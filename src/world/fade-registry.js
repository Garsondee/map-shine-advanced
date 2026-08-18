/**
 * THE FADE REGISTRY — where "automatically expands as we add more effects"
 * (the author's own words, 2026-08-18) becomes a literal, testable property
 * of this codebase instead of a design intention.
 *
 * ============================================================================
 * THE IDEA
 * ============================================================================
 *
 * `fade-engine.js` can smoothly blend between two values of a known TYPE, but
 * it has no idea what "water.depth" even is — on purpose (see its own
 * header). Something has to answer three questions for a namespaced key:
 * "what TYPE is this", "what's its LIVE value right now", and "WRITE a new
 * value here" — and answer them WITHOUT this file (or fade-engine.js) ever
 * having to learn a new effect's name.
 *
 * The answer already exists in this codebase: every effect that wants a
 * Studio card already builds an `{schema, getValue, onChange}` triple
 * (`ui/rooms/studio/shell.js#registerEffectCard`'s own contract) — `schema`
 * is keyed by `core/params-schema.js#PARAM_TYPES`, `getValue`/`onChange` are
 * a live read/write door. `schemaFadeSource` below wraps that EXACT triple,
 * unchanged, into a fade source. There is no second registration to forget:
 * an effect becomes fadeable the moment it has a Studio card, which every
 * effect needs anyway. A future 16th effect adds ZERO lines to this module.
 *
 * ============================================================================
 * PURE, LIKE fade-engine.js
 * ============================================================================
 *
 * No Foundry, no DOM, no globals — `schemaFadeSource`/`createFadeSourceRegistry`
 * operate entirely on functions the CALLER supplies. Node-tested with plain
 * fake sources, the same discipline `tools/studio-preview/` and
 * `tools/remote-preview/`'s own fake view-models already use for the UI side
 * of this exact idea.
 *
 * @module world/fade-registry
 */

import { FADEABLE_TYPES } from './fade-engine.js';

/**
 * @typedef {object} FadeSource
 * @property {() => string[]} keys - every FADEABLE field this source owns
 *   (non-fadeable types, e.g. `action`/`text`/`curve`, are excluded here —
 *   never surfaced as a false promise to an authoring UI).
 * @property {(field: string) => string|undefined} typeOf
 * @property {(field: string) => *} readLive
 * @property {(field: string, value: *) => void} write
 */

/**
 * Wrap a `{schema, getValue, onChange}` triple — the exact shape
 * `registerEffectCard`'s view-model factory already returns — into a
 * {@link FadeSource}. This is the ENTIRE auto-expansion mechanism.
 * @param {{schema: Record<string, {type: string}>, getValue: (id: string) => *,
 *   onChange: (id: string, value: *) => void}} triple
 * @returns {FadeSource}
 */
export function schemaFadeSource({ schema, getValue, onChange }) {
  const s = schema ?? {};
  return {
    keys: () => Object.keys(s).filter((id) => FADEABLE_TYPES.includes(s[id]?.type)),
    typeOf: (field) => s[field]?.type,
    readLive: (field) => getValue?.(field),
    write: (field, value) => onChange?.(field, value),
  };
}

/**
 * A registry of NAMESPACED sources — `'water' -> {keys, typeOf, readLive,
 * write}`, `'weather' -> ...`. `resolve()` splits a key on its FIRST `.` and
 * defers entirely to that namespace's own source; the registry itself never
 * knows what a "water" or a "depth" is, only how to find whoever does.
 *
 * @returns {{
 *   registerSource: (namespace: string, source: FadeSource) => void,
 *   hasSource: (namespace: string) => boolean,
 *   typeOf: (key: string) => string|undefined,
 *   readLive: (key: string) => *,
 *   write: (key: string, value: *) => void,
 *   allKeys: () => string[],
 * }}
 */
export function createFadeSourceRegistry() {
  /** @type {Map<string, FadeSource>} */
  const sources = new Map();

  /**
   * @param {string} namespace
   * @param {FadeSource} source
   */
  function registerSource(namespace, source) {
    if (typeof namespace !== 'string' || namespace.length === 0 || namespace.includes('.')) {
      throw new Error(
        `fade source namespace must be a non-empty string with no '.' — got ${JSON.stringify(namespace)}`
      );
    }
    if (sources.has(namespace)) {
      throw new Error(`fade source '${namespace}' is already registered — one source per namespace`);
    }
    sources.set(namespace, source);
  }

  function hasSource(namespace) {
    return sources.has(namespace);
  }

  /** @param {string} key @returns {{namespace: string, field: string}|null} */
  function splitKey(key) {
    const i = typeof key === 'string' ? key.indexOf('.') : -1;
    if (i <= 0 || i === key.length - 1) return null;
    return { namespace: key.slice(0, i), field: key.slice(i + 1) };
  }

  function typeOf(key) {
    const split = splitKey(key);
    const source = split && sources.get(split.namespace);
    return source ? source.typeOf(split.field) : undefined;
  }

  function readLive(key) {
    const split = splitKey(key);
    const source = split && sources.get(split.namespace);
    return source ? source.readLive(split.field) : undefined;
  }

  function write(key, value) {
    const split = splitKey(key);
    const source = split && sources.get(split.namespace);
    if (!source) {
      throw new Error(`fade write to unknown key '${key}' — no source registered for its namespace`);
    }
    source.write(split.field, value);
  }

  /** Every fadeable key across every registered source, namespace-qualified
   * — what a future authoring UI (Cues, U3) would enumerate to build a
   * "fade to this configuration" picker from. */
  function allKeys() {
    const out = [];
    for (const [namespace, source] of sources) {
      for (const field of source.keys()) out.push(`${namespace}.${field}`);
    }
    return out;
  }

  return { registerSource, hasSource, typeOf, readLive, write, allKeys };
}
