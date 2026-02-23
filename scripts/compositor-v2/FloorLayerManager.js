/**
 * @fileoverview FloorLayerManager — assigns Three.js layers to tiles/tokens
 * based on their floor band, and provides camera layer masks for per-floor rendering.
 *
 * Replaces FloorStack's per-frame visibility toggling with a one-time layer
 * assignment at tile/token creation. Floor isolation during rendering is then
 * simply a camera.layers.mask swap — no scene graph mutations per frame.
 *
 * Layer budget (Three.js supports 0–31):
 *   0       — default (unused by v2; tiles are moved off layer 0)
 *   1–19    — floor layers (FLOOR_LAYERS[0] = 1, FLOOR_LAYERS[1] = 2, …)
 *   20      — ROOF_LAYER (existing, keep)
 *   21      — WEATHER_ROOF_LAYER (existing, keep)
 *   22–24   — freed (formerly floor-presence/water-occluder, eliminated in v2)
 *   25      — ROPE_MASK_LAYER (existing, keep)
 *   26      — TOKEN_MASK_LAYER (existing, keep)
 *   29      — GLOBAL_SCENE_LAYER (existing, keep)
 *   30      — BLOOM_HOTSPOT_LAYER (existing, keep)
 *   31      — OVERLAY_THREE_LAYER (existing, keep)
 *
 * Architecture reference: FLOOR-COMPOSITOR-REBUILD.md §A4, §A5
 *
 * @module compositor-v2/FloorLayerManager
 */

import { createLogger } from '../core/log.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../foundry/levels-scene-flags.js';
import { OVERLAY_THREE_LAYER, GLOBAL_SCENE_LAYER } from '../effects/EffectComposer.js';

const log = createLogger('FloorLayerManager');

// ─── Layer Constants ─────────────────────────────────────────────────────────

/**
 * Floor layers start at Three.js layer 1. Layer 0 is the default layer and
 * is NOT used for floor geometry — this prevents accidentally rendering tiles
 * in passes that only enable layer 0.
 *
 * Max 19 floors supported (layers 1–19). This is more than any VTT scene
 * will ever need (most scenes have 1–4 floors).
 */
const FLOOR_LAYER_BASE = 1;
const MAX_FLOOR_LAYERS = 19;

/**
 * Pre-computed array of floor layer indices: [1, 2, 3, …, 19].
 * FLOOR_LAYERS[floorIndex] gives the Three.js layer number for that floor.
 * @type {number[]}
 */
export const FLOOR_LAYERS = Array.from({ length: MAX_FLOOR_LAYERS }, (_, i) => FLOOR_LAYER_BASE + i);

// ─── FloorLayerManager ──────────────────────────────────────────────────────

/**
 * Manages Three.js layer assignment for floor-based rendering isolation.
 *
 * Tiles and tokens are assigned to a floor layer once at creation time
 * (via assignTileToFloor / assignTokenToFloor). The per-floor render loop
 * then uses getFloorCameraMask(floorIndex) to set the camera's layer mask,
 * which is a single integer write — no scene graph mutation.
 */
export class FloorLayerManager {
  constructor() {
    /**
     * Reference to the FloorStack for floor band discovery.
     * @type {import('../scene/FloorStack.js').FloorStack|null}
     */
    this._floorStack = null;

    /**
     * Tracks which floor layer each sprite is assigned to.
     * Key: sprite (Object3D reference), Value: floor index.
     * Used for debugging and reassignment when floor bands change.
     * @type {Map<import('three').Object3D, number>}
     */
    this._spriteFloorMap = new Map();

    log.debug('FloorLayerManager created');
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  /**
   * Wire the FloorStack reference for floor band lookups.
   * @param {import('../scene/FloorStack.js').FloorStack} floorStack
   */
  setFloorStack(floorStack) {
    this._floorStack = floorStack;
  }

  // ── Layer Assignment ────────────────────────────────────────────────────────

  /**
   * Assign a tile sprite to the correct floor layer based on its tile document.
   *
   * Called from TileManager.updateSpriteProperties() for every tile on creation
   * and update. This is the ONLY place floor layer assignment happens.
   *
   * The sprite's layer 0 is disabled (tiles must not render in default-layer
   * passes). The floor layer is enabled additively so other layers (ROOF_LAYER,
   * WEATHER_ROOF_LAYER, etc.) set by updateSpriteProperties() are preserved.
   *
   * @param {import('three').Object3D} sprite - The tile's Three.js sprite/mesh
   * @param {object} tileDoc - Foundry TileDocument
   */
  assignTileToFloor(sprite, tileDoc) {
    if (!sprite || !tileDoc) return;

    const floorIndex = this._resolveFloorIndex(tileDoc);
    const floorLayer = FLOOR_LAYERS[floorIndex];
    if (floorLayer === undefined) {
      log.warn(`Floor index ${floorIndex} exceeds max layers (${MAX_FLOOR_LAYERS}), clamping to last`);
      return;
    }

    // Remove from any previous floor layer assignment.
    const prevFloor = this._spriteFloorMap.get(sprite);
    if (prevFloor !== undefined && prevFloor !== floorIndex) {
      const prevLayer = FLOOR_LAYERS[prevFloor];
      if (prevLayer !== undefined) sprite.layers.disable(prevLayer);
    }

    // Disable layer 0 — tiles must ONLY render via their floor layer.
    sprite.layers.disable(0);

    // Enable the floor layer (additive — preserves ROOF_LAYER, etc.).
    sprite.layers.enable(floorLayer);

    this._spriteFloorMap.set(sprite, floorIndex);
  }

  /**
   * Assign a token sprite to the correct floor layer based on its token document.
   *
   * Same pattern as assignTileToFloor but uses token elevation for floor lookup.
   *
   * @param {import('three').Object3D} sprite - The token's Three.js sprite/mesh
   * @param {object} tokenDoc - Foundry TokenDocument
   */
  assignTokenToFloor(sprite, tokenDoc) {
    if (!sprite || !tokenDoc) return;

    const floorIndex = this._resolveTokenFloorIndex(tokenDoc);
    const floorLayer = FLOOR_LAYERS[floorIndex];
    if (floorLayer === undefined) return;

    const prevFloor = this._spriteFloorMap.get(sprite);
    if (prevFloor !== undefined && prevFloor !== floorIndex) {
      const prevLayer = FLOOR_LAYERS[prevFloor];
      if (prevLayer !== undefined) sprite.layers.disable(prevLayer);
    }

    sprite.layers.disable(0);
    sprite.layers.enable(floorLayer);

    this._spriteFloorMap.set(sprite, floorIndex);
  }

  /**
   * Assign the basePlaneMesh to floor 0's layer.
   * Called once during scene loading.
   * @param {import('three').Mesh} basePlaneMesh
   */
  assignBasePlane(basePlaneMesh) {
    if (!basePlaneMesh) return;
    basePlaneMesh.layers.disable(0);
    basePlaneMesh.layers.enable(FLOOR_LAYERS[0]);
    this._spriteFloorMap.set(basePlaneMesh, 0);
    log.debug('basePlaneMesh assigned to floor 0 layer');
  }

  // ── Camera Mask Helpers ─────────────────────────────────────────────────────

  /**
   * Get the camera layer mask for rendering a specific floor.
   *
   * The mask enables ONLY that floor's layer. OVERLAY_THREE_LAYER and
   * GLOBAL_SCENE_LAYER are explicitly excluded (they render in separate passes).
   *
   * @param {number} floorIndex
   * @returns {number} Bitmask for camera.layers.mask
   */
  getFloorCameraMask(floorIndex) {
    const layer = FLOOR_LAYERS[floorIndex];
    if (layer === undefined) return 0;
    // Single bit for just this floor's layer.
    return 1 << layer;
  }

  /**
   * Get a camera mask that includes ALL floor layers (for fallback single-pass).
   * @returns {number}
   */
  getAllFloorsCameraMask() {
    let mask = 0;
    const floors = this._floorStack?.getFloors() ?? [];
    for (let i = 0; i < floors.length && i < MAX_FLOOR_LAYERS; i++) {
      mask |= (1 << FLOOR_LAYERS[i]);
    }
    return mask;
  }

  // ── Reassignment ────────────────────────────────────────────────────────────

  /**
   * Reassign all tracked sprites to their correct floor layers.
   *
   * Called when floor bands change (e.g., after mapShineLevelContextChanged
   * triggers a FloorStack rebuild with different elevation ranges). This
   * re-evaluates each sprite's floor membership and moves it to the correct
   * layer if needed.
   *
   * @param {import('../scene/tile-manager.js').TileManager} tileManager
   * @param {import('../scene/token-manager.js').TokenManager} [tokenManager]
   */
  reassignAllLayers(tileManager, tokenManager) {
    let reassigned = 0;

    // Reassign tiles.
    if (tileManager?.tileSprites) {
      for (const { sprite, tileDoc } of tileManager.tileSprites.values()) {
        if (!sprite) continue;
        this.assignTileToFloor(sprite, tileDoc);
        reassigned++;
      }
    }

    // Reassign tokens.
    if (tokenManager?.tokenSprites) {
      for (const { sprite, tokenDoc } of tokenManager.tokenSprites.values()) {
        if (!sprite) continue;
        this.assignTokenToFloor(sprite, tokenDoc);
        reassigned++;
      }
    }

    // Reassign basePlaneMesh.
    const basePlane = window.MapShine?.sceneComposer?.basePlaneMesh;
    if (basePlane) {
      this.assignBasePlane(basePlane);
    }

    log.info(`Reassigned ${reassigned} sprites to floor layers`);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  /**
   * Remove a sprite from tracking when it is disposed.
   * @param {import('three').Object3D} sprite
   */
  untrack(sprite) {
    this._spriteFloorMap.delete(sprite);
  }

  /**
   * Release all references. Call on scene teardown.
   */
  dispose() {
    this._spriteFloorMap.clear();
    this._floorStack = null;
    log.debug('FloorLayerManager disposed');
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Determine which floor index a tile belongs to, using the same logic as
   * FloorStack._tileIsOnFloor but returning the index instead of a boolean.
   *
   * @param {object} tileDoc
   * @returns {number} Floor index (0-based), clamped to valid range
   * @private
   */
  _resolveFloorIndex(tileDoc) {
    const floors = this._floorStack?.getFloors() ?? [];
    if (floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      // Find the best floor by midpoint containment, preferring lower floors.
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid <= f.elevationMax) {
          return Math.min(i, MAX_FLOOR_LAYERS - 1);
        }
      }

      // Fallback: first floor whose band overlaps the tile range.
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) {
          return Math.min(i, MAX_FLOOR_LAYERS - 1);
        }
      }
    }

    // No Levels range: use tile elevation.
    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) {
        return Math.min(i, MAX_FLOOR_LAYERS - 1);
      }
    }

    return 0;
  }

  /**
   * Determine which floor index a token belongs to.
   * @param {object} tokenDoc
   * @returns {number}
   * @private
   */
  _resolveTokenFloorIndex(tokenDoc) {
    const floors = this._floorStack?.getFloors() ?? [];
    if (floors.length <= 1) return 0;

    const rawElev = tokenDoc?.elevation ?? tokenDoc?.document?.elevation ?? 0;
    const elev = Number.isFinite(Number(rawElev)) ? Number(rawElev) : 0;

    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) {
        return Math.min(i, MAX_FLOOR_LAYERS - 1);
      }
    }

    return 0;
  }
}
