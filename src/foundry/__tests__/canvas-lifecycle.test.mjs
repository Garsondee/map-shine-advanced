/**
 * Node verification for foundry/canvas-lifecycle.js's pure part
 * (isOrphanedTeardown). registerCanvasTearDownWatchdog itself touches
 * Hooks/requestAnimationFrame (browser-only) -- verified live via the
 * blank-canvas transition instead, per this codebase's own convention (same
 * split as canvas-compositing.js's decideArtSuppression vs
 * registerCanvasCompositing).
 */
import { isOrphanedTeardown } from '../canvas-lifecycle.js';

export function run(t) {
  const { ok } = t;

  // --- the happy paths: a real draw always follows ------------------------
  ok(
    'a floor switch (canvasInit stamps the SAME generation) is never orphaned',
    isOrphanedTeardown(1, 1, true) === false
  );
  ok(
    'a genuine scene change (canvasInit stamps a LATER generation) is never orphaned',
    isOrphanedTeardown(1, 2, true) === false
  );
  ok('covered and nothing to clean up either way: still not orphaned', isOrphanedTeardown(1, 1, false) === false);

  // --- the actual gap: nothing ever covers this generation -----------------
  ok(
    'no canvasInit followed (coveredGen still at its initial -1) => orphaned, IF a viewer is active',
    isOrphanedTeardown(1, -1, true) === true
  );
  ok(
    'no canvasInit followed, but nothing was running => nothing to clean up, not orphaned',
    isOrphanedTeardown(1, -1, false) === false
  );

  // --- a STALE canvasInit (from a PRIOR draw cycle) must not falsely cover
  // a NEWER teardown it precedes -----------------------------------------
  ok(
    'an OLDER covered generation does not retroactively cover a NEWER teardown',
    isOrphanedTeardown(2, 1, true) === true
  );

  // --- rapid unview() -> view(newScene): the watchdog for the FIRST
  // teardown must be suppressed once ANY later canvasInit fires, even
  // though no NEW teardown incremented the generation in between (Scene#view
  // skips tearDown() entirely when the canvas was already blank) -----------
  ok(
    'a later canvasInit for the SAME generation (rapid unview-then-view) suppresses the watchdog',
    isOrphanedTeardown(3, 3, true) === false
  );
}
