/**
 * Node tests for run-conditions.js — the validity stamp every perf action
 * attaches. The verdict is the load-bearing part: a hidden stretch MUST
 * invalidate, and a mere focus loss must NOT (the author works on other
 * monitors during long sweeps).
 */
import { createRunConditionsMonitor, buildRunConditions, readRendererAdapterInfo } from '../run-conditions.js';

function fakeEnv({ hidden = false, focused = true, w = 1920, h = 1080, dpr = 1 } = {}) {
  let t = 0;
  const listeners = {};
  const add = (type, fn) => ((listeners[type] ??= []).push(fn));
  const remove = (type, fn) => (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn));
  const doc = {
    visibilityState: hidden ? 'hidden' : 'visible',
    hasFocus: () => focused,
    addEventListener: add,
    removeEventListener: remove,
  };
  const win = {
    innerWidth: w,
    innerHeight: h,
    devicePixelRatio: dpr,
    screen: { width: 2560, height: 1440 },
    navigator: { userAgent: 'test-agent', hardwareConcurrency: 16 },
    addEventListener: add,
    removeEventListener: remove,
  };
  const fire = (type) => (listeners[type] ?? []).forEach((f) => f());
  return {
    doc,
    win,
    now: () => t,
    advance: (ms) => (t += ms),
    fire,
    listenerCount: () => Object.values(listeners).reduce((n, a) => n + a.length, 0),
  };
}

export function run(t) {
  const { ok } = t;

  // ---- a clean run is valid ------------------------------------------------
  {
    const e = fakeEnv();
    const m = createRunConditionsMonitor({ ...e, readAdapter: () => ({ vendor: 'nvidia' }) });
    m.start();
    e.advance(60000);
    const r = m.stop();
    ok('clean run is valid', r.valid === true && r.invalidReasons.length === 0);
    ok('clean run records duration', r.durationMs === 60000);
    ok('clean run stamps physical viewport', r.viewport.physicalWidth === 1920 && r.viewport.physicalHeight === 1080);
    ok('clean run stamps adapter + agent', r.adapter.vendor === 'nvidia' && r.userAgent === 'test-agent');
    ok('listeners removed on stop', e.listenerCount() === 0);
  }

  // ---- a hidden stretch invalidates ----------------------------------------
  {
    const e = fakeEnv();
    const m = createRunConditionsMonitor(e);
    m.start();
    e.advance(1000);
    e.doc.visibilityState = 'hidden';
    e.fire('visibilitychange');
    e.advance(2500);
    e.doc.visibilityState = 'visible';
    e.fire('visibilitychange');
    e.advance(1000);
    const r = m.stop();
    ok('hidden stretch invalidates', r.valid === false);
    ok('hidden ms measured exactly', r.hiddenMs === 2500 && r.hiddenEpisodes === 1);
  }

  // ---- hidden at start AND still hidden at stop is counted -----------------
  {
    const e = fakeEnv({ hidden: true });
    const m = createRunConditionsMonitor(e);
    m.start();
    e.advance(4000);
    const r = m.stop();
    ok('hidden throughout counts the whole run', r.hiddenMs === 4000 && r.valid === false);
  }

  // ---- focus loss is noted, NOT invalidating --------------------------------
  {
    const e = fakeEnv();
    const m = createRunConditionsMonitor(e);
    m.start();
    e.fire('blur');
    e.advance(3000);
    e.fire('focus');
    const r = m.stop();
    ok('focus loss alone stays valid', r.valid === true);
    ok('focus loss is measured and noted', r.unfocusedMs === 3000 && r.notes.length === 1);
  }

  // ---- a canvas-size change invalidates -------------------------------------
  {
    const e = fakeEnv();
    const m = createRunConditionsMonitor(e);
    m.start();
    e.win.innerWidth = 1280;
    e.fire('resize');
    const r = m.stop();
    ok('viewport change invalidates', r.valid === false && r.viewportAtStart.physicalWidth === 1920);
  }

  // ---- a DPR change alone invalidates ---------------------------------------
  {
    const e = fakeEnv();
    const m = createRunConditionsMonitor(e);
    m.start();
    e.win.devicePixelRatio = 1.25;
    const r = m.stop();
    ok('dpr change invalidates', r.valid === false);
  }

  // ---- a resize that returns to the same size is only a note ---------------
  {
    const r = buildRunConditions({
      durationMs: 10,
      hiddenMs: 0,
      hiddenEpisodes: 0,
      unfocusedMs: 0,
      resizeEvents: 2,
      startViewport: { physicalWidth: 100, physicalHeight: 100, devicePixelRatio: 1 },
      endViewport: { physicalWidth: 100, physicalHeight: 100, devicePixelRatio: 1 },
    });
    ok('round-trip resize stays valid, noted', r.valid === true && r.notes.length === 1);
  }

  // ---- stop without start, and adapter read throwing ------------------------
  {
    const e = fakeEnv();
    ok('stop without start returns null', createRunConditionsMonitor(e).stop() === null);
    const m = createRunConditionsMonitor({
      ...e,
      readAdapter: () => {
        throw new Error('no device');
      },
    });
    m.start();
    ok('throwing adapter read yields null adapter', m.stop().adapter === null);
  }

  // ---- render-scale governor movement is sampled and noted -----------------
  {
    const e = fakeEnv();
    let scale = { resolvedInternalScale: 1, internalW: 1920, internalH: 1080, userSetting: 'auto' };
    let tick = null;
    const m = createRunConditionsMonitor({
      ...e,
      readRenderScale: () => scale,
      setInterval: (fn) => ((tick = fn), 1),
      clearInterval: () => (tick = null),
    });
    m.start();
    tick();
    scale = { ...scale, resolvedInternalScale: 0.75, internalW: 1440, internalH: 810 };
    tick();
    tick();
    const r = m.stop();
    ok('scale change counted once', r.renderScale.changes === 1 && r.renderScale.distinct.length === 2);
    ok('scale change is a note, not invalid', r.valid === true && r.notes.some((n) => /render resolution/.test(n)));
    ok('scale timer cleared on stop', tick === null);
    ok('scale start/end stamped', r.renderScale.start.internalScale === 1 && r.renderScale.end.internalScale === 0.75);
  }
  {
    const e = fakeEnv();
    const m = createRunConditionsMonitor({ ...e, readRenderScale: () => ({ skipped: true }), setInterval: () => 1, clearInterval: () => {} });
    m.start();
    const r = m.stop();
    ok('skipped scale reader yields null start/end, no changes', r.renderScale.start === null && r.renderScale.changes === 0);
  }

  // ---- adapter reader -------------------------------------------------------
  {
    ok('no renderer gives null adapter', readRendererAdapterInfo(null) === null);
    const a = readRendererAdapterInfo({
      backend: { isWebGPUBackend: true, adapter: { info: { vendor: 'nvidia', architecture: 'ampere' } } },
    });
    ok('adapter reader reads webgpu info', a.backend === 'webgpu' && a.architecture === 'ampere');
    const d = readRendererAdapterInfo({
      backend: { isWebGPUBackend: true, device: { adapterInfo: { vendor: 'nvidia', architecture: 'ampere' } } },
    });
    ok('adapter reader falls back to device.adapterInfo', d?.vendor === 'nvidia');
  }
}
