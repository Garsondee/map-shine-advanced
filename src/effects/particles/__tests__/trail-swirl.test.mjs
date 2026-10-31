/**
 * Node verification for effects/particles/trail-swirl.js — the plain-JS twin of
 * the wind-trail heading curve. The author's 2026-10-31 brief, as checkable
 * claims: a trail runs WITH the wind before and after its swirl, loops are whole
 * turns of differing shape, size and timing, and Swirl variation 0 makes every
 * swirl the same. Walked over many seeds; the TSL copy is checked in the browser.
 */
import {
  planTrailSwirl,
  trailSwirlHeading,
  trailSwirlSpeed,
  trailSizeMuls,
  TRAIL_SWIRL_END_BY,
  TRAIL_SWIRL_MAX_TURNS,
} from '../trail-swirl.js';

const TAU = Math.PI * 2;
/** A deterministic [0,1) sequence (same fract(sin) idiom as the kernel). */
const hashSeq = (seed, n) =>
  Array.from({ length: n }, (_, k) => {
    const x = Math.sin((seed * (2.71 + 1.913 * k) + 4.1 + 7.37 * k) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  });
/** Heading measured from the wind, folded to (−π, π]. */
const offWind = (theta) => Math.atan2(Math.sin(theta), Math.cos(theta));

export function run(t) {
  const { ok } = t;
  const lifeMs = 1550;
  const N = 400;

  for (const [swirl, variation] of [
    [1.2, 0.7],
    [1.2, 1],
    [2, 1],
    [0.4, 0.5],
    [1.95, 0],
  ]) {
    const tag = `swirl ${swirl}, variation ${variation}`;
    let worstStart = 0;
    let worstEnd = 0;
    let reverses = 0;
    let lateLoops = 0;
    let wholeTurns = true;
    let speedOff = 0;
    let speedMin = 1;
    for (let s = 0; s < N; s++) {
      const plan = planTrailSwirl(hashSeq(s, 11), { swirl, variation, lifeMs, sizeLen: 1 });
      worstStart = Math.max(worstStart, Math.abs(trailSwirlHeading(plan, 0)));
      worstEnd = Math.max(worstEnd, Math.abs(offWind(trailSwirlHeading(plan, lifeMs))));
      speedOff = Math.max(speedOff, Math.abs(trailSwirlSpeed(plan, 0) - 1), Math.abs(trailSwirlSpeed(plan, lifeMs) - 1));
      for (let a = 0; a <= lifeMs; a += 25) speedMin = Math.min(speedMin, trailSwirlSpeed(plan, a));
      if (!Number.isInteger(plan.turns)) wholeTurns = false;
      if (plan.startMs + plan.durMs > TRAIL_SWIRL_END_BY * lifeMs + 1e-6) lateLoops++;
      // (A figure-eight turns back by design — its own check is below.)
      if (plan.turns > 0 && !plan.figure8) {
        let prev = 0;
        for (let a = 0; a <= lifeMs; a += 5) {
          const th = trailSwirlHeading(plan, a) * plan.sign;
          if (th < prev - 1e-9) reverses++;
          prev = th;
        }
      }
    }
    ok(`⭐ ${tag}: every trail is born heading along the wind`, worstStart < 1e-9);
    ok(`⭐ ${tag}: every trail leaves its swirl along the wind (worst ${worstEnd.toExponential(1)} rad)`, worstEnd < 1e-6);
    ok(`${tag}: loops are whole turns`, wholeTurns);
    ok(`${tag}: a loop never turns back on itself`, reverses === 0);
    ok(`${tag}: every swirl is finished before the trail fades`, lateLoops === 0);
    ok(`${tag}: trails move at the air's own speed outside the swirl`, speedOff < 1e-12);
    ok(`${tag}: a surge never stalls a trail (slowest ×${speedMin.toFixed(2)})`, speedMin >= 0.55 - 1e-9);
  }

  // Figure-eights: one loop each way, ending on the wind.
  {
    let eights = 0;
    let worst = 0;
    let swingsBoth = true;
    for (let s = 0; s < N; s++) {
      const plan = planTrailSwirl(hashSeq(s, 11), { swirl: 2, variation: 1, lifeMs });
      if (!plan.figure8) continue;
      eights++;
      worst = Math.max(worst, Math.abs(trailSwirlHeading(plan, lifeMs)));
      // The wobble moves WHERE it turns back, so look for the peak, not the middle.
      let peak = 0;
      for (let a = plan.startMs; a <= plan.startMs + plan.durMs; a += 1)
        peak = Math.max(peak, trailSwirlHeading(plan, a) * plan.sign);
      if (peak < TAU * 0.95) swingsBoth = false;
    }
    ok(`⭐ "different shapes": some two-turn loops are figure-eights (${eights})`, eights > N * 0.05);
    ok('a figure-eight ends exactly on the wind (no net turn)', worst < 1e-9);
    ok('a figure-eight really loops out before it loops back', swingsBoth);
  }

  // Swirl 0 = every trail straight, at any variation.
  {
    let maxAbs = 0;
    for (let s = 0; s < N; s++) {
      const plan = planTrailSwirl(hashSeq(s, 11), { swirl: 0, variation: 1, lifeMs });
      for (let a = 0; a <= lifeMs; a += 25) maxAbs = Math.max(maxAbs, Math.abs(trailSwirlHeading(plan, a)));
    }
    ok('swirl 0 keeps every trail straight', maxAbs === 0);
  }

  // Variation 0 = the same swirl for every looper (only the turn direction differs).
  {
    const shapes = new Set();
    for (let s = 0; s < N; s++) {
      const p = planTrailSwirl(hashSeq(s, 11), { swirl: 1.2, variation: 0, lifeMs });
      if (p.turns > 0)
        shapes.add(`${p.turns}|${p.startMs.toFixed(3)}|${p.durMs.toFixed(3)}|${p.wobble}|${p.figure8}|${p.surge}`);
    }
    ok(`variation 0: every looper makes the same loop (${shapes.size} shape)`, shapes.size === 1);
  }

  // ⭐ "they all have the same exact swirl": variation spreads turns, timing, size, shape.
  {
    const turns = new Set();
    const durs = [];
    const starts = [];
    let lopsided = 0;
    let loopers = 0;
    let waves = 0;
    for (let s = 0; s < N; s++) {
      const p = planTrailSwirl(hashSeq(s, 11), { swirl: 1.2, variation: 0.7, lifeMs });
      if (p.turns > 0) {
        loopers++;
        turns.add(p.turns);
        durs.push(p.durMs / p.turns);
        starts.push(p.startMs);
        if (p.wobble > 0.2) lopsided++;
      } else if (p.wave > 0) waves++;
    }
    const spread = (xs) => Math.max(...xs) / Math.min(...xs);
    ok(`⭐ "include loops occasionally": about half the trails loop (${loopers}/${N})`, loopers > N * 0.35 && loopers < N * 0.65);
    ok(`some loops turn once, some more (turn counts ${[...turns].sort().join(',')})`, turns.size >= 2 && Math.max(...turns) <= TRAIL_SWIRL_MAX_TURNS);
    ok(`⭐ loops of different sizes: time per turn spreads ${spread(durs).toFixed(1)}×`, spread(durs) > 3);
    ok(`loops start at different moments (${spread(starts).toFixed(1)}× spread)`, spread(starts) > 1.5);
    ok(`⭐ "less perfect": many loops are lopsided (${lopsided}/${loopers})`, lopsided > loopers * 0.4);
    ok(`non-looping trails get a gentle S-bend (${waves})`, waves > N * 0.3);
  }

  // A loop is a curl, not a lane change: integrate a constant wind through one
  // plan — the path ends back on (near) its own line, well downwind.
  {
    const plan = planTrailSwirl([0.1, 0.5, 0.5, 0.9, 0.5, 0.5, 0, 0, 0, 0.9, 0.5], { swirl: 1, variation: 0, lifeMs });
    let x = 0;
    let y = 0;
    for (let a = 0; a < lifeMs; a += 1) {
      const th = trailSwirlHeading(plan, a);
      x += Math.cos(th);
      y += Math.sin(th);
    }
    const loopLen = plan.durMs; // path length of the loop itself
    ok(`one loop: it ends well downwind of its start (x ${x.toFixed(0)})`, x > lifeMs * 0.5);
    ok(`one loop: a round loop barely shifts the line (y ${y.toFixed(1)} vs loop ${loopLen.toFixed(0)})`, Math.abs(y) < loopLen * 0.25);
  }

  // Sizes: a much wider variety, and none at variation 0.
  {
    const ws = [];
    const ls = [];
    for (let s = 0; s < N; s++) {
      const m = trailSizeMuls(hashSeq(s + 1000, 3), 1);
      ws.push(m.width);
      ls.push(m.length);
    }
    const r = (xs) => Math.max(...xs) / Math.min(...xs);
    ok(`⭐ size variation 1: lengths range ${r(ls).toFixed(1)}×`, r(ls) > 4);
    ok(`size variation 1: widths range ${r(ws).toFixed(1)}×`, r(ws) > 3);
    const z = trailSizeMuls([0.9, 0.1, 0.7], 0);
    ok('size variation 0: every trail the dial size', z.width === 1 && z.length === 1);
  }
}
