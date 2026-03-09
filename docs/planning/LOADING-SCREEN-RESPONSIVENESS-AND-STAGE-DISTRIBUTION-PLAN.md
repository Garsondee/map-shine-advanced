# Loading Screen Responsiveness and Stage Distribution Plan

## Date
2026-03-09

## Scope
Improve perceived responsiveness of the loading experience and make progress stages more evenly distributed and informative.

---

## 1) Current State Audit (What the code does today)

### 1.1 Stage model exists, but distribution is coarse and partially unused
- Stage weights are currently configured as 8 broad buckets in `canvas-replacement.js`:
  - `assets.discover` (5)
  - `assets.load` (25)
  - `effects.core` (15)
  - `effects.deps` (10)
  - `effects.wire` (5)
  - `scene.managers` (15)
  - `scene.sync` (15)
  - `final` (10)
- See duplicated setup blocks in @scripts/foundry/canvas-replacement.js#2905-2923 and @scripts/foundry/canvas-replacement.js#3354-3372.

### 1.2 `scene.managers` is configured but not actively advanced
- We update `scene.sync` several times during manager setup (0.0, 0.35, 0.55, 0.7), but there are no direct `setStage('scene.managers', ...)` updates in the active path.
- Examples of current updates are in @scripts/foundry/canvas-replacement.js#3897-3903, @scripts/foundry/canvas-replacement.js#3959-3960, @scripts/foundry/canvas-replacement.js#3993-4000.

### 1.3 Progress relies heavily on auto-progress bridges
- Auto-progress is used to hide long synchronous windows and avoid frozen bars.
- Example calls: @scripts/foundry/canvas-replacement.js#2921-2923, @scripts/foundry/canvas-replacement.js#3758-3761, @scripts/foundry/canvas-replacement.js#4286-4288, @scripts/foundry/canvas-replacement.js#5086-5089.

### 1.4 Main-thread responsiveness pain points
- There are explicit yields (`setTimeout(0)`) inserted for paint breathing, indicating known UI starvation risk.
- Example: @scripts/foundry/canvas-replacement.js#3852-3865 and @scripts/foundry/canvas-replacement.js#3900-3903.
- Big synchronous sections (scene/effect/manager init) can still hold the thread between updates.

### 1.5 Stage logic is renderer-level sound, but orchestration is fragmented
- Stage-range math in both renderers is correct and weight-based:
  - Legacy overlay: @scripts/ui/loading-overlay.js#45-112
  - Styled renderer: @scripts/ui/loading-screen/styled-loading-screen-renderer.js#72-135
- Problem is not range math; problem is update cadence and granularity of stage events from init pipeline.

---

## 2) Goals

1. **Immediate responsiveness**: loading UI reacts quickly at scene start and continues updating without long visual stalls.
2. **More spread-out stages**: avoid large jumps and make each significant subsystem visible in progress.
3. **Truthful progress**: reduce fake movement while keeping UX smooth.
4. **Maintain V2-first architecture**: no rollback to V1 pathways.

---

## 3) Proposed Stage Model (More spread out)

Replace current coarse 8-stage model with a 14-stage model mapped to actual lifecycle steps already present in `createThreeCanvas()`.

### Proposed top-level stage allocation

1. `bootstrap.cleanup` — 4%
2. `bootstrap.renderer` — 4%
3. `assets.discover` — 4%
4. `assets.load` — 14%
5. `assets.gpuWarmup` — 8%
6. `effects.core` — 10%
7. `effects.floorCompositor` — 8%
8. `managers.tokensTilesWalls` — 12%
9. `managers.interactionCamera` — 8%
10. `managers.ui` — 8%
11. `scene.sync` — 8%
12. `final.prep` — 5%
13. `final.floorAssign` — 4%
14. `final.fadeReady` — 3%

Notes:
- Keeps `assets.load` important but no longer dominant.
- Splits manager and finalization work into visible steps where users currently experience stalls.
- Keeps total = 100%.

---

## 4) Responsiveness Improvements

### 4.1 Centralize stage definitions and transitions
Create one stage manifest (single source of truth) and consume it from both load entry points.

- Why: stage config is currently duplicated (@scripts/foundry/canvas-replacement.js#2905-2923 and #3354-3372).
- Outcome: prevents drift and allows iteration of weights without hunting through initialization flow.

### 4.2 Drive stage progress from `_setCreateThreeCanvasProgress(...)`
Use the existing step tracker as canonical input for stage progression.

- `_setCreateThreeCanvasProgress` already marks fine-grained milestones (@scripts/foundry/canvas-replacement.js#411-414 and many calls through init).
- Add a mapping table: `progressStep -> {stageId, stageLocalProgress}`.
- This removes ad-hoc manual jumps and makes progress evolution deterministic.

### 4.3 Convert long sync blocks into chunked micro-batches
For loops/constructors that can be segmented, process N items then yield (`await nextFrame`) before continuing.

Primary targets:
- Manager initialization batch sections around @scripts/foundry/canvas-replacement.js#3995-4054.
- UI effect registration burst in @scripts/foundry/canvas-replacement.js#4460-5076.

### 4.4 Replace `setTimeout(0)` yielding with a dedicated `yieldToUI()` helper
Standardize yielding with strategy:
1. `await new Promise(requestAnimationFrame)` (paint priority)
2. fallback to `setTimeout(0)` if needed

Benefits:
- More consistent frame opportunity for progress repaint.
- Easier tuning and profiling.

### 4.5 Add update throttling for message/progress writes
Throttle `setMessage`/`setStage` DOM writes to ~30-60ms minimum cadence during intense loops.

- Prevents unnecessary style/layout churn while still appearing continuous.

### 4.6 Keep watchdog, but attach to stage-local subprogress
Current watchdog checks step stickiness (@scripts/foundry/canvas-replacement.js#2931-2964). Extend it with:
- stage-local last progress timestamp
- soft warning threshold before hard timeout
- clearer timeout message with stage and last known substep

---

## 5) Implementation Phases

### Phase A — Instrumentation and Baseline
1. Record stage timing metrics from `_sectionTimings` and per-step tracker.
2. Capture median/90th percentile durations over several scene sizes.
3. Produce baseline report for before/after comparison.

### Phase B — Stage Model Refactor
1. Introduce centralized stage manifest.
2. Replace duplicated `configureStages` blocks with shared helper.
3. Add 14-stage mapping table from progress steps.
4. Remove dead/unused stage IDs (or wire them fully).

### Phase C — Responsiveness Pass
1. Introduce `yieldToUI()` helper.
2. Chunk selected long loops (manager + UI registration paths).
3. Throttle loading overlay write frequency.
4. Ensure every stage has at least one real progress signal (not only auto-progress).

### Phase D — Final UX and Safety Tuning
1. Tune stage weights against measured durations.
2. Add stage-local watchdog diagnostics.
3. Validate debug mode still provides complete timing logs.

---

## 6) Validation Plan

### Functional
- Progress remains monotonic (never decreases).
- No missing stage labels/pills.
- Loading overlay still exits correctly in normal and debug modes.

### Responsiveness
- First visible loading update within 150ms of load start.
- No apparent frozen bar interval > 1.5s without text/stage change.
- Main-thread long tasks reduced in the manager/UI sections.

### Stage Distribution Quality
- No single stage consumes >35% of visual bar unless measured runtime justifies it.
- Final stage does not appear as a long “catch-all” stall.
- Users can identify what subsystem is currently loading from messages.

---

## 7) Concrete File Touchpoints (planned)

- `scripts/foundry/canvas-replacement.js`
  - Central stage manifest usage
  - step-to-stage mapping
  - yield helper usage in long sections
  - watchdog enhancement
- `scripts/ui/loading-overlay.js`
  - optional write throttling support
- `scripts/ui/loading-screen/styled-loading-screen-renderer.js`
  - optional write throttling parity and stage rendering consistency
- (optional) new helper module
  - `scripts/ui/loading-screen/loading-stage-orchestrator.js`

---

## 8) Risks and Mitigations

1. **Risk**: Over-throttling makes progress feel laggy.
   - **Mitigation**: cap throttle interval; bypass throttle on stage boundary transitions.

2. **Risk**: Too many stages increase complexity/noise.
   - **Mitigation**: keep detailed internal steps but group pills visually into major categories if needed.

3. **Risk**: Additional yields increase total load duration slightly.
   - **Mitigation**: apply chunking only in known long synchronous bursts; measure before/after.

---

## 9) Recommended First Slice (smallest high-impact change)

1. Centralize stage definitions (remove duplication).
2. Wire `scene.managers` properly (or remove it and reallocate weight).
3. Add step-to-stage mapping for the existing `_setCreateThreeCanvasProgress` milestones.
4. Introduce `yieldToUI()` and replace current ad-hoc yield spots.

This gives the biggest perceived improvement with minimal architectural risk.

---

## 10) Investigation Findings — Confirmed Bugs and Gaps

This section documents the concrete issues found during the deep-dive investigation of the actual code.

### 10.1 Critical Bug: Progress Bar Goes Backwards

**What happens:**
In `canvas-replacement.js`, the `final` stage is set to `0.9` immediately after the V2 shader-compile skip (line 4314), then set backwards to `0.4` after `initializeUI()` finishes (line 5087).

```
Line 4286: setStage('final', 0.0) → global ~90%
Line 4314: setStage('final', 0.9) → global ~99%   ← V2 shader skip is instant
Lines 4420-5078: initializeUI() runs (36 registrations, no updates inside)
Line 5087: setStage('final', 0.4) → global ~94%   ← BAR JUMPS BACK 5%
Line 5104: setStage('final', 0.50) → global ~95%
Line 5151: setStage('final', 0.85) → global ~98.5%
Line 5209: setStage('final', 1.0) → global 100%
```

The bar visually snaps back from ~99% to ~94% because the stage-local value decreases.

**Root cause:** Shader-compile stage (line 4314) was designed for V1 where real compilation took time. In V2, it fires instantly, overshooting the progress before `initializeUI` runs.

**Fix:** Remove or reorder the `setStage('final', 0.9, 'Shaders ready...')` call, or lower its value so `initializeUI` progress can continue monotonically from it.

---

### 10.2 Critical Gap: `scene.managers` Stage (15% weight) Is Never Driven

**What is configured:**
The 6th bucket, `scene.managers` with weight 15, maps to global range **60%–75%**.

**What actually happens:**
No `loadingOverlay.setStage('scene.managers', ...)` call exists anywhere in the codebase.
All ~10 manager initialization steps use `_setCreateThreeCanvasProgress('scene.managers.X')` for watchdog tracking only, but immediately transition to reporting against `scene.sync`.

The visible effect: the bar jumps from 60% to 75%+ invisibly while doing all manager work (TokenManager, TileManager, FloorStack, WallManager, TokenMovementManager, Interaction, OverlayUI, DropHandler, CameraFollower, PixiInputBridge, CinematicCamera — ~11 named managers plus the lightweight batch).

**`_setCreateThreeCanvasProgress` calls mapped to managers (with no overlay update):**
```
scene.managers.tokens.init
scene.managers.yield.beforeTiles
scene.managers.tiles.init
scene.managers.yield.afterTiles
scene.managers.floorStack.init
scene.managers.floorLayerManager.init
scene.managers.walls.init
scene.managers.tokenMovement.init
scene.managers.lightweightBatch.construct
scene.managers.lightweightBatch.init (or per-id in debug mode)
scene.managers.interaction.init
scene.managers.overlayUI.init
scene.managers.lightEditor.init
scene.managers.dropHandler.init
scene.managers.cameraFollower.init
scene.managers.levelNavigatorOverlay.init
scene.managers.pixiInputBridge.init
scene.managers.cinematicCamera.init
```

**Fix:** Add `setStage('scene.managers', progress)` calls alongside each existing `_setCreateThreeCanvasProgress` call in this block. Map them to evenly spaced local progress values (e.g., `tokens.init` → 0.05, `tiles.init` → 0.15, …, `cinematicCamera.init` → 0.95).

---

### 10.3 Major Gap: `FloorCompositor.initialize()` — ~35 Sequential Effect Inits, No Progress

`FloorCompositor.initialize()` runs as a single synchronous block (called via `effectComposer` during the `effects.core` stage). It initializes **35+ effects sequentially**:

```
SpecularEffectV2, FluidEffectV2, IridescenceEffectV2, PrismEffectV2,
BushEffectV2, TreeEffectV2, FireEffectV2, WindowLightEffectV2,
CloudEffectV2, WaterSplashesEffectV2, WeatherParticlesV2,
AshDisturbanceEffectV2, SmellyFliesEffect, LightningEffectV2,
CandleFlamesEffectV2, PlayerLightEffectV2,
LightingEffectV2, SkyColorEffectV2, ColorCorrectionEffectV2,
FilterEffectV2, AtmosphericFogEffectV2, FogOfWarEffectV2,
BloomEffectV2, SharpenEffectV2, WaterEffectV2,
OverheadShadowsEffectV2, BuildingShadowsEffectV2,
DotScreenEffectV2, HalftoneEffectV2, AsciiEffectV2,
DazzleOverlayEffectV2, VisionModeEffectV2, InvertEffectV2, SepiaEffectV2, LensEffectV2
```

The progress system sees only two events for this entire block:
```
setStage('effects.core', 0.10, 'Initializing V2 compositor...')  ← before
setStage('effects.core', 1.0, 'V2 compositor ready')             ← after
```

**Fix:** Add an `onProgress(label, index, total)` callback parameter to `FloorCompositor.initialize()`. Wire it from `canvas-replacement.js` to emit `setStage('effects.core', ...)` at each init call within the compositor. No yield needed — just progress granularity.

---

### 10.4 Major Gap: `initializeUI()` — 36 `registerEffect` Calls, No Progress

The `initializeUI` async block (lines 4422–5078) registers **36 UI effect schemas** in sequence:

```
weather, lighting, specular, fluid, iridescence, prism, sky-color,
windowLight, fire-sparks, water-splashes, underwater-bubbles,
ash-disturbance, smelly-flies, lightning, candle-flames, player-light,
bloom, colorCorrection, filter, atmospheric-fog, fog, sharpen,
dotScreen, halftone, ascii, dazzleOverlay, visionMode, invert, sepia,
lens, water, cloud, overhead-shadows, building-shadows, ...
```

There are **zero** `setStage` calls inside this block. The bar sits frozen at ~99% for the entire UI setup duration. This is compounded by bug 10.1 — the bar first jumped to 99%, then after the block it jumps backwards to 94%.

**Fix:** Add `setStage('final', progress)` calls for every N registrations (e.g., every 9 = ~4 updates covering `final` 0.1 → 0.35, giving room for subsequent signals to advance monotonically past 0.4).

---

### 10.5 `auto-progress` Targets Are Misconfigured for V2 Path

```
startAutoProgress(0.55, 0.015)  ← targets 55% global from effects.core stage
```

The `effects.core` stage covers global 30–45%. Targeting 55% crosses into a different stage (`effects.deps`), which creates confusing coupling between the auto-progress system and stage boundaries.

Additionally, the `startAutoProgress(0.98, 0.01)` call at line 4287 starts from the `final` stage at 0% then `setStage('final', 0.9)` immediately fires and races with auto-progress. The auto-progress target of 0.98 (global) also gets exceeded by `setStage('final', 1.0)` at the end.

**Fix:** After redesigning stage weights in Phase B, recalibrate all `startAutoProgress` targets to stay within their owning stage range (expressed as stage-local 0–1 values rather than raw global values).

---

### 10.6 `sceneComposer.initialize()` Has an `onProgress` Callback Already

`composer.js` line 400 exposes `options.onProgress(loaded, total, asset)` and calls it for each texture load. This is already wired in `canvas-replacement.js` to emit `setStage('assets.load', v, ...)` updates per-texture.

**Finding:** This is already working correctly. It is the strongest source of real progress today. No fix needed — preserve this pattern as the reference implementation for other gaps.

---

## 11) Full Execution Timeline vs Overlay Stage Signals

Below is the complete ordered execution map for `createThreeCanvas()` in V2 mode, showing where overlay updates exist and where gaps occur.

| Step (in order) | `_setCreateThreeCanvasProgress` | `loadingOverlay.setStage` | Notes |
|---|---|---|---|
| Entry | `entered` | — | Pre-load outer wrapper |
| Destroy old canvas | `cleanup` | — | No update |
| Session start | `bootstrap/renderer` | — | No update |
| Wait Foundry ready | `waitForFoundryCanvasReady` | — | No update |
| Scene settings validate | `sceneSettings.ensureValid` | — | No update |
| DOM canvas create | `canvas.create` | — | No update |
| Renderer attach | `renderer.attach` | `assets.discover 0.0` (immediate) | First visible update |
| SceneComposer init (textures) | `sceneComposer.initialize` | `assets.load` per-texture | **Good — real progress** |
| GPU texture warmup | `gpu.textureWarmup` | `assets.load` per texture | **Good — real progress** |
| FloorCompositor init (35 effects) | — | `effects.core 0.10` then `1.0` | **GAP — no per-effect signal** |
| TokenManager init | `scene.managers.tokens.init` | `scene.sync 0.0` | **WRONG STAGE — should be scene.managers** |
| Yield | `scene.managers.yield.beforeTiles` | — | — |
| TileManager init + sync | `scene.managers.tiles.init` | — | No update |
| Yield | `scene.managers.yield.afterTiles` | — | — |
| FloorStack init | `scene.managers.floorStack.init` | — | No update |
| FloorLayerManager init | `scene.managers.floorLayerManager.init` | — | No update |
| WallManager init | `scene.managers.walls.init` | — | No update |
| TokenMovementManager init | `scene.managers.tokenMovement.init` | — | No update |
| Lightweight batch (7 managers) | `scene.managers.lightweightBatch.*` | `scene.sync 0.7` | **WRONG STAGE** |
| InteractionManager init | `scene.managers.interaction.init` | — | No update |
| OverlayUI init | `scene.managers.overlayUI.init` | — | No update |
| LightEditor init | `scene.managers.lightEditor.init` | — | No update |
| DropHandler init | `scene.managers.dropHandler.init` | — | No update |
| CameraFollower init | `scene.managers.cameraFollower.init` | — | No update |
| LevelNavigatorOverlay init | `scene.managers.levelNavigatorOverlay.init` | — | No update |
| PixiInputBridge init | `scene.managers.pixiInputBridge.init` | — | No update |
| CinematicCamera init | `scene.managers.cinematicCamera.init` | — | No update |
| Enter finalization | — | `final 0.0` | Jump from nowhere in scene.managers |
| Shader compile SKIP | — | `final 0.9` | **Instant jump to 99% — BUG** |
| initializeUI (36 registrations) | `initializeUI` | — | **GAP — bar frozen at 99%** |
| Post-initializeUI | — | `final 0.4` | **BACKWARDS JUMP to 94%** |
| Tile wait | — | `final 0.50` | — |
| preloadAllFloors | `preloadAllFloors` | `final 0.85` | — |
| Fade-in / Ready | — | `final 1.0` | Overlay dismissed |

---

## 12) Prioritized Fix Actions

### P0 — Immediate bugs (fix in next coding session)

**P0-A: Fix backwards-jump at shader skip + initializeUI**
- File: `canvas-replacement.js`
- Change: Lower `setStage('final', 0.9, 'Shaders ready...')` at line 4314 to `0.05` (or remove; shaders are genuinely instant in V2, no user-visible feedback needed).
- Result: Bar goes monotonically 0.0 → 0.4+ through initializeUI block.

**P0-B: Wire `scene.managers` stage**
- File: `canvas-replacement.js`
- Change: Add `loadingOverlay.setStage('scene.managers', progress)` alongside each existing `_setCreateThreeCanvasProgress('scene.managers.X')` call. Assign evenly-spaced local progress values per manager:
  ```
  tokens.init          → 0.05
  tiles.init           → 0.20
  floorStack.init      → 0.30
  floorLayerManager    → 0.35
  walls.init           → 0.45
  tokenMovement.init   → 0.50
  lightweightBatch     → 0.65
  interaction.init     → 0.75
  overlayUI.init       → 0.80
  cameraFollower.init  → 0.88
  pixiInputBridge.init → 0.93
  cinematicCamera.init → 0.98
  ```
- Change: Remove the incorrectly-staged `setStage('scene.sync', 0.0)` and `setStage('scene.sync', 0.7)` calls that currently happen in the managers section — they belong in an actual scene.sync phase.

### P1 — High-impact, low-risk additions

**P1-A: Add per-effect progress to `FloorCompositor.initialize()`**
- File: `FloorCompositor.js` + `canvas-replacement.js`
- Change: Add `onProgress(label, index, total)` callback param to `FloorCompositor.initialize()`. Wire to `setStage('effects.core', index/total)` in `canvas-replacement.js`.
- Effort: Small (one new param, one callback call per `initEffect()`).

**P1-B: Add progress signals to `initializeUI()` registration burst**
- File: `canvas-replacement.js`
- Change: After every 9 `registerEffect` calls, emit `setStage('final', localProgress)` at monotonically increasing values from 0.1 to 0.35 (leaving 0.4+ for existing post-registration signals).
- Effort: 4 inserted `safeCall(() => setStage(...))` lines.

### P2 — Architecture improvements (Phase B of the plan)

**P2-A: Centralize stage manifest**
- Move stage config out of the two duplicated `configureStages` blocks into a shared constant.

**P2-B: Recalibrate `startAutoProgress` targets**
- All targets should be expressed as stage-local values within their own stage range.
- Use the revised 14-stage model or the corrected current model.

**P2-C: Add `yieldToUI()` helper**
- Standardize yielding using `requestAnimationFrame`-based Promise.
- Apply at existing `setTimeout(0)` locations for consistency.
