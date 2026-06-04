/**
 * @fileoverview Overhead Shadows Effect V2 (adapted from V1)
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's capture passes (roof/fluid/tile/upper-floor-alpha composite),
 * temporary override restoration, floor/context behavior, or output textures
 * or roof capture outputs consumed by {@link LightingEffectV2} (ceiling transmittance),
 * you MUST update HealthEvaluator contracts/wiring for `OverheadStampEffectV2`
 * and related `LightingEffectV2` edges to prevent silent failures.
 * Renders soft, directional shadows cast by overhead tiles onto the ground (stamp path).
 * Building / sky-reach / upper-floor **tile** directional shadows are owned by ShadowManager
 * producers; this effect no longer embeds those duplicate terms.
 * @module compositor-v2/effects/OverheadStampEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { tileDocRestrictsLight } from '../../scene/tile-manager.js';
import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';
import { getBandOutdoorsMask } from '../../masks/indoor-outdoor-mask-api.js';
import {
  hashCamera,
  hashCasterLive,
  hashRoofMaskCapture,
  hashTileProjectionCapture,
  hashTileProjectionIds,
} from './overhead-stamp/cacheSignatures.js';
import { SceneCaptureScope } from './overhead-stamp/SceneCaptureScope.js';
import { OverheadMaskBlurPass } from './overhead-stamp/OverheadMaskBlurPass.js';
import { OverheadTileProjectionPass } from './overhead-stamp/OverheadTileProjectionPass.js';
import { OverheadMaskCapturePass } from './overhead-stamp/OverheadMaskCapturePass.js';
import { createOverheadStampCompositeMaterial } from './overhead-stamp/OverheadStampCompositeShader.js';
import {
  applyShadowSunDirection,
  resolveEffectShadowSun2D,
} from '../shadow-system/ShadowSunDirection.js';

const log = createLogger('OverheadStampEffect');

/**
 * @param {import('three').Object3D} object
 * @returns {boolean}
 */
function objectRestrictsLightForRoofCapture(object) {
  if (object?.userData?.restrictsLight === true) return true;
  const id = object?.userData?.foundryTileId;
  if (!id) return false;
  try {
    const doc = canvas?.scene?.tiles?.get?.(id);
    return tileDocRestrictsLight(doc);
  } catch (err) {
    log.debug('restrictsLight doc lookup failed', err);
    return false;
  }
}

/**
 * Overhead Shadows Effect V2 (adapted from V1).
 *
 * - Uses ROOF_LAYER (20) overhead tiles as a stamp.
 * - Tree canopies are intentionally excluded from weather roof visibility/blocker
 *   captures to avoid canopy-alpha halos suppressing lighting around trees.
 * - Casts a short, soft shadow "downwards" from roofs by sampling an
 *   offset version of the roof mask.
 * - Only darkens the region outside the roof by subtracting the base roof
 *   alpha from the offset roof alpha.
 * - Upper-floor slabs (`levelRole: floor` or tile flag `floorCastsOverheadShadow`)
 *   use ROOF_LAYER like ceilings; FloorRenderBus reveals them during capture when
 *   the active floor is below so downstairs still receives their shadow mask.
 */
export class OverheadStampEffectV2 {
  /** @param {import('./FloorRenderBus.js').FloorRenderBus|null} [renderBus] */
  constructor(renderBus = null) {
    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this.roofTarget = null;   // Raw roof alpha (overhead tiles)

    /** @type {THREE.WebGLRenderTarget|null} */
    this.roofBlockTarget = null; // Screen-space forced-opaque roof alpha (no guard remap)

    /** @type {THREE.WebGLRenderTarget|null} */
    this.roofVisibilityTarget = null; // Runtime roof visibility alpha for LightingEffectV2 suppression

    /**
     * Screen-space union of overhead tiles with Foundry Restrict light (alpha = texture alpha).
     * @type {THREE.WebGLRenderTarget|null}
     */
    this.roofRestrictLightTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.rainOcclusionVisibilityTarget = null; // Runtime visibility alpha used by weather masking

    /** @type {THREE.WebGLRenderTarget|null} */
    this.rainOcclusionBlockTarget = null; // Forced-opaque blocker alpha used by weather masking

    /** @type {THREE.WebGLRenderTarget|null} */
    this.shadowTarget = null; // Final overhead shadow factor texture

    // Outdoors mask now obtained from GpuSceneMaskCompositor via FloorCompositor

    /** @type {THREE.Texture|null} */
    this.fluidRoofTarget = null; // Fluid-only roof pass (for optional shadow tint)

    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileProjectionTarget = null; // Selected tile alpha pass for tile shadow projection

    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileProjectionSortTarget = null; // Selected tile sort pass (alpha encoded) for tile shadow projection

    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileReceiverAlphaTarget = null; // Visible tile alpha pass (all tiles)

    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileReceiverSortTarget = null; // Visible tile sort pass (all tiles)

    /** @type {THREE.Texture|null} */
    this.inputTexture = null;

    /** @type {import('../../scene/tile-motion-manager.js').TileMotionManager|null} */
    this._tileMotionManager = null;

    /** @type {import('./FloorRenderBus.js').FloorRenderBus|null} */
    this._renderBus = renderBus ?? null;

    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null; // _Outdoors mask (bright outside, dark indoors)

    /** @type {THREE.Vector2|null} */
    this.sunDir = null; // Screen-space sun direction, driven by TimeManager
    /** @type {number} */
    this._sunDirLengthSq = 1.0;

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null; // Groundplane mesh

    /** @type {THREE.Scene|null} */
    this.shadowScene = null; // World-pinned shadow mesh scene
    /** @type {THREE.Mesh|null} */
    this.shadowMesh = null;

    this.params = {
      enabled: true,
      opacity: 0.5,
      length: 0.1,
      softness: 5,
      outdoorShadowLengthScale: 1.0,
      indoorReceiverShadowLengthScale: 0.25,
      verticalOnly: true,  // v1: primarily vertical motion in screen space
      affectsLights: 0.75,
      sunLatitude: 0.1,    // 0=flat east/west, 1=maximum north/south arc
      indoorShadowEnabled: true, // Back-compat toggle; controls projected _Outdoors dark-region building shadow contribution on outdoor receivers
      indoorShadowOpacity: 1,   // Back-compat alias for outdoorBuildingShadowOpacity
      outdoorBuildingShadowOpacity: 1,
      indoorShadowLengthScale: 4.87, // Back-compat alias for outdoorBuildingShadowLengthScale
      outdoorBuildingShadowLengthScale: 4.87,
      indoorShadowSoftness: 2,
      indoorFluidShadowSoftness: 3.1,
      indoorFluidShadowIntensityBoost: 0.81,
      indoorFluidColorSaturation: 1.2,
      tileProjectionEnabled: true,
      tileProjectionOpacity: 0.5,
      tileProjectionLengthScale: 1.0,
      tileProjectionSoftness: 3.0,
      tileProjectionThreshold: 0.05,
      tileProjectionPower: 1.0,
      tileProjectionOutdoorOpacityScale: 0.75,
      tileProjectionIndoorOpacityScale: 1.0,
      tileProjectionSortBias: 0.002,
      fluidColorEnabled: true,
      fluidEffectTransparency: 0.35,
      fluidShadowIntensityBoost: 1.0,
      fluidShadowSoftness: 3.0,
      fluidColorBoost: 1.5,
      fluidColorSaturation: 1.2,
      debugView: 'final',
      /** Darken outdoor receivers where upper-floor tile alpha blocks sky (derived skyReach). */
      skyReachShadowEnabled: true,
      skyReachShadowOpacity: 1,
      /** Composite all upper floors' GPU `floorAlpha` masks and project like building shadow. */
      upperFloorTileShadowEnabled: true,
      upperFloorTileShadowOpacity: 1,
      upperFloorTileShadowLengthScale: 4.7,
      /** `multiply`: Π alpha (strict; gaps on any upper band weaken shadow). `max`: union of coverage (recommended multi-floor). */
      upperFloorTileCombineMode: 'multiply',
      dynamicLightShadowOverrideEnabled: true,
      dynamicLightShadowOverrideStrength: 0.7,
    };
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations
    this._tempSize = null; // Lazy init when THREE is available

    /** @type {function|null} Unsubscribe from EffectMaskRegistry */
    this._registryUnsub = null;

    /**
     * Per-floor outdoors mask cache so bindFloorMasks() skips redundant swaps.
     * @type {Map<string, {outdoorsMask: THREE.Texture|null}>}
     */
    this._floorStates = new Map();

    /** @type {THREE.Texture|null} 1×1 RGBA white — valid sampler when an upper-floor mask slot is unused. */
    this._whiteMaskPlaceholder = null;

    /** Identity string for upper-floor _Outdoors textures bound for Outdoor Building Shadow casters. */
    this._lastObUpperSig = '';

    /** @type {THREE.Texture|null} */
    this._lastOutdoorsMaskRef = null;

    /** @type {THREE.Texture|null} */
    this._lastSkyReachMaskRef = null;

    /** Identity string for upper-floor `floorAlpha` textures (composite input refresh). */
    this._lastUpperFloorAlphaSig = '';

    /** @type {THREE.Texture|null} */
    this._dynamicLightTexture = null;
    /** @type {THREE.Texture|null} */
    this._windowLightTexture = null;
    this._dynamicLightOverrideStrength = 0.7;
    this._sunAzimuthDeg = null;
    this._sunElevationDeg = null;
    this._driverShadowSoftnessScale = 1.0;
    this._driverShadowLengthScale = 1.0;
    /** @type {{ isValid: boolean, isOrtho: boolean, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number, zoom: number, groundZ: number, c00x: number, c00y: number, c10x: number, c10y: number, c01x: number, c01y: number, c11x: number, c11y: number }} */
    this._stampViewCache = {
      isValid: false, isOrtho: true,
      px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, zoom: 1, groundZ: 0,
      c00x: 0, c00y: 0, c10x: 1, c10y: 0, c01x: 0, c01y: 1, c11x: 1, c11y: 1,
    };
    this._treeRainMaskProbeLastKey = '';
    this._treeRainMaskProbeLastTs = 0;
    this._treeRainDebugHeartbeatLastTs = 0;

    // PERFORMANCE: Per-frame caster cache. Built once at start of render() via
    // a single mainScene.traverse() and reused by all caster/blocker/tile passes.
    // Replaces ~15 separate scene traversals per frame with one O(N) walk plus
    // cheap array iteration. Entries store object refs + categorization flags;
    // live state (visible, opacity) is always read from the object at use time.
    this._frameCasters = {
      list: [],           // All cached entries (anything relevant to overhead capture)
      hasTrees: false,    // True if any tree entries exist
      hasFluid: false,    // True if any fluid-overlay entries exist
      frameId: -1,        // Monotonic per-frame token to detect rebuild necessity
      scene: null,        // Scene reference at time of last build
    };
    this._frameCasterId = 0;

    /**
     * When true, roof/visibility captures were reused from cache this frame — ceiling
     * transmittance in {@link LightingEffectV2} should retain the previous RT contents.
     * @type {boolean}
     */
    this._lastRoofMaskCaptureReused = false;

    // PERFORMANCE: Throttle global window.MapShine debug lookup.
    // _isTreeRainMaskDebugEnabled() previously walked window.MapShine on every
    // render(); cache the result and refresh at most ~every 2s.
    this._debugTreeRainEnabledCache = false;
    this._debugTreeRainEnabledCacheTs = 0;

    /**
     * Roof / blocker / rain-occlusion capture cache. When camera, buffer size,
     * guard scale, and live caster fade state are unchanged, the ~8 scene
     * re-renders per frame are skipped and prior RT contents are reused.
     * @type {{ valid: boolean, sigHash: number, capturedAtMs: number }}
     */
    this._roofMaskCaptureCache = { valid: false, sigHash: 0, capturedAtMs: 0 };

    /**
     * Optional tile-projection capture cache (same invalidation as roof masks).
     * @type {{ valid: boolean, sigHash: number, hasProjection: boolean, hasProjectionSort: boolean, hasReceiverSort: boolean }}
     */
    this._tileProjectionCaptureCache = {
      valid: false,
      sigHash: 0,
      hasProjection: false,
      hasProjectionSort: false,
      hasReceiverSort: false,
    };

    this._maskBlur = new OverheadMaskBlurPass();
    this._tileProjectionPass = new OverheadTileProjectionPass();
    this._maskCapturePass = new OverheadMaskCapturePass();
    /** @type {Set<string>} */
    this._tileProjectionIdSet = new Set();
    this._tileProjectionIdsHash = 0;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.roofBlurredTarget = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileProjectionBlurredTarget = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this.fluidRoofBlurredTarget = null;

    /** @type {import('../../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder|null} */
    this._activePerfRecorder = null;
  }

  /**
   * Build (or reuse) a per-frame caster cache.
   *
   * Single mainScene.traverse() that categorizes every relevant object so the
   * downstream render() passes can iterate a flat array instead of re-walking
   * the scene graph. Cache is keyed by `frameId` so multiple consumers in the
   * same frame all share the same build.
   *
   * Each entry stores stable refs (object/material/uniforms) plus
   * categorization flags. Live mutable state (visible, opacity, uniform values)
   * is always read/written through the stored refs at use time.
   *
   * @param {number} frameId Monotonic frame id (rebuild when changed)
   * @param {number} roofCaptureMaskBits Bitmask of ROOF_LAYER | WEATHER_ROOF_LAYER
   * @returns {Array<object>} The cached list (same instance each call within a frame)
   * @private
   */
  _ensureFrameCasters(frameId, roofCaptureMaskBits) {
    const fc = this._frameCasters;
    if (fc.frameId === frameId && fc.scene === this.mainScene) {
      return fc.list;
    }
    fc.frameId = frameId;
    fc.scene = this.mainScene;
    const list = fc.list;
    list.length = 0;
    fc.hasTrees = false;
    fc.hasFluid = false;
    if (!this.mainScene) return list;

    this.mainScene.traverse((object) => {
      if (!object) return;
      const layers = object.layers;
      const layersMask = layers?.mask ?? 0;
      const ud = object.userData;
      const mat = object.material;
      const hasRoofLayer = (layersMask & roofCaptureMaskBits) !== 0;
      const isTree = !!ud?.mapShineTreeTileId;
      const tileId = this._resolveFoundryTileId(object);
      const isFoundryTile = !!tileId;
      const isTileRenderable = !!(object.isSprite || object.isMesh);
      if (!hasRoofLayer && !isTree && !isFoundryTile) return;
      const uniforms = mat?.uniforms ?? null;
      const isFluidOverlay = !!uniforms?.tFluidMask;
      if (isFluidOverlay) fc.hasFluid = true;
      if (isTree) fc.hasTrees = true;
      const sortKey = isFoundryTile ? this._getTileSortKey(object) : 0;
      list.push({
        object,
        mat: mat ?? null,
        uniforms,
        hasRoofLayer,
        isTree,
        isFluidOverlay,
        isFoundryTile,
        isBusTile: !!ud?.mapShineBusTile,
        isSprite: !!object.isSprite,
        isMesh: !!object.isMesh,
        isTileRenderable,
        hasMaterial: !!mat,
        floorIndex: Number(ud?.floorIndex),
        tileId,
        sortKey,
      });
    });
    return list;
  }

  /**
   * Invalidate the frame caster cache. Cheap; next render() rebuilds on demand.
   * @private
   */
  _invalidateFrameCasters() {
    this._frameCasters.frameId = -1;
    this._frameCasters.scene = null;
  }

  /**
   * @param {{texture?: any, windowTexture?: any, strength?: number}|null} payload
   */
  setDynamicLightOverride(payload = null) {
    this._dynamicLightTexture = payload?.texture ?? null;
    this._windowLightTexture = payload?.windowTexture ?? null;
    this._dynamicLightOverrideStrength = Number.isFinite(Number(payload?.strength))
      ? Math.max(0.0, Math.min(1.0, Number(payload.strength)))
      : 0.7;
  }

  setSunAngles(azimuthDeg, elevationDeg) {
    this._sunAzimuthDeg = Number.isFinite(Number(azimuthDeg)) ? Number(azimuthDeg) : null;
    this._sunElevationDeg = Number.isFinite(Number(elevationDeg)) ? Number(elevationDeg) : null;
  }

  /**
   * Push ShadowDriverState sun + length scale into composite uniforms immediately.
   * @private
   */
  _applyShadowDriverUniforms() {
    if (!this.material?.uniforms) return;
    const THREE = window.THREE;
    if (!THREE) return;

    const sun2d = resolveEffectShadowSun2D({
      azimuthDeg: this._sunAzimuthDeg,
      elevationDeg: this._sunElevationDeg,
      latitudeScale: this.params.sunLatitude ?? 0.1,
      previousDir: this.sunDir,
    });
    this._sunDirLengthSq = sun2d.lengthSq;
    if (!this.sunDir) {
      this.sunDir = new THREE.Vector2(sun2d.x, sun2d.y);
    } else {
      applyShadowSunDirection(this.sunDir, sun2d);
    }
    const u = this.material.uniforms;
    if (u.uSunDir) u.uSunDir.value.copy(this.sunDir);
    if (u.uSunDirLength) {
      u.uSunDirLength.value = Math.sqrt(Math.max(sun2d.lengthSq, 0));
    }
    if (u.uShadowLengthScale) {
      u.uShadowLengthScale.value = Math.max(0, Number(this._driverShadowLengthScale) || 1);
    }
  }

  setDriver(driverState = null) {
    if (!driverState) return;
    this.setSunAngles(driverState.sun?.azimuthDeg, driverState.sun?.elevationDeg);
    this.setDynamicLightOverride(driverState.dynamicLightOverride ?? null);
    if (Number.isFinite(Number(driverState.tuning?.shadowSoftnessScale))) {
      this._driverShadowSoftnessScale = Number(driverState.tuning.shadowSoftnessScale);
    }
    if (Number.isFinite(Number(driverState.tuning?.shadowLengthScale))) {
      this._driverShadowLengthScale = Number(driverState.tuning.shadowLengthScale);
    }
    this._applyShadowDriverUniforms();
  }

  /**
   * Debug: tree / rain occlusion capture. Enable any of:
   * - `window.MapShine.debugTreeRainMaskProbe = true` (or 1 / "true")
   * - `globalThis.__MSA_DEBUG_TREE_RAIN_MASK__ = true`
   *
   * PERFORMANCE: Result is cached for ~1s to keep window.* lookups off the hot
   * render path. The probe only emits once every 400ms anyway, so a 1s cache
   * window has no functional impact for debugging.
   * @returns {boolean}
   * @private
   */
  _isTreeRainMaskDebugEnabled() {
    const now = (typeof performance !== 'undefined' && performance?.now) ? performance.now() : Date.now();
    if ((now - this._debugTreeRainEnabledCacheTs) < 1000) {
      return this._debugTreeRainEnabledCache;
    }
    this._debugTreeRainEnabledCacheTs = now;
    let enabled = false;
    try {
      const g = typeof globalThis !== 'undefined' ? globalThis : window;
      if (g.__MSA_DEBUG_TREE_RAIN_MASK__ === true) {
        enabled = true;
      } else {
        const v = g.MapShine?.debugTreeRainMaskProbe;
        if (v === true || v === 1) enabled = true;
        else if (typeof v === 'string' && v.toLowerCase() === 'true') enabled = true;
      }
    } catch (_) {
      enabled = false;
    }
    this._debugTreeRainEnabledCache = enabled;
    return enabled;
  }

  /**
   * Throttled proof that `render()` is running (helps when payload probe never fired).
   * @private
   */
  _treeRainMaskDebugHeartbeat() {
    if (!this._isTreeRainMaskDebugEnabled()) return;
    const now = (typeof performance !== 'undefined' && performance?.now) ? performance.now() : Date.now();
    if (now - this._treeRainDebugHeartbeatLastTs < 2000) return;
    this._treeRainDebugHeartbeatLastTs = now;
    try {
      console.log('[MSA][TreeRainMaskProbe] overhead render tick', {
        paramsEnabled: !!this.params?.enabled,
        hasRoofBlockTarget: !!this.roofBlockTarget,
        hasRainOcclusionVis: !!this.rainOcclusionVisibilityTarget,
        hasMaterial: !!this.material,
        hasMainScene: !!this.mainScene,
        hasShadowScene: !!this.shadowScene,
      });
    } catch (_) {}
  }

  _emitTreeRainMaskProbe(payload) {
    if (!this._isTreeRainMaskDebugEnabled()) return;
    const now = (typeof performance !== 'undefined' && performance?.now) ? performance.now() : Date.now();
    let key;
    try {
      key = JSON.stringify(payload);
    } catch (_) {
      key = String(payload);
    }
    if (key === this._treeRainMaskProbeLastKey && (now - this._treeRainMaskProbeLastTs) < 400) return;
    this._treeRainMaskProbeLastKey = key;
    this._treeRainMaskProbeLastTs = now;
    try { console.log('[MSA][TreeRainMaskProbe]', payload); } catch (_) {}
  }

  /**
   * 1×1 opaque white texture for shader samplers that must stay valid in WebGL1.
   * @returns {THREE.Texture|null}
   * @private
   */
  _getWhiteMaskPlaceholder() {
    const THREE = window.THREE;
    if (!THREE) return null;
    if (!this._whiteMaskPlaceholder) {
      const data = new Uint8Array([255, 255, 255, 255]);
      const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
      tex.needsUpdate = true;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      this._whiteMaskPlaceholder = tex;
    }
    return this._whiteMaskPlaceholder;
  }

  /**
   * Active (viewed) floor _Outdoors texture for receiver classification and roof/fluid region clip.
   * @returns {THREE.Texture|null}
   * @private
   */
  _resolveReceiverOutdoorsMaskTexture() {
    let activeMask = null;
    const sc = window.MapShine?.sceneComposer;
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const activeKey = activeFloor?.compositorKey ?? null;
    const activeIdx = Number(activeFloor?.index);
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const multiFloor = Array.isArray(floors) && floors.length > 1;

    // Strict path: always prefer the ACTIVE floor compositor texture first.
    // This avoids reusing a stale/global outdoors texture from another floor.
    if (activeKey) {
      activeMask = getBandOutdoorsMask(
        activeKey,
        canvas?.scene ?? null,
        sc?._sceneMaskCompositor,
      ) ?? null;
      if (activeMask) return activeMask;
    }

    // Next best: per-floor bind cache for the active key.
    if (activeKey && this._floorStates.has(activeKey)) {
      activeMask = this._floorStates.get(activeKey).outdoorsMask ?? null;
      if (activeMask) return activeMask;
    }

    // Fall back to FloorCompositor-provided active outdoors mask if available.
    // FloorCompositor now avoids stale wrong-floor reuse in multi-floor scenes.
    if (this.outdoorsMask) return this.outdoorsMask;

    // Active floor can legitimately source _Outdoors from the scene bundle
    // before per-floor compositor caches are fully populated.
    const bundleMask = sc?.currentBundle?.masks?.find?.(
      (m) => (m?.id === 'outdoors' || m?.type === 'outdoors')
    )?.texture ?? null;
    if (bundleMask && (!multiFloor || !Number.isFinite(activeIdx) || activeIdx <= 0)) {
      return bundleMask;
    }

    // Last safety: effect mask registry seed if present.
    const registryMask = window.MapShine?.effectMaskRegistry?.getMask?.('outdoors') ?? null;
    if (registryMask && (!multiFloor || !Number.isFinite(activeIdx) || activeIdx <= 0)) {
      return registryMask;
    }

    // If multi-floor and strict sources are unavailable, return null (shader
    // treats as outdoors) rather than guessing from unrelated floors.
    if (multiFloor) return null;

    // Single-floor fallback path.
    return this.outdoorsMask ?? null;
  }

  /**
   * Active floor derived `skyReach` (outdoors ∧ ¬union of upper-floor floorAlpha).
   * @returns {THREE.Texture|null}
   * @private
   */
  _resolveReceiverSkyReachMaskTexture() {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
    if (!compositor?.getFloorTexture) return null;
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const activeKey = activeFloor?.compositorKey != null ? String(activeFloor.compositorKey) : null;
    if (activeKey) {
      const t = compositor.getFloorTexture(activeKey, 'skyReach') ?? null;
      if (t) return t;
    }
    const b = Number(activeFloor?.elevationMin);
    const h = Number(activeFloor?.elevationMax);
    if (Number.isFinite(b) && Number.isFinite(h)) {
      return compositor.getFloorTexture(`${b}:${h}`, 'skyReach') ?? null;
    }
    return null;
  }

  /**
   * _Outdoors textures for floors strictly above the active floor (Outdoor Building caster path).
   * @returns {THREE.Texture[]}
   * @private
   */
  /**
   * `floorAlpha` textures for floors strictly above the active floor (tile coverage in scene UV).
   * @returns {THREE.Texture[]}
   * @private
   */
  _collectUpperFloorFloorAlphaTextures() {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
    if (!compositor?.getFloorTexture) return [];
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const activeIdx = Number(activeFloor?.index);
    if (!Number.isFinite(activeIdx)) return [];
    const out = [];
    for (const f of floors) {
      const idx = Number(f?.index);
      if (!Number.isFinite(idx) || idx <= activeIdx) continue;
      let tex = null;
      const ck = f?.compositorKey != null ? String(f.compositorKey) : '';
      if (ck) tex = compositor.getFloorTexture(ck, 'floorAlpha') ?? null;
      if (!tex) {
        const b = Number(f?.elevationMin);
        const t = Number(f?.elevationMax);
        if (Number.isFinite(b) && Number.isFinite(t)) {
          tex = compositor.getFloorTexture(`${b}:${t}`, 'floorAlpha') ?? null;
        }
      }
      if (tex) out.push(tex);
    }
    return out;
  }

  _collectUpperFloorOutdoorsTextures() {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
    if (!compositor) return [];
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const activeIdx = Number(activeFloor?.index);
    if (!Number.isFinite(activeIdx)) return [];
    const upper = [];
    for (const f of floors) {
      const idx = Number(f?.index);
      if (!Number.isFinite(idx) || idx <= activeIdx) continue;
      let tex = null;
      const ck = f?.compositorKey != null ? String(f.compositorKey) : '';
      if (ck) tex = getBandOutdoorsMask(ck, canvas?.scene ?? null, compositor) ?? null;
      if (!tex) {
        const b = Number(f?.elevationMin);
        const t = Number(f?.elevationMax);
        if (Number.isFinite(b) && Number.isFinite(t)) {
          tex = getBandOutdoorsMask(`${b}:${t}`, canvas?.scene ?? null, compositor) ?? null;
        }
      }
      if (tex && upper.length < 3) upper.push(tex);
    }
    return upper;
  }

  /**
   * Inject TileMotionManager dependency from the V2 compositor.
   * @param {import('../../scene/tile-motion-manager.js').TileMotionManager|null} manager
   */
  setTileMotionManager(manager) {
    this._tileMotionManager = manager || null;
  }

  /**
   * Resolve tile IDs opted into shadow projection.
   * Source is the injected V2 TileMotionManager only.
   * @returns {string[]}
   * @private
   */
  _getTileProjectionIds() {
    const idsFromInjected = this._tileMotionManager?.getShadowProjectionTileIds?.();
    return Array.isArray(idsFromInjected) ? idsFromInjected : [];
  }

  _clearShadowTargetToWhite(renderer) {
    if (!renderer || !this.shadowTarget) return;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * Begin a nested Performance Recorder span for overhead-shadow internals.
   *
   * These spans intentionally use the same effect aggregate table as normal
   * effects, with keys like `overheadShadows.roofVisibility`. When GPU timer
   * queries are already active for the parent overhead render span, the recorder
   * automatically falls back to CPU/draw-call timing for nested spans.
   *
   * @param {string} name
   * @returns {object|null}
   * @private
   */
  _beginPerfSpan(name) {
    try {
      const recorder = this._activePerfRecorder;
      if (!recorder?.enabled || typeof recorder.beginEffectCall !== 'function') return null;
      return recorder.beginEffectCall(`overheadShadows.${name}`, 'render');
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {object|null} token
   * @private
   */
  _endPerfSpan(token) {
    if (!token) return;
    try {
      const recorder = this._activePerfRecorder ?? window.MapShine?.performanceRecorder;
      recorder?.endEffectCall?.(token);
    } catch (_) {}
  }

  /**
   * Temporarily force upper-floor overhead casters visible for roof capture.
   * FloorRenderBus hides floors above the active band for albedo rendering, but
   * overhead shadow captures should still include those casters so lower floors
   * receive their shadow silhouettes.
   *
   * PERFORMANCE: Uses the per-frame caster cache when available, eliminating a
   * full mainScene.traverse() call per render. Falls back to a direct traverse
   * outside the render path.
   *
   * @returns {Array<{object: THREE.Object3D, visible: boolean}>}
   * @private
   */
  _forceUpperOverheadCasterVisibility() {
    const overrides = [];
    const floorStack = window.MapShine?.floorStack;
    const activeFloor = floorStack?.getActiveFloor?.() ?? null;
    const activeIndex = Number.isFinite(Number(activeFloor?.index)) ? Number(activeFloor.index) : 0;
    if (!this.mainScene || !Number.isFinite(activeIndex)) return overrides;

    const ROOF_LAYER_BIT = 1 << 20;
    const fc = this._frameCasters;
    // Reuse the frame caster cache when its frameId matches the current
    // render frame. The list contains every object with a roof layer (incl.
    // WEATHER_ROOF_LAYER), so we filter for the strict ROOF_LAYER bit here.
    if (fc.frameId >= 0 && fc.scene === this.mainScene) {
      const list = fc.list;
      for (let i = 0, n = list.length; i < n; i++) {
        const entry = list[i];
        const object = entry.object;
        if (!object?.layers || typeof object.visible !== 'boolean') continue;
        if ((object.layers.mask & ROOF_LAYER_BIT) === 0) continue;
        if (entry.isBusTile) continue;
        if (!Number.isFinite(entry.floorIndex) || entry.floorIndex <= activeIndex) continue;
        if (!object.visible) {
          overrides.push({ object, visible: object.visible });
          object.visible = true;
        }
      }
      return overrides;
    }

    // Fallback path (cache miss): direct traverse.
    this.mainScene.traverse((object) => {
      if (!object?.layers || typeof object.visible !== 'boolean') return;
      const isOverheadLayer = (object.layers.mask & ROOF_LAYER_BIT) !== 0;
      if (!isOverheadLayer) return;

      // Skip FloorRenderBus tiles — they are handled by beginOverheadShadowCaptureReveal
      // in FloorRenderBus which properly manages their visibility lifecycle.
      if (object?.userData?.mapShineBusTile) return;

      const floorIndexRaw = object?.userData?.floorIndex;
      const floorIndex = Number(floorIndexRaw);
      if (!Number.isFinite(floorIndex) || floorIndex <= activeIndex) return;

      if (!object.visible) {
        overrides.push({ object, visible: object.visible });
        object.visible = true;
      }
    });

    return overrides;
  }

  /**
   * Temporarily reveal above-active overhead casters for the roof caster pass.
   * Unlike _forceUpperOverheadCasterVisibility(), this is intentionally scoped to
   * the roof shadow caster capture only and must NOT be used for roof visibility/
   * blocker captures (those drive independent lighting occlusion paths).
   *
   * @returns {Array<{object: THREE.Object3D, visible: boolean}>}
   * @private
   */
  _forceUpperOverheadCasterVisibilityForRoofPass() {
    return this._forceUpperOverheadCasterVisibility();
  }

  /**
   * Temporarily expand camera view for roof capture, then return a restore callback.
   * @param {number} scale
   * @returns {() => void}
   * @private
   */
  _applyRoofCaptureGuardScale(scale) {
    const THREE = window.THREE;
    const cam = this.mainCamera;
    if (!THREE || !cam || !Number.isFinite(scale) || scale <= 1.0001) {
      return () => {};
    }

    if (cam.isPerspectiveCamera) {
      const oldFov = cam.fov;
      const oldZoom = cam.zoom;
      const oldAspect = cam.aspect;
      const fovRad = THREE.MathUtils.degToRad(Math.max(1.0, oldFov));
      const expandedFov = 2.0 * Math.atan(Math.tan(fovRad * 0.5) * scale);
      cam.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(expandedFov), 1.0, 170.0);
      cam.updateProjectionMatrix();
      return () => {
        cam.fov = oldFov;
        cam.zoom = oldZoom;
        cam.aspect = oldAspect;
        cam.updateProjectionMatrix();
      };
    }

    if (cam.isOrthographicCamera) {
      const oldZoom = cam.zoom;
      cam.zoom = Math.max(0.0001, oldZoom / scale);
      cam.updateProjectionMatrix();
      return () => {
        cam.zoom = oldZoom;
        cam.updateProjectionMatrix();
      };
    }

    return () => {};
  }

  /**
   * Sync screen→scene UV uniforms for _Outdoors mask sampling in the stamp composite.
   * @param {import('three').Camera|null} camera
   * @private
   */
  _syncStampSceneUniforms(camera) {
    const u = this.material?.uniforms;
    if (!u || !camera) return;
    const THREE = window.THREE;
    const dims = globalThis.canvas?.dimensions;
    if (!THREE || !dims) {
      if (u.uHasStampViewMapping) u.uHasStampViewMapping.value = 0.0;
      return;
    }
    const rect = dims.sceneRect ?? dims;
    const sx = Number(rect?.x ?? dims.sceneX ?? 0);
    const sy = Number(rect?.y ?? dims.sceneY ?? 0);
    const sw = Number(rect?.width ?? dims.sceneWidth ?? dims.width ?? 1);
    const sh = Number(rect?.height ?? dims.sceneHeight ?? dims.height ?? 1);
    if (u.uStampSceneOrigin) u.uStampSceneOrigin.value.set(sx, sy);
    if (u.uStampSceneSize) u.uStampSceneSize.value.set(sw, sh);
    if (u.uSceneDimensions) u.uSceneDimensions.value.set(Number(dims.width ?? 1), Number(dims.height ?? 1));

    const sc = window.MapShine?.sceneComposer;
    const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);
    const q = camera.quaternion;
    const cache = this._stampViewCache;
    const isOrtho = camera.isOrthographicCamera === true;
    const cameraChanged = !cache.isValid
      || cache.isOrtho !== isOrtho
      || cache.px !== camera.position.x || cache.py !== camera.position.y || cache.pz !== camera.position.z
      || cache.qx !== (q?.x ?? 0) || cache.qy !== (q?.y ?? 0) || cache.qz !== (q?.z ?? 0) || cache.qw !== (q?.w ?? 1)
      || cache.zoom !== camera.zoom
      || cache.groundZ !== groundZ;

    if (cameraChanged) {
      let c00x = 0; let c00y = 0; let c10x = 1; let c10y = 0; let c01x = 0; let c01y = 1; let c11x = 1; let c11y = 1;
      if (isOrtho) {
        const zoom = Math.max(0.001, camera.zoom ?? 1.0);
        const vMinX = camera.position.x + camera.left / zoom;
        const vMinY = camera.position.y + camera.bottom / zoom;
        const vMaxX = camera.position.x + camera.right / zoom;
        const vMaxY = camera.position.y + camera.top / zoom;
        c00x = vMinX; c00y = vMinY;
        c10x = vMaxX; c10y = vMinY;
        c01x = vMinX; c01y = vMaxY;
        c11x = vMaxX; c11y = vMaxY;
      } else {
        const ndc = new THREE.Vector3();
        const world = new THREE.Vector3();
        const dir = new THREE.Vector3();
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        const cX = [-1, 1, -1, 1];
        const cY = [-1, -1, 1, 1];
        for (let i = 0; i < 4; i++) {
          ndc.set(cX[i], cY[i], 0.5);
          world.copy(ndc).unproject(camera);
          dir.copy(world).sub(camera.position);
          const dz = dir.z;
          if (dz > -1e-6 && dz < 1e-6) continue;
          const t = (groundZ - camera.position.z) / dz;
          if (!Number.isFinite(t) || t <= 0) continue;
          const ix = camera.position.x + dir.x * t;
          const iy = camera.position.y + dir.y * t;
          if (ix < minX) minX = ix;
          if (iy < minY) minY = iy;
          if (ix > maxX) maxX = ix;
          if (iy > maxY) maxY = iy;
          if (i === 0) { c00x = ix; c00y = iy; }
          else if (i === 1) { c10x = ix; c10y = iy; }
          else if (i === 2) { c01x = ix; c01y = iy; }
          else if (i === 3) { c11x = ix; c11y = iy; }
        }
        if (minX !== Infinity) {
          c00x = minX; c00y = minY;
          c10x = maxX; c10y = minY;
          c01x = minX; c01y = maxY;
          c11x = maxX; c11y = maxY;
        }
      }
      cache.isValid = true;
      cache.isOrtho = isOrtho;
      cache.px = camera.position.x; cache.py = camera.position.y; cache.pz = camera.position.z;
      cache.qx = q?.x ?? 0; cache.qy = q?.y ?? 0; cache.qz = q?.z ?? 0; cache.qw = q?.w ?? 1;
      cache.zoom = camera.zoom ?? 1;
      cache.groundZ = groundZ;
      cache.c00x = c00x; cache.c00y = c00y;
      cache.c10x = c10x; cache.c10y = c10y;
      cache.c01x = c01x; cache.c01y = c01y;
      cache.c11x = c11x; cache.c11y = c11y;
    }

    if (u.uStampViewCorner00) u.uStampViewCorner00.value.set(cache.c00x, cache.c00y);
    if (u.uStampViewCorner10) u.uStampViewCorner10.value.set(cache.c10x, cache.c10y);
    if (u.uStampViewCorner01) u.uStampViewCorner01.value.set(cache.c01x, cache.c01y);
    if (u.uStampViewCorner11) u.uStampViewCorner11.value.set(cache.c11x, cache.c11y);
    if (u.uHasStampViewMapping) u.uHasStampViewMapping.value = cache.isValid ? 1.0 : 0.0;
  }

  /**
   * Set base mesh for V2 integration
   * @param {THREE.Mesh} baseMesh
   */
  setBaseMesh(baseMesh) {
    this.baseMesh = baseMesh;
    // Outdoors mask is set by FloorCompositor via setOutdoorsMask()
    // If we've already been initialized, build the shadow mesh now.
    // Without this, render() will early-out with material=null and targets
    // will remain uninitialized.
    try {
      if (this.renderer && this.shadowScene && this.baseMesh) {
        this._createShadowMesh();
      }
    } catch (_) {}
  }

  /**
   * Set outdoors mask texture (called by FloorCompositor)
   * @param {THREE.Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this.outdoorsMask = texture;
  }

  /**
   * Get shadow factor texture for LightingEffectV2 integration
   * @returns {THREE.Texture|null}
   */
  get shadowFactorTexture() {
    if (!resolveEffectEnabled(this)) return null;
    return this.shadowTarget?.texture || null;
  }

  /**
   * Raw overhead roof alpha texture (screen-space).
   * Used by LightingEffectV2 to suppress other ambient shadow layers on pixels
   * currently covered by visible overhead tiles.
   * @returns {THREE.Texture|null}
   */
  get roofAlphaTexture() {
    if (!resolveEffectEnabled(this)) return null;
    return this.roofVisibilityTarget?.texture || null;
  }

  /**
   * Hard roof blocker texture (screen-space).
   * Captured from a forced-opaque overhead roof pass without guard-band
   * camera scaling so LightingEffectV2 can sample it directly in screen UV.
   * @returns {THREE.Texture|null}
   */
  get roofBlockTexture() {
    if (!resolveEffectEnabled(this)) return null;
    return this.roofBlockTarget?.texture || null;
  }

  /**
   * Restrict-light overhead mask for LightingEffectV2 (screen-space, alpha channel).
   * @returns {THREE.Texture|null}
   */
  get roofRestrictLightTexture() {
    if (!resolveEffectEnabled(this)) return null;
    return this.roofRestrictLightTarget?.texture || null;
  }

  /**
   * Runtime weather occlusion visibility texture (screen-space alpha).
   * Includes overhead/trees with live fade for precipitation masking.
   * @returns {THREE.Texture|null}
   */
  get rainOcclusionVisibilityTexture() {
    if (!resolveEffectEnabled(this)) return null;
    return this.rainOcclusionVisibilityTarget?.texture || null;
  }

  /**
   * Runtime weather occlusion blocker texture (screen-space alpha).
   * Includes overhead/trees forced fully visible for precipitation masking.
   * @returns {THREE.Texture|null}
   */
  get rainOcclusionBlockTexture() {
    if (!resolveEffectEnabled(this)) return null;
    return this.rainOcclusionBlockTarget?.texture || null;
  }

  /** @returns {boolean} */
  get lastRoofMaskCaptureReused() {
    return this._lastRoofMaskCaptureReused;
  }

  /**
   * Embedded "Outdoor Building Shadow", "Sky-Reach Shelter", and "Upper Floor Tile Shadow"
   * branches are removed — those contributions come from ShadowManagerV2 + directional producers.
   * @param {object} THREE
   * @private
   */
  _applyUnifiedShadowStampShaderFlags(THREE) {
    void THREE;
    // Embedded building/sky-reach/upper-floor shadow branches removed from the
    // composite shader to stay within MAX_TEXTURE_IMAGE_UNITS (16).
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'outdoors' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
  }

  /**
   * Phase 4+: per-floor mask swap called by the EffectComposer floor loop.
   * Swaps the outdoors mask for the current floor; render() reads it per-frame
   * and pushes it to uOutdoorsMask / uHasOutdoorsMask.
   *
   * @param {{masks: Array}|null} bundle - Floor mask bundle from the GPU compositor.
   * @param {string} floorKey - Compositor key for this floor (e.g. "0:200").
   */
  bindFloorMasks(bundle, floorKey) {
    const outdoorsEntry = bundle?.masks?.find?.(m => m.id === 'outdoors' || m.type === 'outdoors');
    const floorMask = outdoorsEntry?.texture ?? null;

    // Early-init / compositor timing:
    // The per-floor pipeline can invoke bindFloorMasks() before the compositor has
    // populated the floor bundle for this key. In that case, floorMask is null,
    // but we may already have a valid global/registry outdoors mask (from setBaseMesh
    // or EffectMaskRegistry seeding). Do NOT clobber outdoorsMask to null.
    let registryMask = null;
    try {
      registryMask = window.MapShine?.effectMaskRegistry?.getMask?.('outdoors') ?? null;
    } catch (_) {
      registryMask = null;
    }
    const effectiveMask = floorMask ?? this.outdoorsMask ?? registryMask;

    // Always cache this floor's mask for the render path to look up.
    // Reuse existing entry objects to reduce churn in long sessions.
    const fk = String(floorKey ?? '');
    if (fk) {
      const existing = this._floorStates.get(fk);
      if (existing) existing.outdoorsMask = effectiveMask;
      else this._floorStates.set(fk, { outdoorsMask: effectiveMask });
    }

    // Only set this.outdoorsMask for the ACTIVE floor being viewed.
    // The bindFloorMasks loop iterates through ALL floors, so if we set it for every
    // floor, the last floor's mask "wins" and ground floor rendering would use the
    // top floor's mask (incorrectly masking building shadows).
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const activeKey = activeFloor?.compositorKey ?? null;
    const isActiveFloor = activeKey && String(floorKey) === String(activeKey);

    if (isActiveFloor) {
      this.outdoorsMask = effectiveMask;
    }
  }

  /**
   * UI control schema for Tweakpane
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'main',
          label: 'Overhead Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'softness', 'affectsLights', 'fluidColorEnabled', 'fluidEffectTransparency', 'fluidShadowIntensityBoost', 'fluidShadowSoftness', 'fluidColorBoost', 'fluidColorSaturation']
        },
        {
          name: 'tileProjection',
          label: 'Tile Shadow Projection',
          type: 'inline',
          advanced: true,
          parameters: ['tileProjectionEnabled', 'tileProjectionOpacity', 'tileProjectionLengthScale', 'tileProjectionSoftness', 'tileProjectionThreshold', 'tileProjectionPower', 'tileProjectionOutdoorOpacityScale', 'tileProjectionIndoorOpacityScale']
        },
        {
          name: 'receiverTuning',
          label: 'Receiver Regions',
          type: 'inline',
          advanced: true,
          parameters: ['outdoorShadowLengthScale', 'indoorReceiverShadowLengthScale']
        },
        {
          name: 'debug',
          label: 'Debug',
          type: 'inline',
          advanced: true,
          parameters: ['debugView']
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Shadow Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        length: {
          type: 'slider',
          label: 'Shadow Length',
          min: 0.0,
          max: 0.3,
          step: 0.005,
          default: 0.1
        },
        softness: {
          type: 'slider',
          label: 'Softness',
          min: 0.5,
          max: 5.0,
          step: 0.1,
          default: 5
        },
        outdoorShadowLengthScale: {
          type: 'slider',
          label: 'Outdoor Shadow Length Scale',
          min: 0.0,
          max: 30.0,
          step: 1.00,
          default: 1.0,
          tooltip: 'Scales projected overhead shadow distance on outdoor receivers (0 disables outdoor projection)'
        },
        indoorReceiverShadowLengthScale: {
          type: 'slider',
          label: 'Indoor Shadow Length Scale',
          min: 0.0,
          max: 30.0,
          step: 0.01,
          default: 0.25,
          tooltip: 'Scales projected overhead shadow distance on indoor receivers'
        },
        affectsLights: {
          type: 'slider',
          label: 'Affects Dynamic Lights',
          min: 0.0,
          max: 1.0,
          step: 0.05,
          default: 0.75,
          tooltip: 'Scales how strongly overhead roof shadows lift dynamic-light shadow regions (0 = no lift, 1 = full lift)'
        },
        fluidColorEnabled: {
          type: 'checkbox',
          label: 'Use Fluid Effect Colour',
          default: true,
          advanced: true,
          tooltip: 'Tints overhead shadows with FluidEffect colour when fluid overlays are attached to overhead tiles'
        },
        fluidEffectTransparency: {
          type: 'slider',
          label: 'Fluid Effect Transparency',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.35,
          advanced: true,
          tooltip: 'Opacity of FluidEffect colour tint in overhead shadows'
        },
        fluidShadowIntensityBoost: {
          type: 'slider',
          label: 'Fluid Shadow Intensity Boost',
          min: 0.0,
          max: 5.0,
          step: 0.01,
          default: 1.0,
          advanced: true,
          tooltip: 'Boost multiplier for FluidEffect shadow contribution (up to 500%)'
        },
        fluidShadowSoftness: {
          type: 'slider',
          label: 'Fluid Shadow Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 3.0,
          advanced: true,
          tooltip: 'Blur radius for FluidEffect tint on outdoor receivers (up to 2x regular shadow softness range)'
        },
        fluidColorBoost: {
          type: 'slider',
          label: 'Fluid Colour Boost',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.5,
          advanced: true,
          tooltip: 'Boosts fluid colour intensity used to tint overhead shadows'
        },
        fluidColorSaturation: {
          type: 'slider',
          label: 'Fluid Colour Saturation',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.2,
          advanced: true,
          tooltip: 'Saturation multiplier for fluid shadow tint colour'
        },
        tileProjectionEnabled: {
          type: 'checkbox',
          label: 'Enable Tile Shadow Projection',
          default: true,
          tooltip: 'Adds tile alpha from Tile Motion (per-tile Shadow Projection) as an extra projected shadow source'
        },
        tileProjectionOpacity: {
          type: 'slider',
          label: 'Tile Projection Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5,
          tooltip: 'Overall strength of tile-projected shadows'
        },
        tileProjectionLengthScale: {
          type: 'slider',
          label: 'Tile Projection Length Scale',
          min: 0.0,
          max: 30.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Projection distance for tile shadows (independent of Outdoor/Indoor receiver length scales)'
        },
        tileProjectionSoftness: {
          type: 'slider',
          label: 'Tile Projection Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 3.0,
          tooltip: 'Blur radius for tile-projected shadows'
        },
        tileProjectionThreshold: {
          type: 'slider',
          label: 'Tile Alpha Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.05,
          tooltip: 'Ignores very low tile alpha values before projection'
        },
        tileProjectionPower: {
          type: 'slider',
          label: 'Tile Alpha Contrast',
          min: 0.1,
          max: 4.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Shapes tile alpha falloff before converting to shadow strength'
        },
        tileProjectionOutdoorOpacityScale: {
          type: 'slider',
          label: 'Tile Outdoor Strength Scale',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.75,
          tooltip: 'Additional multiplier applied to tile-projected shadow strength on outdoor receivers'
        },
        tileProjectionIndoorOpacityScale: {
          type: 'slider',
          label: 'Tile Indoor Strength Scale',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Additional multiplier applied to tile-projected shadow strength on indoor receivers'
        },
        debugView: {
          type: 'list',
          label: 'Debug View',
          options: {
            Final: 'final',
            ReceiverOutdoors: 'receiverOutdoors',
            RoofCoverage: 'roofCoverage',
            RoofVisibility: 'roofVisibility',
            RoofBase: 'roofBase',
            RoofCombinedStrength: 'roofCombined',
            TileProjectionStrength: 'tileCombined'
          },
          default: 'final'
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    this.renderer = renderer;
    this.mainScene = scene;
    this.mainCamera = camera;

    // Create a dedicated scene to render the world-pinned shadow mesh. The
    // roof mask itself is still rendered into roofTarget using the main
    // scene and ROOF_LAYER; this scene only contains the groundplane
    // shadow mesh that samples that mask.
    this.shadowScene = new THREE.Scene();

    // Pre-allocate targets so lighting never samples an undefined/black texture.
    try {
      const size = new THREE.Vector2();
      renderer.getDrawingBufferSize(size);
      if (size.x > 0 && size.y > 0) {
        this.onResize(size.x, size.y);
      }
    } catch (_) {}

    if (this.baseMesh) {
      this._createShadowMesh();
    }

    log.info('OverheadShadowsEffect initialized');
  }

  _createShadowMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh) return;

    const whiteOb = this._getWhiteMaskPlaceholder();

    // Dispose previous mesh/material if rebuilding
    if (this.shadowMesh && this.shadowScene) {
      this.shadowScene.remove(this.shadowMesh);
      this.shadowMesh.geometry.dispose();
      this.shadowMesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }

    this.material = createOverheadStampCompositeMaterial(THREE, this.params);
    if (this.material?.uniforms?.uOpacity) {
      this.material.uniforms.uOpacity.value = this.params.opacity;
    }

    this.shadowMesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.shadowMesh.position.copy(this.baseMesh.position);
    this.shadowMesh.rotation.copy(this.baseMesh.rotation);
    this.shadowMesh.scale.copy(this.baseMesh.scale);
    this.shadowMesh.layers.set(0);
    this.shadowScene.add(this.shadowMesh);
  }


  onResize(width, height) {
    const THREE = window.THREE;
    if (!width || !height || !THREE) return;

    this._invalidateRoofMaskCaptureCache();

    if (!this.roofTarget) {
      this.roofTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.roofTarget.setSize(width, height);
    }

    if (!this.roofBlockTarget) {
      this.roofBlockTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.roofBlockTarget.setSize(width, height);
    }

    if (!this.roofVisibilityTarget) {
      this.roofVisibilityTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.roofVisibilityTarget.setSize(width, height);
    }

    if (!this.roofRestrictLightTarget) {
      this.roofRestrictLightTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.roofRestrictLightTarget.setSize(width, height);
    }

    if (!this.rainOcclusionVisibilityTarget) {
      this.rainOcclusionVisibilityTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.rainOcclusionVisibilityTarget.setSize(width, height);
    }

    if (!this.rainOcclusionBlockTarget) {
      this.rainOcclusionBlockTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.rainOcclusionBlockTarget.setSize(width, height);
    }

    if (this.material && this.material.uniforms && this.material.uniforms.uTexelSize) {
      this.material.uniforms.uTexelSize.value.set(1 / width, 1 / height);
    }
    if (this.material && this.material.uniforms && this.material.uniforms.uResolution) {
      this.material.uniforms.uResolution.value.set(width, height);
    }

    if (!this.shadowTarget) {
      this.shadowTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.shadowTarget.setSize(width, height);
    }

    // IMPORTANT: Default to fully lit until we've rendered a valid shadow pass.
    // LightingEffectV2 multiplies by this texture.
    try {
      if (this.renderer && this.shadowTarget) {
        const prevTarget = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this.shadowTarget);
        this.renderer.setClearColor(0xffffff, 1);
        this.renderer.clear();
        this.renderer.setRenderTarget(prevTarget);
      }
    } catch (_) {}

    if (!this.fluidRoofTarget) {
      this.fluidRoofTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.fluidRoofTarget.setSize(width, height);
    }

    if (!this.tileProjectionTarget) {
      this.tileProjectionTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.tileProjectionTarget.setSize(width, height);
    }

    if (!this.tileProjectionSortTarget) {
      this.tileProjectionSortTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.tileProjectionSortTarget.setSize(width, height);
    }

    if (!this.tileReceiverAlphaTarget) {
      this.tileReceiverAlphaTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.tileReceiverAlphaTarget.setSize(width, height);
    }

    if (!this.tileReceiverSortTarget) {
      this.tileReceiverSortTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.tileReceiverSortTarget.setSize(width, height);
    }

    const blurOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    for (const key of ['roofBlurredTarget', 'tileProjectionBlurredTarget', 'fluidRoofBlurredTarget']) {
      if (!this[key]) this[key] = new THREE.WebGLRenderTarget(width, height, blurOpts);
      else this[key].setSize(width, height);
    }
    this._maskBlur.ensureTargets(width, height);
    this._maskCapturePass.ensureTargets(width, height);
  }

  /**
   * EffectComposer will call this before render() when used as a
   * post-processing effect.
   * @param {THREE.Texture} texture
   */
  setInputTexture(texture) {
    // No-op for this effect; it does not directly composite the scene,
    // it only generates a shadow texture consumed by LightingEffect.
    this.inputTexture = texture;
  }

  /**
   * Get effective zoom level from camera.
   * Works with FOV-based zoom (reads sceneComposer.currentZoom),
   * OrthographicCamera (uses camera.zoom), or legacy PerspectiveCamera.
   * @returns {number} Zoom level (1.0 = default)
   * @private
   */
  _getEffectiveZoom() {
    const sceneComposer = window.MapShine?.sceneComposer;

    if (!this.mainCamera) return 1.0;

    // Perspective camera: derive zoom from the camera's *current* FOV against
    // the compositor base FOV. This keeps projection math aligned to the exact
    // camera projection used for this frame (prevents zoom-step mismatch drift).
    if (this.mainCamera.isPerspectiveCamera) {
      try {
        const camFovDeg = Number(this.mainCamera.fov);
        const camFovRad = camFovDeg * (Math.PI / 180);
        const camTanHalf = Math.tan(camFovRad * 0.5);
        const baseTanHalf = Number(sceneComposer?.baseFovTanHalf);
        if (Number.isFinite(baseTanHalf) && baseTanHalf > 1e-6 && Number.isFinite(camTanHalf) && camTanHalf > 1e-6) {
          return baseTanHalf / camTanHalf;
        }
      } catch (_) {}
    }

    // Fallback: compositor-provided zoom scalar.
    if (sceneComposer?.currentZoom !== undefined) {
      return sceneComposer.currentZoom;
    }
    
    // OrthographicCamera: zoom is a direct property
    if (this.mainCamera.isOrthographicCamera) {
      return this.mainCamera.zoom;
    }
    
    // PerspectiveCamera legacy fallback: calculate from Z position
    const baseDist = 10000.0;
    const dist = this.mainCamera.position.z;
    return (dist > 0.1) ? (baseDist / dist) : 1.0;
  }

  /**
   * Resolve a comparable Foundry tile sort key from a tile sprite.
   * @param {THREE.Object3D} object
   * @returns {number}
   * @private
   */
  _getTileSortKey(object) {
    const raw = Number(
      object?.userData?._msSortKey
      ?? object?.userData?.tileDoc?.sort
      ?? object?.userData?.tileDoc?.z
      ?? 0
    );
    return Number.isFinite(raw) ? raw : 0;
  }

  /**
   * Resolve Foundry tile id from bus mesh/material hierarchy.
   * @param {THREE.Object3D|null|undefined} object
   * @returns {string|null}
   * @private
   */
  _resolveFoundryTileId(object) {
    if (!object) return null;
    const direct = object.userData?.foundryTileId;
    if (direct) return String(direct);
    const matId = object.material?.userData?.foundryTileId;
    if (matId) return String(matId);
    let parent = object.parent;
    for (let depth = 0; parent && depth < 4; depth += 1) {
      const pid = parent.userData?.foundryTileId;
      if (pid) return String(pid);
      parent = parent.parent;
    }
    return null;
  }

  /**
   * Normalize a sort key into [0,1] for alpha-encoded sort passes.
   * @param {number} sortKey
   * @param {number} sortMin
   * @param {number} sortRange
   * @returns {number}
   * @private
   */
  _encodeTileSort(sortKey, sortMin, sortRange) {
    const key = Number.isFinite(sortKey) ? sortKey : 0;
    const min = Number.isFinite(sortMin) ? sortMin : 0;
    const range = Number.isFinite(sortRange) && sortRange > 0.00001 ? sortRange : 1.0;
    return Math.max(0.0, Math.min(1.0, (key - min) / range));
  }

  /**
   * Resolve Outdoor Building Shadow controls with legacy-key compatibility.
   * Older scenes may only persist indoorShadowOpacity/indoorShadowLengthScale.
   * @returns {{ opacity: number, lengthScale: number }}
   * @private
   */
  _resolveOutdoorBuildingShadowParams() {
    const defaultOpacity = 0.5;
    const defaultLengthScale = 1.0;

    const modernOpacityRaw = Number(this.params.outdoorBuildingShadowOpacity);
    const legacyOpacityRaw = Number(this.params.indoorShadowOpacity);
    const modernLengthRaw = Number(this.params.outdoorBuildingShadowLengthScale);
    const legacyLengthRaw = Number(this.params.indoorShadowLengthScale);

    const hasModernOpacity = Number.isFinite(modernOpacityRaw);
    const hasLegacyOpacity = Number.isFinite(legacyOpacityRaw);
    const hasModernLength = Number.isFinite(modernLengthRaw);
    const hasLegacyLength = Number.isFinite(legacyLengthRaw);

    // If both exist but modern is still default while legacy was authored,
    // prefer legacy so old saved scenes keep their tuned look.
    const opacityPreferLegacy = hasLegacyOpacity
      && hasModernOpacity
      && Math.abs(modernOpacityRaw - defaultOpacity) < 0.00001
      && Math.abs(legacyOpacityRaw - defaultOpacity) >= 0.00001;
    const lengthPreferLegacy = hasLegacyLength
      && hasModernLength
      && Math.abs(modernLengthRaw - defaultLengthScale) < 0.00001
      && Math.abs(legacyLengthRaw - defaultLengthScale) >= 0.00001;

    const resolvedOpacity = opacityPreferLegacy
      ? legacyOpacityRaw
      : (hasModernOpacity ? modernOpacityRaw : (hasLegacyOpacity ? legacyOpacityRaw : defaultOpacity));
    const resolvedLengthScale = lengthPreferLegacy
      ? legacyLengthRaw
      : (hasModernLength ? modernLengthRaw : (hasLegacyLength ? legacyLengthRaw : defaultLengthScale));

    return {
      opacity: Math.max(0.0, Math.min(1.0, resolvedOpacity)),
      lengthScale: Math.max(0.0, resolvedLengthScale),
    };
  }

  /**
   * Update sun direction from current time of day.
   *
   * We use WeatherController.timeOfDay (0-24h) which is driven by the
   * "Time of Day" UI slider. This gives us a stable, user-controlled
   * east/west shadow offset on a full daily orbit.
   */
  update(timeInfo) {
    if (!this.material || !resolveEffectEnabled(this)) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // Read time of day from WeatherController (0-24 hours). Default to
    // noon (12.0) if unavailable.
    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (e) {
      // Fallback: keep default hour
    }

    let hoverRevealActive = false;
    try {
      hoverRevealActive = !!weatherController?.roofMaskActive;
    } catch (_) {
      hoverRevealActive = false;
    }

    // Optimization: Skip update if params haven't changed
    const camZoom = this._getEffectiveZoom();
    // Floor changes must invalidate this cache even when scalar params/camera are
    // unchanged, otherwise wall/roof occlusion uniforms can remain one floor behind
    // until a pan/zoom modifies camZoom and forces an update.
    let floorContextSig = 'nofloor';
    try {
      const fs = window.MapShine?.floorStack ?? null;
      const active = fs?.getActiveFloor?.() ?? null;
      const activeKey = active?.compositorKey != null
        ? String(active.compositorKey)
        : `${Number(active?.elevationMin)}:${Number(active?.elevationMax)}`;
      const activeIdx = Number.isFinite(Number(active?.index)) ? Number(active.index) : -1;
      const floors = fs?.getFloors?.() ?? [];
      const upperSig = Array.isArray(floors)
        ? floors
          .filter((f) => Number.isFinite(Number(f?.index)) && Number(f.index) > activeIdx)
          .map((f) => (f?.compositorKey != null ? String(f.compositorKey) : `${Number(f?.elevationMin)}:${Number(f?.elevationMax)}`))
          .join('|')
        : '';
      floorContextSig = `${activeIdx}:${activeKey}:${upperSig}`;
    } catch (_) {}
    const updateHash = `${hour.toFixed(3)}_${this.params.sunLatitude}_${this.params.opacity}_${this.params.length}_${this.params.softness}_${this.params.affectsLights}_${this.params.outdoorShadowLengthScale}_${this.params.indoorReceiverShadowLengthScale}_${camZoom.toFixed(4)}_${this.params.tileProjectionEnabled}_${this.params.tileProjectionOpacity}_${this.params.tileProjectionLengthScale}_${this.params.tileProjectionSoftness}_${this.params.tileProjectionThreshold}_${this.params.tileProjectionPower}_${this.params.tileProjectionOutdoorOpacityScale}_${this.params.tileProjectionIndoorOpacityScale}_${this.params.tileProjectionSortBias}_${this.params.fluidColorEnabled}_${this.params.fluidEffectTransparency}_${this.params.fluidShadowIntensityBoost}_${this.params.fluidShadowSoftness}_${this.params.fluidColorBoost}_${this.params.fluidColorSaturation}_${this.params.debugView}_${hoverRevealActive ? 1 : 0}_${floorContextSig}`;

    const receiverMask = this._resolveReceiverOutdoorsMaskTexture();

    // Floor/mask transitions can swap outdoorsMask without changing scalar params.
    // Do not early-return on unchanged updateHash: Tweakpane writes directly to
    // effect.params; skipping update() made strength sliders appear to do nothing.
    this._lastUpdateHash = updateHash;

    const sun2d = resolveEffectShadowSun2D({
      azimuthDeg: this._sunAzimuthDeg,
      elevationDeg: this._sunElevationDeg,
      latitudeScale: this.params.sunLatitude ?? 0.1,
      previousDir: this.sunDir,
    });
    this._sunDirLengthSq = sun2d.lengthSq;
    if (!this.sunDir) {
      this.sunDir = new THREE.Vector2(sun2d.x, sun2d.y);
    } else {
      applyShadowSunDirection(this.sunDir, sun2d);
    }
    if (this.material?.uniforms?.uSunDir) {
      this.material.uniforms.uSunDir.value.copy(this.sunDir);
    }
    if (this.material?.uniforms?.uSunDirLength) {
      this.material.uniforms.uSunDirLength.value = Math.sqrt(Math.max(sun2d.lengthSq, 0));
    }
    if (this.material?.uniforms?.uShadowLengthScale) {
      this.material.uniforms.uShadowLengthScale.value = Math.max(0, Number(this._driverShadowLengthScale) || 1);
    }

    // Drive basic uniforms from params and camera zoom.
    if (this.material) {
      const u = this.material.uniforms;
      if (u.uOpacity) u.uOpacity.value = this.params.opacity;
      if (u.uLength) u.uLength.value = this.params.length;
      if (u.uHoverRevealActive) u.uHoverRevealActive.value = hoverRevealActive ? 1.0 : 0.0;
      if (u.uOutdoorShadowLengthScale) u.uOutdoorShadowLengthScale.value = this.params.outdoorShadowLengthScale ?? 1.0;
      if (u.uIndoorReceiverShadowLengthScale) {
        u.uIndoorReceiverShadowLengthScale.value = this.params.indoorReceiverShadowLengthScale ?? 1.0;
      }
      if (u.uZoom && this.mainCamera) {
        u.uZoom.value = camZoom;
      }
      const projectionIds = this._getTileProjectionIds();
      const hasTileProjection = Array.isArray(projectionIds) && projectionIds.length > 0;
      if (u.uTileProjectionEnabled) {
        u.uTileProjectionEnabled.value = (this.params.tileProjectionEnabled && hasTileProjection) ? 1.0 : 0.0;
      }
      if (u.uTileProjectionOpacity) u.uTileProjectionOpacity.value = this.params.tileProjectionOpacity;
      if (u.uTileProjectionLengthScale) u.uTileProjectionLengthScale.value = this.params.tileProjectionLengthScale;
      if (u.uTileProjectionThreshold) u.uTileProjectionThreshold.value = this.params.tileProjectionThreshold;
      if (u.uTileProjectionPower) u.uTileProjectionPower.value = this.params.tileProjectionPower;
      if (u.uTileProjectionOutdoorOpacityScale) {
        u.uTileProjectionOutdoorOpacityScale.value = this.params.tileProjectionOutdoorOpacityScale;
      }
      if (u.uTileProjectionIndoorOpacityScale) {
        u.uTileProjectionIndoorOpacityScale.value = this.params.tileProjectionIndoorOpacityScale;
      }
      if (u.uTileProjectionSortBias) u.uTileProjectionSortBias.value = this.params.tileProjectionSortBias;
      if (u.uFluidColorEnabled) u.uFluidColorEnabled.value = this.params.fluidColorEnabled ? 1.0 : 0.0;
      if (u.uFluidEffectTransparency) u.uFluidEffectTransparency.value = this.params.fluidEffectTransparency;
      if (u.uFluidShadowIntensityBoost) u.uFluidShadowIntensityBoost.value = this.params.fluidShadowIntensityBoost;
      if (u.uFluidColorBoost) u.uFluidColorBoost.value = this.params.fluidColorBoost;
      if (u.uFluidColorSaturation) u.uFluidColorSaturation.value = this.params.fluidColorSaturation;
      if (u.uIndoorFluidShadowIntensityBoost) {
        u.uIndoorFluidShadowIntensityBoost.value = this.params.indoorFluidShadowIntensityBoost;
      }
      if (u.uIndoorFluidColorSaturation) {
        u.uIndoorFluidColorSaturation.value = this.params.indoorFluidColorSaturation;
      }
      if (u.tDynamicLight) u.tDynamicLight.value = this._dynamicLightTexture ?? null;
      if (u.tWindowLight) u.tWindowLight.value = this._windowLightTexture ?? null;
      if (u.uHasDynamicLight) u.uHasDynamicLight.value = this._dynamicLightTexture ? 1.0 : 0.0;
      if (u.uHasWindowLight) u.uHasWindowLight.value = this._windowLightTexture ? 1.0 : 0.0;
      if (u.uDynamicLightShadowOverrideEnabled) {
        const affects = Math.max(0.0, Math.min(1.0, Number(this.params.affectsLights ?? 0.75)));
        const overrideAllowed = this.params.dynamicLightShadowOverrideEnabled !== false && affects > 0.001;
        u.uDynamicLightShadowOverrideEnabled.value = overrideAllowed ? 1.0 : 0.0;
      }
      if (u.uDynamicLightShadowOverrideStrength) {
        const baseStrength = Number.isFinite(Number(this._dynamicLightOverrideStrength))
          ? this._dynamicLightOverrideStrength
          : Number(this.params.dynamicLightShadowOverrideStrength ?? 0.7);
        const affects = Math.max(0.0, Math.min(1.0, Number(this.params.affectsLights ?? 0.75)));
        u.uDynamicLightShadowOverrideStrength.value = Math.max(0.0, Math.min(1.0, baseStrength * affects));
      }
      if (u.uDebugView) {
        const debugMap = {
          final: 0.0,
          receiverOutdoors: 1.0,
          roofCoverage: 2.0,
          roofVisibility: 3.0,
          roofBase: 4.0,
          roofCombined: 5.0,
          tileCombined: 6.0,
        };
        const key = String(this.params.debugView || 'final');
        u.uDebugView.value = Object.prototype.hasOwnProperty.call(debugMap, key) ? debugMap[key] : 0.0;
      }

      if (u.uSceneDimensions) {
        try {
          const dims = canvas?.dimensions;
          if (dims) {
            const sw = dims.sceneWidth || dims.width || 1;
            const sh = dims.sceneHeight || dims.height || 1;
            u.uSceneDimensions.value.set(sw, sh);
          }
        } catch (_) { /* canvas may not be ready */ }
      }

      if (u.uOutdoorsMask) u.uOutdoorsMask.value = receiverMask;
      if (u.uHasOutdoorsMask) u.uHasOutdoorsMask.value = receiverMask ? 1.0 : 0.0;
      if (u.uOutdoorsMaskFlipY) u.uOutdoorsMaskFlipY.value = receiverMask?.flipY ? 1.0 : 0.0;

      this._lastOutdoorsMaskRef = receiverMask;
    }
  }

  /**
   * Force the next update() to recompute dynamic uniforms/mask bindings.
   * Use this on scene or level transitions where visual context can change
   * without camera/time parameter deltas.
   *
   * @param {string} [reason='manual']
   */
  invalidateDynamicCaches(reason = 'manual') {
    this._lastUpdateHash = null;
    this._lastOutdoorsMaskRef = null;
    this._lastSkyReachMaskRef = null;
    this._lastUpperFloorAlphaSig = '';
    this._lastObUpperSig = '';
    this._invalidateRoofMaskCaptureCache();
    // PERFORMANCE: Drop perf caches so the next render() rebuilds them.
    // - frame caster list (forces a fresh scene traverse)
    this._invalidateFrameCasters();
    // Drop cached per-floor texture refs so scene/floor transitions cannot
    // accumulate stale references over long runtimes.
    this._floorStates.clear();
    try {
      log.debug(`OverheadStampEffectV2: invalidated dynamic caches (${String(reason)})`);
    } catch (_) {}
  }

  /**
   * @returns {boolean}
   * @private
   */
  _isRoofHoverRevealActive() {
    try {
      return !!weatherController?.roofMaskActive;
    } catch (_) {
      return false;
    }
  }

  /**
   * Drop cached roof / tile-projection captures.
   * @private
   */
  _invalidateRoofMaskCaptureCache() {
    this._roofMaskCaptureCache.valid = false;
    this._roofMaskCaptureCache.sigHash = 0;
    this._roofMaskCaptureCache.capturedAtMs = 0;
    this._tileProjectionCaptureCache.valid = false;
    this._tileProjectionCaptureCache.sigHash = 0;
    this._tileProjectionCaptureCache.hasProjection = false;
    this._tileProjectionCaptureCache.hasProjectionSort = false;
    this._tileProjectionCaptureCache.hasReceiverSort = false;
  }

  /**
   * Fingerprint live caster fade + structure. Any partial fade forces a refresh.
   *
   * @param {{ list: object[], hasFluid: boolean, hasTrees: boolean }} frameCasters
   * @returns {string}
   * @private
   */
  _computeCasterLiveSig(frameCasters) {
    return hashCasterLive(frameCasters);
  }

  /**
   * @param {THREE.Vector2} size Drawing buffer size
   * @param {number} roofCaptureScale Guard-band scale from projection softness
   * @param {{ list: object[], hasFluid: boolean, hasTrees: boolean }} frameCasters
   * @returns {number}
   * @private
   */
  _computeRoofMaskCaptureSig(size, roofCaptureScale, frameCasters) {
    const w = Math.floor(size.x);
    const h = Math.floor(size.y);
    const enabled = this.params.enabled ? 1 : 0;
    const motionStr = this._tileMotionManager?.getActiveMotionCaptureSig?.() ?? '';
    let motionHash = 0;
    for (let i = 0; i < motionStr.length; i++) {
      motionHash = ((motionHash << 5) - motionHash + motionStr.charCodeAt(i)) | 0;
    }
    return hashRoofMaskCapture(
      w,
      h,
      roofCaptureScale,
      enabled,
      hashCamera(this.mainCamera, this._getEffectiveZoom()),
      hashCasterLive(frameCasters),
      motionHash,
    );
  }

  /**
   * @param {number} sigHash
   * @param {boolean} hoverRevealActive
   * @returns {boolean}
   * @private
   */
  _shouldReuseRoofMaskCaptures(sigHash, hoverRevealActive) {
    if (hoverRevealActive) return false;
    if (this._tileMotionManager?.shouldBypassShadowCaptureCache?.() === true) return false;
    try {
      if (window.MapShine?.__overheadShadowsForceRoofCaptureEveryFrame === true) return false;
    } catch (err) {
      log.debug('OverheadStamp: roof capture force-flag probe failed', err);
    }
    const cache = this._roofMaskCaptureCache;
    if (!cache.valid || cache.sigHash !== sigHash) return false;
    const maxAgeMs = Number(window.MapShine?.__overheadShadowsRoofCaptureMaxAgeMs);
    const ageLimit = Number.isFinite(maxAgeMs) ? maxAgeMs : 1500;
    if (ageLimit > 0 && (performance.now() - cache.capturedAtMs) > ageLimit) return false;
    return true;
  }

  /**
   * @param {number} sigHash
   * @private
   */
  _markRoofMaskCapturesFresh(sigHash) {
    this._roofMaskCaptureCache.valid = true;
    this._roofMaskCaptureCache.sigHash = sigHash;
    this._roofMaskCaptureCache.capturedAtMs = performance.now();
  }

  /**
   * @param {string[]} tileProjectionIds
   * @returns {Set<string>}
   * @private
   */
  _getTileProjectionIdSet(tileProjectionIds) {
    const idsHash = hashTileProjectionIds(tileProjectionIds);
    if (idsHash !== this._tileProjectionIdsHash) {
      this._tileProjectionIdsHash = idsHash;
      this._tileProjectionIdSet.clear();
      for (let i = 0; i < tileProjectionIds.length; i++) {
        this._tileProjectionIdSet.add(String(tileProjectionIds[i]));
      }
    }
    return this._tileProjectionIdSet;
  }

  /**
   * Render the effect as a full-screen pass.
   */
  render(renderer, scene = null, camera = null) {
    // Allow compositor to supply scene/camera each frame.
    if (scene) this.mainScene = scene;
    if (camera) this.mainCamera = camera;

    this._lastRoofMaskCaptureReused = false;

    // Late populate: base plane may arrive after initialize().
    if (!this.material && !this.baseMesh) {
      const basePlaneMesh = window.MapShine?.sceneComposer?.basePlaneMesh ?? null;
      if (basePlaneMesh) this.setBaseMesh(basePlaneMesh);
    }

    // If not initialized, force a neutral (white) shadow target so
    // LightingEffectV2 doesn't multiply the scene to black.
    if (!this.material || !this.mainCamera || !this.mainScene || !this.shadowScene) {
      if (this._isTreeRainMaskDebugEnabled()) {
        try {
          console.warn('[MSA][TreeRainMaskProbe] render early-out (not initialized)', {
            hasMaterial: !!this.material,
            hasMainCamera: !!this.mainCamera,
            hasMainScene: !!this.mainScene,
            hasShadowScene: !!this.shadowScene,
          });
        } catch (_) {}
      }
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const THREE = window.THREE;
    if (!THREE || !this.mainCamera || !this.mainScene || !this.shadowScene) return;

    // Disabled via params or graphics settings: skip all roof capture passes.
    // Consumers read null from texture getters; weather falls back to mask registry.
    if (!resolveEffectEnabled(this)) {
      this._lastRoofMaskCaptureReused = false;
      this._roofMaskCaptureCache.valid = false;
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    try {
      const recorder = window.MapShine?.performanceRecorder;
      this._activePerfRecorder = recorder?.enabled ? recorder : null;
    } catch (err) {
      log.debug('OverheadStamp: performance recorder probe failed', err);
      this._activePerfRecorder = null;
    }

    this._treeRainMaskDebugHeartbeat();

    let perfToken = this._beginPerfSpan('setupAndCache');

    // Ensure roof target exists and is correctly sized
    // PERFORMANCE: Reuse Vector2 instead of allocating every frame
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    const size = this._tempSize;
    renderer.getDrawingBufferSize(size);

    if (!this.roofTarget
      || !this.roofBlockTarget
      || !this.roofVisibilityTarget
      || !this.roofRestrictLightTarget
      || !this.rainOcclusionVisibilityTarget
      || !this.rainOcclusionBlockTarget
      || !this.shadowTarget
      || !this.fluidRoofTarget
      || !this.tileProjectionTarget
      || !this.tileProjectionSortTarget
      || !this.tileReceiverAlphaTarget
      || !this.tileReceiverSortTarget) {
      this.onResize(size.x, size.y);
    } else if (this.roofTarget.width !== size.x || this.roofTarget.height !== size.y
      || this.rainOcclusionVisibilityTarget.width !== size.x
      || this.rainOcclusionVisibilityTarget.height !== size.y) {
      this.onResize(size.x, size.y);
    }

    // 1. Render ROOF_LAYER (20) into roofTarget as alpha mask.
    //    To keep shadows present even when overhead tiles are hover-hidden
    //    (their sprite opacity fades out for UX), we temporarily force
    //    roof sprite materials to full opacity for this mask pass only.
    const ROOF_LAYER = 20;
    const WEATHER_ROOF_LAYER = 21;
    const roofVisibilityMaskBits = (1 << ROOF_LAYER) | (1 << WEATHER_ROOF_LAYER);
    const roofCaptureMaskBits = roofVisibilityMaskBits;
    const previousLayersMask = this.mainCamera.layers.mask;
    const previousTarget = renderer.getRenderTarget();

    // PERFORMANCE: Build per-frame caster cache (one mainScene.traverse) so all
    // downstream passes iterate a flat array instead of re-walking the scene.
    // frameId is a monotonic per-call counter (not real time) — every render()
    // invocation gets a fresh cache.
    const frameCasterFrameId = ++this._frameCasterId;
    const frameCasters = this._ensureFrameCasters(frameCasterFrameId, roofCaptureMaskBits);
    // PERFORMANCE: Cache the debug-enabled flag so each consumer below avoids a
    // global window.MapShine lookup. The check itself is internally throttled.
    const debugProbeEnabled = this._isTreeRainMaskDebugEnabled();
    this._endPerfSpan(perfToken);

    // Capture roof/fluid with a guard-band expanded camera view so projected
    // sampling near viewport edges still has valid source texels.
    const zoom = this._getEffectiveZoom();
    if (this.material?.uniforms?.uZoom) {
      // Keep shader projection distance and capture guard computations in sync.
      this.material.uniforms.uZoom.value = zoom;
    }
    const maxProjectionScale = Math.max(
      1.0,
      Number(this.params.tileProjectionLengthScale) || 0.0
    );
    const driverSoft = Math.max(0, Number(this._driverShadowSoftnessScale) || 1);
    const driverLen = Math.max(0, Number(this._driverShadowLengthScale) || 1);
    const maxSoftness = Math.max(
      Number(this.params.softness) || 0.0,
      Number(this.params.fluidShadowSoftness) || 0.0,
      Number(this.params.tileProjectionSoftness) || 0.0
    ) * driverSoft;
    const baseProjectionPx = (Number(this.params.length) || 0.0) * 1080.0 * Math.max(zoom, 0.0001);
    const projectionPx = baseProjectionPx * maxProjectionScale;
    const blurPx = maxSoftness * 2.0;
    const guardPx = Math.max(24.0, projectionPx + blurPx + 2.0);
    const guardScaleX = 1.0 + (2.0 * guardPx / Math.max(size.x, 1));
    const guardScaleY = 1.0 + (2.0 * guardPx / Math.max(size.y, 1));
    // Apply guard scaling for both ortho and perspective captures so roof/fluid
    // projection has real off-screen source coverage at viewport edges.
    const roofCaptureScale = Math.max(guardScaleX, guardScaleY);

    const hoverRevealActive = this._isRoofHoverRevealActive();
    const roofMaskCaptureSig = this._computeRoofMaskCaptureSig(size, roofCaptureScale, this._frameCasters);
    const reuseRoofMaskCaptures = this._shouldReuseRoofMaskCaptures(roofMaskCaptureSig, hoverRevealActive);
    this._lastRoofMaskCaptureReused = reuseRoofMaskCaptures;

    const INCLUDE_TREE_CANOPY_IN_WEATHER_ROOF_CAPTURES = true;
    const treeProbe = {
      includeTreeCapture: INCLUDE_TREE_CANOPY_IN_WEATHER_ROOF_CAPTURES,
      treeSeen: 0,
      treeWeatherLayerEnabled: 0,
      treeForcedVisibleForCapture: 0,
      roofTargetTreeParticipants: 0,
      roofTargetHoverFadeAvg: null,
      roofTargetHoverFadeMin: null,
      roofTargetHoverFadeMax: null,
      roofBlockTreeParticipants: 0,
      roofBlockHoverFadeBeforeAvg: null,
      roofBlockHoverFadeForcedCount: 0,
      roofVisibilityTexture: this.roofVisibilityTarget?.texture?.uuid ?? null,
      roofBlockTexture: this.roofBlockTarget?.texture?.uuid ?? null
    };
    const treeCaptureOverrides = [];
    const treeMaskCaptureUniformOverrides = [];
    const overrides = [];
    const opacityUniformOverrides = [];
    const tileOpacityUniformOverrides = [];
    const fluidVisibilityOverrides = [];
    const fluidUniformOverrides = [];
    const nonFluidVisibilityOverrides = [];
    const roofCasterTreeVisibilityOverrides = [];
    const roofSpriteVisibilityOverrides = [];
    const roofUpperCasterVisibilityOverrides = [];
    const pushTreeUniformOverride = (uniforms, key, value) => {
      const u = uniforms?.[key];
      if (!u || typeof u.value !== 'number') return;
      treeMaskCaptureUniformOverrides.push({ uniform: u, value: u.value });
      u.value = value;
    };

    if (!reuseRoofMaskCaptures) {
    perfToken = this._beginPerfSpan('treeWeatherPrep');
    if (INCLUDE_TREE_CANOPY_IN_WEATHER_ROOF_CAPTURES) {
      // PERFORMANCE: Iterate cached caster list instead of full scene traverse.
      // Tree debug counters only filled when probe is enabled to avoid hot-path
      // arithmetic when nobody is watching.
      const weatherRoofBit = 1 << WEATHER_ROOF_LAYER;
      for (let i = 0, n = frameCasters.length; i < n; i++) {
        const entry = frameCasters[i];
        if (!entry.isTree) continue;
        const object = entry.object;
        if (object?.userData?.mapShineTreeGroundShadow || object?.name?.startsWith('TreeV2Shadow_')) continue;
        const layers = object?.layers;
        if (!layers) continue;
        if (debugProbeEnabled) {
          treeProbe.treeSeen += 1;
          if ((layers.mask & weatherRoofBit) !== 0) {
            treeProbe.treeWeatherLayerEnabled += 1;
          }
        }
        treeCaptureOverrides.push({
          object,
          layersMask: layers.mask,
          visible: typeof object.visible === 'boolean' ? object.visible : undefined
        });
        layers.enable(WEATHER_ROOF_LAYER);
        if (typeof object.visible === 'boolean') {
          if (debugProbeEnabled && !object.visible) treeProbe.treeForcedVisibleForCapture += 1;
          object.visible = true;
        }
        // Tree canopy shaders also consume roof/block maps for their own visual
        // output. During roof-map capture, disable that self-masking feedback so
        // tree silhouettes contribute deterministically like roof sprites.
        const uniforms = entry.uniforms;
        if (uniforms) {
          pushTreeUniformOverride(uniforms, 'uRoofRainHardBlockEnabled', 0.0);
          pushTreeUniformOverride(uniforms, 'uHasRoofAlphaMap', 0.0);
          pushTreeUniformOverride(uniforms, 'uHasRoofBlockMap', 0.0);
        }
      }
    }
    this._endPerfSpan(perfToken);

    // PERFORMANCE: Iterate cached caster list. Skip the whole loop when no
    // fluid overlay was seen during cache build (very common case — no fluid
    // tiles in scene means zero exclusions to record).
    const roofVisibilityExclusions = [];
    if (this._frameCasters.hasFluid) {
      for (let i = 0, n = frameCasters.length; i < n; i++) {
        const entry = frameCasters[i];
        if (!entry.hasRoofLayer || !entry.isFluidOverlay) continue;
        const object = entry.object;
        if (typeof object.visible === 'boolean') {
          roofVisibilityExclusions.push({ object, visible: object.visible });
          object.visible = false;
        }
      }
    }

    // Capture runtime roof visibility (with live hover fade opacity) for
    // LightingEffectV2 building-shadow suppression. This pass intentionally uses
    // true tile visibility/opacity and excludes fluid overlays.
    perfToken = this._beginPerfSpan('roofVisibility');
    this.mainCamera.layers.set(ROOF_LAYER);
    this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
    renderer.setRenderTarget(this.roofVisibilityTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.mainScene, this.mainCamera);
    this._endPerfSpan(perfToken);

    for (const entry of roofVisibilityExclusions) {
      if (entry.object) entry.object.visible = entry.visible;
    }

    // Even when overhead shadow projection is disabled, keep roofVisibilityTarget
    // current so other effects (e.g. WindowLightEffectV2) can occlude against
    // visible overhead tiles in screen space.
    if (!this.params.enabled) {
      this.mainCamera.layers.mask = previousLayersMask;
      if (this.roofBlockTarget) {
        // Keep hard roof light-blocking available even when overhead shadow
        // projection is disabled.
        // PERFORMANCE: Both per-pass and tree iterations folded into ONE
        // sweep over the cached caster list.
        const disabledBlockerOpacityOverrides = [];
        const disabledBlockerUniformOverrides = [];
        const disabledTreeBlockerUniformOverrides = [];
        perfToken = this._beginPerfSpan('disabledBlockerPrep');
        for (let i = 0, n = frameCasters.length; i < n; i++) {
          const entry = frameCasters[i];
          if (entry.hasRoofLayer && entry.mat) {
            const mat = entry.mat;
            if (typeof mat.opacity === 'number') {
              disabledBlockerOpacityOverrides.push({ object: entry.object, opacity: mat.opacity });
              mat.opacity = 1.0;
            }
            const uniforms = entry.uniforms;
            if (uniforms) {
              const uOpacity = uniforms.uOpacity;
              if (uOpacity && typeof uOpacity.value === 'number') {
                disabledBlockerUniformOverrides.push({ uniform: uOpacity, value: uOpacity.value });
                uOpacity.value = 1.0;
              }
              const uTileOpacity = uniforms.uTileOpacity;
              if (uTileOpacity && typeof uTileOpacity.value === 'number') {
                disabledBlockerUniformOverrides.push({ uniform: uTileOpacity, value: uTileOpacity.value });
                uTileOpacity.value = 1.0;
              }
            }
          }
          if (entry.isTree) {
            if (debugProbeEnabled) treeProbe.roofBlockTreeParticipants += 1;
            const uniforms = entry.uniforms;
            if (uniforms) {
              if (uniforms.uHoverFade && typeof uniforms.uHoverFade.value === 'number') {
                disabledTreeBlockerUniformOverrides.push({ uniform: uniforms.uHoverFade, value: uniforms.uHoverFade.value });
                uniforms.uHoverFade.value = 1.0;
              }
              if (uniforms.uShadowOpacity && typeof uniforms.uShadowOpacity.value === 'number') {
                disabledTreeBlockerUniformOverrides.push({ uniform: uniforms.uShadowOpacity, value: uniforms.uShadowOpacity.value });
                uniforms.uShadowOpacity.value = 0.0;
              }
              if (uniforms.uWindSpeedGlobal && typeof uniforms.uWindSpeedGlobal.value === 'number') {
                disabledTreeBlockerUniformOverrides.push({ uniform: uniforms.uWindSpeedGlobal, value: uniforms.uWindSpeedGlobal.value });
                uniforms.uWindSpeedGlobal.value = 0.0;
              }
              if (uniforms.uAmbientMotion && typeof uniforms.uAmbientMotion.value === 'number') {
                disabledTreeBlockerUniformOverrides.push({ uniform: uniforms.uAmbientMotion, value: uniforms.uAmbientMotion.value });
                uniforms.uAmbientMotion.value = 0.0;
              }
              if (uniforms.uBranchBend && typeof uniforms.uBranchBend.value === 'number') {
                disabledTreeBlockerUniformOverrides.push({ uniform: uniforms.uBranchBend, value: uniforms.uBranchBend.value });
                uniforms.uBranchBend.value = 0.0;
              }
              if (uniforms.uFlutterIntensity && typeof uniforms.uFlutterIntensity.value === 'number') {
                disabledTreeBlockerUniformOverrides.push({ uniform: uniforms.uFlutterIntensity, value: uniforms.uFlutterIntensity.value });
                uniforms.uFlutterIntensity.value = 0.0;
              }
              if (uniforms.uTurbulence && typeof uniforms.uTurbulence.value === 'number') {
                disabledTreeBlockerUniformOverrides.push({ uniform: uniforms.uTurbulence, value: uniforms.uTurbulence.value });
                uniforms.uTurbulence.value = 0.0;
              }
            }
          }
        }
        this._endPerfSpan(perfToken);

        perfToken = this._beginPerfSpan('disabledRoofBlock');
        this.mainCamera.layers.set(ROOF_LAYER);
        this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
        renderer.setRenderTarget(this.roofBlockTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this.mainScene, this.mainCamera);
        this._endPerfSpan(perfToken);

        // Rain occlusion visibility must see live tree/roof fade (uHoverFade, tile
        // opacity). The roof-block pass above forces full opacity for rb; restore
        // those overrides *before* _renderRainOcclusionTargets so rv matches the
        // screen (enabled path does the same via treeBlockerUniformOverrides finally).
        for (const entry of disabledTreeBlockerUniformOverrides) {
          if (entry?.uniform) entry.uniform.value = entry.value;
        }
        for (const entry of disabledBlockerUniformOverrides) {
          if (entry?.uniform) entry.uniform.value = entry.value;
        }
        for (const entry of disabledBlockerOpacityOverrides) {
          if (entry?.object?.material) entry.object.material.opacity = entry.opacity;
        }

        // Restrict-light mask after live opacity/tree uniforms are restored so hover-
        // faded roofs stop blocking dynamic light (stamp alpha follows the fade).
        if (this.roofRestrictLightTarget) {
          // PERFORMANCE: Iterate cached caster list (no scene traverse).
          const restrictLightVisOverrides = [];
          perfToken = this._beginPerfSpan('disabledRestrictLightPrep');
          for (let i = 0, n = frameCasters.length; i < n; i++) {
            const entry = frameCasters[i];
            if (!entry.hasRoofLayer) continue;
            if (entry.isFluidOverlay) continue;
            const object = entry.object;
            if (!(entry.isSprite || entry.isMesh) || typeof object.visible !== 'boolean') continue;
            const liveVis = object.visible;
            restrictLightVisOverrides.push({ object, visible: object.visible });
            const isFoundryTile = entry.isFoundryTile;
            const rl = objectRestrictsLightForRoofCapture(object);
            if (!isFoundryTile) object.visible = false;
            else object.visible = !!(liveVis && rl);
          }
          this._endPerfSpan(perfToken);
          perfToken = this._beginPerfSpan('disabledRestrictLight');
          this.mainCamera.layers.set(ROOF_LAYER);
          this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
          renderer.setRenderTarget(this.roofRestrictLightTarget);
          renderer.setClearColor(0x000000, 0);
          renderer.clear();
          renderer.render(this.mainScene, this.mainCamera);
          this._endPerfSpan(perfToken);
          for (const entry of restrictLightVisOverrides) {
            if (entry.object) entry.object.visible = entry.visible;
          }
        }

        this._renderRainOcclusionTargets(renderer, roofCaptureMaskBits, ROOF_LAYER, WEATHER_ROOF_LAYER);
        this._emitTreeRainMaskProbe({
          ...treeProbe,
          path: 'overhead-disabled-roofBlock',
          disabledPathRestoredBeforeRainOcclusion: true,
        });
      } else {
        this._emitTreeRainMaskProbe({ ...treeProbe, path: 'overhead-disabled-no-roofBlock', warn: 'roofBlockTarget missing' });
      }
      this._markRoofMaskCapturesFresh(roofMaskCaptureSig);
      for (const entry of treeCaptureOverrides) {
        if (!entry?.object) continue;
        if (entry.object.layers) entry.object.layers.mask = entry.layersMask;
        if (typeof entry.visible === 'boolean') entry.object.visible = entry.visible;
      }
      for (const entry of treeMaskCaptureUniformOverrides) {
        if (entry?.uniform) entry.uniform.value = entry.value;
      }
      this.mainCamera.layers.mask = previousLayersMask;
      this._clearShadowTargetToWhite(renderer);
      renderer.setRenderTarget(previousTarget);
      return;
    }

    // Guard-band capture is only for roof/fluid caster passes. Do NOT apply it
    // to roofVisibilityTarget because LightingEffect samples that texture in
    // direct screen UV space (vUv) without guard remap.
    const restoreRoofCaptureCamera = this._applyRoofCaptureGuardScale(roofCaptureScale);
    if (this.material?.uniforms?.uTileProjectionUvScale) {
      this.material.uniforms.uTileProjectionUvScale.value = 1.0;
    }

    // PERFORMANCE: Iterate cached caster list. Single pass collects fluid visibility
    // / fluid uniform overrides AND opacity overrides for non-fluid casters.
    perfToken = this._beginPerfSpan('casterOverridePrep');
    for (let i = 0, n = frameCasters.length; i < n; i++) {
      const entry = frameCasters[i];
      if (!entry.hasRoofLayer || !entry.mat) continue;
      const object = entry.object;
      const isFluidOverlay = entry.isFluidOverlay;

      if (typeof object.visible === 'boolean') {
        fluidVisibilityOverrides.push({ object, visible: object.visible });
        object.visible = isFluidOverlay;

        if (isFluidOverlay) {
          const uniforms = entry.uniforms;
          if (uniforms) {
            fluidUniformOverrides.push({
              uniforms,
              tileOpacity: uniforms.uTileOpacity?.value,
              roofOcclusionEnabled: uniforms.uRoofOcclusionEnabled?.value
            });
            if (uniforms.uTileOpacity) uniforms.uTileOpacity.value = 1.0;
            if (uniforms.uRoofOcclusionEnabled) uniforms.uRoofOcclusionEnabled.value = 0.0;
          }
        }
      }

      if (isFluidOverlay) continue;
      const mat = entry.mat;
      if (typeof mat.opacity === 'number') {
        overrides.push({ object, opacity: mat.opacity });
        // IMPORTANT: Hover-hide is a UX-only fade on roof tile renderables. We
        // intentionally
        // keep overhead shadows active while hovering, so the shadow mask render
        // pass always treats roof casters as fully opaque.
        mat.opacity = 1.0;
      }
      const uniforms = entry.uniforms;
      if (uniforms) {
        const opacityUniform = uniforms.uOpacity;
        if (opacityUniform && typeof opacityUniform.value === 'number') {
          opacityUniformOverrides.push({ uniform: opacityUniform, value: opacityUniform.value });
          opacityUniform.value = 1.0;
        }
        const tileOpacityUniform = uniforms.uTileOpacity;
        if (tileOpacityUniform && typeof tileOpacityUniform.value === 'number') {
          tileOpacityUniformOverrides.push({ uniform: tileOpacityUniform, value: tileOpacityUniform.value });
          tileOpacityUniform.value = 1.0;
        }
      }
    }
    this._endPerfSpan(perfToken);

    // Pass 0/1 use guard-band camera state (temporarily expanded frustum).
    // Reveal upper-floor bus casters only for these caster-capture passes so
    // roofVisibilityTarget remains active-floor-only.
    let busRevealSnapshot = [];
    try {
      // Tell FloorRenderBus to reveal upper-floor casters for shadow capture.
      // This must happen before _forceUpperOverheadCasterVisibility so the bus
      // tiles are already visible when that function captures the "previous" state.
      busRevealSnapshot = this._renderBus?.beginOverheadShadowCaptureReveal?.() ?? [];

      // Pass 0: render only FluidEffect overlays attached to overhead tiles.
      perfToken = this._beginPerfSpan('fluidRoofCapture');
      this.mainCamera.layers.set(ROOF_LAYER);
      renderer.setRenderTarget(this.fluidRoofTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);
      this._endPerfSpan(perfToken);

    for (const entry of fluidVisibilityOverrides) {
      if (entry.object) {
        entry.object.visible = entry.visible;
      }
    }
    for (const entry of fluidUniformOverrides) {
      if (!entry?.uniforms) continue;
      if (entry.uniforms.uTileOpacity && typeof entry.tileOpacity === 'number') {
        entry.uniforms.uTileOpacity.value = entry.tileOpacity;
      }
      if (entry.uniforms.uRoofOcclusionEnabled && typeof entry.roofOcclusionEnabled === 'number') {
        entry.uniforms.uRoofOcclusionEnabled.value = entry.roofOcclusionEnabled;
      }
    }

      // Pass 1 should be based on overhead tile sprites only (exclude fluid overlays).
      // Re-enable above-active overhead casters ONLY for this caster capture pass
      // so lower floors receive their shadow contribution without polluting
      // visibility/blocker textures used elsewhere.
      perfToken = this._beginPerfSpan('roofCapturePrep');
      roofUpperCasterVisibilityOverrides.push(...this._forceUpperOverheadCasterVisibilityForRoofPass());
      // PERFORMANCE: Iterate cached caster list. Tree probe averaging only runs
      // when debug is enabled.
      for (let i = 0, n = frameCasters.length; i < n; i++) {
        const entry = frameCasters[i];
        if (!entry.hasRoofLayer) continue;
        const object = entry.object;
        if (entry.isFluidOverlay) {
          if (typeof object.visible === 'boolean') {
            nonFluidVisibilityOverrides.push({ object, visible: object.visible });
            object.visible = false;
          }
          continue;
        }
        // Keep tree canopies in roof visibility/block captures so weather masking
        // follows tree hover-fade exactly like overhead roof sprites.
        if (entry.isTree && debugProbeEnabled) {
          const hf = Number(entry.uniforms?.uHoverFade?.value);
          treeProbe.roofTargetTreeParticipants += 1;
          if (Number.isFinite(hf)) {
            const count = treeProbe.roofTargetTreeParticipants;
            treeProbe.roofTargetHoverFadeAvg = (treeProbe.roofTargetHoverFadeAvg == null)
              ? hf
              : (treeProbe.roofTargetHoverFadeAvg * ((count - 1) / count) + hf / count);
            treeProbe.roofTargetHoverFadeMin = (treeProbe.roofTargetHoverFadeMin == null) ? hf : Math.min(treeProbe.roofTargetHoverFadeMin, hf);
            treeProbe.roofTargetHoverFadeMax = (treeProbe.roofTargetHoverFadeMax == null) ? hf : Math.max(treeProbe.roofTargetHoverFadeMax, hf);
          }
        }

        // Hover-reveal can temporarily hide/fade roof renderables. For the roof mask
        // capture pass we still need those tiles to contribute caster alpha.
        if ((entry.isSprite || entry.isMesh) && typeof object.visible === 'boolean') {
          roofSpriteVisibilityOverrides.push({ object, visible: object.visible });
          object.visible = true;
        }
      }
      this._endPerfSpan(perfToken);

      // Pass 1: render overhead tiles into roofTarget (alpha mask)
      perfToken = this._beginPerfSpan('roofCapture');
      this.mainCamera.layers.set(ROOF_LAYER);
      this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
      renderer.setRenderTarget(this.roofTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);
      this._endPerfSpan(perfToken);

      // Pass 1 needs full-opacity casters; restrict-light must use live opacity and
      // the real pre-pass visibility so faded/hidden roofs release dynamic lighting.
      for (const entry of overrides) {
        if (entry.object && entry.object.material) {
          entry.object.material.opacity = entry.opacity;
        }
      }
      for (const entry of opacityUniformOverrides) {
        if (entry?.uniform) entry.uniform.value = entry.value;
      }
      for (const entry of tileOpacityUniformOverrides) {
        if (entry?.uniform) entry.uniform.value = entry.value;
      }
      const roofSpriteLiveVisible = new Map(
        roofSpriteVisibilityOverrides.map((e) => [e.object, e.visible])
      );

      // Pass 1c: restrict-light overhead only (same camera/layers as Pass 1).
      // PERFORMANCE: Iterate cached caster list.
      const restrictLightVisOverrides = [];
      perfToken = this._beginPerfSpan('restrictLightPrep');
      for (let i = 0, n = frameCasters.length; i < n; i++) {
        const entry = frameCasters[i];
        if (!entry.hasRoofLayer) continue;
        if (entry.isFluidOverlay) continue;
        const object = entry.object;
        if (!(entry.isSprite || entry.isMesh) || typeof object.visible !== 'boolean') continue;
        const liveVis = roofSpriteLiveVisible.has(object)
          ? roofSpriteLiveVisible.get(object)
          : object.visible;
        restrictLightVisOverrides.push({ object, visible: object.visible });
        const isFoundryTile = entry.isFoundryTile;
        const rl = objectRestrictsLightForRoofCapture(object);
        if (!isFoundryTile) {
          object.visible = false;
        } else {
          object.visible = !!(liveVis && rl);
        }
      }
      this._endPerfSpan(perfToken);
      perfToken = this._beginPerfSpan('restrictLight');
      renderer.setRenderTarget(this.roofRestrictLightTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);
      this._endPerfSpan(perfToken);
      for (const entry of restrictLightVisOverrides) {
        if (entry.object) entry.object.visible = entry.visible;
      }
    } finally {
      for (const entry of roofCasterTreeVisibilityOverrides) {
        if (entry.object) entry.object.visible = entry.visible;
      }
      for (const entry of roofUpperCasterVisibilityOverrides) {
        if (entry?.object) entry.object.visible = entry.visible;
      }
      restoreRoofCaptureCamera();
      // Restore FloorRenderBus visibility after all other visibility overrides.
      // Bus tiles were revealed by beginOverheadShadowCaptureReveal for this pass.
      this._renderBus?.endOverheadShadowCaptureReveal?.(busRevealSnapshot);
    }

    // Restore per-sprite opacity now that roofTarget capture is done.
    // roofBlockTarget (ceiling transmittance / T is owned by LightingEffectV2) should follow hover-visible roof
    // tiles/canopies so light suppression can fade in/out correctly.
    for (const entry of overrides) {
      if (entry.object && entry.object.material) {
        entry.object.material.opacity = entry.opacity;
      }
    }
    for (const entry of opacityUniformOverrides) {
      if (entry?.uniform) entry.uniform.value = entry.value;
    }
    for (const entry of tileOpacityUniformOverrides) {
      if (entry?.uniform) entry.uniform.value = entry.value;
    }
    for (const entry of roofSpriteVisibilityOverrides) {
      if (entry.object) entry.object.visible = entry.visible;
    }

    // Pass 1b: capture a non-guard roof blocker map for LightingEffectV2 hard
    // occlusion. This must remain in direct screen UV.
    // PERFORMANCE: Iterate cached caster list (trees only). Probe averaging is
    // gated behind debug flag — no arithmetic when nobody is watching.
    const treeBlockerUniformOverrides = [];
    perfToken = this._beginPerfSpan('roofBlockPrep');
    if (this._frameCasters.hasTrees) {
      for (let i = 0, n = frameCasters.length; i < n; i++) {
        const entry = frameCasters[i];
        if (!entry.isTree) continue;
        const uniforms = entry.uniforms;
        if (debugProbeEnabled) {
          treeProbe.roofBlockTreeParticipants += 1;
          const hfBefore = Number(uniforms?.uHoverFade?.value);
          if (Number.isFinite(hfBefore)) {
            const count = treeProbe.roofBlockTreeParticipants;
            treeProbe.roofBlockHoverFadeBeforeAvg = (treeProbe.roofBlockHoverFadeBeforeAvg == null)
              ? hfBefore
              : (treeProbe.roofBlockHoverFadeBeforeAvg * ((count - 1) / count) + hfBefore / count);
          }
        }
        if (!uniforms) continue;
        if (uniforms.uHoverFade && typeof uniforms.uHoverFade.value === 'number') {
          treeBlockerUniformOverrides.push({ uniform: uniforms.uHoverFade, value: uniforms.uHoverFade.value });
          uniforms.uHoverFade.value = 1.0;
          if (debugProbeEnabled) treeProbe.roofBlockHoverFadeForcedCount += 1;
        }
        if (uniforms.uShadowOpacity && typeof uniforms.uShadowOpacity.value === 'number') {
          treeBlockerUniformOverrides.push({ uniform: uniforms.uShadowOpacity, value: uniforms.uShadowOpacity.value });
          uniforms.uShadowOpacity.value = 0.0;
        }
        if (uniforms.uWindSpeedGlobal && typeof uniforms.uWindSpeedGlobal.value === 'number') {
          treeBlockerUniformOverrides.push({ uniform: uniforms.uWindSpeedGlobal, value: uniforms.uWindSpeedGlobal.value });
          uniforms.uWindSpeedGlobal.value = 0.0;
        }
        if (uniforms.uAmbientMotion && typeof uniforms.uAmbientMotion.value === 'number') {
          treeBlockerUniformOverrides.push({ uniform: uniforms.uAmbientMotion, value: uniforms.uAmbientMotion.value });
          uniforms.uAmbientMotion.value = 0.0;
        }
        if (uniforms.uBranchBend && typeof uniforms.uBranchBend.value === 'number') {
          treeBlockerUniformOverrides.push({ uniform: uniforms.uBranchBend, value: uniforms.uBranchBend.value });
          uniforms.uBranchBend.value = 0.0;
        }
        if (uniforms.uFlutterIntensity && typeof uniforms.uFlutterIntensity.value === 'number') {
          treeBlockerUniformOverrides.push({ uniform: uniforms.uFlutterIntensity, value: uniforms.uFlutterIntensity.value });
          uniforms.uFlutterIntensity.value = 0.0;
        }
        if (uniforms.uTurbulence && typeof uniforms.uTurbulence.value === 'number') {
          treeBlockerUniformOverrides.push({ uniform: uniforms.uTurbulence, value: uniforms.uTurbulence.value });
          uniforms.uTurbulence.value = 0.0;
        }
      }
    }
    this._endPerfSpan(perfToken);
    try {
      perfToken = this._beginPerfSpan('roofBlock');
      this.mainCamera.layers.set(ROOF_LAYER);
      this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
      renderer.setRenderTarget(this.roofBlockTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);
      this._endPerfSpan(perfToken);
    } finally {
      for (const entry of treeBlockerUniformOverrides) {
        if (entry?.uniform) entry.uniform.value = entry.value;
      }
    }
    this._renderRainOcclusionTargets(renderer, roofCaptureMaskBits, ROOF_LAYER, WEATHER_ROOF_LAYER);
    this._emitTreeRainMaskProbe({ ...treeProbe, path: 'overhead-enabled' });

    this._markRoofMaskCapturesFresh(roofMaskCaptureSig);

    } else {
      const cacheHitToken = this._beginPerfSpan('roofMaskCaptureCacheHit');
      this._endPerfSpan(cacheHitToken);
      if (!this.params.enabled) {
        for (const entry of treeCaptureOverrides) {
          if (!entry?.object) continue;
          if (entry.object.layers) entry.object.layers.mask = entry.layersMask;
          if (typeof entry.visible === 'boolean') entry.object.visible = entry.visible;
        }
        for (const entry of treeMaskCaptureUniformOverrides) {
          if (entry?.uniform) entry.uniform.value = entry.value;
        }
        this.mainCamera.layers.mask = previousLayersMask;
        this._clearShadowTargetToWhite(renderer);
        renderer.setRenderTarget(previousTarget);
        return;
      }
    }

    // Guard-band UV remap must stay in sync even when roof/tile captures are cache-reused.
    if (this.material?.uniforms?.uRoofUvScale) {
      this.material.uniforms.uRoofUvScale.value = 1.0 / Math.max(roofCaptureScale, 1.0);
    }

    // Pass 1.5: optional tile alpha projection pass.
    // Uses per-tile "Shadow Projection" flags from the injected V2
    // TileMotionManager dependency.
    let hasTileProjection = false;
    let hasTileProjectionSort = false;
    let hasTileReceiverSort = false;
    const tileProjectionIds = this._getTileProjectionIds();
    const tileProjectionActive = this.params.tileProjectionEnabled && tileProjectionIds.length > 0;
    const tileProjectionMotionSig = this._tileMotionManager?.getShadowProjectionMotionSig?.() ?? '';
    const bypassTileMotionShadowCache = this._tileMotionManager?.shouldBypassShadowCaptureCache?.() === true;
    let motionHash = 0;
    const motionStr = String(tileProjectionMotionSig);
    for (let i = 0; i < motionStr.length; i++) {
      motionHash = ((motionHash << 5) - motionHash + motionStr.charCodeAt(i)) | 0;
    }
    const tileProjectionSigHash = tileProjectionActive
      ? hashTileProjectionCapture(roofMaskCaptureSig, hashTileProjectionIds(tileProjectionIds), motionHash)
      : 0;
    const tileProjCache = this._tileProjectionCaptureCache;
    const reuseTileProjection = tileProjectionActive
      && !bypassTileMotionShadowCache
      && tileProjectionSigHash !== 0
      && tileProjCache.valid
      && tileProjCache.sigHash === tileProjectionSigHash;
    if (reuseTileProjection) {
      hasTileProjection = tileProjCache.hasProjection;
      hasTileProjectionSort = tileProjCache.hasProjectionSort;
      hasTileReceiverSort = tileProjCache.hasReceiverSort;
      const tileCacheHitToken = this._beginPerfSpan('tileProjectionCacheHit');
      this._endPerfSpan(tileCacheHitToken);
    } else if (tileProjectionActive) {
      perfToken = this._beginPerfSpan('tileProjectionTotal');
      const tileResult = this._tileProjectionPass.render(this, renderer, {
        size,
        tileProjectionIds,
        frameCasters: this._frameCasters,
        baseProjectionPx,
        tileProjectionIdSet: this._getTileProjectionIdSet(tileProjectionIds),
        beginPerfSpan: (n) => this._beginPerfSpan(n),
        endPerfSpan: (t) => this._endPerfSpan(t),
      });
      hasTileProjection = tileResult.hasProjection;
      hasTileProjectionSort = tileResult.hasProjectionSort;
      hasTileReceiverSort = tileResult.hasReceiverSort;
      tileProjCache.valid = true;
      tileProjCache.sigHash = tileProjectionSigHash;
      tileProjCache.hasProjection = hasTileProjection;
      tileProjCache.hasProjectionSort = hasTileProjectionSort;
      tileProjCache.hasReceiverSort = hasTileReceiverSort;
      this._endPerfSpan(perfToken);
    }

    // Guard-band UV remap must stay in sync even when tile capture is cache-reused
    // (the pass that normally writes uTileProjectionUvScale is skipped on cache hit).
    if (tileProjectionActive && this.material?.uniforms?.uTileProjectionUvScale) {
      const tileProjectionPx = baseProjectionPx * Math.max(Number(this.params.tileProjectionLengthScale) || 0, 0);
      const tileProjectionBlurPx = Math.max(Number(this.params.tileProjectionSoftness) || 0, 0) * 2.0 * driverSoft;
      const tileGuardPx = Math.max(24.0, tileProjectionPx + tileProjectionBlurPx + 2.0);
      const tileGuardScaleX = 1.0 + (2.0 * tileGuardPx / Math.max(size.x, 1));
      const tileGuardScaleY = 1.0 + (2.0 * tileGuardPx / Math.max(size.y, 1));
      const tileCaptureScale = Math.max(tileGuardScaleX, tileGuardScaleY);
      this.material.uniforms.uTileProjectionUvScale.value = 1.0 / Math.max(tileCaptureScale, 1.0);
    }

    // Restore camera layers after tile capture (pass uses layers.enableAll() internally).
    // shadowCompositeDraw saves/restores its own layer mask for the groundplane mesh.
    this.mainCamera.layers.mask = previousLayersMask;

    perfToken = this._beginPerfSpan('maskBlurPasses');
    const roofBlurRadius = Math.max(0, Number(this.params.softness) || 0) * 0.5 * driverSoft;
    const tileBlurRadius = Math.max(0, Number(this.params.tileProjectionSoftness) || 0) * 0.5 * driverSoft;
    const fluidBlurRadius = Math.max(0, Number(this.params.fluidShadowSoftness) || 0) * 0.5 * driverSoft;
    let roofBlurredTex = null;
    let tileBlurredTex = null;
    let fluidBlurredTex = null;
    if (this.roofTarget?.texture && this.roofBlurredTarget) {
      roofBlurredTex = this._maskBlur.blurAlpha(renderer, this.roofTarget.texture, this.roofBlurredTarget, roofBlurRadius);
    }
    if (hasTileProjection && this.tileProjectionTarget?.texture && this.tileProjectionBlurredTarget) {
      tileBlurredTex = this._maskBlur.blurAlpha(renderer, this.tileProjectionTarget.texture, this.tileProjectionBlurredTarget, tileBlurRadius);
    }
    if (this.fluidRoofTarget?.texture && this.fluidRoofBlurredTarget) {
      fluidBlurredTex = this._maskBlur.blurRGBA(renderer, this.fluidRoofTarget.texture, this.fluidRoofBlurredTarget, fluidBlurRadius);
    }
    this._endPerfSpan(perfToken);

    perfToken = this._beginPerfSpan('stampShadowChannelGates');
    this._applyUnifiedShadowStampShaderFlags(THREE);
    this._endPerfSpan(perfToken);

    perfToken = this._beginPerfSpan('shadowCompositeUniforms');
    if (this.material && this.material.uniforms) {
      const u = this.material.uniforms;
      u.tRoof.value = this.roofTarget.texture;
      u.tRoofStamp.value = roofBlurredTex || this.roofTarget.texture;
      u.tRoofVisibility.value = this.roofVisibilityTarget?.texture || null;
      u.uHasRoofVisibility.value = this.roofVisibilityTarget?.texture ? 1.0 : 0.0;
      u.tFluidRoof.value = fluidBlurredTex || this.fluidRoofTarget?.texture || null;
      u.uHasFluidRoof.value = u.tFluidRoof.value ? 1.0 : 0.0;
      u.tTileProjection.value = hasTileProjection
        ? (tileBlurredTex || this.tileProjectionTarget?.texture)
        : null;
      u.uHasTileProjection.value = hasTileProjection ? 1.0 : 0.0;
      if (u.tTileProjectionRaw) {
        u.tTileProjectionRaw.value = hasTileProjection ? (this.tileProjectionTarget?.texture ?? null) : null;
      }
      if (u.uHasTileProjectionRaw) {
        u.uHasTileProjectionRaw.value = (hasTileProjection && this.tileProjectionTarget?.texture) ? 1.0 : 0.0;
      }
      u.tTileProjectionSort.value = hasTileProjectionSort ? this.tileProjectionSortTarget?.texture : null;
      u.uHasTileProjectionSort.value = hasTileProjectionSort ? 1.0 : 0.0;
      u.tTileReceiverAlpha.value = hasTileReceiverSort ? this.tileReceiverAlphaTarget?.texture : null;
      u.tTileReceiverSort.value = hasTileReceiverSort ? this.tileReceiverSortTarget?.texture : null;
      u.uHasTileReceiverSort.value = hasTileReceiverSort ? 1.0 : 0.0;
      if (this.material.uniforms.uResolution) {
        this.material.uniforms.uResolution.value.set(size.x, size.y);
      }

      // Bind depth pass for height-based shadow modulation
      const dpm = window.MapShine?.depthPassManager;
      const depthTex = (dpm && dpm.isEnabled()) ? dpm.getDepthTexture() : null;
      if (this.material.uniforms.uDepthEnabled) {
        this.material.uniforms.uDepthEnabled.value = depthTex ? 1.0 : 0.0;
      }
      if (this.material.uniforms.uDepthTexture) {
        this.material.uniforms.uDepthTexture.value = depthTex;
      }
      if (depthTex && dpm) {
        if (this.material.uniforms.uDepthCameraNear) this.material.uniforms.uDepthCameraNear.value = dpm.getDepthNear();
        if (this.material.uniforms.uDepthCameraFar) this.material.uniforms.uDepthCameraFar.value = dpm.getDepthFar();
        if (this.material.uniforms.uGroundDistance) {
          this.material.uniforms.uGroundDistance.value = window.MapShine?.sceneComposer?.groundDistance ?? 1000.0;
        }
      }
    }
    this._endPerfSpan(perfToken);

    this._syncStampSceneUniforms(this.mainCamera);
    perfToken = this._beginPerfSpan('shadowCompositeDraw');
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    const prevLayerMask = this.mainCamera.layers.mask;
    this.mainCamera.layers.enable(0);
    renderer.render(this.shadowScene, this.mainCamera);
    this.mainCamera.layers.mask = prevLayerMask;
    this._endPerfSpan(perfToken);

    perfToken = this._beginPerfSpan('restoreState');
    for (const entry of nonFluidVisibilityOverrides) {
      if (entry.object) entry.object.visible = entry.visible;
    }
    for (const entry of treeCaptureOverrides) {
      if (!entry?.object) continue;
      if (entry.object.layers) entry.object.layers.mask = entry.layersMask;
      if (typeof entry.visible === 'boolean') entry.object.visible = entry.visible;
    }
    for (const entry of treeMaskCaptureUniformOverrides) {
      if (entry?.uniform) entry.uniform.value = entry.value;
    }
    // Restore previous render target
    renderer.setRenderTarget(previousTarget);
    this._endPerfSpan(perfToken);
  }

  /**
   * Render dedicated weather occlusion maps used by precipitation masking.
   * Captures runtime visibility and forced-opaque blockers for overhead + trees.
   *
   * PERFORMANCE: Reuses the per-frame caster cache built at the start of
   * render(). Falls back to a direct traverse when the cache is unavailable
   * (e.g. called outside the standard render pipeline).
   *
   * @private
   */
  _renderRainOcclusionTargets(renderer, roofCaptureMaskBits, roofLayer, weatherRoofLayer) {
    if (!renderer || !this.mainScene || !this.mainCamera
      || !this.rainOcclusionVisibilityTarget || !this.rainOcclusionBlockTarget) return;

    const scope = new SceneCaptureScope();
    const overrides = [];
    const visUniformOverrides = [];
    const blockUniformOverrides = [];
    const pushUniform = (list, uniforms, key, value) => {
      const u = uniforms?.[key];
      if (!u || typeof u.value !== 'number') return;
      list.push({ uniform: u, value: u.value });
      u.value = value;
    };

    const fc = this._frameCasters;
    const useCache = fc.frameId >= 0 && fc.scene === this.mainScene;

    let perfToken = this._beginPerfSpan('rainOcclusionVisibilityPrep');
    if (useCache) {
      // Iterate cached roof-layer entries.
      const list = fc.list;
      for (let i = 0, n = list.length; i < n; i++) {
        const entry = list[i];
        if (!entry.hasRoofLayer || !entry.mat) continue;
        const object = entry.object;
        const isFluidOverlay = entry.isFluidOverlay;
        if (typeof object.visible === 'boolean') {
          overrides.push({ object, visible: object.visible });
          object.visible = !isFluidOverlay;
        }
        if (isFluidOverlay) continue;

        const mat = entry.mat;
        if (typeof mat.opacity === 'number') {
          visUniformOverrides.push({ object: mat, key: 'opacity', value: mat.opacity });
        }
        const uniforms = entry.uniforms;
        if (!uniforms) continue;
        if (entry.isTree) {
          pushUniform(visUniformOverrides, uniforms, 'uShadowOpacity', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uWindSpeedGlobal', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uAmbientMotion', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uBranchBend', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uFlutterIntensity', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uTurbulence', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uRoofRainHardBlockEnabled', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uHasRoofAlphaMap', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uHasRoofBlockMap', 0.0);
        }
      }
    } else {
      this.mainScene.traverse((object) => {
        if (!object?.layers || !object?.material) return;
        if ((object.layers.mask & roofCaptureMaskBits) === 0) return;
        const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);
        if (typeof object.visible === 'boolean') {
          overrides.push({ object, visible: object.visible });
          object.visible = !isFluidOverlay;
        }
        if (isFluidOverlay) return;

        const mat = object.material;
        if (typeof mat.opacity === 'number') {
          visUniformOverrides.push({ object: mat, key: 'opacity', value: mat.opacity });
        }
        const uniforms = mat?.uniforms;
        if (!uniforms) return;

        if (object?.userData?.mapShineTreeTileId) {
          pushUniform(visUniformOverrides, uniforms, 'uShadowOpacity', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uWindSpeedGlobal', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uAmbientMotion', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uBranchBend', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uFlutterIntensity', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uTurbulence', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uRoofRainHardBlockEnabled', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uHasRoofAlphaMap', 0.0);
          pushUniform(visUniformOverrides, uniforms, 'uHasRoofBlockMap', 0.0);
        }
      });
    }
    this._endPerfSpan(perfToken);

    const prevMask = this.mainCamera.layers.mask;
    const prevTarget = renderer.getRenderTarget();
    try {
    this.mainCamera.layers.set(roofLayer);
    this.mainCamera.layers.enable(weatherRoofLayer);

    perfToken = this._beginPerfSpan('rainOcclusionVisibility');
    renderer.setRenderTarget(this.rainOcclusionVisibilityTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.mainScene, this.mainCamera);
    this._endPerfSpan(perfToken);

    for (const entry of visUniformOverrides) {
      if (entry?.object && entry.key === 'opacity') entry.object.opacity = 1.0;
    }
    perfToken = this._beginPerfSpan('rainOcclusionBlockPrep');
    if (useCache) {
      const list = fc.list;
      for (let i = 0, n = list.length; i < n; i++) {
        const entry = list[i];
        if (!entry.hasRoofLayer || !entry.mat) continue;
        if (entry.isFluidOverlay) continue;
        const mat = entry.mat;
        const uniforms = entry.uniforms;
        if (typeof mat.opacity === 'number') {
          blockUniformOverrides.push({ object: mat, key: 'opacity', value: mat.opacity });
          mat.opacity = 1.0;
        }
        if (!uniforms) continue;
        pushUniform(blockUniformOverrides, uniforms, 'uOpacity', 1.0);
        pushUniform(blockUniformOverrides, uniforms, 'uTileOpacity', 1.0);
        if (entry.isTree) {
          pushUniform(blockUniformOverrides, uniforms, 'uHoverFade', 1.0);
        }
      }
    } else {
      this.mainScene.traverse((object) => {
        if (!object?.layers || !object?.material) return;
        if ((object.layers.mask & roofCaptureMaskBits) === 0) return;
        const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);
        if (isFluidOverlay) return;
        const mat = object.material;
        const uniforms = mat?.uniforms;
        if (typeof mat.opacity === 'number') {
          blockUniformOverrides.push({ object: mat, key: 'opacity', value: mat.opacity });
          mat.opacity = 1.0;
        }
        if (!uniforms) return;
        pushUniform(blockUniformOverrides, uniforms, 'uOpacity', 1.0);
        pushUniform(blockUniformOverrides, uniforms, 'uTileOpacity', 1.0);
        if (object?.userData?.mapShineTreeTileId) {
          pushUniform(blockUniformOverrides, uniforms, 'uHoverFade', 1.0);
        }
      });
    }
    this._endPerfSpan(perfToken);

    perfToken = this._beginPerfSpan('rainOcclusionBlock');
    renderer.setRenderTarget(this.rainOcclusionBlockTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.mainScene, this.mainCamera);
    this._endPerfSpan(perfToken);

    } finally {
      for (const entry of blockUniformOverrides) {
        if (entry?.object && entry.key === 'opacity') entry.object.opacity = entry.value;
        if (entry?.uniform) entry.uniform.value = entry.value;
      }
      for (const entry of visUniformOverrides) {
        if (entry?.object && entry.key === 'opacity') entry.object.opacity = entry.value;
        if (entry?.uniform) entry.uniform.value = entry.value;
      }
      for (const entry of overrides) {
        if (entry?.object) entry.object.visible = entry.visible;
      }
      scope.restore();
      this.mainCamera.layers.mask = prevMask;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    this._tileMotionManager = null;
    this._renderBus = null;
    this._floorStates.clear();
    if (this.roofTarget) {
      this.roofTarget.dispose();
      this.roofTarget = null;
    }
    if (this.roofBlockTarget) {
      this.roofBlockTarget.dispose();
      this.roofBlockTarget = null;
    }
    if (this.roofVisibilityTarget) {
      this.roofVisibilityTarget.dispose();
      this.roofVisibilityTarget = null;
    }
    if (this.roofRestrictLightTarget) {
      this.roofRestrictLightTarget.dispose();
      this.roofRestrictLightTarget = null;
    }
    if (this.rainOcclusionVisibilityTarget) {
      this.rainOcclusionVisibilityTarget.dispose();
      this.rainOcclusionVisibilityTarget = null;
    }
    if (this.rainOcclusionBlockTarget) {
      this.rainOcclusionBlockTarget.dispose();
      this.rainOcclusionBlockTarget = null;
    }
    if (this.shadowTarget) {
      this.shadowTarget.dispose();
      this.shadowTarget = null;
    }
    if (this.fluidRoofTarget) {
      this.fluidRoofTarget.dispose();
      this.fluidRoofTarget = null;
    }
    if (this.tileProjectionTarget) {
      this.tileProjectionTarget.dispose();
      this.tileProjectionTarget = null;
    }
    if (this.tileProjectionSortTarget) {
      this.tileProjectionSortTarget.dispose();
      this.tileProjectionSortTarget = null;
    }
    if (this.tileReceiverAlphaTarget) {
      this.tileReceiverAlphaTarget.dispose();
      this.tileReceiverAlphaTarget = null;
    }
    if (this.tileReceiverSortTarget) {
      this.tileReceiverSortTarget.dispose();
      this.tileReceiverSortTarget = null;
    }
    for (const key of ['roofBlurredTarget', 'tileProjectionBlurredTarget', 'fluidRoofBlurredTarget']) {
      if (this[key]) {
        this[key].dispose();
        this[key] = null;
      }
    }
    this._maskBlur?.dispose?.();
    this._tileProjectionPass?.dispose?.();
    this._maskCapturePass?.dispose?.();
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this._whiteMaskPlaceholder) {
      try { this._whiteMaskPlaceholder.dispose(); } catch (_) {}
      this._whiteMaskPlaceholder = null;
    }
    if (this.shadowMesh && this.shadowScene) {
      this.shadowScene.remove(this.shadowMesh);
      this.shadowMesh = null;
    }
    this.shadowScene = null;
    log.info('OverheadStampEffect disposed');
  }
}
