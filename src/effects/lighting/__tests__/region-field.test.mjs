/**
 * THE SOFT EDGE (2026-11-04) — Node verification for the region field's pure
 * half (region-geometry.js, "THE SOFT EDGE"): the affine coefficients, the
 * tight shape boxes, the field plan, the bake hash, and a CPU twin of the
 * bake + blur that checks the two things the author asked for — a fade about
 * 30 px wide, and no bright seam between region shapes that touch.
 */
import {
  REGION_EDGE_FADE_PX,
  REGION_FIELD_TEXEL_PX,
  REGION_FIELD_MAX_DIM,
  REGION_FIELD_DIM_STEP,
  REGION_FIELD_BLUR_TAPS,
  regionFadeSigmaPx,
  regionFieldCoefficients,
  computeShapeWorldAabb,
  planRegionField,
  hashRegionFieldInputs,
  applyDarknessAdjustment,
  pointInRegionShapes,
  pointInRectangle,
  DARKNESS_ADJUST_MODES,
} from '../region-geometry.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/**
 * CPU twin of the GPU bake: draw regions HARD into a 1-D row of field texels
 * (brightest last wins, holes clear, exactly the viewer's order), then run the
 * same separable Gaussian `buildRegionFieldBlurMaterial` runs (centre + `taps`
 * each side, weights from sigma, normalised), clamping at the row's ends as a
 * clamp-to-edge sampler does. Returns per-texel { c, d } where d is the
 * region darkness the overlay rebuilds (premultiplied by c).
 */
function bakeAndBlurRow({ regions, base, y, x0, texelPx, count, sigmaTexels, taps }) {
  const sorted = regions
    .map((region) => ({ region, adjusted: applyDarknessAdjustment(base, region.mode, region.modifier) }))
    .sort((p, q) => q.adjusted - p.adjusted)
    .map((s) => s.region);
  const field = [];
  for (let i = 0; i < count; i++) {
    const x = x0 + (i + 0.5) * texelPx;
    let texel = { a: 0, b: 0, c: 0 };
    for (const region of sorted) {
      for (const shape of region.shapes) {
        if (shape.hole) continue;
        if (pointInRegionShapes(x, y, [shape])) {
          const { a, b } = regionFieldCoefficients(region.mode, region.modifier);
          texel = { a, b, c: 1 };
        }
      }
    }
    for (const region of sorted) {
      for (const shape of region.shapes) {
        if (shape.hole && pointInRegionShapes(x, y, [{ ...shape, hole: false }])) texel = { a: 0, b: 0, c: 0 };
      }
    }
    field.push(texel);
  }
  const weights = [];
  for (let k = 0; k <= taps; k++) weights.push(Math.exp(-(k * k) / Math.max(1e-4, 2 * sigmaTexels * sigmaTexels)));
  const norm = weights[0] + 2 * weights.slice(1).reduce((s, w) => s + w, 0);
  return field.map((_, i) => {
    let a = 0;
    let b = 0;
    let c = 0;
    for (let k = -taps; k <= taps; k++) {
      const j = Math.min(count - 1, Math.max(0, i + k));
      const w = weights[Math.abs(k)] / norm;
      a += field[j].a * w;
      b += field[j].b * w;
      c += field[j].c * w;
    }
    return { x: x0 + (i + 0.5) * texelPx, c, d: a + b * base };
  });
}

/** The texel nearest world x. */
const at = (row, x) => row.reduce((best, t) => (Math.abs(t.x - x) < Math.abs(best.x - x) ? t : best), row[0]);

export function run(t) {
  const { ok } = t;

  // ── the coefficients are the three Foundry formulas, exactly ──────────────
  {
    let worst = 0;
    for (const mode of [
      DARKNESS_ADJUST_MODES.OVERRIDE,
      DARKNESS_ADJUST_MODES.BRIGHTEN,
      DARKNESS_ADJUST_MODES.DARKEN,
      7,
    ]) {
      for (let bi = 0; bi <= 10; bi++) {
        for (let mi = 0; mi <= 10; mi++) {
          const base = bi / 10;
          const m = mi / 10;
          const { a, b } = regionFieldCoefficients(mode, m);
          worst = Math.max(worst, Math.abs(a + b * base - applyDarknessAdjustment(base, mode, m)));
        }
      }
    }
    ok('coefficients: a + b*base equals applyDarknessAdjustment for every mode (incl. unknown)', worst < 1e-12);
    const clamped = regionFieldCoefficients(DARKNESS_ADJUST_MODES.DARKEN, 3);
    ok('coefficients: modifier clamps to 0..1 as the formulas do', clamped.a === 1 && clamped.b === 0);
  }

  // ── the fade is ~30 px: sigma is a quarter of it ──────────────────────────
  ok('fade: default is 30 px', REGION_EDGE_FADE_PX === 30);
  ok('fade: sigma = fade / 4', near(regionFadeSigmaPx(30), 7.5));

  // ── tight boxes ───────────────────────────────────────────────────────────
  {
    const r = computeShapeWorldAabb({ type: 'rectangle', x: 100, y: 200, width: 300, height: 50 });
    ok(
      'aabb: unrotated rectangle is its own box',
      r.minX === 100 && r.minY === 200 && r.maxX === 400 && r.maxY === 250
    );
    const rot = computeShapeWorldAabb({ type: 'rectangle', x: 0, y: 0, width: 100, height: 20, rotation: 90 });
    ok(
      'aabb: 90 deg rectangle swaps its extents about the origin',
      near(rot.minX, -20, 1e-9) && near(rot.maxX, 0, 1e-9) && near(rot.minY, 0, 1e-9) && near(rot.maxY, 100, 1e-9)
    );
    const anch = computeShapeWorldAabb({
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      anchorX: 0.5,
      anchorY: 0.5,
    });
    ok('aabb: anchor shifts the box', anch.minX === -50 && anch.maxX === 50);
    // every corner of a rotated rectangle is inside its box, and the box is tight
    const shape = {
      type: 'rectangle',
      x: 500,
      y: 300,
      width: 400,
      height: 120,
      rotation: 33,
      anchorX: 0.2,
      anchorY: 0.7,
    };
    const box = computeShapeWorldAabb(shape);
    let inside = true;
    let touched = 0;
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        const x = box.minX + ((box.maxX - box.minX) * i) / 40;
        const y = box.minY + ((box.maxY - box.minY) * j) / 40;
        if (pointInRectangle(x, y, shape)) touched++;
      }
    }
    for (const [px, py] of [
      [box.minX - 1, (box.minY + box.maxY) / 2],
      [box.maxX + 1, (box.minY + box.maxY) / 2],
      [(box.minX + box.maxX) / 2, box.minY - 1],
      [(box.minX + box.maxX) / 2, box.maxY + 1],
    ]) {
      if (pointInRectangle(px, py, shape)) inside = false;
    }
    ok('aabb: a rotated, anchored rectangle never reaches past its box', inside);
    ok('aabb: ...and the box is not empty of it', touched > 100);
    const line = computeShapeWorldAabb({ type: 'line', x: 10, y: 10, length: 100, width: 20 });
    ok(
      'aabb: line spans its length and half its width each side',
      line.minX === 10 && line.maxX === 110 && line.minY === 0 && line.maxY === 20
    );
    const em = computeShapeWorldAabb({
      type: 'emanation',
      radius: 10,
      base: { type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
    });
    ok('aabb: rectangle emanation grows by its radius', em.minX === -10 && em.maxX === 60);
    const poly = computeShapeWorldAabb({ type: 'polygon', points: [0, 0, 100, 0, 50, 80] });
    ok("aabb: polygon is its points' box", poly.minX === 0 && poly.maxX === 100 && poly.maxY === 80);
    ok('aabb: degenerate shape is null', computeShapeWorldAabb({ type: 'rectangle', width: 0, height: 10 }) === null);
  }

  // ── the plan ──────────────────────────────────────────────────────────────
  {
    const boxes = [
      { minX: 1000, minY: 1000, maxX: 1400, maxY: 1200 },
      { minX: 1400, minY: 1000, maxX: 1800, maxY: 1300 },
    ];
    const plan = planRegionField(boxes, { minX: 0, minY: 0, maxX: 5000, maxY: 5000 });
    ok(
      'plan: the union plus one fade of margin is covered',
      plan.rect.minX <= 1000 - 30 && plan.rect.maxX >= 1800 + 30
    );
    ok('plan: ...on y too', plan.rect.minY <= 1000 - 30 && plan.rect.maxY >= 1300 + 30);
    ok('plan: small regions get the fine texel', plan.texelPx === REGION_FIELD_TEXEL_PX);
    ok(
      'plan: sides are whole steps',
      plan.width % REGION_FIELD_DIM_STEP === 0 && plan.height % REGION_FIELD_DIM_STEP === 0
    );
    ok(
      'plan: texels are square and the rect matches the size',
      near((plan.rect.maxX - plan.rect.minX) / plan.width, plan.texelPx) &&
        near((plan.rect.maxY - plan.rect.minY) / plan.height, plan.texelPx)
    );
    ok('plan: sigma is about two texels at the fine texel', near(plan.sigmaTexels, 7.5 / 4));
    ok('plan: the blur reaches past three sigmas', REGION_FIELD_BLUR_TAPS >= 3 * plan.sigmaTexels);

    const huge = planRegionField([{ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }], {
      minX: 0,
      minY: 0,
      maxX: 20000,
      maxY: 8000,
    });
    ok('plan: a huge region is clipped to the canvas, then margined', huge.rect.minX >= -100 && huge.rect.minX <= -30);
    ok('plan: the side cap holds', huge.width <= REGION_FIELD_MAX_DIM && huge.height <= REGION_FIELD_MAX_DIM);
    ok('plan: past the cap the texel grows instead', huge.texelPx > REGION_FIELD_TEXEL_PX);
    ok('plan: ...and still covers the canvas', huge.rect.maxX >= 20000 && huge.rect.maxY >= 8000);
    ok(
      'plan: nothing on the canvas -> null',
      planRegionField([{ minX: 9000, minY: 9000, maxX: 9100, maxY: 9100 }], {
        minX: 0,
        minY: 0,
        maxX: 5000,
        maxY: 5000,
      }) === null
    );
    ok('plan: no boxes -> null', planRegionField([], null) === null);
    ok('plan: null boxes are skipped', planRegionField([null, boxes[0]], null) !== null);
  }

  // ── the bake hash ─────────────────────────────────────────────────────────
  {
    const a = {
      regionId: 'A',
      mode: 2,
      modifier: 0.5,
      shapes: [{ type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }],
    };
    const b = { regionId: 'B', mode: 0, modifier: 0.9, shapes: [{ type: 'polygon', points: [0, 0, 10, 0, 5, 9] }] };
    const plan = planRegionField([{ minX: 0, minY: 0, maxX: 100, maxY: 100 }], null);
    const h = hashRegionFieldInputs([a, b], plan);
    ok('hash: stable for equal input', h === hashRegionFieldInputs([a, b], plan));
    ok(
      'hash: sort slots hash like the regions they wrap',
      h === hashRegionFieldInputs([{ region: a }, { region: b }], plan)
    );
    ok('hash: draw order matters (it decides overlaps)', h !== hashRegionFieldInputs([b, a], plan));
    ok('hash: a modifier change re-bakes', h !== hashRegionFieldInputs([{ ...a, modifier: 0.51 }, b], plan));
    ok(
      'hash: a moved shape re-bakes',
      h !== hashRegionFieldInputs([{ ...a, shapes: [{ ...a.shapes[0], x: 1 }] }, b], plan)
    );
    ok(
      'hash: a moved polygon point re-bakes',
      h !== hashRegionFieldInputs([a, { ...b, shapes: [{ type: 'polygon', points: [0, 0, 10, 0, 5, 9.5] }] }], plan)
    );
    ok(
      'hash: a hole flag re-bakes',
      h !== hashRegionFieldInputs([{ ...a, shapes: [{ ...a.shapes[0], hole: true }] }, b], plan)
    );
    const plan2 = planRegionField([{ minX: 0, minY: 0, maxX: 400, maxY: 100 }], null);
    ok('hash: a new plan re-bakes', h !== hashRegionFieldInputs([a, b], plan2));
  }

  // ── the CPU twin: the fade, and no seam where shapes touch ────────────────
  {
    const sigmaTexels = regionFadeSigmaPx() / REGION_FIELD_TEXEL_PX;
    const row = (regions, base = 0.2) =>
      bakeAndBlurRow({
        regions,
        base,
        y: 50,
        x0: -200,
        texelPx: REGION_FIELD_TEXEL_PX,
        count: 200,
        sigmaTexels,
        taps: REGION_FIELD_BLUR_TAPS,
      });

    // Two rectangles of ONE region touching along x = 200, and two separate
    // regions touching along x = 200: both must stay fully covered across the seam.
    const left = { type: 'rectangle', x: 0, y: 0, width: 200, height: 100 };
    const right = { type: 'rectangle', x: 200, y: 0, width: 200, height: 100 };
    const oneRegion = row([{ regionId: 'R', mode: 0, modifier: 0.9, shapes: [left, right] }]);
    const twoRegions = row([
      { regionId: 'L', mode: 0, modifier: 0.9, shapes: [left] },
      { regionId: 'Rt', mode: 0, modifier: 0.9, shapes: [right] },
    ]);
    const minCoverNearSeam = (r) => Math.min(...r.filter((t2) => t2.x > 150 && t2.x < 250).map((t2) => t2.c));
    ok(
      'seam: two shapes of one region keep full coverage across their shared edge',
      minCoverNearSeam(oneRegion) > 0.999
    );
    ok('seam: two touching regions keep full coverage across their shared edge', minCoverNearSeam(twoRegions) > 0.999);
    const minDarkNearSeam = Math.min(...twoRegions.filter((t2) => t2.x > 150 && t2.x < 250).map((t2) => t2.d / t2.c));
    ok('seam: ...and the same darkness, so nothing brightens there', minDarkNearSeam > 0.9 - 1e-6);

    // The outer edge: 50% at the authored line, and ~30 px from 2.5% to 97.5%.
    // The texels either side of the edge (centres 2 px out and 2 px in) average one half.
    ok(
      'edge: coverage is one half on the authored edge',
      near((at(oneRegion, -2).c + at(oneRegion, 2).c) / 2, 0.5, 1e-6)
    );
    const first = oneRegion.find((t2) => t2.c > 0.025);
    const full = oneRegion.find((t2) => t2.c > 0.975);
    const width = full.x - first.x;
    ok(`edge: the fade is about 30 px wide (measured ${width} px)`, width >= 24 && width <= 36);
    ok('edge: the fade is centred on the edge', first.x < 0 && full.x > 0);
    ok('edge: well outside is untouched', at(oneRegion, -100).c < 1e-6);
    ok(
      'edge: well inside is the hard value',
      near(at(oneRegion, 100).c, 1, 1e-6) && near(at(oneRegion, 100).d, 0.9, 1e-6)
    );

    // Different darkness meeting: a smooth step, never brighter than the brighter side.
    const dark = { regionId: 'D', mode: 0, modifier: 0.95, shapes: [left] };
    const lighter = { regionId: 'Lg', mode: 0, modifier: 0.5, shapes: [right] };
    const step = row([dark, lighter]);
    const across = step.filter((t2) => t2.x > 150 && t2.x < 250).map((t2) => t2.d / t2.c);
    ok('step: two darknesses meet with full coverage', minCoverNearSeam(step) > 0.999);
    ok('step: never brighter than the brighter region', Math.min(...across) >= 0.5 - 1e-6);
    let monotone = true;
    for (let i = 1; i < across.length; i++) if (across[i] > across[i - 1] + 1e-9) monotone = false;
    ok('step: darkness falls monotonically from dark to light', monotone);

    // A hole: coverage falls to zero inside it, softly.
    const holed = row([
      {
        regionId: 'H',
        mode: 0,
        modifier: 0.9,
        shapes: [
          { type: 'rectangle', x: 0, y: 0, width: 400, height: 100 },
          { type: 'rectangle', x: 150, y: 0, width: 100, height: 100, hole: true },
        ],
      },
    ]);
    ok('hole: the middle of a hole is uncovered', at(holed, 200).c < 0.01);
    ok('hole: its edge is a half', near((at(holed, 148).c + at(holed, 152).c) / 2, 0.5, 1e-6));
  }
}
