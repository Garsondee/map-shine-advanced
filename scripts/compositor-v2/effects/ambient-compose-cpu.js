/**
 * @fileoverview CPU mirror of LightingEffectV2 outdoor ambient compose (linear HDR).
 * Shared by post-lighting vegetation overlays so foliage tracks day/night ambient.
 *
 * @module compositor-v2/effects/ambient-compose-cpu
 */

import { LightingDirector } from '../../core/LightingDirector.js';

/** Default twilight tuning — must match LightingEffectV2 schema defaults. */
export const TWILIGHT_AMBIENT_DEFAULTS = Object.freeze({
  darkness: 0.32,
  dayFloorOutdoor: 0.28,
  dayFloorIndoor: 0.14,
  minLightKeepOutdoor: 0.55,
  minLightKeepIndoor: 0.30,
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {readonly [number, number, number]} a
 * @param {readonly [number, number, number]} b
 * @param {number} t
 * @returns {[number, number, number]}
 */
const lerp3 = (a, b, t) => ([
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
]);

/**
 * @param {unknown} src
 * @param {readonly [number, number, number]} fallback
 * @returns {[number, number, number]}
 */
function readRgbFromColorLike(src, fallback) {
  if (src && typeof src === 'object' && 'r' in src) {
    return [
      +(src.r ?? fallback[0]),
      +(src.g ?? fallback[1]),
      +(src.b ?? fallback[2]),
    ];
  }
  return [fallback[0], fallback[1], fallback[2]];
}

/**
 * @returns {[number, number, number]}
 */
function readFoundryAmbientRgb(which, fallback) {
  try {
    const env = globalThis.canvas?.environment;
    const raw = which === 'bright' ? env?.ambientBrightest : env?.ambientDarkness;
    if (raw && typeof raw === 'object' && 'r' in raw) {
      return readRgbFromColorLike(raw, fallback);
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const r = ((raw >> 16) & 255) / 255;
      const g = ((raw >> 8) & 255) / 255;
      const b = (raw & 255) / 255;
      return [r, g, b];
    }
  } catch (_) {}
  return [fallback[0], fallback[1], fallback[2]];
}

/**
 * Resolved twilight controls from LightingEffectV2 params / compose uniforms.
 *
 * @param {import('./LightingEffectV2.js').LightingEffectV2|null|undefined} lightingEffect
 * @returns {{ darkness: number, dayFloorOutdoor: number, dayFloorIndoor: number, minLightKeepOutdoor: number, minLightKeepIndoor: number }}
 */
export function resolveTwilightAmbientParams(lightingEffect = null) {
  const d = TWILIGHT_AMBIENT_DEFAULTS;
  const p = lightingEffect?.params ?? {};
  const u = lightingEffect?._composeMaterial?.uniforms;

  const read = (paramKey, uniformKey, fallback) => {
    const fromParam = Number(p[paramKey]);
    if (Number.isFinite(fromParam)) return Math.max(0, fromParam);
    const fromUniform = Number(u?.[uniformKey]?.value);
    if (Number.isFinite(fromUniform)) return Math.max(0, fromUniform);
    return fallback;
  };

  const darknessParam = Number(p.twilightDarkness);
  return {
    darkness: Number.isFinite(darknessParam)
      ? clamp01(darknessParam)
      : d.darkness,
    dayFloorOutdoor: read('twilightDayFloorOutdoor', 'uTwilightDayFloorOutdoor', d.dayFloorOutdoor),
    dayFloorIndoor: read('twilightDayFloorIndoor', 'uTwilightDayFloorIndoor', d.dayFloorIndoor),
    minLightKeepOutdoor: read('twilightMinLightKeepOutdoor', 'uTwilightMinLightKeepOutdoor', d.minLightKeepOutdoor),
    minLightKeepIndoor: read('twilightMinLightKeepIndoor', 'uTwilightMinLightKeepIndoor', d.minLightKeepIndoor),
  };
}

/**
 * @param {import('./LightingEffectV2.js').LightingEffectV2|null|undefined} lightingEffect
 * @returns {number}
 */
export function resolveTwilightDarkness01(lightingEffect = null) {
  return resolveTwilightAmbientParams(lightingEffect).darkness;
}

/**
 * Simplified ambient illumination (no point lights, darkness meshes, or shadow
 * combine) for one context — matches the core day/night ambient mix in
 * LightingEffectV2 compose. The **indoor** and **outdoor** contexts differ only
 * in which ambient-scale + twilight params they read; the math is identical.
 *
 * @param {'outdoor'|'indoor'} kind
 * @param {object} [options]
 * @param {import('./LightingEffectV2.js').LightingEffectV2|null} [options.lightingEffect]
 * @param {import('../../core/LightingDirector.js').LightingDirectorState|null} [options.directorState]
 * @returns {[number, number, number]}
 */
export function computeAmbientIllumRgb(kind, {
  lightingEffect = null,
  directorState = null,
} = {}) {
  const indoor = kind === 'indoor';
  const state = directorState ?? LightingDirector.get();
  const twilight = resolveTwilightAmbientParams(lightingEffect);
  const darkness = clamp01(state.masterDarkness);
  const daylightHours = clamp01(state.calendarDaylightHours ?? 0);
  const sunStrength = clamp01(state.calendarSunStrength ?? state.calendarDayWeight ?? 0);
  const dayFloor = indoor ? twilight.dayFloorIndoor : twilight.dayFloorOutdoor;
  const minLightKeep = indoor ? twilight.minLightKeepIndoor : twilight.minLightKeepOutdoor;
  const dayAmbientMul = Math.max(sunStrength, dayFloor * daylightHours);

  const u = lightingEffect?._composeMaterial?.uniforms;
  const brightest = u?.uAmbientBrightest?.value
    ? readRgbFromColorLike(u.uAmbientBrightest.value, [1, 1, 1])
    : readFoundryAmbientRgb('bright', [1, 1, 1]);
  const darkest = u?.uAmbientDarkness?.value
    ? readRgbFromColorLike(u.uAmbientDarkness.value, [0.141, 0.141, 0.282])
    : readFoundryAmbientRgb('dark', [0.141, 0.141, 0.282]);

  const eff = lightingEffect?.resolveEffectiveAmbientScales?.()
    ?? lightingEffect?._resolveEffectiveAmbientScalesForCompose?.()
    ?? null;
  const dayScale = Math.max(0, Number(
    (indoor ? eff?.dayIndoor : eff?.dayOutdoor)
    ?? (indoor ? u?.uAmbientDayScaleIndoor?.value : u?.uAmbientDayScaleOutdoor?.value),
  ) || 0);
  const nightScale = Math.max(0, Number(
    (indoor ? eff?.nightIndoor : eff?.nightOutdoor)
    ?? (indoor ? u?.uAmbientNightScaleIndoor?.value : u?.uAmbientNightScaleOutdoor?.value),
  ) || 0);
  const minIllum = Math.max(0, Number(eff?.minIllum ?? u?.uMinIlluminationScale?.value) || 0);

  const ambientDay = brightest.map((c) => c * dayScale * dayAmbientMul);
  const ambientNight = darkest.map((c) => c * nightScale);
  const ambient = lerp3(ambientDay, ambientNight, darkness);

  const minIllumMixed = lerp3(ambientDay, ambientNight, darkness).map((c) => c * 0.1 * minIllum);
  const dayMinKeep = daylightHours * (1.0 - darkness);
  const minFloorScale = Math.max(0.18, dayMinKeep * minLightKeep);

  return ambient.map((c, i) => Math.max(c, minIllumMixed[i] * minFloorScale));
}

/**
 * Outdoor ambient illumination (linear HDR). Thin wrapper over
 * {@link computeAmbientIllumRgb} — kept for existing callers.
 * @param {object} [options]
 * @returns {[number, number, number]}
 */
export function computeOutdoorAmbientIllumRgb(options = {}) {
  return computeAmbientIllumRgb('outdoor', options);
}

/**
 * Indoor ambient illumination (linear HDR) — the "no sky" base indoor pixels get,
 * driven by the Day/Night ambient **indoor** sliders.
 * @param {object} [options]
 * @returns {[number, number, number]}
 */
export function computeIndoorAmbientIllumRgb(options = {}) {
  return computeAmbientIllumRgb('indoor', options);
}

// Runtime handle so consumers that must avoid a static import can reach these off
// `window.MapShine` — the V3 lighting pass needs them but importing this module
// pulls the LightingDirector → WeatherController → wind-profile load-order
// circular dep into V3's Node test bundle and breaks it. Browser-only; no-op
// under Node/tests.
try {
  if (typeof window !== 'undefined') {
    const ms = window.MapShine || (window.MapShine = {});
    ms.__ambientCompose = {
      outdoor: computeOutdoorAmbientIllumRgb,
      indoor: computeIndoorAmbientIllumRgb,
    };
  }
} catch (_) {}
