# Shader Lab — an isolated pixel-query AND visual test bed for TSL materials

**Growth plan:** [`Shader-Lab-Proving-Ground.md`](Shader-Lab-Proving-Ground.md) (2026-08-01) — the fidelity ladder (real ingest → real composite → scale/lifecycle), the agent contract, and multi-agent fleet conventions. This document stays the tool's standing design; that one plans where it goes next.

**Status:** STANDING INFRASTRUCTURE, not a one-bug tool. Built 2026-07-30 (author: *"let's not half-ass this... build a test bed for exactly this sort of problem that would allow you to automatically try things and test the results, being able to query any pixel and get any needed information."*). Elevated 2026-07-31 to an actively-invested-in priority (author: *"you'd spend as much time improving the Shader Lab as you would using it because I think it'll be critical for producing effects quickly and reliably in future... it would be nice if you ran it for me to see the result in the browser here as you work. That way I can look at the same browser window and give my own opinion."*).

---

## This is standing infrastructure, not a one-bug tool

The sun-shadow investigation is the first real workload, not the point. Every future TSL effect
(water, specular, vegetation shadows, lightning) hits the exact same wall this was built to close —
so improving Shader Lab itself is in scope on *any* shader task, not only when a specific bug is
open. Concretely, that means:

- **Invest in it proportionally to how much it gets used.** A session that reaches for Shader Lab
  should expect to spend some of its time making the TOOL better (a new scenario builder, a clearer
  plot, a richer readout), not only running it against one bug and moving on.
- **Visual fidelity to a real Foundry scene should keep improving**, while staying fast to load —
  the two pull against each other and both matter. Parametric synthetic scenarios (a rectangle, a
  wall+ledge) are the fast, controllable end; higher-fidelity comparisons (real mask art, a caster
  texture captured from an actual running scene) are a real direction to grow toward, not a
  distraction from it. See "Fidelity roadmap" below.
- **It should surface a lot of information, not just one number.** Whatever a scenario can tell an
  investigator — multiple channels, timing, a profile plot, not only a single occlusion value —
  is worth exposing, because the next bug this tool catches won't be the sun-shadow march.
- **Always run it where the author can see it.** The Browser pane this tool lives in is the SAME
  pane the author's own client renders — driving it isn't just a way for Claude to get numbers,
  it's a shared surface for both of us to look at the same picture and disagree about it in real
  time. See "The shared-viewing workflow" below.

## Why this exists

The sky-reach shadow investigation (2026-07-30) went through roughly ten rounds of the same slow loop: form a hypothesis about the shader → author reloads the whole Foundry+VT+MSA stack → author navigates to the exact spot → author screenshots a debug view → Claude interprets a photograph of a shadow. Every round cost the author several minutes and produced, at best, a description of pixels rather than the pixels themselves. Several rounds were wasted on confounds that had nothing to do with the actual bug (whether Bloom was on, whether a debug view itself was mis-isolating a channel) purely because there was no way to look at the shader's output *without* the full weight of the running game around it.

This is not a one-bug problem. It is a standing gap: **there is no way to render one TSL material in isolation and query its exact numeric output.** Every future shader bug (water, specular, vegetation shadows, lightning) will hit the same wall. This document is the plan for closing it once.

## What already exists and why it isn't enough

- **`tools/build-three-webgpu.mjs`** already bundles `three/webgpu` + `three/tsl` into `src/vendor/three/three.webgpu.js`, a browser-loadable ESM file with no bundler needed at runtime. This is exactly the artifact Shader Lab needs, already solved, from the original TSL-adoption spike (`docs/planning/Shaders.md` §7.5, 2026-07-16). Reused as-is.
- **`tests/playwright/*.spec.js`** drives a *real, running Foundry instance* via `FoundryLauncher` — the right tool for performance regression testing, the wrong one here: it requires a live world, a live scene, and answers "how does the whole app behave," not "what does this one material output at pixel (x, y) for this one hand-built input." Not reused; a different job.
- **The original TSL spike** (referenced in `Shaders.md`, never preserved as a tool) proved the one fact this design leans on hardest: **`renderer.readRenderTargetPixels` — the WebGL-shaped synchronous call — silently returns all-zero on `WebGPUBackend`.** The correct, modern call is `await renderer.readRenderTargetPixelsAsync(renderTarget, x, y, width, height)`, which three.js's `Renderer.js` (confirmed in the vendored source, `readRenderTargetPixelsAsync` → `backend.copyTextureToBuffer`) implements correctly on both backends. Getting this wrong silently is exactly the kind of "instrument lies" failure `feedback_instruments_must_not_lie` warns about — Shader Lab's readback layer exists specifically so nobody has to rediscover this.

## What Shader Lab is

A tiny, dependency-free, dev-only web page plus a small Node static server, living entirely under `tools/shader-lab/` — never touched by `module.json`, never shipped. It:

1. **Imports the real shader-building functions directly from `src/`, unmodified.** `buildSunShadowBakeMaterial` (and later, any other effect's `build*Material` export) is called exactly as `sun-shadow-subsystem.js` calls it — same file, same function, same math. There is no copy to drift out of sync with the shipped code.
2. **Builds synthetic input data by hand** — a `THREE.DataTexture` painted with whatever caster shape a scenario needs (a rectangle, a blurred-edge ramp, an arbitrary PNG-shaped mask), with no dependency on a real scene, real masks, or Foundry being open at all.
3. **Renders the material to an offscreen render target** using a `THREE.QuadMesh`, exactly as the real bake does.
4. **Reads back exact pixel values** via `readRenderTargetPixelsAsync`, and exposes them through a small `window.shaderLab` API that returns plain JSON — built specifically so it can be queried through the Browser tool's `javascript_tool` (or Playwright, for an automated regression later) without a screenshot anywhere in the loop.
5. **Paints a visible picture, not just numbers.** The SAME whole-render-target readback is drawn to an on-page `<canvas>` (one shared row-order correction, reused by both the numeric API and the picture — never two conventions that could disagree), plus a second canvas plotting a scanline as a line graph, because a human eye catches "flat, then a clean ramp" vs. "two plateaus with a notch" far more reliably in a line plot than in a grayscale image or an array of numbers. **This did not exist for the tool's first day** — it was numeric-only, and the author, asking to watch, correctly identified that as the gap ("I see 'loading…' and it never gets beyond that" — there was genuinely nothing else on the page). Do not regress back to text-only.

## The API surface (first cut — sun shadows only, generalizes later)

Everything below is called from outside the page (Claude, via `javascript_tool`, or a future Playwright spec) as `window.shaderLab.*`:

```js
// Describe the synthetic scene. Returns nothing; just configures state.
shaderLab.setCaster({
  // A pure function (x, y) -> {skyReachCoverage, floatingHeightPx, floatingCoverage, buildingCoverage},
  // world px, same shape sun-occlusion.js's own sampleField takes — so a
  // scenario written for the CPU twin and a scenario written for Shader Lab
  // are the SAME function, one rasterized into a texture, one called directly.
  sampleField: (x, y) => ({ ... }),
  rect: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
  gridDim: 512,       // caster texture resolution — tests casterGridDim directly
  mipmaps: true,
});

shaderLab.setSun({ azimuthDeg: 270, elevationDeg: 45 });
shaderLab.setLook({ strength01: 1, softnessMul: 1, basePx: 2 });
shaderLab.setMarch({ steps: 32, lateralTaps: 3 });   // rebuilds the material — real cost, matches production

await shaderLab.render();  // bakes the field once, like a real sun-shadow bake
await shaderLab.paint();   // NEW: draws the SAME bake to the visible <canvas>

// Query. All async (real WebGPU readback), all return plain numbers/arrays.
await shaderLab.samplePixel(worldX, worldY);           // -> { r, g, b, a } (0..1)
await shaderLab.scanLine({ from: {x,y}, to: {x,y}, steps: 200 });  // -> [{x, y, vis}, ...]
await shaderLab.dumpRegion({ minX, minY, maxX, maxY, resolution }); // -> 2D array, for finding a ring/seam without guessing where to look
await shaderLab.paintProfile({ from, to, steps });     // NEW: scanLine + plots it as a line graph
```

`scanLine` and `dumpRegion` are the two that matter most for a "which pixel is wrong" hunt — a scan across a suspected edge is exactly the ASCII-art probes already run against the CPU twin this session, except now against the *actual GPU shader*, catching anything the CPU twin's plain-JS model can't (real bilinear filtering, real mip selection, any TSL codegen quirk).

**The page itself (`tools/shader-lab/index.html` + `lab.js`) also ships an on-page control panel** —
scenario picker, tier-preset buttons (real `sunShadowTierPlan` numbers, not guessed ones), sun
azimuth/elevation, caster geometry, look sliders — each wired to re-run `setCaster`/`setSun`/
`setLook`/`setMarch` → `render()` → `paint()` + `paintProfile()` on change. This exists so the
author can drive scenarios directly, not only watch Claude narrate `javascript_tool` calls.

## The shared-viewing workflow

The Browser pane Shader Lab runs in is the SAME pane the author's own client renders — it is not a
headless, Claude-only surface. That has concrete implications:

- **Navigate with `force: true`** after any source edit — plain ES module imports cache
  aggressively, and a normal navigate can silently keep serving stale code to BOTH viewers.
- **Leave the page in a state that means something without narration.** The legend text under the
  canvas should always say what's currently being tested (scenario, tier, sun angle, the profile's
  min/max) — the author is looking at the same pixels Claude is, without necessarily reading every
  chat message describing them.
- **Prefer driving it live over batching numeric probes and reporting a summary.** When a finding
  matters, render it, let it sit in the pane, and say so in chat — "look at the pane, the ramp
  should be smooth now" — rather than only pasting arrays of numbers into the conversation. The
  author explicitly wants to "look at the same browser window and give my own opinion" — that
  requires the picture to actually be sitting there, not just have existed for one `javascript_tool`
  call.
- **`computer` screenshot from Claude's side may fail** ("Browser pane is not displayed") depending
  on the host UI's own state — that does not mean the author can't see it. Don't treat a failed
  screenshot as proof the pane is unreachable; the numeric API (`samplePixel`/`scanLine`) still
  works identically regardless, and the author's own view is independent of Claude's screenshot
  tool succeeding.

## Fidelity roadmap

Near term (done): parametric synthetic scenarios (`rectScenario`/`floatingScenario`/
`bothScenario` in `lab.js`) — fast, exactly controllable, good for isolating one mechanism at a
time. Tier presets pull real `sunShadowTierPlan` numbers so "Extreme" here means the actual
production configuration, not a guess.

Medium term, not yet built: a way to load a REAL caster texture captured from an actual running
scene (a JSON/binary dump of one real bake's input) so a synthetic-scenario finding can be checked
against real art's actual silhouette complexity (crenellations, thin trim, overlapping masks) —
synthetic rectangles are excellent for isolating a mechanism but can under- or over-state how much
a real, messy silhouette triggers it.

Long term: the same harness (server, readback layer, canvas+plot+controls shell) generalizes to
any other TSL material with a `build*Material`-shaped export — water, specular, vegetation shadow
smear, lightning — each contributing its own scenario builders and controls, not a separate tool
per effect.

**The fast-to-load constraint stays a real constraint, not a suggestion** — whatever fidelity work
happens here, `preview_start` → `navigate` → a rendered picture should stay a handful of seconds,
because the entire value proposition versus the old screenshot-relay loop is speed. A change that
makes the tool more realistic but slower to boot has traded away the thing that made it worth
building.

## How Claude drives it

1. `mcp__Claude_Browser__preview_start` with a `.claude/launch.json` entry running `tools/shader-lab/serve.mjs` (a ~15-line `node:http` static file server — no external dependency, matching this project's existing preference for zero-dependency tooling in `tools/`).
2. `navigate` to `http://localhost:<port>` with `force: true`.
3. `javascript_tool` calls to configure a scenario and query it, AND/OR the on-page controls for anything the author wants to drive directly. No screenshots required for numeric answers; `computer` screenshot/zoom stays available for the rare case Claude itself needs a look, independent of whether the author's own view of the same pane is working.

## Non-goals (so this doesn't become the next god object)

- **Not a general shader IDE.** No live-editing GLSL/TSL SOURCE in the page, no hot-reload of the
  shader's own code. It calls real exported functions; editing the shader means editing the real
  file, same as always. This is unchanged by the control panel — the panel drives SCENARIO
  parameters (sun angle, caster shape, tier), never the shader graph itself.
- **Not a replacement for live verification.** A number (or a picture) matching expectations here is `BUILT (unverified)` until the author sees it in a real scene — same discipline as everywhere else in this project. Shader Lab narrows *where* to look and lets both of us look at the same isolated picture; it doesn't replace looking at the real thing.
- **Not shipped.** Lives under `tools/`, imports nothing `src/` doesn't already export publicly, and `verify-structure.mjs`'s reachability check should be able to confirm `tools/shader-lab/**` is never imported by anything under `src/`.

## First real use (2026-07-30)

Reproduce the sky-reach "two shadows plus a bright halo" bug: paint a caster shape matching the reported castle silhouette (or a simplified stand-in — a wide rectangle with a narrower spire on top, same proportions), run the exact same `buildSunShadowBakeMaterial` production code against it, and `scanLine` straight across the spire's edge and the main roofline's edge. Compare the numeric profile against every hypothesis already tested this session (the width gate, the R-channel sharpening) to see directly which is/isn't present in the real shader's real output — rather than continuing to infer it from screenshots.

This use immediately paid for itself twice over: found the Round Ten/Eleven discretization-plateau
mechanism precisely, then — once the tool gained a visible canvas and the author asked to actually
watch — DISPROVED that those two fixes were as correct as first claimed, catching a real, still-
open bug (a march-span-coincidence degeneracy) that the numeric-only version had made easy to
mis-read as "close enough." See `keyhole-sun-shadows-plan.md` (project memory) for the live,
evolving status of that specific investigation — this document stays about the TOOL, not the bug.
