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

import { SORT_LAYERS, makeLayerKey } from '../scene/layer-order.js';
import { normalizeTint } from './scene-layers.js';

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
 * @param {object} sceneDoc
 * @returns {Array<object>}
 */
function tokenDocsOf(sceneDoc) {
  const tokens = sceneDoc?.tokens;
  if (!tokens) return [];
  return typeof tokens.contents !== 'undefined' ? tokens.contents : Array.from(tokens);
}

/**
 * A token's footprint in canvas pixels.
 *
 * `x`/`y` are the top-left of the footprint in pixels; `width`/`height` are in
 * GRID UNITS and must be scaled by the grid size. Getting this wrong is silent —
 * a 1x1 token would render one pixel wide and simply look absent.
 *
 * @param {object} token - a Token document (or a plain object shaped like one).
 * @param {number} gridSize - `scene.grid.size`, in pixels.
 * @returns {{x: number, y: number, width: number, height: number, centerX: number, centerY: number}}
 */
export function tokenFootprint(token, gridSize) {
  const width = (token?.width ?? 1) * gridSize;
  const height = (token?.height ?? 1) * gridSize;
  const x = token?.x ?? 0;
  const y = token?.y ?? 0;
  return { x, y, width, height, centerX: x + width / 2, centerY: y + height / 2 };
}

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
 * @returns {boolean}
 */
export function tokenContainsPoint(token, point, gridSize) {
  const f = tokenFootprint(token, gridSize);
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
 * @returns {object|null}
 */
export function pickTokenAt(tokenItems, point, gridSize) {
  for (let i = tokenItems.length - 1; i >= 0; i--) {
    const item = tokenItems[i];
    if (tokenContainsPoint(item._placement?.tokenDoc ?? item, point, gridSize)) return item;
  }
  return null;
}

/**
 * Collect every visible token on the visible levels as a drawable.
 *
 * @param {object} sceneDoc
 * @param {object} [options]
 * @param {Array<string>} [options.visibleLevelIds] - level ids currently drawn.
 * @param {number} [options.gridSize] - falls back to `sceneDoc.grid.size`.
 * @param {(src: string) => string} [options.getRouteFn]
 * @param {boolean} [options.isGM] - a GM sees hidden tokens, dimmed.
 * @returns {{items: Array<object>, skipped: Array<{name: string, reason: string}>}}
 */
export function collectTokens(sceneDoc, { visibleLevelIds = [], gridSize, getRouteFn, isGM = true } = {}) {
  const size = gridSize ?? sceneDoc?.grid?.size ?? 100;
  const items = [];
  const skipped = [];

  for (const token of tokenDocsOf(sceneDoc)) {
    if (token?.hidden && !isGM) continue;

    // `token.level` is a native level ID (see this module's header) — singular,
    // so this is tokenOnLevel, NOT the tile helper. See its doc.
    const on = visibleLevelIds.filter((levelId) => tokenOnLevel(token, levelId));
    if (on.length === 0) continue;

    const src = token?.texture?.src || DEFAULT_TOKEN_ICON;
    const f = tokenFootprint(token, size);
    if (!(f.width > 0 && f.height > 0)) {
      skipped.push({
        name: token?.name || token?.id || '(unnamed token)',
        reason: `degenerate footprint ${f.width}x${f.height}px (width/height are GRID units; grid size ${size})`,
      });
      continue;
    }

    items.push({
      id: `token:${token.id}`,
      kind: 'token',
      key: makeLayerKey({
        elevation: token.elevation ?? 0,
        sortLayer: SORT_LAYERS.TOKENS,
        sort: token.sort ?? 0,
        zIndex: 0,
      }),
      src: getRouteFn ? getRouteFn(src) : src,
      levelId: token.level ?? '',
      visibleOnLevelIds: on,
      // Foundry dims a hidden token to 0.5 for the GM, exactly as it does a tile.
      alpha: (token.alpha ?? 1) * (token.hidden ? 0.5 : 1),
      tint: normalizeTint(token.texture?.tint),
      rotation: token.lockRotation ? 0 : (token.rotation ?? 0),
      hidden: !!token.hidden,
      disposition: token.disposition ?? 0,
      // The RADIAL disc radius for the occlusion mask's G channel — real document
      // data (`occludable.radius`), carried now so the producer is purely additive.
      // 0 means this token contributes no disc.
      occludableRadius: token.occludable?.radius ?? 0,
      footprint: f,
      _placement: { kind: 'token', tokenDoc: token, gridSize: size },
    });
  }

  return { items, skipped };
}
