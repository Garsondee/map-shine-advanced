/**
 * DRIP SPAWN POINTS — where a roofline sings (Precipitation.md §4.3).
 *
 * ============================================================================
 * ⭐ THE V2 TRAGEDY THIS EXISTS TO NOT REPEAT
 * ============================================================================
 *
 * V2's roof drips *"never reliably worked"*, and §4.3 names the cause exactly:
 * its union-find edge labelling was **correct** (`legacy/particles/
 * RoofDripEdgeSampling.js` is harvest-grade), but its screen→world mapping was
 * **voted on at runtime between four Y-flip candidates** (`_probeBestNdcMode`).
 * A system that has to guess which of four flips it is in has already lost.
 *
 * ⚠️ THE FIX IS NOT A BETTER GUESS — IT IS MAKING THE QUESTION UNASKABLE. This
 * module reads a `MaskGrid`, whose coordinate convention is fixed, documented
 * and Node-tested across the whole project: **row 0 is the world rect's minY
 * edge**, texel centres map to world by a plain lerp. There is no screen space
 * anywhere in this file, no NDC, no camera, and therefore no flip to vote on
 * (`feedback_y_flip_recurring_risk`, bitten five times).
 *
 * ============================================================================
 * ⭐ THE EDGE IS `coverAbove`'s OWN BOUNDARY — NOTHING NEW IS AUTHORED
 * ============================================================================
 *
 * §4.3 asks for *"roof and canopy edges"*. That is precisely a texel where
 * something overhead ends: `coverAbove` high here, low next door. The mask
 * authority already derives `coverAbove` per floor for the sun and for sky
 * reach, so the roofline comes out of a product that already exists — no new
 * mask, no new authoring, and (the part that matters) it is automatically
 * RIGHT for whatever the artist drew, including canopies, awnings and bridges.
 *
 * ⚠️ AND IT IS PER FLOOR, WHICH IS THE WHOLE POINT. Standing on the ground you
 * drip from the eaves above you; standing on the roof there is nothing overhead
 * and the roofline stops singing, because from up there it is not an edge of
 * anything. That falls out of `coverAbove` being a per-floor product rather
 * than being special-cased here.
 *
 * ============================================================================
 * WHY THIS IS PURE
 * ============================================================================
 *
 * No THREE, no GPU, no clock — a grid in, world-space points out. The whole
 * geometry is a Node test, which is the only rung at which a Y-flip is
 * genuinely provable: a pixel can be looked at, but only an assertion can say
 * *"the point at grid row 0 has world y = rect.minY"* and keep saying it.
 *
 * ============================================================================
 * ⭐ A SECOND EXTRACTOR: AUTHORED POINTS, NOT AN EDGE (mythica-machina-press#316)
 * ============================================================================
 *
 * {@link extractDripMaskPoints} reads a hand-painted `_Drip` mask
 * (`scene/mask-catalog.js`'s `drip` kind) rather than the auto-derived
 * `coverAbove` roofline above — the author's own words: *"the `_Drip` mask
 * will have white pixels where the drips should spawn from."* Cave ceilings,
 * a leaking pipe, condensation on a specific wall: places nothing above them
 * casts a `coverAbove` edge over, so the roofline can never find them, and the
 * author wants to mark the exact spot by hand instead.
 *
 * ⚠️ NO EDGE TEST, AND THAT IS THE WHOLE DIFFERENCE FROM {@link extractDripEdges}
 * ABOVE. A roofline is a SILHOUETTE — only a boundary texel sheds water — but an
 * authored mask is the author POINTING at exact spots, so every painted texel
 * is a legitimate spawn point, not just the ones on a perimeter. This is
 * `effects/fire/fire-spawn-points.js`'s own distinction, verbatim: *"a
 * distribution needs the mask's density; only an edge needs its resolution."*
 * Fittingly, the SUBSAMPLING technique below is fire's own fractional
 * accumulator, not this file's own integer stride just above — see that
 * function's header for the density-cliff bug the fractional form avoids, and
 * see `extractDripMaskPoints`'s own header for why the older integer stride
 * stays exactly as it is here rather than being "fixed" to match.
 *
 * The coordinate convention — texel CENTRES, row 0 = `spec.y` (minY), world px
 * throughout — is unchanged, because it is a property of `MaskGrid` itself,
 * not of the roofline's own edge-detection. Both extractors, and both kinds of
 * point, feed the SAME `precip-drip-runtime.js` particle engine, just two
 * independent instances of it (`precip-subsystem.js`'s `drips` and
 * `authoredDrips`) — one hand-painted set of spawn points is exactly as valid
 * an input to that engine as one derived from a roofline.
 *
 * @module effects/precipitation/drip-edges
 */

/**
 * How covered a texel must be to count as "roof". A byte threshold rather than
 * "> 0" because `coverAbove` is a coarse rasterisation of real art — its
 * boundary texels hold partial coverage, and treating a 3% sliver as roof would
 * hang drips in mid-air a texel outside the building.
 */
export const COVER_THRESHOLD = 0.5;

/**
 * …and how UNcovered a neighbour must be for the pair to be an EDGE.
 *
 * ⚠️ TWO THRESHOLDS, NOT ONE, AND THE GAP BETWEEN THEM IS DELIBERATE. With a
 * single cut every texel on a soft boundary is both "covered" and "next to
 * uncovered", so a gently-faded canopy rim produces a BAND of spawn points
 * several texels deep instead of a line. Requiring the neighbour to be properly
 * open puts the drips on the outermost row only
 * (`feedback_narrow_tolerance_between_march_samples`'s cousin: a boundary needs
 * two levels to be a boundary).
 */
export const OPEN_THRESHOLD = 0.25;

/** Cap on extracted points. A roofline is a line, not an area — a few hundred
 * points render a whole mansion's eaves. Exceeding it SUBSAMPLES with a stride
 * rather than truncating, so a big map drips evenly instead of only along
 * whichever edge the scan happened to reach first. */
export const MAX_DRIP_POINTS = 512;

/**
 * Extract drip spawn points from a floor's `coverAbove` grid.
 *
 * @param {{spec: object, data: Uint8Array}} grid - a `MaskGrid`. `spec` carries
 *   `{w, h, x, y, width, height}` in WORLD units; row 0 is `spec.y` (minY).
 * @param {object} [options]
 * @param {number} [options.maxPoints]
 * @param {number} [options.coverThreshold]
 * @param {number} [options.openThreshold]
 * @param {{spec: object, data: Uint8Array}} [options.heightGrid] - the floor's
 *   `casterHeight` grid (a byte over {@link options.heightScalePx}). ⭐ §4.3:
 *   *"each drip is born at its edge's own `coverHeightAt` deck altitude — a
 *   bridge drips from bridge height, an awning from awning height, with zero
 *   authoring."* Sampled HERE, on the CPU, at extraction time, so the height
 *   rides in the spawn point itself and no second texture has to be baked and
 *   kept in sync with this one.
 * @param {number} [options.heightScalePx] - `CASTER_HEIGHT_SCALE_PX`.
 * @param {number} [options.defaultHeightPx] - used where the height grid is
 *   absent or reads zero. ⚠️ NOT a silent fallback: `heightSource` in the
 *   result says which was used, because "every drip fell from the same height"
 *   and "the deck heights are all equal" look identical on screen and are very
 *   different facts (`feedback_absent_zone_row_is_a_measurement`).
 * @returns {{points: Float32Array, count: number, edgeTexels: number, stride: number,
 *   heightSource: string, meanHeightPx: number}}
 *   `points` is `[x0, y0, h0, x1, y1, h1, …]` — world px, world px, world px. Empty on any malformed
 *   input — a roofline that cannot be found must produce NO drips, never a
 *   guessed one, because a drip in the wrong place is worse than no drip at all
 *   (it is the exact V2 failure this module is named after).
 */
export function extractDripEdges(grid, options = {}) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  const empty = { points: new Float32Array(0), count: 0, edgeTexels: 0, stride: 1 };
  if (!spec || !data) return empty;
  const w = spec.w | 0;
  const h = spec.h | 0;
  if (w <= 0 || h <= 0 || data.length < w * h) return empty;

  const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? MAX_DRIP_POINTS));
  const coverCut = clamp01(options.coverThreshold ?? COVER_THRESHOLD) * 255;
  const openCut = clamp01(options.openThreshold ?? OPEN_THRESHOLD) * 255;
  const heightGrid = options.heightGrid?.data && options.heightGrid?.spec ? options.heightGrid : null;
  const heightScale = Number.isFinite(options.heightScalePx) ? options.heightScalePx : 2048;
  const defaultHeight = Number.isFinite(options.defaultHeightPx) ? options.defaultHeightPx : DEFAULT_DECK_HEIGHT_PX;

  /**
   * ⚠️ THE DOWNWARD NEIGHBOUR IS NOT SPECIAL, AND THAT IS A CHOICE. A real
   * roof drips off whichever edge the water runs to, which top-down is every
   * edge of the footprint — an eave on the north side sings exactly as much as
   * one on the south. Preferring +Y ("the bottom of the sprite") would be
   * importing a SIDE view's intuition into a plan view, which is the same
   * category error the splash smear made.
   */
  const isEdge = (x, y) => {
    if (data[y * w + x] < coverCut) return false;
    if (x > 0 && data[y * w + (x - 1)] <= openCut) return true;
    if (x < w - 1 && data[y * w + (x + 1)] <= openCut) return true;
    if (y > 0 && data[(y - 1) * w + x] <= openCut) return true;
    if (y < h - 1 && data[(y + 1) * w + x] <= openCut) return true;
    // A texel on the grid's own border with cover right up to it is an edge of
    // the MAP, not of a roof. Excluded: the world simply continues there, and
    // hanging drips along the rect boundary would outline the map.
    return false;
  };

  // Pass 1 — count, so the stride is chosen before anything is allocated.
  let edgeTexels = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isEdge(x, y)) edgeTexels++;
  if (edgeTexels === 0) return empty;

  const stride = Math.max(1, Math.ceil(edgeTexels / maxPoints));
  const count = Math.min(maxPoints, Math.ceil(edgeTexels / stride));
  const points = new Float32Array(count * 3);

  const texelW = Number.isFinite(spec.texelW) && spec.texelW > 0 ? spec.texelW : spec.width / w;
  const texelH = Number.isFinite(spec.texelH) && spec.texelH > 0 ? spec.texelH : spec.height / h;

  let seen = 0;
  let written = 0;
  let heightSum = 0;
  let defaults = 0;
  for (let y = 0; y < h && written < count; y++) {
    for (let x = 0; x < w && written < count; x++) {
      if (!isEdge(x, y)) continue;
      if (seen++ % stride !== 0) continue;
      // ⚠️ TEXEL **CENTRES**, and row 0 IS minY. Both halves are the whole
      // reason this module is pure: they are assertions in the Node suite
      // rather than a convention someone remembered.
      const wx = spec.x + (x + 0.5) * texelW;
      const wy = spec.y + (y + 0.5) * texelH;
      points[written * 3] = wx;
      points[written * 3 + 1] = wy;
      // ⭐ THE DECK's OWN ALTITUDE. Sampled at the edge texel itself, so a
      // bridge drips from bridge height and an awning from awning height with
      // nothing authored. Zero (or no grid) falls back to a plausible eave
      // rather than to the ground — a drip born at height 0 has already landed.
      let heightPx = 0;
      if (heightGrid) {
        const hb = sampleGridByte(heightGrid, wx, wy);
        if (hb !== null) heightPx = (hb / 255) * heightScale;
      }
      points[written * 3 + 2] = heightPx > 1 ? heightPx : defaultHeight;
      if (heightPx > 1) heightSum += heightPx;
      else defaults++;
      written++;
    }
  }

  const measured = written - defaults;
  return {
    points: points.subarray(0, written * 3),
    count: written,
    edgeTexels,
    stride,
    // Which is it: real deck altitudes, the fallback, or a mix? Named rather
    // than inferred — see the `defaultHeightPx` note.
    heightSource: !heightGrid
      ? 'default (no height grid)'
      : measured === 0
        ? 'default (grid read zero everywhere)'
        : defaults === 0
          ? 'measured'
          : `mixed (${measured}/${written} measured)`,
    meanHeightPx: measured > 0 ? heightSum / measured : defaultHeight,
  };
}

/**
 * A typical eave, in world px, for edges whose deck altitude is unknown.
 * ~3 grid squares at a 100px grid: high enough that a drip visibly FALLS,
 * low enough that it does not read as rain starting halfway up the sky.
 */
export const DEFAULT_DECK_HEIGHT_PX = 300;

/**
 * Sample a `MaskGrid` byte at a WORLD position, or null outside it.
 * Row 0 = `spec.y` (minY) — the one convention, stated at every use.
 */
function sampleGridByte(grid, wx, wy) {
  const { spec, data } = grid;
  const w = spec.w | 0;
  const h = spec.h | 0;
  if (!(w > 0 && h > 0)) return null;
  const gx = Math.floor(((wx - spec.x) / spec.width) * w);
  const gy = Math.floor(((wy - spec.y) / spec.height) * h);
  if (gx < 0 || gy < 0 || gx >= w || gy >= h) return null;
  return data[gy * w + gx] ?? null;
}

/**
 * A cheap signature of a grid's edge content, so a caller can tell whether the
 * roofline actually CHANGED before re-extracting and re-uploading.
 *
 * Mirrors `fire-spawn-points.js#fireSpawnSignature`'s job: the mask authority
 * bumps its products version for any edit to any product, so "the version
 * moved" is far weaker than "MY input moved". Re-extracting on every version
 * bump would re-upload a few hundred points every time an unrelated mask was
 * touched.
 *
 * @param {{spec: object, data: Uint8Array}} grid
 * @returns {string}
 */
export function dripEdgeSignature(grid) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  if (!spec || !data) return 'none';
  const w = spec.w | 0;
  const h = spec.h | 0;
  let sum = 0;
  let covered = 0;
  /**
   * ⚠️ EVERY TEXEL, AND THE FIRST CUT STRODE BY 7 — which the Node suite
   * caught immediately: two rooflines differing by one column signed
   * IDENTICALLY, because the three changed texels never landed on a sampled
   * index. A signature that can miss a change is worse than no signature,
   * because the caller then trusts a stale roofline and the drips keep falling
   * off an eave that has moved.
   *
   * The stride was a premature optimisation against a cost that does not
   * exist: this runs on a mask-version bump (not per frame), and a full walk of
   * the largest grid this project produces is a fraction of a millisecond —
   * far less than the extraction it exists to skip.
   */
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sum = (sum + v * (i + 1)) % 2147483647;
    if (v >= COVER_THRESHOLD * 255) covered++;
  }
  return `${w}x${h}:${covered}:${sum}`;
}

/**
 * Paint value above which a texel of an AUTHORED `_Drip` mask counts as a
 * spawn point.
 *
 * ⚠️ LOWER THAN `COVER_THRESHOLD`, AND FOR THE SAME REASON
 * `fire-spawn-points.js`'s own `SPAWN_THRESHOLD` sits below `fire-mask.js`'s:
 * `COVER_THRESHOLD` above answers "is this texel confidently ROOF" (feeding a
 * silhouette that must not hang drips a texel outside the building), while
 * this answers "may a drip be born here" — a faint, partially-painted edge of
 * a hand-drawn patch legitimately produces a faint scatter of drips rather
 * than none at all.
 */
export const DRIP_MASK_SPAWN_THRESHOLD = 0.15;

/**
 * Cap on extracted points. Matches {@link MAX_DRIP_POINTS} — the roofline's own
 * cap — because there is no evidence yet that an authored mask needs a
 * different ceiling. An authored `_Drip` patch is realistically far sparser
 * than a whole building's eaves (a handful of specific spots, not a
 * silhouette), so in practice this cap is rarely the thing doing the work.
 */
export const MAX_DRIP_MASK_POINTS = 512;

/**
 * Extract drip spawn points from a hand-painted `_Drip` mask — every painted
 * texel is a candidate, not just the ones on a boundary. See this module's own
 * header (*"A SECOND EXTRACTOR"*) for why that is the entire difference from
 * {@link extractDripEdges} above, and why the subsampling below is fire's
 * fractional accumulator rather than this file's own integer stride.
 *
 * @param {{spec: object, data: Uint8Array}} grid - a `MaskGrid` for the `drip`
 *   kind (`maskAuthority.getDerived('drip', floorIndex)`). `spec` carries
 *   `{w, h, x, y, width, height}` in WORLD units; row 0 is `spec.y` (minY) —
 *   the one convention, unchanged from {@link extractDripEdges}.
 * @param {object} [options]
 * @param {number} [options.maxPoints]
 * @param {number} [options.threshold] - 0..1 paint value; see
 *   {@link DRIP_MASK_SPAWN_THRESHOLD}.
 * @param {{spec: object, data: Uint8Array}} [options.heightGrid] - the floor's
 *   `casterHeight` grid, sampled exactly as {@link extractDripEdges} samples
 *   it — an authored drip is just as entitled to its own deck altitude as an
 *   auto-detected one (a patch on a bridge drips from bridge height).
 * @param {number} [options.heightScalePx] - `CASTER_HEIGHT_SCALE_PX`.
 * @param {number} [options.defaultHeightPx] - falls back to
 *   {@link DEFAULT_DECK_HEIGHT_PX}, the identical fallback the roofline uses.
 * @returns {{points: Float32Array, count: number, edgeTexels: number, stride: number,
 *   heightSource: string, meanHeightPx: number}}
 *   The IDENTICAL shape {@link extractDripEdges} returns — a drop-in for
 *   whatever consumes it — but two of the names carry a different meaning
 *   here: `edgeTexels` is the PAINTED texel count (there is no "edge" in this
 *   extractor), and `stride` is `keepEvery` from the fractional accumulator
 *   (a float ≥ 1, the natural generalisation of an integer stride — see
 *   `fire-spawn-points.js#extractFireSpawnPoints`). Empty on any malformed
 *   input, for the same reason `extractDripEdges` returns empty rather than a
 *   guess: a drip in the wrong place is worse than no drip.
 */
export function extractDripMaskPoints(grid, options = {}) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  const empty = { points: new Float32Array(0), count: 0, edgeTexels: 0, stride: 1 };
  if (!spec || !data) return empty;
  const w = spec.w | 0;
  const h = spec.h | 0;
  if (w <= 0 || h <= 0 || data.length < w * h) return empty;

  const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? MAX_DRIP_MASK_POINTS));
  const cut = clamp01(options.threshold ?? DRIP_MASK_SPAWN_THRESHOLD) * 255;
  const heightGrid = options.heightGrid?.data && options.heightGrid?.spec ? options.heightGrid : null;
  const heightScale = Number.isFinite(options.heightScalePx) ? options.heightScalePx : 2048;
  const defaultHeight = Number.isFinite(options.defaultHeightPx) ? options.defaultHeightPx : DEFAULT_DECK_HEIGHT_PX;

  // Pass 1 — count, so the fractional accumulator's step is chosen before
  // anything is allocated (the same two-pass shape extractDripEdges uses).
  let painted = 0;
  for (let i = 0; i < w * h; i++) if (data[i] >= cut) painted++;
  if (painted === 0) return empty;

  const texelW = Number.isFinite(spec.texelW) && spec.texelW > 0 ? spec.texelW : spec.width / w;
  const texelH = Number.isFinite(spec.texelH) && spec.texelH > 0 ? spec.texelH : spec.height / h;

  /**
   * ⚠️ A FRACTIONAL ACCUMULATOR, NOT AN INTEGER STRIDE — copied from
   * `fire-spawn-points.js#extractFireSpawnPoints` rather than from this
   * file's own `extractDripEdges` just above (design decision, not an
   * oversight: see this module's header). An integer `Math.ceil(painted /
   * maxPoints)` stride jumps by whole numbers, so crossing ONE painted texel
   * past a multiple of the cap can double the stride and roughly HALVE the
   * spawned count outright — a real, sudden density drop from a single extra
   * painted pixel. `keepEvery` is a FLOAT, so `count` rises smoothly with
   * `painted` right up to the cap instead of sawtoothing.
   */
  const count = Math.min(maxPoints, painted);
  const keepEvery = painted / count;
  const points = new Float32Array(count * 3);

  let seen = 0;
  let nextEmitAt = 0;
  let written = 0;
  let heightSum = 0;
  let defaults = 0;
  for (let y = 0; y < h && written < count; y++) {
    for (let x = 0; x < w && written < count; x++) {
      const v = data[y * w + x];
      if (v < cut) continue;
      // Emit the FIRST eligible texel at or past each `keepEvery`-wide bucket
      // boundary — `count` emissions total, spread evenly across every
      // eligible texel regardless of how close `painted` sits to the cap. See
      // `extractFireSpawnPoints`'s identical loop for the full reasoning.
      if (seen < nextEmitAt) {
        seen++;
        continue;
      }
      nextEmitAt += keepEvery;
      seen++;
      // ⚠️ TEXEL CENTRES, row 0 IS minY — identical convention, no exceptions.
      const wx = spec.x + (x + 0.5) * texelW;
      const wy = spec.y + (y + 0.5) * texelH;
      points[written * 3] = wx;
      points[written * 3 + 1] = wy;
      // THE DECK's OWN ALTITUDE, sampled exactly as extractDripEdges samples
      // it — an authored point is just as entitled to its own height as an
      // edge-derived one (§4.3's promise, kept the same way twice).
      let heightPx = 0;
      if (heightGrid) {
        const hb = sampleGridByte(heightGrid, wx, wy);
        if (hb !== null) heightPx = (hb / 255) * heightScale;
      }
      points[written * 3 + 2] = heightPx > 1 ? heightPx : defaultHeight;
      if (heightPx > 1) heightSum += heightPx;
      else defaults++;
      written++;
    }
  }

  const measured = written - defaults;
  return {
    points: points.subarray(0, written * 3),
    count: written,
    // Not an "edge" — see this function's own header. Named `edgeTexels`
    // anyway so a consumer of either extractor's return shape reads "how many
    // texels qualified before subsampling" the same way either time.
    edgeTexels: painted,
    stride: keepEvery,
    heightSource: !heightGrid
      ? 'default (no height grid)'
      : measured === 0
        ? 'default (grid read zero everywhere)'
        : defaults === 0
          ? 'measured'
          : `mixed (${measured}/${written} measured)`,
    meanHeightPx: measured > 0 ? heightSum / measured : defaultHeight,
  };
}

/**
 * A cheap signature of an authored `_Drip` grid's content, mirroring
 * {@link dripEdgeSignature}'s job and its exact full-walk algorithm — this
 * runs on a mask-version bump, not per frame, so a full walk is cheap and a
 * sampled/strided signature can miss a real change (see that function's own
 * header for the bug a strided first cut produced). The one difference is the
 * threshold: `painted` counts against {@link DRIP_MASK_SPAWN_THRESHOLD}, this
 * extractor's own cut, rather than the roofline's `COVER_THRESHOLD`.
 *
 * @param {{spec: object, data: Uint8Array}} grid
 * @returns {string}
 */
export function dripMaskPointsSignature(grid) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  if (!spec || !data) return 'none';
  const w = spec.w | 0;
  const h = spec.h | 0;
  let sum = 0;
  let painted = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sum = (sum + v * (i + 1)) % 2147483647;
    if (v >= DRIP_MASK_SPAWN_THRESHOLD * 255) painted++;
  }
  return `${w}x${h}:${painted}:${sum}`;
}

/** @param {*} v @returns {number} */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
