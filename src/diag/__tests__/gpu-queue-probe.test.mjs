/**
 * gpu-queue-probe.js — times device.queue.onSubmittedWorkDone() round trips
 * during a load. Load-bearing: one probe outstanding at a time, a probe still
 * outstanding at stop() is REPORTED (the stall in progress is the finding),
 * and late resolutions never mutate a finished result.
 */
import { createGpuQueueProbe, summarizeGpuQueueSamples, GPU_QUEUE_STALL_MS } from '../gpu-queue-probe.js';
import { buildGpuQueueSection } from '../load-report.js';

function fakeGpu() {
  let t = 0;
  let tick = null;
  const pending = [];
  const device = {
    queue: {
      onSubmittedWorkDone: () => new Promise((res) => pending.push(res)),
    },
  };
  return {
    device,
    now: () => t,
    advance: (ms) => (t += ms),
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval: () => (tick = null),
    tick: () => tick?.(),
    resolveAll: () => pending.splice(0).forEach((r) => r()),
    pendingCount: () => pending.length,
    timerLive: () => tick !== null,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

export async function run(t) {
  const { ok } = t;

  // ---- no device yet: no samples, no crash --------------------------------
  {
    const g = fakeGpu();
    let dev = null;
    const p = createGpuQueueProbe({ getDevice: () => dev, now: g.now, setInterval: g.setInterval, clearInterval: g.clearInterval });
    p.start();
    g.tick();
    const r = p.stop();
    ok('no device: zero samples', r.sampleCount === 0 && r.deviceSeenAtMs === null);
    ok('timer cleared on stop', !g.timerLive());
    ok('no-samples verdict', buildGpuQueueSection(r, 100).verdict === 'no-samples');
  }

  // ---- one outstanding at a time; a long stall is ONE sample ----------------
  {
    const g = fakeGpu();
    const p = createGpuQueueProbe({ getDevice: () => g.device, now: g.now, setInterval: g.setInterval, clearInterval: g.clearInterval });
    p.start(); // immediate first tick
    ok('first probe posted on start', g.pendingCount() === 1);
    g.advance(250); g.tick(); g.advance(250); g.tick();
    ok('no pile-up while outstanding', g.pendingCount() === 1);
    g.advance(9500);
    g.resolveAll();
    await flush();
    g.tick(); // next probe
    g.advance(5);
    g.resolveAll();
    await flush();
    const r = p.stop();
    ok('two samples', r.sampleCount === 2);
    ok('max is the 10s stall', r.maxMs === 10000);
    ok('stall counted once', r.stallCount === 1 && r.stalledMs === 10000);
    const sec = buildGpuQueueSection(r, 2700);
    ok('10s GPU wait vs 2.7s main-thread = gpu-side-stall', sec.verdict === 'gpu-side-stall');
    ok('note names the main-thread comparison', /2700ms/.test(sec.note));
  }

  // ---- outstanding at stop is reported, and late resolution is ignored ------
  {
    const g = fakeGpu();
    const p = createGpuQueueProbe({ getDevice: () => g.device, now: g.now, setInterval: g.setInterval, clearInterval: g.clearInterval });
    p.start();
    g.advance(4000);
    const r = p.stop();
    ok('in-flight probe reported as unfinished', r.stillOutstandingMs === 4000 && r.worst[0].unfinished === true);
    g.resolveAll();
    await flush();
    ok('late resolution does not mutate result', r.sampleCount === 1);
  }

  // ---- verdict boundaries ----------------------------------------------------
  {
    const clear = summarizeGpuQueueSamples({ samples: [{ atMs: 0, ms: 3 }, { atMs: 250, ms: 12 }], windowMs: 500 });
    ok('clear verdict', buildGpuQueueSection(clear, 50).verdict === 'clear');
    const backlog = summarizeGpuQueueSamples({ samples: [{ atMs: 0, ms: GPU_QUEUE_STALL_MS + 100 }], windowMs: 500 });
    ok('backlog verdict', buildGpuQueueSection(backlog, 50).verdict === 'gpu-side-backlog');
    const mainBound = summarizeGpuQueueSamples({ samples: [{ atMs: 0, ms: 3000 }], windowMs: 5000 });
    ok('GPU wait no bigger than main-thread stall is not blamed on GPU', buildGpuQueueSection(mainBound, 2900).verdict === 'gpu-side-backlog');
    ok('null in, null out', buildGpuQueueSection(null, 1) === null);
  }

  // ---- a throwing device read / onSubmittedWorkDone is survived --------------
  {
    const g = fakeGpu();
    const p = createGpuQueueProbe({
      getDevice: () => ({ queue: { onSubmittedWorkDone: () => { throw new Error('lost'); } } }),
      now: g.now, setInterval: g.setInterval, clearInterval: g.clearInterval,
    });
    p.start();
    g.tick();
    const r = p.stop();
    ok('throwing queue counted as error', r.errors >= 1 && r.sampleCount === 0);
  }
}
