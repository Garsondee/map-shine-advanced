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
 * 32 is a deliberate middle: at 12000px that is one cell per 375 source px, so
 * a roof occupying 9.9% of its canvas lands in roughly 10-15% of cells even
 * after dilation, while the index buffer stays at most 32×32×6 = 6144 indices
 * (2048 triangles) per tile. Against the ~262k triangles a live frame already
 * draws, the added geometry is noise; the fill it removes is not.
 */
export const COVERAGE_MESH_CELLS = 32;

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
    // Cell → source px → grid cell. `ceil` on the high edge and the +1 floor
    // below guarantee at least one grid sample per mesh cell even when the mesh
    // is finer than the grid — a cell that samples NOTHING would read as empty
    // and silently delete art.
    const py0 = sy + (sh * cy) / n;
    const py1 = sy + (sh * (cy + 1)) / n;
    let gy0 = Math.floor((py0 / ih) * gh);
    let gy1 = Math.ceil((py1 / ih) * gh);
    gy0 = Math.max(0, Math.min(gh - 1, gy0));
    gy1 = Math.max(gy0 + 1, Math.min(gh, gy1));
    for (let cx = 0; cx < n; cx++) {
      const px0 = sx + (sw * cx) / n;
      const px1 = sx + (sw * (cx + 1)) / n;
      let gx0 = Math.floor((px0 / iw) * gw);
      let gx1 = Math.ceil((px1 / iw) * gw);
      gx0 = Math.max(0, Math.min(gw - 1, gx0));
      gx1 = Math.max(gx0 + 1, Math.min(gw, gx1));
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
