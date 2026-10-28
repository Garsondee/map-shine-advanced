/**
 * DUST — THE DECLARATION. Params schema + manifest, pure data, no THREE and no
 * TSL. Same four-way split as `fireflies.js`, and the same engine
 * (`effects/particles/critter-runtime.js`, `kind: 'mote'`).
 *
 * ============================================================================
 * THE IDEA
 * ============================================================================
 *
 * Paint `_Dust` over a room, a barn, a library aisle: the air there is full of
 * tiny motes, drifting, tumbling, riding whatever draught the wind field says
 * reaches that spot. You do not see them in the dim; you see them where the
 * `_Window` light falls, and they take that light's colour — warm gold in the
 * golden hour, white at noon, cool blue under the moon, dimming as a cloud
 * crosses and flickering as rain sheets past the glass, because they are lit by
 * the very light the window effect paints on the floor.
 *
 * What makes it read as AIR and not as a sprinkle of dots on the floor:
 *
 *   • HEIGHT. Every mote floats somewhere in an air column `hoverHeight` deep,
 *     and fire's perspective law `M(h) = D/(D − h)` makes a high mote larger and
 *     pushes it outward from the view's centre, so panning shows real parallax.
 *   • THE SLANTED BEAM. A mote is lit if the SUN'S RAY through it reaches a lit
 *     patch of floor — the floor point it samples is shifted down-sun by its own
 *     height (the shadow handle's shift, the same one a fly's shadow uses), so
 *     the lit motes form a leaning column that stretches out at a low sun.
 *   • DEPTH OF FIELD. A mote far from the focal height is a soft, larger, dimmer
 *     disc; one at it is a crisp pinpoint (`bokeh`).
 *   • GLINTS. Some of a mote's light is a flat flake turning over: it flares when
 *     its face catches the light and goes dark edge-on, faster in a draught.
 *   • LIVING AIR. Each mote is carried by the real wind field where it floats
 *     (still in a sealed room, streaming through a doorway, bent by walls), on top
 *     of slow eddies that carry neighbours together and a gentle rise and fall of
 *     the air itself, so the cloud churns instead of sliding.
 *
 * `_Window`'s own manifest listed this as its deferred `motes` rung ("dust in the
 * beam through the particle engine that already exists"); it lands as its own
 * effect because it needs its own mask — dust is where the author says it is,
 * not wherever a window happens to shine.
 *
 * ⚠️ THE DEFAULTS ARE A FIRST PASS, tuned in the lab and not yet by the author on
 * a real scene.
 *
 * @module effects/critters/dust
 */
import { freezeParams, presenceParams, weatherParams, tokenParams } from './critter-params.js';

export const DUST_PARAMS = freezeParams({
  // ── Presence ─────────────────────────────────────────────────────────────
  ...presenceParams({
    countId: 'countPerZone',
    noun: 'motes',
    unit: 'cloud',
    max: 4000,
    count: 39,
    areaScaling: 1,
    maskSensitivity: 0.41,
    countHelpExtra: 'Most of them are invisible at any moment: a mote only shows while the window light is on it.',
  }),

  // ── Look (the mote itself) ───────────────────────────────────────────────
  size: {
    type: 'float',
    min: 0.5,
    max: 12,
    step: 0.1,
    default: 0.5,
    category: 'Look',
    label: 'Mote size',
    help: 'How big an in-focus mote is, in pixels. Real dust is a speck; a hayloft is bigger chaff.',
  },
  sizeVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.05,
    category: 'Look',
    label: 'Size variation',
    help: 'How much individual motes differ in size: 0 is a uniform haze, 1 mixes specks with flakes.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.3,
    category: 'Look',
    label: 'Opacity',
    help: 'Overall strength of the whole cloud.',
  },
  color: {
    type: 'color',
    space: 'srgb',
    default: '#ffcc80',
    category: 'Look',
    label: 'Dust colour',
    help: 'The colour of the dust itself. The light that falls on it tints it further (see “Takes the light’s colour”), so a pale warm grey reads right in most light.',
  },
  sparkle: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.7,
    category: 'Look',
    label: 'Glints',
    help: 'How much of a mote’s light is a flat flake turning over: it flares as its face catches the light and dims edge-on. 0 is a steady haze of specks. Needs the "glints" quality rung (1) or above.',
  },
  sparkleSharpness: {
    type: 'float',
    min: 1,
    max: 40,
    step: 0.5,
    default: 40,
    category: 'Look',
    label: 'Glint sharpness',
    help: 'How brief each glint is. Low is a slow shimmer; high is a quick, bright wink.',
  },
  bokeh: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0,
    category: 'Look',
    label: 'Depth softness',
    help: 'Depth of field: a mote far above or below the focal height blurs into a larger, fainter disc. 0 keeps every mote a crisp point. Needs the "depth" quality rung (2) or above.',
  },
  focusHeight: {
    type: 'float',
    min: 0,
    max: 400,
    step: 5,
    default: 180,
    category: 'Look',
    label: 'Focal height (px)',
    help: 'The height above the floor that is in sharp focus. Low keeps the floor-level motes crisp and lets the high ones go soft, like a lens looking down into a room.',
  },

  shapeIrregularity: {
    type: 'float',
    min: 0,
    max: 2.5,
    step: 0.05,
    default: 0.55,
    category: 'Look',
    label: 'Shape irregularity',
    help: 'How ragged each mote’s outline is. 0 is a clean oval; 1 is an uneven flake; 2 and over is a shard.',
  },
  flakeThinness: {
    type: 'float',
    min: 0.1,
    max: 1,
    step: 0.05,
    default: 0.85,
    category: 'Look',
    label: 'Flake thinness',
    help: 'How thin the flattest flakes are, as a fraction of their length. 1 makes every mote round; low values make a mix of slivers and chunks.',
  },
  edgeOnSquash: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Look',
    label: 'Edge-on squash',
    help: 'How much a tumbling flake narrows as it turns edge-on to you. Works with Glints. 0 keeps its shape while it flashes.',
  },
  pinpointTightness: {
    type: 'float',
    min: 2,
    max: 40,
    step: 0.5,
    default: 40,
    category: 'Look',
    label: 'Pinpoint tightness',
    help: 'How small and hard the bright core of an in-focus mote is. High is a tiny star; low is a soft fuzzy speck.',
  },
  haloAmount: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: 0.5,
    category: 'Look',
    label: 'Halo',
    help: 'The soft glow around every lit mote. Needs the "sparkle" quality rung (3).',
  },
  starAmount: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 3.5,
    category: 'Look',
    label: 'Star strength',
    help: 'How bright the four-point star on the brightest glints is. Needs the "sparkle" quality rung (3) and Glints above 0.',
  },
  glintFloor: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.02,
    default: 0.04,
    category: 'Look',
    label: 'Glint resting brightness',
    help: 'How bright a flake is between glints, before the average is rebalanced. Low makes glints stand out of a dim haze.',
  },
  colorVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.2,
    category: 'Look',
    label: 'Colour variation',
    help: 'How far each mote leans warm or cool from the dust colour.',
  },
  brightnessVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.75,
    category: 'Look',
    label: 'Brightness variation',
    help: 'How much individual motes differ in brightness, so the cloud is not an even sprinkle.',
  },
  minScreenSize: {
    type: 'float',
    min: 0.5,
    max: 4,
    step: 0.1,
    default: 1.5,
    category: 'Look',
    label: 'Smallest on screen (px)',
    help: 'No mote is drawn smaller than this on screen, however far you zoom out, which stops tiny specks crawling and flickering. Its brightness is scaled back to match.',
  },

  // ── Light ────────────────────────────────────────────────────────────────
  intensity: {
    type: 'float',
    min: 0,
    max: 20,
    step: 0.1,
    default: 20,
    category: 'Light',
    label: 'Brightness in the light',
    help: 'How brightly a mote shines where the window light falls, in HDR units. Above about 1 the brightest glints feed the bloom pass.',
  },
  beamContrast: {
    type: 'float',
    min: 0.5,
    max: 4,
    step: 0.05,
    default: 4,
    category: 'Light',
    label: 'Beam contrast',
    help: 'How sharply the motes divide into lit and unlit. Higher keeps them to the bright heart of the window light; lower lets them glow faintly all through its soft edges.',
  },
  colorFromLight: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Light',
    label: 'Takes the light’s colour',
    help: 'How much the motes take the colour of the light on them — gold at the golden hour, blue under the moon. 0 keeps the dust colour whatever the light is doing.',
  },
  nightOpacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.03,
    category: 'Light',
    label: 'Night opacity ×',
    help: 'How strong the motes are in full dark, as a fraction of their daytime strength. 0.33 keeps them to a third, a subtle drift. Eases in through dusk and out through dawn; 1 keeps them as bright as by day.',
  },
  nightLightColour: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Light',
    label: 'Night takes the light’s colour',
    help: 'After dark, how fully the motes become the colour of the light on them (moon-blue, or the last of the sun) instead of the dust colour. 0 keeps the dust colour at night.',
  },
  lowSunGlow: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Light',
    label: 'Low sun glow ×',
    help: 'Extra brightness when the sun is low: a low sun crosses more air and the dust scatters more of it, so a golden-hour beam is the dustiest-looking of the day. 0 keeps them the same at every hour.',
  },
  beamSlant: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 2,
    category: 'Light',
    label: 'Beam slant ×',
    help: 'How far up-sun a high mote looks for its light: 1 is a real slanted sunbeam (the lit motes lean like a column of light, longer at a low sun); 0 lights each mote from the floor straight under it.',
  },
  ambientGlow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.1,
    category: 'Light',
    label: 'Visible out of the beam',
    help: 'How much the motes show by the room’s own light (torches, lamps, daylight) away from the window light. Low keeps the dust a secret the sunbeam reveals. Needs the "depth" quality rung (2) or above.',
  },

  roomCutoff: {
    type: 'float',
    min: 1,
    max: 1.5,
    step: 0.01,
    default: 1,
    category: 'Light',
    label: 'Room light cutoff ×',
    help: 'How far above the room’s own light the floor must be before it counts as window light. Raise it if dust glows in lamp light or shade; lower it to catch faint beams.',
  },
  hueLimit: {
    type: 'float',
    min: 1,
    max: 4,
    step: 0.1,
    default: 1.2,
    category: 'Light',
    label: 'Light colour limit',
    help: 'The most a window’s colour can tint the dust, as a multiple of white. Lower tames very saturated light.',
  },

  // ── Motion ───────────────────────────────────────────────────────────────
  speed: {
    type: 'float',
    min: 0.1,
    max: 4,
    step: 0.05,
    default: 0.35,
    category: 'Motion',
    label: 'Tempo',
    help: 'A master clock for everything the dust does: drift, swirl, tumble and rise.',
  },
  driftSpeed: {
    type: 'float',
    min: 0,
    max: 60,
    step: 0.5,
    default: 15,
    category: 'Motion',
    label: 'Drift speed',
    help: 'How fast the still air carries a mote along, in pixels per second. Dust is in no hurry.',
  },
  swirl: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1.55,
    category: 'Motion',
    label: 'Swirl',
    help: 'How much the air eddies: slow loops and curls that carry neighbouring motes together, the way real dust moves. 0 is a plain drift.',
  },
  swirlScale: {
    type: 'float',
    min: 20,
    max: 800,
    step: 5,
    default: 60,
    category: 'Motion',
    label: 'Eddy size (px)',
    help: 'How large the air’s eddies are. Small makes a busy, churning cloud; large makes broad, lazy currents.',
  },
  tumble: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 0.4,
    category: 'Motion',
    label: 'Tumble rate',
    help: 'How fast a flake turns over — the rhythm of its glints. A draught makes them tumble faster.',
  },
  updraft: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 2.15,
    category: 'Motion',
    label: 'Rising and sinking air',
    help: 'How far the air itself rises and sinks in slow convection cells, carrying motes up and down through the light. 0 lets every mote hang at its own height.',
  },
  range: {
    type: 'float',
    min: 0,
    max: 400,
    step: 5,
    default: 115,
    category: 'Motion',
    label: 'Spill past the paint (px)',
    help: 'How far beyond the painted edge a mote can drift before it fades out and fresh dust takes its place inside the room. In a draught this is what makes the dust stream through the room instead of piling against the far wall; in still air a gentle turn keeps the cloud where you painted it.',
  },

  wanderAmount: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.8,
    category: 'Motion',
    label: 'Private wander',
    help: 'How much each mote drifts on its own, apart from its neighbours, as a fraction of the drift speed.',
  },
  inertia: {
    type: 'float',
    min: 0.1,
    max: 8,
    step: 0.1,
    default: 0.6,
    category: 'Motion',
    label: 'Inertia (s)',
    help: 'How slowly a mote picks up the air’s speed. Low snaps to every gust; high is heavy and lazy.',
  },
  turbulenceGain: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1.3,
    category: 'Motion',
    label: 'Draught turbulence',
    help: 'How much of the wind grid’s swirl, strongest at doorways, rides on top of its steady flow.',
  },
  eddySpeed: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    category: 'Motion',
    label: 'Eddy speed',
    help: 'How fast the slow loops in the air change shape.',
  },
  convection: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.02,
    default: 0.3,
    category: 'Motion',
    label: 'Convection reach',
    help: 'How far the rising and sinking air carries a mote, as a fraction of the air depth. Scaled by Rising and sinking air.',
  },
  heightEase: {
    type: 'float',
    min: 0.1,
    max: 10,
    step: 0.1,
    default: 5.3,
    category: 'Motion',
    label: 'Height ease (s)',
    help: 'How slowly a mote follows the air up and down.',
  },
  homing: {
    type: 'float',
    min: 0,
    max: 10,
    step: 0.1,
    default: 1.7,
    category: 'Motion',
    label: 'Turn-back strength',
    help: 'How firmly still air steers a mote that has strayed past the painted edge back inside.',
  },
  tokenPush: {
    type: 'float',
    min: 0,
    max: 400,
    step: 5,
    default: 140,
    category: 'Motion',
    label: 'Token shove (px/s)',
    help: 'How hard a nearby token pushes the motes aside.',
  },
  tokenSpin: {
    type: 'float',
    min: 0,
    max: 400,
    step: 5,
    default: 110,
    category: 'Motion',
    label: 'Token wake spin (px/s)',
    help: 'How strongly a token’s passing spins the motes into a curl behind it.',
  },
  fadeInTime: {
    type: 'float',
    min: 0.1,
    max: 10,
    step: 0.1,
    default: 2,
    category: 'Motion',
    label: 'Fade-in time (s)',
    help: 'How long a fresh or replaced mote takes to fade in.',
  },

  // ── Depth ────────────────────────────────────────────────────────────────
  hoverHeight: {
    type: 'float',
    min: 10,
    max: 400,
    step: 5,
    default: 60,
    category: 'Depth',
    label: 'Air depth (px)',
    help: 'How high the dust fills the air, floor to ceiling, in pixels. A deeper column gives more parallax as you pan.',
  },
  perspective: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.05,
    category: 'Depth',
    label: 'Perspective ×',
    help: 'How much being high in the air makes a mote look bigger and pushes it away from the middle of the view. 0 flattens the dust onto the floor; 2 exaggerates the depth.',
  },

  minHeight: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: 0.01,
    category: 'Depth',
    label: 'Lowest mote level',
    help: 'The lowest height motes float at, as a fraction of the air depth. Raise it to lift the whole cloud off the floor.',
  },
  bokehSize: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 0.15,
    category: 'Depth',
    label: 'Defocus size ×',
    help: 'How large an out-of-focus mote grows. Works with Depth softness.',
  },

  // ── Weather ──────────────────────────────────────────────────────────────
  // Dust is not chased off by rain or cold — it is in the air indoors whatever the sky does. A gale
  // through an open door does thin it (it is blown out of the room), and that is all these defaults say.
  ...weatherParams({
    noun: 'motes',
    defaults: {
      rain: 0,
      snow: 0,
      windThreshold: 0.55,
      wind: 0.5,
      coldBelow: 0,
      cold: 0,
      floor: 0.3,
      fadeTime: 0.3,
    },
  }),
  windDrift: {
    type: 'float',
    min: 0,
    max: 600,
    step: 5,
    default: 410,
    category: 'Weather',
    label: 'Wind carries them (px/s)',
    help: 'How fast a full gale would blow a mote along, in pixels per second. Read from the real wind field where each mote is, so a sealed room is still air, a draught through a doorway streams the dust past it, and walls bend the flow.',
  },
  windAgitation: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1.2,
    category: 'Weather',
    label: 'Wind makes them churn ×',
    help: 'How much more the dust swirls and tumbles in wind: the swirl is multiplied by 1 + this × the wind. 0 leaves the eddies as they are in still air.',
  },

  // A token walking through the cloud stirs it: the motes are pushed aside and spun into a little wake.
  ...tokenParams({ noun: 'motes', defaults: { response: 1, radiusPx: 200 } }),
});

/** The Studio card's front-of-house strip. Everything else is on the card's ROH. Held to the schema by a Node test. */
export const DUST_FOH = Object.freeze([
  'countPerZone',
  'intensity',
  'color',
  'size',
  'sparkle',
  'driftSpeed',
  'windDrift',
  'ambientGlow',
]);

/** Built-in presets — see `SMELLY_FLIES_PRESETS`. */
export const DUST_PRESETS = Object.freeze({
  'Library afternoon': Object.freeze({
    countPerZone: 220,
    size: 1.3,
    sparkle: 0.4,
    driftSpeed: 3,
    swirl: 0.7,
    intensity: 2.6,
  }),
  'Hayloft chaff': Object.freeze({
    countPerZone: 420,
    size: 3.2,
    sizeVariation: 0.85,
    color: '#f3d9a6',
    sparkle: 0.8,
    sparkleSharpness: 5,
    tumble: 1.6,
    intensity: 3.6,
  }),
  'Cathedral shafts': Object.freeze({
    countPerZone: 600,
    areaScaling: 1,
    hoverHeight: 360,
    perspective: 1.2,
    beamSlant: 1.4,
    beamContrast: 2.4,
    lowSunGlow: 2,
    driftSpeed: 2.5,
    swirlScale: 420,
    ambientGlow: 0.02,
  }),
  'Stirred up': Object.freeze({
    countPerZone: 700,
    driftSpeed: 16,
    swirl: 2.2,
    swirlScale: 90,
    tumble: 2.5,
    updraft: 1.8,
    tokenStartleResponse: 1,
    tokenStartleRadius: 200,
  }),
  'Faint and fine': Object.freeze({
    countPerZone: 140,
    size: 0.9,
    sizeVariation: 0.3,
    sparkle: 0.2,
    intensity: 1.8,
    bokeh: 1.4,
    ambientGlow: 0,
  }),
});

/** @param {string} name @returns {Record<string, *>} a fresh patch, `{}` for an unknown name. */
export function dustPreset(name) {
  return { ...(DUST_PRESETS[name] ?? {}) };
}

/** THE MANIFEST. */
export const DUST = Object.freeze({
  id: 'dust',
  title: 'Dust',
  // Subtle by design: a handful of lit specks in a sunbeam.
  visualWeight: 0.35,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Builds its mote engine lazily on the first sync that has a painted zone (ensureEngine) — the same synchronous first-run work as the other critters, with no pending window a probe could observe. Covered globally: the kernels grow the pipeline set, which settle.js’s pipeline-growth criterion catches.',
  }),
  params: DUST_PARAMS,
  authoring: Object.freeze({ paint: 'dust' }),

  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'specks',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.01 }),
      adds: 'half the cloud as steady specks lit by the window light, drifting on the wind field',
    }),
    Object.freeze({
      n: 1,
      name: 'glints',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.015 }),
      adds: 'three quarters of the cloud, with flakes that flash as they tumble',
    }),
    Object.freeze({
      n: 2,
      name: 'depth',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.02 }),
      adds: 'the full cloud, with depth of field (soft high motes) and a faint glow by the room’s own lamps (the coloration read)',
    }),
    Object.freeze({
      n: 3,
      name: 'sparkle',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.025 }),
      adds: 'a tiny four-point star on the brightest glints, and a soft halo around each lit mote',
    }),
    Object.freeze({
      n: 4,
      name: 'thick air',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.035 }),
      adds: 'half again as many motes as the author asked for',
    }),
  ]),

  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'shaft',
      note: 'The visible fan of light in the air itself (Window’s own deferred `shaft` rung). The motes already sample the slanted beam; a half-res ray-marched haze along the same slant would join them into one shaft.',
    }),
    Object.freeze({
      name: 'warm-lift',
      note: 'Motes inside the beam rise (the sun warms the air it crosses) and settle in the shade. The window light lives in a TEXTURE and a compute kernel in this renderer never samples one (see critter-zone-sample.js), so the rise needs the beam as a storage buffer or a CPU-side window mask grid first.',
    }),
    Object.freeze({
      name: 'occluded',
      note: 'A mote under a roof tile or an overhead is hidden by the depth gate, but one in a building’s cast shadow is not darkened by it (the window light it samples already is, wherever the window effect darkens its own).',
    }),
  ]),
});
