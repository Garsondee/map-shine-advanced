/**
 * SUN SHADOWS — building, overhead and sky-reach, declared as data.
 *
 * The runtime is `effects/lighting/sun-occlusion.js` (the march's maths),
 * `sun-occlusion-render.js` (its TSL) and `sun-shadow-subsystem.js` (the bake
 * + the rebake decision + the ambient multiply's shared texture); THIS file
 * is the effect's DECLARATION — the params schema and
 * the manifest the registry, the settings cascade and the generated FOH/ROH card
 * read. Same split as `effects/ui-window-shadow.js`, and for the same reason:
 * the manifest is pure data with no `apply` and no field name, so nothing can
 * special-case this effect by id (Effect-Registration.md §6).
 *
 * ============================================================================
 * NINE PARAMS, WHERE V2 HAD ABOUT THIRTY
 * ============================================================================
 *
 * V2 shipped `BuildingShadowsEffectV2`, `SkyReachShadowsEffectV2` and
 * `OverheadStampEffectV2` — three systems, 7,763 lines, each with its own
 * `length`, `softness`, `smear`, `penumbra`, `shadowCurve`, `blurRadius`,
 * `resolutionScale` and per-source `opacity`, all tuned against one another
 * through a shared combine. Nothing in the scene agreed about where the sun was.
 *
 * There is no length knob here, no smear knob, no curve, no per-source opacity.
 * Those are not omissions:
 *
 *   LENGTH   is `height / tan(elevation)` — it comes out of the march.
 *   SMEAR    is what a march IS (the union of the silhouette along the ray).
 *   SOFTNESS contact-hardens with distance, and cloud/night scale it through the
 *            SHARED `effects/shadow-access.js` handle, which every other caster
 *            in the scene reads too.
 *   HEIGHT   for overhead tiles and upper floors comes from Foundry's own
 *            elevation data. Only the building height has no source in the
 *            document, so it is the only height with a slider.
 *
 * `softnessBias` is the one deliberate exception, and it is a BIAS on the shared
 * atmospheric model rather than a second model — the difference that keeps this
 * from being V2's first extra knob.
 *
 * @module effects/sun-shadows
 */

/** @type {Record<string, object>} */
export const SUN_SHADOW_PARAMS = Object.freeze({
  strength01: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    category: 'Look',
    label: 'Shadow strength',
    help: 'How dark a fully-shadowed patch of ground goes. Torches and other lights still light it back up — the sun is the only thing this darkens.',
  },
  buildingHeightPx: {
    type: 'float',
    min: 0,
    max: 1200,
    step: 10,
    default: 260,
    category: 'Look',
    label: 'Building height',
    help: 'How tall the buildings are — the dark, indoor parts of your outdoors mask. The one height with no source in the scene data, so the one you set by hand.',
  },
  dawnDuskLength: {
    // THE DAWN/DUSK CONTROL (author, 2026-07-24: "the number one most important
    // control is going to be a single control for shadow offset at dawn /
    // dusk"). A cap on how many times its own height a shadow may stretch — it
    // only bites at low sun, where 1/tan(elevation) runs away toward the
    // horizon. Lower = shorter dusk shadows.
    type: 'float',
    min: 0.5,
    max: 12,
    step: 0.25,
    default: 4,
    category: 'Look',
    label: 'Dawn/dusk length',
    help: 'The furthest a shadow can stretch at dawn or dusk, as a multiple of the thing casting it. Lower = shorter, less exaggerated low-sun shadows. This is the main knob for taming long evening shadows.',
  },
  lengthScale: {
    // GLOBAL length multiplier (author: "make the shadows a lot shorter, 1/2 of
    // what it is right now"). Default 0.5 halves every shadow at every hour.
    type: 'float',
    min: 0.1,
    max: 2,
    step: 0.05,
    default: 0.5,
    category: 'Look',
    label: 'Shadow length',
    help: 'Scales the length of every shadow at every time of day. 0.5 = half as long. Use the Dawn/dusk knob above to tame just the long evening ones.',
  },
  skyOcclusion: {
    // THE "UNDER A BRIDGE IS DARK" CONTROL (author, 2026-07-25: "using their
    // opaque sections to block light from getting to bits of the scene below
    // that point"). Independent of sun angle — this is how much SKY the ground
    // can see, not where the sun happens to be. The directional march cannot
    // supply it: a 10ft bridge at noon throws its ray-shadow barely past its
    // own footprint.
    // ⚠️ DEFAULT LOWERED 0.65 → 0.25 (2026-07-25, author: "still just a mess").
    // It MULTIPLIES with whatever else darkens a pixel: on their bridge map the
    // ground floor already sits under a 0.5 darkness Region, so 0.65 here gave
    // 0.5 × 0.35 = ×0.17 ambient — effectively black, in hard blobs the shape of
    // every crate and plank on the floor above. A term that compounds with
    // other darkeners must start conservative and be dialled UP by eye.
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.25,
    category: 'Look',
    label: 'Under-cover shade',
    help: 'How much darker a spot gets simply for having something solid overhead — under a bridge, a walkway, an upper floor. Independent of the time of day. Compounds with any darkness Region already covering the area, so raise it gently.',
  },
  softnessBias: {
    type: 'float',
    min: 0.25,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Softness',
    help: 'Nudges every cast shadow softer or crisper. Cloud, night and the sun angle already drive this on their own; use it to taste, not to compensate.',
  },
  edgeBandPx: {
    type: 'float',
    min: 0,
    max: 2000,
    step: 32,
    default: 384,
    category: 'Extent',
    label: 'Map-edge fade',
    help: 'How wide a band at the edge of the map the shadows fade out over. Stops a hard line appearing where the scene ends and the shadows simply stop.',
  },
  showBuilding: {
    type: 'bool',
    default: true,
    category: 'Technical',
    label: 'Include building shadows',
    help: 'Diagnosis: turn off to see the scene without the shadows cast by the indoor (dark) parts of the outdoors mask.',
  },
  showOverhead: {
    type: 'bool',
    default: true,
    category: 'Technical',
    label: 'Include overhead shadows',
    help: 'Diagnosis: turn off to see the scene without the shadows cast by raised tiles on this floor (balconies, awnings, walkways).',
  },
  showSkyReach: {
    type: 'bool',
    default: true,
    category: 'Technical',
    label: 'Include sky-reach shadows',
    help: 'Diagnosis: turn off to see the scene without the shadows cast down from the floors above (a bridge deck, the roofs above it).',
  },
});

/**
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const SUN_SHADOWS = Object.freeze({
  id: 'sunShadows',
  title: 'Sun shadows',
  // Structural, not decorative: buildings without shadows read as flat paint,
  // so this is one of the last things that should be dropped for frame budget.
  visualWeight: 0.85,
  a11y: Object.freeze({ photosensitive: false }),
  // Default-on (feedback_default_on_new_features). It costs one texture fetch
  // per frame in a pass that already runs; the expensive part is a bake that
  // happens a few times a minute.
  enabledFromProfile: 'low',
  params: SUN_SHADOW_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'one-field-one-march',
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.05 }),
      adds: 'buildings, overhead tiles and upper floors all cast one set of smeared shadows onto the outdoors',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'authored-shadow-mask',
      note: "min-combine the hand-painted shadow mask (the catalog's `shadow` kind) into the same visibility field — the artist's own layer, promoted to the highest-authority producer (Light-and-Shadow.md §4.2)",
    }),
    Object.freeze({
      name: 'painted-height-mask',
      note: 'a `_Height` mask so a GM can author per-building heights instead of one global number — the last hand-set value in the system',
    }),
    Object.freeze({
      name: 'cloud-shadows',
      note: 'weather cloud cover as a fourth producer into the same height field, drifting with the wind',
    }),
    Object.freeze({
      name: 'lightning-reuse',
      note: 'a lightning flash is the same field marched from a different direction for one frame — free, and the one thing V2 got right here',
    }),
  ]),
});
