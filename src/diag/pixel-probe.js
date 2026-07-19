/**
 * THE PIXEL PROBE (2026-07-19) — pure decode logic for a live GPU
 * pixel-readback diagnostic. Born from the region-darkness rendering audit:
 * `getRegionDarknessInfo()` proved a region's MATH was correct, but couldn't
 * answer whether that value actually reached the screen — `sampleIllumPixel`
 * (vt-pan-viewer.js) answers that by reading `buf:scene.illum` directly off
 * the GPU. This module holds the decode primitives worth Node-testing in
 * isolation: `decodeHalfFloatRgba` for the HalfFloatType targets (illum/lit/
 * albedo/coloration) so nobody has to hand-decode IEEE-754 half-float bit
 * patterns from a console readback again, and `decodeByteRgba` for the ONE
 * UnsignedByteType target (occlusion.mask) so that buffer's report reads in
 * the same 0..1-ish shape as every other, not a separate byte convention.
 * THIS TOOL FOUND [[keyhole-region-discard-noop-bug]] — a bug no amount of
 * code-reading or CPU-side diagnostics caught. It is the load-bearing
 * instrument for "the math is right but the picture is wrong": reach for it
 * before writing another CPU-side report.
 *
 * The author's own framing: V2 had a much larger "Scene Pixel Probe" tool
 * (legacy/utils/scene-pixel-probe.js, ~1600 lines) doing multi-point
 * brightness/lighting/mask attribution across V2's entire compositor stack
 * — explicitly NOT portable (coupled to V2's FloorCompositorV2/
 * WindowLightEffect/ColorCorrection internals that don't exist in V3), but
 * flagged as a genuinely useful CONCEPT worth a custom V3 rebuild later.
 * This module is the minimal seed of that rebuild: the decode primitive a
 * richer future probe (multi-point comparison, attribution, hypotheses)
 * would still need at its core, kept deliberately small and Node-tested now
 * rather than scoped up mid-investigation.
 *
 * @module diag/pixel-probe
 */

/**
 * Decode ONE 16-bit IEEE-754 half-float BIT PATTERN — exactly what a raw
 * GPU pixel readback of a `THREE.HalfFloatType` render target hands back
 * (verified live, 2026-07-19: `MapShine.sampleIllumPixel`'s first real call
 * returned `14780`, which THIS function decodes to ≈0.7168 — matching
 * `region-darkness.js`'s own computed `resultColor` of 0.7173 to within
 * half-float rounding, the exact number that confirmed a region WAS
 * correctly painting `buf:scene.illum` at that pixel). Standard IEEE-754
 * binary16: 1 sign bit, 5 exponent bits, 10 mantissa bits.
 *
 * @param {number} bits - 0..65535, a raw half-float bit pattern.
 * @returns {number} the decoded value (NaN/±Infinity handled per IEEE-754).
 */
export function halfFloatBitsToFloat32(bits) {
  const b = bits & 0xffff;
  const sign = b & 0x8000 ? -1 : 1;
  const exponent = (b >> 10) & 0x1f;
  const mantissa = b & 0x3ff;
  if (exponent === 0) {
    // Zero (mantissa 0) or a subnormal — both fall out of this one formula.
    return sign * mantissa * Math.pow(2, -24);
  }
  if (exponent === 0x1f) {
    return mantissa ? NaN : sign * Infinity;
  }
  return sign * (1 + mantissa / 1024) * Math.pow(2, exponent - 15);
}

/**
 * Decode a raw RGBA readback (4 half-float bit patterns, as returned by
 * `renderer.readRenderTargetPixelsAsync` for a `HalfFloatType` target) into
 * normal 0..1-ish numbers.
 *
 * @param {ArrayLike<number>|null} raw - length-4 (or a multiple of 4 for a
 *   multi-pixel read; only the first 4 are decoded here — a probe reads one
 *   pixel at a time by design, see `sampleIllumPixel`'s own header).
 * @returns {[number,number,number,number]|null}
 */
export function decodeHalfFloatRgba(raw) {
  if (!raw || raw.length < 4) return null;
  return [
    halfFloatBitsToFloat32(raw[0]),
    halfFloatBitsToFloat32(raw[1]),
    halfFloatBitsToFloat32(raw[2]),
    halfFloatBitsToFloat32(raw[3]),
  ];
}

/**
 * Decode a raw RGBA readback from an `UnsignedByteType` target (plain 0..255
 * ints, e.g. `occlusion.mask` — see `describeOcclusionMask`'s own header for
 * why that buffer is a byte target, not half-float) into the same 0..1-ish
 * shape `decodeHalfFloatRgba` returns, so a probe report can treat every
 * buffer's `rgba` field uniformly regardless of its underlying GPU format.
 * Reference point: Foundry's occlusion clear colour is `[0,1,1,1]`
 * (`describeOcclusionMask`'s comment) — a genuinely CLEARED texel reads back
 * as raw bytes `[0,255,255,255]`, which this decodes to exactly `[0,1,1,1]`.
 *
 * @param {ArrayLike<number>|null} raw - length-4 (or a multiple of 4; only
 *   the first 4 are decoded, same one-pixel-at-a-time convention as
 *   `decodeHalfFloatRgba`).
 * @returns {[number,number,number,number]|null}
 */
export function decodeByteRgba(raw) {
  if (!raw || raw.length < 4) return null;
  return [(raw[0] & 0xff) / 255, (raw[1] & 0xff) / 255, (raw[2] & 0xff) / 255, (raw[3] & 0xff) / 255];
}

/** Channel labels, in `rgba` array order — used only for `diffProbeBuffers`' report shape. */
const RGBA_CHANNELS = ['r', 'g', 'b', 'a'];

/**
 * Diff two probe points' decoded buffers, per buffer, per channel —
 * automates the exact by-hand comparison that found
 * `keyhole-region-discard-noop-bug` and `keyhole-light-region-aware-ambient-fix`:
 * "a point just outside X reads one value, a point just inside reads
 * another — is that jump a real edge or a bug?" A big `biggestJump` between
 * two points that are close together in world space is the signature of a
 * hard seam (an unintended discontinuity); a big jump between two points on
 * opposite sides of an intentional boundary (a light's own falloff edge, a
 * region's authored edge) is expected and this alone can't tell the two
 * apart — it surfaces the number, the investigator still supplies the
 * context of where the points were placed.
 *
 * @param {object|null} prevBuffers - a probe result's `.buffers` (or null).
 * @param {object|null} currBuffers - a probe result's `.buffers` (or null).
 * @returns {{perBuffer: object, biggestJump: {buffer:string, channel:string,
 *   value:number, absValue:number}|null}|null} null if either side is
 *   missing (e.g. a point landed off-screen and was never read back).
 */
export function diffProbeBuffers(prevBuffers, currBuffers) {
  if (!prevBuffers || !currBuffers) return null;
  const perBuffer = {};
  let biggestJump = null;
  for (const name of Object.keys(currBuffers)) {
    const prevRgba = prevBuffers[name]?.rgba;
    const currRgba = currBuffers[name]?.rgba;
    if (!prevRgba || !currRgba) continue;
    const delta = currRgba.map((v, i) => +(v - prevRgba[i]).toFixed(4));
    perBuffer[name] = delta;
    for (let i = 0; i < delta.length; i++) {
      const absValue = Math.abs(delta[i]);
      if (!biggestJump || absValue > biggestJump.absValue) {
        biggestJump = { buffer: name, channel: RGBA_CHANNELS[i] ?? String(i), value: delta[i], absValue };
      }
    }
  }
  if (!Object.keys(perBuffer).length) return null;
  return { perBuffer, biggestJump };
}
