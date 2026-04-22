/**
 * @fileoverview **V3 Mask Binding Controller** — turns hub state into calls
 * on consumer (effect) instances.
 *
 * A "consumer" is any object that wants one or more masks for a specific
 * floor. Consumers register with the controller, providing:
 *
 *   - an `id` (stable, for diagnostics)
 *   - an `instance` (the object whose setters will be invoked)
 *   - a list of `bindings` (mask id + outdoors purpose + setter names)
 *   - optional `getFloorKey()` — defaults to the hub's active floor key
 *
 * On every hub update (cache version bump) — or when a consumer's resolved
 * floor key changes — the controller:
 *
 *   1. Builds a signature for each consumer: `(cacheVersion, floorKey,
 *      [maskId:textureUuid]…)`.
 *   2. Compares against the last signature; if unchanged, does nothing.
 *   3. If changed, resolves each binding through {@link V3MaskHub#getFloorMask}
 *      (awaiting authored loads and derived passes) and invokes the setter.
 *
 * The controller prefers the banded setter in multi-floor scenes when one is
 * provided; otherwise it falls back to the single-texture setter. This
 * mirrors the v13 `MaskBindingController` contract so future V3 effects
 * using the same catalog schema will bind without extra glue.
 *
 * @module v3/V3MaskBindingController
 */

import {
  getConsumerEntry,
  listConsumerMaskIds,
  resolveOutdoorsVariant,
} from "./V3MaskCatalog.js";

/**
 * @typedef {Object} ConsumerRegistration
 * @property {string} id
 * @property {object} instance
 * @property {import("./V3MaskCatalog.js").ConsumerBinding[]} bindings
 * @property {(() => string)|null} [getFloorKey]
 * @property {boolean} [optional]
 */

/**
 * @typedef {Object} ConsumerState
 * @property {string} lastFloorKey
 * @property {string} lastSignature
 * @property {number} lastCacheVersion
 * @property {Map<string, {maskId: string, textureUuid: string|null}>} lastBound
 */

function textureUuid(tex) {
  if (!tex) return null;
  return tex.uuid ?? null;
}

export class V3MaskBindingController {
  /**
   * @param {{
   *   hub: import("./V3MaskHub.js").V3MaskHub,
   *   logger?: { log: Function, warn: Function },
   * }} opts
   */
  constructor({ hub, logger }) {
    this.hub = hub;
    this.log = logger?.log ?? (() => {});
    this.warn = logger?.warn ?? (() => {});

    /** @type {Map<string, ConsumerRegistration>} */ this._consumers = new Map();
    /** @type {Map<string, ConsumerState>} */ this._state = new Map();

    this._unsubscribeHub = hub.subscribe(() => this._scheduleRebind());
    this._pendingRebind = null;
    this._disposed = false;
  }

  /**
   * Register a consumer. If `bindings` is omitted, the controller looks up
   * {@link V3_CONSUMER_CATALOG} by `id` — useful for porting an effect that
   * already has a static entry.
   *
   * @param {ConsumerRegistration} reg
   * @returns {() => void} Unregister.
   */
  register(reg) {
    if (this._disposed) return () => {};
    if (!reg?.id || !reg.instance) {
      this.warn("register: missing id/instance", reg);
      return () => {};
    }
    const bindings = Array.isArray(reg.bindings) && reg.bindings.length
      ? reg.bindings
      : getConsumerEntry(reg.id)?.bindings ?? [];
    if (!bindings.length) {
      this.warn("register: no bindings", reg.id);
    }
    const full = {
      id: String(reg.id),
      instance: reg.instance,
      bindings,
      getFloorKey: typeof reg.getFloorKey === "function" ? reg.getFloorKey : null,
      optional: !!reg.optional,
    };
    this._consumers.set(full.id, full);
    this._state.set(full.id, {
      lastFloorKey: "",
      lastSignature: "",
      lastCacheVersion: -1,
      lastBound: new Map(),
    });
    this._scheduleRebind();
    return () => this.unregister(full.id);
  }

  /** @param {string} id */
  unregister(id) {
    this._consumers.delete(id);
    this._state.delete(id);
  }

  /** Drop everything; controller becomes unusable. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this._unsubscribeHub?.(); } catch (_) {}
    this._unsubscribeHub = null;
    this._consumers.clear();
    this._state.clear();
  }

  /**
   * Force a rebind on next microtask even if nothing changed — useful after
   * registering a brand-new consumer or after manual cache invalidation.
   */
  requestRebind() {
    this._scheduleRebind({ force: true });
  }

  /**
   * @param {{ force?: boolean }} [opts]
   */
  _scheduleRebind(opts = {}) {
    if (this._disposed) return;
    if (this._pendingRebind) {
      if (opts.force) this._pendingRebind.force = true;
      return;
    }
    const task = { force: !!opts.force };
    this._pendingRebind = task;
    Promise.resolve().then(() => {
      if (this._pendingRebind !== task) return;
      this._pendingRebind = null;
      this._rebindAll(task.force).catch((err) => this.warn("rebind failed", err));
    });
  }

  async _rebindAll(force) {
    if (this._disposed) return;
    for (const reg of this._consumers.values()) {
      try {
        await this._rebindConsumer(reg, force);
      } catch (err) {
        this.warn("rebindConsumer failed", reg.id, err);
      }
    }
  }

  /**
   * @param {ConsumerRegistration} reg
   * @param {boolean} force
   */
  async _rebindConsumer(reg, force) {
    const state = this._state.get(reg.id);
    if (!state) return;

    const floorKey = reg.getFloorKey ? reg.getFloorKey() : this.hub.getActiveFloorKey();
    const cacheVersion = this.hub.getCacheVersion();

    // Resolve textures for every binding.
    const resolved = [];
    for (const binding of reg.bindings) {
      const baseId = binding.consumes;
      if (!baseId) continue;
      const maskId = baseId === "outdoors"
        ? resolveOutdoorsVariant(binding.outdoorsPurpose ?? "surface")
        : baseId;
      const { texture, meta } = await this.hub.getFloorMask(floorKey, maskId, {
        purpose: binding.outdoorsPurpose,
        allowSpeculativeDiskUrl: false,
      });
      resolved.push({ binding, maskId, texture, meta });
    }

    const signature = [
      `v=${cacheVersion}`,
      `f=${floorKey}`,
      ...resolved.map((r) => `${r.maskId}:${textureUuid(r.texture) ?? "null"}`),
    ].join("|");

    if (!force && signature === state.lastSignature) return;

    // Call setters.
    for (const r of resolved) {
      const { binding, texture, maskId } = r;
      const before = state.lastBound.get(binding.consumes + "@" + (binding.outdoorsPurpose ?? "surface"));
      const nowUuid = textureUuid(texture);
      if (!force && before?.maskId === maskId && before?.textureUuid === nowUuid) continue;

      const inst = reg.instance;
      const setterName = binding.singleSetter;
      if (setterName && typeof inst[setterName] === "function") {
        try {
          inst[setterName](texture ?? null);
        } catch (err) {
          this.warn(`setter ${reg.id}.${setterName} threw`, err);
        }
      } else if (!reg.optional) {
        this.warn(`consumer ${reg.id} missing setter`, setterName);
      }

      if (binding.singleField && typeof binding.singleField === "string") {
        try { inst[binding.singleField] = texture ?? null; } catch (_) {}
      }

      state.lastBound.set(binding.consumes + "@" + (binding.outdoorsPurpose ?? "surface"), {
        maskId,
        textureUuid: nowUuid,
      });
    }

    state.lastSignature = signature;
    state.lastCacheVersion = cacheVersion;
    state.lastFloorKey = floorKey;
  }

  /** Serializable summary for diagnostics / tests. */
  snapshot() {
    const consumers = [];
    for (const reg of this._consumers.values()) {
      const state = this._state.get(reg.id);
      consumers.push({
        id: reg.id,
        bindings: listConsumerMaskIds({ bindings: reg.bindings }),
        floorKey: state?.lastFloorKey ?? null,
        cacheVersion: state?.lastCacheVersion ?? null,
        signature: state?.lastSignature ?? null,
        bound: state ? Array.from(state.lastBound.entries()).map(([slot, v]) => ({ slot, ...v })) : [],
      });
    }
    return { consumers };
  }
}
