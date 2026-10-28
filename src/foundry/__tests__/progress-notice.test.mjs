/**
 * Node verification for foundry/progress-notice.js — the Foundry progress
 * notification that says what a floor or scene change is doing.
 *
 * Defended: the percentage is a STEP (never a fabricated fraction of unlike work),
 * names are escaped (they are user data in an HTML-rendering widget), an instant
 * change shows NOTHING, and a notification that cannot be shown or updated never
 * breaks the change it describes.
 */
import {
  NOTICE_SHOW_AFTER_MS,
  FLOOR_PREPARE_STEPS,
  describeStep,
  formatPrepareMessage,
  escapeNoticeText,
  createProgressNotice,
  PLAYER_SCENE_MESSAGE,
  PLAYER_FLOOR_MESSAGE,
} from '../progress-notice.js';

/** A fake notification centre and a manual clock. */
function harness() {
  const shown = [];
  const timers = [];
  const notifications = {
    info(message, options) {
      const n = { message, options, pct: 0, removed: false, updates: [] };
      n.update = (u) => {
        n.updates.push(u);
        if (u.pct !== undefined) n.pct = u.pct;
        if (u.message !== undefined) n.message = u.message;
      };
      n.remove = () => {
        n.removed = true;
      };
      shown.push(n);
      return n;
    },
  };
  const notice = createProgressNotice({
    getNotifications: () => notifications,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimer: (h) => {
      timers[h].cleared = true;
    },
  });
  return { notice, shown, timers, fire: (i = 0) => !timers[i].cleared && timers[i].fn() };
}

export function run(t) {
  const { ok } = t;

  // ── describeStep: a step plus the fraction of THAT step's own count ───────────
  const steps = FLOOR_PREPARE_STEPS;
  ok('five steps, in prepare’s order', steps.map((s) => s.id).join() === 'items,compress,masks,bakes,warmup');
  const a = describeStep(steps, { phase: 'items', done: 0, total: 10 });
  ok('the first step starts at 0', a.step === 1 && a.of === 5 && a.pct === 0);
  const b = describeStep(steps, { phase: 'compress', done: 3, total: 6 });
  ok('step 2 half done is (1 + 0.5) / 5', b.step === 2 && Math.abs(b.pct - 0.3) < 1e-9);
  ok('…and names the counted work', b.label === 'compressing the art' && b.detail === ' (3/6)');
  const c = describeStep(steps, { phase: 'warmup', done: 1, total: 1 });
  ok('a one-item step shows no count (it would read “1/1” forever)', c.detail === '' && c.step === 5);
  ok('the last step never exceeds 1', describeStep(steps, { phase: 'warmup', done: 9, total: 9 }).pct <= 1);
  const unknown = describeStep(steps, { phase: 'nonsense', done: 1, total: 4 });
  ok('an unknown phase falls back to the first step rather than throwing', unknown.step === 1);
  ok('missing progress is step 1 of 5', describeStep(steps, null).step === 1);
  ok(
    'done past total is clamped in the count text',
    describeStep(steps, { phase: 'items', done: 12, total: 10 }).detail === ' (10/10)'
  );

  // ── the message, and escaping ─────────────────────────────────────────────────
  ok(
    'escapeNoticeText escapes all five HTML-significant characters',
    escapeNoticeText(`<b>"A&B"</b>'`) === '&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;&#39;'
  );
  ok('…and tolerates null', escapeNoticeText(null) === '');
  const msg = formatPrepareMessage({ name: '<img onerror=x> Cellar' }, b);
  ok('a hostile level name is escaped inside the message', !msg.includes('<img') && msg.includes('&lt;img'));
  ok(
    'the message reads “Preparing X — step 2 of 5: compressing the art (3/6)”',
    formatPrepareMessage({ name: 'Cellar' }, b) === 'Preparing Cellar — step 2 of 5: compressing the art (3/6)'
  );
  ok('a custom verb is used', formatPrepareMessage({ verb: 'Opening', name: 'Keep' }, a).startsWith('Opening Keep'));

  // ── a player is never told which scene or floor is loading ────────────────────
  const playerScene = formatPrepareMessage({ verb: 'Gamemaster is preparing', name: null }, b);
  ok(
    'no name → the generic scene message, no verb, no step detail',
    playerScene === PLAYER_SCENE_MESSAGE && !playerScene.includes('step') && !playerScene.includes('Gamemaster')
  );
  ok('the generic scene message says it may take a while', /little while/.test(PLAYER_SCENE_MESSAGE));
  ok(
    'a floor change can pass its own generic line',
    formatPrepareMessage({ name: undefined, generic: PLAYER_FLOOR_MESSAGE }, b) === PLAYER_FLOOR_MESSAGE
  );

  // ── the notification: nothing until the work is not instant ───────────────────
  ok('the show delay matches ui/floor-transition.js (250 ms)', NOTICE_SHOW_AFTER_MS === 250);
  {
    const h = harness();
    const n = h.notice.begin('Preparing X');
    ok('the timer is armed for the show delay', h.timers.length === 1 && h.timers[0].ms === NOTICE_SHOW_AFTER_MS);
    ok('NOTHING is shown before the delay', h.shown.length === 0 && n.isShown() === false);
    n.end();
    ok('ending before the delay clears the timer — an instant change never flickers', h.timers[0].cleared === true);
    h.fire();
    ok('…and a late timer firing after end shows nothing', h.shown.length === 0);
  }
  {
    const h = harness();
    const n = h.notice.begin('Preparing X');
    h.fire();
    ok('after the delay the progress notification appears', h.shown.length === 1 && n.isShown() === true);
    ok(
      'as a PROGRESS notification that does not spam the console',
      h.shown[0].options.progress === true && h.shown[0].options.console === false
    );
    n.update('Preparing X — step 2 of 5', 0.4);
    ok(
      'updates reach the live notification with message and pct',
      h.shown[0].pct === 0.4 && h.shown[0].message === 'Preparing X — step 2 of 5'
    );
    n.update('over', 7);
    ok('pct is clamped to 0..1', h.shown[0].pct === 1);
    n.end();
    ok('ending removes it', h.shown[0].removed === true && n.isShown() === false);
    n.update('after end', 0.5);
    ok('an update after end is ignored', h.shown[0].message === 'over');
    n.end();
    ok('ending twice is harmless', true);
  }
  {
    const h = harness();
    const n = h.notice.begin('Preparing X');
    n.update('Preparing X — step 3 of 5', 0.5); // before it is shown
    h.fire();
    ok(
      'progress made BEFORE the notification appears is applied the moment it does',
      h.shown[0].pct === 0.5 && h.shown[0].updates.length === 1
    );
  }

  // ── a notification must never break the change it describes ───────────────────
  {
    const throwing = createProgressNotice({
      getNotifications: () => ({
        info() {
          throw new Error('ui.notifications exploded');
        },
      }),
      setTimer: (fn) => fn(),
      clearTimer: () => {},
    });
    const n = throwing.begin('x');
    ok('a notifications.info that throws is contained', n.isShown() === false);
    n.update('y', 0.2);
    n.end();
    ok('…and update/end afterwards are safe', true);
    const none = createProgressNotice({ getNotifications: () => null, setTimer: (fn) => fn(), clearTimer: () => {} });
    const n2 = none.begin('x');
    ok('no ui.notifications at all => nothing shown, nothing thrown', n2.isShown() === false);
    n2.end();
  }
}
