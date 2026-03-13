---
title: Firefox Performance Profile Investigation & Optimization Plan
author: Cascade
date: 2026-03-13
status: proposed
---

# Firefox Performance Profile Investigation & Optimization Plan

## 1) Scope
This document captures confirmed findings from the Firefox performance profile (`performance/Firefox 2026-03-13 12.44 profile.json(1)`), maps them to concrete runtime hotspots in Map Shine Advanced, and proposes a prioritized remediation plan.

Primary goal: reduce frame-time spikes and input latency in Foundry VTT scenes using Map Shine Advanced V2 rendering.

---

## 2) Confirmed Findings

### A. Main-thread render pressure is the primary bottleneck
Firefox markers show repeated long-frame violations, including:

- `LongTask`: **313.65ms**
- `RefreshDriverTick`: **313.64ms**
- `RefreshObserver`: **227.91ms**
- Additional `RefreshDriverTick` spikes in the ~22-58ms range

This confirms severe frame-budget overruns and visible jank under normal interaction.

### B. Input latency is a direct consequence of render saturation
Pointer/mouse/wheel event lag is expected: long `RefreshDriverTick` windows indicate the main thread is unavailable for timely input handling while rendering work is in-flight.

### C. Large GPU texture uploads are a dominant hotspot
Resolved sampled stacks show a concentrated hot path:

- `WebGL2RenderingContext.texSubImage2D`
- `uploadTexture` / `setTexture2D`
- `FloorCompositor._compositePixiWorldOverlay`

This indicates expensive per-frame (or near per-frame) CPU→GPU texture uploads from the PIXI bridge world channel into the compositor chain.

### D. 2D replay clear/draw cost is a secondary CPU contributor
Stacks also show `CanvasRenderingContext2D.clearRect` under:

- `PixiContentLayerBridge._renderReplayCapture`

This is not the top bottleneck versus texture upload, but it does add recurring CPU cost, especially at large capture dimensions.

### E. Polling contributes background wakeups/micro-stutter
A recurring 200ms environment sync interval is present and confirmed.

---

## 3) Code Evidence (Confirmed Hotspots)

### 3.1 Cloud blocker mask traversal (high CPU)
- `scripts/compositor-v2/effects/CloudEffectV2.js`
- `_renderBlockerMask(renderer)` traverses the full bus scene each frame, toggles object visibility, renders blocker RT, then restores visibility.
- This pattern is expensive in dense scenes and is a likely top contributor.

### 3.2 Late overlay world render pass
- `scripts/compositor-v2/FloorCompositor.js`
- `_renderLateWorldOverlay()` triggers a dedicated render call for overlay layer content.

### 3.2b PIXI world composite upload hotspot (highest confidence)
- `scripts/compositor-v2/FloorCompositor.js`
- `_compositePixiWorldOverlay(inputRT)` binds the bridge world canvas texture and renders a fullscreen composite.
- Profile stacks tie this path directly to `texSubImage2D` upload cost (`setTexture2D` → `uploadTexture` → WebGL upload).

### 3.2c Bridge replay path does full-canvas clear + redraw
- `scripts/foundry/pixi-content-layer-bridge.js`
- `_renderReplayCapture(...)` clears and redraws the world capture canvas, then sets `worldTexture.needsUpdate = true`.
- This drives texture re-upload on the compositor pass.

### 3.2d Live-preview throttle gap in replay-only mode
- `scripts/foundry/pixi-content-layer-bridge.js`
- In `update(frameId)`, `live-throttled` path only applies when `captureStrategy !== 'replay-only'`.
- Default strategy is `replay-only`, so rapid interaction can still trigger frequent large uploads.

### 3.3 Fog overlay composite pass
- `scripts/compositor-v2/FloorCompositor.js`
- `_compositeFogOverlayToRT(inputRT, outputRT)` performs an RT blit plus additional fog render.

### 3.4 Distortion below-floor presence pass
- `scripts/compositor-v2/effects/DistortionManager.js`
- `_renderBelowFloorPresence(renderer, scene)` performs a dedicated render pass for layer 24.

### 3.5 200ms environment polling interval
- `scripts/ui/control-panel-manager.js`
- `_startEnvironmentSync()` uses `setInterval(..., 200)` for sun latitude synchronization.

---

## 4) Root-Cause Summary

1. **Large texture upload pressure** from PIXI bridge world-channel updates composed in `_compositePixiWorldOverlay`.
2. **Replay capture overhead** (`clearRect` + redraw + `needsUpdate`) at large world dimensions.
3. **Pass count inflation** in the V2 frame graph (multiple RT passes + overlays + effect sub-passes).
4. **Main-thread scheduling contention** from regular polling and extension scripts.
5. **Secondary GC noise** from repeated per-frame work and temporary state churn.

---

## 5) Prioritized Remediation Plan

## P0 (Highest Priority): Reduce PIXI bridge upload frequency/size

### Objective
Stop frequent large `texSubImage2D` uploads from the PIXI world bridge during live interaction.

### Plan
1. In `PixiContentLayerBridge.update`, apply live throttling to replay-only strategy as well (not just extract strategies).
2. Add stricter gating so `worldTexture.needsUpdate` is only set when replay output materially changes.
3. Introduce a safe lower default capture scale for large scenes (adaptive by world dimensions/device budget).
4. Keep debug/override flags to force high-quality capture when needed.

### Expected Impact
Largest immediate reduction in jank and long-frame spikes by lowering upload byte volume and upload cadence.

---

## P1: Remove per-frame full-scene blocker traversal

### Objective
Replace `_renderBlockerMask` visibility-mutation traversal with layer-based culling.

### Plan
1. Introduce a dedicated cloud blocker render layer constant in `scripts/core/render-layers.js` (if not already suitable via existing layer slots).
2. Assign overhead/cloud-blocking sprites to that layer at creation/update time in the render bus/tile wiring path.
3. In `CloudEffectV2._renderBlockerMask`, switch camera to blocker layer and render directly (no full-scene visibility toggles).
4. Keep a compatibility fallback path behind a debug flag until validated.

### Expected Impact
Large CPU reduction in dense scenes and meaningful frame-time stabilization.

---

## P2: Reduce pass duplication in FloorCompositor pipeline

### Objective
Minimize full-screen and full-scene passes in `FloorCompositor.render`.

### Plan
1. Audit which passes can be merged or skipped when disabled/invisible.
2. Gate late overlay and fog composite passes behind strict cheap preconditions.
3. Evaluate whether fog and/or lens can share prior RT state to avoid extra blits.
4. Add per-pass timings to quickly identify top N contributors during runtime.

### Expected Impact
Lower average frame time and fewer long-tail spikes.

---

## P3: Replace fixed polling with event-driven synchronization

### Objective
Eliminate unnecessary 200ms wakeups from control panel environment sync.

### Plan
1. Replace `setInterval` in `_startEnvironmentSync()` with event/subscription updates from the authoritative state source.
2. If polling remains necessary, backoff aggressively (e.g., inactive panel or unchanged state).

### Expected Impact
Lower baseline main-thread noise and improved input smoothness under load.

---

## P4: Instrumentation & regression guardrails

### Objective
Make performance regressions visible and repeatable.

### Plan
1. Add optional per-pass profiler counters (CPU ms/frame) in V2 render stages.
2. Emit periodic summary logs in debug mode (mean, p95, max frame stage costs).
3. Add a reproducible benchmark scene protocol in `tests/playwright` for before/after capture.

### Expected Impact
Faster root-cause isolation and safer iteration.

---

## 6) Non-Code Mitigations (User/Runtime)

These are valid operational mitigations and should remain documented:

1. Disable heavy browser extensions on Foundry URL (especially password managers and aggressive content scripts).
2. Cap Foundry framerate to 30 when scene complexity exceeds hardware budget.
3. Tune high-cost effect controls (cloud/fog/water/distortion) for large scenes.

---

## 7) Validation Checklist

- [ ] Capture baseline profile in the same scene/state.
- [ ] Implement P0 and capture post-change profile.
- [ ] Confirm lower `texSubImage2D` sample share and reduced long-task frequency.
- [ ] Implement P1 and confirm reduced time in cloud blocker path.
- [ ] Verify no regression in overhead tile cloud-shadow blocking behavior.
- [ ] Implement P2/P3 incrementally and compare p50/p95 frame times.
- [ ] Confirm pointer latency reduction under active pan/zoom/token drag.

---

## 8) Success Criteria

1. **p95 frame time** materially reduced in stress scenes.
2. **Pointer event latency** no longer frequently spikes above one 60 FPS frame budget.
3. Render quality parity preserved for cloud blockers, fog overlay, and layer ordering.
4. No functional regressions in levels/floor visibility semantics.
