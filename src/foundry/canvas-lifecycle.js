/**
 * @fileoverview foundry/canvas-lifecycle.js — THE BLANK-CANVAS WATCHDOG
 * (audit, 2026-07-17: "activate/view teardown" investigation).
 *
 * canvasInit/canvasReady are BOTH skipped entirely when Foundry draws a BLANK
 * canvas — verified in source (client/canvas/board.mjs's `#draw`): `Scene
 * #unview()` and the active scene being deleted both call `canvas.draw(null)`,
 * which returns via `#drawBlank()` **before** either hook fires. `canvasTearDown`
 * is the only hook that DOES fire for that transition (`tearDown()` runs
 * whenever the canvas `wasReady`, before the null-scene check) — but it ALSO
 * fires for an ordinary floor switch and every real scene change (same
 * `#draw()` call, same `tearDown()` step), so it cannot by itself decide to
 * dispose anything: doing so unconditionally would defeat boot.js's cheap
 * same-scene floor-switch path (`setVtPanViewerFloor`) and reintroduce the
 * exact repeated-full-reallocation crash that path exists to prevent.
 *
 * The distinguishing signal is ABSENCE, not presence: every non-blank
 * continuation of `#draw()` re-fires `canvasInit` synchronously afterward —
 * `tearDown()`'s own remaining work between the `canvasTearDown` hook and
 * `canvasInit` is local PIXI/JS teardown only (terminate animations,
 * deactivate layers, tear down groups), never network I/O; the network-bound
 * texture loading happens AFTER `canvasInit`, not before it. So waiting two
 * real animation frames — a generous margin over that local work, and the
 * same "did a real frame actually happen" idiom boot.js already uses for
 * lifting the loading curtain — is enough to tell "nothing followed" from
 * "still working," without racing a legitimately slow scene load.
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
 * THE PURE DECISION CORE. Given the generation a watchdog captured when
 * `canvasTearDown` fired, the highest generation any `canvasInit` has since
 * covered, and whether there is anything left to clean up, decide whether
 * this teardown was ORPHANED (nothing followed it — the canvas went blank).
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
 * @returns {{registered: boolean, reason: string|null, markCovered: () => void}}
 *   `markCovered` MUST be called from your own `canvasInit` handler — it is
 *   what tells this watchdog "a real draw followed, this was not a blank
 *   transition." Returned rather than registering a second `canvasInit` hook
 *   here: boot.js already has one (for the loading curtain), and calling a
 *   plain function from inside it adds no new `Hooks.on` match for the wall
 *   to count.
 */
export function registerCanvasTearDownWatchdog({ isViewerActive, onOrphaned, logInfo } = {}) {
  if (typeof Hooks === 'undefined') {
    return {
      registered: false,
      reason: 'no Foundry Hooks global — not running inside Foundry',
      markCovered: () => {},
    };
  }

  let tearDownGeneration = 0;
  let coveredGeneration = -1;

  Hooks.on('canvasTearDown', () => {
    const gen = ++tearDownGeneration;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!isOrphanedTeardown(gen, coveredGeneration, isViewerActive?.() ?? false)) return;
        logInfo?.('canvas went blank (scene unviewed or deleted) — stopping the orphaned viewer.');
        onOrphaned?.();
      })
    );
  });

  return {
    registered: true,
    reason: null,
    markCovered: () => {
      coveredGeneration = tearDownGeneration;
    },
  };
}
