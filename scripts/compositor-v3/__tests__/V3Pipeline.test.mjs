/**
 * Node smoke test for V3Pipeline.js wiring, using THREE + renderer/bus mocks.
 * Run via ../run-tests.mjs.
 *
 * Pass set: unifiedGeometry (FloorRenderBus.renderTo → scene.color) → lighting
 * (→ scene.illum + scene.lit) → effects (vegetation → scene.lit) → post (V2 colour
 * grade or passthrough → scene.graded) → present (encode scene.graded → screen).
 */
import { V3Pipeline } from '../V3Pipeline.js';
import { makeTHREE } from './ThreeAllocator.test.mjs';

function makeRenderer(w = 1920, h = 1080) {
  const calls = { setRenderTarget: 0, clear: 0, render: 0 };
  return {
    calls, _target: null, autoClear: true,
    getDrawingBufferSize: (v) => { v.x = w; v.y = h; return v; },
    getSize: (v) => { v.x = w; v.y = h; return v; },
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this._target = t; calls.setRenderTarget++; },
    clear() { calls.clear++; },
    render() { calls.render++; },
    setScissorTest() {}, getScissorTest() { return false; },
    setViewport() {}, setClearColor() {}, setClearAlpha() {},
  };
}

// Stub the present + lighting passes so the test doesn't need a full THREE
// (Scene/Mesh/ShaderMaterial). We only verify wiring/order here.
function stubPresent(p) {
  const rec = { calls: 0, lastTexture: null };
  p._present = { present: (r, tex) => { rec.calls++; rec.lastTexture = tex; return true; }, dispose() {} };
  return rec;
}
function stubLighting(p) {
  const rec = { calls: 0, albedoTex: null, illumRT: null, litRT: null };
  p._lighting = {
    render: (r, cam, tex, illumRT, litRT) => { rec.calls++; rec.albedoTex = tex; rec.illumRT = illumRT; rec.litRT = litRT; return true; },
    dispose() {},
  };
  return rec;
}
// Stub the post bridge so the test doesn't need the V2 compositor / full THREE.
// Default: post enabled → renderPost runs (bloom+grade) and writes scene.graded.
function stubPost(p, { appliedCC = false } = {}) {
  const rec = { postCalls: 0, copyCalls: 0, lastGradedRT: null };
  p._post = {
    isColorCorrectionAvailable: () => false,
    ccToneMappingActive: () => false,
    renderPost: (r, cam, lit, graded) => { rec.postCalls++; rec.lastGradedRT = graded; return { appliedCC }; },
    copy: (r, srcTex, dstRT) => { rec.copyCalls++; rec.lastGradedRT = dstRT; return true; },
    dispose() {},
  };
  return rec;
}

// Mock FloorRenderBus: records renderTo(renderer, camera, target).
function makeBus() {
  const rec = { renderToCalls: 0, lastTarget: null, syncStreamingCalls: 0 };
  return {
    rec,
    renderTo: (renderer, camera, target) => { rec.renderToCalls++; rec.lastTarget = target; },
    syncStreaming: () => { rec.syncStreamingCalls++; },
  };
}

const EXPECTED_ORDER = ['sims', 'streaming', 'unifiedGeometry', 'lighting', 'effects', 'post', 'present'];

export function run(t) {
  const { ok } = t;

  // Compiles to unifiedGeometry → present.
  {
    const T = makeTHREE();
    const p = new V3Pipeline({ renderer: makeRenderer(), THREE: T }).initialize();
    const diag = p.getDiagnostics();
    ok('compiles', diag.lastError === null);
    ok('first-plunge order', JSON.stringify(diag.order) === JSON.stringify(EXPECTED_ORDER));
  }

  // Ready by default (both passes real); toggling a cap flips readiness.
  {
    const T = makeTHREE();
    const p = new V3Pipeline({ renderer: makeRenderer(), THREE: T }).initialize();
    ok('ready after init', p.isReady() === true);
    p.setPassImplemented('unifiedGeometry', false);
    ok('not ready when geometry disabled', p.isReady() === false);
    p.setPassImplemented('unifiedGeometry', true);
    ok('ready again', p.isReady() === true);
  }

  // render() → bus into scene.color, lighting into scene.lit, present scene.lit.
  {
    const T = makeTHREE();
    const renderer = makeRenderer(1600, 900);
    const p = new V3Pipeline({ renderer, THREE: T }).initialize();
    const present = stubPresent(p);
    const lighting = stubLighting(p);
    const post = stubPost(p);
    const bus = makeBus();
    const camera = { id: 'cam' };
    const res = p.render({ renderBus: bus, camera, timeInfo: { frameCount: 1 } });
    ok('ran all passes', res && JSON.stringify(res.order) === JSON.stringify(EXPECTED_ORDER));
    ok('bus.renderTo called once', bus.rec.renderToCalls === 1);
    ok('bus rendered into scene.color RT', bus.rec.lastTarget && bus.rec.lastTarget.width === 1600 && bus.rec.lastTarget.height === 900);
    ok('bus streaming synced', bus.rec.syncStreamingCalls === 1);
    ok('lighting got the albedo (scene.color) texture', lighting.calls === 1 && lighting.albedoTex === bus.rec.lastTarget.texture);
    ok('lighting got distinct illum + lit RTs', lighting.illumRT && lighting.litRT && lighting.illumRT !== lighting.litRT && lighting.litRT !== bus.rec.lastTarget);
    // Post: enabled by default → renderPost runs once and writes scene.graded.
    ok('post ran once', post.postCalls === 1);
    ok('present got the scene.graded texture', present.calls === 1 && post.lastGradedRT && present.lastTexture === post.lastGradedRT.texture);
    const diag = p.getDiagnostics();
    ok('pooled 4 targets (color + illum + lit + graded)', diag.stats.pooled === 4);
    ok('7 pass timings', diag.timings.length === 7);
    ok('content frame counted', diag.frames.frames === 1 && diag.frames.contentFrames === 1);
  }

  // Bus missing → geometry clears to black, later passes still run (no throw).
  {
    const T = makeTHREE();
    const renderer = makeRenderer();
    const p = new V3Pipeline({ renderer, THREE: T }).initialize();
    stubPresent(p);
    stubLighting(p);
    stubPost(p);
    const res = p.render({ renderBus: null, camera: { id: 'c' } });
    ok('renders without a bus', res && res.order.length === 7);
    ok('cleared scene.color when bus missing', renderer.calls.clear >= 1);
    const counters = p.getFrameCounters();
    ok('bus-less frame is not a content frame', counters.frames === 1 && counters.contentFrames === 0);
  }

  // Deferred init when THREE missing.
  {
    const p = new V3Pipeline({ renderer: null, THREE: null });
    p.initialize();
    ok('deferred not ready', p.isReady() === false);
    ok('render null when uninit', p.render() === null);
  }

  // Render/present split (Forward+ §16.3 P2): default is 'auto' at full scale.
  {
    const T = makeTHREE();
    const renderer = makeRenderer(100, 50);
    const p = new V3Pipeline({ renderer, THREE: T }).initialize();
    stubPresent(p); stubLighting(p); stubPost(p);
    p.render({ renderBus: makeBus(), camera: { id: 'c' } });
    const rs = p.getPerfReport().renderScale;
    ok('default scale mode auto @ 1.0', rs.mode === 'auto' && rs.scale === 1.0);
  }

  // Render/present split: a pinned scale allocates every screen RT at the
  // internal render size while present size stays the drawing buffer.
  {
    const T = makeTHREE();
    const renderer = makeRenderer(1600, 900);
    const p = new V3Pipeline({ renderer, THREE: T }).initialize();
    const present = stubPresent(p);
    stubLighting(p); stubPost(p);
    const bus = makeBus();
    const prevMapShine = globalThis.window.MapShine;
    globalThis.window.MapShine = { __v3RenderScale: 0.5 };
    try {
      const res = p.render({ renderBus: bus, camera: { id: 'c' } });
      ok('scaled render runs all passes', res && res.order.length === 7);
      ok('scene.color allocated at render scale',
         bus.rec.lastTarget.width === 800 && bus.rec.lastTarget.height === 450);
      ok('present still blitted', present.calls === 1);
      const perf = p.getPerfReport();
      ok('perf reports fixed scale', perf.renderScale.mode === 'fixed' && perf.renderScale.scale === 0.5);
      ok('perf carries both sizes',
         perf.presentSize.width === 1600 && perf.renderSize.width === 800 && perf.renderSize.height === 450);
      ok('monitor folded the frame', perf.monitor.frames === 1 && perf.monitor.passes.length === 7);
      const diag = p.getDiagnostics();
      ok('diagnostics carry perf + gpuTimings fields',
         diag.perf && diag.perf.renderScale.scale === 0.5 && Array.isArray(diag.gpuTimings));
    } finally {
      globalThis.window.MapShine = prevMapShine;
    }
  }

  // Scene-loading flag holds the governor (load storms are not evidence).
  {
    const T = makeTHREE();
    const renderer = makeRenderer(400, 200);
    const p = new V3Pipeline({ renderer, THREE: T }).initialize();
    stubPresent(p); stubLighting(p); stubPost(p);
    const prevMapShine = globalThis.window.MapShine;
    globalThis.window.MapShine = { __msaSceneLoading: true };
    try {
      p.render({ renderBus: makeBus(), camera: { id: 'c' } });
      const gov = p.getPerfReport().renderScale.governor;
      ok('governor held while scene loading', gov.holdActive === true && gov.holdReason === 'scene-loading');
      globalThis.window.MapShine = { __msaSceneLoading: false };
      p.render({ renderBus: makeBus(), camera: { id: 'c' } });
      ok('governor released after load', p.getPerfReport().renderScale.governor.holdActive === false);
    } finally {
      globalThis.window.MapShine = prevMapShine;
    }
  }

  // Scale change across frames RESIZES pooled RTs (graph pool follows size).
  {
    const T = makeTHREE();
    const renderer = makeRenderer(1000, 500);
    const p = new V3Pipeline({ renderer, THREE: T }).initialize();
    stubPresent(p); stubLighting(p); stubPost(p);
    const bus = makeBus();
    const prevMapShine = globalThis.window.MapShine;
    try {
      globalThis.window.MapShine = { __v3RenderScale: 1 };
      p.render({ renderBus: bus, camera: { id: 'c' } });
      ok('full-scale first frame', bus.rec.lastTarget.width === 1000);
      globalThis.window.MapShine = { __v3RenderScale: 0.6 };
      p.render({ renderBus: bus, camera: { id: 'c' } });
      ok('downscaled second frame', bus.rec.lastTarget.width === 600 && bus.rec.lastTarget.height === 300);
      ok('same pooled RT resized, not a new one', p.getDiagnostics().stats.pooled === 4);
    } finally {
      globalThis.window.MapShine = prevMapShine;
    }
  }
}
