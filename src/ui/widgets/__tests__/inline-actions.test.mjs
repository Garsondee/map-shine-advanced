/**
 * inline-actions.js's pure halves: the two-click confirm machine and the
 * name-entry rules that replaced the Studio's native `confirm()` / `prompt()`.
 * The DOM builders are browser-verified live in the studio-preview harness.
 *
 * What these guard is the safety property of a destructive control: a delete
 * must take two deliberate clicks, must NOT stay armed forever, and must not
 * fire on a stale second click after it already timed out.
 */
import { createArmMachine, normalizeName, ARM_MS } from '../inline-actions.js';

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

function arm(overrides = {}) {
  const timers = fakeTimers();
  const log = [];
  const m = createArmMachine({
    armMs: 4000,
    onArm: () => log.push('arm'),
    onDisarm: () => log.push('disarm'),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { m, timers, log };
}

export function run(t) {
  const { ok } = t;

  ok(
    'the default arm window is a few seconds — long enough to react, short enough not to linger',
    ARM_MS >= 2000 && ARM_MS <= 8000
  );

  {
    const { m, log } = arm();
    ok('a fresh machine is not armed', m.isArmed() === false);
    ok('the FIRST press arms and does not fire', m.press() === false && m.isArmed() === true && log.join() === 'arm');
    ok(
      'the SECOND press confirms (fires) and disarms',
      m.press() === true && m.isArmed() === false && log.join() === 'arm,disarm'
    );
  }

  {
    const { m, timers, log } = arm();
    m.press();
    timers.advance(3999);
    ok('still armed just before the window closes', m.isArmed() === true);
    timers.advance(1);
    ok('...disarms itself when the window closes', m.isArmed() === false && log.join() === 'arm,disarm');
    ok(
      'a click AFTER it timed out is a fresh first press, never a confirm',
      m.press() === false && m.isArmed() === true
    );
  }

  {
    const { m, timers, log } = arm();
    m.press();
    m.press();
    timers.advance(10_000);
    ok(
      'confirming clears the timer, so there is no late second disarm',
      log.join() === 'arm,disarm' && timers.pending() === 0
    );
  }

  {
    const { m, timers, log } = arm();
    m.disarm();
    ok('disarming when not armed is a no-op (no spurious onDisarm)', log.length === 0);
    m.press();
    m.disarm();
    ok(
      'disarm() (a blur) cancels an armed button and its timer',
      m.isArmed() === false && timers.pending() === 0 && log.join() === 'arm,disarm'
    );
    ok('...and the next press starts over rather than confirming', m.press() === false);
  }

  // ---- name entry ---------------------------------------------------------
  ok(
    'a typed name is trimmed',
    JSON.stringify(normalizeName('  Misty morning  ')) === '{"ok":true,"name":"Misty morning"}'
  );
  ok('an empty name is refused by default', normalizeName('').ok === false);
  ok('a whitespace-only name is refused too', normalizeName('   \t ').ok === false);
  ok(
    'null/undefined are refused rather than becoming the string "null"',
    normalizeName(null).ok === false && normalizeName(undefined).ok === false
  );
  ok(
    'with allowEmpty an empty entry becomes the fallback (cue capture must never dead-end)',
    JSON.stringify(normalizeName('  ', { allowEmpty: true, fallback: 'Captured — 3:04 PM' })) ===
      '{"ok":true,"name":"Captured — 3:04 PM"}'
  );
  ok(
    'allowEmpty never overrides a name the user DID type',
    normalizeName('Dusk', { allowEmpty: true, fallback: 'Captured' }).name === 'Dusk'
  );
  ok('a numeric name is kept as text', normalizeName(42).name === '42');
}
