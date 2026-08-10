/**
 * Node verification for vt/coverage-mesh.js.
 *
 * Pure array logic — no GPU, no THREE — so these are real tests of the real
 * function, not wiring checks. The property that matters most is NEGATIVE: a
 * cell containing ANY art must never be dropped, because the failure mode is
 * silently missing art on the author's map. Several cases below exist only to
 * pin that direction.
 */
import {
  buildCoverageCellMask,
  buildCoverageIndices,
  splitCoverageCellMask,
  COVERAGE_MESH_CELLS,
  COVERAGE_ALPHA_THRESHOLD,
} from '../coverage-mesh.js';

/** A w×h alpha grid, `paint(x,y)` returning 0-255. */
function grid(w, h, paint) {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = paint(x, y);
  return { w, h, data };
}

/** Every cell index the mask marks occupied, as "x,y" strings. */
function occupiedSet(mask) {
  const s = new Set();
  for (let y = 0; y < mask.cells; y++) {
    for (let x = 0; x < mask.cells; x++) if (mask.occupied[y * mask.cells + x]) s.add(`${x},${y}`);
  }
  return s;
}

export function run(t) {
  const { ok } = t;

  // A fully-painted image has nothing to drop — null tells the caller to keep
  // its ordinary quad rather than build an index buffer identical to it.
  {
    const g = grid(64, 64, () => 255);
    const mask = buildCoverageCellMask({ grid: g, imageW: 640, imageH: 640, cells: 8 });
    ok('fully opaque art returns null (nothing to gain, caller keeps its quad)', mask === null);
  }

  // The headline case: art in one corner only.
  {
    // Paint the top-left eighth of the image.
    const g = grid(64, 64, (x, y) => (x < 8 && y < 8 ? 255 : 0));
    const mask = buildCoverageCellMask({ grid: g, imageW: 640, imageH: 640, cells: 8, dilate: false });
    ok('a corner-only image drops most cells', mask !== null && mask.occupiedCount === 1);
    ok('...and the surviving cell is the RIGHT one', occupiedSet(mask).has('0,0'));
  }

  // Dilation is not cosmetic — it is the guard against a faint edge falloff
  // sitting just under the threshold in the neighbouring cell.
  {
    const g = grid(64, 64, (x, y) => (x < 8 && y < 8 ? 255 : 0));
    const bare = buildCoverageCellMask({ grid: g, imageW: 640, imageH: 640, cells: 8, dilate: false });
    const grown = buildCoverageCellMask({ grid: g, imageW: 640, imageH: 640, cells: 8, dilate: true });
    ok('dilation keeps strictly more cells than it drops', grown.occupiedCount > bare.occupiedCount);
    const s = occupiedSet(grown);
    ok(
      'dilation is a real 8-neighbourhood, not just an axis pair',
      s.has('0,0') && s.has('1,0') && s.has('0,1') && s.has('1,1')
    );
    ok('...and does not leak across the whole grid', !s.has('3,3'));
  }

  // ANY texel over the threshold keeps the cell — never an average. A single
  // bright pixel in an otherwise-empty cell is a thin line crossing it, and a
  // mean would erase it.
  {
    const g = grid(64, 64, (x, y) => (x === 40 && y === 40 ? 255 : 0));
    const mask = buildCoverageCellMask({ grid: g, imageW: 640, imageH: 640, cells: 8, dilate: false });
    ok('ONE opaque texel in an empty cell keeps that cell', mask !== null && mask.occupiedCount === 1);
    ok('...the cell the texel is actually in', occupiedSet(mask).has('5,5'));
  }

  // The threshold answers "is anything here", so a value just under it drops
  // and just over it keeps — pinned in both directions so a future tweak to
  // the constant cannot silently invert the test.
  {
    const under = grid(8, 8, () => COVERAGE_ALPHA_THRESHOLD - 1);
    const over = grid(8, 8, () => COVERAGE_ALPHA_THRESHOLD);
    const mUnder = buildCoverageCellMask({ grid: under, imageW: 80, imageH: 80, cells: 4 });
    const mOver = buildCoverageCellMask({ grid: over, imageW: 80, imageH: 80, cells: 4 });
    ok('alpha below the threshold everywhere is an empty mask', mUnder !== null && mUnder.occupiedCount === 0);
    ok('alpha AT the threshold everywhere keeps everything (so: null)', mOver === null);
  }

  // A tile that is a SUB-RECT of a split image must look up its own region of
  // the grid, never the whole image's — getting this wrong would mesh every
  // tile of a split image against the same (wrong) corner of the art.
  {
    // Art only in the right half of the image.
    const g = grid(64, 64, (x) => (x >= 32 ? 255 : 0));
    const leftTile = { sx: 0, sy: 0, sw: 320, sh: 640 };
    const rightTile = { sx: 320, sy: 0, sw: 320, sh: 640 };
    const mLeft = buildCoverageCellMask({
      grid: g,
      tile: leftTile,
      imageW: 640,
      imageH: 640,
      cells: 4,
      dilate: false,
    });
    const mRight = buildCoverageCellMask({
      grid: g,
      tile: rightTile,
      imageW: 640,
      imageH: 640,
      cells: 4,
      dilate: false,
    });
    ok('the tile covering the EMPTY half meshes to nothing', mLeft !== null && mLeft.occupiedCount === 0);
    ok('the tile covering the PAINTED half keeps everything (null)', mRight === null);
  }

  // Fail-open: every unusable input draws the ordinary full quad.
  {
    ok('no grid → null', buildCoverageCellMask({ grid: null, imageW: 100, imageH: 100, cells: 8 }) === null);
    ok(
      'zero-sized image → null (never a divide-by-zero mask)',
      buildCoverageCellMask({ grid: grid(8, 8, () => 255), imageW: 0, imageH: 100, cells: 8 }) === null
    );
    ok(
      'a grid whose data is shorter than w*h → null, never a partial read',
      buildCoverageCellMask({ grid: { w: 8, h: 8, data: new Uint8Array(4) }, imageW: 80, imageH: 80, cells: 4 }) ===
        null
    );
    ok(
      'cells < 1 → null',
      buildCoverageCellMask({ grid: grid(8, 8, () => 255), imageW: 80, imageH: 80, cells: 0 }) === null
    );
  }

  // A mesh FINER than the grid must still sample at least one grid texel per
  // cell — a cell that sampled an empty range would read as empty and delete
  // real art.
  {
    const g = grid(4, 4, () => 255);
    const mask = buildCoverageCellMask({ grid: g, imageW: 400, imageH: 400, cells: 16, dilate: false });
    ok('a mesh finer than the grid never reads a cell as empty (so: null)', mask === null);
  }

  // buildCoverageIndices — the winding must match buildTessellatedQuadGeometry's
  // own (a,b,c)/(a,c,d) over an (n+1)² vertex grid, or a coverage mesh would
  // face the opposite way from a full one.
  {
    const mask = { cells: 2, occupied: new Uint8Array([1, 0, 0, 0]), occupiedCount: 1 };
    const idx = buildCoverageIndices(mask);
    ok('one occupied cell emits exactly 6 indices', idx.length === 6);
    // side = 3; cell (0,0) → a=0, b=1, c=4, d=3
    ok(
      'winding matches the tessellated quad`s own (a,b,c)/(a,c,d)',
      idx[0] === 0 && idx[1] === 1 && idx[2] === 4 && idx[3] === 0 && idx[4] === 4 && idx[5] === 3
    );
  }
  {
    const mask = { cells: 2, occupied: new Uint8Array([0, 1, 1, 0]), occupiedCount: 2 };
    const idx = buildCoverageIndices(mask);
    ok('two occupied cells emit 12 indices', idx.length === 12);
    // side = 3; cell (1,0) → a=1; cell (0,1) → a=3
    ok('the second cell starts at its own vertex, not the first`s', idx[0] === 1 && idx[6] === 3);
  }
  {
    const idx = buildCoverageIndices({ cells: 2, occupied: new Uint8Array(4), occupiedCount: 0 });
    ok('an all-empty mask emits an EMPTY index buffer (draws nothing)', idx.length === 0);
  }
  {
    // A stale count must never leave a zero-filled tail — six zeroes would be a
    // degenerate triangle pinned at the quad's own first corner.
    const idx = buildCoverageIndices({ cells: 2, occupied: new Uint8Array([1, 0, 0, 0]), occupiedCount: 99 });
    ok('an over-stated occupiedCount is trimmed, never zero-padded', idx.length === 6);
  }

  // The shipped cell count has to be a real, usable tessellation.
  {
    ok('COVERAGE_MESH_CELLS is a positive integer', Number.isInteger(COVERAGE_MESH_CELLS) && COVERAGE_MESH_CELLS > 1);
    const g = grid(512, 512, (x, y) => (x < 64 && y < 64 ? 255 : 0));
    const mask = buildCoverageCellMask({ grid: g, imageW: 12000, imageH: 12000, cells: COVERAGE_MESH_CELLS });
    // A FRACTION of the total, not a fixed count — the absolute cell count this
    // corner occupies scales with COVERAGE_MESH_CELLS itself (a finer grid has
    // more total cells AND a finer corner block), so a hardcoded bound breaks
    // every time that constant is retuned even though the real property (most
    // cells are dropped) still holds. 12.5%-per-axis corner art plus one ring
    // of dilation is comfortably under a tenth of the grid at any cell count
    // this module would plausibly ship.
    ok(
      'a 12000² image with corner-only art drops most cells at the shipped size',
      mask.occupiedCount < mask.cells * mask.cells * 0.1
    );
    ok(
      '...and buildCoverageIndices agrees with the count it reports',
      buildCoverageIndices(mask).length === mask.occupiedCount * 6
    );
  }

  // --- Stage 1: the interior/boundary split (splitCoverageCellMask) --------
  // 640x640 image, 8-cell mesh (80px cells), 64x64 grids (10px texels): cell
  // and texel edges align exactly, so expectations below are exact, not fuzzy.
  // Left half painted solid, right half empty → occupied = cx 0..3 (art) plus
  // cx 4 (the dilation ring).
  {
    const mean = grid(64, 64, (x) => (x < 32 ? 255 : 0));
    const mask = buildCoverageCellMask({ grid: mean, imageW: 640, imageH: 640, cells: 8 });
    const min = { w: 64, h: 64, data: grid(64, 64, (x) => (x < 32 ? 255 : 0)).data };
    const split = splitCoverageCellMask({ mask, minGrid: min, imageW: 640, imageH: 640 });
    ok('a split exists when certified-solid art exists', !!split);
    const inter = occupiedSet(split.interior);
    const bound = occupiedSet(split.boundary);
    let disjoint = true;
    for (const k of inter) if (bound.has(k)) disjoint = false;
    ok('interior and boundary are DISJOINT', disjoint);
    const occ = occupiedSet(mask);
    ok(
      'interior ∪ boundary is EXACTLY the kept-cell set — no cell invented, none lost',
      inter.size + bound.size === occ.size && [...inter, ...bound].every((k) => occ.has(k))
    );
    ok(
      'counts agree with the masks they describe',
      split.interior.occupiedCount === inter.size && split.boundary.occupiedCount === bound.size
    );
    ok('solid-art cells are interior, to the paint edge', inter.has('0,0') && inter.has('3,4'));
    ok('the dilation ring is boundary by construction', bound.has('4,0') && bound.has('4,7'));
    ok(
      'indices come out sized to each half',
      buildCoverageIndices(split.interior).length === split.interior.occupiedCount * 6 &&
        buildCoverageIndices(split.boundary).length === split.boundary.occupiedCount * 6
    );
  }
  // One sub-255 texel deep inside otherwise-solid art demotes ONLY the cell
  // whose rect contains it — the certification a box-averaged MEAN cannot make
  // (a lone 254 rounds away in a mean; it must NOT round away here).
  {
    const mean = grid(64, 64, (x) => (x < 32 ? 255 : 0));
    const mask = buildCoverageCellMask({ grid: mean, imageW: 640, imageH: 640, cells: 8 });
    const minData = grid(64, 64, (x) => (x < 32 ? 255 : 0)).data;
    minData[16 * 64 + 16] = 254; // texel (16,16) — inside cell (2,2)'s aligned 8-texel rect
    const split = splitCoverageCellMask({ mask, minGrid: { w: 64, h: 64, data: minData }, imageW: 640, imageH: 640 });
    ok('a single 254 texel demotes its own cell to boundary', occupiedSet(split.boundary).has('2,2'));
    ok(
      '…without touching any other interior cell',
      occupiedSet(split.interior).has('0,6') && split.interior.occupiedCount === 31
    );
  }
  // Fail-opens — every one hands the caller its single-mesh fast path back.
  {
    const mean = grid(64, 64, (x) => (x < 32 ? 255 : 0));
    const mask = buildCoverageCellMask({ grid: mean, imageW: 640, imageH: 640, cells: 8 });
    ok(
      'a missing min grid fails open to null',
      splitCoverageCellMask({ mask, minGrid: null, imageW: 640, imageH: 640 }) === null
    );
    const allSoft = { w: 64, h: 64, data: grid(64, 64, () => 200).data };
    ok(
      'zero certified-interior cells fails open to null (all-blended IS today)',
      splitCoverageCellMask({ mask, minGrid: allSoft, imageW: 640, imageH: 640 }) === null
    );
    ok(
      'a null mask fails open to null',
      splitCoverageCellMask({ mask: null, minGrid: allSoft, imageW: 640, imageH: 640 }) === null
    );
  }
  // A sub-rect tile maps through its own source rect, exactly like the builder.
  {
    const mean = grid(64, 64, (x) => (x < 32 ? 255 : 0));
    const tile = { sx: 320, sy: 0, sw: 320, sh: 640 };
    const mask = buildCoverageCellMask({ grid: mean, tile, imageW: 640, imageH: 640, cells: 8 });
    ok('the right-half tile of left-half art keeps its all-empty mask', mask !== null && mask.occupiedCount === 0);
    const min = { w: 64, h: 64, data: grid(64, 64, (x) => (x < 32 ? 255 : 0)).data };
    ok(
      'and its split is null (nothing occupied at all)',
      splitCoverageCellMask({ mask, minGrid: min, tile, imageW: 640, imageH: 640 }) === null
    );
  }
}
