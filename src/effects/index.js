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
// ── ANIMATED LIGHTS (docs/planning/Light-Parity.md §5's last item;
// docs/reference/foundry-v14-light-animations-audit.md) ─────────────────────
export { LIGHT_ANIMATIONS, KNOWN_DEFERRED_ANIMATIONS, resolveLightAnimation } from './lighting/animations/registry.js';
export {
  computeAnimationTime,
  SmoothNoise,
  computeFlickerUniforms,
  computePulseUniforms,
} from './lighting/animations/light-animation-clock.js';
export {
  fbmFloat,
  fbmVec3,
  voronoiFloat,
  voronoiVec3,
  simplexFloat,
  hsb2rgb,
  pie,
  rotate2d,
} from './lighting/animations/tsl-noise-toolkit.js';
// Region darkness split 2026-07-25 (size-ratchet god-object reversal): pure CPU
// geometry/darkness math in region-geometry.js, TSL material builders in
// region-darkness.js. Both re-exported here so the effects zone door is unchanged.
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
} from './lighting/region-geometry.js';
export {
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
export { CANDLE_FLAME, CANDLE_FLAME_PARAMS } from './candle-flame.js';
// The candle RUNTIME (candle-flame-render.js's header explains why a candle is
// a billboard + a light, not a particle): pure geometry/colour/light-source math
// + the TSL flame material. The viewer imports these through this door exactly
// as it imports the lighting builders.
export {
  buildCandleFlameMaterial,
  buildCandleFlameGeometry,
  buildCandleLightSources,
  computeCandleFlameArrays,
  candleCirclePolygon,
  hexToRgb01,
} from './candle-flame-render.js';
export {
  describeEffectSettings,
  deriveEffectLayers,
  effectEnableKey,
  choiceLabels,
  GLOBAL_SETTING_KEYS,
} from './effect-settings.js';
