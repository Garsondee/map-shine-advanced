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

import { SUN_SHADOW_DEBUG_VIEWS } from './lighting/sun-shadow-debug.js';

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
  debugView: {
    // THE DIAGNOSIS CONTROL (author, 2026-07-26: "a dropdown in the ROH
    // controls, allowing me to see just a single shadow at a time out of the
    // whole system… on a white background… you can also put debug things into
    // that list so that I can help tell you if an intermediate texture is
    // actually broken").
    //
    // ⚠️ REPLACED the three `showBuilding`/`showOverhead`/`showSkyReach` bools.
    // Their own help text already began "Diagnosis:", and two controls that
    // isolate the same three producers is how they end up disagreeing about
    // which one is on (feedback_debug_ui_one_action_one_control). The isolating
    // views set the SAME derivation includes those bools set, so nothing was
    // lost — one control now owns the whole question.
    type: 'enum',
    // DERIVED from the debug module, never re-typed: that file decides what
    // each view actually shows, so a hand-copied list here could offer a view
    // the renderer does not have (or hide one it does).
    values: SUN_SHADOW_DEBUG_VIEWS.map((v) => v.id),
    valueLabels: Object.fromEntries(SUN_SHADOW_DEBUG_VIEWS.map((v) => [v.id, v.label])),
    default: 'off',
    category: 'Technical',
    label: 'Debug view',
    help: 'Diagnosis. Shows one shadow at a time, or one of the raw data layers, as greyscale on white — white = lit or present, black = shadowed or absent. Compare "occluder coverage" against "occluder height": a shape visible in coverage but BLACK in height means the things overhead exist but have no height recorded, which is why they cast nothing.',
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
  // ⚠️ `low` TURNS THIS OFF ENTIRELY (2026-07-29, author: "the lowest
  // performance tier should turn shadows off and remove the performance
  // cost"). This is the profile GATE — the WHETHER — and it is deliberately
  // separate from the tier ladder below, which only ever answers HOW MUCH.
  // Below `performance` the subsystem drops its caster field, collapses
  // `scene.sunShadow` to 1×1 and stops marching altogether
  // (`sun-shadow-subsystem.js`'s `dropCasterField`), so "off" is genuinely no
  // work rather than a full-resolution march that writes white.
  //
  // Everything at `performance` and above is still default-on
  // (feedback_default_on_new_features): the per-frame cost is one texture fetch
  // in a pass that already runs, and the expensive part is a bake that happens
  // a few times a minute.
  enabledFromProfile: 'performance',
  params: SUN_SHADOW_PARAMS,
  // ============================================================================
  // THE LADDER (built 2026-07-29). The arithmetic is `sun-occlusion.js`'s
  // `SUN_SHADOW_TIER_PLANS`, index-aligned with this list; THIS is the prose.
  // ============================================================================
  //
  // Every rung buys the SAME picture drawn more finely — there is no rung that
  // introduces a new visual feature, because this effect has exactly one
  // (a marched height field) and three producers already feed it. So the rungs
  // are the three build-time numbers the march is compiled from, plus how often
  // it re-runs; `sun-occlusion.js`'s ladder header says what each one is for.
  //
  // ⚠️ `estMsPerMp` IS THE SAME AT EVERY RUNG, AND THAT IS NOT AN OVERSIGHT.
  // It declares the STEADY per-megapixel cost, which for this effect is one
  // texture fetch in the ambient fill — identical whether the field behind it is
  // 512² or 1280². What the ladder actually spends is BAKE time, which is sparse
  // and which `perf-report.js` correctly refuses to grade against a per-pixel
  // budget ("an all-bake effect is not graded against a declared per-pixel
  // budget"). The bake's cost gradient lives where it can be counted rather than
  // guessed: `sunShadowBakeSamples`, reported live in the `sun-shadows` status.
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'coarse-march',
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.05 }),
      adds:
        'buildings, overhead tiles and upper floors all cast one set of smeared shadows onto the ' +
        'outdoors — marched 1:1 with the caster grid, as a single ray, so the shadows land correctly ' +
        'but their side edges are as crisp as the mask underneath them',
    }),
    Object.freeze({
      n: 1,
      name: 'soft-cone',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.05 }),
      adds:
        "the march widens into a 3-tap cone and the field doubles — a silhouette's side edges now " +
        'soften and spread with distance instead of staying pixel-perfect lines (the ORIGINAL shipped look)',
    }),
    Object.freeze({
      n: 2,
      name: 'wide-cone',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.05 }),
      adds:
        'a 5-tap cone and a finer march — visibly smoother silhouette edges and a cleaner fade at the ' +
        'shadow tip, for roughly twice the bake',
    }),
    Object.freeze({
      n: 3,
      name: 'fine-cone',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.05 }),
      adds:
        'the widest cone this system draws (7 taps) over a supersampled field, re-marched on a finer ' +
        'sun step so the shadows SWEEP with the hour instead of stepping — roughly five times the bake',
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
