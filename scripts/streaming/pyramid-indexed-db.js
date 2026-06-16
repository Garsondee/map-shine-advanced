/**
 * @fileoverview IndexedDB persistence for streamed texture pyramid tiles.
 * @module streaming/pyramid-indexed-db
 */

const DB_NAME = 'map-shine-streaming';
const DB_VERSION = 1;
const STORE = 'tiles';

/** @type {Promise<IDBDatabase>|null} */
let _openPromise = null;

/**
 * @returns {Promise<IDBDatabase|null>}
 */
function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (_openPromise) return _openPromise;
  _openPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
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
 * @param {string} key
 * @returns {Promise<Blob|null>}
 */
export async function idbGetTileBlob(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(String(key));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * @param {string} key
 * @param {Blob} blob
 * @returns {Promise<boolean>}
 */
export async function idbPutTileBlob(key, blob) {
  const db = await openDb();
  if (!db || !blob) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, String(key));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * @param {string} prefix
 * @returns {Promise<number>}
 */
export async function idbDeleteByPrefix(prefix) {
  const db = await openDb();
  if (!db) return 0;
  const pfx = String(prefix);
  return new Promise((resolve) => {
    let removed = 0;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
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
