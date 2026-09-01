/**
 * shader-rebuild-probe.js — WHICH material is re-running three's TSL node-graph
 * build, and WHY: a new material object, or the same material with new nodes?
 *
 * ============================================================================
 * THE GAP THIS FILLS
 * ============================================================================
 *
 * Three Chrome traces in a row (2026-08-11) showed the same thing: 40-67% of a
 * frame inside three's `NodeBuilder.build()`, reached via
 * `_renderObjectDirect -> getForRender -> build`. That call path only happens
 * on a DOUBLE miss — the RenderObject has no cached `_nodeBuilderState` AND
 * `nodeBuilderCache.get(cacheKey)` came back undefined. It is a genuine
 * from-scratch shader-graph rebuild, not a cache lookup.
 *
 * Four hypotheses were tested and all four died:
 *   1. `applyEarlyZTileState` mutating live material properties — killed live,
 *      by a transition counter that read 0 across a real pan.
 *   2. `buildWholeImageMaterial` rebuilding — killed by reading
 *      `ensureWholeImageMeshes`, which guards it idempotent forever.
 *   3. MRT/render-target churn bumping the render context's id — killed by
 *      reading `RenderContexts.get` (keyed by attachment+mrt id+callDepth, and
 *      MSA's `sceneAttrZeroMrt` is built ONCE) .
 *   4. Lights changing the dynamic cache key — killed by grep: MSA never
 *      constructs a single `THREE.Light`, so `LightsNode._lights` is empty and
 *      its `customCacheKey()` is constant.
 *
 * Each of those cost a round trip through the author's own hands to disprove.
 * This probe exists so the NEXT question is answered by measurement in one
 * pass instead of a fifth guess.
 *
 * ============================================================================
 * THE ONE DISTINCTION THAT MATTERS, AND WHY
 * ============================================================================
 *
 * `Node.customCacheKey()` returns `this.id` — a unique per-INSTANCE counter
 * (three.webgpu.js:32525). So two structurally identical TSL graphs built from
 * fresh node objects hash DIFFERENTLY, and a material whose nodes were rebuilt
 * misses `nodeBuilderCache` even though nothing about it actually changed.
 *
 * That makes exactly two root causes possible, needing opposite fixes:
 *
 *   materialChanged  — the MATERIAL OBJECT itself is new (uuid differs from
 *                      last time this label was seen). Fix: pool/reuse the
 *                      material, the same shape as `depth-proxy-material-pool`.
 *   nodesChanged     — SAME material uuid, DIFFERENT cache key. The material
 *                      object survived but its node graph was rebuilt or
 *                      mutated underneath it. Fix: stop rebuilding the nodes;
 *                      pooling the material would change NOTHING.
 *
 * Guessing between those two is what burned four rounds. This reports which.
 *
 * A NOTE ON `renderer.info.programs`: it will NOT move while this happens, and
 * that is not evidence against it. Three's PIPELINE cache is keyed on the
 * generated shader SOURCE, so a regenerated-but-identical shader hits it and
 * allocates no new program. Flat `programs` beside heavy `build` is the
 * SIGNATURE of this bug, not its absence.
 *
 * @module diag/shader-rebuild-probe
 */

/** Cap on distinct labels retained. A runaway label function must not leak. */
export const DEFAULT_MAX_LABELS = 64;

/** @param {number} v @returns {number} one decimal place — same rounding perf-report.js uses for ms figures. */
function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

/**
 * Default label for a render object: what it is, stably, across frames.
 *
 * Deliberately NOT the material uuid — the uuid is the VALUE being compared
 * per label, so folding it into the label itself would give every rebuilt
 * material its own bucket and make `materialChanged` structurally
 * unobservable (every label would look brand new, always).
 */
export function defaultDescribeRenderObject(renderObject) {
  const material = renderObject?.material ?? null;
  const object = renderObject?.object ?? null;
  const matName = material?.name || material?.type || 'material?';
  const objName = object?.name || object?.type || 'object?';
  return `${objName}/${matName}`;
}

/**
 * Wrap a three `Nodes` instance and count node-graph rebuilds by label.
 *
 * @param {object} args
 * @param {object} args.nodes - three's `renderer._nodes` (duck-typed).
 * @param {(ro: object) => string} [args.describe]
 * @param {number} [args.maxLabels]
 */
export function createShaderRebuildProbe({
  nodes,
  describe = defaultDescribeRenderObject,
  maxLabels = DEFAULT_MAX_LABELS,
} = {}) {
  if (!nodes || typeof nodes.getForRender !== 'function') {
    throw new Error(
      'createShaderRebuildProbe: needs a three Nodes instance with getForRender(). ' +
        'Pass renderer._nodes — this probe is useless against anything else, and failing here beats ' +
        'silently reporting zero rebuilds forever.'
    );
  }

  let installed = false;
  let original = null;
  let calls = 0;
  let hits = 0;
  let misses = 0;
  let labelsDropped = 0;
  // WALL-CLOCK COST alongside the count (mythica-machina-press#400 follow-up,
  // 2026-09-01) — same reasoning as pipeline-rebuild-probe.js's own addition:
  // a miss COUNT says a rebuild happened, not whether it cost 2ms or 40,000ms,
  // and `NodeBuilder.build()` is a real, synchronous, main-thread cost (this
  // file's own header: "40-67% of a frame"). Timed with a clock read
  // immediately before/after the delegate call already made below, so it
  // survives even a fully blocking freeze — nothing needs to run DURING the
  // block, only right before it starts and right after it ends.
  let totalMissMs = 0;
  let worstMissMs = 0;
  /** label -> {misses, hits, materialChanged, nodesChanged, lastUuid, lastKey, keys:Set, ms, worstMs} */
  const byLabel = new Map();

  function recordMiss(label, renderObject, cacheKey) {
    let entry = byLabel.get(label);
    if (entry === undefined) {
      if (byLabel.size >= maxLabels) {
        labelsDropped++;
        return;
      }
      entry = {
        misses: 0,
        materialChanged: 0,
        nodesChanged: 0,
        lastUuid: null,
        distinctKeys: 0,
        keysTruncated: false,
        keys: new Set(),
        ms: 0,
        worstMs: 0,
      };
      byLabel.set(label, entry);
    }
    entry.misses++;
    const uuid = renderObject?.material?.uuid ?? null;
    // THE WHOLE POINT — see this file's header. Only classify once there IS a
    // previous observation to compare against; the first miss for a label is
    // just a cold cache, which is correct and expected, not churn.
    if (entry.lastUuid !== null) {
      if (uuid !== entry.lastUuid) entry.materialChanged++;
      else entry.nodesChanged++;
    }
    entry.lastUuid = uuid;
    // The key set is diagnostic, not a leak: a healthy label holds ONE key
    // forever, so a set that grows without bound is itself the finding. Cap it
    // and SAY it was capped — silently clearing would make `distinctCacheKeys`
    // appear to fall, which reads as the churn improving when it did not.
    if (entry.keys.size < 512) {
      if (!entry.keys.has(cacheKey)) {
        entry.keys.add(cacheKey);
        entry.distinctKeys = entry.keys.size;
      }
    } else {
      entry.keysTruncated = true;
    }
    return entry;
  }

  return {
    install() {
      if (installed) return false;
      // TWO references on purpose, and this distinction is load-bearing:
      // `original` is the EXACT property value we found, so `uninstall()` can
      // put back the very same function object; `delegate` is the bound copy
      // used to CALL it. Keeping only the bound copy (the first version of
      // this file) meant uninstall wrote a different-but-equivalent function
      // back onto the renderer — invisible in behaviour, and exactly the kind
      // of "restored, sort of" cleanup that leaves a hot path permanently
      // wrapped after a probe is disarmed. Its own test caught it.
      original = nodes.getForRender;
      const delegate = original.bind(nodes);
      const cacheOf = () => (nodes.nodeBuilderCache instanceof Map ? nodes.nodeBuilderCache : null);
      nodes.getForRender = (renderObject, useAsync = false) => {
        calls++;
        // Read the cache BEFORE delegating — afterwards the entry always
        // exists, whether it was a hit or the build just populated it, so a
        // post-hoc check could never tell the two apart.
        let missed = false;
        let cacheKey = null;
        try {
          const cache = cacheOf();
          cacheKey = typeof nodes.getForRenderCacheKey === 'function' ? nodes.getForRenderCacheKey(renderObject) : null;
          // A RenderObject that already carries its own state never reaches
          // the shared cache at all — three returns early. Counting that as a
          // miss would blame the cache for work that never happened.
          const perObject = typeof nodes.get === 'function' ? nodes.get(renderObject) : null;
          const alreadyResolved = perObject?.nodeBuilderState !== undefined;
          missed = !alreadyResolved && cache !== null && cacheKey !== null && cache.get(cacheKey) === undefined;
        } catch {
          // A probe must never break the render loop. An unreadable cache is
          // reported as neither hit nor miss rather than guessed at.
          missed = false;
        }
        if (!missed) {
          hits++;
          return delegate(renderObject, useAsync);
        }
        misses++;
        let entry = null;
        try {
          entry = recordMiss(describe(renderObject), renderObject, cacheKey);
        } catch {
          labelsDropped++;
        }
        const startedAtMs = performance.now();
        try {
          return delegate(renderObject, useAsync);
        } finally {
          const tookMs = performance.now() - startedAtMs;
          totalMissMs += tookMs;
          if (tookMs > worstMissMs) worstMissMs = tookMs;
          if (entry) {
            entry.ms += tookMs;
            if (tookMs > entry.worstMs) entry.worstMs = tookMs;
          }
        }
      };
      installed = true;
      return true;
    },

    uninstall() {
      if (!installed) return false;
      nodes.getForRender = original;
      original = null;
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
        labels.push({
          label,
          misses: e.misses,
          // `materialChanged` > 0 => pool the material. `nodesChanged` > 0 =>
          // pooling would change nothing; stop rebuilding the node graph.
          materialChanged: e.materialChanged,
          nodesChanged: e.nodesChanged,
          distinctCacheKeys: e.distinctKeys,
          distinctCacheKeysTruncated: e.keysTruncated,
          ms: round1(e.ms),
          worstMs: round1(e.worstMs),
        });
      }
      // Worst-first by TIME — see pipeline-rebuild-probe.js's own note on why
      // count-sorting would bury a single 40-second rebuild under ten cheap ones.
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
          'misses are FULL TSL node-graph rebuilds. Per label: materialChanged>0 means a NEW material ' +
          'object each time (fix = pool the material); nodesChanged>0 means the SAME material with a new ' +
          'node graph (fix = stop rebuilding its nodes — pooling would change nothing). ' +
          '`ms`/`worstMs` are WALL-CLOCK time inside the rebuild call itself (clock read immediately before ' +
          'and after), so it is real even across a fully synchronous freeze. ' +
          'renderer.info.programs stays FLAT during this either way, because three caches pipelines by ' +
          'generated source, not by node identity — flat programs is this bug’s signature, not its absence.',
      };
    },
  };
}
