/**
 * @fileoverview World-scoped loading screen hint entries and selection helpers.
 * @module ui/loading-screen/loading-hints
 */

const MODULE_ID = 'map-shine-advanced';
export const LOADING_SCREEN_HINTS_SETTING = 'loadingScreenHints';

export const DEFAULT_HINT_INTERVAL_MS = 10000;
export const DEFAULT_HINT_FADE_MS = 600;

/**
 * @returns {Array<{id:string,text:string,enabled:boolean}>}
 */
export function createDefaultLoadingHints() {
  return [
    {
      id: 'hint-welcome',
      text: 'Welcome — your scene is loading. Explore when you arrive!',
      enabled: true,
    },
    {
      id: 'hint-journal',
      text: 'Check the Journal tab for handouts and lore the GM has shared.',
      enabled: true,
    },
    {
      id: 'hint-compendium',
      text: 'Compendium packs hold spells, items, and actors you can drag onto the sheet.',
      enabled: true,
    },
  ];
}

/**
 * @param {any} entry
 * @returns {{id:string,text:string,enabled:boolean}|null}
 */
export function normalizeHintEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const text = String(entry.text || '').trim();
  if (!text) return null;
  return {
    id: String(entry.id || cryptoSafeId()).trim() || cryptoSafeId(),
    text,
    enabled: entry.enabled !== false,
  };
}

/**
 * @param {any} input
 * @returns {Array<{id:string,text:string,enabled:boolean}>}
 */
export function normalizeHintsList(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => normalizeHintEntry(entry))
    .filter(Boolean);
}

/**
 * Read enabled hints from world settings (safe before/after init).
 * @returns {Array<{id:string,text:string,enabled:boolean}>}
 */
export function getEnabledLoadingHints() {
  try {
    if (!globalThis.game?.settings?.get) return [];
    const raw = game.settings.get(MODULE_ID, LOADING_SCREEN_HINTS_SETTING);
    return normalizeHintsList(raw).filter((h) => h.enabled !== false);
  } catch (_) {
    return [];
  }
}

/**
 * @returns {Array<{id:string,text:string,enabled:boolean}>}
 */
export function getAllLoadingHints() {
  try {
    if (!globalThis.game?.settings?.get) return createDefaultLoadingHints();
    const raw = game.settings.get(MODULE_ID, LOADING_SCREEN_HINTS_SETTING);
    const list = normalizeHintsList(raw);
    return list.length ? list : createDefaultLoadingHints();
  } catch (_) {
    return createDefaultLoadingHints();
  }
}

/**
 * @param {number} length
 * @param {number} [excludeIndex]
 * @returns {number}
 */
export function pickRandomHintIndex(length, excludeIndex = -1) {
  if (length <= 0) return -1;
  if (length === 1) return 0;
  let idx = Math.floor(Math.random() * length);
  let guard = 0;
  while (idx === excludeIndex && guard++ < 12) {
    idx = Math.floor(Math.random() * length);
  }
  return idx;
}

/**
 * @param {Object} props
 * @returns {Object}
 */
export function normalizeLoadingHintsElementProps(props) {
  const source = props && typeof props === 'object' ? props : {};
  return {
    prefix: String(source.prefix ?? 'Tip: '),
    intervalMs: clamp(Number(source.intervalMs) || DEFAULT_HINT_INTERVAL_MS, 2000, 120000),
    fadeMs: clamp(Number(source.fadeMs) || DEFAULT_HINT_FADE_MS, 0, 4000),
    shuffle: source.shuffle !== false,
    emptyText: String(source.emptyText || 'Add loading hints in Map Shine → Loading Screens.'),
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v)));
}

function cryptoSafeId() {
  try {
    if (globalThis.crypto?.randomUUID) return `hint-${globalThis.crypto.randomUUID()}`;
  } catch (_) {
  }
  return `hint-${Math.random().toString(36).slice(2, 10)}`;
}
