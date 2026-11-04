import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInteriorCutGrid,
  interiorCutZoomFactor,
  INTERIOR_CUT_FULL_BELOW_FIT,
  INTERIOR_CUT_GONE_AT_FIT,
} from '../interior-cut.js';

// A 1000x1000 scene on a 100x100 grid: a 400x400 "building" (dark) in the middle, open sky around it.
function building() {
  const w = 100;
  const h = 100;
  const data = new Uint8Array(w * h).fill(255);
  for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) data[y * w + x] = 0;
  return { data, spec: { w, h, width: 1000, height: 1000 } };
}

test('interior cut grid: deep inside stays dark, far outside stays open, the edge is soft', () => {
  const { data, spec } = building();
  const g = buildInteriorCutGrid(data, spec);
  const at = (wx, wy) => g.data[Math.floor((wy / 1000) * g.h) * g.w + Math.floor((wx / 1000) * g.w)];
  assert.ok(at(500, 500) < 40, `centre of the building should be dark, got ${at(500, 500)}`);
  assert.ok(at(30, 30) > 235, `open sky far from the building should be bright, got ${at(30, 30)}`);
  // The wall line (x=300) sits mid-ramp, and the ramp is wide: both 120px either side differ from the extremes.
  const wall = at(300, 500);
  assert.ok(wall > 60 && wall < 200, `the wall should be mid-grey, got ${wall}`);
  assert.ok(at(180, 500) > wall && at(420, 500) < wall, 'monotone across the wall');
});

test('interior cut grid: an all-outdoors map cuts nothing', () => {
  const g = buildInteriorCutGrid(new Uint8Array(64 * 64).fill(255), { w: 64, h: 64, width: 640, height: 640 });
  assert.ok(g.data.every((v) => v === 255));
});

test('interior cut grid: output size is capped for huge scenes', () => {
  const g = buildInteriorCutGrid(new Uint8Array(1024 * 1024).fill(255), {
    w: 1024,
    h: 1024,
    width: 60000,
    height: 60000,
  });
  assert.ok(g.w <= 512 && g.h <= 512);
});

test('zoom factor: whole at medium zoom, weak when fully zoomed out, monotone between', () => {
  const scene = { sceneWidthPx: 4000, sceneHeightPx: 3000 };
  const f = (fit) =>
    interiorCutZoomFactor({
      viewWidthWorldPx: 4000 * fit,
      viewHeightWorldPx: 3000 * fit,
      ...scene,
      zoomedOutKeep: 0.1,
    });
  assert.equal(f(0.2), 1);
  assert.equal(f(INTERIOR_CUT_FULL_BELOW_FIT), 1);
  assert.ok(Math.abs(f(INTERIOR_CUT_GONE_AT_FIT) - 0.1) < 1e-9);
  assert.ok(Math.abs(f(2) - 0.1) < 1e-9);
  let prev = 2;
  for (let fit = 0.3; fit <= 1.2; fit += 0.05) {
    const v = f(fit);
    assert.ok(v <= prev + 1e-12, `non-increasing at fit ${fit}`);
    prev = v;
  }
});

test('zoom factor: no measurement means the full cut (the safe side for interiors)', () => {
  assert.equal(interiorCutZoomFactor({ viewWidthWorldPx: 0, viewHeightWorldPx: 0, sceneWidthPx: 0, sceneHeightPx: 0 }), 1);
});
