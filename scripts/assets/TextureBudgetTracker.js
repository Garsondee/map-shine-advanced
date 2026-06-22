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

/** Once downscale engages, it only releases below (threshold - margin) — anti-flap. */
const DOWNSCALE_RELEASE_MARGIN = 0.15;
/** Minimum time downscale must stay engaged before it may release (ms). */
const DOWNSCALE_MIN_DWELL_MS = 4000;

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

    /** @type {number} Effective budget ceiling in bytes (policy base + adaptive bonus) */
    this.budgetBytes = Math.max(1, (options.budgetMB ?? 512)) * 1024 * 1024;

    /** @type {number} Policy-derived base budget (before adaptive bonus). */
    this._policyBudgetBytes = this.budgetBytes;

    /** @type {number} Extra budget granted by the adaptive controller on stable high-VRAM GPUs. */
    this._adaptiveBonusBytes = 0;

    /** @type {boolean} Sticky downscale state (hysteresis). */
    this._downscaleEngaged = false;

    /** @type {number} performance.now() of the last downscale state change. */
    this._lastDownscaleChangeMs = 0;

    /** @type {number} Fraction at which eviction triggers (default 0.8 = 80%) */
    this.evictThreshold = options.evictThreshold ?? 0.8;

    /** @type {number} Fraction at which downscaling triggers (default 0.8 = 80%) */
    this.downscaleThreshold = options.downscaleThreshold ?? 0.8;

    /** @type {number} Monotonic counter for eviction ordering */
    this._evictSeq = 0;

    /** @type {Array<(tracker: TextureBudgetTracker) => number>} */
    this._evictionHandlers = [];

    /** @type {number} Recommended streaming cell size (world px) */
    this.cellSize = 1024;

    /** @type {number} Max LOD level for tile pyramids */
    this.maxLod = 4;

    /** @type {number} Mask compositor resolution scale (0..1) */
    this.maskResolutionScale = 1.0;

    /** @type {number} Max single background decode dimension */
    this.backgroundMaxSize = 8192;

    /** @type {number} Max single bus-tile albedo decode dimension */
    this.tileAlbedoMaxSize = 4096;

    /** @type {number} GPU maxTextureSize snapshot */
    this.maxTextureSize = 8192;

    /** @type {string} Human-readable reason for the active budget cap */
    this.budgetReason = 'default';

    /** @type {number} */
    this._lastEnforceMs = 0;

    log.debug(`TextureBudgetTracker created — budget: ${(this.budgetBytes / 1024 / 1024).toFixed(0)} MB`);
  }

  /**
   * Apply policy from computeTextureBudgetPolicy().
   * @param {import('../streaming/texture-budget-policy.js').TextureBudgetPolicy} policy
   */
  configureFromPolicy(policy) {
    if (!policy) return;
    this._policyBudgetBytes = Math.max(64, policy.budgetMB ?? 512) * 1024 * 1024;
    this._recomputeBudget();
    this.cellSize = policy.cellSize ?? this.cellSize;
    this.maxLod = policy.maxLod ?? this.maxLod;
    this.maskResolutionScale = policy.maskResolutionScale ?? 1.0;
    this.backgroundMaxSize = policy.backgroundMaxSize ?? this.backgroundMaxSize;
    this.tileAlbedoMaxSize = policy.tileAlbedoMaxSize ?? this.tileAlbedoMaxSize;
    this.maxTextureSize = policy.maxTextureSize ?? this.maxTextureSize;
    this.budgetReason = policy.budgetReason ?? this.budgetReason;
    log.info(
      `TextureBudgetTracker configured — ${(this.budgetBytes / 1024 / 1024).toFixed(0)} MB (${this.budgetReason}), `
      + `cell=${this.cellSize}, maskScale=${this.maskResolutionScale.toFixed(2)}`,
    );
  }

  /** @private */
  _recomputeBudget() {
    this.budgetBytes = Math.max(64 * 1024 * 1024, this._policyBudgetBytes + this._adaptiveBonusBytes);
  }

  /**
   * Grant (or clear) extra budget headroom on top of the policy base. The adaptive
   * controller raises this on stable high-VRAM GPUs so the software cap stops
   * forcing downscale churn, and drops it to 0 on crash / unexpected growth.
   * @param {number} mb
   */
  setAdaptiveBonusMB(mb) {
    const bytes = Math.max(0, Number(mb) || 0) * 1024 * 1024;
    if (bytes === this._adaptiveBonusBytes) return;
    this._adaptiveBonusBytes = bytes;
    this._recomputeBudget();
  }

  /** @returns {number} */
  getAdaptiveBonusMB() {
    return Math.round(this._adaptiveBonusBytes / (1024 * 1024));
  }

  /** @returns {number} */
  getPolicyBudgetMB() {
    return Math.round(this._policyBudgetBytes / (1024 * 1024));
  }

  /**
   * Register a global eviction handler invoked when over budget.
   * Handler should dispose GPU resources and return count evicted.
   * @param {(tracker: TextureBudgetTracker) => number} handler
   */
  addEvictionHandler(handler) {
    if (typeof handler === 'function' && !this._evictionHandlers.includes(handler)) {
      this._evictionHandlers.push(handler);
    }
  }

  /**
   * Remove a previously registered eviction handler.
   * @param {(tracker: TextureBudgetTracker) => number} handler
   */
  removeEvictionHandler(handler) {
    this._evictionHandlers = this._evictionHandlers.filter((h) => h !== handler);
  }

  /**
   * Run eviction handlers until under budget or handlers exhausted.
   * @returns {number} Total entries evicted
   */
  enforceBudget() {
    const now = performance.now();
    const frac = this.getUsedFraction();
    const minIntervalMs = frac > 2 ? 100 : 750;
    if (now - this._lastEnforceMs < minIntervalMs) return 0;
    if (!this.isOverBudget()) return 0;
    this._lastEnforceMs = now;
    let total = 0;
    for (const handler of this._evictionHandlers) {
      if (!this.isOverBudget()) break;
      try {
        total += Number(handler(this)) || 0;
      } catch (e) {
        log.warn('enforceBudget handler failed', e);
      }
    }
    return total;
  }

  /** @returns {number} */
  getRecommendedTileSize() {
    return this.cellSize;
  }

  /** @returns {number} */
  getMaxLodLevel() {
    return this.maxLod;
  }

  /** @returns {number} */
  getTileAlbedoMaxSize() {
    const base = this.tileAlbedoMaxSize ?? this.backgroundMaxSize ?? 4096;
    let max = Math.max(512, Math.floor(base * this.getDownscaleFactor()));
    if (!this.isOverBudget() && this.getUsedFraction() < 0.85) {
      max = Math.min(this.maxTextureSize ?? 8192, Math.max(max, 2048));
    }
    return max;
  }

  /** @returns {number} */
  getMaskResolutionScale() {
    const base = this.maskResolutionScale;
    return base * this.getDownscaleFactor();
  }

  /**
   * Stable mask resolution scale that ignores the volatile over-budget downscale
   * factor. Used for large cached data masks (outdoors/floorAlpha/skyReach/floorId)
   * so they don't oscillate in size as budget pressure fluctuates.
   * @returns {number}
   */
  getStableMaskResolutionScale() {
    return this.maskResolutionScale;
  }

  /**
   * Register a WebGLRenderTarget with automatic byte estimation.
   * @param {import('three').WebGLRenderTarget} rt
   * @param {string} label
   * @param {object} [options]
   */
  registerRenderTarget(rt, label, options = {}) {
    if (!rt) return;
    const w = rt.width ?? rt.texture?.image?.width ?? 0;
    const h = rt.height ?? rt.texture?.image?.height ?? 0;
    const fmt = rt.texture?.type === window.THREE?.FloatType ? 'float'
      : rt.texture?.type === window.THREE?.HalfFloatType ? 'halfFloat' : 'ubyte';
    const bytes = estimateTextureBytes(w, h, fmt);
    this.register(rt, label, bytes, { source: options.source ?? 'renderTarget', floorKey: options.floorKey ?? null });
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
   * P5-07: Returns 0.5 when VRAM is tight, 1.0 otherwise — used to halve mask /
   * tile-albedo resolution under pressure.
   *
   * Hysteresis: engages immediately at `downscaleThreshold` (protective), but only
   * releases once usage falls below `threshold - DOWNSCALE_RELEASE_MARGIN` AND it
   * has been engaged at least DOWNSCALE_MIN_DWELL_MS. This stops the 1.0<->0.5
   * oscillation that repeatedly purged + rebuilt masks at ~80% — a GPU work spike
   * right in the danger zone.
   * @returns {0.5|1.0}
   */
  getDownscaleFactor() {
    const frac = this.getUsedFraction();
    const now = performance.now();
    if (!this._downscaleEngaged) {
      if (frac >= this.downscaleThreshold) {
        this._downscaleEngaged = true;
        this._lastDownscaleChangeMs = now;
      }
    } else {
      const releaseAt = Math.max(0.4, this.downscaleThreshold - DOWNSCALE_RELEASE_MARGIN);
      const dwellOk = (now - this._lastDownscaleChangeMs) >= DOWNSCALE_MIN_DWELL_MS;
      if (frac <= releaseAt && dwellOk) {
        this._downscaleEngaged = false;
        this._lastDownscaleChangeMs = now;
      }
    }
    return this._downscaleEngaged ? 0.5 : 1.0;
  }

  /** @returns {boolean} Current sticky downscale state (for telemetry/UI). */
  isDownscaleEngaged() {
    return this._downscaleEngaged;
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
   * Returns tracked entry counts grouped by source category (for crash diagnostics).
   * @returns {Record<string, number>}
   */
  getSourceEntryCounts() {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const entry of this._entries.values()) {
      const src = entry.source ?? 'other';
      counts[src] = (counts[src] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Dispose — clears all tracking state (does NOT dispose GPU resources).
   */
  dispose() {
    this._entries.clear();
    this._usedBytes = 0;
    this._evictionHandlers = [];
  }
}

/**
 * Module-level singleton, created lazily on first access.
 * @type {TextureBudgetTracker|null}
 */
let _instance = null;

export function resolveTileAlbedoMaxSize(tracker = null) {
  const budget = tracker ?? getTextureBudgetTracker();
  if (typeof budget?.getTileAlbedoMaxSize === 'function') {
    return budget.getTileAlbedoMaxSize();
  }
  const base = budget?.tileAlbedoMaxSize ?? budget?.backgroundMaxSize ?? 4096;
  const factor = typeof budget?.getDownscaleFactor === 'function' ? budget.getDownscaleFactor() : 1;
  return Math.max(512, Math.floor(base * factor));
}

/** @returns {number} */
export function resolveRecommendedTileSize(tracker = null) {
  const budget = tracker ?? getTextureBudgetTracker();
  if (typeof budget?.getRecommendedTileSize === 'function') {
    return budget.getRecommendedTileSize();
  }
  return budget?.cellSize ?? 2048;
}

/**
 * @param {import('./TextureBudgetTracker.js').TextureBudgetTracker|null} [tracker]
 * @returns {import('./TextureBudgetTracker.js').BudgetState}
 */
export function resolveBudgetState(tracker = null) {
  const budget = tracker ?? getTextureBudgetTracker();
  if (typeof budget?.getBudgetState === 'function') {
    return budget.getBudgetState();
  }
  return {
    usedBytes: budget?._usedBytes ?? 0,
    budgetBytes: budget?.budgetBytes ?? 512 * 1024 * 1024,
    usedFraction: 0,
    overBudget: false,
    entryCount: 0,
    topEntries: [],
  };
}

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
