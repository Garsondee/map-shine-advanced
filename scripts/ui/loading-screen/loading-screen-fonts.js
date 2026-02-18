/**
 * @fileoverview Loading screen font helpers (Foundry + Google Fonts).
 * @module ui/loading-screen/loading-screen-fonts
 */

const GOOGLE_LINK_PREFIX = 'map-shine-loading-google-font-';

/**
 * Load configured font families (Google) non-blocking, with timeout.
 * @param {string[]} families
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<void>}
 */
export async function loadConfiguredFonts(families, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(250, options.timeoutMs) : 3000;
  const list = Array.isArray(families) ? families.map((f) => String(f || '').trim()).filter(Boolean) : [];
  if (list.length === 0) return;

  const linkTasks = list.map((familySpec) => ensureGoogleFontLink(familySpec));
  await Promise.race([
    Promise.allSettled(linkTasks).then(() => waitForDocumentFontsReady()),
    sleep(timeoutMs),
  ]);
}

/**
 * Get a sorted list of available font-family names from browser + Foundry hints.
 * @returns {string[]}
 */
export function getAvailableFontFamilies() {
  const set = new Set();

  // Practical defaults present in Foundry/theme contexts.
  ['Signika', 'Modesto Condensed', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'system-ui', 'sans-serif', 'serif', 'monospace']
    .forEach((f) => set.add(f));

  try {
    const docFonts = document?.fonts;
    if (docFonts?.forEach) {
      docFonts.forEach((fontFace) => {
        const family = String(fontFace?.family || '').replace(/^['\"]|['\"]$/g, '').trim();
        if (family) set.add(family);
      });
    }
  } catch (_) {
  }

  // If Foundry exposes known available list, merge it.
  try {
    const choices = globalThis?.foundry?.applications?.settings?.menus?.FontConfig?.getAvailableFonts?.();
    if (Array.isArray(choices)) {
      for (const c of choices) {
        const value = String(c || '').trim();
        if (value) set.add(value);
      }
    }
  } catch (_) {
  }

  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} familySpec
 * @returns {HTMLLinkElement|null}
 */
export function ensureGoogleFontLink(familySpec) {
  const clean = String(familySpec || '').trim();
  if (!clean) return null;

  const id = `${GOOGLE_LINK_PREFIX}${slug(clean)}`;
  const head = document.head || document.documentElement;
  if (!head) return null;

  const existing = head.querySelector(`#${cssEscape(id)}`);
  if (existing) return /** @type {HTMLLinkElement} */ (existing);

  const encoded = encodeGoogleFamilySpec(clean);
  const href = `https://fonts.googleapis.com/css2?family=${encoded}&display=swap`;

  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  link.crossOrigin = 'anonymous';
  head.appendChild(link);
  return link;
}

/**
 * @param {string} familySpec
 * @returns {string}
 */
export function familySpecToFamilyName(familySpec) {
  const clean = String(familySpec || '').trim();
  if (!clean) return '';
  return clean.split(':')[0].trim();
}

function encodeGoogleFamilySpec(spec) {
  // Accept syntax like "Cinzel:wght@400;700" and transform spaces.
  return spec.replace(/\s+/g, '+');
}

function waitForDocumentFontsReady() {
  try {
    const ready = document?.fonts?.ready;
    if (ready && typeof ready.then === 'function') return ready;
  } catch (_) {
  }
  return Promise.resolve();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'font';
}

function cssEscape(value) {
  try {
    return CSS?.escape ? CSS.escape(value) : value;
  } catch (_) {
    return value;
  }
}
