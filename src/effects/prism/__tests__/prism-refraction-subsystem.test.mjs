/**
 * prism-refraction-subsystem.test.mjs — the orchestration logic and the pure
 * rect/sizing arithmetic, with a fake allocator and a fake render pass. Same
 * reasoning `water-refraction-subsystem.test.mjs`'s own header gives: control
 * flow is what's worth pinning here (does a size change reallocate, does an
 * empty union skip the render, does a texture-identity change rebuild the
 * material) — shader OUTPUT needs a real GPU and belongs to a shader-lab
 * bench task, not this suite.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  createPrismRefractionSubsystem,
  unionRectOfItemCorners,
  computePrismCaptureTargetSize,
  intersectRects,
  PRISM_REFRACTION_BUCKET_PX,
  PRISM_REFRACTION_DOWNSAMPLE,
  PRISM_REFRACTION_MAX_DIM_PX,
} from '../prism-refraction-subsystem.js';

function stubTexture(tag) {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  t.__tag = tag;
  return t;
}

function fakeAllocator() {
  let created = 0;
  let disposed = 0;
  return {
    create(name, describe) {
      created++;
      return { name, describe, texture: { name }, width: describe.resolvedW, height: describe.resolvedH, dispose() {} };
    },
    dispose(rt) {
      if (rt) disposed++;
    },
    get created() {
      return created;
    },
    get disposed() {
      return disposed;
    },
  };
}

function fakeRenderPass() {
  let calls = 0;
  return {
    run(target, quad) {
      calls++;
      if (!target || !quad) throw new Error(`renderPrismCapturePass call #${calls} got a missing target/quad`);
    },
    get calls() {
      return calls;
    },
  };
}

const VIEW_RECT = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };
const DEVICE_W = 1600;
const DEVICE_H = 800;

function rectItem(minX, minY, maxX, maxY) {
  return {
    corners: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
  };
}

function buildHarness() {
  const allocator = fakeAllocator();
  const pass = fakeRenderPass();
  const subsystem = createPrismRefractionSubsystem({
    THREE,
    allocator,
    renderPrismCapturePass: (t, q) => pass.run(t, q),
  });
  return { subsystem, allocator, pass };
}

export function run(t) {
  const { ok } = t;

  // ══ unionRectOfItemCorners — this module's own one real departure from water ══
  ok('an empty list unions to null — nothing to capture', unionRectOfItemCorners([]) === null);
  ok(
    'null/undefined is treated as an empty list',
    unionRectOfItemCorners(null) === null && unionRectOfItemCorners(undefined) === null
  );
  ok(
    'a single item unions to its own bounding box',
    (() => {
      const r = unionRectOfItemCorners([rectItem(10, 20, 110, 220)]);
      return r && r.minX === 10 && r.minY === 20 && r.maxX === 110 && r.maxY === 220;
    })()
  );
  ok(
    'two disjoint items union to the SPAN across both, including the gap between them',
    (() => {
      const r = unionRectOfItemCorners([rectItem(0, 0, 100, 100), rectItem(900, 900, 1000, 1000)]);
      return r && r.minX === 0 && r.minY === 0 && r.maxX === 1000 && r.maxY === 1000;
    })()
  );
  ok(
    'an item with non-finite corner values is ignored rather than poisoning the union with NaN',
    (() => {
      const r = unionRectOfItemCorners([{ corners: [{ x: NaN, y: 5 }] }, rectItem(10, 10, 20, 20)]);
      return r && r.minX === 10 && r.maxX === 20;
    })()
  );

  // ══ target sizing — bucket rounding and the max-dimension ceiling ═══════
  ok(
    'computePrismCaptureTargetSize scales by the declared downsample factor',
    (() => {
      // Same arithmetic water-refraction-subsystem.test.mjs's own sibling
      // check pins: 200 world px wide, view 2000 world px over a 1600px
      // device -> 0.8 device px/world px -> 160 at 1:1, halved -> 80,
      // rounded up to the next 64px bucket -> 128.
      const region = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
      const { width } = computePrismCaptureTargetSize(region, VIEW_RECT, DEVICE_W, DEVICE_H);
      return width === 128;
    })()
  );
  ok(
    'a tiny region still gets at least one full bucket, never zero',
    (() => {
      const region = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const { width, height } = computePrismCaptureTargetSize(region, VIEW_RECT, DEVICE_W, DEVICE_H);
      return width === PRISM_REFRACTION_BUCKET_PX && height === PRISM_REFRACTION_BUCKET_PX;
    })()
  );
  ok(
    'an enormous region is clamped to the declared max dimension',
    (() => {
      const region = { minX: 0, minY: 0, maxX: 1e7, maxY: 1e7 };
      const { width, height } = computePrismCaptureTargetSize(region, VIEW_RECT, DEVICE_W, DEVICE_H);
      return width === PRISM_REFRACTION_MAX_DIM_PX && height === PRISM_REFRACTION_MAX_DIM_PX;
    })()
  );
  ok('the downsample constant is actually a downsample, not an upsample', PRISM_REFRACTION_DOWNSAMPLE >= 2);
  ok(
    'intersectRects is re-exported (reused, not duplicated, from water-refraction-subsystem.js)',
    typeof intersectRects === 'function'
  );

  // ══ NO ACTIVE PRISM TILE THIS FRAME — reported honestly, never a crash ══
  {
    const { subsystem, pass } = buildHarness();
    subsystem.tick({
      items: [],
      viewRect: VIEW_RECT,
      deviceW: DEVICE_W,
      deviceH: DEVICE_H,
      sceneColorTexture: stubTexture('sc'),
    });
    ok('no items: texture stays null', subsystem.texture === null);
    ok('no items: capturedRect stays null', subsystem.capturedRect === null);
    ok('no items: never renders', pass.calls === 0);
    ok(
      'no items: status says so, not a generic failure',
      subsystem.getStatus().lastStatus.includes('no active Prism tile')
    );
  }
  {
    const { subsystem, pass } = buildHarness();
    subsystem.tick({
      items: [rectItem(0, 0, 500, 500)],
      viewRect: VIEW_RECT,
      deviceW: DEVICE_W,
      deviceH: DEVICE_H,
      sceneColorTexture: null,
    });
    ok('no scene-colour texture yet: never renders', pass.calls === 0);
    ok('no scene-colour texture yet: status says so', subsystem.getStatus().lastStatus.includes('scene colour'));
  }

  // ══ every active tile is off-screen — skipped, not an error ═════════════
  {
    const { subsystem, pass } = buildHarness();
    subsystem.tick({
      items: [rectItem(100000, 100000, 100500, 100500)], // nowhere near VIEW_RECT
      viewRect: VIEW_RECT,
      deviceW: DEVICE_W,
      deviceH: DEVICE_H,
      sceneColorTexture: stubTexture('sc'),
    });
    ok('off-screen tiles: never renders', pass.calls === 0);
    ok('off-screen tiles: texture stays null (no prior capture to fall back to)', subsystem.texture === null);
    ok('off-screen tiles: status names the real reason', subsystem.getStatus().lastStatus.includes('off-screen'));
  }

  // ══ a real, in-view capture across TWO disjoint tiles ═══════════════════
  {
    const { subsystem, allocator, pass } = buildHarness();
    const items = [rectItem(0, 0, 100, 100), rectItem(300, 300, 500, 500)];
    const sceneColor = stubTexture('sc-1');
    subsystem.tick({ items, viewRect: VIEW_RECT, deviceW: DEVICE_W, deviceH: DEVICE_H, sceneColorTexture: sceneColor });
    ok('a real capture allocates exactly one target', allocator.created === 1);
    ok('a real capture renders exactly once', pass.calls === 1);
    ok('texture is now populated', subsystem.texture !== null);
    ok(
      'capturedRect spans the UNION of both tiles, including the gap between them',
      subsystem.capturedRect.minX === 0 && subsystem.capturedRect.maxX === 500
    );
    ok('status reports ok', subsystem.getStatus().lastStatus === 'ok');
    ok(
      'the status counters agree with what actually happened',
      subsystem.getStatus().ticks === 1 && subsystem.getStatus().captures === 1
    );
  }

  // ══ same items, same texture identity, next frame — no thrash ══════════
  {
    const { subsystem, allocator, pass } = buildHarness();
    const items = [rectItem(0, 0, 500, 500)];
    const sceneColor = stubTexture('sc-1');
    subsystem.tick({ items, viewRect: VIEW_RECT, deviceW: DEVICE_W, deviceH: DEVICE_H, sceneColorTexture: sceneColor });
    subsystem.tick({ items, viewRect: VIEW_RECT, deviceW: DEVICE_W, deviceH: DEVICE_H, sceneColorTexture: sceneColor });
    ok('an unchanged region/texture reuses the SAME allocation — no per-frame realloc', allocator.created === 1);
    ok('an unchanged texture identity does not rebuild the material', subsystem.getStatus().rebuilds === 1);
    ok('but it DOES render again — this is a per-frame capture, not a bake-once', pass.calls === 2);
  }

  // ══ dispose — the same clean-state contract every sibling subsystem has ══
  {
    const { subsystem, allocator } = buildHarness();
    subsystem.tick({
      items: [rectItem(0, 0, 500, 500)],
      viewRect: VIEW_RECT,
      deviceW: DEVICE_W,
      deviceH: DEVICE_H,
      sceneColorTexture: stubTexture('sc'),
    });
    subsystem.dispose();
    ok('dispose releases the allocated target', allocator.disposed === 1);
    ok('dispose clears the texture getter', subsystem.texture === null);
    ok('dispose clears capturedRect too', subsystem.capturedRect === null);
    ok('dispose clears width/height too', subsystem.width === null && subsystem.height === null);
    ok('dispose resets the status counters', subsystem.getStatus().ticks === 0 && subsystem.getStatus().captures === 0);
    ok('dispose is itself reported in status, not silently invisible', subsystem.getStatus().lastStatus === 'disposed');
  }
}
