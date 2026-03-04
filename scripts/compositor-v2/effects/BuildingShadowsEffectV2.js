/**
 * @fileoverview BuildingShadowsEffectV2 — V2 building shadow bake.
 *
 * This is a clean V2 implementation (not a patched V1 port).
 *
 * Core idea:
 * - Treat dark regions in the `_Outdoors` mask as structure occluders.
 * - Bake a greyscale "shadow factor" texture in scene-UV space:
 *     1.0 = fully lit, 0.0 = fully shadowed.
 * - LightingEffectV2 samples this bake using world→sceneUV reconstruction,
 *   so the shadow is world-stable and respects Foundry padding.
 *
 * Multi-floor behavior:
 * - Build a union outdoors canvas from all floors `<= maxFloorIndex`.
 * - Bake uses the union canvas so ascending floors lengthens/extends shadows
 *   where upper-floor silhouettes add occluder area.
 *
 * @module compositor-v2/effects/BuildingShadowsEffectV2
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('BuildingShadowsEffectV2');

const DEFAULT_BAKE_SIZE = 1024;

export class BuildingShadowsEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._enabled = true;

    /** @type {{enabled:boolean, opacity:number, length:number, quality:number, blurStrength:number}} */
    this.params = {
      enabled: true,
      opacity: 0.75,
      length: 0.06,
      quality: 80,
      blurStrength: 0.3,
    };

    // Outdoors mask now obtained from GpuSceneMaskCompositor (central asset system)

    /** @type {HTMLCanvasElement|null} */
    this._unionCanvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this._unionCtx = null;
    /** @type {THREE.CanvasTexture|null} */
    this._unionTexture = null;

    /** @type {THREE.Scene|null} */
    this._bakeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._bakeCamera = null;
    /** @type {THREE.Mesh|null} */
    this._bakeQuad = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._bakeMaterial = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this._bakeTarget = null;

    /** @type {THREE.Vector2|null} */
    this._sunDir = null;

    /** @type {number} */
    this._maxFloorIndex = 0;
    /** @type {string} */
    this._lastBakeHash = '';
    /** @type {boolean} */
    this._needsBake = true;
    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} */
    this._dbgMaskStatsLoggedOnce = false;
  }

  // ── Enabled getter/setter (Design Contract) ─────────────────────────────
  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.params.enabled = this._enabled;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'main',
          label: 'Building Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'quality', 'blurStrength']
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Shadow Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.75
        },
        length: {
          type: 'slider',
          label: 'Shadow Length',
          min: 0.0,
          max: 0.3,
          step: 0.005,
          default: 0.06
        },
        quality: {
          type: 'slider',
          label: 'Quality (Samples)',
          min: 8,
          max: 128,
          step: 1,
          default: 80
        },
        blurStrength: {
          type: 'slider',
          label: 'Blur Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.3
        },
      }
    };
  }

  /**
   * Texture consumed by LightingEffectV2.
   * @returns {THREE.Texture|null}
   */
  get shadowFactorTexture() {
    return this._bakeTarget?.texture ?? null;
  }

  /**
   * Design Contract: populate() exists even if this effect is provider-driven.
   * @param {object} _foundrySceneData
   */
  async populate(_foundrySceneData) {
    if (!this._initialized) return;
    this._rebuildUnionMask();
    this._needsBake = true;
  }

  /**
   * Design Contract: respond to resize.
   * Building shadows are baked in scene-UV space, so output resolution can be fixed.
   * We still keep the method to satisfy the lifecycle contract.
   */
  onResize(_width, _height) {}

  /**
   * Building shadows are bake-on-change; they do not require continuous rendering.
   */
  wantsContinuousRender() { return false; }

  /**
   * FloorCompositor pushes sun angles from SkyColorEffectV2.
   * @param {number} azimuthDeg
   * @param {number} _elevationDeg
   */
  setSunAngles(azimuthDeg, _elevationDeg) {
    const THREE = window.THREE;
    if (!THREE) return;

    // Match the proven V1/BuildingShadows convention used elsewhere:
    // x = -sin(azimuth)
    // y = -cos(azimuth) * lat
    // In V2, we keep the "latitude" clamp as a tiny constant because SkyColor already
    // models solar elevation. This is a stylistic 2.5D shadow length control.
    const az = (Number(azimuthDeg) || 0) * (Math.PI / 180);
    const x = -Math.sin(az);
    const lat = 0.03;
    const y = -Math.cos(az) * lat;

    if (!this._sunDir) this._sunDir = new THREE.Vector2(x, y);
    else this._sunDir.set(x, y);
  }

  /**
   * One-time setup of GPU resources.
   * @param {THREE.WebGLRenderer} renderer
   */
  initialize(renderer) {
    const THREE = window.THREE;
    if (!THREE || this._initialized) return;

    // Union canvas (CPU) → CanvasTexture (GPU)
    this._unionCanvas = document.createElement('canvas');
    this._unionCanvas.width = DEFAULT_BAKE_SIZE;
    this._unionCanvas.height = DEFAULT_BAKE_SIZE;
    this._unionCtx = this._unionCanvas.getContext('2d', { willReadFrequently: false });
    this._unionTexture = new THREE.CanvasTexture(this._unionCanvas);
    // The union mask is authored in Foundry-space (Y-down) and should be sampled
    // as-is (no implicit Y flip).
    this._unionTexture.flipY = false;
    this._unionTexture.wrapS = THREE.ClampToEdgeWrapping;
    this._unionTexture.wrapT = THREE.ClampToEdgeWrapping;
    this._unionTexture.minFilter = THREE.LinearFilter;
    this._unionTexture.magFilter = THREE.LinearFilter;

    // Bake target: greyscale factor (stored in RGBA for compatibility)
    this._bakeTarget = new THREE.WebGLRenderTarget(DEFAULT_BAKE_SIZE, DEFAULT_BAKE_SIZE, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    this._bakeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;

    // Bake scene
    this._bakeScene = new THREE.Scene();
    this._bakeCamera = new THREE.OrthographicCamera(0, 1, 0, 1, 0, 1);

    this._bakeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tOutdoors: { value: this._unionTexture },
        uLength: { value: this.params.length },
        uSampleCount: { value: this.params.quality },
        uSunDir: { value: new THREE.Vector2(0, 1) },
        uPenumbraRadiusNear: { value: 0.0 },
        uPenumbraRadiusFar: { value: 0.06 },
        uPenumbraSamples: { value: 3.0 },
        uPenumbraExponent: { value: 1.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tOutdoors;
        uniform float uLength;
        uniform float uSampleCount;
        uniform vec2 uSunDir;
        uniform float uPenumbraRadiusNear;
        uniform float uPenumbraRadiusFar;
        uniform float uPenumbraSamples;
        uniform float uPenumbraExponent;
        varying vec2 vUv;

        float outdoorsValue(vec2 uv) {
          vec4 c = texture2D(tOutdoors, uv);
          float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
          return max(luma, c.a);
        }

        bool inBounds(vec2 uv) {
          const float eps = 0.0005;
          return uv.x >= eps && uv.x <= 1.0 - eps && uv.y >= eps && uv.y <= 1.0 - eps;
        }

        void main() {
          // The union outdoors mask is a Foundry-space canvas (Y-down, flipY=false).
          // Convert bake quad vUv (Y-up) into Foundry UV for sampling.
          vec2 uvMask = vec2(vUv.x, 1.0 - vUv.y);

          float selfOutdoors = outdoorsValue(uvMask);
          if (selfOutdoors < 0.5) {
            gl_FragColor = vec4(1.0);
            return;
          }

          // uSunDir comes in as a Three/world vector (Y-up). Convert to Foundry UV space.
          vec2 dir = normalize(vec2(uSunDir.x, -uSunDir.y));
          float samples = max(uSampleCount, 1.0);

          vec2 perp = normalize(vec2(-dir.y, dir.x));
          float penumbraCount = max(uPenumbraSamples, 1.0);

          float totalOcclusion = 0.0;
          float totalWeight = 0.0;

          const int MAX_STEPS = 128;
          for (int i = 0; i < MAX_STEPS; i++) {
            float fi = float(i);
            if (fi >= samples) break;

            float t = (samples > 1.0) ? (fi / (samples - 1.0)) : 0.0;
            vec2 baseUv = uvMask - dir * (t * uLength);
            if (!inBounds(baseUv)) continue;

            float rLerp = pow(t, uPenumbraExponent);
            float radius = mix(uPenumbraRadiusNear, uPenumbraRadiusFar, rLerp);

            float occlusion = 0.0;
            float weightSum = 0.0;

            int maxPenumbra = 16;
            int taps = int(clamp(penumbraCount, 1.0, float(maxPenumbra)));

            if (taps <= 1 || radius <= 1e-5) {
              float outdoors = outdoorsValue(baseUv);
              occlusion = (outdoors < 0.5) ? 1.0 : 0.0;
              weightSum = 1.0;
            } else {
              for (int j = 0; j < maxPenumbra; j++) {
                if (j >= taps) continue;

                float fj = float(j);
                float halfCount = (float(taps) - 1.0) * 0.5;
                float offsetIndex = fj - halfCount;
                float norm = (halfCount > 0.0) ? (offsetIndex / halfCount) : 0.0;
                float w = 1.0 - abs(norm);

                vec2 sampleUv = baseUv + perp * (norm * radius);
                float outdoors = 1.0;
                if (inBounds(sampleUv)) {
                  outdoors = outdoorsValue(sampleUv);
                }
                float indoor = (outdoors < 0.5) ? 1.0 : 0.0;
                occlusion += indoor * w;
                weightSum += w;
              }
            }

            if (weightSum > 0.0) occlusion /= weightSum;

            // Weight nearer occluders more strongly.
            // The previous pow(t, ...) weighting suppressed early samples so much
            // that shadows could become nearly invisible on typical maps.
            float distanceWeight = 1.0 - t;
            totalOcclusion += occlusion * distanceWeight;
            totalWeight += distanceWeight;
          }

          float avgOcclusion = (totalWeight > 0.0)
            ? clamp(totalOcclusion / totalWeight, 0.0, 1.0)
            : 0.0;

          float shadowFactor = 1.0 - avgOcclusion;
          gl_FragColor = vec4(shadowFactor, shadowFactor, shadowFactor, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this._bakeMaterial.toneMapped = false;

    this._bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._bakeMaterial);
    this._bakeQuad.position.set(0.5, 0.5, 0);
    this._bakeScene.add(this._bakeQuad);

    // Seed sun direction
    this.setSunAngles(0, 0);

    this._rebuildUnionMask();
    this._needsBake = true;
    this._initialized = true;
    log.info('initialized');
  }

  /**
   * Called by FloorCompositor when visible floors change.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    const next = Math.max(0, Number(maxFloorIndex) || 0);
    if (next === this._maxFloorIndex) return;
    this._maxFloorIndex = next;
    this._rebuildUnionMask();
    this._needsBake = true;
  }

  update() {
    if (!this._enabled) return;
    if (!this._initialized) return;

    const THREE = window.THREE;
    if (!THREE || !this._bakeMaterial) return;

    const blur = THREE.MathUtils.clamp(Number(this.params.blurStrength) || 0, 0.0, 1.0);
    const pFar = 0.02 + blur * 0.18;
    const taps = Math.round(1 + blur * (9 - 1));
    const exp = 0.5 + blur * 2.0;

    const sun = this._sunDir ?? new THREE.Vector2(0, 1);

    const bakeState = {
      sunX: sun.x.toFixed(4),
      sunY: sun.y.toFixed(4),
      length: Number(this.params.length) || 0,
      quality: Math.max(1, Math.floor(Number(this.params.quality) || 1)),
      pFar,
      taps,
      exp,
      floors: this._maxFloorIndex,
      unionId: this._unionTexture ? this._unionTexture.uuid : 'null',
    };
    const hash = JSON.stringify(bakeState);
    if (hash !== this._lastBakeHash) {
      this._lastBakeHash = hash;
      this._needsBake = true;
    }

    const u = this._bakeMaterial.uniforms;
    u.uLength.value = Number(this.params.length) || 0;
    u.uSampleCount.value = Math.max(1, Math.floor(Number(this.params.quality) || 1));
    u.uSunDir.value.copy(sun);
    u.uPenumbraRadiusNear.value = 0.0;
    u.uPenumbraRadiusFar.value = pFar;
    u.uPenumbraSamples.value = Math.max(1, Math.min(9, taps));
    u.uPenumbraExponent.value = exp;
  }

  /**
   * Called every frame by FloorCompositor; bakes only when dirty.
   * @param {THREE.WebGLRenderer} renderer
   */
  render(renderer) {
    if (!this._enabled) return;
    if (!this._initialized) return;
    if (!renderer || !this._bakeScene || !this._bakeCamera || !this._bakeTarget) return;

    if (!this._needsBake) return;

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor?.(new window.THREE.Color());
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this._bakeTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.autoClear = true;
    renderer.clear();
    renderer.render(this._bakeScene, this._bakeCamera);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    // CRITICAL: never restore clearAlpha to 0; a 0 alpha can expose stale PIXI underneath.
    if (prevClear) renderer.setClearColor(prevClear, 1);

    this._needsBake = false;
  }

  _rebuildUnionMask() {
    if (!this._unionCanvas || !this._unionCtx || !this._unionTexture) return;

    // Get outdoors masks from GpuSceneMaskCompositor
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
    if (!compositor) return;

    // Find the first available floor texture to determine canvas size
    const floorMax = Math.max(0, this._maxFloorIndex);
    let refTexture = null;
    for (let i = floorMax; i >= 0; i--) {
      const ctx = window.MapShine?.activeLevelContext;
      const floorKey = ctx ? `${ctx.bottom}:${ctx.top}` : 'ground';
      const tex = compositor.getFloorTexture(floorKey, 'outdoors');
      if (tex?.image) {
        refTexture = tex;
        break;
      }
    }
    if (!refTexture?.image) return;

    const desiredW = refTexture.image.width;
    const desiredH = refTexture.image.height;

    if (this._unionCanvas.width !== desiredW || this._unionCanvas.height !== desiredH) {
      this._unionCanvas.width = desiredW;
      this._unionCanvas.height = desiredH;
      // Resizing the canvas invalidates context state; reacquire.
      this._unionCtx = this._unionCanvas.getContext('2d', { willReadFrequently: false });
      if (this._bakeTarget && window.THREE) {
        try { this._bakeTarget.dispose(); } catch (_) {}
        const THREE = window.THREE;
        this._bakeTarget = new THREE.WebGLRenderTarget(desiredW, desiredH, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          depthBuffer: false,
          stencilBuffer: false,
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
        });
        this._bakeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
      }
    }

    const ctx = this._unionCtx;
    const w = refTexture.image.width;
    const h = refTexture.image.height;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i <= floorMax; i++) {
      const ctx = window.MapShine?.activeLevelContext;
      const floorKey = ctx ? `${ctx.bottom}:${ctx.top}` : 'ground';
      const tex = compositor.getFloorTexture(floorKey, 'outdoors');
      if (!tex?.image) continue;
      this._unionCtx.globalCompositeOperation = 'lighten';
      this._unionCtx.drawImage(tex.image, 0, 0, w, h);
    }

    ctx.restore();
    this._unionTexture.needsUpdate = true;

    // One-shot diagnostics for the most common "no visible shadows" failure:
    // - No authored _Outdoors mask exists
    // - Mask is inverted (outdoors=black, indoors=white)
    if (!this._dbgMaskStatsLoggedOnce) {
      this._dbgMaskStatsLoggedOnce = true;
      try {
        const sample = ctx.getImageData(0, 0, Math.min(64, w), Math.min(64, h)).data;
        let white = 0;
        let black = 0;
        const n = Math.max(1, sample.length / 4);
        for (let i = 0; i < sample.length; i += 4) {
          const v = sample[i];
          if (v > 200) white++;
          else if (v < 55) black++;
        }
        const whiteRatio = white / n;
        const blackRatio = black / n;
        if (whiteRatio < 0.05) {
          log.warn(`Outdoors union mask is almost entirely dark (whiteRatio=${whiteRatio.toFixed(3)}). This usually means your _Outdoors mask is inverted (outdoors=black) or missing. Building shadows will appear fully disabled in this case.`);
        } else if (blackRatio < 0.01) {
          log.warn(`Outdoors union mask is almost entirely white (blackRatio=${blackRatio.toFixed(3)}). This means there are no building occluders in _Outdoors, so shadows will be minimal/absent.`);
        }
      } catch (_) {}
    }

    if (this._bakeMaterial?.uniforms?.tOutdoors) {
      this._bakeMaterial.uniforms.tOutdoors.value = this._unionTexture;
    }
  }

  dispose() {
    // Outdoors mask provider removed

    if (this._bakeTarget) {
      this._bakeTarget.dispose();
      this._bakeTarget = null;
    }
    if (this._bakeMaterial) {
      this._bakeMaterial.dispose();
      this._bakeMaterial = null;
    }
    if (this._unionTexture) {
      this._unionTexture.dispose();
      this._unionTexture = null;
    }

    this._bakeQuad = null;
    this._bakeScene = null;
    this._bakeCamera = null;
    this._unionCanvas = null;
    this._unionCtx = null;
    this._sunDir = null;

    this._initialized = false;
  }
}
