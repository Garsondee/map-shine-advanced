/**
 * mask-derive.test.mjs — the derivation math, proven on ASYMMETRIC fixtures
 * (Y-flip is this repo's named recurring bug class: every new world→texture
 * mapping gets an orientation proof, memory `feedback_y_flip_recurring_risk`).
 *
 * The forward placement transform is CROSS-CHECKED against the real
 * `foundry/scene-geometry.js#computeQuadCorners` — mask-derive carries its own
 * tiny copy for the AABB, and this suite is what keeps the two from drifting.
 */
import {
  computeMaskGridSpec,
  createMaskGrid,
  worldToItemUv,
  itemWorldCorners,
  compositeItemMax,
  deriveFloorProducts,
  makeUniformContent,
  sampleMaskGridWorld,
  maskGridMean,
  extractContentWindow,
} from '../mask-derive.js';
import { computeQuadCorners } from '../../foundry/scene-geometry.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

export async function run(t) {
  // --- grid sizing ---------------------------------------------------------
  const spec = computeMaskGridSpec({ x: 100, y: 200, width: 1000, height: 500 }, 100);
  t.ok('grid preserves aspect (1000x500 → 100x50)', spec.w === 100 && spec.h === 50);
  t.ok('grid texel size derives from rect', near(spec.texelW, 10) && near(spec.texelH, 10));
  t.ok('grid keeps the rect origin', spec.x === 100 && spec.y === 200);

  // --- inverse transform: exact round trip with the forward corners --------
  const placement = { x: 340, y: 210, width: 200, height: 80, anchorX: 0.25, anchorY: 0.75, rotation: 37 };
  const corners = itemWorldCorners(placement);
  const foundryCorners = computeQuadCorners(placement);
  t.ok(
    'itemWorldCorners matches foundry computeQuadCorners corner-for-corner',
    corners.every((c, i) => near(c.x, foundryCorners[i].x, 1e-9) && near(c.y, foundryCorners[i].y, 1e-9))
  );
  const uvExpectations = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  t.ok(
    'worldToItemUv inverts the corners back to unit UVs',
    corners.every((c, i) => {
      const { u, v } = worldToItemUv(placement, c.x, c.y);
      return near(u, uvExpectations[i][0], 1e-9) && near(v, uvExpectations[i][1], 1e-9);
    })
  );

  // --- rasterize orientation: X, Y, and rotation, each asymmetric ----------
  const gspec = computeMaskGridSpec({ x: 0, y: 0, width: 100, height: 100 }, 10); // 10x10, texel 10
  {
    const grid = createMaskGrid(gspec);
    // Item over x∈[0,50), y∈[0,50): content 2x1 = [opaque, transparent].
    const content = { w: 2, h: 1, data: new Uint8Array([255, 0]) };
    compositeItemMax(grid, content, { x: 25, y: 25, width: 50, height: 50, anchorX: 0.5, anchorY: 0.5, rotation: 0 });
    // Texel (2,2) would sit at the item's EXACT center (u=0.5 → right half by
    // floor rule), so the left-half probe is texel (1,2), u=0.3.
    t.ok('left content half lands on the LEFT (texel 1,2 covered)', grid.data[2 * 10 + 1] === 255);
    t.ok('right content half stays empty (texel 4,2 clear)', grid.data[2 * 10 + 4] === 0);
    t.ok('outside the item stays clear (texel 7,2)', grid.data[2 * 10 + 7] === 0);
  }
  {
    const grid = createMaskGrid(gspec);
    // Content 1x2 = [opaque TOP, transparent bottom]. Row 0 must land at minY.
    const content = { w: 1, h: 2, data: new Uint8Array([255, 0]) };
    compositeItemMax(grid, content, { x: 25, y: 25, width: 50, height: 50, anchorX: 0.5, anchorY: 0.5, rotation: 0 });
    t.ok('content row 0 lands at world minY (texel 2,0 covered)', grid.data[0 * 10 + 2] === 255);
    t.ok('content bottom row stays empty toward maxY (texel 2,4 clear)', grid.data[4 * 10 + 2] === 0);
  }
  {
    // 90° clockwise: a 40x20 item at (50,50) occupies x∈[40,60], y∈[30,70].
    const grid = createMaskGrid(gspec);
    compositeItemMax(grid, makeUniformContent(1, 255), {
      x: 50,
      y: 50,
      width: 40,
      height: 20,
      anchorX: 0.5,
      anchorY: 0.5,
      rotation: 90,
    });
    t.ok('rotated footprint covers its true texels (5,3)', grid.data[3 * 10 + 5] === 255);
    t.ok('rotated footprint does NOT cover the unrotated AABB (3,5 clear)', grid.data[5 * 10 + 3] === 0);
  }

  // --- floor derivation: threshold, hidden, missing, sky math --------------
  const items = [
    {
      id: 'bg0',
      elevation: 0,
      hidden: false,
      placement: { x: 50, y: 50, width: 100, height: 100 },
      alpha: makeUniformContent(1, 255),
    },
    {
      id: 'roof0',
      elevation: 10, // exactly AT the ceiling — must count (roof art sits at elevation.top)
      hidden: false,
      placement: { x: 25, y: 50, width: 50, height: 100 }, // left half
      alpha: makeUniformContent(1, 255),
    },
    {
      id: 'hiddenTile',
      elevation: 15,
      hidden: true,
      placement: { x: 75, y: 50, width: 50, height: 100 },
      alpha: makeUniformContent(1, 255),
    },
    {
      id: 'pendingTile',
      elevation: 12,
      hidden: false,
      placement: { x: 75, y: 25, width: 50, height: 50 },
      alpha: null, // not ingested yet — must be REPORTED, never guessed
    },
  ];
  const floors = [
    { index: 0, ceilingElevation: 10, outdoors: null },
    { index: 1, ceilingElevation: 20, outdoors: null },
  ];
  const products = deriveFloorProducts({ gridSpec: gspec, items, floors, outdoorsAbsentValue: 1 });

  const f0 = products[0];
  t.ok('item at exactly the ceiling elevation covers (left half)', f0.coverAbove.data[5 * 10 + 2] === 255);
  t.ok('item below the ceiling never covers (bg0 alone would cover everything)', f0.coverAbove.data[5 * 10 + 7] === 0);
  t.ok(
    'hidden items are excluded and listed',
    f0.coverAbove.data[5 * 10 + 8] === 0 && f0.completeness.hiddenExcludedIds.includes('hiddenTile')
  );
  t.ok(
    'missing-alpha items are listed, not guessed',
    f0.completeness.missingItemIds.includes('pendingTile') && f0.coverAbove.data[2 * 10 + 7] === 0
  );
  t.ok(
    'expected list carries both real inputs',
    f0.completeness.expectedItemIds.includes('roof0') && f0.completeness.expectedItemIds.includes('pendingTile')
  );
  t.ok(
    'skyReach with default outdoors = inverse of cover',
    f0.skyReach.data[5 * 10 + 2] === 0 && f0.skyReach.data[5 * 10 + 7] === 255
  );

  const f1 = products[1];
  t.ok(
    'a floor with nothing above it derives fully-open sky',
    maskGridMean(f1.coverAbove) === 0 && near(maskGridMean(f1.skyReach), 1)
  );

  // --- authored outdoors: multiplication + reach-vs-absent distinction -----
  const authoredFloors = [
    {
      index: 0,
      ceilingElevation: 10,
      // Outdoors art covers only the LEFT half; painted fully indoors (0).
      outdoors: { placement: { x: 25, y: 50, width: 50, height: 100 }, content: makeUniformContent(1, 0) },
    },
  ];
  const authored = deriveFloorProducts({ gridSpec: gspec, items: [], floors: authoredFloors, outdoorsAbsentValue: 1 });
  t.ok('authored indoors kills sky where the mask reaches', authored[0].skyReach.data[5 * 10 + 2] === 0);
  t.ok('outside the mask art the ABSENT value serves (open sky)', authored[0].skyReach.data[5 * 10 + 7] === 255);
  t.ok(
    'outdoors provenance is reported',
    authored[0].completeness.outdoorsSource === 'authored' && f0.completeness.outdoorsSource === 'default'
  );

  // --- sampling + stats ----------------------------------------------------
  t.ok('sampleMaskGridWorld reads the covering texel', sampleMaskGridWorld(f0.coverAbove, 25, 55) === 255);
  t.ok(
    'sampleMaskGridWorld returns null outside the rect',
    sampleMaskGridWorld(f0.coverAbove, -5, 55) === null && sampleMaskGridWorld(f0.coverAbove, 25, 105) === null
  );
  t.ok('maskGridMean of the half-covered floor ≈ 0.5', near(maskGridMean(f0.coverAbove), 0.5, 0.01));

  // --- page content-window extraction --------------------------------------
  const img = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  for (let i = 0; i < 16; i++) {
    img.data[i * 4 + 0] = 10 + i; // r
    img.data[i * 4 + 1] = 100 + i; // g
    img.data[i * 4 + 2] = 200; // b
    img.data[i * 4 + 3] = i; // a
  }
  const win = extractContentWindow(img, { dx: 1, dy: 2, dw: 2, dh: 2 }, 'g');
  t.ok('extractContentWindow crops the window', win.w === 2 && win.h === 2);
  // Pixels (1,2)=idx 9, (2,2)=10, (1,3)=13, (2,3)=14 → g = 109,110,113,114.
  t.ok(
    'extractContentWindow reads the right channel at the right offsets',
    win.data[0] === 109 && win.data[1] === 110 && win.data[2] === 113 && win.data[3] === 114
  );
  const alphaWin = extractContentWindow(img, { dx: 0, dy: 0, dw: 4, dh: 4 }, 'a');
  t.ok('alpha channel extraction works (last pixel a=15)', alphaWin.data[15] === 15);
}
