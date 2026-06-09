/**
 * @fileoverview V2 Fire Sparks Effect — per-floor particle systems from _Fire masks.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's lifecycle, floor-state activation, particle
 * registration, or dependency bindings, you MUST update HealthEvaluator
 * contracts/wiring for `FireEffectV2` to prevent silent failures.
 *
 * Architecture:
 *   One three.quarks BatchedRenderer per floor that has fire, each registered on
 *   the FloorRenderBus with that floor's index (overlay keys use ms_fire_batch_* —
 *   keys starting with "__" are treated like backgrounds in renderFloorRangeTo and
 *   never get floor-range culling). Per-level rendering keeps each fire batch in its
 *   authored floor slice so upper-floor backgrounds/tiles can occlude lower-floor fire.
 *   `_updateBatchRenderOrder` keeps each BatchedRenderer (and quarks systems) pinned to
 *   its authored mask floor's FLOOR_EFFECTS band so upper-floor tile/overhead layers can
 *   still occlude lower-floor flames correctly.
 *   For each tile with a `_Fire` mask, scans the mask on the CPU to build spawn
 *   point lists, then creates fire + ember + smoke particle systems. A procedural
 *   coal-bed shader overlay per tile/background draws on albedo under the particles.
 *   Floor isolation for simulation uses swapping active systems in/out per batch on floor change.
 *
 * V1 → V2 cleanup:
 *   - No EffectMaskRegistry / GpuSceneMaskCompositor (masks loaded per tile)
 *   - No MapPointsManager integration (mask-only fire sources)
 *   - No V1 EffectBase / RenderLayers dependency
 *   - Clean floor isolation via system swapping (no floor-presence gate)
 *   - Behaviors extracted into fire-behaviors.js for reuse
 *
 * @module compositor-v2/effects/FireEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import { probeMaskFile } from '../../assets/loader.js';
import { createMaskStatusSchemaGroup, refreshEffectMaskStatusUi } from '../../ui/effect-mask-status.js';
import Coordinates from '../../utils/coordinates.js';
import { getPerspectiveElevation } from '../../foundry/elevation-context.js';
import { VisionPolygonComputer } from '../../vision/VisionPolygonComputer.js';
import { LightMesh } from '../../scene/LightMesh.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  resolveV14NativeDocFloorIndexMin,
  getViewedLevelBackgroundSrc,
  hasV14NativeLevels,
} from '../../foundry/levels-scene-flags.js';
import {
  FireMaskShape,
  FixedCurlNoiseField,
  FireForcesBehavior,
  FlameLifecycleBehavior,
  EmberLifecycleBehavior,
  SmokeLifecycleBehavior,
  FlameShapeFrameBehavior,
  SmokeShapeFrameBehavior,
  FireSpinBehavior,
  deferVisualBehaviorsOnSystem,
  applyEmberSpriteTextureTransform,
  generateFirePoints,
  filterFirePointsByOutdoor,
  filterFirePointsByAlbedoAlpha,
  filterFirePointsRequireNeighbor,
  syncFireParticleOutdoorFootprint,
  smoothFireParticleShelterMaskOnly,
  applyFireShelterMaskToParticle,
  cacheFireParticleOutdoorFootprintForWind,
} from './fire-behaviors.js';
import {
  buildEffectSceneBoundsFromCanvas,
  sampleAuthoredOutdoorsAtWorld,
  syncSharedOutdoorsMaskForFloor,
} from './water-splash-behaviors.js';
import {
  ParticleSystem as QuarksParticleSystem,
  BatchedRenderer,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ApplyForce,
  ConstantValue,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
} from '../../libs/three.quarks.module.js';

import {
  GROUND_Z,
  RENDER_ORDER_PER_FLOOR,
  effectUnderOverheadOrder,
  outdoorSmokeRenderOrder,
  tileStackedOverlayOrder,
} from '../LayerOrderPolicy.js';
import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';
import { tagQuarkSystem } from '../../core/quark-diagnostics.js';
import {
  COAL_BED_DEFAULT_PARAMS,
  applyCoalBedPreset,
  applyCoalBedBlending,
  createCoalBedMaterial,
  syncCoalBedMaskTexelSize,
  syncCoalBedOverlayPixelSize,
  syncCoalBedUniforms,
} from './fire-coal-bed-shader.js';

const log = createLogger('FireEffectV2');

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Matches glow band split at 0.5 — Indoor/Outdoor Balance folders are exclusive. */
const FIRE_GLOW_BALANCE_OUTDOOR_THRESHOLD = 0.5;

/** Deep orange fire pool hue (linear HDR direction — magnitude lives in emission gain). */
const FIRE_GLOW_COLOR_COOL = { r: 1.0, g: 0.72, b: 0.28 };
const FIRE_GLOW_COLOR_WARM = { r: 1.0, g: 0.32, b: 0.03 };

const FIRE_GLOW_REBUILD_PARAMS = new Set([
  'fireGlowBucketSizePx',
  'fireGlowMaxBuckets',
  'fireGlowRadiusPx',
  'fireGlowInnerRadiusScale',
  'fireGlowNightRadiusPx',
  'fireGlowNightInnerRadiusScale',
  'fireGlowWallClipEnabled',
  'fireGlowWallClipRadiusScale',
]);

const FIRE_GLOW_RADIUS_BALANCE_PARAMS = new Set([
  'fireGlowIndoorRadiusScale',
  'fireGlowOutdoorRadiusScale',
]);

/** Indoor/outdoor balance scales that only touch uniforms (no wall-clip polygon rebuild). */
const FIRE_GLOW_PHOTOMETRY_PARAMS = new Set([
  'fireGlowIndoorIntensityScale',
  'fireGlowOutdoorIntensityScale',
  'fireGlowIndoorCancelScale',
  'fireGlowOutdoorCancelScale',
  'fireGlowIndoorNightBoost',
  'fireGlowOutdoorNightBoost',
]);

/** @param {import('three').WebGLRenderer|null} renderer @param {import('three').Texture|null} texture */
function _isSamplingActiveRenderTarget(renderer, texture) {
  if (!renderer || !texture) return false;
  const active = renderer.getRenderTarget?.();
  return !!(active?.texture && active.texture === texture);
}

// Spatial bucket size for splitting large fire masks into smaller emitters (px).
const BUCKET_SIZE = 2000;

/** Params that require repopulating _Fire mask spawn points + glow clusters. */
const FIRE_MASK_PICKUP_PARAM_KEYS = [
  'fireMaskMinBrightness',
  'fireMaskMinAlpha',
  'fireMaskPremulThreshold',
  'fireAlbedoMinAlpha',
  'fireMaskIsolationPx',
];

/** Hard cap on spatial particle emitters per floor — coarsens buckets when exceeded. */
const FIRE_DEFAULT_MAX_SPATIAL_BUCKETS = 16;
const FIRE_DEFAULT_MAX_SYSTEMS_PER_FLOOR = 36;
const FIRE_DEFAULT_OUTDOOR_SPLIT_MAX_BUCKETS = 10;
const FIRE_DEFAULT_SIM_HZ = 30;
/** Hard ceiling on CPU physics/emission steps. 60+ enables buttery smooth native frame updates. */
const FIRE_MAX_SIM_HZ = 60; // (You can set this to 120 or 144 if you have a high-refresh monitor)
const FIRE_MAX_SPATIAL_BUCKET_SIZE_PX = 16384;

/** Behavior types re-evaluated every render frame for smooth flipbook / colour. */
const FIRE_VISUAL_BEHAVIOR_TYPES = new Set([
  'FlameShapeFrameBehavior',
  'SmokeShapeFrameBehavior',
  'FlameLifecycle',
  'EmberLifecycle',
  'SmokeLifecycle',
  'SizeOverLife',
]);

// Must NOT start with "__" — FloorRenderBus.renderFloorRangeTo treats "__*" keys like
// background planes (visibility = includeBackground only), ignoring floorIndex.
const FIRE_BATCH_OVERLAY_PREFIX = 'ms_fire_batch_';
const FIRE_COAL_BED_OVERLAY_SUFFIX = '_coalBed';
/** Local Z lift on tile-attached coal overlays (on albedo, under particles). */
const COAL_BED_Z_OFFSET = 0.02;
/** tileStackedOverlayOrder delta — paints after albedo, before FLOOR_EFFECTS particles. */
const COAL_BED_STACK_DELTA = 2;

const FIRE_MASK_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];
const REBUILD_PARAM_KEYS = [
  'fireSizeMin', 'fireSizeMax', 'fireLifeMin', 'fireLifeMax',
  'emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax',
  'smokeEnabled', 'smokeSizeMin', 'smokeSizeMax', 'smokeLifeMin', 'smokeLifeMax',
  'smokeSizeGrowth', 'smokeSizeOverLife', 'smokeOutdoorAboveCanopy',
  'timeScale',
  'fireMaxSpatialBuckets', 'fireMaxParticles', 'fireEmberMaxParticles', 'fireSmokeMaxParticles',
  'fireMaxSystemsPerFloor', 'fireOutdoorSplitMaxBuckets',
  ...FIRE_MASK_PICKUP_PARAM_KEYS,
];
const REBUILD_PARAM_SET = new Set(REBUILD_PARAM_KEYS);

// Procedural flame flipbook — 4×8 atlas: rows = fluid shape archetypes, cols = anim frames.
const FIRE_ATLAS_COLS = 8;
const FIRE_ATLAS_ROWS = 4;
const FIRE_ATLAS_SHAPE_COUNT = FIRE_ATLAS_ROWS;
const FIRE_ATLAS_ANIM_FRAMES = FIRE_ATLAS_COLS;
const FIRE_ATLAS_FRAMES = FIRE_ATLAS_COLS * FIRE_ATLAS_ROWS;
const FIRE_ATLAS_CELL_SIZE = 64;

// Procedural smoke atlas — 4×1: one static silhouette per shape row (no flipbook morph).
const SMOKE_ATLAS_COLS = 1;
const SMOKE_ATLAS_ROWS = 4;
const SMOKE_ATLAS_SHAPE_COUNT = SMOKE_ATLAS_ROWS;
const SMOKE_ATLAS_ANIM_FRAMES = SMOKE_ATLAS_COLS;
const SMOKE_ATLAS_CELL_SIZE = 64;

/**
 * Generates noise-driven flame and smoke atlases on offscreen canvases.
 * Flame frames are bird's-eye fire pools (Map Shine is top-down), not side-view teardrops.
 */
class ProceduralTextureBuilder {
  static _hash12(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = (h * 1274126177) | 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  static _valueNoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = this._hash12(ix, iy) / 4294967295;
    const b = this._hash12(ix + 1, iy) / 4294967295;
    const c = this._hash12(ix, iy + 1) / 4294967295;
    const d = this._hash12(ix + 1, iy + 1) / 4294967295;
    const ab = a + (b - a) * ux;
    const cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
  }

  static _fbm(x, y, octaves = 4) {
    let sum = 0;
    let amp = 0.55;
    let freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += (this._valueNoise(x * freq, y * freq) - 0.5) * 2 * amp;
      freq *= 2;
      amp *= 0.55;
    }
    return sum;
  }

  static _smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-5, edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  static _fireAtlasEdgeFadeCell(nx, ny, pad = 0.06) {
    return Math.min(1, nx / pad, ny / pad, (1 - nx) / pad, (1 - ny) / pad);
  }

  /** @private Circular noise drift for one animation column within a shape row. */
  static _fireAtlasAnimDrift(animCol, animCols) {
    const t = (animCol / animCols) * Math.PI * 2;
    return {
      t,
      tX: Math.cos(t) * 1.1,
      tY: Math.sin(t) * 1.1,
      tX2: Math.cos(t * 2.0 + 0.8) * 0.72,
      tY2: Math.sin(t * 2.0 + 0.8) * 0.72,
    };
  }

  /** @private Gentler drift for smoke flipbook — adjacent frames stay similar. */
  static _smokeAtlasAnimDrift(animCol, animCols) {
    const t = (animCol / animCols) * Math.PI * 2;
    const amp = 0.28;
    const amp2 = 0.18;
    return {
      t,
      tX: Math.cos(t) * amp,
      tY: Math.sin(t) * amp,
      tX2: Math.cos(t * 2.0 + 0.8) * amp2,
      tY2: Math.sin(t * 2.0 + 0.8) * amp2,
    };
  }

  /** @private Shape 0 — Fluid Rolling Core: Dense, boiling hot center with warped edges. */
  static _fireShapeRollingCore(nx, ny, animCol, animCols, baseSeed) {
    const { tX, tY } = this._fireAtlasAnimDrift(animCol, animCols);

    // Domain Warping: distort space before calculating distance to center
    const warpX = this._fbm(nx * 3.5 + tX + baseSeed, ny * 3.5 + tY, 2) * 0.25;
    const warpY = this._fbm(nx * 3.5 - tY, ny * 3.5 + tX + baseSeed, 2) * 0.25;

    const dx = (nx - 0.5 + warpX) * 2.0;
    const dy = (ny - 0.5 + warpY) * 2.0;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Exponential hot plasma core
    const core = Math.exp(-dist * dist * 6.0);

    // Crisp but turbulent outer edge
    const detailN = this._fbm(nx * 7.0 - tX, ny * 7.0 - tY, 3);
    const edge = 1.0 - this._smoothstep(0.4, 0.8, dist - detailN * 0.15);

    let alpha = core * 0.7 + edge * 0.5;
    // Hard fade at canvas boundaries
    alpha *= 1.0 - this._smoothstep(0.85, 1.0, dist);
    return Math.pow(Math.max(0, Math.min(1, alpha)), 1.2);
  }

  /** @private Shape 1 — Licking Tendrils: Organic, asymmetric tongues of flame reaching outward. */
  static _fireShapeLickingTendrils(nx, ny, animCol, animCols, baseSeed) {
    const { tX2, tY2 } = this._fireAtlasAnimDrift(animCol, animCols);

    const dx = (nx - 0.5) * 2.0;
    const dy = (ny - 0.5) * 2.0;
    const baseDist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    // Polar noise pulls the perimeter outward into spiky licks
    const polarN = this._fbm(Math.cos(angle) * 2.2 + tX2 + baseSeed, Math.sin(angle) * 2.2 + tY2, 3);
    const dist = baseDist - polarN * 0.35;

    const core = Math.exp(-dist * dist * 8.0);
    const edge = 1.0 - this._smoothstep(0.3, 0.7, dist);

    let alpha = core * 0.6 + edge * 0.6;
    alpha *= 1.0 - this._smoothstep(0.9, 1.0, baseDist);
    return Math.pow(Math.max(0, Math.min(1, alpha)), 1.4);
  }

  /** @private Shape 2 — Splitting Flame: Heavy turbulence that bifurcates the core blob. */
  static _fireShapeSplitting(nx, ny, animCol, animCols, baseSeed) {
    const { tX, tY } = this._fireAtlasAnimDrift(animCol, animCols);

    // Low frequency, high amplitude warp to pull the blob apart
    const splitN = this._fbm(nx * 2.0 - tX + baseSeed, ny * 2.0 - tY, 2);
    const dx = (nx - 0.5 + splitN * 0.3) * 2.0;
    const dy = (ny - 0.5 - splitN * 0.3) * 2.0;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const core = Math.exp(-dist * dist * 5.0);

    // Add medium detail to the torn edges
    const detailN = this._fbm(nx * 5.0 + tX, ny * 5.0 + tY, 2);
    const mask = 1.0 - this._smoothstep(0.4, 0.8, dist + detailN * 0.2);

    let alpha = core * 0.5 + mask * 0.6;
    alpha *= 1.0 - this._smoothstep(0.8, 1.0, Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2) * 2.0);
    return Math.pow(Math.max(0, Math.min(1, alpha)), 1.3);
  }

  /** @private Shape 3 — Archipelago Pool: Coherent fire body with HF noise edge lobes, not speckled wisps. */
  static _fireShapeArchipelagoPool(nx, ny, animCol, animCols, baseSeed) {
    const { tX, tY, tX2, tY2 } = this._fireAtlasAnimDrift(animCol, animCols);

    const warpX = this._fbm(nx * 2.8 + tX + baseSeed + 63.1, ny * 2.8 + tY, 2) * 0.2;
    const warpY = this._fbm(nx * 2.8 - tY + 11.4, ny * 2.8 + tX + baseSeed, 2) * 0.2;
    const dx = (nx - 0.5 + warpX) * 2.0;
    const dy = (ny - 0.5 + warpY) * 2.0;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const core = Math.exp(-dist * dist * 5.5);

    // Medium-frequency lobes — a handful of flame islands, not a furry speckle field.
    const lobeN = this._fbm(nx * 5.5 + tX2 + baseSeed, ny * 5.5 + tY2, 3);
    const lobeMask = this._smoothstep(0.05, 0.45, lobeN);

    // High-frequency ripples on the outer rim for boiling detail.
    const detailN = this._fbm(nx * 10.0 + tX, ny * 10.0 + tY, 2);
    const edgeRipple = 1.0 - this._smoothstep(0.38, 0.75, dist - detailN * 0.1);

    // Archipelago ring: narrow HF channels carve gaps between connected flame lobes.
    const poolEdge = 1.0 - this._smoothstep(0.25, 0.85, dist);
    const channelN = this._fbm(nx * 9.0 + tX * 1.1 + baseSeed + 88.0, ny * 9.0 + tY * 1.1, 3);
    const channels = this._smoothstep(0.35, 0.65, channelN);
    const midRing = this._smoothstep(0.2, 0.45, dist) * (1.0 - this._smoothstep(0.55, 0.8, dist));
    const archipelago = poolEdge * (1.0 - midRing + midRing * channels) * lobeMask;

    let alpha = core * 0.7 + edgeRipple * 0.35 + archipelago * 0.55;
    alpha *= 1.0 - this._smoothstep(0.88, 1.0, dist);
    return Math.pow(Math.max(0, Math.min(1, alpha)), 1.2);
  }

  /** @private Dispatch to one of four fluid silhouette families. */
  static _fireAtlasShapeAlpha(shapeType, nx, ny, animCol, animCols, baseSeed) {
    switch (shapeType) {
      case 0: return this._fireShapeRollingCore(nx, ny, animCol, animCols, baseSeed);
      case 1: return this._fireShapeLickingTendrils(nx, ny, animCol, animCols, baseSeed);
      case 2: return this._fireShapeSplitting(nx, ny, animCol, animCols, baseSeed);
      case 3: return this._fireShapeArchipelagoPool(nx, ny, animCol, animCols, baseSeed);
      default: return this._fireShapeRollingCore(nx, ny, animCol, animCols, baseSeed);
    }
  }

  /**
   * Build a cols×rows flipbook of top-down campfire pools.
   * Rows = four fluid shape archetypes (rolling core, licking tendrils, splitting, archipelago pool); cols = flicker frames.
   * @param {number} cols Animation frames per shape.
   * @param {number} rows Shape archetype count.
   * @param {number} cellSize Pixel size of each atlas cell.
   * @returns {HTMLCanvasElement}
   */
  static buildFireAtlas(cols, rows, cellSize) {
    const w = cols * cellSize;
    const h = rows * cellSize;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;
    const baseSeed = 42.1337;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        for (let py = 0; py < cellSize; py++) {
          for (let px = 0; px < cellSize; px++) {
            const nx = (px + 0.5) / cellSize;
            const ny = (py + 0.5) / cellSize;
            const edgeFadeCell = this._fireAtlasEdgeFadeCell(nx, ny);

            let alpha = this._fireAtlasShapeAlpha(row, nx, ny, col, cols, baseSeed);
            alpha *= edgeFadeCell;

            const idx = ((row * cellSize + py) * w + (col * cellSize + px)) * 4;
            data[idx] = 255;
            data[idx + 1] = 255;
            data[idx + 2] = 255;
            data[idx + 3] = Math.floor(Math.max(0, Math.min(1, alpha)) * 255);
          }
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /** @private Shape 0 — Soft rolling billow: domain-warped diffuse smoke body. */
  static _smokeShapeRollingBillow(nx, ny, animCol, animCols, baseSeed) {
    const { tX, tY } = this._smokeAtlasAnimDrift(animCol, animCols);

    const warpX = this._fbm(nx * 2.8 + tX + baseSeed + 91.3, ny * 2.8 + tY, 2) * 0.32;
    const warpY = this._fbm(nx * 2.8 - tY + 17.1, ny * 2.8 + tX + baseSeed, 2) * 0.32;

    const dx = (nx - 0.5 + warpX) * 2.0;
    const dy = (ny - 0.5 + warpY) * 2.0;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const body = Math.exp(-dist * dist * 2.2);
    const detailN = this._fbm(nx * 5.5 - tX, ny * 5.5 - tY, 3);
    const edge = 1.0 - this._smoothstep(0.35, 0.95, dist - detailN * 0.22);
    const wispN = this._fbm(nx * 3.2 + tX * 0.8, ny * 3.2 + tY * 0.8, 2);
    const wisps = this._smoothstep(-0.2, 0.55, wispN) * edge;

    let alpha = body * 0.45 + edge * 0.55 + wisps * 0.25;
    alpha *= 1.0 - this._smoothstep(0.75, 1.0, dist);
    return Math.pow(Math.max(0, Math.min(1, alpha)), 0.88);
  }

  /** @private Shape 1 — Tendril plume: polar noise pulls soft smoke fingers outward. */
  static _smokeShapeTendrilPlume(nx, ny, animCol, animCols, baseSeed) {
    const { tX2, tY2 } = this._smokeAtlasAnimDrift(animCol, animCols);

    const dx = (nx - 0.5) * 2.0;
    const dy = (ny - 0.5) * 2.0;
    const baseDist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    const polarN = this._fbm(Math.cos(angle) * 1.8 + tX2 + baseSeed + 55.2, Math.sin(angle) * 1.8 + tY2, 3);
    const dist = baseDist - polarN * 0.42;

    const core = Math.exp(-dist * dist * 3.5);
    const edge = 1.0 - this._smoothstep(0.25, 0.85, dist);

    let alpha = core * 0.35 + edge * 0.65;
    alpha *= 1.0 - this._smoothstep(0.82, 1.0, baseDist);
    return Math.pow(Math.max(0, Math.min(1, alpha)), 0.92);
  }

  /** @private Shape 2 — Splitting puff: low-frequency warp separates soft smoke lobes. */
  static _smokeShapeSplittingPuff(nx, ny, animCol, animCols, baseSeed) {
    const { tX, tY } = this._smokeAtlasAnimDrift(animCol, animCols);

    const splitN = this._fbm(nx * 1.6 - tX + baseSeed + 203.7, ny * 1.6 - tY, 2);
    const dx = (nx - 0.5 + splitN * 0.38) * 2.0;
    const dy = (ny - 0.5 - splitN * 0.38) * 2.0;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const body = Math.exp(-dist * dist * 2.8);
    const detailN = this._fbm(nx * 4.2 + tX, ny * 4.2 + tY, 3);
    const mask = 1.0 - this._smoothstep(0.3, 0.9, dist + detailN * 0.28);

    let alpha = body * 0.4 + mask * 0.58;
    alpha *= 1.0 - this._smoothstep(0.78, 1.0, Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2) * 2.0);
    return Math.pow(Math.max(0, Math.min(1, alpha)), 0.9);
  }

  /** @private Shape 3 — Filament wisps: gauzy veil broken into detached soft pockets. */
  static _smokeShapeFilamentWisps(nx, ny, animCol, animCols, baseSeed) {
    const { tX, tY } = this._smokeAtlasAnimDrift(animCol, animCols);

    const dx = (nx - 0.5) * 2.0;
    const dy = (ny - 0.5) * 2.0;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const veil = 1.0 - this._smoothstep(0.15, 0.95, dist);
    const wispN = this._fbm(nx * 3.8 + tX * 1.2 + baseSeed + 311.4, ny * 3.8 + tY * 1.2, 3);
    const wispMask = this._smoothstep(-0.15, 0.35, wispN);
    const filamentN = this._fbm(nx * 7.0 + tX, ny * 7.0 + tY, 2);
    const filaments = this._smoothstep(0.05, 0.5, filamentN) * veil * 0.45;
    const faintCore = Math.exp(-dist * dist * 4.0) * 0.22;

    let alpha = (veil * wispMask * 0.85) + filaments + faintCore;
    alpha *= 1.0 - this._smoothstep(0.8, 1.0, dist);
    return Math.pow(Math.max(0, Math.min(1, alpha)), 0.95);
  }

  /** @private Dispatch to one of four smoke silhouette families. */
  static _smokeAtlasShapeAlpha(shapeType, nx, ny, animCol, animCols, baseSeed) {
    switch (shapeType) {
      case 0: return this._smokeShapeRollingBillow(nx, ny, animCol, animCols, baseSeed);
      case 1: return this._smokeShapeTendrilPlume(nx, ny, animCol, animCols, baseSeed);
      case 2: return this._smokeShapeSplittingPuff(nx, ny, animCol, animCols, baseSeed);
      case 3: return this._smokeShapeFilamentWisps(nx, ny, animCol, animCols, baseSeed);
      default: return this._smokeShapeRollingBillow(nx, ny, animCol, animCols, baseSeed);
    }
  }

  /**
   * Build a cols×rows flipbook of top-down smoke puffs.
   * Rows = four wispy shape archetypes; cols = slow drift frames within each shape.
   * @param {number} cols Animation frames per shape.
   * @param {number} rows Shape archetype count.
   * @param {number} cellSize Pixel size of each atlas cell.
   * @returns {HTMLCanvasElement}
   */
  static buildSmokeAtlas(cols, rows, cellSize) {
    const w = cols * cellSize;
    const h = rows * cellSize;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;
    const baseSeed = 128.7711;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        for (let py = 0; py < cellSize; py++) {
          for (let px = 0; px < cellSize; px++) {
            const nx = (px + 0.5) / cellSize;
            const ny = (py + 0.5) / cellSize;
            const edgeFadeCell = this._fireAtlasEdgeFadeCell(nx, ny, 0.08);

            let alpha = this._smokeAtlasShapeAlpha(row, nx, ny, col, cols, baseSeed);
            alpha *= edgeFadeCell;

            const idx = ((row * cellSize + py) * w + (col * cellSize + px)) * 4;
            data[idx] = 255;
            data[idx + 1] = 255;
            data[idx + 2] = 255;
            data[idx + 3] = Math.floor(Math.max(0, Math.min(1, alpha)) * 255);
          }
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * @deprecated Use buildSmokeAtlas — kept as alias for callers expecting a single cell.
   * @param {number} size
   * @returns {HTMLCanvasElement}
   */
  static buildSmokeTexture(size) {
    return this.buildSmokeAtlas(1, 1, size);
  }

  /** @param {HTMLCanvasElement} canvas @param {typeof THREE} THREE */
  static toTexture(canvas, THREE) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  }
}

// ─── FireEffectV2 ────────────────────────────────────────────────────────────

export class FireEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;

    // Cache for direct mask probing so we don't repeatedly 404-spam hosted setups.
    // Key: basePathWithSuffix (no extension). Value: { url, image } or null when missing.
    this._directMaskCache = new Map();

    /**
     * Per-floor cached system sets. Key: floorIndex.
     * Value: { systems, emberSystems, smokeSystems, batchRenderer }
     * @type {Map<number, object>}
     */
    this._floorStates = new Map();

    /**
     * Set of floor indices whose systems are currently in the BatchedRenderer.
     * The bus shows all floors <= maxFloorIndex, so fire must do the same.
     * @type {Set<number>}
     */
    this._activeFloors = new Set();

    /** @type {THREE.Texture|null} Fire sprite texture */
    this._fireTexture = null;
    /** @type {THREE.Texture|null} Ember sprite texture */
    this._emberTexture = null;
    /** @type {THREE.Texture|null} Dedicated smoke puff texture */
    this._smokeTexture = null;
    /** @type {Promise<void>|null} Resolves when sprite textures are loaded */
    this._texturesReady = null;
    /** @type {object|null} Last foundrySceneData used to populate systems */
    this._lastPopulateSceneData = null;
    /** @type {string} Last structural settings signature used for built systems */
    this._structuralSignature = '';
    /** @type {Promise<void>|null} In-flight async rebuild promise */
    this._rebuildInFlight = null;
    /** @type {boolean} Whether another rebuild should run after current one */
    this._rebuildQueued = false;

    /** @type {object|null} LightingEffectV2 — hosts lightScene for glow meshes */
    this._lightingEffect = null;
    /** @type {THREE.Group|null} */
    this._glowRootGroup = null;
    /** @type {Map<number, THREE.Group>} Per-floor glow groups */
    this._glowFloorGroups = new Map();
    /** @type {Map<number, Map<string, object>>} floorIndex → bucketKey → { lightMesh, baseColor, intensity, phase, outdoor } */
    this._glowBucketsByFloor = new Map();
    /** @type {Map<number, object[]>} floorIndex → cluster metadata for rebuilds */
    this._glowClustersByFloor = new Map();
    /** @type {Map<number, Float32Array>} floorIndex → merged fire-mask points for glow re-cluster */
    this._glowSourcePointsByFloor = new Map();
    /** @type {object|null} Scene bounds cached for glow wall clipping */
    this._glowSceneContext = null;
    /** @type {THREE.DataTexture|null} CPU-built heat-haze mask from glow clusters */
    this._heatDistortionMaskTex = null;
    /** @type {Uint8Array|null} Pixel buffer backing `_heatDistortionMaskTex` */
    this._heatDistortionMaskData = null;
    /** @type {string} Cache signature for `_heatDistortionMaskTex` */
    this._heatDistortionMaskSig = '';
    /** @type {number} Cached heat mask width */
    this._heatDistortionMaskW = 0;
    /** @type {number} Cached heat mask height */
    this._heatDistortionMaskH = 0;
    this._visionComputer = new VisionPolygonComputer();
    this._needsGlowRebuild = false;
    this._lastGlowRebuildAt = 0;
    this._glowFlickerDarkness = -1;
    this._glowParamCache = { indoor: null, outdoor: null, darkness: -1 };
    this._outdoorsMaskFrameToken = 0;
    this._systemParamsSignature = '';
    this._simAccumSec = 0;
    /** @type {number} Seconds per fire physics step (for smoke display-age cap). */
    this._lastFireSimStepSec = 1 / FIRE_DEFAULT_SIM_HZ;
    /** @type {number} Last timeInfo.frameCount seen in update(). */
    this._fireUpdateFrameId = -1;
    /** @type {boolean} At most one physics step per rAF frame when simHz < 60. */
    this._firePhysicsDoneThisFrame = false;
    this._physicsFloorCursor = 0;
    this._glowFlickerFloorCursor = 0;
    /** @type {Map<number, number>} Last timeInfo.elapsed when a floor received physics. */
    this._floorLastPhysicsAt = new Map();
    /** @type {import('../../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder|null} */
    this._activePerfRecorder = null;
    /** @type {[string, number][]} */
    this._glowHookIds = [];
    /** @type {number|null} Per-pass lighting floor (strict slice during per-level compose). */
    this._renderFloorIndexForGlow = null;
    /** @type {boolean} When true, only {@link _renderFloorIndexForGlow} emits into `_lightRT`. */
    this._renderFloorSliceStrict = false;
    /** @type {number} Highest floor index visible for stacked particle/glow visibility. */
    this._maxVisibleFloorIndex = 0;

    /**
     * Per-tile / per-background coal-bed shader overlays.
     * @type {Map<string, { mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number }>}
     */
    this._coalOverlays = new Map();
    /** @type {THREE.TextureLoader|null} */
    this._coalTextureLoader = null;
    /** @type {string} Cached coal-bed uniform signature */
    this._coalBedParamSignature = '';
    /** @type {string} Last applied coal-bed preset id */
    this._lastCoalBedPreset = '';

    // Effect parameters — fire-sparks defaults (map-scale flames + smoke).
    this.params = {
      ...COAL_BED_DEFAULT_PARAMS,
      enabled: true,
      globalFireRate: 2.6,
      fireHeight: 600,
      fireSize: 18.0,
      emberRate: 2.3,
      windInfluence: 0.7,
      fireSizeMin: 150,
      fireSizeMax: 195,
      fireLifeMin: 2.9,
      fireLifeMax: 5,
      fireSpinEnabled: true,
      fireSpinSpeedMin: 0,
      fireSpinSpeedMax: 0.3,
      fireTemperature: 0.85,
      flameTextureOpacity: 1,
      flameTextureBrightness: 1.85,
      flameTextureScaleX: 1,
      flameTextureScaleY: 1,
      flameTextureOffsetX: 0,
      flameTextureOffsetY: 0,
      flameTextureRotation: 0,
      flameTextureFlipX: true,
      flameTextureFlipY: true,
      emberSizeMin: 7,
      emberSizeMax: 26,
      emberLifeMin: 1.1,
      emberLifeMax: 11.3,
      fireUpdraft: 1,
      emberUpdraft: 0.2,
      flameStationaryFraction: 0.95,
      fireCurlStrength: 0.5,
      emberCurlStrength: 1.25,
      weatherPrecipKill: 5,
      weatherWindKill: 0.9,
      timeScale: 3,
      lightIntensity: 1.4,
      nightHdrBrightness: 2.4,
      indoorLifeScale: 0.7,
      indoorTimeScale: 0.4,
      flamePeakOpacity: 0.19,
      flameFlipbookCycles: 2,
      coreEmission: 1.4,
      flameBrightnessFloor: 0,
      emberEmission: 12,
      emberPeakOpacity: 1,
      indoorEmberLifeScale: 0.05,
      indoorEmberSuppression: 0.2,
      smokeEnabled: true,
      smokeFlipbookCycles: 0,
      smokeRatio: 2,
      smokeOpacity: 0.19,
      smokeColorWarmth: 0.53,
      smokeColorBrightness: 0.82,
      smokeDarknessResponse: 1,
      smokeSizeMin: 151,
      smokeSizeMax: 400,
      smokeSizeGrowth: 10,
      smokeSizeOverLife: 10,
      smokeLifeMin: 3.1,
      smokeLifeMax: 12.3,
      smokeUpdraft: 0.8,
      smokeTurbulence: 0.05,
      smokeWindInfluence: 4.5,
      smokeOutdoorAboveCanopy: true,
      indoorSmokeSuppression: 1,
      smokeAlphaStart: 0.16,
      smokeAlphaPeak: 0.9,
      smokeAlphaEnd: 1,
      smokeColorGradient: [
        { t: 0, r: 0.9, g: 0.45, b: 0.1 },
        { t: 0.1061011893408639, r: 0.44, g: 0.38, b: 0.32 },
        { t: 0.24895833219800675, r: 0.36, g: 0.34, b: 0.32 },
        { t: 1, r: 0, g: 0, b: 0 },
      ],
      smokeEmissionGradient: [
        { t: 0.22172437617346613, r: 0.04, g: 0.04, b: 0.04 },
        { t: 0.4756279846315714, r: 0.0345205563107544, g: 0.0345205563107544, b: 0.0345205563107544 },
        { t: 1, r: 0, g: 0, b: 0 },
      ],
      heatDistortionEnabled: true,
      heatDistortionIntensity: 0.001,
      heatDistortionFrequency: 20.0,
      heatDistortionSpeed: 3.0,
      heatDistortionEdgeSoftness: 0.5,

      fireMaxSpatialBuckets: FIRE_DEFAULT_MAX_SPATIAL_BUCKETS,
      fireMaxSystemsPerFloor: FIRE_DEFAULT_MAX_SYSTEMS_PER_FLOOR,
      fireOutdoorSplitMaxBuckets: FIRE_DEFAULT_OUTDOOR_SPLIT_MAX_BUCKETS,
      fireSimHz: FIRE_DEFAULT_SIM_HZ,
      fireMaxParticles: 2000,
      fireEmberMaxParticles: 700,
      fireSmokeMaxParticles: 900,

      fireMaskMinBrightness: 0.6,
      fireMaskMinAlpha: 0.8,
      fireMaskPremulThreshold: 0.2,
      fireAlbedoMinAlpha: 0.65,
      fireMaskIsolationPx: 0,

      fireGlowEnabled: true,
      fireGlowBucketSizePx: 512,
      fireGlowMaxBuckets: 128,
      fireGlowRadiusPx: 720,
      fireGlowInnerRadiusScale: 0.22,
      fireGlowFalloffExponent: 1.15,
      fireGlowEdgeSoftness: 0.88,
      fireGlowIntensity: 1.12,
      fireGlowWarmth: 0,
      fireGlowDarknessCancel: 20,
      fireGlowDarknessNightBoost: 1,
      fireGlowFollowLightIntensity: true,
      fireGlowFlickerStrength: 0.25,
      fireGlowFlickerSpeed: 17.8,
      fireGlowFlickerStrengthJitter: 0.82,
      fireGlowFlickerSpeedJitter: 0.72,
      fireGlowWallClipEnabled: true,
      fireGlowWallClipRadiusScale: 1.0,
      fireGlowDayIntensityScale: 0.29,
      fireGlowNightIntensityScale: 0.45,
      fireGlowIndoorIntensityScale: 0.05,
      fireGlowOutdoorIntensityScale: 0.09,
      fireGlowIndoorCancelScale: 0.1,
      fireGlowOutdoorCancelScale: 0.35,
      fireGlowIndoorRadiusScale: 1.16,
      fireGlowOutdoorRadiusScale: 0.82,
      fireGlowIndoorNightBoost: 0.54,
      fireGlowOutdoorNightBoost: 1.45,
      fireGlowNightWarmth: 0.38,
      fireGlowNightIntensity: 3,
      fireGlowNightDarknessCancel: 9.2,
      fireGlowNightRadiusPx: 916,
      fireGlowNightInnerRadiusScale: 0.27,
      fireGlowNightFalloffExponent: 1.1,
      fireGlowNightEdgeSoftness: 1,
      fireGlowNightFlickerStrength: 0.05,
      fireGlowNightFlickerSpeed: 9.5,
      fireGlowNightFlickerStrengthJitter: 0.85,
      fireGlowNightFlickerSpeedJitter: 1,
    };

    log.debug('FireEffectV2 created');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = this._enabled;
    }
    this._applyGlowVisibility();
  }

  /**
   * Diagnostics / HealthEvaluator: first non-null per-floor BatchedRenderer.
   * @returns {BatchedRenderer|null}
   */
  get _batchRenderer() {
    for (const [, st] of this._floorStates) {
      if (st?.batchRenderer) return st.batchRenderer;
    }
    return null;
  }

  /**
   * Build (or return cached) scene-space heat-haze mask from live fire glow
   * clusters. Used when GpuSceneMaskCompositor has no `fire` RT even though
   * FireEffectV2 populated from direct `_Fire` tile probes.
   * @returns {THREE.DataTexture|null}
   */
  buildHeatDistortionMaskTexture() {
    const THREE = window.THREE;
    const ctx = this._glowSceneContext;
    if (!THREE || !ctx) return null;

    const sceneW = Math.max(1, Number(ctx.sceneWidth) || 1);
    const sceneH = Math.max(1, Number(ctx.sceneHeight) || 1);

    /** @type {object[]} */
    const clusters = [];
    for (const idx of this._activeFloors ?? []) {
      const list = this._glowClustersByFloor.get(idx);
      if (!Array.isArray(list) || !list.length) continue;
      for (const c of list) clusters.push(c);
    }

    /** @type {{ u: number, v: number, strength: number, radiusPx: number }[]} */
    const stamps = [];
    if (clusters.length) {
      for (const c of clusters) {
        const foundrySceneX = Number(c?.foundrySceneX ?? ctx.foundrySceneX) || 0;
        const foundrySceneY = Number(c?.foundrySceneY ?? ctx.foundrySceneY) || 0;
        const cSceneW = Math.max(1, Number(c?.sceneWidth ?? sceneW) || sceneW);
        const cSceneH = Math.max(1, Number(c?.sceneHeight ?? sceneH) || sceneH);
        const u = (Number(c?.cxFoundry) - foundrySceneX) / cSceneW;
        const v = (Number(c?.cyFoundry) - foundrySceneY) / cSceneH;
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        stamps.push({
          u,
          v,
          strength: Math.max(0.15, Math.min(1.0, Number(c?.intensity) || 0.5)),
          radiusPx: Math.max(24, Number(c?.radiusPx) || 0),
        });
      }
    } else {
      const avgSize = Math.max(
        32,
        (Number(this.params?.fireSizeMin) + Number(this.params?.fireSizeMax)) * 0.25,
      );
      const pointRadiusPx = Math.max(48, avgSize * 0.85);
      for (const idx of this._activeFloors ?? []) {
        const points = this._glowSourcePointsByFloor.get(idx);
        if (!points || points.length < 3) continue;
        const stride = Math.max(1, Math.ceil((points.length / 3) / 900));
        for (let i = 0; i < points.length; i += 3 * stride) {
          const u = points[i];
          const v = points[i + 1];
          const b = points[i + 2];
          if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0) continue;
          stamps.push({
            u,
            v,
            strength: Math.max(0.12, Math.min(1.0, b)),
            radiusPx: pointRadiusPx,
          });
        }
      }
    }
    if (!stamps.length) return null;

    const maxDim = 2048;
    const scale = Math.min(1, maxDim / Math.max(sceneW, sceneH));
    const w = Math.max(64, Math.round(sceneW * scale));
    const h = Math.max(64, Math.round(sceneH * scale));

    const activeKey = [...(this._activeFloors ?? [])].sort((a, b) => a - b).join(',');
    let sig = `${w}x${h}|f=${activeKey}|n=${stamps.length}`;
    for (let i = 0; i < Math.min(stamps.length, 12); i++) {
      const s = stamps[i];
      sig += `|${Math.round(s.u * 10000)}:${Math.round(s.v * 10000)}:${Math.round(s.radiusPx)}`;
    }

    if (this._heatDistortionMaskTex && sig === this._heatDistortionMaskSig
      && this._heatDistortionMaskW === w && this._heatDistortionMaskH === h) {
      return this._heatDistortionMaskTex;
    }

    if (!this._heatDistortionMaskData || this._heatDistortionMaskW !== w || this._heatDistortionMaskH !== h) {
      this._heatDistortionMaskData = new Uint8Array(w * h);
      if (this._heatDistortionMaskTex) {
        try { this._heatDistortionMaskTex.dispose(); } catch (_) {}
      }
      this._heatDistortionMaskTex = new THREE.DataTexture(
        this._heatDistortionMaskData,
        w,
        h,
        THREE.RedFormat,
        THREE.UnsignedByteType,
      );
      this._heatDistortionMaskTex.flipY = true;
      this._heatDistortionMaskTex.minFilter = THREE.LinearFilter;
      this._heatDistortionMaskTex.magFilter = THREE.LinearFilter;
      this._heatDistortionMaskTex.wrapS = THREE.ClampToEdgeWrapping;
      this._heatDistortionMaskTex.wrapT = THREE.ClampToEdgeWrapping;
      this._heatDistortionMaskTex.generateMipmaps = false;
      this._heatDistortionMaskW = w;
      this._heatDistortionMaskH = h;
    }

    const data = this._heatDistortionMaskData;
    data.fill(0);

    const edgeSoftness = Number.isFinite(Number(this.params?.heatDistortionEdgeSoftness))
      ? Number(this.params.heatDistortionEdgeSoftness)
      : 0.4;
    const hazeExpand = 1.15 + Math.max(0, edgeSoftness - 0.4) * 0.55;

    for (const s of stamps) {
      const cx = s.u * (w - 1);
      const cy = s.v * (h - 1);
      const radiusPx = s.radiusPx * scale * hazeExpand;
      const strength = s.strength;
      const r = Math.ceil(radiusPx);
      const x0 = Math.max(0, Math.floor(cx - r));
      const x1 = Math.min(w - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r));
      const y1 = Math.min(h - 1, Math.ceil(cy + r));
      const r2 = radiusPx * radiusPx;

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx;
          const dy = y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const t = 1.0 - Math.sqrt(d2 / r2);
          const soft = t * t * (3.0 - 2.0 * t);
          const val = Math.round(strength * soft * 255);
          const idx = y * w + x;
          if (val > data[idx]) data[idx] = val;
        }
      }
    }

    this._heatDistortionMaskTex.image.data = data;
    this._heatDistortionMaskTex.needsUpdate = true;
    this._heatDistortionMaskSig = sig;
    return this._heatDistortionMaskTex;
  }

  /** @private */
  _invalidateHeatDistortionMask() {
    this._heatDistortionMaskSig = '';
  }

  /**
   * Apply a runtime parameter change coming from the UI callback bridge.
   * Structural parameters trigger a full particle-system rebuild; dynamic
   * parameters continue to update live in _updateSystemParams/behaviors.
   * @param {string} paramId
   * @param {*} value
   */
  applyParamChange(paramId, value) {
    if (!this.params || !Object.prototype.hasOwnProperty.call(this.params, paramId)) return;
    this.params[paramId] = value;
    if (paramId.startsWith('fireGlow')) {
      this._applyGlowParamChange(paramId);
      this._invalidateGlowParamCache();
      this._invalidateHeatDistortionMask();
    }
    if (paramId.startsWith('heatDistortion')) {
      this._invalidateHeatDistortionMask();
    }
    if (!REBUILD_PARAM_SET.has(paramId)) {
      this._systemParamsSignature = '';
    }
    if (paramId === 'fireSimHz') {
      this._simAccumSec = 0;
    }
    if (REBUILD_PARAM_SET.has(paramId)) {
      this._queueRebuild();
    }
    if (paramId === 'coalBedPreset') {
      applyCoalBedPreset(this.params, value);
      this._lastCoalBedPreset = String(this.params.coalBedPreset ?? 'coal');
      this._coalBedParamSignature = '';
    }
    if (paramId.startsWith('coalBed')) {
      this._coalBedParamSignature = '';
      this._syncCoalBedOverlays();
    }
    if (paramId.startsWith('flameTexture')) {
      this._systemParamsSignature = '';
      applyEmberSpriteTextureTransform(this._emberTexture, this.params);
    }
  }

  /**
   * CPU scan options for `_Fire` mask pickup (particles + glow source points).
   * @returns {{ threshold: number, minMaskAlpha: number, minMaskBrightness: number }}
   * @private
   */
  _fireMaskScanOptions() {
    const p = this.params ?? {};
    return {
      threshold: Math.max(0, Number(p.fireMaskPremulThreshold ?? 0.2)),
      minMaskAlpha: clamp01(Number(p.fireMaskMinAlpha ?? 0.8)),
      minMaskBrightness: clamp01(Number(p.fireMaskMinBrightness ?? 0.6)),
    };
  }

  /**
   * @returns {number}
   * @private
   */
  _fireAlbedoMinAlpha() {
    return clamp01(Number(this.params?.fireAlbedoMinAlpha ?? 0.65));
  }

  /**
   * @returns {number}
   * @private
   */
  _fireMaskIsolationPx() {
    return Math.max(0, Number(this.params?.fireMaskIsolationPx ?? 0) || 0);
  }

  /**
   * Scan + filter a tile/background-local _Fire mask into spawn/glow points.
   * @param {HTMLImageElement|ImageBitmap} fireMaskImage
   * @param {HTMLImageElement|ImageBitmap|null} albedoImage
   * @returns {Float32Array|null}
   * @private
   */
  _pickupFireMaskPoints(fireMaskImage, albedoImage = null) {
    if (!fireMaskImage) return null;
    let points = generateFirePoints(fireMaskImage, this._fireMaskScanOptions());
    points = filterFirePointsByAlbedoAlpha(points, albedoImage, this._fireAlbedoMinAlpha());
    points = filterFirePointsRequireNeighbor(
      points,
      fireMaskImage.width,
      fireMaskImage.height,
      this._fireMaskIsolationPx(),
    );
    return points;
  }

  /**
   * Attach to LightingEffectV2 so fire glow buckets render into the HDR light buffer.
   * @param {object|null} lightingEffect
   */
  setLightingEffect(lightingEffect) {
    this._lightingEffect = lightingEffect || null;
    this._tryAttachGlowRoot();
    this._applyGlowVisibility();
  }

  /**
   * Restrict fire-glow LightMesh visibility for the upcoming `_lightRT` draw.
   * Mirrors WindowLightEffectV2 floor slicing: per-level lighting must not
   * accumulate lower-floor glow pools onto upper-floor lit RTs (screen-space bleed).
   *
   * @param {number|null} [floorIndex=null] - Render floor for the lighting pass
   * @param {boolean} [sliceStrict=false] - When true, only that floor's glow draws
   */
  setRenderFloorIndexForGlow(floorIndex = null, sliceStrict = false) {
    const next = (floorIndex !== null && floorIndex !== undefined) ? Number(floorIndex) : null;
    this._renderFloorIndexForGlow = (next !== null && Number.isFinite(next)) ? next : null;
    this._renderFloorSliceStrict = this._renderFloorIndexForGlow !== null ? !!sliceStrict : false;
    this._applyGlowFloorVisibility(this._maxVisibleFloorIndex);
  }

  // ── UI schema (moved from V1 FireSparksEffect) ───────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Fire',
        summary: [
          'Flames, embers, and smoke spawn from authored _Fire masks on tiles and level backgrounds.',
          'A procedural coal or wood bed shader draws on the tile surface under the flame particles.',
          'Mask pickup scans bright pixels per floor; optional gameplay glow pools light nearby tokens.',
          'Requires matching _Fire files beside each albedo you want to burn.',
        ].join('\n\n'),
      },
      groups: [
        createMaskStatusSchemaGroup('fire'),
        { name: 'flames', label: 'Flames', type: 'folder', advanced: true, expanded: false, parameters: ['globalFireRate', 'fireHeight', 'fireTemperature', 'flamePeakOpacity', 'coreEmission', 'flameBrightnessFloor', 'fireSizeMin', 'fireSizeMax', 'fireLifeMin', 'fireLifeMax', 'flameFlipbookCycles', 'fireSpinEnabled', 'fireSpinSpeedMin', 'fireSpinSpeedMax', 'flameStationaryFraction', 'fireUpdraft', 'fireCurlStrength'] },
        { name: 'flame-texture', label: 'Flame Texture', type: 'folder', advanced: true, expanded: false, parameters: ['flameTextureOpacity', 'flameTextureBrightness', 'flameTextureScaleX', 'flameTextureScaleY', 'flameTextureOffsetX', 'flameTextureOffsetY', 'flameTextureRotation', 'flameTextureFlipX', 'flameTextureFlipY'] },
        { name: 'embers', label: 'Embers', type: 'folder', advanced: true, expanded: false, parameters: ['emberRate', 'emberEmission', 'emberPeakOpacity', 'emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax', 'indoorEmberLifeScale', 'indoorEmberSuppression', 'emberUpdraft', 'emberCurlStrength'] },
        { name: 'smoke', label: 'Smoke', type: 'folder', expanded: true, parameters: ['smokeEnabled', 'smokeOutdoorAboveCanopy', 'smokeRatio', 'smokeOpacity', 'indoorSmokeSuppression', 'smokeColorWarmth', 'smokeColorBrightness', 'smokeDarknessResponse', 'smokeColorGradient', 'smokeEmissionGradient', 'smokeAlphaStart', 'smokeAlphaPeak', 'smokeAlphaEnd', 'smokeSizeMin', 'smokeSizeMax', 'smokeSizeOverLife', 'smokeLifeMin', 'smokeLifeMax', 'smokeFlipbookCycles', 'smokeUpdraft', 'smokeTurbulence', 'smokeWindInfluence'] },
        {
          name: 'fire-mask-pickup',
          label: 'Fire Mask Pickup',
          type: 'folder',
          expanded: true,
          parameters: [
            'fireMaskMinBrightness',
            'fireMaskMinAlpha',
            'fireMaskPremulThreshold',
            'fireAlbedoMinAlpha',
            'fireMaskIsolationPx',
          ],
        },
        {
          name: 'fire-glow',
          label: 'Fire Glow (Gameplay Light)',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'fireGlowEnabled',
            'fireGlowFollowLightIntensity',
            'fireGlowDayIntensityScale',
            'fireGlowNightIntensityScale',
            'fireGlowDarknessNightBoost',
            'fireGlowBucketSizePx',
            'fireGlowMaxBuckets',
            'fireGlowWallClipEnabled',
            'fireGlowWallClipRadiusScale',
          ],
        },
        {
          name: 'fire-glow-indoor',
          label: 'Fire Glow — Indoor Balance',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'fireGlowIndoorIntensityScale',
            'fireGlowIndoorCancelScale',
            'fireGlowIndoorRadiusScale',
            'fireGlowIndoorNightBoost',
          ],
        },
        {
          name: 'fire-glow-outdoor',
          label: 'Fire Glow — Outdoor Balance',
          type: 'folder',
          expanded: true,
          parameters: [
            'fireGlowOutdoorIntensityScale',
            'fireGlowOutdoorCancelScale',
            'fireGlowOutdoorRadiusScale',
            'fireGlowOutdoorNightBoost',
          ],
        },
        {
          name: 'fire-glow-day',
          label: 'Fire Glow — Day Pool',
          type: 'folder',
          expanded: false,
          parameters: [
            'fireGlowWarmth',
            'fireGlowIntensity',
            'fireGlowDarknessCancel',
            'fireGlowFlickerStrength',
            'fireGlowFlickerSpeed',
            'fireGlowFlickerStrengthJitter',
            'fireGlowFlickerSpeedJitter',
            'fireGlowRadiusPx',
            'fireGlowInnerRadiusScale',
            'fireGlowFalloffExponent',
            'fireGlowEdgeSoftness',
          ],
        },
        {
          name: 'fire-glow-night',
          label: 'Fire Glow — Night Pool',
          type: 'folder',
          advanced: true,
          expanded: true,
          parameters: [
            'fireGlowNightWarmth',
            'fireGlowNightIntensity',
            'fireGlowNightDarknessCancel',
            'fireGlowNightFlickerStrength',
            'fireGlowNightFlickerSpeed',
            'fireGlowNightFlickerStrengthJitter',
            'fireGlowNightFlickerSpeedJitter',
            'fireGlowNightRadiusPx',
            'fireGlowNightInnerRadiusScale',
            'fireGlowNightFalloffExponent',
            'fireGlowNightEdgeSoftness',
          ],
        },
        { name: 'environment', label: 'Environment', type: 'folder', advanced: true, expanded: false, parameters: ['timeScale', 'lightIntensity', 'nightHdrBrightness', 'indoorLifeScale', 'indoorTimeScale', 'weatherPrecipKill'] },
        {
          name: 'fire-performance',
          label: 'Performance',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'fireSimHz',
            'fireMaxSpatialBuckets',
            'fireMaxSystemsPerFloor',
            'fireOutdoorSplitMaxBuckets',
            'fireMaxParticles',
            'fireEmberMaxParticles',
            'fireSmokeMaxParticles',
          ],
        },
        { name: 'heat-distortion', label: 'Heat Distortion', type: 'folder', advanced: true, expanded: false, parameters: ['heatDistortionEnabled', 'heatDistortionIntensity', 'heatDistortionFrequency', 'heatDistortionSpeed', 'heatDistortionEdgeSoftness'] },
        {
          name: 'coal-bed',
          label: 'Coal Bed',
          type: 'folder',
          expanded: true,
          parameters: ['coalBedEnabled', 'coalBedIntensity', 'coalBedOpacity'],
        },
        {
          name: 'coal-bed-style',
          label: 'Coal Bed — Style',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'coalBedPreset',
            'coalBedChunkScale',
            'coalBedChunkContrast',
            'coalBedChunkAspect',
            'coalBedGrainScale',
            'coalBedGrainAngle',
            'coalBedTurbulence',
          ],
        },
        {
          name: 'coal-bed-colors',
          label: 'Coal Bed — Colors',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'coalBedColorChar',
            'coalBedColorHot',
            'coalBedColorWarm',
            'coalBedColorAshWarm',
            'coalBedColorAshCool',
            'coalBedSaturation',
            'coalBedContrast',
            'coalBedEmissiveGain',
            'coalBedFlareDensity',
          ],
        },
        {
          name: 'coal-bed-bands',
          label: 'Coal Bed — Bands',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'coalBedBandCharEnd',
            'coalBedBandHotEnd',
            'coalBedBandWarmEnd',
            'coalBedBandAshWarmEnd',
          ],
        },
        {
          name: 'coal-bed-motion',
          label: 'Coal Bed — Motion',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'coalBedScrollSpeed',
            'coalBedScrollAngle',
            'coalBedEvolveSpeed',
            'coalBedPulseSpeed',
            'coalBedHeatLevels',
            'coalBedEdgeSoftness',
            'coalBedFlareChaos',
            'coalBedRimStrength',
          ],
        },
        {
          name: 'coal-bed-mask',
          label: 'Coal Bed — Mask',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['coalBedMaskLo', 'coalBedMaskExpand', 'coalBedMaskDither'],
        },
      ],
      parameters: {
        enabled: { type: 'checkbox', label: 'Fire Enabled', default: true },
        globalFireRate: { type: 'slider', label: 'Global Intensity', min: 0.0, max: 20.0, step: 0.1, default: 2.6 },
        fireHeight: { type: 'slider', label: 'Height', min: 1.0, max: 600.0, step: 1.0, default: 600 },
        fireTemperature: { type: 'slider', label: 'Temperature', min: 0.0, max: 1.0, step: 0.05, default: 0.85 },
        flamePeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.19 },
        coreEmission: {
          type: 'slider',
          label: 'Core Emission (HDR)',
          min: 0.5,
          max: 12.0,
          step: 0.1,
          default: 1.4,
          tooltip: 'Linear HDR flame energy. Raised for the unclamped lighting pipeline — push higher if night fires look pale.',
        },
        flameBrightnessFloor: { type: 'slider', label: 'Mask Brightness Floor', min: 0.0, max: 1.5, step: 0.01, default: 0 },
        fireSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 150.0, step: 1.0, default: 150 },
        fireSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 200.0, step: 1.0, default: 195 },
        fireLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 6.0, step: 0.05, default: 2.9 },
        fireLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 6.0, step: 0.05, default: 5 },
        flameFlipbookCycles: {
          type: 'slider',
          label: 'Flipbook Cycles',
          min: 0.5,
          max: 6.0,
          step: 0.1,
          default: 2,
          tooltip: 'How many full sprite flipbook loops each flame completes over its lifetime. Higher = faster flicker without changing fade or size.',
        },
        fireSpinEnabled: { type: 'checkbox', label: 'Spin Enabled', default: true, hidden: true },
        fireSpinSpeedMin: { type: 'slider', label: 'Spin Speed Min', min: 0.0, max: 50.0, step: 0.1, default: 0, hidden: true },
        fireSpinSpeedMax: { type: 'slider', label: 'Spin Speed Max', min: 0.0, max: 50.0, step: 0.1, default: 0.3, hidden: true },
        fireUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 1 },
        flameStationaryFraction: {
          type: 'slider',
          label: 'Anchored Flames',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.95,
          tooltip: 'Fraction of flame particles that skip updraft, turbulence, and wind so they stay on the burning surface.',
        },
        fireCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 0.5 },
        flameTextureOpacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        flameTextureBrightness: { type: 'slider', label: 'Brightness', min: 0.0, max: 3.0, step: 0.01, default: 1.85 },
        flameTextureScaleX: {
          type: 'slider', label: 'Scale X', min: 0.05, max: 4.0, step: 0.05, default: 1.0,
          tooltip: 'Applies to the ember sprite. Flame flipbook atlas orientation is fixed.',
        },
        flameTextureScaleY: {
          type: 'slider', label: 'Scale Y', min: 0.05, max: 4.0, step: 0.05, default: 1.0,
          tooltip: 'Applies to the ember sprite. Flame flipbook atlas orientation is fixed.',
        },
        flameTextureOffsetX: { type: 'slider', label: 'Offset X', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        flameTextureOffsetY: { type: 'slider', label: 'Offset Y', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        flameTextureRotation: { type: 'slider', label: 'Rotation (rad)', min: -3.14, max: 3.14, step: 0.01, default: 0.0 },
        flameTextureFlipX: {
          type: 'checkbox', label: 'Flip X', default: true,
          tooltip: 'Ember sprite only.',
        },
        flameTextureFlipY: {
          type: 'checkbox', label: 'Flip Y', default: true,
          tooltip: 'Ember sprite only.',
        },
        emberRate: { type: 'slider', label: 'Density', min: 0.0, max: 5.0, step: 0.1, default: 2.3 },
        emberEmission: {
          type: 'slider',
          label: 'Emission (HDR)',
          min: 0.5,
          max: 12.0,
          step: 0.1,
          default: 12,
          tooltip: 'Linear HDR ember energy (vertex RGB, not alpha).',
        },
        emberPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        emberSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 40.0, step: 1.0, default: 7 },
        emberSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 60.0, step: 1.0, default: 26 },
        emberLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 8.0, step: 0.1, default: 1.1 },
        emberLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 12.0, step: 0.1, default: 11.3 },
        indoorEmberLifeScale: {
          type: 'slider',
          label: 'Indoor Life Scale',
          min: 0.05,
          max: 1.0,
          step: 0.05,
          default: 0.05,
          tooltip: 'Shortens ember lifespan under roof mask (stacks with Environment → Indoor Life Scale).',
        },
        indoorEmberSuppression: {
          type: 'slider',
          label: 'Indoor Density Suppression',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.2,
          tooltip: 'Scales indoor ember brightness/opacity by roof coverage (0 = none; 1 = fully suppressed under roof). Updates live.',
        },
        emberUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 0.2 },
        emberCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 1.25 },
        smokeEnabled: { type: 'checkbox', label: 'Enable Smoke', default: true },
        smokeOutdoorAboveCanopy: {
          type: 'checkbox',
          label: 'Outdoor Smoke & Embers Above Trees',
          default: true,
          tooltip: 'Outdoor smoke and embers (uncovered by roof mask) render above tree and bush canopies. Indoor particles stay under overhead tiles.',
        },
        smokeRatio: { type: 'slider', label: 'Emission Density', min: 0.0, max: 3.0, step: 0.05, default: 2 },
        smokeOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.19 },
        indoorSmokeSuppression: {
          type: 'slider', label: 'Indoor Smoke Suppression', min: 0.0, max: 1.0, step: 0.01, default: 1,
          tooltip: 'Scales indoor smoke opacity by roof coverage (0 = none; 1 = fully suppressed under roof). Updates live.',
        },
        // Legacy colour controls — used when smokeColorGradient is null.
        smokeColorWarmth: { type: 'slider', label: 'Color Warmth', min: 0.0, max: 1.0, step: 0.01, default: 0.53 },
        smokeColorBrightness: { type: 'slider', label: 'Brightness', min: 0.05, max: 2.0, step: 0.01, default: 0.82 },
        smokeDarknessResponse: { type: 'slider', label: 'Darkness Response', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        // Colour-over-life gradient. When set, overrides the warmth/brightness sliders.
        smokeColorGradient: {
          type: 'gradient',
          label: 'Colour Over Life',
          default: [
            { t: 0, r: 0.9, g: 0.45, b: 0.1 },
            { t: 0.1061011893408639, r: 0.44, g: 0.38, b: 0.32 },
            { t: 0.24895833219800675, r: 0.36, g: 0.34, b: 0.32 },
            { t: 1, r: 0, g: 0, b: 0 },
          ]
        },
        // Added on top of base smoke RGB in the lifecycle (black = no extra glow).
        smokeEmissionGradient: {
          type: 'gradient',
          label: 'Emission tint over life',
          default: [
            { t: 0.22172437617346613, r: 0.04, g: 0.04, b: 0.04 },
            { t: 0.4756279846315714, r: 0.0345205563107544, g: 0.0345205563107544, b: 0.0345205563107544 },
            { t: 1, r: 0, g: 0, b: 0 },
          ]
        },
        smokeSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 200.0, step: 1.0, default: 151 },
        smokeSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 400.0, step: 1.0, default: 400 },
        smokeSizeGrowth: { type: 'slider', label: 'Size Growth (Legacy)', min: 1.0, max: 10.0, step: 0.1, default: 10, hidden: true },
        smokeSizeOverLife: { type: 'slider', label: 'Size Over Life', min: 1.0, max: 10.0, step: 0.1, default: 10 },
        smokeLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 10.0, step: 0.1, default: 3.1 },
        smokeLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 15.0, step: 0.1, default: 12.3 },
        smokeFlipbookCycles: {
          type: 'slider',
          label: 'Flipbook Cycles',
          min: 0,
          max: 2.0,
          step: 0.05,
          default: 0,
          tooltip: 'Optional atlas loops per puff (requires multi-frame atlas). 0 = static silhouette — recommended.',
        },
        smokeAlphaStart: { type: 'slider', label: 'Opacity ramp from (life %)', min: 0.0, max: 1.0, step: 0.01, default: 0.16,
          tooltip: 'Life % when opacity begins rising from zero. Must be ≤ Peak opacity at.' },
        smokeAlphaPeak: { type: 'slider', label: 'Peak opacity at (life %)', min: 0.0, max: 1.0, step: 0.01, default: 0.9,
          tooltip: 'Life % at full opacity. If below “ramp from”, treated as same point (hold, then fade).' },
        smokeUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 20.0, step: 0.1, default: 0.8 },
        smokeTurbulence: { type: 'slider', label: 'Turbulence', min: 0.0, max: 5.0, step: 0.05, default: 0.05 },
        smokeWindInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 10.0, step: 0.1, default: 4.5 },
        smokeAlphaEnd: { type: 'slider', label: 'Opacity reaches zero at (life %)', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        fireMaskMinBrightness: {
          type: 'slider',
          label: 'Min Mask White',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.6,
          tooltip: 'Require this much peak RGB brightness in the _Fire mask (0–1). Raise to ignore grey fringe and keep only strong white texels.',
        },
        fireMaskMinAlpha: {
          type: 'slider',
          label: 'Min Mask Alpha',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.8,
          tooltip: 'Reject _Fire texels below this alpha. Raise to drop semi-transparent anti-alias edges (try 0.85–0.95 for WebP holes).',
        },
        fireMaskPremulThreshold: {
          type: 'slider',
          label: 'Min Combined Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.2,
          tooltip: 'Minimum premultiplied strength (mask white × mask alpha). Higher = fewer, stronger pickup points.',
        },
        fireAlbedoMinAlpha: {
          type: 'slider',
          label: 'Min Tile Alpha',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65,
          tooltip: 'Require the colour texture (tile/background) to be this opaque at the same UV. Suppresses fire on transparent map holes and upper-floor rims.',
        },
        fireMaskIsolationPx: {
          type: 'slider',
          label: 'Min Neighbour Distance (px)',
          min: 0,
          max: 64,
          step: 1,
          default: 0,
          tooltip: 'Drop isolated _Fire specks with no neighbour within this distance in mask pixels. 0 = off; try 8–16 to cull single-pixel noise.',
        },
        fireGlowEnabled: { type: 'checkbox', label: 'Enable Fire Glow', default: true },
        fireGlowWarmth: {
          type: 'slider',
          label: 'Pool Warmth',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0,
          tooltip: 'Daylight pool hue at full day. Blends toward Fire Glow — Night Pool at darkness.',
        },
        fireGlowIntensity: {
          type: 'slider',
          label: 'Pool Intensity',
          min: 0,
          max: 3.0,
          step: 0.01,
          default: 1.12,
          tooltip: 'Day flicker/intensity at full daylight.',
        },
        fireGlowDarknessCancel: {
          type: 'slider', label: 'Darkness Cancel (HDR)', min: 0, max: 20, step: 0.1, default: 20,
          tooltip: 'Day HDR punch into the light buffer. Night value is in Fire Glow — Night Pool.',
        },
        fireGlowDarknessNightBoost: {
          type: 'slider', label: 'Night Cancel Boost', min: 1, max: 5, step: 0.05, default: 1,
          tooltip: 'Extra darkness-cancel strength at full scene night.',
        },
        fireGlowFollowLightIntensity: {
          type: 'checkbox', label: 'Follow HDR Brightness Slider', default: true,
          tooltip: 'Multiply cancel strength by Environment → HDR Brightness (day/night blend).',
        },
        fireGlowDayIntensityScale: {
          type: 'slider', label: 'Day Pool Scale', min: 0, max: 2, step: 0.01, default: 0.29,
          tooltip: 'Gameplay-light pool strength at full daylight (master darkness ≈ 0). Fires always emit; night adds darkness-cancel on top.',
        },
        fireGlowNightIntensityScale: {
          type: 'slider', label: 'Night Pool Scale', min: 0, max: 3, step: 0.01, default: 0.45,
          tooltip: 'Brightness multiplier at full night (master darkness ≈ 1). Does not change glow hue.',
        },
        fireGlowIndoorIntensityScale: {
          type: 'slider', label: 'Intensity Scale', min: 0, max: 4, step: 0.01, default: 0.05,
          tooltip: 'Multiplies day/night pool intensity under roof. Outdoor fires use Fire Glow — Outdoor Balance.',
        },
        fireGlowIndoorCancelScale: {
          type: 'slider', label: 'Cancel Scale', min: 0, max: 4, step: 0.01, default: 0.1,
          tooltip: 'HDR darkness-cancel multiplier for indoor pools (after day/night cancel blend).',
        },
        fireGlowIndoorRadiusScale: {
          type: 'slider', label: 'Radius Scale', min: 0.25, max: 3, step: 0.01, default: 1.16,
          tooltip: 'Indoor pool reach multiplier (after day/night radius blend).',
        },
        fireGlowIndoorNightBoost: {
          type: 'slider', label: 'Night Boost', min: 0, max: 4, step: 0.01, default: 0.54,
          tooltip: 'Extra indoor glow at full darkness. Usually lower than outdoor — interior CC already lifts local light.',
        },
        fireGlowOutdoorIntensityScale: {
          type: 'slider', label: 'Intensity Scale', min: 0, max: 4, step: 0.01, default: 0.09,
          tooltip: 'Multiplies day/night pool intensity in open air. Push high for campfires vs midnight ToD.',
        },
        fireGlowOutdoorCancelScale: {
          type: 'slider', label: 'Cancel Scale', min: 0, max: 4, step: 0.01, default: 0.35,
          tooltip: 'HDR darkness-cancel multiplier for outdoor pools. Primary control for bright outdoor fire rings.',
        },
        fireGlowOutdoorRadiusScale: {
          type: 'slider', label: 'Radius Scale', min: 0.25, max: 3, step: 0.01, default: 0.82,
          tooltip: 'Outdoor pool reach multiplier — wider lit area under open sky.',
        },
        fireGlowOutdoorNightBoost: {
          type: 'slider', label: 'Night Boost', min: 0, max: 4, step: 0.01, default: 1.45,
          tooltip: 'Extra outdoor glow at full darkness, on top of intensity/cancel scales.',
        },
        fireGlowNightWarmth: {
          type: 'slider', label: 'Pool Warmth', min: 0, max: 1, step: 0.01, default: 0.38,
          tooltip: 'Night-only pool hue. Blends toward this at full darkness; day warmth is in Fire Glow — Day Pool.',
        },
        fireGlowNightIntensity: {
          type: 'slider', label: 'Pool Intensity', min: 0, max: 3.0, step: 0.01, default: 3,
          tooltip: 'Night flicker/intensity scale at full darkness.',
        },
        fireGlowNightDarknessCancel: {
          type: 'slider', label: 'Darkness Cancel (HDR)', min: 0, max: 20, step: 0.1, default: 9.2,
          tooltip: 'Night HDR punch into the light buffer. Usually higher than the day value for midnight scenes.',
        },
        fireGlowNightFlickerStrength: {
          type: 'slider', label: 'Flicker Strength', min: 0, max: 12, step: 0.05, default: 0.05,
        },
        fireGlowNightFlickerSpeed: {
          type: 'slider', label: 'Flicker Speed', min: 0, max: 25, step: 0.1, default: 9.5,
        },
        fireGlowNightFlickerStrengthJitter: {
          type: 'slider', label: 'Flicker Strength Jitter', min: 0, max: 1, step: 0.01, default: 0.85,
        },
        fireGlowNightFlickerSpeedJitter: {
          type: 'slider', label: 'Flicker Speed Jitter', min: 0, max: 1, step: 0.01, default: 1,
        },
        fireGlowNightRadiusPx: {
          type: 'slider', label: 'Pool Radius (px)', min: 32, max: 2000, step: 4, default: 916,
          tooltip: 'Night pool reach at full darkness. Blends from day radius as scene darkens.',
        },
        fireGlowNightInnerRadiusScale: {
          type: 'slider', label: 'Hot Core Scale', min: 0.05, max: 1, step: 0.01, default: 0.27,
        },
        fireGlowNightFalloffExponent: {
          type: 'slider', label: 'Falloff Exponent', min: 0.5, max: 2.5, step: 0.05, default: 1.1,
          tooltip: 'Night core tightness. Lower = wider soft midnight pool.',
        },
        fireGlowNightEdgeSoftness: {
          type: 'slider', label: 'Pool Edge Softness', min: 0, max: 1.0, step: 0.01, default: 1,
          tooltip: 'Night rim feather in the HDR light buffer.',
        },
        fireGlowFlickerStrength: { type: 'slider', label: 'Flicker Strength', min: 0, max: 12, step: 0.05, default: 0.25 },
        fireGlowFlickerSpeed: { type: 'slider', label: 'Flicker Speed', min: 0, max: 25, step: 0.1, default: 17.8 },
        fireGlowFlickerStrengthJitter: { type: 'slider', label: 'Flicker Strength Jitter', min: 0, max: 1, step: 0.01, default: 0.82 },
        fireGlowFlickerSpeedJitter: { type: 'slider', label: 'Flicker Speed Jitter', min: 0, max: 1, step: 0.01, default: 0.72 },
        fireGlowRadiusPx: { type: 'slider', label: 'Pool Radius (px)', min: 32, max: 2000, step: 4, default: 720 },
        fireGlowInnerRadiusScale: { type: 'slider', label: 'Hot Core Scale', min: 0.05, max: 1, step: 0.01, default: 0.22 },
        fireGlowFalloffExponent: {
          type: 'slider', label: 'Falloff Exponent', min: 0.5, max: 2.5, step: 0.05, default: 1.15,
          tooltip: 'Core tightness for unified radial falloff. Lower = wider soft pool; higher ≈ inverse-square hot core.',
        },
        fireGlowEdgeSoftness: {
          type: 'slider', label: 'Pool Edge Softness', min: 0, max: 1.0, step: 0.01, default: 0.88,
          tooltip: 'Feathers the glow rim in the HDR light buffer. Drives shader attenuation + rim geometry (higher = wider, softer pool).',
        },
        fireGlowBucketSizePx: {
          type: 'slider', label: 'Cluster Bucket (px)', min: 128, max: 2048, step: 16, default: 512,
          tooltip: 'Spatial cluster size for glow pools. Lower values keep separate wall-clipped pools per fire group; very large buckets merge distant fires and weaken wall clipping.',
        },
        fireGlowMaxBuckets: { type: 'slider', label: 'Max Glow Pools', min: 1, max: 256, step: 1, default: 128 },
        fireGlowWallClipEnabled: { type: 'checkbox', label: 'Wall Clip Glow', default: true },
        fireGlowWallClipRadiusScale: { type: 'slider', label: 'Wall Clip Radius Scale', min: 0.25, max: 2, step: 0.01, default: 1.0 },
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 5.0, step: 0.1, default: 0.7, hidden: true },
        timeScale: { type: 'slider', label: 'Time Scale', min: 0.1, max: 3.0, step: 0.05, default: 3 },
        lightIntensity: {
          type: 'slider',
          label: 'HDR Brightness (Day)',
          min: 0.0,
          max: 5.0,
          step: 0.1,
          default: 1.4,
          tooltip: 'Linear HDR output at full daylight. Blends toward Night HDR Brightness as scene darkness increases.',
        },
        nightHdrBrightness: {
          type: 'slider',
          label: 'Night HDR Brightness',
          min: 0.0,
          max: 12.0,
          step: 0.1,
          default: 2.4,
          tooltip: 'Linear HDR output at full night. Raise if flames, embers, and smoke emission look too dim after Color Correction.',
        },
        indoorLifeScale: { type: 'slider', label: 'Indoor Life Scale', min: 0.05, max: 1.0, step: 0.05, default: 0.7 },
        indoorTimeScale: { type: 'slider', label: 'Indoor Time Scale', min: 0.05, max: 1.0, step: 0.05, default: 0.4 },
        weatherPrecipKill: { type: 'slider', label: 'Rain Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 5, tooltip: 'How strongly rain shortens outdoor flame life and suppresses outdoor updraft.' },
        weatherWindKill: { type: 'slider', label: 'Wind Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 0.9, hidden: true },
        heatDistortionEnabled: { type: 'checkbox', label: 'Enable Heat Haze', default: true },
        heatDistortionIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 0.05, step: 0.001, default: 0.001 },
        heatDistortionFrequency: { type: 'slider', label: 'Frequency', min: 1.0, max: 20.0, step: 0.5, default: 20.0 },
        heatDistortionSpeed: { type: 'slider', label: 'Speed', min: 0.1, max: 3.0, step: 0.1, default: 3.0 },
        heatDistortionEdgeSoftness: { type: 'slider', label: 'Edge Softness', min: 0.4, max: 3.0, step: 0.05, default: 0.5 },
        fireSimHz: {
          type: 'slider',
          label: 'Simulation Rate (Hz)',
          min: 8,
          max: FIRE_MAX_SIM_HZ,
          step: 1,
          default: FIRE_DEFAULT_SIM_HZ,
          tooltip: `CPU physics step rate. Set to 60+ for buttery smooth movement, or lower to save CPU.`,
        },
        fireMaxSpatialBuckets: {
          type: 'slider',
          label: 'Max Spatial Buckets / Floor',
          min: 4,
          max: 96,
          step: 1,
          default: FIRE_DEFAULT_MAX_SPATIAL_BUCKETS,
          tooltip: 'Caps particle emitter count per floor. Larger fire maps auto-coarsen buckets when this limit is exceeded.',
        },
        fireMaxSystemsPerFloor: {
          type: 'slider',
          label: 'Max Particle Systems / Floor',
          min: 8,
          max: 120,
          step: 1,
          default: FIRE_DEFAULT_MAX_SYSTEMS_PER_FLOOR,
          tooltip: 'Hard cap on fire + ember + smoke emitters. Excess mask area is merged into fewer buckets.',
        },
        fireOutdoorSplitMaxBuckets: {
          type: 'slider',
          label: 'Outdoor Split Max Buckets',
          min: 2,
          max: 32,
          step: 1,
          default: FIRE_DEFAULT_OUTDOOR_SPLIT_MAX_BUCKETS,
          tooltip: 'Indoor/outdoor ember+smoke split only applies when spatial bucket count is at or below this value.',
        },
        fireMaxParticles: {
          type: 'slider',
          label: 'Max Flame Particles / Bucket',
          min: 200,
          max: 10000,
          step: 50,
          default: 2000,
          tooltip: 'Hard per-bucket cap (scaled by mask area). Emission auto-limits to stay within this budget — reload after changing.',
        },
        fireEmberMaxParticles: {
          type: 'slider',
          label: 'Max Ember Particles / Bucket',
          min: 100,
          max: 4000,
          step: 50,
          default: 700,
          tooltip: 'Hard cap per ember system; emission scales down to match lifespan.',
        },
        fireSmokeMaxParticles: {
          type: 'slider',
          label: 'Max Smoke Particles / Bucket',
          min: 100,
          max: 6000,
          step: 50,
          default: 900,
          tooltip: 'Hard cap per smoke system. Long smoke lifetimes make this the main steady-state CPU driver.',
        },
        coalBedEnabled: {
          type: 'checkbox',
          label: 'Enable Coal Bed',
          default: true,
          tooltip: 'Procedural coal or wood substrate drawn on the tile surface under flame particles.',
        },
        coalBedIntensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.24,
          tooltip: 'Master brightness for smolder tint and HDR sparks.',
        },
        coalBedOpacity: {
          type: 'slider',
          label: 'Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.53,
          tooltip: 'Coal stain strength (premultiplied). Also gently scales spark brightness.',
        },
        coalBedPreset: {
          type: 'select',
          label: 'Preset',
          options: { 'Coal Bed': 'coal', 'Burning Wood': 'wood', 'Charcoal': 'charcoal' },
          default: 'coal',
        },
        coalBedChunkScale: {
          type: 'slider',
          label: 'Smolder Block (px)',
          min: 8.0,
          max: 96.0,
          step: 1.0,
          default: 36.0,
          tooltip: 'Slow coal-bed blocks in overlay pixels. Larger = broader smolder patches.',
        },
        coalBedChunkContrast: {
          type: 'slider',
          label: 'Smolder Sharpness',
          min: 0.5,
          max: 6.0,
          step: 0.05,
          default: 0.5,
          tooltip: 'How crisp smolder blocks are vs charcoal grit.',
        },
        coalBedChunkAspect: {
          type: 'slider',
          label: 'Smolder Aspect',
          min: 0.5,
          max: 4.0,
          step: 0.05,
          default: 3.0,
          tooltip: 'Stretches smolder blocks along the grain angle.',
        },
        coalBedGrainScale: {
          type: 'slider',
          label: 'Flare Size (px)',
          min: 2.0,
          max: 24.0,
          step: 0.5,
          default: 2.0,
          tooltip: 'HDR spark cell size in overlay pixels. Lower = smaller, denser flares.',
        },
        coalBedGrainAngle: {
          type: 'slider',
          label: 'Smolder Angle (rad)',
          min: -3.14,
          max: 3.14,
          step: 0.05,
          default: 1.7,
          tooltip: 'Rotates smolder block grid (sparks stay axis-aligned).',
        },
        coalBedColorChar: { type: 'color', label: 'Char / Unburnt', default: '#1a100c' },
        coalBedColorHot: { type: 'color', label: 'Flare Hot', default: '#ffffff' },
        coalBedColorWarm: { type: 'color', label: 'Ember Warm', default: '#ff4400' },
        coalBedColorAshWarm: { type: 'color', label: 'Smolder', default: '#aa5030' },
        coalBedColorAshCool: { type: 'color', label: 'Dead Ash', default: '#524840' },
        coalBedSaturation: { type: 'slider', label: 'Saturation', min: 0.0, max: 2.5, step: 0.01, default: 0.95 },
        coalBedContrast: {
          type: 'slider',
          label: 'Saturation Boost',
          min: 0.5,
          max: 2.0,
          step: 0.01,
          default: 1.22,
          tooltip: 'Mild color punch — does not crush to black.',
        },
        coalBedRimStrength: {
          type: 'slider',
          label: 'Parallax Depth',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.04,
          tooltip: 'Shifts cold ash UVs so char/cracks appear recessed — cheap fake volume on the flat bed.',
        },
        coalBedEmissiveGain: {
          type: 'slider',
          label: 'Emissive Gain (HDR)',
          min: 0.0,
          max: 16.0,
          step: 0.1,
          default: 12.5,
          tooltip: 'Linear HDR multiplier on flare pixels (bloom picks this up).',
        },
        coalBedFlareDensity: {
          type: 'slider',
          label: 'Spark Coverage',
          min: 0.2,
          max: 0.98,
          step: 0.01,
          default: 0.37,
          tooltip: 'Fraction of flare cells that can spark. Higher = more simultaneous hot spots.',
        },
        coalBedBandCharEnd: {
          type: 'slider', label: 'Ash → Char', min: 0.05, max: 0.95, step: 0.01, default: 0.05,
          tooltip: 'Normalized smolder heat where dead ash gives way to char. Lower = more ash, higher = more char.',
        },
        coalBedBandHotEnd: {
          type: 'slider', label: 'Char → Smolder', min: 0.05, max: 0.95, step: 0.01, default: 0.3,
          tooltip: 'Heat threshold for char → smolder (ash-warm) transition.',
        },
        coalBedBandWarmEnd: {
          type: 'slider', label: 'Smolder → Warm', min: 0.05, max: 0.95, step: 0.01, default: 0.41,
          tooltip: 'Heat threshold for smolder → warm ember tones.',
        },
        coalBedBandAshWarmEnd: {
          type: 'slider', label: 'Warm → Hot', min: 0.05, max: 0.95, step: 0.01, default: 0.95,
          tooltip: 'Heat threshold for warm → hot core colour on the brightest smolder cells.',
        },
        coalBedScrollSpeed: { type: 'slider', label: 'Scroll (unused)', min: 0.0, max: 0.2, step: 0.005, default: 0.0, hidden: true },
        coalBedScrollAngle: { type: 'slider', label: 'Scroll Angle (unused)', min: -3.14, max: 3.14, step: 0.05, default: 0.0, hidden: true },
        coalBedEvolveSpeed: {
          type: 'slider',
          label: 'Smolder Drift Speed',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 2.0,
          tooltip: 'Slow per-block smolder breathing — does not flash the whole mask.',
        },
        coalBedPulseSpeed: {
          type: 'slider',
          label: 'Spark Rate',
          min: 0.2,
          max: 8.0,
          step: 0.05,
          default: 1.8,
          tooltip: 'How often each spark cell flares up and dies. Higher = faster flicker.',
        },
        coalBedTurbulence: {
          type: 'slider',
          label: 'Crack / Organic Warp',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.13,
          tooltip: 'Distorts smolder cells and drives glowing crack vein strength. Also modulates wind-breath ripples.',
        },
        coalBedHeatLevels: {
          type: 'slider',
          label: 'Heat Levels',
          min: 2.0,
          max: 16.0,
          step: 1.0,
          default: 12.0,
          tooltip: 'Quantize smolder base only — HDR sparks stay full brightness.',
        },
        coalBedSplatRate: { type: 'slider', label: 'Splat Rate (unused)', min: 0.0, max: 5.0, step: 0.05, default: 0.0, hidden: true },
        coalBedFlareChaos: {
          type: 'slider',
          label: 'Floating Ember Drift',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.85,
          tooltip: 'Upward drift on micro-sparks — embers breaking off and rising toward flames.',
        },
        coalBedMaskLo: {
          type: 'slider',
          label: 'Mask Threshold',
          min: 0.0,
          max: 0.8,
          step: 0.01,
          default: 0.8,
          tooltip: 'Stochastic cutoff after noisy expand — not a soft alpha edge.',
        },
        coalBedMaskExpand: {
          type: 'slider',
          label: 'Mask Expand (texels)',
          min: 0.0,
          max: 4.0,
          step: 0.25,
          default: 0.0,
          tooltip: 'Dilate _Fire mask before thresholding — dissolves hard authored edges.',
        },
        coalBedMaskDither: {
          type: 'slider',
          label: 'Mask Edge Noise',
          min: 0.0,
          max: 0.5,
          step: 0.01,
          default: 0.5,
          tooltip: 'Noisy soften on mask boundary — irregular pixel dissolve, not a dark ring.',
        },
        coalBedMaskHi: { type: 'slider', label: 'Mask Ceiling (unused)', min: 0.5, max: 1.0, step: 0.01, default: 1.0, hidden: true },
        coalBedEdgeSoftness: {
          type: 'slider',
          label: 'Softness (px)',
          min: 0.0,
          max: 32.0,
          step: 0.5,
          default: 3.0,
          tooltip: 'Blurs smolder blocks, spark halos, and mask edges before/during/after composite. Try 8–20 for natural embers; higher dissolves retro hot pixels.',
        },
      }
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    // BatchedRenderers are created per floor in _buildFloorSystems (populate).

    // Start loading sprite textures (populate() will await this).
    this._texturesReady = this._loadTextures();

    this._registerGlowWallHooks();
    this._coalTextureLoader = new THREE.TextureLoader();

    this._initialized = true;
    log.info('FireEffectV2 initialized');
  }

  /**
   * Populate fire systems for all tiles with _Fire masks.
   * Groups spawn points by floor index. Call after FloorRenderBus.populate().
   *
   * @param {object} foundrySceneData - Scene geometry data
   */
  async populate(foundrySceneData) {
    log.info('FireEffectV2.populate() called, initialized=' + this._initialized);
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this._bindPerfRecorder();
    this._lastPopulateSceneData = foundrySceneData ?? this._lastPopulateSceneData;

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const d = canvas?.dimensions;
    if (!d) { log.warn('populate: no canvas dimensions'); return; }

    log.info(`populate: canvas dimensions OK, scene ${d.sceneWidth}x${d.sceneHeight}`);

    const sceneWidth = d.sceneWidth || d.width;
    const sceneHeight = d.sceneHeight || d.height;
    // Foundry scene origin (top-left, Y-down) — used for tile UV → scene UV conversion.
    const foundrySceneX = d.sceneX || 0;
    const foundrySceneY = d.sceneY || 0;
    // Three.js scene origin (Y-up) — used by FireMaskShape to position particles.
    const sceneX = foundrySceneX;
    const sceneY = (d.height || sceneHeight) - foundrySceneY - sceneHeight;

    // Collect fire points per floor from all tiles AND background.
    // Key: floorIndex, Value: {points: Float32Array[]}
    const floorFireData = new Map();

    let _scanToken = this._beginPerfSpan('populate.scan');
    try {
    this.clear();

    // Wait for fire/ember sprite textures to load before creating systems.
    if (this._texturesReady) {
      log.info('Waiting for fire textures to load...');
      await this._texturesReady;
      log.info('Fire textures loaded, continuing populate');
    }

    // ── Process background image(s) (if they have _Fire masks) ────────────────
    // V14: each Level has its own background.src — scene.background.src is not
    // authoritative. Mirror WaterEffectV2: bind each discovered _Fire mask to the
    // FloorStack index for that level so upper-floor views are not stuck with
    // particles at GROUND_Z + 0 under the map.
    const scene = canvas?.scene ?? null;
    const seenBgFireKeys = new Set();

    /**
     * @param {string} bgSrcRaw
     * @param {number} floorIndex
     */
    const ingestBackgroundFire = async (bgSrcRaw, floorIndex) => {
      const bgSrc = typeof bgSrcRaw === 'string' ? bgSrcRaw.trim() : '';
      if (!bgSrc) return;
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;
      const dedupeKey = `${floorIndex}|${bgBasePath}`;
      if (seenBgFireKeys.has(dedupeKey)) return;

      log.info(`populate: checking background _Fire for floor ${floorIndex}, src=${bgSrc}`);
      log.info(`  probing for _Fire mask at: ${bgBasePath}`);
      const fireResult = await probeMaskFile(bgBasePath, '_Fire');
      log.info(`  probeMaskFile result: ${fireResult?.path ?? 'null'}`);
      let image = null;
      if (fireResult?.path) {
        log.info(`  loading image from: ${fireResult.path}`);
        image = await this._loadImage(fireResult.path);
      }
      log.info(`  image loaded: ${image ? `${image.width}x${image.height}` : 'null'}`);
      if (!image) return;

      log.info(`  calling generateFirePoints (mask pickup gates)`);
      const bgAlbedo = bgSrc ? await this._loadImage(bgSrc) : null;
      const bgLocalPoints = this._pickupFireMaskPoints(image, bgAlbedo);
      log.info(`  mask pickup returned: ${bgLocalPoints ? `${bgLocalPoints.length / 3} points` : 'null'}`);
      if (!bgLocalPoints || bgLocalPoints.length === 0) return;

      log.info(`  background _Fire mask: found ${bgLocalPoints.length / 3} points from ${image.width}x${image.height} image`);
      const bgX = foundrySceneX;
      const bgY = foundrySceneY;
      const bgW = sceneWidth;
      const bgH = sceneHeight;

      const sceneGlobalPoints = new Float32Array(bgLocalPoints.length);
      for (let i = 0; i < bgLocalPoints.length; i += 3) {
        const foundryPx = bgX + bgLocalPoints[i] * bgW;
        const foundryPy = bgY + bgLocalPoints[i + 1] * bgH;
        sceneGlobalPoints[i]     = (foundryPx - foundrySceneX) / sceneWidth;
        sceneGlobalPoints[i + 1] = (foundryPy - foundrySceneY) / sceneHeight;
        sceneGlobalPoints[i + 2] = bgLocalPoints[i + 2];
      }

      const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Math.floor(Number(floorIndex))) : 0;
      if (!floorFireData.has(fi)) {
        floorFireData.set(fi, { pointArrays: [] });
      }
      floorFireData.get(fi).pointArrays.push(sceneGlobalPoints);
      seenBgFireKeys.add(dedupeKey);
      log.info(`  background → floor ${fi}, ${sceneGlobalPoints.length / 3} fire points (scene ${bgW}x${bgH})`);
    };

    if (hasV14NativeLevels(scene) && floors.length > 0) {
      for (const f of floors) {
        const lid = f?.levelId;
        if (typeof lid !== 'string' || !lid.length) continue;
        let bgSrc = '';
        try {
          const lvl = scene.levels?.get?.(lid);
          bgSrc = String(lvl?.background?.src || '').trim();
        } catch (_) {}
        if (!bgSrc) continue;
        await ingestBackgroundFire(bgSrc, f.index);
      }
    }
    // Always also probe the viewed-level background on the active floor index.
    // Covers bands without levelId on FloorStack, init races, and dedupes when
    // the same file was already ingested for that floor in the loop above.
    {
      const fallbackSrc = getViewedLevelBackgroundSrc(scene)
        ?? canvas?.scene?.background?.src
        ?? '';
      const activeFi = window.MapShine?.floorStack?.getActiveFloor?.();
      const fi = (floors.length > 1 && Number.isFinite(Number(activeFi?.index)))
        ? Number(activeFi.index)
        : 0;
      await ingestBackgroundFire(String(fallbackSrc || ''), fi);
    }

    // ── Process tiles ─────────────────────────────────────────────────────────
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];

    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      let image = null;
      const fireResult = await probeMaskFile(basePath, '_Fire');
      if (fireResult?.path) {
        image = await this._loadImage(fireResult.path);
      }
      // probeMaskFile already checked all formats and cached the result.
      // No need for fallback GET probing - it just causes 404 spam.
      if (!image) continue;

      const tileAlbedo = await this._loadImage(src);
      const tileLocalPoints = this._pickupFireMaskPoints(image, tileAlbedo);
      if (!tileLocalPoints || tileLocalPoints.length === 0) continue;

      // Convert tile-local UVs → scene-global UVs.
      // generateFirePoints returns (u, v, brightness) in tile image space [0..1].
      // Foundry v14+: TileDocument x/y is the texture anchor, not the top-left corner
      // (RectangleShapeData: rect origin is x - anchorX*width, y - anchorY*height).
      // Offset UVs relative to anchor, then apply rotation around that origin.
      const tileX = Number(tileDoc.x) || 0;
      const tileY = Number(tileDoc.y) || 0;
      const tileW = Number(tileDoc.width) || 1;
      const tileH = Number(tileDoc.height) || 1;
      const anchorX = Number(tileDoc.texture?.anchorX ?? tileDoc.shape?.anchorX ?? 0);
      const anchorY = Number(tileDoc.texture?.anchorY ?? tileDoc.shape?.anchorY ?? 0);
      const rotDeg = Number(tileDoc.rotation) || 0;
      const rot = (rotDeg * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);

      const sceneGlobalPoints = new Float32Array(tileLocalPoints.length);
      for (let i = 0; i < tileLocalPoints.length; i += 3) {
        const u = tileLocalPoints[i];
        const v = tileLocalPoints[i + 1];
        const du = (u - anchorX) * tileW;
        const dv = (v - anchorY) * tileH;
        const foundryPx = tileX + du * cos - dv * sin;
        const foundryPy = tileY + du * sin + dv * cos;
        sceneGlobalPoints[i]     = (foundryPx - foundrySceneX) / sceneWidth;
        sceneGlobalPoints[i + 1] = (foundryPy - foundrySceneY) / sceneHeight;
        sceneGlobalPoints[i + 2] = tileLocalPoints[i + 2]; // brightness unchanged
      }

      // Resolve floor index.
      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      if (!floorFireData.has(floorIndex)) {
        floorFireData.set(floorIndex, { pointArrays: [] });
      }
      floorFireData.get(floorIndex).pointArrays.push(sceneGlobalPoints);
      log.info(`  tile '${tileId}' → floor ${floorIndex}, ${sceneGlobalPoints.length / 3} fire points (tile ${tileW}x${tileH} at ${tileX},${tileY})`);
    }
    } finally {
      this._endPerfSpan(_scanToken);
    }

    let _buildToken = this._beginPerfSpan('populate.build');
    try {
    // Build particle systems per floor.
    this._glowSceneContext = {
      sceneWidth,
      sceneHeight,
      sceneX,
      sceneY,
      foundrySceneX,
      foundrySceneY,
      sceneBounds: buildEffectSceneBoundsFromCanvas(),
    };

    let totalSystems = 0;
    for (const [floorIndex, { pointArrays }] of floorFireData) {
      // Merge all point arrays for this floor into one.
      const totalLen = pointArrays.reduce((sum, arr) => sum + arr.length, 0);
      const merged = new Float32Array(totalLen);
      let offset = 0;
      for (const arr of pointArrays) {
        merged.set(arr, offset);
        offset += arr.length;
      }

      const state = this._buildFloorSystems(
        merged, sceneWidth, sceneHeight, sceneX, sceneY, floorIndex
      );
      this._floorStates.set(floorIndex, state);
      this._glowSourcePointsByFloor.set(floorIndex, merged);
      this._buildGlowClustersForFloor(floorIndex, merged, sceneWidth, sceneHeight, sceneX, sceneY);
      totalSystems += state.systems.length + state.emberSystems.length + state.smokeSystems.length;
      if (state.batchRenderer) {
        const key = `${FIRE_BATCH_OVERLAY_PREFIX}${floorIndex}`;
        this._renderBus.addEffectOverlay(
          key,
          state.batchRenderer,
          floorIndex,
          { overlayRole: 'stackedFloorEffect' }
        );
        log.info(`FireEffectV2: ${key} added to bus (floor ${floorIndex}), parent=${state.batchRenderer.parent?.type}`);
      }
    }

    // Activate the current floor's systems.
    this._activateCurrentFloor();

    this._rebuildAllFloorGlowMeshes();
    this._invalidateGlowParamCache();
    const maxFi = this._activeFloors.size ? Math.max(...this._activeFloors) : 0;
    this._applyGlowFloorVisibility(maxFi);

    log.info(`FireEffectV2 populated: ${floorFireData.size} floor(s), ${totalSystems} system(s), floorStates keys=[${[...this._floorStates.keys()]}]`);
    
    // Diagnostic: log first few fire points to verify they're in valid world space
    if (floorFireData.size > 0) {
      const firstFloor = floorFireData.entries().next().value;
      if (firstFloor && firstFloor[1]?.pointArrays?.[0]) {
        const pts = firstFloor[1].pointArrays[0];
        log.info(`  First 3 fire points (u,v,brightness): [${pts.slice(0,9).join(', ')}]`);
      }
    }

    this._structuralSignature = this._computeStructuralSignature();

    await this._populateCoalOverlays(foundrySceneData);
    } finally {
      this._endPerfSpan(_buildToken);
    }
    try { refreshEffectMaskStatusUi('fire-sparks'); } catch (_) {}
  }

  /**
   * After a tile's `texture.src` changes, fire spawn points for that tile must be
   * recomputed from the new `_Fire` mask. Because particles are merged per floor
   * (one BatchedRenderer per floor), this triggers a full {@link populate} via
   * {@link _queueRebuild} so all tiles are rescanned — same pattern as param-driven rebuilds.
   *
   * @param {object} _tileDoc
   * @param {object|null} foundrySceneData
   */
  async refreshTileAfterTextureChange(_tileDoc, foundrySceneData) {
    if (!this._initialized) return;
    void _tileDoc;

    if (foundrySceneData && typeof foundrySceneData === 'object') {
      this._lastPopulateSceneData = foundrySceneData;
    } else if (!this._lastPopulateSceneData) {
      const d = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
      if (!d) return;
      this._lastPopulateSceneData = {
        height: d.height,
        width: d.width,
        sceneWidth: d.sceneWidth ?? d.width,
        sceneHeight: d.sceneHeight ?? d.height,
        sceneX: d.sceneX ?? 0,
        sceneY: d.sceneY ?? 0,
      };
    }

    this._queueRebuild();
  }

  // ── Performance Recorder ───────────────────────────────────────────────────

  /** @private */
  _bindPerfRecorder() {
    try {
      const recorder = window.MapShine?.performanceRecorder;
      this._activePerfRecorder = recorder?.enabled ? recorder : null;
    } catch (_) {
      this._activePerfRecorder = null;
    }
  }

  /** @private */
  _beginPerfSpan(name, phase = 'update', options = { cpuOnly: true }) {
    try {
      const recorder = this._activePerfRecorder;
      if (!recorder?.enabled || typeof recorder.beginEffectCall !== 'function') return null;
      return recorder.beginEffectCall(`fire.${phase}.${name}`, phase, options);
    } catch (_) {
      return null;
    }
  }

  /** @param {object|null} token @private */
  _endPerfSpan(token) {
    if (!token) return;
    try {
      const recorder = this._activePerfRecorder ?? window.MapShine?.performanceRecorder;
      recorder?.endEffectCall?.(token);
    } catch (_) {}
  }

  /** Pre-warm per-floor _Outdoors CPU snapshots for drift containment sampling. @private */
  _syncActiveFloorOutdoorsMasks() {
    const token = this._outdoorsMaskFrameToken ?? 0;
    const levelContext = window.MapShine?.activeLevelContext ?? null;
    for (const floorIndex of this._activeFloors) {
      try {
        syncSharedOutdoorsMaskForFloor(floorIndex, token, levelContext);
      } catch (_) {}
    }
  }

  /**
   * Per-frame update. Steps the BatchedRenderer simulation.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._enabled) return;

    this._bindPerfRecorder();
    this._sceneBounds = buildEffectSceneBoundsFromCanvas();
    if (this._glowSceneContext) {
      this._glowSceneContext.sceneBounds = this._sceneBounds;
    }

    // Coal bed time — always advance when the effect is enabled (even with no particle floors).
    this._syncCoalBedOverlays(timeInfo?.elapsed ?? 0);

    try {
      if (window.MapShine?.__v2NavigationLiteUpdates === true) return;
    } catch (_) {}

    // Compute dt for three.quarks (matches V1 time scaling).
    const deltaSec = typeof timeInfo?.motionDelta === 'number'
      ? timeInfo.motionDelta
      : (typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016);
    const clampedDelta = Math.min(deltaSec, 0.1);
    const simSpeed = (weatherController && typeof weatherController.simulationSpeed === 'number')
      ? weatherController.simulationSpeed : 2.0;

    if (this._activeFloors.size === 0) return;

    this._syncActiveFloorOutdoorsMasks();

    const paramsToken = this._beginPerfSpan('systemParams');
    try {
      this._updateSystemParams();
    } finally {
      this._endPerfSpan(paramsToken);
    }

    const attachToken = this._beginPerfSpan('glow.attach');
    try {
      this._tryAttachGlowRoot();
    } finally {
      this._endPerfSpan(attachToken);
    }

    if (this._needsGlowRebuild && (timeInfo.elapsed - this._lastGlowRebuildAt) > 0.12) {
      const rebuildToken = this._beginPerfSpan('glow.rebuild');
      try {
        this._rebuildAllFloorGlowMeshes();
        this._needsGlowRebuild = false;
        this._lastGlowRebuildAt = timeInfo.elapsed;
        this._invalidateGlowParamCache();
      } finally {
        this._endPerfSpan(rebuildToken);
      }
    }

    const flickerToken = this._beginPerfSpan('glow.flicker');
    try {
      this._updateFireGlowFlicker(timeInfo);
    } finally {
      this._endPerfSpan(flickerToken);
    }

    const frameId = Number(timeInfo?.frameCount);
    if (Number.isFinite(frameId) && frameId !== this._fireUpdateFrameId) {
      this._fireUpdateFrameId = frameId;
      this._firePhysicsDoneThisFrame = false;
    }

    const simHz = this._resolveEffectiveSimHz(timeInfo);
    const ageRate = 0.001 * 750 * simSpeed;
    const simStepSec = 1 / simHz;
    this._lastFireSimStepSec = simStepSec;
    const useNativeTimestep = simHz >= 60;

    if (useNativeTimestep) {
      this._simAccumSec = 0;
      if (!this._firePhysicsDoneThisFrame) {
        this._firePhysicsDoneThisFrame = true;
        this._runFirePhysicsAndVisuals(clampedDelta * ageRate, ageRate, true, timeInfo);
      }
    } else {
      this._simAccumSec += clampedDelta;

      if (this._simAccumSec > simStepSec * 2) {
        this._simAccumSec = simStepSec;
      }

      const runPhysics = !this._firePhysicsDoneThisFrame && this._simAccumSec >= simStepSec;
      if (runPhysics) {
        this._simAccumSec -= simStepSec;
        this._firePhysicsDoneThisFrame = true;
        this._runFirePhysicsAndVisuals(simStepSec * ageRate, ageRate, true, timeInfo);
      } else {
        const visualToken = this._beginPerfSpan('visualRefresh');
        try {
          for (const floorIndex of this._activeFloors) {
            const st = this._floorStates.get(floorIndex);
            if (!st?.batchRenderer) continue;
            try {
              this._refreshFireVisuals(st.batchRenderer, this._simAccumSec, ageRate);
            } catch (err) {
              log.warn('FireEffectV2: visual refresh threw, skipping frame:', err);
            }
          }
        } finally {
          this._endPerfSpan(visualToken);
        }
      }
    }
  }

  /**
   * Cap CPU physics rate to the compositor presentation tier so navigation at 30 Hz
   * does not still run 60 Hz particle integration.
   * @param {{ targetFps?: number }|null|undefined} timeInfo
   * @returns {number}
   * @private
   */
  _resolveEffectiveSimHz(timeInfo) {
    const userHz = Math.max(8, Math.min(FIRE_MAX_SIM_HZ, Number(this.params.fireSimHz) || FIRE_DEFAULT_SIM_HZ));
    let capHz = userHz;
    const targetFps = Number(timeInfo?.targetFps);
    if (Number.isFinite(targetFps) && targetFps >= 8 && targetFps < capHz) {
      capHz = Math.max(8, Math.floor(targetFps));
    }
    // Multi-floor fire is stepped on a rotating floor index; cap sim Hz to the
    // presentation FPS budget so CPU stays near what the compositor actually sustains.
    if (capHz > 30 && this._activeFloors.size > 1) {
      try {
        const presentationFps = Number(window.MapShine?.renderPresentationFps);
        if (Number.isFinite(presentationFps) && presentationFps >= 8 && presentationFps < capHz) {
          capHz = Math.max(8, Math.floor(presentationFps));
        }
      } catch (_) {}
    }
    return capHz;
  }

  /**
   * When several floors have glow pools, update one floor per frame (like physics rotation).
   * @returns {number[]}
   * @private
   */
  _getGlowFlickerFloorsThisFrame() {
    const floors = [...this._activeFloors]
      .filter((idx) => (this._glowBucketsByFloor.get(idx)?.size ?? 0) > 0)
      .sort((a, b) => a - b);
    if (floors.length <= 1) return floors;
    this._glowFlickerFloorCursor = (this._glowFlickerFloorCursor + 1) % floors.length;
    return [floors[this._glowFlickerFloorCursor]];
  }

  /**
   * When multiple floors are active, rotate which floor receives physics each step
   * so spike cost stays bounded; visuals still refresh every floor every frame.
   * @returns {number[]}
   * @private
   */
  _getPhysicsFloorsThisFrame() {
    const floors = [...this._activeFloors].sort((a, b) => a - b);
    if (floors.length <= 1) return floors;
    this._physicsFloorCursor = (this._physicsFloorCursor + 1) % floors.length;
    return [floors[this._physicsFloorCursor]];
  }

  /**
   * @param {number} simDt
   * @param {number} ageRate
   * @param {boolean} afterPhysics
   * @param {{ elapsed?: number }} timeInfo
   * @private
   */
  _runFirePhysicsAndVisuals(simDt, ageRate, afterPhysics, timeInfo) {
    const physicsFloors = this._getPhysicsFloorsThisFrame();
    const physicsSet = new Set(physicsFloors);
    const elapsed = Number(timeInfo?.elapsed) || 0;

    const physicsToken = this._beginPerfSpan('physics');
    try {
      for (const floorIndex of physicsFloors) {
        const st = this._floorStates.get(floorIndex);
        if (!st?.batchRenderer) continue;
        try {
          this._stepFirePhysicsSim(st.batchRenderer, simDt);
          this._syncFloorParticleOutdoorState(st.batchRenderer, floorIndex);
          if (Number.isFinite(elapsed)) this._floorLastPhysicsAt.set(floorIndex, elapsed);
        } catch (err) {
          log.warn('FireEffectV2: physics sim threw:', err);
        }
      }
    } finally {
      this._endPerfSpan(physicsToken);
    }

    const visualToken = this._beginPerfSpan('visualRefresh');
    try {
      for (const floorIndex of this._activeFloors) {
        const st = this._floorStates.get(floorIndex);
        if (!st?.batchRenderer) continue;
        try {
          if (physicsSet.has(floorIndex)) {
            this._refreshFireVisuals(st.batchRenderer, 0, ageRate, afterPhysics);
          } else {
            const lastAt = this._floorLastPhysicsAt.get(floorIndex);
            const subSec = Number.isFinite(lastAt) && elapsed > lastAt ? elapsed - lastAt : 0;
            this._refreshFireVisuals(st.batchRenderer, subSec, ageRate, false);
          }
        } catch (err) {
          log.warn('FireEffectV2: visual refresh threw, skipping frame:', err);
        }
      }
    } finally {
      this._endPerfSpan(visualToken);
    }
  }

  /**
   * Step particle physics only (no GPU instance upload). Visual behaviors are
   * deferred via `system._msDeferVisualToRefresh` and `_refreshFireVisuals()`.
   * @param {import('../../libs/three.quarks.module.js').BatchedRenderer} batchRenderer
   * @param {number} simDt
   * @private
   */
  _stepFirePhysicsSim(batchRenderer, simDt) {
    const simToken = this._beginPerfSpan('physics.sim');
    try {
      batchRenderer.systemToBatchIndex.forEach((_, ps) => {
        ps._msDeferVisualToRefresh = true;
        ps.update(simDt);
        if (!ps.userData?.isSmoke) return;
        const particles = ps.particles;
        const pNum = ps.particleNum;
        for (let i = 0; i < pNum; i++) {
          const particle = particles[i];
          if (particle.died) continue;
          applyFireShelterMaskToParticle(particle, ps, 0.35);
        }
      });
    } finally {
      this._endPerfSpan(simToken);
    }
  }

  /**
   * One 5-tap outdoors footprint + shelter mask per particle after physics (matches post-step positions).
   * Wind during ps.update() uses the previous frame's cached footprint.
   * @param {import('../../libs/three.quarks.module.js').BatchedRenderer} batchRenderer
   * @param {number} floorIndex
   * @private
   */
  /**
   * @param {number} floorIndex
   * @returns {object|null}
   * @private
   */
  _resolveOutdoorSnapForFloor(floorIndex) {
    const token = this._outdoorsMaskFrameToken ?? 0;
    const levelContext = window.MapShine?.activeLevelContext ?? null;
    try {
      return syncSharedOutdoorsMaskForFloor(floorIndex, token, levelContext);
    } catch (_) {
      return null;
    }
  }

  _syncFloorParticleOutdoorState(batchRenderer, floorIndex) {
    const syncToken = this._beginPerfSpan('outdoorSync');
    try {
      const snap = this._resolveOutdoorSnapForFloor(floorIndex);
      const sceneBounds = this._sceneBounds ?? buildEffectSceneBoundsFromCanvas();

      batchRenderer.systemToBatchIndex.forEach((_, ps) => {
        const particles = ps.particles;
        const pNum = ps.particleNum;
        const isSmoke = !!ps.userData?.isSmoke;
        for (let i = 0; i < pNum; i++) {
          const particle = particles[i];
          if (particle.died) continue;
          if (isSmoke) {
            cacheFireParticleOutdoorFootprintForWind(particle, this, snap, sceneBounds, ps, { tapCount: 9 });
          } else {
            syncFireParticleOutdoorFootprint(particle, ps, this, snap, sceneBounds, {
              tapCount: 5,
              smoothRate: 0.32,
            });
          }
        }
      });
    } finally {
      this._endPerfSpan(syncToken);
    }
  }

  /**
   * Upload instanced particle buffers to the GPU (single pass per frame).
   * @param {import('../../libs/three.quarks.module.js').BatchedRenderer} batchRenderer
   * @private
   */
  _uploadFireBatchBuffers(batchRenderer) {
    const uploadToken = this._beginPerfSpan('visualRefresh.upload');
    try {
      for (let i = 0; i < batchRenderer.batches.length; i++) {
        batchRenderer.batches[i].update();
      }
    } finally {
      this._endPerfSpan(uploadToken);
    }
  }

  /** @param {import('../../libs/three.quarks.module.js').ParticleSystem} system @private */
  _finalizeFireParticleSystem(system) {
    deferVisualBehaviorsOnSystem(system, FIRE_VISUAL_BEHAVIOR_TYPES);
  }

  /**
   * Extrapolate flipbook / lifecycle visuals between physics steps.
   * @param {import('../../libs/three.quarks.module.js').BatchedRenderer} batchRenderer
   * @param {number} subFrameSec Real seconds since the last physics step.
   * @param {number} ageRate Quarks age units per real second.
   * @param {boolean} [afterPhysics=false] When true, re-run visual behaviors at the
   *   post-physics display age (no extrapolation). Keeps atlas frames in sync after
   *   the physics step, which evaluates behaviors before age += delta.
   * @private
   */
  _refreshFireVisuals(batchRenderer, subFrameSec, ageRate, afterPhysics = false) {
    if (!afterPhysics) {
      if (!Number.isFinite(subFrameSec) || subFrameSec <= 0) {
        this._uploadFireBatchBuffers(batchRenderer);
        return;
      }
    }
    const simStepSec = Number.isFinite(this._lastFireSimStepSec) && this._lastFireSimStepSec > 0
      ? this._lastFireSimStepSec
      : 0;
    const stepAgeCap = simStepSec > 0 ? simStepSec * ageRate : 0;

    batchRenderer.systemToBatchIndex.forEach((_, ps) => {
      if (ps.paused) return;

      ps._msDeferVisualToRefresh = false;

      const particles = ps.particles;
      const pNum = ps.particleNum;
      const isSmoke = !!ps.userData?.isSmoke;

      if (afterPhysics) {
        for (let i = 0; i < pNum; i++) {
          particles[i]._msDisplayAge = particles[i].age;
        }
      } else if (Number.isFinite(subFrameSec) && subFrameSec > 0) {
        const extrapSec = isSmoke && stepAgeCap > 0
          ? Math.min(subFrameSec, simStepSec)
          : subFrameSec;
        const extrapolate = extrapSec * ageRate;
        if (extrapolate > 0) {
          for (let i = 0; i < pNum; i++) {
            const particle = particles[i];
            const ts = particle._msTimeScaleFactor;
            const timeFactor = ts !== undefined ? (ts > 0 ? ts : 0) : 1;
            particle._msDisplayAge = particle.age + extrapolate * timeFactor;
          }
        }
      }

      if (isSmoke) {
        if (afterPhysics) {
          for (let i = 0; i < pNum; i++) {
            const particle = particles[i];
            if (particle.died) continue;
            applyFireShelterMaskToParticle(particle, ps, 0.32);
          }
        } else {
          for (let i = 0; i < pNum; i++) {
            const particle = particles[i];
            if (particle.died) continue;
            smoothFireParticleShelterMaskOnly(particle, 0.22);
          }
        }
      } else if (ps.userData?.isEmber && (afterPhysics || (Number.isFinite(subFrameSec) && subFrameSec > 0))) {
        const emberSmoothRate = afterPhysics ? 0.2 : 0.18;
        for (let i = 0; i < pNum; i++) {
          const particle = particles[i];
          if (particle.died) continue;
          smoothFireParticleShelterMaskOnly(particle, emberSmoothRate);
        }
      }

      for (let j = 0; j < ps.behaviors.length; j++) {
        const beh = ps.behaviors[j];
        if (!FIRE_VISUAL_BEHAVIOR_TYPES.has(beh.type)) continue;
        if ((beh.type === 'SmokeShapeFrameBehavior' || beh.type === 'FlameShapeFrameBehavior') &&
            typeof beh.frameUpdate === 'function') {
          beh.frameUpdate(0);
        }
        const isSizeOverLife = beh.type === 'SizeOverLife';
        const hasSystemParam = typeof beh.update === 'function' && beh.update.length >= 3;
        for (let i = 0; i < pNum; i++) {
          const particle = particles[i];
          if (particle.died) continue;
          if (isSizeOverLife) {
            const savedAge = particle.age;
            particle.age = particle._msDisplayAge;
            beh.update(particle);
            particle.age = savedAge;
          } else if (hasSystemParam) {
            beh.update(particle, 0, ps);
          } else {
            beh.update(particle, 0);
          }
        }
      }
    });

    this._uploadFireBatchBuffers(batchRenderer);
  }

  /**
   * Called when the visible floor range changes. Activates all floors up to
   * maxFloorIndex (matching the bus's setVisibleFloors behaviour).
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;

    // Re-anchor fire draw order to the currently visible floor band so particles
    // render below overhead tiles instead of globally on top of all tile layers.
    this._updateBatchRenderOrder(maxFloorIndex);

    // Determine which floors should be active.
    const desired = new Set();
    for (const idx of this._floorStates.keys()) {
      if (idx <= maxFloorIndex) desired.add(idx);
    }

    // Deactivate floors that should no longer be visible.
    for (const idx of this._activeFloors) {
      if (!desired.has(idx)) this._deactivateFloor(idx);
    }
    // Activate floors that are newly visible.
    for (const idx of desired) {
      if (!this._activeFloors.has(idx)) this._activateFloor(idx);
    }

    log.info(`onFloorChange(${maxFloorIndex}): desired=[${[...desired]}] prev=[${[...this._activeFloors]}] states=[${[...this._floorStates.keys()]}]`);
    this._activeFloors = desired;
    this._systemParamsSignature = '';
    this._applyGlowFloorVisibility(maxFloorIndex);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  clear() {
    // Deactivate all active floors.
    for (const idx of this._activeFloors) {
      this._deactivateFloor(idx);
    }
    this._activeFloors.clear();

    const floorIds = [...this._floorStates.keys()];
    for (const f of floorIds) {
      this._renderBus.removeEffectOverlay(`${FIRE_BATCH_OVERLAY_PREFIX}${f}`);
    }
    for (const [, state] of this._floorStates) {
      this._disposeFloorState(state);
    }
    this._floorStates.clear();

    this._clearAllGlow();
    this._glowClustersByFloor.clear();
    this._glowSourcePointsByFloor.clear();
    this._invalidateHeatDistortionMask();

    this._structuralSignature = '';
    this._systemParamsSignature = '';
    this._simAccumSec = 0;
    this._lastFireSimStepSec = 1 / FIRE_DEFAULT_SIM_HZ;
    this._fireUpdateFrameId = -1;
    this._firePhysicsDoneThisFrame = false;
    this._floorLastPhysicsAt.clear();
    this._invalidateGlowParamCache();
    this._clearCoalOverlays();
    try { refreshEffectMaskStatusUi('fire-sparks'); } catch (_) {}
  }

  dispose() {
    this.clear();
    this._unregisterGlowWallHooks();
    this._fireTexture?.dispose();
    this._emberTexture?.dispose();
    this._smokeTexture?.dispose();
    this._fireTexture = null;
    this._emberTexture = null;
    this._smokeTexture = null;
    try { this._heatDistortionMaskTex?.dispose?.(); } catch (_) {}
    this._heatDistortionMaskTex = null;
    this._heatDistortionMaskData = null;
    this._heatDistortionMaskSig = '';
    this._initialized = false;
    this._lightingEffect = null;
    this._coalTextureLoader = null;
    log.info('FireEffectV2 disposed');
  }

  // ── Private: Coal bed substrate overlays ───────────────────────────────────

  /** @private */
  _coalBedOverlayKey(tileId) {
    return `${tileId}${FIRE_COAL_BED_OVERLAY_SUFFIX}`;
  }

  /** @private */
  _clearCoalOverlays() {
    for (const [tileId] of this._coalOverlays) {
      this._renderBus.removeEffectOverlay(this._coalBedOverlayKey(tileId));
    }
    for (const [, entry] of this._coalOverlays) {
      try { entry.material?.dispose?.(); } catch (_) {}
      try { entry.mesh?.geometry?.dispose?.(); } catch (_) {}
      try {
        const tex = entry.material?.uniforms?.uFireMask?.value;
        tex?.dispose?.();
      } catch (_) {}
    }
    this._coalOverlays.clear();
    this._coalBedParamSignature = '';
  }

  /**
   * Build per-tile coal-bed overlays for every discovered `_Fire` mask.
   * @param {object} foundrySceneData
   * @private
   */
  async _populateCoalOverlays(foundrySceneData) {
    if (!this._initialized || !this._coalTextureLoader) return;
    this._clearCoalOverlays();

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const d = canvas?.dimensions;
    const worldH = foundrySceneData?.height ?? d?.height ?? 0;
    const sceneWidth = foundrySceneData?.sceneWidth ?? d?.sceneWidth ?? d?.width ?? 0;
    const sceneHeight = foundrySceneData?.sceneHeight ?? d?.sceneHeight ?? d?.height ?? 0;
    const sceneX = foundrySceneData?.sceneX ?? d?.sceneX ?? 0;
    const sceneY = foundrySceneData?.sceneY ?? d?.sceneY ?? 0;
    const scene = canvas?.scene ?? null;
    const seenBgKeys = new Set();

    const ingestBackgroundCoal = async (bgSrcRaw, floorIndex) => {
      const bgSrc = typeof bgSrcRaw === 'string' ? bgSrcRaw.trim() : '';
      if (!bgSrc) return;
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;
      const dedupeKey = `${floorIndex}|${bgBasePath}`;
      if (seenBgKeys.has(dedupeKey)) return;

      const fireResult = await probeMaskFile(bgBasePath, '_Fire');
      if (!fireResult?.path) return;

      const tileId = `__bg_fire_${floorIndex}__`;
      const centerX = sceneX + sceneWidth / 2;
      const centerY = worldH - (sceneY + sceneHeight / 2);
      const z = GROUND_Z + floorIndex + COAL_BED_Z_OFFSET;

      this._createCoalOverlay(tileId, floorIndex, {
        maskUrl: fireResult.path,
        centerX,
        centerY,
        z,
        tileW: sceneWidth,
        tileH: sceneHeight,
        rotation: 0,
        busTileId: '__bg_image__',
      });
      seenBgKeys.add(dedupeKey);
    };

    if (hasV14NativeLevels(scene) && floors.length > 0) {
      for (const f of floors) {
        const lid = f?.levelId;
        if (typeof lid !== 'string' || !lid.length) continue;
        let bgSrc = '';
        try {
          const lvl = scene.levels?.get?.(lid);
          bgSrc = String(lvl?.background?.src || '').trim();
        } catch (_) {}
        if (!bgSrc) continue;
        await ingestBackgroundCoal(bgSrc, f.index);
      }
    }
    {
      const fallbackSrc = getViewedLevelBackgroundSrc(scene)
        ?? canvas?.scene?.background?.src
        ?? '';
      const activeFi = window.MapShine?.floorStack?.getActiveFloor?.();
      const fi = (floors.length > 1 && Number.isFinite(Number(activeFi?.index)))
        ? Number(activeFi.index)
        : 0;
      await ingestBackgroundCoal(String(fallbackSrc || ''), fi);
    }

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;
      const fireResult = await probeMaskFile(basePath, '_Fire');
      if (!fireResult?.path) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const tileW = Number(tileDoc.width) || 1;
      const tileH = Number(tileDoc.height) || 1;
      const centerX = (Number(tileDoc.x) || 0) + tileW / 2;
      const centerY = worldH - ((Number(tileDoc.y) || 0) + tileH / 2);
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180
        : 0;
      const z = GROUND_Z + floorIndex + COAL_BED_Z_OFFSET;

      this._createCoalOverlay(tileId, floorIndex, {
        maskUrl: fireResult.path,
        centerX,
        centerY,
        z,
        tileW,
        tileH,
        rotation,
        busTileId: tileId,
      });
    }

    this._syncCoalBedOverlays();
    log.info(`FireEffectV2: coal bed overlays populated (${this._coalOverlays.size})`);
  }

  /**
   * @param {string} tileId
   * @param {number} floorIndex
   * @param {object} opts
   * @private
   */
  _createCoalOverlay(tileId, floorIndex, opts) {
    const THREE = window.THREE;
    if (!THREE) return;

    const {
      maskUrl,
      centerX,
      centerY,
      z,
      tileW,
      tileH,
      rotation,
      busTileId = tileId,
    } = opts;

    const baseEntry = this._renderBus?._tiles?.get?.(busTileId);
    const canAttachToTileRoot = !!baseEntry && !String(busTileId).startsWith('__');

    const material = createCoalBedMaterial(THREE, this.params);
    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `FireCoalBedV2_${tileId}`;
    mesh.frustumCulled = false;

    if (canAttachToTileRoot) {
      mesh.position.set(0, 0, COAL_BED_Z_OFFSET);
      mesh.rotation.z = 0;
    } else {
      mesh.position.set(centerX, centerY, z);
      mesh.rotation.z = rotation;
    }

    try {
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      if (Number.isFinite(baseOrder)) {
        mesh.renderOrder = tileStackedOverlayOrder(baseOrder, floorIndex, COAL_BED_STACK_DELTA);
      } else {
        mesh.renderOrder = effectUnderOverheadOrder(floorIndex, 0) - 1;
      }
    } catch (_) {
      mesh.renderOrder = effectUnderOverheadOrder(floorIndex, 0) - 1;
    }

    const worldScale = material.uniforms?.uOverlayPixelSize?.value;
    if (worldScale) {
      syncCoalBedOverlayPixelSize(material, tileW, tileH);
    }

    const overlayKey = this._coalBedOverlayKey(tileId);
    let attached = false;
    if (canAttachToTileRoot && typeof this._renderBus?.addTileAttachedOverlay === 'function') {
      attached = this._renderBus.addTileAttachedOverlay(busTileId, overlayKey, mesh, floorIndex) === true;
    }
    if (!attached) {
      this._renderBus.addEffectOverlay(overlayKey, mesh, floorIndex);
      if (!String(busTileId).startsWith('__')) {
        try {
          const busEntry = this._renderBus?._tiles?.get?.(overlayKey);
          if (busEntry) busEntry.attachedToTileId = busTileId;
        } catch (_) {}
      }
    }

    this._coalOverlays.set(tileId, { mesh, material, floorIndex });

    const targetMaterial = material;
    this._coalTextureLoader.load(maskUrl, (tex) => {
      const entry = this._coalOverlays.get(tileId);
      if (!entry || entry.material !== targetMaterial) {
        tex.dispose();
        return;
      }
      tex.flipY = true;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;

      const uMask = targetMaterial.uniforms?.uFireMask;
      if (!uMask) {
        tex.dispose();
        return;
      }
      const previousTex = uMask.value;
      uMask.value = tex;
      if (previousTex && previousTex !== tex) {
        try { previousTex.dispose(); } catch (_) {}
      }

      const w = tex.image?.width || 512;
      const h = tex.image?.height || 512;
      syncCoalBedMaskTexelSize(targetMaterial, w, h);
      syncCoalBedOverlayPixelSize(targetMaterial, tileW, tileH);
    }, undefined, (err) => {
      log.warn(`FireEffectV2: failed to load coal-bed mask for ${tileId}: ${maskUrl}`, err);
    });
  }

  /** @private */
  _getCoalBedParamSignature() {
    const p = this.params ?? {};
    return [
      p.coalBedEnabled,
      p.coalBedIntensity,
      p.coalBedOpacity,
      p.coalBedPreset,
      p.coalBedChunkScale,
      p.coalBedChunkContrast,
      p.coalBedChunkAspect,
      p.coalBedGrainScale,
      p.coalBedGrainAngle,
      p.coalBedColorChar,
      p.coalBedColorHot,
      p.coalBedColorWarm,
      p.coalBedColorAshWarm,
      p.coalBedColorAshCool,
      p.coalBedSaturation,
      p.coalBedContrast,
      p.coalBedRimStrength,
      p.coalBedEmissiveGain,
      p.coalBedFlareDensity,
      p.coalBedBandCharEnd,
      p.coalBedBandHotEnd,
      p.coalBedBandWarmEnd,
      p.coalBedBandAshWarmEnd,
      p.coalBedEvolveSpeed,
      p.coalBedPulseSpeed,
      p.coalBedHeatLevels,
      p.coalBedTurbulence,
      p.coalBedFlareChaos,
      p.coalBedMaskLo,
      p.coalBedMaskExpand,
      p.coalBedMaskDither,
      p.coalBedEdgeSoftness,
      this._enabled,
    ].join('|');
  }

  /**
   * Sync coal-bed visibility and shader uniforms.
   * @param {number} [elapsed]
   * @private
   */
  _syncCoalBedOverlays(elapsed) {
    const visible = resolveEffectEnabled(this) && this.params?.coalBedEnabled !== false;
    const signature = this._getCoalBedParamSignature();
    const paramsDirty = signature !== this._coalBedParamSignature;
    if (paramsDirty) this._coalBedParamSignature = signature;

    for (const [, entry] of this._coalOverlays) {
      const mesh = entry?.mesh;
      const material = entry?.material;
      if (!mesh || !material) continue;
      mesh.visible = visible;
      if (paramsDirty) {
        syncCoalBedUniforms(material, this.params, { effectEnabled: resolveEffectEnabled(this) });
        applyCoalBedBlending(material, window.THREE);
      }
      if (typeof elapsed === 'number' && material.uniforms?.uTime) {
        material.uniforms.uTime.value = elapsed;
      }
    }
  }

  // ── Private: Fire glow (HDR darkness cancel via LightMesh) ─────────────────

  _registerGlowWallHooks() {
    const safeOn = (hook, fn) => {
      try {
        const id = Hooks.on(hook, fn);
        this._glowHookIds.push([hook, id]);
      } catch (_) {}
    };
    const onWallChanged = () => { this._needsGlowRebuild = true; };
    safeOn('createWall', onWallChanged);
    safeOn('updateWall', onWallChanged);
    safeOn('deleteWall', onWallChanged);
  }

  _unregisterGlowWallHooks() {
    for (const [hook, id] of this._glowHookIds) {
      try { Hooks.off(hook, id); } catch (_) {}
    }
    this._glowHookIds.length = 0;
  }

  _tryAttachGlowRoot() {
    const lightScene = this._lightingEffect?.lightScene;
    if (!lightScene) return;
    if (!this._glowRootGroup) {
      const THREE = window.THREE;
      if (!THREE) return;
      this._glowRootGroup = new THREE.Group();
      this._glowRootGroup.name = 'FireGlow';
    }
    if (this._glowRootGroup.parent !== lightScene) {
      try { this._glowRootGroup.removeFromParent(); } catch (_) {}
      try { lightScene.add(this._glowRootGroup); } catch (_) {}
    }
  }

  _applyGlowVisibility() {
    const show = this._enabled && !!this.params.fireGlowEnabled;
    if (this._glowRootGroup) this._glowRootGroup.visible = show;
  }

  /**
   * Whether a per-floor glow group should draw into the HDR light buffer this pass.
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _isGlowFloorGroupVisible(floorIndex) {
    if (!this._enabled || !this.params.fireGlowEnabled) return false;
    const fi = Number(floorIndex) || 0;

    const renderFi = this._renderFloorIndexForGlow;
    if (renderFi !== null && Number.isFinite(Number(renderFi))) {
      const sliceFi = Math.max(0, Math.floor(Number(renderFi)));
      if (this._renderFloorSliceStrict) return fi === sliceFi;
      return fi <= sliceFi;
    }

    return fi <= this._maxVisibleFloorIndex;
  }

  /** @param {number} [maxFloorIndex] */
  _applyGlowFloorVisibility(maxFloorIndex = this._maxVisibleFloorIndex) {
    this._maxVisibleFloorIndex = Number.isFinite(Number(maxFloorIndex))
      ? Math.max(0, Math.floor(Number(maxFloorIndex)))
      : 0;
    this._applyGlowVisibility();
    if (!this._glowRootGroup) return;
    for (const [fi, group] of this._glowFloorGroups) {
      group.visible = this._isGlowFloorGroupVisible(fi);
    }
  }

  _applyGlowParamChange(paramId) {
    if (paramId === 'fireGlowEnabled') {
      if (!this.params.fireGlowEnabled) this._clearAllGlow();
      else this._needsGlowRebuild = true;
      this._applyGlowVisibility();
      return;
    }
    if (paramId === 'fireGlowFalloffExponent' || paramId === 'fireGlowNightFalloffExponent') {
      this._applyLiveGlowMeshParams();
      return;
    }
    if (paramId === 'fireGlowEdgeSoftness' || paramId === 'fireGlowNightEdgeSoftness') {
      this._applyLiveGlowMeshParams();
      return;
    }
    if (paramId === 'fireGlowWallClipEnabled') {
      this._needsGlowRebuild = true;
      return;
    }
    if (paramId === 'fireGlowWarmth') {
      return;
    }
    if (paramId === 'fireGlowBucketSizePx' || paramId === 'fireGlowMaxBuckets') {
      this._reclusterGlowFromStoredPoints();
    }
    if (FIRE_GLOW_PHOTOMETRY_PARAMS.has(paramId)) {
      this._invalidateGlowParamCache();
      this._applyLiveFireGlowBalance();
      return;
    }
    if (FIRE_GLOW_RADIUS_BALANCE_PARAMS.has(paramId)) {
      this._invalidateGlowParamCache();
      this._applyLiveFireGlowBalance();
      this._needsGlowRebuild = true;
      return;
    }
    if (FIRE_GLOW_REBUILD_PARAMS.has(paramId)) {
      this._needsGlowRebuild = true;
    }
  }

  _hashGlow2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  _normalizeGlowHue(rgb) {
    const max = Math.max(Number(rgb?.r) || 0, Number(rgb?.g) || 0, Number(rgb?.b) || 0, 1e-4);
    return { r: (Number(rgb?.r) || 0) / max, g: (Number(rgb?.g) || 0) / max, b: (Number(rgb?.b) || 0) / max };
  }

  _computeFireGlowWarmTarget(warmth = null) {
    const w = clamp01(Number(warmth ?? this.params.fireGlowWarmth) || 0);
    return {
      r: FIRE_GLOW_COLOR_COOL.r + (FIRE_GLOW_COLOR_WARM.r - FIRE_GLOW_COLOR_COOL.r) * w,
      g: FIRE_GLOW_COLOR_COOL.g + (FIRE_GLOW_COLOR_WARM.g - FIRE_GLOW_COLOR_COOL.g) * w,
      b: FIRE_GLOW_COLOR_COOL.b + (FIRE_GLOW_COLOR_WARM.b - FIRE_GLOW_COLOR_COOL.b) * w,
    };
  }

  /** @private @param {number} [darkness] */
  _blendGlowDayNightParam(dayKey, nightKey, fallback = 0, darkness = null) {
    const t = clamp01(Number.isFinite(Number(darkness))
      ? Number(darkness)
      : LightingDirector.get().masterDarkness);
    const dayRaw = Number(this.params[dayKey]);
    const day = Number.isFinite(dayRaw) ? dayRaw : fallback;
    const nightRaw = Number(this.params[nightKey]);
    const night = Number.isFinite(nightRaw) ? nightRaw : day;
    return day + (night - day) * t;
  }

  /**
   * @private
   * @param {number} outdoor01
   * @returns {0|1}
   */
  _snapFireGlowBalanceOutdoor(outdoor01) {
    return clamp01(Number(outdoor01) || 0) > FIRE_GLOW_BALANCE_OUTDOOR_THRESHOLD ? 1.0 : 0.0;
  }

  /** @private @param {number} outdoor01 */
  _blendGlowIndoorOutdoorParam(indoorKey, outdoorKey, fallback = 1.0, outdoor01 = 0.5) {
    const o = clamp01(Number(outdoor01) || 0);
    const indoorRaw = Number(this.params[indoorKey]);
    const indoor = Number.isFinite(indoorRaw) ? indoorRaw : fallback;
    const outdoorRaw = Number(this.params[outdoorKey]);
    const outdoor = Number.isFinite(outdoorRaw) ? outdoorRaw : fallback;
    return indoor + (outdoor - indoor) * o;
  }

  /**
   * Effective gameplay-light pool params blended by master darkness (day → night)
   * and roof mask (indoor → outdoor).
   * @param {number} [darkness]
   * @param {number|null} [outdoor01]
   * @returns {object}
   * @private
   */
  _resolveFireGlowParams(darkness = null, outdoor01 = null) {
    const t = clamp01(Number.isFinite(Number(darkness))
      ? Number(darkness)
      : LightingDirector.get().masterDarkness);
    const base = {
      t,
      warmth: clamp01(this._blendGlowDayNightParam('fireGlowWarmth', 'fireGlowNightWarmth', 1.0, t)),
      intensity: Math.max(0, this._blendGlowDayNightParam('fireGlowIntensity', 'fireGlowNightIntensity', 0.95, t)),
      cancel: Math.max(0, this._blendGlowDayNightParam('fireGlowDarknessCancel', 'fireGlowNightDarknessCancel', 8.0, t)),
      radiusPx: Math.max(48, this._blendGlowDayNightParam('fireGlowRadiusPx', 'fireGlowNightRadiusPx', 640, t)),
      innerScale: Math.max(0.05, Math.min(1, this._blendGlowDayNightParam(
        'fireGlowInnerRadiusScale',
        'fireGlowNightInnerRadiusScale',
        0.14,
        t,
      ))),
      falloffExponent: Math.min(2.5, Math.max(0.5, this._blendGlowDayNightParam(
        'fireGlowFalloffExponent',
        'fireGlowNightFalloffExponent',
        2.0,
        t,
      ))),
      edgeSoftness: Math.max(0, Math.min(1.0, this._blendGlowDayNightParam(
        'fireGlowEdgeSoftness',
        'fireGlowNightEdgeSoftness',
        0.32,
        t,
      ))),
      flickerStrength: Math.max(0, this._blendGlowDayNightParam(
        'fireGlowFlickerStrength',
        'fireGlowNightFlickerStrength',
        3.8,
        t,
      )),
      flickerSpeed: Math.max(0, this._blendGlowDayNightParam('fireGlowFlickerSpeed', 'fireGlowNightFlickerSpeed', 4.5, t)),
      flickerStrengthJitter: clamp01(this._blendGlowDayNightParam(
        'fireGlowFlickerStrengthJitter',
        'fireGlowNightFlickerStrengthJitter',
        0.82,
        t,
      )),
      flickerSpeedJitter: clamp01(this._blendGlowDayNightParam(
        'fireGlowFlickerSpeedJitter',
        'fireGlowNightFlickerSpeedJitter',
        0.72,
        t,
      )),
    };

    if (outdoor01 == null || !Number.isFinite(Number(outdoor01))) return base;

    const balanceOutdoor = this._snapFireGlowBalanceOutdoor(outdoor01);
    const intensityScale = Math.max(0, this._blendGlowIndoorOutdoorParam(
      'fireGlowIndoorIntensityScale',
      'fireGlowOutdoorIntensityScale',
      1.0,
      balanceOutdoor,
    ));
    const cancelScale = Math.max(0, this._blendGlowIndoorOutdoorParam(
      'fireGlowIndoorCancelScale',
      'fireGlowOutdoorCancelScale',
      1.0,
      balanceOutdoor,
    ));
    const radiusScale = Math.max(0.25, this._blendGlowIndoorOutdoorParam(
      'fireGlowIndoorRadiusScale',
      'fireGlowOutdoorRadiusScale',
      1.0,
      balanceOutdoor,
    ));

    return {
      ...base,
      intensity: base.intensity * intensityScale,
      cancel: base.cancel * cancelScale,
      radiusPx: Math.max(48, base.radiusPx * radiusScale),
    };
  }

  /** Push current darkness-blended falloff/edge to all glow meshes (UI tweak). @private */
  _applyLiveGlowMeshParams() {
    this._syncGlowMeshPhotometry(true);
  }

  /** @private */
  _invalidateGlowParamCache() {
    this._glowParamCache.indoor = null;
    this._glowParamCache.outdoor = null;
    this._glowParamCache.darkness = -1;
    this._glowFlickerDarkness = -1;
  }

  /**
   * Resolve day/night + indoor/outdoor glow params with per-frame cache.
   * @param {number} outdoor01
   * @returns {object}
   * @private
   */
  _resolveCachedFireGlowParams(outdoor01) {
    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const outdoor = clamp01(Number(outdoor01) || 0);
    const balanceOutdoor = this._snapFireGlowBalanceOutdoor(outdoor);
    const cacheKey = balanceOutdoor > 0.5 ? 'outdoor' : 'indoor';
    const cache = this._glowParamCache;
    if (cache.darkness !== darkness) {
      cache.indoor = null;
      cache.outdoor = null;
      cache.darkness = darkness;
    }
    if (!cache[cacheKey]) {
      cache[cacheKey] = this._resolveFireGlowParams(darkness, balanceOutdoor);
    }
    return cache[cacheKey];
  }

  /**
   * Sync glow pool radius/falloff when darkness or glow params change — not every flicker frame.
   * @param {boolean} [force=false]
   * @private
   */
  _syncGlowMeshPhotometry(force = false) {
    if (this._isLightBufferPassActive()) {
      this._needsGlowRebuild = true;
      return;
    }
    const darkness = clamp01(LightingDirector.get().masterDarkness);
    if (!force && Math.abs(darkness - (this._glowFlickerDarkness ?? -1)) < 0.012) return;
    this._glowFlickerDarkness = darkness;
    this._invalidateGlowParamCache();
    this._glowParamCache.darkness = darkness;
    this._applyLiveFireGlowBalance({ falloffEdgeOnly: true });
  }

  /**
   * Push indoor/outdoor + day/night fire-glow photometry to all pools (slider preview).
   * @param {{ falloffEdgeOnly?: boolean }} [opts]
   * @private
   */
  _applyLiveFireGlowBalance(opts = {}) {
    if (!this.params.fireGlowEnabled || !this._glowBucketsByFloor.size) return;

    this._invalidateGlowParamCache();
    const falloffEdgeOnly = opts.falloffEdgeOnly === true;
    const dayNightMul = this._computeFireGlowDayNightMul();
    const wallClipScale = Math.max(0.25, Number(this.params.fireGlowWallClipRadiusScale) || 1.0);

    for (const buckets of this._glowBucketsByFloor.values()) {
      for (const entry of buckets.values()) {
        const lm = entry?.lightMesh;
        const u = lm?.material?.uniforms;
        if (!u?.uColor?.value) continue;

        const outdoor = entry.outdoor ?? 1.0;
        const glow = this._resolveCachedFireGlowParams(outdoor);
        const sizeBoost = entry.sizeBoost ?? 1.0;
        const radiusPx = Math.max(48, glow.radiusPx * sizeBoost * wallClipScale);
        const innerRadiusPx = Math.max(1, radiusPx * glow.innerScale);

        lm.setOuterRadiusPx?.(radiusPx);
        lm.setInnerRadiusPx?.(innerRadiusPx);
        lm.setFalloffExponent?.(glow.falloffExponent);
        lm.setEdgeSoftness?.(glow.edgeSoftness);

        if (falloffEdgeOnly) continue;

        const indoorMul = this._computeFireGlowIndoorNightBoost(outdoor);
        const outdoorMul = this._computeFireGlowOutdoorNightBoost(outdoor);
        const visualMul = Math.max(
          0,
          glow.intensity
            * Math.max(0.35, entry.intensity)
            * dayNightMul
            * indoorMul
            * outdoorMul
        );

        const hue = this._computeFireGlowColor(glow.warmth);
        u.uColor.value.setRGB(hue.r, hue.g, hue.b);

        const emissionGain = this._computeFireGlowEmissionGain(visualMul, glow.cancel);
        if (typeof lm.setEmissionGain === 'function') {
          lm.setEmissionGain(emissionGain);
        } else if (u.uEmissionGain) {
          u.uEmissionGain.value = emissionGain;
        }
      }
    }
  }

  /** Normalized deep-orange hue for the HDR light buffer (brightness via emission gain). */
  _computeFireGlowColor(warmth = null) {
    return this._normalizeGlowHue(this._computeFireGlowWarmTarget(warmth));
  }

  _computeFireGlowDayNightMul() {
    const darkness = clamp01(LightingDirector.get().masterDarkness);
    // Gameplay light stays on by day; night scale adds darkness-cancel punch (not the only emission path).
    const dayFloor = 0.55;
    const day = Math.max(dayFloor, Math.max(0, Number(this.params.fireGlowDayIntensityScale) || 0));
    const night = Math.max(day, Math.max(0, Number(this.params.fireGlowNightIntensityScale) || 0));
    return day + (night - day) * darkness;
  }

  /** @param {number} visualMul @param {number} [cancelOverride] */
  _computeFireGlowEmissionGain(visualMul, cancelOverride = null) {
    const cancel = Math.max(0, Number(cancelOverride ?? this.params.fireGlowDarknessCancel) || 0);
    if (cancel <= 0) return 0;

    let lightMul = 1.0;
    if (this.params.fireGlowFollowLightIntensity) {
      const dayRaw = Number(this.params.lightIntensity);
      const nightRaw = Number(this.params.nightHdrBrightness);
      const darkness = clamp01(LightingDirector.get().masterDarkness);
      const dayGain = Number.isFinite(dayRaw) && dayRaw > 0 ? dayRaw / 5.0 : 1.0;
      const nightGain = Number.isFinite(nightRaw) && nightRaw > 0 ? nightRaw / 5.0 : 1.0;
      lightMul = dayGain + (nightGain - dayGain) * darkness;
      lightMul = Math.max(0.35, lightMul);
    }

    const nightBoost = Math.max(1, Number(this.params.fireGlowDarknessNightBoost) || 1);
    const nightMul = 1.0 + clamp01(LightingDirector.get().masterDarkness) * (nightBoost - 1.0);
    const vis = Math.max(0, Number(visualMul) || 0);
    return cancel * lightMul * nightMul * vis;
  }

  /** @param {number} outdoor01 */
  _computeFireGlowIndoorNightBoost(outdoor01) {
    const boost = Math.max(0, Number(this.params.fireGlowIndoorNightBoost) || 0);
    if (boost <= 0) return 1.0;
    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const indoor = 1.0 - this._snapFireGlowBalanceOutdoor(outdoor01);
    return 1.0 + boost * indoor * darkness;
  }

  /** @param {number} outdoor01 */
  _computeFireGlowOutdoorNightBoost(outdoor01) {
    const boost = Math.max(0, Number(this.params.fireGlowOutdoorNightBoost) || 0);
    if (boost <= 0) return 1.0;
    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const outdoor = this._snapFireGlowBalanceOutdoor(outdoor01);
    return 1.0 + boost * outdoor * darkness;
  }

  _buildGlowWallClipOptions() {
    const opts = {
      blockGeometry: true,
      circleSegments: 96,
    };
    try {
      const pad = window.MapShine?.lightingEffect?.params?.wallPaddingPx;
      if (typeof pad === 'number' && isFinite(pad) && pad > 0) {
        opts.wallPaddingPx = Math.max(0, pad);
      }
      if (hasV14NativeLevels(canvas?.scene)) {
        const pe = getPerspectiveElevation();
        if (Number.isFinite(pe?.losHeight)) opts.elevation = pe.losHeight;
      }
    } catch (_) {}
    return opts;
  }

  /**
   * Cluster fire-mask pixels into glow pool metadata for one floor.
   * @private
   */
  _buildGlowClustersForFloor(floorIndex, points, sceneW, sceneH, sceneX, sceneY) {
    if (!points || points.length < 3) {
      this._glowClustersByFloor.set(floorIndex, []);
      return;
    }

    const bucketSize = Math.max(128, Number(this.params.fireGlowBucketSizePx) || 512);
    const buckets = new Map();

    for (let i = 0; i < points.length; i += 3) {
      const u = points[i];
      const v = points[i + 1];
      const brightness = points[i + 2];
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(brightness) || brightness <= 0) continue;

      const wx = sceneX + u * sceneW;
      const wy = sceneY + (1.0 - v) * sceneH;
      const bx = Math.floor(wx / bucketSize);
      const by = Math.floor(wy / bucketSize);
      const key = `${bx},${by}`;

      const sceneBounds = this._glowSceneContext?.sceneBounds ?? buildEffectSceneBoundsFromCanvas();
      const rawOutdoor = sampleAuthoredOutdoorsAtWorld(
        floorIndex,
        wx,
        wy,
        sceneBounds,
        this._outdoorsMaskFrameToken,
        window.MapShine?.activeLevelContext ?? null,
      );
      const outdoor = clamp01(rawOutdoor == null || !Number.isFinite(rawOutdoor) ? 1.0 : rawOutdoor);

      let b = buckets.get(key);
      if (!b) {
        b = { sumX: 0, sumY: 0, sumI: 0, sumOutdoor: 0, minOutdoor: 1.0, count: 0 };
        buckets.set(key, b);
      }
      b.sumX += wx;
      b.sumY += wy;
      b.sumI += brightness;
      b.sumOutdoor += outdoor;
      b.minOutdoor = Math.min(b.minOutdoor, outdoor);
      b.count += 1;
    }

    const list = [];
    for (const [key, b] of buckets.entries()) {
      if (!b?.count) continue;
      list.push({ key, ...b });
    }
    list.sort((a, b) => (b.sumI - a.sumI) || (b.count - a.count));

    const maxBuckets = Math.max(1, Number(this.params.fireGlowMaxBuckets) | 0);
    const take = Math.min(list.length, maxBuckets);
    const ctx = this._glowSceneContext;
    const sceneWidth = ctx?.sceneWidth ?? sceneW;
    const sceneHeight = ctx?.sceneHeight ?? sceneH;
    const foundrySceneX = ctx?.foundrySceneX ?? (canvas?.dimensions?.sceneX ?? 0);
    const foundrySceneY = ctx?.foundrySceneY ?? (canvas?.dimensions?.sceneY ?? 0);

    const baseGlowColor = this._computeFireGlowWarmTarget();
    const wallClipScale = Math.max(0.25, Number(this.params.fireGlowWallClipRadiusScale) || 1.0);
    const clusters = [];

    for (let i = 0; i < take; i++) {
      const b = list[i];
      const cxWorld = b.sumX / b.count;
      const cyWorld = b.sumY / b.count;
      const sceneBounds = ctx?.sceneBounds ?? buildEffectSceneBoundsFromCanvas();
      const rawCenter = sampleAuthoredOutdoorsAtWorld(
        floorIndex,
        cxWorld,
        cyWorld,
        sceneBounds,
        this._outdoorsMaskFrameToken,
        window.MapShine?.activeLevelContext ?? null,
      );
      const outdoorAtCenter = clamp01(rawCenter == null || !Number.isFinite(rawCenter) ? 1.0 : rawCenter);
      const outdoorForGlow = Math.min(
        Number.isFinite(b.minOutdoor) ? b.minOutdoor : outdoorAtCenter,
        outdoorAtCenter,
      );
      const intensity = b.sumI / Math.max(1, b.count);
      const phase = this._hashGlow2(cxWorld, cyWorld);
      const foundryCenter = Coordinates.toFoundry(cxWorld, cyWorld);
      const sizeBoost = 0.72 + 0.28 * Math.min(1.5, Math.sqrt(intensity));
      const glow = this._resolveFireGlowParams(null, outdoorForGlow);
      const radiusPx = Math.max(48, glow.radiusPx * sizeBoost * wallClipScale);

      clusters.push({
        key: b.key,
        floorIndex,
        cxWorld,
        cyWorld,
        cxFoundry: foundryCenter.x,
        cyFoundry: foundryCenter.y,
        radiusPx,
        intensity,
        phase,
        outdoor: outdoorForGlow,
        color: baseGlowColor,
        foundrySceneX,
        foundrySceneY,
        sceneWidth,
        sceneHeight,
      });
    }

    this._glowClustersByFloor.set(floorIndex, clusters);
    this._invalidateHeatDistortionMask();
  }

  _reclusterGlowFromStoredPoints() {
    const ctx = this._glowSceneContext;
    if (!ctx) return;
    for (const [floorIndex, points] of this._glowSourcePointsByFloor) {
      this._buildGlowClustersForFloor(
        floorIndex,
        points,
        ctx.sceneWidth,
        ctx.sceneHeight,
        ctx.sceneX,
        ctx.sceneY
      );
    }
  }

  /** Rebuild glow pools when authored _Outdoors CPU decode updates (async mask load). */
  onOutdoorsMaskUpdated() {
    this._outdoorsMaskFrameToken += 1;
    if (!this.params.fireGlowEnabled) return;
    this._reclusterGlowFromStoredPoints();
    this._needsGlowRebuild = true;
  }

  _clearFloorGlow(floorIndex) {
    const buckets = this._glowBucketsByFloor.get(floorIndex);
    if (buckets) {
      for (const entry of buckets.values()) {
        try { entry?.lightMesh?.dispose?.(); } catch (_) {}
        try { entry?.lightMesh?.mesh?.removeFromParent?.(); } catch (_) {}
      }
      buckets.clear();
    }
    this._glowBucketsByFloor.delete(floorIndex);

    const group = this._glowFloorGroups.get(floorIndex);
    if (group) {
      try {
        while (group.children.length) {
          const c = group.children.pop();
          c?.removeFromParent?.();
        }
      } catch (_) {}
      try { group.removeFromParent(); } catch (_) {}
    }
    this._glowFloorGroups.delete(floorIndex);
  }

  _clearAllGlow() {
    for (const fi of [...this._glowBucketsByFloor.keys()]) {
      this._clearFloorGlow(fi);
    }
    this._glowBucketsByFloor.clear();
    this._glowFloorGroups.clear();
    try { this._glowRootGroup?.removeFromParent?.(); } catch (_) {}
    this._glowRootGroup = null;
  }

  /** @private @returns {boolean} */
  _isLightBufferPassActive() {
    const renderer = this._lightingEffect?._lastCompositorRenderer ?? null;
    const lightTex = this._lightingEffect?._lightRT?.texture ?? null;
    return _isSamplingActiveRenderTarget(renderer, lightTex);
  }

  _rebuildAllFloorGlowMeshes() {
    if (this._isLightBufferPassActive()) {
      this._needsGlowRebuild = true;
      return;
    }

    if (!this.params.fireGlowEnabled) {
      this._clearAllGlow();
      return;
    }

    this._tryAttachGlowRoot();
    if (!this._glowRootGroup?.parent) {
      this._clearAllGlow();
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    const lightScene = this._lightingEffect?.lightScene ?? null;
    const glowRoot = this._glowRootGroup;
    let detached = false;
    if (lightScene && glowRoot?.parent === lightScene) {
      try {
        lightScene.remove(glowRoot);
        detached = true;
      } catch (_) {
      }
    }

    const activeFloors = new Set(this._glowClustersByFloor.keys());
    for (const fi of [...this._glowFloorGroups.keys()]) {
      if (!activeFloors.has(fi)) this._clearFloorGlow(fi);
    }

    const walls = canvas?.walls?.placeables ?? [];
    const wallClipOptions = this._buildGlowWallClipOptions();
    const wallClipScale = Math.max(0.25, Number(this.params.fireGlowWallClipRadiusScale) || 1.0);

    for (const [floorIndex, clusters] of this._glowClustersByFloor) {
      this._clearFloorGlow(floorIndex);
      if (!clusters?.length) continue;

      let floorGroup = this._glowFloorGroups.get(floorIndex);
      if (!floorGroup) {
        floorGroup = new THREE.Group();
        floorGroup.name = `FireGlow_floor_${floorIndex}`;
        this._glowFloorGroups.set(floorIndex, floorGroup);
        this._glowRootGroup.add(floorGroup);
      }

      const buckets = new Map();
      const sceneBounds = {
        x: clusters[0].foundrySceneX,
        y: clusters[0].foundrySceneY,
        width: clusters[0].sceneWidth,
        height: clusters[0].sceneHeight,
      };

      for (const c of clusters) {
        const sizeBoost = 0.72 + 0.28 * Math.min(1.5, Math.sqrt(Math.max(0, c.intensity)));
        const outdoor = Math.max(0, Math.min(1, Number(c.outdoor) ?? 1));
        const glow = this._resolveFireGlowParams(null, outdoor);
        const radiusPx = Math.max(48, glow.radiusPx * sizeBoost * wallClipScale);
        const clipRadiusPx = radiusPx;

        let foundryPoly = null;
        if (this.params.fireGlowWallClipEnabled) {
          try {
            foundryPoly = this._visionComputer.compute(
              { x: c.cxFoundry, y: c.cyFoundry },
              clipRadiusPx,
              walls,
              sceneBounds,
              wallClipOptions
            );
          } catch (_) {
            foundryPoly = null;
          }
        }

        let worldPoints = null;
        if (foundryPoly && foundryPoly.length >= 6) {
          worldPoints = [];
          for (let i = 0; i < foundryPoly.length; i += 2) {
            const wp = Coordinates.toWorld(foundryPoly[i], foundryPoly[i + 1]);
            worldPoints.push(wp.x, wp.y);
          }
        } else if (this.params.fireGlowWallClipEnabled) {
          if (outdoor < 0.45) {
            continue;
          }
          // Outdoor campfire: radial pool when wall clip fails in open areas.
        }

        const centerWorld = new THREE.Vector2(c.cxWorld, c.cyWorld);
        const lm = new LightMesh(centerWorld, radiusPx, c.color, {
          innerRadiusPx: Math.max(1, radiusPx * glow.innerScale),
          worldPoints,
          falloffExponent: glow.falloffExponent,
          achromaticRgb: false,
          edgeSoftness: glow.edgeSoftness,
        });

        lm.setEmissionGain?.(0);

        if (lm?.mesh) {
          lm.mesh.renderOrder = 88;
          lm.mesh.position.z = GROUND_Z + (Number(floorIndex) || 0) + 0.18;
          floorGroup.add(lm.mesh);
        }

        buckets.set(c.key, {
          lightMesh: lm,
          baseColor: new THREE.Color(c.color.r, c.color.g, c.color.b),
          intensity: c.intensity,
          phase: c.phase,
          outdoor: c.outdoor,
          sizeBoost,
          wallClipScale,
        });
      }

      this._glowBucketsByFloor.set(floorIndex, buckets);
    }

    if (detached && lightScene && glowRoot) {
      try {
        lightScene.add(glowRoot);
      } catch (_) {
      }
    }

    this._applyGlowVisibility();
  }

  /** @private */
  _updateFireGlowFlicker(timeInfo) {
    if (!this.params.fireGlowEnabled || !this._glowBucketsByFloor.size) return;

    const THREE = window.THREE;
    if (!THREE) return;

    this._syncGlowMeshPhotometry(false);

    const t = timeInfo.elapsed;
    const dayNightMul = this._computeFireGlowDayNightMul();
    /** @type {Map<number, { glow: object, hue: {r:number,g:number,b:number} }>} */
    const glowBandPack = new Map();
    const flickerFloors = this._getGlowFlickerFloorsThisFrame();

    for (const floorIndex of flickerFloors) {
      const buckets = this._glowBucketsByFloor.get(floorIndex);
      if (!buckets?.size) continue;
      for (const entry of buckets.values()) {
        const lm = entry?.lightMesh;
        const u = lm?.material?.uniforms;
        if (!u?.uColor?.value) continue;

        const phase = entry.phase || 0;
        const outdoor = entry.outdoor ?? 1.0;
        const glowBand = outdoor > 0.5 ? 1 : 0;
        let pack = glowBandPack.get(glowBand);
        if (!pack) {
          const glow = this._resolveCachedFireGlowParams(glowBand);
          pack = { glow, hue: this._computeFireGlowColor(glow.warmth) };
          glowBandPack.set(glowBand, pack);
        }
        const glow = pack.glow;
        const strength = glow.flickerStrength;
        const speed = glow.flickerSpeed;
        const speedJ = glow.flickerSpeedJitter;
        const strengthJ = glow.flickerStrengthJitter;

        const r1 = Math.sin((phase + 0.17) * 1000.0) * 43758.5453;
        const r2 = Math.sin((phase + 0.61) * 1000.0) * 24631.1337;
        const rand01 = r1 - Math.floor(r1);
        const rand01b = r2 - Math.floor(r2);
        const speedVar = 1.0 + (rand01 * 2.0 - 1.0) * speedJ;
        const strengthVar = 1.0 + (rand01b * 2.0 - 1.0) * strengthJ;

        const baseAmp = outdoor > 0.5 ? 0.62 : 0.42;
        const baseSpd = outdoor > 0.5 ? 1.05 : 0.85;
        const spd = (speed > 0 ? (speed * baseSpd) : (baseSpd * 4.5)) * Math.max(0.05, speedVar);

        const n1 = Math.sin(t * spd + phase * 6.2831);
        const n2 = Math.sin(t * (spd * 1.73) + phase * 11.7);
        const n3 = Math.sin(t * (spd * 2.91) + phase * 23.1);
        const chaos = (0.55 * n1 + 0.30 * n2 + 0.15 * n3);
        const flicker = Math.max(0.08, 1.0 + (baseAmp * strength * Math.max(0.05, strengthVar)) * chaos);

        const indoorMul = this._computeFireGlowIndoorNightBoost(outdoor);
        const outdoorMul = this._computeFireGlowOutdoorNightBoost(outdoor);
        const visualMul = Math.max(
          0,
          glow.intensity
            * Math.max(0.35, entry.intensity)
            * flicker
            * dayNightMul
            * indoorMul
            * outdoorMul
        );

        u.uColor.value.setRGB(pack.hue.r, pack.hue.g, pack.hue.b);

        const emissionGain = this._computeFireGlowEmissionGain(visualMul, glow.cancel);
        if (typeof lm.setEmissionGain === 'function') {
          lm.setEmissionGain(emissionGain);
        } else if (u.uEmissionGain) {
          u.uEmissionGain.value = emissionGain;
        }
      }
    }
  }

  // ── Private: System building ───────────────────────────────────────────────

  /**
   * @param {number} floorIndex
   * @returns {BatchedRenderer}
   * @private
   */
  _createBatchedRendererForFloor(floorIndex) {
    const br = new BatchedRenderer();
    br.frustumCulled = false;
    br.renderOrder = effectUnderOverheadOrder(floorIndex, 0);
    try {
      if (br.layers && typeof br.layers.set === 'function') {
        br.layers.set(0);
      }
    } catch (_) {}
    return br;
  }

  /**
   * Bucket packed fire-mask points into spatial cells for particle emitters.
   * @private
   */
  _bucketFirePoints(points, sceneW, sceneH, sceneX, sceneY, bucketSizePx) {
    const buckets = new Map();
    const bucketSize = Math.max(BUCKET_SIZE, Number(bucketSizePx) || BUCKET_SIZE);
    for (let i = 0; i < points.length; i += 3) {
      const u = points[i];
      const v = points[i + 1];
      const b = points[i + 2];
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0) continue;
      const worldX = sceneX + u * sceneW;
      const worldY = sceneY + (1.0 - v) * sceneH;
      const bx = Math.floor(worldX / bucketSize);
      const by = Math.floor(worldY / bucketSize);
      const key = `${bx},${by}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(u, v, b);
    }
    return buckets;
  }

  /**
   * Estimate max spatial buckets allowed before particle-system budget is exceeded.
   * @private
   */
  _estimateMaxSpatialBucketsForSystemBudget(proposedBucketCount) {
    const spatialCap = Math.max(4, Number(this.params.fireMaxSpatialBuckets) | 0 || FIRE_DEFAULT_MAX_SPATIAL_BUCKETS);
    const maxSystems = Math.max(8, Number(this.params.fireMaxSystemsPerFloor) | 0 || FIRE_DEFAULT_MAX_SYSTEMS_PER_FLOOR);
    const splitMaxBuckets = Math.max(2, Number(this.params.fireOutdoorSplitMaxBuckets) | 0 || FIRE_DEFAULT_OUTDOOR_SPLIT_MAX_BUCKETS);
    const splitOutdoor = this.params.smokeOutdoorAboveCanopy !== false
      && proposedBucketCount <= splitMaxBuckets;
    const smokeOn = !!this.params.smokeEnabled;
    let perBucket = 1 + (splitOutdoor ? 2 : 1);
    if (smokeOn) perBucket += splitOutdoor ? 2 : 1;
    const budgetBuckets = Math.max(4, Math.floor(maxSystems / perBucket));
    return Math.min(spatialCap, budgetBuckets);
  }

  /**
   * Spatially bucket fire points, coarsening cell size until bucket count is within budget.
   * @private
   */
  _coarsenFireSpatialBuckets(points, sceneW, sceneH, sceneX, sceneY) {
    let bucketSize = BUCKET_SIZE;
    let buckets = this._bucketFirePoints(points, sceneW, sceneH, sceneX, sceneY, bucketSize);
    while (bucketSize < FIRE_MAX_SPATIAL_BUCKET_SIZE_PX) {
      const maxBuckets = this._estimateMaxSpatialBucketsForSystemBudget(buckets.size);
      if (buckets.size <= maxBuckets) break;
      bucketSize *= 2;
      buckets = this._bucketFirePoints(points, sceneW, sceneH, sceneX, sceneY, bucketSize);
    }
    const finalCap = this._estimateMaxSpatialBucketsForSystemBudget(buckets.size);
    if (buckets.size > finalCap) {
      log.warn(`FireEffectV2: ${buckets.size} spatial buckets exceed budget ${finalCap} even at ${bucketSize}px cells`);
    }
    return buckets;
  }

  /** Scale per-bucket particle caps by mask area share (matches DustEffectV2). @private */
  _scaledMaxParticles(baseMax, weight, min = 16) {
    const base = Math.max(min, Number(baseMax) || min);
    const w = Math.max(0.06, Number(weight) || 0.06);
    return Math.max(min, Math.floor(base * w));
  }

  /**
   * three.quarks ignores ParticleSystem.maxParticles at spawn time — enforce a hard cap
   * so live particle count (and CPU cost) cannot grow without bound over time.
   * @private
   */
  _applyParticleSpawnCap(system, maxParticles) {
    if (!system || maxParticles <= 0) return;
    system._msParticleCap = maxParticles;
    if (system._msSpawnCapPatched) return;
    system._msSpawnCapPatched = true;
    const origSpawn = system.spawn.bind(system);
    system.spawn = (count, emissionState, matrix) => {
      const cap = system._msParticleCap;
      if (cap > 0 && system.particleNum >= cap) return;
      const room = cap > 0 ? Math.max(0, cap - system.particleNum) : count;
      if (room <= 0) return;
      origSpawn(Math.min(count, room), emissionState, matrix);
    };
  }

  /**
   * Keep emission rates within what maxParticles and lifespan can sustain (~85% fill).
   * @private
   */
  _capEmissionForParticleBudget(emissionMin, emissionMax, maxParticles, lifeMin, lifeMax, globalRate) {
    const rate = Math.max(0, Number(globalRate) || 0);
    const avgLife = Math.max(0.05, (Number(lifeMin) + Number(lifeMax)) * 0.5);
    const budget = Math.max(1, Number(maxParticles) || 1);
    const maxSustainable = (budget / avgLife) * 0.85;
    let emMin = Math.max(0, Number(emissionMin) || 0) * rate;
    let emMax = Math.max(emMin, Number(emissionMax) || 0) * rate;
    if (emMax <= maxSustainable) return { a: emMin, b: emMax };
    const scale = maxSustainable / emMax;
    emMin *= scale;
    emMax *= scale;
    return { a: emMin, b: emMax };
  }

  /** @private */
  _syncSystemEmission(sys, globalRate) {
    const ud = sys?.userData;
    if (!ud || !sys.emissionOverTime) return;
    const extra = Number(ud._msEmissionExtraMul) || 1;
    const capped = this._capEmissionForParticleBudget(
      (ud._msEmissionBaseA ?? 0) * extra,
      (ud._msEmissionBaseB ?? 0) * extra,
      ud._msMaxParticles ?? 32,
      ud._msLifeMin ?? 0.5,
      ud._msLifeMax ?? 1.0,
      globalRate
    );
    sys.emissionOverTime.a = capped.a;
    sys.emissionOverTime.b = capped.b;
  }

  /**
   * Build fire + ember + smoke systems from merged points for a single floor.
   * Points are spatially bucketed for culling efficiency.
   * @private
   */
  _buildFloorSystems(points, sceneW, sceneH, sceneX, sceneY, floorIndex) {
    const totalCount = points.length / 3;
    if (totalCount === 0) {
      return { systems: [], emberSystems: [], smokeSystems: [], batchRenderer: null };
    }
    const batchRenderer = this._createBatchedRendererForFloor(floorIndex);
    const state = { systems: [], emberSystems: [], smokeSystems: [], batchRenderer };

    const buckets = this._coarsenFireSpatialBuckets(points, sceneW, sceneH, sceneX, sceneY);
    const maxSystems = Math.max(8, Number(this.params.fireMaxSystemsPerFloor) | 0 || FIRE_DEFAULT_MAX_SYSTEMS_PER_FLOOR);
    const splitMaxBuckets = Math.max(2, Number(this.params.fireOutdoorSplitMaxBuckets) | 0 || FIRE_DEFAULT_OUTDOOR_SPLIT_MAX_BUCKETS);
    const splitOutdoor = this.params.smokeOutdoorAboveCanopy !== false && buckets.size <= splitMaxBuckets;
    let systemCount = 0;
    let bucketIndex = 0;

    // Emission weight per bucket: √(pixel count) normalized across buckets.
    // Linear weight (bucketCount/totalCount) starves sparse masks (torches = few dots)
    // when the floor also has large fires — buckets approach zero emission and read as
    // flickery on/off. Sqrt compresses dynamic range so small sources keep a steady stream.
    let sumSqrtBucket = 0;
    for (const [, arr] of buckets) {
      if (arr.length < 3) continue;
      sumSqrtBucket += Math.sqrt(arr.length / 3);
    }

    for (const [, arr] of buckets) {
      if (arr.length < 3) continue;
      const bucketPoints = new Float32Array(arr);
      const bucketN = bucketPoints.length / 3;
      const weight = sumSqrtBucket > 0 ? Math.sqrt(bucketN) / sumSqrtBucket : 1.0;
      // V2 bus layering contract:
      // - Tiles are placed at Z = GROUND_Z + floorIndex
      // - Effects should follow the same scheme to avoid clipping / depth issues.
      // Use a small offset above the floor plane so particles aren't Z-fighting.
      const shape = new FireMaskShape(
        bucketPoints, sceneW, sceneH, sceneX, sceneY,
        this, floorIndex, GROUND_Z + (Number(floorIndex) || 0), 0.55
      );

      // Fire system.
      const fireSys = this._createFireSystem(shape, weight, floorIndex);
      if (fireSys) {
        tagQuarkSystem(fireSys, 'fire', `flame/f${floorIndex}/b${bucketIndex}`);
        state.systems.push(fireSys);
        systemCount += 1;
      }

      let outdoorPoints = null;
      let indoorPoints = null;
      const outdoorCtx = {
        sceneX,
        sceneY,
        sceneW,
        sceneH,
        floorIndex,
        ownerEffect: this,
      };
      if (splitOutdoor) {
        outdoorPoints = filterFirePointsByOutdoor(bucketPoints, 'outdoor', outdoorCtx);
        indoorPoints = filterFirePointsByOutdoor(bucketPoints, 'indoor', outdoorCtx);
      }

      // Embers — optional split: outdoor sparks above tree/bush canopies, indoor under overhead.
      if (systemCount < maxSystems) {
        if (splitOutdoor) {
          if (outdoorPoints && systemCount < maxSystems) {
            const outdoorN = outdoorPoints.length / 3;
            const wOutdoor = weight * (outdoorN / bucketN);
            const outdoorShape = new FireMaskShape(
              outdoorPoints, sceneW, sceneH, sceneX, sceneY,
              this, floorIndex, GROUND_Z + (Number(floorIndex) || 0), 0.55
            );
            const outdoorEmber = this._createEmberSystem(outdoorShape, wOutdoor, floorIndex, { outdoorLayer: true });
            if (outdoorEmber) {
              tagQuarkSystem(outdoorEmber, 'fire', `ember/outdoor/f${floorIndex}/b${bucketIndex}`);
              state.emberSystems.push(outdoorEmber);
              systemCount += 1;
            }
          }
          if (indoorPoints && systemCount < maxSystems) {
            const indoorN = indoorPoints.length / 3;
            const wIndoor = weight * (indoorN / bucketN);
            const indoorShape = new FireMaskShape(
              indoorPoints, sceneW, sceneH, sceneX, sceneY,
              this, floorIndex, GROUND_Z + (Number(floorIndex) || 0), 0.55
            );
            const indoorEmber = this._createEmberSystem(indoorShape, wIndoor, floorIndex, { outdoorLayer: false });
            if (indoorEmber) {
              tagQuarkSystem(indoorEmber, 'fire', `ember/indoor/f${floorIndex}/b${bucketIndex}`);
              state.emberSystems.push(indoorEmber);
              systemCount += 1;
            }
          }
        } else {
          const emberSys = this._createEmberSystem(shape, weight, floorIndex);
          if (emberSys) {
            tagQuarkSystem(emberSys, 'fire', `ember/f${floorIndex}/b${bucketIndex}`);
            state.emberSystems.push(emberSys);
            systemCount += 1;
          }
        }
      }

      // Smoke — optional split: outdoor puffs above tree/bush canopies, indoor under overhead.
      if (this.params.smokeEnabled && systemCount < maxSystems) {
        if (splitOutdoor) {
          if (outdoorPoints && systemCount < maxSystems) {
            const outdoorN = outdoorPoints.length / 3;
            const wOutdoor = weight * (outdoorN / bucketN);
            const outdoorShape = new FireMaskShape(
              outdoorPoints, sceneW, sceneH, sceneX, sceneY,
              this, floorIndex, GROUND_Z + (Number(floorIndex) || 0), 0.55
            );
            const outdoorSmoke = this._createSmokeSystem(outdoorShape, wOutdoor, floorIndex, { outdoorLayer: true });
            if (outdoorSmoke) {
              tagQuarkSystem(outdoorSmoke, 'fire', `smoke/outdoor/f${floorIndex}/b${bucketIndex}`);
              state.smokeSystems.push(outdoorSmoke);
              systemCount += 1;
            }
          }
          if (indoorPoints && systemCount < maxSystems) {
            const indoorN = indoorPoints.length / 3;
            const wIndoor = weight * (indoorN / bucketN);
            const indoorShape = new FireMaskShape(
              indoorPoints, sceneW, sceneH, sceneX, sceneY,
              this, floorIndex, GROUND_Z + (Number(floorIndex) || 0), 0.55
            );
            const indoorSmoke = this._createSmokeSystem(indoorShape, wIndoor, floorIndex, { outdoorLayer: false });
            if (indoorSmoke) {
              tagQuarkSystem(indoorSmoke, 'fire', `smoke/indoor/f${floorIndex}/b${bucketIndex}`);
              state.smokeSystems.push(indoorSmoke);
              systemCount += 1;
            }
          }
        } else if (systemCount < maxSystems) {
          const smokeSys = this._createSmokeSystem(shape, weight, floorIndex, { outdoorLayer: false });
          if (smokeSys) {
            tagQuarkSystem(smokeSys, 'fire', `smoke/f${floorIndex}/b${bucketIndex}`);
            state.smokeSystems.push(smokeSys);
            systemCount += 1;
          }
        }
      }

      bucketIndex += 1;
    }

    return state;
  }

  /** @private */
  _createFireSystem(shape, weight, floorIndex) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._fireTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
      alphaTest: 0.02,
    });
    material.toneMapped = false;
    const texBright = Math.max(0, Number(this.params.flameTextureBrightness) || 1);
    const texOpacity = Math.max(0, Math.min(1, Number(this.params.flameTextureOpacity) ?? 1));
    material.color.setRGB(texBright, texBright, texBright);
    material.opacity = texOpacity;

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.fireLifeMin ?? 0.6) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.fireLifeMax ?? 1.2) / timeScale);
    const sizeMin = Math.max(0.1, p.fireSizeMin ?? 19);
    const sizeMax = Math.max(sizeMin, p.fireSizeMax ?? 170);
    const maxParticles = this._scaledMaxParticles(p.fireMaxParticles ?? 1200, weight, 32);

    const flameLifecycle = new FlameLifecycleBehavior(this);
    const sizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(0.0, 0.2, 1.0, 0.0), 0],
    ]));
    const flameShapeFrames = new FlameShapeFrameBehavior(FIRE_ATLAS_SHAPE_COUNT, FIRE_ATLAS_ANIM_FRAMES, {
      ownerEffect: this,
      cyclesParamKey: 'flameFlipbookCycles',
      defaultCycles: 3.5,
    });
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(p.fireHeight * 0.125));
    const turbulence = new FixedCurlNoiseField(
      new THREE.Vector3(150, 150, 50),
      new THREE.Vector3(80, 80, 30),
      1.5
    );
    const fireForces = new FireForcesBehavior('flame');
    fireForces.bindTurbulence(turbulence);
    const fireSpin = new FireSpinBehavior();

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles,
      emissionOverTime: new IntervalValue(10.0 * weight, 20.0 * weight),
      shape,
      material,
      // Map Shine is Z-up with XY ground; quarks HorizontalBillBoard lies in XZ (Y-up) and
      // reads edge-on as horizontal streaks. Camera-facing billboards match top-down play.
      renderMode: RenderMode.BillBoard,
      renderOrder: this._computeParticleRenderOrder(floorIndex, 0),
      uTileCount: FIRE_ATLAS_COLS,
      vTileCount: FIRE_ATLAS_ROWS,
      blendTiles: true,
      startTileIndex: new ConstantValue(0),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
        flameShapeFrames,
        fireForces,
        fireSpin,
        sizeOverLife,
        flameLifecycle,
      ],
    });

    system.userData = {
      ownerEffect: this,
      floorIndex,
      updraftForce: buoyancy,
      baseUpdraftMag: p.fireHeight * 0.125,
      turbulence,
      baseCurlStrength: new THREE.Vector3(80, 80, 30),
      _msEmissionScale: weight,
      _msMaxParticles: maxParticles,
      _msLifeMin: lifeMin,
      _msLifeMax: lifeMax,
      _msEmissionBaseA: 10.0 * weight,
      _msEmissionBaseB: 20.0 * weight,
      _msEmissionExtraMul: 1,
    };

    this._applyParticleSpawnCap(system, maxParticles);
    this._syncSystemEmission(system, p.globalFireRate ?? 1.0);
    this._finalizeFireParticleSystem(system);

    // Start the system so it becomes active and emits particles.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  /** @private @param {{ outdoorLayer?: boolean }} [opts] */
  _createEmberSystem(shape, weight, floorIndex, opts = {}) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._emberTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      depthWrite: false,
      depthTest: false,
    });
    material.toneMapped = false;
    const texBright = Math.max(0, Number(this.params.flameTextureBrightness) || 1);
    const texOpacity = Math.max(0, Math.min(1, Number(this.params.flameTextureOpacity) ?? 1));
    material.color.setRGB(texBright, texBright, texBright);
    material.opacity = texOpacity;
    applyEmberSpriteTextureTransform(this._emberTexture, this.params);

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.emberLifeMin ?? 1.5) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.emberLifeMax ?? 3.0) / timeScale);
    const sizeMin = Math.max(0.1, p.emberSizeMin ?? 5);
    const sizeMax = Math.max(sizeMin, p.emberSizeMax ?? 17);
    const maxParticles = this._scaledMaxParticles(p.fireEmberMaxParticles ?? 700, weight, 16);

    const emberLifecycle = new EmberLifecycleBehavior(this);
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(p.fireHeight * 0.4));
    const emberCurlStrength = new THREE.Vector3(150, 150, 50);
    const turbulence = new FixedCurlNoiseField(new THREE.Vector3(30, 30, 30), emberCurlStrength.clone(), 4.0);
    const emberForces = new FireForcesBehavior('ember');
    emberForces.bindTurbulence(turbulence);
    const emberSizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(0.0, 0.14, 0.9, 0.0), 0],
    ]));
    const outdoorLayer = opts.outdoorLayer === true;

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles,
      emissionOverTime: new IntervalValue(
        (5.0 * p.emberRate) * weight,
        (10.0 * p.emberRate) * weight
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: this._computeEmberRenderOrder(floorIndex, outdoorLayer),
      behaviors: [
        emberForces,
        emberSizeOverLife,
        emberLifecycle,
      ],
    });

    system.userData = {
      ownerEffect: this,
      floorIndex,
      updraftForce: buoyancy,
      baseUpdraftMag: p.fireHeight * 0.4,
      turbulence,
      baseCurlStrength: emberCurlStrength.clone(),
      isEmber: true,
      isOutdoorEmber: outdoorLayer,
      _msEmissionScale: weight,
      _msMaxParticles: maxParticles,
      _msLifeMin: lifeMin,
      _msLifeMax: lifeMax,
      _msEmissionBaseA: 5.0 * weight,
      _msEmissionBaseB: 10.0 * weight,
      _msEmissionExtraMul: p.emberRate ?? 1.0,
    };

    this._applyParticleSpawnCap(system, maxParticles);
    this._syncSystemEmission(system, p.globalFireRate ?? 1.0);
    this._finalizeFireParticleSystem(system);

    // Start the system so it becomes active and emits particles.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  /** @private @param {{ outdoorLayer?: boolean }} [opts] */
  _createSmokeSystem(shape, weight, floorIndex, opts = {}) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const p = this.params;
    const material = new THREE.MeshBasicMaterial({
      map: this._smokeTexture || this._emberTexture,
      transparent: true,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      alphaTest: 0.008,
    });
    material.toneMapped = false;

    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.smokeLifeMin ?? 0.9) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.smokeLifeMax ?? 3.0) / timeScale);
    const sizeMin = Math.max(1.0, p.smokeSizeMin ?? 183);
    const sizeMax = Math.max(sizeMin, p.smokeSizeMax ?? 400);
    const smokeRatio = Math.max(0.0, p.smokeRatio ?? 0.3);
    const maxParticles = this._scaledMaxParticles(p.fireSmokeMaxParticles ?? 600, weight, 16);

    const smokeShapeFrames = new SmokeShapeFrameBehavior(SMOKE_ATLAS_SHAPE_COUNT, SMOKE_ATLAS_ANIM_FRAMES, {
      ownerEffect: this,
      cyclesParamKey: 'smokeFlipbookCycles',
      defaultCycles: 0,
    });
    const smokeLifecycle = new SmokeLifecycleBehavior(this);
    const smokeUpdraftMag = Math.max(0.0, p.smokeUpdraft ?? 2.5);
    // Top-down play: buoyancy reads on the XY ground plane (+Y) with a Z lift for depth sorting.
    const smokeUpdraftDir = new THREE.Vector3(0, 0.82, 0.28).normalize();
    const smokeUpdraft = new ApplyForce(smokeUpdraftDir, new ConstantValue(smokeUpdraftMag));
    const smokeWindInfluence = Math.max(0.0, p.smokeWindInfluence ?? 1.0);
    const smokeTurbMult = Math.max(0.0, p.smokeTurbulence ?? 1.0);
    const smokeCurlStrengthBase = new THREE.Vector3(200 * smokeTurbMult, 200 * smokeTurbMult, 80 * smokeTurbMult);
    const turbulence = new FixedCurlNoiseField(new THREE.Vector3(100, 100, 40), smokeCurlStrengthBase.clone(), 0.85);
    const smokeForces = new FireForcesBehavior('smoke');
    smokeForces.bindTurbulence(turbulence);
    const outdoorLayer = opts.outdoorLayer === true;

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles,
      emissionOverTime: new IntervalValue(
        10.0 * weight * smokeRatio * 0.5,
        20.0 * weight * smokeRatio * 0.8
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: this._computeSmokeRenderOrder(floorIndex, outdoorLayer),
      uTileCount: SMOKE_ATLAS_COLS,
      vTileCount: SMOKE_ATLAS_ROWS,
      blendTiles: false,
      startTileIndex: new ConstantValue(0),
      startRotation: new ConstantValue(0),
      behaviors: [
        smokeShapeFrames,
        smokeForces,
        smokeLifecycle,
      ],
    });

    system.userData = {
      ownerEffect: this,
      floorIndex,
      updraftForce: smokeUpdraft,
      baseUpdraftMag: smokeUpdraftMag,
      turbulence,
      baseCurlStrength: new THREE.Vector3(200, 200, 80),
      windInfluence: smokeWindInfluence,
      isSmoke: true,
      isOutdoorSmoke: outdoorLayer,
      _msEmissionScale: weight,
      _msMaxParticles: maxParticles,
      _msLifeMin: lifeMin,
      _msLifeMax: lifeMax,
      _msEmissionBaseA: 10.0 * weight * smokeRatio * 0.5,
      _msEmissionBaseB: 20.0 * weight * smokeRatio * 0.8,
      _msEmissionExtraMul: 1,
    };

    this._applyParticleSpawnCap(system, maxParticles);
    this._syncSystemEmission(system, p.globalFireRate ?? 1.0);
    this._finalizeFireParticleSystem(system);

    // Start the system so it becomes active and emits particles.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  // ── Private: Floor switching ───────────────────────────────────────────────

  /** Activate all floors up to the current active floor. @private */
  _activateCurrentFloor() {
    const floorStack = window.MapShine?.floorStack;
    const activeFloor = floorStack?.getActiveFloor();
    // Default to 0 (ground floor only) if active floor not available.
    // Using Infinity would attempt to activate all possible floor indices.
    const maxFloorIndex = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
    log.info(`FireEffectV2: _activateCurrentFloor called, activeFloor=${JSON.stringify(activeFloor)}, maxFloorIndex=${maxFloorIndex}`);
    this.onFloorChange(maxFloorIndex);
  }

  /**
   * Keep each floor's BatchedRenderer + quarks systems in that authored floor's
   * FLOOR_EFFECTS band (between albedo and overhead for the same floor).
   * This preserves expected occlusion by upper layers and avoids globally-lifted
   * fire drawing above geometry that should hide it.
   * @param {number} maxFloorIndex - highest visible floor index (unused; retained for API parity)
   * @private
   */
  _updateBatchRenderOrder(maxFloorIndex) {
    void maxFloorIndex;
    for (const f of this._floorStates.keys()) {
      const state = this._floorStates.get(f);
      if (!state?.batchRenderer) continue;
      const fi = Number(f) || 0;
      const br = state.batchRenderer;
      br.renderOrder = effectUnderOverheadOrder(fi, 0);
      const syncSys = (arr, typeOffset) => {
        for (const sys of arr) {
          if (!sys) continue;
          try {
            sys.renderOrder = this._computeParticleRenderOrder(fi, typeOffset);
          } catch (_) {}
        }
      };
      syncSys(state.systems, 0);
      for (const sys of state.emberSystems) {
        if (!sys) continue;
        try {
          sys.renderOrder = this._computeEmberRenderOrder(fi, sys.userData?.isOutdoorEmber === true);
        } catch (_) {}
      }
      for (const sys of state.smokeSystems) {
        if (!sys) continue;
        try {
          sys.renderOrder = this._computeSmokeRenderOrder(fi, sys.userData?.isOutdoorSmoke === true);
        } catch (_) {}
      }
    }
  }

  /**
   * Compute ember render order — indoor embers under overhead; outdoor above tree/bush canopies.
   * @private
   */
  _computeEmberRenderOrder(floorIndex, outdoorLayer = false) {
    if (outdoorLayer && this.params.smokeOutdoorAboveCanopy !== false) {
      return outdoorSmokeRenderOrder(floorIndex);
    }
    return effectUnderOverheadOrder(floorIndex, 1);
  }

  /**
   * Compute smoke render order — indoor smoke under overhead; outdoor above tree/bush canopies.
   * @private
   */
  _computeSmokeRenderOrder(floorIndex, outdoorLayer = false) {
    if (outdoorLayer && this.params.smokeOutdoorAboveCanopy !== false) {
      return outdoorSmokeRenderOrder(floorIndex);
    }
    return effectUnderOverheadOrder(floorIndex, 2);
  }

  /**
   * Compute particle-system render order within a floor band.
   * Uses FLOOR_EFFECTS role so fire always sits between albedo and overhead.
   * @private
   */
  _computeParticleRenderOrder(floorIndex, typeOffset = 0) {
    const safeTypeOffset = Math.max(0, Math.min(2, Number(typeOffset) || 0));
    return effectUnderOverheadOrder(floorIndex, safeTypeOffset);
  }

  /** Add a floor's systems to that floor's BatchedRenderer + scene. @private */
  _activateFloor(floorIndex) {
    const state = this._floorStates.get(floorIndex);
    const br = state?.batchRenderer;
    if (!state || !br) {
      log.warn(`FireEffectV2: _activateFloor(${floorIndex}) failed - state=${!!state}, batchRenderer=${!!br}`);
      return;
    }

    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    log.info(`FireEffectV2: activating floor ${floorIndex} with ${allSystems.length} systems (${state.systems.length} fire, ${state.emberSystems.length} ember, ${state.smokeSystems.length} smoke)`);
    
    for (const sys of allSystems) {
      try {
        br.addSystem(sys);
      } catch (err) {
        log.warn(`  addSystem() failed:`, err);
      }
      // Emitters must be in the scene graph for three.quarks to update their
      // world matrices. Adding them as children of the BatchedRenderer (which
      // is already in the bus scene) achieves this without exposing the bus's
      // private scene reference.
      if (sys.emitter) {
        try {
          br.add(sys.emitter);
        } catch (err) {
          log.warn(`  Failed to add emitter:`, err);
        }
      }
      if (typeof sys.play === 'function') sys.play();
    }
  }

  /** Remove a specific floor's systems from its BatchedRenderer. @private */
  _deactivateFloor(floorIndex) {
    const state = this._floorStates.get(floorIndex);
    const br = state?.batchRenderer;
    if (!br) return;

    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    for (const sys of allSystems) {
      // Clear live particles so hidden floors do not retain simulation debt.
      if (typeof sys.stop === 'function') {
        try { sys.stop(); } catch (_) {}
      } else if (typeof sys.pause === 'function') {
        try { sys.pause(); } catch (_) {}
      }
      try { br.deleteSystem(sys); } catch (_) {}
      if (sys.emitter) br.remove(sys.emitter);
    }
    log.debug(`FireEffectV2: deactivated floor ${floorIndex}`);
  }

  /** Dispose all systems in a floor state. @private */
  _disposeFloorState(state) {
    const br = state.batchRenderer;
    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    for (const sys of allSystems) {
      try {
        if (br) br.deleteSystem(sys);
      } catch (_) {}
      if (sys.emitter && br) {
        br.remove(sys.emitter);
      }
      // Dispose material.
      try { sys.material?.dispose(); } catch (_) {}
    }
    state.systems.length = 0;
    state.emberSystems.length = 0;
    state.smokeSystems.length = 0;
    state.batchRenderer = null;
  }

  // ── Private: Per-frame param sync ──────────────────────────────────────────

  /** @private */
  _getSystemParamsSignature() {
    const p = this.params;
    return [
      p.globalFireRate,
      p.flameTextureBrightness,
      p.flameTextureOpacity,
      p.flameTextureScaleX,
      p.flameTextureScaleY,
      p.flameTextureOffsetX,
      p.flameTextureOffsetY,
      p.flameTextureRotation,
      p.flameTextureFlipX,
      p.flameTextureFlipY,
      p.fireHeight,
      p.fireUpdraft,
      p.fireCurlStrength,
      p.windInfluence,
      p.emberRate,
      p.emberUpdraft,
      p.emberCurlStrength,
      p.smokeEnabled,
      p.smokeRatio,
      p.smokeUpdraft,
      p.smokeTurbulence,
      p.smokeWindInfluence,
    ].join('|');
  }

  /** Update emission rates, updraft, curl based on current params. @private */
  _updateSystemParams() {
    const signature = this._getSystemParamsSignature();
    if (signature === this._systemParamsSignature) return;
    this._systemParamsSignature = signature;

    const p = this.params;
    const globalRate = Math.max(0.0, p.globalFireRate ?? 1.0);
    const texBright = Math.max(0, Number(p.flameTextureBrightness) || 0);
    const texOpacity = Math.max(0, Math.min(1, Number(p.flameTextureOpacity) ?? 1));
    applyEmberSpriteTextureTransform(this._emberTexture, p);

    for (const floorIndex of this._activeFloors) {
      const state = this._floorStates.get(floorIndex);
      if (!state) continue;
      // Fire systems.
      for (const sys of state.systems) {
        if (sys?.material) {
          if (sys.material.color) sys.material.color.setRGB(texBright, texBright, texBright);
          if (typeof sys.material.opacity === 'number') sys.material.opacity = texOpacity;
        }
        if (!sys?.userData) continue;
        this._syncSystemEmission(sys, globalRate);
        // Updraft.
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = (p.fireHeight ?? 10) * 0.125 * (p.fireUpdraft ?? 1.0);
        // Curl turbulence (CurlNoiseField / FixedCurlNoiseField use `strength`, not `force`).
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.strength && baseCurl) {
          const cs = p.fireCurlStrength ?? 1.0;
          turb.strength.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
        if (sys.userData) sys.userData.windInfluence = p.windInfluence ?? 1.0;
      }

      // Ember systems.
      for (const sys of state.emberSystems) {
        if (sys?.material) {
          if (sys.material.color) sys.material.color.setRGB(texBright, texBright, texBright);
          if (typeof sys.material.opacity === 'number') sys.material.opacity = texOpacity;
        }
        if (!sys?.userData) continue;
        sys.userData._msEmissionExtraMul = p.emberRate ?? 1.0;
        this._syncSystemEmission(sys, globalRate);
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = (p.fireHeight ?? 10) * 0.4 * (p.emberUpdraft ?? 1.0);
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.strength && baseCurl) {
          const cs = p.emberCurlStrength ?? 1.0;
          turb.strength.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
        if (sys.userData) sys.userData.windInfluence = p.windInfluence ?? 1.0;
      }

      // Smoke systems.
      for (const sys of state.smokeSystems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        const smokeRatio = Math.max(0.0, p.smokeRatio ?? 0.3);
        sys.userData._msEmissionBaseA = 10.0 * w * smokeRatio * 0.5;
        sys.userData._msEmissionBaseB = 20.0 * w * smokeRatio * 0.8;
        this._syncSystemEmission(sys, globalRate);
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = Math.max(0.0, p.smokeUpdraft ?? 2.5);
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.strength && baseCurl) {
          const cs = Math.max(0.0, p.smokeTurbulence ?? 1.0);
          turb.strength.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
        if (sys.userData) sys.userData.windInfluence = p.smokeWindInfluence ?? 1.0;
      }
    }
  }

  // ── Private: Texture loading ───────────────────────────────────────────────

  /**
   * Build procedural flame/smoke atlases and load the ember sprite.
   * Returns a promise that resolves when textures are ready for populate().
   * @returns {Promise<void>}
   * @private
   */
  _loadTextures() {
    const THREE = window.THREE;
    if (!THREE) return Promise.resolve();

    try {
      const fireCanvas = ProceduralTextureBuilder.buildFireAtlas(
        FIRE_ATLAS_COLS,
        FIRE_ATLAS_ROWS,
        FIRE_ATLAS_CELL_SIZE
      );
      this._fireTexture = ProceduralTextureBuilder.toTexture(fireCanvas, THREE);

      const smokeCanvas = ProceduralTextureBuilder.buildSmokeAtlas(
        SMOKE_ATLAS_COLS,
        SMOKE_ATLAS_ROWS,
        SMOKE_ATLAS_CELL_SIZE
      );
      this._smokeTexture = ProceduralTextureBuilder.toTexture(smokeCanvas, THREE);
    } catch (err) {
      log.warn('Failed to build procedural fire/smoke textures', err);
    }

    const loader = new THREE.TextureLoader();
    return new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/particle.webp', (tex) => {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        this._emberTexture = tex;
        applyEmberSpriteTextureTransform(this._emberTexture, this.params);
        resolve();
      }, undefined, () => {
        log.warn('Failed to load particle.webp for embers');
        resolve();
      });
    }).then(() => {
      log.info('Fire textures ready (procedural flame/smoke + ember sprite)');
    });
  }

  /**
   * Load an image from URL and return the HTMLImageElement.
   * @private
   */
  _loadImage(url) {
    return this._loadImageInternal(url, { suppressWarn: false });
  }

  /**
   * @param {string} url
   * @param {{ suppressWarn?: boolean }} [opts]
   * @returns {Promise<HTMLImageElement|null>}
   * @private
   */
  _loadImageInternal(url, opts = {}) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        if (!opts?.suppressWarn) log.warn(`Failed to load fire mask image: ${url}`);
        resolve(null);
      };
      img.src = url;
    });
  }

  /**
   * Try loading a mask image by probing common formats via Image() GET.
   * This intentionally avoids FilePicker and HEAD probing, which can fail on
   * some hosted setups even when GET succeeds.
   *
   * @param {string} basePathWithSuffix - e.g. "modules/foo/bar_Map_Fire" (no extension)
   * @returns {Promise<{ url: string, image: HTMLImageElement } | null>}
   * @private
   */
  async _tryLoadMaskImage(basePathWithSuffix, opts = {}) {
    if (!basePathWithSuffix) return null;
    const formats = Array.isArray(opts?.formats) && opts.formats.length ? opts.formats : FIRE_MASK_FORMATS;
    const cacheKey = `${basePathWithSuffix}::${formats.join(',')}`;

    if (this._directMaskCache?.has(cacheKey)) {
      return this._directMaskCache.get(cacheKey);
    }

    for (const ext of formats) {
      const url = `${basePathWithSuffix}.${ext}`;
      const img = await this._loadImageInternal(url, { suppressWarn: true });
      if (img) {
        const hit = { url, image: img };
        this._directMaskCache.set(cacheKey, hit);
        return hit;
      }
    }

    this._directMaskCache.set(cacheKey, null);
    return null;
  }

  // ── Private: Floor resolution ──────────────────────────────────────────────

  /**
   * Must match FloorRenderBus._resolveFloorIndex exactly so _Fire buckets share
   * the same floor band as albedo tiles (floor-depth blur culling depends on it).
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid < f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const v14Idx = resolveV14NativeDocFloorIndexMin(tileDoc, globalThis.canvas?.scene);
    if (v14Idx !== null) return v14Idx;

    // Same FloorCompositor fallback: native level id on the tile vs FloorStack bands.
    try {
      if (hasV14NativeLevels(globalThis.canvas?.scene)) {
        const singleLevel = tileDoc?.level ?? tileDoc?._source?.level;
        if (typeof singleLevel === 'string' && singleLevel.length > 0) {
          for (let i = 0; i < floors.length; i += 1) {
            if (floors[i].levelId === singleLevel) return i;
          }
        }
        const levelsSet = tileDoc?.levels;
        if (levelsSet?.size) {
          for (const lid of levelsSet) {
            for (let i = 0; i < floors.length; i += 1) {
              if (floors[i].levelId === lid) return i;
            }
          }
        }
      }
    } catch (_) {}

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  /** Get the elevation offset for a floor index (for Z positioning). @private */
  _resolveFloorElevation(floorIndex, floors) {
    if (!floors || floorIndex >= floors.length) return 0;
    const f = floors[floorIndex];
    return f?.elevationMin ?? 0;
  }

  /** @private */
  _computeStructuralSignature() {
    const p = this.params || {};
    return REBUILD_PARAM_KEYS.map((k) => `${k}:${Number(p[k] ?? 0).toFixed(4)}`).join('|');
  }

  /** @private */
  _queueRebuild() {
    if (this._rebuildInFlight) {
      this._rebuildQueued = true;
      return;
    }

    const sceneData = this._lastPopulateSceneData;
    if (!sceneData) return;

    this._rebuildInFlight = this.populate(sceneData)
      .catch((err) => {
        log.warn('FireEffectV2: runtime rebuild failed', err);
      })
      .finally(() => {
        this._rebuildInFlight = null;
        if (this._rebuildQueued) {
          this._rebuildQueued = false;
          this._queueRebuild();
        }
      });
  }
}
