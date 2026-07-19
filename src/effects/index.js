/**
 * THE DOOR to effects/ — every pass door and (eventually) every effect
 * declaration crosses this threshold or does not cross at all.
 */
export { registerParticleSystem, buildParticlePass, stepParticles } from './particles/particle-engine.js';
export { validateParticleSystem, EMITTER_SHAPES, BEHAVIORS, SPAWN_KINDS } from './particles/particle-system-schema.js';
export { buildLightVisibilityPass } from './lighting/lighting-pass.js';
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
