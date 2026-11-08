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

// ============================================================================
// PROBE v2 PRIMITIVES (2026-11-08, mmp-78u.12) — the MSA Lab's main instrument.
// Born from the lab's friction log (tools/lab/FRICTION.md): the probe silently
// capped at 3 points, its readings mid-rebuild were garbage, and nothing compared
// the PRESENTED pixel with the lit buffer — the gap that hid the Lens freeze
// (mmp-78u.7: present kept reading a stale texture while "ready" said all good).
// ============================================================================

/** sRGB OETF: linear 0..1 → encoded 0..1 (the curve a screen byte is written in). */
export function srgbEncode(linear) {
  const c = Math.max(0, Math.min(1, Number(linear) || 0));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** A linear 0..1 value as the screen byte it would be with NO tone curve: round(255 · OETF). */
export function linearToSrgbByte(linear) {
  return Math.round(255 * srgbEncode(linear));
}

/**
 * The first pixel of a canvas-texture copy as [r, g, b, a] bytes. The canvas format is
 * whatever `navigator.gpu.getPreferredCanvasFormat()` said — 'bgra8unorm' on most Windows
 * GPUs, so the bytes arrive B, G, R, A and must be swapped.
 * @param {ArrayLike<number>|null} bytes
 * @param {string} format
 * @returns {[number,number,number,number]|null}
 */
export function decodeCanvasPixel(bytes, format) {
  if (!bytes || bytes.length < 4) return null;
  const b = [bytes[0] & 0xff, bytes[1] & 0xff, bytes[2] & 0xff, bytes[3] & 0xff];
  return String(format).startsWith('bgra') ? [b[2], b[1], b[0], b[3]] : b;
}

/**
 * How far the PRESENTED pixel sits from the lit buffer encoded straight to sRGB.
 *
 * The present pass legitimately moves a pixel (tone curve, exposure, grade, bloom, lens), so a
 * small drift is normal: measured on the lab, noon Measure view moves 128 by ~-2, as-shipped by
 * ~-20. A drift of several dozen levels means the screen is not showing this frame's lit —
 * the Lens freeze moved a black wedge step (lit 0) to ~100.
 *
 * @param {{lit:number[]|null, presented:number[]|null}} a - lit linear RGB, presented bytes.
 * @param {{check?:number, suspect?:number}} [t] - thresholds in screen levels.
 * @returns {{expected:number[], drift:number[], maxAbs:number, verdict:'ok'|'check'|'suspect'}|null}
 */
export function judgePresentedDrift({ lit, presented }, { check = 32, suspect = 64 } = {}) {
  if (!lit || !presented) return null;
  const expected = lit.slice(0, 3).map(linearToSrgbByte);
  const drift = expected.map((e, i) => Math.round((presented[i] ?? 0) - e));
  const maxAbs = Math.max(...drift.map(Math.abs));
  const verdict = maxAbs >= suspect ? 'suspect' : maxAbs >= check ? 'check' : 'ok';
  return { expected, drift, maxAbs, verdict };
}

/**
 * Did a buffer read stay put between two frames? `eps` is in buffer units (linear light).
 * Used to wait out a rebuild: reads taken mid-swap return garbage (lab: lit 0.488 vs 0.184).
 * @param {object|null} a - a probe sample's `.buffers`
 * @param {object|null} b
 * @param {string[]} [names]
 * @param {number} [eps]
 */
export function buffersAgree(a, b, names = ['illum', 'lit', 'albedo'], eps = 0.004) {
  if (!a || !b) return false;
  for (const n of names) {
    const x = a[n]?.rgba;
    const y = b[n]?.rgba;
    if (!x || !y) return false;
    for (let i = 0; i < 3; i++) if (Math.abs(x[i] - y[i]) > eps) return false;
  }
  return true;
}

/**
 * One line of mask facts for a point on one floor, from `MapShine.probeMasks`' stack:
 * every mask kind's composited byte (null = no file / not painted) and the derived products.
 * @param {object|null} stack - probeStackAt(...) result
 * @param {number} floorIndex
 * @returns {{floor:string|null, masks:Record<string, number|null>, derived:object|null}|null}
 */
export function compactMaskStack(stack, floorIndex) {
  const f = stack?.floors?.find?.((x) => x.floorIndex === floorIndex) ?? stack?.floors?.[0];
  if (!f) return null;
  const masks = {};
  for (const [kind, v] of Object.entries(f.masks ?? {})) {
    if (v && (v.sourceCount ?? 0) > 0) masks[kind] = v.compositedByte ?? null;
  }
  return { floor: f.name ?? null, masks, derived: f.derived ?? null };
}
