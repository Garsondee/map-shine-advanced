/**
 * @fileoverview MapShineLightAdapter
 * Reads MapShine-native enhanced lights from Foundry scene flags and converts them
 * into the unified `ILightEntity` format.
 */

const MODULE_ID = 'map-shine-advanced';

const CANONICAL_FLAG_KEY = 'enhancedLights';
const CURRENT_VERSION = 1;

const DEFAULT_FLAG_KEYS = [
  CANONICAL_FLAG_KEY,
  'mapshineLights',
  'threeNativeLights'
];

const DEFAULT_COOKIE_STRENGTH = 1.0;
const DEFAULT_COOKIE_CONTRAST = 1.0;
const DEFAULT_COOKIE_GAMMA = 1.0;

const DEFAULT_OUTPUT_GAIN = 1.0;
const DEFAULT_OUTER_WEIGHT = 0.5;
const DEFAULT_INNER_WEIGHT = 0.5;

function _getFlag(scene, key) {
  if (!scene || !key) return undefined;

  try {
    if (typeof scene.getFlag === 'function') {
      const v = scene.getFlag(MODULE_ID, key);
      if (v !== undefined) return v;
    }
  } catch (_) {
  }

  try {
    return scene?.flags?.[MODULE_ID]?.[key];
  } catch (_) {
    return undefined;
  }
}

function _asFiniteNumber(x, fallback) {
  const n = (typeof x === 'number') ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function _coerceAnimation(srcAnim) {
  if (!srcAnim || typeof srcAnim !== 'object') return undefined;

  // Preserve arbitrary animation payloads for MapShine-native authoring.
  // The renderer will selectively consume fields it understands.
  const a = { ...srcAnim };

  if ('speed' in a) a.speed = _asFiniteNumber(a.speed, a.speed);
  if ('intensity' in a) a.intensity = _asFiniteNumber(a.intensity, a.intensity);
  if ('seed' in a) a.seed = _asFiniteNumber(a.seed, a.seed);
  if ('reverse' in a) a.reverse = a.reverse === true;

  return a;
}

/**
 * @returns {{version:number, lights:any[]}}
 */
function _coerceContainer(raw) {
  if (!raw) return { version: CURRENT_VERSION, lights: [] };

  // Legacy: raw array of lights.
  if (Array.isArray(raw)) return { version: CURRENT_VERSION, lights: raw };

  if (raw && typeof raw === 'object') {
    const version = Number.isFinite(raw.version) ? raw.version : CURRENT_VERSION;
    const lights = Array.isArray(raw.lights)
      ? raw.lights
      : (Array.isArray(raw.items) ? raw.items : []);

    return { version, lights };
  }

  return { version: CURRENT_VERSION, lights: [] };
}

export class MapShineLightAdapter {
  /**
   * Read enhanced lights from the scene (if any) and convert them to `ILightEntity`.
   *
   * This is intentionally tolerant:
   * - Accepts multiple possible flag keys (early prototypes may vary)
   * - Accepts either an array, or an object containing `{ lights: [...] }`
   * - Skips invalid entries rather than throwing
   *
   * @param {Scene} scene
   * @param {{flagKeys?: string[]}} [options]
   * @returns {any[]} ILightEntity[]
   */
  static readEntities(scene, options = {}) {
    const flagKeys = Array.isArray(options.flagKeys) && options.flagKeys.length
      ? options.flagKeys
      : DEFAULT_FLAG_KEYS;

    let raw = undefined;
    // Prefer canonical key first.
    raw = _getFlag(scene, CANONICAL_FLAG_KEY);

    if (raw === undefined || raw === null) {
      for (const key of flagKeys) {
        raw = _getFlag(scene, key);
        if (raw !== undefined && raw !== null) break;
      }
    }

    const container = _coerceContainer(raw);
    const list = Array.isArray(container.lights) ? container.lights : [];
    if (!list.length) return [];

    /** @type {any[]} */
    const out = [];

    for (let i = 0; i < list.length; i++) {
      const src = list[i];
      if (!src || typeof src !== 'object') continue;

      const id = (src.id != null) ? String(src.id) : '';
      if (!id) continue;

      const x = _asFiniteNumber(src.x ?? src.transform?.x, null);
      const y = _asFiniteNumber(src.y ?? src.transform?.y, null);
      if (x === null || y === null) continue;

      const dim = _asFiniteNumber(src.dim ?? src.photometry?.dim, 0);
      const bright = _asFiniteNumber(src.bright ?? src.photometry?.bright, Math.max(0, dim * 0.5));

      out.push({
        id,
        sourceType: 'mapshine',
        enabled: src.enabled !== false,
        isDarkness: src.isDarkness === true,
        linkedFoundryLightId: (src.linkedFoundryLightId != null) ? String(src.linkedFoundryLightId) : undefined,
        overrideFoundry: src.overrideFoundry === true,
        transform: {
          x,
          y,
          z: (src.z !== undefined || src.transform?.z !== undefined)
            ? _asFiniteNumber(src.z ?? src.transform?.z, 0)
            : undefined
        },
        color: src.color,
        photometry: {
          dim,
          bright,
          attenuation: (src.attenuation !== undefined || src.photometry?.attenuation !== undefined)
            ? _asFiniteNumber(src.attenuation ?? src.photometry?.attenuation, 0.5)
            : undefined,
          alpha: (src.alpha !== undefined || src.photometry?.alpha !== undefined)
            ? _asFiniteNumber(src.alpha ?? src.photometry?.alpha, 0.5)
            : undefined,
          luminosity: (src.luminosity !== undefined || src.photometry?.luminosity !== undefined)
            ? _asFiniteNumber(src.luminosity ?? src.photometry?.luminosity, 0.5)
            : undefined
        },
        animation: _coerceAnimation(src.animation),
        // Darkness-driven intensity response ("Sun Light").
        darknessResponse: (src.darknessResponse && typeof src.darknessResponse === 'object')
          ? {
              enabled: src.darknessResponse.enabled === true,
              invert: src.darknessResponse.invert !== false,
              exponent: _asFiniteNumber(src.darknessResponse.exponent, 1.0),
              min: _asFiniteNumber(src.darknessResponse.min, 0.0),
              max: _asFiniteNumber(src.darknessResponse.max, 1.0)
            }
          : undefined,
        isStatic: src.isStatic === true,
        // Layer targeting: which surface layers this light affects
        targetLayers: (src.targetLayers === 'ground' || src.targetLayers === 'overhead' || src.targetLayers === 'both')
          ? src.targetLayers
          : 'both',
        // Additional shaping/boost controls
        outputGain: (src.outputGain !== undefined)
          ? _asFiniteNumber(src.outputGain, DEFAULT_OUTPUT_GAIN)
          : DEFAULT_OUTPUT_GAIN,
        outerWeight: (src.outerWeight !== undefined)
          ? _asFiniteNumber(src.outerWeight, DEFAULT_OUTER_WEIGHT)
          : DEFAULT_OUTER_WEIGHT,
        innerWeight: (src.innerWeight !== undefined)
          ? _asFiniteNumber(src.innerWeight, DEFAULT_INNER_WEIGHT)
          : DEFAULT_INNER_WEIGHT,
        // Cookie/gobo texture support
        cookieEnabled: src.cookieEnabled === true,
        cookieTexture: (typeof src.cookieTexture === 'string' && src.cookieTexture) ? src.cookieTexture : undefined,
        cookieRotation: (src.cookieRotation !== undefined) ? _asFiniteNumber(src.cookieRotation, undefined) : undefined,
        cookieScale: (src.cookieScale !== undefined) ? _asFiniteNumber(src.cookieScale, undefined) : undefined,
        cookieTint: (typeof src.cookieTint === 'string' && src.cookieTint) ? src.cookieTint : undefined,
        // Cookie shaping controls (boost visibility)
        cookieStrength: (src.cookieStrength !== undefined)
          ? _asFiniteNumber(src.cookieStrength, DEFAULT_COOKIE_STRENGTH)
          : DEFAULT_COOKIE_STRENGTH,
        cookieContrast: (src.cookieContrast !== undefined)
          ? _asFiniteNumber(src.cookieContrast, DEFAULT_COOKIE_CONTRAST)
          : DEFAULT_COOKIE_CONTRAST,
        cookieGamma: (src.cookieGamma !== undefined)
          ? _asFiniteNumber(src.cookieGamma, DEFAULT_COOKIE_GAMMA)
          : DEFAULT_COOKIE_GAMMA,
        cookieInvert: src.cookieInvert === true,
        cookieColorize: src.cookieColorize === true,
        activationRange: (src.activationRange !== undefined) ? _asFiniteNumber(src.activationRange, undefined) : undefined,
        zMin: (src.zMin !== undefined) ? _asFiniteNumber(src.zMin, undefined) : undefined,
        zMax: (src.zMax !== undefined) ? _asFiniteNumber(src.zMax, undefined) : undefined,
        castShadows: src.castShadows === true,
        shadowQuality: (src.shadowQuality === 'hard' || src.shadowQuality === 'soft') ? src.shadowQuality : undefined,
        raw: src
      });
    }

    return out;
  }
}
