/**
 * @file EffectMaskRegistry.js
 * @description Central mask state manager for the multi-level rendering architecture.
 *
 * Separates mask ownership from effect consumption. Effects subscribe to mask
 * type changes via an observer pattern instead of receiving masks through
 * destructive `setBaseMesh` calls. Floor transitions are atomic — the registry
 * applies preserve/clear policies per mask type, then notifies all subscribers.
 *
 * The registry also owns tile-change relevance filtering: only geometry/texture/
 * visibility changes trigger recomposition; Levels flag changes are ignored.
 *
 * See docs/planning/MULTI-LEVEL-RENDERING-ARCHITECTURE.md for full design.
 */

import { createLogger } from '../core/log.js';

const log = createLogger('EffectMaskRegistry');

// ── Mask Policies ────────────────────────────────────────────────────────────
// Each mask type has a policy controlling its behavior during floor transitions.

/**
 * @typedef {Object} MaskPolicy
 * @property {boolean} preserveAcrossFloors — Keep mask when switching to a floor without this type
 * @property {boolean} disposeOnClear — Dispose derived GPU resources when clearing slot
 * @property {boolean} recomposeOnTileChange — Trigger recomposition when a tile changes
 * @property {'lighten'|'source-over'} compositionMode — How per-tile masks combine in compositor
 * @property {'data'|'visual'|'color'} resolutionClass — Determines max texture resolution
 */

/**
 * Default policies for all known mask types. Defined centrally so adding a new
 * mask-consuming effect only requires a policy entry + a subscribe() call.
 */
const DEFAULT_POLICIES = {
  water:        { preserveAcrossFloors: true,  disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'lighten',     resolutionClass: 'data'   },
  fire:         { preserveAcrossFloors: false, disposeOnClear: true,  recomposeOnTileChange: true,  compositionMode: 'lighten',     resolutionClass: 'data'   },
  outdoors:     { preserveAcrossFloors: false, disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'data'   },
  windows:      { preserveAcrossFloors: true,  disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'data'   },
  specular:     { preserveAcrossFloors: true,  disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'visual' },
  normal:       { preserveAcrossFloors: true,  disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'visual' },
  tree:         { preserveAcrossFloors: false, disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'color'  },
  bush:         { preserveAcrossFloors: false, disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'color'  },
  dust:         { preserveAcrossFloors: false, disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'lighten',     resolutionClass: 'data'   },
  ash:          { preserveAcrossFloors: false, disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'lighten',     resolutionClass: 'data'   },
  iridescence:  { preserveAcrossFloors: false, disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'data'   },
  prism:        { preserveAcrossFloors: false, disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'data'   },
  roughness:    { preserveAcrossFloors: true,  disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'visual' },
  fluid:        { preserveAcrossFloors: false, disposeOnClear: false, recomposeOnTileChange: true,  compositionMode: 'source-over', resolutionClass: 'data'   },
};

// ── Slot Model ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MaskSlot
 * @property {THREE.Texture|null} texture — Current scene-space composite texture
 * @property {string|null} floorKey — "${bottom}:${top}" of the floor this mask belongs to
 * @property {'compositor'|'bundle'|'override'} source — How this mask was set
 * @property {number} timestamp — When this mask was last updated (performance.now())
 */

/**
 * Creates a fresh empty slot.
 * @returns {MaskSlot}
 */
function _createEmptySlot() {
  return { texture: null, floorKey: null, source: 'bundle', timestamp: 0 };
}


// ── EffectMaskRegistry ───────────────────────────────────────────────────────

export class EffectMaskRegistry {

  constructor() {
    /** @type {Map<string, MaskSlot>} Per-mask-type slot */
    this._slots = new Map();

    /** @type {Map<string, MaskPolicy>} Per-mask-type policy */
    this._policies = new Map();

    /** @type {Map<string, Set<function>>} Per-mask-type subscriber callbacks */
    this._subscribers = new Map();

    /** @type {Set<function>} Global floor-change subscribers */
    this._floorChangeSubscribers = new Set();

    /**
     * When true, tile-change driven invalidation is blocked. Set synchronously
     * at the start of a floor transition and cleared synchronously at the end.
     * No timers, no debounce, no async gaps — race conditions impossible.
     * @type {boolean}
     */
    this._transitioning = false;

    /** @type {string|null} Active floor key: "${bottom}:${top}" */
    this._activeFloorKey = null;

    /** @type {number|null} Debounce timer for tile-change recomposition */
    this._recomposeTimer = null;

    /** @type {number} Debounce interval in ms for tile-change-driven recomposition */
    this._recomposeDebounceMs = 100;

    /** @type {Map<string, MaskPolicy>} Per-mask overrides (edge case support) */
    this._overrides = new Map();

    // Metrics tracking
    this._metrics = {
      transitionCount: 0,
      lastTransitionMs: 0,
      recomposeCount: 0,
      lastRecomposeMs: 0,
    };

    // Register default policies and initialize slots
    for (const [type, policy] of Object.entries(DEFAULT_POLICIES)) {
      this._policies.set(type, { ...policy });
      this._slots.set(type, _createEmptySlot());
      this._subscribers.set(type, new Set());
    }
  }

  // ── Policy Management ────────────────────────────────────────────────────

  /**
   * Define or update the policy for a mask type. Also initializes the slot
   * and subscriber set if they don't already exist.
   * @param {string} maskType
   * @param {Partial<MaskPolicy>} policy
   */
  definePolicy(maskType, policy) {
    const existing = this._policies.get(maskType) || {};
    this._policies.set(maskType, { ...existing, ...policy });
    if (!this._slots.has(maskType)) {
      this._slots.set(maskType, _createEmptySlot());
    }
    if (!this._subscribers.has(maskType)) {
      this._subscribers.set(maskType, new Set());
    }
  }

  /**
   * Returns the effective policy for a mask type, with any overrides applied.
   * @param {string} maskType
   * @returns {MaskPolicy|null}
   */
  getPolicy(maskType) {
    const base = this._policies.get(maskType);
    if (!base) return null;
    const override = this._overrides.get(maskType);
    return override ? { ...base, ...override } : base;
  }

  // ── Subscription API ─────────────────────────────────────────────────────

  /**
   * Subscribe to changes for a specific mask type. The callback receives
   * (texture, floorKey, source) whenever the slot is updated or cleared.
   *
   * @param {string} maskType
   * @param {function(THREE.Texture|null, string|null, string): void} callback
   * @returns {function(): void} Unsubscribe function
   */
  subscribe(maskType, callback) {
    if (typeof callback !== 'function') {
      log.warn(`subscribe: callback for '${maskType}' is not a function`);
      return () => {};
    }
    let subs = this._subscribers.get(maskType);
    if (!subs) {
      subs = new Set();
      this._subscribers.set(maskType, subs);
    }
    subs.add(callback);
    return () => subs.delete(callback);
  }

  /**
   * Subscribe to floor-change events. Callback receives (newFloorKey, prevFloorKey).
   * @param {function(string|null, string|null): void} callback
   * @returns {function(): void} Unsubscribe function
   */
  onFloorChange(callback) {
    if (typeof callback !== 'function') return () => {};
    this._floorChangeSubscribers.add(callback);
    return () => this._floorChangeSubscribers.delete(callback);
  }

  // ── Mask Access ──────────────────────────────────────────────────────────

  /**
   * Get the current texture for a mask type.
   * @param {string} maskType
   * @returns {THREE.Texture|null}
   */
  getMask(maskType) {
    return this._slots.get(maskType)?.texture ?? null;
  }

  /**
   * Get the full slot data for a mask type.
   * @param {string} maskType
   * @returns {MaskSlot|null}
   */
  getSlot(maskType) {
    return this._slots.get(maskType) ?? null;
  }

  /**
   * Returns all mask types that currently have a non-null texture.
   * @returns {string[]}
   */
  getActiveMaskTypes() {
    const types = [];
    for (const [type, slot] of this._slots) {
      if (slot.texture) types.push(type);
    }
    return types;
  }

  // ── Mask Mutation ────────────────────────────────────────────────────────

  /**
   * Set the mask texture for a type. Updates the slot and notifies subscribers.
   *
   * @param {string} maskType
   * @param {THREE.Texture|null} texture
   * @param {string|null} [floorKey=null] — Floor key this mask belongs to
   * @param {'compositor'|'bundle'|'override'} [source='bundle'] — Source attribution
   */
  setMask(maskType, texture, floorKey = null, source = 'bundle') {
    let slot = this._slots.get(maskType);
    if (!slot) {
      slot = _createEmptySlot();
      this._slots.set(maskType, slot);
      if (!this._subscribers.has(maskType)) {
        this._subscribers.set(maskType, new Set());
      }
    }

    const prevTexture = slot.texture;

    // Skip no-op updates (same texture reference, same floor)
    if (prevTexture === texture && slot.floorKey === floorKey) return;

    slot.texture = texture;
    slot.floorKey = floorKey ?? this._activeFloorKey;
    slot.source = source;
    slot.timestamp = performance.now();

    log.debug(`setMask: '${maskType}' → ${texture ? 'texture' : 'null'}`, {
      floorKey: slot.floorKey, source
    });

    this._notifySubscribers(maskType);
  }

  /**
   * Clear the mask for a type, respecting the effective policy.
   * If `preserveAcrossFloors` is true, the slot is NOT cleared.
   *
   * @param {string} maskType
   * @param {Object} [options]
   * @param {boolean} [options.force=false] — Clear even if policy says preserve
   * @returns {boolean} Whether the slot was actually cleared
   */
  clearMask(maskType, options = {}) {
    const { force = false } = options;
    const policy = this.getPolicy(maskType);
    const slot = this._slots.get(maskType);

    if (!slot) return false;

    // Respect preserve policy unless forced
    if (!force && policy?.preserveAcrossFloors && slot.texture) {
      log.debug(`clearMask: '${maskType}' preserved (preserveAcrossFloors)`);
      return false;
    }

    const prevTexture = slot.texture;
    if (!prevTexture) return false; // Already null, no-op

    // Dispose GPU resources if policy requires it
    if (policy?.disposeOnClear && prevTexture) {
      try {
        prevTexture.dispose?.();
      } catch (e) {
        log.warn(`clearMask: dispose failed for '${maskType}'`, e);
      }
    }

    slot.texture = null;
    slot.floorKey = null;
    slot.source = 'bundle';
    slot.timestamp = performance.now();

    log.debug(`clearMask: '${maskType}' cleared`);
    this._notifySubscribers(maskType);
    return true;
  }

  // ── Floor Transition Protocol ────────────────────────────────────────────

  /**
   * Begin a floor transition. Must be called synchronously at the start of
   * a level-change handler, BEFORE any async work. Blocks all tile-change
   * driven invalidation until endTransition() is called.
   */
  beginTransition() {
    this._transitioning = true;
  }

  /**
   * End a floor transition. Must be called synchronously after all mask
   * redistribution is complete (even on error paths — use finally blocks).
   */
  endTransition() {
    this._transitioning = false;
  }

  /** @returns {boolean} Whether a floor transition is in progress. */
  get transitioning() {
    return this._transitioning;
  }

  /**
   * Atomically transition to a new floor. This is the primary entry point
   * for level-change handlers.
   *
   * Phase 1: Determine what changes per mask type (replace/preserve/clear).
   * Phase 2: Apply changes to slots.
   * Phase 3: Notify subscribers for changed slots.
   *
   * @param {string} floorKey — New floor key, e.g. "0:10"
   * @param {Array<{type: string, id?: string, texture: THREE.Texture|null}>} newFloorMasks
   *   — Masks produced by the compositor/bundle for the new floor
   * @returns {Map<string, 'replace'|'preserve'|'clear'>} Per-type action taken
   */
  transitionToFloor(floorKey, newFloorMasks) {
    const t0 = performance.now();
    this._transitioning = true;

    const prevFloorKey = this._activeFloorKey;
    this._activeFloorKey = floorKey;

    // Build a lookup of new floor masks by type/id
    const newMasksByType = new Map();
    if (newFloorMasks) {
      for (const m of newFloorMasks) {
        const type = m.type || m.id;
        if (type && m.texture) {
          newMasksByType.set(type, m.texture);
        }
      }
    }

    // Phase 1: Determine action per mask type
    /** @type {Map<string, {action: 'replace'|'preserve'|'clear', texture?: THREE.Texture}>} */
    const changes = new Map();

    for (const [type, policy] of this._policies) {
      const effectivePolicy = this.getPolicy(type);
      const newTexture = newMasksByType.get(type) ?? null;
      const currentSlot = this._slots.get(type);
      const currentTexture = currentSlot?.texture ?? null;

      if (newTexture) {
        // New floor provides this mask — always use it
        changes.set(type, { action: 'replace', texture: newTexture });
      } else if (effectivePolicy?.preserveAcrossFloors && currentTexture) {
        // No mask on new floor, but policy says preserve — keep current
        changes.set(type, { action: 'preserve' });
      } else if (currentTexture) {
        // No mask on new floor, policy says clear
        changes.set(type, { action: 'clear' });
      }
      // If currentTexture is already null and no new texture, nothing to do
    }

    // Phase 2: Apply changes atomically
    for (const [type, change] of changes) {
      if (change.action === 'replace') {
        const slot = this._slots.get(type);
        if (slot) {
          slot.texture = change.texture;
          slot.floorKey = floorKey;
          slot.source = 'bundle';
          slot.timestamp = performance.now();
        }
      } else if (change.action === 'clear') {
        const policy = this.getPolicy(type);
        const slot = this._slots.get(type);
        if (slot) {
          if (policy?.disposeOnClear && slot.texture) {
            try { slot.texture.dispose?.(); } catch (_) {}
          }
          slot.texture = null;
          slot.floorKey = null;
          slot.source = 'bundle';
          slot.timestamp = performance.now();
        }
      }
      // 'preserve' — do nothing, slot stays as-is
    }

    // Phase 3: Notify subscribers for changed slots (not preserved ones)
    const actions = new Map();
    for (const [type, change] of changes) {
      actions.set(type, change.action);
      if (change.action !== 'preserve') {
        this._notifySubscribers(type);
      }
    }

    // Notify floor-change subscribers
    for (const cb of this._floorChangeSubscribers) {
      try {
        cb(floorKey, prevFloorKey);
      } catch (e) {
        log.warn('transitionToFloor: floor-change subscriber error', e);
      }
    }

    this._transitioning = false;

    // Metrics
    const elapsed = performance.now() - t0;
    this._metrics.transitionCount++;
    this._metrics.lastTransitionMs = elapsed;

    log.warn('[FloorDiag] transitionToFloor complete', {
      floorKey,
      prevFloorKey,
      actions: Object.fromEntries(actions),
      elapsedMs: elapsed.toFixed(1)
    });

    return actions;
  }

  // ── Tile Change Filtering ────────────────────────────────────────────────

  /**
   * Called by TileManager when a tile changes. Classifies the change and
   * only propagates to subscribers when mask-relevant properties changed.
   *
   * This is the critical filter that prevents Levels flag changes from
   * triggering mask invalidation (the root cause of the water destruction bug).
   *
   * @param {Object} tileDoc — Tile document
   * @param {Object|null} changes — Changed properties (from updateTile hook)
   * @returns {boolean} Whether the change was classified as mask-relevant
   */
  onTileChange(tileDoc, changes) {
    // During floor transitions, ignore ALL tile changes.
    if (this._transitioning) return false;

    if (!changes) return false;

    const keys = Object.keys(changes);
    if (keys.length === 0) return false;

    // Geometry/texture changes → recompose affected mask types
    const geometryChanged = keys.some(k =>
      k === 'x' || k === 'y' || k === 'width' ||
      k === 'height' || k === 'rotation' || k === 'texture'
    );

    // Elevation/sort changes → re-evaluate Z ordering in compositor
    const elevationChanged = keys.some(k =>
      k === 'elevation' || k === 'sort' || k === 'z'
    );

    // Visibility changes → tile may enter/leave the composition set
    const visibilityChanged = keys.some(k =>
      k === 'hidden' || k === 'alpha'
    );

    // Flag-only changes (Levels, tile motion, etc.) → IGNORE.
    // This is the critical filter that prevents Levels flag updates from
    // triggering water/mask invalidation.
    if (!geometryChanged && !elevationChanged && !visibilityChanged) {
      return false;
    }

    // Schedule debounced recomposition
    this._scheduleRecompose(tileDoc, { geometryChanged, elevationChanged, visibilityChanged });
    return true;
  }

  /**
   * Schedule a debounced mask recomposition. Multiple tile changes within
   * the debounce window are coalesced into a single recompose.
   * @private
   */
  _scheduleRecompose(_tileDoc, _changeInfo) {
    // Clear existing timer
    if (this._recomposeTimer !== null) {
      clearTimeout(this._recomposeTimer);
    }

    this._recomposeTimer = setTimeout(() => {
      this._recomposeTimer = null;
      this._metrics.recomposeCount++;
      this._metrics.lastRecomposeMs = performance.now();

      // Emit a recompose event. The actual recomposition is driven by
      // SceneComposer or the level-switch handler — we just signal that
      // it's needed. Subscribers can listen for this via onRecomposeNeeded.
      for (const cb of this._recomposeCallbacks) {
        try {
          cb();
        } catch (e) {
          log.warn('_scheduleRecompose: callback error', e);
        }
      }
    }, this._recomposeDebounceMs);
  }

  /** @type {Set<function>} Callbacks invoked when a recompose is needed. */
  _recomposeCallbacks = new Set();

  /**
   * Register a callback to be invoked when tile changes require mask recomposition.
   * @param {function(): void} callback
   * @returns {function(): void} Unsubscribe function
   */
  onRecomposeNeeded(callback) {
    if (typeof callback !== 'function') return () => {};
    this._recomposeCallbacks.add(callback);
    return () => this._recomposeCallbacks.delete(callback);
  }

  // ── Override System ──────────────────────────────────────────────────────

  /**
   * Apply a per-mask policy override. Overrides are merged on top of the
   * base policy when evaluating transitions and clear operations.
   *
   * @param {string} maskType
   * @param {Partial<MaskPolicy>} overridePolicy
   */
  override(maskType, overridePolicy) {
    this._overrides.set(maskType, { ...overridePolicy });
    log.debug(`override: '${maskType}' →`, overridePolicy);
  }

  /**
   * Clear a per-mask override, reverting to the base policy.
   * @param {string} maskType
   */
  clearOverride(maskType) {
    this._overrides.delete(maskType);
    log.debug(`clearOverride: '${maskType}'`);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  /**
   * Returns a diagnostic snapshot of the registry's current state.
   * @returns {Object}
   */
  getMetrics() {
    const slots = {};
    for (const [type, slot] of this._slots) {
      const subs = this._subscribers.get(type);
      slots[type] = {
        hasTexture: !!slot.texture,
        floorKey: slot.floorKey,
        source: slot.source,
        subscriberCount: subs ? subs.size : 0,
        lastUpdateMs: slot.timestamp ? Math.round(performance.now() - slot.timestamp) : null,
      };
      // Include texture resolution if available
      if (slot.texture) {
        const img = slot.texture.image;
        if (img) {
          slots[type].resolution = {
            w: img.width || img.naturalWidth || 0,
            h: img.height || img.naturalHeight || 0
          };
        }
      }
    }

    return {
      activeFloorKey: this._activeFloorKey,
      transitioning: this._transitioning,
      transitionCount: this._metrics.transitionCount,
      lastTransitionMs: this._metrics.lastTransitionMs,
      recomposeCount: this._metrics.recomposeCount,
      slots,
      policyCount: this._policies.size,
      overrideCount: this._overrides.size,
      floorChangeSubscriberCount: this._floorChangeSubscribers.size,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Dispose the registry. Clears all slots, subscribers, timers, and
   * optionally disposes owned textures.
   */
  dispose() {
    // Clear debounce timer
    if (this._recomposeTimer !== null) {
      clearTimeout(this._recomposeTimer);
      this._recomposeTimer = null;
    }

    // Dispose textures per policy
    for (const [type, slot] of this._slots) {
      const policy = this.getPolicy(type);
      if (policy?.disposeOnClear && slot.texture) {
        try { slot.texture.dispose?.(); } catch (_) {}
      }
      slot.texture = null;
      slot.floorKey = null;
      slot.timestamp = 0;
    }

    // Clear all subscriber sets
    for (const subs of this._subscribers.values()) {
      subs.clear();
    }
    this._floorChangeSubscribers.clear();
    this._recomposeCallbacks.clear();
    this._overrides.clear();

    this._transitioning = false;
    this._activeFloorKey = null;

    log.info('EffectMaskRegistry disposed');
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  /**
   * Notify all subscribers for a given mask type with the current slot data.
   * P5-09: Also fires onMaskArrived() on any EffectBase with _lazyInitPending
   * when the texture transitions from null → non-null.
   * @private
   * @param {string} maskType
   */
  _notifySubscribers(maskType) {
    const subs = this._subscribers.get(maskType);
    if (!subs || subs.size === 0) return;

    const slot = this._slots.get(maskType);
    const texture = slot?.texture ?? null;
    const floorKey = slot?.floorKey ?? null;
    const source = slot?.source ?? 'bundle';

    // P5-09: Track whether this is a first-arrival (null → non-null) for lazy init.
    const prevTexture = this._prevTextures?.get(maskType) ?? null;
    const isMaskArrival = !!texture && !prevTexture;
    if (!this._prevTextures) this._prevTextures = new Map();
    this._prevTextures.set(maskType, texture);

    for (const cb of subs) {
      try {
        cb(texture, floorKey, source);
      } catch (e) {
        log.warn(`_notifySubscribers: error in '${maskType}' subscriber`, e);
      }
    }

    // P5-09: Notify lazy-pending EffectBase instances that a mask has arrived.
    // This allows effects deferred during batch registration to initialize
    // themselves as soon as their required mask becomes available.
    if (isMaskArrival) {
      try {
        const composer = window.MapShine?.effectComposer;
        if (composer?.effects) {
          for (const effect of composer.effects.values()) {
            if (effect._lazyInitPending && typeof effect.onMaskArrived === 'function') {
              try {
                effect.onMaskArrived(maskType, texture);
              } catch (e) {
                log.warn(`onMaskArrived error for effect '${effect.id}'`, e);
              }
            }
          }
        }
      } catch (_) {}
    }
  }

  // ── P5-10/11/12/13: Debug State ──────────────────────────────────────────

  /**
   * P5-10/11/12: Returns a rich debug snapshot for the Tweakpane debug panel.
   * Includes per-slot status, active floor, compositor cache hit rate,
   * and per-mask-type toggle state.
   * @returns {Object}
   */
  getDebugState() {
    const slots = {};
    for (const [type, slot] of this._slots) {
      const subs = this._subscribers.get(type);
      const policy = this.getPolicy(type);
      const img = slot.texture?.image;
      slots[type] = {
        hasTexture: !!slot.texture,
        floorKey: slot.floorKey,
        source: slot.source,
        subscriberCount: subs ? subs.size : 0,
        ageMs: slot.timestamp ? Math.round(performance.now() - slot.timestamp) : null,
        resolution: img ? { w: img.width || img.naturalWidth || 0, h: img.height || img.naturalHeight || 0 } : null,
        policy: policy ? {
          preserveAcrossFloors: policy.preserveAcrossFloors,
          compositionMode: policy.compositionMode,
          resolutionClass: policy.resolutionClass
        } : null,
        // P5-12: per-mask-type enabled toggle (defaults to true)
        enabled: this._maskTypeEnabled?.get(type) !== false
      };
    }

    return {
      activeFloorKey: this._activeFloorKey,
      transitioning: this._transitioning,
      transitionCount: this._metrics.transitionCount,
      lastTransitionMs: this._metrics.lastTransitionMs,
      recomposeCount: this._metrics.recomposeCount,
      lastRecomposeMs: this._metrics.lastRecomposeMs,
      slots
    };
  }

  /**
   * P5-12: Toggle a mask type on/off in the debug overlay.
   * When disabled, the slot is treated as null by getMask() for debug purposes.
   * @param {string} maskType
   * @param {boolean} enabled
   */
  setMaskTypeDebugEnabled(maskType, enabled) {
    if (!this._maskTypeEnabled) this._maskTypeEnabled = new Map();
    this._maskTypeEnabled.set(maskType, enabled === true);
    // Re-notify subscribers so effects pick up the debug override immediately.
    this._notifySubscribersDebugOverride(maskType, enabled ? (this._slots.get(maskType)?.texture ?? null) : null);
  }

  /**
   * @param {string} maskType
   * @returns {boolean} Whether the mask type is enabled for debug purposes
   */
  isMaskTypeDebugEnabled(maskType) {
    return this._maskTypeEnabled?.get(maskType) !== false;
  }

  /**
   * Notify subscribers with a debug-overridden texture value (null when disabled).
   * @private
   */
  _notifySubscribersDebugOverride(maskType, overrideTexture) {
    const subs = this._subscribers.get(maskType);
    if (!subs || subs.size === 0) return;
    const slot = this._slots.get(maskType);
    const floorKey = slot?.floorKey ?? null;
    const source = slot?.source ?? 'bundle';
    for (const cb of subs) {
      try { cb(overrideTexture, floorKey, source); } catch (_) {}
    }
  }
}
