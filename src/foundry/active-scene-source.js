/**
 * @fileoverview foundry/active-scene-source.js — reads the CURRENTLY DISPLAYED
 * scene's floor art (Keyhole Stage 2B: point the VT viewer at real art instead
 * of the torture fixture). First file in `src/foundry/` — the ONE Foundry
 * adapter (Keyhole.md §3, CONVENTIONS.md §1).
 *
 * MULTI-FLOOR VIA NATIVE `scene.levels` — a directive, not just a finding.
 * Author decision 2026-07-15: build around Foundry's own core Levels schema;
 * the long-established THIRD-PARTY Levels module is treated as legacy/
 * redundant going forward (its vendored copy under `othermodules/` was
 * deleted the same session). `getActiveSceneFloors()` is therefore the
 * PRIMARY entry point: it reads `scene.levels` (`common/documents/level.mjs`,
 * schemaVersion "14.359") — an `EmbeddedCollectionField` of Level documents,
 * each with its own `background.src` + `elevation.{bottom,top}` — sorts by
 * `elevation.bottom` ascending (the semantically correct floor order; NOT
 * `scene.firstLevel`, whose own doc comment warns it's creation order, "not…
 * first by sort order" in a multi-level scene), and maps each to a floor.
 *
 * THE DEPRECATION THAT CONFIRMED THIS DIRECTION: `client/documents/scene.mjs`
 * (line ~1707) — `Scene#background` is `@deprecated since v14, until 16`,
 * delegating to `this.firstLevel?.background` and logging a compatibility
 * warning on every access. Stage 2B's first cut (`getActiveSceneBackground`,
 * kept below) was unknowingly exercising this deprecated shim the whole time
 * — it worked (confirmed live: the author's 12000² mansion scene loaded
 * through it), but v14 itself is telling us `scene.levels` is the real,
 * current, non-deprecated source of truth. `getActiveSceneBackground` now
 * serves as `getActiveSceneFloors`'s own last-resort fallback (a scene with
 * zero usable Level backgrounds — e.g. not yet migrated to the core schema)
 * rather than the primary path — one path per behavior, not two competing ones.
 *
 * NOTE, for the record (not this increment's problem): the project's own
 * torture-fixture generator (`tools/make-torture-world.mjs`) and legacy V2's
 * harvest-manifest entry (`foundry/levels-scene-flags.js`, Keyhole.md §6)
 * both still target the third-party module's TILE-flag convention
 * (`flags.levels.rangeBottom`/`rangeTop`) for their synthetic multi-floor
 * test world — a real, separate follow-up (regenerate the fixture via
 * `scene.createEmbeddedDocuments("Level", [...])`, matching level.mjs's own
 * JSDoc example) so the fixture matches what's actually being built now.
 *
 * MULTI-FLOOR COMPOSITING (added same day, author-reported live: a real
 * multi-level scene showed solid BLACK where a hole in the upper floor's art
 * should have revealed the floor below). Verified in source before writing
 * anything (per the standing rule) — the real Foundry algorithm is NOT
 * "swap floor images on floor-switch," it's simultaneous elevation-sorted
 * alpha-composited layers: `client/documents/scene.mjs#_configureLevelTextures`
 * draws a texture mesh for the viewed Level PLUS every OTHER Level whose id is
 * a member of the VIEWED Level's own `visibility.levels` set
 * (`client/documents/level.mjs#isVisible`: `id===view || viewedLevel
 * .visibility.levels.has(id)` — NOT symmetric, and NOT "always show the floor
 * directly below"; it's exactly the per-floor author-configured setting the
 * user pointed at). `computeVisibleFloorIndices()` below replicates this
 * exact rule so `vt-pan-viewer.js` can render the same set of floors,
 * Z-ordered by elevation and alpha-blended, that real Foundry would.
 *
 * STILL DELIBERATELY NOT BUILT (tracked, not silently dropped):
 * - Non-square worlds. `page-table.js`'s `PageTable` takes a single
 *   `worldSizePx` (the page grid is square by construction) — see
 *   `vt-pan-viewer.js`'s loud guard against a non-square decoded image. Each
 *   floor is checked independently, so one non-square Level failing doesn't
 *   block floors that ARE square.
 * - Per-floor world-size reconciliation. Real Level art can legitimately be
 *   uploaded at different native pixel resolutions while representing the
 *   SAME in-game footprint (Foundry scales via `Level#textures.fit/scaleX/Y`);
 *   this project derives `worldSizePx` purely from each floor's OWN decoded
 *   image (matching the existing single-floor assumption, not new to this
 *   increment). Composited floors with genuinely mismatched `worldSizePx`
 *   will visually misalign — `vt-pan-viewer.js` warns (console) rather than
 *   silently misaligning, but doesn't yet reconcile/rescale.
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
 * The FALLBACK path — reads the scene's own (deprecated-since-v14, see this
 * file's header) `background.src` getter, which itself delegates to
 * `firstLevel`. Used internally by `getActiveSceneFloors()` when a scene has
 * no `levels` with usable image art at all (e.g. not yet migrated to the core
 * Level schema). Kept exported + independently tested because it's still a
 * real, correct, minimal way to answer "does this scene have ANY displayable
 * background," not because it's the primary entry point anymore.
 *
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

/**
 * Read a Scene document's `levels` embedded collection into a plain array,
 * tolerant of either the real Foundry `EmbeddedCollection` (a Map subclass —
 * exposes `.values()`) or a plain array/iterable (test mocks). Pure, no
 * Foundry globals touched.
 * @param {object|null} sceneDoc
 * @returns {any[]}
 */
function levelDocsOf(sceneDoc) {
  const levels = sceneDoc?.levels;
  if (!levels) return [];
  if (typeof levels.values === 'function') return Array.from(levels.values());
  return Array.from(levels);
}

/**
 * THE PRIMARY entry point (see this file's header for why): every usable
 * floor of the currently-displayed scene, sorted bottom-to-top by
 * `elevation.bottom`, read from Foundry's native `scene.levels` collection.
 * Falls back to `getActiveSceneBackground()` (a single floor 0) when no Level
 * has usable image art — e.g. a scene that predates the core Levels schema
 * migration, or one with zero Levels defined at all.
 *
 * A Level with NO background set is silently skipped (not an error — a Level
 * can legitimately exist purely for lighting/region config, with visuals
 * coming from tiles instead). A Level with a VIDEO background is skipped but
 * reported in `skipped[]` (not silently dropped — Doctrine #1) rather than
 * failing the whole scene, since the other floors may still be perfectly usable.
 *
 * Each floor descriptor also carries `id` (the raw Level document id) and
 * `visibilityLevelIds` (that Level's OWN `visibility.levels` set, as a plain
 * string array) — the raw material `computeVisibleFloorIndices()` needs to
 * replicate Foundry's real cross-floor visibility rule. The legacy single-
 * floor fallback synthesizes `id:'legacy'`/`visibilityLevelIds:[]` (there's
 * only ever one floor in that case, so visibility-set membership is moot).
 *
 * @param {object|null} sceneDoc - see `getActiveSceneBackground`'s param doc.
 * @param {(path:string)=>string} [getRouteFn] - forwarded to resolveAssetUrl (testability).
 * @returns {{ok:true, floors:Array<{index:number,id:string,url:string,name:string,elevationBottom:number|null,elevationTop:number|null,visibilityLevelIds:string[]}>, skipped:Array<{name:string,reason:string}>}
 *          |{ok:false, error:string}}
 */
export function getActiveSceneFloors(sceneDoc, getRouteFn) {
  if (!sceneDoc) {
    return { ok: false, error: 'no active scene (canvas.scene is null) — open a scene in Foundry first' };
  }

  const skipped = [];
  const withImages = [];
  for (const lvl of levelDocsOf(sceneDoc)) {
    const src = lvl?.background?.src;
    if (!src) continue; // no background set on this Level — legitimate, not an error
    if (!isImageUrl(src)) {
      skipped.push({
        name: lvl.name || '(unnamed level)',
        reason: `background ("${src}") is a video, not a still image`,
      });
      continue;
    }
    withImages.push(lvl);
  }
  withImages.sort((a, b) => (a.elevation?.bottom ?? 0) - (b.elevation?.bottom ?? 0));

  if (withImages.length > 0) {
    return {
      ok: true,
      floors: withImages.map((lvl, index) => ({
        index,
        id: lvl.id,
        url: resolveAssetUrl(lvl.background.src, getRouteFn),
        name: lvl.name || `Level ${index}`,
        elevationBottom: lvl.elevation?.bottom ?? null,
        // elevationTop (2026-07-19, added for region-darkness elevation
        // gating): `Level.elevation.top` is a real, separate field —
        // schema default 20, `common/documents/level.mjs` — not inferred
        // from an adjacent floor's own bottom. `null` reads as Foundry's
        // own "+Infinity" convention (that field's doc comment, same file),
        // matching how `elevationBottom` already treats a missing value.
        elevationTop: lvl.elevation?.top ?? null,
        visibilityLevelIds: Array.from(lvl.visibility?.levels ?? []),
      })),
      skipped,
    };
  }

  const legacyBg = getActiveSceneBackground(sceneDoc, getRouteFn);
  if (legacyBg.ok) {
    return {
      ok: true,
      floors: [
        {
          index: 0,
          id: 'legacy',
          url: legacyBg.url,
          name: legacyBg.name,
          elevationBottom: null,
          elevationTop: null, // unrestricted — the single-floor fallback, no Level document to read a band from
          visibilityLevelIds: [],
        },
      ],
      skipped,
    };
  }
  return {
    ok: false,
    error:
      `scene "${sceneDoc.name}" has no usable floor art (0 Level backgrounds usable` +
      `${skipped.length ? `, ${skipped.length} skipped (video)` : ''}, and no legacy scene background either)`,
  };
}

/**
 * Replicates Foundry's REAL cross-floor visibility algorithm (see this file's
 * header — verified against `_configureLevelTextures`/`Level#isVisible` in
 * source, not guessed): given `getActiveSceneFloors()`'s `floors` array and
 * which one is currently being viewed, returns every floor index that should
 * be rendered alongside it — the viewed floor itself, PLUS any floor whose id
 * appears in the VIEWED floor's own `visibilityLevelIds`. Deliberately NOT
 * symmetric (floor A listing floor B as visible does not imply the reverse —
 * matches Foundry's own one-directional `has()` check) and NOT "always show
 * the floor below" (an author who never configured `visibility.levels` sees
 * ONLY the viewed floor, exactly like real Foundry).
 *
 * @param {ReturnType<typeof getActiveSceneFloors>['floors']} floors
 * @param {number} viewedIndex
 * @returns {number[]} floor indices to render, always including viewedIndex
 *   (if it exists), sorted ascending — which is also elevation-ascending,
 *   since `getActiveSceneFloors` already sorts its output that way.
 */
export function computeVisibleFloorIndices(floors, viewedIndex) {
  const viewed = floors.find((f) => f.index === viewedIndex);
  if (!viewed) return [];
  const visibleIds = new Set(viewed.visibilityLevelIds || []);
  return floors
    .filter((f) => f.index === viewedIndex || visibleIds.has(f.id))
    .map((f) => f.index)
    .sort((a, b) => a - b);
}
