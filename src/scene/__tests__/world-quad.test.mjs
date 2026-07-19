/**
 * Node verification for scene/world-quad.js — world-space geometry + the camera.
 *
 * THE ORIENTATION BLOCK IS THE POINT OF THIS FILE. Y-flip is a recurring bug
 * class in this project — a fresh instance, with a different mechanism, every
 * time a new world→screen or world→texture mapping appears, each one found live
 * by looking at an upside-down map. This module introduces exactly such a
 * mapping, so the orientation is asserted here, before a browser is involved.
 *
 * The chain that must hold, end to end:
 *   small world Y  →  screen TOP  →  image v=0  →  the image's TOP row
 * Break any link and the map is upside-down. Each link gets its own test.
 */
import {
  computeCameraFrustum,
  worldToNdc,
  ndcToWorld,
  clientToNdc,
  ndcToPixel,
  QUAD_UVS,
  QUAD_INDICES,
  buildQuadPositions,
  worldToQuadUv,
  computeTileSubPlacement,
  viewRectToImageRect,
  computeItemViewportPx,
  rectsOverlap,
} from '../world-quad.js';
import { computeQuadCorners, computeTilePlacement } from '../../foundry/scene-geometry.js';
import { planImageTiles } from '../../vt/texture-limits.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok, throws } = t;
  const view = { minX: 0, minY: 0, maxX: 1000, maxY: 500 };

  // --- THE CAMERA: the flip lives here and nowhere else --------------------
  {
    const f = computeCameraFrustum(view);
    ok('frustum: left/right are the plain world X range', f.left === 0 && f.right === 1000);
    // The inversion. If someone "fixes" this to top=maxY, the world renders
    // upside-down — this assertion is the tripwire.
    ok('frustum: top is minY and bottom is maxY (INVERTED — this IS the Y-flip)', f.top === 0 && f.bottom === 500);
  }

  // --- THE ORIENTATION CHAIN ----------------------------------------------
  {
    // Link 1: small world Y must land at the TOP of the screen (NDC +1).
    const top = worldToNdc({ x: 500, y: 0 }, view);
    ok('orientation: world minY -> NDC +1 (screen TOP)', near(top.y, 1));
    const bottom = worldToNdc({ x: 500, y: 500 }, view);
    ok('orientation: world maxY -> NDC -1 (screen BOTTOM)', near(bottom.y, -1));
    ok('orientation: mid-Y -> NDC 0', near(worldToNdc({ x: 500, y: 250 }, view).y, 0));
    // X is conventional.
    ok('orientation: world minX -> NDC -1 (screen LEFT)', near(worldToNdc({ x: 0, y: 250 }, view).x, -1));
    ok('orientation: world maxX -> NDC +1 (screen RIGHT)', near(worldToNdc({ x: 1000, y: 250 }, view).x, 1));
    // Y increasing must move DOWN the screen. This is the whole convention in
    // one assertion.
    ok(
      'orientation: increasing world Y moves DOWN the screen',
      worldToNdc({ x: 0, y: 100 }, view).y > worldToNdc({ x: 0, y: 400 }, view).y
    );
  }

  // --- Link 2 + 3: uv=(0,0) pairs with the minY corner, and v=0 is the top --
  {
    // An unrotated, default-anchored quad. computeQuadCorners returns corners in
    // (0,0),(1,0),(1,1),(0,1) order; QUAD_UVS must pair with that order such that
    // the uv=(0,0) corner is the one at the SMALLEST world Y.
    const placement = { x: 100, y: 100, width: 40, height: 20 };
    const corners = computeQuadCorners(placement);
    const uvOfCorner = (i) => ({ u: QUAD_UVS[i * 2], v: QUAD_UVS[i * 2 + 1] });

    const c0 = corners[0];
    const uv0 = uvOfCorner(0);
    ok('chain: corner[0] is uv (0,0)', uv0.u === 0 && uv0.v === 0);
    ok('chain: corner[0] is at the SMALLEST world Y (the top edge)', c0.y === 90 && c0.y < corners[3].y);
    // v=1 must be the LARGEST world Y.
    const uv3 = uvOfCorner(3);
    ok('chain: corner[3] is uv (0,1) and sits at the LARGEST world Y', uv3.v === 1 && corners[3].y === 110);
    // Therefore: the uv v=0 edge renders at the screen top.
    const topEdgeNdc = worldToNdc(c0, { minX: 0, minY: 0, maxX: 200, maxY: 200 });
    const bottomEdgeNdc = worldToNdc(corners[3], { minX: 0, minY: 0, maxX: 200, maxY: 200 });
    ok('chain: the v=0 edge lands ABOVE the v=1 edge on screen (NOT upside-down)', topEdgeNdc.y > bottomEdgeNdc.y);
  }

  // --- ndcToPixel: the pixel-readback diagnostic's own world→texel mapping,
  // same orientation discipline as the chain above (row 0 = screen top) -----
  {
    ok(
      'ndc (-1,+1) [top-left] -> pixel (0,0)',
      (() => {
        const p = ndcToPixel({ x: -1, y: 1 }, 200, 100);
        return p.x === 0 && p.y === 0;
      })()
    );
    ok(
      'ndc (+1,-1) [bottom-right] -> pixel (width-1,height-1)',
      (() => {
        const p = ndcToPixel({ x: 1, y: -1 }, 200, 100);
        return p.x === 199 && p.y === 99;
      })()
    );
    ok(
      'ndc (0,0) [centre] -> pixel (width/2,height/2)',
      (() => {
        const p = ndcToPixel({ x: 0, y: 0 }, 200, 100);
        return p.x === 100 && p.y === 50;
      })()
    );
    ok(
      'increasing NDC y (moving toward screen top) DECREASES pixel y (row 0 is the top row)',
      ndcToPixel({ x: 0, y: 0.8 }, 200, 100).y < ndcToPixel({ x: 0, y: -0.8 }, 200, 100).y
    );
    ok(
      'an off-screen NDC clamps into the target instead of going negative/overflowing',
      (() => {
        const p = ndcToPixel({ x: -3, y: 5 }, 200, 100);
        return p.x === 0 && p.y === 0;
      })()
    );
    ok(
      'an off-screen NDC clamps at the high end too',
      (() => {
        const p = ndcToPixel({ x: 3, y: -5 }, 200, 100);
        return p.x === 199 && p.y === 99;
      })()
    );
  }

  // --- ndcToWorld: the exact inverse of worldToNdc — the interactive pixel
  // probe's click→world chain, second half (clientToNdc is the first) -------
  {
    const rect = { minX: 100, minY: 200, maxX: 1100, maxY: 700 };
    // Round-trip: every corner and the centre must come back byte-identical
    // (within fp epsilon) after worldToNdc -> ndcToWorld. The cleanest
    // possible check for an algebraic inverse — no independent re-derivation
    // to get wrong.
    const points = [
      { x: 100, y: 200 },
      { x: 1100, y: 200 },
      { x: 1100, y: 700 },
      { x: 100, y: 700 },
      { x: 600, y: 450 },
      { x: 350, y: 625 },
    ];
    let mismatches = 0;
    for (const p of points) {
      const back = ndcToWorld(worldToNdc(p, rect), rect);
      if (!near(back.x, p.x) || !near(back.y, p.y)) mismatches++;
    }
    ok('ndcToWorld exactly inverts worldToNdc for every corner + interior point', mismatches === 0);
    ok(
      'ndcToWorld(-1,+1) [top-left NDC] -> the worldRect minX,minY corner',
      (() => {
        const p = ndcToWorld({ x: -1, y: 1 }, rect);
        return near(p.x, 100) && near(p.y, 200);
      })()
    );
    ok(
      'ndcToWorld(+1,-1) [bottom-right NDC] -> the worldRect maxX,maxY corner',
      (() => {
        const p = ndcToWorld({ x: 1, y: -1 }, rect);
        return near(p.x, 1100) && near(p.y, 700);
      })()
    );
  }

  // --- clientToNdc: viewport click coordinates -> NDC -----------------------
  {
    const rect = { left: 50, top: 20, width: 800, height: 500 };
    ok(
      'a click on the canvas top-left corner -> NDC (-1,+1)',
      (() => {
        const ndc = clientToNdc(50, 20, rect);
        return near(ndc.x, -1) && near(ndc.y, 1);
      })()
    );
    ok(
      'a click on the canvas bottom-right corner -> NDC (+1,-1)',
      (() => {
        const ndc = clientToNdc(850, 520, rect);
        return near(ndc.x, 1) && near(ndc.y, -1);
      })()
    );
    ok(
      'a click at the canvas centre -> NDC (0,0)',
      (() => {
        const ndc = clientToNdc(450, 270, rect);
        return near(ndc.x, 0) && near(ndc.y, 0);
      })()
    );
    ok(
      'a zero-size rect never divides by zero (reads as NDC 0,0 top-left-ish, never NaN)',
      (() => {
        const ndc = clientToNdc(10, 10, { left: 0, top: 0, width: 0, height: 0 });
        return Number.isFinite(ndc.x) && Number.isFinite(ndc.y);
      })()
    );
    // Full chain: a click through clientToNdc + ndcToWorld must land on the
    // SAME world point worldToNdc + the forward canvas math would place it —
    // i.e. clicking the canvas centre lands at the worldRect's own centre.
    {
      const worldRect = { minX: 5000, minY: 8000, maxX: 6000, maxY: 9000 };
      const world = ndcToWorld(clientToNdc(450, 270, rect), worldRect);
      ok('full click chain: canvas centre -> worldRect centre', near(world.x, 5500) && near(world.y, 8500));
    }
  }

  // --- quad buffers --------------------------------------------------------
  {
    const corners = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
      { x: 7, y: 8 },
    ];
    const pos = buildQuadPositions(corners);
    ok('positions: 12 floats (4 verts x xyz)', pos.length === 12);
    ok(
      'positions: xy from the corners, z flat at 0',
      pos[0] === 1 && pos[1] === 2 && pos[2] === 0 && pos[9] === 7 && pos[10] === 8
    );
    ok(
      "positions: every z is 0 (flat painter's-algorithm composite)",
      pos[2] === 0 && pos[5] === 0 && pos[8] === 0 && pos[11] === 0
    );
    throws('positions: rejects a non-quad', () => buildQuadPositions([{ x: 0, y: 0 }]), 'expected 4 corners');
    ok('uvs: 8 floats matching the corner order', QUAD_UVS.length === 8);
    ok('indices: two triangles sharing the 0-2 diagonal', QUAD_INDICES.join() === '0,1,2,0,2,3');
  }

  // --- worldToQuadUv: the exact inverse of computeQuadCorners --------------
  {
    // Round-trip against the forward transform for a nasty case: rotated, with an
    // off-centre anchor. If these two ever disagree, residency requests pages for
    // the wrong part of the image.
    let mismatches = 0;
    for (const rotation of [0, 30, 45, 90, 180, -37]) {
      for (const [anchorX, anchorY] of [
        [0.5, 0.5],
        [0, 0],
        [1, 0.25],
      ]) {
        const placement = { x: 500, y: 300, width: 200, height: 80, anchorX, anchorY, rotation };
        const corners = computeQuadCorners(placement);
        const expectUv = [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ];
        for (let i = 0; i < 4; i++) {
          const { u, v } = worldToQuadUv(corners[i], placement);
          if (!near(u, expectUv[i][0], 1e-9) || !near(v, expectUv[i][1], 1e-9)) mismatches++;
        }
      }
    }
    ok('worldToQuadUv: exactly inverts computeQuadCorners (18 placements x 4 corners)', mismatches === 0);
    // Centre maps to (0.5, 0.5).
    const centre = worldToQuadUv({ x: 100, y: 100 }, { x: 100, y: 100, width: 40, height: 20 });
    ok('worldToQuadUv: the anchor point maps to the anchor uv', near(centre.u, 0.5) && near(centre.v, 0.5));
    // Outside the quad -> outside [0,1], not clamped.
    const outside = worldToQuadUv({ x: 1000, y: 100 }, { x: 100, y: 100, width: 40, height: 20 });
    ok('worldToQuadUv: a point off the quad reports u > 1 (not clamped)', outside.u > 1);
  }

  // --- viewRectToImageRect -------------------------------------------------
  {
    // A 1000x1000 tile at the origin, backed by a 500x500 image (so image px are
    // 0.5 world px). The view covers the tile's top-left quadrant.
    const placement = { x: 0, y: 0, width: 1000, height: 1000, anchorX: 0, anchorY: 0, rotation: 0 };
    const imageSize = { width: 500, height: 500 };

    const full = viewRectToImageRect({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }, placement, imageSize);
    ok(
      'imageRect: a view covering the whole quad needs the whole image',
      near(full.minX, 0) && near(full.maxX, 500) && near(full.maxY, 500)
    );

    const quadrant = viewRectToImageRect({ minX: 0, minY: 0, maxX: 500, maxY: 500 }, placement, imageSize);
    ok(
      "imageRect: a view over the top-left quadrant needs the image's top-left quadrant",
      near(quadrant.maxX, 250) && near(quadrant.maxY, 250)
    );

    // Clamped to the image, never past it.
    const overshoot = viewRectToImageRect({ minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }, placement, imageSize);
    ok(
      'imageRect: a view larger than the quad clamps to the image bounds',
      near(overshoot.minX, 0) && near(overshoot.maxX, 500)
    );

    // Entirely off the quad -> null (nothing to stream).
    ok(
      'imageRect: a view that misses the quad entirely -> null',
      viewRectToImageRect({ minX: 5000, minY: 5000, maxX: 6000, maxY: 6000 }, placement, imageSize) === null
    );
    ok(
      'imageRect: a view just past the near edge -> null',
      viewRectToImageRect({ minX: -100, minY: -100, maxX: -1, maxY: -1 }, placement, imageSize) === null
    );
  }

  // --- viewRectToImageRect: rotation over-requests, never under-requests ---
  {
    // A 45-degree tile: the visible region is NOT axis-aligned in image space, so
    // the AABB of the projected corners is deliberately conservative. Requesting
    // a few extra pages costs pages; requesting too few is a visible hole.
    const placement = { x: 500, y: 500, width: 200, height: 200, anchorX: 0.5, anchorY: 0.5, rotation: 45 };
    const imageSize = { width: 100, height: 100 };
    const rect = viewRectToImageRect({ minX: 400, minY: 400, maxX: 600, maxY: 600 }, placement, imageSize);
    ok('imageRect: a rotated tile still resolves a usable rect', rect !== null);
    ok('imageRect: rotated -> conservative (covers the whole image here)', near(rect.minX, 0) && near(rect.maxX, 100));
  }

  // --- computeItemViewportPx: the O(tiles) trap ---------------------------
  {
    const canvas = { width: 1000, height: 1000 };
    // View spans 1000 world px across a 1000px canvas -> 1 screen px per world px.
    const v = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    ok(
      'viewportPx: a 100-world-px quad at 1:1 zoom occupies ~100 screen px',
      near(computeItemViewportPx(v, canvas, { width: 100, height: 100 }), 100)
    );
    // Zoom out 10x: the same quad is now 10 screen px, so it must serve a MUCH
    // coarser mip. Passing the canvas size here instead would claim it needs mip 0.
    const zoomedOut = { minX: 0, minY: 0, maxX: 10000, maxY: 10000 };
    ok(
      "viewportPx: zooming out 10x shrinks the quad's screen extent to ~10px",
      near(computeItemViewportPx(zoomedOut, canvas, { width: 100, height: 100 }), 10)
    );
    ok(
      'viewportPx: uses the LARGER axis (conservative -> sharper)',
      near(computeItemViewportPx(v, canvas, { width: 100, height: 400 }), 400)
    );
    ok(
      'viewportPx: never returns 0 (would divide by zero downstream)',
      computeItemViewportPx(v, canvas, { width: 0, height: 0 }) >= 1
    );
    // A degenerate view must not produce NaN/Infinity.
    ok(
      'viewportPx: a zero-span view is finite',
      Number.isFinite(computeItemViewportPx({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, canvas, { width: 10, height: 10 }))
    );
  }

  // --- rectsOverlap ---------------------------------------------------------
  {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    ok('overlap: intersecting', rectsOverlap(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 }));
    ok('overlap: disjoint in X', rectsOverlap(a, { minX: 20, minY: 0, maxX: 30, maxY: 10 }) === false);
    ok('overlap: disjoint in Y', rectsOverlap(a, { minX: 0, minY: 20, maxX: 10, maxY: 30 }) === false);
    ok('overlap: touching edges do not count', rectsOverlap(a, { minX: 10, minY: 0, maxX: 20, maxY: 10 }) === false);
    ok('overlap: fully contained', rectsOverlap(a, { minX: 2, minY: 2, maxX: 8, maxY: 8 }));
  }

  // --- END TO END: a real tile, placed and projected -----------------------
  {
    // A 200x100 tile at canvas (1500, 900), default-anchored (so 1500,900 is its
    // CENTRE), viewed by a camera framing (1000..2000, 700..1100) on a 1000x400
    // canvas. Everything composed: scene-geometry places it, world-quad projects it.
    const placement = computeTilePlacement({ width: 200, height: 100 }, { x: 1500, y: 900, width: 200, height: 100 });
    const corners = computeQuadCorners(placement);
    const worldRect = { minX: 1000, minY: 700, maxX: 2000, maxY: 1100 };
    const ndc = corners.map((c) => worldToNdc(c, worldRect));

    // The tile is centred in the view, so its NDC centre is ~0.
    const cx = (ndc[0].x + ndc[2].x) / 2;
    const cy = (ndc[0].y + ndc[2].y) / 2;
    ok('end-to-end: a tile centred in the view projects to NDC ~(0,0)', near(cx, 0) && near(cy, 0));
    // Its top edge (uv v=0) is ABOVE its bottom edge on screen.
    ok('end-to-end: the tile is not upside-down (v=0 edge is higher in NDC)', ndc[0].y > ndc[3].y);
    // It occupies 200/1000 of the view's width -> 0.4 of NDC's 2-unit span.
    ok("end-to-end: NDC width matches the tile's share of the view", near(ndc[1].x - ndc[0].x, 0.4));
    // ...and 100/400 of the height -> 0.5 of the 2-unit span.
    ok("end-to-end: NDC height matches the tile's share of the view", near(ndc[0].y - ndc[3].y, 0.5));
  }

  // --- computeTileSubPlacement: a SPLIT image draws exactly like a whole one -
  // Verified against the REAL computeQuadCorners, so the split path inherits the
  // whole-item path's orientation (no fresh Y-flip — the point of this file).
  {
    const cornersMatch = (a, b) => a.every((c, i) => near(c.x, b[i].x, 1e-6) && near(c.y, b[i].y, 1e-6));
    const aabb = (cs) => ({
      minX: Math.min(...cs.map((c) => c.x)),
      minY: Math.min(...cs.map((c) => c.y)),
      maxX: Math.max(...cs.map((c) => c.x)),
      maxY: Math.max(...cs.map((c) => c.y)),
    });

    // 1×1 whole-image tile reproduces the item's OWN quad, corner-for-corner.
    {
      const placement = { x: 9000, y: 9000, width: 12000, height: 12000, anchorX: 0.5, anchorY: 0.5, rotation: 0 };
      const sub = computeTileSubPlacement(placement, 12000, 12000, { sx: 0, sy: 0, sw: 12000, sh: 12000 });
      ok(
        'tileSubPlacement: a 1×1 whole tile reproduces the item quad corner-for-corner',
        cornersMatch(computeQuadCorners(sub), computeQuadCorners(placement))
      );
    }

    // A real 2×2 split (planImageTiles @ 8192) PARTITIONS the item quad: the four
    // tile quads union to exactly the item quad, with no gap and no overshoot.
    {
      const placement = { x: 9000, y: 9000, width: 12000, height: 12000, anchorX: 0.5, anchorY: 0.5, rotation: 0 };
      const plan = planImageTiles(12000, 12000, 8192); // 2×2 of 6000² source tiles
      const subs = plan.tiles.map((tile) => computeTileSubPlacement(placement, 12000, 12000, tile));
      const itemBox = aabb(computeQuadCorners(placement));
      const union = aabb(subs.flatMap((s) => computeQuadCorners(s)));
      ok(
        'tileSubPlacement: 2×2 tiles union to exactly the item quad (no gap/overshoot)',
        near(union.minX, itemBox.minX, 1e-6) &&
          near(union.minY, itemBox.minY, 1e-6) &&
          near(union.maxX, itemBox.maxX, 1e-6) &&
          near(union.maxY, itemBox.maxY, 1e-6)
      );
      ok(
        'tileSubPlacement: each of the 4 tiles is 6000×6000 world px',
        subs.every((s) => near(s.width, 6000) && near(s.height, 6000))
      );
      // Source (0,0) is the image's TOP-LEFT; under Y-down world it must centre in
      // the item's top-left quadrant (smaller X AND smaller Y). This is the flip
      // link, asserted for the split path too.
      ok(
        'tileSubPlacement: source (0,0) tile centres top-left (Y-down inherited)',
        near(subs[0].x, 6000) && near(subs[0].y, 6000)
      );
    }

    // Rotated / off-anchor items: the whole-image tile STILL reproduces the item
    // quad — the sub-placement rides the same anchor + rotation, so a split of a
    // rotated tile stays glued to it.
    for (const placement of [
      { x: 500, y: 400, width: 300, height: 200, anchorX: 0.5, anchorY: 0.5, rotation: 37 },
      { x: 500, y: 400, width: 300, height: 200, anchorX: 0, anchorY: 0, rotation: 0 },
      { x: 500, y: 400, width: 300, height: 200, anchorX: 0.2, anchorY: 0.8, rotation: 90 },
    ]) {
      const sub = computeTileSubPlacement(placement, 300, 200, { sx: 0, sy: 0, sw: 300, sh: 200 });
      ok(
        `tileSubPlacement: whole tile reproduces the item quad (rot ${placement.rotation}, anchor ${placement.anchorX})`,
        cornersMatch(computeQuadCorners(sub), computeQuadCorners(placement))
      );
    }
  }
}
