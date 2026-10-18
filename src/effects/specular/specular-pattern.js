/**
 * THE SHIMMER FIELD — V2's pattern maths, in plain JS, asserted in Node.
 *
 * `specular-render.js` is the TSL transcription of this file, line for line.
 * This is the twin that makes the transcription checkable
 * (`feedback_smooth_output_hides_ported_bugs`): a shimmer is a smooth output,
 * and a smooth output hides a ported bug indefinitely because every wrong
 * version still looks like *something*.
 *
 * ============================================================================
 * WHY THIS REPLACED A PBR MODEL
 * ============================================================================
 * The effect this supersedes computed GGX lobes, Smith height-correlated
 * visibility, Schlick Fresnel and a split-sum environment BRDF against a
 * synthesised finite eye height. All of it existed to manufacture angular
 * variation, and **an orthographic camera over a flat map has none to
 * manufacture** — `N`, `V` and therefore `N·H` are one number for the whole
 * screen. It shipped invisible four times, each round finding a real zero in a
 * chain of thirteen silent preconditions, and it was never going to converge:
 * the medium cannot carry the quantity the model computed.
 *
 * What a 2D top-down map CAN carry is a **field** — shimmers, gradients and
 * patterns painted across the metal the `_Specular` mask marks, moving with the
 * camera and evolving slowly in time. That is what V2 did, and V2 looked right.
 * This file is V2's algorithm recovered from `legacy/compositor-v2/effects/
 * specular-shader.js`, with its three mislabelled controls renamed to what they
 * actually do.
 *
 * ============================================================================
 * ⚠️ V2'S CONTROL LABELS WERE WRONG, AND THE ALGEBRA IS THE PROOF
 * ============================================================================
 * Work `anisotropicBlob` through by hand:
 *
 *   cell pitch ALONG grain  = 1/scale       (pattern-UV units)
 *   cell pitch ACROSS grain = rowSpacing/scale
 *   Gaussian σ in cell space = 1/√(2·spreadMul) along,
 *                              1/(rowSpacing·√(2·spreadMul)) across
 *
 * Map cell space back to pattern space and **the two `rowSpacing` factors
 * cancel exactly**. At `streak = 0` the blob is perfectly ISOTROPIC. So:
 *
 *   · V2's "Elongation" elongates nothing. It sets ROW SPACING — how far apart
 *     the rows of glints sit across the grain. At its default of 4 you get rows
 *     of round glints running along the grain with wide gaps between rows.
 *   · V2's "Scatter" is the real streak control: it rotates the local offset
 *     by a PER-CELL HASHED ANGLE *before* the anisotropic stretch, which skews
 *     the Gaussian into a directional ellipse. 0 = round dots, 1.7 = randomly
 *     oriented streaks. **This is the single most load-bearing control in the
 *     whole effect and it was named after its least important side effect.**
 *   · V2's "Cluster size" is not a size. It is the threshold WINDOW the blob is
 *     smoothstepped through — a contrast control.
 *
 * The names here describe the mechanism. Porting the labels would port the
 * confusion, and this project has already paid for a control whose name
 * disagreed with its code (`feedback_unconsumed_api_rots_silently`).
 *
 * ============================================================================
 * THE FIELD HAS NO HARD EDGE ANYWHERE (soft-edge rework, 2026-10-18)
 * ============================================================================
 * The author asked for this twice — *"strictly it needs to be gradients and
 * never cut off angles or edges"* (Round 19) and again on 2026-10-18 — and
 * raising the `contrast` floor, the first answer, did not touch the causes.
 * Measured on the real shader (`tools/shader-lab/specular-lab.js`), there were
 * three, and each is fixed at its root rather than damped:
 *
 *   1. **THE LATTICE WAS CUT ALONG ITS OWN CELL BORDERS.** Each pixel evaluated
 *      only the blob of the cell it sat in. A blob jittered/rotated toward a
 *      border (±0.3 cell of jitter plus a ~0.4-cell reach — more than the 0.5
 *      to the border) was sliced off dead straight: a single pixel stepped 0.59
 *      of display luminance in the raw field at quarter zoom (0.032 now), every
 *      few blobs, as long as the cell's side.
 *      `blobExponent` now blends the four NEAREST cells (the 2×2 the point
 *      leans toward) with a smooth minimum, so a blob that crosses a border
 *      simply continues into the next cell. Four cells are provably enough: the
 *      nearest cell not evaluated is ≥ `BLOB_REACH_MIN_DISTANCE` (0.58) of a cell
 *      away, and `blobCutExponent` fades every blob to exactly zero before the
 *      exponent such a cell could reach, less the blend width so it cannot
 *      touch even the smooth minimum — the four-cell result IS the full-lattice
 *      result over the whole parameter space (asserted against a full 3×3 in
 *      `specular-pattern.test.mjs`).
 *   2. **THE CONTRAST WINDOW WAS A THRESHOLDED GAUSSIAN.** `smoothstep(lo, hi,
 *      blob)` is exactly 0 below `lo` (blob 0.15, i.e. 1.9 in the exponent) with
 *      a quadratic foot, so the glint's visible edge — the display's 10 → 90 %
 *      rise — was only 25-159 world px wide for a ROUND blob on the six shipped
 *      layers, and a thin streak's edge is only as wide as the streak is thin.
 *      It is now a LOGISTIC in the blob's exponent (`softWindow`): the same shape
 *      where the eye reads the glint's outline, but with an exponential skirt
 *      instead of a cut — 57-359 px, ≈2.3× wider on every layer at the shipped
 *      defaults. Brightness parity with the old window was MEASURED, not
 *      assumed: mean display luminance of the six-layer field is within 0.5 %
 *      of before and the area above half brightness within 1.5 %
 *      (`SOFT_WINDOW_*`).
 *   3. **`max` ACROSS LAYERS CREASES WHERE TWO SKIRTS CROSS.** Replaced by a
 *      6-norm (`unionLayers`): `max` to within 12 % wherever one layer
 *      dominates, smooth everywhere, and still never stacks brightness.
 *
 * What the CPU twin cannot show is shaded in `specular-render.js`: the
 * light-coupled flicker used to clamp at zero (`max(1 + n·A, 0)`), cutting dark
 * notches into glints with a log-gradient that is unbounded at the clamp. It is
 * now `exp(n·A·gain)` (`flickerFactor`) — strictly positive, bounded slope.
 *
 * @module effects/specular/specular-pattern
 */

/** Rows-of-glints spacing floor.
 *
 * ⚠️ RAISED 0.18 → 1 (soft-edge rework, 2026-10-18). Below 1 the blob is wider
 * ACROSS the grain than a row is tall, so it spills over several rows and the
 * four-cell neighbourhood that makes the lattice seamless can no longer see all
 * of it (a 2×2 misses up to 0.43 of the field at 0.5, and the rest of that range
 * rendered as stacked, chopped strips anyway). 1 is the "even scatter" the Row
 * spacing help text already names as the dense end. */
export const MIN_ROW_SPACING = 1;

/** Gaussian tightness endpoints for `softness` 0..1 — `mix(18, 5, softness)`.
 * 18 is a tight dot, 5 a broad soft pool. V2's `spreadMul`, verbatim. */
export const SPREAD_TIGHT = 18;
export const SPREAD_LOOSE = 5;

/** How far a per-cell hash may jitter a blob off its lattice point, in cells.
 * ±0.3 — enough to destroy the visible grid, small enough that blobs stay in
 * their own cell and the lattice keeps its density guarantee. */
export const CELL_JITTER = 0.6;

/** How far `streak` may rotate a cell, in radians per unit. At V2's default
 * 1.7 this is ±1.19 rad (±68°), i.e. effectively free orientation. */
export const STREAK_RADIANS = 1.4;

/**
 * How much a grain running ACROSS the light is favoured over one running along
 * it — `mix(SUN_BIAS_MIN, 1, |lightDir · grainPerp|)`.
 *
 * 0.35 is V2's, and it is the brushed-metal term: a 2.9× brightness swing per
 * layer as the sun rotates over a day. It is the ONLY way the sun's azimuth
 * reaches this effect, since there is no half-vector to put it in.
 */
export const SUN_BIAS_MIN = 0.35;

/**
 * THE MASK'S ONE ROUGHNESS-LIKE COUPLING — the cellular base's cell count,
 * `mix(2.5, 13, strength)`.
 *
 * Brighter mask ⇒ FINER cells. A polished gold inlay breaks into fine glitter
 * while dull pewter reads as broad soft shapes, from one authored channel and
 * no second mask. Easy to miss in V2's source and visually significant.
 */
export const CELL_SCALE_DULL = 2.5;
export const CELL_SCALE_BRIGHT = 13;

/**
 * How wide, in blob-exponent units, two neighbouring cells' blobs are blended
 * where their outlines meet (`smoothMin`). Narrow enough that a blob far from
 * any neighbour is untouched, wide enough that no crease survives where two
 * meet. Not a look control: it only chooses how the seam between two blobs is
 * rounded.
 */
export const BLOB_BLEND_WIDTH = 0.45;

/**
 * The closest, in cells, a cell OUTSIDE the evaluated 2×2 can be to any point:
 * the point leans toward the 2×2's cells, so the next cell out is a whole cell
 * away, less its own centre jitter — which is a VECTOR of up to
 * `CELL_JITTER/2` on each axis, i.e. `CELL_JITTER/√2` long, not `CELL_JITTER/2`
 * (the first draft of this constant forgot the diagonal and the 2×2 differed
 * from the full lattice by 1e-2 at the loose end of the Softness slider). This
 * is the number the four-cell neighbourhood's exactness rests on.
 */
export const BLOB_REACH_MIN_DISTANCE = 1 - CELL_JITTER / Math.SQRT2;

/**
 * Where, as a fraction of the cut exponent (`blobCutExponent`), the fade to
 * exactly zero begins. Past the cut no cell outside the evaluated 2×2 could
 * have mattered, so the four-cell result IS the full-lattice result — not an
 * approximation that happens to be small. At the shipped softness range
 * (0.31-0.5) the cut sits at an exponent of 3.4-4.2, where the window below is
 * already ~2e-3: it fades the faint outer end of the skirt a little, and it is
 * what makes the loose end of the Softness slider seamless too.
 */
export const BLOB_CUT_ONSET = 0.6;

/**
 * THE SOFT WINDOW — a logistic in the blob's exponent, anchored to where the
 * pre-rework `smoothstep(lo, hi, blob)` put the glint's visible outline.
 *
 * The anchor is the point `SOFT_WINDOW_ANCHOR` of the way up the OLD window
 * (the 22 % point of its smoothstep), because at the shipped gain that is where
 * the eye reads an outline; the logistic is placed so it passes through the
 * same value there, then falls off exponentially instead of being cut.
 * `SOFT_WINDOW_SHARPNESS / (the old window's width in exponent units)` is its
 * steepness, clamped to `[SOFT_SHARP_MIN, SOFT_SHARP_MAX]`: lower is a broader,
 * softer skirt. 3.0 and 0.3 were chosen by sweeping both against the old field
 * and holding mean display luminance (+0.4 %) and the area above half
 * brightness (-1.2 %) while widening every ramp ≈2.3× and cutting the steepest
 * per-pixel step at quarter zoom from 0.44 to 0.08 (`tools/shader-lab`'s
 * `edgeReport` on the real shader agrees with the CPU sweep).
 */
export const SOFT_WINDOW_ANCHOR = 0.3;
export const SOFT_WINDOW_SHARPNESS = 3.0;
export const SOFT_SHARP_MIN = 2.0;
export const SOFT_SHARP_MAX = 5.5;
/** `exp()` argument ceiling — far past where the window is 0, and short of f32 overflow. */
export const SOFT_EXP_CLAMP = 30;

/**
 * The p of the p-norm that joins the six layers. 6 keeps the result within
 * 12 % of `max` where one layer dominates (the author's reason for `max` over
 * `sum`: overlapping layers must not stack brightness) and is smooth where two
 * cross, which `max` is not.
 */
export const LAYER_UNION_POWER = 6;

/**
 * The hash. Deliberately the sin-based one `effects/particles/gust-runtime.js`
 * already uses rather than `TSL.hash`, for two reasons: this codebase's own
 * precedent is not to depend on `TSL.hash` being exported under that name, and
 * a two-line hash is the only kind that can be transcribed into TSL with
 * confidence that both sides compute the same thing.
 *
 * ⚠️ NOT bit-exact against the GPU, and the tests must not assert as if it
 * were — `Math.sin` and a GPU `sin` differ in the last bits. The twin exists to
 * check STRUCTURE (range, determinism, decorrelation, the shape of the blob),
 * never to pin values (`feedback_measure_the_output_not_the_equation`).
 *
 * @param {number} x @param {number} y @returns {number} 0..1
 */
export function hash12(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** @param {number} a @param {number} b @param {number} t @returns {number} */
function mix(a, b, t) {
  return a + (b - a) * t;
}

/** @param {number} x @returns {number} */
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Hermite smoothstep, TSL argument order. @param {number} e0 @param {number} e1
 * @param {number} x @returns {number} */
function smoothstep01(e0, e1, x) {
  const d = e1 - e0;
  if (Math.abs(d) < 1e-9) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / d);
  return t * t * (3 - 2 * t);
}

/**
 * The Gaussian tightness for a `softness` 0..1 — `mix(SPREAD_TIGHT,
 * SPREAD_LOOSE, softness)`, V2's `spreadMul`.
 * @param {number} softness @returns {number}
 */
export function spreadForSoftness(softness) {
  return mix(SPREAD_TIGHT, SPREAD_LOOSE, clamp01(softness));
}

/**
 * Smooth minimum, the polynomial form: EXACTLY `min(a, b)` wherever the two
 * differ by at least `w`, and a C¹ curve (never a crease) where they are
 * closer. Used on blob EXPONENTS, where the smaller exponent is the nearer
 * blob, so this is the smooth union of two blobs.
 * @param {number} a @param {number} b @param {number} w @returns {number}
 */
export function smoothMin(a, b, w) {
  const h = Math.max(w - Math.abs(a - b), 0) / w;
  return Math.min(a, b) - h * h * w * 0.25;
}

/**
 * ONE CELL'S BLOB EXPONENT — `spreadMul · (sx² + sy²)` for the blob hashed to
 * lattice cell (`cellX`, `cellY`), seen from `offX`/`offY` (the point's offset
 * from THAT cell's centre, in cells). `exp(-result)` is the Gaussian.
 *
 * @param {number} cellX @param {number} cellY @param {number} offX @param {number} offY
 * @param {number} rows @param {number} streak @param {number} spreadMul
 * @returns {number} >= 0
 */
export function cellBlobExponent(cellX, cellY, offX, offY, rows, streak, spreadMul) {
  // ⚠️ THE ROTATION HAPPENS BEFORE THE STRETCH, AND THAT ORDER IS THE EFFECT.
  // Rotating a circle then stretching it yields a skewed ellipse with a real
  // orientation; stretching then rotating yields the same ellipse every time,
  // merely turned. Swap these two blocks and every glint on the map becomes
  // identically oriented — the lattice reappears and it reads as wallpaper.
  const rot = (hash12(cellX + 17.3, cellY + 91.7) - 0.5) * streak * STREAK_RADIANS;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  let rx = offX * c - offY * s;
  let ry = offX * s + offY * c;

  // Per-cell jitter, so the lattice is not readable as a grid.
  rx -= (hash12(cellX + 127.1, cellY + 311.7) - 0.5) * CELL_JITTER;
  ry -= (hash12(cellX + 269.5, cellY + 183.3) - 0.5) * CELL_JITTER;

  const sy = ry * rows;
  return (rx * rx + sy * sy) * spreadMul;
}

/**
 * THE BLOB FIELD'S EXPONENT — the smooth union of the four nearest cells' blobs.
 *
 * A hash lattice rotated into the grain's frame, one Gaussian blob per cell,
 * each jittered and rotated by its own hash (see the module header for what
 * each control genuinely does and why three of them are renamed) — and, since
 * the soft-edge rework, every blob is allowed to cross into the next cell.
 *
 * The four cells are the point's own and its three neighbours on the side it
 * leans toward (the sign of its offset from the centre). That is enough and not
 * a heuristic: see `BLOB_REACH_MIN_DISTANCE`.
 *
 * @param {object} args
 * @param {number} args.u @param {number} args.v - pattern-space coordinate.
 * @param {number} args.grainX @param {number} args.grainY - UNIT grain vector.
 * @param {number} args.density - cells per pattern unit along the grain.
 * @param {number} args.rowSpacing - row pitch across the grain, in cells (>= 1).
 * @param {number} args.softness - 0 tight dot .. 1 broad pool.
 * @param {number} args.streak - per-cell rotation amount. THE streak control.
 * @returns {number} the exponent: 0 at a blob's centre, growing outward.
 */
export function blobExponent({ u, v, grainX, grainY, density, rowSpacing, softness, streak }) {
  const rows = Math.max(rowSpacing, MIN_ROW_SPACING);
  const scale = Math.max(density, 0.25);
  // The grain's own frame. `perp` is the grain rotated +90°.
  const perpX = -grainY;
  const perpY = grainX;
  const along = (u * grainX + v * grainY) * scale;
  const across = ((u * perpX + v * perpY) * scale) / rows;

  const cellX = Math.floor(along);
  const cellY = Math.floor(across);
  const offX = along - cellX - 0.5;
  const offY = across - cellY - 0.5;
  const stepX = offX < 0 ? -1 : 1;
  const stepY = offY < 0 ? -1 : 1;
  const spreadMul = spreadForSoftness(softness);

  const e00 = cellBlobExponent(cellX, cellY, offX, offY, rows, streak, spreadMul);
  const e10 = cellBlobExponent(cellX + stepX, cellY, offX - stepX, offY, rows, streak, spreadMul);
  const e01 = cellBlobExponent(cellX, cellY + stepY, offX, offY - stepY, rows, streak, spreadMul);
  const e11 = cellBlobExponent(cellX + stepX, cellY + stepY, offX - stepX, offY - stepY, rows, streak, spreadMul);
  return smoothMin(smoothMin(e00, e10, BLOB_BLEND_WIDTH), smoothMin(e01, e11, BLOB_BLEND_WIDTH), BLOB_BLEND_WIDTH);
}

/**
 * The blob value itself — `exp(-blobExponent)`, 0..1 (marginally above 1 is
 * clamped: two blobs whose centres coincide blend to a slightly negative
 * exponent). Kept as the public name V2's controls and this file's tests speak.
 *
 * @param {object} args - `blobExponent`'s.
 * @returns {number} 0..1
 */
export function anisotropicBlob(args) {
  return Math.min(1, Math.exp(-blobExponent(args)));
}

/**
 * The exponent at which a blob has been faded to exactly zero, and so the last
 * one at which the four-cell neighbourhood can differ from the full lattice.
 *
 * A cell outside the 2×2 is at least `BLOB_REACH_MIN_DISTANCE` away, so its
 * exponent is at least `k · BLOB_REACH_MIN_DISTANCE²` (with `rowSpacing >= 1`
 * the stretch only ever ADDS to the exponent). It can move the smooth minimum
 * only while it is within `BLOB_BLEND_WIDTH` of it, so the window is zero from
 * that exponent less the blend width upward. See `BLOB_CUT_ONSET`.
 * @param {number} spreadMul @returns {number}
 */
export function blobCutExponent(spreadMul) {
  return spreadMul * BLOB_REACH_MIN_DISTANCE * BLOB_REACH_MIN_DISTANCE - BLOB_BLEND_WIDTH;
}

/**
 * The window the soft window REPLACED — `smoothstep(mix(0.55, 0.08, c),
 * mix(0.95, 0.45, c), blob)`. Kept so the new window's placement is derived
 * from it rather than from a second set of magic numbers, and so a test can
 * compare the two.
 * @param {number} contrast @returns {{lo: number, hi: number}}
 */
export function legacyWindow(contrast) {
  const c = clamp01(contrast);
  return { lo: mix(0.55, 0.08, c), hi: mix(0.95, 0.45, c) };
}

/**
 * The soft window's three numbers for a `contrast`: its midpoint and steepness
 * in exponent space, and the factor that scales its peak to exactly 1.
 * Computed on the CPU and pushed as ONE `vec3` uniform per layer — the
 * shader never takes a logarithm.
 *
 * @param {number} contrast 0..1 (the schema allows 0.5..1)
 * @returns {{mid: number, sharp: number, peakInv: number}}
 */
export function softWindowParams(contrast) {
  const { lo, hi } = legacyWindow(contrast);
  const anchorExponent = -Math.log(lo + SOFT_WINDOW_ANCHOR * (hi - lo));
  const legacyWidth = Math.log(hi / lo);
  const sharp = Math.min(SOFT_SHARP_MAX, Math.max(SOFT_SHARP_MIN, SOFT_WINDOW_SHARPNESS / legacyWidth));
  const anchorValue = smoothstep01(0, 1, SOFT_WINDOW_ANCHOR);
  const mid = anchorExponent - Math.log(1 / anchorValue - 1) / sharp;
  // 1 / logistic(0): the blob's centre reads exactly 1, whatever `mid` is.
  const peakInv = 1 + Math.exp(-sharp * mid);
  return { mid, sharp, peakInv };
}

/**
 * THE SOFT WINDOW — a blob exponent in, a 0..1 glint out. See the module header
 * for why it is a logistic and how its placement was chosen.
 *
 * @param {number} e - `blobExponent`'s result.
 * @param {{mid: number, sharp: number, peakInv: number}} wp - `softWindowParams`'s.
 * @param {number} [cutExponent] - `blobCutExponent`'s, to fade the skirt out
 *   where the four-cell neighbourhood stops being exact. Omit for none.
 * @returns {number} 0..1
 */
export function softWindow(e, wp, cutExponent = Infinity) {
  const x = Math.min(wp.sharp * (e - wp.mid), SOFT_EXP_CLAMP);
  const s = Math.min(1, wp.peakInv / (1 + Math.exp(x)));
  if (!Number.isFinite(cutExponent)) return s;
  return s * (1 - smoothstep01(cutExponent * BLOB_CUT_ONSET, cutExponent, e));
}

/**
 * The 6-norm that joins the layers: `(Σ vᵖ)^(1/p)`. See `LAYER_UNION_POWER`.
 * @param {number[]} values each >= 0 @returns {number}
 */
export function unionLayers(values) {
  let sum = 0;
  for (const v of values) sum += Math.pow(Math.max(v, 0), LAYER_UNION_POWER);
  return Math.pow(sum, 1 / LAYER_UNION_POWER);
}

/**
 * How much a layer's grain is favoured by the sun's azimuth. Outdoors only —
 * indoors there is no azimuth to be relative to.
 *
 * @param {number} grainX @param {number} grainY - UNIT grain vector.
 * @param {number} sunAzimuthRad
 * @returns {number} SUN_BIAS_MIN..1
 */
export function sunGrainBias(grainX, grainY, sunAzimuthRad) {
  const lx = Math.cos(sunAzimuthRad);
  const ly = Math.sin(sunAzimuthRad);
  // Against the grain's PERPENDICULAR: a brushed surface throws its highlight
  // across the grooves, not along them.
  const d = Math.abs(lx * -grainY + ly * grainX);
  return mix(SUN_BIAS_MIN, 1, clamp01(d));
}

/**
 * ONE FULL SHIMMER LAYER — blob, contrast window, sun bias.
 *
 * @param {object} args - `blobExponent`'s args, plus:
 * @param {number} args.contrast - 0 = a tight window (small soft pools),
 *   1 = a wide one (broad connected sheen). V2's mislabelled "Cluster size".
 *   The schema stops at 0.5: below that the pools get small enough that no
 *   window can keep their skirt wide.
 * @param {number} [args.sunBias] - `sunGrainBias`'s result, or 1 indoors.
 * @returns {number} 0..1
 */
export function shimmerLayer(args) {
  const e = blobExponent(args);
  return (
    softWindow(e, softWindowParams(args.contrast), blobCutExponent(spreadForSoftness(args.softness))) *
    (args.sunBias ?? 1)
  );
}

/**
 * The cellular base's cell count for a given mask strength — the module
 * header's `CELL_SCALE_*` coupling.
 * @param {number} strength @returns {number}
 */
export function cellScaleForStrength(strength) {
  return mix(CELL_SCALE_DULL, CELL_SCALE_BRIGHT, clamp01(strength));
}

/**
 * HOW FAR THE PATTERN SLIDES when the camera moves — the signature motion, and
 * the one number that decides whether this reads as metal.
 *
 * V2's gain worked out to ≈1:1 in world space at its defaults, meaning the
 * shimmer is very nearly SCREEN-LOCKED: it slides across the map as you pan,
 * exactly as a reflection does, rather than sitting painted on the art. Layer
 * 3's depth was NEGATIVE, so it counter-moved at the same rate — and that
 * relative motion between layers is most of what sells "a highlight sweeping
 * over a surface".
 *
 * Expressed here as a plain multiplier on the view centre, in PATTERN units, so
 * `depth = 1` is exactly the 1:1 case whatever `patternScalePx` is. V2 buried
 * the same relationship in a magic 0.0006 that only came out at 1:1 because it
 * happened to cancel against a `worldPatternScale` of 16384.
 *
 * @param {number} viewCentreX @param {number} viewCentreY
 * @param {number} depthX @param {number} depthY - per-island signed depth.
 * @param {number} strength - the global master.
 * @param {number} patternScalePx
 * @returns {{u: number, v: number}} the pattern-space offset to SUBTRACT.
 */
export function parallaxOffset(viewCentreX, viewCentreY, depthX, depthY, strength, patternScalePx) {
  const s = strength / Math.max(patternScalePx, 1);
  return { u: viewCentreX * depthX * s, v: viewCentreY * depthY * s };
}

/**
 * THE HIGHLIGHT CEILING — a luminance-preserving soft knee on the shine's OWN
 * output, live-diagnosed 2026-07-27 as the fix for two reports that turned out
 * to be one cause: *"metal reads as self-illuminating"* and *"the blend looks
 * washed out instead of intense and colourful."*
 *
 * ============================================================================
 * WHY: THE COMPOSITE HAD NO CEILING OF ITS OWN
 * ============================================================================
 * `shine = tint × (1 + shimmer·gain) × incident × strength` has THREE factors
 * that can each independently exceed 1 — a bright mask tint, a well-lit
 * `incident`, and `(1 + shimmer·gain)` at gain 4 — so their PRODUCT routinely
 * reaches 2-4+ per channel at entirely ordinary settings, not just at extreme
 * ones. That value is added straight into the shared HDR buffer, and whatever
 * tonemap curve runs at present (`neutral` by default — a real filmic operator,
 * not a raw clip) has to compress it hard to fit the display. **Compression of
 * an over-bright signal reads as desaturation** — that IS "washed out" — and a
 * broad, flatly-elevated region compressed this way reads as glued-on light
 * rather than as a surface catching real, local illumination — that IS "self-
 * illuminating". Both complaints were the same overshoot, described twice.
 *
 * The fix is NOT to lower every slider and hope; sliders are exactly what an
 * author WILL push, and the effect should stay well-behaved when they do. The
 * fix is to give the effect its own bounded ceiling, so it can never demand
 * more than a sane share of the frame's own HDR headroom regardless of how the
 * parameters are set — the same reasoning that makes a limiter standard on a
 * mix bus rather than trusting every fader to stay polite.
 *
 * ============================================================================
 * WHY LUMINANCE, NOT PER-CHANNEL
 * ============================================================================
 * Compressing R, G and B independently would compress a saturated colour's
 * DOMINANT channel harder than its others (gold's R compresses more than its
 * B), which shifts the HUE toward neutral — exactly the "less colourful"
 * direction this fix exists to reverse. Computing ONE luminance-based
 * compression factor and applying it to all three channels UNIFORMLY preserves
 * the exact hue and saturation ratio of the input; only the overall brightness
 * is reined in. Rich gold gets DIMMER gold, never paler gold.
 *
 * ============================================================================
 * THE CURVE
 * ============================================================================
 *      L' = ceiling · L / (ceiling + L)
 *
 * Bounded for ALL L (as L→∞, L'→ceiling — never past it, unlike extended
 * Reinhard's own Lwhite, which is a "this maps to white" POINT rather than a
 * true asymptote and overshoots beyond it). Near-IDENTITY for L well below the
 * ceiling (`dL'/dL → 1` as `L → 0`), so ordinary, modest shine is untouched —
 * this only intervenes on genuine excess.
 *
 * @param {number} l - raw luminance, >= 0.
 * @param {number} ceiling - the asymptote this may approach but never exceed.
 * @returns {number} the compressed luminance.
 */
export function reinhardCeiling(l, ceiling) {
  if (l <= 0) return 0;
  return (ceiling * l) / (ceiling + l);
}

/**
 * Apply `reinhardCeiling` to an RGB triple, scaling all three channels by the
 * SAME factor so hue and saturation survive exactly — see the module's own
 * header for why per-channel compression is the wrong tool here.
 *
 * @param {number[]} rgb @param {number[]} lumaWeights - e.g. `LUMA_709`.
 * @param {number} ceiling
 * @returns {number[]} the compressed triple.
 */
export function reinhardCeilingRgb(rgb, lumaWeights, ceiling) {
  const l = rgb[0] * lumaWeights[0] + rgb[1] * lumaWeights[1] + rgb[2] * lumaWeights[2];
  if (l <= 1e-6) return [rgb[0], rgb[1], rgb[2]];
  const compressed = reinhardCeiling(l, ceiling);
  const scale = compressed / l;
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
}

/**
 * THE CPU TWIN OF `incident` — the sRGB EOTF, which is what "how lit is this
 * pixel" actually means in the space this effect adds into.
 *
 * ============================================================================
 * THIS IS THE FIX FOR "METAL SELF-ILLUMINATES IN THE DARK" — and it is the
 * ENGINE'S OWN CURVE, not a tuned exponent. (2026-07-27, probe-measured.)
 * ============================================================================
 * `buf:scene.illum` NEVER REACHES ZERO in an unlit room: Foundry's own
 * `ambientDarkness` is baked into it upstream, so a genuinely dark interior
 * measures ~0.19. The author spotted this unaided from debug channel 19 —
 * *"it's grey to white, not black to white, so if the grey parts are boosting
 * brightness as well as white then that might result in a global floor lift"* —
 * and that is exactly the mechanism.
 *
 * Meanwhile `environmental-light.js` renders the scene through a GAMMA-space
 * multiply, `lit = EOTF(OETF(albedo) x illum)`. So at a real measured point
 * (albedo 0.730, illum 0.188) the visible surface lands at
 * `EOTF(OETF(0.730) x 0.188)` ≈ **0.019**, while this pass — adding in LINEAR
 * space straight off `illum` — was contributing ~0.03-0.12. **Metal rendered
 * 2-6x brighter than the surface beneath it.** A unit mismatch, not a missing
 * gate and not a floor to subtract.
 *
 * The right factor drops out of that same composite: set `albedo = 1` (a
 * perfectly white surface). `OETF(1) = 1`, leaving `lit = EOTF(illum)`. So
 * **`EOTF(illum)` IS "what fraction of full brightness does anything render at
 * under this illumination"**, in precisely the linear space this pass adds
 * into. At 0.188 it returns 0.025 (7.4x darker — the dark room collapses); at
 * 0.866 it returns 0.729 (1.19x — lit metal essentially untouched).
 *
 * ⚠️ **PER CHANNEL, and that is NOT the hue-shift trap `reinhardCeilingRgb`
 * guards against.** This curve is the literal inverse of the OETF the albedo
 * path already takes per channel, so matching it channel-for-channel is what
 * keeps a coloured light's tint identical to what the scene shows. A
 * luminance-scalar version here would be the deviation.
 *
 * ⚠️ It replaces a hand-tuned `pow(luma, 1.7)` that aimed at this exact symptom
 * and was simply too weak — `0.188^1.7 = 0.058`, still ~3x the surroundings,
 * which is why the author reported no improvement. **Do not reintroduce a
 * free exponent here: the correct value is fixed by the composite, and any
 * other number silently desynchronises this effect from the rest of the frame.**
 *
 * @param {number[]} rgb - linear-ish illum sample.
 * @returns {number[]} the same triple through the sRGB EOTF, per channel.
 */
export function incidentFromIllumRgb(rgb) {
  return rgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
}

/**
 * A SEPARATE, ARTISTIC gate on top of `incidentFromIllumRgb` — added ROUND 16
 * (2026-08-03), live report: *"we only get a specular shine in the brighter
 * areas of the map, near candles, point lights or outside at noon. Shadows
 * and lack of light should suppress the specular shine."*
 *
 * ⚠️ **THIS IS NOT THE EXPONENT `incidentFromIllumRgb`'S OWN HEADER WARNS
 * AGAINST.** That warning is about the PHYSICAL term itself: `incident` must
 * equal `EOTF(illum)` exactly, or metal desynchronises from how the rest of
 * the frame responds to the same light. This function never touches
 * `incident` — it consumes the already-correct value and returns a SEPARATE
 * multiplier, the same relationship `reinhardCeiling` above already has to
 * the composite (a later, stylistic reshaping stage, not a correction to the
 * physical term). Skipping this stage entirely reproduces the exact old
 * behaviour, because `steepness = 1` is an identity.
 *
 * Anchored at `incident`'s OWN scale so "full brightness" keeps meaning what
 * it means everywhere else in this effect: bounded input `[0, 1]` maps
 * `0 -> 0` and `1 -> 1` for ANY steepness, so a torch's falloff still reads as
 * a continuous gradient into its edge (no reintroduction of the Round 15
 * "binary on/off" bug) — only the OPEN interval between is reshaped, pulled
 * DOWN for `steepness > 1`. Anything already AT OR ABOVE full brightness
 * (overlapping lights, a sunlit exterior) passes through completely
 * unscaled — this only ever REMOVES shine from dim areas, never adds beyond
 * what `incident` alone already would contribute.
 *
 * Luminance-scaled, not per-channel, for the same reason `reinhardCeilingRgb`
 * is: an independent `pow()` per channel would shrink a coloured light's
 * weakest channel hardest, oversaturating its tint as brightness falls — a
 * second, self-inflicted version of the OTHER open complaint (colour
 * fidelity), not a fix for this one.
 *
 * @param {number[]} rgb - `incidentFromIllumRgb`'s own output.
 * @param {number[]} lumaWeights - e.g. `LUMA_709`.
 * @param {number} steepness - `1` is an identity; higher pulls dim areas down
 *   harder while leaving 0 and 1 fixed.
 * @returns {number[]} the reshaped triple, same hue and saturation as input.
 */
export function steepenIncidentRgb(rgb, lumaWeights, steepness) {
  const luma = Math.max(rgb[0] * lumaWeights[0] + rgb[1] * lumaWeights[1] + rgb[2] * lumaWeights[2], 1e-6);
  const clamped01 = Math.min(luma, 1);
  const excess = Math.max(luma - 1, 0);
  const steepenedLuma = Math.pow(clamped01, steepness) + excess;
  const scale = steepenedLuma / luma;
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
}

/**
 * Default steepness for `steepenIncidentRgb`. `3` (cubic): at half of full
 * brightness the shine's own response falls to an eighth, at 70% it falls to
 * ~34% — decisively darker through ordinary ambient light while a genuinely
 * bright pixel (a candle, a point light, noon sun) is completely unaffected.
 *
 * ⚠️ **LIVE-ADJUSTABLE SINCE ROUND 17 (2026-08-03)** — this shipped as a
 * fixed internal constant for one round, then the author's own channel probe
 * showed it crushing an ORDINARILY lit point (illum ~0.56, nowhere near a
 * dark room) to ~0.3% of its EOTF'd brightness: `illumDirect` luma 0.561 →
 * `incident` (post-EOTF) ≈0.115 → this cubic → ≈0.0015, a ~375× cut from the
 * raw light reading for a point that is not remotely in shadow. That is a
 * very likely direct cause of a live "specular is barely visible any more"
 * report. `specular-render.js` now turns this into `uIncidentSteepness`, a
 * real uniform (`setIncidentSteepness()`), exposed on `SPECULAR_PARAMS` as
 * `incidentSteepness` — `1` is a pass-through (no suppression beyond the
 * EOTF itself), values below `1` actively BOOST dim areas above the linear
 * reading (useful for "make it punch through everywhere" testing), values
 * above `3` suppress harder still.
 *
 * ⚠️ LOWERED 3 → 2.85 (ROUND 18, 2026-08-03) — THE FIRST LIVE-CONFIRMED
 * VALUE. The author dialled this down slightly from the Round 17 default on
 * a real scene, alongside strength/saturation/parallax/shimmerGain/the
 * ceilings, and reported "we have a basic specular effect working again."
 * Barely moved from 3 — this control was already close to right, unlike
 * several of its neighbours.
 *
 * ⚠️ RAISED 2.85 → 7.15 (ROUND 21, 2026-08-05) — new live-tuned defaults,
 * same "the author's own dialled-in scene is the standard" posture as every
 * round above. This is now well past 3, i.e. MORE aggressive suppression of
 * dim/shadowed metal than any earlier round shipped — only genuinely bright
 * points (candles, point lights, direct sun) keep meaningful shine.
 *
 * ⚠️ RAISED 7.15 → 200 — a further live-tuned round, author-confirmed
 * 2026-08-31 ("the darkness response curve was setup and decided by me. It
 * stays, it's correct") after this constant had drifted out of sync with
 * `SPECULAR_PARAMS.incidentSteepness.default` (specular.js), which had
 * already moved to 200 in the working tree. This constant was the stale
 * side, not the param. See `specular-pattern.test.mjs`'s own
 * `litMetalLuma` scenario for the recomputed contrast thresholds this
 * forced — a jump this large changes what "well-lit" produces there too.
 *
 * ⚠️ LOWERED 200 → 36.75 (ROUND 22, 2026-09-09) — new live-tuned defaults;
 * still decisively aggressive suppression of dim/shadowed metal (well past
 * the original 3), just no longer at the extreme this round-21 value shipped.
 *
 * ⚠️ LOWERED 36.75 → 16.55 (ROUND 23, 2026-09-09) — new live-tuned defaults;
 * still well past the original 3, the author's own dialled-in scene,
 * recorded exactly.
 */
export const SPECULAR_INCIDENT_STEEPNESS = 10.5; // LOWERED 16.55 → 10.5 (ROUND 24, 2026-10-17)

/**
 * THE KNEE — the incident-light level at which metal reaches its FULL shine.
 *
 * ============================================================================
 * ⚠️ WHY THIS CONSTANT HAD TO EXIST (measured 2026-08-09, not reasoned)
 * ============================================================================
 *
 * Author, live: *"the light from candles still isn't causing specular surfaces
 * to flash and shine yet."* Measured on the specular bench with production's
 * own darkness floor (0.188), sweeping `illum` and reading `screenContrast`:
 *
 *     illum   0.188  0.25  0.30  0.40  0.55  0.75    1.00
 *     contrast 1.000 1.000 1.000 1.000 1.000 1.001   1.346
 *
 * Metal was **algebraically dead below illum ≈ 0.75** — not merely dim,
 * contrast exactly 1.000 — and only responded approaching 1.0. No candle, and
 * in fact no light in the engine short of direct noon sun, ever gets there.
 *
 * THE MECHANISM. `steepenedLuma = pow(incidentLuma, S)` was applied to a value
 * that had ALREADY been through the sRGB EOTF (≈ ^2.2), so the effective
 * exponent on the light reading was ~15.7 — and, crucially, `pow(x, S)` only
 * returns 1 when `x` is 1. So "full shine" was implicitly anchored at
 * `incidentLuma == 1`, i.e. a perfectly white, fully-bright pixel. An
 * ORDINARY lit point measures `incidentLuma ≈ 0.115` (that figure is the
 * author's own ROUND 17 probe, recorded in {@link SPECULAR_INCIDENT_STEEPNESS}
 * above), and `0.115^7.15 ≈ 1e-8`. The suppression curve was doing its job
 * perfectly against an anchor point nothing in the scene could ever reach.
 *
 * Note the steepness comment directly above already claims "a genuinely bright
 * pixel (a candle, a point light, noon sun) is completely unaffected." The
 * measurement says otherwise for two of those three. It was a reasonable
 * reading of the equation that was never checked against the output
 * (`feedback_measure_the_output_not_the_equation`).
 *
 * ============================================================================
 * WHY A KNEE RATHER THAN JUST LOWERING THE STEEPNESS
 * ============================================================================
 *
 * The author has TWO standing asks that a single exponent cannot satisfy at
 * once — ROUND 16: *"Shadows and lack of light should suppress the specular
 * shine"*, and now: candles must make metal flash. Lowering `S` restores
 * candle shine only by also restoring shine in the dim ambient the ROUND 16
 * ask exists to kill. Separating "how sharply does shine fall off below the
 * knee" (`S`, untouched, still the author's own live-tuned 7.15) from "where
 * IS the knee" (this constant) makes both true simultaneously: full shine from
 * candle-level light and up, hard suppression below it.
 *
 * `0.15` sits just above the author's own measured "ordinarily lit" reading of
 * 0.115, so a candle's bright core clears it outright while its dim outer
 * falloff does not. **A knee of 1.0 reproduces the previous behaviour
 * EXACTLY** (see `specular-render.js`'s own note at the use site — the
 * algebra is identical at K=1), which is what makes this safe to add to a
 * live-tuned effect rather than a retune of it.
 *
 * ⚠️ RAISED 0.15 → 0.22 (ROUND 23, 2026-09-09) — new live-tuned defaults,
 * the first live-tuned value this control has shipped; still just above the
 * author's own measured "ordinarily lit" reading of 0.115, the same posture
 * the original 0.15 argued for, moved slightly higher on a real scene.
 */
export const SPECULAR_INCIDENT_KNEE = 0.01; // LOWERED 0.22 → 0.01 = THE SCHEMA'S OWN MIN (ROUND 24, 2026-10-17)

/**
 * ============================================================================
 * THE CANDLE-LIGHT RESPONSE GROUP (2026-08-09) — author: *"far too much…
 * give me lots of RoH controls so that I can tune the curve"*
 * ============================================================================
 *
 * The knee above fixed "candle-lit metal is algebraically dead" and immediately
 * produced the opposite complaint. That is not a mis-tuned number so much as a
 * missing DIMENSION: with only a knee position and a falloff exponent, the
 * curve's TOP is a hard `min(t,1)` clamp, so every lamp bright enough to clear
 * the knee lands on the identical, maximal, perfectly flat response. These
 * three constants give the top of the curve the same tunability the bottom
 * already had.
 *
 * ⚠️ AND THE FLAT TOP IS ALSO WHY THE FLICKER VANISHED — see
 * `specular-render.js`'s own note at the use site. A saturated curve cannot
 * transmit variation, so no amount of flicker in `buf:scene.illum` could reach
 * the screen once a candle cleared the knee. `SPECULAR_KNEE_SOFTNESS` is
 * therefore doing double duty and is the first control to reach for on EITHER
 * complaint.
 */

/**
 * How gradually the response saturates at the knee. `0` is the hard
 * `min(t, 1)` clamp (byte-identical to how this shipped hours earlier); `1`
 * is a fully exponential approach that never quite reaches full, so brightness
 * rolls off instead of clipping AND light variation keeps modulating all the
 * way up. Default `0.5` — real rolloff, without discarding the knee's whole
 * point of "past here, metal is properly lit."
 */
export const SPECULAR_KNEE_SOFTNESS = 0.66; // RAISED 0.5 → 0.66 (ROUND 24, 2026-10-17)

/**
 * A plain multiplier on the shine response, applied AFTER the curve. The
 * blunt "all of this is too strong" dial, deliberately separate from
 * `strength` (which scales the whole effect including its unlit behaviour) so
 * lamp-lit metal can be pulled back without touching how the effect reads
 * outdoors at noon. Default `0.55`, i.e. a real reduction from the value the
 * author called "far too much" rather than a nominal one — the curve controls
 * around it are what let that be dialled back up per scene.
 */
export const SPECULAR_INCIDENT_GAIN = 0.23; // LOWERED 0.55 → 0.23 (ROUND 24, 2026-10-17)

/**
 * ============================================================================
 * THE LIGHT-COUPLED FLICKER (2026-08-09) — author: *"a bit of organic
 * animation on specular surfaces illuminated by candles"*
 * ============================================================================
 *
 * An independent organic flutter, scaled by how strongly lit each pixel is.
 * ⚠️ It is NOT the candle's own flicker re-derived — `specular-render.js`'s use
 * site explains why that is structurally impossible from a merged `illum`
 * buffer, and why re-deriving it would be a second authority on one value.
 *
 * Defaults are deliberately modest: this is a texture on the light, and the
 * author's own standing instinct on a new look is to see it and then dial it
 * (`feedback_default_on_new_features`), which is much easier from "present but
 * gentle" than from "off" or from "obviously too much".
 */
/** Depth of the flutter, as a fraction of the shine. 0 = off.
 * ⚠️ A zero-mean SPATIAL noise, which is why the bench's `onMetalMean` cannot
 * see it at all and its `onMetalPeak` barely moves — the flutter redistributes
 * brightness across the metal rather than raising it. Verified instead by
 * capturing the frame at amount 0 vs 3 and diffing: visible organic mottling,
 * and a 29% larger PNG (identical images compress identically). Do not "fix"
 * a future flat mean reading here by raising this — read
 * `feedback_aggregate_cannot_name_the_source` first.
 *
 * ⚠️ RAISED 0.5 → 3 = THE SCHEMA'S OWN MAX (ROUND 23, 2026-09-09) — new
 * live-tuned defaults, the first live-tuned value this control has shipped —
 * the author's own dialled-in scene, recorded exactly. */
export const SPECULAR_FLICKER_AMOUNT = 3;
/** Flutter rate. Candle-ish: fast enough to read as flame, slow enough not to strobe.
 *
 * ⚠️ LOWERED 1.6 → 0.1 (ROUND 23, 2026-09-09) — new live-tuned defaults, the
 * first live-tuned value this control has shipped; a slow breathing flutter
 * rather than a fast candle-gutter one. */
export const SPECULAR_FLICKER_SPEED = 0.1;
/** World-space size of one coherent flutter patch, in px. Roughly a candle's
 * own pool of light, so nearby metal flickers together and distant metal does
 * not. */
export const SPECULAR_FLICKER_SCALE_PX = 320;
/** Blend between the two noise octaves: 0 = the broad slow one alone (smooth
 * breathing), 1 = the fine fast one alone (busy guttering).
 *
 * ⚠️ RAISED 0.5 → 0.64 (ROUND 23, 2026-09-09) — new live-tuned defaults, the
 * first live-tuned value this control has shipped. */
export const SPECULAR_FLICKER_ROUGHNESS = 0.64;

/**
 * THE FLUTTER'S SHAPE (soft-edge rework, 2026-10-18) — `exp(LOG_GAIN · amount ·
 * noise · lightWeight)`, replacing `max(1 + amount · noise · lightWeight, 0)`.
 *
 * ⚠️ WHY THE OLD FORM WAS A HARD EDGE FACTORY. At the live amount of 3 the
 * clamp zeroes the shine wherever `noise < -1/3` (a third of the area) and the
 * ramp back up is `3 · |∇noise|` per px ≈ 0.09 — so over ~11 world px the shine
 * went from nothing to full, and the glint's own gain then saturates the display
 * within a couple of px of that. The picture: crisp, crescent-shaped dark notches
 * bitten out of the middle of glints (`slab-effect-s05` in the lab). A
 * multiplier that reaches exactly 0 with a finite slope has an unbounded
 * log-gradient at that point, and the display responds to the LOG of the light.
 *
 * The exponential has a constant log-gradient (`LOG_GAIN · amount · |∇noise|`,
 * ≈ 0.02 per px at amount 3 — an e-fold per ~50 px) and is strictly positive, so
 * the dark patches are dim rather than off and nothing in it can be an edge.
 * `0.5` keeps the author's amount-3 mottling in the range the clamp had (×0.3
 * .. ×3.3 at |noise| 0.8 against 0 .. ×3.4); at the small amounts the effect
 * shipped with, `exp(0.5·x)` and `1 + 0.5·x` agree to first order.
 */
export const SPECULAR_FLICKER_LOG_GAIN = 0.5;

/**
 * The flutter multiplier on the shine: 1 where nothing lights the pixel
 * (`lightWeight` 0) or the amount is 0, strictly positive everywhere.
 * @param {number} noise - the flutter noise, roughly -1..1.
 * @param {number} amount - `SPECULAR_FLICKER_AMOUNT` or the author's own.
 * @param {number} lightWeight - 0..1, how strongly lit the pixel is.
 * @returns {number}
 */
export function flickerFactor(noise, amount, lightWeight) {
  return Math.exp(SPECULAR_FLICKER_LOG_GAIN * amount * noise * lightWeight);
}

/**
 * How brightly the SHEEN (the always-on base, no shimmer) may peak before its
 * OWN ceiling reins it in.
 *
 * ⚠️ **ROUND 15 (2026-08-03): RAISING THIS WAS TRIED AND REVERTED — IT
 * ATTACKS THE WRONG AXIS.** The author's next report after ROUND 14 (the
 * floor-gate fix) was *"either entirely ON or entirely OFF... we want
 * gradients of brighter shiny metal which pierce through."* The tempting read
 * is "0.15 flattens too much dynamic range, raise it" — and in ISOLATION
 * (`reinhardCeiling` fed a wide range of raw brightness values alone) that is
 * true. But `sheen` does NOT depend on the shimmer pattern at all — it is the
 * SAME value at a shimmer trough and a shimmer peak on the same metal. Raising
 * its ceiling raises that SHARED floor under both, which SHRINKS their RATIO
 * (`peak/trough → 1` as `sheen` grows relative to `glint`), i.e. LESS
 * contrast in the shimmer pattern itself — the opposite of "pierce through."
 * `specular-pattern.test.mjs`'s own ROUND-10 regression guard (peak > 1.8×
 * trough, post-tonemap) caught this immediately when 0.4 was tried: contrast
 * dropped, not rose. Reverted to 0.15 pending a properly-targeted fix — see
 * [[keyhole-specular-built]]'s ROUND 15 for what was actually tried and the
 * real candidates left (the shimmer LAYER's own smoothstep width/spatial
 * sparsity is the more likely lever for "gradient" in the sense the author
 * means, not this ceiling).
 *
 * ⚠️ **SEPARATELY: "gold boosts toward white instead of staying saturated" is
 * a DIFFERENT, DEEPER finding, NOT fixable by any ceiling in this file.**
 * Verified against the REAL transcribed `neutralToneMapping` formula
 * (`specular-pattern.test.mjs`): the global "Neutral" tonemap has a
 * DELIBERATE, BUILT-IN desaturation step once any channel's peak crosses
 * `StartCompression` (0.76) — `desat = 1 − 1/(Desaturation·(peak−newPeak)+1)`,
 * blending every channel TOWARD the compressed peak (an achromatic value) by
 * an amount that GROWS with how much compression is happening. This is a
 * genuine, documented characteristic of that tonemap operator, not a bug
 * here: `reinhardCeilingRgb` below IS already hue-preserving (one luminance-
 * derived scalar applied to all three channels, provably direction-
 * preserving) — specular's OWN composite never desaturates anything on its
 * own. The desaturation happens ONLY once the COMBINED pixel (base scene +
 * shine) enters the global tonemap's compression zone — a real tension
 * between "brighter" and "stays saturated" that no per-effect ceiling alone
 * can resolve, since the tonemap acts on base+shine TOGETHER.
 *
 * ============================================================================
 * ORIGINAL ROUND 10 REASONING BELOW, STILL THE SHIPPED VALUE
 * ============================================================================
 * **DROPPED FROM 1.4 TO 0.15 (2026-07-27) — CONTRAST, not just brightness.**
 * The author's report: *"the darker parts are being boosted in brightness
 * much like the brighter parts, which leads to a washed out ugly look instead
 * of a sharper, high contrast result."* 1.4 was "modest" only measured in
 * isolation — added to a typically-lit base scene it routinely pushed the
 * COMBINED pixel (`scene.lit` + shine) past `neutralToneMapping`'s own
 * `StartCompression` (0.76, `three.webgpu.js`'s `neutralToneMapping`), so the
 * global tonemap — which specular has no visibility into and cannot locally
 * correct for — was ALREADY compressing hard before the shimmer pattern ever
 * got a say. Measured: a shimmer-background pixel and a shimmer-peak pixel on
 * the SAME metal, same lighting, reached the screen at a 1.31:1 ratio — not
 * because the pattern lacks contrast (it has ~2.9:1 pre-tonemap), but because
 * `sheen` alone was already consuming the tonemap's compression headroom
 * before `glint` added anything.
 *
 * At 0.15, sheen is barely more than "gold looks like gold, not stone" — the
 * `1 +` structure's whole job — and leaves the headroom to `glint`, which is
 * what the shimmer PATTERN needs to read as pattern rather than as a uniform
 * lift. Verified in Node against the real `neutralToneMapping` formula (see
 * `specular-pattern.test.mjs`), across five lighting/paint combinations: the
 * post-tonemap peak:trough ratio improves in every one (e.g. 1.31→2.00 at
 * moderate light, 3.15→5.25 in a dim room), and the trough itself lands much
 * closer to the base scene's own tonemapped brightness — the "dark parts
 * stay dark" half of the ask.
 *
 * ⚠️ **LIVE-ADJUSTABLE SINCE ROUND 17 (2026-08-03)** — `specular-render.js`
 * turns this into `uSheenCeiling`, a real uniform with `setSheenCeiling()`,
 * exposed on `SPECULAR_PARAMS` with NO upper limit worth naming: this value
 * is now the DEFAULT an unconfigured scene ships with, not the only value
 * that can exist. Push it well past 1 and sheen stops being "gold looks like
 * gold" and starts being "gold looks lit from within" — a legitimate,
 * requested extreme for a scene where the shine is reading too faint to see
 * at all, not a mistake to guard against.
 *
 * ⚠️ RAISED 0.15 → 1 (ROUND 18, 2026-08-03), THEN BACK DOWN TO 0.15
 * (ROUND 19, same day) — the round-18 raise was live-confirmed for overall
 * visibility, but Round 18's own honest measurement flagged the exact trade
 * it made: raising this shrinks peak:trough shimmer contrast, and the
 * measured combination landed back near the ORIGINAL pre-Round-10 "washed
 * out" bug's own ratio. The author's next live look confirmed the concern
 * directly — *"the base shine ceiling should be lower, make it very low"* —
 * so this reverts to the exact value Round 10 originally measured and
 * tuned (not a fresh guess): `specular-pattern.test.mjs`'s Round-10
 * regression guard is restored to its ORIGINAL, stricter thresholds
 * alongside this, since the realistic-incidentAmt fix from Round 18 means
 * they now measure a genuinely representative scenario rather than a stale
 * flat stand-in.
 *
 * ⚠️ LOWERED ALL THE WAY TO 0 (ROUND 21, 2026-08-05) — new live-tuned
 * defaults, continuing the SAME direction Round 19's own live feedback
 * asked for ("make it very low"), taken to its logical end. **THIS IS NOT
 * MERELY "very dim" — READ `ceilingCompress` BEFORE ASSUMING IT IS A BUG**:
 * at `ceiling = 0`, `compressed = 0·luma/(0+luma) = 0` and `scale =
 * compressed/luma = 0`, so the sheen term is multiplied by an EXACT, literal
 * zero for any lit pixel (`luma > 1e-6`) — the steady base shine is
 * algebraically eliminated, not merely dimmed, and every visible highlight
 * comes from `glint` (the shimmer) alone. A live-tuned, deliberate choice,
 * not a silent precondition to "fix" back upward.
 */
export const SPECULAR_SHEEN_CEILING = 0;

/**
 * How brightly the GLINT (the shimmer's own contribution) may peak — high on
 * purpose, and RAISED FURTHER (16→20, 2026-07-27) alongside
 * `SPECULAR_DEFAULT_SHIMMER_GAIN` (4→5.5): with `SPECULAR_SHEEN_CEILING` cut
 * to a fifth of its old value, the composite has real headroom again before
 * `neutralToneMapping` starts compressing, so glint can use more of it rather
 * than leaving the "shines brighter" half of the author's ask unaddressed. A
 * real specular highlight is SUPPOSED to blow out toward bloom; that is what
 * makes a glint read as metal catching hot, sharp light rather than as a
 * painted surface. See `specular-render.js`'s composite header.
 *
 * ⚠️ **LIVE-ADJUSTABLE SINCE ROUND 17** — same shape as the sheen ceiling
 * above (`uGlintCeiling`/`setGlintCeiling()`), same reasoning for leaving it
 * uncapped upward.
 *
 * ⚠️ RAISED 20 → 28 (ROUND 18, 2026-08-03) — live-confirmed; see
 * `SPECULAR_SHEEN_CEILING`'s header for the full account of this round's
 * standard and the contrast trade-off it measured.
 *
 * ⚠️ RAISED 28 → 200 = THE SCHEMA'S OWN MAX (ROUND 21, 2026-08-05) — new
 * live-tuned defaults, and it now carries the WHOLE effect: with
 * `SPECULAR_SHEEN_CEILING` at exactly 0 this same round, `glint` is the
 * ONLY term contributing to the composite's `1 +` structure at all — every
 * highlight on screen is a shimmer peak, none is a steady base shine.
 */
export const SPECULAR_GLINT_CEILING = 200;
