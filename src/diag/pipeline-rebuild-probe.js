/**
 * pipeline-rebuild-probe.js — WHICH render object is triggering a real GPU
 * PIPELINE compile, one cache layer downstream of shader-rebuild-probe.js's
 * node-graph one.
 *
 * ============================================================================
 * WHY THIS IS A DIFFERENT CACHE, NOT A DUPLICATE PROBE
 * ============================================================================
 *
 * `Nodes.getForRender` (shader-rebuild-probe.js) answers "did the TSL node
 * graph have to be rebuilt from scratch" — a SHADER SOURCE question.
 * `Pipelines.getForRender` (this file, three.webgpu.js:46803-46844) answers a
 * different question one layer down: given whatever shader source exists,
 * does a GPU PIPELINE OBJECT for this exact combination (source + render
 * target format + blend state + primitive topology + ...) already exist? A
 * node graph can be perfectly cached — zero misses on the OTHER probe — while
 * this cache still misses, e.g. the same material rendering into a different
 * render target for the first time. A genuine miss reaches
 * `Pipelines._getRenderPipeline` (three.webgpu.js:46934-46944), which calls
 * `backend.createRenderPipeline(...)` — in the ordinary render loop, where
 * `promises` is always null, that runs its synchronous branch:
 * `device.createRenderPipeline(...)`, a real, main-thread-blocking driver
 * call.
 *
 * Built 2026-08-12 chasing a `steady-spike:pass.light.accumulate`-shaped
 * finding (mean hides a real max) that showed up in a report window where
 * shader-rebuild-probe.js read a clean 0-miss window at the same time —
 * meaning if a rebuild explains a spike like that, it is THIS cache, not
 * that one.
 *
 * ============================================================================
 * HOW THIS STAYS SAFE — OBSERVE THE SET, NEVER PREDICT THE KEY
 * ============================================================================
 *
 * shader-rebuild-probe.js can safely read `nodeBuilderCache.get(cacheKey)`
 * BEFORE delegating, because the cache key it needs is already fully
 * resolvable from the renderObject alone (`getForRenderCacheKey`). This
 * cache's key is NOT: `Pipelines.getForRender`'s own cache key
 * (`_getRenderCacheKey`) depends on `stageVertex`/`stageFragment`, which do
 * not exist until partway through that same method's own body (they come
 * from `renderObject.getNodeBuilderState()`, resolved inline). Predicting the
 * same key from outside would mean either calling private methods this probe
 * has no business calling, or re-deriving `getNodeBuilderState()` a second
 * time — a real risk of interfering with caching semantics this probe cannot
 * fully verify are side-effect-free from outside three's own source.
 *
 * A simpler idea — diff `pipelines.caches.size` before/after delegating — was
 * tried and rejected: `getForRender`'s miss branch can RELEASE the render
 * object's previous pipeline (`_releasePipeline`, which deletes from the same
 * `caches` map) in the same call where it installs the new one, so a genuine
 * rebuild can net to a ZERO size change. That is not a rare corner case —
 * it is exactly the "same object, new render state" churn this probe exists
 * to catch. So this probe counts `caches.set()` CALLS directly (a temporary,
 * self-healing wrap around the live `Map` instance, active only for the
 * duration of one tracked `getForRender` call), which is called exactly once
 * per genuine miss regardless of whether a release also happened alongside
 * it.
 *
 * `pipelines.caches` is also reassigned wholesale on `Pipelines.dispose()`
 * (three.webgpu.js:46886-46889, `this.caches = new Map()`) — reached from
 * `WebGPURenderer.dispose()` and hence from any renderer/context teardown
 * mid-session. A wrap installed once on the OLD Map object would silently go
 * dark after that with no error and no signal, which is worse than not
 * probing at all. So the wrap is re-verified and re-applied, if needed, on
 * every tracked call — one reference comparison, cheap next to the very
 * multi-millisecond compiles this probe exists to catch.
 *
 * The OUTER `getForRender` wrap is a one-time capture of the `Pipelines`
 * object itself, same as shader-rebuild-probe.js's own risk acceptance for
 * `renderer._nodes` — both assume the renderer constructs that object once
 * at init and never swaps the object's own identity mid-session, only resets
 * things owned by it (like `.caches`).
 *
 * @module diag/pipeline-rebuild-probe
 */

/** Cap on distinct labels retained. A runaway label function must not leak. */
export const DEFAULT_MAX_LABELS = 64;

/** @param {number} v @returns {number} one decimal place — same rounding perf-report.js uses for ms figures. */
function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

/**
 * Default label for a render object — same shape as
 * shader-rebuild-probe.js's `defaultDescribeRenderObject`, deliberately, so a
 * label from one probe's report is directly comparable to the other's.
 */
export function defaultDescribeRenderObject(renderObject) {
  const material = renderObject?.material ?? null;
  const object = renderObject?.object ?? null;
  const matName = material?.name || material?.type || 'material?';
  const objName = object?.name || object?.type || 'object?';
  return `${objName}/${matName}`;
}

/**
 * Wrap a three `Pipelines` instance and count PIPELINE (not node-graph)
 * rebuilds by label.
 *
 * @param {object} args
 * @param {object} args.pipelines - three's `renderer._pipelines` (duck-typed).
 * @param {(ro: object) => string} [args.describe]
 * @param {number} [args.maxLabels]
 */
export function createPipelineRebuildProbe({
  pipelines,
  describe = defaultDescribeRenderObject,
  maxLabels = DEFAULT_MAX_LABELS,
} = {}) {
  if (!pipelines || typeof pipelines.getForRender !== 'function' || !(pipelines.caches instanceof Map)) {
    throw new Error(
      'createPipelineRebuildProbe: needs a three Pipelines instance with getForRender() and a caches Map. ' +
        'Pass renderer._pipelines — this probe is useless against anything else, and failing here beats ' +
        'silently reporting zero rebuilds forever.'
    );
  }

  let installed = false;
  let originalGetForRender = null;
  let wrappedCachesSet = null;
  let originalCachesSet = null;
  let insideTrackedCall = false;
  let sawSetThisCall = false;
  let calls = 0;
  let hits = 0;
  let misses = 0;
  let labelsDropped = 0;
  // WALL-CLOCK COST, NOT JUST A COUNT (mythica-machina-press#400 follow-up,
  // 2026-09-01). A miss count says a compile happened; it says nothing about
  // whether it took 2ms or 40,000ms — and a genuinely synchronous
  // `device.createRenderPipeline` call (this probe's own header) is exactly
  // the kind of block a POLLED instrument (vt/settle.js) cannot see through:
  // nothing can check in while the main thread is solid. Timing the bracket
  // this probe ALREADY wraps costs nothing extra to install — the delegate
  // call is already inside a `try`; reading the clock immediately before and
  // (on a miss) immediately after survives the freeze by construction, since
  // both reads happen on the same thread, sequentially, regardless of how
  // long the call in between blocks.
  let totalMissMs = 0;
  let worstMissMs = 0;
  /** label -> {misses, ms, worstMs} */
  const byLabel = new Map();

  function recordLabeledMiss(label, tookMs) {
    let entry = byLabel.get(label);
    if (entry === undefined) {
      if (byLabel.size >= maxLabels) {
        labelsDropped++;
        return;
      }
      entry = { misses: 0, ms: 0, worstMs: 0 };
      byLabel.set(label, entry);
    }
    entry.misses++;
    entry.ms += tookMs;
    if (tookMs > entry.worstMs) entry.worstMs = tookMs;
  }

  /**
   * Re-verify the wrap on `pipelines.caches.set` is still the live one before
   * every tracked call — see this file's own header for why `.caches` can be
   * silently swapped out from under a one-time wrap.
   */
  function ensureCachesWrapped() {
    const caches = pipelines.caches;
    if (!(caches instanceof Map)) return false;
    if (caches.set === wrappedCachesSet) return true;
    originalCachesSet = caches.set;
    caches.set = wrappedCachesSet;
    return true;
  }

  return {
    install() {
      if (installed) return false;
      // Two references on purpose, same discipline as shader-rebuild-probe.js:
      // `originalGetForRender` is the exact property value found, so
      // `uninstall()` can put back the very same function object.
      originalGetForRender = pipelines.getForRender;
      const delegate = originalGetForRender.bind(pipelines);

      wrappedCachesSet = function (key, value) {
        if (insideTrackedCall) sawSetThisCall = true;
        return originalCachesSet.call(this, key, value);
      };

      pipelines.getForRender = (renderObject, promises) => {
        calls++;
        const cachesReady = ensureCachesWrapped();
        const wasInside = insideTrackedCall;
        insideTrackedCall = cachesReady;
        sawSetThisCall = false;
        // One clock read on EVERY call (a hit is the common case and must
        // stay cheap) — a second read only on the rare miss path, below.
        const startedAtMs = performance.now();
        try {
          return delegate(renderObject, promises);
        } finally {
          insideTrackedCall = wasInside;
          if (cachesReady && sawSetThisCall) {
            misses++;
            const tookMs = performance.now() - startedAtMs;
            totalMissMs += tookMs;
            if (tookMs > worstMissMs) worstMissMs = tookMs;
            let label = null;
            try {
              label = describe(renderObject);
            } catch {
              label = null;
            }
            if (label !== null && label !== undefined) {
              recordLabeledMiss(label, tookMs);
            } else {
              labelsDropped++;
            }
          } else {
            hits++;
          }
        }
      };
      installed = true;
      return true;
    },

    uninstall() {
      if (!installed) return false;
      pipelines.getForRender = originalGetForRender;
      if (pipelines.caches instanceof Map && pipelines.caches.set === wrappedCachesSet) {
        pipelines.caches.set = originalCachesSet;
      }
      originalGetForRender = null;
      wrappedCachesSet = null;
      originalCachesSet = null;
      insideTrackedCall = false;
      installed = false;
      return true;
    },

    isInstalled: () => installed,

    reset() {
      calls = 0;
      hits = 0;
      misses = 0;
      labelsDropped = 0;
      totalMissMs = 0;
      worstMissMs = 0;
      byLabel.clear();
    },

    stats() {
      const labels = [];
      for (const [label, e] of byLabel) {
        labels.push({ label, misses: e.misses, ms: round1(e.ms), worstMs: round1(e.worstMs) });
      }
      // Worst-first by TIME, not by count — a label that missed once for
      // 40,000ms is the finding; a label that missed ten times for 0.4ms each
      // is noise, and a count-sorted list would bury the first under the second.
      labels.sort((a, b) => b.ms - a.ms);
      return {
        installed,
        calls,
        hits,
        misses,
        labelsDropped,
        totalMissMs: round1(totalMissMs),
        worstMissMs: round1(worstMissMs),
        labels,
        note:
          'misses are real GPU PIPELINE compiles (device.createRenderPipeline), a DIFFERENT cache from ' +
          "shader-rebuild-probe.js's node-graph one — see this module's own header for why a miss here can " +
          'happen even when that probe reads clean. `ms`/`worstMs` are WALL-CLOCK time inside the (real, ' +
          'main-thread-blocking) compile call itself, timed with a clock read immediately before and after — ' +
          'this survives a fully synchronous freeze by construction, unlike anything that relies on polling ' +
          'during the block. Per label: how many times this render object forced a brand-new pipeline this ' +
          'window, and how much wall-clock time that cost (no material/nodes split here — a pipeline miss ' +
          'already names the render object directly, so there is no second axis to classify).',
      };
    },
  };
}
