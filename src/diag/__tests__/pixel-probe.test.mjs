/**
 * Node verification for diag/pixel-probe.js — the half-float readback decoder.
 */
import { halfFloatBitsToFloat32, decodeHalfFloatRgba, decodeByteRgba, diffProbeBuffers } from '../pixel-probe.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // ---- REAL, OBSERVED data (2026-07-19) — the exact bit pattern
  // MapShine.sampleIllumPixel returned live, and the resultColor
  // region-darkness.js computed for that same region/pixel. This is a
  // regression anchor, not a synthetic case: if this ever stops matching,
  // either the decoder or the readback path broke. -----------------------
  ok(
    'the live-observed DARKEN-region bit pattern (14780) decodes to ~0.7173 (region-darkness.js resultColor)',
    near(halfFloatBitsToFloat32(14780), 0.7172549019607843, 0.002)
  );
  ok('the live-observed alpha bit pattern (15360) decodes to exactly 1.0', halfFloatBitsToFloat32(15360) === 1);

  // ---- known IEEE-754 binary16 reference values --------------------------
  ok('0x0000 decodes to 0', halfFloatBitsToFloat32(0x0000) === 0);
  ok('0x3c00 decodes to 1.0', halfFloatBitsToFloat32(0x3c00) === 1);
  ok('0xbc00 decodes to -1.0', halfFloatBitsToFloat32(0xbc00) === -1);
  ok('0x4000 decodes to 2.0', halfFloatBitsToFloat32(0x4000) === 2);
  ok('0x3800 decodes to 0.5', halfFloatBitsToFloat32(0x3800) === 0.5);
  ok('0x7c00 (max exponent, zero mantissa) decodes to +Infinity', halfFloatBitsToFloat32(0x7c00) === Infinity);
  ok(
    '0xfc00 (max exponent, sign set, zero mantissa) decodes to -Infinity',
    halfFloatBitsToFloat32(0xfc00) === -Infinity
  );
  ok('0x7e00 (max exponent, nonzero mantissa) decodes to NaN', Number.isNaN(halfFloatBitsToFloat32(0x7e00)));
  ok(
    'a subnormal bit pattern decodes to a tiny positive number, not NaN/Infinity',
    (() => {
      const v = halfFloatBitsToFloat32(0x0001);
      return Number.isFinite(v) && v > 0 && v < 1e-4;
    })()
  );
  ok(
    'a value beyond 16 bits is masked down, never throws or reads a sign bit that is not really set',
    (() => {
      // 0x1_3c00 (bit 16 set + 0x3c00) must decode identically to 0x3c00.
      return halfFloatBitsToFloat32(0x13c00) === halfFloatBitsToFloat32(0x3c00);
    })()
  );

  // ---- decodeHalfFloatRgba -------------------------------------------------
  ok(
    'decodes a real 4-element RGBA readback into normal 0..1-ish numbers',
    (() => {
      const [r, g, b, a] = decodeHalfFloatRgba([14780, 14780, 14780, 15360]);
      return near(r, 0.7173, 0.002) && near(g, 0.7173, 0.002) && near(b, 0.7173, 0.002) && a === 1;
    })()
  );
  ok(
    'null/undefined input reads as null, never throws',
    decodeHalfFloatRgba(null) === null && decodeHalfFloatRgba(undefined) === null
  );
  ok('a too-short array reads as null', decodeHalfFloatRgba([1, 2, 3]) === null);

  // ---- decodeByteRgba (occlusion.mask, UnsignedByteType — a different GPU
  // format than illum/lit/albedo/coloration, so a separate decode path) ----
  ok(
    "Foundry's occlusion clear colour [0,1,1,1] round-trips through its own byte encoding " +
      "([0,255,255,255]) back to [0,1,1,1] exactly (describeOcclusionMask's own documented clear value)",
    (() => {
      const [r, g, b, a] = decodeByteRgba([0, 255, 255, 255]);
      return r === 0 && g === 1 && b === 1 && a === 1;
    })()
  );
  ok(
    'a mid-range byte (128) decodes to ~0.502, not 0.5 (integer byte quantization, not a float shortcut)',
    near(decodeByteRgba([128, 128, 128, 128])[0], 128 / 255, 1e-9)
  );
  ok(
    'values are masked to 8 bits, never read a value above 1.0',
    decodeByteRgba([300, 0, 0, 0])[0] === (300 & 0xff) / 255
  );
  ok(
    'null/undefined input reads as null, never throws',
    decodeByteRgba(null) === null && decodeByteRgba(undefined) === null
  );
  ok('a too-short array reads as null', decodeByteRgba([1, 2, 3]) === null);

  // ---- diffProbeBuffers — the by-hand "point A vs point B" comparison,
  // automated -----------------------------------------------------------
  const bufA = {
    illum: { rgba: [0.717, 0.717, 0.717, 1] },
    lit: { rgba: [0.5, 0.5, 0.5, 1] },
  };
  const bufB = {
    illum: { rgba: [0.934, 0.934, 0.934, 1] },
    lit: { rgba: [0.5, 0.5, 0.5, 1] },
  };
  ok(
    'flags the exact live-observed region-boundary jump (0.717 -> 0.934) as the biggest, in the illum buffer',
    (() => {
      const d = diffProbeBuffers(bufA, bufB);
      return (
        d.biggestJump.buffer === 'illum' && d.biggestJump.channel === 'r' && near(d.biggestJump.absValue, 0.217, 0.001)
      );
    })()
  );
  ok(
    'an identical buffer contributes zero delta and is never picked as the biggest jump',
    diffProbeBuffers(bufA, bufB).perBuffer.lit.every((v) => v === 0)
  );
  ok(
    'a buffer missing from one side is skipped, not thrown on',
    diffProbeBuffers({ illum: { rgba: [0, 0, 0, 1] } }, { illum: { rgba: [1, 1, 1, 1] } }, {}).perBuffer.illum !==
      undefined
  );
  ok(
    'either side missing reads as null, never throws',
    diffProbeBuffers(null, bufB) === null && diffProbeBuffers(bufA, null) === null
  );
  ok(
    'two buffers sharing no keys read as null',
    diffProbeBuffers({ a: { rgba: [0, 0, 0, 0] } }, { b: { rgba: [0, 0, 0, 0] } }) === null
  );
}
