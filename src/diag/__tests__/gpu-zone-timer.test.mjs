/**
 * Node tests for gpu-zone-timer.js.
 *
 * The GPU side cannot be proven without a GPU, but three things CAN be, and each
 * is a trap the vendored three sets:
 *
 *   1. `probeTimestampSupport` must distinguish "the flag was never requested"
 *      from "this adapter cannot do it". Conflating those is precisely the
 *      week-long misdiagnosis this module exists to correct.
 *   2. A render pass with NO zone open must be COUNTED as unattributed, never
 *      folded into slot 0 — which is what a naive `currentSlot() ?? 0` would do,
 *      silently inflating whichever zone happens to be first in the taxonomy.
 *   3. A uid with no resolved timestamp must be skipped, because
 *      `getTimestamp(uid)` warns and returns a lying 0 (three.webgpu.js:67476).
 */
import { createFrameProfiler } from '../frame-profiler.js';
import { createGpuZoneTimer, parseTimestampUid, probeTimestampSupport } from '../gpu-zone-timer.js';

/** Stands in for THREE.InspectorBase — the real one is an exported class. */
class FakeInspectorBase {
  setRenderer(r) {
    this._renderer = r;
    return this;
  }
}

/** Drain the microtask queue AND a macrotask, so `.finally` handlers have run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeRenderer({ capable = true } = {}) {
  const pool = { timestamps: new Map() };
  return {
    // A real accessor pair, because three's `set inspector` calls
    // `value.setRenderer(this)` (three.webgpu.js:61016) and the timer relies on
    // that contract. A plain data property would let a broken timer pass.
    _inspector: null,
    get inspector() {
      return this._inspector;
    },
    set inspector(v) {
      this._inspector = v;
      if (v && typeof v.setRenderer === 'function') v.setRenderer(this);
    },
    backend: {
      isWebGPUBackend: true,
      trackTimestamp: capable,
      timestampQueryPool: { render: pool, compute: null },
    },
    info: { render: { drawCalls: 0, triangles: 0 } },
    _pool: pool,
    _resolveCalls: 0,
    async resolveTimestampsAsync() {
      this._resolveCalls++;
    },
  };
}

export async function run(t) {
  const { ok } = t;

  // ---- uid parsing ---------------------------------------------------------
  {
    const p = parseTimestampUid('r:3:17:f412');
    ok('a render uid parses', p.type === 'render' && p.call === 3 && p.context === 17 && p.frame === 412);
    ok('a compute uid parses', parseTimestampUid('c:1:2:f3').type === 'compute');
    ok('a malformed uid is null, not a partial object', parseTimestampUid('nonsense') === null);
    ok('a non-string is null', parseTimestampUid(null) === null);
    ok('a uid missing the frame segment is null', parseTimestampUid('r:1:2') === null);
  }

  // ---- capability probing: the three causes of "no" are different -----------
  {
    const none = probeTimestampSupport(null);
    ok('no renderer reports no method', none.method === 'none');
    ok('...and says the backend is not initialised', none.reason.includes('init'));

    const unarmedFlag = probeTimestampSupport({ backend: { trackTimestamp: false } });
    ok('a false flag reports no method', unarmedFlag.method === 'none');
    ok(
      '...and names the CONSTRUCTOR-ONLY flag as the likely cause, not the hardware',
      unarmedFlag.reason.includes('CONSTRUCTOR-ONLY')
    );
    ok(
      '...and explicitly says the two causes are different problems',
      unarmedFlag.reason.includes('different problems')
    );

    const ok1 = probeTimestampSupport({ backend: { trackTimestamp: true, isWebGPUBackend: true } });
    ok('a true post-init flag proves both halves', ok1.method === 'timestamp-query' && ok1.capable === true);
    ok('the backend is named', ok1.backend === 'webgpu');
    ok('a capable probe carries no reason', ok1.reason === null);

    // The viewer parks the flag at false after init and stashes the capability,
    // so the probe must read the stash too or it would report "no" forever.
    const parked = probeTimestampSupport({ backend: { trackTimestamp: false, __msaTimestampCapable: true } });
    ok('a parked-but-capable backend still probes as capable', parked.capable === true);
  }

  // ---- arm / disarm are symmetric and touch exactly one vendor flag ---------
  {
    const renderer = fakeRenderer();
    const profiler = createFrameProfiler();
    const timer = createGpuZoneTimer({ renderer, InspectorBase: FakeInspectorBase, profiler });

    renderer.backend.trackTimestamp = false; // as the viewer parks it
    renderer.backend.__msaTimestampCapable = true;

    ok('starts disarmed', timer.isArmed() === false);
    ok('arming reports success on a capable device', timer.arm() === true);
    ok('arming flips the one vendor flag', renderer.backend.trackTimestamp === true);
    ok('arming installs an inspector', renderer.inspector !== null);
    ok('the inspector was given the renderer', renderer.inspector._renderer === renderer);
    ok('arming twice is idempotent', timer.arm() === true);

    timer.disarm();
    ok('disarming clears the vendor flag', renderer.backend.trackTimestamp === false);
    ok('disarmed reports disarmed', timer.isArmed() === false);

    // An incapable device must refuse rather than half-arming.
    const weak = fakeRenderer({ capable: false });
    weak.backend.trackTimestamp = false;
    const weakTimer = createGpuZoneTimer({ renderer: weak, InspectorBase: FakeInspectorBase, profiler });
    ok('an incapable device refuses to arm', weakTimer.arm() === false);
    ok('...and does not touch the flag', weak.backend.trackTimestamp === false);
    ok('...and does not install an inspector', weak.inspector === null);
    ok('...and its status says so', weakTimer.getStatus().capable === false);
  }

  // ---- attribution: a pass with no zone open is COUNTED, not misfiled -------
  {
    const renderer = fakeRenderer();
    renderer.backend.__msaTimestampCapable = true;
    const profiler = createFrameProfiler();
    const timer = createGpuZoneTimer({ renderer, InspectorBase: FakeInspectorBase, profiler });
    profiler.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    timer.arm();

    // A render outside every bracket.
    renderer.inspector.beginRender('r:1:1:f1');
    ok('a pass with no zone open is counted as unattributed', timer.getStatus().unattributedPasses === 1);
    ok('...and its status explains where that time went instead', timer.getStatus().note.includes('residualGpuMs'));

    // A render inside a bracket.
    const slot = profiler.indexOf('light.drawPointLights');
    profiler.begin(slot);
    renderer.inspector.beginRender('r:2:1:f1');
    profiler.end(slot);

    // Resolve: three writes durations into the pool keyed by uid.
    renderer._pool.timestamps.set('r:2:1:f1', 1.75);
    timer.collect();
    await flush();

    const stats = profiler.snapshot().zoneStats.find((z) => z.id === 'light.drawPointLights');
    ok('a resolved duration is folded into the open zone', stats.gpu !== null && stats.gpu.sumMs === 1.75);
    ok('the fold is counted', timer.getStatus().foldedSamples === 1);
    ok('the unattributed pass was NOT folded anywhere', timer.getStatus().unattributedPasses === 1);
    ok(
      'the pool entry is pruned after folding (three never prunes it)',
      renderer._pool.timestamps.has('r:2:1:f1') === false
    );
    ok('resolveTimestampsAsync was actually called', renderer._resolveCalls === 1);
  }

  // ---- an unresolved uid must be skipped, never read as a lying 0 -----------
  {
    const renderer = fakeRenderer();
    renderer.backend.__msaTimestampCapable = true;
    const profiler = createFrameProfiler();
    const timer = createGpuZoneTimer({ renderer, InspectorBase: FakeInspectorBase, profiler });
    profiler.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    timer.arm();

    const slot = profiler.indexOf('light.drawIllum');
    profiler.begin(slot);
    renderer.inspector.beginRender('r:9:1:f9');
    profiler.end(slot);

    // Nothing put a duration in the pool — the query has not resolved yet.
    timer.collect();
    await flush();

    const stats = profiler.snapshot().zoneStats.find((z) => z.id === 'light.drawIllum');
    ok('an unresolved uid folds NOTHING (no lying zero)', stats.gpu === null);
    ok('...and stays pending for a later frame', timer.getStatus().pendingUids === 1);
    ok('...and is not counted as folded', timer.getStatus().foldedSamples === 0);

    // It resolves a frame later and folds then.
    renderer._pool.timestamps.set('r:9:1:f9', 0.5);
    timer.collect();
    await flush();
    ok(
      'a late-resolving uid folds on a later collect',
      profiler.snapshot().zoneStats.find((z) => z.id === 'light.drawIllum').gpu.sumMs === 0.5
    );
    ok('...and the pending map drains', timer.getStatus().pendingUids === 0);
  }

  // ---- disarmed, the inspector records nothing -----------------------------
  {
    const renderer = fakeRenderer();
    renderer.backend.__msaTimestampCapable = true;
    const profiler = createFrameProfiler();
    const timer = createGpuZoneTimer({ renderer, InspectorBase: FakeInspectorBase, profiler });
    timer.arm();
    const inspector = renderer.inspector;
    timer.disarm();

    inspector.beginRender('r:1:1:f1');
    ok('a disarmed inspector records nothing', timer.getStatus().pendingUids === 0);
    ok(
      'collect() on a disarmed timer is a no-op',
      (() => {
        const before = renderer._resolveCalls;
        timer.collect();
        return renderer._resolveCalls === before;
      })()
    );
  }

  // ---- overflow diagnostics: peak pending size ------------------------------
  {
    const renderer = fakeRenderer();
    renderer.backend.__msaTimestampCapable = true;
    const profiler = createFrameProfiler();
    const timer = createGpuZoneTimer({ renderer, InspectorBase: FakeInspectorBase, profiler });
    profiler.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    timer.arm();

    // Two passes open and never resolved (nothing is ever put into
    // pool.timestamps for them) — both sit in `pending` simultaneously.
    const slot = profiler.indexOf('light.drawPointLights');
    profiler.begin(slot);
    renderer.inspector.beginRender('r:1:1:f1');
    profiler.end(slot);
    profiler.begin(slot);
    renderer.inspector.beginRender('r:2:1:f1');
    profiler.end(slot);

    timer.collect();
    await flush();
    ok('peak pending size reflects both still-unresolved uids', timer.getStatus().maxPendingSize === 2);
    ok('a clean run reports no resolve-skip streak', timer.getStatus().maxResolveSkipStreak === 0);
  }

  // ---- overflow diagnostics: resolve-skip streak (a stuck resolve, not a
  // missed collect() call) ----------------------------------------------------
  {
    const pool = { timestamps: new Map() };
    let resolveCallCount = 0;
    let releaseResolve = null;
    const renderer = {
      _inspector: null,
      get inspector() {
        return this._inspector;
      },
      set inspector(v) {
        this._inspector = v;
        if (v && typeof v.setRenderer === 'function') v.setRenderer(this);
      },
      backend: {
        isWebGPUBackend: true,
        trackTimestamp: true,
        __msaTimestampCapable: true,
        timestampQueryPool: { render: pool, compute: null },
      },
      info: { render: { drawCalls: 0, triangles: 0 } },
      // Never settles until the test calls `releaseResolve()` — stands in for a
      // `resultBuffer.mapAsync` that is genuinely stuck behind a GPU backlog.
      async resolveTimestampsAsync() {
        resolveCallCount++;
        await new Promise((res) => {
          releaseResolve = res;
        });
      },
    };
    const profiler = createFrameProfiler();
    const timer = createGpuZoneTimer({ renderer, InspectorBase: FakeInspectorBase, profiler });
    profiler.arm({ settleFrames: 0, clockResolutionMs: 0.1 });
    timer.arm();

    const slot = profiler.indexOf('light.drawPointLights');
    const openAndCollect = (uid) => {
      profiler.begin(slot);
      renderer.inspector.beginRender(uid);
      profiler.end(slot);
      timer.collect();
    };

    openAndCollect('r:1:1:f1');
    await flush();
    ok('the first collect() call starts the (stuck) resolve', resolveCallCount === 1);
    ok('the call that STARTS a resolve is not itself a skip', timer.getStatus().maxResolveSkipStreak === 0);

    // Three more frames render and call collect() while the resolve is stuck.
    for (let i = 0; i < 3; i++) {
      openAndCollect(`r:${i + 2}:1:f1`);
      await flush();
    }
    ok('three consecutive blocked collect() calls are counted', timer.getStatus().maxResolveSkipStreak === 3);
    ok('no second resolve was requested while the first is still in flight', resolveCallCount === 1);

    releaseResolve();
    await flush();
    openAndCollect('r:99:1:f1');
    await flush();
    ok('once the stuck resolve clears, the next collect() starts a fresh one', resolveCallCount === 2);
    ok(
      'the PEAK streak is retained even after the current streak resets',
      timer.getStatus().maxResolveSkipStreak === 3
    );
  }

  // ---- status is honest about what it could not measure ---------------------
  {
    const renderer = fakeRenderer();
    renderer.backend.__msaTimestampCapable = true;
    const profiler = createFrameProfiler();
    const timer = createGpuZoneTimer({ renderer, InspectorBase: FakeInspectorBase, profiler });
    const idle = timer.getStatus();
    ok("an unarmed timer reports method 'idle', not 'none'", idle.method === 'idle');
    ok('...while still reporting that it is capable', idle.capable === true);
    ok('a clean armed status carries no alarm note', (timer.arm(), timer.getStatus().note === null));
  }
}
