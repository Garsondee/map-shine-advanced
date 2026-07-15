/**
 * @fileoverview Jump Flood Algorithm (JFA) based Signed Distance Field generator
 * for vision masks. Converts a binary vision mask (white=visible, black=hidden)
 * into a smooth distance field that the fog shader can use for clean, 
 * resolution-independent edges — eliminating scallop artifacts from low-density
 * polygon boundaries.
 * 
 * Pipeline:
 *   1. Seed pass: detect edges in the binary mask → encode pixel coords into RG channels
 *   2. JFA passes (log2(N)): propagate nearest-edge coords via jump flood
 *   3. Distance pass: compute signed distance from propagated coords
 *   4. Fog shader samples the SDF for smooth edge blending
 * 
 * @module vision/VisionSDF
 */

import { createLogger } from '../core/log.js';

const log = createLogger('VisionSDF');

/**
 * Generates a Signed Distance Field from a binary vision mask using the
 * Jump Flood Algorithm. The SDF texture stores normalized signed distance
 * in the R channel: 0.5 = on edge, >0.5 = inside (visible), <0.5 = outside.
 */
export class VisionSDF {
  /**
   * @param {THREE.WebGLRenderer} renderer - The Three.js renderer
   * @param {number} width - Width of the vision render target
   * @param {number} height - Height of the vision render target
   */
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this.width = width;
    this.height = height;

    // Maximum distance in pixels that the SDF encodes. Values beyond this
    // are clamped. 32px covers any reasonable fog softness setting while
    // maximizing precision in the near-edge region that matters most.
    this._maxDistance = 32.0;

    // Ping-pong render targets for JFA passes (RGBAFloat for coordinate precision)
    this._jfaTargetA = null;
    this._jfaTargetB = null;

    // Final SDF output render target (single channel would suffice but RGBA is safer)
    this._sdfTarget = null;

    // Shared fullscreen quad scene for all passes
    this._quadScene = null;
    this._quadCamera = null;

    // Shader materials
    this._seedMaterial = null;
    this._jfaMaterial = null;
    this._distanceMaterial = null;

    // Track whether the SDF is up-to-date with the current vision mask
    this._dirty = true;

    this._initialized = false;
  }

  /**
   * Initialize all GPU resources.
   * Must be called after the renderer is ready.
   */
  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) return;

    const w = this.width;
    const h = this.height;

    // --- Render targets ---
    // JFA targets need to store pixel coordinates (up to 2048) with sub-pixel precision.
    // We use HalfFloatType for performance; FloatType if half-float isn't available.
    const floatType = THREE.HalfFloatType;
    const jfaOpts = {
      format: THREE.RGBAFormat,
      type: floatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    };
    this._jfaTargetA = new THREE.WebGLRenderTarget(w, h, jfaOpts);
    this._jfaTargetB = new THREE.WebGLRenderTarget(w, h, jfaOpts);

    // SDF output — HalfFloatType eliminates 8-bit quantization banding that
    // recreates staircase artifacts at edges. Linear filtering enables smooth
    // interpolation between texels for clean anti-aliased edges at any zoom.
    this._sdfTarget = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    });

    // --- Fullscreen quad ---
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quadScene = new THREE.Scene();
    // The quad mesh is swapped between materials for each pass
    this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quadScene.add(this._quadMesh);

    // --- Shader materials ---
    this._createSeedMaterial();
    this._createJFAMaterial();
    this._createDistanceMaterial();

    this._initialized = true;
    log.info(`VisionSDF initialized: ${w}x${h}`);
  }

  // ---------------------------------------------------------------------------
  // Shader creation
  // ---------------------------------------------------------------------------

  /**
   * Seed pass: detect edge pixels in the binary vision mask.
   * Edge pixels get their own UV encoded into RG; non-edge pixels get a
   * sentinel value (-1, -1) meaning "no seed found yet".
   * @private
   */
  _createSeedMaterial() {
    const THREE = window.THREE;
    this._seedMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tVision: { value: null },
        uTexelSize: { value: new THREE.Vector2(1.0 / this.width, 1.0 / this.height) }
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tVision;
        uniform vec2 uTexelSize;
        varying vec2 vUv;

        void main() {
          float c = texture2D(tVision, vUv).r;

          // Sample 4-connected neighbors to detect edges
          float l = texture2D(tVision, vUv + vec2(-uTexelSize.x, 0.0)).r;
          float r = texture2D(tVision, vUv + vec2( uTexelSize.x, 0.0)).r;
          float d = texture2D(tVision, vUv + vec2(0.0, -uTexelSize.y)).r;
          float u = texture2D(tVision, vUv + vec2(0.0,  uTexelSize.y)).r;

          // An edge pixel is one where at least one neighbor differs
          // (threshold at 0.5 to handle bilinear bleed)
          float cBin = step(0.5, c);
          float diff = abs(cBin - step(0.5, l))
                     + abs(cBin - step(0.5, r))
                     + abs(cBin - step(0.5, d))
                     + abs(cBin - step(0.5, u));
          bool isEdge = diff > 0.0;

          if (isEdge) {
            // Seed: store own UV coordinates and the inside/outside flag
            gl_FragColor = vec4(vUv, cBin, 1.0);
          } else {
            // No seed: sentinel (-1, -1)
            gl_FragColor = vec4(-1.0, -1.0, cBin, 0.0);
          }
        }
      `,
      depthWrite: false,
      depthTest: false
    });
  }

  /**
   * JFA step pass: for each pixel, check 9 neighbors at the current step
   * distance and keep the closest seed coordinate.
   * @private
   */
  _createJFAMaterial() {
    const THREE = window.THREE;
    this._jfaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPrevious: { value: null },
        uStepSize: { value: 1.0 },
        uTexelSize: { value: new THREE.Vector2(1.0 / this.width, 1.0 / this.height) },
        // Aspect correction: distance should be computed in pixels, not UVs
        uAspect: { value: new THREE.Vector2(this.width, this.height) }
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tPrevious;
        uniform float uStepSize;
        uniform vec2 uTexelSize;
        uniform vec2 uAspect;
        varying vec2 vUv;

        void main() {
          vec2 bestSeed = vec2(-1.0);
          float bestDist = 1e10;
          float inside = 0.0;

          // Check 3x3 neighborhood at current step distance.
          // Avoid 'continue' for WebGL1 compatibility — use conditional instead.
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 offset = vec2(float(x), float(y)) * uStepSize * uTexelSize;
              vec2 sampleUv = clamp(vUv + offset, vec2(0.0), vec2(1.0));

              vec4 data = texture2D(tPrevious, sampleUv);
              vec2 seedUv = data.rg;

              // Only consider samples that have a valid seed (not -1 sentinel)
              if (seedUv.x >= 0.0) {
                // Distance in pixel space (aspect-corrected)
                vec2 diff = (vUv - seedUv) * uAspect;
                float dist = dot(diff, diff);

                if (dist < bestDist) {
                  bestDist = dist;
                  bestSeed = seedUv;
                  inside = data.b;
                }
              }
            }
          }

          // Read our own data as fallback
          vec4 self = texture2D(tPrevious, vUv);
          if (bestSeed.x < 0.0) {
            // No seed found in neighborhood — keep self
            gl_FragColor = self;
          } else {
            gl_FragColor = vec4(bestSeed, inside, 1.0);
          }
        }
      `,
      depthWrite: false,
      depthTest: false
    });
  }

  /**
   * Distance pass: compute signed distance from the nearest seed coordinate
   * and encode it as a normalized value (0.5 = edge, >0.5 = inside).
   * @private
   */
  _createDistanceMaterial() {
    const THREE = window.THREE;
    this._distanceMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tJFA: { value: null },
        tVision: { value: null },
        uAspect: { value: new THREE.Vector2(this.width, this.height) },
        uMaxDistance: { value: this._maxDistance }
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tJFA;
        uniform sampler2D tVision;
        uniform vec2 uAspect;
        uniform float uMaxDistance;
        varying vec2 vUv;

        void main() {
          vec4 jfa = texture2D(tJFA, vUv);
          vec2 seedUv = jfa.rg;
          float vision = texture2D(tVision, vUv).r;
          bool isInside = vision > 0.5;

          float dist;
          if (seedUv.x < 0.0) {
            // No seed found — far from any edge. Use max distance.
            dist = uMaxDistance;
          } else {
            // Distance to nearest edge in pixels
            vec2 diff = (vUv - seedUv) * uAspect;
            dist = sqrt(dot(diff, diff));
          }

          // Sign: positive inside, negative outside
          float signedDist = isInside ? dist : -dist;

          // Normalize to 0..1 range: 0.5 = on edge
          float normalized = clamp(signedDist / uMaxDistance * 0.5 + 0.5, 0.0, 1.0);

          gl_FragColor = vec4(normalized, normalized, normalized, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Compute the SDF from the given binary vision texture.
   * Only call this when the vision mask has actually changed.
   * @param {THREE.Texture} visionTexture - The binary vision mask (white=visible)
   * @returns {THREE.Texture} The SDF texture (sample .r: 0.5=edge, >0.5=inside)
   */
  update(visionTexture) {
    if (!this._initialized || !visionTexture) return this.getTexture();
    const THREE = window.THREE;

    const currentTarget = this.renderer.getRenderTarget();

    // --- Pass 1: Seed ---
    this._seedMaterial.uniforms.tVision.value = visionTexture;
    this._quadMesh.material = this._seedMaterial;
    this.renderer.setRenderTarget(this._jfaTargetA);
    this.renderer.render(this._quadScene, this._quadCamera);

    // --- Passes 2..N: JFA flood ---
    // Step sizes: largest power-of-2 ≤ max(width, height), halving each pass
    const maxDim = Math.max(this.width, this.height);
    let stepSize = 1;
    while (stepSize * 2 <= maxDim) stepSize *= 2;

    let readTarget = this._jfaTargetA;
    let writeTarget = this._jfaTargetB;

    this._quadMesh.material = this._jfaMaterial;

    while (stepSize >= 1) {
      this._jfaMaterial.uniforms.tPrevious.value = readTarget.texture;
      this._jfaMaterial.uniforms.uStepSize.value = stepSize;

      this.renderer.setRenderTarget(writeTarget);
      this.renderer.render(this._quadScene, this._quadCamera);

      // Swap
      const tmp = readTarget;
      readTarget = writeTarget;
      writeTarget = tmp;

      stepSize = Math.floor(stepSize / 2);
    }

    // --- Pass N+1: Distance computation ---
    this._distanceMaterial.uniforms.tJFA.value = readTarget.texture;
    this._distanceMaterial.uniforms.tVision.value = visionTexture;
    this._quadMesh.material = this._distanceMaterial;
    this.renderer.setRenderTarget(this._sdfTarget);
    this.renderer.render(this._quadScene, this._quadCamera);

    // Restore
    this.renderer.setRenderTarget(currentTarget);

    this._dirty = false;
    return this._sdfTarget.texture;
  }

  /**
   * Get the current SDF texture. May be stale if update() hasn't been called.
   * @returns {THREE.Texture|null}
   */
  getTexture() {
    return this._sdfTarget?.texture ?? null;
  }

  /**
   * Mark the SDF as needing recomputation.
   */
  markDirty() {
    this._dirty = true;
  }

  /**
   * @returns {boolean} Whether the SDF needs recomputation.
   */
  get isDirty() {
    return this._dirty;
  }

  /**
   * @returns {number} The maximum distance (in pixels) encoded in the SDF.
   */
  get maxDistance() {
    return this._maxDistance;
  }

  /**
   * Resize the SDF targets to match a new vision RT size.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;

    if (this._jfaTargetA) this._jfaTargetA.setSize(width, height);
    if (this._jfaTargetB) this._jfaTargetB.setSize(width, height);
    if (this._sdfTarget) this._sdfTarget.setSize(width, height);

    // Update uniforms that depend on resolution
    const texel = new window.THREE.Vector2(1.0 / width, 1.0 / height);
    const aspect = new window.THREE.Vector2(width, height);

    if (this._seedMaterial) this._seedMaterial.uniforms.uTexelSize.value.copy(texel);
    if (this._jfaMaterial) {
      this._jfaMaterial.uniforms.uTexelSize.value.copy(texel);
      this._jfaMaterial.uniforms.uAspect.value.copy(aspect);
    }
    if (this._distanceMaterial) this._distanceMaterial.uniforms.uAspect.value.copy(aspect);

    this._dirty = true;
    log.debug(`VisionSDF resized: ${width}x${height}`);
  }

  /**
   * Dispose all GPU resources.
   */
  dispose() {
    try { this._jfaTargetA?.dispose(); } catch (_) {}
    try { this._jfaTargetB?.dispose(); } catch (_) {}
    try { this._sdfTarget?.dispose(); } catch (_) {}
    try { this._seedMaterial?.dispose(); } catch (_) {}
    try { this._jfaMaterial?.dispose(); } catch (_) {}
    try { this._distanceMaterial?.dispose(); } catch (_) {}
    try { this._quadMesh?.geometry?.dispose(); } catch (_) {}

    this._jfaTargetA = null;
    this._jfaTargetB = null;
    this._sdfTarget = null;
    this._seedMaterial = null;
    this._jfaMaterial = null;
    this._distanceMaterial = null;
    this._quadMesh = null;
    this._quadScene = null;
    this._quadCamera = null;

    this._initialized = false;
    log.info('VisionSDF disposed');
  }
}
