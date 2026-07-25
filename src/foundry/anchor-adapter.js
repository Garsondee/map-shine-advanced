/**
 * ANCHOR ADAPTER — the ONE place authored anchor data (added/edited/removed
 * candles, and whatever anchor kind comes next) is read from or written to the
 * active scene's flags. Mirrors `paint-adapter.js`'s `savePaintedMasks`/
 * `loadPaintedMasks` exactly (same shape, same scene-flag storage, same
 * "no active scene -> a reported failure, never a throw" stance) — anchors are
 * the "place" sibling of the mask authority's "paint" (scene/anchor-authority.js's
 * header), and their persistence should look like the sibling it is, not a new
 * shape invented for its own sake.
 *
 * The PAYLOAD is deliberately a small diff, not a full anchor dump — the same
 * "store only what differs" discipline `core/params-schema.js#serializeParams`
 * already uses:
 *   - `overrides`: `{ [anchorId]: rawAnchorFieldsPatch }` — a brand-new
 *     authored anchor (a UI-minted id) OR an edit layered onto a V2-imported
 *     candle (its own stable `v2:<groupId>:<index>` id). `scene/anchor-
 *     authority.js#mergeAnchorSources` is the pure function that reassembles
 *     this against a fresh V2 import on every scene load.
 *   - `removed`: `string[]` of anchor ids to drop regardless of source.
 *
 * @module foundry/anchor-adapter
 */

const MODULE_ID = 'map-shine-advanced';
const ANCHOR_FLAG = 'authoredAnchors';

/** The active, drawn canvas, or null when no scene is ready. */
function activeCanvas() {
  const c = globalThis.canvas;
  return c && c.ready && c.dimensions ? c : null;
}

/**
 * Persist the authored-anchor payload to the active scene's flags — the same
 * embed-in-scene-flag storage every other authored MSA content uses, so it
 * travels inside an adventure automatically (Authoring-and-Distribution.md §3).
 * @param {{overrides?: Record<string, object>, removed?: string[]}} payload
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function saveAuthoredAnchors(payload) {
  const c = activeCanvas();
  if (!c || !c.scene) return { ok: false, reason: 'no active scene' };
  await c.scene.setFlag(MODULE_ID, ANCHOR_FLAG, payload);
  return { ok: true };
}

/** Read the authored-anchor payload from the active scene's flags (or null). */
export function loadAuthoredAnchors() {
  const c = activeCanvas();
  if (!c || !c.scene) return null;
  return c.scene.getFlag(MODULE_ID, ANCHOR_FLAG) ?? null;
}
