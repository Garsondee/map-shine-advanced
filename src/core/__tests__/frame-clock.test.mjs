/**
 * THE ONE CLOCK, and the pause ramp that makes the whole world hold its breath.
 *
 * Every assertion here runs on an INJECTED time source, so the five-second ramp
 * is verified in microseconds and can never flake. V2's equivalent ramp
 * (`legacy/core/time.js#setFoundryPaused`) had no tests at all — it was correct,
 * and nothing would have told anyone if it stopped being.
 */
import { makeFrameClock, DEFAULT_MAX_DT_SEC, DEFAULT_PAUSE_RAMP_SEC } from '../frame-clock.js';

export function run(t) {
  const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

  /** A clock with a hand-cranked time source. `step(sec)` ticks one frame. */
  const fake = (opts = {}) => {
    let wallMs = 1000; // deliberately NOT 0 — tMs must not inherit the epoch
    const clock = makeFrameClock({ now: () => wallMs, ...opts });
    return {
      clock,
      /** Advance wall time and tick once. @returns the frame snapshot. */
      step(sec = 0.1) {
        wallMs += sec * 1000;
        return clock.tick();
      },
      /** Advance `sec` of wall time in `stepSec` slices. */
      run(sec, stepSec = 0.1) {
        let last = clock.peek();
        for (let i = 0; i < Math.round(sec / stepSec); i++) last = this.step(stepSec);
        return last;
      },
      rewind(sec) {
        wallMs -= sec * 1000;
        return clock.tick();
      },
    };
  };

  // ---- the basics, unchanged from before the ramp existed -------------------
  {
    const f = fake();
    const first = f.clock.tick();
    t.ok('first tick reports dtSec 0, not time-since-page-load', first.dtSec === 0 && first.realDtSec === 0);
    t.ok('tMs starts at 0, NOT at the wall-clock epoch', first.tMs === 0);
    t.ok('frame counter starts at 1', first.frame === 1);

    const second = f.step(0.016);
    t.ok('steady tick: dtSec is the real delta at scale 1', close(second.dtSec, 0.016));
    t.ok('sim time accumulates', close(second.tMs, 16));
    t.ok('wall time accumulates alongside', close(second.realMs, 16));
  }

  {
    const f = fake();
    f.clock.tick();
    const monster = f.step(30); // a background tab / debugger pause
    t.ok('a monster delta clamps to maxDtSec', monster.dtSec === DEFAULT_MAX_DT_SEC);
    t.ok('the WALL delta clamps too (one lurch guard, not two policies)', monster.realDtSec === DEFAULT_MAX_DT_SEC);
  }

  {
    const f = fake();
    f.clock.tick();
    const backwards = f.rewind(5);
    t.ok('a negative delta clamps to 0, never integrates backwards', backwards.dtSec === 0);
  }

  {
    const f = fake({ maxDtSec: 0.02 });
    f.clock.tick();
    t.ok('custom maxDtSec honoured', f.step(0.05).dtSec === 0.02);
  }

  // ---- the pause ramp -------------------------------------------------------
  {
    const f = fake();
    f.clock.tick();
    f.clock.setScaleTarget(0, DEFAULT_PAUSE_RAMP_SEC);

    const half = f.run(2.5);
    t.ok('halfway through the ramp the world runs at half speed', close(half.timeScale, 0.5, 1e-3));
    t.ok('halfway is NOT yet paused', half.paused === false);
    t.ok('a mid-ramp frame still advances sim time, just slower', half.dtSec > 0 && half.dtSec < half.realDtSec);

    const stopped = f.run(2.5);
    t.ok('after five seconds the world is fully stopped', close(stopped.timeScale, 0));
    t.ok('a stopped world reports paused', stopped.paused === true);
    t.ok('a stopped world has zero sim delta', stopped.dtSec === 0);

    const frozenAt = stopped.tMs;
    const stillStopped = f.run(3);
    t.ok('sim time does NOT advance while stopped', close(stillStopped.tMs, frozenAt));
    t.ok('WALL time DOES advance while stopped — the ramp depends on it', stillStopped.realMs > stopped.realMs);
  }

  {
    // The bug this guards: a ramp advanced by its OWN scaled output asymptotes
    // toward the target and, at scale 0, can never come back — dtSec is 0
    // forever, so nothing is left to drive the resume. Wall time must drive it.
    const f = fake();
    f.clock.tick();
    f.clock.setScaleTarget(0, DEFAULT_PAUSE_RAMP_SEC);
    f.run(5);
    t.ok('precondition: fully stopped', f.clock.getScale() === 0);
    f.clock.setScaleTarget(1, DEFAULT_PAUSE_RAMP_SEC);
    const resumed = f.run(5);
    t.ok('a fully stopped world can still resume', close(resumed.timeScale, 1));
    t.ok('a resumed world is not paused', resumed.paused === false);
    t.ok('and its sim delta is real again', close(resumed.dtSec, 0.1));
  }

  {
    // Pause then immediately change your mind. The ramp must restart from where
    // the scale ACTUALLY is, not snap to the stop and ease back up from zero.
    const f = fake();
    f.clock.tick();
    f.clock.setScaleTarget(0, DEFAULT_PAUSE_RAMP_SEC);
    f.run(2.5);
    const midScale = f.clock.getScale();
    f.clock.setScaleTarget(1, DEFAULT_PAUSE_RAMP_SEC);
    const oneFrameLater = f.step(0.016);
    t.ok('re-targeting mid-ramp is continuous — no snap', Math.abs(oneFrameLater.timeScale - midScale) < 0.01);
    t.ok('and it climbs from there', f.run(5).timeScale > midScale);
  }

  {
    const f = fake();
    f.clock.tick();
    f.clock.setScaleTarget(0, DEFAULT_PAUSE_RAMP_SEC);
    f.run(2);
    const before = f.clock.getScale();
    // A caller that re-asserts the same target every frame (the obvious way to
    // wire a `game.paused` poll) must not restart the ramp each time — without
    // the guard this resets the ramp 60×/sec and the world NEVER stops.
    for (let i = 0; i < 10; i++) f.clock.setScaleTarget(0, DEFAULT_PAUSE_RAMP_SEC);
    t.ok('re-asserting the SAME target mid-ramp is a pure no-op', f.clock.getScale() === before);
    const done = f.run(3.2);
    t.ok('and the ramp still completes on schedule', close(done.timeScale, 0));
    // ...but a DELIBERATE re-time still lands.
    const g = fake();
    g.clock.tick();
    g.clock.setScaleTarget(0, DEFAULT_PAUSE_RAMP_SEC);
    g.run(1);
    g.clock.setScaleTarget(0, 0);
    t.ok('a hard stop overrides a five-second ramp already in flight', g.clock.getScale() === 0);
  }

  {
    const f = fake();
    f.clock.tick();
    f.clock.setScaleTarget(0, 0);
    t.ok('a zero-second ramp applies instantly', f.clock.getScale() === 0);
    const stopped = f.step(0.1);
    t.ok('and the very next frame is already frozen', stopped.dtSec === 0 && stopped.paused === true);
  }

  // ---- clamping: nothing may run backwards, nothing may lurch --------------
  {
    const f = fake();
    f.clock.tick();
    f.clock.setScaleTarget(-3, 0);
    t.ok('a negative scale clamps to 0 — the world never runs backwards', f.clock.getScale() === 0);
    f.clock.setScaleTarget(999, 0);
    t.ok('an unbounded fast-forward clamps to 4', f.clock.getScale() === 4);
    f.clock.setScaleTarget(NaN, 0);
    t.ok('a non-finite scale reads as normal speed, never NaN downstream', f.clock.getScale() === 1);
  }

  {
    const f = fake({ scale: 0 });
    const first = f.clock.tick();
    t.ok('a clock CONSTRUCTED stopped starts stopped', first.paused === true && first.timeScale === 0);
  }

  // ---- the snapshot contract ------------------------------------------------
  {
    const f = fake();
    const snap = f.clock.tick();
    t.ok('the snapshot is frozen — a consumer cannot scribble on it', Object.isFrozen(snap));
    t.ok('peek() returns the same frame without advancing', f.clock.peek() === snap);
    t.ok(
      'every documented field is present',
      ['frame', 'tMs', 'dtSec', 'realMs', 'realDtSec', 'timeScale', 'paused'].every((k) => k in snap)
    );
  }
}
