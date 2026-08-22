/**
 * water-refraction-subsystem.test.mjs — the orchestration logic and the pure
 * rect/sizing arithmetic, with a fake allocator and a fake render pass, same
 * reasoning as `water-sim-subsystem.test.mjs`'s own header: control flow is
 * what's worth pinning here (does a size change reallocate, does an empty
 * intersection skip the render, does a texture-identity change rebuild the
 * material) — shader OUTPUT needs a real GPU and belongs to a shader-lab
 * bench task, not this suite.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  createWaterRefractionSubsystem,
  intersectRects,
  computeCaptureTargetSize,
  WATER_REFRACTION_BUCKET_PX,
  WATER_REFRACTION_DOWNSAMPLE,
  WATER_REFRACTION_MAX_DIM_PX,
} from '../water-refraction-subsystem.js';

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
      return { name, describe, texture: { name }, dispose() {} };
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
      if (!target || !quad) throw new Error(`renderWaterPass call #${calls} got a missing target/quad`);
    },
    get calls() {
      return calls;
    },
  };
}

const VIEW_RECT = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };
const CANVAS_W = 1600;
const CANVAS_H = 800;

function buildHarness() {
  const allocator = fakeAllocator();
  const pass = fakeRenderPass();
  const subsystem = createWaterRefractionSubsystem({
    THREE,
    allocator,
    renderWaterPass: (t, q) => pass.run(t, q),
  });
  return { subsystem, allocator, pass };
}

export function run(t) {
  const { ok } = t;

  // ══ pure rect math — no THREE, no allocator, no subsystem at all ═══════
  ok(
    'intersectRects finds a real overlap',
    (() => {
      const r = intersectRects(
        { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        { minX: 50, minY: 50, maxX: 150, maxY: 150 }
      );
      return r && r.minX === 50 && r.minY === 50 && r.maxX === 100 && r.maxY === 100;
    })()
  );
  ok(
    'intersectRects returns null for disjoint rects',
    intersectRects({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { minX: 100, minY: 100, maxX: 200, maxY: 200 }) === null
  );
  ok(
    'intersectRects returns null for merely touching edges — a real region has real area',
    intersectRects({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { minX: 100, minY: 0, maxX: 200, maxY: 100 }) === null
  );
  ok(
    'intersectRects: one rect fully containing the other yields the smaller one',
    (() => {
      const r = intersectRects(
        { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
        { minX: 100, minY: 100, maxX: 200, maxY: 200 }
      );
      return r && r.minX === 100 && r.maxX === 200;
    })()
  );

  // ══ target sizing — bucket rounding and the max-dimension ceiling ═══════
  ok(
    'computeCaptureTargetSize scales by the declared downsample factor',
    (() => {
      // 200 world px wide, view is 2000 world px across a 1600px canvas ->
      // 0.8 device px per world px -> 160 device px at 1:1, halved by the
      // downsample factor -> 80, rounded up to the next 64px bucket -> 128.
      const region = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
      const { width } = computeCaptureTargetSize(region, VIEW_RECT, CANVAS_W, CANVAS_H);
      return width === 128;
    })()
  );
  ok(
    'a tiny region still gets at least one full bucket, never zero',
    (() => {
      const region = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const { width, height } = computeCaptureTargetSize(region, VIEW_RECT, CANVAS_W, CANVAS_H);
      return width === WATER_REFRACTION_BUCKET_PX && height === WATER_REFRACTION_BUCKET_PX;
    })()
  );
  ok(
    'an enormous region is clamped to the declared max dimension',
    (() => {
      const region = { minX: 0, minY: 0, maxX: 1e7, maxY: 1e7 };
      const { width, height } = computeCaptureTargetSize(region, VIEW_RECT, CANVAS_W, CANVAS_H);
      return width === WATER_REFRACTION_MAX_DIM_PX && height === WATER_REFRACTION_MAX_DIM_PX;
    })()
  );
  ok('the downsample constant is actually a downsample, not an upsample', WATER_REFRACTION_DOWNSAMPLE >= 2);

  // ══ NO INPUTS YET — reported honestly, never a crash, never a render ═══
  {
    const { subsystem, pass } = buildHarness();
    subsystem.tick({
      bodyRect: null,
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: stubTexture('sc'),
    });
    ok('no body rect: texture stays null', subsystem.texture === null);
    ok('no body rect: capturedRect stays null', subsystem.capturedRect === null);
    ok('no body rect: never renders', pass.calls === 0);
    ok('no body rect: status says so, not a generic failure', subsystem.getStatus().lastStatus.includes('body rect'));
  }
  {
    const { subsystem, pass } = buildHarness();
    subsystem.tick({
      bodyRect: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: null,
    });
    ok('no scene-color texture yet: never renders', pass.calls === 0);
    ok('no scene-color texture yet: status says so', subsystem.getStatus().lastStatus.includes('scene.color'));
  }

  // ══ water fully off-screen — skipped, not an error ══════════════════════
  {
    const { subsystem, pass } = buildHarness();
    subsystem.tick({
      bodyRect: { minX: 100000, minY: 100000, maxX: 100500, maxY: 100500 }, // nowhere near VIEW_RECT
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: stubTexture('sc'),
    });
    ok('off-screen water: never renders', pass.calls === 0);
    ok('off-screen water: texture stays null (no PRIOR capture to fall back to)', subsystem.texture === null);
    ok('off-screen water: status names the real reason', subsystem.getStatus().lastStatus.includes('off-screen'));
  }

  // ══ a real, in-view capture ══════════════════════════════════════════════
  {
    const { subsystem, allocator, pass } = buildHarness();
    const bodyRect = { minX: 0, minY: 0, maxX: 500, maxY: 500 };
    const sceneColor = stubTexture('sc-1');
    subsystem.tick({
      bodyRect,
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: sceneColor,
    });
    ok('a real capture allocates exactly one target', allocator.created === 1);
    ok('a real capture renders exactly once', pass.calls === 1);
    ok('texture is now populated', subsystem.texture !== null);
    ok(
      'capturedRect is the body/view INTERSECTION, not the raw body rect',
      subsystem.capturedRect.maxX === 500 && subsystem.capturedRect.minX === 0
    );
    ok('status reports ok', subsystem.getStatus().lastStatus === 'ok');
    ok(
      'the status counters agree with what actually happened',
      subsystem.getStatus().ticks === 1 && subsystem.getStatus().captures === 1
    );
  }

  // ══ same size, same texture identity, next frame — no thrash ═══════════
  {
    const { subsystem, allocator, pass } = buildHarness();
    const bodyRect = { minX: 0, minY: 0, maxX: 500, maxY: 500 };
    const sceneColor = stubTexture('sc-1');
    subsystem.tick({
      bodyRect,
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: sceneColor,
    });
    subsystem.tick({
      bodyRect,
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: sceneColor,
    });
    ok('an unchanged region/texture reuses the SAME allocation — no per-frame realloc', allocator.created === 1);
    ok('an unchanged texture identity does not rebuild the material', subsystem.getStatus().rebuilds === 1);
    ok('but it DOES render again — this is a per-frame capture, not a bake-once', pass.calls === 2);
  }

  // ══ the camera zooms out enough to change the bucketed target size ══════
  {
    const { subsystem, allocator } = buildHarness();
    const sceneColor = stubTexture('sc-1');
    subsystem.tick({
      bodyRect: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: sceneColor,
    });
    const firstSize = subsystem.getStatus().grid;
    // A much wider view rect over the SAME canvas -> far fewer device px per
    // world unit -> a smaller bucketed target.
    subsystem.tick({
      bodyRect: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
      viewRect: { minX: 0, minY: 0, maxX: 20000, maxY: 10000 },
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: sceneColor,
    });
    ok(
      'a real size change reallocates the target',
      allocator.created === 2 && subsystem.getStatus().grid !== firstSize
    );
  }

  // ══ scene-color texture is swapped for a NEW object (e.g. after a resize) ═
  {
    const { subsystem } = buildHarness();
    const bodyRect = { minX: 0, minY: 0, maxX: 500, maxY: 500 };
    subsystem.tick({
      bodyRect,
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: stubTexture('sc-a'),
    });
    subsystem.tick({
      bodyRect,
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: stubTexture('sc-b'),
    });
    ok('a new scene-color texture identity triggers a material rebuild', subsystem.getStatus().rebuilds === 2);
  }

  // ══ dispose — the same clean-state contract every sibling subsystem has ══
  {
    const { subsystem, allocator } = buildHarness();
    subsystem.tick({
      bodyRect: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
      viewRect: VIEW_RECT,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      sceneColorTexture: stubTexture('sc'),
    });
    subsystem.dispose();
    ok('dispose releases the allocated target', allocator.disposed === 1);
    ok('dispose clears the texture getter', subsystem.texture === null);
    ok(
      'dispose clears capturedRect too — a disposed subsystem claims no valid capture',
      subsystem.capturedRect === null
    );
    ok('dispose resets the status counters', subsystem.getStatus().ticks === 0 && subsystem.getStatus().captures === 0);
    ok('dispose is itself reported in status, not silently invisible', subsystem.getStatus().lastStatus === 'disposed');
  }
}
