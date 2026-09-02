/**
 * @fileoverview vt/baked-textures.js — client for build-time pre-baked BC1/BC7
 * sidecars (mythica-machina-press#439: bake once at module-build time instead
 * of asking every player's browser to encode). Looks for a `msa-baked/
 * manifest.json` near a source asset and, on a fresh hit, fetches and decodes
 * the sidecar instead of the caller ever touching the source image.
 *
 * DEGRADATION-FIRST, the same posture `compressed-textures.js`'s own header
 * states for the whole pipeline: no manifest, no entry, a stale entry, a
 * network error, a corrupt file — every one of these resolves `null`, and the
 * caller (`bc-compress.worker.js#handle`) falls through to the real
 * fetch+decode+encode path completely unchanged. A bake is an optimization no
 * scene may depend on existing; a map with no bake at all must render exactly
 * as it does today.
 *
 * FRESHNESS. A manifest entry records the source file's byte length at bake
 * time. Before trusting a hit, this issues a HEAD request on the ORIGINAL
 * source URL and compares Content-Length — the same cheap, no-download check
 * `bc-compress.worker.js`'s own `isSameResource` already uses for its
 * IndexedDB cache, and the same "an inconclusive check trusts the existing
 * data" posture: a baked file comes from a controlled build step, not a GM's
 * live re-upload, so the staleness risk here is smaller than the runtime
 * cache's, not larger.
 *
 * WALK-UP, NOT A HARD-CODED FOLDER NAME. The manifest is not assumed to live
 * under any specific directory (e.g. "assets/") — this looks in the asset's
 * own directory first, then a few parents up, for a `msa-baked/
 * manifest.json`. That matches the baker's own convention (one manifest per
 * module, sitting next to the assets it covers) without this file hard-coding
 * that module layout.
 */
import { decodeSidecar } from './baked-format.js';

/** How many parent directories to try before giving up. The baker writes one
 * manifest per module next to the assets it covers (typically one hop up
 * from a nested folder like "assets/scenes/") — this leaves headroom without
 * inviting an unrelated manifest several levels up to be treated as
 * authoritative for a file it never described. */
const MAX_WALK_UP = 4;

/** manifestUrl -> Promise<{entries:object}|null>, so N assets in the same
 * baked directory cost exactly one manifest fetch, not N. A 404/parse-failure
 * is cached too (as null) — a map with no bake at all must not re-probe its
 * own manifest URL once per texture request. */
const _manifestCache = new Map();

function stripQuery(url) {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}

function dirname(url) {
  const i = url.lastIndexOf('/');
  return i >= 0 ? url.slice(0, i) : '';
}

async function fetchManifest(dir, fetchFn) {
  const url = `${dir}/msa-baked/manifest.json`;
  if (_manifestCache.has(url)) return _manifestCache.get(url);
  const p = (async () => {
    try {
      const resp = await fetchFn(url);
      if (!resp.ok) return null;
      const json = await resp.json();
      return json && typeof json === 'object' && json.entries && typeof json.entries === 'object' ? json : null;
    } catch (_) {
      return null;
    }
  })();
  _manifestCache.set(url, p);
  return p;
}

/** Walk up from `src`'s own directory looking for a manifest that names it.
 * Stops at the FIRST manifest found, whether or not it lists `src` — a
 * manifest that exists but doesn't know this file means "not baked", not
 * "keep looking higher up" (this file's own header). */
async function findEntry(src, fetchFn) {
  const cleanSrc = stripQuery(src);
  let dir = dirname(cleanSrc);
  for (let i = 0; i < MAX_WALK_UP && dir; i++) {
    const manifest = await fetchManifest(dir, fetchFn);
    if (manifest) {
      const rel = cleanSrc.slice(dir.length + 1);
      const entry = manifest.entries[rel];
      return entry ? { manifestDir: dir, entry } : null;
    }
    dir = dirname(dir);
  }
  return null;
}

async function isFresh(src, entry, fetchFn) {
  if (!Number.isFinite(entry.sourceBytes)) return true; // nothing recorded to compare against ⇒ can't invalidate
  try {
    const resp = await fetchFn(src, { method: 'HEAD' });
    if (!resp.ok) return true; // inconclusive ⇒ trust the bake (isSameResource's own posture)
    const len = resp.headers.get('content-length');
    return len == null || Number(len) === entry.sourceBytes;
  } catch (_) {
    return true;
  }
}

/**
 * @param {string} src - root-absolute asset URL, the same string the runtime
 *   path fetches (may carry a query string; stripped for manifest lookups
 *   only, kept as-is for the HEAD freshness check and any diagnostics).
 * @param {{fetchFn?: typeof fetch}} [opts] - `fetchFn` is injected so this is
 *   Node-testable without a real server (mirrors `resolveAssetUrl`'s own
 *   injected-`getRouteFn` pattern in foundry/active-scene-source.js).
 * @returns {Promise<object|null>} the exact shape `bc-compress.worker.js#handle`
 *   returns from a live encode (`cached:false`), or `null` if there is no
 *   usable bake — the caller's contract is unchanged either way.
 */
export async function fetchBakedTexture(src, { fetchFn = fetch } = {}) {
  try {
    const found = await findEntry(src, fetchFn);
    if (!found) return null;
    const { manifestDir, entry } = found;
    if (!entry.file || (entry.format !== 'bc1' && entry.format !== 'bc7')) return null;
    if (!(await isFresh(src, entry, fetchFn))) return null;

    const sidecarUrl = `${manifestDir}/msa-baked/${entry.file}`;
    const resp = await fetchFn(sidecarUrl);
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    const decoded = await decodeSidecar(buf);
    if (decoded.format !== entry.format) return null; // manifest/file disagree — treat as corrupt, not fatal
    return { ...decoded, cached: false };
  } catch (_) {
    return null;
  }
}

/** Test-only: clears the manifest cache so repeated Node test runs (or a
 * long-lived page after a re-bake) don't see a stale 404. Not called from
 * production code. */
export function _clearBakedManifestCacheForTests() {
  _manifestCache.clear();
}
