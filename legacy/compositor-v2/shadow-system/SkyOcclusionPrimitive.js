/**
 * @fileoverview Scene-space open-sky scalar used by lighting, sky grading and shadows.
 */

export class SkyOcclusionPrimitive {
  constructor() {
    this._scene = null;
    this._camera = null;
    this._quad = null;
    this._material = null;
    this._target = null;
  }

  initialize(renderer, width = 2, height = 2) {
    const THREE = window.THREE;
    if (!THREE || !renderer || this._scene) return;
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tOutdoors: { value: null },
        tSkyReach: { value: null },
        tUpperAlpha: { value: null },
        uHasOutdoors: { value: 0.0 },
        uHasSkyReach: { value: 0.0 },
        uHasUpperAlpha: { value: 0.0 },
        uOutdoorsFlipY: { value: 0.0 },
        uSkyReachFlipY: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tOutdoors;
        uniform sampler2D tSkyReach;
        uniform sampler2D tUpperAlpha;
        uniform float uHasOutdoors;
        uniform float uHasSkyReach;
        uniform float uHasUpperAlpha;
        uniform float uOutdoorsFlipY;
        uniform float uSkyReachFlipY;
        varying vec2 vUv;

        float readAlphaAware(sampler2D tex, vec2 uv, float flipY) {
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (flipY > 0.5) suv.y = 1.0 - suv.y;
          vec4 m = texture2D(tex, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        void main() {
          float outdoors = uHasOutdoors > 0.5 ? readAlphaAware(tOutdoors, vUv, uOutdoorsFlipY) : 1.0;
          float skyReach = uHasSkyReach > 0.5 ? readAlphaAware(tSkyReach, vUv, uSkyReachFlipY) : 1.0;
          float upperCover = uHasUpperAlpha > 0.5 ? clamp(texture2D(tUpperAlpha, vUv).r, 0.0, 1.0) : 0.0;
          float openSky = clamp(outdoors * skyReach * (1.0 - upperCover), 0.0, 1.0);
          gl_FragColor = vec4(openSky, openSky, openSky, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });
    this._material.toneMapped = false;
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);
    this._ensureTarget(width, height);
  }

  get texture() {
    return this._target?.texture ?? null;
  }

  render(renderer, driverState, upperFloorCompositeTexture = null) {
    if (!renderer || !this._material || !this._target) return null;
    const outdoors = driverState?.masks?.activeOutdoors ?? null;
    const skyReach = driverState?.masks?.activeSkyReach ?? null;
    const sizeSource = upperFloorCompositeTexture ?? outdoors ?? skyReach;
    const w = Number(sizeSource?.image?.width ?? sizeSource?.source?.data?.width ?? sizeSource?.width ?? 0);
    const h = Number(sizeSource?.image?.height ?? sizeSource?.source?.data?.height ?? sizeSource?.height ?? 0);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 1 && h > 1) {
      this._ensureTarget(w, h);
    }
    const u = this._material.uniforms;
    u.tOutdoors.value = outdoors;
    u.tSkyReach.value = skyReach;
    u.tUpperAlpha.value = upperFloorCompositeTexture;
    u.uHasOutdoors.value = outdoors ? 1.0 : 0.0;
    u.uHasSkyReach.value = skyReach ? 1.0 : 0.0;
    u.uHasUpperAlpha.value = upperFloorCompositeTexture ? 1.0 : 0.0;
    u.uOutdoorsFlipY.value = outdoors?.flipY ? 1.0 : 0.0;
    u.uSkyReachFlipY.value = skyReach?.flipY ? 1.0 : 0.0;

    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this._target);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(this._scene, this._camera);
    } finally {
      renderer.setRenderTarget(prev);
    }
    return this._target.texture;
  }

  onResize(width, height) {
    this._ensureTarget(width, height);
  }

  _ensureTarget(width, height) {
    const THREE = window.THREE;
    if (!THREE) return;
    const w = Math.max(2, Math.round(width || 2));
    const h = Math.max(2, Math.round(height || 2));
    if (this._target) {
      this._target.setSize(w, h);
      return;
    }
    this._target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._target.texture.name = 'MapShineSkyOcclusion';
    this._target.texture.flipY = false;
  }

  dispose() {
    try { this._target?.dispose?.(); } catch (_) {}
    try { this._material?.dispose?.(); } catch (_) {}
    try { this._quad?.geometry?.dispose?.(); } catch (_) {}
    this._target = null;
    this._material = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;
  }
}
