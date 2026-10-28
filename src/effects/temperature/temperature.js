/**
 * TEMPERATURE EFFECTS — the scene's look follows the Remote's Temperature fader.
 *
 * The author, 2026-10-27: *"the temperature of the scene's lighting / visuals
 * could be linked to the 'temp' vertical slider. Below the freezing tick we cool
 * the scene colouring down to make it feel icy, above the 75% mark we make a
 * subtle warming recolouration."* Plus two bonus layers: frost creeping in from
 * the screen's edges below 10% that refracts the scene like ice, and a gentle
 * outdoor-only heat ripple when it is hot — *"higher rendering performance is
 * more important than visual fidenlity"*.
 *
 * THREE PARTS, ALL ON THE PRESENT DRAW, NONE A NEW PASS:
 *
 *  1. THE GRADE — pure data. `temperature-model.js#resolveTemperatureGrade` turns the eased
 *     `temperature01` into deltas on the ONE grade primitive (`grade-ops.js`):
 *     white balance, saturation, contrast, exposure, split-tone lift/gain. The
 *     viewer folds them into the Colour Grade's own uniforms before they are
 *     pushed — zero shader cost, and the map-wide CC simply gains a term.
 *     `indoorShare` splits it between the artistic grade (whole frame) and the
 *     outdoor-gated environmental grade, so indoors can feel the cold less.
 *  2. FROST — a screen-edge mat plus fern crystals, sampled from ONE baked
 *     tileable texture (`temperature-noise.js`), offsetting the present's own
 *     sample position (refraction) and laying a pale veil on top. Its coverage
 *     GROWS on the CPU (`temperature-model.js#stepFrost`) — slowly in, quicker out.
 *  3. HEAT RIPPLE — two taps of the same texture's smooth channel, world-
 *     anchored and rising, scaled by the `_Outdoors` gate the present already
 *     samples.
 *
 * The cold line defaults to the snow tick (`world/weather.js#PRECIP_SLEET_BAND`
 * `.coldEdge`, the snowflake the fader draws) so "below the freezing tick"
 * means exactly that tick, and moves with it.
 *
 * THIS FILE IS THE DECLARATION (params + manifest), pure data; the maths that
 * reads it is `temperature-model.js`.
 *
 * @module effects/temperature/temperature
 */

import { PRECIP_SLEET_BAND } from '../../world/index.js';

/** The effect's Studio parameters, in card order. */
export const TEMPERATURE_EFFECTS_PARAMS = Object.freeze({
  // ── Cold grade ──────────────────────────────────────────────────────────
  coldBelow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: PRECIP_SLEET_BAND.coldEdge,
    category: 'Cold grade',
    label: 'Icy below',
    help: 'Temperature where the icy grade starts. Defaults to the snowflake tick on the Temperature fader (the freezing line).',
  },
  coldFullAt: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Cold grade',
    label: 'Fully icy at',
    help: 'Temperature where the icy grade reaches full strength. Between this and "Icy below" it eases in.',
  },
  coldStrength: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Cold grade',
    label: 'Icy strength',
    help: 'Scales the whole icy grade. 0 turns it off, 2 exaggerates it.',
  },
  coldWhiteBalance: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.8,
    category: 'Cold grade',
    label: 'Cool shift',
    help: 'How far the white balance swings toward blue at full cold.',
  },
  coldDesaturate: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.28,
    category: 'Cold grade',
    label: 'Drain colour',
    help: 'How much colour the cold drains away. Frozen scenes read pale and washed.',
  },
  coldContrast: {
    type: 'float',
    min: -0.5,
    max: 0.5,
    step: 0.01,
    default: 0.04,
    category: 'Cold grade',
    label: 'Contrast',
    help: 'Contrast added (+) or removed (−) at full cold. A touch more reads crisp and brittle.',
  },
  coldExposure: {
    type: 'float',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0.05,
    category: 'Cold grade',
    label: 'Brightness',
    help: 'Exposure change at full cold, in stops. A small lift keeps icy light bright rather than gloomy.',
  },
  coldShadowTint: {
    type: 'color',
    space: 'srgb',
    default: '#6f9fd8',
    category: 'Cold grade',
    label: 'Shadow tint',
    help: 'The colour the shadows lean toward at full cold.',
  },
  coldShadowAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    category: 'Cold grade',
    label: 'Shadow tint amount',
    help: 'How strongly the shadows take the cold tint.',
  },
  coldHighlightTint: {
    type: 'color',
    space: 'srgb',
    default: '#dff1ff',
    category: 'Cold grade',
    label: 'Highlight tint',
    help: 'The colour the highlights lean toward at full cold.',
  },
  coldHighlightAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.45,
    category: 'Cold grade',
    label: 'Highlight tint amount',
    help: 'How strongly the highlights take the cold tint.',
  },

  // ── Warm grade ──────────────────────────────────────────────────────────
  warmAbove: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.75,
    category: 'Warm grade',
    label: 'Warm above',
    help: 'Temperature where the warm grade starts (75% by default).',
  },
  warmFullAt: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Warm grade',
    label: 'Fully warm at',
    help: 'Temperature where the warm grade reaches full strength.',
  },
  warmStrength: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Warm grade',
    label: 'Warm strength',
    help: 'Scales the whole warm grade. It is deliberately subtle at 1.',
  },
  warmWhiteBalance: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.18,
    category: 'Warm grade',
    label: 'Warm shift',
    help: 'How far the white balance swings toward orange at full heat.',
  },
  warmSaturation: {
    type: 'float',
    min: -0.5,
    max: 0.5,
    step: 0.01,
    default: 0.06,
    category: 'Warm grade',
    label: 'Saturation',
    help: 'Colour added (+) or drained (−) at full heat. A little extra reads sun-baked.',
  },
  warmContrast: {
    type: 'float',
    min: -0.5,
    max: 0.5,
    step: 0.01,
    default: 0,
    category: 'Warm grade',
    label: 'Contrast',
    help: 'Contrast added (+) or removed (−) at full heat. Slightly negative reads hazy.',
  },
  warmExposure: {
    type: 'float',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0.02,
    category: 'Warm grade',
    label: 'Brightness',
    help: 'Exposure change at full heat, in stops.',
  },
  warmShadowTint: {
    type: 'color',
    space: 'srgb',
    default: '#7a4a24',
    category: 'Warm grade',
    label: 'Shadow tint',
    help: 'The colour the shadows lean toward at full heat.',
  },
  warmShadowAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.15,
    category: 'Warm grade',
    label: 'Shadow tint amount',
    help: 'How strongly the shadows take the warm tint.',
  },
  warmHighlightTint: {
    type: 'color',
    space: 'srgb',
    default: '#ffe1b4',
    category: 'Warm grade',
    label: 'Highlight tint',
    help: 'The colour the highlights lean toward at full heat.',
  },
  warmHighlightAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.25,
    category: 'Warm grade',
    label: 'Highlight tint amount',
    help: 'How strongly the highlights take the warm tint.',
  },
  indoorShare: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    category: 'Indoors',
    label: 'Indoors share',
    help: 'How much of the cold or warm grade reaches indoors. 1 = the whole map alike; 0 = outdoors only (needs the map’s outdoors mask).',
  },

  // ── Frost ───────────────────────────────────────────────────────────────
  frostEnabled: {
    type: 'bool',
    default: true,
    category: 'Frost',
    label: 'Frost on the edges',
    help: 'Frost and ice creep in from the edges of the screen when it is very cold, refracting the scene like ice.',
  },
  frostBelow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.1,
    category: 'Frost',
    label: 'Frost below',
    help: 'Temperature where frost starts to form (10% by default).',
  },
  frostFullAt: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Frost',
    label: 'Full frost at',
    help: 'Temperature where the frost grows to its full reach.',
  },
  frostGrowSec: {
    type: 'float',
    min: 1,
    max: 600,
    step: 1,
    default: 90,
    category: 'Frost',
    label: 'Grow time (s)',
    help: 'Seconds for the frost to creep all the way in. Slow is the point: it should feel like the cold setting in.',
  },
  frostMeltSec: {
    type: 'float',
    min: 1,
    max: 600,
    step: 1,
    default: 25,
    category: 'Frost',
    label: 'Melt time (s)',
    help: 'Seconds for full frost to clear once it warms up.',
  },
  frostReach: {
    type: 'float',
    min: 0.02,
    max: 0.6,
    step: 0.01,
    default: 0.22,
    category: 'Frost',
    label: 'Reach',
    help: 'How far in from the edge full frost reaches, as a share of the screen height.',
  },
  frostIrregularity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    category: 'Frost',
    label: 'Ragged edge',
    help: 'How uneven the frost line is. 0 is a neat frame; 1 lets it surge in some places and hang back in others.',
  },
  frostCornerBias: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.65,
    category: 'Frost',
    label: 'Corners first',
    help: 'How much further the frost reaches into the corners than along the sides.',
  },
  frostSoftness: {
    type: 'float',
    min: 0.02,
    max: 1,
    step: 0.01,
    default: 0.45,
    category: 'Frost',
    label: 'Mat softness',
    help: 'How gently the solid frost mat at the frame fades into the open crystals.',
  },
  frostCrystalScale: {
    type: 'float',
    min: 0.5,
    max: 6,
    step: 0.05,
    default: 2.6,
    category: 'Frost',
    label: 'Crystal scale',
    help: 'How many crystal tiles fit the screen height. Higher = smaller, finer crystals.',
  },
  frostRefractPx: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.5,
    default: 9,
    category: 'Frost',
    label: 'Refraction (px)',
    help: 'How far the ice bends the scene seen through it, in screen pixels.',
  },
  frostOpacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    category: 'Frost',
    label: 'Frost opacity',
    help: 'How white and opaque the frost is. Low values leave mostly clear, refracting ice.',
  },
  frostSparkle: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.3,
    category: 'Frost',
    label: 'Crystal glints',
    help: 'Brightness of the crystal edges catching the light.',
  },
  frostNightGlow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.2,
    category: 'Frost',
    label: 'Night brightness',
    help: 'How bright the frost stays in a dark scene, as a share of its daylight brightness. Low keeps night frost from glowing.',
  },
  frostTint: {
    type: 'color',
    space: 'srgb',
    default: '#e2f3ff',
    category: 'Frost',
    label: 'Frost colour',
    help: 'The colour of the frost and of the light through the ice.',
  },

  // ── Heat ripple ─────────────────────────────────────────────────────────
  heatEnabled: {
    type: 'bool',
    default: true,
    category: 'Heat ripple',
    label: 'Heat ripple',
    help: 'A gentle shimmer over outdoor ground when it is hot. Outdoors only (follows the map’s outdoors mask).',
  },
  heatAbove: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.8,
    category: 'Heat ripple',
    label: 'Ripple above',
    help: 'Temperature where the shimmer starts.',
  },
  heatFullAt: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Heat ripple',
    label: 'Full ripple at',
    help: 'Temperature where the shimmer reaches full strength.',
  },
  heatStrengthPx: {
    type: 'float',
    min: 0,
    max: 8,
    step: 0.1,
    default: 1.4,
    category: 'Heat ripple',
    label: 'Strength (px)',
    help: 'How far the shimmer moves the picture at full heat, in screen pixels. Keep it small.',
  },
  heatScale: {
    type: 'float',
    min: 50,
    max: 2000,
    step: 10,
    default: 320,
    category: 'Heat ripple',
    label: 'Ripple size',
    help: 'The size of one shimmer cell on the map, in map pixels.',
  },
  heatRiseSpeed: {
    type: 'float',
    min: 0,
    max: 400,
    step: 1,
    default: 45,
    category: 'Heat ripple',
    label: 'Rise speed',
    help: 'How fast the shimmer drifts up the screen, in map pixels per second.',
  },
  heatNightStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.3,
    category: 'Heat ripple',
    label: 'At night',
    help: 'How much shimmer is left in full darkness, as a share of the daytime amount. Hot ground cools after dark.',
  },
});

/**
 * The manifest. `enabledFromProfile: 'low'`: the grade is free (uniform
 * values only), and the two warp layers are compiled into the present only
 * while one of them is actually showing.
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const TEMPERATURE_EFFECTS = Object.freeze({
  id: 'temperatureEffects',
  title: 'Temperature Effects',
  visualWeight: 0.35,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Bakes one 512² noise texture (~tens of ms on the CPU) and recompiles the present the first time frost or heat ripple shows — only below 10% or above 80% temperature, never at load on a temperate scene, so no per-effect probe (a "built yet" flag would fail closed on every mild map).',
  }),
  params: TEMPERATURE_EFFECTS_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'grade-frost-ripple',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.05 }),
      adds: 'an icy / warm shift on the Colour Grade (free), plus — only while showing — a frost frame that refracts the scene (2 texture taps) and an outdoor heat ripple (2 taps), folded into the present draw',
    }),
  ]),
});
