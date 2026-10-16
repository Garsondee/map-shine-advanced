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
    activeLowLight: true,
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
    activeLowLight: false,
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
    'exactly the five grade-mode keys, in the documented order',
    PLAYER_VISION_GRADE_MODE_KEYS.length === 5 &&
      PLAYER_VISION_GRADE_MODE_KEYS[0] === 'nightVision' &&
      PLAYER_VISION_GRADE_MODE_KEYS[1] === 'lowLight' &&
      PLAYER_VISION_GRADE_MODE_KEYS[2] === 'activeLowLight' &&
      PLAYER_VISION_GRADE_MODE_KEYS[3] === 'infravision' &&
      PLAYER_VISION_GRADE_MODE_KEYS[4] === 'activeInfravision'
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
  {
    const nv = VISION_MODE_PRESETS.nightVision;
    const ll = VISION_MODE_PRESETS.lowLight;
    const activeLl = VISION_MODE_PRESETS.activeLowLight;
    ok(
      'nightVision is a softened V2 goggles profile: reduced gain/brightness, fully monochrome green',
      nv.gain < 10 && nv.gamma === 0.86 && nv.brightness < 2 && nv.saturation === 0 && nv.tintStrength === 1
    );
    ok(
      'nightVision tints green (green channel the largest, red none)',
      nv.tintRgb[1] > nv.tintRgb[2] && nv.tintRgb[2] > nv.tintRgb[0] && nv.tintRgb[0] === 0
    );
    ok(
      'nightVision has the device look: eyepiece, scanlines, sensor noise and phosphor shimmer',
      nv.eyepieceIntensity > 0 &&
        nv.scanIntensity > 0 &&
        nv.noiseAmount > 0 &&
        nv.noiseEdgeBoost > 0 &&
        nv.phosphorFlickerAmount > 0
    );
    ok(
      'nightVision softens V2 optics while retaining barrel distortion, RGB edge split and circular eyepiece',
      nv.distortionAmount < 0 &&
        Math.abs(nv.distortionAmount) < 0.18 &&
        nv.chromaticAberrationPx > 0 &&
        nv.chromaticAberrationPx < 6 &&
        nv.chromaticAberrationEdgePower === 4 &&
        nv.eyepieceStyle === 'single' &&
        nv.eyepieceSeparation === 0.26 &&
        nv.eyepieceRadius === 14 &&
        nv.eyepieceSoftness === 6
    );
    ok(
      'nightVision carries V2 power-on and softened scanline tuning',
      nv.warmupSeconds === 0.6 &&
        nv.shutdownSeconds === 0.4 &&
        nv.powerFlickerEnabled === true &&
        nv.bloomEnabled === true &&
        nv.bloomThreshold === 1.44 &&
        nv.bloomBlurPx === 9.8 &&
        nv.scanIntensity < 0.3
    );
    ok(
      'nightVision only brightens: the amplifier never crushes (lift >= 0, a real luminance cap)',
      nv.darkLift >= 0 && nv.maxLuma > 1 && nv.gain >= 1
    );
    ok(
      'lowLight is the weakest, muted scotopic adaptation with a token-centered falloff',
      ll.shadowGain < activeLl.shadowGain &&
        ll.darkSaturation < activeLl.darkSaturation &&
        ll.eyepieceRadius === activeLl.eyepieceRadius &&
        ll.eyepieceSoftness === activeLl.eyepieceSoftness
    );
    ok(
      'activeLowLight amplifies more and retains more colour than passive Low-light',
      activeLl.shadowGain > ll.shadowGain && activeLl.darkSaturation > ll.darkSaturation
    );
    ok(
      'infrared modes lift dim scene detail and keep their active sweep subdued',
      VISION_MODE_PRESETS.infravision.thermalGain > 1 &&
        VISION_MODE_PRESETS.activeInfravision.thermalGamma < 1 &&
        VISION_MODE_PRESETS.activeInfravision.scanBrightness < 0.1
    );
    ok(
      'lowLight lifts shadows, gently: a modest gain, a knee well inside the tonal range',
      ll.shadowGain > 0 && ll.shadowGain <= 2 && ll.shadowKnee > 0 && ll.shadowKnee < 0.6
    );
    ok(
      'amplification modes are gated by scene darkness (start < end, inside 0..1)',
      [nv, ll, activeLl].every(
        (m) => m.darknessGateStart >= 0 && m.darknessGateStart < m.darknessGateEnd && m.darknessGateEnd <= 1
      )
    );
    // ========================================================================
    // SATURATION + THE PURKINJE SHIFT (2026-10-15, author's own follow-up).
    // ========================================================================
    ok(
      'both low-light modes are genuinely desaturated, with the dark floor below the lit value (and inside 0..1)',
      [ll, activeLl].every(
        (m) =>
          m.baseSaturation > 0 && m.baseSaturation <= 1 && m.darkSaturation >= 0 && m.darkSaturation <= m.baseSaturation
      )
    );
    ok(
      'Low Light gives up far more colour than Low Light (Active) — "less saturation but not as low as plain Low Light"',
      ll.baseSaturation < activeLl.baseSaturation && ll.darkSaturation < activeLl.darkSaturation
    );
    ok(
      'the Purkinje shift crushes RED and holds blue/green on BOTH low-light modes (per-channel rod gain, ascending R→G→B)',
      [ll, activeLl].every(
        (m) => m.rodGainRgb[0] < m.rodGainRgb[1] && m.rodGainRgb[1] <= m.rodGainRgb[2] && m.rodGainRgb[0] < 1
      )
    );
    ok(
      'the Purkinje rod-weighted grey is blue/green heavy, so a saturated red drains toward near-black rather than its own brightness',
      [ll, activeLl].every(
        (m) =>
          m.rodLumaRgb[0] < m.rodLumaRgb[1] &&
          m.rodLumaRgb[0] < m.rodLumaRgb[2] &&
          Math.abs(m.rodLumaRgb[0] + m.rodLumaRgb[1] + m.rodLumaRgb[2] - 1) < 0.02
      )
    );
    ok(
      'the Purkinje amount is a real 0..1 blend on both low-light modes, strongest on the passive one',
      [ll, activeLl].every(
        (m) =>
          m.purkinjeStrength > 0 && m.purkinjeStrength <= 1 && m.purkinjeDesaturation > 0 && m.purkinjeDesaturation <= 1
      ) && ll.purkinjeStrength > activeLl.purkinjeStrength
    );
    // ========================================================================
    // THE SHARED TOKEN-CENTERED RANGE + THE THERMAL HOT-BODY RECOLOUR.
    // ========================================================================
    {
      const modes = [
        VISION_MODE_PRESETS.nightVision,
        VISION_MODE_PRESETS.lowLight,
        VISION_MODE_PRESETS.activeLowLight,
        VISION_MODE_PRESETS.infravision,
        VISION_MODE_PRESETS.activeInfravision,
      ];
      ok(
        'all FIVE grade modes drop off at the SAME token-centered range (one radius/softness pair, no mode with its own reach)',
        modes.every(
          (m) => m.eyepieceRadius === modes[0].eyepieceRadius && m.eyepieceSoftness === modes[0].eyepieceSoftness
        )
      );
      ok(
        'all FIVE grade modes reveal a bright light outside that range (start < end, inside 0..1) rather than hiding it',
        modes.every((m) => m.lightRevealStart >= 0 && m.lightRevealStart < m.lightRevealEnd && m.lightRevealEnd <= 1)
      );
      const thermal = [VISION_MODE_PRESETS.infravision, VISION_MODE_PRESETS.activeInfravision];
      ok(
        'the hot-body token recolour is unique to the two thermal modes',
        thermal.every((m) => m.tokenStrength > 0 && m.tokenStrength <= 1) &&
          [VISION_MODE_PRESETS.nightVision, VISION_MODE_PRESETS.lowLight, VISION_MODE_PRESETS.activeLowLight].every(
            (m) => m.tokenStrength === undefined
          )
      );
      ok(
        "the hot-body mask covers the token's own box and a little past it (scale >= 1), with a soft edge band inside that (0 < feather < 1)",
        thermal.every((m) => m.tokenScale >= 1 && m.tokenFeather01 > 0 && m.tokenFeather01 < 1)
      );
      ok(
        'the hot-body recolour can only BRIGHTEN a body — a gain above 1, a luminance floor above pure black, and a base heat inside the ramp',
        thermal.every(
          (m) =>
            m.tokenGain > 1 && m.tokenLumaFloor > 0 && m.tokenHeat > 0 && m.tokenHeat < 1 && m.tokenHeatFromLuma > 0
        )
      );
      // ======================================================================
      // THE 2026-10-15 LIVE VERDICTS, AS REGRESSION BARS: the modes brighten
      // the scene, they recolour by HUE only, and the cool end is not a violet
      // wash. See `thermalHueAtLuminance` for the mechanism all three rest on.
      // ======================================================================
      ok(
        'both thermal modes BRIGHTEN the scene — a real shadow lift on every one of them, never a pure tint',
        thermal.every((m) => m.shadowGain > 0 && m.shadowKnee > 0 && m.shadowKnee < 1 && m.darkLift >= 0)
      );
      ok(
        "a thermal mode recolours by HUE at the scene's own (lifted) luminance, so tintStrength is a taste knob, not a legibility one",
        thermal.every((m) => m.tintStrength > 0 && m.tintStrength <= 1)
      );
      ok(
        'activeInfravision is the brighter, broader, more powerful thermal mode (more lift, more heat, more hue and more body coverage than the passive one)',
        thermal[1].shadowGain > thermal[0].shadowGain &&
          thermal[1].thermalGain > thermal[0].thermalGain &&
          thermal[1].tintStrength > thermal[0].tintStrength &&
          thermal[1].tokenStrength > thermal[0].tokenStrength &&
          thermal[1].tokenScale > thermal[0].tokenScale &&
          thermal[1].tokenGain > thermal[0].tokenGain &&
          thermal[1].tokenHeat > thermal[0].tokenHeat
      );
      ok(
        'the thermal modes are darkness-gated the same way the amplification modes are',
        thermal.every(
          (m) => m.darknessGateStart >= 0 && m.darknessGateStart < m.darknessGateEnd && m.darknessGateEnd <= 1
        )
      );
    }
  }
  {
    const stops = VISION_MODE_PRESETS.infravision.rampStops;
    const coldest = stops[0];
    const hottest = stops[3];
    ok(
      'thermal ramp runs cool→warm across its 4 stops (blue channel highest at stop 0, red highest at the last stop)',
      coldest[2] > coldest[0] && hottest[0] > hottest[2]
    );
    ok(
      'the coldest stop is a VISIBLE, near-neutral grey — not the near-black violet that washed the map ("the purple colour is a problem too. It\'s far far too strong and obscures things")',
      coldest[0] > 0.3 && coldest[1] > 0.3 && coldest[2] - coldest[0] < 0.1
    );
    ok(
      'the warm stop is still emphatically thermal (red well clear of blue)',
      stops[2][0] - stops[2][2] > 0.5 && stops[2][0] > stops[2][1] && stops[2][1] > stops[2][2]
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
    'every one of the five grade modes resolves when allowed',
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
