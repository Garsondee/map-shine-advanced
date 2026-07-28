/**
 * window-cookie.test.mjs — the mask decode.
 *
 * "A bright pixel in `_Windows` is where a bright light would fall on the
 * interior at day" is the authoring contract the whole effect rests on
 * (author directive, 2026-07-27). These assertions pin the decode, plus the
 * two things about it non-obvious enough that a future reader could
 * "correct" them into a bug: the alpha-missing fallback, and why tint and
 * level are kept as two separate numbers.
 */
import {
  decodeWindowMask,
  cookieRgb,
  smoothstep,
  softShoulder,
  shoulderedContribution,
  WINDOW_PRESENCE_EDGE0,
  WINDOW_PRESENCE_EDGE1,
  WINDOW_SHOULDER_K,
} from '../window-cookie.js';

/** @param {number[]} c @returns {number} */
function peak(c) {
  return Math.max(c[0], c[1], c[2]);
}

/** @param {{ok: Function}} t */
export function run(t) {
  const { ok } = t;

  // ── LEVEL: darker paint is dimmer light ──────────────────────────────────
  const dark = decodeWindowMask(0.2, 0.2, 0.2, 1);
  const mid = decodeWindowMask(0.5, 0.5, 0.5, 1);
  const bright = decodeWindowMask(1, 1, 1, 1);
  ok('darker paint decodes to a dimmer level', dark.level < mid.level && mid.level < bright.level);
  ok('fully bright white paint decodes near level 1', bright.level > 0.98);

  // ── TINT: a stained-glass patch keeps its own hue ────────────────────────
  const red = decodeWindowMask(1, 0, 0, 1);
  ok('a pure red cookie tints red', red.tint[0] > 0.95 && red.tint[1] < 0.05 && red.tint[2] < 0.05);
  const grey = decodeWindowMask(0.5, 0.5, 0.5, 1);
  ok('grey paint tints neutral white', Math.abs(grey.tint[0] - 1) < 1e-4 && Math.abs(grey.tint[1] - 1) < 1e-4);

  // ⚠️ Gold and white painted at the SAME peak channel (v = max(r,g,b) = 1 for
  // both) must return the SAME amount of light, in different colours — a
  // naive `rgb × level` would darken saturated paint twice (once for being
  // dark, once for being coloured). Comparing against `grey` (v = 0.5) would
  // not be a fair test — that cookie is genuinely dimmer paint.
  const gold = decodeWindowMask(1, 0.8, 0.3, 1);
  const white = decodeWindowMask(1, 1, 1, 1);
  const goldCookie = cookieRgb(gold);
  const whiteCookie = cookieRgb(white);
  ok(
    'gold and white at the same peak brightness return the same peak light',
    Math.abs(peak(goldCookie) - peak(whiteCookie)) < 0.02
  );

  // ── PRESENCE: the antialiased floor ───────────────────────────────────────
  const belowEdge = decodeWindowMask(0.001, 0.001, 0.001, 1);
  ok('near-zero paint has zero presence', belowEdge.presence === 0);
  const aboveEdge = decodeWindowMask(0.5, 0.5, 0.5, 1);
  ok('ordinary painted value is fully present', aboveEdge.presence === 1);
  ok(
    'the presence band is narrow enough to preserve the dark end of the range',
    WINDOW_PRESENCE_EDGE1 - WINDOW_PRESENCE_EDGE0 < 0.1
  );

  // ⚠️ THE ALPHA-MISSING FALLBACK IS LOAD-BEARING — a greyscale `_Window` with
  // no real alpha channel is the common authoring case, and without this
  // branch every such file would decode to level 0 everywhere.
  const noAlpha = decodeWindowMask(0.8, 0.8, 0.8, 0);
  ok('a file with no alpha channel still lights (the epsilon fallback)', noAlpha.level > 0.5);
  const belowEpsilonAlpha = decodeWindowMask(0.8, 0.8, 0.8, 0.00001);
  ok(
    'an alpha below the epsilon is treated the same as missing, never as "fully transparent"',
    Math.abs(belowEpsilonAlpha.level - noAlpha.level) < 1e-6
  );
  const halfAlpha = decodeWindowMask(0.8, 0.8, 0.8, 0.5);
  ok('a REAL half-alpha genuinely halves the level', halfAlpha.level < noAlpha.level);

  // ── CONTRAST: a gamma on level, never on presence or tint ────────────────
  const lowContrast = decodeWindowMask(0.5, 0.5, 0.5, 1, 0.5);
  const highContrast = decodeWindowMask(0.5, 0.5, 0.5, 1, 2);
  ok('contrast > 1 darkens a mid-value cookie (sharper falloff)', highContrast.level < mid.level);
  ok('contrast < 1 brightens a mid-value cookie (softer falloff)', lowContrast.level > mid.level);
  ok('contrast never touches tint', lowContrast.tint[0] === mid.tint[0] && highContrast.tint[0] === mid.tint[0]);
  ok(
    'contrast never touches presence — it is a value gamma, not a threshold shift',
    lowContrast.presence === mid.presence && highContrast.presence === mid.presence
  );

  // ── NaN safety on pure black — never seen, but must never poison a sum ───
  const black = decodeWindowMask(0, 0, 0, 1);
  ok(
    'pure black never produces NaN in its tint (an additive blend cannot recover from one)',
    Number.isFinite(black.tint[0]) && Number.isFinite(black.tint[1]) && Number.isFinite(black.tint[2])
  );

  // ── smoothstep itself (TSL-arg-order transcription target) ──────────────
  ok('smoothstep(0,1,0) = 0', smoothstep(0, 1, 0) === 0);
  ok('smoothstep(0,1,1) = 1', smoothstep(0, 1, 1) === 1);
  ok('smoothstep is monotonic across the ramp', smoothstep(0, 1, 0.25) < smoothstep(0, 1, 0.75));
  ok('a degenerate zero-width edge does not divide by zero', Number.isFinite(smoothstep(0.5, 0.5, 0.6)));

  // ── THE HIGHLIGHT SHOULDER — found live: a large cookie over bright art ──
  // washed out to a flat white disc. See shoulderedContribution's own header
  // for the exact composite formula this is calibrated against.
  ok('shoulder is a no-op at 0', softShoulder(0) === 0);
  ok('shoulder never returns negative for a negative (clamped) input', softShoulder(-5) === 0);
  ok(
    'shoulder is monotonic — brighter raw is never darker after shaping',
    softShoulder(0.2) < softShoulder(0.5) && softShoulder(0.5) < softShoulder(1) && softShoulder(1) < softShoulder(3)
  );
  ok(
    'near-identity at small values — a modest cookie is not visibly altered',
    Math.abs(softShoulder(0.05) - 0.05) / 0.05 < 0.05
  );
  ok(
    'a fully-painted, default-strength cookie (raw=1) lands close to the documented ≈0.556',
    Math.abs(softShoulder(1) - 1 / (1 + WINDOW_SHOULDER_K)) < 1e-9
  );
  ok(
    'the asymptote holds even at an extreme (maxed strength=3) input — never reaches, let alone exceeds, 1/K',
    softShoulder(3) < 1 / WINDOW_SHOULDER_K && softShoulder(1000) < 1 / WINDOW_SHOULDER_K
  );

  // ⚠️ HUE/SATURATION MUST SURVIVE COMPRESSION. Compressing R, G, B
  // independently would desaturate a saturated cookie exactly where it is
  // brightest (the curve's slope shrinks as its input grows, and an unevenly
  // saturated colour has channels sitting at different points on that
  // shrinking slope) — shaping the PEAK and rescaling all three by the SAME
  // ratio is what this test actually pins.
  const saturatedRaw = [1.2, 0.6, 0.1]; // a bright, saturated orange-red beam past raw=1
  const shaped = shoulderedContribution(saturatedRaw);
  const rawRatioGR = saturatedRaw[1] / saturatedRaw[0];
  const rawRatioBR = saturatedRaw[2] / saturatedRaw[0];
  const shapedRatioGR = shaped[1] / shaped[0];
  const shapedRatioBR = shaped[2] / shaped[0];
  ok(
    'the shoulder preserves hue/saturation — channel RATIOS are unchanged by compression',
    Math.abs(shapedRatioGR - rawRatioGR) < 1e-9 && Math.abs(shapedRatioBR - rawRatioBR) < 1e-9
  );
  ok('…while genuinely compressing the peak', Math.max(...shaped) < Math.max(...saturatedRaw));

  // ── MEASURE THE NET, NOT THE EQUATION (feedback_measure_the_output_not_
  // the_equation) — simulate the REAL composite formula
  // (environmental-light.js: `lit = EOTF(OETF(albedo) × illum)`, i.e. in sRGB
  // terms `litSrgb = albedoSrgb × illum`) rather than trusting that a
  // reasonable-looking shoulder constant behaves sanely in the units the
  // screen actually uses.
  const litSrgb = (albedoSrgb, illum) => albedoSrgb * illum;
  const paleAlbedo = 0.88; // a pale stone floor / gold trim / parchment — the exact case that blew out live
  const dimAmbient = 0.3; // a typical dim-to-moderate lit interior before this effect touches it
  const brightAmbient = 0.9; // a bright daylight interior — little headroom left, the worst realistic case

  // The common case: a fully-painted, default-strength cookie in a dim room
  // must brighten the room WITHOUT clipping.
  const dimTotal = dimAmbient + shoulderedContribution([1, 1, 1])[0];
  ok('typical dim interior + a full cookie: illum rises well above ambient', dimTotal > dimAmbient * 1.5);
  ok('…and the composite does NOT clip on bright art', litSrgb(paleAlbedo, dimTotal) < 1.0);

  // The worst case: already-bright ambient + a MAXED strength slider (raw=3,
  // the top of WINDOW_PARAMS.strength's range) — the shoulder cannot see how
  // much headroom illum already has (reading it back would be the
  // read-while-write hazard this codebase avoids elsewhere), so it CANNOT
  // guarantee zero clipping here. What it must guarantee is that the
  // overshoot is meaningfully smaller than an unshouldered add would produce.
  const maxedRawContribution = 3; // strength=3, fully painted, full coverage, no cloud dimming
  const shoulderedTotal = brightAmbient + shoulderedContribution([maxedRawContribution, 0, 0])[0];
  const unshoulderedTotal = brightAmbient + maxedRawContribution;
  const shoulderedOvershoot = Math.max(0, litSrgb(paleAlbedo, shoulderedTotal) - 1);
  const unshoulderedOvershoot = Math.max(0, litSrgb(paleAlbedo, unshoulderedTotal) - 1);
  ok(
    'worst case (bright ambient + maxed strength) still overshoots less than half of what an unshouldered add would',
    shoulderedOvershoot < unshoulderedOvershoot * 0.5
  );
  ok(
    '…and the unshouldered comparison genuinely would have overshot (proves this is a real improvement)',
    unshoulderedOvershoot > 0.5
  );
}
