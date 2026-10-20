/**
 * FIRE — COUNTERING THE SCENE'S BLOOM (2026-10-20). Pure maths, no THREE, Node-tested.
 *
 * ⚠️ WHY THIS EXISTS: MEASURED IN THE REAL VIEWER, NOT GUESSED. The flame is drawn into `scene.lit`, and the scene's bloom
 * (`post.bloom`, effects/bloom.js) then reads `scene.lit` and ADDS its glow back into it. The author's tuned bloom is strong
 * (threshold 0.33, core 1.01, atmosphere 0.24), so a flame the painted palette says is cream (0.99, 0.73, 0.16) lands in
 * `scene.lit` as (3.2, 2.1, 0.3): R and G both clip at the display and every painted flame comes out the same flat acid
 * yellow. A flat test patch of (0.5, 0.25, 0.1) came out at exactly 2.25x that with the bloom on, and exactly itself with the
 * bloom off (probed with `MapShine.probePixels`; the bloom is the ONLY pass that does it).
 *
 * The bloom's bright pass is `bright = c * (max(softQ, br - threshold) / br)` with `br = max(r,g,b)` and a quadratic soft knee
 * (bloom-render.js), and the two bands add `strength * (core * coreStrength + atmo * atmoStrength)` of the pyramid's response
 * to it. On a region wider than the kernel the pyramid sums three mips per band, so the net effect on a pixel is
 *
 *     lit = c * (1 + K * contribution(max(c)))          K = strength * 3 * (core + atmosphere)       (a BROAD region)
 *
 * a gain that is ~1 for dark colours, ~2 for mid, ~3.5 for the brightest. A region only as wide as a flame gets a fraction of
 * K (the kernels need room to fill: the flame at 66 px radius measured K ~ 1.8 of 3.7), so K is scaled by `regionFill(px)`.
 *
 * The flame cannot be painted with a plain scale (the reds and the cream need different ones), so it paints the INVERSE:
 * for every wanted display colour `T` it emits `s * T`, with `s` the root of `s * (1 + K * contribution(s * max(T))) = 1`.
 * With the bloom OFF (or disabled by the performance profile) `K` is 0, `s` is exactly 1, and the flame is what the palette
 * says; with it on, the bloom hands the colour back.
 *
 * THE SHADER SOLVES IT ITSELF (`fire-billow-render.js`, nine unrolled bisection steps on four uniforms) rather than reading a
 * lookup: a lookup would be a data texture, and `gpu/textures-in-vt-only` allows none in effects/. `inverseBloomScale` here is
 * the same bisection in plain numbers, the reference the tests hold the shader's algorithm to.
 *
 * It is an approximation by construction, in the safe direction: a narrower region than assumed comes out a little darker than
 * the palette, never washed out.
 *
 * @module effects/fire/fire-billow-bloom
 */

/** Mips summed per band on a broad region (post.bloom: core = mips 2->1->0, atmosphere = mips 5->4->3). */
const BAND_MIPS = 3;
/** On-screen flame radius (px) at which the bloom reaches half its broad-region gain on the flame. Fitted in the rig. */
export const FILL_RADIUS_PX = 67;
/** Bisection steps the shader unrolls (error <= 2^-9 of the scale): the tests hold the maths to the same count. */
export const BLOOM_SOLVE_STEPS = 9;

const num = (v, d) => (Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** `#rrggbb` -> mean of its three channels in 0..1 (the bloom feeds these to the shader as plain multipliers). */
function tintMean(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  const n = Number.parseInt(m ? m[1] : fallback, 16);
  return (((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)) / (3 * 255);
}

/**
 * The bloom bright pass's share of a pixel that is kept (bloom-render.js `brightMaterial`, line for line).
 * @param {number} br max channel of the pixel in `scene.lit`
 * @param {number} threshold @param {number} knee
 */
export function bloomContribution(br, threshold, knee) {
  const kneeW = threshold * knee + 1e-4;
  const soft = clamp(br - threshold + kneeW, 0, 2 * kneeW);
  const softQ = (soft * soft) / (4 * kneeW + 1e-4);
  return Math.max(Math.max(softQ, br - threshold) / Math.max(br, 1e-4), 0);
}

/**
 * The live bloom, reduced to the three numbers the inverse needs. `null` when the bloom is off (nothing to counter).
 *
 * @param {{enabled?:boolean, params?:object}|null|undefined} state `getBloomRenderState()`
 * @returns {{threshold:number, knee:number, K:number}|null} `K` is the BROAD-region gain constant
 */
export function bloomCounterParams(state) {
  if (!state || state.enabled === false) return null;
  const p = state.params ?? {};
  const strength = Math.max(0, num(p.strength, 1));
  const core = Math.max(0, num(p.coreStrength, 1)) * tintMean(p.coreTint, 'ffffff');
  const atmo = Math.max(0, num(p.atmoStrength, 0.5)) * tintMean(p.atmoTint, 'fff0dc');
  const K = strength * BAND_MIPS * (core + atmo);
  if (!(K > 1e-4)) return null;
  return { threshold: Math.max(0, num(p.threshold, 1)), knee: clamp(num(p.knee, 0.5), 0, 1), K };
}

/** How much of the broad-region gain a flame of this on-screen radius (px) gets: 0 (a speck) .. 1 (a hall). */
export function regionFill(radiusPx) {
  const r = Math.max(0, num(radiusPx, 0));
  return (r * r) / (r * r + FILL_RADIUS_PX * FILL_RADIUS_PX);
}

/** The bloom's in-place gain on an area whose max channel is `br`, at a region fill of `fill`. */
export function bloomGain(br, c, fill = 1) {
  return 1 + c.K * clamp(fill, 0, 1) * bloomContribution(br, c.threshold, c.knee);
}

/**
 * The scale `s` such that painting `s * T` gives `T` once the bloom has added its share: the root of
 * `s * bloomGain(s * brT) = 1`, by bisection (the left side is monotone in `s`). The shader runs the SAME steps; `steps` is
 * a parameter so the tests can compare the shader's nine against a converged answer.
 *
 * @param {number} brT the wanted display colour's max channel
 * @param {{threshold:number, knee:number, K:number}|null} c from {@link bloomCounterParams}
 * @param {number} [fill=1] {@link regionFill}
 * @param {number} [steps=36]
 * @returns {number} 0..1 (1 when there is no bloom, or nothing to counter)
 */
export function inverseBloomScale(brT, c, fill = 1, steps = 36) {
  if (!c || !(brT > 1e-6) || !(fill > 1e-6)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < steps; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid * bloomGain(mid * brT, c, fill) > 1) hi = mid;
    else lo = mid;
  }
  // the shader returns `hi` (so a bloom of 0 gives exactly 1); with `steps` large, lo and hi agree
  return hi;
}

/**
 * What the renderer's four uniforms are set to. `k = 0` is "no bloom": the shader's scale is exactly 1.
 *
 * @param {{threshold:number, knee:number, K:number}|null} c
 * @param {number} [mix01=1] the author's "Counter scene bloom" dial (0 = leave the flame to the bloom)
 * @returns {{k:number, threshold:number, knee:number, mix:number}}
 */
export function bloomCounterUniforms(c, mix01 = 1) {
  if (!c) return { k: 0, threshold: 1, knee: 0.5, mix: 0 };
  return { k: c.K, threshold: c.threshold, knee: c.knee, mix: clamp(num(mix01, 1), 0, 1) };
}
