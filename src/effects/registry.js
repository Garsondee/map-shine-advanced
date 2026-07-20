/**
 * THE EFFECT REGISTRY — the ONE door for an effect's enable state, params and
 * tier. `id → { manifest, apply }`. Nothing else knows an effect exists.
 *
 * ============================================================================
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ============================================================================
 *
 * This is a SUBSET of the full effect contract in `Effects-API.md` §5 — it has
 * no `reads`/`writes`/graph derivation, because UI-shadow (the first registrant)
 * is a screen-space, DOM-driven effect that barely has graph reads, and the
 * full contract is best pressure-tested by WATER, the honest hard case (§6 of
 * that doc). When water lands, its contract SUBSUMES this map; until then this
 * is the whole registry, and it is the ONLY door for what it owns.
 *
 * ============================================================================
 * WHY A REGISTRY AT ALL — the V2 corpse (Effect-Registration.md §6)
 * ============================================================================
 *
 * V2 had no registry. "Which effects exist and are they on" lived in hardcoded
 * `['ascii','_asciiEffect']` ID→private-field tables scattered across
 * `resolve-effect-enabled.js` and the 10,063-line `FloorCompositor`, so adding
 * an effect meant editing hand tables (or it silently never gated), and the
 * render loop read the UI's debounce internals to decide what drew. Here:
 *   - an effect is a VALUE in this map; nothing knows its field name;
 *   - "is it on / with what values" is ONE call (`resolveAndApply`) over the
 *     pure cascade resolver (effect-cascade.js), never a per-category function;
 *   - the resolved state flows registry → `apply` → the effect, and the frame
 *     loop reads only what `apply` set — it cannot see a settings store or UI
 *     state, so the V2 race is unreachable by construction.
 *
 * `apply` is INJECTED at registration (by the composition root, boot.js), not
 * baked into the manifest — so the manifest stays pure data and the effects zone
 * never imports the renderer (the dependency inversion V2's foundry adapter got
 * backwards). The manifest is validated at registration: a malformed one throws
 * LOUDLY here, at startup, rather than misbehaving in play.
 *
 * @module effects/registry
 */

import { validateEffectManifest } from './effect-manifest.js';
import { resolveEffectEnabled, resolveEffectParams } from './effect-cascade.js';

/**
 * @typedef {object} ResolvedEffect
 * @property {boolean} enabled
 * @property {Record<string, unknown>} params
 * @property {{key: string, reason: string}[]} rejected - stored values that failed validation (reported, never silently coerced).
 */

/**
 * Create an effect registry. A factory, not a module singleton, so tests get a
 * fresh one and the composition root owns the live instance (no ambient global
 * to reach around — the `no-global-bus` discipline).
 *
 * @returns {{
 *   register: (manifest: object, apply: (r: ResolvedEffect) => void) => string,
 *   get: (id: string) => {manifest: object, apply: Function} | null,
 *   list: () => object[],
 *   resolveAndApply: (id: string, layers?: object) => ResolvedEffect,
 * }}
 */
export function createEffectRegistry() {
  /** @type {Map<string, {manifest: object, apply: Function}>} */
  const entries = new Map();

  /**
   * Register an effect. Validates the manifest (throws loudly if bad), rejects a
   * duplicate id, and pairs it with the `apply` the composition root injects.
   * @param {object} manifest
   * @param {(r: ResolvedEffect) => void} apply
   * @returns {string} the registered id
   */
  function register(manifest, apply) {
    const v = validateEffectManifest(manifest);
    if (!v.ok) {
      throw new Error(`effect manifest '${manifest?.id ?? '?'}' is invalid:\n  - ${v.errors.join('\n  - ')}`);
    }
    if (typeof apply !== 'function') {
      throw new Error(
        `effect '${manifest.id}' needs an apply(resolved) function — the registry drives the effect through it`
      );
    }
    if (entries.has(manifest.id)) {
      throw new Error(`effect '${manifest.id}' is already registered — one entry per id (the id is the settings key)`);
    }
    entries.set(manifest.id, { manifest, apply });
    return manifest.id;
  }

  /** @param {string} id @returns {{manifest: object, apply: Function}|null} */
  function get(id) {
    return entries.get(id) ?? null;
  }

  /** @returns {object[]} every registered manifest (for the settings adapter to derive its registrations from). */
  function list() {
    return [...entries.values()].map((e) => e.manifest);
  }

  /**
   * Resolve an effect's effective state through the cascade and hand it to its
   * `apply`. An unknown id THROWS — loudly, never a silent skip: the registry is
   * the only door, so being asked to drive an effect it does not know is a real
   * bug, not a no-op (V2's `applyParamChange` silently returned on an unknown key
   * and the caller was never told).
   *
   * @param {string} id
   * @param {object} [layers] - `{ profile, gmEnable, playerEnable, reducePhotosensitive, paramLayers }`
   * @returns {ResolvedEffect}
   */
  function resolveAndApply(id, layers = {}) {
    const entry = entries.get(id);
    if (!entry) {
      throw new Error(
        `no effect registered as '${id}' — nothing else knows this effect (the registry is the only door)`
      );
    }
    const enabled = resolveEffectEnabled(entry.manifest, layers);
    const { values, rejected } = resolveEffectParams(entry.manifest.params, layers?.paramLayers ?? []);
    const resolved = { enabled, params: values, rejected };
    entry.apply(resolved);
    return resolved;
  }

  return { register, get, list, resolveAndApply };
}
