/**
 * The Pen's gates, tested as far as this environment honestly allows: `game`
 * is undefined under Node (no Foundry), so `readIsGM()` genuinely returns
 * `false` here — every `advance()` call in this suite is REAL refused-at-
 * the-GM-gate behaviour, not a simulation of it. The full success path
 * (a real `game.time.advance()` landing) needs a live Foundry `game` global
 * this project does not mock (the same "pure logic gets tests, Foundry-
 * touching paths get verified live" line every sibling file in this
 * directory already draws — `game-time.test.mjs` tests only its pure
 * `deriveHourFromComponents`, never `readWorldTimeOfDay` itself).
 *
 * What IS fully proven here: every REFUSAL reason a gate can produce, that
 * every refusal still lands in the audit log (so a live reviewer can see
 * "the hold actually fired", not just infer it), and that the day/week
 * convenience wrappers compute the exact right delta before they ever reach
 * a gate — visible because `refuse()` logs the ATTEMPTED delta too.
 *
 * The aggregator (`run-tests.mjs`) does `await fn(t)`, so `run` here being
 * `async` is fully supported — every assertion below is awaited for real.
 */
import { advance, isPenArmed, getAdvanceAuditLog, jumpToHour, advanceDays, advanceWeeks } from '../time-authority.js';

export async function run(t) {
  // ---- isPenArmed: pure, fully testable ------------------------------------
  t.ok("armed only in 'almanac' posture", isPenArmed('almanac') === true);
  t.ok("NOT armed in 'follow'", isPenArmed('follow') === false);
  t.ok("NOT armed in 'aesthetic'", isPenArmed('aesthetic') === false);
  t.ok('NOT armed for garbage input', isPenArmed('almanacc') === false && isPenArmed(undefined) === false);

  // ---- the audit log starts as a frozen array ------------------------------
  {
    const log = getAdvanceAuditLog();
    t.ok('getAdvanceAuditLog returns an array', Array.isArray(log));
    t.ok('the returned array is frozen (callers cannot rewrite history)', Object.isFrozen(log));
  }

  // ---- refusal: not a finite delta -----------------------------------------
  {
    const before = getAdvanceAuditLog().length;
    const r = await advance(NaN, { posture: 'almanac', source: 'test-nan' });
    t.ok('a non-finite delta is refused', r.ok === false && r.reason.includes('finite'));
    t.ok('the refusal is audited', getAdvanceAuditLog().length === before + 1);
    t.ok('...with the right source tag', getAdvanceAuditLog().at(-1).source === 'test-nan');
  }

  // ---- refusal: posture not armed ------------------------------------------
  {
    const before = getAdvanceAuditLog().length;
    const r = await advance(3600, { posture: 'follow', source: 'test-unarmed' });
    t.ok('a non-almanac posture is refused', r.ok === false && r.reason.includes('not armed'));
    t.ok(
      'the attempted delta is still logged (1 hour = 3600s)',
      getAdvanceAuditLog().length === before + 1 && getAdvanceAuditLog().at(-1).delta === 3600
    );
  }

  // ---- refusal: no GM (the real, unmocked Node behaviour) -----------------
  {
    const r = await advance(3600, { posture: 'almanac', source: 'test-no-gm' });
    t.ok(
      'armed but not a GM client is refused at the GM gate',
      r.ok === false && r.reason.toLowerCase().includes('gm')
    );
  }

  // ---- refusal ORDER: finite-check beats everything else -------------------
  {
    const r = await advance(Infinity, { posture: 'follow' });
    t.ok('a non-finite delta is refused BEFORE the posture check ever runs', r.reason.includes('finite'));
  }

  // ---- jumpToHour: worldTime unavailable is its OWN, distinct refusal ------
  {
    const r = await jumpToHour(6, { posture: 'almanac', source: 'test-jump' });
    t.ok('jumpToHour refuses cleanly with no game.time.worldTime', r.ok === false && r.reason.includes('worldTime'));
    t.ok('and never reaches the gate/audit path at all (delta stays 0)', r.delta === 0);
  }

  // ---- advanceDays / advanceWeeks: the ARITHMETIC is provably right, -------
  // ---- even though the write itself is refused (no GM in this environment) -
  {
    const before = getAdvanceAuditLog().length;
    await advanceDays(2, { posture: 'almanac', source: 'test-days' });
    const entry = getAdvanceAuditLog().at(-1);
    t.ok('advanceDays(2) computes exactly 2*24*3600 seconds (Earth default day length)', entry.delta === 2 * 24 * 3600);
    t.ok('...and it is a NEW entry, not a stale one', getAdvanceAuditLog().length === before + 1);
  }
  {
    await advanceDays(-3, { posture: 'almanac', source: 'test-days-negative' });
    t.ok(
      'advanceDays accepts negative n (a correction) and computes the signed delta',
      getAdvanceAuditLog().at(-1).delta === -3 * 24 * 3600
    );
  }
  {
    await advanceWeeks(1, { posture: 'almanac', source: 'test-weeks' });
    t.ok(
      'advanceWeeks(1) computes exactly 7*24*3600 seconds (Earth default week length)',
      getAdvanceAuditLog().at(-1).delta === 7 * 24 * 3600
    );
  }

  // ---- the ring buffer caps its size, never growing without bound ---------
  {
    for (let i = 0; i < 60; i++) {
      await advance(1, { posture: 'almanac', source: `test-cap-${i}` });
    }
    t.ok('the audit log never exceeds its declared capacity (50)', getAdvanceAuditLog().length === 50);
    t.ok('...and keeps the MOST RECENT entries (FIFO drop)', getAdvanceAuditLog().at(-1).source === 'test-cap-59');
  }
}
