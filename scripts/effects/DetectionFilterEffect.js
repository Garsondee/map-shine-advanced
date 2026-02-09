/**
 * @fileoverview Renders visual indicators on tokens detected via special detection modes.
 *
 * Foundry applies PIXI filters (GlowOverlayFilter, OutlineOverlayFilter) to tokens
 * detected through special senses like tremorsense or see-invisibility. Since we
 * render tokens as Three.js sprites, we replicate these effects using child meshes:
 *
 * - **Glow** (seeInvisibility, senseInvisibility): A scaled-up, blurred copy of the
 *   token sprite rendered behind it with additive blending and the detection color.
 * - **Outline** (seeAll, senseAll, feelTremor): A slightly scaled-up solid-color
 *   silhouette rendered behind the token.
 *
 * The VisibilityController supplies per-token detection state each frame. This effect
 * reads that state and creates/updates/removes indicator child sprites accordingly.
 *
 * @module effects/DetectionFilterEffect
 */

import { createLogger } from '../core/log.js';
import { OVERLAY_THREE_LAYER } from './EffectComposer.js';

const log = createLogger('DetectionFilter');

/**
 * Detection filter color presets matching Foundry's defaults.
 * Colors are THREE.Color-compatible hex values.
 */
const FILTER_PRESETS = {
  // GlowOverlayFilter used by seeInvisibility / senseInvisibility
  glow: {
    color: 0x009955, // Green glow [0, 0.60, 0.33]
    scale: 1.15,     // How much larger than the token
    opacity: 0.6,
    blending: 'additive'
  },
  // OutlineOverlayFilter used by seeAll / senseAll
  outline: {
    color: 0xff0000, // Red outline
    scale: 1.06,
    opacity: 0.85,
    blending: 'normal'
  },
  // Fallback for unrecognized filter types
  unknown: {
    color: 0xffaa00, // Orange
    scale: 1.08,
    opacity: 0.7,
    blending: 'normal'
  }
};

export class DetectionFilterEffect {
  /**
   * @param {import('../scene/token-manager.js').TokenManager} tokenManager
   * @param {import('../vision/VisibilityController.js').VisibilityController} visibilityController
   */
  constructor(tokenManager, visibilityController) {
    this.tokenManager = tokenManager;
    this.visibilityController = visibilityController;

    /**
     * Tracks which tokens currently have an active indicator sprite.
     * @type {Map<string, THREE.Sprite>}
     */
    this._indicators = new Map();

    /** Shared materials per filter type (reused across tokens) */
    this._materials = new Map();

    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;
    this._initialized = true;
    log.info('DetectionFilterEffect initialized');
  }

  /**
   * Called every frame by EffectComposer (via addUpdatable).
   * Syncs indicator sprites with the current detection state.
   *
   * NOTE: Currently disabled — the solid-color rectangle indicators are not
   * visually correct (shows as colored squares instead of proper glow/outline
   * effects). This needs proper shader work (radial blur for glow, edge
   * detection for outline) before it can be enabled. The VisibilityController
   * still tracks detection filter state so this can be wired up later.
   */
  update() {
    // TODO: Re-enable once proper glow/outline shaders are implemented.
    // The infrastructure (VisibilityController.detectionState) is ready.
    return;
  }

  /**
   * Create a detection indicator child sprite.
   * The indicator is a slightly larger copy of the parent sprite rendered behind it
   * with a solid detection color.
   *
   * @param {THREE.Sprite} parentSprite - The token sprite to attach to
   * @param {string} filterType - 'glow', 'outline', or 'unknown'
   * @returns {THREE.Sprite|null}
   * @private
   */
  _createIndicator(parentSprite, filterType) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const preset = FILTER_PRESETS[filterType] || FILTER_PRESETS.unknown;
    const material = this._getMaterial(filterType);

    const indicator = new THREE.Sprite(material);
    indicator.name = 'DetectionIndicator';
    indicator.matrixAutoUpdate = false;

    // Render in overlay layer so it's above fog but below HUD
    indicator.layers.set(OVERLAY_THREE_LAYER);

    // Scale slightly larger than parent to create outline/glow effect.
    // Parent sprite has scale (1,1,1) in its local space (parent scale is pixel size).
    // Child inherits parent scale, so we just need the ratio.
    indicator.scale.set(preset.scale, preset.scale, 1);

    // Position slightly behind the token (negative Z in parent space)
    indicator.position.set(0, 0, -0.001);
    indicator.updateMatrix();

    // Store metadata
    indicator.userData._filterType = filterType;
    indicator.userData._isDetectionIndicator = true;

    parentSprite.add(indicator);
    return indicator;
  }

  /**
   * Get or create a shared material for a filter type.
   * @param {string} filterType
   * @returns {THREE.SpriteMaterial}
   * @private
   */
  _getMaterial(filterType) {
    if (this._materials.has(filterType)) {
      return this._materials.get(filterType);
    }

    const THREE = window.THREE;
    const preset = FILTER_PRESETS[filterType] || FILTER_PRESETS.unknown;

    const material = new THREE.SpriteMaterial({
      color: preset.color,
      transparent: true,
      opacity: preset.opacity,
      depthTest: false,
      depthWrite: false,
      blending: preset.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      // No map texture — renders as a solid color rectangle matching the token shape.
      // This creates a colored silhouette behind the token.
    });

    this._materials.set(filterType, material);
    return material;
  }

  /**
   * Remove an indicator sprite from its parent and clean up.
   * @param {string} tokenId
   * @param {THREE.Sprite} indicator
   * @private
   */
  _removeIndicator(tokenId, indicator) {
    if (indicator.parent) {
      indicator.parent.remove(indicator);
    }
    // Don't dispose shared material — it's reused
    indicator.geometry?.dispose();
    this._indicators.delete(tokenId);
  }

  /**
   * Dispose all resources.
   */
  dispose() {
    for (const [tokenId, indicator] of this._indicators) {
      if (indicator.parent) indicator.parent.remove(indicator);
      indicator.geometry?.dispose();
    }
    this._indicators.clear();

    for (const mat of this._materials.values()) {
      mat.dispose();
    }
    this._materials.clear();

    this._initialized = false;
    log.info('DetectionFilterEffect disposed');
  }
}
