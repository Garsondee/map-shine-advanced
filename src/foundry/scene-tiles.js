/**
 * TILES, narrowly: picking one to safely PING for the editing-cadence stress
 * test (`perf-structural-ab.js#runEditCascadeStress`, wired from `boot.js`'s
 * `perf-run-full`). Not a rendering adapter like `scene-tokens.js` — nothing
 * here draws anything. This exists only so the stress test's own document
 * write goes through `src/foundry/`, same as every other live mutation in
 * this codebase (`fade-persistence.js`, `sky-persistence.js`,
 * `cues-persistence.js` all wrap their own `scene.setFlag` the same way) —
 * `tools/verify-structure.mjs`'s `foundry/adapter-only` gate names
 * `canvas.tiles`/`canvas.scene` literally, but the rule this file actually
 * follows is the one in that gate's own `why`: "All Foundry access goes
 * through src/foundry/", not merely dodging the regex's exact wording.
 *
 * WHY A TILE, AND WHY THIS SHAPE — see `docs/planning/Performance-Gap-
 * Analysis-2026-08-26.md` / the author's own direct answer when asked what
 * to mutate: "An invisible flag on an existing tile, then unset it." The
 * flag key (`__perfStressPing`) is read by nothing else in this codebase —
 * grep it before ever renaming it — so a run that throws before its own
 * `finally` unsets it leaves nothing visibly wrong on the map.
 *
 * @module foundry/scene-tiles
 */

/**
 * Same tolerant shape as `scene-layers.js`'s own private `tileDocsOf` —
 * duplicated rather than imported, deliberately: that copy is `collectSceneLayers`'s
 * private helper for DRAWING tiles, this one is for finding ONE to mutate, and
 * the two functions have no reason to share a dependency just because their
 * bodies currently match.
 * @param {object|null} sceneDoc
 * @returns {Array<object>}
 */
function tileDocsOf(sceneDoc) {
  const tiles = sceneDoc?.tiles;
  if (!tiles) return [];
  return typeof tiles.values === 'function' ? Array.from(tiles.values()) : Array.from(tiles);
}

/**
 * The tile the stress test pings — arbitrary but DETERMINISTIC (always the
 * first document in the scene's own tile collection), so repeated runs hit
 * the same tile instead of a different random one each time, which would
 * make two reports harder to compare for no reason.
 *
 * @param {object|null} sceneDoc
 * @returns {object|null} a live Tile document, or null if this scene has none
 */
export function pickStressTestTile(sceneDoc) {
  const docs = tileDocsOf(sceneDoc);
  return docs.length > 0 ? docs[0] : null;
}

/**
 * Write the scoped ping flag. An inert edit — nothing in this codebase reads
 * `flags.<moduleId>.<flagKey>` back, so its only effect is firing the
 * `updateTile` hook the stress test exists to cost out.
 *
 * @param {object|null} tileDoc a document from `pickStressTestTile`
 * @param {string} moduleId
 * @param {string} flagKey
 * @returns {Promise<boolean>} false if `tileDoc` cannot be updated (never throws for that reason)
 */
export async function pingStressTestTile(tileDoc, moduleId, flagKey) {
  if (!tileDoc || typeof tileDoc.update !== 'function') return false;
  await tileDoc.update({ [`flags.${moduleId}.${flagKey}`]: true });
  return true;
}

/**
 * Revert it. Callers MUST run this from a `finally` — see this module's own
 * header on why a failed revert must still leave nothing visibly wrong (it
 * does, even then; this is belt-and-braces, not the only safety net).
 *
 * @param {object|null} tileDoc
 * @param {string} moduleId
 * @param {string} flagKey
 * @returns {Promise<boolean>} false if `tileDoc` cannot be updated (never throws for that reason)
 */
export async function unpingStressTestTile(tileDoc, moduleId, flagKey) {
  if (!tileDoc || typeof tileDoc.unsetFlag !== 'function') return false;
  await tileDoc.unsetFlag(moduleId, flagKey);
  return true;
}
