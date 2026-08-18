/**
 * THE DAY CLOCK — the one owner of time-of-day, and the two modes that keep it
 * from ever writing back into Foundry's world clock.
 *
 * The mode assertions are the important ones: they are what stops V2's
 * write-back feedback loop from being reintroduced by someone who thinks
 * "surely the dial should also move the world clock".
 */
import {
  createDayClock,
  shortestHourDelta,
  DAY_CLOCK_MODES,
  DEFAULT_RATE_HOURS_PER_MINUTE,
  ALMANAC_POSTURES,
  postureToDayClockMode,
} from '../day-clock.js';

export function run(t) {
  const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

  // ---- the short way round the dial ----------------------------------------
  {
    t.ok('forward within the day', close(shortestHourDelta(9, 11), 2));
    t.ok('backward within the day', close(shortestHourDelta(11, 9), -2));
    t.ok('23:00 → 01:00 sweeps FORWARD through midnight, not back through the day', close(shortestHourDelta(23, 1), 2));
    t.ok('01:00 → 23:00 sweeps backward through midnight', close(shortestHourDelta(1, 23), -2));
    t.ok('exactly opposite resolves without NaN', Number.isFinite(shortestHourDelta(0, 12)));
  }

  // ---- defaults -------------------------------------------------------------
  {
    const c = createDayClock();
    const s = c.read();
    t.ok('a fresh clock reads noon', s.todHour === 12);
    t.ok('a fresh clock is aesthetic', s.mode === 'aesthetic');
    t.ok('a fresh clock does NOT drift', s.rateHoursPerMinute === DEFAULT_RATE_HOURS_PER_MINUTE);
    t.ok('and its ring is draggable', s.canSetHour === true);
    t.ok('ticking a rate-0 clock changes nothing', c.tick(10) === 12);
    t.ok('the state object is frozen', Object.isFrozen(s));
  }

  // ---- drift ----------------------------------------------------------------
  {
    const c = createDayClock({ todHour: 6, rateHoursPerMinute: 24 });
    c.tick(60); // one real minute at 24 game-hours/min = exactly one full day
    t.ok('a full-day rate wraps cleanly back to the same hour', close(c.read().todHour, 6, 1e-9));

    const d = createDayClock({ todHour: 0, rateHoursPerMinute: 6 });
    d.tick(30); // half a real minute → 3 game hours
    t.ok('drift is hours-per-real-MINUTE, not per second', close(d.read().todHour, 3));

    const e = createDayClock({ todHour: 1, rateHoursPerMinute: -6 });
    e.tick(30);
    t.ok('a negative rate runs the day backwards, wrapping past midnight', close(e.read().todHour, 22));
  }

  {
    // The whole reason the day clock takes the SIM delta: a paused world has
    // dtSec 0, so the sun stops with everything else. No special case needed.
    const c = createDayClock({ todHour: 9, rateHoursPerMinute: 60 });
    c.tick(0);
    t.ok('a zero delta (a paused world) freezes the sun too', c.read().todHour === 9);
  }

  // ---- MODES: the write-back that must never exist -------------------------
  {
    t.ok('there are exactly two modes', DAY_CLOCK_MODES.length === 2);

    const c = createDayClock({ todHour: 12, mode: 'synced' });
    t.ok('synced mode reports its ring read-only', c.read().canSetHour === false);
    t.ok('setHour is REJECTED in synced mode', c.setHour(3) === false);
    t.ok('and the hour genuinely did not move', c.read().todHour === 12);

    // ...but the world clock itself must still be able to drive it, or synced
    // mode would be inert.
    c.syncTo(15);
    c.tick(10);
    t.ok('syncTo still works in synced mode — it is the ONLY way the hour moves', c.read().todHour === 15);
  }

  {
    const c = createDayClock({ todHour: 12, mode: 'aesthetic', rateHoursPerMinute: 30 });
    c.setMode('synced');
    c.tick(60);
    t.ok('a local drift rate does NOT run in synced mode', c.read().todHour === 12);
    c.setMode('aesthetic');
    c.tick(60);
    t.ok('and it resumes when the mode returns', close(c.read().todHour, 18));
  }

  {
    const c = createDayClock({ todHour: 6 });
    c.syncTo(18);
    t.ok('a walk is in flight', c.read().isSyncing === true);
    c.setMode('synced');
    t.ok('changing mode abandons a walk authorised under the old rules', c.read().isSyncing === false);
  }

  {
    const c = createDayClock({ mode: 'nonsense' });
    t.ok('an unknown mode falls back to aesthetic, never undefined', c.read().mode === 'aesthetic');
  }

  // ---- eased sync, not a snap ----------------------------------------------
  {
    const c = createDayClock({ todHour: 12, syncHoursPerSecond: 6 });
    c.syncTo(20);
    const afterOneFrame = c.tick(1 / 60);
    t.ok('a big jump does NOT land in one frame', afterOneFrame < 12.2 && afterOneFrame > 12);
    t.ok('and reports itself as syncing', c.read().isSyncing === true);
    for (let i = 0; i < 200; i++) c.tick(1 / 60);
    t.ok('but it does arrive', close(c.read().todHour, 20, 1e-6));
    t.ok('and stops reporting as syncing once it has', c.read().isSyncing === false);
  }

  {
    // A combat round is +6 world-seconds. That must land essentially at once —
    // an eased sync that takes a visible beat for a 6-second nudge would read
    // as lag, not as a sweep.
    const c = createDayClock({ todHour: 12 });
    c.syncTo(12 + 6 / 3600);
    c.tick(1 / 60);
    t.ok('a combat-round-sized nudge lands immediately', c.read().isSyncing === false);
  }

  {
    const c = createDayClock({ todHour: 23 });
    c.syncTo(1);
    for (let i = 0; i < 200; i++) c.tick(1 / 60);
    t.ok('a sync across midnight arrives (short way round)', close(c.read().todHour, 1, 1e-6));
  }

  {
    const c = createDayClock({ todHour: 4 });
    c.jumpTo(19.5);
    t.ok('jumpTo lands instantly — for a scene load, with no walk', c.read().todHour === 19.5);
    t.ok('and leaves nothing in flight', c.read().isSyncing === false);
  }

  {
    const c = createDayClock({ todHour: 4 });
    c.syncTo(20);
    c.setHour(9);
    t.ok('a manual ring drag cancels an in-flight walk', c.read().isSyncing === false && c.read().todHour === 9);
  }

  // ---- clamping / robustness -----------------------------------------------
  {
    const c = createDayClock({ todHour: 30.5 });
    t.ok('an out-of-range start hour wraps', close(c.read().todHour, 6.5));
    t.ok('an absurd rate clamps', c.setRate(1e9) === 60);
    t.ok('a non-finite rate reads as frozen, never NaN', c.setRate(NaN) === 0);
    c.setHour(NaN);
    t.ok('a non-finite hour reads as noon, never NaN downstream', c.read().todHour === 12);
    c.tick(NaN);
    t.ok('a non-finite delta is ignored', c.read().todHour === 12);
    c.tick(-5);
    t.ok('a negative delta never runs the clock backwards', c.read().todHour === 12);
  }

  // ---- ALMANAC_POSTURES / postureToDayClockMode (Almanac Testament §1) -----
  {
    t.ok('there are exactly three postures', ALMANAC_POSTURES.length === 3);
    t.ok(
      'the three are exactly aesthetic/follow/almanac',
      ['aesthetic', 'follow', 'almanac'].every((p) => ALMANAC_POSTURES.includes(p))
    );
    t.ok('ALMANAC_POSTURES is frozen', Object.isFrozen(ALMANAC_POSTURES));

    t.ok("aesthetic posture -> day-clock's aesthetic mode", postureToDayClockMode('aesthetic') === 'aesthetic');
    t.ok("follow posture -> day-clock's synced mode", postureToDayClockMode('follow') === 'synced');
    t.ok(
      "almanac posture -> day-clock's synced mode too (both READ the same way)",
      postureToDayClockMode('almanac') === 'synced'
    );
    t.ok(
      'follow and almanac are indistinguishable to day-clock — by design (the pen is a separate faculty)',
      postureToDayClockMode('follow') === postureToDayClockMode('almanac')
    );
    t.ok(
      'garbage input fails to aesthetic — the SAME direction normalizeMode already fails in',
      postureToDayClockMode('nonsense') === 'aesthetic' && postureToDayClockMode(undefined) === 'aesthetic'
    );

    // The translated mode must actually drive the day clock correctly —
    // proves the two functions compose, not just that each looks right alone.
    const c = createDayClock({ todHour: 12, mode: postureToDayClockMode('almanac') });
    t.ok('a clock constructed from the translated almanac posture is ring-locked', c.read().canSetHour === false);
    const c2 = createDayClock({ todHour: 12, mode: postureToDayClockMode('aesthetic') });
    t.ok('a clock constructed from the translated aesthetic posture is ring-free', c2.read().canSetHour === true);
  }
}
