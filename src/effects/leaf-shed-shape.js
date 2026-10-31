/**
 * LEAF SHED — THE BODY: a leaf, a clump of leaves and a twig, drawn the way the
 * author paints them. Pure TSL builders; no buffers, no THREE objects.
 *
 * ============================================================================
 * WHAT THE ART LOOKS LIKE (measured 2026-10-31, Wilderness pack, deep forest)
 * ============================================================================
 *   • Bush leaves: almond/teardrop shapes — a rounded base, a pointed tip —
 *     ≈ 30–40 art px long and ≈ 0.55 as wide, each closed by a brushy outline.
 *   • The outline is ≈ 4 art px wide and is the FILL'S OWN colour at ≈ 0.2–0.33
 *     brightness (dark teal round a teal bush, near-black round a yellow one),
 *     never a flat black.
 *   • Fills are flat with a softer lighter half (cel shading), plus a short dark
 *     interior stroke rather than a full drawn midrib.
 *   • Tree canopy edges are scalloped lobes tipped with small pointed tufts —
 *     which is what a torn-off CLUMP is drawn as here.
 *   • Branches are pink-brown (~#6a544e), chunky, outlined the same way.
 *
 * The shapes were judged in a scratch prototype beside crops of that art before
 * this port (a narrower leaf drowned in its own outline; a thinner twig read as
 * a black scratch), and the constants below are the ones that matched.
 *
 * ============================================================================
 * THE FRAME
 * ============================================================================
 * Every function takes `p` = (u, v) in LEAF UNITS: u runs stem → tip (−1 … +1),
 * v across, 1 unit = half the leaf's length. A leaf turning over is drawn by
 * squashing v by |cos flip| (`flipCos`) — edge-on is a sliver, past edge-on the
 * paler underside shows.
 *
 * @module effects/leaf-shed-shape
 */

/** Full width of a leaf at its widest, in leaf units (≈ 0.55 of the length, as painted). */
const LEAF_HALF_WIDTH = 0.56;
/** How far the widest point sits toward the stem (0 = middle). */
const LEAF_BASE_BIAS = 0.32;
/** The flattest a turning leaf gets: a sliver, never a line that aliases away. */
const MIN_FLIP = 0.08;

/**
 * Signed distance (leaf units, negative inside) to one teardrop leaf.
 * @param {*} TSL @param {*} u @param {*} v
 */
export function leafDistance(TSL, u, v) {
  const { float, clamp, sin, pow, max, abs, select } = TSL;
  const t = clamp(u.add(1).mul(0.5), 0, 1);
  const w = float(LEAF_HALF_WIDTH)
    .mul(pow(max(sin(t.mul(Math.PI)), 1e-5), 0.62))
    .mul(float(1).sub(t.mul(LEAF_BASE_BIAS)));
  return select(abs(u).lessThan(1), abs(v).sub(w), max(abs(u).sub(1), abs(v)).add(0.02));
}

function capsule(TSL, u, v, ax, ay, bx, by, r) {
  const { vec2, clamp, dot, length } = TSL;
  const pa = vec2(u.sub(ax), v.sub(ay));
  const ba = vec2(bx - ax, by - ay);
  const h = clamp(dot(pa, ba).div((bx - ax) ** 2 + (by - ay) ** 2), 0, 1);
  return length(pa.sub(ba.mul(h))).sub(r);
}

function rotated(TSL, u, v, a, du = 0, dv = 0) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const uu = u.sub(du);
  const vv = v.sub(dv);
  return { u: uu.mul(c).add(vv.mul(s)), v: uu.mul(-s).add(vv.mul(c)) };
}

/** A torn-off clump: a scalloped puff with three leaf tips poking out of its rim. */
export function clumpDistance(TSL, u, v) {
  const { float, length, atan, max, cos, pow, min } = TSL;
  const r = length(TSL.vec2(u, v));
  const ang = atan(v, u);
  const lobes = float(0.08).mul(pow(max(cos(ang.mul(5).add(0.4)), 0), 3));
  let d = r.sub(0.55).sub(lobes);
  for (const a of [-1.1, 0, 1.1]) {
    const q = rotated(TSL, u, v, a);
    d = min(d, leafDistance(TSL, q.u.mul(2.4).sub(1.25), q.v.mul(2.4)).div(2.4));
  }
  return d;
}

/** A twig: a forked stick with one small leaf on the fork. */
export function twigDistance(TSL, u, v) {
  const { min } = TSL;
  let d = capsule(TSL, u, v, -0.85, 0, 0.8, 0.06, 0.15);
  d = min(d, capsule(TSL, u, v, 0.1, 0.03, 0.5, 0.42, 0.11));
  d = min(d, capsule(TSL, u, v, -0.35, 0, -0.1, -0.33, 0.09));
  const q = rotated(TSL, u, v, -0.9, 0.62, 0.48);
  return min(d, leafDistance(TSL, q.u.mul(3.2), q.v.mul(3.2)).div(3.2));
}

/**
 * Distance to whichever body `kind` is (0 leaf, 1 clump, 2 twig), with the turn
 * applied. All three are evaluated and one selected — each is a handful of ALU
 * on a quad a few dozen pixels wide, cheaper than a divergent branch.
 * @param {*} TSL @param {*} p - vec2 leaf units. @param {*} kind @param {*} flipCos - |cos flip|, already floored.
 */
export function shedDistance(TSL, p, kind, flipCos) {
  const { select } = TSL;
  const u = p.x;
  const v = p.y.div(flipCos);
  const d = select(
    kind.lessThan(0.5),
    leafDistance(TSL, u.mul(1.1), v.mul(1.1)).div(1.1),
    select(kind.lessThan(1.5), clumpDistance(TSL, u, v), twigDistance(TSL, u, v))
  );
  return d.mul(flipCos);
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
 * @returns {{rgb:*, alpha:*, distance:*}}
 */
export function buildShedLook(TSL, { p, aa, kind, flip, rgb, inkW, lightSide }) {
  const { float, vec3, abs, cos, max, min, smoothstep, select, mix } = TSL;
  const c = cos(flip);
  const flipCos = max(abs(c), MIN_FLIP);
  const d = shedDistance(TSL, p, kind, flipCos);
  const alpha = float(1).sub(smoothstep(aa.negate(), aa, d));
  const isTwig = kind.greaterThan(1.5);
  // The underside: paler and a touch greyer, as a real leaf's is.
  const under = rgb.mul(0.82).add(vec3(0.06, 0.065, 0.045));
  const base = select(c.greaterThanEqual(0), rgb, select(isTwig, rgb.mul(0.9), under));
  const hi = min(rgb.mul(1.18).add(0.03), vec3(1, 1, 1));
  const v = p.y.div(flipCos);
  const litHalf = smoothstep(-0.05, 0.08, v.mul(lightSide)).mul(select(isTwig, float(0.35), float(0.55)));
  let col = mix(base, hi, litHalf);
  const ink = rgb.mul(0.3);
  // The short interior stroke the art uses in place of a full midrib.
  const strokeSpan = select(kind.lessThan(0.5), smoothstep(-0.9, -0.75, p.x).mul(smoothstep(0.6, 0.45, p.x)), float(0));
  const stroke = float(1)
    .sub(smoothstep(aa.mul(0.5), aa.mul(1.4), abs(v).mul(flipCos)))
    .mul(strokeSpan)
    .mul(0.45);
  col = mix(col, ink, stroke);
  const w = select(isTwig, inkW.mul(0.6), inkW);
  const fillMask = float(1).sub(smoothstep(w.negate().sub(aa), w.negate().add(aa), d));
  col = mix(ink, col, fillMask);
  return { rgb: col, alpha, distance: d };
}

/**
 * Just the silhouette's coverage at `p` (for the cast shadow).
 * @param {*} TSL @param {*} p @param {*} kind @param {*} flip @param {*} soft - edge softness, leaf units.
 */
export function shedCoverage(TSL, p, kind, flip, soft) {
  const { float, abs, cos, max, smoothstep } = TSL;
  const flipCos = max(abs(cos(flip)), MIN_FLIP);
  const d = shedDistance(TSL, p, kind, flipCos);
  return float(1).sub(smoothstep(soft.negate(), soft, d));
}
