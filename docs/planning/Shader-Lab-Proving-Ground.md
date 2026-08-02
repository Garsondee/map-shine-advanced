# Shader Lab — the Proving Ground plan

**Status:** P1 + P2 (first slice) **BUILT (unverified)** 2026-08-01 — see §10. Rungs 3-5 remain
planning only. Companion to
[`Shader-Lab.md`](Shader-Lab.md) (the tool's standing design — still true, not superseded); this
document plans the tool's next growth along the three axes the author set:

1. **Work well with Claude Code** — agents drive it, read it, and leave evidence behind.
2. **Many agents at once** — parallel effect development without stepping on each other.
3. **Above all: break the way Foundry breaks.** *"The Shader Lab won't be useful if it is unable
   to break in the ways that things would actually break when they hit Foundry."*

**The measure of success, stated once:** an effect that goes lab-green and then fails live should
fail **only** for a reason already on the Known Blind Spots register (§7). Any live failure NOT on
that register is a lab defect — file it against the lab, close it by adding the missing fidelity,
and add a regression-zoo entry (§4.4) so it stays closed. That is the whole plan in one rule.

**What this does NOT change:** the two-word doctrine. Lab-green is still `BUILT (unverified)`.
The lab never promotes anything to `LIVE`; its job is to make the author's first live look
*boring* — and to make live failures *diagnosed on arrival* instead of ten-round hunts.

---

## 0. The framing: AOV isolates vs. the comp

In Maya terms — because they are the exact right terms: today's benches render **isolated AOVs
with hand-built inputs**. That is genuinely valuable (it partitions "shader wrong" from "plumbing
wrong" in one run — `bench-specular.js`'s gate ladder proved it), and Rung 1 keeps it forever as
the fast inner loop. But the bugs that have actually burned us live in **the comp**:

- real *footage* (real mask files with seams, missing alpha channels, multi-floor suites — not
  synthetic rectangles that are correct by construction),
- the real *node graph downstream* (gamma-space composite, blend-mode zoo, accumulation order,
  tone mapping that is only sometimes on),
- the real *pipeline around the frame* (floor switches, resizes, residency, disposal).

The evidence is our own history, in our own documents' words:

- `Sun-Shadows-Redesign.md` §"What the lab was missing": the CPU twin matched the GPU shader
  *decimal-for-decimal in the lab* while the live scene still showed the double shadow — because
  the lab bypassed **the derivation** (real `mask-derive.js` over real multi-floor mask sets) and
  **the composite** (per-floor gate, ambient multiply, gamma).
- `bench-specular.js:30-34`, its own header: *"⚠️ IT CANNOT SEE A WIRING BUG IN THE VIEWER. Every
  input here is synthetic and correct by construction."*
- Specular shipped invisible repeatedly; ten live rounds traced a gamma mismatch and a tonemap
  washout — both **composite-side** facts no isolated bench could have shown.

So the plan is: keep the AOV isolate, and **build the comp** — one rung at a time, each rung
importing more of the real pipeline, each rung justified by a named bug it would have caught.

---

## 1. What exists today (grow it, don't rebuild it)

| Piece | What it already does right | Where |
| --- | --- | --- |
| Sun bench | Real `buildSunShadowBakeMaterial` + smear prototype, toggleable on identical scenes; scanline/dumpRegion/`findHoles` (the local-maximum hole detector); Y-flip `selfTest` calibrates instead of assuming | `tools/shader-lab/lab.js` |
| Specular bench | Real material + real island bake + real injected outdoors gate; HalfFloat target matching `scene.lit`; byte-exact `ATTR_PRESETS` incl. the fail-open case; `gateLadder()` (first dead factor named outright); `visibilityReport()` post-tonemap contrast; **`dumpShader()` — the generated WGSL, not the imagined graph** | `tools/shader-lab/bench-specular.js` |
| Lightning bench | The OTHER bench shape: real subsystem lifecycle (`createLightningSubsystem`) animated live on a visible WebGPU canvas — proof the lab can host stateful, animated, population-managed effects, not only static bakes | `tools/shader-lab/lightning-lab.js` |
| Server | Zero-dep static server rooted at repo root (so `/src/**` imports run unmodified); `SHADER_LAB_PORT`/`PORT` env + `autoPort: true` — **multi-instance is already half-solved** | `tools/shader-lab/serve.mjs`, `.claude/launch.json` |
| Shared-pane workflow | The author and Claude look at the same picture; legend law (the pane describes itself); `force: true` reload discipline | `Shader-Lab.md` §"The shared-viewing workflow" |
| Adjacent infra | Node TSL-construction tests (7 `*-render.test.mjs`); `tools/run-tests.mjs` (suite discovery, lying-suite detection); Playwright + `FoundryLauncher` (real Foundry, perf); `pngjs` already a devDependency; vendored `three.webgpu.js` bundle | `src/**/__tests__/`, `tests/playwright/`, `tools/build-three-webgpu.mjs` |

Standing laws that carry over unchanged: **imports real `src/` code, never a copy** ·
**fast boot is a constraint, not a suggestion** · **not shipped, never imported by `src/`** ·
**instruments must not lie** (selfTests, calibrated flips, UNMEASURED ≠ zero).

---

## 2. The divergence audit — why lab-green has not meant Foundry-green

A production-surface audit (2026-08-01, this plan's research pass) mapped everything an effect
receives in the real pipeline. Below, each gap states the production fact, what the lab does
instead, and the named bug class that lived in the difference. This section is the requirements
list for §3's rungs.

### G1 — The renderer and color contract are not production's

| Production fact | Lab today |
| --- | --- |
| `new THREE.WebGPURenderer({ canvas, antialias:false, requiredLimits, trackTimestamp:true })`, `requiredLimits` raising `maxTextureDimension2D` toward 16384 (`vt-pan-viewer.js:1131`, `texture-limits.js`) | `new THREE.WebGPURenderer({ antialias: false })` (`lab.js:103`) |
| `setPixelRatio(min(Foundry resolution, 4))`; every screen RT sized from `getDrawingBufferSize()`, **not** CSS pixels (`vt-pan-viewer.js:1182-1211`) | No pixel ratio at all — mask texel : screen pixel ratios are systematically wrong |
| `renderer.toneMapping` / `outputColorSpace` **never set**; every RT `NoColorSpace`; exactly ONE sRGB OETF, applied by three at the canvas (`vt-pan-viewer.js:1380-1391, 3812-3815`) | Bench transcribes the OETF by hand in `paint()` — correct today, but a *transcription*, and one that must now follow a second rule: |
| **Tone mapping runs only when the Colour Grade effect is enabled** — `grade-present.js` builds with `'none'` and rebuilds to `'neutral'` on enable (`grade-present.js:109`, `vt-pan-viewer.js:4733-4761`) | `bench-specular.js:104-107` claims neutral tonemap runs "every frame by default" — **that claim is wrong**; the lab must model BOTH grade states |

Bug classes that lived here: 🔢🌗 gamma composite · specular's tonemap-washout rounds ·
🔎🔍 zoom-out mush (a pixel-ratio/mip regime fact the lab literally cannot enter today).

### G2 — Inputs skip the real ingest and derivation

Production's mask reality (`src/vt/mask-image.js:163-291`, `scene/mask-catalog.js:101-240`,
`scene/mask-authority.js`):

- **Two mask paths.** A coarse CPU grid (≤512/side, from VT coarsest pages, `mask-derive.js`)
  serving rects and derivations, AND the full-res authored-file path effects actually sample:
  `fetch → createImageBitmap(resize, 'high') → OffscreenCanvas.getImageData → repack to 'r' or
  'rgb' + painted-AABB measure → DataTexture(LinearFilter, ClampToEdge, flipY:false, NO mipmaps,
  NoColorSpace)`, capped at `MASK_IMAGE_MAX_DIM = 16384`.
- **Per-effect scale forks are real**: `SPECULAR_MASK_IMAGE_SCALE = 0.5` (specular samples a
  half-res mask) while water samples full-res. Sun shadows is the only mipmap opt-in caller.
- **No BC compression on masks** — BC7/BC1 (with a hand-built mip chain) applies to map ART only.
- Discovery/serving rules with teeth: `outdoors` is `required: true` and **throws**; suffixes are
  single-sourced in `mask-catalog.js` (a verify wall enforces it); any drawable can host a mask,
  composited in draw order, later host overwriting earlier.
- The per-floor outdoors gate texture is itself a **derived bake** (`bakeOutdoorsTexture`,
  RGBA8/LINEAR from the ≤512 grid, rebaked on floor and mask-version change).

The lab rasterizes synthetic `sampleField`s directly into its own packing — every one of the
stages above is bypassed. Bug classes that lived here: 🎯1️⃣ one byte two quantities · 🏷️>📏
membership beats derived threshold · 🔲✂️ the 32-vertex polygon cap · 🪞🔁 the fallback matcher
matching itself · ↕️ Y-flip (every new mapping) · the no-alpha `_Specular` decode-to-black ·
**the live double shadow that survived lab-green march fixes** (multi-floor derivation).

### G3 — The composite is a different world

The audit's load-bearing facts:

- **The canonical arithmetic** (`environmental-light.js:426-441`): `mapSrgb = OETF(albedo)` →
  `litSrgb = mapSrgb × (illum × uiShadowVis)` → `finalSrgb = litSrgb + coloration` (a
  **gamma-space add**) → `lit = EOTF(finalSrgb)`. And upstream: `illum = max(ambient × sunVis,
  pointLights)` — the sun's field **multiplies ambient before lights max in** (`:348-364`).
- **`buf:scene.illum` holds Foundry-sRGB values inside a linear-typed RGBA16F/NoColorSpace
  target**, with a readability floor (~0.188) that `uDarknessFloor` exists to subtract
  (`specular-render.js:676-703, 711-754`). Sampling it "as linear" was specular's actual bug.
- **Accumulation, not composition of independent passes**: inside `light.accumulate`
  (`vt-pan-viewer.js:4147-4235`), with `autoClearColor` forced false, SIX writers land in
  sequence — illum quad, region darkness, point lights (**MaxEquation**), window light, then the
  composite quad into `scene.lit`, then guarded additive candle/lightning/wind draws. **Three
  separate live bugs came from this ordering.** A bench that renders one material into a fresh
  target reproduces the material and erases the ordering.
- **The blend zoo is production reality**: specular = Custom One/One with alpha Zero/One +
  DoubleSide + no depth; fluid absorb = Zero/SrcColor multiply; point lights = MaxEquation;
  occlusion discs = MinEquation; bloom/candle/lightning = additive.
- **MRT is renderer-global and scoped** — save/set/restore around `geometry.world` only;
  an `mrtNode` on a surface-stage material is actively harmful (`scene-attr.js:33-42`,
  `vt-pan-viewer.js:4248-4254`).
- **`buf:scene.attr` must be reproduced BROKEN, not as designed**: clear is `(0,0,0,0)` (spec
  said `(255,0,0,0)`); the alpha lane measures broken and its consumer deliberately ignores it
  (`scene-attr.js:115-122`, `specular-render.js:766-774`). `ATTR_PRESETS.neverWritten` already
  models this — that instinct generalizes: **fidelity means the shipped state, warts included.**
- **`positionWorld` is the real input mapping**, via the shared `uViewRect` and
  `computeCameraFrustum` (where the ONE Y-flip lives: `top = worldRect.minY`) — not `uv()` on a
  fullscreen quad. The benches already import `computeCameraFrustum`; the rule must hold for
  every future bench.
- **renderOrder is a law, not a convention**: one flat sort (`layer-order.js#sortByLayer`) stamps
  indices; depth testing is off everywhere; ascending order IS the layering. Effects with their
  own scenes bypass it entirely by getting dedicated `renderer.render()` calls.

Bug classes that lived here: 🎨🚫 blend neutrality per-blend · 🪫⚖️ alpha-blended MRT margin ·
🪣➡️🚫 composite-only terms miss shared buffers · ✅🎯➡️🎯 host-relative render order ·
🎭 DoubleSide invisibility · 🔢🌗 gamma composite (again — it spans G1/G3).

### G4 — World state and lifecycle don't exist in the lab

- The deep-frozen env snapshot (`world/environment.js:93-169`): time (sim vs wall, pause ramp),
  sun (from hour), ambient (Foundry's palette), weather, wind, `darkness01`.
- **One shader clock**: `uGlobalTimeMs`, written once per frame — by `point-light-pool.js:434`
  (a coupling worth its own audit line, §9.3).
- Sky/shadow/wind handles are **immutable + versioned; consumers take getters, never captured
  values** — a contract the lab never exercises (staleness bugs invisible).
- **No lifecycle callbacks**: effects are *polled* — `sync(floorIndex, viewRect)` every frame,
  **before** `hasContent()` (gating sync on visibility is a documented deadlock,
  `vt-pan-viewer.js:4260-4267`). Resize = viewer reallocates + `rebindPresent()`; sun-shadow
  deliberately resizes-in-place so captured `.texture` refs stay valid
  (`sun-shadow-subsystem.js:378-384`). Floor switch = `setFloorIndex` rebakes wind + outdoors +
  residency (`:8716-8749`). Teardown ambiguity: `canvasTearDown` fires for both floor switches
  and blank canvases; the distinguishing signal is the *absence* of `canvasInit` after two rAFs
  (`foundry/canvas-lifecycle.js:79-109`).

Bug classes: ⏱️ residency sync ≠ render-loop sync · 🗂️🔭 discovery scope narrower than the
authority (a floor never visited never got submitted) · 💥🆕 floor-switch device loss ·
stale-handle staleness (unnamed so far — the lab should name it first).

### G5 — Scale and regime

The allocator law (`three-allocator.js:81-152`): world-res targets ≤2048/side, screen ≤8192,
enforced by a verify wall. Production maps are 12k-class with BC-compressed art and hand-built
mip chains; masks up to 16384. The lab tests 512² quads at zoom 1. 📏🎯 MEASURE THE OUTPUT taught
us a correct formula in the wrong regime returns nothing — tier 3 water measured as an invisible
0.0084 wash. The regime IS the test.

Bug classes: ⚖️➡️ BC1's biased error (art-side; visible to any effect sampling composited art) ·
🧱 the 8-storage-buffers-per-stage cap · zoom-out mush · HalfFloat precision at glint peaks.

### G6 — Backend and environment

One correction to the folklore: **there is no `forceWebGL` fallback in production.**
`WebGPURenderer` picks its backend; the safety slide on device loss goes to *Foundry's PIXI
renderer*, not to a WebGL build of ours (`vt-pan-viewer.js:1235-1262`). So the lab owes no
WebGL test matrix today. What it does owe: device-loss drills (both named device-loss incidents
were found live), adapter-limit honesty (`requiredLimits` parity), and headless-vs-headed WebGPU
parity checks for the CLI rung (§5.6).

---

## 3. The Fidelity Ladder

**The architecture rule, before the rungs: SINGLE-SOURCE OR IT LIES.** Synthetic *data* is
allowed (and rung 1 keeps it); paraphrased *code* is forbidden. Every rung must run the real
module — the real mask loader, the real derive, the real composite nodes, the real pass bodies.
Where the real code is currently inline in `vt-pan-viewer.js`'s one 9.3k-line function and can't
be imported, **that extraction is part of this plan's work**, done under
`VT-Pan-Viewer-Extraction.md`'s seven traps — the lab becomes the second consumer that forces
honest seams (exactly how the god object starts to die: not by decree, but by something else
needing the pieces). A lab-local transcription is a 🧟 plausible diagnosis waiting to rot — the
`neutralToneMap` transcription drifting from `grade-present.js`'s actual gating is the live
example (§2 G1), and the migration OFF hand transcriptions is itself zoo-tracked.

| Rung | Name | Real | Synthetic | Catches (named classes) | Exists? |
| --- | --- | --- | --- | --- | --- |
| 0 | Node constructs | TSL graph build in plain Node | everything else | throws-on-startup, TDZ, bad swizzles | ✅ 7 suites |
| 1 | Isolated material | material + real WebGPU + readback | all inputs | shader-internal logic; gate ladders; WGSL | ✅ 3 benches |
| 2 | **Real ingest & derivation** | `loadMaskImageTexture`, catalog/authority rules, `bakeCasterTexture`, island packs, water JFA, `bakeOutdoorsTexture` — fed real fixture files, multi-floor | scene geometry, camera | one-byte-two-quantities, Y-flip, no-alpha decode, 32-vertex cap, self-matching discovery, **the double-shadow class** | ❌ |
| 3 | **The mini-frame** (real composite) | the `light.accumulate` sequence + `geometry.world` MRT scoping + present chain, real blend modes, real `sortByLayer` orders, grade ON and OFF | which hosts exist, their art | gamma composite, blend neutrality, MRT alpha margin, shared-buffer reuse, host-relative order, DoubleSide, accumulation-order bugs | ❌ |
| 4 | Scale & tiers | full-res fixture, BC-compressed art variants, allocator-law target sizes, production pixel ratio, tier plans, timing | camera path | regime bugs, BC bias, zoom-out mush, storage-buffer budget, HalfFloat clipping | ❌ |
| 5 | Lifecycle scripts | scripted sequences over rung-3 scenes: floor switch (with its rebakes), resize (reallocate + re-point), pause ramp, dispose/re-init, device-loss drill, teardown-without-init | the script itself | residency-sync class, discovery-scope class, stale captured textures, floor-switch collisions (the lab-reachable part) | ❌ |
| 6 | Foundry itself | everything | nothing | hook ordering, PIXI seam, module interop | ✅ Playwright perf rig (correctness smoke = future, out of lab scope) |

**When to run what** (the workflow contract, so agents don't guess):

- Inner loop while shaping a shader: rung 1 (+0 via `npm test`). Seconds.
- Before claiming `BUILT (unverified)` on any effect work: that effect's **scenario suite at
  rungs 2+3**. A claim without a rung-2/3 run should read as suspicious in review.
- Before a live session / after landing anything composite-adjacent: rung 4+5 sweep + the
  full regression zoo (headless, §5.6).
- Rung 6 stays perf-focused and author-scheduled.

**Boot cost stays protected:** the page boots to rung 1 with synthetic scenes in a handful of
seconds, exactly as today. Rungs 2-5 lazy-load fixtures and cached derived products on demand
(§4.3). A fidelity rung that slowed the inner loop would be trading away the tool's founding
value; it is the roadmap's one inviolable constraint (`Shader-Lab.md` says the same).

---

## 4. Fixtures — the footage library

### 4.1 Fixture One: `example_map/town river bridge`

Already in the repo, already tracked, never yet fed to the lab. A real, sellable-quality,
**three-floor** map with a full authored mask suite:

| Floor | Art | Masks present |
| --- | --- | --- |
| `Tower_Bridge_Underground` | 9.1 MB webp | `_Outdoors`, `_Overhead`, `_Shadow`, `_Specular`, `_Water`, `_WaterHard`, `_Windows`, `_Fire` |
| `Tower_Bridge_Middle` | 8.0 MB webp | `_Outdoors`, `_Overhead`, `_Overhead_Outdoors`, `_Shadow`, `_Windows`, `_Fire` |
| `Tower_Bridge_Roof` | 3.0 MB webp | `_Outdoors` |
| props | `crosshead_*_door_02/03.webp` | door graphics fixtures for free |

What it exercises that synthetics cannot: multi-floor derivation (the double-shadow gap),
overhead-union attachment (the tavern-sign requirement), a real `_Windows` gobo, real water
bodies for the JFA bake, real specular islands on real art, authored `_Outdoors` with real
seams and holes, and the `required: true` outdoors rule against real filenames.

### 4.2 The fixture manifest — authored truths, asserted at authored points

Each fixture ships `fixtures/<name>/manifest.json`: scene rect + grid size + padding (production
default 0.25, grid-snapped — `scene-geometry.js:83-108`), floor bands, file map per floor, and an
`expectations` block of **hand-verified facts at named world points**: "the bridge deck at
(x,y) is outdoors", "the underground vault at (x,y) is indoors", "this texel of `_Specular` is
gold ≈ (230,180,60)". Assertions then compare the pipeline's answer against the authored fact —
🏷️>📏 membership beats a derived threshold, applied to our own test data. Expectations are the
part of a fixture that makes it a *test* rather than a demo scene.

### 4.3 The derived-product cache

Rung 2's real derivations on full-res files are not free (BC encodes, island bakes, JFA). Cache
every derived product under `tools/shader-lab/cache/`, keyed by **content hash of the source
bytes + the deriving code's version** — never by URL or filename alone (✅🗄️ a URL-keyed cache
needs a content validator; we wrote that memory, we obey it in our own tool). Cache is
gitignored, shared read-safe across instances, and any entry is reproducible by deletion.

### 4.4 The Regression Zoo

A directory of small adversarial fixtures + pinned scenarios, one per named bug class that is
lab-reproducible, each **demonstrated to fail on the pre-fix code shape** when it lands
(a detector that has never fired is not known to work — the vegetation Jacobian test's
"fires at 10× the cap" discipline, generalized). Seed list, mapped from memory:

| Zoo entry | Bug class it pins |
| --- | --- |
| Greyscale `_Specular` with no alpha channel | the decode-to-black fallback |
| A region polygon with 40+ vertices | 🔲✂️ silent cap corrupting a hard boundary |
| A `_Tree` filename that the base-shortening fallback would self-match | 🪞🔁 fallback matcher matches itself |
| Same-name-different-bytes texture pair | ✅🗄️ URL-keyed cache validator |
| Asymmetric orientation marker through EVERY new texture mapping | ↕️ Y-flip (generalizes both benches' selfTests into a required rite for new benches) |
| Effect rendered over known backgrounds under each production blend mode; neutrality asserted per-blend | 🎨🚫 blend neutrality is per-blend |
| Attr written at α=0.5, α=0.25 through a real alpha-blended MRT draw | 🪫⚖️ alpha-blended write margin |
| Illum authored sRGB-with-floor; effect's additive term checked against `EOTF(illum)` | 🔢🌗 gamma composite |
| Raw vs BC1/BC7-compressed art variant, diffed under the effect | ⚖️➡️ biased error survives scoring |
| Tier sweep 0→3 asserting output lands in an expected brightness band per tier, monotonic | 📏🎯 measure the output, not the equation |
| Storage-buffer count per stage asserted against a budget file (extends `tools/uniform-budgets.json`) | 🧱 the 8-buffer cap |
| Two hosts sandwiching an effect; order asserted host-relative (with vegetation's sanctioned carve-out annotated, not "fixed") | ✅🎯➡️🎯 host-relative order |
| Camera convention flipped; world-quad materials still visible | 🎭 DoubleSide |
| Every scenario also executed through its CPU twin where one exists; GPU-vs-twin diff bounded | 🌊🧪 a smooth output hides a ported bug |

**Definition of done for any future live-found bug:** the fix lands with a zoo entry that fails
on the pre-fix shape. The zoo is how the lab *accumulates* Foundry's ways of breaking instead of
re-learning them.

---

## 5. The agent contract — how Claude Code drives it

### 5.1 One machine-readable door

Two functions on `window.shaderLab`, stable across benches:

- `shaderLab.describe()` → `{ benches, scenarios, params, checks, fixtures }` — an agent learns
  the lab by asking it, not by re-reading source every session.
- `shaderLab.run(scenarioRef | inlineSpec)` → a **report**: `{ meta, inputs, checks: [{id, status:
  'pass'|'fail'|'UNMEASURED', measured, expected, note}], stats, artifacts: [paths] }`.

`UNMEASURED` is a first-class status, never conflated with zero or failure — 🔬 instruments must
not lie is a schema rule here, not a hope. Every bench selfTest failure poisons subsequent
reports with a visible `calibration: FAILED` flag rather than silently continuing.

### 5.2 Scenario files are the unit of work

`tools/shader-lab/scenarios/<bench>/<name>.scenario.mjs` exporting `{ name, bench, rung,
fixture?, build(labApi), checks[] }`. `.mjs` not JSON because sample fields and check predicates
are functions. Everything an agent iterates on, reviews, or regresses is a scenario file —
which makes multi-agent merges ordinary file merges, and makes the regression zoo just "the
scenarios with pinned expectations." The page grows a **"save pane state as scenario"** button:
the author twiddles sliders to something interesting, an agent codifies the result — the taste
loop closing in the direction it actually flows.

### 5.3 Runs leave evidence

Every `run()` writes `tools/shader-lab/runs/<utc-stamp>-<label>/`:

- `report.json` — the report above;
- `frame-raw.png`, `frame-presented.png` (post grade/present, both grade states when relevant),
  `diff-vs-golden.png` heatmap when a golden exists;
- `shader.wgsl` — `dumpShader()` output, so codegen changes diff in review;
- `provenance.json` — **mandatory**: git SHA, `git diff --stat` dirty-file hashes (the author
  live-edits while agents work; a result without dirty-state provenance is unattributable),
  three.js version, backend + adapter info, seed, scenario content hash.

Agents can `Read` the PNGs directly — the lab becomes something an agent can *look at*, not only
query, which is the cheap pre-check before spending the author's eyes. `runs/` is gitignored;
a run worth keeping gets its scenario promoted, not its artifacts committed.

### 5.4 Determinism

Golden comparisons need reproducible frames. The only two `Math.random()` users under
`src/effects/` are `lightning-subsystem.js` and `fluid/fluid-pump.js` — both grow an injectable
RNG seam (defaulting to `Math.random` in production, seeded in the lab). Time is already an
injected node (`uTimeMs`); animated scenarios assert at fixed timestamps or over a fixed
deterministic time series. Goldens carry per-backend tolerance (adapter differences are real;
a byte-exact golden across GPUs is a lie waiting to flake).

### 5.5 The shared pane stays the author's window

Everything in `Shader-Lab.md` §"The shared-viewing workflow" carries over: the MAIN session's
instance lives in the shared Browser pane, `force: true` after edits, and the legend always
states what is on screen. New rule for agent runs: a scenario run leaves the pane *showing that
scenario's final frame* — the author should be able to glance over at any time and see what the
fleet last did, with the legend naming the scenario and run id.

### 5.6 The headless rung

`tools/shader-lab/cli.mjs`: Playwright (already a devDependency) boots Chromium against
`serve.mjs`, loads **the same page** (never a parallel harness — 🍴 mode forks drop features),
runs a scenario list via `shaderLab.run`, writes `runs/`, exits nonzero on any failed check.

- `npm run lab -- <scenario…>` for humans and agents; `npm run lab -- --zoo` for the full
  regression sweep.
- **Not in default `verify`.** `verify` stays fast and GPU-independent. A `verify:gpu` script
  exists for pre-live sweeps and any future CI with a GPU runner (fork F2, §9).
- Windows headless WebGPU is real but flag-sensitive (`--headless=new`, GPU not disabled;
  fall back to headed-minimized if the adapter refuses) — the CLI's FIRST check is a WebGPU
  smoke + calibration scenario, so "headless silently got a software adapter" reports itself
  instead of skewing every number after it.

### 5.7 `AGENTS.md`

`tools/shader-lab/AGENTS.md`, ~30 lines: start the server (or find it running), `describe()`,
run a scenario, read a report, add a scenario, promote a golden, the shared-pane etiquette, the
"which rung before which claim" table from §3. A fresh subagent given only that file should
produce a green scenario run without reading lab source. Project memory points at it.

---

## 6. The fleet — many agents, one lab

**Model: one lab instance per agent, one authoritative pane for the author.**

- **Instances are cheap and already supported** — `serve.mjs` honors `PORT`/`SHADER_LAB_PORT`
  and `launch.json` has `autoPort: true`. An agent working in a worktree starts the lab FROM
  that worktree, so the page imports that worktree's `src/` — effect iteration is isolated by
  construction, no shared mutable anything.
- **The shared pane belongs to the main session** (author-facing, main checkout). Subagents use
  their own instances headlessly or via their own tabs; they do not navigate the author's pane.
- **`runs/` never collides**: UTC-stamp + label + provenance; reports are the merge artifact.
  A coordinating session tables N agents' reports side by side — that is the review surface for
  "five agents each iterating one effect."
- **Goldens are single-writer.** Agent runs emit *candidate* goldens into their own run dir;
  only an explicit `promote` step (main session, or the author via a button) copies into
  `tools/shader-lab/goldens/`. No agent ever writes a golden in place — the same discipline as
  "only the author promotes to LIVE", one level down.
- **Perf runs serialize** via a lockfile the CLI honors (`runs/.perf-lock`); correctness runs
  share the GPU freely (contention skews timing, not pixels).
- **Fixture data is tracked in git** (worktrees get it for free); the derived cache (§4.3) is
  content-keyed so instances can share one cache directory safely via `SHADER_LAB_CACHE`.
- Device-loss drills run only in an agent's own instance, never the author's pane.

Optional, later: a tiny fleet dashboard page (instances registry + latest runs gallery) so the
author can watch the whole fleet from one tab. Nice-to-have; the reports directory already
carries the information.

---

## 7. Known Blind Spots — what the lab will NEVER catch

Kept short, kept honest, and kept in the doc so §0's rule has teeth. Each item is a permanent
entry on the author's first-live-look checklist, and the checklist should shrink to exactly
this list:

1. **Foundry's own authorities** — the darkness gate's second veto, hook ordering,
   `canvas.draw()` lifecycle collisions (💥🆕 the floor-switch device loss lived here),
   module interop. Reachable only by the Playwright+FoundryLauncher rig (today: perf; a
   correctness smoke spec is a worthwhile *separate* future effort).
2. **The interface seam** — PIXI chrome, hit-testing, `pointer-events: none` input mirroring,
   camera sync with Foundry's pan/zoom.
3. **True residency under human panning** — rung 5 scripts approximate pan/zoom/floor
   sequences; real VT streaming under real hands stays live-only.
4. **Other people's machines** — adapter diversity, driver bugs, the player-side profiles.
5. **Taste.** The author's eye is the only instrument for "is it beautiful." The lab measures
   "is it present, correct, in-band, and stable" so that live time is spent on beauty.

---

## 8. Build order

Each phase names its acceptance test as a historical bug it would have caught — that is the
only honest way to claim fidelity improved.

**P1 — The agent contract** (small, multiplies everything after)
`describe()`/`run()`/report schema + `runs/` with provenance + scenario file format (existing
bench scenarios ported) + `AGENTS.md` + save-pane-as-scenario.
*Done when:* a fresh subagent, given only `AGENTS.md`, runs a scenario green and hands back a
report + PNGs; the author watches it happen in the shared pane.

**P2 — Fixture One + Rung 2 (real ingest & derivation)** ← the sun-shadow gap, still bleeding
Fixture manifest + expectations; `loadMaskImageTexture` + catalog/authority rules running in-lab
over the real files; real `bakeCasterTexture` over the real multi-floor suite feeding the sun
bench; real island pack over the real `_Specular`; derived cache; zoo seeds (no-alpha, Y-flip
rite, 40-vertex polygon, self-match filename).
*Would have caught:* the live double shadow (multi-floor derivation), specular's
decode-to-black, every one-byte-two-quantities packing drift.
*Acceptance:* the smear-vs-march comparison runs on Tower Bridge Middle's REAL casters in the
shared pane.

**P3 — Rung 3 (the mini-frame composite)**
The `light.accumulate` sequence + MRT-scoped `geometry.world` + present chain assembled from
REAL imports (extractions from `vt-pan-viewer.js` where needed, under the extraction doc's
traps); real blend modes; `sortByLayer`-stamped hosts; grade ON/OFF both modeled; the
transcribed `neutralToneMap`/OETF in `bench-specular.js` replaced by the real nodes (zoo-tracked
so the transcription cannot quietly return).
*Would have caught:* the gamma-mismatch and tonemap-washout specular rounds, blend-neutrality
and MRT-margin classes, all three accumulation-order live bugs.
*Acceptance:* a specular scenario whose ONLY change is "render through the mini-frame instead of
alone" reproduces the historical washout when the old gamma bug is re-introduced on a branch.

**P4 — Headless CLI + fleet conventions**
`cli.mjs` + `npm run lab` + WebGPU smoke-first; goldens + promotion; perf lock; worktree
instance conventions documented; seeded RNG seams in lightning/fluid-pump.
*Done when:* two agents in two worktrees iterate two effects simultaneously, each with green
zoo runs, no shared-state collisions, and the main session tables both reports.

**P5 — Rungs 4+5 (scale & lifecycle)**
Full-res + BC-variant art scenarios; production pixel ratio + `requiredLimits` parity in the
lab renderer; tier sweeps with band asserts; storage-buffer budgets; lifecycle scripts
(floor-switch with rebakes, resize re-point, pause ramp, dispose/re-init, device-loss drill,
teardown-without-init).
*Would have caught:* tier-3 water's invisible 0.0084 wash at its real regime, the
residency-sync class, stale captured textures on resize.

Ordering rationale: P1 first because every later phase is authored and consumed through it.
P2 before P3 because derivation feeds the composite and because the double-shadow class is the
one currently costing live rounds. P4 whenever fleet pressure demands it — it has no fidelity
dependencies beyond P1. P5 last because it leans on P2's fixtures and P3's frame.

---

## 9. Open forks and audit items for the author

**F1 — Mini-frame vs. embedding the viewer.** Two ways to get the real composite: (a) the
mini-frame — assemble the real pass bodies in the lab, extracting seams from `vt-pan-viewer.js`
as needed; (b) boot the entire `vt-pan-viewer` in the lab against a fixture adapter.
**Recommendation: (a).** The viewer is the god object; embedding it whole imports its lifecycle
entanglements and boot cost into the tool whose founding constraint is fast boot — and every
extraction the mini-frame forces is equity against the god object anyway. (b) remains the
long-term convergence point: each extraction milestone can upgrade the mini-frame toward it.

**F2 — Does `verify` grow a GPU rung?** Recommendation: no — keep `verify` fast and
GPU-independent; `npm run lab -- --zoo` is the pre-live sweep, author-invoked or
session-invoked. Revisit only if a GPU CI runner ever exists.

**F3 — Fixture policy.** Is Tower Bridge cleared (license-wise and size-wise, ~27 MB tracked)
to be THE canonical fixture forever? And do we want a second, *generated* pathological fixture
at true 12k scale (never committed, built by a script) for rung 4, so the repo doesn't carry
50 MB of stress art?

**F4 — Priority under constraint.** If only one fidelity phase lands soon: P2 (recommendation —
it is the gap the sun-shadow work is actively bleeding through), accepting that composite-side
classes stay uncovered until P3.

---

## 10. What landed, 2026-08-01 (P1 + P2 first slice)

Author cleared Tower Bridge and directed P1 → P2, with the framing that fixed the scope:
*"The goal isn't to make the Shader Lab interesting for me to look at, it's to give you real
masks to work with."* So the albedo art is deliberately not wired in — masks only.

**P1 — the agent contract (built):**
- `tools/shader-lab/contract.js` — `window.lab.describe()` / `window.lab.run()`, the fixed report
  schema, `evaluate()` (a thrown predicate becomes `UNMEASURED`, never `fail`), artifact saving.
- `serve.mjs` grew three things: image MIME types (without them `createImageBitmap` fails on a
  perfectly valid `.webp` and the real loader dutifully reports "no mask"), `GET
  /__lab/provenance` (git SHA + branch + **hash of every dirty file** — 53 of them on this tree),
  and `POST /__lab/artifact` writing to `runs/<runId>/` with both path segments sanitised and
  re-checked after resolution.
- `AGENTS.md` — the ~1-page door for a fresh agent. `runs/` and `cache/` gitignored.

**P2 first slice — real ingest (built):**
- `fixtures/tower-bridge.js` — the manifest, with expectations tiered `structural` /
  `invariant` / `authored`, the last **deliberately empty** so no measurement blesses itself.
- `bench-fixture.js` — five scenarios running the REAL `loadMaskImageTexture` against the real
  files. Current: **18 pass, 0 fail, 5 UNMEASURED** (`ok:false`, correctly — five axes genuinely
  cannot be measured at this rung).

**What it found on its first three runs** — all three are the rig working, and two are my errors,
which is the point of building it:

1. **`_Overhead` is not a mask kind.** The fixture declared it one; the bench's own gray-channel
   check failed it at `maxChannelDelta = 99` because it is colour *artwork*. `mask-catalog.js`
   has no `overhead` kind — "overhead" names an item ROLE. Corrected in the fixture
   (`ART_LAYERS`), and it means `<Prefix>_Overhead_Outdoors.webp` is the overhead *drawable's*
   own mask — the locked "every mask attaches to any item" decision appearing in real filenames.
2. **My per-floor polarity expectations were wrong**, and the art says why: underground is an
   open **river** (58.7% outdoors, eight cutwater piers), roof is a few small rooftops (19.4% of
   the canvas). Replaced with checks the data actually promises — **bimodality** (measured
   99.65-99.71% in the extreme buckets; catches a smeared decode, wrong colour space, bad resize)
   and **cross-floor difference** (130-176 mean bytes apart; catches the "every floor resolved to
   the same file" class that every per-file check passes happily). The polarity fractions are now
   reported as `UNMEASURED` proposals awaiting the author, not asserted.
3. **⚠ HYPOTHESIS — `_Outdoors` black carries two meanings**: "indoors" and "this floor has no
   art here". The roof mask is 80.6% black and almost none of it is indoors. Recorded as
   `BLACK_HAS_TWO_MEANINGS` in the fixture, tagged unproven; the next step is reading how
   per-floor outdoors is composited before anyone treats it as a defect.
4. **Observation for the author:** `Tower_Bridge_Underground_Specular.webp` is **0.11% painted,
   peaking at byte 176/255**. Legitimate for a level with a few metal fittings — but worth an eye
   given shine's history of shipping invisible, because a nearly-empty mask and a broken shader
   look identical from the far end of the pipeline.

**P2 second half — the derivation (built, same day):** `bench-derive.js` runs the real
`deriveFloorProducts` + `rasterizeAuthored` over the real three-floor item set. Three scenarios,
**all green**: `multi-floor-bands` (13 checks), `derived-vs-ingested-outdoors` (4),
`caster-grid-dim-independence` (8). The art IS loaded here — the derivation's coverage input is
genuinely art alpha, and substituting a mask would be inventing the producer's shape.

What it establishes that no single-floor bench could ask:

- **The band classification is correct on real multi-floor data.** Sky-reach item lists resolve
  exactly right per floor (underground sees middle-bg, middle-overhead, roof-bg; middle sees
  roof-bg; roof sees nothing), and `coverAbove` decreases monotonically bottom-to-top
  (0.73 → 0.19 → 0).
- **The rasterizer agrees with the ingest.** The 512-texel `rasterizeAuthored` grid lands within
  0.006 of the full-resolution ingest on all three floors, against the author-ratified fractions.
  That validates placement/UV/overwrite end to end.
- **The 2026-07-30 stride corruption is now pinned, and the pin is proven to work.** Coverage is
  stable across `casterGridDim` 512/768/1024 (spread 0.0009) while the outdoors gate correctly
  stays at 512. Crucially, a `detector-is-not-vacuous` check reproduces the bug's own mechanism on
  the real gate grid — flat-index read 0.1479 vs world-sampled 0.5879 — so the stability check is
  demonstrably sensitive to the class it exists for, rather than merely green.

**Two more corrections the bench extracted from me**, both the same shape as the `_Overhead` one:

- `MaskGrid` is `{spec, data}`; `ContentGrid` is `{w, h, data}`. I read `.w` on the former and
  died in `new ImageData`. Now funnelled through one `gridDims()`.
- **`coverAbove` is not `skyReach`.** I asserted the top floor's sky-reach must be zero; it must
  equal its *outdoors mask*, because `skyReach = outdoors × (1 − coverAbove)` and nothing is above
  the top floor. Replaced with two checks grounded in the author's ratified fractions rather than
  in the implementation.

**Author rulings folded in, 2026-08-01:** the three per-floor outdoors fractions are ratified and
now assert (tolerance ±0.02, *derived* from measured cross-scale drift of ≤0.0041, not guessed);
specular coverage is a ratified band (0.01%–15%, "expect less on most maps at varying degrees").
And the `_Outdoors`-black-means-two-things hypothesis was **ruled out** — black means indoors,
full stop, and indoor areas are fully painted with art. The wrong theory is recorded as
`BLACK_MEANS_INDOORS` so the roof mask's 80.6% black cannot invite it again.

### The overhead ruling, and what it unlocked (2026-08-01, later the same day)

Author: *"I use `_Overhead` but it's not a formal suffix. It's more for me to remember that a
layer belongs to a particular floor and therefore belongs as the highest element on that floor. I
use tiles or the foreground image for that scene's level for these textures."*

So the host is a TILE **or** the level FOREGROUND, and both are used. Those band completely
differently, and the fixture now models both (`OVERHEAD_HOST_TYPES`), which mattered more than it
sounds:

| host | `ownerFloorIndex` | own floor | floors below |
| --- | --- | --- | --- |
| level foreground | the floor index | `none` | `skyReach` |
| tile | `null` | **`overhead`** | `skyReach` |

**Declaring it as level art alone left the OVERHEAD caster band permanently empty** — a whole
production path the bench reported green while never executing it. With the tile host the band
fills correctly (coverage 255; caster height byte 95 ≈ 382 world px, matching the declared
19 units × 20 px/unit), and both hosts still agree about the floors below, which is the invariant
that says the host type only ever decides the OWN-floor band.

### The outdoors-composition question, answered with numbers

Author: *"we can either use the floors main `_Outdoors` to work that out OR I can author an
outdoors mask for overhead items. Ideally outdoors stuff should just use the main albedo's of that
floors `_Outdoors` mask."*

The `overhead-outdoors-composition` scenario measures what the fallback would actually cost, on
the real files, through the real `rasterizeAuthored`. Middle floor, baseline (floor mask only) =
**0.5864 outdoors**:

| second host placement | resulting outdoors | texels flipped to indoors |
| --- | --- | --- |
| full-canvas (level foreground) | **0.0224** | 69,920 |
| tile sized to its own art | **0.4165** | 21,896 |

**The mechanism, and it is not a bug in the composition rule.** Both overhead files are 97.9%
empty with identical content bounds — the mask is authored to mark *which overhead bits are
outside*, inside a full-canvas file that is otherwise transparent padding.
`compositeItemOverwrite` writes at every texel in the placement, deliberately (its own comment:
"a tile that can darken one too — wall a hole back up"), so it cannot distinguish that padding
from authored indoors. A mask describing 2% of the map, composited over a floor gate, declares the
other 98% enclosed.

**This supports the author's stated ideal directly**: one `_Outdoors` per floor avoids both rows
of that table. If a per-overhead mask is ever genuinely needed, the composition rule for that case
would have to be something other than an unconditional overwrite — gated on the overhead art's own
alpha, say — because the file's padding is otherwise indistinguishable from a painted interior.
Recorded as `OUTDOORS_RESOLUTION_RULING`; the scenario reports the delta and **asserts nothing
about which is right**, except the one part that is not a matter of taste (that a full-canvas
second host destroys the gate, which is now a real check).

### The handoff: a REAL caster field, and the extraction that made it honest

The chain now runs end to end — **real mask files → real loader → real derivation → real packing
→ a caster field** — which is the whole path the live double-shadow escaped through.

Getting the last arrow required a small `src/` change, and it is the extraction doctrine working
exactly as §3 predicted ("the lab becomes the second consumer that forces honest seams"):
`bakeCasterTexture`'s inner packing loop is now **`packCasterTexelData`**, an exported pure
function, moved line-for-line. Before, that RGBA layout lived inside a closure over
`getCasterHeightField`, so it was reachable only by standing up the whole subsystem — meaning the
byte layout every sun-shadow material reads had **no direct test at all**, and the lab would have
had to transcribe it. A transcribed packing rule is precisely the drift this plan forbids.

Two things fell out of that immediately:

1. **`caster-pack.test.mjs` — 12 new Node assertions in `npm run verify`** (6598 → 6610). The
   load-bearing one puts the 2026-07-30 stride corruption in the default gate permanently: a 2×2
   gate grid against 4×4 / 6×6 / 8×8 caster grids, asserting the world-sample lands in the right
   quadrant at every resolution — **plus a non-vacuity check** proving a flat-index read would
   disagree. It also pins the gate's fail-OPEN polarity (`?? 255`).
2. **The `real-caster-field` scenario**, whose numbers all cross-check against independently
   known truths rather than against each other: height byte 199/255 × 1024 = 799 px = the
   separately-reported `maxCasterHeightPx`; gate 58.8% = the author-ratified 0.587; R (90,865
   texels) ⊂ B (91,088), confirming the Round Seven repack still holds. The height field shows
   three clean strata — byte 100 = the middle floor at 400 world px, byte 199 = the roof at 800 —
   each exactly `(elevation − bottom) × 20 px/unit`.

### Real elevation bands, and the unbounded ceiling they brought with them

Author-given 2026-08-01: *"A typical map would have floors being between 10 and 20 tall. So the
river town map could be described as being Floor 1: 0-20, Floor 2: 20-40, Floor 3 (rooftops)
40 - infinity."* The fixture's placeholder bands are replaced by these.

**The `+Infinity` top is the valuable part**, not a detail. It is a genuinely distinct path —
`deriveFloorProducts` documents it as *"no ceiling declared: nothing counts as above, and the
report says so rather than inventing a number"*, and the same unbounded band is what makes
vegetation fall back to host-relative ordering (`Bug-Tracker.md` #2's escape hatch). The fixture
had never entered it. Two new checks now do: that exactly the top floor reports a non-finite
ceiling (a ceiling silently normalised to a number is indistinguishable from a declared one), and
that an infinite ceiling does not blank the floor's gate.

It also forced two fixes worth recording:

- **`Infinity − 1` is `Infinity`.** The bench placed an overhead tile at `ceiling − 1`, which on
  an unbounded floor is a nonsense elevation that *reads as plausible*. Both host types now fall
  back to one step above the band's bottom.
- **`JSON.stringify(Infinity)` is `null`** — so the persisted `report.json` would have rendered
  "unbounded" as "no value recorded", which is a different fact and a missing measurement. Every
  elevation reaching a report now goes through `reportElevation()` and survives the round-trip as
  `"Infinity (no ceiling declared)"`. `feedback_instruments_must_not_lie` applied to the reporting
  layer rather than the measurement.

`distancePixels` remains the one lab declaration, but it is now principled rather than arbitrary:
Foundry derives it as `grid.size / grid.distance`, and the near-universal 100 px / 5 ft default
gives exactly the 20 in use. The band *ordering* is what every check rests on, so the assertions
hold regardless; only the absolute heights (400 / 800 world px) are downstream of it.

### Discovery: mostly already solved, and one direction that wasn't

The last rung-2 item turned out to be largely built already — worth recording, because the useful
outcome of checking was NOT writing the thing.

`_WaterHard` is **not a stray file and not a mask**. Author-confirmed: *"there is no planned or
existing _WaterHard mask/texture… I never planned for water to have more than just a _Water
mask."* Correct — the 4.9 MB file in the fixture folder is an alternative **background artwork**
for the underground floor, and `mask-discovery.js`'s art-variant fallback exists for exactly it (a
tile whose art is `..._WaterHard.webp` must still find the masks named for the shorter base).
That, plus the exact-base-wins rule protecting `..._Overhead_Outdoors`, has been covered in
`mask-discovery.test.mjs` since 2026-07-25. The fixture described it wrongly as junk; corrected.

One direction genuinely was not pinned: the *reverse* — could that file be adopted **as** the
`_Water` mask? It cannot, and the reason is a single character: `matchMaskFiles` builds its
prefix as `` `${base}${suffix}.` `` **with the trailing dot**, so `_Water.` fails at the `h` in
`WaterHard`. Three new Node assertions now hold that, including the general rule that a suffix
followed by more word characters never matches. Simplifying the match to `includes('_Water')`
would silently bind 4.9 MB of background art as a water mask.

**These belong in Node, not the lab** — `matchMaskFiles` is pure, so the question needs no GPU, no
fetch and no browser. The lab's `non-mask-files` scenario now reports them as covered with a
pointer to the Node test, rather than as UNMEASURED.

**Rung 2 totals: 73 checks across 10 lab scenarios — 69 pass, 3 UNMEASURED, 1 "fail" that is a
check correctly reporting a deliberately non-production scale.** Plus 15 new Node assertions in
`npm run verify` (6598 → 6613): 12 pinning the caster packing, 3 pinning suffix matching.

The 3 remaining UNMEASURED are honest and each names what would close it: mask **orientation**
(needs an authored ground truth or a real composite — rung 3), **authored world points**
(`FIXTURE.authored`, the author's to fill), and the **overhead-outdoors composition delta**
(reported, awaiting a design ruling rather than a measurement).

**Rung 2 is closed.**

---

## 11. Rung 3, slice 1 — the composite's gamma arithmetic (2026-08-01)

`bench-composite.js` builds the REAL `buildEnvironmentalLightMaterials` and renders its REAL
`compositeMaterial`, checked against an independent CPU twin. Three scenarios, 8 checks, all
green. This is the first rung at which the lab can see what happens to a pixel *after* a
material writes it — where the specular gamma mismatch and tonemap washout both lived.

**The headline: "a no-op at noon" is now automated.** `environmental-light.js`'s own essay calls
it *"the strongest parity check there is"* — at `illum = white` the round-trip must be the
identity and the lit map pixel-identical to the unlit map. Measured worst error across six
albedo values: **1.2 × 10⁻⁵**. Any stray transfer error breaks it — a doubled OETF, a missing
EOTF, a tonemap that should not be running, a texture tagged with the wrong colour space.

**And the check that proves the bench can see what the identity cannot.** Gamma-space and
linear-space compositing *agree* at `illum = 1`, so the identity alone cannot tell them apart.
At night they diverge, and the bench now measures the real output against both models:

| case | gamma (shipped) | naive linear | display gap | relative |
| --- | --- | --- | --- | --- |
| deep night `#242448` | 0.00604 | 0.00377 | **5.7/255** | **37.6%** |
| dusk | 0.05087 | 0.04580 | 3.3/255 | 10.0% |
| shaded interior | 0.02829 | 0.02544 | 2.6/255 | 10.1% |
| bright (near convergence) | 0.25684 | 0.25484 | 0.5/255 | 0.8% |

37.6% at deep night independently corroborates the essay's documented *"~30% too dark"*, and the
decay toward noon is visible in the data rather than hidden. Coloration is separately confirmed
to add **before** the EOTF (adding it after would move that pixel by 0.11 — the named
"composite is gamma, not linear" class).

**⚠️ The instrument's own bug, and it is the more useful finding.** The first version judged
divergence with an **absolute tolerance on linear light values** and reported the night case as
"barely diverging" at 0.0023 — the very case that is a 37.6% error and the most visible point on
the curve. Linear light is not a perceptual scale: near black, enormous visible errors occupy
tiny numeric ranges. That is `feedback_measure_the_output_not_the_equation`, committed by the
test rig rather than the shader, and it is exactly the failure mode that makes a green suite
worthless. Divergence is now judged **after the OETF, in display units**, which is where the
essay's own "~30%" and "~0.049 vs ~0.071" live. A bright case is kept in the set specifically so
convergence-at-noon stays visible, and the "does not match linear" check is scoped to separable
cases so that convergence cannot false-fail it.

## 12. Rung 3, slice 2 — blend neutrality (2026-08-01)

`bench-blend.js` measures the identity element of every production blend mode, using a real
two-draw accumulation with `autoClearColor` forced false — the same shape
`runLightAccumulatePass` uses. The named class is
`feedback_blend_neutral_element_is_per_blend`: *"output `vec4(0)` to leave a buffer untouched" is
TRUE ONLY FOR NormalBlending.* Nine checks, all green:

| blend | used by | neutral | non-neutral → measured | equation predicts |
| --- | --- | --- | --- | --- |
| One/One Add | specular, bloom, candle, lightning, fluid emit | **0** | 0.25 → 0.749 | 0.75 |
| Zero/SrcColor | fluid absorb (the water tier-1 pass) | **1** | 0.25 → 0.1255 | 0.125 |
| One/One Max | point-light illumination + coloration | **0** | 0.9 → 0.898 | 0.9 |
| One/One Min | occlusion discs | **1** | 0.1 → 0.098 | 0.1 |

Each row asserts both directions — the neutral value leaves the destination at 0.5, and the
non-neutral value both changes it *and* matches its equation. Then one assertion states the class
outright: **the neutral element takes more than one distinct value across production blends**, so
"write `vec4(0)` and you're safe" is true for two of these and wrong for the other two.

### What this slice could NOT measure, and why that is the honest outcome

The half that actually bites is the MRT consequence — one blend state applies to *every*
attachment, so a multiply-blended pass writing the documented `attr = vec4(0,0,0,0)` default
multiplies `buf:scene.attr` by zero and wipes it. The bench imports the real
`buildSceneAttrZeroMrt` to try to reproduce that, and **cannot**: it reports `UNMEASURED`.

Two things were established on the way, and both are worth keeping:

- **A `count: 2` render target with no `renderer.setMRT()` writes nothing at all** — attachment 0
  included. The first version of this bench used one MRT target for every scenario and every
  reading came back zero, including the un-blended base draw. A three-case isolation probe (plain
  quad → single-attachment target = correct; identical quad → two-attachment target = all zero)
  located it in one step. The algebra scenario now uses a single-attachment target, which needs
  no MRT and should never have depended on it.
- **The scenario self-calibrates before asserting.** It first writes a known non-zero value to
  attachment 1 under plain NormalBlending and checks it comes back. It does not, so the scenario
  refuses to make claims about MRT blending. Without that gate it would have reported "the
  attachment is zero" — which is what a *successful* reproduction of the bug also looks like, and
  the instrument would have manufactured a finding out of its own limitation.

The bug class is documented and real (caught in review in water tier 1); what is missing is the
lab's ability to reproduce it, not evidence for it. The next step is recorded in the check's own
note: mirror how a production material actually composes `output` + `mrtNode`
(`scene-attr.js#buildRealFloorAttrMrtNode`, the `geometry.world` pass) rather than hand-building
a `NodeMaterial` as this bench does.

**Still open at rung 3** — the composite's *sequencing*: six writers accumulating into
`buf:scene.lit`, MRT scoping, and the grade's tone-mapping being active only when the Colour Grade
effect is enabled. Those need the pass bodies extracting from `vt-pan-viewer.js`, the same way
`packCasterTexelData` came out of the sun subsystem. The MRT question above is a prerequisite for
the first of them.

**Audit items the research pass surfaced** (production contradictions, cheap to fix in passing —
each is a 🧟 plausible-diagnosis-rots seed if left):
1. `mask-image.js:73-80` JSDoc says "Half"; `MASK_IMAGE_SCALE = 1`. One of them is wrong.
2. `graph/passes.js` declares `buf:final` (never exists; present really reads `scene.lit`) and
   `buf:scene.depth` (every descriptor sets `depth:false`); `buf:scene.lit` is real but
   undeclared. The DAG should tell the truth the frame executes.
3. `uGlobalTimeMs` is written by `point-light-pool.js:434` — verify the write survives every
   "point lights disabled/absent" path, or move it somewhere unconditional; if it can skip,
   every time-driven effect freezes together (🔌 a default-on seam...).
4. `vt-pan-viewer.js:4417-4419` stale comment ("resolves to exactly three passes"; seven live).
5. `bench-specular.js:104-107` "every frame by default" tonemap claim — wrong today; fixed by
   P3 replacing the transcription.
