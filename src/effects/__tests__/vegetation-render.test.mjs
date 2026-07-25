/**
 * vegetation-render.test.mjs — Case 1 detection (a tile whose OWN texture is
 * `_Tree`/`_Bush`-suffixed) and the vertex-displacement curve. Case 2
 * (sibling-file discovery) is a network question and lives in boot.js — see
 * vegetation-render.js's own header for why that split is deliberate.
 */
import {
  detectSelfVegetationKind,
  heightWeight01,
  validateVegetationKinds,
  vegetationMeshSegments,
  buildTessellatedQuadGeometry,
  VEGETATION_MIN_SEGMENTS,
  VEGETATION_MAX_SEGMENTS,
} from '../vegetation-render.js';
import { VEGETATION_KINDS } from '../vegetation.js';

export function run(t) {
  const { ok } = t;

  // --- detectSelfVegetationKind: the real, positive cases -------------------
  ok(
    'a plain _Tree-suffixed tile src is detected as tree',
    detectSelfVegetationKind('assets/tiles/oak-cluster_Tree.webp')?.id === 'tree'
  );
  ok(
    'a plain _Bush-suffixed tile src is detected as bush',
    detectSelfVegetationKind('assets/tiles/hedge-row_Bush.png')?.id === 'bush'
  );
  ok(
    'case-insensitive (Windows-hosted servers serve case-insensitively — same reasoning mask-discovery.js uses)',
    detectSelfVegetationKind('assets/tiles/OAK_tree.WEBP')?.id === 'tree'
  );
  ok(
    'a query string after the extension does not break detection',
    detectSelfVegetationKind('assets/tiles/hedge_Bush.webp?v=3')?.id === 'bush'
  );
  ok(
    'no directory prefix still detects correctly (a bare filename)',
    detectSelfVegetationKind('hedge_Bush.webp')?.id === 'bush'
  );

  // --- the negative cases — must NOT false-positive ------------------------
  ok(
    'a plain tile with no suffix at all is not vegetation',
    detectSelfVegetationKind('assets/tiles/rock.webp') === null
  );
  ok(
    'endsWith is anchored to the true END — "_Tree" merely PRESENT (followed by more name) does not match ' +
      '("_Tree_wall.webp" is a wall tile that happens to contain "_Tree", not vegetation)',
    detectSelfVegetationKind('assets/tiles/_Tree_wall.webp') === null
  );
  ok(
    'trailing letters "tree" with no suffix DELIMITER do not match ("banyantree.webp" is not "_Tree"-suffixed)',
    detectSelfVegetationKind('assets/tiles/banyantree.webp') === null
  );
  ok(
    'an empty/undefined src never throws and returns null',
    detectSelfVegetationKind('') === null && detectSelfVegetationKind(undefined) === null
  );
  ok(
    'a URL with no extension at all is handled without throwing, and a non-matching one still returns null',
    detectSelfVegetationKind('assets/tiles/oak_stump') === null
  );
  ok(
    'a URL with no extension whose name genuinely ends in the suffix still matches (no throw, correct match)',
    detectSelfVegetationKind('assets/tiles/oak_Tree')?.id === 'tree'
  );

  // --- validateVegetationKinds against the REAL declared table -------------
  ok('the real VEGETATION_KINDS table validates', validateVegetationKinds(VEGETATION_KINDS).ok);

  // --- heightWeight01: pinned root, full tip, monotonic, quadratic ease-in --
  ok('the root (v=0) never moves', heightWeight01(0) === 0);
  ok('the tip (v=1) moves at full weight', heightWeight01(1) === 1);
  ok('the midpoint moves LESS than half (quadratic ease-in, not linear)', heightWeight01(0.5) === 0.25);
  ok(
    'monotonically increasing across the range',
    heightWeight01(0.2) < heightWeight01(0.6) && heightWeight01(0.6) < heightWeight01(0.9)
  );
  ok('a v slightly below 0 clamps rather than extrapolating negative', heightWeight01(-0.3) === 0);
  ok('a v slightly above 1 clamps rather than extrapolating past full', heightWeight01(1.3) === 1);

  // ==========================================================================
  // TESSELLATION — the fix for "everything sways identically" (2026-07-23).
  // A 4-vertex quad can only ever carry ONE wind sample; these helpers are what
  // give a whole-map canopy enough vertices to disagree with itself.
  // ==========================================================================

  // --- segment count: real resolution, honestly bounded --------------------
  {
    ok(
      'a big map tessellates but stays inside the ceiling',
      vegetationMeshSegments(12000, 12000) === VEGETATION_MAX_SEGMENTS
    );
    ok(
      'a mid-size background gets real resolution (not clamped to either end)',
      vegetationMeshSegments(3200, 3200) > VEGETATION_MIN_SEGMENTS &&
        vegetationMeshSegments(3200, 3200) < VEGETATION_MAX_SEGMENTS
    );
    ok('a small bush tile still gets the minimum give', vegetationMeshSegments(120, 90) === VEGETATION_MIN_SEGMENTS);
    ok(
      'segments follow the LONGEST axis (a wide, short banner still subdivides)',
      vegetationMeshSegments(6000, 100) > 10
    );
    ok(
      'degenerate/absent sizes fall back to the minimum rather than 0 or NaN',
      vegetationMeshSegments(0, 0) === VEGETATION_MIN_SEGMENTS &&
        vegetationMeshSegments(NaN, undefined) === VEGETATION_MIN_SEGMENTS
    );
    ok(
      'negative sizes are treated by magnitude, never producing a negative count',
      vegetationMeshSegments(-3200, -3200) > VEGETATION_MIN_SEGMENTS
    );
  }

  // --- geometry: counts, corners, UVs, index validity ----------------------
  {
    // A deliberately ROTATED, non-axis-aligned quad — the case a bounding-box
    // approximation would get wrong, so the bilinear interpolation is actually
    // being tested rather than a trivially-square one.
    const corners = [
      { x: 100, y: 100 }, // uv (0,0)
      { x: 300, y: 140 }, // uv (1,0)
      { x: 260, y: 340 }, // uv (1,1)
      { x: 60, y: 300 }, // uv (0,1)
    ];
    const n = 4;
    const g = buildTessellatedQuadGeometry(corners, n);
    const side = n + 1;

    ok('vertex count is (segments+1)²', g.vertexCount === side * side && g.positions.length === side * side * 3);
    ok('one UV pair per vertex', g.uvs.length === side * side * 2);
    ok('two triangles per cell', g.indices.length === n * n * 6);

    // The four grid CORNERS must land exactly on the four world corners —
    // this is what proves the tessellated mesh occupies the same footprint as
    // the plain quad it replaces (a mismatch here would shift the whole canopy).
    const vertAt = (i, j) => {
      const idx = (j * side + i) * 3;
      return { x: g.positions[idx], y: g.positions[idx + 1], z: g.positions[idx + 2] };
    };
    const near = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
    ok('grid corner (0,0) matches world corner 0', near(vertAt(0, 0), corners[0]));
    ok('grid corner (n,0) matches world corner 1', near(vertAt(n, 0), corners[1]));
    ok('grid corner (n,n) matches world corner 2', near(vertAt(n, n), corners[2]));
    ok('grid corner (0,n) matches world corner 3', near(vertAt(0, n), corners[3]));

    // The centre must be the average of the four corners for a bilinear patch —
    // the check that actually catches a transposed u/v or a wrong edge pairing.
    const centre = vertAt(n / 2, n / 2);
    const avg = {
      x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
      y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
    };
    ok('the grid centre is the bilinear centre of the four corners', near(centre, avg));

    ok(
      'every vertex is flat (z = 0, a painter-ordered 2D composite)',
      g.positions.every((_, i) => i % 3 !== 2 || g.positions[i] === 0)
    );

    // UVs must span the full 0..1 range in both axes, matching QUAD_UVS.
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let i = 0; i < g.uvs.length; i += 2) {
      uMin = Math.min(uMin, g.uvs[i]);
      uMax = Math.max(uMax, g.uvs[i]);
      vMin = Math.min(vMin, g.uvs[i + 1]);
      vMax = Math.max(vMax, g.uvs[i + 1]);
    }
    ok('UVs span exactly 0..1 on both axes', uMin === 0 && uMax === 1 && vMin === 0 && vMax === 1);

    // No index may point outside the vertex buffer — a class of bug that shows
    // up as garbage geometry or a device fault rather than a clean error.
    ok(
      'every index is in range',
      g.indices.every((ix) => ix >= 0 && ix < g.vertexCount)
    );
  }

  // --- degenerate inputs -----------------------------------------------------
  {
    const one = buildTessellatedQuadGeometry(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      1
    );
    ok('segments=1 degenerates to exactly the plain 4-vertex quad', one.vertexCount === 4 && one.indices.length === 6);
    let threw = false;
    try {
      buildTessellatedQuadGeometry([{ x: 0, y: 0 }], 4);
    } catch (_) {
      threw = true;
    }
    ok('a wrong corner count throws loudly rather than producing silent garbage', threw);
  }
}
