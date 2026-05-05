/**
 * @fileoverview GPU helper used by {@link V3MaskHub} to compute derived masks
 * (presently `skyReach`) into a single-channel RenderTarget that lives in
 * scene-UV space, so consumers can sample it the same way as authored masks.
 *
 * Orientation: the pass samples `uv` directly and never toggles flipY — both
 * authored masks and albedo textures arrive with
 * {@link V3_LEVEL_TEXTURE_FLIP_Y} applied, so the RT naturally inherits the
 * same row order.
 *
 * `skyReach` may ping-pong through two internal scratch targets when several
 * upper-floor albedo alphas are chained; stack matte still uses one material
 * and one RT per composite key.
 *
 * @module v3/V3DerivedMaskPass
 */

import * as THREE from "../vendor/three.module.js";
import { V3_LEVEL_TEXTURE_FLIP_Y } from "./V3RenderConventions.js";

const VERT = `precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * skyReach = outdoors.r * Π (1 − α_j) over every higher floor j's albedo alpha.
 * Output written to .rgb for easy sampling (`.r`, `.g`, `.b` all equal) and
 * .a so channel-view `'a'` also works.
 */
const FRAG_SKY_REACH = `precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uOutdoors;
uniform sampler2D uCover;
uniform float uHasCover;

void main() {
  float outdoors = texture(uOutdoors, vUv).r;
  float cover = 0.0;
  if (uHasCover > 0.5) {
    cover = clamp(texture(uCover, vUv).a, 0.0, 1.0);
  }
  float sky = clamp(outdoors * (1.0 - cover), 0.0, 1.0);
  fragColor = vec4(sky, sky, sky, sky);
}
`;

/**
 * One step of skyReach chaining: either copy `uBase.r` (no multiply) or
 * `uBase.r * (1 - uAlpha.a)` when `uHasMult` is set.
 */
const FRAG_SKY_REACH_ACCUM = `precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uBase;
uniform sampler2D uAlpha;
uniform float uHasMult;

void main() {
  float b = texture(uBase, vUv).r;
  if (uHasMult < 0.5) {
    fragColor = vec4(b, b, b, b);
    return;
  }
  float a = clamp(texture(uAlpha, vUv).a, 0.0, 1.0);
  float v = clamp(b * (1.0 - a), 0.0, 1.0);
  fragColor = vec4(v, v, v, v);
}
`;

/**
 * Same matte as the floor sandwich for albedo: `mix(lower, upper, a)` with
 * `a` from upper albedo — works for single-channel masks (R) and RGBA
 * (`normal`, `bush`, etc.).
 */
const FRAG_STACK_MATTE = `precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uMaskLower;
uniform sampler2D uMaskUpper;
uniform sampler2D uAlbedoUpper;

void main() {
  vec4 lower = texture(uMaskLower, vUv);
  vec4 upper = texture(uMaskUpper, vUv);
  float a = clamp(texture(uAlbedoUpper, vUv).a, 0.0, 1.0);
  fragColor = mix(lower, upper, a);
}
`;

/**
 * Minimal, reusable single-pass compositor. Allocates one material + one
 * render target sized to the largest input; callers own the lifetime of the
 * returned target via {@link V3DerivedMaskPass#renderSkyReach}.
 */
export class V3DerivedMaskPass {
  /**
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(renderer) {
    this.renderer = renderer;

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._camera.position.set(0, 0, 0.5);

    this._materialSkyReach = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uOutdoors: { value: null },
        uCover: { value: null },
        uHasCover: { value: 0.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG_SKY_REACH,
    });

    this._materialStackMatte = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uMaskLower: { value: null },
        uMaskUpper: { value: null },
        uAlbedoUpper: { value: null },
      },
      vertexShader: VERT,
      fragmentShader: FRAG_STACK_MATTE,
    });

    this._materialSkyReachAccum = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBase: { value: null },
        uAlpha: { value: null },
        uHasMult: { value: 0.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG_SKY_REACH_ACCUM,
    });

    this._fallback = this._buildFallback();

    /** @type {THREE.WebGLRenderTarget|null} */ this._skyScratchA = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._skyScratchB = null;

    const geo = new THREE.PlaneGeometry(2, 2);
    this._mesh = new THREE.Mesh(geo, this._materialSkyReach);
    this._mesh.frustumCulled = false;
    this._scene.add(this._mesh);
  }

  _buildFallback() {
    const data = new Uint8Array([0, 0, 0, 0]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.needsUpdate = true;
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    return t;
  }

  /**
   * Target size from inputs: max width and max height across textures (same UV
   * grid as the sandwich). Uses **native texel dimensions** so mask preview and
   * derived masks match full scene / art resolution; only scales down uniformly
   * if the larger side exceeds the WebGL `maxTextureSize` capability.
   *
   * @param {THREE.Texture[]} textures
   * @returns {{ width: number, height: number }}
   */
  _targetSize(textures) {
    let w = 0;
    let h = 0;
    for (const t of textures) {
      const img = t?.image;
      const iw = img?.width ?? img?.naturalWidth ?? 0;
      const ih = img?.height ?? img?.naturalHeight ?? 0;
      if (iw > w) w = iw;
      if (ih > h) h = ih;
    }
    if (w <= 0 || h <= 0) {
      w = 1024;
      h = 1024;
    }
    const cap =
      (this.renderer && this.renderer.capabilities && this.renderer.capabilities.maxTextureSize) ||
      16384;
    const mw = Math.max(w, h);
    let scale = 1;
    if (mw > cap) scale = cap / mw;
    return {
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
    };
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {'A'|'B'} which
   * @returns {THREE.WebGLRenderTarget}
   */
  _ensureSkyScratchRT(width, height, which) {
    const key = which === "A" ? "_skyScratchA" : "_skyScratchB";
    let rt = this[key];
    if (!rt || rt.width !== width || rt.height !== height) {
      try { rt?.dispose(); } catch (_) {}
      rt = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        colorSpace: THREE.NoColorSpace,
        generateMipmaps: false,
      });
      rt.texture.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
      this[key] = rt;
    }
    return rt;
  }

  /**
   * `skyReach = outdoors.r * Π (1 - alpha_j.a)` for each upper-floor albedo in
   * order (commutative product). Empty `alphaTexArray` copies outdoors into the
   * target (top floor / no occluders above).
   *
   * @param {{
   *   outdoorsTex: THREE.Texture,
   *   alphaTexArray: THREE.Texture[],
   *   reuseTarget?: THREE.WebGLRenderTarget|null,
   * }} args
   * @returns {THREE.WebGLRenderTarget|null}
   */
  renderSkyReachChain({ outdoorsTex, alphaTexArray, reuseTarget = null }) {
    if (!this.renderer || !outdoorsTex) return null;

    const alphas = Array.isArray(alphaTexArray) ? alphaTexArray.filter(Boolean) : [];
    const { width, height } = this._targetSize([outdoorsTex, ...alphas]);

    let target = reuseTarget;
    if (!target || target.width !== width || target.height !== height) {
      try { target?.dispose(); } catch (_) {}
      target = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        colorSpace: THREE.NoColorSpace,
        generateMipmaps: false,
      });
      target.texture.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    }

    const u = this._materialSkyReachAccum.uniforms;
    const prevMat = this._mesh.material;

    const drawAccum = (baseTex, alphaTex, hasMult, dst) => {
      u.uBase.value = baseTex;
      u.uAlpha.value = alphaTex ?? this._fallback;
      u.uHasMult.value = hasMult ? 1.0 : 0.0;
      this._mesh.material = this._materialSkyReachAccum;

      const prevTarget = this.renderer.getRenderTarget();
      const prevAutoClear = this.renderer.autoClear;
      const prevClearColor = new THREE.Color();
      this.renderer.getClearColor(prevClearColor);
      const prevClearAlpha = this.renderer.getClearAlpha();

      try {
        this.renderer.setRenderTarget(dst);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.autoClear = true;
        this.renderer.render(this._scene, this._camera);
      } finally {
        this.renderer.setRenderTarget(prevTarget);
        this.renderer.setClearColor(prevClearColor, prevClearAlpha);
        this.renderer.autoClear = prevAutoClear;
      }
    };

    try {
      if (!alphas.length) {
        drawAccum(outdoorsTex, null, false, target);
        return target;
      }

      let readTex = outdoorsTex;
      const scrA = this._ensureSkyScratchRT(width, height, "A");
      const scrB = this._ensureSkyScratchRT(width, height, "B");

      for (let k = 0; k < alphas.length; k++) {
        const isLast = k === alphas.length - 1;
        const dst = isLast ? target : (k & 1) === 0 ? scrA : scrB;
        drawAccum(readTex, alphas[k], true, dst);
        readTex = dst.texture;
      }
    } finally {
      this._mesh.material = prevMat;
    }

    return target;
  }

  /**
   * Render `skyReach = outdoors.r * (1 - cover.a)` to a fresh RenderTarget.
   *
   * @param {{
   *   outdoorsTex: THREE.Texture,
   *   coverAlphaTex: THREE.Texture|null,
   *   reuseTarget?: THREE.WebGLRenderTarget|null,
   * }} args
   * @returns {THREE.WebGLRenderTarget|null}
   */
  renderSkyReach({ outdoorsTex, coverAlphaTex, reuseTarget = null }) {
    return this.renderSkyReachChain({
      outdoorsTex,
      alphaTexArray: coverAlphaTex ? [coverAlphaTex] : [],
      reuseTarget,
    });
  }

  /**
   * Two-floor mask stack in full UV space — same matte as the sandwich /
   * {@link V3LevelTextureDebugOverlay} dual mode: `mix(lower, upper, upperAlbedo.a)`.
   *
   * @param {{
   *   lowerMask: THREE.Texture,
   *   upperMask: THREE.Texture,
   *   upperAlbedo: THREE.Texture,
   *   reuseTarget?: THREE.WebGLRenderTarget|null,
   *   nearestAlbedoAlpha?: boolean,
   *     When true, samples `upperAlbedo` with nearest filtering for this draw only
   *     (filters restored after) so hard alpha edges do not bilinear-blend dark
   *     upper `skyReach` over the lower floor (straight-alpha halo).
   * }} args
   * @returns {THREE.WebGLRenderTarget|null}
   */
  renderMaskStackMatteOverAlbedo({
    lowerMask,
    upperMask,
    upperAlbedo,
    reuseTarget = null,
    nearestAlbedoAlpha = false,
  }) {
    if (!this.renderer || !lowerMask || !upperMask || !upperAlbedo) return null;

    const { width, height } = this._targetSize([lowerMask, upperMask, upperAlbedo]);
    let target = reuseTarget;
    if (!target || target.width !== width || target.height !== height) {
      try { target?.dispose(); } catch (_) {}
      target = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        colorSpace: THREE.NoColorSpace,
        generateMipmaps: false,
      });
      target.texture.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    }

    const u = this._materialStackMatte.uniforms;
    u.uMaskLower.value = lowerMask;
    u.uMaskUpper.value = upperMask;
    u.uAlbedoUpper.value = upperAlbedo;

    /** @type {number|undefined} */ let savedMin;
    /** @type {number|undefined} */ let savedMag;
    if (nearestAlbedoAlpha) {
      savedMin = upperAlbedo.minFilter;
      savedMag = upperAlbedo.magFilter;
      upperAlbedo.minFilter = THREE.NearestFilter;
      upperAlbedo.magFilter = THREE.NearestFilter;
      upperAlbedo.needsUpdate = true;
    }

    const prevMat = this._mesh.material;
    this._mesh.material = this._materialStackMatte;

    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    const prevClearColor = new THREE.Color();
    this.renderer.getClearColor(prevClearColor);
    const prevClearAlpha = this.renderer.getClearAlpha();

    try {
      this.renderer.setRenderTarget(target);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.autoClear = true;
      this.renderer.render(this._scene, this._camera);
    } finally {
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(prevClearColor, prevClearAlpha);
      this.renderer.autoClear = prevAutoClear;
      this._mesh.material = prevMat;
      if (nearestAlbedoAlpha) {
        upperAlbedo.minFilter = savedMin;
        upperAlbedo.magFilter = savedMag;
        upperAlbedo.needsUpdate = true;
      }
    }

    return target;
  }

  dispose() {
    try { this._mesh?.geometry?.dispose(); } catch (_) {}
    try { this._materialSkyReach?.dispose(); } catch (_) {}
    try { this._materialSkyReachAccum?.dispose(); } catch (_) {}
    try { this._materialStackMatte?.dispose(); } catch (_) {}
    try { this._fallback?.dispose(); } catch (_) {}
    try { this._skyScratchA?.dispose(); } catch (_) {}
    try { this._skyScratchB?.dispose(); } catch (_) {}
    this._scene = null;
    this._camera = null;
    this._mesh = null;
    this._materialSkyReach = null;
    this._materialSkyReachAccum = null;
    this._materialStackMatte = null;
    this._fallback = null;
    this._skyScratchA = null;
    this._skyScratchB = null;
    this.renderer = null;
  }
}
