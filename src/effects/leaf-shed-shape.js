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
/** The most a line may take of a leaf, in leaf units. Interiors keep the rest. */
const MAX_INK_LEAF = 0.16;
/**
 * A twig's line is this share of the stick's LOCAL radius, so a thin shoot keeps a body inside its outline
 * exactly as a thick one does (the author: shapes "always have a minimal internal volume").
 */
const INK_OF_RADIUS = 0.4;
/** Pale wood of a freshly broken end (straight sRGB), from the author's wood sheet. */
const CUT_WOOD = [226 / 255, 170 / 255, 108 / 255];
/** Dice for callers that have none (tests, the shadow's old look): a plain leaf. */
const NO_DICE = [0.5, 0.5, 0.5, 0.5];

/**
 * THE DIALS (the author, 2026-10-31: "lots of controls so that I can fine tune the appearance"). The
 * runtime hands its uniform nodes in through {@link buildShedLook} / {@link shedCoverage}; every builder
 * below reads them with {@link knob}, so a Studio slider moves a uniform and never rebuilds a shader.
 * Defaults reproduce the look the author approved before the dials existed.
 */
export const SHAPE_KNOB_DEFAULTS = Object.freeze({
  leafWidth: 1,
  leafVariety: 1,
  saturation: 1,
  brightness: 1,
  shading: 0.55,
  underside: 1,
  veins: 0.45,
  outlineDarkness: 1,
  outlineNoise: 1,
  outlineGrain: 1,
  twigThickness: 1,
  twigBranching: 1,
  twigCurl: 1,
  cutWood: 1,
});
/**
 * The knobs in force while one material's nodes are being built. Node graphs are built synchronously, so
 * this is set for the span of one {@link buildShedLook}/{@link shedCoverage} call and cleared after —
 * cheaper to read than threading one more argument through every leaf form.
 */
let KNOBS = null;
function knob(TSL, name) {
  return KNOBS?.[name] ?? TSL.float(SHAPE_KNOB_DEFAULTS[name]);
}
function withKnobs(knobs, build) {
  const prev = KNOBS;
  KNOBS = knobs ?? null;
  try {
    return build();
  } finally {
    KNOBS = prev;
  }
}

/** The four dice as nodes — `rnd` may be a vec4 node, an array of numbers, or null. */
function dice(TSL, rnd) {
  const src = rnd ?? NO_DICE;
  if (Array.isArray(src)) return src.map((x) => (typeof x === 'number' ? TSL.float(x) : x));
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
  const variety = knob(TSL, 'leafVariety');
  const widthK = float(1.01).add(r0.sub(0.5).mul(0.42).mul(variety)).mul(knob(TSL, 'leafWidth')); // 0.80 … 1.22 at 1
  const bias = float(0.31).add(r1.sub(0.5).mul(0.34).mul(variety)); // 0.14 … 0.48: where it is fullest
  const bow = r2.sub(0.5).mul(0.24).mul(variety); // ± 0.12: a leaf is rarely straight
  const lopsided = r3.sub(0.5).mul(0.36).mul(variety); // ± 0.18: one flank fuller
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

/**
 * One tapered stick segment from a to b (numbers or nodes), radius `ra` at a → `rb` at b.
 * @returns {{d:*, r:*}} the distance and the radius at the nearest point (for the line's width).
 */
function segment(TSL, u, v, ax, ay, bx, by, ra, rb) {
  const { clamp, max, sqrt, mix, float } = TSL;
  const n = (x) => (typeof x === 'number' ? float(x) : x);
  const pax = u.sub(n(ax));
  const pay = v.sub(n(ay));
  const bax = n(bx).sub(n(ax));
  const bay = n(by).sub(n(ay));
  const h = clamp(pax.mul(bax).add(pay.mul(bay)).div(max(bax.mul(bax).add(bay.mul(bay)), 1e-5)), 0, 1);
  const dx = pax.sub(bax.mul(h));
  const dy = pay.sub(bay.mul(h));
  const r = mix(n(ra), n(rb), h);
  return { d: sqrt(dx.mul(dx).add(dy.mul(dy))).sub(r), r };
}

/** Union of two {d, r}: the nearer one's radius wins. */
function unionR(TSL, a, b) {
  const take = b.d.lessThan(a.d);
  return { d: TSL.select(take, b.d, a.d), r: TSL.select(take, b.r, a.r) };
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

// ── broad leaves (kind 1) ───────────────────────────────────────────────────
// The author, 2026-10-31, with a chart of real leaf shapes: "Three prongs and a circle do not make a very
// convincing leaf shape". Five real forms instead, one per leaf by its dice: palmate (maple), trifoliate,
// cordate (heart), hastate (a spear with back lobes) and serrated ovate. Each grows from a short stem at
// u = −1 and points toward +u, like the plain leaf.

/** Palmate/digitate (maple): five pointed, toothed lobes fanning from a centre near the stem. */
function palmateLeaf(TSL, u, v, r) {
  const { float, length, atan, abs, max, pow, fract, vec2, select } = TSL;
  const qx = u.add(0.22);
  const rho = length(vec2(qx, v));
  const th = atan(v, qx);
  const LOBES = [
    [0, 1],
    [0.92, 0.84],
    [-0.92, 0.84],
    [1.85, 0.52],
    [-1.85, 0.52],
  ];
  let reach = float(0);
  LOBES.forEach(([a, len], k) => {
    const variety = knob(TSL, 'leafVariety');
    const ang = float(a).add(reroll(TSL, r[k % 4], 2.3 + k).sub(0.5).mul(0.22).mul(variety));
    const l = float(len).mul(float(1).add(reroll(TSL, r[(k + 1) % 4], 5.1 + k).sub(0.5).mul(0.3).mul(variety)));
    reach = max(reach, l.mul(pow(max(float(1).sub(abs(th.sub(ang)).div(0.42)), 0), 1.25)));
  });
  const tri = abs(fract(th.mul(4.4).add(r[2])).sub(0.5)).mul(2);
  const teeth = tri.sub(0.5).mul(0.05).mul(select(reach.greaterThan(0.08), float(1), float(0)));
  return rho.sub(float(0.3).add(reach.mul(0.62)).add(teeth)).mul(0.72);
}

/** Trifoliate: three ovate leaflets from one point, the middle one longest. */
function trifoliateLeaf(TSL, u, v, r) {
  const { min, float } = TSL;
  const qc = rotated(TSL, u, v, r[0].sub(0.5).mul(0.2), -0.42, 0);
  let d = leafDistance(TSL, qc.u.sub(0.5).mul(1.9), qc.v.mul(1.9), [r[1], r[2], r[3], r[0]]).div(1.9);
  for (const s of [-1, 1]) {
    const a = float(s * 1.05).add(reroll(TSL, r[s > 0 ? 1 : 2], 3.3).sub(0.5).mul(0.3));
    const q = rotated(TSL, u, v, a, -0.42, 0);
    d = min(d, leafDistance(TSL, q.u.sub(0.38).mul(2.5), q.v.mul(2.5), [r[2], r[s > 0 ? 3 : 0], r[1], r[3]]).div(2.5));
  }
  return d;
}

/** Cordate (heart): broad, rounded lobes either side of a notch at the stem, a pointed tip. */
function cordateLeaf(TSL, u, v, r) {
  const { min, max, length, vec2, abs, float } = TSL;
  let d = leafDistance(TSL, u, v.mul(0.82), [0.9, 0.95, r[2], 0.5]).mul(0.82);
  const lobeR = float(0.36).add(r[0].mul(0.06));
  d = min(d, length(vec2(u.add(0.5), abs(v).sub(0.3))).sub(lobeR));
  return max(d, float(0.2).sub(length(vec2(u.add(1.05), v))));
}

/** Hastate (spear): a narrow blade with two pointed lobes swept back at its base. */
function hastateLeaf(TSL, u, v, r) {
  const { min, float } = TSL;
  let d = leafDistance(TSL, u, v.mul(1.7), [0.45, 0.2, r[2], 0.5]).div(1.7);
  for (const s of [-1, 1]) {
    const a = float(s * 2.3).add(reroll(TSL, r[s > 0 ? 0 : 3], 4.1).sub(0.5).mul(0.3));
    const q = rotated(TSL, u, v, a, -0.48, 0);
    d = min(d, leafDistance(TSL, q.u.sub(0.3).mul(3.0), q.v.mul(3.0), [r[1], 0.3, r[0], 0.5]).div(3.0));
  }
  return d;
}

/** Serrated ovate (elm, birch): an ovate blade whose edge is sawn into teeth that lean toward the tip. */
function serratedLeaf(TSL, u, v, r) {
  const { clamp, fract, float } = TSL;
  const t = clamp(u.add(1).mul(0.5), 0, 1);
  const d = leafDistance(TSL, u, v.mul(0.92), [0.85, 0.6, r[2], r[3]]);
  const tooth = float(1).sub(fract(t.mul(8).add(r[0]))).mul(0.07);
  return d.add(tooth).sub(0.035);
}

/** How many broad-leaf forms there are (the dice pick one per leaf). */
export const BROAD_LEAF_FORMS = 5;

/**
 * A broad leaf (kind 1): one of {@link BROAD_LEAF_FORMS} real leaf forms, picked by the leaf's dice, on a
 * short stem. (The function keeps its old name: kind 1 used to be a torn-off clump.)
 */
export function clumpDistance(TSL, u, v, rnd = null) {
  const { select, floor, min } = TSL;
  const r = dice(TSL, rnd);
  const form = floor(reroll(TSL, r[1].add(r[2].mul(0.37)), 11.3).mul(BROAD_LEAF_FORMS));
  const blade = select(
    form.lessThan(0.5),
    palmateLeaf(TSL, u, v, r),
    select(
      form.lessThan(1.5),
      trifoliateLeaf(TSL, u, v, r),
      select(
        form.lessThan(2.5),
        cordateLeaf(TSL, u, v, r),
        select(form.lessThan(3.5), hastateLeaf(TSL, u, v, r), serratedLeaf(TSL, u, v, r))
      )
    )
  );
  const stem = segment(TSL, u, v, -1.04, 0, -0.55, 0, 0.032, 0.026).d;
  return min(blade, stem);
}

// ── twigs (kind 2) — GROWN, not drawn ───────────────────────────────────────
// The author, 2026-10-31: "far too fat … they also need curves … look up mathematical principles of how
// twigs change in shape, angle and width". Three such principles, each used below:
//   • LEONARDO'S RULE: at a fork, cross-sectional area is conserved, r_parent² = r_main² + r_side².
//     A side shoot of 0.55–0.75 of its parent's radius leaves the main axis √(1 − f²) of it.
//   • SYMPODIAL ZIG-ZAG: a twig's axis is a chain of short internodes, each turned a little the other way
//     at its node (the bud that took over), plus a random wander: a gently crooked line.
//   • BRANCH ANGLES of 30–55° from the parent, each shoot curving back toward its parent's heading as it
//     grows (it reaches for the same light), thinning to a point.
// The base is the broken end (pale wood); every other end is a natural, pointed tip.

/** Main-axis base radius, leaf units (a twig is 2.6 leaves long, so ≈ 6–7 art px across at the base). */
const TWIG_BASE_R = 0.075;
/** Each internode keeps this share of its radius (6 internodes → about half by the tip, before forks). */
const INTERNODE_TAPER = 0.9;

/**
 * A grown twig: its distance, the stick radius at the nearest point (the line's width follows it), and
 * how near the broken base this point is (the pale cut end).
 * @returns {{d:*, r:*, cut:*}}
 */
export function twigShape(TSL, u, vIn, rnd = null) {
  const { float, cos, sin, select, sqrt, length, vec2, smoothstep } = TSL;
  const r = dice(TSL, rnd);
  const v = select(r[3].greaterThan(0.5), vIn, vIn.negate());
  const die = (k) => reroll(TSL, r[k % 4], 3.7 + k * 1.913);
  const N = 6;
  const L = float(1.85 / N).mul(float(0.88).add(die(0).mul(0.2)));
  const zig = select(die(2).greaterThan(0.5), float(1), float(-1));
  const R0 = float(TWIG_BASE_R).mul(float(0.85).add(die(3).mul(0.35))).mul(knob(TSL, 'twigThickness'));
  const curl = knob(TSL, 'twigCurl');
  const branching = knob(TSL, 'twigBranching');
  const base = [-0.93, 0];
  let x = float(base[0]);
  let y = float(base[1]);
  let th = die(1).sub(0.5).mul(0.5).mul(curl);
  let rad = R0;
  let acc = null;
  const FORKS = { 2: 1, 4: -1 };
  for (let i = 0; i < N; i++) {
    th = th.add(die(10 + i).sub(0.5).mul(0.5).mul(curl)).add(zig.mul(i % 2 ? 0.17 : -0.17).mul(curl));
    const nx = x.add(L.mul(cos(th)));
    const ny = y.add(L.mul(sin(th)));
    const radEnd = rad.mul(INTERNODE_TAPER);
    const seg = segment(TSL, u, v, x, y, nx, ny, rad, radEnd);
    acc = acc ? unionR(TSL, acc, seg) : seg;
    rad = radEnd;
    const side = FORKS[i + 1];
    if (side) {
      // Leonardo: the side shoot takes f of the radius, the main axis keeps √(1 − f²).
      const f = float(0.55).add(die(20 + i).mul(0.2));
      const rSide = rad.mul(f);
      const rMain = rad.mul(sqrt(float(1).sub(f.mul(f))));
      const sgn = zig.mul(side);
      let sth = th.add(sgn.mul(float(0.55).add(die(24 + i).mul(0.4))));
      let sx = nx;
      let sy = ny;
      let sr = rSide;
      const sideLens = [0.8, 0.62, 0.45];
      sideLens.forEach((k, j) => {
        // It curves back toward the parent's heading as it grows, with its own wander.
        sth = sth.sub(sgn.mul(0.16)).add(die(30 + i * 3 + j).sub(0.5).mul(0.45).mul(curl));
        const ex = sx.add(L.mul(k).mul(branching).mul(cos(sth)));
        const ey = sy.add(L.mul(k).mul(branching).mul(sin(sth)));
        const er = sr.mul(j === sideLens.length - 1 ? 0.35 : 0.72);
        acc = unionR(TSL, acc, segment(TSL, u, v, sx, sy, ex, ey, sr, er));
        // A tiny tertiary spur off the side shoot's first node, sometimes.
        if (j === 0) {
          const spurTh = sth.sub(sgn.mul(float(0.7).add(die(40 + i).mul(0.3))));
          const spur = segment(
            TSL,
            u,
            v,
            ex,
            ey,
            ex.add(L.mul(0.38).mul(branching).mul(cos(spurTh))),
            ey.add(L.mul(0.38).mul(branching).mul(sin(spurTh))),
            er.mul(0.6),
            er.mul(0.2)
          );
          acc = unionR(TSL, acc, { d: select(die(44 + i).greaterThan(0.45), spur.d, float(9)), r: spur.r });
        }
        sx = ex;
        sy = ey;
        sr = er;
      });
      // The main axis kinks away from the shoot it gave up.
      th = th.sub(sgn.mul(0.14));
      rad = rMain;
    }
    x = nx;
    y = ny;
  }
  const cut = float(1).sub(smoothstep(R0.mul(0.9), R0.mul(1.7), length(vec2(u.sub(base[0]), v.sub(base[1])))));
  return { d: acc.d, r: acc.r, cut };
}

/** A twig's distance alone. */
export function twigDistance(TSL, u, v, rnd = null) {
  return twigShape(TSL, u, v, rnd).d;
}

/**
 * Distance to whichever body `kind` is (0 leaf, 1 broad leaf, 2 twig), with the turn applied, plus the
 * twig's local stick radius and cut-end mask (leaves: a large radius, no cut). All three are evaluated and
 * one selected — each is a handful of ALU on a quad a few dozen pixels wide, cheaper than a divergent branch.
 * @param {*} TSL @param {*} p - vec2 leaf units. @param {*} kind @param {*} flipCos - |cos flip|, already floored.
 * @param {*} [rnd] - the leaf's four dice (vec4 node).
 * @returns {{d:*, rad:*, cut:*}}
 */
export function shedBody(TSL, p, kind, flipCos, rnd = null) {
  const { select, float } = TSL;
  const u = p.x;
  const v = p.y.div(flipCos);
  // A twig is a round stick: turning over does not thin it the way it thins a flat leaf.
  const twig = twigShape(TSL, u, p.y, rnd);
  const isBroad = kind.lessThan(1.5);
  const leafD = select(
    kind.lessThan(0.5),
    leafDistance(TSL, u.mul(1.1), v.mul(1.1), rnd).div(1.1),
    clumpDistance(TSL, u, v, rnd)
  );
  return {
    d: select(isBroad, leafD.mul(flipCos), twig.d),
    rad: select(isBroad, float(1), twig.r),
    cut: select(isBroad, float(0), twig.cut),
  };
}

/** The body's distance alone (see {@link shedBody}). */
export function shedDistance(TSL, p, kind, flipCos, rnd = null) {
  return shedBody(TSL, p, kind, flipCos, rnd).d;
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
 * @param {object} [a.knobs] - the dials as nodes, keyed as {@link SHAPE_KNOB_DEFAULTS}; missing ones take the default.
 * @returns {{rgb:*, alpha:*, distance:*}}
 */
export function buildShedLook(TSL, args) {
  return withKnobs(args.knobs, () => buildShedLookNow(TSL, args));
}

function buildShedLookNow(TSL, { p, aa, kind, flip, rgb: rgbIn, inkW, lightSide, rnd = null }) {
  const { float, vec3, abs, cos, max, min, smoothstep, select, mix, dot, clamp } = TSL;
  // Saturation and brightness first: everything below (the shading, the line) is made from this colour.
  const lum0 = dot(rgbIn, vec3(0.299, 0.587, 0.114));
  const rgb = clamp(
    mix(vec3(lum0, lum0, lum0), rgbIn, knob(TSL, 'saturation')).mul(knob(TSL, 'brightness')),
    vec3(0, 0, 0),
    vec3(1, 1, 1)
  );
  const c = cos(flip);
  const flipCos = max(abs(c), MIN_FLIP);
  const body = shedBody(TSL, p, kind, flipCos, rnd);
  const d0 = body.d;
  const isTwig = kind.greaterThan(1.5);
  // A twig's line follows its stick: a share of the local radius, so the thinnest shoot keeps a body.
  const w = select(isTwig, min(inkW.mul(0.75), body.rad.mul(INK_OF_RADIUS)), min(inkW, float(MAX_INK_LEAF)));
  const v = p.y.div(flipCos);
  // The brush: one wobble for the line's outer edge, another (decorrelated) for where the
  // colour starts — so the band swells and thins as it runs round the shape.
  const dice4 = dice(TSL, rnd);
  const seed = dice4[0].add(dice4[3].mul(1.7));
  // A twig is ~1.7x the size of a leaf, so the same noise would read smoother on it: sample it finer and
  // swing it harder, so its edge is as ragged on screen as the tree's (the author: "sharper, less noisy than the tree").
  const nk = select(isTwig, float(1.9), float(1)).mul(knob(TSL, 'outlineGrain'));
  const ampK = select(isTwig, float(1.25), float(1)).mul(knob(TSL, 'outlineNoise'));
  const outerWobble = brush(TSL, p.x.mul(nk), v.mul(nk), seed).mul(w).mul(0.42).mul(ampK).mul(flipCos);
  const innerWobble = brush(TSL, p.x.add(3.1).mul(nk), v.sub(1.7).mul(nk), seed.add(0.53))
    .mul(w)
    .mul(0.45)
    .mul(ampK)
    .mul(flipCos);
  const d = d0.add(outerWobble);
  const alpha = float(1).sub(smoothstep(aa.negate(), aa, d));
  // The underside: paler and a touch greyer, as a real leaf's is.
  const under = rgb.mul(0.82).add(vec3(0.06, 0.065, 0.045));
  const base = select(c.greaterThanEqual(0), rgb, select(isTwig, rgb.mul(0.9), mix(rgb, under, knob(TSL, 'underside'))));
  const hi = min(rgb.mul(1.18).add(0.03), vec3(1, 1, 1));
  const shading = knob(TSL, 'shading');
  const litHalf = smoothstep(-0.05, 0.08, v.mul(lightSide)).mul(select(isTwig, shading.mul(0.35 / 0.55), shading));
  let col = mix(base, hi, litHalf);
  // The short interior stroke the art uses in place of a full midrib (dark fill, not the black line).
  const strokeInk = rgb.mul(0.3);
  const strokeSpan = select(kind.lessThan(1.5), smoothstep(-0.9, -0.75, p.x).mul(smoothstep(0.6, 0.45, p.x)), float(0));
  const stroke = float(1)
    .sub(smoothstep(aa.mul(0.5), aa.mul(1.4), abs(v).mul(flipCos)))
    .mul(strokeSpan)
    .mul(knob(TSL, 'veins'));
  col = mix(col, strokeInk, stroke);
  // The freshly broken end shows pale wood (her wood sheet): the twig's base, where it tore off. Its tips grew.
  const endMask = body.cut.mul(knob(TSL, 'cutWood'));
  col = mix(col, vec3(CUT_WOOD[0], CUT_WOOD[1], CUT_WOOD[2]), endMask);
  // The line. Leaves: a DEEP GREEN of their own colour, darker and a touch more saturated, never black (the
  // author, 2026-10-31: "no black outlines please, use an appropriate darker green"). Wood: a dark BROWN,
  // as the tree's own line is.
  const lum = dot(rgb, vec3(0.299, 0.587, 0.114));
  const deep = max(vec3(lum, lum, lum).add(rgb.sub(lum).mul(1.35)), vec3(0, 0, 0)).mul(0.42);
  const brown = vec3(0.02, 0.012, 0.008).add(rgb.mul(0.2));
  const ink = mix(rgb, select(isTwig, brown, deep), knob(TSL, 'outlineDarkness'));
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
export function shedCoverage(TSL, p, kind, flip, soft, rnd = null, knobs = null) {
  return withKnobs(knobs, () => {
    const { float, abs, cos, max, smoothstep } = TSL;
    const flipCos = max(abs(cos(flip)), MIN_FLIP);
    const d = shedDistance(TSL, p, kind, flipCos, rnd);
    return float(1).sub(smoothstep(soft.negate(), soft, d));
  });
}
