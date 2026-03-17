/**
 * @fileoverview FloorDepthBlurEffect — Kawase multi-pass blur on floors below the active level.
 *
 * When the player is on floor N > 0, each floor f below it receives a Kawase
 * blur pass proportional to its depth (N - f): the further below, the stronger
 * the blur. The blurred floors are progressively alpha-composited, then the
 * active floor (and above) is rendered sharp on top, producing a depth-of-field
 * style effect between levels.
 *
 * Pipeline (called from FloorCompositor before the main bus render):
 *   For each floor f from 0 to (activeFloor - 1):
 *     1. render(f)    — renderFloorRangeTo → _scratchA (transparent bg, except floor 0 gets bg planes)
 *     2. blur(depth)  — N Kawase passes ping-pong between _scratchA / _scratchB
 *     3. accumulate   — alpha-composite result into _accumA / _accumB (ping-pong)
 *   After loop, render active+above → _scratchA (transparent bg)
 *   Final composite: accum (bg) + _scratchA (fg, sharp active) → target RT
 *
 * @module compositor-v2/effects/FloorDepthBlurEffect
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('FloorDepthBlurEffect');

// ─── Shaders ─────────────────────────────────────────────────────────────────

/** Kawase blur pass: 4-corner tent filter at ±offset (in UV space). Running this
 *  N times with increasing per-iteration offsets produces a very smooth blur. */
const KAWASE_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const KAWASE_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uOffset;       // pixel-space offset pre-multiplied by texelSize
  varying vec2 vUv;

  void main() {
    vec4 a = texture2D(tDiffuse, vUv + vec2(-uOffset.x, -uOffset.y));
    vec4 b = texture2D(tDiffuse, vUv + vec2( uOffset.x, -uOffset.y));
    vec4 c = texture2D(tDiffuse, vUv + vec2(-uOffset.x,  uOffset.y));
    vec4 d = texture2D(tDiffuse, vUv + vec2( uOffset.x,  uOffset.y));
    gl_FragColor = (a + b + c + d) * 0.25;
  }
`;

/** Alpha-over composite: fg placed over bg using standard Porter-Duff over. */
const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tBg;
  uniform sampler2D tFg;
  varying vec2 vUv;

  void main() {
    vec4 bg = texture2D(tBg, vUv);
    vec4 fg = texture2D(tFg, vUv);
    // Porter-Duff over: fg on top of bg
    float outA = fg.a + bg.a * (1.0 - fg.a);
    vec3  outC = fg.a > 0.0
      ? (fg.rgb * fg.a + bg.rgb * bg.a * (1.0 - fg.a)) / max(outA, 0.0001)
      : bg.rgb;
    gl_FragColor = vec4(outC, outA);
  }
`;

/** Simple blit: copy input texture to output with no blending. */
const BLIT_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
`;

// ─── FloorDepthBlurEffect ─────────────────────────────────────────────────────

export class FloorDepthBlurEffect {
  constructor() {
    this._initialized = false;

    this.params = {
      /** Master toggle — no-op when false, falls through to normal bus render. */
      enabled: false,
      /**
       * Blur radius in screen pixels applied per floor of depth.
       * Depth-1 floor gets 1×, depth-2 gets 2×, etc.
       */
      blurRadiusPx: 6,
      /**
       * Kawase iterations PER floor depth level. More = smoother but costlier.
       * Each iteration is one fullscreen quad draw call.
       */
      itersPerDepth: 2,
      /** Hard cap on total Kawase iterations to bound GPU cost. */
      maxIters: 6,
    };

    // ── Blit scene (shared ortho quad) ────────────────────────────────────────
    /** @type {import('three').Scene|null} */
    this._quadScene = null;
    /** @type {import('three').OrthographicCamera|null} */
    this._quadCamera = null;
    /** @type {import('three').Mesh|null} */
    this._quadMesh = null;

    // ── Materials ─────────────────────────────────────────────────────────────
    /** @type {import('three').ShaderMaterial|null} Kawase blur pass */
    this._kawaseMat = null;
    /** @type {import('three').ShaderMaterial|null} Alpha-over composite */
    this._compositeMat = null;
    /** @type {import('three').ShaderMaterial|null} Simple blit */
    this._blitMat = null;

    // ── Internal render targets ────────────────────────────────────────────────
    /** Scratch A — single-floor tile render + blur ping-pong slot A */
    this._scratchA = null;
    /** Scratch B — blur ping-pong slot B */
    this._scratchB = null;
    /** Accumulation ping-pong A */
    this._accumA = null;
    /** Accumulation ping-pong B */
    this._accumB = null;
  }

  // ── Control schema ──────────────────────────────────────────────────────────

  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'floorDepthBlur',
          label: 'Floor Depth Blur',
          type: 'inline',
          parameters: ['blurRadiusPx', 'itersPerDepth', 'maxIters'],
        },
      ],
      parameters: {
        blurRadiusPx:  { type: 'slider', min: 1, max: 30, step: 0.5, default: 6,
                         label: 'Blur Radius (px/floor)' },
        itersPerDepth: { type: 'slider', min: 1, max: 4, step: 1, default: 2,
                         label: 'Iterations/Floor' },
        maxIters:      { type: 'slider', min: 2, max: 12, step: 1, default: 6,
                         label: 'Max Iterations (cap)' },
      },
      presets: {
        'Subtle':   { blurRadiusPx: 3,  itersPerDepth: 1 },
        'Moderate': { blurRadiusPx: 6,  itersPerDepth: 2 },
        'Heavy':    { blurRadiusPx: 12, itersPerDepth: 3 },
      },
    };
  }

  // ── Enabled accessor ────────────────────────────────────────────────────────

  /** Mirror `params.enabled` as a first-class property so _propagateToV2 can
   *  use the `effect.enabled = value` setter path consistently. */
  get enabled() {
    return !!this.params.enabled;
  }

  set enabled(v) {
    this.params.enabled = !!v;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} width
   * @param {number} height
   * @param {number} [preferredType] - THREE texture type (HalfFloat or UnsignedByte)
   */
  initialize(renderer, width, height, preferredType) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;

    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const type = preferredType ?? THREE.HalfFloatType;

    const makeRT = () => {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type,
        depthBuffer: false,
        stencilBuffer: false,
      });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      return rt;
    };

    this._scratchA = makeRT();
    this._scratchB = makeRT();
    this._accumA   = makeRT();
    this._accumB   = makeRT();

    // ── Shared fullscreen quad ─────────────────────────────────────────────
    this._quadScene  = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);
    this._quadMesh = new THREE.Mesh(geo, null);
    this._quadMesh.frustumCulled = false;
    this._quadScene.add(this._quadMesh);

    // ── Materials ────────────────────────────────────────────────────────────
    const matBase = {
      depthTest: false, depthWrite: false, toneMapped: false,
      // NoBlending is critical: NormalBlending (the default) would premultiply
      // alpha into RGB when the autoClear step writes an opaque background first,
      // compounding across blur passes into white blow-out.
      blending: THREE.NoBlending,
    };

    this._kawaseMat = new THREE.ShaderMaterial({
      ...matBase,
      uniforms: {
        tDiffuse: { value: null },
        uOffset:  { value: new THREE.Vector2(0, 0) },
      },
      vertexShader:   KAWASE_VERT,
      fragmentShader: KAWASE_FRAG,
    });

    this._compositeMat = new THREE.ShaderMaterial({
      ...matBase,
      uniforms: {
        tBg: { value: null },
        tFg: { value: null },
      },
      vertexShader:   KAWASE_VERT,
      fragmentShader: COMPOSITE_FRAG,
    });

    this._blitMat = new THREE.ShaderMaterial({
      ...matBase,
      uniforms: { tDiffuse: { value: null } },
      vertexShader:   KAWASE_VERT,
      fragmentShader: BLIT_FRAG,
    });

    this._initialized = true;
    log.info(`FloorDepthBlurEffect initialized (${w}×${h})`);
  }

  onResize(width, height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this._scratchA?.setSize(w, h);
    this._scratchB?.setSize(w, h);
    this._accumA?.setSize(w, h);
    this._accumB?.setSize(w, h);
  }

  dispose() {
    try { this._kawaseMat?.dispose(); }    catch (_) {}
    try { this._compositeMat?.dispose(); } catch (_) {}
    try { this._blitMat?.dispose(); }      catch (_) {}
    try { this._quadMesh?.geometry?.dispose(); } catch (_) {}
    try { this._scratchA?.dispose(); } catch (_) {}
    try { this._scratchB?.dispose(); } catch (_) {}
    try { this._accumA?.dispose(); }   catch (_) {}
    try { this._accumB?.dispose(); }   catch (_) {}
    this._quadScene = this._quadCamera = this._quadMesh = null;
    this._kawaseMat = this._compositeMat = this._blitMat = null;
    this._scratchA = this._scratchB = this._accumA = this._accumB = null;
    this._initialized = false;
    log.info('FloorDepthBlurEffect disposed');
  }

  // ── Main API ────────────────────────────────────────────────────────────────

  /**
   * Render blurred below-floor content plus sharp active+above content into
   * `outputRT`. When the active floor is 0 (or the effect is disabled) this
   * falls through to a plain full-bus render via `bus.renderTo`.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   * @param {import('../FloorRenderBus.js').FloorRenderBus} bus
   * @param {number} activeFloorIndex - Index of the currently viewed floor
   * @param {import('three').WebGLRenderTarget} outputRT - Destination (usually _sceneRT)
   */
  render(renderer, camera, bus, activeFloorIndex, outputRT) {
    if (!this._initialized || !this.params.enabled || activeFloorIndex <= 0) {
      // Fall through: standard full-bus render to sceneRT.
      bus.renderTo(renderer, camera, outputRT);
      return;
    }

    const {
      blurRadiusPx,
      itersPerDepth,
      maxIters,
    } = this.params;
    const zoomScale = this._getEffectiveZoom(camera);

    // Texel size for the output RT.
    const texW = Math.max(1, outputRT.width);
    const texH = Math.max(1, outputRT.height);
    const texelW = 1 / texW;
    const texelH = 1 / texH;

    // ── Phase 1: render + blur each floor below active, accumulate ────────────
    let accumCurrent = null; // starts null until first floor is written

    for (let f = 0; f < activeFloorIndex; f++) {
      const depth = activeFloorIndex - f; // how many floors below active

      // 1a. Render this floor's tiles to _scratchA.
      //     Floor 0 includes background planes (bg colour + bg image) so the
      //     composited output is never transparent in the ground layer.
      bus.renderFloorRangeTo(
        renderer, camera, f, f, this._scratchA,
        { includeBackground: f === 0, clearAlpha: f === 0 ? 1 : 0 },
      );

      // 1b. Kawase blur _scratchA proportional to depth.
      const iters = Math.min(maxIters, depth * itersPerDepth);
      const depthRadiusPx = blurRadiusPx * depth * zoomScale;
      this._applyKawaseBlur(renderer, texelW, texelH, depthRadiusPx, iters);
      // After _applyKawaseBlur the result is always in _scratchA.

      // 1c. Accumulate: composite _scratchA (fg) over current accumulation.
      if (accumCurrent === null) {
        // First floor: just blit directly into _accumA.
        this._blit(renderer, this._scratchA.texture, this._accumA);
        accumCurrent = this._accumA;
      } else {
        // Subsequent floors: composite over the current accumulation.
        const accumNext = (accumCurrent === this._accumA) ? this._accumB : this._accumA;
        this._compositeOver(renderer, accumCurrent.texture, this._scratchA.texture, accumNext);
        accumCurrent = accumNext;
      }
    }

    // ── Phase 2: write blurred below-floor accumulation into outputRT ─────────
    if (accumCurrent !== null) {
      this._blit(renderer, accumCurrent.texture, outputRT);
    } else {
      // Safety fallback (activeFloorIndex > 0 should imply at least floor 0 exists).
      bus.renderTo(renderer, camera, outputRT);
      return;
    }

    // ── Phase 3: render active floor + above directly over outputRT ───────────
    // This avoids any additional shader alpha math on the active floor path and
    // guarantees the visible floor itself is not blurred by this effect.
    bus.renderFloorRangeTo(
      renderer, camera, activeFloorIndex, Infinity, outputRT,
      { includeBackground: false, clearBeforeRender: false, clearAlpha: 0 },
    );
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Resolve an effect zoom scalar for screen-space blur stability.
   *
   * Orthographic camera: use camera.zoom directly.
   * Perspective camera: prefer sceneComposer.currentZoom (FOV-driven), with a
   * fallback derived from baseFovTanHalf/current camera FOV.
   *
   * @param {import('three').Camera|null|undefined} camera
   * @returns {number}
   */
  _getEffectiveZoom(camera) {
    const sceneComposer = window.MapShine?.sceneComposer;

    if (!camera) return 1.0;

    if (camera.isOrthographicCamera) {
      const z = Number(camera.zoom);
      return Number.isFinite(z) && z > 0 ? z : 1.0;
    }

    // Perspective path: prefer compositor zoom (authoritative in this project).
    const compositorZoom = Number(sceneComposer?.currentZoom);
    if (Number.isFinite(compositorZoom) && compositorZoom > 0) {
      return compositorZoom;
    }

    if (camera.isPerspectiveCamera) {
      try {
        const camFovRad = (Number(camera.fov) || 60) * (Math.PI / 180);
        const camTanHalf = Math.tan(camFovRad * 0.5);
        const baseTanHalf = Number(sceneComposer?.baseFovTanHalf);
        if (Number.isFinite(baseTanHalf) && baseTanHalf > 1e-6 && Number.isFinite(camTanHalf) && camTanHalf > 1e-6) {
          return baseTanHalf / camTanHalf;
        }
      } catch (_) {}
    }

    return 1.0;
  }

  /**
   * Apply N Kawase passes ping-ponging between _scratchA and _scratchB.
   * After this call, the blurred result is in _scratchA.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {number} texelW
   * @param {number} texelH
   * @param {number} totalRadiusPx - Total spread radius in screen pixels
   * @param {number} iterations - Number of blur passes (each = 1 fullscreen draw)
   */
  _applyKawaseBlur(renderer, texelW, texelH, totalRadiusPx, iterations) {
    if (iterations <= 0 || totalRadiusPx <= 0) return;

    // Distribute the total radius across iterations using Kawase's i+0.5 spacing
    // pattern, scaled so the cumulative spread hits totalRadiusPx.
    // Kawase offset at pass i = scale * (i + 0.5), where scale is chosen so
    // the sum of all offsets ≈ totalRadiusPx.
    const sumBase = iterations * (iterations - 1) / 2 + iterations * 0.5; // sum of (i+0.5) for i=0..N-1
    const scale = totalRadiusPx / Math.max(sumBase, 0.5);

    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    // Ping-pong: A→B on odd passes, B→A on even passes.
    // Start: input in _scratchA. End: result in _scratchA (even total = 2→A, 4→A, etc.)
    // Odd iteration count: result ends in _scratchB; do one more blit back to _scratchA.
    let src = this._scratchA;
    let dst = this._scratchB;

    this._quadMesh.material = this._kawaseMat;
    renderer.autoClear = true;

    for (let i = 0; i < iterations; i++) {
      const offset = scale * (i + 0.5);
      this._kawaseMat.uniforms.tDiffuse.value = src.texture;
      this._kawaseMat.uniforms.uOffset.value.set(offset * texelW, offset * texelH);
      renderer.setRenderTarget(dst);
      renderer.render(this._quadScene, this._quadCamera);
      // Swap
      const tmp = src; src = dst; dst = tmp;
    }

    // After the loop, `src` holds the result (because we swap at the end of each pass).
    // If src !== _scratchA, blit it back so the caller can always expect result in _scratchA.
    if (src !== this._scratchA) {
      this._blit(renderer, src.texture, this._scratchA);
      // (renderer state already clean after _blit)
    } else {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }

    // Always restore after last operation.
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * Composite `fg` over `bg` (Porter-Duff over), write to `outputRT`.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Texture} bgTex
   * @param {import('three').Texture} fgTex
   * @param {import('three').WebGLRenderTarget} outputRT
   */
  _compositeOver(renderer, bgTex, fgTex, outputRT) {
    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    this._compositeMat.uniforms.tBg.value = bgTex;
    this._compositeMat.uniforms.tFg.value = fgTex;
    this._quadMesh.material = this._compositeMat;
    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._quadScene, this._quadCamera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * Simple blit: copy `srcTex` into `outputRT`.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Texture} srcTex
   * @param {import('three').WebGLRenderTarget} outputRT
   */
  _blit(renderer, srcTex, outputRT) {
    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    this._blitMat.uniforms.tDiffuse.value = srcTex;
    this._quadMesh.material = this._blitMat;
    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._quadScene, this._quadCamera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }
}
