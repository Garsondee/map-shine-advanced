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
  opacity: 1,
  tint: [1, 1, 1],
  // ── flies ──
  speed: 1,
  buzz: 1500,
  tether: 20,
  swarmRadius: 100,
  maxSpeed: 600,
  flyHeight: 80,
  landChance: 0.1,
  landingTime: 0.8,
  takeoffTime: 0.5,
  walkSpeed: 60,
  takeoffChance: 0.04,
  groomChance: 0.6,
  pauseMin: 0.6,
  pauseMax: 2.5,
  size: 18,
  sizeVariation: 0.25,
  wingBlur: 1,
  lookIndex: 0,
  // ── maggots ──
  maggotSize: 20,
  maggotSpeed: 1,
  maggotWriggle: 1,
  maggotClustering: 0.6,
  maggotColor: [0.9, 0.86, 0.72],
  // ── fireflies ──
  driftSpeed: 30,
  wander: 1,
  hoverHeight: 45,
  range: 140,
  restChance: 0.015,
  liftChance: 0.05,
  color: [0.72, 1, 0.23],
  intensity: 5,
  glowRadius: 18,
  flashPeriod: 3.6,
  synchrony: 0.25,
  bodyVisibility: 0.7,
  flashStyleIndex: 0,
  colonyPhase: 0,
});

/**
 * Where a kind's own default differs from the table's (the table is shared, and `size` means a fly's
 * 18 px there but a firefly's 8). Applied over the base when a kind's bank is built.
 */
export const CRITTER_KIND_DEFAULTS = Object.freeze({
  fly: Object.freeze({}),
  maggot: Object.freeze({}),
  firefly: Object.freeze({ size: 8 }),
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
