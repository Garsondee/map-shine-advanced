# The Shader-Rebuild Investigation — 2026-08-11

**Status: CULPRIT NAMED, FIXED, and CONFIRMED by a real re-trace (~120fps steady, §6).**
**Plus: a general fix for how this kind of bug hides (§7), and a second, related finding from the
same confirming trace, fixed but not yet re-traced (§8).**

> **ANSWER (added after the probe ran).** The author armed the probe, panned, and read:
> `{calls: 1397, hits: 632, misses: 765, labels: [{label: "Mesh/NodeMaterial", misses: 765,`
> `materialChanged: 763, nodesChanged: 1, distinctCacheKeys: 512+ (truncated)}]}`
>
> **763 of 765 rebuilds were `materialChanged`** — a brand-new material object nearly every time,
> 512+ distinct cache keys, a **55 % miss rate**. Not node mutation: something was *constructing*
> fresh materials on the hot path.
>
> **It was the vegetation branch of `rebuildSceneDepthProxies` — and it was excluded from the
> material pool on purpose, by me, one commit earlier.** See §4a. Fixed in the same session.

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

## 4a. THE CULPRIT, and the honest account of how it got there

`rebuildSceneDepthProxies`'s **vegetation branch** (`vt/vt-pan-viewer.js`) built, on every pass:

```js
positionNode = Fn(() => { ...buildVegetationSwayDisplacementNode... })();  // fresh TSL nodes
const material = buildSceneDepthWriterMaterial(writerArgs);                // fresh material
depthProxyEntries.push({ mesh, material, pooled: false });
addDepthPrepassTwin(writerArgs, overlay.geometry, z);                      // pooled defaults FALSE
```

That is **two fresh materials per canopy per pass** — and `rebuildSceneDepthProxies` runs **every
frame** while the camera moves (`depth.proxyRebuild`, `occurrenceRate: 1.0` across the 463-frame
P-008 capture). Fresh nodes ⇒ fresh cache key (§2's keystone) ⇒ guaranteed full `NodeBuilder.build()`
on the very next render. Which is exactly what all three traces show, in exactly the two render calls
that render these proxies.

### How it got there — a measurement that measured the wrong thing

This exclusion was deliberate. The comment justifying it read:

> *"Measured cost of leaving it unpooled: 0.9% of the total rebuild cost the pool exists to cut —
> real upside left on the table on purpose, not missed."*

That 0.9 % was real — and irrelevant. It measured the cost of **constructing** the material, inside
the residency zone, which genuinely is cheap. It did not measure the **consequence**: one pass later,
in a *different zone*, three rebuilds the whole node graph because the material it was handed is new.

That is precisely the *"a small zone timing hides a large downstream cost"* trap named in
`Residency-Streaming-Audit-2026-08-11.md` §6 — written in the same session, by the same author of the
change, one commit earlier. **Naming a trap is not the same as being immune to it.**

The second half of the mistake was the safety argument: the pool's signature folded in only the
*presence* of a positionNode, which was safe **only** because no positionNode-bearing caller ever used
the pool. That made the exclusion self-justifying — it was unsafe to pool *because* the signature
assumed nothing would.

### The fix (shipped this session)

1. **`computeDepthProxyMaterialSignature` now requires an explicit `variantKey` whenever a
   `positionNode` is present, and THROWS otherwise.** Presence-only keying would map every canopy to
   one shared material and sway them all from whichever built first — a wrong-picture bug visible
   only on screen and invisible to any unit test. The throw makes it unrepresentable rather than
   unlikely.
2. **The position node is cached per overlay in a `WeakMap` keyed on `overlay.motion`** — the bag the
   node closes over by reference. A rebuilt overlay brings a new bag, which cannot find an old entry,
   so a stale node can never animate a live canopy; the old entry becomes collectable with the bag.
   A monotonic `id` on each entry supplies the `variantKey`.
3. **Scene-rect uniforms are updated in place**, not rebuilt — rebuilding them would defeat the fix.
4. **Both the proxy and its prepass twin are pooled and share the one cached node**, preserving
   `[[feedback_depth_proxy_needs_the_same_animation]]` (the twin must sway identically or the canopy
   occludes where it is not drawn).

7 new Node tests pin the `variantKey` contract, including the sabotage case. `npm run verify` green
at **8,559**.

### What is NOT yet proven

The fix is verified by construction and by unit test, **not yet by a trace**. `nodesChanged: 1` in
the probe reading is also unexplained — one single miss classified as same-material-new-nodes. One
occurrence is consistent with an ordinary cold-start artifact, but it is recorded rather than waved
away. The confirming measurement is the author's: re-arm the probe, pan, and expect `misses` to fall
to near zero.

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

## 6. THE FIX CONFIRMED — a real trace, ~9x fewer hangs, ~120fps steady

The author re-traced after the vegetation-pooling fix (§4a) landed. Frame times in the new capture
sit at a **steady 8.2-8.5ms**, essentially every frame — roughly **120fps**, up from the 13fps a
72.1ms frame implied before. `NodeBuilder.build()` no longer dominates the profile at all.

## 7. THE SILENT-FAILURE PROBLEM — the author's own critical call-out

Immediately after confirming the win, the author raised a sharper point, generalized past this one
bug: *"why the hell haven't we been seeing useful, loud, informative errors generated as a result
of the cache not working?"* A cache that silently reverts to its slow path produces CORRECT pixels
and WRONG performance — no test catches that, no crash announces it. This project's own
`depthProxyMaterialPool.stats()` and its `depth-proxy-pool-health` finding already existed and
still didn't catch the vegetation bug, for two compounding reasons: the accessor bug (§ P-008's own
Finding 4) left the finding's input `null` in every real report, AND — the sharper point — a
health check scoped to "inside this one pool" is structurally blind to code that was never routed
through the pool at all, which is exactly what the vegetation exclusion was.

**Fixed, generalized rather than patched once:**

- `perf-session.js` now arms `shader-rebuild-probe.js` **automatically** for every measured
  window (same lifecycle as the GPU zone timer — armed after settling, disarmed in the `finally`),
  not a manual console step someone has to remember exists.
- `perf-report.js` gained a `shader-rebuild-churn` finding, **`'high'` severity unconditionally**
  (the probe's own classification already excludes each label's first, expected miss, so anything
  it reports is by construction a repeat rebuild this window — no cold-start ambiguity to hedge
  against, unlike `depth-proxy-pool-health`'s `'medium'`).
- The instrument watches three's OWN node-graph cache directly (`Nodes.getForRender`), not any one
  pool's proxy for it — so it catches churn regardless of which subsystem causes it, closing the
  exact blind spot that let the vegetation bug hide.
- Full account, generalized past this one bug into a standing rule for every future pool this
  project builds: `[[feedback_pool_health_needs_a_loud_gate]]` (memory).

`npm run verify` green throughout, 8,580 tests at this point.

## 8. SECOND FINDING FROM THE SAME TRACE — point-light wall-clip, uncached

The confirming trace's own new #1 cost (`point-light-pool.js#update`, 17.2% of the sampled window;
its `readActiveLightSources` → `computeLightWallClippedShape` → Foundry's `ClockwiseSweepPolygon`
chain alone, 9.9%) was a second, genuinely separate bug, found by reading the code the trace
pointed at rather than guessed from the percentage alone.

**Mechanism, verified against source, not assumed:** `readActiveLightSources`
(`foundry/scene-lights.js`) recomputes a light's TRUE wall-clipped shape whenever Foundry's own
darkness gate disabled it but MSA's own darkness model (the "Aesthetic mode" default) says it
should stay on — a real, needed, already-correct fix for a real bug (see that file's own header).
But unlike its candle/lightning siblings in `point-light-pool.js` (`candleWallClipCache`,
`lightningWallClipCache`), that call had **no cache around it at all**. On a scene where Foundry's
gate and MSA's model disagree for most/all real lights — routine in Aesthetic mode, the default —
every one of them re-ran Foundry's own vertex-identification/edge-identification/sweep pipeline
from scratch, every single frame.

**Fixed, same session:** a third sibling cache, `regularLightWallClipCache`, threaded into
`readActiveLightSources` via an optional `{wallClipCache, floorId}` param (the function stays pure
and correct without one — the old always-recompute behaviour — so nothing that already calls it
without the new option breaks). Deliberately **stricter** than the candle/lightning precedent it
extends: invalidated on floor and radius (matching them) **plus position, angle, and rotation**,
which they do not check — a candle is a static anchor, but a real Foundry light can be attached to
a moving token, and skipping a position check would have silently rendered a moving light's
wall-clip from wherever it used to be. Pruned against a NEW `seenSourceIds` set `
readActiveLightSources` now also returns — deliberately wider than its own `lights` output, so a
light merely cycling outside its darkness window this frame (still real, still tracked by Foundry)
is never confused with a light that was actually deleted; only the second should evict a cache
entry. NaN-safe (`Object.is`, not `===`) since `angle` can genuinely be non-finite for some light
configs (`isDarknessOnlyDisable`'s own `Number.isFinite` guard exists for the same reason).

The caching *decision* was extracted as a pure, exported `wallClipCacheEntryMatches(cached,
current)` — `readActiveLightSources` itself stays browser-only/live-verified by this file's own
established convention (its test file's own header says so), but the decision most likely to hide
a subtle off-by-one bug is now Node-tested directly: 13 new assertions, including the NaN case and
the moving-light case.

`npm run verify` green, **8,593 tests**. **Not yet confirmed by a trace** — verified by construction
and unit test only, same honest caveat as §4a's fix carried before its own confirmation landed.

## 9. Open items

- ~~Run the probe and name the culprit~~ — **DONE**, see §4a.
- ~~Fix it~~ — **DONE**, see §4a's fix list.
- ~~Confirm the win with a trace~~ — **DONE**, see §6: ~8.3ms steady, ~120fps.
- ~~Make pool/cache health loud automatically~~ — **DONE**, see §7.
- ~~Chase the trace's new #1 cost (point-light wall-clip)~~ — **DONE, code-level**, see §8. Fixed
  by construction and unit test; **not yet confirmed by a trace** — the same honest gap §4a's fix
  carried before its own confirmation landed.
- **[NEXT] Confirm §8's fix with a trace.** Same discipline as before: a trace, never
  `renderer.info.programs`-style proxies — this specific fix has no such proxy metric at all yet,
  which is itself worth noting; `computeLightWallClippedShape`'s own call count would be the
  natural one if this class of fix recurs.
- **[NEXT] Check the canopies still sway**, and sway correctly per-item (§4a's fix). The pool's
  `variantKey` guard makes cross-canopy aliasing unrepresentable, but "the animation still runs at
  all" is a screen verdict, not a unit test — this touched the node that drives it.
- **[NEXT] Check moving lights** (§8's fix) — a light attached to a moving token should track
  smoothly; the position-invalidation logic is unit-tested but its real-world trigger (a token
  actually moving with a light attached) has not been observed live.
- The single unexplained `nodesChanged: 1` from the §4a probe reading — still unexplained, not
  re-investigated this round.
- Unresolved from earlier rounds and NOT re-opened here: the 20 worst hitches (250-667 ms) with
  provably idle decode/cache, still unexplained
  (`Residency-Streaming-Audit-2026-08-11.md` §5).
- `mask-authority.js` shows real per-frame self time in trace #2 (`requiredMissingAuthoredIds`
  38.3 ms, `sampleWorld` 28.8 ms) and `candle-flame-geometry.js#buildOneLightSource` 36.1 ms. Small
  beside the shader rebuild, but they are per-frame costs in code that reads like it should be
  cached. Worth a look **after** the fixes above are confirmed, not before.

---

## 10. A note on method, recorded deliberately

Rounds 1-4 each ended with a plausible mechanism, read from real source, that turned out not to be
what was happening. The pattern in all four: *a mechanism that COULD produce the symptom was treated
as the one that DID.* The corrective is not "read more carefully" — each read was correct about what
the code does. It is to **build the measurement that distinguishes candidates before proposing a
fix**, which is what §4 does. `[[feedback_plausible_diagnosis_rots]]` is the standing name for this
failure; this document is its most expensive instance so far.
