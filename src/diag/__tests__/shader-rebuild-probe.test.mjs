/**
 * Node tests for shader-rebuild-probe.js.
 *
 * The assertions that earn their keep are the CLASSIFICATION ones: this probe
 * exists to tell `materialChanged` (a new material object each frame — fix by
 * pooling) apart from `nodesChanged` (the same material with a rebuilt node
 * graph — pooling would change nothing). Getting that backwards would send a
 * fix at the wrong subsystem, which is the exact failure this whole
 * investigation already paid for four times over.
 *
 * Also pinned: the probe must never break the render loop, and must never
 * count three's own early-return (a RenderObject that already carries its
 * nodeBuilderState never consults the shared cache at all) as a cache miss.
 */
import { createShaderRebuildProbe, defaultDescribeRenderObject, DEFAULT_MAX_LABELS } from '../shader-rebuild-probe.js';

/** A stand-in for three's `Nodes`, with the same double-cache shape. */
function fakeNodes() {
  const nodeBuilderCache = new Map();
  const perObject = new Map();
  const builds = [];
  const nodes = {
    nodeBuilderCache,
    getForRenderCacheKey: (ro) => ro.cacheKey,
    get(ro) {
      if (!perObject.has(ro)) perObject.set(ro, {});
      return perObject.get(ro);
    },
    getForRender(ro) {
      const data = this.get(ro);
      if (data.nodeBuilderState !== undefined) return data.nodeBuilderState;
      let state = nodeBuilderCache.get(ro.cacheKey);
      if (state === undefined) {
        // A deliberate busy-wait ON A GENUINE MISS ONLY, so the probe's OWN
        // clock (real performance.now() reads, not a fake) has something real
        // to measure — see the "worst offender is first" test below, which
        // exists specifically to prove the ranking is by TIME, not count.
        if (ro.slowMs > 0) {
          const until = performance.now() + ro.slowMs;
          while (performance.now() < until) {
            /* deliberate spin */
          }
        }
        state = { builtFor: ro.cacheKey };
        builds.push(ro.cacheKey);
        nodeBuilderCache.set(ro.cacheKey, state);
      }
      data.nodeBuilderState = state;
      return state;
    },
  };
  return { nodes, builds, nodeBuilderCache };
}

const ro = (cacheKey, uuid, objName = 'tile', matName = 'NodeMaterial', slowMs = 0) => ({
  cacheKey,
  material: { uuid, type: matName },
  object: { name: objName },
  slowMs,
});

export function run(t) {
  const { ok } = t;

  // ---- refuses a bad handle rather than reporting a silent zero forever ----
  {
    let threw = null;
    try {
      createShaderRebuildProbe({ nodes: {} });
    } catch (e) {
      threw = e;
    }
    ok('it refuses a non-Nodes object', threw !== null);
    ok('...and says what it needs', threw.message.includes('getForRender'));
  }

  // ---- install / uninstall is exactly reversible ---------------------------
  {
    const { nodes } = fakeNodes();
    const before = nodes.getForRender;
    const probe = createShaderRebuildProbe({ nodes });
    ok('not installed until asked', probe.isInstalled() === false);
    ok('install reports it did something', probe.install() === true);
    ok('...and is idempotent', probe.install() === false);
    ok('the method was actually replaced', nodes.getForRender !== before);
    ok('uninstall reports it did something', probe.uninstall() === true);
    ok('the original method is restored EXACTLY', nodes.getForRender === before);
    ok('...and uninstall is idempotent too', probe.uninstall() === false);
  }

  // ---- a cold first build is a miss; the second identical one is a hit -----
  {
    const { nodes, builds } = fakeNodes();
    const probe = createShaderRebuildProbe({ nodes });
    probe.install();
    probe.getForRenderCalled = null;

    nodes.getForRender(ro(1, 'mat-a'));
    ok('the first ever build is a miss', probe.stats().misses === 1);
    // A DIFFERENT render object, same material, same key — three's shared
    // nodeBuilderCache should carry it, so this must NOT count as a rebuild.
    nodes.getForRender(ro(1, 'mat-a'));
    ok('a second render object with the same key is a HIT, not a rebuild', probe.stats().hits === 1);
    ok('...and the underlying build really only ran once', builds.length === 1);
    ok('calls counts both', probe.stats().calls === 2);
  }

  // ---- three's own per-object early return is never counted as a miss ------
  {
    const { nodes } = fakeNodes();
    const probe = createShaderRebuildProbe({ nodes });
    probe.install();
    const obj = ro(7, 'mat-x');
    nodes.getForRender(obj); // cold miss, populates both caches
    nodes.getForRender(obj); // SAME render object — three returns early
    const s = probe.stats();
    ok('the repeat call on the same render object is not a miss', s.misses === 1);
    ok('...it is counted as a hit', s.hits === 1);
  }

  // ---- THE CLASSIFICATION: a new material object every time ---------------
  {
    const { nodes } = fakeNodes();
    const probe = createShaderRebuildProbe({ nodes });
    probe.install();
    // Same label ("tile/NodeMaterial"), new uuid AND new key each round — the
    // signature of a material being rebuilt from scratch every frame.
    nodes.getForRender(ro(10, 'uuid-1'));
    nodes.getForRender(ro(11, 'uuid-2'));
    nodes.getForRender(ro(12, 'uuid-3'));
    const label = probe.stats().labels[0];
    ok('all three are misses', label.misses === 3);
    ok('the first is unclassified (a cold cache is not churn)', label.materialChanged + label.nodesChanged === 2);
    ok('a NEW material object each time reads as materialChanged', label.materialChanged === 2);
    ok('...and never as nodesChanged', label.nodesChanged === 0);
    ok('distinct cache keys are counted', label.distinctCacheKeys === 3);
  }

  // ---- THE CLASSIFICATION: same material, rebuilt node graph --------------
  {
    const { nodes } = fakeNodes();
    const probe = createShaderRebuildProbe({ nodes });
    probe.install();
    // SAME uuid throughout — the material object survived — but the cache key
    // moves every round, which can only mean its nodes were rebuilt/mutated.
    nodes.getForRender(ro(20, 'uuid-same'));
    nodes.getForRender(ro(21, 'uuid-same'));
    nodes.getForRender(ro(22, 'uuid-same'));
    const label = probe.stats().labels[0];
    ok('all three are misses', label.misses === 3);
    ok('the same material with a new graph reads as nodesChanged', label.nodesChanged === 2);
    ok('...and never as materialChanged', label.materialChanged === 0);
    ok(
      'the two classifications are mutually exclusive per observation',
      label.materialChanged + label.nodesChanged === label.misses - 1
    );
  }

  // ---- labels are ranked worst-first BY TIME, not just count ----------------
  // A label that misses once for 40 seconds is the finding a report must lead
  // with; a label that misses five times for a few ms each is noise beside it
  // — count-sorting would get that backwards. `quiet` misses once but slowly;
  // `noisy` misses five times but each is near-instant, so a count-based sort
  // would (wrongly) put `noisy` first.
  {
    const { nodes } = fakeNodes();
    const probe = createShaderRebuildProbe({ nodes });
    probe.install();
    nodes.getForRender(ro(30, 'a', 'quiet', 'NodeMaterial', 20));
    for (let i = 0; i < 5; i++) nodes.getForRender(ro(40 + i, `n${i}`, 'noisy'));
    const labels = probe.stats().labels;
    ok('misses are still counted correctly per label', labels.find((l) => l.label.startsWith('noisy')).misses === 5);
    ok('the slow-but-rare offender is ranked first, by wall-clock time', labels[0].label.startsWith('quiet'));
    ok('...with a real, measured duration behind it', labels[0].ms >= 15);
    ok(
      '...and the frequent-but-cheap one is still reported',
      labels.some((l) => l.label.startsWith('noisy'))
    );

    const s = probe.stats();
    ok('totalMissMs sums every miss across every label', s.totalMissMs >= 15);
    ok('worstMissMs is the single worst rebuild, not a sum', s.worstMissMs >= 15 && s.worstMissMs <= s.totalMissMs);

    probe.reset();
    const r = probe.stats();
    ok('reset zeroes the accumulated timing, not just the counts', r.totalMissMs === 0 && r.worstMissMs === 0);
  }

  // ---- a throwing describe() must never break the render loop -------------
  {
    const { nodes, builds } = fakeNodes();
    const probe = createShaderRebuildProbe({
      nodes,
      describe: () => {
        throw new Error('label exploded');
      },
    });
    probe.install();
    let threw = null;
    try {
      nodes.getForRender(ro(50, 'mat'));
    } catch (e) {
      threw = e;
    }
    ok('the render path still completes', threw === null);
    ok('...and the real build still happened', builds.length === 1);
    ok('...and the failure is counted, not swallowed silently', probe.stats().labelsDropped === 1);
  }

  // ---- the label table is bounded -----------------------------------------
  {
    const { nodes } = fakeNodes();
    const probe = createShaderRebuildProbe({ nodes, maxLabels: 3 });
    probe.install();
    for (let i = 0; i < 10; i++) nodes.getForRender(ro(100 + i, `u${i}`, `obj${i}`));
    const s = probe.stats();
    ok('the label table is capped', s.labels.length === 3);
    ok('...and the drops are reported rather than hidden', s.labelsDropped === 7);
    ok('every miss is still counted in the total', s.misses === 10);
  }

  // ---- reset clears counters but leaves the hook installed -----------------
  {
    const { nodes } = fakeNodes();
    const probe = createShaderRebuildProbe({ nodes });
    probe.install();
    nodes.getForRender(ro(200, 'm'));
    probe.reset();
    const s = probe.stats();
    ok('counters are cleared', s.misses === 0 && s.hits === 0 && s.calls === 0);
    ok('labels are cleared', s.labels.length === 0);
    ok('...but the probe is still installed', s.installed === true);
  }

  // ---- the default label is stable across a material rebuild --------------
  {
    // If the label included the uuid, every rebuilt material would land in its
    // own bucket and `materialChanged` could never be observed at all.
    const a = defaultDescribeRenderObject(ro(1, 'uuid-1', 'tile', 'NodeMaterial'));
    const b = defaultDescribeRenderObject(ro(2, 'uuid-2', 'tile', 'NodeMaterial'));
    ok('the same object+material type labels identically across rebuilds', a === b);
    ok('...and it does not embed the uuid', !a.includes('uuid-1'));
    ok('a different object gets a different label', defaultDescribeRenderObject(ro(1, 'u', 'other')) !== a);
  }

  ok(`the default label cap is ${DEFAULT_MAX_LABELS}`, DEFAULT_MAX_LABELS === 64);
}
