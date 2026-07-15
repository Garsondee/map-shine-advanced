/**
 * Neutral calibration targets for preset-insight scoring.
 */

export const NEUTRAL_TARGET_PATHS = Object.freeze({
  'effects.colorCorrection.exposure': 1,
  'effects.colorCorrection.masterGamma': 1,
  'effects.colorCorrection.gammaColor.r': 1,
  'effects.colorCorrection.gammaColor.g': 1,
  'effects.colorCorrection.gammaColor.b': 1,
  'effects.colorCorrection.brightness': 0,
  'effects.colorCorrection.contrast': 1,
  'effects.colorCorrection.saturation': 1,
  'effects.colorCorrection.vibrance': 0,
  'effects.colorCorrection.temperature': 0,
  'effects.colorCorrection.tint': 0,
  'effects.colorCorrection.toneMapping': 0,
  'effects.colorCorrection.todTimelineEnabled': false,
  'effects.colorCorrection.atmosphereEnabled': false,
  'effects.lighting.lightIntensity': 1,
  'effects.lighting.colorationStrength': 0,
  'effects.lighting.colorationReflectivity': 0,
  'effects.lighting.colorationSaturation': 0,
  'effects.lighting.globalIllumination': 1,
  'effects.lighting.ambientDayScale': 1,
  'effects.lighting.ambientNightScale': 1,
  'effects.lighting.combinedShadowEffectStrength': 0,
  'effects.bloom.enabled': false,
  'effects.atmospheric-fog.enabled': false,
  'effects.fog.enabled': false,
});

export function neutralTargetEntries() {
  return Object.entries(NEUTRAL_TARGET_PATHS);
}
