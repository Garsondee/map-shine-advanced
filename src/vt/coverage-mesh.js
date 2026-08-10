/**
 * COVERAGE MESHING — stop rasterizing canvas, start rasterizing art.
 *
 * ============================================================================
 * THE MEASUREMENT THAT FORCED THIS (2026-08-09, the author's own mansion map)
 * ============================================================================
 * Every layer of a real authored map is a full-canvas image, and on a large map
 * that canvas is enormous — 12000×12000 for all eleven layers of the mansion.
 * But the ART on most of those layers occupies a tiny fraction of it. Decoded
 * and measured through a real browser (never inferred from file size —
 * `feedback_asset_content_inferred_from_downstream_arithmetic`):
 *
 *   layer                  painted   art bbox   rasterized before this
 *   Ground                   100 %      100 %                    100 %
 *   Ground_Roof              3.7 %      9.9 %                    100 %
 *   Ground_Overhead          1.1 %     43.3 %                    100 %
 *   First-Floor_Overhead     1.0 %     33.6 %                    100 %
 *   First-Floor             33.3 %     43.3 %                    100 %
 *   Ground_Tree             11.9 %      100 %                    100 %
 *   Ground_Bush              7.2 %      100 %                    100 %
 *
 * A roof covering 3.7% of its canvas was rasterizing the ENTIRE screen, every
 * frame, in BOTH the colour pass and the depth-authority pass. That is not a
 * shading cost that tuning a shader can reach — it is fill spent on texels that
 * are transparent by construction.
 *
 * Note the last two rows especially: `_Tree`/`_Bush` have a bbox covering the
 * WHOLE canvas (scattered vegetation reaches every corner) while painting under
 * 12% of it. A bounding-box crop — the obvious first idea — would save them
 * NOTHING. That is why this works per-CELL rather than per-bbox.
 *
 * ============================================================================
 * THE MECHANISM: SAME VERTICES, FEWER INDICES
 * ============================================================================
 * The quad is already tessellated into an n×n cell grid for other reasons
 * (`buildTessellatedQuadGeometry`, built for vegetation's wind sway). This
 * module decides WHICH of those cells contain art and emits an index buffer
 * covering only those. The VERTEX buffer is untouched — identical positions,
 * identical UVs, identical bilinear interpolation across a rotated or mirrored
 * placement. Nothing moves; empty cells simply stop being drawn.
 *
 * That property is the whole reason to do it this way rather than by shrinking
 * the quad: a geometry that MOVES can distort art, mis-place a rotated tile, or
 * break the `uvScale` crop the block-compressed path depends on. A geometry
 * that only drops fully-transparent cells cannot change a single visible pixel.
 *
 * It also reaches both passes from one place, which no shader-side fix can:
 * `rebuildSceneDepthProxies` builds `buf:scene.depth`'s proxy meshes on the
 * item's OWN `t.geometry` (design doc §7, "proxy meshes sharing each item's
 * geometry"), so a cell dropped here stops rasterizing in `geometry.worldDraw`
 * AND in `geometry.depthDraw`, for free, with no second wiring to keep in sync.
 *
 * ============================================================================
 * WHY IT IS SAFE TO DROP A CELL
 * ============================================================================
 * Three deliberate conservatisms, because the failure mode of dropping a cell
 * that DID have art is invisible-missing-art, which is far worse than the cost
 * of keeping a few empty ones:
 *
 * 1. ANY texel over the threshold keeps the whole cell — never an average. A
 *    mean would erase a thin bright line crossing an otherwise-empty cell,
 *    which is exactly the "an aggregate cannot name its source" trap
 *    (`feedback_aggregate_cannot_name_the_source`).
 * 2. The threshold is LOW (4/255), not the item's own `alphaThreshold`. This
 *    answers "is there anything here at all", never "is this opaque enough to
 *    occlude" — a different question, asked one layer down by the depth
 *    writer's own alpha test, which still runs unchanged.
 * 3. The mask is DILATED by one cell in every direction, so a cell whose art
 *    is a faint edge falloff below the threshold is still kept whenever it
 *    touches real paint. Bilinear sampling reaches slightly outside a cell;
 *    the dilation covers that reach rather than assuming it away.
 *
 * And the whole thing fails OPEN: no grid, an unusable grid, or a mask that
 * would keep everything all return `null`, and the caller draws the full quad
 * exactly as it always did. A coverage mesh is an optimisation, never a
 * correctness dependency.
 */

/**
 * Cells per axis for an ordinary (non-vegetation) tile's coverage mesh.
 *
 * Measured against the real mansion assets (2026-08-09, after the first live
 * report confirmed the technique): going finer trades a FEW THOUSAND more
 * triangles — trivial next to the ~137k a frame already draws — for a large
 * further fill cut on exactly the layers that need it most:
 *
 *   layer                    32 cells    64 cells    128 cells
 *   Ground_Roof                11.5%        6.9%         5.2%
 *   Ground_Overhead             43.8%       26.0%        11.5%
 *   First-Floor_Overhead        31.9%       18.2%         8.5%
 *
 * 64 is the chosen point: most of the AVAILABLE gain past 32, well short of
 * where triangle count starts growing faster than the fill it buys (128
 * cells roughly triples the triangles for a smaller further cut). At 12000px
 * that is one cell per 187.5 source px — still coarser than the 512-wide
 * coarse alpha grid's own ~23px/texel, so this is not yet limited by the
 * grid's own resolution (`buildCoverageCellMask`'s "finer than the grid"
 * guard exists for exactly the point past which refining further stops
 * helping). Index buffer stays at most 64×64×6 = 24576 indices (8192
 * triangles) per tile — vegetation overlays are unaffected, they tessellate
 * at their OWN wind-sway `segments` count, never this constant.
 */
export const COVERAGE_MESH_CELLS = 64;

/** Alpha (0-255) at or above which a texel counts as "there is art here". */
export const COVERAGE_ALPHA_THRESHOLD = 4;

/**
 * Decide which cells of an n×n tessellation of ONE TILE contain art.
 *
 * The grid describes the WHOLE source image; a tile may be a sub-rect of it
 * (`planImageTiles` splits an image past the hardware/memory cap), so each
 * cell is mapped through the tile's own source rect before being looked up —
 * never assumed to span the whole image.
 *
 * @param {object} args
 * @param {{w:number, h:number, data:Uint8Array}|null|undefined} args.grid - the
 *   item's coarse alpha grid over its ENTIRE source image (`vt/coarse-alpha.js`).
 * @param {{sx:number, sy:number, sw:number, sh:number}|null} [args.tile] - this
 *   tile's source rect in image pixels. Omitted/null means the whole image.
 * @param {number} args.imageW - the SOURCE image's own width in px.
 * @param {number} args.imageH - the SOURCE image's own height in px.
 * @param {number} args.cells - cells per axis (the tessellation's `segments`).
 * @param {number} [args.alphaThreshold=COVERAGE_ALPHA_THRESHOLD]
 * @param {boolean} [args.dilate=true]
 * @returns {{cells:number, occupied:Uint8Array, occupiedCount:number}|null}
 *   `null` when there is nothing trustworthy to act on, or when the answer is
 *   "keep everything" — both mean the caller should draw the ordinary full
 *   quad, so a null saves it building an index buffer identical to the default.
 */
export function buildCoverageCellMask({
  grid,
  tile = null,
  imageW,
  imageH,
  cells,
  alphaThreshold = COVERAGE_ALPHA_THRESHOLD,
  dilate = true,
}) {
  const n = Math.floor(Number(cells) || 0);
  const gw = Math.floor(Number(grid?.w) || 0);
  const gh = Math.floor(Number(grid?.h) || 0);
  const data = grid?.data;
  if (n < 1 || gw < 1 || gh < 1 || !data || data.length < gw * gh) return null;
  const iw = Number(imageW) || 0;
  const ih = Number(imageH) || 0;
  if (!(iw > 0) || !(ih > 0)) return null;

  // The tile's own source rect, defaulting to the whole image. Clamped because
  // a padded/compressed plan can describe a rect fractionally past the edge.
  const sx = Math.max(0, Number(tile?.sx) || 0);
  const sy = Math.max(0, Number(tile?.sy) || 0);
  const sw = Math.min(iw - sx, Number(tile?.sw) || iw);
  const sh = Math.min(ih - sy, Number(tile?.sh) || ih);
  if (!(sw > 0) || !(sh > 0)) return null;

  const raw = new Uint8Array(n * n);
  let rawCount = 0;
  for (let cy = 0; cy < n; cy++) {
    const [gy0, gy1] = cellGridSpan(cy, n, sy, sh, ih, gh);
    for (let cx = 0; cx < n; cx++) {
      const [gx0, gx1] = cellGridSpan(cx, n, sx, sw, iw, gw);
      let hit = 0;
      for (let gy = gy0; gy < gy1 && !hit; gy++) {
        const row = gy * gw;
        for (let gx = gx0; gx < gx1; gx++) {
          if (data[row + gx] >= alphaThreshold) {
            hit = 1;
            break;
          }
        }
      }
      if (hit) {
        raw[cy * n + cx] = 1;
        rawCount++;
      }
    }
  }

  if (rawCount === 0) {
    // A genuinely empty tile (a layer's art lives entirely in a DIFFERENT tile
    // of the same split image). Reported as an all-empty mask rather than
    // null: "draw nothing" is a real, correct, maximally-valuable answer here,
    // and collapsing it into null would draw the whole quad instead.
    return { cells: n, occupied: raw, occupiedCount: 0 };
  }

  const occupied = dilate ? dilateCellMask(raw, n) : raw;
  let occupiedCount = 0;
  for (let i = 0; i < occupied.length; i++) if (occupied[i]) occupiedCount++;
  // Nothing to gain — every cell survives, so the caller's plain quad is both
  // cheaper to build and identical to draw.
  if (occupiedCount >= n * n) return null;
  return { cells: n, occupied, occupiedCount };
}

/**
 * One axis of the cell → coarse-grid-texel mapping: mesh cell `c` of `n`, over
 * the tile's source span `[s0, s0+sLen)` of an `imgDim`-px image, → the
 * half-open texel range `[g0, g1)` it must sample. `ceil` on the high edge and
 * the `+1` floor guarantee at least one texel per cell even when the mesh is
 * finer than the grid — a cell that samples NOTHING would read as empty and
 * silently delete art. Extracted (2026-08-10, Stage 1) so
 * `splitCoverageCellMask` cannot drift from `buildCoverageCellMask`'s mapping:
 * one function, two callers, and the ceil-overlap is load-bearing for BOTH
 * (here it keeps art; there it conservatively demotes edge-adjacent cells to
 * boundary, which also covers bilinear filter reach at ~23px/texel).
 *
 * @param {number} c @param {number} n
 * @param {number} s0 @param {number} sLen
 * @param {number} imgDim @param {number} gDim
 * @returns {[number, number]}
 */
function cellGridSpan(c, n, s0, sLen, imgDim, gDim) {
  const p0 = s0 + (sLen * c) / n;
  const p1 = s0 + (sLen * (c + 1)) / n;
  let g0 = Math.floor((p0 / imgDim) * gDim);
  let g1 = Math.ceil((p1 / imgDim) * gDim);
  g0 = Math.max(0, Math.min(gDim - 1, g0));
  g1 = Math.max(g0 + 1, Math.min(gDim, g1));
  return [g0, g1];
}

/**
 * STAGE 1 (docs/planning/Stage-1-Shade-Once.md §3) — partition an existing
 * kept-cell mask into INTERIOR (certified fully opaque: every min-grid texel
 * the cell touches is exactly 255) and BOUNDARY (every other kept cell).
 *
 * The certification source is the per-texel MIN grid
 * (`coarse-alpha.js#accumulateMinAlphaBand`) — NEVER the box-averaged mean
 * grid the occupancy mask was built from, which cannot certify a min (its
 * §2 has the full argument). The dilation ring lands in boundary by
 * construction: its texels touch alpha 0. `cellGridSpan`'s ceil-overlap means
 * a cell adjacent to any transparency samples at least one sub-255 texel and
 * demotes itself — the conservative direction, since a boundary cell drawn
 * blended is always correct, merely unoptimised.
 *
 * Fails OPEN, matching this module's contract: `null` for any unusable input
 * AND for "zero interior cells" — both mean the caller keeps its existing
 * single mesh and today's exact pixels.
 *
 * @param {object} args
 * @param {{cells:number, occupied:Uint8Array, occupiedCount:number}|null} args.mask -
 *   from {@link buildCoverageCellMask}, for the SAME tile/image geometry.
 * @param {{w:number, h:number, data:Uint8Array}|null|undefined} args.minGrid -
 *   the item's min-alpha grid over its ENTIRE source image.
 * @param {{sx:number, sy:number, sw:number, sh:number}|null} [args.tile]
 * @param {number} args.imageW @param {number} args.imageH
 * @returns {{
 *   interior: {cells:number, occupied:Uint8Array, occupiedCount:number},
 *   boundary: {cells:number, occupied:Uint8Array, occupiedCount:number},
 * }|null} both halves are `buildCoverageIndices`-shaped; interior ∪ boundary
 *   equals the input mask's occupied set exactly, and they are disjoint.
 */
export function splitCoverageCellMask({ mask, minGrid, tile = null, imageW, imageH }) {
  const n = Math.floor(Number(mask?.cells) || 0);
  const occupied = mask?.occupied;
  if (n < 1 || !occupied || occupied.length < n * n) return null;
  const gw = Math.floor(Number(minGrid?.w) || 0);
  const gh = Math.floor(Number(minGrid?.h) || 0);
  const data = minGrid?.data;
  if (gw < 1 || gh < 1 || !data || data.length < gw * gh) return null;
  const iw = Number(imageW) || 0;
  const ih = Number(imageH) || 0;
  if (!(iw > 0) || !(ih > 0)) return null;

  const sx = Math.max(0, Number(tile?.sx) || 0);
  const sy = Math.max(0, Number(tile?.sy) || 0);
  const sw = Math.min(iw - sx, Number(tile?.sw) || iw);
  const sh = Math.min(ih - sy, Number(tile?.sh) || ih);
  if (!(sw > 0) || !(sh > 0)) return null;

  const interior = new Uint8Array(n * n);
  const boundary = new Uint8Array(n * n);
  let interiorCount = 0;
  let boundaryCount = 0;
  for (let cy = 0; cy < n; cy++) {
    const [gy0, gy1] = cellGridSpan(cy, n, sy, sh, ih, gh);
    for (let cx = 0; cx < n; cx++) {
      const ci = cy * n + cx;
      if (!occupied[ci]) continue;
      const [gx0, gx1] = cellGridSpan(cx, n, sx, sw, iw, gw);
      let solid = 1;
      for (let gy = gy0; gy < gy1 && solid; gy++) {
        const row = gy * gw;
        for (let gx = gx0; gx < gx1; gx++) {
          if (data[row + gx] !== 255) {
            solid = 0;
            break;
          }
        }
      }
      if (solid) {
        interior[ci] = 1;
        interiorCount++;
      } else {
        boundary[ci] = 1;
        boundaryCount++;
      }
    }
  }
  // Zero interior means the split buys nothing — one mesh drawing everything
  // blended IS today's behaviour, so hand the caller back its fast path.
  if (interiorCount === 0) return null;
  return {
    interior: { cells: n, occupied: interior, occupiedCount: interiorCount },
    boundary: { cells: n, occupied: boundary, occupiedCount: boundaryCount },
  };
}

/** Grow a cell mask by one cell in all 8 directions. See this module's own
 * "why it is safe to drop a cell" note 3 for why this is not optional.
 * @param {Uint8Array} src @param {number} n @returns {Uint8Array} */
function dilateCellMask(src, n) {
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!src[y * n + x]) continue;
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(n - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(n - 1, x + 1);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) out[yy * n + xx] = 1;
      }
    }
  }
  return out;
}

/**
 * The index buffer for the occupied cells of an n×n tessellation, in the SAME
 * per-cell winding `buildTessellatedQuadGeometry` uses — (a,b,c)/(a,c,d) over
 * the (n+1)² vertex grid — so a coverage mesh and a full one face identically
 * and can share one vertex buffer.
 *
 * @param {{cells:number, occupied:Uint8Array, occupiedCount:number}} mask
 * @returns {Uint32Array} `occupiedCount * 6` indices; empty when nothing is occupied.
 */
export function buildCoverageIndices(mask) {
  const n = Math.floor(Number(mask?.cells) || 0);
  const occupied = mask?.occupied;
  if (n < 1 || !occupied) return new Uint32Array(0);
  const side = n + 1;
  const out = new Uint32Array(Math.max(0, Number(mask.occupiedCount) || 0) * 6);
  let t = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (!occupied[j * n + i]) continue;
      const a = j * side + i;
      const b = a + 1;
      const c = a + side + 1;
      const d = a + side;
      out[t++] = a;
      out[t++] = b;
      out[t++] = c;
      out[t++] = a;
      out[t++] = c;
      out[t++] = d;
    }
  }
  // Exact-size guarantee: `occupiedCount` and the loop must agree, or the tail
  // would be zero-filled — index 0 six times over, a degenerate triangle at the
  // quad's own first corner. Trimming is cheap insurance against a caller that
  // hand-built a mask with a stale count.
  return t === out.length ? out : out.subarray(0, t);
}
