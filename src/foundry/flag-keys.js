/**
 * DOTTED KEYS IN SCENE FLAGS — Foundry's document update path runs every
 * update through `expandObject`, which turns ANY dotted key, at any depth,
 * into a nested path. A flat map stored with `setFlag` therefore reads back
 * nested:
 *
 *   write  { 'weather.cloudCover01': { to: 0.6, ... } }
 *   read   { weather: { cloudCover01: { to: 0.6, ... } } }
 *
 * The fade state and each cue's `targets` are exactly such flat maps (keys
 * are fade-source ids like `weather.cloudCover01`). Read back unrepaired, the
 * fade state filtered down to nothing (so a GM's weather fade never eased on
 * a player's client, and an in-flight fade vanished on reload), and every
 * cue failed validation the moment its first flag echo landed — GO refused
 * it (UI test pass, 2026-09-26).
 *
 * `flattenDottedLeaves` is the read-side repair: it walks the nested shape
 * back down to the original dotted keys, stopping at the first object that
 * `isLeaf` recognises as a value. Already-flat input passes through
 * unchanged, so it is safe on legacy and fresh data alike.
 *
 * @module foundry/flag-keys
 */

/**
 * @param {unknown} obj - the flag value as read back from Foundry.
 * @param {(v: object) => boolean} isLeaf - true for a map VALUE (e.g. an
 *   object with its own `to`), which is kept whole rather than walked into.
 * @returns {Record<string, unknown>}
 */
export function flattenDottedLeaves(obj, isLeaf) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && !isLeaf(v)) walk(v, key);
      else out[key] = v;
    }
  };
  walk(obj, '');
  return out;
}

/** A fade entry / cue target: the one field both always carry is `to`. */
export const hasOwnTo = (v) => Object.prototype.hasOwnProperty.call(v, 'to');
