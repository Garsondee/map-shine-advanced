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

  const look = {
    posterize: clamp(num(p.posterize, BILLOW_LOOK.posterize), 0, 1),
    bandCount: Math.round(clamp(num(p.bandCount, BILLOW_LOOK.bandCount), 3, 12)),
    crescent: BILLOW_LOOK.crescent * (shading / 0.5),
    relief: BILLOW_LOOK.relief,
    glow: BILLOW_LOOK.glow * clamp(num(p.flameGlow, 1), 0, 4),
    coalGain: BILLOW_LOOK.coalGain * clamp(num(p.coalGlow, 1), 0, 3),
    smokeOpacity: clamp(BILLOW_LOOK.smokeOpacity * clamp(num(p.smokeThickness, 1), 0, 1.5), 0, 1),
    smokeSoot: clamp(num(p.smokeSoot, 0.2) * (extra.sootGain ?? 1), 0, 1),
    edgeSoft: BILLOW_LOOK.edgeSoft,
    warpPx: BILLOW_LOOK.warpPx * clamp(num(p.flameRagged, 1), 0, 3),
    warpPx2: BILLOW_LOOK.warpPx2 * clamp(num(p.flameRagged, 1), 0, 3),
    hue: extra.hueShiftRad ?? 0,
    tint,
  };

  const life = {
    douseSec: clamp(num(p.douseSec, FIRE_LIFE.douseSec), 2, 600),
    smoulderSec: clamp(num(p.smoulderSec, FIRE_LIFE.smoulderSec), 5, 7200),
    rekindleDelaySec: clamp(num(p.rekindleDelaySec, FIRE_LIFE.rekindleDelaySec), 10, 86400),
    rekindleRampSec: clamp(num(p.rekindleRampSec, FIRE_LIFE.rekindleRampSec), 10, 7200),
  };

  return {
    look,
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
  };
}
