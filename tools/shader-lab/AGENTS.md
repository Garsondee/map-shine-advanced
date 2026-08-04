# Shader Lab — how to drive it (read this first, don't read the source)

A dev-only page that renders **real production shader code** against **real or synthetic inputs**
on a real WebGPU device, and reports exact numbers. Design: `docs/planning/Shader-Lab.md`.
Growth plan: `docs/planning/Shader-Lab-Proving-Ground.md`.

## 1. Start it

```bash
node tools/shader-lab/serve.mjs
```

Or, from Claude Code, `preview_start` with `name: "shader-lab"` (registered in
`.claude/launch.json`, `autoPort: true`). Then `navigate` to the port **with `force: true`** —
ES modules cache hard and a stale `lab.js` will be served to you *and* to the author.

Working in a git worktree? Start the server **from that worktree** so the page imports that
worktree's `src/`. Instances are cheap and isolated; that is the fleet story.

## 2. Ask what exists — never guess

```js
window.lab.describe()
```

Returns every registered bench, its rung, its scenarios, its params, its check ids. This is
the intended first call. Do not read bench source to find out what a scenario does.

## 3. Run a scenario

```js
await window.lab.run('fixture', 'outdoors-all-floors', { params: { scale: 0.25 } })
```

Returns a **report**:

| Field | Meaning |
| --- | --- |
| `ok` | true only if zero `fail`, zero `UNMEASURED`, and `calibration === 'OK'` |
| `checks[]` | `{id, status, measured, expected, note}` |
| `summary` | counts per status |
| `inputs` / `stats` | what was fed in, what was measured |
| `provenance` | git SHA, branch, **and the hash of every dirty file** |
| `persistedTo` | path under `tools/shader-lab/runs/<runId>/` |
| `artifacts[]` | PNGs etc. saved beside the report |

### The three statuses, and why the third exists

- `pass` — measured, and it matched.
- `fail` — measured, and it did not.
- **`UNMEASURED`** — *could not be measured*. Not a pass. Not a failure. A rig without this
  status will always find a way to call an unmeasured thing green
  (`feedback_instruments_must_not_lie`).

**`ok: false` with zero failures is normal and correct** — it means something real is still
unmeasured. Read `summary`, don't just read `ok`.

## 4. Look at the picture, don't only read numbers

Runs save PNGs to `tools/shader-lab/runs/<runId>/`. **Read those files directly** — you can see
images. A 1-D scanline through a 2-D artifact has lied to us before (that is why
`shaderLab.findHoles()` exists). If the pane won't screenshot for you ("Browser pane is not
displayed"), that is a known caveat and does **not** mean the author can't see it — save a PNG
and read it instead.

Leave the pane showing something meaningful, with the legend naming what is on it. The author
watches this same pane.

## 5. Add a scenario

Scenarios live on their bench (`bench-*.js`), in a `Map` keyed by name, each
`{ name, summary, async run(ctx) → { checks[], inputs, stats } }`. Use `evaluate(id, fn)` from
`contract.mjs` — it turns a thrown predicate into `UNMEASURED` rather than into a false `fail`.

Adding a whole new bench? Follow `fixture-lab.js`: **its own module file, its own canvas, its own
panel, and a second independent `change` listener** on the shared `#effect` `<select>`. Never
edit `lab.js` to add a bench — it is large and another session is often editing it.

## 6. Rules that are not optional

- **Import real `src/` code. Never transcribe it.** A lab-local copy of a shader, a tonemap, or
  a packing rule is a divergence waiting to happen, and we already have one on the books
  (`bench-specular.js`'s hand-written `neutralToneMap`).
- **Verify orientation, never assume it.** Every new texture mapping is a fresh chance to be
  upside-down (`feedback_y_flip_recurring_risk`). Benches calibrate empirically in `selfTest()`.
  If you cannot calibrate, report `UNMEASURED`.
- **Test at the REAL tier / scale.** A device-loss bug was invisible at Standard and only
  appeared at Extreme's real settings. Same for mask scale: production is 1, except `_Specular`
  at 0.5.
- **Lab-green is `BUILT (unverified)`, always.** Only the author, on a real scene, says `LIVE`.

## 7. Fixture One — real authored masks

`tools/shader-lab/fixtures/tower-bridge.mjs` — the "town river bridge" map. Three floors
(underground = an open **river**, middle = deck + town, roof = a few rooftops), every mask
10650 × 4950, the exact regime `vt/mask-image.js` was written against.

⚠️ **Scale costs real memory.** One mask at scale 1 is 52.7 M texels: ~53 MB as `'r'`, ~211 MB as
`'rgb'`, plus an equal transient during decode. Explore at `0.25`; use scale 1 deliberately.
`window.fixtureBench.releaseAll()` frees everything.

Two things in that file are worth reading before you trust any mask assumption: `ART_LAYERS`
(why `_Overhead` is **not** a mask kind — the fixture asserted it was and its own check caught
it) and `BLACK_HAS_TWO_MEANINGS` (an open hypothesis, tagged as such).

## 8. The `derive` bench — real multi-floor derivation

`bench-derive.js` runs the real `deriveFloorProducts` + `rasterizeAuthored` over the real
three-floor item set. **This is the stage the live sun-shadow double-shadow escaped through** —
lab-green march fixes never touched it because the lab used to rasterize its own synthetic caster
packing.

It loads the ART too (at `ART_ALPHA_SCALE`), because the derivation's coverage input is genuinely
art alpha, not a mask — feeding it a mask instead would be inventing the producer's shape.

⚠️ **Two neighbouring grid types with different shapes**, and conflating them is a real trap this
bench already fell into: a `MaskGrid` (what the derivation returns) is `{spec, data}` with its
size on `.spec.w/.h`; a `ContentGrid` (what you feed in) is `{w, h, data}`. Use `gridDims()`.

⚠️ **`coverAbove` ≠ `skyReach`.** `skyReach = outdoors × (1 − coverAbove)`. The top floor has zero
cover above it, so its sky-reach *equals its outdoors mask* — not zero. Asserting otherwise is a
mistake this bench also already made.

## 9. The `composite` bench — rung 3, the gamma arithmetic

`bench-composite.js` renders the REAL `compositeMaterial` from
`environmental-light.js` and checks it against an independent CPU twin. It owns the project's
strongest parity check: **`noon-is-a-no-op`** — at `illum = white` the composite must return the
albedo unchanged (measured to 1.2e-5). Any transfer-function error anywhere breaks it.

Two rules this bench learned the hard way, both worth carrying into any new numeric check:

- **Judge perceptual differences in DISPLAY space, not linear.** Near black, a 37.6% relative
  error is only 0.0023 in linear units. An absolute linear tolerance called the worst case on the
  curve "barely diverging". Convert through the OETF first.
- **Scope a "must NOT match X" check to cases where X is separable.** Gamma and linear
  compositing genuinely agree at `illum = 1`; asserting they differ there would false-fail on
  correct physics.

The CPU twin here transcribes the sRGB transfer pair, which normally this lab forbids. It is
justified *only* because the twin must be independent of the code under test — a twin that
called the same function would be a tautology — and because sRGB is a fixed published spec, not
project code that can drift. Do not take it as licence to transcribe anything else.

## 10. The `floor-lighting` bench — rung 3, multi-floor light occlusion

`bench-floor-lighting.js` builds a three-floor building out of primitives (ground = whole map;
first + second = a slab over the footprint only), writes a real `buf:scene.attr` through the REAL
`resolveItemFloorAttrUniforms` + `packFloorAttr`, and renders the REAL
`buildPointLightIlluminationMaterial` MAX-blended into a real illum target.

**It exists because three consecutive "fixed it" rounds on the light/elevation gate died on the
author's live scene**, each after a by-hand trace whose arithmetic was genuinely correct. The
arithmetic was never the problem: the material was sampling `buf:scene.attr` with a bare
`texture(attrTexture)` node, whose default uv is `uv()` — **and a light's fan geometry has no `uv`
attribute at all** (it sets only `position`). Every fragment of every light read the same constant
texel. The fix is `screenUV`, the technique the sibling coloration material — sharing the very same
geometry object — already used.

Its `the-frame-changes-at-all-between-floors` check is the generic detector for that whole bug
class: **hold every uniform fixed, vary only the buffer, and demand the frame change.** It read
`0.00% of pixels differ` before the fix and ~13% after. Any future gate that reads a screen-space
buffer from a world-space mesh should be checked the same way.

**A light is drawn by TWO meshes sharing ONE geometry** — illumination and coloration (the coloured
glow + every animated light effect). Fixing a gate in one leaves the other painting through solid
floors, which is exactly what the author saw next. Scenario `animated-coloration-is-occluded-too`
covers the second half; if you add a third light mesh, add a scenario for it too.

**Candle flames and lightning bolts are SEPARATE batched meshes** (candle-flame-render.js /
lightning-render.js), not point-light-pool meshes at all — one draw call can hold many
anchors/strands on DIFFERENT floors, so their `elevationRank` is baked PER-VERTEX at geometry-build
time, not a uniform (`boot.js#getCandleRenderState`/`getLightningRenderState`'s
`resolveAnchorElevationRank`). Scenario `candle-and-lightning-sprites-are-occluded` covers both.
⚠️ Its lightning fixture picks `uGlobalTimeMs` to land the envelope's `postT` around 0.2, NOT at
`spawnMs + durationMs` — the envelope's own `decay`/`connectSpike` terms are BOTH ~0 by full
duration (a bolt has genuinely finished by then), so t=1 renders nothing and looks exactly like an
occlusion bug that isn't one. See that scenario's own comment for the arithmetic.

**Occlusion fade and physical solidity are DIFFERENT questions — read
`occlusion-fade-does-not-defeat-solidity` before touching `buf:scene.attr`'s alpha again.** Foundry's
own roof-fade mechanic (`scene/occlusion.js`) fades a Tile's ON-SCREEN alpha so a player can see
their token underneath; that fade must NEVER reach `buf:scene.attr`'s solidity channel, or a light
under the roof stops being occluded the instant a token walks into the room. Building the MRT render
this scenario needs surfaced THREE separate real traps, in order:
1. **A raw pixel readback coordinate ignores the bench's own `orientation` flip.** Always route through
   `sampleAt`, never a hand-picked `(x,y)`.
2. **`renderer.setMRT(...)` is not optional.** In the vendored three.webgpu.js, when the renderer has no
   global MRT set, `material.mrtNode` REPLACES the whole fragment output instead of extending it — a
   `mrt({attr: ...})` with no `output` key writes NOTHING to slot 0. Wrap every MRT render in
   `renderer.setMRT(mrt({output, attr: vec4(0,0,0,0)}))` / restore, matching
   `vt/scene-attr.js#buildSceneAttrZeroMrt` exactly.
3. **`material.transparent` must match production (`true`).** An opaque material's alpha output is not
   meaningful — a low alpha written through `colorNode` reads back as flat 255 regardless of what the
   shader computed, which looks exactly like a solidity bug and isn't one.

Two traps this bench fell into **in itself**, both worth copying the fix for:

- **`depthTest: false` means three sorts your quads FRONT-TO-BACK**, so the ground floor drew last
  and overwrote every slab; the attr buffer came back all-floor-0 and looked exactly like a shader
  bug. Use `renderOrder`, not z-position.
- **A Y-CENTRED test feature cannot calibrate a Y-flip.** The footprint was centred, so every
  orientation probe was invariant and `calibrate` passed while telling you nothing; three checks
  passed only because they also sat on the centre line. The footprint is now deliberately
  asymmetric in Y (250..650 of 0..1000) and the probe has two distinct predicted values.

**Scenario `real-map-reproduces-the-live-bug` (2026-08-04, stage 0 of `docs/planning/Depth-
Buffer.md`) is a SECOND, separate rig inside this same file** β€” the real tower-bridge map (three
real Level backgrounds + two real `_Overhead` foregrounds), through the REAL `collectLevelTextures`
+ `sortByLayer` + the same real encoder/gate every other scenario here uses. It has its OWN camera,
render targets, and orientation calibration (`realMap`/`realOrientation`, `ensureRealMapAssets`) β€”
never reuse the synthetic bench's `attrRt`/`illumRt`/`camera`/`orientation`, they are sized for a
1000Γ—1000 toy world, not a 10650Γ—4950 real one.

⚠️ **This scenario is SUPPOSED to fail.** It exists to prove the live bug in an automated rig
before touching any production code β€” an unconfigured light under the Roof floor's own ordinary
background is occluded by NEITHER the sentinel-blocked fine gate NOR the overhead bit (which only
fires for FOREGROUND content). If a future session sees this scenario suddenly reporting `ok:true`,
that means the depth-buffer redesign landed and the bug is fixed β€” celebrate, then update this
scenario's own header comment (it says "MUST FAIL, TODAY" for a reason) rather than being alarmed.

Its four world-space test points are FOUND by scanning the REAL decoded art alpha
(`findRealArtRegion`), never guessed β€” this project's own art content was unknown going in, so a
hardcoded pixel coordinate would have been exactly the kind of invented producer-shape this lab
exists to avoid. One control (`TOP_FLOOR_CONTROL`) needs no scan to succeed at all: nothing exists
above the topmost floor in a 3-floor map, by construction, so it is the one check guaranteed to run
even if the real art turns out to have zero genuine alpha holes anywhere (plausible β€” a Level
background is usually painted edge-to-edge; `_Outdoors` masks, not alpha, carry this project's real
indoor/outdoor signal).

## 11. Known-good smoke test

```js
window.lab.describe().benches.map(b => b.name)   // ['fixture', 'derive', …, 'floor-lighting']
await window.lab.run('fixture', 'outdoors-all-floors', { params: { scale: 0.125 } })
// expect: 21 pass, 0 fail, 2 UNMEASURED, ok:false (orientation + authored points are real gaps)
await window.lab.run('derive', 'multi-floor-bands')
// expect: 13 pass, 0 fail, ok:true
await window.lab.run('floor-lighting', 'the-authors-three-lights')
// expect: 4 pass, 0 fail, ok:true — outdoor light seen from every floor, sealed light
// occluded from above, and ONE first-floor light both lit (outdoors) and dark (under the
// slab) in the SAME frame. Artifacts show the building's edge bitten out of the light.
await window.lab.run('derive', 'caster-grid-dim-independence')
// expect: 8 pass — including `detector-is-not-vacuous`, which reproduces the 2026-07-30
// stride bug on the real gate grid to prove the stability check can actually see it.
```
