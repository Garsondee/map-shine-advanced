/**
 * @fileoverview **V3 Mask Catalog — single source of truth.**
 *
 * This module is the authoritative declaration of every mask V3 knows about
 * (authored and derived) and every consumer that reads one. It is modeled on
 * `v13_module/scripts/masks/mask-catalog.js` but tightened for the V3 mini
 * stack: one declaration per mask id, one entry per consumer, with helpers
 * that the hub + binding controller + inspector all consume.
 *
 * Architectural contract:
 *
 *   - Authored masks have a `suffix` and live on disk next to each floor's
 *     background image (e.g. `scene/map_Outdoors.webp`).
 *   - Derived masks (`floorAlpha`, `skyReach`) have `suffix: null`; they are
 *     computed at runtime by the hub from other masks / albedo slots.
 *   - Every mask declares a `composeMode` ('source-over' | 'lighten') and a
 *     `debugChannel` so every consumer (runtime + inspector) uses the same
 *     sampling convention.
 *   - Every consumer declares how it wants to be bound (single setter vs
 *     banded array + floor id) and — for the outdoors family — whether it
 *     wants the surface `outdoors` or the derived `skyReach`.
 *
 * Adding a mask or consumer is a **one-file change** here plus (optionally)
 * the authoring pipeline and/or the effect implementation.
 *
 * @module v3/V3MaskCatalog
 */

/**
 * Purpose tokens for the `outdoors` family. Consumers opt into one of these.
 *
 *   - 'surface' : authored `_Outdoors` texture for that floor. Use for
 *                 surface-semantic decisions (water bodies, puddles, specular
 *                 on outdoor surfaces, building/overhead shadow gating).
 *   - 'sky'     : derived `skyReach` texture — `outdoors ∧ ¬upperAlphas`. Use
 *                 for "is the sky reaching this pixel" decisions (cloud
 *                 shadows, sky color grade, fog, rain / snow spawners).
 *
 * @typedef {'surface'|'sky'} OutdoorsPurpose
 */

/**
 * @typedef {'source-over'|'lighten'} MaskComposeMode
 *   - 'source-over': later tiles replace earlier (outdoors, windows, normal maps).
 *   - 'lighten'    : MAX blend across tiles (fire, water depth, dust, ash).
 */

/**
 * @typedef {Object} MaskCatalogEntry
 * @property {string|null} suffix           File suffix (null for derived masks).
 * @property {boolean} perFloor             Per-floor vs scene-wide.
 * @property {boolean} derived              True if computed at runtime.
 * @property {boolean} [internal]           Not user-facing in the inspector.
 * @property {MaskComposeMode} composeMode  Tile → scene composition rule.
 * @property {'rgba'|'r'|'a'} debugChannel  Which channel carries signal.
 * @property {string[]} [dependencies]      Derived-only: other mask ids required.
 * @property {string[]} [purposes]          Optional semantic tags.
 * @property {string} [description]
 */

/**
 * Every mask the V3 runtime knows about.
 *
 * **Do not** add suffixed `_Outdoors_0` / `_Outdoors_1` variants here — the
 * hub discovers authored files **per floor** using each floor's background
 * base path. One catalog entry ⇒ one mask id per floor.
 *
 * @type {Readonly<Record<string, MaskCatalogEntry>>}
 */
export const V3_MASK_CATALOG = Object.freeze({
  // Authored, per-floor surface masks --------------------------------------
  outdoors: {
    suffix: "_Outdoors",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "r",
    purposes: ["surface"],
    description:
      "Indoor/outdoor area mask (authored per floor on disk). With two levels and a non-ground viewed floor, the hub’s default surface texture is the same **stack matte** as other suffixed masks (lower+upper `_Outdoors` mixed by upper albedo alpha).",
  },
  specular: {
    suffix: "_Specular",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "r",
    description: "Specular highlights mask.",
  },
  roughness: {
    suffix: "_Roughness",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "r",
    description: "Roughness/smoothness map.",
  },
  normal: {
    suffix: "_Normal",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "rgba",
    description: "Normal map for lighting detail.",
  },
  fire: {
    suffix: "_Fire",
    perFloor: true,
    derived: false,
    composeMode: "lighten",
    debugChannel: "r",
    description: "Fire source mask.",
  },
  ash: {
    suffix: "_Ash",
    perFloor: true,
    derived: false,
    composeMode: "lighten",
    debugChannel: "r",
    description: "Ash disturbance mask.",
  },
  dust: {
    suffix: "_Dust",
    perFloor: true,
    derived: false,
    composeMode: "lighten",
    debugChannel: "r",
    description: "Dust motes mask.",
  },
  iridescence: {
    suffix: "_Iridescence",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "rgba",
    description: "Iridescence effect mask.",
  },
  fluid: {
    suffix: "_Fluid",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "r",
    description: "Fluid flow data mask.",
  },
  prism: {
    suffix: "_Prism",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "rgba",
    description: "Prism/refraction mask.",
  },
  windows: {
    suffix: "_Windows",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "r",
    description: "Window lighting mask.",
  },
  structural: {
    suffix: "_Structural",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "r",
    description: "Structural (legacy window) mask.",
  },
  bush: {
    suffix: "_Bush",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "rgba",
    description: "Animated bush mask (RGBA with transparency).",
  },
  tree: {
    suffix: "_Tree",
    perFloor: true,
    derived: false,
    composeMode: "source-over",
    debugChannel: "rgba",
    description: "Animated tree canopy (RGBA with transparency).",
  },
  water: {
    suffix: "_Water",
    perFloor: true,
    derived: false,
    composeMode: "lighten",
    debugChannel: "r",
    description:
      "Water depth mask (data). Uses the same two-floor **stack matte** as `_Outdoors` when the upper layer is visible (see hub `authoredOnly` / Tweakpane “match viewed floor”).",
  },

  // Derived per-floor masks -----------------------------------------------
  floorAlpha: {
    suffix: null,
    perFloor: true,
    derived: true,
    internal: true,
    composeMode: "source-over",
    debugChannel: "a",
    dependencies: [],
    description:
      "Per-floor albedo alpha. In V3 mini this is the albedo alpha of the floor's background texture — used as the matte/overhead source for skyReach and any future occluder passes.",
  },
  skyReach: {
    suffix: null,
    perFloor: true,
    derived: true,
    composeMode: "source-over",
    debugChannel: "r",
    dependencies: ["outdoors", "floorAlpha"],
    purposes: ["sky"],
    description:
      "Per-floor sky visibility in map UVs: base is outdoors × Π_j (1 − α_j) for all levels j strictly above. Floors with an index > 0 are then mattes over the previous floor's skyReach with this floor's albedo alpha (same as outdoors stack), so α=0 shows the level below.",
  },
});

/**
 * @typedef {Object} ConsumerBinding
 * @property {string} consumes            Mask id or 'outdoors' (+ purpose).
 * @property {OutdoorsPurpose} [outdoorsPurpose]
 *   Required when `consumes === 'outdoors'`. Selects `outdoors` vs `skyReach`.
 * @property {string} [singleField]       Instance field name for fall-backs.
 * @property {string} [singleSetter]      Method name for single-texture setter.
 * @property {string} [bandedSetter]      Method name for banded-array setter.
 * @property {string} [floorIdSetter]     Method name that accepts the floorId texture.
 * @property {number} [bandedSlots]       Banded length (defaults to 4).
 */

/**
 * @typedef {Object} ConsumerCatalogEntry
 * @property {string} description         Human-readable purpose.
 * @property {boolean} [optional]         Missing consumer is not an error.
 * @property {ConsumerBinding[]} bindings One per mask slot the consumer reads.
 */

/**
 * Static registry of **potential** consumers; concrete instances are
 * registered at runtime with the binding controller. Empty today (V3 has no
 * effects shipped yet) but mirrors the v13 surface so effects can be ported
 * one catalog entry at a time.
 *
 * @type {Readonly<Record<string, ConsumerCatalogEntry>>}
 */
export const V3_CONSUMER_CATALOG = Object.freeze({
  // Placeholders — each will materialize as its effect is ported to V3.
  // cloud: {
  //   description: "Cloud shadows / sky tint — uses derived skyReach.",
  //   bindings: [{
  //     consumes: "outdoors",
  //     outdoorsPurpose: "sky",
  //     singleSetter: "setOutdoorsMask",
  //     bandedSetter: "setOutdoorsMasks",
  //     floorIdSetter: "setFloorIdTexture",
  //     bandedSlots: 4,
  //   }],
  // },
});

/**
 * Map an outdoors purpose to the **actual mask id** the hub should return.
 *
 * @param {OutdoorsPurpose} [purpose]
 * @returns {'outdoors'|'skyReach'}
 */
export function resolveOutdoorsVariant(purpose) {
  return purpose === "sky" ? "skyReach" : "outdoors";
}

/**
 * Enumerate the mask ids a consumer actually needs, after outdoors purpose
 * resolution. Used by the binding controller to build change signatures.
 *
 * @param {ConsumerCatalogEntry} entry
 * @returns {string[]}
 */
export function listConsumerMaskIds(entry) {
  const out = [];
  if (!entry?.bindings) return out;
  for (const b of entry.bindings) {
    if (b.consumes === "outdoors") {
      out.push(resolveOutdoorsVariant(b.outdoorsPurpose ?? "surface"));
    } else if (typeof b.consumes === "string" && b.consumes.length) {
      out.push(b.consumes);
    }
  }
  return out;
}

/** @returns {string[]} Every mask id, stable-ordered. */
export function listAllMaskIds() {
  return Object.keys(V3_MASK_CATALOG);
}

/** @returns {string[]} Authored (file-backed) per-floor mask ids. */
export function listAuthoredMaskIds() {
  return Object.entries(V3_MASK_CATALOG)
    .filter(([, e]) => e.perFloor && !e.derived && e.suffix)
    .map(([id]) => id);
}

/** @returns {string[]} Derived (runtime-computed) mask ids. */
export function listDerivedMaskIds() {
  return Object.entries(V3_MASK_CATALOG)
    .filter(([, e]) => e.derived)
    .map(([id]) => id);
}

/** @returns {string[]} Per-floor mask ids (authored + derived). */
export function listPerFloorMaskIds() {
  return Object.entries(V3_MASK_CATALOG)
    .filter(([, e]) => e.perFloor)
    .map(([id]) => id);
}

/**
 * Lookup a mask entry.
 *
 * @param {string} maskId
 * @returns {MaskCatalogEntry|null}
 */
export function getMaskEntry(maskId) {
  return V3_MASK_CATALOG[maskId] ?? null;
}

/**
 * Lookup a consumer entry.
 *
 * @param {string} consumerId
 * @returns {ConsumerCatalogEntry|null}
 */
export function getConsumerEntry(consumerId) {
  return V3_CONSUMER_CATALOG[consumerId] ?? null;
}

/**
 * Topologically sort derived mask ids so dependencies come first.
 *
 * @returns {string[]}
 */
export function listDerivedMaskIdsInOrder() {
  const ids = listDerivedMaskIds();
  const done = new Set();
  const out = [];
  const visit = (id) => {
    if (done.has(id)) return;
    const entry = V3_MASK_CATALOG[id];
    if (!entry) return;
    for (const dep of entry.dependencies ?? []) {
      if (V3_MASK_CATALOG[dep]?.derived && !done.has(dep)) visit(dep);
    }
    done.add(id);
    out.push(id);
  };
  for (const id of ids) visit(id);
  return out;
}
