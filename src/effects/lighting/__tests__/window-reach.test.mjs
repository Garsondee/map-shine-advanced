/**
 * window-reach.test.mjs — how far a candle's / fire's light keeps shining once it has
 * crossed a window (`window-reach.js`).
 *
 * THE LIVE SYMPTOM THIS PINS (2026-10-19): a candle with the default 2000 px reach, next to
 * a `light: PROXIMITY` window, threw straight-edged fans of light far across the ground
 * outside. The CPU spec below is what the TSL port mirrors; the graph tests prove the
 * port constructs with the real vendored three.webgpu TSL (they cannot prove the pixels —
 * that was a before/after render in a real Foundry scene, see the bead).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  WINDOW_REACH_OFF_PX,
  WINDOW_REACH_DEFAULT_PX,
  MAX_WINDOWS_PER_LIGHT,
  windowReachLimited,
  windowReachFade,
  distancePastWindow,
  computeWindowReachMultiplier,
  findWindowsForReach,
  buildWindowReachTerm,
} from '../window-reach.js';
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
  eq('gone at the reach', windowReachFade(200, 200), 0);
  eq('gone past the reach (never negative, never back up)', windowReachFade(5000, 200), 0);
  ok(
    'strictly dimmer as it goes further',
    windowReachFade(50, 200) > windowReachFade(100, 200) && windowReachFade(100, 200) > windowReachFade(150, 200)
  );
  ok('no hard edge: it is nearly flat-zero just before the reach', windowReachFade(190, 200) < 0.003);
  eq('a zero reach does not divide by zero', windowReachFade(10, 0), 0);

  // ── geometry: a window in the wall y = 100, light at (0, 0), glass from x=-50 to 50 ──
  const L = { x: 0, y: 0 };
  const win = { ax: -50, ay: 100, bx: 50, by: 100 };
  ok(
    'a point in the room (before the glass) is not "past" the window',
    distancePastWindow(L, { x: 0, y: 60 }, win) === -1
  );
  ok('straight through: 50 px past the glass', near(distancePastWindow(L, { x: 0, y: 150 }, win), 50));
  ok('a point on the glass line itself is 0 past', near(distancePastWindow(L, { x: 20, y: 100 }, win), 0, 1e-9));
  ok(
    'a ray that misses the glass (beside the window) is not "past" it',
    distancePastWindow(L, { x: 300, y: 150 }, win) === -1
  );
  ok('behind the light is not past the window', distancePastWindow(L, { x: 0, y: -150 }, win) === -1);
  ok(
    'a ray that grazes just past the glass end is still caught (2 px slack)',
    distancePastWindow(L, { x: 51 * 1.5, y: 150 }, win) >= 0
  );
  ok(
    'a degenerate (zero-length) window never hits',
    distancePastWindow(L, { x: 0, y: 150 }, { ax: 5, ay: 100, bx: 5, by: 100 }) === -1
  );
  ok(
    'a ray parallel to the window never hits',
    distancePastWindow(L, { x: 500, y: 0 }, { ax: 0, ay: 0, bx: 100, by: 0 }) === -1
  );

  // ── the multiplier: indoors is EXACTLY 1, outdoors fades ────────────────
  const windows = [win];
  for (const p of [
    { x: 0, y: 99 },
    { x: -300, y: 40 },
    { x: 40, y: -500 },
    { x: 900, y: 99 },
    { x: 0, y: 0 },
  ]) {
    eq(`indoors (${p.x},${p.y}) is multiplied by exactly 1`, computeWindowReachMultiplier(L, p, windows, 200), 1);
  }
  ok(
    'just outside the glass is almost full strength',
    computeWindowReachMultiplier(L, { x: 0, y: 105 }, windows, 200) > 0.9
  );
  ok('well outside it is dim', computeWindowReachMultiplier(L, { x: 0, y: 250 }, windows, 200) < 0.1);
  eq(
    'past the reach it is exactly 0 (this is what removes the long fan)',
    computeWindowReachMultiplier(L, { x: 0, y: 900 }, windows, 200),
    0
  );
  ok(
    'the wedge BESIDE the glass the ray cannot reach is untouched (light that came another way)',
    computeWindowReachMultiplier(L, { x: 400, y: 150 }, windows, 200) === 1
  );
  ok(
    'a bigger reach lets more light through',
    computeWindowReachMultiplier(L, { x: 0, y: 250 }, windows, 400) >
      computeWindowReachMultiplier(L, { x: 0, y: 250 }, windows, 200)
  );
  // series: the SMALLEST multiplier wins
  const second = { ax: -400, ay: 200, bx: 400, by: 200 };
  const p = { x: 0, y: 260 };
  const one = computeWindowReachMultiplier(L, p, [win], 300);
  const both = computeWindowReachMultiplier(L, p, [win, second], 300);
  ok(
    'windows in series take the smallest multiplier',
    both <= one && both === Math.min(one, computeWindowReachMultiplier(L, p, [second], 300))
  );
  eq('no windows at all: 1', computeWindowReachMultiplier(L, { x: 0, y: 500 }, [], 200), 1);

  // ── which windows a light uses ──────────────────────────────────────────
  const seg = (x1, y1, x2, y2, aperture = true) => ({ x1, y1, x2, y2, aperture });
  const found = findWindowsForReach({ x: 0, y: 0, radius: 500 }, [
    seg(-50, 300, 50, 300),
    seg(-50, 100, 50, 100),
    seg(-50, 900, 50, 900),
    seg(-50, 50, 50, 50, false),
  ]);
  eq(
    'only windows within the light radius, nearest first',
    found.map((w) => w.ay),
    [100, 300]
  );
  eq(
    'a non-aperture wall is never a window',
    found.some((w) => w.ay === 50),
    false
  );
  const many = [];
  for (let i = 1; i <= 9; i++) many.push(seg(-10, i * 40, 10, i * 40));
  const capped = findWindowsForReach({ x: 0, y: 0, radius: 1000 }, many);
  eq(`at most ${MAX_WINDOWS_PER_LIGHT} windows`, capped.length, MAX_WINDOWS_PER_LIGHT);
  eq(
    'the capped list is the nearest ones',
    capped.map((w) => w.ay),
    [40, 80, 120, 160]
  );
  const reuse = [];
  ok(
    'the result array is the caller’s own (no allocation per frame)',
    findWindowsForReach({ x: 0, y: 0, radius: 500 }, many, reuse) === reuse && reuse.length === 4
  );
  eq('a radius of zero finds nothing', findWindowsForReach({ x: 0, y: 0, radius: 0 }, many).length, 0);
  eq('no walls: empty', findWindowsForReach({ x: 0, y: 0, radius: 500 }, []).length, 0);

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
  eq(
    'zero windows compiles out entirely',
    buildWindowReachTerm({ THREE, positionWorldXY: posXY, windowCount: 0, shared }),
    null
  );
  for (let n = 1; n <= MAX_WINDOWS_PER_LIGHT; n++) {
    let term = null;
    let err = null;
    try {
      term = buildWindowReachTerm({ THREE, positionWorldXY: posXY, windowCount: n, shared });
    } catch (e) {
      err = e;
    }
    ok(
      `${n} window(s) construct (${err ? err.message : 'clean'})`,
      err === null && term && term.windows.length === n && !!term.node && !!term.uLight
    );
  }
  eq(
    'more windows than the cap are clamped',
    buildWindowReachTerm({ THREE, positionWorldXY: posXY, windowCount: 99, shared }).windows.length,
    MAX_WINDOWS_PER_LIGHT
  );

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
  const illumHolder = { count: 2, shared, handle: null };
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
  ok(
    'it hands back two window uniform slots and the light position',
    illumHolder.handle?.windows?.length === 2 && !!illumHolder.handle.uLight
  );
  const noneHolder = { count: 0, shared, handle: null };
  try {
    buildPointLightIlluminationMaterial({ ...common, windowReach: noneHolder });
  } catch (e) {
    illumErr = e;
  }
  ok('with zero windows nothing is compiled in and no handle is returned', noneHolder.handle === null);
  const colorHolder = { count: 3, shared, handle: null };
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
  ok('and hands back three slots', colorHolder.handle?.windows?.length === 3);
}
