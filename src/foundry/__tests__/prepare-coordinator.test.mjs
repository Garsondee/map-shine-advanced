/**
 * Node verification for foundry/prepare-coordinator.js — the GM side of "prepare
 * the scene on every client, then switch" (loading audit, 2026-10-25).
 *
 * Defended: every way a wait can END is distinct and named, a late or foreign
 * reply can never end the wrong wait, a wait with nobody to wait for does not
 * wait, and the timeout is a real timer that is always cleared.
 */
import { createPrepareCoordinator, PREPARE_MESSAGE } from '../prepare-coordinator.js';

/** A manual clock. */
function clock() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimer: (h) => {
      timers[h].cleared = true;
    },
    fire: (i = 0) => {
      if (!timers[i].cleared) timers[i].fn();
    },
  };
}

export async function run(t) {
  const { ok } = t;

  ok(
    'the three message types are distinct strings',
    new Set(Object.values(PREPARE_MESSAGE)).size === 4 && Object.isFrozen(PREPARE_MESSAGE)
  );

  // ── all-ready ────────────────────────────────────────────────────────────────
  {
    const c = clock();
    const co = createPrepareCoordinator(c);
    const changes = [];
    const s = co.begin({
      token: 'T1',
      recipients: ['a', 'b'],
      timeoutMs: 60000,
      onChange: (x) => changes.push(`${x.ready.length}/${x.total}`),
    });
    ok('a timer is armed for the timeout', c.timers.length === 1 && c.timers[0].ms === 60000);
    ok('the first change reports 0 of 2', changes[0] === '0/2');
    ok(
      'a reply for the right token marks that player',
      co.handleReady({ token: 'T1', userId: 'a' }) === true && s.status().missing.join() === 'b'
    );
    ok('a repeat reply is not counted twice', co.handleReady({ token: 'T1', userId: 'a' }) === false);
    ok('a reply from someone who was never asked is ignored', co.handleReady({ token: 'T1', userId: 'zed' }) === false);
    ok(
      'a reply for another token is ignored',
      co.handleReady({ token: 'OLD', userId: 'b' }) === false && s.status().done === false
    );
    co.handleReady({ token: 'T1', userId: 'b' });
    const end = await s.promise;
    ok(
      'when the last player answers the wait ends "all-ready"',
      end.reason === 'all-ready' && end.missing.length === 0 && end.ready.length === 2
    );
    ok('…and the timeout timer was cleared', c.timers[0].cleared === true);
    ok('onChange saw 1/2 then 2/2', changes.join() === '0/2,1/2,2/2');
    ok('a reply after the end is ignored', co.handleReady({ token: 'T1', userId: 'a' }) === false);
    ok('there is no active session afterwards', co.getActive() === null);
  }

  // ── timeout ──────────────────────────────────────────────────────────────────
  {
    const c = clock();
    const co = createPrepareCoordinator(c);
    const s = co.begin({ token: 'T2', recipients: ['a', 'b'], timeoutMs: 1000 });
    co.handleReady({ token: 'T2', userId: 'a' });
    c.fire();
    const end = await s.promise;
    ok(
      'the timer firing ends the wait "timeout", naming who was still owed',
      end.reason === 'timeout' && end.missing.join() === 'b' && end.ready.join() === 'a'
    );
  }

  // ── forced / cancelled ───────────────────────────────────────────────────────
  {
    const co = createPrepareCoordinator(clock());
    // No manual override any more (2026-10-25): a waiting session has no "proceed now".
    const s1 = co.begin({ token: 'T3', recipients: ['a'], timeoutMs: 0 });
    ok('a session has no manual "proceed now" override', s1.proceedNow === undefined);
    s1.cancel();
    ok('a waiting session ends "cancelled" when the GM cancels', (await s1.promise).reason === 'cancelled');
    const s2 = co.begin({ token: 'T4', recipients: ['a'] });
    s2.cancel();
    ok('cancel ends "cancelled"', (await s2.promise).reason === 'cancelled');
    s2.cancel();
    ok('an ended session cannot be ended again with a different reason', (await s2.promise).reason === 'cancelled');
  }

  // ── presence round: only players who say "here" are waited for ──────────────
  {
    const c = clock();
    const co = createPrepareCoordinator(c);
    const s = co.begin({ token: 'P1', recipients: ['a', 'b', 'nomod'], presenceMs: 2500, timeoutMs: 60000 });
    ok(
      'presence: nothing is owed while the presence round runs',
      s.status().missing.length === 0 && s.status().phase === 'presence'
    );
    ok('presence: a player says "here"', co.handlePresent({ token: 'P1', userId: 'a' }) === true);
    ok(
      'presence: a second "here" from the same player counts once',
      co.handlePresent({ token: 'P1', userId: 'a' }) === false
    );
    ok('presence: a stranger cannot count as present', co.handlePresent({ token: 'P1', userId: 'mallory' }) === false);
    ok('presence: a "here" with a stale token is ignored', co.handlePresent({ token: 'OLD', userId: 'b' }) === false);
    ok(
      'presence: a "ready" before presence ends is not accepted',
      co.handleReady({ token: 'P1', userId: 'a' }) === false
    );
    co.handlePresent({ token: 'P1', userId: 'b' });
    c.fire(0); // the presence window closes
    const after = s.status();
    ok(
      'ready phase: owes exactly the players who said "here"',
      after.phase === 'ready' && after.total === 2 && after.missing.join() === 'a,b'
    );
    ok('ready phase: the player without the module is NOT waited for', !after.missing.includes('nomod'));
    ok('ready phase: a late "here" no longer counts', co.handlePresent({ token: 'P1', userId: 'nomod' }) === false);
    co.handleReady({ token: 'P1', userId: 'a' });
    co.handleReady({ token: 'P1', userId: 'b' });
    const end = await s.promise;
    ok('presence: the switch goes ahead as soon as every present player is ready', end.reason === 'all-ready');
    ok('presence: the wait timer is cleared once it has ended', c.timers[1]?.cleared === true);
  }

  // ── presence round, nobody present: nothing to wait for ──────────────────────
  {
    const c = clock();
    const co = createPrepareCoordinator(c);
    const s = co.begin({ token: 'P2', recipients: ['nomod'], presenceMs: 2500, timeoutMs: 60000 });
    c.fire(0);
    ok(
      'presence: nobody with the module → "no-recipients", the switch proceeds at once',
      (await s.promise).reason === 'no-recipients'
    );
  }

  // ── presence round, GM cancels mid-presence ──────────────────────────────────
  {
    const c = clock();
    const co = createPrepareCoordinator(c);
    const s = co.begin({ token: 'P3', recipients: ['a'], presenceMs: 2500 });
    s.cancel();
    ok('presence: cancel ends the round', (await s.promise).reason === 'cancelled');
    c.fire(0);
    ok('presence: the presence timer is cleared by the end', c.timers[0].cleared === true);
  }

  // ── no timeout armed for 0 / Infinity / missing ──────────────────────────────
  {
    const c = clock();
    const co = createPrepareCoordinator(c);
    co.begin({ token: 'T5', recipients: ['a'], timeoutMs: 0 });
    co.begin({ token: 'T6', recipients: ['a'], timeoutMs: Infinity });
    co.begin({ token: 'T7', recipients: ['a'] });
    ok('0, Infinity and omitted all mean "wait as long as it takes" — no timer', c.timers.length === 0);
  }

  // ── nobody to wait for ───────────────────────────────────────────────────────
  {
    const c = clock();
    const co = createPrepareCoordinator(c);
    const s = co.begin({ token: 'T8', recipients: [], timeoutMs: 5000 });
    ok(
      'no recipients => ends at once as "no-recipients" with no timer',
      (await s.promise).reason === 'no-recipients' && c.timers.length === 0
    );
  }

  // ── supersede ────────────────────────────────────────────────────────────────
  {
    const c = clock();
    const co = createPrepareCoordinator(c);
    const first = co.begin({ token: 'A', recipients: ['a'], timeoutMs: 1000 });
    const second = co.begin({ token: 'B', recipients: ['a'], timeoutMs: 1000 });
    ok('a newer request supersedes the older one', (await first.promise).reason === 'superseded');
    ok('…whose timer is cleared', c.timers[0].cleared === true);
    ok('a reply for the OLD token no longer advances anything', co.handleReady({ token: 'A', userId: 'a' }) === false);
    ok(
      'a reply for the new token does',
      co.handleReady({ token: 'B', userId: 'a' }) === true && (await second.promise).reason === 'all-ready'
    );
  }

  // ── duplicate recipients collapse ────────────────────────────────────────────
  {
    const co = createPrepareCoordinator(clock());
    const s = co.begin({ token: 'D', recipients: ['a', 'a', 'b'] });
    ok('a user listed twice is owed once', s.status().total === 2);
  }
}
