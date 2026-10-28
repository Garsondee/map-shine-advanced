/**
 * Node verification for effects/window/window-weather.js — the pure halves
 * (the cover→break threshold, the golden-hour weight, the dramatic daylight
 * tint). The TSL gain itself is lab/browser-verified (tools/shader-lab/wind-lab).
 */
import {
  windowBreakThreshold,
  windowGolden01,
  windowDaylightTint,
  windowFill01,
  windowTargetLight,
  windowLightDelta,
  WINDOW_OUTDOOR_MATCH_DEFAULT,
  WINDOW_WEATHER_DEFAULTS,
} from '../window-weather.js';
import { WINDOW_PARAMS } from '../window.js';
import { computeSun } from '../../../world/sun.js';
import { createSkyHandle } from '../../sky-access.js';
import { hexToRgb01 } from '../../candle-flame-geometry.js';

const luma = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

// Fraction of a unit normal above z — the break field is a standardised noise.
const above = (z) => 0.5 * (1 - erf(z / Math.SQRT2));
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

export function run(t) {
  const { ok } = t;
  ok('a clear sky lets every fragment through the breaks', above(windowBreakThreshold(0)) > 0.99);
  ok('70% cover keeps roughly half the window lit', Math.abs(above(windowBreakThreshold(0.7)) - 0.5) < 0.12);
  ok(
    '⭐ 90% cover leaves small patches (10-25% lit) — "dramatic smaller amounts"',
    above(windowBreakThreshold(0.9)) > 0.1 && above(windowBreakThreshold(0.9)) < 0.25
  );
  ok('more cloud never opens more breaks', windowBreakThreshold(0.95) > windowBreakThreshold(0.6));

  ok('no golden light at noon', windowGolden01({ twilight01: 0, dayFactor01: 1 }) === 0);
  ok('no golden light at night', windowGolden01({ twilight01: 0.2, dayFactor01: 0 }) === 0);
  ok('golden light peaks with the sun just up', windowGolden01({ twilight01: 0.7, dayFactor01: 0.7 }) > 0.9);

  const dawnDusk = [1, 0.4, 0.1];
  const night = [0.2, 0.35, 1];
  const noon = windowDaylightTint({ dawnDusk, night, twilight01: 0, dayFactor01: 1, goldenBoost: 0.9 });
  ok(
    'noon stays neutral',
    noon.every((v) => Math.abs(v - 1) < 1e-9)
  );
  const golden = windowDaylightTint({ dawnDusk, night, twilight01: 0.7, dayFactor01: 0.7, goldenBoost: 0.9 });
  // A LEAN on top of the outdoor light, which is already golden (the full-chain check below).
  ok('golden hour leans warm', golden[0] > golden[2] * 1.2);
  // 2026-10-27: it used to multiply by up to 1 + goldenBoost — the greenhouse blow-out.
  ok('⭐ the daylight tint is a HUE — golden hour no brighter than noon', Math.abs(luma(golden) - 1) < 1e-9);
  const harder = windowDaylightTint({ dawnDusk, night, twilight01: 0.7, dayFactor01: 0.7, goldenBoost: 2 });
  ok(
    'goldenBoost pushes the lean harder, still without brightening',
    harder[0] > golden[0] && Math.abs(luma(harder) - 1) < 1e-9
  );
  const moon = windowDaylightTint({ dawnDusk, night, twilight01: 0, dayFactor01: 0, goldenBoost: 0.9 });
  ok('night leans toward the night colour', moon[2] > moon[0] && Math.abs(luma(moon) - 1) < 1e-9);

  // ── THE OUTDOOR MATCH — the Mansion greenhouse (author, 2026-10-27: "it
  // should end up roughly the same brightness as the outdoors around it,
  // neither much darker nor brighter"). A white `_Window` at the shipped
  // strength (1.5) with the clear-noon boost (×1.3), through the real sun and
  // sky models, at the three hours she screenshotted.
  const D = WINDOW_PARAMS;
  const fill = windowFill01(D.strength.default * 1.3);
  ok('a white window at the default strength lets in nearly all the outdoor light', fill > 0.9);
  ok('a mid-grey one still reads as less', windowFill01(0.5 * D.strength.default) < 0.85);
  const tints = { dawnDusk: hexToRgb01(D.dawnDuskTint.default), night: hexToRgb01(D.nightTint.default) };
  const room = (sun, bg, sky) => {
    const outdoor = bg.map((v, i) => v * sky.ambientMultiplierRgb[i] + sky.moonAddRgb[i]);
    const hue = windowDaylightTint({
      ...tints,
      twilight01: sun.twilight01,
      dayFactor01: sun.dayFactor01,
      goldenBoost: D.goldenBoost.default,
    });
    const target = windowTargetLight({ outdoorRgb: outdoor, hueRgb: hue, outdoorMatch: D.outdoorMatch.default });
    const delta = windowLightDelta({ fill01: fill, targetRgb: target, indoorRgb: bg });
    return { outdoor, inside: bg.map((v, i) => v + delta[i]) };
  };
  const day = [0.93, 0.93, 0.93];
  {
    const sun = computeSun(12);
    const { outdoor, inside } = room(sun, day, createSkyHandle({ sun, goldenHour01: 0.78 }));
    const r = luma(inside) / luma(outdoor);
    ok(`⭐ noon: the greenhouse is about as bright as the garden (×${r.toFixed(2)})`, r > 0.95 && r < 2.1);
  }
  {
    const sun = computeSun(18 - 0.4);
    const { outdoor, inside } = room(sun, day, createSkyHandle({ sun, goldenHour01: 0.78 }));
    const r = luma(inside) / luma(outdoor);
    const peak = (c) => Math.max(...c);
    ok(`⭐ golden hour: no brighter than the garden beside it (×${r.toFixed(2)})`, r > 0.9 && r < 2.1);
    ok('…and no channel blown far past the garden', peak(inside) < peak(outdoor) * 2.1);
    // (1.6× since the golden grade was scaled 20% down, 2026-10-28 — it was 2× at full strength.)
    ok(`…and golden (R/B ×${(inside[0] / inside[2]).toFixed(2)})`, inside[0] > inside[2] * 1.6);
  }
  {
    const sun = computeSun(0);
    const nightBg = [0.04, 0.04, 0.08];
    const { outdoor, inside } = room(sun, nightBg, createSkyHandle({ sun, moonlight01: 1 }));
    const r = luma(inside) / luma(outdoor);
    ok(`⭐ moonlit night: the greenhouse gets the moonlight the garden gets (×${r.toFixed(2)})`, r > 0.9 && r < 2.1);
    ok('…and it is cool', inside[2] > inside[0]);
  }
  {
    // A storm wave darkens the light let in below the room's own fill: the
    // signed delta really does darken the room toward the outdoors.
    const delta = windowLightDelta({ fill01: 1, targetRgb: [0.2, 0.2, 0.2], indoorRgb: day });
    ok(
      'a darker-than-the-room outside darkens the room (signed delta)',
      delta.every((v) => v < 0)
    );
    ok(
      'an unpainted texel changes nothing',
      windowLightDelta({ fill01: 0, targetRgb: [5, 5, 5], indoorRgb: day }).every((v) => v === 0)
    );
  }
  ok(
    'malformed outdoor light reads as dark, never NaN',
    windowTargetLight({ outdoorRgb: [NaN, 1] }).every(Number.isFinite)
  );

  // ── The two "too red" controls (author, 2026-10-27: golden hour on _Window "far
  // too red and I can't see any way to lower that").
  {
    const sun = computeSun(18 - 0.4);
    const sky = createSkyHandle({ sun, goldenHour01: 0.78 });
    const outdoor = day.map((v, i) => v * sky.ambientMultiplierRgb[i] + sky.moonAddRgb[i]);
    const lean = (tintAmount) =>
      windowDaylightTint({
        ...tints,
        twilight01: sun.twilight01,
        dayFactor01: sun.dayFactor01,
        goldenBoost: D.goldenBoost.default,
        tintAmount,
      });
    const redness = (rgb) => rgb[0] / rgb[2];
    ok(
      'tintAmount 0 means no lean at all',
      lean(0).every((v) => Math.abs(v - 1) < 1e-9)
    );
    ok('less tintAmount, less red', redness(lean(0.5)) < redness(lean(1)) && redness(lean(0)) < redness(lean(0.5)));
    ok(
      'tintAmount stays a hue — luminance 1',
      [0, 0.5, 1, 1.5].every((a) => Math.abs(luma(lean(a)) - 1) < 1e-9)
    );
    const hue = lean(1);
    const full = windowTargetLight({ outdoorRgb: outdoor, hueRgb: hue, outdoorMatch: 1 });
    const half = windowTargetLight({ outdoorRgb: outdoor, hueRgb: hue, outdoorMatch: 1, outdoorHue: 0.5 });
    const none = windowTargetLight({ outdoorRgb: outdoor, hueRgb: [1, 1, 1], outdoorMatch: 1, outdoorHue: 0 });
    ok('lower outdoorHue drains the red', redness(half) < redness(full));
    ok(
      'outdoorHue 0 is neutral grey',
      none.every((v) => Math.abs(v - none[0]) < 1e-9)
    );
    ok(
      'outdoorHue never changes the brightness',
      Math.abs(luma(full) - luma(none)) < 1e-6 && Math.abs(luma(half) - luma(full)) < 1e-6
    );
  }
  ok(
    'WINDOW_PARAMS.outdoorMatch default mirrors the module default',
    D.outdoorMatch.default === WINDOW_OUTDOOR_MATCH_DEFAULT
  );

  for (const [k, def] of [
    ['weatherBreakFill', WINDOW_WEATHER_DEFAULTS.breakFill],
    ['weatherBreakSizeM', WINDOW_WEATHER_DEFAULTS.breakSizeM],
    ['weatherStormDarken', WINDOW_WEATHER_DEFAULTS.stormDarken],
    ['goldenBoost', WINDOW_WEATHER_DEFAULTS.goldenBoost],
    ['tintAmount', WINDOW_WEATHER_DEFAULTS.tintAmount],
    ['outdoorHue', WINDOW_WEATHER_DEFAULTS.outdoorHue],
  ]) {
    ok(`WINDOW_PARAMS.${k} default mirrors the module default`, WINDOW_PARAMS[k]?.default === def);
  }
}
