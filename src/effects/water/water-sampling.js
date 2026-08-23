/**
 * SMOOTH RECONSTRUCTION OF A COARSE FIELD — the cure for texel-grid staircases,
 * as a UV remap rather than as more samples.
 *
 * ============================================================================
 * THE BUG THIS EXISTS FOR (author-reported live, 2026-08-16)
 * ============================================================================
 * *"In the white things on top of water there are some unusual hard edges
 * appearing that don't make sense"* — traced in red as a stepped, staircase
 * line running through open water, following nothing the map contains.
 *
 * Water's body pack (`res:waterBody`) was originally a 512-long-side field
 * (`WATER_BODY_SUPERSAMPLE = 1`) stretched across a map that can be 10,650 px
 * wide — one texel ~21 world px — later raised to a water-owned 1,536
 * (`WATER_BODY_GRID_MAX_DIM`, 2026-08-19), ~7 world px per texel on the same
 * map. It is sampled LINEAR, which was itself a live bug fix — NEAREST made
 * the shoreline blocky. But linear interpolation is only **C0**: the value is
 * continuous across a texel boundary and its GRADIENT is not. Every texel
 * edge is a crease, AT ANY RESOLUTION — this fix's own next paragraph is the
 * reason raising the resolution alone (2026-08-19's own fix included) does
 * not by itself remove the crease pattern; it only moves the creases closer
 * together and shrinks their individual footprint.
 *
 * A crease is invisible while nothing amplifies it. Water amplifies it three
 * times over — a `smoothstep(0, 34px, sdf)` wet band that crosses its whole
 * ramp inside 1.6 texels, a foam crest threshold, and tier 3's GGX lobe, which
 * at `alpha = 0.06` turns a fraction of a degree of normal into a factor of ten
 * of brightness. Push a piecewise-bilinear field through any of those and the
 * creases stop being creases and become EDGES, running along the grid in the
 * diamond/staircase pattern bilinear interpolation has always had.
 *
 * ⚠️ **THE FIX FOR CREASES IS NOT A FINER FIELD, AND THAT IS SETTLED HISTORY.**
 * `WATER_BODY_SUPERSAMPLE` went 1 → 3 → 1 in 2026-07-26 for exactly this
 * instinct, and its own doc now ends "a finer field will NOT sharpen an edge".
 * Raising it again would cost 9× the VRAM and 9× the bake to move the same
 * creases closer together. Nor is it a blur: blurring the RESULT smears the
 * distance field, which is the one thing every consumer depends on being
 * metric. THIS FILE is that fix, and it is resolution-independent by design.
 *
 * ⚠️ `WATER_BODY_GRID_MAX_DIM` (2026-08-19, `water-body.js`) raising the
 * flood's own resolution is NOT a reopening of this settled question — it is
 * a fix for a DIFFERENT, later-diagnosed problem: the tangent field's own
 * ANGULAR resolution near a small or closely-packed obstacle, where one texel
 * can only ever hold one seed direction no matter how well this file smooths
 * the reads between texels. A crease is an interpolation artefact this file
 * removes at any resolution; an under-resolved tangent near a small obstacle
 * is missing DATA this file cannot invent. Conflating the two — "we already
 * proved resolution doesn't matter, so don't raise it again" — is the mistake
 * to avoid here.
 *
 * ============================================================================
 * WHAT IT DOES INSTEAD — the standard smooth-bilinear remap
 * ============================================================================
 * The hardware's linear filter blends by the FRACTIONAL texel position, and
 * that fraction is a sawtooth: it ramps 0→1 and drops, so its derivative jumps
 * at every boundary. Feed the filter a fraction that has been eased through a
 * quintic (Perlin's own `6t⁵ − 15t⁴ + 10t³`, whose first AND second derivatives
 * vanish at both ends) and the reconstruction becomes **C2** — no crease
 * anywhere — while still passing exactly through every texel centre, so no
 * value is invented and no distance is distorted.
 *
 * Cost: a floor, a fract, five multiply-adds. NO extra texture fetch, which is
 * the whole reason this is the affordable fix — tier 3's ladder text promised
 * "no new bandwidth" and this keeps it.
 *
 * Not water-specific in principle: any consumer of a coarse world field with a
 * steep read on top of it wants this. Kept in `effects/water/` until a second
 * caller exists, rather than promoted to a shared zone on speculation.
 *
 * THREE is INJECTED, never imported.
 *
 * @module effects/water/water-sampling
 */

/**
 * Ease a 0..1 fraction with the quintic smootherstep. Exported because it is the
 * one line the CPU twin and the TSL builder below must agree on exactly, and a
 * second hand-typed copy of a polynomial is how two implementations drift.
 * @param {number} t
 * @returns {number}
 */
export function quintic(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * THE CPU TWIN of {@link buildSmoothTexelUv} — the same remap in plain JS, so
 * the properties that matter are Node-assertable rather than only visible on a
 * GPU (`feedback_measure_the_output_not_the_equation`).
 *
 * The two properties worth pinning, and both are tested:
 *   · **texel centres are FIXED POINTS.** At a centre the fraction is exactly 0
 *     (or 1), the quintic maps those to themselves, so the remapped UV is the
 *     original. The field's own sampled values are untouched; only what happens
 *     BETWEEN them changes.
 *   · **the remap never leaves the texel it started in**, so it can never reach
 *     a neighbour's neighbour and cannot widen the field's effective blur.
 *
 * @param {number} u @param {number} v - UV in 0..1 over the texture.
 * @param {number} texW @param {number} texH - the texture's size in texels. A
 *   non-positive or non-finite size returns the UV UNCHANGED — an unwired caller
 *   gets today's plain bilinear, never a NaN that renders as a black quad.
 * @returns {[number, number]} the remapped UV, to be sampled with LINEAR.
 */
export function smoothTexelUv(u, v, texW, texH) {
  if (!(Number.isFinite(texW) && texW > 0 && Number.isFinite(texH) && texH > 0)) return [u, v];
  const remap = (coord, size) => {
    // −0.5 puts the origin on the first texel's CENTRE, which is where the
    // hardware's own filter weights are anchored. Skipping it is the classic
    // half-texel bug: the eased fraction would be out of phase with the filter
    // it is supposed to be correcting, and the creases would move rather than
    // disappear.
    const p = coord * size - 0.5;
    const i = Math.floor(p);
    const f = p - i;
    return (i + 0.5 + quintic(f)) / size;
  };
  return [remap(u, texW), remap(v, texH)];
}

/**
 * Build the TSL twin. Returns a vec2 node to sample the coarse field at.
 *
 * @param {*} TSL - `THREE.TSL`, injected by the caller that owns THREE.
 * @param {object} args
 * @param {*} args.uvNode - a vec2 node: the UV that WOULD have been sampled.
 * @param {*} args.uTexSize - a vec2 uniform node: the field's size in texels.
 *   The caller pushes the real grid dimensions every time the field is
 *   reallocated; a zero here would divide by zero, so the caller is responsible
 *   for seeding it with the real size (see `water-surface-subsystem.js`).
 * @returns {*} a vec2 node.
 */
export function buildSmoothTexelUv(TSL, { uvNode, uTexSize }) {
  const { vec2, float, floor, max } = TSL;
  // `max(size, 1)` is the shader-side twin of the CPU guard above: a field that
  // has not been allocated yet reports 0×0, and a division by it would poison
  // every downstream distance with Inf/NaN rather than merely looking wrong.
  const size = max(uTexSize, vec2(1, 1));
  const p = uvNode.mul(size).sub(vec2(0.5, 0.5));
  const i = floor(p);
  const f = p.sub(i);
  // 6t⁵ − 15t⁴ + 10t³, spelled as Horner exactly like `quintic` above so the
  // two read as one formula. Component-wise on a vec2: TSL's arithmetic is
  // element-wise, so this eases u and v independently, which is what a separable
  // bilinear filter needs.
  const eased = f
    .mul(f)
    .mul(f)
    .mul(f.mul(f.mul(float(6)).sub(float(15))).add(float(10)));
  return i.add(vec2(0.5, 0.5)).add(eased).div(size);
}
