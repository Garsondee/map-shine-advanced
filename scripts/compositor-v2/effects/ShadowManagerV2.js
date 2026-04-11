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
        uHasCloudShadow: { value: 0.0 },
        uHasCloudShadowRaw: { value: 0.0 },
        uHasOverheadShadow: { value: 0.0 },
        uHasBuildingShadow: { value: 0.0 },
        uUseRawCloud: { value: 0.0 },
        uCloudWeight: { value: 1.0 },
        uCloudOpacity: { value: 1.0 },
        uOverheadOpacity: { value: 1.0 },
        uBuildingOpacity: { value: 1.0 },
        // Coordinate conversion uniforms for building shadows (world space)
        uSceneRect: { value: new THREE.Vector4() },
        uHasSceneRect: { value: 0.0 },
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
        uniform float uHasCloudShadow;
        uniform float uHasCloudShadowRaw;
        uniform float uHasOverheadShadow;
        uniform float uHasBuildingShadow;
        uniform float uUseRawCloud;
        uniform float uCloudWeight;
        uniform float uCloudOpacity;
        uniform float uOverheadOpacity;
        uniform float uBuildingOpacity;
        // Coordinate conversion uniforms for building shadows (world space)
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;
        varying vec2 vUv;

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
          float combined = clamp(max(rgb.r, max(rgb.g, rgb.b)) * projection, 0.0, 1.0);
          return combined;
        }

        float readBuildingShadow() {
          if (uHasBuildingShadow < 0.5) return 1.0;
          // Building shadows are in scene/world space, need to convert screen UV to scene UV
          // Use the same conversion as the water shader
          vec2 sceneUv = vUv;
          if (uHasSceneRect > 0.5) {
            // Convert screen UV to scene UV: same as water shader approach
            sceneUv = (vUv * uSceneRect.zw) + uSceneRect.xy;
          }
          return clamp(texture2D(tBuildingShadow, sceneUv).r, 0.0, 1.0);
        }

        void main() {
          float cloudBase = readCloudShadow();
          float overheadBase = readOverheadShadow();
          float buildingBase = readBuildingShadow();

          float cloud = mix(1.0, cloudBase, clamp(uCloudOpacity, 0.0, 1.0));
          float overhead = mix(1.0, overheadBase, clamp(uOverheadOpacity, 0.0, 1.0));
          float building = mix(1.0, buildingBase, clamp(uBuildingOpacity, 0.0, 1.0));
          float cw = clamp(uCloudWeight, 0.0, 1.0);
          float combined = overhead * building * mix(1.0, cloud, cw);
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

  setInputs({ cloudShadowTexture = null, cloudShadowRawTexture = null, overheadShadowTexture = null, buildingShadowTexture = null } = {}) {
    this._cloudShadowTexture = cloudShadowTexture ?? null;
    this._cloudShadowRawTexture = cloudShadowRawTexture ?? null;
    this._overheadShadowTexture = overheadShadowTexture ?? null;
    this._buildingShadowTexture = buildingShadowTexture ?? null;
  }

  /**
   * Set scene rectangle for coordinate conversion (needed for world-space building shadows)
   * @param {THREE.Vector4} sceneRect - (x, y, width, height) in Foundry coordinates
   */
  setSceneRect(sceneRect) {
    this._sceneRect = sceneRect;
  }

  _renderOne(renderer, target, useRawCloud) {
    if (!renderer || !target || !this._material || !this._scene || !this._camera) return;
    const u = this._material.uniforms;
    u.tCloudShadow.value = this._cloudShadowTexture;
    u.tCloudShadowRaw.value = this._cloudShadowRawTexture;
    u.tOverheadShadow.value = this._overheadShadowTexture;
    u.tBuildingShadow.value = this._buildingShadowTexture;
    u.uHasCloudShadow.value = this._cloudShadowTexture ? 1.0 : 0.0;
    u.uHasCloudShadowRaw.value = this._cloudShadowRawTexture ? 1.0 : 0.0;
    u.uHasOverheadShadow.value = this._overheadShadowTexture ? 1.0 : 0.0;
    u.uHasBuildingShadow.value = this._buildingShadowTexture ? 1.0 : 0.0;
    u.uUseRawCloud.value = useRawCloud ? 1.0 : 0.0;
    u.uCloudWeight.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudWeight) || 0));
    u.uCloudOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudOpacity) || 0));
    u.uOverheadOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.overheadOpacity) || 0));
    u.uBuildingOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.buildingOpacity) || 1.0));
    
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
