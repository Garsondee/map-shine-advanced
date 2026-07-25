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
 * Neutral ambient palette — a light-grey day, a cool-dark night, a white
 * brightest. The LIVE path always supplies Foundry's real palette
 * (`foundry/scene-environment.js#readSceneAmbient`), so this default only
 * governs a snapshot built with no ambient input (tests, a pre-scene frame).
 * It intentionally resembles Foundry's own fallback so a snapshot built
 * without a scene still reads plausibly, but the Foundry values are NOT
 * duplicated as authority — they enter as an input, per the one-way rule.
 * Endpoints are sRGB 0..1 (the space `canvas.colors` stores; the light pass
 * converts as needed).
 */
export const DEFAULT_AMBIENT = Object.freeze({
  daylight: Object.freeze([0.93, 0.93, 0.93]),
  darkness: Object.freeze([0.14, 0.14, 0.28]),
  brightest: Object.freeze([1, 1, 1]),
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
 * @param {{daylight:number[], darkness:number[], brightest:number[]}} [inputs.ambientInput] -
 *   Foundry's ambient palette endpoints (sRGB 0..1), read via the adapter. The
 *   light pass mixes `background = mix(daylight, darkness, darknessLevel)` from these.
 * @param {import('./sun.js').SunConfig} [inputs.sunConfig]
 * @returns {Readonly<object>} the env snapshot.
 */
export function buildEnvSnapshot({
  time,
  todHour,
  weather,
  wind,
  darknessInput = 0,
  ambientInput = DEFAULT_AMBIENT,
  sunConfig = DEFAULT_SUN_CONFIG,
}) {
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
  //
  // Keyed to the SKY, not to the direct sun (2026-07-23, author: *"allowing
  // darkness to hit 1 at a point after dusk and before dawn"*). `dayFactor01`
  // dies as the sun touches the horizon; `skyFactor01` carries the lit sky down
  // through the three twilights and only reaches 0 at `fullDarkElevationDeg`.
  // Using the former made the scene snap to full night at sunset and deleted
  // the blue hour entirely — there was no window where the sun gave nothing but
  // the sky still gave something. See world/sun.js#SKY_PHASES.
  const nightDarkness = 1 - sun.skyFactor01;
  const darkness01 = clamp01(Math.max(nightDarkness, clamp01(darknessInput)));

  const amb = ambientInput ?? DEFAULT_AMBIENT;

  return deepFreeze({
    // BOTH clocks ride the call sheet (core/frame-clock.js's own header says
    // why there are two): `tMs`/`dtSec` are SIM time — scaled, and what every
    // effect reads, so the pause ramp reaches all of them without any of them
    // knowing it exists. `realMs`/`realDtSec` are wall time, for the handful of
    // housekeeping consumers (throttles, hitch logs, probes) that must keep
    // counting while the world is stopped. `timeScale`/`paused` are carried so
    // a diagnostic can SHOW the ramp rather than infer it.
    time: {
      frame: time.frame,
      tMs: time.tMs,
      dtSec: time.dtSec,
      realMs: Number.isFinite(time.realMs) ? time.realMs : time.tMs,
      realDtSec: Number.isFinite(time.realDtSec) ? time.realDtSec : time.dtSec,
      timeScale: Number.isFinite(time.timeScale) ? time.timeScale : 1,
      paused: time.paused === true,
      todHour: hour,
    },
    sun,
    // Foundry's ambient endpoints (sRGB 0..1). Carried through so the light
    // pass reproduces Foundry's own ladder rather than re-reading a global.
    ambient: {
      daylight: clampRgb(amb.daylight, DEFAULT_AMBIENT.daylight),
      darkness: clampRgb(amb.darkness, DEFAULT_AMBIENT.darkness),
      brightest: clampRgb(amb.brightest, DEFAULT_AMBIENT.brightest),
    },
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

/**
 * Clamp an rgb triple into [0,1]³, falling back to `fallback` if it is not a
 * usable triple. The adapter already validates the live path; this is the
 * snapshot's own belt so a malformed input can never reach a shader uniform.
 * @param {number[]} rgb @param {readonly number[]} fallback @returns {[number,number,number]}
 */
function clampRgb(rgb, fallback) {
  if (!Array.isArray(rgb) || rgb.length < 3) return [fallback[0], fallback[1], fallback[2]];
  return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
}

/** Freeze an object tree so the call sheet is genuinely read-only. */
function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}
