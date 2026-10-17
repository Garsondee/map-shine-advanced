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
 * sky goes fully dark most of them settle again, and rain sends them to ground.
 * The WINDOW is keyed to sun elevation (`critter-activity.js`), not to clock
 * hours, so it follows the astrolabe's own twilight arcs and a GM who changes the
 * sun's peak height moves it for free.
 *
 * V2 never had fireflies (its roadmap's "ambient dressing" list never got past
 * dust and flies); this is new, built on the flies' machinery: a zone field to
 * steer by, a GPU state machine per insect, a procedural body. Only the glow is
 * different — and it is emissive HDR on purpose, so the bloom pass picks it up.
 *
 * ⚠️ `photosensitive: false`, deliberately and with a reason. Each flash is a
 * point of light a few pixels across, and the slowest rate any style allows is
 * well under 3 Hz per insect (`flashPeriod` bottoms out at half a second). The
 * accessibility class exists for large-area flicker; if that ever changes, the
 * schema's minimum is the place to enforce it.
 *
 * ⚠️ THE DEFAULTS ARE A FIRST PASS, tuned in the lab and not yet by the author on
 * a real scene.
 *
 * @module effects/critters/fireflies
 */
import { FIREFLY_FLASH_STYLES } from './critter-species.js';

export const FIREFLIES_PARAMS = Object.freeze({
  // ── Colony ───────────────────────────────────────────────────────────────
  countPerZone: {
    type: 'int',
    min: 0,
    max: 300,
    step: 1,
    default: 14,
    category: 'Colony',
    label: 'Fireflies per colony',
    help: 'How many fireflies a painted blob of reference size (about two and a half grid squares across) can hold at full strength. Every separate painted blob is its own colony.',
  },
  areaScaling: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.6,
    category: 'Colony',
    label: 'Bigger meadow, bigger colony',
    help: '0 gives every painted blob the same number of fireflies; 1 makes the colony proportional to the blob’s area.',
  },
  maskSensitivity: {
    type: 'float',
    min: 0.02,
    max: 0.6,
    step: 0.01,
    default: 0.15,
    category: 'Colony',
    label: 'Mask sensitivity',
    help: 'How much paint counts as part of a colony’s zone. LOWER catches faint or thin strokes — turn it DOWN if fireflies you painted are not appearing.',
  },

  // ── Twilight ─────────────────────────────────────────────────────────────
  alwaysActive: {
    type: 'bool',
    default: false,
    category: 'Twilight',
    label: 'Ignore time of day',
    help: 'Show the fireflies whatever the sun is doing — for a game that does not run a day clock, or for checking your paint at noon. Rain still grounds them.',
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
    default: true,
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
    default: -20,
    category: 'Twilight',
    label: 'Settle by (°)',
    help: 'The colony thins from halfway between “full” and this angle, down to the stragglers, in the dark. −18° is the end of astronomical twilight, when the sky is fully black.',
  },
  nightResidual: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.2,
    category: 'Twilight',
    label: 'Stay out all night',
    help: 'The fraction of the colony still glowing in the dead of night. 0 sends every one to ground once the sky is dark.',
  },
  weatherResponse: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Twilight',
    label: 'Weather response',
    help: 'How much rain and wind send them to ground. At 1, rain empties the air completely and a gale thins it.',
  },

  // ── Flight ───────────────────────────────────────────────────────────────
  speed: {
    type: 'float',
    min: 0.1,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Flight',
    label: 'Tempo',
    help: 'A master clock for how fast they drift, turn and decide.',
  },
  driftSpeed: {
    type: 'float',
    min: 5,
    max: 250,
    step: 1,
    default: 30,
    category: 'Flight',
    label: 'Drift speed',
    help: 'How fast a firefly cruises, in pixels per second. They are lazy fliers.',
  },
  wander: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Flight',
    label: 'Wander',
    help: 'How much they meander — the sweep of the slow looping turns. 0 flies in straight lines.',
  },
  hoverHeight: {
    type: 'float',
    min: 5,
    max: 250,
    step: 5,
    default: 45,
    category: 'Flight',
    label: 'Flight height',
    help: 'About how high above the ground they bob. Height makes a firefly look nearer the camera, so a higher colony reads as a looser, larger cloud.',
  },
  range: {
    type: 'float',
    min: 0,
    max: 800,
    step: 10,
    default: 140,
    category: 'Flight',
    label: 'Roaming range',
    help: 'How far, in pixels, they stray beyond the painted edge before turning back.',
  },
  restChance: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.005,
    default: 0.015,
    category: 'Flight',
    label: 'Rest chance (per second)',
    help: 'The chance each second that a flying firefly lands on the ground or a leaf. Resting ones glow more softly and steadily, like a female waiting for a signal.',
  },
  liftChance: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.005,
    default: 0.05,
    category: 'Flight',
    label: 'Lift-off chance (per second)',
    help: 'The chance each second that a resting firefly takes off again.',
  },

  // ── Glow ─────────────────────────────────────────────────────────────────
  color: {
    type: 'color',
    space: 'srgb',
    default: '#b8ff3a',
    category: 'Glow',
    label: 'Glow colour',
    help: 'Real fireflies run from yellow-green to blue-green. Hue-shift it for a will-o’-the-wisp.',
  },
  intensity: {
    type: 'float',
    min: 0,
    max: 40,
    step: 0.1,
    default: 5,
    category: 'Glow',
    label: 'Glow strength',
    help: 'Brightness of the glow in HDR units. Above about 1 it feeds the bloom pass, which is what makes the light bleed softly into the dark around it.',
  },
  glowRadius: {
    type: 'float',
    min: 2,
    max: 120,
    step: 1,
    default: 18,
    category: 'Glow',
    label: 'Glow radius',
    help: 'How far the halo spreads, in pixels.',
  },
  flashStyle: {
    type: 'enum',
    values: [...FIREFLY_FLASH_STYLES],
    default: 'breathe',
    category: 'Glow',
    label: 'Flash pattern',
    help: 'Breathe is a slow swell and fade. Blink is a single short flash, then dark. Double is two quick flashes, then a pause. Steady is a constant glow with a faint shimmer.',
  },
  flashPeriod: {
    type: 'float',
    min: 0.5,
    max: 20,
    step: 0.1,
    default: 3.6,
    category: 'Glow',
    label: 'Flash period (s)',
    help: 'Seconds between the start of one flash and the next, for each firefly. Never faster than two a second.',
  },
  synchrony: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.25,
    category: 'Glow',
    label: 'Synchrony',
    help: 'How closely the colony flashes together. 0 is every firefly on its own rhythm; 1 flashes the whole colony in unison, as some Southeast Asian species do.',
  },
  bodyVisibility: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.7,
    category: 'Glow',
    label: 'Body visible',
    help: 'How much of the beetle itself shows when zoomed in, as opposed to just its light.',
  },

  // ── Look ─────────────────────────────────────────────────────────────────
  size: {
    type: 'float',
    min: 3,
    max: 60,
    step: 1,
    default: 8,
    category: 'Look',
    label: 'Firefly size',
    help: 'Body length in pixels.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Opacity',
    help: 'Overall opacity of the fireflies and their glow.',
  },
});

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
