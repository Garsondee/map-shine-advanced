/**
 * The ONE CLOCK. Proven with an injected fake time source — no waiting, no
 * flakes, and the tab-background lurch (the giant-delta class V2 fought
 * per-effect) is demonstrated clamped at the source.
 */
import { makeFrameClock, DEFAULT_MAX_DT_SEC } from '../../core/frame-clock.js';

export function run(t) {
  const fakeNow = (times) => {
    let i = 0;
    return () => times[Math.min(i++, times.length - 1)];
  };

  {
    const clock = makeFrameClock({ now: fakeNow([1000, 1016, 1033]) });
    const f1 = clock.tick();
    t.ok('first tick: dt is 0, not time-since-page-load', f1.dtSec === 0 && f1.frame === 1);
    const f2 = clock.tick();
    t.ok('second tick: real delta', Math.abs(f2.dtSec - 0.016) < 1e-9 && f2.frame === 2);
    t.ok('snapshots are frozen', Object.isFrozen(f1) && Object.isFrozen(f2));
    t.ok(
      'peek returns the same frozen frame without advancing',
      clock.peek() === clock.peek() && clock.peek().frame === 2
    );
  }

  {
    // The background-tab lurch: 5 seconds pass while throttled. Every V2 sim
    // integrated that monster delta; here it clamps at the source, once.
    const clock = makeFrameClock({ now: fakeNow([0, 5000]) });
    clock.tick();
    const lurch = clock.tick();
    t.ok(`a 5s gap clamps to maxDt (${DEFAULT_MAX_DT_SEC}s)`, lurch.dtSec === DEFAULT_MAX_DT_SEC);
  }

  {
    // A backwards clock (adjustment/wrap) must never integrate negative time.
    const clock = makeFrameClock({ now: fakeNow([1000, 900]) });
    clock.tick();
    t.ok('negative delta clamps to 0, never reverses', clock.tick().dtSec === 0);
  }

  {
    const clock = makeFrameClock({ now: fakeNow([0, 50]), maxDtSec: 0.02 });
    clock.tick();
    t.ok('custom maxDtSec honoured', clock.tick().dtSec === 0.02);
  }
}
