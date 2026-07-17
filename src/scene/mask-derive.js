/**
 * MASK DERIVATION — the pure math that turns ingested coarse content (art
 * opacity, outdoors masks) into the catalog's DERIVED products (coverAbove,
 * skyReach), per floor, on a fixed small scene-space grid.
 *
 * ============================================================================
 * THE KEYHOLE SHAPE OF THIS (why it is a few KB of Uint8, not a render pass)
 * ============================================================================
 *
 * V2 derived skyReach on the GPU at scene resolution — fullscreen accumulator
 * passes over per-floor world-res `floorAlpha` RTs (`legacy/masks/shaders/
 * skyReachShader.js`), themselves baked by a 4,000-line compositor from
 * world-res sources. The QUESTION being answered — "is there a building above
 * me?" — is inherently coarse: building footprints are hundreds of pixels.
 * Answering it at world resolution is exactly the O(world) cost class Keyhole
 * exists to delete.
 *
 * Here the inputs are the packs' COARSEST pages (each pack's `maxMip` page is
 * the whole item in ≤248² texels, already decoded by the pager on its way to
 * the coarse pin — see mask-authority.js for the ingest seam), and the output
 * is a ≤MASK_GRID_MAX_DIM-per-side Uint8 grid per floor per product. CPU, a
 * few milliseconds, recomputed lazily when inputs change, never blocking a
 * frame. When a GPU pass eventually consumes these (light.visibility's
 * sky-reach term), the grid uploads as one tiny DataTexture through vt/ —
 * deliberately NOT built until that consumer exists.
 *
 * COORDINATES (Y-flip is a recurring bug class here — feedback memory): all
 * world positions are Foundry canvas space, +Y DOWN. Grid row 0 is the
 * world-rect's minY edge (the TOP of the map on screen). Item placements are
 * `foundry/scene-geometry.js` shapes (anchor-based x/y + width/height +
 * clockwise rotation); `worldToItemUv` below is the exact inverse of
 * `computeQuadCorners`' forward transform, and the Node suite cross-checks
 * the two against each other on asymmetric fixtures rather than trusting
 * either in isolation.
 *
 * @module scene/mask-derive
 */

/** Longest grid side for derived products. 512 across a 16K-px world ≈ one
 * texel per ~31px — an order of magnitude finer than any building footprint,
 * three orders cheaper than world-res. */
export const MASK_GRID_MAX_DIM = 512;

/**
 * @typedef {object} MaskGridSpec
 * @property {number} x - world minX of the covered rect.
 * @property {number} y - world minY of the covered rect.
 * @property {number} width - world width covered.
 * @property {number} height - world height covered.
 * @property {number} w - texels across.
 * @property {number} h - texels down.
 * @property {number} texelW - world units per texel, X.
 * @property {number} texelH - world units per texel, Y.
 */

/**
 * @typedef {object} MaskGrid
 * @property {MaskGridSpec} spec
 * @property {Uint8Array} data - w*h, row-major, row 0 = minY.
 */

/** @typedef {{w:number, h:number, data:Uint8Array}} ContentGrid - one item's
 * extracted channel at its pack's coarsest mip. Row 0 = the image's top. */

/**
 * Size a derived-product grid over a world rect (normally the scene's
 * `sceneRect` — art is placed within it; the padding ring holds no art).
 * @param {{x:number, y:number, width:number, height:number}} rect
 * @param {number} [maxDim]
 * @returns {MaskGridSpec}
 */
export function computeMaskGridSpec(rect, maxDim = MASK_GRID_MAX_DIM) {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const scale = maxDim / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { x: rect.x, y: rect.y, width, height, w, h, texelW: width / w, texelH: height / h };
}

/** @param {MaskGridSpec} spec @param {number} [fill] @returns {MaskGrid} */
export function createMaskGrid(spec, fill = 0) {
  const data = new Uint8Array(spec.w * spec.h);
  if (fill) data.fill(fill);
  return { spec, data };
}

/**
 * Inverse of `foundry/scene-geometry.js#computeQuadCorners`' forward
 * transform: world point -> the item's texture UV (u,v in [0,1] inside the
 * art, either coordinate outside that range = the point misses the item).
 * Handles rotation exactly — no AABB approximation — which is what lets a
 * rotated overhead tile cast a correctly-angled cover footprint.
 *
 * @param {{x:number, y:number, width:number, height:number, anchorX?:number,
 *          anchorY?:number, rotation?:number}} placement
 * @param {number} wx @param {number} wy
 * @returns {{u:number, v:number}}
 */
export function worldToItemUv(placement, wx, wy) {
  const { x, y, width, height, anchorX = 0.5, anchorY = 0.5, rotation = 0 } = placement;
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = wx - x;
  const dy = wy - y;
  const lx = cos * dx + sin * dy;
  const ly = -sin * dx + cos * dy;
  return { u: lx / width + anchorX, v: ly / height + anchorY };
}

/**
 * The item's world-space corners (forward transform, duplicated here ONLY for
 * the AABB below — the Node suite pins it corner-for-corner against
 * foundry/scene-geometry.js's `computeQuadCorners` so the two can never
 * drift apart silently).
 * @param {Parameters<typeof worldToItemUv>[0]} placement
 * @returns {Array<{x:number, y:number}>}
 */
export function itemWorldCorners(placement) {
  const { x, y, width, height, anchorX = 0.5, anchorY = 0.5, rotation = 0 } = placement;
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const corner = (u, v) => {
    const lx = (u - anchorX) * width;
    const ly = (v - anchorY) * height;
    return { x: x + (cos * lx - sin * ly), y: y + (sin * lx + cos * ly) };
  };
  return [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
}

/**
 * MAX-composite one item's content grid into a scene grid through its
 * placement. Iterates only the grid texels under the item's rotated-corner
 * AABB; each texel center is inverse-transformed and nearest-sampled.
 *
 * @param {MaskGrid} grid
 * @param {ContentGrid} content
 * @param {Parameters<typeof worldToItemUv>[0]} placement
 */
export function compositeItemMax(grid, content, placement) {
  const { spec, data } = grid;
  const corners = itemWorldCorners(placement);
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));

  const gx0 = Math.max(0, Math.floor((minX - spec.x) / spec.texelW));
  const gx1 = Math.min(spec.w - 1, Math.ceil((maxX - spec.x) / spec.texelW));
  const gy0 = Math.max(0, Math.floor((minY - spec.y) / spec.texelH));
  const gy1 = Math.min(spec.h - 1, Math.ceil((maxY - spec.y) / spec.texelH));

  for (let gy = gy0; gy <= gy1; gy++) {
    const wy = spec.y + (gy + 0.5) * spec.texelH;
    for (let gx = gx0; gx <= gx1; gx++) {
      const wx = spec.x + (gx + 0.5) * spec.texelW;
      const { u, v } = worldToItemUv(placement, wx, wy);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const cx = Math.min(content.w - 1, Math.floor(u * content.w));
      const cy = Math.min(content.h - 1, Math.floor(v * content.h));
      const value = content.data[cy * content.w + cx];
      const i = gy * spec.w + gx;
      if (value > data[i]) data[i] = value;
    }
  }
}

/**
 * @typedef {object} DeriveItemInput
 * @property {string} id
 * @property {number} elevation - the item's sort-key elevation.
 * @property {boolean} hidden - GM-only items do not cover (players' sky is canon).
 * @property {Parameters<typeof worldToItemUv>[0]} placement
 * @property {ContentGrid|null} alpha - art opacity at the pack's coarsest mip,
 *   or null when not (yet) ingested — a null NEVER guesses coverage; it lands
 *   in `completeness.missingItemIds` instead (soft, reported, §4.1's rule).
 */

/**
 * @typedef {object} DeriveFloorInput
 * @property {number} index
 * @property {number} ceilingElevation - the floor's `elevation.top` (Foundry's
 *   own migrated home of `foregroundElevation` — common/documents/scene.mjs:195
 *   maps one onto the other). +Infinity = "no ceiling declared": nothing
 *   counts as above, and the report says so rather than inventing a number.
 * @property {{placement: Parameters<typeof worldToItemUv>[0], content: ContentGrid}|null} outdoors -
 *   the floor's authored outdoors content, or null to serve the catalog default.
 */

/**
 * @typedef {object} DerivedFloorProducts
 * @property {number} index
 * @property {MaskGrid} coverAbove
 * @property {MaskGrid} skyReach
 * @property {{expectedItemIds: string[], missingItemIds: string[], hiddenExcludedIds: string[],
 *             outdoorsSource: 'authored'|'default', ceilingElevation: number}} completeness
 */

/**
 * Derive every floor's products in one pass over the item set.
 *
 * Threshold rule (the load-bearing semantic, verified against the layering
 * law's live drawList): an item covers floor N iff `elevation >=
 * ceilingElevation(N)`. The floor's OWN roof art sits exactly AT the ceiling
 * (`levelForeground` elevation = `elevation.top`) and an upper floor's ground
 * commonly shares that same number — both count as cover, which matches the
 * author-observed stack (roof at 10, upstairs ground at 10, both over a
 * floor-9 rug that must NOT count).
 *
 * @param {object} args
 * @param {MaskGridSpec} args.gridSpec
 * @param {DeriveItemInput[]} args.items
 * @param {DeriveFloorInput[]} args.floors
 * @param {number} args.outdoorsAbsentValue - 0..1 (catalog `outdoors.absentValue`).
 * @returns {DerivedFloorProducts[]}
 */
export function deriveFloorProducts({ gridSpec, items, floors, outdoorsAbsentValue }) {
  const products = [];
  for (const floor of floors) {
    const cover = createMaskGrid(gridSpec);
    const expected = [];
    const missing = [];
    const hiddenExcluded = [];

    for (const item of items) {
      if (!(item.elevation >= floor.ceilingElevation)) continue;
      if (item.hidden) {
        hiddenExcluded.push(item.id);
        continue;
      }
      expected.push(item.id);
      if (!item.alpha) {
        missing.push(item.id);
        continue;
      }
      compositeItemMax(cover, item.alpha, item.placement);
    }

    const sky = createMaskGrid(gridSpec);
    const absentByte = Math.round(outdoorsAbsentValue * 255);
    if (floor.outdoors) {
      // Rasterize the authored outdoors through ITS OWN placement (the mask
      // file's native size can legitimately differ from the albedo's), then
      // combine. Texels the outdoors art does not reach read the absent value.
      const outdoorsGrid = createMaskGrid(gridSpec);
      compositeItemMax(outdoorsGrid, floor.outdoors.content, floor.outdoors.placement);
      const covered = createMaskGrid(gridSpec);
      compositeItemMax(covered, makeUniformContent(1, 255), floor.outdoors.placement);
      for (let i = 0; i < sky.data.length; i++) {
        const o = covered.data[i] > 0 ? outdoorsGrid.data[i] : absentByte;
        sky.data[i] = Math.round((o * (255 - cover.data[i])) / 255);
      }
    } else {
      for (let i = 0; i < sky.data.length; i++) {
        sky.data[i] = Math.round((absentByte * (255 - cover.data[i])) / 255);
      }
    }

    products.push({
      index: floor.index,
      coverAbove: cover,
      skyReach: sky,
      completeness: {
        expectedItemIds: expected,
        missingItemIds: missing,
        hiddenExcludedIds: hiddenExcluded,
        outdoorsSource: floor.outdoors ? 'authored' : 'default',
        ceilingElevation: floor.ceilingElevation,
      },
    });
  }
  return products;
}

/** A 1×1 constant content grid (used to mark "where does this item reach"). @param {number} size @param {number} value @returns {ContentGrid} */
export function makeUniformContent(size, value) {
  const data = new Uint8Array(size * size);
  data.fill(value);
  return { w: size, h: size, data };
}

/**
 * Nearest-sample a derived grid at a world position. Returns 0..255, or null
 * outside the grid's rect — null so "outside the scene" can be given the
 * catalog's absent value by the CALLER (the authority), never invented here.
 * @param {MaskGrid} grid @param {number} wx @param {number} wy
 * @returns {number|null}
 */
export function sampleMaskGridWorld(grid, wx, wy) {
  const { spec, data } = grid;
  const gx = Math.floor((wx - spec.x) / spec.texelW);
  const gy = Math.floor((wy - spec.y) / spec.texelH);
  if (gx < 0 || gx >= spec.w || gy < 0 || gy >= spec.h) return null;
  return data[gy * spec.w + gx];
}

/** Mean value 0..1 of a grid — the report's one-glance "how open is this floor" number. @param {MaskGrid} grid @returns {number} */
export function maskGridMean(grid) {
  if (grid.data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < grid.data.length; i++) sum += grid.data[i];
  return sum / (grid.data.length * 255);
}

/**
 * Extract one channel of a decoded page's CONTENT WINDOW into a ContentGrid.
 * `window` is decode-pool's `computePagePlacement` result for that page (dx/
 * dy/dw/dh — where the REAL, unpadded image content sits inside the square
 * page canvas); everything outside it is border/clamp padding and is skipped,
 * so the returned grid is exactly the item at that mip, nothing else.
 *
 * Pure: operates on any {data,width,height} ImageData-shaped object.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
 * @param {{dx:number, dy:number, dw:number, dh:number}} window
 * @param {'r'|'g'|'b'|'a'} channel
 * @returns {ContentGrid}
 */
export function extractContentWindow(imageData, window, channel) {
  const offset = { r: 0, g: 1, b: 2, a: 3 }[channel];
  const { dx, dy, dw, dh } = window;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const srcRow = (dy + y) * imageData.width;
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] = imageData.data[(srcRow + dx + x) * 4 + offset];
    }
  }
  return { w: dw, h: dh, data: out };
}
