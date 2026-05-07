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
import { resolveCompositorOutdoorsTexture } from '../../masks/resolve-compositor-outdoors.js';

const log = createLogger('PaintedShadowEffectV2');
const MAX_PAINTED_SHADOW_EDGE_PX = 3072;

export class PaintedShadowEffectV2 {
  constructor() {
    this.params = {
      enabled: false,
      opacity: 0.6,
      length: 0.055,
      blurRadius: 1.8,
      resolutionScale: 1.0,
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
  }

  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'main',
          label: 'Painted Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'blurRadius', 'resolutionScale'],
        },
      ],
      parameters: {
        opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.6 },
        length: { type: 'slider', label: 'Length', min: 0.0, max: 0.6, step: 0.005, default: 0.055 },
        blurRadius: { type: 'slider', label: 'Blur', min: 0.0, max: 4.0, step: 0.05, default: 1.8 },
        resolutionScale: { type: 'slider', label: 'Resolution', min: 0.75, max: 2.0, step: 0.05, default: 1.0 },
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

  /**
   * Active-floor _Outdoors from FloorCompositor (same path as BuildingShadowsEffectV2 / OverheadShadowsEffectV2).
   * @param {import('three').Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
  }

  /**
   * Match BuildingShadowsEffectV2: avoid ground/bundle stand-in _Outdoors on upper floors in multi-floor scenes.
   * @returns {boolean}
   */
  _skipGroundAndBundleFallbackForUpperMultiFloor() {
    let floorStackFloors = [];
    try {
      floorStackFloors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    } catch (_) {
      floorStackFloors = [];
    }
    const af = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const idx = Number(af?.index);
    return floorStackFloors.length > 1 && Number.isFinite(idx) && idx > 0;
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
        tOutdoors: { value: null },
        uHasPaintedShadow: { value: 0.0 },
        uHasOutdoorsMask: { value: 0.0 },
        uPaintedFlipY: { value: 0.0 },
        uOutdoorsFlipY: { value: 0.0 },
        uSunDir: { value: new THREE.Vector2(0.0, -1.0) },
        uOpacity: { value: this.params.opacity },
        uLength: { value: this.params.length },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        tDynamicLight: { value: null },
        uHasDynamicLight: { value: 0.0 },
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
      fragmentShader: `
        uniform sampler2D tPaintedShadow;
        uniform sampler2D tOutdoors;
        uniform float uHasPaintedShadow;
        uniform float uHasOutdoorsMask;
        uniform float uPaintedFlipY;
        uniform float uOutdoorsFlipY;
        uniform vec2 uSunDir;
        uniform float uOpacity;
        uniform float uLength;
        uniform vec2 uSceneDimensions;
        uniform sampler2D tDynamicLight;
        uniform float uHasDynamicLight;
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

        float readOutdoors(vec2 uv) {
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

          float painted = readMaskShadowStrength(tPaintedShadow, casterUv, uPaintedFlipY);
          float outdoors = readOutdoors(vUv);
          float strength = clamp(painted * clamp(uOpacity, 0.0, 1.0) * outdoors, 0.0, 1.0);
          if (uHasDynamicLight > 0.5 && uDynamicLightShadowOverrideEnabled > 0.5 && uHasDynSceneRect > 0.5) {
            vec2 dynUv = clamp(sceneUvToDynScreenUv(vUv), vec2(0.0), vec2(1.0));
            vec3 dyn = texture2D(tDynamicLight, dynUv).rgb;
            float dynI = clamp(max(dyn.r, max(dyn.g, dyn.b)), 0.0, 1.0);
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
  }

  _resolvePaintedShadowTexture() {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    if (!compositor) return null;
    const maskAliases = ['handPaintedShadow', 'paintedShadow', 'shadow'];
    const isPaintedMaskEntry = (m) => {
      const id = String(m?.id ?? '').toLowerCase();
      const type = String(m?.type ?? '').toLowerCase();
      const suffix = String(m?.suffix ?? '').toLowerCase();
      return maskAliases.some((a) => id === a.toLowerCase() || type === a.toLowerCase()) || suffix === '_shadow';
    };
    const getFloorMask = (floorKey) => {
      if (!floorKey) return null;
      for (const alias of maskAliases) {
        const tex = compositor.getFloorTexture?.(String(floorKey), alias) ?? null;
        if (tex) return tex;
      }
      const metaMasks = compositor?._floorMeta?.get?.(String(floorKey))?.masks ?? null;
      if (Array.isArray(metaMasks)) {
        const hit = metaMasks.find((m) => isPaintedMaskEntry(m) && !!m?.texture);
        if (hit?.texture) return hit.texture;
      }
      return null;
    };
    const activeKey = window.MapShine?.floorStack?.getActiveFloor?.()?.compositorKey ?? null;
    if (activeKey) {
      const tex = getFloorMask(activeKey);
      if (tex) return tex;
    }
    const activeFloorKey = compositor?._activeFloorKey ?? null;
    if (activeFloorKey) {
      const tex = getFloorMask(activeFloorKey);
      if (tex) return tex;
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
    const strictUpper = this._skipGroundAndBundleFallbackForUpperMultiFloor();
    let outdoorsTex = this._outdoorsMask ?? null;
    if (!outdoorsTex) {
      outdoorsTex = resolveCompositorOutdoorsTexture(compositor, window.MapShine?.activeLevelContext ?? null, {
        skipGroundFallback: strictUpper,
        allowBundleFallback: !strictUpper,
      }).texture ?? null;
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
        dynamicLightOverrideBound: !!(this._dynamicLightOverride?.texture),
        note: 'Missing painted or outdoors mask',
      };
      this._clearShadowTargetToWhite(renderer);
      return;
    }
    this._loggedMissingOutdoorsMask = false;
    if (!this._ensureTargets(renderer, paintedTex)) {
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    try {
      const pu = this._projectMaterial.uniforms;
      pu.tPaintedShadow.value = paintedTex;
      pu.tOutdoors.value = outdoorsTex;
      pu.uHasPaintedShadow.value = 1.0;
      pu.uHasOutdoorsMask.value = 1.0;
      pu.uPaintedFlipY.value = paintedTex?.flipY ? 1.0 : 0.0;
      pu.uOutdoorsFlipY.value = outdoorsTex?.flipY ? 1.0 : 0.0;
      pu.uSunDir.value.copy(this.sunDir || { x: 0.0, y: -1.0 });
      pu.uOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.opacity) || 0.0));
      pu.uLength.value = Math.max(0.0, Number(this.params.length) || 0.0);
      const dlo = this._dynamicLightOverride;
      const dynTex = dlo?.texture ?? null;
      pu.tDynamicLight.value = dynTex;
      pu.uHasDynamicLight.value = dynTex ? 1.0 : 0.0;
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
        dynamicLightOverrideBound: !!dynTex,
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
  }
}
