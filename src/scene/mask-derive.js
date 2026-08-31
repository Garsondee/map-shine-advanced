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
 * WATER'S OWN, INDEPENDENT grid resolution (2026-08-17) — see
 * `deriveFloorProducts`'s `authoredGridSpecs` param for the mechanism, and
 * `effects/water/water-body-subsystem.js`'s header for the consumer.
 *
 * `MASK_GRID_MAX_DIM` (512) is a POINT-sample grid: `compositeItemOverwrite`
 * takes exactly one bilinear sample at each output texel's centre, no area
 * coverage. `fire-spawn-points.js` already names the consequence for a small
 * painted feature on a large map ("a real 42-55px hearth is two or three
 * texels"); water's shore-foam machinery hit the SAME wall from the geometry
 * side — a single rock painted as a hole in the `_Water` mask can be smaller
 * than the ~21px/texel spacing a 10,650px-wide map gets at 512, so the point
 * sample simply never lands on it and the shore-distance field it feeds never
 * learns the rock exists (`water-body.js`'s JFA is exact GIVEN a seed; it
 * cannot seed a hole no texel ever sampled). The SAME coarseness also
 * quantises every OTHER shore's tangent/distance to ~21px steps, which is
 * what a foam band driven by it reads as "blocky, predictable, no grain" even
 * where it does show up — one root cause for two symptoms.
 *
 * 2048 is not a new budget — it is the Keyhole allocator's own existing hard
 * cap (`water-body-subsystem.js §3`'s own citation), just spent on the MASK
 * water derives from instead of leaving that stuck at the shared 512 while
 * fire/sky-reach/outdoors/specular keep their own resolution unaffected
 * (`deriveFloorProducts`'s `casterGridSpec` already proves this exact
 * per-consumer-resolution shape for the sun-shadow caster channels — this is
 * the same pattern, generalised to any authored kind, applied to `water`).
 * At this map's aspect that is ~2048×952, ~5.2 world-px/texel — a rock this
 * small a point-sample could still theoretically straddle, but the odds drop
 * from "usually misses" to "would need to be smaller than a d20".
 */
export const WATER_GRID_MAX_DIM = 2048;

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
 * ⚠️ WHEN ONE DESTINATION TEXEL COVERS THIS MANY SOURCE TEXELS OR MORE (per
 * axis, measured as a HALF-extent, so 0.75 means a footprint 1.5 source
 * texels wide), an `areaAverage` source stops being point-sampled by
 * {@link compositeItemOverwrite} and is area-averaged instead. See that
 * function's MINIFICATION section for why, and for why clearing this bar is
 * necessary but not on its own sufficient.
 *
 * 0.75 is the smallest threshold that is safe rather than a tuning choice: a
 * half-extent of exactly 0.75 spans 1.5 source texels, which ALWAYS contains
 * at least one source texel centre at every sub-texel phase, so the box can
 * never come back empty and need a fallback. Below it the box would be
 * narrower than one texel — i.e. NEAREST sampling, strictly worse than the
 * bilinear tap it would replace — so a source that is merely level with, or
 * finer than, the destination keeps the existing path even having opted in.
 * The painter's own layer clears it by a wide margin and is meant to: 4096
 * against `MASK_GRID_MAX_DIM`'s 512 is a half-extent of 4.0, and against
 * `WATER_GRID_MAX_DIM`'s 2048 it is exactly 1.0.
 */
export const BOX_FILTER_MIN_HALF_TEXELS = 0.75;

/**
 * AREA-AVERAGE (box filter) a content grid — and its PREMULTIPLIED value —
 * over the source-texel footprint that ONE destination texel covers.
 *
 * ⚠️ PREMULTIPLIED, AND THAT IS THE WHOLE POINT. The area-average of a
 * source-over composite is NOT `dst×(1−mean(a)) + mean(c)×mean(a)`; it is
 *
 *     (1/N)·Σ [dst×(1−aₖ) + cₖ×aₖ]  =  dst×(1−ā) + (1/N)·Σ cₖaₖ
 *
 * — the mean of the PRODUCT, never the product of the means. Filtering
 * non-premultiplied colour re-introduces exactly the multiply this whole
 * change exists to delete: a small opaque dab covering 9 of a footprint's 64
 * source texels has ā = 0.14 and mean(c) = 36, and the wrong form composites
 * it to 36 × 0.14 = 5 — back under fire's sensitivity floor, with the
 * aliasing merely traded for a crush. The right form composites it to 36.
 *
 * Returns the two numbers the caller needs and nothing else: `alphaMean`
 * (0..1) and `premultMean` (0..255, already `Σcₖaₖ/N/255`).
 *
 * `alpha === null` means "fully opaque", the same `?? null` rule
 * {@link compositeItemOverwrite} applies everywhere else — which reduces
 * this to a plain box average of `content`.
 *
 * @param {ContentGrid} content
 * @param {ContentGrid|null} alpha - MUST share `content`'s dimensions (the
 *   caller checks; both painted self-alpha and a file's decoded alpha do by
 *   construction).
 * @param {number} u - 0..1 across the content, the destination texel's CENTRE.
 * @param {number} v - 0..1 down the content, likewise.
 * @param {number} hx - footprint half-extent in SOURCE TEXELS, X.
 * @param {number} hy - the same, Y.
 * @returns {{alphaMean: number, premultMean: number}}
 */
export function sampleContentBoxPremultiplied(content, alpha, u, v, hx, hy) {
  const { w, h, data } = content;
  const ad = alpha ? alpha.data : null;
  // Source texel CENTRES sit at integers in this space — the same half-texel
  // convention `sampleContentBilinear` uses, so "which texels does this
  // footprint contain" is just "which integers are in [c−h, c+h)".
  const cx = u * w - 0.5;
  const cy = v * h - 0.5;
  // HALF-OPEN, `[c − h, c + h)`, and that detail is load-bearing: the closed
  // interval takes 2h+1 texels whenever the footprint happens to align on a
  // texel centre and 2h otherwise, so the divisor — and therefore the
  // composited value — would still wobble with sub-texel phase. That is a
  // smaller version of the very lottery this path exists to remove. Half-open
  // takes exactly `floor(2h)` texels at EVERY phase, which is also exactly
  // the footprint's own area in source texels.
  let x0 = Math.ceil(cx - hx);
  let x1 = Math.ceil(cx + hx) - 1;
  let y0 = Math.ceil(cy - hy);
  let y1 = Math.ceil(cy + hy) - 1;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > w - 1) x1 = w - 1;
  if (y1 > h - 1) y1 = h - 1;
  // Only reachable when the footprint's centre is outside the grid entirely,
  // which the caller's own in-footprint test already excludes — kept so this
  // helper is honest on its own rather than only inside its one call site.
  if (x0 > x1 || y0 > y1) return { alphaMean: 0, premultMean: 0 };
  let sumA = 0;
  let sumCA = 0;
  let n = 0;
  for (let sy = y0; sy <= y1; sy++) {
    const row = sy * w;
    for (let sx = x0; sx <= x1; sx++) {
      const i = row + sx;
      const a = ad ? ad[i] : 255;
      sumA += a;
      sumCA += data[i] * a;
      n++;
    }
  }
  return { alphaMean: sumA / n / 255, premultMean: sumCA / n / 255 };
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
 * ⚠️ TRANSPARENT MEANS UNPAINTED, NOT ZERO (2026-08-02, author's ruling, live:
 * *"Transparent means unpainted — composite by alpha. Transparent also means
 * not inside a building. For entirely underground scenes I still provide an
 * entirely black `_Outdoors` mask."*).
 *
 * This used to write a value for every texel inside the item's placement
 * RECTANGLE. A mask's transparent pixels have a colour channel of 0, and for
 * `_Outdoors` a 0 means INDOORS — so every unpainted corner of a mask file
 * became a solid, shadow-casting wall, and shadows appeared to be thrown by
 * the mask image's own empty edges. Blending by the mask's own alpha makes
 * "painted 0" and "not painted" two different facts again, which is the SAME
 * distinction `rasterizeAuthored`'s absent-value fill already draws one level
 * up (a texel no placement reaches). That the author still authors a fully
 * BLACK mask for an all-indoor scene is exactly why this had to be alpha and
 * not "treat 0 as absent": an opaque black pixel is a real, meant indoors.
 *
 * `alpha` is optional — omitted (or null) composites fully opaque, which is
 * byte-identical to the pre-2026-08-02 behaviour for any caller that has no
 * alpha to give.
 *
 * ⚠️ MINIFICATION TAKES A DIFFERENT PATH (2026-08-31), and the reason is that
 * everything above this line was designed for the opposite case. A single
 * 2×2 bilinear tap per destination texel is the CORRECT filter for
 * MAGNIFICATION — a ≤248-texel coarse mip stretched over a 512-texel scene
 * grid, which is what every mask FILE is and what `sampleContentBilinear`'s
 * own header describes. It is structurally wrong for MINIFICATION, and the
 * in-app painter is exactly that: `scene/paint-mask.js#PAINT_GRID_MAX_DIM` is
 * 4096 against `MASK_GRID_MAX_DIM`'s 512, so ONE destination texel covers 64
 * source texels and a single narrow tap throws 63 of them away.
 *
 * The symptom that is: a minimum-size brush dab (`stampBrushWorld`'s own
 * `MIN_STAMP_RADIUS_TEXELS`, ~1–4 painted texels) either lands under a
 * destination texel's centre and reads ~255, or misses it and reads 0 — a
 * COIN FLIP on sub-texel phase, decided by where in the map the author
 * happened to click and by nothing they can see or control. Measured on the
 * real 4096→512 geometry: real signal survived ~27% of phases. The painter's
 * own preview, which draws the source layer directly at source resolution,
 * showed the dab every single time.
 *
 * So when the source is meaningfully FINER than the destination
 * ({@link BOX_FILTER_MIN_HALF_TEXELS}), each destination texel area-averages
 * every source texel whose centre falls inside its own footprint
 * ({@link sampleContentBoxPremultiplied}) instead. Same dab, same geometry:
 * 100% of phases, composited to a stable ~36/255 — above fire's own 13/255
 * sensitivity floor at every phase rather than at one in four of them.
 *
 * ⚠️⚠️ AND IT IS OPT-IN, NOT GEOMETRY ALONE — `areaAverage` must be asked
 * for. The geometry test above is necessary but NOT sufficient, and finding
 * that out is the reason this parameter exists rather than the branch simply
 * firing wherever a source happens to minify. Measured while building this:
 * a 512²-native TILE with its own mask file, placed at ~512 world px on a
 * 10,650 px map, hands in a coarse-mip content grid finer than its own
 * footprint on the scene grid — it minifies by ~5×, clears the threshold, and
 * would have silently changed compositing behaviour for an existing,
 * author-tuned, file-based mask kind on every small masked Tile in every
 * scene. That is a blast radius this change has no live visual verification
 * for, and "it is the more correct filter" is not the same claim as "it is
 * safe to change under every live scene tonight".
 *
 * There is also a real difference between the two sources, not just a
 * difference in risk appetite: a FILE's content grid is its pack's coarsest
 * MIP, which the packer produced by successive area-averaging from native
 * resolution — it arrives already band-limited to roughly its own texel
 * count. The painter's grid is raw, full-resolution, never-filtered signal
 * (`scene/paint-mask.js` writes brush stamps straight into it), which is the
 * textbook setup for exactly the aliasing above. Opting one in and not the
 * other is a statement about which signal has already been filtered, and it
 * keeps every file-based mask byte-for-byte identical to before, provably,
 * rather than by argument.
 *
 * @param {MaskGrid} grid
 * @param {ContentGrid} content
 * @param {Parameters<typeof worldToItemUv>[0]} placement
 * @param {ContentGrid|null} [alpha] - the mask image's OWN alpha, same
 *   geometry as `content` (both come from one `extractContentWindow` pass).
 * @param {object} [options]
 * @param {boolean} [options.areaAverage=false] - opt IN to the minifying box
 *   filter described above. `scene/mask-authority.js#ingestPaintedMask` is
 *   the one producer that sets it (carried on the source and forwarded by
 *   {@link rasterizeAuthored}); every file-based source leaves it false and
 *   takes the untouched bilinear path at any resolution ratio.
 */
export function compositeItemOverwrite(grid, content, placement, alpha = null, { areaAverage = false } = {}) {
  const { spec, data } = grid;
  // ── MAGNIFY OR MINIFY? ───────────────────────────────────────────────────
  // How much of the SOURCE does one DESTINATION texel cover, in source
  // texels? `worldToItemUv` is linear (a rotation and two scales), so a
  // destination texel's UV footprint is that same rotated rectangle and its
  // AABB half-extents fall straight out of the transform's own cos/sin — no
  // per-texel work, computed once for the whole composite. Rotation is
  // handled by over-covering slightly (an axis-aligned box around a rotated
  // footprint), which costs a touch of extra blur on a rotated minifying
  // source and never a missed texel; a painted layer, the only minifying
  // source that exists today, is always axis-aligned.
  let hx = 0;
  let hy = 0;
  if (areaAverage) {
    const rot = ((placement.rotation ?? 0) * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(rot));
    const absSin = Math.abs(Math.sin(rot));
    hx = ((absCos * spec.texelW + absSin * spec.texelH) / (2 * Math.abs(placement.width))) * content.w;
    hy = ((absSin * spec.texelW + absCos * spec.texelH) / (2 * Math.abs(placement.height))) * content.h;
  }
  const useBox =
    hx >= BOX_FILTER_MIN_HALF_TEXELS &&
    hy >= BOX_FILTER_MIN_HALF_TEXELS &&
    Number.isFinite(hx) &&
    Number.isFinite(hy) &&
    // Premultiplying the two together index-for-index needs them to BE the
    // same geometry. Every real caller's already is (one `extractContentWindow`
    // pass for a file, one derived LUT array for paint); a hypothetical
    // mismatch falls back to the bilinear path rather than reading garbage.
    (!alpha || (alpha.w === content.w && alpha.h === content.h));
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
      // REACH IS DECIDED BY THE TEXEL CENTRE ON BOTH PATHS, deliberately: it
      // is the same "which texels does this source own" question
      // `rasterizeAuthored` builds its absent-vs-painted distinction on, and
      // widening it under the box filter would silently change every
      // source's footprint by half a texel.
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const i = gy * spec.w + gx;
      if (useBox) {
        const { alphaMean, premultMean } = sampleContentBoxPremultiplied(content, alpha, u, v, hx, hy);
        data[i] = Math.min(255, Math.round(data[i] * (1 - alphaMean) + premultMean));
        continue;
      }
      const raw = sampleContentBilinear(content, u, v);
      if (!alpha) {
        data[i] = Math.min(255, Math.round(raw));
        continue;
      }
      // SOURCE-OVER by the mask's own alpha: a=1 overwrites (the old
      // behaviour), a=0 leaves whatever was already there (the absent-value
      // fill, or an earlier source in draw order), and the antialiased edge
      // in between blends — so a mask's own soft edge stays soft instead of
      // snapping to "painted 0".
      const a = Math.max(0, Math.min(1, sampleContentBilinear(alpha, u, v) / 255));
      data[i] = Math.min(255, Math.round(data[i] * (1 - a) + raw * a));
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
 * THE OVERHEAD/EXTERIOR GATE'S OWN THRESHOLD (2026-07-30, author live — a
 * thin, wall-mounted overhead protrusion cast an asymmetrically faded shadow:
 * strong at one end, "weak, blurred" at the other, in the RAW caster data
 * itself, before any march ever ran).
 *
 * "Is this overhead texel over indoor or outdoor ground" is a BINARY
 * question — a protrusion is either exterior (casts) or interior (must not
 * leak a shadow outside the building, `deriveFloorProducts`'s own header). It
 * was being answered with a CONTINUOUS multiply against the raw `_Outdoors`
 * grid instead: `coverOverhead × outdoors ÷ 255`. That grid is the SAME
 * coarse, box-blurred read the receiver gate needed its own sharpening for
 * (`sun-occlusion.js#GATE_SHARPEN_LOW/HIGH`) — and a wall-mounted protrusion's
 * OWN attachment point is exactly where that blur is worst, since it sits
 * squarely on the indoor/outdoor boundary the mask draws. One end of the
 * item reads confidently outdoor (multiplier ≈1, full coverage), the
 * attachment end reads the blurred middle (multiplier partial), and — because
 * a gated value under `HEIGHT_COVERAGE_THRESHOLD` also zeroes the HEIGHT, not
 * just the coverage (line below) — that end can lose its height entirely.
 * The result is not a soft gradient the item's own art would produce; it is
 * an artefact of the classifying MASK's blur, baked permanently into the
 * caster field before the shadow's own (correct) linear-filter softening ever
 * gets a chance to run.
 *
 * The fix: decide the classification BINARILY, at the mask's own natural
 * midpoint, before it ever multiplies anything. A texel is over exterior
 * ground or it is not; there is no third state to preserve a fraction of. Any
 * blur the `_Outdoors` mask carries is still exactly as soft as before by
 * the time the shadow reaches the SCREEN — the caster texture is linear-
 * filtered and the march's own contact-hardening already supplies that
 * softening — this just stops applying it TWICE, asymmetrically, baked in
 * ahead of time as an accident of which side of a coarse-grid transition a
 * thin item's own footprint happens to straddle.
 */
export const OVERHEAD_EXTERIOR_THRESHOLD = 128;

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
 *   coverBuilding: MaskGrid, coverOverhead: MaskGrid, coverSkyReach: MaskGrid,
 *   outdoors: MaskGrid, coverAbove: MaskGrid}} casterChannels -
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
 *   ⚠️ `outdoors`/`coverAbove` (2026-08-02) are CASTER-RESOLUTION TWINS of the
 *   top-level `outdoors`/`coverAbove` properties of THIS SAME product (below) —
 *   NOT the same object, aliased to it only when no caster-specific resolution
 *   was requested. The top-level pair stays pinned at the SHARED `gridSpec`
 *   resolution every other effect (water/wind) also budgets against; these
 *   scale with `casterGridSpec` exactly like `coverOverhead`/`coverSkyReach`
 *   already did. Before this pair existed, the layer-smear model's walls (R)
 *   and floor-above (B) channels — read from the top-level pair — were pinned
 *   to the shared, low-res grid at every performance tier, which is what made
 *   a real scene's walls and sky-reach layer visibly pixelated regardless of
 *   how high the tier ladder's own `layerGridDim` went.
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
 * @param {Array<{placement: Parameters<typeof worldToItemUv>[0], content: ContentGrid,
 *   alpha?: ContentGrid|null, areaAverage?: boolean}>} sources - already
 *   filtered to real content+placement, already sorted ascending by draw
 *   order. `alpha` is the mask file's own opacity; see
 *   {@link compositeItemOverwrite} for why a transparent texel must not be
 *   written as a painted 0, and for what `areaAverage` opts a source into.
 * @param {number} absentValue - 0..1, the catalog's own.
 * @returns {MaskGrid}
 */
/**
 * ONE LINE PER SOURCE THAT FED A GRID — what `rasterizeAuthored` was actually
 * handed, in draw order, before it composited anything.
 *
 * ⚠️ WHY THIS EXISTS (2026-08-02). The author's live `outdoors` grid read
 * meanByte 75.4 / nearBlack 67.2% while the same map's `_Outdoors` files, run
 * through the REAL production path (real packer, real page table, real content
 * window, real extraction) measured 220.6 / 9.9% — and every other floor's
 * measured light too, so no overwrite composite of them could reach 67% black.
 * Three separate theories died against that gap, each one a plausible reading
 * of a grid-level aggregate. A grid mean cannot say WHICH source darkened it;
 * this can, and it costs one pass over content grids that are ~166×77.
 *
 * `contentMeanByte ≈ 0` with a healthy `alphaMeanByte` is the specific
 * signature that started this: the composite reduces to `absent × (1 − a)`, so
 * the grid's mean lands at exactly `255 × transparentFraction` no matter what
 * the author painted.
 *
 * @param {Array<{placement?: object, content?: ContentGrid, alpha?: ContentGrid|null}>} sources
 * @param {(source: object) => string} [labelOf] - names the owner, if known.
 * @returns {Array<object>}
 */
/**
 * THE SAME LEDGER, AT ONE WORLD POINT — every source that reaches (worldX,
 * worldY), what it contributed there, and the running composite after it.
 *
 * `describeAuthoredSources` (below) reports each source's WHOLE-GRID means,
 * which answers "which source is wrong" but not "what happened at the pixel I
 * am looking at". Author, 2026-08-02, after three rounds of cross-floor
 * shadow diagnosis: *"you should make it give the exact colour values for
 * every point, for every floor and for every mask... Be sure to account for
 * partially transparent layers and their alphas."* This is that, for one
 * kind on one floor; `mask-authority.js#probeStackAt` fans it across every
 * floor and every kind.
 *
 * The `after` column is the load-bearing one: it replays
 * `compositeItemOverwrite`'s own source-over arithmetic step by step, so a
 * source that LOOKS harmless (a low `rawByte`) but lands with alpha 255 over
 * everything is visible as the moment the running value jumps.
 *
 * @param {Array<{placement?: object, content?: ContentGrid, alpha?: ContentGrid|null, ownerId?: string}>} sources
 * @param {number} absentValue - 0..1, the kind's own (the starting value).
 * @param {number} worldX @param {number} worldY
 * @returns {{value: number, rows: Array<object>}} `value` is the final
 *   composited byte at this point — the same number `sampleMaskGridWorld`
 *   would return from the rasterized grid, reached the long way so each
 *   step is inspectable.
 */
export function sampleAuthoredSourcesAt(sources, absentValue, worldX, worldY) {
  const absentByte = Math.round(Math.max(0, Math.min(1, absentValue)) * 255);
  let running = absentByte;
  const rows = [];
  for (const [order, source] of (sources ?? []).entries()) {
    if (!source?.content || !source?.placement) continue;
    const { u, v } = worldToItemUv(source.placement, worldX, worldY);
    const inFootprint = u >= 0 && u < 1 && v >= 0 && v < 1;
    const before = running;
    let rawByte = null;
    let alphaByte = null;
    if (inFootprint) {
      rawByte = Math.round(sampleContentBilinear(source.content, u, v));
      // A source with no alpha grid composites fully opaque — the same
      // `?? null` → "treat as 255" rule `compositeItemOverwrite` applies.
      alphaByte = source.alpha ? Math.round(sampleContentBilinear(source.alpha, u, v)) : 255;
      const a = Math.max(0, Math.min(1, alphaByte / 255));
      running = Math.min(255, Math.round(before * (1 - a) + rawByte * a));
    }
    rows.push({
      order,
      owner: source.ownerId ?? null,
      inFootprint,
      // u/v rounded: enough to see WHERE in the source this landed (a
      // near-0 or near-1 reading is the tell for an off-by-one placement)
      // without pretending to more precision than a bilinear read has.
      u: inFootprint ? +u.toFixed(4) : null,
      v: inFootprint ? +v.toFixed(4) : null,
      rawByte,
      alphaByte,
      before,
      after: running,
      changed: running !== before,
    });
  }
  return { value: running, rows };
}

export function describeAuthoredSources(sources, labelOf) {
  const meanOf = (g) => {
    if (!g?.data?.length) return null;
    let s = 0;
    for (let i = 0; i < g.data.length; i++) s += g.data[i];
    return +(s / g.data.length).toFixed(1);
  };
  return (sources ?? []).map((source, i) => {
    const p = source?.placement ?? null;
    return {
      order: i,
      owner: labelOf?.(source) ?? source?.ownerId ?? null,
      content: source?.content ? `${source.content.w}x${source.content.h}` : 'MISSING',
      contentMeanByte: meanOf(source?.content),
      hasAlpha: !!source?.alpha,
      alphaMeanByte: meanOf(source?.alpha),
      // The rectangle it claims on the map. A source that covers the whole
      // canvas overwrites every earlier one; a mis-placed one writes the wrong
      // half of the map and reads as "the mask is wrong".
      placement: p
        ? {
            x: Math.round(p.x ?? 0),
            y: Math.round(p.y ?? 0),
            w: Math.round(p.width ?? 0),
            h: Math.round(p.height ?? 0),
          }
        : null,
    };
  });
}

export function rasterizeAuthored(gridSpec, sources, absentValue) {
  const grid = createMaskGrid(gridSpec);
  const absentByte = Math.round(Math.max(0, Math.min(1, absentValue)) * 255);
  grid.data.fill(absentByte);
  for (const source of sources ?? []) {
    if (!source?.content || !source?.placement) continue;
    // `source.alpha` is the mask file's OWN alpha, carried from
    // `mask-authority.js#ingestDecodedPage`. Absent (an older/synthetic
    // source) composites fully opaque — the pre-2026-08-02 behaviour.
    //
    // `source.areaAverage` is the PAINTED source's own opt-in to the
    // minifying box filter (2026-08-31) — see `compositeItemOverwrite`'s
    // MINIFICATION section. Absent/false on every file source, which is what
    // keeps them byte-for-byte on the untouched bilinear path.
    compositeItemOverwrite(grid, source.content, source.placement, source.alpha ?? null, {
      areaAverage: source.areaAverage === true,
    });
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
 * @param {MaskGridSpec} [args.casterGridSpec] - the resolution the CASTER
 *   channels alone (`casterBuilding`/`casterOverhead`/`casterSkyReach`,
 *   `coverBuilding`/`coverOverhead`/`coverSkyReach`, `casterHeight`) rasterize
 *   at, independent of `gridSpec` — omit to reuse `gridSpec` (today's
 *   behaviour, byte-for-byte). sun-occlusion.js's `casterGridDim` tier axis is
 *   why this exists: raising a SUN-SHADOW-ONLY grid's resolution here costs
 *   nothing for `coverAbove`/`skyReach`/`outdoors`/etc., which stay on
 *   `gridSpec` and share its (deliberately fixed) budget with every other
 *   consumer of `MASK_GRID_MAX_DIM` that does not ask for its own.
 * @param {Record<string, MaskGridSpec>} [args.authoredGridSpecs] - per-KIND
 *   resolution overrides for the generic `rasterize: true` loop (the one
 *   `water` today comes through) — `{water: computeMaskGridSpec(rect,
 *   WATER_GRID_MAX_DIM)}`, keyed by `mask-catalog.js` kind id, omitted keys
 *   fall back to `gridSpec` exactly as before. Same shape as `casterGridSpec`
 *   one level down — generalised because the caster channels are not the only
 *   authored kind a POINT-sampled 512px grid can silently lose a small
 *   painted feature from (`WATER_GRID_MAX_DIM`'s own doc has the incident).
 * @returns {DerivedFloorProducts[]}
 */
export function deriveFloorProducts({
  gridSpec,
  items,
  floors,
  outdoorsAbsentValue,
  casterHeights = null,
  casterGridSpec = null,
  authoredGridSpecs = {},
}) {
  const casterSpecActive = casterGridSpec ?? gridSpec;
  const products = [];
  const heightScalePx = casterHeights?.scalePx > 0 ? casterHeights.scalePx : 0;
  const distancePixels = Number.isFinite(casterHeights?.distancePixels) ? casterHeights.distancePixels : 0;
  const include = casterHeights?.include ?? {};
  const wantBuilding = heightScalePx > 0 && include.building !== false;
  const wantOverhead = heightScalePx > 0 && distancePixels > 0 && include.overhead !== false;
  const wantSkyReach = heightScalePx > 0 && distancePixels > 0 && include.skyReach !== false;

  for (const floor of floors) {
    const cover = createMaskGrid(gridSpec);
    // ⚠️ A CASTER-RESOLUTION TWIN OF `cover`, aliased (not duplicated) when no
    // caster-specific resolution was requested — same "off costs nothing"
    // discipline `wantBuilding`/`wantOverhead` already follow. See
    // `DerivedFloorProducts.casterChannels`'s own doc for why this exists:
    // `cover` (and `outdoors`, below) stayed pinned to the SHARED `gridSpec`
    // resolution while `coverOverhead`/`coverSkyReach` already scaled with
    // `casterGridSpec` — found 2026-08-02, author live: a real scene's walls
    // and sky-reach layer were visibly pixelated at every performance tier,
    // because the two most visually dominant channels were silently capped at
    // the shared, low-res budget every OTHER effect (water/wind) also shares,
    // while the tier ladder's own `layerGridDim` (2048 at Extreme) only ever
    // reached the overhead channel.
    const coverCaster = casterGridSpec ? createMaskGrid(casterSpecActive) : cover;
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
    const casterBuilding = createMaskGrid(casterSpecActive);
    const casterOverhead = createMaskGrid(casterSpecActive);
    const casterSkyReach = createMaskGrid(casterSpecActive);
    const coverOverhead = createMaskGrid(casterSpecActive);
    const coverSkyReach = createMaskGrid(casterSpecActive);
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
        if (coverCaster !== cover) compositeItemMax(coverCaster, item.alpha, item.placement);
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
    // The same caster-resolution-twin discipline as `coverCaster`, above —
    // `sky` (skyReach) does not need one: it is derived FROM `outdoors`+`cover`
    // right below at whichever resolution THEY were built at, and nothing
    // downstream reads it at caster resolution the way the layer-smear pack
    // reads `outdoors` and `coverAbove` directly.
    const outdoorsCaster = casterGridSpec
      ? rasterizeAuthored(casterSpecActive, floor.outdoors, outdoorsAbsentValue)
      : outdoors;
    for (let i = 0; i < sky.data.length; i++) {
      sky.data[i] = Math.round((outdoors.data[i] * (255 - cover.data[i])) / 255);
    }

    // Every OTHER `rasterize: true` kind (mask-catalog.js) — `water` today.
    // Same rasterizer, no derivation on top: the consumer is a GPU bake, and
    // the authority's job ends at "here is the authored value on the grid".
    // `authoredGridSpecs[kindId]` (present for `water` — see
    // `WATER_GRID_MAX_DIM`'s own doc) rasterizes THAT kind at its own,
    // independent resolution; every kind absent from the map keeps today's
    // byte-for-byte behaviour on the shared `gridSpec`.
    const authored = {};
    for (const [kindId, input] of Object.entries(floor.authored ?? {})) {
      const kindGridSpec = authoredGridSpecs[kindId] ?? gridSpec;
      authored[kindId] = rasterizeAuthored(kindGridSpec, input?.sources, input?.absentValue ?? 0);
    }
    const authoredSources = Object.fromEntries(
      Object.entries(floor.authored ?? {}).map(([id, input]) => [
        id,
        input?.sources?.length > 0 ? 'authored' : 'default',
      ])
    );
    // ⚠️ THE COUNT, NOT JUST THE authored/default VERDICT (2026-08-13
    // diagnostic pass — a floor-specific fire-registration mystery that
    // `authoredSources` alone couldn't distinguish). `rasterizeAuthored`
    // composites its sources by OVERWRITE, in draw order, a LATER source
    // replacing an EARLIER one within their shared footprint
    // (`compositeItemOverwrite`'s own doc) — so "authored" only ever says "at
    // least one source contributed something", never "and nothing drawn after
    // it blanked the result back out". Two floors with byte-identical painted
    // content can legitimately have a DIFFERENT number of items hosting the
    // same kind (`scene/layer-order.js#maskHostFloorIndices` is per-item, per-
    // floor), and if one of them is a second, unpainted host drawn after the
    // real one, this is the field that would show it — `authoredSources`
    // alone reads identically ("authored") on both floors either way.
    const authoredSourceCounts = Object.fromEntries(
      Object.entries(floor.authored ?? {}).map(([id, input]) => [id, input?.sources?.length ?? 0])
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
    const coverBuilding = createMaskGrid(casterSpecActive);
    if (wantBuilding && casterHeights.buildingHeightPx > 0) {
      const buildingByte = Math.min(255, Math.round((casterHeights.buildingHeightPx / heightScalePx) * 255));
      if (buildingByte > maxCasterByte) maxCasterByte = buildingByte;
      // ⚠️ WORLD-SAMPLED, NOT INDEX-ALIGNED (2026-07-30, casterGridDim). `outdoors`
      // always rasterizes at the SHARED `gridSpec` — it serves water/wind/etc.
      // too, and its own resolution is not this effect's to raise. Once
      // `casterSpecActive` differs from `gridSpec` (a tier with its own,
      // higher-res `casterGridDim`), `coverBuilding.data[i]` and `outdoors.data[i]`
      // are DIFFERENT-SIZED grids — the same array index means a different world
      // texel in each. `sampleMaskGridWorld` looks `outdoors` up by WORLD
      // POSITION instead, which is correct at any relative resolution and a
      // no-op in cost terms when the two happen to match (today's tiers 0-1).
      for (let gy = 0; gy < casterSpecActive.h; gy++) {
        const wy = casterSpecActive.y + (gy + 0.5) * casterSpecActive.texelH;
        for (let gx = 0; gx < casterSpecActive.w; gx++) {
          const wx = casterSpecActive.x + (gx + 0.5) * casterSpecActive.texelW;
          const i = gy * casterSpecActive.w + gx;
          const outdoorsByte = sampleMaskGridWorld(outdoors, wx, wy) ?? 255;
          const indoorness = 255 - outdoorsByte;
          coverBuilding.data[i] = indoorness;
          casterBuilding.data[i] = indoorness >= HEIGHT_COVERAGE_THRESHOLD ? buildingByte : 0;
        }
      }
    }

    // OVERHEAD gated to EXTERIOR protrusions (author, 2026-07-24: *"Overhead
    // shadows from inside of a building are ending up projected outside the
    // building."*). An overhead tile sitting over INDOOR ground is interior
    // architecture under a roof — the sun never reaches it, so it must not
    // cast a sun-shadow at all (and certainly not one that leaks out past the
    // wall onto the courtyard, which is what a receiver-gated-only shadow did).
    //
    // ⚠️ BINARY, NOT A CONTINUOUS MULTIPLY (2026-07-30 — see
    // `OVERHEAD_EXTERIOR_THRESHOLD`'s own header for the asymmetric-fade bug
    // this replaces). A wall-mounted protrusion's own attachment point sits
    // exactly on the `_Outdoors` mask's blurriest boundary, and multiplying
    // by that raw, partial value baked a fake, asymmetric taper into the
    // caster field itself — permanently, before the shadow's own (correct)
    // softening ever ran. Classifying exterior/interior at the mask's own
    // midpoint, once, avoids manufacturing a gradient the source art never
    // had.
    //
    // Applied to the COVERAGE, with the height zeroed wherever the gate
    // fails — never to the height directly, which would re-create the
    // alpha×height coupling this rethink exists to remove.
    //
    // ⚠️ WORLD-SAMPLED against `outdoors`, same reason as THE BUILDING CHANNEL
    // just above: `coverOverhead` may now be a different resolution than the
    // shared `outdoors` grid it is gated against (casterGridDim).
    for (let gy = 0; gy < casterSpecActive.h; gy++) {
      const wy = casterSpecActive.y + (gy + 0.5) * casterSpecActive.texelH;
      for (let gx = 0; gx < casterSpecActive.w; gx++) {
        const wx = casterSpecActive.x + (gx + 0.5) * casterSpecActive.texelW;
        const i = gy * casterSpecActive.w + gx;
        const outdoorsByte = sampleMaskGridWorld(outdoors, wx, wy) ?? 255;
        const isExterior = outdoorsByte >= OVERHEAD_EXTERIOR_THRESHOLD;
        const gated = isExterior ? coverOverhead.data[i] : 0;
        coverOverhead.data[i] = gated;
        if (gated < HEIGHT_COVERAGE_THRESHOLD) casterOverhead.data[i] = 0;
      }
    }

    // MAX, not sum: three producers describing ONE physical quantity (how tall
    // the occluder is). A chimney on a roof over a building is not three
    // shadows stacked, it is the tallest of the three. This is the same
    // reasoning `combineVisibility` uses for min-combining visibility, one
    // level down.
    const casterHeight = createMaskGrid(casterSpecActive);
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
        // CASTER-RESOLUTION TWINS of the shared-resolution `outdoors`/`coverAbove`
        // above (2026-08-02) — see `coverCaster`'s own comment, up in the item
        // loop, for the full story. `layer-smear`'s R (walls) and B (floor-
        // above) channels read THESE, not the shared-resolution products.
        outdoors: outdoorsCaster,
        coverAbove: coverCaster,
      },
      // ⚠️ WHAT ACTUALLY FED `outdoors`, per source. `outdoorsSource` below says
      // only "authored vs default"; when a floor's grid comes out wrong this
      // says WHICH of its sources did it. See `describeAuthoredSources`.
      outdoorsLedger: describeAuthoredSources(floor.outdoors),
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
        authoredSourceCounts,
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
 * How many texels in a grid clear a given byte threshold (0..255) — the exact
 * question a sparse-content extractor (e.g. `effects/fire/fire-mask.js`'s
 * `PAINT_THRESHOLD`) actually asks, which `maskGridMean` cannot answer for a
 * small/sparse region: a handful of bright texels against a 262,144-texel
 * grid rounds to "0%" whether they are genuinely absent or genuinely present,
 * so the mean alone cannot distinguish "nothing here" from "a small real
 * thing here" (`feedback_instruments_must_not_lie`).
 * @param {{data: Uint8Array|number[]}} grid @param {number} byteThreshold
 * @returns {number}
 */
export function maskGridCountAbove(grid, byteThreshold) {
  let count = 0;
  for (let i = 0; i < grid.data.length; i++) if (grid.data[i] >= byteThreshold) count++;
  return count;
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
