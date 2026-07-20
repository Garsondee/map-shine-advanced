/**
 * candle-flame-render.test.mjs — the PURE half of the candle runtime: the flame
 * geometry math (billboard corners, tip toward −Y, uv), the light-source
 * builder (descriptor shape MUST match what the viewer's light pool consumes),
 * the circle polygon, and the colour parse. The TSL material + THREE geometry
 * wrapper are browser-verified live (no DOM/WebGL mock — CONVENTIONS §4).
 */
import {
  hexToRgb01,
  candleCirclePolygon,
  buildCandleLightSources,
  clusterCandleAnchors,
  computeCandleFlameArrays,
} from '../candle-flame-render.js';

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

export function run(t) {
  const { ok } = t;

  // --- hexToRgb01 ----------------------------------------------------------
  {
    const [r, g, b] = hexToRgb01('#ffaa00');
    ok('#ffaa00 → red 1', approx(r, 1));
    ok('#ffaa00 → green 0xaa/255', approx(g, 0xaa / 255));
    ok('#ffaa00 → blue 0', approx(b, 0));
    ok(
      '#ffffff → white',
      hexToRgb01('#ffffff').every((c) => approx(c, 1))
    );
    ok(
      '#000000 → black',
      hexToRgb01('#000000').every((c) => approx(c, 0))
    );
    ok('a hex without # still parses', approx(hexToRgb01('ffaa00')[0], 1));
    ok(
      'a malformed colour falls back to a warm orange (never throws)',
      hexToRgb01('nope')[0] === 1 && hexToRgb01('nope')[2] === 0
    );
  }

  // --- candleCirclePolygon -------------------------------------------------
  {
    const poly = candleCirclePolygon(100, 200, 50, 16);
    ok('16 segments → 32 flat numbers', poly.length === 32);
    let onCircle = true;
    for (let i = 0; i < poly.length; i += 2) {
      const dx = poly[i] - 100;
      const dy = poly[i + 1] - 200;
      if (!approx(Math.hypot(dx, dy), 50, 1e-4)) onCircle = false;
    }
    ok('every point sits on the circle of the given radius', onCircle);
    ok('segments below 3 are floored to a valid polygon', candleCirclePolygon(0, 0, 10, 1).length >= 6);
  }

  // --- clusterCandleAnchors — the perf lever (nearby candles share a light) --
  {
    // radius 400 → cell 200. These three are within one cell → one cluster.
    const chandelier = clusterCandleAnchors(
      [
        { id: 'c', x: 100, y: 100 },
        { id: 'a', x: 110, y: 105 },
        { id: 'b', x: 95, y: 112 },
      ],
      200
    );
    ok('a tight cluster of candles becomes ONE cluster', chandelier.length === 1);
    ok('the cluster carries its member count', chandelier[0].count === 3);
    ok('the cluster id is the sorted member ids (stable for pool reuse)', chandelier[0].id === 'a,b,c');
    ok(
      'the cluster sits at the member centroid',
      approx(chandelier[0].x, (100 + 110 + 95) / 3) && approx(chandelier[0].y, (100 + 105 + 112) / 3)
    );

    // Two candles far apart (> one cell) stay separate.
    const spread = clusterCandleAnchors(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 900, y: 900 },
      ],
      200
    );
    ok('candles more than a cell apart do NOT merge', spread.length === 2);
    ok(
      'non-finite anchors are dropped from clustering',
      clusterCandleAnchors([{ id: 'a', x: NaN, y: 0 }], 200).length === 0
    );
  }

  // --- buildCandleLightSources — the descriptor the light pool expects -----
  {
    // Far apart → one cluster-light each; the lone anchor's id passes through.
    const lights = buildCandleLightSources(
      [
        { id: 'a', x: 10, y: 20 },
        { id: 'b', x: 9000, y: 9000 },
      ],
      { lightRadiusPx: 150, colorHex: '#ffaa00' }
    );
    ok('far-apart candles → one light each', lights.length === 2);
    const L = lights.find((l) => l.sourceId === 'candle:a');
    ok('a lone-cluster sourceId is its anchor id (unique vs Foundry lights)', !!L);
    ok('position comes from the anchor', L.x === 10 && L.y === 20);
    ok('radius comes from the param', L.radius === 150);
    ok('carries a circular shapePoints polygon', Array.isArray(L.shapePoints) && L.shapePoints.length === 64);
    ok(
      'declares the fields the pool reconcile reads',
      [
        'sourceId',
        'x',
        'y',
        'radius',
        'shapePoints',
        'ratio',
        'attenuation01',
        'luminosity01',
        'hasColor',
        'alpha01',
        'color',
        'animation',
      ].every((k) => k in L)
    );
    ok('a candle light has colour (it tints the floor warm)', L.hasColor === true);
    ok('the light colour is the parsed flame colour', approx(L.color[0], 1) && approx(L.color[2], 0));
    ok(
      'a candle light carries a "no animation" shape (Foundry-shaped, not a bare-absent field — see this ' +
        "module's own comment) so the animated-lights pool wiring never chokes on it",
      L.animation && L.animation.type === null && typeof L.animation.speedRaw === 'number'
    );

    // A chandelier's candles merge into ONE light (perf + a single pooled glow).
    const merged = buildCandleLightSources(
      [
        { id: 'a', x: 100, y: 100 },
        { id: 'b', x: 120, y: 110 },
        { id: 'c', x: 90, y: 95 },
      ],
      { lightRadiusPx: 400, colorHex: '#ffaa00' }
    );
    ok('a chandelier of candles casts ONE merged light', merged.length === 1);
    ok('the merged light id encodes its members', merged[0].sourceId === 'candle:a,b,c');

    // radius 0 = "a flame with no light" (the param help's promise), not a default.
    ok(
      'lightRadiusPx 0 emits NO light sources',
      buildCandleLightSources([{ id: 'a', x: 10, y: 20 }], { lightRadiusPx: 0, colorHex: '#ffaa00' }).length === 0
    );
    ok(
      'a negative radius emits none',
      buildCandleLightSources([{ id: 'a', x: 10, y: 20 }], { lightRadiusPx: -5, colorHex: '#fff000' }).length === 0
    );

    // bad anchors are skipped, never crash the batch.
    const dirty = buildCandleLightSources(
      [
        { id: 'ok', x: 1, y: 2 },
        { id: 'nan', x: 'x', y: 2 },
        { x: 5, y: 5 },
      ],
      { lightRadiusPx: 100, colorHex: '#ffaa00' }
    );
    ok(
      'non-finite anchors are skipped',
      dirty.every((l) => Number.isFinite(l.x) && Number.isFinite(l.y))
    );
  }

  // --- computeCandleFlameArrays — a square CENTRED on the wick ---------------
  {
    const { positions, uvs, indices, quadCount } = computeCandleFlameArrays([{ x: 100, y: 200 }], { sizePx: 48 });
    ok('one quad per candle', quadCount === 1);
    ok('4 verts × 3 = 12 position floats', positions.length === 12);
    ok('4 verts × 2 = 8 uv floats', uvs.length === 8);
    ok('2 tris × 3 = 6 indices', indices.length === 6);

    // A square CENTRED on the wick: verts span cx±half, cy±half (half = 24).
    // The wick (anchor) sits at the quad centre → uv (0.5,0.5) → the round base.
    ok('the quad is centred on the candle x (100)', approx((positions[0] + positions[3]) / 2, 100));
    ok('the quad is centred on the candle y (200)', approx((positions[1] + positions[7]) / 2, 200));
    ok('the quad spans ± half-size around the wick', positions[1] === 176 && positions[7] === 224);
    ok('the quad is square (width === height)', positions[3] - positions[0] === positions[7] - positions[1]);

    // uv: (0,0) → (1,1) across the square, so the wick lands at (0.5, 0.5).
    ok('uv runs 0..1 across the square', uvs[0] === 0 && uvs[1] === 0 && uvs[4] === 1 && uvs[5] === 1);
    ok('indices reference this quad’s own 4 verts', Math.max(...indices) === 3);

    // two candles → a second quad indexed off base+4.
    const two = computeCandleFlameArrays(
      [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ],
      { sizePx: 10 }
    );
    ok('two candles → two quads, batched into one geometry', two.quadCount === 2 && two.positions.length === 24);
    ok('the second quad’s indices are offset by 4', two.indices[6] === 4);

    // a non-finite anchor is dropped from the batch (belt-and-braces).
    const skipped = computeCandleFlameArrays(
      [
        { x: 1, y: 1 },
        { x: NaN, y: 2 },
      ],
      { sizePx: 10 }
    );
    ok('a non-finite anchor is not baked into the geometry', skipped.quadCount === 1);
  }
}
