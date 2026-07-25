# THE ENGINE POSTMORTEM — V2's architecture blunders, measured

**Status:** RESEARCH, authored 2026-07-16 from a direct audit of `legacy/` at the author's direction (_"find the most critical focal points of the previous module and go through them looking for high level architecture blunders when building a rendering engine"_).
**Companion:** `Effects-API.md` audits the **effects** layer (the contract). **This** audits the **engine** layer — the render loop, the renderer, the Foundry bridge, resource lifetime. Memory: `v2-postmortem-the-failure-modes` carries the distilled version.
**Scale:** `legacy/` is **376,355 lines** of non-vendor JavaScript across 435 files.
**⏱️ AND IT WAS BUILT IN UNDER SIX MONTHS** (author, 2026-07-16; git: first commit `2025-11-17`) — **~2,000 lines/day, sustained, solo.** This is the single most important number in the document and it inverts the reading: nothing here _rotted_. It was laid down at extraordinary speed. **The good abstractions did not lose over years; they lost in MONTHS.** Structure does not lose to laziness — it loses to VELOCITY, because at 2,000 lines/day there is no afternoon in which the correct-but-harder path is affordable. Read every finding below as the signature of speed, not neglect.

---

## 0. The focal points

Size is not sin, but size marks where the pressure went. The largest things in V2:

| Lines      | File                                    | What it says                                       |
| ---------- | --------------------------------------- | -------------------------------------------------- |
| **12,771** | `scene/token-movement-manager.js`       | _moving a token_ is the biggest file in the module |
| **12,573** | `foundry/canvas-replacement.js`         | the Foundry bridge                                 |
| 11,777     | `particles/WeatherParticles.js`         | one effect family                                  |
| 11,157     | `ui/tweakpane-manager.js`               | the panels                                         |
| **10,063** | `compositor-v2/FloorCompositor.js`      | the god-object                                     |
| 8,955      | `scene/interaction-manager.js`          | input                                              |
| 6,861      | `compositor-v2/effects/FireEffectV2.js` | one effect                                         |
| 6,421      | `scene/tile-manager.js`                 | tiles                                              |
| 4,959      | `masks/GpuSceneMaskCompositor.js`       | the world-res mask bakes                           |
| 4,574      | `foundry/pixi-content-layer-bridge.js`  | the GPU→CPU readback bridge                        |
| 4,083      | `compositor-v2/FloorRenderBus.js`       | floor plumbing                                     |

**`token-movement-manager.js` at 12,771 lines is the single loudest signal in the table.** Moving a token is not a hard problem. It is 12,771 lines because _movement_ had to reconcile Foundry's authority, PIXI's rendering, Three's rendering, floor levels, vision, and interaction — with no contract between any of them. **The size is not the bug; it is the bug's shadow.**

---

## 1. 🔴 THE ROOT BLUNDER — two renderers, both live, both authoritative

Everything else in this document is downstream of this one decision, and V2 states it plainly in its own docstring (`core/frame-coordinator.js`):

> _"This module solves the **fundamental problem of having two render systems that need to stay synchronized**. Without coordination, Three.js may render a frame using **stale Foundry data** (vision masks, fog textures, token positions) because PIXI hasn't finished its update pass yet... **Forces PIXI to flush any pending renders before Three.js samples textures.**"_

Three modules exist for **nothing but making two renderers agree**:

| Lines     | Module                      | Job                                                                         |
| --------- | --------------------------- | --------------------------------------------------------------------------- |
| 974       | `core/render-loop.js`       | pacing + strict-sync hold flags                                             |
| 572       | `core/frame-coordinator.js` | hook PIXI's ticker, flush PIXI, sync phases                                 |
| 292       | `core/frame-state.js`       | _"Prevents desync between PIXI and Three.js during rapid camera movements"_ |
| **1,838** |                             | **and they still did not work**                                             |

That last clause is not rhetorical. From `render-loop.js`:

```js
const STRICT_HOLD_MAX_MS = 250;
// "Without this cap, a stale flag would starve the compositor
//  and freeze the scene indefinitely."
```

**A band-aid on a band-aid.** A sync flag that can deadlock the renderer, so a timeout forcibly breaks it after 250 ms. And the frame is gated by mutable booleans — `_forceNextRender`, `_isStrictSyncEnabled`, `_strictHoldState`, `_isCinematicPresentationActive`, `_isPresentationPacingEnabled`, `_isTimeCriticalPlaybackActive` — among **50 distinct private fields** in the render loop alone. The frame is not a pipeline. It is a **negotiation between mutually-suspicious flags**, with a deadlock-breaker bolted on.

**And it forces a PIXI flush every frame** so Three can sample PIXI's textures. That is a synchronisation point per frame, forever, by design.

> **The blunder: two sources of truth for one picture.** Every line of those 1,838 is a correct, competent attempt to reconcile something that should never have needed reconciling.

**Keyhole's answer, and note it was reached from the OTHER end today:** `keyhole-input-model-decision` (2026-07-16) — _"a second camera is a second source of truth."_ MSA renders; Foundry owns documents, simulation and input; **MSA MIRRORS `canvas.stage` rather than owning a camera.** One source of truth, read not owned. The 1,838 lines do not get refactored — **they cease to have a subject.** Keyhole §4.3's proxy-texture severance is the same move applied to textures: Foundry never decodes the real file, so there is nothing to keep in sync.

---

## 2. 🔴 THE ADAPTER EXISTED AND LOST — the same failure, twice

`v2-postmortem-the-failure-modes` §1 records that `EffectComposer`'s correct layer model lost to `FloorCompositor` (5 importers vs 92). **It happened a second time, independently, at the engine layer.**

`legacy/foundry/` is the designated Foundry adapter. Keyhole §9 risk 1 says _"all Foundry touchpoints isolated in `src/foundry/`, version-gated, fail loud."_ **V2 intended exactly the same thing.**

|                                                                 | count   |
| --------------------------------------------------------------- | ------- |
| Files touching Foundry globals (`canvas.` / `game.` / `Hooks.`) | **128** |
| ...of which are in the adapter (`legacy/foundry/`)              | **21**  |
| **Adapter coverage of its own job**                             | **16%** |

**107 files reach around the adapter.** Plus, module-wide:

- **224** `Hooks.on/once` call sites across **79 distinct hooks**
- **98** direct `.prototype.x =` monkey-patches of Foundry internals — against only **2** `libWrapper` registrations

98 unguarded prototype patches is a **Foundry-drift bomb**: any v14→v15 change to any of those internals breaks the module, silently, at a call site nobody remembers writing. This is §9 risk 1 — and V2 shows the mitigation (_"isolate in the adapter"_) is worthless as an intention. It has to be **enforced**, exactly like the `src/` → `legacy/` import fence.

> **Two independent proofs, same shape:** the right structure existed, was optional, and lost. **This is not a coincidence — it is the mechanism.** Optional structure always loses, because bypassing it is always cheaper _today_.

---

## 3. 🔴 NOBODY OWNS THE RENDERER

|                                                    | count        |
| -------------------------------------------------- | ------------ |
| `renderer.setRenderTarget(...)` call sites         | **452**      |
| ...spread across                                   | **60 files** |
| `renderer.clear()`                                 | 113          |
| `autoClear` touches (a **global mutable boolean**) | **262**      |
| `setViewport` / `setScissor`                       | 32           |

**Sixty modules independently driving global renderer state.** Every one must save what it changes and restore it; any one that forgets leaks into whatever renders next. 262 `autoClear` mutations means sixty modules are flipping a global flag and hoping about ordering.

This is the bug class that produces _"it works unless you enable bloom, then shadows break"_ — and it is unfixable at the call site, because the call site is not wrong. **The architecture is wrong: renderer state has 60 owners, i.e. none.**

**Keyhole's answer:** the frame graph is the **only** thing that touches the renderer. A pass declares `reads`/`writes` and receives a target; it never calls `setRenderTarget`, never touches `autoClear`, never clears. Same enforcement-by-absence as the effect contract (`Effects-API.md` §5): a pass cannot leak renderer state because it is never handed the renderer.

---

## 4. 🔴 THE GPU USED AS A DATA STRUCTURE — sync points everywhere

| Pattern                               | Sites  | Cost                                                              |
| ------------------------------------- | ------ | ----------------------------------------------------------------- |
| `getImageData`                        | **46** | CPU decode + heap spike (the 8250² one = **260 MB + 550–850 ms**) |
| `readRenderTargetPixels`              | **41** | **full GPU→CPU pipeline stall, each**                             |
| `createImageBitmap`                   | 33     | decode                                                            |
| `extract.canvas/pixels/base64` (PIXI) | 18     | stall + allocation                                                |
| `toDataURL`                           | 9      | stall + encode                                                    |
| `readPixels`                          | 8      | stall                                                             |
| `gl.finish()`                         | 7      | **the nuclear stall** — drain everything                          |

The worst example, `scene/physics-rope-manager.js:657`:

```js
const renderer = window.MapShine?.effectComposer?.renderer;   // reach through a global
...
renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);        // ← ONE PIXEL
```

**A full GPU pipeline stall to fetch four bytes**, via a global, to answer a question the CPU could have known. This is the defining engine anti-pattern: **treating the GPU as a queryable data structure instead of a write-only pipe.** The GPU is deep-pipelined; asking it anything costs you the whole pipeline.

**Keyhole's answer** (§4.1): **per-page CPU extraction at decode time.** Any CPU consumer of mask pixels registers an extractor that runs _in the decode worker_, on 248² pages, accumulating world-space results as pages stream. The data is on the CPU _before_ anyone asks. The giant `getImageData` and the readback-to-ask-a-question class become **unrepresentable**, not discouraged. `pixi-content-layer-bridge.js` (4,574 lines) and its `extract.canvas` readbacks are on the kill list (§7) — **deleted, not optimised.**

---

## 5. 🟠 117 UNIFORM-GATED SHADER BRANCHES — Law 4, violated at scale

`uHasAboveOverheadLight`, `uHasBelowWaterMask`, `uHasActiveFloorAlpha`, `uEnable*`, `uUse*` — **117 distinct uniform-gated branches.**

This is precisely the anti-pattern `Effects.md` Law 4 bans (_"gating by uniform is NOT gating"_), and its presence 117 times over is what makes that law worth having. Each one is a feature "turned off" by setting a uniform to zero — which **still executes, still binds its textures, still occupies registers.** The shader compiled for the worst case and every user paid for it, on every pixel, forever.

That law was derived this afternoon from a _single_ live bug (the occlusion block running at `weights [0,0,0,0]`, black-screening the map). **V2 proves it is not an edge case — it is the default thing a person does**, 117 times, because it is the easiest way to make a feature optional. **Which is exactly why the tier ladder must be a JS `if` at graph-build time**, and why the test is mechanical: _if turning it off does not shrink the compiled shader, it is not off._

---

## 6. 🟠 LIFETIME IS A PER-CALL-SITE CONCERN

|                               | count   |
| ----------------------------- | ------- |
| `new THREE.WebGLRenderTarget` | 109     |
| `new THREE.*Texture(`         | 75      |
| `new THREE.*Material(`        | 324     |
| **`.dispose()`**              | **981** |

981 hand-written disposals is not a leak signature — it is _more_ disposal than creation, which means **defensive disposal**: nobody is sure who owns a resource, so everybody disposes, from several places, guarded. That is the same disease as `?.setOutdoorsMask?.()` — **uncertainty about ownership, papered over with defensive code.**

**Keyhole's answer:** nothing allocates a render target. The graph owns lifetime, pools by lifetime, aliases where lifetimes do not overlap, and frees. `dispose()` stops being a thing effects do.

---

## 7. ✅ WHAT V2 GOT RIGHT — measured, not charity

The audit must be honest or it is just contempt, and two results genuinely surprised me:

- **GC discipline in the hot path was GOOD.** 627 `new THREE.Vector2/3` across the module, but **only 3** inside effect `update`/`render` bodies. Someone knew not to allocate per-frame and held that line across 97k lines of effects. Keep this.
- **Zero shader recompiles in the hot path.** 488 `needsUpdate = true` sites, **0** inside effect update/render. Recompiles happen at setup, where they belong.
- **`FrameState`'s instinct was right.** _"A single authoritative source of truth for camera/view bounds per frame"_ — a per-frame immutable snapshot is exactly the correct pattern. It only existed to paper over the two-renderer blunder; **the pattern survives into Keyhole, the reason for it does not.**
- **`EffectComposer`'s layer model** was correct (see `Effects-API.md` §3).
- **The crash reporter earned its keep** and is harvested wholesale.

---

## 7B. ROUND FOUR — the bridge, the mask baker, the input fork (completing the accounting)

### canvas-replacement.js (12,573 lines) — the adapter that imports the product

- **A layering INVERSION:** the Foundry bridge imports concrete effect classes (`SpecularEffectV2`, `CandleFlamesEffectV2`, `LightningEffectV2`, …). The lowest-level integration file knows the highest-level product features by name. Arrows point every direction; there is no "down".
- **249 empty catches in this ONE file** (~10% of the module's 2,670), **60 setTimeouts**, and only **2 version-gating checks** in 12.5k lines of Foundry integration — the drift bomb, unguarded at its epicentre.
- **Suppression by per-object flag-fiddling:** Foundry's rendering is suppressed by manually flipping `renderable`/`visible` on individual drawings, shapes, text and frames — each of which must later be perfectly restored. "Who owns visibility?" answered with _everyone_ — the no-owner disease again, applied to Foundry's scene graph.

### GpuSceneMaskCompositor.js (4,959 lines) — the crash, in miniature, self-described

Its own docstring is the whole indictment: _"One WebGLRenderTarget per mask type… Per-floor render target cache with LRU eviction (max 8 floors)… CPU readback via getCpuPixels() for particle spawn point scanning… Falls back to the CPU SceneMaskCompositor"_. That is: **world-res × mask-types × 8 floors of cached RTs, a synchronous readback API as a _feature_, and a complete second CPU implementation of the same thing** (two paths for one behaviour — doctrine #1's origin story). 127 cache/prewarm/sweep mentions: cache management as a lifestyle. **Under Keyhole this entire machine, its CPU twin, its floor cache and its readback are replaced by `vtSample()`** — the cleanest illustration in the codebase of "fix the cost model, delete the machine." Its real product knowledge (per-mask blend modes, the lighten/`max(r,g,b)` convention, `MASK_MAX_SIZE` history) is extracted at Stage 4 per the harvest manifest.

### interaction-manager.js (8,955 lines) — the price tag of the fork not taken

_"Replaces Foundry's canvas interaction layer for THREE.js."_ Nine thousand lines re-implementing selection, dragging and deletion — importing an effect class to draw its selection box. **This file is what the input-model decision (`keyhole-input-model-decision`: Foundry owns ALL input) saved us from writing again.** The decision was made from a bug; this is its cost-benefit validated by corpse.

## 8. THE SYNTHESIS — what actually killed it

Every blunder above is **downstream of two decisions**, and neither was crazy at the time:

```
DECISION 1: run two renderers, both authoritative
  → PIXI and Three must agree → 1,838 lines of sync → per-frame PIXI flush
  → still desyncs → strict-sync flags → deadlock → a 250ms deadlock-breaker
  → Three must READ what PIXI knows → readbacks, extract.canvas, getImageData
  → the GPU becomes a data structure → sync points everywhere
  → token movement must satisfy both → 12,771 lines

DECISION 2: make structure optional
  → EffectComposer loses to FloorCompositor (5 vs 92 importers)
  → the Foundry adapter loses to direct access (21 of 128 files)
  → no contract → caller must know every effect → 643 touch points
  → no owner for renderer state → 452 setRenderTarget across 60 files
  → no owner for lifetime → 981 defensive disposals
  → no way to declare an output → 70 private world-res RTs → the VRAM death
```

**Neither decision was made by a fool, and neither looked like a mistake on the day.** Decision 1 is what you do when you want Foundry's ecosystem _and_ real rendering. Decision 2 is what happens when nobody makes conformance mandatory — which is the default state of every codebase.

### The three questions this audit adds to the list

`v2-postmortem-the-failure-modes` §4 has five. These are the engine-specific ones:

6. **Is there exactly ONE source of truth for this?** Two renderers, two cameras, two ideas of "the view" — each one costs thousands of lines of reconciliation that never fully works. _If you are writing sync code, you have already lost; go delete a source of truth instead._
7. **Am I asking the GPU a question?** Every readback is a stall. If the CPU needs to know it, compute it on the CPU, at decode time, before anyone asks.
8. **Who owns this?** Renderer state, resource lifetime, the frame's truth. If the answer is "everyone, carefully" the answer is **nobody**, and it will leak. Name one owner, and make it the only one that _can_.

---

_Two renderers. Optional structure. Everything else is a consequence._
