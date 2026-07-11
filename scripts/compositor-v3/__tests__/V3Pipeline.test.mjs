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
// Default: CC unavailable → the pass passthrough-copies scene.lit → scene.graded.
function stubPost(p, { available = false } = {}) {
  const rec = { gradeCalls: 0, copyCalls: 0, lastCopyDst: null };
  p._post = {
    isColorCorrectionAvailable: () => available,
    ccToneMappingActive: () => false,
    renderColorGrade: () => { rec.gradeCalls++; return false; },
    copy: (r, srcTex, dstRT) => { rec.copyCalls++; rec.lastCopyDst = dstRT; return true; },
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

const EXPECTED_ORDER = ['unifiedGeometry', 'lighting', 'effects', 'post', 'present'];

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
    // Post: CC unavailable in the mock → passthrough-copy scene.lit → scene.graded.
    ok('post passthrough-copied once', post.copyCalls === 1 && post.gradeCalls === 0);
    ok('present got the scene.graded texture', present.calls === 1 && post.lastCopyDst && present.lastTexture === post.lastCopyDst.texture);
    const diag = p.getDiagnostics();
    ok('pooled 4 targets (color + illum + lit + graded)', diag.stats.pooled === 4);
    ok('5 pass timings', diag.timings.length === 5);
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
    ok('renders without a bus', res && res.order.length === 5);
    ok('cleared scene.color when bus missing', renderer.calls.clear >= 1);
  }

  // Deferred init when THREE missing.
  {
    const p = new V3Pipeline({ renderer: null, THREE: null });
    p.initialize();
    ok('deferred not ready', p.isReady() === false);
    ok('render null when uninit', p.render() === null);
  }
}
