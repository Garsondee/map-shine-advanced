/**
 * @fileoverview PaintedShadowEffectV2
 *
 * Projects authored `_Shadow` mask data along sun direction and outputs a
 * scene-space lit factor texture (1 = lit, 0 = shadowed).
 * Shadow contribution is gated by `_Outdoors` so interiors remain unaffected.
 *
 * LightingEffectV2 recomposes this factor separately from cloud/building/overhead
 * so dynamic-light shadow lift and cloud ambient influence do not erase painted
 * shadow on outdoor pixels (same RT as ShadowManagerV2 `tPaintedShadow`).
 *
 * Blur: optional `_sharpHoldTarget` snapshot + invert merge (see `contactShadowPreserve`)
 * matches {@link BuildingShadowsEffectV2} so separable blur does not eat contact edges.
 *
 * Internal render targets use the same half-res budgeting as building shadows to keep
 * the project + separable blur chain from burning fill rate on very large mask textures.
 *
 * Render cadence mirrors {@link BuildingShadowsEffectV2}: hard/soft dirty detection with
 * throttled refresh when sun or dynamic-light inputs drift slowly.
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { loadAssetBundle, loadTexture, probeMaskFile } from '../../assets/loader.js';
import { getViewedLevelBackgroundSrc } from '../../foundry/levels-scene-flags.js';
import { getMaskTextureManifest, maskTextureManifestMatchesLoadContext } from '../../settings/mask-manifest-flags.js';
import { collectCompositorFloorCandidateKeys, resolveCompositorFloorMaskTexture, resolveCompositorOutdoorsTexture } from '../../masks/resolve-compositor-outdoors.js';
import { FLOOR_ID_OUTDOORS_RECEIVER_GLSL } from '../shadow-system/DirectionalShadowProjector.js';
import {
  resolveEffectShadowSun2D,
  writeEffectSunDir,
} from '../shadow-system/ShadowSunDirection.js';
import { resolveBakeRayLength } from '../lightning/shadow-bake-override.js';
import { createMaskStatusSchemaGroup, refreshEffectMaskStatusUi } from '../../ui/effect-mask-status.js';

const log = createLogger('PaintedShadowEffectV2');
/** Align with BuildingShadowsEffectV2 — painted shadow is low-frequency after blur. */
const MAX_PAINTED_SHADOW_EDGE_PX = 2560;
/** Same idea as BuildingShadowsEffectV2: separable blur + invert are fill-rate heavy; half-res RT is visually equivalent on most scenes. */
const INTERNAL_PAINTED_SHADOW_DOWNSAMPLE = 0.5;
const PAINTED_SHADOW_VIEW_BOUNDS_QUANTIZE = 24;
const PAINTED_SHADOW_DRIVER_EPS = 0.002;
const PAINTED_SHADOW_SUN_EPS_DEG = 0.1;
/** Throttle dynamic-light coupling (texture.version bumps every lighting frame). */
const PAINTED_SHADOW_THROTTLE_DYNAMIC_MS = 50;
const PAINTED_SHADOW_THROTTLE_STATIC_MS = 400;
const PAINTED_SHADOW_SAFETY_DYNAMIC_MS = 1000;
const PAINTED_SHADOW_SAFETY_STATIC_MS = 3000;
const PAINTED_MASK_ALIASES = ['handPaintedShadow', 'paintedShadow', 'shadow'];

export class PaintedShadowEffectV2 {
  constructor() {
    this.params = {
      enabled: true,
      opacity: 0.5,
      /** Multiplier on projected shadow strength after opacity (1 = legacy, up to 10 = much deeper). */
      shadowStrengthBoost: 1,
      length: 0.075,
      blurRadius: 4,
      /** 1 = keep full strength at mask contact; fringe uses blurred field. 0 = legacy uniform blur. */
      contactShadowPreserve: 1,
      contactSharpBlendLow: 0.04,
      contactSharpBlendHigh: 0.78,
      /** Grow shadow coverage in shadow RT pixels (max-filter); hides rim at footprint. */
      shadowEdgeInflatePx: 1.25,
      resolutionScale: 1,
      sunLatitude: 0.1,
      dynamicLightShadowOverrideEnabled: true,
      dynamicLightShadowOverrideStrength: 0.7,
    };

    this.renderer = null;
    this._scene = null;
    this._camera = null;
    this._quad = null;
    this._projectMaterial = null;
    this._invertMaterial = null;
    this._blurMaterial = null;
    this._copyMaterial = null;
    this._strengthTarget = null;
    this._blurTarget = null;
    /** @type {import('three').WebGLRenderTarget|null} Pre-blur strength snapshot when contactShadowPreserve > 0 */
    this._sharpHoldTarget = null;
    this.shadowTarget = null;
    this.sunDir = null;
    this._sunAzimuthDeg = null;
    this._sunElevationDeg = null;
    this._loggedMissingOutdoorsMask = false;
    /** @type {import('three').Texture|null} Same _Outdoors as Building/Overhead — pushed by FloorCompositor._syncOutdoorsMaskConsumers */
    this._outdoorsMask = null;
    this._dynamicLightOverride = null;
    this._healthDiagnostics = null;
    /** @type {{ texture:any, resolvedKey:string|null, maskType:string|null, route:string|null, candidateKeysAttempted:string[] }|null} */
    this._lastPaintGpuResolve = null;
    /** @type {string|null} */
    this._lastPaintedSourceSig = null;
    /** @type {Map<string, import('three').Texture|null>} */
    this._paintedBundleByBasePath = new Map();
    /** @type {Set<string>} */
    this._paintedBundleLoadsInFlight = new Set();
    /** @type {Map<string, number>} */
    this._paintedBundleLastAttemptMs = new Map();
    /** @type {Set<string>} Base paths with no `_Shadow` on disk (skip re-probing). */
    this._paintedBundleMissPaths = new Set();
    /** @type {(import('three').Texture|null)[]} */
    this._paintedMasks = [null, null, null, null];
    /** @type {(import('three').Texture|null)[]} Per-level lit pass masks (bundle-first, never ground-dup). */
    this._litFloorMasks = [null, null, null, null];
    /** @type {(import('three').Texture|null)[]} */
    this._outdoorsMasks = [null, null, null, null];
    /** @type {import('three').Texture|null} */
    this._floorIdTex = null;
    /** @type {import('three').Texture|null} */
    this._noShadowFallbackTex = null;
    /** @type {{ receiverBaseIndex?: number, activeFloorAlpha?: import('three').Texture|null, upperFloorAlphaCompositeTexture?: import('three').Texture|null, upperFloorAlphaTextures?: import('three').Texture[] }|null} */
    this._driverMasksSnapshot = null;
    this._driverShadowLengthScale = 1.0;
    this._driverShadowSoftnessScale = 1.0;
    /** @type {import('three').WebGLRenderTarget|null} */
    this._floorOcclusionTarget = null;
    /** @type {import('three').ShaderMaterial|null} */
    this._levelAlphaMaterial = null;
    /** @type {import('three').ShaderMaterial|null} */
    this._floorAlphaOcclusionMaterial = null;
    /** @type {Map<string, import('three').Texture|null>} */
    this._levelTextureCache = new Map();
    /** @type {Map<string, Promise<import('three').Texture|null>>} */
    this._levelTextureInflight = new Map();
    /** @type {string} */
    this._floorOcclusionSig = '';
    /** @type {import('three').WebGLRenderTarget|null} Scratch lit RT for per-level receiver-only painted shadow. */
    this._litScratchTarget = null;
    /** @type {import('three').WebGLRenderTarget|null} Floor-0-only lit (multi-floor ground level pass). */
    this._groundOnlyLitTarget = null;
    /** @type {(import('three').WebGLRenderTarget|null)[]} Cached lit factor per receiver floor — filled in {@link render} so {@link renderLitForSingleFloor} skips redundant blur pipelines. */
    this._perFloorLitTargets = [null, null, null, null];
    /** Serialized each {@link render}; compared in {@link renderLitForSingleFloor}. */
    this._perFloorLitCacheSerial = 0;
    /** @type {number[]} When index matches `_perFloorLitCacheSerial`, {@link renderLitForSingleFloor} returns {@link _perFloorLitTargets} without re-render. */
    this._perFloorLitLastFillSerial = [0, 0, 0, 0];
    /** @type {import('three').Texture|null} Resolved painted tex from the latest {@link render}. */
    this._lastPaintedTexForSlots = null;

    /** @type {Record<string, unknown>} Last-seen UI params (dirty detection). */
    this._lastParams = {};
    /** @type {object} Inputs that affect shadow RTs; drives cache + throttle. */
    this._renderState = {
      time: 0,
      sunAz: null,
      sunEl: null,
      driverLen: null,
      driverSoft: null,
      rtWidth: 0,
      rtHeight: 0,
      bandSig: '',
      floorIdUuid: null,
      paintedUuid0: null,
      paintedUuid1: null,
      paintedUuid2: null,
      paintedUuid3: null,
      outdoorsUuid0: null,
      outdoorsUuid1: null,
      outdoorsUuid2: null,
      outdoorsUuid3: null,
      litMaskUuid0: null,
      litMaskUuid1: null,
      litMaskUuid2: null,
      litMaskUuid3: null,
      hasLitMask0: 0,
      hasLitMask1: 0,
      hasLitMask2: 0,
      hasLitMask3: 0,
      dynTexVersion: -1,
      winTexVersion: -1,
      dloStrength: -1,
      dloEnabled: null,
      vbX: 0,
      vbY: 0,
      vbZ: 0,
      vbW: 0,
      srX: 0,
      srY: 0,
      srZ: 0,
      srW: 0,
      sdimX: 0,
      sdimY: 0,
    };
  }

  /** @returns {import('three').Texture|null} Floor-0-only lit factor (multi-floor level 0 pass). */
  get groundOnlyLitTexture() {
    return this._groundOnlyLitTarget?.texture ?? null;
  }

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Painted Shadows',
        summary: [
          'Projects hand-painted _Shadow masks along the sun direction into a scene-space lit-factor texture.',
          'Outdoor pixels only — gated by the same _Outdoors mask Building Shadows uses.',
          'Multi-floor maps stack per-floor _Shadow slots; bundle fallback loads per-level art when compositor slots are empty.',
        ].join('\n\n'),
      },
      groups: [
        createMaskStatusSchemaGroup('handPaintedShadow'),
        {
          name: 'main',
          label: 'Painted Shadows',
          type: 'inline',
          parameters: [
            'opacity',
            'shadowStrengthBoost',
            'length',
            'blurRadius',
            'contactShadowPreserve',
            'contactSharpBlendLow',
            'contactSharpBlendHigh',
            'shadowEdgeInflatePx',
            'resolutionScale',
          ],
        },
      ],
      parameters: {
        opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        shadowStrengthBoost: {
          type: 'slider',
          label: 'Strength boost',
          min: 1.0,
          max: 10.0,
          step: 0.05,
          default: 1,
          tooltip: 'Extra darkening beyond opacity (×1 matches older behavior; use up to ×10 when shadows look too faint).',
        },
        length: { type: 'slider', label: 'Length', min: 0.0, max: 0.6, step: 0.005, default: 0.075 },
        blurRadius: { type: 'slider', label: 'Blur', min: 0.0, max: 4.0, step: 0.05, default: 4 },
        contactShadowPreserve: {
          type: 'slider',
          label: 'Contact preserve',
          min: 0.0,
          max: 1.0,
          step: 0.02,
          default: 1,
          tooltip:
            'Blurs outward without eating the caster edge: merges pre-blur strength where shadow is darkest, full blur where it fades.',
          advanced: true,
        },
        contactSharpBlendLow: {
          type: 'slider',
          label: 'Contact blend (low)',
          min: 0.0,
          max: 0.35,
          step: 0.005,
          default: 0.04,
          tooltip:
            'Lower bound for where pre-blur strength starts to dominate. Raise slightly if fringe looks too crunchy.',
          advanced: true,
        },
        contactSharpBlendHigh: {
          type: 'slider',
          label: 'Contact blend (high)',
          min: 0.2,
          max: 0.98,
          step: 0.01,
          default: 0.78,
          tooltip:
            'Upper bound toward full contact sharpness inside the silhouette. Lower to pull softness closer to walls.',
          advanced: true,
        },
        shadowEdgeInflatePx: {
          type: 'slider',
          label: 'Edge inflate (px)',
          min: 0.0,
          max: 8.0,
          step: 0.05,
          default: 1.25,
          tooltip:
            'Expands painted shadow slightly in this pass’s pixel grid (often lower-res than canvas) so it tucks under assets and hides bright rim cracks. 0 = off.',
          advanced: true,
        },
        resolutionScale: { type: 'slider', label: 'Resolution', min: 0.75, max: 2.0, step: 0.05, default: 1, advanced: true },
      },
    };
  }

  get shadowFactorTexture() {
    return this.shadowTarget?.texture ?? null;
  }

  /**
   * Lit factor for a single floor mask + outdoors (no floor-id or level-alpha gating).
   * Lighting multiplies by level albedo alpha so holes stay transparent for composite.
   * @param {import('three').WebGLRenderer} renderer
   * @param {number} floorIndex
   * @param {import('three').WebGLRenderTarget} litTarget
   * @returns {import('three').Texture|null}
   * @private
   */
  _renderSingleFloorLit(renderer, floorIndex, litTarget) {
    if (!renderer || !this._projectMaterial || !litTarget) {
      return this.shadowFactorTexture ?? null;
    }
    const idx = Math.max(0, Math.min(3, Math.floor(Number(floorIndex))));
    if (!Number.isFinite(idx)) return this.shadowFactorTexture ?? null;
    if (this._lastPaintedTexForSlots) {
      this._rebuildLitFloorMasks(this._lastPaintedTexForSlots);
    }
    if (!this._hasValidLitMask(idx)) {
      const prev = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      try {
        renderer.setRenderTarget(litTarget);
        renderer.setClearColor(0xffffff, 1.0);
        renderer.clear();
        renderer.autoClear = false;
      } finally {
        renderer.autoClear = prevAuto;
        renderer.setRenderTarget(prev);
      }
      return litTarget.texture ?? null;
    }

    const pu = this._projectMaterial.uniforms;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevFloorIdx = pu.uPaintedFloorIndex.value;
    const prevRecvIdx = pu.uReceiverFloorIndex.value;
    const prevRecvAlpha = pu.tReceiverLevelAlpha.value;
    const prevHasRecvAlpha = pu.uHasReceiverLevelAlpha.value;
    try {
      this._bindLitFloorMaskSlotsToProjectUniforms(pu);
      pu.uReceiverFloorIndex.value = idx;
      pu.uPaintedFloorIndex.value = -1.0;
      pu.tReceiverLevelAlpha.value = null;
      pu.uHasReceiverLevelAlpha.value = 0.0;
      renderer.autoClear = false;
      this._renderStrengthToLitTarget(renderer, litTarget);
      return litTarget.texture ?? null;
    } finally {
      pu.uReceiverFloorIndex.value = prevRecvIdx;
      pu.uPaintedFloorIndex.value = prevFloorIdx;
      pu.tReceiverLevelAlpha.value = prevRecvAlpha;
      pu.uHasReceiverLevelAlpha.value = prevHasRecvAlpha;
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {number} floorIndex
   * @returns {import('three').Texture|null}
   */
  renderLitForSingleFloor(renderer, floorIndex) {
    const idx = Math.max(0, Math.min(3, Math.floor(Number(floorIndex))));
    if (
      idx >= 1
      && this._perFloorLitLastFillSerial[idx] === this._perFloorLitCacheSerial
      && this._perFloorLitTargets[idx]?.texture
    ) {
      return this._perFloorLitTargets[idx].texture;
    }
    if (!this._litScratchTarget) return this.shadowFactorTexture ?? null;
    return this._renderSingleFloorLit(renderer, floorIndex, this._litScratchTarget);
  }

  /** @deprecated Use {@link renderLitForSingleFloor} */
  renderLitThroughFloor(renderer, receiverFloorIndex) {
    return this.renderLitForSingleFloor(renderer, receiverFloorIndex);
  }

  /** @deprecated Use {@link renderLitForSingleFloor} */
  renderLitForFloor(renderer, floorIndex) {
    return this.renderLitForSingleFloor(renderer, floorIndex);
  }

  setSunAngles(azimuthDeg, elevationDeg) {
    this._sunAzimuthDeg = Number.isFinite(Number(azimuthDeg)) ? Number(azimuthDeg) : null;
    this._sunElevationDeg = Number.isFinite(Number(elevationDeg)) ? Number(elevationDeg) : null;
  }

  setDynamicLightOverride(payload = null) {
    this._dynamicLightOverride = payload && typeof payload === 'object' ? payload : null;
  }

  setDriver(driverState = null) {
    if (!driverState) return;
    this.setSunAngles(driverState.sun?.azimuthDeg, driverState.sun?.elevationDeg);
    this.setDynamicLightOverride(driverState.dynamicLightOverride ?? null);
    const m = driverState.masks;
    this._driverMasksSnapshot = m
      ? {
        receiverBaseIndex: m.receiverBaseIndex,
        activeFloorAlpha: m.activeFloorAlpha ?? null,
        upperFloorAlphaCompositeTexture: m.upperFloorAlphaCompositeTexture ?? null,
        upperFloorAlphaTextures: Array.isArray(m.upperFloorAlphaTextures) ? m.upperFloorAlphaTextures.slice() : [],
      }
      : null;
    if (Number.isFinite(Number(driverState.tuning?.shadowSoftnessScale))) {
      this._driverShadowSoftnessScale = Number(driverState.tuning.shadowSoftnessScale);
    }
    if (Number.isFinite(Number(driverState.tuning?.shadowLengthScale))) {
      this._driverShadowLengthScale = Number(driverState.tuning.shadowLengthScale);
    }
  }

  /**
   * Active-floor _Outdoors from FloorCompositor (same path as BuildingShadowsEffectV2 / OverheadShadowsEffectV2).
   * @param {import('three').Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
  }

  /**
   * Match {@link FloorCompositor#_resolveOutdoorsMask}: same skipGround /
   * bundle rules as GpuSceneMaskCompositor resolution (not PaintedShadow-specific
   * shortcuts). Prefer this over syncing `_outdoorsMask` alone so the viewed band's
   * _Outdoors tracks live FloorStack + compositor caches even when the sync path skips.
   * @returns {import('three').Texture|null}
   * @private
   */
  _resolveLiveCompositorOutdoorsTexture() {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    if (!compositor || typeof compositor.getFloorTexture !== 'function') return null;
    let floorStackFloors = [];
    try {
      floorStackFloors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    } catch (_) {
      floorStackFloors = [];
    }
    const skipGroundGlobalFallback = floorStackFloors.length > 1;
    let compositorHasFloorMasks = false;
    try {
      const cacheSize = Number(compositor?._floorCache?.size ?? 0);
      const metaSize = Number(compositor?._floorMeta?.size ?? 0);
      compositorHasFloorMasks = (cacheSize > 0) || (metaSize > 0);
    } catch (_) {
      compositorHasFloorMasks = false;
    }
    const allowBundleFallback = !skipGroundGlobalFallback || !compositorHasFloorMasks;
    const ctx = window.MapShine?.activeLevelContext ?? null;
    return resolveCompositorOutdoorsTexture(compositor, ctx, {
      skipGroundFallback: skipGroundGlobalFallback,
      allowBundleFallback,
      // Painted shadow should gate by the currently viewed band's outdoors only.
      // Borrowing sibling/lower-floor outdoors causes stale-looking floor switches.
      strictViewedFloorOnly: true,
    }).texture ?? null;
  }

  /**
   * Multi-floor scenes must not use scene-global fallback _Shadow (bundle/registry).
   * If per-floor compositor keys have no painted mask yet, fail closed (null) instead
   * of latching one global texture across level changes.
   * @returns {boolean}
   */
  _disableGlobalPaintedFallbackForMultiFloor() {
    let floorStackFloors = [];
    try {
      floorStackFloors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    } catch (_) {
      floorStackFloors = [];
    }
    const af = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const idx = Number(af?.index);
    return floorStackFloors.length > 1 && Number.isFinite(idx) && idx >= 0;
  }

  _resolveViewedLevelBasePath() {
    try {
      const sc = window.MapShine?.sceneComposer ?? null;
      const scene = canvas?.scene ?? null;
      if (!sc || !scene || typeof sc.extractBasePath !== 'function') return null;
      const viewedSrc = getViewedLevelBackgroundSrc(scene);
      if (!viewedSrc) return null;
      const basePath = sc.extractBasePath(viewedSrc);
      return (typeof basePath === 'string' && basePath.trim()) ? basePath.trim() : null;
    } catch (_) {
      return null;
    }
  }

  _resolveBasePathForFloorIndex(floorIndex) {
    try {
      const sc = window.MapShine?.sceneComposer ?? null;
      const scene = canvas?.scene ?? null;
      if (!sc || !scene || typeof sc.extractBasePath !== 'function') return null;
      const levels = scene?.levels?.sorted ?? scene?.levels?.contents ?? [];
      const target = levels.find((l) => Number(l?.index) === Number(floorIndex)) ?? null;
      const bgSrc = target?.background?.src ?? null;
      if (typeof bgSrc !== 'string' || !bgSrc.trim()) return null;
      const bp = sc.extractBasePath(bgSrc.trim());
      return (typeof bp === 'string' && bp.trim()) ? bp.trim() : null;
    } catch (_) {
      return null;
    }
  }

  _resolveViewedLevelShadowProbeInfo() {
    try {
      const scene = canvas?.scene ?? null;
      const viewedSrc = getViewedLevelBackgroundSrc(scene);
      const ext = (() => {
        const s = String(viewedSrc || '');
        const noQuery = s.split('?')[0];
        const dot = noQuery.lastIndexOf('.');
        return dot >= 0 ? noQuery.slice(dot + 1).toLowerCase() : 'webp';
      })();
      return {
        viewedSrc: viewedSrc || null,
        ext: ext || 'webp',
      };
    } catch (_) {
      return { viewedSrc: null, ext: 'webp' };
    }
  }

  /**
   * @param {number} floorIndex
   * @returns {{ bottom: number, top: number }|null}
   * @private
   */
  _levelContextForFloorIndex(floorIndex) {
    try {
      const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      const floor = floors.find((f) => Number(f?.index) === Number(floorIndex)) ?? null;
      if (!floor) return window.MapShine?.activeLevelContext ?? null;
      const bottom = Number(floor.elevationMin);
      const top = Number(floor.elevationMax);
      if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;
      return { bottom, top };
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {number} floorIndex
   * @returns {{ viewedSrc: string|null, ext: string }}
   * @private
   */
  _resolveShadowProbeInfoForFloorIndex(floorIndex) {
    try {
      const scene = canvas?.scene ?? null;
      const levels = scene?.levels?.sorted ?? scene?.levels?.contents ?? [];
      const target = levels.find((l) => Number(l?.index) === Number(floorIndex)) ?? null;
      const bgSrc = target?.background?.src ?? null;
      if (typeof bgSrc !== 'string' || !bgSrc.trim()) {
        return this._resolveViewedLevelShadowProbeInfo();
      }
      const s = bgSrc.trim();
      const noQuery = s.split('?')[0];
      const dot = noQuery.lastIndexOf('.');
      const ext = dot >= 0 ? noQuery.slice(dot + 1).toLowerCase() : 'webp';
      return { viewedSrc: s, ext: ext || 'webp' };
    } catch (_) {
      return this._resolveViewedLevelShadowProbeInfo();
    }
  }

  /**
   * @param {{ compositorKey?: string, index?: number }|null|undefined} floor
   * @param {*} compositor
   * @returns {import('three').Texture|null}
   * @private
   */
  _resolveCompositorPaintedMaskForFloor(floor, compositor) {
    const key = floor?.compositorKey;
    const idx = Number(floor?.index);
    if (!compositor || !key) return null;
    const lvlCtx = this._levelContextForFloorIndex(idx);
    const gpu = resolveCompositorFloorMaskTexture(compositor, PAINTED_MASK_ALIASES, lvlCtx);
    if (gpu?.texture) return gpu.texture;
    return (
      compositor.getFloorTexture?.(key, 'handPaintedShadow')
      ?? compositor.getFloorTexture?.(key, 'paintedShadow')
      ?? compositor.getFloorTexture?.(key, 'shadow')
      ?? null
    );
  }

  async _probePaintedShadowTextureForBasePath(basePath, floorIndex = null) {
    if (!basePath) return null;
    const info = Number.isFinite(Number(floorIndex))
      ? this._resolveShadowProbeInfoForFloorIndex(Number(floorIndex))
      : this._resolveViewedLevelShadowProbeInfo();
    // Prefer authoritative scene manifest path for handPaintedShadow when available.
    try {
      const scene = canvas?.scene ?? null;
      const flag = getMaskTextureManifest(scene);
      const maskSourceSrc = info.viewedSrc ?? null;
      if (flag && maskTextureManifestMatchesLoadContext(flag, basePath, maskSourceSrc)) {
        const p = flag?.pathsByMaskId?.handPaintedShadow
          ?? flag?.pathsByMaskId?.handpaintedshadow
          ?? null;
        if (typeof p === 'string' && p.trim()) {
          const tex = await loadTexture(p.trim(), { suppressProbeErrors: true });
          if (tex) return tex;
        }
      }
    } catch (_) {}

    const suffixes = ['_Shadow', '_shadow'];
    const extCandidates = [];
    const pushExt = (e) => {
      const s = String(e || '').toLowerCase().replace(/^\./, '');
      if (!s || extCandidates.includes(s)) return;
      extCandidates.push(s);
    };
    pushExt(info.ext);
    pushExt('webp');
    pushExt('png');
    pushExt('jpg');
    pushExt('jpeg');

    for (const suffix of suffixes) {
      const probed = await probeMaskFile(basePath, suffix, { allowConventionProbe: false });
      const resolvedPath = probed?.path ?? null;
      if (!resolvedPath) continue;
      try {
        const tex = await loadTexture(resolvedPath, { suppressProbeErrors: true });
        if (tex) return tex;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Load per-level `_Shadow` from bundle when compositor slot is empty or ground-duplicated.
   * @param {number} floorIndex
   * @param {string} [groundMaskUuid]
   * @returns {boolean} True when a non-ground mask was assigned.
   * @private
   */
  _tryAssignPaintedBundleMaskForFloor(floorIndex, groundMaskUuid = null) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return false;
    const floorBasePath = this._resolveBasePathForFloorIndex(idx);
    if (!floorBasePath) return false;
    const cached = this._paintedBundleByBasePath.get(floorBasePath) ?? null;
    if (!this._paintedBundleByBasePath.has(floorBasePath) || cached == null) {
      this._schedulePaintedBundleLoadForBasePath(floorBasePath, idx);
    }
    if (!cached?.uuid) return false;
    if (groundMaskUuid && cached.uuid === groundMaskUuid) return false;
    this._paintedMasks[idx] = cached;
    return true;
  }

  /**
   * @param {import('three').Texture|null} paintedTex
   * @private
   */
  _rebuildLitFloorMasks(paintedTex) {
    const noShadow = this._noShadowFallbackTex;
    const groundUuid = (this._paintedMasks[0] ?? paintedTex)?.uuid ?? null;
    this._litFloorMasks = [null, null, null, null];
    for (let idx = 0; idx < 4; idx++) {
      if (idx === 0) {
        this._litFloorMasks[0] = this._paintedMasks[0] ?? paintedTex ?? noShadow ?? null;
        continue;
      }
      const bundleMask = this._getDistinctBundleMaskForFloor(idx, groundUuid);
      if (bundleMask) {
        this._litFloorMasks[idx] = bundleMask;
        continue;
      }
      const compositorMask = this._paintedMasks[idx] ?? null;
      if (compositorMask?.uuid && compositorMask.uuid !== groundUuid) {
        this._litFloorMasks[idx] = compositorMask;
        continue;
      }
      this._litFloorMasks[idx] = null;
    }
  }

  /**
   * @param {number} floorIndex
   * @param {string|null} groundMaskUuid
   * @returns {import('three').Texture|null}
   * @private
   */
  _getDistinctBundleMaskForFloor(floorIndex, groundMaskUuid) {
    const floorBasePath = this._resolveBasePathForFloorIndex(floorIndex);
    if (!floorBasePath) return null;
    const cached = this._paintedBundleByBasePath.get(floorBasePath) ?? null;
    if (cached?.uuid && (!groundMaskUuid || cached.uuid !== groundMaskUuid)) {
      return cached;
    }
    if (!this._paintedBundleByBasePath.has(floorBasePath) || cached == null) {
      this._schedulePaintedBundleLoadForBasePath(floorBasePath, floorIndex);
    }
    return null;
  }

  /** @private */
  _primePaintedBundleLoadsForAllFloors() {
    for (let idx = 1; idx < 4; idx++) {
      const floorBasePath = this._resolveBasePathForFloorIndex(idx);
      if (floorBasePath) this._schedulePaintedBundleLoadForBasePath(floorBasePath, idx);
    }
  }

  _schedulePaintedBundleLoadForBasePath(basePath, floorIndex = null) {
    if (!basePath || this._paintedBundleLoadsInFlight.has(basePath)) return;
    if (this._paintedBundleMissPaths.has(basePath)) return;
    const now = Date.now();
    const last = Number(this._paintedBundleLastAttemptMs.get(basePath) ?? 0);
    if (last > 0 && (now - last) < 1200) return;
    this._paintedBundleLastAttemptMs.set(basePath, now);
    this._paintedBundleLoadsInFlight.add(basePath);
    const run = async () => {
      try {
        const directTex = await this._probePaintedShadowTextureForBasePath(basePath, floorIndex);
        if (directTex) {
          this._paintedBundleByBasePath.set(basePath, directTex);
          this._applyLoadedPaintedBundleForBasePath(basePath);
          return;
        }
        const probed = await probeMaskFile(basePath, '_Shadow', { allowConventionProbe: false });
        if (!probed?.path) {
          this._paintedBundleByBasePath.set(basePath, null);
          this._paintedBundleMissPaths.add(basePath);
          return;
        }
        const result = await loadAssetBundle(basePath, null, {
          skipBaseTexture: true,
          suppressProbeErrors: true,
          bypassCache: true,
          maskIds: ['handPaintedShadow'],
          allowConventionProbe: true,
          maskConventionFallback: 'full',
        });
        const masks = result?.bundle?.masks ?? [];
        const hit = Array.isArray(masks)
          ? masks.find((m) => {
            const id = String(m?.id ?? m?.type ?? '').toLowerCase();
            const suffix = String(m?.suffix ?? '').toLowerCase();
            return id.includes('shadow') || suffix === '_shadow';
          })
          : null;
        const bundleTex = hit?.texture ?? null;
        this._paintedBundleByBasePath.set(basePath, bundleTex);
        if (bundleTex) this._applyLoadedPaintedBundleForBasePath(basePath);
        if (!bundleTex) this._paintedBundleMissPaths.add(basePath);
      } catch (_) {
        this._paintedBundleByBasePath.set(basePath, null);
        this._paintedBundleMissPaths.add(basePath);
      } finally {
        this._paintedBundleLoadsInFlight.delete(basePath);
        try { refreshEffectMaskStatusUi('painted-shadows'); } catch (_) {}
      }
    };
    void run();
  }

  /** @param {string} basePath @private */
  _applyLoadedPaintedBundleForBasePath(basePath) {
    if (!basePath) return;
    const groundUuid = this._paintedMasks[0]?.uuid ?? null;
    for (let idx = 0; idx < 4; idx += 1) {
      const floorBasePath = this._resolveBasePathForFloorIndex(idx);
      if (floorBasePath !== basePath) continue;
      this._tryAssignPaintedBundleMaskForFloor(idx, idx === 0 ? null : groundUuid);
    }
    try { refreshEffectMaskStatusUi('painted-shadows'); } catch (_) {}
  }

  /**
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _hasValidLitMask(floorIndex) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return false;
    const mask = this._litFloorMasks?.[idx] ?? null;
    const noShadow = this._noShadowFallbackTex;
    if (!mask || !noShadow) return false;
    return mask !== noShadow && mask.uuid !== noShadow.uuid;
  }

  /**
   * @param {Record<string, { value: any }>} pu
   * @private
   */
  _syncLitMaskUniformsOnly(pu) {
    for (let i = 0; i < 4; i++) {
      pu[`uHasLitMask${i}`].value = this._hasValidLitMask(i) ? 1.0 : 0.0;
    }
  }

  /**
   * Binds per-floor lit masks for the cumulative receiver pass (overwrites slot samplers).
   * @param {Record<string, { value: any }>} pu
   * @private
   */
  _bindLitFloorMaskSlotsToProjectUniforms(pu) {
    const noShadow = this._noShadowFallbackTex;
    for (let i = 0; i < 4; i++) {
      const mask = this._litFloorMasks?.[i] ?? noShadow ?? null;
      pu[`tPaintedShadow${i}`].value = mask;
      pu[`uHasLitMask${i}`].value = this._hasValidLitMask(i) ? 1.0 : 0.0;
      pu[`uPainted${i}FlipY`].value = mask?.flipY ? 1.0 : 0.0;
    }
  }

  /**
   * Some scenes author `_Shadow` only as a scene-global bundle mask (no per-floor
   * compositor entries). In that case we must allow bundle fallback even on multi-floor
   * maps, otherwise painted shadow disappears entirely.
   * @param {any} compositor
   * @returns {boolean}
   * @private
   */
  _hasAnyPerFloorPaintedShadow(compositor) {
    if (!compositor) return false;
    const ids = new Set(['handpaintedshadow', 'paintedshadow', 'shadow']);
    const isPainted = (m) => {
      const id = String(m?.id ?? '').toLowerCase();
      const type = String(m?.type ?? '').toLowerCase();
      const suffix = String(m?.suffix ?? '').toLowerCase();
      return ids.has(id) || ids.has(type) || suffix === '_shadow';
    };
    try {
      if (compositor?._floorCache && typeof compositor._floorCache.entries === 'function') {
        for (const [, maskMap] of compositor._floorCache.entries()) {
          if (!maskMap || typeof maskMap.get !== 'function') continue;
          const a = maskMap.get('handPaintedShadow');
          const b = maskMap.get('paintedShadow');
          const c = maskMap.get('shadow');
          if (a?.texture || b?.texture || c?.texture) return true;
        }
      }
    } catch (_) {}
    try {
      if (compositor?._floorMeta && typeof compositor._floorMeta.values === 'function') {
        for (const meta of compositor._floorMeta.values()) {
          const masks = meta?.masks;
          if (!Array.isArray(masks)) continue;
          if (masks.some((m) => isPainted(m) && !!m?.texture)) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  getHealthDiagnostics() {
    return this._healthDiagnostics ? { ...this._healthDiagnostics } : null;
  }

  /**
   * Per-floor painted slot for the per-pixel pass (uPaintedFloorIndex < 0).
   * Only suppress slots that duplicate the ground mask — shared upper-floor UUIDs
   * must stay bound so readPaintedByFloor(N) works for floor-id N pixels.
   * Per-level lighting uses {@link renderLitForFloor} with {@link _litFloorMasks} instead.
   * @param {number} floorIndex
   * @param {import('three').Texture|null} paintedTex
   * @param {import('three').Texture|null} noShadowTex
   * @returns {import('three').Texture|null}
   * @private
   */
  _resolvePaintedSlotTexture(floorIndex, paintedTex, noShadowTex) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0) return noShadowTex ?? null;
    if (idx === 0) {
      return this._paintedMasks[0] ?? paintedTex ?? noShadowTex ?? null;
    }
    const tex = this._paintedMasks[idx] ?? null;
    if (!tex) return noShadowTex ?? null;
    const ground = this._paintedMasks[0] ?? paintedTex ?? null;
    if (ground?.uuid && tex.uuid === ground.uuid) {
      return noShadowTex ?? null;
    }
    return tex;
  }

  initialize(renderer) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;

    if (this._projectMaterial) {
      try { this._projectMaterial.dispose(); } catch (_) {}
      this._projectMaterial = null;
    }
    if (this._invertMaterial) {
      try { this._invertMaterial.dispose(); } catch (_) {}
      this._invertMaterial = null;
    }
    if (this._blurMaterial) {
      try { this._blurMaterial.dispose(); } catch (_) {}
      this._blurMaterial = null;
    }
    if (this._copyMaterial) {
      try { this._copyMaterial.dispose(); } catch (_) {}
      this._copyMaterial = null;
    }

    this.renderer = renderer;
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._projectMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPaintedShadow: { value: null },
        tPaintedShadow0: { value: null },
        tPaintedShadow1: { value: null },
        tPaintedShadow2: { value: null },
        tPaintedShadow3: { value: null },
        tOutdoors: { value: null },
        tOutdoors0: { value: null },
        tOutdoors1: { value: null },
        tOutdoors2: { value: null },
        tOutdoors3: { value: null },
        tFloorIdTex: { value: null },
        uHasPaintedShadow: { value: 0.0 },
        uHasOutdoorsMask: { value: 0.0 },
        uHasFloorIdTex: { value: 0.0 },
        uFloorIdFlipY: { value: 1.0 },
        uPaintedFlipY: { value: 0.0 },
        uOutdoorsFlipY: { value: 0.0 },
        uHasOutdoors0: { value: 0.0 },
        uHasOutdoors1: { value: 0.0 },
        uHasOutdoors2: { value: 0.0 },
        uHasOutdoors3: { value: 0.0 },
        uOutdoors0FlipY: { value: 0.0 },
        uOutdoors1FlipY: { value: 0.0 },
        uOutdoors2FlipY: { value: 0.0 },
        uOutdoors3FlipY: { value: 0.0 },
        uSunDir: { value: new THREE.Vector2(0.0, -1.0) },
        uOpacity: { value: this.params.opacity },
        uShadowStrengthBoost: { value: this.params.shadowStrengthBoost ?? 1 },
        uLength: { value: this.params.length },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        tDynamicLight: { value: null },
        tWindowLight: { value: null },
        uHasDynamicLight: { value: 0.0 },
        uHasWindowLight: { value: 0.0 },
        uDynamicLightShadowOverrideEnabled: { value: 1.0 },
        uDynamicLightShadowOverrideStrength: { value: this.params.dynamicLightShadowOverrideStrength ?? 0.7 },
        uDynViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uDynSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uDynSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uHasDynSceneRect: { value: 0.0 },
        uPaintedFloorIndex: { value: -1.0 },
        uReceiverFloorIndex: { value: -1.0 },
        tReceiverLevelAlpha: { value: null },
        uHasReceiverLevelAlpha: { value: 0.0 },
        uHasLitMask0: { value: 0.0 },
        uHasLitMask1: { value: 0.0 },
        uHasLitMask2: { value: 0.0 },
        uHasLitMask3: { value: 0.0 },
        uPainted0FlipY: { value: 0.0 },
        uPainted1FlipY: { value: 0.0 },
        uPainted2FlipY: { value: 0.0 },
        uPainted3FlipY: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `${FLOOR_ID_OUTDOORS_RECEIVER_GLSL}
        uniform sampler2D tPaintedShadow;
        uniform sampler2D tPaintedShadow0;
        uniform sampler2D tPaintedShadow1;
        uniform sampler2D tPaintedShadow2;
        uniform sampler2D tPaintedShadow3;
        uniform sampler2D tOutdoors;
        uniform sampler2D tOutdoors0;
        uniform sampler2D tOutdoors1;
        uniform sampler2D tOutdoors2;
        uniform sampler2D tOutdoors3;
        uniform sampler2D tFloorIdTex;
        uniform float uHasPaintedShadow;
        uniform float uHasOutdoorsMask;
        uniform float uHasFloorIdTex;
        uniform float uFloorIdFlipY;
        uniform float uHasOutdoors0;
        uniform float uHasOutdoors1;
        uniform float uHasOutdoors2;
        uniform float uHasOutdoors3;
        uniform float uOutdoors0FlipY;
        uniform float uOutdoors1FlipY;
        uniform float uOutdoors2FlipY;
        uniform float uOutdoors3FlipY;
        uniform float uPaintedFlipY;
        uniform float uOutdoorsFlipY;
        uniform vec2 uSunDir;
        uniform float uOpacity;
        uniform float uShadowStrengthBoost;
        uniform float uLength;
        uniform vec2 uSceneDimensions;
        uniform sampler2D tDynamicLight;
        uniform sampler2D tWindowLight;
        uniform float uHasDynamicLight;
        uniform float uHasWindowLight;
        uniform float uDynamicLightShadowOverrideEnabled;
        uniform float uDynamicLightShadowOverrideStrength;
        uniform vec4 uDynViewBounds;
        uniform vec2 uDynSceneDimensions;
        uniform vec4 uDynSceneRect;
        uniform float uHasDynSceneRect;
        uniform float uPaintedFloorIndex;
        uniform float uReceiverFloorIndex;
        uniform sampler2D tReceiverLevelAlpha;
        uniform float uHasReceiverLevelAlpha;
        uniform float uHasLitMask0;
        uniform float uHasLitMask1;
        uniform float uHasLitMask2;
        uniform float uHasLitMask3;
        uniform float uPainted0FlipY;
        uniform float uPainted1FlipY;
        uniform float uPainted2FlipY;
        uniform float uPainted3FlipY;
        varying vec2 vUv;

        float readMaskShadowStrength(sampler2D tex, vec2 uv, float flipY) {
          vec2 suv = clamp(uv, vec2(0.0), vec2(1.0));
          if (flipY > 0.5) suv.y = 1.0 - suv.y;
          vec4 s = texture2D(tex, suv);
          float luma = max(s.r, max(s.g, s.b));
          // _Shadow authoring convention: dark = stronger shadow contribution.
          // Keep alpha as the coverage gate (transparent pixels stay inactive).
          return clamp((1.0 - luma) * s.a, 0.0, 1.0);
        }

        float readFloorIndex(vec2 sceneUvFoundry) {
          if (uHasFloorIdTex < 0.5) return -1.0;
          vec2 fidUv = clamp(sceneUvFoundry, 0.0, 1.0);
          if (uFloorIdFlipY > 0.5) fidUv.y = 1.0 - fidUv.y;
          float fid = texture2D(tFloorIdTex, fidUv).r;
          return floor(fid * 255.0 + 0.5);
        }

        float hasLitMaskForFloor(float floorIdx) {
          if (floorIdx < 0.5) return uHasLitMask0;
          if (floorIdx < 1.5) return uHasLitMask1;
          if (floorIdx < 2.5) return uHasLitMask2;
          return uHasLitMask3;
        }

        float readPaintedByFloor(float floorIdx, vec2 uv) {
          if (floorIdx < 0.0) return readMaskShadowStrength(tPaintedShadow, uv, uPaintedFlipY);
          if (floorIdx < 0.5) return readMaskShadowStrength(tPaintedShadow0, uv, uPainted0FlipY);
          if (floorIdx < 1.5) return readMaskShadowStrength(tPaintedShadow1, uv, uPainted1FlipY);
          if (floorIdx < 2.5) return readMaskShadowStrength(tPaintedShadow2, uv, uPainted2FlipY);
          return readMaskShadowStrength(tPaintedShadow3, uv, uPainted3FlipY);
        }

        vec2 sceneUvToDynScreenUv(vec2 sceneUv) {
          vec2 foundryPos = uDynSceneRect.xy + sceneUv * max(uDynSceneRect.zw, vec2(1e-5));
          vec2 threePos = vec2(foundryPos.x, uDynSceneDimensions.y - foundryPos.y);
          vec2 span = max(uDynViewBounds.zw - uDynViewBounds.xy, vec2(1e-5));
          return (threePos - uDynViewBounds.xy) / span;
        }

        float applyDynamicLightShadowLift(float strength, vec2 sceneUv) {
          if ((uHasDynamicLight < 0.5 && uHasWindowLight < 0.5)
            || uDynamicLightShadowOverrideEnabled < 0.5
            || uHasDynSceneRect < 0.5) {
            return strength;
          }
          vec2 dynUv = clamp(sceneUvToDynScreenUv(sceneUv), vec2(0.0), vec2(1.0));
          float dynI = 0.0;
          if (uHasDynamicLight > 0.5) {
            vec3 dyn = texture2D(tDynamicLight, dynUv).rgb;
            dynI = max(dynI, clamp(max(dyn.r, max(dyn.g, dyn.b)), 0.0, 1.0));
          }
          if (uHasWindowLight > 0.5) {
            vec3 win = texture2D(tWindowLight, sceneUv).rgb;
            dynI = max(dynI, clamp(max(win.r, max(win.g, win.b)), 0.0, 1.0));
          }
          // Linear-HDR _lightRT can carry a nonzero baseline from AmbientLight-style
          // meshes; the legacy 0.02–0.30 band treated that as dynamic and erased
          // painted occlusion before inversion. Prefer a higher knee so only strong
          // local gameplay/window spill lifts hand-authored shadow.
          float dynPresence = smoothstep(0.28, 0.92, dynI);
          float dynLift = clamp(dynPresence * max(uDynamicLightShadowOverrideStrength, 0.0), 0.0, 1.0);
          return mix(strength, 0.0, dynLift);
        }

        float readOutdoorsByFloor(float floorIdx, vec2 uv) {
          if (floorIdx < 0.5) {
            return uHasOutdoors0 > 0.5
              ? msa_readAlphaAwareOutdoors(tOutdoors0, uv, uOutdoors0FlipY)
              : 1.0;
          }
          if (floorIdx < 1.5) {
            return uHasOutdoors1 > 0.5
              ? msa_readAlphaAwareOutdoors(tOutdoors1, uv, uOutdoors1FlipY)
              : 1.0;
          }
          if (floorIdx < 2.5) {
            return uHasOutdoors2 > 0.5
              ? msa_readAlphaAwareOutdoors(tOutdoors2, uv, uOutdoors2FlipY)
              : 1.0;
          }
          return uHasOutdoors3 > 0.5
            ? msa_readAlphaAwareOutdoors(tOutdoors3, uv, uOutdoors3FlipY)
            : 1.0;
        }

        float readOutdoors(vec2 uv) {
          if (uHasFloorIdTex > 0.5) {
            return msa_readFloorIdOutdoors(
              uv,
              tFloorIdTex,
              uHasFloorIdTex,
              uFloorIdFlipY,
              tOutdoors0,
              tOutdoors1,
              tOutdoors2,
              tOutdoors3,
              uHasOutdoors0,
              uHasOutdoors1,
              uHasOutdoors2,
              uHasOutdoors3,
              uOutdoors0FlipY,
              uOutdoors1FlipY,
              uOutdoors2FlipY,
              uOutdoors3FlipY
            );
          }
          vec2 suv = clamp(uv, vec2(0.0), vec2(1.0));
          if (uOutdoorsFlipY > 0.5) suv.y = 1.0 - suv.y;
          vec4 m = texture2D(tOutdoors, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        void main() {
          if (uHasPaintedShadow < 0.5 || uHasOutdoorsMask < 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          vec2 dir = normalize(uSunDir);
          vec2 safeSceneSize = max(uSceneDimensions, vec2(1.0));
          float pixelLen = uLength * 1080.0;
          vec2 offsetUv = dir * (pixelLen / safeSceneSize);
          vec2 casterUv = clamp(vUv + offsetUv, vec2(0.0), vec2(1.0));

          float strength;
          if (uReceiverFloorIndex >= 0.0) {
            float recvIdx = clamp(uReceiverFloorIndex, 0.0, 3.0);
            float litAccum = 1.0;
            if (hasLitMaskForFloor(recvIdx) > 0.5) {
              float paintedF = readPaintedByFloor(recvIdx, casterUv);
              float outdoorsF = readOutdoorsByFloor(recvIdx, vUv);
              float strF = clamp(
                paintedF * clamp(uOpacity, 0.0, 1.0) * outdoorsF * clamp(uShadowStrengthBoost, 1.0, 10.0),
                0.0,
                1.0
              );
              strF = applyDynamicLightShadowLift(strF, vUv);
              litAccum *= (1.0 - strF);
            }
            strength = 1.0 - litAccum;
          } else {
            float painted;
            float outdoors;
            if (uPaintedFloorIndex >= 0.0) {
              float forcedFloor = clamp(uPaintedFloorIndex, 0.0, 3.0);
              painted = readPaintedByFloor(forcedFloor, casterUv);
              outdoors = readOutdoorsByFloor(forcedFloor, vUv);
            } else {
              float floorIdx = readFloorIndex(vUv);
              painted = readPaintedByFloor(floorIdx, casterUv);
              outdoors = readOutdoors(vUv);
            }
            strength = clamp(
              painted * clamp(uOpacity, 0.0, 1.0) * outdoors * clamp(uShadowStrengthBoost, 1.0, 10.0),
              0.0,
              1.0
            );
            strength = applyDynamicLightShadowLift(strength, vUv);
          }
          gl_FragColor = vec4(strength, strength, strength, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._projectMaterial.toneMapped = false;

    this._invertMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tStrength: { value: null },
        tSharpStrength: { value: null },
        uContactShadowPreserve: { value: this.params.contactShadowPreserve ?? 1 },
        uContactSharpBlendLow: { value: this.params.contactSharpBlendLow ?? 0.04 },
        uContactSharpBlendHigh: { value: this.params.contactSharpBlendHigh ?? 0.78 },
        uShadowEdgeInflatePx: { value: this.params.shadowEdgeInflatePx ?? 0 },
        uStrengthTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tStrength;
        uniform sampler2D tSharpStrength;
        uniform float uContactShadowPreserve;
        uniform float uContactSharpBlendLow;
        uniform float uContactSharpBlendHigh;
        uniform float uShadowEdgeInflatePx;
        uniform vec2 uStrengthTexelSize;
        varying vec2 vUv;

        float mergedStrength(vec2 suv) {
          float sBlur = clamp(texture2D(tStrength, suv).r, 0.0, 1.0);
          float sSharp = clamp(texture2D(tSharpStrength, suv).r, 0.0, 1.0);
          float preserve = clamp(uContactShadowPreserve, 0.0, 1.0);
          float lo = min(uContactSharpBlendLow, uContactSharpBlendHigh - 1e-4);
          float hi = max(uContactSharpBlendHigh, lo + 1e-4);
          float edgeW = smoothstep(lo, hi, sSharp);
          return mix(sBlur, sSharp, preserve * edgeW);
        }

        void main() {
          vec2 edge = vec2(0.001);
          vec2 edge2 = vec2(0.999);
          vec2 suv = clamp(vUv, edge, edge2);
          vec2 duv = max(uStrengthTexelSize * max(uShadowEdgeInflatePx, 0.0), vec2(0.0));
          float s = mergedStrength(suv);
          float infl = clamp(uShadowEdgeInflatePx, 0.0, 32.0);
          if (infl > 1e-6) {
            // Separable axis max-filter (5 taps) — visually equivalent to 9-tap diamond for small inflate.
            float sH = max(mergedStrength(clamp(suv - vec2(duv.x, 0.0), edge, edge2)),
              max(s, mergedStrength(clamp(suv + vec2(duv.x, 0.0), edge, edge2))));
            s = max(sH, max(mergedStrength(clamp(suv - vec2(0.0, duv.y), edge, edge2)),
              mergedStrength(clamp(suv + vec2(0.0, duv.y), edge, edge2))));
          }
          float lit = 1.0 - s;
          gl_FragColor = vec4(lit, lit, lit, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._invertMaterial.toneMapped = false;

    this._blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uRadius: { value: this.params.blurRadius },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tInput;
        uniform vec2 uDirection;
        uniform vec2 uTexelSize;
        uniform float uRadius;
        varying vec2 vUv;

        void main() {
          vec2 stepUv = uDirection * uTexelSize * max(uRadius, 0.0);
          float c0 = texture2D(tInput, vUv).r * 0.22702703;
          float c1 = texture2D(tInput, vUv + stepUv * 1.38461538).r * 0.31621622;
          float c2 = texture2D(tInput, vUv - stepUv * 1.38461538).r * 0.31621622;
          float c3 = texture2D(tInput, vUv + stepUv * 3.23076923).r * 0.07027027;
          float c4 = texture2D(tInput, vUv - stepUv * 3.23076923).r * 0.07027027;
          float v = clamp(c0 + c1 + c2 + c3 + c4, 0.0, 1.0);
          gl_FragColor = vec4(v, v, v, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._blurMaterial.toneMapped = false;

    this._copyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tMap: { value: null },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tMap;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(tMap, vUv);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._copyMaterial.toneMapped = false;

    this._levelAlphaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tLevelAlbedo: { value: null },
        uFlipY: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tLevelAlbedo;
        uniform float uFlipY;
        varying vec2 vUv;
        void main() {
          vec2 uv = clamp(vUv, 0.0, 1.0);
          if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
          float a = clamp(texture2D(tLevelAlbedo, uv).a, 0.0, 1.0);
          gl_FragColor = vec4(vec3(a), a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    this._levelAlphaMaterial.toneMapped = false;

    this._floorAlphaOcclusionMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uFlipY: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tInput;
        uniform float uFlipY;
        varying vec2 vUv;
        void main() {
          vec2 uv = clamp(vUv, 0.0, 1.0);
          if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
          float a = clamp(texture2D(tInput, uv).r, 0.0, 1.0);
          gl_FragColor = vec4(vec3(a), a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    this._floorAlphaOcclusionMaterial.toneMapped = false;

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._projectMaterial);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    // Neutral painted-mask fallback: white RGB + alpha 1 => readMaskShadowStrength = 0.
    try {
      const data = new Uint8Array([255, 255, 255, 255]);
      this._noShadowFallbackTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      this._noShadowFallbackTex.needsUpdate = true;
      this._noShadowFallbackTex.flipY = false;
      this._noShadowFallbackTex.generateMipmaps = false;
      this._noShadowFallbackTex.minFilter = THREE.NearestFilter;
      this._noShadowFallbackTex.magFilter = THREE.NearestFilter;
      this._noShadowFallbackTex.name = 'MapShinePaintedShadowNoShadowFallback';
    } catch (_) {
      this._noShadowFallbackTex = null;
    }
  }

  /**
   * Match BuildingShadowsEffectV2 budgeting: clamp longest edge after user scale × internal downsample.
   * Avoids supersampling authored masks toward huge blur chains.
   * @param {number} imgW
   * @param {number} imgH
   * @returns {{ w: number, h: number }}
   * @private
   */
  _computePaintedRtSize(imgW, imgH) {
    const iw = Math.max(1, Math.round(Number(imgW) || 1));
    const ih = Math.max(1, Math.round(Number(imgH) || 1));
    const scaleRaw = Number(this.params.resolutionScale ?? 1);
    const scale = Number.isFinite(scaleRaw) ? Math.min(2.0, Math.max(0.25, scaleRaw)) : 1.0;
    let w = Math.max(1, Math.round(iw * scale * INTERNAL_PAINTED_SHADOW_DOWNSAMPLE));
    let h = Math.max(1, Math.round(ih * scale * INTERNAL_PAINTED_SHADOW_DOWNSAMPLE));
    const maxE = Math.max(w, h);
    if (maxE > MAX_PAINTED_SHADOW_EDGE_PX) {
      const s = MAX_PAINTED_SHADOW_EDGE_PX / maxE;
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    return { w, h };
  }

  /** @private */
  _invalidatePerFloorLitCache() {
    for (let i = 1; i <= 3; i++) this._perFloorLitLastFillSerial[i] = 0;
  }

  /** Force next {@link render} to run GPU passes (e.g. after clearing shadowTarget). */
  _invalidateShadowRenderCache() {
    this._renderState.time = 0;
  }

  /** @param {number} v @param {number} step */
  _quantizeForCache(v, step) {
    if (!Number.isFinite(v) || step <= 0) return 0;
    return Math.round(v / step) * step;
  }

  /** @param {number|null|undefined} a @param {number|null|undefined} b @param {number} eps */
  _numChanged(a, b, eps) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) && !Number.isFinite(nb)) return false;
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return true;
    return Math.abs(na - nb) > eps;
  }

  /**
   * Snap camera view bounds so sub-texel camera jitter does not bust the cache.
   * @param {{x:number,y:number,z:number,w:number}|null|undefined} vb
   * @returns {{x:number,y:number,z:number,w:number}|null}
   */
  _quantizeViewBoundsForCache(vb) {
    if (!vb) return null;
    const step = PAINTED_SHADOW_VIEW_BOUNDS_QUANTIZE;
    return {
      x: this._quantizeForCache(vb.x, step),
      y: this._quantizeForCache(vb.y, step),
      z: this._quantizeForCache(vb.z, step),
      w: this._quantizeForCache(vb.w, step),
    };
  }

  /**
   * @param {number} now
   * @param {object} snap
   */
  _commitRenderState(now, snap) {
    const rs = this._renderState;
    rs.time = now;
    rs.sunAz = snap.sunAz;
    rs.sunEl = snap.sunEl;
    rs.driverLen = snap.driverLen;
    rs.driverSoft = snap.driverSoft;
    rs.rtWidth = snap.rtWidth;
    rs.rtHeight = snap.rtHeight;
    rs.bandSig = snap.bandSig;
    rs.floorIdUuid = snap.floorIdUuid;
    rs.paintedUuid0 = snap.paintedUuid0;
    rs.paintedUuid1 = snap.paintedUuid1;
    rs.paintedUuid2 = snap.paintedUuid2;
    rs.paintedUuid3 = snap.paintedUuid3;
    rs.outdoorsUuid0 = snap.outdoorsUuid0;
    rs.outdoorsUuid1 = snap.outdoorsUuid1;
    rs.outdoorsUuid2 = snap.outdoorsUuid2;
    rs.outdoorsUuid3 = snap.outdoorsUuid3;
    rs.litMaskUuid0 = snap.litMaskUuid0;
    rs.litMaskUuid1 = snap.litMaskUuid1;
    rs.litMaskUuid2 = snap.litMaskUuid2;
    rs.litMaskUuid3 = snap.litMaskUuid3;
    rs.hasLitMask0 = snap.hasLitMask0;
    rs.hasLitMask1 = snap.hasLitMask1;
    rs.hasLitMask2 = snap.hasLitMask2;
    rs.hasLitMask3 = snap.hasLitMask3;
    rs.dynTexVersion = snap.dynTexVersion;
    rs.winTexVersion = snap.winTexVersion;
    rs.dloStrength = snap.dloStrength;
    rs.dloEnabled = snap.dloEnabled;
    rs.vbX = snap.vbX;
    rs.vbY = snap.vbY;
    rs.vbZ = snap.vbZ;
    rs.vbW = snap.vbW;
    rs.srX = snap.srX;
    rs.srY = snap.srY;
    rs.srZ = snap.srZ;
    rs.srW = snap.srW;
    rs.sdimX = snap.sdimX;
    rs.sdimY = snap.sdimY;
  }

  /**
   * @param {string} bandSig
   * @returns {object}
   * @private
   */
  _buildRenderSnapshot(bandSig) {
    const dlo = this._dynamicLightOverride;
    const dynTex = dlo?.texture ?? null;
    const winTex = dlo?.windowTexture ?? null;
    const vbQ = this._quantizeViewBoundsForCache(dlo?.viewBounds);
    const sr = dlo?.sceneRect;
    const sdim = dlo?.sceneDimensions;
    const litMasks = this._litFloorMasks ?? [];
    const painted = this._paintedMasks ?? [];
    const outdoors = this._outdoorsMasks ?? [];

    return {
      sunAz: this._sunAzimuthDeg,
      sunEl: this._sunElevationDeg,
      driverLen: this._driverShadowLengthScale,
      driverSoft: this._driverShadowSoftnessScale,
      rtWidth: this._strengthTarget?.width ?? 0,
      rtHeight: this._strengthTarget?.height ?? 0,
      bandSig: bandSig ?? '',
      floorIdUuid: this._floorIdTex?.uuid ?? null,
      paintedUuid0: painted[0]?.uuid ?? null,
      paintedUuid1: painted[1]?.uuid ?? null,
      paintedUuid2: painted[2]?.uuid ?? null,
      paintedUuid3: painted[3]?.uuid ?? null,
      outdoorsUuid0: outdoors[0]?.uuid ?? null,
      outdoorsUuid1: outdoors[1]?.uuid ?? null,
      outdoorsUuid2: outdoors[2]?.uuid ?? null,
      outdoorsUuid3: outdoors[3]?.uuid ?? null,
      litMaskUuid0: litMasks[0]?.uuid ?? null,
      litMaskUuid1: litMasks[1]?.uuid ?? null,
      litMaskUuid2: litMasks[2]?.uuid ?? null,
      litMaskUuid3: litMasks[3]?.uuid ?? null,
      hasLitMask0: this._hasValidLitMask(0) ? 1 : 0,
      hasLitMask1: this._hasValidLitMask(1) ? 1 : 0,
      hasLitMask2: this._hasValidLitMask(2) ? 1 : 0,
      hasLitMask3: this._hasValidLitMask(3) ? 1 : 0,
      dynTexVersion: dynTex ? dynTex.version : -1,
      winTexVersion: winTex ? winTex.version : -1,
      dloStrength: dlo?.strength ?? -1,
      dloEnabled: dlo?.enabled !== false,
      vbX: vbQ?.x ?? 0,
      vbY: vbQ?.y ?? 0,
      vbZ: vbQ?.z ?? 0,
      vbW: vbQ?.w ?? 0,
      srX: sr?.x ?? 0,
      srY: sr?.y ?? 0,
      srZ: sr?.z ?? 0,
      srW: sr?.w ?? 0,
      sdimX: sdim?.x ?? 0,
      sdimY: sdim?.y ?? 0,
    };
  }

  /**
   * Hard dirty = rebuild immediately. Soft dirty = sun/driver/viewBounds/tex.version (throttled).
   * @param {object} snap
   * @returns {{hard:boolean, soft:boolean}}
   */
  _classifyRenderDirty(snap) {
    const rs = this._renderState;
    let hard = false;
    let soft = false;

    if (
      rs.rtWidth !== snap.rtWidth ||
      rs.rtHeight !== snap.rtHeight ||
      rs.bandSig !== snap.bandSig ||
      rs.floorIdUuid !== snap.floorIdUuid ||
      rs.paintedUuid0 !== snap.paintedUuid0 ||
      rs.paintedUuid1 !== snap.paintedUuid1 ||
      rs.paintedUuid2 !== snap.paintedUuid2 ||
      rs.paintedUuid3 !== snap.paintedUuid3 ||
      rs.outdoorsUuid0 !== snap.outdoorsUuid0 ||
      rs.outdoorsUuid1 !== snap.outdoorsUuid1 ||
      rs.outdoorsUuid2 !== snap.outdoorsUuid2 ||
      rs.outdoorsUuid3 !== snap.outdoorsUuid3 ||
      rs.litMaskUuid0 !== snap.litMaskUuid0 ||
      rs.litMaskUuid1 !== snap.litMaskUuid1 ||
      rs.litMaskUuid2 !== snap.litMaskUuid2 ||
      rs.litMaskUuid3 !== snap.litMaskUuid3 ||
      rs.hasLitMask0 !== snap.hasLitMask0 ||
      rs.hasLitMask1 !== snap.hasLitMask1 ||
      rs.hasLitMask2 !== snap.hasLitMask2 ||
      rs.hasLitMask3 !== snap.hasLitMask3 ||
      rs.dloEnabled !== snap.dloEnabled
    ) {
      hard = true;
    }

    if (this._numChanged(rs.dloStrength, snap.dloStrength, 1e-5)) hard = true;

    if (
      this._numChanged(rs.sunAz, snap.sunAz, PAINTED_SHADOW_SUN_EPS_DEG) ||
      this._numChanged(rs.sunEl, snap.sunEl, PAINTED_SHADOW_SUN_EPS_DEG) ||
      this._numChanged(rs.driverLen, snap.driverLen, PAINTED_SHADOW_DRIVER_EPS) ||
      this._numChanged(rs.driverSoft, snap.driverSoft, PAINTED_SHADOW_DRIVER_EPS)
    ) {
      soft = true;
    }

    if (
      rs.vbX !== snap.vbX ||
      rs.vbY !== snap.vbY ||
      rs.vbZ !== snap.vbZ ||
      rs.vbW !== snap.vbW ||
      rs.srX !== snap.srX ||
      rs.srY !== snap.srY ||
      rs.srZ !== snap.srZ ||
      rs.srW !== snap.srW ||
      rs.sdimX !== snap.sdimX ||
      rs.sdimY !== snap.sdimY ||
      rs.dynTexVersion !== snap.dynTexVersion ||
      rs.winTexVersion !== snap.winTexVersion
    ) {
      soft = true;
    }

    return { hard, soft };
  }

  /**
   * Returns true when shadow inputs changed or the throttle window elapsed.
   * @param {object} snap
   * @param {{hard:boolean, soft:boolean}} dirty
   * @returns {boolean}
   */
  _shouldRenderSnapshot(snap, dirty) {
    const now = performance.now();

    const dlo = this._dynamicLightOverride;
    const hasDynamicLights =
      (dlo?.texture || dlo?.windowTexture) &&
      snap.dloEnabled &&
      this.params.dynamicLightShadowOverrideEnabled !== false;
    const throttleMs = hasDynamicLights
      ? PAINTED_SHADOW_THROTTLE_DYNAMIC_MS
      : PAINTED_SHADOW_THROTTLE_STATIC_MS;
    const safetyMs = hasDynamicLights
      ? PAINTED_SHADOW_SAFETY_DYNAMIC_MS
      : PAINTED_SHADOW_SAFETY_STATIC_MS;
    const elapsed = now - this._renderState.time;

    if (dirty.hard) {
      this._commitRenderState(now, snap);
      return true;
    }

    if (dirty.soft && elapsed >= throttleMs) {
      this._commitRenderState(now, snap);
      return true;
    }

    if (elapsed >= safetyMs) {
      this._commitRenderState(now, snap);
      return true;
    }

    return false;
  }

  /**
   * Per-floor selective re-render when only one floor's masks changed.
   * @param {number} floorIndex
   * @param {object} snap
   * @param {{hard:boolean, soft:boolean}} dirty
   * @param {boolean} multiFloor
   * @param {boolean} floorHardDirty
   * @param {boolean} globalHardAllFloors
   * @returns {boolean}
   * @private
   */
  _shouldRenderFloor(floorIndex, snap, dirty, multiFloor, floorHardDirty, globalHardAllFloors, paramHard) {
    const fi = Math.max(0, Math.min(3, Math.floor(Number(floorIndex))));
    if (!multiFloor) return fi === 0;

    if (fi > 0 && !snap[`hasLitMask${fi}`]) return false;

    if (dirty.soft || globalHardAllFloors || floorHardDirty || paramHard) return true;

    if (fi === 0 && !this._groundOnlyLitTarget?.texture) return true;
    if (fi > 0 && !this._perFloorLitTargets[fi]?.texture) return true;

    return false;
  }

  /**
   * @param {object} snap
   * @param {object} rs
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _floorMaskHardDirty(snap, rs, floorIndex) {
    const fi = Math.max(0, Math.min(3, Math.floor(Number(floorIndex))));
    return rs[`litMaskUuid${fi}`] !== snap[`litMaskUuid${fi}`]
      || rs[`outdoorsUuid${fi}`] !== snap[`outdoorsUuid${fi}`]
      || rs[`hasLitMask${fi}`] !== snap[`hasLitMask${fi}`];
  }

  /**
   * @param {object} snap
   * @param {object} rs
   * @returns {boolean}
   * @private
   */
  _globalHardRequiresAllFloors(snap, rs) {
    return rs.rtWidth !== snap.rtWidth
      || rs.rtHeight !== snap.rtHeight
      || rs.bandSig !== snap.bandSig
      || rs.floorIdUuid !== snap.floorIdUuid
      || rs.dloEnabled !== snap.dloEnabled
      || this._numChanged(rs.dloStrength, snap.dloStrength, 1e-5);
  }

  /**
   * @param {string} bandSig
   * @returns {{ snap: object, dirty: { hard: boolean, soft: boolean } }}
   * @private
   */
  _resolveRenderDirtyState(bandSig) {
    const snap = this._buildRenderSnapshot(bandSig);
    const dirty = this._classifyRenderDirty(snap);
    let paramHard = false;

    for (const k in this.params) {
      if (this.params[k] !== this._lastParams[k]) {
        this._lastParams[k] = this.params[k];
        paramHard = true;
        break;
      }
    }

    if (paramHard) {
      return { snap, dirty: { hard: true, soft: false }, paramHard: true };
    }

    return { snap, dirty, paramHard: false };
  }

  /**
   * @param {number} floorIndex 1–3
   * @param {number} w
   * @param {number} h
   * @returns {boolean}
   * @private
   */
  _ensurePerFloorLitTarget(floorIndex, w, h) {
    const THREE = window.THREE;
    if (!THREE || floorIndex < 1 || floorIndex > 3) return false;
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    if (!this._perFloorLitTargets[floorIndex]) {
      this._perFloorLitTargets[floorIndex] = new THREE.WebGLRenderTarget(w, h, rtOpts);
    } else {
      this._perFloorLitTargets[floorIndex].setSize(w, h);
    }
    return !!this._perFloorLitTargets[floorIndex];
  }

  /**
   * Resolves GpuSceneMaskCompositor / bundle _Shadow inputs using the same floor-key
   * discovery order as `_Outdoors`. Stores the last Gpu resolve on `_lastPaintGpuResolve`
   * for diagnostics / band-change detection.
   * @returns {import('three').Texture|null}
   */
  _resolvePaintedShadowTexture() {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    this._lastPaintGpuResolve = null;
    if (!compositor) return null;

    const maskAliases = ['handPaintedShadow', 'paintedShadow', 'shadow'];
    const isPaintedMaskEntry = (m) => {
      const id = String(m?.id ?? '').toLowerCase();
      const type = String(m?.type ?? '').toLowerCase();
      const suffix = String(m?.suffix ?? '').toLowerCase();
      return maskAliases.some((a) => id === a.toLowerCase() || type === a.toLowerCase()) || suffix === '_shadow';
    };

    const lvlCtx = window.MapShine?.activeLevelContext ?? null;
    const gpu = resolveCompositorFloorMaskTexture(compositor, maskAliases, lvlCtx);
    this._lastPaintGpuResolve = gpu;
    if (gpu.texture) return gpu.texture;

    const ckCollected = collectCompositorFloorCandidateKeys(compositor, lvlCtx);
    const metaFloorKeys = [
      ...new Set([...(gpu.candidateKeysAttempted ?? []), gpu.resolvedKey, ckCollected.ctxBandKey].filter(Boolean)),
    ];
    for (const floorKey of metaFloorKeys) {
      const metaMasks = compositor?._floorMeta?.get?.(String(floorKey))?.masks ?? null;
      if (!Array.isArray(metaMasks)) continue;
      const hit = metaMasks.find((m) => isPaintedMaskEntry(m) && !!m?.texture);
      if (hit?.texture) return hit.texture;
    }

    const disableGlobalFallback = this._disableGlobalPaintedFallbackForMultiFloor();
    const hasPerFloorPainted = this._hasAnyPerFloorPaintedShadow(compositor);
    if (disableGlobalFallback && hasPerFloorPainted) {
      return null;
    }

    const viewedBasePath = this._resolveViewedLevelBasePath();
    if (viewedBasePath) {
      const cachedViewed = this._paintedBundleByBasePath.get(viewedBasePath);
      if (!this._paintedBundleByBasePath.has(viewedBasePath) || cachedViewed == null) {
        this._schedulePaintedBundleLoadForBasePath(viewedBasePath);
      }
      const viewedBundleTex = cachedViewed ?? null;
      if (viewedBundleTex) return viewedBundleTex;
      // In multi-floor scenes, avoid stale global currentBundle fallback while
      // async load for the viewed basePath is in flight.
      if (disableGlobalFallback) return null;
    }
    const bundleTex = window.MapShine?.sceneComposer?.currentBundle?.masks?.find?.(
      (m) => isPaintedMaskEntry(m) && !!m?.texture
    )?.texture ?? null;
    if (bundleTex) return bundleTex;
    for (const alias of maskAliases) {
      const regTex = window.MapShine?.effectMaskRegistry?.getMask?.(alias) ?? null;
      if (regTex) return regTex;
    }
    return null;
  }

  _ensureTargets(renderer, paintedTex) {
    const THREE = window.THREE;
    if (!THREE || !renderer || !paintedTex?.image) return false;
    const imgW = Math.max(1, Number(paintedTex.image.width) || 1);
    const imgH = Math.max(1, Number(paintedTex.image.height) || 1);
    const { w, h } = this._computePaintedRtSize(imgW, imgH);
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    if (!this._strengthTarget) this._strengthTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    else this._strengthTarget.setSize(w, h);
    if (!this._blurTarget) this._blurTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    else this._blurTarget.setSize(w, h);
    if (!this._sharpHoldTarget) this._sharpHoldTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    else this._sharpHoldTarget.setSize(w, h);
    if (!this.shadowTarget) this.shadowTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    else this.shadowTarget.setSize(w, h);
    if (!this._litScratchTarget) this._litScratchTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    else this._litScratchTarget.setSize(w, h);
    if (!this._groundOnlyLitTarget) this._groundOnlyLitTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    else this._groundOnlyLitTarget.setSize(w, h);
    this._projectMaterial.uniforms.uSceneDimensions.value.set(imgW, imgH);
    this._blurMaterial.uniforms.uTexelSize.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    return true;
  }

  /**
   * Project current uniforms to strength (with optional blur) then invert to lit RT.
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').WebGLRenderTarget} litTarget
   * @private
   */
  _renderStrengthToLitTarget(renderer, litTarget) {
    if (!renderer || !litTarget || !this._strengthTarget || !this._projectMaterial || !this._invertMaterial) return;

    const iu = this._invertMaterial.uniforms;
    if (iu?.uContactShadowPreserve) {
      const p = Number(this.params.contactShadowPreserve);
      iu.uContactShadowPreserve.value = Number.isFinite(p) ? Math.max(0.0, Math.min(1.0, p)) : 1.0;
    }
    if (iu?.uContactSharpBlendLow && iu?.uContactSharpBlendHigh) {
      let lo = Number(this.params.contactSharpBlendLow);
      let hi = Number(this.params.contactSharpBlendHigh);
      if (!Number.isFinite(lo)) lo = 0.04;
      if (!Number.isFinite(hi)) hi = 0.78;
      if (hi <= lo + 1e-4) hi = lo + 1e-4;
      lo = Math.max(0.0, Math.min(0.999, lo));
      hi = Math.max(lo + 1e-4, Math.min(1.0, hi));
      iu.uContactSharpBlendLow.value = lo;
      iu.uContactSharpBlendHigh.value = hi;
    }
    if (iu?.uShadowEdgeInflatePx) {
      const inf = Number(this.params.shadowEdgeInflatePx);
      iu.uShadowEdgeInflatePx.value = Number.isFinite(inf) ? Math.max(0.0, Math.min(32.0, inf)) : 0.0;
    }

    renderer.setRenderTarget(this._strengthTarget);
    renderer.setClearColor(0x000000, 1.0);
    renderer.clear();
    this._quad.material = this._projectMaterial;
    renderer.render(this._scene, this._camera);

    const blurRadius = Math.max(0.0, Number(this.params.blurRadius) || 0.0)
      * Math.max(0.05, Number(this._driverShadowSoftnessScale) || 1.0);
    const useBlur =
      !!this._blurMaterial && !!this._blurTarget && blurRadius > 0.01;
    let finalStrengthTex = this._strengthTarget.texture;

    const contactP = Number(this.params.contactShadowPreserve ?? 1);
    const preserveContact =
      !!this._sharpHoldTarget &&
      !!this._copyMaterial &&
      Number.isFinite(contactP) &&
      contactP > 1e-4;

    if (useBlur) {
      this._quad.material = this._blurMaterial;
      this._blurMaterial.uniforms.uRadius.value = blurRadius;

      let blurSrc = this._strengthTarget.texture;
      if (preserveContact) {
        this._quad.material = this._copyMaterial;
        this._copyMaterial.uniforms.tMap.value = this._strengthTarget.texture;
        renderer.setRenderTarget(this._sharpHoldTarget);
        renderer.setClearColor(0x000000, 1.0);
        renderer.clear();
        renderer.render(this._scene, this._camera);
        blurSrc = this._sharpHoldTarget.texture;
        this._quad.material = this._blurMaterial;
      }

      this._blurMaterial.uniforms.tInput.value = blurSrc;
      this._blurMaterial.uniforms.uDirection.value.set(1, 0);
      renderer.setRenderTarget(this._blurTarget);
      renderer.setClearColor(0x000000, 1.0);
      renderer.clear();
      renderer.render(this._scene, this._camera);

      this._blurMaterial.uniforms.tInput.value = this._blurTarget.texture;
      this._blurMaterial.uniforms.uDirection.value.set(0, 1);
      renderer.setRenderTarget(this._strengthTarget);
      renderer.setClearColor(0x000000, 1.0);
      renderer.clear();
      renderer.render(this._scene, this._camera);
      finalStrengthTex = this._strengthTarget.texture;
    }

    if (this._invertMaterial.uniforms.uStrengthTexelSize) {
      const sw = Math.max(1, this._strengthTarget.width | 0);
      const sh = Math.max(1, this._strengthTarget.height | 0);
      this._invertMaterial.uniforms.uStrengthTexelSize.value.set(1 / sw, 1 / sh);
    }
    this._quad.material = this._invertMaterial;
    this._invertMaterial.uniforms.tStrength.value = finalStrengthTex;
    if (this._invertMaterial.uniforms.tSharpStrength) {
      const sharpTex = (preserveContact && useBlur && this._sharpHoldTarget?.texture)
        ? this._sharpHoldTarget.texture
        : finalStrengthTex;
      this._invertMaterial.uniforms.tSharpStrength.value = sharpTex;
    }
    renderer.setRenderTarget(litTarget);
    renderer.setClearColor(0xffffff, 1.0);
    renderer.clear();
    renderer.render(this._scene, this._camera);
  }

  _updateSunDirection() {
    const THREE = window.THREE;
    if (!THREE) return;
    const sun2d = resolveEffectShadowSun2D({
      azimuthDeg: this._sunAzimuthDeg,
      elevationDeg: this._sunElevationDeg,
      previousDir: this.sunDir,
    });
    this.sunDir = writeEffectSunDir(this.sunDir, sun2d, THREE);
  }

  _requestLevelTexture(src) {
    const key = String(src || '').trim();
    if (!key) return null;
    if (this._levelTextureCache.has(key)) return this._levelTextureCache.get(key);
    if (!this._levelTextureInflight.has(key)) {
      const promise = loadTexture(key, { suppressProbeErrors: true })
        .then((tex) => {
          if (tex) {
            try {
              tex.flipY = false;
              tex.needsUpdate = true;
            } catch (_) {}
          }
          this._levelTextureCache.set(key, tex ?? null);
          return tex ?? null;
        })
        .catch(() => {
          this._levelTextureCache.set(key, null);
          return null;
        })
        .finally(() => {
          this._levelTextureInflight.delete(key);
        });
      this._levelTextureInflight.set(key, promise);
    }
    return null;
  }

  /**
   * Union of viewed-floor + upper-floor coverage (floorAlpha + level albedo alpha).
   * @param {number} receiverBaseIndex
   * @returns {{ kind:'floorAlpha'|'level', tex:import('three').Texture }[]}
   * @private
   */
  _collectOcclusionSources(receiverBaseIndex) {
    const sources = [];
    const seen = new Set();
    const pushTex = (tex, kind) => {
      const sig = tex?.uuid ?? tex;
      if (!tex || seen.has(sig)) return;
      seen.add(sig);
      sources.push({ kind, tex });
    };

    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    const scene = canvas?.scene ?? null;
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const receiverBase = Number.isFinite(Number(receiverBaseIndex)) ? Number(receiverBaseIndex) : 0;

    for (const f of floors) {
      const idx = Number(f?.index);
      if (!Number.isFinite(idx) || idx < receiverBase) continue;
      const key = f?.compositorKey != null ? String(f.compositorKey) : '';
      if (compositor && key) {
        pushTex(compositor.getFloorTexture?.(key, 'floorAlpha') ?? null, 'floorAlpha');
      }
      const levelId = f?.levelId;
      const level = levelId ? (scene?.levels?.get?.(levelId) ?? null) : null;
      pushTex(this._requestLevelTexture(level?.background?.src), 'level');
      pushTex(this._requestLevelTexture(level?.foreground?.src), 'level');
    }

    const snapUpper = this._driverMasksSnapshot?.upperFloorAlphaTextures;
    if (Array.isArray(snapUpper)) {
      for (const tex of snapUpper) pushTex(tex, 'floorAlpha');
    }

    return sources;
  }

  /** @private */
  _ensureFloorOcclusionTarget(renderer, width, height) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;
    const w = Math.max(2, Math.round(width || 2));
    const h = Math.max(2, Math.round(height || 2));
    if (this._floorOcclusionTarget) {
      if (this._floorOcclusionTarget.width !== w || this._floorOcclusionTarget.height !== h) {
        this._floorOcclusionTarget.setSize(w, h);
        this._floorOcclusionSig = '';
      }
      return;
    }
    this._floorOcclusionTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._floorOcclusionTarget.texture.name = 'MapShinePaintedShadowFloorOcclusion';
    this._floorOcclusionTarget.texture.flipY = false;
  }

  /** @private */
  _applyMaxBlendMaterial(material, THREE) {
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.MaxEquation ?? THREE.AddEquation;
    material.blendEquationAlpha = THREE.MaxEquation ?? THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneFactor;
    material.transparent = true;
  }

  /**
   * Max-composite viewed + upper floor sheets so below-receiver painted shadow
   * does not darken middle-floor albedo / tiles.
   * @returns {import('three').Texture|null}
   * @private
   */
  _buildViewedFloorOcclusion(renderer, receiverBaseIndex, width, height) {
    const THREE = window.THREE;
    if (!THREE || !renderer || !this._scene || !this._camera || !this._quad) return null;
    const sources = this._collectOcclusionSources(receiverBaseIndex);
    if (!sources.length) return null;

    let sig = `${receiverBaseIndex}|${width}x${height}|${sources.length}`;
    for (const { kind, tex } of sources) {
      sig += `|${kind}:${tex?.uuid ?? ''}:${tex?.version ?? 0}:${tex?.flipY ? 1 : 0}`;
    }
    if (sig === this._floorOcclusionSig && this._floorOcclusionTarget?.texture) {
      return this._floorOcclusionTarget.texture;
    }

    this._ensureFloorOcclusionTarget(renderer, width, height);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    try {
      renderer.setRenderTarget(this._floorOcclusionTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.autoClear = false;
      for (const { kind, tex } of sources) {
        if (kind === 'level' && this._levelAlphaMaterial) {
          this._levelAlphaMaterial.uniforms.tLevelAlbedo.value = tex;
          this._levelAlphaMaterial.uniforms.uFlipY.value = tex?.flipY ? 1.0 : 0.0;
          this._applyMaxBlendMaterial(this._levelAlphaMaterial, THREE);
          this._quad.material = this._levelAlphaMaterial;
        } else if (this._floorAlphaOcclusionMaterial) {
          this._floorAlphaOcclusionMaterial.uniforms.tInput.value = tex;
          this._floorAlphaOcclusionMaterial.uniforms.uFlipY.value = tex?.flipY ? 1.0 : 0.0;
          this._applyMaxBlendMaterial(this._floorAlphaOcclusionMaterial, THREE);
          this._quad.material = this._floorAlphaOcclusionMaterial;
        } else {
          continue;
        }
        renderer.render(this._scene, this._camera);
      }
      if (this._levelAlphaMaterial) {
        this._levelAlphaMaterial.blending = THREE.NoBlending;
        this._levelAlphaMaterial.transparent = false;
      }
      if (this._floorAlphaOcclusionMaterial) {
        this._floorAlphaOcclusionMaterial.blending = THREE.NoBlending;
        this._floorAlphaOcclusionMaterial.transparent = false;
      }
      this._floorOcclusionSig = sig;
    } finally {
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget);
    }
    return this._floorOcclusionTarget?.texture ?? null;
  }

  _clearShadowTargetToWhite(renderer) {
    if (!renderer) return;
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const targets = [
      this.shadowTarget,
      this._litScratchTarget,
      this._groundOnlyLitTarget,
    ].filter(Boolean);
    for (const rt of targets) {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0xffffff, 1.0);
      renderer.clear();
    }
    renderer.autoClear = prevAuto;
    renderer.setRenderTarget(prev);
  }

  update(timeInfo) {
    if (timeInfo && Number.isFinite(Number(timeInfo.sunAzimuthDeg))) {
      this._sunAzimuthDeg = Number(timeInfo.sunAzimuthDeg);
    }
    if (timeInfo && Number.isFinite(Number(timeInfo.sunElevationDeg))) {
      this._sunElevationDeg = Number(timeInfo.sunElevationDeg);
    }
    this._updateSunDirection();
  }

  render(renderer) {
    if (!this.params.enabled || !this._projectMaterial || !this._invertMaterial || !this._quad || !this._scene || !this._camera) {
      this._invalidatePerFloorLitCache();
      this._invalidateShadowRenderCache();
      return;
    }

    const paintedTex = this._resolvePaintedShadowTexture();
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    const liveOutdoor = compositor ? this._resolveLiveCompositorOutdoorsTexture() : null;
    let outdoorsTex = liveOutdoor ?? this._outdoorsMask ?? null;
    // Per-floor layering: pick painted/outdoors by floorIdTarget per pixel.
    this._paintedMasks = [null, null, null, null];
    this._litFloorMasks = [null, null, null, null];
    this._outdoorsMasks = [null, null, null, null];
    this._floorIdTex = null;
    if (compositor) {
      try {
        const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
        this._primePaintedBundleLoadsForAllFloors();
        for (const floor of floors) {
          const idx = Number(floor?.index);
          if (!Number.isFinite(idx) || idx < 0 || idx > 3) continue;
          this._paintedMasks[idx] = this._resolveCompositorPaintedMaskForFloor(floor, compositor);
          this._outdoorsMasks[idx] = compositor.getFloorTexture?.(floor.compositorKey, 'outdoors') ?? null;
          if (!this._paintedMasks[idx]) {
            this._tryAssignPaintedBundleMaskForFloor(idx);
          }
        }
        const groundMask = this._paintedMasks[0] ?? null;
        for (let idx = 1; idx < 4; idx++) {
          const tex = this._paintedMasks[idx];
          if (!tex || !groundMask?.uuid || tex.uuid !== groundMask.uuid) continue;
          // Compositor often hands back the ground _Shadow for every floor key.
          const replaced = this._tryAssignPaintedBundleMaskForFloor(idx, groundMask.uuid);
          if (!replaced) this._paintedMasks[idx] = null;
        }
        const anyOutdoors = this._outdoorsMasks.some((t) => !!t);
        if (anyOutdoors) {
          this._floorIdTex = compositor.floorIdTarget?.texture ?? null;
        }
      } catch (_) {}
    }
    try { refreshEffectMaskStatusUi('painted-shadows'); } catch (_) {}
    if (!paintedTex || !outdoorsTex) {
      if (!outdoorsTex && !this._loggedMissingOutdoorsMask) {
        this._loggedMissingOutdoorsMask = true;
        log.warn('PaintedShadowEffectV2: _Outdoors mask unavailable; skipping painted shadow to avoid darkening interiors.');
      }
      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: !!this.params.enabled,
        paintedMaskFound: !!paintedTex,
        outdoorsMaskFound: !!outdoorsTex,
        syncOutdoorsMaskUuid: this._outdoorsMask?.uuid ?? null,
        dynamicLightOverrideBound: !!(this._dynamicLightOverride?.texture || this._dynamicLightOverride?.windowTexture),
        note: 'Missing painted or outdoors mask',
      };
      this._invalidatePerFloorLitCache();
      this._invalidateShadowRenderCache();
      this._clearShadowTargetToWhite(renderer);
      this._lastPaintedSourceSig = null;
      return;
    }
    this._loggedMissingOutdoorsMask = false;

    let cacheVersion = 0;
    try {
      cacheVersion = Number(window?.MapShine?.sceneComposer?._sceneMaskCompositor?.getFloorCacheVersion?.() ?? 0);
    } catch (_) {}
    const gpg = this._lastPaintGpuResolve;
    const bandSig = [
      gpg?.route ?? '',
      gpg?.resolvedKey ?? '',
      gpg?.maskType ?? '',
      paintedTex?.uuid ?? '',
      outdoorsTex?.uuid ?? '',
      cacheVersion,
    ].join('|');
    if (this._lastPaintedSourceSig != null && this._lastPaintedSourceSig !== bandSig && renderer) {
      this._invalidatePerFloorLitCache();
      this._invalidateShadowRenderCache();
      this._clearShadowTargetToWhite(renderer);
      this._floorOcclusionSig = '';
    }
    this._lastPaintedSourceSig = bandSig;

    if (!this._ensureTargets(renderer, paintedTex)) {
      this._invalidatePerFloorLitCache();
      this._invalidateShadowRenderCache();
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    this._lastPaintedTexForSlots = paintedTex;
    this._rebuildLitFloorMasks(paintedTex);

    const { snap: renderSnap, dirty: renderDirty, paramHard } = this._resolveRenderDirtyState(bandSig);
    const preCommitRs = this._renderState;
    const globalHardAllFloors = this._globalHardRequiresAllFloors(renderSnap, preCommitRs);
    if (!this._shouldRenderSnapshot(renderSnap, renderDirty)) {
      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: true,
        paintedMaskFound: true,
        outdoorsMaskFound: true,
        syncOutdoorsMaskUuid: this._outdoorsMask?.uuid ?? null,
        dynamicLightOverrideBound: !!(this._dynamicLightOverride?.texture || this._dynamicLightOverride?.windowTexture),
        shadowFactorTextureUuid: this.shadowTarget?.texture?.uuid ?? null,
        litScratchUuid: this._litScratchTarget?.texture?.uuid ?? null,
        groundOnlyLitUuid: this._groundOnlyLitTarget?.texture?.uuid ?? null,
        note: 'Cached render (optimization)',
      };
      return;
    }

    this._perFloorLitCacheSerial++;
    const perFloorLitSerialThisFrame = this._perFloorLitCacheSerial;
    const multiFloor = (window.MapShine?.floorStack?.getFloors?.()?.length ?? 0) > 1;

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    try {
      const pu = this._projectMaterial.uniforms;
      pu.tPaintedShadow.value = paintedTex;

      const noShadowTex = this._noShadowFallbackTex;
      pu.tPaintedShadow0.value = this._resolvePaintedSlotTexture(0, paintedTex, noShadowTex);
      pu.tPaintedShadow1.value = this._resolvePaintedSlotTexture(1, paintedTex, noShadowTex);
      pu.tPaintedShadow2.value = this._resolvePaintedSlotTexture(2, paintedTex, noShadowTex);
      pu.tPaintedShadow3.value = this._resolvePaintedSlotTexture(3, paintedTex, noShadowTex);
      for (let i = 0; i < 4; i++) {
        const t = pu[`tPaintedShadow${i}`].value;
        pu[`uPainted${i}FlipY`].value = t?.flipY ? 1.0 : 0.0;
      }
      const groundMask = this._paintedMasks[0] ?? paintedTex ?? null;
      const paintedSlotBindings = [0, 1, 2, 3].map((i) => {
        const raw = this._paintedMasks[i] ?? null;
        const bound = pu[`tPaintedShadow${i}`].value ?? null;
        return {
          floor: i,
          uuid: bound?.uuid ?? null,
          rawMaskUuid: raw?.uuid ?? null,
          dedupedFromGround: !!(i > 0 && raw?.uuid && groundMask?.uuid
            && raw.uuid === groundMask.uuid && bound !== raw),
        };
      });

      pu.uPaintedFloorIndex.value = -1.0;
      pu.uReceiverFloorIndex.value = -1.0;
      pu.tReceiverLevelAlpha.value = null;
      pu.uHasReceiverLevelAlpha.value = 0.0;
      this._syncLitMaskUniformsOnly(pu);

      pu.tOutdoors.value = outdoorsTex;
      pu.tOutdoors0.value = this._outdoorsMasks[0] ?? outdoorsTex;
      pu.tOutdoors1.value = this._outdoorsMasks[1] ?? outdoorsTex;
      pu.tOutdoors2.value = this._outdoorsMasks[2] ?? outdoorsTex;
      pu.tOutdoors3.value = this._outdoorsMasks[3] ?? outdoorsTex;
      pu.tFloorIdTex.value = this._floorIdTex;
      pu.uHasPaintedShadow.value = 1.0;
      pu.uHasOutdoorsMask.value = 1.0;
      pu.uHasFloorIdTex.value = this._floorIdTex ? 1.0 : 0.0;
      pu.uFloorIdFlipY.value = 1.0;
      pu.uPaintedFlipY.value = paintedTex?.flipY ? 1.0 : 0.0;
      pu.uOutdoorsFlipY.value = outdoorsTex?.flipY ? 1.0 : 0.0;
      for (let i = 0; i < 4; i++) {
        const t = pu[`tOutdoors${i}`].value;
        pu[`uHasOutdoors${i}`].value = t ? 1.0 : 0.0;
        pu[`uOutdoors${i}FlipY`].value = t?.flipY ? 1.0 : 0.0;
      }
      pu.uSunDir.value.copy(this.sunDir || { x: 0.0, y: -1.0 });
      pu.uOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.opacity) || 0.0));
      {
        const b = Number(this.params.shadowStrengthBoost);
        pu.uShadowStrengthBoost.value = Number.isFinite(b) ? Math.max(1.0, Math.min(10.0, b)) : 1.0;
      }
      pu.uLength.value = resolveBakeRayLength(
        this,
        Math.max(0.0, Number(this.params.length) || 0.0)
          * Math.max(0.05, Number(this._driverShadowLengthScale) || 1.0),
      );
      const dlo = this._dynamicLightOverride;
      const dynTex = dlo?.texture ?? null;
      const winTex = dlo?.windowTexture ?? null;
      pu.tDynamicLight.value = dynTex;
      pu.tWindowLight.value = winTex;
      pu.uHasDynamicLight.value = dynTex ? 1.0 : 0.0;
      pu.uHasWindowLight.value = winTex ? 1.0 : 0.0;
      pu.uDynamicLightShadowOverrideEnabled.value = (this.params.dynamicLightShadowOverrideEnabled !== false && dlo?.enabled !== false) ? 1.0 : 0.0;
      const dynStrength = Number.isFinite(Number(dlo?.strength))
        ? Number(dlo.strength)
        : Number(this.params.dynamicLightShadowOverrideStrength ?? 0.7);
      pu.uDynamicLightShadowOverrideStrength.value = Math.max(0.0, Math.min(1.0, dynStrength));
      const vb = dlo?.viewBounds;
      if (vb && Number.isFinite(vb.x) && Number.isFinite(vb.y) && Number.isFinite(vb.z) && Number.isFinite(vb.w)) {
        pu.uDynViewBounds.value.set(vb.x, vb.y, vb.z, vb.w);
      }
      const sdim = dlo?.sceneDimensions;
      if (sdim && Number.isFinite(sdim.x) && Number.isFinite(sdim.y)) {
        pu.uDynSceneDimensions.value.set(sdim.x, sdim.y);
      }
      const srect = dlo?.sceneRect;
      if (srect && Number.isFinite(srect.x) && Number.isFinite(srect.y) && Number.isFinite(srect.z) && Number.isFinite(srect.w)) {
        pu.uDynSceneRect.value.set(srect.x, srect.y, srect.z, srect.w);
        pu.uHasDynSceneRect.value = 1.0;
      } else {
        pu.uHasDynSceneRect.value = 0.0;
      }

      renderer.autoClear = false;

      if (!multiFloor) {
        this._renderStrengthToLitTarget(renderer, this.shadowTarget);
      }

      const rtW = this._strengthTarget?.width | 0;
      const rtH = this._strengthTarget?.height | 0;
      if (multiFloor && this._groundOnlyLitTarget && this._shouldRenderFloor(
        0, renderSnap, renderDirty, multiFloor,
        this._floorMaskHardDirty(renderSnap, preCommitRs, 0),
        globalHardAllFloors,
        paramHard,
      )) {
        this._renderSingleFloorLit(renderer, 0, this._groundOnlyLitTarget);
        this._perFloorLitLastFillSerial[0] = perFloorLitSerialThisFrame;
      }
      // FloorCompositor calls `renderLitForSingleFloor` once per visible upper band; without
      // prefetch each call repeated the entire project+blur+invert chain (often >2×/frame).
      if (multiFloor && rtW > 0 && rtH > 0 && renderer) {
        for (let fi = 1; fi <= 3; fi++) {
          if (!this._shouldRenderFloor(
            fi, renderSnap, renderDirty, multiFloor,
            this._floorMaskHardDirty(renderSnap, preCommitRs, fi),
            globalHardAllFloors,
            paramHard,
          )) {
            if (this._perFloorLitTargets[fi]?.texture) {
              this._perFloorLitLastFillSerial[fi] = perFloorLitSerialThisFrame;
            }
            continue;
          }
          if (!this._hasValidLitMask(fi)) {
            this._perFloorLitLastFillSerial[fi] = 0;
            continue;
          }
          if (!this._ensurePerFloorLitTarget(fi, rtW, rtH)) continue;
          this._renderSingleFloorLit(renderer, fi, this._perFloorLitTargets[fi]);
          this._perFloorLitLastFillSerial[fi] = perFloorLitSerialThisFrame;
        }
      } else if (!multiFloor) {
        this._invalidatePerFloorLitCache();
      }

      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: !!this.params.enabled,
        paintedMaskFound: true,
        outdoorsMaskFound: true,
        syncOutdoorsMaskUuid: this._outdoorsMask?.uuid ?? null,
        dynamicLightOverrideBound: !!(dynTex || winTex),
        shadowFactorTextureUuid: this.shadowTarget?.texture?.uuid ?? null,
        litScratchUuid: this._litScratchTarget?.texture?.uuid ?? null,
        groundOnlyLitUuid: this._groundOnlyLitTarget?.texture?.uuid ?? null,
        renderCached: false,
        multiFloorSkipCombined: multiFloor,
        paintedSlotBindings,
        rawPerFloorMaskUuids: (this._paintedMasks ?? []).map((t, i) => ({ floor: i, uuid: t?.uuid ?? null })),
        litFloorMaskUuids: (this._litFloorMasks ?? []).map((t, i) => ({ floor: i, uuid: t?.uuid ?? null })),
      };
    } finally {
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    try { this._strengthTarget?.dispose(); } catch (_) {}
    try { this._blurTarget?.dispose(); } catch (_) {}
    try { this._sharpHoldTarget?.dispose(); } catch (_) {}
    try { this.shadowTarget?.dispose(); } catch (_) {}
    try { this._litScratchTarget?.dispose(); } catch (_) {}
    try { this._groundOnlyLitTarget?.dispose(); } catch (_) {}
    for (let i = 1; i <= 3; i++) {
      try { this._perFloorLitTargets[i]?.dispose?.(); } catch (_) {}
      this._perFloorLitTargets[i] = null;
      this._perFloorLitLastFillSerial[i] = 0;
    }
    try { this._projectMaterial?.dispose(); } catch (_) {}
    try { this._invertMaterial?.dispose(); } catch (_) {}
    try { this._blurMaterial?.dispose(); } catch (_) {}
    try { this._copyMaterial?.dispose(); } catch (_) {}
    try { this._quad?.geometry?.dispose(); } catch (_) {}
    try { this._noShadowFallbackTex?.dispose?.(); } catch (_) {}
    try { this._floorOcclusionTarget?.dispose?.(); } catch (_) {}
    try { this._levelAlphaMaterial?.dispose?.(); } catch (_) {}
    try { this._floorAlphaOcclusionMaterial?.dispose?.(); } catch (_) {}
    this._strengthTarget = null;
    this._blurTarget = null;
    this._sharpHoldTarget = null;
    this.shadowTarget = null;
    this._litScratchTarget = null;
    this._groundOnlyLitTarget = null;
    this._perFloorLitTargets = [null, null, null, null];
    this._perFloorLitLastFillSerial = [0, 0, 0, 0];
    this._perFloorLitCacheSerial = 0;
    this._projectMaterial = null;
    this._invertMaterial = null;
    this._blurMaterial = null;
    this._copyMaterial = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;
    this.renderer = null;
    this._outdoorsMask = null;
    this._lastPaintGpuResolve = null;
    this._lastPaintedSourceSig = null;
    this._paintedBundleByBasePath.clear();
    this._paintedBundleLoadsInFlight.clear();
    this._paintedBundleLastAttemptMs.clear();
    this._paintedBundleMissPaths.clear();
    this._paintedMasks = [null, null, null, null];
    this._litFloorMasks = [null, null, null, null];
    this._outdoorsMasks = [null, null, null, null];
    this._floorIdTex = null;
    this._noShadowFallbackTex = null;
    this._lastPaintedTexForSlots = null;
    this._driverMasksSnapshot = null;
    this._floorOcclusionTarget = null;
    this._levelAlphaMaterial = null;
    this._floorAlphaOcclusionMaterial = null;
    this._levelTextureCache.clear();
    this._levelTextureInflight.clear();
    this._floorOcclusionSig = '';
    this._lastParams = {};
    this._renderState.time = 0;
    try { refreshEffectMaskStatusUi('painted-shadows'); } catch (_) {}
  }
}