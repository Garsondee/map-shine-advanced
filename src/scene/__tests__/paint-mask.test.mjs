/**
 * paint-mask.js — the pure painted-mask model, brush, codec, persistence.
 * Cross-checks the brush against mask-derive's OWN sampler so paint and read
 * can never disagree about where a world point lands (the anti-Y-flip guard).
 */
import {
  createPaintLayer,
  stampBrushWorld,
  rasterizePolygon,
  rasterizeStrokedLine,
  isPaintLayerEmpty,
  encodePaintLayer,
  decodePaintLayer,
  encodedByteEstimate,
  serializePaintedMasks,
  hydratePaintedMasks,
  sampleMaskGridWorld,
  PAINT_EMBED_BYTE_BUDGET,
  PAINT_GRID_MAX_DIM,
} from '../paint-mask.js';

const RECT = { x: 0, y: 0, width: 1000, height: 800 };
const CENTER = { x: 500, y: 400 };

const dataEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function run(t) {
  // --- model -------------------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    t.ok('createPaintLayer: PAINT_GRID_MAX_DIM on the long side', layer.spec.w === PAINT_GRID_MAX_DIM);
    t.ok(
      'createPaintLayer: shorter side scaled by aspect',
      layer.spec.h === Math.round((800 * PAINT_GRID_MAX_DIM) / 1000)
    );
    t.ok('createPaintLayer: starts empty', isPaintLayerEmpty(layer));
  }

  // --- brush, cross-checked through the authority's OWN reader ------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 255, hardness: 0.5 });
    t.ok('stamp: not empty after painting', !isPaintLayerEmpty(layer));
    t.ok(
      'stamp: centre reads full through sampleMaskGridWorld',
      sampleMaskGridWorld(layer, CENTER.x, CENTER.y) === 255
    );

    const rim = sampleMaskGridWorld(layer, CENTER.x + 90, CENTER.y); // d≈0.9 of the radius
    t.ok('stamp: rim is softer than centre', rim > 0 && rim < 255);

    t.ok('stamp: outside the radius is untouched', sampleMaskGridWorld(layer, CENTER.x, CENTER.y + 160) === 0);
    t.ok('stamp: a point off the grid samples null, never a guess', sampleMaskGridWorld(layer, -50, -50) === null);
  }

  // --- round brush stays round on a non-square grid -----------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 120, { value: 255, hardness: 1 });
    // equal WORLD distance along x and y must give the same painted state,
    // even though texelW !== texelH — the per-axis normalisation is what buys this.
    const alongX = sampleMaskGridWorld(layer, CENTER.x + 60, CENTER.y);
    const alongY = sampleMaskGridWorld(layer, CENTER.x, CENTER.y + 60);
    t.ok('round brush: equal world distance paints equally on both axes', alongX === 255 && alongY === 255);
    t.ok(
      'round brush: just outside the radius is clean on both axes',
      sampleMaskGridWorld(layer, CENTER.x + 130, CENTER.y) === 0
    );
  }

  // --- erase --------------------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 255, hardness: 1 });
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 255, hardness: 1, mode: 'erase' });
    t.ok('erase: removes what was painted', sampleMaskGridWorld(layer, CENTER.x, CENTER.y) === 0);
  }

  // --- add (airbrush) builds up and clamps --------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 90, hardness: 1, mode: 'add' });
    const once = sampleMaskGridWorld(layer, CENTER.x, CENTER.y);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 90, hardness: 1, mode: 'add' });
    t.ok('add: a second dab builds up past the first', sampleMaskGridWorld(layer, CENTER.x, CENTER.y) > once);
    for (let k = 0; k < 6; k++)
      stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 90, hardness: 1, mode: 'add' });
    t.ok('add: build-up clamps at 255', sampleMaskGridWorld(layer, CENTER.x, CENTER.y) === 255);
  }

  // --- polygon fill: the vector == mask unification -----------------------
  {
    const layer = createPaintLayer(RECT);
    rasterizePolygon(
      layer,
      [
        { x: 400, y: 300 },
        { x: 600, y: 300 },
        { x: 600, y: 500 },
        { x: 400, y: 500 },
      ],
      { value: 255 }
    );
    t.ok('polygon: interior fills, read through the authority sampler', sampleMaskGridWorld(layer, 500, 400) === 255);
    t.ok('polygon: exterior is clean', sampleMaskGridWorld(layer, 200, 200) === 0);
  }

  // --- polygon with a hole (even-odd; a hole needs no special-casing) ------
  {
    const layer = createPaintLayer(RECT);
    const outer = [
      { x: 300, y: 200 },
      { x: 700, y: 200 },
      { x: 700, y: 600 },
      { x: 300, y: 600 },
    ];
    const hole = [
      { x: 450, y: 350 },
      { x: 550, y: 350 },
      { x: 550, y: 450 },
      { x: 450, y: 450 },
    ];
    rasterizePolygon(layer, outer, { value: 255, holes: [hole] });
    t.ok('polygon hole: the ring is filled', sampleMaskGridWorld(layer, 350, 250) === 255);
    t.ok('polygon hole: inside the hole is NOT filled', sampleMaskGridWorld(layer, 500, 400) === 0);
  }

  // --- polygon erase punches a hole into a fill ---------------------------
  {
    const layer = createPaintLayer(RECT);
    rasterizePolygon(
      layer,
      [
        { x: 300, y: 300 },
        { x: 700, y: 300 },
        { x: 700, y: 500 },
        { x: 300, y: 500 },
      ],
      { value: 255 }
    );
    rasterizePolygon(
      layer,
      [
        { x: 450, y: 350 },
        { x: 550, y: 350 },
        { x: 550, y: 450 },
        { x: 450, y: 450 },
      ],
      { value: 255, mode: 'erase' }
    );
    t.ok('polygon erase: the erased sub-region is clear', sampleMaskGridWorld(layer, 500, 400) === 0);
    t.ok('polygon erase: the rest of the fill survives', sampleMaskGridWorld(layer, 350, 400) === 255);
  }

  // --- stroked line: "draw a line == paint a line" ------------------------
  {
    const layer = createPaintLayer(RECT);
    rasterizeStrokedLine(
      layer,
      [
        { x: 200, y: 400 },
        { x: 800, y: 400 },
      ],
      40, // width -> radius 20
      { value: 255 }
    );
    t.ok('line: the stroke centre is painted', sampleMaskGridWorld(layer, 500, 400) === 255);
    t.ok('line: within the width is painted', sampleMaskGridWorld(layer, 500, 415) > 0);
    t.ok('line: beyond the width is clean', sampleMaskGridWorld(layer, 500, 480) === 0);
    t.ok('line: the endpoint is painted (round cap)', sampleMaskGridWorld(layer, 800, 400) === 255);
  }

  // --- codec round-trip ---------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 130, { value: 200, hardness: 0.4 });
    stampBrushWorld(layer, 200, 200, 60, { value: 255, hardness: 0.7 });
    const encoded = encodePaintLayer(layer);
    const { layer: back, dimensionsMatch } = decodePaintLayer(encoded, RECT);
    t.ok('codec: round-trips byte-for-byte', dataEqual(layer.data, back.data));
    t.ok('codec: dimensions match the same scene rect', dimensionsMatch === true);
  }

  // --- a genuinely SPARSE mask (a small brush on a REAL-scale scene, not a
  //     big brush on a tiny test rect) stays well under the embed budget ---
  {
    // 12,000-wide is the real scene scale used elsewhere in this project. A
    // radius-130 stroke on it is a small, localized dab (~2% of grid width at
    // PAINT_GRID_MAX_DIM) -- the actual "sparse" case PAINT_EMBED_BYTE_BUDGET
    // exists to distinguish from a mask detailed enough to want Mode B.
    const bigRect = { x: 0, y: 0, width: 12000, height: 8000 };
    const layer = createPaintLayer(bigRect);
    stampBrushWorld(layer, 6000, 4000, 130, { value: 200, hardness: 0.4 });
    stampBrushWorld(layer, 2000, 2000, 60, { value: 255, hardness: 0.7 });
    const encoded = encodePaintLayer(layer);
    t.ok('codec: a sparse mask is well under the embed budget', encodedByteEstimate(encoded) < PAINT_EMBED_BYTE_BUDGET);
  }

  // --- a resized scene is REPORTED, not silently stretched ----------------
  {
    const layer = createPaintLayer(RECT); // PAINT_GRID_MAX_DIM x (aspect-scaled)
    stampBrushWorld(layer, CENTER.x, CENTER.y, 80, { value: 255 });
    const encoded = encodePaintLayer(layer);
    // A genuinely different aspect ratio -> a different h at the SAME maxDim.
    const { dimensionsMatch } = decodePaintLayer(encoded, { x: 0, y: 0, width: 800, height: 800 });
    t.ok('codec: a resolution change is reported as a mismatch', dimensionsMatch === false);
  }

  // --- maxDim is honoured, and MUST be threaded consistently through decode
  //     (the real bug fixed 2026-07-20: decodePaintLayer used to ignore its
  //     caller's maxDim entirely and always compare against mask-derive's
  //     unrelated 512 default, so bumping PAINT_GRID_MAX_DIM alone would have
  //     made EVERY ordinary reload report a false "scene resized") ----------
  {
    const layer = createPaintLayer(RECT, 256);
    t.ok('createPaintLayer: an explicit maxDim overrides the default', layer.spec.w === 256);
    const encoded = encodePaintLayer(layer);
    const matching = decodePaintLayer(encoded, RECT, 256);
    t.ok('decodePaintLayer: the SAME maxDim as encoding reports a match', matching.dimensionsMatch === true);
    const defaulted = decodePaintLayer(encoded, RECT); // maxDim defaults to PAINT_GRID_MAX_DIM, NOT 256
    t.ok(
      'decodePaintLayer: a DIFFERENT maxDim than encoding correctly reports a mismatch (not silently wrong)',
      defaulted.dimensionsMatch === false
    );
  }

  // --- persistence: only-painted-stored, round-trip -----------------------
  {
    const fire = createPaintLayer(RECT);
    stampBrushWorld(fire, CENTER.x, CENTER.y, 100, { value: 255 });
    const dust = createPaintLayer(RECT); // never painted

    const payload = serializePaintedMasks({ 'fire::0': fire, 'dust::0': dust });
    t.ok('serialize: keeps a painted mask', !!payload['fire::0']);
    t.ok('serialize: drops an unpainted mask (store only what differs)', !('dust::0' in payload));

    const { layers, mismatched } = hydratePaintedMasks(payload, RECT);
    t.ok('hydrate: brings the painted mask back', !!layers['fire::0']);
    t.ok('hydrate: no false mismatches on the same rect', mismatched.length === 0);
    t.ok('hydrate: round-trips the painted data', dataEqual(fire.data, layers['fire::0'].data));
  }

  // --- guards -------------------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, 5, 5, 30, { value: 255 }); // near the corner — clamps, does not throw
    t.ok('stamp: near-edge brush clamps without throwing', !isPaintLayerEmpty(layer));
    // Behaviour CHANGED by the coverage-floor fix below: a zero radius used
    // to be a true no-op (safe, but also the exact bug — see the next block).
    // It must still never crash, and must now RELIABLY paint the nearest
    // texel instead of silently doing nothing.
    stampBrushWorld(layer, CENTER.x, CENTER.y, 0, { value: 255 });
    t.ok(
      'stamp: a zero/tiny radius does not crash AND reliably paints the nearest texel',
      sampleMaskGridWorld(layer, CENTER.x, CENTER.y) > 0
    );
  }

  // --- THE COVERAGE-FLOOR BUG (2026-07-20): below ~0.71 texels of radius, a
  //     stamp's success used to depend on a coin-flip of sub-texel alignment
  //     — the exact mechanism behind "a dragged line breaks into dots" and
  //     "the smallest brush sometimes does nothing". Test several
  //     deliberately AWKWARD sub-texel offsets (not just one lucky centred
  //     alignment), on a real scene scale, and prove every one now paints. -
  {
    const bigRect = { x: 0, y: 0, width: 12000, height: 8000 }; // the real scene scale the bug was reported on
    const texelW = createPaintLayer(bigRect).spec.texelW; // ~5.86
    const tinyRadius = texelW * 0.3; // well under the old ~0.71-texel failure threshold
    for (const frac of [0, 0.25, 0.5, 0.75, 0.9]) {
      const layer = createPaintLayer(bigRect);
      const px = 6000 + frac * texelW; // deliberately NOT texel-centre-aligned
      stampBrushWorld(layer, px, 4000, tinyRadius, { value: 255, hardness: 1 });
      t.ok(`stamp: a tiny brush paints reliably at sub-texel offset ${frac}`, !isPaintLayerEmpty(layer));
    }
  }
}
