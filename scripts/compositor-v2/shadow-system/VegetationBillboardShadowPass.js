/**
 * @fileoverview Renders vegetation canopy self-shadow into a screen-sized lit
 * factor texture (R=1 full light, lower = darker) for ShadowManagerV2.
 * Uses a wind-free offset+blur approximation so the pass stays cheap.
 */

export class VegetationBillboardShadowPass {
  constructor() {
    /** @type {THREE.WebGLRenderTarget|null} */
    this._target = null;
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._material = null;
    /** @type {THREE.Mesh|null} */
    this._clone = null;
  }

  get texture() {
    return this._target?.texture ?? null;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE || this._scene) return;
    this._scene = new THREE.Scene();
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        uMask: { value: null },
        uSunDir: { value: new THREE.Vector2(0, -1) },
        uShadowOpacity: { value: 0.5 },
        uShadowLength: { value: 0.01 },
        uShadowSoftness: { value: 0.5 },
        uIntensity: { value: 1.0 },
        uDeriveAlpha: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMask;
        uniform vec2 uSunDir;
        uniform float uShadowOpacity;
        uniform float uShadowLength;
        uniform float uShadowSoftness;
        uniform float uIntensity;
        uniform float uDeriveAlpha;
        varying vec2 vUv;

        float safeAlpha(vec4 s) {
          float a = s.a;
          if (uDeriveAlpha > 0.5 && a > 0.99) {
            float lum  = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
            float maxC = max(s.r, max(s.g, s.b));
            float minC = min(s.r, min(s.g, s.b));
            float chroma = maxC - minC;
            float isBright = step(0.85, lum);
            float isDesat  = 1.0 - step(0.06, chroma);
            float bg = isBright * isDesat;
            a *= (1.0 - bg);
          }
          return a;
        }

        void main() {
          vec2 shadowDir = normalize(vec2(uSunDir.x, -uSunDir.y));
          if (length(shadowDir) < 0.01) shadowDir = vec2(0.0, -1.0);
          vec2 shadowOffset = shadowDir * uShadowLength;
          float shadowBlur = max(0.0001, uShadowSoftness * 0.0008);
          vec2 shadowBaseUv = vUv - shadowOffset;
          vec2 step1 = vec2(shadowBlur);
          vec2 step2 = step1 * 2.0;

          float shadowAccum = 0.0;
          float shadowWeight = 0.0;
          float tap = safeAlpha(texture2D(uMask, shadowBaseUv));
          shadowAccum += tap * 0.24;
          shadowWeight += 0.24;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2( step1.x,  step1.y)));
          shadowAccum += tap * 0.12; shadowWeight += 0.12;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2(-step1.x,  step1.y)));
          shadowAccum += tap * 0.12; shadowWeight += 0.12;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2( step1.x, -step1.y)));
          shadowAccum += tap * 0.12; shadowWeight += 0.12;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2(-step1.x, -step1.y)));
          shadowAccum += tap * 0.12; shadowWeight += 0.12;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2( step2.x, 0.0)));
          shadowAccum += tap * 0.07; shadowWeight += 0.07;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2(-step2.x, 0.0)));
          shadowAccum += tap * 0.07; shadowWeight += 0.07;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2(0.0,  step2.y)));
          shadowAccum += tap * 0.07; shadowWeight += 0.07;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2(0.0, -step2.y)));
          shadowAccum += tap * 0.07; shadowWeight += 0.07;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2( step2.x,  step2.y)));
          shadowAccum += tap * 0.04; shadowWeight += 0.04;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2(-step2.x,  step2.y)));
          shadowAccum += tap * 0.04; shadowWeight += 0.04;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2( step2.x, -step2.y)));
          shadowAccum += tap * 0.04; shadowWeight += 0.04;
          tap = safeAlpha(texture2D(uMask, shadowBaseUv + vec2(-step2.x, -step2.y)));
          shadowAccum += tap * 0.04; shadowWeight += 0.04;

          float shadowA = (shadowWeight > 0.0) ? (shadowAccum / shadowWeight) : 0.0;
          shadowA *= clamp(uShadowOpacity, 0.0, 1.0) * clamp(uIntensity, 0.0, 1.0);
          float lit = clamp(1.0 - shadowA, 0.0, 1.0);
          gl_FragColor = vec4(lit, lit, lit, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    this._material.toneMapped = false;
  }

  onResize(w, h) {
    const THREE = window.THREE;
    if (!THREE) return;
    const rw = Math.max(2, Math.floor(w || 2));
    const rh = Math.max(2, Math.floor(h || 2));
    if (!this._target) {
      this._target = new THREE.WebGLRenderTarget(rw, rh, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this._target.texture.name = 'MapShineVegetationBillboardShadow';
      this._target.texture.flipY = false;
    } else {
      this._target.setSize(rw, rh);
    }
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {Iterable<{mesh: THREE.Mesh, uniforms: object}>} overlayEntries
   */
  render(renderer, camera, overlayEntries) {
    const THREE = window.THREE;
    if (!renderer || !camera || !this._material || !this._target) return;
    const prevRt = renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    this._material.blending = THREE.CustomBlending;
    this._material.blendEquation = THREE.AddEquation;
    this._material.blendSrc = THREE.DstColorFactor;
    this._material.blendDst = THREE.ZeroFactor;
    this._material.transparent = false;
    try {
      renderer.setRenderTarget(this._target);
      renderer.setClearColor(0xffffff, 1.0);
      renderer.clear(true, true, true);
      renderer.autoClear = false;
      const u = this._material.uniforms;
      for (const { mesh, uniforms } of overlayEntries) {
        if (!mesh || !uniforms) continue;
        const mask = uniforms.uTreeMask?.value ?? uniforms.uBushMask?.value ?? null;
        if (!mask) continue;
        u.uMask.value = mask;
        if (uniforms.uSunDir?.value) u.uSunDir.value.copy(uniforms.uSunDir.value);
        u.uShadowOpacity.value = Number(uniforms.uShadowOpacity?.value ?? 0.5);
        u.uShadowLength.value = Number(uniforms.uShadowLength?.value ?? 0.01);
        u.uShadowSoftness.value = Number(uniforms.uShadowSoftness?.value ?? 0.5);
        u.uIntensity.value = Number(uniforms.uIntensity?.value ?? 1.0);
        u.uDeriveAlpha.value = Number(uniforms.uDeriveAlpha?.value ?? 0.0);
        if (!this._clone) {
          this._clone = new THREE.Mesh(mesh.geometry, this._material);
          this._clone.frustumCulled = false;
        } else {
          this._clone.geometry = mesh.geometry;
          this._clone.material = this._material;
        }
        this._clone.position.copy(mesh.position);
        this._clone.rotation.copy(mesh.rotation);
        this._clone.scale.copy(mesh.scale);
        this._clone.updateMatrixWorld(true);
        this._scene.add(this._clone);
        renderer.render(this._scene, camera);
        this._scene.remove(this._clone);
      }
    } finally {
      this._material.blending = THREE.NoBlending;
      renderer.autoClear = prevAuto;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.setRenderTarget(prevRt);
    }
  }

  dispose() {
    try { this._target?.dispose?.(); } catch (_) {}
    try { this._material?.dispose?.(); } catch (_) {}
    this._target = null;
    this._material = null;
    this._clone = null;
    this._scene = null;
  }
}
