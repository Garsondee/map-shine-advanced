/**
 * Node verification for effects/vision/player-vision-modes.js
 * (mythica-machina-press#77 Stage 2b, #580) — the gate function's own
 * "should THIS client's present pass apply a vision-mode grade right now"
 * rule, and the preset table's shape. The TSL half (`player-vision-grade-
 * render.js`) is untested here — see that file's own header for why.
 */
import {
  PLAYER_VISION_GRADE_MODE_KEYS,
  VISION_MODE_PRESETS,
  resolveActivePlayerVisionModePreset,
} from '../player-vision-modes.js';

const ALL_ALLOWED = Object.freeze({
  modes: Object.freeze({
    torch: true,
    flashlight: true,
    nightVision: true,
    lowLight: true,
    infravision: true,
    activeInfravision: true,
  }),
});

const NONE_ALLOWED = Object.freeze({
  modes: Object.freeze({
    torch: false,
    flashlight: false,
    nightVision: false,
    lowLight: false,
    infravision: false,
    activeInfravision: false,
  }),
});

export function run(t) {
  const { ok } = t;

  // ==========================================================================
  // THE PRESET TABLE — one entry per grade mode key, nothing extra/missing.
  // ==========================================================================
  ok(
    'exactly the four grade-mode keys, in the documented order',
    PLAYER_VISION_GRADE_MODE_KEYS.length === 4 &&
      PLAYER_VISION_GRADE_MODE_KEYS[0] === 'nightVision' &&
      PLAYER_VISION_GRADE_MODE_KEYS[1] === 'lowLight' &&
      PLAYER_VISION_GRADE_MODE_KEYS[2] === 'infravision' &&
      PLAYER_VISION_GRADE_MODE_KEYS[3] === 'activeInfravision'
  );
  ok(
    'every grade-mode key has a preset',
    PLAYER_VISION_GRADE_MODE_KEYS.every((k) => VISION_MODE_PRESETS[k] && typeof VISION_MODE_PRESETS[k] === 'object')
  );
  ok(
    'torch/flashlight have no screen-grade preset (they are real lights, not a tint)',
    VISION_MODE_PRESETS.torch === undefined && VISION_MODE_PRESETS.flashlight === undefined
  );
  ok(
    'infravision and activeInfravision share the same thermal ramp stops (same palette, different sharpness)',
    JSON.stringify(VISION_MODE_PRESETS.infravision.rampStops) ===
      JSON.stringify(VISION_MODE_PRESETS.activeInfravision.rampStops)
  );
  ok(
    'activeInfravision is sharper (higher contrastPower) than plain infravision',
    VISION_MODE_PRESETS.activeInfravision.contrastPower > VISION_MODE_PRESETS.infravision.contrastPower
  );
  ok(
    'activeInfravision has an active scan sweep, plain infravision does not',
    VISION_MODE_PRESETS.activeInfravision.scanAmount > 0 && VISION_MODE_PRESETS.infravision.scanAmount === 0
  );
  ok(
    'nightVision is a heavier tint than lowLight — the two must not read as duplicates',
    VISION_MODE_PRESETS.nightVision.tintMix01 > VISION_MODE_PRESETS.lowLight.tintMix01
  );
  ok(
    'nightVision tints green, lowLight tints near-neutral (not green) — visually distinct kinds of tint',
    VISION_MODE_PRESETS.nightVision.tintRgb[1] > VISION_MODE_PRESETS.nightVision.tintRgb[0] &&
      VISION_MODE_PRESETS.nightVision.tintRgb[1] > VISION_MODE_PRESETS.nightVision.tintRgb[2] &&
      Math.abs(VISION_MODE_PRESETS.lowLight.tintRgb[0] - VISION_MODE_PRESETS.lowLight.tintRgb[1]) < 0.1
  );
  ok(
    'nightVision has grain/vignette, lowLight has neither (device look vs. adapted eyes)',
    VISION_MODE_PRESETS.nightVision.grainAmount > 0 &&
      VISION_MODE_PRESETS.nightVision.vignetteStrength > 0 &&
      VISION_MODE_PRESETS.lowLight.grainAmount === 0 &&
      VISION_MODE_PRESETS.lowLight.vignetteStrength === 0
  );
  {
    const stops = VISION_MODE_PRESETS.infravision.rampStops;
    const coldest = stops[0];
    const hottest = stops[3];
    ok(
      'thermal ramp runs cool→warm across its 4 stops (blue channel highest at stop 0, red highest at the last stop)',
      coldest[2] > coldest[0] && hottest[0] > hottest[2]
    );
  }

  // ==========================================================================
  // THE GATE — resolveActivePlayerVisionModePreset
  // ==========================================================================
  ok(
    'an allowed mode for a non-GM resolves to itself',
    resolveActivePlayerVisionModePreset({ isGM: false, mode: 'nightVision', permissions: ALL_ALLOWED }) ===
      'nightVision'
  );
  ok(
    'every one of the four grade modes resolves when allowed',
    PLAYER_VISION_GRADE_MODE_KEYS.every(
      (mode) => resolveActivePlayerVisionModePreset({ isGM: false, mode, permissions: ALL_ALLOWED }) === mode
    )
  );
  ok(
    'a GM NEVER gets a grade, even with a mode set and the scene allowing it',
    resolveActivePlayerVisionModePreset({ isGM: true, mode: 'nightVision', permissions: ALL_ALLOWED }) === null
  );
  ok(
    'no mode (null — no token, or no pick) resolves to null',
    resolveActivePlayerVisionModePreset({ isGM: false, mode: null, permissions: ALL_ALLOWED }) === null
  );
  ok(
    'torch/flashlight (real lights, no grade) never resolve to a grade preset',
    resolveActivePlayerVisionModePreset({ isGM: false, mode: 'torch', permissions: ALL_ALLOWED }) === null &&
      resolveActivePlayerVisionModePreset({ isGM: false, mode: 'flashlight', permissions: ALL_ALLOWED }) === null
  );
  ok(
    'an unrecognized/modded mode string resolves to null, not a throw',
    resolveActivePlayerVisionModePreset({ isGM: false, mode: 'some-modded-value', permissions: ALL_ALLOWED }) === null
  );
  ok(
    'the GM having disallowed this mode on the scene wins over the token having it picked',
    resolveActivePlayerVisionModePreset({ isGM: false, mode: 'nightVision', permissions: NONE_ALLOWED }) === null
  );
  ok(
    'a missing/malformed permissions object fails CLOSED (no grade), not a throw',
    resolveActivePlayerVisionModePreset({ isGM: false, mode: 'nightVision', permissions: null }) === null &&
      resolveActivePlayerVisionModePreset({ isGM: false, mode: 'nightVision', permissions: {} }) === null
  );
}
