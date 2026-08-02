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
  compositeItemOverwrite,
  deriveFloorProducts,
  rasterizeAuthored,
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
  // ⚠️ THESE ASSERT ORIENTATION AS A COMPARISON, NOT AS A LITERAL. They used to
  // pin `=== 255` / `=== 0`, which was only ever true because `compositeItemMax`
  // NEAREST-sampled; it is bilinear since 2026-07-26 (the "blocky, square-edged"
  // fix), so a 2-texel-wide fixture legitimately interpolates across its whole
  // width. The INVARIANT under test is which way round the content lands, and
  // `left > right` states that far more directly than a magic number did — it
  // cannot be satisfied by a flipped mapping, and it survives any future change
  // to the reconstruction filter.
  {
    const grid = createMaskGrid(gspec);
    // Item over x∈[0,50), y∈[0,50): content 2x1 = [opaque, transparent].
    const content = { w: 2, h: 1, data: new Uint8Array([255, 0]) };
    compositeItemMax(grid, content, { x: 25, y: 25, width: 50, height: 50, anchorX: 0.5, anchorY: 0.5, rotation: 0 });
    const left = grid.data[2 * 10 + 1];
    const right = grid.data[2 * 10 + 4];
    t.ok('left content half lands on the LEFT (texel 1,2 brightest)', left > 200);
    t.ok('right content half is the DARK end (texel 4,2 < left)', right < 64 && right < left);
    t.ok('outside the item stays clear (texel 7,2)', grid.data[2 * 10 + 7] === 0);
  }
  {
    const grid = createMaskGrid(gspec);
    // Content 1x2 = [opaque TOP, transparent bottom]. Row 0 must land at minY.
    const content = { w: 1, h: 2, data: new Uint8Array([255, 0]) };
    compositeItemMax(grid, content, { x: 25, y: 25, width: 50, height: 50, anchorX: 0.5, anchorY: 0.5, rotation: 0 });
    const top = grid.data[0 * 10 + 2];
    const bottom = grid.data[4 * 10 + 2];
    t.ok('content row 0 lands at world minY (texel 2,0 brightest)', top > 200);
    t.ok('content bottom row is the DARK end toward maxY', bottom < 64 && bottom < top);
  }
  {
    // THE ANTI-BLOCKINESS PROPERTY ITSELF, pinned so a revert to nearest is a
    // test failure rather than a slow visual regression: a coarse content grid
    // sampled onto a finer scene grid must produce a RAMP, not a staircase.
    // Nearest would give exactly two distinct values across this row.
    const fine = computeMaskGridSpec({ x: 0, y: 0, width: 100, height: 100 }, 20); // texel 5
    const grid = createMaskGrid(fine);
    const content = { w: 2, h: 1, data: new Uint8Array([255, 0]) };
    compositeItemMax(grid, content, { x: 50, y: 50, width: 100, height: 100, anchorX: 0.5, anchorY: 0.5, rotation: 0 });
    const row = [];
    for (let gx = 0; gx < 20; gx++) row.push(grid.data[10 * 20 + gx]);
    const distinct = new Set(row).size;
    t.ok('a coarse content grid reconstructs as a RAMP, not 2 hard blocks', distinct > 6);
    t.ok(
      'the ramp is monotonically non-increasing left→right',
      row.every((v, i) => i === 0 || v <= row[i - 1])
    );
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

  // --- compositeItemOverwrite: unlike compositeItemMax, it can DARKEN too --
  // (2026-07-26, `keyhole-mask-any-item-decision` — a Tile's own mask must be
  // able to wall a hole back up, not just open one; MAX can only ever raise
  // a value, never lower it, so it cannot express that.)
  {
    const grid = createMaskGrid(gspec);
    compositeItemMax(grid, makeUniformContent(1, 255), { x: 50, y: 50, width: 100, height: 100, rotation: 0 });
    t.ok(
      'setup: the whole grid starts bright',
      grid.data.every((v) => v === 255)
    );
    compositeItemMax(grid, makeUniformContent(1, 0), { x: 25, y: 50, width: 50, height: 100, rotation: 0 });
    t.ok('compositeItemMax alone can never darken — it only ever raises a value', grid.data[5 * 10 + 2] === 255);
    compositeItemOverwrite(grid, makeUniformContent(1, 0), { x: 25, y: 50, width: 50, height: 100, rotation: 0 });
    t.ok(
      'compositeItemOverwrite REPLACES within its own footprint, even to something darker',
      grid.data[5 * 10 + 2] === 0
    );
    t.ok('and leaves texels outside its own footprint untouched', grid.data[5 * 10 + 7] === 255);
  }

  // ══════════════════════════════════════════════════════════════════
  // 🖌️ TRANSPARENT MEANS UNPAINTED, NOT A PAINTED ZERO (author's ruling,
  // 2026-08-02, live: shadows appeared to be thrown by the empty edges of a
  // mask image — *"Why would an 'edge' at 0 alpha cause a shadow to appear?"*).
  //
  // A transparent pixel's colour channel is 0, and for `_Outdoors` a 0 means
  // INDOORS — so writing the whole placement RECTANGLE turned every unpainted
  // corner of a mask file into a solid, shadow-casting wall.
  // ══════════════════════════════════════════════════════════════════
  {
    const opaque = makeUniformContent(1, 255);

    // A fully TRANSPARENT source must change nothing at all, even though its
    // colour channel is 0 and its rectangle covers everything.
    const clear = createMaskGrid(gspec);
    clear.data.fill(255); // the outdoors absent value
    compositeItemOverwrite(
      clear,
      makeUniformContent(1, 0),
      { x: 50, y: 50, width: 100, height: 100, rotation: 0 },
      makeUniformContent(1, 0) // alpha 0 everywhere — unpainted
    );
    t.ok(
      'a fully transparent mask paints NOTHING — an unpainted texel keeps the absent value, never a wall',
      clear.data.every((v) => v === 255)
    );

    // An OPAQUE black mask must still mean indoors — the author still authors
    // exactly that for an entirely-underground scene, so "treat 0 as absent"
    // would have been the wrong fix.
    const painted = createMaskGrid(gspec);
    painted.data.fill(255);
    compositeItemOverwrite(
      painted,
      makeUniformContent(1, 0),
      { x: 50, y: 50, width: 100, height: 100, rotation: 0 },
      opaque
    );
    t.ok(
      'an OPAQUE black mask still means indoors — a deliberately black mask is real data',
      painted.data.every((v) => v === 0)
    );

    // Half alpha blends against what is already there rather than snapping.
    const half = createMaskGrid(gspec);
    half.data.fill(255);
    compositeItemOverwrite(
      half,
      makeUniformContent(1, 0),
      { x: 50, y: 50, width: 100, height: 100, rotation: 0 },
      makeUniformContent(1, 128)
    );
    t.ok(
      "a mask's antialiased edge blends instead of snapping to painted-0",
      half.data.every((v) => v > 120 && v < 135)
    );

    // OMITTING alpha is byte-identical to the old behaviour — every caller
    // that has no alpha to give must be unaffected.
    const noAlpha = createMaskGrid(gspec);
    noAlpha.data.fill(255);
    compositeItemOverwrite(noAlpha, makeUniformContent(1, 0), { x: 50, y: 50, width: 100, height: 100, rotation: 0 });
    t.ok(
      'omitting alpha composites fully opaque (unchanged for callers with none)',
      noAlpha.data.every((v) => v === 0)
    );

    // And through the real entry point, so the wiring is pinned too, not just
    // the primitive: `rasterizeAuthored` must forward `source.alpha`.
    const viaRasterize = rasterizeAuthored(
      gspec,
      [
        {
          placement: { x: 50, y: 50, width: 100, height: 100, rotation: 0 },
          content: makeUniformContent(1, 0),
          alpha: makeUniformContent(1, 0),
        },
      ],
      1 // outdoors' own absentValue
    );
    t.ok(
      'rasterizeAuthored forwards alpha — a transparent source leaves the absent fill intact',
      viaRasterize.data.every((v) => v === 255)
    );
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
    { index: 0, ceilingElevation: 10, outdoors: [] },
    { index: 1, ceilingElevation: 20, outdoors: [] },
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
  t.ok(
    'the default (unauthored) outdoors grid reads the absent value everywhere, on EVERY floor',
    f0.outdoors.data.every((v) => v === 255) && f1.outdoors.data.every((v) => v === 255)
  );

  // --- authored outdoors: multiplication + reach-vs-absent distinction -----
  const authoredFloors = [
    {
      index: 0,
      ceilingElevation: 10,
      // Outdoors art covers only the LEFT half; painted fully indoors (0).
      outdoors: [{ placement: { x: 25, y: 50, width: 50, height: 100 }, content: makeUniformContent(1, 0) }],
    },
  ];
  const authored = deriveFloorProducts({ gridSpec: gspec, items: [], floors: authoredFloors, outdoorsAbsentValue: 1 });
  t.ok('authored indoors kills sky where the mask reaches', authored[0].skyReach.data[5 * 10 + 2] === 0);
  t.ok('outside the mask art the ABSENT value serves (open sky)', authored[0].skyReach.data[5 * 10 + 7] === 255);
  t.ok(
    'outdoors provenance is reported',
    authored[0].completeness.outdoorsSource === 'authored' && f0.completeness.outdoorsSource === 'default'
  );
  // --- the RAW outdoors grid — 2026-07-21, the general shelter signal, ------
  // distinct from skyReach (which ALSO folds in coverAbove — a different,
  // rain-occlusion-specific question). No items/roofs in this fixture, so
  // coverAbove is 0 everywhere and skyReach would happen to equal outdoors
  // here regardless — the real point is that `outdoors` is now its OWN,
  // independently-sampleable product, not that these two numbers differ.
  t.ok(
    'the RAW outdoors value reflects the painted mask where it reaches (indoors, painted 0)',
    authored[0].outdoors.data[5 * 10 + 2] === 0
  );
  t.ok(
    'outside the mask`s own placement, the RAW outdoors value falls back to the absent value, not 0',
    authored[0].outdoors.data[5 * 10 + 7] === 255
  );

  // --- rasterizeAuthored: the shared helper the outdoors block became -------
  // (2026-07-25, Water.md Phase 2a — `water` is the second `rasterize: true`
  // kind, so the outdoors block was extracted rather than copied. Generalized
  // 2026-07-26 from ONE source to an ORDERED LIST — `keyhole-mask-any-item-
  // decision` — so this now also proves the "reach vs painted-black" and
  // "multiple sources" distinctions together.)
  {
    const placed = {
      placement: { x: 25, y: 50, width: 50, height: 100 },
      content: makeUniformContent(1, 40),
    };
    const g = rasterizeAuthored(gspec, [placed], 0);
    t.ok('rasterizeAuthored writes the painted value where the art reaches', g.data[5 * 10 + 2] === 40);
    t.ok('rasterizeAuthored writes the ABSENT value outside the art', g.data[5 * 10 + 7] === 0);

    // A mask painted BLACK inside its own reach must read 0, while a texel
    // the art never reaches reads absentValue. With absentValue 1 the two are
    // visibly different numbers; a plain compositeItemMax would give 0 for
    // both — `compositeItemOverwrite` doesn't have that ambiguity: a never-
    // reached texel is simply never written, full stop.
    const black = rasterizeAuthored(gspec, [{ ...placed, content: makeUniformContent(1, 0) }], 1);
    t.ok('painted-black inside the art reads 0, not the absent value', black.data[5 * 10 + 2] === 0);
    t.ok('unreached texels read the absent value, not 0', black.data[5 * 10 + 7] === 255);

    const none = rasterizeAuthored(gspec, [], 0.5);
    t.ok(
      'no authored content at all (an empty source list) fills the whole grid with the absent value',
      none.data.every((v) => v === 128)
    );
  }

  // --- rasterizeAuthored: MULTIPLE ordered sources composite together ------
  // (2026-07-26, `keyhole-mask-any-item-decision`, LOCKED — a Tile's own mask
  // now composites into the SAME grid as its floor's background, in draw
  // order, OVERWRITING rather than MAX-ing: the author's own worked example
  // needs a later source to be able to paint something DARKER, not just
  // brighter — *"a tile... automatically overwrites the `_Outdoors` so that
  // suddenly the corner of the building is outside where previously it was
  // inside"* — and the reverse, walling a hole back up, must work too.)
  {
    const wholeFloor = { placement: { x: 50, y: 50, width: 100, height: 100 }, content: makeUniformContent(1, 255) };
    // A SECOND source, painted BLACK (0), covering only the left half — a
    // Tile walling up part of an otherwise fully-outdoor floor.
    const leftHalfDark = { placement: { x: 25, y: 50, width: 50, height: 100 }, content: makeUniformContent(1, 0) };

    const laterWins = rasterizeAuthored(gspec, [wholeFloor, leftHalfDark], 0.5);
    t.ok(
      'a LATER source overwrites an EARLIER one within their shared footprint, even DARKER',
      laterWins.data[5 * 10 + 2] === 0
    );
    t.ok(
      "outside the later source's own footprint, the earlier source's paint survives",
      laterWins.data[5 * 10 + 7] === 255
    );

    // Order reversed: whichever source is listed LAST wins — there is no
    // hidden precedence rule here, only the order the caller hands in
    // (mask-authority.js resolves that from scene/layer-order.js).
    const earlierWins = rasterizeAuthored(gspec, [leftHalfDark, wholeFloor], 0.5);
    t.ok(
      "draw order is entirely the CALLER's doing, not a fixed precedence — reversing the list reverses who wins",
      earlierWins.data[5 * 10 + 2] === 255
    );

    // A texel NEITHER source's own placement ever reaches keeps the absent
    // value — "authored by something" and "never painted by anything on this
    // floor" stay two different, honestly-reported facts, generalized from
    // one source to N.
    const neitherReaches = rasterizeAuthored(
      gspec,
      [
        { placement: { x: 10, y: 10, width: 10, height: 10 }, content: makeUniformContent(1, 255) },
        { placement: { x: 10, y: 90, width: 10, height: 10 }, content: makeUniformContent(1, 0) },
      ],
      0.5
    );
    t.ok('a texel no source reaches keeps the absent value', neitherReaches.data[5 * 10 + 5] === 128);
  }

  // --- the `authored` product bag: water rides here, not on a top-level key -
  {
    const waterFloors = [
      {
        index: 0,
        ceilingElevation: 10,
        outdoors: [],
        authored: {
          water: {
            sources: [{ placement: { x: 25, y: 50, width: 50, height: 100 }, content: makeUniformContent(1, 200) }],
            absentValue: 0,
          },
        },
      },
      { index: 1, ceilingElevation: 20, outdoors: [], authored: { water: { sources: [], absentValue: 0 } } },
    ];
    const wp = deriveFloorProducts({ gridSpec: gspec, items: [], floors: waterFloors, outdoorsAbsentValue: 1 });
    t.ok(
      'an authored rasterize kind lands under products.authored[kindId]',
      wp[0].authored.water.data[5 * 10 + 2] === 200
    );
    t.ok('its absent value fills outside the art', wp[0].authored.water.data[5 * 10 + 7] === 0);
    t.ok(
      'a floor with no content for the kind still gets a grid (absent-filled), never undefined',
      wp[1].authored.water instanceof Object && wp[1].authored.water.data.every((v) => v === 0)
    );
    // THE FACT THE BODY PACK TURNS ON: both grids above are all-zero in
    // places, so the DATA cannot distinguish "painted no water" from "no mask
    // at all". Provenance can, and must — otherwise floor 1 would borrow the
    // river from below purely because its own mask happens to be empty.
    t.ok(
      'provenance separates authored-but-empty from never-authored',
      wp[0].completeness.authoredSources.water === 'authored' && wp[1].completeness.authoredSources.water === 'default'
    );
    t.ok(
      'a floor input with no `authored` bag at all is legal and yields an empty bag',
      Object.keys(f0.authored).length === 0 && Object.keys(f0.completeness.authoredSources).length === 0
    );
  }

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

  // ═══════════════════════════════════════════════════════════════════════
  // THE CASTER HEIGHT FIELD (docs/planning/Sun-Shadows.md §3.1)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Three producers, ONE physical quantity, three ELEVATION BANDS that must not
  // overlap or leave a gap. These assertions exist because every one of the
  // three failed in V2 in a way that looked plausible on screen: a roof that
  // silently stopped casting, a balcony counted as a whole upper floor, an
  // unknown ground elevation treated as zero.
  {
    const SCALE = 2048;
    const casterFloors = [
      // A floor whose GROUND is at 0 and CEILING at 10 — so a tile at 5 is
      // overhead (a balcony) and the roof at 10 is sky-reach.
      { index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] },
      // Upstairs: ground 10, no declared ceiling.
      { index: 1, ceilingElevation: Infinity, bottomElevation: 10, outdoors: [] },
    ];
    const casterItems = [
      {
        id: 'ground',
        elevation: 0,
        hidden: false,
        placement: { x: 50, y: 50, width: 100, height: 100 },
        alpha: makeUniformContent(1, 255),
      },
      // A balcony 5 units up, over the LEFT half.
      {
        id: 'balcony',
        elevation: 5,
        hidden: false,
        placement: { x: 25, y: 50, width: 50, height: 100 },
        alpha: makeUniformContent(1, 255),
      },
      // The roof, at the ceiling, over the RIGHT half.
      {
        id: 'roof',
        elevation: 10,
        hidden: false,
        placement: { x: 75, y: 50, width: 50, height: 100 },
        alpha: makeUniformContent(1, 255),
      },
    ];
    const cast = deriveFloorProducts({
      gridSpec: gspec,
      items: casterItems,
      floors: casterFloors,
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: SCALE, distancePixels: 20, buildingHeightPx: 0 },
    });
    const g0 = cast[0];
    const LEFT = 5 * 10 + 2;
    const RIGHT = 5 * 10 + 7;
    const px = (byte) => (byte / 255) * SCALE;

    t.ok(
      'the balcony lands in OVERHEAD, not sky-reach',
      g0.casterChannels.overhead.data[LEFT] > 0 && g0.casterChannels.skyReach.data[LEFT] === 0
    );
    t.ok(
      'the roof lands in SKY-REACH, not overhead',
      g0.casterChannels.skyReach.data[RIGHT] > 0 && g0.casterChannels.overhead.data[RIGHT] === 0
    );
    t.ok(
      "the balcony's height is its elevation above THIS floor, in px (5 units x 20 px/unit)",
      near(px(g0.casterChannels.overhead.data[LEFT]), 100, 10)
    );
    t.ok(
      "the roof's height likewise (10 units x 20 px/unit)",
      near(px(g0.casterChannels.skyReach.data[RIGHT]), 200, 10)
    );
    t.ok(
      'the floor’s own GROUND art casts nothing — it is not raised above itself',
      g0.casterChannels.overhead.data[LEFT] === g0.casterChannels.overhead.data[LEFT] &&
        !g0.completeness.overheadItemIds.includes('ground')
    );
    t.ok(
      'casterHeight is the MAX of the three, never their sum (a chimney on a roof is one shadow)',
      g0.casterHeight.data[LEFT] === g0.casterChannels.overhead.data[LEFT] &&
        g0.casterHeight.data[RIGHT] === g0.casterChannels.skyReach.data[RIGHT]
    );
    t.ok(
      'each band reports which items fed it',
      g0.completeness.overheadItemIds.includes('balcony') && g0.completeness.skyReachItemIds.includes('roof')
    );

    // THE UPSTAIRS VIEW: standing on floor 1, the roof at elevation 10 is its
    // own GROUND, not something overhead — the same item must not cast on the
    // floor it belongs to.
    const g1 = cast[1];
    t.ok(
      'an item AT a floor’s own ground elevation casts nothing on that floor',
      g1.casterChannels.overhead.data[RIGHT] === 0 && g1.casterChannels.skyReach.data[RIGHT] === 0
    );
  }

  // AN UNKNOWN GROUND is reported, never treated as zero — the difference
  // between "this balcony is 5 units up" and "we have no idea how high anything
  // is", which produce very different shadows and only one of them is a fact.
  {
    const noGround = deriveFloorProducts({
      gridSpec: gspec,
      items: [
        {
          id: 'tile',
          elevation: 5,
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: undefined, outdoors: [] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 0 },
    });
    t.ok('no declared ground → the overhead band is EMPTY', maskGridMean(noGround[0].casterChannels.overhead) === 0);
    t.ok('and the report says so with null, not 0', noGround[0].completeness.bottomElevation === null);
  }

  // THE BUILDING CHANNEL — derived from the outdoors painting alone, so it can
  // never be starved the way the art-driven producers can.
  {
    const built = deriveFloorProducts({
      gridSpec: gspec,
      items: [],
      floors: [
        {
          index: 0,
          ceilingElevation: 10,
          bottomElevation: 0,
          // Left half painted INDOORS (0) — that is the building footprint.
          outdoors: [{ placement: { x: 25, y: 50, width: 50, height: 100 }, content: makeUniformContent(1, 0) }],
        },
      ],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 256 },
    });
    const b = built[0].casterChannels.building;
    t.ok('the dark of the outdoors mask stands up as a building', b.data[5 * 10 + 2] > 0);
    t.ok('the painted-outdoors half stands up as nothing', b.data[5 * 10 + 7] === 0);
    t.ok(
      'at the authored height (256 px over a 2048 px scale = 32/255)',
      near((b.data[5 * 10 + 2] / 255) * 2048, 256, 12)
    );
    t.ok(
      'the building has its own COVERAGE channel (indoor-ness), separate from its height',
      built[0].casterChannels.coverBuilding.data[5 * 10 + 2] > 200 &&
        built[0].casterChannels.coverBuilding.data[5 * 10 + 7] === 0
    );
    t.ok(
      'a GROUNDED wall contributes no SKY-REACH coverage — nothing feeds the march`s d=0 self-check',
      maskGridMean(built[0].casterChannels.coverSkyReach) === 0
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // 🎚️ `casterGridDim` (2026-07-30) — the CASTER channels can rasterize at a
  // DIFFERENT resolution from `gridSpec`, so a sun-shadow performance tier can
  // buy a crisper SILHOUETTE without raising the shared 512-cap grid every
  // OTHER consumer (water/specular/wind) budgets against. The load-bearing
  // claim: `outdoors` (always at `gridSpec`) must still gate the caster
  // channels CORRECTLY by WORLD POSITION even though the two grids no longer
  // share an index space.
  // ══════════════════════════════════════════════════════════════════════
  {
    const fineSpec = computeMaskGridSpec({ x: 0, y: 0, width: 100, height: 100 }, 20); // 20x20, texel 5 — 2x gspec
    const split2x = deriveFloorProducts({
      gridSpec: gspec,
      casterGridSpec: fineSpec,
      items: [],
      floors: [
        {
          index: 0,
          ceilingElevation: 10,
          bottomElevation: 0,
          // Same left-half-indoors painting as THE BUILDING CHANNEL test above.
          outdoors: [{ placement: { x: 25, y: 50, width: 50, height: 100 }, content: makeUniformContent(1, 0) }],
        },
      ],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 256 },
    });
    const f = split2x[0];
    t.ok(
      'the SHARED channels stay at gridSpec`s own resolution (10x10 = 100), untouched',
      f.coverAbove.data.length === 100 && f.outdoors.data.length === 100 && f.skyReach.data.length === 100
    );
    t.ok(
      'the CASTER channels take on casterGridSpec`s resolution instead (20x20 = 400)',
      f.casterChannels.building.data.length === 400 &&
        f.casterChannels.coverBuilding.data.length === 400 &&
        f.casterHeight.data.length === 400
    );
    // World x=22.5 (gx=4, well inside the painted-indoors left half) vs
    // world x=77.5 (gx=15, well inside the untouched-outdoors right half),
    // both at an arbitrary row (gy=10) — the SAME world-space boundary THE
    // BUILDING CHANNEL test above already proved at gridSpec's own coarser
    // resolution, now re-proved at DOUBLE it.
    const bFine = f.casterChannels.building;
    const idxIndoors = 10 * 20 + 4;
    const idxOutdoors = 10 * 20 + 15;
    t.ok('at 2x resolution, the indoors world position still stands up as a building', bFine.data[idxIndoors] > 0);
    t.ok('and the outdoors world position still stands up as nothing', bFine.data[idxOutdoors] === 0);
    t.ok(
      'at the correct authored height, unaffected by the resolution change',
      near((bFine.data[idxIndoors] / 255) * 2048, 256, 12)
    );

    // A caller that omits casterGridSpec gets BYTE-IDENTICAL behaviour to
    // before this feature existed — the regression guard for every other test
    // in this file that never passes it.
    const noCasterSpec = deriveFloorProducts({
      gridSpec: gspec,
      items: [],
      floors: [
        {
          index: 0,
          ceilingElevation: 10,
          bottomElevation: 0,
          outdoors: [{ placement: { x: 25, y: 50, width: 50, height: 100 }, content: makeUniformContent(1, 0) }],
        },
      ],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 256 },
    });
    t.ok(
      'omitting casterGridSpec reuses gridSpec exactly, matching THE BUILDING CHANNEL test above',
      noCasterSpec[0].casterChannels.building.data.length === 100 &&
        near((noCasterSpec[0].casterChannels.building.data[5 * 10 + 2] / 255) * 2048, 256, 12)
    );
  }

  // The OVERHEAD exterior gate must ALSO stay correct across a resolution
  // split — it is the OTHER loop that reads `outdoors` beside the caster
  // channels (mask-derive.js's own `OVERHEAD_EXTERIOR_THRESHOLD` gate).
  {
    const fineSpec = computeMaskGridSpec({ x: 0, y: 0, width: 100, height: 100 }, 20);
    const gatedFine = deriveFloorProducts({
      gridSpec: gspec,
      casterGridSpec: fineSpec,
      items: [
        {
          id: 'balcony',
          elevation: 5,
          hidden: false,
          // Sits over the RIGHT (outdoors, exterior) half only.
          placement: { x: 75, y: 50, width: 50, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
      ],
      floors: [
        {
          index: 0,
          ceilingElevation: 10,
          bottomElevation: 0,
          // Left half indoors, right half outdoors — same split as above.
          outdoors: [{ placement: { x: 25, y: 50, width: 50, height: 100 }, content: makeUniformContent(1, 0) }],
        },
      ],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 0 },
    });
    const covOverheadFine = gatedFine[0].casterChannels.coverOverhead;
    t.ok(
      'the overhead exterior gate resolves at casterGridSpec`s own resolution too (20x20 = 400)',
      covOverheadFine.data.length === 400
    );
    // The balcony spans world x=[50,100] (all exterior) — should read through
    // the gate at ANY sampled point within its own footprint, at the FINE
    // resolution, cross-checked by WORLD POSITION against the coarse
    // `outdoors` grid rather than a shared index.
    const idxOnBalconyExterior = 10 * 20 + 15; // world x=77.5, inside both the balcony and the exterior half
    t.ok(
      'an overhead item over EXTERIOR ground still casts at 2x resolution',
      covOverheadFine.data[idxOnBalconyExterior] > 0
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE 2026-07-26 RETHINK — COVERAGE AND HEIGHT ARE TWO FACTS, NOT ONE BYTE
  // ══════════════════════════════════════════════════════════════════════
  //
  // The field used to store `alpha × height` in a single byte, so a
  // half-transparent caster read as a HALF-HEIGHT one: a shorter shadow, and
  // (because the march derived darkness from how far a caster overtopped the
  // ray) a fainter one too. That single packing decision produced every symptom
  // the author reported — smeared silhouettes, "different opacities", and a
  // sky-reach shadow that never appeared. These pin the split.
  {
    const SCALE = 2048;
    const halfAlpha = makeUniformContent(1, 128);
    const split = deriveFloorProducts({
      gridSpec: gspec,
      items: [
        {
          id: 'ghostDeck',
          elevation: 10,
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: halfAlpha,
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: SCALE, distancePixels: 20, buildingHeightPx: 0 },
    });
    const s = split[0];
    const AT = 5 * 10 + 5;
    t.ok(
      'a HALF-transparent caster keeps its FULL height (10 units x 20 px = 200 px)',
      near((s.casterChannels.skyReach.data[AT] / 255) * SCALE, 200, 12)
    );
    t.ok('and records its opacity as COVERAGE instead', near(s.casterChannels.coverSkyReach.data[AT], 128, 2));

    // THE SMOKING GUN, made reportable. Casters present + max height ZERO is
    // exactly what a floor with no declared `bottomElevation` produces, and it
    // is why "sky reach isn't working" was undiagnosable: every item COUNT
    // looked healthy while the field cast nothing (feedback_instruments_must_not_lie).
    // ±8 px: one byte step over a 2048 px scale. Stated as a tolerance rather
    // than a magic literal so the number reads as "a quantised height" and not
    // as an exact measurement it can never be.
    t.ok('a healthy field reports its tallest caster in world px', near(s.completeness.maxCasterHeightPx, 200, 8));
    const noGround = deriveFloorProducts({
      gridSpec: gspec,
      items: [
        {
          id: 'deck',
          elevation: 10,
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: undefined, outdoors: [] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: SCALE, distancePixels: 20, buildingHeightPx: 0 },
    });
    t.ok(
      'casters counted but ZERO tall is a REPORTED state, not a silent blank',
      noGround[0].completeness.skyReachItemIds.includes('deck') && noGround[0].completeness.maxCasterHeightPx === 0
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // A TILE'S OWN FLOOR VISIBILITY OUTRANKS ITS ELEVATION (2026-07-26, round 2)
  // ══════════════════════════════════════════════════════════════════════
  //
  // THE BUG, author-caught LIVE: a standing prop on a raised tile still
  // rendered its shadow through its own sprite AFTER the overhead-vs-
  // sky-reach split (§ above). Cause: the prop is a TILE with a SPECIFIC
  // `levels` set naming THIS floor, but its elevation ALSO happens to cross
  // this floor's own ceiling — so the elevation-only test classified it as
  // "sky-reach" (a different floor's structure) even though it is drawn
  // right here. `visibleFloorIndices` is the fix: floor membership beats the
  // elevation number, exactly the same shape as `ownerFloorIndex` for level
  // art, just for tiles.
  {
    const lantern = deriveFloorProducts({
      gridSpec: gspec,
      items: [
        {
          id: 'lanternPlinth',
          elevation: 12, // ABOVE this floor's own ceiling (10) — the trap
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: makeUniformContent(1, 255),
          visibleFloorIndices: [0], // but CONFIRMED drawn on THIS floor
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 0 },
    });
    const c = lantern[0].completeness;
    t.ok(
      'a tile confirmed visible HERE is never sky-reach for this floor, whatever its elevation says',
      !c.skyReachItemIds.includes('lanternPlinth')
    );
    t.ok(
      'it is overhead instead — uncapped by the ceiling, since it is confirmed drawn here',
      c.overheadItemIds.includes('lanternPlinth')
    );
    t.ok(
      "and its own footprint is excluded from the self-shadow channel, matching the 'never self-shadow' fix",
      lantern[0].casterChannels.coverSkyReach.data[5 * 10 + 5] === 0
    );

    // The control: an IDENTICAL item with UNKNOWN visibility (no
    // `visibleFloorIndices` at all) falls back to the ORIGINAL elevation-only
    // test, unchanged — this is a strictly additive fix, not a behaviour swap.
    const unknown = deriveFloorProducts({
      gridSpec: gspec,
      items: [
        {
          id: 'legacyItem',
          elevation: 12,
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 0 },
    });
    t.ok(
      'unknown visibility (no visibleFloorIndices) is unchanged: elevation alone still decides',
      unknown[0].completeness.skyReachItemIds.includes('legacyItem')
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // AN OVERHEAD ITEM MUST NEVER SELF-SHADOW (2026-07-26)
  // ══════════════════════════════════════════════════════════════════════
  //
  // THE BUG (author, screenshot): a standing prop on a raised tile rendered
  // with its shadow painted THROUGH its own sprite. Root cause: the march's
  // zero-distance self-check ("is something solid directly over ME") read
  // `max(coverOverhead, coverSkyReach)` — but an overhead item lives on THIS
  // SAME floor. Foundry elevation is a draw-order key, not a spatial offset:
  // a raised tile's own sprite occupies the IDENTICAL (x,y) as whatever it
  // would "shade" beneath it, so there is no separate, visible ground there
  // to darken — only the item's own opaque art. Sky-reach is different: a
  // genuinely other floor, whose art this floor never draws at that pixel, so
  // darkening it darkens real, still-visible ground. `coverSkyReach` is what
  // the subsystem now packs into the self-check channel — this pins that
  // overhead's own coverage never reaches it, while still reaching
  // `coverOverhead` (which marches normally, casting onto NEARBY ground).
  {
    const SCALE = 2048;
    const balcony = deriveFloorProducts({
      gridSpec: gspec,
      items: [
        {
          id: 'lanternPlinth',
          elevation: 5,
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: SCALE, distancePixels: 20, buildingHeightPx: 0 },
    });
    const AT = 5 * 10 + 5;
    t.ok(
      "an overhead item's own footprint contributes ZERO to the self-shadow channel",
      balcony[0].casterChannels.coverSkyReach.data[AT] === 0
    );
    t.ok(
      'the SAME footprint still carries full coverage for the march to find NEARBY (via coverOverhead)',
      balcony[0].casterChannels.coverOverhead.data[AT] > 200
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // A LEVEL'S OWN ART IS CLASSIFIED BY FLOOR MEMBERSHIP, NOT BY ELEVATION
  // ══════════════════════════════════════════════════════════════════════
  //
  // THE BUG (author, 2026-07-26): *"When I change to sky reach only it only
  // shows the overhead parts of the upper floors… we're not including
  // 'background image' and 'foreground image' from upper floors."*
  //
  // A level's BACKGROUND sits at its own `elevation.bottom`; its FOREGROUND at
  // `elevation.top`. The old test was `elevation >= ceilingElevation`, which
  // holds for a background ONLY while the scene's bands abut exactly. These
  // bands OVERLAP by 5 — floor 1 starts at 5 while floor 0 runs to 10 — which
  // is ordinary authoring and used to silently drop floor 1's entire
  // background while keeping its foreground. Both must cast.
  {
    const overlapping = deriveFloorProducts({
      gridSpec: gspec,
      items: [
        {
          id: 'level:f1:background',
          elevation: 5, // BELOW floor 0's ceiling of 10 — the whole point
          ownerFloorIndex: 1,
          hidden: false,
          placement: { x: 25, y: 50, width: 50, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
        {
          id: 'level:f1:foreground',
          elevation: 15,
          ownerFloorIndex: 1,
          hidden: false,
          placement: { x: 75, y: 50, width: 50, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
        {
          id: 'level:f0:background',
          elevation: 0,
          ownerFloorIndex: 0, // THIS floor's own ground — must never cast on itself
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 0 },
    });
    const c = overlapping[0].completeness;
    t.ok(
      "an upper floor's BACKGROUND casts sky-reach even though its elevation is below this ceiling",
      c.skyReachItemIds.includes('level:f1:background')
    );
    t.ok("an upper floor's FOREGROUND still casts too", c.skyReachItemIds.includes('level:f1:foreground'));
    t.ok(
      "THIS floor's own background never casts on itself",
      !c.skyReachItemIds.includes('level:f0:background') && !c.overheadItemIds.includes('level:f0:background')
    );
    t.ok('a level’s own art is never reclassified as an overhead protrusion', c.overheadItemIds.length === 0);
    // The per-item verdict table — the instrument that would have answered this
    // in one paste instead of a screenshot plus a directory listing.
    const row = c.itemBands.find((b) => b.id === 'level:f1:background');
    t.ok(
      'every item reports its own band, elevation and owner floor',
      row?.band === 'skyReach' && row.ownerFloorIndex === 1
    );
    t.ok('and whether its art had actually arrived', row?.hasArt === true);
  }

  // OVERHEAD IS GATED TO EXTERIOR PROTRUSIONS (2026-07-24, author: "Overhead
  // shadows from inside of a building are ending up projected outside"). An
  // overhead tile over INDOOR ground must cast nothing; the same tile over
  // OUTDOOR ground (an exterior balcony) still casts.
  {
    // Left half of the floor is authored INDOORS (outdoors=0), right half open.
    const outdoorsArt = {
      placement: { x: 50, y: 50, width: 100, height: 100 },
      content: (() => {
        const w = 8;
        const h = 8;
        const data = new Uint8Array(w * h);
        for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) data[gy * w + gx] = gx < w / 2 ? 0 : 255;
        return { w, h, data };
      })(),
    };
    // Two overhead tiles at +5: one over the indoor (left) half, one over the
    // outdoor (right) half.
    const items = [
      {
        id: 'interiorMezz',
        elevation: 5,
        hidden: false,
        placement: { x: 25, y: 50, width: 50, height: 100 },
        alpha: makeUniformContent(1, 255),
      },
      {
        id: 'exteriorBalcony',
        elevation: 5,
        hidden: false,
        placement: { x: 75, y: 50, width: 50, height: 100 },
        alpha: makeUniformContent(1, 255),
      },
    ];
    const gated = deriveFloorProducts({
      gridSpec: gspec,
      items,
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [outdoorsArt] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 0 },
    });
    const ov = gated[0].casterChannels.overhead;
    t.ok('an overhead tile over INDOOR ground casts nothing (no leak outside the building)', ov.data[5 * 10 + 2] === 0);
    t.ok('an overhead tile over OUTDOOR ground (an exterior balcony) still casts', ov.data[5 * 10 + 7] > 0);
  }

  // 🔒 THE ASYMMETRIC-FADE REGRESSION (2026-07-30, author live) — the SAME
  // gate, but against a BLURRED `_Outdoors` transition (a ramp across several
  // texels, not the hard step above) — exactly what a wall-mounted, thin
  // overhead protrusion straddles at its own attachment point. Before this
  // fix, the gate MULTIPLIED coverage by the raw ramp value, baking a fake,
  // one-sided taper into the item's OWN coverage/height that the source art
  // never had — strong at the confidently-outdoor end, fading to nothing at
  // the indoor end, permanently, before the shadow's own softening ever ran.
  {
    // A GRADUAL ramp across the grid's width: indoors (0) on the left, a
    // BLURRED middle band, confidently outdoors (255) on the right — the
    // coarse-grid-blur shape a real `_Outdoors` mask has at a wall's edge.
    const rampArt = {
      placement: { x: 0, y: 0, width: 100, height: 100 },
      content: (() => {
        const w = 8;
        const h = 8;
        const data = new Uint8Array(w * h);
        const ramp = [0, 0, 40, 100, 160, 220, 255, 255]; // strictly increasing, spans the midpoint
        for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) data[gy * w + gx] = ramp[gx];
        return { w, h, data };
      })(),
    };
    // ONE overhead item spanning the WHOLE floor width, so its own footprint
    // straddles the entire ramp — the wall-mounted-protrusion shape: one
    // continuous piece of art, not two separate tiles either side of a hard
    // line.
    const straddling = [
      {
        id: 'wallMountedBracket',
        elevation: 5,
        hidden: false,
        placement: { x: 50, y: 50, width: 100, height: 100 },
        alpha: makeUniformContent(1, 255),
      },
    ];
    const faded = deriveFloorProducts({
      gridSpec: gspec,
      items: straddling,
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [rampArt] }],
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 0 },
    });
    const fadedOv = faded[0].casterChannels.coverOverhead;
    const fadedOutdoors = faded[0].outdoors;
    const row = 5 * 10;
    // Read the item's OWN coverage where the item is fully outdoor-side, as
    // the "what full, ungated coverage looks like" reference.
    const fullCoverage = fadedOv.data[row + 9];
    t.ok('sanity: the item genuinely covers this row at full strength once ungated', fullCoverage > 200);
    for (let col = 0; col < 10; col++) {
      const i = row + col;
      const isExterior = fadedOutdoors.data[i] >= 128;
      t.ok(
        `col ${col}: gated coverage is BINARY, not a fraction of the raw outdoors ramp (outdoors=${fadedOutdoors.data[i]})`,
        isExterior ? fadedOv.data[i] === fullCoverage : fadedOv.data[i] === 0
      );
    }
  }

  // THE ISOLATION TOGGLES — applied at DERIVATION, not as shader gates, so
  // "off" genuinely removes the contribution (tsl/no-uniform-gates).
  {
    const args = {
      gridSpec: gspec,
      items: [
        {
          id: 'roof',
          elevation: 10,
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] }],
      outdoorsAbsentValue: 1,
    };
    const on = deriveFloorProducts({
      ...args,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 100 },
    });
    const off = deriveFloorProducts({
      ...args,
      casterHeights: { scalePx: 2048, distancePixels: 20, buildingHeightPx: 100, include: { skyReach: false } },
    });
    t.ok('sky-reach on: the roof is in the field', maskGridMean(on[0].casterChannels.skyReach) > 0);
    t.ok('sky-reach off: the channel is genuinely empty', maskGridMean(off[0].casterChannels.skyReach) === 0);
    t.ok(
      'and turning one off leaves the others untouched',
      near(maskGridMean(off[0].casterChannels.building), maskGridMean(on[0].casterChannels.building), 1e-9)
    );
  }

  // NO SPEC AT ALL → an empty field, not a guessed one. This is the state
  // before a scene has told us its grid scale, and it must render as "no
  // shadows" rather than as shadows of an invented size.
  {
    const noSpec = deriveFloorProducts({
      gridSpec: gspec,
      items: [
        {
          id: 'roof',
          elevation: 10,
          hidden: false,
          placement: { x: 50, y: 50, width: 100, height: 100 },
          alpha: makeUniformContent(1, 255),
        },
      ],
      floors: [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] }],
      outdoorsAbsentValue: 1,
    });
    t.ok('no caster spec → every channel is empty', maskGridMean(noSpec[0].casterHeight) === 0);
  }
}
