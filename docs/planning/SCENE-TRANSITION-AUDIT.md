# Scene Transition Audit — Blank Scene → MSA Scene Failure

**Reported bug:** Transitioning from a blank/non-MSA scene to an MSA-enabled scene
results in the loading screen appearing but nothing ever rendering. Works after
a full Foundry reload.

---

## Scene Transition Lifecycle Overview

Every scene switch goes through this pipeline (relevant hooks/wrappers only):

```
Canvas.tearDown()  [wrapped by installCanvasTransitionWrapper]
  → _tearDownWrapper: showLoading / fadeToBlack(2s) / calls original tearDown
  → Foundry fires: canvasTearDown hook
      → onCanvasTearDown(): destroyThreeCanvas()
  → _tearDownWrapper returns

Canvas.draw(newScene)  [wrapped by installCanvasDrawWrapper]
  → Foundry fires: canvasConfig hook  → sets config.backgroundAlpha=0 if MSA-enabled
  → Foundry fires: canvasInit hook
  → Foundry fires: canvasReady hook
      → onCanvasReady(canvas)
          → IF MSA-enabled:  createThreeCanvas(scene)
          → IF not MSA:      UI-only mode (uiManager, controlPanel init, overlay dismiss)
```

---

## The Non-MSA → MSA Transition Path (Bug Scenario)

### State entering the transition

When the user was sitting on the blank (non-MSA) scene:
- `onCanvasReady` fired → `sceneSettings.isEnabled(scene)` = false
- UI-only mode ran: `uiManager`, `controlPanel`, `cinematicCameraManager`, `graphicsSettings` created
- **`createThreeCanvas` was NEVER called** — no Three canvas, no PIXI suppression
- **`window.MapShine.renderer` still exists** (from initial bootstrap, never used for a canvas)
- `_createThreeCanvasRunning` = false

### What happens during tearDown

`onCanvasTearDown` → `destroyThreeCanvas()`:
- Disposes `uiManager`, `controlPanel` etc. ✓
- `modeManager` is null → calls `restoreFoundryRendering()` (no-op since layers were never hidden)
- **CRITICAL: Disposes `window.MapShine.renderer` and sets it to null** even though it was never
  used for a Three canvas in this scene.

### What happens during draw (the broken part)

`onCanvasReady` → `createThreeCanvas(scene)`:

1. **Line ~3431:** `destroyThreeCanvas()` called again (redundant cleanup at start of createThreeCanvas).
   - Everything already null. `restoreFoundryRendering()` fires again.
2. **Line ~3460:** Renderer is `null` → **lazy bootstrap triggered**.
   - `await import('../core/bootstrap.js')` + `mod.bootstrap({ verbose: false, skipSceneInit: true })`
   - If bootstrap fails (even silently), `bootstrapOk` is null/false.
3. **Line ~3470:** `if (!bootstrapOk) return;` — **EARLY RETURN, no overlay dismissal!**
   OR if bootstrap succeeds but `window.MapShine.renderer` is still null:
4. **Line ~3474:** `if (!mapShine.renderer) { log.error(...); return; }` — **EARLY RETURN, no overlay dismissal!**

---

## Confirmed Bugs Found

### BUG-1 (PRIMARY SUSPECT): Early returns in `createThreeCanvas` leave the loading overlay stuck

There are multiple bare `return;` statements early in `createThreeCanvas` (lines ~3455, 3470,
3474, 3471, 3512) that exit BEFORE the main `try/catch` block. The `catch` block dismisses
the overlay on error. The `finally` block only resets `_createThreeCanvasRunning`. **Neither
the catch nor the finally dismisses the overlay for early returns.**

Affected early-exit paths:
```javascript
if (!THREE) { return; }                        // line ~3455 — no overlay dismiss
if (!bootstrapOk) return;                      // line ~3470 — no overlay dismiss
if (!mapShine.renderer) { return; }            // line ~3474 — no overlay dismiss  
if (session.isStale()) return;                 // line ~3471 — no overlay dismiss
if (canvasOk === false) return;                // line ~3512 — no overlay dismiss (inside try but bare return)
```

The 5-minute watchdog timer will eventually dismiss the overlay, but users won't wait that long.

### BUG-2: `destroyThreeCanvas()` destroys the renderer even when no Three canvas was active

`destroyThreeCanvas()` is called from `onCanvasTearDown` for EVERY scene transition including
non-MSA → MSA. It always disposes `window.MapShine.renderer` if it exists. This forces the
lazy bootstrap path on every MSA scene load after any scene transition.

The lazy bootstrap is a recovery path, not an intended fast path. If it fails for any reason
(e.g. WebGL context creation throttling after `forceContextLoss()`), the scene silently aborts.

### BUG-3: `destroyThreeCanvas()` called twice per MSA scene load

Sequence: `onCanvasTearDown` → `destroyThreeCanvas()` → then `createThreeCanvas()` → `destroyThreeCanvas()` again.

The second call (inside `createThreeCanvas`) always calls `restoreFoundryRendering()` because
`modeManager` is null. This restores PIXI layers to visible mid-initialization, which is
then corrected later but creates a brief incorrect state.

### BUG-4: `forceContextLoss()` on a renderer that was bootstrapped but never used

When `destroyThreeCanvas()` calls `globalRenderer.forceContextLoss()` on the bootstrap renderer
(which was created but never attached to a canvas during a non-MSA scene), the WebGL context is
forcibly killed. The subsequent lazy bootstrap must create a fresh WebGL context. On some
browsers/drivers, creating a new context immediately after a forced loss can fail or return a
degraded context.

### BUG-5 (LATENT): `onCanvasTearDown` safety timer condition checks stale `canvas` reference

```javascript
_overlayDismissSafetyTimerId = setTimeout(() => {
    if (!canvas?.scene && !canvas?.loading) { /* dismiss overlay */ }
}, 10000);
```

The `canvas` variable here is the parameter from `onCanvasTearDown(canvas)`. By the time the
timer fires (10s later), `canvas` is the OLD canvas object, not the current one. If a new MSA
scene is actively loading, `canvas.loading` on the old object may not reflect this.

---

## Investigation Steps (TODO)

### Phase 1: Confirm the bug path (diagnostics)
- [ ] **P1-01**: Add a `console.warn` to every early `return;` in `createThreeCanvas` that includes the step name and "loading overlay NOT dismissed"
- [ ] **P1-02**: Add a `console.warn` to the finally block noting whether overlay was dismissed
- [ ] **P1-03**: Reproduce the blank→MSA transition and check which early return fires
- [ ] **P1-04**: Check browser console for "lazy bootstrap" warning to confirm BUG-2 is triggering

### Phase 2: Fix early-return overlay leak (BUG-1) — HIGH PRIORITY
- [ ] **P2-01**: Wrap all early returns in `createThreeCanvas` (before the main try block) in a
  helper that dismisses the overlay before returning:
  ```javascript
  const _earlyReturn = (reason) => {
    log.warn(`createThreeCanvas aborting early: ${reason}`);
    safeCall(() => loadingOverlay.fadeIn(500).catch(() => {}), 'overlay.earlyReturn', Severity.COSMETIC);
  };
  ```
- [ ] **P2-02**: Handle `session.isStale()` returns separately (no overlay dismiss, just abort cleanly)
- [ ] **P2-03**: Ensure `canvasOk === false` return also dismisses overlay

### Phase 3: Fix renderer lifecycle (BUG-2 + BUG-4) — HIGH PRIORITY

**Option A: Guard renderer disposal in `destroyThreeCanvas`**
Only dispose the renderer if a Three canvas was actually active for this session. Track this
with a new `let _threeCanvasWasActive = false;` flag, set to true when the canvas is attached
at line ~3682, reset in `destroyThreeCanvas`.

```javascript
// In destroyThreeCanvas():
if (window.MapShine?.renderer && _threeCanvasWasActive) {
    globalRenderer.forceContextLoss();
    globalRenderer.dispose();
    window.MapShine.renderer = null;
}
_threeCanvasWasActive = false;
```

**Option B: Move renderer disposal out of `destroyThreeCanvas` into a separate `tearDownRenderer` call**
Only called when going from MSA→anything, not from non-MSA→anything.

- [ ] **P3-01**: Add `_threeCanvasWasActive` flag (set on Three canvas attach, cleared on destroy)
- [ ] **P3-02**: Gate `forceContextLoss()` + `dispose()` on `_threeCanvasWasActive`
- [ ] **P3-03**: Test MSA→blank, blank→MSA, MSA→MSA, blank→blank transitions

### Phase 4: Eliminate double `destroyThreeCanvas()` call (BUG-3)
- [ ] **P4-01**: Remove the redundant `destroyThreeCanvas()` call at the start of `createThreeCanvas`
  (line ~3431). The teardown hook already ran it.
- [ ] **P4-02**: If cleanup is still needed, only null out specific local module vars, don't
  re-run the full destroy path.

### Phase 5: Fix safety timer stale `canvas` reference (BUG-5)
- [ ] **P5-01**: In the safety timer, use `globalThis.canvas` instead of the closed-over parameter:
  ```javascript
  _overlayDismissSafetyTimerId = setTimeout(() => {
    if (!globalThis.canvas?.scene && !globalThis.canvas?.loading) { /* dismiss */ }
  }, 10000);
  ```

### Phase 6: General scene transition hardening
- [ ] **P6-01**: Audit `onCanvasReady` UI-only mode path — ensure overlay is always dismissed
  even if `uiManager.initialize()` or `controlPanel.initialize()` throws
- [ ] **P6-02**: Verify `canvasConfig` hook correctly applies `backgroundAlpha=0` to the live
  PIXI renderer in Foundry v13/PIXI v8 (not just the config object)
- [ ] **P6-03**: Add an explicit `canvas.app.renderer.background.alpha = 0` call in `onCanvasReady`
  immediately upon entering the MSA-enabled path (belt+suspenders before `createThreeCanvas`)
- [ ] **P6-04**: Check if `#drawBlank()` + MSA scene draw can cause two `canvasReady` calls or
  skip hooks in edge cases
- [ ] **P6-05**: Consider moving `restoreFoundryRendering()` out of `destroyThreeCanvas()` so
  it only runs when there's actually a Three canvas to restore from

---

## Priority Fix Order

1. **BUG-1 (P2)**: Early return overlay leak — most likely direct cause of "loading screen
   stuck forever" symptom. Simple to fix.
2. **BUG-2 + BUG-4 (P3)**: Renderer always destroyed on teardown regardless of whether a
   Three canvas was active. When coming from a non-MSA scene, forcing context loss on the
   bootstrap renderer then immediately recreating it is unnecessary risk.
3. **BUG-3 (P4)**: Double `destroyThreeCanvas()` — causes `restoreFoundryRendering()` to run
   mid-init, briefly showing PIXI layers during MSA init.
4. **BUG-5 (P5)**: Stale `canvas` reference in safety timer — low risk but easy to fix.

---

## Files Involved

- `scripts/foundry/canvas-replacement.js` — primary file, all bugs are here
  - `createThreeCanvas()` — BUG-1, BUG-3 (second destroyThreeCanvas call)
  - `destroyThreeCanvas()` — BUG-2, BUG-4 (renderer always disposed)
  - `onCanvasTearDown()` — BUG-5 (safety timer stale canvas)
  - `installCanvasTransitionWrapper()` — `_tearDownWrapper` (overlay show/fade)
- `scripts/core/load-session.js` — session staleness (clean, no issues found)
- `scripts/core/bootstrap.js` — lazy bootstrap target (needs audit for failure modes)

---

## Testing Matrix

| Transition        | Expected                    | Currently broken? |
|-------------------|-----------------------------|-------------------|
| blank → MSA       | MSA scene loads and renders | YES (reported)     |
| MSA → blank       | Blank scene, overlay dismissed | Unknown          |
| MSA → MSA         | MSA scene loads and renders | Likely working    |
| blank → blank     | Overlay dismissed           | Unknown           |
| reload → MSA      | MSA scene loads and renders | Working (user confirmed) |
| null scene → MSA  | MSA scene loads and renders | Unknown           |
