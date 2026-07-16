/**
 * THE ENV SNAPSHOT — the frame's call sheet. One frozen value per frame carrying
 * time, sun, weather, wind and darkness; every downstream pass READS it and
 * nothing else may answer those questions.
 *
 * WHY (docs/planning/Environment.md — the audit this module answers):
 * V2's clock lived INSIDE the weather controller (`WeatherController.js:184`,
 * `this.timeOfDay = 12.0`) — time was a *field of* weather, so the two systems
 * that should have composed were hierarchically entangled, twenty files grew
 * their own time, eight grew their own sun, and darkness was round-tripped
 * THROUGH Foundry's scene document as a feedback bus (28 readers of MSA's own
 * write; two months of dated scars over one float).
 *
 * THE SHAPE OF THE FIX — arrows point one way:
 *
 *   clock → time → sun = f(time) → env snapshot → every consumer
 *                weather = f(time, weatherState) ↗
 *
 * Time is UPSTREAM of weather, never inside it. Weather cannot cache a stale
 * sky (the documented `_staticSnapped` bug) because weather never caches sky
 * outputs at all — the snapshot is rebuilt each frame from inputs, and it is
 * cheap because it is a handful of numbers.
 *
 * DARKNESS — the one-direction-of-authority rule (Environment.md §2.2): this
 * module is the ONLY place `darknessLevel` may appear outside `foundry/` (the
 * `env/one-darkness` tripwire enforces it). Foundry's value arrives here as an
 * INPUT, is folded into one number, and is NEVER written back. If the project
 * later decides MSA owns darkness instead, the write happens in `foundry/`
 * and this module still just reads its input — either way there is exactly one
 * home and no read-back loop.
 *
 * This is the PURE CORE of the `frame.snapshot` pass (graph/passes.js). The
 * pass wiring (who calls this, from what Foundry inputs) lands with the frame
 * loop integration; everything here is Node-tested today.
 *
 * @module world/environment
 */

import { computeSun, normalizeHour, DEFAULT_SUN_CONFIG } from './sun.js';

/**
 * Neutral defaults: clear, windless noon. A scene with no weather state reads
 * as V2's own "canonical fresh-scene default: clear noon".
 */
export const DEFAULT_WEATHER = Object.freeze({
  preset: 'clear',
  precip01: 0,
  cloudCover01: 0,
  wetness01: 0,
});

export const DEFAULT_WIND = Object.freeze({
  directionDeg: 0,
  speed01: 0,
  gustiness01: 0,
});

/**
 * Build the frame's environment snapshot. Pure: same inputs → same value.
 * Everything is normalised, clamped and DEEP-FROZEN — a consumer cannot
 * scribble on the call sheet (V2's params blackboard, 938 keys, 119 external
 * writers, is the disease this prevents).
 *
 * @param {object} inputs
 * @param {Readonly<{frame: number, tMs: number, dtSec: number}>} inputs.time - from core/frame-clock.
 * @param {number} inputs.todHour - time of day, hours 0..24.
 * @param {object} [inputs.weather] - weather owner's state (shape of DEFAULT_WEATHER).
 * @param {object} [inputs.wind] - wind owner's state (shape of DEFAULT_WIND).
 * @param {number} [inputs.darknessInput] - Foundry's darknessLevel, 0..1, read via the adapter.
 * @param {import('./sun.js').SunConfig} [inputs.sunConfig]
 * @returns {Readonly<object>} the env snapshot.
 */
export function buildEnvSnapshot({ time, todHour, weather, wind, darknessInput = 0, sunConfig = DEFAULT_SUN_CONFIG }) {
  if (!time || !Number.isFinite(time.tMs)) {
    // Loud, not silent: an env without a clock is a programming error upstream,
    // and 2,670 swallowed errors is how V2 kept problems invisible.
    throw new Error('buildEnvSnapshot: `time` must be a frame-clock snapshot ({frame, tMs, dtSec})');
  }

  const hour = normalizeHour(todHour);
  const sun = computeSun(hour, sunConfig);
  const w = { ...DEFAULT_WEATHER, ...(weather ?? {}) };
  const wd = { ...DEFAULT_WIND, ...(wind ?? {}) };

  // ONE darkness, derived in ONE place: the darker of "what the night implies"
  // and "what Foundry/GM asked for". A GM sliding darkness up mid-day wins;
  // night wins over a GM who left it at 0. min/max chosen over multiplication
  // so neither authority can be silently diluted by the other.
  const nightDarkness = 1 - sun.dayFactor01;
  const darkness01 = clamp01(Math.max(nightDarkness, clamp01(darknessInput)));

  return deepFreeze({
    time: { frame: time.frame, tMs: time.tMs, dtSec: time.dtSec, todHour: hour },
    sun,
    weather: {
      preset: String(w.preset),
      precip01: clamp01(w.precip01),
      cloudCover01: clamp01(w.cloudCover01),
      wetness01: clamp01(w.wetness01),
    },
    wind: {
      directionDeg: ((Number(wd.directionDeg) % 360) + 360) % 360,
      speed01: clamp01(wd.speed01),
      gustiness01: clamp01(wd.gustiness01),
    },
    darkness01,
  });
}

/** @param {number} x @returns {number} */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Freeze an object tree so the call sheet is genuinely read-only. */
function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}
