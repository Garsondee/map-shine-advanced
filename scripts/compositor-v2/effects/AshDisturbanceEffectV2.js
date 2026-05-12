/**
 * @fileoverview AshDisturbanceEffectV2 — V2 token-movement ash burst particles.
 *
 * V2 architecture:
 * - Discovers `_Ash` masks per tile (and scene background) using `probeMaskFile()`.
 * - CPU-scans masks to build spawn point clouds in absolute world coordinates.
 * - Builds per-floor Quarks particle systems and swaps active floors in/out
 *   based on the current visible floors.
 *
 * This effect is intentionally self-contained (no EffectMaskRegistry / MaskManager).
 *
 * @module compositor-v2/effects/AshDisturbanceEffectV2
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { OVERLAY_THREE_LAYER } from '../../core/render-layers.js';
import {
  ParticleSystem as QuarksParticleSystem,
  BatchedRenderer,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ConstantValue,
  ApplyForce,
  ColorOverLife,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  CurlNoiseField,
} from '../../libs/three.quarks.module.js';

const log = createLogger('AshDisturbanceV2');

const GROUND_Z = 1000;
const BURST_Z_OFFSET = 5;

/** Min time between movement bursts per token (path updates can fire very often). */
const TOKEN_MOVE_BURST_MIN_MS = 75;

const ASH_MASK_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];

/** Parallel mask probe + CPU scan; serial per-tile was starving Foundry's websocket during populate. */
const ASH_TILE_PROBE_CONCURRENCY = 8;

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  if (!items.length) return [];
  const cap = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}

async function yieldToEventLoop() {
  await new Promise((r) => setTimeout(r, 0));
}

class AshBurstShape {
  /**
   * @param {Float32Array} pointsWorld - packed [x, y, brightness, ...] in world space
   */
  constructor(pointsWorld, groundZ) {
    this.points = pointsWorld;
    this.groundZ = groundZ;

    this.centerX = 0;
    this.centerY = 0;
    this.radius = 150;

    /** @type {number[]} */
    this._candidateIndices = [];
    this.type = 'ash_burst_v2';
  }

  setCenter(x, y, radius) {
    this.centerX = x;
    this.centerY = y;
    this.radius = Math.max(10, radius || 150);

    const pts = this.points;
    const candidates = [];
    const count = pts.length / 3;
    const rSq = this.radius * this.radius;

    for (let i = 0; i < count; i++) {
      const o = i * 3;
      const px = pts[o];
      const py = pts[o + 1];
      const b = pts[o + 2];
      if (b <= 0.0) continue;

      const dx = px - x;
      const dy = py - y;
      if ((dx * dx + dy * dy) <= rSq) {
        candidates.push(i);
      }
    }

    this._candidateIndices = candidates;
  }

  initialize(p) {
    const candidates = this._candidateIndices;
    if (!candidates || candidates.length === 0) {
      if (typeof p.life === 'number') p.life = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
      if (typeof p.size === 'number') p.size = 0;
      return;
    }

    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    const o = idx * 3;
    const px = this.points[o];
    const py = this.points[o + 1];
    const brightness = this.points[o + 2];

    p.position.x = px;
    p.position.y = py;
    p.position.z = this.groundZ + BURST_Z_OFFSET;

    const alphaScale = Math.max(0.2, Math.min(1.0, brightness));
    if (p.color && typeof p.color.w === 'number') {
      p.color.w *= alphaScale;
    }
    if (typeof p.size === 'number') {
      p.size *= (0.7 + 0.6 * alphaScale);
    }

    if (p.velocity) {
      p.velocity.set(0, 0, 0);
    }
  }

  update() {
  }
}

export class AshDisturbanceEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._renderBus = renderBus;

    this._enabled = false;
    this._initialized = false;

    /** @type {BatchedRenderer|null} */
    this._batchRenderer = null;

    /** @type {THREE.Texture|null} */
    this._particleTexture = null;
    /** @type {Promise<void>|null} */
    this._texturesReady = null;

    // Cache for direct mask probing to avoid repeated 404 spam.
    /** @type {Map<string, {url: string, image: HTMLImageElement} | null>} */
    this._directMaskCache = new Map();

    /**
     * Per-floor particle system state.
     * Key: floorIndex
     * Value: { points: Float32Array, systems: QuarksParticleSystem[] }
     * @type {Map<number, {points: Float32Array, systems: QuarksParticleSystem[]}>}
     */
    this._floorStates = new Map();

    /** @type {Set<number>} */
    this._activeFloors = new Set();

    /** @type {THREE.Vector2|null} */
    this._tempVec2 = null;

    /** @type {Array<[string, number]>} Foundry hook ids for cleanup */
    this._hookIds = [];

    /** @type {Map<string, number>} tokenId -> last burst time (ms) */
    this._tokenBurstLastMs = new Map();

    this._loggedFirstBurst = false;

    this.params = {
      enabled: false,
      burstRate: 270,
      burstDuration: 1.6,
      burstRadius: 170,
      maxParticles: 3000,
      lifeMin: 4,
      lifeMax: 5.9,
      sizeMin: 54,
      sizeMax: 77,
      windInfluence: 0.35,
      curlStrength: 20,
      curlScale: 140,
      opacityStart: 0.5,
      opacityEnd: 0.15,
      colorStart: { r: 0.50, g: 0.46, b: 0.42, a: 0.5 },
      colorEnd: { r: 0.30, g: 0.27, b: 0.24, a: 0.15 }
    };
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'burst', label: 'Burst Settings', type: 'inline', parameters: ['burstRate', 'burstDuration', 'burstRadius', 'maxParticles'] },
        { name: 'appearance', label: 'Appearance', type: 'inline', separator: true, parameters: ['sizeMin', 'sizeMax', 'lifeMin', 'lifeMax', 'opacityStart', 'opacityEnd'] },
        { name: 'motion', label: 'Motion', type: 'inline', separator: true, parameters: ['windInfluence', 'curlStrength', 'curlScale'] }
      ],
      presets: {
        'Light Disturbance': { burstRate: 200, burstDuration: 0.3, burstRadius: 180, maxParticles: 1500, sizeMin: 14, sizeMax: 35, lifeMin: 1.0, lifeMax: 2.5, opacityStart: 0.65, opacityEnd: 0.1, windInfluence: 0.5, curlStrength: 10, curlScale: 240 },
        'Standard': { burstRate: 500, burstDuration: 0.5, burstRadius: 250, maxParticles: 3000, sizeMin: 20, sizeMax: 50, lifeMin: 1.5, lifeMax: 3.5, opacityStart: 0.85, opacityEnd: 0.15, windInfluence: 0.6, curlStrength: 15, curlScale: 240 },
        'Heavy Disturbance': { burstRate: 800, burstDuration: 0.8, burstRadius: 350, maxParticles: 5000, sizeMin: 25, sizeMax: 65, lifeMin: 2.0, lifeMax: 4.5, opacityStart: 0.95, opacityEnd: 0.2, windInfluence: 0.8, curlStrength: 20, curlScale: 200 },
        'Volcanic': { burstRate: 1200, burstDuration: 1.2, burstRadius: 450, maxParticles: 6000, sizeMin: 30, sizeMax: 80, lifeMin: 2.5, lifeMax: 5.5, opacityStart: 1.0, opacityEnd: 0.3, windInfluence: 1.0, curlStrength: 30, curlScale: 160 }
      },
      parameters: {
        enabled: { type: 'boolean', default: false },
        burstRate: { type: 'slider', label: 'Burst Rate (particles/s)', min: 50, max: 2000, step: 10, default: 270, throttle: 50 },
        burstDuration: { type: 'slider', label: 'Burst Duration (s)', min: 0.1, max: 2.0, step: 0.05, default: 1.6, throttle: 50 },
        burstRadius: { type: 'slider', label: 'Burst Radius (px)', min: 50, max: 800, step: 10, default: 170, throttle: 50 },
        maxParticles: { type: 'slider', label: 'Max Particles', min: 500, max: 8000, step: 100, default: 3000, throttle: 50 },
        lifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.2, max: 6.0, step: 0.1, default: 4, throttle: 50 },
        lifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.5, max: 8.0, step: 0.1, default: 5.9, throttle: 50 },
        sizeMin: { type: 'slider', label: 'Size Min (px)', min: 4, max: 100, step: 1, default: 54, throttle: 50 },
        sizeMax: { type: 'slider', label: 'Size Max (px)', min: 8, max: 150, step: 1, default: 77, throttle: 50 },
        opacityStart: { type: 'slider', label: 'Opacity Start', min: 0.1, max: 1.0, step: 0.05, default: 0.5, throttle: 50 },
        opacityEnd: { type: 'slider', label: 'Opacity End', min: 0.0, max: 1.0, step: 0.05, default: 0.15, throttle: 50 },
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 3.0, step: 0.05, default: 0.35, throttle: 50 },
        curlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 80.0, step: 1, default: 20, throttle: 50 },
        curlScale: { type: 'slider', label: 'Curl Scale', min: 50, max: 800, step: 10, default: 140, throttle: 50 }
      }
    };
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(v) {
    this._enabled = !!v;
    if (this.params) this.params.enabled = !!v;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._tempVec2 = new THREE.Vector2();

    this._batchRenderer = new BatchedRenderer();
    // Must render above tiles and specular overlays.
    this._batchRenderer.renderOrder = 200050;
    this._batchRenderer.frustumCulled = false;
    try {
      if (this._batchRenderer.layers && typeof this._batchRenderer.layers.enable === 'function') {
        this._batchRenderer.layers.enable(OVERLAY_THREE_LAYER);
      }
    } catch (_) {}

    // IMPORTANT (V2): Do NOT register the BatchedRenderer into the bus here.
    // FloorRenderBus.populate() calls clear() which removes all _tiles entries,
    // including effect overlays. If we register in initialize(), the overlay is
    // immediately detached and the batch renderer ends up with parent=null.
    // We register (or re-register) in populate() after the bus has been populated.

    this._ensureTextures();

    this._registerTokenHooks();

    this._initialized = true;
    log.info('AshDisturbanceEffectV2 initialized');
  }

  async populate(foundrySceneData) {
    void foundrySceneData;

    const popT0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    const popPhase = (phase, extra = {}) => {
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      log.warn(`[POPULATE] AshDisturbanceEffectV2 | ${phase} | +${(now - popT0).toFixed(0)}ms`, extra);
    };

    popPhase('enter populate()');

    // Ensure our BatchedRenderer is attached to the bus scene AFTER the bus has
    // populated/cleared its internal tile map.
    try {
      if (this._batchRenderer && !this._batchRenderer.parent) {
        this._renderBus.addEffectOverlay('__ash_disturbance_batch__', this._batchRenderer, 0);
      }
    } catch (_) {}

    popPhase('after bus overlay attach attempt');

    // Build per-floor spawn point clouds.
    const tTex0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    try {
      await this._ensureTextures();
    } catch (_) {
    }
    const tTex1 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    popPhase('after ensureTextures()', { ensureTexturesMs: (tTex1 - tTex0).toFixed(0) });

    const THREE = window.THREE;
    if (!THREE) {
      popPhase('abort: THREE missing');
      return;
    }

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const worldH = canvas?.dimensions?.height ?? 0;

    // Background image source.
    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const tBg0 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      const bgPts = await this._probeScanPointsForSource({
        baseSrc: bgSrc,
        isBackground: true,
        floorIndex: 0,
        x: canvas?.dimensions?.sceneX ?? 0,
        y: canvas?.dimensions?.sceneY ?? 0,
        w: canvas?.dimensions?.sceneWidth ?? 0,
        h: canvas?.dimensions?.sceneHeight ?? 0,
        worldH,
      });
      const tBg1 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      if (bgPts) this._mergePointsIntoFloor(0, bgPts);
      popPhase('after background _Ash probe+scan', {
        bgProbeMs: (tBg1 - tBg0).toFixed(0),
        mergedPoints: !!bgPts,
      });
    } else {
      popPhase('skip background (no bg src)');
    }

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    const jobs = [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      jobs.push({
        floorIndex,
        baseSrc: src,
        x: Number(tileDoc.x) || 0,
        y: Number(tileDoc.y) || 0,
        w: Number(tileDoc.width) || 0,
        h: Number(tileDoc.height) || 0,
        worldH,
      });
    }

    popPhase('tile job list built', {
      tileDocCount: tileDocs.length,
      jobsWithSrc: jobs.length,
      concurrency: ASH_TILE_PROBE_CONCURRENCY,
    });

    const tPar0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    const probeRows = await mapWithConcurrency(
      jobs,
      ASH_TILE_PROBE_CONCURRENCY,
      async (job) => {
        const pts = await this._probeScanPointsForSource({
          baseSrc: job.baseSrc,
          isBackground: false,
          floorIndex: job.floorIndex,
          x: job.x,
          y: job.y,
          w: job.w,
          h: job.h,
          worldH: job.worldH,
        });
        return pts ? { floorIndex: job.floorIndex, points: pts } : null;
      },
    );
    const tPar1 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    const hits = probeRows.filter((r) => r != null).length;
    popPhase('after parallel probe+scan', {
      parallelWallMs: (tPar1 - tPar0).toFixed(0),
      jobs: jobs.length,
      rowsWithMaskHits: hits,
    });

    const tMerge0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    let mergeCount = 0;
    for (const row of probeRows) {
      if (!row) continue;
      this._mergePointsIntoFloor(row.floorIndex, row.points);
      mergeCount++;
      if (mergeCount % 32 === 0) {
        await yieldToEventLoop();
      }
    }
    const tMerge1 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    popPhase('after merge pass', {
      mergeWallMs: (tMerge1 - tMerge0).toFixed(0),
      mergedRows: mergeCount,
    });

    const tRb0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    let rebuildIdx = 0;
    for (const [floorIndex, st] of this._floorStates) {
      const tOne = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      this._rebuildSystemsForFloor(floorIndex, st.points);
      const tOneEnd = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      const oneMs = tOneEnd - tOne;
      if (oneMs > 50) {
        log.warn(`[POPULATE] AshDisturbanceEffectV2 | slow _rebuildSystemsForFloor | floor=${floorIndex} | ms=${oneMs.toFixed(0)} | +${(tOneEnd - popT0).toFixed(0)}ms since populate start`);
      }
      rebuildIdx++;
      if (rebuildIdx % 2 === 0) {
        await yieldToEventLoop();
      }
    }
    const tRb1 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    popPhase('after all _rebuildSystemsForFloor', {
      rebuildTotalMs: (tRb1 - tRb0).toFixed(0),
      floors: rebuildIdx,
    });

    const tFc0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
    const maxFloorIdx = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
    this.onFloorChange(maxFloorIdx);
    const tFc1 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    popPhase('after onFloorChange', { onFloorChangeMs: (tFc1 - tFc0).toFixed(0), maxFloorIdx });

    const popT1 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    log.warn(`[POPULATE] AshDisturbanceEffectV2 | populate() COMPLETE | totalMs=${(popT1 - popT0).toFixed(0)}`, {
      floors: this._floorStates.size,
      pointsByFloor: Array.from(this._floorStates.entries()).map(([k, v]) => [k, Math.floor((v.points?.length ?? 0) / 3)]),
    });
  }

  onFloorChange(maxFloorIndex) {
    const maxIdx = Number.isFinite(maxFloorIndex) ? maxFloorIndex : 0;

    // Visible floors in V2 are [0..maxIdx]. We keep systems for all visible floors
    // active so lower floors can show through gaps.
    const desired = new Set();
    for (let i = 0; i <= maxIdx; i++) desired.add(i);

    for (const fi of this._activeFloors) {
      if (!desired.has(fi)) {
        this._deactivateFloor(fi);
      }
    }
    for (const fi of desired) {
      if (!this._activeFloors.has(fi)) {
        this._activateFloor(fi);
      }
    }
  }

  update(timeInfo) {
    if (!this.enabled) return;
    if (!this._batchRenderer) return;

    const weather = window.MapShine?.weatherController?.getCurrentState?.() ?? {};
    const ashBoost = Math.max(0, Math.min(1, Number(weather.ashIntensity) || 0));

    const motionDelta = (typeof timeInfo?.motionDelta === 'number')
      ? timeInfo.motionDelta
      : (typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016);

    // Quarks tick whenever the effect is enabled (bursts use mask + enabled; weather ash is optional).
    try {
      this._batchRenderer.update(motionDelta);
    } catch (_) {
    }

    // Wind scales with weather ash intensity; curl follows user params regardless.
    const windSpeed = Number(weather.windSpeed) || 0;
    const windDir = weather.windDirection || { x: 1, y: 0 };
    const wx = Number(windDir.x) || 1;
    const wy = Number(windDir.y) || 0;
    const len = Math.hypot(wx, wy) || 1;
    const dirX = wx / len;
    const dirY = wy / len;

    for (const fi of this._activeFloors) {
      const st = this._floorStates.get(fi);
      if (!st?.systems) continue;
      for (const system of st.systems) {
        if (!system?.userData) continue;

        const t = Number(system.userData.burstTime) || 0;
        if (t > 0) {
          system.userData.burstTime = Math.max(0, t - motionDelta);
          if (system.userData.burstTime <= 0) {
            const emission = system.emissionOverTime;
            if (emission && typeof emission.value === 'number') emission.value = 0;
          }
        }

        const windForce = system.userData.windForce;
        if (windForce?.direction) {
          windForce.direction.set(dirX, dirY, 0);
          if (windForce.magnitude && typeof windForce.magnitude.value === 'number') {
            windForce.magnitude.value = 600 * windSpeed * (this.params.windInfluence ?? 0.6) * ashBoost;
          }
        }

        const curl = system.userData.curl;
        const baseCurl = system.userData.baseCurlStrength;
        if (curl && baseCurl) {
          curl.strength.copy(baseCurl).multiplyScalar(Math.max(0.0, this.params.curlStrength ?? 15));
        }
      }
    }
  }

  /**
   * Trigger an ash burst centered on the given world position.
   * @param {number} worldX
   * @param {number} worldY
   */
  triggerBurstAt(worldX, worldY) {
    if (!this.enabled) return;

    const weather = window.MapShine?.weatherController?.getCurrentState?.() ?? {};
    const ashBoost = Math.max(0, Math.min(1, Number(weather.ashIntensity) || 0));
    const burstRateMul = 1.0 + 0.5 * ashBoost;

    // Pick the topmost visible floor (active) as the primary burst floor.
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
    const floorIndex = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
    const st = this._floorStates.get(floorIndex);
    if (!st?.systems?.length) return;

    const system = st.systems[Math.floor(Math.random() * st.systems.length)];
    const shape = system?.userData?.burstShape;
    if (!shape) return;

    shape.setCenter(worldX, worldY, this.params.burstRadius);

    const emission = system.emissionOverTime;
    if (emission && typeof emission.value === 'number') {
      emission.value = Math.max(0, (this.params.burstRate || 0) * burstRateMul);
    }
    system.userData.burstTime = Math.max(0.05, this.params.burstDuration || 0.2);

    if (!this._loggedFirstBurst) {
      this._loggedFirstBurst = true;
      log.info('Ash disturbance: first V2 burst', {
        floorIndex,
        x: Number(worldX.toFixed(0)),
        y: Number(worldY.toFixed(0)),
        candidates: shape._candidateIndices?.length ?? 0,
        systems: st.systems.length,
      });
    }
  }

  /**
   * Called by Foundry hook: token doc changed with x/y.
   * @param {string} tokenId
   */
  handleTokenMovement(tokenId) {
    if (!this.enabled) return;

    const token = canvas?.tokens?.get?.(tokenId);
    const doc = token?.document || canvas?.scene?.tokens?.get?.(tokenId);
    if (!doc) return;

    const grid = canvas?.grid;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0)
      ? grid.sizeX
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0)
      ? grid.sizeY
      : gridSizeX;

    const widthPx = doc.width * gridSizeX;
    const heightPx = doc.height * gridSizeY;

    // Convert Foundry top-left to world center (Three Y-up).
    const worldH = canvas?.dimensions?.height ?? 0;
    const centerX = (Number(doc.x) || 0) + widthPx / 2;
    const centerY = worldH - ((Number(doc.y) || 0) + heightPx / 2);

    this.triggerBurstAt(centerX, centerY);
  }

  applyParamChange(paramId, value) {
    if (!this.params) return;

    if (paramId === 'enabled' || paramId === 'masterEnabled') {
      this.enabled = !!value;
      return;
    }

    if (Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }

    if (paramId === 'opacityStart') {
      this.params.colorStart.a = Number(value) || 0;
    } else if (paramId === 'opacityEnd') {
      this.params.colorEnd.a = Number(value) || 0;
    }
  }

  dispose() {
    try {
      this._unregisterTokenHooks();
      this._tokenBurstLastMs.clear();

      for (const fi of this._activeFloors) this._deactivateFloor(fi);
      this._activeFloors.clear();

      for (const [fi, st] of this._floorStates) {
        for (const sys of (st.systems || [])) {
          try {
            this._batchRenderer?.deleteSystem?.(sys);
          } catch (_) {}
        }
      }
      this._floorStates.clear();

      if (this._batchRenderer) {
        try { this._renderBus.removeEffectOverlay('__ash_disturbance_batch__'); } catch (_) {}
      }
      this._batchRenderer = null;

      if (this._particleTexture) {
        try { this._particleTexture.dispose(); } catch (_) {}
      }
      this._particleTexture = null;
      this._texturesReady = null;
    } catch (_) {
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _registerTokenHooks() {
    if (this._hookIds.length) return;
    const H = globalThis.Hooks;
    if (!H || typeof H.on !== 'function') return;

    const id = H.on('updateToken', (tokenDoc, changes) => {
      if (!this.enabled || !this._initialized) return;
      if (!tokenDoc?.id) return;
      if (!changes || (changes.x === undefined && changes.y === undefined)) return;

      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      const last = this._tokenBurstLastMs.get(tokenDoc.id) ?? 0;
      if (now - last < TOKEN_MOVE_BURST_MIN_MS) return;
      this._tokenBurstLastMs.set(tokenDoc.id, now);

      this.handleTokenMovement(tokenDoc.id);
    });
    this._hookIds.push(['updateToken', id]);
  }

  _unregisterTokenHooks() {
    const H = globalThis.Hooks;
    if (!H || typeof H.off !== 'function') {
      this._hookIds.length = 0;
      return;
    }
    for (const [name, hookId] of this._hookIds) {
      try {
        H.off(name, hookId);
      } catch (_) {}
    }
    this._hookIds.length = 0;
  }

  _activateFloor(floorIndex) {
    const st = this._floorStates.get(floorIndex);
    if (!st?.systems?.length) return;
    if (!this._batchRenderer) return;

    for (const sys of st.systems) {
      try {
        // Some builds require explicit re-add on floor swap.
        const map = this._batchRenderer.systemToBatchIndex;
        if (map?.has?.(sys)) continue;
        this._batchRenderer.addSystem(sys);
      } catch (_) {
      }

      // Ensure the emitter is parented under the BatchedRenderer so quarks can
      // update world matrices and the bus scene actually renders the particles.
      try {
        if (sys?.emitter && !sys.emitter.parent) {
          this._batchRenderer.add(sys.emitter);
        }
      } catch (_) {}

      // Some versions require play() to start emission.
      try { sys?.play?.(); } catch (_) {}
    }

    this._activeFloors.add(floorIndex);
  }

  _deactivateFloor(floorIndex) {
    const st = this._floorStates.get(floorIndex);
    if (!st?.systems?.length) {
      this._activeFloors.delete(floorIndex);
      return;
    }
    if (!this._batchRenderer) {
      this._activeFloors.delete(floorIndex);
      return;
    }

    for (const sys of st.systems) {
      try {
        this._batchRenderer.deleteSystem(sys);
      } catch (_) {
      }

      try {
        if (sys?.emitter?.parent) {
          sys.emitter.parent.remove(sys.emitter);
        }
      } catch (_) {}
    }

    this._activeFloors.delete(floorIndex);
  }

  async _ensureTextures() {
    if (this._texturesReady) return this._texturesReady;

    const THREE = window.THREE;
    if (!THREE) {
      this._texturesReady = Promise.resolve();
      return this._texturesReady;
    }

    this._texturesReady = new Promise((resolve) => {
      try {
        const loader = new THREE.TextureLoader();
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
            log.warn('AshDisturbanceEffectV2: failed to load particle texture');
            resolve();
          }
        );
      } catch (_) {
        resolve();
      }
    });

    return this._texturesReady;
  }

  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

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

  /**
   * Probe `_Ash` mask and scan pixels to world-space spawn points (no `_floorStates` mutation).
   * @returns {Promise<Float32Array|null>}
   * @private
   */
  async _probeScanPointsForSource({ baseSrc, isBackground, floorIndex, x, y, w, h, worldH }) {
    void floorIndex;
    if (!baseSrc) return null;
    if (!(w > 0 && h > 0)) return null;

    const basePath = this._extractBasePath(baseSrc);
    if (!basePath) return null;

    const mask = await this._probeDirectMask(basePath, '_Ash', { suppressProbeErrors: true });
    if (!mask?.image) return null;

    const points = this._scanMaskToWorldPoints(mask.image, {
      isBackground,
      x,
      y,
      w,
      h,
      worldH,
    });

    if (!points || points.length === 0) return null;
    return points;
  }

  /**
   * Append packed spawn points for a floor (called sequentially after parallel probe).
   * @private
   */
  _mergePointsIntoFloor(floorIndex, points) {
    const existing = this._floorStates.get(floorIndex);
    if (!existing) {
      this._floorStates.set(floorIndex, { points, systems: [] });
      return;
    }

    const a = existing.points;
    const b = points;
    const merged = new Float32Array(a.length + b.length);
    merged.set(a, 0);
    merged.set(b, a.length);
    existing.points = merged;
  }

  _scanMaskToWorldPoints(image, { isBackground, x, y, w, h, worldH }) {
    try {
      const iw = image?.width ?? image?.naturalWidth ?? 0;
      const ih = image?.height ?? image?.naturalHeight ?? 0;
      if (!(iw > 0 && ih > 0)) return null;

      const cvs = document.createElement('canvas');
      cvs.width = iw;
      cvs.height = ih;
      const ctx = cvs.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, iw, ih).data;

      // Adaptive stride to limit CPU time.
      const stride = Math.max(1, Math.floor(Math.max(iw, ih) / 512));
      const threshold = 0.12;

      const coords = [];
      for (let py = 0; py < ih; py += stride) {
        for (let px = 0; px < iw; px += stride) {
          const idx = (py * iw + px) * 4;
          const b = data[idx] / 255.0;
          if (b <= threshold) continue;

          const u = px / (iw - 1);
          const v = py / (ih - 1);

          // Base image UV -> Foundry coords.
          const fx = x + u * w;
          const fy = y + v * h;

          // Foundry Y-down -> world Y-up.
          const wx = fx;
          const wy = worldH - fy;

          coords.push(wx, wy, b);
        }
      }

      if (coords.length === 0) return null;
      return new Float32Array(coords);
    } catch (err) {
      log.warn('AshDisturbanceEffectV2: scanMaskToWorldPoints failed', err);
      return null;
    }
  }

  _rebuildSystemsForFloor(floorIndex, pointsWorld) {
    if (!this._batchRenderer) return;
    if (!pointsWorld || pointsWorld.length === 0) return;

    // Clear existing.
    const st = this._floorStates.get(floorIndex);
    if (!st) return;
    for (const sys of st.systems) {
      try { this._batchRenderer.deleteSystem(sys); } catch (_) {}
      try {
        if (sys?.emitter?.parent) {
          sys.emitter.parent.remove(sys.emitter);
        }
      } catch (_) {}
    }
    st.systems = [];

    const THREE = window.THREE;
    if (!THREE) return;

    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number')
      ? sceneComposer.groundZ
      : GROUND_Z;

    const material = new THREE.MeshBasicMaterial({
      map: this._particleTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0x6b625b,
      opacity: 1.0,
      side: THREE.DoubleSide
    });

    const p = this.params;

    const startColor = new ColorRange(
      new Vector4(p.colorStart.r, p.colorStart.g, p.colorStart.b, p.colorStart.a),
      new Vector4(p.colorStart.r, p.colorStart.g, p.colorStart.b, p.colorStart.a)
    );

    const colorOverLife = new ColorOverLife(new ColorRange(
      new Vector4(p.colorStart.r, p.colorStart.g, p.colorStart.b, p.colorStart.a),
      new Vector4(p.colorEnd.r, p.colorEnd.g, p.colorEnd.b, p.colorEnd.a)
    ));

    const sizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(0.2, 1.0, 0.8, 0.0), 0]
    ]));

    const createBurstSystem = () => {
      // Particles for upper floors should sit slightly above the corresponding
      // floor's albedo plane (GROUND_Z + floorIndex).
      const shape = new AshBurstShape(pointsWorld, groundZ + floorIndex);

      const windForce = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(0));
      const curlScale = Math.max(1.0, p.curlScale ?? 240);
      const curlStrength = Math.max(0.0, p.curlStrength ?? 10);
      const curl = new CurlNoiseField(
        new THREE.Vector3(curlScale, curlScale, curlScale),
        new THREE.Vector3(curlStrength, curlStrength, curlStrength),
        1.0
      );

      const system = new QuarksParticleSystem({
        duration: 1,
        looping: true,
        prewarm: false,
        startLife: new IntervalValue(p.lifeMin, p.lifeMax),
        startSpeed: new ConstantValue(0),
        startSize: new IntervalValue(p.sizeMin, p.sizeMax),
        startColor,
        worldSpace: true,
        maxParticles: p.maxParticles,
        emissionOverTime: new ConstantValue(0),
        shape,
        material,
        renderMode: RenderMode.BillBoard,
        renderOrder: 200060,
        behaviors: [
          windForce,
          curl,
          colorOverLife,
          sizeOverLife,
        ]
      });

      system.userData = {
        burstShape: shape,
        windForce,
        curl,
        baseCurlStrength: curl.strength.clone(),
        burstTime: 0,
      };

      return system;
    };

    const systemCount = 6;
    for (let i = 0; i < systemCount; i++) {
      st.systems.push(createBurstSystem());
    }

    // Ensure systems for visible floors are registered.
    if (this._activeFloors.has(floorIndex)) {
      this._activateFloor(floorIndex);
    }
  }

  _extractBasePath(src) {
    try {
      const s = String(src || '');
      if (!s) return null;
      const q = s.indexOf('?');
      const clean = q >= 0 ? s.slice(0, q) : s;
      const lastDot = clean.lastIndexOf('.');
      if (lastDot <= 0) return clean;
      const ext = clean.slice(lastDot + 1).toLowerCase();
      if (ASH_MASK_FORMATS.includes(ext)) return clean.slice(0, lastDot);
      return clean;
    } catch (_) {
      return null;
    }
  }

  async _probeDirectMask(basePath, suffix, options = {}) {
    const cacheKey = `${basePath}${suffix}::${ASH_MASK_FORMATS.join(',')}`;
    if (this._directMaskCache.has(cacheKey)) {
      return this._directMaskCache.get(cacheKey);
    }

    // First try canonical probe helper (respects negative cache + hosted constraints).
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

    const url = probe.path;
    const image = await this._loadImage(url);
    const out = image ? { url, image } : null;
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
