/**
 * THE MARKER-OVERLAY REGISTRY — the ONE door for "what world-space points
 * should a live diagnostic overlay draw right now."
 *
 * ============================================================================
 * WHY THIS IS GENERIC, NOT CANDLE-SPECIFIC
 * ============================================================================
 *
 * The candle's Tier-0 placement proof (a one-shot teardrop overlay in
 * vt-pan-viewer.js#drawWorldMarkers) answered "did the V2 import land in the
 * right spot" but went stale on pan/zoom — it computed positions once, at
 * click time. The author's own framing on seeing it (2026-07-20): "a
 * diagnostic UI would actually be very useful for this module so as long as
 * we can make it generically useful for all effects." So this is NOT "the
 * candle overlay, upgraded" — it is the anchor/mask-authority PATTERN applied
 * to on-screen diagnostics: any effect (candle now; lightning points, rope
 * endpoints, a region's authored shape later) registers a named POINT SOURCE
 * here — `{ getPoints, color, label }` — and ONE live tracking loop (vt-pan-
 * viewer.js's `startVtPanViewerLiveMarkers`, driven from here) draws every
 * registered source every frame it is armed, against the current view. A
 * second effect wanting its own overlay is one `registerMarkerSource` call,
 * not a second hand-rolled DOM loop — the velocity test (Effect-
 * Registration.md §6) applied to a diagnostic instead of a render pass.
 *
 * `diag/` is exempt as an import TARGET from `zones/one-door` (tools/verify-
 * structure.mjs's own note), so any zone — effects/, foundry/, boot itself —
 * can register a source directly without a barrel detour.
 *
 * PURE + Node-testable: no THREE, no DOM, no Foundry. The registry stores
 * closures and calls them; drawing is vt-pan-viewer.js's job, injected the
 * same way the mask authority receives `resolvePlacement`.
 *
 * @module diag/marker-overlay
 */

/**
 * @typedef {object} MarkerSource
 * @property {string} label - human name, for a future source-picker UI.
 * @property {string} color - CSS colour string for every point from this source.
 * @property {() => Array<{x:number, y:number}>} getPoints - called once per
 *   overlay tick; MUST be cheap (a live-tracking loop calls it every frame
 *   while armed) — a wrapper over an already-served list (e.g. `anchorAuthority
 *   .anchorsForEffect(...)`), never a fresh computation.
 */

/** @type {Map<string, MarkerSource>} */
const sources = new Map();

/**
 * Register a named point source. Registering the SAME id again replaces the
 * previous registration (a scene reload re-registering its own source is the
 * common case, not an error — unlike the effect registry, there is no
 * "already registered" throw here: a diagnostic re-declaring itself is
 * routine, not a bug).
 *
 * @param {string} id - stable identity (e.g. an effect id: 'candleFlame').
 * @param {MarkerSource} source
 */
export function registerMarkerSource(id, source) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('registerMarkerSource: id must be a non-empty string');
  }
  if (!source || typeof source.getPoints !== 'function') {
    throw new Error(`registerMarkerSource('${id}'): needs a getPoints() function`);
  }
  sources.set(id, {
    label: typeof source.label === 'string' && source.label.length > 0 ? source.label : id,
    color: typeof source.color === 'string' && source.color.length > 0 ? source.color : '#ffaa00',
    getPoints: source.getPoints,
  });
}

/** @param {string} id */
export function unregisterMarkerSource(id) {
  sources.delete(id);
}

/** @returns {Array<{id:string, label:string, color:string}>} every registered source, for a future picker UI. */
export function listMarkerSources() {
  return [...sources.entries()].map(([id, s]) => ({ id, label: s.label, color: s.color }));
}

/**
 * Flatten every registered source's CURRENT points into one draw list. A
 * source whose `getPoints` throws is SKIPPED and reported via the injected
 * `onError` — never lets one bad provider blank every other effect's markers
 * (the same "a failed read degrades, never crashes the whole thing" stance
 * effect-cascade.js's resolver takes).
 *
 * @param {{onError?: (id:string, err:unknown) => void}} [opts]
 * @returns {Array<{x:number, y:number, color:string, sourceId:string}>}
 */
export function getAllMarkerPoints({ onError } = {}) {
  const out = [];
  for (const [id, source] of sources) {
    let points;
    try {
      points = source.getPoints();
    } catch (err) {
      onError?.(id, err);
      continue;
    }
    if (!Array.isArray(points)) continue;
    for (const p of points) {
      const x = Number(p?.x);
      const y = Number(p?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y, color: source.color, sourceId: id });
    }
  }
  return out;
}

/** Test-only: drop every registration (each `__tests__` run starts clean). */
export function _clearMarkerSourcesForTest() {
  sources.clear();
}
