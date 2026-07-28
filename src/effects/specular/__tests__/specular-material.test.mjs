/**
 * specular-material.test.mjs — the mask decode.
 *
 * "The darker the pixels in the specular mask, the less shiny the surface is"
 * is the authoring contract the whole effect rests on, and it is one function.
 * These assertions pin it, plus the two things about it non-obvious enough that
 * a future reader could "correct" them into a bug.
 *
 * The PBR decode this replaces (F0, metalness, roughness, GGX, Smith, Schlick)
 * is gone — see `specular-pattern.js`'s header for why a 2D top-down map has no
 * angles for any of it to act on, and `specular.js`'s for the doctrine that
 * went with it.
 */
import {
  decodeSpecularMask,
  describeSpecularMapping,
  keyLightDirection,
  smoothstep,
  SPECULAR_PRESENCE_EDGE0,
  SPECULAR_PRESENCE_EDGE1,
  SPECULAR_ALPHA_EPSILON,
  LUMA_601,
  LUMA_709,
} from '../specular-material.js';

/** Rec.709 luma of a tint — the quantity the decode promises to preserve.
 * @param {number[]} c @returns {number} */
function luma709(c) {
  return c[0] * LUMA_709[0] + c[1] * LUMA_709[1] + c[2] * LUMA_709[2];
}

/** @param {{ok: Function}} t */
export function run(t) {
  const { ok } = t;

  // ── STRENGTH: darker paint is less shiny ────────────────────────────────
  const dark = decodeSpecularMask(0.2, 0.2, 0.2, 1);
  const mid = decodeSpecularMask(0.5, 0.5, 0.5, 1);
  const bright = decodeSpecularMask(1, 1, 1, 1);
  ok('darker paint decodes to less strength', dark.strength < mid.strength && mid.strength < bright.strength);
  ok('white at full alpha is full strength', Math.abs(bright.strength - 1) < 1e-9);
  ok('black is zero strength', decodeSpecularMask(0, 0, 0, 1).strength === 0);
  ok('alpha scales strength', Math.abs(decodeSpecularMask(1, 1, 1, 0.5).strength - 0.5) < 1e-9);

  // ⚠️ THE ALPHA-MISSING FALLBACK, and it is load-bearing rather than
  // defensive. A greyscale mask with no alpha channel is the common authoring
  // case; without this branch every such map decodes to `luma × 0` and renders
  // pure black, which is indistinguishable from "the effect is broken". V2
  // carried it, and shipping without it would silently break existing maps.
  const noAlpha = decodeSpecularMask(0.5, 0.5, 0.5, 0);
  ok('a mask with NO alpha channel falls back to luminance alone', Math.abs(noAlpha.strength - 0.5) < 1e-9);
  ok(
    '…and the fallback triggers below the documented epsilon, not at exactly 0',
    Math.abs(decodeSpecularMask(1, 1, 1, SPECULAR_ALPHA_EPSILON / 2).strength - 1) < 1e-9
  );
  ok(
    '…while a genuinely near-zero alpha above it still dims',
    decodeSpecularMask(1, 1, 1, SPECULAR_ALPHA_EPSILON * 10).strength < 0.01
  );

  // ⚠️ RAW VALUES, NO TRANSFER CURVE. V2 uploaded the mask `NoColorSpace` and
  // every existing map was painted against that, so "50% grey" must mean 0.5
  // and not sRGB's 0.21. An sRGB decode here silently re-exposes every map that
  // has ever been authored.
  ok('a 50% grey texel decodes to 0.5, not to sRGB-linear 0.21', Math.abs(mid.strength - 0.5) < 1e-9);

  // ── TINT: hue without a second brightness penalty ───────────────────────
  const gold = decodeSpecularMask(1, 0.766, 0.336, 1);
  ok('gold keeps its hue', gold.tint[0] > gold.tint[1] && gold.tint[1] > gold.tint[2]);
  // THE CENTRAL PROPERTY. A naive `rgb × strength` darkens saturated paint
  // twice — once for being dark, once for being coloured — so gold painted as
  // brightly as grey would return LESS light than the grey. Re-normalising the
  // tint to carry `strength` as its own luma is what makes "which metal" a
  // statement about colour rather than about brightness.
  ok('the tint carries strength as its own luma', Math.abs(luma709(gold.tint) - gold.strength) < 1e-6);
  ok('…for a neutral too', Math.abs(luma709(mid.tint) - mid.strength) < 1e-6);
  const blue = decodeSpecularMask(0.1, 0.15, 0.9, 1);
  ok('…and for a deeply saturated blue', Math.abs(luma709(blue.tint) - blue.strength) < 1e-6);

  const neutral = decodeSpecularMask(1, 0.766, 0.336, 1, 0);
  ok('saturation 0 gives a neutral white shine', Math.abs(neutral.tint[0] - neutral.tint[1]) < 1e-9);
  ok('…at the same strength — colour is dropped, brightness is not', Math.abs(neutral.strength - gold.strength) < 1e-9);
  ok('saturation is clamped rather than exploding', decodeSpecularMask(1, 0.5, 0.2, 1, 99).tint.every(Number.isFinite));

  // A black texel has no hue to preserve and the normalisation would divide by
  // zero. Its strength is 0 so the tint is never seen, but a NaN reaching an
  // additive blend paints a permanent black hole that no parameter explains.
  ok('a black texel produces no NaN', decodeSpecularMask(0, 0, 0, 1).tint.every(Number.isFinite));

  // ── THE PRESENCE EDGE ───────────────────────────────────────────────────
  ok('the presence band starts near zero', SPECULAR_PRESENCE_EDGE0 < SPECULAR_PRESENCE_EDGE1);
  ok('an unpainted texel has no presence', smoothstep(SPECULAR_PRESENCE_EDGE0, SPECULAR_PRESENCE_EDGE1, 0) === 0);
  ok('a fully painted texel has full presence', smoothstep(SPECULAR_PRESENCE_EDGE0, SPECULAR_PRESENCE_EDGE1, 1) === 1);
  ok('the band is narrow — it antialiases an edge, it does not fade dark metal', SPECULAR_PRESENCE_EDGE1 < 0.1);

  // ── THE LUMA WEIGHTINGS ─────────────────────────────────────────────────
  // Two different weightings in one decode looks like an oversight. It is not:
  // 601 is what V2 measured strength with, so every existing file keeps the
  // brightness its author saw; 709 is correct for re-normalising a colour.
  // Unifying them would silently re-expose every painted map.
  ok(
    'both weightings sum to 1',
    Math.abs(LUMA_601.reduce((a, b) => a + b) - 1) < 1e-9 && Math.abs(LUMA_709.reduce((a, b) => a + b) - 1) < 1e-9
  );
  ok('they are genuinely different weightings', LUMA_601[1] !== LUMA_709[1]);

  // ── THE SUN VECTOR ──────────────────────────────────────────────────────
  const horizon = keyLightDirection({ dirX: 0, dirY: 1, elevationDeg: 0 });
  ok('a horizon sun points along its own azimuth', Math.abs(horizon[1] - 1) < 1e-6);
  ok(
    'the vector is unit length',
    Math.abs(Math.hypot(...keyLightDirection({ dirX: 0.6, dirY: 0.8, elevationDeg: 30 })) - 1) < 1e-6
  );
  ok('a degenerate key falls back to straight up rather than NaN', keyLightDirection({}).every(Number.isFinite));

  // ── THE COORDINATE TWIN ─────────────────────────────────────────────────
  const m = describeSpecularMapping({
    maskRect: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    quadWorld: { minX: 100, minY: 200, maxX: 900, maxY: 800 },
    viewRect: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
  });
  ok('the twin reports mask UV at the quad corners', m.maskUvAtQuadCorners.bottomLeft[0] === 0.1);
  ok('…and at the far corner', m.maskUvAtQuadCorners.topRight[0] === 0.9);
  ok('the twin reports the view span', m.viewSpanX === 2000);
  ok(
    'a missing rect reports null rather than throwing',
    describeSpecularMapping({ maskRect: null, quadWorld: null, viewRect: null }).maskUvAtQuadCorners === null
  );
}
