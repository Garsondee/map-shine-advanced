/**
 * TOKENS, as drawables.
 *
 * Deliberately NOT a token *system*: no vision, no fog, no detection modes, no
 * light, no rings, no turn markers. Basic rendering and selection only. That
 * scope is the author's, and the reason is ordering (2026-07-16): *"In order to
 * test occlusion we actually need to have token rendering working first. Just
 * basic token rendering and selection, not vision or fog of war. Then we can
 * test if the tiles are correctly occluding."* Occlusion IS tokens fading roofs
 * — with nothing on the board there is nothing to fade and nothing to verify, so
 * the mask producer built first would be a subsystem that could only be trusted,
 * never checked.
 *
 * Everything here is read from the real v14 schema
 * (`common/documents/token.mjs`), not assumed. The three that bite:
 *
 * 1. **`width`/`height` are GRID UNITS, not pixels** (`positive: true, initial:
 *    1`). A 1x1 token is one grid square. Multiply by `grid.size`. `x`/`y` ARE
 *    pixels, so the record mixes units and reads as if it does not.
 * 2. **`token.level` is a native level ID** (`DocumentIdField`, initial
 *    `BaseScene.metadata.defaultLevelId`). A token's floor is in core v14's own
 *    schema — no tile-flag convention, no third-party module.
 * 3. **The texture is CENTRE-anchored** (`anchorX: 0.5, anchorY: 0.5, fit:
 *    "contain"`), unlike a tile's top-left. `x`/`y` is the footprint's top-left
 *    corner; the ART centres on that footprint and is fitted, not stretched.
 *
 * Tokens enter the ONE flat draw list at `SORT_LAYERS.TOKENS` (700) through the
 * same `makeLayerKey`/`sortByLayer` law as everything else — see
 * `src/scene/layer-order.js`, which is parity-fuzzed against Foundry's own
 * comparator. No new layering machinery, on purpose: the whole point of the law
 * being one flat list is that a new kind of drawable is just another key.
 */

import { SORT_LAYERS, makeLayerKey } from '../scene/index.js';
import { normalizeTint } from './scene-layers.js';
import { tokenFootprint, GRID_TYPES } from './scene-geometry.js';

/** Foundry's own fallback art when a token has no texture (`Token.DEFAULT_ICON`). */
export const DEFAULT_TOKEN_ICON = 'icons/svg/mystery-man.svg';

/**
 * Is this token on `levelId`?
 *
 * NOT `includedInLevel` from scene-layers.js, which is the TILE test and reads
 * `doc.levels` -- a SET of ids, because a tile has a dropdown choosing which
 * floors show it. A token has `token.level`: ONE id, singular
 * (`DocumentIdField`). Passing a token to the tile helper finds no `levels` set,
 * hits its "no restriction, show everywhere" branch, and returns true — so every
 * token would render on every floor. Caught by scene-tokens.test.mjs before it
 * ever reached a screen; the two fields differ by one letter and mean different
 * things.
 *
 * @param {object} token
 * @param {string} levelId
 * @returns {boolean}
 */
export function tokenOnLevel(token, levelId) {
  return (token?.level ?? '') === levelId;
}

/**
 * Foundry's own default level id — a LITERAL, from
 * `BaseScene.metadata.defaultLevelId` in the v14 source. Not a placeholder of
 * ours; this exact string is what an unassigned token carries.
 */
export const DEFAULT_LEVEL_ID = 'defaultLevel0000';

/**
 * Which level is this token ACTUALLY on?
 *
 * `token.level` initialises to `defaultLevel0000` (above). A scene authored with
 * its own levels has ids like `cFSJ3W4gsqvGbb2A` and **no `defaultLevel0000`
 * among them** — so a token carrying the default matches no level, and a strict
 * `token.level === levelId` test drops it from every floor. That is exactly what
 * happened live (2026-07-16): a token dragged onto a real 3-level scene never
 * appeared, and the draw list had no `token:` entry at all.
 *
 * So: an id the scene actually HAS is authoritative. An id it does not have
 * (the default, or a level since deleted) is not a reason to make the token
 * vanish — it falls back to the viewed level, where the user can see it and fix
 * it. **A token that exists must be visible somewhere**; silently dropping a
 * document because its floor is unassigned is the worst of the options, since
 * the failure is invisible and looks like the renderer is broken.
 *
 * WITHOUT `knownLevelIds` this does NOTHING — deliberately. The fallback needs
 * to distinguish "this id is not a level at all" from "this id is a real level
 * that just is not currently visible", and only the scene's FULL level list can
 * tell those apart. Given only the visible ids, an upstairs token looks exactly
 * like an unassigned one, and falling back would drag it down onto the viewed
 * floor. The test caught precisely that. When the information needed to decide
 * is absent, do not guess — leave the value alone.
 *
 * @param {object} token
 * @param {Array<string>|Set<string>} [knownLevelIds] - the scene's REAL level
 *   ids, ALL of them. Omit and no fallback is applied.
 * @param {string} [fallbackLevelId] - the viewed level.
 * @returns {string}
 */
export function resolveTokenLevel(token, knownLevelIds, fallbackLevelId) {
  const level = token?.level ?? '';
  if (!knownLevelIds) return level; // cannot tell unassigned from hidden — see above
  const known = knownLevelIds instanceof Set ? knownLevelIds : new Set(knownLevelIds);
  if (known.has(level)) return level;
  return fallbackLevelId ?? '';
}

/**
 * @param {object} sceneDoc
 * @returns {Array<object>}
 */
function tokenDocsOf(sceneDoc) {
  const tokens = sceneDoc?.tokens;
  if (!tokens) return [];
  return typeof tokens.contents !== 'undefined' ? tokens.contents : Array.from(tokens);
}

// tokenFootprint MOVED to scene-geometry.js (2026-07-17) — pure geometry, and
// scene-layers.js needs it without importing scene-tokens.js (which already
// imports FROM scene-layers.js — that would be a cycle). Imported above,
// re-exported here so every existing import site, including this file's own
// internal callers below, is unchanged.
export { tokenFootprint };

/**
 * Is `point` (canvas pixels) inside this token's footprint?
 *
 * Rectangular only, and knowingly so: `shape` (`CONST.TOKEN_SHAPES`) also allows
 * ellipses and trapezoids, and Foundry's own hit test is alpha-thresholded
 * against the real texture. This is the footprint test, which is what selection
 * needs and is exact for the rectangle case that is nearly every token. The
 * alpha-aware refinement belongs with whatever holds the pixels, not here.
 *
 * The bounds are half-open (`>= x`, `< x + width`) so two adjacent tokens never
 * both claim the pixel on their shared edge.
 *
 * @param {object} token
 * @param {{x: number, y: number}} point
 * @param {number} gridSize
 * @param {number} [gridType] - see `tokenFootprint`'s own doc; defaults to SQUARE.
 * @returns {boolean}
 */
export function tokenContainsPoint(token, point, gridSize, gridType) {
  const f = tokenFootprint(token, gridSize, gridType);
  return point.x >= f.x && point.x < f.x + f.width && point.y >= f.y && point.y < f.y + f.height;
}

/**
 * The topmost token at `point`, or null.
 *
 * "Topmost" means LAST in paint order, which is what the user sees and therefore
 * what they mean when they click. Callers pass the already-sorted drawables, so
 * this cannot disagree with the screen: it walks the same list backwards.
 *
 * @param {Array<object>} tokenItems - token drawables, in paint order.
 * @param {{x: number, y: number}} point
 * @param {number} gridSize
 * @param {number} [gridType] - see `tokenFootprint`'s own doc; defaults to SQUARE.
 * @returns {object|null}
 */
export function pickTokenAt(tokenItems, point, gridSize, gridType) {
  for (let i = tokenItems.length - 1; i >= 0; i--) {
    const item = tokenItems[i];
    if (tokenContainsPoint(item._placement?.tokenDoc ?? item, point, gridSize, gridType)) return item;
  }
  return null;
}

/**
 * The Foundry document types `collectTokens` READS. Declared HERE, beside the
 * collector, because whoever changes what this reads is the only person who can
 * know this changed — and a list kept somewhere else is a list that drifts.
 *
 * The renderer redraws on these documents' create/update/delete hooks. A type
 * this collector reads but does not declare renders once and then silently
 * ignores every later change to it (author-reported 2026-07-17 — that is
 * exactly what happened to Tile: read by `collectSceneLayers`, watched by
 * nobody, so a moved tile left its art behind).
 *
 * @type {ReadonlyArray<string>}
 */
export const TOKEN_DOCUMENTS = Object.freeze(['Token']);

/**
 * How Foundry fades a token while it is being dragged — `PlaceableObject#
 * _getTargetAlpha` (placeables/placeable-object.mjs:640):
 * `isDragging ? (isPreview ? 0.8 : (hasPreview ? 0.4 : 1)) : 1`. The preview
 * clone is drawn at 0.8 and the token it stands in for drops to 0.4, so the two
 * read as "here" and "going there". Copied, not invented: a different pair
 * would make the drag look wrong next to every other Foundry placeable.
 */
export const DRAG_PREVIEW_ALPHA = 0.8;
export const DRAG_ORIGINAL_ALPHA = 0.4;

/**
 * The draw-list id of the drag ghost for token `originalId`. STABLE per token
 * (not per drag): the viewer hides, never disposes, an item that leaves the
 * draw list, so the second drag of a token finds its ghost already loaded.
 * @param {string} originalId
 * @returns {string}
 */
export function dragPreviewItemId(originalId) {
  return `token:${originalId}:drag-preview`;
}

/**
 * Collect every visible token on the visible levels as a drawable.
 *
 * @param {object} sceneDoc
 * @param {object} [options]
 * @param {Array<string>} [options.visibleLevelIds] - level ids currently drawn.
 * @param {number} [options.gridSize] - falls back to `sceneDoc.grid.size`.
 * @param {number} [options.gridType] - falls back to `sceneDoc.grid.type`; see
 *   `tokenFootprint`'s own doc (`CONST.GRID_TYPES`, defaults to SQUARE).
 * @param {(src: string) => string} [options.getRouteFn]
 * @param {boolean} [options.isGM] - a GM sees hidden tokens, dimmed.
 * @param {Array<{originalId: string, document: object}>} [options.dragPreviews] -
 *   the live drag previews (`readTokenDragPreviews`, foundry/token-drag-previews.js):
 *   `document` is the preview clone's own TokenDocument, which Foundry mutates on
 *   every pointer move; `originalId` is the id of the token being dragged. Each
 *   becomes a GHOST item beside the real tokens, and the token it was cloned from
 *   is dimmed (see DRAG_*_ALPHA).
 * @returns {{items: Array<object>, skipped: Array<{name: string, reason: string}>}}
 */
export function collectTokens(
  sceneDoc,
  {
    visibleLevelIds = [],
    knownLevelIds,
    viewedLevelId,
    gridSize,
    gridType,
    getRouteFn,
    isGM = true,
    dragPreviews = [],
  } = {}
) {
  // No knownLevelIds => strict matching, no fallback. See resolveTokenLevel: with
  // only the VISIBLE ids, a token on a real-but-hidden floor is indistinguishable
  // from an unassigned one, and falling back would drag it onto the viewed floor.
  const known = knownLevelIds ? new Set(knownLevelIds) : null;
  const fallback = viewedLevelId ?? visibleLevelIds[0] ?? '';
  const size = gridSize ?? sceneDoc?.grid?.size ?? 100;
  const type = gridType ?? sceneDoc?.grid?.type ?? GRID_TYPES.SQUARE;
  const items = [];
  const skipped = [];

  // A drag ghost is a token like any other as far as collection goes — same level
  // resolution, same footprint, same drop reasons — so it runs through the SAME
  // loop rather than a second collector that would have to be kept in step. The
  // only differences are the handful of fields set under `preview` below.
  const draggedIds = new Set(dragPreviews.map((p) => p.originalId));
  const entries = [
    ...tokenDocsOf(sceneDoc).map((token) => ({ token, preview: null })),
    ...dragPreviews.map((preview) => ({ token: preview.document, preview })),
  ];

  for (const { token, preview } of entries) {
    // EVERY drop is reported with its reason. A bare `continue` here is what made
    // three tokens vanish while the report said skippedItems: [] -- confidently
    // claiming nothing was skipped while quietly binning them (author-reported
    // 2026-07-16, "only one token renders"). A silent skip is worse than a crash:
    // it manufactures the impression that collection ran cleanly.
    const drop = (reason) =>
      skipped.push({
        name: `${token?.name || token?.id || '(unnamed token)'}${preview ? ' (drag preview)' : ''}`,
        id: token?.id,
        reason,
      });

    if (token?.hidden && !isGM) {
      drop('hidden, and this client is not a GM');
      continue;
    }

    // `token.level` is a native level ID (see this module's header) — singular,
    // so this is tokenOnLevel, NOT the tile helper. Resolved first, because the
    // raw field may hold defaultLevel0000, which no authored scene has.
    const level = resolveTokenLevel(token, known, fallback);
    const on = visibleLevelIds.filter((levelId) => level === levelId);
    if (on.length === 0) {
      drop(
        `on level "${level}"${level === (token?.level ?? '') ? '' : ` (resolved from "${token?.level ?? ''}")`}, ` +
          `which is not among the visible levels [${visibleLevelIds.join(', ')}]`
      );
      continue;
    }

    const src = token?.texture?.src || DEFAULT_TOKEN_ICON;
    const f = tokenFootprint(token, size, type);
    if (!(f.width > 0 && f.height > 0)) {
      drop(`degenerate footprint ${f.width}x${f.height}px (width/height are GRID units; grid size ${size})`);
      continue;
    }

    // Foundry fades a token while it is dragged — see DRAG_*_ALPHA.
    const dragFade = preview ? DRAG_PREVIEW_ALPHA : draggedIds.has(token.id) ? DRAG_ORIGINAL_ALPHA : 1;

    items.push({
      id: preview ? dragPreviewItemId(preview.originalId) : `token:${token.id}`,
      kind: 'token',
      // A GHOST, not a token: it paints above every real token at its elevation
      // (Foundry draws previews in a container above all placeables), it must
      // never take part in occlusion, and it must not flash the black
      // disclosure-safety stand-in a first-ever load gets — the renderer keys off
      // `dragPreview` for all three.
      ...(preview ? { dragPreview: true } : {}),
      key: makeLayerKey({
        elevation: token.elevation ?? 0,
        sortLayer: preview ? SORT_LAYERS.TOKEN_EFFECTS : SORT_LAYERS.TOKENS,
        sort: token.sort ?? 0,
        zIndex: 0,
      }),
      src: getRouteFn ? getRouteFn(src) : src,
      levelId: level,
      visibleOnLevelIds: on,
      // Foundry dims a hidden token to 0.5 for the GM, exactly as it does a tile.
      alpha: (token.alpha ?? 1) * (token.hidden ? 0.5 : 1) * dragFade,
      tint: normalizeTint(token.texture?.tint),
      rotation: token.lockRotation ? 0 : (token.rotation ?? 0),
      hidden: !!token.hidden,
      disposition: token.disposition ?? 0,
      // The RADIAL disc radius for the occlusion mask's G channel — real document
      // data (`occludable.radius`), carried now so the producer is purely additive.
      // 0 means this token contributes no disc. A ghost never contributes one: the
      // real token is still standing where it was, and a second disc following the
      // cursor would fade roofs the token is not under.
      occludableRadius: preview ? 0 : (token.occludable?.radius ?? 0),
      // `footprint` (top-level) is a SNAPSHOT for hit-testing utilities
      // (`pickTokenAt`/`tokenContainsPoint`) that don't need live-tracking. It
      // is NOT what the renderer places art from — `_placement` intentionally
      // carries `gridSize`, not a cached footprint, so `computeItemPlacement`
      // re-derives position fresh from `tokenDoc` every time (scene-layers.js,
      // 2026-07-17 — a stale cached footprint here is exactly what caused a
      // moved token's art to stop short of its true document position while
      // reporting no error, since every consumer looked correct in isolation).
      footprint: f,
      _placement: { kind: 'token', tokenDoc: token, gridSize: size, gridType: type },
    });
  }

  return { items, skipped };
}

/**
 * EVERY token document, and what collection decided about it — the instrument
 * that should have existed before the level matching did.
 *
 * Reports the RAW `token.level`, the RESOLVED level, and the scene's real level
 * ids side by side, because the whole class of bug here is those three
 * disagreeing: a token carrying `defaultLevel0000` that no authored scene has, a
 * token on a level since deleted, a token on a real floor you cannot currently
 * see. All three look identical from the outside — the token is simply absent —
 * and none of them are distinguishable from "the renderer is broken" without
 * this.
 *
 * Pure, and independent of collection: it re-derives rather than instrumenting
 * collectTokens from the inside, so it can still be trusted if collectTokens is
 * the thing that is wrong.
 *
 * @param {object} sceneDoc
 * @param {object} [options] - the same options collectTokens was called with.
 * @returns {object}
 */
export function diagnoseTokens(
  sceneDoc,
  { visibleLevelIds = [], knownLevelIds, viewedLevelId, gridSize, gridType } = {}
) {
  const size = gridSize ?? sceneDoc?.grid?.size ?? 100;
  const type = gridType ?? sceneDoc?.grid?.type ?? GRID_TYPES.SQUARE;
  const known = knownLevelIds ? new Set(knownLevelIds) : null;
  const fallback = viewedLevelId ?? visibleLevelIds[0] ?? '';
  const docs = tokenDocsOf(sceneDoc);
  return {
    tokenDocsFound: docs.length,
    gridSize: size,
    gridType: type,
    visibleLevelIds,
    knownLevelIds: knownLevelIds ?? null,
    viewedLevelId: viewedLevelId ?? null,
    fallbackLevelId: fallback,
    defaultLevelId: DEFAULT_LEVEL_ID,
    tokens: docs.map((token) => {
      const rawLevel = token?.level ?? '';
      const resolved = resolveTokenLevel(token, known, fallback);
      const f = tokenFootprint(token, size, type);
      return {
        id: token?.id,
        name: token?.name,
        rawLevel,
        resolvedLevel: resolved,
        levelIsReal: known ? known.has(rawLevel) : null,
        levelIsFoundryDefault: rawLevel === DEFAULT_LEVEL_ID,
        wouldRender: visibleLevelIds.includes(resolved),
        elevation: token?.elevation ?? 0,
        hidden: !!token?.hidden,
        gridWidth: token?.width,
        gridHeight: token?.height,
        footprintPx: { x: f.x, y: f.y, width: f.width, height: f.height },
        src: token?.texture?.src ?? null,
      };
    }),
  };
}
