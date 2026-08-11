/**
 * Node verification for vt/settle.js — the "is the scene actually finished
 * loading" detector.
 *
 * The properties pinned here are the ones whose failure modes are expensive and
 * SILENT: declaring settled while work is outstanding (a screenshot of a
 * half-drawn map, read as truth), declaring settled during the gap between two
 * stages (the premature-completion bug this module exists to end), and
 * declaring settled in a renderer that is not drawing at all.
 */
import { createSettleTracker, summarizeSettleWork, DEFAULT_SETTLE_QUIET_MS, SETTLE_WORK_KEYS } from '../settle.js';

export function run(t) {
  const { ok } = t;

  // --- summarizeSettleWork -------------------------------------------------
  {
    const { blockers, totalOutstanding } = summarizeSettleWork({ itemsLoading: 3, residencyInFlight: true });
    ok(
      'counts a numeric counter',
      blockers.some((b) => b.key === 'itemsLoading' && b.count === 3)
    );
    ok(
      'treats a boolean flag as one unit of work',
      blockers.some((b) => b.key === 'residencyInFlight' && b.count === 1)
    );
    ok('totals across kinds', totalOutstanding === 4);
    ok(
      'every blocker carries a human label',
      blockers.every((b) => typeof b.label === 'string' && b.label.length > 5)
    );
  }
  {
    const { blockers, totalOutstanding } = summarizeSettleWork({});
    ok('an empty bag is zero work, never a fabricated blocker', blockers.length === 0 && totalOutstanding === 0);
    const missing = summarizeSettleWork(null);
    ok('a null bag does not throw', missing.totalOutstanding === 0);
    const unknown = summarizeSettleWork({ somethingElse: 99 });
    ok('an unknown key is ignored, never counted as work', unknown.totalOutstanding === 0);
  }
  {
    const keys = new Set(SETTLE_WORK_KEYS.map((k) => k.key));
    ok('the key list has no duplicates', keys.size === SETTLE_WORK_KEYS.length);
  }

  // --- the quiet period ----------------------------------------------------
  // THE CENTRAL CASE: counters dip through zero between stages. A reader that
  // calls the first zero "done" reproduces exactly the bug this module exists
  // to fix, so a single zero sample must NEVER settle.
  {
    const tr = createSettleTracker({ quietMs: 1000, minFrames: 2 });
    let s = tr.sample({ itemsLoading: 2 }, 0, 0);
    ok('work outstanding is not settled', s.settled === false && s.totalOutstanding === 2);
    s = tr.sample({}, 100, 10);
    ok('the FIRST zero sample is not settled (this is the between-stages dip)', s.settled === false);
    s = tr.sample({ bcCompressOutstanding: 1 }, 200, 20);
    ok('work reappearing restarts the clock', s.settled === false && s.quietForMs === 0);
    s = tr.sample({}, 300, 30);
    s = tr.sample({}, 1200, 40);
    ok('quiet must be measured from the RESTART, not the first ever zero', s.settled === false);
    s = tr.sample({}, 1301, 50);
    ok('settles once the full quiet period has elapsed with frames advancing', s.settled === true);
    ok('and reports nothing outstanding', s.blockers.length === 0 && s.waitingFor.length === 0);
  }

  // --- a still renderer is not a settled one -------------------------------
  {
    const tr = createSettleTracker({ quietMs: 100, minFrames: 2 });
    tr.sample({}, 0, 5);
    const s = tr.sample({}, 5000, 5); // ages of quiet, but the frame count never moved
    ok('zero work + zero frames is NOT settled', s.settled === false);
    ok(
      '...and it says so plainly',
      s.waitingFor.some((w) => /frames/i.test(w))
    );
    const s2 = tr.sample({}, 6000, 9);
    ok('once frames advance, it settles', s2.settled === true);
  }

  // --- what it was waiting for --------------------------------------------
  {
    const tr = createSettleTracker({ quietMs: 1000 });
    const s = tr.sample({ itemsLoading: 1, maskPagesPending: 7 }, 0, 0);
    ok(
      'waitingFor names each blocker with its count',
      s.waitingFor.length === 2 && /\(7\)/.test(s.waitingFor.join(' '))
    );
    ok('blockers are ordered by the loading chain, earliest first', s.blockers[0].key === 'itemsLoading');
    const quiet = tr.sample({}, 10, 5);
    ok('during the quiet dwell it says it is waiting on the period itself', /quiet period/.test(quiet.waitingFor[0]));
  }

  // --- housekeeping --------------------------------------------------------
  {
    const tr = createSettleTracker();
    ok('read() before any sample is null, never a fake settled', tr.read() === null);
    tr.sample({}, 0, 0);
    ok('read() returns the last sample', tr.read() !== null);
    tr.reset();
    ok('reset clears it (a floor switch starts a NEW settle, not a continued one)', tr.read() === null);
    ok('the default quiet period is a real, positive number', DEFAULT_SETTLE_QUIET_MS > 0);
  }
}
