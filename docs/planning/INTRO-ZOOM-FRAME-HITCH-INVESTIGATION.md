# Intro Zoom Frame-Hitch Investigation

**Date:** 2026-03-16  
**Symptom:** Visible framerate hitching / stuttering during the intro zoom camera animation.

---

## 1. Architecture of the Current Approach

### Two Independent rAF Chains

There are two completely separate `requestAnimationFrame` loops running simultaneously:

| Loop | Owner | Drives |
|---|---|---|
| PIXI ticker (`canvas.app.ticker`) | Foundry | Stage transforms, token movement, `canvas.animatePan` |
| `RenderLoop` (MapShine) | `scripts/core/render-loop.js` | Three.js rendering via `EffectComposer.render()` |

These two rAF loops are **not synchronized**. The browser can schedule them in any order within a single display cycle.

### How `canvas.animatePan()` Works

`canvas.animatePan()` calls `CanvasAnimation.animate()` which registers a tick callback on the **PIXI ticker** at `PIXI.UPDATE_PRIORITY.LOW + 1` (≈ priority 0).

Each PIXI tick, the callback fires `ontick: () => this.pan(position)` which updates `canvas.stage.pivot.x/y` and `canvas.stage.scale.x`.

### How `RenderLoop` Detects Camera Motion

`RenderLoop.render()` samples `canvas.stage.pivot.x/y` and `canvas.stage.scale.x` every rAF call and compares to the previous frame snapshot:

```js
// scripts/core/render-loop.js:256-275
cameraChanged = (
  pixiPivotX !== this._lastPixiPivotX ||
  pixiPivotY !== this._lastPixiPivotY ||
  pixiZoom   !== this._lastPixiZoom
);
```

If changed → render at `activeFps` target (60fps by default).  
If not changed → idle at `idleFps` (15fps) unless `effectWantsContinuous` or `_continuousRenderUntilMs`.

### FrameCoordinator Position in Tick Order

`FrameCoordinator` hooks into PIXI ticker at priority `-50` (runs last, after everything including `CanvasAnimation`). It is NOT in the rAF chain that drives Three.js rendering. MapShine's `RenderLoop` is still fully separate.

---

## 2. Root Causes of Hitching

### Cause A — Phase Mismatch Between PIXI Ticker and MapShine rAF

**This is the primary cause.**

```
Display cycle N:
  - MapShine rAF fires FIRST
    → reads pivot = pos_n-1 (stale, PIXI hasn't ticked yet)
    → cameraChanged = false (same as last render!)
    → Three.js renders OLD camera position
  - PIXI ticker fires AFTER
    → advances pivot to pos_n
    → canvas.stage.pivot.x updated

Display cycle N+1:
  - MapShine rAF fires
    → reads pivot = pos_n (now sees the change from last cycle)
    → renders pos_n but it's one display cycle late
```

**Result:** Every other frame Three.js renders the camera 1 display cycle behind PIXI. This causes the characteristic 30fps-feeling stutter even when both loops nominally run at 60fps.

This ordering is non-deterministic — it depends on browser scheduler. On some frames the ordering reverses and things look smooth. The inconsistency is the hitch.

**Key files:**
- `scripts/core/render-loop.js:251-262` (PIXI pivot snapshot)
- `foundryvttsourcecode/resources/app/client/canvas/animation/canvas-animation.mjs:120-150` (PIXI ticker animation)
- `foundryvttsourcecode/resources/app/client/canvas/board.mjs:1515-1536` (`animatePan` drives pan from ticker ontick)

---

### Cause B — Continuous Render Not Armed During Zoom

`IntroZoomEffect._animateCameraZoom()` calls `canvas.animatePan()` and awaits it, but **never calls `renderLoop.requestContinuousRender(zoomDurationMs)`**.

By the time the intro zoom starts, the compile-gate polling loop has ended. Its `requestContinuousRender(100)` calls have all expired. The render loop is in default "active" mode — it renders when camera changes, but still subject to the `activeFps` cap (default 60fps) and `minIntervalMs` throttle.

If the RenderLoop fires in rapid succession (e.g. effects want continuous render at 30fps), the camera change detected 1 frame late means an effective 30fps camera update rate.

**Key files:**
- `scripts/foundry/intro-zoom-effect.js:505-516` (`_animateCameraZoom` — no continuous render call)
- `scripts/core/render-loop.js:127-141` (`requestContinuousRender`)
- `scripts/core/render-loop.js:297-328` (adaptive FPS throttle logic)

---

### Cause C — activeFps Cap May Be Too Low

`RenderLoop` defaults to `_activeFps = 60`. But on high-refresh displays (144Hz), or when PIXI ticks faster than 60fps, the active FPS cap means Three.js skips intermediate camera positions. Even at 60fps, if a PIXI tick fires at 6ms and the next MapShine rAF fires at 16ms, the camera at 6ms and 10ms are both missed.

**Key file:** `scripts/core/render-loop.js:27-28`

---

### Cause D — `_waitForSmoothRendering` Uses Its Own Independent rAF

`IntroZoomEffect._waitForSmoothRendering()` measures frame pacing by timing `requestAnimationFrame` callbacks. This does not measure the MapShine RenderLoop's actual render rate (which is throttled by the adaptive FPS system). The stability it reports reflects browser rAF scheduling, not actual Three.js frame delivery.

A scene can pass `_waitForSmoothRendering` while MapShine is still at 15fps idle.

**Key file:** `scripts/foundry/intro-zoom-effect.js:556-574`

---

### Cause E — CSS White Overlay Transition Is on Browser Compositor Thread

The white overlay opacity transition runs entirely on the browser's GPU compositor thread. It has no synchronization with WebGL frame delivery. If WebGL is under load (e.g. first few frames after shader gate opens), the overlay fade can visually advance while the scene frame lags, creating temporal misalignment at the reveal moment.

**Key file:** `scripts/foundry/intro-zoom-effect.js:480-527` (`_setWhiteOverlayOpacity`)

---

## 3. Candidate Fixes (Ranked by Impact / Effort)

### Fix 1 — Quick: Arm Continuous Render for Full Zoom Duration *(Low effort, partial fix)*

In `_animateCameraZoom`, call `requestContinuousRender` for the animation duration before starting the pan:

```js
async _animateCameraZoom(x, y, scale, durationMs) {
  // Arm the render loop to stay in continuous mode for the zoom duration.
  try {
    window.MapShine?.renderLoop?.requestContinuousRender?.(durationMs + 1000);
  } catch (_) {}
  // ... existing canvas.animatePan call
}
```

**Impact:** Removes throttle-induced drops. Does NOT fix phase-mismatch stutter.  
**Risk:** Low.

---

### Fix 2 — Better: Replace `canvas.animatePan` with rAF-Driven `canvas.pan`

Replace `canvas.animatePan()` with a custom animation loop that drives `canvas.pan()` from inside MapShine's `requestAnimationFrame`. This ensures the camera is updated **on the same frame** Three.js reads it, eliminating phase mismatch.

```js
async _animateCameraZoom(x, y, scale, durationMs) {
  // Arm continuous render
  window.MapShine?.renderLoop?.requestContinuousRender?.(durationMs + 1000);

  const startX     = canvas.stage.pivot.x;
  const startY     = canvas.stage.pivot.y;
  const startScale = canvas.stage.scale.x;
  const startMs    = performance.now();
  const endMs      = startMs + durationMs;

  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      const t   = Math.min(1, (now - startMs) / durationMs);
      const te  = this._easeInOutCosine(t); // same easing Foundry uses

      const cx = startX + (x - startX) * te;
      const cy = startY + (y - startY) * te;
      const cs = startScale + (scale - startScale) * te;

      try { canvas.pan({ x: cx, y: cy, scale: cs }); } catch (_) {}

      if (t < 1 && now < endMs) {
        requestAnimationFrame(tick);
      } else {
        try { canvas.pan({ x, y, scale }); } catch (_) {}
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}
```

**Impact:** Eliminates phase-mismatch stutter entirely. Camera update is now co-located with the rAF that drives Three render.  
**Risk:** Medium. We bypass Foundry's CanvasAnimation system (which can be terminated externally). Need to guard for `_active` flag abort.

---

### Fix 3 — Best: Drive Animation via `RenderLoop` Updatable Registration *(Larger effort, cleanest)*

Register a per-frame updatable in `EffectComposer` for the duration of the intro zoom that:
1. Calls `canvas.pan()` each time `EffectComposer.render()` runs (before Three renders)
2. Is auto-removed when the animation completes

This would guarantee sub-frame alignment because `canvas.pan()` is called in the same callstack as `renderer.render()`.

**Requires:** A lightweight "one-shot updatable" registration path in `EffectComposer`.  
**Impact:** Architectural fix. Camera pan and Three render are deterministically aligned.  
**Risk:** Medium-high (touches EffectComposer).

---

### Fix 4 — Diagnostic: Add RenderLoop `cinematicMode` Flag *(Low effort, targeted)*

Add a `startCinematicMode(durationMs)` / `stopCinematicMode()` API to `RenderLoop` that:
- Forces `_activeFps = 60` for the duration
- Sets `_continuousRenderUntilMs` to `now + durationMs`
- Bypasses `minIntervalMs` cap so every rAF call renders

```js
// RenderLoop
startCinematicMode(durationMs) {
  this._cinematicModeUntilMs = performance.now() + durationMs;
  this._forceNextRender = true;
}
```

Then in `RenderLoop.render()`, when `_cinematicModeUntilMs` is active, skip ALL throttle checks.

**Impact:** Ensures full-rate rendering during cinematic. Does not fix phase mismatch but makes it less visible.  
**Risk:** Low.

---

## 4. Recommended Sequence

1. **Immediate (Fix 1 + Fix 4):** Arm continuous render + add `cinematicMode` to RenderLoop.  
   Fast, low-risk, removes most throttle-induced hitching.

2. **Follow-up (Fix 2):** Replace `canvas.animatePan` with rAF-driven `canvas.pan` custom loop.  
   Eliminates phase-mismatch stutter at root.

3. **Long-term (Fix 3):** If Fix 2 still shows edge cases, migrate to registered updatable approach.

---

## 5. Verification Plan

1. Enable browser DevTools → Performance tab → record a full intro zoom.
2. Look at: frame rendering timeline, rAF spacing, any long tasks > 16ms.
3. Compare `canvas.stage.pivot.x` motion vs Three.js render timestamps (add temp timing instrumentation to `RenderLoop.render()` during camera animation).
4. After Fix 2: confirm camera never reads a stale pivot (pivot should always change between Two.js renders during animation).

---

## 6. Files to Modify

| File | Change |
|---|---|
| `scripts/foundry/intro-zoom-effect.js` | Fix 1: add `requestContinuousRender`; Fix 2: custom rAF animation |
| `scripts/core/render-loop.js` | Fix 4: add `startCinematicMode`/`stopCinematicMode` |
| `scripts/foundry/canvas-replacement.js` | Call `renderLoop.startCinematicMode(zoomDurationMs)` before intro zoom |
