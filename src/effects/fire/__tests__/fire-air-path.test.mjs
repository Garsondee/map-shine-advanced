/**
 * fire-air-path.test.mjs — the path a fire's air has taken (mmp-9un.5): smoke reads where ITS air went since it was born.
 */
import { createAirPath } from '../fire-air-path.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

export function run(t) {
  // steady air: the sums grow in a straight line, and any past moment reads back exactly
  {
    const p = createAirPath();
    for (let k = 0; k <= 100; k++) p.advance(100 + k * 0.1, 2, -1, 0.5, 0.3);
    const h = p.head;
    const past = p.at(106);
    t.ok(
      `steady air carries the path in a straight line, slowed by the rise rate (W = ${h.wx.toFixed(3)}, ${h.wy.toFixed(3)} m over 10 s at 2,-1 m/s x 0.5)`,
      near(h.wx, 10, 1e-9) && near(h.wy, -5, 1e-9) && near(h.R, 5, 1e-9)
    );
    t.ok(
      'any moment of the history reads back on that line (4 s ago: 4 m less)',
      near(past.wx, h.wx - 4, 1e-9) && near(past.wy, h.wy + 2, 1e-9) && near(past.R, h.R - 2, 1e-9)
    );
    t.ok(
      'the heading and the lean are remembered with each moment',
      near(past.dirX, 2 / Math.hypot(2, 1), 1e-9) &&
        near(past.dirY, -1 / Math.hypot(2, 1), 1e-9) &&
        near(past.lean01, 0.3)
    );
  }
  // before the history: steady air at the oldest rate, so a puff older than the history still has a sensible path
  {
    const p = createAirPath({ historySec: 5, sampleSec: 0.2 });
    for (let k = 0; k <= 200; k++) p.advance(k * 0.1, 3, 0, 1, 0);
    const oldest = p.at(-1e9);
    const back = p.at(0.5);
    t.ok(
      `a short history keeps only its window (${p.length} samples for 5 s) and extrapolates before it at the oldest rate`,
      p.length <= 28 && near(back.wx, 1.5, 1e-9) && oldest.wx < -1e8
    );
  }
  // a turn: the sums bend at the moment the air turned, and only after it
  {
    const p = createAirPath();
    for (let k = 0; k <= 100; k++) {
      const tt = k * 0.1;
      p.advance(tt, tt < 5 ? 4 : 0, tt < 5 ? 0 : 4, 1, 0);
    }
    const before = p.at(4);
    const after = p.at(8);
    t.ok(
      `the path bends where the air turned (4 s: ${before.wx.toFixed(2)},${before.wy.toFixed(2)}; 8 s: ${after.wx.toFixed(2)},${after.wy.toFixed(2)})`,
      near(before.wx, 16, 0.05) && near(before.wy, 0, 1e-9) && near(after.wx, 20, 0.45) && near(after.wy, 12, 0.45)
    );
  }
  // a clock that steps back or jumps starts a fresh path (a reload, a seek) instead of smearing the smoke
  {
    const p = createAirPath();
    for (let k = 0; k <= 50; k++) p.advance(10 + k * 0.1, 5, 0, 1, 0);
    p.advance(60, 5, 0, 1, 0);
    t.ok(`a jump of more than 5 s starts a fresh path (W = ${p.head.wx})`, p.head.wx === 0 && p.length === 1);
    p.advance(59, 5, 0, 1, 0);
    t.ok('a clock that steps back starts a fresh path too', p.head.wx === 0 && p.head.t === 59);
  }
  // a long session at a gale keeps the sums small without moving any difference
  {
    const p = createAirPath();
    for (let k = 0; k <= 600; k++) p.advance(k * 0.05, 70000, 0, 1, 0);
    const d = p.head.wx - p.at(29).wx;
    t.ok(
      `the sums are rebased before they lose precision; differences are kept (${d.toFixed(1)} m in the last second)`,
      Math.abs(p.head.wx) < 1e6 + 1e5 && near(d, 70000, 1)
    );
  }
  // still air: no heading, and the path stays put
  {
    const p = createAirPath();
    for (let k = 0; k <= 30; k++) p.advance(k * 0.1, 0, 0, 1, 0);
    t.ok(
      'still air leaves the path where it was, with no heading',
      p.head.wx === 0 && p.head.dirX === 0 && p.head.R > 2.9
    );
  }
}
