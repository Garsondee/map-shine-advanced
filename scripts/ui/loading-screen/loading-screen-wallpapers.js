/**
 * @fileoverview Wallpaper selection and preload helpers for loading screens.
 * @module ui/loading-screen/loading-screen-wallpapers
 */

const SESSION_FIRST_LOAD_KEY = 'map-shine-advanced.loading.firstLoadDone';
const SESSION_SEQ_INDEX_KEY = 'map-shine-advanced.loading.wallpaperSeqIndex';

/** @type {Map<string, HTMLImageElement>} */
const imageCache = new Map();

/**
 * @param {Object} wallpapers
 * @param {{isFirstLoad?: boolean}} [options]
 * @returns {Object|null}
 */
export function selectWallpaper(wallpapers, options = {}) {
  const entries = Array.isArray(wallpapers?.entries)
    ? wallpapers.entries.filter((e) => e && String(e.src || '').trim())
    : [];

  if (entries.length === 0) return null;

  const isFirstLoad = options.isFirstLoad === true;
  if (isFirstLoad) {
    const pinned = entries.find((e) => e.pinToFirstLoad === true);
    if (pinned) return pinned;
  }

  const mode = String(wallpapers?.mode || 'single');
  if (mode === 'single') return entries[0];

  if (mode === 'sequential') {
    const idx = getAndAdvanceSequenceIndex(entries.length);
    return entries[idx] || entries[0];
  }

  // Weighted random fallback.
  let total = 0;
  for (const entry of entries) total += normalizeWeight(entry.weight);
  if (total <= 0) return entries[0];

  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= normalizeWeight(entry.weight);
    if (roll <= 0) return entry;
  }

  return entries[entries.length - 1];
}

/**
 * @param {Object} wallpapers
 * @param {{decodeTimeoutMs?: number}} [options]
 * @returns {Promise<void>}
 */
export async function preloadWallpapers(wallpapers, options = {}) {
  const entries = Array.isArray(wallpapers?.entries)
    ? wallpapers.entries.filter((e) => e && String(e.src || '').trim())
    : [];

  const timeoutMs = Number.isFinite(options.decodeTimeoutMs) ? Math.max(100, options.decodeTimeoutMs) : 2500;
  if (entries.length === 0) return;

  await Promise.allSettled(entries.map((entry) => loadImage(entry.src, timeoutMs)));
}

/**
 * @param {string} src
 * @returns {HTMLImageElement|null}
 */
export function getCachedWallpaperImage(src) {
  const key = String(src || '').trim();
  if (!key) return null;
  return imageCache.get(key) || null;
}

/**
 * @returns {boolean}
 */
export function isFirstLoadOfSession() {
  try {
    const done = sessionStorage.getItem(SESSION_FIRST_LOAD_KEY);
    if (done === '1') return false;
    sessionStorage.setItem(SESSION_FIRST_LOAD_KEY, '1');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} src
 * @param {number} timeoutMs
 * @returns {Promise<HTMLImageElement|null>}
 */
export async function loadImage(src, timeoutMs = 2500) {
  const key = String(src || '').trim();
  if (!key) return null;
  const cached = imageCache.get(key);
  if (cached) return cached;

  const img = new Image();
  img.decoding = 'async';
  img.loading = 'eager';

  const loaded = new Promise((resolve) => {
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
  });

  img.src = key;

  const result = await Promise.race([
    loaded,
    sleep(timeoutMs).then(() => null),
  ]);

  if (!result) return null;

  try {
    if (typeof img.decode === 'function') {
      await Promise.race([img.decode().catch(() => {}), sleep(timeoutMs)]);
    }
  } catch (_) {
  }

  imageCache.set(key, img);
  return img;
}

function normalizeWeight(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(10, Number(value)));
}

function getAndAdvanceSequenceIndex(length) {
  if (length <= 1) return 0;
  try {
    const current = Number.parseInt(sessionStorage.getItem(SESSION_SEQ_INDEX_KEY) || '0', 10);
    const idx = Number.isFinite(current) ? Math.max(0, current) % length : 0;
    sessionStorage.setItem(SESSION_SEQ_INDEX_KEY, String((idx + 1) % length));
    return idx;
  } catch (_) {
    return 0;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
