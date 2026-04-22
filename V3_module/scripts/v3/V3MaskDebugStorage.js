/**
 * @fileoverview Persist V3 mask debug Tweakpane params + pinned mask overlay in localStorage.
 */

const STORAGE_KEY = "map-shine-advanced.v3MaskDebug.params.v1";

/**
 * @typedef {{
 *   followViewedFloor: boolean,
 *   manualFloor: number,
 *   overlayOpacity: number,
 *   checkerOpacity: number,
 *   checkerSizePx: number,
 * }} StoredMaskDebugParams
 */

/**
 * @typedef {{
 *   params: StoredMaskDebugParams,
 *   pinnedPreviewMaskId: string|null,
 * }} MaskDebugStoredState
 */

/**
 * @param {Partial<StoredMaskDebugParams>} defaults
 * @returns {MaskDebugStoredState}
 */
export function loadMaskDebugState(defaults) {
  const base = { ...defaults };
  let pinnedPreviewMaskId = null;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return { params: base, pinnedPreviewMaskId: null };
    }
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") {
      return { params: base, pinnedPreviewMaskId: null };
    }
    const params = {
      followViewedFloor:
        typeof o.followViewedFloor === "boolean"
          ? o.followViewedFloor
          : base.followViewedFloor,
      manualFloor:
        typeof o.manualFloor === "number" && Number.isFinite(o.manualFloor)
          ? o.manualFloor
          : base.manualFloor,
      overlayOpacity:
        typeof o.overlayOpacity === "number" && Number.isFinite(o.overlayOpacity)
          ? o.overlayOpacity
          : base.overlayOpacity,
      checkerOpacity:
        typeof o.checkerOpacity === "number" && Number.isFinite(o.checkerOpacity)
          ? o.checkerOpacity
          : base.checkerOpacity,
      checkerSizePx:
        typeof o.checkerSizePx === "number" && Number.isFinite(o.checkerSizePx)
          ? o.checkerSizePx
          : base.checkerSizePx,
    };
    if (typeof o.pinnedPreviewMaskId === "string" && o.pinnedPreviewMaskId.length > 0) {
      pinnedPreviewMaskId = o.pinnedPreviewMaskId;
    }
    return { params, pinnedPreviewMaskId };
  } catch (_) {
    return { params: base, pinnedPreviewMaskId: null };
  }
}

/**
 * @param {StoredMaskDebugParams} params
 * @param {string|null} pinnedPreviewMaskId registry id (e.g. `outdoors`) or null to clear pin
 */
export function saveMaskDebugState(params, pinnedPreviewMaskId) {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...params,
        pinnedPreviewMaskId:
          typeof pinnedPreviewMaskId === "string" && pinnedPreviewMaskId.length > 0
            ? pinnedPreviewMaskId
            : null,
      }),
    );
  } catch (_) {}
}

const SKY_LIT_STORAGE_KEY = "map-shine-advanced.v3SkyLighting.v1";

/**
 * @typedef {{
 *   enabled: boolean,
 *   useSceneDarkness: boolean,
 *   manualDarkness01: number,
 *   strength: number,
 * }} SkyLightingDebugState
 */

/**
 * @param {SkyLightingDebugState} defaults
 * @returns {SkyLightingDebugState}
 */
export function loadSkyLightingDebugState(defaults) {
  const base = { ...defaults };
  try {
    const raw = globalThis.localStorage?.getItem(SKY_LIT_STORAGE_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return base;
    return {
      enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
      useSceneDarkness:
        typeof o.useSceneDarkness === "boolean" ? o.useSceneDarkness : base.useSceneDarkness,
      manualDarkness01:
        typeof o.manualDarkness01 === "number" && Number.isFinite(o.manualDarkness01)
          ? Math.max(0, Math.min(1, o.manualDarkness01))
          : base.manualDarkness01,
      strength:
        typeof o.strength === "number" && Number.isFinite(o.strength)
          ? Math.max(0, Math.min(3, o.strength))
          : base.strength,
    };
  } catch (_) {
    return base;
  }
}

/**
 * @param {SkyLightingDebugState} state
 */
export function saveSkyLightingDebugState(state) {
  try {
    globalThis.localStorage?.setItem(SKY_LIT_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

const AMBIENT_TINT_STORAGE_KEY = "map-shine-advanced.v3AmbientTint.v1";

/**
 * @typedef {{
 *   enabled: boolean,
 *   color: [number, number, number],
 *   intensity: number,
 * }} AmbientTintDebugState
 */

/** Validate a 3-tuple of finite numbers; used for color defaults + persisted state. */
function coerceColor3(value, fallback) {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = Number(value[i]);
    out[i] = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback[i];
  }
  return out;
}

/**
 * @param {AmbientTintDebugState} defaults
 * @returns {AmbientTintDebugState}
 */
export function loadAmbientTintDebugState(defaults) {
  const base = { ...defaults, color: [...defaults.color] };
  try {
    const raw = globalThis.localStorage?.getItem(AMBIENT_TINT_STORAGE_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return base;
    return {
      enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
      color: coerceColor3(o.color, base.color),
      intensity:
        typeof o.intensity === "number" && Number.isFinite(o.intensity)
          ? Math.max(0, Math.min(4, o.intensity))
          : base.intensity,
    };
  } catch (_) {
    return base;
  }
}

/** @param {AmbientTintDebugState} state */
export function saveAmbientTintDebugState(state) {
  try {
    globalThis.localStorage?.setItem(AMBIENT_TINT_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

const LIGHT_APPEARANCE_STORAGE_KEY = "map-shine-advanced.v3LightAppearance.v1";

/**
 * @typedef {{
 *   addScale: number,
 *   dimRadiusStrength: number,
 *   brightRadiusStrength: number,
 *   illuminationStrength: number,
 *   colorationStrength: number,
 *   colorationReflectivity: number,
 *   colorationSaturation: number,
 *   groundSaturation: number,
 *   groundContrast: number,
 * }} LightAppearanceDebugState
 */

/**
 * @param {LightAppearanceDebugState} defaults
 * @returns {LightAppearanceDebugState}
 */
export function loadLightAppearanceDebugState(defaults) {
  const base = { ...defaults };
  try {
    const raw = globalThis.localStorage?.getItem(LIGHT_APPEARANCE_STORAGE_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return base;
    const read = (key, fallback, min, max) => {
      const n = Number(o[key]);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };
    return {
      addScale: read("addScale", base.addScale, 0, 2),
      dimRadiusStrength: read("dimRadiusStrength", base.dimRadiusStrength, 0, 8),
      brightRadiusStrength: read("brightRadiusStrength", base.brightRadiusStrength, 0, 8),
      illuminationStrength: read("illuminationStrength", base.illuminationStrength, 0, 4),
      colorationStrength: read("colorationStrength", base.colorationStrength, 0, 4),
      colorationReflectivity: read("colorationReflectivity", base.colorationReflectivity, 0, 1),
      colorationSaturation: read("colorationSaturation", base.colorationSaturation, -1, 4),
      groundSaturation: read("groundSaturation", base.groundSaturation, -1, 4),
      groundContrast: read("groundContrast", base.groundContrast, -1, 2),
    };
  } catch (_) {
    return base;
  }
}

/** @param {LightAppearanceDebugState} state */
export function saveLightAppearanceDebugState(state) {
  try {
    globalThis.localStorage?.setItem(LIGHT_APPEARANCE_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

const SCENE_COLOR_GRADE_STORAGE_KEY = "map-shine-advanced.v3SceneColorGrade.v1";

/**
 * @typedef {{
 *   enabled: boolean,
 *   exposure: number,
 *   temperature: number,
 *   tint: number,
 *   brightness: number,
 *   contrast: number,
 *   saturation: number,
 *   vibrance: number,
 *   liftColor: [number, number, number],
 *   gammaColor: [number, number, number],
 *   gainColor: [number, number, number],
 *   masterGamma: number,
 *   toneMapping: number,
 * }} SceneColorGradeDebugState
 */

/**
 * @param {SceneColorGradeDebugState} defaults
 * @returns {SceneColorGradeDebugState}
 */
export function loadSceneColorGradeDebugState(defaults) {
  const base = {
    ...defaults,
    liftColor: [...defaults.liftColor],
    gammaColor: [...defaults.gammaColor],
    gainColor: [...defaults.gainColor],
  };
  try {
    const raw = globalThis.localStorage?.getItem(SCENE_COLOR_GRADE_STORAGE_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return base;
    const read = (key, fallback, min, max) => {
      const n = Number(o[key]);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };
    return {
      enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
      exposure: read("exposure", base.exposure, 0, 5),
      temperature: read("temperature", base.temperature, -1, 1),
      tint: read("tint", base.tint, -1, 1),
      brightness: read("brightness", base.brightness, -0.1, 0.1),
      contrast: read("contrast", base.contrast, 0.5, 1.5),
      saturation: read("saturation", base.saturation, 0, 2.5),
      vibrance: read("vibrance", base.vibrance, -1, 1),
      liftColor: coerceColor3(o.liftColor, base.liftColor),
      gammaColor: coerceColor3(o.gammaColor, base.gammaColor),
      gainColor: coerceColor3(o.gainColor, base.gainColor),
      masterGamma: read("masterGamma", base.masterGamma, 0.1, 3),
      toneMapping: Math.max(0, Math.min(2, Math.round(read("toneMapping", base.toneMapping, 0, 2)))),
    };
  } catch (_) {
    return base;
  }
}

/** @param {SceneColorGradeDebugState} state */
export function saveSceneColorGradeDebugState(state) {
  try {
    globalThis.localStorage?.setItem(SCENE_COLOR_GRADE_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

const TOKEN_COLOR_GRADE_STORAGE_KEY = "map-shine-advanced.v3TokenColorGrade.v1";

/**
 * @typedef {{
 *   enabled: boolean,
 *   exposure: number,
 *   temperature: number,
 *   tint: number,
 *   brightness: number,
 *   contrast: number,
 *   saturation: number,
 *   vibrance: number,
 *   amount: number,
 * }} TokenColorGradeDebugState
 */

/**
 * @param {TokenColorGradeDebugState} defaults
 * @returns {TokenColorGradeDebugState}
 */
export function loadTokenColorGradeDebugState(defaults) {
  const base = { ...defaults };
  try {
    const raw = globalThis.localStorage?.getItem(TOKEN_COLOR_GRADE_STORAGE_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return base;
    const read = (key, fallback, min, max) => {
      const n = Number(o[key]);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };
    return {
      enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
      exposure: read("exposure", base.exposure, 0, 5),
      temperature: read("temperature", base.temperature, -1, 1),
      tint: read("tint", base.tint, -1, 1),
      brightness: read("brightness", base.brightness, -0.1, 0.1),
      contrast: read("contrast", base.contrast, 0.5, 1.5),
      saturation: read("saturation", base.saturation, 0, 2.5),
      vibrance: read("vibrance", base.vibrance, -1, 1),
      amount: read("amount", base.amount, 0, 1),
    };
  } catch (_) {
    return base;
  }
}

/** @param {TokenColorGradeDebugState} state */
export function saveTokenColorGradeDebugState(state) {
  try {
    globalThis.localStorage?.setItem(TOKEN_COLOR_GRADE_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

const BUILDING_SHADOWS_STORAGE_KEY = "map-shine-advanced.v3BuildingShadows.v1";

/**
 * @typedef {{
 *   enabled: boolean,
 *   opacity: number,
 *   length: number,
 *   softness: number,
 *   smear: number,
 *   penumbra: number,
 *   shadowCurve: number,
 *   blurRadius: number,
 *   resolutionScale: number,
 *   alphaHoleLo: number,
 *   alphaHoleHi: number,
 *   sunAzimuthDeg: number,
 *   sunLatitude: number,
 * }} BuildingShadowsDebugState
 */

/**
 * @param {BuildingShadowsDebugState} defaults
 * @returns {BuildingShadowsDebugState}
 */
export function loadBuildingShadowsDebugState(defaults) {
  const base = { ...defaults };
  try {
    const raw = globalThis.localStorage?.getItem(BUILDING_SHADOWS_STORAGE_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return base;
    const read = (key, fallback, min, max) => {
      const n = Number(o[key]);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };
    let lo = read("alphaHoleLo", base.alphaHoleLo, 0, 1);
    let hi = read("alphaHoleHi", base.alphaHoleHi, 0, 1);
    if (hi <= lo) hi = Math.min(1, lo + 0.01);
    return {
      enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
      opacity: read("opacity", base.opacity, 0, 1),
      length: read("length", base.length, 0, 2),
      softness: read("softness", base.softness, 0.1, 8),
      smear: read("smear", base.smear, 0, 1),
      penumbra: read("penumbra", base.penumbra, 0, 1),
      shadowCurve: read("shadowCurve", base.shadowCurve, 0.1, 3),
      blurRadius: read("blurRadius", base.blurRadius, 0, 4),
      resolutionScale: read("resolutionScale", base.resolutionScale, 0.25, 2),
      alphaHoleLo: lo,
      alphaHoleHi: hi,
      sunAzimuthDeg: read("sunAzimuthDeg", base.sunAzimuthDeg, 0, 360),
      sunLatitude: read("sunLatitude", base.sunLatitude, 0, 1),
    };
  } catch (_) {
    return base;
  }
}

/** @param {BuildingShadowsDebugState} state */
export function saveBuildingShadowsDebugState(state) {
  try {
    globalThis.localStorage?.setItem(BUILDING_SHADOWS_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}
