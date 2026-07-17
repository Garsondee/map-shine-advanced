/**
 * @fileoverview foundry/scene-layers.js — reads a Scene's documents into the flat,
 * keyed draw list the renderer sorts and paints.
 *
 * This is where "Foreground Tiles" and "Tiles" actually come from, and the
 * punchline is that neither is a feature here: both are just Tile documents that
 * land at different elevations, and the ONE sort key
 * (`scene/layer-order.js#compareLayerKeys`) puts each where it belongs. There is
 * no `isForeground` branch in this file because there is no such field in Foundry
 * — `overhead`/`roof` were deleted in v12 and converted into elevation numbers.
 *
 * Everything is replicated from the vendored v14 source with citations. Pure: no
 * Foundry globals, no THREE, no DOM — hand it a plain object shaped like a Scene
 * and it works, which is how it's Node-tested.
 *
 * @module foundry/scene-layers
 */

import { SORT_LAYERS, makeLayerKey } from '../scene/layer-order.js';
import { packOcclusionModes } from '../scene/occlusion.js';
import {
  computeSceneDimensions,
  computeLevelTexturePlacement,
  computeTilePlacement,
  computeTokenPlacement,
} from './scene-geometry.js';
import { isImageUrl, resolveAssetUrl } from './active-scene-source.js';

/**
 * Normalize Foundry's ColorField (a `Color` instance live, a `"#rrggbb"` string
 * in raw data) to a plain `0xRRGGBB` number, which is what a shader uniform wants.
 * @param {any} tint
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeTint(tint, fallback = 0xffffff) {
  if (tint === null || tint === undefined) return fallback;
  if (typeof tint === 'number') return tint;
  if (typeof tint === 'string') {
    const parsed = Number.parseInt(tint.replace('#', ''), 16);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  // Foundry's Color is a Number subclass — valueOf() gives the packed int.
  const asNumber = Number(tint?.valueOf?.() ?? NaN);
  return Number.isNaN(asNumber) ? fallback : asNumber;
}

/**
 * Read a Scene's `levels` into a plain array, tolerating either the real
 * `EmbeddedCollection` (a Map subclass) or a plain array (test mocks).
 * @param {object|null} sceneDoc @returns {any[]}
 */
function levelDocsOf(sceneDoc) {
  const levels = sceneDoc?.levels;
  if (!levels) return [];
  if (typeof levels.values === 'function') return Array.from(levels.values());
  return Array.from(levels);
}

/** Same tolerance for `tiles`. @param {object|null} sceneDoc @returns {any[]} */
function tileDocsOf(sceneDoc) {
  const tiles = sceneDoc?.tiles;
  if (!tiles) return [];
  if (typeof tiles.values === 'function') return Array.from(tiles.values());
  return Array.from(tiles);
}

/**
 * Levels in Foundry's own **sort order**, each with its `index`.
 *
 * `client/documents/scene.mjs:371` is unambiguous and easy to get wrong:
 *
 *     this.levels.sorted = this.levels.contents.sort((a, b) => a.sort - b.sort)
 *     for (const [i, level] of this.levels.sorted.entries()) level.index = i
 *
 * The index that becomes the layer key's `sort` term comes from **`level.sort`**,
 * NOT from elevation. That distinction is invisible until two levels share an
 * elevation boundary (floor 0's `top` == floor 1's `bottom`, which is the normal
 * way to stack floors) — there, this index is the *only* thing deciding whether
 * the lower floor's roof paints under the upper floor's ground. Ordering by
 * elevation instead would usually agree and occasionally, silently, not.
 *
 * `active-scene-source.js#getActiveSceneFloors` orders floors by
 * `elevation.bottom` — correct for ITS job (which floor is "up" from here), and
 * a different question from this one. Both numbers exist; neither substitutes.
 *
 * Prefers the real `level.index` when Foundry has already assigned it.
 *
 * @param {object|null} sceneDoc
 * @returns {Array<{level:any, index:number}>}
 */
export function sortedLevels(sceneDoc) {
  const docs = levelDocsOf(sceneDoc);
  if (docs.length && docs.every((l) => Number.isInteger(l?.index))) {
    return docs.map((level) => ({ level, index: level.index })).sort((a, b) => a.index - b.index);
  }
  return [...docs].sort((a, b) => (a?.sort ?? 0) - (b?.sort ?? 0)).map((level, index) => ({ level, index }));
}

/**
 * Level elevation with Foundry's own null → ±Infinity normalization applied
 * (`Level#prepareBaseData`, client/documents/level.mjs:62). A null `bottom` means
 * "extends down forever", not zero.
 * @param {any} level @returns {{bottom:number, top:number}}
 */
export function levelElevation(level) {
  const e = level?.elevation ?? {};
  return {
    bottom: e.bottom ?? -Infinity,
    top: e.top ?? Infinity,
  };
}

/**
 * Foundry's `Level#isVisible` (client/documents/level.mjs:36): the viewed level,
 * plus any level the VIEWED level lists in its own `visibility.levels`.
 *
 * Deliberately NOT symmetric and NOT "always show the floor below" — it's exactly
 * the per-level setting the author configured.
 *
 * @param {any} level @param {any} viewedLevel @returns {boolean}
 */
export function isLevelVisible(level, viewedLevel) {
  if (!viewedLevel || !level) return false;
  if (level.id === viewedLevel.id) return true;
  const set = viewedLevel.visibility?.levels;
  if (!set) return false;
  return typeof set.has === 'function' ? set.has(level.id) : Array.from(set).includes(level.id);
}

/**
 * Foundry's `CanvasDocument#includedInLevel` (client/documents/abstract/canvas-document.mjs:96):
 *
 *     if (!this.schema.has("levels") || !this.levels.size) return true;
 *     return this.levels.has(id);
 *
 * The load-bearing detail is the first line: **an EMPTY levels set means present
 * on EVERY level**, not on none. This is the author-facing "which floors is this
 * tile on" control (a `SceneLevelsSetField` of Level ids), and leaving it blank —
 * the default — is how you say "all of them".
 *
 * @param {any} doc @param {string} levelId @returns {boolean}
 */
export function includedInLevel(doc, levelId) {
  const set = doc?.levels;
  if (!set) return true;
  const size = typeof set.size === 'number' ? set.size : Array.from(set).length;
  if (!size) return true;
  return typeof set.has === 'function' ? set.has(levelId) : Array.from(set).includes(levelId);
}

/**
 * @typedef {object} SceneLayerItem
 * @property {string} id - stable identity; also the VT page-key prefix, so it must
 *   be unique per streamable image and stable across residency updates.
 * @property {'levelBackground'|'levelForeground'|'tile'} kind
 * @property {import('../scene/layer-order.js').LayerKey} key - the sort key.
 * @property {string} src - resolved, fetchable URL.
 * @property {string} levelId - owning level for level art; `''` for tiles.
 * @property {string[]} visibleOnLevelIds - for tiles: the visible levels that include it.
 * @property {number} alpha
 * @property {number} tint - packed 0xRRGGBB.
 * @property {number} alphaThreshold
 * @property {{modes:number, alpha:number}} occlusion - `modes` is an OR'd bitfield.
 * @property {boolean} restrictsLight
 * @property {boolean} restrictsWeather
 * @property {boolean} isUpper - above the viewed level (drives Foundry's SURFACE default).
 * @property {boolean} hidden - GM-only.
 * @property {object} _placement - opaque input for {@link computeItemPlacement}.
 */

/**
 * Level background + foreground draw items, replicating
 * `Scene#_configureLevelTextures` (client/documents/scene.mjs:888) exactly:
 *
 *     background → elevation = level.elevation.bottom, sort = index, zIndex = 0
 *     foreground → elevation = level.elevation.top,    sort = index, zIndex = 1
 *
 * **The single most important line in this module** is that the two textures get
 * DIFFERENT elevations. The Level is an elevation *band*: its ground sits at the
 * bottom, its roof at the top, and everything authored on that floor (tiles,
 * tokens) has an elevation in between. That is the entire mechanism by which a
 * roof covers a token — no roof logic, just `5 < 10`.
 *
 * `isUpper` reproduces Foundry's `!isView && elevation > viewedLevel.elevation.bottom`,
 * which is what makes an upper floor's art default to SURFACE occlusion so you
 * can see down through it.
 *
 * @param {object|null} sceneDoc
 * @param {object} [options]
 * @param {string} [options.viewedLevelId] - the level being viewed (`scene._view`).
 * @param {(p:string)=>string} [options.getRouteFn] - injected for testability.
 * @returns {{items: SceneLayerItem[], skipped: Array<{name:string, reason:string}>}}
 */
export function collectLevelTextures(sceneDoc, { viewedLevelId, getRouteFn } = {}) {
  const items = [];
  const skipped = [];
  const levels = sortedLevels(sceneDoc);
  const viewedLevel = levels.find(({ level }) => level.id === viewedLevelId)?.level;
  if (!viewedLevel) return { items, skipped };
  const viewedBottom = levelElevation(viewedLevel).bottom;

  for (const { level, index } of levels) {
    const isView = level.id === viewedLevel.id;
    const isVisible = isLevelVisible(level, viewedLevel);
    const elevation = levelElevation(level);

    /** @param {'background'|'foreground'} which */
    const consider = (which) => {
      const cfg = level[which] ?? {};
      // Foundry: `if (isView || (src && isVisible))`. The viewed level is always
      // considered even with no src (it still contributes its background COLOR);
      // we have nothing to stream without a src, so a srcless entry is simply not
      // a draw item rather than an error.
      if (!(isView || isVisible)) return;
      if (!cfg.src) return;
      if (!isImageUrl(cfg.src)) {
        skipped.push({
          name: `${level.name || level.id} ${which}`,
          reason: `"${cfg.src}" is not a still image (video level art isn't supported yet)`,
        });
        return;
      }
      const isBackground = which === 'background';
      const ownElevation = isBackground ? elevation.bottom : elevation.top;
      items.push({
        id: `level:${level.id}:${which}`,
        kind: isBackground ? 'levelBackground' : 'levelForeground',
        key: makeLayerKey({
          elevation: ownElevation,
          sortLayer: SORT_LAYERS.SCENE,
          sort: index,
          zIndex: isBackground ? 0 : 1, // separates the two when a Level has zero height
        }),
        src: resolveAssetUrl(cfg.src, getRouteFn),
        levelId: level.id,
        visibleOnLevelIds: [level.id],
        alpha: 1,
        tint: normalizeTint(cfg.tint),
        alphaThreshold: cfg.alphaThreshold ?? 0.75,
        // `#drawLevelTexture` (primary.mjs:305) gives upper-level art SURFACE
        // occlusion so you can see through the floor you're standing under.
        occlusion: { modes: !isView && ownElevation > viewedBottom ? 2 /* SURFACE */ : 0, alpha: 0 },
        restrictsLight: isBackground,
        restrictsWeather: isBackground,
        isUpper: !isView && ownElevation > viewedBottom,
        hidden: false,
        _placement: { kind: 'level', texturesConfig: level.textures ?? {} },
      });
    };

    consider('background');
    consider('foreground');
  }
  return { items, skipped };
}

/**
 * Tile draw items.
 *
 * ## The one deliberate divergence from Foundry (author decision, 2026-07-16)
 *
 * Foundry draws tiles for the **viewed** level only: `PlaceablesLayer#_draw`
 * iterates `viewedDocuments()`, which filters on `doc.viewed` →
 * `includedInLevel(scene._view)`. Level background/foreground art, by contrast,
 * draws for every **visible** level. That asymmetry means real Foundry shows a
 * lower floor's ART through a hole in the floor above, but none of its FURNITURE.
 *
 * MSA draws a tile if ANY currently-visible level includes it. Rationale: an
 * otherwise-correct room, visible through a hole, with every object in it missing,
 * reads as a rendering bug — and multi-floor fidelity is the point of this
 * renderer. When only the viewed level is visible this reduces EXACTLY to
 * Foundry's rule, so the divergence is strictly additive.
 *
 * Note a tile is emitted **once**, not once per level it appears on: its own
 * `elevation` places it in the sort order, so level membership is purely a
 * visibility filter. (This matters — a tile with an empty `levels` set is on
 * every level, and emitting it per-level would draw it N times.)
 *
 * @param {object|null} sceneDoc
 * @param {object} [options]
 * @param {string[]} [options.visibleLevelIds] - levels currently composited.
 * @param {(p:string)=>string} [options.getRouteFn]
 * @param {boolean} [options.isGM] - GM sees hidden tiles (dimmed); players don't.
 * @returns {{items: SceneLayerItem[], skipped: Array<{name:string, reason:string}>}}
 */
export function collectTiles(sceneDoc, { visibleLevelIds = [], getRouteFn, isGM = true } = {}) {
  const items = [];
  const skipped = [];
  for (const tile of tileDocsOf(sceneDoc)) {
    const src = tile?.texture?.src;
    if (!src) continue; // a tile with no art is legitimate (Foundry draws a placeholder box in the editor)
    if (tile.hidden && !isGM) continue;

    const on = visibleLevelIds.filter((levelId) => includedInLevel(tile, levelId));
    if (on.length === 0) continue; // not on any visible floor

    if (!isImageUrl(src)) {
      skipped.push({
        name: tile.name || tile.id || '(unnamed tile)',
        reason: `"${src}" is not a still image (video tiles aren't supported yet)`,
      });
      continue;
    }

    items.push({
      id: `tile:${tile.id}`,
      kind: 'tile',
      key: makeLayerKey({
        // The tile's OWN elevation. This alone decides whether it's a rug or a
        // roof — see this module's header.
        elevation: tile.elevation ?? 0,
        sortLayer: SORT_LAYERS.TILES,
        sort: tile.sort ?? 0,
        zIndex: 0,
      }),
      src: resolveAssetUrl(src, getRouteFn),
      levelId: '',
      visibleOnLevelIds: on,
      // Foundry dims a hidden tile to 0.5 for the GM (Tile#_refreshState).
      alpha: (tile.alpha ?? 1) * (tile.hidden ? 0.5 : 1),
      tint: normalizeTint(tile.texture?.tint),
      alphaThreshold: tile.texture?.alphaThreshold ?? 0.75,
      occlusion: {
        modes: packOcclusionModes(tile.occlusion?.modes),
        alpha: tile.occlusion?.alpha ?? 0,
      },
      restrictsLight: !!tile.restrictions?.light,
      restrictsWeather: !!tile.restrictions?.weather,
      isUpper: false,
      hidden: !!tile.hidden,
      _placement: { kind: 'tile', tileDoc: tile },
    });
  }
  return { items, skipped };
}

/**
 * The Foundry document types `collectSceneLayers` READS. Declared HERE, beside
 * the collector, because whoever changes what this reads is the only person who
 * can know this changed — and a list kept somewhere else is a list that drifts.
 *
 * The renderer redraws on these documents' create/update/delete hooks. A type
 * this collector reads but does not declare renders once and then silently
 * ignores every later change to it. **`Tile` is here because that is not
 * hypothetical**: it was read by this function, watched by nobody, and a moved
 * tile kept its MSA art at the old position while Foundry's own interface
 * chrome moved correctly (author-reported 2026-07-17 — "it leaves a version of
 * the tile behind"). `Level` because each Level contributes background AND
 * foreground art, and its elevation is a sort key.
 *
 * If you add a document type to this collector — Drawing, Wall, whatever — add
 * it here in the SAME edit, or the renderer will not notice it changing.
 *
 * @type {ReadonlyArray<string>}
 */
export const SCENE_LAYER_DOCUMENTS = Object.freeze(['Level', 'Tile']);

/**
 * The whole draw list for a scene: level art + tiles, unsorted.
 *
 * Sorting is the caller's step (`scene/layer-order.js#sortByLayer`) so the
 * renderer can add its own items — effects, tokens later — to the same list
 * before it's ordered. One list, one sort, one law.
 *
 * @param {object|null} sceneDoc
 * @param {object} [options]
 * @param {string} [options.viewedLevelId]
 * @param {string[]} [options.visibleLevelIds] - defaults to `[viewedLevelId]`.
 * @param {(p:string)=>string} [options.getRouteFn]
 * @param {boolean} [options.isGM]
 * @returns {{items: SceneLayerItem[], skipped: Array<{name:string,reason:string}>,
 *            dimensions: ReturnType<typeof computeSceneDimensions>}}
 */
export function collectSceneLayers(sceneDoc, options = {}) {
  const { viewedLevelId, getRouteFn, isGM } = options;
  const visibleLevelIds = options.visibleLevelIds ?? (viewedLevelId ? [viewedLevelId] : []);
  const levelResult = collectLevelTextures(sceneDoc, { viewedLevelId, getRouteFn });
  const tileResult = collectTiles(sceneDoc, { visibleLevelIds, getRouteFn, isGM });
  return {
    items: [...levelResult.items, ...tileResult.items],
    skipped: [...levelResult.skipped, ...tileResult.skipped],
    dimensions: computeSceneDimensions(sceneDoc),
  };
}

/**
 * Resolve an item's world-space placement once its texture's native size is known.
 *
 * Split from collection because the size requires reading the image
 * (`getSourceDimensions`), which is async and browser-only — keeping it out of
 * here is what lets the whole collection path stay pure and Node-tested.
 *
 * @param {SceneLayerItem} item
 * @param {{width:number, height:number}} textureSize - the art's NATIVE pixel size.
 * @param {ReturnType<typeof computeSceneDimensions>} dimensions
 * @returns {ReturnType<typeof computeTilePlacement>}
 */
export function computeItemPlacement(item, textureSize, dimensions) {
  if (item._placement.kind === 'tile') {
    return computeTilePlacement(textureSize, item._placement.tileDoc);
  }
  // A token carries its footprint already converted to pixels — see
  // scene-tokens.js, which owns the grid-units conversion.
  if (item._placement.kind === 'token') {
    return computeTokenPlacement(textureSize, item._placement.tokenDoc, item._placement.footprint);
  }
  return computeLevelTexturePlacement(textureSize, dimensions, item._placement.texturesConfig);
}
