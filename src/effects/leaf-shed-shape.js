/**
 * LEAF SHED — THE BODY: a leaf, a clump of leaves and a twig, drawn the way the
 * author paints them. Pure TSL builders; no buffers, no THREE objects.
 *
 * ============================================================================
 * WHAT THE ART LOOKS LIKE (measured 2026-10-31, Wilderness pack, deep forest)
 * ============================================================================
 *   • Bush leaves: pointed ovate shapes — a rounded base, a pointed tip —
 *     ≈ 30–40 art px long and ≈ 0.55 as wide, never two alike: some fat, some
 *     slim, some bowed, one flank fuller than the other.
 *   • THE OUTLINE IS BLACK AND NOISY (the author, 2026-10-31, looking at the
 *     rock-and-vegetation art): a heavy, high-contrast black line ≈ 4 art px
 *     wide that wobbles — it wanders in and out along both its edges, the way a
 *     brush drags, with no two stretches alike. The first cut drew a clean
 *     dark-fill-coloured edge and read as vector clip-art; this draws the line.
 *   • Fills are flat with a softer lighter half (cel shading), plus a short dark
 *     interior stroke rather than a full drawn midrib.
 *   • Tree canopy edges are scalloped lobes tipped with small pointed tufts —
 *     which is what a torn-off CLUMP is drawn as here (3 tips, ragged).
 *   • Branches are pink-brown (~#6a544e), chunky, outlined the same way.
 *
 * ============================================================================
 * THE FRAME
 * ============================================================================
 * Every function takes `p` = (u, v) in LEAF UNITS: u runs stem → tip (−1 … +1),
 * v across, 1 unit = half the leaf's length. A leaf turning over is drawn by
 * squashing v by |cos flip| (`flipCos`) — edge-on is a sliver, past edge-on the
 * paler underside shows.
 *
 * `rnd` is this leaf's four dice (vec4, each 0..1, fixed for its whole life —
 * the runtime derives them from the birth stamp). They bend the form: width,
 * where it is fullest, the bow, the lopsidedness; the clump's tip angles and
 * lengths; the twig's fork. They also seed the outline's noise.
 *
 * @module effects/leaf-shed-shape
 */

/** Full width of a leaf at its widest, in leaf units (≈ 0.55 of the length, as painted). */
const LEAF_HALF_WIDTH = 0.56;
/** How far the widest point sits toward the stem (0 = middle). */
const LEAF_BASE_BIAS = 0.32;
/** The flattest a turning leaf gets: a sliver, never a line that aliases away. */
const MIN_FLIP = 0.08;
/** Dice for callers that have none (tests, the shadow's old look): a plain leaf. */
const NO_DICE = [0.5, 0.5, 0.5, 0.5];

/** The four dice as nodes — `rnd` may be a vec4 node, an array of numbers, or null. */
function dice(TSL, rnd) {
  const src = rnd ?? NO_DICE;
  if (Array.isArray(src)) return src.map((x) => TSL.float(x));
  return [src.x, src.y, src.z, src.w];
}

/** A cheap decorrelated re-roll of one die. */
function reroll(TSL, r, k) {
  return TSL.fract(r.mul(k).add(k * 0.3719));
}

/**
 * Signed distance (leaf units, negative inside) to one pointed-ovate leaf,
 * its form bent by the dice.
 * @param {*} TSL @param {*} u @param {*} v @param {*} [rnd]
 */
export function leafDistance(TSL, u, v, rnd = null) {
  const { float, clamp, sin, pow, max, abs, select } = TSL;
  const [r0, r1, r2, r3] = dice(TSL, rnd);
  const widthK = float(0.8).add(r0.mul(0.42)); // 0.80 … 1.22
  const bias = float(0.14).add(r1.mul(0.34)); // 0.14 … 0.48: where it is fullest
  const bow = r2.sub(0.5).mul(0.24); // ± 0.12: a leaf is rarely straight
  const lopsided = r3.sub(0.5).mul(0.36); // ± 0.18: one flank fuller
  const tipPow = float(0.5).add(reroll(TSL, r0, 7.7).mul(0.22));
  const vb = v.add(bow.mul(u.mul(u).sub(1)));
  const t = clamp(u.add(1).mul(0.5), 0, 1);
  const side = clamp(vb.mul(24), -1, 1);
  const w = widthK
    .mul(LEAF_HALF_WIDTH)
    .mul(pow(max(sin(t.mul(Math.PI)), 1e-5), tipPow))
    .mul(float(1).sub(t.mul(bias)))
    .mul(float(1).add(lopsided.mul(side)));
  return select(abs(u).lessThan(1), abs(vb).sub(w), max(abs(u).sub(1), abs(vb)).add(0.02));
}

function capsule(TSL, u, v, ax, ay, bx, by, r) {
  const { vec2, clamp, dot, length } = TSL;
  const pa = vec2(u.sub(ax), v.sub(ay));
  const ba = vec2(bx - ax, by - ay);
  const h = clamp(dot(pa, ba).div((bx - ax) ** 2 + (by - ay) ** 2), 0, 1);
  return length(pa.sub(ba.mul(h))).sub(r);
}

/** Rotation by `a` radians (a number or a node) about (du, dv). */
function rotated(TSL, u, v, a, du = 0, dv = 0) {
  const { cos, sin, float } = TSL;
  const an = typeof a === 'number' ? float(a) : a;
  const c = cos(an);
  const s = sin(an);
  const uu = u.sub(du);
  const vv = v.sub(dv);
  return { u: uu.mul(c).add(vv.mul(s)), v: uu.mul(s.negate()).add(vv.mul(c)) };
}

/**
 * A torn-off clump: a scalloped puff with three ragged leaf tips poking out of its
 * rim — each tip's angle, length and width thrown by the dice, so the arrowhead is
 * never the same arrowhead twice.
 */
export function clumpDistance(TSL, u, v, rnd = null) {
  const { float, length, atan, max, cos, pow, min, vec2 } = TSL;
  const [r0, r1, r2, r3] = dice(TSL, rnd);
  // The puff itself: a little off-round, its scallops turned a random way.
  const stretch = float(0.86).add(r1.mul(0.28));
  const uu = u;
  const vv = v.mul(stretch);
  const radius = float(0.5).add(r2.mul(0.1));
  const r = length(vec2(uu, vv));
  const ang = atan(vv, uu);
  const lobes = float(0.05).add(r1.mul(0.05)).mul(pow(max(cos(ang.mul(5).add(r0.mul(6.2832))), 0), 3));
  let d = r.sub(radius).sub(lobes);
  const base = [-1.1, 0, 1.1];
  for (let k = 0; k < 3; k++) {
    const jitterA = reroll(TSL, r3, 3.1 + k * 4.3).sub(0.5).mul(0.62);
    const jitterL = reroll(TSL, r0, 5.3 + k * 2.9);
    const jitterW = reroll(TSL, r2, 4.7 + k * 3.3);
    const q = rotated(TSL, u, v, jitterA.add(base[k]));
    const scale = float(2.0).add(jitterL.mul(0.9)); // 2.0 … 2.9: long tip → short tip
    // Each tip is a small ovate leaf with its OWN dice.
    const tip = leafDistance(TSL, q.u.mul(scale).sub(1.25), q.v.mul(scale), [
      jitterW,
      reroll(TSL, jitterL, 2.3),
      reroll(TSL, jitterA.add(0.5), 6.1),
      reroll(TSL, jitterW, 9.7),
    ]).div(scale);
    d = min(d, tip);
  }
  return d;
}

/** One forked-stick twig with a single small leaf on the fork — the original design (design 0). */
function twigForkLeaf(TSL, u, v, r) {
  const { min, float } = TSL;
  const [r0, r1, r2, r3] = r;
  // The main stick bows by a dice-sized amount: a straight stick never looks torn off.
  const bow = r0.sub(0.5).mul(0.2);
  let d = capsule(TSL, u, v.add(bow.mul(u.mul(u).sub(0.72))), -0.85, 0, 0.8, 0.06, 0.15);
  const forkEndX = float(0.38).add(r1.mul(0.24));
  const forkEndY = float(0.3).add(r2.mul(0.26));
  // The fork: a capsule whose far end moves with the dice (built through a point-segment distance).
  const forkA = { x: 0.1, y: 0.03 };
  const pax = u.sub(forkA.x);
  const pay = v.sub(forkA.y);
  const bax = forkEndX.sub(forkA.x);
  const bay = forkEndY.sub(forkA.y);
  const hh = TSL.clamp(pax.mul(bax).add(pay.mul(bay)).div(bax.mul(bax).add(bay.mul(bay))), 0, 1);
  const dx = pax.sub(bax.mul(hh));
  const dy = pay.sub(bay.mul(hh));
  d = min(d, TSL.sqrt(dx.mul(dx).add(dy.mul(dy))).sub(0.11));
  d = min(d, capsule(TSL, u, v, -0.35, 0, -0.1, -0.33, 0.09));
  const q = rotated(TSL, u, v, float(-0.9).add(r1.sub(0.5).mul(0.7)), 0.62, 0.48);
  return min(d, leafDistance(TSL, q.u.mul(3.2), q.v.mul(3.2), [r2, r0, r3, r1]).div(3.2));
}

/** Design 1 — a Y: one stick that splits into two prongs at its end. */
function twigY(TSL, u, v) {
  const { min } = TSL;
  let d = capsule(TSL, u, v, -0.9, 0, 0.15, 0.02, 0.14);
  d = min(d, capsule(TSL, u, v, 0.1, 0.02, 0.88, 0.3, 0.11));
  return min(d, capsule(TSL, u, v, 0.1, 0.02, 0.86, -0.27, 0.1));
}

/** Design 2 — a bare branch: a long stick with three short nubs left where side shoots broke off. */
function twigNubs(TSL, u, v) {
  const { min } = TSL;
  let d = capsule(TSL, u, v, -0.92, 0, 0.92, 0.05, 0.12);
  d = min(d, capsule(TSL, u, v, -0.32, 0, -0.16, 0.3, 0.08));
  d = min(d, capsule(TSL, u, v, 0.22, 0.03, 0.4, -0.29, 0.08));
  return min(d, capsule(TSL, u, v, 0.58, 0.04, 0.74, 0.24, 0.07));
}

/** Design 3 — a short heavy stub with a knot and one broken-off spur: a chunk of limb. */
function twigStub(TSL, u, v) {
  const { min } = TSL;
  let d = capsule(TSL, u, v, -0.55, 0, 0.55, 0.03, 0.22);
  d = min(d, capsule(TSL, u, v, 0.15, 0.1, 0.32, 0.42, 0.1));
  return min(d, capsule(TSL, u, v, 0.55, 0.03, 0.8, 0.0, 0.14));
}

/** Design 4 — a leafy sprig: a thin stick carrying three small leaves along it. */
function twigSprig(TSL, u, v, r) {
  const { min, float } = TSL;
  let d = capsule(TSL, u, v, -0.9, 0, 0.7, 0.04, 0.08);
  const spots = [
    [-0.05, 0.1, -0.9],
    [0.42, -0.1, 0.95],
    [0.8, 0.04, 0.1],
  ];
  spots.forEach(([du, dv, a], i) => {
    const q = rotated(TSL, u, v, float(a).add(r[i].sub(0.5).mul(0.5)), du, dv);
    d = min(d, leafDistance(TSL, q.u.mul(3.0), q.v.mul(3.0), [r[(i + 1) % 4], r[i], r[(i + 2) % 4], r[3]]).div(3.0));
  });
  return d;
}

/** Design 5 — a crooked branch: two bends, a spur at the elbow. */
function twigCrook(TSL, u, v) {
  const { min } = TSL;
  let d = capsule(TSL, u, v, -0.9, 0.22, -0.12, -0.14, 0.12);
  d = min(d, capsule(TSL, u, v, -0.12, -0.14, 0.88, 0.16, 0.11));
  return min(d, capsule(TSL, u, v, -0.12, -0.14, 0.05, -0.46, 0.08));
}

/** How many twig designs there are (the dice pick one per twig). */
export const TWIG_DESIGNS = 6;

/**
 * A twig: one of {@link TWIG_DESIGNS} designs, chosen by the leaf's own dice and mirrored at random —
 * a forked stick with a leaf, a Y, a bare branch with nubs, a chunk of limb, a leafy sprig, a crooked branch.
 */
export function twigDistance(TSL, u, vIn, rnd = null) {
  const { select, floor } = TSL;
  const r = dice(TSL, rnd);
  const v = select(r[3].greaterThan(0.5), vIn, vIn.negate());
  const design = floor(reroll(TSL, r[1].add(r[2].mul(0.37)), 11.3).mul(TWIG_DESIGNS));
  const forks = twigForkLeaf(TSL, u, v, r);
  const y = twigY(TSL, u, v);
  const nubs = twigNubs(TSL, u, v);
  const stub = twigStub(TSL, u, v);
  const sprig = twigSprig(TSL, u, v, r);
  const crook = twigCrook(TSL, u, v);
  return select(
    design.lessThan(0.5),
    forks,
    select(
      design.lessThan(1.5),
      y,
      select(design.lessThan(2.5), nubs, select(design.lessThan(3.5), stub, select(design.lessThan(4.5), sprig, crook)))
    )
  );
}

/**
 * Distance to whichever body `kind` is (0 leaf, 1 clump, 2 twig), with the turn
 * applied. All three are evaluated and one selected — each is a handful of ALU
 * on a quad a few dozen pixels wide, cheaper than a divergent branch.
 * @param {*} TSL @param {*} p - vec2 leaf units. @param {*} kind @param {*} flipCos - |cos flip|, already floored.
 * @param {*} [rnd] - the leaf's four dice (vec4 node).
 */
export function shedDistance(TSL, p, kind, flipCos, rnd = null) {
  const { select } = TSL;
  const u = p.x;
  const v = p.y.div(flipCos);
  const d = select(
    kind.lessThan(0.5),
    leafDistance(TSL, u.mul(1.1), v.mul(1.1), rnd).div(1.1),
    select(kind.lessThan(1.5), clumpDistance(TSL, u, v, rnd), twigDistance(TSL, u, v, rnd))
  );
  return d.mul(flipCos);
}

// ── the brush ───────────────────────────────────────────────────────────────

function hash21(TSL, x, y) {
  const { fract, sin } = TSL;
  return fract(sin(x.mul(127.1).add(y.mul(311.7))).mul(43758.5453));
}

/** Smooth value noise, 0..1. */
function valueNoise(TSL, x, y) {
  const { floor, fract, mix } = TSL;
  const ix = floor(x);
  const iy = floor(y);
  const fx = fract(x);
  const fy = fract(y);
  const sx = fx.mul(fx).mul(fx.mul(-2).add(3));
  const sy = fy.mul(fy).mul(fy.mul(-2).add(3));
  const a = hash21(TSL, ix, iy);
  const b = hash21(TSL, ix.add(1), iy);
  const c = hash21(TSL, ix, iy.add(1));
  const e = hash21(TSL, ix.add(1), iy.add(1));
  return mix(mix(a, b, sx), mix(c, e, sx), sy);
}

/**
 * The brush wobble at leaf-frame point (x, y), −1 … +1: a coarse drift (the line
 * wandering) plus a fine tremor (the dragged-bristle roughness). `seed` decorrelates
 * the silhouette's edge from the ink's inner edge, and one leaf from the next.
 * Noise is sampled in the leaf's OWN frame, so it turns and flips with the leaf.
 */
function brush(TSL, x, y, seed) {
  const sx = seed.mul(31.7);
  const sy = seed.mul(17.3);
  const coarse = valueNoise(TSL, x.mul(4.6).add(sx), y.mul(4.6).add(sy)).mul(2).sub(1);
  const fine = valueNoise(TSL, x.mul(13.0).add(sy), y.mul(13.0).add(sx)).mul(2).sub(1);
  const grit = valueNoise(TSL, x.mul(31.0).add(sx), y.mul(31.0).add(sy)).mul(2).sub(1);
  return coarse.mul(0.5).add(fine.mul(0.35)).add(grit.mul(0.15));
}

/**
 * The painted look of one body: straight-sRGB colour and coverage.
 *
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.p - vec2, leaf units.
 * @param {*} a.aa - float, one screen pixel in leaf units.
 * @param {*} a.kind - float 0/1/2.
 * @param {*} a.flip - float, the turn angle (cos < 0 shows the underside).
 * @param {*} a.rgb - vec3, the fill (straight sRGB 0..1).
 * @param {*} a.inkW - float, outline width in leaf units.
 * @param {*} a.lightSide - float ±1: which half of the leaf faces the light.
 * @param {*} [a.rnd] - the leaf's four dice (vec4 node).
 * @returns {{rgb:*, alpha:*, distance:*}}
 */
export function buildShedLook(TSL, { p, aa, kind, flip, rgb, inkW, lightSide, rnd = null }) {
  const { float, vec3, abs, cos, max, min, smoothstep, select, mix } = TSL;
  const c = cos(flip);
  const flipCos = max(abs(c), MIN_FLIP);
  const d0 = shedDistance(TSL, p, kind, flipCos, rnd);
  const isTwig = kind.greaterThan(1.5);
  const w = select(isTwig, inkW.mul(0.6), inkW);
  const v = p.y.div(flipCos);
  // The brush: one wobble for the line's outer edge, another (decorrelated) for where the
  // colour starts — so the black band swells and thins as it runs round the shape.
  const dice4 = dice(TSL, rnd);
  const seed = dice4[0].add(dice4[3].mul(1.7));
  const outerWobble = brush(TSL, p.x, v, seed).mul(w).mul(0.42).mul(flipCos);
  const innerWobble = brush(TSL, p.x.add(3.1), v.sub(1.7), seed.add(0.53)).mul(w).mul(0.62).mul(flipCos);
  const d = d0.add(outerWobble);
  const alpha = float(1).sub(smoothstep(aa.negate(), aa, d));
  // The underside: paler and a touch greyer, as a real leaf's is.
  const under = rgb.mul(0.82).add(vec3(0.06, 0.065, 0.045));
  const base = select(c.greaterThanEqual(0), rgb, select(isTwig, rgb.mul(0.9), under));
  const hi = min(rgb.mul(1.18).add(0.03), vec3(1, 1, 1));
  const litHalf = smoothstep(-0.05, 0.08, v.mul(lightSide)).mul(select(isTwig, float(0.35), float(0.55)));
  let col = mix(base, hi, litHalf);
  // The short interior stroke the art uses in place of a full midrib (dark fill, not the black line).
  const strokeInk = rgb.mul(0.3);
  const strokeSpan = select(kind.lessThan(0.5), smoothstep(-0.9, -0.75, p.x).mul(smoothstep(0.6, 0.45, p.x)), float(0));
  const stroke = float(1)
    .sub(smoothstep(aa.mul(0.5), aa.mul(1.4), abs(v).mul(flipCos)))
    .mul(strokeSpan)
    .mul(0.45);
  col = mix(col, strokeInk, stroke);
  // The line: black, high contrast — a breath of the fill's hue so it sits in the art, no more.
  const ink = vec3(0.012, 0.014, 0.012).add(rgb.mul(0.05));
  const dFill = d0.add(innerWobble);
  const fillMask = float(1).sub(smoothstep(w.negate().sub(aa), w.negate().add(aa), dFill));
  col = mix(ink, col, fillMask);
  return { rgb: col, alpha, distance: d };
}

/**
 * Just the silhouette's coverage at `p` (for the cast shadow).
 * @param {*} TSL @param {*} p @param {*} kind @param {*} flip @param {*} soft - edge softness, leaf units.
 * @param {*} [rnd] - the leaf's four dice (vec4 node).
 */
export function shedCoverage(TSL, p, kind, flip, soft, rnd = null) {
  const { float, abs, cos, max, smoothstep } = TSL;
  const flipCos = max(abs(cos(flip)), MIN_FLIP);
  const d = shedDistance(TSL, p, kind, flipCos, rnd);
  return float(1).sub(smoothstep(soft.negate(), soft, d));
}
