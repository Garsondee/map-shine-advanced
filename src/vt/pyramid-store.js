/**
 * @fileoverview vt/pyramid-store.js — IndexedDB persistence for sliced VT pages
 * (Keyhole.md §4.1: "First encounter with an asset slices it once ... persists
 * to IndexedDB keyed by URL+mtime; every later load streams pages only").
 *
 * HARVESTED from legacy/streaming/pyramid-indexed-db.js (git mv, history
 * preserved) — the generic key→Blob store is unchanged in substance; only
 * renamed to page-oriented names and given `pageStoreKey()`. This is the
 * persistence layer that lets `decode-pool.js` slice a source image to pages
 * ONCE and then RELEASE the full bitmap: every later page request comes from
 * here (a tiny 256² blob) instead of re-holding a 576 MB source bitmap. That is
 * what bounds decode-heap memory to `O(decode ring)` instead of
 * `O(layers × floors × world²)` — the fix for the multi-layer decode-memory
 * ceiling (a 12000² image is ~576 MB decoded; holding 20+ of them at once
 * exhausted the browser decode heap, observed live 2026-07-15).
 *
 * Fails soft everywhere: if IndexedDB is unavailable or a transaction errors,
 * every function resolves to null/false and the caller falls back to slicing
 * from the source. Persistence is an optimization, never a correctness
 * dependency.
 *
 * @module vt/pyramid-store
 */

const DB_NAME = 'map-shine-vt-pages';
const DB_VERSION = 1;
const STORE = 'pages';

/** @type {Promise<IDBDatabase|null>|null} */
let _openPromise = null;

// POOL HEALTH (cache-completeness pass, 2026-08-12) — module-level, not
// closure-local: unlike every other cache in this codebase, this module
// exports bare functions with no factory/enclosing scope to hold counters
// in. hits/misses are getPageBlob's own READ outcome (a real Blob found vs
// not — the caller falls back to slicing from source on a miss, this
// module's own header); writes/writeFailures are putPageBlob's own outcome.
// A `db` unavailable/transaction-error read is NEITHER a hit nor a miss —
// no cache decision was possible, same doctrine every bake-gate in this
// pass uses for its own "not ready" branch.
let _pageHits = 0;
let _pageMisses = 0;
let _pageWrites = 0;
let _pageWriteFailures = 0;

/** @returns {Promise<IDBDatabase|null>} */
function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (_openPromise) return _openPromise;
  _openPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
  return _openPromise;
}

/**
 * The canonical persistence key for one page of one source. Includes the source
 * URL so different layers/floors never collide, and the page's mip/coordinates.
 * (URL already encodes the module path; add an mtime/version segment here later
 * if authored assets ever change under a stable URL — §4.1's "URL+mtime".)
 * @param {string} url @param {number} mip @param {number} px @param {number} py
 * @returns {string}
 */
export function pageStoreKey(url, mip, px, py) {
  return `${url}|m${mip}|${px},${py}`;
}

/** @param {string} key @returns {Promise<Blob|null>} */
export async function getPageBlob(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(String(key));
      req.onsuccess = () => {
        if (req.result) _pageHits += 1;
        else _pageMisses += 1;
        resolve(req.result ?? null);
      };
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

/** @param {string} key @param {Blob} blob @returns {Promise<boolean>} */
export async function putPageBlob(key, blob) {
  const db = await openDb();
  if (!db || !blob) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, String(key));
      tx.oncomplete = () => {
        _pageWrites += 1;
        resolve(true);
      };
      tx.onerror = () => {
        _pageWriteFailures += 1;
        resolve(false);
      };
    } catch (_) {
      resolve(false);
    }
  });
}

/** Snapshot of this module's own read/write counters — for the perf
 * report's cache-health pass. Lifetime counters; a caller wanting one
 * window's rate samples before/after, same convention as
 * `depth-proxy-material-pool.js`. */
export function getPyramidStoreStats() {
  return { hits: _pageHits, misses: _pageMisses, writes: _pageWrites, writeFailures: _pageWriteFailures };
}

/**
 * Evict every persisted page whose key starts with `prefix` (e.g. all pages of
 * one source URL). @param {string} prefix @returns {Promise<number>} removed count.
 */
export async function deletePagesByPrefix(prefix) {
  const db = await openDb();
  if (!db) return 0;
  const pfx = String(prefix);
  return new Promise((resolve) => {
    let removed = 0;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(pfx)) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => resolve(removed);
    } catch (_) {
      resolve(removed);
    }
  });
}
