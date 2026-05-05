/**
 * @fileoverview V2 Dust effect — per-floor Quarks particles from _Dust masks.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change lifecycle, `_floorStates`, BatchedRenderer integration, or sky-tint
 * inputs, you MUST update HealthEvaluator contracts for `DustEffectV2` (and contextual
 * edges from `SkyColorEffectV2`) to prevent silent failures.
 *
 * Architecture mirrors FireEffectV2:
 * - Discovers `_Dust` masks from scene background + tiles
 * - CPU scans masks once per populate and stores world-space spawn points
 * - Builds per-floor Quarks systems and swaps active floors in/out of a
 *   BatchedRenderer based on current visible floors
 * - Self-contained (no V1 EffectBase / no EffectMaskRegistry dependency)
 *
 * @module compositor-v2/effects/DustEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  resolveV14NativeDocFloorIndexMin,
  getViewedLevelBackgroundSrc,
  hasV14NativeLevels,
} from '../../foundry/levels-scene-flags.js';
// OVERLAY_THREE_LAYER not needed — dust uses layer 0 only; stacking handled
// by LayerOrderPolicy FLOOR_EFFECTS band.
import {
  ParticleSystem as QuarksParticleSystem,
  BatchedRenderer,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ConstantValue,
  ApplyForce,
  CurlNoiseField,
} from '../../libs/three.quarks.module.js';

import {
  GROUND_Z,
  effectUnderOverheadOrder,
} from '../LayerOrderPolicy.js';

const log = createLogger('DustEffectV2');

const BUCKET_SIZE = 2200;

const DUST_MASK_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];

const REBUILD_PARAM_KEYS = [
  'density', 'maxParticles', 'lifeMin', 'lifeMax', 'sizeMin', 'sizeMax', 'zMin', 'zMax',
  'motionDrift', 'motionCurlStrength', 'motionCurlScale',
];
const REBUILD_PARAM_SET = new Set(REBUILD_PARAM_KEYS);

class DustFadeOverLifeBehavior {
  constructor(ownerEffect = null) {
    this.type = 'DustFadeOverLifeV2';
    this.fadeInFraction = 0.25;
    this.fadeOutFraction = 0.25;
    this.ownerEffect = ownerEffect;
    this._brightness = 1.0;
    this._opacity = 1.0;
    this._glitterEnabled = false;
    this._glitterStrength = 0.0;
    this._glitterRateMin = 8.0;
    this._glitterRateMax = 16.0;
    this._skyTintEnabled = false;
    this._skyTintStrength = 0.0;
    this._skyTintColor = { r: 1.0, g: 1.0, b: 1.0 };
  }

  initialize(particle) {
    if (particle && particle.color) {
      particle._dustBaseAlpha = particle.color.w;
      particle._dustBaseR = particle.color.x;
      particle._dustBaseG = particle.color.y;
      particle._dustBaseB = particle.color.z;
      // Randomize glitter cadence per particle to avoid synchronized strobing.
      particle._dustGlitterPhase = Math.random() * Math.PI * 2;
      particle._dustGlitterRateHz = this._glitterRateMin + Math.random() * Math.max(0, this._glitterRateMax - this._glitterRateMin);
      particle._dustGlitterStrengthJitter = 0.7 + Math.random() * 0.6;
    }
  }

  update(particle) {
    if (!particle || !particle.color) return;
    if (typeof particle.age !== 'number' || typeof particle.life !== 'number') return;

    const life = Math.max(1e-6, particle.life);
    const t = Math.min(Math.max(particle.age / life, 0), 1);

    const fin = Math.max(1e-6, this.fadeInFraction);
    const fout = Math.max(1e-6, this.fadeOutFraction);
    let envelope = 1.0;

    if (t < fin) envelope = t / fin;
    else if (t > (1.0 - fout)) envelope = (1.0 - t) / fout;

    envelope = Math.min(Math.max(envelope, 0.0), 1.0);

    const baseA = (typeof particle._dustBaseAlpha === 'number') ? particle._dustBaseAlpha : particle.color.w;
    const baseR = (typeof particle._dustBaseR === 'number') ? particle._dustBaseR : particle.color.x;
    const baseG = (typeof particle._dustBaseG === 'number') ? particle._dustBaseG : particle.color.y;
    const baseB = (typeof particle._dustBaseB === 'number') ? particle._dustBaseB : particle.color.z;

    let tintR = baseR;
    let tintG = baseG;
    let tintB = baseB;
    if (this._skyTintEnabled && this._skyTintStrength > 0.0001) {
      // Preserve base intensity while shifting hue toward live sky tint.
      const avg = Math.max(0.0001, (baseR + baseG + baseB) / 3.0);
      const sr = Math.max(0.0, Number(this._skyTintColor?.r) || 0.0);
      const sg = Math.max(0.0, Number(this._skyTintColor?.g) || 0.0);
      const sb = Math.max(0.0, Number(this._skyTintColor?.b) || 0.0);
      const targetR = avg * sr;
      const targetG = avg * sg;
      const targetB = avg * sb;
      const mix = Math.max(0.0, Math.min(1.0, this._skyTintStrength));
      tintR = baseR + (targetR - baseR) * mix;
      tintG = baseG + (targetG - baseG) * mix;
      tintB = baseB + (targetB - baseB) * mix;
    }

    let glitterMul = 1.0;
    if (this._glitterEnabled && this._glitterStrength > 0.0001) {
      const phase = Number.isFinite(particle._dustGlitterPhase) ? particle._dustGlitterPhase : 0.0;
      const rateHz = Number.isFinite(particle._dustGlitterRateHz) ? particle._dustGlitterRateHz : this._glitterRateMin;
      const strengthJitter = Number.isFinite(particle._dustGlitterStrengthJitter) ? particle._dustGlitterStrengthJitter : 1.0;

      // Centered oscillation [-1..1], converted to subtle multiplicative brightness.
      const osc = Math.sin((particle.age * rateHz * Math.PI * 2) + phase);
      const glitterStrength = Math.max(0.0, this._glitterStrength * strengthJitter);
      glitterMul = Math.max(0.05, 1.0 + (osc * glitterStrength));
    }

    const finalBrightness = this._brightness * glitterMul;
    particle.color.x = tintR * finalBrightness;
    particle.color.y = tintG * finalBrightness;
    particle.color.z = tintB * finalBrightness;
    particle.color.w = baseA * envelope * this._opacity;
  }

  frameUpdate() {
    const p = this.ownerEffect?.params;
    const b = (p && typeof p.brightness === 'number') ? p.brightness : 1.0;
    const a = (p && typeof p.opacity === 'number') ? p.opacity : 1.0;
    this._brightness = Math.max(0.0, Math.min(10.0, b));
    this._opacity = Math.max(0.0, Math.min(1.0, a));
    this._glitterEnabled = !!(p && p.glitterEnabled);
    this._glitterStrength = (p && typeof p.glitterStrength === 'number') ? Math.max(0.0, Math.min(0.95, p.glitterStrength)) : 0.0;
    const minHz = (p && typeof p.glitterRateMin === 'number') ? p.glitterRateMin : 8.0;
    const maxHz = (p && typeof p.glitterRateMax === 'number') ? p.glitterRateMax : 16.0;
    this._glitterRateMin = Math.max(0.1, Math.min(minHz, maxHz));
    this._glitterRateMax = Math.max(this._glitterRateMin, Math.max(minHz, maxHz));
    this._skyTintEnabled = !!(p && p.skyTintEnabled);
    this._skyTintStrength = (p && typeof p.skyTintStrength === 'number')
      ? Math.max(0.0, Math.min(1.0, p.skyTintStrength))
      : 0.0;
    const sky = this.ownerEffect?._skyState?.skyTintColor;
    this._skyTintColor = {
      r: Math.max(0.0, Number(sky?.r) || 1.0),
      g: Math.max(0.0, Number(sky?.g) || 1.0),
      b: Math.max(0.0, Number(sky?.b) || 1.0),
    };
  }

  reset() {
  }

  clone() {
    const b = new DustFadeOverLifeBehavior(this.ownerEffect);
    b.fadeInFraction = this.fadeInFraction;
    b.fadeOutFraction = this.fadeOutFraction;
    return b;
  }
}

class DustMaskShape {
  constructor(pointsWorld, ownerEffect, floorZ) {
    this.points = pointsWorld;
    this.ownerEffect = ownerEffect;
    this.floorZ = floorZ;
    this.type = 'dust_mask_v2';
  }

  initialize(p) {
    const count = this.points.length / 3;
    if (count <= 0) return;

    const idx = Math.floor(Math.random() * count) * 3;
    const x = this.points[idx];
    const y = this.points[idx + 1];
    const b = this.points[idx + 2];

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(b) || b <= 0.0) {
      if (typeof p.life === 'number') p.life = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
      if (typeof p.size === 'number') p.size = 0;
      return;
    }

    const params = this.ownerEffect?.params;
    const zMin = params && typeof params.zMin === 'number' ? params.zMin : 10;
    const zMax = params && typeof params.zMax === 'number' ? params.zMax : 140;
    const z = this.floorZ + zMin + Math.random() * Math.max(0, zMax - zMin);

    p.position.x = x;
    p.position.y = y;
    p.position.z = z;

    const alphaScale = Math.max(0.35, Math.min(1.0, b));
    if (p.color && typeof p.color.w === 'number') p.color.w *= alphaScale;
    if (typeof p.size === 'number') p.size *= (0.6 + 0.4 * alphaScale);

    if (p.velocity) p.velocity.set(0, 0, 0);
  }

  update() {
  }
}

export class DustEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;

    this._batchRenderer = null;

    /** @type {Map<number, { points: Float32Array, systems: QuarksParticleSystem[] }>} */
    this._floorStates = new Map();
    /** @type {Set<number>} */
    this._activeFloors = new Set();

    /** @type {THREE.Texture|null} */
    this._particleTexture = null;
    /** @type {Promise<void>|null} */
    this._texturesReady = null;

    /** @type {Map<string, {url: string, image: HTMLImageElement} | null>} */
    this._directMaskCache = new Map();

    /** @type {object|null} */
    this._lastPopulateSceneData = null;
    /** @type {Promise<void>|null} */
    this._rebuildInFlight = null;
    /** @type {boolean} */
    this._rebuildQueued = false;
    /** @type {import('../../scene/map-points-manager.js').MapPointsManager|null} */
    this._mapPointsManager = null;
    /** @type {(() => void)|null} */
    this._mapPointChangeListener = null;
    /** @type {any} */
    this._activeLevelContext = null;
    /** @type {{ skyTintColor: { r: number, g: number, b: number }, sunAzimuthDeg: number }} */
    this._skyState = {
      skyTintColor: { r: 1.0, g: 1.0, b: 1.0 },
      sunAzimuthDeg: 180.0,
    };

    this.params = {
      enabled: false,
      density: 3.0,
      maxParticles: 4000,
      brightness: 3.0,
      opacity: 0.5,
      skyTintEnabled: false,
      skyTintStrength: 0.0,
      glitterEnabled: false,
      glitterStrength: 0.12,
      glitterRateMin: 8.0,
      glitterRateMax: 16.0,
      lifeMin: 4.5,
      lifeMax: 8.7,
      sizeMin: 15.0,
      sizeMax: 25.0,
      zMin: 10.0,
      zMax: 140.0,
      motionDrift: 1.0,
      motionCurlStrength: 18.0,
      motionCurlScale: 40.0,
      // Outdoor pixels (from optional _Outdoors mask) above this threshold are skipped.
      outdoorRejectThreshold: 0.5,
      maskThreshold: 0.05,
    };

    log.debug('DustEffectV2 created');
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'dust', label: 'Dust Motes', type: 'inline', parameters: ['density', 'maxParticles'] },
        { name: 'appearance', label: 'Appearance', type: 'inline', separator: true, parameters: ['brightness', 'opacity', 'skyTintEnabled', 'skyTintStrength'] },
        { name: 'glitter', label: 'Glitter', type: 'inline', separator: true, parameters: ['glitterEnabled', 'glitterStrength', 'glitterRateMin', 'glitterRateMax'] },
        { name: 'lifetime', label: 'Lifetime & Size', type: 'inline', separator: true, parameters: ['lifeMin', 'lifeMax', 'sizeMin', 'sizeMax'] },
        { name: 'volume', label: 'Volume', type: 'inline', separator: true, parameters: ['zMin', 'zMax'] },
        { name: 'motion', label: 'Motion', type: 'inline', separator: true, parameters: ['motionDrift', 'motionCurlStrength', 'motionCurlScale'] },
      ],
      parameters: {
        enabled: { type: 'boolean', label: 'Dust Enabled', default: false },
        density: { type: 'slider', label: 'Density', min: 0.0, max: 3.0, step: 0.05, default: 3.0 },
        maxParticles: { type: 'slider', label: 'Max Particles', min: 0, max: 20000, step: 100, default: 4000 },
        brightness: { type: 'slider', label: 'Brightness', min: 0.0, max: 3.0, step: 0.05, default: 3.0 },
        opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        skyTintEnabled: { type: 'boolean', label: 'Sky Tint Dust', default: false },
        skyTintStrength: { type: 'slider', label: 'Sky Tint Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        glitterEnabled: { type: 'boolean', label: 'Enable Glitter', default: false },
        glitterStrength: { type: 'slider', label: 'Glitter Strength', min: 0.0, max: 0.6, step: 0.01, default: 0.12 },
        glitterRateMin: { type: 'slider', label: 'Glitter Rate Min (Hz)', min: 0.1, max: 30.0, step: 0.1, default: 8.0 },
        glitterRateMax: { type: 'slider', label: 'Glitter Rate Max (Hz)', min: 0.1, max: 30.0, step: 0.1, default: 16.0 },
        lifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.2, max: 30.0, step: 0.1, default: 4.5 },
        lifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.2, max: 30.0, step: 0.1, default: 8.7 },
        sizeMin: { type: 'slider', label: 'Size Min', min: 0.1, max: 80.0, step: 0.5, default: 15.0 },
        sizeMax: { type: 'slider', label: 'Size Max', min: 0.1, max: 120.0, step: 0.5, default: 25.0 },
        zMin: { type: 'slider', label: 'Z Min', min: 0.0, max: 800.0, step: 1.0, default: 10.0 },
        zMax: { type: 'slider', label: 'Z Max', min: 0.0, max: 1200.0, step: 1.0, default: 140.0 },
        motionDrift: { type: 'slider', label: 'Drift', min: 0.0, max: 80.0, step: 0.5, default: 1.0 },
        motionCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 200.0, step: 1.0, default: 18.0 },
        motionCurlScale: { type: 'slider', label: 'Curl Scale', min: 10.0, max: 2000.0, step: 10.0, default: 40.0 },
      }
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = this._enabled;
    }
  }

  initialize() {
    if (this._initialized) return;

    const THREE = window.THREE;
    if (!THREE) {
      log.warn('initialize: THREE not available');
      return;
    }

    this._batchRenderer = new BatchedRenderer();
    this._batchRenderer.renderOrder = effectUnderOverheadOrder(0, 30);
    this._batchRenderer.frustumCulled = false;
    try {
      if (this._batchRenderer.layers && typeof this._batchRenderer.layers.set === 'function') {
        this._batchRenderer.layers.set(0);
      }
    } catch (_) {
    }

    this._texturesReady = this._loadTextures();

    this._initialized = true;
    log.info('DustEffectV2 initialized');
  }

  applyParamChange(paramId, value) {
    if (paramId === 'enabled' || paramId === 'masterEnabled') {
      this.enabled = !!value;
      return;
    }
    if (!this.params || !Object.prototype.hasOwnProperty.call(this.params, paramId)) return;

    this.params[paramId] = value;
    if (REBUILD_PARAM_SET.has(paramId)) {
      this._queueRebuild();
    }
  }

  /**
   * Receives live sky state from FloorCompositor.
   * @param {{ skyTintColor?: { r?: number, g?: number, b?: number }, sunAzimuthDeg?: number }} state
   */
  setSkyState(state = {}) {
    const tint = state?.skyTintColor;
    this._skyState = {
      skyTintColor: {
        r: Math.max(0.0, Number(tint?.r) || 1.0),
        g: Math.max(0.0, Number(tint?.g) || 1.0),
        b: Math.max(0.0, Number(tint?.b) || 1.0),
      },
      sunAzimuthDeg: Number.isFinite(Number(state?.sunAzimuthDeg)) ? Number(state.sunAzimuthDeg) : 180.0,
    };
  }

  /**
   * Wire dust map-point sources from MapPointsManager.
   * @param {import('../../scene/map-points-manager.js').MapPointsManager|null} manager
   */
  setMapPointsSources(manager) {
    const prevManager = this._mapPointsManager;
    if (this._mapPointChangeListener && prevManager) {
      prevManager.removeChangeListener(this._mapPointChangeListener);
    }

    this._mapPointsManager = manager || null;
    this._mapPointChangeListener = () => this._queueRebuild();

    if (this._mapPointsManager) {
      this._mapPointsManager.addChangeListener(this._mapPointChangeListener);
    }

    this._queueRebuild();
  }

  setActiveLevelContext(context = null) {
    const nextContext = context ?? window.MapShine?.activeLevelContext ?? null;
    const prevKey = this._levelContextKey(this._activeLevelContext);
    const nextKey = this._levelContextKey(nextContext);
    this._activeLevelContext = nextContext;

    if (prevKey !== nextKey) {
      this._queueRebuild();
    }
  }

  _levelContextKey(context) {
    const b = Number(context?.bottom);
    const t = Number(context?.top);
    if (!Number.isFinite(b) || !Number.isFinite(t)) return 'all-levels';
    return `${b}:${t}`;
  }

  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this._lastPopulateSceneData = foundrySceneData ?? this._lastPopulateSceneData;

    this.clear();
    if (this._texturesReady) await this._texturesReady;

    const d = canvas?.dimensions;
    if (!d) return;

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const worldH = Number(d.height) || 0;

    // Background first (V14 level-aware): bind each discovered background _Dust mask
    // to its authored floor index instead of pinning to floor 0.
    const scene = canvas?.scene ?? null;
    const seenBgDustKeys = new Set();
    const ingestBackgroundDust = async (bgSrcRaw, floorIndex) => {
      const bgSrc = typeof bgSrcRaw === 'string' ? bgSrcRaw.trim() : '';
      if (!bgSrc) return;
      const bgBasePath = this._extractBasePath(bgSrc);
      if (!bgBasePath) return;
      const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Math.floor(Number(floorIndex))) : 0;
      const dedupeKey = `${fi}|${bgBasePath}`;
      if (seenBgDustKeys.has(dedupeKey)) return;
      seenBgDustKeys.add(dedupeKey);

      await this._accumulateDustPointsForSource({
        baseSrc: bgSrc,
        floorIndex: fi,
        x: Number(d.sceneX) || 0,
        y: Number(d.sceneY) || 0,
        w: Number(d.sceneWidth) || 0,
        h: Number(d.sceneHeight) || 0,
        worldH,
      });
    };

    if (hasV14NativeLevels(scene) && floors.length > 0) {
      for (const floor of floors) {
        const levelId = floor?.levelId;
        if (typeof levelId !== 'string' || !levelId.length) continue;
        let bgSrc = '';
        try {
          const lvl = scene.levels?.get?.(levelId);
          bgSrc = String(lvl?.background?.src || '').trim();
        } catch (_) {
        }
        if (!bgSrc) continue;
        await ingestBackgroundDust(bgSrc, floor.index);
      }
    }

    // Always also probe the currently viewed background on active floor index.
    {
      const fallbackSrc = getViewedLevelBackgroundSrc(scene)
        ?? canvas?.scene?.background?.src
        ?? '';
      const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
      const activeFloorIndex = (floors.length > 1 && Number.isFinite(Number(activeFloor?.index)))
        ? Number(activeFloor.index)
        : 0;
      await ingestBackgroundDust(String(fallbackSrc || ''), activeFloorIndex);
    }

    // Tiles.
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      await this._accumulateDustPointsForSource({
        baseSrc: src,
        floorIndex,
        x: Number(tileDoc.x) || 0,
        y: Number(tileDoc.y) || 0,
        w: Number(tileDoc.width) || 0,
        h: Number(tileDoc.height) || 0,
        worldH,
      });
    }

    this._accumulateDustPointsFromMapPoints({ floors });

    for (const [floorIndex, state] of this._floorStates) {
      this._rebuildSystemsForFloor(floorIndex, state.points);
    }

    const systemsByFloor = Array.from(this._floorStates.entries()).map(([k, v]) => [k, v.systems?.length ?? 0]);
    const totalSystems = systemsByFloor.reduce((sum, [, n]) => sum + n, 0);

    if (this._batchRenderer) {
      this._renderBus.addEffectOverlay('__dust_batch__', this._batchRenderer, 0);
    }

    this._activateCurrentFloor();

    if (this._floorStates.size === 0) {
      log.debug('DustEffectV2: no spawn points found from _Dust masks or dust map points');
    }

    log.info('DustEffectV2 populated', {
      floors: this._floorStates.size,
      pointsByFloor: Array.from(this._floorStates.entries()).map(([k, v]) => [k, Math.floor((v.points?.length ?? 0) / 3)]),
      systemsByFloor,
      totalSystems,
    });
  }

  update(timeInfo) {
    if (!this._initialized || !this._batchRenderer || !this._enabled || !this.params.enabled) return;

    const deltaSec = typeof timeInfo?.motionDelta === 'number'
      ? timeInfo.motionDelta
      : (typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016);
    const clampedDelta = Math.min(deltaSec, 0.1);
    const simSpeed = (weatherController && typeof weatherController.simulationSpeed === 'number')
      ? weatherController.simulationSpeed : 2.0;
    const dt = clampedDelta * 0.001 * 750 * simSpeed;

    this._updateSystemParams();

    try {
      this._batchRenderer.update(dt);
    } catch (err) {
      log.warn('DustEffectV2: BatchedRenderer.update threw, skipping frame:', err);
    }
  }

  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;

    // Keep floor-scoped map-point groups in sync with active level context.
    this.setActiveLevelContext(window.MapShine?.activeLevelContext ?? null);

    this._updateBatchRenderOrder(maxFloorIndex);

    const desired = new Set();
    for (const idx of this._floorStates.keys()) {
      if (idx <= maxFloorIndex) desired.add(idx);
    }

    for (const idx of this._activeFloors) {
      if (!desired.has(idx)) this._deactivateFloor(idx);
    }
    for (const idx of desired) {
      if (!this._activeFloors.has(idx)) this._activateFloor(idx);
    }

    this._activeFloors = desired;
  }

  clear() {
    for (const idx of this._activeFloors) this._deactivateFloor(idx);
    this._activeFloors.clear();

    for (const [, state] of this._floorStates) this._disposeFloorState(state);
    this._floorStates.clear();

    this._renderBus.removeEffectOverlay('__dust_batch__');
  }

  dispose() {
    this.clear();
    if (this._mapPointChangeListener && this._mapPointsManager) {
      this._mapPointsManager.removeChangeListener(this._mapPointChangeListener);
    }
    this._mapPointChangeListener = null;
    this._mapPointsManager = null;
    this._particleTexture?.dispose();
    this._particleTexture = null;
    this._batchRenderer = null;
    this._initialized = false;
  }

  _queueRebuild() {
    if (this._rebuildInFlight) {
      this._rebuildQueued = true;
      return;
    }

    const sceneData = this._lastPopulateSceneData;
    if (!sceneData) return;

    this._rebuildInFlight = this.populate(sceneData)
      .catch((err) => {
        log.warn('DustEffectV2: runtime rebuild failed', err);
      })
      .finally(() => {
        this._rebuildInFlight = null;
        if (this._rebuildQueued) {
          this._rebuildQueued = false;
          this._queueRebuild();
        }
      });
  }

  _updateSystemParams() {
    const p = this.params;
    const density = Math.max(0.0, Number(p.density) || 0.0);

    for (const [, state] of this._floorStates) {
      for (const sys of state.systems) {
        if (!sys?.userData) continue;

        const scale = sys.userData._msEmissionScale ?? 1.0;
        if (sys.emissionOverTime) {
          // Keep total scene-wide dust emission consistent across buckets.
          sys.emissionOverTime.a = 12.0 * density * scale;
          sys.emissionOverTime.b = 20.0 * density * scale;
        }

        const drift = sys.userData.driftForce;
        if (drift?.magnitude && typeof drift.magnitude.value === 'number') {
          drift.magnitude.value = Math.max(0.0, Number(p.motionDrift) || 0.0);
        }

        const curl = sys.userData.curl;
        const baseCurl = sys.userData.baseCurlStrength;
        if (curl?.strength && baseCurl) {
          const cs = Math.max(0.0, Number(p.motionCurlStrength) || 0.0);
          curl.strength.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
      }
    }
  }

  _activateCurrentFloor() {
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
    const maxFloorIndex = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
    this.onFloorChange(maxFloorIndex);
  }

  _updateBatchRenderOrder(maxFloorIndex) {
    if (!this._batchRenderer) return;
    const safeFloorIndex = Number.isFinite(Number(maxFloorIndex)) ? Number(maxFloorIndex) : 0;
    this._batchRenderer.renderOrder = effectUnderOverheadOrder(safeFloorIndex, 30);
  }

  _activateFloor(floorIndex) {
    const state = this._floorStates.get(floorIndex);
    if (!state || !this._batchRenderer) return;

    log.info(`DustEffectV2: activating floor ${floorIndex} with ${state.systems.length} system(s)`);

    for (const sys of state.systems) {
      try { this._batchRenderer.addSystem(sys); } catch (_) {}
      if (sys.emitter) {
        try { this._batchRenderer.add(sys.emitter); } catch (_) {}
      }
      try { sys.play?.(); } catch (_) {}
    }
  }

  _deactivateFloor(floorIndex) {
    if (!this._batchRenderer) return;
    const state = this._floorStates.get(floorIndex);
    if (!state) return;

    for (const sys of state.systems) {
      try { this._batchRenderer.deleteSystem(sys); } catch (_) {}
      if (sys.emitter) this._batchRenderer.remove(sys.emitter);
    }
  }

  _disposeFloorState(state) {
    for (const sys of state.systems) {
      try { this._batchRenderer?.deleteSystem?.(sys); } catch (_) {}
      try { this._batchRenderer?.remove?.(sys.emitter); } catch (_) {}
      try { sys.material?.dispose?.(); } catch (_) {}
    }
    state.systems.length = 0;
  }

  _rebuildSystemsForFloor(floorIndex, pointsWorld) {
    const state = this._floorStates.get(floorIndex);
    if (!state) return;

    // Dispose previous floor systems before rebuild.
    for (const sys of state.systems) {
      try { this._batchRenderer?.deleteSystem?.(sys); } catch (_) {}
      try { this._batchRenderer?.remove?.(sys.emitter); } catch (_) {}
      try { sys.material?.dispose?.(); } catch (_) {}
    }
    state.systems = [];

    const count = Math.floor((pointsWorld?.length ?? 0) / 3);
    if (count <= 0) return;

    const buckets = new Map();
    for (let i = 0; i < pointsWorld.length; i += 3) {
      const x = pointsWorld[i];
      const y = pointsWorld[i + 1];
      const b = pointsWorld[i + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(b) || b <= 0) continue;

      const bx = Math.floor(x / BUCKET_SIZE);
      const by = Math.floor(y / BUCKET_SIZE);
      const key = `${bx},${by}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(x, y, b);
    }

    const totalCount = Math.max(1, count);
    for (const [, arr] of buckets) {
      if (arr.length < 3) continue;
      const pts = new Float32Array(arr);
      const weight = (pts.length / 3) / totalCount;
      const sys = this._createDustSystem(pts, weight, floorIndex);
      if (sys) state.systems.push(sys);
    }

    if (state.systems.length === 0) {
      log.warn(`DustEffectV2: floor ${floorIndex} has points but created 0 systems`, {
        pointCount: count,
        bucketCount: buckets.size,
      });
    }

    if (this._activeFloors.has(floorIndex)) {
      this._activateFloor(floorIndex);
    }
  }

  _createDustSystem(pointsWorld, weight, floorIndex) {
    const THREE = window.THREE;
    if (!THREE || !this._particleTexture) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._particleTexture,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: false,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;

    const p = this.params;
    const lifeMin = Math.max(0.01, Number(p.lifeMin) || 5.0);
    const lifeMax = Math.max(lifeMin, Number(p.lifeMax) || 15.0);
    const sizeMin = Math.max(0.1, Number(p.sizeMin) || 4.0);
    const sizeMax = Math.max(sizeMin, Number(p.sizeMax) || 16.0);

    const density = Math.max(0.0, Number(p.density) || 0.0);
    const maxParticles = Math.max(1, Math.floor((Number(p.maxParticles) || 3000) * Math.max(0.1, weight)));

    const floorZ = GROUND_Z + (Number(floorIndex) || 0);
    const shape = new DustMaskShape(pointsWorld, this, floorZ);

    const driftForce = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(Math.max(0, Number(p.motionDrift) || 0)));

    const curlScale = Math.max(1.0, Number(p.motionCurlScale) || 380.0);
    const curl = new CurlNoiseField(
      new THREE.Vector3(curlScale, curlScale, curlScale),
      new THREE.Vector3(1, 1, 1),
      1.0
    );

    const alpha = 0.9;
    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(
        new Vector4(1.0, 1.0, 1.0, alpha),
        new Vector4(1.0, 1.0, 1.0, alpha)
      ),
      worldSpace: true,
      maxParticles,
      emissionOverTime: new IntervalValue(12.0 * density * weight, 20.0 * density * weight),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 200010,
      behaviors: [
        driftForce,
        curl,
        new DustFadeOverLifeBehavior(this),
      ],
    });

    system.userData = {
      driftForce,
      curl,
      baseCurlStrength: new THREE.Vector3(1, 1, 1),
      _msEmissionScale: weight,
      ownerEffect: this,
    };

    return system;
  }

  async _loadTextures() {
    const THREE = window.THREE;
    if (!THREE) return;

    const loader = new THREE.TextureLoader();
    await new Promise((resolve) => {
      loader.load(
        'modules/map-shine-advanced/assets/particle.webp',
        (tex) => {
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = true;
          tex.needsUpdate = true;
          this._particleTexture = tex;
          resolve();
        },
        undefined,
        () => {
          log.warn('DustEffectV2: failed to load particle texture');
          resolve();
        }
      );
    });
  }

  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    // Prefer V14-native level membership when available.
    const nativeFloorIndex = resolveV14NativeDocFloorIndexMin(tileDoc, canvas?.scene);
    if (Number.isFinite(Number(nativeFloorIndex))) {
      const fi = Math.floor(Number(nativeFloorIndex));
      if (fi >= 0 && fi < floors.length) return fi;
    }

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid <= f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  async _accumulateDustPointsForSource({ baseSrc, floorIndex, x, y, w, h, worldH }) {
    if (!baseSrc) return;
    if (!(w > 0 && h > 0)) return;

    const basePath = this._extractBasePath(baseSrc);
    if (!basePath) return;

    const dustMask = await this._probeDirectMask(basePath, '_Dust', { suppressProbeErrors: true });
    if (!dustMask?.image) {
      log.debug('DustEffectV2: no _Dust mask resolved for source', { baseSrc, basePath, floorIndex });
      return;
    }

    const outdoorsMask = await this._probeDirectMask(basePath, '_Outdoors', { suppressProbeErrors: true });

    const points = this._scanDustMaskToWorldPoints(dustMask.image, outdoorsMask?.image ?? null, {
      x,
      y,
      w,
      h,
      worldH,
    });

    if (!points || points.length === 0) return;

    this._appendPointsToFloorState(floorIndex, points);
  }

  _appendPointsToFloorState(floorIndex, points) {
    if (!points || points.length === 0) return;

    const existing = this._floorStates.get(floorIndex);
    if (!existing) {
      this._floorStates.set(floorIndex, { points, systems: [] });
      return;
    }

    const merged = new Float32Array(existing.points.length + points.length);
    merged.set(existing.points, 0);
    merged.set(points, existing.points.length);
    existing.points = merged;
  }

  _accumulateDustPointsFromMapPoints({ floors }) {
    const manager = this._mapPointsManager;
    if (!manager) return;

    const groups = typeof manager.getGroupsByEffect === 'function'
      ? manager.getGroupsByEffect('dust')
      : [];
    if (!Array.isArray(groups) || groups.length === 0) return;

    let contributingGroups = 0;
    let contributedPointTriples = 0;

    for (const group of groups) {
      if (!group || !Array.isArray(group.points) || group.points.length === 0) continue;

      const floorIndices = this._resolveMapPointGroupFloorIndices(group, floors);
      if (!floorIndices.length) continue;

      let points = null;
      if (group.type === 'area' && group.points.length >= 3) {
        points = this._sampleMapPointAreaToWorldPoints(group);
      } else if (group.type === 'point') {
        points = this._sampleMapPointPointGroupToWorldPoints(group);
      }

      if (!points || points.length === 0) continue;
      contributingGroups += 1;
      contributedPointTriples += Math.floor(points.length / 3);
      for (const floorIndex of floorIndices) {
        this._appendPointsToFloorState(floorIndex, points);
      }
    }

    if (contributingGroups > 0) {
      log.info('DustEffectV2: ingested dust map-point groups', {
        groups: contributingGroups,
        sampledPoints: contributedPointTriples,
      });
    }
  }

  _resolveMapPointGroupFloorIndices(group, floors) {
    if (!Array.isArray(floors) || floors.length === 0) return [0];

    const binding = group?.metadata?.levelBinding;
    const mode = String(binding?.mode || 'all-levels');
    if (mode !== 'locked') {
      return floors.map((_, idx) => idx);
    }

    const bottom = Number(binding?.bottom);
    const top = Number(binding?.top);
    if (!Number.isFinite(bottom) || !Number.isFinite(top)) {
      const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
      const idx = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
      return [idx];
    }

    const matched = [];
    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];
      const fMin = Number(floor?.elevationMin);
      const fMax = Number(floor?.elevationMax);
      if (!Number.isFinite(fMin) || !Number.isFinite(fMax)) continue;
      if (top >= fMin && bottom <= fMax) matched.push(i);
    }

    if (matched.length > 0) return matched;
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
    const idx = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
    return [idx];
  }

  _sampleMapPointPointGroupToWorldPoints(group) {
    const points = group?.points;
    if (!Array.isArray(points) || points.length === 0) return null;

    const out = [];
    const intensity = this._mapPointEmissionIntensity(group);
    for (const point of points) {
      const fx = Number(point?.x);
      const fy = Number(point?.y);
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) continue;
      out.push(fx, fy, intensity);
    }
    return out.length ? new Float32Array(out) : null;
  }

  _sampleMapPointAreaToWorldPoints(group) {
    const polygon = group?.points;
    if (!Array.isArray(polygon) || polygon.length < 3) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of polygon) {
      const x = Number(p?.x);
      const y = Number(p?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const stride = Math.max(24, Math.min(160, Math.floor(Math.max(width, height) / 24)));
    const intensity = this._mapPointEmissionIntensity(group);
    const out = [];

    // Include vertices so very small polygons still emit.
    for (const p of polygon) {
      const x = Number(p?.x);
      const y = Number(p?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push(x, y, intensity);
    }

    for (let y = minY; y <= maxY; y += stride) {
      for (let x = minX; x <= maxX; x += stride) {
        if (!this._isPointInPolygon(x, y, polygon)) continue;
        out.push(x, y, intensity);
      }
    }

    return out.length ? new Float32Array(out) : null;
  }

  _mapPointEmissionIntensity(group) {
    const i = Number(group?.emission?.intensity);
    if (!Number.isFinite(i)) return 1.0;
    return Math.max(0.05, Math.min(1.0, i));
  }

  _isPointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = Number(polygon[i]?.x);
      const yi = Number(polygon[i]?.y);
      const xj = Number(polygon[j]?.x);
      const yj = Number(polygon[j]?.y);
      if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;

      const crosses = ((yi > y) !== (yj > y))
        && (x < ((xj - xi) * (y - yi) / Math.max(1e-6, (yj - yi)) + xi));
      if (crosses) inside = !inside;
    }
    return inside;
  }

  _scanDustMaskToWorldPoints(dustImage, outdoorsImage, { x, y, w, h, worldH }) {
    try {
      const iw = dustImage?.width ?? dustImage?.naturalWidth ?? 0;
      const ih = dustImage?.height ?? dustImage?.naturalHeight ?? 0;
      if (!(iw > 0 && ih > 0)) return null;

      const cvs = document.createElement('canvas');
      cvs.width = iw;
      cvs.height = ih;
      const ctx = cvs.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(dustImage, 0, 0);
      const dustData = ctx.getImageData(0, 0, iw, ih).data;

      let outdoorsData = null;
      let ow = 0;
      let oh = 0;
      if (outdoorsImage) {
        ow = outdoorsImage?.width ?? outdoorsImage?.naturalWidth ?? 0;
        oh = outdoorsImage?.height ?? outdoorsImage?.naturalHeight ?? 0;
        if (ow > 0 && oh > 0) {
          const oc = document.createElement('canvas');
          oc.width = ow;
          oc.height = oh;
          const octx = oc.getContext('2d', { willReadFrequently: true });
          if (octx) {
            octx.drawImage(outdoorsImage, 0, 0);
            outdoorsData = octx.getImageData(0, 0, ow, oh).data;
          }
        }
      }

      const threshold = Math.max(0, Math.min(1, Number(this.params.maskThreshold) || 0.05));
      const outdoorRejectThreshold = Math.max(0, Math.min(1, Number(this.params.outdoorRejectThreshold) || 0.5));
      const stride = Math.max(1, Math.floor(Math.max(iw, ih) / 600));

      const coords = [];
      for (let py = 0; py < ih; py += stride) {
        for (let px = 0; px < iw; px += stride) {
          const idx = (py * iw + px) * 4;
          const r = dustData[idx] / 255.0;
          const g = dustData[idx + 1] / 255.0;
          const b = dustData[idx + 2] / 255.0;
          const a = dustData[idx + 3] / 255.0;
          const lum = Math.max(r, g, b);
          const d = lum * a;
          if (d <= threshold) continue;

          if (outdoorsData && ow > 1 && oh > 1) {
            const ox = Math.floor((px / (iw - 1)) * (ow - 1));
            const oy = Math.floor((py / (ih - 1)) * (oh - 1));
            const oIdx = (oy * ow + ox) * 4;
            const or = outdoorsData[oIdx] / 255.0;
            const og = outdoorsData[oIdx + 1] / 255.0;
            const ob = outdoorsData[oIdx + 2] / 255.0;
            const oa = outdoorsData[oIdx + 3] / 255.0;
            const outdoor = Math.max(or, og, ob) * oa;
            if (outdoor > outdoorRejectThreshold) continue;
          }

          const u = px / (iw - 1);
          const v = py / (ih - 1);

          const fx = x + u * w;
          const fy = y + v * h;
          const wx = fx;
          const wy = worldH - fy;

          coords.push(wx, wy, Math.min(1.0, d));
        }
      }

      if (coords.length === 0) return null;
      return new Float32Array(coords);
    } catch (err) {
      log.warn('DustEffectV2: _scanDustMaskToWorldPoints failed', err);
      return null;
    }
  }

  _extractBasePath(src) {
    try {
      const s = String(src || '');
      if (!s) return null;
      const q = s.indexOf('?');
      const hash = s.indexOf('#');
      let cut = s.length;
      if (q >= 0) cut = Math.min(cut, q);
      if (hash >= 0) cut = Math.min(cut, hash);
      const clean = s.slice(0, cut);
      const lastDot = clean.lastIndexOf('.');
      if (lastDot > 0) {
        const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
        if (lastDot > lastSlash) {
          return clean.slice(0, lastDot);
        }
      }
      return clean;
    } catch (_) {
      return null;
    }
  }

  async _probeDirectMask(basePath, suffix, options = {}) {
    const cacheKey = `${basePath}${suffix}::${DUST_MASK_FORMATS.join(',')}`;
    if (this._directMaskCache.has(cacheKey)) {
      return this._directMaskCache.get(cacheKey);
    }

    let probe = null;
    try {
      probe = await probeMaskFile(basePath, suffix, options);
    } catch (_) {
      probe = null;
    }

    if (!probe?.path) {
      this._directMaskCache.set(cacheKey, null);
      return null;
    }

    const image = await this._loadImage(probe.path);
    const out = image ? { url: probe.path, image } : null;
    this._directMaskCache.set(cacheKey, out);
    return out;
  }

  _loadImage(url) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      } catch (_) {
        resolve(null);
      }
    });
  }
}
