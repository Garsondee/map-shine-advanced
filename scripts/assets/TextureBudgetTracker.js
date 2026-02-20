/**
 * @fileoverview TextureBudgetTracker — P5-01 to P5-07
 *
 * Tracks allocated texture VRAM by source, enforces an 80% budget ceiling,
 * and provides a resolution downscaling fallback when the budget is exceeded.
 *
 * Architecture:
 * - Every WebGLRenderTarget and mask texture calls register() on allocation
 *   and unregister() on dispose.
 * - getBudgetState() returns a snapshot used by the Tweakpane debug panel.
 * - evictStaleFloorCaches() is called by TileManager when budget > 80%.
 * - getDownscaleFactor() returns 0.5 when budget > 80%, 1.0 otherwise.
 *
 * @module assets/TextureBudgetTracker
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TextureBudgetTracker');

/**
 * Estimate bytes for a WebGLRenderTarget or texture given its dimensions and format.
 * Defaults to RGBA HalfFloat (8 bytes/pixel) for render targets, RGBA UByte (4 bytes/pixel)
 * for data/color textures.
 *
 * @param {number} width
 * @param {number} height
 * @param {'halfFloat'|'ubyte'|'float'} [pixelFormat='halfFloat']
 * @param {number} [channels=4]
 * @returns {number} Estimated bytes
 */
export function estimateTextureBytes(width, height, pixelFormat = 'halfFloat', channels = 4) {
  const bytesPerChannel = pixelFormat === 'float' ? 4 : pixelFormat === 'halfFloat' ? 2 : 1;
  return Math.max(1, width) * Math.max(1, height) * channels * bytesPerChannel;
}

/**
 * @typedef {Object} TrackedEntry
 * @property {string} label - Human-readable label for debug UI
 * @property {string} source - Category: 'renderTarget'|'tileMask'|'sceneMask'|'other'
 * @property {number} sizeBytes - Estimated VRAM bytes
 * @property {number} registeredAt - performance.now() timestamp
 * @property {string|null} floorKey - "${bottom}:${top}" if floor-specific, else null
 */

/**
 * @typedef {Object} BudgetState
 * @property {number} usedBytes - Total tracked VRAM bytes
 * @property {number} budgetBytes - Configured VRAM budget in bytes
 * @property {number} usedFraction - usedBytes / budgetBytes (0..1+)
 * @property {boolean} overBudget - true when usedFraction >= 0.8
 * @property {number} entryCount - Number of tracked entries
 * @property {Array<{label: string, source: string, sizeBytes: number}>} topEntries - Top 10 by size
 */

export class TextureBudgetTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.budgetMB=512] - VRAM budget in megabytes
   * @param {number} [options.evictThreshold=0.8] - Fraction at which eviction triggers
   * @param {number} [options.downscaleThreshold=0.8] - Fraction at which downscaling triggers
   */
  constructor(options = {}) {
    /** @type {Map<object, TrackedEntry>} Key is the texture/RT object reference */
    this._entries = new Map();

    /** @type {number} Total tracked bytes */
    this._usedBytes = 0;

    /** @type {number} Budget ceiling in bytes */
    this.budgetBytes = Math.max(1, (options.budgetMB ?? 512)) * 1024 * 1024;

    /** @type {number} Fraction at which eviction triggers (default 0.8 = 80%) */
    this.evictThreshold = options.evictThreshold ?? 0.8;

    /** @type {number} Fraction at which downscaling triggers (default 0.8 = 80%) */
    this.downscaleThreshold = options.downscaleThreshold ?? 0.8;

    /** @type {number} Monotonic counter for eviction ordering */
    this._evictSeq = 0;

    log.debug(`TextureBudgetTracker created — budget: ${(this.budgetBytes / 1024 / 1024).toFixed(0)} MB`);
  }

  // ── Registration API ──────────────────────────────────────────────────────

  /**
   * P5-02: Register a texture or render target.
   * @param {object} textureOrRT - THREE.Texture or THREE.WebGLRenderTarget
   * @param {string} label - Human-readable label (e.g. 'LightingEffect.lightTarget')
   * @param {number} sizeBytes - Estimated VRAM bytes
   * @param {object} [options]
   * @param {string} [options.source='other'] - Category for grouping in debug UI
   * @param {string|null} [options.floorKey=null] - Floor key if floor-specific
   */
  register(textureOrRT, label, sizeBytes, options = {}) {
    if (!textureOrRT || typeof sizeBytes !== 'number' || sizeBytes < 0) return;

    // If already registered, update the entry (e.g. resize).
    if (this._entries.has(textureOrRT)) {
      const existing = this._entries.get(textureOrRT);
      this._usedBytes -= existing.sizeBytes;
      existing.sizeBytes = sizeBytes;
      existing.label = label;
      this._usedBytes += sizeBytes;
      return;
    }

    /** @type {TrackedEntry} */
    const entry = {
      label,
      source: options.source ?? 'other',
      sizeBytes,
      registeredAt: performance.now(),
      floorKey: options.floorKey ?? null,
      _seq: this._evictSeq++
    };

    this._entries.set(textureOrRT, entry);
    this._usedBytes += sizeBytes;

    log.debug(`register: "${label}" ${(sizeBytes / 1024).toFixed(1)} KB (total: ${(this._usedBytes / 1024 / 1024).toFixed(1)} MB)`);
  }

  /**
   * P5-03: Unregister a texture or render target (called on dispose).
   * @param {object} textureOrRT
   */
  unregister(textureOrRT) {
    if (!textureOrRT) return;
    const entry = this._entries.get(textureOrRT);
    if (!entry) return;
    this._usedBytes = Math.max(0, this._usedBytes - entry.sizeBytes);
    this._entries.delete(textureOrRT);
    log.debug(`unregister: "${entry.label}" freed ${(entry.sizeBytes / 1024).toFixed(1)} KB`);
  }

  // ── Budget Queries ────────────────────────────────────────────────────────

  /**
   * @returns {number} Current used fraction (0..1+)
   */
  getUsedFraction() {
    return this._usedBytes / Math.max(1, this.budgetBytes);
  }

  /**
   * @returns {boolean} True when used fraction >= evictThreshold
   */
  isOverBudget() {
    return this.getUsedFraction() >= this.evictThreshold;
  }

  /**
   * P5-07: Returns 0.5 when over the downscale threshold, 1.0 otherwise.
   * Callers use this to halve visual mask resolution when VRAM is tight.
   * @returns {0.5|1.0}
   */
  getDownscaleFactor() {
    return this.getUsedFraction() >= this.downscaleThreshold ? 0.5 : 1.0;
  }

  /**
   * P5-06: Evict oldest non-active floor cache entries when over budget.
   * Calls the provided callback for each entry to evict; the callback is
   * responsible for actually disposing the texture and clearing the cache.
   *
   * @param {string|null} activeFloorKey - The currently active floor key (never evict this)
   * @param {function(object, TrackedEntry): void} onEvict - Called with (textureOrRT, entry)
   * @returns {number} Number of entries evicted
   */
  evictStaleFloorCaches(activeFloorKey, onEvict) {
    if (!this.isOverBudget()) return 0;
    if (typeof onEvict !== 'function') return 0;

    // Collect floor-specific entries that are NOT the active floor,
    // sorted oldest-first (lowest _seq).
    const candidates = [];
    for (const [ref, entry] of this._entries) {
      if (entry.floorKey && entry.floorKey !== activeFloorKey) {
        candidates.push({ ref, entry });
      }
    }
    candidates.sort((a, b) => a.entry._seq - b.entry._seq);

    let evicted = 0;
    for (const { ref, entry } of candidates) {
      if (!this.isOverBudget()) break;
      try {
        onEvict(ref, entry);
      } catch (e) {
        log.warn(`evict callback failed for "${entry.label}"`, e);
      }
      // onEvict is expected to call unregister() — but guard in case it doesn't.
      if (this._entries.has(ref)) {
        this.unregister(ref);
      }
      evicted++;
    }

    if (evicted > 0) {
      log.info(`Evicted ${evicted} stale floor cache entries. Budget: ${(this.getUsedFraction() * 100).toFixed(1)}%`);
    }
    return evicted;
  }

  // ── Debug / Metrics ───────────────────────────────────────────────────────

  /**
   * Returns a snapshot of the current budget state for the Tweakpane debug panel.
   * @returns {BudgetState}
   */
  getBudgetState() {
    const usedFraction = this.getUsedFraction();
    const entries = Array.from(this._entries.values());
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
    const topEntries = entries.slice(0, 10).map(e => ({
      label: e.label,
      source: e.source,
      sizeBytes: e.sizeBytes
    }));

    return {
      usedBytes: this._usedBytes,
      budgetBytes: this.budgetBytes,
      usedFraction,
      overBudget: usedFraction >= this.evictThreshold,
      entryCount: this._entries.size,
      topEntries
    };
  }

  /**
   * Returns per-source totals for the debug panel.
   * @returns {Object<string, number>} Map of source → total bytes
   */
  getSourceBreakdown() {
    const breakdown = {};
    for (const entry of this._entries.values()) {
      breakdown[entry.source] = (breakdown[entry.source] ?? 0) + entry.sizeBytes;
    }
    return breakdown;
  }

  /**
   * Dispose — clears all tracking state (does NOT dispose GPU resources).
   */
  dispose() {
    this._entries.clear();
    this._usedBytes = 0;
  }
}

/**
 * Module-level singleton, created lazily on first access.
 * @type {TextureBudgetTracker|null}
 */
let _instance = null;

/**
 * Get or create the global TextureBudgetTracker singleton.
 * @param {object} [options] - Passed to constructor on first creation only
 * @returns {TextureBudgetTracker}
 */
export function getTextureBudgetTracker(options) {
  if (!_instance) {
    _instance = new TextureBudgetTracker(options);
  }
  return _instance;
}

/**
 * Replace the singleton (used in tests or for reconfiguration).
 * @param {TextureBudgetTracker|null} instance
 */
export function setTextureBudgetTracker(instance) {
  _instance = instance;
}
