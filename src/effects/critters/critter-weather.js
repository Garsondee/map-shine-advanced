/**
 * CRITTER WEATHER — how rain, snow, wind and cold act on a population of insects.
 *
 * Pure functions of the frame's environment snapshot (`world/environment.js`) and an effect's own
 * params; no THREE, no GPU, Node-tested. Flies, maggots and fireflies share this module and differ
 * only in what their params say, so "a gale clears the flies but the maggots do not mind it" is a
 * default in a table, not a branch in the code.
 *
 * ============================================================================
 * TWO DIFFERENT THINGS WEATHER DOES, AND WHY THEY ARE SEPARATE
 * ============================================================================
 *
 * 1. IT THINS THE POPULATION — {@link weatherFactor}. A fraction 0..1 of the agents are out; the
 *    rest are not drawn. This is a head-count, evaluated on the CPU, and it is what the old single
 *    `weatherResponse` slider did (V2's rule: `max(0.1, 1 − (precip·0.5 + wind·0.3))`). Each cause
 *    has its own response and its own threshold, because an insect's reasons differ: rain soaks
 *    wings, snow is cold and wet, a gale makes flight pointless, a cold snap stops them altogether.
 *
 * 2. IT CHANGES HOW THE ONES THAT STAY MOVE — {@link weatherDrive}. Wind carries a flying insect
 *    downwind (advection) and makes its flight more erratic (agitation); rain drives a fly to land
 *    and stay down (shelter), and makes a maggot writhe (agitation); cold slows everything (tempo).
 *    These ride into the GPU kernels as four uniforms every frame, so the swarm visibly reacts
 *    BEFORE the head-count has finished falling.
 *
 * Both read the same snapshot, so what a player sees is the one sky every other effect sees.
 *
 * ============================================================================
 * "FULL RAIN" IS NOT precip01 = 1
 * ============================================================================
 *
 * `precip01` is the manager's intensity axis, and a heavy storm sits around 0.7: asking a slider that
 * says "at 1, rain clears them completely" to need a precipitation of exactly 1 would make that
 * promise unkeepable. So a load saturates at {@link LOAD_SATURATION} — steady, soaking rain is a full
 * load — and the response then scales it.
 *
 * @module effects/critters/critter-weather
 */
import { windFlowVector, windStrength01ForSpeed01 } from '../../world/index.js';

/** Precipitation (0..1) at which rain or snow counts as a FULL load on an insect. */
export const LOAD_SATURATION = 0.7;

/** How much a gust adds to the felt wind: a gusty gale at speed 0.5 is felt as ~0.75. */
const GUST_BOOST = 0.5;

/** The floor on how much cold can slow an insect: it never freezes in place entirely. */
const MIN_TEMPO = 0.15;

/** The temperature (0..1) a snapshot that never wrote one reads as: mild, well clear of any cold response. */
const MILD = 0.55;

/** @param {number} x @returns {number} */
const clamp01 = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/**
 * The sky as an insect feels it: five scalars and a direction, all 0..1 except the direction.
 *
 * `precipKind` decides which kind of load the precipitation is. Snow and the cold half of a sleet mix
 * are snow load; rain, hail and the warm half of sleet are rain load; falling ash and embers are a
 * lighter rain-like irritant. An unknown kind is rain, the pessimistic answer for a bug.
 *
 * @param {object|null} env - the frame's env snapshot; null (the first frame) reads as calm and mild.
 * @returns {{rainLoad: number, snowLoad: number, wind: number, gust: number, windEffective: number,
 *   temperature: number, windDirectionDeg: number}}
 */
export function skyFeel(env) {
  const precip = clamp01(env?.weather?.precip01);
  const kind = typeof env?.weather?.precipKind === 'string' ? env.weather.precipKind : 'rain';
  let snowShare = 0;
  let rainShare = 1;
  if (kind === 'snow') {
    snowShare = 1;
    rainShare = 0;
  } else if (kind === 'sleet') {
    snowShare = clamp01(env?.weather?.precipMixWeight);
    rainShare = 1 - snowShare;
  } else if (kind === 'ash' || kind === 'embers') {
    rainShare = 0.6;
  }
  // Beaufort strength (2026-10-27: the dial went linear to 70 m/s; the critter
  // thresholds were tuned when 0..1 was force ÷ 12).
  const wind = windStrength01ForSpeed01(clamp01(env?.wind?.speed01));
  const gust = clamp01(env?.wind?.gustiness01);
  const temperature = Number.isFinite(env?.weather?.temperature01) ? clamp01(env.weather.temperature01) : MILD;
  return {
    rainLoad: clamp01((precip * rainShare) / LOAD_SATURATION),
    snowLoad: clamp01((precip * snowShare) / LOAD_SATURATION),
    wind,
    gust,
    windEffective: clamp01(wind * (1 + GUST_BOOST * gust)),
    temperature,
    windDirectionDeg: Number.isFinite(env?.wind?.directionDeg) ? env.wind.directionDeg : 0,
  };
}

/**
 * How cold it is for an insect that minds below `coldBelow`: 0 at or above the threshold, 1 at 0 °
 * (temperature01 = 0). A `coldBelow` of 0 means "never cold".
 * @param {{temperature: number}} feel @param {number} coldBelow
 */
function coldness(feel, coldBelow) {
  const below = clamp01(coldBelow);
  if (below <= 0) return 0;
  return clamp01((below - feel.temperature) / below);
}

/**
 * The fraction of a population that braves this weather, 0..1.
 *
 *     factor = max( weatherFloor,  (1 − rain·rainLoad) · (1 − snow·snowLoad)
 *                                  · (1 − wind·over)    · (1 − cold·coldness) )
 *
 * where `over` is how far the felt wind is past `windThreshold` (0 at it, 1 at a full gale), and
 * `coldness` is how far the temperature is below `coldBelow`. Each term is 1 when its response is 0,
 * so a population indifferent to everything returns exactly 1. `weatherFloor` is the brave few that
 * stay out whatever the sky does (V2 kept a tenth).
 *
 * @param {ReturnType<typeof skyFeel>} feel
 * @param {object} [p] - the effect's params; any missing response reads as 0 (indifferent).
 * @param {number} [p.rainResponse] @param {number} [p.snowResponse]
 * @param {number} [p.windThreshold] @param {number} [p.windResponse]
 * @param {number} [p.coldBelow] @param {number} [p.coldResponse]
 * @param {number} [p.weatherFloor]
 * @returns {number}
 */
export function weatherFactor(feel, p = {}) {
  const rain = 1 - clamp01(p.rainResponse) * feel.rainLoad;
  const snow = 1 - clamp01(p.snowResponse) * feel.snowLoad;
  const threshold = clamp01(p.windThreshold);
  const over = clamp01((feel.windEffective - threshold) / Math.max(1 - threshold, 0.05));
  const wind = 1 - clamp01(p.windResponse) * over;
  const cold = 1 - clamp01(p.coldResponse) * coldness(feel, p.coldBelow);
  return Math.max(clamp01(p.weatherFloor), clamp01(rain * snow * wind * cold));
}

/**
 * How the weather changes the way the insects that stayed behave. Four numbers the kernels read:
 *
 *   windPush    px/s, a vector — the air's own velocity at the insect's height. A flying agent is
 *               carried by it; one standing on the ground ignores it. `windDrift` is px/s at a
 *               full gale.
 *   agitation   ≥ 1 — a multiplier on how violent the movement is: a fly's dart strength and a
 *               firefly's turning (from wind), a maggot's writhing (from rain).
 *   shelter     0..1 — how strongly a flier is driven to land and stay down (rain, snow).
 *   tempo       MIN_TEMPO..1 — a multiplier on the pace of every decision (cold slows them).
 *
 * @param {ReturnType<typeof skyFeel>} feel
 * @param {object} [p]
 * @param {number} [p.windDrift] @param {number} [p.windAgitation] @param {number} [p.rainAgitation]
 * @param {number} [p.rainShelter] @param {number} [p.coldSlowdown] @param {number} [p.coldBelow]
 * @returns {{windPush: [number, number], agitation: number, shelter: number, tempo: number}}
 */
export function weatherDrive(feel, p = {}) {
  const flow = windFlowVector(feel.windDirectionDeg);
  const drift = Math.max(0, Number(p.windDrift) || 0) * feel.windEffective;
  return {
    windPush: [flow.x * drift, flow.y * drift],
    agitation:
      1 +
      Math.max(0, Number(p.windAgitation) || 0) * feel.windEffective +
      Math.max(0, Number(p.rainAgitation) || 0) * feel.rainLoad,
    shelter: clamp01(clamp01(p.rainShelter) * Math.max(feel.rainLoad, feel.snowLoad)),
    tempo: Math.max(MIN_TEMPO, 1 - clamp01(p.coldSlowdown) * coldness(feel, p.coldBelow)),
  };
}

/**
 * Every param id these functions read, split by what they do — the one list the schemas are held to. A
 * `Weather` control whose id is in neither list is a control nothing reads; a Node test fails on it.
 */
export const WEATHER_FACTOR_PARAMS = Object.freeze([
  'rainResponse',
  'snowResponse',
  'windThreshold',
  'windResponse',
  'coldBelow',
  'coldResponse',
  'weatherFloor',
]);
export const WEATHER_DRIVE_PARAMS = Object.freeze([
  'windDrift',
  'windAgitation',
  'rainAgitation',
  'rainShelter',
  'coldSlowdown',
  'coldBelow',
]);

/** The neutral drive: calm air, no agitation, no shelter, full tempo. What an engine reads before the first frame. */
export const CALM_DRIVE = Object.freeze({ windPush: Object.freeze([0, 0]), agitation: 1, shelter: 0, tempo: 1 });
