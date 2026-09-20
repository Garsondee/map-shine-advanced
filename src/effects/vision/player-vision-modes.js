/**
 * PLAYER VISION-MODE GRADES — the presets and the gate for the four
 * screen-space looks Night Vision / Low-light Vision / Infravision / Active
 * Infravision resolve to (mythica-machina-press#77 Stage 2b, #580's own
 * "real MSA thermal-vision post-process" ask).
 *
 * Deliberately separate from `foundry/player-light-mode.js#PLAYER_LIGHT_MODES`
 * (all six carried-light modes, Torch/Flashlight included) — THIS module only
 * knows the four that have a screen-space GRADE at all. Torch/Flashlight are
 * real MSA-rendered LIGHTS (Stage 2a, `point-light-pool.js`/the particle
 * engine), not a post-process tint, so they never resolve to a preset here.
 *
 * Same "one place, named constants" shape as `effects/lighting/player-light-
 * geometry.js#PLAYER_LIGHT_MODE_PRESETS` — a preset is a plain object of
 * tuned numbers, nothing else reaches into the shader to pick a value.
 *
 * ⚠️ REASONED, NOT MEASURED (same honesty posture as `environmental-
 * light.js#FLUID_SHADOW_TINT_STRENGTH`). #77's "concept only" scope note asks
 * for a good, distinct, functional look per mode — not V2's full per-control
 * depth (scanlines/phosphor/bloom/Purkinje-crossover/chromatic-aberration/
 * warm-up-flicker are real V2 controls, explicitly deferred as follow-up
 * depth, not this build's bar). If the author wants a mode stronger/weaker/
 * more-or-less saturated by eye, these are the numbers to change.
 *
 * @module effects/vision/player-vision-modes
 */

/** The four mode keys that have a screen-space grade at all — a strict
 * subset of `PLAYER_LIGHT_MODES` (`torch`/`flashlight` excluded: they render
 * as real lights, not a tint on the final image). */
export const PLAYER_VISION_GRADE_MODE_KEYS = Object.freeze([
  'nightVision',
  'lowLight',
  'infravision',
  'activeInfravision',
]);

/**
 * Named, tuned constants per mode. Every number here is a deliberate design
 * choice, not a measurement — see this module's own header.
 *
 * Shared vocabulary across modes:
 *   - `gain`       multiplies luminance before the tint/ramp (brightness/amp boost)
 *   - `floorLift`  additive black-floor lift, so total darkness reads as a dim
 *                  glow rather than pure black (both amplification modes)
 *   - `grainAmount` per-pixel animated noise amplitude, 0 = none
 *
 * @type {Readonly<Record<string, object>>}
 */
export const VISION_MODE_PRESETS = Object.freeze({
  /** Classic image-intensifier NVG: strong green monochrome, real gain,
   * grain, and a soft eyepiece vignette — the most "textbook NVG" of the
   * four, deliberately the most heavily tinted/desaturated mode. */
  nightVision: Object.freeze({
    tintRgb: Object.freeze([0.35, 1.0, 0.42]),
    gain: 2.4,
    floorLift: 0.06,
    // How strongly the output is pulled toward the flat monochrome-green
    // tint vs. the (gained) true colour — 1 = fully monochrome NVG, 0 = tint
    // has no effect. Real NVG reads as almost entirely monochrome.
    tintMix01: 0.88,
    grainAmount: 0.05,
    grainSpeed: 14,
    vignetteStrength: 0.38,
    vignetteRadius: 0.72,
  }),
  /** A gentler amplification — brighter shadows, mild desaturation, a
   * near-neutral (NOT green) cool-white tint, no grain/vignette. Reads as
   * "your eyes adjusted to the dark", not a device look. */
  lowLight: Object.freeze({
    tintRgb: Object.freeze([0.93, 0.97, 1.0]),
    gain: 1.55,
    floorLift: 0.1,
    tintMix01: 0.22,
    // Partial desaturation toward luminance — a device look drains colour
    // entirely; low-light adaptation only mutes it.
    desaturate01: 0.35,
    grainAmount: 0,
    grainSpeed: 0,
    vignetteStrength: 0,
    vignetteRadius: 1,
  }),
  /** A false-colour thermal ramp — cool/dark biased toward blue-purple,
   * warm/bright biased toward orange-red, using the final composited
   * luminance as the heat proxy (see `buildThermalRampNode`'s own header
   * for why). Passive-sensing feel: no scan sweep, moderate contrast. */
  infravision: Object.freeze({
    rampStops: Object.freeze([
      Object.freeze([0.04, 0.0, 0.12]), // coldest — near-black purple
      Object.freeze([0.08, 0.08, 0.55]), // cool — blue
      Object.freeze([0.95, 0.35, 0.05]), // warm — orange-red
      Object.freeze([1.0, 0.92, 0.55]), // hottest — pale yellow-white
    ]),
    contrastPower: 1.0,
    grainAmount: 0.02,
    grainSpeed: 6,
    scanAmount: 0, // no active sweep — see `activeInfravision` below
  }),
  /** The same thermal ramp, sharpened (higher contrast, so hot/cold
   * separate more aggressively) plus a bright horizontal sweep band that
   * loops down the screen — reads as an ACTIVELY scanning sensor rather
   * than passive heat-sensing. */
  activeInfravision: Object.freeze({
    rampStops: Object.freeze([
      Object.freeze([0.04, 0.0, 0.12]),
      Object.freeze([0.08, 0.08, 0.55]),
      Object.freeze([0.95, 0.35, 0.05]),
      Object.freeze([1.0, 0.92, 0.55]),
    ]),
    contrastPower: 1.5,
    grainAmount: 0.03,
    grainSpeed: 6,
    scanAmount: 1,
    scanSpeedHz: 0.35, // one full sweep every ~2.9s
    scanBandWidth: 0.05, // fraction of screen height
    scanBrightness: 0.22,
  }),
});

/**
 * THE GATE — should THIS client's present pass apply a vision-mode grade
 * right now, and which one? Pure and total: every live Foundry/canvas read
 * (which token is mine, what that token's flag says, what the scene
 * currently allows, whether I am a GM) happens at the CALLER's own call site
 * (`boot.js`'s injected `getActivePlayerVisionMode` closure — mirrors
 * `player-light-mode.js#readActivePlayerCarriedLightTokens`'s own "live read
 * vs. pure resolver" split), never here.
 *
 * ⚠️ A GM NEVER GETS A GRADE, EVEN IF `mode` IS SET. Mirrors `ui/rooms/
 * player-light-picker.js`'s own posture exactly: a GM has no personal
 * carried light/vision the way a player does (`resolveViewerToken()`'s own
 * header — it deliberately does NOT exclude a GM itself; every caller that
 * needs the exclusion makes it at its own call site, and this is that call
 * site for the render gate).
 *
 * @param {object} args
 * @param {boolean} args.isGM - `foundry/viewer-token.js#isViewingUserGM()`'s result.
 * @param {string|null} args.mode - `readTokenPlayerLightMode()`'s result for
 *   the viewer's own token (or `null` — no token, no mode, torch/flashlight).
 * @param {{modes: Record<string, boolean>}} args.permissions -
 *   `readScenePlayerLightPermissions().permissions`.
 * @returns {string|null} one of `PLAYER_VISION_GRADE_MODE_KEYS`, or `null`
 *   (no grade should render this frame).
 */
export function resolveActivePlayerVisionModePreset({ isGM, mode, permissions }) {
  if (isGM) return null;
  if (!PLAYER_VISION_GRADE_MODE_KEYS.includes(mode)) return null;
  if (permissions?.modes?.[mode] !== true) return null;
  return mode;
}
