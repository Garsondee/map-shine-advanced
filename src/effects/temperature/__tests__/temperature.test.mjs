/**
 * Node verification for effects/temperature/temperature.js + temperature-model.js — the bands, the
 * grade delta on the ONE grade primitive, the frost's growth and the ripple.
 */
import { TEMPERATURE_EFFECTS, TEMPERATURE_EFFECTS_PARAMS } from '../temperature.js';
import {
  IDENTITY_TEMPERATURE_GRADE,
  temperatureBands,
  temperatureRamp,
  temperatureColor,
  resolveTemperatureGrade,
  applyTemperatureGrade,
  stepFrost,
  heatRipplePx,
  stepHeatScroll,
  HEAT_TAP_Y_FREQ,
  createTemperatureFxStepper,
} from '../temperature-model.js';
import { applyGrade, IDENTITY_GRADE, luminance } from '../../grade/grade-ops.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { PRECIP_SLEET_BAND } from '../../../world/index.js';

const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

export function run(t) {
  const { ok } = t;

  ok('manifest validates', validateEffectManifest(TEMPERATURE_EFFECTS).ok === true);
  ok('params schema validates', validateParamsSchema(TEMPERATURE_EFFECTS_PARAMS).ok === true);
  ok('its card is titled Temperature Effects', TEMPERATURE_EFFECTS.title === 'Temperature Effects');
  ok(
    '⭐ "below the freezing tick" — the icy line IS the fader\'s snowflake tick',
    TEMPERATURE_EFFECTS_PARAMS.coldBelow.default === PRECIP_SLEET_BAND.coldEdge
  );
  ok('warming starts at the 75% mark', TEMPERATURE_EFFECTS_PARAMS.warmAbove.default === 0.75);
  ok('frost starts below the 10% mark', TEMPERATURE_EFFECTS_PARAMS.frostBelow.default === 0.1);
  ok('plenty of controls (≥ 35)', Object.keys(TEMPERATURE_EFFECTS_PARAMS).length >= 35);

  // ── Bands ──
  const mild = temperatureBands(0.55, {});
  ok(
    '⭐ a temperate scene is untouched (no cold, warm, frost or ripple)',
    mild.cold01 === 0 && mild.warm01 === 0 && mild.frostTarget01 === 0 && mild.heat01 === 0
  );
  ok('just above the tick: not icy', temperatureBands(0.26, {}).cold01 === 0);
  ok(
    'below the tick: icy, rising as it gets colder',
    temperatureBands(0.2, {}).cold01 > 0 && temperatureBands(0.1, {}).cold01 > temperatureBands(0.2, {}).cold01
  );
  ok('at 0: fully icy', near(temperatureBands(0, {}).cold01, 1));
  ok(
    'at 0.74: not warm; at 0.9: warm',
    temperatureBands(0.74, {}).warm01 === 0 && temperatureBands(0.9, {}).warm01 > 0
  );
  ok(
    'frost only below 10%',
    temperatureBands(0.11, {}).frostTarget01 === 0 && temperatureBands(0.05, {}).frostTarget01 > 0
  );
  ok('ripple only above 80%', temperatureBands(0.79, {}).heat01 === 0 && temperatureBands(0.95, {}).heat01 > 0);
  ok('frost switch off ⇒ no frost', temperatureBands(0, { frostEnabled: false }).frostTarget01 === 0);
  ok('ripple switch off ⇒ no ripple', temperatureBands(1, { heatEnabled: false }).heat01 === 0);
  ok('strength 2 exaggerates', near(temperatureBands(0, { coldStrength: 2 }).cold01, 2));
  ok('a degenerate band is a hard step', temperatureRamp(0.3, 0.5, 0.5) === 0 && temperatureRamp(0.6, 0.5, 0.5) === 1);
  ok('a missing temperature reads as a temperate day', temperatureBands(undefined, {}).cold01 === 0);

  // ── Grade ──
  ok('colour params take hex or an rgb triple', temperatureColor('#ff8000', [0, 0, 0])[1] === 128 / 255);
  ok('a bad colour falls back', temperatureColor('blue', [0.1, 0.2, 0.3])[2] === 0.3);
  const idDelta = resolveTemperatureGrade(0.55, {});
  const sample = [0.6, 0.45, 0.3];
  const idOut = applyGrade(sample, { ...IDENTITY_GRADE, ...applyTemperatureGrade({}, idDelta, 1) });
  ok(
    '⭐ at a temperate value the folded grade is the identity (parity holds)',
    idOut.every((v, i) => near(v, sample[i], 1e-9))
  );
  const icy = applyGrade(sample, {
    ...IDENTITY_GRADE,
    ...applyTemperatureGrade({}, resolveTemperatureGrade(0, {}), 1),
  });
  const blueRatio = (c) => c[2] / Math.max(1e-6, c[0]);
  ok('⭐ cold cools the picture (blue up relative to red)', blueRatio(icy) > blueRatio(sample) * 1.3);
  const satOf = (c) => {
    const L = luminance(c);
    return Math.hypot(c[0] - L, c[1] - L, c[2] - L);
  };
  const grey = [0.5, 0.5, 0.5];
  const icyGrey = applyGrade(grey, {
    ...IDENTITY_GRADE,
    ...applyTemperatureGrade({}, resolveTemperatureGrade(0, {}), 1),
  });
  ok('cold tints a neutral grey cool', icyGrey[2] > icyGrey[0]);
  const warm = applyGrade(sample, {
    ...IDENTITY_GRADE,
    ...applyTemperatureGrade({}, resolveTemperatureGrade(1, {}), 1),
  });
  ok('⭐ heat warms the picture (red up relative to blue)', warm[0] / warm[2] > sample[0] / sample[2]);
  ok(
    'the warm shift is subtler than the cold one (author: "a subtle warming")',
    Math.abs(resolveTemperatureGrade(1, {}).temperature) < Math.abs(resolveTemperatureGrade(0, {}).temperature)
  );
  ok('cold drains colour', resolveTemperatureGrade(0, {}).saturationMul < 1 && satOf(icy) >= 0);
  const authored = { exposure: 0.3, saturation: 1.2, temperature: 0.1, lift: [0.01, 0, 0], gain: [1, 0.9, 1] };
  const kept = applyTemperatureGrade(authored, resolveTemperatureGrade(0, {}), 0);
  ok(
    'share 0 leaves an authored grade exactly as it was',
    kept.exposure === 0.3 && kept.saturation === 1.2 && kept.temperature === 0.1 && kept.gain[1] === 0.9
  );
  const halves = applyTemperatureGrade(authored, resolveTemperatureGrade(0, {}), 0.5);
  const whole = applyTemperatureGrade(authored, resolveTemperatureGrade(0, {}), 1);
  ok('the share scales the delta linearly', near(halves.temperature - 0.1, (whole.temperature - 0.1) / 2, 1e-12));
  ok('identity delta is a no-op', applyTemperatureGrade(authored, IDENTITY_TEMPERATURE_GRADE, 1).exposure === 0.3);

  // ── Frost growth ──
  let f = 0;
  for (let i = 0; i < 60 * 30; i++) f = stepFrost(f, 1 / 60, 1, {});
  ok('⭐ frost grows SLOWLY — 30 s in, it is about a third of the way at the 90 s default', f > 0.3 && f < 0.36);
  for (let i = 0; i < 60 * 70; i++) f = stepFrost(f, 1 / 60, 1, {});
  ok('…and reaches full by ~100 s', near(f, 1));
  ok('frost never overshoots its target', stepFrost(0.49, 1, 0.5, { frostGrowSec: 1 }) === 0.5);
  ok('a long hitch counts as one second', near(stepFrost(0, 30, 1, { frostGrowSec: 10 }), 0.1));
  let m = 1;
  for (let i = 0; i < 60 * 26; i++) m = stepFrost(m, 1 / 60, 0, {});
  ok('frost melts faster than it grows (25 s default)', m === 0);

  // ── Heat ripple ──
  ok('no heat ⇒ no ripple', heatRipplePx(0, {}, {}) === 0);
  const day = heatRipplePx(1, {}, { darkness01: 0, worldPerScreenPx: 1 });
  ok('⭐ the ripple is small — the default is ~1.4 px', near(day, TEMPERATURE_EFFECTS_PARAMS.heatStrengthPx.default));
  ok('dimmer at night', near(heatRipplePx(1, {}, { darkness01: 1, worldPerScreenPx: 1 }), day * 0.3));
  ok('fades out zoomed far out (a cell under 30 px on screen)', heatRipplePx(1, {}, { worldPerScreenPx: 20 }) === 0);
  const scroll = [0.99, 0];
  stepHeatScroll(scroll, 1, { heatRiseSpeed: 320, heatScale: 320 });
  ok(
    'the rising scroll wraps into [0,1)',
    scroll[0] >= 0 && scroll[0] < 1 && near(scroll[0], (0.99 + HEAT_TAP_Y_FREQ[0]) % 1, 1e-9)
  );

  // ── The per-frame stepper (shared by the viewer and the lab) ──
  const frame = (over = {}) => ({
    enabled: true,
    params: {},
    temperature01: 0.55,
    realDtSec: 1 / 60,
    worldDtSec: 1 / 60,
    darkness01: 0,
    screenW: 1920,
    screenH: 1080,
    worldPerScreenPx: 1,
    ...over,
  });
  const mildStep = createTemperatureFxStepper().step(frame());
  ok(
    '⭐ a temperate frame compiles NEITHER warp layer in',
    mildStep.warp.frost === false && mildStep.warp.heatRipple === false
  );
  const isIdentity = (g) =>
    g.exposure === 0 &&
    g.temperature === 0 &&
    g.saturationMul === 1 &&
    g.contrastMul === 1 &&
    g.lift.every((v) => v === 0) &&
    g.gainMul.every((v) => v === 1);
  ok('a temperate frame carries the identity grade', isIdentity(mildStep.grade));
  const cold = createTemperatureFxStepper();
  let cs = cold.step(frame({ temperature01: 0.02 }));
  ok(
    'the first frost frame is invisible and not yet compiled in',
    cs.warp.frost === false && cs.warp.frostCover < 1e-6
  );
  for (let i = 0; i < 60; i++) cs = cold.step(frame({ temperature01: 0.02 }));
  ok('after a second the frost shows, barely', cs.warp.frost === true && cs.warp.frostCover < 0.01);
  for (let i = 0; i < 60 * 45; i++) cs = cold.step(frame({ temperature01: 0.02 }));
  ok(
    '45 s in, about half-grown (smoothstepped)',
    cs.info.frost01 > 0.45 && cs.info.frost01 < 0.55 && cs.warp.frostCover > 0.4 && cs.warp.frostCover < 0.6
  );
  cold.setFrost01(1);
  cs = cold.step(frame({ temperature01: 0.6 }));
  ok(
    'warming up leaves the frost to melt, not vanish',
    cs.warp.frost === true && cs.info.frost01 < 1 && cs.info.frost01 > 0.99
  );
  for (let i = 0; i < 60 * 30; i++) cs = cold.step(frame({ temperature01: 0.6 }));
  ok('…and once melted the layer compiles back out', cs.warp.frost === false);
  const hot = createTemperatureFxStepper();
  const hs = hot.step(frame({ temperature01: 0.95 }));
  ok(
    'hot ⇒ the ripple layer compiles in, tiny',
    hs.warp.heatRipple === true && hs.info.ripplePx > 0 && hs.info.ripplePx < 2
  );
  ok('ripple amount is in UV units of the screen', Math.abs(hs.warp.heatAmpUv[0] - hs.info.ripplePx / 1920) < 1e-12);
  const night = createTemperatureFxStepper().step(frame({ temperature01: 0.95, darkness01: 1 }));
  ok(
    'night: the ripple is down to 30% but the layer stays compiled (no rebuild at dusk)',
    night.warp.heatRipple === true && Math.abs(night.info.ripplePx - hs.info.ripplePx * 0.3) < 1e-9
  );
  const far = createTemperatureFxStepper().step(frame({ temperature01: 0.95, worldPerScreenPx: 30 }));
  ok(
    'zoomed far out: amount fades but the layer stays compiled (no rebuild while zooming)',
    far.warp.heatRipple === true && far.info.ripplePx === 0
  );
  const off = createTemperatureFxStepper().step(frame({ enabled: false, temperature01: 0 }));
  ok(
    '⭐ the card switched off ⇒ identity grade, no frost, no ripple',
    isIdentity(off.grade) && off.warp.frost === false && off.warp.heatRipple === false
  );
  const noRipple = createTemperatureFxStepper().step(frame({ temperature01: 1, params: { heatStrengthPx: 0 } }));
  ok('ripple strength 0 ⇒ the layer is not compiled in', noRipple.warp.heatRipple === false);
  const scrollA = createTemperatureFxStepper();
  scrollA.step(frame({ temperature01: 1 }));
  const s1 = scrollA.step(frame({ temperature01: 1 })).warp.heatScroll[0];
  const s2 = scrollA.step(frame({ temperature01: 1, worldDtSec: 0 })).warp.heatScroll[0];
  ok('paused world time holds the ripple still', s1 === s2);
  ok(
    'the indoor share of the grade follows indoorShare',
    createTemperatureFxStepper().step(frame({ params: { indoorShare: 0.25 } })).indoorShare === 0.25
  );
}
