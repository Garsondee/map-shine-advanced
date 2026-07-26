/**
 * THE TUBE NET — fluid's geometric description of itself, extracted from the
 * rasterised `fluid` mask grid ON THE CPU, at decode time, once per mask
 * version (`docs/planning/Fluid.md` §5.2 stage A).
 *
 * Pure. No THREE, no Foundry, no globals, no I/O. Everything it needs arrives
 * as arguments and everything it knows leaves as the return value, which is
 * what makes the geodesic testable against brute force in Node — and that test
 * is not optional (see THE INSTRUMENT, below).
 *
 * ============================================================================
 * WHY THE GEODESIC, AND NOT THE PAINTED GRADIENT
 * ============================================================================
 * V2 asked the author to paint an arc-length ramp along each tube and then
 * recovered the flow direction by DIFFERENCING that ramp two texels apart
 * (`legacy/compositor-v2/effects/FluidEffectV2.js`, `grad = vec2(ageR-ageL,
 * ageU-ageD)` at a fixed ±12-texel offset). That is resolution-dependent, noisy
 * on a compressed mask, undefined wherever the ramp is flat, and meaningless at
 * a junction. It is the same mistake `feedback_sdf_does_not_draw_the_edge` and
 * `Water.md` §5.1 correction 3 each cost a session: do not difference a texture
 * to find a direction the GEOMETRY already knows.
 *
 * So arc length is DERIVED here, always, from the shape of the painted tube
 * itself. The author's ramp supplies exactly ONE BIT per tube — which end the
 * goo comes from — and nothing else.
 *
 * **That "always" is load-bearing and is not a style preference.** The obvious
 * alternative is *"use the painted ramp when it looks usable, otherwise derive
 * it"*, which is a MODE FORK, and `feedback_mode_forks_silently_drop_features`
 * records that shape going wrong THREE times on this project, resolved each
 * time by deleting the losing fork. There is one path. The hint is an input to
 * it, never a substitute for it.
 *
 * ============================================================================
 * THE ONE-BYTE HAZARD, NAMED BEFORE IT BITES
 * ============================================================================
 * The mask's R channel is read two ways (`scene/mask-catalog.js`, kind
 * `fluid`): BY THRESHOLD it is presence, BY VALUE it is the flow hint. That is
 * deliberate and it is NOT V2's bug — V2 computed `coverage = a · luma(rgb)`, a
 * PRODUCT, so a dim ramp was only PARTIALLY present and the tube visibly faded
 * out exactly where the fluid was oldest. A threshold does not fade.
 *
 * But `feedback_one_byte_two_quantities` still applies at one specific place:
 * **an ANTIALIASED EDGE texel genuinely is `coverage × ramp`.** Its value is
 * low because it is half-covered, not because it is far along the tube. The
 * naive orientation test — compare the hint at the two endpoints — reads
 * exactly those texels, and would be reading noise while looking authoritative.
 *
 * The cure is `hintCorrelation` below: orientation is decided by correlating
 * the hint against the geodesic across the WHOLE tube, with each texel weighted
 * by how INTERIOR it is (its count of present 8-neighbours). Edge texels
 * contribute almost nothing; interior texels carry the answer; and when a tube
 * is so thin that it has no interior at all, the confidence drops and the
 * extractor says so instead of guessing. An instrument that reports its own
 * confidence cannot lie the way a two-sample comparison can.
 *
 * ============================================================================
 * THE INSTRUMENT — why this file's Node test is the real deliverable
 * ============================================================================
 * A wrong arc length produces a SMOOTH, PLAUSIBLE, WRONG field — goo that flows
 * at a slightly odd speed, or from the wrong end, with no nameable symptom.
 * That is precisely the failure `feedback_smooth_output_hides_ported_bugs` was
 * written about, and `Water.md`'s own jump flood found a real bug this way that
 * "looked fine" (it understated distance near the map border by up to 2√2
 * texels, silently, forever). So `fluid-net.test.mjs` diffs this Dijkstra
 * against an independent brute-force implementation on every fixture, and
 * asserts the conservation identity on the area profile. Eyeballing a tube is
 * not verification.
 *
 * @module effects/fluid/fluid-net
 */

/**
 * A grid byte at or above this counts as tube. The catalog's `fluid` kind
 * declares `R > 0 is tube interior`, so this is 1 — the smallest nonzero byte —
 * and NOT a mid-grey threshold. A tube's far end painted at 3/255 is a
 * deliberately dim ramp position, not background.
 *
 * ⚠️ The cost of that choice, named rather than engineered around: the
 * rasterised grid is a DOWNSAMPLE of the source mask, so a texel straddling the
 * painted edge lands somewhere between 0 and the painted value. At a threshold
 * of 1 essentially every straddling texel reads as tube, which fattens each
 * tube by up to one GRID texel all round. That is acceptable here for the same
 * reason `WATER_PRESENCE_EPS` accepts its own bias: this grid supplies
 * LOW-FREQUENCY facts (arc length, area, radius), never the silhouette. The
 * silhouette comes from the mask file at its authored resolution and the
 * per-pixel distance from the GPU flood — `Fluid.md` §5.0's three-source rule.
 * Raising this number would trade a fatter tube for a SHORTER one (the dim end
 * would be cut off), which is strictly worse.
 */
export const FLUID_PRESENCE_MIN_BYTE = 1;

/**
 * Components smaller than this many grid texels are discarded as speckle.
 *
 * A real tube on a 512-max grid covering a battlemap is tens to thousands of
 * texels; a 3-texel blob is a compression artefact or a stray brush dab. The
 * number is small on purpose — this is a speckle filter, not a size policy, and
 * anything it drops is REPORTED (see `warnings`), never silently absorbed.
 */
export const FLUID_MIN_TUBE_TEXELS = 6;

/**
 * How many arc-length bins each tube's 1-D profile carries. This is the width
 * of one row of the sim state and profile textures (`Fluid.md` §5.3), so it is
 * a texture dimension, not a tuning knob: 512 samples along a 3,000 world-px
 * tube is ~6 px per sample, comfortably finer than any slug.
 */
export const FLUID_PROFILE_SAMPLES = 512;

/**
 * The tube-count cap — the height of the state texture (`Fluid.md` §5.3), so
 * again a texture dimension. A map with more painted tubes than this keeps the
 * LARGEST `FLUID_MAX_TUBES` and reports the rest as dropped.
 *
 * ⚠️ `Fluid.md` §13 risk 2 is exactly this: *"whatever the cap does, it must
 * log what it dropped"*. Silent truncation reads as "covered everything" when
 * it did not (`feedback_instruments_must_not_lie`), so the drop is a warning
 * string AND a count, and the caller is expected to surface both.
 */
export const FLUID_MAX_TUBES = 64;

/**
 * Below this |correlation| the painted hint is judged unusable and the tube is
 * oriented geometrically instead.
 *
 * 0.15 is deliberately permissive: a genuinely painted ramp on a tube with any
 * interior at all correlates far above this (the fixtures measure |r| > 0.9),
 * while an unpainted flat tube sits near 0 and noise on a 1-texel-wide tube
 * rarely clears it. The failure direction is the safe one — a rejected hint
 * costs an arbitrary-but-stable flow direction, which the brief explicitly
 * permits ("doesn't need to be exactly the same for all users"), whereas an
 * ACCEPTED bad hint would point the goo confidently the wrong way.
 */
export const FLUID_HINT_MIN_CORRELATION = 0.15;

/** The 8-neighbourhood, as (dx, dy) pairs. Diagonals are included because a
 * one-texel-wide tube drawn at an angle is DISCONNECTED under 4-connectivity —
 * the single most likely way a real painted tube would silently split into
 * dozens of speckle components and then be filtered away entirely. */
const NEIGHBOURS = Object.freeze([
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
]);

/**
 * A minimal binary min-heap over (texelIndex, distance).
 *
 * Written out rather than reached for because the alternative — a sorted array,
 * or re-scanning for the minimum — turns this from O(E log V) into O(V²), and a
 * fully-painted 512×512 grid is 262,144 texels, where that difference is the
 * difference between ~10 ms and a hung tab. The bake runs once per mask
 * version, but "once" is still on the main thread.
 */
class MinHeap {
  constructor() {
    /** @type {number[]} */
    this.items = [];
    /** @type {number[]} */
    this.keys = [];
  }

  get size() {
    return this.items.length;
  }

  /** @param {number} item @param {number} key */
  push(item, key) {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= keys[i]) break;
      swap(items, keys, parent, i);
      i = parent;
    }
  }

  /** @returns {number} the item with the smallest key. Call only when size > 0. */
  pop() {
    const { items, keys } = this;
    const top = items[0];
    const lastItem = items.pop();
    const lastKey = keys.pop();
    if (items.length > 0) {
      items[0] = /** @type {number} */ (lastItem);
      keys[0] = /** @type {number} */ (lastKey);
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < keys.length && keys[l] < keys[smallest]) smallest = l;
        if (r < keys.length && keys[r] < keys[smallest]) smallest = r;
        if (smallest === i) break;
        swap(items, keys, i, smallest);
        i = smallest;
      }
    }
    return top;
  }
}

/** @param {number[]} a @param {number[]} b @param {number} i @param {number} j */
function swap(a, b, i, j) {
  const ai = a[i];
  a[i] = a[j];
  a[j] = ai;
  const bi = b[i];
  b[i] = b[j];
  b[j] = bi;
}

/**
 * Geodesic distance from `source` to every texel of one component, in WORLD PX,
 * travelling only through present texels.
 *
 * The step costs are REAL WORLD DISTANCES (`texelW`, `texelH`, and the diagonal
 * hypotenuse), not hop counts. A hop count would make a tube's measured length
 * depend on how diagonal it happens to be — a 45° tube would read ~41% longer
 * than the same tube drawn axis-aligned, and every downstream speed would
 * inherit that error.
 *
 * ⚠️ Honest limitation, stated because a future session will otherwise assume
 * exactness: this is a grid geodesic, so it carries the standard metrication
 * error of an 8-connected graph (a straight run at 22.5° measures up to ~8%
 * long, because the path must staircase between the two available directions).
 * That does NOT matter for what arc length is used for here — `s` needs to be
 * smooth and monotone along the tube, and a uniform ~8% scale error is absorbed
 * entirely by the flow-speed parameter. It WOULD matter if anything ever
 * compared two tubes' lengths as physical quantities; nothing does.
 *
 * @param {object} args
 * @param {Uint8Array} args.present - 1 where tube, 0 elsewhere, w*h.
 * @param {Uint16Array} args.tubeId - component labels, w*h; only `label` is walked.
 * @param {number} args.label
 * @param {number} args.source - texel index to start from.
 * @param {number} args.w @param {number} args.h
 * @param {number} args.texelW @param {number} args.texelH
 * @param {{dist: Float64Array, settled: Uint8Array}} [args.scratch] - reusable
 *   buffers. Optional so tests can call this plainly, and supplied by
 *   `extractTubeNet` because it is not: at 512² a `dist` array is 2 MB, three
 *   sweeps per tube and sixty-four tubes is ~380 MB of allocation churn for a
 *   bake that is supposed to be invisible. The buffers are reset here, so a
 *   caller may hand the same pair back on every call.
 * @param {number[]} [args.resetList] - the component's own texel indices. When
 *   given, ONLY those are reset instead of the whole grid, which is safe
 *   because every read below is guarded by `tubeId[j] === label` — a texel
 *   outside the component is never consulted, so its stale value cannot be
 *   observed.
 *
 *   ⚠️ **This is worth ~4%, NOT the win it looks like, and the measurement is
 *   recorded so nobody pays for the same wrong guess twice.** A full
 *   `fill(Infinity)` + `fill(0)` over a 1,536×714 grid across 36 sweeps is
 *   ~79 M writes against ~650 k of real work, which reads like the obvious
 *   bottleneck. It is not: measured on the twelve-tube fixture, 379 ms → 365 ms.
 *   The actual cost is the Dijkstra itself (~14 ms per sweep × 36 ≈ 80% of the
 *   bake); the fixed passes — `labelComponents` 28 ms, `chamferRadius` 29 ms,
 *   `interiorness` 22 ms — are the rest. If this bake ever needs to be faster,
 *   the lever is FEWER SWEEPS (the third one exists only to compute
 *   `offPathFraction`, a diagnostic), not cheaper bookkeeping.
 * @returns {{dist: Float64Array, farthest: number, farthestDist: number}}
 */
export function geodesicFrom({ present, tubeId, label, source, w, h, texelW, texelH, scratch, resetList }) {
  const dist = scratch ? scratch.dist : new Float64Array(w * h);
  const settled = scratch ? scratch.settled : new Uint8Array(w * h);
  if (resetList) {
    for (let k = 0; k < resetList.length; k++) {
      dist[resetList[k]] = Infinity;
      settled[resetList[k]] = 0;
    }
  } else {
    dist.fill(Infinity);
    settled.fill(0);
  }
  const diag = Math.hypot(texelW, texelH);
  const stepCost = NEIGHBOURS.map(([dx, dy]) => (dx !== 0 && dy !== 0 ? diag : dx !== 0 ? texelW : texelH));

  const heap = new MinHeap();
  dist[source] = 0;
  heap.push(source, 0);

  let farthest = source;
  let farthestDist = 0;

  while (heap.size > 0) {
    const i = heap.pop();
    if (settled[i]) continue;
    settled[i] = 1;
    const d = dist[i];
    if (d > farthestDist) {
      farthestDist = d;
      farthest = i;
    }
    const x = i % w;
    const y = (i - x) / w;
    for (let n = 0; n < NEIGHBOURS.length; n++) {
      const nx = x + NEIGHBOURS[n][0];
      const ny = y + NEIGHBOURS[n][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!present[j] || tubeId[j] !== label || settled[j]) continue;
      const nd = d + stepCost[n];
      if (nd < dist[j]) {
        dist[j] = nd;
        heap.push(j, nd);
      }
    }
  }

  return { dist, farthest, farthestDist };
}

/**
 * Distance from every present texel to the nearest NON-present texel, in world
 * px — the tube's local half-width, used only for the coarse radius profile.
 *
 * A two-pass chamfer sweep, which is approximate (~2% against true Euclidean on
 * this neighbourhood) and entirely sufficient: this feeds `radiusProfile`, a
 * low-frequency per-bin quantity. **The per-pixel cross-section coordinate `w`
 * does NOT come from here** — it comes from the GPU jump flood at pack
 * resolution (`Fluid.md` §5.0). Mixing those two is the bug class the
 * three-source rule exists to prevent.
 *
 * Out of bounds counts as NOT present, so a tube running off the edge of the
 * grid is treated as ending there. That understates radius along the border,
 * which is the safe direction: a tube reads slightly thinner at the map edge
 * rather than fabricating width that was never painted.
 *
 * ⚠️ **HALF A TEXEL IS SUBTRACTED, and it is not a fudge.** A chamfer sweep
 * measures centre-to-centre: the middle texel of a three-texel-wide band sits
 * two texels from the nearest ABSENT texel's centre, so the raw sweep says its
 * radius is 2 texels when the band is only 1.5 texels from centre to edge. The
 * boundary lies half a texel inside the first absent centre, so the radius of a
 * uniform tube comes out exactly right after the subtraction — which is what
 * makes `2 × radius ≈ crossSectionProfile` a real invariant the test suite can
 * assert, rather than two independently-wrong numbers that happen to be close.
 *
 * @param {Uint8Array} present @param {number} w @param {number} h
 * @param {number} texelW @param {number} texelH
 * @returns {Float64Array}
 */
export function chamferRadius(present, w, h, texelW, texelH) {
  const diag = Math.hypot(texelW, texelH);
  const dt = new Float64Array(w * h);
  const BIG = (w * texelW + h * texelH) * 2;

  for (let i = 0; i < dt.length; i++) dt[i] = present[i] ? BIG : 0;

  const relax = (i, j, cost) => {
    const v = dt[j] + cost;
    if (v < dt[i]) dt[i] = v;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!present[i]) continue;
      if (x > 0) relax(i, i - 1, texelW);
      else dt[i] = Math.min(dt[i], texelW);
      if (y > 0) relax(i, i - w, texelH);
      else dt[i] = Math.min(dt[i], texelH);
      if (x > 0 && y > 0) relax(i, i - w - 1, diag);
      if (x < w - 1 && y > 0) relax(i, i - w + 1, diag);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!present[i]) continue;
      if (x < w - 1) relax(i, i + 1, texelW);
      else dt[i] = Math.min(dt[i], texelW);
      if (y < h - 1) relax(i, i + w, texelH);
      else dt[i] = Math.min(dt[i], texelH);
      if (x < w - 1 && y < h - 1) relax(i, i + w + 1, diag);
      if (x > 0 && y < h - 1) relax(i, i + w - 1, diag);
    }
  }

  // Centre-to-centre becomes centre-to-boundary. See the header.
  const halfTexel = 0.25 * (texelW + texelH);
  for (let i = 0; i < dt.length; i++) {
    if (present[i]) dt[i] = Math.max(0, dt[i] - halfTexel);
  }
  return dt;
}

/**
 * Label 8-connected components of the presence mask, largest first.
 *
 * Iterative, with an explicit stack. Never recursive: a tube snaking across a
 * 512² grid is tens of thousands of texels deep, which is a stack overflow in
 * every JS engine — and it would present as a crash on ONE author's map, which
 * is the worst possible way to find out.
 *
 * @param {Uint8Array} present @param {number} w @param {number} h
 * @returns {{tubeId: Uint16Array, sizes: number[]}} `tubeId` is 1-based; 0 = not tube.
 */
export function labelComponents(present, w, h) {
  const tubeId = new Uint16Array(w * h);
  /** @type {number[]} */
  const sizes = [];
  /** @type {number[]} */
  const stack = [];
  let next = 0;

  for (let seed = 0; seed < present.length; seed++) {
    if (!present[seed] || tubeId[seed] !== 0) continue;
    next++;
    // 65535 is Uint16Array's ceiling and also far past FLUID_MAX_TUBES; a mask
    // with that many speckle components is pathological, and wrapping the label
    // would silently MERGE two unrelated tubes, which is worse than stopping.
    if (next > 65535) break;
    let count = 0;
    tubeId[seed] = next;
    stack.push(seed);
    while (stack.length > 0) {
      const i = /** @type {number} */ (stack.pop());
      count++;
      const x = i % w;
      const y = (i - x) / w;
      for (let n = 0; n < NEIGHBOURS.length; n++) {
        const nx = x + NEIGHBOURS[n][0];
        const ny = y + NEIGHBOURS[n][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!present[j] || tubeId[j] !== 0) continue;
        tubeId[j] = next;
        stack.push(j);
      }
    }
    sizes.push(count);
  }
  return { tubeId, sizes };
}

/**
 * How interior each present texel is: its count of present 8-neighbours, 0..8,
 * with out-of-bounds counting as absent.
 *
 * This is the antialiasing guard described in the module header. It is a
 * WEIGHT, not a filter, and that distinction is the whole reason it works on
 * thin tubes: an all-or-nothing "interior means all 8 neighbours present" test
 * returns ZERO samples for a one-texel-wide tube — which is the common case for
 * a thin glass capillary on a 512-max grid — and an orientation routine that
 * silently has no data is exactly the instrument that lies.
 *
 * @param {Uint8Array} present @param {number} w @param {number} h
 * @returns {Uint8Array}
 */
export function interiorness(present, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!present[i]) continue;
      let c = 0;
      for (let n = 0; n < NEIGHBOURS.length; n++) {
        const nx = x + NEIGHBOURS[n][0];
        const ny = y + NEIGHBOURS[n][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (present[ny * w + nx]) c++;
      }
      out[i] = c;
    }
  }
  return out;
}

/**
 * Weighted Pearson correlation between the painted hint and geodesic distance
 * from the root.
 *
 * Returns 0 — meaning "no usable signal", never a fabricated direction — when
 * either variable has no variance, which is exactly the unpainted-flat-tube
 * case this must not guess at.
 *
 * @param {number[]} hint @param {number[]} dist @param {number[]} weight
 * @returns {number} -1..1
 */
export function weightedCorrelation(hint, dist, weight) {
  let sw = 0;
  let mh = 0;
  let md = 0;
  for (let i = 0; i < hint.length; i++) {
    sw += weight[i];
    mh += weight[i] * hint[i];
    md += weight[i] * dist[i];
  }
  if (sw <= 0) return 0;
  mh /= sw;
  md /= sw;
  let cov = 0;
  let vh = 0;
  let vd = 0;
  for (let i = 0; i < hint.length; i++) {
    const dh = hint[i] - mh;
    const dd = dist[i] - md;
    cov += weight[i] * dh * dd;
    vh += weight[i] * dh * dh;
    vd += weight[i] * dd * dd;
  }
  if (vh <= 0 || vd <= 0) return 0;
  return cov / Math.sqrt(vh * vd);
}

/**
 * @typedef {object} Tube
 * @property {number} id - 1-based, matches `tubeIdByTexel`.
 * @property {number} row - 0-based row in the state/profile textures.
 * @property {number} texelCount
 * @property {number} lengthPx - geodesic root→tip distance, world px.
 * @property {number} rootTexel @property {number} tipTexel
 * @property {'hint'|'geometry'} orientedBy - what decided which end is `s = 0`.
 * @property {number} hintCorrelation - weighted correlation of hint against
 *   distance-from-the-FINAL-root. Negative means the bright end IS the root,
 *   i.e. correctly oriented; `orientedBy: 'hint'` guarantees it is ≤
 *   −FLUID_HINT_MIN_CORRELATION. Near 0 means the paint carried no direction.
 * @property {Float64Array} binAreaProfile - per bin, the PLAN-VIEW AREA of the
 *   tube in that bin, world px². This is the quantity that CONSERVES: it is the
 *   bin's capacity, so `φ · binArea` is the liquid it holds and the sim's mass
 *   balance is a sum over this array. Deliberately not called `areaProfile` —
 *   see `crossSectionProfile`, which is the OTHER thing "area" could mean and
 *   is the one continuity divides by.
 * @property {Float64Array} crossSectionProfile - per bin, the tube's effective
 *   WIDTH across the flow, world px (`binArea / binLength`). This is the `A` in
 *   `v = Q/A` — the relation that makes goo speed up through a constriction.
 *   In a top-down 2-D world a "cross-section" is a length, not an area, which
 *   is exactly why the two profiles need different names: conflating them puts
 *   a bin-length factor into every velocity, and a velocity that is wrong by a
 *   constant looks like a badly-tuned speed slider rather than like a bug.
 *   For a uniform tube this equals `2 × radiusProfile`, which the suite asserts.
 * @property {Float64Array} radiusProfile - per bin, the tube's half-width, world
 *   px (coarse — see `chamferRadius`).
 * @property {number} maxRadiusPx
 * @property {number} filledBins - bins that held no texel and were filled from
 *   their nearest populated neighbour. A large number means the tube is short
 *   relative to FLUID_PROFILE_SAMPLES; it is reported rather than hidden
 *   because `v = Q/A` divides by area and a zero bin would be a singularity.
 * @property {number} offPathFraction - 0..1, the share of the tube's texels
 *   that do NOT lie on the root→tip corridor. This is the honest measure of
 *   whether the 1-D assumption holds: ~0 is a simple tube, a large value means
 *   branches or a wide bulb, and it is deliberately NOT called "junction
 *   detection" because it is not — real topology arrives with the junction
 *   routing rung (`Fluid.md` §7 deferredRungs).
 */

/**
 * @typedef {object} TubeNet
 * @property {import('../../scene/mask-derive.js').MaskGridSpec} spec
 * @property {number} tubeCount
 * @property {Uint16Array} tubeIdByTexel - w*h, 0 = not tube, else `Tube.id`.
 * @property {Float32Array} sByTexel - w*h, arc length 0..1. Meaningless (0)
 *   where `tubeIdByTexel` is 0 — the id is the gate, never a sentinel in `s`.
 * @property {Float64Array} wallDistByTexel - w*h, distance from this texel to
 *   the tube wall in world px (`chamferRadius`'s output, boundary-corrected).
 *   Returned rather than kept private because `fluid-pack.js` needs it for the
 *   pack's `across` channel and recomputing a chamfer transform there would be
 *   a second implementation of one measurement — the shape `Water.md` §2.4's
 *   two disagreeing GGX stacks warn about.
 * @property {number} samplesPerTube
 * @property {Tube[]} tubes
 * @property {{small: number, overCap: number}} dropped
 * @property {string[]} warnings - EVERY lossy decision, in English. Empty means
 *   nothing was dropped; the caller is expected to surface these, because a cap
 *   that truncates silently reads as "covered everything".
 */

/**
 * Extract the tube net from a rasterised `fluid` mask grid.
 *
 * @param {object} args
 * @param {import('../../scene/mask-derive.js').MaskGrid} args.grid - the
 *   authority's rasterised `fluid` product (`getDerived('fluid', floor)`).
 * @param {number} [args.presenceMinByte]
 * @param {number} [args.minTubeTexels]
 * @param {number} [args.maxTubes]
 * @param {number} [args.samplesPerTube]
 * @param {number} [args.hintMinCorrelation]
 * @returns {TubeNet}
 */
export function extractTubeNet({
  grid,
  presenceMinByte = FLUID_PRESENCE_MIN_BYTE,
  minTubeTexels = FLUID_MIN_TUBE_TEXELS,
  maxTubes = FLUID_MAX_TUBES,
  samplesPerTube = FLUID_PROFILE_SAMPLES,
  hintMinCorrelation = FLUID_HINT_MIN_CORRELATION,
} = {}) {
  if (!grid || !grid.spec || !grid.data) {
    throw new Error(
      "extractTubeNet: needs a MaskGrid ({spec, data}) — pass the authority's rasterised `fluid` " +
        'product from getDerived("fluid", floorIndex), not a raw array. There is no useful default: a ' +
        'missing grid means the mask never reached the CPU, which is a wiring fault, not "no tubes".'
    );
  }

  const { w, h, texelW, texelH } = grid.spec;
  const data = grid.data;
  /** @type {string[]} */
  const warnings = [];

  const present = new Uint8Array(w * h);
  for (let i = 0; i < present.length; i++) present[i] = data[i] >= presenceMinByte ? 1 : 0;

  const { tubeId, sizes } = labelComponents(present, w, h);

  // Rank components by size so both filters below keep the tubes that matter.
  const ranked = sizes
    .map((count, idx) => ({ label: idx + 1, count }))
    .filter((c) => c.count >= minTubeTexels)
    .sort((a, b) => b.count - a.count);

  const droppedSmall = sizes.length - ranked.length;
  if (droppedSmall > 0) {
    warnings.push(
      `${droppedSmall} component(s) under ${minTubeTexels} texels dropped as speckle. If a real tube ` +
        'vanished, it is painted thinner than the mask grid can resolve — paint it wider, not this lower.'
    );
  }

  const kept = ranked.slice(0, maxTubes);
  const droppedOverCap = ranked.length - kept.length;
  if (droppedOverCap > 0) {
    const lost = ranked.slice(maxTubes).reduce((n, c) => n + c.count, 0);
    warnings.push(
      `${droppedOverCap} tube(s) dropped: the scene painted ${ranked.length} but the state texture ` +
        `holds ${maxTubes} rows (FLUID_MAX_TUBES). The largest ${maxTubes} were kept; ${lost} texels ` +
        'of painted tube will not animate.'
    );
  }

  const keptLabels = new Set(kept.map((c) => c.label));
  // Re-label to a dense 1..n so `tubeIdByTexel` indexes state rows directly and
  // a dropped component leaves no hole for a consumer to trip over.
  const remap = new Uint16Array(sizes.length + 1);
  kept.forEach((c, i) => {
    remap[c.label] = i + 1;
  });
  const tubeIdByTexel = new Uint16Array(w * h);
  for (let i = 0; i < tubeIdByTexel.length; i++) {
    const old = tubeId[i];
    tubeIdByTexel[i] = old !== 0 && keptLabels.has(old) ? remap[old] : 0;
  }
  for (let i = 0; i < present.length; i++) present[i] = tubeIdByTexel[i] !== 0 ? 1 : 0;

  const dtRadius = chamferRadius(present, w, h, texelW, texelH);
  const inner = interiorness(present, w, h);
  const sByTexel = new Float32Array(w * h);
  /** @type {Tube[]} */
  const tubes = [];

  // Every tube's member list in ONE pass. Scanning the whole grid once per tube
  // instead would be 64 × 262,144 comparisons on a full-size grid, for data a
  // single sweep already has in hand.
  /** @type {number[][]} */
  const membersByTube = kept.map(() => []);
  for (let i = 0; i < tubeIdByTexel.length; i++) {
    const id = tubeIdByTexel[i];
    if (id !== 0) membersByTube[id - 1].push(i);
  }

  // Three reusable sweep buffers — see `geodesicFrom`'s `scratch`. Two must be
  // live at once (distance from the root AND from the tip); the third carries
  // the throwaway first sweep.
  const scratch = [0, 1, 2].map(() => ({
    dist: new Float64Array(w * h),
    settled: new Uint8Array(w * h),
  }));

  for (let t = 0; t < kept.length; t++) {
    const label = t + 1;
    const members = membersByTube[t];

    const common = { present, tubeId: tubeIdByTexel, label, w, h, texelW, texelH };
    // The double sweep: from anywhere to the far end A, then A to the far end
    // B. A→B is the component's geodesic diameter, which is the only defensible
    // "along the tube" axis available without asking the author to mark ends.
    const sweep1 = geodesicFrom({ ...common, source: members[0], scratch: scratch[2], resetList: members });
    const fromA = geodesicFrom({ ...common, source: sweep1.farthest, scratch: scratch[0], resetList: members });
    const fromB = geodesicFrom({ ...common, source: fromA.farthest, scratch: scratch[1], resetList: members });
    const lengthPx = fromA.farthestDist;

    let rootTexel = sweep1.farthest;
    let tipTexel = fromA.farthest;
    let distFromRoot = fromA.dist;
    let distFromTip = fromB.dist;

    // Orientation. Weight by interiorness SQUARED so an antialiased boundary
    // texel (whose byte is coverage × ramp, not ramp) contributes ~1/64th of a
    // fully-interior one — see the module header's one-byte hazard.
    const hint = [];
    const dvals = [];
    const weight = [];
    for (const i of members) {
      const wgt = (inner[i] / 8) ** 2;
      if (wgt <= 0) continue;
      hint.push(data[i] / 255);
      dvals.push(distFromRoot[i]);
      weight.push(wgt);
    }
    let corr = weightedCorrelation(hint, dvals, weight);
    /** @type {'hint'|'geometry'} */
    let orientedBy = 'geometry';
    if (Math.abs(corr) >= hintMinCorrelation) {
      orientedBy = 'hint';
      // s = 0 must be the BRIGHT end (the catalog's declared polarity, which
      // preserves V2's bright→dark flow for existing art), so the hint must
      // DECREASE with distance from the root. A positive correlation means the
      // current root sits at the dark end — swap, and the correlation reported
      // is the one against the FINAL root, so a correctly oriented tube always
      // reads negative.
      if (corr > 0) {
        const tmpTexel = rootTexel;
        rootTexel = tipTexel;
        tipTexel = tmpTexel;
        const tmpDist = distFromRoot;
        distFromRoot = distFromTip;
        distFromTip = tmpDist;
        corr = -corr;
      }
    }

    const binAreaProfile = new Float64Array(samplesPerTube);
    const radiusProfile = new Float64Array(samplesPerTube);
    const populated = new Uint8Array(samplesPerTube);
    const texelArea = texelW * texelH;
    let maxRadiusPx = 0;
    let offPath = 0;
    const diagStep = Math.hypot(texelW, texelH);

    for (const i of members) {
      const d = distFromRoot[i];
      const s = lengthPx > 0 && Number.isFinite(d) ? Math.min(1, Math.max(0, d / lengthPx)) : 0;
      sByTexel[i] = s;
      const bin = Math.min(samplesPerTube - 1, Math.floor(s * samplesPerTube));
      binAreaProfile[bin] += texelArea;
      if (dtRadius[i] > radiusProfile[bin]) radiusProfile[bin] = dtRadius[i];
      populated[bin] = 1;
      if (dtRadius[i] > maxRadiusPx) maxRadiusPx = dtRadius[i];
      // A texel is "on the corridor" if going root→it→tip is no longer than
      // going root→tip, allowing for the detour of stepping out to the tube
      // wall and back.
      const tol = 2 * dtRadius[i] + diagStep;
      if (Number.isFinite(distFromTip[i]) && distFromRoot[i] + distFromTip[i] > lengthPx + tol) offPath++;
    }

    // Empty bins are filled from the nearest populated bin, NOT left at zero:
    // area is a DIVISOR (v = Q/A, the continuity relation that makes goo speed
    // up through a constriction), so a zero bin is a singularity that would
    // fling a slug across the tube in one step. Reported via `filledBins`.
    const filledBins = fillEmptyBins(binAreaProfile, radiusProfile, populated);

    // Cross-section is DERIVED, never measured separately — two independent
    // measurements of the same geometry are two things that can disagree, and
    // `Water.md` §2.4's two GGX stacks with different `k` terms are what that
    // looks like after a year.
    const binLengthPx = lengthPx > 0 ? lengthPx / samplesPerTube : 0;
    const crossSectionProfile = new Float64Array(samplesPerTube);
    if (binLengthPx > 0) {
      for (let b = 0; b < samplesPerTube; b++) crossSectionProfile[b] = binAreaProfile[b] / binLengthPx;
    }

    tubes.push({
      id: label,
      row: t,
      texelCount: members.length,
      lengthPx,
      rootTexel,
      tipTexel,
      orientedBy,
      hintCorrelation: corr,
      binAreaProfile,
      crossSectionProfile,
      radiusProfile,
      maxRadiusPx,
      filledBins,
      offPathFraction: members.length > 0 ? offPath / members.length : 0,
    });
  }

  return {
    spec: grid.spec,
    tubeCount: tubes.length,
    tubeIdByTexel,
    sByTexel,
    wallDistByTexel: dtRadius,
    samplesPerTube,
    tubes,
    dropped: { small: droppedSmall, overCap: droppedOverCap },
    warnings,
  };
}

/**
 * Fill unpopulated profile bins from the NEAREST populated one, in place.
 *
 * Nearest in either direction, resolved by two index sweeps rather than by
 * copying values forward — copying would propagate a filled value into the next
 * gap and drift a short tube's whole profile toward whichever end happened to
 * be scanned first.
 *
 * A tube shorter than `samplesPerTube` texels has more bins than texels, so
 * gaps are NORMAL, not a fault; what would be a fault is leaving them at zero,
 * because area is the divisor in `v = Q/A`.
 *
 * @param {Float64Array} area @param {Float64Array} radius @param {Uint8Array} populated
 * @returns {number} how many bins were filled.
 */
export function fillEmptyBins(area, radius, populated) {
  const n = populated.length;
  const leftSrc = new Int32Array(n).fill(-1);
  const rightSrc = new Int32Array(n).fill(-1);

  let last = -1;
  for (let i = 0; i < n; i++) {
    if (populated[i]) last = i;
    leftSrc[i] = last;
  }
  let next = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (populated[i]) next = i;
    rightSrc[i] = next;
  }

  let filled = 0;
  for (let i = 0; i < n; i++) {
    if (populated[i]) continue;
    const l = leftSrc[i];
    const r = rightSrc[i];
    // No populated bin anywhere means the tube contributed no texels at all,
    // which `extractTubeNet` cannot produce (a component has ≥ minTubeTexels).
    // Leaving zeros here would be the honest answer if it ever did.
    if (l < 0 && r < 0) continue;
    const src = l < 0 ? r : r < 0 ? l : i - l <= r - i ? l : r;
    area[i] = area[src];
    radius[i] = radius[src];
    filled++;
  }
  return filled;
}
