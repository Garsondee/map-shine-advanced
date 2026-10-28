/**
 * CRITTER UNIFORMS — one table, one lazy bank.
 *
 * A critter engine reads dozens of tunables (the manifests' params plus per-frame
 * clocks, the zone's geometry, the camera). Hand-declaring each as
 * `const uBuzz = uniform(…)` is the V2 shape that grew water to 324 uniforms with
 * 46 of them inert: nothing connected "a knob exists" to "a shader reads it".
 *
 * Here the DEFAULTS TABLE is the single declaration, and a uniform is created the
 * first time a kernel or material asks for it by name (`bank.get('buzz')`). So:
 *
 *   • A fly engine never allocates the maggot's uniforms, and vice versa — an
 *     unread knob does not exist, rather than existing and being ignored.
 *   • Asking for a name that is not in the table THROWS, loudly, at build time —
 *     a typo cannot become a control that silently does nothing.
 *   • `setMany(params)` pushes only what was ever requested, so a param the engine
 *     never reads costs nothing per frame.
 *
 * Param ids are the uniform names (the effect's `params.buzz` is `bank.get('buzz')`
 * and `setMany({buzz})`), so there is no second vocabulary to keep in step.
 *
 * ⚠️ NO FEATURE-GATE UNIFORMS (`tsl/no-uniform-gates`): nothing here is an
 * on/off switch for a block of shader. A tier is a JS `if` at build time.
 *
 * @module effects/critters/critter-uniforms
 */
import { TOKEN_SLOT_FAR } from './critter-token.js';

/**
 * name → default. A number is a float uniform; a 2- or 3-array is a vec2/vec3.
 * Defaults match the manifests' own, so an engine that is never `setParams`'d
 * still behaves like the shipped look.
 */
export const CRITTER_UNIFORM_DEFAULTS = Object.freeze({
  // ── per-frame clocks and plumbing (set by `step`) ──
  dt: 0,
  timeSec: 0,
  rand: 0,
  active: 0,
  population: 0,
  camCentre: [0, 0],
  camHeight: 1000,
  expectedDepth: 0,
  // ── the zone field's geometry (set by `setZone`) ──
  zoneOrigin: [0, 0],
  zoneCell: [10, 10],
  zoneDims: [1, 1],
  homesOffset: 0,
  // ── the sky (set by the subsystem from the shadow handle) ──
  shadowShift: [0.3, 0.4],
  shadowSoft: 0.2,
  shadowAmount: 0.45,
  // ── the weather's hand on the ones that stayed (set by the subsystem each frame — `critter-weather.js#weatherDrive`) ──
  windPush: [0, 0],
  agitation: 1,
  shelter: 0,
  tempo: 1,
  // ── nearby tokens (set by the subsystem each frame — `critter-token.js#nearestTokenSlots`;
  // flies and fireflies only, see that module's own header). A fixed, JS-unrolled set of
  // positions, not a `uniformArray` — mantle-runtime.js's own note explains why. Each defaults to
  // `TOKEN_SLOT_FAR`, a position no real agent is ever near, so an empty slot costs nothing and
  // needs no separate "is this slot live" flag.
  tokenPos0: [TOKEN_SLOT_FAR, TOKEN_SLOT_FAR],
  tokenPos1: [TOKEN_SLOT_FAR, TOKEN_SLOT_FAR],
  tokenPos2: [TOKEN_SLOT_FAR, TOKEN_SLOT_FAR],
  tokenPos3: [TOKEN_SLOT_FAR, TOKEN_SLOT_FAR],
  tokenPos4: [TOKEN_SLOT_FAR, TOKEN_SLOT_FAR],
  tokenPos5: [TOKEN_SLOT_FAR, TOKEN_SLOT_FAR],
  tokenPos6: [TOKEN_SLOT_FAR, TOKEN_SLOT_FAR],
  tokenPos7: [TOKEN_SLOT_FAR, TOKEN_SLOT_FAR],
  tokenStartleResponse: 0,
  tokenStartleRadius: 150,
  // ── shared by every kind ──
  opacity: 1,
  speed: 1,
  sizeVariation: 0.25,
  lightInfluence: 1,
  perspective: 1,
  hoverBob: 1,
  pauseMin: 0.6,
  pauseMax: 2.5,
  // ── flies ──
  tint: [1, 1, 1],
  eyeColor: [0.5, 0.086, 0.051],
  wingOpacity: 1,
  wingSpread: 1,
  sheen: 1,
  legWeight: 1,
  bankAmount: 1,
  shadowSoftness: 1,
  buzz: 4000,
  tether: 10,
  swarmRadius: 600,
  maxSpeed: 450,
  flyHeight: 80,
  landChance: 0.1,
  landingTime: 0.8,
  takeoffTime: 0.5,
  walkSpeed: 60,
  takeoffChance: 0.04,
  groomChance: 0.6,
  size: 4,
  wingBlur: 1,
  lookIndex: 0,
  // ── maggots ──
  color: [0.72, 1, 0.23],
  girth: 1.6,
  contactShadow: 1,
  gloss: 1,
  segmentDepth: 1,
  gutLine: 1,
  wriggle: 0.6,
  waveCount: 1,
  crawlSpeed: 0.35,
  crawlChance: 0.55,
  crawlLength: 1,
  clustering: 0.25,
  // ── fireflies ── (sparser, softer, wider-roaming tuning, 2026-10-28)
  driftSpeed: 17,
  wander: 0.75,
  hoverHeight: 25,
  range: 730,
  restChance: 0.5,
  liftChance: 0.045,
  colorVariation: 0.3,
  intensity: 6.2,
  glowRadius: 8,
  coreSize: 1,
  haloAmount: 0.1,
  afterglow: 0.1,
  restGlow: 0.05,
  flashPeriod: 3.6,
  synchrony: 0.25,
  bodyVisibility: 0.5,
  flashStyleIndex: 0,
  colonyPhase: 0,
  // ── dust motes (`dust.js`; the `mote` kind) ──
  sparkle: 0.55,
  sparkleSharpness: 9,
  bokeh: 0.8,
  focusHeight: 40,
  beamContrast: 1.3,
  colorFromLight: 0.8,
  lowSunGlow: 1.2,
  beamSlant: 0.55,
  ambientGlow: 0.06,
  swirl: 1,
  swirlScale: 180,
  tumble: 1,
  updraft: 1,
  // px/s a full gale carries a mote (read from the wind grid, per mote). The flies' and fireflies' own
  // `windDrift` is a CPU-side input (`critter-weather.js#weatherDrive`) with the same meaning and its own
  // defaults, which is why each kind restates it below: the table's value is the flies'.
  windDrift: 140,
  // dust controls (`dust.js`)
  nightOpacity: 0.03,
  nightLightColour: 1,
  shapeIrregularity: 1,
  flakeThinness: 0.4,
  edgeOnSquash: 0.6,
  pinpointTightness: 8,
  bokehSize: 1.6,
  starAmount: 1.5,
  glintFloor: 0.2,
  roomCutoff: 1.02,
  hueLimit: 2.5,
  minScreenSize: 1.5,
  brightnessVariation: 0.3,
  fadeInTime: 2,
  wanderAmount: 0.3,
  inertia: 1.5,
  turbulenceGain: 0.6,
  heightEase: 2,
  eddySpeed: 0.13,
  convection: 0.3,
  tokenPush: 140,
  tokenSpin: 110,
  homing: 4,
  minHeight: 0.05,
  // The motes' per-frame plumbing (set by the subsystem / `step`): the view they are drawn into, where the
  // sun's ray lands per px of height, how low the sun is, the room's own light, the window light's full range,
  // and the unwrapped clock the wind field's noise runs on.
  viewMin: [0, 0],
  viewSize: [1, 1],
  sunShift: [0, 0],
  sunLow: 0,
  night: 0,
  lightBase: [0.3, 0.3, 0.3],
  beamRef: 0.45,
  windTimeMs: 0,
});

/**
 * Where a kind's own default differs from the table's (the table is shared, and `size` means a fly's
 * 4 px there but a firefly's 3). Applied over the base when a kind's bank is built.
 */
export const CRITTER_KIND_DEFAULTS = Object.freeze({
  // `tokenStartleResponse`/`tokenStartleRadius` mirror smelly-flies.js's own defaults — a fly
  // startles hard and from a wide radius.
  fly: Object.freeze({
    size: 6,
    shadowSoftness: 0.35,
    flyHeight: 230,
    landChance: 0.495,
    landingTime: 1,
    tokenStartleResponse: 1,
    tokenStartleRadius: 480,
  }),
  // `color` is the glow's in the table (a firefly's) and the skin's here; a maggot rests in longer
  // pauses than a fly. Maggots never read the token uniforms at all (critter-token.js's own
  // header), so no override is needed here for them.
  maggot: Object.freeze({ size: 6, sizeVariation: 0.65, color: [0.902, 0.863, 0.722], pauseMin: 0.9, pauseMax: 3.6 }),
  // `tokenStartleResponse`/`tokenStartleRadius` mirror fireflies.js's own defaults — wider-range
  // than a fly's now (2026-10-28 retune), but still a lift-off, not a panic. `opacity`/
  // `lightInfluence`/`perspective` are overridden too: despite living in the "shared by every
  // kind" block above, each kind in fact declares its OWN schema default for these three
  // (fireflies.js/smelly-flies.js/maggots.js each have their own `opacity` slider, etc.) — the
  // "shared" comment recorded a coincidence (every kind defaulted to 1) that fireflies' own
  // 2026-10-28 retune broke; fly's and maggot's schemas still say 1, so the shared block above
  // stays 1 and only fireflies' own kind gets its retuned numbers here.
  firefly: Object.freeze({
    size: 3,
    sizeVariation: 0.2,
    windDrift: 60,
    tokenStartleResponse: 1,
    tokenStartleRadius: 200,
    opacity: 0.5,
    lightInfluence: 0.5,
    perspective: 0.15,
  }),
  // Dust (`dust.js`): the schema's own defaults, so a mote engine that has not been pushed anything yet still
  // looks like the shipped one. `color` is #fff1dc.
  mote: Object.freeze({
    size: 0.5,
    sizeVariation: 0.05,
    color: [1, 0.8, 0.502],
    intensity: 20,
    driftSpeed: 15,
    range: 115,
    hoverHeight: 60,
    perspective: 0.05,
    windDrift: 410,
    haloAmount: 0.5,
    colorVariation: 0.2,
    tokenStartleResponse: 1,
    tokenStartleRadius: 200,
    bokehSize: 0.15,
    minHeight: 0.01,
    fadeInTime: 2,
    tokenSpin: 110,
    tokenPush: 140,
    homing: 1.7,
    heightEase: 5.3,
    convection: 0.3,
    eddySpeed: 0.55,
    turbulenceGain: 1.3,
    inertia: 0.6,
    wanderAmount: 0.8,
    updraft: 2.15,
    tumble: 0.4,
    swirlScale: 60,
    swirl: 1.55,
    speed: 0.35,
    hueLimit: 1.2,
    roomCutoff: 1,
    ambientGlow: 0.1,
    beamSlant: 2,
    lowSunGlow: 1,
    colorFromLight: 1,
    beamContrast: 4,
    minScreenSize: 1.5,
    brightnessVariation: 0.75,
    glintFloor: 0.04,
    starAmount: 3.5,
    pinpointTightness: 40,
    edgeOnSquash: 0.5,
    flakeThinness: 0.85,
    shapeIrregularity: 0.55,
    focusHeight: 180,
    bokeh: 0,
    sparkleSharpness: 40,
    sparkle: 0.7,
    opacity: 0.3,
  }),
});

/**
 * @param {*} TSL
 * @param {Readonly<Record<string, number|number[]>>} [defaults]
 * @returns {{get: (name: string) => *, set: (name: string, value: number|number[]) => boolean,
 *   setMany: (values: Record<string, number|number[]>) => void, names: () => string[]}}
 */
export function createUniformBank(TSL, defaults = CRITTER_UNIFORM_DEFAULTS) {
  const { uniform, float, vec2, vec3 } = TSL;
  /** @type {Map<string, {node: *, size: number}>} */
  const nodes = new Map();
  /**
   * The last value asked for each name, whether or not its uniform exists yet.
   *
   * ⚠️ THIS MAP IS NOT OPTIONAL. A kernel's body does not run when the kernel is
   * constructed, it runs when the kernel is first BUILT (the first `renderer.compute`), so
   * the uniforms a kernel reads are created AFTER the first `setParams`. Without this
   * map those first values would be silently dropped — the author's settings ignored
   * until they happened to touch a slider — which is exactly the failure a lazy bank
   * invites. Values wait here, and are applied the moment their uniform is created.
   * @type {Map<string, number|number[]>}
   */
  const requested = new Map();

  function make(value) {
    if (Array.isArray(value)) {
      if (value.length === 2) return { node: uniform(vec2(value[0], value[1])), size: 2 };
      if (value.length === 3) return { node: uniform(vec3(value[0], value[1], value[2])), size: 3 };
      throw new Error(`critter uniform: unsupported vector length ${value.length}`);
    }
    return { node: uniform(float(value)), size: 1 };
  }

  function has(name) {
    return Object.prototype.hasOwnProperty.call(defaults, name);
  }

  function get(name) {
    let entry = nodes.get(name);
    if (!entry) {
      if (!has(name)) {
        throw new Error(
          `critter uniform '${name}' is not in CRITTER_UNIFORM_DEFAULTS — add it to the table (it is the single declaration), do not invent one at the call site`
        );
      }
      entry = make(requested.has(name) ? requested.get(name) : defaults[name]);
      nodes.set(name, entry);
    }
    return entry.node;
  }

  const isValid = (value) =>
    Array.isArray(value)
      ? value.length >= 2 && value.length <= 3 && value.every(Number.isFinite)
      : Number.isFinite(value);

  /** @returns {boolean} true if `name` is a uniform this table declares (a non-finite value is ignored, the last good one kept). */
  function set(name, value) {
    if (!has(name)) return false;
    if (!isValid(value)) return true;
    const entry = nodes.get(name);
    if (entry) {
      if (entry.size === 1 && !Array.isArray(value)) entry.node.value = value;
      else if (Array.isArray(value) && value.length === entry.size) entry.node.value.set(...value);
      else return true;
    }
    requested.set(name, value);
    return true;
  }

  function setMany(values) {
    for (const name of Object.keys(values)) set(name, values[name]);
  }

  return { get, set, setMany, names: () => [...nodes.keys()] };
}
