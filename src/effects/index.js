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
export { createFireParticleEngine } from './particles/particle-engine.js';
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
// SUN GEOMETRY (docs/planning/Sun-Shadows.md) — the shared azimuth/rebake/
// gate-sharpening/edge-fade utilities. Narrowed 2026-08-02: this file used to
// also export the march and the averaged-mean smear (both retired — see
// `sun-occlusion.js`'s own header); what remains is genuinely shared, not
// shadow-model-specific.
export {
  marchDirectionToSun,
  sunNeedsRebake,
  edgeRamp01,
  PENUMBRA_PER_PX,
  GATE_SHARPEN_LOW,
  GATE_SHARPEN_HIGH,
} from './lighting/sun-occlusion.js';
// THE LAYER SMEAR MODEL (docs/planning/Sun-Shadows-Layer-Smear.md) — the
// current sun-shadow bake. `layerSmearTierPlan` is exported because
// `boot.js` needs `.layerGridDim` to size the caster-specific derivation grid
// (the ONE call site that does; see that call site's own comment for why it
// matters). The rest of this model's surface (`resolveLayerSmear`,
// `buildLayerSmearBakeMaterial`, `layerSmearBakeSamples`, …) is consumed
// directly by `sun-shadow-subsystem.js`, not through this barrel — not
// re-exported here for the same "unconsumed API rots silently" reason the
// retired ladder's own comment (just above, in spirit) used to state.
export { layerSmearTierPlan } from './lighting/layer-smear.js';
export { buildSunVisibilityNode } from './lighting/sun-occlusion-render.js';
export { createSunShadowSubsystem, SUN_SHADOW_QUANTIZE_DEG } from './lighting/sun-shadow-subsystem.js';
// THE DEBUG VIEW's own vocabulary — boot reads it to drive the derivation
// includes from the picked view, so "sky-reach only" isolates for real.
export { SUN_SHADOW_DEBUG_VIEWS, sunShadowDebugPaints, sunShadowDebugView } from './lighting/sun-shadow-debug.js';
// THE POINT-LIGHT POOL — extraction step 3 of docs/planning/
// VT-Pan-Viewer-Extraction.md. The mesh pool, its four dedicated scenes, the
// candle wall-clip cache, and the per-frame reconcile.
export { createPointLightPool, resolveAnchorElevationRank } from './lighting/point-light-pool.js';
export {
  buildEnvironmentalLightMaterials,
  blendSunVisibilityAcrossFloors,
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
  LIGHT_ELEVATION_UNCONFIGURED_SENTINEL,
  ELEVATION_RANK_FRACTION_DIVISOR,
} from './lighting/point-light-illumination.js';
export { buildPointLightColorationMaterial, computeColorationAlpha } from './lighting/point-light-coloration.js';
// S2.15 (Performance-Audit-2026-08.md §3.1's MRT-merge plan) — the dedicated-
// target/blit infrastructure the viewer's own render sequence wires up.
// `buildMergedPointLightShadingCore` itself is NOT re-exported here —
// `point-light-batch-mesh.js` is its only caller, a sibling file inside
// `effects/lighting/` that imports it directly; a barrel path nothing outside
// the zone uses would just be an unconsumed export (`feedback_unconsumed_
// api_rots_silently`).
export {
  describePointLightMergedMrt,
  buildPointLightMergedRendererMrtStructs,
  buildPointLightMergedZeroQuadMaterial,
  buildPointLightMergedBlitMaterial,
} from './lighting/point-light-merged.js';
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
  computeMinimumDarknessFloor,
  regionOverlapsElevationBand,
  DARKNESS_ADJUST_MODES,
} from './lighting/region-geometry.js';
// THE VISION MASK's rules — slice 2 of "MSA owns vision/fog" (Pillar 11,
// docs/planning/Vision-Fog-Ownership.md). Pure; the rasteriser that consumes
// `decideRevealed` as its CPU twin is slice 2's remaining half.
export {
  decideRevealed,
  reconcileVisionMeshPool,
  decideFogGating,
  REVEAL_ILLUMINATION_THRESHOLD,
  EXPLORED_DIM_FACTOR,
  VISION_GATE_BUILD_TAG,
} from './vision/vision-mask.js';
export {
  createVisionMaskSubsystem,
  buildVisionLosMaterial,
  buildVisionLightMaterial,
  buildVisionGateMaterial,
  buildVisionExploredDimMaterial,
  buildVisionSnapshotPublishMaterial,
} from './vision/vision-mask-render.js';
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
export { WATER, WATER_PARAMS, WATER_DEBUG_CHANNELS, WATER_PRESETS, waterPreset } from './water/water.js';
export { resolveWaterFloor } from './water/water-floor.js';
// THE BODY PACK (docs/planning/Water.md §5.1) — one jump-flood signed distance
// field, baked on mask change. The subsystem owns the targets and the version
// poll; `water-body.js` is its TSL half plus the arithmetic the Node suite
// pins (the flood is exact, and only a brute-force comparison can say so).
export { createWaterBodySubsystem } from './water/water-body-subsystem.js';
// TIER 0 — the surface itself: the mask, tinted, in the right place. Its
// shoreline comes from the HIGH-RES mask file, NOT the SDF (that mistake cost
// four rounds; water-render.js's header has the account). Also read it for why
// "the punch" needs no buf:scene.attr read — the draw order IS the punch.
export {
  buildWaterSurfaceMaterial,
  WATER_TIER0_TINT,
  WATER_TIER0_OPACITY,
  WATER_PRESENCE_EDGE0,
  WATER_PRESENCE_EDGE1,
  WATER_DEFAULT_TIER,
} from './water/water-render.js';
export { createWaterSurfaceSubsystem } from './water/water-surface-subsystem.js';
// THE FLOW PACK (docs/planning/Water-Simulation-Turn.md §3 Layer B / §4 S2) —
// area-averaged solidity over the SAME full-resolution mask the surface pack
// loads, baked once that texture exists. `water-flow.js` is its TSL half.
export { createWaterFlowSubsystem } from './water/water-flow-subsystem.js';
export { createWaterSeams } from './water/water-seams.js';
export { createWaterRegistration } from './water/water-registration.js';
// SHINE (docs/planning/Specular.md) — `surface.response`. An ANIMATED FIELD of
// shimmers, gradients and patterns painted across the metal the specular mask
// marks: sliding with the camera, evolving slowly, gated by the scene lighting
// and by indoors/outdoors. The mask reads as STRENGTH + TINT (darker paint is
// less shiny; its hue says which metal).
//
// ⚠️ THE PBR MODEL THAT USED TO BE HERE IS GONE (2026-07-27) — GGX, Smith,
// Schlick, a split-sum environment BRDF and a synthesised eye height, all of it
// manufacturing angular variation that an orthographic camera over a flat map
// does not have. It shipped invisible four times. `specular-pattern.js`'s
// header carries the full account; `specular.js`'s carries the doctrine that
// went with it, including the rule it had to retract.
export {
  decodeSpecularMask,
  describeSpecularMapping,
  keyLightDirection,
  SPECULAR_PRESENCE_EDGE0,
  SPECULAR_PRESENCE_EDGE1,
  SPECULAR_ALPHA_EPSILON,
} from './specular/specular-material.js';
export {
  anisotropicBlob,
  shimmerLayer,
  sunGrainBias,
  cellScaleForStrength,
  parallaxOffset,
} from './specular/specular-pattern.js';
export {
  buildSpecularIslandPack,
  presenceGridFromRgba,
  islandParallax,
  SPECULAR_ISLAND_MAX_DIM,
} from './specular/specular-islands.js';
export {
  SPECULAR,
  SPECULAR_PARAMS,
  SPECULAR_LAYER_PARAMS,
  SPECULAR_DEBUG_CHANNELS,
  SPECULAR_DEBUG_BOOST,
} from './specular/specular.js';
export {
  buildSpecularSurfaceMaterial,
  SPECULAR_MASK_IMAGE_SCALE,
  SPECULAR_LAYER_DEFAULTS,
  SPECULAR_LAYER_COUNT,
} from './specular/specular-render.js';
export { createSpecularSurfaceSubsystem } from './specular/specular-surface-subsystem.js';
export { createSpecularSeams } from './specular/specular-seams.js';
export { createSpecularRegistration } from './specular/specular-registration.js';
// FLUID — goo in thin glass tubes (docs/planning/Fluid.md). Phase 1 only: the
// declaration and the CPU tube-net extractor. NOTHING RENDERS YET — there is no
// pack bake, no sim, no material and no registration, so `FLUID` is exported
// for the Node suite and for the registry to find later, not because a viewer
// consumes it today. `fluid.js`'s header says the same thing at more length,
// because a manifest cannot tell "declared" from "built" on its own.
//
// `extractTubeNet` is the whole of the CPU side: connected components, the
// GEODESIC arc length (derived from the tube's shape — never differenced out of
// the painted ramp, which is the V2 mistake `feedback_sdf_does_not_draw_the_
// edge` names), the area/radius profiles, and the hint-vs-geodesic correlation
// that decides which end the goo flows from without trusting antialiased edge
// texels.
// Phase 2 added the PACK (the tube net as one uploadable RGBA buffer) and the
// BAKE (the version poll). There is still no GPU pass: three of the pack's four
// channels are CPU-only quantities, so a jump flood would recompute the fourth
// into a separate target for no visible difference (Fluid.md correction #3).
// The whole bake is therefore a pure function plus one upload — and Node-tested
// end to end, including the exit criterion that bakes do not track frames.
export { FLUID, FLUID_PARAMS } from './fluid/fluid.js';
export {
  buildFluidPack,
  packToHalfFloat,
  toHalfFloat,
  fromHalfFloat,
  FLUID_PACK_MAX_DIM,
  FLUID_PACK_CHANNELS,
} from './fluid/fluid-pack.js';
export { buildFluidSurfaceMaterials, FLUID_ABSORPTION_STRENGTH } from './fluid/fluid-render.js';
export { createFluidSurfaceSubsystem } from './fluid/fluid-surface-subsystem.js';
export { createFluidRegistration, createFluidSeams } from './fluid/fluid-registration.js';
export {
  extractTubeNet,
  geodesicFrom,
  labelComponents,
  chamferRadius,
  interiorness,
  weightedCorrelation,
  fillEmptyBins,
  FLUID_PRESENCE_MIN_BYTE,
  FLUID_MIN_TUBE_TEXELS,
  FLUID_PROFILE_SAMPLES,
  FLUID_MAX_TUBES,
  FLUID_HINT_MIN_CORRELATION,
} from './fluid/fluid-net.js';
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
  WATER_BODY_SUPERSAMPLE,
} from './water/water-body.js';
// `buildSurfaceResponsePass` is GONE (2026-07-26) — surface.response is live
// (tiers 0-2, docs/planning/Specular.md) and its NotBuilt door was deleted with
// the seam it stood for. The real exports are the specular/ block above.
// WINDOW LIGHT (docs/planning/Windows.md) — `light.accumulate`. Tier 0 only:
// author-confirmed 2026-07-27, `_Window` is a hand-painted INTERIOR light
// cookie (value = level, hue+saturation = tint) — not an aperture to project
// through. ADDS onto buf:scene.illum, never onto composed scene colour. Cloud
// shadows are a WIRED SEAM (window-render.js#cloudFactorNode, defaults to a
// constant 1) — world/cloud-field.js does not exist yet; see window.js's own
// header and its `deferredRungs` entry for what plugs in there.
export {
  decodeWindowMask,
  cookieRgb,
  WINDOW_PRESENCE_EDGE0,
  WINDOW_PRESENCE_EDGE1,
  WINDOW_ALPHA_EPSILON,
} from './window/window-cookie.js';
export { WINDOW, WINDOW_PARAMS, WINDOW_DEBUG_CHANNELS, WINDOW_DEBUG_BOOST } from './window/window.js';
export {
  buildWindowSurfaceMaterial,
  WINDOW_MASK_IMAGE_SCALE,
  WINDOW_DEFAULT_STRENGTH,
  WINDOW_DEFAULT_CONTRAST,
} from './window/window-render.js';
export { createWindowSurfaceSubsystem } from './window/window-surface-subsystem.js';
export { createWindowSeams } from './window/window-seams.js';
export { createWindowRegistration } from './window/window-registration.js';

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
  resolveEffectTier,
  PERFORMANCE_PROFILES,
  DEFAULT_PERFORMANCE_PROFILE,
  ENABLE_OVERRIDES,
} from './effect-cascade.js';
export { UI_WINDOW_SHADOW, UI_SHADOW_PARAMS } from './ui-window-shadow.js';
export { CANDLE_FLAME, CANDLE_FLAME_PARAMS } from './candle-flame.js';
export { shouldAutoIgnite, stableUnit01 } from './candle-ignite.js';
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
  vegetationTierPlan,
  VEGETATION_DEFAULT_TIER,
  vegetationCanopyElevation,
  vegetationHeightFt,
  vegetationOverlayRenderOrder,
  buildVegetationDepthItems,
  flutterFoldFreeAmplitudePx,
  VEG_FLUTTER_FOLD_SAFETY,
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
// DEPTH OF FIELD (docs/planning/Depth-of-Field.md) — the SECOND `post` stage
// effect, and the first post-stage consumer of buf:scene.depth. Same
// declaration + TSL-builder split as bloom, imported through this door
// exactly the same way.
export { DEPTH_OF_FIELD, DOF_PARAMS, DOF_PRESETS, dofPreset } from './depth-of-field.js';
// SUN SHADOWS (docs/planning/Sun-Shadows.md) — the effect DECLARATION; its
// runtime is lighting/sun-occlusion*.js plus lighting/sun-shadow-subsystem.js
// (the bake + the decision-to-rebake; the viewer only supplies the two
// GPU-touching callbacks — see that module's own §3).
export { SUN_SHADOWS, SUN_SHADOW_PARAMS } from './sun-shadows.js';
// APERTURE GOBO (docs/planning/Aperture-Gobo.md) — the effect DECLARATION;
// its runtime is lighting/aperture-gobo.js (the pure CPU projection math)
// plus lighting/aperture-gobo-render.js (the TSL transcription), consumed
// directly by lighting/point-light-pool.js — there is no separate subsystem
// module the way sun-shadows has one, because this effect owns no bake, no
// render target, and no rebake decision of its own.
export { APERTURE_GOBO, APERTURE_GOBO_PARAMS, APERTURE_GOBO_DEBUG_CHANNELS } from './aperture-gobo.js';
export { createApertureGoboRegistration } from './aperture-gobo-registration.js';
export { buildBloomMaterials } from './bloom-render.js';
export { buildDofMaterials } from './depth-of-field-render.js';
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
  candleTierPlan,
  CANDLE_DEFAULT_TIER,
  candleClusterLightParams,
  deriveCandleSeed,
  hexToRgb01,
  resolveAnchorColorHex,
  resolveAnchorSizePx,
  resolveAnchorLightRadiusPx,
  resolveAnchorElevationWorldUnits,
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

// LIGHTNING (docs/planning/Lightning.md) — the forked-bolt strike effect
// (V2's `LightningEffectV2`; the weather/landscape flash sibling is out of
// scope). Declaration + pure geometry/math + TSL render, the SAME three-way
// split candle/door already use.
export { LIGHTNING, LIGHTNING_PARAMS } from './lightning.js';
export {
  hashStringToSeed,
  mixSeed,
  createRng,
  randFloat,
  randFloatRange,
  randInt,
  generateBoltPath,
  nextBurstDelayMs,
  generateBurst,
  computeStrandEnvelope,
  groupLightningAnchorsIntoSources,
  defaultLightningElevation,
  buildLightningLightSources,
  computeLightningStrandArrays,
  hexToRgb01 as lightningHexToRgb01,
} from './lightning-geometry.js';
export { buildLightningGeometry, refillLightningGeometry, buildLightningMaterial } from './lightning-render.js';
export { createLightningSubsystem } from './lightning-subsystem.js';

// FIRE (docs/planning/Fire.md) — the vertical slab integral. Because the camera
// is orthographic and looks exactly down −Z, every view ray is parallel to
// world up, so "marching the fire volume" is a 1-D column integral at a fixed
// (x,y) with every fragment integrating the SAME heights in lockstep — no ray
// setup, no 3D texture, zero bytes of memory read. Same four-way split as
// candle and lightning: declaration, pure math, TSL render, lifecycle.
export { FIRE, FIRE_PARAMS } from './fire/fire.js';
export {
  fireScaleChain,
  firePuffPhase,
  firePuffEnvelope,
  fireSlabPlan,
  fireSliceTable,
  fireTierPlan,
  fireShearSeconds,
  fireCoveragePx,
  fireQuadSizePx,
  fireWeatherResponse,
  applyWeatherResponseGain,
  fireRuntimeFromParams,
  resolveFireCoverageRung,
  clusterFireSources,
  buildFireLightSources,
  computeFireQuadArrays,
  fireGeometrySignature,
  deriveFireSeed,
  FIRE_DEFAULT_TIER,
  FIRE_RAMP_WOOD,
  FIRE_SMOKE_RAMP,
  FIRE_FUELS,
} from './fire/fire-geometry.js';
export { buildFireMaterial, buildFireGeometry, fireSizeClass, fireSizeClassDiameter } from './fire/fire-render.js';
export { extractFiresFromMask, extractFiresWithLabels, fireMaskSignature, chamferDistance } from './fire/fire-mask.js';
export { createFireSubsystem } from './fire/fire-subsystem.js';
// PRECIPITATION (P1, docs/planning/Precipitation.md) — the FALL. ⚠️ BUILT and
// shader-lab-verified, but NOT drawing into the live frame yet: LAW 3 (rain
// indoors must be unrepresentable) needs the sky-reach gate first, and
// `graph/passes.js` declares that seam. Exported now rather than later because
// this zone's door is how boot.js reaches it at all, and a module that lands
// without its door is the `graph/reachable-from-boot` debt this repo ratchets.
export { createPrecipitationSubsystem, resolveActivePopulations } from './precipitation/precip-subsystem.js';

// ⭐ P5's ROOFLINE (Precipitation.md §4.3) — pure grid→world-points, so the
// Y-flip that killed V2's drips is a Node assertion rather than a runtime vote.
export {
  extractDripEdges,
  dripEdgeSignature,
  MAX_DRIP_POINTS,
  DEFAULT_DECK_HEIGHT_PX,
} from './precipitation/drip-edges.js';
export {
  PRECIP_SPECIES,
  PRECIP_SPECIES_IDS,
  PRECIP_SPECIES_PLANNED,
  resolveSpecies,
  isBuiltSpecies,
  resolveSpeciesFrame,
  evalCurve,
} from './precipitation/precip-species.js';
// THE SPRITE — V2's four bird's-eye flame archetypes plus the colour spec they
// are drawn with (docs/planning/Fire.md). Exported through the zone door rather
// than imported directly by the runtime that will consume it, per `zones/
// one-door`; the Shader Lab reaches it the same way every other effect module
// is reached.
export {
  FLAME_ARCHETYPES,
  FLAME_GRADIENT_COLD,
  FLAME_GRADIENT_STANDARD,
  FLAME_GRADIENT_HOT,
  FLAME_EMISSION_STOPS,
  FLAME_ALPHA_STOPS,
  EMBER_COLOR_STOPS,
  EMBER_EMISSION_STOPS,
  SMOKE_COLOR_STOPS,
  FIRE_HDR_LINEAR_GAIN,
  FLAME_CORE_EMISSION,
  EMBER_EMISSION,
  FLAME_PEAK_OPACITY,
  EMBER_PEAK_OPACITY,
  flameGradientStops,
  piecewiseLinear,
  piecewiseLinearRgb,
  buildFlameShapeAlpha,
  buildFlameShading,
  buildLifeFade,
} from './fire/fire-sprite.js';
// THE SPAWN CLOUD — the painted region as a flat point buffer the particle
// kernel indexes. `SPAWN_KINDS.extracted`'s first real implementation.
export {
  extractFireSpawnPoints,
  fireSpawnSignature,
  packSpawnPoints,
  SPAWN_POINT_STRIDE,
} from './fire/fire-spawn-points.js';
