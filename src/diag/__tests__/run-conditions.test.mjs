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

  // ---- timeline: events carry time + phase; checkpoints vouch for early work --
  {
    const e = fakeEnv();
    const m = createRunConditionsMonitor(e);
    m.start();
    m.notePhase('Profiling: measuring — 10 frames · 1.0s elapsed');
    e.advance(1000);
    m.notePhase('Profiling: measuring — 20 frames · 2.0s elapsed'); // counters only: same phase
    e.advance(59000);
    m.checkpoint('main-route-end');
    m.notePhase('structural-ab — [1/5 low] toggle ON');
    e.advance(5000);
    e.win.innerHeight = 1024;
    e.fire('resize');
    e.advance(1000);
    e.win.innerHeight = 1080;
    e.fire('resize');
    m.checkpoint('tier-sweep-end');
    const r = m.stop();
    ok('flip-and-back canvas change invalidates the whole run', r.valid === false && /2 time\(s\)/.test(r.invalidReasons.join(' ')));
    ok('first invalid is the canvas change at 65s', r.firstInvalid?.kind === 'canvas' && r.firstInvalid.atMs === 65000);
    ok('first invalid names its phase', /structural-ab/.test(r.firstInvalid.phase));
    ok('counter ticks do not create a new phase', r.events.every((ev) => !/20 frames/.test(ev.phase ?? '')));
    ok('main-route checkpoint still clean', r.checkpoints[0].name === 'main-route-end' && r.checkpoints[0].cleanSoFar === true);
    ok('later checkpoint dirty', r.checkpoints[1].cleanSoFar === false);
    ok('both canvas changes recorded', r.events.filter((ev) => ev.kind === 'canvas').length === 2);
  }
  {
    const e = fakeEnv();
    const m = createRunConditionsMonitor(e);
    m.start();
    e.fire('resize'); // same size: no event
    e.doc.visibilityState = 'hidden';
    e.fire('visibilitychange');
    e.advance(10);
    e.doc.visibilityState = 'visible';
    e.fire('visibilitychange');
    const r = m.stop();
    ok('same-size resize adds no canvas event', !r.events.some((ev) => ev.kind === 'canvas'));
    ok('hidden + visible events recorded', r.events.map((ev) => ev.kind).join(',') === 'hidden,visible');
    ok('checkpoint/notePhase after stop are harmless', (m.checkpoint('x'), m.notePhase('y'), true));
  }

  // ---- a paused game invalidates (author-caught 2026-09-24) -----------------
  {
    const e = fakeEnv();
    let paused = true;
    let tick = null;
    const m = createRunConditionsMonitor({
      ...e,
      readPaused: () => paused,
      setInterval: (fn) => ((tick = fn), 1),
      clearInterval: () => (tick = null),
    });
    m.start(); // sample 1: paused
    e.advance(1000);
    tick(); // sample 2: paused
    paused = false;
    e.advance(1000);
    tick(); // sample 3: running
    const r = m.stop(); // sample 4: running
    ok('paused run is invalid', r.valid === false && /PAUSED/.test(r.invalidReasons.join(' ')));
    ok('paused samples counted', r.paused.pausedSamples === 2 && r.paused.samples === 4);
    ok('paused is the first invalid event, at t=0', r.firstInvalid?.kind === 'paused' && r.firstInvalid.atMs === 0);
    ok('unpause recorded on the timeline', r.events.some((ev) => ev.kind === 'unpaused'));
  }
  {
    const e = fakeEnv();
    let tick = null;
    const m = createRunConditionsMonitor({
      ...e,
      readPaused: () => false,
      setInterval: (fn) => ((tick = fn), 1),
      clearInterval: () => (tick = null),
    });
    m.start();
    tick();
    const r = m.stop();
    ok('a never-paused run stays valid, with no pause events', r.valid === true && r.events.length === 0);
    ok('a throwing pause read is ignored, not fatal', (() => {
      const m2 = createRunConditionsMonitor({ ...fakeEnv(), readPaused: () => { throw new Error('x'); }, setInterval: () => 1, clearInterval: () => {} });
      m2.start();
      return m2.stop().valid === true;
    })());
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
