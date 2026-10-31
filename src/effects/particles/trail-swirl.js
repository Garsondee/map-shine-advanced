/**
 * TRAIL SWIRL — the heading curve a wind trail turns through as it lives.
 *
 * The author, 2026-10-31: *"the swirl is good but the end point leaves the wind
 * trail headed in a direction which ISN'T in line with the wind. Rethink the way
 * we do swirls to make them include loops occasionally of different shapes and
 * sizes but that before and after the wind trail should follow the actual wind
 * direction. Include a much wider variety of trail sizes and make the swirls
 * less perfect."*
 *
 * WHAT WAS WRONG: the old curl turned at `|v| / R` until it had turned
 * `swirl × 2π`, then carried on straight. At swirl 1.2 that is 432°, so every
 * looping trail left its loop 72° off the wind and flew that way until it died.
 * Any swirl that is not a whole number did the same.
 *
 * THE MODEL NOW: a trail's heading offset from the air is a FUNCTION OF ITS AGE,
 * fixed at birth by a few seed hashes:
 *
 *     θ(age) = sign · 2π · n · g(u),   u = (age − start) / duration ∈ [0, 1]
 *
 * with `n` a WHOLE number of turns, and `g` rising monotonically from 0 to
 * exactly 1. So before the loop θ = 0 and after it θ = 2πn: a trail rides the
 * real wind both sides of its loop, whatever the loop looked like. `g` is
 *
 *     s = smoothstep(u)                               (turn eases in and out)
 *     g = s − a · (sin(2πk·s + φ) − sin φ) / (2πk)    (a < 1, k a whole number)
 *
 * The ease makes the turn rate zero at both ends (the stroke glides in and out
 * of the loop, no kink); the wobble term speeds the turn up and slows it down
 * around the loop — slow turning draws a wide arc, fast turning a tight one — so
 * loops come out egg-, teardrop- and kidney-shaped instead of circles. It never
 * reverses (`g' = s'·(1 − a·cos(…)) ≥ 0` for a < 1) and it lands on exactly 1
 * (`sin(2πk + φ) = sin φ` for whole k), so the exit stays true.
 *
 * Two more shapes, both still ending on the wind: some two-turn loops FOLD into
 * a figure-eight (one loop out, one back: θ = 2π·(1 − |2g − 1|), 0 → 2π → 0),
 * and the head SURGES through a loop (speed × 1 ± up to 0.45 at its middle,
 * exactly 1 outside it): slowed, the loop ties a tight knot; hurried, it
 * sweeps wide. (The first cut had only the wobble; in the lab's long exposure
 * the loops still read as near-circles.)
 *
 * Trails that do not loop get a gentle S (θ = A·sin(2π·s): out one way, back the
 * other, back to the wind) once Swirl variation is up; at variation 0 they run
 * straight, as before. Loop SIZE is speed × time: a loop that takes 0.3 s at
 * 15 m/s is ~0.7 m across, so faster air draws bigger loops, and the variation
 * spreads the time per turn ~6× between the quickest and the laziest.
 *
 * TWO COPIES, ONE SHAPE: `planTrailSwirl` + `trailSwirlHeading` +
 * `trailSwirlSpeed` are the plain-JS twin (Node-tested: start/end alignment,
 * monotone turn, the fit inside a life); `buildTrailSwirlNodes` is the same arithmetic as TSL for the ribbon
 * engine's update kernel (`gust-runtime.js`). Change both together — the test
 * file walks the twin through the same constants exported here.
 *
 * @module effects/particles/trail-swirl
 */

/** Share of trails that loop when Swirl is at 1 or more (Swirl below 1 scales it). */
export const TRAIL_SWIRL_LOOP_SHARE = 0.5;
/** Most whole turns one loop can make. */
export const TRAIL_SWIRL_MAX_TURNS = 3;
/** Seconds one turn takes at variation 0 (the variation spreads it ×2^±1.3). */
export const TRAIL_SWIRL_TURN_SEC = 0.3;
/** log2 spread of the time per turn at variation 1 (0.3 s → 0.12 … 0.74 s). */
export const TRAIL_SWIRL_TURN_SPREAD = 1.3;
/** Where in its life a loop starts, at variation 0, as a fraction of the life
 *  (after the ~0.45 s fade-in, so the run-in along the wind shows). */
export const TRAIL_SWIRL_START = 0.28;
/** ± spread of the start at variation 1. */
export const TRAIL_SWIRL_START_SPREAD = 0.12;
/** A loop must be finished by this fraction of the life, so the run-out along
 *  the wind shows before the fade thins it (0.88 in the first cut left the
 *  run-out of late loops too faint to read). */
export const TRAIL_SWIRL_END_BY = 0.74;
/** Longest a swirl may take, as a fraction of the life. */
export const TRAIL_SWIRL_MAX_DUR = 0.55;
/** Largest wobble amplitude `a` (must stay < 1 for the turn never to reverse). */
export const TRAIL_SWIRL_MAX_WOBBLE = 0.92;
/** Share of two-turn loops that become a figure-eight, at variation 1. */
export const TRAIL_SWIRL_FIGURE8_SHARE = 0.5;
/** Largest speed change through a loop (± — slowing ties a knot, speeding sweeps wide). */
export const TRAIL_SWIRL_MAX_SURGE = 0.45;
/** Largest S-bend heading swing of a non-looping trail, radians (~34°). */
export const TRAIL_SWIRL_MAX_WAVE = 0.6;
/** log2 spread of trail size at Size variation 1 (×0.41 … ×2.46). */
export const TRAIL_SIZE_SPREAD = 1.3;

const TAU = Math.PI * 2;

/** smoothstep(0, 1, u) for u already in [0, 1]. */
const ease = (u) => u * u * (3 - 2 * u);

/**
 * Plan one trail's swirl from its hashes. `h` is an array of at least 11 values
 * in [0, 1) (the kernel's own seed hashes, in this order).
 * @param {number[]} h
 * @param {{swirl:number, variation:number, lifeMs:number, sizeLen?:number}} o
 *   `sizeLen` — the trail's own length multiplier ({@link trailSizeMuls}); a
 *   long stroke gets a lazier, bigger loop (time per turn × sizeLen^0.6).
 */
export function planTrailSwirl(h, { swirl, variation, lifeMs, sizeLen = 1 }) {
  const S = Math.max(0, swirl);
  const v = Math.min(1, Math.max(0, variation));
  const sign = h[3] > 0.5 ? 1 : -1;
  const loops = h[0] < TRAIL_SWIRL_LOOP_SHARE * Math.min(1, S);
  // Mean turns = Swirl past 1, spread ±80% by the variation, rounded stochastically
  // only as far as the variation allows (variation 0 = every looper the same).
  const mean = Math.max(1, S) * (1 + v * 0.8 * (2 * h[1] - 1));
  const turns = loops ? Math.min(TRAIL_SWIRL_MAX_TURNS, Math.max(1, Math.floor(mean + 0.5 + v * (h[2] - 0.5)))) : 0;
  const turnSec = TRAIL_SWIRL_TURN_SEC * 2 ** (v * TRAIL_SWIRL_TURN_SPREAD * (2 * h[4] - 1)) * sizeLen ** 0.6;
  let durMs = 1000 * turnSec * (loops ? turns ** 0.8 : 1.5);
  durMs = Math.min(durMs, lifeMs * TRAIL_SWIRL_MAX_DUR);
  const startFrac = TRAIL_SWIRL_START + v * TRAIL_SWIRL_START_SPREAD * (2 * h[5] - 1);
  const startMs = Math.max(0, Math.min(startFrac * lifeMs, TRAIL_SWIRL_END_BY * lifeMs - durMs));
  // Lopsided turn: most loops get a strong wobble at a low harmonic (one lobe =
  // egg/teardrop); a few a higher one (a bumpy curl).
  const wobble = v * TRAIL_SWIRL_MAX_WOBBLE * (0.35 + 0.65 * h[6]);
  const harmonic = 1 + Math.floor(h[7] * h[7] * 3);
  const phase = TAU * h[8];
  const wave = loops ? 0 : Math.min(1, S) * v * TRAIL_SWIRL_MAX_WAVE * (0.3 + 0.7 * h[6]);
  const figure8 = turns === 2 && h[9] < TRAIL_SWIRL_FIGURE8_SHARE * v;
  const surge = v * TRAIL_SWIRL_MAX_SURGE * (2 * h[10] - 1);
  return { sign, turns, startMs, durMs, wobble, harmonic, phase, wave, figure8, surge };
}

/** Where a planned trail is through its swirl, eased: 0 before, 1 after. */
function swirlProgress(plan, ageMs) {
  const u = Math.min(1, Math.max(0, (ageMs - plan.startMs) / Math.max(1, plan.durMs)));
  return { u, s: ease(u) };
}

/**
 * The speed multiplier a planned trail moves at, `ageMs` into its life: 1
 * outside the swirl, `1 + surge` at its middle (a slowed head ties a tight
 * knot, a hurried one sweeps a wide loop). Never below 0.55.
 */
export function trailSwirlSpeed(plan, ageMs) {
  const { u } = swirlProgress(plan, ageMs);
  const bell = Math.sin(Math.PI * u) ** 2;
  return 1 + plan.surge * bell;
}

/**
 * The heading offset (radians, + = counter-clockwise) a planned trail has at
 * `ageMs`. Exactly 0 before its loop, exactly `sign·2π·turns` after it.
 * @param {ReturnType<typeof planTrailSwirl>} plan
 * @param {number} ageMs
 */
export function trailSwirlHeading(plan, ageMs) {
  const { s } = swirlProgress(plan, ageMs);
  const k = plan.harmonic;
  const g = s - (plan.wobble * (Math.sin(TAU * k * s + plan.phase) - Math.sin(plan.phase))) / (TAU * k);
  // A figure-eight folds the two turns: one loop out, one loop back (0 → 2π → 0).
  const turned = plan.figure8 ? 1 - Math.abs(2 * g - 1) : plan.turns * g;
  return plan.sign * (TAU * turned + plan.wave * Math.sin(TAU * s));
}

/**
 * A trail's size multipliers from two hashes: one shared SIZE (big trails are
 * both longer and fatter) plus a little independent jitter on each.
 * @param {number[]} h - [size, widthJitter, lengthJitter] in [0, 1).
 * @param {number} sizeVariation - 0 = every trail the dial's size, 1 = ×0.41…×2.46.
 * @returns {{width:number, length:number}}
 */
export function trailSizeMuls(h, sizeVariation) {
  const sv = Math.min(1, Math.max(0, sizeVariation));
  const size = 2 ** (sv * TRAIL_SIZE_SPREAD * (2 * h[0] - 1));
  return {
    width: size ** 0.75 * (1 + sv * 0.25 * (2 * h[1] - 1)),
    length: size * (1 + sv * 0.3 * (2 * h[2] - 1)),
  };
}

/**
 * The TSL twin of {@link trailSizeMuls}. `hash(salt)` returns this trail's
 * seed hash for a salt (the kernel's own `hash11(seed·a + b)`).
 */
export function buildTrailSizeNodes(TSL, { hash, uSizeVar }) {
  const { float, pow } = TSL;
  const sv = uSizeVar.clamp(float(0), float(1));
  const size = pow(float(2), sv.mul(float(TRAIL_SIZE_SPREAD)).mul(hash(0).mul(float(2)).sub(float(1))));
  const width = pow(size, float(0.75)).mul(float(1).add(sv.mul(float(0.25)).mul(hash(1).mul(float(2)).sub(float(1)))));
  const length = size.mul(float(1).add(sv.mul(float(0.3)).mul(hash(2).mul(float(2)).sub(float(1)))));
  return { width, length };
}

/**
 * The TSL twin of {@link planTrailSwirl} + {@link trailSwirlHeading} +
 * {@link trailSwirlSpeed}: this trail's heading offset (`theta`, radians) and
 * speed multiplier (`speed`) at `ageMs`.
 * @param {*} TSL
 * @param {{hash:(salt:number)=>*, uSwirl:*, uSwirlVar:*, lifeMs:*, ageMs:*, sizeLen:*}} o
 * @returns {{theta:*, speed:*}}
 */
export function buildTrailSwirlNodes(TSL, { hash, uSwirl, uSwirlVar, lifeMs, ageMs, sizeLen }) {
  const { float, pow, sin } = TSL;
  const one = float(1);
  const two = float(2);
  const S = uSwirl.max(float(0));
  const v = uSwirlVar.clamp(float(0), one);
  const h = (k) => hash(k);
  const centred = (k) => h(k).mul(two).sub(one); // [-1, 1)
  const sign = h(3).greaterThan(float(0.5)).select(one, float(-1));
  const loops = h(0).lessThan(float(TRAIL_SWIRL_LOOP_SHARE).mul(S.min(one)));
  const mean = S.max(one).mul(one.add(v.mul(float(0.8)).mul(centred(1))));
  const turnsRaw = mean.add(float(0.5)).add(v.mul(h(2).sub(float(0.5)))).floor().clamp(one, float(TRAIL_SWIRL_MAX_TURNS));
  const turns = loops.select(turnsRaw, float(0));
  const turnSec = float(TRAIL_SWIRL_TURN_SEC)
    .mul(pow(two, v.mul(float(TRAIL_SWIRL_TURN_SPREAD)).mul(centred(4))))
    .mul(pow(sizeLen.max(float(1e-3)), float(0.6)));
  const durMs = float(1000)
    .mul(turnSec)
    .mul(loops.select(pow(turnsRaw, float(0.8)), float(1.5)))
    .min(lifeMs.mul(float(TRAIL_SWIRL_MAX_DUR)));
  const startFrac = float(TRAIL_SWIRL_START).add(v.mul(float(TRAIL_SWIRL_START_SPREAD)).mul(centred(5)));
  const startMs = startFrac.mul(lifeMs).min(lifeMs.mul(float(TRAIL_SWIRL_END_BY)).sub(durMs)).max(float(0));
  const wobble = v.mul(float(TRAIL_SWIRL_MAX_WOBBLE)).mul(float(0.35).add(float(0.65).mul(h(6))));
  const harmonic = one.add(h(7).mul(h(7)).mul(float(3)).floor());
  const phase = float(TAU).mul(h(8));
  const wave = loops.select(
    float(0),
    S.min(one).mul(v).mul(float(TRAIL_SWIRL_MAX_WAVE)).mul(float(0.3).add(float(0.7).mul(h(6))))
  );
  const figure8 = turns.equal(two).and(h(9).lessThan(v.mul(float(TRAIL_SWIRL_FIGURE8_SHARE))));
  const surge = v.mul(float(TRAIL_SWIRL_MAX_SURGE)).mul(centred(10));

  const u = ageMs.sub(startMs).div(durMs.max(one)).clamp(float(0), one);
  const s = u.mul(u).mul(float(3).sub(u.mul(two)));
  const twoPiK = float(TAU).mul(harmonic);
  const g = s.sub(wobble.mul(sin(twoPiK.mul(s).add(phase)).sub(sin(phase))).div(twoPiK));
  const turned = figure8.select(one.sub(g.mul(two).sub(one).abs()), turns.mul(g));
  const theta = sign.mul(float(TAU).mul(turned).add(wave.mul(sin(float(TAU).mul(s)))));
  const bell = sin(float(Math.PI).mul(u));
  const speed = one.add(surge.mul(bell.mul(bell)));
  return { theta, speed };
}
