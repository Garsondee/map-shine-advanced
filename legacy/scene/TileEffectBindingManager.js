/**
 * @fileoverview TileEffectBindingManager — centralized routing layer for per-tile
 * effect overlays (specular, fluid, and any future tile-bindable effects).
 *
 * ## Problem it solves
 * Previously, TileManager held direct references to SpecularEffect and FluidEffect
 * and called their bind/unbind/sync methods at every tile lifecycle point. Adding a
 * new per-tile effect required editing TileManager in multiple places.
 *
 * ## Architecture
 * Effects implement the TileBindableEffect interface:
 *   - bindTileSprite(tileDoc, sprite, maskTexture?, options?)
 *   - unbindTileSprite(tileId)
 *   - syncTileSpriteTransform(tileId, sprite)
 *   - syncTileSpriteVisibility(tileId, sprite)   [optional]
 *
 * TileManager calls this manager at every tile lifecycle event. The manager fans
 * the call out to all registered effects. TileManager no longer needs to know
 * which effects exist.
 *
 * ## Tile-ready flow
 * When a tile becomes ready (texture loaded), TileManager calls:
 *   bindingManager.onTileReady(tileDoc, sprite)
 *
 * The manager asks each registered effect to load its own per-tile mask texture
 * (via the effect's optional loadTileMask(tileDoc) method) and then calls
 * bindTileSprite. Effects that don't need per-tile masks (e.g. occluder-only)
 * can bind immediately with null.
 *
 * @module scene/TileEffectBindingManager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TileEffectBindingManager');

/**
 * @typedef {object} TileBindableEffect
 * @property {function(object, THREE.Object3D, THREE.Texture|null, object=): void} bindTileSprite
 * @property {function(string): void} unbindTileSprite
 * @property {function(string, THREE.Object3D): void} syncTileSpriteTransform
 * @property {function(string, THREE.Object3D): void} [syncTileSpriteVisibility]
 * @property {function(object): Promise<THREE.Texture|null>} [loadTileMask]
 *   Optional: if present, called by the manager to load the per-tile mask before
 *   calling bindTileSprite. If absent, bindTileSprite is called with null.
 * @property {function(object): boolean} [shouldBindTile]
 *   Optional: if present, called to decide whether this tile should be bound at
 *   all. Return false to skip binding (e.g. overhead tiles for some effects).
 */

export class TileEffectBindingManager {
  constructor() {
    /**
     * Registered tile-bindable effects, in registration order.
     * @type {TileBindableEffect[]}
     */
    this._effects = [];

    /**
     * Active level context for floor-change filtering.
     * @type {{bottom: number, top: number}|null}
     */
    this._levelContext = null;

    log.debug('TileEffectBindingManager created');
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Register a tile-bindable effect. The effect will receive all future tile
   * lifecycle events. Idempotent — registering the same effect twice is a no-op.
   * @param {TileBindableEffect} effect
   */
  registerEffect(effect) {
    if (!effect || this._effects.includes(effect)) return;
    this._effects.push(effect);
    log.debug(`TileEffectBindingManager: registered effect (total=${this._effects.length})`);
  }

  /**
   * Unregister a tile-bindable effect. Does not unbind any existing tiles —
   * call dispose() on the effect separately if needed.
   * @param {TileBindableEffect} effect
   */
  unregisterEffect(effect) {
    const idx = this._effects.indexOf(effect);
    if (idx !== -1) {
      this._effects.splice(idx, 1);
      log.debug(`TileEffectBindingManager: unregistered effect (total=${this._effects.length})`);
    }
  }

  // ── Tile lifecycle ──────────────────────────────────────────────────────────

  /**
   * Called when a tile sprite is ready (texture loaded, transform set).
   * Fans out to all registered effects: loads per-tile mask then binds.
   *
   * This is async because effects may need to load mask textures from disk.
   * Errors in individual effects are caught and logged without aborting others.
   *
   * @param {object} tileDoc - Foundry TileDocument
   * @param {THREE.Object3D} sprite - Three.js sprite mesh
   * @returns {Promise<void>}
   */
  async onTileReady(tileDoc, sprite) {
    if (!tileDoc || !sprite) return;
    const tileId = tileDoc.id;
    if (!tileId) return;

    for (const effect of this._effects) {
      try {
        // Allow effects to opt out of specific tiles (e.g. overhead tiles).
        if (typeof effect.shouldBindTile === 'function') {
          if (!effect.shouldBindTile(tileDoc)) continue;
        }

        let maskTexture = null;

        // If the effect knows how to load its own per-tile mask, let it do so.
        if (typeof effect.loadTileMask === 'function') {
          try {
            maskTexture = await effect.loadTileMask(tileDoc);
          } catch (e) {
            log.debug(`onTileReady: loadTileMask failed for tile ${tileId}`, e);
          }
        }

        // Verify the tile is still alive after the async mask load.
        if (!sprite.parent && sprite.parent !== null) continue;

        effect.bindTileSprite(tileDoc, sprite, maskTexture);
      } catch (e) {
        log.warn(`onTileReady: effect.bindTileSprite failed for tile ${tileId}`, e);
      }
    }
  }

  /**
   * Called when a tile sprite's world transform changes (position, rotation,
   * scale, or material rotation from TileMotionManager animation).
   * @param {string} tileId
   * @param {THREE.Object3D} sprite
   */
  onTileTransformChanged(tileId, sprite) {
    if (!tileId || !sprite) return;
    for (const effect of this._effects) {
      try {
        effect.syncTileSpriteTransform(tileId, sprite);
      } catch (e) {
        log.debug(`onTileTransformChanged: failed for tile ${tileId}`, e);
      }
    }
  }

  /**
   * Called when a tile sprite's visibility changes (level switch, hidden flag,
   * hover fade). Effects should show/hide their overlays to match.
   * @param {string} tileId
   * @param {THREE.Object3D} sprite
   */
  onTileVisibilityChanged(tileId, sprite) {
    if (!tileId || !sprite) return;
    for (const effect of this._effects) {
      try {
        if (typeof effect.syncTileSpriteVisibility === 'function') {
          effect.syncTileSpriteVisibility(tileId, sprite);
        } else {
          // Fall back to transform sync which also mirrors visibility.
          effect.syncTileSpriteTransform(tileId, sprite);
        }
      } catch (e) {
        log.debug(`onTileVisibilityChanged: failed for tile ${tileId}`, e);
      }
    }
  }

  /**
   * Called when a tile is removed from the scene (deleted or scene teardown).
   * Unbinds all effect overlays for this tile and disposes GPU resources.
   * @param {string} tileId
   */
  onTileRemoved(tileId) {
    if (!tileId) return;
    for (const effect of this._effects) {
      try {
        effect.unbindTileSprite(tileId);
      } catch (e) {
        log.debug(`onTileRemoved: failed for tile ${tileId}`, e);
      }
    }
  }

  /**
   * Called when the active level context changes (floor switch).
   * Effects that implement onLevelChanged() receive the new context directly.
   * All other effects have their per-tile overlays visibility-synced via
   * onTileVisibilityChanged so they hide/show correctly for the new floor.
   *
   * @param {{bottom: number, top: number}} levelContext - New active level band
   * @param {Map<string, {sprite: THREE.Object3D, tileDoc: object}>} tileSprites
   *   Current tile sprite map from TileManager (for visibility re-sync).
   */
  onLevelChanged(levelContext, tileSprites) {
    this._levelContext = levelContext;

    // Notify effects that have a dedicated level-change handler.
    for (const effect of this._effects) {
      try {
        if (typeof effect.onLevelChanged === 'function') {
          effect.onLevelChanged(levelContext);
        }
      } catch (e) {
        log.debug('onLevelChanged: effect.onLevelChanged failed', e);
      }
    }

    // Re-sync visibility for all current tiles so overlays hide/show correctly.
    if (tileSprites) {
      for (const [tileId, data] of tileSprites) {
        const sprite = data?.sprite;
        if (!sprite) continue;
        this.onTileVisibilityChanged(tileId, sprite);
      }
    }
  }

  // ── Dispose ─────────────────────────────────────────────────────────────────

  /**
   * Dispose all bindings. Does NOT dispose the effects themselves — the effects
   * own their GPU resources and are disposed separately.
   * After dispose(), the manager is empty and can be re-used.
   */
  dispose() {
    this._effects.length = 0;
    this._levelContext = null;
    log.debug('TileEffectBindingManager disposed');
  }
}
