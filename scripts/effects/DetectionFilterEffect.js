/**
 * @fileoverview Renders visual indicators on tokens detected via special detection modes.
 *
 * Foundry applies PIXI filters (GlowOverlayFilter, OutlineOverlayFilter) to tokens
 * detected through special senses like tremorsense or see-invisibility. Since we
 * render tokens as Three.js sprites, we replicate these effects using standalone
 * meshes with custom shaders:
 *
 * - **Glow** (seeInvisibility, senseInvisibility): An expanded, softened silhouette
 *   of the token rendered behind it with additive blending and the detection color.
 *   Uses multi-ring alpha sampling for a smooth radial falloff.
 *
 * - **Outline** (seeAll, senseAll, feelTremor): A thin edge-detected border around
 *   the token silhouette rendered with the detection color. Uses alpha discontinuity
 *   sampling for crisp edge detection.
 *
 * Indicators render on OVERLAY_THREE_LAYER with renderOrder 10000, placing them
 * above the fog plane (9999). This ensures tokens detected through special modes
 * (e.g. tremorsense through walls) remain visible even in fogged areas.
 *
 * The VisibilityController supplies per-token detection state each frame. This effect
 * reads that state and creates/updates/removes indicator meshes accordingly.
 *
 * @module effects/DetectionFilterEffect
 */

import { createLogger } from '../core/log.js';
import { OVERLAY_THREE_LAYER } from './EffectComposer.js';

const log = createLogger('DetectionFilter');

// ── Filter Presets ──────────────────────────────────────────────────────────
// Match Foundry's default detection filter colors and behaviors.

const FILTER_PRESETS = {
  // GlowOverlayFilter — seeInvisibility / senseInvisibility
  glow: {
    color: [0.0, 0.60, 0.33],
    glowSize: 0.07,
    opacity: 0.65,
    pulseSpeed: 2.5,
    pulseAmount: 0.2,
    additive: true,
    expansion: 1.2
  },
  // OutlineOverlayFilter — seeAll / senseAll / feelTremor
  outline: {
    color: [1.0, 0.0, 0.0],
    outlineWidth: 0.02,
    opacity: 0.9,
    pulseSpeed: 1.8,
    pulseAmount: 0.12,
    additive: false,
    expansion: 1.08
  },
  // Fallback for unrecognised filter types
  unknown: {
    color: [1.0, 0.67, 0.0],
    outlineWidth: 0.02,
    opacity: 0.8,
    pulseSpeed: 1.8,
    pulseAmount: 0.12,
    additive: false,
    expansion: 1.08
  }
};

// ── Shaders ─────────────────────────────────────────────────────────────────

const INDICATOR_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Combined glow / outline fragment shader.
 * uMode = 0 → glow (multi-ring alpha expansion with soft radial falloff).
 * uMode = 1 → outline (edge detection via alpha discontinuity).
 */
const INDICATOR_FRAGMENT = /* glsl */ `
  uniform sampler2D tMap;
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uPulseSpeed;
  uniform float uPulseAmount;
  uniform float uMode;         // 0 = glow, 1 = outline
  uniform float uGlowSize;    // UV-space glow expansion radius
  uniform float uOutlineWidth; // UV-space outline thickness

  varying vec2 vUv;

  void main() {
    float srcAlpha = texture2D(tMap, vUv).a;

    // Gentle pulse for visual feedback
    float pulse = 1.0 + sin(uTime * uPulseSpeed) * uPulseAmount;

    if (uMode < 0.5) {
      // ─── Glow ────────────────────────────────────────────────────────
      // Sample alpha at three concentric rings with decreasing weight
      // to create a smooth, soft halo around the token silhouette.
      float expanded = 0.0;
      float totalW   = 0.0;

      for (int ring = 1; ring <= 3; ring++) {
        float r = uGlowSize * (float(ring) / 3.0);
        float w = 1.0 - (float(ring) - 1.0) / 3.0;

        for (int i = 0; i < 12; i++) {
          float a = float(i) * 6.2832 / 12.0;
          vec2  o = vec2(cos(a), sin(a)) * r;
          expanded += texture2D(tMap, vUv + o).a * w;
          totalW   += w;
        }
      }
      expanded /= totalW;

      // Halo = expanded silhouette minus the original solid area
      float halo = clamp(expanded - srcAlpha * 0.8, 0.0, 1.0);
      halo = smoothstep(0.0, 0.5, halo);

      gl_FragColor = vec4(uColor * pulse, halo * uOpacity * pulse);

    } else {
      // ─── Outline ─────────────────────────────────────────────────────
      // Detect sharp alpha transitions by comparing min/max of neighbours.
      float mx = 0.0;
      float mn = 1.0;

      for (int i = 0; i < 16; i++) {
        float a  = float(i) * 6.2832 / 16.0;
        vec2  o  = vec2(cos(a), sin(a)) * uOutlineWidth;
        float na = texture2D(tMap, vUv + o).a;
        mx = max(mx, na);
        mn = min(mn, na);
      }

      // Edge exists where there's a sharp transition between opaque and transparent
      float edge = smoothstep(0.1, 0.5, mx - mn);

      // Restrict to the actual silhouette border (not interior or far exterior)
      float nearEdge = step(0.01, mx) * (1.0 - step(0.99, mn));
      float outline  = edge * nearEdge;

      gl_FragColor = vec4(uColor * pulse, outline * uOpacity * pulse);
    }
  }
`;

// ── Effect Class ────────────────────────────────────────────────────────────

export class DetectionFilterEffect {
  /**
   * @param {import('../scene/token-manager.js').TokenManager} tokenManager
   * @param {import('../vision/VisibilityController.js').VisibilityController} visibilityController
   */
  constructor(tokenManager, visibilityController) {
    this.tokenManager = tokenManager;
    this.visibilityController = visibilityController;

    /**
     * Active indicators keyed by tokenId.
     * @type {Map<string, {mesh: THREE.Mesh, filterType: string}>}
     */
    this._indicators = new Map();

    /** Shared unit-plane geometry (1×1, scaled per-token). */
    this._sharedGeometry = null;

    this._initialized = false;

    /** Elapsed time forwarded from TimeManager. */
    this._elapsed = 0;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;

    const THREE = window.THREE;
    if (!THREE) return;

    this._sharedGeometry = new THREE.PlaneGeometry(1, 1);
    this._initialized = true;
    log.info('DetectionFilterEffect initialized');
  }

  /**
   * Called every frame by EffectComposer (via addUpdatable).
   * Reads VisibilityController.detectionState and syncs indicator meshes.
   * @param {import('../core/time.js').TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized) return;
    if (!this.visibilityController?._initialized) return;
    if (!this.tokenManager?.tokenSprites) return;

    this._elapsed = timeInfo?.elapsed ?? 0;

    // Fast path: no detection filters active → clean up and bail
    if (!this.visibilityController.hasActiveDetectionFilters()) {
      if (this._indicators.size > 0) this._removeAllIndicators();
      return;
    }

    // Set of tokenIds that still need indicators this frame
    const activeIds = new Set();

    for (const [tokenId, state] of this.visibilityController.detectionState) {
      if (!state.visible || !state.detectionFilter) continue;

      const spriteData = this.tokenManager.tokenSprites.get(tokenId);
      const sprite = spriteData?.sprite;
      if (!sprite?.visible) continue;

      // The shader needs the token's texture for alpha-based edge/glow work
      const texture = sprite.material?.map;
      if (!texture) continue;

      activeIds.add(tokenId);

      const existing = this._indicators.get(tokenId);

      if (existing && existing.filterType === state.detectionFilter) {
        // Indicator already exists with the correct type — update it in place
        this._syncToToken(existing.mesh, sprite);
        const u = existing.mesh.material.uniforms;
        u.uTime.value = this._elapsed;
        if (u.tMap.value !== texture) u.tMap.value = texture;
      } else {
        // Wrong type or missing — (re)create
        if (existing) this._removeIndicator(tokenId);
        this._createIndicator(tokenId, sprite, texture, state.detectionFilter);
      }
    }

    // Tear down indicators for tokens that lost their detection filter.
    // Snapshot keys to avoid mutating the map during iteration.
    for (const tokenId of [...this._indicators.keys()]) {
      if (!activeIds.has(tokenId)) this._removeIndicator(tokenId);
    }
  }

  // ── Indicator CRUD ────────────────────────────────────────────────────────

  /**
   * Build a new indicator mesh for a detected token.
   * @param {string} tokenId
   * @param {THREE.Sprite} parentSprite - The token sprite to track
   * @param {THREE.Texture} texture     - The token's loaded texture
   * @param {string} filterType         - 'glow', 'outline', or 'unknown'
   * @private
   */
  _createIndicator(tokenId, parentSprite, texture, filterType) {
    const THREE = window.THREE;
    if (!THREE || !this._sharedGeometry) return;

    const preset = FILTER_PRESETS[filterType] || FILTER_PRESETS.unknown;
    const isGlow = (filterType === 'glow');

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tMap:          { value: texture },
        uColor:        { value: new THREE.Vector3(preset.color[0], preset.color[1], preset.color[2]) },
        uOpacity:      { value: preset.opacity },
        uTime:         { value: this._elapsed },
        uPulseSpeed:   { value: preset.pulseSpeed },
        uPulseAmount:  { value: preset.pulseAmount },
        uMode:         { value: isGlow ? 0.0 : 1.0 },
        uGlowSize:     { value: preset.glowSize ?? 0.07 },
        uOutlineWidth:  { value: preset.outlineWidth ?? 0.02 }
      },
      vertexShader: INDICATOR_VERTEX,
      fragmentShader: INDICATOR_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: preset.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(this._sharedGeometry, material);
    mesh.name = `DetectionFilter_${tokenId}`;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.userData._expansion = preset.expansion;

    // Render on the overlay layer ABOVE the fog plane
    mesh.layers.set(OVERLAY_THREE_LAYER);
    mesh.renderOrder = 10000;

    this._syncToToken(mesh, parentSprite);

    const scene = this.tokenManager.scene;
    if (scene) scene.add(mesh);

    this._indicators.set(tokenId, { mesh, filterType });
    log.debug(`Created ${filterType} indicator for token ${tokenId}`);
  }

  /**
   * Synchronise an indicator mesh's transform to match a token sprite.
   * @param {THREE.Mesh} mesh
   * @param {THREE.Sprite} sprite
   * @private
   */
  _syncToToken(mesh, sprite) {
    // Same world position, just behind the token (−0.01 Z)
    mesh.position.copy(sprite.position);
    mesh.position.z -= 0.01;

    // Expansion factor is cached on the mesh during creation
    const expansion = mesh.userData._expansion ?? 1.1;

    mesh.scale.set(
      sprite.scale.x * expansion,
      sprite.scale.y * expansion,
      1
    );

    // Match token rotation (SpriteMaterial.rotation → mesh rotation around Z)
    if (sprite.material?.rotation) {
      mesh.rotation.z = sprite.material.rotation;
    }

    mesh.updateMatrix();
  }

  /**
   * Remove and dispose a single indicator.
   * @param {string} tokenId
   * @private
   */
  _removeIndicator(tokenId) {
    const entry = this._indicators.get(tokenId);
    if (!entry) return;

    if (entry.mesh.parent) entry.mesh.parent.remove(entry.mesh);
    entry.mesh.material.dispose();
    this._indicators.delete(tokenId);
  }

  /**
   * Remove all active indicators.
   * @private
   */
  _removeAllIndicators() {
    for (const tokenId of [...this._indicators.keys()]) {
      this._removeIndicator(tokenId);
    }
  }

  // ── Disposal ──────────────────────────────────────────────────────────────

  dispose() {
    this._removeAllIndicators();

    if (this._sharedGeometry) {
      this._sharedGeometry.dispose();
      this._sharedGeometry = null;
    }

    this._initialized = false;
    log.info('DetectionFilterEffect disposed');
  }
}
