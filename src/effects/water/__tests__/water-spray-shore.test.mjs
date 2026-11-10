/**
 * water-spray-shore.test.mjs — the CPU half of the spray particles (2026-11-06, mmp-7kx.1): hard shore points from a
 * decoded mask, and a frame's births. The author's complaint was flecks moving as one batch — so these pin that births
 * come out each with its own throw, in a count that varies frame to frame, only where the current drives into a face.
 */
import { extractSprayShore, planSprayBirths, sprayWaveImpact, WAVE_IMPACT_MEAN } from '../water-spray-shore.js';

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
  // `tSec` runs a long clock (seed × 0.37 s) so the crests that now decide WHEN a wall throws (2026-11-10) all pass.
  const plan = (dir, speed, seed, spray = 1, extra = {}) =>
    planSprayBirths(shore, {
      dtSec: 1 / 60,
      flowDir: dir,
      flowSpeedPx: speed,
      spray,
      view,
      maxBirths: 600,
      random: seeded(seed),
      tSec: seed * 0.37,
      ...extra,
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
  // 2000 moments: spray is bursty now (waves), so a short sample is mostly quiet spells
  for (let f = 0; f < 2000; f++) {
    slow += plan([1, 0], 35, 5000 + f).length;
    fast += plan([1, 0], 140, 5000 + f).length;
  }
  ok('a faster current throws more spray', fast > slow * 2);
  ok('maxBirths caps a frame', plan([1, 0], 70, 3, 1).length <= 600);

  // WAVES DECIDE WHEN (2026-11-10, mmp-78u.30.7): quiet spells and sudden splats, not an even trickle.
  const timeline = [];
  for (let f = 0; f < 600; f++) {
    timeline.push(
      planSprayBirths(shore, {
        dtSec: 1 / 30,
        flowDir: [1, 0],
        flowSpeedPx: 70,
        spray: 1,
        view,
        maxBirths: 5000,
        random: seeded(9000 + f),
        tSec: f / 30,
      }).length
    );
  }
  const quiet = timeline.filter((n) => n === 0).length;
  const peak = Math.max(...timeline);
  const mean = timeline.reduce((a, b) => a + b, 0) / timeline.length;
  ok(`spray comes in splats: quiet spells (${quiet}/600 frames empty)`, quiet > 120);
  ok(`... and bursts far above the mean (peak ${peak} vs mean ${mean.toFixed(1)})`, peak > mean * 4);
  ok('wind alone (no current) drives spray into a wall it blows at', (() => {
    let n = 0;
    for (let f = 0; f < 2000; f++) n += plan([1, 0], 0, f + 1, 1, { wind01: 0.8, windDir: [1, 0] }).length;
    return n > 2000;
  })());
  ok('wind blowing away from the wall, no current: none', (() => {
    let n = 0;
    for (let f = 0; f < 120; f++) n += plan([1, 0], 0, f + 1, 1, { wind01: 0.8, windDir: [-1, 0] }).length;
    return n === 0;
  })());
  ok('the wave impact averages to its stated mean', (() => {
    let s = 0;
    for (let i = 0; i < 4000; i++) s += sprayWaveImpact(i * 13.7, i * 3.1, i * 0.113, 0.6, 0.8, 60);
    const m = s / 4000;
    return m > WAVE_IMPACT_MEAN * 0.6 && m < WAVE_IMPACT_MEAN * 1.6;
  })());
}
