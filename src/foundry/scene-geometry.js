/**
 * @fileoverview foundry/scene-geometry.js — THE COORDINATE MODEL.
 *
 * Answers exactly one question, for every drawable: *where does this quad go, in
 * world space?* Every placement in the renderer resolves through this module, so
 * there is one definition of "world space" rather than one per feature.
 *
 * ## World space IS Foundry's canvas space
 *
 * Origin at the top-left of the **padded** rect, +X right, +Y **down**, units =
 * canvas pixels. This is not a preference — it's the space Foundry's own
 * documents are authored in (`Tile#x/y`, `Token#x/y`, wall coordinates), so
 * adopting anything else means converting on every read and getting to debug the
 * conversion forever. Y-down matches PIXI and Foundry; the renderer's camera is
 * responsible for presenting it, not this module (see `vt-pan-viewer`'s
 * orthographic camera, whose `top`/`bottom` are deliberately inverted so +Y
 * points down on screen).
 *
 * ## The correction this module exists to make
 *
 * Before this, the renderer assumed **world space == the background image's
 * pixel space** — a fullscreen quad whose UVs were remapped to the visible
 * region, so "UV" and "world position" were the same number. That assumption is
 * false, and quietly so:
 *
 * - `Scene#padding` **defaults to 0.25** (`common/documents/scene.mjs:78`). The
 *   canvas rect is `sceneWidth + 2x` wide, where `x` is the grid-snapped
 *   padding. On a default scene the canvas is ~1.5× the art, and the art is
 *   *inset* at `sceneRect`, not at the origin.
 * - `scene.width`/`height` are canvas pixels, NOT the background image's native
 *   resolution. Foundry *fits* the image into `sceneRect` via
 *   `PrimarySpriteMesh#resize` — a 4000×3000 image can back a 2000×1500 scene.
 * - Tiles are authored in canvas space and clamped to `[0, d.width]`
 *   (`client/documents/tile.mjs#prepareDerivedData`).
 *
 * All three were invisible while the renderer drew nothing but a full-scene
 * background: the image simply *was* the view, so no second coordinate system
 * existed to disagree with. The instant a tile is placed, every one of them
 * misaligns it. The author's 12000×12000 mansion happens to be square and (so
 * far) has not exposed it — that's luck, not correctness.
 *
 * The fix is to separate two things the old model conflated:
 *   - **UV** — a position within *one texture's own image*, always 0..1.
 *   - **World position** — where that texture's quad sits in canvas space.
 * Geometry carries the world position; `vtSample` keeps taking a UV. This is
 * also what Stage 3's unified geometry pass needs, so it's foundation, not detour.
 *
 * Everything here is pure and Node-tested against the vendored v14 source's own
 * formulas — no Foundry globals, no THREE, no DOM.
 *
 * @module foundry/scene-geometry
 */

/** Foundry's `CONST.TEXTURE_DATA_FIT_MODES` (common/constants.mjs:1955), verbatim. */
export const TEXTURE_FIT_MODES = Object.freeze(['fill', 'contain', 'cover', 'width', 'height']);

/**
 * Replicates `Scene#getDimensions()` (client/documents/scene.mjs:446) and the
 * grid's `calculateDimensions` (common/grid/square.mjs:1349 — gridless and
 * hexagonal use the identical padding formula; only `rows`/`columns`, which we
 * don't need, differ).
 *
 * The padding is **grid-snapped**, which is why this can't be eyeballed as
 * `sceneWidth * (1 + 2*padding)`:
 *
 *     x = ceil(padding * sceneWidth / gridSize) * gridSize
 *
 * Foundry's source carries a standing warning not to rewrite `* (1 / size)` as
 * `/ size` because it changes the result and breaks real scenes — floating-point
 * division and reciprocal-multiplication disagree in the last bit, and `ceil()`
 * amplifies that into a whole grid square. It is reproduced here exactly, for
 * exactly that reason. Do not "simplify" it.
 *
 * @param {object} sceneDoc - a Foundry Scene document (or a plain object with
 *   the same fields — this function never touches a Foundry global, so tests and
 *   callers can hand it a literal).
 * @returns {{width:number, height:number, size:number,
 *            rect:{x:number,y:number,width:number,height:number},
 *            sceneX:number, sceneY:number, sceneWidth:number, sceneHeight:number,
 *            sceneRect:{x:number,y:number,width:number,height:number}}}
 */
export function computeSceneDimensions(sceneDoc) {
  const sceneWidth = sceneDoc?.width ?? 4000; // schema initial values (scene.mjs:76-77)
  const sceneHeight = sceneDoc?.height ?? 3000;
  const padding = sceneDoc?.padding ?? 0.25; // schema initial (scene.mjs:78) — NOT zero
  const size = sceneDoc?.grid?.size ?? 100;
  const shiftX = sceneDoc?.shiftX ?? 0;
  const shiftY = sceneDoc?.shiftY ?? 0;

  // Exactly Foundry's expression — see this function's doc for why the
  // reciprocal multiply is load-bearing and must not be simplified to a divide.
  const x = Math.ceil(padding * sceneWidth * (1 / size)) * size;
  const y = Math.ceil(padding * sceneHeight * (1 / size)) * size;
  const width = sceneWidth + 2 * x;
  const height = sceneHeight + 2 * y;
  const sceneX = x - shiftX;
  const sceneY = y - shiftY;

  return {
    width,
    height,
    size,
    rect: { x: 0, y: 0, width, height },
    sceneX,
    sceneY,
    sceneWidth,
    sceneHeight,
    sceneRect: { x: sceneX, y: sceneY, width: sceneWidth, height: sceneHeight },
  };
}

/**
 * Replicates `PrimarySpriteMesh#resize` (client/canvas/primary/primary-sprite-mesh.mjs
 * :126) — how a texture of arbitrary native resolution is scaled to fill a
 * target box under a fit mode.
 *
 * Returns the **signed** scale. The sign matters and is not a rounding detail: a
 * negative `scaleX`/`scaleY` is how Foundry flips a tile horizontally or
 * vertically, and dropping the sign silently un-flips authored content. Foundry
 * itself only takes `Math.abs()` for the *reported* `_width`/`_height`, while
 * the actual geometry uses the signed value.
 *
 * @param {{width:number, height:number}} textureSize - the texture's NATIVE pixel size.
 * @param {{width:number, height:number}} baseSize - the box to fit into (a tile's
 *   document width/height, or the sceneRect for level art).
 * @param {{fit?:string, scaleX?:number, scaleY?:number}} [options]
 * @returns {{scaleX:number, scaleY:number, width:number, height:number}} signed
 *   scales, plus the resulting rendered size (absolute, as Foundry reports it).
 */
export function computeTextureFit(textureSize, baseSize, { fit = 'fill', scaleX = 1, scaleY = 1 } = {}) {
  const { width: textureWidth, height: textureHeight } = textureSize;
  const { width: baseWidth, height: baseHeight } = baseSize;
  if (!(baseWidth >= 0 && baseHeight >= 0)) {
    throw new Error(`scene-geometry: invalid baseWidth/baseHeight (${baseWidth}x${baseHeight})`);
  }
  if (!(textureWidth > 0 && textureHeight > 0)) {
    throw new Error(`scene-geometry: invalid textureWidth/textureHeight (${textureWidth}x${textureHeight})`);
  }

  let sx;
  let sy;
  switch (fit) {
    case 'fill':
      sx = baseWidth / textureWidth;
      sy = baseHeight / textureHeight;
      break;
    case 'cover':
      sx = sy = Math.max(baseWidth / textureWidth, baseHeight / textureHeight);
      break;
    case 'contain':
      sx = sy = Math.min(baseWidth / textureWidth, baseHeight / textureHeight);
      break;
    case 'width':
      sx = sy = baseWidth / textureWidth;
      break;
    case 'height':
      sx = sy = baseHeight / textureHeight;
      break;
    default:
      // Foundry throws here too — an unknown fit mode is authored data we can't
      // honour, and guessing "fill" would silently mis-size the art.
      throw new Error(`scene-geometry: invalid fit mode "${fit}" (expected one of ${TEXTURE_FIT_MODES.join(', ')})`);
  }
  sx *= scaleX;
  sy *= scaleY;
  return {
    scaleX: sx,
    scaleY: sy,
    width: Math.abs(sx * textureWidth),
    height: Math.abs(sy * textureHeight),
  };
}

/**
 * The four world-space corners of a placed texture quad, in canvas space.
 *
 * The placement model, confirmed against `RectangleShapeData#_createCenter`
 * (client/data/shapes.mjs:801) — note that `(x, y)` is **the anchor point, not
 * the top-left corner**. This trips people up: a default tile has
 * `anchorX/anchorY = 0.5` (`common/documents/tile.mjs:42`), so its `x,y` is its
 * CENTRE. Foundry's own centre formula is
 *
 *     dx = (0.5 - anchorX) * width;  dy = (0.5 - anchorY) * height
 *     centre = (x + (cos*dx - sin*dy), y + (sin*dx + cos*dy))
 *
 * which is precisely this function's `local → rotate → translate` chain
 * evaluated at (u,v) = (0.5, 0.5). Deriving corners from the same chain rather
 * than from a centre + half-extents keeps rotation exact for non-central anchors.
 *
 * Corners are returned in (u,v) order (0,0), (1,0), (1,1), (0,1) — i.e.
 * texture-space top-left, top-right, bottom-right, bottom-left, since +Y is down.
 *
 * @param {object} placement
 * @param {number} placement.x - anchor point X in canvas space.
 * @param {number} placement.y - anchor point Y in canvas space.
 * @param {number} placement.width - the quad's rendered width (from {@link computeTextureFit}).
 * @param {number} placement.height - the quad's rendered height.
 * @param {number} [placement.anchorX] - 0..1 within the quad (default 0.5, Foundry's).
 * @param {number} [placement.anchorY] - 0..1 within the quad (default 0.5).
 * @param {number} [placement.rotation] - degrees, clockwise on screen.
 * @returns {Array<{x:number, y:number}>} four corners in canvas space.
 */
export function computeQuadCorners({ x, y, width, height, anchorX = 0.5, anchorY = 0.5, rotation = 0 }) {
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const uv = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  return uv.map(([u, v]) => {
    const lx = (u - anchorX) * width;
    const ly = (v - anchorY) * height;
    return { x: x + (cos * lx - sin * ly), y: y + (sin * lx + cos * ly) };
  });
}

/**
 * The axis-aligned bounding box of a placed quad, in canvas space.
 *
 * Used for residency (which world region does this drawable need streamed?) and
 * for cheap visibility culling. Derived from the real rotated corners rather
 * than from width/height, so a rotated tile reports the box it actually covers.
 *
 * @param {Parameters<typeof computeQuadCorners>[0]} placement
 * @returns {{minX:number, minY:number, maxX:number, maxY:number}}
 */
export function computeQuadBounds(placement) {
  const corners = computeQuadCorners(placement);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Where a Level's background/foreground art lands in canvas space.
 *
 * Replicates `PrimaryCanvasGroup#drawLevelTexture` (client/canvas/groups/primary.mjs
 * :282): anchored per `Level#textures`, positioned at the **sceneRect centre**
 * plus the configured offset, rotated, and resized to fill the sceneRect under
 * the fit mode.
 *
 * This is the piece that makes level art padding-correct: the quad is placed at
 * `sceneRect`, which is inset inside the padded canvas — not stretched across
 * the whole world, which is what the pre-existing fullscreen-quad model did.
 *
 * @param {{width:number, height:number}} textureSize - the art's native pixel size.
 * @param {ReturnType<typeof computeSceneDimensions>} dimensions
 * @param {object} [texturesConfig] - the Level's `textures` schema field
 *   (anchorX/anchorY/offsetX/offsetY/fit/scaleX/scaleY/rotation). Defaults match
 *   `common/documents/level.mjs:98-107`.
 * @returns {{x:number, y:number, width:number, height:number, anchorX:number,
 *            anchorY:number, rotation:number, scaleX:number, scaleY:number}}
 *   a placement accepted by {@link computeQuadCorners}.
 */
export function computeLevelTexturePlacement(textureSize, dimensions, texturesConfig = {}) {
  const {
    anchorX = 0.5,
    anchorY = 0.5,
    offsetX = 0,
    offsetY = 0,
    fit = 'fill',
    scaleX = 1,
    scaleY = 1,
    rotation = 0,
  } = texturesConfig;
  const r = dimensions.sceneRect;
  const fitted = computeTextureFit(textureSize, { width: r.width, height: r.height }, { fit, scaleX, scaleY });
  return {
    x: r.x + r.width / 2 + offsetX,
    y: r.y + r.height / 2 + offsetY,
    width: fitted.width,
    height: fitted.height,
    anchorX,
    anchorY,
    rotation,
    scaleX: fitted.scaleX,
    scaleY: fitted.scaleY,
  };
}

/**
 * Where a Tile's art lands in canvas space.
 *
 * Replicates `Tile#_refreshPosition/_refreshRotation/_refreshSize`
 * (client/canvas/placeables/tile.mjs:272-315) via the derived
 * `TileDocument#shape` (client/documents/tile.mjs:47): position from the
 * document's `x,y`, anchor and fit from its `texture`, size from its
 * `width,height` under the fit mode.
 *
 * Note the tile's `width`/`height` are the **shape** box; the *rendered* size can
 * differ under any fit mode other than "fill" (e.g. "contain" letterboxes the art
 * inside the box). Foundry keeps those two rects distinct — the shape drives
 * hit-testing and occlusion polygons, the rendered rect drives pixels. This
 * returns the rendered rect, because that's what gets drawn.
 *
 * @param {{width:number, height:number}} textureSize - the tile art's native pixel size.
 * @param {object} tileDoc - a Tile document (or a plain object with the same fields).
 * @returns {{x:number, y:number, width:number, height:number, anchorX:number,
 *            anchorY:number, rotation:number, scaleX:number, scaleY:number}}
 */
export function computeTilePlacement(textureSize, tileDoc) {
  const texture = tileDoc?.texture ?? {};
  const { anchorX = 0.5, anchorY = 0.5, fit = 'fill', scaleX = 1, scaleY = 1 } = texture;
  const fitted = computeTextureFit(
    textureSize,
    { width: tileDoc?.width ?? 0, height: tileDoc?.height ?? 0 },
    { fit, scaleX, scaleY }
  );
  return {
    x: tileDoc?.x ?? 0,
    y: tileDoc?.y ?? 0,
    width: fitted.width,
    height: fitted.height,
    anchorX,
    anchorY,
    rotation: tileDoc?.rotation ?? 0,
    scaleX: fitted.scaleX,
    scaleY: fitted.scaleY,
  };
}

/**
 * A token's footprint in canvas pixels.
 *
 * `x`/`y` are the top-left of the footprint in pixels; `width`/`height` are in
 * GRID UNITS and must be scaled by the grid size. Getting this wrong is silent —
 * a 1x1 token would render one pixel wide and simply look absent.
 *
 * Lives HERE, not in scene-tokens.js (moved 2026-07-17) — it is pure geometry
 * (this module's whole job, per its own header: "where does this quad go, in
 * world space"), and `computeItemPlacement` (scene-layers.js) needs to call it
 * FRESH on every placement resolution, not just at collection time. Keeping it
 * in scene-tokens.js would have forced scene-layers.js to import from
 * scene-tokens.js — which already imports FROM scene-layers.js
 * (`normalizeTint`) — a real import cycle. This module has zero dependencies,
 * so both can reach it without one. `scene-tokens.js` re-exports it so every
 * existing import site (including its own internal callers) is unchanged.
 *
 * ## Hex-grid width/height compression (mythica-machina-press#105)
 *
 * On a hexagonal grid, `TokenDocument#getSize()` (`common/documents/token.mjs:481-494`)
 * compresses ONE axis — the one that packs along the interlocking-hex direction —
 * by `0.75·⌊n⌋ + 0.5·(n mod 1) + 0.25` before multiplying by that axis's own pixel
 * size: a "2-wide" token is 1.75 hex-widths, not 2, because hexes interlock rather
 * than tile edge-to-edge along that axis. `GRID_TYPES` 2/3 (`HEXODDR`/`HEXEVENR`,
 * row-based, pointy-top) compress HEIGHT; 4/5 (`HEXODDQ`/`HEXEVENQ`, column-based,
 * flat-top) compress WIDTH (`common/documents/scene.mjs`'s own
 * `config.columns = (type === HEXODDQ) || (type === HEXEVENQ)`).
 *
 * The grid's own per-axis pixel size also differs from `gridSize` on the
 * UNCOMPRESSED axis: `HexagonalGrid`'s constructor (`common/grid/hexagonal.mjs:22-33`)
 * multiplies `sizeY` (row-based) or `sizeX` (column-based) by `2·√⅓ ≈ 1.1547005…`
 * — reproduced here as a literal (not `Math.SQRT1_3`, which is a Foundry-only
 * polyfill on the global `Math` object, absent in this module's plain-JS/Node
 * test environment) for exactly this file's own standing "no simplifying a
 * reproduced formula" rule.
 *
 * ⚠️ NOT invisible for the common 1×1 case, unlike a first read of the
 * compression formula suggests. For any INTEGER width/height the GRID-UNIT
 * compression itself IS a no-op (`0.75·⌊n⌋ + 0.5·(n mod 1) + 0.25` evaluates
 * to exactly `n`) — but `sizeX`/`sizeY` already disagree by the `2·√⅓` factor
 * BEFORE that multiply ever runs, for every hex token regardless of size,
 * because a regular hexagon's own bounding box isn't square. A plain 1×1
 * token on a flat-top hex grid is genuinely `gridSize·1.1547 × gridSize`
 * pixels, not `gridSize × gridSize` — this was wrong for every single hex
 * token on every hex-grid scene before this fix, not just multi-hex ones.
 *
 * NOT ported here: `TokenDocument#getCenterPoint()`'s shape-specific centroid
 * for non-rectangular hex shapes (ellipse/trapezoid/hex-rectangle,
 * `BaseToken._getHexagonalShape`) — a materially larger port (shape caching,
 * per-shape point tables) left for its own pass. This function still returns a
 * RECTANGULAR footprint/centre, which is what `TokenDocument#getCenterPoint()`
 * ALSO falls back to for any shape/size combination `_getHexagonalShape` has no
 * table for — so this is a narrowing of the gap, not a new inconsistency.
 *
 * @param {object} token - a Token document (or a plain object shaped like one).
 * @param {number} gridSize - `scene.grid.size`, in pixels.
 * @param {number} [gridType] - `scene.grid.type` (`CONST.GRID_TYPES`, `common/constants.mjs`).
 *   Defaults to `1` (`SQUARE`) — every existing caller that passes only two
 *   arguments keeps exactly its old, square-grid behaviour.
 * @returns {{x: number, y: number, width: number, height: number, centerX: number, centerY: number}}
 */
export function tokenFootprint(token, gridSize, gridType = GRID_TYPES.SQUARE) {
  let width = token?.width ?? 1;
  let height = token?.height ?? 1;
  let sizeX = gridSize;
  let sizeY = gridSize;
  if (isHexagonalGridType(gridType)) {
    // 2·√⅓ — see this function's own doc for why it's a literal, not Math.SQRT1_3.
    const HEX_AXIS_SCALE = 1.1547005383792515;
    if (isColumnsHexGridType(gridType)) {
      width = 0.75 * Math.floor(width) + 0.5 * (width % 1) + 0.25;
      sizeX = gridSize * HEX_AXIS_SCALE;
    } else {
      height = 0.75 * Math.floor(height) + 0.5 * (height % 1) + 0.25;
      sizeY = gridSize * HEX_AXIS_SCALE;
    }
  }
  const w = width * sizeX;
  const h = height * sizeY;
  const x = token?.x ?? 0;
  const y = token?.y ?? 0;
  return { x, y, width: w, height: h, centerX: x + w / 2, centerY: y + h / 2 };
}

/**
 * Foundry's `CONST.GRID_TYPES` (`common/constants.mjs`), the values this module
 * needs — reproduced as a plain object (not imported) since this module has
 * zero dependencies by design (see this file's own header).
 */
export const GRID_TYPES = Object.freeze({
  GRIDLESS: 0,
  SQUARE: 1,
  HEXODDR: 2,
  HEXEVENR: 3,
  HEXODDQ: 4,
  HEXEVENQ: 5,
});

/** Row- or column-based hexagonal, `GRID_TYPES.HEXODDR`..`HEXEVENQ`, contiguous. */
function isHexagonalGridType(gridType) {
  return gridType >= GRID_TYPES.HEXODDR && gridType <= GRID_TYPES.HEXEVENQ;
}

/** Column-based (flat-top) hex, as opposed to row-based (pointy-top). */
function isColumnsHexGridType(gridType) {
  return gridType === GRID_TYPES.HEXODDQ || gridType === GRID_TYPES.HEXEVENQ;
}

/**
 * Where a token's ART goes, in canvas pixels.
 *
 * Same return shape as {@link computeTilePlacement} on purpose — the renderer
 * then treats a token like any other quad, and no drawing code learns the word
 * "token". The differences from a tile are entirely in the inputs:
 *
 * - **The footprint is passed in, already in PIXELS.** A token's `width`/`height`
 *   are GRID UNITS (see scene-tokens.js#tokenFootprint), unlike a tile's, which
 *   are pixels. Taking the footprint as an argument rather than the grid size
 *   keeps that conversion in exactly one place and keeps this module free of any
 *   token schema knowledge.
 * - **`fit` defaults to "contain", not "fill"** — the v14 schema's own default
 *   (`TextureData({}, {initial: {..., fit: "contain"}})`). Art is fitted inside
 *   the footprint preserving aspect, never stretched to it.
 * - **`lockRotation` pins rotation to 0**, whatever angle is stored.
 *
 * @param {{width: number, height: number}} textureSize
 * @param {object} tokenDoc
 * @param {{x: number, y: number, width: number, height: number}} footprint - PIXELS.
 * @returns {object} the same placement shape a tile produces.
 */
export function computeTokenPlacement(textureSize, tokenDoc, footprint) {
  const texture = tokenDoc?.texture ?? {};
  const { anchorX = 0.5, anchorY = 0.5, fit = 'contain', scaleX = 1, scaleY = 1 } = texture;
  const fitted = computeTextureFit(
    textureSize,
    { width: footprint.width, height: footprint.height },
    { fit, scaleX, scaleY }
  );
  return {
    // THE FOOTPRINT'S CENTRE, not its top-left. computeQuadCorners treats x/y as
    // the ANCHOR POINT (`lx = (u - anchorX) * width; return x + lx`), and a token's
    // anchor is 0.5/0.5 — so passing the top-left centres the art ON the corner and
    // offsets every token half its size up and left. Author-reported live
    // (2026-07-16): "Tokens don't seem to align with their bounding boxes for
    // selection purposes... I assume that threejs and PIXI might disagree on their
    // position" — exactly right; Foundry's hit box was correct and the art was not.
    //
    // `token.x`/`y` ARE the footprint's top-left (v14 schema), so the conversion
    // belongs here, once, rather than at every call site.
    x: footprint.x + footprint.width / 2,
    y: footprint.y + footprint.height / 2,
    width: fitted.width,
    height: fitted.height,
    anchorX,
    anchorY,
    rotation: tokenDoc?.lockRotation ? 0 : (tokenDoc?.rotation ?? 0),
    scaleX: fitted.scaleX,
    scaleY: fitted.scaleY,
  };
}
