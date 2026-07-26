/**
 * THE DOOR to effects/ — every pass door and (eventually) every effect
 * declaration crosses this threshold or does not cross at all.
 */
export { validateParticleSystem, EMITTER_SHAPES, BEHAVIORS, SPAWN_KINDS } from './particles/particle-system-schema.js';
export {
  ParticleArena,
  describeParticleArena,
  PARTICLE_ATTRIBUTES,
  BYTES_PER_PARTICLE,
  DEFAULT_BUDGET_BYTES,
} from './particles/particle-arena.js';
export { createParticleEngine } from './particles/particle-engine.js';
export { WIND_DIAGNOSTIC_PARTICLES } from './particles/wind-diagnostic-particles.js';
export { createGustEngine } from './particles/particle-engine.js';
export { WIND_GUSTS } from './particles/wind-gusts.js';
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
  softenThrowPx,
} from './lighting/light-visibility.js';
// SUN OCCLUSION (docs/planning/Sun-Shadows.md) — building, overhead and
// sky-reach shadows as ONE occluder height field read by ONE march. The pure
// maths; `sun-occlusion-render.js` is its TSL transcription.
export {
  marchDirectionToSun,
  marchVisibility,
  marchStepPx,
  marchPenumbraPx,
  maxThrowPx,
  sunNeedsRebake,
  angleDeltaDeg,
  edgeRamp01,
  resolveSunMarch,
  sharpenReceiverGate01,
  DEFAULT_MARCH_STEPS,
  PENUMBRA_PER_PX,
  GATE_SHARPEN_LOW,
  GATE_SHARPEN_HIGH,
} from './lighting/sun-occlusion.js';
export { buildSunShadowBakeMaterial, buildSunVisibilityNode } from './lighting/sun-occlusion-render.js';
export {
  createSunShadowSubsystem,
  SUN_SHADOW_FIELD_DIM,
  SUN_SHADOW_MARCH_STEPS,
} from './lighting/sun-shadow-subsystem.js';
// THE POINT-LIGHT POOL — extraction step 3 of docs/planning/
// VT-Pan-Viewer-Extraction.md. The mesh pool, its two dedicated scenes, the
// candle wall-clip cache, and the per-frame reconcile.
export { createPointLightPool } from './lighting/point-light-pool.js';
export {
  buildEnvironmentalLightMaterials,
  computeAmbientBackground,
  computeAmbientColors,
  computeGlobalLightFloor,
  maxRgb,
  FOUNDRY_LIGHT_WEIGHTS,
  mixRgb,
  buildWorldSpaceOutdoorsGate,
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
  buildAnimationTimeNode,
  buildFlickerNode,
  buildFlickerRatioNode,
  buildPulseNode,
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
  hspherize,
  mirrorTriangle,
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
export { WATER, WATER_PARAMS } from './water/water.js';
export { resolveWaterFloor } from './water/water-floor.js';
// THE BODY PACK (docs/planning/Water.md §5.1) — one jump-flood signed distance
// field, baked on mask change. The subsystem owns the targets and the version
// poll; `water-body.js` is its TSL half plus the arithmetic the Node suite
// pins (the flood is exact, and only a brute-force comparison can say so).
export { createWaterBodySubsystem } from './water/water-body-subsystem.js';
// TIER 0 — the surface itself: the mask, tinted, in the right place, with a
// soft SDF-derived shoreline. Read its header for why "the punch" needs no
// buf:scene.attr read (the painter's-algorithm draw order IS the punch).
export {
  buildWaterSurfaceMaterial,
  WATER_TIER0_TINT,
  WATER_TIER0_OPACITY,
  WATER_TIER0_SHORE_SOFTNESS_PX,
} from './water/water-render.js';
// DOOR GRAPHICS as a self-owned subsystem (extracted 2026-07-26). Also the
// template tier-0 water follows: an opaque, LIT map element drawn into
// buf:scene.color BEFORE lighting, in its own scene.
export { createDoorGraphicsSubsystem } from './door-graphics-subsystem.js';
export {
  buildWaterSeedMaterial,
  buildWaterJfaStepMaterial,
  buildWaterBodyResolveMaterial,
  jfaStepCount,
  jfaStrideForStep,
  rebaseNeighborOffset,
  flowFromTangent,
  WATER_PRESENCE_EPS,
  WATER_MASK_FILTER,
} from './water/water-body.js';
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
export { DOOR_GRAPHICS, DOOR_GRAPHICS_PARAMS } from './door-graphics.js';
export { VEGETATION, VEGETATION_PARAMS, VEGETATION_KINDS } from './vegetation.js';
// The vegetation RUNTIME's pure half (vegetation-render.js's own header
// explains the split): Case-1 self-vegetation-tile detection + the
// vertex-displacement curve. THREE/TSL glue lives in vt/vt-pan-viewer.js.
export {
  detectSelfVegetationKind,
  heightWeight01,
  validateVegetationKinds,
  vegetationMeshSegments,
  buildTessellatedQuadGeometry,
} from './vegetation-render.js';
// The vegetation SHADOW subsystem — extraction step 2 of docs/planning/
// VT-Pan-Viewer-Extraction.md. The padded quad, the per-kind pad, and the
// per-frame sky sync, with their dependencies named instead of reached for.
// `padPlacement`/`vegetationShadowPadPx`/the two constants are exported
// standalone because call sites that legitimately STAY in the viewer (the
// Case-2 overlay build, `setTileGeometry`, `buildVegetationMaterial`,
// `refreshWholeImageItem`) still need them — one home, several readers.
export {
  createVegetationShadowSubsystem,
  padPlacement,
  vegetationShadowPadPx,
  VEG_SHADOW_RENDER_ORDER_MAGNITUDE,
  VEG_SHADOW_SMEAR_TAPS,
} from './vegetation-shadow-subsystem.js';
// THE SHADOW HANDLE (effects/shadow-access.js's header is the map) — the sky
// described ONCE; a caster declares only a height and an offset scale. The
// atmospheric half (cloud softening, night fading) is derived there and shared
// by every caster, which is what replaces V2's per-aspect slider explosion.
export {
  createShadowHandle,
  shadowAtmosphere,
  maxThrowForHeightPx,
  MAX_THROW_HEIGHT_RATIO,
  BASE_SOFTNESS_PX,
  CLOUD_SOFTEN,
  NIGHT_SOFTEN,
} from './shadow-access.js';

// THE SKY HANDLE (effects/sky-access.js's header is the map; docs/planning/Sky.md
// is the design) — the OUTDOOR LIGHT described once. Atmosphere comes from the
// light, never from a colour-correction pass: V2 needed a whole second system
// to cancel its own grade inside torch pools, and that compensator was the cost
// of grading after lighting. Ships neutral (`realism01 = 0` is a mathematical
// no-op) so Foundry parity is intact until the author dials it in.
export { createSkyHandle, luminance, saturation } from './sky-access.js';

// THE GRADE ENGINE (effects/grade/, docs/planning/Grade.md) — ONE grade
// primitive at TWO scopes. The desaturation a light CANNOT do
// (luminance-preserving), the ToD/weather look, and the authored artistic look.
// The `post.grade` seam, folded into present. Absorbs V2's 112 grade uniforms
// across three parallel families.
export {
  applyGrade,
  resolveEnvGrade,
  scaleGradeToIdentity,
  gradePreset,
  GRADE_PRESETS,
  IDENTITY_GRADE,
  buildGradeNode,
  TONE_MAP_FNS,
  TONE_MAP_NAMES,
} from './grade/grade-ops.js';
export { buildGradePresentMaterial } from './grade/grade-present.js';
export { parseCubeLut, identityCubeLut } from './grade/lut-cube.js';
// THE GOD CC — the fully-featured artistic "Look" grade as a first-class
// effect (schema + manifest), plumbed through the same cascade + generated
// FOH/ROH card as bloom. docs/planning/Grade.md §14.
export { GRADE, GRADE_LOOK_PARAMS, BUNDLED_LUT_NAMES } from './grade/grade.js';
// BLOOM (docs/planning/Bloom.md) — the first `post` stage effect. The declaration
// (schema + manifest + presets) and the TSL pyramid builders, imported through
// this door exactly as grade/candle are.
export { BLOOM, BLOOM_PARAMS, BLOOM_PRESETS, bloomPreset } from './bloom.js';
// SUN SHADOWS (docs/planning/Sun-Shadows.md) — the effect DECLARATION; its
// runtime is lighting/sun-occlusion*.js plus lighting/sun-shadow-subsystem.js
// (the bake + the decision-to-rebake; the viewer only supplies the two
// GPU-touching callbacks — see that module's own §3).
export { SUN_SHADOWS, SUN_SHADOW_PARAMS } from './sun-shadows.js';
export { buildBloomMaterials } from './bloom-render.js';
// The candle RUNTIME (candle-flame-render.js's header explains why a candle is
// a billboard + a light, not a particle): pure geometry/colour/light-source math
// (candle-flame-geometry.js, split out 2026-07-25) + the TSL flame material
// (candle-flame-render.js). The viewer imports these through this door exactly
// as it imports the lighting builders.
export {
  buildCandleLightSources,
  computeCandleFlameArrays,
  candleCirclePolygon,
  candleAnimationQualityTier,
  candleClusterLightParams,
  deriveCandleSeed,
  hexToRgb01,
  resolveAnchorColorHex,
  resolveAnchorSizePx,
  resolveAnchorLightRadiusPx,
} from './candle-flame-geometry.js';
export { buildCandleFlameMaterial, buildCandleFlameGeometry } from './candle-flame-render.js';
// The door-graphics RUNTIME (door-graphics-render.js's header explains why a
// door needs no Y-flip here): pure DoorMesh-parity math (closed placement,
// per-type open animation, the computeQuadCorners bridge) + the textured-quad
// material. The viewer imports these through this door exactly as it imports
// the candle builders.
export {
  DOOR_STYLES,
  DOOR_ANIMATION_TYPES,
  doorLeafStyles,
  isMidpointAnimation,
  easeInOutCosine as doorEaseInOutCosine,
  computeDoorClosedSnapshot,
  applyDoorAnimation,
  doorSnapshotToPlacement,
  buildDoorMaterial,
} from './door-graphics-render.js';
export {
  describeEffectSettings,
  deriveEffectLayers,
  effectEnableKey,
  choiceLabels,
  GLOBAL_SETTING_KEYS,
} from './effect-settings.js';
