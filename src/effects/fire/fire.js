/**
 * FIRE — THE DECLARATION. Params schema + manifest, pure data, no THREE and no
 * TSL. The runtime lives in `fire-render.js` (the TSL material), the physics in
 * `fire-geometry.js` (pure math, Node-tested), and the lifecycle in
 * `fire-subsystem.js` — the same four-way split `candle-flame.js` and
 * `lightning.js` use.
 *
 * ⚠️ `apply` IS NOT DECLARED HERE. It is injected at registration by `boot.js`,
 * so `effects/` never imports the renderer and the manifest stays pure data.
 *
 * ⚠️ PLACEMENT IS NOT DECLARED HERE EITHER. `scene/anchor-catalog.js` already
 * carries `effectId: 'fire'` on the fire anchor kind, and a second declaration
 * would drift (`effect-manifest.js:54`).
 *
 * @module effects/fire/fire
 */

/**
 * THE PARAMS.
 *
 * ⚠️ NOTE HOW FEW THERE ARE. V2's fire shipped **167 controls**
 * (`docs/reference/v2-effect-params/fire-effect.md`), several of which were
 * dead on arrival — `coalBedScrollSpeed` was literally labelled "Scroll
 * (unused)", `smokeSizeGrowth` was "(Legacy)", and `fireSize` existed in
 * `params` with no schema entry at all. The reason there are ~20 here is not
 * restraint for its own sake: almost everything V2 exposed as a slider is
 * DERIVED from `diameterPx` in `fire-geometry.js#fireScaleChain`, because it
 * genuinely is derived — puff frequency, plume height, turbulence, smoke
 * production, light radius and flicker depth all follow from how big the fire
 * is. A control that lets you set a bonfire's flicker rate to a candle's is not
 * a feature; it is a way to make the fire stop reading as a fire.
 */
export const FIRE_PARAMS = Object.freeze({
  // ── Presence ──────────────────────────────────────────────────────────────
  intensity: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Presence',
    label: 'Fire intensity',
    help: 'How hard everything burns. Above 1 pushes hotter and brighter; below 1 banks it down toward embers.',
  },
  fuel: {
    type: 'enum',
    values: ['wood', 'coal', 'oil', 'magical'],
    default: 'wood',
    category: 'Presence',
    label: 'Fuel',
    help: 'What is burning. Wood is the default look; coal burns deeper and lower; oil is tall and very sooty; magical is hue-shifted for the unnatural stuff.',
  },
  maskSensitivity: {
    type: 'float',
    min: 0.02,
    max: 0.6,
    step: 0.01,
    default: 0.2,
    category: 'Presence',
    label: 'Mask sensitivity',
    help: 'How much of the painted fire mask counts as real paint before a fire registers there. LOWER catches fainter or smaller painted strokes — turn this DOWN if fire you painted is not appearing. HIGHER requires bolder, more solid paint before a fire lights at all.',
  },

  // ── Look ──────────────────────────────────────────────────────────────────
  color: {
    type: 'color',
    space: 'srgb',
    default: '#fdba35',
    category: 'Look',
    label: 'Flame tint',
    help: 'Tints the flame only — never the smoke, which is lit by the fire rather than made of it.',
  },
  posterize: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.85,
    category: 'Look',
    label: 'Banding',
    help: 'How hard the colour steps between temperature bands. 0 is a smooth photographic ramp; 1 is flat cel-shaded bands. The painted reference look sits high.',
  },
  bandCount: {
    type: 'int',
    min: 3,
    max: 12,
    step: 1,
    default: 7,
    category: 'Look',
    label: 'Band count',
    help: 'How many distinct colour steps the banding uses. Fewer reads as more stylised.',
  },
  brightness: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Flame brightness',
    help: 'Master brightness for the flame itself. Push it too far and the banding blows out into a flat disc.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // THE TUNING SET (2026-08-09) — the author drives the look from here.
  //
  // ⚠️ EVERY RANGE HERE IS DELIBERATELY ABSURD, AND THAT IS THE REQUIREMENT.
  // Author: *"give me lots of controls... critically I want you to give me
  // extremely wide ranges for everything. I'll find better values for you."*
  // A slider that cannot reach the answer is worse than no slider — it quietly
  // rules out the region the answer was in. So these span far past anything
  // plausible in both directions, and the DEFAULT of every multiplier is 1.0,
  // meaning "exactly the V2-derived constant". A value is therefore always
  // readable as a distance from the reference rather than an absolute nobody
  // can calibrate.
  // ══════════════════════════════════════════════════════════════════════════

  // ── Flame ─────────────────────────────────────────────────────────────────
  flameCount: {
    type: 'float',
    min: 0,
    max: 200,
    step: 1,
    default: 47,
    category: 'Flame',
    label: 'Flame count',
    help: 'Flame sprites per fire, PER ARCHETYPE — there are four, so the real total is four times this. V2 ran about 51 for a whole floor.',
  },
  flameLifeScale: {
    type: 'float',
    min: 0.05,
    max: 30,
    step: 0.05,
    default: 1.1,
    category: 'Flame',
    label: 'Flame lifetime ×',
    help: 'Multiplies how long each flame sprite lives (base 2.4-4.2s). Short lives read as puffs that vanish; long ones as a steady body of fire.',
  },
  flameSizeScale: {
    type: 'float',
    min: 0.02,
    max: 20,
    step: 0.02,
    default: 1.22,
    category: 'Flame',
    label: 'Flame size ×',
    help: 'Multiplies sprite size on top of the automatic scaling to the fire’s painted width.',
  },
  flameOpacity: {
    type: 'float',
    min: 0,
    max: 20,
    step: 0.05,
    default: 0.85,
    category: 'Flame',
    label: 'Flame opacity ×',
    help: 'How solid each flame sprite is. Raise this if the fire looks thin or washed out.',
  },
  flameEmission: {
    type: 'float',
    min: 0,
    max: 50,
    step: 0.1,
    default: 50,
    category: 'Flame',
    label: 'Flame emission ×',
    help: 'Raw brightness of the flame colour. Above about 3 the hues start saturating toward white where sprites overlap — that is the "white blur" failure.',
  },
  flameColorAge: {
    type: 'float',
    min: 0.1,
    max: 12,
    step: 0.05,
    default: 12,
    category: 'Flame',
    label: 'Colour cooling rate',
    help: 'How fast a sprite walks down the reference ramp. LOW = stays pale/white-hot for most of its life. HIGH = drops to deep orange and rust almost immediately. This is the orange-vs-white dial.',
  },
  flameSpawnBias: {
    type: 'float',
    min: -20,
    max: 20,
    step: 0.1,
    default: 0,
    category: 'Flame',
    label: 'Spawn brightness bias',
    help: 'Which painted texels flames prefer to spawn on. 0 = evenly across every painted texel, matching intensity to shade. Positive pulls spawns toward the brightest paint; negative toward the darkest. Saturates well before the ends of the range — no need to reach them.',
  },
  flameCohesion: {
    type: 'float',
    min: -2,
    max: 3,
    step: 0.02,
    default: 0,
    category: 'Flame',
    label: 'Cohesion (pull together)',
    help: 'Pulls every flame toward its fire’s own centre of mass. 0 = spawns spread across the full painted shape (the default — OFF). 1 = every flame collapses onto that single point. Negative pushes flames apart instead, beyond their painted region. ⚠ A good idea, currently buggy — the author has found the live result unreliable, so this defaults off until it is fixed. Move it off 0 to experiment, not to rely on.',
  },

  // ── Ember ─────────────────────────────────────────────────────────────────
  emberCount: {
    type: 'float',
    min: 0,
    max: 200,
    step: 1,
    default: 39,
    category: 'Ember',
    label: 'Ember count',
    help: 'Sparks per fire. V2 ran about 95 for a whole floor.',
  },
  emberSizeScale: {
    type: 'float',
    min: 0.02,
    max: 20,
    step: 0.02,
    default: 1,
    category: 'Ember',
    label: 'Ember size ×',
    help: 'Base is 2.3-8.7 world px — already a third of V2’s own, at the author’s request.',
  },
  emberLifeScale: {
    type: 'float',
    min: 0.05,
    max: 30,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Ember lifetime ×',
    help: 'How long a spark survives. Longer lives let embers travel further from the fire before dying.',
  },
  emberChaos: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Ember chaos ×',
    help: 'Strength of the swirling flow that pushes embers around. 0 leaves them drifting only with wind.',
  },
  emberRise: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Ember rise ×',
    help: 'How fast embers climb. Height drives the perspective effect, so this also controls how much they grow and splay outward as they go.',
  },
  emberEmission: {
    type: 'float',
    min: 0,
    max: 50,
    step: 0.1,
    default: 1,
    category: 'Ember',
    label: 'Ember brightness ×',
    help: 'Embers are ~8x hotter than flames by design — that ratio is what makes a tiny dot read as a spark rather than a speck.',
  },

  // ── Smoke ─────────────────────────────────────────────────────────────────
  smokeCount: {
    type: 'float',
    min: 0,
    max: 400,
    step: 1,
    default: 24,
    category: 'Smoke',
    label: 'Smoke count',
    help: 'Smoke puffs per fire. V2 ran about 139 for a whole floor.',
  },
  smokeSizeScale: {
    type: 'float',
    min: 0.02,
    max: 20,
    step: 0.02,
    default: 1,
    category: 'Smoke',
    label: 'Smoke size ×',
    help: 'Base is 151-400 world px, and a plume SHOULD outgrow the fire that made it.',
  },
  smokeLifeScale: {
    type: 'float',
    min: 0.05,
    max: 30,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke lifetime ×',
    help: 'Longer-lived smoke drifts further and builds a denser column.',
  },
  smokeOpacity: {
    type: 'float',
    min: 0,
    max: 20,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke opacity ×',
    help: 'Smoke is the one layer that DARKENS the map rather than adding light, so this genuinely obscures what is beneath it.',
  },
  smokeGrowth: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke spread ×',
    help: 'How much a puff swells over its life. Base is a 10x expansion.',
  },
  smokeRise: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke rise ×',
    help: 'How fast smoke climbs, which drives its perspective growth and outward drift.',
  },

  // ── Depth ─────────────────────────────────────────────────────────────────
  perspective: {
    type: 'float',
    min: 0,
    max: 20,
    step: 0.05,
    default: 1,
    category: 'Depth',
    label: 'Perspective strength',
    help: 'Fakes V2’s perspective camera per particle: risen particles grow and splay away from the view centre. 1 = V2 exactly (camera 1000 units up). 0 = perfectly flat. Best judged while panning.',
  },

  // ── Detail ────────────────────────────────────────────────────────────────
  smokeAmount: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Smoke',
    help: 'How much smoke this fire makes, on top of what its size already implies. 0 turns it off entirely.',
  },
  grain: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Detail',
    label: 'Smoke grain',
    help: 'The dry-brush speckle and soot flecks through the smoke. The painted reference has quite a lot of this.',
  },

  // ── Light ─────────────────────────────────────────────────────────────────
  lightEnabled: {
    type: 'bool',
    default: true,
    category: 'Light',
    label: 'Cast light',
    help: 'Whether this fire lights the scene. Turning it off is by far the biggest performance saving fire offers — a fire costs what its LIGHT costs.',
  },
  lightRadiusScale: {
    type: 'float',
    min: 0.25,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Light',
    label: 'Light reach',
    help: "Scales the light radius the fire's size already implies. This is the single most expensive number in the effect — doubling it roughly quadruples the light's cost.",
  },
  lightColor: {
    type: 'color',
    space: 'srgb',
    default: '#ff9a3c',
    category: 'Light',
    label: 'Light colour',
    help: "The colour this fire throws into the room, separate from the flame's own tint.",
  },

  // ── Motion ────────────────────────────────────────────────────────────────
  windResponse: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Wind response',
    help: 'How far wind leans the plume. The lean grows with height on its own, so a tall fire streams further than a short one at the same setting.',
  },
  animationSpeed: {
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Speed',
    help: 'How fast the fire itself moves — the flame silhouette boiling and the turbulence carrying embers and smoke. Separate from the Life× dials (how long a particle survives) and the chaos/rise dials (how hard it gets pushed around).',
  },

  // ── Response ──────────────────────────────────────────────────────────────
  weatherResponse: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Response',
    label: 'Weather response',
    help: 'How much rain and wind affect this fire. At 1, rain cools and steams it and a hard enough gale blows it out; at 0 it burns regardless.',
  },
  canBeSnuffed: {
    type: 'bool',
    default: true,
    category: 'Response',
    label: 'Can blow out',
    help: 'Whether a strong enough wind can put this fire out. The threshold scales with size on its own — a lamp gutters in a breeze a bonfire ignores.',
  },
});

/**
 * THE MANIFEST.
 *
 * ⚠️ `photosensitive: TRUE`, unlike the candle's. A candle flame is a small,
 * gentle flicker; a large fire pulses its whole cast light at a real vortex-
 * shedding frequency, and at campfire scale that lands near 1.5 Hz across a
 * significant fraction of the screen. That is squarely in the range the
 * accessibility hard-off exists for (`effect-settings.js`'s
 * `reducePhotosensitive`), and it is not a judgement call this effect gets to
 * make for its viewer.
 */
export const FIRE = Object.freeze({
  id: 'fire',
  title: 'Fire',
  visualWeight: 1.0,
  a11y: Object.freeze({ photosensitive: true }),
  enabledFromProfile: 'low',
  params: FIRE_PARAMS,
  authoring: Object.freeze({ paint: 'fire' }),

  /**
   * `estMsPerMp` is MEASURED, not estimated, for the noise term — the dominant
   * one. `tools/shader-lab/bench-fire.js#octave-cost-curve` put a 3-octave 3D
   * fBm at 0.1323 ms/Mpx on the reference machine (RTX 3070 Laptop), perfectly
   * linear across octaves 1–6 with a fixed cost of 0.0004 ms/Mpx. Sheet cost is
   * `M × 0.1323`; the per-slice scalar ALU is still estimated at ~0.004 ms/Mpx
   * and gets its own measurement once the material has a steady-state bench.
   *
   * ⚠️ RUNG 0 IS C8 AND THAT IS LEGAL — the monotonic-cost check starts at i=2
   * (`effect-manifest.js:194`), the same shape water uses. A fire that emits no
   * light reads as BROKEN rather than as simple, so the light is in the floor.
   */
  tiers: Object.freeze([
    {
      n: 0,
      name: 'hearth',
      cost: { class: 'C8', estMsPerMp: 0.05 },
      adds: 'one clustered warm light per fire plus a flat posterized disc pulsing at the real puff frequency — right place, right size, lights the room',
    },
    {
      n: 1,
      name: 'billow',
      fromProfile: 'low',
      cost: { class: 'C1', estMsPerMp: 0.14 },
      adds: 'one noise sheet: the 1−|fbm| billow fold erodes the disc into cauliflower lobes and the field boils',
    },
    {
      n: 2,
      name: 'plume',
      fromProfile: 'performance',
      cost: { class: 'C1', estMsPerMp: 0.29 },
      adds: 'the slab integral proper — two sheets over six slices, giving self-occlusion seams, a downwind-sheared plume and an accumulated soft edge',
    },
    {
      n: 3,
      name: 'smoke',
      fromProfile: 'standard',
      cost: { class: 'C1', estMsPerMp: 0.45 },
      adds: 'three sheets over ten slices, the upper ones taking the smoke ramp — a warm-lit crown with stipple grain and soot flecks, plus wind and rain response',
    },
    // ⚠️ ONE RUNG PER PROFILE FROM HERE, and that is not cosmetic. An earlier
    // version put `smoke` AND `flicker` both at `standard`, so the default
    // profile resolved to rung 4 while `FIRE_DEFAULT_TIER` said 3 — the
    // fallback for a malformed tier would have shown a different fire from the
    // one every default install gets. The anti-drift test in
    // `__tests__/fire.test.mjs` caught it, which is exactly what it is for.
    {
      n: 4,
      name: 'flicker',
      fromProfile: 'quality',
      cost: { class: 'C3', estMsPerMp: 0.49 },
      adds: 'the cast light animates from the same puff clock the flame runs on, and is depth-gated so a fire behind a wall stops lighting through it',
    },
    {
      n: 5,
      name: 'inferno',
      fromProfile: 'extreme',
      cost: { class: 'C8', estMsPerMp: 0.7 },
      adds: 'four sheets over fourteen slices, finer clustering so big fires stop sharing one light, and the deepest colour banding',
    },
  ]),

  /** Recorded, genuinely not built — the list this effect is judged against. */
  deferredRungs: Object.freeze([
    {
      name: 'smoke-as-a-second-pass',
      note: "Smoke is drawn in the flame's ADDITIVE pass today, so it can only add light and reads as a warm haze rather than something that darkens the map beneath it. The correct shape is a second, alpha-blended pass — which is what V2 did (flame additive, smoke NormalBlending).",
    },
    {
      name: 'embers-and-sparks',
      note: "Via the shared ParticleArena and SPAWN_KINDS.extracted, which was explicitly designed for fire spawn points. Must add ZERO new storage buffers — the arena already uses 6 of WebGPU's guaranteed 8.",
    },
    {
      name: 'coal-bed',
      note: "The glowing fuel under the flames. V2's was 667 lines and 32 uniforms and was the thing that made a campfire read as a campfire when the flames were low; the redesign is Worley chunks plus the same banded ramp at low temperature.",
    },
    {
      name: 'room-smoke-fill',
      note: 'Belongs in world/smoke-field.js as a sibling of wind-field.js, not inside this effect — windows, lighting and vision all want to read it. Needs a ROOM concept the codebase does not have yet (the outdoors mask and skyReach exist; segmentation does not). C7, gated on coverage per Law 7.',
    },
    {
      name: 'fire-whirl',
      note: "A rotate2d on the noise coordinate as a function of height gives spiralling lobes. Uniquely legible from directly above, which is exactly this renderer's camera.",
    },
  ]),
});
