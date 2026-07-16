# HEALTH — the Breaker Box was right; its model was a hand-drawn copy

**Status:** RESEARCH + DESIGN SEED, 2026-07-17. Author: *"Health evaluators seemed like a good idea but I bet it could have been much better planned and implemented."*
**Verdict:** the idea is **excellent and survives whole**. The implementation was a **parallel, hand-maintained model of the system, coupled to private fields** — and it *had to be*, because nothing in V2 was declared. Under Keyhole it stops being a model and becomes a **derivation**.
**Companions:** `Effects-API.md` (declarations), `graph/passes.js` (the real graph, as data), `Params.md` §3.6 (the readout finding), `feedback_instruments_must_not_lie`.

---

## 0. The idea was right — say so plainly

A **Breaker Box**: a panel showing which circuits of the engine are live, named like circuits — `src:waterMasks`, `src:waterData`, `src:cloudField`, `src:roofCapture`. For an engine whose failures are *silent by nature* (a mask that never loaded looks identical to a mask that is legitimately black), that is exactly the right instrument. Tiered rules (`structural` / `error`), a dependency graph, a header indicator, per-effect diagnostics. **Keep the concept entirely. It is the author's answer to `feedback_instruments_must_not_lie`, invented independently and years early.**

The scale it reached: **4,505 lines** (`HealthEvaluatorService` 2,261 · `breaker-box-dialog` 1,545 · registries/graph/utils/indicator ~700).

## 1. What it actually was

```js
// HealthEvaluatorService.js:1256 — the service registering the effect ON ITS OWN BEHALF
this.registry.register('WaterEffectV2', {
  getInstance: (ctx) => ctx.floorCompositor?._waterEffect ?? null,   // ← reach into privates
  rules: [
    { id: 'initialized',     check: (i) => ({ pass: !!i?._initialized }) },      // ← private field
    { id: 'composeMaterial', check: (i) => ({ pass: !!i?._composeMaterial }) },  // ← private field
  ],
});
// :1213 — the dependency graph, HAND-WRITTEN
this.dependencyGraph.addEdge('WaterEffectV2', 'WindowLightEffectV2', 'contextual');
```

| Symptom | Count | What it means |
|---|---|---|
| Effect names hardcoded in the health service | **17** | it maintains its own census of the module |
| `HealthContractRegistry` entries registered **by effects** | **0** | not a registry — a lookup table the service fills in about itself |
| Dependency edges | hand-written `addEdge` calls | **a second, parallel copy of a graph the real code never wrote down** |
| Health checks reading `_privateFields` | throughout | the observer is coupled to the observed's internals |
| UI→rule binding | **keyword strings** (`keywords: ['composeMaterial', 'floorData']`) | rename a private field and the Breaker Box silently shows the wrong circuit |
| `HEALTH-WIRING BADGE` comment-MUSTs on effects | **10** | comment-MUSTs #7 and #8 of the eight; the genre is 0-for-8 |
| Health writing product `params` | **7 sites** | it had status to show and no display channel (`Params.md` §3.6) |

### The badge refutes itself
> *"If you change this effect's lifecycle, core resources, floor behavior, or dependency bindings, you **MUST** update HealthEvaluator contracts/wiring for `WaterEffectV2` **to prevent silent failures**."*

**A system whose whole purpose is catching silent failures, which fails silently when you forget to hand-update it.** That is not an implementation bug; it is the shape. And the badge exists *because* the shape leaks — it is a Post-it note apologising for an architecture.

## 2. The diagnosis — and the exoneration

> **V2's health system was a hand-drawn copy of the module's structure, kept beside the real thing, and it drifted.**

Every disease of the module, reflected in its watchdog: a god-object (2,261 lines) reaching into another god-object's privates; a parallel model needing manual sync; a comment-MUST holding it together; and — recorded in the params harvest — **diagnostics mutating product state, which was never malice but a missing readout concept.**

**But here is the exoneration, and it matters: it could not have been built any other way.** The health system needed to know *"what does Water depend on?"* — and **nothing in V2 declared that.** Not the effects, not the composer, not the config. The dependency graph existed **only** inside the health service, because the health service was the only thing that ever needed to write it down. Asked to observe an undeclared system, it did the only possible thing: **it wrote its own description of reality and tried to keep it true by hand.** That is not poor planning. That is the *correct* response to an undeclarative architecture — and it is doomed regardless.

## 3. THE KEYHOLE DESIGN — health is DERIVED, never modelled

**The payoff of everything declared so far, and this is the whole point:**

| V2 hand-wrote it | Keyhole already declares it |
|---|---|
| 17 hardcoded effect names | `graph/passes.js` — **the pass list IS the census** |
| `addEdge('WaterEffectV2', 'WindowLightEffectV2')` | `passes.js` `reads: ['buf:scene.illum']` — **the graph IS the declaration** |
| `getInstance: ctx => fc._waterEffect` | passes are values in a registry; there are no privates to reach for |
| "is it initialized?" via `_initialized` | a declared `creates:` resource either exists this frame or does not |
| unbuilt-vs-broken, indistinguishable | `pass-seams.js` — **status is already a checked fact** |
| `keywords: ['composeMaterial']` string-matching | a rule names a **resource id** from the same grammar the graph uses |
| the HEALTH-WIRING BADGE | **deleted** — nothing to sync, because the declaration IS the model |

**The rule: health may not contain a model of the system. It may only read the declarations and compare them to runtime.** If health needs a fact the declarations do not carry, that is a gap in the *declarations* — fix it there, where everyone benefits, rather than in a private copy only the watchdog reads.

Sketch:
```js
// Not "what do I know about water" — "what did water DECLARE, and is it true?"
for (const pass of PASSES) {
  for (const r of pass.creates) {
    report(pass.id, r, frame.has(r) ? 'live' : pass.status === 'seam' ? 'unbuilt' : 'MISSING');
  }
  for (const r of pass.reads) {
    if (!frame.has(r)) report(pass.id, r, 'STARVED', `declared read '${r}' was never created`);
  }
}
```
That loop replaces most of 2,261 lines, cannot drift, and **needs no badge on any effect** — because it derives from the same declaration the frame graph executes. One source of truth, two consumers.

### 3.1 Readouts become first class (the other half)
`Params.md` §3.6 found 11 `readonly: true` "params" (`statusProbeAge`, `statusDayPhase`…) — status text pushed through the params system **because it was the only display channel**. That is *why* diagnostics wrote product state. So the renderer gains a **readout** concept: a derived, computed, displayed value that is **never stored, never persisted, never writable**. Health produces readouts. Params stay knobs. The seventh writer of product params disappears — not by discipline, by having somewhere legitimate to go.

### 3.2 Health observes; it never mutates
A watchdog that changes what it watches is not a watchdog. Tripwire: `diag/` may not write params or scene documents (partially covered by `params/one-owner`; extend when the health module lands).

### 3.3 What to harvest, gratefully
- **The Breaker Box UI and its metaphor** — circuits, statuses, a header indicator. Genuinely good product thinking; rebuild the view over derived data.
- **The rule vocabulary** — `tier: 'structural'`, severities, per-level keys. Sound taxonomy.
- **The named sources** (`src:waterMasks`, `src:roofCapture`) — that IS a resource namespace, invented independently. It becomes the real `vt:`/`buf:`/`res:` ids.
- **`ShaderCompileMonitor`, `RenderStackSnapshot`, mask-presence rules** — real detectors of real failures; re-seat them on declared data.

## 3.4 ✅ BUILT AND MEASURED (2026-07-17) — the claim, proven

`src/graph/pass-health.js` + 24 assertions. The claim was *"every declaration is a free health check"*; measured:

| | V2 | Keyhole |
|---|---|---|
| Lines | **4,092** | **141** |
| Effect names hardcoded | 17 | **0** |
| Hand-written dependency edges | `addEdge(...)` | **0** — read from `passes.js` `reads:` |
| Private fields read | throughout | **0** |
| What it needs FROM effects | a badge on **10** | **nothing** |

**Questions it can now ask that V2 could not:** **STARVED** (*"this pass declared a read of `buf:scene.illum` and nothing produced it"* — the exact fact `addEdge` was guessing at); **UNBUILT ≠ BROKEN** (a seam is `info` and cites its doc — in V2 an unwired effect and a failed one looked identical, which is why a red Breaker Box was hard to trust); and breaking the first link reports STARVED down the whole chain, per pass, with no hand-drawn graph.

`breakerCircuits` derives the panel too — worst-status-wins, ids straight from the pass list — replacing `SOURCE_DEFS` and its `keywords: ['composeMaterial']` string-matching. And the tests assert the **shape** (no effect names, no private fields, no `addEdge`), so **a model cannot creep back in without a red test.**

## 4. Sequencing
Health lands **after** the frame graph runs (it needs a live frame to compare declarations against) and **after** readouts exist. It is not urgent — but the design is recorded now because *every declaration we add from here is a health check we get for free*, and that should be a conscious dividend rather than a happy accident.

---

*The Breaker Box asked exactly the right question. It just had to draw its own map first, by hand, because nobody else had drawn one. Now the map is the code — so the watchdog can read it instead of copying it.*
