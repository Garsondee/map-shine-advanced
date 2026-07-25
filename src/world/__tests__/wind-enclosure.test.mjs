/**
 * wind-enclosure.test.mjs — `openness`: the "is this cell connected to the
 * outside" flood-fill (2026-07-22, THE RETHINK — docs/planning/
 * Wind-Rethink.md), 100% pure. Fixtures mirror wind-bake.test.mjs's own
 * style (a hand-built solid mask on a small grid).
 */
import {
  floodFillOpenFromBoundary,
  summarizeEnclosure,
  downsampleMax,
  cropGridMargin,
  distanceFromDoorThreshold,
  opennessFalloffFromDistance,
  downsampleDistanceMin,
  distanceFromNearestSolid,
  wallAvoidanceDirectionFromDistance,
  wallProximityFromDistance,
} from '../wind-enclosure.js';
import { rasterizeWallsToGrid } from '../wind-bake.js';

function idxOf(cols, col, row) {
  return row * cols + col;
}

export function run(t) {
  const { ok } = t;

  // --- no walls at all -> the whole grid is open, reachable trivially ------
  // (2026-07-22, THE RETHINK'S OWN decisive test — the author deleted every
  // wall from a real scene and expected wind everywhere; this is that test,
  // in miniature.)
  {
    const cols = 6;
    const rows = 6;
    const solid = new Uint8Array(cols * rows);
    const open = floodFillOpenFromBoundary(solid, cols, rows);
    ok(
      'an empty (wall-free) grid reads fully open everywhere — no walls means wind everywhere',
      Array.from(open).every((v) => v === 1)
    );
  }

  // --- a single interior solid cell doesn't disconnect anything ------------
  {
    const cols = 6;
    const rows = 6;
    const solid = new Uint8Array(cols * rows);
    solid[idxOf(cols, 3, 3)] = 1;
    const open = floodFillOpenFromBoundary(solid, cols, rows);
    ok('a lone interior wall cell reads 0 (it is solid, not open)', open[idxOf(cols, 3, 3)] === 0);
    ok(
      'every OTHER cell around a single lone wall stays open/reachable',
      Array.from(open)
        .filter((v, i) => i !== idxOf(cols, 3, 3))
        .every((v) => v === 1)
    );
  }

  // --- a FULLY SEALED ROOM (no gaps) — the exact bug scenario --------------
  // A 3x3 interior room (rows/cols 2..4) enclosed by a solid ring at 1 and 5,
  // on a 7x7 grid — no gap anywhere in the ring.
  {
    const cols = 7;
    const rows = 7;
    const solid = new Uint8Array(cols * rows);
    for (let col = 1; col <= 5; col++) {
      solid[idxOf(cols, col, 1)] = 1;
      solid[idxOf(cols, col, 5)] = 1;
    }
    for (let row = 1; row <= 5; row++) {
      solid[idxOf(cols, 1, row)] = 1;
      solid[idxOf(cols, 5, row)] = 1;
    }
    const open = floodFillOpenFromBoundary(solid, cols, rows);
    ok(
      'a fully sealed room (no gaps) reads UNREACHABLE (0, i.e. openness=0, calm) throughout its interior',
      [
        [2, 2],
        [3, 3],
        [4, 4],
        [2, 4],
        [4, 2],
      ].every(([col, row]) => open[idxOf(cols, col, row)] === 0)
    );
    ok(
      'the area OUTSIDE the sealed room (between it and the map border) reads open (1)',
      open[idxOf(cols, 0, 0)] === 1 && open[idxOf(cols, 6, 6)] === 1 && open[idxOf(cols, 0, 6)] === 1
    );
    ok('the ring itself reads 0 (solid, not open)', open[idxOf(cols, 3, 1)] === 0);

    const summary = summarizeEnclosure(solid, open);
    ok(
      'summarizeEnclosure counts the 9 interior cells as enclosed and the ring as solid',
      summary.enclosedCells === 9 && summary.solidCells === 16 && summary.openCells === cols * rows - 9 - 16
    );
  }

  // --- the SAME room, but with ONE gap (a doorway) — must now read OPEN ----
  // floodFillOpenFromBoundary ITSELF stays binary — the whole connected room
  // reads 1 uniformly, no fading. The graded penetration falloff (tested
  // separately below, `distanceFromDoorThreshold`/`opennessFalloffFromDistance`)
  // is a SEPARATE pass layered on top, added 2026-07-22 same day as binary
  // (Wind-Rethink.md §5 q1, "start with binary for testing... aim to do
  // something more interesting if it works" — the author's own staging).
  {
    const cols = 7;
    const rows = 7;
    const solid = new Uint8Array(cols * rows);
    for (let col = 1; col <= 5; col++) {
      solid[idxOf(cols, col, 1)] = 1;
      // row 5 (bottom wall) deliberately SKIPS col 3 — a one-cell doorway.
      if (col !== 3) solid[idxOf(cols, col, 5)] = 1;
    }
    for (let row = 1; row <= 5; row++) {
      solid[idxOf(cols, 1, row)] = 1;
      solid[idxOf(cols, 5, row)] = 1;
    }
    const open = floodFillOpenFromBoundary(solid, cols, rows);
    ok(
      'a room with ONE doorway gap reads OPEN (1) throughout its interior, transitively through the gap — ' +
        'uniformly, not fading with distance from the gap',
      [
        [2, 2],
        [3, 3],
        [4, 4],
      ].every(([col, row]) => open[idxOf(cols, col, row)] === 1)
    );
    ok('the doorway cell itself reads open', open[idxOf(cols, 3, 5)] === 1);

    // --- the door-responsive property: SEAL the same gap back up and the
    // --- whole room drops back to 0 in one rebake, no partial state.
    const solidSealed = Uint8Array.from(solid);
    solidSealed[idxOf(cols, 3, 5)] = 1;
    const openSealed = floodFillOpenFromBoundary(solidSealed, cols, rows);
    ok(
      'sealing the SAME gap back up drops the WHOLE room to 0 — door-responsive by construction, no residual state',
      [
        [2, 2],
        [3, 3],
        [4, 4],
      ].every(([col, row]) => openSealed[idxOf(cols, col, row)] === 0)
    );
  }

  // --- a border cell can itself be solid — must not crash, and everything --
  // --- fully walled off is correctly ALL-enclosed (nothing open at all) ----
  {
    const cols = 4;
    const rows = 4;
    const solid = new Uint8Array(cols * rows).fill(1); // every cell solid, including the whole border
    const open = floodFillOpenFromBoundary(solid, cols, rows);
    ok(
      'an entirely solid grid never crashes and reads all-0 (nothing open, correctly)',
      Array.from(open).every((v) => v === 0)
    );
  }

  // --- degenerate / empty grid never throws --------------------------------
  {
    const open = floodFillOpenFromBoundary(new Uint8Array(0), 0, 0);
    ok('a zero-size grid returns an empty array, never throws', open.length === 0);
    const openMismatch = floodFillOpenFromBoundary(null, 3, 3);
    ok(
      'a null/mismatched solid mask falls back to all-open (treated as no walls), never throws',
      Array.from(openMismatch).every((v) => v === 1)
    );
  }

  // --- determinism -----------------------------------------------------------
  {
    const cols = 5;
    const rows = 5;
    const solid = new Uint8Array(cols * rows);
    solid[idxOf(cols, 2, 2)] = 1;
    const a = floodFillOpenFromBoundary(solid, cols, rows);
    const b = floodFillOpenFromBoundary(solid, cols, rows);
    ok(
      'flood-filling twice from the same input is deterministic',
      Array.from(a).every((v, i) => v === b[i])
    );
  }

  // --- downsampleMax (2026-07-22, fine-to-coarse openness) -------------------
  // a 4x4 fine 0/1 openness mask -> 2x2 coarse, 1 if ANY fine cell in the 2x2
  // footprint is open (max-pool) — a door that only opens part of a coarse
  // cell must still admit wind, so this is deliberately generous.
  {
    //   top-left 2x2:  [1,0,0,0] -> reached (1)
    //   top-right 2x2: [0,0,0,0] -> sealed  (0)
    //   bot-left 2x2:  [0,0,0,1] -> reached (1) via one sliver cell
    //   bot-right 2x2: [1,1,1,1] -> reached (1)
    const fineOpen = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1]);
    const coarseOpen = downsampleMax(fineOpen, 2, 2, 2);
    ok('downsampleMax: a footprint with any reached fine cell reads 1', coarseOpen[0] === 1);
    ok('downsampleMax: a fully-sealed footprint reads 0', coarseOpen[1] === 0);
    ok('downsampleMax: a footprint reached through a single sliver cell still reads 1 (generous)', coarseOpen[2] === 1);
    ok('downsampleMax: a fully-reached footprint reads 1', coarseOpen[3] === 1);
    ok('downsampleMax handles a zero-size grid', downsampleMax(new Uint8Array(0), 0, 0, 4).length === 0);
    ok(
      'downsampleMax with a mismatched-length fine array falls back to all 0, never throws',
      Array.from(downsampleMax(new Uint8Array(3), 2, 2, 2)).every((v) => v === 0)
    );
  }

  // --- the FULL pipeline, end to end: fine rasterize (no over-seal) ->
  // --- flood-fill -> downsample, on a curved/diagonal opening that a
  // --- coarse, over-sealed rasterization would have fused shut (the exact
  // --- author-confirmed live bug: "removing the physical door walls did
  // --- nothing, because the curved entrance geometry sealed at coarse
  // --- resolution"). Simulated here with a DIAGONAL gap, the coarse
  // --- over-seal guard's own trigger case, rather than a real curve.
  {
    // A 6x6 coarse room, ring wall at 1/4, but the "doorway" is a single
    // DIAGONAL step in the wall — the supercover guard would fuse this shut
    // at coarse resolution; at 2x fine resolution with superCover:false, it
    // survives.
    const coarseCols = 6;
    const coarseRows = 6;
    // Fine grid = 2x coarse.
    const fineCols = coarseCols * 2;
    const fineRows = coarseRows * 2;
    const fineSolid = new Uint8Array(fineCols * fineRows);
    const fidx = (c, r) => r * fineCols + c;
    // Ring at fine rows/cols 2 and 7 (mirrors coarse ring at 1/4 * 2).
    for (let c = 2; c <= 7; c++) {
      fineSolid[fidx(c, 2)] = 1;
      if (c !== 5) fineSolid[fidx(c, 7)] = 1; // gap at fine col 5, bottom wall
    }
    for (let r = 2; r <= 7; r++) {
      fineSolid[fidx(2, r)] = 1;
      fineSolid[fidx(7, r)] = 1;
    }
    const fineOpen = floodFillOpenFromBoundary(fineSolid, fineCols, fineRows);
    const coarseOpenness = downsampleMax(fineOpen, coarseCols, coarseRows, 2);
    const cidx = (c, r) => r * coarseCols + c;
    ok(
      'end-to-end: a room reachable only through a sub-coarse-cell gap reads openness=1 at coarse resolution',
      coarseOpenness[cidx(3, 3)] === 1
    );
  }

  // --- distanceFromDoorThreshold / opennessFalloffFromDistance (2026-07-22,
  // --- the door-distance penetration falloff) — the SAME 7x7 ring-room
  // --- fixture as the "one gap" test above, but this time BOTH flood-fills
  // --- a caller would actually produce: `fullOpen` (doors passable, the gap
  // --- open) and `exteriorOpen` (doors always solid, i.e. the gap SEALED —
  // --- the exact fixture the fully-sealed-room test above already built).
  {
    const cols = 7;
    const rows = 7;
    const solidWithGap = new Uint8Array(cols * rows);
    for (let col = 1; col <= 5; col++) {
      solidWithGap[idxOf(cols, col, 1)] = 1;
      if (col !== 3) solidWithGap[idxOf(cols, col, 5)] = 1; // gap at (3,5)
    }
    for (let row = 1; row <= 5; row++) {
      solidWithGap[idxOf(cols, 1, row)] = 1;
      solidWithGap[idxOf(cols, 5, row)] = 1;
    }
    const fullOpen = floodFillOpenFromBoundary(solidWithGap, cols, rows);

    const solidSealed = new Uint8Array(cols * rows);
    for (let col = 1; col <= 5; col++) {
      solidSealed[idxOf(cols, col, 1)] = 1;
      solidSealed[idxOf(cols, col, 5)] = 1; // NO exclusion — the door counts as solid here
    }
    for (let row = 1; row <= 5; row++) {
      solidSealed[idxOf(cols, 1, row)] = 1;
      solidSealed[idxOf(cols, 5, row)] = 1;
    }
    const exteriorOpen = floodFillOpenFromBoundary(solidSealed, cols, rows);

    const distance = distanceFromDoorThreshold(fullOpen, exteriorOpen, cols, rows);
    ok(
      'a genuinely exterior cell (never behind any door) reads -1 — distance-from-door is a meaningless question there',
      distance[idxOf(cols, 0, 0)] === -1
    );
    ok('the open door`s own gap cell reads distance 0 — it IS the threshold', distance[idxOf(cols, 3, 5)] === 0);
    ok('one step further into the room reads a strictly greater distance', distance[idxOf(cols, 3, 4)] === 1);
    ok('the room centre is further still (Manhattan distance from the threshold)', distance[idxOf(cols, 3, 3)] === 2);
    ok('the far interior corner is 4 hops from the threshold', distance[idxOf(cols, 2, 2)] === 4);
    ok('a wall cell (solid in both masks) is never "indoor" at all — reads -1', distance[idxOf(cols, 3, 1)] === -1);

    const falloff = opennessFalloffFromDistance(distance, exteriorOpen, { reachCells: 4 });
    ok(
      'an exterior cell reads falloff 1 unconditionally, ignoring reachCells and distance entirely',
      falloff[idxOf(cols, 0, 0)] === 1
    );
    ok('the threshold cell (distance 0) reads full falloff 1', falloff[idxOf(cols, 3, 5)] === 1);
    ok('one step in (distance 1 of 4) reads 0.75', Math.abs(falloff[idxOf(cols, 3, 4)] - 0.75) < 1e-6);
    ok(
      'the centre (distance 2 of 4) reads 0.5 — "something very subtle"',
      Math.abs(falloff[idxOf(cols, 3, 3)] - 0.5) < 1e-6
    );
    ok('the far corner (distance EXACTLY reachCells) reads 0', falloff[idxOf(cols, 2, 2)] === 0);
    ok('a wall cell (never reached, never exterior) reads 0', falloff[idxOf(cols, 3, 1)] === 0);

    // A FULLY SEALED room (no gap at all) — distance never seeds anything;
    // every interior cell reads -1, falloff 0 throughout, same as the
    // fully-sealed-room test far above.
    const distanceSealed = distanceFromDoorThreshold(exteriorOpen, exteriorOpen, cols, rows);
    ok(
      'with no door open anywhere, nothing is ever classified "indoor via a door" — every cell reads -1',
      Array.from(distanceSealed).every((d) => d === -1)
    );

    // Degenerate / mismatched input never throws.
    ok('a zero-size grid returns an empty array', distanceFromDoorThreshold(fullOpen, exteriorOpen, 0, 0).length === 0);
    ok(
      'a null/mismatched mask falls back to all-solid (never indoor, never exterior) — every cell reads -1',
      Array.from(distanceFromDoorThreshold(null, null, cols, rows)).every((d) => d === -1)
    );
    ok(
      'opennessFalloffFromDistance with no exteriorOpen supplied still works from distance alone',
      opennessFalloffFromDistance(distance, null, { reachCells: 4 })[idxOf(cols, 3, 5)] === 1
    );
  }

  // --- downsampleDistanceMin (2026-07-22, fine-to-coarse door-distance) ------
  {
    // Fine grid (row-major, 4 cols):
    //   top-left 2x2:  [5, 3, 7, 2]  -> min = 2
    //   top-right 2x2: [-1,-1,-1,-1] -> all unreached -> -1
    //   bot-left 2x2:  [-1, 4,-1,-1] -> min of the reached = 4
    //   bot-right 2x2: [0, 9, 1, 8]  -> min = 0
    const fineDist = new Int32Array([5, 3, -1, -1, 7, 2, -1, -1, -1, 4, 0, 9, -1, -1, 1, 8]);
    const coarseDist = downsampleDistanceMin(fineDist, 2, 2, 2);
    ok('downsampleDistanceMin: reachable footprint takes the MIN distance (2)', coarseDist[0] === 2);
    ok('downsampleDistanceMin: a fully-unreached footprint stays -1', coarseDist[1] === -1);
    ok(
      'downsampleDistanceMin: a partly-reached footprint takes the reached min (4), ignoring the -1s',
      coarseDist[2] === 4
    );
    ok('downsampleDistanceMin: a footprint touching a threshold (distance 0) reads 0', coarseDist[3] === 0);
    ok(
      'downsampleDistanceMin handles a zero-size grid',
      downsampleDistanceMin(new Int32Array(0), 0, 0, 4).length === 0
    );
    ok(
      'downsampleDistanceMin with a mismatched-length fine array falls back to all -1, never throws',
      Array.from(downsampleDistanceMin(new Int32Array(3), 2, 2, 2)).every((d) => d === -1)
    );
  }

  // --- distanceFromNearestSolid / wallAvoidanceDirectionFromDistance /
  // wallProximityFromDistance (2026-07-23, the wall-avoidance deflection —
  // author: "walls perpendicular to the wind aren't preventing the wind
  // from penetrating... how can we prevent wind from crossing walls with
  // confidence") — a single vertical wall column (col=2) on a 5x5 grid,
  // deliberately simple enough to hand-verify every distance and direction:
  //
  //   col:  0 1 2 3 4
  //         . . # . .
  //         . . # . .
  //         . . # . .   (every row identical — the wall runs the full height)
  //         . . # . .
  //         . . # . .
  {
    const cols = 5;
    const rows = 5;
    const solid = new Uint8Array(cols * rows);
    for (let row = 0; row < rows; row++) solid[idxOf(cols, 2, row)] = 1;

    const distance = distanceFromNearestSolid(solid, cols, rows);
    ok('distanceFromNearestSolid: a solid cell reads 0', distance[idxOf(cols, 2, 2)] === 0);
    ok(
      'distanceFromNearestSolid: one cell either side of the wall reads 1',
      distance[idxOf(cols, 1, 2)] === 1 && distance[idxOf(cols, 3, 2)] === 1
    );
    ok(
      'distanceFromNearestSolid: two cells either side reads 2 (the grid edge, furthest from the wall)',
      distance[idxOf(cols, 0, 2)] === 2 && distance[idxOf(cols, 4, 2)] === 2
    );

    const { dirX, dirY } = wallAvoidanceDirectionFromDistance(distance, cols, rows);
    ok(
      'wallAvoidanceDirectionFromDistance: just LEFT of the wall, "away" points further left (-X)',
      dirX[idxOf(cols, 1, 2)] < -0.9 && Math.abs(dirY[idxOf(cols, 1, 2)]) < 1e-6
    );
    ok(
      'wallAvoidanceDirectionFromDistance: just RIGHT of the wall, "away" points further right (+X)',
      dirX[idxOf(cols, 3, 2)] > 0.9 && Math.abs(dirY[idxOf(cols, 3, 2)]) < 1e-6
    );
    ok(
      'wallAvoidanceDirectionFromDistance: every direction returned is unit length (or exactly zero)',
      Array.from({ length: cols * rows }, (_, i) => Math.hypot(dirX[i], dirY[i])).every(
        (len) => len < 1e-6 || Math.abs(len - 1) < 1e-5
      )
    );

    const proximity = wallProximityFromDistance(distance, { reachCells: 2 });
    ok('wallProximityFromDistance: AT a wall (distance 0) reads full strength (1)', proximity[idxOf(cols, 2, 2)] === 1);
    ok(
      'wallProximityFromDistance: one cell away (of a 2-cell reach) reads the EASED midpoint (0.25 = 0.5², ' +
        'not the linear 0.5 — 2026-07-23, softened per author feedback: "not so binary... a softer effect")',
      Math.abs(proximity[idxOf(cols, 1, 2)] - 0.25) < 1e-6
    );
    ok('wallProximityFromDistance: exactly AT the reach limit fades fully to 0', proximity[idxOf(cols, 0, 2)] === 0);
    // The eased curve must still be MONOTONIC (strictly non-increasing as
    // distance grows) and stay within [0,1] — a wider fixture (reachCells=8,
    // several fractional steps) than the reachCells=2 one above, which only
    // has a single interior sample point.
    {
      const wideProximity = wallProximityFromDistance(distance, { reachCells: 8 });
      const samples = [0, 1, 2].map((d) => wideProximity[idxOf(cols, 2 - d, 2)]); // walking away from the wall at col=2
      ok(
        'wallProximityFromDistance: the eased curve is monotonically non-increasing with distance',
        samples[0] >= samples[1] && samples[1] >= samples[2]
      );
      ok(
        'wallProximityFromDistance: every value stays within [0,1]',
        Array.from(wideProximity).every((v) => v >= 0 && v <= 1)
      );
      // d=1 of reach=8: linear = 1-1/8 = 0.875; eased = 0.875² = 0.765625.
      ok(
        'wallProximityFromDistance: the eased value is the SQUARE of the linear falloff, not the linear value itself',
        Math.abs(samples[1] - 0.765625) < 1e-6
      );
    }

    // Degenerate inputs never throw.
    ok(
      'distanceFromNearestSolid: a zero-size grid returns an empty array',
      distanceFromNearestSolid(solid, 0, 0).length === 0
    );
    const noWalls = new Uint8Array(cols * rows);
    const noWallDist = distanceFromNearestSolid(noWalls, cols, rows);
    ok(
      'distanceFromNearestSolid: a map with NO solid cells at all reads -1 everywhere',
      Array.from(noWallDist).every((d) => d === -1)
    );
    const { dirX: flatX, dirY: flatY } = wallAvoidanceDirectionFromDistance(noWallDist, cols, rows);
    ok(
      'wallAvoidanceDirectionFromDistance: with no walls anywhere, direction is (0,0) everywhere — never a cliff',
      Array.from(flatX).every((v) => v === 0) && Array.from(flatY).every((v) => v === 0)
    );
    const flatProximity = wallProximityFromDistance(noWallDist);
    ok(
      'wallProximityFromDistance: with no walls anywhere, proximity is 0 everywhere — a guaranteed no-op',
      Array.from(flatProximity).every((v) => v === 0)
    );
    ok(
      'wallAvoidanceDirectionFromDistance: mismatched-length distance array never throws, returns zeros',
      wallAvoidanceDirectionFromDistance(new Int32Array(3), cols, rows).dirX.every((v) => v === 0)
    );
  }

  // --- cropGridMargin + THE MAP-EDGE WALL-CLIPPING BUG IT FIXES --------------
  // (2026-07-23, author: "a building, fully enclosed with walls, sits right
  // on the edge of the map... wind just starts inside the building.")
  // `rasterizeWallsToGrid`'s own `mark()` silently drops any col/row outside
  // `[0,cols)×[0,rows)` — so a wall whose true position sits just OUTSIDE a
  // grid tightly bound to the scene rect gets THAT PORTION completely
  // unrasterized, not merely nicked at a corner. This reproduces that exact
  // mechanism end to end, then proves padding + `cropGridMargin` fixes it.
  {
    const cellSize = 10;
    const trueCols = 6;
    const trueRows = 6;
    // A box whose TOP/LEFT walls sit at world x=-2/y=-2 — just outside a
    // grid whose own minX/minY is 0 (col/row -1, always dropped).
    const boxWalls = [
      { solid: true, x1: -2, y1: -2, x2: 58, y2: -2 }, // top
      { solid: true, x1: -2, y1: 58, x2: 58, y2: 58 }, // bottom
      { solid: true, x1: -2, y1: -2, x2: -2, y2: 58 }, // left
      { solid: true, x1: 58, y1: -2, x2: 58, y2: 58 }, // right
    ];
    const interiorIdx = idxOf(trueCols, 3, 3); // world (35,35) — well inside the box either way

    // WITHOUT padding: top/left walls clip off the tight grid entirely —
    // THE BUG, reproduced.
    const tightSolid = rasterizeWallsToGrid(
      boxWalls,
      { minX: 0, minY: 0, cols: trueCols, rows: trueRows, cellSize },
      { superCover: false }
    );
    const tightOpen = floodFillOpenFromBoundary(tightSolid, trueCols, trueRows);
    ok(
      'THE BUG, reproduced: a box whose walls clip off a tight edge-bound grid leaks — interior reads open',
      tightOpen[interiorIdx] === 1
    );

    // WITH a padded grid: the SAME walls now rasterize fully (their true
    // position is comfortably inside the padded grid's own bounds) — THE FIX.
    const margin = 3;
    const paddedCols = trueCols + margin * 2;
    const paddedRows = trueRows + margin * 2;
    const paddedSolid = rasterizeWallsToGrid(
      boxWalls,
      { minX: -margin * cellSize, minY: -margin * cellSize, cols: paddedCols, rows: paddedRows, cellSize },
      { superCover: false }
    );
    const paddedOpen = floodFillOpenFromBoundary(paddedSolid, paddedCols, paddedRows);
    const croppedOpen = cropGridMargin(paddedOpen, paddedCols, paddedRows, margin);
    ok('cropGridMargin: output is exactly the true-grid size', croppedOpen.length === trueCols * trueRows);
    ok(
      'THE FIX: with padding, the SAME box walls rasterize fully and the interior correctly reads sealed',
      croppedOpen[interiorIdx] === 0
    );
  }

  // --- cropGridMargin, mechanical correctness ---------------------------------
  {
    // A 4x4 padded grid, margin=1, cropping to the inner 2x2. Value = row*4+col
    // so each cropped cell's own value proves EXACTLY which source cell it
    // came from, not just that some value survived.
    const padded = new Uint8Array(16);
    for (let i = 0; i < 16; i++) padded[i] = i;
    const cropped = cropGridMargin(padded, 4, 4, 1);
    ok('cropGridMargin: correct output length', cropped.length === 4);
    ok("cropGridMargin: top-left inner cell is the padded grid's own (1,1)", cropped[0] === 1 * 4 + 1);
    ok("cropGridMargin: bottom-right inner cell is the padded grid's own (2,2)", cropped[3] === 2 * 4 + 2);
    ok(
      'cropGridMargin: zero margin is a no-op copy',
      Array.from(cropGridMargin(padded, 4, 4, 0)).every((v, i) => v === padded[i])
    );
    ok('cropGridMargin: margin covering the whole grid returns empty', cropGridMargin(padded, 4, 4, 2).length === 0);
    ok(
      'cropGridMargin: preserves the input array TYPE (Float32Array in, Float32Array out)',
      cropGridMargin(new Float32Array(16), 4, 4, 1) instanceof Float32Array
    );
    ok(
      'cropGridMargin: mismatched-length input falls back to all-zero, never throws',
      Array.from(cropGridMargin(new Uint8Array(5), 4, 4, 1)).every((v) => v === 0)
    );
  }
}
