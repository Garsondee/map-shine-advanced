/**
 * @fileoverview Controls Three.js token visibility using a dual-path approach
 * for maximum robustness.
 *
 * ARCHITECTURE — Two redundant paths ensure correct visibility:
 *
 * PATH A — _refreshVisibility patch (per-token, immediate):
 *   Monkey-patches Token.prototype._refreshVisibility so we execute inside
 *   Foundry's render-flag pipeline at exactly the moment each token's
 *   isVisible is evaluated. Syncs the result to the Three.js sprite and
 *   forces the PIXI token to remain visible for hit-testing (Three.js
 *   handles the visual hiding; PIXI stays interactive at alpha=0).
 *
 * PATH B — sightRefresh hook (bulk, after vision computation):
 *   Listens to Foundry's "sightRefresh" hook which fires AFTER
 *   refreshVisibility() has drawn all vision polygons and
 *   restrictVisibility() has set render flags. At this point
 *   canvas.visibility.testVisibility() is fully functional, so we
 *   iterate ALL token sprites and call foundryToken.isVisible to
 *   sync them in bulk. This catches any tokens the patch missed.
 *
 * IMPORTANT — No other code should set sprite.visible on token sprites.
 * TokenManager.updateSpriteVisibility must return without modification
 * when the VC is active.
 *
 * @module vision/VisibilityController
 */

import { createLogger } from '../core/log.js';

const log = createLogger('VisibilityController');

export class VisibilityController {
  /**
   * @param {TokenManager} tokenManager - The TokenManager that owns the Three.js sprites
   */
  constructor(tokenManager) {
    /** @type {import('../scene/token-manager.js').TokenManager} */
    this.tokenManager = tokenManager;

    /**
     * Per-token detection state from the last visibility pass.
     * Maps tokenId → { visible: boolean, detectionFilter: string|null }
     * @type {Map<string, {visible: boolean, detectionFilter: string|null}>}
     */
    this.detectionState = new Map();

    /**
     * The original (unpatched) Token._refreshVisibility method.
     * Stored so we can restore it on dispose.
     * @type {Function|null}
     * @private
     */
    this._origRefreshVisibility = null;

    /**
     * Registered hook IDs for cleanup. Each entry is [hookName, hookId].
     * @type {Array<[string, number]>}
     * @private
     */
    this._hookIds = [];

    /**
     * Whether a deferred bulk refresh is already queued (prevents stacking).
     * @type {boolean}
     * @private
     */
    this._bulkRefreshQueued = false;

    this._initialized = false;
  }

  // ---------------------------------------------------------------------------
  //  Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Install the _refreshVisibility patch, register hooks, and perform
   * an initial bulk visibility sync.
   */
  initialize() {
    if (this._initialized) return;

    this._installPixiPatch();
    this._registerHooks();

    this._initialized = true;
    log.info('VisibilityController initialized (patch + sightRefresh hook)');

    // Queue an immediate bulk refresh so existing sprites (created before
    // the VC was initialised) get the correct visibility on the next frame.
    this._queueBulkRefresh();
  }

  /**
   * Restore the original _refreshVisibility, remove hooks, and clear state.
   */
  dispose() {
    // Restore original method
    if (this._origRefreshVisibility) {
      const TokenClass = CONFIG.Token?.objectClass ?? Token;
      TokenClass.prototype._refreshVisibility = this._origRefreshVisibility;
      this._origRefreshVisibility = null;
      log.debug('Restored original Token._refreshVisibility');
    }

    // Remove hooks
    for (const [name, id] of this._hookIds) {
      Hooks.off(name, id);
    }
    this._hookIds = [];

    this.detectionState.clear();
    this._initialized = false;
    log.info('VisibilityController disposed');
  }

  // ---------------------------------------------------------------------------
  //  PATH A — _refreshVisibility patch (per-token, inside render-flag cycle)
  // ---------------------------------------------------------------------------

  /**
   * Patch Token.prototype._refreshVisibility to intercept Foundry's
   * per-token visibility computation. This fires when the refreshVisibility
   * render flag is processed for each token.
   * @private
   */
  _installPixiPatch() {
    const TokenClass = CONFIG.Token?.objectClass ?? Token;
    this._origRefreshVisibility = TokenClass.prototype._refreshVisibility;

    const self = this;
    TokenClass.prototype._refreshVisibility = function _patchedRefreshVisibility() {
      // Step 1: Let Foundry compute visibility normally.
      // After this call: this.visible === this.isVisible, this.mesh.visible is set,
      // emulateMoveEvent fired if changed, occlusion refresh triggered if needed.
      self._origRefreshVisibility.call(this);

      // Step 2: Sync the computed result to the Three.js sprite.
      if (self._initialized) {
        const tokenId = this.document?.id;
        if (tokenId) {
          self._syncSingleToken(tokenId, this);
        }
      }

      // Step 3: Force the PIXI token to remain visible for hit-testing/interaction.
      // Three.js handles the visual hiding — PIXI tokens are transparent (alpha=0)
      // but must stay in the display tree for click/drag/HUD to work.
      this.visible = true;
      if (this.mesh) this.mesh.visible = false;
    };
  }

  // ---------------------------------------------------------------------------
  //  PATH B — Hook-based bulk refresh (after vision polygons are computed)
  // ---------------------------------------------------------------------------

  /**
   * Register Foundry hooks that trigger visibility refreshes.
   * @private
   */
  _registerHooks() {
    // sightRefresh fires AFTER:
    //   1. refreshVisibility() has drawn all vision polygons
    //   2. restrictVisibility() has set {refreshVisibility: true} on all tokens
    // At this point canvas.visibility.testVisibility() is fully functional.
    this._hookIds.push(['sightRefresh',
      Hooks.on('sightRefresh', () => this._refreshAllVisibility())
    ]);

    // visibilityRefresh fires after the vision container is refreshed
    // (draws vision shapes into the mask). Another good sync point.
    this._hookIds.push(['visibilityRefresh',
      Hooks.on('visibilityRefresh', () => this._queueBulkRefresh())
    ]);

    // controlToken fires when a token is selected/deselected. Vision
    // polygons are NOT yet updated at this point, so we defer the refresh
    // to after Foundry's perception pipeline catches up.
    this._hookIds.push(['controlToken',
      Hooks.on('controlToken', () => this._queueBulkRefresh())
    ]);

    // When the active level changes (floor navigation, controlled-token
    // elevation change, etc.), tokens on higher levels must be hidden.
    this._hookIds.push(['mapShineLevelContextChanged',
      Hooks.on('mapShineLevelContextChanged', () => this._queueBulkRefresh())
    ]);
  }

  /**
   * Queue a deferred bulk refresh on the next animation frame.
   * Multiple calls within the same frame are coalesced.
   * @private
   */
  _queueBulkRefresh() {
    if (this._bulkRefreshQueued) return;
    this._bulkRefreshQueued = true;
    requestAnimationFrame(() => {
      this._bulkRefreshQueued = false;
      if (this._initialized) this._refreshAllVisibility();
    });
  }

  // ---------------------------------------------------------------------------
  //  Level-based visibility filtering
  // ---------------------------------------------------------------------------

  /**
   * Check whether a token is above the current active level and should be
   * hidden. Tokens whose elevation exceeds the active level's top boundary
   * are considered "above" and are not rendered.
   *
   * @param {TokenDocument|object} tokenDoc - The token document (or object with .elevation)
   * @returns {boolean} True if the token is above the current level (should be hidden)
   * @private
   */
  _isTokenAboveCurrentLevel(tokenDoc) {
    try {
      const levelContext = window.MapShine?.activeLevelContext;
      // No active level context (single-level scene or levels not configured)
      // → don't filter, let normal Foundry visibility decide.
      if (!levelContext || !Number.isFinite(levelContext.top)) return false;

      // Only filter when there are multiple levels — single-level scenes
      // should never hide tokens via this path.
      if ((levelContext.count ?? 0) <= 1) return false;

      const tokenElev = Number(tokenDoc?.elevation ?? 0);
      if (!Number.isFinite(tokenElev)) return false;

      // Token is above if its elevation exceeds the active level's top.
      // Use a small epsilon to avoid floating-point edge cases at boundaries.
      // IMPORTANT: Shared-boundary semantics.
      // If level A is [0,10] and level B is [10,20], elevation=10 should be treated
      // as belonging to the UPPER level (B). So when viewing level A, tokens at
      // elevation==top should be hidden.
      return tokenElev >= levelContext.top - 0.01;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  //  Core visibility logic (shared by both paths)
  // ---------------------------------------------------------------------------

  /**
   * Sync a single token's Three.js sprite visibility to Foundry's isVisible.
   * Called from the _refreshVisibility patch (Path A).
   * @param {string} tokenId
   * @param {Token} foundryToken - The Foundry PIXI token object
   * @private
   */
  _syncSingleToken(tokenId, foundryToken) {
    const spriteData = this.tokenManager?.tokenSprites?.get(tokenId);
    if (!spriteData?.sprite) return;

    const sprite = spriteData.sprite;

    // After the original _refreshVisibility, this.visible holds the result
    // of this.isVisible (before we override it for PIXI interaction).
    let computedVisible = foundryToken.visible;

    // Level-based filtering: hide tokens that are above the current level.
    // This runs after Foundry's own visibility so we only further restrict.
    if (computedVisible && this._isTokenAboveCurrentLevel(foundryToken.document)) {
      computedVisible = false;
    }

    sprite.visible = computedVisible;
    if (computedVisible && sprite.material?.map) {
      // Only restore opacity if the texture has loaded. Without a map,
      // setting opacity > 0 would show a white rectangle.
      sprite.material.opacity = foundryToken.document?.hidden ? 0.5 : 1.0;
    }

    // Track detection state for Phase 3 glow/outline rendering.
    const detectionFilter = foundryToken.detectionFilter
      ? this._identifyDetectionFilter(foundryToken)
      : null;
    this.detectionState.set(tokenId, { visible: computedVisible, detectionFilter });
  }

  /**
   * Bulk refresh visibility for ALL token sprites by reading each Foundry
   * token's isVisible. Called from sightRefresh hook (Path B) and at init.
   *
   * At sightRefresh time, Foundry has:
   *  - Computed all vision polygons (refreshVisibility)
   *  - Initialised all vision/light sources
   *  - testVisibility() returns correct geometric results
   * So calling foundryToken.isVisible here is safe and accurate.
   * @private
   */
  _refreshAllVisibility() {
    if (!this.tokenManager?.tokenSprites) return;

    const placeables = canvas?.tokens?.placeables;
    if (!placeables) return;

    // Build lookup: tokenId → Foundry PIXI Token
    const placeableMap = new Map();
    for (const t of placeables) {
      if (t.document?.id) placeableMap.set(t.document.id, t);
    }

    const isGM = game?.user?.isGM ?? false;

    for (const [tokenId, spriteData] of this.tokenManager.tokenSprites) {
      const sprite = spriteData?.sprite;
      if (!sprite) continue;

      const foundryToken = placeableMap.get(tokenId);
      if (!foundryToken) {
        // Token has a Three.js sprite but no PIXI counterpart — hide it
        sprite.visible = false;
        this.detectionState.set(tokenId, { visible: false, detectionFilter: null });
        continue;
      }

      let visible;
      let detectionFilter = null;

      try {
        // Token.isVisible is the authoritative source. It checks:
        //  - hidden (GM-only)
        //  - tokenVision disabled → always visible
        //  - controlled → always visible
        //  - active vision → always visible
        //  - otherwise → canvas.visibility.testVisibility (geometric LOS test)
        visible = foundryToken.isVisible;
        detectionFilter = foundryToken.detectionFilter
          ? this._identifyDetectionFilter(foundryToken)
          : null;
      } catch (e) {
        // If isVisible throws (e.g. vision not ready), fall back:
        // GM sees everything, players see nothing until vision is ready.
        visible = isGM;
      }

      // Level-based filtering: hide tokens that are above the current level.
      if (visible && this._isTokenAboveCurrentLevel(foundryToken.document)) {
        visible = false;
      }

      sprite.visible = visible;
      if (visible && sprite.material?.map) {
        // Only restore opacity if the texture has loaded. Without a map,
        // setting opacity > 0 would show a white rectangle.
        sprite.material.opacity = foundryToken.document?.hidden ? 0.5 : 1.0;
      }
      this.detectionState.set(tokenId, { visible, detectionFilter });
    }
  }

  // ---------------------------------------------------------------------------
  //  Detection filter helpers
  // ---------------------------------------------------------------------------

  /**
   * Identify what type of detection filter was applied to a token.
   * Returns the detection mode id string for Phase 3 rendering.
   * @param {Token} foundryToken
   * @returns {string|null}
   * @private
   */
  _identifyDetectionFilter(foundryToken) {
    const filter = foundryToken.detectionFilter;
    if (!filter) return null;

    try {
      const className = filter.constructor?.name ?? '';
      if (className.includes('Glow')) return 'glow';
      if (className.includes('Outline')) return 'outline';
    } catch (_) {}

    return 'unknown';
  }

  /**
   * Check if a specific token was detected by a special detection mode.
   * @param {string} tokenId
   * @returns {{visible: boolean, detectionFilter: string|null}|null}
   */
  getDetectionState(tokenId) {
    return this.detectionState.get(tokenId) ?? null;
  }

  /**
   * Check if any tokens have active detection filters (for Phase 3 optimization).
   * @returns {boolean}
   */
  hasActiveDetectionFilters() {
    for (const state of this.detectionState.values()) {
      if (state.detectionFilter) return true;
    }
    return false;
  }
}
