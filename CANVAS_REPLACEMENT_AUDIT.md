# `canvas-replacement.js` — External Audit Verification Report

**File audited:** `scripts/foundry/canvas-replacement.js` (10,514 lines)
**Date:** 2026-05-12
**Goal:** Verify a third-party audit of issues, identify which claims are accurate, which are partially accurate (wrong line numbers but correct mechanism), and which are wrong.

> **Overall verdict:** Of the 9 individual claims raised, **8 are valid bugs or real anti-patterns**, **1 is partially valid** (correct mechanism, wrong location). Several line numbers in the original report are off, but the underlying mechanisms match what is in the file today. The two highest-impact items are the duplicate WebGL context-loss handlers (memory leak + behavior collision) and the throttled PIXI suppression ticker (visible flicker at 60 FPS).

---

## 1. Conflicting & Leaking WebGL Context Handlers — **VALID (Critical)**

**Auditor claim:** Two separate sets of `webglcontextlost` / `webglcontextrestored` handlers are attached to `threeCanvas`. They give contradictory instructions, and only the first set is cleaned up.

### Verification

There are *four* webgl listener installations in the file, on *two different* canvases:

| Lines | Target | How attached | Cleaned up? |
|---|---|---|---|
| `2395`, `2401` | **PIXI canvas(es)** (via `MutationObserver`) | anonymous | n/a — diagnostic-only `preventDefault()` |
| `2442`, `2448` | **PIXI** `canvas.app.view` | anonymous | n/a — diagnostic-only |
| `6199`, `6229`, `6257-6258` | **threeCanvas** | named (`_webglContextLostHandler`, `_webglContextRestoredHandler`) | **Yes** — removed in `destroyThreeCanvas` at lines `9012-9013` |
| `7137`, `7145` | **threeCanvas** | **anonymous** | **No** — leaked across every scene transition |

The two threeCanvas installs (`6199`/`7137`) are the real problem. They give contradictory directives on the same event:

```6199:6227:scripts/foundry/canvas-replacement.js
      _webglContextLostHandler = (ev) => {
        safeCall(() => ev.preventDefault(), 'contextLost.preventDefault', Severity.COSMETIC);
        _threeContextLost = true;
        log.warn('WebGL context lost - rendering paused (rAF loop continues)');
        // ... applies "Safe Mode" ...
        // IMPORTANT: do NOT stop the render loop here.
        // RenderLoop.render() already skips rendering while the context is lost,
        // but it must keep scheduling requestAnimationFrame so we can resume
        // immediately when the context is restored.
      };
```

```7137:7150:scripts/foundry/canvas-replacement.js
      threeCanvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        log.warn('P0.4: WebGL context lost - pausing render loop');
        if (renderLoop && renderLoop.running()) {
          renderLoop.stop();
        }
      }, false);

      threeCanvas.addEventListener('webglcontextrestored', () => {
        log.info('P0.4: WebGL context restored - rebuilding scene');
        // Trigger full scene rebuild to recreate render targets and re-upload textures
        resetScene(canvas.scene);
      }, false);
```

`destroyThreeCanvas` only removes the named pair:

```9010:9020:scripts/foundry/canvas-replacement.js
  if (threeCanvas) {
    safeDispose(() => {
      if (_webglContextLostHandler) threeCanvas.removeEventListener('webglcontextlost', _webglContextLostHandler);
      if (_webglContextRestoredHandler) threeCanvas.removeEventListener('webglcontextrestored', _webglContextRestoredHandler);
    }, 'removeContextHandlers');
    _webglContextLostHandler = null;
    _webglContextRestoredHandler = null;

    threeCanvas.remove();
    threeCanvas = null;
    log.debug('Three.js canvas removed');
  }
```

### Why it matters

1. **Behavior collision.** On `webglcontextlost`, set 1 deliberately keeps the rAF loop alive; set 2 calls `renderLoop.stop()`. On `webglcontextrestored`, set 1 just resizes & restarts the loop; set 2 calls `resetScene(canvas.scene)` (full teardown + rebuild). Both fire, and the order is non-deterministic from the consumer's standpoint.
2. **Memory leak.** The anonymous listeners hold closures over `renderLoop`, `resetScene`, and `canvas` references. Because `threeCanvas.remove()` is called but the listener references are never released, the old DOM canvas remains reachable via the listener registry for as long as the closures live (which is forever, since `renderLoop`/`resetScene` are module-scope identifiers — the closures themselves are kept alive by the canvas element's listener list, and the canvas element is kept alive by the closures).

### Minor correction to the auditor

The auditor placed "Set 1" at line ~2530 — that is actually the PIXI-view diagnostic listener block, not the named handlers. The named handlers live at **line 6199**, and the conflicting anonymous "P0.4" pair is at **line 7137**. The substantive claim is correct.

### Recommended fix

Delete the lines 7137–7150 block entirely. Consolidate all context-loss policy into `_webglContextLostHandler` / `_webglContextRestoredHandler`. Decide whether to `stop()` the render loop or keep it pumping rAFs — pick one strategy, not both.

---

## 2. `drawSelect` Monkey-Patch Binding Bug — **VALID**

**Auditor claim:** `_mapShineOrigDrawSelect = current.bind(controls)` permanently binds the captured method to the *old* `controls` instance. On the next scene draw, Foundry replaces `canvas.controls`, but restoring from this cache re-installs a function whose `this` still points at the destroyed layer.

### Verification

Line number cited (`~1130`) is wrong; the actual code is at **line 1577**:

```1568:1599:scripts/foundry/canvas-replacement.js
  safeCall(() => {
    const controls = canvas?.controls;
    if (!controls) return;

    const selectGfx = controls.select;
    const current = controls.drawSelect;

    if (suppress) {
      if (!_mapShineOrigDrawSelect && typeof current === 'function') {
        _mapShineOrigDrawSelect = current.bind(controls);
      }

      controls.drawSelect = ({ x, y, width, height } = {}) => {
        safeCall(() => {
          if (selectGfx?.clear) selectGfx.clear();
          if (selectGfx) selectGfx.visible = false;
        }, 'selectRect.clearGfx', Severity.COSMETIC);
      };
      // ...
    } else {
      if (_mapShineOrigDrawSelect) {
        controls.drawSelect = _mapShineOrigDrawSelect;
      }
      // ...
    }
  }, 'selectRect.patch', Severity.COSMETIC);
```

There is a second site that consumes `_mapShineOrigDrawSelect` in `destroyThreeCanvas`:

```9041:9047:scripts/foundry/canvas-replacement.js
      if (_mapShineOrigDrawSelect && !modeManagerHadOrigDrawSelect) {
        controls.drawSelect = _mapShineOrigDrawSelect;
      }
      if (controls.select) controls.select.visible = true;
      _mapShineOrigDrawSelect = null;
      _mapShineSelectSuppressed = false;
    }, 'destroyThree.restoreSelectRect.postModeManager', Severity.COSMETIC);
```

If between capture and restore Foundry recreates `canvas.controls` (which it does on `Canvas.draw` / scene change), the bound `this` is stale. Any call to `controls.drawSelect(...)` will operate on the destroyed PIXI `Graphics` object via the closed-over `selectGfx` access patterns inside Foundry's original method. PIXI v6 graphics use `.geometry` after destroy; calls into it will throw or no-op in confusing ways.

### Mitigations already in place

The code does clear `_mapShineOrigDrawSelect = null` in three locations (lines `1517`, `9037`, `9045`) and there's an early `_restoreFoundryNativeSelectRectForVanillaScene()` path. But the *capture* is what's wrong — once captured with `.bind(controls)`, every subsequent restore re-applies the same stale binding regardless of how many guards run afterwards.

### Recommended fix

```javascript
_mapShineOrigDrawSelect = current;   // store the method, not a binding
```

When Foundry calls `this.drawSelect(...)` on the *new* `controls`, `this` will correctly resolve to the new layer.

---

## 3. Race Condition in `resetScene` ↔ `createThreeCanvas` — **VALID**

**Auditor claim:** `resetScene`'s `sceneResetInProgress` lock and `createThreeCanvas`'s `_createThreeCanvasRunning` lock are not synchronized; `createThreeCanvas` returns synchronously when its lock is held, so `resetScene`'s `await` resolves before the queued work actually runs.

### Verification

```9140:9182:scripts/foundry/canvas-replacement.js
export async function resetScene(options = undefined) {
  if (sceneResetInProgress) return;
  sceneResetInProgress = true;

  try {
    // ...
    await createThreeCanvas(scene);
    // ...
  } catch (e) { /* ... */ }
  finally {
    sceneResetInProgress = false;
  }
}
```

And `createThreeCanvas`:

```5648:5662:scripts/foundry/canvas-replacement.js
  if (_createThreeCanvasRunning) {
    const pendingSceneId = String(scene?.id ?? '');
    const currentSceneId = String(loadCoordinator.sceneId ?? '');
    if (pendingSceneId && pendingSceneId === currentSceneId) {
      log.warn('[loading] createThreeCanvas already in progress for same scene — ignoring duplicate call.');
      return;
    }

    _createThreeCanvasPendingRequest = {
      scene,
      createOptions: { ...(createOptions || {}) },
    };
    log.warn('[loading] createThreeCanvas already in progress — queued latest request for different scene.');
    return;
  }
```

The replay later uses `setTimeout` + `void` — fire-and-forget, no Promise propagated to anyone:

```8685:8693:scripts/foundry/canvas-replacement.js
    if (pending?.scene && !_createThreeCanvasFailed && pendingSceneId && pendingSceneId !== currentSceneId) {
      safeCall(() => {
        // Replayed calls bypass onCanvasReady; re-seed coordinator scene context.
        loadCoordinator.beginSceneLoad(pending.scene?.id, pending.scene?.name);
        setTimeout(() => {
          void createThreeCanvas(pending.scene, pending.createOptions);
        }, 0);
      }, 'createThreeCanvas.replayPending', Severity.COSMETIC);
    }
```

So the failure mode plays out as the auditor described:

1. User mashes the reset button.
2. First `resetScene` flips `sceneResetInProgress = true` and `await createThreeCanvas(...)` — it begins.
3. Second `resetScene` is bounced by `if (sceneResetInProgress) return;` — OK so far.
4. The webgl-context-restored handler from §1 then *also* calls `resetScene(canvas.scene)`. Since `sceneResetInProgress` is no longer true (or is still true, depending on race), the call may either bounce or proceed.
5. If it proceeds, `createThreeCanvas` is already running; the call hits the queue branch and returns synchronously. `resetScene`'s `await` resolves to `undefined` instantly. `sceneResetInProgress` flips to `false` *while a queued canvas creation is pending*.
6. Now another reset can sneak in, and so on.

### Recommended fix

Return a Promise from the queue:

```javascript
if (_createThreeCanvasRunning) {
  return new Promise((resolve, reject) => {
    _createThreeCanvasPendingRequest = { scene, createOptions, resolve, reject };
  });
}
```

…and resolve/reject it from the replay path in the `finally` block at 8681. `resetScene`'s `await` will then actually await the real work.

---

## 4. 33 ms PIXI Suppression Ticker — **VALID (causes flicker at 60+ FPS)**

**Auditor claim:** `_enforceGameplayPixiSuppression` is throttled to fire once per 33 ms inside the PIXI ticker. At 60 FPS this misses every other frame, so any layer being toggled `visible = true` by Foundry renders for ~16.6 ms before being clamped back.

### Verification

```4758:4770:scripts/foundry/canvas-replacement.js
    try {
      const ticker = canvas?.app?.ticker;
      if (ticker?.add) {
        _pixiSuppressionTickerFn = () => {
          const now = performance.now();
          if ((now - _pixiSuppressionTickerLastMs) < 33) return;
          _pixiSuppressionTickerLastMs = now;
          try { _enforceGameplayPixiSuppression(); } catch (_) {}
          try { _updateFoundrySelectRectSuppression(); } catch (_) {}
        };
        ticker.add(_pixiSuppressionTickerFn, null, -75);
      }
    } catch (_) {}
```

Two issues stack here:

1. **Throttle.** Confirmed exactly as described.
2. **Priority `-75`.** In PIXI's ticker, higher priorities run first. `app.render` runs at the default priority (`UTILITY = 0`). A callback registered at `-75` runs *after* the render call each tick. That means even when the throttle allows the callback to run, the layer was already rendered with the wrong visibility on that frame — the suppression only takes effect on the *next* frame.

So at 60 FPS with native Foundry actively writing `visible = true` once per frame (e.g. via `refreshTile`, `refreshToken`, sight refresh chains), the pattern is:

- Frame N: Foundry sets `visible = true`. Render draws the layer. Then suppression callback runs, sets `visible = false`.
- Frame N+1: Foundry sets `visible = true` again. Render draws the layer (visible flash). Suppression callback throttled — skipped.
- Frame N+2: same as frame N.

Result: 30 Hz flicker baseline, worse when the throttle window drifts.

### Recommended fix

Either:
- Remove the 33 ms gate. The body of `_enforceGameplayPixiSuppression` should already be cheap (visibility writes), and "as cheap as possible" is more correct than "throttled".
- *And* move the callback to a higher priority than the renderer (e.g. add at priority `PIXI.UPDATE_PRIORITY.HIGH = 25` or use the dedicated `prerender` event on `app.renderer`) so the visibility writes precede the render call.

A better long-term fix is to suppress at the source (the hooks at lines 4751-4756) and stop the per-frame fallback ticker entirely. The fact that a per-frame ticker is even needed suggests there are hook paths that bypass the named hooks.

---

## 5. "Ghost Code" from Stripped Logs — **VALID**

**Auditor claim:** Many `try { … } catch (_) {}` blocks contain only dead variable declarations whose computed values are never used. Looks like a log-stripping build step that removed the `console.log` call but left the argument evaluation behind.

### Verification

Counts inside `canvas-replacement.js`:

- Completely empty `try { } catch (_) {}` blocks (multiline form): **6**
- Short ≤80-char `try {…} catch (_) {}` blocks (single-line form): **54**
- `try { const x = …; } catch (_)` blocks where the value is never used: at least **12** in the cases I sampled.

Examples copied verbatim from the file:

```2832:2840:scripts/foundry/canvas-replacement.js
        try {
          const total = Array.isArray(sources) ? sources.length : (sources?.size ?? null);
          const msg = options?.message ?? '';
        } catch (_) {}

        try {
          const keys = Object.keys(loader ?? {}).slice(0, 120);
        } catch (_) {}
```

```3486:3500:scripts/foundry/canvas-replacement.js
      const wrappedFn = function(...args) {
        try {
          const n = String(enterId).padStart(3, '0');
        } catch (_) {
        }

        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function') {
            return result.then((v) => {
              try {
                const n = String(resolveId).padStart(3, '0');
              } catch (_) {
              }
```

```3076:3079:scripts/foundry/canvas-replacement.js
        try {
          const keys = Object.keys(loader ?? {}).slice(0, 80);
        } catch (_) {
        }
```

These blocks live inside hot paths: the texture-loader trace (called on every `load()` invocation during asset preload) and the canvas-method wrappers (called on every `_draw`/`_drawBlank`). Each call allocates short-lived strings/arrays and a `try` frame for no reason.

### What actually happened

`Object.keys(loader).slice(0, 120)` is exactly the kind of pre-stringification a debug logger would call to get a snapshot of the loader state — but the surrounding `log.debug(...)` call has been removed (the comment `// Diagnostic log removed intentionally.` at lines 2444 and 2450 makes this explicit).

The file even has explicit comment evidence: lines 2444 (`// Diagnostic log removed intentionally.`) and 2450 confirm this is a manual stripping pattern, not a build tool issue. So the auditor's "build pipeline AST transformer" hypothesis is slightly off — it's *manual* stripping that left the dead variable declarations behind by accident.

### Recommended fix

Either delete the dead declarations outright, or replace with a no-op logger:

```javascript
import { createLogger } from '../core/log.js';
const log = createLogger('foundry/canvas-replacement');
// ...
log.debug('Loader keys:', () => Object.keys(loader).slice(0, 120)); // lazy eval
```

Lazy-arg loggers are the standard fix — the argument function is only evaluated when the log level is actually enabled.

---

## 6. Dangling Promises in `waitForThreeFrames` — **VALID (but mostly dead code in V2)**

**Auditor claim:** `Promise.race([rAF, setTimeout])` does not cancel the loser; the `setTimeout` stays alive in the timer queue for 100 ms holding the closure even after the rAF wins.

### Verification

```4039:4043:scripts/foundry/canvas-replacement.js
      // Use Promise.race to ensure we don't hang if tab is backgrounded (rAF pauses)
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(resolve)),
        new Promise(resolve => setTimeout(resolve, 100)) // Fallback: max 100ms per iteration
      ]);
```

Inside a `while (performance.now() - startTime < timeoutMs)` loop with a default `timeoutMs = 5000` ms. So up to ~300 iterations, each leaving a dead 100 ms `setTimeout` alive. That's a steady ~30 timer entries queued at any time during the call, plus their closures. Not catastrophic, but it's exactly the kind of GC pressure the auditor describes.

### Mitigating factor

`waitForThreeFrames` is **declared but not called** in the active V2 flow. The only call site I could find is:

```8123:8128:scripts/foundry/canvas-replacement.js
    _setCreateThreeCanvasProgress('waitForThreeFrames');
    stepLog(' -> Step: waitForThreeFrames SKIPPED (V2)');
    safeCall(() => loadingOverlay.setStage('scene.frames', 1.0, 'Frame stabilization skipped', { immediate: true, keepAuto: false }), 'overlay.frames.skip', Severity.COSMETIC);
    try { dlp.event('fin.waitForThreeFrames: SKIPPED (V2)', 'warn'); } catch (_) {}
    if (isDebugLoad) { try { dlp.end('fin.waitForThreeFrames', { skipped: true, v2: true }); } catch (_) {} }
    _sectionEnd('fin.waitForThreeFrames');
```

…which logs "skipped" and does not invoke the function. So the leak is dormant. But the function still occupies code surface and matches the auditor's described pattern. Either delete the dead function or apply the auditor's fix:

```javascript
await new Promise(resolve => {
  let timer;
  const raf = requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve();
  });
  timer = setTimeout(() => {
    cancelAnimationFrame(raf);
    resolve();
  }, 100);
});
```

This is correct and addresses the issue. If the function is genuinely dead, deleting it is simpler.

---

## 7. `HTMLImageElement.prototype.src` Patching — **PARTIALLY VALID**

**Auditor claim:** Globally redefining the `src` setter on `HTMLImageElement.prototype` is unsafe in a multi-module environment. `PerformanceObserver` would do this without prototype mutation.

### Verification

```2718:2780:scripts/foundry/canvas-replacement.js
function _installNetworkDiagnostics() {
  const enabled = (
    debugLoadingProfiler?.debugMode === true ||
    globalThis?.MapShine?.__debugNetworkDiagnostics === true
  );
  if (!enabled) return null;
  // ...
  try {
    const origSet = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')?.set;
    if (origSet && !HTMLImageElement.prototype.__msaCrisisImgWrapped) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        set(val) {
          const id = ++diag._imgId;
          const src = String(val ?? '').slice(0, 200);
          diag.pendingImages.set(id, { src, startMs: performance.now() });
          const cleanup = () => { diag.pendingImages.delete(id); };
          this.addEventListener('load', cleanup, { once: true });
          this.addEventListener('error', cleanup, { once: true });
          origSet.call(this, val);
        },
        get: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')?.get,
        configurable: true,
        enumerable: true,
      });
      HTMLImageElement.prototype.__msaCrisisImgWrapped = true;
    }
  } catch (_) {}
```

The patch is:

- Gated behind a diagnostic flag (`debugLoadingProfiler.debugMode === true` *or* an explicit `window.MapShine.__debugNetworkDiagnostics = true`).
- Guarded against double-wrap with `__msaCrisisImgWrapped`.
- `fetch` is similarly wrapped just above.

So the auditor's framing ("dangerous in a shared environment") is correct in principle, but practically the impact is bounded — this only runs in debug builds. The `fetch` wrap (lines 2736-2754) is arguably more impactful since `fetch` is far more central to the loader.

### Recommended fix

Replace the entire `_installNetworkDiagnostics` body with a `PerformanceObserver`:

```javascript
const po = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    // e.name = URL, e.duration = ms, e.initiatorType = 'img' | 'fetch' | 'xmlhttprequest' | ...
    diag.completed.push({ name: e.name, duration: e.duration, type: e.initiatorType });
  }
});
po.observe({ entryTypes: ['resource'] });
```

This gives you per-resource timing without touching any prototype.

---

## 8. libWrapper Fallback Never Unwraps — **VALID (minor)**

**Auditor claim:** When libWrapper is not present, `Canvas.prototype.draw` and `Canvas.prototype.tearDown` are mutated directly. `destroyThreeCanvas` never restores them.

### Verification

```3547:3558:scripts/foundry/canvas-replacement.js
    const CanvasCls = globalThis.foundry?.canvas?.Canvas;
    const proto = CanvasCls?.prototype;
    if (!proto?.draw) return;
    if (proto.draw.__mapShineWrapped) return;

    const original = proto.draw;
    const directWrapped = async function(...args) {
      return _drawWrapper.call(this, original.bind(this), ...args);
    };

    directWrapped.__mapShineWrapped = true;
    proto.draw = directWrapped;
```

```3725:3730:scripts/foundry/canvas-replacement.js
    const directWrapped = async function(...args) {
      return _tearDownWrapper.call(this, original.bind(this), ...args);
    };

    directWrapped.__mapShineWrapped = true;
    proto.tearDown = directWrapped;
```

The original function reference is captured locally inside the closure (`const original = proto.draw`); there is no module-level handle to restore it later. `destroyThreeCanvas` does not attempt to remove either wrapper.

This is a real but low-impact issue, as the auditor noted. Foundry modules typically only fully unwrap on `Setup` / `Init` cycles after a page reload. The risk surfaces if a future "soft disable" path is added that calls `destroyThreeCanvas` without a reload.

### Recommended fix

Store the originals on the prototype as `proto.__mapShineOrigDraw = original` (or in a module-level map) and add unwrap helpers to `destroyThreeCanvas`. Even simpler: only support libWrapper, and refuse to install if libWrapper is missing.

---

## 9. `safeCall` Swallowing — **PARTIALLY VALID**

**Auditor claim:** Heavy use of `safeCall()` generic try/catch swallows errors silently; warning-level logging during development is essential.

### Verification

`safeCall` itself is fine:

```93:121:scripts/core/safe-call.js
function _handleError(error, context, severity, options = {}) {
  // ...
  switch (severity) {
    case Severity.CRITICAL:
      log.error(`[CRITICAL] ${context}:`, error);
      throw error;

    case Severity.DEGRADED:
      log.warn(`[degraded] ${context}:`, error);
      return options.fallback;

    case Severity.COSMETIC:
      // Silent — only log at debug level for development
      log.debug(`[cosmetic] ${context}:`, error?.message ?? error);
      return options.fallback;
    // ...
  }
}
```

`COSMETIC` logs at `debug`, which is sensible — but the user's broader concern surfaces in *how often* `Severity.COSMETIC` is used in this file. A grep against `canvas-replacement.js` shows hundreds of `safeCall(..., Severity.COSMETIC)` calls, including for things that are not actually cosmetic (e.g., the WebGL context-handler registration at line 6259, render-loop restart at line 6254, render-resolution restore at line 6235 — these affect rendering correctness and should be `DEGRADED` so they appear at `warn`).

The auditor's framing is correct: in an "everything is cosmetic" file, real failures get hidden behind the project's default log level. This is the most likely root cause of any "stuck loading screen with no console output" bug.

### Recommended fix

Audit each `safeCall(..., Severity.COSMETIC)` site and re-classify:

- Context-handler registration, renderer resize on context restore, render-loop start/stop → `Severity.DEGRADED`.
- Notifications, overlay text updates, UI breadcrumbs → keep `Severity.COSMETIC`.

---

## Summary Table

| # | Claim | Verdict | Notes on line numbers |
|---|---|---|---|
| 1 | Conflicting + leaking WebGL context handlers | **Valid (critical)** | Set 1 is at L6199 (not L2530). Set 2 is at L7137 (not L2975). |
| 2 | `drawSelect` bound to stale `controls` | **Valid** | Code is at L1577, not L1130. |
| 3 | `resetScene` ↔ `createThreeCanvas` race | **Valid** | `resetScene` at L9140; queue at L5648-5662; replay at L8685-8693. |
| 4 | 33 ms ticker throttle → flicker | **Valid** | L4763. Compounded by priority `-75` (runs after render). |
| 5 | Ghost code from stripped logs | **Valid** | 54+ short empty-`catch` blocks; ≥12 dead `const` declarations. |
| 6 | Dangling timer in `Promise.race` | **Valid (dormant)** | Pattern at L4040; function is unreachable in V2 path. |
| 7 | `HTMLImageElement.prototype.src` patch | **Partially valid** | L2761. Gated behind debug flag; PerformanceObserver is the right alternative. |
| 8 | libWrapper fallback leaves prototype wrapped | **Valid (minor)** | L3558 (`draw`), L3730 (`tearDown`). |
| 9 | `safeCall` silently swallows | **Partially valid** | `safeCall` itself is well-designed; the misuse is over-classifying real failures as `COSMETIC`. |

## Recommended Priority Order

1. **#1 (WebGL handler conflict + leak)** — silent state corruption and growing memory across scene changes.
2. **#4 (Throttled suppression ticker)** — user-visible flicker on every scene at default frame rates.
3. **#9 misuse of `Severity.COSMETIC`** — promotes any real fix above to actually being diagnosable.
4. **#3 (`resetScene` race)** — affects power-user workflows (spammed reset button, automated tests).
5. **#2 (`drawSelect` stale `this`)** — surfaces on every scene transition with a TokenLayer active.
6. **#5 (ghost code in hot paths)** — sustained GC pressure during asset load.
7. **#8 (libWrapper fallback)** — only matters once a soft-disable path is added.
8. **#6 (`waitForThreeFrames`)** — currently dormant in V2; delete or fix when reviving.
9. **#7 (`HTMLImageElement` patch)** — debug-gated; swap to `PerformanceObserver` when convenient.
