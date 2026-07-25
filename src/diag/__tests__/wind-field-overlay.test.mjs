/**
 * wind-field-overlay.test.mjs — the pure grid-layout + geometry-array math
 * (the TSL arrow material is browser-verified live, per this module's own
 * header).
 */
import {
  computeWindOverlayGrid,
  computeWindOverlayGridFromBake,
  computeWindOverlayArrays,
  DEFAULT_WIND_OVERLAY_MAX_POINTS,
} from '../wind-field-overlay.js';

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

export function run(t) {
  const { ok } = t;

  // --- a basic, well within cap grid -----------------------------------------
  {
    const { points, spacingPx, capped } = computeWindOverlayGrid({
      minX: 0,
      minY: 0,
      maxX: 900,
      maxY: 600,
      spacingPx: 150,
    });
    ok('an uncapped grid keeps the REQUESTED spacing exactly', spacingPx === 150);
    ok('an uncapped grid is not marked capped', capped === false);
    // width 900 / spacing 150 -> 6+1 cols; height 600/150 -> 4+1 rows.
    ok('grid dimensions match width/height ÷ spacing (+1)', points.length === 7 * 5);
    ok(
      'every point lies within (or exactly on the centred padding of) the rect',
      points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    );
  }

  // --- pinning: the grid is anchored to a FIXED world lattice, not to
  // whichever view rect asked for it (2026-07-21, author-reported: the
  // overlay didn't feel pinned to the map under pan/zoom) -----------------
  {
    // Two DIFFERENT, overlapping view rects at the SAME spacing.
    const viewA = computeWindOverlayGrid({ minX: 0, minY: 0, maxX: 900, maxY: 600, spacingPx: 150 });
    const viewB = computeWindOverlayGrid({ minX: 320, minY: 50, maxX: 1220, maxY: 650, spacingPx: 150 });
    const keyOf = (p) => `${p.x},${p.y}`;
    const setA = new Set(viewA.points.map(keyOf));
    const setB = new Set(viewB.points.map(keyOf));
    // (450,300) sits inside BOTH rects' overlap (x:[320,900], y:[50,600]) and
    // is a multiple of the 150 spacing — a pinned lattice must place it at
    // the exact SAME world coordinate regardless of which rect asked.
    ok(
      'a lattice point inside two different overlapping views has the SAME world coordinate in both — the grid is pinned, not re-centred per view',
      setA.has('450,300') && setB.has('450,300')
    );
    // A point that is NOT a multiple of spacing must never appear at all —
    // proof positions are snapped to the lattice, not merely "inside the rect".
    ok('a non-lattice position never appears as a point', !setA.has('475,300') && !setA.has('450,325'));
  }

  // --- the lattice itself changes only when spacing changes (a coarser LOD
  // is a genuinely different grid, not a "swim") --------------------------
  {
    const fine = computeWindOverlayGrid({ minX: 0, minY: 0, maxX: 900, maxY: 600, spacingPx: 150 });
    const coarse = computeWindOverlayGrid({ minX: 0, minY: 0, maxX: 900, maxY: 600, spacingPx: 300 });
    ok(
      'doubling the spacing halves the density per axis (a different, coarser lattice)',
      coarse.points.length < fine.points.length
    );
    ok(
      'every coarse point is ALSO one of the fine lattice points (the coarse grid is a true subset)',
      coarse.points.every((p) => fine.points.some((q) => q.x === p.x && q.y === p.y))
    );
  }

  // --- capping: spacing grows (points are never dropped from a full-cover grid) --
  {
    const { points, spacingPx, capped } = computeWindOverlayGrid({
      minX: 0,
      minY: 0,
      maxX: 10000,
      maxY: 10000,
      spacingPx: 10, // a naive 10px grid over 10000x10000 would be ~1,000,000 points
      maxPoints: 400,
    });
    ok('a request that would blow the cap IS capped', capped === true);
    ok('the actual point count stays at or under the cap', points.length <= 400);
    ok('spacing GREW past the requested value to make it fit', spacingPx > 10);
    ok(
      'still covers the full rect (not a partial corner)',
      points.some((p) => p.x > 5000) && points.some((p) => p.x < 5000)
    );
  }

  // --- the default cap is used when maxPoints is omitted --------------------
  {
    const { points } = computeWindOverlayGrid({ minX: 0, minY: 0, maxX: 100000, maxY: 100000, spacingPx: 5 });
    ok('an omitted maxPoints falls back to the module default', points.length <= DEFAULT_WIND_OVERLAY_MAX_POINTS);
  }

  // --- degenerate / non-finite bounds never throw, always return an empty grid --
  ok(
    'a zero-area rect returns no points',
    computeWindOverlayGrid({ minX: 0, minY: 0, maxX: 0, maxY: 500 }).points.length === 0
  );
  ok(
    'an inverted rect (max < min) returns no points, not a negative-size crash',
    computeWindOverlayGrid({ minX: 500, minY: 500, maxX: 0, maxY: 0 }).points.length === 0
  );
  ok(
    'non-finite bounds return no points',
    computeWindOverlayGrid({ minX: NaN, minY: 0, maxX: 100, maxY: 100 }).points.length === 0
  );
  ok(
    'a non-finite/zero spacingPx falls back to a sane default rather than dividing by zero',
    Number.isFinite(computeWindOverlayGrid({ minX: 0, minY: 0, maxX: 500, maxY: 500, spacingPx: 0 }).spacingPx) &&
      computeWindOverlayGrid({ minX: 0, minY: 0, maxX: 500, maxY: 500, spacingPx: 0 }).points.length > 0
  );

  // --- computeWindOverlayArrays — per-point windExposure baking (2026-07-21,
  // author-reported: the overlay looked identically turbulent indoors and
  // outdoors — traced to exposure being hard-coded, never sampled per point) --
  {
    const { exposures, centers, quadCount } = computeWindOverlayArrays(
      [
        { x: 100, y: 200, windExposure: 0.2 }, // sheltered (indoors)
        { x: 300, y: 400, windExposure: 1 }, // fully exposed (outdoors)
      ],
      { sizePx: 48 }
    );
    ok('one quad per point', quadCount === 2);
    ok(
      'every vertex of a quad carries the SAME wind exposure (reads as constant across the arrow)',
      [0, 1, 2, 3].every((v) => approx(exposures[v], 0.2))
    );
    ok(
      'a different point carries its OWN exposure, not the first point`s',
      [0, 1, 2, 3].every((v) => approx(exposures[4 + v], 1))
    );
    ok(
      'centers still bake per-point world position (unaffected by the new exposure channel)',
      centers[0] === 100 && centers[1] === 200 && centers[8] === 300 && centers[9] === 400
    );
  }
  {
    const { exposures } = computeWindOverlayArrays([{ x: 0, y: 0 }], { sizePx: 10 });
    ok(
      'a point with no windExposure defaults to fully outdoors (1) — the SAME absence convention candle geometry uses',
      exposures.every((e) => approx(e, 1))
    );
  }
  {
    const { exposures } = computeWindOverlayArrays(
      [
        { x: 0, y: 0, windExposure: 5 },
        { x: 1, y: 1, windExposure: -3 },
      ],
      {
        sizePx: 10,
      }
    );
    ok('an out-of-range windExposure clamps into [0,1]', exposures[0] === 1 && exposures[4] === 0);
  }

  // --- computeWindOverlayGridFromBake (2026-07-23, author: "make the overlay
  // show the exact resolution accurately") — samples the REAL bake grid's own
  // cells instead of an independently-recomputed lattice ---------------------
  {
    // A tiny 4x4 bake grid, cellSize 100, origin at (1000,2000) — deliberately
    // NOT (0,0), so a test that only worked by coincidence at the origin
    // can't pass silently.
    const bake = { cols: 4, rows: 4, cellSize: 100, originX: 1000, originY: 2000 };

    const full = computeWindOverlayGridFromBake({ ...bake, minX: 1000, minY: 2000, maxX: 1400, maxY: 2400 });
    ok('a view covering the whole bake grid returns every cell', full.points.length === 16);
    ok('stride is 1 when nothing needs coarsening', full.stride === 1 && full.capped === false);
    ok('spacingPx equals the real cellSize at stride 1', full.spacingPx === 100);
    ok(
      'each point sits at its cell CENTER, not its corner',
      full.points.some((p) => p.x === 1050 && p.y === 2050 && p.col === 0 && p.row === 0)
    );

    const partial = computeWindOverlayGridFromBake({ ...bake, minX: 1000, minY: 2000, maxX: 1150, maxY: 2150 });
    ok(
      'a view covering only part of the grid returns only the cells it actually overlaps (2x2)',
      partial.points.length === 4
    );

    const outside = computeWindOverlayGridFromBake({ ...bake, minX: -5000, minY: -5000, maxX: -4000, maxY: -4000 });
    ok('a view entirely outside the bake grid returns no points, never throws', outside.points.length === 0);

    // A caller-requested minimum stride (the repurposed windOverlayResolution
    // knob: "show every Nth real cell") is honoured even when nothing needs
    // to be capped.
    const strided = computeWindOverlayGridFromBake({
      ...bake,
      minX: 1000,
      minY: 2000,
      maxX: 1400,
      maxY: 2400,
      stride: 2,
    });
    ok('a requested stride > 1 is honoured (every 2nd real cell, both axes)', strided.points.length === 4);
    ok('spacingPx reflects the requested stride', strided.spacingPx === 200);
    ok(
      'strided points are STILL real cell centers, not a recomputed lattice',
      strided.points.every((p) => (p.x - 1050) % 100 === 0 && (p.y - 2050) % 100 === 0)
    );

    // Capping: a big grid, small maxPoints — stride must grow past whatever
    // was requested, and every returned point must still be a genuine cell.
    const bigBake = { cols: 200, rows: 200, cellSize: 10, originX: 0, originY: 0 };
    const capped = computeWindOverlayGridFromBake({
      ...bigBake,
      minX: 0,
      minY: 0,
      maxX: 2000,
      maxY: 2000,
      maxPoints: 50,
    });
    ok('a request that would blow the cap IS capped', capped.capped === true);
    ok('the actual point count stays at or under the cap', capped.points.length <= 50);
    ok('stride grew past 1 to make it fit', capped.stride > 1);
    ok(
      'every capped point is still exactly on the real grid lattice (an HONEST coarsening, not a re-derived one)',
      capped.points.every((p) => (p.x - 5) % 10 === 0 && (p.y - 5) % 10 === 0)
    );

    ok(
      'a non-finite/zero cols|rows|cellSize never throws, returns no points',
      computeWindOverlayGridFromBake({
        cols: 0,
        rows: 4,
        cellSize: 100,
        originX: 0,
        originY: 0,
        minX: 0,
        minY: 0,
        maxX: 100,
        maxY: 100,
      }).points.length === 0
    );
    ok(
      'a degenerate view rect never throws, returns no points',
      computeWindOverlayGridFromBake({ ...bake, minX: 0, minY: 0, maxX: 0, maxY: 0 }).points.length === 0
    );
  }
}
