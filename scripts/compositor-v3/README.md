# compositor-v3 — the V3 unified-forward pipeline

Parallel rendering path for Forward+ Stage B, built behind a flag (default OFF).
The shipping V2 compositor is untouched while this matures. Design specs live in
[docs/planning/v3/](../../docs/planning/v3/); this README is the code-side
orientation and the living design note for the floor-change fast path.

## What's here now (B1 in progress)

| File | Role | Status |
|------|------|--------|
| `FrameGraph.js` | Declarative pass scheduler (B0-2 §2): topo-order, validation, pooled RTs, per-pass timing. THREE-free core, Node-verified. | ✅ built + verified |
| `v3-flags.js` | `isV3PipelineEnabled()` / `isV3FloorFastPathEnabled()`; console API `MapShine.v3.help()`. | ✅ built |
| _(next)_ `ThreeAllocator.js` | Frame-graph allocator backed by `THREE.WebGLRenderTarget` (incl. `count:2` MRT for the attribute buffer). | ⏳ |
| `V3Pipeline.js` | Orchestrator: FrameGraph + ThreeAllocator + FullscreenPresent. First-plunge passes are **real**: `unifiedGeometry` → `present`. Fail-safe `isReady()` gate. | ✅ renders albedo |
| `ThreeAllocator.js` | Frame-graph allocator over `THREE.WebGLRenderTarget` incl. `count:2` MRT for the attribute buffer. | ✅ built + verified |
| `FullscreenPresent.js` | Raw passthrough blit of a texture → screen, mirroring V2 `_blitToScreen` state handling. | ✅ built |
| `__tests__/` | Node verification for the core modules (62 assertions). | ✅ green |
| _(next)_ lighting / attribute-buffer / post passes | Insert between geometry and present as they land (each with its own capability flag). | ⏳ |

**V3 is the DEFAULT renderer.** At the single V2 seam (`EffectComposer.js`, where
`_compositorV2.render(...)` was called) V3 owns the frame whenever it is enabled
(default) and initialized. V3 errors are logged loudly and do **not** silently
fall back to V2 — we are replacing V2, not maintaining it. V2 renders only when
V3 is explicitly disabled for debugging, or before V3 has initialized.

Debug opt-out to V2: `MapShine.v3.pipeline(false)` (this session), or reload with
`?msaV3=0`. `MapShine.floorCompositorV2` still exists — V3 reuses its
FloorRenderBus (that dependency migrates into V3 as scene-building is ported).

## Current state — how to test

Upload and reload; V3 renders by default. Graph: `unifiedGeometry` (albedo, all
floors) → `lighting` (ambient + Foundry lights) → `present` (linear→sRGB).

**Lighting now models Foundry v14** (see `ForwardLightingPass.js` header for the
exact math traced from `foundryvttsourcecode_v14`): illumination is **MAX-blended**
(overlapping lights no longer stack/blow out), lights have a **bright core + dim
ring** (`switchColor` with the `ratio = bright/max(dim,bright)` split), Foundry's
**attenuation** falloff, and color applied as a separate **SCREEN** coloration
layer. Brightness levels come from the scene environment (ambient daylight/
darkness/brightest + darkness weights), read from `canvas.colors`/
`canvas.environment` — so day scenes stay bright, night scenes go dark with light
pools, matching Foundry.

**Walls now block light.** Each light is rendered clipped to its Foundry
wall-bounded polygon (`lightSource.shape.points`, the same `ClockwiseSweepPolygon`
Foundry itself renders) — light stops at walls, and the ambient base shows
through beyond them. Geometry is cached per light and rebuilt only when Foundry
recomputes the shape (light moved / wall changed). The falloff is computed in
world space from the light center, so the shape clips without distorting the
gradient.

**Light set = Foundry's active sources.** The pass now iterates
`canvas.effects.lightSources` (what Foundry actually renders) instead of all
light documents. So V3's lit lights now exactly match Foundry's — including
level/elevation gating. **If any light vanished vs the previous build, it wasn't
an active Foundry light either** (wrong elevation, disabled, or on a non-viewed
level).

**Still NOT matched (follow-ups):**
- **Indoor/outdoor darkness** — the `_Outdoors` mask isn't sampled yet, so
  indoors gets the same ambient as outdoors. Next lighting step.
- Darkness/negative lights, non-default coloration techniques, light animation,
  soft wall edges (currently a hard wall boundary).

**Worth checking:** light **stops at walls** now (the headline change);
overlapping lights don't over-brighten; a torch shows a bright center fading to a
dim edge; colors read correctly; day vs night ambient differs. If a light looks
wrong, tell me which and how (missing / bleeds through a wall / wrong shape).

## Effects (candle flames, vegetation) — first cut

`V3EffectsBridge.js` drives the existing effect instances under V3 (V2's
`render()` isn't called, so nothing ticked them before):
- **Candle flames** — their `update()` is ticked in the geometry pass; the flame
  meshes already live in the bus scene, so they render there. They now animate.
- **Bush / Tree** — ticked too, and composited onto the lit scene in a new
  `effects` pass (graph is now geometry → lighting → effects → present), drawing
  the overlay meshes exactly as V2's `_compositeVegetationAboveWater` does.

**Lighting is now an illumination buffer** (as of the candle-glow work). The
light pass renders illumination-only into `scene.illum` (ambient bg base +
Foundry lights MAX-blended + additive glow from light-emitting effects), then
composites `scene.lit = albedo × illum` and screens coloration on top. This is
**mathematically identical** to the old per-light `albedo × illum` bake for
Foundry lights (`MAX(albedo·x) = albedo·MAX(x)`), so the Foundry-light look is
unchanged — but now **candle glow lights the map underneath** instead of adding a
flat overlay.

**Candle glow** (`_glowGroup` `LightMesh` disks) renders additively into
`scene.illum`, so candle-lit areas reveal/brighten the map — the way V2 feeds
candle glow into its light buffer.

**Vegetation** shows its real texture (the earlier black was my own bad ambient
sync); it's lit by the ambient day/night term. Local lights still don't reach it
(it composites after the light pass) — a follow-up.

**Indoor/outdoor ambient** — the lighting ambient now samples the scene's
`_Outdoors` mask: indoor areas get only the base darkness (lit by local lights),
outdoor areas get the sky ambient. The view→world→scene-UV reconstruction and
flip replicate `ColorCorrectionEffectV2` exactly. Default on; toggle with
`MapShine.v3.indoorOutdoor(false)` / `?msaV3Indoor=0`. Safe fallback: no mask →
uniform sky ambient (prior behavior), so it can't regress — only aligned indoor
darkening is added. **If indoor/outdoor looks inverted or shifted, toggle it off
and tell me** (the mask UV/flip is the one thing I couldn't verify without the
scene).

**HDR highlight rolloff** (replaced the earlier global ACES) — the present pass
leaves everything below a knee (`MapShine.v3.hdrKnee`, default 0.9) identical to
what lighting produced (Foundry-matched), and compresses only the over-knee hot
"filament" toward white while preserving its hue/saturation (global ACES bleached
saturated cores — that was the regression). Default on; `MapShine.v3.tonemap(false)`
hard-clips for comparison, `MapShine.v3.hdrKnee(0.95)` narrows the rolloff to only
the very brightest cores.

**Worth checking:** candles now *illuminate* the map around them (not just a
glow halo)? Foundry-light lighting still looks the same as before (it should be
byte-identical)? Vegetation still shows and tracks day/night?

**If it breaks:** grab the console error. No V2 fallback on a V3 error (by
design — bugs surface). `?msaV3=0` reloads into V2 for comparison.

## Running the core tests

The core (`FrameGraph`, `ThreeAllocator`, `V3Pipeline` wiring) is pure logic — no
WebGL, no Foundry — so it runs under Node. esbuild resolves the ESM imports:

```sh
node ./node_modules/esbuild/bin/esbuild scripts/compositor-v3/__tests__/run-tests.mjs \
  --bundle --format=esm --platform=node --outfile=./.v3test.mjs && node ./.v3test.mjs
```

Expected tail: `V3 core verification: 59 passed, 0 failed` / `ALL GREEN`.

## The floor-change fast path — why V3 removes the loading screen

### What a floor change costs today (V2), traced

A deliberate floor switch (`CameraFollower.stepLevel` / level-picker →
`_setActiveLevelByIndex`, [camera-follower.js:441](../foundry/camera-follower.js))
runs the **loading curtain** ([level-transition-curtain.js](../scene/level-transition-curtain.js))
because two expensive, content-rebuilding things happen underneath it:

1. **Foundry's own `canvas.scene.view({ level })`** (camera-follower.js:520, inside
   the curtain's `perform`) tears down and redraws Foundry's canvas → fires
   `canvasReady`. Heavy, and Foundry-owned.
2. **MSA's `levelMaskRebuild`** ([canvas-replacement.js:3512](../foundry/canvas-replacement.js),
   reacting to `mapShineLevelContextChanged`): `bus.swapBackgroundImage`, a cold
   mask load via `_loadMasksOnlyForBasePath` (canvas-replacement.js:3610), and
   `compositor.forceRepopulate` (canvas-replacement.js:3769). On a first visit to
   a floor this is a multi-hundred-ms-to-seconds "scene rebuilds element by
   element" — which is exactly what the curtain exists to hide
   (level-transition-curtain.js:594–604).

The curtain's readiness gates (`_awaitLevelMaskRebuild`,
`_awaitFloorCompositorPopulate`, `_awaitCompiledPrograms`, …) are all waiting for
**that rebuild** to finish. Remove the rebuild and the reason for the curtain
goes with it.

### Why V3 makes the rebuild unnecessary

V3's premise is the **unified pass**: every visible floor is drawn at real Z in
one geometry pass, its masks sampled from a fixed-budget resident/streamed cache
(B0-1, B0-2). The albedo is *already* floor-unified in V2
(`FloorRenderBus` Z-orders by floor — Forward+ §12.1); V3 extends that to
lighting/water/shadows so nothing per-floor needs re-composing on a view change.

Under that architecture a floor switch changes only **what the viewer is looking
from**, not **what content exists**:

- **viewed-floor uniform** — the unified/post shaders already need "which floor is
  the viewer on" (drives dimming of other floors, fog perspective, the
  attribute-buffer-derived current-floor gate, B0-1 §2.3). Changing floors = writing
  one uniform + re-deriving the cheap screen-space gates. No RT reallocation.
- **fog / vision** — MSA consumes Foundry's vision sources; the viewed floor's
  `.los`/`.fov` polygons must be current. `FogOfWarEffectV2` already tracks
  per-elevation-band exploration (Forward+ §11.4.1), so the band swap is a
  binding change, not a rebuild.
- **masks** — resident already; nothing to cold-load.

So the fast path is: **skip `levelMaskRebuild` + `forceRepopulate`, skip the
curtain, write the viewed-floor state, request one render.** The switch becomes a
sub-frame view change — no black screen, no progress bar.

### The seam it plugs into (already exists)

`CameraFollower._setActiveLevelByIndex` already has a **no-curtain branch**
(`useCurtain = emit && isVisibleChange && !isReactiveReason && curtainAvailable`,
camera-follower.js:457) and a `SKIP_CURTAIN_REASONS` set (camera-follower.js:44)
for reactive redraws. The V3 fast path generalizes this: when
`isV3FloorFastPathEnabled()`, a *deliberate* visible change also takes the direct
branch, and the `mapShineLevelContextChanged` handler's rebuild body early-returns
to a **view-only update**.

### Staging (do not do it all at once)

1. **B1-floor-a — gate the rebuild.** In the `levelMaskRebuild` handler, when the
   fast path is on AND V3 owns rendering AND the target floor's masks are already
   resident, early-return after the cheap state update (skip mask load +
   `forceRepopulate`). Fall back to the full rebuild whenever residency is not
   proven — **reliability first**: an un-resident floor must still rebuild (behind
   the curtain) rather than show a broken frame.
2. **B1-floor-b — bypass the curtain.** Route the switch through the direct branch
   under the fast-path flag; write the viewed-floor uniform; `requestRender`.
   Keep a short (~1 frame) cross-fade *in the compositor* (not a full-screen black
   curtain) if a hard cut reads poorly — cosmetic, decided against the S2 scene.
3. **B1-floor-c — Foundry-side `scene.view`.** Investigate whether the Foundry
   `canvas.scene.view({ level })` redraw can be avoided or made non-tearing when
   V3 owns the visuals (MSA only needs Foundry's *vision output* for the level,
   not its canvas repaint). This is the residual cost and the least-understood
   piece; treat as a spike, keep the curtain fallback until it's proven.

Reliability ordering throughout: a floor the fast path cannot safely serve
(masks not resident, vision not ready) **falls back to the curtain**, never to a
broken or half-built frame. The fast path is an optimization gated on proof, not
an assumption.

## The load path (module boot → first frame) — hardening targets

Traced `module.js` → `bootstrap` → `canvasReady`:

- `init` hook ([module.js:736](../module.js)) registers settings + shows the
  loading overlay cover.
- `ready` hook (module.js:1316) runs `bootstrap()` (module.js:1379), then
  `LoadingScreenManager`.
- `canvas-replacement.js` drives the actual scene draw + the two-stage shader
  warmup gate that produces the premature-"Ready!" stall (Forward+ §13.9 / A11).

V3's load-path priorities, in the user's stated order:
1. **Reliability** — never submit GPU work that risks the TDR stall (Forward+
   §13.5–13.9); the frame graph's staged passes make it natural to yield between
   heavy submissions. Small deliberate delays are acceptable to relieve the GPU.
2. **Smooth** — the loading overlay stays animated/honest; the "Ready!"-before-
   reveal regression (A11) is fixed as part of wiring V3's readiness signal into
   the overlay rather than the V2 two-gate warmup.
3. **Quick** — only after the above; the frame graph's per-pass timing feeds the
   diagnostics so load cost is measurable, not guessed.

These are notes for the B1 load-wiring step, not yet implemented.
