/**
 * candle-flame-geometry.test.mjs — the PURE half of the candle runtime (split
 * out of candle-flame-render.js 2026-07-25, the size-ratchet god-object
 * reversal): the flame geometry math (billboard corners, tip toward −Y, uv),
 * the light-source builder (descriptor shape MUST match what the viewer's
 * light pool consumes), the circle polygon, and the colour parse. The TSL
 * material + THREE geometry wrapper stay in candle-flame-render.js,
 * browser-verified live (no DOM/WebGL mock — CONVENTIONS §4).
 */
import {
  hexToRgb01,
  candleCirclePolygon,
  buildCandleLightSources,
  candleAnimationQualityTier,
  candleClusterLightParams,
  clusterCandleAnchors,
  computeCandleFlameArrays,
  deriveCandleSeed,
  resolveAnchorColorHex,
  resolveAnchorSizePx,
  resolveAnchorLightRadiusPx,
} from '../candle-flame-geometry.js';
import { LIGHT_ELEVATION_UNCONFIGURED_SENTINEL } from '../lighting/point-light-illumination.js';

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

  // --- resolveAnchorColorHex/SizePx/LightRadiusPx — the override gate ------
  {
    const plain = { params: { useCustomColor: false, useCustomSize: false, useCustomLightRadius: false } };
    const custom = {
      params: {
        useCustomColor: true,
        customColor: '#00ff88',
        useCustomSize: true,
        customSizePx: 60,
        useCustomLightRadius: true,
        customLightRadiusPx: 900,
      },
    };
    ok('no override -> the shared colour wins', resolveAnchorColorHex(plain, '#ffaa00') === '#ffaa00');
    ok('an active override -> the candle’s own colour wins', resolveAnchorColorHex(custom, '#ffaa00') === '#00ff88');
    ok(
      'a gate off with a stray custom value still inherits',
      resolveAnchorColorHex({ params: { useCustomColor: false, customColor: '#000000' } }, '#ffaa00') === '#ffaa00'
    );
    ok('an anchor with no params at all inherits (never throws)', resolveAnchorColorHex({}, '#ffaa00') === '#ffaa00');
    ok(
      'an invalid shared colour still falls back to a warm orange',
      resolveAnchorColorHex({}, undefined) === '#ffaa00'
    );

    ok('no override -> the shared size wins', resolveAnchorSizePx(plain, 24) === 24);
    ok('an active override -> the candle’s own size wins', resolveAnchorSizePx(custom, 24) === 60);
    ok('a non-finite shared size falls back to 1 (never NaN/0)', resolveAnchorSizePx(plain, NaN) === 1);
    ok(
      'an override of 0/negative is invalid and falls back to the shared value',
      resolveAnchorSizePx({ params: { useCustomSize: true, customSizePx: 0 } }, 24) === 24
    );

    ok('no override -> the shared light radius wins', resolveAnchorLightRadiusPx(plain, 400) === 400);
    ok('an active override -> the candle’s own reach wins', resolveAnchorLightRadiusPx(custom, 400) === 900);
    ok(
      'an override of exactly 0 is a legitimate "no light from this candle" choice',
      resolveAnchorLightRadiusPx({ params: { useCustomLightRadius: true, customLightRadiusPx: 0 } }, 400) === 0
    );
    ok(
      'a negative override is invalid and falls back to the shared radius',
      resolveAnchorLightRadiusPx({ params: { useCustomLightRadius: true, customLightRadiusPx: -5 } }, 400) === 400
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

    // --- windExposure aggregation (Wind.md Tier 0) ---------------------------
    // A sheltered candle (0) and a fully-exposed one (1) in the same cluster
    // average to a partly-exposed light — neither shelter extreme wins outright.
    const mixedExposure = clusterCandleAnchors(
      [
        { id: 'a', x: 100, y: 100, windExposure: 0 },
        { id: 'b', x: 110, y: 105, windExposure: 1 },
      ],
      200
    );
    ok('a cluster AVERAGES member windExposure', mixedExposure.length === 1 && approx(mixedExposure[0].exposure, 0.5));
    ok(
      'an anchor with no windExposure counts as fully outdoors (1), matching computeCandleFlameArrays',
      approx(clusterCandleAnchors([{ id: 'a', x: 1, y: 2 }], 200)[0].exposure, 1)
    );
    ok(
      'an out-of-range windExposure clamps into [0,1] before averaging',
      approx(clusterCandleAnchors([{ id: 'a', x: 1, y: 2, windExposure: 7 }], 200)[0].exposure, 1) &&
        approx(clusterCandleAnchors([{ id: 'a', x: 1, y: 2, windExposure: -3 }], 200)[0].exposure, 0)
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
    // Radius now carries the flat +25% inverse-square boost (× a gentle
    // per-position/strength factor), so it is ABOVE the raw param, not equal.
    ok(
      'radius carries the inverse-square +25% boost (above the raw param)',
      L.radius > 150 && Number.isFinite(L.radius)
    );
    ok('carries a circular shapePoints polygon', Array.isArray(L.shapePoints) && L.shapePoints.length === 64);
    ok('a candle uses the inverse-square falloff model (not Foundry corona)', L.falloffModel === 'inverseSquare');
    ok(
      'declares the fields the pool reconcile reads',
      [
        'sourceId',
        'x',
        'y',
        'radius',
        'windExposure',
        'shapePoints',
        'ratio',
        'attenuation01',
        'luminosity01',
        'hasColor',
        'alpha01',
        'color',
        'falloffModel',
        'animation',
      ].every((k) => k in L)
    );
    ok(
      'a lone anchor with no windExposure carries the fully-outdoors default (1) onto its light',
      approx(L.windExposure, 1)
    );
    ok(
      "a light's windExposure is the cluster's averaged member exposure",
      approx(
        buildCandleLightSources(
          [
            { id: 'a', x: 100, y: 100, windExposure: 0.2 },
            { id: 'b', x: 110, y: 105, windExposure: 0.8 },
          ],
          { lightRadiusPx: 150, colorHex: '#ffaa00' }
        )[0].windExposure,
        0.5
      )
    );
    ok('a light carries a windResponse field for candle-flicker.js to read', 'windResponse' in L);
    ok('omitting windResponse defaults every light to 1 (the tuned reference)', approx(L.windResponse, 1));
    ok(
      "the effect's windResponse param flows onto every light in the batch",
      buildCandleLightSources(
        [
          { id: 'a', x: 100, y: 100 },
          { id: 'b', x: 9000, y: 9000 },
        ],
        { lightRadiusPx: 150, colorHex: '#ffaa00', windResponse: 1.7 }
      ).every((l) => approx(l.windResponse, 1.7))
    );
    ok(
      'windResponse: 0 (a wind-inert candle) is honoured, not treated as "missing" (falsy but finite)',
      approx(
        buildCandleLightSources([{ id: 'a', x: 10, y: 20 }], {
          lightRadiusPx: 150,
          colorHex: '#ffaa00',
          windResponse: 0,
        })[0].windResponse,
        0
      )
    );
    ok('a candle light has colour (it tints the floor warm)', L.hasColor === true);
    ok('the light colour is the parsed flame colour', approx(L.color[0], 1) && approx(L.color[2], 0));
    ok(
      'a candle light carries a Foundry-shaped animation object (not a bare-absent field) so the animated-lights pool wiring never chokes on it',
      L.animation && typeof L.animation.speedRaw === 'number'
    );
    ok(
      "a candle light defaults to MSA's own candleFlicker type (2026-07-20, author-directed), not Foundry's torch verbatim",
      L.animation.type === 'candleFlicker'
    );
    ok(
      'a candle light carries a position-derived seed, not a shared 0',
      typeof L.animation.seed === 'number' && L.animation.seed === deriveCandleSeed(L.x, L.y)
    );
    ok(
      'a candle light carries a build-time animation quality tier (integer, for candle-flicker.js JS-if gating)',
      L.animation.quality === 2 // 'lavish' default (no animationQuality passed above)
    );

    // ANIMATION QUALITY TIER — the enum→int map (candle-flicker.js's ladder).
    ok('animationQuality "low" → tier 0', candleAnimationQualityTier('low') === 0);
    ok('animationQuality "standard" → tier 1', candleAnimationQualityTier('standard') === 1);
    ok('animationQuality "lavish" → tier 2', candleAnimationQualityTier('lavish') === 2);
    ok(
      'an unknown quality falls back to the richest tier (matches the param default)',
      candleAnimationQualityTier('bogus') === 2
    );
    ok('a missing quality falls back to the richest tier', candleAnimationQualityTier(undefined) === 2);
    ok(
      'the resolved tier flows onto the descriptor (low → quality 0)',
      buildCandleLightSources([{ id: 'a', x: 10, y: 20 }], {
        lightRadiusPx: 400,
        colorHex: '#ffaa00',
        animationQuality: 'low',
      })[0].animation.quality === 0
    );
    ok(
      'the resolved tier flows onto the descriptor (standard → quality 1)',
      buildCandleLightSources([{ id: 'a', x: 10, y: 20 }], {
        lightRadiusPx: 400,
        colorHex: '#ffaa00',
        animationQuality: 'standard',
      })[0].animation.quality === 1
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
    // …and that merged 3-candle light is BRIGHTER than a lone candle at the
    // same spot (the author's "combine lots of candles → brighter spaces").
    const lone = buildCandleLightSources([{ id: 'a', x: 100, y: 100 }], { lightRadiusPx: 400, colorHex: '#ffaa00' })[0];
    ok('a 3-candle cluster out-glows a single candle (higher coloration alpha)', merged[0].alpha01 > lone.alpha01);
    ok('a 3-candle cluster lifts the floor more (higher luminosity)', merged[0].luminosity01 > lone.luminosity01);

    // --- candleClusterLightParams — the strength → brightness/reach map -------
    // A single candle (strength ~1) is much dimmer than the ~4-candle reference;
    // a big candelabra is brighter. This is the author's #2/#3 directly.
    const one = candleClusterLightParams(1, 400);
    const four = candleClusterLightParams(4, 400);
    const eight = candleClusterLightParams(8, 400);
    ok('one candle sits below the neutral reference (dimmer exposure)', one.luminosity01 < 0.5);
    ok('≈4 candles land at the neutral reference (exposure ~0)', approx(four.luminosity01, 0.5, 1e-9));
    ok('8 candles are brighter than the reference', eight.luminosity01 > 0.5);
    ok(
      'coloration strength scales monotonically with candle count',
      one.alpha01 < four.alpha01 && four.alpha01 < eight.alpha01
    );
    ok('a single candle is roughly a quarter of the reference glow', approx(one.alpha01, four.alpha01 / 4, 1e-9));
    ok(
      'radius carries the flat +25% boost at the single-candle reference',
      approx(candleClusterLightParams(1, 400).radius, 500, 1e-9)
    );
    ok('more candles reach further', eight.radius > one.radius);
    ok(
      'brightness is clamped, never blown out or negative',
      candleClusterLightParams(999, 400).luminosity01 <= 1 && candleClusterLightParams(0.01, 400).luminosity01 >= 0.05
    );
    ok(
      'a degenerate strength/radius never throws or yields NaN',
      Number.isFinite(candleClusterLightParams(NaN, NaN).radius)
    );

    // --- cluster intensity aggregation — Σ per-anchor intensity --------------
    const dimCluster = clusterCandleAnchors(
      [
        { id: 'a', x: 100, y: 100, params: { intensity: 0.25 } },
        { id: 'b', x: 110, y: 105, params: { intensity: 0.25 } },
      ],
      200
    );
    ok('a cluster SUMS its members’ burn intensity', dimCluster.length === 1 && approx(dimCluster[0].intensity, 0.5));
    ok(
      'a param-less anchor counts as a full candle (intensity 1) — older callers still cluster',
      clusterCandleAnchors([{ id: 'a', x: 1, y: 2 }], 200)[0].intensity === 1
    );

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

    // --- per-candle overrides never merge into the shared cluster light ------
    {
      // Three tight-packed plain candles + one tight-packed RECOLOURED one, all
      // within one clustering cell.
      const anchors = [
        { id: 'a', x: 100, y: 100 },
        { id: 'b', x: 105, y: 102 },
        { id: 'c', x: 98, y: 103 },
        { id: 'special', x: 101, y: 101, params: { useCustomColor: true, customColor: '#22ff44' } },
      ];
      const withOverride = buildCandleLightSources(anchors, { lightRadiusPx: 400, colorHex: '#ffaa00' });
      ok('the recoloured candle gets its OWN light, never merged', withOverride.length === 2);
      const specialLight = withOverride.find((l) => l.sourceId === 'candle:special');
      const plainLight = withOverride.find((l) => l.sourceId !== 'candle:special');
      ok('the solo override light exists and is coloured correctly', approx(specialLight.color[1], 1));
      ok('the untouched trio still merges into one shared light', plainLight.sourceId === 'candle:a,b,c');
      ok(
        'the shared light keeps the GLOBAL colour, unaffected by its neighbour',
        approx(plainLight.color[0], 1) && approx(plainLight.color[1], 0.667, 1e-3)
      );

      // Byte-identical default: dropping the override anchor entirely leaves
      // the remaining trio's light UNCHANGED.
      const withoutOverride = buildCandleLightSources(anchors.slice(0, 3), { lightRadiusPx: 400, colorHex: '#ffaa00' });
      ok(
        'an un-customised cluster renders identically whether or not a customised neighbour exists',
        approx(withoutOverride[0].radius, plainLight.radius) &&
          approx(withoutOverride[0].luminosity01, plainLight.luminosity01)
      );

      // A per-candle light-radius override, with the GLOBAL radius at 0 (every
      // plain candle emits no light) — the overridden one still casts light.
      const radiusOnly = buildCandleLightSources(
        [
          { id: 'dark1', x: 10, y: 10 },
          { id: 'lit', x: 500, y: 500, params: { useCustomLightRadius: true, customLightRadiusPx: 300 } },
        ],
        { lightRadiusPx: 0, colorHex: '#ffaa00' }
      );
      ok('a global radius of 0 still lets an overridden candle cast light', radiusOnly.length === 1);
      ok('the overridden candle’s own radius is honoured', radiusOnly[0].sourceId === 'candle:lit');

      // A per-candle override of light radius to exactly 0 correctly casts none.
      const overrideToDark = buildCandleLightSources(
        [{ id: 'snuffed', x: 1, y: 1, params: { useCustomLightRadius: true, customLightRadiusPx: 0 } }],
        { lightRadiusPx: 400, colorHex: '#ffaa00' }
      );
      ok('an overridden candle can legitimately opt OUT of casting light', overrideToDark.length === 0);
    }
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

  // --- computeCandleFlameArrays — per-candle wind attributes (center/exposure)
  {
    const { centers, exposures } = computeCandleFlameArrays([{ x: 100, y: 200, windExposure: 0.4 }], { sizePx: 48 });
    ok('center is 4 verts × 2 floats', centers.length === 8);
    ok('windExposure is 4 verts × 1 float', exposures.length === 4);
    // The wick's WORLD position is baked identically on all 4 verts (so it reads
    // as a constant across the quad → clean per-candle wind, not a gradient).
    ok(
      'every vert carries the SAME wick center (the world xy)',
      centers[0] === 100 && centers[1] === 200 && centers[6] === 100 && centers[7] === 200
    );
    ok(
      'every vert carries the same wind exposure',
      exposures.every((e) => approx(e, 0.4))
    );

    // Exposure defaults to 1 (fully outdoors) when the anchor doesn't carry it,
    // and clamps to [0,1] for a garbage value — the mask catalog's own semantics.
    ok(
      'a candle with no windExposure defaults to fully outdoors (1)',
      computeCandleFlameArrays([{ x: 0, y: 0 }], { sizePx: 10 }).exposures[0] === 1
    );
    ok(
      'an out-of-range exposure is clamped into [0,1]',
      computeCandleFlameArrays([{ x: 0, y: 0, windExposure: 5 }], { sizePx: 10 }).exposures[0] === 1 &&
        computeCandleFlameArrays([{ x: 0, y: 0, windExposure: -3 }], { sizePx: 10 }).exposures[0] === 0
    );
  }

  // --- computeCandleFlameArrays — the flame's OWN height-gate input -----------
  {
    const { elevationRanks } = computeCandleFlameArrays([{ x: 0, y: 0, elevationRank: 2.5 }], { sizePx: 10 });
    ok('elevationRanks is 4 verts × 1 float', elevationRanks.length === 4);
    ok(
      'every vert of a quad carries the SAME baked rank — a flat per-candle value, not a gradient',
      elevationRanks.every((r) => approx(r, 2.5))
    );
    ok(
      'an anchor with NO elevationRank defaults to the SENTINEL, never 0 — a hand-built fixture (or a caller ' +
        'predating this field) must keep the OLD "always fully reaches" behaviour, not a silently-introduced gate',
      computeCandleFlameArrays([{ x: 0, y: 0 }], { sizePx: 10 }).elevationRanks[0] ===
        LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
    );
    ok(
      'a non-finite elevationRank ALSO reads as the sentinel, never NaN propagating into the shader',
      computeCandleFlameArrays([{ x: 0, y: 0, elevationRank: NaN }], { sizePx: 10 }).elevationRanks[0] ===
        LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
    );
  }

  // --- computeCandleFlameArrays — per-candle colour/size/brightness bake -----
  {
    // A plain candle bakes the SHARED colour + a default (1) brightness.
    const plain = computeCandleFlameArrays([{ x: 0, y: 0 }], { sizePx: 24, colorHex: '#ffaa00' });
    ok('colors is 4 verts × 3 floats', plain.colors.length === 12);
    ok('intensities is 4 verts × 1 float', plain.intensities.length === 4);
    ok(
      'a plain candle bakes the SHARED colour on every vertex',
      approx(plain.colors[0], 1) && approx(plain.colors[1], 0xaa / 255) && approx(plain.colors[2], 0)
    );
    ok(
      'a plain candle with no intensity param bakes full brightness (1)',
      plain.intensities.every((v) => approx(v, 1))
    );

    // A recoloured, resized, dimmed candle bakes ITS OWN values, not the shared ones.
    const custom = computeCandleFlameArrays(
      [
        {
          x: 0,
          y: 0,
          params: {
            useCustomColor: true,
            customColor: '#00ff00',
            useCustomSize: true,
            customSizePx: 100,
            intensity: 0.25,
          },
        },
      ],
      { sizePx: 24, colorHex: '#ffaa00' }
    );
    ok(
      'an overridden candle bakes its OWN colour, not the shared one',
      approx(custom.colors[0], 0) && approx(custom.colors[1], 1) && approx(custom.colors[2], 0)
    );
    ok(
      'an overridden candle bakes its OWN brightness',
      custom.intensities.every((v) => approx(v, 0.25))
    );
    ok(
      'an overridden candle bakes its OWN size (quad width 100, not the shared 24)',
      custom.positions[3] - custom.positions[0] === 100
    );

    // Two candles side by side, one plain and one recoloured — each keeps its
    // own colour (they are NOT averaged or bled into each other).
    const mixed = computeCandleFlameArrays(
      [
        { x: 0, y: 0 },
        { x: 10, y: 10, params: { useCustomColor: true, customColor: '#0000ff' } },
      ],
      { sizePx: 10, colorHex: '#ffaa00' }
    );
    ok('the first (plain) quad keeps the shared colour', approx(mixed.colors[0], 1) && approx(mixed.colors[2], 0));
    ok(
      'the second (overridden) quad keeps its own colour, unaffected by its neighbour',
      approx(mixed.colors[12], 0) && approx(mixed.colors[14], 1)
    );

    // Brightness clamps into [0,1] the same way every other 0..1 param does.
    const wildIntensity = computeCandleFlameArrays([{ x: 0, y: 0, params: { intensity: 7 } }], { sizePx: 10 });
    ok(
      'an out-of-range intensity clamps into [0,1] rather than blowing out the flame',
      wildIntensity.intensities[0] === 1
    );
  }
}
