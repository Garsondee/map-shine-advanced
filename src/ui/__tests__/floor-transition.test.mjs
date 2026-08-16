/**
 * ui/floor-transition.js — the pure text-formatting core, plus the
 * environment-safety guarantee: importing and calling this module under plain
 * Node (no `document`) must never throw and must never fake visibility.
 *
 * The DOM-dependent behaviour (the SHOW_AFTER_MS delayed reveal, the Cancel
 * button actually invoking its callback) needs a real browser and is
 * therefore verified live, not here — same split every other `ui/` module in
 * this project draws.
 */
import {
  SHOW_AFTER_MS,
  formatFloorTransitionHeadline,
  formatFloorTransitionBlockers,
  beginFloorTransition,
  updateFloorTransitionProgress,
  endFloorTransition,
  isFloorTransitionVisible,
  isFloorTransitionActive,
} from '../floor-transition.js';

export function run(t) {
  const { ok } = t;

  // ---- formatFloorTransitionHeadline --------------------------------------
  ok('climbing a floor reads as going up', formatFloorTransitionHeadline(0, 1) === 'Going up');
  ok('descending a floor reads as going down', formatFloorTransitionHeadline(2, 0) === 'Going down');
  ok('a multi-floor jump is still just a direction', formatFloorTransitionHeadline(0, 3) === 'Going up');
  ok(
    'the SAME floor (a redraw, not a real switch) falls back rather than lying about direction',
    formatFloorTransitionHeadline(1, 1) === 'Switching floors'
  );
  ok('missing indices fall back the same way', formatFloorTransitionHeadline(null, 1) === 'Switching floors');
  ok('...both missing', formatFloorTransitionHeadline(undefined, undefined) === 'Switching floors');
  ok(
    'a non-finite index falls back rather than throwing',
    formatFloorTransitionHeadline(NaN, 1) === 'Switching floors'
  );

  // ---- formatFloorTransitionBlockers ---------------------------------------
  ok('an empty list renders as nothing', formatFloorTransitionBlockers([]) === '');
  ok('a null list does not throw', formatFloorTransitionBlockers(null) === '');
  ok('a missing list does not throw', formatFloorTransitionBlockers(undefined) === '');
  const three = ['a', 'b', 'c'];
  ok('a list at the cap is shown whole', formatFloorTransitionBlockers(three) === 'a · b · c');
  const five = ['a', 'b', 'c', 'd', 'e'];
  ok(
    'an over-cap list never silently truncates — it says how many more',
    /\+2 more/.test(formatFloorTransitionBlockers(five))
  );
  ok('...and still shows the first ones in full', formatFloorTransitionBlockers(five).startsWith('a · b · c'));

  // ---- the reveal delay is a real, positive number -------------------------
  ok('SHOW_AFTER_MS is a real positive delay', Number.isFinite(SHOW_AFTER_MS) && SHOW_AFTER_MS > 0);

  // ---- environment safety: no DOM here, so every call must be a safe no-op
  ok('nothing active before begin', isFloorTransitionActive() === false && isFloorTransitionVisible() === false);
  beginFloorTransition({ fromFloorIndex: 0, toFloorIndex: 1, onCancel: () => {} });
  ok(
    'beginFloorTransition does not throw without a DOM, and does not fake visibility',
    isFloorTransitionVisible() === false
  );
  ok('...but IS active — the timer armed even though nothing rendered', isFloorTransitionActive() === true);
  updateFloorTransitionProgress(['map layers still loading (2)']);
  endFloorTransition();
  ok(
    'endFloorTransition clears both active and visible',
    isFloorTransitionActive() === false && isFloorTransitionVisible() === false
  );
  ok('endFloorTransition is safe to call again with nothing active', (endFloorTransition(), true));

  // ---- beginFloorTransition never stacks two ------------------------------
  beginFloorTransition({ fromFloorIndex: 1, toFloorIndex: 2 });
  beginFloorTransition({ fromFloorIndex: 2, toFloorIndex: 1 }); // a rapid second request
  ok('a second begin tears down the first rather than leaking state', isFloorTransitionActive() === true);
  endFloorTransition();
}
