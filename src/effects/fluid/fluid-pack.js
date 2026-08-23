/**
 * THE TUBE PACK — `res:tubeNet` as one interleaved RGBA buffer, ready to upload
 * (`docs/planning/Fluid.md` §5.2 stage B).
 *
 * Pure. No THREE, no render targets, no GPU. That is correction #3 of the
 * design and it is worth restating here because a future session will
 * reasonably expect a jump flood (water has one, and §5.2 originally specified
 * one):
 *
 *   **Three of this pack's four channels can ONLY come from the CPU.** Arc
 *   length needs a constrained geodesic, tube id needs connected components,
 *   and the radius needs per-component work — none of which is what a jump
 *   flood computes. `fluid-net.js` already produces all three, already walks
 *   every tube texel three times, and already yields a distance transform as a
 *   by-product. A GPU flood would recompute ONE channel the CPU pass already
 *   has, into a SEPARATE target, which would then need combining with a
 *   CPU-uploaded texture regardless. That is more machinery — allocator
 *   lifetimes, ping-pong, the `renderer-state/graph-only` callback dance — for
 *   an output nobody could tell apart.
 *
 *   Water's flood is on the GPU for a reason that does not transfer: its SDF
 *   spans the whole scene rect and nothing on the CPU wanted it. Tubes are
 *   sparse, and the CPU is already there.
 *
 * The dividend is that the ENTIRE bake is a pure function plus one upload, so
 * it is verified in Node rather than by looking at a screenshot and hoping.
 *
 * ============================================================================
 * THE CHANNELS, AND THE ONE THAT IS DELIBERATELY UNSIGNED
 * ============================================================================
 *   R  `s`         arc length along the tube, 0..1
 *   G  `across`    UNSIGNED distance from the centreline: 0 centre, 1 wall
 *   B  `tubeId`    0 = not a tube, else 1..tubeCount (the state texture's row + 1)
 *   A  `radiusPx`  local tube half-width, world px
 *
 * `across` carries no sign because nothing below tier 5 can use one: the
 * optical path length through a round tube is `√(1 − across²)` and the wall rim
 * is a band near `across → 1`, both even in `w`. A sign needs the OFFSET to the
 * nearest wall texel — which a jump flood stores and a chamfer transform does
 * not — so a signed channel today would mean either fabricating the sign or
 * building the feature-transform variant four rungs before a consumer exists.
 * When tier 5 (bubbles pinning to a wall) lands, the channel widens to −1..1
 * and every consumer written against `abs()` keeps working unchanged.
 *
 * ============================================================================
 * OUTSIDE A TUBE, EVERY CHANNEL IS ZERO — AND `tubeId` IS THE ONLY GATE
 * ============================================================================
 * A consumer must test `tubeId > 0`, never `s > 0` or `across < 1`. `s` is
 * legitimately 0 at every tube's root, and `across` is legitimately 0 down
 * every tube's centreline, so both collide with the outside-value. Using either
 * as a presence test would erase the root of every tube or paint the whole map
 * as centreline. The id is unambiguous by construction, which is why it is in
 * the pack at all rather than being inferred.
 *
 * @module effects/fluid/fluid-pack
 */

/**
 * The pack's long-side resolution cap, and therefore the resolution the tube
 * net is extracted at (`Fluid.md` correction #2 — the two are the same grid).
 *
 * **1,536 is chosen against the tube, not against the map.** On a 10,650 px
 * map this is ~6.9 world px per texel, so a 40 px glass tube is ~6 texels
 * across: enough to separate two tubes running a tube's width apart, and enough
 * for the radius profile to mean something. The 512-wide derived grid every
 * other mask consumer uses would be ~21 world px per texel — 1–2 texels per
 * tube — where adjacent tubes MERGE into one component and no downstream code
 * can recover them.
 *
 * It is also, not by accident, the same figure water's own body-pack flood
 * lands on (`water-body.js#WATER_BODY_GRID_MAX_DIM`, water-owned, sized from
 * the world rect the same way this file's own cap is), and it sits under the
 * Keyhole allocator's 2,048 px cap with no exception needed.
 *
 * Cost at 1,536 × 714: ~1.1 M texels, RGBA16F = **~8.8 MB** resident, and a
 * measured ~365 ms of CPU once per mask version (never per frame).
 */
export const FLUID_PACK_MAX_DIM = 1536;

/** Channels per texel. RGBA, interleaved, row-major, row 0 = minY — the same
 * convention `MaskGrid` uses, so a consumer that can index one can index both. */
export const FLUID_PACK_CHANNELS = 4;

/**
 * Encode one float as an IEEE-754 half-float bit pattern.
 *
 * Present because the pack uploads as RGBA16F rather than RGBA32F: at 1.1 M
 * texels that is 8.8 MB against 17.6 MB, and half-float's ~3 decimal digits are
 * ample for every channel here (`s` and `across` are 0..1 where fp16 resolves
 * ~0.0005; `tubeId` ≤ 64 is exact — fp16 represents every integer to 2,048;
 * `radiusPx` in the hundreds resolves to ~0.06 px).
 *
 * Written out rather than reached for because `Math.fround` gives fp32, not
 * fp16, and the DataView trick is the standard way. Subnormals are flushed to
 * zero deliberately: the smallest normal half is ~6.1e-5 and nothing here
 * carries meaning below that, so the extra branch would be cost without effect.
 *
 * @param {number} value
 * @returns {number} the 16 bits, as a number in 0..65535.
 */
export function toHalfFloat(value) {
  if (!Number.isFinite(value)) return value > 0 ? 0x7c00 : Number.isNaN(value) ? 0x7e00 : 0xfc00;
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const v = Math.abs(value);
  if (v === 0) return sign;
  if (v >= 65504) return sign | 0x7bff; // clamp to the largest finite half
  if (v < 6.103515625e-5) return sign; // flush subnormals to zero
  const exponent = Math.floor(Math.log2(v));
  const mantissa = Math.round((v / 2 ** exponent - 1) * 1024);
  // Rounding the mantissa can carry into the exponent (1023.5 → 1024).
  if (mantissa === 1024) return sign | ((exponent + 1 + 15) << 10);
  return sign | ((exponent + 15) << 10) | mantissa;
}

/**
 * Decode a half-float bit pattern. Exists for the Node suite's round-trip
 * assertions — nothing in the render path calls it, because the GPU does this
 * in hardware. A converter with no inverse is a converter nobody can test.
 *
 * @param {number} bits
 * @returns {number}
 */
export function fromHalfFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

/**
 * @typedef {object} FluidPack
 * @property {import('../../scene/mask-derive.js').MaskGridSpec} spec - the
 *   world rect this pack covers and its texel size. A consumer maps world →
 *   texel with the same arithmetic every `MaskGrid` uses.
 * @property {number} width @property {number} height
 * @property {Float32Array} data - `width * height * 4`, interleaved RGBA.
 * @property {number} tubeCount
 * @property {number} maxTubeWidthTexels - the widest tube's diameter measured
 *   in PACK TEXELS. **The instrument for correction #2, and it reports TWO
 *   distinct failures that both look like "the effect is a bit flat":**
 *
 *   Below ~2, adjacent tubes MERGE into one component and share a flow forever.
 *
 *   Below ~4, `across` cannot form a gradient. A tube two texels wide has BOTH
 *   its texels the same distance from a wall, so `across` is uniformly 0 across
 *   the whole tube, the `√(1−across²)` path length is constant, and tier 1's
 *   cylinder shading — the rung whose entire job is *"it stops being a painted
 *   line"* — silently produces a flat line. Nothing errors; it just does not
 *   work. This number is how that is diagnosed in one glance rather than by
 *   suspecting the shader.
 *
 *   Both are cured by the same lever (`FLUID_PACK_MAX_DIM`) or by painting
 *   wider tubes, and neither is cured downstream.
 */

/**
 * Build the pack from an extracted tube net.
 *
 * @param {object} args
 * @param {import('./fluid-net.js').TubeNet} args.net - `extractTubeNet`'s
 *   output, extracted at THIS pack's resolution (they are the same grid — see
 *   `FLUID_PACK_MAX_DIM`).
 * @returns {FluidPack}
 */
export function buildFluidPack({ net } = {}) {
  if (!net || !net.spec || !net.tubeIdByTexel || !net.sByTexel) {
    throw new Error(
      'buildFluidPack: needs a TubeNet from extractTubeNet({grid}). There is no useful default — an ' +
        'absent net means the extractor never ran, which is a wiring fault, not "no tubes" (a scene ' +
        'with no tubes still produces a net, with tubeCount 0).'
    );
  }

  const { w, h } = net.spec;
  const data = new Float32Array(w * h * FLUID_PACK_CHANNELS);

  // Per-tube radius PROFILES, indexed by tube id (1-based, hence the +1 slot).
  //
  // ⚠️ The LOCAL radius, not the tube's maximum. Normalising `across` against a
  // single per-tube number looks simpler and is wrong the moment a tube is not
  // uniform: a painted flask joined to a capillary would have one max radius,
  // so the capillary's centreline would read `across ≈ 0.9` — "almost at the
  // wall" — and the whole stem would shade as if it were rim. The profile the
  // extractor already binned by arc length is exactly the per-position radius
  // this needs, so the local value costs one lookup and no new measurement.
  const profileByTube = new Array(net.tubeCount + 1).fill(null);
  for (const tube of net.tubes) profileByTube[tube.id] = tube.radiusProfile;
  const bins = net.samplesPerTube;

  let maxTubeWidthTexels = 0;
  const texelSize = 0.5 * (net.spec.texelW + net.spec.texelH);
  for (const tube of net.tubes) {
    const widthTexels = texelSize > 0 ? (2 * tube.maxRadiusPx) / texelSize : 0;
    if (widthTexels > maxTubeWidthTexels) maxTubeWidthTexels = widthTexels;
  }

  for (let i = 0; i < w * h; i++) {
    const id = net.tubeIdByTexel[i];
    // Outside a tube every channel stays 0. `across` in particular must NOT
    // default to 1 ("at the wall") — a consumer reading it without checking the
    // id would then see a wall-coloured rim over the entire map.
    if (id === 0) continue;
    const o = i * FLUID_PACK_CHANNELS;
    const s = net.sByTexel[i];
    const profile = profileByTube[id];
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(s * bins)));
    const radiusPx = profile ? profile[bin] : 0;
    data[o] = s;
    // 0 at the centreline (distance-to-wall equals the local half-width), 1 at
    // the wall (distance 0). A tube one texel wide has a local radius of 0 —
    // the chamfer's boundary correction lands there — and reads as ALL WALL,
    // which is the honest answer for a tube with no interior rather than a
    // divide-by-zero dressed up as a centreline.
    data[o + 1] = radiusPx > 0 ? Math.min(1, Math.max(0, 1 - net.wallDistByTexel[i] / radiusPx)) : 1;
    data[o + 2] = id;
    data[o + 3] = radiusPx;
  }

  return {
    spec: net.spec,
    width: w,
    height: h,
    data,
    tubeCount: net.tubeCount,
    maxTubeWidthTexels,
  };
}

/**
 * Convert a pack's float data to half-float bit patterns for upload.
 *
 * Split from {@link buildFluidPack} so the pack itself stays exact and
 * assertable — a test that had to decode half-floats to check `tubeId` would be
 * testing the encoder and the builder at once, and would fail ambiguously.
 *
 * @param {FluidPack} pack
 * @returns {Uint16Array}
 */
export function packToHalfFloat(pack) {
  const out = new Uint16Array(pack.data.length);
  for (let i = 0; i < pack.data.length; i++) out[i] = toHalfFloat(pack.data[i]);
  return out;
}
