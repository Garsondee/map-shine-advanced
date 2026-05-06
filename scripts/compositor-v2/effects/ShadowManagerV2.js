/**
 * @fileoverview ShadowManagerV2 — combines cloud + overhead + building shadow factors.
 *
 * Contract:
 * - Inputs are shadow factors in [0..1], where 1 = fully lit.
 * - Output is their product (independent darkening), for ambient-darkening consumers.
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('ShadowManagerV2');

export class ShadowManagerV2 {
  constructor() {
    this.enabled = true;
    this._initialized = false;

    this.params = {
      cloudWeight: 1.0,
      cloudOpacity: 1.0,
      overheadOpacity: 1.0,
      overheadOcclusionStrength: 1.0,
      paintedOpacity: 1.0,
    };

    this._combinedRT = null;
    this._combinedRawRT = null;
    this._scene = null;
    this._camera = null;
    this._quad = null;
    this._material = null;
    this._sizeVec = null;

    this._cloudShadowTexture = null;
    this._cloudShadowRawTexture = null;
    this._overheadShadowTexture = null;
    this._buildingShadowTexture = null;
    this._paintedShadowTexture = null;
  }

  initialize(renderer, width, height) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;
    if (this._initialized) return;

    this._sizeVec = new THREE.Vector2();
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tCloudShadow: { value: null },
        tCloudShadowRaw: { value: null },
        tOverheadShadow: { value: null },
        tBuildingShadow: { value: null },
        tPaintedShadow: { value: null },
        uHasCloudShadow: { value: 0.0 },
        uHasCloudShadowRaw: { value: 0.0 },
        uHasOverheadShadow: { value: 0.0 },
        uHasBuildingShadow: { value: 0.0 },
        uHasPaintedShadow: { value: 0.0 },
        uUseRawCloud: { value: 0.0 },
        uCloudWeight: { value: 1.0 },
        uCloudOpacity: { value: 1.0 },
        uOverheadOpacity: { value: 1.0 },
        uBuildingOpacity: { value: 1.0 },
        uPaintedOpacity: { value: 1.0 },
        // Coordinate conversion uniforms for building shadows (world space)
        uSceneRect: { value: new THREE.Vector4() },
        uHasSceneRect: { value: 0.0 },
        // Match water-shader.js + LightingEffectV2: vUv → Foundry → sceneUv for tBuildingShadow.
        uViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uHasBuildingUvRemap: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tCloudShadow;
        uniform sampler2D tCloudShadowRaw;
        uniform sampler2D tOverheadShadow;
        uniform sampler2D tBuildingShadow;
        uniform sampler2D tPaintedShadow;
        uniform float uHasCloudShadow;
        uniform float uHasCloudShadowRaw;
        uniform float uHasOverheadShadow;
        uniform float uHasBuildingShadow;
        uniform float uHasPaintedShadow;
        uniform float uUseRawCloud;
        uniform float uCloudWeight;
        uniform float uCloudOpacity;
        uniform float uOverheadOpacity;
        uniform float uBuildingOpacity;
        uniform float uPaintedOpacity;
        // Coordinate conversion uniforms for building shadows (world space)
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;
        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform float uHasBuildingUvRemap;
        varying vec2 vUv;

        vec2 smScreenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          return vec2(threeX, uSceneDimensions.y - threeY);
        }

        vec2 smFoundryToSceneUv(vec2 foundryPos) {
          return (foundryPos - uSceneRect.xy) / max(uSceneRect.zw, vec2(1e-5));
        }

        float readCloudShadow() {
          if (uUseRawCloud > 0.5 && uHasCloudShadowRaw > 0.5) {
            return clamp(texture2D(tCloudShadowRaw, vUv).r, 0.0, 1.0);
          }
          if (uHasCloudShadow > 0.5) {
            return clamp(texture2D(tCloudShadow, vUv).r, 0.0, 1.0);
          }
          return 1.0;
        }

        float readOverheadShadow() {
          if (uHasOverheadShadow < 0.5) return 1.0;
          vec4 ov = texture2D(tOverheadShadow, vUv);
          vec3 rgb = clamp(ov.rgb, vec3(0.0), vec3(1.0));
          float projection = clamp(ov.a, 0.0, 1.0);
          // Match water-shader + LightingEffectV2: lit factor from mean of (RGB × projection),
          // not max(RGB) (max stays too bright vs ambient dimming under tinted roofs).
          vec3 combinedRgb = rgb * projection;
          return clamp(dot(combinedRgb, vec3(0.3333333)), 0.0, 1.0);
        }

        float readBuildingShadow() {
          if (uHasBuildingShadow < 0.5) return 1.0;
          vec2 sceneUv = vUv;
          if (uHasBuildingUvRemap > 0.5 && uHasSceneRect > 0.5) {
            vec2 foundryPos = smScreenUvToFoundry(vUv);
            sceneUv = clamp(smFoundryToSceneUv(foundryPos), vec2(0.0), vec2(1.0));
          } else if (uHasSceneRect > 0.5) {
            sceneUv = clamp((vUv * uSceneRect.zw) + uSceneRect.xy, vec2(0.0), vec2(1.0));
          }
          return clamp(texture2D(tBuildingShadow, sceneUv).r, 0.0, 1.0);
        }

        float readPaintedShadow() {
          if (uHasPaintedShadow < 0.5) return 1.0;
          vec2 sceneUv = vUv;
          if (uHasBuildingUvRemap > 0.5 && uHasSceneRect > 0.5) {
            vec2 foundryPos = smScreenUvToFoundry(vUv);
            sceneUv = clamp(smFoundryToSceneUv(foundryPos), vec2(0.0), vec2(1.0));
          } else if (uHasSceneRect > 0.5) {
            sceneUv = clamp((vUv * uSceneRect.zw) + uSceneRect.xy, vec2(0.0), vec2(1.0));
          }
          return clamp(texture2D(tPaintedShadow, sceneUv).r, 0.0, 1.0);
        }

        void main() {
          float cloudBase = readCloudShadow();
          float overheadBase = readOverheadShadow();
          float buildingBase = readBuildingShadow();
          float paintedBase = readPaintedShadow();

          float cloud = mix(1.0, cloudBase, clamp(uCloudOpacity, 0.0, 1.0));
          float overhead = mix(1.0, overheadBase, clamp(uOverheadOpacity, 0.0, 1.0));
          float building = mix(1.0, buildingBase, clamp(uBuildingOpacity, 0.0, 1.0));
          float painted = mix(1.0, paintedBase, clamp(uPaintedOpacity, 0.0, 1.0));
          float cw = clamp(uCloudWeight, 0.0, 1.0);
          float combined = overhead * building * painted * mix(1.0, cloud, cw);
          gl_FragColor = vec4(combined, combined, combined, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._material.toneMapped = false;

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    this._initialized = true;
    this.onResize(width, height);
    log.info('ShadowManagerV2 initialized');
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!THREE || !this._initialized) return;
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    if (this._combinedRT) this._combinedRT.setSize(w, h);
    else this._combinedRT = new THREE.WebGLRenderTarget(w, h, opts);
    if (this._combinedRawRT) this._combinedRawRT.setSize(w, h);
    else this._combinedRawRT = new THREE.WebGLRenderTarget(w, h, opts);
  }

  setInputs({ cloudShadowTexture = null, cloudShadowRawTexture = null, overheadShadowTexture = null, buildingShadowTexture = null, paintedShadowTexture = null } = {}) {
    this._cloudShadowTexture = cloudShadowTexture ?? null;
    this._cloudShadowRawTexture = cloudShadowRawTexture ?? null;
    this._overheadShadowTexture = overheadShadowTexture ?? null;
    this._buildingShadowTexture = buildingShadowTexture ?? null;
    this._paintedShadowTexture = paintedShadowTexture ?? null;
  }

  /**
   * Set scene rectangle for coordinate conversion (needed for world-space building shadows)
   * @param {THREE.Vector4} sceneRect - (x, y, width, height) in Foundry coordinates
   */
  setSceneRect(sceneRect) {
    this._sceneRect = sceneRect;
  }

  /**
   * Match water-shader.js / LightingEffectV2 building UV: screen vUv → Foundry XY →
   * normalized scene UV into BuildingShadowsEffectV2.shadowFactorTexture.
   * Call after {@link #setSceneRect} each frame before {@link #render}.
   * @param {import('three').Camera|null} camera
   */
  applyBuildingShadowUvRemap(camera) {
    const u = this._material?.uniforms;
    if (!u?.uHasBuildingUvRemap) return;
    if (!camera) {
      u.uHasBuildingUvRemap.value = 0.0;
      return;
    }
    const THREE = window.THREE;
    if (!THREE) {
      u.uHasBuildingUvRemap.value = 0.0;
      return;
    }
    try {
      const dims = globalThis.canvas?.dimensions;
      if (!dims || !this._sceneRect) {
        u.uHasBuildingUvRemap.value = 0.0;
        return;
      }
      const totalW = Math.max(1, Number(dims.width) || 1);
      const totalH = Math.max(1, Number(dims.height) || 1);
      u.uSceneDimensions.value.set(totalW, totalH);

      if (camera.isOrthographicCamera) {
        const camPos = camera.position;
        const zoom = Math.max(0.001, camera.zoom ?? 1.0);
        u.uViewBounds.value.set(
          camPos.x + camera.left / zoom,
          camPos.y + camera.bottom / zoom,
          camPos.x + camera.right / zoom,
          camPos.y + camera.top / zoom,
        );
      } else if (camera.isPerspectiveCamera) {
        const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
        const ndc = new THREE.Vector3();
        const world = new THREE.Vector3();
        const dir = new THREE.Vector3();
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        for (let i = 0; i < 4; i++) {
          ndc.set(corners[i][0], corners[i][1], 0.5);
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
        if (minX === Infinity) {
          u.uHasBuildingUvRemap.value = 0.0;
          return;
        }
        u.uViewBounds.value.set(minX, minY, maxX, maxY);
      } else {
        u.uHasBuildingUvRemap.value = 0.0;
        return;
      }
      u.uHasBuildingUvRemap.value = 1.0;
    } catch (_) {
      u.uHasBuildingUvRemap.value = 0.0;
    }
  }

  _renderOne(renderer, target, useRawCloud) {
    if (!renderer || !target || !this._material || !this._scene || !this._camera) return;
    const u = this._material.uniforms;
    u.tCloudShadow.value = this._cloudShadowTexture;
    u.tCloudShadowRaw.value = this._cloudShadowRawTexture;
    u.tOverheadShadow.value = this._overheadShadowTexture;
    u.tBuildingShadow.value = this._buildingShadowTexture;
    u.tPaintedShadow.value = this._paintedShadowTexture;
    u.uHasCloudShadow.value = this._cloudShadowTexture ? 1.0 : 0.0;
    u.uHasCloudShadowRaw.value = this._cloudShadowRawTexture ? 1.0 : 0.0;
    u.uHasOverheadShadow.value = this._overheadShadowTexture ? 1.0 : 0.0;
    u.uHasBuildingShadow.value = this._buildingShadowTexture ? 1.0 : 0.0;
    u.uHasPaintedShadow.value = this._paintedShadowTexture ? 1.0 : 0.0;
    u.uUseRawCloud.value = useRawCloud ? 1.0 : 0.0;
    u.uCloudWeight.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudWeight) || 0));
    u.uCloudOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudOpacity) || 0));
    u.uOverheadOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.overheadOpacity) || 0));
    u.uBuildingOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.buildingOpacity) || 1.0));
    u.uPaintedOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.paintedOpacity) || 1.0));
    
    // Bind scene rect for coordinate conversion (world-space building shadows)
    if (this._sceneRect) {
      u.uSceneRect.value.set(this._sceneRect.x, this._sceneRect.y, this._sceneRect.z, this._sceneRect.w);
      u.uHasSceneRect.value = 1.0;
    } else {
      u.uHasSceneRect.value = 0.0;
    }

    renderer.setRenderTarget(target);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this._scene, this._camera);
  }

  render(renderer) {
    if (!this._initialized || !this.enabled || !renderer) return false;
    if (!this._combinedRT || !this._combinedRawRT) {
      renderer.getDrawingBufferSize(this._sizeVec);
      this.onResize(this._sizeVec.x, this._sizeVec.y);
    }
    const prevTarget = renderer.getRenderTarget();
    try {
      this._renderOne(renderer, this._combinedRT, false);
      this._renderOne(renderer, this._combinedRawRT, true);
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
    return true;
  }

  get combinedShadowTexture() {
    return this._combinedRT?.texture ?? null;
  }

  get combinedShadowRawTexture() {
    return this._combinedRawRT?.texture ?? this._combinedRT?.texture ?? null;
  }

  dispose() {
    try { this._combinedRT?.dispose?.(); } catch (_) {}
    try { this._combinedRawRT?.dispose?.(); } catch (_) {}
    try { this._material?.dispose?.(); } catch (_) {}
    try { this._quad?.geometry?.dispose?.(); } catch (_) {}
    this._combinedRT = null;
    this._combinedRawRT = null;
    this._material = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;
    this._initialized = false;
    log.info('ShadowManagerV2 disposed');
  }
}
