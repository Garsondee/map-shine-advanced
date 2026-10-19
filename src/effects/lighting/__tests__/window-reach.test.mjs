/**
 * window-reach.test.mjs — how far a candle's / fire's light keeps shining once it has
 * crossed a window (`window-reach.js`).
 *
 * THE LIVE SYMPTOM THIS PINS (2026-10-19): a candle with the default 2000 px reach, in a
 * building with dozens of windows, threw straight-edged fans of light far across the ground
 * outside. The CPU spec below is what the TSL port mirrors; the graph tests prove the port
 * constructs with the real vendored three.webgpu TSL (they cannot prove the pixels — that was a
 * before/after render in a real Foundry scene, see the bead).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  WINDOW_REACH_OFF_PX,
  WINDOW_REACH_DEFAULT_PX,
  WINDOW_REACH_BINS,
  WINDOW_SOFT_RAMP_PX,
  WINDOW_REACH_HOLD,
  WINDOW_NONE,
  WINDOW_EDGE_SOFT_FRACTION,
  windowReachLimited,
  windowReachFade,
  windowEdgeSoftness,
  windowCrossing,
  distancePastWindow,
  computeWindowReachMultiplier,
  windowReachAlongRay,
  computeWindowReachProfile,
  sampleWindowReachProfile,
  buildWindowReachTerm,
} from '../window-reach.js';
import { deriveWallBlocksLight } from '../../../foundry/scene-walls.js';
import { canBatchLight } from '../point-light-batch.js';
import { createApertureGoboSharedUniforms } from '../aperture-gobo-render.js';
import { APERTURE_GOBO_DEFAULTS } from '../aperture-gobo.js';
import { APERTURE_GOBO_PARAMS } from '../../aperture-gobo.js';
import { buildPointLightIlluminationMaterial } from '../point-light-illumination.js';
import { buildPointLightColorationMaterial } from '../point-light-coloration.js';

export function run(t) {
  const { ok } = t;
  const eq = (name, got, want) =>
    ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want));
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

  // ── the setting ─────────────────────────────────────────────────────────
  ok('the default reach is a real limit (so the fix is ON by default)', windowReachLimited(WINDOW_REACH_DEFAULT_PX));
  ok('the slider end (2000) means "no limit"', !windowReachLimited(WINDOW_REACH_OFF_PX));
  ok('NaN / undefined mean "no limit", never a crash', !windowReachLimited(NaN) && !windowReachLimited(undefined));
  eq(
    'the Studio param exists with the shared default',
    APERTURE_GOBO_PARAMS.outsideReachPx.default,
    APERTURE_GOBO_DEFAULTS.outsideReachPx
  );
  eq('the default is the exported default', APERTURE_GOBO_DEFAULTS.outsideReachPx, WINDOW_REACH_DEFAULT_PX);
  eq('the slider tops out at the "no limit" value', APERTURE_GOBO_PARAMS.outsideReachPx.max, WINDOW_REACH_OFF_PX);
  ok('the default is visibly shorter than a candle (2000 px)', WINDOW_REACH_DEFAULT_PX <= 300);

  // ── the fade curve ──────────────────────────────────────────────────────
  eq('full strength at the glass', windowReachFade(0, 200), 1);
  eq(
    'and it HOLDS full strength over the first part of the reach (so the window pattern shows)',
    windowReachFade(200 * WINDOW_REACH_HOLD, 200),
    1
  );
  eq('gone at the reach', windowReachFade(200, 200), 0);
  eq('gone past the reach (never negative, never back up)', windowReachFade(5000, 200), 0);
  ok(
    'strictly dimmer as it goes further',
    windowReachFade(50, 200) > windowReachFade(100, 200) && windowReachFade(100, 200) > windowReachFade(150, 200)
  );
  ok('no hard edge: it is nearly flat-zero just before the reach', windowReachFade(190, 200) < 0.02);
  eq('a zero reach does not divide by zero', windowReachFade(10, 0), 0);

  // ── soft sides: the beam fades in over the outer part of the glass at each side ──
  eq('nothing at the very edge of the glass', windowEdgeSoftness(0), 0);
  eq('nothing at the other edge either', windowEdgeSoftness(1), 0);
  eq('full strength through the middle of the glass', windowEdgeSoftness(0.5), 1);
  eq('full strength right at the inner edge of the soft zone', windowEdgeSoftness(WINDOW_EDGE_SOFT_FRACTION), 1);
  ok(
    'half-way up the soft zone is part-way (a smooth ramp, not a step)',
    windowEdgeSoftness(WINDOW_EDGE_SOFT_FRACTION / 2) > 0.4 && windowEdgeSoftness(WINDOW_EDGE_SOFT_FRACTION / 2) < 0.6
  );
  ok('symmetric', Math.abs(windowEdgeSoftness(0.1) - windowEdgeSoftness(0.9)) < 1e-12);
  ok(
    'outside the glass (slack) is 0, never negative',
    windowEdgeSoftness(-0.01) === 0 && windowEdgeSoftness(1.01) === 0
  );

  // ── one window, geometry: a window in the wall y = 100, light at (0, 0), glass x = -50 .. 50 ──
  const L = { x: 0, y: 0 };
  const win = { ax: -50, ay: 100, bx: 50, by: 100 };
  ok(
    'a point in the room (before the glass) is not "past" the window',
    distancePastWindow(L, { x: 0, y: 60 }, win) === -1
  );
  ok('straight through: 50 px past the glass', near(distancePastWindow(L, { x: 0, y: 150 }, win), 50));
  ok(
    'windowCrossing reports where across the glass the ray goes (0.5 = the middle)',
    Math.abs(windowCrossing(L, { x: 0, y: 150 }, win).u - 0.5) < 1e-9
  );
  ok(
    'a ray that misses the glass (beside the window) is not "past" it',
    distancePastWindow(L, { x: 300, y: 150 }, win) === -1
  );
  ok('behind the light is not past the window', distancePastWindow(L, { x: 0, y: -150 }, win) === -1);
  ok(
    'a degenerate (zero-length) window never hits',
    distancePastWindow(L, { x: 0, y: 150 }, { ax: 5, ay: 100, bx: 5, by: 100 }) === -1
  );
  ok(
    'a ray parallel to the window never hits',
    distancePastWindow(L, { x: 500, y: 0 }, { ax: 0, ay: 0, bx: 100, by: 0 }) === -1
  );
  for (const p of [
    { x: 0, y: 99 },
    { x: -300, y: 40 },
    { x: 40, y: -500 },
    { x: 900, y: 99 },
    { x: 0, y: 0 },
  ]) {
    eq(
      `one window, indoors (${p.x},${p.y}) is multiplied by exactly 1`,
      computeWindowReachMultiplier(L, p, [win], 200),
      1
    );
  }

  // ── THE PROFILE: a room with MANY windows, only some of which the light shines out of ──
  const wall = (x1, y1, x2, y2, reachWindow = false) => ({ x1, y1, x2, y2, reachWindow });
  // An 800 x 800 room centred on the light (walls at +-400), with a window in the south and west walls and TWO
  // on the north wall, plus 40 more windows far away that the light cannot see (the compound has 47).
  const room = [
    wall(-400, 400, -150, 400),
    wall(-150, 400, 150, 400, true), // south window, 300 wide
    wall(150, 400, 400, 400),
    wall(-400, -400, -250, -400),
    wall(-250, -400, -120, -400, true), // north window A
    wall(-120, -400, 120, -400),
    wall(120, -400, 250, -400, true), // north window B
    wall(250, -400, 400, -400),
    wall(-400, -400, -400, -100),
    wall(-400, -100, -400, 100, true), // west window
    wall(-400, 100, -400, 400),
    wall(400, -400, 400, 400),
  ];
  const farWindows = [];
  for (let i = 0; i < 40; i++) farWindows.push(wall(1500, -1800 + i * 90, 1500, -1800 + i * 90 + 50, true));
  const walls = [...room, ...farWindows];
  const light = { x: 0, y: 0, radius: 2000 };
  const bytes = new Uint8Array(WINDOW_REACH_BINS * 4);
  const count = computeWindowReachProfile(light, walls, bytes);
  ok('the profile finds directions through windows', count > 0 && count < WINDOW_REACH_BINS);
  ok(
    'the profile is RGBA8: alpha is always 255',
    (() => {
      for (let i = 0; i < WINDOW_REACH_BINS; i++) if (bytes[i * 4 + 3] !== 255) return false;
      return true;
    })()
  );
  const reach = 200;
  const m = (x, y) => sampleWindowReachProfile(bytes, light, { x, y }, reach);
  // indoors: exactly 1, in every direction, up to the walls
  let indoorsMin = 1;
  for (let a = 0; a < 360; a += 1) {
    for (const r of [10, 100, 250, 390]) {
      const x = Math.cos((a * Math.PI) / 180) * r;
      const y = Math.sin((a * Math.PI) / 180) * r;
      if (Math.abs(x) < 399 && Math.abs(y) < 399) indoorsMin = Math.min(indoorsMin, m(x, y));
    }
  }
  eq('everywhere INSIDE the room the light is multiplied by exactly 1', indoorsMin, 1);
  ok('just outside the south window (middle) is nearly full strength', m(0, 410) > 0.9);
  ok('well outside the south window is dim', m(0, 580) < 0.1);
  eq('past the reach it is exactly 0, straight out of the south window', m(0, 400 + reach + 30), 0);
  eq('and out of the north window', m(-185 * 1.8, -400 * 1.8), 0);
  eq('and out of the SECOND north window', m(185 * 1.8, -400 * 1.8), 0);
  eq('and out of the west window', m(-400 - reach - 30, 0), 0);
  ok(
    'outside a SOLID part of the wall there is no light at all to curtail: stays 1 (never got out)',
    m(350, -500) === 1
  );
  ok('the 40 far windows the light cannot see do not touch the room', m(-300, 0) === 1);
  ok(
    'the soft sides: a ray through the very edge of the south glass is dimmer than through the middle',
    m(144, 480) < m(0, 480)
  );
  ok(
    'a bigger reach lets more light through',
    sampleWindowReachProfile(bytes, light, { x: 0, y: 500 }, 400) > m(0, 500)
  );
  ok(
    'the multiplier is always within 0..1',
    (() => {
      for (let a = 0; a < 360; a += 3)
        for (const r of [50, 450, 520, 700, 1500]) {
          const v = m(Math.cos((a * Math.PI) / 180) * r, Math.sin((a * Math.PI) / 180) * r);
          if (!(v >= 0 && v <= 1)) return false;
        }
      return true;
    })()
  );
  // the along-the-ray function and its edges
  eq('before the window the ray is 1', windowReachAlongRay(100, 400, 1, 200), 1);
  eq('the "no window" sentinel is 1 at any distance', windowReachAlongRay(1900, WINDOW_NONE, 1, 200), 1);
  ok(
    'soft sides ease in over the ramp, not a step at the glass',
    windowReachAlongRay(401, 400, 0, 200) > 0.9 && windowReachAlongRay(400 + WINDOW_SOFT_RAMP_PX, 400, 0, 2000) < 0.1
  );

  // THE RIM BUG (2026-10-19): the edge of a window beam, where it meets the shadow of the post beside it, glowed as a thin bright
  // line, because the lookup blended the faded window direction with the neighbouring "post" direction (reads 1, unmodulated).
  {
    const postLight = { x: 0, y: 0, radius: 2000 };
    const edgeWalls = [wall(-300, 400, -20, 400), wall(-20, 400, 20, 400, true), wall(20, 400, 300, 400)];
    const edgeBytes = new Uint8Array(WINDOW_REACH_BINS * 4);
    computeWindowReachProfile(postLight, edgeWalls, edgeBytes);
    const reachPx = 100;
    // walk across the window's edge, far enough past the glass that the beam has faded to nothing
    let worst = 0;
    for (let deg = -2.9; deg <= 2.9; deg += 0.01) {
      const rad = (90 + deg) * (Math.PI / 180);
      const pt = { x: Math.cos(rad) * 700, y: Math.sin(rad) * 700 };
      const v = sampleWindowReachProfile(edgeBytes, postLight, pt, reachPx);
      const throughWindow = Math.abs(pt.x) < 20 * (700 / 400);
      if (throughWindow) worst = Math.max(worst, v);
    }
    ok(
      'across the window beam, far past the glass, the light has faded to nothing right up to its edge (no bright rim)',
      worst < 1e-3
    );
    ok(
      'beside the beam there is nothing to curtail',
      sampleWindowReachProfile(edgeBytes, postLight, { x: 300, y: 300 }, reachPx) === 1
    );
  }

  // no windows / no walls
  const none = new Uint8Array(WINDOW_REACH_BINS * 4);
  eq(
    'a room with no windows has an empty profile',
    computeWindowReachProfile(
      light,
      room.map((w) => ({ ...w, reachWindow: false })),
      none
    ),
    0
  );
  eq('no walls at all: empty', computeWindowReachProfile(light, [], none), 0);
  eq(
    'a light whose radius reaches nothing: empty',
    computeWindowReachProfile({ x: 0, y: 0, radius: 10 }, walls, none),
    0
  );
  const behind = new Uint8Array(WINDOW_REACH_BINS * 4);
  eq(
    'a window hidden behind a solid wall is never "first"',
    computeWindowReachProfile(
      { x: 0, y: 0, radius: 1000 },
      [wall(-500, 200, 500, 200), wall(-50, 300, 50, 300, true)],
      behind
    ),
    0
  );

  // ── what stops light ────────────────────────────────────────────────────
  ok('an ordinary wall stops light', deriveWallBlocksLight({ light: 20 }) === true);
  ok('light:NONE does not (windows, railings, terrain edges)', deriveWallBlocksLight({ light: 0 }) === false);
  ok(
    'a PROXIMITY window blocks like a wall until the window code takes over',
    deriveWallBlocksLight({ light: 30 }) === true
  );
  ok('a closed door stops light', deriveWallBlocksLight({ light: 20, door: 1, ds: 0 }) === true);
  ok('an open door lets it through', deriveWallBlocksLight({ light: 20, door: 1, ds: 1 }) === false);
  ok(
    'a missing field reads as an ordinary wall',
    deriveWallBlocksLight({}) === true && deriveWallBlocksLight() === true
  );

  // ── batching: a window-reach light cannot share a batched bucket ────────
  ok(
    'a candle with no window in reach still batches',
    canBatchLight({ apertureCount: 0, windowReachCount: 0, falloffModel: 'candle' }) === true
  );
  ok(
    'a candle WITH a window in reach stays on the per-light path',
    canBatchLight({ apertureCount: 0, windowReachCount: 1, falloffModel: 'candle' }) === false
  );

  // ── the TSL port constructs ─────────────────────────────────────────────
  const { vec2, uniform, float } = THREE.TSL;
  const shared = createApertureGoboSharedUniforms(THREE);
  ok('the shared reach uniform exists', !!shared.uWindowReachPx);
  const posXY = vec2(uniform(float(0)), uniform(float(0)));
  const tex = new THREE.DataTexture(bytes, WINDOW_REACH_BINS, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  eq(
    'zero windows compiles out entirely',
    buildWindowReachTerm({ THREE, positionWorldXY: posXY, windowCount: 0, shared, profileTexture: tex }),
    null
  );
  eq(
    'no texture compiles out too (never a half-built graph)',
    buildWindowReachTerm({ THREE, positionWorldXY: posXY, windowCount: 1, shared, profileTexture: null }),
    null
  );
  let term = null;
  let err = null;
  try {
    term = buildWindowReachTerm({ THREE, positionWorldXY: posXY, windowCount: 1, shared, profileTexture: tex });
  } catch (e) {
    err = e;
  }
  ok(`the term constructs (${err ? err.message : 'clean'})`, err === null && !!term && !!term.node && !!term.uLight);

  // ── both materials carry it, through the real builders ──────────────────
  const common = {
    THREE,
    uBackgroundColor: uniform(THREE.TSL.vec3(0, 0, 0)),
    uDimColor: uniform(THREE.TSL.vec3(0, 0, 0)),
    uBrightColor: uniform(THREE.TSL.vec3(1, 1, 1)),
    uGlobalTimeMs: uniform(float(0)),
    falloffModel: 'candle',
    apertureGoboShared: shared,
  };
  const illumHolder = { count: 1, shared, texture: tex, handle: null };
  let illumErr = null;
  try {
    buildPointLightIlluminationMaterial({ ...common, windowReach: illumHolder });
  } catch (e) {
    illumErr = e;
  }
  ok(
    `the illumination material builds with a window-reach term (${illumErr ? illumErr.message : 'clean'})`,
    illumErr === null
  );
  ok('it hands back the light position uniform', !!illumHolder.handle?.uLight);
  const noneHolder = { count: 0, shared, texture: tex, handle: null };
  buildPointLightIlluminationMaterial({ ...common, windowReach: noneHolder });
  ok('with zero windows nothing is compiled in and no handle is returned', noneHolder.handle === null);
  const colorHolder = { count: 1, shared, texture: tex, handle: null };
  let colorErr = null;
  try {
    buildPointLightColorationMaterial({
      THREE,
      uGlobalTimeMs: uniform(float(0)),
      uRatio: uniform(float(0.5)),
      falloffModel: 'candle',
      apertureGoboShared: shared,
      windowReach: colorHolder,
    });
  } catch (e) {
    colorErr = e;
  }
  ok(
    `the coloration material builds with a window-reach term (${colorErr ? colorErr.message : 'clean'})`,
    colorErr === null
  );
  ok('and hands back its own light position uniform', !!colorHolder.handle?.uLight);
}
