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
 * MAX-composite one item's content grid into a scene grid through its
 * placement. Iterates only the grid texels under the item's rotated-corner
 * AABB; each texel center is inverse-transformed and nearest-sampled.
 *
 * @param {MaskGrid} grid
 * @param {ContentGrid} content
 * @param {Parameters<typeof worldToItemUv>[0]} placement
 * @param {number} [valueScale=1] - multiplier applied to each sampled byte
 *   before the MAX. 1 = plain coverage (the `coverAbove` case). For the caster
 *   height field this carries the caster's HEIGHT: a fully-opaque texel writes
 *   the full height, and a half-covered silhouette texel writes half — which is
 *   not a rounding artefact but the soft edge a real penumbra wants.
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
      const cx = Math.min(content.w - 1, Math.floor(u * content.w));
      const cy = Math.min(content.h - 1, Math.floor(v * content.h));
      const raw = content.data[cy * content.w + cx];
      const value = scale === 1 ? raw : Math.min(255, Math.round(raw * scale));
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
 * @property {number} [bottomElevation] - the floor's `elevation.bottom` — the
 *   GROUND a caster's height is measured from. Non-finite = "unknown", which
 *   makes the OVERHEAD band empty (there is no floor to be raised above) and is
 *   reported rather than guessed at zero.
 * @property {{placement: Parameters<typeof worldToItemUv>[0], content: ContentGrid}|null} outdoors -
 *   the floor's authored outdoors content, or null to serve the catalog default.
 * @property {Record<string, {placement: Parameters<typeof worldToItemUv>[0],
 *   content: ContentGrid, absentValue: number}|null>} [authored] - every OTHER
 *   `rasterize: true` kind (mask-catalog.js), keyed by kind id. `outdoors`
 *   keeps its own dedicated field because two DERIVED products are built on
 *   top of it here (`skyReach`, the caster building channel) and those reads
 *   should not go through a string lookup that could silently miss.
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
 * @property {{building: MaskGrid, overhead: MaskGrid, skyReach: MaskGrid}} casterChannels -
 *   the same field, unmerged. Three producers of ONE physical quantity, kept
 *   separable for exactly two reasons: the author's isolation toggles, and the
 *   pixel probe being able to answer "which of the three is missing" instead of
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
 * Rasterize ONE authored mask through its own placement onto the scene grid,
 * filling every texel the art does not reach with the kind's absent value.
 *
 * Extracted 2026-07-25 from the outdoors block below, unchanged, when `water`
 * became the second kind to need exactly this (`MaskKind.rasterize`). The
 * `covered` pass is the load-bearing half and the reason a plain
 * `compositeItemMax` will not do: `compositeItemMax` MAXes, so a texel outside
 * the art keeps its initial 0 — indistinguishable from art that painted black.
 * Compositing a uniform-1 grid through the SAME placement records reach
 * separately, so "outside the mask" can serve `absentValue` while "painted
 * black" serves 0. Getting that backwards is how a missing mask reads as a
 * confident measurement.
 *
 * @param {MaskGridSpec} gridSpec
 * @param {{placement: Parameters<typeof worldToItemUv>[0], content: ContentGrid}|null} authored
 * @param {number} absentValue - 0..1, the catalog's own.
 * @returns {MaskGrid}
 */
export function rasterizeAuthored(gridSpec, authored, absentValue) {
  const grid = createMaskGrid(gridSpec);
  const absentByte = Math.round(Math.max(0, Math.min(1, absentValue)) * 255);
  if (!authored?.content || !authored?.placement) {
    grid.data.fill(absentByte);
    return grid;
  }
  const painted = createMaskGrid(gridSpec);
  compositeItemMax(painted, authored.content, authored.placement);
  const covered = createMaskGrid(gridSpec);
  compositeItemMax(covered, makeUniformContent(1, 255), authored.placement);
  for (let i = 0; i < grid.data.length; i++) {
    grid.data[i] = covered.data[i] > 0 ? painted.data[i] : absentByte;
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

    const bottomElevation = Number.isFinite(floor.bottomElevation) ? floor.bottomElevation : null;
    const casterBuilding = createMaskGrid(gridSpec);
    const casterOverhead = createMaskGrid(gridSpec);
    const casterSkyReach = createMaskGrid(gridSpec);

    /** An item's height above THIS floor's ground, in world px (0 if unknown). */
    const heightPxOf = (item) =>
      bottomElevation === null ? 0 : Math.max(0, (item.elevation - bottomElevation) * distancePixels);

    for (const item of items) {
      const isAbove = item.elevation >= floor.ceilingElevation;
      // The overhead band needs a known ground to be measured from; without one
      // there is no such thing as "raised above this floor" and the completeness
      // record says so (bottomElevation: null) rather than treating 0 as ground.
      const isOverhead =
        bottomElevation !== null && item.elevation > bottomElevation && item.elevation < floor.ceilingElevation;
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
          compositeItemMax(casterSkyReach, item.alpha, item.placement, heightPxOf(item) / heightScalePx);
        }
      } else if (wantOverhead) {
        overheadIds.push(item.id);
        compositeItemMax(casterOverhead, item.alpha, item.placement, heightPxOf(item) / heightScalePx);
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
      authored[kindId] = rasterizeAuthored(gridSpec, input?.content ? input : null, input?.absentValue ?? 0);
    }
    const authoredSources = Object.fromEntries(
      Object.entries(floor.authored ?? {}).map(([id, input]) => [id, input?.content ? 'authored' : 'default'])
    );

    // THE BUILDING CHANNEL — the dark of `_Outdoors` IS the building footprint.
    // No item, no alpha, no elevation: the author already painted where the
    // walls are, and that painting is a REQUIRED mask, so this producer can
    // never be starved the way the art-opacity ones can.
    if (wantBuilding && casterHeights.buildingHeightPx > 0) {
      const buildingByte = Math.min(255, Math.round((casterHeights.buildingHeightPx / heightScalePx) * 255));
      for (let i = 0; i < casterBuilding.data.length; i++) {
        // (255 − outdoors) = indoor-ness. A doorway painted mid-grey therefore
        // casts a HALF-height shadow, which reads as a soft threshold rather
        // than a wall appearing out of nowhere — the same interpolation the sky
        // light already relies on at a door.
        casterBuilding.data[i] = Math.round((buildingByte * (255 - outdoors.data[i])) / 255);
      }
    }

    // OVERHEAD gated to EXTERIOR protrusions (author, 2026-07-24: *"Overhead
    // shadows from inside of a building are ending up projected outside the
    // building."*). An overhead tile sitting over INDOOR ground is interior
    // architecture under a roof — the sun never reaches it, so it must not
    // cast a sun-shadow at all (and certainly not one that leaks out past the
    // wall onto the courtyard, which is what a receiver-gated-only shadow did).
    // Only overhead whose OWN footprint is over OUTDOOR ground survives — an
    // exterior balcony/awning protruding over the open air, which is exactly
    // the "protruding exterior element" the original brief wanted. Multiplying
    // by the outdoors value keeps the soft threshold at a wall's edge rather
    // than a hard cut.
    for (let i = 0; i < casterOverhead.data.length; i++) {
      casterOverhead.data[i] = Math.round((casterOverhead.data[i] * outdoors.data[i]) / 255);
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
      casterChannels: { building: casterBuilding, overhead: casterOverhead, skyReach: casterSkyReach },
      completeness: {
        expectedItemIds: expected,
        missingItemIds: missing,
        hiddenExcludedIds: hiddenExcluded,
        outdoorsSource: floor.outdoors ? 'authored' : 'default',
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
