/**
 * MAGGOT BODY — a larva drawn from arithmetic, wriggling because its SHAPE is a
 * function of time, not because a sprite was flipped.
 *
 * Pure TSL node-builders, no allocation, no state. Two halves, split by WHERE they
 * run, because that is what makes a thousand wriggling maggots cheap:
 *
 *   • {@link buildMaggotRig} runs in the VERTEX stage, once per maggot (four times,
 *     in fact, for the quad's four corners): it bends the body into its pose for
 *     this instant — nine points down the spine and a radius at each — and hands
 *     them to the fragment stage as varyings.
 *   • {@link buildMaggotBody} runs per PIXEL: it knows nothing about waves, only the
 *     nine points, and draws a tapered tube through them.
 *
 * Putting the `sin`s in the rig instead of the pixel shader is the whole trick: the
 * expensive, time-varying part is evaluated per animal, the cheap geometric part per
 * pixel. (The fly's `fly-pose.js` is the same split.)
 *
 * ============================================================================
 * HOW A WORM WRIGGLES — TWO WAVES, ONE CONSTRAINT
 * ============================================================================
 *
 * 1. THE BEND. A transverse wave runs along the spine: each point is pushed
 *    sideways by `A·sin(2π·κ·s − ωt)`, with `s` the position along the body. Two
 *    such waves at unrelated wavelengths and speeds are added (a 0.85 and a 1.9
 *    wavelength per body), so the motion never settles into the obviously periodic
 *    snake of a single sine.
 * 2. THE SQUEEZE. A longitudinal wave of CONTRACTION runs along it: segments take
 *    turns shortening (and fattening) and stretching (and thinning) — the
 *    peristalsis that actually moves a legless animal. It is a modulation of each
 *    segment's length and radius, travelling the other way.
 * 3. THE CONSTRAINT: a worm does not stretch when it bends. The segment lengths are
 *    fixed first (squeeze wave included), the sideways offsets second, and each
 *    segment's FORWARD step is then `√(ℓ² − Δy²)` — so a body that curls into an S
 *    gets visibly SHORTER end to end, exactly as a real one does, instead of the
 *    rubber-band lengthening a naive "offset the points" rig gives.
 *
 * ⚠️ EVERY TIER FLAG IS A JS `if` THAT DECIDES WHICH NODES ARE BUILT.
 *
 * @module effects/critters/maggot-body
 */
import { coverage, stroke, layer, over } from './critter-sdf.js';

const TAU = Math.PI * 2;

/** Capsules down the body; the rig has one more POINT than this. */
export const MAGGOT_SEGMENTS = 8;
/** Half-width at the fattest point, in body lengths (a maggot is about five times as long as it is wide). */
const R_MAX = 0.105;
/**
 * Radius profile head → tail, fraction of {@link R_MAX}: a pointed snout, a swelling
 * body, and a blunt truncated tail (a maggot's rear is not tapered — it ends in a
 * flat plate with two breathing holes).
 */
const PROFILE = [0.2, 0.52, 0.76, 0.92, 1.0, 1.0, 0.96, 0.9, 0.8];
/** Skin grooves along the body — real larvae have eleven visible segments. */
const GROOVES = 11;
/**
 * The rates, as multiples of the stored wave phase, at which the rig reads it: the first lateral wave and
 * the squeeze at 1×, the second lateral wave at 1.37×. (The brain adds a 0.5× sway to the crawl heading.)
 * The brain wraps the phase at a period every one of these completes whole turns over, so a wrap leaves no
 * seam — `maggot-brain.js#WAVE_PERIOD` says why, and a Node test holds the two files together.
 */
export const WAVE_RATES = Object.freeze([1, 1.37]);
const SECOND_WAVE_RATE = WAVE_RATES[1];

/**
 * The spine for this instant.
 *
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.wave - float node: accumulated wave phase, radians (`custom.y`).
 * @param {*} a.excite - float node 0..1: how worked-up it is (`custom.z`).
 * @param {*} a.wriggle - float node: the author's wriggle multiplier.
 * @param {*} a.seed01 - float node: per-maggot random.
 * @returns {{points: Array<*>}} nine vec3 nodes, (x, y, radius) in body lengths, head first,
 *   +x toward the head, centred on the body's centroid.
 */
export function buildMaggotRig(TSL, { wave, excite, wriggle, seed01 }) {
  const { float, vec3, sin, sqrt, max, min } = TSL;
  const N = MAGGOT_SEGMENTS;
  const phi = seed01.mul(TAU);

  // sideways amplitude: always a little, much more when worked up, scaled by the author
  const amp = min(float(0.2), float(0.04).add(excite.mul(0.075)).mul(wriggle));
  // squeeze depth follows excitement the same way
  const squeeze = float(0.06)
    .add(excite.mul(0.12))
    .mul(min(wriggle, float(1.5)));

  // lateral offsets at the nine points
  const ys = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const env = 0.55 + 0.45 * s;
    const w1 = sin(
      wave
        .negate()
        .add(phi)
        .add(TAU * 0.85 * s)
    );
    const w2 = sin(
      wave
        .mul(SECOND_WAVE_RATE)
        .negate()
        .add(phi.mul(2.1))
        .add(TAU * 1.9 * s)
    );
    ys.push(amp.mul(env).mul(w1.mul(0.7).add(w2.mul(0.3))));
  }

  // segment lengths: the squeeze wave, normalised so the body keeps its length
  const raw = [];
  let sum = float(0);
  for (let j = 0; j < N; j++) {
    const sMid = (j + 0.5) / N;
    const r = float(1).add(squeeze.mul(sin(wave.add(TAU * 1.25 * sMid))));
    raw.push(r);
    sum = sum.add(r);
  }

  // forward steps that preserve each segment's length under the sideways offsets
  const xs = [float(0)];
  for (let j = 0; j < N; j++) {
    const len = raw[j].div(sum);
    const dy = ys[j + 1].sub(ys[j]);
    const dx = sqrt(max(len.mul(len).sub(dy.mul(dy)), len.mul(len).mul(0.04)));
    xs.push(xs[j].sub(dx));
  }
  let meanX = float(0);
  for (let i = 0; i <= N; i++) meanX = meanX.add(xs[i]);
  meanX = meanX.div(N + 1);

  const points = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    // where the squeeze wave is thin the body is long, and vice versa
    const fat = float(1).sub(squeeze.mul(0.9).mul(sin(wave.add(TAU * 1.25 * s))));
    points.push(vec3(xs[i].sub(meanX), ys[i], float(R_MAX * PROFILE[i]).mul(fat)));
  }
  return { points };
}

/**
 * One pixel of a maggot.
 *
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.p - vec2 node: this pixel in body lengths, +x toward the head.
 * @param {*} a.aa - float node: one pixel in body lengths (> 0).
 * @param {Array<*>} a.points - the rig's nine vec3 nodes (varyings).
 * @param {*} a.lightLocal - vec2 node: unit light direction in body space.
 * @param {*} a.colour - vec3 node: the author's maggot colour (sRGB).
 * @param {*} a.seed01 - float node.
 * @param {object} a.plan - `critterTierPlan('fly', n)` (maggots follow the fly ladder).
 * @returns {{rgb: *, alpha: *}} straight sRGB colour and alpha.
 */
export function buildMaggotBody(TSL, { p, aa, points, lightLocal, colour, seed01, plan }) {
  const { float, vec2, vec3, select, clamp, mix, smoothstep, length, dot, sqrt, max, min, pow, fract, normalize } = TSL;
  const N = MAGGOT_SEGMENTS;
  const k = (a, b, x) => smoothstep(float(a), float(b), x);

  // nearest point on the tapered tube: the union of linearly-tapered capsules
  let best = float(1e3);
  let bestT = float(0);
  let bestOff = vec2(0, 0);
  let bestR = float(R_MAX);
  for (let j = 0; j < N; j++) {
    const a = vec2(points[j].x, points[j].y);
    const b = vec2(points[j + 1].x, points[j + 1].y);
    const pa = p.sub(a);
    const ba = b.sub(a);
    const h = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-8)), 0, 1);
    const off = pa.sub(ba.mul(h));
    const r = mix(points[j].z, points[j + 1].z, h);
    const d = length(off).sub(r);
    const nearer = d.lessThan(best);
    best = select(nearer, d, best);
    bestT = select(nearer, h.add(j).div(N), bestT);
    bestOff = select(nearer, off, bestOff);
    bestR = select(nearer, r, bestR);
  }

  // a hemispherical normal across the tube
  const dAxis = max(length(bestOff), 1e-5);
  const across = min(dAxis.div(max(bestR, 1e-4)), float(1));
  const nz = sqrt(max(float(1).sub(across.mul(across)), 0));
  const n2 = bestOff.div(dAxis).mul(across);
  const n = vec3(n2.x, n2.y, nz);
  const L3 = normalize(vec3(lightLocal.x.mul(0.6), lightLocal.y.mul(0.6), float(0.75)));
  const H3 = normalize(L3.add(vec3(0, 0, 1)));
  // skin is translucent: wrap the light around the form so the shadow side is never black
  const wrap = clamp(dot(n, L3).add(0.45).div(1.45), 0, 1);
  const spec = pow(max(dot(n, H3), 0), 26);

  // an individual's tint and the author's colour
  const skin = colour.mul(float(0.92).add(seed01.mul(0.16)));
  let rgb = skin.mul(float(0.5).add(wrap.mul(0.62)));
  // light scatters through the skin: warm at the thin rim
  rgb = rgb.add(
    vec3(1.0, 0.82, 0.55)
      .mul(k(0.55, 1.0, across))
      .mul(0.07)
      .mul(wrap)
  );
  // grooves between the segments, deeper toward the tail
  const band = fract(bestT.mul(GROOVES));
  const edge = min(band, float(1).sub(band));
  const groove = float(1).sub(k(0, 0.11, edge));
  rgb = rgb.mul(float(1).sub(groove.mul(float(0.05).add(bestT.mul(0.08)))));
  // the dark gut line, seen through the skin along the back
  const gut = float(1)
    .sub(k(0, 0.42, across))
    .mul(k(0.16, 0.34, bestT))
    .mul(float(1).sub(k(0.86, 0.98, bestT)));
  rgb = mix(rgb, skin.mul(vec3(0.62, 0.52, 0.4)), gut.mul(0.34));
  if (plan.sheen) rgb = rgb.add(vec3(1, 0.97, 0.9).mul(spec).mul(0.5));
  else rgb = rgb.add(vec3(1, 0.97, 0.9).mul(spec).mul(0.18));

  let stack = layer(TSL, rgb, coverage(TSL, best, aa));

  if (plan.veins) {
    // mouth hooks at the snout and the two breathing holes on the tail plate — specks, kept steady by the stroke's width floor
    const snout = vec2(points[0].x, points[0].y);
    const hooks = stroke(TSL, length(p.sub(snout.add(vec2(0.012, 0)))), 0.016, aa);
    const tail = vec2(points[N].x, points[N].y);
    const holeA = stroke(TSL, length(p.sub(tail.add(vec2(0.0, 0.03)))), 0.012, aa);
    const holeB = stroke(TSL, length(p.sub(tail.add(vec2(0.0, -0.03)))), 0.012, aa);
    const dots = max(hooks, max(holeA, holeB));
    stack = over(TSL, layer(TSL, vec3(0.1, 0.07, 0.04), dots.mul(0.85)), stack);
  }

  // a soft contact shadow where the body presses on the ground, UNDER the body — free:
  // the body's own distance, widened, is already in hand
  const contact = float(1)
    .sub(k(0, 0.085, max(best, float(0))))
    .mul(0.34);
  stack = over(TSL, stack, layer(TSL, vec3(0.02, 0.015, 0.01), contact));

  const alpha = stack.a;
  return { rgb: stack.c.div(max(alpha, 1e-5)), alpha };
}

/** The pieces the tests and the lab want without building a graph. */
export const MAGGOT_GEOMETRY = Object.freeze({
  segments: MAGGOT_SEGMENTS,
  rMax: R_MAX,
  profile: PROFILE,
  grooves: GROOVES,
});
