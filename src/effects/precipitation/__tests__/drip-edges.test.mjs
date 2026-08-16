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
}
