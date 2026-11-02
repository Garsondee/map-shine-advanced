/**
 * FOG MEMORY PERSISTENCE — what a player's token has seen, kept on the token across reloads.
 *
 * The author, 2026-11-02: *"if I explore an area and then reload Foundry the token has forgotten places
 * it has seen previously but cannot see currently … Each scene must carry that memory for each player
 * controlled token."*
 *
 * MSA owns vision, so Foundry's own FogExploration documents are not fed; MSA's explored buffer lived
 * only in GPU memory and died with the page. Now each player-owned token carries its own memory as a
 * flag on its TOKEN document, which lives inside the scene — so the scene carries it, per token, and a
 * copy of the scene carries its tokens' memories with it.
 *
 * WHAT IS STORED is only WHERE the token has seen: the explored coverage (0..1, soft-edged), as a small
 * greyscale WebP over the scene rect. The remembered COLOUR is not stored: it is the map's own art, and
 * the viewer re-records it whenever remembered ground is on screen (as Foundry's own fog shows the
 * current map in explored areas). A few tens of kilobytes per token instead of megabytes.
 *
 * WHO WRITES: any client whose current sight comes from the token AND who may update it (its owner, or
 * a GM). A save MAX-merges with what is already stored, so two clients saving the same token both keep
 * what they added. Tokens without a player owner (a GM's monsters) are never written.
 *
 * GM "Reset Fog" (Foundry's own button) clears every token's memory in that scene.
 *
 * @module foundry/fog-memory-persistence
 */

export const FOG_MEMORY_NAMESPACE = 'map-shine-advanced';
export const FOG_MEMORY_FLAG = 'fogMemory';
export const FOG_MEMORY_VERSION = 1;

/** `'Token.abc'` (a vision source's id) → `'abc'`; anything else → null. */
export function tokenIdFromSourceId(sourceId) {
  if (typeof sourceId !== 'string') return null;
  const m = /^Token\.([A-Za-z0-9]+)$/.exec(sourceId);
  return m ? m[1] : null;
}

/**
 * The set of tokens whose sight is on screen, as one stable key (sorted ids, '' for none). The memory in
 * the explored buffer belongs to exactly this set; when the key changes the buffer is saved and reloaded.
 * @param {Array<{sourceId?: string, blinded?: boolean}>} sources
 */
export function fogMemoryKey(sources) {
  const ids = new Set();
  for (const s of Array.isArray(sources) ? sources : []) {
    const id = tokenIdFromSourceId(s?.sourceId);
    if (id) ids.add(id);
  }
  return [...ids].sort().join(',');
}

/** The token ids in a key. */
export function tokenIdsOfKey(key) {
  return typeof key === 'string' && key.length > 0 ? key.split(',') : [];
}

/** A stored record is usable: right version, a sane rect, a WebP/PNG data URL. */
export function isValidFogMemoryRecord(rec) {
  return (
    !!rec &&
    rec.v === FOG_MEMORY_VERSION &&
    Array.isArray(rec.rect) &&
    rec.rect.length === 4 &&
    rec.rect.every(Number.isFinite) &&
    rec.rect[2] > rec.rect[0] &&
    rec.rect[3] > rec.rect[1] &&
    Number.isInteger(rec.w) &&
    Number.isInteger(rec.h) &&
    rec.w > 0 &&
    rec.h > 0 &&
    typeof rec.data === 'string' &&
    /^data:image\/(webp|png);base64,/.test(rec.data)
  );
}

/** Build a record. */
export function makeFogMemoryRecord({ rect, w, h, data }) {
  return { v: FOG_MEMORY_VERSION, rect: [...rect], w, h, data };
}

/** The token document for an id in the current scene (null if absent). */
export function sceneTokenDoc(tokenId, scene = globalThis.canvas?.scene) {
  try {
    return scene?.tokens?.get?.(tokenId) ?? null;
  } catch (_err) {
    return null;
  }
}

/** The memory stored on a token (null when none or unreadable). */
export function readFogMemory(tokenDoc) {
  try {
    const rec = tokenDoc?.getFlag?.(FOG_MEMORY_NAMESPACE, FOG_MEMORY_FLAG) ?? null;
    return isValidFogMemoryRecord(rec) ? rec : null;
  } catch (_err) {
    return null;
  }
}

/** Does this token's memory get saved: it has a player owner, and this user may update it. */
export function shouldSaveFogMemory(tokenDoc, user = globalThis.game?.user) {
  try {
    if (!tokenDoc || !user) return false;
    const playerOwned = tokenDoc.hasPlayerOwner === true || tokenDoc.actor?.hasPlayerOwner === true;
    return playerOwned && tokenDoc.canUserModify?.(user, 'update') === true;
  } catch (_err) {
    return false;
  }
}

/**
 * Store a record on a token. Flags only, so nothing redraws; `render: false` keeps sheets closed.
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeFogMemory(tokenDoc, record) {
  try {
    await tokenDoc.update(
      { [`flags.${FOG_MEMORY_NAMESPACE}.${FOG_MEMORY_FLAG}`]: record },
      { render: false, msaFogMemory: true }
    );
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `saving fog memory on token ${tokenDoc?.id} failed: ${err?.message ?? err}` };
  }
}

/**
 * GM "Reset Fog": forget every token's memory in a scene (GM only; a player's call does nothing).
 * @returns {Promise<{cleared: number, reason: string|null}>}
 */
export async function clearSceneFogMemory(scene = globalThis.canvas?.scene, user = globalThis.game?.user) {
  if (!scene || user?.isGM !== true) return { cleared: 0, reason: null };
  let cleared = 0;
  try {
    for (const t of scene.tokens ?? []) {
      if (t.getFlag?.(FOG_MEMORY_NAMESPACE, FOG_MEMORY_FLAG) == null) continue;
      await t.unsetFlag(FOG_MEMORY_NAMESPACE, FOG_MEMORY_FLAG);
      cleared++;
    }
    return { cleared, reason: null };
  } catch (err) {
    return { cleared, reason: `clearing fog memory failed: ${err?.message ?? err}` };
  }
}

/**
 * MAX-merge two coverage rasters of the same size (Uint8 grey, one byte per texel), into `into`.
 * Memory only ever grows, whichever client saved last.
 */
export function mergeCoverageMax(into, other) {
  if (!other || other.length !== into.length) return into;
  for (let i = 0; i < into.length; i++) if (other[i] > into[i]) into[i] = other[i];
  return into;
}

/** The stored raster size for a scene rect: the longest side at most `maxDim`, never under 16. */
export function fogMemorySize(rect, maxDim = 1024) {
  const w = Math.max(1, rect[2] - rect[0]);
  const h = Math.max(1, rect[3] - rect[1]);
  const k = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.max(16, Math.round(w * k)), h: Math.max(16, Math.round(h * k)) };
}
