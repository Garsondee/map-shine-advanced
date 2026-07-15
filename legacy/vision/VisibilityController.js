/**
 * @fileoverview Controls Three.js token visibility using a dual-path approach
 * for maximum robustness.
 *
 * ARCHITECTURE — Two redundant paths ensure correct visibility:
 *
 * PATH A — _refreshVisibility patch (per-token, immediate):
 *   Monkey-patches Token.prototype._refreshVisibility so we execute inside
 *   Foundry's render-flag pipeline at exactly the moment each token's
 *   isVisible is evaluated. Syncs the result to the Three.js sprite (with
 *   the same window optical pass-through fallback as Path B) and forces the
 *   PIXI token to remain visible for hit-testing (Three.js handles the visual
 *   hiding; PIXI stays interactive at alpha=0).
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
import { isGmLike } from '../core/gm-parity.js';


import { createLogger } from '../core/log.js';
import { getTokenRenderingMode, TOKEN_RENDERING_MODES } from '../settings/scene-settings.js';
import { isLevelsEnabledForScene, hasV14NativeLevels, readWallHeightFlags } from '../foundry/levels-scene-flags.js';

const log = createLogger('VisibilityController');

function _isFoundryTokenRenderingMode() {
  try {
    return getTokenRenderingMode() === TOKEN_RENDERING_MODES.FOUNDRY;
  } catch (_) {
    return false;
  }
}

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

      // Save the computed visibility BEFORE we override it for hit-testing
      const computedVisibility = this.isVisible ?? this.visible;

      // Step 2: Sync the computed result to the Three.js sprite.
      if (self._initialized) {
        const tokenId = this.document?.id;
        if (tokenId) {
          self._syncSingleToken(tokenId, this, computedVisibility);
        }
      }

      if (_isFoundryTokenRenderingMode()) {
        // In native mode, keep Foundry token visuals untouched.
        return;
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

  /**
   * Request a compositor frame after token visibility changes.
   * @private
   */
  _requestRender() {
    try {
      window.MapShine?.renderLoop?.requestRender?.();
    } catch (_) {
    }
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
      if (!levelContext) return false;

      const scene = canvas?.scene;
      if (!hasV14NativeLevels(scene) && !isLevelsEnabledForScene(scene)) return false;
      if (String(levelContext?.source || '') === 'inferred') return false;
      if ((levelContext.count ?? 0) <= 1) return false;

      // V14 native: tokens have `level` (singular ID). Use Foundry's
      // includedInLevel which respects the level visibility graph.
      if (hasV14NativeLevels(scene)) {
        const activeLevelId = levelContext?.levelId;
        if (typeof activeLevelId === 'string') {
          const td = tokenDoc?.document ?? tokenDoc;
          if (typeof td?.includedInLevel === 'function') {
            return !td.includedInLevel(activeLevelId);
          }
          const tokenLevelId = td?.level ?? td?._source?.level;
          if (typeof tokenLevelId === 'string') {
            return tokenLevelId !== activeLevelId;
          }
        }
      }

      // Legacy elevation-based filtering
      if (!Number.isFinite(levelContext.top)) return false;
      const tokenElev = Number(tokenDoc?.elevation ?? 0);
      if (!Number.isFinite(tokenElev)) return false;
      return tokenElev >= levelContext.top - 0.01;
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether `viewer` has unobstructed sight/light to `point` (canvas-space {x,y}),
   * treating PROXIMITY/DISTANCE walls as optical pass-through (windows).
   * Used by token visibility and {@link WallManager} door icon visibility.
   *
   * @param {{x: number, y: number}} point
   * @param {Token} viewer - Foundry token placeable
   * @returns {boolean}
   */
  canSeePointOptically(point, viewer) {
    try {
      if (!point || !viewer) return false;
      const hasSight = !!(viewer.hasSight || viewer.document?.sight?.enabled);
      if (!hasSight) return false;

      const origin = viewer.center;
      if (!origin) return false;

      const viewerElevation = Number.isFinite(Number(viewer?.document?.elevation))
        ? Number(viewer.document.elevation)
        : 0;

      const sightHit = this._findClosestBlockingCollisionWithOpticalPassThrough(
        viewer,
        origin,
        point,
        'sight',
        viewerElevation
      );
      if (sightHit) return false;

      const lightHit = this._findClosestBlockingCollisionWithOpticalPassThrough(
        viewer,
        origin,
        point,
        'light',
        viewerElevation
      );
      if (lightHit) return false;

      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Optical LOS fallback for cases where Foundry visibility disagrees with
   * MapShine's window pass-through wall behavior.
   * @param {Token|null} targetToken
   * @returns {boolean}
   * @private
   */
  _canAnyControlledTokenSeeTargetOptically(targetToken) {
    try {
      if (!targetToken) return false;
      const controlled = canvas?.tokens?.controlled;
      if (!Array.isArray(controlled) || controlled.length === 0) return false;

      const targetCenter = targetToken.center;
      if (!targetCenter) return false;
      const targetTokenId = targetToken.document?.id;

      for (const viewer of controlled) {
        if (!viewer) continue;
        if (viewer === targetToken) return true;
        if (viewer.document?.id && viewer.document.id === targetTokenId) return true;

        if (this.canSeePointOptically(targetCenter, viewer)) return true;
      }
    } catch (_) {
    }
    return false;
  }

  /**
   * Variant of collision query that treats optical proximity/distance walls as
   * pass-through, matching flashlight window behavior.
   * @private
   */
  _findClosestBlockingCollisionWithOpticalPassThrough(tokenObj, origin, destination, type, elevation) {
    if (!tokenObj || !destination || !type) return null;
    const backend = CONFIG?.Canvas?.polygonBackends?.[type];

    try {
      const allHits = backend?.testCollision?.(origin, destination, {
        mode: 'all',
        type,
        source: tokenObj,
        token: tokenObj,
        edgeDirectionMode: CONST?.EDGE_DIRECTION_MODES?.NORMAL,
        useThreshold: true
      });
      if (!Array.isArray(allHits) || allHits.length === 0) return null;

      for (const hit of allHits) {
        if (this._collisionHitBlocksAtElevationWithOpticalPassThrough(hit, elevation, type)) {
          return hit;
        }
      }
    } catch (_) {
    }

    return null;
  }

  /**
   * Elevation-aware wall blocking with optical pass-through support for
   * proximity/distance walls (windows).
   * @private
   */
  _collisionHitBlocksAtElevationWithOpticalPassThrough(hit, elevation, type = null) {
    if (!hit) return false;
    if (!Number.isFinite(elevation)) return true;
    if (typeof hit !== 'object') return !!hit;

    const edges = hit?.edges;
    if (!(edges instanceof Set) || edges.size === 0) return true;

    for (const edge of edges) {
      if (!edge) continue;
      if (edge.type && edge.type !== 'wall') return true;

      const wallDoc = edge.object?.document ?? edge.object ?? null;
      if (!wallDoc) return true;

      const bounds = readWallHeightFlags(wallDoc);
      let bottom = Number(bounds?.bottom);
      let top = Number(bounds?.top);
      if (!Number.isFinite(bottom)) bottom = -Infinity;
      if (!Number.isFinite(top)) top = Infinity;
      if (top < bottom) {
        const swap = bottom;
        bottom = top;
        top = swap;
      }
      if (bottom <= elevation && elevation < top) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  //  Core visibility logic (shared by both paths)
  // ---------------------------------------------------------------------------

  /**
   * Sync a single token's Three.js sprite visibility to Foundry's isVisible.
   * Called from the _refreshVisibility patch (Path A).
   * @param {string} tokenId
   * @param {Token} foundryToken - The Foundry PIXI token object
   * @param {boolean} [computedVisibility] - The computed visibility from the patch
   * @private
   */
  _syncSingleToken(tokenId, foundryToken, computedVisibility) {
    const spriteData = this.tokenManager?.tokenSprites?.get(tokenId);
    if (!spriteData?.sprite) return;

    const sprite = spriteData.sprite;

    if (_isFoundryTokenRenderingMode()) {
      sprite.visible = false;
      this.detectionState.set(tokenId, { visible: false, detectionFilter: null });
      return;
    }

    // Use the explicitly passed computed visibility, or fallback to isVisible
    let visible = computedVisibility ?? foundryToken.isVisible ?? foundryToken.visible;

    // Match Path B: window (PROXIMITY/DISTANCE) optical pass-through so the next
    // render-flag tick does not overwrite sightRefresh with Foundry-strict false.
    if (!visible) {
      visible = this._canAnyControlledTokenSeeTargetOptically(foundryToken);
    }

    // Level-based filtering: hide tokens that are above the current level.
    // This runs after Foundry's own visibility so we only further restrict.
    if (visible && this._isTokenAboveCurrentLevel(foundryToken.document)) {
      visible = false;
    }

    const wasVisible = sprite.visible;
    const previousOpacity = Number(sprite.material?.opacity);
    sprite.visible = visible;
    if (visible && sprite.material?.map) {
      // Only restore opacity if the texture has loaded. Without a map,
      // setting opacity > 0 would show a white rectangle.
      sprite.material.opacity = foundryToken.document?.hidden ? 0.5 : 1.0;
    }
    if (wasVisible !== sprite.visible || previousOpacity !== Number(sprite.material?.opacity)) {
      this._requestRender();
    }

    // Track detection state for Phase 3 glow/outline rendering.
    const detectionFilter = foundryToken.detectionFilter
      ? this._identifyDetectionFilter(foundryToken)
      : null;
    this.detectionState.set(tokenId, { visible, detectionFilter });
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

    const foundryMode = _isFoundryTokenRenderingMode();

    // Build lookup: tokenId → Foundry PIXI Token
    const placeableMap = new Map();
    for (const t of placeables) {
      if (t.document?.id) placeableMap.set(t.document.id, t);
    }

    const isGM = isGmLike();
    let changed = false;

    for (const [tokenId, spriteData] of this.tokenManager.tokenSprites) {
      const sprite = spriteData?.sprite;
      if (!sprite) continue;

      if (foundryMode) {
        sprite.visible = false;
        this.detectionState.set(tokenId, { visible: false, detectionFilter: null });
        continue;
      }

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
        // If isVisible throws (e.g. vision not ready), fail-soft for players:
        // prefer prior state, then owner/control visibility. Avoids a hard
        // "players see nothing" collapse during startup races.
        const prior = this.detectionState.get(tokenId)?.visible;
        if (typeof prior === 'boolean') {
          visible = prior;
        } else {
          visible = !!(
            isGM
            || foundryToken?.controlled
            || foundryToken?.isOwner
            || foundryToken?.document?.isOwner
          );
        }
      }

      if (!visible) {
        visible = this._canAnyControlledTokenSeeTargetOptically(foundryToken);
      }

      // Level-based filtering: hide tokens that are above the current level.
      if (visible && this._isTokenAboveCurrentLevel(foundryToken.document)) {
        visible = false;
      }

      const wasVisible = sprite.visible;
      const previousOpacity = Number(sprite.material?.opacity);
      sprite.visible = visible;
      if (visible && sprite.material?.map) {
        // Only restore opacity if the texture has loaded. Without a map,
        // setting opacity > 0 would show a white rectangle.
        sprite.material.opacity = foundryToken.document?.hidden ? 0.5 : 1.0;
      }
      if (wasVisible !== sprite.visible || previousOpacity !== Number(sprite.material?.opacity)) {
        changed = true;
      }
      this.detectionState.set(tokenId, { visible, detectionFilter });
    }

    if (changed) this._requestRender();
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
