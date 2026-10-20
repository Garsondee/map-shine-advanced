/**
 * FIRE — THE AUTHOR'S DIALS, MAPPED ONTO THE BILLOW MODEL (2026-10-20). Pure maths, Node-tested.
 *
 * `fireRuntimeFromParams` (fire-geometry.js) still serves the ember engine, the light and the weather numbers. This is
 * the other half: the flame, smoke, coal bed and the long life of the fire. One function, one place, so the schema in
 * `fire.js`, the subsystem and the lab all read the same mapping.
 *
 * ⚠️ NEW DIALS, NEW NAMES. The old flame/smoke dials (`flameCount`, `flameOpacity`, `flameWindPush`, `smokeCount`,
 * `animationSpeed`, `color`, `perspective`...) were tuned against four soft sprites and a velocity-integrated particle
 * system, and a stored value from them means nothing to a billow model: a `perspective` of 22 is a camera 45 px up, an
 * `animationSpeed` of 0.1 freezes a flame, a `color` of #ffe7b8 multiplies blue by 3.4. Re-using the names would hand the
 * author's old numbers to a different machine. They are retired (an unknown stored key is simply ignored) and the new
 * ones start from the painted-art defaults.
 *
 * @module effects/fire/fire-billow-params
 */
import { BILLOW_TUNE } from './fire-billow-geometry.js';
import { BILLOW_LOOK } from './fire-billow-render.js';
import { FIRE_LIFE } from './fire-billow-state.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** `#rrggbb` -> [r,g,b] 0..1 (null if malformed). */
function hex01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * @param {object} p the resolved FIRE_PARAMS values
 * @param {object} [extra]
 * @param {number} [extra.sootGain=1] the fuel's soot
 * @param {number} [extra.smokeGain=1] the fuel's smoke
 * @param {number} [extra.heightGain=1] the fuel's height
 * @param {number} [extra.hueShiftRad=0] the fuel's own hue shift plus the author's, in radians
 * @returns {{look:object, tune:object, life:object, smokeMul:number, spitMul:number, parallax:number, tilt:number,
 *   motionSpeed:number, hueShiftRad:number, tint:number[], quality:number, drafts:number, rekindle:boolean}}
 */
/** Every artistic dial that sets ONE model constant or look uniform directly: dial -> [where, key, default, min, max]. */
const DIRECT = {
  flameCoreBloom: ['look', 'coreBloom', 1.2, 0, 6],
  windShear: ['tune', 'windShear', 1.1, 0, 3],
  windFlatten: ['tune', 'windFlatten', 0.5, 0, 0.9],
  smokeStreak: ['tune', 'smokeStreak', 4, 0, 10],
  flameTongueLength: ['tune', 'tongueLength', 2, 0.1, 2],
  flameCurl: ['tune', 'tongueCurl', 7, 0, 8],
  flameCycle: ['tune', 'bodyLifeMul', 1, 0.2, 3],
  flameFleckSize: ['tune', 'fleckSize', 0.06, 0.01, 0.3],
  flameFleckSpeed: ['tune', 'fleckSpeed', 2.2, 0.2, 8],
  flameLeanCurve: ['tune', 'leanCurve', 1.5, 0.3, 4],
  flameWindStreak: ['tune', 'leanStreak', 1.6, 0, 5],
  flameRainShrink: ['tune', 'rainShrink', 0.62, 0, 1],
  flameEdgeSoft: ['look', 'edgeSoft', 0.08, 0.012, 0.3],
  flameMottle: ['look', 'mottle', 0.1, 0, 0.5],
  flameRelief: ['look', 'relief', 2.6, 0, 8],
  flameBrightness: ['look', 'emission', 1, 0.2, 2.5],
  flameTone: ['look', 'tonePow', 0.84, 0.4, 1.6],
  flameFullness: ['look', 'outline', 0.5, 0.25, 0.9],
  flameGlowRadius: ['look', 'glowRadiusPx', 14, 0, 60],
  coalCellSize: ['look', 'coalCell', 0.16, 0.04, 0.6],
  coalCrack: ['look', 'coalCrack', 0.22, 0.03, 0.6],
  flameWobbleSpeed: ['look', 'warpSpeed', 0.7, 0, 3],
  flameWobbleScale: ['look', 'warpFreq', 0.05, 0.01, 0.2],
  smokeFadeIn: ['look', 'smokeFadeIn', 0.3, 0, 1],
  smokeOverFlame: ['look', 'smokeOverFlame', 0.55, 0, 1],
  smokeLife: ['tune', 'smokeLife', 4.6, 1, 20],
  smokeStart: ['tune', 'smokeStart', 0.42, 0.1, 1.5],
  smokeGrow: ['tune', 'smokeGrow', 1.9, 0, 5],
  smokeLift: ['tune', 'smokeLift', 3.4, 1, 8],
  smokeCrisp: ['look', 'smokeCrisp', 0.7, 0, 1],
  smokeShading: ['look', 'smokeRelief', 2.4, 0, 8],
  smokeCoverage: ['look', 'smokeOutline', 0.42, 0.15, 1.2],
  smokeEdgeSoft: ['look', 'smokeSoft', 0.14, 0.02, 0.5],
  smokeBrightGrey: ['look', 'smokeDayDark', 0.55, 0, 0.9],
  smokeLineWidth: ['scale', 'smokeLineWidth', 1, 0, 3],
  buildingSmokeHeight: ['tune', 'massRise', 2.4, 0.5, 6],
  spitThrow: ['tune', 'spitRange', 2.6, 0.5, 8],
  spitSmoulderSec: ['tune', 'spitLife', 24, 4, 120],
};

export function billowRuntimeFromParams(p = {}, extra = {}) {
  const size = clamp(num(p.flameSize, 1), 0.2, 4);
  const height = clamp(num(p.flameHeight, 1), 0.1, 4);
  const lick = clamp(num(p.flameLick, 1), 0, 3);
  const lean = clamp(num(p.flameWindLean, 1), 0, 4);
  const flecks = clamp(num(p.flameFlecks, 1), 0, 4);
  const detail = clamp(num(p.flameDetail, 1), 0.3, 1.5);
  const shading = clamp(num(p.flameShading, 0.5), 0, 1);
  const smoke = clamp(num(p.smokeDensity, 1), 0, 4);
  const tint = hex01(p.flameTint) ?? [1, 1, 1];

  const tune = {
    bodyRadius: BILLOW_TUNE.bodyRadius * size,
    bodyHeight: BILLOW_TUNE.bodyHeight * height,
    tongueMax: Math.max(0, Math.round(BILLOW_TUNE.tongueMax * lick)),
    tongueLength: BILLOW_TUNE.tongueLength * (0.5 + 0.5 * lick),
    leanLength: BILLOW_TUNE.leanLength * lean,
    fleckBase: BILLOW_TUNE.fleckBase * flecks,
    fleckPerR: BILLOW_TUNE.fleckPerR * flecks,
    smokeSize: BILLOW_TUNE.smokeSize * clamp(num(p.smokeSize, 1), 0.2, 4),
    smokeRise: BILLOW_TUNE.smokeRise * clamp(num(p.smokeHeight, 1), 0.1, 4),
    smokeDrift: BILLOW_TUNE.smokeDrift * clamp(num(p.smokeDrift, 1), 0, 4),
    spitSize: BILLOW_TUNE.spitSize * clamp(num(p.spitSize, 1), 0.2, 4),
  };
  tune.tongueMin = Math.min(BILLOW_TUNE.tongueMin, tune.tongueMax);
  const directLook = {};
  let smokeLineWidth = 1;
  for (const [dial, [where, key, def, lo, hi]] of Object.entries(DIRECT)) {
    const v = clamp(num(p[dial], def), lo, hi);
    if (where === 'tune')
      tune[key] = key === 'tongueLength' ? tune[key] * (v / def) : v; // (Licking tongues already scales the length)
    else if (where === 'look') directLook[key] = v;
    else smokeLineWidth = v;
  }

  const look = {
    posterize: clamp(num(p.posterize, BILLOW_LOOK.posterize), 0, 1),
    bandCount: Math.round(clamp(num(p.bandCount, BILLOW_LOOK.bandCount), 3, 12)),
    crescent: BILLOW_LOOK.crescent * (shading / 0.5),
    relief: BILLOW_LOOK.relief,
    glow: BILLOW_LOOK.glow * clamp(num(p.flameGlow, 1), 0, 4),
    coalGain: BILLOW_LOOK.coalGain * clamp(num(p.coalGlow, 1), 0, 3),
    smokeOpacity: clamp(BILLOW_LOOK.smokeOpacity * clamp(num(p.smokeThickness, 1), 0, 1.5), 0, 1),
    smokeSoot: clamp(num(p.smokeSoot, 0.2) * (extra.sootGain ?? 1), 0, 1),
    smokeLineA: clamp(num(p.smokeLine, BILLOW_LOOK.smokeLineA), 0, 1),
    smokeShadow: clamp(num(p.smokeShadow, BILLOW_LOOK.smokeShadow), 0, 1),
    edgeSoft: BILLOW_LOOK.edgeSoft,
    warpPx: BILLOW_LOOK.warpPx * clamp(num(p.flameRagged, 1), 0, 3),
    warpPx2: BILLOW_LOOK.warpPx2 * clamp(num(p.flameRagged, 1), 0, 3),
    hue: extra.hueShiftRad ?? 0,
    tint,
    ...directLook,
  };

  const life = {
    douseSec: clamp(num(p.douseSec, FIRE_LIFE.douseSec), 2, 600),
    smoulderSec: clamp(num(p.smoulderSec, FIRE_LIFE.smoulderSec), 5, 7200),
    rekindleDelaySec: clamp(num(p.rekindleDelaySec, FIRE_LIFE.rekindleDelaySec), 10, 86400),
    rekindleRampSec: clamp(num(p.rekindleRampSec, FIRE_LIFE.rekindleRampSec), 10, 7200),
  };

  return {
    look,
    smokeLineWidth,
    tune,
    life,
    smokeMul: smoke * (extra.smokeGain ?? 1),
    spitMul: clamp(num(p.spitRate, 1), 0, 6),
    // the camera: how much height shifts a billow toward/away from the view centre, and the 3/4 lift
    parallax: clamp(num(p.heightParallax, 1), 0, 4),
    tilt: clamp(num(p.heightTilt, 0.3), 0, 1),
    motionSpeed: clamp(num(p.flameSpeed, 1), 0.1, 3),
    hueShiftRad: extra.hueShiftRad ?? 0,
    tint,
    quality: detail,
    drafts: clamp(num(p.draftStrength, 1), 0, 3),
    rekindle: p.rekindle !== false,
    heightGain: extra.heightGain ?? 1,
    // how much of the scene's bloom the flame pre-darkens for (1 = all of it, 0 = leave it to the bloom)
    bloomMix: clamp(num(p.bloomCounter, 1), 0, 1),
  };
}
