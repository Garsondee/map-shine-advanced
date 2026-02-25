/**
 * @fileoverview OutdoorsMaskProviderV2 — per-floor _Outdoors mask for V2.
 *
 * Discovers `_Outdoors` mask images on scene tiles, composites them into a
 * single scene-UV canvas texture per floor, and distributes the result to all
 * V2 systems that need it:
 *   - CloudEffectV2  → cloud shadow is gated to outdoor areas
 *   - WaterEffectV2  → wave/rain indoor damping
 *   - WeatherController → particle foam fleck roof gating
 *
 * ## Coordinate space
 * The composite canvas is authored in Foundry coordinate space (Y-down, top-left
 * origin).  Each tile is placed at its Foundry (x, y) position relative to the
 * scene rect.  The resulting `THREE.CanvasTexture` has `flipY = false` so the
 * GPU texture matches the Foundry orientation.
 *
 * Cloud shadow shader samples `tOutdoorsMask` using `vUv` (screen UV). Since
 * CloudEffectV2 renders fullscreen quads whose Y=0 maps to the TOP of the
 * viewport, this matches the Foundry Y-down canvas — no flip needed.
 *
 * WaterEffectV2 samples `tOutdoorsMask` via `sampleOutdoorsMask(worldSceneUv)`
 * which already applies `uOutdoorsMaskFlipY`. We set that uniform to 0.0 because
 * our canvas is already Y-down.
 *
 * ## Floor handling
 * The outdoors mask is per-floor (each floor can have different roof tiles).
 * On floor change, `onFloorChange(maxFloorIndex)` swaps to the best available
 * mask for that floor, falling back to floor 0 if no exact match exists.
 *
 * @module compositor-v2/effects/OutdoorsMaskProviderV2
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';

const log = createLogger('OutdoorsMaskProviderV2');

// Resolution of the composited outdoors mask texture.
// 1024 is sufficient — the mask is used for large-scale indoor/outdoor gating,
// not per-pixel precision features.
const MASK_RESOLUTION = 1024;

// ─── OutdoorsMaskProviderV2 ───────────────────────────────────────────────────

export class OutdoorsMaskProviderV2 {
  constructor() {
    /** @type {boolean} */
    this._populated = false;

    /**
     * Per-floor mask textures, keyed by floor index.
     * Value: THREE.CanvasTexture composited from all _Outdoors tiles on that floor.
     * @type {Map<number, THREE.Texture>}
     */
    this._floorMasks = new Map();

    /**
     * Per-floor raw HTMLCanvasElement used to build each CanvasTexture.
     * Kept alive so BuildingShadowsEffectV2 can union-composite them directly
     * via ctx.drawImage() without extracting from CanvasTexture internals.
     * Keyed by floor index (same keys as _floorMasks).
     * @type {Map<number, HTMLCanvasElement>}
     */
    this._floorCanvases = new Map();

    /**
     * The currently active mask texture (for the active floor).
     * Null if no _Outdoors tiles found on any floor.
     * @type {THREE.Texture|null}
     */
    this._activeMask = null;

    /** @type {number} Active floor index */
    this._activeFloorIndex = 0;

    /**
     * Registered consumer callbacks. Called whenever the active mask changes.
     * @type {Array<(tex: THREE.Texture|null) => void>}
     */
    this._consumers = [];
  }

  /**
   * Get the outdoors mask texture for an explicit floor index.
   * Returns null if that floor has no authored _Outdoors tiles.
   * @param {number} floorIndex
   * @returns {THREE.Texture|null}
   */
  getFloorTexture(floorIndex) {
    return this._floorMasks.get(Number(floorIndex) || 0) ?? null;
  }

  /**
   * Get the raw HTMLCanvasElement used to composite the outdoors mask for a
   * specific floor. Used by BuildingShadowsEffectV2 to union-composite multiple
   * floor canvases without extracting from CanvasTexture internals.
   * Returns null if that floor has no _Outdoors tiles or populate() hasn't run.
   * @param {number} floorIndex
   * @returns {HTMLCanvasElement|null}
   */
  getFloorCanvas(floorIndex) {
    return this._floorCanvases.get(Number(floorIndex) || 0) ?? null;
  }

  /**
   * Get a sorted list of floor indices that have an authored outdoors mask.
   * @returns {number[]}
   */
  getAvailableFloorIndices() {
    return Array.from(this._floorCanvases.keys()).sort((a, b) => a - b);
  }

  /**
   * Get the count of floors that have an _Outdoors mask.
   * @returns {number}
   */
  get floorCount() {
    return this._floorMasks.size;
  }

  /**
   * Get a fixed-length array of outdoors mask textures for floor indices [0..count-1].
   * Missing floors are returned as null.
   * @param {number} count
   * @returns {Array<THREE.Texture|null>}
   */
  getFloorTextureArray(count) {
    const n = Math.max(0, Math.min(32, Number(count) || 0));
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this._floorMasks.get(i) ?? null;
    return out;
  }

  // ── Public interface ────────────────────────────────────────────────────────

  /**
   * Current outdoors mask texture for the active floor.
   * Null if no _Outdoors masks were found.
   * @type {THREE.Texture|null}
   */
  get texture() { return this._activeMask; }

  /**
   * Current active floor index (as last set by populate() / onFloorChange()).
   * @returns {number}
   */
  get activeFloorIndex() { return this._activeFloorIndex ?? 0; }

  /**
   * Register a consumer callback that fires immediately with the current mask
   * and again whenever the active floor mask changes.
   * @param {(tex: THREE.Texture|null) => void} callback
   */
  subscribe(callback) {
    this._consumers.push(callback);
    // Fire immediately so the consumer gets the current state.
    try { callback(this._activeMask); } catch (_) {}
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Discover and composite all _Outdoors masks from the scene.
   * Call after FloorRenderBus.populate() so tile geometry is available.
   * @param {object} foundrySceneData - Scene geometry data from SceneComposer
   */
  async populate(foundrySceneData) {
    // Dispose previous state on re-populate
    this._disposeAll();

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    if (tileDocs.length === 0) {
      log.info('OutdoorsMaskProviderV2: no tiles in scene');
      this._notifyConsumers();
      return;
    }

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];

    // ── Step 1: Discover _Outdoors masks ─────────────────────────────────
    const tileEntries = [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      const result = await probeMaskFile(basePath, '_Outdoors');
      if (!result?.path) continue;

      tileEntries.push({
        tileDoc,
        maskPath: result.path,
        floorIndex: this._resolveFloorIndex(tileDoc, floors),
      });
    }

    if (tileEntries.length === 0) {
      log.info('OutdoorsMaskProviderV2: no _Outdoors masks found in scene');
      this._populated = true;
      this._notifyConsumers();
      return;
    }
    log.info(`OutdoorsMaskProviderV2: found ${tileEntries.length} _Outdoors mask(s)`,
      tileEntries.map(e => e.maskPath));

    // ── Step 2: Group by floor ────────────────────────────────────────────
    /** @type {Map<number, Array>} */
    const byFloor = new Map();
    for (const entry of tileEntries) {
      let arr = byFloor.get(entry.floorIndex);
      if (!arr) { arr = []; byFloor.set(entry.floorIndex, arr); }
      arr.push(entry);
    }

    try {
      const summary = Array.from(byFloor.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([fi, arr]) => `${fi}:${arr.length}`)
        .join(', ');
      log.debug(`OutdoorsMaskProviderV2: byFloor mask counts [${summary}]`);
    } catch (_) {}

    // ── Step 3: Composite per-floor mask textures ─────────────────────────
    const sceneRect = canvas?.dimensions?.sceneRect ?? canvas?.dimensions;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width ?? sceneRect?.sceneWidth ?? 1;
    const sceneH = sceneRect?.height ?? sceneRect?.sceneHeight ?? 1;

    for (const [floorIndex, entries] of byFloor) {
      try {
        const result = await this._compositeFloorMask(entries, { sceneX, sceneY, sceneW, sceneH });
        if (result) {
          this._floorMasks.set(floorIndex, result.tex);
          this._floorCanvases.set(floorIndex, result.canvas);
        }
      } catch (err) {
        log.error(`OutdoorsMaskProviderV2: floor ${floorIndex} composite failed:`, err);
      }
    }

    // ── Step 4: Activate the current floor ───────────────────────────────
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor();
    this._activeFloorIndex = activeFloor?.index ?? 0;
    this._activeMask = this._pickMask(this._activeFloorIndex);

    this._populated = true;
    log.info(`OutdoorsMaskProviderV2 populated: ${this._floorMasks.size} floor mask(s), active floor ${this._activeFloorIndex}`);
    this._notifyConsumers();
  }

  /**
   * Switch to the best-available outdoors mask for the given maximum floor index.
   * Mirrors WaterEffectV2.onFloorChange() logic.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._populated) return;
    const prev = this._activeMask;
    this._activeFloorIndex = maxFloorIndex;
    this._activeMask = this._pickMask(maxFloorIndex);
    if (this._activeMask !== prev) {
      log.info(`OutdoorsMaskProviderV2: floor change → index ${maxFloorIndex}, mask ${this._activeMask ? 'present' : 'absent'}`);
      this._notifyConsumers();
    }
  }

  /** Dispose all GPU resources and reset state. */
  dispose() {
    this._disposeAll();
    this._consumers = [];
    log.info('OutdoorsMaskProviderV2 disposed');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Pick the best mask for the requested floor — highest floor index ≤ maxFloorIndex.
   * Falls back to floor 0 if no exact match.
   * @param {number} maxFloorIndex
   * @returns {THREE.Texture|null}
   * @private
   */
  _pickMask(maxFloorIndex) {
    if (this._floorMasks.size === 0) return null;
    let best = -1;
    for (const idx of this._floorMasks.keys()) {
      if (idx <= maxFloorIndex && idx > best) best = idx;
    }
    if (best >= 0) return this._floorMasks.get(best) ?? null;
    // Fallback: floor 0
    return this._floorMasks.get(0) ?? null;
  }

  /** @private */
  _notifyConsumers() {
    for (const cb of this._consumers) {
      try { cb(this._activeMask); } catch (_) {}
    }
  }

  /** @private */
  _disposeAll() {
    for (const tex of this._floorMasks.values()) {
      try { tex.dispose(); } catch (_) {}
    }
    this._floorMasks.clear();
    // Canvas elements are just DOM objects — no GPU disposal needed,
    // but we clear the map so GC can reclaim them.
    this._floorCanvases.clear();
    this._activeMask = null;
    this._populated = false;
  }

  /**
   * Composite _Outdoors mask images for all tiles on one floor into a single
   * scene-UV canvas, then wrap in a THREE.CanvasTexture.
   *
   * Canvas origin is top-left (Foundry Y-down). flipY=false so the GPU texture
   * orientation matches the Foundry scene coordinate space used by all consumers.
   *
   * @param {Array} entries - [{ tileDoc, maskPath, floorIndex }]
   * @param {{ sceneX, sceneY, sceneW, sceneH }} sceneGeo
   * @returns {Promise<THREE.Texture|null>}
   * @private
   */
  async _compositeFloorMask(entries, { sceneX, sceneY, sceneW, sceneH }) {
    const THREE = window.THREE;
    if (!THREE) return null;

    // Load all mask images in parallel
    const loadImg = (url) => new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = () => { log.warn(`_compositeFloorMask: failed to load ${url}`); resolve(null); };
      img.src = url;
    });

    const images = await Promise.all(entries.map(e => loadImg(e.maskPath)));

    const validPairs = [];
    for (let i = 0; i < entries.length; i++) {
      if (images[i]) validPairs.push({ entry: entries[i], img: images[i] });
    }
    if (validPairs.length === 0) {
      log.warn('_compositeFloorMask: all mask images failed to load');
      return null;
    }

    // Canvas resolution proportional to scene aspect, capped at MASK_RESOLUTION.
    const aspect = sceneW / Math.max(1, sceneH);
    let cvW, cvH;
    if (aspect >= 1) {
      cvW = MASK_RESOLUTION;
      cvH = Math.max(4, Math.round(MASK_RESOLUTION / aspect));
    } else {
      cvH = MASK_RESOLUTION;
      cvW = Math.max(4, Math.round(MASK_RESOLUTION * aspect));
    }

    const cv = document.createElement('canvas');
    cv.width  = cvW;
    cv.height = cvH;
    const ctx = cv.getContext('2d', { willReadFrequently: false });
    if (!ctx) { log.warn('_compositeFloorMask: 2D context unavailable'); return null; }
    // Keep ctx.globalCompositeOperation as 'source-over' for tile drawing.

    // Fill with black (= fully indoors). Outdoors tiles paint white (= outdoors).
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cvW, cvH);

    for (const { entry, img } of validPairs) {
      const td = entry.tileDoc;
      const tileW = td.width  ?? 0;
      const tileH = td.height ?? 0;
      if (tileW <= 0 || tileH <= 0) continue;

      const tileX = td.x ?? 0;
      const tileY = td.y ?? 0;

      // Map tile Foundry rect → canvas pixel rect (Y-down, matching Foundry)
      const px = ((tileX - sceneX) / sceneW) * cvW;
      const py = ((tileY - sceneY) / sceneH) * cvH;
      const pw = (tileW / sceneW) * cvW;
      const ph = (tileH / sceneH) * cvH;

      if (typeof td.rotation === 'number' && td.rotation !== 0) {
        const cx = px + pw / 2;
        const cy = py + ph / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((td.rotation * Math.PI) / 180);
        ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
      } else {
        ctx.drawImage(img, px, py, pw, ph);
      }
    }

    // Wrap in CanvasTexture — flipY=false keeps Foundry Y-down orientation.
    const tex = new THREE.CanvasTexture(cv);
    tex.flipY    = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    // Return both the texture and the raw canvas so callers can union-composite.
    return { tex, canvas: cv };
  }

  /**
   * Resolve the floor index for a tile document.
   * Matches the logic in WaterEffectV2 / SpecularEffectV2.
   * @param {object} tileDoc
   * @param {Array}  floors
   * @returns {number}
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      if (flags) {
        for (let i = 0; i < floors.length; i++) {
          const flr = floors[i];
          // FloorStack floors are FloorBand objects.
          // Use elevationMin/elevationMax (inclusive) to find the floor band.
          const bandMin = Number.isFinite(Number(flr?.elevationMin)) ? Number(flr.elevationMin) : (Number(flr?.elevation ?? flr?.rangeBottom) || 0);
          const bandMax = Number.isFinite(Number(flr?.elevationMax)) ? Number(flr.elevationMax) : (Number(flr?.rangeTop) || bandMin);
          // Prefer midpoint containment for stability.
          const rb = Number(flags.rangeBottom);
          const rt = Number(flags.rangeTop);
          const mid = (rb + rt) / 2;
          if (mid >= bandMin && mid <= bandMax) return i;
        }

        // Fallback: any overlap with the floor band.
        for (let i = 0; i < floors.length; i++) {
          const flr = floors[i];
          const bandMin = Number.isFinite(Number(flr?.elevationMin)) ? Number(flr.elevationMin) : (Number(flr?.elevation ?? flr?.rangeBottom) || 0);
          const bandMax = Number.isFinite(Number(flr?.elevationMax)) ? Number(flr.elevationMax) : (Number(flr?.rangeTop) || bandMin);
          const rb = Number(flags.rangeBottom);
          const rt = Number(flags.rangeTop);
          if (rb <= bandMax && bandMin <= rt) return i;
        }
      }
    }

    // No Levels range flags: use tile elevation to find the floor band.
    // This matches the FloorStack/FloorLayerManager fallback logic.
    const elevRaw = tileDoc?.elevation ?? tileDoc?.document?.elevation ?? 0;
    const elev = Number.isFinite(Number(elevRaw)) ? Number(elevRaw) : 0;
    for (let i = 0; i < floors.length; i++) {
      const flr = floors[i];
      const bandMin = Number.isFinite(Number(flr?.elevationMin)) ? Number(flr.elevationMin) : (Number(flr?.elevation ?? flr?.rangeBottom) || 0);
      const bandMax = Number.isFinite(Number(flr?.elevationMax)) ? Number(flr.elevationMax) : (Number(flr?.rangeTop) || bandMin);
      if (elev >= bandMin && elev <= bandMax) return i;
    }

    return 0;
  }
}
