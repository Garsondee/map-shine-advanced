/**
 * tooltip.js's pure halves: where a tooltip goes, and WHEN it shows.
 *
 * The DOM wiring (title → data-tip conversion, listeners, the element itself)
 * is browser-verified live in the studio-preview harness, same convention as
 * every other widget here (CONVENTIONS.md §4). What can silently go wrong in
 * the part that runs in Node is exactly what makes a tooltip feel wrong: a
 * delay that restarts on every child element the pointer crosses, a "warm"
 * window that never closes, a tooltip that reappears under a slider you are
 * dragging, or one that hangs off the edge of the screen.
 */
import {
  computeTooltipPosition,
  createTooltipMachine,
  mergeTooltipScopes,
  setTip,
  installTooltips,
  DEFAULT_TOOLTIP_SCOPE,
  TOOLTIP_OPEN_DELAY_MS,
  TOOLTIP_WARM_MS,
} from '../tooltip.js';

/** The slice of an element `setTip` touches: attributes, `dataset`, `title`. */
function fakeEl({ title = '', dataTip } = {}) {
  const attrs = new Map();
  const el = {
    dataset: {},
    title,
    hasAttribute: (name) => attrs.has(name),
  };
  if (dataTip !== undefined) {
    attrs.set('data-tip', dataTip);
    el.dataset.tip = dataTip;
  }
  return el;
}

/** A virtual clock: `setTimer` queues, `advance(ms)` runs everything due. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const queue = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      queue.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => queue.size,
  };
}

function machine(overrides = {}) {
  const timers = fakeTimers();
  const calls = [];
  const m = createTooltipMachine({
    show: (target, text, opts) => calls.push({ type: 'show', target, text, instant: opts.instant, side: opts.side }),
    hide: () => calls.push({ type: 'hide' }),
    openDelayMs: 450,
    warmMs: 300,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return {
    m,
    timers,
    calls,
    shows: () => calls.filter((c) => c.type === 'show'),
    hides: () => calls.filter((c) => c.type === 'hide'),
  };
}

export function run(t) {
  const { ok } = t;

  // ---- placement ----------------------------------------------------------
  const viewport = { w: 1000, h: 800 };
  const anchor = { left: 100, top: 100, right: 140, bottom: 124 };
  const size = { w: 80, h: 24 };

  const below = computeTooltipPosition({ anchor, size, viewport });
  ok(
    'default placement is BELOW the anchor, centred on it',
    below.side === 'bottom' && below.top === 132 && below.left === 80
  );

  const nearBottom = computeTooltipPosition({
    anchor: { left: 100, top: 760, right: 140, bottom: 784 },
    size,
    viewport,
  });
  ok('flips ABOVE when there is no room below', nearBottom.side === 'top' && nearBottom.top === 728);

  const cramped = computeTooltipPosition({ anchor, size: { w: 80, h: 900 }, viewport });
  ok('when neither side fits it keeps the preferred side rather than inventing one', cramped.side === 'bottom');

  const farRight = computeTooltipPosition({
    anchor: { left: 960, top: 100, right: 1000, bottom: 124 },
    size,
    viewport,
  });
  ok(
    'clamps to the right edge instead of hanging off the screen',
    farRight.left + size.w <= viewport.w - 8 && farRight.left >= 8
  );
  const farLeft = computeTooltipPosition({ anchor: { left: 0, top: 100, right: 20, bottom: 124 }, size, viewport });
  ok('clamps to the left edge too', farLeft.left === 8);

  const rail = computeTooltipPosition({
    anchor: { left: 20, top: 100, right: 62, bottom: 142 },
    size,
    viewport,
    side: 'right',
  });
  ok(
    'side:right puts it beside the anchor (the department rail)',
    rail.side === 'right' && rail.left === 70 && rail.top === 109
  );
  const railFlip = computeTooltipPosition({
    anchor: { left: 940, top: 100, right: 980, bottom: 142 },
    size,
    viewport,
    side: 'right',
  });
  ok('...and flips to the LEFT when there is no room on the right', railFlip.side === 'left');
  const railTop = computeTooltipPosition({
    anchor: { left: 20, top: 0, right: 62, bottom: 20 },
    size,
    viewport,
    side: 'right',
  });
  ok('a side placement is clamped vertically too', railTop.top >= 8);

  // ---- timing -------------------------------------------------------------
  ok(
    'the defaults are sane: a real delay, and a shorter warm window',
    TOOLTIP_OPEN_DELAY_MS > 200 && TOOLTIP_WARM_MS > 0 && TOOLTIP_WARM_MS < TOOLTIP_OPEN_DELAY_MS
  );

  {
    const { m, timers, shows } = machine();
    const a = {};
    m.enter(a, 'Pin to top');
    timers.advance(449);
    ok('nothing shows before the open delay has elapsed', shows().length === 0);
    timers.advance(1);
    ok(
      '...and it shows exactly when it has, animated (not instant)',
      shows().length === 1 && shows()[0].instant === false && shows()[0].text === 'Pin to top'
    );
  }

  {
    const { m, timers, shows } = machine();
    const a = {};
    m.enter(a, 'x');
    timers.advance(200);
    m.leave(a);
    timers.advance(1000);
    ok(
      'leaving before the delay cancels it — a quick sweep across a toolbar shows nothing',
      shows().length === 0 && timers.pending() === 0
    );
  }

  {
    // Crossing child elements re-fires `pointerover` for the SAME target; that
    // must not restart the wait.
    const { m, timers, shows } = machine();
    const a = {};
    m.enter(a, 'x');
    timers.advance(300);
    m.enter(a, 'x');
    timers.advance(150);
    ok('re-entering the same target while pending does NOT restart the delay', shows().length === 1);
  }

  {
    const { m, timers, shows, hides } = machine();
    const a = {};
    const b = {};
    m.enter(a, 'A');
    timers.advance(450);
    m.leave(a);
    m.enter(b, 'B');
    ok(
      'moving to a neighbour within the warm window shows it AT ONCE and without animation',
      shows().length === 2 && shows()[1].instant === true && shows()[1].text === 'B'
    );
    ok('...and the pointer leaving A hid it exactly once', hides().length === 1);
  }

  {
    const { m, timers, shows } = machine();
    const a = {};
    const b = {};
    m.enter(a, 'A');
    timers.advance(450);
    m.enter(b, 'B');
    ok(
      'hovering a second target while one is open swaps instantly, with no hide/show flicker between',
      shows().length === 2 && shows()[1].instant === true
    );
  }

  {
    const { m, timers, shows } = machine();
    const a = {};
    m.enter(a, 'A');
    timers.advance(450);
    m.leave(a);
    timers.advance(299);
    ok('the warm window is still open just before it closes', m.isWarm() === true);
    timers.advance(1);
    ok('...and closes on time', m.isWarm() === false);
    m.enter({}, 'C');
    timers.advance(449);
    ok('after the warm window the next tooltip waits the full delay again', shows().length === 1);
    timers.advance(1);
    ok('...then shows, animated', shows().length === 2 && shows()[1].instant === false);
  }

  {
    // A press (dismiss) must keep the tooltip from reappearing under a slider
    // that is being dragged, until the pointer actually leaves.
    const { m, timers, shows, hides } = machine();
    const a = {};
    m.enter(a, 'A');
    timers.advance(450);
    m.dismiss(a);
    ok('a press hides a showing tooltip', hides().length === 1 && m.isShowing() === false);
    m.enter(a, 'A');
    timers.advance(2000);
    ok('...and it does NOT come back while the pointer is still over that same control', shows().length === 1);
    m.leave(a);
    timers.advance(400); // let the warm window lapse
    m.enter(a, 'A');
    timers.advance(450);
    ok('...but it can again once the pointer has left and returned', shows().length === 2);
  }

  {
    const { m, timers, shows } = machine();
    const a = {};
    m.enter(a, 'A');
    m.dismiss(a);
    timers.advance(2000);
    ok('a press during the pending delay cancels the pending tooltip', shows().length === 0 && timers.pending() === 0);
  }

  {
    const { m, timers, shows, hides } = machine();
    m.enter({}, 'A');
    timers.advance(450);
    m.reset();
    ok('reset (scroll / Escape) hides and clears everything', hides().length === 1 && m.isShowing() === false);
    timers.advance(1000); // the warm window the hide started lapses
    m.enter({}, 'B');
    timers.advance(449);
    ok('...and leaves no stuck state: the next tooltip waits its normal delay', shows().length === 1);
    timers.advance(1);
    ok('...and then shows, animated', shows().length === 2 && shows()[1].instant === false);
  }

  {
    const { m, timers, shows } = machine();
    m.enter({}, '');
    m.enter({}, undefined);
    timers.advance(2000);
    ok('a target with no text never shows a blank tooltip', shows().length === 0);
  }

  {
    const { m, timers, shows } = machine();
    const a = {};
    m.enter(a, 'A', 'right');
    timers.advance(450);
    ok('the requested side is passed through to show()', shows()[0].side === 'right');
  }

  // ---- several rooms, one tooltip ------------------------------------------------
  ok(
    'the default scope is still the Studio (its call site passes none)',
    DEFAULT_TOOLTIP_SCOPE === '#msa-studio, .msa-studio-pop'
  );
  ok(
    'a scope list is split into selectors and added after the ones already covered',
    mergeTooltipScopes(['#msa-studio'], '#msa-remote, #msa-player').join('|') === '#msa-studio|#msa-remote|#msa-player'
  );
  ok(
    'a selector already covered is not added twice (every room may call install, in any order)',
    mergeTooltipScopes(['#msa-studio', '.pop'], '.pop, #msa-studio, #msa-remote').join('|') ===
      '#msa-studio|.pop|#msa-remote'
  );
  ok(
    'commas INSIDE parentheses do not split a selector (:is(a, b) stays whole)',
    mergeTooltipScopes([], ':is(#a, #b) .x, #c').join('|') === ':is(#a, #b) .x|#c'
  );
  ok(
    'blank entries and a missing scope add nothing',
    mergeTooltipScopes(['#a'], ' , ,').join('|') === '#a' &&
      mergeTooltipScopes(['#a'], undefined).join('|') === '#a' &&
      mergeTooltipScopes([], '').length === 0
  );
  {
    const before = ['#a'];
    mergeTooltipScopes(before, '#b');
    ok('the list passed in is never mutated', before.length === 1);
  }
  ok(
    'installTooltips is a no-op without a document (Node) rather than throwing',
    installTooltips({ scope: '#msa-remote' }) === null
  );

  // ---- changing a tooltip's text while the widget owns it ----------------------------
  {
    const el = fakeEl({ title: 'old' });
    setTip(el, 'Pause time flow');
    ok(
      'before the widget has taken over, the text goes to `title` (touch devices keep it)',
      el.title === 'Pause time flow'
    );
  }
  {
    const el = fakeEl({ dataTip: 'Play time flow' });
    setTip(el, 'Pause time flow');
    ok(
      'after the takeover it goes to `data-tip`, and the native `title` stays empty (no second tooltip)',
      el.dataset.tip === 'Pause time flow' && el.title === ''
    );
  }
  ok('setTip on nothing is harmless', (setTip(null, 'x'), setTip(undefined, 'x'), true));
}
