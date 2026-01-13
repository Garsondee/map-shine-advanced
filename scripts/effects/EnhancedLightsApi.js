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
        isStatic: data.isStatic === true,
        castShadows: data.castShadows === true,
        shadowQuality: data.shadowQuality,
        // Cookie/gobo texture support
        cookieTexture: (typeof data.cookieTexture === 'string' && data.cookieTexture) ? data.cookieTexture : undefined,
        cookieRotation: Number.isFinite(data.cookieRotation) ? data.cookieRotation : undefined,
        cookieScale: Number.isFinite(data.cookieScale) ? data.cookieScale : undefined
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
        ? ((typeof changes.cookieTexture === 'string' && changes.cookieTexture) ? changes.cookieTexture : undefined)
        : cur.cookieTexture;
      const normalizedCookieRotation = (changes.cookieRotation !== undefined)
        ? (Number.isFinite(changes.cookieRotation) ? changes.cookieRotation : undefined)
        : cur.cookieRotation;
      const normalizedCookieScale = (changes.cookieScale !== undefined)
        ? (Number.isFinite(changes.cookieScale) ? changes.cookieScale : undefined)
        : cur.cookieScale;
      const next = {
        ...cur,
        ...changes,
        targetLayers: normalizedTargetLayers,
        cookieTexture: normalizedCookieTexture,
        cookieRotation: normalizedCookieRotation,
        cookieScale: normalizedCookieScale,
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
        }
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
