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
 * FLIES — diurnal, and driven off by weather (V2 parity, with more dials)
 * ============================================================================
 *
 * V2 thinned its swarm with `max(0.1, 1 − (precip·0.5 + wind·0.3))` and nothing
 * else — flies buzzed at midnight. Here the weather is `critter-weather.js#weatherFactor`
 * (rain, snow, wind above a threshold, and cold, each with its own response — V2's
 * single rule is the special case) and a daylight term is added: `nightActivity` is
 * the fraction of the swarm that stays out after dark.
 *
 * MAGGOTS have no sky at all but the weather: they live IN the thing, so only what
 * weather does to them (rain drives them under, a cold snap stills them) thins them.
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

import { skyFeel, weatherFactor } from './critter-weather.js';

/** @param {number} x @returns {number} */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * A FALLING Hermite step: 0 at or above `high`, 1 at or below `low`, smooth between. Every edge of the
 * twilight window is this shape (the sun is going down), so the direction is part of the name and the
 * function cannot be handed an edge pair that means the opposite: `high <= low` (including equal) is a hard
 * step at `low`. (It used to be a general smoothstep whose equal-edge case returned the RISING step, which
 * is the wrong way round for a falling edge — an inverted window, silently.)
 */
function smoothFall(high, low, x) {
  if (!(high > low)) return x <= low ? 1 : 0;
  const t = clamp01((high - x) / (high - low));
  return t * t * (3 - 2 * t);
}

/** The narrowest a twilight ramp may be, in degrees of sun elevation. */
const MIN_RAMP_DEG = 0.5;

/**
 * The window's three edges, put in the only order that means anything: the sun must pass `appear`, then
 * `full`, then `fadeBy` on its way down. The schema lets each slider move over a range that overlaps the
 * others' (appear −10…30, full −30…10, fade −60…0), so a GM can drag them into any order, and an
 * unordered window was not merely odd but INVERTED (a full colony at noon and none at night). Instead of
 * rejecting a setting, each edge is held at least {@link MIN_RAMP_DEG} below the one before it.
 *
 * @param {number} appear @param {number} full @param {number} fadeBy
 * @returns {{appear: number, full: number, low: number, mid: number}}
 */
export function twilightEdges(appear, full, fadeBy) {
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const a = num(appear, 4);
  const f = Math.min(num(full, -6), a - MIN_RAMP_DEG);
  const low = Math.min(num(fadeBy, -20), f - MIN_RAMP_DEG);
  return { appear: a, full: f, low, mid: (f + low) / 2 };
}

/**
 * How active the FLY swarm is: daylight × weather.
 *
 * @param {object|null} env - the frame's env snapshot (`world/environment.js`).
 * @param {object} [params] - the effect's params: `nightActivity` and the weather responses
 *   (`critter-weather.js#weatherFactor`).
 * @returns {number} 0..1
 */
export function flyActivity(env, params = {}) {
  // No snapshot yet (the very first frame) reads as an ordinary day: a swarm that
  // is briefly too visible is a better failure than one that is briefly missing.
  const day = Number.isFinite(env?.sun?.dayFactor01) ? clamp01(env.sun.dayFactor01) : 1;
  const night = clamp01(params.nightActivity ?? 0.1);
  const daylight = night + (1 - night) * day;
  return clamp01(daylight * weatherFactor(skyFeel(env), params));
}

/**
 * How active the MAGGOT population is: the weather and nothing else (day and night are the same to a maggot).
 *
 * @param {object|null} env @param {object} [params] - the weather responses.
 * @returns {number} 0..1
 */
export function maggotActivity(env, params = {}) {
  return clamp01(weatherFactor(skyFeel(env), params));
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
 * @param {object} [params.weather] - everything else in `params` is read as the weather responses
 *   (`critter-weather.js#weatherFactor`): rain, snow, wind, cold and the floor.
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
    ...weather
  } = {}
) {
  const calm = weatherFactor(skyFeel(env), weather);
  if (alwaysActive) return calm;
  const elevation = env?.sun?.elevationDeg;
  if (!Number.isFinite(elevation)) return 0;

  // Which half of the day is this? `rising` is the sun model's own flag.
  const allowed = env.sun.rising === true ? dawn !== false : dusk !== false;
  if (!allowed) return 0;

  // The three edges are put in order first (`twilightEdges`), so the window cannot be inverted by sliders
  // that overlap. The decay begins halfway between "full" and "fade by", so there is a plateau rather than
  // a single peak.
  const edges = twilightEdges(appearBelowDeg, fullBelowDeg, fadeByDeg);
  const ramp = smoothFall(edges.appear, edges.full, elevation); // 0 above, 1 once low enough
  const decay = smoothFall(edges.mid, edges.low, elevation); // 0 on the plateau, 1 once faded
  const residual = clamp01(nightResidual);
  return clamp01(ramp * (1 - (1 - residual) * decay) * calm);
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
