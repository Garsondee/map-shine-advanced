/**
 * @fileoverview MaskBindingController — single fan-out engine responsible for
 * giving every consumer the correct per-floor version of every suffixed mask.
 *
 * The controller is the generalisation of the previous
 * `_syncOutdoorsMaskConsumers` path on `FloorCompositor`. Instead of wiring
 * one mask (outdoors) to a handful of effects through ad-hoc logic, it walks
 * {@link module:masks/mask-catalog.CONSUMER_CATALOG}, builds a per-floor mask
 * bundle for every visible floor, and dispatches to each consumer via either:
 *
 *   - a single-texture setter (`setXxxMask(tex)`) for legacy/simple consumers;
 *   - or a banded-array setter (`setXxxMasks([tex0, tex1, tex2, tex3])` plus
 *     `setFloorIdTexture(tex)`) for per-floor-aware shaders.
 *
 * The controller also aggregates a full binding signature across every
 * (floor × mask) pair plus the compositor's `_floorCacheVersion`. If the
 * signature is unchanged it short-circuits (same guarantee the
 * outdoors-only path provided). Any mask becoming present/absent, any
 * texture promoting from a fallback, or any floor cache eviction bumps the
 * version and forces a full re-fan-out.
 *
 * Public entry points:
 *   - {@link MaskBindingController#sync}           — call once per frame.
 *   - {@link MaskBindingController#isReadyForFrame} — strict-sync dependency gate.
 *   - {@link MaskBindingController#diagnose}       — snapshot for telemetry.
 *
 * @module masks/mask-binding-controller
 */

import { createLogger } from '../core/log.js';
import {
  MASK_CATALOG,
  CONSUMER_CATALOG,
  resolveOutdoorsVariant,
} from './mask-catalog.js';

const log = createLogger('MaskBindingController');

/** Default number of banded slots consumers accept unless they override. */
const DEFAULT_BANDED_SLOTS = 4;

/**
 * @typedef {Object} PerFloorMaskBundle
 * @property {string} floorKey        Compositor key, e.g. '0:5'.
 * @property {number} index           0-based floor index from FloorStack.
 * @property {number} elevationMin
 * @property {number} elevationMax
 * @property {Object<string, import('three').Texture|null>} masks
 *   Map of mask id (e.g. 'outdoors', 'skyReach', 'water') → texture.
 */

/**
 * @typedef {Object} SyncResult
 * @property {boolean} changed   True when fan-out ran this call.
 * @property {boolean} skipped   True when signature matched and fan-out was skipped.
 * @property {string}  reason    Short human-readable reason when !changed && !skipped.
 * @property {number}  consumersFanned  How many consumer entries were visited.
 * @property {string}  signature        The signature string that was active at this call.
 */

export class MaskBindingController {
  /**
   * @param {Object} deps
   * @param {Object} deps.floorCompositor - FloorCompositor instance (for `_xxxEffect` lookups).
   * @param {Object} deps.getCompositor   - Callable returning the live GpuSceneMaskCompositor.
   * @param {Object} [deps.getFloorStack] - Callable returning the FloorStack (defaults to window.MapShine.floorStack).
   * @param {Object} [deps.getWeatherController] - Callable returning WeatherController.
   */
  constructor(deps = {}) {
    this._floorCompositor = deps.floorCompositor ?? null;
    this._getCompositor = typeof deps.getCompositor === 'function'
      ? deps.getCompositor
      : () => window?.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    this._getFloorStack = typeof deps.getFloorStack === 'function'
      ? deps.getFloorStack
      : () => window?.MapShine?.floorStack ?? null;
    this._getWeatherController = typeof deps.getWeatherController === 'function'
      ? deps.getWeatherController
      : () => window?.MapShine?.weatherController ?? null;

    /** @type {string|null} Signature of the most recent successful sync. */
    this._lastSignature = null;

    /** @type {number} Monotonic counter of fan-outs performed. */
    this._syncCount = 0;

    /** @type {Object|null} Last published telemetry payload. */
    this._lastTelemetry = null;

    /** @type {number|null} Active floor index seen on the last sync. */
    this._lastActiveFloorIndex = null;
  }

  /**
   * Build a {@link PerFloorMaskBundle} for a single floor by reading every
   * mask id listed in {@link MASK_CATALOG} from the compositor's per-floor
   * cache.
   *
   * Returns `null` for the bundle's texture slots that the compositor doesn't
   * have yet. The controller treats missing textures as "not ready" for
   * strict-sync purposes but still fans out whatever is available so that
   * consumers progressively pick up new textures as they come online.
   *
   * @param {Object} compositor
   * @param {{ index:number, compositorKey:string, elevationMin:number, elevationMax:number }} floor
   * @returns {PerFloorMaskBundle}
   * @private
   */
  _buildBundle(compositor, floor) {
    const masks = Object.create(null);
    const floorKey = floor.compositorKey;
    for (const id of Object.keys(MASK_CATALOG)) {
      const entry = MASK_CATALOG[id];
      if (!entry.perFloor) {
        masks[id] = null;
        continue;
      }
      let tex = null;
      try {
        tex = compositor?.getFloorTexture?.(floorKey, id) ?? null;
      } catch (_) {
        tex = null;
      }
      masks[id] = tex;
    }
    return {
      floorKey,
      index: floor.index,
      elevationMin: floor.elevationMin,
      elevationMax: floor.elevationMax,
      masks,
    };
  }

  /**
   * Resolve the consumer instance for a catalog entry.
   *
   *   - location='floorCompositor' → read `this._floorCompositor[entry.path]`.
   *   - location='global'          → read global singletons by path name
   *                                  (e.g. `weatherController` → MapShine.weatherController).
   *
   * @param {import('./mask-catalog.js').ConsumerCatalogEntry} entry
   * @returns {Object|null}
   * @private
   */
  _resolveConsumer(entry) {
    if (!entry) return null;
    if (entry.location === 'global') {
      switch (entry.path) {
        case 'weatherController': return this._getWeatherController() ?? null;
        default: return null;
      }
    }
    const fc = this._floorCompositor;
    if (!fc) return null;
    return fc[entry.path] ?? null;
  }

  /**
   * Resolve the mask id a binding reads — handles the 'outdoors' → 'skyReach'
   * variant for sky-purpose consumers.
   *
   * @param {import('./mask-catalog.js').ConsumerBinding} binding
   * @returns {string}
   * @private
   */
  _resolveMaskId(binding) {
    if (binding.consumes === 'outdoors') {
      return resolveOutdoorsVariant(binding.outdoorsPurpose ?? 'surface');
    }
    return binding.consumes;
  }

  /**
   * Pick the texture to push down the single-texture setter path for a
   * consumer. We prefer the active floor's texture; if that slot is null we
   * fall back to the first non-null texture across visible floors so
   * consumers never receive a sudden null during async promotion.
   *
   * @param {PerFloorMaskBundle[]} bundles
   * @param {number} activeIndex
   * @param {string} maskId
   * @returns {import('three').Texture|null}
   * @private
   */
  _pickSingleTex(bundles, activeIndex, maskId) {
    const active = bundles.find((b) => b.index === activeIndex);
    if (active?.masks?.[maskId]) return active.masks[maskId];
    for (const b of bundles) {
      if (b.masks?.[maskId]) return b.masks[maskId];
    }
    return null;
  }

  /**
   * Build the banded-texture array for a consumer. Slot `i` is populated from
   * the bundle whose `index === i`, or null if there's no matching floor in
   * the visible set.
   *
   * @param {PerFloorMaskBundle[]} bundles
   * @param {number} slots
   * @param {string} maskId
   * @returns {(import('three').Texture|null)[]}
   * @private
   */
  _buildBandedArray(bundles, slots, maskId) {
    const arr = new Array(slots).fill(null);
    for (const b of bundles) {
      if (b.index >= 0 && b.index < slots) {
        arr[b.index] = b.masks?.[maskId] ?? null;
      }
    }
    return arr;
  }

  /**
   * Compute a deterministic signature across every visible floor × every
   * referenced mask id + the active floor index + the compositor cache
   * version. Any change to any of these forces a full re-fan-out.
   *
   * @param {PerFloorMaskBundle[]} bundles
   * @param {number} activeIndex
   * @param {number} cacheVersion
   * @returns {string}
   * @private
   */
  _computeSignature(bundles, activeIndex, cacheVersion) {
    const parts = [`v:${cacheVersion}`, `a:${activeIndex ?? 'none'}`];
    const sorted = [...bundles].sort((a, b) => a.index - b.index);
    for (const b of sorted) {
      const m = b.masks;
      const maskIds = Object.keys(m).sort();
      const segs = [];
      for (const id of maskIds) {
        const t = m[id];
        segs.push(`${id}:${t?.uuid ? t.uuid : (t ? 'anon' : 'null')}`);
      }
      parts.push(`${b.floorKey}#${b.index}[${segs.join(',')}]`);
    }
    return parts.join('|');
  }

  /**
   * Fan out a single consumer.
   *
   * @param {string} consumerId
   * @param {import('./mask-catalog.js').ConsumerCatalogEntry} entry
   * @param {PerFloorMaskBundle[]} bundles
   * @param {number} activeIndex
   * @param {import('three').Texture|null} floorIdTex
   * @returns {Object} telemetry row for this consumer
   * @private
   */
  _fanOutConsumer(consumerId, entry, bundles, activeIndex, floorIdTex) {
    const instance = this._resolveConsumer(entry);
    const row = {
      id: consumerId,
      path: entry.path,
      present: !!instance,
      bindings: [],
    };
    if (!instance) {
      if (!entry.optional) {
        log.debug(`fanOut: consumer '${consumerId}' not present (path=${entry.path})`);
      }
      return row;
    }

    for (const binding of entry.bindings) {
      const maskId = this._resolveMaskId(binding);
      const slots = binding.bandedSlots ?? DEFAULT_BANDED_SLOTS;
      const hasBanded = typeof binding.bandedSetter === 'string'
        && typeof instance[binding.bandedSetter] === 'function';
      const hasSingle = typeof binding.singleSetter === 'string'
        && typeof instance[binding.singleSetter] === 'function';

      if (hasBanded) {
        const arr = this._buildBandedArray(bundles, slots, maskId);
        try { instance[binding.bandedSetter](arr); } catch (err) {
          log.warn(`fanOut: ${consumerId}.${binding.bandedSetter} threw`, err);
        }
        if (binding.floorIdSetter && typeof instance[binding.floorIdSetter] === 'function') {
          try { instance[binding.floorIdSetter](floorIdTex); } catch (err) {
            log.warn(`fanOut: ${consumerId}.${binding.floorIdSetter} threw`, err);
          }
        }
        row.bindings.push({
          consumes: binding.consumes,
          maskId,
          path: 'banded',
          slots,
          present: arr.map((t) => !!t),
        });
      } else if (hasSingle) {
        const tex = this._pickSingleTex(bundles, activeIndex, maskId);
        try { instance[binding.singleSetter](tex); } catch (err) {
          log.warn(`fanOut: ${consumerId}.${binding.singleSetter} threw`, err);
        }
        row.bindings.push({
          consumes: binding.consumes,
          maskId,
          path: 'single',
          present: !!tex,
          source: bundles.find((b) => b.index === activeIndex)?.masks?.[maskId] ? 'active' : (tex ? 'fallback' : 'none'),
        });
      } else {
        row.bindings.push({
          consumes: binding.consumes,
          maskId,
          path: 'missing-setter',
          present: false,
        });
      }
    }
    return row;
  }

  /**
   * Perform a full per-floor fan-out across every registered consumer.
   *
   * Typical usage — from `FloorCompositor.render()` right before drawing,
   * replacing the old `_syncOutdoorsMaskConsumers()` special case:
   *
   *     this._maskBindingController.sync({
   *       activeFloorIndex: this._activeFloorIndex,
   *       force: false,
   *     });
   *
   * @param {Object} [options]
   * @param {number|null} [options.activeFloorIndex]
   *   Active floor index from FloorStack; defaults to the live value on
   *   `window.MapShine.floorStack`.
   * @param {boolean} [options.force=false]
   *   Skip the signature short-circuit and re-dispatch every consumer.
   * @returns {SyncResult}
   */
  sync(options = {}) {
    const force = !!options.force;
    const compositor = this._getCompositor();
    const floorStack = this._getFloorStack();

    const floors = (() => {
      try {
        const list = floorStack?.getFloors?.() ?? [];
        return Array.isArray(list) ? list.filter((f) => f && f.compositorKey) : [];
      } catch (_) {
        return [];
      }
    })();

    const activeIndex = Number.isFinite(Number(options.activeFloorIndex))
      ? Number(options.activeFloorIndex)
      : (Number.isFinite(Number(floorStack?.getActiveFloor?.()?.index))
        ? Number(floorStack.getActiveFloor().index)
        : 0);

    // Build per-floor bundles. For single-floor scenes the floor list may be
    // empty — we synthesise a 'ground' bundle so single-floor consumers still
    // pick up the authored _Outdoors/_Water etc. from the ground-floor cache.
    let bundles;
    if (floors.length === 0) {
      bundles = [this._buildBundle(compositor, {
        index: 0,
        compositorKey: compositor?._activeFloorKey ?? 'ground',
        elevationMin: 0,
        elevationMax: 0,
      })];
    } else {
      bundles = floors.map((f) => this._buildBundle(compositor, f));
    }

    const cacheVersion = Number(compositor?.getFloorCacheVersion?.() ?? 0);
    const signature = this._computeSignature(bundles, activeIndex, cacheVersion);

    if (!force && signature === this._lastSignature) {
      return { changed: false, skipped: true, reason: 'signature-match', consumersFanned: 0, signature };
    }

    const floorIdTex = compositor?.floorIdTarget?.texture ?? null;

    const rows = [];
    for (const [consumerId, entry] of Object.entries(CONSUMER_CATALOG)) {
      rows.push(this._fanOutConsumer(consumerId, entry, bundles, activeIndex, floorIdTex));
    }

    this._lastSignature = signature;
    this._lastActiveFloorIndex = activeIndex;
    this._syncCount++;

    this._lastTelemetry = {
      signature,
      activeIndex,
      cacheVersion,
      visibleFloors: bundles.map((b) => ({
        index: b.index,
        floorKey: b.floorKey,
        masks: Object.fromEntries(Object.entries(b.masks).map(([id, t]) => [id, !!t])),
      })),
      consumers: rows,
      syncCount: this._syncCount,
    };
    try {
      if (window?.MapShine) {
        window.MapShine.__maskBindings = this._lastTelemetry;
      }
    } catch (_) {}

    return {
      changed: true,
      skipped: false,
      reason: '',
      consumersFanned: rows.length,
      signature,
    };
  }

  /**
   * Strict-sync readiness probe. Returns `{ valid, reason }` — `valid=false`
   * means the controller is missing at least one required texture for a
   * visible floor, and the caller should hold the last valid frame.
   *
   * A consumer binding is "required" for gate purposes if it targets the
   * active floor and is marked as such in the catalog. To keep the initial
   * rollout conservative we only require the following for the active floor:
   *
   *   - outdoors        (surface consumers need a real mask)
   *   - skyReach        (weather/cloud/fog/sky all gate on this)
   *   - floorAlpha      (present whenever any tile finished composing — cheap
   *                      readiness indicator)
   *
   * @returns {{ valid: boolean, reason: string, missing: string[], activeIndex: number }}
   */
  isReadyForFrame() {
    const compositor = this._getCompositor();
    if (!compositor) {
      return { valid: false, reason: 'no-compositor', missing: ['compositor'], activeIndex: -1 };
    }
    const floorStack = this._getFloorStack();
    const active = floorStack?.getActiveFloor?.() ?? null;
    const activeIndex = Number(active?.index ?? 0);
    const activeKey = active?.compositorKey ?? compositor?._activeFloorKey ?? null;
    if (!activeKey) {
      return { valid: false, reason: 'no-active-floor-key', missing: ['activeKey'], activeIndex };
    }

    // Build fallback keys for multi-floor "look down" semantics:
    // when the active/viewed floor has no authored/derived mask yet, allow the
    // nearest lower visible floor that does have the mask. This mirrors the
    // per-level render fallback used by water and prevents strict-sync from
    // holding the entire frame on scenes where only lower floors author masks.
    const floorList = (() => {
      try {
        const list = floorStack?.getFloors?.() ?? [];
        return Array.isArray(list) ? list : [];
      } catch (_) {
        return [];
      }
    })();
    const byIndex = new Map(
      floorList
        .map((f) => [Number(f?.index), f])
        .filter(([idx]) => Number.isFinite(idx)),
    );
    const visibleIndices = (() => {
      try {
        const vis = floorStack?.getVisibleFloors?.() ?? [];
        if (!Array.isArray(vis) || vis.length === 0) return [activeIndex];
        return vis
          .map((f) => Number(f?.index))
          .filter((idx) => Number.isFinite(idx))
          .sort((a, b) => b - a);
      } catch (_) {
        return [activeIndex];
      }
    })();
    /** @type {string[]} */
    const candidateKeys = [String(activeKey)];
    for (const idx of visibleIndices) {
      if (idx > activeIndex) continue;
      const k = byIndex.get(idx)?.compositorKey;
      if (k) candidateKeys.push(String(k));
    }
    const uniqueCandidateKeys = [...new Set(candidateKeys)];

    const REQUIRED = ['outdoors', 'floorAlpha', 'skyReach'];
    const missing = [];
    for (const id of REQUIRED) {
      let found = false;
      for (const key of uniqueCandidateKeys) {
        const tex = compositor.getFloorTexture?.(key, id) ?? null;
        if (tex) {
          found = true;
          break;
        }
      }
      if (!found) missing.push(id);
    }
    if (missing.length === 0) {
      return { valid: true, reason: 'ok', missing: [], activeIndex };
    }
    return {
      valid: false,
      reason: `missing:${missing.join(',')}@${activeKey}`,
      missing,
      activeIndex,
    };
  }

  /**
   * Return the most recent fan-out telemetry snapshot, or null if `sync` has
   * not run yet. Used by `MapShine.debug.diagnoseMaskBindings()`.
   *
   * @returns {Object|null}
   */
  diagnose() {
    return this._lastTelemetry;
  }

  /**
   * Invalidate the cached signature so the next `sync()` performs a full
   * fan-out even if nothing else changed. Useful after explicit floor changes
   * or scene reloads.
   */
  invalidate() {
    this._lastSignature = null;
  }
}

export default MaskBindingController;
