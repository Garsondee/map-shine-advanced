/**
 * @fileoverview Module-wide Depth Pass Manager
 * Renders a dedicated depth pass from the main scene and publishes
 * the resulting depth texture for consumption by effects (specular
 * occlusion, fog depth fade, contact shadows, etc.).
 *
 * Architecture:
 *  - Owns a WebGLRenderTarget with an attached DepthTexture.
 *  - Renders the scene each frame (or on invalidation) using the same
 *    camera the EffectComposer uses, capturing device depth.
 *  - Publishes the depth texture to MaskManager so any effect can
 *    discover it via the standard mask registry.
 *  - Provides a debug visualization quad that can be toggled from the
 *    Tweakpane Developer Tools panel.
 *
 * Coordinate notes (see windsurf rule "coordinates.md"):
 *  - Camera at Z=2000, ground at Z=1000 (GROUND_Z).
 *  - near=1, far=5000 on the PerspectiveCamera.
 *  - Device depth is non-linear (perspective); linear depth is derived
 *    in the debug visualizer shader via cameraNear/cameraFar uniforms.
 *
 * @module scene/depth-pass-manager
 */

import { createLogger } from '../core/log.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';

const log = createLogger('DepthPass');

// ─── Debug Visualizer Shaders ────────────────────────────────────────────────

const DEPTH_VIS_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const DEPTH_VIS_FRAGMENT = /* glsl */ `
uniform sampler2D uDepthTexture;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uGroundDistance; // Eye-space distance from camera to ground plane
uniform int uDisplayMode;
// 0 = layer view  (±6 world units — all 4 layers clearly distinct)
// 1 = sort zoom   (±1.0 world unit centered on FG — shows sort-key differences)
// 2 = raw device  (0-1 device depth — direct buffer inspection)

varying vec2 vUv;

// Convert perspective device depth [0,1] → linear eye-space depth.
// Must use the same near/far as the depth pass camera (tight bounds).
float linearizeDepth(float d) {
  float z_ndc = d * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) /
         (uCameraFar + uCameraNear - z_ndc * (uCameraFar - uCameraNear));
}

void main() {
  float deviceDepth = texture2D(uDepthTexture, vUv).r;

  // Background (nothing rendered) — magenta
  if (deviceDepth >= 0.9999) {
    gl_FragColor = vec4(0.3, 0.0, 0.3, 1.0);
    return;
  }

  // Mode 2: raw device depth — no linearization, direct buffer view
  if (uDisplayMode == 2) {
    gl_FragColor = vec4(vec3(deviceDepth), 1.0);
    return;
  }

  float linDepth = linearizeDepth(deviceDepth);
  float deltaFromGround = linDepth - uGroundDistance;

  if (uDisplayMode == 1) {
    // Sort zoom: ±1.0 world unit centered on FG layer (delta = -2.0).
    // FG tiles are at groundZ+2.0, so distance = groundDist - 2.0.
    // Delta from ground = -2.0. Sort 0 → -2.0, sort 999 → -2.999.
    // This mode makes sort-key differences within FG layer clearly visible.
    float fgCenter = -2.0;
    float halfRange = 1.0;
    float t = clamp((deltaFromGround - fgCenter + halfRange) / (2.0 * halfRange), 0.0, 1.0);
    gl_FragColor = vec4(vec3(t), 1.0);
    return;
  }

  // Mode 0: Layer view — ±6 world units around ground plane.
  // Tile Z layout (layers 1.0 apart, sort 0.001/step):
  //   ground → delta=0     → t=0.5  (neutral grey)
  //   BG     → delta=-1    → t=0.42 (blue tint)
  //   FG     → delta=-2    → t=0.33 (blue tint)
  //   TOKEN  → delta=-3    → t=0.25 (cyan tint)
  //   OVERHEAD → delta=-4  → t=0.17 (cyan tint)
  // Each layer is a clearly distinct shade/color.
  float halfRange = 6.0;
  float t = clamp((deltaFromGround + halfRange) / (2.0 * halfRange), 0.0, 1.0);

  vec3 color;
  if (t < 0.2) {
    // Overhead/token band — cyan tint
    color = vec3(t * 0.5, t, t);
  } else if (t < 0.45) {
    // FG/BG tile band — blue tint
    color = vec3(t * 0.7, t * 0.7, t);
  } else if (t > 0.55) {
    // Below ground — warm tint
    color = vec3(t, t * 0.8, t * 0.6);
  } else {
    // Ground plane — neutral grey
    color = vec3(t);
  }
  gl_FragColor = vec4(color, 1.0);
}
`;

// ─── Depth Pass Manager ──────────────────────────────────────────────────────

/**
 * Centralized depth pass that captures scene depth each frame and
 * publishes the texture for downstream effects.
 */
export class DepthPassManager {
  constructor() {
    /** @type {THREE.WebGLRenderTarget|null} */
    this._depthTarget = null;

    /** @type {THREE.DepthTexture|null} */
    this._depthTexture = null;

    /** @type {THREE.WebGLRenderer|null} */
    this._renderer = null;

    /** @type {THREE.Scene|null} */
    this._scene = null;

    /** @type {THREE.PerspectiveCamera|null} */
    this._camera = null;

    /** @type {THREE.PerspectiveCamera|null} Cloned camera with tight near/far */
    this._depthCamera = null;

    /** @type {number} Depth pass near plane (tight bounds around content) */
    this._depthNear = 1;

    /** @type {number} Depth pass far plane (tight bounds around content) */
    this._depthFar = 5000;

    /** @type {boolean} Whether the depth pass is enabled */
    this._enabled = true;

    /** @type {boolean} Whether the depth needs re-rendering this frame */
    this._dirty = true;

    /**
     * Continuous mode — re-render every frame regardless of dirty state.
     * Defaults to false (on-demand). The depth pass self-invalidates on camera
     * movement and can be manually invalidated via invalidate().
     * Use setContinuous(true) to force every-frame rendering for debugging.
     * @type {boolean}
     */
    this._continuous = false;

    /**
     * Max depth-pass render rate (Hz). Even when continuously dirty (e.g. during
     * camera pan), cap to this rate to avoid GPU pressure from redundant passes.
     * @type {number}
     */
    this._maxHz = 30;

    /** @type {number} Timestamp of last depth render (ms) */
    this._lastRenderTimeMs = 0;

    // Camera change detection — stored as flat values to avoid per-frame object allocation
    /** @private */ this._prevCamX = NaN;
    /** @private */ this._prevCamY = NaN;
    /** @private */ this._prevCamZ = NaN;
    /** @private */ this._prevCamQx = NaN;
    /** @private */ this._prevCamQy = NaN;
    /** @private */ this._prevCamQz = NaN;
    /** @private */ this._prevCamQw = NaN;
    /** @private */ this._prevCamFov = NaN;

    // ── Debug visualization ──────────────────────────────────────────────
    /** @type {boolean} */
    this._debugEnabled = false;

    /** @type {THREE.Mesh|null} Full-screen debug quad */
    this._debugQuad = null;

    /** @type {THREE.ShaderMaterial|null} */
    this._debugMaterial = null;

    /** @type {THREE.Scene|null} Tiny scene containing only the debug quad */
    this._debugScene = null;

    /** @type {THREE.OrthographicCamera|null} */
    this._debugCamera = null;

    /** @type {number} 0 = raw device depth, 1 = linearized */
    this._debugDisplayMode = 0;

    /** @type {number} Width of current render target */
    this._width = 0;

    /** @type {number} Height of current render target */
    this._height = 0;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {MaskManager|null} */
    this._maskManager = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Initialize the depth pass with references to the shared renderer, scene, and camera.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   */
  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE || !renderer || !scene || !camera) {
      log.warn('DepthPassManager.initialize: missing dependencies');
      return;
    }

    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;

    // Determine initial size from the renderer's drawing buffer
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this._width = Math.max(1, Math.floor(size.width || size.x || 1));
    this._height = Math.max(1, Math.floor(size.height || size.y || 1));

    this._createDepthTarget();
    this._createDebugVisualization();
    this._createDepthCamera();

    this._initialized = true;
    this._dirty = true;

    log.info(`DepthPassManager initialized (${this._width}x${this._height})`);
  }

  /**
   * Wire the MaskManager so depth textures are published for effect discovery.
   * @param {MaskManager} maskManager
   */
  setMaskManager(maskManager) {
    this._maskManager = maskManager;
    // Publish immediately if we already have a depth texture
    if (this._depthTexture) {
      this._publishToMaskManager();
    }
  }

  // ── Depth Camera ─────────────────────────────────────────────────────────

  /**
   * Create a cloned camera with tight near/far bounds for the depth pass.
   * The main camera (near=1, far=5000) maps 0.01-unit tile Z differences
   * to <1 float32 ULP at distance 1000 — indistinguishable. By tightening
   * the depth range to ±200 units around the ground plane, we get ~400 ULPs
   * of separation per 0.01 units, which is more than enough.
   * @private
   */
  _createDepthCamera() {
    const THREE = window.THREE;
    if (!THREE || !this._camera) return;

    this._depthCamera = this._camera.clone();
    this._syncDepthCameraBounds();
  }

  /**
   * Sync the depth camera's near/far to current scene geometry.
   * @private
   */
  _syncDepthCameraBounds() {
    if (!this._depthCamera || !this._camera) return;

    const sc = window.MapShine?.sceneComposer;
    const groundDist = sc?.groundDistance ?? (this._camera.position.z - (sc?.groundZ ?? 0));
    const safeGround = Math.max(10, groundDist);

    // Tight bounds: ±200 units around ground. Covers all tile layers
    // (bg=+0.01, fg=+0.02, overhead=+0.08), tokens (~+0.06), and
    // provides headroom for elevated objects.
    this._depthNear = Math.max(1, safeGround - 200);
    this._depthFar = safeGround + 200;

    this._depthCamera.near = this._depthNear;
    this._depthCamera.far = this._depthFar;
    this._depthCamera.updateProjectionMatrix();
  }

  // ── Render Target ────────────────────────────────────────────────────────

  /** @private */
  _createDepthTarget() {
    const THREE = window.THREE;
    if (!THREE) return;

    // Clean up previous target if any
    this._disposeDepthTarget();

    // Create a DepthTexture — this is the actual texture that effects sample.
    // Use FloatType (DEPTH_COMPONENT32F) for maximum precision.
    // At Z=1000 with near=1/far=5000, tile layers differ by only 0.01-0.08
    // world units.  16-bit depth (~15 unit precision) and 24-bit (~0.06)
    // cannot resolve these; 32-bit float (~0.0001) can.
    this._depthTexture = new THREE.DepthTexture(
      this._width, this._height,
      THREE.FloatType  // DEPTH_COMPONENT32F — required for thin tile Z band
    );
    this._depthTexture.minFilter = THREE.NearestFilter;
    this._depthTexture.magFilter = THREE.NearestFilter;

    // RenderTarget that writes depth into the attached DepthTexture.
    // WebGL requires at least one color attachment on an FBO, so we keep
    // the default RGBA color buffer (it's never read).
    this._depthTarget = new THREE.WebGLRenderTarget(this._width, this._height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this._depthTarget.depthTexture = this._depthTexture;

    log.debug(`Depth target created: ${this._width}x${this._height}`);
  }

  /** @private */
  _disposeDepthTarget() {
    if (this._depthTarget) {
      this._depthTarget.dispose();
      this._depthTarget = null;
    }
    if (this._depthTexture) {
      this._depthTexture.dispose();
      this._depthTexture = null;
    }
  }

  // ── Debug Visualization ──────────────────────────────────────────────────

  /** @private */
  _createDebugVisualization() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._debugMaterial = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VIS_VERTEX,
      fragmentShader: DEPTH_VIS_FRAGMENT,
      uniforms: {
        uDepthTexture: { value: null },
        uCameraNear: { value: 1.0 },
        uCameraFar: { value: 5000.0 },
        uGroundDistance: { value: 1000.0 },
        uDisplayMode: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });

    // Full-screen triangle (more efficient than a quad but a quad is fine here)
    const geom = new THREE.PlaneGeometry(2, 2);
    this._debugQuad = new THREE.Mesh(geom, this._debugMaterial);
    this._debugQuad.frustumCulled = false;

    this._debugScene = new THREE.Scene();
    this._debugScene.add(this._debugQuad);

    this._debugCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  // ── Per-frame Update (called by EffectComposer as an updatable) ─────────

  /**
   * Called every frame by EffectComposer.
   * Renders the depth pass if dirty, camera moved, or in continuous mode.
   * Rate-capped to _maxHz to avoid redundant GPU work.
   * @param {Object} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._enabled) return;

    // Self-invalidate on camera movement (position, rotation, or FOV change)
    this._detectCameraChange();

    const shouldRender = this._continuous || this._dirty;
    if (!shouldRender) return;

    // Rate-cap: skip if we rendered too recently
    if (this._maxHz > 0 && !this._continuous) {
      const now = performance.now();
      const minIntervalMs = 1000 / this._maxHz;
      if ((now - this._lastRenderTimeMs) < minIntervalMs) return;
      this._lastRenderTimeMs = now;
    }

    this._renderDepthPass();
    this._dirty = false;
  }

  /**
   * Compare current camera state to previous frame and set _dirty if changed.
   * Uses flat scalar comparisons to avoid any per-frame allocations.
   * @private
   */
  _detectCameraChange() {
    const cam = this._camera;
    if (!cam) return;

    const p = cam.position;
    const q = cam.quaternion;
    const fov = cam.fov;

    if (
      p.x !== this._prevCamX || p.y !== this._prevCamY || p.z !== this._prevCamZ ||
      q.x !== this._prevCamQx || q.y !== this._prevCamQy ||
      q.z !== this._prevCamQz || q.w !== this._prevCamQw ||
      fov !== this._prevCamFov
    ) {
      this._dirty = true;
      this._prevCamX = p.x; this._prevCamY = p.y; this._prevCamZ = p.z;
      this._prevCamQx = q.x; this._prevCamQy = q.y;
      this._prevCamQz = q.z; this._prevCamQw = q.w;
      this._prevCamFov = fov;
    }
  }

  /** @private */
  _renderDepthPass() {
    const renderer = this._renderer;
    const scene = this._scene;
    const mainCamera = this._camera;
    const depthCamera = this._depthCamera;
    if (!renderer || !scene || !mainCamera || !depthCamera || !this._depthTarget) return;

    // Ensure size matches the current drawing buffer
    const THREE = window.THREE;
    if (THREE) {
      const size = renderer.getDrawingBufferSize(this._sizeVec || (this._sizeVec = new THREE.Vector2()));
      const w = Math.max(1, Math.floor(size.width || size.x || 1));
      const h = Math.max(1, Math.floor(size.height || size.y || 1));
      if (w !== this._width || h !== this._height) {
        this._width = w;
        this._height = h;
        this._depthTarget.setSize(w, h);
        log.debug(`Depth target resized: ${w}x${h}`);
      }
    }

    // Sync the depth camera to the main camera's transform + FOV each frame,
    // but keep the tight near/far bounds for depth precision.
    depthCamera.position.copy(mainCamera.position);
    depthCamera.quaternion.copy(mainCamera.quaternion);
    depthCamera.fov = mainCamera.fov;
    depthCamera.aspect = mainCamera.aspect;
    depthCamera.layers.mask = mainCamera.layers.mask;
    this._syncDepthCameraBounds(); // recompute near/far + updateProjectionMatrix

    // Save renderer state
    const prevRenderTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    // Render the scene into our depth target using the tight-bounds camera.
    // Exclude overlay-only objects (layer 31) — same exclusion as the main scene render.
    try {
      depthCamera.layers.disable(OVERLAY_THREE_LAYER);
      renderer.setRenderTarget(this._depthTarget);
      renderer.autoClear = true;
      renderer.clear(true, true, false);
      renderer.render(scene, depthCamera);
    } finally {
      renderer.setRenderTarget(prevRenderTarget);
      renderer.autoClear = prevAutoClear;
    }

    // Update debug material uniforms — use depth pass near/far
    if (this._debugMaterial) {
      this._debugMaterial.uniforms.uDepthTexture.value = this._depthTexture;
      this._debugMaterial.uniforms.uCameraNear.value = this._depthNear;
      this._debugMaterial.uniforms.uCameraFar.value = this._depthFar;
      this._debugMaterial.uniforms.uDisplayMode.value = this._debugDisplayMode;

      const sc = window.MapShine?.sceneComposer;
      const groundDist = sc?.groundDistance ?? (mainCamera.position.z - (sc?.groundZ ?? 0));
      this._debugMaterial.uniforms.uGroundDistance.value = Math.max(1, groundDist);
    }
  }

  /**
   * Render the debug depth visualization to screen.
   * Called from EffectComposer's render loop when debug is active.
   */
  renderDebugOverlay() {
    if (!this._debugEnabled || !this._renderer || !this._debugScene || !this._debugCamera) return;
    if (!this._debugMaterial?.uniforms?.uDepthTexture?.value) return;

    const renderer = this._renderer;
    const prevRenderTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      // Render to screen, disabling autoClear so we don't wipe the scene
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.render(this._debugScene, this._debugCamera);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevRenderTarget);
    }
  }

  // ── MaskManager Publication ──────────────────────────────────────────────

  /** @private */
  _publishToMaskManager() {
    if (!this._maskManager || !this._depthTexture) return;
    try {
      this._maskManager.setTexture('depth.device', this._depthTexture, {
        space: 'screenUv',
        source: 'depthPass',
        lifecycle: 'perFrame',
        colorSpace: '',
        uvFlipY: false,
      });
    } catch (e) {
      log.warn('Failed to publish depth texture to MaskManager:', e);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Get the raw device depth texture for sampling in shaders.
   * @returns {THREE.DepthTexture|null}
   */
  getDepthTexture() {
    return this._depthTexture;
  }

  /**
   * Get the near plane used for the depth pass projection.
   * Effects must linearize stored depth values with these bounds,
   * NOT the main camera's near/far.
   * @returns {number}
   */
  getDepthNear() {
    return this._depthNear;
  }

  /**
   * Get the far plane used for the depth pass projection.
   * @returns {number}
   */
  getDepthFar() {
    return this._depthFar;
  }

  /**
   * Get the full render target (for advanced use cases needing the FBO).
   * @returns {THREE.WebGLRenderTarget|null}
   */
  getDepthTarget() {
    return this._depthTarget;
  }

  /** Mark the depth pass as needing a re-render next frame. */
  invalidate() {
    this._dirty = true;
  }

  /** @param {boolean} enabled */
  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (!this._enabled) {
      this._dirty = false;
    }
  }

  /** @returns {boolean} */
  isEnabled() {
    return this._enabled;
  }

  /** @param {boolean} continuous */
  setContinuous(continuous) {
    this._continuous = !!continuous;
  }

  /** @returns {boolean} */
  isContinuous() {
    return this._continuous;
  }

  // ── Debug API ────────────────────────────────────────────────────────────

  /** @param {boolean} enabled */
  setDebugEnabled(enabled) {
    this._debugEnabled = !!enabled;
  }

  /** @returns {boolean} */
  isDebugEnabled() {
    return this._debugEnabled;
  }

  /**
   * @param {number} mode 0 = tile detail (±0.15u), 1 = full range (±200u), 2 = raw device depth
   */
  setDebugDisplayMode(mode) {
    const m = Number(mode);
    this._debugDisplayMode = (m === 1 || m === 2) ? m : 0;
  }

  /** @returns {number} */
  getDebugDisplayMode() {
    return this._debugDisplayMode;
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  /**
   * Called when the viewport resizes.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this._width && h === this._height) return;

    this._width = w;
    this._height = h;

    if (this._depthTarget) {
      this._depthTarget.setSize(w, h);
    }
    this._dirty = true;
    log.debug(`DepthPassManager resized: ${w}x${h}`);
  }

  // ── Dispose ──────────────────────────────────────────────────────────────

  dispose() {
    this._disposeDepthTarget();

    if (this._debugMaterial) {
      this._debugMaterial.dispose();
      this._debugMaterial = null;
    }
    if (this._debugQuad?.geometry) {
      this._debugQuad.geometry.dispose();
    }
    this._debugQuad = null;
    this._debugScene = null;
    this._debugCamera = null;

    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._depthCamera = null;
    this._maskManager = null;
    this._initialized = false;

    log.info('DepthPassManager disposed');
  }
}
