/**
 * @fileoverview Mask catalog — single source of truth for the per-level mask
 * binding system.
 *
 * The catalog has two parts:
 *
 *   1. MASK_CATALOG — declares every suffixed mask (and derived masks such as
 *      `skyReach`) that the pipeline knows about. Entries with `derived: true`
 *      have no authored file on disk and are computed from other masks.
 *
 *   2. CONSUMER_CATALOG — declares every effect/subsystem that reads masks,
 *      the field each mask is stored under on the effect instance, and — for
 *      the `outdoors` slot specifically — whether the consumer wants the
 *      authored surface `_Outdoors` or the derived `skyReach` (which is
 *      `_Outdoors ∧ ¬upperFloorAlphas`).
 *
 * The catalog is used by:
 *   - GpuSceneMaskCompositor to know which suffixes to compose per floor, and
 *     when to derive `skyReach` from authored masks + floor alphas.
 *   - MaskBindingController to fan out per-floor bundles to each consumer,
 *     resolving the correct outdoors variant (surface vs sky-reach) and
 *     choosing between single-texture and banded-array binding paths.
 *   - Diagnostics helpers so a single probe can report what each consumer
 *     currently has bound for every visible level.
 *
 * Adding a new mask suffix is a single-line change here plus the authoring
 * pipeline; adding a new consumer is a single entry in CONSUMER_CATALOG.
 *
 * @module masks/mask-catalog
 */

/**
 * Purpose tokens for the `outdoors` family. Consumers opt into one of these.
 *
 *   - 'surface' : authored `_Outdoors_N` texture. Use for surface-semantic
 *                 decisions (water bodies, rainy puddles, specular on outdoor
 *                 surfaces, building/overhead shadow gating).
 *   - 'sky'     : derived `skyReach_N` texture — `outdoors_N ∧ ¬upperAlphas`.
 *                 Use for "is the sky reaching this pixel" decisions (cloud
 *                 shadows, sky color grade, fog, rain/snow/ash spawners).
 *
 * @typedef {'surface'|'sky'} OutdoorsPurpose
 */

/**
 * @typedef {Object} MaskCatalogEntry
 * @property {string|null} suffix  File suffix (null for derived masks).
 * @property {boolean} perFloor    Whether this mask is composed per floor.
 * @property {boolean} derived     True if computed at runtime from other masks.
 * @property {boolean} [internal]  True if not user-facing (e.g. floorAlpha).
 * @property {string[]} [purposes] Optional semantic tags for consumers.
 * @property {string} [description]
 */

/**
 * Every mask the runtime knows about. Kept in sync with
 * {@link module:assets/loader.getEffectMaskRegistry} by the loader module.
 *
 * @type {Record<string, MaskCatalogEntry>}
 */
export const MASK_CATALOG = Object.freeze({
  // Authored, per-floor surface masks ------------------------------------
  outdoors:    { suffix: '_Outdoors',    perFloor: true,  derived: false, purposes: ['surface'], description: 'Indoor/outdoor area mask (authored per floor as _Outdoors_N)' },
  specular:    { suffix: '_Specular',    perFloor: true,  derived: false, description: 'Specular highlights mask' },
  roughness:   { suffix: '_Roughness',   perFloor: true,  derived: false, description: 'Roughness/smoothness map' },
  normal:      { suffix: '_Normal',      perFloor: true,  derived: false, description: 'Normal map for lighting detail' },
  water:       { suffix: '_Water',       perFloor: true,  derived: false, description: 'Water depth mask' },
  fire:        { suffix: '_Fire',        perFloor: true,  derived: false, description: 'Fire source mask' },
  windows:     { suffix: '_Windows',     perFloor: true,  derived: false, description: 'Window light mask' },
  structural:  { suffix: '_Structural',  perFloor: true,  derived: false, description: 'Structural/legacy window mask' },
  iridescence: { suffix: '_Iridescence', perFloor: true,  derived: false, description: 'Iridescence effect mask' },
  prism:       { suffix: '_Prism',       perFloor: true,  derived: false, description: 'Prism/refraction mask' },
  tree:        { suffix: '_Tree',        perFloor: true,  derived: false, description: 'Animated tree canopy mask' },
  bush:        { suffix: '_Bush',        perFloor: true,  derived: false, description: 'Animated bush mask' },
  fluid:       { suffix: '_Fluid',       perFloor: true,  derived: false, description: 'Fluid flow data mask' },
  dust:        { suffix: '_Dust',        perFloor: true,  derived: false, description: 'Dust motes mask' },
  ash:         { suffix: '_Ash',         perFloor: true,  derived: false, description: 'Ash disturbance mask' },

  // Derived per-floor masks ----------------------------------------------
  floorAlpha:  { suffix: null, perFloor: true, derived: true, internal: true, description: 'Per-floor albedo alpha composed from tile textures (world-space, used to derive skyReach and for overhead occluder passes).' },
  skyReach:    { suffix: null, perFloor: true, derived: true, purposes: ['sky'], description: 'Per-floor outdoors ∧ ¬(union of upper-floor alphas). 1.0 = sky can reach this pixel on that floor; 0.0 = occluded by something above.' },
});

/**
 * @typedef {Object} ConsumerBinding
 * @property {string} consumes
 *   Suffix key this binding reads from (e.g. 'outdoors', 'water'). For the
 *   outdoors family the {@link ConsumerBinding.outdoorsPurpose} field picks
 *   between authored surface vs derived sky-reach variants.
 * @property {OutdoorsPurpose} [outdoorsPurpose]
 *   Required when `consumes === 'outdoors'`. Selects `outdoors` vs `skyReach`.
 * @property {string} [singleField]
 *   Instance field name for the legacy single-texture setter path
 *   (e.g. '_outdoorsMask'). Optional; omit for banded-only consumers.
 * @property {string} [singleSetter]
 *   Method name for the single-texture setter (e.g. 'setOutdoorsMask').
 * @property {string} [bandedSetter]
 *   Method name for the banded-array setter (e.g. 'setOutdoorsMasks'). If
 *   provided, MaskBindingController prefers banded binding in multi-floor
 *   scenes.
 * @property {string} [floorIdSetter]
 *   Method name to push the floor-id texture (banded consumers only).
 * @property {number} [bandedSlots]
 *   Number of banded slots the consumer accepts. Defaults to 4 if omitted.
 */

/**
 * @typedef {Object} ConsumerCatalogEntry
 * @property {string} path
 *   Dotted path under FloorCompositor where the effect instance lives
 *   (e.g. `_cloudEffect`, `_waterEffect`).
 * @property {string} location
 *   Resolution scope: 'floorCompositor' (default), 'weatherController',
 *   'global' (read from a module-level singleton via path-less lookup).
 * @property {boolean} [optional]
 *   If true, missing consumer is not an error.
 * @property {ConsumerBinding[]} bindings
 *   One binding per mask type the consumer reads.
 */

/**
 * Every consumer that pulls a mask from the fan-out controller.
 *
 * Keep this list in lockstep with the setter APIs on the individual effect
 * classes. The controller reflects the `path` on `FloorCompositor` and looks
 * up `singleSetter` / `bandedSetter` dynamically, so adding a new consumer
 * means:
 *
 *   1. Add a `setXxxMask`/`setXxxMasks` method on the effect (or reuse an
 *      existing one).
 *   2. Register it here with the mask ids it reads.
 *
 * @type {Record<string, ConsumerCatalogEntry>}
 */
export const CONSUMER_CATALOG = Object.freeze({
  cloud: {
    path: '_cloudEffect',
    location: 'floorCompositor',
    bindings: [
      {
        consumes: 'outdoors',
        outdoorsPurpose: 'sky',
        singleField: '_outdoorsMask',
        singleSetter: 'setOutdoorsMask',
        bandedSetter: 'setOutdoorsMasks',
        floorIdSetter: 'setFloorIdTexture',
        bandedSlots: 4,
      },
    ],
  },

  water: {
    path: '_waterEffect',
    location: 'floorCompositor',
    bindings: [
      {
        consumes: 'outdoors',
        outdoorsPurpose: 'sky',
        singleField: '_outdoorsMask',
        singleSetter: 'setOutdoorsMask',
      },
    ],
  },

  sky: {
    path: '_skyColorEffect',
    location: 'floorCompositor',
    bindings: [
      {
        consumes: 'outdoors',
        outdoorsPurpose: 'sky',
        singleField: '_outdoorsMask',
        singleSetter: 'setOutdoorsMask',
      },
    ],
  },

  fog: {
    path: '_atmosphericFogEffect',
    location: 'floorCompositor',
    bindings: [
      {
        consumes: 'outdoors',
        outdoorsPurpose: 'sky',
        singleField: 'outdoorsMask',
        singleSetter: 'setOutdoorsMask',
      },
    ],
  },

  filter: {
    path: '_filterEffect',
    location: 'floorCompositor',
    bindings: [
      {
        consumes: 'outdoors',
        outdoorsPurpose: 'surface',
        singleField: '_outdoorsMask',
        singleSetter: 'setOutdoorsMask',
      },
    ],
  },

  overheadShadow: {
    path: '_overheadShadowEffect',
    location: 'floorCompositor',
    bindings: [
      {
        consumes: 'outdoors',
        outdoorsPurpose: 'surface',
        singleSetter: 'setOutdoorsMask',
      },
    ],
  },

  buildingShadow: {
    path: '_buildingShadowEffect',
    location: 'floorCompositor',
    bindings: [
      {
        consumes: 'outdoors',
        outdoorsPurpose: 'surface',
        singleSetter: 'setOutdoorsMask',
      },
    ],
  },

  weather: {
    path: 'weatherController',
    location: 'global',
    optional: true,
    bindings: [
      {
        consumes: 'outdoors',
        outdoorsPurpose: 'sky',
        singleSetter: 'setRoofMap',
      },
    ],
  },
});

/**
 * Helper: return the MASK_CATALOG entry for an outdoors binding, resolved to
 * either 'outdoors' (surface) or 'skyReach' (derived) based on purpose.
 *
 * @param {OutdoorsPurpose} purpose
 * @returns {'outdoors'|'skyReach'}
 */
export function resolveOutdoorsVariant(purpose) {
  return purpose === 'sky' ? 'skyReach' : 'outdoors';
}

/**
 * Helper: enumerate the mask ids this consumer entry depends on, after
 * resolving outdoors purpose. Used by MaskBindingController to build binding
 * signatures.
 *
 * @param {ConsumerCatalogEntry} entry
 * @returns {string[]}
 */
export function listConsumerMaskIds(entry) {
  const out = [];
  for (const b of entry.bindings) {
    if (b.consumes === 'outdoors') {
      out.push(resolveOutdoorsVariant(b.outdoorsPurpose ?? 'surface'));
    } else {
      out.push(b.consumes);
    }
  }
  return out;
}

/**
 * List of mask ids that are per-floor composable (for iteration by
 * GpuSceneMaskCompositor and the controller).
 *
 * @returns {string[]}
 */
export function listPerFloorMaskIds() {
  return Object.entries(MASK_CATALOG)
    .filter(([, entry]) => entry.perFloor)
    .map(([id]) => id);
}

/**
 * List of authored (non-derived) mask ids.
 *
 * @returns {string[]}
 */
export function listAuthoredMaskIds() {
  return Object.entries(MASK_CATALOG)
    .filter(([, entry]) => entry.perFloor && !entry.derived)
    .map(([id]) => id);
}

/**
 * List of derived mask ids.
 *
 * @returns {string[]}
 */
export function listDerivedMaskIds() {
  return Object.entries(MASK_CATALOG)
    .filter(([, entry]) => entry.derived)
    .map(([id]) => id);
}
