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
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { loadAssetBundle, loadTexture } from '../../assets/loader.js';
import { getViewedLevelBackgroundSrc } from '../../foundry/levels-scene-flags.js';
import { getMaskTextureManifest, maskTextureManifestMatchesLoadContext } from '../../settings/mask-manifest-flags.js';
import { collectCompositorFloorCandidateKeys, resolveCompositorFloorMaskTexture, resolveCompositorOutdoorsTexture } from '../../masks/resolve-compositor-outdoors.js';
import { FLOOR_ID_OUTDOORS_RECEIVER_GLSL } from '../shadow-system/DirectionalShadowProjector.js';

const log = createLogger('PaintedShadowEffectV2');
const MAX_PAINTED_SHADOW_EDGE_PX = 3072;

export class PaintedShadowEffectV2 {
  constructor() {
    this.params = {
      enabled: true,
      opacity: 0.5,
      length: 0.1,
      blurRadius: 0,
      resolutionScale: 2,
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
    this._strengthTarget = null;
    this._blurTarget = null;
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
    /** @type {(import('three').Texture|null)[]} */
    this._paintedMasks = [null, null, null, null];
    /** @type {(import('three').Texture|null)[]} */
    this._outdoorsMasks = [null, null, null, null];
    /** @type {import('three').Texture|null} */
    this._floorIdTex = null;
    /** @type {import('three').Texture|null} */
    this._noShadowFallbackTex = null;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'main',
          label: 'Painted Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'blurRadius', 'resolutionScale'],
        },
      ],
      parameters: {
        opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        length: { type: 'slider', label: 'Length', min: 0.0, max: 0.6, step: 0.005, default: 0.1 },
        blurRadius: { type: 'slider', label: 'Blur', min: 0.0, max: 4.0, step: 0.05, default: 0 },
        resolutionScale: { type: 'slider', label: 'Resolution', min: 0.75, max: 2.0, step: 0.05, default: 2 },
      },
    };
  }

  get shadowFactorTexture() {
    return this.shadowTarget?.texture ?? null;
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

  async _probePaintedShadowTextureForBasePath(basePath) {
    if (!basePath) return null;
    const info = this._resolveViewedLevelShadowProbeInfo();
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
      for (const ext of extCandidates) {
        const path = `${basePath}${suffix}.${ext}`;
        try {
          const tex = await loadTexture(path, { suppressProbeErrors: true });
          if (tex) return tex;
        } catch (_) {}
      }
    }
    return null;
  }

  _schedulePaintedBundleLoadForBasePath(basePath) {
    if (!basePath || this._paintedBundleLoadsInFlight.has(basePath)) return;
    const now = Date.now();
    const last = Number(this._paintedBundleLastAttemptMs.get(basePath) ?? 0);
    if (last > 0 && (now - last) < 1200) return;
    this._paintedBundleLastAttemptMs.set(basePath, now);
    this._paintedBundleLoadsInFlight.add(basePath);
    const run = async () => {
      try {
        const directTex = await this._probePaintedShadowTextureForBasePath(basePath);
        if (directTex) {
          this._paintedBundleByBasePath.set(basePath, directTex);
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
        this._paintedBundleByBasePath.set(basePath, hit?.texture ?? null);
      } catch (_) {
        this._paintedBundleByBasePath.set(basePath, null);
      } finally {
        this._paintedBundleLoadsInFlight.delete(basePath);
      }
    };
    void run();
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

  initialize(renderer) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;

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

        float readPaintedByFloor(float floorIdx, vec2 uv) {
          if (floorIdx < 0.0) return readMaskShadowStrength(tPaintedShadow, uv, uPaintedFlipY);
          if (floorIdx < 0.5) return readMaskShadowStrength(tPaintedShadow0, uv, uPaintedFlipY);
          if (floorIdx < 1.5) return readMaskShadowStrength(tPaintedShadow1, uv, uPaintedFlipY);
          if (floorIdx < 2.5) return readMaskShadowStrength(tPaintedShadow2, uv, uPaintedFlipY);
          return readMaskShadowStrength(tPaintedShadow3, uv, uPaintedFlipY);
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

        vec2 sceneUvToDynScreenUv(vec2 sceneUv) {
          vec2 foundryPos = uDynSceneRect.xy + sceneUv * max(uDynSceneRect.zw, vec2(1e-5));
          vec2 threePos = vec2(foundryPos.x, uDynSceneDimensions.y - foundryPos.y);
          vec2 span = max(uDynViewBounds.zw - uDynViewBounds.xy, vec2(1e-5));
          return (threePos - uDynViewBounds.xy) / span;
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

          float floorIdx = readFloorIndex(vUv);
          float painted = readPaintedByFloor(floorIdx, casterUv);
          float outdoors = readOutdoors(vUv);
          float strength = clamp(painted * clamp(uOpacity, 0.0, 1.0) * outdoors, 0.0, 1.0);
          if ((uHasDynamicLight > 0.5 || uHasWindowLight > 0.5) && uDynamicLightShadowOverrideEnabled > 0.5 && uHasDynSceneRect > 0.5) {
            vec2 dynUv = clamp(sceneUvToDynScreenUv(vUv), vec2(0.0), vec2(1.0));
            float dynI = 0.0;
            if (uHasDynamicLight > 0.5) {
              vec3 dyn = texture2D(tDynamicLight, dynUv).rgb;
              dynI = max(dynI, clamp(max(dyn.r, max(dyn.g, dyn.b)), 0.0, 1.0));
            }
            if (uHasWindowLight > 0.5) {
              vec3 win = texture2D(tWindowLight, dynUv).rgb;
              dynI = max(dynI, clamp(max(win.r, max(win.g, win.b)), 0.0, 1.0));
            }
            float dynPresence = smoothstep(0.02, 0.30, dynI);
            float dynLift = clamp(dynPresence * max(uDynamicLightShadowOverrideStrength, 0.0), 0.0, 1.0);
            strength = mix(strength, 0.0, dynLift);
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
        varying vec2 vUv;
        void main() {
          float s = clamp(texture2D(tStrength, vUv).r, 0.0, 1.0);
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
    const maxEdge = MAX_PAINTED_SHADOW_EDGE_PX;
    const scaleBase = Math.min(1.0, maxEdge / imgW, maxEdge / imgH);
    const scale = scaleBase * Math.max(0.25, Number(this.params.resolutionScale) || 1.0);
    const w = Math.max(1, Math.round(imgW * scale));
    const h = Math.max(1, Math.round(imgH * scale));
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
    if (!this.shadowTarget) this.shadowTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    else this.shadowTarget.setSize(w, h);
    this._projectMaterial.uniforms.uSceneDimensions.value.set(imgW, imgH);
    this._blurMaterial.uniforms.uTexelSize.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    return true;
  }

  _updateSunDirection() {
    const THREE = window.THREE;
    if (!THREE) return;
    const lat = Math.max(0.0, Math.min(1.0, this.params.sunLatitude ?? 0.1));
    let x = 0.0;
    let y = -1.0 * lat;
    if (Number.isFinite(this._sunAzimuthDeg)) {
      const azimuthRad = this._sunAzimuthDeg * (Math.PI / 180.0);
      x = -Math.sin(azimuthRad);
      y = -Math.cos(azimuthRad) * lat;
    } else {
      let hour = 12.0;
      try {
        if (weatherController && typeof weatherController.timeOfDay === 'number') hour = weatherController.timeOfDay;
      } catch (_) {}
      const t = (hour % 24.0) / 24.0;
      const azimuth = (t - 0.5) * (Math.PI * 2.0);
      x = -Math.sin(azimuth);
      y = -Math.cos(azimuth) * lat;
    }
    const dirLenSq = (x * x) + (y * y);
    if (dirLenSq < 1e-8) {
      const prevX = Number(this.sunDir?.x);
      const prevY = Number(this.sunDir?.y);
      const prevLenSq = (prevX * prevX) + (prevY * prevY);
      if (Number.isFinite(prevLenSq) && prevLenSq > 1e-8) {
        x = prevX;
        y = prevY;
      } else {
        x = -1.0;
        y = 0.0;
      }
    }
    if (!this.sunDir) this.sunDir = new THREE.Vector2(x, y);
    else this.sunDir.set(x, y);
  }

  _clearShadowTargetToWhite(renderer) {
    if (!renderer || !this.shadowTarget) return;
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1.0);
    renderer.clear();
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
    if (!this.params.enabled || !this._projectMaterial || !this._invertMaterial || !this._quad || !this._scene || !this._camera) return;
    const paintedTex = this._resolvePaintedShadowTexture();
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    const liveOutdoor = compositor ? this._resolveLiveCompositorOutdoorsTexture() : null;
    let outdoorsTex = liveOutdoor ?? this._outdoorsMask ?? null;
    // Per-floor layering: pick painted/outdoors by floorIdTarget per pixel.
    this._paintedMasks = [null, null, null, null];
    this._outdoorsMasks = [null, null, null, null];
    this._floorIdTex = null;
    if (compositor) {
      try {
        const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
        for (const floor of floors) {
          const idx = Number(floor?.index);
          const key = floor?.compositorKey;
          if (!Number.isFinite(idx) || idx < 0 || idx > 3 || !key) continue;
          this._paintedMasks[idx] = (
            compositor.getFloorTexture?.(key, 'handPaintedShadow')
            ?? compositor.getFloorTexture?.(key, 'paintedShadow')
            ?? compositor.getFloorTexture?.(key, 'shadow')
            ?? null
          );
          this._outdoorsMasks[idx] = compositor.getFloorTexture?.(key, 'outdoors') ?? null;
          if (!this._paintedMasks[idx]) {
            const floorBasePath = this._resolveBasePathForFloorIndex(idx);
            if (floorBasePath) {
              const cached = this._paintedBundleByBasePath.get(floorBasePath);
              if (!this._paintedBundleByBasePath.has(floorBasePath) || cached == null) {
                this._schedulePaintedBundleLoadForBasePath(floorBasePath);
              }
              if (cached) this._paintedMasks[idx] = cached;
            }
          }
        }
        const anyOutdoors = this._outdoorsMasks.some((t) => !!t);
        if (anyOutdoors) {
          this._floorIdTex = compositor.floorIdTarget?.texture ?? null;
        }
      } catch (_) {}
    }
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
      this._clearShadowTargetToWhite(renderer);
    }
    this._lastPaintedSourceSig = bandSig;

    if (!this._ensureTargets(renderer, paintedTex)) {
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    try {
      const pu = this._projectMaterial.uniforms;
      pu.tPaintedShadow.value = paintedTex;
      const noShadowTex = this._noShadowFallbackTex ?? paintedTex;
      pu.tPaintedShadow0.value = this._paintedMasks[0] ?? noShadowTex;
      pu.tPaintedShadow1.value = this._paintedMasks[1] ?? noShadowTex;
      pu.tPaintedShadow2.value = this._paintedMasks[2] ?? noShadowTex;
      pu.tPaintedShadow3.value = this._paintedMasks[3] ?? noShadowTex;
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
      pu.uLength.value = Math.max(0.0, Number(this.params.length) || 0.0);
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
      renderer.setRenderTarget(this._strengthTarget);
      renderer.setClearColor(0x000000, 1.0);
      renderer.clear();
      this._quad.material = this._projectMaterial;
      renderer.render(this._scene, this._camera);

      const blurRadius = Math.max(0.0, Number(this.params.blurRadius) || 0.0);
      const useBlur = blurRadius > 0.01;
      if (useBlur) {
        this._quad.material = this._blurMaterial;
        this._blurMaterial.uniforms.uRadius.value = blurRadius;

        this._blurMaterial.uniforms.tInput.value = this._strengthTarget.texture;
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
      }

      this._quad.material = this._invertMaterial;
      this._invertMaterial.uniforms.tStrength.value = this._strengthTarget.texture;
      renderer.setRenderTarget(this.shadowTarget);
      renderer.setClearColor(0xffffff, 1.0);
      renderer.clear();
      renderer.render(this._scene, this._camera);
      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: !!this.params.enabled,
        paintedMaskFound: true,
        outdoorsMaskFound: true,
        syncOutdoorsMaskUuid: this._outdoorsMask?.uuid ?? null,
        dynamicLightOverrideBound: !!(dynTex || winTex),
        shadowFactorTextureUuid: this.shadowTarget?.texture?.uuid ?? null,
      };
    } finally {
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    try { this._strengthTarget?.dispose(); } catch (_) {}
    try { this._blurTarget?.dispose(); } catch (_) {}
    try { this.shadowTarget?.dispose(); } catch (_) {}
    try { this._projectMaterial?.dispose(); } catch (_) {}
    try { this._invertMaterial?.dispose(); } catch (_) {}
    try { this._blurMaterial?.dispose(); } catch (_) {}
    try { this._quad?.geometry?.dispose(); } catch (_) {}
    try { this._noShadowFallbackTex?.dispose?.(); } catch (_) {}
    this._strengthTarget = null;
    this._blurTarget = null;
    this.shadowTarget = null;
    this._projectMaterial = null;
    this._invertMaterial = null;
    this._blurMaterial = null;
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
    this._paintedMasks = [null, null, null, null];
    this._outdoorsMasks = [null, null, null, null];
    this._floorIdTex = null;
    this._noShadowFallbackTex = null;
  }
}
