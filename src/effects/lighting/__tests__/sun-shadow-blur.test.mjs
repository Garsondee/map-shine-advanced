/**
 * THE TWO BLURS THAT DETACHED SHADOWS FROM THEIR CASTERS, pinned.
 *
 * Author, live on the real Town River Bridge map (2026-08-02): *"Sky reach and
 * building shadows both appear to be heavily blurred, so heavily that they
 * detach from buildings"*, and *"pulls the shadow away from building edges
 * unrealistically"*.
 *
 * Two independent causes, both measured from their own report rather than
 * guessed:
 *
 * 1. THE DEPTH GRADIENT REPLACED THE SILHOUETTE. At `skyReachDepthPx = 1300`
 *    on a 2048-wide layer texture (5.2 world px/texel) the nested reads ask
 *    for mip 6.4 / 7.4 / 8.0 — and mip 8 is EIGHT BY FOUR texels for the whole
 *    10650×4950 map. Used as the coverage outright, that wash WAS the shadow's
 *    shape, so it spread ~1300 px past any real edge. It now MULTIPLIES the
 *    sharp read instead.
 *
 * 2. THE RECEIVER GATE WAS PRE-BLURRED (`GATE_AA_LOD = log2(4)`), which is 21
 *    world px on that scene — enough to start the shadow weak at the wall.
 *    Reverted to 0.
 *
 * The blur ledger (`describeBakeBlur`) exists so neither can ever again be
 * invisible in a report: it prints the LOD and the world-px footprint of every
 * read the bake makes, with no GPU readback.
 */
import { describeBakeBlur, describeLayerChannels } from '../sun-shadow-subsystem.js';
import { MAX_LOD, GATE_AA_LOD } from '../layer-smear-render.js';
import { resolveLayerSmear, layerSmearVisibility, SHADOW_LAYER_COUNT, DEPTH_SCALES } from '../layer-smear.js';

/** The author's own reported scene, so these numbers are the real ones. */
const REAL = Object.freeze({
  rect: { minX: 2700, minY: 1350, maxX: 13350, maxY: 6300 },
  layerGridDimPx: 2048,
  maxThrowPx: 115,
  steps: 48,
  softnessMul: 0.25,
  depthRadiusPx: 1300,
});

export function run(t) {
  const { ok } = t;

  // ── 🔒 THE DEPTH TERM MUST NOT INVENT COVERAGE OUTSIDE THE SILHOUETTE ──
  // This is THE regression guard for cause 1, and it is written as a
  // BEHAVIOUR ("nothing outside the caster") rather than as the formula, so a
  // future re-tuning that keeps the property still passes.
  {
    const HALF = 300;
    // A single square slab in the FLOOR-ABOVE layer (index 2) — the only layer
    // that carries a depth radius in production.
    const sampleLayers = (x, y) => {
      const out = new Array(SHADOW_LAYER_COUNT).fill(0);
      if (Math.abs(x) <= HALF && Math.abs(y) <= HALF) out[2] = 1;
      return out;
    };
    const heightsPx = [0, 0, 400, 0];
    // A sun HIGH overhead, so the directional throw is tiny and anything we
    // measure far from the slab can only have come from the depth wash.
    const resolved = resolveLayerSmear({ azimuthDeg: 220, elevationDeg: 80, heightsPx });
    const visAt = (x, y, r) =>
      layerSmearVisibility({
        x,
        y,
        sampleLayers,
        resolved,
        depthRadiusPx: [0, 0, r, 0],
        steps: 32,
      });

    const R = 1300;
    // WELL outside the slab, but comfortably INSIDE the depth radius — the
    // exact place the old code painted shadow out of nothing.
    const farOutside = HALF + R * 0.5;
    ok(
      `the depth gradient casts NOTHING ${Math.round(R * 0.5)}px outside the caster, ` +
        `though that is well inside its own ${R}px radius (got ${visAt(farOutside, farOutside, R).toFixed(3)})`,
      visAt(farOutside, farOutside, R) > 0.999
    );

    // ...and the picture beyond the slab must not depend on the radius at all.
    ok(
      'growing the depth radius does not grow the shadow outward — the silhouette bounds it',
      Math.abs(visAt(farOutside, farOutside, 400) - visAt(farOutside, farOutside, 2000)) < 1e-6
    );

    // ⚠️ THE GRADIENT'S OWN TESTS USE A RADIUS SIZED TO THE SLAB, not the
    // 1300px one above — `isotropicDepthTerm`'s own rule is "about HALF the
    // widest covered span", and this slab is 600px across. Measured while
    // writing this file: at r=1300 on a 600px slab EVERY sample ring lands
    // outside the slab, so the depth term reads ~0 everywhere on it and the
    // gradient inverts. That is the documented mis-sizing, not a defect — but
    // it is exactly the trap a future reader would fall into, so both radii
    // appear here on purpose: the leak guard above must hold at ANY radius,
    // while the gradient itself is only meaningful at a sane one.
    const R_FIT = HALF; // half the span, per the sizing rule

    // NON-VACUITY: the layer must genuinely be casting, or "nothing outside"
    // is trivially true and this whole block proves nothing.
    const centre = visAt(0, 0, R_FIT);
    ok(
      `the slab DOES shadow its own centre, so the guard above is not vacuous (got ${centre.toFixed(3)})`,
      centre < 0.9
    );

    // And the FEATURE still works: deeper in is darker than near the edge.
    const nearEdge = visAt(HALF * 0.9, 0, R_FIT);
    ok(
      `the gradient survives the fix — centre (${centre.toFixed(3)}) is darker than near-edge (${nearEdge.toFixed(3)})`,
      centre < nearEdge - 1e-4
    );
  }

  // ── 🔒 THE RECEIVER GATE IS SHARP ────────────────────────────────────
  {
    ok(
      `GATE_AA_LOD is 0 — the receiver gate reads the wall channel SHARP (is ${GATE_AA_LOD}). ` +
        'Any non-zero value blurs the indoor/outdoor boundary and walks the shadow off its wall.',
      GATE_AA_LOD === 0
    );
  }

  // ── THE CHANNEL LEDGER SEPARATES "BLURRED BY US" FROM "ARRIVED BLURRED" ──
  {
    const W = 64,
      H = 32;
    const mk = (fill) => {
      const d = new Uint8Array(W * H * 4);
      for (let i = 0; i < W * H; i++) d[i * 4] = fill(i % W, Math.floor(i / W));
      return d;
    };
    // A CRISP silhouette: a hard-edged block, so only its boundary column is
    // partial. Few soft texels relative to covered ones.
    const crisp = describeLayerChannels(
      mk((x) => (x < 32 ? 255 : 0)),
      W,
      H
    );
    // The SAME shape arriving pre-blurred — a long ramp instead of an edge.
    const blurred = describeLayerChannels(
      mk((x) => Math.max(0, Math.min(255, Math.round(255 * (1 - x / 63))))),
      W,
      H
    );

    ok(`a crisp silhouette reports a LOW softEdgePct (${crisp.walls.softEdgePct}%)`, crisp.walls.softEdgePct < 10);
    ok(
      `the same shape arriving pre-blurred reports a HIGH one (${blurred.walls.softEdgePct}%) — this is the ` +
        'figure that tells "the shader blurred it" apart from "the input was already soft"',
      blurred.walls.softEdgePct > 80
    );
    ok(
      'both agree the channel is covered — softEdgePct is about SHARPNESS, not amount',
      crisp.walls.coveredPct > 40 && blurred.walls.coveredPct > 40
    );
    ok(
      'an empty channel reports zeros rather than NaN from a 0/0',
      crisp.higher.coveredPct === 0 && crisp.higher.softEdgePct === 0
    );
    // ⚠️ The report carries its own thresholds, because `casterField.coveredPct`
    // one level up counts `> 0` and these count `> 8`. Two differently-measured
    // numbers both called "covered" is how a reader reaches a confident wrong
    // conclusion.
    ok(
      'the channel ledger states the thresholds it used, in the report itself',
      crisp.thresholds && crisp.thresholds.emptyAtOrBelow > 0 && crisp.thresholds.solidAtOrAbove < 255
    );
  }

  // ── THE BLUR LEDGER TELLS THE TRUTH ──────────────────────────────────
  {
    const b = describeBakeBlur(REAL);

    ok('the ledger derives texelWorldPx as max(rect) / layerGridDim', Math.abs(b.texelWorldPx - 10650 / 2048) < 0.01);
    ok(
      `at the author's real settings the DIRECTIONAL read is not the blur — tipLod ${b.directional.tipLod}, ` +
        `limited by ${b.directional.limitedBy}`,
      b.directional.tipLod === 0 && b.directional.limitedBy === 'texelFloor'
    );
    ok(
      'the ledger reports one entry per nested depth scale',
      Array.isArray(b.depthGradient) && b.depthGradient.length === DEPTH_SCALES
    );
    // THE number that made the bug obvious the moment it was printed.
    ok(
      `the ledger surfaces how much map ONE texel of the coarsest read covers (${b.coarsestReadCoversWorldPx}px) — ` +
        'the single figure that made a 1300px radius self-evidently absurd',
      b.coarsestReadCoversWorldPx > 1000
    );
    ok(
      'a coarse depth read is reported as a tiny map-wide texel span, not a big-sounding LOD',
      b.depthGradient[DEPTH_SCALES - 1].mapSpanTexels < 16
    );

    // Turning the gradient off must be visible AS off, not as a zero radius
    // the reader has to interpret.
    const off = describeBakeBlur({ ...REAL, depthRadiusPx: 0 });
    ok('depthRadiusPx 0 reports the gradient as explicitly off', typeof off.depthGradient === 'string');

    // The ledger must never claim a level the shader would not request.
    const absurd = describeBakeBlur({ ...REAL, depthRadiusPx: 1e9 });
    ok(
      `the ledger clamps to the shader's own MAX_LOD (${MAX_LOD}) rather than inventing a level`,
      absurd.depthGradient.every((d) => d.lod <= MAX_LOD)
    );

    // And it must refuse to answer before there is anything to describe.
    ok(
      'with no layer texture uploaded the ledger says UNMEASURABLE rather than dividing by zero',
      describeBakeBlur({ ...REAL, layerGridDimPx: 0 }).unmeasurable !== undefined
    );
  }
}
