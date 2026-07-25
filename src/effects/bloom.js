/**
 * BLOOM — MSA's first POST-processing effect, and the first citizen of the
 * `post` stage in the frame graph (graph/passes.js `post.bloom`).
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest + presets) — pure data,
 * no THREE. The runtime (the dual-filter blur pyramid) lives in
 * `effects/bloom-render.js` (TSL builders, THREE injected) and is driven by a
 * `runPostBloomPass` closure in `vt/vt-pan-viewer.js`. Same split as the candle
 * (candle-flame.js declaration + candle-flame-render.js material), so this is
 * backend-agnostic and Node-validatable.
 *
 * THE TECHNIQUE (docs/planning/Bloom.md): the modern "physically-based" bloom
 * from Jimenez / Call of Duty: Advanced Warfare — a progressive downsample
 * (13-tap, Karis average on the first step to kill fireflies) + a progressive
 * tent-filter upsample. It replaces the stock three UnrealBloomPass port (hard
 * threshold → grainy; separable Gaussian per mip) and V2's `BloomEffectV2`
 * (also separable Gaussian). It looks better AND is cheaper, and its pyramid
 * gives the author's "tight CORE + wide ATMOSPHERE" for free: the two are just
 * shallow vs deep levels of the SAME pyramid, each weighted independently —
 * exactly V2's Surface/Atmosphere split, one blur chain, two taps.
 *
 * THE CLAMP (why bloom can't leak where it shouldn't): the bright-pass INPUT is
 * darkened by a world-space mask BEFORE any blur runs, so a bright source in a
 * masked region contributes zero energy to the pyramid and physically cannot
 * bloom outward. Today that mask is `_Outdoors` (the "outdoor spill suppress"
 * below — stops indoor window-glow haloing onto dark exterior ground). The SAME
 * input hook is where a native fog-of-war visibility texture connects the day
 * MSA renders its own fog (keyhole-vision-fog-direction) — the architecture is
 * built now; the fog wire is a documented seam, not a faked control.
 *
 * @module effects/bloom
 */

/**
 * The authorable knobs (validated by core/params-schema.js). Grouped by the
 * fixed ROH categories (diag/effect-controls.js CATEGORY_ORDER). Every control
 * here is LIVE — there is deliberately no dead "fog clip" toggle: the fog clamp
 * arrives wired, with the fog system, rather than as a switch that does nothing
 * (Effects-UI.md's dead-control rule; feedback_required_masks_fail_loud).
 *
 * @type {Record<string, object>}
 */
export const BLOOM_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  threshold: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.01,
    default: 1.0,
    category: 'Look',
    label: 'Threshold',
    help: 'How bright a pixel must be before it starts to glow. The scene is HDR (light and coloration push values above 1), so ~1.0 means "only real highlights bloom"; lower it to make more of the image glow.',
  },
  knee: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    category: 'Look',
    label: 'Soft knee',
    help: 'How gently the glow fades in around the threshold. 0 = a hard cutoff (can shimmer/grain on moving highlights); 1 = a very soft, forgiving roll-in. This is the modern fix for the "sparkly bloom" look.',
  },
  strength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.0,
    category: 'Look',
    label: 'Strength',
    help: 'Overall glow intensity — scales both the tight core and the wide atmosphere together. The master dial.',
  },
  coreStrength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.0,
    category: 'Look',
    label: 'Core strength',
    help: 'Intensity of the TIGHT glow that hugs bright sources (lamps, fire, specular glints). This is the crisp halo right on the source.',
  },
  coreTint: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Look',
    label: 'Core tint',
    help: 'Colour of the tight core glow. White keeps it faithful to the source colour; tint it to push a mood.',
  },
  atmoStrength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 0.5,
    category: 'Look',
    label: 'Atmosphere strength',
    help: 'Intensity of the WIDE, soft glow — the sense of air catching the light, haze around a scene. This is the "atmospherics" layer, separate from the tight core.',
  },
  atmoTint: {
    type: 'color',
    space: 'srgb',
    // Warm haze by default (V2's atmosphere tint intent).
    default: '#fff0dc',
    category: 'Look',
    label: 'Atmosphere tint',
    help: 'Colour of the wide atmospheric glow. A warm tint reads as dusty/golden air; a cool tint as misty/moonlit.',
  },

  // ── Extent (reach / spread) ───────────────────────────────────────────────
  coreSpread: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.4,
    category: 'Extent',
    label: 'Core spread',
    help: 'How far the tight core glow reaches from its source. Small keeps it crisp on the highlight; larger softens and grows it.',
  },
  atmoSpread: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.7,
    category: 'Extent',
    label: 'Atmosphere spread',
    help: 'How far the wide atmospheric glow reaches. Larger = a broader, softer wash of air-glow across the scene.',
  },

  // ── Response (masking / clamping) ─────────────────────────────────────────
  outdoorSpillSuppress: {
    type: 'bool',
    default: true,
    category: 'Response',
    label: 'Suppress outdoor spill',
    help: 'Stops bright indoor window-light from blooming out onto the dark ground OUTSIDE a building. Uses the painted indoor/outdoor mask. Leave on for exteriors around lit buildings.',
  },
  spillLumLo: {
    type: 'float',
    min: 0.05,
    max: 1.5,
    step: 0.01,
    default: 0.42,
    category: 'Response',
    label: 'Spill floor (× threshold)',
    help: 'Advanced. Outdoor ground darker than threshold × this value gets NO spilled bloom at all. Lower = suppress more aggressively.',
  },
  spillLumHi: {
    type: 'float',
    min: 0.1,
    max: 2,
    step: 0.01,
    default: 0.92,
    category: 'Response',
    label: 'Spill ceiling (× threshold)',
    help: 'Advanced. Outdoor pixels brighter than threshold × this value keep their FULL bloom (real outdoor highlights — sun, torches, water glints — still glow). Between floor and ceiling it fades in.',
  },
});

/**
 * Named looks, shipped as DATA (the grade-ops.js preset pattern). A preset is
 * just a partial diff over the schema defaults — the exact shape the effect
 * cascade takes as a `paramLayers` entry, so applying one is dropping it into
 * the resolver, not a bespoke code path.
 *
 * Ported from BloomEffectV2's authored set (docs/reference/v2-effect-params/
 * bloom-effect.md) and RE-TUNED for the new dual-filter math — the V2 numbers
 * were tuned against separable-Gaussian GLSL that no longer exists, so only the
 * INTENT of each look carries over, never the literal values.
 *
 * @type {Record<string, Record<string, number|string>>}
 */
export const BLOOM_PRESETS = Object.freeze({
  none: {},
  subtle: { strength: 0.55, coreStrength: 0.85, atmoStrength: 0.25, threshold: 1.25, atmoSpread: 0.55 },
  strong: { strength: 1.6, coreStrength: 1.35, atmoStrength: 0.95, threshold: 0.85 },
  dreamy: {
    strength: 1.3,
    coreStrength: 0.9,
    atmoStrength: 1.2,
    threshold: 0.75,
    knee: 0.85,
    atmoSpread: 0.9,
    coreSpread: 0.6,
  },
  neon: { strength: 1.5, coreStrength: 1.7, atmoStrength: 0.7, threshold: 0.6, knee: 0.35, atmoTint: '#ff8fd6' },
  clearNoon: { strength: 0.8, threshold: 1.45, coreStrength: 1.0, atmoStrength: 0.3, atmoTint: '#fff6e8' },
  goldenHour: { strength: 1.15, threshold: 0.9, atmoStrength: 0.75, atmoTint: '#ffcf9e', atmoSpread: 0.8 },
  overcastDay: { strength: 0.7, threshold: 1.1, atmoStrength: 0.5, atmoTint: '#dfe6ee', coreStrength: 0.85 },
  storm: { strength: 0.9, threshold: 1.0, atmoStrength: 0.6, atmoTint: '#b8c2d0' },
  moonlitNight: { strength: 0.95, threshold: 0.7, atmoStrength: 0.85, atmoTint: '#9fb6d6', atmoSpread: 0.85 },
  interiorNight: { strength: 1.05, threshold: 0.8, coreStrength: 1.2, atmoStrength: 0.5, atmoTint: '#ffb877' },
});

/** The schema defaults as a flat object — the base a preset diffs over. */
const BLOOM_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(BLOOM_PARAMS).map(([k, decl]) => [k, decl.default]))
);

/**
 * Resolve a named preset to a FULL params object (defaults + the named diff).
 * Unknown name ⇒ the plain defaults. Mirrors grade-ops.js#gradePreset.
 * @param {string} name
 * @returns {Record<string, number|string>}
 */
export function bloomPreset(name) {
  return { ...BLOOM_DEFAULTS, ...(BLOOM_PRESETS[name] || {}) };
}

/**
 * The manifest — the effect as data (Effects.md §2 shape).
 *
 * `enabledFromProfile: 'low'` = ON at every performance profile by default.
 * Bloom is a KEY environment effect (the author's own framing) and the pyramid
 * is cheap — half-resolution and below, ~11 small passes, ~8 MB of render
 * targets (Keyhole.md §4.2's RT inventory already budgets "bloom chain ~8").
 * feedback_default_on_new_features: ship the best look, dial DOWN on request.
 * `a11y.photosensitive: false` — a soft glow, not a strobe.
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const BLOOM = Object.freeze({
  id: 'bloom',
  title: 'Bloom',
  // A whole-image atmosphere effect — high perceptual weight, defended well
  // above decorative chrome (it is a big part of "the environment looks right").
  visualWeight: 0.7,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  params: BLOOM_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'dual-filter-two-band',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.3 }),
      adds: 'Jimenez/COD progressive downsample (13-tap + Karis) + tent upsample, split into an independently-weighted tight core and wide atmosphere band, masked bright-pass input (outdoor-spill clamp via the outdoors mask), additively composited into scene.lit before the grade',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'fog-of-war-clip',
      note: "darken the bright-pass input inside fog-of-war too — connects the SAME input hook to MSA's native fog visibility texture the day it exists (keyhole-vision-fog-direction)",
    }),
    Object.freeze({
      name: 'selective-emissive-bloom',
      note: "bloom only flagged emissive surfaces (candle flames, magic) via an MRT emissive channel — needs geometry.world to MRT buf:scene.attr's emissive first",
    }),
    Object.freeze({
      name: 'lens-dirt-and-streaks',
      note: 'a screen-space dirt texture and anamorphic streak tap on the bright-pass for a lens feel',
    }),
    Object.freeze({
      name: 'performance-tiers',
      note: 'governor-driven resolution scale + mip count per performance profile (Effects.md §6) — tier 0 is fixed half-res, 6 mips',
    }),
  ]),
});
