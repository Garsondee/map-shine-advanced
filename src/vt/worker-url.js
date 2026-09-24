/**
 * WORKER FETCH URLS (2026-09-24, mythica-machina-press#618).
 *
 * A module worker resolves a RELATIVE url against its OWN script location
 * (`modules/map-shine-advanced/src/vt/`), not the page's. Foundry hands out
 * asset paths page-relative (`modules/<map>/assets/x.webp`), so the main thread
 * fetched them fine while the very same string 404'd inside the worker —
 * #618's "reproducible 404 from inside the worker only".
 *
 * Fix: the main thread sends its own `document.baseURI` with every request and
 * the worker resolves against THAT, only at fetch time. The url string itself
 * is left untouched everywhere else, because both workers use it as a cache
 * key — rewriting it would silently invalidate every player's existing cache.
 */

/** The page's base URL, or null outside a document (tests, workers). */
export function pageBaseUrl() {
  return typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : null;
}

/**
 * Resolve `url` against the page base for a fetch from inside a worker.
 * Absolute and root-absolute urls resolve to the same place they always did;
 * only a page-relative one changes (from a guaranteed 404 to the right file).
 * @param {string} url
 * @param {string|null|undefined} base
 */
export function resolveAgainstPage(url, base) {
  if (!base || typeof url !== 'string') return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
