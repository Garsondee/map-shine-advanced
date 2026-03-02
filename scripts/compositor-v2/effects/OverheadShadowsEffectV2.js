/**
 * @fileoverview OverheadShadowsEffectV2 — V2 overhead tile shadow pass.
 *
 * Renders soft, directional shadows cast by overhead tiles (tileDoc.overhead === true)
 * onto the scene below them.
 *
 * ## Algorithm
 * 1. **Roof capture pass** (per-frame, screen-space):
 *    Walk FloorRenderBus._tiles for overhead tiles at the active floor.
 *    Temporarily show only those tiles and render them alpha-only to a
 *    half-resolution RT (_roofAlphaRT). All non-overhead tiles are hidden.
 *
 * 2. **Shadow offset + blur pass**:
 *    A single shader samples _roofAlphaRT at an offset UV (driven by sun direction
 *    and shadow length) and writes a greyscale shadow factor (1.0=lit, 0.0=shadowed).
 *    A lightweight box blur is embedded in the same pass via multi-sample offset.
 *
 * 3. **Integration**:
 *    The resulting shadow factor texture is exposed via `get shadowFactorTexture()`.
 *    FloorCompositor feeds it into LightingEffectV2.render() as `overheadShadowTexture`,
 *    which applies it identically to the building shadow: dims ambient only,
 *    dynamic lights punch through.
 *
 * ## Key differences from V1 OverheadShadowsEffect
 * - V1 maintains a world-pinned mesh that re-projects the shadow back into screen space.
 *   V2 LightingEffectV2 already reconstructs world XY per-fragment (same as building
 *   shadows), so no display mesh is needed.
 * - V1 has many passes (roof alpha, fluid roof, tile projection, indoor shadow, etc.).
 *   V2 implements the core pass only (opacity + length + softness) — additional passes
 *   can be layered in later.
 * - Sun direction is received via setSunAngles() from SkyColorEffectV2 (single source
 *   of truth), matching the BuildingShadowsEffectV2 pattern.
 *
 * @module compositor-v2/effects/OverheadShadowsEffectV2
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('OverheadShadowsEffectV2');

// Shadow RT resolution. Half of typical viewport is sufficient — shadow edges
// are naturally soft so aliasing is not visible.
const SHADOW_RT_SIZE = 512;

export class OverheadShadowsEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    /** @type {import('../FloorRenderBus.js').FloorRenderBus} */
    this._renderBus = renderBus;

    /** @type {boolean} */
    this._initialized = false;

    // ── Sun direction ──────────────────────────────────────────────────
    /** @type {number} Azimuth in degrees from SkyColorEffectV2 */
    this._sunAzimuthDeg = 180;
    /** @type {number} Elevation in degrees */
    this._sunElevationDeg = 45;

    // ── GPU resources ─────────────────────────────────────────────────
    /** @type {THREE.WebGLRenderTarget|null} Overhead tile alpha (per-frame roof capture) */
    this._roofAlphaRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Shadow factor output (1.0=lit, 0.0=shadowed) */
    this._shadowRT = null;

    /** @type {THREE.Scene|null} Fullscreen quad scene for shadow pass */
    this._shadowScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._shadowCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._shadowMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._shadowQuad = null;

    /** @type {THREE.Vector2|null} Reusable size vec */
    this._sizeVec = null;

    this.params = {
      enabled: true,
      opacity: 0.4,
      length: 0.06,
      softness: 3.0,
      sunLatitude: 0.1,
    };

    log.debug('OverheadShadowsEffectV2 created');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize GPU resources.
   * @param {THREE.WebGLRenderer} renderer
   */
  initialize(renderer) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;

    this._renderer = renderer;
    this._sizeVec = new THREE.Vector2();

    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };

    // Roof capture RT: records overhead tile alpha in screen UV space this frame.
    this._roofAlphaRT = new THREE.WebGLRenderTarget(SHADOW_RT_SIZE, SHADOW_RT_SIZE, rtOpts);
    this._roofAlphaRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    // Shadow factor RT: output passed to LightingEffectV2. Cleared to white (fully lit)
    // so the scene is unaffected before the first render.
    this._shadowRT = new THREE.WebGLRenderTarget(SHADOW_RT_SIZE, SHADOW_RT_SIZE, rtOpts);
    renderer.setRenderTarget(this._shadowRT);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.setRenderTarget(null);

    // ── Shadow offset + blur pass ──────────────────────────────────────
    // Samples roofAlphaRT at `vUv + sunDir * length` then applies a lightweight
    // Gaussian-approximation box blur for soft penumbra.
    this._shadowScene = new THREE.Scene();
    this._shadowCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._shadowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tRoof:        { value: null },
        uSunDir:      { value: new THREE.Vector2(0, -1) },
        uLength:      { value: this.params.length },
        uOpacity:     { value: this.params.opacity },
        uSoftness:    { value: this.params.softness },
        // Texel size for blur kernel (1/SHADOW_RT_SIZE by default, updated on resize)
        uTexelSize:   { value: new THREE.Vector2(1 / SHADOW_RT_SIZE, 1 / SHADOW_RT_SIZE) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tRoof;
        uniform vec2      uSunDir;
        uniform float     uLength;
        uniform float     uOpacity;
        uniform float     uSoftness;
        uniform vec2      uTexelSize;
        varying vec2 vUv;

        // Sample roof alpha, blurred over a small kernel to soften the shadow edge.
        // This is a simple 5-tap approximation: centre + 4 neighbours scaled by
        // the softness radius. More samples = softer but more expensive.
        float sampleRoof(vec2 uv) {
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
          return texture2D(tRoof, uv).a;
        }

        float sampleRoofBlurred(vec2 uv) {
          float blur = uSoftness * 0.005; // Convert softness (1–5) to UV-space radius
          float a = sampleRoof(uv);
          a += sampleRoof(uv + vec2( blur, 0.0));
          a += sampleRoof(uv + vec2(-blur, 0.0));
          a += sampleRoof(uv + vec2(0.0,  blur));
          a += sampleRoof(uv + vec2(0.0, -blur));
          // Extra diagonal taps for wider penumbra without banding artefacts.
          float diag = blur * 0.707;
          a += sampleRoof(uv + vec2( diag,  diag));
          a += sampleRoof(uv + vec2(-diag,  diag));
          a += sampleRoof(uv + vec2( diag, -diag));
          a += sampleRoof(uv + vec2(-diag, -diag));
          return a / 9.0;
        }

        void main() {
          // The shadow falls OFFSET from the roof silhouette in the sun direction.
          // Sample roofAlphaRT at uv MINUS the offset so at ground level we read
          // the roof that is "above" us in the shadow direction.
          vec2 shadowUv = vUv - uSunDir * uLength;

          float roofAlpha = sampleRoofBlurred(shadowUv);

          // Only the shadow region outside the roof itself (avoid double-darkening
          // areas already under opaque roof). Also subtract the direct-roof alpha at
          // the current pixel so the shadow is purely the penumbra region.
          float selfRoof = sampleRoof(vUv);
          // Cast shadow = roofAlpha at offset position, attenuated by presence of
          // roof overhead (to avoid shadow appearing ON TOP of the roof tile).
          float castAlpha = roofAlpha * (1.0 - selfRoof);

          // Shadow factor: 1.0 = fully lit, 0.0 = fully shadowed.
          float shadowFactor = 1.0 - castAlpha * clamp(uOpacity, 0.0, 1.0);
          gl_FragColor = vec4(shadowFactor, shadowFactor, shadowFactor, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this._shadowMaterial.toneMapped = false;

    this._shadowQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._shadowMaterial
    );
    this._shadowQuad.frustumCulled = false;
    this._shadowScene.add(this._shadowQuad);

    this._initialized = true;
    log.info(`OverheadShadowsEffectV2 initialized (RT: ${SHADOW_RT_SIZE}×${SHADOW_RT_SIZE})`);
  }

  // ── Sun direction ─────────────────────────────────────────────────

  /**
   * Receive sun angles from SkyColorEffectV2 (single source of truth).
   * Called each frame by FloorCompositor before render().
   *
   * @param {number} azimuthDeg  - Sun azimuth in degrees (0 = North, 90 = East)
   * @param {number} elevationDeg - Sun elevation in degrees (0 = horizon, 90 = zenith)
   */
  setSunAngles(azimuthDeg, elevationDeg) {
    this._sunAzimuthDeg = azimuthDeg;
    this._sunElevationDeg = elevationDeg;

    if (!this._shadowMaterial) return;

    // Convert to UV-space shadow direction.
    // Azimuth: angle from North (0°) clockwise. In UV space (Y+ = up):
    //   azimuth 0 (North) → shadow falls South → UV dir = (0, -1)
    //   azimuth 90 (East) → shadow falls West → UV dir = (-1, 0)
    //   azimuth 180 (South) → shadow falls North → UV dir = (0, +1)
    //   azimuth 270 (West) → shadow falls East → UV dir = (+1, 0)
    const az = azimuthDeg * Math.PI / 180;
    // Sun is to the North at 0°; shadow falls South. Elevation dampens length.
    const elevScale = Math.max(0.1, Math.cos(elevationDeg * Math.PI / 180));
    // Add sunLatitude influence: tilts shadow slightly north-south.
    const latOffset = (this.params.sunLatitude ?? 0.1) * Math.sin(az);
    const dirX = -Math.sin(az) * elevScale;
    const dirY = Math.cos(az) * elevScale + latOffset;
    const len = Math.sqrt(dirX * dirX + dirY * dirY);
    const nx = len > 1e-4 ? dirX / len : 0;
    const ny = len > 1e-4 ? dirY / len : -1;

    this._shadowMaterial.uniforms.uSunDir.value.set(nx, ny);
  }

  // ── Per-frame render ──────────────────────────────────────────────

  /**
   * Capture overhead tile alpha and compute shadow factor.
   * Must be called AFTER the bus scene has been updated for this frame
   * (visibility set, floor applied) but BEFORE LightingEffectV2.render().
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera - Main perspective camera (for tile projection)
   * @param {number} maxFloorIndex - Active max floor index
   */
  render(renderer, camera, maxFloorIndex) {
    if (!this._initialized || !this.params.enabled) return;
    if (!this._roofAlphaRT || !this._shadowRT || !this._shadowMaterial) return;
    if (!this._renderBus?._tiles) return;

    const THREE = window.THREE;
    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevColor     = renderer.getClearColor(new THREE.Color());
    const prevAlpha     = renderer.getClearAlpha();
    const prevLayerMask = camera.layers.mask;

    // ── Pass 1: Render overhead tile alpha → _roofAlphaRT ────────────
    // Temporarily isolate overhead tiles at/above the active floor.
    const tiles = this._renderBus._tiles;
    const savedVisibility = new Map();
    const savedMaterials = new Map();

    for (const [key, entry] of tiles) {
      savedVisibility.set(key, entry.mesh.visible);

      // Background and effect overlay tiles are never roof silhouettes.
      if (key.startsWith('__')) {
        entry.mesh.visible = false;
        continue;
      }

      // Only render overhead tiles at the current floor (and above, since
      // upper-floor roofs cast shadows onto the floor below).
      const isOverhead = entry.mesh.renderOrder >= (entry.floorIndex * 10000 + 5000);
      const inRange = entry.floorIndex <= maxFloorIndex + 1; // include one floor above

      if (!isOverhead || !inRange || !entry.material?.map) {
        entry.mesh.visible = false;
        continue;
      }

      // Render with true alpha — captures transparent roof edges faithfully.
      entry.mesh.visible = true;
      savedMaterials.set(key, {
        color: entry.material.color ? entry.material.color.clone() : null,
        depthTest: entry.material.depthTest,
        depthWrite: entry.material.depthWrite,
      });
      if (entry.material.color) entry.material.color.set(1, 1, 1);
      entry.material.depthTest = false;
      entry.material.depthWrite = false;
      entry.material.needsUpdate = true;
    }

    camera.layers.enable(0);
    renderer.setRenderTarget(this._roofAlphaRT);
    renderer.setClearColor(0x000000, 0); // Transparent = no roof
    renderer.autoClear = true;
    renderer.render(this._renderBus._scene, camera);

    // Restore tile state.
    camera.layers.mask = prevLayerMask;
    for (const [key, wasVisible] of savedVisibility) {
      const entry = tiles.get(key);
      if (entry) entry.mesh.visible = wasVisible;
    }
    for (const [key, saved] of savedMaterials) {
      const entry = tiles.get(key);
      if (!entry) continue;
      if (saved.color && entry.material.color) entry.material.color.copy(saved.color);
      entry.material.depthTest = saved.depthTest;
      entry.material.depthWrite = saved.depthWrite;
      entry.material.needsUpdate = true;
    }

    // ── Pass 2: Shadow offset + blur → _shadowRT ──────────────────────
    this._shadowMaterial.uniforms.tRoof.value    = this._roofAlphaRT.texture;
    this._shadowMaterial.uniforms.uLength.value  = this.params.length;
    this._shadowMaterial.uniforms.uOpacity.value = this.params.opacity;
    this._shadowMaterial.uniforms.uSoftness.value = this.params.softness;

    renderer.setRenderTarget(this._shadowRT);
    renderer.setClearColor(0xffffff, 1); // White = fully lit default
    renderer.autoClear = true;
    renderer.render(this._shadowScene, this._shadowCamera);

    // Restore renderer state.
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.setRenderTarget(prevTarget);
  }

  // ── Output ────────────────────────────────────────────────────────

  /**
   * The shadow factor texture (1.0 = fully lit, 0.0 = fully shadowed).
   * Fed into LightingEffectV2.render() as the overhead shadow input.
   * @returns {THREE.Texture|null}
   */
  get shadowFactorTexture() {
    return this._shadowRT?.texture ?? null;
  }

  // ── Resize ────────────────────────────────────────────────────────

  /**
   * Resize internal RTs. Called by FloorCompositor.onResize().
   * The shadow RT stays at SHADOW_RT_SIZE (fixed resolution) but we
   * update uTexelSize if the blit scale changes.
   */
  onResize(_w, _h) {
    // Shadow RT is fixed-res; no RT resize needed.
    // texelSize stays correct as long as RT stays SHADOW_RT_SIZE × SHADOW_RT_SIZE.
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  dispose() {
    try { this._roofAlphaRT?.dispose(); } catch (_) {}
    try { this._shadowRT?.dispose(); } catch (_) {}
    try { this._shadowMaterial?.dispose(); } catch (_) {}
    try { this._shadowQuad?.geometry?.dispose(); } catch (_) {}

    this._roofAlphaRT = null;
    this._shadowRT = null;
    this._shadowScene = null;
    this._shadowCamera = null;
    this._shadowMaterial = null;
    this._shadowQuad = null;
    this._initialized = false;

    log.info('OverheadShadowsEffectV2 disposed');
  }
}
