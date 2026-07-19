/**
 * paint-mask.js — the pure painted-mask model, brush, codec, persistence.
 * Cross-checks the brush against mask-derive's OWN sampler so paint and read
 * can never disagree about where a world point lands (the anti-Y-flip guard).
 */
import {
  createPaintLayer,
  stampBrushWorld,
  isPaintLayerEmpty,
  encodePaintLayer,
  decodePaintLayer,
  encodedByteEstimate,
  serializePaintedMasks,
  hydratePaintedMasks,
  sampleMaskGridWorld,
  PAINT_EMBED_BYTE_BUDGET,
} from '../paint-mask.js';

const RECT = { x: 0, y: 0, width: 1000, height: 800 };
const CENTER = { x: 500, y: 400 };

const dataEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function run(t) {
  // --- model -------------------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    t.ok('createPaintLayer: 512 on the long side', layer.spec.w === 512);
    t.ok('createPaintLayer: shorter side scaled by aspect', layer.spec.h === Math.round((800 * 512) / 1000));
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

  // --- codec round-trip ---------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 130, { value: 200, hardness: 0.4 });
    stampBrushWorld(layer, 200, 200, 60, { value: 255, hardness: 0.7 });
    const encoded = encodePaintLayer(layer);
    const { layer: back, dimensionsMatch } = decodePaintLayer(encoded, RECT);
    t.ok('codec: round-trips byte-for-byte', dataEqual(layer.data, back.data));
    t.ok('codec: dimensions match the same scene rect', dimensionsMatch === true);
    t.ok('codec: a sparse mask is well under the embed budget', encodedByteEstimate(encoded) < PAINT_EMBED_BYTE_BUDGET);
  }

  // --- a resized scene is REPORTED, not silently stretched ----------------
  {
    const layer = createPaintLayer(RECT); // 512 x 410
    stampBrushWorld(layer, CENTER.x, CENTER.y, 80, { value: 255 });
    const encoded = encodePaintLayer(layer);
    const { dimensionsMatch } = decodePaintLayer(encoded, { x: 0, y: 0, width: 800, height: 800 }); // -> 512 x 512
    t.ok('codec: a resolution change is reported as a mismatch', dimensionsMatch === false);
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
    stampBrushWorld(layer, CENTER.x, CENTER.y, 0, { value: 255 }); // zero radius — must not divide by zero
    t.ok('stamp: zero-radius brush is a no-op, not a crash', sampleMaskGridWorld(layer, CENTER.x, CENTER.y) === 0);
  }
}
