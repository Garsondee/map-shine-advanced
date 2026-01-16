/**
 * @fileoverview EnhancedLightsApi
 * Minimal dev-authoring API for MapShine-native enhanced lights.
 *
 * This intentionally avoids UI work. It only reads/writes scene flags.
 * LightingEffect listens to updateScene and will rebuild MapShine-native light
 * renderables automatically.
 */

const MODULE_ID = 'map-shine-advanced';
const FLAG_KEY = 'enhancedLights';
const CURRENT_VERSION = 1;

const DEFAULT_COOKIE_TEXTURE = `modules/${MODULE_ID}/assets/kenney assets/light_01.png`;
const DEFAULT_COOKIE_STRENGTH = 1.0;
const DEFAULT_COOKIE_CONTRAST = 1.0;
const DEFAULT_COOKIE_GAMMA = 1.0;
const DEFAULT_COOKIE_INVERT = false;
const DEFAULT_COOKIE_COLORIZE = false;
const DEFAULT_COOKIE_TINT = '#ffffff';

const DEFAULT_OUTPUT_GAIN = 1.0;
const DEFAULT_OUTER_WEIGHT = 0.5;
const DEFAULT_INNER_WEIGHT = 0.5;

function _randomId() {
  try {
    if (foundry?.utils?.randomID) return foundry.utils.randomID();
  } catch (_) {
  }

  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch (_) {
  }

  return String(Math.floor(Math.random() * 1e9));
}

function _isObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function _clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function _normalizeDarknessResponse(cur, next) {
  const c0 = _isObject(cur) ? cur : {};
  const n0 = _isObject(next) ? next : {};
  const out = { ...c0, ...n0 };

  // Defaults chosen to represent "Sun Light" behavior:
  // - enabled off by default
  // - invert on means "day=1" (scene darkness 0) and "night=0" (scene darkness 1)
  if (out.enabled !== undefined) out.enabled = out.enabled === true;
  if (out.invert !== undefined) out.invert = out.invert !== false;

  if (out.exponent !== undefined) {
    const e = Number(out.exponent);
    out.exponent = Number.isFinite(e) ? Math.max(0.01, e) : 1.0;
  }

  if (out.min !== undefined) out.min = _clamp01(out.min);
  if (out.max !== undefined) out.max = _clamp01(out.max);

  return out;
}

function _canEditScene() {
  const scene = canvas?.scene;
  const user = game?.user;
  if (!scene || !user) return false;
  if (user.isGM) return true;

  try {
    if (typeof scene.canUserModify === 'function') return scene.canUserModify(user, 'update');
  } catch (_) {
  }

  return false;
}

function _normalizeContainer(raw) {
  if (Array.isArray(raw)) {
    return { version: CURRENT_VERSION, lights: raw };
  }

  if (_isObject(raw)) {
    const version = Number.isFinite(raw.version) ? raw.version : CURRENT_VERSION;
    const lights = Array.isArray(raw.lights)
      ? raw.lights
      : (Array.isArray(raw.items) ? raw.items : []);

    return { version, lights };
  }

  return { version: CURRENT_VERSION, lights: [] };
}

export function createEnhancedLightsApi() {
  return {
    moduleId: MODULE_ID,
    flagKey: FLAG_KEY,
    version: CURRENT_VERSION,

    canEdit() {
      return _canEditScene();
    },

    async getContainer() {
      const scene = canvas?.scene;
      if (!scene) return _normalizeContainer(null);

      let raw;
      try {
        raw = scene.getFlag(MODULE_ID, FLAG_KEY);
      } catch (_) {
        raw = scene?.flags?.[MODULE_ID]?.[FLAG_KEY];
      }

      return _normalizeContainer(raw);
    },

    async list() {
      const c = await this.getContainer();
      return Array.isArray(c.lights) ? c.lights : [];
    },

    async get(id) {
      const list = await this.list();
      return list.find((l) => String(l?.id) === String(id)) || null;
    },

    /**
     * Create an enhanced light seeded from a Foundry AmbientLight.
     * @param {string} foundryId
     * @param {{overrideFoundry?: boolean, id?: string}} [options]
     */
    async enhanceFoundryLight(foundryId, options = {}) {
      if (!_canEditScene()) throw new Error('Insufficient permissions to edit scene');
      const scene = canvas?.scene;
      if (!scene) throw new Error('No active scene');

      const placeable = canvas?.lighting?.get?.(foundryId) || canvas?.lighting?.placeables?.find?.((l) => l?.id === foundryId);
      const doc = placeable?.document;
      if (!doc) throw new Error(`AmbientLight not found: ${foundryId}`);

      const config = doc?.config ?? {};

      return this.create({
        id: options?.id,
        x: doc.x,
        y: doc.y,
        dim: config.dim,
        bright: config.bright,
        attenuation: config.attenuation,
        alpha: config.alpha,
        luminosity: config.luminosity,
        color: config.color,
        isDarkness: (config.negative === true) || (doc.negative === true),
        animation: (config.animation && typeof config.animation === 'object') ? { ...config.animation } : undefined,
        linkedFoundryLightId: String(foundryId),
        overrideFoundry: options?.overrideFoundry === true
      });
    },

    /**
     * Create a new enhanced light.
     * @param {Object} data
     */
    async create(data = {}) {
      if (!_canEditScene()) throw new Error('Insufficient permissions to edit scene');

      const scene = canvas?.scene;
      if (!scene) throw new Error('No active scene');

      const container = await this.getContainer();
      const lights = Array.isArray(container.lights) ? [...container.lights] : [];

      const id = String(data.id ?? _randomId());
      const x = Number.isFinite(data.x) ? data.x : (Number.isFinite(data.transform?.x) ? data.transform.x : 0);
      const y = Number.isFinite(data.y) ? data.y : (Number.isFinite(data.transform?.y) ? data.transform.y : 0);

      const dim = Number.isFinite(data.dim) ? data.dim : (Number.isFinite(data.photometry?.dim) ? data.photometry.dim : 8);
      const bright = Number.isFinite(data.bright) ? data.bright : (Number.isFinite(data.photometry?.bright) ? data.photometry.bright : Math.max(0, dim * 0.5));

      // Validate targetLayers
      const validLayers = ['ground', 'overhead', 'both'];
      const targetLayers = validLayers.includes(data.targetLayers) ? data.targetLayers : 'both';

      const light = {
        id,
        enabled: data.enabled !== false,
        isDarkness: data.isDarkness === true,
        linkedFoundryLightId: (data.linkedFoundryLightId != null) ? String(data.linkedFoundryLightId) : undefined,
        overrideFoundry: data.overrideFoundry === true,
        targetLayers,
        transform: { x, y },
        color: data.color ?? '#ffffff',
        photometry: {
          dim,
          bright,
          attenuation: Number.isFinite(data.attenuation) ? data.attenuation : (Number.isFinite(data.photometry?.attenuation) ? data.photometry.attenuation : 0.5),
          alpha: Number.isFinite(data.alpha) ? data.alpha : (Number.isFinite(data.photometry?.alpha) ? data.photometry.alpha : 0.5),
          luminosity: Number.isFinite(data.luminosity) ? data.luminosity : (Number.isFinite(data.photometry?.luminosity) ? data.photometry.luminosity : 0.5)
        },
        animation: _isObject(data.animation) ? data.animation : undefined,
        // Darkness-driven response ("Sun Light" intensity behavior)
        darknessResponse: _isObject(data.darknessResponse)
          ? _normalizeDarknessResponse(undefined, data.darknessResponse)
          : undefined,
        isStatic: data.isStatic === true,
        castShadows: data.castShadows === true,
        shadowQuality: data.shadowQuality,
        // Additional shaping/boost controls
        outputGain: Number.isFinite(data.outputGain) ? data.outputGain : DEFAULT_OUTPUT_GAIN,
        outerWeight: Number.isFinite(data.outerWeight) ? data.outerWeight : DEFAULT_OUTER_WEIGHT,
        innerWeight: Number.isFinite(data.innerWeight) ? data.innerWeight : DEFAULT_INNER_WEIGHT,
        // Cookie/gobo texture support
        cookieEnabled: data.cookieEnabled === true,
        cookieTexture: (typeof data.cookieTexture === 'string' && data.cookieTexture)
          ? data.cookieTexture
          : DEFAULT_COOKIE_TEXTURE,
        cookieRotation: Number.isFinite(data.cookieRotation) ? data.cookieRotation : undefined,
        cookieScale: Number.isFinite(data.cookieScale) ? data.cookieScale : undefined,
        cookieTint: (typeof data.cookieTint === 'string' && data.cookieTint)
          ? data.cookieTint
          : DEFAULT_COOKIE_TINT,
        // Cookie shaping controls (boost visibility)
        cookieStrength: Number.isFinite(data.cookieStrength) ? data.cookieStrength : DEFAULT_COOKIE_STRENGTH,
        cookieContrast: Number.isFinite(data.cookieContrast) ? data.cookieContrast : DEFAULT_COOKIE_CONTRAST,
        cookieGamma: Number.isFinite(data.cookieGamma) ? data.cookieGamma : DEFAULT_COOKIE_GAMMA,
        cookieInvert: data.cookieInvert === true,
        cookieColorize: data.cookieColorize === true
      };

      lights.push(light);

      const next = { version: CURRENT_VERSION, lights };
      await scene.setFlag(MODULE_ID, FLAG_KEY, next);
      return light;
    },

    async update(id, changes = {}) {
      if (!_canEditScene()) throw new Error('Insufficient permissions to edit scene');

      const scene = canvas?.scene;
      if (!scene) throw new Error('No active scene');

      const container = await this.getContainer();
      const lights = Array.isArray(container.lights) ? [...container.lights] : [];

      const idx = lights.findIndex((l) => String(l?.id) === String(id));
      if (idx === -1) return null;

      const cur = lights[idx] || {};

      // Normalize selected fields similarly to create()
      const validLayers = ['ground', 'overhead', 'both'];
      const normalizedTargetLayers = (changes.targetLayers !== undefined)
        ? (validLayers.includes(changes.targetLayers) ? changes.targetLayers : (cur.targetLayers ?? 'both'))
        : (cur.targetLayers ?? 'both');

      const normalizedCookieTexture = (changes.cookieTexture !== undefined)
        ? ((typeof changes.cookieTexture === 'string' && changes.cookieTexture) ? changes.cookieTexture : DEFAULT_COOKIE_TEXTURE)
        : (cur.cookieTexture ?? DEFAULT_COOKIE_TEXTURE);
      const normalizedCookieRotation = (changes.cookieRotation !== undefined)
        ? (Number.isFinite(changes.cookieRotation) ? changes.cookieRotation : undefined)
        : cur.cookieRotation;
      const normalizedCookieScale = (changes.cookieScale !== undefined)
        ? (Number.isFinite(changes.cookieScale) ? changes.cookieScale : undefined)
        : cur.cookieScale;
      const normalizedCookieEnabled = (changes.cookieEnabled !== undefined)
        ? (changes.cookieEnabled === true)
        : (cur.cookieEnabled === true);

      const normalizedCookieTint = (changes.cookieTint !== undefined)
        ? ((typeof changes.cookieTint === 'string' && changes.cookieTint) ? changes.cookieTint : DEFAULT_COOKIE_TINT)
        : (cur.cookieTint ?? DEFAULT_COOKIE_TINT);

      const normalizedOutputGain = (changes.outputGain !== undefined)
        ? (Number.isFinite(changes.outputGain) ? changes.outputGain : DEFAULT_OUTPUT_GAIN)
        : (Number.isFinite(cur.outputGain) ? cur.outputGain : DEFAULT_OUTPUT_GAIN);
      const normalizedOuterWeight = (changes.outerWeight !== undefined)
        ? (Number.isFinite(changes.outerWeight) ? changes.outerWeight : DEFAULT_OUTER_WEIGHT)
        : (Number.isFinite(cur.outerWeight) ? cur.outerWeight : DEFAULT_OUTER_WEIGHT);
      const normalizedInnerWeight = (changes.innerWeight !== undefined)
        ? (Number.isFinite(changes.innerWeight) ? changes.innerWeight : DEFAULT_INNER_WEIGHT)
        : (Number.isFinite(cur.innerWeight) ? cur.innerWeight : DEFAULT_INNER_WEIGHT);

      const normalizedCookieStrength = (changes.cookieStrength !== undefined)
        ? (Number.isFinite(changes.cookieStrength) ? changes.cookieStrength : DEFAULT_COOKIE_STRENGTH)
        : (Number.isFinite(cur.cookieStrength) ? cur.cookieStrength : DEFAULT_COOKIE_STRENGTH);
      const normalizedCookieContrast = (changes.cookieContrast !== undefined)
        ? (Number.isFinite(changes.cookieContrast) ? changes.cookieContrast : DEFAULT_COOKIE_CONTRAST)
        : (Number.isFinite(cur.cookieContrast) ? cur.cookieContrast : DEFAULT_COOKIE_CONTRAST);
      const normalizedCookieGamma = (changes.cookieGamma !== undefined)
        ? (Number.isFinite(changes.cookieGamma) ? changes.cookieGamma : DEFAULT_COOKIE_GAMMA)
        : (Number.isFinite(cur.cookieGamma) ? cur.cookieGamma : DEFAULT_COOKIE_GAMMA);
      const normalizedCookieInvert = (changes.cookieInvert !== undefined)
        ? (changes.cookieInvert === true)
        : (cur.cookieInvert === true);
      const normalizedCookieColorize = (changes.cookieColorize !== undefined)
        ? (changes.cookieColorize === true)
        : (cur.cookieColorize === true);

      const next = {
        ...cur,
        ...changes,
        targetLayers: normalizedTargetLayers,
        outputGain: normalizedOutputGain,
        outerWeight: normalizedOuterWeight,
        innerWeight: normalizedInnerWeight,
        cookieEnabled: normalizedCookieEnabled,
        cookieTexture: normalizedCookieTexture,
        cookieRotation: normalizedCookieRotation,
        cookieScale: normalizedCookieScale,
        cookieTint: normalizedCookieTint,
        cookieStrength: normalizedCookieStrength,
        cookieContrast: normalizedCookieContrast,
        cookieGamma: normalizedCookieGamma,
        cookieInvert: normalizedCookieInvert,
        cookieColorize: normalizedCookieColorize,
        transform: {
          ...(cur.transform || {}),
          ...(changes.transform || {}),
          x: (changes.x !== undefined) ? changes.x : ((changes.transform && changes.transform.x !== undefined) ? changes.transform.x : (cur.transform?.x ?? 0)),
          y: (changes.y !== undefined) ? changes.y : ((changes.transform && changes.transform.y !== undefined) ? changes.transform.y : (cur.transform?.y ?? 0))
        },
        photometry: {
          ...(cur.photometry || {}),
          ...(changes.photometry || {}),
          dim: (changes.dim !== undefined) ? changes.dim : ((changes.photometry && changes.photometry.dim !== undefined) ? changes.photometry.dim : (cur.photometry?.dim ?? 0)),
          bright: (changes.bright !== undefined) ? changes.bright : ((changes.photometry && changes.photometry.bright !== undefined) ? changes.photometry.bright : (cur.photometry?.bright ?? 0))
        },
        darknessResponse: (changes.darknessResponse !== undefined)
          ? _normalizeDarknessResponse(cur.darknessResponse, changes.darknessResponse)
          : cur.darknessResponse
      };

      delete next.x;
      delete next.y;
      delete next.dim;
      delete next.bright;

      lights[idx] = next;

      await scene.setFlag(MODULE_ID, FLAG_KEY, { version: CURRENT_VERSION, lights });
      return next;
    },

    async remove(id) {
      if (!_canEditScene()) throw new Error('Insufficient permissions to edit scene');

      const scene = canvas?.scene;
      if (!scene) throw new Error('No active scene');

      const container = await this.getContainer();
      const lights = Array.isArray(container.lights) ? [...container.lights] : [];

      const nextLights = lights.filter((l) => String(l?.id) !== String(id));
      await scene.setFlag(MODULE_ID, FLAG_KEY, { version: CURRENT_VERSION, lights: nextLights });
      return true;
    },

    async clear() {
      if (!_canEditScene()) throw new Error('Insufficient permissions to edit scene');
      const scene = canvas?.scene;
      if (!scene) throw new Error('No active scene');
      await scene.setFlag(MODULE_ID, FLAG_KEY, { version: CURRENT_VERSION, lights: [] });
      return true;
    }
  };
}
