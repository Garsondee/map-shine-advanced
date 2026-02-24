/**
 * @fileoverview WaterEffectV2 — V2 water post-processing pass.
 *
 * Applies water tint, wave distortion, caustics, specular (GGX), foam, murk,
 * sand, rain ripples, and chromatic aberration to water areas defined by
 * `_Water` mask textures.
 *
 * Architecture:
 *   1. `populate()` discovers per-tile `_Water` masks via `probeMaskFile()`.
 *   2. Per-floor masks are composited into a single RT by rendering white quads
 *      masked by the water texture into a scene-sized render target.
 *   3. `WaterSurfaceModel.buildFromMaskTexture()` builds SDF data from the
 *      composited mask (R=SDF, G=exposure, BA=normals).
 *   4. The fullscreen water shader reads tWaterData + scene RT to produce the
 *      refracted/tinted/specular output as a post-processing pass.
 *
 * Simplifications vs V1 (layered in as V2 systems come online):
 *   - No EffectMaskRegistry / GpuSceneMaskCompositor
 *   - No DistortionManager integration
 *   - No token mask / cloud shadow / outdoors mask
 *   - No floor transition locks (bus visibility handles floor isolation)
 *
 * @module compositor-v2/effects/WaterEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { WaterSurfaceModel } from '../../effects/WaterSurfaceModel.js';
import { DepthShaderChunks } from '../../effects/DepthShaderChunks.js';
import { getVertexShader, getFragmentShader } from './water-shader.js';

const log = createLogger('WaterEffectV2');

// Bitmask flags for conditional shader defines.
const DEF_SAND        = 1 << 0;
const DEF_FOAM_FLECKS = 1 << 1;
const DEF_MULTITAP    = 1 << 2;
const DEF_CHROM_AB    = 1 << 3;

/**
 * Accept either 0..1 or 0..255 color channels and normalize to 0..1.
 * This keeps V2 tolerant of legacy V1 preset values.
 * @param {{r:number,g:number,b:number}|null|undefined} c
 * @param {{r:number,g:number,b:number}} fallback
 * @returns {{r:number,g:number,b:number}}
 */
function normalizeRgb01(c, fallback = { r: 0, g: 0, b: 0 }) {
  if (!c || typeof c !== 'object') return fallback;
  let r = typeof c.r === 'number' ? c.r : fallback.r;
  let g = typeof c.g === 'number' ? c.g : fallback.g;
  let b = typeof c.b === 'number' ? c.b : fallback.b;
  const maxv = Math.max(r, g, b);
  if (maxv > 1.0) {
    r /= 255.0;
    g /= 255.0;
    b /= 255.0;
  }
  return {
    r: Math.max(0.0, Math.min(1.0, r)),
    g: Math.max(0.0, Math.min(1.0, g)),
    b: Math.max(0.0, Math.min(1.0, b)),
  };
}

// ─── WaterEffectV2 ──────────────────────────────────────────────────────────

export class WaterEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;
    /** @type {boolean} */
    this.enabled = true;

    // ── Effect parameters (V1 defaults for visual parity) ────────────────
    this.params = {
      // Tint
      tintColor: { r: 0.02, g: 0.18, b: 0.28 },
      tintStrength: 0.36,

      // Waves
      waveScale: 4.0,
      waveSpeed: 1.0,
      waveStrength: 0.6,
      distortionStrengthPx: 6.0,
      waveWarpLargeStrength: 0.15,
      waveWarpSmallStrength: 0.08,
      waveWarpMicroStrength: 0.04,
      waveWarpTimeSpeed: 0.15,
      waveEvolutionEnabled: true,
      waveEvolutionSpeed: 0.15,
      waveEvolutionAmount: 0.3,
      waveEvolutionScale: 0.5,
      waveSpeedUseWind: false,
      waveSpeedWindMinFactor: 1.0,
      waveStrengthUseWind: false,
      waveStrengthWindMinFactor: 1.0,
      waveIndoorDampingEnabled: false,
      waveIndoorDampingStrength: 1.0,
      waveIndoorMinFactor: 0.05,
      useTargetWindDirection: false,
      windDirResponsiveness: 10.0,

      // Chromatic aberration
      // Keep enabled by default for V1 visual parity (subtle RGB separation
      // on distortion edges). This was accidentally left disabled in early V2.
      chromaticAberrationEnabled: true,
      chromaticAberrationStrengthPx: 2.5,
      chromaticAberrationEdgeCenter: 0.50,
      chromaticAberrationEdgeFeather: 0.10,
      chromaticAberrationEdgeGamma: 1.0,
      chromaticAberrationEdgeMin: 0.0,

      // Distortion edge masking
      distortionEdgeCenter: 0.50,
      distortionEdgeFeather: 0.06,
      distortionEdgeGamma: 1.0,
      distortionShoreRemapLo: 0.0,
      distortionShoreRemapHi: 1.0,
      distortionShorePow: 1.0,
      distortionShoreMin: 0.0,

      // Refraction
      // Keep multi-tap enabled by default to preserve the softer V1 water look.
      refractionMultiTapEnabled: true,

      // Rain
      rainPrecipitation: 0.0,
      rainDistortionEnabled: true,
      rainDistortionUseWeather: true,
      rainDistortionPrecipitationOverride: 0.0,
      rainIndoorDampingEnabled: true,
      rainIndoorDampingStrength: 1.0,
      rainSplit: 0.5,
      rainBlend: 0.1,
      rainGlobalStrength: 1.0,
      rainRippleStrengthPx: 3.0,
      rainRippleScale: 12.0,
      rainRippleSpeed: 1.0,
      rainRippleDensity: 0.7,
      rainRippleSharpness: 1.0,
      rainRippleJitter: 0.8,
      rainRippleRadiusMin: 0.1,
      rainRippleRadiusMax: 0.45,
      rainRippleWidthScale: 1.0,
      rainRippleSecondaryEnabled: true,
      rainRippleSecondaryStrength: 0.4,
      rainRippleSecondaryPhaseOffset: 0.35,
      rainStormStrengthPx: 8.0,
      rainStormScale: 6.0,
      rainStormSpeed: 0.5,
      rainStormCurl: 1.0,
      rainStormRateBase: 0.6,
      rainStormRateSpeedScale: 0.3,
      rainStormSizeMin: 0.08,
      rainStormSizeMax: 0.35,
      rainStormWidthMinScale: 0.3,
      rainStormWidthMaxScale: 0.8,
      rainStormDecay: 3.0,
      rainStormCoreWeight: 0.6,
      rainStormRingWeight: 0.8,
      rainStormSwirlStrength: 0.6,
      rainStormMicroEnabled: true,
      rainStormMicroStrength: 0.3,
      rainStormMicroScale: 2.5,
      rainStormMicroSpeed: 0.8,
      rainMaxCombinedStrengthPx: 10.0,

      // Wind coupling
      lockWaveTravelToWind: true,
      waveDirOffsetDeg: 0.0,
      waveAppearanceRotDeg: 0.0,
      waveAppearanceOffsetDeg: 0.0,
      advectionDirOffsetDeg: 0.0,
      advectionSpeed01: 0.15,
      advectionSpeed: 1.5,

      // Specular (GGX)
      specStrength: 35.0,
      specPower: 8.0,
      specSunAzimuthDeg: 135.0,
      specSunElevationDeg: 45.0,
      specSunIntensity: 1.0,
      specNormalStrength: 1.2,
      specNormalScale: 0.6,
      specRoughnessMin: 0.15,
      specRoughnessMax: 0.55,
      specF0: 0.04,
      specMaskGamma: 1.5,
      specSkyTint: 0.3,
      specShoreBias: 0.3,
      specDistortionNormalStrength: 0.5,
      specAnisotropy: 0.0,
      specAnisoRatio: 2.0,

      // Cloud shadow modulation
      cloudShadowEnabled: true,
      cloudShadowDarkenStrength: 1.25,
      cloudShadowDarkenCurve: 1.5,
      cloudShadowSpecularKill: 1.0,
      cloudShadowSpecularCurve: 6.0,

      // Caustics
      causticsEnabled: true,
      causticsIntensity: 4.0,
      causticsScale: 33.4,
      causticsSpeed: 1.05,
      causticsSharpness: 0.1,
      causticsEdgeLo: 0.11,
      causticsEdgeHi: 1.0,

      // Foam
      foamColor: { r: 0.85, g: 0.90, b: 0.88 },
      foamStrength: 0.60,
      foamThreshold: 0.28,
      foamScale: 20.0,
      foamSpeed: 0.1,
      foamCurlStrength: 0.35,
      foamCurlScale: 2.0,
      foamCurlSpeed: 0.05,
      foamBreakupStrength1: 0.5,
      foamBreakupScale1: 3.0,
      foamBreakupSpeed1: 0.04,
      foamBreakupStrength2: 0.3,
      foamBreakupScale2: 7.0,
      foamBreakupSpeed2: 0.02,
      foamBlackPoint: 0.0,
      foamWhitePoint: 1.0,
      foamGamma: 1.0,
      foamContrast: 1.0,
      foamBrightness: 0.0,
      floatingFoamStrength: 0.40,
      floatingFoamCoverage: 0.35,
      floatingFoamScale: 8.0,
      floatingFoamWaveDistortion: 0.5,
      foamFlecksEnabled: true,
      foamFlecksIntensity: 0.6,

      // Murk
      murkEnabled: true,
      murkIntensity: 0.4,
      murkColor: { r: 0.15, g: 0.22, b: 0.12 },
      murkScale: 1.2,
      murkSpeed: 0.05,
      murkDepthLo: 0.2,
      murkDepthHi: 0.8,
      murkGrainScale: 80.0,
      murkGrainSpeed: 0.3,
      murkGrainStrength: 0.4,
      murkDepthFade: 1.5,

      // Sand
      sandEnabled: false,
      sandIntensity: 0.5,
      sandColor: { r: 0.76, g: 0.68, b: 0.50 },
      sandContrast: 1.5,
      sandChunkScale: 1.5,
      sandChunkSpeed: 0.02,
      sandGrainScale: 120.0,
      sandGrainSpeed: 0.1,
      sandBillowStrength: 0.4,
      sandCoverage: 0.4,
      sandChunkSoftness: 0.15,
      sandSpeckCoverage: 0.3,
      sandSpeckSoftness: 0.1,
      sandDepthLo: 0.0,
      sandDepthHi: 0.4,
      sandAnisotropy: 0.3,
      sandDistortionStrength: 0.3,
      sandAdditive: 0.15,

      // SDF build
      buildResolution: 2048,
      maskThreshold: 0.15,
      maskChannel: 'auto',
      maskInvert: false,
      maskBlurRadius: 0.0,
      maskBlurPasses: 0,
      maskExpandPx: 0.0,
      sdfRangePx: 64,
      shoreWidthPx: 24,

      // Debug
      debugView: 0,
    };

    // ── Per-floor water state ────────────────────────────────────────────
    // Keyed by floorIndex → { maskRT, waterData, rawMask }
    /** @type {Map<number, object>} */
    this._floorWater = new Map();

    /** @type {number} */
    this._activeFloorIndex = 0;

    // ── Discovered water tiles (populated in populate()) ─────────────────
    /** @type {Array<{tileId: string, basePath: string, floorIndex: number, maskPath: string}>} */
    this._waterTiles = [];

    // ── Surface model ────────────────────────────────────────────────────
    /** @type {WaterSurfaceModel} */
    this._surfaceModel = new WaterSurfaceModel();

    // ── GPU resources (created in initialize()) ──────────────────────────
    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;
    /** @type {THREE.DataTexture|null} */
    this._noiseTexture = null;

    // ── Wind / time state ────────────────────────────────────────────────
    this._windTime = 0;
    this._windOffsetUvX = 0;
    this._windOffsetUvY = 0;
    this._smoothedWindDirX = 1.0;
    this._smoothedWindDirY = 0.0;
    this._lastTimeValue = null;

    // ── Cached sun direction ─────────────────────────────────────────────
    this._cachedSunAzDeg = null;
    this._cachedSunElDeg = null;
    this._cachedSunDirX = 0;
    this._cachedSunDirY = 0;
    this._cachedSunDirZ = 1;

    // ── Defines tracking ─────────────────────────────────────────────────
    this._lastDefinesKey = -1;

    // ── Reusable vectors ─────────────────────────────────────────────────
    this._sizeVec = null;

    log.debug('WaterEffectV2 created');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Resolve advection speed with backward compatibility.
   * V2 uses advectionSpeed01; legacy V1 presets may set advectionSpeed.
   * @param {object} p
   * @returns {number}
   * @private
   */
  _resolveAdvectionSpeed01(p) {
    const direct = Number(p.advectionSpeed01);
    const legacy = Number(p.advectionSpeed);
    // If V2 value is left at the stock default and a legacy value exists,
    // prefer the legacy value for backwards-compatible preset loading.
    if (Number.isFinite(legacy) && (!Number.isFinite(direct) || Math.abs(direct - 0.15) < 1e-6)) {
      return Math.max(0, legacy * 0.1);
    }
    if (Number.isFinite(direct)) return Math.max(0, direct);
    return 0.15;
  }

  /**
   * Resolve wave appearance rotation in degrees with V1 alias compatibility.
   * V2 name: waveAppearanceRotDeg
   * V1 name: waveAppearanceOffsetDeg
   * @param {object} p
   * @returns {number}
   * @private
   */
  _resolveWaveAppearanceDeg(p) {
    const rot = Number(p.waveAppearanceRotDeg);
    const legacy = Number(p.waveAppearanceOffsetDeg);
    if (Number.isFinite(legacy) && (!Number.isFinite(rot) || Math.abs(rot) < 1e-6)) {
      return legacy;
    }
    if (Number.isFinite(rot)) return rot;
    if (Number.isFinite(legacy)) return legacy;
    return 0;
  }

  /**
   * Create GPU resources: fullscreen quad, shader material, noise texture.
   * Call once after FloorCompositor is ready.
   */
  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    this._sizeVec = new THREE.Vector2();

    // Noise texture (512x512 RGBA, deterministic seeded LCG)
    this._noiseTexture = WaterEffectV2._createNoiseTexture(THREE);

    // Build initial defines based on default params
    const defines = {};
    if (this.params.sandEnabled) defines.USE_SAND = 1;
    if (this.params.foamFlecksEnabled) defines.USE_FOAM_FLECKS = 1;
    if (this.params.refractionMultiTapEnabled) defines.USE_WATER_REFRACTION_MULTITAP = 1;
    if (this.params.chromaticAberrationEnabled) defines.USE_WATER_CHROMATIC_ABERRATION = 1;

    // Create shader material with all uniforms
    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: this._buildUniforms(THREE),
      vertexShader: getVertexShader(),
      fragmentShader: getFragmentShader(),
      defines,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    this._composeMaterial.toneMapped = false;

    // Fullscreen quad
    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._composeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._composeMaterial
    );
    this._composeQuad.frustumCulled = false;
    this._composeScene.add(this._composeQuad);

    this._initialized = true;
    log.info('WaterEffectV2 initialized');
  }

  /**
   * Discover _Water masks for all tiles, composite per-floor, build SDF.
   * Call after FloorRenderBus.populate() so tile geometry is already built.
   * @param {object} foundrySceneData - Scene geometry data from SceneComposer
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    const THREE = window.THREE;
    if (!THREE) return;

    // Clear previous state
    this._disposeFloorWater();
    this._waterTiles = [];

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    if (tileDocs.length === 0) { log.info('populate: no tiles'); return; }

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = foundrySceneData?.height ?? canvas?.dimensions?.height ?? 0;

    // ── Step 1: Discover _Water masks per tile ───────────────────────────
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      const waterResult = await probeMaskFile(basePath, '_Water');
      if (!waterResult?.path) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      this._waterTiles.push({
        tileId, basePath, floorIndex,
        maskPath: waterResult.path,
        tileDoc,
      });
    }

    if (this._waterTiles.length === 0) {
      log.warn('WaterEffectV2 populate: no _Water masks found in any tile. Checked', tileDocs.length, 'tiles.');
      return;
    }
    log.info(`WaterEffectV2 populate: found ${this._waterTiles.length} _Water mask(s)`, this._waterTiles.map(t => t.maskPath));

    // ── Step 2: Group tiles by floor ─────────────────────────────────────
    /** @type {Map<number, Array>} */
    const byFloor = new Map();
    for (const entry of this._waterTiles) {
      let arr = byFloor.get(entry.floorIndex);
      if (!arr) { arr = []; byFloor.set(entry.floorIndex, arr); }
      arr.push(entry);
    }

    // ── Step 3: Composite per-floor masks + build SDF ────────────────────
    const sceneRect = canvas?.dimensions?.sceneRect ?? canvas?.dimensions;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width ?? sceneRect?.sceneWidth ?? 1;
    const sceneH = sceneRect?.height ?? sceneRect?.sceneHeight ?? 1;

    for (const [floorIndex, entries] of byFloor) {
      try {
        const floorData = await this._compositeFloorMask(
          THREE, entries, { sceneX, sceneY, sceneW, sceneH }
        );
        if (floorData) {
          this._floorWater.set(floorIndex, floorData);
        }
      } catch (err) {
        log.error(`populate: floor ${floorIndex} mask compositing failed:`, err);
      }
    }

    // ── Step 4: Activate the current floor's water data ──────────────────
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor();
    this._activeFloorIndex = activeFloor?.index ?? 0;
    this._applyFloorWaterData(this._activeFloorIndex);

    log.info(`WaterEffectV2 populated: ${this._waterTiles.length} tile(s), ${this._floorWater.size} floor(s)`);
  }

  /**
   * Composite all water mask images for one floor into a single scene-UV canvas,
   * then build SDF via WaterSurfaceModel.
   *
   * Uses canvas 2D compositing instead of WebGL render targets so that
   * WaterSurfaceModel.buildFromMaskTexture() receives a texture backed by a
   * real HTMLImageElement/canvas (CPU path) rather than an RT texture (which
   * would require the broken GPU readback path).
   *
   * @param {object} THREE
   * @param {Array} entries - Water tile entries for this floor
   * @param {object} sceneGeo - { sceneX, sceneY, sceneW, sceneH }
   * @returns {Promise<{waterData: object, rawMask: THREE.Texture|null}|null>}
   * @private
   */
  async _compositeFloorMask(THREE, entries, sceneGeo) {
    const { sceneX, sceneY, sceneW, sceneH } = sceneGeo;

    // Load all mask images in parallel via HTMLImageElement (gives us CPU pixels)
    const loadImg = (url) => new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        log.warn(`_compositeFloorMask: failed to load ${url}`);
        resolve(null);
      };
      img.src = url;
    });

    const imgPromises = entries.map(e => loadImg(e.maskPath));
    const images = await Promise.all(imgPromises);

    // Filter out failed loads
    const validPairs = [];
    for (let i = 0; i < entries.length; i++) {
      if (images[i]) validPairs.push({ entry: entries[i], img: images[i] });
    }
    if (validPairs.length === 0) {
      log.warn('_compositeFloorMask: all mask images failed to load');
      return null;
    }

    // Determine canvas resolution (proportional to scene, capped at buildResolution)
    const maxRes = this.params.buildResolution || 2048;
    const aspect = sceneW / Math.max(1, sceneH);
    let cvW, cvH;
    if (aspect >= 1) {
      cvW = Math.min(maxRes, maxRes);
      cvH = Math.max(1, Math.round(cvW / aspect));
    } else {
      cvH = Math.min(maxRes, maxRes);
      cvW = Math.max(1, Math.round(cvH * aspect));
    }
    cvW = Math.max(8, Math.min(maxRes, cvW));
    cvH = Math.max(8, Math.min(maxRes, cvH));

    // Create a canvas and composite all tile masks into it at their scene-UV positions
    const canvas = document.createElement('canvas');
    canvas.width = cvW;
    canvas.height = cvH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      log.warn('_compositeFloorMask: failed to get 2D context');
      return null;
    }
    ctx.clearRect(0, 0, cvW, cvH);

    for (const { entry, img } of validPairs) {
      const td = entry.tileDoc;
      const tileW = td.width ?? 0;
      const tileH = td.height ?? 0;
      if (tileW <= 0 || tileH <= 0) continue;

      const tileX = td.x ?? 0;
      const tileY = td.y ?? 0;

      // Map tile Foundry rect → canvas pixel rect
      const px = ((tileX - sceneX) / sceneW) * cvW;
      const py = ((tileY - sceneY) / sceneH) * cvH;
      const pw = (tileW / sceneW) * cvW;
      const ph = (tileH / sceneH) * cvH;

      if (typeof td.rotation === 'number' && td.rotation !== 0) {
        // Rotate around tile center
        const cx = px + pw / 2;
        const cy = py + ph / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((td.rotation * Math.PI) / 180);
        ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
      } else {
        ctx.drawImage(img, px, py, pw, ph);
      }
    }

    // Wrap the canvas in a THREE.CanvasTexture so buildFromMaskTexture gets a
    // real image-backed texture (CPU path, not RT readback path)
    const canvasTex = new THREE.CanvasTexture(canvas);
    canvasTex.flipY = false;
    canvasTex.needsUpdate = true;

    // Build SDF from the composited canvas texture
    let waterData = null;
    try {
      waterData = this._surfaceModel.buildFromMaskTexture(canvasTex, {
        resolution: this.params.buildResolution || 2048,
        threshold: this.params.maskThreshold ?? 0.65,
        channel: this.params.maskChannel ?? 'luma',
        invert: !!this.params.maskInvert,
        blurRadius: this.params.maskBlurRadius ?? 0.0,
        blurPasses: this.params.maskBlurPasses ?? 0,
        expandPx: this.params.maskExpandPx ?? -0.3,
        sdfRangePx: this.params.sdfRangePx ?? 12,
        exposureWidthPx: this.params.shoreWidthPx ?? 128,
      });
    } catch (err) {
      log.error('_compositeFloorMask: SDF build failed:', err);
      canvasTex.dispose();
      return null;
    }

    // CanvasTexture is no longer needed once SDF is built (CPU data was consumed)
    canvasTex.dispose();

    if (!waterData?.hasWater) {
      log.info('_compositeFloorMask: mask found but no water pixels above threshold');
      return null;
    }

    const rawMask = waterData?.rawMaskTexture ?? null;
    return { waterData, rawMask };
  }

  /**
   * Apply a floor's water data textures to the shader uniforms.
   * @param {number} floorIndex
   * @private
   */
  _applyFloorWaterData(floorIndex) {
    if (!this._composeMaterial) return;
    const u = this._composeMaterial.uniforms;
    const floorData = this._floorWater.get(floorIndex);

    // floorData = { waterData: { texture, rawMaskTexture, hasWater, ... }, rawMask }
    const sdfTex = floorData?.waterData?.texture ?? null;
    if (sdfTex) {
      u.tWaterData.value = sdfTex;
      u.uHasWaterData.value = 1.0;

      // Update texel size based on actual SDF texture dimensions
      if (sdfTex.image) {
        const w = sdfTex.image.width || 2048;
        const h = sdfTex.image.height || 2048;
        u.uWaterDataTexelSize.value.set(1.0 / w, 1.0 / h);
      }
    } else {
      u.uHasWaterData.value = 0.0;
    }

    const rawMaskTex = floorData?.rawMask ?? null;
    if (rawMaskTex) {
      u.tWaterRawMask.value = rawMaskTex;
      u.uHasWaterRawMask.value = 1.0;
    } else {
      u.uHasWaterRawMask.value = 0.0;
    }
  }

  /**
   * Feed active-floor water data to legacy WeatherParticles foam systems.
   * @param {number} elapsedSeconds
   * @private
   */
  _syncLegacyFoamParticles(elapsedSeconds) {
    try {
      const wp = window.MapShineParticles?.weatherParticles;
      if (!wp) return;

      const floorData = this._floorWater.get(this._activeFloorIndex);
      const waterDataTex = floorData?.waterData?.texture ?? null;

      // Optional scene bounds for world->scene UV mapping on particle behaviors.
      let sceneBounds = null;
      const THREE = window.THREE;
      const dims = canvas?.dimensions;
      if (THREE && dims) {
        const rect = dims.sceneRect ?? dims;
        const sx = rect?.x ?? dims.sceneX ?? 0;
        const sy = rect?.y ?? dims.sceneY ?? 0;
        const sw = rect?.width ?? dims.sceneWidth ?? dims.width ?? 1;
        const sh = rect?.height ?? dims.sceneHeight ?? dims.height ?? 1;
        sceneBounds = new THREE.Vector4(sx, sy, sw, sh);
      }

      if (typeof wp.setWaterDataTexture === 'function') {
        wp.setWaterDataTexture(waterDataTex, sceneBounds);
      }
      if (typeof wp.setFoamParams === 'function') {
        wp.setFoamParams(this.params, elapsedSeconds);
      }
    } catch (_) {}
  }

  /**
   * Dispose all per-floor water data.
   * @private
   */
  _disposeFloorWater() {
    for (const [, data] of this._floorWater) {
      // waterData holds the SDF texture + rawMaskTexture (DataTextures)
      try { data.waterData?.texture?.dispose(); } catch (_) {}
      try { data.waterData?.rawMaskTexture?.dispose(); } catch (_) {}
      // rawMask is a reference to waterData.rawMaskTexture — already disposed above
    }
    this._floorWater.clear();
  }

  /**
   * Per-frame update. Syncs all time-varying uniforms from params.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    const u = this._composeMaterial.uniforms;
    const p = this.params;
    const dt = timeInfo.delta || 0;
    const elapsed = timeInfo.elapsed || 0;

    // ── Time ──────────────────────────────────────────────────────────────
    u.uTime.value = elapsed;

    // ── Wind state (WeatherController-coupled with deterministic fallback) ──
    // Keep fallback values stable so the effect behaves consistently when weather
    // is disabled/unavailable.
    let windDirX = 1.0;
    let windDirY = 0.0;
    let windSpeed01 = 0.15;
    try {
      const ws = weatherController?.getCurrentState?.();
      if (ws) {
        const wx = Number(ws.windDirection?.x);
        const wy = Number(ws.windDirection?.y);
        const wv = Number(ws.windSpeed);
        if (Number.isFinite(wx) && Number.isFinite(wy)) {
          const len = Math.hypot(wx, wy);
          if (len > 1e-5) {
            windDirX = wx / len;
            windDirY = wy / len;
          }
        }
        if (Number.isFinite(wv)) windSpeed01 = Math.max(0, Math.min(1, wv));
      }
    } catch (_) {}

    // Optional wind-direction smoothing (legacy V1 behavior parity).
    if (p.useTargetWindDirection) {
      const responsiveness = Math.max(0, Number(p.windDirResponsiveness) || 0);
      const lerpT = 1.0 - Math.exp(-responsiveness * dt);
      this._smoothedWindDirX += (windDirX - this._smoothedWindDirX) * lerpT;
      this._smoothedWindDirY += (windDirY - this._smoothedWindDirY) * lerpT;
      const smoothLen = Math.hypot(this._smoothedWindDirX, this._smoothedWindDirY);
      if (smoothLen > 1e-5) {
        windDirX = this._smoothedWindDirX / smoothLen;
        windDirY = this._smoothedWindDirY / smoothLen;
      }
    }

    this._windTime += dt * windSpeed01;
    u.uWindTime.value = this._windTime;
    u.uWindDir.value.set(windDirX, windDirY);
    u.uWindSpeed.value = windSpeed01;

    // Advection offset (UV drift from wind)
    const advSpeed = this._resolveAdvectionSpeed01(p);
    const advDeg = p.advectionDirOffsetDeg ?? 0;
    const advRad = advDeg * (Math.PI / 180);
    const advDirX = windDirX * Math.cos(advRad) - windDirY * Math.sin(advRad);
    const advDirY = windDirX * Math.sin(advRad) + windDirY * Math.cos(advRad);
    this._windOffsetUvX += advDirX * windSpeed01 * advSpeed * dt;
    this._windOffsetUvY += advDirY * windSpeed01 * advSpeed * dt;
    u.uWindOffsetUv.value.set(this._windOffsetUvX, this._windOffsetUvY);

    // ── Enable ────────────────────────────────────────────────────────────
    u.uWaterEnabled.value = this.enabled ? 1.0 : 0.0;

    // ── Tint ──────────────────────────────────────────────────────────────
    const tint = normalizeRgb01(p.tintColor, { r: 0.02, g: 0.18, b: 0.28 });
    u.uTintColor.value.set(tint.r, tint.g, tint.b);
    u.uTintStrength.value = p.tintStrength;

    // ── Waves ─────────────────────────────────────────────────────────────
    const waveSpeed = (p.waveSpeedUseWind ? Math.max(p.waveSpeedWindMinFactor ?? 1.0, windSpeed01) : 1.0) * (p.waveSpeed ?? 1.0);
    const waveStrength = (p.waveStrengthUseWind ? Math.max(p.waveStrengthWindMinFactor ?? 1.0, windSpeed01) : 1.0) * (p.waveStrength ?? 0.6);
    u.uWaveScale.value = p.waveScale;
    u.uWaveSpeed.value = waveSpeed;
    u.uWaveStrength.value = waveStrength;
    u.uDistortionStrengthPx.value = p.distortionStrengthPx;
    u.uWaveWarpLargeStrength.value = p.waveWarpLargeStrength;
    u.uWaveWarpSmallStrength.value = p.waveWarpSmallStrength;
    u.uWaveWarpMicroStrength.value = p.waveWarpMicroStrength;
    u.uWaveWarpTimeSpeed.value = p.waveWarpTimeSpeed;
    u.uWaveEvolutionEnabled.value = p.waveEvolutionEnabled ? 1.0 : 0.0;
    u.uWaveEvolutionSpeed.value = p.waveEvolutionSpeed;
    u.uWaveEvolutionAmount.value = p.waveEvolutionAmount;
    u.uWaveEvolutionScale.value = p.waveEvolutionScale;
    u.uWaveIndoorDampingEnabled.value = p.waveIndoorDampingEnabled ? 1.0 : 0.0;
    u.uWaveIndoorDampingStrength.value = p.waveIndoorDampingStrength ?? 1.0;
    u.uWaveIndoorMinFactor.value = p.waveIndoorMinFactor ?? 0.05;

    // ── Wave direction ────────────────────────────────────────────────────
    u.uLockWaveTravelToWind.value = p.lockWaveTravelToWind ? 1.0 : 0.0;
    u.uWaveDirOffsetRad.value = (p.waveDirOffsetDeg ?? 0) * (Math.PI / 180);
    const waveAppearanceDeg = this._resolveWaveAppearanceDeg(p);
    u.uWaveAppearanceRotRad.value = waveAppearanceDeg * (Math.PI / 180);

    // ── Distortion edge ───────────────────────────────────────────────────
    u.uDistortionEdgeCenter.value = p.distortionEdgeCenter;
    u.uDistortionEdgeFeather.value = p.distortionEdgeFeather;
    u.uDistortionEdgeGamma.value = p.distortionEdgeGamma;
    u.uDistortionShoreRemapLo.value = p.distortionShoreRemapLo;
    u.uDistortionShoreRemapHi.value = p.distortionShoreRemapHi;
    u.uDistortionShorePow.value = p.distortionShorePow;
    u.uDistortionShoreMin.value = p.distortionShoreMin;

    // ── Chromatic aberration ──────────────────────────────────────────────
    u.uChromaticAberrationStrengthPx.value = p.chromaticAberrationStrengthPx;
    u.uChromaticAberrationEdgeCenter.value = p.chromaticAberrationEdgeCenter;
    u.uChromaticAberrationEdgeFeather.value = p.chromaticAberrationEdgeFeather;
    u.uChromaticAberrationEdgeGamma.value = p.chromaticAberrationEdgeGamma;
    u.uChromaticAberrationEdgeMin.value = p.chromaticAberrationEdgeMin;

    // ── Rain (parameter + WeatherController coupling) ─────────────────────
    // Preserve manual tuning (`rainPrecipitation`) but allow live weather to
    // drive intensity when it is stronger.
    let precip = p.rainPrecipitation ?? 0;
    const rainDistortionEnabled = (p.rainDistortionEnabled ?? true) !== false;
    if (!rainDistortionEnabled) {
      precip = 0;
    } else {
      const rainUseWeather = (p.rainDistortionUseWeather ?? true) !== false;
      if (!rainUseWeather) {
        precip = Math.max(0, Math.min(1, Number(p.rainDistortionPrecipitationOverride ?? precip) || 0));
      } else {
        try {
          const ws = weatherController?.getCurrentState?.();
          const weatherPrecip = Number(ws?.precipitation);
          const precipType = Number(ws?.precipType);
          // Treat type=1 (RAIN) and type=3 (HAIL) as liquid precipitation coupling.
          const isLiquid = (precipType === 1 || precipType === 3);
          if (isLiquid && Number.isFinite(weatherPrecip)) {
            precip = Math.max(precip, Math.max(0, Math.min(1, weatherPrecip)));
          }
        } catch (_) {}
      }
    }
    u.uRainEnabled.value = precip > 0.001 ? 1.0 : 0.0;
    u.uRainPrecipitation.value = precip;
    u.uRainSplit.value = (p.rainDistortionSplit ?? p.rainSplit ?? 0.5);
    u.uRainBlend.value = (p.rainDistortionBlend ?? p.rainBlend ?? 0.1);
    const rainGlobalStrength = (p.rainDistortionGlobalStrength ?? p.rainGlobalStrength ?? 1.0);
    u.uRainGlobalStrength.value = rainGlobalStrength;
    u.uRainIndoorDampingEnabled.value = p.rainIndoorDampingEnabled ? 1.0 : 0.0;
    u.uRainIndoorDampingStrength.value = p.rainIndoorDampingStrength ?? 1.0;
    u.uRainRippleStrengthPx.value = p.rainRippleStrengthPx;
    u.uRainRippleScale.value = p.rainRippleScale;
    u.uRainRippleSpeed.value = p.rainRippleSpeed;
    u.uRainRippleDensity.value = p.rainRippleDensity;
    u.uRainRippleSharpness.value = p.rainRippleSharpness;
    u.uRainRippleJitter.value = p.rainRippleJitter;
    u.uRainRippleRadiusMin.value = p.rainRippleRadiusMin;
    u.uRainRippleRadiusMax.value = p.rainRippleRadiusMax;
    u.uRainRippleWidthScale.value = p.rainRippleWidthScale;
    u.uRainRippleSecondaryEnabled.value = p.rainRippleSecondaryEnabled ? 1.0 : 0.0;
    u.uRainRippleSecondaryStrength.value = p.rainRippleSecondaryStrength;
    u.uRainRippleSecondaryPhaseOffset.value = p.rainRippleSecondaryPhaseOffset;
    u.uRainStormStrengthPx.value = p.rainStormStrengthPx;
    u.uRainStormScale.value = p.rainStormScale;
    u.uRainStormSpeed.value = p.rainStormSpeed;
    u.uRainStormCurl.value = p.rainStormCurl;
    u.uRainStormRateBase.value = p.rainStormRateBase;
    u.uRainStormRateSpeedScale.value = p.rainStormRateSpeedScale;
    u.uRainStormSizeMin.value = p.rainStormSizeMin;
    u.uRainStormSizeMax.value = p.rainStormSizeMax;
    u.uRainStormWidthMinScale.value = p.rainStormWidthMinScale;
    u.uRainStormWidthMaxScale.value = p.rainStormWidthMaxScale;
    u.uRainStormDecay.value = p.rainStormDecay;
    u.uRainStormCoreWeight.value = p.rainStormCoreWeight;
    u.uRainStormRingWeight.value = p.rainStormRingWeight;
    u.uRainStormSwirlStrength.value = p.rainStormSwirlStrength;
    u.uRainStormMicroEnabled.value = p.rainStormMicroEnabled ? 1.0 : 0.0;
    u.uRainStormMicroStrength.value = p.rainStormMicroStrength;
    u.uRainStormMicroScale.value = p.rainStormMicroScale;
    u.uRainStormMicroSpeed.value = p.rainStormMicroSpeed;
    u.uRainMaxCombinedStrengthPx.value = p.rainMaxCombinedStrengthPx;

    // ── Specular (GGX) ───────────────────────────────────────────────────
    u.uSpecStrength.value = p.specStrength;
    u.uSpecPower.value = p.specPower;
    u.uSpecSunIntensity.value = p.specSunIntensity;
    u.uSpecNormalStrength.value = p.specNormalStrength;
    u.uSpecNormalScale.value = p.specNormalScale;
    u.uSpecRoughnessMin.value = p.specRoughnessMin;
    u.uSpecRoughnessMax.value = p.specRoughnessMax;
    u.uSpecF0.value = p.specF0;
    u.uSpecMaskGamma.value = p.specMaskGamma;
    u.uSpecSkyTint.value = p.specSkyTint;
    u.uSpecShoreBias.value = p.specShoreBias;
    u.uSpecDistortionNormalStrength.value = p.specDistortionNormalStrength;
    u.uSpecAnisotropy.value = p.specAnisotropy;
    u.uSpecAnisoRatio.value = p.specAnisoRatio;
    u.uCloudShadowEnabled.value = p.cloudShadowEnabled ? 1.0 : 0.0;
    u.uCloudShadowDarkenStrength.value = p.cloudShadowDarkenStrength ?? 1.25;
    u.uCloudShadowDarkenCurve.value = p.cloudShadowDarkenCurve ?? 1.5;
    u.uCloudShadowSpecularKill.value = p.cloudShadowSpecularKill ?? 1.0;
    u.uCloudShadowSpecularCurve.value = p.cloudShadowSpecularCurve ?? 6.0;

    // Caustics
    u.uCausticsEnabled.value = p.causticsEnabled ? 1.0 : 0.0;
    u.uCausticsIntensity.value = p.causticsIntensity ?? 4.0;
    u.uCausticsScale.value = p.causticsScale ?? 33.4;
    u.uCausticsSpeed.value = p.causticsSpeed ?? 1.05;
    u.uCausticsSharpness.value = p.causticsSharpness ?? 0.1;
    u.uCausticsEdgeLo.value = p.causticsEdgeLo ?? 0.11;
    u.uCausticsEdgeHi.value = p.causticsEdgeHi ?? 1.0;

    // Sun direction from azimuth + elevation (cached to avoid per-frame trig)
    const az = p.specSunAzimuthDeg ?? 135;
    const el = p.specSunElevationDeg ?? 45;
    if (az !== this._cachedSunAzDeg || el !== this._cachedSunElDeg) {
      const azRad = az * (Math.PI / 180);
      const elRad = el * (Math.PI / 180);
      this._cachedSunDirX = Math.cos(elRad) * Math.sin(azRad);
      this._cachedSunDirY = Math.cos(elRad) * Math.cos(azRad);
      this._cachedSunDirZ = Math.sin(elRad);
      this._cachedSunAzDeg = az;
      this._cachedSunElDeg = el;
    }
    u.uSpecSunDir.value.set(this._cachedSunDirX, this._cachedSunDirY, this._cachedSunDirZ);

    // ── Foam ──────────────────────────────────────────────────────────────
    const foamColor = normalizeRgb01(p.foamColor, { r: 0.85, g: 0.9, b: 0.88 });
    u.uFoamColor.value.set(foamColor.r, foamColor.g, foamColor.b);
    u.uFoamStrength.value = p.foamStrength;
    u.uFoamThreshold.value = p.foamThreshold;
    u.uFoamScale.value = p.foamScale;
    u.uFoamSpeed.value = p.foamSpeed;
    u.uFoamCurlStrength.value = p.foamCurlStrength;
    u.uFoamCurlScale.value = p.foamCurlScale;
    u.uFoamCurlSpeed.value = p.foamCurlSpeed;
    u.uFoamBreakupStrength1.value = p.foamBreakupStrength1;
    u.uFoamBreakupScale1.value = p.foamBreakupScale1;
    u.uFoamBreakupSpeed1.value = p.foamBreakupSpeed1;
    u.uFoamBreakupStrength2.value = p.foamBreakupStrength2;
    u.uFoamBreakupScale2.value = p.foamBreakupScale2;
    u.uFoamBreakupSpeed2.value = p.foamBreakupSpeed2;
    u.uFoamBlackPoint.value = p.foamBlackPoint;
    u.uFoamWhitePoint.value = p.foamWhitePoint;
    u.uFoamGamma.value = p.foamGamma;
    u.uFoamContrast.value = p.foamContrast;
    u.uFoamBrightness.value = p.foamBrightness;
    u.uFloatingFoamStrength.value = p.floatingFoamStrength;
    u.uFloatingFoamCoverage.value = p.floatingFoamCoverage;
    u.uFloatingFoamScale.value = p.floatingFoamScale;
    u.uFloatingFoamWaveDistortion.value = p.floatingFoamWaveDistortion;
    u.uFoamFlecksIntensity.value = p.foamFlecksIntensity;

    // ── Murk ──────────────────────────────────────────────────────────────
    u.uMurkEnabled.value = p.murkEnabled ? 1.0 : 0.0;
    u.uMurkIntensity.value = p.murkIntensity;
    const murkColor = normalizeRgb01(p.murkColor, { r: 0.15, g: 0.22, b: 0.12 });
    u.uMurkColor.value.set(murkColor.r, murkColor.g, murkColor.b);
    u.uMurkScale.value = p.murkScale;
    u.uMurkSpeed.value = p.murkSpeed;
    u.uMurkDepthLo.value = p.murkDepthLo;
    u.uMurkDepthHi.value = p.murkDepthHi;
    u.uMurkGrainScale.value = p.murkGrainScale;
    u.uMurkGrainSpeed.value = p.murkGrainSpeed;
    u.uMurkGrainStrength.value = p.murkGrainStrength;
    u.uMurkDepthFade.value = p.murkDepthFade;

    // ── Sand ──────────────────────────────────────────────────────────────
    u.uSandIntensity.value = p.sandIntensity;
    const sandColor = normalizeRgb01(p.sandColor, { r: 0.76, g: 0.68, b: 0.5 });
    u.uSandColor.value.set(sandColor.r, sandColor.g, sandColor.b);
    u.uSandContrast.value = p.sandContrast;
    u.uSandChunkScale.value = p.sandChunkScale;
    u.uSandChunkSpeed.value = p.sandChunkSpeed;
    u.uSandGrainScale.value = p.sandGrainScale;
    u.uSandGrainSpeed.value = p.sandGrainSpeed;
    u.uSandBillowStrength.value = p.sandBillowStrength;
    u.uSandCoverage.value = p.sandCoverage;
    u.uSandChunkSoftness.value = p.sandChunkSoftness;
    u.uSandSpeckCoverage.value = p.sandSpeckCoverage;
    u.uSandSpeckSoftness.value = p.sandSpeckSoftness;
    u.uSandDepthLo.value = p.sandDepthLo;
    u.uSandDepthHi.value = p.sandDepthHi;
    u.uSandAnisotropy.value = p.sandAnisotropy;
    u.uSandDistortionStrength.value = p.sandDistortionStrength;
    u.uSandAdditive.value = p.sandAdditive;

    // ── Debug ─────────────────────────────────────────────────────────────
    u.uDebugView.value = p.debugView ?? 0;

    // ── Legacy foam particle bridge ───────────────────────────────────────
    // WeatherParticles already has mature foam.webp spawning/behavior logic.
    // Feed it the active floor's WaterData + current water params so V2 keeps
    // foam particle complexity while the post water shader remains authoritative.
    this._syncLegacyFoamParticles(elapsed);

    // ── Foundry environment ───────────────────────────────────────────────
    try {
      u.uSceneDarkness.value = canvas?.environment?.darknessLevel ?? 0;
    } catch (_) {}

    // ── Shader defines (conditional compilation) ──────────────────────────
    const sandEnabled = !!p.sandEnabled;
    const flecksEnabled = !!p.foamFlecksEnabled;
    const multiTapEnabled = !!p.refractionMultiTapEnabled;
    const chromEnabled = !!p.chromaticAberrationEnabled;
    const definesKey = (sandEnabled ? DEF_SAND : 0)
      | (flecksEnabled ? DEF_FOAM_FLECKS : 0)
      | (multiTapEnabled ? DEF_MULTITAP : 0)
      | (chromEnabled ? DEF_CHROM_AB : 0);

    if (definesKey !== this._lastDefinesKey) {
      const d = this._composeMaterial.defines || {};
      if (sandEnabled) d.USE_SAND = 1; else delete d.USE_SAND;
      if (flecksEnabled) d.USE_FOAM_FLECKS = 1; else delete d.USE_FOAM_FLECKS;
      if (multiTapEnabled) d.USE_WATER_REFRACTION_MULTITAP = 1; else delete d.USE_WATER_REFRACTION_MULTITAP;
      if (chromEnabled) d.USE_WATER_CHROMATIC_ABERRATION = 1; else delete d.USE_WATER_CHROMATIC_ABERRATION;
      this._composeMaterial.defines = d;
      this._composeMaterial.needsUpdate = true;
      this._lastDefinesKey = definesKey;
    }
  }

  /**
   * Post-processing render pass: reads inputRT, writes water effect to outputRT.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   * @param {THREE.WebGLRenderTarget|null} [occluderRT=null] - Screen-space alpha mask of
   *   upper-floor tiles. Alpha > 0 means the pixel is covered and water should be skipped.
   */
  render(renderer, camera, inputRT, outputRT, occluderRT = null) {
    if (!this._initialized || !this._composeMaterial || !inputRT) return;
    const u = this._composeMaterial.uniforms;

    // ── Bind input texture ────────────────────────────────────────────────
    u.tDiffuse.value = inputRT.texture;

    // ── Upper-floor occluder mask (screen-space) ─────────────────────────
    // Provided by FloorCompositor (rendered from upper-floor tiles).
    // Validated behavior: this is the primary masking path that keeps lower-floor
    // water visible through real openings while fully suppressing water under
    // upper-floor geometry.
    const occ = occluderRT?.texture ?? null;
    if (u.tWaterOccluderAlpha && u.uHasWaterOccluderAlpha) {
      u.tWaterOccluderAlpha.value = occ;
      u.uHasWaterOccluderAlpha.value = occ ? 1.0 : 0.0;
    }

    // Outdoors mask (world-space scene UV) for indoor damping paths.
    if (u.tOutdoorsMask && u.uHasOutdoorsMask) {
      let outdoorsTex = null;
      let outdoorsRec = null;
      try {
        const mm = window.MapShine?.maskManager;
        outdoorsTex = mm?.getTexture?.('outdoors') ?? null;
        outdoorsRec = mm?.textures?.get?.('outdoors') ?? null;
      } catch (_) {}
      u.tOutdoorsMask.value = outdoorsTex;
      u.uHasOutdoorsMask.value = outdoorsTex ? 1.0 : 0.0;
      if (u.uOutdoorsMaskFlipY) {
        const metaFlipY = (outdoorsRec && typeof outdoorsRec.uvFlipY === 'boolean') ? outdoorsRec.uvFlipY : null;
        const flip = (metaFlipY !== null) ? metaFlipY : (outdoorsTex?.flipY ?? false);
        u.uOutdoorsMaskFlipY.value = flip ? 1.0 : 0.0;
      }
    }

    // Cloud shadow texture (screen-space).
    if (u.tCloudShadow && u.uHasCloudShadow) {
      let cloudTex = null;
      try {
        const mm = window.MapShine?.maskManager;
        cloudTex = mm?.getTexture?.('cloudShadow') ?? null;
      } catch (_) {}
      u.tCloudShadow.value = cloudTex;
      u.uHasCloudShadow.value = cloudTex ? 1.0 : 0.0;
    }

    // Active level elevation for depth-relative occlusion.
    if (u.uActiveLevelElevation) {
      const activeBottom = Number(window.MapShine?.activeLevelContext?.bottom);
      u.uActiveLevelElevation.value = Number.isFinite(activeBottom) ? activeBottom : 0.0;
    }

    // ── Depth pass binding (for upper-floor occlusion) ───────────────────
    DepthShaderChunks.bindDepthPass(u);

    // ── Resolution ────────────────────────────────────────────────────────
    renderer.getDrawingBufferSize(this._sizeVec);
    const w = Math.max(1, this._sizeVec.x);
    const h = Math.max(1, this._sizeVec.y);
    u.uResolution.value.set(w, h);

    // ── Zoom (FOV-based from sceneComposer) ───────────────────────────────
    try {
      u.uZoom.value = window.MapShine?.sceneComposer?.currentZoom ?? 1.0;
    } catch (_) {
      u.uZoom.value = 1.0;
    }

    // ── View bounds (Three.js world-space frustum on the ground plane) ────
    // Reconstruct the four corners of the camera frustum at the ground Z.
    try {
      const THREE = window.THREE;
      if (camera && THREE) {
        // Perspective camera needs ray intersection with the ground plane.
        // The previous implementation unprojected NDC corners at z=0 which
        // corresponds to the near plane, causing unstable/incorrect bounds.
        if (camera.isOrthographicCamera) {
          const camPos = camera.position;
          const minX = camPos.x + camera.left / camera.zoom;
          const maxX = camPos.x + camera.right / camera.zoom;
          const minY = camPos.y + camera.bottom / camera.zoom;
          const maxY = camPos.y + camera.top / camera.zoom;
          u.uViewBounds.value.set(minX, minY, maxX, maxY);
        } else if (camera.isPerspectiveCamera) {
          const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
          const ndc = new THREE.Vector3();
          const world = new THREE.Vector3();
          const dir = new THREE.Vector3();

          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;

          // NDC corners (same set used by V1)
          const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
          for (const c of corners) {
            ndc.set(c[0], c[1], 0.5);
            world.copy(ndc).unproject(camera);
            dir.copy(world).sub(camera.position);
            const dz = dir.z;
            if (Math.abs(dz) < 1e-6) continue;
            const t = (groundZ - camera.position.z) / dz;
            if (!Number.isFinite(t) || t <= 0) continue;

            const ix = camera.position.x + dir.x * t;
            const iy = camera.position.y + dir.y * t;

            if (ix < minX) minX = ix;
            if (iy < minY) minY = iy;
            if (ix > maxX) maxX = ix;
            if (iy > maxY) maxY = iy;
          }

          if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
            u.uViewBounds.value.set(minX, minY, maxX, maxY);
          }
        }
      }
    } catch (_) { /* view bounds remain as last set */ }

    // ── Scene dimensions + rect ───────────────────────────────────────────
    try {
      const dims = canvas?.dimensions;
      if (dims) {
        const totalW = dims.width ?? 1;
        const totalH = dims.height ?? 1;
        u.uSceneDimensions.value.set(totalW, totalH);

        const rect = dims.sceneRect ?? dims;
        const sx = rect.x ?? dims.sceneX ?? 0;
        const sy = rect.y ?? dims.sceneY ?? 0;
        const sw = rect.width ?? dims.sceneWidth ?? totalW;
        const sh = rect.height ?? dims.sceneHeight ?? totalH;
        u.uSceneRect.value.set(sx, sy, sw, sh);
        u.uHasSceneRect.value = 1.0;
      }
    } catch (_) {}

    // ── Sky color (from V1 skyColor if available) ─────────────────────────
    try {
      const skyEffect = window.MapShine?.effectComposer?.effects?.get('sky-color');
      if (skyEffect) {
        const sc = skyEffect.skyColor;
        if (sc) {
          u.uSkyColor.value.set(
            sc.r ?? 0.5, sc.g ?? 0.6, sc.b ?? 0.8
          );
          u.uSkyIntensity.value = skyEffect.skyIntensity ?? 0.5;
        }
      }
    } catch (_) {}

    // ── Render post-processing pass ───────────────────────────────────────
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * Handle floor change — swap active water SDF data.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;
    // Find the highest floor index that has water data and is <= maxFloorIndex.
    // This handles the common case where water is only on floor 0.
    let bestFloor = -1;
    for (const floorIndex of this._floorWater.keys()) {
      if (floorIndex <= maxFloorIndex && floorIndex > bestFloor) {
        bestFloor = floorIndex;
      }
    }

    if (bestFloor >= 0 && bestFloor !== this._activeFloorIndex) {
      this._activeFloorIndex = bestFloor;
      this._applyFloorWaterData(bestFloor);
      log.debug(`WaterEffectV2: switched to floor ${bestFloor} water data`);
    } else if (bestFloor < 0) {
      // No water on any visible floor — disable water data
      if (this._composeMaterial) {
        this._composeMaterial.uniforms.uHasWaterData.value = 0.0;
        this._composeMaterial.uniforms.uHasWaterRawMask.value = 0.0;
      }
    }
  }

  /**
   * Resize handler (no internal RTs to resize for the compose pass itself,
   * but mask RTs may need rebuilding if we ever tie them to screen resolution).
   */
  onResize(w, h) {
    // No-op for now. Mask RTs are scene-resolution, not screen-resolution.
  }

  /**
   * Full dispose — call on scene teardown.
   */
  dispose() {
    // Dispose per-floor water data (mask RTs, SDF textures, raw masks)
    this._disposeFloorWater();
    this._waterTiles = [];

    // Dispose compose quad resources
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;

    // Dispose noise texture
    try { this._noiseTexture?.dispose(); } catch (_) {}
    this._noiseTexture = null;

    // Reset state
    this._windTime = 0;
    this._windOffsetUvX = 0;
    this._windOffsetUvY = 0;
    this._lastDefinesKey = -1;
    this._activeFloorIndex = 0;

    this._initialized = false;
    log.info('WaterEffectV2 disposed');
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Build the uniforms object for the water shader material.
   * @param {object} THREE
   * @returns {object} Uniforms dict
   * @private
   */
  _buildUniforms(THREE) {
    const p = this.params;
    const tint = normalizeRgb01(p.tintColor, { r: 0.02, g: 0.18, b: 0.28 });
    const foamColor = normalizeRgb01(p.foamColor, { r: 0.85, g: 0.9, b: 0.88 });
    const murkColor = normalizeRgb01(p.murkColor, { r: 0.15, g: 0.22, b: 0.12 });
    const sandColor = normalizeRgb01(p.sandColor, { r: 0.76, g: 0.68, b: 0.5 });
    const black1x1 = this._make1x1(THREE, 0, 0, 0, 255);
    return {
      tDiffuse:            { value: null },
      tNoiseMap:           { value: this._noiseTexture },
      tWaterData:          { value: black1x1 },
      uHasWaterData:       { value: 0.0 },
      uWaterEnabled:       { value: this.enabled ? 1.0 : 0.0 },
      tWaterRawMask:       { value: black1x1 },
      uHasWaterRawMask:    { value: 0.0 },
      tWaterOccluderAlpha: { value: null },
      uHasWaterOccluderAlpha: { value: 0.0 },
      uWaterDataTexelSize: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },

      // Tint
      uTintColor:    { value: new THREE.Vector3(tint.r, tint.g, tint.b) },
      uTintStrength: { value: p.tintStrength },

      // Waves
      uWaveScale:              { value: p.waveScale },
      uWaveSpeed:              { value: p.waveSpeed },
      uWaveStrength:           { value: p.waveStrength },
      uDistortionStrengthPx:   { value: p.distortionStrengthPx },
      uWaveWarpLargeStrength:  { value: p.waveWarpLargeStrength },
      uWaveWarpSmallStrength:  { value: p.waveWarpSmallStrength },
      uWaveWarpMicroStrength:  { value: p.waveWarpMicroStrength },
      uWaveWarpTimeSpeed:      { value: p.waveWarpTimeSpeed },
      uWaveEvolutionEnabled:   { value: p.waveEvolutionEnabled ? 1.0 : 0.0 },
      uWaveEvolutionSpeed:     { value: p.waveEvolutionSpeed },
      uWaveEvolutionAmount:    { value: p.waveEvolutionAmount },
      uWaveEvolutionScale:     { value: p.waveEvolutionScale },
      uWaveIndoorDampingEnabled: { value: p.waveIndoorDampingEnabled ? 1.0 : 0.0 },
      uWaveIndoorDampingStrength: { value: p.waveIndoorDampingStrength ?? 1.0 },
      uWaveIndoorMinFactor: { value: p.waveIndoorMinFactor ?? 0.05 },

      // Chromatic aberration
      uChromaticAberrationStrengthPx:  { value: p.chromaticAberrationStrengthPx },
      uChromaticAberrationEdgeCenter:  { value: p.chromaticAberrationEdgeCenter },
      uChromaticAberrationEdgeFeather: { value: p.chromaticAberrationEdgeFeather },
      uChromaticAberrationEdgeGamma:   { value: p.chromaticAberrationEdgeGamma },
      uChromaticAberrationEdgeMin:     { value: p.chromaticAberrationEdgeMin },

      // Distortion edge
      uDistortionEdgeCenter:    { value: p.distortionEdgeCenter },
      uDistortionEdgeFeather:   { value: p.distortionEdgeFeather },
      uDistortionEdgeGamma:     { value: p.distortionEdgeGamma },
      uDistortionShoreRemapLo:  { value: p.distortionShoreRemapLo },
      uDistortionShoreRemapHi:  { value: p.distortionShoreRemapHi },
      uDistortionShorePow:      { value: p.distortionShorePow },
      uDistortionShoreMin:      { value: p.distortionShoreMin },

      // Rain
      uRainEnabled:        { value: 0.0 },
      uRainPrecipitation:  { value: p.rainPrecipitation },
      uRainSplit:          { value: p.rainSplit },
      uRainBlend:          { value: p.rainBlend },
      uRainGlobalStrength: { value: p.rainGlobalStrength },
      tOutdoorsMask:       { value: null },
      uHasOutdoorsMask:    { value: 0.0 },
      uOutdoorsMaskFlipY:  { value: 0.0 },
      uRainIndoorDampingEnabled: { value: p.rainIndoorDampingEnabled ? 1.0 : 0.0 },
      uRainIndoorDampingStrength: { value: p.rainIndoorDampingStrength ?? 1.0 },
      uRainRippleStrengthPx:          { value: p.rainRippleStrengthPx },
      uRainRippleScale:               { value: p.rainRippleScale },
      uRainRippleSpeed:               { value: p.rainRippleSpeed },
      uRainRippleDensity:             { value: p.rainRippleDensity },
      uRainRippleSharpness:           { value: p.rainRippleSharpness },
      uRainRippleJitter:              { value: p.rainRippleJitter },
      uRainRippleRadiusMin:           { value: p.rainRippleRadiusMin },
      uRainRippleRadiusMax:           { value: p.rainRippleRadiusMax },
      uRainRippleWidthScale:          { value: p.rainRippleWidthScale },
      uRainRippleSecondaryEnabled:    { value: p.rainRippleSecondaryEnabled ? 1.0 : 0.0 },
      uRainRippleSecondaryStrength:   { value: p.rainRippleSecondaryStrength },
      uRainRippleSecondaryPhaseOffset: { value: p.rainRippleSecondaryPhaseOffset },
      uRainStormStrengthPx:    { value: p.rainStormStrengthPx },
      uRainStormScale:         { value: p.rainStormScale },
      uRainStormSpeed:         { value: p.rainStormSpeed },
      uRainStormCurl:          { value: p.rainStormCurl },
      uRainStormRateBase:      { value: p.rainStormRateBase },
      uRainStormRateSpeedScale: { value: p.rainStormRateSpeedScale },
      uRainStormSizeMin:       { value: p.rainStormSizeMin },
      uRainStormSizeMax:       { value: p.rainStormSizeMax },
      uRainStormWidthMinScale: { value: p.rainStormWidthMinScale },
      uRainStormWidthMaxScale: { value: p.rainStormWidthMaxScale },
      uRainStormDecay:         { value: p.rainStormDecay },
      uRainStormCoreWeight:    { value: p.rainStormCoreWeight },
      uRainStormRingWeight:    { value: p.rainStormRingWeight },
      uRainStormSwirlStrength: { value: p.rainStormSwirlStrength },
      uRainStormMicroEnabled:  { value: p.rainStormMicroEnabled ? 1.0 : 0.0 },
      uRainStormMicroStrength: { value: p.rainStormMicroStrength },
      uRainStormMicroScale:    { value: p.rainStormMicroScale },
      uRainStormMicroSpeed:    { value: p.rainStormMicroSpeed },
      uRainMaxCombinedStrengthPx: { value: p.rainMaxCombinedStrengthPx },

      // Wind
      uWindDir:      { value: new THREE.Vector2(1, 0) },
      uWindSpeed:    { value: 0.0 },
      uWindOffsetUv: { value: new THREE.Vector2(0, 0) },
      uWindTime:     { value: 0.0 },
      uLockWaveTravelToWind: { value: p.lockWaveTravelToWind ? 1.0 : 0.0 },
      uWaveDirOffsetRad:     { value: 0.0 },
      uWaveAppearanceRotRad: { value: 0.0 },

      // Specular (GGX)
      uSpecStrength:        { value: p.specStrength },
      uSpecPower:           { value: p.specPower },
      uSpecSunDir:          { value: new THREE.Vector3(0.5, 0.5, 0.707) },
      uSpecSunIntensity:    { value: p.specSunIntensity },
      uSpecNormalStrength:  { value: p.specNormalStrength },
      uSpecNormalScale:     { value: p.specNormalScale },
      uSpecRoughnessMin:    { value: p.specRoughnessMin },
      uSpecRoughnessMax:    { value: p.specRoughnessMax },
      uSpecF0:              { value: p.specF0 },
      uSpecMaskGamma:       { value: p.specMaskGamma },
      uSpecSkyTint:         { value: p.specSkyTint },
      uSpecShoreBias:       { value: p.specShoreBias },
      uSpecDistortionNormalStrength: { value: p.specDistortionNormalStrength },
      uSpecAnisotropy:      { value: p.specAnisotropy },
      uSpecAnisoRatio:      { value: p.specAnisoRatio },
      tCloudShadow:         { value: null },
      uHasCloudShadow:      { value: 0.0 },
      uCloudShadowEnabled:  { value: p.cloudShadowEnabled ? 1.0 : 0.0 },
      uCloudShadowDarkenStrength: { value: p.cloudShadowDarkenStrength ?? 1.25 },
      uCloudShadowDarkenCurve: { value: p.cloudShadowDarkenCurve ?? 1.5 },
      uCloudShadowSpecularKill: { value: p.cloudShadowSpecularKill ?? 1.0 },
      uCloudShadowSpecularCurve: { value: p.cloudShadowSpecularCurve ?? 6.0 },

      // Caustics
      uCausticsEnabled:      { value: p.causticsEnabled ? 1.0 : 0.0 },
      uCausticsIntensity:    { value: p.causticsIntensity ?? 4.0 },
      uCausticsScale:        { value: p.causticsScale ?? 33.4 },
      uCausticsSpeed:        { value: p.causticsSpeed ?? 1.05 },
      uCausticsSharpness:    { value: p.causticsSharpness ?? 0.1 },
      uCausticsEdgeLo:       { value: p.causticsEdgeLo ?? 0.11 },
      uCausticsEdgeHi:       { value: p.causticsEdgeHi ?? 1.0 },

      // Foam
      uFoamColor:     { value: new THREE.Vector3(foamColor.r, foamColor.g, foamColor.b) },
      uFoamStrength:  { value: p.foamStrength },
      uFoamThreshold: { value: p.foamThreshold },
      uFoamScale:     { value: p.foamScale },
      uFoamSpeed:     { value: p.foamSpeed },
      uFoamCurlStrength:     { value: p.foamCurlStrength },
      uFoamCurlScale:        { value: p.foamCurlScale },
      uFoamCurlSpeed:        { value: p.foamCurlSpeed },
      uFoamBreakupStrength1: { value: p.foamBreakupStrength1 },
      uFoamBreakupScale1:    { value: p.foamBreakupScale1 },
      uFoamBreakupSpeed1:    { value: p.foamBreakupSpeed1 },
      uFoamBreakupStrength2: { value: p.foamBreakupStrength2 },
      uFoamBreakupScale2:    { value: p.foamBreakupScale2 },
      uFoamBreakupSpeed2:    { value: p.foamBreakupSpeed2 },
      uFoamBlackPoint:  { value: p.foamBlackPoint },
      uFoamWhitePoint:  { value: p.foamWhitePoint },
      uFoamGamma:       { value: p.foamGamma },
      uFoamContrast:    { value: p.foamContrast },
      uFoamBrightness:  { value: p.foamBrightness },
      uFloatingFoamStrength:       { value: p.floatingFoamStrength },
      uFloatingFoamCoverage:       { value: p.floatingFoamCoverage },
      uFloatingFoamScale:          { value: p.floatingFoamScale },
      uFloatingFoamWaveDistortion: { value: p.floatingFoamWaveDistortion },
      uFoamFlecksIntensity:        { value: p.foamFlecksIntensity },

      // Murk
      uMurkEnabled:       { value: p.murkEnabled ? 1.0 : 0.0 },
      uMurkIntensity:     { value: p.murkIntensity },
      uMurkColor:         { value: new THREE.Vector3(murkColor.r, murkColor.g, murkColor.b) },
      uMurkScale:         { value: p.murkScale },
      uMurkSpeed:         { value: p.murkSpeed },
      uMurkDepthLo:       { value: p.murkDepthLo },
      uMurkDepthHi:       { value: p.murkDepthHi },
      uMurkGrainScale:    { value: p.murkGrainScale },
      uMurkGrainSpeed:    { value: p.murkGrainSpeed },
      uMurkGrainStrength: { value: p.murkGrainStrength },
      uMurkDepthFade:     { value: p.murkDepthFade },

      // Sand
      uSandIntensity:          { value: p.sandIntensity },
      uSandColor:              { value: new THREE.Vector3(sandColor.r, sandColor.g, sandColor.b) },
      uSandContrast:           { value: p.sandContrast },
      uSandChunkScale:         { value: p.sandChunkScale },
      uSandChunkSpeed:         { value: p.sandChunkSpeed },
      uSandGrainScale:         { value: p.sandGrainScale },
      uSandGrainSpeed:         { value: p.sandGrainSpeed },
      uSandBillowStrength:     { value: p.sandBillowStrength },
      uSandCoverage:           { value: p.sandCoverage },
      uSandChunkSoftness:      { value: p.sandChunkSoftness },
      uSandSpeckCoverage:      { value: p.sandSpeckCoverage },
      uSandSpeckSoftness:      { value: p.sandSpeckSoftness },
      uSandDepthLo:            { value: p.sandDepthLo },
      uSandDepthHi:            { value: p.sandDepthHi },
      uSandAnisotropy:         { value: p.sandAnisotropy },
      uSandDistortionStrength: { value: p.sandDistortionStrength },
      uSandAdditive:           { value: p.sandAdditive },

      // Debug
      uDebugView: { value: p.debugView },

      // Global
      uTime:            { value: 0.0 },
      uResolution:      { value: new THREE.Vector2(1, 1) },
      uZoom:            { value: 1.0 },
      uViewBounds:      { value: new THREE.Vector4(0, 0, 1, 1) },
      uSceneDimensions: { value: new THREE.Vector2(1, 1) },
      uSceneRect:       { value: new THREE.Vector4(0, 0, 1, 1) },
      uHasSceneRect:    { value: 0.0 },
      uSkyColor:        { value: new THREE.Vector3(0.5, 0.6, 0.8) },
      uSkyIntensity:    { value: 0.5 },
      uSceneDarkness:   { value: 0.0 },
      uActiveLevelElevation: { value: 0.0 },

      // Depth pass (shared module uniforms for depth-aware occlusion)
      ...DepthShaderChunks.createUniforms(),
    };
  }

  /**
   * Create a 1x1 DataTexture.
   * @private
   */
  _make1x1(THREE, r, g, b, a) {
    const data = new Uint8Array([r, g, b, a]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /**
   * Resolve the floor index for a tile document (same logic as SpecularEffectV2).
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      if (flags) {
        for (let i = 0; i < floors.length; i++) {
          const flr = floors[i];
          const elevation = flr.elevation ?? flr.rangeBottom ?? 0;
          if (elevation >= flags.rangeBottom && elevation < flags.rangeTop) return i;
        }
      }
    }
    return 0;
  }

  /**
   * Generate a 512x512 RGBA noise texture with four independent channels.
   * Deterministic seeded LCG — identical to V1.
   * @param {object} THREE
   * @returns {THREE.DataTexture}
   * @static
   */
  static _createNoiseTexture(THREE) {
    const size = 512;
    const data = new Uint8Array(size * size * 4);
    let sR = 48271, sG = 16807, sB = 75013, sA = 33791;
    for (let i = 0; i < size * size; i++) {
      sR = (sR * 1103515245 + 12345) & 0x7fffffff;
      sG = (sG * 1103515245 + 12345) & 0x7fffffff;
      sB = (sB * 1103515245 + 12345) & 0x7fffffff;
      sA = (sA * 1103515245 + 12345) & 0x7fffffff;
      const idx = i * 4;
      data[idx]     = (sR >> 16) & 0xff;
      data[idx + 1] = (sG >> 16) & 0xff;
      data[idx + 2] = (sB >> 16) & 0xff;
      data[idx + 3] = (sA >> 16) & 0xff;
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }
}
