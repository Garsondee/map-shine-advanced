/**
 * THE ALMANAC — biomes as data, and the clock that biases them
 * (docs/planning/Weather-Manager.md §5.2–§5.3).
 *
 * ============================================================================
 * A BIOME IS A GRAPH, NOT A SCRIPT
 * ============================================================================
 *
 * Ten climates, each a set of edges over the same 13 archetypes
 * `weather-data.js` already defines. `clear → fair-cumulus → thunderstorm` is
 * a path in the temperate graphs; `clear → snow` is not an edge in `desert` at
 * all. That is the whole mechanism behind "a realistic set of states" — it is
 * STRUCTURAL (an edge either exists or it doesn't), never a runtime check
 * against temperature or season. A desert's graph simply has no way to reach
 * `snow`, the same way `shadowfell-verge`'s graph has no `clear` node at all.
 *
 * Every biome is validated (this module, at load, and again by its own test
 * suite) to be a single STRONGLY CONNECTED graph: every node the walk can
 * enter has at least one way out, and every node can eventually reach every
 * other node in the same biome. A dead end here is not a design quirk, it is
 * a bug — a walk that enters a node with no outgoing edge freezes the sky
 * forever, silently, and the only symptom is "the weather stopped".
 *
 * ============================================================================
 * TIME OF DAY BIASES TRANSITIONS, IT DOES NOT GATE THEM
 * ============================================================================
 *
 * Five curves, closed list, each multiplying a transition's weight. `flat`
 * (the default when an edge names none) means "this transition doesn't care
 * what time it is". Every curve keeps a nonzero floor — real weather is not a
 * clock, `convectiveAfternoon` thunderstorms are RARE outside 14–18h, not
 * IMPOSSIBLE — the floor is what keeps `feedback_gate_polarity_must_fail_open`
 * satisfied here: a transition biased toward one time of day must still be
 * reachable at 3am, just unlikely.
 *
 * @module world/weather-biomes
 */

import { normalizeHour } from './sun.js';
import { WEATHER_ARCHETYPE_IDS } from './weather-data.js';

// ============================================================================
// TIME-OF-DAY CURVES
// ============================================================================

/** @param {number} t @returns {number} 0..1, smooth at both ends. */
function smoothstep01(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** 0 at `a`, 1 at `b`, smooth between. `a === b` is a hard step. */
function ramp(hour, a, b) {
  if (a === b) return hour >= a ? 1 : 0;
  return smoothstep01((hour - a) / (b - a));
}

/**
 * A daytime "bump": `floor` outside `[riseStart, fallEnd]`, 1 across
 * `[riseEnd, fallStart]`, smoothly ramped between. The window must NOT cross
 * midnight — `nocturnalCalm` below needs the opposite (a trough that DOES
 * cross midnight) and is built separately for exactly that reason.
 * @param {number} hour @param {number} riseStart @param {number} riseEnd
 * @param {number} fallStart @param {number} fallEnd @param {number} floor
 * @returns {number}
 */
function bump(hour, riseStart, riseEnd, fallStart, fallEnd, floor) {
  const h = normalizeHour(hour);
  const up = ramp(h, riseStart, riseEnd);
  const down = 1 - ramp(h, fallStart, fallEnd);
  const shape = Math.min(up, down);
  return floor + (1 - floor) * Math.max(0, shape);
}

/** Hours between `hour` and `center` the SHORT way round the 24h dial, 0..12. */
function circularHourDistance(hour, center) {
  const d = Math.abs(normalizeHour(hour) - normalizeHour(center));
  return d > 12 ? 24 - d : d;
}

/**
 * THE FIVE CURVES — closed list (Weather-Manager.md §5.3). A transition names
 * one by STRING; {@link evalTodCurve} is the one place a name resolves to a
 * function, and it fails open to `flat` for an unknown name so a typo in a
 * biome row degrades to "no time bias" rather than crashing the walk.
 */
export const TOD_CURVES = Object.freeze({
  /** Surface heating -> cumulus -> storms. Continental/tropical afternoons. */
  convectiveAfternoon: (hour) => bump(hour, 11, 14, 18, 21, 0.08),
  /** Overnight cooling -> dawn fog, gone by mid-morning. */
  radiativeDawn: (hour) => bump(hour, 1, 4, 8, 10, 0.06),
  /** Convection dies with the sun; wind lays down. A TROUGH, not a peak —
   * low across 22h-06h, full strength by mid-morning and mid-evening. */
  nocturnalCalm: (hour) => {
    const d = circularHourDistance(hour, 2);
    const t = smoothstep01((d - 4) / 2);
    const floor = 0.15;
    return floor + (1 - floor) * t;
  },
  /** The near-daily tropical deluge — narrower and harder than the
   * continental afternoon bump. */
  monsoonClock: (hour) => bump(hour, 14, 15, 17, 18, 0.03),
  /** Weather that does not care what time it is. */
  flat: () => 1,
});

/** @type {readonly string[]} */
export const TOD_CURVE_NAMES = Object.freeze(Object.keys(TOD_CURVES));

/**
 * Resolve a curve NAME to a value at `hour`. Fails open to `flat` (weight 1,
 * no bias) for an unknown/missing name.
 * @param {string} name @param {number} hour @returns {number}
 */
export function evalTodCurve(name, hour) {
  const fn = TOD_CURVES[name];
  return typeof fn === 'function' ? fn(hour) : 1;
}

// ============================================================================
// DWELL — how long a sky lingers, in GAME hours, before the walk reconsiders
// ============================================================================

/**
 * The shared starting point every biome's `dwellHours` merges over. Storms
 * are short (they are drama, not backdrop); overcast and clear are the
 * longest-lived, because a sky that changed every twenty minutes would read
 * as flickering rather than as weather.
 */
export const DEFAULT_DWELL_HOURS = Object.freeze({
  clear: Object.freeze({ min: 3, mean: 8, max: 20 }),
  streaks: Object.freeze({ min: 2, mean: 5, max: 12 }),
  'high-veil': Object.freeze({ min: 2, mean: 5, max: 10 }),
  'fair-cumulus': Object.freeze({ min: 2, mean: 5, max: 10 }),
  mackerel: Object.freeze({ min: 2, mean: 4, max: 8 }),
  broken: Object.freeze({ min: 2, mean: 4, max: 8 }),
  overcast: Object.freeze({ min: 3, mean: 8, max: 18 }),
  fog: Object.freeze({ min: 1, mean: 3, max: 6 }),
  drizzle: Object.freeze({ min: 1, mean: 3, max: 6 }),
  'steady-rain': Object.freeze({ min: 1, mean: 3, max: 7 }),
  snow: Object.freeze({ min: 2, mean: 6, max: 14 }),
  gale: Object.freeze({ min: 1, mean: 3, max: 6 }),
  thunderstorm: Object.freeze({ min: 0.5, mean: 1.5, max: 3 }),
});

/**
 * Merge per-biome dwell overrides over the shared defaults, so a biome only
 * has to author what makes it DIFFERENT (a desert's `clear` lingering for
 * days, a monsoon's `thunderstorm` arriving and leaving fast) rather than
 * repeating all 13 rows in every biome.
 * @param {object} [overrides]
 * @returns {Readonly<object>}
 */
function dwell(overrides = {}) {
  const out = {};
  for (const id of WEATHER_ARCHETYPE_IDS) {
    out[id] = Object.freeze({ ...DEFAULT_DWELL_HOURS[id], ...(overrides[id] ?? {}) });
  }
  return Object.freeze(out);
}

/** One edge helper, purely for reading the biome tables below without the
 * object-literal noise repeated 90-odd times. @returns {object} */
function edge(from, to, weight, todCurve = 'flat') {
  return Object.freeze({ from, to, weight, todCurve });
}

// ============================================================================
// THE BIOMES
// ============================================================================

export const WEATHER_BIOMES = Object.freeze([
  Object.freeze({
    id: 'temperate-coast',
    label: 'Temperate Coast',
    blurb: 'Everything happens here eventually — mild, changeable, rarely extreme.',
    archetypeWeights: Object.freeze({
      clear: 0.3,
      streaks: 0.08,
      'high-veil': 0.08,
      'fair-cumulus': 0.16,
      mackerel: 0.06,
      broken: 0.1,
      overcast: 0.1,
      fog: 0.03,
      drizzle: 0.05,
      'steady-rain': 0.03,
      gale: 0.01,
    }),
    transitions: Object.freeze([
      edge('clear', 'streaks', 0.5),
      edge('clear', 'fair-cumulus', 0.9),
      edge('clear', 'high-veil', 0.4),
      edge('streaks', 'clear', 0.7),
      edge('streaks', 'high-veil', 0.4),
      edge('high-veil', 'clear', 0.6),
      edge('high-veil', 'overcast', 0.3),
      edge('fair-cumulus', 'clear', 0.6),
      edge('fair-cumulus', 'mackerel', 0.4),
      edge('fair-cumulus', 'broken', 0.4, 'convectiveAfternoon'),
      edge('mackerel', 'fair-cumulus', 0.5),
      edge('mackerel', 'broken', 0.4),
      edge('broken', 'fair-cumulus', 0.4),
      edge('broken', 'overcast', 0.5),
      edge('broken', 'thunderstorm', 0.15, 'convectiveAfternoon'),
      edge('overcast', 'broken', 0.4),
      edge('overcast', 'drizzle', 0.35),
      edge('overcast', 'fog', 0.15, 'radiativeDawn'),
      edge('drizzle', 'overcast', 0.5),
      edge('drizzle', 'steady-rain', 0.3),
      edge('steady-rain', 'drizzle', 0.5),
      edge('steady-rain', 'broken', 0.3),
      edge('fog', 'overcast', 0.6),
      edge('fog', 'clear', 0.4, 'radiativeDawn'),
      edge('thunderstorm', 'gale', 0.5),
      edge('thunderstorm', 'broken', 0.4),
      edge('gale', 'clear', 0.5),
      edge('gale', 'streaks', 0.3),
    ]),
    dwellHours: dwell(),
    frontScripts: Object.freeze([
      { id: 'warm-front', ratePerGameDay: 0.15 },
      { id: 'cold-front', ratePerGameDay: 0.1 },
    ]),
    eventRates: Object.freeze({}),
    tempByHour01: 'radiativeDawn',
  }),

  Object.freeze({
    id: 'continental-plains',
    label: 'Continental Plains',
    blurb: 'Wide skies, hot afternoons, storms that build fast and hit hard.',
    archetypeWeights: Object.freeze({
      clear: 0.38,
      streaks: 0.1,
      'high-veil': 0.06,
      'fair-cumulus': 0.18,
      mackerel: 0.04,
      broken: 0.08,
      overcast: 0.05,
      gale: 0.05,
      thunderstorm: 0.03,
      drizzle: 0.03,
    }),
    transitions: Object.freeze([
      edge('clear', 'streaks', 0.4),
      edge('clear', 'fair-cumulus', 0.8),
      edge('clear', 'gale', 0.15),
      edge('streaks', 'clear', 0.8),
      edge('fair-cumulus', 'clear', 0.6),
      edge('fair-cumulus', 'mackerel', 0.3),
      edge('fair-cumulus', 'broken', 0.5, 'convectiveAfternoon'),
      edge('mackerel', 'fair-cumulus', 0.6),
      edge('mackerel', 'broken', 0.3, 'convectiveAfternoon'),
      edge('broken', 'fair-cumulus', 0.3),
      edge('broken', 'thunderstorm', 0.4, 'convectiveAfternoon'),
      edge('broken', 'overcast', 0.2),
      edge('thunderstorm', 'gale', 0.6, 'convectiveAfternoon'),
      edge('thunderstorm', 'drizzle', 0.2),
      edge('gale', 'clear', 0.6),
      edge('gale', 'streaks', 0.3),
      edge('overcast', 'broken', 0.5),
      edge('overcast', 'drizzle', 0.3),
      edge('drizzle', 'clear', 0.4),
      edge('drizzle', 'overcast', 0.4),
      edge('high-veil', 'clear', 0.8),
      edge('clear', 'high-veil', 0.2),
    ]),
    dwellHours: dwell({ thunderstorm: { min: 0.5, mean: 1, max: 2 } }),
    frontScripts: Object.freeze([{ id: 'cold-front', ratePerGameDay: 0.2 }]),
    eventRates: Object.freeze({}),
    tempByHour01: 'convectiveAfternoon',
  }),

  Object.freeze({
    id: 'desert',
    label: 'Desert',
    blurb: 'Clear for days at a stretch; a dust gale or a freak storm is the whole story.',
    archetypeWeights: Object.freeze({
      clear: 0.72,
      streaks: 0.1,
      'high-veil': 0.08,
      gale: 0.06,
      'fair-cumulus': 0.03,
      thunderstorm: 0.01,
    }),
    transitions: Object.freeze([
      edge('clear', 'streaks', 0.3),
      edge('clear', 'high-veil', 0.15),
      edge('clear', 'gale', 0.12),
      edge('clear', 'fair-cumulus', 0.05, 'convectiveAfternoon'),
      edge('streaks', 'clear', 0.85),
      edge('high-veil', 'clear', 0.85),
      edge('gale', 'clear', 0.75),
      edge('fair-cumulus', 'clear', 0.75),
      edge('fair-cumulus', 'thunderstorm', 0.08, 'convectiveAfternoon'),
      edge('thunderstorm', 'gale', 0.6),
      edge('thunderstorm', 'clear', 0.4),
    ]),
    dwellHours: dwell({
      clear: { min: 6, mean: 24, max: 72 },
      gale: { min: 1, mean: 4, max: 10 },
      thunderstorm: { min: 0.3, mean: 0.8, max: 1.5 },
    }),
    frontScripts: Object.freeze([]),
    eventRates: Object.freeze({}),
    tempByHour01: 'convectiveAfternoon',
  }),

  Object.freeze({
    id: 'tropical-monsoon',
    label: 'Tropical Monsoon',
    blurb: 'Builds and breaks almost every afternoon — humid, dramatic, on a clock.',
    archetypeWeights: Object.freeze({
      'fair-cumulus': 0.22,
      clear: 0.14,
      mackerel: 0.1,
      broken: 0.1,
      thunderstorm: 0.14,
      'steady-rain': 0.12,
      drizzle: 0.08,
      overcast: 0.06,
      gale: 0.04,
      'high-veil': 0.04,
    }),
    transitions: Object.freeze([
      edge('clear', 'fair-cumulus', 0.7),
      edge('clear', 'high-veil', 0.25),
      edge('high-veil', 'clear', 0.6),
      edge('high-veil', 'fair-cumulus', 0.4),
      edge('fair-cumulus', 'clear', 0.25),
      edge('fair-cumulus', 'mackerel', 0.35),
      edge('fair-cumulus', 'thunderstorm', 0.5, 'monsoonClock'),
      edge('mackerel', 'broken', 0.5),
      edge('mackerel', 'fair-cumulus', 0.4),
      edge('broken', 'thunderstorm', 0.4, 'monsoonClock'),
      edge('broken', 'overcast', 0.3),
      edge('overcast', 'steady-rain', 0.4),
      edge('overcast', 'broken', 0.4),
      edge('thunderstorm', 'steady-rain', 0.4),
      edge('thunderstorm', 'gale', 0.3),
      edge('steady-rain', 'drizzle', 0.4),
      edge('steady-rain', 'broken', 0.4),
      edge('drizzle', 'fair-cumulus', 0.5),
      edge('drizzle', 'overcast', 0.3),
      edge('gale', 'fair-cumulus', 0.6),
      edge('gale', 'clear', 0.3),
    ]),
    dwellHours: dwell({ thunderstorm: { min: 0.5, mean: 1.2, max: 2.5 }, clear: { min: 2, mean: 5, max: 10 } }),
    frontScripts: Object.freeze([]),
    eventRates: Object.freeze({}),
    tempByHour01: 'monsoonClock',
  }),

  Object.freeze({
    id: 'boreal-tundra',
    label: 'Boreal Tundra',
    blurb: 'Cold and low-ceilinged. Snow more often than not once the sky fills in.',
    archetypeWeights: Object.freeze({
      clear: 0.22,
      streaks: 0.1,
      'high-veil': 0.14,
      overcast: 0.18,
      snow: 0.16,
      fog: 0.06,
      gale: 0.08,
    }),
    transitions: Object.freeze([
      edge('clear', 'streaks', 0.4),
      edge('clear', 'high-veil', 0.3),
      edge('clear', 'overcast', 0.2),
      edge('streaks', 'clear', 0.6),
      edge('streaks', 'high-veil', 0.3),
      edge('high-veil', 'clear', 0.5),
      edge('high-veil', 'overcast', 0.4),
      edge('overcast', 'high-veil', 0.3),
      edge('overcast', 'snow', 0.4),
      edge('overcast', 'fog', 0.15, 'radiativeDawn'),
      edge('snow', 'overcast', 0.5),
      edge('snow', 'clear', 0.2),
      edge('snow', 'gale', 0.2),
      edge('gale', 'snow', 0.3),
      edge('gale', 'clear', 0.5),
      edge('fog', 'overcast', 0.6),
      edge('fog', 'clear', 0.4, 'radiativeDawn'),
    ]),
    dwellHours: dwell({ clear: { min: 4, mean: 10, max: 24 }, snow: { min: 3, mean: 8, max: 20 } }),
    frontScripts: Object.freeze([{ id: 'cold-front', ratePerGameDay: 0.12 }]),
    eventRates: Object.freeze({}),
    tempByHour01: 'nocturnalCalm',
  }),

  Object.freeze({
    id: 'high-mountain',
    label: 'High Mountain',
    blurb: 'Weather builds fast and turns on you — wind, storm and snow share the same afternoon.',
    archetypeWeights: Object.freeze({
      clear: 0.24,
      streaks: 0.1,
      'fair-cumulus': 0.12,
      broken: 0.1,
      overcast: 0.1,
      snow: 0.1,
      gale: 0.14,
      thunderstorm: 0.06,
      fog: 0.04,
    }),
    transitions: Object.freeze([
      edge('clear', 'streaks', 0.4),
      edge('clear', 'fair-cumulus', 0.35),
      edge('clear', 'gale', 0.25),
      edge('streaks', 'clear', 0.6),
      edge('fair-cumulus', 'clear', 0.4),
      edge('fair-cumulus', 'broken', 0.4, 'convectiveAfternoon'),
      edge('fair-cumulus', 'thunderstorm', 0.2, 'convectiveAfternoon'),
      edge('broken', 'overcast', 0.4),
      edge('broken', 'fair-cumulus', 0.4),
      edge('overcast', 'snow', 0.3),
      edge('overcast', 'broken', 0.4),
      edge('overcast', 'fog', 0.2),
      edge('thunderstorm', 'gale', 0.6),
      edge('thunderstorm', 'snow', 0.2),
      edge('snow', 'overcast', 0.4),
      edge('snow', 'clear', 0.3),
      edge('snow', 'gale', 0.3),
      edge('gale', 'clear', 0.5),
      edge('gale', 'streaks', 0.3),
      edge('fog', 'clear', 0.5),
      edge('fog', 'overcast', 0.5),
    ]),
    dwellHours: dwell({ thunderstorm: { min: 0.4, mean: 1, max: 2 }, gale: { min: 1, mean: 3, max: 8 } }),
    frontScripts: Object.freeze([{ id: 'cold-front', ratePerGameDay: 0.18 }]),
    eventRates: Object.freeze({}),
    tempByHour01: 'convectiveAfternoon',
  }),

  Object.freeze({
    id: 'moorland-mire',
    label: 'Moorland Mire',
    blurb: 'Damp and low. Fog owns the dawn; the sky rarely fully clears.',
    archetypeWeights: Object.freeze({
      clear: 0.14,
      'high-veil': 0.16,
      streaks: 0.08,
      overcast: 0.24,
      fog: 0.16,
      drizzle: 0.22,
    }),
    transitions: Object.freeze([
      edge('clear', 'fog', 0.35, 'radiativeDawn'),
      edge('clear', 'high-veil', 0.35),
      edge('clear', 'streaks', 0.2),
      edge('fog', 'clear', 0.4, 'radiativeDawn'),
      edge('fog', 'overcast', 0.5),
      edge('high-veil', 'overcast', 0.4),
      edge('high-veil', 'clear', 0.5),
      edge('streaks', 'high-veil', 0.4),
      edge('streaks', 'clear', 0.5),
      edge('overcast', 'drizzle', 0.5),
      edge('overcast', 'fog', 0.3, 'radiativeDawn'),
      edge('overcast', 'high-veil', 0.2),
      edge('drizzle', 'overcast', 0.5),
      edge('drizzle', 'fog', 0.2, 'radiativeDawn'),
      edge('drizzle', 'clear', 0.15),
    ]),
    dwellHours: dwell({ fog: { min: 1, mean: 4, max: 8 }, drizzle: { min: 2, mean: 5, max: 10 } }),
    frontScripts: Object.freeze([{ id: 'warm-front', ratePerGameDay: 0.1 }]),
    eventRates: Object.freeze({}),
    tempByHour01: 'radiativeDawn',
  }),

  Object.freeze({
    id: 'volcanic-waste',
    label: 'Volcanic Waste',
    blurb: 'Hazy and restless — the sky rarely reads as clean, calm air.',
    archetypeWeights: Object.freeze({
      'high-veil': 0.32,
      clear: 0.14,
      overcast: 0.24,
      gale: 0.16,
      thunderstorm: 0.14,
    }),
    transitions: Object.freeze([
      edge('clear', 'high-veil', 0.6),
      edge('clear', 'gale', 0.25),
      edge('high-veil', 'clear', 0.35),
      edge('high-veil', 'overcast', 0.45),
      edge('overcast', 'high-veil', 0.35),
      edge('overcast', 'thunderstorm', 0.2),
      edge('overcast', 'gale', 0.3),
      edge('gale', 'overcast', 0.4),
      edge('gale', 'clear', 0.35),
      edge('thunderstorm', 'gale', 0.6),
      edge('thunderstorm', 'overcast', 0.4),
    ]),
    dwellHours: dwell({ 'high-veil': { min: 3, mean: 8, max: 16 }, thunderstorm: { min: 0.5, mean: 1.5, max: 3 } }),
    frontScripts: Object.freeze([]),
    eventRates: Object.freeze({ volcanicUnrest: 0.2 }),
    tempByHour01: 'flat',
  }),

  Object.freeze({
    id: 'feywild-glade',
    label: 'Feywild Glade',
    blurb: 'Gentle and bright more often than not — the magical proof that a biome is just a data row.',
    archetypeWeights: Object.freeze({
      clear: 0.3,
      'fair-cumulus': 0.24,
      'high-veil': 0.14,
      mackerel: 0.1,
      broken: 0.08,
      overcast: 0.06,
      drizzle: 0.08,
    }),
    transitions: Object.freeze([
      edge('clear', 'fair-cumulus', 0.7),
      edge('clear', 'high-veil', 0.4),
      edge('fair-cumulus', 'clear', 0.6),
      edge('fair-cumulus', 'mackerel', 0.4),
      edge('mackerel', 'fair-cumulus', 0.6),
      edge('mackerel', 'broken', 0.25),
      edge('high-veil', 'clear', 0.7),
      edge('broken', 'fair-cumulus', 0.5),
      edge('broken', 'overcast', 0.25),
      edge('overcast', 'broken', 0.5),
      // "Petal-fall" is the biome's own precip SKIN (a slice-7 particle-archetype
      // choice, not built here) — the edge just reuses `drizzle` for now, exactly
      // the seam pattern `cloudFactorNode` already established: the mechanism
      // waits, the graph edge does not.
      edge('overcast', 'drizzle', 0.3),
      edge('drizzle', 'overcast', 0.4),
      edge('drizzle', 'clear', 0.35),
    ]),
    dwellHours: dwell({ drizzle: { min: 1, mean: 2, max: 4 } }),
    frontScripts: Object.freeze([]),
    eventRates: Object.freeze({ shimmer: 0.3 }),
    tempByHour01: 'flat',
  }),

  Object.freeze({
    id: 'shadowfell-verge',
    label: 'Shadowfell Verge',
    blurb: 'A gloom that never truly lifts — the clamp does the work, not the graph.',
    archetypeWeights: Object.freeze({
      'high-veil': 0.2,
      overcast: 0.35,
      broken: 0.2,
      fog: 0.15,
      drizzle: 0.1,
    }),
    transitions: Object.freeze([
      // No `clear` node, deliberately — this biome does not pretend the sky
      // can fully open. Even where a lighter archetype's row would say a low
      // cover, the biome's own `clamps` floor still applies at read time.
      edge('high-veil', 'overcast', 0.5),
      edge('high-veil', 'broken', 0.3),
      edge('overcast', 'broken', 0.4),
      edge('overcast', 'fog', 0.3),
      edge('overcast', 'drizzle', 0.3),
      edge('broken', 'overcast', 0.5),
      edge('broken', 'high-veil', 0.3),
      edge('fog', 'overcast', 0.6),
      edge('fog', 'broken', 0.4),
      edge('drizzle', 'overcast', 0.5),
      edge('drizzle', 'broken', 0.3),
    ]),
    dwellHours: dwell({ overcast: { min: 4, mean: 10, max: 20 } }),
    frontScripts: Object.freeze([]),
    eventRates: Object.freeze({ gloomPulse: 0.15 }),
    tempByHour01: 'flat',
    // Per-axis bounds the walk (and, per the design's "clamps bound
    // everything", a GM's own slider) cannot escape while this biome is
    // active. `cloudCover01` never reads below 0.6 — "permanent veil" is this
    // one number, not a special-cased render path.
    clamps: Object.freeze({ cloudCover01: Object.freeze({ min: 0.6 }) }),
  }),
]);

/** @type {readonly string[]} */
export const WEATHER_BIOME_IDS = Object.freeze(WEATHER_BIOMES.map((b) => b.id));

const BIOME_BY_ID = new Map(WEATHER_BIOMES.map((b) => [b.id, b]));

/**
 * Look a biome up by id, failing OPEN (never throwing) for an unknown one.
 * Unlike {@link resolveArchetype} there is no single "default biome" to fall
 * back to — Almanac mode with no biome selected is a legitimate idle state
 * (the walk simply never advances), so this returns `null` rather than
 * inventing a default climate nobody chose.
 * @param {string} id
 * @returns {Readonly<{ok: boolean, biome: object|null, reason: string|null}>}
 */
export function resolveBiome(id) {
  const found = typeof id === 'string' ? BIOME_BY_ID.get(id) : undefined;
  if (found) return Object.freeze({ ok: true, biome: found, reason: null });
  return Object.freeze({ ok: false, biome: null, reason: `unknown biome id ${JSON.stringify(id)}` });
}

/** @param {string} id @returns {boolean} */
export function isKnownBiome(id) {
  return typeof id === 'string' && BIOME_BY_ID.has(id);
}

/**
 * Every archetype id a biome's graph actually touches (as either end of an
 * edge). Used by validation and by the walk's own "pick a starting node".
 * @param {object} biome
 * @returns {string[]}
 */
export function biomeNodeIds(biome) {
  const s = new Set();
  for (const e of biome.transitions) {
    s.add(e.from);
    s.add(e.to);
  }
  return [...s];
}

/**
 * Is every node in this biome's graph reachable from every other, following
 * directed edges? The walk's own liveness guarantee: if this is false, some
 * node is either a dead end (no way out) or an island (no way in), and the
 * walk can silently freeze the moment it lands there.
 *
 * Small graphs (a dozen-odd nodes) — plain two-pass BFS is plenty, no need
 * for a real SCC algorithm.
 * @param {object} biome
 * @returns {boolean}
 */
export function isBiomeStronglyConnected(biome) {
  const nodes = biomeNodeIds(biome);
  if (nodes.length === 0) return false;
  const fwd = new Map(nodes.map((n) => [n, []]));
  const rev = new Map(nodes.map((n) => [n, []]));
  for (const e of biome.transitions) {
    fwd.get(e.from)?.push(e.to);
    rev.get(e.to)?.push(e.from);
  }
  const reachable = (start, adj) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };
  const start = nodes[0];
  const forwardReach = reachable(start, fwd);
  const backwardReach = reachable(start, rev);
  return nodes.every((n) => forwardReach.has(n) && backwardReach.has(n));
}
