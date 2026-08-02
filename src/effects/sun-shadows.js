/**
 * SUN SHADOWS — building, overhead and sky-reach, declared as data.
 *
 * The runtime is `effects/lighting/layer-smear.js` (the model's maths),
 * `layer-smear-render.js` (its TSL) and `sun-shadow-subsystem.js` (the bake
 * + the rebake decision + the ambient multiply's shared texture); THIS file
 * is the effect's DECLARATION — the params schema and
 * the manifest the registry, the settings cascade and the generated FOH/ROH card
 * read. Same split as `effects/ui-window-shadow.js`, and for the same reason:
 * the manifest is pure data with no `apply` and no field name, so nothing can
 * special-case this effect by id (Effect-Registration.md §6).
 *
 * ============================================================================
 * THE LAYER SMEAR MODEL (2026-08-02 — replaces the column march and the
 * averaged-mean smear that briefly followed it; see
 * `docs/planning/Sun-Shadows-Layer-Smear.md` for the full redesign and
 * `docs/planning/Sun-Shadows-Redesign.md` for the two attempts it retired)
 * ============================================================================
 *
 * A top-down shadow is a COMPOSITING problem, not a physics one (author,
 * 2026-08-02, after two ray-marched models each shipped a real bug: a bright
 * halo hugging every building, and a second shadow that could not compound
 * with the first). Four occluder LAYERS — this floor's walls, its overhead
 * tiles, the floor above and everything higher — each a flat silhouette
 * smeared toward the sun, combined by MULTIPLYING their transmittances
 * (independent occluders in series) rather than averaging them.
 *
 * STILL TRUE, from the model this replaces:
 *
 *   LENGTH   is `height / tan(elevation)` — it comes out of the model, per layer.
 *   SOFTNESS contact-hardens with distance, and cloud/night scale it through the
 *            SHARED `effects/shadow-access.js` handle, which every other caster
 *            in the scene reads too.
 *
 * NO LONGER TRUE, and named here rather than left for a reader to notice by
 * absence: heights for overhead tiles and the floor above were meant to come
 * from Foundry's own elevation data (the doctrine this file used to state
 * for exactly `buildingHeightPx`, its one authored exception) — that
 * derivation is not built yet, so `overheadHeightPx`/`aboveHeightPx` are
 * AUTHORED SLIDERS too, for now. A named simplification, not a silent one;
 * deriving them from real elevation data is a tracked follow-up.
 *
 * NEW: `skyReachDepthPx` — the one param the layer-smear model's own
 * compositing needs that the march never did. A directional cast-shadow march
 * has no notion of "how deep under this roof am I", only "how far have I
 * walked from its edge" — so the middle of a wide span (the deck of a bridge)
 * came out flat, same darkness as a texel one step in from the edge. This
 * dials how far that gradient reaches inward before it settles at its
 * darkest. See `layer-smear.js#isotropicDepthTerm`'s own header for the
 * mechanism (author, live: *"I'd like the middle of this sky reach bit to be
 * darkest and darker"*).
 *
 * Every OTHER number the layer-smear model needs (per-layer strength ratios,
 * the falloff curve's shape, how fast the penumbra blurs with distance) is a
 * LOOK CONSTANT in `sun-shadow-subsystem.js`, not a param here — the same
 * "not a knob" doctrine this file has always applied to length/smear/softness,
 * now applied to what the new model added. `softnessBias` remains the one
 * deliberate exception: a BIAS on the shared atmospheric model, not a second
 * one — the difference that keeps this from becoming V2's first extra knob.
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
  wallHeightPx: {
    type: 'float',
    min: 0,
    max: 1200,
    step: 10,
    default: 260,
    category: 'Look',
    label: 'Wall height',
    help: 'How tall the buildings are — the dark, indoor parts of your outdoors mask. The one height with no source in the scene data, so the one you set by hand.',
  },
  overheadHeightPx: {
    type: 'float',
    min: 0,
    max: 800,
    step: 10,
    default: 220,
    category: 'Look',
    label: 'Overhead height',
    help: 'How high overhead tiles on this floor sit above the ground — awnings, gates, walkways. Ideally this would come from each tile’s own Foundry elevation; until that lands, it is one height for all of them.',
  },
  aboveHeightPx: {
    type: 'float',
    min: 0,
    max: 1200,
    step: 10,
    default: 400,
    category: 'Look',
    label: 'Floor-above height',
    help: 'How far above this floor the next one up (and everything higher) sits. Ideally this would come from the scene’s own floor elevations; until that lands, it is one height for the whole stack above you.',
  },
  skyReachDepthPx: {
    // THE SKY-REACH GRADIENT (author, 2026-08-02, live, on the first real-map
    // render of this model: "a soft gradient for the sky reach so that it
    // gets darker as it gets further in which should make the most middle
    // section of the bridge even darker but still a little bit of light
    // should leak through"). See this file's own header for why this is a
    // real param rather than a look constant.
    type: 'float',
    min: 0,
    max: 2000,
    step: 20,
    // 700→1300 2026-08-02 — the author's own "preferred default" pass in
    // Shader Lab, live against the real Tower Bridge deck.
    default: 1300,
    category: 'Look',
    label: 'Sky-reach depth',
    help: 'How far in from the edge of whatever is above you the shadow keeps deepening before it settles at its darkest. Roughly HALF the width of your widest covered span (a bridge deck, a great hall’s roof) puts the darkest point at its middle.',
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
    // 1→0.25 (the floor) 2026-08-02 — the author's own "preferred default"
    // pass tuned Shader Lab's own softnessMul slider (no atmosphere
    // multiplier there) down to ~0.2; 0.25 is the closest this param's own
    // declared range allows.
    default: 0.25,
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
  // Below `performance` the subsystem drops its layer field, collapses
  // `scene.sunShadow` to 1×1 and stops baking altogether
  // (`sun-shadow-subsystem.js`'s `dropCasterField`), so "off" is genuinely no
  // work rather than a full-resolution bake that writes white.
  //
  // Everything at `performance` and above is still default-on
  // (feedback_default_on_new_features): the per-frame cost is one texture fetch
  // in a pass that already runs, and the expensive part is a bake that happens
  // a few times a minute.
  enabledFromProfile: 'performance',
  params: SUN_SHADOW_PARAMS,
  // ============================================================================
  // THE LADDER (built 2026-07-29, re-based 2026-08-02 onto the layer-smear
  // model). The arithmetic is `layer-smear.js`'s `LAYER_SMEAR_TIER_PLANS`,
  // index-aligned with this list; THIS is the prose.
  // ============================================================================
  //
  // Every rung buys the SAME picture drawn more finely — there is no rung that
  // introduces a new visual feature, because this effect has exactly one (a
  // baked layer field) and four occluder layers already feed it. The rungs
  // are the layer/field resolution (a resize) and the station count (the one
  // number still compiled into the shader, so still a rebuild); `layer-smear.js`'s
  // own ladder header says what each one is for.
  //
  // ⚠️ `estMsPerMp` IS THE SAME AT EVERY RUNG, AND THAT IS NOT AN OVERSIGHT.
  // It declares the STEADY per-megapixel cost, which for this effect is one
  // texture fetch in the ambient fill — identical whether the field behind it is
  // 512² or 2048². What the ladder actually spends is BAKE time, which is sparse
  // and which `perf-report.js` correctly refuses to grade against a per-pixel
  // budget ("an all-bake effect is not graded against a declared per-pixel
  // budget"). The bake's cost gradient lives where it can be counted rather than
  // guessed: `layerSmearBakeSamples`, reported live in the `sun-shadows` status.
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'coarse',
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.05 }),
      adds:
        'walls, overhead tiles and the floor above all cast one set of smeared, multiplied-together ' +
        'shadows onto the outdoors — at the lowest silhouette resolution this system draws, so ' +
        'rooflines and wall corners read as visibly blocky',
    }),
    Object.freeze({
      n: 1,
      name: 'standard',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.05 }),
      adds: 'the silhouette and the output field both double — noticeably sharper edges and a smoother falloff',
    }),
    Object.freeze({
      n: 2,
      name: 'quality',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.05 }),
      adds: 'sharper still — fine roofline detail (chimneys, thin trim) starts to resolve cleanly',
    }),
    Object.freeze({
      n: 3,
      name: 'extreme',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.05 }),
      adds:
        'the sharpest silhouette and smoothest gradient this system draws, over the most march stations — ' +
        'the sky-reach depth gradient in particular stays smooth even under a very wide roof',
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
      // ⚠️ THE MECHANISM CHANGED (author-ruled 2026-08-01). This note used to say
      // "a fourth producer into the same layer field", i.e. INTO THE BAKE. That
      // is wrong, and wrong in a way that would have looked like a stutter bug
      // rather than a design error: this subsystem re-bakes only when the sun
      // has moved past `SUN_SHADOW_QUANTIZE_DEG` — a few times a minute — while
      // clouds drift CONTINUOUSLY. Baked clouds would jump; the obvious fix
      // (bake every frame) would multiply the bake cost by two orders of
      // magnitude to carry a term that is ~10 ALU ops evaluated inline.
      //
      // The bake exists because GEOMETRY-derived occlusion is expensive to
      // derive. A cloud is closed-form (`world/cloud-field.js`, analytic noise),
      // so any shader can call it for free. ONE shadow authority is still the
      // rule — it is preserved by combining in `effects/shadow-access.js`, the
      // handle every caster already reads, not by putting clouds in the bake.
      note:
        'weather cloud cover drifting with the wind, combined at the READ site (`effects/shadow-access.js`) ' +
        'rather than baked into the layer field — the bake is sparse and clouds are continuous. ' +
        'See docs/planning/Clouds.md §4.1.',
    }),
    Object.freeze({
      name: 'lightning-reuse',
      note: 'a lightning flash is the same field baked from a different direction for one frame — free, and the one thing V2 got right here',
    }),
  ]),
});
