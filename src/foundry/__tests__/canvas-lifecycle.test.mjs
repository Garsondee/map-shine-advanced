/**
 * Node verification for foundry/canvas-lifecycle.js's pure part
 * (isOrphanedTeardown). registerCanvasTearDownWatchdog itself touches
 * Hooks/requestAnimationFrame (browser-only) -- verified live via the
 * blank-canvas transition instead, per this codebase's own convention (same
 * split as canvas-compositing.js's decideArtSuppression vs
 * registerCanvasCompositing).
 */
import { isOrphanedTeardown, decideTeardownKind } from '../canvas-lifecycle.js';

export function run(t) {
  const { ok } = t;

  // --- THE PRIMARY SIGNAL (2026-10-25, loading audit P-02): Foundry's own
  // canvasTearDown options say whether a draw follows. `board.mjs:1125/1346`.
  const scene = { id: 's' };
  const level = { id: 'l' };
  ok(
    'a level change (same scene, next level set) is a redraw — never stop anything',
    decideTeardownKind({ nextScene: scene, nextLevel: level }) === 'redraw'
  );
  ok(
    'a scene change (new scene, next level set) is a redraw',
    decideTeardownKind({ nextScene: { id: 'other' }, nextLevel: level }) === 'redraw'
  );
  ok('draw(null): no scene, no level => blank', decideTeardownKind({ nextScene: null, nextLevel: null }) === 'blank');
  ok(
    'a scene with no resolvable level => blank (Foundry itself goes to #drawBlank, board.mjs:1139)',
    decideTeardownKind({ nextScene: scene, nextLevel: undefined }) === 'blank'
  );
  ok('an explicit null nextLevel => blank', decideTeardownKind({ nextScene: scene, nextLevel: null }) === 'blank');
  ok(
    'no options at all => unknown, so the caller falls back to inference',
    decideTeardownKind(undefined) === 'unknown'
  );
  ok('null options => unknown', decideTeardownKind(null) === 'unknown');
  ok('options without a nextLevel key => unknown', decideTeardownKind({ nextScene: scene }) === 'unknown');
  ok('a non-object => unknown', decideTeardownKind('x') === 'unknown');

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
