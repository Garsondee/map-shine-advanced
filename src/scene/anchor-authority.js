/**
 * THE ANCHOR AUTHORITY — the single source of truth for SERVING discrete point
 * effects. Which anchors exist this scene (imported from V2 map points, or
 * authored later), each VALIDATED on the way in through the catalog, filtered
 * per consuming effect and floor. One instance, owned by boot, reset per scene.
 * The "place" sibling of scene/mask-authority.js's "paint".
 *
 * ============================================================================
 * WHERE IT SITS (injected, no new zone imports — the mask-authority pattern)
 * ============================================================================
 *
 *   foundry/v2-anchor-import ──(raw candidates)──▶ ┌───────────────┐
 *                                    boot hands ──▶│   AUTHORITY   │──▶ anchorsForEffect ──▶ effects/candle-flame
 *                                                  │  (this file)  │──▶ getReport ──▶ debug panel
 *                                                  └───────────────┘
 *
 * `foundry/` is a leaf and may not import `scene/`; the effects zone may not
 * reach the renderer. So the importer produces PLAIN raw candidates, boot (the
 * composition root) resets this authority with them, and the candle effect's
 * `apply` reads the served result. Nobody reaches sideways — exactly the
 * wiring the mask authority uses for discovery/ingest.
 *
 * ============================================================================
 * VALIDATE AT THE WRITE — no repair shop (Params.md §2, the V2 corpse)
 * ============================================================================
 *
 * V2's map points were repaired at the disk boundary (control-state-
 * sanitize.js, 333 lines) because nothing validated on the way in. Here, an
 * anchor is checked as it is ingested: an unknown kind, a non-finite position
 * or an out-of-range param is DROPPED and REPORTED — never silently coerced,
 * never stored. So a scene can carry no invalid anchor, so nothing needs
 * repairing on load. Per-anchor knobs hydrate through the catalog's params
 * schema, the same total, reporting path effect params use (core/params-
 * schema.js#hydrateParams).
 *
 * PURE + Node-testable: the log door is injected; no THREE, no Foundry, no
 * clock. A read always reflects every reset before it.
 *
 * @module scene/anchor-authority
 */

import { anchorKindById, anchorKindsForEffect, validateAnchorCatalog } from './anchor-catalog.js';
import { hydrateParams } from '../core/params-schema.js';

const REJECT_LOG_MAX = 20;

/**
 * @param {object} options
 * @param {{warn: Function, error: Function, info: Function}} options.log - the
 *   one log door (core/log.js), injected so this module stays Node-testable.
 */
export function createAnchorAuthority({ log }) {
  const catalog = validateAnchorCatalog();
  if (!catalog.ok) {
    // Same stance as the mask authority: a broken catalog degrades the anchors
    // (serve nothing), never the session. Say so loudly.
    log.error('anchor catalog INVALID — serving no anchors:', catalog.errors);
  }

  /** Scene-lifetime state; replaced wholesale by reset(). */
  let scene = emptyScene();
  let version = 0;
  const counters = { accepted: 0, rejected: 0 };
  const rejected = []; // {id, kind, reason} — bounded, reported (never hidden)

  function emptyScene() {
    return {
      sceneKey: null,
      anchors: new Map(), // id -> resolved anchor
    };
  }

  /**
   * Begin serving a scene's anchors. Everything from the previous scene is
   * dropped. Idempotent for a given input — the same candidates always resolve
   * to the same served set.
   *
   * @param {object} args
   * @param {string} args.sceneKey - stable identity for reports.
   * @param {Array<object>} [args.anchors] - RAW anchor candidates (from the V2
   *   importer or an author): `{ id, kind, x, y, floorBinding?, enabled?,
   *   params?, provenance? }`. Validated here; invalid ones are reported, not served.
   */
  function reset({ sceneKey, anchors = [] }) {
    scene = emptyScene();
    scene.sceneKey = sceneKey;
    counters.accepted = 0;
    counters.rejected = 0;
    rejected.length = 0;
    setAnchors(anchors);
    version++;
  }

  /**
   * Validate + store a set of raw candidates (reset uses this; a live authoring
   * tool would too). Replaces the current set.
   * @param {Array<object>} anchors
   */
  function setAnchors(anchors) {
    scene.anchors = new Map();
    for (const raw of Array.isArray(anchors) ? anchors : []) {
      const resolved = ingestOne(raw);
      if (resolved) scene.anchors.set(resolved.id, resolved);
    }
    version++;
  }

  /** @param {object} raw @returns {object|null} the resolved anchor, or null if rejected. */
  function ingestOne(raw) {
    const reject = (reason, idHint) => {
      counters.rejected++;
      if (rejected.length < REJECT_LOG_MAX) rejected.push({ id: idHint ?? raw?.id ?? '?', kind: raw?.kind, reason });
      return null;
    };

    if (!raw || typeof raw !== 'object') return reject('candidate is not an object');
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      return reject('missing a stable string id (the caller mints it — V2 group id + point index, or a UI id)');
    }
    const kind = anchorKindById(raw.kind);
    if (!kind) return reject(`unknown kind '${raw.kind}' — declare it in scene/anchor-catalog.js`);

    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return reject(`non-finite position (x=${raw.x}, y=${raw.y})`);

    // Per-anchor knobs hydrate + validate through the catalog schema; an invalid
    // stored value falls back to its default and is folded into the reject log
    // (reported, never a silent coerce).
    const { values: params, rejected: paramRejects } = hydrateParams(kind.params, raw.params ?? {});
    for (const pr of paramRejects) {
      counters.rejected++;
      if (rejected.length < REJECT_LOG_MAX) {
        rejected.push({ id: raw.id, kind: raw.kind, reason: `param '${pr.key}': ${pr.reason} (fell back to default)` });
      }
    }

    counters.accepted++;
    return {
      id: raw.id,
      kind: kind.id,
      effectId: kind.effectId,
      x,
      y,
      floorBinding: normalizeFloorBinding(raw.floorBinding),
      enabled: raw.enabled === false ? false : true,
      params,
      provenance: raw.provenance === 'importedFromV2' ? 'importedFromV2' : 'authored',
    };
  }

  /**
   * The consumer's read: every enabled anchor a given effect renders, filtered
   * to a floor context. `floorContext` null (or absent) serves ALL floors — the
   * "show me everything" default the report and a floor-agnostic effect want.
   *
   * @param {string} effectId - the consuming effect's registry id.
   * @param {{elevation?: number}|null} [floorContext]
   * @returns {Array<object>} resolved anchors (id, kind, x, y, params, floorBinding, provenance).
   */
  function anchorsForEffect(effectId, floorContext = null) {
    const kinds = new Set(anchorKindsForEffect(effectId).map((k) => k.id));
    if (kinds.size === 0) return [];
    const out = [];
    for (const a of scene.anchors.values()) {
      if (!kinds.has(a.kind) || !a.enabled) continue;
      // The anchor's own cross-floor override, if its kind declares one — see
      // `floorMatches`. Read off the hydrated params, so an anchor whose kind
      // has no such param simply passes `undefined` and gets the old behaviour.
      if (!floorMatches(a.floorBinding, floorContext, a.params?.floorVisibility)) continue;
      out.push(a);
    }
    return out;
  }

  /** The debug-panel report payload — the whole story, one click. */
  function getReport() {
    const byKind = {};
    for (const a of scene.anchors.values()) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    return {
      catalog: { ok: catalog.ok, errors: catalog.errors },
      sceneKey: scene.sceneKey,
      version,
      served: scene.anchors.size,
      byKind,
      counters: { ...counters },
      rejected: [...rejected],
      // Enough to eyeball "did placement land where the old candles were" — a
      // handful of candles, so listing them all is cheap and is the whole point.
      anchors: [...scene.anchors.values()].map((a) => ({
        id: a.id,
        kind: a.kind,
        x: Math.round(a.x),
        y: Math.round(a.y),
        floor: a.floorBinding.mode,
        // The locked elevation band, surfaced so per-floor filtering can be
        // verified (distinct bands per floor → filtering separates them).
        floorBand: a.floorBinding.mode === 'locked' ? [a.floorBinding.bottom, a.floorBinding.top] : null,
        provenance: a.provenance,
      })),
    };
  }

  /**
   * Add (or upsert, by id) ONE anchor — the live-authoring counterpart to
   * `reset`'s wholesale load. Same validate-at-write path as ingest
   * (`ingestOne`): a bad candidate is dropped and reported, never stored.
   * @param {object} raw - same shape `reset`'s `anchors` entries take.
   * @returns {object|null} the resolved anchor, or null if rejected.
   */
  function addAnchor(raw) {
    const resolved = ingestOne(raw);
    if (resolved) {
      scene.anchors.set(resolved.id, resolved);
      version++;
    }
    return resolved;
  }

  /**
   * Remove one anchor by id. A no-op (returns false) if it was never served —
   * deleting twice, or deleting something rejected at ingest, is not an error.
   * @param {string} id
   * @returns {boolean} whether an anchor was actually removed.
   */
  function removeAnchor(id) {
    const existed = scene.anchors.delete(id);
    if (existed) version++;
    return existed;
  }

  /**
   * Patch one anchor's fields (position/floor/enabled/params) and re-validate
   * the WHOLE result through the same `ingestOne` gate a fresh candidate goes
   * through — an edit that would make the anchor invalid is rejected exactly
   * like a bad import, never half-applied. `patch.params` merges onto the
   * anchor's CURRENT params (a partial update); everything else replaces.
   * @param {string} id
   * @param {{x?:number, y?:number, floorBinding?:object, enabled?:boolean, params?:object}} patch
   * @returns {object|null} the resolved anchor, or null if it doesn't exist or the patch is invalid.
   */
  function updateAnchor(id, patch = {}) {
    const existing = scene.anchors.get(id);
    if (!existing) return null;
    // PRESENCE, not validity, decides what carries forward: a key the caller
    // never mentioned keeps its existing (already-valid) value, but a key the
    // caller DID provide flows through verbatim to ingestOne below, garbage
    // included — so a bad explicit value is REJECTED (the whole update fails,
    // reported), never silently swapped back to the old one, which would look
    // identical to "the edit worked" from the caller's side.
    const has = (k) => patch && Object.prototype.hasOwnProperty.call(patch, k);
    const merged = {
      id: existing.id,
      kind: existing.kind,
      x: has('x') ? patch.x : existing.x,
      y: has('y') ? patch.y : existing.y,
      floorBinding: has('floorBinding') ? patch.floorBinding : existing.floorBinding,
      enabled: has('enabled') ? patch.enabled : existing.enabled,
      params: { ...existing.params, ...(patch?.params ?? {}) },
      provenance: existing.provenance,
    };
    const resolved = ingestOne(merged);
    if (resolved) {
      scene.anchors.set(resolved.id, resolved);
      version++;
    }
    return resolved;
  }

  return { reset, setAnchors, addAnchor, removeAnchor, updateAnchor, anchorsForEffect, getReport };
}

/**
 * Merge V2-imported anchor CANDIDATES (non-destructive, re-read every scene
 * load — `foundry/v2-anchor-import.js`) with the AUTHORED overlay (added
 * anchors, edits, removals — persisted separately, `foundry/anchor-adapter.js`)
 * into the one candidate list `reset({anchors})` should serve. Pure: the boot-
 * owned join between two read-only sources feeding the one authority.
 *
 * An override is keyed by anchor id, so editing a V2-imported candle (its
 * stable `v2:<groupId>:<index>` id, `v2-anchor-import.js`'s own doc) and
 * editing a freshly-authored one (a UI-minted id) go through the SAME path:
 * an id present in both `v2Candidates` and `overrides` is the V2 candidate
 * with the override's fields layered on top (so an edit that only touches
 * colour does not have to repeat position/floor); an id present ONLY in
 * `overrides` is a brand-new authored anchor; an id in `removed` is dropped
 * regardless of which source it came from.
 *
 * @param {Array<object>} v2Candidates - `importV2Anchors(...).anchors`.
 * @param {{overrides?: Record<string, object>, removed?: string[]}} [authoredPayload] - `loadAuthoredAnchors()`'s result (or null/absent — a scene with no authoring yet).
 * @returns {Array<object>} the merged candidate list, ready for `reset({anchors})`.
 */
export function mergeAnchorSources(v2Candidates, authoredPayload) {
  const overrides =
    authoredPayload?.overrides && typeof authoredPayload.overrides === 'object' ? authoredPayload.overrides : {};
  const removed = new Set(Array.isArray(authoredPayload?.removed) ? authoredPayload.removed : []);
  const seenIds = new Set();
  const out = [];

  for (const v2 of Array.isArray(v2Candidates) ? v2Candidates : []) {
    if (!v2 || typeof v2.id !== 'string') continue;
    seenIds.add(v2.id);
    if (removed.has(v2.id)) continue;
    const override = overrides[v2.id];
    out.push(
      override && typeof override === 'object'
        ? { ...v2, ...override, params: { ...v2.params, ...override.params } }
        : v2
    );
  }

  for (const [id, entry] of Object.entries(overrides)) {
    if (seenIds.has(id) || removed.has(id) || !entry || typeof entry !== 'object') continue;
    out.push({ ...entry, id });
  }

  return out;
}

/**
 * The closest anchor to a world point, within `maxDistPx` — pure hit-testing
 * for the placement UI's "clicked an existing candle vs. clicked empty map"
 * decision. Ties keep the FIRST closest found (stable for a stable input order).
 * @param {Array<{id:string, x:number, y:number}>} anchors
 * @param {number} x @param {number} y @param {number} maxDistPx
 * @returns {object|null}
 */
export function nearestAnchor(anchors, x, y, maxDistPx) {
  let best = null;
  let bestDist = Number.isFinite(maxDistPx) ? maxDistPx : Infinity;
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const dx = Number(a?.x) - Number(x);
    const dy = Number(a?.y) - Number(y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Normalise a floor binding to `{ mode, bottom, top, floorKey }`. Mirrors V2's
 * LevelBinding (legacy/scene/map-points-manager.js:75) — 'all-levels' (globally
 * visible) or 'locked' (an inclusive elevation band). Anything unrecognised
 * degrades to 'all-levels' (visible), never to a hidden anchor.
 * @param {object} [b]
 * @returns {{mode: 'all-levels'|'locked', bottom: number|null, top: number|null, floorKey: string|null}}
 */
function normalizeFloorBinding(b) {
  const mode = b?.mode === 'locked' ? 'locked' : 'all-levels';
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    mode,
    bottom: mode === 'locked' ? num(b?.bottom) : null,
    top: mode === 'locked' ? num(b?.top) : null,
    floorKey: typeof b?.floorKey === 'string' ? b.floorKey : null,
  };
}

/**
 * Does an anchor's floor binding admit this floor context? 'all-levels' always;
 * 'locked' if the context elevation sits within the inclusive band (a null
 * bound is open-ended). A null context means "no floor filter" → always visible
 * (the report + floor-agnostic reads). Deliberately simple for Tier 0: the
 * full token-vision / active-floor context is the effect's concern later, not
 * this filter's.
 *
 * `visibility` (2026-08-01) is the anchor's OWN author-facing override of a
 * locked binding — `scene/anchor-catalog.js`'s `floorVisibility` param, added
 * because a candle bound to the ground floor vanished from the floor above with
 * no way for an author to say "no, this one should be visible through the
 * stairwell". It only ever WIDENS what a locked band admits; it can never hide
 * an anchor the binding would have shown, so an anchor kind that has no such
 * param (lightning, and every future kind until it asks for one) behaves
 * exactly as before.
 *
 * @param {{mode: string, bottom: number|null, top: number|null}} binding
 * @param {{elevation?: number}|null} context
 * @param {'own-floor'|'own-and-above'|'all-floors'} [visibility] - absent or
 *   unrecognised reads as 'own-floor', i.e. the pre-existing behaviour.
 * @returns {boolean}
 */
function floorMatches(binding, context, visibility = 'own-floor') {
  if (binding.mode !== 'locked') return true;
  // Opted out of floor binding entirely — the author has taken responsibility
  // for this one anchor (see the param's own help text).
  if (visibility === 'all-floors') return true;
  if (!context || !Number.isFinite(Number(context.elevation))) return true;
  const e = Number(context.elevation);
  if (binding.bottom !== null && e < binding.bottom) return false;
  // LOOKING DOWN FROM ABOVE is the whole reported case: a viewer higher than
  // this anchor's band still sees it. Below the band stays hidden either way —
  // you cannot see a candle on the floor above through its own ceiling, and
  // widening that direction too would have been a guess nobody asked for.
  if (binding.top !== null && e > binding.top) return visibility === 'own-and-above';
  return true;
}
