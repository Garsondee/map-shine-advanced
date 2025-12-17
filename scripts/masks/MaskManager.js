export class MaskManager {
  constructor() {
    this._masks = new Map();
    this._renderer = null;
    this._derived = new Map();
    this._recipes = new Map();

    this._quadScene = null;
    this._quadCamera = null;
    this._quadMesh = null;
    this._boostMaterial = null;
    this._blurMaterial = null;
    this._opMaterial = null;
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

    if (!this._opMaterial) {
      this._opMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tA: { value: null },
          tB: { value: null },
          uOp: { value: 0.0 },
          uLo: { value: 0.0 },
          uHi: { value: 1.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D tA;
          uniform sampler2D tB;
          uniform float uOp;
          uniform float uLo;
          uniform float uHi;
          varying vec2 vUv;

          void main() {
            float a = texture2D(tA, vUv).r;
            float b = texture2D(tB, vUv).r;
            float outV = a;

            if (uOp < 0.5) {
              outV = 1.0 - a;
            } else if (uOp < 1.5) {
              outV = smoothstep(uLo, uHi, a);
            } else if (uOp < 2.5) {
              outV = max(a, b);
            } else if (uOp < 3.5) {
              outV = min(a, b);
            } else {
              outV = a * b;
            }

            gl_FragColor = vec4(outV, outV, outV, 1.0);
          }
        `,
        depthWrite: false,
        depthTest: false
      });
    }

    return true;
  }

  defineDerivedMask(id, recipe) {
    if (!id || typeof id !== 'string') {
      throw new Error('MaskManager.defineDerivedMask: id must be a non-empty string');
    }
    if (!recipe || typeof recipe !== 'object') {
      throw new Error('MaskManager.defineDerivedMask: recipe must be an object');
    }
    this._recipes.set(id, recipe);
  }

  _getTextureInternal(id, visiting) {
    const rec = this._masks.get(id);
    if (rec) return rec.texture;
    const recipe = this._recipes.get(id);
    if (!recipe) return null;
    return this._evaluateDerived(id, recipe, visiting);
  }

  _evaluateDerived(id, recipe, visiting) {
    const THREE = window.THREE;
    if (!THREE || !this._renderer) return null;
    if (!this._ensureQuad() || !this._ensureMaterials()) return null;

    if (!visiting) visiting = new Set();
    if (visiting.has(id)) {
      throw new Error(`MaskManager derived mask cycle detected at ${id}`);
    }
    visiting.add(id);

    const op = recipe.op;
    let aId = null;
    let bId = null;
    if (op === 'invert' || op === 'threshold') {
      aId = recipe.input;
    } else {
      aId = recipe.a;
      bId = recipe.b;
    }

    const aTex = aId ? this._getTextureInternal(aId, visiting) : null;
    const bTex = bId ? this._getTextureInternal(bId, visiting) : null;
    visiting.delete(id);

    if (!aTex) return null;
    if ((op !== 'invert' && op !== 'threshold') && !bTex) return null;

    const aRec = aId ? this.getRecord(aId) : null;
    const bRec = bId ? this.getRecord(bId) : null;
    const dynamic = (aRec?.lifecycle === 'dynamicPerFrame') || (bRec?.lifecycle === 'dynamicPerFrame');

    const baseW = aRec?.width ?? aTex?.image?.width ?? null;
    const baseH = aRec?.height ?? aTex?.image?.height ?? null;
    if (!baseW || !baseH) return null;

    const w = Math.max(1, Math.floor(baseW));
    const h = Math.max(1, Math.floor(baseH));

    const lo = (typeof recipe.lo === 'number' && isFinite(recipe.lo)) ? recipe.lo : 0.0;
    const hi = (typeof recipe.hi === 'number' && isFinite(recipe.hi)) ? recipe.hi : 1.0;

    const aUuid = aTex?.uuid ?? 'null';
    const bUuid = bTex?.uuid ?? 'null';
    const key = `${op}|${aUuid}|${bUuid}|${w}x${h}|lo${lo}|hi${hi}`;

    const rt = this._getOrCreateDerivedTargets(id, w, h, THREE.UnsignedByteType);
    if (!rt) return null;

    if (!dynamic && rt.key === key) {
      const outTexCached = rt.a.texture;
      this.setTexture(id, outTexCached, {
        space: aRec?.space ?? 'sceneUv',
        source: 'derived',
        channels: 'r',
        uvFlipY: false,
        lifecycle: aRec?.lifecycle ?? 'staticPerScene',
        width: w,
        height: h
      });
      return outTexCached;
    }
    rt.key = key;

    const prevTarget = this._renderer.getRenderTarget();

    const u = this._opMaterial.uniforms;
    u.tA.value = aTex;
    u.tB.value = bTex ?? aTex;
    if (op === 'invert') {
      u.uOp.value = 0.0;
    } else if (op === 'threshold') {
      u.uOp.value = 1.0;
    } else if (op === 'max') {
      u.uOp.value = 2.0;
    } else if (op === 'min') {
      u.uOp.value = 3.0;
    } else if (op === 'mul') {
      u.uOp.value = 4.0;
    } else {
      u.uOp.value = 4.0;
    }
    u.uLo.value = lo;
    u.uHi.value = hi;

    this._quadMesh.material = this._opMaterial;
    this._renderer.setRenderTarget(rt.a);
    this._renderer.clear();
    this._renderer.render(this._quadScene, this._quadCamera);

    this._renderer.setRenderTarget(prevTarget);

    const outTex = rt.a.texture;
    this.setTexture(id, outTex, {
      space: aRec?.space ?? 'sceneUv',
      source: 'derived',
      channels: 'r',
      uvFlipY: false,
      lifecycle: dynamic ? 'dynamicPerFrame' : (aRec?.lifecycle ?? 'staticPerScene'),
      width: w,
      height: h
    });
    return outTex;
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
      if (this._opMaterial) this._opMaterial.dispose();
    } catch (e) {
    }

    this._boostMaterial = null;
    this._blurMaterial = null;
    this._opMaterial = null;
    this._quadMesh = null;
    this._quadScene = null;
    this._quadCamera = null;
    this._renderer = null;
    this._tmpVec2 = null;
    this._recipes.clear();
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
    if (rec) return rec.texture;
    try {
      return this._getTextureInternal(id, new Set());
    } catch (e) {
      return null;
    }
  }

  getRecord(id) {
    return this._masks.get(id) ?? null;
  }

  listIds() {
    return Array.from(this._masks.keys());
  }
}
