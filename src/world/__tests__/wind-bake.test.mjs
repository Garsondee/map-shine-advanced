/**
 * wind-bake.test.mjs — the geometry-only prep this file is now scoped to
 * (2026-07-22, THE RETHINK — docs/planning/Wind-Rethink.md): the wall
 * rasterization + the ambient angle convention. 100% pure (no THREE, no
 * Foundry), so the whole thing is Node-tested directly.
 */
import { ambientVectorFromWind, windFlowVector, computeWindBakeGridSpec, rasterizeWallsToGrid } from '../wind-bake.js';

function approx(a, b, eps = 1e-4) {
  return Math.abs(a - b) <= eps;
}

export function run(t) {
  const { ok } = t;

  // --- windFlowVector / ambientVectorFromWind — THE one angle convention -----
  // ⚠️ SETTLED 2026-09-04 BY THE AUTHOR (mythica-machina-press#487/#496, #497
  // Stage 0), REPLACING THE METEOROLOGICAL READING THIS SUITE USED TO PIN.
  // `directionDeg` is a COMPASS BEARING — 0° = north, clockwise — naming the
  // direction the wind blows TOWARD. Point the dial north, the air goes north.
  // In Y-DOWN world space (+X east, +Y south) that is `(sin θ, −cos θ)`, which
  // is byte-identical to the compass widget's own needle trig, deliberately:
  // the needle a GM drags and the direction the air travels are now one
  // formula, so the dial cannot lie.
  {
    const north = ambientVectorFromWind({ directionDeg: 0, speed01: 1 });
    ok('a bearing of 0° (north) blows toward -Y, i.e. screen north', approx(north.x, 0) && approx(north.y, -1));
    const east = ambientVectorFromWind({ directionDeg: 90, speed01: 1 });
    ok('a bearing of 90° (east) blows toward +X', approx(east.x, 1) && approx(east.y, 0));
    const south = ambientVectorFromWind({ directionDeg: 180, speed01: 1 });
    ok('a bearing of 180° (south) blows toward +Y', approx(south.x, 0) && approx(south.y, 1));
    const west = ambientVectorFromWind({ directionDeg: 270, speed01: 1 });
    ok('a bearing of 270° (west) blows toward -X', approx(west.x, -1) && approx(west.y, 0));
    const half = ambientVectorFromWind({ directionDeg: 0, speed01: 0.5 });
    ok('speed01 scales the vector linearly', approx(half.y, -0.5));
    const defaulted = ambientVectorFromWind();
    ok('missing input defaults to a zero (windless) vector, never throws', defaulted.x === 0 && defaulted.y === 0);
    const negSpeed = ambientVectorFromWind({ directionDeg: 0, speed01: -5 });
    ok('a negative speed clamps to 0, never blows "backwards"', approx(negSpeed.y, 0));
  }

  // --- the unit-vector helper every consumer resolves through ----------------
  // ⭐ THE POINT OF THIS BLOCK is that there is exactly ONE implementation. The
  // codebase previously held THREE readings of `directionDeg` at once (this
  // file's, the compass dial's, and precipitation's), a constant 90° apart in
  // one case and 180° in the other, with a hand-derived `−90` patch in
  // `effects/precipitation/squall-field.js` bridging the gap. If a future
  // change rotates this helper, every wind-driven effect rotates together —
  // which is the property that was actually missing.
  {
    ok(
      'the flow vector is unit length at every angle',
      [0, 37, 90, 211, 359].every((d) => {
        const v = windFlowVector(d);
        return approx(Math.hypot(v.x, v.y), 1);
      })
    );
    // Turning the dial must turn the flow the SAME way and by the same amount —
    // the property whose absence produced "point wind north, they move east".
    const a = windFlowVector(0);
    const b = windFlowVector(90);
    ok('⭐ +90° of bearing rotates the flow by exactly +90°', approx(a.x * b.y - a.y * b.x, 1));
    ok('a non-finite angle yields a finite vector rather than NaN', Number.isFinite(windFlowVector(NaN).x));
  }

  // --- computeWindBakeGridSpec — the [64,256] resolution clamp --------------
  {
    const tiny = computeWindBakeGridSpec({
      sceneX: 0,
      sceneY: 0,
      sceneWidth: 1000,
      sceneHeight: 800,
      gridSizePixels: 100,
    });
    ok('a small scene is clamped UP to the 64-cell floor on its long axis', Math.max(tiny.cols, tiny.rows) >= 64);
    const huge = computeWindBakeGridSpec({
      sceneX: 0,
      sceneY: 0,
      sceneWidth: 40000,
      sceneHeight: 30000,
      gridSizePixels: 100,
    });
    ok('a huge scene is clamped DOWN to the 256-cell ceiling on its long axis', Math.max(huge.cols, huge.rows) <= 256);
    const rect = computeWindBakeGridSpec({
      sceneX: 0,
      sceneY: 0,
      sceneWidth: 2000,
      sceneHeight: 1000,
      gridSizePixels: 100,
    });
    ok(
      'a non-square scene keeps SQUARE cells (same cellSize both axes), just fewer rows than cols',
      rect.cols > rect.rows
    );
    const originOffset = computeWindBakeGridSpec({
      sceneX: 250,
      sceneY: -50,
      sceneWidth: 1000,
      sceneHeight: 1000,
      gridSizePixels: 100,
    });
    ok(
      'the grid origin carries the scene rect origin through, not always (0,0)',
      originOffset.minX === 250 && originOffset.minY === -50
    );
    const degenerate = computeWindBakeGridSpec({ sceneWidth: NaN, sceneHeight: NaN, gridSizePixels: NaN });
    ok(
      'degenerate input falls back to sane defaults, never throws or produces 0 cells',
      degenerate.cols > 0 && degenerate.rows > 0
    );
  }

  // --- rasterizeWallsToGrid — conservative rasterization + the diagonal-leak guard --
  {
    const gridSpec = { minX: 0, minY: 0, cols: 10, rows: 10, cellSize: 10 };
    // A horizontal wall along the row-3 band, columns 2..6.
    const horiz = rasterizeWallsToGrid([{ x1: 25, y1: 35, x2: 65, y2: 35, solid: true }], gridSpec);
    ok('a horizontal wall marks the cells along its row', horiz[3 * 10 + 3] === 1 && horiz[3 * 10 + 5] === 1);
    ok('cells off the wall`s row stay open', horiz[0 * 10 + 3] === 0 && horiz[9 * 10 + 3] === 0);

    // A wall marked NOT solid (e.g. an open door) must mark NOTHING.
    const openDoor = rasterizeWallsToGrid([{ x1: 25, y1: 35, x2: 65, y2: 35, solid: false }], gridSpec);
    ok(
      'a non-solid segment (an open door) marks no cells at all',
      openDoor.every((v) => v === 0)
    );

    // A PURE DIAGONAL single-cell hop: from the centre of cell (0,0) to the
    // centre of cell (1,1) — a naive single-sample line could touch only
    // those two cells, leaving the (1,0)/(0,1) corner gap open; the
    // supercover guard must additionally fill at least one of the pair.
    const diagSpec = { minX: 0, minY: 0, cols: 4, rows: 4, cellSize: 10 };
    const diag = rasterizeWallsToGrid([{ x1: 5, y1: 5, x2: 15, y2: 15, solid: true }], diagSpec);
    const cornerFilled = diag[0 * 4 + 1] === 1 || diag[1 * 4 + 0] === 1;
    ok('the diagonal-leak guard fills at least one connecting corner cell (no diagonal-only gap)', cornerFilled);

    // superCover:false (the OPENNESS mask, 2026-07-22 THE RETHINK) — the
    // diagonal wall must NOT fill the connecting corner cells, so a
    // flood-fill can find a path through what the over-sealed default mask
    // would have blocked. The two on-line cells stay solid; the off-diagonal
    // corners stay OPEN.
    const diagNoSeal = rasterizeWallsToGrid([{ x1: 5, y1: 5, x2: 15, y2: 15, solid: true }], diagSpec, {
      superCover: false,
    });
    ok(
      'superCover:false leaves the diagonal corner cells OPEN (no over-seal — a path can thread through)',
      diagNoSeal[0 * 4 + 1] === 0 && diagNoSeal[1 * 4 + 0] === 0
    );
    ok(
      'superCover:false still marks the two ON-LINE cells solid (the wall itself is still there)',
      diagNoSeal[0 * 4 + 0] === 1 && diagNoSeal[1 * 4 + 1] === 1
    );

    // Out-of-bounds / degenerate segments never crash and never write outside the array.
    const oob = rasterizeWallsToGrid([{ x1: -500, y1: -500, x2: 5000, y2: 5000, solid: true }], gridSpec);
    ok('an out-of-bounds wall does not crash and stays within the grid array length', oob.length === 100);
    ok(
      'non-finite wall coordinates are skipped, not crashed on',
      rasterizeWallsToGrid([{ x1: NaN, y1: 0, x2: 10, y2: 10, solid: true }], gridSpec).every((v) => v === 0)
    );
    ok(
      'an empty wall list -> an all-open grid',
      rasterizeWallsToGrid([], gridSpec).every((v) => v === 0)
    );
  }
}
