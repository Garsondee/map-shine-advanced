# compositor-v3 — the V3 unified-forward pipeline

Parallel rendering path for Forward+ Stage B, and the **default renderer**
(flag `MapShine.v3.pipeline(false)` / `?msaV3=0` opts back into V2 for
debugging/A-B). The shipping V2 compositor is kept alive and reused for parts
V3 hasn't ported yet (see "Still missing" below); it is not otherwise touched.
Design specs live in [docs/planning/v3/](../../docs/planning/v3/); this README
is the code-side orientation and status doc — **more current than
[Forward+.md](../../docs/planning/Forward+.md) §15**, which lags it.

## What's here now

| File | Role | Status |
|------|------|--------|
| `FrameGraph.js` | Declarative pass scheduler (B0-2 §2): topo-order, validation, pooled RTs, per-pass CPU timing + injected per-pass GPU timing. THREE-free core, Node-verified. | ✅ built + verified |
| `ThreeAllocator.js` | Frame-graph allocator over `THREE.WebGLRenderTarget`. | ✅ built + verified |
| `GpuPassTimer.js` | Per-pass GPU ms via `EXT_disjoint_timer_query_webgl2` (Forward+ §16.3 P1). Async results, disjoint-safe, skips when another query owns the target (PerformanceRecorder), self-disables on errors. | ✅ built |
| `v3-perf.js` | The performance contract (§16.3 P1/P2): frame + per-pass budgets, `V3PerfMonitor` rolling stats, `RenderScaleGovernor` (DRS ladder w/ warmup, streaks, cooldown), `computeRenderSize`. Pure logic, Node-verified. | ✅ built + verified |
| `v3-flags.js` | Every `MapShine.v3.*` runtime flag + console API (`MapShine.v3.help()`), incl. `perf()`, `renderScale()`, `dither()`. | ✅ built |
| `V3Pipeline.js` | Orchestrator: FrameGraph + ThreeAllocator + FullscreenPresent. Pass graph: `sims → streaming → unifiedGeometry → lighting → effects → post → present` (sims/streaming split out so per-pass timings attribute main-thread cost — the 2026-07-14 hardware run showed ~8 ms resolution-independent CPU hiding in the combined pass). Fail-safe `isReady()` gate; frame counters feed the scene curtain's V3 readiness branch. **Render/present split:** all `'screen'` RTs allocate at `drawingBuffer × renderScale`; present upsamples. Governor closes the loop in `'auto'` mode. | ✅ live |
| `ForwardLightingPass.js` | Interim (non-clustered) per-light-mesh forward lighting: Foundry v14 illumination model, wall-clipped lights, day/night + indoor/outdoor ambient. | ✅ live |
| `V3EffectsBridge.js` | Ticks/composites reused V2 effect instances (candle flames, bush/tree) under V3. | ✅ first cut |
| `V3PostBridge.js` | Runs V2's `BloomEffectV2` + `ColorCorrectionEffectV2` (ToD + contextual indoor/outdoor grade) on the V3 lit buffer. Follows render-scale size changes. | ✅ live |
| `FullscreenPresent.js` | Linear→sRGB encode + hue-preserving HDR highlight rolloff + ±0.5 LSB encode dither (banding kill, §16.3 P7). Doubles as the DRS upsample (bilinear). | ✅ built |
| `__tests__/` | Node verification for the core modules (112 assertions). | ✅ green |
| _(not started)_ attribute buffer, clustered lighting, shadows, water, atmo fog, floor-change fast path | See Forward+.md §15 B2–B5 / the "Still missing" list below. | ⏳ |

## Performance contract (Forward+ §16 P-track) — live in V3

- **Budgets:** 16.6 ms/frame reference; provisional per-pass budgets in
  `v3-perf.js` (`PASS_BUDGETS_MS`). `MapShine.v3.perf()` prints per-pass CPU
  (last/avg/worst) + GPU (recent) vs budget, the render→present sizes, and the
  governor state. The same snapshot rides in every crash report (`record.v3`).
- **GPU timings:** per-pass via `EXT_disjoint_timer_query_webgl2` when the
  driver offers it (results lag 1–3 frames; treat as "recent"). CPU timings
  always. If the diagnostics `PerformanceRecorder` is actively measuring, V3
  yields the query target and skips those passes' GPU numbers rather than
  corrupting either measurement.
- **Dynamic resolution (DRS):** default `renderScale` mode is `'auto'` — the
  governor walks the ladder 1.0 → 0.85 → 0.7 → 0.6 → 0.5 on sustained
  over-budget cost (graph CPU/GPU cost, never RAF wall time — idle throttling
  must not read as "over budget"), with 15-frame down-streaks, 180-frame
  up-streaks, and a 90-frame cooldown between steps. **The governor is HELD
  while a scene is loading** (`__msaSceneLoading`) and discards a settle
  window of evidence after release — load storms are not steady-state
  evidence (hardware run 2026-07-14: it stepped down at frame 165 of a load
  and stuck). **Up-prediction scales only the GPU share** of the cost
  (`max(cpu, gpu × r²)`): CPU submission cost is resolution-independent
  (measured identical at 0.7 and 0.5), so the old whole-cost model could
  never climb back on CPU-heavy frames. `perf()` prints the predicted
  next-rung-up cost and the threshold it must clear. Scale changes are
  logged. Pin with `MapShine.v3.renderScale(0.75)`, restore with
  `.renderScale('auto')`, URL `?msaV3Scale=`. At scale 1.0 the present blit
  is pixel-exact (no resampling).
- **Scene-curtain readiness (V3 branch):** `scene-transition-curtain`'s reveal
  gate previously waited on V2-only signals (`__v2CompositorRenderPath ===
  'full'`, V2 frame-input validation) that never become true under V3 — every
  V3 load burned the full 20 s timeout before "revealing anyway" (the Native
  "won't load" stall, 2026-07-14). Under V3 the gate now requires: bus populate
  complete + ≥3 real V3 content frames (`V3Pipeline.getFrameCounters()`) + the
  same path-agnostic program/draw stability. The render seam stamps
  `window.MapShine.__v3OwnsFrame` each frame as the authoritative signal.
- **Dither:** the present pass adds ±0.5 LSB interleaved-gradient noise post-OETF
  (kills dark-scene banding). `MapShine.v3.dither(false)` / `?msaV3Dither=0` to A/B.
- **WebGPU telemetry (W0):** crash reports record `navigator.gpu` presence +
  adapter info (`record.webgpu`) so the W1 backend decision is made on real
  user-base numbers. Informational only — rendering stays WebGL2.

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
floors) → `lighting` (ambient + Foundry lights) → `effects` (vegetation) →
`post` (V2 colour grade) → `present` (encode).

## Colour grade (CC / post) — running V2's grade on V3

`V3PostBridge.js` runs V2's post-merge **ColorCorrection** (which hosts the
Contextual Scene Grade — the time-of-day timeline + indoor/outdoor packs) on the
V3 lit buffer, so the module's signature look is present for judging V3's lighting
fundamentals. It reaches the live `_colorCorrectionEffect` +
`_contextualSceneGradeManager` off `window.MapShine.floorCompositorV2`, ticks
them (V2.render, which normally does, is skipped under V3), and calls the same
`ColorCorrectionEffectV2.render(renderer, litRT, gradedRT)` seam FloorCompositor
uses post-merge.

- **Colour space:** CC consumes linear HDR and writes linear (its own ACES when
  its `toneMapping` param is on; no sRGB encode). The present pass does the
  linear→sRGB encode and **skips the highlight rolloff when CC tone-mapped** (a
  second compression would crush highlights); otherwise it keeps the rolloff.
- **Default ON.** `MapShine.v3.post(false)` / `?msaV3Post=0` shows raw V3 physical
  lighting (with the rolloff) for A/B. Any CC failure passes the lit buffer
  through untouched — never a broken frame.
- **Chain:** bloom (HDR, before the grade) → ColorCorrection. `MapShine.v3.bloom(false)`
  toggles bloom within the post chain (`post` is the master switch). Atmospheric
  fog and the stylizer chain are the remaining follow-ups on the same
  `render(in, out)` contract.
- **Depends on the `_Outdoors` mask** for the indoor/outdoor grade (same resolve
  as V3 lighting). If interior/exterior don't differentiate, that mask isn't
  resolving under V3 yet — the shared open item.

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

**Still NOT matched (follow-ups):** darkness/negative lights, non-default
coloration techniques, light animation, soft wall edges (currently a hard wall
boundary), clustered/per-fragment lighting (still one mesh per light — see B2).
Indoor/outdoor darkness IS matched now — see "Indoor/outdoor ambient" below.

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

**Indoor/outdoor ambient** — the lighting ambient samples the scene's `_Outdoors`
mask: indoor areas get only the base darkness (lit by local lights), outdoor
areas get the sky ambient. The mask decode matches the authoritative convention
shared by `ColorCorrectionEffectV2`/`LightingEffectV2`/water (`max(r,g,b)` with
a soft 0.18–0.82 band, alpha-gated validity) — a naive `.r` read was tried first
and was wrong. **Confirmed working 2026-07-13** after fixing the real bug: the
scene camera is a `PerspectiveCamera` (`composer.js:1156`), so any
`isOrthographicCamera`-gated view-bounds formula (and a naive unproject)
silently left the mask's screen→world reconstruction at degenerate
`(0,0)-(1,1)` bounds — every sample fell outside the scene rect and defaulted
to "outdoor" everywhere. Fixed by sourcing the view rectangle from
`view-projection-service.getVisibleWorldRect()` (the same ground-plane raycast
tile streaming already relies on) instead of any camera-type-specific formula —
**the rule for every future V3/CC consumer that needs screen→world bounds.**
Default on; toggle with `MapShine.v3.indoorOutdoor(false)` / `?msaV3Indoor=0`.
Diagnostics: `MapShine.v3.outdoors()` (full resolve trace + mask pixel
readback), `MapShine.v3.outdoorsDebug(true)` (red=indoor/green=outdoor tint).

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
