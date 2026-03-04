/**
 * @fileoverview Building Shadows Effect V2
 *
 * Builds a directional projected shadow field from the dark regions of _Outdoors
 * masks (indoors/buildings), then feeds a scene-space shadow-factor texture to
 * LightingEffectV2.
 *
 * Multi-level behavior:
 * - Combines all floors above the active floor into one shadow field.
 * - Falls back to the active floor outdoors mask when no upper floors exist
 *   (single-level maps / non-level scenes).
 *
 * @module compositor-v2/effects/BuildingShadowsEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';

const log = createLogger('BuildingShadowsEffectV2');

export class BuildingShadowsEffectV2 {
  constructor() {
    this.params = {
      enabled: true,
      opacity: 0.75,
      length: 0.165,
      softness: 3.0,
      sunLatitude: 0.1,
    };

    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = null;
    /** @type {THREE.Camera|null} */
    this.mainCamera = null;

    /** @type {THREE.WebGLRenderTarget|null} Max-composited building shadow strength (0..1) */
    this._strengthTarget = null;
    /** @type {THREE.WebGLRenderTarget|null} Lighting-facing factor texture (1=lit, 0=shadowed) */
    this.shadowTarget = null;

    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._camera = null;
    /** @type {THREE.Mesh|null} */
    this._quad = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._projectMaterial = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._invertMaterial = null;

    /** @type {THREE.Vector2|null} */
    this.sunDir = null;
    /** @type {THREE.Vector2|null} */
    this._tempSize = null;

    /** @type {THREE.Texture|null} Latest outdoors mask from FloorCompositor sync */
    this._outdoorsMask = null;

    /** @type {boolean} One-shot debug guard for empty-floor diagnostics */
    this._loggedNoMaskOnce = false;

    this._sunAzimuthDeg = null;
    this._sunElevationDeg = null;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'main',
          label: 'Building Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'softness']
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.75
        },
        length: {
          type: 'slider',
          label: 'Length',
          min: 0.0,
          max: 0.35,
          step: 0.005,
          default: 0.165
        },
        softness: {
          type: 'slider',
          label: 'Softness',
          min: 0.5,
          max: 8.0,
          step: 0.1,
          default: 3.0
        }
      }
    };
  }

  get enabled() {
    return !!this.params.enabled;
  }

  set enabled(v) {
    this.params.enabled = !!v;
  }

  get shadowFactorTexture() {
    return this.shadowTarget?.texture || null;
  }

  /**
   * Direct outdoors mask feed from FloorCompositor.
   * Used as a fallback when per-floor compositor lookups are not ready yet.
   * @param {THREE.Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
  }

  initialize(renderer, camera) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;

    this.renderer = renderer;
    this.mainCamera = camera || null;
    this._tempSize = new THREE.Vector2();

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._projectMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uOutdoorsMask: { value: null },
        uHasMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uSunDir: { value: new THREE.Vector2(0, 1) },
        uLength: { value: this.params.length },
        uSoftness: { value: this.params.softness },
        uZoom: { value: 1.0 },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uOutdoorsMask;
        uniform float uHasMask;
        uniform float uOutdoorsMaskFlipY;
        uniform vec2 uSunDir;
        uniform float uLength;
        uniform float uSoftness;
        uniform float uZoom;
        uniform vec2 uTexelSize;
        uniform vec2 uSceneDimensions;
        varying vec2 vUv;

        float uvInBounds(vec2 uv) {
          vec2 safeMin = max(uTexelSize * 0.5, vec2(0.0));
          vec2 safeMax = min(vec2(1.0) - uTexelSize * 0.5, vec2(1.0));
          vec2 ge0 = step(safeMin, uv);
          vec2 le1 = step(uv, safeMax);
          return ge0.x * ge0.y * le1.x * le1.y;
        }

        float readOutdoorsMask(vec2 uv) {
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (uOutdoorsMaskFlipY > 0.5) {
            suv.y = 1.0 - suv.y;
          }
          return clamp(texture2D(uOutdoorsMask, suv).r, 0.0, 1.0);
        }

        void main() {
          if (uHasMask < 0.5) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // Match OverheadShadows projection direction.
          vec2 dir = -normalize(uSunDir);
          float pxLen = uLength * 1080.0 * max(uZoom, 0.0001);
          vec2 maskTexel = uTexelSize;
          vec2 baseOffsetUv = dir * pxLen * maskTexel;

          float receiverOutdoors = readOutdoorsMask(vUv);
          float receiverOutdoorGate = step(0.5, receiverOutdoors);

          vec2 stepUv = maskTexel * max(uSoftness, 0.5) * 4.0;
          float accum = 0.0;
          float weightSum = 0.0;

          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 jitter = vec2(float(dx), float(dy)) * stepUv;
              vec2 sampleUv = vUv + baseOffsetUv + jitter;
              float valid = uvInBounds(sampleUv);
              float w = (dx == 0 && dy == 0) ? 2.0 : 1.0;
              float casterOutdoors = readOutdoorsMask(sampleUv) * valid;
              float casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate;
              accum += casterIndoor * w;
              weightSum += w * valid;
            }
          }

          float strength = (weightSum > 0.0) ? (accum / weightSum) : 0.0;
          gl_FragColor = vec4(vec3(clamp(strength, 0.0, 1.0)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this._projectMaterial.toneMapped = false;

    this._invertMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tStrength: { value: null },
        uOpacity: { value: this.params.opacity }
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
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float s = clamp(texture2D(tStrength, vUv).r, 0.0, 1.0);
          float factor = 1.0 - s * clamp(uOpacity, 0.0, 1.0);
          gl_FragColor = vec4(vec3(factor), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._invertMaterial.toneMapped = false;

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._projectMaterial);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    renderer.getDrawingBufferSize(this._tempSize);
    this.onResize(this._tempSize.x, this._tempSize.y);

    log.info('BuildingShadowsEffectV2 initialized');
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!THREE || !width || !height) return;

    if (!this._strengthTarget) {
      this._strengthTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
    } else {
      this._strengthTarget.setSize(width, height);
    }

    if (!this.shadowTarget) {
      this.shadowTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
    } else {
      this.shadowTarget.setSize(width, height);
    }

    if (this._projectMaterial?.uniforms?.uTexelSize) {
      this._projectMaterial.uniforms.uTexelSize.value.set(1 / width, 1 / height);
    }

    this._clearShadowTargetToWhite(this.renderer);
  }

  update(_timeInfo) {
    if (!this._projectMaterial) return;

    this._updateSunDirection();

    const u = this._projectMaterial.uniforms;
    u.uLength.value = this.params.length;
    u.uSoftness.value = this.params.softness;
    u.uZoom.value = this._getEffectiveZoom();
    if (this.sunDir) u.uSunDir.value.copy(this.sunDir);

    const dims = canvas?.dimensions;
    if (dims && u.uSceneDimensions) {
      const sw = dims.sceneWidth || dims.width || 1;
      const sh = dims.sceneHeight || dims.height || 1;
      u.uSceneDimensions.value.set(sw, sh);
    }

    if (this._invertMaterial?.uniforms?.uOpacity) {
      this._invertMaterial.uniforms.uOpacity.value = this.params.opacity;
    }
  }

  setSunAngles(azimuthDeg, elevationDeg) {
    this._sunAzimuthDeg = Number(azimuthDeg);
    this._sunElevationDeg = Number(elevationDeg);
  }

  render(renderer, camera) {
    if (camera) this.mainCamera = camera;
    if (!renderer || !this._projectMaterial || !this._invertMaterial || !this._scene || !this._quad || !this.shadowTarget || !this._strengthTarget) {
      return;
    }

    if (!this.params.enabled) {
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const sc = window.MapShine?.sceneComposer;
    const compositor = sc?._sceneMaskCompositor;
    if (!compositor) {
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const floorKeys = this._resolveSourceFloorKeys(compositor);
    const fallbackMask = this._outdoorsMask ?? null;
    if (floorKeys.length === 0 && !fallbackMask) {
      if (!this._loggedNoMaskOnce) {
        this._loggedNoMaskOnce = true;
        log.warn('BuildingShadowsEffectV2: no outdoors mask source (no floor keys and no fallback texture)');
      }
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    // Building shadow is a world/scene-space texture consumed by LightingEffectV2
    // via scene UV reconstruction. Do NOT size this RT to the current screen.
    // Match scene/mask space instead so sampling is stable and not view-dependent.
    const targetSize = this._resolveSceneTargetSize(compositor, floorKeys, fallbackMask);
    if (this._strengthTarget.width !== targetSize.x || this._strengthTarget.height !== targetSize.y) {
      this.onResize(targetSize.x, targetSize.y);
    }

    this.update(null);

    const THREE = window.THREE;
    if (!THREE) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this._strengthTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.autoClear = false;

    this._quad.material = this._projectMaterial;
    let drewAny = false;
    for (const key of floorKeys) {
      const maskTex = compositor.getFloorTexture(key, 'outdoors');
      if (!maskTex) continue;
      this._projectMaterial.uniforms.uOutdoorsMask.value = maskTex;
      this._projectMaterial.uniforms.uHasMask.value = 1.0;
      this._projectMaterial.uniforms.uOutdoorsMaskFlipY.value = maskTex?.flipY ? 1.0 : 0.0;
      renderer.render(this._scene, this._camera);
      drewAny = true;
    }

    // Fallback: if keyed lookups weren't ready this frame, still project from the
    // direct outdoors texture feed so the effect doesn't disappear.
    if (!drewAny && fallbackMask) {
      this._projectMaterial.uniforms.uOutdoorsMask.value = fallbackMask;
      this._projectMaterial.uniforms.uHasMask.value = 1.0;
      this._projectMaterial.uniforms.uOutdoorsMaskFlipY.value = fallbackMask?.flipY ? 1.0 : 0.0;
      renderer.render(this._scene, this._camera);
      drewAny = true;
    }

    if (!drewAny) {
      this._clearShadowTargetToWhite(renderer);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
      return;
    }

    this._quad.material = this._invertMaterial;
    this._invertMaterial.uniforms.tStrength.value = this._strengthTarget.texture;
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.autoClear = true;
    renderer.render(this._scene, this._camera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  _resolveSourceFloorKeys(compositor) {
    const ctx = window.MapShine?.activeLevelContext ?? null;
    const activeKey = (ctx && Number.isFinite(Number(ctx.bottom)) && Number.isFinite(Number(ctx.top)))
      ? `${ctx.bottom}:${ctx.top}`
      : null;

    const floorStack = window.MapShine?.floorStack;
    const activeIdx = Number.isFinite(floorStack?.getActiveFloor?.()?.index)
      ? floorStack.getActiveFloor().index
      : 0;

    const keys = [];
    const floors = floorStack?.getFloors?.() ?? [];
    if (Array.isArray(floors) && floors.length > 0) {
      for (const floor of floors) {
        if (!Number.isFinite(floor?.index) || floor.index <= activeIdx) continue;
        const b = Number(floor?.elevationMin);
        const t = Number(floor?.elevationMax);
        if (!Number.isFinite(b) || !Number.isFinite(t)) continue;
        const key = `${b}:${t}`;
        if (compositor.getFloorTexture(key, 'outdoors')) keys.push(key);
      }
    }

    const activeFloor = floorStack?.getActiveFloor?.() ?? null;
    if (keys.length === 0 && activeFloor) {
      const b = Number(activeFloor?.elevationMin);
      const t = Number(activeFloor?.elevationMax);
      if (Number.isFinite(b) && Number.isFinite(t)) {
        const key = `${b}:${t}`;
        if (compositor.getFloorTexture(key, 'outdoors')) keys.push(key);
      }
    }

    // Single-level fallback: use active floor if no upper floors are available.
    if (keys.length === 0 && activeKey && compositor.getFloorTexture(activeKey, 'outdoors')) {
      keys.push(activeKey);
    }

    // Non-level fallback used by some scenes.
    if (keys.length === 0 && compositor.getFloorTexture('ground', 'outdoors')) {
      keys.push('ground');
    }

    return keys;
  }

  /**
   * Resolve scene-space target size for building shadow RTs.
   * Prefers outdoors mask texture dimensions (already scene-space composed),
   * falls back to scene rect dimensions.
   * @private
   */
  _resolveSceneTargetSize(compositor, floorKeys, fallbackMask) {
    const fromTex = (tex) => {
      const w = Number(tex?.image?.width ?? tex?.source?.data?.width ?? tex?.source?.width ?? 0);
      const h = Number(tex?.image?.height ?? tex?.source?.data?.height ?? tex?.source?.height ?? 0);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return { x: Math.max(1, Math.round(w)), y: Math.max(1, Math.round(h)) };
      }
      return null;
    };

    for (const key of floorKeys || []) {
      const tex = compositor?.getFloorTexture?.(key, 'outdoors') ?? null;
      const sz = fromTex(tex);
      if (sz) return sz;
    }

    const fallbackSize = fromTex(fallbackMask);
    if (fallbackSize) return fallbackSize;

    const rect = canvas?.dimensions?.sceneRect;
    const sw = Number(rect?.width ?? canvas?.dimensions?.sceneWidth ?? canvas?.dimensions?.width ?? 1);
    const sh = Number(rect?.height ?? canvas?.dimensions?.sceneHeight ?? canvas?.dimensions?.height ?? 1);
    return {
      x: Math.max(1, Math.round(sw)),
      y: Math.max(1, Math.round(sh)),
    };
  }

  _getEffectiveZoom() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer?.currentZoom !== undefined) {
      return sceneComposer.currentZoom;
    }
    if (!this.mainCamera) return 1.0;
    if (this.mainCamera.isOrthographicCamera) return this.mainCamera.zoom || 1.0;
    const baseDist = 10000.0;
    const dist = this.mainCamera.position?.z || baseDist;
    return dist > 0.1 ? (baseDist / dist) : 1.0;
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
        if (weatherController && typeof weatherController.timeOfDay === 'number') {
          hour = weatherController.timeOfDay;
        }
      } catch (_) {}
      const t = (hour % 24.0) / 24.0;
      const azimuth = (t - 0.5) * Math.PI;
      x = -Math.sin(azimuth);
      y = -Math.cos(azimuth) * lat;
    }

    if (!this.sunDir) this.sunDir = new THREE.Vector2(x, y);
    else this.sunDir.set(x, y);
  }

  _clearShadowTargetToWhite(renderer) {
    if (!renderer || !this.shadowTarget) return;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    try { this._strengthTarget?.dispose(); } catch (_) {}
    try { this.shadowTarget?.dispose(); } catch (_) {}
    try { this._projectMaterial?.dispose(); } catch (_) {}
    try { this._invertMaterial?.dispose(); } catch (_) {}
    try { this._quad?.geometry?.dispose(); } catch (_) {}

    this._strengthTarget = null;
    this.shadowTarget = null;
    this._projectMaterial = null;
    this._invertMaterial = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;

    log.info('BuildingShadowsEffectV2 disposed');
  }
}
