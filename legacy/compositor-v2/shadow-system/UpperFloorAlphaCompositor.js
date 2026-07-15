/**
 * @fileoverview Shared upper-floor floorAlpha compositor for sky-reach and sky occlusion.
 */

export class UpperFloorAlphaCompositor {
  constructor() {
    this.combineMode = 'max';
    this._scene = null;
    this._camera = null;
    this._quad = null;
    this._material = null;
    this._target = null;
    this._lastSig = '';
  }

  initialize(renderer, width = 2, height = 2) {
    const THREE = window.THREE;
    if (!THREE || !renderer || this._scene) return;
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uFlipY: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tInput;
        uniform float uFlipY;
        varying vec2 vUv;
        void main() {
          vec2 uv = clamp(vUv, 0.0, 1.0);
          if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
          float a = clamp(texture2D(tInput, uv).r, 0.0, 1.0);
          gl_FragColor = vec4(a, a, a, a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: true,
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

  render(renderer, textures = [], { combineMode = this.combineMode } = {}) {
    const THREE = window.THREE;
    if (!THREE || !renderer || !this._material || !this._scene || !this._camera) return null;
    const sources = Array.isArray(textures) ? textures.filter(Boolean) : [];
    const size = this._resolveSize(sources);
    this._ensureTarget(size.x, size.y);
    const mode = String(combineMode || 'max').toLowerCase() === 'multiply' ? 'multiply' : 'max';
    let sig = `${mode}|${size.x}x${size.y}|${sources.length}`;
    for (const tex of sources) sig += `|${tex?.uuid ?? ''}:${tex?.version ?? 0}:${tex?.flipY ? 1 : 0}`;
    if (sig === this._lastSig && this._target?.texture) return this._target.texture;

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(this._target);
      if (mode === 'multiply') {
        renderer.setClearColor(0xffffff, 1);
        renderer.clear();
        this._material.blending = THREE.CustomBlending;
        this._material.blendEquation = THREE.AddEquation;
        this._material.blendSrc = THREE.DstColorFactor;
        this._material.blendDst = THREE.ZeroFactor;
      } else {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        this._material.blending = THREE.CustomBlending;
        this._material.blendEquation = THREE.MaxEquation ?? THREE.AddEquation;
        this._material.blendSrc = THREE.OneFactor;
        this._material.blendDst = THREE.OneFactor;
      }
      this._material.transparent = true;
      renderer.autoClear = false;
      for (const tex of sources) {
        this._material.uniforms.tInput.value = tex;
        this._material.uniforms.uFlipY.value = tex?.flipY ? 1.0 : 0.0;
        renderer.render(this._scene, this._camera);
      }
      this._lastSig = sig;
    } finally {
      this._material.blending = THREE.NoBlending;
      this._material.transparent = false;
      renderer.autoClear = prevAuto;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.setRenderTarget(prevTarget);
    }
    return this._target.texture;
  }

  _ensureTarget(width, height) {
    const THREE = window.THREE;
    if (!THREE) return;
    const w = Math.max(2, Math.round(width || 2));
    const h = Math.max(2, Math.round(height || 2));
    if (this._target) {
      if (this._target.width !== w || this._target.height !== h) {
        this._target.setSize(w, h);
        this._lastSig = '';
      }
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
    this._target.texture.name = 'MapShineUpperFloorAlphaComposite';
    this._target.texture.flipY = false;
  }

  _resolveSize(textures) {
    let x = 2;
    let y = 2;
    for (const tex of textures) {
      const w = Number(tex?.image?.width ?? tex?.source?.data?.width ?? tex?.width ?? 0);
      const h = Number(tex?.image?.height ?? tex?.source?.data?.height ?? tex?.height ?? 0);
      if (w > x) x = w;
      if (h > y) y = h;
    }
    return { x, y };
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
    this._lastSig = '';
  }
}
