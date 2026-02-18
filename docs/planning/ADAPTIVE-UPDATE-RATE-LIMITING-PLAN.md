# Adaptive Update-Rate Limiting Plan

## Status
- Phase: **Implementation Complete** (all 10 items shipped)
- Priority: High (performance & stability)
- Builds on: Adaptive FPS cap system already implemented in `RenderLoop`

### Implementation Summary
| ID | Item | Status |
|----|------|--------|
| T1-A | Sub-rate updatable lanes in EffectComposer | ✅ Done |
| T1-B | Depth pass on-demand instead of continuous | ✅ Done |
| T1-C | Weather simulation static fast-path | ✅ Done |
| T2-A | Weather particle control-rate split | ✅ Done |
| T2-B | Adaptive effect decimation based on frame time | ✅ Done |
| T2-C | FrameCoordinator callback gating | ✅ Done |
| T3-A | Adaptive perception update interval | ✅ Done |
| T3-B | Adaptive vision throttle | ✅ Done |
| T3-C | UI loop power-saving | ✅ Done |
| T3-D | Control panel interval cleanup | ✅ Done |

---

## 1) Goal

Extend the adaptive frame-rate limiter beyond the render loop into **all high-frequency subsystems** — updatables, weather simulation, particle control, depth pass, vision, perception, frame coordinator callbacks, and UI loops — so that every per-frame cost center runs at the minimum rate needed for its current activity level.

The aim is measurably lower CPU/GPU utilisation in idle and low-activity scenes, smoother frame pacing under load, and no visual regression.

---

## 2) Current System Baseline

### 2.1 Render Loop (already adaptive)
- **File:** `scripts/core/render-loop.js`
- Three FPS tiers: idle (15), active (60), continuous (30)
- Fast-path early bailout skips per-RAF work when frame is not due
- Cached polling for `EffectComposer.wantsContinuousRender()` (33–120 ms interval)
- Runtime-tunable via `window.MapShine.renderAdaptiveFpsEnabled`, `renderIdleFps`, `renderActiveFps`, `renderContinuousFps`
- UI controls in Graphics Settings dialog

### 2.2 EffectComposer render pipeline
- **File:** `scripts/effects/EffectComposer.js`
- `render(deltaTime)` called by RenderLoop when a frame is allowed
- Iterates all **updatables** (`this.updatables` Set) calling `updatable.update(timeInfo)` every rendered frame
- Iterates all **effects** calling `effect.update(timeInfo)` + `effect.render()` every rendered frame
- `shouldRenderThisFrame()` only gates on GPU tier (low-tier skips medium effects every other frame); no dynamic frame-time adaptation

### 2.3 Registered Updatables (all run every rendered frame)
Registered via `effectComposer.addUpdatable()` in `canvas-replacement.js`:

| Updatable | File | Current Rate | Work Done |
|---|---|---|---|
| **CameraFollower** | `foundry/camera-follower.js` | Every frame | Reads PIXI pivot/scale → writes Three camera. Must stay every frame. |
| **WeatherController** | `core/WeatherController.js` | Every frame | Transition lerp, noise variability, wetness, environment outputs. Has frame-dedup guard. |
| **DepthPassManager** | `scene/depth-pass-manager.js` | Every frame | Full scene depth render (GPU). `_continuous = true` always. |
| **GridRenderer** | `scene/grid-renderer.js` | Every frame | Grid overlay update. Minimal when grid hasn't changed. |
| **DetectionFilterEffect** | `effects/DetectionFilterEffect.js` | Every frame | Syncs detection indicator meshes to token positions. |
| **DynamicExposureManager** | `core/DynamicExposureManager.js` | Every frame | GPU probe readback + exposure smoothing. Already self-throttled at `probeHz` (8 Hz). |
| **TileManager** | `scene/tile-manager.js` | Every frame | Darkness tinting, occlusion fade animation, window light uniform sync. |
| **TileMotionManager** | `scene/tile-motion-manager.js` | Every frame | Animated tile transforms (rotation, orbit, texture scroll). Requests continuous render when playing. |
| **TokenManager** | `scene/token-manager.js` | Every frame | Window light texture sync, token animations, darkness tinting. |
| **TokenMovementManager** | `scene/token-movement-manager.js` | Every frame | Walk/fly animation tracks — per-frame lerp of sprite position. |
| **DoorMeshManager** | `scene/DoorMeshManager.js` | Every frame | Animated door mesh updates. |
| **PhysicsRopeManager** | `scene/physics-rope-manager.js` | Every frame | Verlet integration for rope physics. |
| **InteractionManager** | `scene/interaction-manager.js` | Every frame | HUD positioning, selection box animation, light gizmo updates. |
| **OverlayUIManager** | `ui/overlay-ui-manager.js` | Every frame | Projects world anchors → screen-space DOM overlay positions. |
| **LightEditorTweakpane** | `ui/light-editor-tweakpane.js` | Every frame | Light editor overlay position sync. |

### 2.4 ParticleSystem (separate from updatables)
- **File:** `scripts/particles/ParticleSystem.js`
- Called as an effect's `update()` by EffectComposer
- Steps WeatherController (redundant if already updated as updatable)
- Runs `weatherParticles.update(dt)` — expensive emission/behavior recompute
- Runs `_applyQuarksCulling()` — frustum culling
- Runs `batchRenderer.update(dt)` — Quarks particle simulation

### 2.5 Frame Coordinator
- **File:** `scripts/core/frame-coordinator.js`
- Hooks into Foundry PIXI ticker at priority -50 (runs after Foundry)
- Runs `_syncCallbacks` and `_postPixiCallbacks` every PIXI tick (~60 Hz)
- `forcePerceptionUpdate()` throttled at 100 ms fixed interval
- Used by fog effect for vision mask sync

### 2.6 Vision & Visibility
- **VisionManager** (`scripts/vision/VisionManager.js`): 100 ms throttle on `refreshToken`-driven updates; immediate for wall/token create/delete
- **VisibilityController** (`scripts/vision/VisibilityController.js`): RAF-coalesced bulk refresh; hook-driven

### 2.7 UI Loops
- **TweakpaneManager** (`scripts/ui/tweakpane-manager.js`): Own RAF loop with `uiFrameRate` throttle; skips when not visible
- **ControlPanelManager** (`scripts/ui/control-panel-manager.js`): `setInterval(250ms)` for status panel; `setInterval(1000ms)` for sun latitude sync
- **TileMotionDialog** (`scripts/ui/tile-motion-dialog.js`): `setInterval(300ms)` for state refresh

---

## 3) Proposed Improvements

### Tier 1 — High Impact, Low Risk

#### T1-A: Sub-rate updatable lanes in EffectComposer
**Problem:** All 15+ updatables run every rendered frame, even when most have nothing meaningful to do.

**Solution:** Add an optional `updateHz` property to updatables. EffectComposer accumulates delta and only calls `update()` when the updatable's interval has elapsed. Updatables without `updateHz` run every frame (backwards-compatible).

**Candidates for reduced rate:**
| Updatable | Proposed Hz | Rationale |
|---|---|---|
| WeatherController | 15 Hz idle / 30 Hz transitioning | Pure state math; 60 Hz is overkill |
| TileManager (tint path) | 15 Hz | Tint changes slowly; occlusion fade can stay full-rate |
| TokenManager (tint path) | 15 Hz | Tint changes slowly; animations stay full-rate |
| GridRenderer | 5 Hz | Grid rarely changes |
| DetectionFilterEffect | 15 Hz | Detection state changes infrequently |
| OverlayUIManager | 30 Hz | DOM updates are expensive; 30 Hz is smooth enough |
| LightEditorTweakpane | 15 Hz | Only matters when light editor is open |
| InteractionManager | 30 Hz | HUD positioning + gizmos; 30 Hz is smooth |

**Updatables that must stay full-rate:**
- CameraFollower (camera sync is frame-critical)
- TokenMovementManager (animation tracks are frame-critical)
- TileMotionManager (animation tracks are frame-critical)
- PhysicsRopeManager (verlet integration is time-step sensitive)
- DoorMeshManager (animation)
- DynamicExposureManager (already self-throttled at 8 Hz probe; update() itself is cheap)

**Implementation sketch:**
```js
// In EffectComposer constructor:
this._updatableAccum = new Map(); // updatable → accumulated delta

// In EffectComposer.render():
for (const updatable of this.updatables) {
  const hz = updatable.updateHz;
  if (hz && hz > 0) {
    const accum = (this._updatableAccum.get(updatable) || 0) + timeInfo.delta;
    const interval = 1.0 / hz;
    if (accum < interval) {
      this._updatableAccum.set(updatable, accum);
      continue; // skip this frame
    }
    this._updatableAccum.set(updatable, accum % interval);
  }
  updatable.update(timeInfo);
}
```

#### T1-B: Depth pass on-demand instead of continuous
**Problem:** `DepthPassManager._continuous = true` renders a full scene depth pass every frame, even when no depth-dependent effects are active or the scene is static.

**Solution:** Default `_continuous = false`. Mark dirty on:
- Camera movement (detected by RenderLoop already)
- Tile/token position changes (via invalidation hooks)
- Effect enable/disable

When idle, skip the depth pass entirely. When active, render at most N Hz (e.g., 30 Hz).

**Estimated savings:** One full scene render call per idle frame.

#### T1-C: Weather simulation adaptive tick rate
**Problem:** `WeatherController.update()` does transition lerp, noise variability, wetness, and environment outputs every frame. When weather is static (no transition, no dynamic, no variability), this is wasted work.

**Solution:** Inside `WeatherController.update()`, detect static state and early-return:
```js
if (!this.isTransitioning && !this.dynamicEnabled && this.variability <= 0) {
  // Static weather — skip noise/wetness/output recalc.
  // Only copy target→current once, then early-return on subsequent frames.
  if (!this._staticSnapped) {
    this._copyState(this.targetState, this.currentState);
    this._updateEnvironmentOutputs();
    this._staticSnapped = true;
  }
  return;
}
this._staticSnapped = false;
```

### Tier 2 — Medium Impact, Medium Risk

#### T2-A: Weather particle control-rate split
**Problem:** `WeatherParticles.update()` runs expensive emission/behavior recompute (LOD, emitter shape, foam fleck sizing, darkness coupling, mask projection) every particle frame.

**Solution:** Split into:
1. **Fast path** (every frame): `batchRenderer.update(dt)` — particle simulation must tick every frame for smooth motion
2. **Slow path** (15–30 Hz): emission rate recalculation, emitter shape repositioning, LOD, darkness coupling, foam parameters

**Implementation:** Add a frame counter or time accumulator inside `WeatherParticles.update()`. Only run the slow path when enough time has elapsed.

#### T2-B: Adaptive effect decimation based on frame time
**Problem:** `shouldRenderThisFrame()` only gates on static GPU tier. It never adapts to runtime conditions.

**Solution:** Track rolling average frame time. When average exceeds budget (e.g., 20 ms for 60 fps target), begin skipping non-critical effects:
1. Medium-tier effects every other frame
2. Low-priority post-effects at half rate
3. Cosmetic updatables at reduced rate

When average recovers below budget, restore full rate. Hysteresis prevents oscillation.

#### T2-C: FrameCoordinator callback gating
**Problem:** `_syncCallbacks` and `_postPixiCallbacks` run every PIXI tick (~60 Hz), even when the Three.js render loop has decided to skip this frame.

**Solution:** When the adaptive FPS cap means the next Three.js render is not due, skip non-critical frame coordinator callbacks. Only fog/vision sync (which is hook-driven anyway) should remain ungated.

**Implementation:** Expose `RenderLoop.isFrameDue(nowMs)` as a cheap read. In `_onPixiTick`, check this before running post-PIXI callbacks.

### Tier 3 — Lower Impact, Already Partially Throttled

#### T3-A: Adaptive perception update interval
**Current:** Fixed 100 ms minimum interval in `FrameCoordinator.forcePerceptionUpdate()`.

**Proposal:** 50 ms during active camera/token motion, 200 ms when idle. Tie to the adaptive FPS mode (active vs idle).

#### T3-B: Adaptive vision throttle
**Current:** Fixed 100 ms in `VisionManager._updateThrottleMs`.

**Proposal:** 50 ms while dragging controlled tokens, 200 ms while idle. Reset to fast rate on `controlToken` hook.

#### T3-C: UI loop power-saving
**Current:** TweakpaneManager RAF loop runs continuously (throttled to `uiFrameRate`).

**Proposal:** When the Tweakpane panel has been open but not interacted with for >5 seconds, drop to 5 Hz. Restore full rate on any input event within the panel.

#### T3-D: Control panel interval cleanup
**Current:** `setInterval(250ms)` for status panel updates while visible.

**Proposal:** Only tick when panel is visible AND focused/hovered. Otherwise pause the interval entirely.

---

## 4) Implementation Order

### Phase 1 — Updatable sub-rate lanes + depth pass on-demand
1. Add `updateHz` support to `EffectComposer` updatable loop
2. Set `updateHz` on WeatherController, TileManager, TokenManager, GridRenderer, DetectionFilterEffect, OverlayUIManager, InteractionManager, LightEditorTweakpane
3. Change `DepthPassManager._continuous` default to `false`; add invalidation triggers
4. Add weather static-state early-return

**Files modified:**
- `scripts/effects/EffectComposer.js` — updatable sub-rate loop
- `scripts/core/WeatherController.js` — `updateHz` + static fast-path
- `scripts/scene/tile-manager.js` — `updateHz`
- `scripts/scene/token-manager.js` — `updateHz`
- `scripts/scene/grid-renderer.js` — `updateHz`
- `scripts/effects/DetectionFilterEffect.js` — `updateHz`
- `scripts/ui/overlay-ui-manager.js` — `updateHz`
- `scripts/scene/interaction-manager.js` — `updateHz`
- `scripts/ui/light-editor-tweakpane.js` — `updateHz`
- `scripts/scene/depth-pass-manager.js` — on-demand rendering

### Phase 2 — Particle and effect decimation
1. Split `WeatherParticles.update()` into fast/slow paths
2. Add dynamic frame-time adaptation to `shouldRenderThisFrame()`

**Files modified:**
- `scripts/particles/WeatherParticles.js`
- `scripts/particles/ParticleSystem.js`
- `scripts/effects/EffectComposer.js`

### Phase 3 — Frame coordinator + vision + UI refinements
1. Gate frame coordinator callbacks on render-due check
2. Adaptive perception/vision throttle intervals
3. UI loop power-saving

**Files modified:**
- `scripts/core/frame-coordinator.js`
- `scripts/core/render-loop.js` (expose `isFrameDue()`)
- `scripts/vision/VisionManager.js`
- `scripts/ui/tweakpane-manager.js`
- `scripts/ui/control-panel-manager.js`

---

## 5) Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Updatable sub-rate causes visible stutter in tint/overlay | Medium | Keep animation-critical updatables at full rate; only throttle slow-changing state |
| Depth pass on-demand misses an invalidation → stale depth | Medium | Conservative dirty triggers; keep `invalidate()` API for manual override |
| Weather static fast-path skips a state change | Low | Clear `_staticSnapped` on any `setTargetState()`, `setDynamic()`, or `setVariability()` call |
| Particle slow-path causes emission "pop" | Low | Interpolate emission rates over the slow-path interval |
| Frame-time adaptation oscillates | Medium | Hysteresis band (enter degraded at 20 ms avg, exit at 14 ms avg) |
| Frame coordinator gating delays fog sync | Low | Fog sync is hook-driven via `onPostPixi`; only gate optional sync callbacks |

---

## 6) Acceptance Criteria

### Functional
1. All updatables still receive correct `timeInfo` (with accumulated delta for sub-rate ones)
2. Weather transitions, token movement, tile motion, rope physics remain visually smooth
3. Depth pass updates correctly on camera movement and scene changes
4. No regression in fog/vision responsiveness during token drag

### Performance
1. Measurable reduction in per-frame CPU time during idle scenes (target: 20–40% fewer updatable calls)
2. Measurable reduction in GPU draw calls during idle (depth pass skipped)
3. No increase in worst-case frame time during active scenes
4. Stable frame pacing under adaptive FPS cap

### Safety
1. All sub-rate settings are runtime-tunable via `window.MapShine` overrides
2. Setting `updateHz = 0` or `undefined` on any updatable reverts to every-frame behavior
3. `DepthPassManager.setContinuous(true)` overrides on-demand mode for debugging
4. Adaptive effect decimation can be disabled via `window.MapShine.renderAdaptiveDecimation = false`

---

## 7) Reference Files

### Core render pipeline
- `scripts/core/render-loop.js` — Adaptive FPS cap, frame scheduling
- `scripts/effects/EffectComposer.js` — Effect/updatable orchestration
- `scripts/core/time.js` — TimeManager, delta clamping
- `scripts/core/frame-coordinator.js` — PIXI↔Three sync

### Updatables
- `scripts/foundry/camera-follower.js`
- `scripts/core/WeatherController.js`
- `scripts/scene/depth-pass-manager.js`
- `scripts/scene/grid-renderer.js`
- `scripts/effects/DetectionFilterEffect.js`
- `scripts/core/DynamicExposureManager.js`
- `scripts/scene/tile-manager.js`
- `scripts/scene/tile-motion-manager.js`
- `scripts/scene/token-manager.js`
- `scripts/scene/token-movement-manager.js`
- `scripts/scene/DoorMeshManager.js`
- `scripts/scene/physics-rope-manager.js`
- `scripts/scene/interaction-manager.js`
- `scripts/ui/overlay-ui-manager.js`
- `scripts/ui/light-editor-tweakpane.js`

### Particles
- `scripts/particles/ParticleSystem.js`
- `scripts/particles/WeatherParticles.js`

### Vision
- `scripts/vision/VisionManager.js`
- `scripts/vision/VisibilityController.js`

### UI
- `scripts/ui/tweakpane-manager.js`
- `scripts/ui/control-panel-manager.js`
- `scripts/ui/tile-motion-dialog.js`

### Settings
- `scripts/ui/graphics-settings-manager.js`
- `scripts/ui/graphics-settings-dialog.js`
