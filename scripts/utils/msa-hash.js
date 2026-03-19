/**
 * @fileoverview Deterministic hash utilities for Map Shine Advanced config verification.
 *
 * Used to fingerprint MSA scene/tile settings so that the exact same configuration
 * always produces the same hash token. Authors record the hash when packing a map;
 * importers recompute it after import to confirm the config survived the round-trip.
 *
 * @module utils/msa-hash
 */

/**
 * Produce a deterministic JSON string from any value by sorting object keys
 * recursively and handling circular references. The `_expectedHash` sentinel
 * key is excluded so the hash is always of the "content" only.
 *
 * @param {*} value
 * @returns {string}
 */
export function msaStableStringify(value) {
  const seen = new WeakSet();

  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null; // break circular refs
    seen.add(v);

    if (Array.isArray(v)) return v.map(walk);

    const out = {};
    // Sort keys for determinism; exclude the hash sentinel itself.
    const keys = Object.keys(v).filter(k => k !== '_expectedHash').sort();
    for (const k of keys) out[k] = walk(v[k]);
    return out;
  };

  return JSON.stringify(walk(value));
}

/**
 * Compute an 8-character SHA-256 fingerprint of the given object.
 *
 * The hash is deterministic: the same config (regardless of key insertion order)
 * always produces the same token. The `_expectedHash` key is excluded from the
 * input so that embedding the hash into the config doesn't invalidate it.
 *
 * @param {object} obj - MSA config to fingerprint (scene flags and/or tile flags)
 * @returns {Promise<string>} 8-char lowercase hex string (e.g. 'a3f8c21d')
 */
export async function msaComputeHash(obj) {
  try {
    const str = msaStableStringify(obj);
    const encoded = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    // First 4 bytes → 8 hex chars: enough entropy to catch any real mismatch
    return hashArray.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    console.warn('Map Shine: hash computation failed:', e);
    return 'xxxxxxxx';
  }
}
