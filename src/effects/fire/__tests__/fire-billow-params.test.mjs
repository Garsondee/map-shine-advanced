/**
 * fire-billow-params.test.mjs — THE AUTHOR'S DIALS, MAPPED ONTO THE BILLOW MODEL.
 *
 * Every dial in the schema's Look / Flame / Smoke / Depth / Response categories must (a) actually reach the model — a control
 * that is declared and read nowhere is the exact failure `params/no-dead-controls` exists for — and (b) be clamped, so a stored
 * value from any older schema cannot reach past what its slider says.
 */
import { billowRuntimeFromParams } from '../fire-billow-params.js';
import { FIRE_PARAMS } from '../fire.js';
import { BILLOW_TUNE } from '../fire-billow-geometry.js';
import { BILLOW_LOOK, billowSmokeScale } from '../fire-billow-render.js';
import { FIRE_LIFE } from '../fire-billow-state.js';

const NEUTRAL = {
  intensity: 1,
  flameSize: 1,
  flameHeight: 1,
  flameLick: 1,
  flameWindLean: 1,
  flameFlecks: 1,
  flameDetail: 1,
  flameSpeed: 1,
  flameRagged: 1,
  flameShading: 0.5,
  posterize: 0.62,
  bandCount: 5,
  flameGlow: 1,
  windResponse: 1,
  smokeLineWidth: 1,
};
// (the tests pin the MODEL, not the author's tuned dials: shape/size dials start from neutral)
const defaults = { ...Object.fromEntries(Object.entries(FIRE_PARAMS).map(([k, d]) => [k, d.default])), ...NEUTRAL };

export function run(t) {
  const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
  const base = billowRuntimeFromParams(defaults);

  // ── THE SCHEMA DEFAULTS ARE THE MODEL'S OWN (the painted-art look, fitted in the lab) ───────────────────────────
  t.ok(
    'the schema defaults leave every tune value at the model’s own',
    near(base.tune.bodyRadius, BILLOW_TUNE.bodyRadius) &&
      near(base.tune.bodyHeight, BILLOW_TUNE.bodyHeight) &&
      near(base.tune.leanLength, BILLOW_TUNE.leanLength) &&
      near(base.tune.fleckBase, BILLOW_TUNE.fleckBase)
  );
  t.ok(
    'and every look value at the renderer’s own (posterize, bands)',
    near(base.look.posterize, defaults.posterize) &&
      base.look.bandCount === defaults.bandCount &&
      near(base.look.glow, BILLOW_LOOK.glow) &&
      near(base.look.coalGain, BILLOW_LOOK.coalGain)
  );
  t.ok(
    'and the life constants at the state machine’s own',
    near(base.life.douseSec, FIRE_LIFE.douseSec) &&
      near(base.life.smoulderSec, FIRE_LIFE.smoulderSec) &&
      near(base.life.rekindleDelaySec, FIRE_LIFE.rekindleDelaySec) &&
      near(base.life.rekindleRampSec, FIRE_LIFE.rekindleRampSec)
  );
  t.ok(
    // flameTint's own default moved from white to the author's '#ffd2a8' (fire.js, 2026-10-27);
    // white itself is still pinned, just below, as `hex01`'s own identity case.
    'the default tint is the author’s warm #ffd2a8 (no change leaves the painted palette as-is) and rekindle is on',
    near(base.tint[0], 1) && near(base.tint[1], 0xd2 / 255) && near(base.tint[2], 0xa8 / 255) && base.rekindle === true
  );
  t.ok(
    'a white flameTint leaves the painted palette exactly as it is (the identity case)',
    billowRuntimeFromParams({ ...defaults, flameTint: '#ffffff' }).tint.every((c) => c === 1)
  );
  t.ok('the default camera is the 3/4 view with full parallax', near(base.parallax, 1) && near(base.tilt, 0.3));
  t.ok(
    'an empty params object resolves to sane values too (the schema is not required to be complete)',
    (() => {
      const v = billowRuntimeFromParams({});
      return Object.values(v.tune).every(Number.isFinite) && v.motionSpeed === 1 && v.smokeMul === 1;
    })()
  );

  // ── EVERY DIAL REACHES THE MODEL ─────────────────────────────────────────────────────────────────────────────────
  const withP = (patch, extra) => billowRuntimeFromParams({ ...defaults, ...patch }, extra);
  t.ok('Flame size scales the plume radius', near(withP({ flameSize: 2 }).tune.bodyRadius, BILLOW_TUNE.bodyRadius * 2));
  t.ok(
    'Flame height scales the flame-tip height',
    near(withP({ flameHeight: 0.5 }).tune.bodyHeight, BILLOW_TUNE.bodyHeight * 0.5)
  );
  t.ok(
    'Licking tongues 0 means a single compact flame (no secondary tongues)',
    withP({ flameLick: 0 }).tune.tongueMax === 0 && withP({ flameLick: 0 }).tune.tongueMin === 0
  );
  t.ok(
    'Licking tongues scales how many and how far',
    withP({ flameLick: 2 }).tune.tongueMax > BILLOW_TUNE.tongueMax &&
      withP({ flameLick: 2 }).tune.tongueLength > BILLOW_TUNE.tongueLength
  );
  t.ok(
    'Wind lean scales the lean length',
    near(withP({ flameWindLean: 3 }).tune.leanLength, BILLOW_TUNE.leanLength * 3)
  );
  t.ok(
    'Flecks scales both the base and the per-radius count',
    near(withP({ flameFlecks: 2 }).tune.fleckBase, BILLOW_TUNE.fleckBase * 2) &&
      near(withP({ flameFlecks: 2 }).tune.fleckPerR, BILLOW_TUNE.fleckPerR * 2)
  );
  t.ok('Billow detail scales the quality budget', near(withP({ flameDetail: 0.5 }).quality, 0.5));
  t.ok(
    'Billow shading scales the crescents (0 is flat)',
    near(withP({ flameShading: 0 }).look.crescent, 0) && withP({ flameShading: 1 }).look.crescent > base.look.crescent
  );
  t.ok(
    'Edge raggedness scales both warp octaves',
    near(withP({ flameRagged: 2 }).look.warpPx, BILLOW_LOOK.warpPx * 2) &&
      near(withP({ flameRagged: 0 }).look.warpPx2, 0)
  );
  t.ok(
    'Flame glow and Coal glow scale their gains',
    near(withP({ flameGlow: 2 }).look.glow, BILLOW_LOOK.glow * 2) && near(withP({ coalGlow: 0 }).look.coalGain, 0)
  );
  t.ok('Speed becomes the clock rate', near(withP({ flameSpeed: 2 }).motionSpeed, 2));
  t.ok(
    'Banding and Band count reach the look',
    near(withP({ posterize: 1 }).look.posterize, 1) && withP({ bandCount: 7 }).look.bandCount === 7
  );
  t.ok(
    'Smoke amount x the fuel’s own smoke is the smoke multiplier',
    near(withP({ smokeDensity: 2 }, { smokeGain: 1.5 }).smokeMul, 3)
  );
  t.ok(
    'Smoke size / height / wind drift reach the tune',
    near(withP({ smokeSize: 2 }).tune.smokeSize, BILLOW_TUNE.smokeSize * 2) &&
      near(withP({ smokeHeight: 2 }).tune.smokeRise, BILLOW_TUNE.smokeRise * 2) &&
      near(withP({ smokeDrift: 0 }).tune.smokeDrift, 0)
  );
  t.ok(
    'Smoke thickness scales the smoke’s opacity (and never past 1)',
    withP({ smokeThickness: 0.5 }).look.smokeOpacity < base.look.smokeOpacity &&
      withP({ smokeThickness: 1.5 }).look.smokeOpacity <= 1
  );
  t.ok(
    'Smoke soot x the fuel’s soot darkens the smoke, clamped to 1',
    withP({ smokeSoot: 0.5 }, { sootGain: 1 }).look.smokeSoot === 0.5 &&
      withP({ smokeSoot: 0.8 }, { sootGain: 2.4 }).look.smokeSoot === 1
  );
  t.ok(
    'Smoke edge darkening and Smoke ground shadow reach the look, default to the renderer’s own, and are clamped to 0..1',
    near(base.look.smokeLineA, BILLOW_LOOK.smokeLineA) &&
      near(base.look.smokeShadow, BILLOW_LOOK.smokeShadow) &&
      near(withP({ smokeLine: 0.9 }).look.smokeLineA, 0.9) &&
      near(withP({ smokeShadow: 0.05 }).look.smokeShadow, 0.05) &&
      withP({ smokeLine: 0 }).look.smokeLineA === 0 &&
      withP({ smokeLine: 9 }).look.smokeLineA === 1 &&
      withP({ smokeShadow: -4 }).look.smokeShadow === 0 &&
      near(billowRuntimeFromParams({}).look.smokeLineA, BILLOW_LOOK.smokeLineA)
  );
  t.ok(
    'Spitting embers dial and size reach the model',
    withP({ spitRate: 3 }).spitMul === 3 && near(withP({ spitSize: 2 }).tune.spitSize, BILLOW_TUNE.spitSize * 2)
  );
  t.ok(
    'Height parallax and Height tilt reach the camera',
    near(withP({ heightParallax: 2.5 }).parallax, 2.5) && near(withP({ heightTilt: 0.8 }).tilt, 0.8)
  );
  t.ok('Indoor drafts reaches the model', near(withP({ draftStrength: 2 }).drafts, 2));
  t.ok(
    'the four life dials reach the state machine, and Relights switches the comeback off',
    (() => {
      const v = withP({ douseSec: 10, smoulderSec: 60, rekindleDelaySec: 100, rekindleRampSec: 50, rekindle: false });
      return (
        v.life.douseSec === 10 &&
        v.life.smoulderSec === 60 &&
        v.life.rekindleDelaySec === 100 &&
        v.life.rekindleRampSec === 50 &&
        v.rekindle === false
      );
    })()
  );
  t.ok(
    'Flame tint parses to a multiplier; a bad colour falls back to white',
    withP({ flameTint: '#ff8000' }).tint[0] === 1 &&
      near(withP({ flameTint: '#ff8000' }).tint[1], 128 / 255, 1e-3) &&
      withP({ flameTint: 'nonsense' }).tint.every((c) => c === 1)
  );
  t.ok(
    'the hue shift (the fuel’s plus the author’s, already in radians) is passed through',
    near(withP({}, { hueShiftRad: 1.25 }).hueShiftRad, 1.25) && near(withP({}, { hueShiftRad: 1.25 }).look.hue, 1.25)
  );
  t.ok('the fuel’s height gain rides along', near(withP({}, { heightGain: 1.35 }).heightGain, 1.35));
  t.ok(
    '“Counter scene bloom” reaches the model, defaults to all of it, and is clamped to 0..1',
    near(base.bloomMix, 1) &&
      near(withP({ bloomCounter: 0.25 }).bloomMix, 0.25) &&
      withP({ bloomCounter: 9 }).bloomMix === 1 &&
      withP({ bloomCounter: -3 }).bloomMix === 0
  );

  // ── THE ARTISTIC DIALS (shape, look, smoke layering): defaults leave the model untouched, each one reaches it, each is clamped ──
  {
    const NEW = {
      tune: {
        flameCurl: 'tongueCurl',
        flameCycle: 'bodyLifeMul',
        flameFleckSize: 'fleckSize',
        flameFleckSpeed: 'fleckSpeed',
        flameLeanCurve: 'leanCurve',
        flameWindStreak: 'leanStreak',
        flameRainShrink: 'rainShrink',
        smokeLife: 'smokeLife',
        smokeStart: 'smokeStart',
        smokeGrow: 'smokeGrow',
        smokeLift: 'smokeLift',
        buildingSmokeHeight: 'massRise',
        spitThrow: 'spitRange',
        spitSmoulderSec: 'spitLife',
      },
      look: {
        flameEdgeSoft: 'edgeSoft',
        flameMottle: 'mottle',
        flameRelief: 'relief',
        flameBrightness: 'emission',
        flameTone: 'tonePow',
        flameFullness: 'outline',
        flameGlowRadius: 'glowRadiusPx',
        coalCellSize: 'coalCell',
        coalCrack: 'coalCrack',
        flameWobbleSpeed: 'warpSpeed',
        flameWobbleScale: 'warpFreq',
        smokeFadeIn: 'smokeFadeIn',
        smokeOverFlame: 'smokeOverFlame',
        smokeCrisp: 'smokeCrisp',
        smokeShading: 'smokeRelief',
        smokeCoverage: 'smokeOutline',
        smokeEdgeSoft: 'smokeSoft',
        smokeBrightGrey: 'smokeDayDark',
      },
    };
    let ok = true;
    for (const [where, map] of Object.entries(NEW)) {
      for (const [dial, key] of Object.entries(map)) {
        const d = FIRE_PARAMS[dial];
        const src = where === 'tune' ? BILLOW_TUNE : BILLOW_LOOK;
        const lo = withP({ [dial]: d.min })[where][key];
        const hi = withP({ [dial]: d.max })[where][key];
        const def = base[where][key];
        const clampOk =
          withP({ [dial]: d.max * 1000 })[where][key] === hi && withP({ [dial]: -1e9 })[where][key] === lo;
        if (!d || !near(d.default, src[key], 1e-9) || !near(def, src[key], 1e-9) || lo === hi || !clampOk) {
          ok = false;
          console.log('  dial problem:', dial, key, d?.default, src[key], def, lo, hi, clampOk);
        }
      }
    }
    t.ok(
      'every artistic dial (flame shape, look, smoke layering, spit) defaults to the model own constant, reaches the model, and is clamped',
      ok
    );
    t.ok(
      'the smoke rim width multiplies the rim',
      near(withP({ smokeLineWidth: 2 }).smokeLineWidth, 2) && base.smokeLineWidth === 1
    );
    t.ok(
      'smoke is drawn OVER the flame and fades in: default fade-in and over-flame opacity are set and sane',
      BILLOW_LOOK.smokeFadeIn > 0 && BILLOW_LOOK.smokeOverFlame > 0 && BILLOW_LOOK.smokeOverFlame < 1
    );
  }

  // ── CLAMPING: a stored value from any other schema cannot reach past the slider ────────────────────────────────
  {
    const wild = billowRuntimeFromParams({
      flameSize: 1e6,
      flameHeight: -5,
      flameLick: 99,
      flameWindLean: 99,
      flameFlecks: 1e9,
      flameDetail: 99,
      flameSpeed: 0,
      spitRate: 1e9,
      heightTilt: 9,
      heightParallax: 22.1,
      smokeDensity: 1e9,
      douseSec: 0,
      rekindleDelaySec: 1e12,
      smokeThickness: 13.35,
    });
    t.ok(
      'absurd values are clamped to the schema’s ranges',
      wild.tune.bodyRadius <= BILLOW_TUNE.bodyRadius * 4 + 1e-9 &&
        wild.tune.bodyHeight >= BILLOW_TUNE.bodyHeight * 0.1 - 1e-9 &&
        wild.tune.tongueMax <= Math.round(BILLOW_TUNE.tongueMax * 3) &&
        wild.quality <= 1.5 &&
        wild.motionSpeed >= 0.1 &&
        wild.spitMul <= 6 &&
        wild.tilt <= 1 &&
        wild.parallax <= 4 &&
        wild.life.douseSec >= 2 &&
        wild.life.rekindleDelaySec <= 86400 &&
        wild.look.smokeOpacity <= 1
    );
    t.ok(
      'a retired dial’s old stored value (perspective 22.1, animationSpeed 0.1, a #ffe7b8 colour) is simply ignored',
      (() => {
        const v = billowRuntimeFromParams({
          perspective: 22.1,
          animationSpeed: 0.1,
          color: '#ffe7b8',
          flameOpacity: 6.6,
          flameCount: 500,
          brightness: 3,
        });
        return near(v.parallax, 1) && near(v.motionSpeed, 1) && v.tint.every((c) => c === 1);
      })()
    );
    t.ok(
      'NaN / null / undefined dials fall back to defaults',
      (() => {
        const v = billowRuntimeFromParams({
          flameSize: NaN,
          flameHeight: null,
          flameLick: undefined,
          flameWindLean: 'x',
        });
        return near(v.tune.bodyRadius, BILLOW_TUNE.bodyRadius) && near(v.tune.leanLength, BILLOW_TUNE.leanLength);
      })()
    );
  }

  // ── THE SCHEMA ITSELF CARRIES EVERY DIAL THIS MAPPING READS (no dead controls) ─────────────────────────────────
  {
    const read = [
      'flameSize',
      'flameHeight',
      'flameLick',
      'flameWindLean',
      'flameFlecks',
      'flameDetail',
      'flameShading',
      'flameRagged',
      'flameGlow',
      'coalGlow',
      'flameSpeed',
      'flameTint',
      'bloomCounter',
      'posterize',
      'bandCount',
      'smokeDensity',
      'smokeSize',
      'smokeHeight',
      'smokeDrift',
      'smokeThickness',
      'smokeSoot',
      'smokeLine',
      'smokeShadow',
      'spitRate',
      'spitSize',
      'heightParallax',
      'heightTilt',
      'draftStrength',
      'douseSec',
      'smoulderSec',
      'rekindle',
      'rekindleDelaySec',
      'rekindleRampSec',
    ];
    t.ok(
      'every dial the billow mapping reads is declared in FIRE_PARAMS',
      read.every((k) => FIRE_PARAMS[k] !== undefined)
    );
    const retired = [
      'flameCount',
      'flameOpacity',
      'flameEmission',
      'flameColorAge',
      'flameWindPush',
      'smokeCount',
      'animationSpeed',
      'perspective',
      'color',
      'brightness',
      'smokeAmount',
      'grain',
    ];
    t.ok(
      'the retired sprite-era dials are gone from the schema (their stored values mean nothing to a billow model)',
      retired.every((k) => FIRE_PARAMS[k] === undefined)
    );
    t.ok(
      'the building spread dial is declared, and its default (0) leaves a big fire lighting all at once',
      FIRE_PARAMS.spreadSec?.type === 'float' &&
        FIRE_PARAMS.spreadSec.default === 0 &&
        FIRE_PARAMS.spreadSec.min === 0 &&
        FIRE_PARAMS.spreadSec.max >= 600
    );
    t.ok(
      'every declared default is inside its own range',
      Object.entries(FIRE_PARAMS).every(([, d]) => d.type !== 'float' || (d.default >= d.min && d.default <= d.max))
    );
  }

  // ── THE SMOKE'S CARTOON FURNITURE FOLLOWS THE ZOOM AND THE SIZE OF THE BILLOWS ───────────────────────────────────
  {
    const camp = billowSmokeScale(1, 40);
    const roof = billowSmokeScale(1, 300);
    t.ok(
      'a roof’s smoke gets wider crescents and a longer ground shadow than a campfire’s',
      roof.crescentPx > camp.crescentPx * 2 && roof.shadowOffWorld > camp.shadowOffWorld * 2
    );
    t.ok(
      'the outline follows the zoom (a painted line grows with the picture): thicker zoomed in, thinner zoomed out',
      billowSmokeScale(2, 40).linePx > billowSmokeScale(1, 40).linePx &&
        billowSmokeScale(0.25, 40).linePx < billowSmokeScale(1, 40).linePx
    );
    t.ok(
      'the crescents follow the zoom too (a px width): they grow as you zoom in on the same cloud',
      billowSmokeScale(2, 100).crescentPx > billowSmokeScale(1, 100).crescentPx
    );
    t.ok(
      'and everything is held between a hair and a brush stroke (a map zoomed all the way out or in stays readable)',
      (() => {
        const lo = billowSmokeScale(0.001, 4);
        const hi = billowSmokeScale(1000, 1e6);
        return (
          lo.linePx >= 1.2 &&
          hi.linePx <= 6 &&
          lo.crescentPx >= 3 &&
          hi.crescentPx <= 48 &&
          lo.shadowOffWorld >= 4 &&
          hi.shadowOffWorld <= 60
        );
      })()
    );
    t.ok(
      'a missing or nonsense zoom and radius fall back to sane numbers',
      (() => {
        const v = [billowSmokeScale(undefined, undefined), billowSmokeScale(NaN, -5), billowSmokeScale(0, 0)];
        return v.every((o) => Object.values(o).every((n) => Number.isFinite(n) && n > 0));
      })()
    );
  }
}
