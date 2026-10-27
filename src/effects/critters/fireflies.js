/**
 * FIREFLIES — THE DECLARATION. Params schema + manifest, pure data, no THREE and
 * no TSL. Same four-way split as `smelly-flies.js`, and the same engine
 * (`effects/particles/critter-runtime.js`, `kind: 'firefly'`).
 *
 * ============================================================================
 * THE IDEA
 * ============================================================================
 *
 * Paint a meadow, a hedgerow, a marsh edge. When the sun drops into its twilight
 * window the colony hatches from that paint and drifts over it, glowing; as the
 * sky goes fully dark most of them fade away again, and rain clears the air (the
 * colony thins out rather than landing: a landing is one insect's decision, this
 * is a head-count).
 * The WINDOW is keyed to sun elevation (`critter-activity.js`), not to clock
 * hours, so it follows the astrolabe's own twilight arcs and a GM who changes the
 * sun's peak height moves it for free.
 *
 * V2 never had fireflies (its roadmap's "ambient dressing" list never got past
 * dust and flies); this is new, built on the flies' machinery: a zone field to
 * steer by, a GPU state machine per insect, a procedural body. Only the glow is
 * different — and it is emissive HDR on purpose, so the bloom pass picks it up.
 *
 * ⚠️ `photosensitive: false`, deliberately and with a reason: no insect, in any
 * style, at any setting, flashes more than three times in any one second — the
 * line WCAG 2.3.1 draws, which holds whatever area the flashes cover.
 * `flashPeriod` bottoms out at one second; the kernel clamps it there as well
 * (`FIREFLY_SYNC.PERIOD_FLOOR`), so a stale saved value cannot get under it; the
 * colony coupling can quicken an insect by at most 0.18 flashes a second; and the
 * flash clock runs on REAL time, so the Tempo slider cannot speed it up (it once
 * did, until a review measured 4 Hz at Tempo 2). The busiest style is Double, two
 * flashes a cycle: 2 a second at the floor, 3 at the coupling's worst. If any of
 * these numbers change, the schema's minimum is the place to keep the promise.
 *
 * ⚠️ THE DEFAULTS ARE A FIRST PASS, tuned in the lab and not yet by the author on
 * a real scene.
 *
 * @module effects/critters/fireflies
 */
import { FIREFLY_FLASH_STYLES } from './critter-species.js';
import { freezeParams, presenceParams, weatherParams, tokenParams } from './critter-params.js';

export const FIREFLIES_PARAMS = freezeParams({
  // ── Presence ─────────────────────────────────────────────────────────────
  ...presenceParams({
    countId: 'countPerZone',
    noun: 'fireflies',
    unit: 'colony',
    max: 300,
    count: 6,
    areaScaling: 0.2,
    maskSensitivity: 0.6,
  }),

  // ── Look (the beetle itself) ─────────────────────────────────────────────
  size: {
    type: 'float',
    min: 3,
    max: 60,
    step: 1,
    default: 3,
    category: 'Look',
    label: 'Firefly size',
    help: 'Body length in pixels.',
  },
  sizeVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.2,
    category: 'Look',
    label: 'Size variation',
    help: 'How much individual fireflies differ in size.',
  },
  bodyVisibility: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Look',
    label: 'Body visible',
    help: 'How much of the beetle itself shows when zoomed in, as opposed to just its light.',
  },
  lightInfluence: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Look',
    label: 'Body lit by the scene',
    help: 'How much the scene’s lighting darkens and tints the beetle’s body (its own light is never dimmed): 1 puts it in the torchlight or the gloom like everything else, 0 shows it full-bright. Needs the "lit" quality rung (2) or above.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Look',
    label: 'Opacity',
    help: 'Overall opacity of the fireflies and their glow.',
  },

  // ── Light (the glow) ─────────────────────────────────────────────────────
  color: {
    type: 'color',
    space: 'srgb',
    default: '#b8ff3a',
    category: 'Light',
    label: 'Glow colour',
    help: 'Real fireflies run from yellow-green to blue-green. Hue-shift it for a will-o’-the-wisp.',
  },
  colorVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.3,
    category: 'Light',
    label: 'Colour variation',
    help: 'How far each firefly’s own colour strays from the glow colour: 0 is a colony of one hue; higher mixes yellow-green and blue-green individuals.',
  },
  intensity: {
    type: 'float',
    min: 0,
    max: 40,
    step: 0.1,
    default: 6.2,
    category: 'Light',
    label: 'Glow strength',
    help: 'Brightness of the glow in HDR units. Above about 1 it feeds the bloom pass, which is what makes the light bleed softly into the dark around it.',
  },
  glowRadius: {
    type: 'float',
    min: 2,
    max: 120,
    step: 1,
    default: 8,
    category: 'Light',
    label: 'Glow radius',
    help: 'How far the halo spreads, in pixels.',
  },
  coreSize: {
    type: 'float',
    min: 0.4,
    max: 2.5,
    step: 0.05,
    default: 1,
    category: 'Light',
    label: 'Hot core size ×',
    help: 'How big the hot white-yellow centre of each flash is, relative to the halo. Small is a pinpoint star; large is a soft lantern.',
  },
  haloAmount: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.1,
    category: 'Light',
    label: 'Halo ×',
    help: 'How strong the soft halo around the core is. 0 is a bare pinpoint; 2 is a hazy cloud of light.',
  },
  afterglow: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.1,
    category: 'Light',
    label: 'Afterglow ×',
    help: 'The fading streak a flying firefly leaves, like a long-exposure photograph. 0 removes it; 2 is a long comet tail. Needs the "afterglow" quality rung (3) or above.',
  },
  restGlow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.05,
    category: 'Light',
    label: 'Resting glow',
    help: 'How brightly a firefly resting on the ground glows: a low, steady light, like a female waiting for a signal. 0 puts the light out when it lands.',
  },
  flashStyle: {
    type: 'enum',
    values: [...FIREFLY_FLASH_STYLES],
    default: 'breathe',
    category: 'Light',
    label: 'Flash pattern',
    help: 'Breathe is a slow swell and fade. Blink is a single short flash, then dark. Double is two quick flashes, then a pause. Steady is a constant glow with a faint shimmer.',
  },
  flashPeriod: {
    type: 'float',
    min: 1,
    max: 20,
    step: 0.1,
    default: 3.6,
    category: 'Light',
    label: 'Flash period (s)',
    help: 'Seconds between the start of one flash and the next, for each firefly. Never faster than one a second (the Double pattern flashes twice in each period, so never more than three a second).',
  },
  synchrony: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.25,
    category: 'Light',
    label: 'Synchrony',
    help: 'How closely the colony flashes together. 0 is every firefly on its own rhythm; 1 flashes the whole colony in unison, as some Southeast Asian species do.',
  },

  // ── Motion ───────────────────────────────────────────────────────────────
  speed: {
    type: 'float',
    min: 0.1,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Tempo',
    help: 'A master clock for how fast they drift, turn and decide. It does not change the flash rhythm: that runs on real time, set by the flash period.',
  },
  driftSpeed: {
    type: 'float',
    min: 5,
    max: 250,
    step: 1,
    default: 17,
    category: 'Motion',
    label: 'Drift speed',
    help: 'How fast a firefly cruises, in pixels per second. They are lazy fliers.',
  },
  wander: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.75,
    category: 'Motion',
    label: 'Wander',
    help: 'How much they meander — the sweep of the slow looping turns. 0 flies in straight lines.',
  },
  hoverBob: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Hover bob ×',
    help: 'How much a firefly rises and sinks as it drifts. 0 holds a level altitude; higher is a bobbing, bouncing flight.',
  },
  range: {
    type: 'float',
    min: 0,
    max: 800,
    step: 10,
    default: 730,
    category: 'Motion',
    label: 'Roaming range',
    help: 'How far, in pixels, they stray beyond the painted edge before turning back.',
  },
  restChance: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.005,
    default: 0.5,
    category: 'Motion',
    label: 'Rest chance (per second)',
    help: 'The chance each second that a flying firefly lands on the ground or a leaf. Resting ones glow more softly and steadily, like a female waiting for a signal.',
  },
  liftChance: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.005,
    default: 0.045,
    category: 'Motion',
    label: 'Lift-off chance (per second)',
    help: 'The chance each second that a resting firefly takes off again.',
  },

  // ── Depth ────────────────────────────────────────────────────────────────
  hoverHeight: {
    type: 'float',
    min: 5,
    max: 250,
    step: 5,
    default: 25,
    category: 'Depth',
    label: 'Flight height',
    help: 'About how high above the ground they bob. Height makes a firefly look nearer the camera, so a higher colony reads as a looser, larger cloud.',
  },
  perspective: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.15,
    category: 'Depth',
    label: 'Perspective ×',
    help: 'How much being high in the air makes a firefly look bigger and pushes it away from the middle of the view. 0 flattens the colony onto the ground; 2 exaggerates the depth.',
  },

  // ── Twilight ─────────────────────────────────────────────────────────────
  alwaysActive: {
    type: 'bool',
    default: false,
    category: 'Twilight',
    label: 'Ignore time of day',
    help: 'Show the fireflies whatever the sun is doing — for a game that does not run a day clock, or for checking your paint at noon. Rain still clears them.',
  },
  dusk: {
    type: 'bool',
    default: true,
    category: 'Twilight',
    label: 'Evening',
    help: 'Fireflies come out as the sun sets.',
  },
  dawn: {
    type: 'bool',
    default: false,
    category: 'Twilight',
    label: 'Morning',
    help: 'Fireflies come out again before the sun rises. Switch both off and only Ignore time of day will show them.',
  },
  appearBelowDeg: {
    type: 'float',
    min: -10,
    max: 30,
    step: 0.5,
    default: 4,
    category: 'Twilight',
    label: 'First ones hatch when the sun is below (°)',
    help: 'Sun elevation in degrees above the horizon. They begin to appear as the sun sinks past this angle. Higher starts the show earlier in the golden hour; the sun passes 0° at sunset.',
  },
  fullBelowDeg: {
    type: 'float',
    min: -30,
    max: 10,
    step: 0.5,
    default: -6,
    category: 'Twilight',
    label: 'Full colony when the sun is below (°)',
    help: 'By this angle the whole colony is out. −6° is the end of civil twilight, the blue hour.',
  },
  fadeByDeg: {
    type: 'float',
    min: -60,
    max: 0,
    step: 0.5,
    default: -18,
    category: 'Twilight',
    label: 'Settle by (°)',
    help: 'The colony thins from halfway between “full” and this angle, down to the stragglers, in the dark. −18° is the end of astronomical twilight, when the sky is fully black.',
  },
  nightResidual: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.1,
    category: 'Twilight',
    label: 'Stay out all night',
    help: 'The fraction of the colony still glowing in the dead of night. 0 puts every one away once the sky is dark.',
  },

  // ── Weather ──────────────────────────────────────────────────────────────
  ...weatherParams({
    noun: 'fireflies',
    defaults: {
      rain: 1,
      snow: 1,
      windThreshold: 0.1,
      wind: 0.8,
      coldBelow: 0.3,
      cold: 1,
      floor: 0,
      fadeTime: 3,
    },
  }),
  windDrift: {
    type: 'float',
    min: 0,
    max: 300,
    step: 5,
    default: 60,
    category: 'Weather',
    label: 'Wind carries them (px/s)',
    help: 'How fast a full gale blows a flying firefly downwind, in pixels per second. The colony’s edge turns them back, so this skews the cloud and shears it rather than blowing it away. Resting fireflies are not moved.',
  },
  windAgitation: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 0.8,
    category: 'Weather',
    label: 'Wind makes them erratic ×',
    help: 'How much more they wander in wind: their wander is multiplied by 1 + this × the wind. 0 leaves their lazy loops untouched.',
  },
  rainShelter: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.6,
    category: 'Weather',
    label: 'Rain makes them settle',
    help: 'How strongly rain or snow makes the fireflies that stay land and rest: more settling, less lifting off. Only matters where the rain does not clear them outright.',
  },
  coldSlowdown: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Weather',
    label: 'Cold slows them',
    help: 'How sluggish a cold evening makes the fireflies that remain: they drift, turn and decide more slowly. Uses the same "too cold below" temperature. The flash rhythm is not slowed — it runs on real time.',
  },

  // ⭐ TOKENS — new scope, not a deferred idea closed (this effect's own idea list only ever had
  // `ground-light`, about LIGHTING a token, never about reacting to one). Softer than the flies'
  // own response by default: a firefly settling into the dark near something large reads as
  // wary, not panicked.
  ...tokenParams({ noun: 'fireflies', defaults: { response: 1, radiusPx: 200 } }),
});

/**
 * The Studio card's front-of-house strip: how many, how bright, what colour, how they flash, how in step they are,
 * whether they keep to the twilight window, and the two weather responses. Everything else is on the card's ROH.
 * Held to the schema by a Node test.
 */
export const FIREFLIES_FOH = Object.freeze([
  'countPerZone',
  'intensity',
  'color',
  'flashStyle',
  'synchrony',
  'alwaysActive',
  'rainResponse',
  'windResponse',
]);

/** Built-in presets — see `SMELLY_FLIES_PRESETS`. */
export const FIREFLIES_PRESETS = Object.freeze({
  'Summer meadow': Object.freeze({ countPerZone: 24, areaScaling: 0.7, flashStyle: 'breathe', synchrony: 0.2 }),
  'Sparse and shy': Object.freeze({ countPerZone: 6, intensity: 3.5, driftSpeed: 20, wander: 1.4 }),
  'Synchronous swarm': Object.freeze({
    countPerZone: 60,
    areaScaling: 0.8,
    synchrony: 1,
    flashStyle: 'blink',
    flashPeriod: 2.2,
    intensity: 6,
  }),
  'Will-o’-the-wisps': Object.freeze({
    countPerZone: 8,
    color: '#7fd8ff',
    colorVariation: 0.1,
    intensity: 9,
    glowRadius: 36,
    flashStyle: 'steady',
    driftSpeed: 14,
    wander: 2,
    hoverBob: 2,
    afterglow: 1.6,
  }),
  'Ignores the weather': Object.freeze({
    rainResponse: 0,
    snowResponse: 0,
    windResponse: 0,
    coldResponse: 0,
    windDrift: 0,
    windAgitation: 0,
    rainShelter: 0,
    coldSlowdown: 0,
  }),
});

/** @param {string} name @returns {Record<string, *>} a fresh patch, `{}` for an unknown name. */
export function firefliesPreset(name) {
  return { ...(FIREFLIES_PRESETS[name] ?? {}) };
}

/** THE MANIFEST. */
export const FIREFLIES = Object.freeze({
  id: 'fireflies',
  title: 'Fireflies',
  // A deliberate, atmospheric effect that earns its place at twilight.
  visualWeight: 0.5,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Builds its firefly engine lazily on the first sync that has both a painted zone and a non-zero activity (ensureEngine) — real first-run work (a compute kernel and a material), but SYNCHRONOUS, with no pending window a probe could observe, and a "built yet?" flag would hold readiness open forever on a scene with no colony painted or at noon. It is covered globally instead: the kernels grow the pipeline set, which settle.js’s pipeline-growth criterion catches.',
  }),
  params: FIREFLIES_PARAMS,
  authoring: Object.freeze({ paint: 'fireflies' }),

  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'motes',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.02 }),
      adds: 'half the colony as pure glow — a hot core and a halo, flashing in its pattern — drifting over the paint',
    }),
    Object.freeze({
      n: 1,
      name: 'beetles',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.03 }),
      adds: 'three quarters of the colony, each with a visible body (wing cases, a glowing lantern) when the camera is close',
    }),
    Object.freeze({
      n: 2,
      name: 'lit',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.04 }),
      adds: 'the full colony, with the body lit by the scene (two illumination reads) so a beetle in a torch pool reads and one in the dark does not',
    }),
    Object.freeze({
      n: 3,
      name: 'afterglow',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.05 }),
      adds: 'a fading light trail along each flight path (the afterimage a long exposure shows)',
    }),
    Object.freeze({
      n: 4,
      name: 'swarm',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.06 }),
      adds: 'a quarter more fireflies than the author asked for',
    }),
  ]),

  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'ground-light',
      note: 'A real point light under each flash, so the grass and tokens nearby brighten with it. Needs a cheap, merged light source in the point-light pool (the way fire merges its light), not one light per insect.',
    }),
    Object.freeze({
      name: 'kuramoto-sync',
      note: 'Synchrony today blends each firefly’s own phase toward one colony clock. Real colonies converge by each insect nudging its phase when it sees a neighbour flash; that needs a neighbour query the GPU kernel does not have.',
    }),
  ]),
});
