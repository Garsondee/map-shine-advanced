# Pan/Zoom + Render-Cycle Sync Audit (No Fixes)

Date: 2026-03-17  
Scope: End-to-end audit of camera pan/zoom pathways and frame scheduling behavior in MapShine V2 runtime.

---

## 1) Executive Summary

Current runtime has **multiple camera update systems with different timing models**:

1. **Foundry animated pan path** (`canvas.animatePan`) running on PIXI ticker.
2. **Direct camera writes** (`canvas.pan` and raw `canvas.stage.*` writes).
3. **MapShine Three render path** (`RenderLoop` + `EffectComposer`) on its own rAF.
4. **Optional smoothing loops** in both `PixiInputBridge` and `CinematicCameraManager`.

This architecture can be smooth, but only when one system is dominant at a time. Hitching appears when:
- different loops update/consume camera state at different phases,
- expensive per-frame work spikes frame time during camera movement,
- and shader program variants are still being generated while zoom changes view-dependent paths.

---

## 2) Pan/Zoom Entry Points (Complete Map)

### A. Intro zoom cinematic
- Uses direct `canvas.pan` in custom rAF loop with cosine easing: `@scripts/foundry/intro-zoom-effect.js#495-559`
- Starts/stops render-loop cinematic mode: `@scripts/foundry/intro-zoom-effect.js#516-520`, `@scripts/foundry/intro-zoom-effect.js#557-558`

### B. User mouse pan/zoom on Three canvas
- Input bridge writes **directly** to `canvas.stage.pivot/scale/position` (not `canvas.pan`): `@scripts/foundry/pixi-input-bridge.js#372-382`
- Pan drag path: `@scripts/foundry/pixi-input-bridge.js#560-568`
- Wheel zoom path: `@scripts/foundry/pixi-input-bridge.js#603-656`
- Optional input smoothing rAF loop: `@scripts/foundry/pixi-input-bridge.js#387-461`

### C. Cinematic camera manager
- Focus helpers still use Foundry `animatePan`: `@scripts/foundry/cinematic-camera-manager.js#753-787`
- Remote follow interpolation applies `canvas.pan(..., duration:0)`: `@scripts/foundry/cinematic-camera-manager.js#892-933`
- Group cohesion applies `canvas.pan(..., duration:0)` every update: `@scripts/foundry/cinematic-camera-manager.js#1127-1187`
- Constraint enforcement can trigger additional corrective `canvas.pan`: `@scripts/foundry/cinematic-camera-manager.js#444-470`

### D. Other non-cinematic camera jumps
- Tweakpane/map-point jumps call `canvas.pan`: `@scripts/ui/tweakpane-manager.js#5411-5431`, `@scripts/ui/tweakpane-manager.js#5907`
- Map point interactions call `canvas.pan`: `@scripts/scene/map-point-interaction.js#693-697`

### E. Foundry native behavior for reference
- `canvas.pan` does constraints + hook dispatch + HUD align + invalidations: `@foundryvttsourcecode/resources/app/client/canvas/board.mjs#1463-1496`
- `canvas.animatePan` is PIXI-ticker `CanvasAnimation.animate(... ontick => this.pan(position))`: `@foundryvttsourcecode/resources/app/client/canvas/board.mjs#1515-1537`
- CanvasAnimation ticker callback registered on PIXI ticker (priority default LOW+1): `@foundryvttsourcecode/resources/app/client/canvas/animation/canvas-animation.mjs#98-151`

---

## 3) Frame Scheduling Topology

## 3.1 Active loops

1. **PIXI ticker loop** (Foundry)
   - Drives `CanvasAnimation` (`animatePan`) and many Foundry subsystems.

2. **MapShine RenderLoop rAF**
   - Schedules its own `requestAnimationFrame`: `@scripts/core/render-loop.js#223-230`
   - Reads PIXI stage pivot/scale to detect camera change: `@scripts/core/render-loop.js#271-295`
   - Runs `EffectComposer.render(...)`: `@scripts/core/render-loop.js#364`

3. **Input smoothing rAF** (`PixiInputBridge`)
   - Separate rAF that can mutate stage continuously: `@scripts/foundry/pixi-input-bridge.js#387-461`

4. **Cinematic self-update fallback rAF** (`CinematicCameraManager`)
   - Separate rAF fallback when external update loop stalls: `@scripts/foundry/cinematic-camera-manager.js#403-435`

## 3.2 V2-mode frame coordinator status

- FrameCoordinator exists but is explicitly disabled in V2 runtime path: `@scripts/foundry/canvas-replacement.js#4524-4532`
- Therefore there is no single authoritative “post-PIXI then render Three” coordinator in V2 today.

---

## 4) Why Motion Can Still Hitch

### Finding 1: Mixed timing domains still coexist
Even after intro moved to rAF+`canvas.pan`, other camera paths (focus/group helpers) still use `canvas.animatePan` (PIXI ticker) while render consumption is in MapShine rAF.

This means smoothness varies by which path is active.

### Finding 2: Direct stage writes bypass Foundry pan side-effects
`PixiInputBridge` writes stage directly (`pivot/scale/position`) and bypasses:
- `Hooks.callAll("canvasPan")`
- `scene._viewPosition` updates
- `updateBlur`, hidden/effects invalidation, emulateMoveEvent

(Those are part of Foundry `canvas.pan`: `@foundryvttsourcecode/resources/app/client/canvas/board.mjs#1478-1496`.)

MapShine compensates partially (e.g. HUD align in camera follower: `@scripts/foundry/camera-follower.js#757-763`), but this creates divergent behavior between user-input camera changes and Foundry-native camera changes.

### Finding 3: Multiple camera modifiers can apply in same frame window
During non-suspended runtime, camera can be modified by:
- user input smoothing,
- cinematic constraints (`_enforcePanBounds`),
- remote-follow interpolation,
- group cohesion.

These are guarded, but they still represent multiple writers with different triggers and cadence.

### Finding 4: RenderLoop adaptive pacing can still hide subframe movement
RenderLoop uses adaptive FPS gates (`idle/active/continuous`) and pre-check min-interval fast path: `@scripts/core/render-loop.js#318-355`.

Cinematic mode bypasses this (`@scripts/core/render-loop.js#314-317`, `@scripts/core/render-loop.js#335-347`), but only where explicitly enabled.

### Finding 5: Heavy per-frame work during movement competes for frame budget
`EffectComposer.render` runs all updatables before compositor render: `@scripts/effects/EffectComposer.js#607-643`.

Camera follower is one updatable among many and is added after several managers in startup sequence: `@scripts/foundry/canvas-replacement.js#3995-4320`.

Any expensive updatable frame can stretch frame time and cause visible stutter regardless of camera interpolation quality.

### Finding 6: Shader “done” is not equivalent to “all future variants created”
Program readiness gating relies on current `renderer.info.programs` readiness snapshot. But program *count* can still increase later as new branches/material states become active due to pan/zoom/vision state changes.

Evidence of vision/perception-triggered churn:
- Fog effect repeatedly forces perception updates in hooks/retry paths: `@scripts/compositor-v2/effects/FogOfWarEffectV2.js#1232-1257`, `@scripts/compositor-v2/effects/FogOfWarEffectV2.js#2039-2051`, `@scripts/compositor-v2/effects/FogOfWarEffectV2.js#2341`

This aligns with user-observed “select token early and it smooths out” behavior (selection/perception paths pre-activate rendering variants).

---

## 5) Render-Cycle Alignment: What Helps in General

These are architecture-level recommendations only (no code changes in this audit).

### Priority A — Single timing domain for camera writes
Prefer one authoritative writer during motion sequences:
- either all camera animation via RenderLoop-aligned rAF,
- or all via PIXI ticker with Three render explicitly chained post-PIXI.

Avoid mixed writer models during the same user-visible motion.

### Priority B — Single writer policy (state machine)
Define camera “ownership modes” (e.g. local-input, intro-cinematic, remote-follow, cohesion) and enforce exactly one active writer at a time, with explicit handoff.

### Priority C — Unify camera side-effects contract
If bypassing `canvas.pan`, replicate required side-effects in one shared camera-apply utility, or ensure all systems consume only stage state and do not rely on Foundry hook side-effects.

### Priority D — Tie expensive systems to motion phases
During active pan/zoom, temporarily:
- reduce/decimate non-critical updatables,
- defer expensive perception retries where safe,
- prioritize camera + compositor path.

### Priority E — Warm “interactive variants,” not just base shaders
Warmup should include representative camera states and vision states used during immediate post-load interaction (token-selected vs unselected, floor transitions, zoom extremes) so program variants are materialized before cinematic reveal.

### Priority F — Instrument frame provenance
Collect per-frame tags: camera-writer source, render-loop mode (idle/active/continuous/cinematic), updatable cost breakdown, program-count deltas.

Without this, hitching remains hard to localize when multiple systems can be active.

---

## 6) Risk Matrix (Current)

- **High risk**: program variants created after “ready” gate due to late vision/perception/material paths.
- **High risk**: mixed timing domains across different camera pathways.
- **Medium risk**: direct stage writes bypassing Foundry pan contract.
- **Medium risk**: stacked camera modifiers in advanced cinematic mode.
- **Medium risk**: adaptive pacing outside explicitly cinematic windows.

---

## 7) Suggested Next Investigation (Still No Fixes)

1. Capture a single hitching session with per-frame telemetry:
   - camera writer source,
   - updatable timings,
   - `renderer.info.programs.length` over time,
   - RenderLoop mode transitions.
2. Reproduce in four isolated scenarios:
   - intro zoom only,
   - user wheel-zoom only,
   - remote-follow only,
   - cohesion only.
3. Compare “token selected early” vs “no early token selection” program growth curves.

This will distinguish whether remaining hitching is primarily **scheduling desync** or **late workload bursts**.
