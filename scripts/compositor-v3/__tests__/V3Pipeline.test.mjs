/**
 * Node smoke test for V3Pipeline.js wiring, using THREE + renderer/bus mocks.
 * Run via ../run-tests.mjs.
 *
 * First-plunge pass set: unifiedGeometry (FloorRenderBus.renderTo → scene.color)
 * → present (blit scene.color → screen).
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

// Mock FloorRenderBus: records renderTo(renderer, camera, target).
function makeBus() {
  const rec = { renderToCalls: 0, lastTarget: null, syncStreamingCalls: 0 };
  return {
    rec,
    renderTo: (renderer, camera, target) => { rec.renderToCalls++; rec.lastTarget = target; },
    syncStreaming: () => { rec.syncStreamingCalls++; },
  };
}

const EXPECTED_ORDER = ['unifiedGeometry', 'lighting', 'effects', 'present'];

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
    const bus = makeBus();
    const camera = { id: 'cam' };
    const res = p.render({ renderBus: bus, camera, timeInfo: { frameCount: 1 } });
    ok('ran all three passes', res && JSON.stringify(res.order) === JSON.stringify(EXPECTED_ORDER));
    ok('bus.renderTo called once', bus.rec.renderToCalls === 1);
    ok('bus rendered into scene.color RT', bus.rec.lastTarget && bus.rec.lastTarget.width === 1600 && bus.rec.lastTarget.height === 900);
    ok('bus streaming synced', bus.rec.syncStreamingCalls === 1);
    ok('lighting got the albedo (scene.color) texture', lighting.calls === 1 && lighting.albedoTex === bus.rec.lastTarget.texture);
    ok('lighting got distinct illum + lit RTs', lighting.illumRT && lighting.litRT && lighting.illumRT !== lighting.litRT && lighting.litRT !== bus.rec.lastTarget);
    ok('present got the scene.lit texture', present.calls === 1 && present.lastTexture === lighting.litRT.texture);
    const diag = p.getDiagnostics();
    ok('pooled 3 targets (color + illum + lit)', diag.stats.pooled === 3);
    ok('4 pass timings', diag.timings.length === 4);
  }

  // Bus missing → geometry clears to black, later passes still run (no throw).
  {
    const T = makeTHREE();
    const renderer = makeRenderer();
    const p = new V3Pipeline({ renderer, THREE: T }).initialize();
    stubPresent(p);
    stubLighting(p);
    const res = p.render({ renderBus: null, camera: { id: 'c' } });
    ok('renders without a bus', res && res.order.length === 4);
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
