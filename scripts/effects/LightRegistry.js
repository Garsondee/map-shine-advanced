/**
 * @fileoverview LightRegistry
 * Central registry that merges light entities from multiple sources (Foundry + MapShine).
 *
 * This is a data-layer abstraction only. Rendering is still owned by the consumer
 * (currently LightingEffect uses ThreeLightSource / ThreeDarknessSource).
 */

/** @typedef {'foundry'|'mapshine'} LightSourceType */

/**
 * @typedef {Object} LightEntityTransform
 * @property {number} x - Foundry world X (pixels)
 * @property {number} y - Foundry world Y (pixels)
 * @property {number} [z] - Optional elevation/height (scene units or pixels depending on consumer)
 */

/**
 * @typedef {Object} LightEntityPhotometry
 * @property {number} dim - Dim radius (scene distance units)
 * @property {number} bright - Bright radius (scene distance units)
 * @property {number} [attenuation] - 0..1 softness-ish parameter (Foundry-style)
 * @property {number} [alpha] - 0..1 intensity/opacity multiplier (Foundry-style)
 * @property {number} [luminosity] - 0..1 brightness bias (Foundry-style)
 */

/**
 * @typedef {Object} LightEntityAnimation
 * @property {string} [type] - Animation id (Foundry animation key or MapShine custom id)
 * @property {number} [speed]
 * @property {number} [intensity]
 */

/**
 * @typedef {Object} ILightEntity
 * @property {string} id
 * @property {LightSourceType} sourceType
 * @property {boolean} enabled
 * @property {boolean} isDarkness
 * @property {LightEntityTransform} transform
 * @property {string|number|{r:number,g:number,b:number}} [color]
 * @property {LightEntityPhotometry} photometry
 * @property {LightEntityAnimation} [animation]
 * @property {boolean} isStatic
 * @property {number} [activationRange]
 * @property {number} [zMin]
 * @property {number} [zMax]
 * @property {boolean} castShadows
 * @property {'hard'|'soft'} [shadowQuality]
 * @property {any} [raw] - Original backing data (e.g. Foundry document object)
 */

export class LightRegistry {
  constructor() {
    /** @type {Map<string, ILightEntity>} */
    this.foundryLights = new Map();

    /** @type {Map<string, ILightEntity>} */
    this.foundryDarkness = new Map();

    /** @type {Map<string, ILightEntity>} */
    this.mapshineLights = new Map();

    /** @type {number} */
    this.version = 0;
  }

  /**
   * @param {any} doc - AmbientLightDocument-like object (or merged object)
   * @returns {ILightEntity}
   */
  static fromFoundryAmbientLightDoc(doc) {
    const config = doc?.config ?? {};
    const isNegative = (config?.negative === true) || (doc?.negative === true);

    return {
      id: String(doc?.id ?? ''),
      sourceType: 'foundry',
      enabled: (doc?.hidden === true) ? false : true,
      isDarkness: isNegative,
      transform: {
        x: Number(doc?.x ?? 0),
        y: Number(doc?.y ?? 0)
      },
      color: config?.color,
      photometry: {
        dim: Number(config?.dim ?? 0),
        bright: Number(config?.bright ?? 0),
        attenuation: Number.isFinite(config?.attenuation) ? config.attenuation : undefined,
        alpha: Number.isFinite(config?.alpha) ? config.alpha : undefined,
        luminosity: Number.isFinite(config?.luminosity) ? config.luminosity : undefined
      },
      animation: (config?.animation && typeof config.animation === 'object')
        ? {
            type: config.animation.type,
            speed: config.animation.speed,
            intensity: config.animation.intensity
          }
        : undefined,
      // Defaults from plan
      isStatic: false,
      activationRange: undefined,
      zMin: undefined,
      zMax: undefined,
      castShadows: false,
      shadowQuality: undefined,
      raw: doc
    };
  }

  /**
   * Update or insert an entity coming from Foundry.
   * @param {ILightEntity} entity
   */
  upsertFoundryEntity(entity) {
    if (!entity?.id) return;

    if (entity.isDarkness) {
      this.foundryDarkness.set(entity.id, entity);
      this.foundryLights.delete(entity.id);
    } else {
      this.foundryLights.set(entity.id, entity);
      this.foundryDarkness.delete(entity.id);
    }

    this.version++;
  }

  /**
   * Remove an entity by id (both light + darkness buckets).
   * @param {string} id
   */
  removeFoundryEntity(id) {
    if (!id) return;
    this.foundryLights.delete(id);
    this.foundryDarkness.delete(id);
    this.version++;
  }

  /**
   * Replace the MapShine-native light set.
   * @param {ILightEntity[]} entities
   */
  setMapshineEntities(entities) {
    this.mapshineLights.clear();
    if (Array.isArray(entities)) {
      for (const e of entities) {
        if (!e?.id) continue;
        this.mapshineLights.set(String(e.id), e);
      }
    }
    this.version++;
  }

  /**
   * @returns {ILightEntity[]}
   */
  getAllLightEntities() {
    return [
      ...this.foundryLights.values(),
      ...this.foundryDarkness.values(),
      ...this.mapshineLights.values()
    ];
  }
}
