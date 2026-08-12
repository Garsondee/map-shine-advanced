/**
 * Node tests for pipeline-rebuild-probe.js.
 *
 * The fake `Pipelines` below reproduces three's real sequence
 * (three.webgpu.js:46803-46844) closely enough to exercise the two failure
 * modes a naive implementation would get wrong:
 *
 *   1. `usedTimes--` then maybe `_releasePipeline` (a `.delete()`) THEN maybe
 *      `_getRenderPipeline` (a `.set()`), both inside ONE call — so a genuine
 *      rebuild can leave `caches.size` completely unchanged. A probe that
 *      diffs `.size` before/after would miss this; this probe counts `.set()`
 *      calls directly instead, so it must not.
 *   2. `Pipelines.dispose()` reassigns `this.caches` to a brand new Map. A
 *      wrap installed once on the old Map would go silently dark after that;
 *      this probe re-verifies its wrap on every tracked call, so it must not.
 */
import {
  createPipelineRebuildProbe,
  defaultDescribeRenderObject,
  DEFAULT_MAX_LABELS,
} from '../pipeline-rebuild-probe.js';
import { defaultDescribeRenderObject as siblingDescribe } from '../shader-rebuild-probe.js';

/** A stand-in for three's `Pipelines`, with the same decrement/release/create shape. */
function fakePipelines() {
  let compiles = 0;
  const pending = new Map();
  const pipelines = {
    caches: new Map(),
    getForRender(renderObject) {
      const data = pending.get(renderObject) ?? { pipeline: null };
      pending.set(renderObject, data);

      const previousPipeline = data.pipeline;
      if (previousPipeline) previousPipeline.usedTimes--;

      const cacheKey = renderObject.cacheKey;
      let pipeline = this.caches.get(cacheKey);
      if (pipeline === undefined) {
        if (previousPipeline && previousPipeline.usedTimes === 0) {
          this.caches.delete(previousPipeline.cacheKey);
        }
        compiles++;
        pipeline = { cacheKey, usedTimes: 0 };
        this.caches.set(cacheKey, pipeline);
      }
      pipeline.usedTimes++;
      data.pipeline = pipeline;
      return pipeline;
    },
    dispose() {
      this.caches = new Map();
    },
  };
  return { pipelines, getCompiles: () => compiles };
}

const ro = (cacheKey, objName = 'tile', matName = 'NodeMaterial') => ({
  cacheKey,
  material: { type: matName },
  object: { name: objName },
});

export function run(t) {
  const { ok } = t;

  // ---- refuses a bad handle rather than reporting a silent zero forever ----
  {
    let threw = null;
    try {
      createPipelineRebuildProbe({ pipelines: {} });
    } catch (e) {
      threw = e;
    }
    ok('it refuses a non-Pipelines object', threw !== null);
    ok('...and says what it needs', threw.message.includes('getForRender'));
  }
  {
    let threw = null;
    try {
      createPipelineRebuildProbe({ pipelines: { getForRender: () => {} } });
    } catch (e) {
      threw = e;
    }
    ok('it also refuses a handle with no caches Map', threw !== null);
  }

  // ---- install / uninstall is exactly reversible ---------------------------
  {
    const { pipelines } = fakePipelines();
    const beforeGetForRender = pipelines.getForRender;
    const beforeCachesSet = pipelines.caches.set;
    const probe = createPipelineRebuildProbe({ pipelines });
    ok('not installed until asked', probe.isInstalled() === false);
    ok('install reports it did something', probe.install() === true);
    ok('...and is idempotent', probe.install() === false);
    ok('getForRender was actually replaced', pipelines.getForRender !== beforeGetForRender);
    pipelines.getForRender(ro(1)); // touch it once so caches.set gets wrapped too
    ok('...and caches.set was wrapped once exercised', pipelines.caches.set !== beforeCachesSet);
    ok('uninstall reports it did something', probe.uninstall() === true);
    ok('getForRender is restored EXACTLY', pipelines.getForRender === beforeGetForRender);
    ok('caches.set is restored too', pipelines.caches.set === beforeCachesSet);
    ok('...and uninstall is idempotent too', probe.uninstall() === false);
  }

  // ---- a cold compile is a miss; the identical repeat is a hit -------------
  {
    const { pipelines, getCompiles } = fakePipelines();
    const probe = createPipelineRebuildProbe({ pipelines });
    probe.install();
    const a = ro('key-x');

    pipelines.getForRender(a);
    ok('the first ever compile is a miss', probe.stats().misses === 1);
    pipelines.getForRender(a);
    ok('the identical repeat is a hit, not a rebuild', probe.stats().hits === 1);
    ok('...and the underlying compile really only ran once', getCompiles() === 1);
    ok('calls counts both', probe.stats().calls === 2);
  }

  // ---- a different render object with the same cache key is a hit ----------
  {
    const { pipelines, getCompiles } = fakePipelines();
    const probe = createPipelineRebuildProbe({ pipelines });
    probe.install();
    pipelines.getForRender(ro('shared-key', 'tileA'));
    pipelines.getForRender(ro('shared-key', 'tileB'));
    ok('the shared pipeline is reused for the second object', probe.stats().hits === 1);
    ok('...and only compiled once', getCompiles() === 1);
  }

  // ---- THE KEY SCENARIO: release + recreate nets .size to zero, still a miss
  {
    const { pipelines, getCompiles } = fakePipelines();
    const probe = createPipelineRebuildProbe({ pipelines });
    probe.install();
    const a = ro('key-1');
    pipelines.getForRender(a); // cold miss: caches = {key-1}
    ok('caches holds exactly one entry after the cold miss', pipelines.caches.size === 1);

    a.cacheKey = 'key-2'; // simulate a render-state change on the SAME object
    const sizeBefore = pipelines.caches.size;
    pipelines.getForRender(a); // releases key-1 AND creates key-2 in one call
    ok('the fake really did net .size to zero change (proving the scenario)', pipelines.caches.size === sizeBefore);
    ok('a real rebuild happened underneath', getCompiles() === 2);
    ok('the probe still detects it as a miss despite the flat .size', probe.stats().misses === 2);
    ok('...and does not misreport it as a hit', probe.stats().hits === 0);
  }

  // ---- THE DISPOSE SCENARIO: .caches reassigned mid-session, wrap self-heals
  {
    const { pipelines, getCompiles } = fakePipelines();
    const probe = createPipelineRebuildProbe({ pipelines });
    probe.install();
    pipelines.getForRender(ro('before-dispose'));
    ok('one miss before dispose', probe.stats().misses === 1);

    pipelines.dispose(); // reassigns pipelines.caches to a brand-new, unwrapped Map
    ok('dispose really did swap the Map instance', pipelines.caches.size === 0);

    pipelines.getForRender(ro('after-dispose'));
    ok('a compile after dispose still happened', getCompiles() === 2);
    ok('the probe self-heals and still counts it as a miss', probe.stats().misses === 2);
    ok('...it did not go silently dark after the reassignment', probe.stats().hits === 0);
  }

  // ---- labels are ranked worst-first, so the report leads with the culprit -
  {
    const { pipelines } = fakePipelines();
    const probe = createPipelineRebuildProbe({ pipelines });
    probe.install();
    pipelines.getForRender(ro('q', 'quiet'));
    for (let i = 0; i < 5; i++) pipelines.getForRender(ro(`n${i}`, 'noisy'));
    const labels = probe.stats().labels;
    ok('the worst offender is first', labels[0].label.startsWith('noisy'));
    ok(
      '...and the quiet one is still reported',
      labels.some((l) => l.label.startsWith('quiet'))
    );
    ok('the noisy label counted all five of its own misses', labels[0].misses === 5);
  }

  // ---- a throwing describe() must never break the render loop -------------
  {
    const { pipelines, getCompiles } = fakePipelines();
    const probe = createPipelineRebuildProbe({
      pipelines,
      describe: () => {
        throw new Error('label exploded');
      },
    });
    probe.install();
    let threw = null;
    try {
      pipelines.getForRender(ro('boom'));
    } catch (e) {
      threw = e;
    }
    ok('the render path still completes', threw === null);
    ok('...and the real compile still happened', getCompiles() === 1);
    ok('...and the failure is counted, not swallowed silently', probe.stats().labelsDropped === 1);
    ok('the miss is still counted in the total', probe.stats().misses === 1);
  }

  // ---- the label table is bounded -------------------------------------------
  {
    const { pipelines } = fakePipelines();
    const probe = createPipelineRebuildProbe({ pipelines, maxLabels: 3 });
    probe.install();
    for (let i = 0; i < 10; i++) pipelines.getForRender(ro(`k${i}`, `obj${i}`));
    const s = probe.stats();
    ok('the label table is capped', s.labels.length === 3);
    ok('...and the drops are reported rather than hidden', s.labelsDropped === 7);
    ok('every miss is still counted in the total', s.misses === 10);
  }

  // ---- reset clears counters but leaves the hook installed -------------------
  {
    const { pipelines } = fakePipelines();
    const probe = createPipelineRebuildProbe({ pipelines });
    probe.install();
    pipelines.getForRender(ro('r'));
    probe.reset();
    const s = probe.stats();
    ok('counters are cleared', s.misses === 0 && s.hits === 0 && s.calls === 0);
    ok('labels are cleared', s.labels.length === 0);
    ok('...but the probe is still installed', s.installed === true);
  }

  // ---- the default label matches shader-rebuild-probe.js's, on purpose ------
  {
    const object = ro('k', 'tile', 'NodeMaterial');
    ok(
      'labels from both probes are directly comparable for the same render object',
      defaultDescribeRenderObject(object) === siblingDescribe(object)
    );
  }

  ok(`the default label cap is ${DEFAULT_MAX_LABELS}`, DEFAULT_MAX_LABELS === 64);
}
