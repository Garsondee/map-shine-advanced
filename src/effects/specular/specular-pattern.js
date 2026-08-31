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
 */
export const SPECULAR_INCIDENT_STEEPNESS = 200;

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
 */
export const SPECULAR_INCIDENT_KNEE = 0.15;

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
export const SPECULAR_KNEE_SOFTNESS = 0.5;

/**
 * A plain multiplier on the shine response, applied AFTER the curve. The
 * blunt "all of this is too strong" dial, deliberately separate from
 * `strength` (which scales the whole effect including its unlit behaviour) so
 * lamp-lit metal can be pulled back without touching how the effect reads
 * outdoors at noon. Default `0.55`, i.e. a real reduction from the value the
 * author called "far too much" rather than a nominal one — the curve controls
 * around it are what let that be dialled back up per scene.
 */
export const SPECULAR_INCIDENT_GAIN = 0.55;

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
 * `feedback_aggregate_cannot_name_the_source` first. */
export const SPECULAR_FLICKER_AMOUNT = 0.5;
/** Flutter rate. Candle-ish: fast enough to read as flame, slow enough not to strobe. */
export const SPECULAR_FLICKER_SPEED = 1.6;
/** World-space size of one coherent flutter patch, in px. Roughly a candle's
 * own pool of light, so nearby metal flickers together and distant metal does
 * not. */
export const SPECULAR_FLICKER_SCALE_PX = 320;
/** Blend between the two noise octaves: 0 = the broad slow one alone (smooth
 * breathing), 1 = the fine fast one alone (busy guttering). */
export const SPECULAR_FLICKER_ROUGHNESS = 0.5;

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
