# Forward+ — Rendering Architecture Refactor

**Status:** Research document — diagnosis verified against source (2026-07-09). Target architecture in §14, staged plan of attack in §15. Not yet broken into file-level implementation tasks.
**Scope:** A large, multi-month refactor of the compositor, mask, lighting, water, and PIXI-bridge subsystems. This is the living design record; expand each phase into its own task list as work starts. Line numbers cited below are pointers verified on 2026-07-09 and will drift as code changes.

> **Author's framing (2026-07):** The module in its current form is *not reliable, not safe to run* on constrained hardware and needs a considerable rethink. Tile streaming was attempted to beat the VRAM problem and was not enough. This document is the honest account of *where all the problems actually lie* before any rebuild starts — including the parts of the earlier "just do what game engines do" advice that don't survive contact with MSA's real constraints.

---

## 1. The problem, in one sentence

Map Shine Advanced (MSA) bounds GPU/CPU memory to **world size × per-floor mask count**, where a modern real-time engine bounds it to **screen resolution**. The mismatch isn't raw scene complexity — it's that MSA's cost model scales with the size and authored-mask density of the *world*, not the size of the *view*.

### 1.1 The correction to the crash report's numbers

The [Mansion investigation](../Mansion-Multifloor-WebGL-Load-Investigation.md) reports "~11 multifloor bands." **That count is misleading.** `FloorStack.rebuildFloors()` ([FloorStack.js:131](../../scripts/scene/FloorStack.js)) maps Foundry `scene.levels` **1:1** to floor bands. The Mansion is actually **2 Levels** (ground + upper), each with an **overhead layer**. The dominant cost is therefore **not floor count** — it's:

> **per-floor × (up to 15 authored mask types) × up to 12000×12000 px**, plus a stack of ~48 full-screen effect passes, many holding their own render-target sets.

A concrete worst case from the author: a 12000² map where each of 2 floors carries `_Outdoors`, `_Specular`, `_Bush`, `_Tree` (and the ground floor's overhead) as separate 12000² textures. Smaller maps (8250²) may instead carry `_Fire`, `_Shadow`, etc. across up to 3 floors. Either way the multiplier is **mask-types × floors × world-resolution**, and that is what exhausts an 8 GB card.

### 1.2 The case study

[Mansion-Multifloor-WebGL-Load-Investigation.md](../Mansion-Multifloor-WebGL-Load-Investigation.md):
- 12000×12000 (144 MP), 2 Levels + overheads, 20 lights, 1002 walls.
- Fails to load on an RTX 3070 (8 GB) with repeated `webglcontextlost` during **load** (not steady-state); loads on a 16 GB desktop GPU.
- `primaryLeakId: "none"` — **not a leak**; it's peak-VRAM/work spikes during load.
- Existing mitigations (800×450 safe-mode, pinned 8 GB preset, load-slim deferring 13 effects, streaming inflight caps) reduce but do **not** eliminate the crash. Latest crash (Stage D) is at `initializeUI` ~60 s with a **2146 MB JS heap** — abnormally high, implicating the PIXI bridge (§4.3).

---

## 2. Verified system inventory (the real surface area)

Numbers below are from the current source, not estimates.

### 2.1 The mask system — the primary VRAM driver
[mask-catalog.js](../../scripts/masks/mask-catalog.js) declares **15 authored per-floor masks** + **2 derived**:

| Kind | Masks |
|------|-------|
| **Authored painted textures** (13) | `_Specular`, `_Roughness`, `_Normal`, `_Water`, `_Fire`, `_Windows`, `_Structural`, `_Iridescence`, `_Prism`, `_Tree`, `_Bush`, `_Fluid`, `_Dust`, `_Ash` |
| **Authored, geometry-semantic** (1) | `_Outdoors` (indoor/outdoor area) |
| **Derived at runtime** (2) | `floorAlpha` (from tile albedo alpha), `skyReach` (`outdoors ∧ ¬upperFloorAlphas`) |

- Baked **world-space** by [GpuSceneMaskCompositor.js](../../scripts/masks/GpuSceneMaskCompositor.js), capped at `HIGH_DETAIL_DATA_MAX = 8192` / `VISUAL_MAX = 8192` / `SCALAR_MASK_MAX = 4096` ([lines 74–85](../../scripts/masks/GpuSceneMaskCompositor.js)).
- Mask RTs are already `UnsignedByteType` RGBA (`_createRenderTarget`, line 3800) — **4 bytes/px**. At 8192² that's **256 MB per mask**. The code comment at line 3759 states this plainly: *"on a 12000px scene meant ~256MB per mask × many floors/variants = multi-GB VRAM blowout."*
- Partially mitigated: `_highDetailMaskTarget()` (line 3767) now scales data-mask resolution by the budget policy (floor of 0.18×), and `_floorCache` (line 392) has LRU eviction (`_maxCachedFloors`) + `evictDistantFloorCaches()` (line 3830). These bound *retention*, not *per-floor authored footprint*.
- **Critical:** masks are **not streamed** (see §2.4). They are the untamed cost.

### 2.2 The compositor RT stack
- [LevelRenderTargetPool.js](../../scripts/compositor-v2/LevelRenderTargetPool.js) allocates `{ sceneRT, postA, postB }` **per visible level** (`acquire`, line 54); `releaseStale(activeLevels)` (line 151) frees non-visible levels. Type is caller-supplied (`HalfFloatType` or `UnsignedByteType`). Peak cost scales with **simultaneously-visible** floors, which for stacked/see-through views is all of them.
- [FloorCompositor.js](../../scripts/compositor-v2/FloorCompositor.js) (~10k lines) drives `_renderPerLevelPipeline` (line 8985) and blends bottom→top via `LevelCompositePass` (line 834).

### 2.3 The effect roster — ~48 V2 effects, each with private RTs
`scripts/compositor-v2/effects/` holds **~48 `*EffectV2` classes** totaling ~104k lines. The largest: `FireEffectV2` (6861), `LightingEffectV2` (5891), `WaterEffectV2` (5174), `PlayerLightEffectV2` (5029), `FogOfWarEffectV2` (4083), `WaterSplashesEffectV2` (3854), `WindowLightEffectV2` (3667), `CandleFlamesEffectV2` (3570), `OverheadStampEffectV2` (3216). Many hold **multiple full-screen RTs** (`OverheadStampEffectV2` has ~35 RenderTarget references; the crash report counts ~19 live full-screen RGBA8 targets from it alone). The level RT pool is only *part* of the compositor's VRAM — the effect stack is the rest, and per-floor effects multiply it.
- `LightingEffectV2` keeps **per-floor HalfFloat light snapshots**: `_perFloorLightSnapshotRts` (line 483) + `_perFloorGameplayLightSnapshotRts` (line 498), populated in `_snapshotLightRtForFloor` (line 1684).

### 2.4 Streaming — covers images, not masks
[tile-streaming-manager.js](../../scripts/streaming/tile-streaming-manager.js) streams only **background/foreground album images** (grid keys `__bg_image__` / `__fg_image__`, lines 27–34) via a pyramid + IndexedDB + worker decode pool. It has real machinery (pan detection, inflight caps `GLOBAL_INFLIGHT_CAP_HUGE = 10`, floor-transition pauses). **But the 15 masks and the effect RT stacks are not streamed at all.** This is the core reason "tile streaming wasn't enough": it virtualized the cheap, already-tileable part (flat album images) and left the expensive part (world-space masks × floors × effects) fully resident.

### 2.5 The PIXI bridge
[pixi-content-layer-bridge.js](../../scripts/foundry/pixi-content-layer-bridge.js) (4575 lines) mirrors Foundry's PIXI canvas into Three.js via `renderer.extract.canvas(...)` GPU→CPU readback — **8 call sites** plus offscreen render-then-extract paths (lines 4250–4276, 4370–4378). Gated by a `_dirty` flag + throttle (`update(frameId)`, line 3411), so not literally every frame — but the **initial full-layer capture is on the load critical path**, and drawing/template/UI edits retrigger readbacks. Prime suspect for the 2146 MB JS-heap spike.

---

## 3. Root causes (four flaws)

MSA is a **Photoshop-style compositor** (full-screen RTs stacked and alpha-blended per floor) rather than a **game-engine renderer** (geometry drawn into one depth-tested buffer). The four flaws:

1. **Per-floor render-target stacks** (§2.2) — framebuffer VRAM scales with visible-floor count. Real but *secondary* to masks for the 2-floor Mansion.
2. **World-space authored masks** (§2.1) — the dominant cost. 13 painted + 1 semantic mask, each up to 256 MB, per floor, fully resident, unstreamed.
3. **PIXI→Three GPU readback** (§2.5) — `extract.canvas` round-trips GPU→CPU→GPU; drives the JS-heap spike.
4. **World-scaled eager loading** (§2.4) — masks/effects load wholesale; concurrent floor init spikes uploads into `webglcontextlost` before UI finishes.

---

## 4. Hard architectural constraints (what the earlier advice missed)

The pasted "do what modern engines do" analysis is directionally right but collides with three MSA-specific realities. **These constraints must shape every phase below.**

### 4.1 Most masks are painted textures, not polygon data — *screen-space vector masks mostly don't apply*
The earlier plan proposed replacing world-space masks with screen-space rasterized **polygon** masks. But 13 of 15 masks (`_Specular`, `_Water`, `_Fire`, `_Tree`, `_Bush`, `_Normal`, `_Roughness`, `_Iridescence`, ...) are **authored painted PNGs** with per-pixel artistic detail — there is no polygon to rasterize. Only `_Outdoors` (and its derivatives `skyReach`/`floorAlpha`) are area-semantic enough to *maybe* become vector/SDF data. **Therefore the real fix for painted masks is tiling + streaming + (deferred) compression, not screen-space rasterization.** This is the single biggest correction to the original plan.

### 4.2 Water on a lower floor must render — and simulate — visible through gaps in the floor above
The defining hard case (author's "wooden-plank prison over a raging river"): standing on the upper floor, the river **below** must be visible and correctly simulated through the plank gaps, occluded by the planks themselves. The code already implements this with real machinery:
- `_resolveWaterSourceFloorForView(viewedFloorIndex)` ([FloorCompositor.js:8303](../../scripts/compositor-v2/FloorCompositor.js)) scans floors `0..viewed` and picks the highest *lower* floor that has water data.
- Screen-space occluders bind the deck/slice/overhead masks so the lower water is punched by the upper deck: `_frameSplashUpperOccluderTexByFloor`, `_frameWaterSourceDeckTex`, `_frameWaterSourceSliceTex`, `tOverheadRoofBlock`, `tSliceAlpha` ([water-screen-occlusion.js](../../scripts/compositor-v2/effects/water-screen-occlusion.js), `resolveSplashOcclusionBindings`).

**Implications:**
- **Hi-Z / opaque inter-floor culling is fundamentally unsafe here.** You cannot cull or early-Z-discard the lower floor when the upper floor has holes the water shows through. This *kills* the earlier "Hi-Z culling is the holy grail" idea as a general strategy — it's only valid for *fully opaque* upper floors, which the plank case violates by definition.
- **A naive single-depth-buffer unified pass (Phase 1) must still reproduce this cross-floor visibility + occlusion**, including running the water *simulation* for an off-view floor. Depth testing alone doesn't give you "simulate the thing below and show it through a hole with the correct occluder" — that's a compositing relationship, not a depth relationship. Phase 1 has to keep an explicit lower-floor-visible-through-upper path.

### 4.3 The PIXI bridge can't just be deleted — Foundry owns tokens, templates, drawings, walls, fog, UI
Foundry's interaction model (token drag, template preview, wall editing, vision/fog, HUD) lives in PIXI. The bridge exists so Three.js can composite that content at the right depth. Replacing `extract.canvas` with **native Three.js geometry synced from Foundry documents** (the right fix) is a per-document-type reimplementation (tokens, drawings, templates, measured walls, fog) — large, and some layers (dynamic UI chrome) are better left as a DOM/CSS overlay than reproduced. This is why Phase 5 is big and can't be a single deletion.

---

## 5. Already shipped mitigations (don't re-litigate)

These are load-bearing band-aids on the `O(floors × masks × world)` cost model. The refactor builds on them; it doesn't replace them.
- [texture-budget-policy.js](../../scripts/streaming/texture-budget-policy.js) — `resolveMaxDrawingBufferMp`, `resolveCompositorRtBudgetMB`, `RT_MB_PER_DRAWING_BUFFER_MP_BASE` drive a VRAM-tier drawing-buffer cap.
- [graphics-settings-manager.js](../../scripts/ui/graphics-settings-manager.js) — `_applyVramPixelRatioCap` (~3.5 MP / ~1440p ceiling on 8 GB).
- [load-slim-compositor.js](../../scripts/compositor-v2/load-slim-compositor.js) — defers 13 heavy effects during load; forces UnsignedByte compositor RTs during load.
- Mask budget scaling (`_highDetailMaskTarget`), `_floorCache` LRU + `evictDistantFloorCaches`, `LevelRenderTargetPool.releaseStale`, streaming inflight caps, `webgl-crash-recovery.js` safe-mode escalation.

**Framing:** all of the above tune *resolution* and *retention*. The refactor changes the *cost model* so it stops scaling with world size and floor count.

---

## 6. Target architecture (revised for the §4 constraints)

Ordered by impact-to-risk. Numbering is stable for cross-referencing task lists.

### Phase 1 — Unified depth-layered rendering (reduce per-floor RTs)
Replace the per-level RT pool + bottom→top `LevelCompositePass` with a single screen-sized framebuffer where floors get real Z (floor *n* → Z = 100n) and the hardware depth buffer resolves occlusion; upper-floor holes use `alphaTest`/`discard`.
> **Research update (§12):** the tile/token **albedo is already unified** (`FloorRenderBus` Z-orders by floor). The per-floor RT stack exists only for **screen-space lighting/water/shadow passes**, so Phase 1 **cannot be separated from Phase 4** — collapsing the stack requires forward per-fragment lighting. Treat Phase 1+4 as one "unified forward pipeline" workstream. Full effect-by-effect classification in §12.
**Must preserve (§4.2, §12.3 Class D):** the lower-floor-water-visible-through-upper-deck path. Phase 1 keeps an explicit "render + simulate lower water floor, composite through deck occluder" branch — this does not fall out of depth testing for free.
**Also fold in:** `BatchedMesh` for static tiles/walls/map-points (draw-call reduction; same code surface).
**Expected effect:** framebuffer VRAM `O(floors)` → `O(1)` for the *opaque* case; biggest single lever after masks.
**Touches:** `FloorCompositor.js`, `LevelRenderTargetPool.js`, `LevelCompositePass.js`, `FloorRenderBus.js`, `LayerOrderPolicy.js`, every per-floor effect.

### Phase 2 — Mask virtualization: tile + stream the painted masks *(highest structural value, given §4.1)*
This is the **real answer to the dominant cost**, and it replaces the original plan's "screen-space vector masks" for the 13 painted masks. Extend the existing tile-pyramid/IndexedDB/worker streaming (§2.4) — which today only covers `__bg_image__`/`__fg_image__` — to cover **per-floor authored masks**. Page mask tiles by view frustum into a fixed VRAM budget with LRU eviction and a low-res whole-floor fallback, exactly as the album images already do.
**Prerequisite:** a preprocessing/export step that builds tiled pyramids per floor per mask (the author's own recommendation). Channel-packing (§8) rides on top: `_Fire` etc. are single-channel and can share an RGBA atlas.
**Expected effect:** mask VRAM decouples from map size → the single biggest crash-cause on the Mansion scene goes away.
**Touches:** `GpuSceneMaskCompositor.js`, `scripts/streaming/*` (pyramid builder, tile decode, budget), `mask-channel-pack.js`, mask authoring/export pipeline.
**Note — full Sparse Virtual Texturing (page-table indirection shader, the id-Tech MegaTexture approach) is the stretch end of this phase**; start with per-mask frustum tiling (same pattern as album images) before committing to a single-physical-cache SVT.

> **Infra-reuse assessment (researched 2026-07-09) — half is reusable, half is genuinely new.** Split the streaming stack into *storage* and *consumption*:
> - **Storage/build half — HIGH reuse.** `pyramid-indexed-db.js` is fully generic (keyed by arbitrary string, stores blobs — reusable for mask tiles verbatim). `texture-pyramid-builder.js` is a generic URL→tiled-pyramid→worker-decode mechanism, currently only *wired* to `__bg_image__`/`__fg_image__`; the machinery is mask-agnostic. **Channel-packing already has a real head-start:** [mask-channel-pack.js](../../scripts/streaming/mask-channel-pack.js) defines `PACKABLE_BINARY_MASKS = ['fire','dust','ash','outdoors']` packed into one RGBA atlas (R/G/B/A). So ~4 of the binary masks can share one texture — but the RGB masks (`_Normal`, `_Windows`, `_Specular` color, `_Water`) can't 4-pack, so channel-packing helps a minority.
> - **Consumption half — LOW reuse, this is the real cost.** Album images are **drawn as tile *meshes* at world positions** → simple frustum culling decides which meshes to draw (what the existing streaming does). **Masks are sampled by *world coordinate inside effect shaders*** — verified: `water-shader.js` samples `sampleOutdoorsMask(worldSceneUv)`, `specular-shader.js` uses `worldPatternUv`, all `texture2D(mask, worldUV)`. A shader can request *any* world position any frame, so "stream only visible mask tiles" forces **every mask consumer to handle non-resident regions** (page-table lookup + residency test + low-res fallback). That is Sparse Virtual Texturing proper, a per-shader change across ~15 mask consumers — **not** solved by the existing draw-cull streaming. **This is why Phase 2 is a real project, not a wiring job**, and why the SVT page-table work (above) is unavoidable, not optional, once you go past a low-res whole-floor fallback.
> **Practical sequencing implication:** the cheapest first win is *not* tiling — it's **(a) per-floor mask LRU eviction to a low-res whole-floor fallback** (bounds VRAM without shader changes), then **(b) channel-pack the 4 binary masks** (one-time atlas, no per-consumer SVT), and only then **(c) full SVT** for the large RGB masks. Steps (a)/(b) may relieve the crash enough to defer (c).

### Phase 3 — Screen-space / SDF masks for the *geometry-semantic* masks only
Narrowed from the original: applies **only** to `_Outdoors` / `skyReach` / `floorAlpha`, which are area-semantic and derivable from geometry rather than painted per-pixel. Options: (a) rasterize outdoors regions from polygon data into a viewport-sized RT per camera move; or (b) fold into Phase 6's SDF. **Does not apply to the 13 painted masks** (§4.1) — those go through Phase 2.
**Expected effect:** removes the largest *derived* world-space bakes (`skyReach`/`floorAlpha` at up to 8192²) from VRAM.
**Touches:** `GpuSceneMaskCompositor.js` (`ensureSceneSpaceOutdoorsForFloor`, skyReach derivation), `outdoors-mask-*`.

### Phase 4 — Forward+ clustered lighting
Replace `LightingEffectV2`'s per-floor full-screen light-accumulation snapshots with per-pixel clustered lookup: bin lights into a screen grid on the CPU, upload as a DataTexture/UBO, loop only over a tile's lights in the fragment shader inside the Phase-1 unified pass. (Merges ideas.md's tile-based deferred lighting — one phase, not two.)
**Near-term bug regardless of Phase 4 (§7):** `_perFloorLightSnapshotRts` is only disposed at teardown (lines 5824–5866) — **no floor-change eviction**, so it grows unbounded per session. Fix this independently and soon.
**Expected effect:** removes the per-floor HalfFloat light snapshots; fill rate becomes independent of light count.
**Touches:** `LightingEffectV2.js` (expect a rewrite of the accumulation path, not a patch), tile shaders in `FloorRenderBus`.
**Depends on:** Phase 1.

### Phase 5 — Native geometry bridge (kill the PIXI `extract.canvas` readback)
Vision/fog are **already native and Foundry-authoritative** (`FogOfWarEffectV2` consumes `visionSource.los` polygons). The remaining work is (a) **delete ~1338 lines of dead vision files** (§11.4.2), and (b) **natively reconstruct the three content layers** (drawings, templates, sounds) so `pixi-content-layer-bridge.js` and its `extract.canvas` readback can retire. **Full detailed design in [§11](#11-pixi-bridge-replacement--detailed-design-phase-5).**
**Expected effect:** removes the only per-frame PIXI→CPU readback; CPU/RAM/GC relief + full visual control (not the load-crash fix — that's Phase 2).
**Touches:** `pixi-content-layer-bridge.js`, `FogOfWarEffectV2.js` (already native — extend for content layers or add sibling managers), `TokenManager`/`VisibilityController` (billboard + hit-test pattern to reuse); **delete only** `FoundryFogBridge.js`, `VisionManager.js`, `FogManager.js`, `GeometryConverter.js` (keep the live `VisionPolygonComputer.js` + `VisionSDF.js`).
**Independent of Phases 1–4** — parallel track.

### Phase 6 — SDF-based GPU shadows & vision *(from ideas.md, verified applicable)*
Replace Foundry's CPU raycast → 2D vision polygons ([VisionPolygonComputer.js](../../scripts/vision/VisionPolygonComputer.js)) with a per-floor 2D SDF of wall segments (Jump-Flooding Algorithm), raymarched on the GPU for pixel-perfect soft shadows. Naturally shares the Phase-1/4 fragment pass.
**Expected effect:** removes the CPU LOS-polygon bottleneck for many moving lights/tokens.
**Touches:** `ShadowManagerV2.js`, `LightingEffectV2.js`, `VisionPolygonComputer.js`, `FoundryFogBridge.js`.
**Sequence:** alongside/after Phase 4, not first.

### ~~Phase 7 — Hi-Z inter-floor culling~~ — **rejected as a general strategy (see §4.2)**
Culling lower floors when the upper floor is opaque is unsafe in MSA because water (and potentially other effects) on a lower floor must render **and simulate** through gaps in the floor above. Phase 1's hardware early-Z already gives correct free occlusion for the genuinely-opaque case. A *narrow, opt-in* per-tile cull for floors flagged fully-opaque-with-no-see-through-effects could be revisited later, but it is **not** the "holy grail" the original advice claimed and is explicitly deprioritized.

---

## 7. Open questions — resolved by this pass

| Question | Answer (verified 2026-07-09) |
|----------|------------------------------|
| Does `_perFloorLightSnapshotRts` get released on floor change? | **No.** Only at teardown (LightingEffectV2 5824–5866). Session-unbounded growth → near-term fix, independent of Phase 4. |
| What fraction of masks are geometry-derived vs painted? | **13 painted + 1 semantic (`_Outdoors`) + 2 derived.** Screen-space/vector masks apply only to the semantic/derived ones (§4.1); painted masks need Phase 2 tiling. |
| Are `extract.canvas` calls hot-path or on-demand? | **Both.** `_dirty`-gated + throttled, but the initial full-layer capture is on the load critical path and edits retrigger readbacks (§2.5). |
| Current default `rtType` for `LevelRenderTargetPool`? | Caller-supplied; load-slim forces UnsignedByte during load, HalfFloat otherwise. Mask RTs already UnsignedByte. Mitigation target = the HalfFloat compositor/lighting RTs, not masks. |
| Is the Mansion really 11 floors? | **No — 2 Levels + overheads.** Cost is masks×floors×resolution, not floor count (§1.1). |
| Can Hi-Z culling cull lower floors? | **No** — breaks water-under-floor (§4.2). Phase 7 rejected. |
| Does MSA share a WebGL context with PIXI? | **No, by default.** Shared context is opt-in (`__usePixiSharedWebGLContext`), off in production → readback is forced for anything captured from PIXI (§11.1). |
| Does the live vision/fog path recompute polygons or consume Foundry's? | **Consumes Foundry's** `.los`/`.fov`/`.shape` polygons directly (`FogOfWarEffectV2`), builds `ShapeGeometry`, native world-space vision RT. Already Option B (§11.4.1). |
| Which of the `scripts/vision/` files are dead vs live? | **Dead (~1338 lines):** `VisionManager`, `FoundryFogBridge`, `FogManager`, `GeometryConverter`. **Live — keep:** `VisionPolygonComputer` (effect occlusion, `FireEffectV2` et al.), `VisionSDF` (`FogOfWarEffectV2` fog edges). Verified by import/constructor tracing (§11.4.2). |
| Is the PIXI bridge the crash driver? | **No.** It's throttled; Mansion crash allocators are masks/tiles (Phase 2). The bridge is a CPU/RAM/GC + visual-control problem, scoped to drawings/templates/sounds only (§11.1 correction, §11.4.3). |

### Still open (need decisions, not just code reading)
- **KTX2/Basis compression — deferred, likely hard here.** MSA masks/images are GM-uploaded at runtime, not build-pipeline assets; `KTX2Loader` only *decodes* pre-transcoded files, so this needs a client-side Basis *encoder* (WASM) running in a worker against arbitrary 4K–12K uploads. Feasibility unproven. Treat as a timeboxed spike *after* Phase 2, not an early win — Phase 2 tiling delivers most of the VRAM relief without it.
- Should Phase 2 start as per-mask frustum tiling (low risk, mirrors album streaming) or go straight to full SVT page-table indirection (high risk)? Recommendation: tiling first.
- Does the water-source-floor path (§4.2) generalize to *other* see-through effects (fire glow through floor holes, foliage)? Audit before Phase 1 locks the unified-pass compositing contract.
- What does the mask export/preprocessing pipeline (Phase 2 prerequisite) look like, and does it run at author time or first-load? Blocks Phase 2 scoping.

---

## 8. Adjacent ideas (tracked so they aren't lost)
From [ideas.md](../architecture/ideas.md):
- **Channel packing** — `_Fire`/`_Dust`/single-channel masks into RGBA atlases; rides on Phase 2. `mask-channel-pack.js` already exists as a starting point.
- **Web Workers for pathfinding** (`nav-mesh-builder.js`, `multi-floor-graph.js`, `nav-mesh-pathfinder.js`, `FoundryFogBridge.js`) — orthogonal frame-stutter fix, separate workstream.
- **WebGPU as a design principle** — structure Phase 1/4/6 stateful passes as immutable pipeline objects so a future WGSL port isn't a rewrite. Not a phase.
- **Streaming minimap / LOD-on-zoom-out** (TODO §9 item 25) — pairs naturally with Phase 2's tile system; the minimap doubles as a streaming debug view.

## 9. Next steps for this document
> **Superseded by the Plan of Attack (§15)** — the items below are folded into Stage A/B there with sequencing and exit criteria. Kept for the per-item detail and section cross-references.
1. **Fix `_perFloorLightSnapshotRts` eviction** — smallest, safest, real win; independent of everything (§4/§7).
2. **Scope Phase 2's mask-tiling pipeline** — it's the dominant crash cause and the true replacement for the original "screen-space mask" idea. Define the export/preprocessing step first.
3. **Treat Phase 1 and Phase 4 as one "unified forward pipeline" workstream** (§12.4) — the per-floor RT stack only disappears when lighting/shadows go forward per-fragment. Do not scope Phase 1 as if it were separable from Phase 4.
4. **Design the Class D see-through contract first** (§12.3–12.4) — write the "lower floor rendered + simulated, composited through upper-deck alpha holes" relationship as an explicit spec before any unified-pass code; it constrains everything else.
5. **Audit the Class D generalization question** (§12.6) — does anything besides water need see-through (fire glow / foliage / player light through floor holes)? Highest-priority Phase-1 unknown.
6. **Run a "live-path audit" of the Class C/D files** (§12.5) — `WaterEffectV2` (95 legacy markers), `LightingEffectV2` (91), the shadow effects — mark each fallback live/dead, delete dead, document the one intended path, *before* rewriting them.
7. **Delete the dead vision files** (§11.4.2) — safe standalone ~1338-line cleanup; keep live `VisionPolygonComputer` + `VisionSDF`. Also delete stale `interaction-manager.js` comments claiming FogEffect uses `FoundryFogBridge`.
8. **Verify the multi-floor vision gap** (§11.6) — confirm `FogOfWarEffectV2` gets correct `.los` polygons for non-active floors; gates both Phase 1 and Phase 5.
9. **Choose a transparent-sort/OIT strategy for Class B** (§12.6) — gates particle/vegetation correctness in the unified pass.
10. Keep the [Mansion investigation](../Mansion-Multifloor-WebGL-Load-Investigation.md) as the acceptance test; timebox the KTX2 spike so it stays a spike.

---

## 10. Cross-references
- [ideas.md](../architecture/ideas.md) — SDF (→Phase 6), tile lighting (→Phase 4), Hi-Z (→rejected §4.2), KTX2 (→deferred §7), BatchedMesh/Workers/WebGPU (→§1/§8). Its priority order doesn't apply here: Phase 2 (mask tiling) and Phase 5 (PIXI) outrank SDF/Hi-Z because they're what actually crashes the scene.
- [TODO.md](../TODO.md) §9 items 22–28 — the performance/VRAM backlog this refactor resolves at the root (fire cost, roof drips, untracked mask cache, RT VRAM, tile streaming, vegetation streaming).
- [Mansion-Multifloor-WebGL-Load-Investigation.md](../Mansion-Multifloor-WebGL-Load-Investigation.md) — the live incident and shipped mitigations.
- `docs/investigations/performance_issues.md`, `performance_issues_02.md` — large-map perf logs; mine for additional evidence before Phase 1.

---

## 11. PIXI Bridge Replacement — Detailed Design (Phase 5)

*Researched 2026-07-09 against the unminified V14 client source in `foundryvttsourcecode_v14/resources/app/client/` and MSA's `scripts/vision/` + `scripts/foundry/`. This is the near-term priority.*

### 11.1 Root cause — MSA and PIXI run in **separate WebGL contexts** by default
The readback isn't a coding oversight; it's forced by the renderer topology:
- MSA creates its Three.js renderer with its **own** WebGL context unless `window.MapShine.__usePixiSharedWebGLContext === true` ([bootstrap.js:74–77](../../scripts/core/bootstrap.js)); that flag is **opt-in and off by default**, so `requestedSharedContext` resolves to `null` and [renderer-strategy.js](../../scripts/core/renderer-strategy.js) builds a fresh context.
- **Two GL contexts cannot share texture handles.** Anything PIXI renders that Three needs must therefore be copied CPU-side: [pixi-content-layer-bridge.js](../../scripts/foundry/pixi-content-layer-bridge.js) calls `renderer.extract.canvas(...)` (8+ sites) and explicitly documents the topology: it has a GPU→GPU injection path gated on `sharedContext = (pixiGl === threeGl)` (line 335) that **falls back to CPU readback** when contexts differ (line 357). In production (unshared) that fallback is the *only* path.
- Shared context is almost certainly off-by-default because **PIXI and Three each assume they own all GL state** (bound FBO, blend/depth state, active texture unit, vertex attrib arrays). Co-driving one context requires meticulous save/restore at every engine boundary and is a well-known source of corruption/crashes. That fragility is a real cost of "just turn on shared context."

> **Scope correction (important, verified 2026-07-09):** the content bridge is **throttled** (66 ms world / 120 ms live capture, [pixi-content-layer-bridge.js:45–47](../../scripts/foundry/pixi-content-layer-bridge.js)) and is **not** the primary crash driver. The Mansion Stage D crash's top allocators are `loadTextureAsync` / `TileManager.loadTileTexture` — i.e. **masks/tiles (Phase 2)**, not the bridge. The 2.1 GB JS-heap figure cannot be pinned on the bridge from the current evidence. Replace the bridge for **CPU/RAM efficiency, GC stutter, and full visual control** — but the load-crash fix is Phase 2. Do not oversell Phase 5 as the crash cure.
> **Heap-spike data point (2026-07-09 test run, needs clean-run confirmation):** a Mansion load crash showed **1966 MB JS heap with only 2 renderer textures alive** (run was poisoned by a compositor constructor crash-loop, so treat cautiously) — evidence that the ~2 GB heap spike is **CPU-side load-path allocation** (decode buffers / load machinery / error spam), not a mirror of GPU texture content. If a clean run reproduces ~2 GB heap before GPU content mounts, the heap investigation should target the CPU decode/load path, not the PIXI bridge or GPU texture duplication.

### 11.2 Important nuance — not all readback is the enemy
Foundry's **own** fog persistence already does a GPU→CPU readback (`FogManager.#extractPixels` / `_extractBase64` via `TextureExtractor`, [fog.mjs:203–247, 912–918](../../foundryvttsourcecode_v14/resources/app/client/canvas/perception/fog.mjs)) — but it's **throttled to 500 ms / debounced 2 s**, extracts a small WebP, and is off the render hot path. That kind of readback is fine and unavoidable for DB persistence. **The target to kill is per-frame content readback, not all readback.** The migration keeps a throttled persistence readback (reusing Foundry's own) and removes the every-frame copies.

### 11.3 What Foundry exposes as **data** (the native-reconstruction inputs — verified V14)
Everything the bridge currently rasterizes-then-reads is available as structured data that Three can consume directly:

| Content | Foundry data source (V14, verified) | Native Three reconstruction |
|---------|--------------------------------------|-----------------------------|
| Vision / LOS polygons | `canvas.effects.visionSources` (Collection, [groups/effects.mjs:71](../../foundryvttsourcecode_v14/resources/app/client/canvas/groups/effects.mjs)); each source `.los`, `.light`, `.fov`/`.shape` are `PointSourcePolygon` with flat `.points` arrays ([point-vision-source.mjs:108–126](../../foundryvttsourcecode_v14/resources/app/client/canvas/sources/point-vision-source.mjs)) + `.data.{x,y,elevation,radius}` | Triangulate `.points` → `THREE.ShapeGeometry`. **This is already what the live code does** ([FogOfWarEffectV2.js:728](../../scripts/compositor-v2/effects/FogOfWarEffectV2.js)) — do **not** recompute (see §11.4.1). |
| Walls / edges | `canvas.edges` — `CanvasEdges extends Map` ([geometry/edges/edges.mjs:9](../../foundryvttsourcecode_v14/resources/app/client/canvas/geometry/edges/edges.mjs)); authoritative segment graph consumed by `ClockwiseSweepPolygon` | Only needed if MSA ever computes its own polygons (it shouldn't — §11.4.1). Useful for door-seam / wall-adornment visuals. |
| Persistent fog | `canvas.fog.exploration` (`FogExploration` document, save/load API) + `canvas.fog.sprite.texture` (live accumulated RT) | Accumulate natively in a Three RT; persist by writing WebP back into the `FogExploration` document via Foundry's API (multiplayer/union preserved) |
| Measured templates | `canvas.templates.placeables`; each has `.shape`/`.ray` ([placeables/template.mjs:258–267](../../foundryvttsourcecode_v14/resources/app/client/canvas/placeables/template.mjs)) + document `{t, distance, direction, angle, width, x, y}` | Rebuild circle/cone/ray/rect as `THREE` geometry from the document — pure math, exact match |
| Drawings | `canvas.drawings.placeables` → `DrawingDocument` shape/points/fill/stroke | `THREE.ShapeGeometry`/line from points + material from fill/stroke |
| Ambient sounds / notes | `canvas.sounds.placeables`, `canvas.notes.placeables` (positions, radii, icons) | Billboard sprites (same approach tokens already use) |
| Tokens | already native Three sprites via `TokenManager` | — (done; `VisibilityController` syncs visibility) |

### 11.4 The actual state — vision/fog is **already native**; the bridge is only content layers
Deeper tracing (2026-07-09) overturns the earlier "mid-migration, competing stacks" read. The truth is cleaner and changes the plan:

**11.4.1 Vision + fog are already Option B — and already consume Foundry's authoritative polygons.**
The **live** fog implementation is [FogOfWarEffectV2.js](../../scripts/compositor-v2/effects/FogOfWarEffectV2.js) (4083 lines). It:
- Reads Foundry's computed vision directly: `const shape = vs?.los || vs?.shape || vs?.fov; const pts = shape?.points` ([line 728, 1013](../../scripts/compositor-v2/effects/FogOfWarEffectV2.js)), builds `THREE.ShapeGeometry`, and renders a **world-space vision RT** — no readback, no self-raycasting.
- Maintains its **own** ping-pong exploration accumulation RT, **per elevation band** (`_explorationGpuBandKey` — this is *more* than Foundry, which persists one exploration per level), seeds it from Foundry's saved `FogExploration` at load, and writes back via a **throttled, tiled GPU→CPU readback + WebP encode** ([lines 223–237](../../scripts/compositor-v2/effects/FogOfWarEffectV2.js)) — the acceptable persistence readback of §11.2.
- Has its own SDF pass for smooth fog edges ([line 243](../../scripts/compositor-v2/effects/FogOfWarEffectV2.js)).

So **the vision mask is already native and Foundry-authoritative.** The strategic decision "consume Foundry's `ClockwiseSweepPolygon` output, never recompute" (right, because that algorithm bakes in one-way walls via `edgeDirectionMode`, terrain/threshold walls via `useThreshold`, limited-angle via `boundaryShapes`, sight/light/darkness type behavior, elevation via `Level`, and V14 `surfaceExposure` — none of which a bespoke raycaster will match across game systems) **is already implemented in the live path.**

**11.4.2 Part of the old vision stack is dead code — but verify precisely before deleting.**
Import/constructor tracing (verified 2026-07-09, not just a constructor grep) splits the `scripts/vision/` files cleanly:

| File | Lines | Status | Evidence |
|------|-------|--------|----------|
| `VisionManager.js` | 577 | **DEAD** | Not imported anywhere (`from …/VisionManager` → 0 hits); only stale comment references. |
| `FoundryFogBridge.js` | 336 | **DEAD** | Not imported/constructed; only **stale comments** in `interaction-manager.js` claiming "FogEffect uses FoundryFogBridge" — it does not (FogOfWarEffectV2 consumes polygons directly). |
| `FogManager.js` (MSA's) | 341 | **DEAD** | Not imported/constructed. The `FogManager` hits in `canvas-replacement.js`/`module.js` are Foundry's `foundry.canvas.perception.FogManager` (name collision), not this file. |
| `GeometryConverter.js` | 84 | **DEAD (transitive)** | Imported only by the two dead files above; the `ReplicaOcclusionMaskPass` reference is a comment. |
| `VisionPolygonComputer.js` | 1296 | **LIVE — keep** | Constructed by `FireEffectV2:739`, and imported by `CandleFlamesEffectV2`, `LightningEffectV2`, `FogOfWarEffectV2`, `ThreeLightSource`, `light-interaction` — used for **per-effect occlusion geometry** (light-blocking for fire/candle/lightning glow), *not* the vision mask. |
| `VisionSDF.js` | 458 | **LIVE — keep** | Constructed by `FogOfWarEffectV2:1212` for the fog-edge SDF. |

So the safe deletion is **~1338 lines** (`VisionManager` + `FoundryFogBridge` + `FogManager` + `GeometryConverter`), not the ~3100 an earlier draft claimed. **`VisionPolygonComputer` and `VisionSDF` must not be deleted.** Caveat: `VisionPolygonComputer`'s use for effect occlusion is a bespoke raycaster and *could* carry the same cross-system fidelity divergence (§11.4.1) for those effects' light-blocking — worth a separate audit, but it is not dead code and is out of Phase 5's scope.

**11.4.3 What actually still does per-frame readback: content layers only.**
[pixi-content-layer-bridge.js](../../scripts/foundry/pixi-content-layer-bridge.js) (4575 lines, "Drawings-first bridge") is the **only** live `extract.canvas` readback path. It captures **drawings (primary), measured templates, and ambient sounds** into an HTMLCanvasElement → `THREE.CanvasTexture`, dual-channel (world/ui), throttled. This — not vision/fog — is the entire remaining Phase 5 surface.

**11.4.4 Token visibility is already correctly negotiated.**
[VisibilityController.js](../../scripts/vision/VisibilityController.js) delegates to `foundryToken.isVisible` (which runs the game system's registered **detection modes** — basic sight, see-invisible, blindsight, tremorsense, etc.) and keeps the PIXI token interactive at alpha 0 for **hit-testing** while Three renders the sprite. This is the exact "Foundry is authority, MSA owns visuals" contract, working today — keep and generalize this pattern to every migrated layer.

### 11.5 Recommendation — finish Option B; the remaining work is content layers, not vision
Option B is **already the architecture for vision/fog**; there is no need to consider Option A (shared context) for them. The remaining Option B work is narrowly:
1. **Delete the dead vision files** (§11.4.2) — ~1338 lines (`VisionManager` + `FoundryFogBridge` + `FogManager` + `GeometryConverter`); keep `VisionPolygonComputer` + `VisionSDF`.
2. **Reconstruct the three content layers natively** (§11.4.3) so `extract.canvas` and `pixi-content-layer-bridge.js` can retire.
Shared context (Option A) is **not** recommended even as a stopgap: it would trade the throttled, contained content-bridge readback for permanent cross-engine GL-state fragility, and vision/fog already don't need it.

### 11.6 Content-layer reconstruction — the real Phase 5 work
Difficulty is uneven; sequence easiest-first to build confidence and retire `extract.canvas` sites incrementally.

**Templates (easiest — pure math).** `canvas.templates.placeables`; each `MeasuredTemplate` already exposes `.shape`/`.ray` ([template.mjs:258–267](../../foundryvttsourcecode_v14/resources/app/client/canvas/placeables/template.mjs)) plus document `{t, distance, direction, angle, width, x, y}`. Rebuild circle/cone/ray/rect as `THREE.ShapeGeometry` from the document. Gaps to honor for cross-system parity: round-vs-flat cone (`CONFIG.MeasuredTemplate` / core setting), grid snapping (`canvas.grid.getSnappedPoint`), the highlighted grid squares, and border/fill/texture styling. Live preview during drag = read the preview placeable's document each frame.

**Ambient sounds / notes (easy — billboards).** `canvas.sounds.placeables`, `canvas.notes.placeables` → position/radius/icon. Same billboard-sprite approach tokens already use; hide the PIXI originals (alpha 0) but keep them for hit-testing (§11.4.4).

**Drawings (hardest — the long tail).** `canvas.drawings.placeables` → `DrawingDocument`. Straightforward for solid shapes (rect/ellipse/polygon → `THREE.ShapeGeometry` from `shape` + fill/stroke material), but Foundry supports (verified in `common/documents/drawing.mjs` + `placeables/drawing.mjs`):
- **`bezierFactor` freehand smoothing** — must replicate the smoothing or accept polyline approximation.
- **`fillType` PATTERN with a `texture`** (tiled image fill) — needs texture sampling/repeat in the material.
- **`text` via `PreciseText`** (font/size/color/stroke) — reproducing PIXI text in Three needs a canvas-texture glyph render or MSDF; **this is the single highest-effort item** and the place to decide "pixel-perfect vs good-enough."

**Risks / open questions:**
- **Drawing text fidelity** is the main scope risk. Options: (a) render each text drawing to a small offscreen canvas → `CanvasTexture` (a *bounded, per-drawing, on-change* readback — acceptable, unlike full-layer capture); (b) MSDF font atlas (best quality, most work). Decide early.
- **Hit-testing stays in PIXI** for every migrated layer (§11.4.4) — do not reimplement picking in Three unless a layer has no PIXI equivalent.
- **Live editing/preview**: drawings/templates being drawn emit `refresh*`/preview placeables, not just `create/update` hooks. Native reconstruction must read the preview placeable per frame while a tool is active, then settle on the document hook — mirror the throttle logic already in the content bridge.
- **Per-floor / elevation**: templates, drawings, sounds carry elevation; they must be routed to the correct MSA floor band (§4.2) and Z, matching how the bridge currently gates by `elevationInBand`.
- **Multi-floor vision gap (pre-existing, verify):** Foundry initializes vision sources for the **active view level**. MSA composites multiple floors — confirm `FogOfWarEffectV2` gets correct `.los` polygons for **non-active** floors (it tracks per-band exploration, implying it does, but the *live vision* for a lower floor viewed from above — the water-under-planks case, §4.2 — needs explicit verification that Foundry still exposes usable vision sources for it, or that MSA falls back to full-visibility there).

**Cleanup dividend:** finishing §11.5 removes `pixi-content-layer-bridge.js` (4575) + the dead vision files (~1338, §11.4.2) ≈ **~5.9k lines** and every `extract.canvas` site, for a much smaller, fully GPU-resident content path.

### 11.7 The negotiation contract — how MSA stays a visual layer over Foundry's authority
The whole refactor rests on a clean division: **Foundry owns data, rules, interaction, and persistence; MSA owns pixels.** For cross-system compatibility this must be driven entirely by Foundry's own change signals, never by hardcoded system assumptions. The signals (verified V14):

**Perception render-flag pipeline** ([perception-manager.mjs:12–104](../../foundryvttsourcecode_v14/resources/app/client/canvas/perception/perception-manager.mjs)) — `canvas.perception.update({...})` sets flags that propagate:
`initializeVisionSources → refreshVision → refreshVisionSources`; `initializeLightSources → refreshLighting`; `refreshOcclusion → refreshOcclusionMask`; `initializeSounds → refreshSounds`. After `canvas.visibility.refresh()` runs, the **`sightRefresh` hook** fires — this is MSA's cue that all `visionSource.los`/`.fov` polygons for the frame are final and safe to consume. `VisibilityController` already listens here; the native content/vision rebuilds should key off the same pipeline rather than polling.

**Document hooks (authoritative data changes)** — `create/update/delete` for `Wall`, `Token`, `AmbientLight`, `AmbientSound`, `MeasuredTemplate`, `Drawing`, `Note`, `Region`, plus `updateScene` (dimensions/darkness/globalLight), `updateFogExploration`, and `canvasReady`/`canvasTearDown`. MSA reconstructs the affected native geometry on these; it must not assume which system fired them.

**Interaction stays in PIXI** — Foundry's placeable layers keep handling clicks/drags/HUD at alpha 0 (§11.4.4). MSA never intercepts input; it mirrors the resulting document/preview state into Three. This is what makes the visuals system-agnostic: any system's tools, sheets, and automation keep working untouched.

**What MSA must *not* do (cross-system traps):**
- Don't reimplement detection modes / vision modes / senses — delegate to `token.isVisible` and consume the resulting vision sources. Systems (and modules like *Levels*, *Wall Height*, *Vision 5e*) register these in `CONFIG.Canvas.detectionModes` / `visionModes`; MSA reading the *output* (polygons + `isVisible`) is automatically compatible.
- Don't assume grid type — templates/snapping differ on gridded vs gridless; always go through `canvas.grid.*` helpers.
- Don't assume dnd5e template shapes or units — read the `MeasuredTemplate` document and `canvas.dimensions.distancePixels`.
- Don't cache wall/edge topology across `canvasReady` — rebuild from `canvas.edges` each scene.

---

## 12. Phase 1 — Effect-by-Effect Classification (research, not yet a plan)

*Traced 2026-07-09 against `FloorCompositor.js` (~10k lines), `FloorRenderBus.js`, `LevelCompositePass.js`, and the effect roster. Goal: know exactly what a unified depth-layered pass would break before committing.*

### 12.1 The pivotal finding — the albedo geometry is *already* unified
`FloorRenderBus` is **not** a per-floor-RT painter. Its own header states the design: *"One THREE.Scene. Tiles Z-ordered by floor index (floor 0 at Z=1000, floor 1 at Z=1001, etc.) so standard depth sorting handles layering"* ([FloorRenderBus.js header](../../scripts/compositor-v2/FloorRenderBus.js)), using `camera.layers` (floors 1–19, overhead 20) and `renderOrder`. **So Phase 1's "give every floor real Z and let the depth buffer resolve occlusion" is already true for tile/token albedo.**

The per-floor render-target stack (`LevelRenderTargetPool`, `_renderPerLevelPipeline`) therefore does **not** exist because of geometry. It exists because **lighting, water, and shadows are screen-space post-passes that must be applied per floor with per-floor masks, then merged bottom→top** by `LevelCompositePass` (Porter–Duff source-over, straight-alpha — [LevelCompositePass.js:4](../../scripts/compositor-v2/LevelCompositePass.js)). That reframes Phase 1 entirely (§12.4).

### 12.2 The four render phases (where each effect actually runs)
Verified call-site map in `FloorCompositor`:

| Phase | What runs | Floor behavior |
|-------|-----------|----------------|
| **P0 — Simulation `update()`** (~L3262–3275, L5152–5296) | Fire/Dust/Ash/AshCloud/WaterSplashes/SmellyFlies/Lightning/CandleFlames/PlayerLight sims; Bush/Tree/Fluid/Cloud sims; all effect `update()` | Floor-agnostic; no RT allocation. Advances GPU sim state only. |
| **P1 — Global producers** (~L5316–5545) | Specular, Iridescence, Prism render (once); shadow *producers* (Overhead/Building/SkyReach/Painted mask build, L5418–5474); Cloud render; Lighting `beginFrame`/ceiling-transmittance | Run **once**, produce world/screen textures consumed later. |
| **P2 — Per-level loop** (L9111–9410) | Bus albedo per floor (already Z-sorted); **Lighting** per floor (L9235); **WindowLight** per floor; **Fire glow** per floor; **Painted/Building shadow** *lit-per-floor* (L9223/9230); **Water** per-level when single-floor (L9317) | **The per-floor RT stack.** Allocates `{sceneRT,postA,postB}` per visible floor; builds cross-floor water occluders from upper sceneRTs. |
| **P3 — Level composite** (L~9410) | `LevelCompositePass` bottom→top | Collapses the stack to one RT. |
| **P4 — Post-merge** (L1803–1868, L9540–9744) | **Water** multi-floor (L9540, builds see-through occluders); Atmospheric Fog (L9607); **Bloom** (L9627); **Color Correction** (L9744); Filter/Sharpen/DotScreen/Halftone/Ascii/Dazzle/VisionMode/Invert/Sepia/Lens/Distortion; FogOfWar; FloorDepthBlur | Run **once** on the merged composite. |

### 12.3 Classification (Phase-1 impact of collapsing the P2 per-floor stack)

**Class A — Phase-1-neutral (screen-space on the final image; don't care how it was composed).** No change needed beyond receiving one input RT instead of a merged one.
`FilterEffectV2`, `SharpenEffectV2`, `DotScreenEffectV2`, `HalftoneEffectV2`, `AsciiEffectV2`, `DazzleOverlayEffectV2`, `VisionModeEffectV2`, `InvertEffectV2`, `SepiaEffectV2`, `LensEffectV2`, `DistortionManager`, `FloorDepthBlurEffect`, `FogOfWarEffectV2` (world-space vision RT, already floor-aware). Also the **once-run screen-space mask passes** `SpecularEffectV2`, `IridescenceEffectV2`, `PrismEffectV2` (rendered once at L5316–5318, *not* per floor) and `ColorCorrectionEffectV2` / `BloomEffectV2` / `AtmosphericFogEffectV2` (post-merge already) — **but** these five consume a *stacked per-floor mask* (stacked outdoors, per-floor specular/iridescence source); that aggregated input must survive the refactor, so treat them as **A-minus** (§12.6 last bullet).

**Class B — Geometry-in-scene, needs correct depth/transparency in a unified pass.** These already live in the one bus scene (or a parallel scene) as meshes/particles; Phase 1's risk for them is **transparent-object depth sorting** (depth-write vs read-order) across floors, not screen-space compositing.
`BushEffectV2`, `TreeEffectV2`, `FluidEffectV2`, `DustEffectV2`, `AshDisturbanceEffectV2`, `AshCloudEffectV2`, `SmellyFliesEffect`, `WeatherParticlesV2`, `WeatherLightningEffectV2`, `CandleFlamesEffectV2`, `CloudEffectV2` (cloud sprites), `SelectionBoxEffectV2`, `MovementPreviewEffectV2`, `DetectionFilterEffect`. Main hazard: many use additive/transparent blending that currently relies on per-floor pass isolation; a single depth-tested pass needs an explicit transparent-sort or OIT strategy.

**Class C — Hard-coupled to the per-floor RT stack (this is *why* the stack exists).** Cannot be collapsed without moving lighting/shadows to **forward/per-fragment** shading — i.e. Phase 1 and Phase 4 are the *same move*, not sequential (§12.4).
`LightingEffectV2` (per-floor pass + per-floor HalfFloat snapshots + `beginStackedLightBuffer`/`accumulateStackedLightBuffer`), `WindowLightEffectV2` (per-floor window light), `FireEffectV2` glow (`setRenderFloorIndexForGlow` per floor), `PaintedShadowEffectV2` & `BuildingShadowsEffectV2` (hybrid: global mask build in P1 **plus** `renderLitForSingleFloor` per floor in P2), `PlayerLightEffectV2`, `ShadowManagerV2` + shadow-system producers (`SkyReachShadowsEffectV2`, `OverheadShadowsEffectV2`, `OverheadStampEffectV2`, `UpperFloorAlphaCompositor`, directional/vegetation shadow passes).

**Class D — The cross-floor see-through path (the water-under-planks constraint, §4.2 made concrete).** Depends on **lower-floor content being rendered and available while an upper floor is in view**, then occluded by the upper deck.
`WaterEffectV2` + `WaterSplashesEffectV2`: multi-floor water runs in P4 and calls `_resolvePostMergeWaterOccluderRT(levelSceneRTs, …)` (L9291) — it reads **upper levels' sceneRTs** to punch the deck over lower water, and `_resolveWaterSourceFloorForView` (L8303) picks a *lower* floor's water for the current view. A unified depth pass must keep an explicit "lower water floor is rendered + simulated, then composited through the upper deck's alpha holes" branch — depth testing alone does not reproduce "simulate the thing below and reveal it through a hole with the correct occluder." **This is the single hardest Phase-1 constraint and it cannot be dropped.**

> **Class D generalization — RESOLVED (2026-07-09), and the answer is reassuring.** The §12.6 "highest-priority unknown" (does anything besides water need see-through?) is answered: **yes, several effects do — but they share ONE primitive, not N hacks.** `TileManager` produces two screen-space **floor-presence masks** ([tile-manager.js:1333–1386](../../scripts/scene/tile-manager.js)): `floorPresenceScene` (layer 23 = alpha quads for *current-floor* tiles) and `belowFloorPresenceScene` (layer 24 = *below-floor* / `levelsHidden` tiles). Purpose, verbatim from the source: *"bound preserved effects to their originating floor."* Verified consumers: **`WaterEffectV2`/`water-screen-occlusion`, `DistortionManager` (heat shimmer — `belowFloorPresenceTarget`, [DistortionManager.js:488–498](../../scripts/compositor-v2/effects/DistortionManager.js)), `CandleFlamesEffectV2`, `WindowLightEffectV2`, `SpecularEffectV2` (`specular-shader`), and `GpuSceneMaskCompositor`.** So the cross-floor contract is a **generalized screen-space occlusion primitive** (current-floor presence + below-floor presence), already shared. **This substantially de-risks Class D:** Phase 1's hardest requirement reduces to a single, concrete, testable contract — *"the unified pass must still be able to produce a current-floor-presence mask and a below-floor-presence mask in screen space."* If that primitive survives, water, heat distortion, candle flames, window light, and specular all keep their cross-floor behavior. Design **that primitive** first, not N per-effect branches.
> **Separate note — Fire glow is the ragged edge.** `FireEffectV2` is *not* in the floor-presence consumer list; it uses `setRenderFloorIndexForGlow` (P2) plus the water occlusion path's roof-block/slice textures, and [TODO.md §7 item 20](../TODO.md) documents live bugs ("fire glows appear ABOVE overhead tiles incorrectly"; "heat distortion... appears to be effecting rooftops above the fire"). So fire's cross-floor handling is **already partially broken and inconsistent with the shared primitive** — Phase 1 is an opportunity to fold fire glow onto the same floor-presence primitive rather than port its bespoke, buggy path.

### 12.4 Consequence — Phase 1 and Phase 4 are one move, and Class C/D define the real work
- **Albedo:** already unified (§12.1) — near-zero Phase-1 work.
- **Class A:** trivial — re-point inputs.
- **Class B:** a **transparent-sort / order-independent-transparency** problem in the unified scene; real but bounded, and largely shared with Phase 4.
- **Class C:** the per-floor RT stack only disappears if lighting/window-light/fire-glow/shadows become **forward per-fragment** in the unified geometry pass. That *is* Phase 4 (clustered lighting). **Recommendation: merge Phase 1 and Phase 4 into a single "unified forward pipeline" workstream** — attempting Phase 1 without Phase 4 just moves the per-floor passes around without removing them.
- **Class D:** must be designed *first*, as an explicit contract, because it constrains the entire unified-pass architecture. Everything else can adapt to it; it cannot adapt to them. **Now concrete (§12.3 resolution):** the contract is "reproduce the current-floor + below-floor screen-space presence masks." One primitive, ~6 consumers — bounded and testable, not open-ended.

### 12.5 Legacy / fallback debt — a Phase-1 risk multiplier (user-flagged)
The effects Phase 1 must rewrite are the **most legacy-encrusted** files in the codebase. Count of `legacy|abandoned|deprecated|fallback|pre-phase|old path|removed` markers (verified 2026-07-09):

| File | Markers | Phase-1 class |
|------|---------|---------------|
| `FloorCompositor.js` | 115 | orchestrator |
| `WaterEffectV2.js` | 95 | **D** (hardest) |
| `LightingEffectV2.js` | 91 | **C** (hardest) |
| `BuildingShadowsEffectV2.js` | 85 | **C** |
| `SpecularEffectV2.js` | 69 | B |
| `WindowLightEffectV2.js` | 63 | **C** |
| `SkyReachShadowsEffectV2.js` | 61 | **C** |
| `FogOfWarEffectV2.js` | 52 | A |

The `FloorRenderBus` header itself documents *"Previous approach (ABANDONED — see planning doc Attempts 1–4)"* — the current design is Attempt 5. This matters for Phase 1 in two ways: (1) the exact files that must be rewritten (Water, Lighting, Shadows) carry the heaviest dead-branch / fallback load, so **a de-legacying pass on Class C/D files is a legitimate Phase-1 precondition** — you cannot safely rewrite a 5174-line water effect with 95 legacy markers until you know which branches are live; (2) reliability today is partly eroded *by* those fallbacks (silent `catch(_){}` degradation paths, dual single-floor/multi-floor code paths). **Recommendation: before the unified-pipeline rewrite, do a scoped "live-path audit" of `WaterEffectV2`, `LightingEffectV2`, and the shadow effects — mark each fallback as live/dead, delete the dead, and document the single intended path.** This is the compositor-side analogue of the §11.4.2 dead-vision-file cleanup.

### 12.6 Open questions this raised (for the next research pass)
- **Transparent sort strategy** for Class B in a single depth pass: painter's-order per floor band + depth test between bands? Weighted-blended OIT? This gates Phase 1/4 feasibility for particles/vegetation.
- **How many Class C effects can share one forward lighting pass** vs. needing their own contribution buffer (fire glow, window light, player light each have bespoke shading)? Determines whether Phase 4's clustered pass is one shader or several.
- ~~**Class D generalization:** does any effect other than water need the see-through path?~~ **RESOLVED 2026-07-09 (§12.3):** yes — water, heat distortion, candle flames, window light, specular — but all via ONE shared primitive (`TileManager` floor-presence masks, layers 23/24). The Phase-1 contract is "preserve that primitive," not N branches. Fire glow is the exception (bespoke + already buggy; fold it onto the primitive).
- **Stacked masks/snapshots as the hidden Phase-1 surface:** `_buildStackedOutdoorsForPostMerge`, `_stackedLevelLitSnapshots`, `beginStackedLightBuffer` — these per-floor-aggregate structures feed post-merge A-class effects. Enumerate every consumer before removing the per-floor RTs that populate them.

---

## 13. Diagnostic report accuracy (fixed 2026-07-09)

The crash/diagnostic reports produced by [webgl-crash-recovery.js](../../scripts/core/webgl-crash-recovery.js) are what a future LLM (or you) will read first when debugging a crash — including future refactor work on this very plan. If the report is misleading, fixes built on it will be misdirected. Traced and corrected two concrete issues this session:

1. **Floor count was never actually recorded — a tile-mesh count was mislabeled as a floor count.** `diagnoseCrash()`'s multifloor-mask cause used `populate.busTileCount` (= `FloorRenderBus._tiles.size`, a **mesh/tile count**, confirmed in [tile-streaming-report.js:93](../../scripts/ui/tile-streaming-report.js)) and presented it as `"${busTileCount} floors visible during load"`. This is the same class of error as the Mansion investigation's "~11 multifloor bands" claim (§1.1) — a proxy count silently standing in for floor count. **Fixed:** `collectDiagnostics()` now records real `record.scene.levelsCount` / `visibleFloorsCount` from `window.MapShine.floorStack`, and the diagnosis text uses that when available, falling back to a correctly-labeled tile-mesh count (never "floors") otherwise.
2. **The only numeric mask-VRAM estimate covers 1 of ~15 masks, unlabeled as such.** `_estimateOutdoorsMaskBakeSize()` estimates `_Outdoors` alone and fed a cause string ("Multifloor outdoors mask baking would allocate ~X MB per floor") that reads as if it were the total mask cost. Per §2.1, MSA bakes up to 15 comparably-sized authored per-floor masks. An LLM fixing "the mask problem" from this report alone would very plausibly optimize `_Outdoors` and miss `_Specular`/`_Water`/`_Fire`/`_Tree`/`_Bush`/etc. **Fixed:** both the raw estimate object (new `note` field) and the diagnosis text now explicitly caveat that this is a representative sample, not the total, and name the other mask suffixes.

**Not yet audited (flag for a future pass, lower priority):** the ~1,720-line file has sections this pass didn't fully read (offset 1199–1726) — worth a follow-up sweep for similar proxy-count-as-ground-truth patterns, and for whether the PIXI content bridge (§11) is correctly *absent* from crash attribution (it should be, per §11.1's correction — the bridge is throttled and not the crash driver; confirmed no PIXI/extract.canvas references exist in this file's diagnosis logic, which is correct and should stay that way).

---

## 14. Architecture review — the target state and its principles *(added 2026-07-09)*

*Big-picture pass over everything above. §14.1–14.2 are decision rules and the end-state description; §14.3–14.5 are design proposals that need validation during Stage B design (§15), marked as such. Nothing here contradicts the verified findings — it organizes them into a buildable shape.*

### 14.1 Principles — the decision rules for every choice below

1. **The screen-bound invariant.** Every byte of GPU memory is bounded by *screen resolution* or a *fixed budget* — never by world size, mask count, or floor count. Any new allocation that scales with the world is a regression, full stop. This is the one-sentence version of the whole refactor.
2. **Foundry is the authority; MSA is the renderer.** Never recompute what Foundry computes (vision polygons, visibility/detection, template shapes, grid math). Consume outputs via documents + hooks (§11.7). This is what buys cross-system compatibility for free.
3. **One primitive per concern.** The codebase's recurring disease is N bespoke solutions to one problem (fire's cross-floor path vs. the shared floor-presence primitive; per-effect occluder builds; three vision stacks of which two were dead). Each concern gets exactly one primitive with a named owner; new effects consume primitives, never re-derive them.
4. **No silent fallbacks.** A fallback either becomes the only path or gets deleted. `catch(_){}`-degradation and dual single-/multi-floor branches (§12.5) erode reliability *and* misdirect debugging. New code: fail loudly in dev, degrade *visibly* (logged + surfaced in diagnostics) in production.
5. **Delete before you build.** Every rewrite of a subsystem is preceded by its live-path audit + dead-branch deletion (§12.5). You cannot safely rewrite what you cannot read.
6. **Diagnostics tell the truth from day one** (§13). Every new system ships with its VRAM/timings visible in the crash/perf reports, correctly labeled. Reports are the interface future debugging sessions (human or LLM) trust.
7. **Shippable at every step.** The module must remain releasable throughout. Big pieces are built as a parallel path behind a flag (V3), validated scene-by-scene, then flipped — never rewritten in place. (The codebase's own history — `FloorRenderBus` is "Attempt 5" — is the argument.)

### 14.2 The end-state frame — what one frame looks like when we're done

```
CPU (per frame, cheap):
  Foundry hooks/documents → sim updates (water, fire, weather; bounded sim-space RTs)
  → light list → screen-tile cluster bins (Phase 4)

GPU:
  [Producers]   floor-presence / vision RT / shadow producers — screen-sized only
  [Unified pass] ONE geometry pass, all floors at real Z, hardware depth test:
                 • forward clustered lighting per fragment (Phase 1+4)
                 • alphaTest holes let lower floors show through
                 • masks sampled via fixed-budget cache (Phase 2) 
                 • MRT: color  +  thin floor-attribute buffer (§14.3)
  [Exceptions]  the ONE see-through branch: lower-floor water surface,
                composited through upper-deck alpha (Class D contract)
  [Post]        bloom, CC, stylization, fog-of-war — once, on the single composite
```

Everything on the GPU side is screen-sized except the mask cache, which is a *fixed* budget (e.g. 256–512 MB) regardless of map size. Target total at 1080p: **well under 1 GB VRAM for any scene** — versus multi-GB today. That number is the acceptance metric for the whole effort.

### 14.3 Proposal — the floor-attribute buffer (the §12.3 primitive, made concrete)

The Class D resolution found that ~6 subsystems share one primitive: screen-space "which floor owns this pixel" masks (layers 23/24). §12.6 separately flagged the stacked-outdoors builds feeding post-merge effects. **These are the same family of data.** In a unified pass, all of it collapses into a second MRT attachment written by opaque/alphaTest fragments:

> **Attribute buffer (RGBA8, screen-sized, NEAREST):** R = floor index of the topmost opaque fragment · G = outdoors/skyReach value (sampled in-pass from a *low-res* per-floor outdoors texture — outdoors is area classification and doesn't need world resolution) · B/A = reserved (presence flags, material bits).

Every downstream consumer then derives its need from one buffer: *current-floor presence* = `floorID == viewed`; *below-floor presence* = `floorID < viewed`; *stacked outdoors for CC/bloom* = the G channel directly. This retires the per-effect presence scenes, the stacked-outdoors post-merge builds, **and** the A-minus caveat in §12.3 — and it folds Phase 3 into the unified pass (outdoors becomes a per-pixel attribute, not a world-space bake stack). Convention: only opaque + alphaTest fragments write attributes; transparents read them (standard). Consumers needing soft edges blur their derived mask. **Validate in Stage B design**: semi-transparent decks and the water surface are the edge cases.

### 14.4 Proposal — a minimal frame graph replaces the god-compositor

`FloorCompositor.js` is ~10k lines because pass ordering, RT lifetimes, and effect wiring are all implicit in one imperative method. V3 should introduce a *minimal* frame graph — not an engine, ~200 lines: passes declare `{name, reads[], writes[], execute()}`; a tiny scheduler allocates transient RTs from a pool, aliases them when lifetimes don't overlap, and runs passes in dependency order. Dividends: automatic RT reuse (memory), per-pass GPU/CPU timings for free (feeds §13 diagnostics), impossible-to-miss ordering bugs, and exactly the immutable-pipeline structure §8 wants for a future WebGPU port.

### 14.5 Proposal — water surface as first-class geometry

Today, water is a screen-space composite with hand-built cross-floor occluders (§12.3 Class D, the hardest machinery in the codebase). In the unified pass, the natural form is: **the water surface is a mesh** (the water-mask region, at its floor's Z) whose shader samples the existing bounded sim. Then plank-over-river occlusion is *just depth testing* — planks at upper Z occlude; alphaTest holes reveal — and most of `_resolvePostMergeWaterOccluderRT`'s bespoke machinery dissolves. The sim itself (already bounded, P0) is untouched. Splashes/edge-cases keep a small screen-space path reading the attribute buffer. **This is the highest-payoff simplification in the plan and also the riskiest — it gets its own milestone (B5) gated on the plank-prison acceptance scene, with V2 water kept alive behind the flag until V3 water passes.**

---

## 15. Plan of attack

Two stages plus a parallel track. Stage A makes today's module *safer and measurably lighter* with generic, low-risk fixes — the "small improved version." Stage B is the big refactor, built as a parallel V3 pipeline behind a flag. Ordering within stages is deliberate; each item lists its exit criterion. Sizes: S = hours–a day, M = days, L = week+.

### Stage A — Stabilize and shrink (the small improved version)

| # | Item | Size | Exit criterion |
|---|------|------|----------------|
| A1 ✅ | **Git safety net**: commit current work; branch per Stage-A item thereafter | S | **Done 2026-07-09** (`4ac1e83` baseline + `af4d3c6` docs; docs/ un-gitignored) |
| A2 ✅* | **Acceptance scene set**: pick 4–5 golden scenes (single-floor; Mansion 2-floor; plank-prison river; fire-heavy; 144 MP) + a repeatable manual checklist (load → pan → floor-switch → screenshot). Every later item is verified against these | S | Checklist committed (`9603042`, [acceptance-scenes.md](acceptance-scenes.md)). ***User task remaining:** fill in scene names + capture baseline screenshots |
| A3 | **Diagnostics truth pass** (finish §13): sweep remaining `webgl-crash-recovery.js` lines; add per-mask-type VRAM totals and floor counts to reports so every later stage is measurable | M | Report shows accurate mask/RT/floor numbers on a test crash |
| A4 ✅ | **Delete dead vision files** (§11.4.2): ~1338 lines + stale comments | S | **Done 2026-07-09** (`d2a7b66`, −1,347 lines; 5 stale comments corrected; imports verified clean) |
| A5 ✅ | **Fix `_perFloorLightSnapshotRts` eviction** (§7): evict on floor-set change, mirroring `releaseStale` | S | **Done 2026-07-09** (`a0f0f74`; also covered `_perFloorGameplayLightSnapshotRts` + `FloorCompositor._stackedLevelLitSnapshots`, same leak class found during implementation). **Needs runtime verify** on Mansion floor-switching |
| A6 | **Live-path audit + de-legacy, one file at a time** (§12.5): `WaterEffectV2` → `LightingEffectV2` → `BuildingShadows` → `WindowLight` → `SkyReach`. Timeboxed per file; mark live/dead, delete dead, document THE path. No behavior changes | L | Each file's marker count materially down; golden scenes unchanged |
| A7 | **Mask VRAM quick wins** (§6 Phase 2a/2b): (a) LRU-evict non-active floors' masks to a low-res whole-floor fallback; (b) channel-pack the 4 binary masks (`mask-channel-pack.js` exists) | M–L | A3 diagnostics show mask VRAM materially down on Mansion; **Mansion loads on the 8 GB laptop** |
| A8 | **Phase 5 first slice — templates natively** (§11.6, easiest content layer): proves the native-reconstruction pattern end-to-end while being small | M | Templates render via Three geometry; one `extract.canvas` cluster retired |

**Stage A exit gate:** Mansion loads without safe-mode on the 8 GB laptop; golden scenes visually unchanged; diagnostics accurate. *This is worth a release.*

### Stage B — The big refactor (V3 unified forward pipeline, behind a flag)

**B0 — Design docs first (no code).** Three short specs, validated against §12's classification: (1) the floor-attribute buffer (§14.3) including the water/transparent-deck edge cases; (2) the V3 frame graph pass list (§14.4) — every §12.2 phase mapped to a named pass; (3) the Class B transparency strategy (recommendation: painter's-order *within* floor bands + depth test *between* bands first; OIT only if that visibly fails). Exit: specs reviewed, golden-scene expectations written down.

**B1 — Frame graph + unified albedo (M).** V3 flag renders albedo-only unified pass (already Z-sorted, §12.1) + attribute buffer through the frame graph. Exit: golden scenes' *geometry* matches V2 with lighting off; attribute buffer visualizable in a debug overlay.

**B2 — Clustered forward lighting (L).** Phase 4 proper: light bins → per-fragment loop in the unified pass. `LightingEffectV2`'s accumulation path retires *inside V3*. Exit: lighting parity on golden scenes; per-floor light snapshot RTs gone from V3 diagnostics.

**B3 — Shadows onto the forward pass (L).** Shadow producers (P1) stay; per-floor *lit* application (`renderLitForSingleFloor`) becomes attribute-buffer-driven terms in the unified shader. Exit: shadow parity; per-floor shadow passes gone.

**B4 — Class B transparents/particles (M–L).** Vegetation, particles, candles under the B0 transparency strategy, reading the attribute buffer for floor gating. Fire glow **folds onto the shared primitive here** (§12.3 — fixes TODO §7 item 20 as a side effect rather than porting the buggy bespoke path). Exit: fire/foliage golden scenes pass, including glow-under-roof.

**B5 — Water as geometry (L, riskiest).** §14.5. V2 water stays live until the plank-prison scene passes in V3. Exit: plank-prison parity + the occluder machinery absent from V3.

**B6 — Mask residency / SVT (L).** Phase 2c for the big RGB masks: page-table indirection + residency fallback in mask-sampling shaders — now fewer and consolidated by B2–B5. May shrink or defer if A7 already relieved the crash class. Exit: fixed mask budget honored on a 16k-map stress scene.

**B7 — Flip and delete (M).** V3 default-on; V2 per-floor pipeline, `LevelCompositePass`, `LevelRenderTargetPool`, and the stacked-mask builders deleted after a soak period. Exit: §14.2's memory target hit (<1 GB @1080p on every golden scene); LOC materially down.

### Parallel track C — finish Phase 5 content layers (independent of B)
Sounds/notes billboards (M) → drawings (L; decide text fidelity per §11.6 early — recommendation: per-drawing on-change canvas render, i.e. bounded readback). Retire `pixi-content-layer-bridge.js` (~4.6k lines) when done.

### Deferred / rejected (unchanged)
KTX2 spike (timeboxed, after B6); SDF shadows (Phase 6, after B2 proves the fragment pass); narrow opt-in Hi-Z (only if profiling shows opaque-stack cost post-B7); shared GL context (rejected, §11.5).

### Risk register (top 4)
1. **V3 visual divergence** → golden scenes + flag-flip A/B at every milestone (A2 is the insurance policy; do not skip it).
2. **Live-path audit scope creep** → hard timebox per file; the goal is "know the live path," not "perfect the file."
3. **Water rewrite stalls** → B5 is sequenced after B2–B4 prove the pipeline, and V2 water survives behind the flag until parity; a stalled B5 does not block B6/B7 for non-water scenes.
4. **Solo-dev bandwidth** → every item is independently landable; Stage A alone is a meaningful release even if Stage B waits.
