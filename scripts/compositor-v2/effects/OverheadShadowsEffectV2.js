/**
 * @fileoverview Overhead Shadows Effect V2 (adapted from V1)
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's capture passes (roof/fluid/tile/upper-floor-alpha composite),
 * temporary override restoration, floor/context behavior, or output textures
 * (including ceilingTransmittance), you MUST update HealthEvaluator contracts/wiring
 * for `OverheadShadowsEffectV2`
 * to prevent silent failures.
 * Renders soft, directional shadows cast by overhead tiles onto the ground.
 * @module compositor-v2/effects/OverheadShadowsEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { tileDocRestrictsLight } from '../../scene/tile-manager.js';

const log = createLogger('OverheadShadowsEffect');

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
  } catch (_) {
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
export class OverheadShadowsEffectV2 {
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

    /**
     * Half-res packed ceiling light transmittance T in R (1 = lights pass, 0 = blocked).
     * Derived from roofVisibility + roofBlock with the same thresholds as LightingEffectV2
     * so geometric gating has a single source of truth (see _renderCeilingTransmittancePass).
     * @type {THREE.WebGLRenderTarget|null}
     */
    this.ceilingTransmittanceTarget = null;

    /** @type {THREE.Scene|null} */
    this._ceilingTransmittanceScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._ceilingTransmittanceCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._ceilingTransmittanceMaterial = null;

    /** True after _renderCeilingTransmittancePass this frame (avoids binding cleared-white RT as valid T). */
    this._ceilingTransmittanceWritten = false;

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

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null; // Groundplane mesh

    /** @type {THREE.Scene|null} */
    this.shadowScene = null; // World-pinned shadow mesh scene
    /** @type {THREE.Mesh|null} */
    this.shadowMesh = null;

    this.params = {
      enabled: true,
      opacity: 0.4,
      length: 0.040,
      softness: 1.0,
      outdoorShadowLengthScale: 2.0,
      indoorReceiverShadowLengthScale: 0.25,
      verticalOnly: true,  // v1: primarily vertical motion in screen space
      affectsLights: 0.75,
      sunLatitude: 0.1,    // 0=flat east/west, 1=maximum north/south arc
      indoorShadowEnabled: true, // Back-compat toggle; controls projected _Outdoors dark-region building shadow contribution on outdoor receivers
      indoorShadowOpacity: 0.42,   // Back-compat alias for outdoorBuildingShadowOpacity
      outdoorBuildingShadowOpacity: 0.42,
      indoorShadowLengthScale: 4.70, // Back-compat alias for outdoorBuildingShadowLengthScale
      outdoorBuildingShadowLengthScale: 4.70,
      indoorShadowSoftness: 3.8,
      indoorFluidShadowSoftness: 3.1,
      indoorFluidShadowIntensityBoost: 0.81,
      indoorFluidColorSaturation: 1.2,
      tileProjectionEnabled: true,
      tileProjectionOpacity: 0.5,
      tileProjectionLengthScale: 1.0,
      tileProjectionSoftness: 3.0,
      tileProjectionThreshold: 0.05,
      tileProjectionPower: 1.0,
      tileProjectionOutdoorOpacityScale: 0.10,
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
      skyReachShadowOpacity: 0.35,
      /** Composite all upper floors' GPU `floorAlpha` masks and project like building shadow. */
      upperFloorTileShadowEnabled: true,
      upperFloorTileShadowOpacity: 0.55,
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

    /** @type {THREE.WebGLRenderTarget|null} Product/union of upper-floor `floorAlpha` for directional shadow. */
    this._upperFloorCompositeRT = null;
    /** @type {THREE.Scene|null} */
    this._upperFloorAccumScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._upperFloorAccumCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._upperFloorAccumMaterial = null;

    /** @type {THREE.Texture|null} */
    this._dynamicLightTexture = null;
    this._dynamicLightOverrideStrength = 0.7;
    this._treeRainMaskProbeLastKey = '';
    this._treeRainMaskProbeLastTs = 0;
    this._treeRainDebugHeartbeatLastTs = 0;
  }

  /**
   * @param {{texture?: any, strength?: number}|null} payload
   */
  setDynamicLightOverride(payload = null) {
    this._dynamicLightTexture = payload?.texture ?? null;
    this._dynamicLightOverrideStrength = Number.isFinite(Number(payload?.strength))
      ? Math.max(0.0, Math.min(1.0, Number(payload.strength)))
      : 0.7;
  }

  /**
   * Debug: tree / rain occlusion capture. Enable any of:
   * - `window.MapShine.debugTreeRainMaskProbe = true` (or 1 / "true")
   * - `globalThis.__MSA_DEBUG_TREE_RAIN_MASK__ = true`
   * @returns {boolean}
   * @private
   */
  _isTreeRainMaskDebugEnabled() {
    try {
      const g = typeof globalThis !== 'undefined' ? globalThis : window;
      if (g.__MSA_DEBUG_TREE_RAIN_MASK__ === true) return true;
      const v = g.MapShine?.debugTreeRainMaskProbe;
      if (v === true || v === 1) return true;
      if (typeof v === 'string' && v.toLowerCase() === 'true') return true;
      return false;
    } catch (_) {
      return false;
    }
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
      activeMask = sc?._sceneMaskCompositor?.getFloorTexture?.(activeKey, 'outdoors') ?? null;
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
      if (ck) tex = compositor.getFloorTexture?.(ck, 'outdoors') ?? null;
      if (!tex) {
        const b = Number(f?.elevationMin);
        const t = Number(f?.elevationMax);
        if (Number.isFinite(b) && Number.isFinite(t)) {
          tex = compositor.getFloorTexture?.(`${b}:${t}`, 'outdoors') ?? null;
        }
      }
      if (tex && upper.length < 3) upper.push(tex);
    }
    return upper;
  }

  /**
   * Lazy fullscreen pass: samples one upper-floor `floorAlpha` into the composite RT.
   * @param {object} THREE
   * @private
   */
  _ensureUpperFloorAccumPass(THREE) {
    if (this._upperFloorAccumScene) return;
    this._upperFloorAccumCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._upperFloorAccumScene = new THREE.Scene();
    this._upperFloorAccumMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tUpperAlpha: { value: null },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tUpperAlpha;
        varying vec2 vUv;
        void main() {
          float a = texture2D(tUpperAlpha, vUv).r;
          gl_FragColor = vec4(a, a, a, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._upperFloorAccumMaterial);
    mesh.frustumCulled = false;
    this._upperFloorAccumScene.add(mesh);
  }

  /**
   * Build scene-UV texture: multiply or max of every upper-floor `floorAlpha` from GpuSceneMaskCompositor.
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} THREE
   * @private
   */
  _renderUpperFloorComposite(renderer, THREE) {
    const white = this._getWhiteMaskPlaceholder();
    const u = this.material?.uniforms;
    if (!u?.tUpperFloorComposite) return;

    if (!this.params.upperFloorTileShadowEnabled) {
      u.tUpperFloorComposite.value = white;
      u.uHasUpperFloorComposite.value = 0.0;
      return;
    }

    const textures = this._collectUpperFloorFloorAlphaTextures();
    if (textures.length === 0) {
      u.tUpperFloorComposite.value = white;
      u.uHasUpperFloorComposite.value = 0.0;
      return;
    }

    this._ensureUpperFloorAccumPass(THREE);

    let maxW = 2;
    let maxH = 2;
    for (const t of textures) {
      if (!t) continue;
      // RT / DataTexture masks often omit DOM image fields; read dims robustly.
      const iw = t.image?.width ?? t.source?.data?.width ?? t.width
        ?? t.image?.naturalWidth ?? t.image?.videoWidth ?? 0;
      const ih = t.image?.height ?? t.source?.data?.height ?? t.height
        ?? t.image?.naturalHeight ?? t.image?.videoHeight ?? 0;
      if (iw > maxW) maxW = iw;
      if (ih > maxH) maxH = ih;
    }
    if (maxW <= 2 && maxH <= 2) {
      try {
        const comp = window.MapShine?.sceneComposer?._sceneMaskCompositor;
        const od = comp?.getOutputDims?.('floorAlpha');
        const ow = Math.floor(Number(od?.width));
        const oh = Math.floor(Number(od?.height));
        if (ow > 0 && oh > 0) {
          maxW = Math.max(maxW, ow);
          maxH = Math.max(maxH, oh);
        }
      } catch (_) {}
      if (maxW <= 2 && maxH <= 2 && renderer) {
        const d = new THREE.Vector2();
        renderer.getDrawingBufferSize(d);
        maxW = Math.max(maxW, Math.max(2, Math.floor(d.x)));
        maxH = Math.max(maxH, Math.max(2, Math.floor(d.y)));
      }
    }
    const cap = (renderer?.capabilities?.maxTextureSize | 0) || 8192;
    maxW = Math.max(2, Math.min(maxW, cap));
    maxH = Math.max(2, Math.min(maxH, cap));

    if (!this._upperFloorCompositeRT
      || this._upperFloorCompositeRT.width !== maxW
      || this._upperFloorCompositeRT.height !== maxH) {
      try { this._upperFloorCompositeRT?.dispose(); } catch (_) {}
      this._upperFloorCompositeRT = new THREE.WebGLRenderTarget(maxW, maxH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this._upperFloorCompositeRT.texture.flipY = false;
      this._upperFloorCompositeRT.texture.name = 'Overhead_upperFloorComposite';
    }

    const mat = this._upperFloorAccumMaterial;
    const prevTarget = renderer.getRenderTarget();
    const prevClearColor = new THREE.Color();
    renderer.getClearColor(prevClearColor);
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this._upperFloorCompositeRT);

    const useMultiply = String(this.params.upperFloorTileCombineMode || '').toLowerCase() === 'multiply';
    if (useMultiply) {
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.DstColorFactor;
      mat.blendDst = THREE.ZeroFactor;
      mat.blendEquationAlpha = THREE.AddEquation;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.ZeroFactor;
    } else {
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.MaxEquation ?? THREE.AddEquation;
      mat.blendEquationAlpha = THREE.MaxEquation ?? THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneFactor;
    }
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.transparent = true;

    for (const tex of textures) {
      mat.uniforms.tUpperAlpha.value = tex;
      try {
        renderer.render(this._upperFloorAccumScene, this._upperFloorAccumCamera);
      } catch (e) {
        log.debug('OverheadShadowsEffectV2: upper-floor composite draw failed', e);
      }
    }

    mat.blending = THREE.NoBlending;
    mat.transparent = false;

    renderer.setClearColor(prevClearColor, prevClearAlpha);
    renderer.setRenderTarget(prevTarget);

    u.tUpperFloorComposite.value = this._upperFloorCompositeRT.texture;
    u.uHasUpperFloorComposite.value = 1.0;
    if (u.uUpperFloorCompositeFlipY) u.uUpperFloorCompositeFlipY.value = 0.0;
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
   * Temporarily force upper-floor overhead casters visible for roof capture.
   * FloorRenderBus hides floors above the active band for albedo rendering, but
   * overhead shadow captures should still include those casters so lower floors
   * receive their shadow silhouettes.
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

    this.mainScene.traverse((object) => {
      if (!object?.layers || typeof object.visible !== 'boolean') return;
      const isOverheadLayer = (object.layers.mask & (1 << 20)) !== 0;
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
    return this.shadowTarget?.texture || null;
  }

  /**
   * Raw overhead roof alpha texture (screen-space).
   * Used by LightingEffectV2 to suppress other ambient shadow layers on pixels
   * currently covered by visible overhead tiles.
   * @returns {THREE.Texture|null}
   */
  get roofAlphaTexture() {
    return this.roofVisibilityTarget?.texture || null;
  }

  /**
   * Hard roof blocker texture (screen-space).
   * Captured from a forced-opaque overhead roof pass without guard-band
   * camera scaling so LightingEffectV2 can sample it directly in screen UV.
   * @returns {THREE.Texture|null}
   */
  get roofBlockTexture() {
    return this.roofBlockTarget?.texture || null;
  }

  /**
   * Restrict-light overhead mask for LightingEffectV2 (screen-space, alpha channel).
   * @returns {THREE.Texture|null}
   */
  get roofRestrictLightTexture() {
    return this.roofRestrictLightTarget?.texture || null;
  }

  /**
   * Runtime weather occlusion visibility texture (screen-space alpha).
   * Includes overhead/trees with live fade for precipitation masking.
   * @returns {THREE.Texture|null}
   */
  get rainOcclusionVisibilityTexture() {
    return this.rainOcclusionVisibilityTarget?.texture || null;
  }

  /**
   * Runtime weather occlusion blocker texture (screen-space alpha).
   * Includes overhead/trees forced fully visible for precipitation masking.
   * @returns {THREE.Texture|null}
   */
  get rainOcclusionBlockTexture() {
    return this.rainOcclusionBlockTarget?.texture || null;
  }

  /**
   * Half-res transmittance for dynamic lights under ceilings (R channel, linear 0..1).
   * @returns {THREE.Texture|null}
   */
  get ceilingTransmittanceTexture() {
    return this.ceilingTransmittanceTarget?.texture || null;
  }

  /**
   * Texture for LightingEffectV2 only after a successful blit this frame.
   * @returns {THREE.Texture|null}
   */
  get ceilingTransmittanceTextureForLighting() {
    return (this._ceilingTransmittanceWritten && this.ceilingTransmittanceTarget?.texture)
      ? this.ceilingTransmittanceTarget.texture
      : null;
  }

  /**
   * Lazy fullscreen pass: roofVisibility + roofBlock → T (matches lighting thresholds).
   * @private
   */
  _ensureCeilingTransmittancePass() {
    const THREE = window.THREE;
    if (!THREE || this._ceilingTransmittanceScene) return;

    this._ceilingTransmittanceCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._ceilingTransmittanceScene = new THREE.Scene();
    this._ceilingTransmittanceMaterial = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      // IMPORTANT:
      // These shader sources are authored inside JS template literals (backticks).
      // Do NOT use backticks inside shader comments/strings, or the module will fail
      // to parse (template literal termination bug).
      uniforms: {
        tRoofVis: { value: null },
        tRoofBlock: { value: null },
        uHasRoofVis: { value: 0 },
        uHasRoofBlock: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tRoofVis;
        uniform sampler2D tRoofBlock;
        uniform float uHasRoofVis;
        uniform float uHasRoofBlock;
        varying vec2 vUv;
        void main() {
          float T = 1.0;
          float roofVisOcc = 0.0;
          if (uHasRoofVis > 0.5) {
            vec4 rv = texture2D(tRoofVis, vUv);
            float a = clamp(max(rv.a, max(rv.r, max(rv.g, rv.b))), 0.0, 1.0);
            // Slightly lower threshold than legacy 0.20 so faint roof art / half-res
            // soften still registers as occluding for lights.
            // Smooth the occlusion ramp so roof/tree hover fading doesn't produce
            // a hard binary "light on vs light off" transition.
            roofVisOcc = smoothstep(0.10, 0.14, a);
            T *= (1.0 - roofVisOcc);
          }
          if (uHasRoofBlock > 0.5) {
            vec4 rb = texture2D(tRoofBlock, vUv);
            float b = clamp(max(rb.a, max(rb.r, max(rb.g, rb.b))), 0.0, 1.0);
            // IMPORTANT INVARIANT:
            // Keep hard blocker tied to live roof visibility (roofVisOcc) so it
            // fades out with hover-revealed trees/overheads instead of staying
            // dark while hidden. This prevents hover reveal from leaving lights
            // permanently suppressed.
            float roofBlockOcc = smoothstep(0.42, 0.48, b) * roofVisOcc;
            T *= (1.0 - roofBlockOcc);
          }
          gl_FragColor = vec4(T, T, T, 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._ceilingTransmittanceMaterial);
    mesh.frustumCulled = false;
    this._ceilingTransmittanceScene.add(mesh);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @private
   */
  _renderCeilingTransmittancePass(renderer) {
    if (!renderer || !this.roofVisibilityTarget?.texture || !this.roofBlockTarget?.texture
      || !this.ceilingTransmittanceTarget) {
      return;
    }
    this._ensureCeilingTransmittancePass();
    if (!this._ceilingTransmittanceMaterial || !this._ceilingTransmittanceScene
      || !this._ceilingTransmittanceCamera) {
      return;
    }
    const m = this._ceilingTransmittanceMaterial;
    m.uniforms.tRoofVis.value = this.roofVisibilityTarget.texture;
    m.uniforms.tRoofBlock.value = this.roofBlockTarget.texture;
    m.uniforms.uHasRoofVis.value = 1.0;
    m.uniforms.uHasRoofBlock.value = 1.0;

    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.ceilingTransmittanceTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(this._ceilingTransmittanceScene, this._ceilingTransmittanceCamera);
      this._ceilingTransmittanceWritten = true;
    } finally {
      renderer.setRenderTarget(prev);
    }
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
          parameters: ['tileProjectionEnabled', 'tileProjectionOpacity', 'tileProjectionLengthScale', 'tileProjectionSoftness', 'tileProjectionThreshold', 'tileProjectionPower', 'tileProjectionOutdoorOpacityScale', 'tileProjectionIndoorOpacityScale']
        },
        {
          name: 'receiverTuning',
          label: 'Receiver Regions',
          type: 'inline',
          parameters: ['outdoorShadowLengthScale', 'indoorReceiverShadowLengthScale']
        },
        {
          name: 'indoorShadow',
          label: 'Outdoor Building Shadow (_Outdoors)',
          type: 'inline',
          parameters: ['indoorShadowEnabled', 'outdoorBuildingShadowOpacity', 'outdoorBuildingShadowLengthScale', 'indoorShadowSoftness', 'indoorFluidShadowSoftness', 'indoorFluidShadowIntensityBoost', 'indoorFluidColorSaturation']
        },
        {
          name: 'skyReachShadow',
          label: 'Sky-Reach Shelter (derived mask)',
          type: 'inline',
          parameters: ['skyReachShadowEnabled', 'skyReachShadowOpacity']
        },
        {
          name: 'upperFloorTileShadow',
          label: 'Upper Floor Tile Shadow (floorAlpha)',
          type: 'inline',
          parameters: ['upperFloorTileShadowEnabled', 'upperFloorTileShadowOpacity', 'upperFloorTileShadowLengthScale', 'upperFloorTileCombineMode']
        },
        {
          name: 'debug',
          label: 'Debug',
          type: 'inline',
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
          default: 0.4
        },
        length: {
          type: 'slider',
          label: 'Shadow Length',
          min: 0.0,
          max: 0.3,
          step: 0.005,
          default: 0.040
        },
        softness: {
          type: 'slider',
          label: 'Softness',
          min: 0.5,
          max: 5.0,
          step: 0.1,
          default: 1.0
        },
        outdoorShadowLengthScale: {
          type: 'slider',
          label: 'Outdoor Shadow Length Scale',
          min: 0.0,
          max: 30.0,
          step: 1.00,
          default: 2.0,
          tooltip: 'Scales projected overhead shadow distance on outdoor receivers'
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
          default: 0.75
        },
        fluidColorEnabled: {
          type: 'checkbox',
          label: 'Use Fluid Effect Colour',
          default: true,
          tooltip: 'Tints overhead shadows with FluidEffect colour when fluid overlays are attached to overhead tiles'
        },
        fluidEffectTransparency: {
          type: 'slider',
          label: 'Fluid Effect Transparency',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.35,
          tooltip: 'Opacity of FluidEffect colour tint in overhead shadows'
        },
        fluidShadowIntensityBoost: {
          type: 'slider',
          label: 'Fluid Shadow Intensity Boost',
          min: 0.0,
          max: 5.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Boost multiplier for FluidEffect shadow contribution (up to 500%)'
        },
        fluidShadowSoftness: {
          type: 'slider',
          label: 'Fluid Shadow Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 3.0,
          tooltip: 'Blur radius for FluidEffect tint on outdoor receivers (up to 2x regular shadow softness range)'
        },
        fluidColorBoost: {
          type: 'slider',
          label: 'Fluid Colour Boost',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.5,
          tooltip: 'Boosts fluid colour intensity used to tint overhead shadows'
        },
        fluidColorSaturation: {
          type: 'slider',
          label: 'Fluid Colour Saturation',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.2,
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
          tooltip: 'Scales projection distance for tile-projected shadows relative to roof shadows'
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
          default: 0.10,
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
        indoorShadowEnabled: {
          type: 'checkbox',
          label: 'Enable Outdoor Building Shadow',
          default: true,
          tooltip: 'Injects a projected building-shadow term from _Outdoors dark regions (outdoor receivers only)'
        },
        outdoorBuildingShadowOpacity: {
          type: 'slider',
          label: 'Outdoor Building Shadow Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.42,
          tooltip: 'Strength of projected _Outdoors dark-region contribution on outdoor receivers'
        },
        outdoorBuildingShadowLengthScale: {
          type: 'slider',
          label: 'Outdoor Building Shadow Length Scale',
          min: 0.0,
          max: 30.0,
          step: 0.01,
          default: 4.70,
          tooltip: 'Scale factor for _Outdoors dark-region projection distance'
        },
        indoorShadowSoftness: {
          type: 'slider',
          label: 'Indoor Shadow Softness',
          min: 0.5,
          max: 5.0,
          step: 0.1,
          default: 3.8,
          tooltip: 'Indoor blur radius for overhead, sky-reach shelter, and fluid shadow contributions'
        },
        skyReachShadowEnabled: {
          type: 'checkbox',
          label: 'Enable Sky-Reach Shelter Shadow',
          default: true,
          tooltip: 'Currently forced on in code (uniform always 1). Darkens outdoor receivers where derived skyReach is low.'
        },
        skyReachShadowOpacity: {
          type: 'slider',
          label: 'Sky-Reach Shelter Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.35,
          tooltip: 'How strongly low skyReach (occluded from sky by floors above) adds to the overhead shadow factor'
        },
        upperFloorTileShadowEnabled: {
          type: 'checkbox',
          label: 'Enable Upper Floor Tile Shadow',
          default: true,
          tooltip: 'Composites GPU floorAlpha from every level above the viewer, then projects and softens like building shadow (recommended for bridge decks)'
        },
        upperFloorTileShadowOpacity: {
          type: 'slider',
          label: 'Upper Floor Tile Shadow Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.55,
          tooltip: 'Strength of the projected upper-floor tile-alpha shadow on outdoor receivers'
        },
        upperFloorTileShadowLengthScale: {
          type: 'slider',
          label: 'Upper Floor Tile Shadow Length Scale',
          min: 0.0,
          max: 30.0,
          step: 0.05,
          default: 4.7,
          tooltip: 'Projection distance scale for upper-floor tile shadows (same regime as Outdoor Building Shadow)'
        },
        upperFloorTileCombineMode: {
          type: 'list',
          label: 'Combine Upper Alphas',
          options: {
            Multiply: 'multiply',
            MaxUnion: 'max'
          },
          default: 'multiply',
          tooltip: 'multiply = Π alpha per pixel (strict). max = union — better when several upper bands overlap or have gaps'
        },
        indoorFluidShadowSoftness: {
          type: 'slider',
          label: 'Indoor Fluid Shadow Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 3.1,
          tooltip: 'Blur radius for FluidEffect tint on indoor receivers (up to 2x regular shadow softness range)'
        },
        indoorFluidShadowIntensityBoost: {
          type: 'slider',
          label: 'Indoor Fluid Shadow Intensity Boost',
          min: 0.0,
          max: 5.0,
          step: 0.01,
          default: 0.81,
          tooltip: 'Boost multiplier for FluidEffect colour contribution on indoor receivers (up to 500%)'
        },
        indoorFluidColorSaturation: {
          type: 'slider',
          label: 'Indoor Fluid Colour Saturation',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.2,
          tooltip: 'Saturation multiplier for FluidEffect tint on indoor receivers'
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
            TileProjectionStrength: 'tileCombined',
            SkyReachShelter: 'skyReachShelter'
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

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tRoof: { value: null },
        tRoofVisibility: { value: null },
        uHasRoofVisibility: { value: 0.0 },
        uOpacity: { value: this.params.opacity },
        uLength: { value: this.params.length },
        uSoftness: { value: this.params.softness },
        uOutdoorShadowLengthScale: { value: this.params.outdoorShadowLengthScale ?? 1.0 },
        uIndoorReceiverShadowLengthScale: { value: this.params.indoorReceiverShadowLengthScale ?? 1.0 },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uRoofUvScale: { value: 1.0 },
        uTileProjectionUvScale: { value: 1.0 },
        uSunDir: { value: new THREE.Vector2(0.0, 1.0) },
        uResolution: { value: new THREE.Vector2(1024, 1024) },
        uZoom: { value: 1.0 },
        uHoverRevealActive: { value: 0.0 },
        // Indoor shadow from _Outdoors mask
        uOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        tSkyReach: { value: whiteOb },
        uHasSkyReach: { value: 0.0 },
        uSkyReachFlipY: { value: 0.0 },
        uSkyReachShadowEnabled: { value: 1.0 },
        uSkyReachShadowOpacity: { value: this.params.skyReachShadowOpacity ?? 0.35 },
        tUpperFloorComposite: { value: whiteOb },
        uHasUpperFloorComposite: { value: 0.0 },
        uUpperFloorCompositeFlipY: { value: 0.0 },
        uUpperFloorTileShadowEnabled: { value: 1.0 },
        uUpperFloorTileShadowOpacity: { value: this.params.upperFloorTileShadowOpacity ?? 0.55 },
        uUpperFloorTileShadowLengthScale: { value: this.params.upperFloorTileShadowLengthScale ?? 4.7 },
        // Upper-floor _Outdoors for Outdoor Building Shadow casters only (min across levels above).
        uObUpperOutdoors0: { value: whiteOb },
        uObUpperOutdoors1: { value: whiteOb },
        uObUpperOutdoors2: { value: whiteOb },
        uObUpperOutdoorsFlipY0: { value: 0.0 },
        uObUpperOutdoorsFlipY1: { value: 0.0 },
        uObUpperOutdoorsFlipY2: { value: 0.0 },
        uObUpperCount: { value: 0.0 },
        uIndoorShadowEnabled: { value: 0.0 },
        uOutdoorBuildingShadowOpacity: { value: this.params.outdoorBuildingShadowOpacity ?? this.params.indoorShadowOpacity ?? 0.5 },
        uOutdoorBuildingShadowLengthScale: { value: this.params.outdoorBuildingShadowLengthScale ?? this.params.indoorShadowLengthScale ?? 1.0 },
        uIndoorShadowSoftness: { value: 3.0 },
        uIndoorFluidShadowSoftness: { value: 3.0 },
        uIndoorFluidShadowIntensityBoost: { value: 1.0 },
        uIndoorFluidColorSaturation: { value: 1.2 },
        uFluidColorEnabled: { value: 0.0 },
        uFluidEffectTransparency: { value: 0.35 },
        uFluidShadowIntensityBoost: { value: 1.0 },
        uFluidShadowSoftness: { value: 3.0 },
        uFluidColorBoost: { value: 1.5 },
        uFluidColorSaturation: { value: 1.2 },
        tFluidRoof: { value: null },
        uHasFluidRoof: { value: 0.0 },
        tTileProjection: { value: null },
        uHasTileProjection: { value: 0.0 },
        tTileProjectionSort: { value: null },
        uHasTileProjectionSort: { value: 0.0 },
        tTileReceiverAlpha: { value: null },
        tTileReceiverSort: { value: null },
        uHasTileReceiverSort: { value: 0.0 },
        uTileProjectionEnabled: { value: 0.0 },
        uTileProjectionOpacity: { value: 0.5 },
        uTileProjectionLengthScale: { value: 1.0 },
        uTileProjectionSoftness: { value: 3.0 },
        uTileProjectionThreshold: { value: 0.05 },
        uTileProjectionPower: { value: 1.0 },
        uTileProjectionOutdoorOpacityScale: { value: 1.0 },
        uTileProjectionIndoorOpacityScale: { value: 1.0 },
        uTileProjectionSortBias: { value: 0.002 },
        // Scene dimensions in world pixels for world-space mask UV conversion
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        // Depth pass integration: height-based shadow modulation.
        // Casters must be above receivers to cast shadows — prevents
        // self-shadowing and upward-shadowing using per-pixel depth.
        uDepthTexture: { value: null },
        uDepthEnabled: { value: 0.0 },
        uDepthCameraNear: { value: 800.0 },
        uDepthCameraFar: { value: 1200.0 },
        uGroundDistance: { value: 1000.0 }
        ,
        uDebugView: { value: 0.0 },
        tDynamicLight: { value: null },
        uHasDynamicLight: { value: 0.0 },
        uDynamicLightShadowOverrideEnabled: { value: 1.0 },
        uDynamicLightShadowOverrideStrength: { value: this.params.dynamicLightShadowOverrideStrength ?? 0.7 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tRoof;
        uniform sampler2D tRoofVisibility;
        uniform float uHasRoofVisibility;
        uniform float uOpacity;
        uniform float uLength;
        uniform float uSoftness;
        uniform float uOutdoorShadowLengthScale;
        uniform float uIndoorReceiverShadowLengthScale;
        uniform vec2 uTexelSize;
        uniform float uRoofUvScale;
        uniform float uTileProjectionUvScale;
        uniform vec2 uSunDir;
        uniform vec2 uResolution;
        uniform float uZoom;
        uniform float uHoverRevealActive;

        // Indoor shadow from _Outdoors mask
        uniform sampler2D uOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;
        uniform sampler2D tSkyReach;
        uniform float uHasSkyReach;
        uniform float uSkyReachFlipY;
        uniform float uSkyReachShadowEnabled;
        uniform float uSkyReachShadowOpacity;
        uniform sampler2D tUpperFloorComposite;
        uniform float uHasUpperFloorComposite;
        uniform float uUpperFloorCompositeFlipY;
        uniform float uUpperFloorTileShadowEnabled;
        uniform float uUpperFloorTileShadowOpacity;
        uniform float uUpperFloorTileShadowLengthScale;
        uniform sampler2D uObUpperOutdoors0;
        uniform sampler2D uObUpperOutdoors1;
        uniform sampler2D uObUpperOutdoors2;
        uniform float uObUpperOutdoorsFlipY0;
        uniform float uObUpperOutdoorsFlipY1;
        uniform float uObUpperOutdoorsFlipY2;
        uniform float uObUpperCount;
        uniform float uIndoorShadowEnabled;
        uniform float uOutdoorBuildingShadowOpacity;
        uniform float uOutdoorBuildingShadowLengthScale;
        uniform float uIndoorShadowSoftness;
        uniform float uIndoorFluidShadowSoftness;
        uniform float uIndoorFluidShadowIntensityBoost;
        uniform float uIndoorFluidColorSaturation;
        uniform float uFluidColorEnabled;
        uniform float uFluidEffectTransparency;
        uniform float uFluidShadowIntensityBoost;
        uniform float uFluidShadowSoftness;
        uniform float uFluidColorBoost;
        uniform float uFluidColorSaturation;
        uniform sampler2D tFluidRoof;
        uniform float uHasFluidRoof;
        uniform sampler2D tTileProjection;
        uniform float uHasTileProjection;
        uniform sampler2D tTileProjectionSort;
        uniform float uHasTileProjectionSort;
        uniform sampler2D tTileReceiverAlpha;
        uniform sampler2D tTileReceiverSort;
        uniform float uHasTileReceiverSort;
        uniform float uTileProjectionEnabled;
        uniform float uTileProjectionOpacity;
        uniform float uTileProjectionLengthScale;
        uniform float uTileProjectionSoftness;
        uniform float uTileProjectionThreshold;
        uniform float uTileProjectionPower;
        uniform float uTileProjectionOutdoorOpacityScale;
        uniform float uTileProjectionIndoorOpacityScale;
        uniform float uTileProjectionSortBias;
        // Scene dimensions in world pixels for mask UV conversion
        uniform vec2 uSceneDimensions;

        // Depth pass integration
        uniform sampler2D uDepthTexture;
        uniform float uDepthEnabled;
        uniform float uDepthCameraNear;
        uniform float uDepthCameraFar;
        uniform float uGroundDistance;
        uniform float uDebugView;
        uniform sampler2D tDynamicLight;
        uniform float uHasDynamicLight;
        uniform float uDynamicLightShadowOverrideEnabled;
        uniform float uDynamicLightShadowOverrideStrength;

        varying vec2 vUv;

        // Linearize perspective device depth [0,1] → eye-space distance.
        // Uses the tight depth camera's near/far (NOT main camera).
        float msa_linearizeDepth(float d) {
          float z_ndc = d * 2.0 - 1.0;
          return (2.0 * uDepthCameraNear * uDepthCameraFar) /
                 (uDepthCameraFar + uDepthCameraNear - z_ndc * (uDepthCameraFar - uDepthCameraNear));
        }

        // ClampToEdge + linear filtering can smear border texels when sampling
        // exactly on the 0/1 boundary. Require taps to stay at least half a
        // texel inside texture bounds to keep edge behavior stable.
        float uvInBounds(vec2 uv, vec2 texelSize) {
          // Keep a small safety inset to avoid border-smear taps, but do not
          // reject too aggressively or projected shadows can disappear in a
          // directional diagonal near screen edges.
          vec2 safeMin = max(texelSize * 0.25, vec2(0.0));
          vec2 safeMax = min(vec2(1.0) - texelSize * 0.25, vec2(1.0));
          vec2 ge0 = step(safeMin, uv);
          vec2 le1 = step(uv, safeMax);
          return ge0.x * ge0.y * le1.x * le1.y;
        }

        float readOutdoorsMask(vec2 uv) {
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (uOutdoorsMaskFlipY > 0.5) {
            suv.y = 1.0 - suv.y;
          }
          // Per-floor outdoors masks can be sparse. Outside valid coverage, alpha
          // may be 0 while RGB is black; interpret that as default outdoors (1.0).
          vec4 m = texture2D(uOutdoorsMask, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        float readObUpperSample(sampler2D samp, float flipY, vec2 uv) {
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (flipY > 0.5) suv.y = 1.0 - suv.y;
          vec4 m = texture2D(samp, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        // Outdoor Building Shadow caster: combine _Outdoors from levels above the viewer.
        // min() => treat as "indoor caster" if ANY upper level marks this world XY dark/indoor.
        // When uObUpperCount < 0.5, fall back to the receiver mask (single-floor / top floor).
        float readOutdoorBuildingCasterOutdoors(vec2 uv) {
          if (uObUpperCount < 0.5) {
            return readOutdoorsMask(uv);
          }
          float o = 1.0;
          if (uObUpperCount > 0.5) {
            o = min(o, readObUpperSample(uObUpperOutdoors0, uObUpperOutdoorsFlipY0, uv));
          }
          if (uObUpperCount > 1.5) {
            o = min(o, readObUpperSample(uObUpperOutdoors1, uObUpperOutdoorsFlipY1, uv));
          }
          if (uObUpperCount > 2.5) {
            o = min(o, readObUpperSample(uObUpperOutdoors2, uObUpperOutdoorsFlipY2, uv));
          }
          return o;
        }

        float readSkyReach(vec2 uv) {
          if (uHasSkyReach < 0.5) {
            return 1.0;
          }
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (uSkyReachFlipY > 0.5) {
            suv.y = 1.0 - suv.y;
          }
          vec4 m = texture2D(tSkyReach, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        float readUpperFloorComposite(vec2 uv) {
          if (uHasUpperFloorComposite < 0.5) {
            return 0.0;
          }
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (uUpperFloorCompositeFlipY > 0.5) {
            suv.y = 1.0 - suv.y;
          }
          return clamp(texture2D(tUpperFloorComposite, suv).r, 0.0, 1.0);
        }

        // Compute how far we can travel along delta before leaving [0,1].
        // Returned scale is clamped to [0,1], so callers can safely apply it
        // to their intended offset vector.
        float offsetScaleLimit(float origin, float delta) {
          if (delta > 0.0) return (1.0 - origin) / delta;
          if (delta < 0.0) return (0.0 - origin) / delta;
          return 1e6;
        }

        float offsetTravelScale(vec2 origin, vec2 delta) {
          float kx = offsetScaleLimit(origin.x, delta.x);
          float ky = offsetScaleLimit(origin.y, delta.y);
          return clamp(min(kx, ky), 0.0, 1.0);
        }

        void main() {
          // Screen-space UV for this fragment, matching the roofTarget
          // render that was produced with the same camera.
          vec2 screenUv = gl_FragCoord.xy / uResolution;
          // roofTarget/fluidRoofTarget may be captured with a guard-band
          // expanded camera. Remap current screen UV into that larger capture.
          float roofUvScale = max(uRoofUvScale, 0.0001);
          vec2 roofUv = (screenUv - 0.5) * roofUvScale + 0.5;
          float tileProjectionUvScale = max(uTileProjectionUvScale, 0.0001);
          vec2 tileProjectionUv = (screenUv - 0.5) * tileProjectionUvScale + 0.5;

          // Two direction vectors are needed because the roof sampling and
          // indoor mask sampling operate in different UV spaces:
          //
          // Screen UV (gl_FragCoord / uResolution): Y=0 at the BOTTOM of the
          //   viewport (south on the map).
          // Mesh UV (vUv on basePlane with scale.y=-1 and flipY=false): V=0 at
          //   the TOP of the mesh (north on the map).
          //
          // BuildingShadowsEffect's bake shader uses a standard-UV bake quad
          // where V=0 also maps to north (flipY=false on the _Outdoors mask).
          // So its +dir.y points north in its UV space. To get the same visual
          // direction in screen UV we must negate Y, because screen Y=0 is south.
          //
          // dir        — mesh/mask UV space (V=0 = north, matches bake UV)
          // screenDir  — screen UV space (Y=0 = south, needs Y flip)
          vec2 dir = normalize(uSunDir);
          vec2 screenDir = normalize(vec2(uSunDir.x, -uSunDir.y));

          // Receiver-space classification (at the current fragment).
          // White in _Outdoors = outdoors, black = indoors.
          bool hasOutdoorsMask = (uHasOutdoorsMask > 0.5);
          float receiverOutdoors = hasOutdoorsMask ? readOutdoorsMask(vUv) : 1.0;
          float receiverIndoor = 1.0 - receiverOutdoors;
          float receiverIsOutdoors = step(0.5, receiverOutdoors);
          float receiverIsIndoor = 1.0 - receiverIsOutdoors;

          // Scale length by zoom so the world-space band stays
          // approximately constant as the camera zoom changes.
          // We use a reference height of 1080px to convert the normalized uLength
          // into a pixel distance. This ensures the shadow length is stable across
          // different resolutions (resolution-independent) and aspect ratios.
          // uLength (0.04) * 1080 ~= 43 pixels at Zoom 1.
          float receiverLengthScale = mix(
            max(uOutdoorShadowLengthScale, 0.0),
            max(uIndoorReceiverShadowLengthScale, 0.0),
            receiverIndoor
          );
          float pixelLen = uLength * 1080.0 * max(uZoom, 0.0001) * receiverLengthScale;

          // Sample the roof mask at an offset along screenDir. We look for
          // roof pixels in the +screenDir direction so shadow extends in
          // -screenDir, matching BuildingShadowsEffect's visual convention.
          vec2 baseOffsetDeltaUv = screenDir * pixelLen * uTexelSize * roofUvScale;
          float baseOffsetScaleX = clamp(offsetScaleLimit(roofUv.x, baseOffsetDeltaUv.x), 0.0, 1.0);
          float baseOffsetScaleY = clamp(offsetScaleLimit(roofUv.y, baseOffsetDeltaUv.y), 0.0, 1.0);
          float baseOffsetScale = min(baseOffsetScaleX, baseOffsetScaleY);
          float baseOffsetScaleAvg = 0.5 * (baseOffsetScaleX + baseOffsetScaleY);
          // Smooth edge falloff: when we cannot travel full projection distance
          // near viewport borders, fade contribution to avoid smear bands from
          // heavily compressed sample neighborhoods.
          // Keep a non-zero floor so projection degrades instead of vanishing.
          // Keep stronger contribution near borders so overlap at the top/left
          // of the viewport does not collapse into a directional diagonal cut.
          float baseEdgeFade = mix(0.65, 1.0, smoothstep(0.0, 1.0, baseOffsetScaleAvg));
          vec2 offsetUv = roofUv + vec2(
            baseOffsetDeltaUv.x * baseOffsetScaleX,
            baseOffsetDeltaUv.y * baseOffsetScaleY
          );
          // Suppress self-shadowing on the caster layer itself.
          // Keep an unmodified receiver roof coverage mask so non-roof shadow
          // contributions (e.g. Outdoor Building Shadow) stay below overhead tiles.
          float roofCoverageAlpha = clamp(texture2D(tRoof, clamp(roofUv, 0.0, 1.0)).a, 0.0, 1.0);
          // Building-shadow suppression should follow the runtime roof fade
          // state (hover-reveal/visibility) rather than the forced-opacity
          // caster capture in tRoof.
          float roofVisibilityAlpha = roofCoverageAlpha;
          if (uHasRoofVisibility > 0.5) {
            roofVisibilityAlpha = clamp(texture2D(tRoofVisibility, clamp(screenUv, 0.0, 1.0)).a, 0.0, 1.0);
          }
          // Receiver-side self-mask baseline must follow runtime view-floor roof
          // visibility (not the revealed caster capture). This allows upper-floor
          // revealed casters to project onto lower floors without being canceled
          // as if they were local receiver coverage.
          float roofBaseAlpha = roofVisibilityAlpha;
          // Tree-style unmasking behavior during hover reveal: keep caster
          // projection active, but stop masking it out under the source roof.
          roofBaseAlpha *= (1.0 - clamp(uHoverRevealActive, 0.0, 1.0));

          bool tileProjectionEnabled = (uTileProjectionEnabled > 0.5 && uHasTileProjection > 0.5);
          float tileProjectionLengthScale = max(uTileProjectionLengthScale, 0.0);
          float projectedPixelLen = pixelLen * tileProjectionLengthScale;
          vec2 projectedOffsetDeltaUv = screenDir * projectedPixelLen * uTexelSize * tileProjectionUvScale;
          float projectedOffsetScaleX = clamp(offsetScaleLimit(tileProjectionUv.x, projectedOffsetDeltaUv.x), 0.0, 1.0);
          float projectedOffsetScaleY = clamp(offsetScaleLimit(tileProjectionUv.y, projectedOffsetDeltaUv.y), 0.0, 1.0);
          float projectedOffsetScale = min(projectedOffsetScaleX, projectedOffsetScaleY);
          float projectedOffsetScaleAvg = 0.5 * (projectedOffsetScaleX + projectedOffsetScaleY);
          // Keep a non-zero floor so tile projection degrades instead of vanishing.
          float projectedEdgeFade = mix(0.65, 1.0, smoothstep(0.0, 1.0, projectedOffsetScaleAvg));
          vec2 projectedOffsetUv = tileProjectionUv + vec2(
            projectedOffsetDeltaUv.x * projectedOffsetScaleX,
            projectedOffsetDeltaUv.y * projectedOffsetScaleY
          );
          // Same rule for tile projection casters: do not project onto the
          // tile's own layer footprint at the receiver pixel.
          float tileBaseAlpha = clamp(texture2D(tTileProjection, clamp(tileProjectionUv, 0.0, 1.0)).a, 0.0, 1.0);

          // ---- Depth pass: height-based shadow modulation ----
          // IMPORTANT: Keep depth gating only for tile projection shadows.
          //
          // Roof/indoor overhead shadow continuity intentionally does NOT use
          // this gate, because hover-hidden roofs fade out of the main depth
          // pass (depthWrite disabled near zero opacity) while we still need
          // their captured roof mask to cast shadows. Applying depthMod there
          // also suppresses _Outdoors dark-region contribution in outdoor space.
          float depthTileProjectionMod = 1.0;
          if (uDepthEnabled > 0.5 && tileProjectionEnabled) {
            float receiverDevice = texture2D(uDepthTexture, screenUv).r;
            if (receiverDevice < 0.9999) {
              float receiverLinear = msa_linearizeDepth(receiverDevice);
              float receiverHeight = uGroundDistance - receiverLinear;

              // Tile projection caster height (uses projection-length offset)
              vec2 tileCasterUv = screenUv + screenDir * projectedPixelLen * uTexelSize * projectedOffsetScale;
              float tileCasterDevice = texture2D(uDepthTexture, tileCasterUv).r;
              if (tileCasterDevice < 0.9999) {
                float tileCasterLinear = msa_linearizeDepth(tileCasterDevice);
                float tileCasterHeight = uGroundDistance - tileCasterLinear;
                // Preserve projection for same-height casters (common for tile->tile
                // projections) and only suppress clearly lower casters.
                float tileHeightDiff = tileCasterHeight - receiverHeight;
                depthTileProjectionMod = smoothstep(-2.0, -0.1, tileHeightDiff);
              }
            }
          }

          // Prepare indoor/outdoor mask sampling in world UV (mask space).
          // We use this for two jobs:
          // 1) Receiver/caster region matching (clip shadows that cross the
          //    indoor/outdoor boundary)
          // 2) Optional indoor-only shadow contribution
          bool indoorEnabled = (uIndoorShadowEnabled > 0.5 && hasOutdoorsMask);
          vec2 maskTexelSize = vec2(1.0) / max(uSceneDimensions, vec2(1.0));
          // Keep _Outdoors dark-region taps projected with sun direction so
          // building-shadow motion remains consistent with roof projection.
          // _Outdoors dark-region projection is sampled in world/scene UV.
          // Keep this path zoom-stable (do NOT scale by camera zoom).
          float buildingMaskPixelLenBase = uLength * 1080.0;
          float maskPixelLenBase = uLength * 1080.0 * receiverLengthScale;
          float maskPixelLenIndoor = buildingMaskPixelLenBase * max(uOutdoorBuildingShadowLengthScale, 0.0);
          float maskPixelLenProjected = maskPixelLenBase * tileProjectionLengthScale;
          // Region matching and tile-projection region checks should use the same
          // world-UV sampling direction as the roof projection path.
          vec2 maskProjectDir = dir;
          vec2 maskOffsetUvBase = vUv + maskProjectDir * maskPixelLenBase * maskTexelSize;
          vec2 maskOffsetUvIndoor = vUv + maskProjectDir * maskPixelLenIndoor * maskTexelSize;
          vec2 maskOffsetUvProjected = vUv + maskProjectDir * maskPixelLenProjected * maskTexelSize;
          float upperTileMaskPixelLen = uLength * 1080.0 * max(uUpperFloorTileShadowLengthScale, 0.0);
          vec2 maskOffsetUvUpperTile = vUv + maskProjectDir * upperTileMaskPixelLen * maskTexelSize;
          vec2 upperTileMaskDelta = maskProjectDir * upperTileMaskPixelLen * maskTexelSize;
          float upperTileTravelScale = offsetTravelScale(vUv, upperTileMaskDelta);
          float upperTileEdgeFade = mix(0.65, 1.0, smoothstep(0.0, 1.0, upperTileTravelScale));
          // World/mesh UV travel for _Outdoors building shadow only — do not tie
          // this to screen-space roof projection (baseEdgeFade). Short roof
          // projection or viewport clamping was incorrectly zeroing building shadow.
          vec2 outdoorBuildingMaskDelta = maskProjectDir * maskPixelLenIndoor * maskTexelSize;
          float outdoorBuildingTravelScale = offsetTravelScale(vUv, outdoorBuildingMaskDelta);
          float outdoorBuildingEdgeFade = mix(0.65, 1.0, smoothstep(0.0, 1.0, outdoorBuildingTravelScale));

          // Apply indoor/outdoor softness selection uniformly so all shadow
          // components (roof, indoor mask, and fluid tint) blur consistently.
          float blurSoftness = mix(uSoftness, uIndoorShadowSoftness, receiverIsIndoor);
          // Keep blur footprint in the same zoom regime as projection length.
          // Without this, shadows appear to sharpen/soften while zooming even
          // when the caster offset is otherwise world-stable.
          float zoomScale = max(uZoom, 0.0001);
          vec2 stepUv = uTexelSize * blurSoftness * roofUvScale * zoomScale;
          vec2 maskStepUv = maskTexelSize * blurSoftness * 4.0 * zoomScale;
          // Indoor dark-region taps are world/scene-UV based, so keep their blur
          // radius independent of camera zoom to avoid zoom-linked swim.
          vec2 indoorMaskStepUv = maskTexelSize * blurSoftness * 4.0;
          float fluidBlurSoftness = mix(uFluidShadowSoftness, uIndoorFluidShadowSoftness, receiverIndoor);
          vec2 fluidStepUv = uTexelSize * fluidBlurSoftness * roofUvScale * zoomScale;
          vec2 maskFluidStepUv = maskTexelSize * fluidBlurSoftness * 4.0 * zoomScale;

          float accum = 0.0;
          float weightSum = 0.0;
          float skyReachAccum = 0.0;
          for (int dy = -2; dy <= 2; dy++) {
            for (int dx = -2; dx <= 2; dx++) {
              vec2 sUv = offsetUv + vec2(float(dx), float(dy)) * stepUv;
              // Edge handling: allow taps very close to the border to contribute.
              // Hard validity clipping here can cause visible screen-edge cut lines
              // when projected UVs are clamped near top/left.
              float sUvValid = uvInBounds(sUv, uTexelSize * 0.05);
              float wx = 1.0 - (abs(float(dx)) / 3.0);
              float wy = 1.0 - (abs(float(dy)) / 3.0);
              float w = max(wx * wy, 0.0001);
              float wEffective = w * sUvValid;

              // Roof tap (screen-space)
              float roofTap = texture2D(tRoof, clamp(sUv, 0.0, 1.0)).a * sUvValid;
              float roofProjectedOnlyTap = max(roofTap - roofBaseAlpha, 0.0);
              float roofStrengthTap = clamp(roofProjectedOnlyTap * uOpacity, 0.0, 1.0);
              roofStrengthTap *= baseEdgeFade;

              // Region clipping (receiver floor _Outdoors only): mask-offset tap
              // uses the VIEWED floor's mask at sun-offset UV — not the upstairs
              // caster's classification. On outdoor ground under an upper slab,
              // that offset often lands on "indoor" building footprint on the
              // ground map while tRoof correctly captures the upper-floor caster;
              // sameRegionTap would zero the stamp (felt like "upper mask" killing
              // downstairs shadow). Skip offset clip for outdoor receivers; keep
              // full clip for indoor receivers so overhead does not leak outdoors→indoors.
              vec2 maskJitterUv = vec2(float(dx), float(dy)) * maskStepUv;
              vec2 indoorMaskJitterUv = vec2(float(dx), float(dy)) * indoorMaskStepUv;
              float sameRegionTap = hasOutdoorsMask ? 0.0 : 1.0;
              if (hasOutdoorsMask) {
                vec2 mUvBase = maskOffsetUvBase + maskJitterUv;
                float mUvBaseValid = uvInBounds(mUvBase, maskTexelSize);
                if (mUvBaseValid > 0.5) {
                  float casterOutdoorsBase = readOutdoorsMask(mUvBase);
                  float casterIsOutdoors = step(0.5, casterOutdoorsBase);
                  float casterIsIndoor = 1.0 - casterIsOutdoors;
                  // Explicit region split so indoor casters only project to
                  // indoor receivers and outdoor casters only to outdoor receivers.
                  sameRegionTap = receiverIsOutdoors * casterIsOutdoors + receiverIsIndoor * casterIsIndoor;
                }
                float roofRegionTap = (receiverIsOutdoors > 0.5) ? 1.0 : sameRegionTap;
                roofStrengthTap *= roofRegionTap;
              }
              // Indoor dark regions (black in _Outdoors) should not receive
              // overhead roof projection. This preserves independent control of
              // interior darkness via dedicated indoor lighting/shadow systems.
              roofStrengthTap *= receiverIsOutdoors;

              // Dark-region tap (world-space _Outdoors mask)
              // This is a separate projected building-shadow term sourced from
              // indoor (_Outdoors dark) casters and applied to outdoor receivers.
              float indoorStrengthTap = 0.0;
              if (indoorEnabled) {
                vec2 mUvIndoor = maskOffsetUvIndoor + indoorMaskJitterUv;
                float mUvIndoorValid = uvInBounds(mUvIndoor, maskTexelSize);
                if (mUvIndoorValid > 0.5) {
                  float casterOutdoorsIndoor = readOutdoorBuildingCasterOutdoors(mUvIndoor);
                  float casterIndoorsIndoor = 1.0 - casterOutdoorsIndoor;
                  indoorStrengthTap = clamp(casterIndoorsIndoor * uOutdoorBuildingShadowOpacity * receiverIsOutdoors, 0.0, 1.0);
                  // Keep outdoor-building contribution out from directly under
                  // currently visible overhead coverage on the VIEWED floor.
                  // Use roofVisibilityAlpha (view-floor state), not roofCoverageAlpha
                  // (revealed caster capture), so masking differs correctly by
                  // active level and does not inherit upper-floor reveal state.
                  indoorStrengthTap *= (1.0 - roofVisibilityAlpha);
                  indoorStrengthTap *= outdoorBuildingEdgeFade;
                }
              }

              float skyReachStrengthTap = 0.0;
              if (uSkyReachShadowEnabled > 0.5 && uHasSkyReach > 0.5) {
                // Match upper-floor mask projection: sample skyReach along sun offset in mask UV.
                vec2 skyUv = maskOffsetUvUpperTile + indoorMaskJitterUv;
                float skyUvValid = uvInBounds(skyUv, maskTexelSize);
                if (skyUvValid > 0.5) {
                  float skyR = readSkyReach(skyUv);
                  float shelter = receiverIsOutdoors * (1.0 - skyR) * max(uSkyReachShadowOpacity, 0.0) * upperTileEdgeFade;
                  // Do NOT multiply by (1 - roofVisibilityAlpha) here. That gate is correct for the
                  // _Outdoors building-shadow term (view-floor overhead coverage), but upper-floor
                  // bridge slabs are revealed into tRoofVisibility during capture — under the deck,
                  // roofVisibilityAlpha is often ~1 while skyReach encodes the desired shelter.
                  // max(roofStrengthTap, skyReachStrengthTap) already avoids double-darkening.
                  skyReachStrengthTap = clamp(shelter, 0.0, 1.0);
                }
              }

              float upperFloorTileTap = 0.0;
              if (uUpperFloorTileShadowEnabled > 0.5 && uHasUpperFloorComposite > 0.5) {
                vec2 mUvUpper = maskOffsetUvUpperTile + indoorMaskJitterUv;
                float mUvUpperValid = uvInBounds(mUvUpper, maskTexelSize);
                if (mUvUpperValid > 0.5) {
                  float ua = readUpperFloorComposite(mUvUpper);
                  upperFloorTileTap = clamp(
                    ua * max(uUpperFloorTileShadowOpacity, 0.0) * receiverIsOutdoors * upperTileEdgeFade,
                    0.0,
                    1.0
                  );
                }
              }

              // Combine BEFORE blur.
              float combinedTap = max(roofStrengthTap, max(indoorStrengthTap, max(skyReachStrengthTap, upperFloorTileTap)));
              accum += combinedTap * wEffective;
              skyReachAccum += skyReachStrengthTap * wEffective;
              weightSum += wEffective;
            }
          }

          float combinedStrength = (weightSum > 0.0) ? (accum / weightSum) : 0.0;
          float skyReachShelterAvg = (weightSum > 0.0) ? (skyReachAccum / weightSum) : 0.0;

          float tileProjectedStrength = 0.0;
          if (tileProjectionEnabled) {
            float projectedSoftness = max(uTileProjectionSoftness, 0.5);
            vec2 projectedStepUv = uTexelSize * projectedSoftness * tileProjectionUvScale * zoomScale;
            float projectedAccum = 0.0;
            float projectedWeightSum = 0.0;
            float projectionReceiverScale = mix(max(uTileProjectionOutdoorOpacityScale, 0.0), max(uTileProjectionIndoorOpacityScale, 0.0), receiverIndoor);
            bool hasTileSortOcclusion = (uHasTileProjectionSort > 0.5 && uHasTileReceiverSort > 0.5);
            float receiverTileAlpha = hasTileSortOcclusion ? clamp(texture2D(tTileReceiverAlpha, screenUv).a, 0.0, 1.0) : 0.0;
            float receiverTileSortEncoded = hasTileSortOcclusion ? clamp(texture2D(tTileReceiverSort, screenUv).a, 0.0, 1.0) : 0.0;
            float receiverTileSortNorm = (receiverTileAlpha > 0.0001)
              ? clamp(receiverTileSortEncoded / receiverTileAlpha, 0.0, 1.0)
              : 0.0;

            for (int pdy = -2; pdy <= 2; pdy++) {
              for (int pdx = -2; pdx <= 2; pdx++) {
                vec2 pUv = projectedOffsetUv + vec2(float(pdx), float(pdy)) * projectedStepUv;
                float pUvValid = uvInBounds(pUv, uTexelSize * 0.05);
                float pwx = 1.0 - (abs(float(pdx)) / 3.0);
                float pwy = 1.0 - (abs(float(pdy)) / 3.0);
                float pw = max(pwx * pwy, 0.0001);
                float pwEffective = pw * pUvValid;

                float tileAlphaTap = clamp(texture2D(tTileProjection, clamp(pUv, 0.0, 1.0)).a, 0.0, 1.0) * pUvValid;
                float tileProjectedOnlyTap = max(tileAlphaTap - tileBaseAlpha, 0.0);
                float thresholdDenom = max(1.0 - uTileProjectionThreshold, 0.0001);
                float tileMaskedTap = clamp((tileProjectedOnlyTap - uTileProjectionThreshold) / thresholdDenom, 0.0, 1.0);
                tileMaskedTap = pow(tileMaskedTap, max(uTileProjectionPower, 0.0001));

                float sortGate = 1.0;
                if (hasTileSortOcclusion && receiverTileAlpha > 0.0001 && tileAlphaTap > 0.0001) {
                  float casterTileSortEncoded = clamp(texture2D(tTileProjectionSort, clamp(pUv, 0.0, 1.0)).a, 0.0, 1.0);
                  float casterTileSortNorm = clamp(casterTileSortEncoded / tileAlphaTap, 0.0, 1.0);
                  float requiredCasterSort = receiverTileSortNorm + max(uTileProjectionSortBias, 0.0);
                  // Only allow projection when the caster sort is above the
                  // currently visible receiver tile sort. This prevents tiles
                  // from projecting shadows "onto" tiles layered above them.
                  sortGate = step(requiredCasterSort, casterTileSortNorm);
                }

                // Tile projection is intentionally NOT clipped by _Outdoors region.
                // This keeps projected tile shadows visible indoors and outdoors.
                float sameProjectionRegionTap = 1.0;

                float tileStrengthTap = clamp(tileMaskedTap * uTileProjectionOpacity * projectionReceiverScale * sameProjectionRegionTap * sortGate, 0.0, 1.0);
                tileStrengthTap *= projectedEdgeFade;
                projectedAccum += tileStrengthTap * pwEffective;
                projectedWeightSum += pwEffective;
              }
            }

            tileProjectedStrength = (projectedWeightSum > 0.0) ? (projectedAccum / projectedWeightSum) : 0.0;
            // Depth-based height gate: suppress tile shadow when caster is not above receiver
            tileProjectedStrength *= depthTileProjectionMod;
          }

          // Keep roof/indoor/fluid contribution separate from tile projection.
          // LightingEffect can then route tile projection through its own path
          // without inheriting roof/outdoor masking behavior.
          float roofCombinedStrength = combinedStrength;
          float tileOnlyStrength = tileProjectedStrength;

          if (uHasDynamicLight > 0.5 && uDynamicLightShadowOverrideEnabled > 0.5) {
            vec3 dyn = texture2D(tDynamicLight, clamp(screenUv, vec2(0.0), vec2(1.0))).rgb;
            float dynI = clamp(max(dyn.r, max(dyn.g, dyn.b)), 0.0, 1.0);
            float dynPresence = smoothstep(0.02, 0.30, dynI);
            float dynLift = clamp(dynPresence * max(uDynamicLightShadowOverrideStrength, 0.0), 0.0, 1.0);
            roofCombinedStrength = mix(roofCombinedStrength, 0.0, dynLift);
            tileOnlyStrength = mix(tileOnlyStrength, 0.0, dynLift);
          }

          // Fluid tint gets its own softer blur path with larger 5x5 Gaussian
          // kernel. This avoids harsh tint edges when the fluid softness sliders
          // are pushed above regular shadow softness.
          float fluidAccumA = 0.0;
          vec3 fluidAccumRgb = vec3(0.0);
          float fluidWeightSum = 0.0;
          if (uFluidColorEnabled > 0.5 && uHasFluidRoof > 0.5) {
            for (int fdy = -2; fdy <= 2; fdy++) {
              for (int fdx = -2; fdx <= 2; fdx++) {
                vec2 fUv = offsetUv + vec2(float(fdx), float(fdy)) * fluidStepUv;
                float fUvValid = uvInBounds(fUv, uTexelSize * 0.05);
                vec2 maskJitterFluidUv = vec2(float(fdx), float(fdy)) * maskFluidStepUv;
                float wx = 1.0 - (abs(float(fdx)) / 3.0);
                float wy = 1.0 - (abs(float(fdy)) / 3.0);
                float fw = max(wx * wy, 0.0001);
                float fwEffective = fw * fUvValid;

                float sameRegionFluidTap = 1.0;
                if (hasOutdoorsMask) {
                  vec2 mUvFluid = maskOffsetUvBase + maskJitterFluidUv;
                  float mUvFluidValid = uvInBounds(mUvFluid, maskTexelSize);
                  if (mUvFluidValid > 0.5) {
                    float casterOutdoorsFluid = readOutdoorsMask(mUvFluid);
                    float casterIsOutdoorsFluid = step(0.5, casterOutdoorsFluid);
                    sameRegionFluidTap = 1.0 - abs(casterIsOutdoorsFluid - receiverIsOutdoors);
                  }
                  if (receiverIsOutdoors > 0.5) {
                    sameRegionFluidTap = 1.0;
                  }
                }

                vec4 fluidTap = texture2D(tFluidRoof, clamp(fUv, 0.0, 1.0));
                float fa = clamp(fluidTap.a, 0.0, 1.0) * sameRegionFluidTap;
                fa *= fUvValid;
                fa *= baseEdgeFade;
                fluidAccumA += fa * fw;
                // Fluid capture can be straight or premultiplied depending on
                // renderer/material state. Reconstruct tap color from alpha so
                // tint remains chromatic (instead of collapsing toward black).
                vec3 fluidTapColor = (fluidTap.a > 0.0001)
                  ? clamp(fluidTap.rgb / fluidTap.a, 0.0, 1.0)
                  : vec3(0.0);
                fluidAccumRgb += fluidTapColor * fa * fw;
                fluidWeightSum += fwEffective;
              }
            }
          }

          // Encode shadow factor in the red channel (1.0 = fully lit,
          // 0.0 = fully shadowed).
          float shadowFactor = 1.0 - roofCombinedStrength;
          float tileShadowFactor = 1.0 - tileOnlyStrength;
          vec3 shadowRgb = vec3(shadowFactor);

          if (uFluidColorEnabled > 0.5 && uHasFluidRoof > 0.5 && fluidAccumA > 0.0001) {
            float fluidBlurAlpha = fluidAccumA / max(fluidWeightSum, 0.0001);
            vec3 fluidBlurColor = fluidAccumRgb / max(fluidAccumA, 0.0001);
            float fluidLuma = dot(fluidBlurColor, vec3(0.2126, 0.7152, 0.0722));
            // Blend indoor/outdoor tint controls using the continuous indoor
            // weight so partially covered pixels are not stuck on one branch.
            float fluidSaturation = mix(max(uFluidColorSaturation, 0.0), max(uIndoorFluidColorSaturation, 0.0), receiverIndoor);
            fluidBlurColor = mix(vec3(fluidLuma), fluidBlurColor, fluidSaturation);
            fluidBlurColor = clamp(fluidBlurColor * max(uFluidColorBoost, 0.0), 0.0, 1.0);
            float fluidIntensityBoost = mix(max(uFluidShadowIntensityBoost, 0.0), max(uIndoorFluidShadowIntensityBoost, 0.0), receiverIndoor);
            // Root cause of subtle indoor tint: intensity boost previously only
            // affected mix amount, while tint darkness stayed capped by a weak
            // indoor combinedStrength. Apply boost to tint strength too.
            float tintedStrength = clamp(combinedStrength * fluidIntensityBoost, 0.0, 1.0);
            float fluidTintMix = clamp(fluidBlurAlpha * uFluidEffectTransparency * fluidIntensityBoost, 0.0, 1.0);
            vec3 tintedShadow = 1.0 - tintedStrength * (1.0 - fluidBlurColor);
            shadowRgb = mix(shadowRgb, tintedShadow, fluidTintMix);
          }

          // Debug visualizations for overhead-shadow masking stages.
          // 0: final output (default)
          // 1: receiverOutdoors
          // 2: roofCoverageAlpha
          // 3: roofVisibilityAlpha
          // 4: roofBaseAlpha
          // 5: roofCombinedStrength
          // 6: tileOnlyStrength
          // 7: skyReachShelterAvg (blurred sky-reach-only contribution)
          if (uDebugView > 0.5) {
            float d = 0.0;
            if (uDebugView < 1.5) {
              d = receiverOutdoors;
            } else if (uDebugView < 2.5) {
              d = roofCoverageAlpha;
            } else if (uDebugView < 3.5) {
              d = roofVisibilityAlpha;
            } else if (uDebugView < 4.5) {
              d = roofBaseAlpha;
            } else if (uDebugView < 5.5) {
              d = roofCombinedStrength;
            } else if (uDebugView < 6.5) {
              d = tileOnlyStrength;
            } else {
              d = skyReachShelterAvg;
            }
            gl_FragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
            return;
          }

          // Encode dedicated tile-projection factor in alpha so compositing can
          // apply it independently from roof/outdoor gating.
          gl_FragColor = vec4(shadowRgb, tileShadowFactor);
        }
      `,
      transparent: false
    });

    this.shadowMesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.shadowMesh.position.copy(this.baseMesh.position);
    this.shadowMesh.rotation.copy(this.baseMesh.rotation);
    this.shadowMesh.scale.copy(this.baseMesh.scale);

    // Ensure the shadow mesh is visible to cameras even when FloorCompositor
    // is rendering with floor-isolated layer masks.
    this.shadowMesh.layers.set(0);

    this.shadowScene.add(this.shadowMesh);
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!width || !height || !THREE) return;

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

    const ctW = Math.max(1, Math.floor(width / 2));
    const ctH = Math.max(1, Math.floor(height / 2));
    if (!this.ceilingTransmittanceTarget) {
      this.ceilingTransmittanceTarget = new THREE.WebGLRenderTarget(ctW, ctH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
      });
    } else {
      this.ceilingTransmittanceTarget.setSize(ctW, ctH);
    }
    try {
      if (this.renderer && this.ceilingTransmittanceTarget) {
        const prevTarget = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this.ceilingTransmittanceTarget);
        this.renderer.setClearColor(0xffffff, 1);
        this.renderer.clear();
        this.renderer.setRenderTarget(prevTarget);
      }
    } catch (_) {}

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
    if (!this.material || !this.params.enabled) return;

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
    const outdoorBuildingShadow = this._resolveOutdoorBuildingShadowParams();
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
    const updateHash = `${hour.toFixed(3)}_${this.params.sunLatitude}_${this.params.opacity}_${this.params.length}_${this.params.softness}_${this.params.outdoorShadowLengthScale}_${this.params.indoorReceiverShadowLengthScale}_${camZoom.toFixed(4)}_${this.params.indoorShadowEnabled}_${outdoorBuildingShadow.opacity}_${outdoorBuildingShadow.lengthScale}_${this.params.indoorShadowSoftness}_${this.params.indoorFluidShadowSoftness}_${this.params.indoorFluidShadowIntensityBoost}_${this.params.indoorFluidColorSaturation}_${this.params.tileProjectionEnabled}_${this.params.tileProjectionOpacity}_${this.params.tileProjectionLengthScale}_${this.params.tileProjectionSoftness}_${this.params.tileProjectionThreshold}_${this.params.tileProjectionPower}_${this.params.tileProjectionOutdoorOpacityScale}_${this.params.tileProjectionIndoorOpacityScale}_${this.params.tileProjectionSortBias}_${this.params.fluidColorEnabled}_${this.params.fluidEffectTransparency}_${this.params.fluidShadowIntensityBoost}_${this.params.fluidShadowSoftness}_${this.params.fluidColorBoost}_${this.params.fluidColorSaturation}_${this.params.skyReachShadowOpacity}_${this.params.upperFloorTileShadowEnabled}_${this.params.upperFloorTileShadowOpacity}_${this.params.upperFloorTileShadowLengthScale}_${this.params.upperFloorTileCombineMode}_${this.params.debugView}_${hoverRevealActive ? 1 : 0}_${floorContextSig}`;

    const receiverMask = this._resolveReceiverOutdoorsMaskTexture();
    const receiverSkyReach = this._resolveReceiverSkyReachMaskTexture();
    const upperObTextures = this._collectUpperFloorOutdoorsTextures();
    const obUpperSig = upperObTextures.map((t) => t?.uuid ?? '').join('|');
    const upperFloorAlphaTextures = this._collectUpperFloorFloorAlphaTextures();
    const upperFloorAlphaSig = upperFloorAlphaTextures.map((t) => t?.uuid ?? '').join('|');

    // Floor/mask transitions can swap outdoorsMask without changing scalar params.
    // Do not early-return on unchanged updateHash: Tweakpane writes directly to
    // effect.params; skipping update() made strength sliders appear to do nothing.
    this._lastUpdateHash = updateHash;

    // Map hour to a full 24h sun azimuth orbit.
    // 12h (noon)    ->   0
    //  6h (sunrise) -> -PI/2
    // 18h (sunset)  -> +PI/2
    //  0h/24h       -> -PI (same direction as +PI, continuous wrap)
    const t = (hour % 24.0) / 24.0;
    const azimuth = (t - 0.5) * (Math.PI * 2.0);

    // Sun direction MUST be identical to BuildingShadowsEffect so both
    // effects follow the same daily arc. The shader projection sign (+dir)
    // is what makes both shadow directions visually consistent.
    let x = -Math.sin(azimuth);

    const lat = Math.max(0.0, Math.min(1.0, this.params.sunLatitude ?? 0.5));
    let y = -Math.cos(azimuth) * lat;

    // Keep shader direction valid even when latitude is zero (or extremely low),
    // where full-orbit noon/midnight can collapse to a near-zero vector.
    const dirLenSq = (x * x) + (y * y);
    if (dirLenSq < 1e-8) {
      const prevX = Number(this.sunDir?.x);
      const prevY = Number(this.sunDir?.y);
      const prevLenSq = (prevX * prevX) + (prevY * prevY);
      if (Number.isFinite(prevLenSq) && prevLenSq > 1e-8) {
        x = prevX;
        y = prevY;
      } else {
        // East/west fallback based on local azimuth trend.
        x = Math.cos(azimuth) >= 0.0 ? -1.0 : 1.0;
        y = 0.0;
      }
    }

    if (!this.sunDir) {
      this.sunDir = new THREE.Vector2(x, y);
    } else {
      this.sunDir.set(x, y);
    }
    if (this.material && this.material.uniforms.uSunDir) {
      this.material.uniforms.uSunDir.value.copy(this.sunDir);
    }

    // Drive basic uniforms from params and camera zoom.
    if (this.material) {
      const u = this.material.uniforms;
      const outdoorBuildingShadowOpacity = outdoorBuildingShadow.opacity;
      const outdoorBuildingShadowLengthScale = outdoorBuildingShadow.lengthScale;
      if (u.uOpacity) u.uOpacity.value = this.params.opacity;
      if (u.uLength)  u.uLength.value  = this.params.length;
      if (u.uSoftness) u.uSoftness.value = this.params.softness;
      if (u.uHoverRevealActive) u.uHoverRevealActive.value = hoverRevealActive ? 1.0 : 0.0;
      if (u.uOutdoorShadowLengthScale) u.uOutdoorShadowLengthScale.value = this.params.outdoorShadowLengthScale ?? 1.0;
      if (u.uIndoorReceiverShadowLengthScale) u.uIndoorReceiverShadowLengthScale.value = this.params.indoorReceiverShadowLengthScale ?? 1.0;
      if (u.uZoom && this.mainCamera) {
        u.uZoom.value = camZoom;
      }
      // Outdoor Building Shadow: projected _Outdoors dark-region term (outdoor
      // receivers) that helps visually connect overhead-only roof details
      // (ornaments, floating elements) back to the building mass.
      //
      // NOTE: Keep this directly user-controlled even when
      // BuildingShadowsEffectV2 is enabled; that effect cannot replace this
      // per-overhead-layer continuity contribution in all scenes.
      const outdoorBuildingContributionEnabled = !!this.params.indoorShadowEnabled;
      if (u.uIndoorShadowEnabled) u.uIndoorShadowEnabled.value = outdoorBuildingContributionEnabled ? 1.0 : 0.0;
      if (u.uOutdoorBuildingShadowOpacity) u.uOutdoorBuildingShadowOpacity.value = outdoorBuildingShadowOpacity;
      if (u.uOutdoorBuildingShadowLengthScale) u.uOutdoorBuildingShadowLengthScale.value = outdoorBuildingShadowLengthScale;
      if (u.uIndoorShadowSoftness) u.uIndoorShadowSoftness.value = this.params.indoorShadowSoftness;
      if (u.uIndoorFluidShadowSoftness) u.uIndoorFluidShadowSoftness.value = this.params.indoorFluidShadowSoftness;
      if (u.uIndoorFluidShadowIntensityBoost) u.uIndoorFluidShadowIntensityBoost.value = this.params.indoorFluidShadowIntensityBoost;
      if (u.uIndoorFluidColorSaturation) u.uIndoorFluidColorSaturation.value = this.params.indoorFluidColorSaturation;
      const projectionIds = this._getTileProjectionIds();
      const hasTileProjection = Array.isArray(projectionIds) && projectionIds.length > 0;
      if (u.uTileProjectionEnabled) u.uTileProjectionEnabled.value = (this.params.tileProjectionEnabled || hasTileProjection) ? 1.0 : 0.0;
      if (u.uTileProjectionOpacity) u.uTileProjectionOpacity.value = this.params.tileProjectionOpacity;
      if (u.uTileProjectionLengthScale) u.uTileProjectionLengthScale.value = this.params.tileProjectionLengthScale;
      if (u.uTileProjectionSoftness) u.uTileProjectionSoftness.value = this.params.tileProjectionSoftness;
      if (u.uTileProjectionThreshold) u.uTileProjectionThreshold.value = this.params.tileProjectionThreshold;
      if (u.uTileProjectionPower) u.uTileProjectionPower.value = this.params.tileProjectionPower;
      if (u.uTileProjectionOutdoorOpacityScale) u.uTileProjectionOutdoorOpacityScale.value = this.params.tileProjectionOutdoorOpacityScale;
      if (u.uTileProjectionIndoorOpacityScale) u.uTileProjectionIndoorOpacityScale.value = this.params.tileProjectionIndoorOpacityScale;
      if (u.uTileProjectionSortBias) u.uTileProjectionSortBias.value = this.params.tileProjectionSortBias;
      if (u.uFluidColorEnabled) u.uFluidColorEnabled.value = this.params.fluidColorEnabled ? 1.0 : 0.0;
      if (u.uFluidEffectTransparency) u.uFluidEffectTransparency.value = this.params.fluidEffectTransparency;
      if (u.uFluidShadowIntensityBoost) u.uFluidShadowIntensityBoost.value = this.params.fluidShadowIntensityBoost;
      if (u.uFluidShadowSoftness) u.uFluidShadowSoftness.value = this.params.fluidShadowSoftness;
      if (u.uFluidColorBoost) u.uFluidColorBoost.value = this.params.fluidColorBoost;
      if (u.uFluidColorSaturation) u.uFluidColorSaturation.value = this.params.fluidColorSaturation;
      if (u.tDynamicLight) u.tDynamicLight.value = this._dynamicLightTexture ?? null;
      if (u.uHasDynamicLight) u.uHasDynamicLight.value = this._dynamicLightTexture ? 1.0 : 0.0;
      if (u.uDynamicLightShadowOverrideEnabled) {
        u.uDynamicLightShadowOverrideEnabled.value = this.params.dynamicLightShadowOverrideEnabled === false ? 0.0 : 1.0;
      }
      if (u.uDynamicLightShadowOverrideStrength) {
        const dynStrength = Number.isFinite(Number(this._dynamicLightOverrideStrength))
          ? this._dynamicLightOverrideStrength
          : Number(this.params.dynamicLightShadowOverrideStrength ?? 0.7);
        u.uDynamicLightShadowOverrideStrength.value = Math.max(0.0, Math.min(1.0, dynStrength));
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
          skyReachShelter: 7.0
        };
        const key = String(this.params.debugView || 'final');
        u.uDebugView.value = Object.prototype.hasOwnProperty.call(debugMap, key) ? debugMap[key] : 0.0;
      }

      // Scene dimensions for mask UV conversion (world-space mask offset)
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

      // Receiver + roof/fluid region clip: ACTIVE (viewed) floor _Outdoors only —
      // keeps overhead / building contributions from leaking into current-level indoor.
      if (u.uOutdoorsMask) u.uOutdoorsMask.value = receiverMask;
      if (u.uHasOutdoorsMask) u.uHasOutdoorsMask.value = receiverMask ? 1.0 : 0.0;
      if (u.uOutdoorsMaskFlipY) u.uOutdoorsMaskFlipY.value = receiverMask?.flipY ? 1.0 : 0.0;

      const whiteObBind = this._getWhiteMaskPlaceholder();
      if (u.tSkyReach) u.tSkyReach.value = receiverSkyReach ?? whiteObBind;
      if (u.uHasSkyReach) u.uHasSkyReach.value = receiverSkyReach ? 1.0 : 0.0;
      if (u.uSkyReachFlipY) u.uSkyReachFlipY.value = receiverSkyReach?.flipY ? 1.0 : 0.0;
      if (u.uSkyReachShadowEnabled) {
        // Hard-wired on (ignore params.skyReachShadowEnabled / saved worlds).
        u.uSkyReachShadowEnabled.value = 1.0;
      }
      if (u.uSkyReachShadowOpacity) {
        u.uSkyReachShadowOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.skyReachShadowOpacity) || 0.0));
      }
      if (u.uUpperFloorTileShadowEnabled) {
        u.uUpperFloorTileShadowEnabled.value = this.params.upperFloorTileShadowEnabled !== false ? 1.0 : 0.0;
      }
      if (u.uUpperFloorTileShadowOpacity) {
        u.uUpperFloorTileShadowOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.upperFloorTileShadowOpacity) || 0.0));
      }
      if (u.uUpperFloorTileShadowLengthScale) {
        u.uUpperFloorTileShadowLengthScale.value = Math.max(0.0, Number(this.params.upperFloorTileShadowLengthScale) || 0.0);
      }

      // Outdoor Building Shadow casters: combine _Outdoors from levels above the viewer
      // (min = indoor on any upper level at this world XY). Slots unused → white sampler.
      const whiteOb = this._getWhiteMaskPlaceholder();
      if (u.uObUpperOutdoors0) u.uObUpperOutdoors0.value = upperObTextures[0] ?? whiteOb;
      if (u.uObUpperOutdoors1) u.uObUpperOutdoors1.value = upperObTextures[1] ?? whiteOb;
      if (u.uObUpperOutdoors2) u.uObUpperOutdoors2.value = upperObTextures[2] ?? whiteOb;
      if (u.uObUpperOutdoorsFlipY0) {
        u.uObUpperOutdoorsFlipY0.value = upperObTextures[0]?.flipY ? 1.0 : 0.0;
      }
      if (u.uObUpperOutdoorsFlipY1) {
        u.uObUpperOutdoorsFlipY1.value = upperObTextures[1]?.flipY ? 1.0 : 0.0;
      }
      if (u.uObUpperOutdoorsFlipY2) {
        u.uObUpperOutdoorsFlipY2.value = upperObTextures[2]?.flipY ? 1.0 : 0.0;
      }
      if (u.uObUpperCount) u.uObUpperCount.value = upperObTextures.length;

      this._lastOutdoorsMaskRef = receiverMask;
      this._lastSkyReachMaskRef = receiverSkyReach;
      this._lastUpperFloorAlphaSig = upperFloorAlphaSig;
      this._lastObUpperSig = obUpperSig;
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
    // Drop cached per-floor texture refs so scene/floor transitions cannot
    // accumulate stale references over long runtimes.
    this._floorStates.clear();
    try {
      log.debug(`OverheadShadowsEffectV2: invalidated dynamic caches (${String(reason)})`);
    } catch (_) {}
  }

  /**
   * Render the effect as a full-screen pass.
   */
  render(renderer, scene = null, camera = null) {
    // Allow compositor to supply scene/camera each frame.
    if (scene) this.mainScene = scene;
    if (camera) this.mainCamera = camera;

    this._ceilingTransmittanceWritten = false;

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

    this._treeRainMaskDebugHeartbeat();

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
      || !this.ceilingTransmittanceTarget
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

    // Capture roof/fluid with a guard-band expanded camera view so projected
    // sampling near viewport edges still has valid source texels.
    const zoom = this._getEffectiveZoom();
    if (this.material?.uniforms?.uZoom) {
      // Keep shader projection distance and capture guard computations in sync.
      this.material.uniforms.uZoom.value = zoom;
    }
    const resolvedOutdoorBuildingShadow = this._resolveOutdoorBuildingShadowParams();
    const maxProjectionScale = Math.max(
      1.0,
      Number(this.params.tileProjectionLengthScale) || 0.0,
      Number(resolvedOutdoorBuildingShadow.lengthScale) || 0.0
    );
    const maxSoftness = Math.max(
      Number(this.params.softness) || 0.0,
      Number(this.params.indoorShadowSoftness) || 0.0,
      Number(this.params.fluidShadowSoftness) || 0.0,
      Number(this.params.indoorFluidShadowSoftness) || 0.0,
      Number(this.params.tileProjectionSoftness) || 0.0
    );
    const baseProjectionPx = (Number(this.params.length) || 0.0) * 1080.0 * Math.max(zoom, 0.0001);
    const projectionPx = baseProjectionPx * maxProjectionScale;
    const blurPx = maxSoftness * 2.0;
    const guardPx = Math.max(24.0, projectionPx + blurPx + 2.0);
    const guardScaleX = 1.0 + (2.0 * guardPx / Math.max(size.x, 1));
    const guardScaleY = 1.0 + (2.0 * guardPx / Math.max(size.y, 1));
    // Apply guard scaling for both ortho and perspective captures so roof/fluid
    // projection has real off-screen source coverage at viewport edges.
    const roofCaptureScale = Math.max(guardScaleX, guardScaleY);

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
    const pushTreeUniformOverride = (uniforms, key, value) => {
      const u = uniforms?.[key];
      if (!u || typeof u.value !== 'number') return;
      treeMaskCaptureUniformOverrides.push({ uniform: u, value: u.value });
      u.value = value;
    };
    if (INCLUDE_TREE_CANOPY_IN_WEATHER_ROOF_CAPTURES) {
      this.mainScene.traverse((object) => {
        if (!object?.userData?.mapShineTreeTileId || !object.layers) return;
        treeProbe.treeSeen += 1;
        if ((object.layers.mask & (1 << WEATHER_ROOF_LAYER)) !== 0) {
          treeProbe.treeWeatherLayerEnabled += 1;
        }
        treeCaptureOverrides.push({
          object,
          layersMask: object.layers.mask,
          visible: typeof object.visible === 'boolean' ? object.visible : undefined
        });
        object.layers.enable(WEATHER_ROOF_LAYER);
        if (typeof object.visible === 'boolean') {
          if (!object.visible) treeProbe.treeForcedVisibleForCapture += 1;
          object.visible = true;
        }
        // Tree canopy shaders also consume roof/block maps for their own visual
        // output. During roof-map capture, disable that self-masking feedback so
        // tree silhouettes contribute deterministically like roof sprites.
        const uniforms = object?.material?.uniforms;
        if (uniforms) {
          pushTreeUniformOverride(uniforms, 'uRoofRainHardBlockEnabled', 0.0);
          pushTreeUniformOverride(uniforms, 'uHasRoofAlphaMap', 0.0);
          pushTreeUniformOverride(uniforms, 'uHasRoofBlockMap', 0.0);
        }
      });
    }

    const roofVisibilityExclusions = [];
    this.mainScene.traverse((object) => {
      if (!object.layers || (object.layers.mask & roofVisibilityMaskBits) === 0) return;
      const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);
      if (!isFluidOverlay) return;
      if (typeof object.visible === 'boolean') {
        roofVisibilityExclusions.push({ object, visible: object.visible });
        object.visible = false;
      }
    });

    // Capture runtime roof visibility (with live hover fade opacity) for
    // LightingEffectV2 building-shadow suppression. This pass intentionally uses
    // true tile visibility/opacity and excludes fluid overlays.
    this.mainCamera.layers.set(ROOF_LAYER);
    this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
    renderer.setRenderTarget(this.roofVisibilityTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.mainScene, this.mainCamera);

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
        const disabledBlockerOpacityOverrides = [];
        const disabledBlockerUniformOverrides = [];
        this.mainScene.traverse((object) => {
          if (!object?.layers || !object?.material) return;
          if ((object.layers.mask & roofCaptureMaskBits) === 0) return;
          const mat = object.material;
          if (typeof mat.opacity === 'number') {
            disabledBlockerOpacityOverrides.push({ object, opacity: mat.opacity });
            mat.opacity = 1.0;
          }
          const uOpacity = mat?.uniforms?.uOpacity;
          if (uOpacity && typeof uOpacity.value === 'number') {
            disabledBlockerUniformOverrides.push({ uniform: uOpacity, value: uOpacity.value });
            uOpacity.value = 1.0;
          }
          const uTileOpacity = mat?.uniforms?.uTileOpacity;
          if (uTileOpacity && typeof uTileOpacity.value === 'number') {
            disabledBlockerUniformOverrides.push({ uniform: uTileOpacity, value: uTileOpacity.value });
            uTileOpacity.value = 1.0;
          }
        });

        const disabledTreeBlockerUniformOverrides = [];
        this.mainScene.traverse((object) => {
          if (!object?.userData?.mapShineTreeTileId) return;
          treeProbe.roofBlockTreeParticipants += 1;
          const uniforms = object?.material?.uniforms;
          if (!uniforms) return;
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
        });

        this.mainCamera.layers.set(ROOF_LAYER);
        this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
        renderer.setRenderTarget(this.roofBlockTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this.mainScene, this.mainCamera);

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
          const restrictLightVisOverrides = [];
          this.mainScene.traverse((object) => {
            if (!object.layers || (object.layers.mask & roofCaptureMaskBits) === 0) return;
            const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);
            if (isFluidOverlay) return;
            if (!(object.isSprite || object.isMesh) || typeof object.visible !== 'boolean') return;
            const liveVis = object.visible;
            restrictLightVisOverrides.push({ object, visible: object.visible });
            const isFoundryTile = !!object.userData?.foundryTileId;
            const rl = objectRestrictsLightForRoofCapture(object);
            if (!isFoundryTile) object.visible = false;
            else object.visible = !!(liveVis && rl);
          });
          this.mainCamera.layers.set(ROOF_LAYER);
          this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
          renderer.setRenderTarget(this.roofRestrictLightTarget);
          renderer.setClearColor(0x000000, 0);
          renderer.clear();
          renderer.render(this.mainScene, this.mainCamera);
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

        this._renderCeilingTransmittancePass(renderer);
      } else {
        this._emitTreeRainMaskProbe({ ...treeProbe, path: 'overhead-disabled-no-roofBlock', warn: 'roofBlockTarget missing' });
      }
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
    if (this.material?.uniforms?.uRoofUvScale) {
      this.material.uniforms.uRoofUvScale.value = 1.0 / Math.max(roofCaptureScale, 1.0);
    }
    if (this.material?.uniforms?.uTileProjectionUvScale) {
      this.material.uniforms.uTileProjectionUvScale.value = 1.0;
    }

    const overrides = [];
    const opacityUniformOverrides = [];
    const tileOpacityUniformOverrides = [];
    const fluidVisibilityOverrides = [];
    const fluidUniformOverrides = [];
    const nonFluidVisibilityOverrides = [];
    const roofCasterTreeVisibilityOverrides = [];
    const roofSpriteVisibilityOverrides = [];
    const roofUpperCasterVisibilityOverrides = [];
    const tileProjectionVisibilityOverrides = [];
    const tileProjectionOpacityOverrides = [];
    const tileReceiverVisibilityOverrides = [];
    const tileReceiverOpacityOverrides = [];
    this.mainScene.traverse((object) => {
      if (!object.layers || !object.material) return;

      // Include both ROOF_LAYER and WEATHER_ROOF_LAYER participants.
      // Weather blocker meshes can be weather-only and must be forced opaque in
      // blocker capture passes.
      if ((object.layers.mask & roofCaptureMaskBits) === 0) return;

      const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);

      if (typeof object.visible === 'boolean') {
        fluidVisibilityOverrides.push({ object, visible: object.visible });
        object.visible = isFluidOverlay;

        if (isFluidOverlay) {
          const uniforms = object.material?.uniforms;
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

      if (isFluidOverlay) return;
      const mat = object.material;
      if (typeof mat.opacity === 'number') {
        overrides.push({ object, opacity: mat.opacity });
        // IMPORTANT: Hover-hide is a UX-only fade on roof tile renderables. We
        // intentionally
        // keep overhead shadows active while hovering, so the shadow mask render
        // pass always treats roof casters as fully opaque.
        mat.opacity = 1.0;
      }
      const opacityUniform = mat?.uniforms?.uOpacity;
      if (opacityUniform && typeof opacityUniform.value === 'number') {
        opacityUniformOverrides.push({ uniform: opacityUniform, value: opacityUniform.value });
        opacityUniform.value = 1.0;
      }
      const tileOpacityUniform = mat?.uniforms?.uTileOpacity;
      if (tileOpacityUniform && typeof tileOpacityUniform.value === 'number') {
        tileOpacityUniformOverrides.push({ uniform: tileOpacityUniform, value: tileOpacityUniform.value });
        tileOpacityUniform.value = 1.0;
      }
    });

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
      this.mainCamera.layers.set(ROOF_LAYER);
      renderer.setRenderTarget(this.fluidRoofTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);

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
      roofUpperCasterVisibilityOverrides.push(...this._forceUpperOverheadCasterVisibilityForRoofPass());
      this.mainScene.traverse((object) => {
        if (!object.layers || (object.layers.mask & roofCaptureMaskBits) === 0) return;
        const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);
        if (isFluidOverlay) {
          if (typeof object.visible === 'boolean') {
            nonFluidVisibilityOverrides.push({ object, visible: object.visible });
            object.visible = false;
          }
          return;
        }
        // Keep tree canopies in roof visibility/block captures so weather masking
        // follows tree hover-fade exactly like overhead roof sprites.
        if (object?.userData?.mapShineTreeTileId) {
          const hf = Number(object?.material?.uniforms?.uHoverFade?.value);
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
        if ((object.isSprite || object.isMesh) && typeof object.visible === 'boolean') {
          roofSpriteVisibilityOverrides.push({ object, visible: object.visible });
          object.visible = true;
        }
      });

      // Pass 1: render overhead tiles into roofTarget (alpha mask)
      this.mainCamera.layers.set(ROOF_LAYER);
      this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
      renderer.setRenderTarget(this.roofTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);

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
      const restrictLightVisOverrides = [];
      this.mainScene.traverse((object) => {
        if (!object.layers || (object.layers.mask & roofCaptureMaskBits) === 0) return;
        const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);
        if (isFluidOverlay) return;
        if (!(object.isSprite || object.isMesh) || typeof object.visible !== 'boolean') return;
        const liveVis = roofSpriteLiveVisible.has(object)
          ? roofSpriteLiveVisible.get(object)
          : object.visible;
        restrictLightVisOverrides.push({ object, visible: object.visible });
        const isFoundryTile = !!object.userData?.foundryTileId;
        const rl = objectRestrictsLightForRoofCapture(object);
        if (!isFoundryTile) {
          object.visible = false;
        } else {
          object.visible = !!(liveVis && rl);
        }
      });
      renderer.setRenderTarget(this.roofRestrictLightTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);
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
    // roofBlockTarget/ceilingTransmittance should follow hover-visible roof
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
    const treeBlockerUniformOverrides = [];
    this.mainScene.traverse((object) => {
      if (!object?.userData?.mapShineTreeTileId) return;
      treeProbe.roofBlockTreeParticipants += 1;
      const uniforms = object?.material?.uniforms;
      if (!uniforms) return;
      const hfBefore = Number(uniforms.uHoverFade?.value);
      if (Number.isFinite(hfBefore)) {
        const count = treeProbe.roofBlockTreeParticipants;
        treeProbe.roofBlockHoverFadeBeforeAvg = (treeProbe.roofBlockHoverFadeBeforeAvg == null)
          ? hfBefore
          : (treeProbe.roofBlockHoverFadeBeforeAvg * ((count - 1) / count) + hfBefore / count);
      }
      if (uniforms.uHoverFade && typeof uniforms.uHoverFade.value === 'number') {
        treeBlockerUniformOverrides.push({ uniform: uniforms.uHoverFade, value: uniforms.uHoverFade.value });
        uniforms.uHoverFade.value = 1.0;
        treeProbe.roofBlockHoverFadeForcedCount += 1;
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
    });
    try {
      this.mainCamera.layers.set(ROOF_LAYER);
      this.mainCamera.layers.enable(WEATHER_ROOF_LAYER);
      renderer.setRenderTarget(this.roofBlockTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);
    } finally {
      for (const entry of treeBlockerUniformOverrides) {
        if (entry?.uniform) entry.uniform.value = entry.value;
      }
    }
    this._renderRainOcclusionTargets(renderer, roofCaptureMaskBits, ROOF_LAYER, WEATHER_ROOF_LAYER);
    this._emitTreeRainMaskProbe({ ...treeProbe, path: 'overhead-enabled' });

    this._renderCeilingTransmittancePass(renderer);

    // IMPORTANT: restore camera layers before rendering the world-pinned
    // shadow mesh so the base plane is visible to the camera again.
    this.mainCamera.layers.mask = previousLayersMask;

    // Pass 1.5: optional tile alpha projection pass.
    // Uses per-tile "Shadow Projection" flags from the injected V2
    // TileMotionManager dependency.
    let hasTileProjection = false;
    let hasTileProjectionSort = false;
    let hasTileReceiverSort = false;
    const tileProjectionIds = this._getTileProjectionIds();
    if (tileProjectionIds.length > 0
      && this.tileProjectionTarget
      && this.tileProjectionSortTarget
      && this.tileReceiverAlphaTarget
      && this.tileReceiverSortTarget) {
      const idSet = new Set(tileProjectionIds.map((id) => String(id)));

      // Build a dynamic sort normalization range from currently present tile
      // sprites so projected-caster and receiver sort maps stay comparable.
      let sortMin = Infinity;
      let sortMax = -Infinity;
      this.mainScene.traverse((object) => {
        const isTileRenderable = !!(object?.isSprite || object?.isMesh);
        if (!isTileRenderable || !object?.material) return;
        if (!object?.userData?.foundryTileId) return;
        const sortKey = this._getTileSortKey(object);
        if (sortKey < sortMin) sortMin = sortKey;
        if (sortKey > sortMax) sortMax = sortKey;
      });
      if (!Number.isFinite(sortMin) || !Number.isFinite(sortMax)) {
        sortMin = 0;
        sortMax = 1;
      }
      const sortDelta = sortMax - sortMin;
      // V2 bus tiles currently do not guarantee a stable, receiver-comparable
      // sort signal across all tile render paths. Failing open avoids fully
      // suppressing projection in scenes where sort encoding is inconsistent.
      const canUseSortOcclusion = false;
      const sortRange = canUseSortOcclusion ? sortDelta : 1.0;

      // Projection contributors need the same guard-band strategy as roof
      // captures because projected lookups can sample opposite screen edges.
      const tileProjectionPx = baseProjectionPx * Math.max(Number(this.params.tileProjectionLengthScale) || 0.0, 0.0);
      const tileProjectionBlurPx = Math.max(Number(this.params.tileProjectionSoftness) || 0.0, 0.0) * 2.0;
      const tileGuardPx = Math.max(24.0, tileProjectionPx + tileProjectionBlurPx + 2.0);
      const tileGuardScaleX = 1.0 + (2.0 * tileGuardPx / Math.max(size.x, 1));
      const tileGuardScaleY = 1.0 + (2.0 * tileGuardPx / Math.max(size.y, 1));
      const tileCaptureScale = Math.max(tileGuardScaleX, tileGuardScaleY);

      // Receiver sort maps: capture currently visible top tile stacking so
      // projected casters can be occluded by higher-sort receiver tiles.
      this.mainScene.traverse((object) => {
        const isRenderable = !!(object.isSprite || object.isMesh || object.isPoints || object.isLine);
        if (!isRenderable || typeof object.visible !== 'boolean') return;
        tileReceiverVisibilityOverrides.push({ object, visible: object.visible });

        const isTileRenderable = !!(object.isSprite || object.isMesh);
        const keepVisible = !!(object.visible && isTileRenderable && object?.userData?.foundryTileId && object.material);
        object.visible = keepVisible;

        if (keepVisible && typeof object.material?.opacity === 'number') {
          tileReceiverOpacityOverrides.push({ object, opacity: object.material.opacity });
        }
      });

      // Receiver alpha pass (original alpha/opacity).
      this.mainCamera.layers.enableAll();
      renderer.setRenderTarget(this.tileReceiverAlphaTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);

      // Receiver sort pass (alpha multiplied by normalized sort).
      // Skip when all tiles share the same sort, because there is no ordering
      // signal to compare and a degenerate range would over-suppress shadows.
      if (canUseSortOcclusion) {
        for (const entry of tileReceiverOpacityOverrides) {
          if (!entry.object?.material || typeof entry.opacity !== 'number') continue;
          const sortKey = this._getTileSortKey(entry.object);
          const sortNorm = this._encodeTileSort(sortKey, sortMin, sortRange);
          entry.object.material.opacity = entry.opacity * sortNorm;
        }

        renderer.setRenderTarget(this.tileReceiverSortTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this.mainScene, this.mainCamera);
        hasTileReceiverSort = true;
      }

      for (const entry of tileReceiverOpacityOverrides) {
        if (!entry.object?.material || typeof entry.opacity !== 'number') continue;
        entry.object.material.opacity = entry.opacity;
      }
      for (const entry of tileReceiverVisibilityOverrides) {
        if (entry.object) entry.object.visible = entry.visible;
      }

      // Contributor alpha pass for selected projection caster tiles.
      this.mainScene.traverse((object) => {
        const isRenderable = !!(object.isSprite || object.isMesh || object.isPoints || object.isLine);
        if (!isRenderable || typeof object.visible !== 'boolean') return;
        tileProjectionVisibilityOverrides.push({ object, visible: object.visible });

        const tileId = object?.userData?.foundryTileId;
        const isTileRenderable = !!(object.isSprite || object.isMesh);
        const keepVisible = !!(isTileRenderable && tileId && idSet.has(String(tileId)));
        // Projection should still capture tiles that are currently hidden/faded
        // by indoor roof reveal logic. Force selected contributors visible.
        object.visible = keepVisible;

        // Ignore runtime sprite opacity fades (e.g. hover/roof hide) so the
        // projection pass captures the tile alpha silhouette consistently.
        if (keepVisible && typeof object.material?.opacity === 'number') {
          tileProjectionOpacityOverrides.push({ object, opacity: object.material.opacity });
          object.material.opacity = 1.0;
        }
      });

      // Tile projection can target any tile layer (not only ROOF_LAYER).
      // We isolate contributors via visibility overrides, so enabling all
      // camera layers here ensures selected tiles are always capturable.
      const restoreTileCaptureCamera = this._applyRoofCaptureGuardScale(tileCaptureScale);
      if (this.material?.uniforms?.uTileProjectionUvScale) {
        this.material.uniforms.uTileProjectionUvScale.value = 1.0 / Math.max(tileCaptureScale, 1.0);
      }
      try {
        this.mainCamera.layers.enableAll();

        renderer.setRenderTarget(this.tileProjectionTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this.mainScene, this.mainCamera);

        // Contributor sort pass (same selected casters, alpha multiplied by
        // normalized sort) for per-pixel sort occlusion in the projection shader.
        if (canUseSortOcclusion) {
          for (const entry of tileProjectionOpacityOverrides) {
            if (!entry.object?.material || typeof entry.opacity !== 'number') continue;
            const sortKey = this._getTileSortKey(entry.object);
            const sortNorm = this._encodeTileSort(sortKey, sortMin, sortRange);
            entry.object.material.opacity = sortNorm;
          }

          renderer.setRenderTarget(this.tileProjectionSortTarget);
          renderer.setClearColor(0x000000, 0);
          renderer.clear();
          renderer.render(this.mainScene, this.mainCamera);
          hasTileProjectionSort = true;
        }
      } finally {
        restoreTileCaptureCamera();
      }

      hasTileProjection = true;
    }

    this.mainCamera.layers.mask = previousLayersMask;

    for (const entry of tileProjectionVisibilityOverrides) {
      if (entry.object) entry.object.visible = entry.visible;
    }
    for (const entry of tileProjectionOpacityOverrides) {
      if (entry.object?.material && typeof entry.opacity === 'number') {
        entry.object.material.opacity = entry.opacity;
      }
    }

    this._renderUpperFloorComposite(renderer, THREE);

    // Pass 2: build shadow texture from roofTarget using a world-pinned
    // groundplane mesh that samples the roof mask in screen space.
    if (this.material && this.material.uniforms) {
      this.material.uniforms.tRoof.value = this.roofTarget.texture;
      this.material.uniforms.tRoofVisibility.value = this.roofVisibilityTarget?.texture || null;
      this.material.uniforms.uHasRoofVisibility.value = this.roofVisibilityTarget?.texture ? 1.0 : 0.0;
      this.material.uniforms.tFluidRoof.value = this.fluidRoofTarget?.texture || null;
      this.material.uniforms.uHasFluidRoof.value = this.fluidRoofTarget?.texture ? 1.0 : 0.0;
      this.material.uniforms.tTileProjection.value = hasTileProjection ? this.tileProjectionTarget?.texture : null;
      this.material.uniforms.uHasTileProjection.value = hasTileProjection ? 1.0 : 0.0;
      this.material.uniforms.tTileProjectionSort.value = hasTileProjectionSort ? this.tileProjectionSortTarget?.texture : null;
      this.material.uniforms.uHasTileProjectionSort.value = hasTileProjectionSort ? 1.0 : 0.0;
      this.material.uniforms.tTileReceiverAlpha.value = hasTileReceiverSort ? this.tileReceiverAlphaTarget?.texture : null;
      this.material.uniforms.tTileReceiverSort.value = hasTileReceiverSort ? this.tileReceiverSortTarget?.texture : null;
      this.material.uniforms.uHasTileReceiverSort.value = hasTileReceiverSort ? 1.0 : 0.0;
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

    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    const prevLayerMask = this.mainCamera.layers.mask;
    this.mainCamera.layers.enable(0);
    renderer.render(this.shadowScene, this.mainCamera);
    this.mainCamera.layers.mask = prevLayerMask;

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
  }

  /**
   * Render dedicated weather occlusion maps used by precipitation masking.
   * Captures runtime visibility and forced-opaque blockers for overhead + trees.
   * @private
   */
  _renderRainOcclusionTargets(renderer, roofCaptureMaskBits, roofLayer, weatherRoofLayer) {
    if (!renderer || !this.mainScene || !this.mainCamera
      || !this.rainOcclusionVisibilityTarget || !this.rainOcclusionBlockTarget) return;

    const overrides = [];
    const visUniformOverrides = [];
    const blockUniformOverrides = [];
    const pushUniform = (list, uniforms, key, value) => {
      const u = uniforms?.[key];
      if (!u || typeof u.value !== 'number') return;
      list.push({ uniform: u, value: u.value });
      u.value = value;
    };

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

      // Keep tree silhouettes deterministic for capture and prevent recursive roof-map feedback.
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

    const prevMask = this.mainCamera.layers.mask;
    this.mainCamera.layers.set(roofLayer);
    this.mainCamera.layers.enable(weatherRoofLayer);

    renderer.setRenderTarget(this.rainOcclusionVisibilityTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.mainScene, this.mainCamera);

    // Blocker pass: force opacity/fade to full so hiddenBlock can engage while fading.
    for (const entry of visUniformOverrides) {
      if (entry?.object && entry.key === 'opacity') entry.object.opacity = 1.0;
    }
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

    renderer.setRenderTarget(this.rainOcclusionBlockTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.mainScene, this.mainCamera);

    for (const entry of blockUniformOverrides) {
      if (entry?.object && entry.key === 'opacity') entry.object.opacity = entry.value;
      if (entry?.uniform) entry.uniform.value = entry.value;
    }
    // Restore visibility-pass uniform edits.
    for (const entry of visUniformOverrides) {
      if (entry?.object && entry.key === 'opacity') entry.object.opacity = entry.value;
      if (entry?.uniform) entry.uniform.value = entry.value;
    }
    for (const entry of overrides) {
      if (entry?.object) entry.object.visible = entry.visible;
    }
    this.mainCamera.layers.mask = prevMask;
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
    if (this.ceilingTransmittanceTarget) {
      this.ceilingTransmittanceTarget.dispose();
      this.ceilingTransmittanceTarget = null;
    }
    if (this._ceilingTransmittanceMaterial) {
      this._ceilingTransmittanceMaterial.dispose();
      this._ceilingTransmittanceMaterial = null;
    }
    if (this._ceilingTransmittanceScene) {
      const ch = this._ceilingTransmittanceScene.children?.[0];
      if (ch?.geometry) ch.geometry.dispose();
      this._ceilingTransmittanceScene = null;
    }
    this._ceilingTransmittanceCamera = null;
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
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this._upperFloorCompositeRT) {
      try { this._upperFloorCompositeRT.dispose(); } catch (_) {}
      this._upperFloorCompositeRT = null;
    }
    if (this._upperFloorAccumMaterial) {
      try { this._upperFloorAccumMaterial.dispose(); } catch (_) {}
      this._upperFloorAccumMaterial = null;
    }
    if (this._upperFloorAccumScene) {
      const uch = this._upperFloorAccumScene.children?.[0];
      if (uch?.geometry) uch.geometry.dispose();
      this._upperFloorAccumScene = null;
    }
    this._upperFloorAccumCamera = null;
    if (this._whiteMaskPlaceholder) {
      try { this._whiteMaskPlaceholder.dispose(); } catch (_) {}
      this._whiteMaskPlaceholder = null;
    }
    if (this.shadowMesh && this.shadowScene) {
      this.shadowScene.remove(this.shadowMesh);
      this.shadowMesh = null;
    }
    this.shadowScene = null;
    log.info('OverheadShadowsEffect disposed');
  }
}
