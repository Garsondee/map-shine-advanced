/**
 * THE DOOR to effects/ — every pass door and (eventually) every effect
 * declaration crosses this threshold or does not cross at all.
 */
export { registerParticleSystem, buildParticlePass, stepParticles } from './particles/particle-engine.js';
export { validateParticleSystem, EMITTER_SHAPES, BEHAVIORS, SPAWN_KINDS } from './particles/particle-system-schema.js';
export { buildLightVisibilityPass } from './lighting/lighting-pass.js';
export {
  SUN_VISIBILITY_LIT,
  SUN_VISIBILITY_SHADOW,
  DEFAULT_WORKSPACE_LIGHT,
  clamp01 as clampVisibility01,
  combineVisibility,
  authoredShadowVisibility,
  composeSunTermWithMaxLight,
  shadowOffsetDirection,
  projectShadowOffset,
  shadowPenumbraPx,
  projectOccluderShadow,
  mapWindowRectToStamp,
  buildUiShadowVisibility,
  MAX_UI_SHADOW_STAMPS,
} from './lighting/light-visibility.js';
export {
  buildEnvironmentalLightMaterials,
  computeAmbientBackground,
  computeAmbientColors,
  computeGlobalLightFloor,
  maxRgb,
  FOUNDRY_LIGHT_WEIGHTS,
  mixRgb,
} from './lighting/environmental-light.js';
export {
  buildPointLightIlluminationMaterial,
  easeAttenuation,
  computeExposure,
  triangulateLightFan,
  writeLightEdgePoints,
  computeEdgeSoftMarginNormalized,
  MAX_LIGHT_EDGES,
} from './lighting/point-light-illumination.js';
export { buildPointLightColorationMaterial, computeColorationAlpha } from './lighting/point-light-coloration.js';
export {
  pointInRectangle,
  pointInEllipse,
  pointInPolygon,
  pointInCone,
  pointInRing,
  pointInLine,
  pointInEmanation,
  pointInRegionShapes,
  computeShapeMeshBounds,
  writeRegionPolygonPoints,
  applyDarknessAdjustment,
  computeRegionAdjustedDarkness,
  regionOverlapsElevationBand,
  DARKNESS_ADJUST_MODES,
  buildRegionRectangleMaterial,
  buildRegionEllipseMaterial,
  buildRegionPolygonMaterial,
  buildRegionConeMaterial,
  buildRegionRingMaterial,
  buildRegionLineMaterial,
  buildRegionEmanationRectangleMaterial,
  buildRegionEmanationPolygonMaterial,
  MAX_REGION_POLYGON_POINTS,
} from './lighting/region-darkness.js';
export { buildGradePass } from './grade/grade-pass.js';
export { buildWaterPass, buildFluidSimPass } from './water/water-pass.js';
export { buildSurfaceResponsePass } from './surface-response.js';

// ── EFFECT REGISTRATION (docs/planning/Effect-Registration.md) ──────────────
// The ONE door for an effect's enable/params/tier. UI-shadow is the first
// registrant; the registry is a documented SUBSET of Effects-API.md's contract
// that water's full reads/writes contract will subsume.
export { createEffectRegistry } from './registry.js';
export { validateEffectManifest } from './effect-manifest.js';
export {
  resolveEffectEnabled,
  resolveEffectParams,
  profileRank,
  PERFORMANCE_PROFILES,
  DEFAULT_PERFORMANCE_PROFILE,
  ENABLE_OVERRIDES,
} from './effect-cascade.js';
export { UI_WINDOW_SHADOW, UI_SHADOW_PARAMS } from './ui-window-shadow.js';
export {
  describeEffectSettings,
  deriveEffectLayers,
  effectEnableKey,
  choiceLabels,
  GLOBAL_SETTING_KEYS,
} from './effect-settings.js';
