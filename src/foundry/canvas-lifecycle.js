/**
 * @fileoverview foundry/canvas-lifecycle.js — THE BLANK-CANVAS WATCHDOG
 * (audit, 2026-07-17: "activate/view teardown" investigation; reworked
 * 2026-10-25, loading audit finding P-02).
 *
 * canvasInit/canvasReady are BOTH skipped entirely when Foundry draws a BLANK
 * canvas — verified in source (client/canvas/board.mjs's `#draw`): `Scene
 * #unview()` and the active scene being deleted both call `canvas.draw(null)`,
 * which returns via `#drawBlank()` **before** either hook fires. `canvasTearDown`
 * is the only hook that DOES fire for that transition (`tearDown()` runs
 * whenever the canvas `wasReady`, before the null-scene check) — but it ALSO
 * fires for an ordinary floor switch and every real scene change (same
 * `#draw()` call, same `tearDown()` step), so it cannot by itself decide to
 * dispose anything without knowing which kind of teardown it is.
 *
 * ============================================================================
 * THE SIGNAL IS IN THE HOOK (2026-10-25)
 * ============================================================================
 * Foundry passes `{nextScene, nextLevel}` as the hook's second argument
 * (`board.mjs:1125` builds it, `:1346` fires `Hooks.callAll("canvasTearDown",
 * this, options)`), and `#draw` goes blank exactly when `nextLevel` is falsy
 * (`board.mjs:1139`). So "is a draw coming?" is answered SYNCHRONOUSLY, with no
 * timer: `decideTeardownKind(options)`.
 *
 * The previous version inferred it from ABSENCE: it waited two animation frames
 * for a `canvasInit` and stopped the viewer if none came, on the stated premise
 * that nothing between the two hooks was network-bound. That premise is false
 * in v14. Every group's `tearDown` runs between them, and the visibility
 * group's awaits `canvas.fog.clear()` → `FogManager#save()` — a GPU read-back
 * plus a server write whenever exploration is unsaved
 * (`client/canvas/groups/visibility.mjs:452-475`, `perception/fog.mjs:380-392,
 * 822-864`), which is the ordinary state of a player who has just moved. A
 * save slower than two frames orphaned a perfectly healthy viewer on an
 * ordinary level change, and the rebuild that followed ran with no curtain
 * (the scene id had not changed) — grid over nothing, for as long as a cold
 * start takes.
 *
 * The timer survives only as the fallback for a hook call that carries no
 * options at all (nothing in v14 does that), and even then it refuses to
 * conclude anything while Foundry itself says a draw is in progress
 * (`canvas.loading`, true from `board.mjs:1107` until the draw ends).
 *
 * Lives here, not in boot.js, because registering a raw `Hooks.on(...)` call
 * outside `src/foundry/` is exactly what `foundry/adapter-only`'s ratchet
 * exists to catch (tools/verify-structure.mjs) — this file is the one place
 * that wall allows it. Everything ELSE (deciding what "orphaned" means, what
 * to do about it) is injected from boot.js, the composition root, same as
 * `scene/mask-authority.js`'s two seams.
 *
 * @module foundry/canvas-lifecycle
 */

/**
 * What kind of teardown is this? Pure — Node-testable without `Hooks`.
 *
 * - `'blank'`   — Foundry is drawing NO scene (`nextLevel` falsy): no
 *   `canvasInit` will follow, so anything MSA is running is now orphaned.
 * - `'redraw'`  — a scene or level change: `canvasInit` WILL follow, however
 *   long the teardown takes. Never stop anything.
 * - `'unknown'` — the hook carried no usable options; fall back to inference.
 *
 * @param {{nextScene?: object|null, nextLevel?: object|null}|null|undefined} options -
 *   the `canvasTearDown` hook's second argument.
 * @returns {'blank'|'redraw'|'unknown'}
 */
export function decideTeardownKind(options) {
  if (!options || typeof options !== 'object' || !('nextLevel' in options)) return 'unknown';
  return options.nextLevel ? 'redraw' : 'blank';
}

/**
 * THE PURE DECISION CORE for the FALLBACK path. Given the generation a
 * watchdog captured when `canvasTearDown` fired, the highest generation any
 * `canvasInit` has since covered, and whether there is anything left to clean
 * up, decide whether this teardown was ORPHANED (nothing followed it — the
 * canvas went blank).
 *
 * Pulled out as its own function specifically so it is Node-testable without
 * a real `Hooks`/`requestAnimationFrame` — the actual wiring below is
 * browser-only and verified live (same split as canvas-compositing.js's
 * `decideArtSuppression` vs `registerCanvasCompositing`).
 *
 * @param {number} tearDownGen - the generation this watchdog captured.
 * @param {number} coveredGen - the highest generation any canvasInit has stamped.
 * @param {boolean} viewerActive - is there anything to actually clean up?
 * @returns {boolean}
 */
export function isOrphanedTeardown(tearDownGen, coveredGen, viewerActive) {
  if (coveredGen >= tearDownGen) return false; // a real draw already covered this teardown
  return !!viewerActive;
}

/**
 * Is Foundry in the middle of a draw right now? `canvas.loading` is set true at
 * the top of `#draw` and false at its end (or on a failed texture/group draw).
 * A teardown that is still being followed by a draw in progress is not
 * orphaned, however slow it is.
 * @returns {boolean}
 */
function foundryIsDrawing() {
  return globalThis.canvas?.loading === true;
}

/**
 * Register the watchdog. Call once, at module load (same timing constraint as
 * `registerCanvasCompositing` — `Hooks.on` must exist by the time Foundry
 * starts drawing).
 *
 * @param {object} deps
 * @param {() => boolean} deps.isViewerActive - true if there's a live MSA
 *   viewer that would otherwise be orphaned.
 * @param {() => void} deps.onOrphaned - called when a teardown is confirmed
 *   orphaned. Expected to stop the viewer and lift any stuck loading curtain
 *   — this module knows neither concept, only that "nothing followed."
 * @param {(msg: string) => void} [deps.logInfo] - optional, for an audit trail.
 * @param {(kind: 'redraw'|'blank'|'unknown') => void} [deps.onTearDown] - optional; told of every teardown
 *   (the floor-change timeline, `diag/floor-timeline.js`).
 * @returns {{registered: boolean, reason: string|null, markCovered: () => void}}
 *   `markCovered` MUST be called from your own `canvasInit` handler — it is
 *   what tells the FALLBACK path "a real draw followed, this was not a blank
 *   transition." Returned rather than registering a second `canvasInit` hook
 *   here: boot.js already has one (for the loading curtain), and calling a
 *   plain function from inside it adds no new `Hooks.on` match for the wall
 *   to count.
 */
export function registerCanvasTearDownWatchdog({ isViewerActive, onOrphaned, logInfo, onTearDown } = {}) {
  if (typeof Hooks === 'undefined') {
    return {
      registered: false,
      reason: 'no Foundry Hooks global — not running inside Foundry',
      markCovered: () => {},
    };
  }

  let tearDownGeneration = 0;
  let coveredGeneration = -1;

  Hooks.on('canvasTearDown', (_canvas, options) => {
    const gen = ++tearDownGeneration;
    const kind = decideTeardownKind(options);
    try {
      onTearDown?.(kind);
    } catch (err) {
      logInfo?.(`the teardown observer threw (ignored): ${err?.message ?? err}`);
    }

    if (kind === 'redraw') return; // a canvasInit follows; nothing to decide

    if (kind === 'blank') {
      if (!(isViewerActive?.() ?? false)) return;
      logInfo?.('canvas went blank (scene unviewed or deleted) — stopping the orphaned viewer.');
      onOrphaned?.();
      return;
    }

    // 'unknown' — the old inference, now refusing to conclude while Foundry is mid-draw.
    const check = (framesLeft) =>
      requestAnimationFrame(() => {
        if (framesLeft > 0) return check(framesLeft - 1);
        if (foundryIsDrawing()) return check(0); // still drawing: look again next frame
        if (!isOrphanedTeardown(gen, coveredGeneration, isViewerActive?.() ?? false)) return;
        logInfo?.('canvas went blank (no canvasInit followed the teardown) — stopping the orphaned viewer.');
        onOrphaned?.();
      });
    check(1);
  });

  return {
    registered: true,
    reason: null,
    markCovered: () => {
      coveredGeneration = tearDownGeneration;
    },
  };
}
