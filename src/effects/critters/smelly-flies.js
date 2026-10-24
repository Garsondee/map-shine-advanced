/**
 * SMELLY FLIES — THE DECLARATION. Params schema + manifest, pure data, no THREE
 * and no TSL. The agents live in `effects/particles/critter-runtime.js`, their
 * bodies in `fly-body.js`, the perception in `critter-zone.js`
 * and the lifecycle in `critter-subsystem.js`.
 *
 * ⚠️ `apply` IS NOT DECLARED HERE. It is injected at registration (boot.js), so
 * `effects/` never imports the renderer and the manifest stays pure data.
 *
 * ============================================================================
 * WHAT V2 DID, AND WHAT THIS KEEPS
 * ============================================================================
 *
 * V2's `SmellyFliesEffect` spawned flies from map-point groups (a point, a line or
 * an area), drove each fly with a JavaScript state machine — spawning → flying
 * (darting bursts, a soft tether back to a home, drag, a speed limit) → landing →
 * walking (idle / rotate / move inside the polygon) → taking off — drew each as a
 * two-frame sprite (`fly.webp`, `fly_landed.webp`), killed any fly that crossed
 * the indoors/outdoors line, and thinned the swarm in rain and wind. Twelve
 * sliders, `maxParticles` ("Max Flies", 1–30) the headline one.
 *
 * Everything on that list survives, with three structural changes:
 *
 *   • AREAS ARE PAINTED, not placed: `authoring.paint: 'flies'`. Each separate
 *     blob is its own swarm ("paint for regions, place for anchors"). The V2
 *     point/line/area distinction is just a painted dot, stroke or blob.
 *   • THE BODY IS PROCEDURAL. No sprite: the wings beat, the six legs step in a
 *     tripod gait with the feet planted, takeoff and landing have their own
 *     poses, and a soft shadow separates from the body with height. That is what
 *     makes the animation tunable instead of baked.
 *   • THE MIND IS A GPU STATE MACHINE per fly, in a compute kernel — no
 *     per-fly JavaScript object (V2's actual bottleneck). Nothing here needs to
 *     match between players, and nothing about it affects play.
 *
 * NEW: flies sleep at night (`nightActivity`), a fly grooms (rubs its legs) while it idles,
 * and the weather has a dial per cause — rain, snow, wind above a threshold, and cold each
 * thin the swarm by their own response, and the air carries a flying fly downwind
 * (`critter-weather.js`). Maggots are their OWN effect with their own mask (`maggots.js`,
 * `_Maggots`): a corpse wants both, a puddle of blood only flies.
 *
 * ⚠️ THE DEFAULTS ARE A FIRST PASS, tuned in the lab and not yet by the author on
 * a real scene. Ranges are deliberately generous — "I'll find the values" is this
 * project's standing request for a new look.
 *
 * @module effects/critters/smelly-flies
 */
import { FLY_LOOKS } from './critter-species.js';
import { freezeParams, presenceParams, weatherParams, tokenParams } from './critter-params.js';

export const SMELLY_FLIES_PARAMS = freezeParams({
  // ── Presence ─────────────────────────────────────────────────────────────
  ...presenceParams({
    countId: 'fliesPerZone',
    noun: 'flies',
    unit: 'swarm',
    max: 200,
    count: 5,
    areaScaling: 0.5,
    countHelpExtra: 'V2 called this Max Flies and stopped at 30.',
  }),

  // ── Look ─────────────────────────────────────────────────────────────────
  size: {
    type: 'float',
    min: 4,
    max: 120,
    step: 1,
    default: 4,
    category: 'Look',
    label: 'Fly size',
    help: 'Body length in pixels. V2’s Flying Scale was 18.',
  },
  sizeVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.25,
    category: 'Look',
    label: 'Size variation',
    help: 'How much individual flies differ in size.',
  },
  species: {
    type: 'enum',
    values: [...FLY_LOOKS],
    default: 'mixed',
    category: 'Look',
    label: 'Kind of fly',
    help: 'Mixed rolls a kind for each fly. Housefly is grey with a striped back; bluebottle and greenbottle are the metallic blowflies that find a corpse first; flesh fly has a chequered abdomen.',
  },
  tint: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Look',
    label: 'Tint',
    help: 'Multiplies the fly’s own colouring. White is a no-op.',
  },
  eyeColor: {
    type: 'color',
    space: 'srgb',
    default: '#80160d',
    category: 'Look',
    label: 'Eye colour',
    help: 'The compound eyes. Houseflies are the red-brown of the default; a pale orange or a deep crimson reads as a different species at a glance.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Opacity',
    help: 'Overall opacity of the flies (and their shadows).',
  },
  lightInfluence: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Lit by the scene',
    help: 'How much the scene’s own lighting darkens and tints a fly: 1 puts it in the torchlight or the gloom like everything else, 0 draws it full-bright whatever the room is doing. Needs the "lit" quality rung (2) or above.',
  },
  shadowStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.45,
    category: 'Look',
    label: 'Shadow',
    help: 'How dark the fly’s shadow on the ground is. It slides away from the body as the fly climbs and merges back when it lands — the cue that tells the eye the fly is airborne.',
  },
  shadowSoftness: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Shadow softness ×',
    help: 'How blurred the shadow is, as a multiple of what the sky’s own cloud cover and sun height give it. Under 1 is a hard noon shadow; over 1 is the smudge under an overcast sky.',
  },

  // ── Detail ───────────────────────────────────────────────────────────────
  wingBlur: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Wing blur',
    help: 'How smeared the wings are when flapping fast. 1 is the translucent fan a real fly shows at 60 fps; 0 draws crisp wings frozen at one angle (V2’s Motion Blur switch, as a dial).',
  },
  wingOpacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Wing opacity',
    help: 'How solid the wings are. Lower is the near-invisible gauze of a small fly; 1 is the default glassy pane with its veins.',
  },
  wingSpread: {
    type: 'float',
    min: 0.7,
    max: 1.25,
    step: 0.01,
    default: 1,
    category: 'Detail',
    label: 'Wing spread ×',
    help: 'How wide the wings are held in flight, and how far they beat. Under 1 is the tight, rapid buzz of a small fly; over 1 is a lumbering blowfly with its wings out.',
  },
  sheen: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Metallic sheen',
    help: 'How glossy a bluebottle’s or greenbottle’s back is. 0 is matte, 2 a lacquered gem. Needs the "detail" quality rung (3) or above.',
  },
  legWeight: {
    type: 'float',
    min: 0.5,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Leg thickness ×',
    help: 'How thick the legs are drawn. Thicker reads better from far away; thinner is a crane-fly’s spidery limbs. Needs the "legs" quality rung (1) or above.',
  },
  bankAmount: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Banking ×',
    help: 'How far a fly leans into a turn, the two wings no longer symmetrical. 0 holds it level like a drawing. Needs the "detail" quality rung (3) or above.',
  },

  // ── Motion (flight) ──────────────────────────────────────────────────────
  buzz: {
    type: 'float',
    min: 200,
    max: 4000,
    step: 50,
    default: 4000,
    category: 'Motion',
    label: 'Buzz intensity',
    help: 'How hard a fly darts. Each dart is a short burst in a random direction (a twentieth to a quarter of a second), so this is the jitter in the flight path. V2’s Buzz Intensity.',
  },
  tether: {
    type: 'float',
    min: 1,
    max: 100,
    step: 1,
    default: 10,
    category: 'Motion',
    label: 'Tether strength',
    help: 'How strongly a fly that has strayed is steered back to its own home spot in the swarm. Low lets them roam the whole zone; high keeps each one in a tight personal cloud.',
  },
  swarmRadius: {
    type: 'float',
    min: 20,
    max: 600,
    step: 5,
    default: 600,
    category: 'Motion',
    label: 'Swarm radius',
    help: 'How far, in pixels, a fly wanders from its home spot before the tether starts to pull. V2 hard-coded 100.',
  },
  maxSpeed: {
    type: 'float',
    min: 100,
    max: 3000,
    step: 50,
    default: 450,
    category: 'Motion',
    label: 'Top speed',
    help: 'The fastest a fly can travel through the air, in pixels per second.',
  },
  landChance: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.005,
    default: 0.1,
    category: 'Motion',
    label: 'Land chance (per second)',
    help: 'The chance each second that a flying fly decides to land, if it is over its zone. 0 keeps the whole swarm in the air forever.',
  },
  landingTime: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 0.8,
    category: 'Motion',
    label: 'Landing time (s)',
    help: 'How long the descent takes: the fly slows, drops its legs, flares its wings and folds them on touchdown.',
  },
  takeoffTime: {
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 0.5,
    category: 'Motion',
    label: 'Take-off time (s)',
    help: 'How long a take-off takes: a crouch, the wings snapping open and beating up to a blur, then the climb.',
  },
  hoverBob: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Hover bob ×',
    help: 'How much a flying fly bobs up and down as it hovers. 0 holds a perfectly level altitude; higher is a drunken, bouncing flight.',
  },
  speed: {
    type: 'float',
    min: 0.1,
    max: 6,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Tempo',
    help: 'A master clock for the flies’ decisions — how quickly they dart, land, walk and pause. 1 is the natural pace; V2’s Speed slider defaulted to 2.75 and scaled everything.',
  },

  // ── Ground (landed flies) ────────────────────────────────────────────────
  walkSpeed: {
    type: 'float',
    min: 5,
    max: 400,
    step: 5,
    default: 60,
    category: 'Ground',
    label: 'Walk speed',
    help: 'How fast a landed fly walks, in pixels per second. The legs keep their feet planted at any speed, so this never makes them slide.',
  },
  takeoffChance: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.005,
    default: 0.04,
    category: 'Ground',
    label: 'Take-off chance (per second)',
    help: 'The chance each second that a walking fly takes off again. 0 leaves landed flies on the ground for good.',
  },
  groomChance: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.6,
    category: 'Ground',
    label: 'Grooming',
    help: 'How much of a landed fly’s idle time is spent grooming — rubbing its front legs together, or its back legs along the wings — instead of standing still.',
  },
  pauseMin: {
    type: 'float',
    min: 0.1,
    max: 20,
    step: 0.1,
    default: 0.6,
    category: 'Ground',
    label: 'Shortest pause (s)',
    help: 'The shortest a landed fly stops between walks.',
  },
  pauseMax: {
    type: 'float',
    min: 0.2,
    max: 30,
    step: 0.1,
    default: 2.5,
    category: 'Ground',
    label: 'Longest pause (s)',
    help: 'The longest a landed fly stops between walks.',
  },

  // ── Depth ────────────────────────────────────────────────────────────────
  flyHeight: {
    type: 'float',
    min: 5,
    max: 400,
    step: 5,
    default: 80,
    category: 'Depth',
    label: 'Fly height',
    help: 'How high above the ground a flying fly hovers. Height makes it look bigger (it is nearer the camera), throws its shadow further away, and is what the landing and take-off animations travel between.',
  },
  perspective: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Depth',
    label: 'Perspective ×',
    help: 'How much being high in the air makes a fly look bigger and pushes it away from the middle of the view. 0 flattens the swarm onto the ground; 2 exaggerates the sense of depth.',
  },

  // ── Twilight ─────────────────────────────────────────────────────────────
  nightActivity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.1,
    category: 'Twilight',
    label: 'Flies at night',
    help: 'The fraction of the swarm still out after dark. Flies are daytime insects; at 0 they all vanish at dusk and return at dawn, one by one.',
  },

  // ── Weather ──────────────────────────────────────────────────────────────
  ...weatherParams({
    noun: 'flies',
    defaults: {
      rain: 0.85,
      snow: 1,
      windThreshold: 0.35,
      wind: 0.8,
      coldBelow: 0.3,
      cold: 1,
      floor: 0.1,
      fadeTime: 2.5,
    },
  }),
  windDrift: {
    type: 'float',
    min: 0,
    max: 500,
    step: 5,
    default: 140,
    category: 'Weather',
    label: 'Wind carries them (px/s)',
    help: 'How fast a full gale blows a flying fly downwind, in pixels per second. They fight back — the tether and the paint’s edge hold the swarm over its zone — so this shifts the cloud downwind and smears it, rather than blowing it away. Landed flies are not moved.',
  },
  windAgitation: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1.2,
    category: 'Weather',
    label: 'Wind makes them frantic ×',
    help: 'How much more violently a fly darts in wind: its buzz is multiplied by 1 + this × the wind. 0 leaves their flight untouched.',
  },
  rainShelter: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Weather',
    label: 'Rain drives them down',
    help: 'How strongly rain or snow makes the flies that stay land and stay landed: more landing, less taking off. The ones the rain has not cleared sit tight on the ground.',
  },
  coldSlowdown: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.6,
    category: 'Weather',
    label: 'Cold slows them',
    help: 'How sluggish the cold makes the flies that remain: every decision, dart and step slows. Uses the same "too cold below" temperature.',
  },

  // ⭐ TOKENS — the "startle" idea this file used to only DEFER (see this module's own history):
  // "flies scattering when a token walks through the swarm... a disturbance source — a small
  // list of token positions". `critter-token.js`/`critter-subsystem.js` supply it now.
  ...tokenParams({ noun: 'flies', defaults: { response: 0.8, radiusPx: 140 } }),
});

/**
 * The Studio card's front-of-house strip: the handful of controls a GM reaches for while running a scene (how many,
 * how big, which flies, how restless, how they land, whether they keep out after dark, and the two weather
 * responses). Everything else is on the card's ROH, grouped by category. Held to the schema by a Node test.
 */
export const SMELLY_FLIES_FOH = Object.freeze([
  'fliesPerZone',
  'size',
  'species',
  'buzz',
  'landChance',
  'nightActivity',
  'rainResponse',
  'windResponse',
]);

/**
 * Built-in presets: a named patch of the params above. Each is a starting point, not a prison — every
 * control stays live after one is applied. `critter-declarations.test.mjs` holds every key to the schema.
 */
export const SMELLY_FLIES_PRESETS = Object.freeze({
  'Corpse swarm': Object.freeze({ fliesPerZone: 24, buzz: 1800, landChance: 0.12, size: 16, areaScaling: 0.7 }),
  'Lazy afternoon': Object.freeze({
    fliesPerZone: 6,
    buzz: 900,
    landChance: 0.2,
    takeoffChance: 0.03,
    speed: 0.8,
    hoverBob: 1.6,
    swarmRadius: 140,
  }),
  Plague: Object.freeze({ fliesPerZone: 60, areaScaling: 0.9, buzz: 2200, size: 14, maxSpeed: 800, tether: 12 }),
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
  'Fair-weather flies': Object.freeze({
    rainResponse: 1,
    snowResponse: 1,
    windThreshold: 0.15,
    windResponse: 1,
    coldBelow: 0.45,
    coldResponse: 1,
    weatherFloor: 0,
    windDrift: 260,
  }),
});

/** @param {string} name @returns {Record<string, *>} a fresh patch, `{}` for an unknown name. */
export function smellyFliesPreset(name) {
  return { ...(SMELLY_FLIES_PRESETS[name] ?? {}) };
}

/**
 * THE MANIFEST.
 *
 * `photosensitive: false`: nothing flashes. Wing blur is a static translucent fan,
 * not a strobe, and a fly is a few pixels.
 */
export const SMELLY_FLIES = Object.freeze({
  id: 'smellyFlies',
  title: 'Smelly flies',
  // Ambient decoration, fewer and smaller than fire's whole-screen light.
  visualWeight: 0.4,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Builds its fly engine lazily on the first sync that has a painted zone (ensureEngine) — real first-run work (two compute kernels and two materials), but SYNCHRONOUS, with no pending window a probe could observe, and a "built yet?" flag would hold readiness open forever on a scene with no flies painted. It is covered globally instead: the engine’s kernels grow the pipeline set, which is precisely what settle.js’s pipeline-growth criterion exists to catch.',
  }),
  params: SMELLY_FLIES_PARAMS,
  authoring: Object.freeze({ paint: 'flies' }),

  /**
   * THE LADDER — what each rung buys, as flags `critter-species.js#critterTierPlan`
   * hands the material builders at graph-build time. Cost classes are
   * non-decreasing from rung 1 (Effects.md Law 3); rung 0 is the admission price.
   * The tests assert this ladder against `critter-species.js#CRITTER_TIER_COUNT`
   * and the `standard` profile against `CRITTER_DEFAULT_TIER`, so the plan table
   * and the ladder cannot drift apart.
   */
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'specks',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.02 }),
      adds: 'half the swarm, each a fly silhouette with the beating-wing fan and no legs, shadow or lighting — right place, right motion, as cheap as the effect gets',
    }),
    Object.freeze({
      n: 1,
      name: 'legs',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.03 }),
      adds: 'three quarters of the swarm, now with six legs stepping in a tripod gait with planted feet, and the walk, landing and take-off poses',
    }),
    Object.freeze({
      n: 2,
      name: 'lit',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.05 }),
      adds: 'the full swarm, lit by the scene (two illumination reads), with a ground shadow that parts from the body with height and crisp wing veins',
    }),
    Object.freeze({
      n: 3,
      name: 'detail',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.07 }),
      adds: 'grooming, banking into turns, and the metallic sheen of a bluebottle’s back',
    }),
    Object.freeze({
      n: 4,
      name: 'plague',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.09 }),
      adds: 'a quarter more flies than the author asked for',
    }),
  ]),

  /** Recorded, genuinely not built — the list this effect is judged against. */
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'startle',
      note: 'Flies scattering when a token walks through the swarm, so a landed fly takes off ahead of a footstep. The kernel already has the takeoff transition; what it lacks is a disturbance source — a small list of token positions in the same storage buffer as the zone field.',
    }),
    Object.freeze({
      name: 'placed-swarms',
      note: 'A flies anchor kind (scene/anchor-catalog.js) for a swarm around one placed point, and the V2 map-point import that would feed it. V2 point groups paint as a small dot today; area and line groups have no importer.',
    }),
    Object.freeze({
      name: 'carrion-glow',
      note: 'Flies landing on a token that is dead or a corpse prop, rather than only on painted ground. Needs the corpse state from the token proxy.',
    }),
  ]),
});
