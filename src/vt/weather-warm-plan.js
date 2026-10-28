/**
 * vt/weather-warm-plan.js — WHICH WEATHER-DRIVEN SHADERS ARE COMPILED DURING LOADING (2026-10-28).
 *
 * ============================================================================
 * THE PROBLEM
 * ============================================================================
 * Rain, snow, wind trails and the cloud tops are all ABSENT at the moment the load-time warm-up draws the frame:
 * the sky is clear, the wind is calm, the camera is close. Absent means no mesh is submitted (Effects.md Law 4 —
 * "a clear day costs nothing"), so none of their pipelines is ever asked for, and each compiles on the FIRST
 * frame the GM turns it on. At a desk that is a multi-second freeze every time a control is touched during
 * testing; at the table it is the same freeze in front of the players.
 *
 * ============================================================================
 * THE FIX, AND WHY IT IS SAFE
 * ============================================================================
 * Show each of them to the renderer ONCE, behind the loading curtain, then put everything back. The render
 * path is the real one (so the pipeline built is the pipeline a real frame wants); only the gate that keeps it
 * out is forced open for the duration of one synchronous block.
 *
 * What keeps this from becoming the context-loss crash that `core/compile-policy.js` exists to prevent:
 *
 *   - ONE SCENARIO PER TASK. Each scenario is its own macrotask, with a frame between, so the pipeline
 *     governor's per-task synchronous compile budget (`SYNC_CHARS_PER_TASK`) starts over for each one. A burst
 *     of compiles in a single task is what the GPU watchdog sums.
 *   - NOTHING IS MADE SYNCHRONOUS. The warm-up does not use `governor.blocking`; the heavy pipelines (rain
 *     curtain, storm fog, torrent) are the deferrable ones and compile on worker threads. After each scenario
 *     the loader waits for the compiles in flight (`settleCompiles`) before starting the next.
 *   - A DISABLED EFFECT IS NOT WARMED. A low-end profile that turned the cloud tops off pays nothing for them.
 *
 * Pure: no renderer, no clock. Node-tested.
 *
 * @module vt/weather-warm-plan
 */

/**
 * @typedef {object} WeatherWarmScenario
 * @property {string} id - stable key, for the log and the tests.
 * @property {string} label - what the loading screen says it is doing.
 * @property {'precip'|'windTrails'|'cloudTops'} type
 * @property {string[]} passes - pass-plan ids to draw, in order.
 * @property {string} [kind] - the precipitation kind to force (`type: 'precip'` only).
 */

const KIND_LABEL = Object.freeze({ rain: 'rain', snow: 'snow', hail: 'hail', ash: 'ash fall' });

/**
 * @param {object} state
 * @param {string[]} [state.precipKinds] - from `precipitationSubsystem.warmUpKinds()`; empty when the effect is off.
 * @param {boolean} [state.windTrails] - the wind-trails effect is enabled.
 * @param {boolean} [state.cloudTops] - the cloud-tops effect is enabled.
 * @returns {WeatherWarmScenario[]} in the order they should run.
 */
export function planWeatherWarmUp({ precipKinds = [], windTrails = false, cloudTops = false } = {}) {
  /** @type {WeatherWarmScenario[]} */
  const out = [];
  for (const kind of precipKinds) {
    out.push({
      id: `precip:${kind}`,
      label: KIND_LABEL[kind] ?? kind,
      type: 'precip',
      kind,
      // Rain alone also draws the roof-edge drips, which live in the WORLD scene rather than the weather pass.
      passes: kind === 'rain' ? ['geometry.world', 'surface.precipitation'] : ['surface.precipitation'],
    });
  }
  if (windTrails) {
    out.push({ id: 'windTrails', label: 'wind trails', type: 'windTrails', passes: ['surface.particles'] });
  }
  if (cloudTops) {
    out.push({ id: 'cloudTops', label: 'cloud tops', type: 'cloudTops', passes: ['surface.cloudTops'] });
  }
  return out;
}

/**
 * The loading screen's line for one scenario.
 * @param {WeatherWarmScenario} scenario
 * @returns {string}
 */
export function formatWeatherWarmDetail(scenario) {
  return `Preparing ${scenario.label} so it appears instantly later`;
}
