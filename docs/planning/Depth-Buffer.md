# The Depth Authority — a real depth buffer for an orthographic hole-stack

**Status: DESIGN. Nothing built.** This is the plan of record for `buf:scene.depth`, a resource name that has been reserved in [`src/graph/passes.js:185`](src/graph/passes.js:185) since the pass graph was written and never implemented.

**Why now:** the light-elevation-occlusion failure (`docs/planning/Light-Elevation-Occlusion-Failure.md`, fifteen rounds, still broken) is not a lighting bug. It is what happens when an effect has to re-derive "is something above me at this pixel" from scratch, out of a byte-packed side-channel that was never designed to carry an ordering. Every effect that needs the same answer has invented its own version of it, and each one has been wrong differently:

| effect | its private answer to "what's above me" | how it broke |
| --- | --- | --- |
| point lights | 4-bit quantized height above own floor + floor index + a 1e6 sentinel | 15 rounds, still broken |
| specular | `PRESENCE_BIT_OCCLUDES_BACKGROUND` (one bit) | polarity inverted after shipping twice in one day |
| sun shadows | `attr.r` floor-index equality | every Level foreground attributed to the floor above |
| vegetation | `passiveElevationFraction` riding the same 4 bits | untested live |
| region darkness | its own elevation-band filter | one floor's region darkened every floor |
| aperture gobo | nothing — assumed | 19 rounds |

Six subsystems, six answers, one question. **This document designs the one answer.**

---

## 1. The idea, in one sentence

> **The depth value is the drawable's own position in the flat sort law — the integer `sortByLayer` already stamps on it.**

Not a Z distance. Not an elevation. Not a quantized height. [`scene/layer-order.js`](src/scene/layer-order.js) already sorts every drawable in the scene with Foundry's own comparator (`elevation → sortLayer → sort → zIndex → tiebreak`) and assigns `renderOrder = index`. That integer is a **total order over everything that draws**. It is already the painter's order. It is already correct for "background image, tile and foreground image sort and elevation" — that is literally what the comparator is.

So: **rank = renderOrder.** Compare two ranks and you know which is on top. No new ordering concept, no second authority, nothing to keep in sync, nothing to quantize.

Everything else in this document is plumbing to get that number into a buffer and back out again without corrupting it.

### What this immediately deletes

- `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL` (elevation 0 ⇒ unblockable — the direct cause of the live lighting bug)
- `elevationRank` + `ELEVATION_RANK_FRACTION_DIVISOR` + the CPU/GPU mirrored constants + the cross-file pin test
- `RECEIVER_ELEVATION_LEVELS`, `RECEIVER_ELEVATION_RANGE_UNITS`, `quantizeReceiverElevationAboveFloor`, `decodeReceiverElevationLevel`
- `PRESENCE_BIT_OVERHEAD`, `decodeOverheadBit`
- `PRESENCE_BIT_OCCLUDES_BACKGROUND` and its threshold
- `HEIGHT_GATE_TOLERANCE_UNITS` / `HEIGHT_GATE_SOFTNESS_UNITS` (a soft band exists only because the value being compared was quantized garbage; an exact ordinal needs no tolerance)
- `ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD = 0.5` (replaced by the item's own authored `alphaThreshold`)
- ultimately, `buf:scene.attr` in its entirety

That is not a side benefit. Every one of those exists to prop up a comparison that a real depth buffer makes trivially.

---

## 2. Why a depth buffer and not another packed byte

The attr buffer's fatal property is that it rides **alpha blending**: `attr_new = attr_old·(1−α) + attr_src·α`. A rank is a value, and a blended value is arithmetic garbage with no relationship to either endpoint. Round 15 tried to fix that with an alpha test; that helps, but it still leaves the answer dependent on **draw order** (last writer wins), which is exactly the thing that failed silently in rounds 7 and 10.

A depth buffer has neither problem:

- **The GPU does the max for you.** `depthCompare: 'greater'`, `depthWriteEnabled: true`. The winning fragment is the highest-ranked one. **Order-independent** — it does not matter which order the drawables are submitted in. That kills an entire bug class permanently.
- **32-bit float precision.** Integers exact to 2²⁴ ≈ 16.7 million. No quantization, no range constant to guess wrong by 10×, no collisions.
- **The colour attachment carries the winner's payload for free.** Whatever the depth-winning fragment writes to the colour target is what lands — floor index, flags, outdoors, anything. No blending, no margins, no polarity puzzles.
- **Early-Z makes it fast.** Put the rank in the vertex Z (`mesh.position.z = rank`), never `fragDepth` — a shader that writes `fragDepth` disables early-Z on every GPU.
- **It is what Foundry does.** `CanvasDepthMask` (see the source audit in the failure report) is the same idea with 8 bits and a MAX blend because PIXI cannot do better. We can do better.

### Holes fall out for free

A fragment whose albedo alpha is below its item's own authored `texture.alphaThreshold` calls `discard()` and never enters the depth test. So a hole in a roof is a pixel where the roof never won, and the floor below is the answer. That is [[keyhole-orthographic-hole-stack-model]] implemented rather than approximated — *albedo's own opacity is the only ground truth for "is there a surface here"*, expressed as one `discard`.

⚠️ `discard()` must live inside an `Fn()` body — [[keyhole-region-discard-noop-bug]]: it is a silent no-op outside one.

---

## 3. Layers — one pass primitive, run more than once

The topmost **surface** and the topmost **light blocker** are different questions with different answers. A rug is a surface and does not block light; a roof tile with "Restrict Lighting" unticked is a surface and does not block light. If lighting reads the surface rank, every ground-floor prop becomes an occluder — which is precisely the false-positive class MSA has today (every whole-image item writes attr).

One depth attachment yields one winner, so each question needs its own target. The answer is not a special case per question — it is **one reusable pass primitive invoked with a different membership filter**:

```js
renderDepthLayer({ items, filter, target })
```

| layer | membership filter | consumers |
| --- | --- | --- |
| `solid` | every drawable that paints opaque art, **including tokens** | specular occlusion, sun shadows, vegetation, water, grade, fog, anything asking "what floor is this pixel showing" |
| `light` | Level **backgrounds**, Level **foregrounds**, **tokens**, and Tiles that are `restrictsLight`-ticked **or sitting at/above their own floor's `elevation.top`** | point lights, candle/lightning, aperture gobo, window light |
| `weather` | `item.restrictsWeather` | rain/snow occlusion, particles — **deferred, named not silent** |

`restrictsLight`, `restrictsWeather` and `alphaThreshold` are **already read faithfully** by [`scene-layers.js:311,405,410,315`](src/foundry/scene-layers.js:405) and consumed nowhere. This design's inputs already exist; nothing new has to be extracted from Foundry.

### 3a. Why the `light` filter is *not* Foundry's (author decision, 2026-08-04)

Foundry does **not** block light with a Level's foreground (`primary.mjs:301` sets `restrictsLight = true` only `if (lt.isBackground)`), and does not block with tokens at all. I originally proposed matching that. **The author overruled it, correctly:**

> *"Level foregrounds should block light from lights which are below their elevation… you know how when a light is behind an object in real life and you can't magically see through the object?"*
> *"Tokens have elevation and tokens have an albedo texture which gives accurate opacity readings. If a token is ABOVE a light source, guess what… the light would be blocked the same way as with everything else."*

That is the [[keyhole-orthographic-hole-stack-model]] applied consistently, and [[keyhole-parity-compat-doctrine]] says MSA owns the picture. Foundry's narrower rule is a limitation of a one-channel 8-bit depth mask that also has to fade roofs for token visibility, not a considered rendering opinion. So:

- **A Level's foreground IS the roof layer by construction** — it sits at `elevation.top`, which is exactly what "overhead" means. It is not ambiguous the way a tile is, so it needs no opt-in flag.
- **Tokens are surfaces with real per-pixel opacity.** A flying token above a torch occludes it; a token standing beside it does not (equal rank — see the tie-break in §6).

### 3b. Why tiles still need a signal — elevation is a sort key, not a height

The tempting simplification is "every solid surface above the light blocks it, done, no filters." It breaks on tiles, and the reason is already a named lesson here: [[feedback_elevation_is_sort_key_not_offset]].

A decorative rug authored at `elevation: 3` inside a floor spanning [0, 20) is not three feet in the air. **3 is a sort number** — the author's way of saying "draw this above the flagstones." A torch at `elevation: 0` beside it outranks nothing, so a pure rank rule makes the rug black. That is wrong, and it is wrong for every prop, rug, decal and furniture tile in every scene.

For Level art and tokens, elevation genuinely *is* a height (a Level's band is a real vertical band; a token's elevation is how high it is off the ground), so rank alone is trustworthy. For tiles it is overloaded, so a tile needs to state its intent. Two ways, both already authored:

1. **`restrictions.light` ticked** — Foundry's own explicit per-object checkbox.
2. **The tile sits at or above its own floor's `elevation.top`** — [`isInForeground`](src/scene/layer-order.js:226), already implemented. This is what makes the author's own `_Overhead` convention work.

Reason (2) is not a heuristic bolted on; it is required by how the author actually authors. From [`fixtures/tower-bridge.js:206-230`](tools/shader-lab/fixtures/tower-bridge.js:206), author-ruled 2026-08-01:

> *"I use `_Overhead` … for me to remember that a layer belongs to a particular floor and therefore belongs as the highest element on that floor. **I use tiles or the foreground image for that scene's level for these textures**"*

The same art, with the same intent, is hosted **either as a Level foreground or as a Tile**. Rule (1) alone would mean `Tower_Bridge_Middle_Overhead.webp` blocks light when the author hosts it as a foreground and silently does not when they host it as a tile — the same picture, two behaviours, decided by an authoring choice that has nothing to do with light. Rule (2) makes the two hosts agree, which is what the author's convention already means.

⚠️ **The half-open-band trap applies to rule (2) and only to rule (2).** A tile at exactly `elevation.top` falls into the band *above* under `resolveElevationFloorIndex`'s `[bottom, top)` ([[feedback_half_open_band_excludes_its_own_member]], already paid for twice). Round 8's epsilon-adjusted lookup is the fix and must be carried over — but note it is now confined to this ONE membership question. The **rank** comes straight from the sort key and never touches a band lookup at all, so the trap can no longer corrupt the ordering itself.

The `weather` layer costs nothing to add later precisely because the pass is a primitive with a filter, not three hand-written passes. That is the "flexible and reusable" the ask names.

---

## 4. Format

### Per layer, one render target:

| attachment | format | contents |
| --- | --- | --- |
| depth | `DepthTexture`, `FloatType` (depth32float) | **the rank**, normalised `rank / MAX_RANK` into [0,1] |
| colour 0 | `RGBA8`, NEAREST, NoColorSpace | the winning fragment's payload |

Colour payload (this is `buf:scene.attr`'s job, done by a depth test instead of a blend):

| channel | meaning |
| --- | --- |
| R | floor index of the winning drawable (0-255) |
| G | `outdoors` at this fragment's world position (the existing `buildWorldSpaceOutdoorsGate`, unchanged) |
| B | flags: bit0 `restrictsLight`, bit1 `restrictsWeather`, bit2 `isLevelBackground`, bit3 `isLevelForeground`, bit4 `isTile`, bit5 `occlusionFaded` |
| A | 255 for any fragment that won (i.e. "something is here"), 0 for the cleared buffer |

Note what changed about the flags: **they are no longer a value field riding a blend.** They are the winner's own byte, written whole. A polarity mistake in a flag is now a plain bug, not an invisible corruption — which is the entire content of `PRESENCE_BIT_OCCLUDES_BACKGROUND`'s 60-line polarity essay.

**Clear values:** depth `0` (rank 0 = below everything), colour `(0,0,0,0)`. Both mean "nothing here", and both read as **fail-open** for every consumer — a light under an unwritten pixel is lit, a shine on an unwritten pixel shows. [[feedback_gate_polarity_must_fail_open]] is satisfied by construction, not by a convention someone has to remember.

### `MAX_RANK` and precision

`MAX_RANK` = the count of ranked drawables this frame, published by the authority as a uniform. Normalising by a live count means the depth values spread across the full [0,1] range regardless of scene size, and `rank` round-trips exactly: `round(depthSample * MAX_RANK)`. depth32float holds every integer up to 2²⁴ exactly, so this is lossless for any scene that fits in memory at all.

---

## 5. Slices — "an accurate buffer for all floors, use the correct slice"

Two separate things are being asked for here, and they have very different costs.

### 5a. "Accurate for all floors" — free, and the important half

Today the viewer draws the viewed floor plus whatever floors that floor's own `visibility.levels` declares ([`vt-pan-viewer.js:34-49`](src/vt/vt-pan-viewer.js:34)). Anything not drawn does not exist to any effect.

**The depth pass takes its own draw list: every item from `collectSceneLayers`, all floors, regardless of view.** A light on floor 0 then correctly sees floor 3's roof above it whether or not floor 3 is currently being painted. This is strictly more than Foundry has (Foundry's depth mask only contains what the current view draws) and it costs one traversal of a trivial material.

⚠️ **Residency caveat, stated not hidden.** An item on a floor that is not being drawn may have no resident texture, and the alpha test needs one. Use the **coarse mip**, which residency already pins for every item (`coarsePinSet` / `computeCoarsePinBudget`), and where even that is missing, **skip the item and log it** — never silently treat "not loaded" as "not there". [[feedback_instruments_must_not_lie]]: an incomplete slice must say so.

### 5b. Per-floor slices — DEFERRED OUT OF v1 (decided)

**Author: *"The budget table is only useful if it doesn't prevent development of the module. Don't let it stand in the way."* Agreed, so here is the decision rather than a menu: v1 ships NO slices.**

Tier 0 — full-resolution `solid` + `light`, over the all-floors draw list — is 59 MB at 1440p / 133 MB at 4K, and it already delivers "an accurate buffer for all floors," because §5a's all-floors draw list is the part that carried that promise. Slices only add the ability to ask *"topmost surface at or below floor N"* for an N that is neither the top nor the viewed floor, and **no consumer in the codebase asks that question today.** Building storage for a question nobody asks is exactly the kind of speculative scaffolding that would slow this down.

The design below stays in the document so that when a consumer does need it, the mechanism is already worked out and the memory cost is already known — not so that v1 has to pay for it. The rest of this section is **reference, not scope.**

A slice is: *the topmost surface at or below floor N.* Because the sort law is elevation-ascending, slices are **cumulative**, so they are cheap to build:

```
clear layer 0
draw floor 0's drawables      → layer 0 is now "floors ≤ 0"
copy layer 0 → layer 1
draw floor 1's drawables      → layer 1 is now "floors ≤ 1"
copy layer 1 → layer 2
...
```

**One traversal + (N−1) blits per layer set.** Not N traversals. Three's WebGPU build supports layered render targets with array depth textures (`useArrayDepthTexture`, [`three.webgpu.js:4822`](src/vendor/three/three.webgpu.js:4822)), which is the natural home: `texture_2d_array<f32>` indexed by floor.

**The cost, plainly, because this project has already lost a GPU device to memory ([[keyhole-device-loss-large-map]]):**

| config | bytes/px | 2560×1440 | 3840×2160 |
| --- | --- | --- | --- |
| one full-res layer (depth+colour) | 8 | 29 MB | 66 MB |
| `solid` + `light`, no slices (**tier 0**) | 16 | 59 MB | 133 MB |
| + 6 floor slices, full res, depth only | +4×6×2 | +354 MB | +796 MB ❌ |
| + 6 floor slices, **half res**, depth only | +1×6×2 | **+88 MB** | +199 MB |
| + 6 floor slices, **quarter res**, depth only | +0.25×6×2 | +22 MB | +50 MB |

When this is eventually built: **half-resolution, depth-only (rank), with a computed budget and a hard cap.** The full-resolution non-sliced buffers stay available for anything needing exact hole edges — which is most consumers most of the time, since a hole's edge matters and "what was the topmost surface two floors down" does not need to be pixel-crisp. If the budget is exceeded, **fall back and say so in the status report** — never allocate past the cap, never truncate silently ([[feedback_silent_cap_corrupts_hard_boundary]]).

A cheaper intermediate, if a consumer ever needs *some* slicing but not all of it: two slices only — `top` (everything) and `viewed` (≤ the viewed floor) — which covers the plausible queries at a third the memory of a 6-floor set and needs no array texture at all.

---

## 6. The Authority — the part that actually stops the bleeding

The buffer is not the deliverable. The deliverable is **one module every effect asks, instead of each one decoding bytes.** This is the [[keyhole-mask-authority]] pattern, which already works in this codebase, applied to depth.

`src/scene/depth-authority.js` — pure, Node-testable, no THREE:

```js
// ── CPU side ────────────────────────────────────────────────────────────
depth.rebuild(items)              // sortByLayer once; publish ranks + tables
depth.rankOf(item)                // → integer rank for a drawable
depth.rankOfKey(layerKey)         // → rank for anything with a sort key
depth.rankOfElevation(elevation)  // → rank a light/effect at this elevation sits at
depth.floorOfRank(rank)           // → floor index
depth.maxRank                     // → the normalisation divisor
```

`rankOfElevation` is the one that kills the sentinel. Given a light at elevation E, it binary-searches the sorted key list for where E lands — Foundry's `mapElevation`, generalised from elevations to full sort keys. **Elevation 0 is an ordinary, low, perfectly comparable rank.** There is no "unconfigured", no sentinel, no second signal needed, and no authoring burden: a light that has never had its elevation touched is *correctly the lowest thing in the scene* and is occluded by everything above it — which is exactly what the author has been asking for since round 1.

`src/vt/scene-depth.js` — the THREE/TSL half:

```js
// ── GPU side: ONE query, every effect uses it ───────────────────────────
const d = depthNodes.query(TSL, { layer: 'light', slice: 'top' });
d.rank            // float node, the exact ordinal at this pixel
d.floorIndex      // float node
d.outdoors        // float node
d.present         // 0/1 — did anything win here
d.flag('restrictsLight')
d.isAbove(myRank) // 0/1 — is the surface here above me
d.isBelow(myRank)
```

The whole point-light height gate then becomes, in full:

```js
const gate = depthNodes.query(TSL, { layer: 'light', slice: 'top' }).isBelow(uLightRank);
combinedFalloff = combinedFalloff.mul(gate);
```

One line. No smoothstep band, no tolerance, no softness, no overhead bit, no sentinel, no mirrored constants, no CPU twin to keep in sync.

**The query API takes an already-sampled position the same way `buildHeightGateNode` does** — [[feedback_shared_texture_node_carries_the_wrong_uv]] cost four rounds; the API must make `screenUV` the only expressible answer, not a thing each caller remembers.

---

## 7. The pass

`geometry.depth`, a new pass, drawn **before** `geometry.world`.

- **Its own scene, its own meshes.** Proxy meshes sharing each item's geometry, with a tiny depth material — the same twin-mesh idiom point lights already use (`colorationMesh` sharing `geometry`). Not a material swap on the production meshes: [[feedback_diagnostic_must_not_render_production_materials_elsewhere]] is a standing lesson about rendering production materials into a second target, and a full-floor draw list needs meshes the colour pass does not have anyway. **One code path for all items** — no "resident items swap, non-resident items proxy" fork ([[feedback_mode_forks_silently_drop_features]], proven three times).
- **The material is trivial:** sample albedo alpha at `.level(0)` (round 10's fix, keep it), `discard()` below `alphaThreshold`, write the payload byte. No clarity, no tint, no occlusion fade, no lighting.
- **`depthTest: true`, `depthWrite: true`, `depthFunc: GreaterDepth`, no blending.** The rest of the renderer stays `depthTest:false`; this pass is the one place a real Z exists, in its own target.
- Rank enters as `mesh.position.z = rank / maxRank`. Never `fragDepth`.

**Pass-graph declarations** (`src/graph/passes.js`): `geometry.depth` **creates** `buf:scene.depth` (finally real) and `buf:scene.depth.light`; `light.accumulate`, `surface.response`, `post.grade` and the shadow passes gain them as **reads**. The graph's own `reads-before-creates` validator then enforces the ordering for free.

---

## 8. Verification — the real map, in the lab, automatically

No more probes. Two things replace them, and neither is a number I go fishing for after the fact.

### 8a. The bench draws the REAL three-floor map, not a building made of rectangles

**This is the load-bearing change.** [`tools/shader-lab/bench-floor-lighting.js`](tools/shader-lab/bench-floor-lighting.js) currently builds a three-floor building out of primitives with a synthetic attr encoder. That is exactly the shape that let round 7's bug survive three lab-green rounds: *"the bench's synthetic roof had NO occlusion concept at all"* — [[feedback_bench_must_build_inputs_like_production]], and its sibling [[feedback_synthetic_fixture_invariant_is_not_authored_art]].

The fixture to fix it **already exists**: [`tools/shader-lab/fixtures/tower-bridge.js`](tools/shader-lab/fixtures/tower-bridge.js), the real "town river bridge" map, with author-ratified elevation bands (Underground 0-20, Middle 20-40, Roof 40-∞), all three backgrounds, and the two `_Overhead` layers already declared in `ART_LAYERS`. It has never been assembled into a drawn stack — it has only been used for mask ingest.

So the depth bench draws it: **three Level backgrounds + two `_Overhead` foregrounds, at their real elevations, at real alpha, through the real depth material.** `EXPLORE_SCALE` (0.25) for iteration, production scale for the fidelity run, and the report states which — the fixture's own established discipline.

Why this specific art is the right test and a synthetic slab is not:

- The `_Overhead` layers have **real transparent holes** — the open river channel runs straight through the middle of the map with nothing overhead, and the buildings are solid roof mass. So one frame contains both "occluded" and "not occluded" **for the same light**, in a shape you recognise. A blanket cross-floor kill and a correct per-pixel bite look identical on a rectangle; on this map they do not.
- Real silhouettes: crenellations, thin trim, bridge cabling, and the seams where two pieces of art abut. That is where an alpha test at the wrong threshold shows up.
- The author already has this map in Foundry, so a lab result and a live result are about **the same picture** — which is what makes a disagreement between them informative instead of just confusing.

### 8b. What the bench asserts, automatically

Each of these is a fact about the picture, not a byte I went looking for. Several are direct regression pins on failures already in the record:

| assertion | pins |
| --- | --- |
| A light under the Middle `_Overhead`'s opaque roof mass is dark; **the same light, same frame**, where the `_Overhead` is transparent over the river, is lit | the whole feature. A blanket kill fails this |
| A light with **elevation left at 0** is occluded by a roof above it | the sentinel bug — this was *impossible* under the old model |
| `_Overhead` hosted as a **Level foreground** and the same art hosted as a **Tile at `elevation.top`** produce identical depth | §3b's two-host agreement |
| A token at elevation 30 above a light at 20 blocks it; the same token at 20 does not | decision 3 + the §6 tie-break |
| A rug tile at elevation 3, `restrictsLight` unticked, does **not** darken a torch at elevation 0 | §3b — the thing a pure rank rule would break |
| `round(depthSample × maxRank)` equals the CPU-side `rankOf(item)` for a known drawable | the rank round-trips losslessly; catches a normalisation or precision slip |
| The frame **changes** between viewing floor 0 and floor 2 | round 4's own detector — `0.00% of pixels differ` was the tell that the gate was reading a constant |
| Nothing is written where every layer's alpha is below its `alphaThreshold` | `discard()` actually discarded ([[keyhole-region-discard-noop-bug]]) |

### 8c. The false-colour view, for the human look

Render `rank → hue` into the debug panel ([[keyhole-debug-panel]], one control one action). Every floor becomes a colour band, every tile a step within it, and a hole in a roof is literally the floor's colour showing through in the shape of the hole. A wrong layering is a wrong picture — you see it, in one glance, with no numbers. Plus a click-driven `isBelow(cursorRank)` view: click a point, every pixel the buffer says is below that surface lights up.

### 8d. The limit, stated plainly

The lab runs the real shader on a real GPU against the real art. It still **cannot** prove residency, mask discovery, the production draw-list construction, or Foundry's own document reads — which is exactly the caution you gave, and it is why the existing `floor-lighting` bench went green three times while the live scene stayed broken. Lab-green stays `BUILT (unverified)`; your eyes on your own scene are what say `LIVE` ([[keyhole-current-state]]).

What changes is the failure mode: the bench now fails for real reasons instead of passing for synthetic ones, and when it and the live scene disagree, the disagreement is about one map both of us can look at.

---

## 9. Staging

Each stage is independently shippable and independently verifiable. No stage requires trusting the next one.

| stage | what lands | proof |
| --- | --- | --- |
| **0** | βœ… **DONE (2026-08-04).** The real-map bench, on the CURRENT broken gate. `fixtures/tower-bridge.js`'s three real Level backgrounds + two real `_Overhead` layers, drawn through `collectLevelTextures`/`sortByLayer`, into `bench-floor-lighting.js`'s new `real-map-reproduces-the-live-bug` scenario. No production code touched. | **Confirmed FAILING, for exactly the predicted reason.** 7 of 8 checks pass (the encoder is correct; every control β€” configured-elevation cross-floor, same-floor overhead, top-floor, open-sky β€” behaves correctly); the ONE failure is `THE-LIVE-BUG-unconfigured-light-under-real-roof-is-NOT-occluded` reading fully bright (255) where it must read ambient (60). Artifacts (`real-map-attr.png`/`real-map-illum.png`) show a recognisable map (the two bridge towers as real Roof-floor rectangles, river patches) under real lighting, not synthetic geometry. See Β§9a for what building this against real art actually found. |
| **1** | πŸŸ’ **CPU half DONE; GPU mechanism proven in the lab; production module real, tested, reachable, AND now wired into the CONTINUOUS live per-frame loop (2026-08-04). Only consumer migration remains (stage 2).** `vt/scene-depth.js`: `describeSceneDepthTarget`, `computeSceneDepthFlags`, `resolveSceneDepthFloorIndex`, `rankToDepthZ`, `computeExpectedStoredDepth`, `buildSceneDepthWriterMaterial`, `buildSceneDepthProxyMesh`, `querySceneDepth` — every one a direct port of what `bench-scene-depth.js` already proved. `graph/three-allocator.js` extended (`depthTexture: true`) for a REAL, samplable `depth32float` attachment. `vt-pan-viewer.js` now REALLY does the following, every session: `sceneDepth` (a real allocator target) + `depthScene`/`depthCamera` (this pass's own dedicated scene/camera, X/Y framing synced from the SAME `computeCameraFrustum` the world camera uses, never sharing its Z) are built once; `rebuildSceneDepthProxies(items)` runs at the end of EVERY residency pass, walking the real, current `itemStates` and building one depth-writer proxy mesh per VISIBLE tile (sharing that tile's own geometry, never a copy) for every Level background/foreground, tile and token `ensureWholeImageMeshes` produces; `runSceneDepthPass()` renders that scene into `sceneDepth` every single frame, from inside `runGeometryWorldPass` itself (the same place door leaves already composite in). A NEW perf zone (`geometry.depthDraw`) measures its real GPU cost — Β§11's own "measure it, don't predict it" risk, answered rather than assumed. **Still NOT done, and this genuinely is stage 2, not a stage-1 gap:** no consumer (a light's own occlusion gate) reads from `buf:scene.depth` yet; vegetation Case-2 overlays don't participate (named gap, not silent — they aren't part of `depthAuthority`'s own ranked list either). | CPU half: a fuzz test (500 Γ— 20) proved the binary search exactly, caught a real bug first try. GPU half: 5 lab scenarios, 21/21 (Β§9b). Production module: `computeExpectedStoredDepth` verified against a real GPU inside `runSceneDepthSelfTest`, not just derived on paper. THIS ROUND: two real structural walls hit and fixed, not routed around — a genuine collision between `gpu/allocator-only` and `gpu/textures-in-vt-only` over `DepthTexture` (fixed by narrowing that rule's own pattern, `CONVENTIONS.md` Β§7's own doctrine) and a `log/one-door` ratchet trip from two `console.error` calls (fixed by using the file's own `log` instance). A genuine variable-shadowing bug (the self-test's own local `depthCamera` colliding with the new persistent one) was found on self-review and renamed before it could confuse a future reader — harmless in practice, still fixed. Full project suite: 7360 passed, 0 failed, structure gates at their EXISTING bounds — 9 ratcheted, nothing newly tolerated anywhere, including `log/one-door`. **What is NOT yet true: nobody has clicked `MapShine.debug` β†’ this live wiring in a real Foundry session.** Lab-green plus a clean `npm run verify` is `BUILT (unverified)`, not `LIVE` — that promotion is the author's own eyes on their own scene, same standard as everything else in this document. |
| **2** | `light` layer. Point lights, candle, lightning, aperture gobo move to `isBelow`. **Delete** the sentinel, overhead bit, `elevationRank`, the height-gate constants, the mirrors, the pin test. | Stage 0's bench now **passes**, for the right reason. The lantern cover goes dark on your scene. |
| **3** | Tokens join both layers. Specular, sun shadows, region darkness, vegetation, water move to the authority. **Delete `buf:scene.attr`** and `scene-attr.js`. | Each effect's live behaviour unchanged or better; the false-colour view explains any diff. |
| **4** | `weather` layer. Slices only if a consumer actually needs one. | β€” |

**Stage 0 exists because a bench that cannot reproduce the known bug cannot prove the fix.** Building it against the current, broken gate first is the only way to know the bench is honest before it is asked to bless anything β€” and it is the specific thing that went wrong three times already ([[feedback_bench_must_build_inputs_like_production]]). Stage 2 is where the live bug dies.

### 9a. What building stage 0 against REAL art found β€” four bugs, all in the bench, none in production

Getting a bench that draws full-canvas real art (rather than the existing synthetic scenarios' smaller geometric "holes") to tell the truth took four rounds, each caught by looking at actual data rather than trusting the first plausible result β€” the same discipline this whole document exists because of, just turned on the bench itself before it was trusted to judge anything:

1. **`material.transparent` copied from the wrong sibling.** The existing synthetic scenarios use `transparent:false` and get away with it because their upper floors are smaller *geometry* β€” a hole is a place nothing was drawn, never a place something transparent was drawn and blended through. Every real item here is a full-canvas quad (matching real Foundry Level art), so the *only* thing that can let a lower floor show through is real alpha blending on `packFloorAttr`'s own blend-driving component β€” which an opaque material never applies; it just overwrites, unconditionally. Result: the entire attr buffer read as Roof (floor 2), literally 100% of texels, because Roof draws last. Fixed: `transparent:true`, matching production's real `buildWholeImageMaterial` β€” this is AGENTS.md Β§10's own scenario-5 trap #3, rediscovered by copying the wrong scenario's setup instead of production's.
2. **A coarse render target couldn't resolve a fine test point.** A calibration point verified robust at the decoded art's own 2662Γ—1237 resolution still read ambiguously once rendered at a coarser 1024-wide target β€” a Β±5-texel window at decode scale is under Β±2 texels once downsampled ~2.6Γ—. Fixed by rendering at (a rounded-up multiple-of-64 version of) the decode resolution directly, removing the mismatch rather than tuning around it.
3. **A single mirrored texel is not a contrast guard.** [[feedback_calibration_needs_a_contrast_guard]] already named the general lesson; this is a sharper instance of it β€” a calibration point's own exact vertical mirror can be genuinely transparent while the column is still ~76% opaque overall, so a real render/decode row-count discrepancy of barely a dozen texels lands the *actual* sampled mirror row back inside a *different* opaque band a few texels away. One coincidentally-clear texel is not a discriminator; a wide band (Β±30 texels) that is uniformly the opposite condition is. `findRealArtRegion`'s `requireVerticalAsymmetry` now checks the band, not the texel.
4. **Co-located test lights under MAX blending.** Three of the five test lights deliberately share one world position (to compare different elevations against the same receiver) β€” sampling a *combined* render at that shared pixel reports the brightest of every overlapping light, so one light's bug (unoccluded, bright) silently drowned out a correctly-dark sibling's own answer at the exact same texel. Fixed by rendering each light in isolation for the numeric checks; a combined render remains for the human-facing artifact only, where overlap is expected and fine to *see*.

None of these were production bugs β€” all four were the bench lying to itself in a new way, exactly the failure mode this whole investigation is about, just caught in minutes each via the false-colour artifact and a targeted column dump instead of surviving to round three.

### 9b. Stage 1's GPU mechanism, proven in `tools/shader-lab/bench-scene-depth.js`

Five scenarios, `window.lab.run('scene-depth', β€¦)`, 21/21 checks green:

1. **`order-independence`** β€” the headline claim. Two full-canvas quads at different ranks, fully overlapping, rendered twice: once submitted low-rank-then-high, once high-then-low. The two renders are **pixel-identical** (0 differing bytes across the whole frame) and the higher rank wins in both. This is the property `vt/scene-attr.js`'s alpha blend never had β€” "who wins" was always a function of draw order there, which is what rounds 7 and 10 of the light-elevation investigation both fought in different ways.
2. **`rank-round-trips-through-the-real-authority`** β€” five items, ranked by the REAL `createDepthAuthority` (not a hand-typed z value), fed in via a deliberately shuffled array. All 5 decode back to their own exact rank through the full write β†’ render β†’ readback path.
3. **`discard-reveals-whats-underneath`** β€” a higher-rank quad with a real alpha hole (step function, not an image) over a lower-rank solid quad. Inside the hole, the lower item shows through **completely unchanged**; outside it, the higher item wins normally; the boundary is never an in-between value. This is `packFloorAttr`'s round-15 failure class β€” a soft edge scaling the whole packed byte β€” made structurally impossible rather than margined around, because nothing here blends.
4. **`real-map-through-the-new-mechanism`** β€” the same tower-bridge assets stage 0 used, drawn through `depthFunc:LessDepth` instead of an alpha-blended MRT write. The resulting per-floor histogram (β‰ˆ27% / 54% / 19% across the three floors) matches stage 0's own, independently-derived histogram on the SAME map almost exactly, and the false-colour picture is visibly the same map β€” the two Tower Bridge towers, the river patches β€” confirming the new mechanism agrees with the old (already-fixed) one on what the correct picture looks like.
5. **`tsl-query-samples-the-real-depth-texture`** β€” the piece none of the first four attempt. Three non-overlapping strips at real ranks; a SECOND material (never the one that wrote the depth attachment) samples it via its own TSL fragment shader at `screenUV` (wherever this fragment is) and at a known `queryUV` (one strip's own centre), and compares the two raw stored depth values directly with ordinary TSL arithmetic β€” no `compareFunction` sampler, no attempt to reconstruct an integer rank from the sampled float. Passed first try, 6/6: the strip below the query reads `isAbove=false`, the query strip reads `isEqual=true` (equal to itself, not "above" itself), the strip above reads `isAbove=true` β€” visible in the saved artifact as three flat, distinct colour bands with no bleed at the boundaries.

**A real polarity bug, found the same way every other one in this document was.** The first attempt used `depthFunc:GreaterDepth` with a reasoned-out justification (this document's own now-corrected text). Scenario 1's first run showed the LOWER rank winning, consistently, regardless of submission order β€” order-independence was already proven, only the winner was backwards. The actual cause: the bench's camera sits at world z=5 looking toward z=0, so a higher rank's world-z (closer to 1) is *closer to the camera* than a lower rank's β€” and under an ordinary depth convention, closer means a *smaller* stored depth value, not larger. `GreaterDepth` was therefore backwards given this camera, not a GPU-backend quirk (`reversedDepthBuffer` was the first, wrong, suspect). Fixed to `LessDepth` + clear-depth `1`; every scenario passed clean on the next run.

**What scenarios 1-4 prove, and what they do NOT.** Proven: writing a rank into `mesh.position.z`, depth-testing it against real drawables, and reading the winner back β€” all end-to-end, on both synthetic fixtures and real art. **Not attempted by any of them: a SEPARATE material sampling the depth attachment via a TSL `texture()`-style node**, the way a future point light's shader would query "what rank is above me here." Every check in scenarios 1-4 reads the depth buffer back through `renderer.readRenderTargetPixelsAsync`, a CPU-side readback, never a GPU shader-side sample β€” and one of those four scenarios turned out to have been reading it WRONG the whole time (see the `depthRaw` note below). This gap is precisely what Β§11's own "sampling a depth32float render-target texture in TSL" risk was about, and it is what scenario 5 closes.

**Scenario 5 β€” `tsl-query-samples-the-real-depth-texture` β€” closes the gap, first try, 6/6 checks green.** Three non-overlapping strips at real ranks (via the REAL `createDepthAuthority`, shuffled input, same discipline as scenario 2): `below`, `query`, `above`. A SECOND material β€” never the one that wrote the depth attachment β€” samples it twice in its own TSL fragment shader: once at `screenUV` (wherever this fragment is) and once at a known, fixed `queryUV` (the `query` strip's own centre), then compares the two **raw stored depth values directly**, with no attempt to convert either back into an integer rank. That last part matters: reverse-engineering what a given rank's stored-depth value "should" be would mean reimplementing `OrthographicCamera`'s own view-to-NDC formula independently in JS, on reasoning alone β€” exactly the confidence Β§9b's own `GreaterDepth` mistake already burned once. Comparing two GPU-sampled values against each other sidesteps that, and still proves the thing that actually matters: a different material CAN read this texture and get a usable, order-preserving answer. Result: `below` reads `isAbove=false, isEqual=false`; `query` reads `isAbove=false, isEqual=true` (equal to itself, correctly not "above" itself); `above` reads `isAbove=true, isEqual=false` β€” the full three-way discriminating pattern, matching the real rank order (`below`=0, `query`=1, `above`=2) exactly, visible in the saved false-colour artifact as three flat, distinct colour bands (deep blue / bright green / magenta) with no bleed at the boundaries.

**A genuine dead-and-wrong CPU readback, found while building scenario 5, fixed the same day.** `renderDepthPass` (the shared helper every scenario in this bench calls) carried a `depthRaw` field, produced by calling `renderer.readRenderTargetPixelsAsync(colorRt, 0, 0, DIM, DIM, 0, undefined, true)` β€” an extra trailing `true`, on the theory that it selected the depth attachment instead of colour. It does not: the actual method signature is `(renderTarget, x, y, width, height, textureIndex=0, faceIndex=0)`, reading `renderTarget.textures[textureIndex]` unconditionally β€” a plain 7-parameter function with no depth-reading mode at all. The 8th argument was silently dropped, so `depthRaw` was a byte-identical SECOND copy of the colour buffer, not depth data. Nothing ever consumed it (a grep across the whole file found zero reads of `.depthRaw`), so it never produced a wrong answer β€” but it document a capability ("this bench can read depth back to the CPU") that never existed, and would have misled the very next attempt to cross-check scenario 5's GPU-side result against a CPU-side depth readback. Removed outright rather than fixed, since scenario 5's own comparison design (sample-vs-sample, never sample-vs-CPU-readback) makes a working CPU depth readback unnecessary for anything this bench currently proves.

**The false-colour view itself went through two misses before it actually showed what it claimed to, both caught by the author looking at the picture rather than at the check output.** First pass packed `floorIndex` into the shade byte β€” a floor's plain background and that SAME floor's own `_Overhead` layer share one `floorIndex`, so the picture rendered them as the identical grey despite being different items at different ranks (*"I can't see separate shades for the overhead layers"*). Second pass packed ordinal rank (`rank/(itemCount-1)`) instead, spread evenly across the full byte range β€” which told the 5 real items apart, but only by "which of the 5 is this": an item authored a long way above its own floor and one authored 1ft above it would still just land on two adjacent, evenly-spaced rank slots, with no relationship to how far apart they actually are (*"give them a different shade based on their elevation so that if they are a long way above the ground they would be treated potentially differently to if they were 1ft above the ground"*).

The landed fix makes the shade byte dominated by each item's own real `key.elevation` (world units), normalised against the min/max elevation actually present in the scene β€” black-to-white now reads as ground-to-sky, not as list position. In the real tower-bridge run this produces exactly the three-floor progression you'd want: Underground's background at byte 0, Middle's at 159, Roof's at 255. The two `_Overhead` layers are not hypothetical edge cases for tie-breaking β€” they are exact elevation ties in this very fixture (Underground's Overhead top, 20, equals Middle's own background bottom, 20; Middle's Overhead top, 40, equals Roof's background bottom, 40, both real floor-to-floor seams), so a reserved headroom breaks ties **locally, among only the siblings that share one exact elevation** (never a global rank fraction, which would dilute the separation across the whole item count instead of concentrating it where it's actually needed), sized against the fixture's own smallest real gap between two *different* elevations so it can never push one elevation's shade past a neighbouring elevation's. The regression check does not stop at counting distinct byte values β€” an earlier version of the fix reached "5 distinct bytes" that were only 6 levels apart out of 255, which is true on paper and invisible on a screen. It now also asserts a minimum gap (β‰₯16/255) between any two neighbouring shades actually present, because a check that passes on a difference no eye can read is [[feedback_smooth_output_hides_ported_bugs]]'s lesson again, just for a visualisation instead of a computation.

---

### 9c. The production module, `src/vt/scene-depth.js` — a real file now, not a plan

Every export is a direct, faithful port of a mechanism Β§9b already proved on a real device β€” never a fresh reinvention written against reasoning alone:

- `describeSceneDepthTarget` β€” the `ThreeAllocator`-shaped descriptor (Β§4's format: `depth32float` + RGBA8 payload, both `screenSized`).
- `rankToDepthZ` β€” `(rank+1)/(maxRank+1)`, byte-for-byte the bench's own formula.
- `computeExpectedStoredDepth` β€” the closed-form conversion from a bare rank (no drawn geometry needed) to the stored-depth value a real drawable at that rank would produce, derived from `THREE.Matrix4#makeOrthographic`'s own WebGPU-coordinate-system branch (`three.webgpu.js:6168-6170`, read before trusting it) for this pass's OWN dedicated camera (`DEPTH_PASS_CAMERA_Z=5, DEPTH_PASS_NEAR=0.01, DEPTH_PASS_FAR=10` β€” the exact numbers `bench-scene-depth.js` already proved, never a second, independently-typed copy). This is the piece that makes a LIGHT's own occlusion query possible at all: a light has no geometry in this pass to sample a reference point from the way scenario 5's strips did, so its own rank has to convert to a comparable depth value on the CPU instead.
- `buildSceneDepthWriterMaterial` / `buildSceneDepthProxyMesh` β€” the depth-test material and the proxy-mesh wrapper, Β§7's "proxy meshes SHARING each item's geometry" taken literally: the mesh helper takes an EXISTING `THREE.BufferGeometry`, never builds one, so wiring this into the live per-item loop later costs no extra geometry allocation.
- `querySceneDepth` β€” scenario 5's own material, generalised: sample the depth texture once at `screenUV`, compare against a plain `expectedDepth` float. No rank-to-depth conversion ever happens on the GPU β€” see the module's own header for why that would mean re-deriving the projection formula inside a shader for no reason.
- `computeSceneDepthFlags` / `resolveSceneDepthFloorIndex` β€” the R/B payload channels (Β§4). G (outdoors) is a named, honest gap: it reads a real `0` (matching `packFloorAttr`'s own safe default), not a fabricated value, because wiring it needs the same `envLight`/`uOutdoorsRect` plumbing `scene-attr.js`'s real writers take and no Stage 1 consumer reads it yet.

**Two structural prerequisites, closed the same session, both because a hard gate said so, not by choice:**

1. **`graph/three-allocator.js` extended** with `desc.depthTexture === true` (+ `desc.depthTextureType`) β€” `describe()`/`create()` now build a real `THREE.DepthTexture`, wired into the target's own `depthTexture` slot, BEFORE the `WebGLRenderTarget` is constructed (three only reads that option at construction, never by later assignment). `DepthTexture`'s own constructor already defaults to `NearestFilter` + `compareFunction:null` (`three.webgpu.js:16297`) β€” exactly what an ordinary, non-shadow-style TSL sample needs, confirmed by reading the backend's own sampler-selection code (`:70613`) before relying on it. New tests in `three-allocator.test.mjs` cover the field's own shape and the real construction.
2. **A genuine rule collision in `tools/verify-structure.mjs`, found and fixed, not routed around.** `gpu/allocator-only` (all `new *RenderTarget(` must live in the allocator) and `gpu/textures-in-vt-only` (all `new *Texture(` must live in `vt/`) never anticipated a texture that is BOTH: a `DepthTexture` has no source image at all (it starts empty, populated by rendering to it) β€” categorically a render-TARGET ATTACHMENT, not the "world-sized art uploaded outside vt/" crisis that second rule's own `why` names. Fixed by narrowing the PATTERN (`(?!DepthTexture\b)`), not by exempting `three-allocator.js` wholesale β€” a future `new DataTexture(...)` landing in that same file, a genuine instance of the thing the rule polices, is still caught. Per `CONVENTIONS.md` Β§7: fix the rule config with a comment, never sprinkle a bypass through the code.

**Genuine reachability, not a symbolic import.** `graph/reachable-from-boot`'s own ratchet failed the instant `scene-depth.js` existed unimported β€” the SAME wall `depth-authority.js`'s CPU half hit earlier this session. The fix follows the SAME doctrine that ratchet's own error message states outright ("wire the file into something boot.js reaches… same session… never left for later"): `vt-pan-viewer.js` gained `runSceneDepthSelfTest()`, built on the EXACT precedent `runOrientationSelfTest()` already set (`diag/orientation-probe.js`'s own header: "real pixels, through the real chain") β€” allocate a real, temporary `depthTexture`-backed target through the (now-extended) allocator, draw three known ranks through the real writer material and this pass's own dedicated camera, then query the result back through the real formula, with the SAME `MapShine.debug.registerAction('scene-depth-self-test', …)` wiring the orientation probe uses. Disposed when done; never touches `sceneColor`, the shared world camera, or anything the live map depends on. Both materials use `fragmentNode` (never `colorNode`), which bypasses the MRT system entirely by construction (`scene-attr.js`'s own documented distinction) β€” no MRT save/restore needed for this pass at all, unlike `runGeometryWorldPass`/`runOrientationSelfTest`'s own `colorNode`-based work.

**What this buys beyond satisfying a ratchet:** the self-test is the FIRST time `computeExpectedStoredDepth`'s formula is checked against a real GPU's actual output using the PRODUCTION module, not a lab-only stand-in β€” rank 0's own drawn strip produces a real stored-depth value that the self-test compares, on every run, against what the formula predicts for rank 0 with zero geometry of its own. Lab-green plus a self-test that has never been clicked in a live session is still `BUILT (unverified)`, not `LIVE` β€” the author running `MapShine.debug` β†’ "Scene-depth self-test" once is what promotes it.

---

### 9d. The CONTINUOUS live pass β€” `vt-pan-viewer.js` now writes `buf:scene.depth` every frame

Author: *"wire it into the live per-frame loop now."* This is the difference between "the module exists and can be exercised on demand" (Β§9c) and "the map's own real draw list produces a real depth buffer every session, whether or not anyone clicks anything."

**Where the real per-item geometry/texture actually live, found by reading, not assumed.** `itemStates` (a `Map<itemId, state>`) is `updateResidencyUnguarded`'s own authoritative per-item table. For every Level background/foreground, tile and token, `state.wholeImage.tiles[]` (built by `ensureWholeImageMeshes`, kept current by `refreshWholeImageItem`) is where the REAL `{tex, geometry, mesh}` triple lives β€” confirmed by reading `ensureWholeImageMeshes`'s own body, not inferred from a comment. `state.geometry`/`state.mesh` themselves are dead fields for these item kinds (a docstring inside the file says so outright: tokens and whole-image art render through the tile path's OWN geometry). This is also EXACTLY the set `depthAuthority.rebuild(items)` already ranks β€” `items` and `itemStates` are built from the SAME source, one residency pass apart.

**The design: rebuild on residency, render every frame β€” never the other way round.** A proxy mesh's geometry is BORROWED (shared with the real tile, per Β§7's own "proxy meshes sharing each item's geometry"), so building one is cheap: no new GPU buffer, just a thin `THREE.Mesh` wrapper and a small `NodeMaterial`. `rebuildSceneDepthProxies(items)` runs once, at the END of `updateResidencyUnguarded` β€” after every item's placement/visibility is already final for this pass β€” and does a WHOLESALE rebuild: dispose every proxy this function built last time, then walk `items` fresh, skip anything without `state.wholeImage.tiles` (vegetation Case 2 overlays, doors, water/fluid β€” none of these are part of `items` either) or without a currently-VISIBLE tile (`t.mesh?.visible` β€” the SAME flag the colour pass just set), and build one proxy per surviving tile. This was a deliberate choice over incrementally tracking add/remove at each of the THREE separate `scene.add(mesh)` call sites `ensureWholeImageMeshes`/tile-building code has β€” `feedback_mode_forks_silently_drop_features` is the standing warning against trusting "I found all of them." A wholesale rebuild can't miss one, because it never remembers what existed before; residency itself already runs on an event-driven cadence (not every frame), so the rebuild cost is paid on the SAME schedule real geometry/texture work already is.

**The render itself is the SIMPLEST part.** `runSceneDepthPass()` β€” set target, clear (colour to 0, depth to 1 β€” this pass's own proven convention), render `depthScene` through `depthCamera`, restore. Called from INSIDE `runGeometryWorldPass()`, right after the existing door-leaves composite call β€” the SAME function already makes more than one `renderer.render()` call into more than one target, so this is one more of the same shape, not a new pattern. No MRT save/restore needed here at all: both this pass's material and the self-test's use `fragmentNode` (never `colorNode`), which bypasses three's MRT system entirely by construction β€” confirmed from `scene-attr.js`'s own header, not assumed by analogy.

**The dedicated camera, wired for real.** `depthCamera` is built once (position, near/far, `lookAt` β€” Β§9c's own `DEPTH_PASS_*` constants), then its X/Y framing is synced EVERY frame inside `updateCamera()` β€” the SAME function that already syncs the shared world camera, from the SAME `computeCameraFrustum(rect)` call, so the two cameras' `screenUV` mappings can never drift apart even though their Z axes are completely independent.

**Three real problems, found and fixed before this landed, not after:**
1. **A genuine rule collision** between `gpu/allocator-only` and `gpu/textures-in-vt-only` over `DepthTexture` β€” see Β§9c, fixed there, holds unchanged here.
2. **`log/one-door`'s ratchet tripped** the instant two `console.error` calls landed in the new code (the disposal path's catch block, and `rebuildSceneDepthProxies`'s `logError` callback) β€” `vt-pan-viewer.js` already owns a scoped `log = createLogger('vt-pan-viewer')`; both calls now use it, and the ratchet's bound (30) never moved.
3. **A genuine variable-shadowing bug, caught on self-review, not by any tool.** The self-test built last round (Β§9c) already declared a LOCAL `const depthCamera` inside its own method body; this round's new PERSISTENT, closure-scoped `depthCamera` (shared by the live pass) landed under the identical name. JS shadowing made this harmless in practice β€” the self-test's own camera never leaked outside its method, and the live pass's camera was never affected β€” but it is exactly the kind of same-name-different-thing confusion this project's own naming discipline exists to prevent, and nothing but re-reading the full diff caught it (ESLint's own config did not flag it). Renamed the self-test's copy to `selfTestCamera`.

**Full project suite: 7360 passed, 0 failed, structure gates at their EXISTING bounds** β€” 9 ratcheted, including `log/one-door`, none of them moved.

**What is deliberately still NOT true, stated so it can't be mistaken for done:** this wiring has not been run against a real Foundry session by the author β€” `npm run verify` proves the code is correct BY EVERY STATIC MEASURE THIS PROJECT HAS, not that the picture on a real scene is right. And even once it is confirmed live, `buf:scene.depth` still has ZERO consumers β€” every existing effect (point lights, specular, sun shadows) still reads the old `buf:scene.attr`/sentinel machinery exactly as before. Stage 2 is deleting that machinery one consumer at a time and proving each migration against the SAME real map, not assuming this pass being correct makes the next step easy.

### 9e. Stage 2, first consumer β€” ordinary Foundry point lights read `buf:scene.depth` now

Author, same session, minutes after Β§9d landed, with a screenshot and a pixel probe: *"Can we finally use this depth buffer to actually do some real work? Like occluding this light that we've been trying to do for days? ... have you actually applied the depth buffer to lighting yet? Fix it."* The probe was first-party proof the old mechanism was still broken exactly where it mattered: at a pixel with real, visible, `meshVisible:true` Ground Floor art AND a `restrictsLight:true` tile directly under it, `buf:scene.attr` read `alpha=0` β€” "nothing drawn here" by this project's own "R can lie, A can't" rule, on a pixel that plainly had something drawn.

**What migrated.** `point-light-illumination.js`/`point-light-coloration.js` β€” an ordinary Foundry light's illumination floor-lift AND its coloured glow, the two materials the "twin materials" bug class ([[feedback_mode_forks_silently_drop_features]]) exists to keep in lockstep. `buildDepthHeightGateNode(TSL, {depthHere, flagsHere, uLightExpectedDepth})` replaces `buildHeightGateNode` for these two call sites ONLY: one `select(storedDepth.lessThan(expected), 0, 1)`, no tolerance, no softness band β€” a real per-item RANK is an exact ordinal, not a lossy quantised byte that needed fuzzing to survive texel noise. `point-light-pool.js`'s `update()` resolves each light's rank fresh every frame through an INJECTED callback, `resolveExpectedDepth(elevation)`, composed in `vt-pan-viewer.js` from `depthAuthority.rankOfElevation(elevation)` + a new `vt/scene-depth.js#computeLightExpectedDepth(rank, maxRank)` β€” injected, not imported, because `effects/lighting/` cannot import `vt/scene-depth.js` without creating the `vt/`↔`effects/` cycle this codebase's layering forbids (the SAME reason `RECEIVER_ELEVATION_LEVELS_MIRROR` was already a duplicate, not an import).

**What did NOT migrate, named on purpose.** Candle-flame and lightning-bolt SPRITES/RIBBONS (`candle-flame-render.js`/`lightning-render.js`) still call the OLD `buildHeightGateNode`, gated by `resolveAnchorElevationRank`'s per-VERTEX-baked rank (`boot.js` β†’ `candle-flame-geometry.js`'s own arrays) β€” a materially different data path (batched mesh, no per-light uniform slot) that this pass did not touch. The LIGHT a candle or a lightning bolt CASTS, however, DOES go through the new mechanism β€” it flows through `point-light-pool.js`'s own shared `update()` loop alongside every ordinary Foundry light, normalized the same way (`light.elevation === undefined` β†’ treated as 0, mirroring the old `resolveLightElevationRank`'s identical guard). `buildHeightGateNode`/`resolveLightElevationRank`/`resolveAnchorElevationRank`/the sentinel/the mirrors are all left completely intact β€” still load-bearing for the sprite/ribbon path, explicitly NOT deleted this round.

**One elevation-blind case rank alone does not subsume, ported forward.** ROUND 9 of the old investigation found that a Tile's own explicit Foundry "Restrict Lighting" flag blocks light regardless of the tile's elevation relative to the light β€” Foundry's own mechanism for it is elevation-BLIND by design. A real ordinal rank captures "is a roof/foreground genuinely above me" for free (no bit needed β€” it was always going to sort higher), but it does NOT capture a same-elevation decorative tile with the flag ticked. `buildDepthHeightGateNode` hard-blocks on `RESTRICTS_LIGHT && IS_TILE`, read from `buf:scene.depth`'s own colour payload (`vt/scene-depth.js#computeSceneDepthFlags`, already written in Β§9c, previously unconsumed) β€” scoped to `IS_TILE` because a Level's own background gets `restrictsLight:true` UNCONDITIONALLY and an unscoped check would black out every light on its own floor.

**Two stale doc claims caught and fixed while building this, neither affecting Β§9a-9d's own correctness:**
1. `computeExpectedStoredDepth`'s own docstring and this file's Β§header both claimed a "scenario 6" empirically verified the CPU-side depth-prediction formula against a real GPU's output. It does not exist β€” `bench-scene-depth.js` has scenarios 1-5 only. The formula is algebra, cross-checked against the vendored `makeOrthographic` source, NOT GPU-verified. Both docstrings now say so plainly, and name themselves as the first suspect if a light's occlusion ever misbehaves.
2. `computeSceneDepthFlags`'s own doc claimed `restrictsWeather` was read through a `kind === 'tile'` ternary. It isn't β€” the real function reads `restrictsLight`/`restrictsWeather` completely unscoped, any kind. Caught by reading the function body, not trusting the comment next to it β€” exactly why the `RESTRICTS_LIGHT && IS_TILE` guard above lives in the CONSUMER, not inside `computeSceneDepthFlags` itself.

**The fail-open tie buffer, a real risk found before it shipped, not after.** The common case for a light's own query is a TIE β€” `depth-authority.js#rankOfElevation`'s whole point is that a torch standing on its own floor's ground resolves to THAT ground's own rank. A bare `computeExpectedStoredDepth` compared with `storedDepth.lessThan(expected)` has no room for ordinary CPU (JS double) vs GPU (float32) rounding noise at that exact tie β€” `bench-scene-depth.js`'s OWN scenario 5 query material already needed an `epsilon` for the identical problem, comparing two GPU-sampled values against EACH OTHER, the easier case. Left unguarded here, a light could read its own floor as "above" it and go dark everywhere, every frame β€” a global blackout, not a corner case. `computeLightExpectedDepth(rank, maxRank)` subtracts a fail-open buffer sized to HALF one rank's own depth-space gap β€” not a flat constant ([[feedback_margin_sized_to_gap_is_self_defeating]]) β€” which is PROVABLY smaller than the gap between any two genuinely different real ranks (the rank→depth map is affine: one rank step always changes stored depth by the identical amount, at any scene size), so it can absorb float noise at a tie but can never merge two distinct items into a false one.

**Full project suite: 7372 passed, 0 failed** (up from Β§9d's 7360 β€” new coverage for `buildDepthHeightGateNode`'s bit arithmetic and `computeLightExpectedDepth`'s tie buffer, both against concrete numeric cases, not just "does it construct"). Structure gates unchanged: 28 rules, 9 ratcheted, none moved.

**What is deliberately still NOT true.** Not run against a real Foundry session β€” the same honest limit Β§9d named, now inherited by this migration too. `computeExpectedStoredDepth`'s formula is still only algebra-verified (the missing "scenario 6" above). Candle/lightning's own sprite/ribbon visuals are unchanged, still on the old mechanism. And the OLD machinery β€” `buildHeightGateNode`, the sentinel, the mirrors, `resolveLightElevationRank` β€” is still fully present in the codebase; Β§9d's own plan ("delete the sentinel, overhead bit, `elevationRank`, the height-gate constants, the mirrors, the pin test") has NOT started, deliberately: it stays load-bearing until candle/lightning migrate too.

### 9f. LIVE-CONFIRMED, and locked as the sole system (2026-08-04, minutes later)

**The author's own words, on the first real test:** *"Very very good news. It's working. Lighting is now correctly occluding."* This is the promotion Β§9e's own "what is deliberately still NOT true" section named as outstanding β€” point-light height/elevation occlusion via `buf:scene.depth` moves from `BUILT (unverified)` to `LIVE`, this project's own two-word distinction ([[keyhole-current-state]]).

**Then, immediately, a mandate:** *"This needs to be the system we use for all effects, it needs to be the only depth system allowed and we need to make sure of that."* Recorded as a locked decision, not just a memory note β€” [[keyhole-depth-authority-sole-system-decision]]. "Make sure of that" is an enforcement instruction, not a documentation one, and this codebase's own standing mechanism for exactly this shape of rule is `tools/verify-structure.mjs` (see its own header: *"A comment cannot fail a build. This file can."*).

**New structure rule, `depth/authority-only`:** bans any NEW call to `buildHeightGateNode` / `resolveLightElevationRank` / `resolveAnchorElevationRank` outside the five files that legitimately still need them β€” the two files that DEFINE them (`point-light-illumination.js`, `point-light-pool.js`) and the three grandfathered consumers (`boot.js`, `candle-flame-render.js`, `lightning-render.js`, all still on the OLD mechanism per Β§9e's own scoping decision). Zero-tolerance, not ratcheted (like `gpu/allocator-only`) β€” there is exactly one legitimate reason to call these three functions today, and it already has a name. Proven both ways in `tools/verify-structure.test.mjs`: a synthetic "what a second effect would have written" snippet is rejected, and `computeHeightGate`/`elevationRank`/the sentinel constant β€” the OLD gate's own pure arithmetic, deliberately NOT banned, still load-bearing for the grandfathered path β€” are confirmed to pass clean. Full suite: 7381 passed, 0 failed.

**What "locked" does and does not mean.** It means: no future effect may invent a second bespoke floor-index/quantization/sentinel scheme the way `buf:scene.attr`'s height gate did. It does NOT mean `buf:scene.attr` itself is dead β€” its other channels (floor index for non-occlusion purposes, outdoors, occludes-background) still have real, undisplaced consumers, and candle/lightning's own sprites still legitimately read its height/elevation bits until THEY migrate too (Stage 2, continued, not Stage 3's full deletion).

**Next planned consumer, named by the author in the same breath:** vegetation. `_Tree` overlays ranked near the TOP of their own floor's band, `_Bush` overlays around the MIDDLE, so vegetation on different floors "automatically layers correctly" against each other and against everything else on `buf:scene.depth`, via the SAME one rank number β€” no more bespoke per-effect layering logic. `VegetationKind#passiveElevationFraction` already encodes this exact shape (1.0 tree, 0.5 bush) for the OLD `buf:scene.attr` consumer ([[keyhole-light-elevation-occlusion]]'s ROUND 5); the new work is giving Case-2 vegetation overlays a synthetic elevation feeding `depthAuthority.rebuild()`'s own `items` list, which Β§9d's `rebuildSceneDepthProxies` currently explicitly excludes.

---

## 10. Decisions — RESOLVED (author, 2026-08-04)

1. **Level foregrounds block light.** ✅ *"Level foregrounds should block light from lights which are below their elevation… you know how when a light is behind an object in real life and you can't magically see through the object?"* Foundry's narrower rule is not followed — [[keyhole-parity-compat-doctrine]], MSA owns the picture. See §3a. This also **forced §3b**: because the author hosts the same `_Overhead` art as a foreground *or* as a tile, tiles at/above their own floor's top must block too, or one picture gets two behaviours depending on an authoring choice unrelated to light.
2. **No slices in v1.** ✅ *"The budget table is only useful if it doesn't prevent development of the module. Don't let it stand in the way."* §5b is deferred to reference-only; §5a's all-floors draw list already delivers "accurate for all floors" and costs nothing.
3. **Tokens block light and write `solid` depth.** ✅ *"tokens have an albedo texture which gives accurate opacity readings. If a token is ABOVE a light source, guess what… the light would be blocked the same way as with everything else."*

One consequence of (1) worth stating before it surprises anyone on first look: **a light on a floor will now be occluded by that floor's own `_Overhead` roof**, everywhere the roof art is opaque. That is correct — you are looking down at a roof — but it is a visible change from today on every scene with a foreground layer, and it is the most likely thing to read as "too dark" at first glance. **The river channel, where the `_Overhead` is transparent, is where you check it is actually working rather than just uniformly dark.**

## 11. Risks, named before building

- βœ… **RESOLVED 2026-08-04 β€” Sampling a `depth32float` render-target texture from a SEPARATE material's own TSL fragment shader.** Three's own shadow maps do exactly this ([`three.webgpu.js:52386`](src/vendor/three/three.webgpu.js:52386)), and Β§9b's scenario 5 now proves it for *our* target, read by a *different* material than the one that wrote it: `texture(depthTexture, screenUV)` and `texture(depthTexture, queryUV)`, compared directly with `.lessThan()`/`abs().lessThan(epsilon)`, no `compareFunction` sampler needed since the query never asks a shadow-map-style "is X closer than Y" hardware question β€” it reads the raw stored float back and compares it in ordinary TSL arithmetic. `DepthTexture`'s own constructor already defaults to `NearestFilter` + no `compareFunction`, which is exactly what a plain (non-comparison) sample needs β€” nothing extra had to be configured. `vt/scene-depth.js`'s own `query()` API can now be built on this directly. The `rgba16float` fallback below is no longer needed for THIS risk, though it may still matter for other reasons (e.g. if `copyTextureToTexture` on depth turns out to be awkward for Β§5b).
- **`copyTextureToTexture` on a depth attachment** in this backend — required by §5b only. Not a v1 problem.
- **The all-floors draw list** costs draws the colour pass does not pay. Measure it in the perf lab before stage 1 ships; the material is trivial and early-Z rejects most of it, but "trivial" is a prediction until it is a measurement ([[feedback_measure_the_output_not_the_equation]]).
- **`discard()` outside `Fn()` is a silent no-op** ([[keyhole-region-discard-noop-bug]]). The alpha test is the load-bearing line in this whole design; if it no-ops, every pixel of every quad's transparent padding becomes a surface and the hole-stack model inverts. §8b pins it.
- **The allocator law** ([`three-allocator.js:81-152`](src/graph/three-allocator.js:81)) requires `screenSized: true` on every target here, and has no `layers` field — only §5b would need one, and adding it must be a deliberate descriptor change, never a bypass. (A DIFFERENT allocator gap — no support for a real, samplable depth TEXTURE at all, as opposed to a plain depth/stencil renderbuffer — was closed 2026-08-04, §9c: `desc.depthTexture`/`desc.depthTextureType`. `layers` remains open; the two are unrelated fields.)
- **Tile elevation is an overloaded field** (§3b). Rule (2) — "a tile at/above its own floor's `elevation.top` is overhead" — is the piece most likely to misfire on a real scene, because it depends on a band lookup and the author's own numbers. If it turns out to catch tiles it shouldn't, the fallback is rule (1) alone plus asking you to tick the boxes on `_Overhead` tiles. That is a worse authoring experience, not a broken model, so it is a safe retreat.
- **Assembling the fixture is not free.** The tower-bridge art is 10,650 × 4,950 per layer and five layers deep; the fixture's own header measures a full-scale `rgb` load at 211 MB *plus* a transient 211 MB. The bench must run at `EXPLORE_SCALE` (0.25) by default and state the scale in its report, exactly as the ingest scenarios already do. A depth bench that quietly runs at 1/16 the texel count while reporting like a production run would be [[feedback_instruments_must_not_lie]] in a new costume.

---

## 12. What this is not

It is not a Z-buffer for perspective geometry; there is no perspective ([[keyhole-orthographic-hole-stack-model]]). It is not a replacement for the mask authority — masks answer "what did the author paint here", depth answers "what is on top here". It is not a soft-shadow or a visibility system. And it does not, on its own, make any effect correct — it makes every effect **ask the same question of the same authority**, so that when one of them is wrong, it is wrong once, in one place, visibly.
