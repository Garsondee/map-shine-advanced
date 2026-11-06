/**
 * water-spray-shore.test.mjs — the CPU half of the spray particles (2026-11-06, mmp-7kx.1): hard shore points from a
 * decoded mask, and a frame's births. The author's complaint was flecks moving as one batch — so these pin that births
 * come out each with its own throw, in a count that varies frame to frame, only where the current drives into a face.
 */
import { extractSprayShore, planSprayBirths } from '../water-spray-shore.js';

/** A seeded 0..1 generator (mulberry32), so the planner's draws are repeatable. */
function seeded(s) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function run(t) {
  const { ok } = t;
  // A 400×400 mask: water (255) on the left, a hard wall (0) from x = 250, and a SOFT ramp along the top rows.
  const W = 400;
  const H = 400;
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = x < 250 ? 255 : 0;
      if (y < 60 && x < 250) v = Math.round(255 * (y / 60)); // a soft painted shallows ramp
      data[y * W + x] = v;
    }
  }
  const rect = { minX: 1000, minY: 2000, maxX: 1400, maxY: 2400 };
  const shore = extractSprayShore(data, W, H, rect);
  ok('the hard wall yields shore points', shore.count > 50);
  const xs = [];
  let normalsRight = true;
  for (let i = 0; i < shore.count; i++) {
    xs.push(shore.points[i * 4]);
    if (shore.points[i * 4 + 2] < 0.9) normalsRight = false;
  }
  ok(
    'every point sits on the hard wall (world x ≈ 1250), none on the soft ramp',
    xs.every((x) => Math.abs(x - 1250) < 4)
  );
  ok('normals point from the water into the wall (+x)', normalsRight);

  const view = { minX: 900, minY: 1900, maxX: 1500, maxY: 2500 };
  const plan = (dir, speed, seed, spray = 1) =>
    planSprayBirths(shore, {
      dtSec: 1 / 60,
      flowDir: dir,
      flowSpeedPx: speed,
      spray,
      view,
      maxBirths: 600,
      random: seeded(seed),
    });

  const into = [];
  for (let f = 0; f < 120; f++) into.push(...plan([1, 0], 70, f + 1));
  ok('a current driving into the wall throws flecks', into.length > 50);
  ok('a current running AWAY from the wall throws none', plan([-1, 0], 70, 7).length === 0);
  ok('still water throws none', plan([1, 0], 0, 7).length === 0);
  ok('spray 0 throws none', plan([1, 0], 70, 7, 0).length === 0);

  const counts = [];
  for (let f = 0; f < 60; f++) counts.push(plan([1, 0], 70, 1000 + f).length);
  ok('the count per frame varies (no fixed batch)', new Set(counts).size > 1);

  // every fleck its own throw: directions, speeds, air times, arcs and sizes all spread
  const spread = (arr) => Math.max(...arr) - Math.min(...arr);
  const ang = into.map((b) => Math.atan2(b.vy, b.vx));
  const spd = into.map((b) => Math.hypot(b.vx, b.vy));
  ok('directions spread over a wide fan (> 120°)', spread(ang) > (120 * Math.PI) / 180);
  ok(
    'every fleck is thrown back off the face (vx < 0)',
    into.every((b) => b.vx < 0.0001 || Math.abs(b.vy) > b.vx)
  );
  ok('speeds spread (> 80 px/s range)', spread(spd) > 80);
  ok('air times spread (> 0.4 s range)', spread(into.map((b) => b.airSec)) > 0.4);
  ok('arc heights spread (> 15 px range)', spread(into.map((b) => b.apexPx)) > 15);
  ok('sizes spread (> 0.5 px range)', spread(into.map((b) => b.sizePx)) > 0.5);
  ok(
    'no two flecks share a throw (all distinct velocities)',
    new Set(into.map((b) => `${b.vx.toFixed(3)},${b.vy.toFixed(3)}`)).size === into.length
  );

  // a faster current throws more
  let slow = 0;
  let fast = 0;
  for (let f = 0; f < 120; f++) {
    slow += plan([1, 0], 35, 5000 + f).length;
    fast += plan([1, 0], 140, 5000 + f).length;
  }
  ok('a faster current throws more spray', fast > slow * 2);
  ok('maxBirths caps a frame', plan([1, 0], 70, 3, 1).length <= 600);
}
