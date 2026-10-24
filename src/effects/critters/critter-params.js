/**
 * CRITTER PARAMS — the parts of a declaration the three critter effects have in common.
 *
 * Flies, maggots and fireflies are three effects with one shape: a painted zone, a head-count
 * dealt across it, and a sky that decides how many of them are out. The controls for those
 * shared parts are the SAME controls in the same words, and the only thing that differs is the
 * default (a maggot does not mind the wind and a firefly does). Writing each control out three
 * times is how the three would drift apart in label, range and help text; here a control is
 * written once, and each effect says only what is different about it.
 *
 * Everything returned is plain frozen data — the declaration-first rule (`core/params-schema.js`)
 * is that a schema is data a renderer, a test and a human can all read, and these are.
 *
 * ⚠️ EVERY `category` BELOW MUST BE A MEMBER OF `ui/widgets/param-groups.js#CATEGORY_ORDER`. That
 * list is a CLOSED vocabulary: a control whose category is not in it is silently swept into
 * "Technical", and the Studio card then shows one undifferentiated pile — which is exactly what
 * these three cards did before this file existed. A Node test (`critter-declarations.test.mjs`)
 * holds every control to the list.
 *
 * @module effects/critters/critter-params
 */

/** Freeze a param map and every declaration in it. */
export function freezeParams(map) {
  for (const decl of Object.values(map)) Object.freeze(decl);
  return Object.freeze(map);
}

/**
 * The three controls every critter effect opens with: how many, how that scales with the blob,
 * and how much paint counts. `countId`/`countLabel` differ per effect (V2's `fliesPerZone`).
 *
 * @param {object} a
 * @param {string} a.countId - the param id of the head-count.
 * @param {string} a.noun - 'flies' | 'maggots' | 'fireflies'.
 * @param {string} a.unit - what one painted blob is called: 'swarm' | 'writhing mass' | 'colony'.
 * @param {number} a.max - the most one reference-sized blob may hold.
 * @param {number} a.count - the default head-count.
 * @param {number} a.areaScaling - the default area scaling.
 * @param {string} [a.countHelpExtra] - appended to the head-count's help.
 * @returns {Record<string, object>}
 */
export function presenceParams({ countId, noun, unit, max, count, areaScaling, countHelpExtra = '' }) {
  return {
    [countId]: {
      type: 'int',
      min: 0,
      max,
      step: 1,
      default: count,
      category: 'Presence',
      label: `${cap(noun)} per ${unit}`,
      help: `How many ${noun} a painted blob of reference size (about two and a half grid squares across) holds at full strength. Every separate painted blob is its own ${unit}.${countHelpExtra ? ' ' + countHelpExtra : ''}`,
    },
    areaScaling: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: areaScaling,
      category: 'Presence',
      label: `Bigger blob, bigger ${unit}`,
      help: `0 gives every painted blob the same number of ${noun}. 1 makes the ${unit} proportional to the blob’s area, so a painted marsh teems and a painted puddle does not.`,
    },
    maskSensitivity: {
      type: 'float',
      min: 0.02,
      max: 0.6,
      step: 0.01,
      default: 0.15,
      category: 'Presence',
      label: 'Mask sensitivity',
      help: `How much paint counts as part of a ${unit}’s zone. LOWER catches faint or thin strokes — turn it DOWN if ${noun} you painted are not appearing. HIGHER wants bold, solid paint.`,
    },
  };
}

/**
 * The weather-response block: how rain, snow, wind and cold thin the population
 * (`critter-weather.js#weatherFactor`) and how fast it reacts. The defaults are the effect's own
 * temperament — a firefly clears off in rain, a maggot barely notices.
 *
 * @param {object} a
 * @param {string} a.noun
 * @param {{rain: number, snow: number, windThreshold: number, wind: number, coldBelow: number, cold: number,
 *   floor: number, fadeTime: number}} a.defaults
 * @returns {Record<string, object>}
 */
export function weatherParams({ noun, defaults: d }) {
  return {
    rainResponse: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: d.rain,
      category: 'Weather',
      label: 'Rain clears them',
      help: `How many ${noun} rain sends away. At 1, steady rain clears them completely; at 0 they ignore it. Drizzle thins them in proportion.`,
    },
    snowResponse: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: d.snow,
      category: 'Weather',
      label: 'Snow clears them',
      help: `How many ${noun} snow sends away, separately from rain: a snow-proof, rain-shy ${noun === 'maggots' ? 'heap' : 'swarm'} is one slider each. Sleet counts as a mix of both.`,
    },
    windThreshold: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: d.windThreshold,
      category: 'Weather',
      label: 'Wind they tolerate',
      help: `How strong the wind has to be before ${noun} start to leave. 0 is any breath of air; 1 is only a full gale. Gusts count extra.`,
    },
    windResponse: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: d.wind,
      category: 'Weather',
      label: 'High wind clears them',
      help: `How completely a gale clears the ${noun} (once it is past the wind they tolerate). 0 means wind never drives them off.`,
    },
    coldBelow: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: d.coldBelow,
      category: 'Weather',
      label: 'Too cold below',
      help: 'The temperature (the weather’s own 0 = freezing … 1 = hot scale) under which the cold starts to bite. 0 means they never mind the cold.',
    },
    coldResponse: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: d.cold,
      category: 'Weather',
      label: 'Cold clears them',
      help: `How many ${noun} a freezing day sends away.`,
    },
    weatherFloor: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: d.floor,
      category: 'Weather',
      label: 'The brave few',
      help: `The fraction of ${noun} that stays out whatever the weather does. V2 kept a tenth out in a gale and a downpour.`,
    },
    fadeTime: {
      type: 'float',
      min: 0.3,
      max: 60,
      step: 0.1,
      default: d.fadeTime,
      category: 'Response',
      label: 'Reaction time (s)',
      help: `How long the ${noun} take to react when the sky changes — to thin out as the rain comes and to return when it passes. The head-count changes one individual at a time over this many seconds.`,
    },
  };
}

/**
 * The token-disturbance block (the goal's "flies/fireflies react to token position/proximity/
 * movement" ask, the sibling of `weatherParams` above — same category, `'Weather'`, because a
 * nearby creature is the identical KIND of external-world input a swarm has no params schema
 * section of its own for yet, and the closed category list (this file's own header) is not worth
 * growing by one for a two-control block). Read by `critter-token.js#nearestTokenSlots`'s callers
 * in `critter-subsystem.js`, consumed per-agent in `fly-brain.js`/`firefly-brain.js`. NOT offered to
 * maggots — see `critter-token.js`'s own header for why.
 *
 * @param {object} a
 * @param {string} a.noun - 'flies' | 'fireflies'.
 * @param {{response: number, radiusPx: number}} a.defaults - the effect's own temperament: how
 *   jumpy it is, and how close counts as "here".
 * @returns {Record<string, object>}
 */
export function tokenParams({ noun, defaults: d }) {
  return {
    tokenStartleResponse: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.05,
      default: d.response,
      category: 'Weather',
      label: 'Startled by tokens',
      help: `How strongly a nearby token sends ${noun} scattering — 0 ignores tokens entirely, 1 reacts to the lightest footstep.`,
    },
    tokenStartleRadius: {
      type: 'float',
      min: 20,
      max: 600,
      step: 10,
      default: d.radiusPx,
      category: 'Weather',
      label: 'Startle distance (px)',
      help: `How close a token has to come before ${noun} notice it at all.`,
    },
  };
}

/** @param {string} s */
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
