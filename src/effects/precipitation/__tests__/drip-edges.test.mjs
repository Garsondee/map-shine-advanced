/**
 * DRIP SPAWN POINTS (docs/planning/Precipitation.md §4.3).
 *
 * ⚠️ THIS SUITE IS THE FEATURE'S REASON FOR EXISTING IN THIS SHAPE. V2's roof
 * drips *"never reliably worked"* because their screen→world mapping was VOTED
 * ON AT RUNTIME between four Y-flip candidates. The replacement is not a better
 * vote — it is a pure grid→world function whose orientation is ASSERTED, here,
 * on a deliberately ASYMMETRIC fixture. A centred fixture cannot calibrate a
 * flip: two benches in this project have already recorded reporting
 * `mismatchesFlipped: 0` while telling nobody anything.
 */
import {
  extractDripEdges,
  dripEdgeSignature,
  COVER_THRESHOLD,
  OPEN_THRESHOLD,
  DEFAULT_DECK_HEIGHT_PX,
  extractDripMaskPoints,
  dripMaskPointsSignature,
  DRIP_MASK_SPAWN_THRESHOLD,
  MAX_DRIP_MASK_POINTS,
} from '../drip-edges.js';

/** A grid with a solid rectangle of "roof" in it. Row 0 = spec.y = minY. */
function makeGrid({ w = 16, h = 12, x = 100, y = 200, width = 1600, height = 1200, rect = null } = {}) {
  const data = new Uint8Array(w * h);
  if (rect) {
    for (let gy = rect.y0; gy < rect.y1; gy++) {
      for (let gx = rect.x0; gx < rect.x1; gx++) data[gy * w + gx] = 255;
    }
  }
  return { spec: { w, h, x, y, width, height, texelW: width / w, texelH: height / h }, data };
}

/** A grid painted at exactly the given (gx, gy, byteValue) triples — for
 * `extractDripMaskPoints`, whose selection rule is a per-texel VALUE cut, not
 * a silhouette, so arbitrary scattered points (not just solid rects) are the
 * representative fixture shape. */
function makePointGrid({ w = 16, h = 12, x = 100, y = 200, width = 1600, height = 1200, points = [] } = {}) {
  const data = new Uint8Array(w * h);
  for (const [gx, gy, v] of points) data[gy * w + gx] = v;
  return { spec: { w, h, x, y, width, height, texelW: width / w, texelH: height / h }, data };
}

export function run(t) {
  // ---- ⭐ THE ORIENTATION, ON AN ASYMMETRIC FIXTURE ---------------------------
  {
    // A roof in the TOP-LEFT of the grid — low gx, low gy — which in world
    // terms is low x and low y. Off-centre in BOTH axes so a flip in either is
    // visible rather than invisible.
    const grid = makeGrid({ rect: { x0: 2, x1: 6, y0: 1, y1: 4 } });
    const out = extractDripEdges(grid);
    t.ok('a solid roof produces edge points', out.count > 0);

    const xs = [];
    const ys = [];
    for (let i = 0; i < out.count; i++) {
      xs.push(out.points[i * 3]);
      ys.push(out.points[i * 3 + 1]);
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    // texelW = 100, texelH = 100; rect x 100.., y 200..
    // gx 2..5 ⇒ world x 350..650 (centres); gy 1..3 ⇒ world y 350..550.
    t.ok('⭐ points land in the roof’s own world X span', minX >= 340 && maxX <= 660);
    // ⚠️ THE ASSERTION V2 NEEDED AND NEVER HAD. Grid row 1 is world y = 350,
    // NOT the mirrored 1350 a flipped read would produce. Row 0 IS minY.
    t.ok('⭐ row 0 is minY — a flipped read would land near y=1350, not 350', minY >= 340 && maxY <= 560);
    t.ok(
      'no point escapes the grid rect',
      xs.every((v) => v >= 100 && v <= 1700) && ys.every((v) => v >= 200 && v <= 1400)
    );
  }

  // ---- what counts as an edge -------------------------------------------------
  {
    const grid = makeGrid({ rect: { x0: 4, x1: 10, y0: 3, y1: 8 } });
    const out = extractDripEdges(grid);
    // A 6×5 solid block has a 6+6+3+3 = 18-texel perimeter and a 4×3 = 12-texel
    // interior. Only the perimeter is an edge — an interior roof texel has no
    // open neighbour and nothing to drip off.
    t.ok('only the perimeter is an edge, never the interior', out.edgeTexels === 18);

    const solid = makeGrid({ rect: { x0: 0, x1: 16, y0: 0, y1: 12 } });
    // ⚠️ A ROOF THAT FILLS THE WHOLE GRID HAS NO EDGE — the world continues
    // past the rect, so its border is an edge of the MAP, not of a building.
    // Hanging drips there would outline the map.
    t.ok(
      'a full-grid roof produces no edges (the map’s border is not a roofline)',
      extractDripEdges(solid).count === 0
    );

    t.ok('an empty grid produces nothing', extractDripEdges(makeGrid()).count === 0);
    // Fails SILENT, never guessed — a drip in the wrong place is worse than no
    // drip, which is this module's whole thesis.
    t.ok('malformed input produces nothing', extractDripEdges(null).count === 0 && extractDripEdges({}).count === 0);
  }

  // ---- the two thresholds are a BAND, not one cut -----------------------------
  {
    t.ok('the cover cut sits above the open cut', COVER_THRESHOLD > OPEN_THRESHOLD);
    // A soft rim: values that are "covered" but whose neighbours are also
    // partly covered must NOT all become spawn points, or a faded canopy edge
    // produces a band several texels deep instead of a line.
    const w = 10;
    const h = 6;
    const data = new Uint8Array(w * h);
    for (let gy = 1; gy < 5; gy++) {
      for (let gx = 1; gx < 9; gx++) {
        // A ramp from the middle outward: centre solid, rim partial.
        const d = Math.max(Math.abs(gx - 4.5), Math.abs(gy - 2.5));
        data[gy * w + gx] = Math.round(255 * Math.max(0, 1 - d / 4));
      }
    }
    const soft = { spec: { w, h, x: 0, y: 0, width: 1000, height: 600 }, data };
    const out = extractDripEdges(soft);
    // With a single cut every ramp texel above it would qualify; with the band
    // only the outermost properly-covered ring does.
    t.ok('a soft rim yields a line, not a band', out.edgeTexels > 0 && out.edgeTexels <= 12);
  }

  // ---- ⭐ THE DECK ALTITUDE ---------------------------------------------------
  {
    const grid = makeGrid({ rect: { x0: 3, x1: 9, y0: 2, y1: 7 } });
    const bare = extractDripEdges(grid);
    t.ok('with no height grid every drip uses the default eave', bare.heightSource.startsWith('default'));
    t.ok(
      'the default is a real height, not the ground',
      DEFAULT_DECK_HEIGHT_PX > 0 &&
        Array.from({ length: bare.count }, (_, i) => bare.points[i * 3 + 2]).every((v) => v === DEFAULT_DECK_HEIGHT_PX)
    );

    // A height grid at the SAME rect, half-height everywhere the roof is.
    const hgrid = makeGrid({ rect: { x0: 3, x1: 9, y0: 2, y1: 7 } });
    for (let i = 0; i < hgrid.data.length; i++) if (hgrid.data[i] > 0) hgrid.data[i] = 128;
    const withH = extractDripEdges(grid, { heightGrid: hgrid, heightScalePx: 2000 });
    t.ok('⭐ a height grid gives every drip its own deck altitude', withH.heightSource === 'measured');
    // 128/255 × 2000 ≈ 1004.
    t.ok('the altitude is the byte scaled by the caster scale', Math.abs(withH.meanHeightPx - 1004) < 12);
    // ⚠️ NAMED, NOT INFERRED. "Every drip fell from the same height" and "the
    // decks really are all equal" look identical on screen and are very
    // different facts.
    t.ok('the source is reported either way', bare.heightSource !== withH.heightSource);
  }

  // ---- the cap SUBSAMPLES, it does not truncate -------------------------------
  {
    // A long thin roof with a big perimeter.
    const grid = makeGrid({ w: 64, h: 48, rect: { x0: 1, x1: 63, y0: 1, y1: 47 } });
    const full = extractDripEdges(grid, { maxPoints: 10000 });
    const capped = extractDripEdges(grid, { maxPoints: 20 });
    t.ok('the cap bites', full.count > 20 && capped.count <= 20);
    t.ok('the cap is reported as a stride, not silently', capped.stride > 1 && capped.edgeTexels === full.edgeTexels);
    // ⚠️ EVEN COVERAGE, NOT THE FIRST N. A truncating cap would put every point
    // on the roof's top edge and leave three sides silent — which reads as
    // "drips are broken" rather than "drips are tiered".
    const ys = Array.from({ length: capped.count }, (_, i) => capped.points[i * 3 + 1]);
    t.ok('a capped roofline still spans the whole roof', Math.max(...ys) - Math.min(...ys) > 0);
  }

  // ---- the signature notices a changed roofline -------------------------------
  {
    const a = makeGrid({ rect: { x0: 2, x1: 6, y0: 1, y1: 4 } });
    const b = makeGrid({ rect: { x0: 2, x1: 7, y0: 1, y1: 4 } });
    t.ok('the same grid signs the same', dripEdgeSignature(a) === dripEdgeSignature(a));
    t.ok('a changed roofline signs differently', dripEdgeSignature(a) !== dripEdgeSignature(b));
    t.ok('a missing grid signs as none', dripEdgeSignature(null) === 'none');
  }

  // ══════════════════════════════════════════════════════════════════════
  // extractDripMaskPoints (mythica-machina-press#316) — THE AUTHORED MASK.
  // Every painted texel is a candidate (no edge test), and subsampling is
  // the fractional accumulator borrowed from fire-spawn-points.js, not this
  // file's own integer stride above. See the module header for both.
  // ══════════════════════════════════════════════════════════════════════

  // ---- ⭐ THE ORIENTATION, ON AN ASYMMETRIC FIXTURE — same discipline as
  // extractDripEdges's own first test: a fixture centred in either axis
  // cannot catch a flip. Three scattered points, none of them an edge or a
  // silhouette, which extractDripEdges's own algorithm would find NOTHING in
  // (no texel here has a covered neighbour AND an open one at this cut). -----
  {
    // texelW = texelH = 100; rect x 100.., y 200.. (same fixture geometry as
    // makeGrid's defaults, so the world-space arithmetic below is comparable).
    // World = spec.{x,y} + (grid + 0.5) * texel — texel CENTRES, row 0 = minY.
    const grid = makePointGrid({
      points: [
        [1, 1, 255], // world (100+1.5*100, 200+1.5*100) = (250, 350)
        [10, 8, 200], // world (100+10.5*100, 200+8.5*100) = (1150, 1050)
        [2, 9, 90], // world (100+2.5*100, 200+9.5*100) = (350, 1150) — well above the 0.15 cut (≈38)
      ],
    });
    const out = extractDripMaskPoints(grid);
    t.ok(`three scattered points yield three spawn points (got ${out.count})`, out.count === 3);
    const xs = [];
    const ys = [];
    for (let i = 0; i < out.count; i++) {
      xs.push(out.points[i * 3]);
      ys.push(out.points[i * 3 + 1]);
    }
    t.ok(`the near point lands at its own texel centre (${xs.join(',')})`, xs.includes(250) && ys.includes(350));
    // ⚠️ THE ASSERTION A FLIPPED READ WOULD FAIL. Grid row 8 (of 12) is world y
    // = 200 + 8.5*100 = 1050, NOT the mirrored reading a flip would produce.
    t.ok('⭐ row 0 is minY here too — a flipped read would land at 1050, not mirrored', ys.includes(1050));
    t.ok('the third (faint but above-cut) point lands at its own texel centre', xs.includes(350) && ys.includes(1150));
  }

  // ---- unpainted and below-threshold inputs produce nothing -------------------
  {
    t.ok('an unpainted grid yields nothing', extractDripMaskPoints(makeGrid()).count === 0);
    t.ok(
      'a null grid yields nothing',
      extractDripMaskPoints(null).count === 0 && extractDripMaskPoints({}).count === 0
    );
    // 0.15 × 255 = 38.25 — 38 sits just under the cut, 39 just over it.
    const below = makePointGrid({ points: [[3, 3, 38]] });
    const above = makePointGrid({ points: [[3, 3, 39]] });
    t.ok('a value just below DRIP_MASK_SPAWN_THRESHOLD spawns nothing', extractDripMaskPoints(below).count === 0);
    t.ok('a value just above it spawns a point', extractDripMaskPoints(above).count === 1);
    t.ok(
      'the threshold is genuinely lower than the roofline`s COVER_THRESHOLD',
      DRIP_MASK_SPAWN_THRESHOLD < COVER_THRESHOLD
    );
  }

  // ---- NO edge test: an interior texel with every neighbour painted still
  // spawns, unlike extractDripEdges's own perimeter-only rule ------------------
  {
    const solidInterior = makeGrid({ w: 10, h: 10, rect: { x0: 2, x1: 8, y0: 2, y1: 8 } });
    const asEdges = extractDripEdges(solidInterior);
    const asAuthored = extractDripMaskPoints(solidInterior);
    t.ok(
      'the SAME solid block: extractDripEdges keeps only the perimeter...',
      asEdges.count > 0 && asEdges.edgeTexels < asAuthored.edgeTexels
    );
    t.ok(
      '...while extractDripMaskPoints keeps every painted texel, interior included',
      asAuthored.count === 36 && asAuthored.edgeTexels === 36
    );
  }

  // ---- ⭐ THE DECK ALTITUDE — sampled exactly like extractDripEdges's own ------
  {
    const grid = makePointGrid({ points: [[4, 4, 255]] });
    const bare = extractDripMaskPoints(grid);
    t.ok('with no height grid, the default eave height is used', bare.heightSource.startsWith('default'));
    t.ok('the default is a real height, not the ground', bare.points[2] === DEFAULT_DECK_HEIGHT_PX);

    const hgrid = makePointGrid({ points: [[4, 4, 128]] });
    const withH = extractDripMaskPoints(grid, { heightGrid: hgrid, heightScalePx: 2000 });
    t.ok('a height grid gives the authored point its own deck altitude', withH.heightSource === 'measured');
    // 128/255 × 2000 ≈ 1004.
    t.ok('the altitude is the byte scaled by the caster scale', Math.abs(withH.meanHeightPx - 1004) < 12);
  }

  // ---- the cap SUBSAMPLES, it does not truncate — mirrors extractDripEdges's
  // own equivalent test, same reasoning ------------------------------------
  {
    const points = [];
    for (let gy = 0; gy < 48; gy++) for (let gx = 0; gx < 64; gx++) points.push([gx, gy, 255]);
    const grid = makePointGrid({ w: 64, h: 48, points });
    const full = extractDripMaskPoints(grid, { maxPoints: 10000 });
    const capped = extractDripMaskPoints(grid, { maxPoints: 20 });
    t.ok('the cap bites', full.count > 20 && capped.count <= 20);
    t.ok(
      'the cap is reported via `stride` (the fractional keepEvery), not silently',
      capped.stride > 1 && capped.edgeTexels === full.edgeTexels
    );
    const ys = Array.from({ length: capped.count }, (_, i) => capped.points[i * 3 + 1]);
    t.ok('a capped cloud still spans the whole painted area', Math.max(...ys) - Math.min(...ys) > 0);
  }

  // ---- ⚠️ NO DENSITY CLIFF AT THE CAP BOUNDARY — the exact property
  // fire-spawn-points.js#extractFireSpawnPoints's own test proves, mirrored
  // here for the fractional accumulator this function borrows from it. -------
  {
    const capAt20 = (paintedCount) => {
      const w = 10;
      const rowsNeeded = Math.ceil(paintedCount / w);
      const points = [];
      let remaining = paintedCount;
      for (let gy = 0; gy < rowsNeeded; gy++) {
        const thisRow = Math.min(w, remaining);
        for (let gx = 0; gx < thisRow; gx++) points.push([gx, gy, 255]);
        remaining -= thisRow;
      }
      return extractDripMaskPoints(makePointGrid({ w, h: rowsNeeded, points }), { maxPoints: 20 }).count;
    };
    const atCap = capAt20(20);
    const oneOver = capAt20(21);
    t.ok('painted exactly at the cap keeps every eligible texel', atCap === 20);
    t.ok(`one MORE painted texel than the cap does not crater the count (cap=20 got ${oneOver})`, oneOver === 20);

    // The general property: count tracks min(cap, painted) smoothly across a
    // range of caps against a FIXED painted total — no cap should see a
    // sudden drop relative to its neighbours.
    const fixedPoints = [];
    for (let gy = 0; gy < 10; gy++) for (let gx = 0; gx < 10; gx++) fixedPoints.push([gx, gy, 255]); // 100 painted
    const fixedGrid = makePointGrid({ w: 10, h: 10, points: fixedPoints });
    const counts = [90, 91, 99, 100, 101, 150].map((cap) => extractDripMaskPoints(fixedGrid, { maxPoints: cap }).count);
    t.ok(
      `count exactly matches min(cap, painted) at every sampled cap (${counts.join(', ')})`,
      counts[0] === 90 &&
        counts[1] === 91 &&
        counts[2] === 99 &&
        counts[3] === 100 &&
        counts[4] === 100 &&
        counts[5] === 100
    );
  }

  // ---- the default cap matches the roofline's own ----------------------------
  {
    t.ok('MAX_DRIP_MASK_POINTS matches the roofline`s own MAX_DRIP_POINTS cap', MAX_DRIP_MASK_POINTS === 512);
  }

  // ---- the return shape is a drop-in for extractDripEdges's own callers ------
  {
    const a = extractDripEdges(makeGrid({ rect: { x0: 2, x1: 6, y0: 1, y1: 4 } }));
    const b = extractDripMaskPoints(makePointGrid({ points: [[2, 2, 255]] }));
    const fields = (o) => Object.keys(o).sort();
    t.ok(
      `both extractors return the identical field set (${fields(a).join(',')} / ${fields(b).join(',')})`,
      fields(a).join(',') === fields(b).join(',')
    );
  }

  // ---- determinism ------------------------------------------------------------
  {
    const grid = makePointGrid({
      points: [
        [1, 1, 255],
        [5, 5, 180],
      ],
    });
    const a = extractDripMaskPoints(grid);
    const b = extractDripMaskPoints(grid);
    t.ok('extraction is deterministic', a.points.every((v, i) => v === b.points[i]) && a.count === b.count);
  }

  // ---- the signature notices a changed authored mask --------------------------
  {
    const a = makePointGrid({ points: [[2, 2, 255]] });
    const b = makePointGrid({
      points: [
        [2, 2, 255],
        [3, 2, 255],
      ],
    });
    t.ok('the same grid signs the same', dripMaskPointsSignature(a) === dripMaskPointsSignature(a));
    t.ok('a changed mask signs differently', dripMaskPointsSignature(a) !== dripMaskPointsSignature(b));
    t.ok('a missing grid signs as none', dripMaskPointsSignature(null) === 'none');
  }
}
