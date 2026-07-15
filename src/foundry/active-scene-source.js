/**
 * @fileoverview foundry/active-scene-source.js — reads the CURRENTLY DISPLAYED
 * scene's base background image (Keyhole Stage 2B: point the VT viewer at
 * real art instead of the torture fixture). First file in `src/foundry/` —
 * the ONE Foundry adapter (Keyhole.md §3, CONVENTIONS.md §1).
 *
 * SCOPE FOR THIS INCREMENT, deliberately minimal (the same "ship a minimal
 * slice, record the deferred target" discipline as decode-pool.js's Worker-pool
 * deferral and vt-sample.glsl.js's old single-mip note): FLOOR 0 ONLY, the
 * scene's base `background.src` (common/documents/scene.mjs's
 * `_LEVELS_PROPERTY_MAP` confirms this exact field — verified against the
 * vendored v14 source, not assumed).
 *
 * DELIBERATELY NOT YET BUILT (tracked, not silently dropped):
 * - Multi-floor art. v14 core now ships a NATIVE `scene.levels` embedded
 *   collection (common/documents/level.mjs, schemaVersion "14.359") where each
 *   Level document carries its OWN background.src — a real, very recent core
 *   feature, confirmed in source. BUT this project's own torture-fixture
 *   generator (tools/make-torture-world.mjs) and legacy V2's harvest-manifest
 *   entry ("foundry/levels-scene-flags.js", Keyhole.md §6) both target the
 *   older, long-established THIRD-PARTY Levels module convention instead:
 *   floor-background TILES carrying `flags.levels.rangeBottom`/`rangeTop`.
 *   Real author worlds are far more likely to already use the third-party
 *   convention (it predates the core feature by years). Detecting either (or
 *   both) is real, scoped follow-up work — not built here, so this increment
 *   stays small and reviewable.
 * - Non-square worlds. `page-table.js`'s `PageTable` takes a single
 *   `worldSizePx` (the page grid is square by construction) — see
 *   `vt-pan-viewer.js`'s loud guard against a non-square decoded image.
 *
 * @module foundry/active-scene-source
 */

/**
 * Extensions Foundry itself treats as displayable still images (mirrors
 * `CONST.IMAGE_FILE_EXTENSIONS`, common/constants.mjs — verified against the
 * vendored v14 source, not guessed). A background pointing at a VIDEO
 * extension (`CONST.VIDEO_FILE_EXTENSIONS` — scene backgrounds legitimately
 * support animated video in Foundry) is a real possibility this module must
 * reject loudly rather than hand to `createImageBitmap()`, which cannot
 * decode video.
 */
const IMAGE_EXTENSIONS = new Set(['apng', 'avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'tiff', 'webp']);

/** @param {string} url @returns {boolean} true if the URL's extension is a still-image type Foundry serves. */
export function isImageUrl(url) {
  const match = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(url || '');
  return !!match && IMAGE_EXTENSIONS.has(match[1].toLowerCase());
}

/**
 * Resolve a Foundry-stored asset path to a fetchable URL. Foundry's own
 * `foundry.utils.getRoute()` (common/utils/helpers.mjs, verified in source)
 * applies the `ROUTE_PREFIX` reverse-proxy setting when one is configured —
 * most installs don't set one, but skipping this would silently 404 on the
 * ones that do.
 *
 * @param {string} src
 * @param {(path:string)=>string} [getRouteFn] - injected for Node testability;
 *   defaults to the real `foundry.utils.getRoute` when running live.
 * @returns {string}
 */
export function resolveAssetUrl(src, getRouteFn) {
  const fn = getRouteFn ?? globalThis.foundry?.utils?.getRoute;
  if (typeof fn === 'function') {
    try {
      return fn(src);
    } catch (_) {
      // Fall through to the raw path — a resolution failure here shouldn't
      // block on its own; the fetch itself will surface a clear 404 if wrong.
    }
  }
  return src;
}

/**
 * @param {object|null} sceneDoc - a Foundry Scene document. Callers pass
 *   `canvas.scene` (the CURRENTLY DISPLAYED scene) — verified via
 *   client/canvas/board.mjs's `Canvas#scene` getter, whose own doc comment is
 *   exactly "the currently displayed Scene document, or null if the Canvas is
 *   currently blank." Deliberately NOT `game.scenes.active` (the world's
 *   default scene), which can differ from what's actually on screen.
 * @param {(path:string)=>string} [getRouteFn] - forwarded to resolveAssetUrl (testability).
 * @returns {{ok:true, url:string, name:string}|{ok:false, error:string}}
 */
export function getActiveSceneBackground(sceneDoc, getRouteFn) {
  if (!sceneDoc) {
    return { ok: false, error: 'no active scene (canvas.scene is null) — open a scene in Foundry first' };
  }
  const src = sceneDoc.background?.src;
  if (!src) {
    return { ok: false, error: `scene "${sceneDoc.name}" has no background image set` };
  }
  if (!isImageUrl(src)) {
    return {
      ok: false,
      error:
        `scene "${sceneDoc.name}"'s background ("${src}") is not a still image (looks like a video ` +
        `background) — the VT pipeline decodes static images only; video backgrounds aren't supported yet`,
    };
  }
  return { ok: true, url: resolveAssetUrl(src, getRouteFn), name: sceneDoc.name };
}
