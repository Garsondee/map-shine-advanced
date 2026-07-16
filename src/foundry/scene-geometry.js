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
