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
 * @module effects/specular/specular-pattern
 */

/** Rows-of-glints spacing floor. Below this the `across` divide explodes the
 * lattice into a smear; V2 clamped at the same value. */
export const MIN_ROW_SPACING = 0.18;

/** Gaussian tightness endpoints for `softness` 0..1 — `mix(18, 5, softness)`.
 * 18 is a hard dot, 5 a broad soft pool. V2's `spreadMul`, verbatim. */
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
 * ONE ANISOTROPIC BLOB LATTICE SAMPLE — V2's `anisotropicBlob`.
 *
 * A hash lattice rotated into the grain's frame, one Gaussian blob per cell,
 * each jittered and rotated by its own hash. See the module header for what
 * each control genuinely does and why three of them are renamed.
 *
 * @param {object} args
 * @param {number} args.u @param {number} args.v - pattern-space coordinate.
 * @param {number} args.grainX @param {number} args.grainY - UNIT grain vector.
 * @param {number} args.density - cells per pattern unit along the grain.
 * @param {number} args.rowSpacing - row pitch across the grain, in cells.
 * @param {number} args.softness - 0 tight dot .. 1 broad pool.
 * @param {number} args.streak - per-cell rotation amount. THE streak control.
 * @returns {number} 0..1
 */
export function anisotropicBlob({ u, v, grainX, grainY, density, rowSpacing, softness, streak }) {
  const rows = Math.max(rowSpacing, MIN_ROW_SPACING);
  const scale = Math.max(density, 0.25);
  // The grain's own frame. `perp` is the grain rotated +90°.
  const perpX = -grainY;
  const perpY = grainX;
  const along = (u * grainX + v * grainY) * scale;
  const across = ((u * perpX + v * perpY) * scale) / rows;

  const cellX = Math.floor(along);
  const cellY = Math.floor(across);
  let offX = along - cellX - 0.5;
  let offY = across - cellY - 0.5;

  // ⚠️ THE ROTATION HAPPENS BEFORE THE STRETCH, AND THAT ORDER IS THE EFFECT.
  // Rotating a circle then stretching it yields a skewed ellipse with a real
  // orientation; stretching then rotating yields the same ellipse every time,
  // merely turned. Swap these two blocks and every glint on the map becomes
  // identically oriented — the lattice reappears and it reads as wallpaper.
  const rot = (hash12(cellX + 17.3, cellY + 91.7) - 0.5) * streak * STREAK_RADIANS;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const rx = offX * c - offY * s;
  const ry = offX * s + offY * c;
  offX = rx;
  offY = ry;

  // Per-cell jitter, so the lattice is not readable as a grid.
  const seed = hash12(cellX + 127.1, cellY + 311.7);
  offX -= (seed - 0.5) * CELL_JITTER;
  offY -= (hash12(cellX + 269.5, cellY + 183.3) - 0.5) * CELL_JITTER;

  const spreadMul = mix(SPREAD_TIGHT, SPREAD_LOOSE, clamp01(softness));
  const sx = offX;
  const sy = offY * rows;
  return Math.exp(-(sx * sx + sy * sy) * spreadMul);
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
 * @param {object} args - `anisotropicBlob`'s args, plus:
 * @param {number} args.contrast - 0 = a narrow window (sparse hard glints),
 *   1 = a wide one (broad connected sheen). V2's mislabelled "Cluster size".
 * @param {number} [args.sunBias] - `sunGrainBias`'s result, or 1 indoors.
 * @returns {number} 0..1
 */
export function shimmerLayer(args) {
  const blob = anisotropicBlob(args);
  const c = clamp01(args.contrast);
  const lo = mix(0.55, 0.08, c);
  const hi = mix(0.95, 0.45, c);
  return smoothstep01(lo, hi, blob) * (args.sunBias ?? 1);
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
 * How brightly the SHEEN (the always-on base, no shimmer) may peak before its
 * OWN ceiling reins it in.
 *
 * ⚠️ **DROPPED FROM 1.4 TO 0.15 (2026-07-27) — CONTRAST, not just brightness.**
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
 */
export const SPECULAR_SHEEN_CEILING = 0.15;

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
 */
export const SPECULAR_GLINT_CEILING = 20;
