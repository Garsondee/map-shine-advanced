# EFFECTS — the contract

**Status:** RESEARCH + DESIGN SPEC, authored 2026-07-16 from a direct audit of `legacy/` (V2). Not implemented.
**Companion:** `Effects.md` is the **tier** spec — how one effect is laid out so it costs what the machine can afford. **This** is the **contract** spec — how an effect talks to the rest of the system at all. Effects.md answers *"how expensive?"*; this answers *"what may it touch?"*. Read Effects.md first; it is shorter and this leans on it.
**Author directive:** *"examine the effects in the legacy folder V2... bear in mind that it worked but it became a monstrous interwoven mess... look for the things that each effect consumes and produces. I think we need to start thinking about how a sensible API structure between effects and the rest of the system would turn a mess of individual effect concepts into a unified plan."*

---

## 1. What is actually there — measured, not remembered

V2's effects **worked**. That matters and this document is not a sneer at them: the look is the product, and it shipped. But the numbers below are what "monstrous interwoven mess" means when you count it.

| Measurement | Number |
|---|---|
| Total effect code in `legacy/` | **~97,000 lines** |
| Largest single effect (`FireEffectV2.js`) | **6,861 lines** |
| `FloorCompositor.js` — the god-object that drives them | **10,063 lines** |
| Effects `FloorCompositor` knows **by name** (`this._fireEffect`, …) | **46** |
| Times it touches those named fields | **643** (≈14 per effect) |
| Distinct `render()` signatures across effects | **5** |
| Reaches into the `window.MapShine` global from inside effects | **479** |
| Private `WebGLRenderTarget`s allocated by effects | **70** (OverheadStamp alone: 13; Lighting: 11) |
| Effects that **declare** a dependency, an input, or an output | **0** |

That last row is the whole story. **Nothing is declared, so everything is discovered — by hand, by the caller, forever.**

## 2. Three structural causes

The mess is not sloppiness. Each of these is a *forced move* given the one before it.

### 2.1 There is no uniform signature, so the caller cannot be generic

```
render(renderer, camera, inputRT, outputRT)   ×8
render(renderer, camera)                       ×5
render(renderer, scene, camera)                ×3
render(renderer, inputRT, outputRT)            ×3
render(renderer)                               ×2
```

Five shapes. A composer **cannot** loop over these. It must know which kind each effect is — so it names them individually. **The 643 touch points are a consequence, not a cause.** Given no contract, `FloorCompositor` had no other option available to it.

### 2.2 Resources are PUSHED, through bespoke per-effect doors

`FloorCompositor.js:7292` is the mess in one screenshot:

```js
this._cloudEffect?.setOutdoorsMask?.(outdoorsTex);
this._ashCloudEffect?.setOutdoorsMask?.(outdoorsTex);
this._waterEffect?.setOutdoorsMask?.(waterOutdoorsTex);
this._filterEffect?.setOutdoorsMask?.(outdoorsTex);
this._atmosphericFogEffect?.setOutdoorsMask?.(outdoorsTex);
this._bloomEffect?.setOutdoorsMask?.(outdoorsTex);
this._overheadShadowEffect?.setOutdoorsMask?.(outdoorsTex);
this._buildingShadowEffect?.setOutdoorsMask?.(outdoorsTex);
```

One resource. Twelve consumers. Twelve bespoke setters. A hand-maintained list in the god-object. **Two `?.` per line** — the caller does not even know which effects have the door, so it asks at runtime, every time. Add an effect that needs the outdoors mask and you edit this list; forget, and the effect silently gets nothing. There is no error, just an effect that quietly does the wrong thing.

`setOutdoorsMask` is 12 effects. `onFloorChange`, `setSunAngles`, `setDriver`, `setTimelineGradeState`, `setMapPointsSources`, `setDynamicLightOverride` are the same pattern again, each with its own list.

### 2.3 Effects reach UP and SIDEWAYS through a global — which makes cycles

479 reaches into `window.MapShine`. Sorted by what they grab:

- `floorStack?.getFloors` (64), `activeLevelContext` (43) — **up**, to scene state
- `effectComposer?._floorCompositorV2` (41), `sceneComposer?._sceneMaskCompositor` (27) — **up, into private fields** (note the underscore: these are not APIs, they are internals)
- `lightingEffect` / `lightingEffect?.tokenMaskTarget` (10) — **sideways, into another effect**

And the sideways one closes a loop:

```js
LightingEffectV2.js:4209   const fire = window.MapShine?.fireEffectV2?._glowBucketsByFloor;
FireEffectV2.js:4799       const pad  = window.MapShine?.lightingEffect?.params?.wallPaddingPx;
```

**Lighting reads Fire's private field. Fire reads Lighting's params.** Neither can be built, tested, understood, or ported without the other. That is what "interwoven" is, mechanically: not that the code is bad, but that **the dependency graph is invisible and cyclic**, so nothing can be pulled out of it.

---

## 3. THE finding: the good design existed, and it lost

This is the most important thing in the audit, and it changes what "design a better API" has to mean.

`legacy/effects/EffectComposer.js` (2,191 lines) opens with:

```js
 * Manages effect dependencies, render order, and shared render targets
...
  BASE:             { order: 0,   requiresDepth: false },
  MATERIAL:         { order: 100, requiresDepth: true  },
  SURFACE_EFFECTS:  { order: 200, requiresDepth: true  },
  PARTICLES:        { order: 300, requiresDepth: true  },
  ENVIRONMENTAL:    { order: 400, requiresDepth: false },
  POST_PROCESSING:  { order: 500, requiresDepth: false },
```

**That is a good design.** Declared layers, numeric order, gaps for insertion, an explicit statement of intent — it is structurally the same shape as the layering law Keyhole adopted for drawables (`SORT_LAYERS {SCENE:0, TILES:500, TOKENS:700}`), arrived at independently, and it is *right*.

**It is used in exactly one place outside its own file, and that place is a console helper.**

| | importers |
|---|---|
| `EffectComposer` (the designed path) | **5** |
| `FloorCompositor` (the god-object) | **92** |

**V2 did not fail from lack of design. Someone built the right abstraction and 46 effects walked straight past it**, because wiring yourself into the god-object was easier than conforming to a contract. The contract was optional, so it lost. Every single time.

> **The lesson, and the load-bearing requirement for everything in §5:**
> **A good API that is optional is a good API that loses.** Designing a better contract is *necessary and completely insufficient*. The contract must be the **only** way to get anything — not the recommended way, not the clean way. The *easy* way and the *only* way, or V3 grows its own FloorCompositor within a year.

This is Keyhole doctrine #5 already in writing (*"the doctrine, the allocator throw, and the import fence exist precisely to make relapse harder than doing it right"*) — here is the proof it was earned, in this codebase, at the cost of 97,000 lines.

---

## 4. What effects CONSUME and PRODUCE

The author's actual question. Counted across all V2 effects:

### 4.1 Consumes — seven kinds, and only one is poison

| Kind | Hits | What it is | Verdict |
|---|---|---|---|
| **Params** | 2197 | tuned values from scene flags + control panel + client overrides | legitimate — **the product**, and the biggest single input |
| **Floor context** | 1170 | which floors exist, which is active, this effect's floorIndex | legitimate — hand it in |
| **View** | 785 | camera, zoom, visible rect, scene bounds, dimensions | legitimate — hand it in |
| **Walls / vision** | 567 | wall geometry, padding, LOS polys | legitimate — Foundry-owned (Keyhole §4.3), hand it in |
| **Masks** | 286+ | its own `_Specular`/`_Fire`/`_Water`, plus shared `_Outdoors` | legitimate — **a VT read** now |
| **Other effects' outputs** | 151 | `lightingEffect.tokenMaskTarget`, fire's glow buckets | **legitimate NEED, poisonous ROUTE** |
| **Time of day** | 30 | sun angle, ToD anchor | legitimate — hand it in |
| Perf recorder | 21 | span begin/end | infrastructure |

**Six of the seven are just scene state**, and every one of them is something the system already knows and could simply *hand to the effect*. They are reached for through a global only because nothing hands them over.

**The seventh — reading another effect's output — is a real requirement.** Lighting genuinely needs fire's glow. Specular genuinely needs the token mask. **The need is legitimate; the route is the disease.** Fix the route and this becomes the most useful edge in the system: a declared dependency the graph can order, cull, and verify.

### 4.2 Produces — two kinds, and neither is declared

1. **A contribution to a shared buffer** — most effects ultimately modify the scene colour.
2. **A named artifact other passes need** — lighting's `illum` and token mask, fire's glow buckets, the shadow targets.

**Neither is declared.** Kind 2 is published as `this._privateField` and read through a global by anyone who knows the name. That is why there are **70 private render targets**: with no way to declare *"I produce a thing called `glow`"*, every effect allocates its own, forever, at world resolution. §4.2's RT crisis and this missing declaration are **the same bug**.

### 4.3 The knot is FAKE — verified, not asserted

The Lighting↔Fire cycle looks fundamental. It is not:

```js
LightingEffectV2.js:328    wallPaddingPx: 2.0,     // ← a DEFAULT PARAM VALUE. A constant.
FireEffectV2.js:4799       const pad = window.MapShine?.lightingEffect?.params?.wallPaddingPx;
```

**Fire reaches through a global, into another effect's internals, to read a constant.** That direction is not a data dependency at all — it is two effects **sharing an input**, expressed as one rummaging in the other. The real graph is:

```
params.wallPaddingPx ──┬──> Fire ──(glow)──> Lighting
                       └──> Lighting
```

A DAG. One direction. **The cycle was an artifact of the reach-around, not of the physics.** Declaring inputs does not *manage* this knot — it **dissolves** it.

Expect this to generalise: most V2 "interweaving" is probably shared inputs wearing a trench coat. That is a hopeful finding for Stage 6 — the port is less entangled than it looks, once the routes are fixed.

---

## 5. The contract

An effect is a **declaration**, not an object that gets wired up. Everything V2's god-object did by hand becomes **derived** from the declaration.

```js
export const SPECULAR = {
  id: 'specular',
  layer: LAYERS.SURFACE,          // ordering — EffectComposer's good idea, made mandatory

  // WHAT IT MAY TOUCH. This is the whole contract. If it is not listed, the
  // effect cannot reach it — not "should not", CANNOT: there is no global to
  // reach through and no reference to rummage in.
  reads: [
    'vt:specular',                // a VT layer-pack — the ONLY way to world data
    'buf:scene.attr',             // floor/outdoors/coverage — a C3 graph read
    'buf:scene.illum',            // lighting's DECLARED output. Not lightingEffect._foo.
  ],
  writes: ['buf:scene.color'],    // or 'res:glow' to publish a named artifact

  params: SPECULAR_PARAMS,        // a SCHEMA, not a grab-bag — the product's knobs
  tiers: SPECULAR_TIERS,          // the ladder — see Effects.md

  build(ctx) {
    // ctx holds EXACTLY what `reads` declared, and NOTHING else.
    // There is no ctx.compositor, no ctx.effects, no window.MapShine.
    // Reaching sideways is not forbidden by policy — it is unavailable.
  },
};
```

**`ctx` is the enforcement.** Not a lint rule, not a review comment, not doctrine — an absence. You cannot reach into another effect because you were not given anything to reach with. This is the same move as §4.6's allocator: make the wrong thing *impossible at the call site*, not *discouraged in a document*. V2 proves discouragement loses.

### What the frame graph now DERIVES (all of it hand-written in V2)

| V2 did this by hand | Keyhole derives it from `reads`/`writes` |
|---|---|
| 643 named touch points | **zero** — the graph resolves `reads` and calls `build(ctx)` |
| Render order in a 10k-line file | **topological sort** of the dependency graph, tie-broken by `layer` |
| The Lighting↔Fire knot, invisible | **a cycle is a BUILD ERROR**, named, at startup, with both edges |
| 12 hand-listed `setOutdoorsMask` calls | one resource, N declared readers, resolved automatically |
| 70 private RTs, world-res, forever | **pooled and aliased by lifetime** — a buffer nobody reads next is reused |
| Effects silently doing nothing when the list was missed | **an undeclared read is an error**; an unsatisfiable read names the missing producer |
| `resolve-effect-enabled`'s hardcoded `['ascii', '_asciiEffect']` table | an effect is a value in a registry; nothing knows its field name |
| Dead effects still costing | **passes whose outputs nobody reads are culled** |

That table is the answer to *"turn a mess of individual effect concepts into a unified plan."* The plan is: **declare, and let the graph do what the god-object was doing by hand.** The god-object is not refactored — it is *derived*, and therefore deleted.

### The rules that make it stick

1. **`ctx` contains exactly the declared reads.** No escape hatch. No `ctx.system`. The moment one exists, it becomes the new `window.MapShine` — that is not a prediction, it is what happened.
2. **No effect may name another effect.** Ever. It names a **resource** (`buf:scene.illum`), which some pass produces. Renaming or replacing the lighting pass must not touch a single consumer.
3. **A resource has ONE producer**, declared. Two writers of `buf:scene.color` without an explicit blend contract is a build error, not a race.
4. **Params are a schema, not an object to rummage in.** Fire may not read Lighting's params — if a value is shared, it is a shared param with one home. That is what dissolved the knot (§4.3).
5. **No effect allocates a render target.** It declares `writes`, the graph allocates, pools, aliases and frees. This is how 70 private RTs become a handful, and how §4.6's allocator gets a single chokepoint to enforce the law at.
6. **Everything an effect touches is versioned by frame.** No effect reads a buffer another pass will write later this frame — the graph knows the order, so it can prove this rather than hope.
7. **One TSL source, tiers per Effects.md.** The contract says what it may touch; the ladder says how much it may spend.

---

## 6. What this changes about Stage 6

Keyhole §4.4 maps 48 V2 effect classes → ~10 passes, and `keyhole-stage6-effects-approach` says to audit and rethink each one rather than mechanically port it. This audit sharpens both:

- **The 48→10 collapse is more achievable than it looks.** Much of the 97k lines is not effect logic — it is *wiring*: bespoke setters, floor-index resolution (`_resolveFloorIndex` in 11 effects), overlay lifecycle (`_createOverlay`, `_syncOverlayVisibility`, `_disposeOverlayEntry`), perf-span plumbing (`_beginPerfSpan`/`_endPerfSpan` in 9), mask-status UI notification (7). **All of it exists because there is no contract, and all of it evaporates under one.** The actual shader and its tuned params — the product — is a fraction of each file.
- **Port the DECLARATION first, the implementation second.** For each effect, write its `reads`/`writes`/`params`/`tiers` before touching a line of shader. If the declaration cannot be written, the effect is not understood yet, and that is worth finding out in an afternoon rather than in week three.
- **The declarations are a survey.** Ten declarations will show which resources are genuinely shared, which "effects" are one pass wearing several names, and where the real dependency edges are. **That is the unified plan** — and it is cheap, because a declaration is data.
- **Water still goes first** (§4.4, §9 risk 4). Its cross-floor sim-source rule is the hardest edge in the system, and it is exactly the kind of thing that was expressed in V2 as a reach-around. It will be the best test of whether the contract can express real work.

## 7. What this deliberately does not decide

- **The resource namespace.** `vt:`/`buf:`/`res:` is a sketch, not a decision.
- **Which 10 passes.** §4.4's mapping is still the starting inventory.
- **The params schema shape.** It is 2197 hits and the single biggest input; it deserves its own pass, and the tweakpane panels are part of the product (§6 harvest).
- **How tiers and `reads` interact.** A tier that needs an extra pack (Effects.md's `packs: {3: [...]}`) implies reads that only exist at that tier. Probably per-tier `reads`. Not decided.

---

*V2's contract was optional, so it lost. Make it the only door.*
