# Rendering Suspects Log

Working notes for potential performance and memory issues observed in profiling screenshots.

## Context

- Runtime: Foundry VTT V12 module (`map-shine-advanced`)
- Symptom: very slow/choppy rendering, memory growth over time, eventual crash
- Method: collect suspects from profiler screenshots first; deep-dive later

## Findings So Far

### 1) Large grey profiler time block is likely idle/wait, not core bottleneck

- Screenshot stacks show Windows wait/message-loop frames (`ZwWaitForAlertByThreadId`, `SleepConditionVariableSRW`, etc.).
- Interpretation: this grey block usually indicates thread waiting/scheduler idle slices, not direct JS/WebGL work.
- Action: treat as context, not primary optimization target.

### 2) Heavy frame cost is in WebGL render path

- Stacks include renderer-heavy frames (`WebGLRenderer.render`, `renderObjects`, `setProgram`).
- Interpretation: actual hot path is likely GPU/driver + high per-frame render workload and state churn.
- Action: prioritize reducing per-frame render/rebuild churn and pass count.

### 3) Potential per-light per-frame allocation in zoom calculation

- File: `scripts/effects/ThreeLightSource.js`
- Suspect: `_getEffectiveZoom()` allocates `new THREE.Vector2()` when using perspective-camera zoom estimation.
- Why suspect: called from `updateAnimation()` path; multiplied by number of lights each frame can create GC pressure.
- Investigation result:
  - Confirmed: in perspective-camera mode, `_getEffectiveZoom()` allocated a fresh `THREE.Vector2` for `renderer.getDrawingBufferSize()` each call.
  - Confirmed: `updateAnimation()` invoked `_getEffectiveZoom()` twice per light per frame (once via `_getWallInsetWorldPx()`, once directly).
- Simple fix applied:
  - Reused a per-instance scratch vector (`this._tmpDrawingBufferSize`) in `_getEffectiveZoom()`.
  - Added optional `zoomOverride` param to `_getWallInsetWorldPx()` and passed the already computed `zoomNow` from `updateAnimation()`.
  - Net effect: no per-call Vector2 allocation in this path and one less `_getEffectiveZoom()` invocation per light per frame.

### 4) Frequent geometry rebuild risk in light animation update loop

- File: `scripts/effects/ThreeLightSource.js`
- Suspect: `updateAnimation()` may call `updateData(this.document, true)` during inset/zoom changes.
- Why suspect: forced rebuild path recreates geometry and can churn memory/CPU when many lights are active.
- Investigation result:
  - Confirmed: inset/zoom maintenance could trigger periodic forced rebuilds for many lights.
  - Confirmed: rebuild checks ran even when wall inset was effectively disabled, and even in circle-fallback mode where inset rebuild has no visual benefit.
- Simple fix applied:
  - Rebuilds now only occur when inset is actually enabled (`wallInsetPx > 0`) and the light uses wall-clipped polygon geometry (not circle fallback).
  - Rebuild throttle relaxed from ~10Hz to ~5Hz (`0.1s` -> `0.2s`) to reduce churn while zooming.
  - When rebuilds are not relevant, inset/zoom trackers are still updated so state stays coherent.

## Evidence References

- Screenshot 1: `assets/c__Users_Ingram_AppData_Roaming_Cursor_User_workspaceStorage_73c1d63ee6115b2ea67899524afe7131_images_image-76583f8b-d9bb-4f9c-b680-ab4aad45c516.png`
- Screenshot 2: `assets/c__Users_Ingram_AppData_Roaming_Cursor_User_workspaceStorage_73c1d63ee6115b2ea67899524afe7131_images_image-2b6dabb7-0370-44a0-a06c-18323d1dbb0b.png`

## Next Screenshot Intake

For each new screenshot, append:

- observed hot stack(s)
- likely subsystem
- confidence level (low/med/high)
- whether it suggests CPU bound, GPU bound, or memory leak/churn
- immediate next probe to confirm/refute

## Screenshot Intake Updates

### Screenshot 3 (`image-b7e8d6e5-b31f-4640-a79b-b2a60b84aeb8.png`)

- observed hot stack(s):
  - `setProgram` -> `WebGLRenderer.render` -> `renderObjects` -> `FloorCompositor.render`
  - Browser pipeline frames around refresh/timer callbacks (`nsRefreshDriver`, `requestAnimationFrame`)
  - Thread wait/message-loop frames still present below
- likely subsystem:
  - Main render loop + shader/program switching in Three.js compositor path
- confidence:
  - high (for render-path pressure), low (for proving leak source from this screenshot alone)
- suggests:
  - primarily render-bound frame workload/state churn (CPU driver overhead + GPU work)
  - this screenshot alone does not prove a leak, but is consistent with too many expensive passes/material program switches per frame
- immediate next probe:
  - add/increase per-pass timing capture in `FloorCompositor.render` and identify which pass contributes most (`lighting`, `cloud`, `overhead shadows`, `building shadows`, `lens`, per-level loop)
  - inspect renderer info counters over time (`renderer.info.programs`, `renderer.info.memory.textures`, `renderer.info.memory.geometries`) to catch monotonic growth

### Screenshot 4 (`image-95e69ddd-1aea-4c6f-9b99-e191b5cf75d5.png`)

- observed hot stack(s):
  - Frequent `update` chains inside `requestAnimationFrame` callback path
  - Repeated effect updates visible in stack names (notably weather/cloud and compositor-linked effects)
  - `render` calls still present, but this view highlights update frequency/churn more than deep GPU wait
- likely subsystem:
  - Per-frame update orchestration (JS-side effect update fan-out before render)
- confidence:
  - medium-high (for update-loop pressure), medium (for exact top offender without timings)
- suggests:
  - potential CPU-bound frame setup overhead from many active effect `update()` calls each tick
  - possible duplicated or redundant updates in the same frame across subsystems
- immediate next probe:
  - instrument/update counters per effect per frame to detect duplicate calls
  - capture CPU time split between `update()` and `render()` phases in `FloorCompositor`
  - temporarily disable groups of effects (weather, overhead shadows, lighting, water) to see which update cluster drops frame time fastest

## Deep Dive: OverheadShadowsEffectV2

### High-likelihood FPS hotspots (confirmed by code audit)

- `render()` performs many full-scene traversals (`mainScene.traverse`) in one frame path.
- `render()` executes many render passes/RT writes in sequence (roof visibility, blocker, roof capture, fluid pass, optional tile projection/receiver passes, final shadow pass).
- Tile projection path can add several additional traversals + RT renders when projection tile IDs are present.

### Memory/churn risks identified

- Per-floor mask cache (`_floorStates`) retained texture refs across runtime and was not explicitly cleared on cache invalidation/dispose.
- `update()` recomputed effective zoom twice (minor but avoidable per-frame overhead).

### Simple fixes applied

- `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`
  - Reused existing `_floorStates` entries in `bindFloorMasks()` instead of replacing objects each bind.
  - Cleared `_floorStates` in `invalidateDynamicCaches()` and `dispose()` to prevent stale texture-ref retention over long sessions/scene transitions.
  - Removed duplicate zoom computation in `update()` by reusing `camZoom` for `u.uZoom`.

### Remaining structural concern (not changed yet)

- The dominant performance cost is likely architectural: many scene traversals + multi-pass captures per frame in `OverheadShadowsEffectV2.render()`. This is more likely to cause large frame drops than a single leak bug and would need targeted pass-gating/caching work to reduce safely.
