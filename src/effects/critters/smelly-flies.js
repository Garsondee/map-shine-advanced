/**
 * SMELLY FLIES — THE DECLARATION. Params schema + manifest, pure data, no THREE
 * and no TSL. The agents live in `effects/particles/critter-runtime.js`, their
 * bodies in `fly-body.js` / `maggot-body.js`, the perception in `critter-zone.js`
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
 * NEW: maggots (`maggotsPerZone`) wriggle where the flies gather, flies sleep at
 * night (`nightActivity`), and a fly grooms (rubs its legs) while it idles.
 *
 * ⚠️ THE DEFAULTS ARE A FIRST PASS, tuned in the lab and not yet by the author on
 * a real scene. Ranges are deliberately generous — "I'll find the values" is this
 * project's standing request for a new look.
 *
 * @module effects/critters/smelly-flies
 */
import { FLY_LOOKS } from './critter-species.js';

export const SMELLY_FLIES_PARAMS = Object.freeze({
  // ── Swarm ────────────────────────────────────────────────────────────────
  fliesPerZone: {
    type: 'int',
    min: 0,
    max: 200,
    step: 1,
    default: 10,
    category: 'Swarm',
    label: 'Flies per swarm',
    help: 'How many flies hover over a painted blob of reference size (about two and a half grid squares across). Every separate painted blob is its own swarm. V2 called this Max Flies and stopped at 30.',
  },
  areaScaling: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Swarm',
    label: 'Bigger blob, bigger swarm',
    help: '0 gives every painted blob the same number of flies, as V2 did. 1 makes the swarm proportional to the blob’s area, so a painted marsh buzzes and a painted puddle does not.',
  },
  maskSensitivity: {
    type: 'float',
    min: 0.02,
    max: 0.6,
    step: 0.01,
    default: 0.15,
    category: 'Swarm',
    label: 'Mask sensitivity',
    help: 'How much paint counts as part of a swarm’s zone. LOWER catches faint or thin strokes — turn it DOWN if flies you painted are not appearing. HIGHER wants bold, solid paint.',
  },

  // ── Flight ───────────────────────────────────────────────────────────────
  buzz: {
    type: 'float',
    min: 200,
    max: 4000,
    step: 50,
    default: 1500,
    category: 'Flight',
    label: 'Buzz intensity',
    help: 'How hard a fly darts. Each dart is a short burst in a random direction (a twentieth to a quarter of a second), so this is the jitter in the flight path. V2’s Buzz Intensity.',
  },
  tether: {
    type: 'float',
    min: 1,
    max: 100,
    step: 1,
    default: 20,
    category: 'Flight',
    label: 'Tether strength',
    help: 'How strongly a fly that has strayed is steered back to its own home spot in the swarm. Low lets them roam the whole zone; high keeps each one in a tight personal cloud.',
  },
  swarmRadius: {
    type: 'float',
    min: 20,
    max: 600,
    step: 5,
    default: 100,
    category: 'Flight',
    label: 'Swarm radius',
    help: 'How far, in pixels, a fly wanders from its home spot before the tether starts to pull. V2 hard-coded 100.',
  },
  maxSpeed: {
    type: 'float',
    min: 100,
    max: 3000,
    step: 50,
    default: 600,
    category: 'Flight',
    label: 'Top speed',
    help: 'The fastest a fly can travel, in pixels per second.',
  },
  flyHeight: {
    type: 'float',
    min: 5,
    max: 400,
    step: 5,
    default: 80,
    category: 'Flight',
    label: 'Fly height',
    help: 'How high above the ground a flying fly hovers. Height makes it look bigger (it is nearer the camera), throws its shadow further away, and is what the landing and take-off animations travel between.',
  },
  landChance: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.005,
    default: 0.1,
    category: 'Flight',
    label: 'Land chance (per second)',
    help: 'The chance each second that a flying fly decides to land, if it is over its zone. 0 keeps the whole swarm in the air forever.',
  },
  landingTime: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 0.8,
    category: 'Flight',
    label: 'Landing time (s)',
    help: 'How long the descent takes: the fly slows, drops its legs, flares its wings and folds them on touchdown.',
  },
  takeoffTime: {
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 0.5,
    category: 'Flight',
    label: 'Take-off time (s)',
    help: 'How long a take-off takes: a crouch, the wings snapping open and beating up to a blur, then the climb.',
  },

  // ── Ground ───────────────────────────────────────────────────────────────
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

  // ── Look ─────────────────────────────────────────────────────────────────
  size: {
    type: 'float',
    min: 6,
    max: 120,
    step: 1,
    default: 18,
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
  wingBlur: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Wing blur',
    help: 'How smeared the wings are when flapping fast. 1 is the translucent fan a real fly shows at 60 fps; 0 draws crisp wings frozen at one angle (V2’s Motion Blur switch, as a dial).',
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
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Opacity',
    help: 'Overall opacity of the flies and maggots.',
  },

  // ── Behaviour ────────────────────────────────────────────────────────────
  speed: {
    type: 'float',
    min: 0.1,
    max: 6,
    step: 0.05,
    default: 1,
    category: 'Behaviour',
    label: 'Tempo',
    help: 'A master clock for the flies’ decisions — how quickly they dart, land, walk and pause. 1 is the natural pace; V2’s Speed slider defaulted to 2.75 and scaled everything.',
  },
  nightActivity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.1,
    category: 'Behaviour',
    label: 'Flies at night',
    help: 'The fraction of the swarm still out after dark. Flies are daytime insects; at 0 they all vanish at dusk and return at dawn, one by one.',
  },
  weatherResponse: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Behaviour',
    label: 'Weather response',
    help: 'How much rain and wind thin the swarm (V2’s own rule: down to a tenth in a gale and a downpour). 0 makes them indifferent to weather.',
  },

  // ── Maggots ──────────────────────────────────────────────────────────────
  maggotsPerZone: {
    type: 'int',
    min: 0,
    max: 300,
    step: 1,
    default: 0,
    category: 'Maggots',
    label: 'Maggots per swarm',
    help: 'How many maggots wriggle on a blob of reference size. They live in the same painted zones as the flies, so a corpse gets both. 0 is none — the slider to reach for if you want it grosser.',
  },
  maggotSize: {
    type: 'float',
    min: 6,
    max: 120,
    step: 1,
    default: 20,
    category: 'Maggots',
    label: 'Maggot size',
    help: 'Body length in pixels.',
  },
  maggotSpeed: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Maggots',
    label: 'Crawl speed ×',
    help: 'How fast maggots crawl. Even at 1 they mostly writhe in place, then shuffle a body length or so and stop.',
  },
  maggotWriggle: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Maggots',
    label: 'Wriggle ×',
    help: 'How violently the body writhes — the sideways S-wave and the squeeze-and-stretch along its length.',
  },
  maggotClustering: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.6,
    category: 'Maggots',
    label: 'Clustering',
    help: 'How strongly maggots pile toward the middle of a zone, where the thing they are eating is. 0 spreads them evenly over the paint.',
  },
  maggotColor: {
    type: 'color',
    space: 'srgb',
    default: '#e6dcb8',
    category: 'Maggots',
    label: 'Maggot colour',
    help: 'The body colour. Real maggots run from cream to dull yellow.',
  },
});

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
    why: 'Builds its fly and maggot engines lazily on the first sync that has a painted zone (ensureEngines) — real first-run work (two compute kernels and two materials), but SYNCHRONOUS, with no pending window a probe could observe, and a "built yet?" flag would hold readiness open forever on a scene with no flies painted. It is covered globally instead: each engine’s kernels grow the pipeline set, which is precisely what settle.js’s pipeline-growth criterion exists to catch.',
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
      adds: 'a quarter more flies and maggots than the author asked for',
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
