/**
 * @fileoverview Building Shadows Effect V2
 *
 * Builds a directional projected shadow field from the dark regions of _Outdoors
 * masks (indoors/buildings), then feeds a scene-space shadow-factor texture to
 * LightingEffectV2.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change `shadowTarget` / `_strengthTarget` lifecycle, render cadence, or
 * LightingEffectV2 uniform wiring, you MUST update HealthEvaluator contracts for
 * `BuildingShadowsEffectV2` and the edge into `LightingEffectV2` to prevent silent failures.
 *
 * Multi-level behavior:
 * - Combines the active floor + all floors above it into one shadow field.
 * - As perspective moves upward, lower floors are excluded.
 * - Falls back to the active floor outdoors mask when no floor-stack data exists
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
      smear: 0.65,
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

    /** @type {Promise<void>|null} Background floor-mask warmup in flight */
    this._floorPreloadPromise = null;
    /** @type {number} Last warmup attempt timestamp (ms) */
    this._lastFloorPreloadAttemptMs = 0;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'main',
          label: 'Building Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'softness', 'smear']
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
        },
        smear: {
          type: 'slider',
          label: 'Smear',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.65
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
        uReceiverOutdoorsMask: { value: null },
        uHasReceiverMask: { value: 0.0 },
        uReceiverOutdoorsMaskFlipY: { value: 0.0 },
        uSunDir: { value: new THREE.Vector2(0, 1) },
        uLength: { value: this.params.length },
        uSoftness: { value: this.params.softness },
        uSmear: { value: this.params.smear },
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
        uniform sampler2D uReceiverOutdoorsMask;
        uniform float uHasReceiverMask;
        uniform float uReceiverOutdoorsMaskFlipY;
        uniform vec2 uSunDir;
        uniform float uLength;
        uniform float uSoftness;
        uniform float uSmear;
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
          // Treat transparent texels as default outdoors (1.0). Some per-floor
          // masks are sparse and encode valid coverage in alpha.
          vec4 m = texture2D(uOutdoorsMask, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        float readReceiverOutdoorsMask(vec2 uv) {
          if (uHasReceiverMask < 0.5) return readOutdoorsMask(uv);
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (uReceiverOutdoorsMaskFlipY > 0.5) {
            suv.y = 1.0 - suv.y;
          }
          vec4 m = texture2D(uReceiverOutdoorsMask, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        void main() {
          if (uHasMask < 0.5) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // This pass renders in scene/world UV space (not screen UV), so
          // projection distance must remain world-stable and NOT scale with
          // camera zoom. Scaling by zoom here causes visible shadow length
          // changes while zooming.
          vec2 dir = -normalize(uSunDir);
          float pxLen = uLength * 1080.0;
          vec2 maskTexel = uTexelSize;
          vec2 baseOffsetUv = dir * pxLen * maskTexel;

          // Use a continuous receiver outdoors gate from the active/view floor.
          // This avoids abrupt binary cut lines while still preventing indoor
          // receivers from being fully darkened by projected building shadow.
          float receiverOutdoors = readReceiverOutdoorsMask(vUv);
          float receiverOutdoorGate = clamp(receiverOutdoors, 0.0, 1.0);

          float accum = 0.0;
          float weightSum = 0.0;

          // Kawase-style multi-ring taps at several distances along projection.
          // This yields smoother penumbra-like edges with fewer harsh box artifacts.
          float smearAmount = clamp(uSmear, 0.0, 1.0);
          for (int s = 0; s < 3; s++) {
            float t = float(s) / 2.0;
            float sigma = max(uSoftness, 0.5) * mix(0.8, 1.8, t * t);
            vec2 step1 = maskTexel * sigma * 2.0;
            vec2 step2 = step1 * 2.0;
            vec2 centerUv = vUv + (baseOffsetUv * mix(0.25, 1.0, t));
            float traceWeight = mix(1.0, 1.7, smearAmount * t);

            vec2 sampleUv = centerUv;
            float valid = uvInBounds(sampleUv);
            float w = 0.24 * traceWeight;
            float casterOutdoors = readOutdoorsMask(sampleUv);
            float casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2( step1.x,  step1.y);
            valid = uvInBounds(sampleUv);
            w = 0.12 * traceWeight;
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2(-step1.x,  step1.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2( step1.x, -step1.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2(-step1.x, -step1.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            w = 0.07 * traceWeight;
            sampleUv = centerUv + vec2( step2.x, 0.0);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2(-step2.x, 0.0);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2(0.0,  step2.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2(0.0, -step2.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            w = 0.04 * traceWeight;
            sampleUv = centerUv + vec2( step2.x,  step2.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2(-step2.x,  step2.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2( step2.x, -step2.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;

            sampleUv = centerUv + vec2(-step2.x, -step2.y);
            valid = uvInBounds(sampleUv);
            casterOutdoors = readOutdoorsMask(sampleUv);
            casterIndoor = (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
            accum += casterIndoor * w;
            weightSum += w * valid;
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
    u.uSmear.value = this.params.smear;
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

    const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
    this._maybeWarmFloorMaskCache(compositor, floorCount);

    const floorKeys = this._resolveSourceFloorKeys(compositor);
    // Multi-floor safety: never fall back to an ambiguous single outdoors texture
    // (often ground) when per-floor keys are unavailable; that causes cross-floor
    // leakage on upper floors. Single-floor scenes still use fallbackMask.
    const allowFallbackMask = floorCount <= 1;
    const fallbackMask = allowFallbackMask ? (this._outdoorsMask ?? null) : null;
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

    const receiverMaskTex = this._resolveReceiverMaskTexture(compositor);
    if (this._projectMaterial?.uniforms) {
      this._projectMaterial.uniforms.uReceiverOutdoorsMask.value = receiverMaskTex;
      this._projectMaterial.uniforms.uHasReceiverMask.value = receiverMaskTex ? 1.0 : 0.0;
      this._projectMaterial.uniforms.uReceiverOutdoorsMaskFlipY.value = receiverMaskTex?.flipY ? 1.0 : 0.0;
    }

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
    const activeBottom = Number(ctx?.bottom);

    // Compositor cache keys with textures available this frame.
    const cachedEntries = [];
    try {
      const floorMeta = compositor?._floorMeta;
      if (floorMeta && typeof floorMeta.entries === 'function') {
        for (const [key] of floorMeta.entries()) {
          const parts = String(key).split(':');
          const b = Number(parts[0]);
          const t = Number(parts[1]);
          if (!Number.isFinite(b) || !Number.isFinite(t)) continue;
          if (!compositor.getFloorTexture(key, 'outdoors')) continue;
          cachedEntries.push({ key, bottom: b, top: t });
        }
      }
    } catch (_) {}

    const floorStack = window.MapShine?.floorStack;
    const activeFloor = floorStack?.getActiveFloor?.() ?? null;
    const activeIdx = Number.isFinite(activeFloor?.index)
      ? Number(activeFloor.index)
      : null;

    const keys = [];
    const seen = new Set();
    const pushKey = (key) => {
      if (!key || seen.has(key)) return;
      if (!compositor.getFloorTexture(key, 'outdoors')) return;
      seen.add(key);
      keys.push(key);
    };

    const floors = floorStack?.getFloors?.() ?? [];
    if (Array.isArray(floors) && floors.length > 0) {
      let resolvedActiveIdx = activeIdx;
      if (!Number.isFinite(resolvedActiveIdx) && activeKey) {
        const match = floors.find((floor) => {
          const b = Number(floor?.elevationMin);
          const t = Number(floor?.elevationMax);
          return Number.isFinite(b) && Number.isFinite(t) && `${b}:${t}` === activeKey;
        });
        if (Number.isFinite(match?.index)) resolvedActiveIdx = Number(match.index);
      }
      if (!Number.isFinite(resolvedActiveIdx)) {
        resolvedActiveIdx = 0;
      }

      for (const floor of floors) {
        if (!Number.isFinite(floor?.index) || floor.index < resolvedActiveIdx) continue;
        const b = Number(floor?.elevationMin);
        const t = Number(floor?.elevationMax);
        if (!Number.isFinite(b) || !Number.isFinite(t)) continue;
        pushKey(`${b}:${t}`);
      }
    }

    if (keys.length === 0 && activeFloor) {
      const b = Number(activeFloor?.elevationMin);
      const t = Number(activeFloor?.elevationMax);
      if (Number.isFinite(b) && Number.isFinite(t)) {
        pushKey(`${b}:${t}`);
      }
    }

    // Single-level / no-floor-stack fallback: use active context band if available.
    if (keys.length === 0 && activeKey) {
      pushKey(activeKey);
    }

    // Non-level fallback used by some scenes.
    if (keys.length === 0) {
      pushKey('ground');
    }

    // If floor-stack selection produced no valid textures yet, use currently
    // cached floor masks so the effect still renders while warmup completes.
    if (keys.length === 0 && cachedEntries.length > 0) {
      cachedEntries.sort((a, b) => a.bottom - b.bottom);
      if (Number.isFinite(activeBottom)) {
        const filtered = cachedEntries
          .filter((entry) => entry.bottom >= activeBottom)
          .map((entry) => entry.key);
        if (filtered.length > 0) return filtered;
      }
      return cachedEntries.map((entry) => entry.key);
    }

    return keys;
  }

  _resolveReceiverMaskTexture(compositor) {
    const ctx = window.MapShine?.activeLevelContext ?? null;
    const activeKey = (ctx && Number.isFinite(Number(ctx.bottom)) && Number.isFinite(Number(ctx.top)))
      ? `${ctx.bottom}:${ctx.top}`
      : null;

    if (activeKey) {
      const tex = compositor.getFloorTexture(activeKey, 'outdoors');
      if (tex) return tex;
    }

    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    if (activeFloor) {
      const b = Number(activeFloor?.elevationMin);
      const t = Number(activeFloor?.elevationMax);
      if (Number.isFinite(b) && Number.isFinite(t)) {
        const tex = compositor.getFloorTexture(`${b}:${t}`, 'outdoors');
        if (tex) return tex;
      }
    }

    return this._outdoorsMask ?? null;
  }

  _maybeWarmFloorMaskCache(compositor, floorCount) {
    if (!compositor || floorCount <= 1) return;
    if (this._floorPreloadPromise) return;

    const now = Date.now();
    if ((now - this._lastFloorPreloadAttemptMs) < 1000) return;
    this._lastFloorPreloadAttemptMs = now;

    const scene = canvas?.scene ?? null;
    if (!scene || typeof compositor.preloadAllFloors !== 'function') return;

    const activeLevelContext = window.MapShine?.activeLevelContext ?? null;
    const lastMaskBasePath = compositor?._activeFloorBasePath ?? null;

    this._floorPreloadPromise = compositor.preloadAllFloors(scene, {
      activeLevelContext,
      lastMaskBasePath,
    })
      .catch((err) => {
        log.debug('BuildingShadowsEffectV2: preloadAllFloors warmup failed', err);
      })
      .finally(() => {
        this._floorPreloadPromise = null;
      });
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
