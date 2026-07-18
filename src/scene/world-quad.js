/**
 * @fileoverview scene/world-quad.js — world-space quad geometry and the camera
 * convention. The bridge between "where is this drawable" (canvas space,
 * `foundry/scene-geometry.js`) and "what does the GPU draw".
 *
 * ## Why this module exists at all: Y-flip is a recurring bug class here
 *
 * This project's own history: a *constant battle with Y-flipping*, a fresh
 * instance every time a NEW world→screen or world→texture mapping is introduced,
 * each with a different mechanism, each found live. This module introduces
 * exactly such a mapping — the real geometry pass — so the orientation rules are
 * written down, made explicit, and **Node-tested before they ever reach a
 * browser**, instead of being discovered by looking at an upside-down map.
 *
 * ## The conventions, stated once
 *
 * **World space** = Foundry canvas space: origin at the padded rect's top-left,
 * +X right, **+Y DOWN**, units = canvas pixels.
 *
 * **Image/UV space** = a texture's own pixels normalized to 0..1, with **v=0 at
 * the image's TOP row**. This is not a choice — it's forced by the existing,
 * live-proven decode path: `decode-pool.js#decodePage` crops straight off
 * `worldRect.minY` as an image row, and nothing flips during upload (the atlas
 * is `flipY:false`, and `copyTextureToTexture` reads the DESTINATION's flipY).
 * So `vtSample(uv)` with `uv.y = 0` returns the image's top row, full stop.
 *
 * **The camera** carries the entire flip, in one place: an orthographic camera
 * built with `top = worldRect.minY` and `bottom = worldRect.maxY` — inverted
 * relative to the usual Y-up convention. Three maps `top → NDC +1` (screen top),
 * so the smallest world Y lands at the top of the screen. That is Y-down, and it
 * means **geometry can use raw Foundry coordinates with no conversion anywhere**.
 *
 * The payoff of putting the flip in the camera: a quad's vertices are its literal
 * world corners and its UVs are the literal 0..1 corners, with `uv=(0,0)` on the
 * `minY` corner. Both spaces run the same direction, so no term anywhere else has
 * to be negated — and a negation that doesn't exist can't be applied twice.
 *
 * This REPLACES the old fullscreen-quad-with-remapped-UVs approach, which worked
 * only because it conflated the two spaces (the quad was the screen, its UV was
 * the world position). That's unrepresentable once a tile has to sit at a
 * specific place in a padded canvas.
 *
 * @module scene/world-quad
 */

/**
 * The orthographic camera frustum for a view rect, with the Y-flip applied.
 *
 * `top`/`bottom` are deliberately inverted (`top = minY`). Guard this in review:
 * "fixing" it to `top = maxY` renders the whole world upside-down, which is
 * exactly the bug class this module is documented against.
 *
 * @param {{minX:number, minY:number, maxX:number, maxY:number}} worldRect
 * @returns {{left:number, right:number, top:number, bottom:number}}
 */
export function computeCameraFrustum(worldRect) {
  return {
    left: worldRect.minX,
    right: worldRect.maxX,
    top: worldRect.minY, // NOT maxY — see this function's doc and the module header
    bottom: worldRect.maxY,
  };
}

/**
 * Project a world point to normalized device coordinates under
 * {@link computeCameraFrustum}. Exists so the orientation can be ASSERTED in a
 * Node test rather than asserted in a comment — the whole point of this module.
 *
 * @param {{x:number, y:number}} point
 * @param {{minX:number, minY:number, maxX:number, maxY:number}} worldRect
 * @returns {{x:number, y:number}} NDC, each in [-1, 1] when on screen.
 */
export function worldToNdc(point, worldRect) {
  const f = computeCameraFrustum(worldRect);
  return {
    x: ((point.x - f.left) / (f.right - f.left)) * 2 - 1,
    // (y - top) / (bottom - top) gives 0 at top, 1 at bottom; NDC +1 IS the
    // screen top, so the result is negated into place.
    y: -(((point.y - f.top) / (f.bottom - f.top)) * 2 - 1),
  };
}

/**
 * UVs for a quad, matching {@link computeQuadCorners}'s (0,0),(1,0),(1,1),(0,1)
 * corner order. `uv=(0,0)` pairs with the corner at the texture's own top-left,
 * and v=0 is the image's top row — so an unrotated quad's minY corner samples the
 * image's top row, which is what "not upside-down" means here.
 */
export const QUAD_UVS = Object.freeze([0, 0, 1, 0, 1, 1, 0, 1]);

/**
 * Triangle indices for the same corner order: (0,1,2) and (0,2,3).
 *
 * Winding is deliberately not load-bearing — every material in this renderer uses
 * `side: DoubleSide`, because a tile with a negative `scaleX` (Foundry's way of
 * flipping art horizontally, see `scene-geometry.js#computeTextureFit`) mirrors
 * its corners and reverses the effective winding. Culling by winding would make
 * every flipped tile silently vanish.
 */
export const QUAD_INDICES = Object.freeze([0, 1, 2, 0, 2, 3]);

/**
 * Flatten four world corners into the position buffer a `BufferGeometry` wants.
 * z = 0 for everything: this is a flat 2D composite ordered by the painter's
 * algorithm (`scene/layer-order.js` → `renderOrder`), not a depth-tested 3D
 * scene, so Z carries no information and depth testing stays off.
 *
 * @param {Array<{x:number, y:number}>} corners - exactly 4, from `computeQuadCorners`.
 * @returns {Float32Array} 12 floats (4 verts x xyz).
 */
export function buildQuadPositions(corners) {
  if (corners.length !== 4) throw new Error(`world-quad: expected 4 corners, got ${corners.length}`);
  const out = new Float32Array(12);
  for (let i = 0; i < 4; i++) {
    out[i * 3] = corners[i].x;
    out[i * 3 + 1] = corners[i].y;
    out[i * 3 + 2] = 0;
  }
  return out;
}

/**
 * Invert a placement: world point → the quad's own 0..1 UV space.
 *
 * The exact inverse of `scene-geometry.js#computeQuadCorners`'s
 * `local → rotate → translate` chain, so it stays correct for a rotated tile with
 * an off-centre anchor. Handles a negative scale implicitly (the placement's
 * width/height are absolute; the corner order already encodes any mirroring).
 *
 * @param {{x:number, y:number}} point - in world space.
 * @param {{x:number,y:number,width:number,height:number,anchorX?:number,anchorY?:number,rotation?:number}} placement
 * @returns {{u:number, v:number}} may fall outside [0,1] when the point is off the quad.
 */
export function worldToQuadUv(point, placement) {
  const { x, y, width, height, anchorX = 0.5, anchorY = 0.5, rotation = 0 } = placement;
  const a = (-rotation * Math.PI) / 180; // inverse rotation
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = point.x - x;
  const dy = point.y - y;
  const lx = cos * dx - sin * dy;
  const ly = sin * dx + cos * dy;
  return {
    u: width === 0 ? 0 : lx / width + anchorX,
    v: height === 0 ? 0 : ly / height + anchorY,
  };
}

/**
 * A tile's own placement — so a SPLIT image draws exactly like a whole one.
 *
 * The "load whole images like PIXI" path (2026-07-17) uploads an image whole
 * when it fits the GPU texture limit, or as the smallest grid of sub-tiles when
 * it doesn't (`vt/texture-limits.js#planImageTiles` — the author's quarter-split
 * generalized). Each sub-tile is its OWN texture holding one source rect, and it
 * needs to sit at exactly its slice of the item's world quad. Rather than invent
 * a parallel placement path (a fresh Y-flip waiting to happen — see this
 * module's header), this re-expresses the tile as a normal centred placement:
 * feed the result to the SAME `computeQuadCorners` + `QUAD_UVS` the whole-item
 * path already uses, with the tile's whole texture sampled 0..1.
 *
 * It is the exact FORWARD of {@link worldToQuadUv}: the tile's centre in the
 * item's 0..1 UV space (proportional to the source rect) mapped back to world,
 * honouring the item's anchor and rotation — so a rotated or off-anchor item's
 * tiles stay aligned. For a 1×1 (whole-image) plan it reproduces the item's own
 * quad exactly. Source rects are top-left origin with sy DOWN, matching UV v-down
 * (this module's convention), so no flip is introduced here.
 *
 * @param {{x:number,y:number,width:number,height:number,anchorX?:number,anchorY?:number,rotation?:number}} placement
 *   the whole item's placement (from `computeTilePlacement`/`computeLevelTexturePlacement`).
 * @param {number} sourceW @param {number} sourceH - the item's native image pixels.
 * @param {{sx:number,sy:number,sw:number,sh:number}} tile - one entry of a `planImageTiles` result.
 * @returns {{x:number,y:number,width:number,height:number,anchorX:number,anchorY:number,rotation:number}}
 *   a centred (anchor 0.5) placement for the tile, ready for `computeQuadCorners`.
 */
export function computeTileSubPlacement(placement, sourceW, sourceH, tile) {
  const { x, y, width, height, anchorX = 0.5, anchorY = 0.5, rotation = 0 } = placement;
  const { sx, sy, sw, sh } = tile;
  // The tile's centre in the item's own 0..1 UV space.
  const u = (sx + sw / 2) / sourceW;
  const v = (sy + sh / 2) / sourceH;
  // Forward map (invert worldToQuadUv): local from UV, then rotate+translate.
  // worldToQuadUv builds [lx;ly] = R(a)[dx;dy] with a = -rotation, so the
  // inverse is [dx;dy] = R(a)^T [lx;ly].
  const lx = (u - anchorX) * width;
  const ly = (v - anchorY) * height;
  const a = (-rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = cos * lx + sin * ly;
  const dy = -sin * lx + cos * ly;
  return {
    x: x + dx,
    y: y + dy,
    width: (sw / sourceW) * width,
    height: (sh / sourceH) * height,
    anchorX: 0.5,
    anchorY: 0.5,
    rotation,
  };
}

/**
 * Which part of an item's IMAGE does the current view actually need?
 *
 * The residency planner works in one virtual texture's own image pixels, but the
 * camera works in world space, and — since the coordinate-model correction — those
 * are no longer the same thing. This converts.
 *
 * Projects the view rect's four corners into the quad's UV space and takes their
 * AABB, then scales to image pixels and clamps to the image. Using corners (rather
 * than transforming the rect directly) is what keeps it correct under rotation:
 * a rotated tile's visible region is not an axis-aligned rect in image space, so
 * the AABB of the projected corners is the right conservative answer — it can
 * over-request at odd angles, never under-request, and over-requesting costs a
 * few pages while under-requesting is a visible hole.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} worldRect - the view.
 * @param {object} placement - from `computeTilePlacement`/`computeLevelTexturePlacement`.
 * @param {{width:number, height:number}} imageSize - the texture's native pixels.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} image-space
 *   rect, or null when the view doesn't touch the quad at all.
 */
export function viewRectToImageRect(worldRect, placement, imageSize) {
  const corners = [
    { x: worldRect.minX, y: worldRect.minY },
    { x: worldRect.maxX, y: worldRect.minY },
    { x: worldRect.maxX, y: worldRect.maxY },
    { x: worldRect.minX, y: worldRect.maxY },
  ];
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const c of corners) {
    const { u, v } = worldToQuadUv(c, placement);
    if (u < minU) minU = u;
    if (v < minV) minV = v;
    if (u > maxU) maxU = u;
    if (v > maxV) maxV = v;
  }
  // Entirely off the quad — nothing of this image is on screen.
  if (maxU <= 0 || maxV <= 0 || minU >= 1 || minV >= 1) return null;
  const cu0 = Math.max(0, minU);
  const cv0 = Math.max(0, minV);
  const cu1 = Math.min(1, maxU);
  const cv1 = Math.min(1, maxV);
  return {
    minX: cu0 * imageSize.width,
    minY: cv0 * imageSize.height,
    maxX: cu1 * imageSize.width,
    maxY: cv1 * imageSize.height,
  };
}

/**
 * The screen-pixel extent an item's VISIBLE image region occupies — the
 * `viewportPx` that `residency.chooseMip` needs.
 *
 * `chooseMip` picks a mip from `imageSpan / viewportPx` (texels per screen pixel).
 * Passing the CANVAS size here would be wrong for anything that isn't full-screen:
 * a 1024px tile drawn 100px wide must serve a coarse mip, and a canvas-sized
 * viewportPx would tell the planner it needs mip 0 — i.e. every small tile would
 * stream its full resolution. That's the O(tiles) blowup this whole architecture
 * exists to prevent, arriving through the back door.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} worldRect - the view.
 * @param {{width:number,height:number}} canvasSize - the drawing buffer.
 * @param {{width:number,height:number}} quadWorldSize - the quad's world extent.
 * @returns {number} screen pixels along the quad's larger axis (>= 1).
 */
export function computeItemViewportPx(worldRect, canvasSize, quadWorldSize) {
  const viewW = Math.max(1e-6, worldRect.maxX - worldRect.minX);
  const viewH = Math.max(1e-6, worldRect.maxY - worldRect.minY);
  const screenPxPerWorldPxX = canvasSize.width / viewW;
  const screenPxPerWorldPxY = canvasSize.height / viewH;
  return Math.max(1, Math.max(quadWorldSize.width * screenPxPerWorldPxX, quadWorldSize.height * screenPxPerWorldPxY));
}

/**
 * Cheap cull: does an item's world AABB overlap the view at all?
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} a
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} b
 * @returns {boolean}
 */
export function rectsOverlap(a, b) {
  return !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY);
}
