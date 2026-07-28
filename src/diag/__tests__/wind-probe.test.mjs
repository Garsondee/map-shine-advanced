/**
 * wind-probe.test.mjs — the click-to-probe wind+particle inspector's pure
 * decomposition math. 100% pure (no THREE, no GPU); mirrors
 * `world/__tests__/wind-bake.test.mjs`'s own hand-built-grid fixture style.
 *
 * 2026-07-22, THE RETHINK (docs/planning/Wind-Rethink.md) — `decomposeWindAt`
 * now reports a SINGLE geometry-derived `openness` grid instead of the
 * wall-relaxation/exposure/door-chaos/windReach tangle these tests used to
 * exercise separately.
 */
import {
  describeWindBake,
  nearestCell,
  nearestSolidDistanceCells,
  decomposeWindAt,
  findNearestParticles,
  summarizeNearestParticles,
} from '../wind-probe.js';
import { ambientVectorFromWind } from '../../world/wind-bake.js';
import { floodFillOpenFromBoundary } from '../../world/wind-enclosure.js';

function approx(a, b, eps = 1e-4) {
  return Math.abs(a - b) <= eps;
}

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // describeWindBake — the antidote to a button that lied for months
  // ======================================================================
  // "Rebake wind structure" formatted its note from `result.exposure.min/.max/
  // .varies`, fields bakeWindField stopped returning when the Wind rethink
  // deleted the exposure machinery. undefined is falsy, so EVERY click took the
  // failure branch and printed a confident diagnosis about the outdoors mask —
  // a mask wind no longer consults at all. These assertions are pinned to the
  // bake's REAL return shape so the next shape change goes red here instead.
  {
    const real = {
      ok: true,
      reason: 'walls changed',
      cols: 64,
      rows: 48,
      levelId: 'ground',
      wallCount: 120,
      totalWallCount: 300,
      solidCells: 400,
      openCells: 2200,
      enclosedCells: 472,
      enclosedPct: 15,
    };
    const line = describeWindBake(real);
    ok('it reports the grid it actually baked', line.includes('64x48 cells'));
    ok('it reports scoped/total walls without implying a fault', line.includes('120/300 wall segments'));
    ok('it reports the enclosure counts', line.includes('2200 open to the exterior'));
    ok('it reports the sealed percentage', line.includes('472 sealed (15%)'));
    ok('it names the trigger', line.includes('walls changed'));

    // THE REGRESSION ITSELF: nothing in a healthy bake may read as a failure.
    ok('a healthy bake never claims something is wrong', !/DOES NOT VARY|wrong floor|not yet streamed/i.test(line));
    ok('it never prints the word undefined', !line.includes('undefined'));

    // A field that is genuinely gone is OMITTED, never inferred as a fault —
    // exactly the mistake the old note made.
    const partial = describeWindBake({ ok: true, reason: 'scene load', cols: 8, rows: 8 });
    ok('missing counts are simply absent', !partial.includes('undefined') && partial.includes('8x8 cells'));
    ok(
      'a bake with no counts at all says so plainly',
      describeWindBake({ ok: true, reason: 'x' }).includes('no cell counts')
    );

    // The one reading that IS actionable.
    ok('a fully sealed floor is called out', describeWindBake({ ...real, openCells: 0 }).includes('reaches nowhere'));

    ok(
      'a failed bake reports the failure, not a grid',
      describeWindBake({ ok: false, reason: 'no viewer', error: 'boom' }).includes('boom')
    );
    ok('no result at all does not throw', describeWindBake(null).length > 0);
    ok('a non-object does not throw', describeWindBake('nope').length > 0);
  }

  // --- nearestCell — the SAME formula the particle kernel uses -------------
  {
    const grid = { originX: 0, originY: 0, cellSize: 10, cols: 5, rows: 5 };
    ok(
      'nearestCell finds (0,0) at the grid origin',
      (() => {
        const c = nearestCell(0, 0, grid);
        return c.col === 0 && c.row === 0 && c.index === 0;
      })()
    );
    ok(
      'nearestCell floors within a cell (not rounds)',
      (() => {
        const c = nearestCell(19, 5, grid); // col 1 spans [10,20)
        return c.col === 1 && c.row === 0;
      })()
    );
    ok(
      'nearestCell clamps a position past the grid edge to the last cell, never out of bounds',
      (() => {
        const c = nearestCell(999, 999, grid);
        return c.col === 4 && c.row === 4;
      })()
    );
    ok(
      'nearestCell clamps a NEGATIVE position to the first cell',
      (() => {
        const c = nearestCell(-50, -50, grid);
        return c.col === 0 && c.row === 0;
      })()
    );
    ok('nearestCell returns null for a degenerate (zero-size) grid', nearestCell(0, 0, { cols: 0, rows: 0 }) === null);
  }

  // --- nearestSolidDistanceCells --------------------------------------------
  {
    const cols = 10;
    const rows = 10;
    const solid = new Uint8Array(cols * rows);
    solid[5 * cols + 5] = 1; // one solid cell at (5,5)
    ok(
      'a cell exactly 1 away from the only solid cell reports distance 1',
      nearestSolidDistanceCells({ col: 4, row: 5 }, solid, cols, rows) === 1
    );
    ok(
      'a cell far outside the search radius reports null (never Infinity, never a false 0)',
      nearestSolidDistanceCells({ col: 0, row: 0 }, solid, cols, rows, 3) === null
    );
    ok(
      'widening the search radius finds the same solid cell from further away',
      nearestSolidDistanceCells({ col: 0, row: 0 }, solid, cols, rows, 8) !== null
    );
  }

  // --- decomposeWindAt — the full ground-truth breakdown --------------------
  {
    const cols = 10;
    const rows = 10;
    // A full-height wall at column 6 with a 2-row gap at the bottom.
    const solid = new Uint8Array(cols * rows);
    for (let row = 0; row < rows - 2; row++) solid[row * cols + 6] = 1;
    const ambient = ambientVectorFromWind({ directionDeg: 180, speed01: 1 }); // "West" -> flow toward +X
    const open = floodFillOpenFromBoundary(solid, cols, rows);
    const gridSpec = { originX: 0, originY: 0, cellSize: 10, cols, rows };
    const openness = { solid, openness: open, ...gridSpec };

    // A cell directly upstream of the unbroken wall section (col 5, row 3) —
    // on the SAME connected side as the gap (rows 8-9) -> openness 1.
    const atOpen = decomposeWindAt({ x: 55, y: 35, ambientX: ambient.x, ambientY: ambient.y, openness });
    ok(
      'decomposeWindAt resolves the correct cell for a world position',
      atOpen.cell.col === 5 && atOpen.cell.row === 3
    );
    ok('decomposeWindAt reports solid:false for an open cell', atOpen.solid === false);
    ok('an open, connected cell reads openness 1', atOpen.openness === 1);
    ok(
      'coherentTotal = ambientBias × openness exactly (openness=1 here, so it equals ambientBias)',
      approx(atOpen.coherentTotal.x, atOpen.ambientBias.x) && approx(atOpen.coherentTotal.y, atOpen.ambientBias.y)
    );
    ok('nearestSolidDistanceCells is small right next to the wall', atOpen.nearestSolidDistanceCells <= 2);

    // A cell ON a solid wall segment.
    const onWall = decomposeWindAt({ x: 65, y: 35, ambientX: ambient.x, ambientY: ambient.y, openness }); // col 6, row 3
    ok('decomposeWindAt reports solid:true for a wall cell', onWall.solid === true);

    // paintedExposure is reference-only — present in the report, never folded
    // into coherentTotal, even when it flatly contradicts openness.
    const withPainted = decomposeWindAt({
      x: 55,
      y: 35,
      ambientX: ambient.x,
      ambientY: ambient.y,
      openness,
      paintedExposure: 0.1, // deliberately LOW, contradicting openness=1
    });
    ok(
      'paintedExposureForReference reports the supplied value verbatim',
      withPainted.paintedExposureForReference === 0.1
    );
    ok(
      'paintedExposure does NOT influence coherentTotal even when it disagrees with openness',
      approx(withPainted.coherentTotal.x, atOpen.coherentTotal.x) &&
        approx(withPainted.coherentTotal.y, atOpen.coherentTotal.y)
    );
    ok('paintedExposureForReference reports null when not supplied', atOpen.paintedExposureForReference === null);

    // Degenerate openness grid (no bake yet) -> ok:false, never a throw.
    const noGrid = decomposeWindAt({ x: 0, y: 0, openness: { cols: 0, rows: 0 } });
    ok('decomposeWindAt reports ok:false (not a throw) when the openness grid is degenerate', noGrid.ok === false);
  }

  // --- ENCLOSED-ROOM cross-check + DOOR-RESPONSIVENESS — the actual bug
  // --- this tool exists to find, and the exact property the rethink fixed.
  {
    // A small sealed room (rows/cols 2..4) inside a 7x7 grid, no gaps.
    const cols = 7;
    const rows = 7;
    const solid = new Uint8Array(cols * rows);
    for (let col = 1; col <= 5; col++) {
      solid[1 * cols + col] = 1;
      solid[5 * cols + col] = 1;
    }
    for (let row = 1; row <= 5; row++) {
      solid[row * cols + 1] = 1;
      solid[row * cols + 5] = 1;
    }
    const ambient = ambientVectorFromWind({ directionDeg: 180, speed01: 1 });
    const open = floodFillOpenFromBoundary(solid, cols, rows);
    const openness = { solid, openness: open, originX: 0, originY: 0, cellSize: 10, cols, rows };

    const insideSealedRoom = decomposeWindAt({ x: 35, y: 35, ambientX: ambient.x, ambientY: ambient.y, openness }); // cell (3,3), room centre
    ok('decomposeWindAt reports openness 0 for a cell inside a fully sealed room', insideSealedRoom.openness === 0);
    ok(
      'a sealed room reads coherentTotal exactly {0,0} REGARDLESS of ambient strength — the whole point of the rethink',
      insideSealedRoom.coherentTotal.x === 0 &&
        insideSealedRoom.coherentTotal.y === 0 &&
        insideSealedRoom.coherentTotal.mag === 0
    );

    // NOW open a gap in the SAME ring and rebuild the openness grid — the
    // SAME room must flip to openness 1 in one rebake, no residual state.
    const solidWithGap = Uint8Array.from(solid);
    solidWithGap[5 * cols + 3] = 0; // punch a doorway in the bottom wall
    const openWithGap = floodFillOpenFromBoundary(solidWithGap, cols, rows);
    const opennessWithGap = {
      solid: solidWithGap,
      openness: openWithGap,
      originX: 0,
      originY: 0,
      cellSize: 10,
      cols,
      rows,
    };
    const afterDoorOpens = decomposeWindAt({
      x: 35,
      y: 35,
      ambientX: ambient.x,
      ambientY: ambient.y,
      openness: opennessWithGap,
    });
    ok('opening a door in the SAME sealed room flips it to openness 1 in one rebake', afterDoorOpens.openness === 1);
    ok(
      "the SAME room's coherentTotal now equals the full ambient — no more phantom cancellation math to get wrong",
      approx(afterDoorOpens.coherentTotal.x, ambient.x) && approx(afterDoorOpens.coherentTotal.y, ambient.y)
    );
  }

  // --- findNearestParticles --------------------------------------------------
  {
    const particles = [
      { i: 0, pos: [0, 0], vel: [10, 0] },
      { i: 1, pos: [100, 0], vel: [5, 5] },
      { i: 2, pos: [5, 0], vel: [-10, 0] },
      { i: 3, pos: [NaN, 5], vel: [1, 1] }, // malformed — must be skipped, not crash
    ];
    const nearest = findNearestParticles({ particles, queryX: 0, queryY: 0, maxResults: 2 });
    ok(
      'findNearestParticles returns the closest N, nearest first',
      nearest.length === 2 && nearest[0].i === 0 && nearest[1].i === 2
    );
    ok(
      'findNearestParticles stamps a distancePx on each result',
      nearest[0].distancePx === 0 && nearest[1].distancePx === 5
    );
    ok('findNearestParticles silently skips malformed entries (NaN position), never crashes', true); // no throw above proves it

    const capped = findNearestParticles({ particles, queryX: 0, queryY: 0, maxDistancePx: 6 });
    ok(
      'maxDistancePx excludes anything farther than the cap',
      capped.length === 2 && capped.every((p) => p.distancePx <= 6)
    );
  }

  // --- summarizeNearestParticles ---------------------------------------------
  {
    ok(
      'summarizeNearestParticles returns null for an empty selection (never a fake zero-filled summary)',
      summarizeNearestParticles([]) === null
    );

    const uniform = [
      { vel: [10, 0], openness: 0.9 },
      { vel: [10, 0], openness: 0.8 },
    ];
    const uniformSummary = summarizeNearestParticles(uniform);
    ok(
      'uniform velocities summarize to alignment ~1 (all pointing the same way)',
      approx(uniformSummary.directionAlignment, 1, 0.01)
    );
    ok('meanSpeed is the plain average magnitude', approx(uniformSummary.meanSpeed, 10));
    ok('meanOpenness averages the supplied openness values', approx(uniformSummary.meanOpenness, 0.85));

    const scattered = [{ vel: [10, 0] }, { vel: [-10, 0] }, { vel: [0, 10] }, { vel: [0, -10] }];
    const scatteredSummary = summarizeNearestParticles(scattered);
    ok(
      'four opposing/perpendicular velocities summarize to alignment ~0 (a genuinely varied field)',
      scatteredSummary.directionAlignment < 0.1
    );

    const stillOnly = [{ vel: [0, 0] }, { vel: [0.001, 0] }];
    const stillSummary = summarizeNearestParticles(stillOnly);
    ok(
      'a population with no meaningfully-moving particle reports a null direction (not a fake 0°)',
      stillSummary.meanDirectionDeg === null && stillSummary.directionAlignment === null
    );
  }
}
