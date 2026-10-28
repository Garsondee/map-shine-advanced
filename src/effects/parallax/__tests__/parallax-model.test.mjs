/**
 * parallax-model.test.mjs — the declaration validates, and the maths behaves like a real stack of
 * floors: the viewed floor never moves, higher layers ride outward and lower ones sink inward, a
 * tall building is capped, and a floor change is a smooth glide of one number.
 */
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { PARALLAX, PARALLAX_PARAMS } from '../parallax.js';
import {
  FALLBACK_FLOOR_SPAN,
  floorLadder,
  viewElevationAt,
  softCapHeight,
  parallaxScale,
  displacePoint,
  displaceQuad,
  undisplacePoint,
  resolveParallaxFrame,
  raisedEdgeShade,
  edgeShadeLadder,
  glideEase,
  createFloorGlide,
} from '../parallax-model.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const DEF = Object.fromEntries(Object.entries(PARALLAX_PARAMS).map(([k, d]) => [k, d.default]));

export function run(t) {
  const { ok } = t;

  ok('manifest validates', validateEffectManifest(PARALLAX).ok === true);
  ok('params schema validates', validateParamsSchema(PARALLAX_PARAMS).ok === true);
  ok('its card is titled Parallax', PARALLAX.title === 'Parallax');
  ok('opt-in: on by default only at the extreme profile', PARALLAX.enabledFromProfile === 'extreme');

  // ── the ladder of floors ─────────────────────────────────────────────────
  const three = [
    { index: 0, elevationBottom: 0, elevationTop: 10 },
    { index: 1, elevationBottom: 10, elevationTop: 20 },
    { index: 2, elevationBottom: 20, elevationTop: 30 },
  ];
  const lad = floorLadder(three);
  ok('ladder: planes are the floors’ own bottoms', lad.base.join() === '0,10,20' && lad.span === 10);
  const gappy = floorLadder([
    { index: 0, elevationBottom: null, elevationTop: null },
    { index: 1, elevationBottom: null, elevationTop: null },
    { index: 2, elevationBottom: 25, elevationTop: 35 },
  ]);
  ok('ladder: a floor with no band continues one span up', gappy.base[0] === 0 && gappy.base[1] === 10);
  ok('ladder: the span is the median of the finite bands', gappy.span === 10 && gappy.base[2] === 25);
  ok(
    'ladder: no floors is an empty ladder',
    floorLadder([]).base.length === 0 && floorLadder(null).span === FALLBACK_FLOOR_SPAN
  );
  const clash = floorLadder([
    { index: 0, elevationBottom: 5, elevationTop: 10 },
    { index: 1, elevationBottom: 5, elevationTop: 10 },
  ]);
  ok('ladder: two floors never share a plane', clash.base[1] > clash.base[0]);

  // ── the view elevation glides ────────────────────────────────────────────
  ok('view elevation at a whole floor is its plane', viewElevationAt(lad, 1) === 10 && viewElevationAt(lad, 2) === 20);
  ok(
    'view elevation interpolates between floors',
    near(viewElevationAt(lad, 0.25), 2.5) && near(viewElevationAt(lad, 1.5), 15)
  );
  ok('view elevation extrapolates past the ends', viewElevationAt(lad, -1) === -10 && viewElevationAt(lad, 3) === 30);
  ok(
    'view elevation tolerates garbage',
    viewElevationAt(lad, NaN) === 0 && viewElevationAt({ base: [], span: 10 }, 1) === 0
  );

  // ── the scale ────────────────────────────────────────────────────────────
  ok('⭐ the viewed plane never scales', parallaxScale(0, 1500) === 1);
  ok('higher layers scale up, lower ones down', parallaxScale(100, 1500) > 1 && parallaxScale(-100, 1500) < 1);
  ok('scale = eyeH / (eyeH − h)', near(parallaxScale(300, 1500), 1500 / 1200));
  ok(
    'a layer is never pushed through the eye',
    Number.isFinite(parallaxScale(1499, 1500)) && parallaxScale(1499, 1500) <= 4
  );
  ok('no eye means no parallax', parallaxScale(100, 0) === 1);

  // ── the soft cap ─────────────────────────────────────────────────────────
  ok('soft cap is near-identity for small heights', near(softCapHeight(1, 1000, 1000), 1, 1e-5));
  ok('soft cap never exceeds its limit', softCapHeight(1e9, 100, 50) <= 100 && softCapHeight(-1e9, 100, 50) >= -50);
  ok('soft cap is monotonic', softCapHeight(300, 400, 400) > softCapHeight(200, 400, 400));
  ok('soft cap keeps the sign and zero', softCapHeight(0, 100, 100) === 0 && softCapHeight(-5, 100, 100) < 0);
  ok('soft cap with no room is zero', softCapHeight(50, 0, 0) === 0 && softCapHeight(NaN, 10, 10) === 0);

  // ── displacement ─────────────────────────────────────────────────────────
  const eye = { x: 1000, y: 600 };
  const p = { x: 1400, y: 300 };
  const moved = displacePoint(p, eye, 1.1);
  ok(
    'displace: the eye does not move',
    near(displacePoint(eye, eye, 1.7).x, 1000) && near(displacePoint(eye, eye, 1.7).y, 600)
  );
  ok('displace: scale 1 is the identity', displacePoint(p, eye, 1).x === 1400 && displacePoint(p, eye, 1).y === 300);
  ok('displace: scaled about the eye', near(moved.x, 1440) && near(moved.y, 270));
  const back = undisplacePoint(moved, eye, 1.1);
  ok('undisplace is the exact inverse', near(back.x, p.x, 1e-9) && near(back.y, p.y, 1e-9));
  const q = displaceQuad({ x: 1400, y: 300 }, { x: 200, y: 100 }, eye, 1.1);
  ok(
    'a quad stays a quad: centre moves, size scales',
    near(q.x, 1440) && near(q.y, 270) && near(q.sx, 220) && near(q.sy, 110)
  );
  const corner = displacePoint({ x: 1400 + 100, y: 300 + 50 }, eye, 1.1);
  ok(
    'a displaced quad’s corner is the displaced corner',
    near(q.x + q.sx / 2, corner.x) && near(q.y + q.sy / 2, corner.y)
  );

  // ── the frame ────────────────────────────────────────────────────────────
  const ctx = { floors: three, floorPos: 1, boardMinSidePx: 3000, halfSpanPx: 600, fovDeg: 45 };
  const f = resolveParallaxFrame(null, DEF, ctx);
  ok('frame: on with the defaults', f.enabled === true && f.eyeH > 0 && f.pxPerUnit > 0);
  ok('⭐ frame: the viewed floor is at scale 1', f.scaleOf(10) === 1 && f.heightOf(10) === 0);
  ok('frame: the floor above rides out, the floor below sinks', f.scaleOf(20) > 1 && f.scaleOf(0) < 1);
  ok('frame: higher is bigger', f.scaleOf(30) > f.scaleOf(20) && f.scaleOf(0) < f.scaleOf(10));
  ok('frame: subtle by default (one floor ≲ 6 %)', f.scaleOf(20) < 1.06 && f.scaleOf(0) > 0.94);
  ok('frame: the table top clears the highest roof', f.topHeight > 0 && f.topHeight >= f.heightOf(30) - 1e-9);
  ok(
    'frame: the recess is deepest at the lowest floor’s plane',
    f.bottomDepth > 0 && near(f.bottomDepth, -f.heightOf(0))
  );

  // THE FIT (the author, 2026-10-28: trees as high as "the top of the brass element and not the side").
  const oneFloor = [{ index: 0, elevationBottom: 0, elevationTop: 10 }];
  const solo = {
    floors: oneFloor,
    floorPos: 0,
    boardMinSidePx: 3000,
    halfSpanPx: 600,
    fovDeg: 45,
    extraTopAbove: 25,
    canopyFt: 25,
  };
  const loose = resolveParallaxFrame(null, DEF, solo);
  const fitted = resolveParallaxFrame(null, DEF, { ...solo, tableTopPx: loose.topHeight * 3 });
  ok(
    '⭐ fit: the treetops stand exactly level with a taller table top',
    near(fitted.heightOf(25), loose.topHeight * 3, 1e-6) && near(fitted.topHeight, loose.topHeight * 3, 1e-6)
  );
  ok(
    'fit: every raised layer lifts by the same factor',
    near(fitted.heightOf(10) / loose.heightOf(10), 3, 1e-9) && near(fitted.lift, 3, 1e-9)
  );
  ok('⭐ fit: the viewed floor still never moves', fitted.scaleOf(0) === 1 && fitted.heightOf(0) === 0);
  const deep = resolveParallaxFrame(null, DEF, { ...ctx, floorPos: 2, tableTopPx: 1e-3 });
  const deepLoose = resolveParallaxFrame(null, DEF, { ...ctx, floorPos: 2 });
  ok(
    'fit: a stack taller than the table is never squashed (the recess deepens instead)',
    deep.lift === 1 && near(deep.topHeight, deepLoose.topHeight)
  );
  const fitBelow = resolveParallaxFrame(null, DEF, { ...ctx, floorPos: 2, tableTopPx: 500 });
  ok('fit: the floors beneath keep their depth', near(fitBelow.heightOf(0), deepLoose.heightOf(0)));
  ok('fit: no table, no lift', loose.lift === 1);

  // THE EDGE SHADOW a layer keeps (the author: "until trees only get 15% of the AO strength").
  ok(
    'shade: the floor and below keep all of it',
    raisedEdgeShade(0, 100, 0.15) === 1 && raisedEdgeShade(-50, 100, 0.15) === 1
  );
  ok('shade: treetop height keeps the tree share', near(raisedEdgeShade(100, 100, 0.15), 0.15));
  ok('shade: halfway up is halfway', near(raisedEdgeShade(50, 100, 0.15), 0.575));
  ok('shade: never below the tree share', near(raisedEdgeShade(400, 100, 0.15), 0.15));
  ok(
    '⭐ shade: the default canopy keeps 15 %',
    DEF.treeEdgeShadow === 0.15 && near(fitted.edgeShadeOf(25), 0.15) && fitted.edgeShadeOf(0) === 1
  );

  // THE LADDER: the steps multiply out to each band's exact share.
  const shadeLad = edgeShadeLadder(
    [
      { order: 0, shade: 1 },
      { order: 1, shade: 1 },
      { order: 5, shade: 0.15 },
      { order: 3, shade: 0.7 },
    ],
    0.15
  );
  ok(
    'ladder: one step per band change, in draw order',
    shadeLad.steps.length === 2 && shadeLad.steps[0].order === 2 && shadeLad.steps[1].order === 4
  );
  ok('ladder: the overlay keeps the top band’s share', near(shadeLad.last, 0.15));
  const occ = 0.8;
  const after = (i) =>
    shadeLad.steps.slice(i).reduce((k, s) => (k * (1 - occ * s.from)) / (1 - occ * s.to), 1) *
    (1 - occ * shadeLad.last);
  ok('⭐ ladder: the floor gets the whole shadow', near(after(0), 1 - occ));
  ok('⭐ ladder: the treetops get their share', near(after(shadeLad.steps.length), 1 - occ * 0.15));
  ok(
    'ladder: a later layer never keeps more than an earlier one',
    edgeShadeLadder(
      [
        { order: 0, shade: 0.15 },
        { order: 1, shade: 1 },
      ],
      0.15
    ).steps.length === 1
  );
  ok(
    'ladder: share 1 needs no steps',
    edgeShadeLadder([{ order: 0, shade: 0.2 }], 1).steps.length === 0 &&
      edgeShadeLadder([{ order: 0, shade: 0.2 }], 1).last === 1
  );
  ok(
    'ladder: nothing raised, nothing to step',
    edgeShadeLadder(
      [
        { order: 0, shade: 1 },
        { order: 1, shade: 1 },
      ],
      0.15
    ).steps.length === 0
  );
  ok(
    'ladder: never more than three steps',
    edgeShadeLadder(
      Array.from({ length: 20 }, (_, i) => ({ order: i, shade: 1 - i / 19 })),
      0
    ).steps.length <= 3
  );

  const ground = resolveParallaxFrame(null, DEF, { ...ctx, floorPos: 0 });
  const top = resolveParallaxFrame(null, DEF, { ...ctx, floorPos: 2 });
  ok('climbing: the table top comes down to meet you', ground.topHeight > f.topHeight && f.topHeight > top.topHeight);
  ok('climbing: the ground sinks deeper', top.bottomDepth > f.bottomDepth && f.bottomDepth > ground.bottomDepth);
  ok('on the ground floor nothing is below', near(ground.bottomDepth, 0));

  // The glide: every layer's scale moves continuously with the fractional floor.
  let prev = resolveParallaxFrame(null, DEF, { ...ctx, floorPos: 0 }).scaleOf(10);
  let smooth = true;
  for (let i = 1; i <= 20; i++) {
    const s = resolveParallaxFrame(null, DEF, { ...ctx, floorPos: i / 20 }).scaleOf(10);
    if (!(s < prev + 1e-12) || Math.abs(s - prev) > 0.01) smooth = false;
    prev = s;
  }
  ok('glide: a layer’s scale changes smoothly and monotonically through a floor change', smooth);

  const off = resolveParallaxFrame({ strength: 0 }, DEF, ctx);
  ok('strength 0 turns it off and flattens every layer', off.enabled === false && off.scaleOf(30) === 1);
  const strong = resolveParallaxFrame({ strength: 2 }, DEF, ctx);
  ok('strength scales the heights', strong.scaleOf(20) > f.scaleOf(20));

  // Many storeys, tight zoom: the limit holds.
  const tall = Array.from({ length: 40 }, (_, i) => ({ index: i, elevationBottom: i * 10, elevationTop: i * 10 + 10 }));
  const crush = resolveParallaxFrame({ floorHeightPct: 6, strength: 2, maxScale: 1.1 }, DEF, {
    floors: tall,
    floorPos: 0,
    boardMinSidePx: 4000,
    halfSpanPx: 150,
    fovDeg: 45,
  });
  ok('the limit holds on a 40-storey tower', crush.scaleOf(390) <= 1.1 + 1e-9 && crush.scaleOf(390) > 1.05);
  ok(
    'and the layers never swap order under it',
    crush.scaleOf(390) >= crush.scaleOf(380) && crush.scaleOf(380) > crush.scaleOf(10)
  );

  ok(
    'zooming in raises the parallax (the eye drops)',
    resolveParallaxFrame(null, DEF, { ...ctx, halfSpanPx: 200 }).scaleOf(20) > f.scaleOf(20)
  );
  ok('floor bases are the ladder’s planes', f.floorBase(0) === 0 && f.floorBase(1) === 10 && f.floorBase(2) === 20);
  ok('floor base clamps to the ladder', f.floorBase(-3) === 0 && f.floorBase(99) === 20 && f.floorBase(NaN) === 0);
  ok(
    'floor tops are the next floor’s plane, one span up for the highest',
    f.floorTop(0) === 10 && f.floorTop(1) === 20 && f.floorTop(2) === 30
  );
  ok('the lowest scale is the lowest floor’s plane', f.lowestScale === f.scaleOf(0) && f.lowestScale < 1);
  const taller = resolveParallaxFrame(null, DEF, { ...ctx, extraTopAbove: 35 });
  ok('a canopy taller than the building raises the table top', taller.topHeight > f.topHeight);
  ok(
    'a canopy shorter than the building changes nothing',
    resolveParallaxFrame(null, DEF, { ...ctx, extraTopAbove: 8 }).topHeight === f.topHeight
  );
  const one = resolveParallaxFrame(null, DEF, { ...ctx, floors: [three[0]], floorPos: 0 });
  ok(
    'a one-floor scene still works (trees rise, nothing sinks)',
    one.enabled && one.bottomDepth === 0 && one.scaleOf(5) > 1
  );
  const none = resolveParallaxFrame(null, DEF, { ...ctx, floors: [], floorPos: 0 });
  ok('no floors: nothing to move, nothing thrown', none.topHeight === 0 && none.bottomDepth === 0);

  // ── the floor glide ──────────────────────────────────────────────────────
  ok('ease: 0 → 0, 1 → 1, 0.5 → 0.5', glideEase(0) === 0 && glideEase(1) === 1 && near(glideEase(0.5), 0.5));
  ok('ease: soft at both ends', glideEase(0.05) < 0.01 && glideEase(0.95) > 0.99);
  ok('ease: clamps outside 0..1', glideEase(-1) === 0 && glideEase(2) === 1);
  const g = createFloorGlide();
  ok(
    'glide: the first floor is adopted outright (loading is not a floor change)',
    g.step(2, 0, 1) === 2 && !g.active()
  );
  ok('glide: no change, no motion', g.step(2, 500, 1) === 2 && !g.active());
  const a = g.step(3, 1000, 1);
  ok('glide: a change starts from where it was', a === 2 && g.active());
  const mid = g.step(3, 1500, 1);
  ok('glide: halfway is halfway', near(mid, 2.5) && g.active());
  ok('glide: arrives and stops', g.step(3, 2000, 1) === 3 && !g.active());
  g.step(4, 3000, 1);
  const part = g.step(4, 3400, 1);
  const turned = g.step(2, 3400, 1);
  ok('glide: retarget mid-flight carries on from the current value', part > 3 && part < 4 && near(turned, part));
  ok('glide: zero seconds snaps', createFloorGlide().step(0, 0, 0) === 0);
  const z = createFloorGlide();
  z.step(0, 0, 0);
  ok('glide: zero duration jumps on a change', z.step(5, 10, 0) === 5 && !z.active());
  const sn = createFloorGlide();
  sn.step(0, 0, 1);
  sn.step(3, 10, 1);
  sn.settle(3);
  ok('glide: settle jumps with no motion', sn.value() === 3 && !sn.active());
  ok('glide: garbage targets are floor 0', createFloorGlide().step(NaN, 0, 1) === 0);
}
