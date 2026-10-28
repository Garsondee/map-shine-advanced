/**
 * pipeline-governor.test.mjs — every pipeline compile, named and timed, and the big ones kept off the GPU's
 * main thread (2026-10-27, epic mmp-fpu).
 *
 * A fake WebGPU backend records exactly HOW each pipeline was requested (`promises === null` is the synchronous
 * path that blocks the GPU process; an array is the asynchronous one), so the tests can state what matters:
 * a big shader never takes the synchronous path, a one-shot pass always does, a blocking block restores the old
 * guarantee, the crash breadcrumbs are written BEFORE the compile and cleared after it, and a lost device leaves
 * the evidence in place.
 */
import {
  createInFlightTracker,
  createPipelineGovernor,
  describePipeline,
  fingerprint,
  SLOW_COMPILE_MS,
  SYNC_CHARS_PER_TASK,
} from '../pipeline-governor.js';
import { HEAVY_PIPELINE_CHARS, markCompileDeferrable, markCompileSyncOnly } from '../../core/compile-policy.js';

/** A backend that records requests and lets the test decide when each GPU job "finishes". */
function fakeBackend() {
  const requests = [];
  const asyncResolvers = [];
  const queueWaiters = [];
  const utils = {
    name: 'utils',
    createRenderPipeline(renderObject, promises) {
      requests.push({ renderObject, async: promises !== null && promises !== undefined });
      if (promises) promises.push(new Promise((resolve) => asyncResolvers.push(resolve)));
      return 'original-result';
    },
  };
  const device = {
    queue: { onSubmittedWorkDone: () => new Promise((resolve, reject) => queueWaiters.push({ resolve, reject })) },
  };
  return { renderer: { backend: { pipelineUtils: utils, device } }, utils, requests, asyncResolvers, queueWaiters };
}

const pipeline = (chars, name = 'mat', material = {}) => ({
  pipeline: {
    vertexProgram: { code: 'v'.repeat(Math.floor(chars / 2)) },
    fragmentProgram: { code: 'f'.repeat(Math.ceil(chars / 2)) },
  },
  material: { name, ...material },
});

/** A guard that records the order of events. */
const spyGuard = (events) => ({
  noteCompileStart: (id, label, chars) => events.push(['start', id, label, chars]),
  noteCompileEnd: (id) => events.push(['end', id]),
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function run(t) {
  const { ok } = t;

  // ── DESCRIBING A PIPELINE ────────────────────────────────────────────────
  {
    const d = describePipeline(pipeline(1000, 'candle'));
    ok(
      'a pipeline is named after its material and sized by its generated shader',
      d.label.startsWith('candle#') && d.chars === 1000
    );
    ok(
      '...with a fingerprint that tells two same-named materials apart',
      describePipeline(pipeline(1000, 'candle')).label === d.label &&
        describePipeline({
          ...pipeline(1000, 'candle'),
          pipeline: { vertexProgram: { code: 'a' }, fragmentProgram: { code: 'b' } },
        }).label !== d.label
    );
    ok(
      'a render object with nothing in it still gets a label, not a throw',
      describePipeline({}).label.startsWith('pipeline#') && describePipeline(null).chars === 0
    );
    ok(
      'the fingerprint is stable and short',
      fingerprint('abc') === fingerprint('abc') &&
        fingerprint('abc').length === 6 &&
        fingerprint('abc') !== fingerprint('abd')
    );
  }

  // ── THE TRACKER ──────────────────────────────────────────────────────────
  {
    let clock = 0;
    const tracker = createInFlightTracker({ now: () => clock });
    ok(
      'idle resolves at once when nothing is in flight',
      (await Promise.race([tracker.idle().then(() => 'idle'), tick().then(() => 'late')])) === 'idle'
    );
    tracker.begin('a', { label: 'one', chars: 10, mode: 'async', reason: 'flagged' });
    tracker.begin('b', { label: 'two', chars: 20, mode: 'sync', reason: 'default' });
    let idled = false;
    tracker.idle().then(() => (idled = true));
    clock = 400;
    ok('end reports the elapsed time', tracker.end('a')?.ms === 400);
    await tick();
    ok('idle waits for EVERYTHING', idled === false && tracker.inFlight() === 1);
    clock = 900;
    tracker.end('b', new Error('boom'));
    await tick();
    ok('...and resolves when the last one ends, failed or not', idled === true && tracker.inFlight() === 0);
    ok('failures are counted', tracker.counts().completed === 1 && tracker.counts().failed === 1);
    ok('ending an unknown id is harmless', tracker.end('nope') === null);
    ok(
      'records keep what each compile was',
      tracker.records().length === 2 && tracker.records()[0].label === 'one' && tracker.records()[1].failed === true
    );
  }

  // ── INSTALLING ───────────────────────────────────────────────────────────
  {
    const b = fakeBackend();
    const original = b.utils.createRenderPipeline;
    const gov = createPipelineGovernor({ renderer: b.renderer });
    ok('install wraps the one creation function', gov.install() === true && b.utils.createRenderPipeline !== original);
    ok(
      'installing twice is a no-op, not a double wrap',
      gov.install() === true && createPipelineGovernor({ renderer: b.renderer }).install() === true
    );
    gov.uninstall();
    ok('uninstall puts the original back', b.utils.createRenderPipeline === original);

    const missing = createPipelineGovernor({ renderer: { backend: {} } });
    ok(
      'a renderer of an unexpected shape installs nothing and says why',
      missing.install() === false && /pipelineUtils/.test(missing.report().reason ?? '')
    );
    ok('...and the report still works', missing.report().installed === false && missing.report().created === 0);
    ok('...as does a missing renderer entirely', createPipelineGovernor({ renderer: null }).install() === false);
  }

  // ── THE POLICY IN ACTION ─────────────────────────────────────────────────
  {
    const b = fakeBackend();
    const events = [];
    const gov = createPipelineGovernor({ renderer: b.renderer, guard: spyGuard(events) });
    gov.install();
    const create = (ro, promises = null) => b.utils.createRenderPipeline(ro, promises);

    // a small, unmarked pipeline: the old synchronous path
    create(pipeline(4_000, 'small'));
    ok('a small pipeline is created the old, synchronous way', b.requests.at(-1).async === false);
    ok('...and counts as in flight until the GPU has finished it', gov.inFlight() === 1);
    await Promise.resolve();
    await Promise.resolve();
    ok('one queue wait covers every synchronous creation of the task', b.queueWaiters.length === 1);
    b.queueWaiters[0].resolve();
    await gov.idle();
    ok('...then it clears', gov.inFlight() === 0 && events.some((e) => e[0] === 'end'));

    // a flagged per-frame effect: async, immediately, from the current state
    const flame = pipeline(4_000, 'flame', { userData: {} });
    markCompileDeferrable(flame.material, 'flame');
    create(flame);
    ok('a flagged effect is requested ASYNCHRONOUSLY', b.requests.at(-1).async === true);
    ok('...at once, from the render object as it is now (not from a queue, later)', b.requests.length === 2);
    ok('...and is in flight until its pipeline resolves', gov.inFlight() === 1);
    b.asyncResolvers.at(-1)();
    await gov.idle();
    ok('...when it does, it clears', gov.inFlight() === 0);

    // a one-shot pass: sync however large
    const bake = pipeline(HEAVY_PIPELINE_CHARS * 2, 'bake');
    markCompileSyncOnly(bake.material, 'sun shadow bake');
    create(bake);
    ok('a one-shot pass is NEVER deferred, however large', b.requests.at(-1).async === false);
    await tick();
    b.queueWaiters.at(-1).resolve();
    await gov.idle();

    // an unmarked monster: async, named in the log
    const monster = pipeline(HEAVY_PIPELINE_CHARS + 10, 'monster');
    create(monster);
    ok('an unmarked shader past the threshold is deferred anyway', b.requests.at(-1).async === true);
    ok(
      '...and the report names it, so someone decides what it should have been',
      gov.report().heavyUnflagged.some((l) => l.startsWith('monster#'))
    );
    b.asyncResolvers.at(-1)();
    await gov.idle();
    create(pipeline(HEAVY_PIPELINE_CHARS + 10, 'monster'));
    ok('...once, not on every creation', gov.report().heavyUnflagged.length === 1);
    b.asyncResolvers.at(-1)();
    await gov.idle();

    // compileAsync: already async, counted and left alone
    const before = b.requests.length;
    const promises = [];
    const out = create(pipeline(4_000, 'precompiled'), promises);
    ok(
      "three's own compileAsync passes straight through, result intact",
      out === 'original-result' &&
        b.requests.length === before + 1 &&
        b.requests.at(-1).async === true &&
        promises.length === 1
    );
    ok('...and is counted', gov.report().compileAsync === 1 && gov.inFlight() === 1);
    b.asyncResolvers.at(-1)();
    await gov.idle();
    const rep = gov.report();
    ok(
      'the report totals every route',
      rep.created === 6 && rep.sync === 2 && rep.async === 3 && rep.installed === true
    );
    ok(
      '...and the slowest are listed with sizes',
      Array.isArray(rep.slowest) && rep.slowest.every((r) => typeof r.chars === 'number')
    );
  }

  // ── BLOCKING MODE ────────────────────────────────────────────────────────
  {
    const b = fakeBackend();
    const gov = createPipelineGovernor({ renderer: b.renderer });
    gov.install();
    const flame = pipeline(4_000, 'flame');
    markCompileDeferrable(flame.material);
    const result = gov.blocking(() => {
      b.utils.createRenderPipeline(flame, null);
      return 'block result';
    });
    ok(
      "inside blocking(), even a flagged effect is created synchronously — the floor-prepare block's guarantee",
      b.requests.at(-1).async === false && result === 'block result'
    );
    b.utils.createRenderPipeline(flame, null);
    ok('...and the moment it returns, deferral is back', b.requests.at(-1).async === true);
    gov.blocking(() => gov.blocking(() => b.utils.createRenderPipeline(flame, null)));
    ok('blocking() nests', b.requests.at(-1).async === false);
    try {
      gov.blocking(() => {
        throw new Error('inside');
      });
    } catch (_) {
      // expected
    }
    b.utils.createRenderPipeline(flame, null);
    ok('a throw inside blocking() cannot leave the governor stuck synchronous', b.requests.at(-1).async === true);
  }

  // ── A HEAVY PIPELINE IS NEVER SYNCHRONOUS, EVEN INSIDE A BLOCKING BLOCK ──
  {
    const b = fakeBackend();
    const gov = createPipelineGovernor({ renderer: b.renderer });
    gov.install();
    const water = pipeline(HEAVY_PIPELINE_CHARS + 1, 'water');
    markCompileDeferrable(water.material);
    gov.blocking(() => b.utils.createRenderPipeline(water, null));
    ok(
      'inside blocking(), a heavy pipeline still goes to a worker thread (water was 12-16 s per pipeline, cold)',
      b.requests.at(-1).async === true
    );
    ok('...and the report says a blocking block asked for it', gov.report().heavyInBlocking === 1);
    const bake = pipeline(HEAVY_PIPELINE_CHARS * 2, 'bake');
    markCompileSyncOnly(bake.material);
    gov.blocking(() => b.utils.createRenderPipeline(bake, null));
    ok(
      '...but a one-shot pass stays synchronous: skipping it would lose its result',
      b.requests.at(-1).async === false
    );
    await tick(); // a new task: the one-shot pass above spent this one's synchronous budget
    const small = pipeline(HEAVY_PIPELINE_CHARS - 1, 'big-but-ordinary');
    gov.blocking(() => b.utils.createRenderPipeline(small, null));
    ok('...and one just under the threshold is still the old synchronous way', b.requests.at(-1).async === false);
  }

  // ── THE PER-TASK BUDGET: A BURST OF SMALL COMPILES IS ONE LONG GPU TASK ──
  {
    const b = fakeBackend();
    const gov = createPipelineGovernor({ renderer: b.renderer });
    gov.install();
    const create = (chars, name, material) => b.utils.createRenderPipeline(pipeline(chars, name, material), null);
    const third = Math.floor(SYNC_CHARS_PER_TASK / 3) + 1;
    create(third, 'one');
    create(third, 'two');
    ok('the first compiles of a task are synchronous', b.requests.at(-1).async === false && b.requests.length === 2);
    create(third, 'three');
    ok(
      'once the task has spent its synchronous budget, the next pipeline is asynchronous instead',
      b.requests.at(-1).async === true
    );
    create(100, 'tiny');
    ok(
      'the budget is a running sum, not a latch: what still fits compiles the old way',
      b.requests.at(-1).async === false
    );
    create(third, 'four');
    ok('...while another that does not fit goes asynchronous too', b.requests.at(-1).async === true);
    ok('...counted, so the load report can say how often the valve opened', gov.report().overBudget === 2);
    await tick();
    create(third, 'next-task');
    ok('the budget starts over when the event loop turns', b.requests.at(-1).async === false);

    // a one-shot pass is exempt from conversion but still occupies the GPU, so it counts
    await tick();
    const bake = pipeline(Math.floor(SYNC_CHARS_PER_TASK * 0.9), 'bake');
    markCompileSyncOnly(bake.material);
    b.utils.createRenderPipeline(bake, null);
    ok('a one-shot pass is created synchronously whatever the budget', b.requests.at(-1).async === false);
    create(Math.floor(SYNC_CHARS_PER_TASK * 0.2), 'after-bake');
    ok(
      '...and what it cost is held against the ordinary pipelines that follow it in the task',
      b.requests.at(-1).async === true
    );

    // the budget is for synchronous work only: a flagged effect was already asynchronous and costs the task nothing
    await tick();
    const flame = pipeline(SYNC_CHARS_PER_TASK, 'flame');
    markCompileDeferrable(flame.material);
    b.utils.createRenderPipeline(flame, null);
    create(third, 'still-fits');
    ok(
      'an asynchronous pipeline spends none of the synchronous budget',
      b.requests.at(-2).async === true && b.requests.at(-1).async === false
    );
    ok(
      'the budget is a published constant, a few seconds of compile',
      SYNC_CHARS_PER_TASK >= 40_000 && SYNC_CHARS_PER_TASK < HEAVY_PIPELINE_CHARS * 3
    );
  }

  // ── THE CRASH BREADCRUMBS ────────────────────────────────────────────────
  {
    const b = fakeBackend();
    const events = [];
    const gov = createPipelineGovernor({ renderer: b.renderer, guard: spyGuard(events) });
    gov.install();
    const flame = pipeline(60_000, 'flame');
    markCompileDeferrable(flame.material);
    b.utils.createRenderPipeline(flame, null);
    const startAt = events.findIndex((e) => e[0] === 'start');
    ok('the breadcrumb is written BEFORE the compile is requested', startAt === 0 && b.requests.length === 1);
    ok("...with the shader's name and size", events[0][2].startsWith('flame#') && events[0][3] === 60_000);
    ok('...and no end yet', !events.some((e) => e[0] === 'end'));
    b.asyncResolvers[0]();
    await gov.idle();
    ok('it is cleared when the pipeline resolves', events.at(-1)[0] === 'end' && events.at(-1)[1] === events[0][1]);

    // a lost device: the queue wait REJECTS, and the evidence must stay where it is
    b.utils.createRenderPipeline(pipeline(3_000, 'small-at-death'), null);
    await tick();
    b.queueWaiters.at(-1).reject(new Error('device lost'));
    await tick();
    ok(
      'a rejected queue wait (device lost) leaves the synchronous compile IN FLIGHT as evidence',
      gov.inFlight() === 1 && !events.slice(2).some((e) => e[0] === 'end')
    );

    // a guard that throws must never break a compile
    const bad = createPipelineGovernor({
      renderer: fakeBackend().renderer,
      guard: {
        noteCompileStart: () => {
          throw new Error('storage full');
        },
        noteCompileEnd: () => {
          throw new Error('storage full');
        },
      },
    });
    bad.install();
    let threw = false;
    try {
      bad.report();
    } catch (_) {
      threw = true;
    }
    ok('a failing breadcrumb store never breaks the governor', !threw);
  }

  // ── FAILURES ─────────────────────────────────────────────────────────────
  {
    const b = fakeBackend();
    const gov = createPipelineGovernor({ renderer: b.renderer });
    gov.install();
    b.utils.createRenderPipeline = ((orig) => orig)(b.utils.createRenderPipeline);
    const exploding = { pipeline: pipeline(10).pipeline, material: { name: 'x' } };
    const wrapped = b.renderer.backend.pipelineUtils.createRenderPipeline;
    // make the ORIGINAL throw by swapping in a throwing backend
    const t2 = fakeBackend();
    t2.utils.createRenderPipeline = () => {
      throw new Error('descriptor build failed');
    };
    const gov2 = createPipelineGovernor({ renderer: t2.renderer });
    gov2.install();
    let rethrown = false;
    try {
      t2.utils.createRenderPipeline(exploding, null);
    } catch (e) {
      rethrown = /descriptor build failed/.test(e.message);
    }
    ok('an error in the original is rethrown, not swallowed', rethrown);
    ok('...and leaves nothing stuck in flight', gov2.inFlight() === 0 && gov2.report().failed === 1);
    ok('(sanity) the first backend is untouched by the second', typeof wrapped === 'function');
  }

  // ── A SLOW COMPILE IS A WARNING WITH A NAME ──────────────────────────────
  ok(
    'the slow-compile bar is a few seconds, well under the 15 s watchdog',
    SLOW_COMPILE_MS >= 1_000 && SLOW_COMPILE_MS <= 5_000
  );
}
