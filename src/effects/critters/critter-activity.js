/**
 * CRITTER ACTIVITY — how awake a population is right now, 0..1.
 *
 * Pure functions of the frame's environment snapshot (`world/environment.js`): the
 * hour never lives here, only what the snapshot says about the sky, the weather
 * and the wind (the `time/one-tod` and `env/one-sun` walls — a second clock or a
 * second sun is exactly how V2 got shadows and specular disagreeing).
 *
 * The result is a POPULATION FRACTION, not a switch. The subsystem shows the first
 * `round(total × activity)` slots, and `zone.allocateZonePopulation` deals slots
 * round-robin across zones, so a dusk that is 30% of the way in shows 30% of the
 * fireflies of EVERY zone — they appear one by one, everywhere, rather than a
 * whole zone popping on.
 *
 * ============================================================================
 * FLIES — diurnal, and driven off by weather (V2 parity)
 * ============================================================================
 *
 * V2 thinned its swarm with `max(0.1, 1 − (precip·0.5 + wind·0.3))` and nothing
 * else — flies buzzed at midnight. Here the same weather term is kept (blended by
 * `weatherResponse` so a GM can turn it off) and a daylight term is added:
 * `nightActivity` is the fraction of the swarm that stays out after dark.
 *
 * ============================================================================
 * FIREFLIES — a window in SUN ELEVATION, not in clock hours
 * ============================================================================
 *
 * The same reasoning `world/sun.js` gives for its sky phases: V2's time of day was
 * eight hand-placed hour anchors and the sun was computed separately, so the two
 * disagreed about when dusk was. Keying the window to elevation means it follows
 * the astrolabe's own twilight arcs and a GM who changes the sun's peak height
 * moves it for free.
 *
 *      at or above `appearBelowDeg`   none
 *      appearBelowDeg → fullBelowDeg  ramp up      (the hatch)
 *      fullBelowDeg → halfway         full         (the plateau)
 *      halfway → fadeByDeg            ramp down    to `nightResidual`
 *      fadeByDeg and below            `nightResidual` (stragglers; zero if the GM asks for zero)
 *
 * Dusk and dawn are told apart by `env.sun.rising` (the sun model is symmetric
 * about noon, so that flag is the only thing that distinguishes them).
 *
 * @module effects/critters/critter-activity
 */

/** @param {number} x @returns {number} */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Hermite smoothstep on [edge0, edge1]; works for edge0 > edge1 (a falling edge). */
function smooth(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * V2's weather term, `max(0.1, 1 − (precip·0.5 + wind·0.3))`, blended by how much
 * the GM wants weather to matter. `response = 0` is "weather never matters".
 *
 * @param {{weather?: {precip01?: number}, wind?: {speed01?: number}}|null} env
 * @param {number} response - 0..1
 * @returns {number} 0.1..1
 */
export function weatherCalm(env, response) {
  const precip = clamp01(env?.weather?.precip01);
  const wind = clamp01(env?.wind?.speed01);
  const v2 = Math.max(0.1, 1 - (precip * 0.5 + wind * 0.3));
  const r = clamp01(response);
  return 1 + (v2 - 1) * r;
}

/**
 * How active the FLY swarm is: daylight × weather.
 *
 * @param {object|null} env - the frame's env snapshot (`world/environment.js`).
 * @param {{nightActivity?: number, weatherResponse?: number}} params
 * @returns {number} 0..1
 */
export function flyActivity(env, { nightActivity = 0.1, weatherResponse = 1 } = {}) {
  // No snapshot yet (the very first frame) reads as an ordinary day: a swarm that
  // is briefly too visible is a better failure than one that is briefly missing.
  const day = Number.isFinite(env?.sun?.dayFactor01) ? clamp01(env.sun.dayFactor01) : 1;
  const night = clamp01(nightActivity);
  const daylight = night + (1 - night) * day;
  return clamp01(daylight * weatherCalm(env, weatherResponse));
}

/**
 * How active the FIREFLY population is, by the sun's elevation.
 *
 * @param {object|null} env
 * @param {object} params
 * @param {boolean} [params.alwaysActive=false] - ignore the sky entirely (a GM who does not run a day clock).
 * @param {boolean} [params.dusk=true] - allow the evening window.
 * @param {boolean} [params.dawn=true] - allow the morning window.
 * @param {number} [params.appearBelowDeg=4] - the sun must be lower than this for the first one to hatch.
 * @param {number} [params.fullBelowDeg=-6] - …and at or below this the population is complete.
 * @param {number} [params.fadeByDeg=-20] - below this, only the stragglers remain.
 * @param {number} [params.nightResidual=0.2] - fraction that stays out through the dark.
 * @param {number} [params.weatherResponse=1] - 0..1: rain and wind send them to ground.
 * @returns {number} 0..1
 */
export function fireflyActivity(
  env,
  {
    alwaysActive = false,
    dusk = true,
    dawn = true,
    appearBelowDeg = 4,
    fullBelowDeg = -6,
    fadeByDeg = -20,
    nightResidual = 0.2,
    weatherResponse = 1,
  } = {}
) {
  const calm = fireflyWeather(env, weatherResponse);
  if (alwaysActive) return calm;
  const elevation = env?.sun?.elevationDeg;
  if (!Number.isFinite(elevation)) return 0;

  // Which half of the day is this? `rising` is the sun model's own flag.
  const allowed = env.sun.rising === true ? dawn !== false : dusk !== false;
  if (!allowed) return 0;

  const ramp = smooth(appearBelowDeg, fullBelowDeg, elevation); // 0 above, 1 once low enough
  // The decay begins halfway between "full" and "fade by", so there is a plateau
  // rather than a single peak. `lowEdge` guards a GM who drags fadeBy above full.
  const lowEdge = Math.min(fadeByDeg, fullBelowDeg);
  const decay = smooth((fullBelowDeg + lowEdge) / 2, lowEdge, elevation); // 0 on the plateau, 1 once faded
  const residual = clamp01(nightResidual);
  return clamp01(ramp * (1 - (1 - residual) * decay) * calm);
}

/**
 * Rain grounds fireflies completely; wind thins them. Unlike the fly term this has
 * no 10% floor — a downpour with glowing insects hovering in it reads as a bug.
 *
 * @param {object|null} env @param {number} response 0..1
 * @returns {number} 0..1
 */
export function fireflyWeather(env, response) {
  const r = clamp01(response);
  const precip = clamp01(env?.weather?.precip01);
  const wind = clamp01(env?.wind?.speed01);
  const factor = clamp01(1 - precip * 1.0) * clamp01(1 - wind * 0.6);
  return 1 + (factor - 1) * r;
}

/**
 * First-order smoothing toward a target, framerate-independent.
 *
 * A GM who drags the clock from noon to dusk would otherwise change the target
 * from 0 to 1 in one frame and every firefly would pop on together. The time
 * constant is real seconds (the caller passes the wall delta), so a paused world
 * still finishes the fade.
 *
 * @param {number} current @param {number} target
 * @param {number} dtSec @param {number} tauSec - seconds to cover ~63% of the gap.
 * @returns {number}
 */
export function approach(current, target, dtSec, tauSec) {
  const dt = Math.max(0, Number(dtSec) || 0);
  const tau = Math.max(1e-3, Number(tauSec) || 0);
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

/**
 * How many of `total` slots are showing at this activity, as a FLOAT: the whole
 * part is the slots fully on, the fraction is the next slot partway faded in. The
 * kernel reads it as a per-slot alpha ramp (`clamp(count − slotIndex, 0, 1)`), so
 * the population changes one individual at a time and never in steps.
 *
 * @param {number} activity01 @param {number} total
 * @returns {number} 0..total
 */
export function activeSlotCount(activity01, total) {
  return clamp01(activity01) * Math.max(0, total);
}
