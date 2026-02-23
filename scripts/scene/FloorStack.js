/**
 * @fileoverview FloorStack — manages the ordered set of elevation floors in a scene.
 *
 * Responsibilities:
 * - Derive floor bands from a LevelsImportSnapshot (or single-floor fallback for
 *   scenes that do not use the Levels module).
 * - Track which floor is "active" (the player's current viewpoint).
 * - Toggle Three.js object visibility per-floor for the per-floor render loop.
 * - Provide the ordered floor array for EffectComposer's floor loop.
 *
 * Floor visibility toggling works by temporarily overriding `.visible` on tile
 * and token sprites to show only objects that belong to floor N. This automatically
 * propagates to all camera.layers-based sub-renders inside effects (roof alpha,
 * water occluder, token mask, etc.) without requiring any changes to those effects.
 *
 * Visibility is saved before the loop begins and restored after it completes each
 * frame via restoreVisibility(), returning every object to its Levels-driven state.
 *
 * Architecture reference: LEVELS-ARCHITECTURE-RETHINK.md §6, §12.10
 *
 * @module scene/FloorStack
 */

import { createLogger } from '../core/log.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../foundry/levels-scene-flags.js';

const log = createLogger('FloorStack');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Sentinel min elevation for open-ended floor bands (no Levels data) */
const ELEVATION_OPEN_BOTTOM = -1e9;
/** Sentinel max elevation for open-ended floor bands (no Levels data) */
const ELEVATION_OPEN_TOP = 1e9;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} FloorBand
 * @property {number} index        - Floor index (0 = ground, ascending)
 * @property {number} elevationMin - Bottom of this band's elevation range (inclusive)
 * @property {number} elevationMax - Top of this band's elevation range (inclusive)
 * @property {string} key          - Stable string key: `floor_${index}_${elevationMin}`
 * @property {string} compositorKey - Key matching GpuSceneMaskCompositor: `"${bottom}:${top}"`
 * @property {boolean} isActive    - Whether this is the player's current floor
 */

// ─── FloorStack ───────────────────────────────────────────────────────────────

/**
 * Manages the ordered set of elevation floors in a scene for the per-floor
 * rendering loop.
 */
export class FloorStack {
  constructor() {
    /** @type {import('./tile-manager.js').TileManager|null} */
    this._tileManager = null;

    /** @type {import('./token-manager.js').TokenManager|null} */
    this._tokenManager = null;

    /**
     * Ordered bottom-to-top array of floor bands for the current scene.
     * Rebuilt by rebuildFloors() on scene load and floor context changes.
     * @type {FloorBand[]}
     */
    this._floors = [];

    /** @type {number} Index into _floors for the player's current viewpoint */
    this._activeFloorIndex = 0;

    /**
     * Saved sprite visibility states captured at the start of each frame's
     * floor loop. Maps each Three.js sprite/mesh to its pre-loop .visible
     * value so restoreVisibility() can return every object to its
     * Levels-driven state after the loop completes.
     *
     * Keyed by the Three.js Object3D reference directly to avoid string
     * allocation per frame.
     * @type {Map<import('three').Object3D, boolean>}
     */
    this._savedVisibility = new Map();

    log.debug('FloorStack created');
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  /**
   * Wire manager references used for per-floor visibility toggling.
   * Call immediately after both managers are initialized.
   * @param {import('./tile-manager.js').TileManager} tileManager
   * @param {import('./token-manager.js').TokenManager} tokenManager
   */
  setManagers(tileManager, tokenManager) {
    this._tileManager = tileManager;
    this._tokenManager = tokenManager;
  }

  // ── Floor Discovery ──────────────────────────────────────────────────────

  /**
   * Rebuild the floor band array from the provided Levels scene bands.
   *
   * Call this on scene load (after LevelsImportSnapshot is built) and whenever
   * the active level context changes.
   *
   * @param {import('../core/levels-import/LevelsImportSnapshot.js').LevelsSceneBand[]|null|undefined} sceneBands
   *   Array of {bottom, top, name} bands from LevelsImportSnapshot.sceneBands.
   *   Pass null/undefined to use a single-floor fallback (non-Levels scenes).
   * @param {object|null} activeLevelContext
   *   The current active level context {bottom, top} from window.MapShine.activeLevelContext.
   *   Used to identify which floor is active after rebuilding.
   */
  rebuildFloors(sceneBands, activeLevelContext) {
    if (sceneBands?.length > 0) {
      // Build a FloorBand for each Levels scene band, sorted bottom-to-top.
      const sorted = [...sceneBands].sort((a, b) => Number(a.bottom) - Number(b.bottom));
      this._floors = sorted.map((band, i) => ({
        index: i,
        elevationMin: Number(band.bottom),
        elevationMax: Number(band.top),
        key: `floor_${i}_${band.bottom}`,
        // Matches GpuSceneMaskCompositor._floorMeta key format used in composeFloor().
        compositorKey: `${band.bottom ?? ''}:${band.top ?? ''}`,
        isActive: false,
      }));
    } else {
      // Non-Levels scene: single omnipresent floor.
      this._floors = [{
        index: 0,
        elevationMin: ELEVATION_OPEN_BOTTOM,
        elevationMax: ELEVATION_OPEN_TOP,
        key: 'floor_0_default',
        // Non-Levels scene: context has no bottom/top so both sides are empty string.
        compositorKey: ':',
        isActive: true,
      }];
    }

    // Mark the active floor from the current level context.
    this._activeFloorIndex = this._resolveActiveFloorIndex(activeLevelContext);
    if (this._floors[this._activeFloorIndex]) {
      this._floors[this._activeFloorIndex].isActive = true;
    }

    log.info(`FloorStack rebuilt: ${this._floors.length} floor(s), active=${this._activeFloorIndex}`, {
      floors: this._floors.map(f => `[${f.elevationMin}–${f.elevationMax}]`),
    });
  }

  // ── Floor Access ──────────────────────────────────────────────────────────

  /**
   * Returns the ordered bottom-to-top array of all floor bands in the scene.
   * @returns {FloorBand[]}
   */
  getFloors() {
    return this._floors;
  }

  /**
   * Returns the floors that should be rendered this frame: all floors from the
   * bottom (floor 0) up to and including the active floor, in bottom-to-top
   * order. Lower floors are visible through gaps in higher floor tiles.
   *
   * In a single-floor scene this returns exactly [floor 0].
   * @returns {FloorBand[]}
   */
  getVisibleFloors() {
    if (this._floors.length <= 1) return this._floors.slice();
    return this._floors.slice(0, this._activeFloorIndex + 1);
  }

  /**
   * Returns the currently active (player-viewed) floor band.
   * @returns {FloorBand|null}
   */
  getActiveFloor() {
    return this._floors[this._activeFloorIndex] ?? null;
  }

  /**
   * Update which floor is active based on the given level context.
   * Marks the new active floor's `isActive` flag and clears the old one.
   * @param {number} floorIndex
   */
  setActiveFloor(floorIndex) {
    if (this._floors.length === 0) return;
    const clamped = Math.max(0, Math.min(this._floors.length - 1, floorIndex));

    if (clamped === this._activeFloorIndex) return;

    if (this._floors[this._activeFloorIndex]) {
      this._floors[this._activeFloorIndex].isActive = false;
    }
    this._activeFloorIndex = clamped;
    if (this._floors[this._activeFloorIndex]) {
      this._floors[this._activeFloorIndex].isActive = true;
    }

    log.debug(`FloorStack active floor changed to ${clamped}`);
  }

  // ── Per-Frame Visibility Toggle ───────────────────────────────────────────

  /**
   * Save the current visibility state of all managed sprites and then show
   * only the sprites that belong to floor N.
   *
   * Called inside the EffectComposer floor loop before each floor's
   * depth capture and scene render. Must be paired with restoreVisibility()
   * after the loop completes.
   *
   * The save-once design: the first call each frame (floor 0) saves all states
   * into _savedVisibility. Subsequent calls (floor 1, 2, …) do not re-save so
   * the restore always returns to the original Levels-driven state, not to
   * the floor-loop-modified state of the previous floor pass.
   *
   * @param {number} floorIndex
   */
  setFloorVisible(floorIndex) {
    const floor = this._floors[floorIndex];
    if (!floor) return;

    const isFirstFloor = this._savedVisibility.size === 0;

    // ── Base Plane (scene background) ─────────────────────────────────────────
    // The basePlaneMesh is the scene background image. It belongs to the ground
    // floor (index 0). On upper floors it must be hidden so that pixels without
    // geometry remain transparent (alpha=0), allowing lower floors to show
    // through during alpha compositing. Without this, every floor's _floorRT
    // would be opaque and ground-floor effects (water, fire) would be invisible.
    const basePlane = window.MapShine?.sceneComposer?.basePlaneMesh;
    if (basePlane) {
      if (isFirstFloor) {
        this._savedVisibility.set(basePlane, basePlane.visible);
      }
      const origVisible = isFirstFloor ? basePlane.visible : (this._savedVisibility.get(basePlane) ?? basePlane.visible);
      basePlane.visible = origVisible && (floorIndex === 0);
    }

    // ── Tiles ────────────────────────────────────────────────────────────────
    const tileSprites = this._tileManager?.tileSprites;
    if (tileSprites) {
      for (const { sprite, tileDoc } of tileSprites.values()) {
        if (!sprite) continue;

        // Save original visibility on the first floor pass only.
        if (isFirstFloor) {
          this._savedVisibility.set(sprite, sprite.visible);
        }

        // Only show the sprite if it was originally visible AND belongs to
        // this floor. An originally-hidden sprite (e.g., Levels-hidden,
        // GM-hidden) stays hidden regardless of floor.
        const origVisible = isFirstFloor ? sprite.visible : (this._savedVisibility.get(sprite) ?? sprite.visible);
        sprite.visible = origVisible && this._tileIsOnFloor(tileDoc, floor);
      }
    }

    // ── Tokens ───────────────────────────────────────────────────────────────
    const tokenSprites = this._tokenManager?.tokenSprites;
    if (tokenSprites) {
      for (const { sprite, tokenDoc } of tokenSprites.values()) {
        if (!sprite) continue;

        if (isFirstFloor) {
          this._savedVisibility.set(sprite, sprite.visible);
        }

        const origVisible = isFirstFloor ? sprite.visible : (this._savedVisibility.get(sprite) ?? sprite.visible);
        sprite.visible = origVisible && this._tokenIsOnFloor(tokenDoc, floor);
      }
    }
  }

  /**
   * Restore all sprites to their pre-floor-loop visibility states.
   *
   * Call once after the floor loop completes each frame, before the global
   * scene pass. This returns every object to its Levels-driven visibility
   * (the state TileManager and TokenManager computed for the active level),
   * which is what the global scene pass and overlay pass expect.
   */
  restoreVisibility() {
    for (const [obj, visible] of this._savedVisibility) {
      obj.visible = visible;
    }
    this._savedVisibility.clear();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Release all references. Call when the scene is torn down.
   */
  dispose() {
    this._tileManager = null;
    this._tokenManager = null;
    this._floors = [];
    this._savedVisibility.clear();
    log.debug('FloorStack disposed');
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Determine whether a tile belongs to the given floor band.
   *
   * Rules:
   * - If the tile has Levels range flags (rangeBottom/rangeTop), it belongs
   *   to any floor whose band overlaps with that range.
   * - If the tile has no Levels range flags, it belongs to whichever floor
   *   band contains its `elevation` value.
   * - If the floor band is the sentinel open-ended range (non-Levels scene),
   *   all tiles are considered on that floor.
   *
   * @param {object} tileDoc
   * @param {FloorBand} floor
   * @returns {boolean}
   * @private
   */
  _tileIsOnFloor(tileDoc, floor) {
    // Open-ended single-floor fallback — everything is on floor 0.
    if (floor.elevationMin === ELEVATION_OPEN_BOTTOM && floor.elevationMax === ELEVATION_OPEN_TOP) {
      return true;
    }

    if (tileHasLevelsRange(tileDoc)) {
      // Tile has explicit Levels range: check overlap with floor band.
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      // Standard interval overlap: [a,b] overlaps [c,d] iff a<=d && c<=b
      return tileBottom <= floor.elevationMax && floor.elevationMin <= tileTop;
    }

    // No Levels range: use tile's elevation to find its floor.
    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    return elev >= floor.elevationMin && elev <= floor.elevationMax;
  }

  /**
   * Determine whether a token belongs to the given floor band.
   *
   * A token's elevation is compared against the floor's [elevationMin, elevationMax]
   * range. Tokens without finite elevation are assigned to the lowest floor.
   *
   * @param {object} tokenDoc - The token document (Foundry TokenDocument)
   * @param {FloorBand} floor
   * @returns {boolean}
   * @private
   */
  _tokenIsOnFloor(tokenDoc, floor) {
    // Open-ended single-floor fallback — all tokens are on floor 0.
    if (floor.elevationMin === ELEVATION_OPEN_BOTTOM && floor.elevationMax === ELEVATION_OPEN_TOP) {
      return true;
    }

    // Token elevation can be on the root doc or under `.document`
    const rawElev = tokenDoc?.elevation ?? tokenDoc?.document?.elevation ?? 0;
    const elev = Number.isFinite(Number(rawElev)) ? Number(rawElev) : 0;

    // Edge case: token exactly on floor boundary belongs to the lower floor.
    return elev >= floor.elevationMin && elev <= floor.elevationMax;
  }

  /**
   * Resolve the floor index that corresponds to the given active level context.
   * Returns 0 if no match is found (safe default).
   *
   * @param {object|null|undefined} context - {bottom, top} from activeLevelContext
   * @returns {number}
   * @private
   */
  _resolveActiveFloorIndex(context) {
    if (!context || !Number.isFinite(Number(context.bottom))) return 0;

    const ctxBottom = Number(context.bottom);
    const ctxTop = Number(context.top);

    // Find the floor band that best matches the context's elevation range.
    // Prefer exact match, then first band that contains the context midpoint.
    const mid = (ctxBottom + ctxTop) / 2;

    let bestIdx = 0;
    for (let i = 0; i < this._floors.length; i++) {
      const f = this._floors[i];
      if (f.elevationMin === ctxBottom && f.elevationMax === ctxTop) {
        return i; // Exact match
      }
      if (mid >= f.elevationMin && mid <= f.elevationMax) {
        bestIdx = i;
      }
    }
    return bestIdx;
  }
}
