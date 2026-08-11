# The Shader-Rebuild Investigation — 2026-08-11

**Status: cause NARROWED to one mechanism, exact culprit NOT yet named. Instrument built to name it.**

Opened at the author's direction: *"I think we have a recursive problem. Start a new document. We need
to work out what is going on here. We need to track down the performance problem causes and get them
fixed."*

This document exists because four hypotheses died in a row, each costing a round trip through the
author's own hands. It records what is now PROVEN, what is DISPROVEN (so nobody re-tests it), and the
one measurement left to take.

---

## 1. The symptom, from three independent Chrome traces

| Trace | Window | `NodeBuilder.build()` share |
|---|---|---|
| #1 (2026-08-11, camera stress) | one 72.1 ms frame | 50.1 ms — **67.3 %** |
| #2 (whole capture, ~19 s) | 4,543 ms of main-thread work | 1,909 ms — **39.7 %** |
| #3 (one 77.8 ms frame) | `runGeometryWorldPass` 64.2 ms | 59.1 ms across two render calls — **76 %** |

Trace #3 is the clearest. Inside a single frame:

```
runGeometryWorldPass                     64.2 ms  (81.1 % of frame)
  runSceneDepthPass                      34.6 ms
    render -> ... -> _renderObjectDirect
      getForRender  (three.webgpu.js:58506)  33.5 ms   <- 97 % of the depth pass
        build       (three.webgpu.js:57634)  33.5 ms
  render (the world draw)                27.8 ms
    ... -> _renderObjectDirect
      getForRender                          25.6 ms   <- 92 % of the world draw
        build                               25.6 ms
```

**Both render calls in the geometry pass spend nearly all their CPU time building shader graphs, every
frame.** The remaining passes (lighting, bloom, DoF, present) together are a rounding error beside it.

### The "recursion" the author spotted is real, and it is the node graph

Traces #2/#5 show `build` recursing `32775 -> 33077 -> 35571 -> 32775 -> ...` for **40+ levels**, each
level ~17 ms total but with near-zero *self* time. That is not a runaway loop — it is
`Node.build()` walking MSA's TSL graph depth-first, and the graph is genuinely that deep. The depth is
not itself a bug; **paying for the full walk every frame is.** A deep graph is fine when it is built
once and cached.

---

## 2. What the call path PROVES (not infers)

`Nodes.getForRender` (three.webgpu.js:58506) only reaches `build` on a **double miss**:

```js
getForRender(renderObject) {
  const renderObjectData = this.get(renderObject);
  let nodeBuilderState = renderObjectData.nodeBuilderState;   // (a) per-RenderObject cache
  if (nodeBuilderState === undefined) {
    const cacheKey = this.getForRenderCacheKey(renderObject); // = renderObject.initialCacheKey
    nodeBuilderState = this.nodeBuilderCache.get(cacheKey);   // (b) shared cache
    if (nodeBuilderState === undefined) {
      /* FULL BUILD */
```

So every frame, for the geometry meshes, BOTH are missing:

- **(a) misses** => the `RenderObject` is FRESH this frame (that field is cached on the instance, so a
  surviving RenderObject could never re-enter this path).
- **(b) misses** => its `initialCacheKey` matches nothing already built.

Two ways to get a fresh RenderObject (`RenderObjects.get`, three.webgpu.js:45969-45993):
1. the chain-map key `[object, material, renderContext, lightsNode]` missed, or
2. the dispose-and-recreate branch at :45986 fired
   (`renderObject.version !== material.version || needsUpdate`, **and**
   `initialCacheKey !== getCacheKey()`).

### The keystone fact

```js
// three.webgpu.js:32524
customCacheKey() {
  return this.id;      // a unique per-INSTANCE counter
}
```

**A TSL node's default cache key is its instance id.** Two structurally identical graphs built from
fresh node objects therefore hash *differently*. Any code path that reconstructs a node graph — even
to something byte-identical — guarantees a `nodeBuilderCache` miss and a full rebuild.

### Why `renderer.info.programs` stayed flat at 86, and why that is NOT a refutation

This puzzled the investigation for a full round. Three caches *pipelines* by the **generated shader
source string**, not by node identity. A regenerated-but-identical graph produces identical source,
hits the pipeline cache, and allocates **no new program**. So:

> **Flat `programs` beside heavy `build` is the signature of this bug, not evidence against it.**

The expensive half (walking the graph to *produce* the source) is paid in full; the cheap half
(compiling it) is correctly skipped. Any future investigation that reads a flat `programs` count as
"no shader churn" will be wrong for the same reason.

---

## 3. Hypotheses tested and KILLED — do not re-test these

| # | Hypothesis | How it died |
|---|---|---|
| 1 | `applyEarlyZTileState` mutating `maskNode`/`transparent`/`depthTest`/`depthFunc` on state flips | **Killed live.** A transition counter (`MapShine.getEarlyZComposition().earlyZTransitions`) read `{total: 5, reversals: 0}` after a real pan with real rAF cadence — 5 one-time settles on load, zero churn. |
| 2 | `buildWholeImageMaterial` rebuilding per pass | **Killed by code.** `ensureWholeImageMeshes` opens with `if (state.wholeImage) return state.wholeImage;` and its own comment calls the material choice *"a ONE-TIME, construction-time decision, never revisited."* Structurally cannot run twice per item. |
| 3 | MRT / render-target juggling bumping the render context id (which `getMaterialCacheKey` includes) | **Killed by code.** `RenderContexts.get` (:47569) caches by `attachment + mrt.id + callDepth`; MSA's `sceneAttrZeroMrt` is built ONCE at `vt-pan-viewer.js:1667` and MSA's `render()` calls are sequential, not nested, so `callDepth` stays 0. |
| 4 | Lights changing the dynamic cache key via `LightsNode.getCacheKey(true)` | **Killed by grep.** MSA never constructs a single `THREE.Light` — every `AmbientLight` hit in the codebase is Foundry's own document class. `LightsNode._lights` is empty, so `customCacheKey()` (:51837) hashes an empty array: constant. |

Also checked and cleared: `point-light-pool.js#update()` creates exactly **one** `NodeMaterial` in the
whole file (line 487, the aperture-shadow debug material) and caches its wall-clip/aperture work
aggressively. It is expensive (10.1 % of trace #2) but it is **not** rebuilding materials per frame.

---

## 4. What is left, and the instrument built to decide it

Given the keystone fact, exactly two causes remain, and they need **opposite** fixes:

- **`materialChanged`** — the material OBJECT is new each frame (uuid differs).
  *Fix:* pool/reuse it, the shape `vt/depth-proxy-material-pool.js` already uses.
- **`nodesChanged`** — SAME material uuid, DIFFERENT cache key. The material survived but its node
  graph was rebuilt or mutated underneath it.
  *Fix:* stop rebuilding the nodes. **Pooling the material would change nothing.**

Guessing between these is what burned rounds 1-4. So this round builds the measurement instead.

### `src/diag/shader-rebuild-probe.js` (BUILT, 21 Node tests, `npm run verify` green at 8,552)

Wraps three's `Nodes.getForRender`, reads the shared cache *before* delegating (afterwards a hit and a
just-populated miss are indistinguishable), and tallies misses by a stable label, classifying each as
`materialChanged` vs `nodesChanged`. Deliberately:

- **off unless armed** — it wraps a hot-path call, so a real player pays nothing;
- **refuses to arm** if `renderer._nodes` is absent, rather than reporting zero rebuilds forever
  ([[feedback_instruments_must_not_lie]]);
- **never breaks the render loop** — a throwing label function is counted in `labelsDropped`, not
  propagated;
- **never counts three's own early return** (a RenderObject already carrying its `nodeBuilderState`
  never consults the shared cache) as a cache miss;
- **restores the exact original function** on uninstall. Its own test caught the first version writing
  back a `.bind()` copy instead — a hot path that stays wrapped after disarm is precisely the
  "restored, sort of" cleanup this project has been bitten by before.

**The label deliberately excludes the material uuid.** Folding it in would give every rebuilt material
its own bucket and make `materialChanged` structurally unobservable — the instrument would report
"all cold caches, no churn" no matter how bad the churn got.

### How to run it

```js
MapShine.setShaderRebuildProbe(true)   // arm + reset
// ...pan the camera for a few seconds...
MapShine.getShaderRebuilds()           // labels[], worst first
MapShine.setShaderRebuildProbe(false)  // disarm
```

Read `labels[0]`:
- `materialChanged > 0` => something recreates that material. Pool it.
- `nodesChanged > 0` => something rebuilds that material's nodes in place. Find and stop it.
- `distinctCacheKeys` climbing with frame count confirms churn rather than a one-time settle.

---

## 5. Why this outranks everything else currently queued

Trace #3's frame: 77.8 ms total, ~59 ms of it shader building. Removing it would take that frame to
roughly **19 ms — about 52 fps, from 13.** No other finding in this project's performance work comes
near that:

- residency streaming (P-008 addendum) is wall-clock latency that demonstrably **overlaps** rendering;
- Stage 1's early-Z prepass is a real ~26 ms GPU line item whose payback is still unmeasured;
- Stage 2's point-light batching had almost nothing to batch on the profiled scene.

This is exclusive main-thread time inside the render call itself, every frame, and it is a *cache
miss* — meaning the work is redundant by construction, not inherent.

---

## 6. Open items

- **[NEXT] Run the probe and name the culprit.** One pan, one console read.
- **Then fix it**, by whichever of the two shapes §4 reports.
- **Re-measure with a trace**, not with `programs` (see §2's warning).
- Unresolved from earlier rounds and NOT re-opened here: the 20 worst hitches (250-667 ms) with
  provably idle decode/cache, still unexplained
  (`Residency-Streaming-Audit-2026-08-11.md` §5).
- `mask-authority.js` shows real per-frame self time in trace #2 (`requiredMissingAuthoredIds`
  38.3 ms, `sampleWorld` 28.8 ms) and `candle-flame-geometry.js#buildOneLightSource` 36.1 ms. Small
  beside the shader rebuild, but they are per-frame costs in code that reads like it should be
  cached. Worth a look **after** the main finding is fixed, not before.

---

## 7. A note on method, recorded deliberately

Rounds 1-4 each ended with a plausible mechanism, read from real source, that turned out not to be
what was happening. The pattern in all four: *a mechanism that COULD produce the symptom was treated
as the one that DID.* The corrective is not "read more carefully" — each read was correct about what
the code does. It is to **build the measurement that distinguishes candidates before proposing a
fix**, which is what §4 does. `[[feedback_plausible_diagnosis_rots]]` is the standing name for this
failure; this document is its most expensive instance so far.
