export class MaskManager {
  constructor() {
    this._masks = new Map();
    this._renderer = null;
    this._derived = new Map();

    this._quadScene = null;
    this._quadCamera = null;
    this._quadMesh = null;
    this._boostMaterial = null;
    this._blurMaterial = null;
    this._tmpVec2 = null;
  }

  setRenderer(renderer) {
    this._renderer = renderer || null;
  }

  _ensureQuad() {
    const THREE = window.THREE;
    if (!THREE) return false;
    if (!this._quadScene) this._quadScene = new THREE.Scene();
    if (!this._quadCamera) this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    if (!this._quadMesh) {
      this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
      this._quadScene.add(this._quadMesh);
    }
    return true;
  }

  _ensureMaterials() {
    const THREE = window.THREE;
    if (!THREE) return false;

    if (!this._boostMaterial) {
      this._boostMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tInput: { value: null },
          uBoost: { value: 1.0 },
          uThreshold: { value: 0.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D tInput;
          uniform float uBoost;
          uniform float uThreshold;
          varying vec2 vUv;

          float msLuminance(vec3 c) {
            return dot(c, vec3(0.2126, 0.7152, 0.0722));
          }

          void main() {
            vec4 s = texture2D(tInput, vUv);
            float v = msLuminance(s.rgb);
            v = clamp(v * uBoost, 0.0, 1.0);
            v = (v >= uThreshold) ? v : 0.0;
            gl_FragColor = vec4(v, v, v, 1.0);
          }
        `,
        depthWrite: false,
        depthTest: false
      });
    }

    if (!this._blurMaterial) {
      this._blurMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tInput: { value: null },
          uDirection: { value: new THREE.Vector2(1.0, 0.0) },
          uTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },
          uBlurRadius: { value: 2.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D tInput;
          uniform vec2 uDirection;
          uniform vec2 uTexelSize;
          uniform float uBlurRadius;
          varying vec2 vUv;

          void main() {
            vec4 sum = vec4(0.0);
            float weightSum = 0.0;
            float r = max(uBlurRadius, 0.0001);

            for (float i = -4.0; i <= 4.0; i += 1.0) {
              float w = exp(-0.5 * (i * i) / (r * r));
              vec2 off = uDirection * uTexelSize * i * r;
              sum += texture2D(tInput, vUv + off) * w;
              weightSum += w;
            }

            gl_FragColor = sum / max(weightSum, 1e-6);
          }
        `,
        depthWrite: false,
        depthTest: false
      });
    }

    return true;
  }

  _getOrCreateDerivedTargets(outId, width, height, type) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const prev = this._derived.get(outId);
    if (prev && prev.a && prev.b) {
      if (prev.a.width !== width || prev.a.height !== height) prev.a.setSize(width, height);
      if (prev.b.width !== width || prev.b.height !== height) prev.b.setSize(width, height);
      if (prev.boost && (prev.boost.width !== width || prev.boost.height !== height)) prev.boost.setSize(width, height);
      return prev;
    }

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: type ?? THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false
    };

    const rec = {
      a: new THREE.WebGLRenderTarget(width, height, opts),
      b: new THREE.WebGLRenderTarget(width, height, opts),
      boost: new THREE.WebGLRenderTarget(width, height, opts),
      key: null
    };

    this._derived.set(outId, rec);
    return rec;
  }

  getOrCreateBlurredMask(outId, inId, opts = {}) {
    const THREE = window.THREE;
    if (!THREE || !this._renderer) return null;
    if (!this._ensureQuad() || !this._ensureMaterials()) return null;

    const inRec = this.getRecord(inId);
    const inTex = inRec?.texture || null;
    if (!inTex) return null;

    const baseW = inRec?.width ?? inTex?.image?.width ?? null;
    const baseH = inRec?.height ?? inTex?.image?.height ?? null;
    if (!baseW || !baseH) return null;

    const scale = (typeof opts.scale === 'number' && isFinite(opts.scale)) ? opts.scale : 1.0;
    const w = Math.max(1, Math.floor(baseW * scale));
    const h = Math.max(1, Math.floor(baseH * scale));

    const boost = (typeof opts.boost === 'number' && isFinite(opts.boost)) ? opts.boost : 1.0;
    const threshold = (typeof opts.threshold === 'number' && isFinite(opts.threshold)) ? opts.threshold : 0.0;
    const blurRadius = (typeof opts.blurRadius === 'number' && isFinite(opts.blurRadius)) ? opts.blurRadius : 2.0;
    const blurPasses = (typeof opts.blurPasses === 'number' && isFinite(opts.blurPasses)) ? Math.max(0, Math.floor(opts.blurPasses)) : 2;
    const type = opts.type ?? THREE.UnsignedByteType;

    const key = `${inTex.uuid}|${w}x${h}|b${boost}|t${threshold}|r${blurRadius}|p${blurPasses}|ty${type}`;
    const rt = this._getOrCreateDerivedTargets(outId, w, h, type);
    if (!rt) return null;
    if (rt.key === key) {
      const outTex = rt.a.texture;
      this.setTexture(outId, outTex, {
        space: inRec?.space ?? 'sceneUv',
        source: 'derived',
        channels: 'r',
        uvFlipY: false,
        lifecycle: 'staticPerScene',
        width: w,
        height: h
      });
      return outTex;
    }
    rt.key = key;

    if (!this._tmpVec2) this._tmpVec2 = new THREE.Vector2();
    this._tmpVec2.set(1 / w, 1 / h);

    const prevTarget = this._renderer.getRenderTarget();

    this._boostMaterial.uniforms.tInput.value = inTex;
    this._boostMaterial.uniforms.uBoost.value = boost;
    this._boostMaterial.uniforms.uThreshold.value = threshold;
    this._quadMesh.material = this._boostMaterial;
    this._renderer.setRenderTarget(rt.boost);
    this._renderer.clear();
    this._renderer.render(this._quadScene, this._quadCamera);

    this._blurMaterial.uniforms.uTexelSize.value.copy(this._tmpVec2);
    this._blurMaterial.uniforms.uBlurRadius.value = blurRadius;

    let readTex = rt.boost.texture;
    let outA = rt.a;
    let outB = rt.b;

    for (let i = 0; i < Math.max(1, blurPasses); i++) {
      this._blurMaterial.uniforms.uDirection.value.set(1.0, 0.0);
      this._blurMaterial.uniforms.tInput.value = readTex;
      this._quadMesh.material = this._blurMaterial;
      this._renderer.setRenderTarget(outB);
      this._renderer.clear();
      this._renderer.render(this._quadScene, this._quadCamera);

      this._blurMaterial.uniforms.uDirection.value.set(0.0, 1.0);
      this._blurMaterial.uniforms.tInput.value = outB.texture;
      this._renderer.setRenderTarget(outA);
      this._renderer.clear();
      this._renderer.render(this._quadScene, this._quadCamera);

      readTex = outA.texture;
    }

    this._renderer.setRenderTarget(prevTarget);

    const outTex = rt.a.texture;
    this.setTexture(outId, outTex, {
      space: inRec?.space ?? 'sceneUv',
      source: 'derived',
      channels: 'r',
      uvFlipY: false,
      lifecycle: 'staticPerScene',
      width: w,
      height: h
    });
    return outTex;
  }

  dispose() {
    try {
      for (const rec of this._derived.values()) {
        if (rec?.a) rec.a.dispose();
        if (rec?.b) rec.b.dispose();
        if (rec?.boost) rec.boost.dispose();
      }
      this._derived.clear();
    } catch (e) {
    }

    try {
      if (this._boostMaterial) this._boostMaterial.dispose();
      if (this._blurMaterial) this._blurMaterial.dispose();
    } catch (e) {
    }

    this._boostMaterial = null;
    this._blurMaterial = null;
    this._quadMesh = null;
    this._quadScene = null;
    this._quadCamera = null;
    this._renderer = null;
    this._tmpVec2 = null;
    this._masks.clear();
  }

  setTexture(id, texture, meta = {}) {
    if (!id || typeof id !== 'string') {
      throw new Error('MaskManager.setTexture: id must be a non-empty string');
    }

    if (!texture) {
      this._masks.delete(id);
      return;
    }

    const prev = this._masks.get(id);
    const img = texture?.image;
    const next = {
      id,
      texture,
      space: meta.space ?? prev?.space ?? 'sceneUv',
      source: meta.source ?? prev?.source ?? 'unknown',
      colorSpace: meta.colorSpace ?? prev?.colorSpace ?? null,
      uvFlipY: meta.uvFlipY ?? prev?.uvFlipY ?? null,
      channels: meta.channels ?? prev?.channels ?? null,
      lifecycle: meta.lifecycle ?? prev?.lifecycle ?? null,
      width: meta.width ?? prev?.width ?? (img?.width ?? null),
      height: meta.height ?? prev?.height ?? (img?.height ?? null)
    };

    this._masks.set(id, next);
  }

  getTexture(id) {
    const rec = this._masks.get(id);
    return rec ? rec.texture : null;
  }

  getRecord(id) {
    return this._masks.get(id) ?? null;
  }

  listIds() {
    return Array.from(this._masks.keys());
  }
}
