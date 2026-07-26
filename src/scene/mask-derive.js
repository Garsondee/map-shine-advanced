/**
 * MASK DERIVATION — the pure math that turns ingested coarse content (art
 * opacity, outdoors masks) into the catalog's DERIVED products (coverAbove,
 * skyReach) PLUS the raw rasterized `outdoors` value alone (2026-07-21 —
 * see `DerivedFloorProducts`'s own doc for why a general "is this indoors"
 * signal needs to exist SEPARATELY from skyReach's narrower, rain-specific
 * "is there open sky above me" question), per floor, on a fixed small
 * scene-space grid.
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
 * BILINEAR sample of a content grid at normalized (u,v).
 *
 * ⚠️ THIS REPLACED NEAREST, AND THAT WAS THE "BLOCKY, SQUARE-EDGED" BUG
 * (author, 2026-07-26). A content grid is the pack's COARSEST mip — ≤248 texels
 * for a whole item, so ~43 world px per texel on a 10,650 px map. Nearest
 * sampling stamps each of those as a hard 43 px square into the (finer) scene
 * grid, and every consumer downstream inherits a staircase no amount of shader
 * softening can undo: the sun shadow's silhouette, the sky gate at a doorway,
 * the wind's shelter boundary. Interpolating costs three extra array reads per
 * texel in a pass that already runs lazily, on the CPU, a few times a scene.
 *
 * Half-texel offset (`u*w − 0.5`) so the interpolation is centred on texel
 * CENTRES — without it every sampled value is biased half a texel toward the
 * origin, which is a Y-flip-class error that shows up as art creeping up-left
 * (`feedback_y_flip_recurring_risk`: verify orientation at every new mapping).
 * Edges clamp rather than wrap: an item's own border must not fold back in.
 *
 * @param {ContentGrid} content
 * @param {number} u - 0..1 across the content.
 * @param {number} v - 0..1 down the content.
 * @returns {number} 0..255, interpolated.
 */
export function sampleContentBilinear(content, u, v) {
  const { w, h, data } = content;
  const fx = u * w - 0.5;
  const fy = v * h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const cx0 = x0 < 0 ? 0 : x0 > w - 1 ? w - 1 : x0;
  const cy0 = y0 < 0 ? 0 : y0 > h - 1 ? h - 1 : y0;
  const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 > w - 1 ? w - 1 : x0 + 1;
  const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 > h - 1 ? h - 1 : y0 + 1;
  const top = data[cy0 * w + cx0] * (1 - tx) + data[cy0 * w + cx1] * tx;
  const bot = data[cy1 * w + cx0] * (1 - tx) + data[cy1 * w + cx1] * tx;
  return top * (1 - ty) + bot * ty;
}

/**
 * MAX-composite one item's content grid into a scene grid through its
 * placement. Iterates only the grid texels under the item's rotated-corner
 * AABB; each texel center is inverse-transformed and bilinearly sampled.
 *
 * @param {MaskGrid} grid
 * @param {ContentGrid} content
 * @param {Parameters<typeof worldToItemUv>[0]} placement
 * @param {number} [valueScale=1] - multiplier applied to each sampled byte
 *   before the MAX.
 *
 *   ⚠️ DO NOT USE THIS TO CARRY A CASTER'S HEIGHT. It did until 2026-07-26, and
 *   that was the sun shadow's root defect: multiplying an item's ALPHA by its
 *   HEIGHT stores two physical quantities in one byte, so the art's antialiased
 *   edge became a height ramp → a shadow-length ramp → a darkness ramp
 *   (docs/planning/Sun-Shadows-Rethink.md §2c). Composite coverage here and
 *   height through {@link compositeItemHeightMax}, which keeps them separate.
 */
export function compositeItemMax(grid, content, placement, valueScale = 1) {
  const { spec, data } = grid;
  const scale = Number.isFinite(valueScale) ? Math.max(0, valueScale) : 1;
  if (scale === 0) return;
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
      const raw = sampleContentBilinear(content, u, v);
      const value = Math.min(255, Math.round(scale === 1 ? raw : raw * scale));
      const i = gy * spec.w + gx;
      if (value > data[i]) data[i] = value;
    }
  }
}

/**
 * OVERWRITE-composite one item's content grid into a scene grid through its
 * placement. Unlike {@link compositeItemMax}, this REPLACES the destination
 * value unconditionally within the item's own footprint rather than keeping
 * whichever is brighter — which is what lets a LATER item in draw order
 * paint something DARKER than an earlier one too, not just brighter. Author
 * directive, 2026-07-26 (docs/planning/Specular.md §9 / the mask-any-item
 * decision): a Tile's own `_Outdoors` mask can wall a hole back up — turn a
 * texel from outdoors back to indoors — which a MAX-only composite could
 * never do (MAX only ever raises a value, never lowers it).
 *
 * Composite MULTIPLE sources onto one grid by calling this once per source
 * in ASCENDING draw order (`scene/layer-order.js#compareLayerKeys` — the
 * SAME order the visible artwork itself paints in): the last call to reach a
 * texel wins there. A texel no source's own placement ever reaches is simply
 * never written, so it keeps whatever the grid held before this pass — the
 * caller (`rasterizeAuthored`) relies on that to tell "nothing was ever
 * painted here" apart from "something was painted here and it was 0".
 *
 * @param {MaskGrid} grid
 * @param {ContentGrid} content
 * @param {Parameters<typeof worldToItemUv>[0]} placement
 */
export function compositeItemOverwrite(grid, content, placement) {
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
      const raw = sampleContentBilinear(content, u, v);
      data[gy * spec.w + gx] = Math.min(255, Math.round(raw));
    }
  }
}

/**
 * Coverage is the THRESHOLD above which an item's alpha is treated as really
 * being there for the purpose of writing its HEIGHT. ~3 %: below this the art is
 * the faintest fringe of an antialiased edge, and letting that write full height
 * would inflate every caster's height footprint by a texel or two of nothing.
 *
 * It does NOT soften anything — softness is the coverage channel's whole job.
 * This only decides where a height is DEFINED, and the direction of the error is
 * chosen deliberately: too-generous is harmless (coverage gates it to nothing),
 * too-tight loses shadow at the silhouette's edge.
 */
export const HEIGHT_COVERAGE_THRESHOLD = 8;

/**
 * MAX-composite one item's HEIGHT into a scene grid, wherever that item's alpha
 * clears {@link HEIGHT_COVERAGE_THRESHOLD}.
 *
 * The counterpart to {@link compositeItemMax}, and the fix for the packing
 * defect its own doc names: this writes the item's height AS ITSELF, never
 * multiplied by alpha. A half-transparent texel of a 300 px bridge deck stores
 * "300 px, half covered" (height here, coverage there) instead of the old
 * "150 px caster", which the march could only read as a shorter, fainter,
 * differently-shaped object than the deck actually is.
 *
 * @param {MaskGrid} grid - the height grid.
 * @param {ContentGrid} content - the item's alpha.
 * @param {Parameters<typeof worldToItemUv>[0]} placement
 * @param {number} heightByte - the item's own height, 0..255 over the field scale.
 */
export function compositeItemHeightMax(grid, content, placement, heightByte) {
  const { spec, data } = grid;
  const value = Math.max(0, Math.min(255, Math.round(heightByte)));
  if (value === 0) return;
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
      if (sampleContentBilinear(content, u, v) < HEIGHT_COVERAGE_THRESHOLD) continue;
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
 * @property {number|null} [ownerFloorIndex] - for a LEVEL's own background or
 *   foreground art only: the index of the floor it belongs to. Null for tiles.
 *
 *   ⚠️ THIS OUTRANKS `elevation` FOR THE "IS IT ABOVE ME" TEST, and that is the
 *   2026-07-26 sky-reach fix. A level's background sits at its own
 *   `elevation.bottom` — the boundary it SHARES with the floor below's ceiling —
 *   so `elevation >= ceilingElevation` only holds while a scene's bands abut
 *   exactly. Overlap them by one unit and every upper floor's BACKGROUND
 *   silently stops casting while its FOREGROUND (at `elevation.top`) still
 *   does. That is precisely what the author saw: *"it only shows the overhead
 *   parts of the upper floors… we're not including 'background image' and
 *   'foreground image'"*. Floor membership is unambiguous and cannot drift, so
 *   for level art it is simply the better question to ask.
 * @property {number[]|null} [visibleFloorIndices] - for a TILE only: every
 *   floor index it is actually drawn on (`foundry/scene-layers.js#collectTiles`'s
 *   own `visibleOnLevelIds`, resolved to indices). Null when unknown (treated
 *   as "elevation alone decides", the pre-2026-07-26-round-2 behaviour).
 *
 *   ⚠️ SAME BUG AS `ownerFloorIndex`, ONE LEVEL LATER (round 2, author-caught
 *   live: a raised prop rendered its shadow through its own sprite). A tile
 *   drawn ON this floor cannot ALSO be "a different floor's structure above
 *   this floor" — no matter how its `elevation` compares to this floor's own
 *   ceiling. If this floor's index is in the list, the item is ALWAYS treated
 *   as this floor's own overhead content (never sky-reach), uncapped by the
 *   ceiling — its elevation number may exceed it for pure draw-order reasons,
 *   and that must not reclassify it as a separate layer it never was.
 */

/**
 * @typedef {object} DeriveFloorInput
 * @property {number} index
 * @property {number} ceilingElevation - the floor's `elevation.top` (Foundry's
 *   own migrated home of `foregroundElevation` — common/documents/scene.mjs:195
 *   maps one onto the other). +Infinity = "no ceiling declared": nothing
 *   counts as above, and the report says so rather than inventing a number.
 * @property {number} [bottomElevation] - the floor's `elevation.bottom` — the
 *   GROUND a caster's height is measured from. Non-finite = "unknown", which
 *   makes the OVERHEAD band empty (there is no floor to be raised above) and is
 *   reported rather than guessed at zero.
 * @property {Array<{placement: Parameters<typeof worldToItemUv>[0], content: ContentGrid}>} outdoors -
 *   EVERY item that authored outdoors content for this floor (background,
 *   foreground, any visible Tile — 2026-07-26, `keyhole-mask-any-item-
 *   decision`, LOCKED), already sorted ascending by draw order. Empty array
 *   = nothing authored anywhere on this floor, serve the catalog default.
 * @property {Record<string, {sources: Array<{placement: Parameters<typeof worldToItemUv>[0],
 *   content: ContentGrid}>, absentValue: number}>} [authored] - every OTHER
 *   `rasterize: true` kind (mask-catalog.js), keyed by kind id, same
 *   ordered-list shape as `outdoors`. `outdoors` keeps its own dedicated
 *   field because two DERIVED products are built on top of it here
 *   (`skyReach`, the caster building channel) and those reads should not go
 *   through a string lookup that could silently miss.
 */

/**
 * @typedef {object} CasterHeightSpec - how {@link deriveFloorProducts} turns
 *   elevations into the occluder height field (docs/planning/Sun-Shadows.md §3.1).
 * @property {number} scalePx - world px represented by a byte value of 255.
 * @property {number} distancePixels - `canvas.dimensions.distancePixels`, the
 *   ONE conversion from Foundry's scene distance units to world pixels. Never
 *   assumed: an elevation of "5" is five FEET (or metres, or whatever the scene
 *   declares), not five pixels.
 * @property {number} buildingHeightPx - how tall the dark of `_Outdoors` stands.
 *   The one number with no Foundry source, so the one number with a slider.
 * @property {{building?: boolean, overhead?: boolean, skyReach?: boolean}} [include] -
 *   the ROH isolation toggles, applied HERE rather than as shader uniforms: a
 *   disabled producer's channel is simply never written, so turning it off
 *   genuinely removes it (tsl/no-uniform-gates — a uniform set to zero still
 *   executes every pixel and pays for its bindings).
 */

/**
 * @typedef {object} DerivedFloorProducts
 * @property {number} index
 * @property {MaskGrid} coverAbove
 * @property {MaskGrid} skyReach
 * @property {MaskGrid} outdoors - the RAW authored outdoors value alone
 *   (white=outdoors/black=indoors, absent-value-filled outside the mask's
 *   own reach) — deliberately NOT multiplied by `(1-coverAbove)` the way
 *   `skyReach` is. `skyReach` answers "is there open sky above me" (its
 *   real, narrow, V2-inherited purpose: keeping rain from falling under a
 *   bridge/roof — Wind.md's author, 2026-07-21); THIS answers the simpler,
 *   more common question "is this location indoors or outdoors", which is
 *   what general shelter/exposure consumers (wind sway, ambient sound, …)
 *   actually want and `skyReach` only coincidentally matches on a
 *   single-floor scene with no ceiling declared (coverAbove ≡ 0 there).
 * @property {MaskGrid} casterHeight - THE OCCLUDER HEIGHT FIELD, max-combined
 *   across the three producers: how tall the thing between this texel and the
 *   sun is, as a byte over `CasterHeightSpec.scalePx`. This is what a point
 *   consumer samples ("how high is the bridge over my head?"); the GPU march
 *   reads `casterChannels` instead so the three can be told apart.
 * @property {{building: MaskGrid, overhead: MaskGrid, skyReach: MaskGrid, height: MaskGrid,
 *   coverBuilding: MaskGrid, coverOverhead: MaskGrid, coverSkyReach: MaskGrid}} casterChannels -
 *   the field's HEIGHT (`height`, MAX-merged, byte over `CasterHeightSpec.scalePx`)
 *   plus each producer's own COVERAGE, unmerged (2026-07-26 rethink — coverage
 *   and height are two facts per producer, never one byte; Sun-Shadows-
 *   Rethink.md §3). `building`/`overhead`/`skyReach` are the legacy PER-PRODUCER
 *   HEIGHTS, kept for the isolation toggles and the pixel probe's "which of the
 *   three is missing". ⚠️ There is no `coverFloating` — it existed only
 *   2026-07-26T00-18, folded `coverOverhead` into the sun march's zero-distance
 *   self-check, and made a same-floor overhead item (a raised tile occupying
 *   the IDENTICAL (x,y) as whatever it would "shade") paint a shadow through
 *   its own sprite. That check now reads `coverSkyReach` alone — a genuinely
 *   different floor's structure, whose art this floor never draws at that
 *   pixel (docs/planning/Sun-Shadows-Rethink.md §4b).
 *   "the shadow looks wrong".
 * @property {Record<string, MaskGrid>} authored - every OTHER `rasterize: true`
 *   kind's raw grid (`water` today), keyed by kind id. No derivation on top:
 *   these exist because a GPU consumer bakes from the authored value directly.
 * @property {{expectedItemIds: string[], missingItemIds: string[], hiddenExcludedIds: string[],
 *             outdoorsSource: 'authored'|'default',
 *             authoredSources: Record<string, 'authored'|'default'>,
 *             ceilingElevation: number,
 *             bottomElevation: number, overheadItemIds: string[], skyReachItemIds: string[]}} completeness
 */

/**
 * Rasterize an ORDERED LIST of authored mask sources onto ONE scene grid —
 * every item that authored this kind for this floor (a Tile's own `_Water`
 * beside the floor's own background `_Water`, say) composites into the SAME
 * grid rather than each living on its own. Author directive, 2026-07-26,
 * responding directly to the question "how does a Tile's own mask combine
 * with what's already painted underneath it": *"I want to blow the corner of
 * a building open... a tile with the corner blown off in the artwork AND
 * with its own `_Outdoors` mask... automatically overwrites the `_Outdoors`
 * so that suddenly the corner of the building is outside where previously it
 * was inside."* — see `keyhole-mask-any-item-decision` (LOCKED).
 *
 * `sources` MUST already be in ASCENDING draw order (mask-authority.js
 * resolves that via `scene/layer-order.js#compareLayerKeys`, the SAME
 * comparator the visible art itself sorts by, before calling this) — each
 * later source OVERWRITES an earlier one within their shared footprint
 * ({@link compositeItemOverwrite}, never a MAX composite: MAX could only
 * ever brighten a texel, and the author's own example needs a tile that can
 * darken one too — wall a hole back up, not just open one).
 *
 * A texel NO source's own placement ever reaches keeps the kind's absent
 * value — "authored, by at least one contributing item" and "never painted
 * by anything on this floor" stay two different, honestly-reported facts.
 * This generalizes the ORIGINAL single-source rule (extracted 2026-07-25,
 * one background item only) to N; an empty or single-element list reduces to
 * exactly the old behaviour.
 *
 * @param {MaskGridSpec} gridSpec
 * @param {Array<{placement: Parameters<typeof worldToItemUv>[0], content: ContentGrid}>} sources -
 *   already filtered to real content+placement, already sorted ascending by draw order.
 * @param {number} absentValue - 0..1, the catalog's own.
 * @returns {MaskGrid}
 */
export function rasterizeAuthored(gridSpec, sources, absentValue) {
  const grid = createMaskGrid(gridSpec);
  const absentByte = Math.round(Math.max(0, Math.min(1, absentValue)) * 255);
  grid.data.fill(absentByte);
  for (const source of sources ?? []) {
    if (!source?.content || !source?.placement) continue;
    compositeItemOverwrite(grid, source.content, source.placement);
  }
  return grid;
}

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
 * THE THREE CASTER BANDS, on the same elevation axis, so they cannot overlap or
 * leave a gap (docs/planning/Sun-Shadows.md §3.1):
 *
 *   elevation >= ceilingElevation                    → SKY-REACH (art overhead:
 *                                                      upper grounds, this
 *                                                      floor's own roof)
 *   bottomElevation < elevation < ceilingElevation   → OVERHEAD (this floor's
 *                                                      own raised tiles —
 *                                                      balconies, awnings)
 *   elevation <= bottomElevation                     → nothing (it is the
 *                                                      ground, or under it)
 *
 * @param {object} args
 * @param {MaskGridSpec} args.gridSpec
 * @param {DeriveItemInput[]} args.items
 * @param {DeriveFloorInput[]} args.floors
 * @param {number} args.outdoorsAbsentValue - 0..1 (catalog `outdoors.absentValue`).
 * @param {CasterHeightSpec} [args.casterHeights] - omit to leave the height
 *   field empty (every channel zero) — the honest state before a scene has told
 *   us its grid scale, not a guess.
 * @returns {DerivedFloorProducts[]}
 */
export function deriveFloorProducts({ gridSpec, items, floors, outdoorsAbsentValue, casterHeights = null }) {
  const products = [];
  const heightScalePx = casterHeights?.scalePx > 0 ? casterHeights.scalePx : 0;
  const distancePixels = Number.isFinite(casterHeights?.distancePixels) ? casterHeights.distancePixels : 0;
  const include = casterHeights?.include ?? {};
  const wantBuilding = heightScalePx > 0 && include.building !== false;
  const wantOverhead = heightScalePx > 0 && distancePixels > 0 && include.overhead !== false;
  const wantSkyReach = heightScalePx > 0 && distancePixels > 0 && include.skyReach !== false;

  for (const floor of floors) {
    const cover = createMaskGrid(gridSpec);
    const expected = [];
    const missing = [];
    const hiddenExcluded = [];
    const overheadIds = [];
    const skyReachIds = [];
    /** One row per item: the classification, made inspectable. See
     * `completeness.itemBands`. */
    const itemBands = [];

    const bottomElevation = Number.isFinite(floor.bottomElevation) ? floor.bottomElevation : null;
    // HEIGHTS (world px as a byte over `heightScalePx`) and COVERAGE (art
    // alpha) are separate grids per producer — the whole point of the
    // 2026-07-26 rethink. One byte cannot mean both without the art's soft edge
    // silently becoming a short caster (Sun-Shadows-Rethink.md §2c).
    const casterBuilding = createMaskGrid(gridSpec);
    const casterOverhead = createMaskGrid(gridSpec);
    const casterSkyReach = createMaskGrid(gridSpec);
    const coverOverhead = createMaskGrid(gridSpec);
    const coverSkyReach = createMaskGrid(gridSpec);
    /** Tallest caster written to this floor, in BYTES — reported so "there are
     * casters but they are all zero-height" is a readable state rather than an
     * invisible one. That exact condition (a floor with no declared
     * `bottomElevation` makes every height 0 while the item COUNTS stay
     * healthy) is what made sky-reach undebuggable — feedback_instruments_must_not_lie. */
    let maxCasterByte = 0;

    /** An item's height above THIS floor's ground, in world px (0 if unknown). */
    const heightPxOf = (item) =>
      bottomElevation === null ? 0 : Math.max(0, (item.elevation - bottomElevation) * distancePixels);
    /** The same, as the field's own byte. */
    const heightByteOf = (item) => {
      const byte = Math.min(255, Math.round((heightPxOf(item) / heightScalePx) * 255));
      if (byte > maxCasterByte) maxCasterByte = byte;
      return byte;
    };

    for (const item of items) {
      // FLOOR MEMBERSHIP FIRST for a level's own art, elevation for everything
      // else — see `DeriveItemInput.ownerFloorIndex` for why the elevation test
      // alone silently dropped every upper-floor BACKGROUND.
      const owner = Number.isFinite(item.ownerFloorIndex) ? item.ownerFloorIndex : null;
      // ⚠️ ROUND TWO OF THE SAME BUG (author-caught live: a raised prop's
      // shadow rendered through its own sprite). A TILE actually drawn on THIS
      // floor cannot be "a different floor's structure above it" no matter
      // what its elevation number says relative to this floor's ceiling — see
      // `DeriveItemInput.visibleFloorIndices`. `null` (visibility unknown)
      // falls back to the original elevation-only test unchanged.
      const visibleHere = Array.isArray(item.visibleFloorIndices) && item.visibleFloorIndices.includes(floor.index);
      const isAbove =
        owner !== null ? owner > floor.index : visibleHere ? false : item.elevation >= floor.ceilingElevation;
      // The overhead band needs a known ground to be measured from; without one
      // there is no such thing as "raised above this floor" and the completeness
      // record says so (bottomElevation: null) rather than treating 0 as ground.
      //
      // `owner === null` is explicit, not incidental: a level's OWN art is never
      // an overhead protrusion. It is either above (handled by the membership
      // test) or it is this floor's own ground and casts nothing. The elevation
      // arithmetic happens to agree today; stating it means a future band change
      // cannot quietly reclassify a whole floor's background as a balcony.
      //
      // `visibleHere` DROPS THE CEILING CAP, not just the sky-reach test: a
      // tile confirmed drawn here is this floor's own content regardless of
      // how tall its elevation number reads (often chosen purely for draw
      // order), so nothing about it may reclassify as "not overhead either".
      const isOverhead =
        owner === null &&
        bottomElevation !== null &&
        item.elevation > bottomElevation &&
        (visibleHere || item.elevation < floor.ceilingElevation);
      // The verdict for THIS item, recorded before any of the early exits below
      // — every item gets a row, including the ones that cast nothing, because
      // "why is this not casting" is the question being asked.
      const band = isAbove ? 'skyReach' : isOverhead ? 'overhead' : 'none';
      itemBands.push({
        id: item.id,
        band,
        elevation: item.elevation,
        ownerFloorIndex: owner,
        heightPx: band === 'none' ? 0 : Math.round(heightPxOf(item)),
        hasArt: !!item.alpha,
        hidden: !!item.hidden,
      });
      if (!isAbove && !isOverhead) continue;
      if (item.hidden) {
        hiddenExcluded.push(item.id);
        continue;
      }
      // `expected`/`missing` stay scoped to the COVER question (art at or above
      // the ceiling) so `coverAbove`'s own completeness contract is unchanged;
      // the two caster bands get their own id lists below.
      if (isAbove) expected.push(item.id);
      if (!item.alpha) {
        if (isAbove) missing.push(item.id);
        continue;
      }
      if (isAbove) {
        compositeItemMax(cover, item.alpha, item.placement);
        if (wantSkyReach) {
          skyReachIds.push(item.id);
          compositeItemMax(coverSkyReach, item.alpha, item.placement);
          compositeItemHeightMax(casterSkyReach, item.alpha, item.placement, heightByteOf(item));
        }
      } else if (wantOverhead) {
        overheadIds.push(item.id);
        compositeItemMax(coverOverhead, item.alpha, item.placement);
        compositeItemHeightMax(casterOverhead, item.alpha, item.placement, heightByteOf(item));
      }
    }

    const sky = createMaskGrid(gridSpec);
    const outdoors = rasterizeAuthored(gridSpec, floor.outdoors, outdoorsAbsentValue);
    for (let i = 0; i < sky.data.length; i++) {
      sky.data[i] = Math.round((outdoors.data[i] * (255 - cover.data[i])) / 255);
    }

    // Every OTHER `rasterize: true` kind (mask-catalog.js) — `water` today.
    // Same rasterizer, no derivation on top: the consumer is a GPU bake, and
    // the authority's job ends at "here is the authored value on the grid".
    const authored = {};
    for (const [kindId, input] of Object.entries(floor.authored ?? {})) {
      authored[kindId] = rasterizeAuthored(gridSpec, input?.sources, input?.absentValue ?? 0);
    }
    const authoredSources = Object.fromEntries(
      Object.entries(floor.authored ?? {}).map(([id, input]) => [
        id,
        input?.sources?.length > 0 ? 'authored' : 'default',
      ])
    );

    // THE BUILDING CHANNEL — the dark of `_Outdoors` IS the building footprint.
    // No item, no alpha, no elevation: the author already painted where the
    // walls are, and that painting is a REQUIRED mask, so this producer can
    // never be starved the way the art-opacity ones can.
    //
    // COVERAGE and HEIGHT, separately (the rethink's whole point): indoor-ness
    // is the COVERAGE — a doorway painted mid-grey is half-covered, and a
    // half-covered texel casts a half-strength shadow, which is what a soft
    // threshold at a door should be. It used to scale the HEIGHT instead, which
    // made that same doorway a half-height wall casting a half-LENGTH shadow.
    const coverBuilding = createMaskGrid(gridSpec);
    if (wantBuilding && casterHeights.buildingHeightPx > 0) {
      const buildingByte = Math.min(255, Math.round((casterHeights.buildingHeightPx / heightScalePx) * 255));
      if (buildingByte > maxCasterByte) maxCasterByte = buildingByte;
      for (let i = 0; i < coverBuilding.data.length; i++) {
        const indoorness = 255 - outdoors.data[i];
        coverBuilding.data[i] = indoorness;
        casterBuilding.data[i] = indoorness >= HEIGHT_COVERAGE_THRESHOLD ? buildingByte : 0;
      }
    }

    // OVERHEAD gated to EXTERIOR protrusions (author, 2026-07-24: *"Overhead
    // shadows from inside of a building are ending up projected outside the
    // building."*). An overhead tile sitting over INDOOR ground is interior
    // architecture under a roof — the sun never reaches it, so it must not
    // cast a sun-shadow at all (and certainly not one that leaks out past the
    // wall onto the courtyard, which is what a receiver-gated-only shadow did).
    //
    // Applied to the COVERAGE, with the height zeroed wherever the gated
    // coverage vanishes — never to the height directly, which would re-create
    // the alpha×height coupling this rethink exists to remove.
    for (let i = 0; i < coverOverhead.data.length; i++) {
      const gated = Math.round((coverOverhead.data[i] * outdoors.data[i]) / 255);
      coverOverhead.data[i] = gated;
      if (gated < HEIGHT_COVERAGE_THRESHOLD) casterOverhead.data[i] = 0;
    }

    // MAX, not sum: three producers describing ONE physical quantity (how tall
    // the occluder is). A chimney on a roof over a building is not three
    // shadows stacked, it is the tallest of the three. This is the same
    // reasoning `combineVisibility` uses for min-combining visibility, one
    // level down.
    const casterHeight = createMaskGrid(gridSpec);
    for (let i = 0; i < casterHeight.data.length; i++) {
      const b = casterBuilding.data[i];
      const o = casterOverhead.data[i];
      const s = casterSkyReach.data[i];
      casterHeight.data[i] = b > o ? (b > s ? b : s) : o > s ? o : s;
    }

    products.push({
      index: floor.index,
      coverAbove: cover,
      skyReach: sky,
      outdoors,
      authored,
      casterHeight,
      casterChannels: {
        building: casterBuilding,
        overhead: casterOverhead,
        skyReach: casterSkyReach,
        // THE FOUR THE GPU ACTUALLY PACKS (R,G,B + the gate arrives separately).
        // ⚠️ NO `coverFloating`. R packs `coverSkyReach` alone — see this
        // typedef's own doc for why folding `coverOverhead` in was the bug.
        height: casterHeight,
        coverBuilding,
        coverOverhead,
        coverSkyReach,
      },
      completeness: {
        expectedItemIds: expected,
        missingItemIds: missing,
        hiddenExcludedIds: hiddenExcluded,
        outdoorsSource: floor.outdoors?.length > 0 ? 'authored' : 'default',
        // Per rasterized kind: did real authored content reach this floor, or
        // is the grid an absent-fill? `water` reads this to decide whether the
        // floor genuinely HAS water — an all-zero grid from a real all-land
        // mask and an all-zero grid from no mask at all are different facts,
        // and only one of them means "do not bake" (feedback_required_masks_fail_loud
        // applied to a kind that is not required: report the difference rather
        // than throw on it).
        authoredSources,
        ceilingElevation: floor.ceilingElevation,
        // null (not 0) when the floor declares no ground: "we do not know" and
        // "it is at zero" produce very different shadows, and only one of them
        // is a fact (feedback_required_masks_fail_loud's reasoning, applied to a
        // number rather than a file).
        bottomElevation,
        overheadItemIds: overheadIds,
        skyReachItemIds: skyReachIds,
        // ⚠️ THE FIELD'S TALLEST CASTER, in world px. Zero WITH a non-empty
        // item list is the exact silent failure that hid sky-reach for months:
        // a floor with no declared `bottomElevation` gives every caster a
        // height of 0, so the counts stay healthy while the field is blank and
        // nothing casts. Reported so the two states can never look alike.
        maxCasterHeightPx: Math.round((maxCasterByte / 255) * heightScalePx),
        // EVERY item's verdict, in one table: what it is, where it sits, which
        // band took it, and whether its art had arrived. Added 2026-07-26
        // because "sky-reach only shows the overhead parts" took a screenshot,
        // a directory listing and a code read to diagnose — and all three were
        // answering a question this row could have answered on its own
        // (feedback_instruments_must_not_lie). A classification bug is invisible
        // in aggregate counts and obvious in a per-item list.
        itemBands: itemBands.sort((a, b) => (a.band < b.band ? -1 : a.band > b.band ? 1 : 0)),
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
