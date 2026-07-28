/**
 * THE COOKIE DECODE — `_Window`'s three channels read as LIGHT, not as an
 * aperture. PURE: no THREE, no TSL, no Foundry. `window-render.js` is the TSL
 * transcription of exactly this maths.
 *
 * ============================================================================
 * WHAT THE MASK IS (author directive, 2026-07-27)
 * ============================================================================
 * *"All `_Windows` and `_Structural` masks are light applied only to the
 * interior of buildings… any bright pixel is where a bright light would fall
 * on the interior at day… the gobo lighting cookie shapes of window lights
 * spilling into rooms."*
 *
 * So there is no geometry to derive here — no aperture, no wall, no sill, no
 * "which side is outside". The artist has already painted where the light
 * lands, how strong, and what colour. This decode answers exactly two
 * questions, both about the paint itself:
 *
 *   VALUE (max of r,g,b) → LEVEL. How much light lands at this texel.
 *   HUE + SATURATION      → TINT.  What colour that light is (stained glass:
 *                                  paint the rose window red and blue, get
 *                                  red and blue light on the floor).
 *   VALUE ≈ 0             → PRESENCE. The bottom of the range is "is anything
 *                                     painted here at all".
 *
 * `docs/planning/Windows.md` §3.1 is this argument in full, including why
 * `level` and `tint` are kept as two numbers rather than collapsed into one
 * (`feedback_one_byte_two_quantities` — a byte carrying two unrelated
 * quantities cannot be tuned into correctness).
 *
 * ============================================================================
 * WHY A SEPARATE PURE MODULE AT ALL
 * ============================================================================
 * `feedback_smooth_output_hides_ported_bugs`: a light-cookie effect produces a
 * smooth, plausible glow from almost ANY decode, correct or not. So the decode
 * is written ONCE here, in plain JS, asserted against named cases in Node
 * (`__tests__/window-cookie.test.mjs`), and the shader transcribes it
 * line-for-line. Same split as `effects/specular/specular-material.js`.
 *
 * @module effects/window/window-cookie
 */

/**
 * Where the mask's VALUE is thresholded into presence, and how wide the ramp
 * is — both in mask value (0..1), not distance. Mirrors
 * `SPECULAR_PRESENCE_EDGE0/1` (`effects/specular/specular-material.js`): wide
 * enough to antialias an authored edge, narrow enough not to eat the dark end
 * of the range (a dim, cloud-darkened cookie must still register as PRESENT,
 * only dimmer — see `decodeWindowMask`'s own `level` output for that half).
 */
export const WINDOW_PRESENCE_EDGE0 = 1 / 255;
export const WINDOW_PRESENCE_EDGE1 = 20 / 255;

/**
 * THE ALPHA-MISSING FALLBACK IS LOAD-BEARING, NOT DEFENSIVE — same reasoning
 * as `SPECULAR_ALPHA_EPSILON`. A greyscale `_Window` with no real alpha
 * channel is a common authoring case, and without this branch every such file
 * renders pure black (`level = value × 0`).
 */
export const WINDOW_ALPHA_EPSILON = 1e-4;

/** @param {number} x @returns {number} */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Hermite smoothstep. Exported shape matches TSL's `smoothstep(e0, e1, x)`
 * argument order deliberately — the transcription is then line-for-line.
 * @param {number} e0 @param {number} e1 @param {number} x @returns {number} */
export function smoothstep(e0, e1, x) {
  const d = e1 - e0;
  if (Math.abs(d) < 1e-9) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / d);
  return t * t * (3 - 2 * t);
}

/**
 * THE MASK, DECODED — level, tint and presence, the author's own reading.
 *
 * The tint step re-normalises the mask's RGB to carry `level` as its own
 * luma-free peak — a naive `rgb × level` would darken saturated paint twice
 * (once for being dark, once for being coloured); dividing by `v` first and
 * re-multiplying by `level` keeps a fully-saturated red patch exactly as red
 * at every brightness.
 *
 * @param {number} r @param {number} g @param {number} b - 0..1, RAW authored
 *   values. ⚠️ NOT sRGB-decoded — mirrors `_Specular`'s own convention
 *   (`NoColorSpace` upload): a "50% grey" texel means 0.5, not 0.21.
 * @param {number} a - 0..1 alpha, or 0 when the file has no alpha channel.
 * @param {number} [contrast] - gamma on `level` (`docs/planning/Windows.md`
 *   §7.5's "Patch contrast"). 1 = neutral. >1 sharpens the falloff (a harder-
 *   edged cookie); <1 softens it.
 * @returns {{level: number, tint: number[], presence: number}}
 */
export function decodeWindowMask(r, g, b, a, contrast = 1) {
  const v = Math.max(clamp01(r), clamp01(g), clamp01(b));
  const alpha = clamp01(a);
  // See WINDOW_ALPHA_EPSILON's own doc — a file with no alpha channel must
  // not silently zero every pixel.
  const effectiveAlpha = alpha < WINDOW_ALPHA_EPSILON ? 1 : alpha;
  const gated = v * effectiveAlpha;

  const presence = smoothstep(WINDOW_PRESENCE_EDGE0, WINDOW_PRESENCE_EDGE1, gated);
  const c = Math.max(contrast, 0.001);
  const level = Math.pow(clamp01(gated), c);

  // Guarded: a pure black texel has no hue to preserve and the divide would be
  // by zero. Its level is 0 anyway, so the tint is never seen at that texel —
  // but a NaN here would propagate through an additive blend into a permanent
  // black hole, the exact failure mode this codebase has paid for before.
  const denom = Math.max(v, 1e-4);
  return {
    level,
    tint: [clamp01(r) / denom, clamp01(g) / denom, clamp01(b) / denom],
    presence,
  };
}

/**
 * The cookie's own light contribution — `level × tint`, the quantity that
 * ADDS onto `buf:scene.illum` (never onto composed scene colour — see
 * `docs/planning/Windows.md` §2.2 and §3.2: three effects in this codebase
 * have shipped the additive-onto-litColor mistake; this one must not be the
 * fourth).
 *
 * @param {{level: number, tint: number[]}} decoded
 * @returns {number[]}
 */
export function cookieRgb(decoded) {
  return [decoded.tint[0] * decoded.level, decoded.tint[1] * decoded.level, decoded.tint[2] * decoded.level];
}

/**
 * THE HIGHLIGHT SHOULDER — found live, on a real scene (2026-07-27): a large
 * cookie over bright architectural art (a pale stone floor, a gold-and-blue
 * astronomical mosaic) came back as a flat, textureless white disc, the
 * painted tracery gone entirely.
 *
 * ============================================================================
 * WHY, TRACED THROUGH THE ACTUAL COMPOSITE FORMULA — NOT GUESSED
 * ============================================================================
 * `environmental-light.js`'s composite is `lit = EOTF( OETF(albedo) × illum )`
 * (`feedback_gamma_space_composite_arithmetic`). Illum MULTIPLIES the
 * gamma-encoded albedo, so once `illum` crosses roughly `1 / OETF(albedo)`,
 * every channel that hits that ceiling clips to exactly 1.0 — and it does so
 * FLATLY: two adjacent texels whose painted brightness differed (the
 * wagon-wheel's spokes vs. its panes) both land on the identical white once
 * both clip, so the RELATIVE detail that makes the shape readable is what
 * disappears, not just the peak brightness. Bright map art (pale stone, gold
 * trim, parchment) commonly has `OETF(albedo)` around 0.8–0.95, which leaves
 * almost no headroom: an UNSHOULDERED add of a fully-painted, full-strength
 * cookie (contributing up to +1.0 of illum) blows out the instant the
 * pre-existing ambient is anywhere above "quite dark".
 *
 * ============================================================================
 * WHY THE SHOULDER LIVES HERE, NOT AS A CHANGE TO THE SHARED COMPOSITE
 * ============================================================================
 * `environmental-light.js` is shared, load-bearing (specular reads the same
 * illum buffer; the whole ambient/point-light/coloration stack depends on its
 * exact formula), and its "byte-identical to Foundry at noon" invariant is
 * exactly the kind of thing an unrelated effect must not risk. Shaping THIS
 * effect's OWN contribution before it ever reaches the shared buffer is the
 * same category of thing point lights already do to their own falloff
 * (`point-light-illumination.js`'s `easeAttenuation`/presence curves) — an
 * energy shape belonging to the light, not a scene-wide grade. It is
 * deliberately NOT the same thing `docs/planning/Windows.md` §9 forbids
 * ("no per-effect tonemap") — that rule is about not re-implementing
 * exposure/saturation/tint on the whole picture; this is one light's own
 * radiance curve, same as a real light has a maximum output.
 *
 * ============================================================================
 * WHY IT SHAPES THE PEAK CHANNEL, NEVER EACH CHANNEL INDEPENDENTLY
 * ============================================================================
 * Compressing R, G and B independently would DESATURATE the cookie exactly
 * where it is brightest — a saturated red beam would fade toward pale pink at
 * its brightest texel, because the curve's slope shrinks as its input grows,
 * and an unevenly-saturated colour has channels sitting at different points
 * on that shrinking slope. Deriving one scale factor from the PEAK channel
 * and applying it to all three preserves the RGB ratio exactly — hue and
 * saturation survive compression; only overall magnitude does not.
 *
 * ============================================================================
 * WHAT THIS DOES NOT CLAIM
 * ============================================================================
 * This bounds THIS light's own contribution — it cannot see how much headroom
 * `buf:scene.illum` already has left, because reading the buffer this pass is
 * simultaneously rendering INTO is the read-while-write hazard this codebase
 * already avoids elsewhere (why `surface.response` had to become its own
 * later pass rather than draw inside `light.accumulate`). So a cookie sitting
 * on top of an ALREADY near-maximum ambient can still clip somewhat — the
 * honest claim is "the overshoot is bounded and the loss of detail is far
 * less total", not "clipping can never happen here".
 *
 * @param {number} raw @param {number} k @returns {number}
 */
export function softShoulder(raw, k = WINDOW_SHOULDER_K) {
  const x = Math.max(raw, 0);
  return x / (1 + x * Math.max(k, 0.001));
}

/**
 * Calibrated so a fully-painted, default-strength cookie (`raw = 1`) lands at
 * `1/(1+K) ≈ 0.556` — bright enough to read clearly, and with real headroom
 * left before a typical dim-to-moderate interior ambient pushes the total
 * past 1.0 — while the asymptote as `raw → ∞` (a maxed-out `strength` slider,
 * `1/K ≈ 1.25`) still caps how far even an extreme setting can push the
 * shared buffer. Not derived from a physical constant — there isn't one here,
 * the same honest place `Water.md`'s tuned constants sit — but MEASURED
 * against the real composite formula above rather than picked by eye.
 */
export const WINDOW_SHOULDER_K = 0.8;

/**
 * The final RGB contribution to `buf:scene.illum`: `cookieRgb × modulation`
 * (strength, coverage, cloud factor — everything multiplicative that is not
 * part of the paint itself), shouldered on its PEAK channel so hue and
 * saturation survive compression.
 *
 * @param {number[]} rgb - the pre-shoulder contribution (already scaled by
 *   strength/coverage/cloud).
 * @param {number} [k]
 * @returns {number[]}
 */
export function shoulderedContribution(rgb, k = WINDOW_SHOULDER_K) {
  const peak = Math.max(rgb[0], rgb[1], rgb[2], 1e-5);
  const shapedPeak = softShoulder(peak, k);
  const scale = shapedPeak / peak;
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
}
