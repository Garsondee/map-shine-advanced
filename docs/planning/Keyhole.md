# KEYHOLE — The V3 Rebirth Plan

**Status:** ACTIVE BUILD PLAN (authored 2026-07-15). This document **supersedes Forward+.md §14–§16 as the plan of record.** Forward+.md remains the diagnosis archive — the evidence lives there; the build lives here.
**Author decision (2026-07-15, verbatim intent):** *"V2 is dead, long live the V3."* No band-aids, no fallback paths, a serious and complete refactoring. This document is the main vector of thrust for every session that follows.
**Audience:** a fresh session with zero context, and the author. Everything needed to start is in this file.

---

## 🧱 LAYERING, FOREGROUND & TILES — foundation landed 2026-07-16 (read this first; it changes §4.2 and §8)

**Author directive (2026-07-16):** get *"Foreground Tiles"* and *"Tiles"* working, researching the real vendored Foundry source rather than guessing; and *"examine your layering system in general because eventually we're going to have a huge number of effects on lots of floors so a strong ability to control visual layering is going to be key to long term viability."* Author chose full scope (foundation + foreground + tiles), chose to **draw tiles on every visible floor** (a deliberate divergence from Foundry — see below), and flagged **occlusion modes as critical**.

**The finding that reframes the whole task: "Foreground Tiles" is not a feature you build.** Foundry DELETED the `overhead`/`roof` booleans in v12 — `migrateOverheadTiles` reads `if (tile.overhead) tile.elevation = foregroundElevation`; the flag was converted into a number and dropped. A tile is "overhead in the Foreground" (the Tile sheet's own wording) **iff `tile.elevation >= level.elevation.top`** — which the UI labels *"Foreground Elevation"*. Implement one sort law over real elevations and both requested features fall out with **zero special-casing**. Full research, with source citations, is in project memory: `reference_foundry_v14_layering_law`.

**The layering law (adopted verbatim from `PrimaryCanvasGroup._compareObjects`, primary.mjs:480):**

> `elevation → sortLayer → sort → zIndex → tiebreak`, with `SORT_LAYERS {SCENE:0, TILES:500, DRAWINGS:600, TOKENS:700, WEATHER:1000}`.

Every drawable — level art, tiles, tokens, drawings, weather, and every future MSA effect — is ONE flat list under that key. **No band arithmetic:** sort the list, assign `renderOrder = index`. This replaces legacy's `LayerOrderPolicy.js` (`floorIndex*10000 + roleOffset`, 2400 slots/role), whose fixed capacity fails *silently* on overflow, whose key is a floor ordinal rather than an elevation (so it cannot express "this roof is at elevation 10"), and which needs a new enum entry per effect type. MSA's own effect bands claim the gaps Foundry left (`SCENE_EFFECTS 250`, `TILE_EFFECTS 550`, `TOKEN_EFFECTS 750`). This is the direct answer to the author's long-term-viability concern.

**A Level is an elevation BAND, and that is the entire roof mechanism.** `_configureLevelTextures` places a Level's background at `elevation.bottom` and its foreground at `elevation.top` — *different elevations*. Tiles and tokens authored on that floor sit between them. A token at 5 is under a roof at 10 because `5 < 10`; nothing is flagged.

**Two wrong assumptions corrected — both invisible until now, neither an edge case:**
1. **World space is NOT the background image's pixel space.** The renderer used a fullscreen quad with UVs remapped to the visible region, so "UV" and "world position" were the same number. But `Scene#padding` **defaults to 0.25** (the canvas is ~1.5× the art, with the art *inset* at `sceneRect`), `scene.width/height` are canvas pixels rather than the image's resolution (Foundry *fits* the image), and tiles are authored in canvas space. All three were harmless while nothing but a full-scene background was drawn — the image simply *was* the view. **Any tile exposes all three.** The 12,000² mansion is square with zero padding, which is luck, not correctness. World space is now Foundry canvas space (+Y down), and UV vs. world position are separate concepts.
2. **Non-square art threw, so most real scenes could not render at all.** `PageTable` assumed a square page grid. Square scene art is the exception, not the rule — this was a latent blocker sitting one scene away the entire time, on top of hard-blocking tiles (which are essentially never square). Now rectangular throughout, and cheaply: a mip halves both axes together, so the page **payload stays square** and the atlas/cache/upload/IndexedDB path is completely untouched — only the *grid* is rectangular.

**Landed, committed, and Node-tested (566 assertions; `d173b99`, `0027319`, `1c1b8ed`, `0367ac7`):**
- `src/scene/layer-order.js` — the law. **Parity-fuzzed against a transcription of Foundry's own comparator: 6000 random keys agree exactly, including ±Infinity** (Level elevations really are ±Infinity — `prepareBaseData` sets them).
- `src/foundry/scene-geometry.js` — the coordinate model. Replicates `Scene#getDimensions` (incl. the load-bearing `* (1/size)` reciprocal Foundry warns not to simplify), `PrimarySpriteMesh#resize` (all 5 fit modes, **signed** scale — a negative scale is how Foundry flips a tile), and the placement chain confirmed against `RectangleShapeData#_createCenter`: **`(x,y)` is the ANCHOR, not the top-left** — a default tile's anchor is 0.5, so its `x,y` is its *centre*.
- `src/foundry/scene-layers.js` — Scene documents → keyed draw items (level bg/fg + tiles). **Caught a real divergence before shipping:** `level.index`, which becomes the key's `sort` term, comes from `level.sort` and **not** elevation (`scene.mjs:371`); `getActiveSceneFloors` orders by `elevation.bottom`, correct for *its* job (which floor is "up") and a different question. Both numbers exist; neither substitutes.
- `src/scene/occlusion.js` — the occlusion model. Without it, correct layering yields a roof that permanently hides everything under it: accurate and unplayable.
- `src/scene/world-quad.js` — world-space geometry + the camera, built pure **specifically** because Y-flip is this project's recurring bug class and this is a brand-new world→screen mapping. **The camera carries the entire flip** (ortho with `top = minY`), so geometry uses raw Foundry coordinates and no term anywhere else needs negating — a negation that doesn't exist cannot be applied twice, which is how most prior Y-flips actually happened. The orientation chain (`world minY → NDC +1 → uv v=0 → image top row`) is asserted link by link in Node.

**Occlusion — why it is NOT blocked on Stage 5.** Foundry's design (adopted wholesale): ONE RGBA screen-space mask where **R=Fade, G=Radial, B=Vision, A=Surface**, each channel storing an **elevation index** (not a coverage value), MIN-blended so the lowest occluder wins; a drawable fades where the mask's stored elevation is below its own. Elevation comparison and shape coverage ride the same number, so one texture serves every drawable at every elevation with no per-pair work. **This needs token *documents* — position, elevation, `vision.los` — not token *rendering*.** Foundry stays authoritative for vision polygons (§4.3), so the occluder set is CPU data we already plan to consume. The model is fully ported and tested; only the mask render target + the 4-line shader remain.

**✅ RENDERER WIRING LANDED (`04e0d0e`) — AND NOW LIVE-CONFIRMED (2026-07-16), author's words: *"I can see tiles and they look correct. This was on a non-square map with multiple floors and multiple tiles with elevation."* and later, after the TSL port and the camera work, *"All floors work, layering is correct."* The rest of this paragraph is the original claim, kept because it was written before the evidence and turned out to hold.** The renderer is item-based and world-space: a floor's background, its foreground (roof) art and every tile are peers, each with its own virtual texture and its own quad in canvas space, all ordered by the one sort law. The camera replaces the fullscreen-quad/UV-remap model (and with it `reframeLayer`/`reframeVisibleLayers`, and the UV-compounding bug class that path produced live — a rewrite that reads its own previous output cannot compound if it does not exist). Residency now plans in each item's **image space** (`viewRectToImageRect` + `computeItemViewportPx`); passing the canvas size to `chooseMip` instead would make every small tile stream full resolution — O(tiles), the exact cost model this architecture exists to destroy. `view-state.js` is rectangular. `boot.js` feeds items from `collectSceneLayers` for real scenes and from a synthetic fabricator for the torture fixture — **one renderer, one path**. 574 Node assertions green, lint clean, boot bundles, fence clean. **None of it has rendered a pixel yet** — the risky math is Node-proven (orientation, placement, image-rect, the sort law) but the wiring is not.

**⬜ THE REMAINING PIECE: the occlusion mask PRODUCER — still the last piece of this directive, and now finally TESTABLE.** Author's ordering correction (2026-07-16), which was right and reframes the sequence: *"In order to test occlusion we actually need to have token rendering working first. Just basic token rendering and selection, not vision or fog of war. Then we can test if the tiles are correctly occluding."* Occlusion IS tokens fading roofs — with nothing on the board there is nothing to fade and nothing to verify, so a producer built first could only be trusted, never checked. **Tokens now render (see the TOKENS section below), so this is unblocked.** Two gaps found while debugging that will bite the moment the mask is real: `maskUV` is fed `positionGeometry.xy` (WORLD coords) where it needs a SCREEN-space UV; and `mapElevation(table, elev)` returns **1 for every item** against the placeholder table `[-Infinity]`, since everything exceeds -Infinity.

**The original statement of the piece:** The shader path is real and implements Foundry's algorithm verbatim in shape (`occlusion.mjs:16` — four channels, the elevation-index `step` test, `max` across weights, the alpha mix), fed by the ported model (`scene/occlusion.js`) with real document data. What is missing is the thing that WRITES the mask: rendering each occludable token's `vision.los` polygon and radial disc into a screen-space RGBA render target with **MIN blending**, rebuilt when perception changes, plus `_identifyOccludedObjects` (the alpha-thresholded hit test that sets each item's `occluded` boolean, which is what gates FADE). Until then the mask is an inert 1×1 using Foundry's own clear value `[0,1,1,1]` — literally "nothing occludes anything" — so every item renders unoccluded and switching the producer on is purely additive: build it, point the uniform at its render texture, feed real weights. **Also tracked:** `vt-pan-viewer.js` now imports from `scene/` and `foundry/` and is really the scene renderer — it belongs at `src/scene/scene-renderer.js`; a mechanical rename, deliberately not bundled into a structural commit.

---

## 📍 CURRENT STATUS (updated 2026-07-16 late — read this before §8's stage narrative)

**Branch `keyhole`. Stage 0 ✅, Stage 1 ✅, Stage 2 🔶 (core proven, formal metrics not captured). Two things landed since the last update that were NOT on the stage ladder at all, both author-directed, both live-confirmed: the TSL/WebGPU port (§9 Q3) and TOKENS + the input model (§4.7, new).**

### ✅ THE TSL/WebGPU PORT IS DONE AND LIVE-CONFIRMED

Q3's overturn (§9) is executed, not just decided. `WebGPURenderer` (reports `backend: "webgpu"`), `NodeMaterial`, the VT sampler as a TSL `Fn` — **the GLSL is deleted, not kept alongside.** Author-confirmed on a real 3-floor 16050×7650 scene: *"The real shader is working and not washed out. All floors work, layering is correct."* ~0.36 ms/frame, 0 misses, 0 evictions at rest. `three.webgpu.js` vendored via `npm run build:three-webgpu`.

**The safety slide (§4.3) got its first REAL test and passed** — unprompted. A renderer exception during startup made MSA stand down, announce itself, and hand the author a working Foundry session. It also now auto-dismisses after 20 s (author: the banner *"linger[ed] on the screen forever"*; it had done its job once read, after which it was a red bar bolted over the map — the state still lives in `getRenderMode()` and the diagnostics forever, only the pixels expire).

**The whole port cost one session to ONE bug, and it is worth reading before writing any TSL:** `reference_tsl_method_chaining_trap` in project memory. TSL's `.mix()` METHOD takes its receiver as the **interpolant** — three.js defines `mixElement = (t, e1, e2) => mix(e1, e2, t)`, so `a.mix(b, t)` compiles to `mix(b, t, a)`, silently, with no type error. `uUnoccludedAlpha.mix(uOccludedAlpha, occ)` reads as `mix(1, 0, 0) == 1` (an identity) and compiled to `mix(0, occ, 1) == 0` — **alpha × 0, the entire map black**, while every uniform printed correct. ONE root cause, THREE bugs: the black screen, the washed-out map (the sRGB decode never ran despite `srgbDecode: 1` binding correctly), and the mip cross-fade. **Rule: always the FUNCTION form, `mix(a, b, t)`. Never the method.** (`.smoothstep()` is the same trap.)

**Also learned, and it generalises past TSL:** colour space is a property of the DATA, not the texture. ONE atlas holds both albedo pages and mask pages, so `texture.colorSpace = SRGBColorSpace` would have fixed the map and silently corrupted every mask. The decode is per-pack, in-shader, driven by `pack.name`.

### ✅ TOKENS RENDER, AND FOUNDRY OWNS ALL INPUT (§4.7 — new, and it changes §4.3)

Author-confirmed: *"Tokens now land exactly where they should be and the mouse changes to a pointer in the exact correct places. Pan and zoom seems perfectly aligned with tokens."* Y-flip survived a brand-new world→screen mapping. See §4.7 for the decision and its rationale.

### 🐞 THE ONE CONFIRMED OPEN BUG — dangling indirection texels on eviction

**Verified by grep, not theorised.** `src/vt/page-cache.js` evicts a page's slot and reuses it, and **nothing clears the previous owner's indirection texel** — `onEvict` / `evictCallback` / `clearIndirection` return **zero hits** across `src/vt/`. The old pack's page table still says "my page is in slot N" while slot N now holds another pack's pixels, so it samples the wrong content until residency happens to rewrite the texel.

**Repro (author): dropping a token onto the board flashes rectangular texture garbage, then it resolves.** Trigger is precisely **a new pack arriving at a full cache** — a token IS a new pack. The zoom-time "misplaced tiles" was the same defect; it stopped appearing only because the camera fight stopped thrashing residency, which was *masking the trigger, not fixing the bug*. The cache exhaustion reported alongside it (`2048/2048`, `freePages: 0`, ~1700 evictions, multi-second frame gaps) was a symptom of that same fight.

**The invariant to restore:** a slot must not be reusable until every indirection texel pointing at it is cleared. Same CLASS as `7baca4a` (release → measure → request), which fixed double-pinning on *transitions* but never covered eviction. Prefer making the cache own an evict callback over sprinkling clears at call sites.

### Still open, in likely order

1. **The eviction bug above** — it is the only confirmed correctness defect.
2. **Pan/zoom is "better, not smooth like before"** — probably residency work per camera change. RE-MEASURE now the view is correct; do not guess.
3. **Selection is NOT built** — and per §4.7 Foundry does the hit-testing, so `pickTokenAt`/`tokenContainsPoint` in `scene-tokens.js` are likely unnecessary. Check before building anything on them.
4. **The occlusion mask producer** — the last piece of the tiles directive, now testable.
5. Stage 2's formal gate metrics (full PIXI residency, load time, `texImage2D` timing); Tile-document proxying; a second real scene.
6. `vt-pan-viewer.js` belongs at `src/scene/scene-renderer.js` — a mechanical rename, still not done.

### 🔬 THE METHODOLOGY LESSON OF THIS SESSION — read `feedback_instruments_must_not_lie`

**Six wrong theories on the black screen; the bisect ladder found it in four clicks.** What actually worked, every time, was rendering ONE layer of the graph at a time and letting the author's eyes report. What failed, every time, was reading the code and reasoning. **When printed values say a bug is impossible but the screen disagrees, suspect the OPERATION, not the values** — printing the occlusion uniforms proved the weights were clean zeros, which is what forced the search onto `mix` itself.

**FIVE self-deceiving instruments in one session**, each costing a full round-trip: a pixel readback using deprecated `renderAsync` that read all-zero off a **visibly red** frame; a page-table probe reading mip 0 while the view sat at mip 2; a greyscale `occ` display that made "not occluded" and "the draw failed" the same colour; forced-alpha bisect stages that hid the layers beneath; and a bare `continue` that binned three tokens while the report said `skipped: []`. **"I could not measure this" must never look like "the thing is broken." Every skip reports its reason.** An instrument's output is what decisions are made from, so it deserves MORE scepticism than the code under test, not less.

**And twice the author out-reasoned me from the diagnostics I had sent them** — *"Could it be a problem with adding tokens to the scene and not with rendering them?"* (it was) and *"what would make it so that only the first token was rendered?"* (nothing could — which is what proved the skip was silent). Both times the datum was already in a report I had written.

---

## 0. Read this first

**The name:** you view a 144-megapixel world through a ~3-megapixel screen. You are always looking through a **keyhole**. A renderer that holds only what the keyhole shows cannot run out of memory, no matter how large the world grows. A renderer that holds the world always will. MSA has always held the world. That is the entire crisis, and this plan ends it.

**The goal (author's stated end-state):** the module absorbs **12,000×12,000 px textures, many of them, on multiple floors**, and does whatever it needs to during loading so this is never a context-killing problem. This plan designs for **16K² × 4 floors** so 12K³ sits inside the envelope with margin.

**The one law:**

> **Nothing is ever allocated at world resolution. Ever. Everything world-sized pages through a fixed-size cache.**

Not a budget we police. An architectural impossibility, enforced in the allocator (§4.6). If the code physically cannot hold a 12K texture, it cannot crash from one.

**The doctrine (author-mandated):**

1. **One path per behavior.** No fallback that routes through legacy code. If a capability isn't built yet, the feature is *absent and fails loudly* — it is never quietly served by V2.
2. **Legacy is frozen and quarantined** (§5). It stops being a runtime and becomes a reference library + parts donor. New code never imports it.
3. **Degradation happens inside the new system's own knobs** (render scale, page budget, effect toggles) — never by switching architectures.
4. **The hard case ships first.** The 12K×3-floor torture scene is Stage 0's fixture and every stage's gate — not the final boss discovered last.
5. **Instruments must not lie** (added 2026-07-16, earned the hard way — five self-deceiving instruments in one session, each costing a live round-trip; see CURRENT STATUS's methodology note and `feedback_instruments_must_not_lie`). *"I could not measure this"* must never look like *"the thing is broken."* Never encode a result on an axis where a failure lands on a valid value. **Every skip, drop and early-return reports its reason and its id** — `skipped: []` must mean *nothing was skipped*, never *I didn't look*. When a measurement contradicts a working system, suspect the measurement. And when printed values say a bug is impossible but the screen disagrees, **suspect the OPERATION, not the values**.
6. **Debug UI: one action = one control** (author, 2026-07-16). Never ship a button whose next step is always another button — if an action always follows, it is part of that action. Mutually-exclusive modes are a dropdown (`MapShine.debug.registerSelect`), persisted so a refresh keeps them. **Debugging scaffolding is culled once it has found its bug**, per the standing tidy-up directive; it does not become furniture.

---

## 1. The evidence (why this is the only remaining move)

Field-calibrated numbers from the 2026-07 crash campaign (full trail: Forward+.md §13, crash-report JSONs, four instrumented rounds on 2026-07-15). Hardware reference: **RTX 3070 Laptop, 8 GB, ANGLE/D3D11, Chrome** — the design-floor card.

| Fact | Number | Source |
|---|---|---|
| Usable browser-WebGL memory on the 8 GB card | **~1.6 GB** (context loss observed ~1.6–1.8 GB) | vram-ledger field calibration |
| V2 compositor RT cost | **470–580 MB per drawing-buffer megapixel** (→ 3.3–3.6 GB at native 6.16 MP) | rtVramEstimate, 3 reports |
| Foundry PIXI duplicate copies of art MSA already has | **~719 MB steady**, incl. **one 8250² `LightCovers.webp` = 345 MB** | pixiTextures section, every report |
| PIXI re-upload storm (6408×5121 `texImage2D` ~100–300 ms each) | continuous, entire session | slowGlOps, every report |
| World-res masks resident (already scaled to 0.35!) | **341–509 MB** | TextureBudgetTracker |
| Aggregate on the Church scene (8250², 3 floors) | **102–103% of ceiling** — masks+PIXI alone = 75% before one RT exists | vramLedger |
| Full-res CPU mask scan (fire spawn points) | 8250² `getImageData` = **260 MB heap + 550–850 ms stall per load** | bigCanvasOps |

Four rounds of instrumented fixes (pacing queues, VRAM ledger, dynamic resolution, PIXI demotion, preload-race guards) each fixed a real bug and each moved the crash without killing it. **That is the signature of a correct diagnosis at the wrong layer.** The cost model is `O(world × floors × masks)`; the card is `O(fixed)`. No reactive mechanism reconciles those. Only changing the cost model to `O(screen)` does.

**Proof it fits once the law holds** (native 6.16 MP display, 3 MP internal, worst case):

| Consumer under Keyhole | Budget |
|---|---|
| Virtual-texture page cache (fixed, all floors, all masks, all art) | **512 MB** (hard) |
| Frame-graph RTs at 3 MP internal (§4.2 math) | ~180 MB (≤ 370 MB at full native internal) |
| Foundry PIXI (proxy textures only, §4.3) | **< 60 MB** |
| Streaming scratch + decode ring + misc | ~150 MB |
| Fog exploration (capped, whitelisted, §4.4) | ~50 MB |
| **Total worst case** | **≈ 0.95–1.15 GB vs 1.6 GB ceiling** |

World size does not appear in that table. That is the whole point. A 16K map adds one mip level to a pyramid on disk and nothing to VRAM.

---

## 2. What V3 got right and what it never got

V3 (scripts/compositor-v3/) is **not being discarded — it is being completed.** It got the *drawing* right: frame graph, unified geometry, Foundry-v14-accurate forward lighting with wall clipping, DRS governor, per-pass GPU timing, present/tonemap. All of that is harvested nearly intact (§6).

What it never got: **its own memory model.** It rides V2's FloorRenderBus, V2's GpuSceneMaskCompositor (world-res mask bakes), V2's effect instances (world-res private RTs), and leaves Foundry's PIXI holding full-res duplicates. That is why V3 crashes identically to V2. Keyhole = V3's pipeline + a paged memory core + a severed Foundry bridge, with V2 removed from the loop entirely.

---

## 3. Naming, versioning, tree layout

- **Codename:** Keyhole. Ships as **Map Shine Advanced 0.6.0**. Same module id, same scene/tile flag schema (author content keeps working; flags are data, not code).
- **New code root: `src/`.** `module.json` `esmodules` points at `src/boot.js` and nothing else.
- **Three.js:** upgrade to current release in `src/vendor/`. Legacy keeps its old copy; they never run in the same session, so no compatibility work.
- **Legacy root: `scripts/` → renamed `legacy/` at Stage 0.** See §5.

```
src/
  boot.js                 # init/ready hooks, adapter bring-up — the ONLY entry
  vt/                     # the virtual texture core (the new part)
    page-cache.js         #   physical atlas array + LRU + pin sets
    page-table.js         #   per-virtual-texture indirection
    residency.js          #   analytic visible-page computation (no GPU feedback)
    pyramid-builder.js    #   harvested, re-sliced to page format
    pyramid-store.js      #   harvested IndexedDB store
    decode-pool.js/.worker.js  # harvested worker decode + per-page extraction
    upload-governor.js    #   harvested gpu-work-scheduler
    mask-catalog.js       #   mask semantics + channel-packing plan
    vt-sample.glsl.js     #   THE shared sampler include every consumer uses
  graph/                  # harvested V3 frame graph, allocator (law-enforcing), perf, present
  scene/                  # floor model, unified geometry pass, attribute buffer, view-rect
  foundry/                # the ONE adapter: hooks, documents, PROXY TEXTURES, vision polys, levels flags
  gameplay/               # native tokens, walls, fog/vision, templates, drawings, interaction
  effects/                # lighting (harvested), grade, bloom, water, fire, vegetation, weather, post
  world/                  # LightingDirector, weather, wind, time-of-day (harvested)
  ui/                     # loading overlay, graphics settings, tweakpane shells (harvested, rebound)
  diag/                   # crash recovery, ledger (telemetry+assert), leak probe, profiler (harvested)
```

---

## 4. Target architecture

### 4.1 The virtual texture core (`src/vt/`) — the genuinely new part

**Page format.** 256×256-texel RGBA8 pages, 4-texel borders baked on all sides (248² payload). 256 KB per page. Rationale: big enough that indirection tables stay tiny, small enough that one upload is invisible (~0.25 MB `texSubImage2D` — the 100–300 ms giant-upload class of GL stall becomes *unrepresentable*).

**Physical cache.** One `THREE.DataArrayTexture` (or N 4096² atlases if array-texture filtering disappoints): 4096² holds 16×16=256 pages = 64 MB/layer; 8 layers = **2048 pages = 512 MB, allocated once at boot, never resized, never exceeded.** Budget scales by GPU tier (4 GB → 256 MB, 8 GB → 512 MB, 16 GB+ → 1 GB) but is *fixed for the session*. LRU eviction; two pin classes that are never evicted:
- **Coarse pins:** the top mips of every layer of every floor (whole world at low res — ~tens of pages total). Guarantees the *entire scene renders, always, instantly*, just soft. There is no "grey fallback" state and no "not resident → crash" state. Worst case is blur, never black, never loss.
- **Active-view ring:** current visible set + 1-page guard ring + next-coarser mip.

**Page tables.** Per virtual texture (per floor × per layer-pack): a tiny RGBA8 indirection texture (≤64×64 per mip; a 12K world at 248-texel pages is 49×49 pages at mip 0) encoding atlas slot + resident mip + flags. VRAM cost: negligible (<2 MB total for the torture scene).

**Sampling.** One shared GLSL include, `vtSample(layerPack, worldUV)`: indirection fetch → atlas fetch with border-safe UV, per-page mip clamp to the finest-resident level (automatic coarse fallback — this is what makes "not loaded yet" mean "soft," not "wrong"). Every consumer — geometry, masks, effects — samples through this include and nothing else. Bilinear only (top-down maps need no anisotropy).

**Residency is analytic — no GPU feedback pass.** This is the huge simplification vs. id-Tech-style SVT and the reason this is *less* exotic than it sounds: MSA's camera is top-down. The visible world rect (already computed every frame by `view-projection-service.getVisibleWorldRect()` — harvested) + zoom gives *exactly* the needed page range and mip per layer per visible floor, on the CPU, in microseconds. Miss lists go to the decode pool; uploads go through the harvested upload governor (MB/frame credit).

**Sources & the pyramid.** The harvested `texture-pyramid-builder` + IndexedDB store already slice source images into tiled mip pyramids — re-target the slice geometry to the page format (248 payload + 4 border) and extend coverage from "background/foreground images only" to **every authored input: albedo AND all 15 mask types** (this closes Forward+ §2.4's "streaming covers images, not masks" — the core reason streaming "wasn't enough"). First encounter with an asset slices it once (paced, worker-decoded) and persists to IndexedDB keyed by URL+mtime; every later load streams pages only. An optional offline pre-slicer tool comes later (§9 Q4) — nice, not required.

**Mask channel-packing.** 13 painted masks are mostly single-channel. Pack into layer-packs so the working set stays small (final packing decided by the Stage 4 audit against `legacy/scripts/masks/mask-catalog.js`; `mask-channel-pack.js`'s `PACKABLE_BINARY_MASKS` is the head start). Planning assumption: **≤6 layer-packs per floor** (albedo, surface-response pack, environment pack, sim pack, normal, windows/emissive). Working-set math at 3 MP internal: ~49 pages/layer visible → 6 packs × 3 floors × 49 ≈ 880 pages ≈ **220 MB — under half the cache, with prefetch headroom.** Upper floors are mostly transparent and consume far less in practice.

**⚠️ CORRECTED (2026-07-16, author-confirmed real mask taxonomy — this section's original "13→6" estimate was optimistic):** of the torture fixture's 7 masks, only 3 are genuinely single-channel and channel-packable (`_Shadow` black=dark/white=lit, `_Outdoors` white=out/black=in, `_Fire` white=fire-spawn) — they pack into R/G/B of one RGBA texture with a SHARED alpha for the structural hole (the transparent hole in an upper floor is a property of the FLOOR, identical across every mask on that floor, not per-mask — confirmed by the author, and what makes one shared alpha channel valid for all three). The rest are NOT packable: `_Specular`/`_Window` carry actual COLOUR (metallic tint / light colour) and need a full RGB channel each; `_Tree`/`_Bush` are RGBA colour+coverage. **Real math: 7 masks → 4 packs**, not 13→6 — channel-packing is a real but bounded win, built and live-testable on the representative fixture (`tools/make-torture-world.mjs`, regenerated 2026-07-15/16 to match this real taxonomy instead of an earlier grayscale-everything approximation).

**Per-page CPU extraction (kills the getImageData class).** Any CPU consumer of mask pixels (fire spawn points, vegetation clump fields, map-point seeding) registers a per-page extractor that runs *in the decode worker at decode time* on 248² pages, accumulating world-space results incrementally. The 8250² 260 MB `getImageData` in `fire-behaviors.js:readImageRgba` — flagged in every crash report — becomes structurally impossible.

### 4.2 The frame graph and O(screen) render targets (`src/graph/`, `src/scene/`)

Harvest V3's FrameGraph/ThreeAllocator/GpuPassTimer/v3-perf/FullscreenPresent nearly whole. Pass list (evolves, but the *inventory* is law-bound):

`sims → vtResidency → geometry(unified, MRT) → lighting → water → effects → post → present`

- **Unified geometry (exists in V3):** all visible floors drawn at real Z in one pass, `alphaTest` for floor holes, sampling albedo via `vtSample`. **MRT writes the B0-1 attribute buffer at last:** `scene.color` (RGBA16F) + `scene.attr` (RGBA8: floorId, outdoors, overhead/roof coverage, material flags). The attribute buffer is what makes shadows, water occlusion, and per-pixel floor gating *cheap screen-space reads* instead of per-floor RT stacks — it was always the keystone (docs/planning/v3/B0-1) and it lands here, early, not last.
- **Lighting:** harvested `ForwardLightingPass` (Foundry-v14 model, wall-clipped, MAX-blend illum + SCREEN coloration) rendering into `scene.illum`; composite `lit = albedo × illum`. Indoor/outdoor ambient reads `scene.attr` (no more world-res outdoors RT resolves).
- **RT inventory at 3 MP internal** (allocator-enforced): color 24 MB + attr 12 + depth 12 + illum 24 + lit 24 + post ping/pong 48 + bloom chain ~8 + water/fog screen buffers ~30 ≈ **~180 MB.** At uncapped native 6.16 MP ≈ 370 MB. Versus V2's 1.1–3.6 GB. DRS (harvested governor) remains the fine-tuning knob, no longer the survival mechanism.

### 4.3 The Foundry adapter and the severed bridge (`src/foundry/`, `src/gameplay/`)

**Proxy textures — prevention, not demotion (the single biggest instant win).** Intercept Foundry's texture loading for scene backgrounds and tile documents *before* PIXI ever decodes them, and hand PIXI a ≤1024px proxy generated from our own pyramid (the mip already exists in IndexedDB). Foundry never touches the 8250² file. This kills, permanently and by construction: the 719 MB PIXI residency, the 345 MB LightCovers hostage, the continuous 6408×5121 re-upload storm, *and* the browser-process decode spikes on every `canvas.draw`. The five generations of demotion/sweep machinery become deletable. (Foundry scales tile meshes to document dimensions regardless of texture resolution, and the PIXI canvas is visually suppressed under MSA anyway — the only observable cost is lower-fidelity alpha in PIXI-side hover hit-tests. Accepted.)

**What Foundry remains authoritative for (documents & simulation — never rendered by PIXI on our watch):** scene/tile/token/wall/light documents, vision & fog *computation* (`ClockwiseSweepPolygon` LOS/FOV polygons — CPU data we consume), levels flags, turn order, chat, all DOM UI.

**What becomes natively rendered in `src/gameplay/` (completing the severance Forward+ §11 designed):** tokens (TokenManager already native — harvest + re-seat), fog-of-war (FogOfWarEffectV2 already native — harvest), wall-editing visuals, measured templates, drawings, sound/note icons, token HUD anchoring. `pixi-content-layer-bridge.js` and its `extract.canvas` GPU→CPU readbacks are **deleted at Stage 5**, not bypassed.

**The one legitimate switch:** the existing `useNativeFoundryRendering` world/client setting = MSA fully off (pure Foundry, no proxies, no keyhole). That is an off-switch, not a fallback path, and it stays.

**LONG-TERM DIRECTION (author decision 2026-07-15, explicitly not near-term work — recorded here so it isn't lost, not scheduled): a TIERED reliability fallback, not just a binary switch.** The target end-state is WebGPU → WebGL2 → native Foundry PIXI rendering, attempted in that order, so a player whose hardware can't sustain Keyhole's best effort is never the reason a session stalls or a browser crashes mid-game. Two concrete mechanisms, both future work:
1. **Automatic capability detection at boot** — try WebGPU, fall to WebGL2, fall to the `useNativeFoundryRendering` off-switch, without requiring the player to know anything is wrong.
2. **GM-enforceable, mid-session** — a GM option to force any player (or the whole table) onto a lower tier if problems start happening live, not just a boot-time preference.

**⚠️ ITS LAST RUNG IS NOW BUILT (2026-07-16, `da8470b`) — because the alternative turned out to be actively harmful, not merely absent.** `diag/render-fallback.js#engageFoundryFallback` hands rendering back to Foundry on any renderer failure and announces it unmissably (a `pointer-events:none` banner that cannot interfere and is deliberately not dismissible, plus a notification, plus `renderMode` in every diagnostics report). Two lessons worth keeping. **(1) The doctrine reading that nearly prevented it:** doctrine #1 was applied to a total renderer failure and refused the slide, mounting an error wall instead. That is wrong — doctrine #1 forbids silently patching a missing V3 *feature* with V2 code mid-build; a dead renderer is the opposite shape, exactly as this section already said. The test: is legacy code quietly standing in for a Keyhole feature that should exist? → forbidden. Is the whole renderer down and Foundry keeping the session alive? → sanctioned, and required. **(2) The code was BLOCKING the slide:** `vt-pan-viewer` appends its canvas before the WebGL renderer is even constructed, and that canvas is opaque (`background:#000`) — so a Three.js/WebGL failure left a black rectangle over a perfectly healthy Foundry canvas, costing the player a session Foundry could have absorbed entirely. Tearing the canvas down is the load-bearing half of the fix. The full ladder (WebGPU → WebGL2, auto-detected + GM-enforceable mid-session) remains deferred as below.

This is a deliberate, explicit, WHOLE-RENDERER safety valve — the same *kind* of thing as the off-switch above, just evolved from a static manual toggle into an intelligent tiered ladder. It does **not** relax §0's doctrine #1 ("no fallback that routes through legacy code") or #3 ("degradation happens inside the new system's own knobs... never by switching architectures"): those forbid silently patching a missing V3 *feature* with legacy code mid-build. This is the opposite shape — a conscious, top-level, whole-system mode change, off by default, that never quietly substitutes for unbuilt Keyhole capability. Author's own framing: *"This isn't scope creep, this is about keeping the reliability/safety of running the module paramount over the visuals."* The natural landing spot is alongside §16's W-track WebGPU-convergence work (Q3 below) — build it when that work is underway, not before.

### 4.4 Effects: ~48 classes collapse into ~10 passes + shader ports (`src/effects/`)

The V2 effect *look* is the product — the shaders and their tuned parameters are harvested per effect out of `legacy/`; the *machinery* (per-effect world-res RTs, populate pipelines, binding managers) is not. Mapping:

| V2 family | Keyhole home |
|---|---|
| Specular, Roughness, Iridescence, Prism, Normal | one **surface-response** term in lighting/material pass, sampling the packed VT layer |
| LightingEffectV2, WindowLight, PlayerLight, VisionMode | forward-lighting extensions (emissive from VT windows layer; injected sources; post) |
| CC/Grade (ToD + contextual), Bloom, Sepia + stylizer chain, AtmosphericFog, DepthBlur, Distortion | frame-graph **post chain** (V3PostBridge already runs CC/bloom — re-seat natively) |
| Water + Splashes | dedicated **water pass** — see below |
| Fire, CandleFlames, coals | **sims** pass; spawn points from per-page extraction (§4.1) |
| Tree/Bush (billboards, canopy, sway) + their shadows | vegetation geometry + shadow passes; clump fields from per-page extraction |
| BuildingShadows, SkyReach, OverheadStamp (~19–35 RTs today!), VegBillboardShadow | one **unified shadow pass** over the attribute buffer (the B0-1 payoff) |
| Weather particles, Clouds/AshClouds + cloud shadows, Lightning | sims + screen passes (cloud sprites already lazy/paced — harvest) |
| FogOfWar | native, harvested (see fog note below) |

**Water is the honest hard case** (Forward+ §4.2: the river must render *and simulate* under plank gaps of the floor above). Keyhole makes the plumbing easier — upper-floor coverage/occluders are attribute-buffer reads, not bespoke RT chains — but the cross-floor sim-source rule (`_resolveWaterSourceFloorForView` semantics) is ported deliberately, with its own design note, as the **first** Stage 6 effect while energy is high. Sim grids are sim-res (not world-res) and already law-compliant.

**Fog exploration is the one sanctioned world-space persistent buffer:** capped ≤2048² per floor (≈16 MB × floors), explicitly whitelisted in the allocator. Revisit as read-write VT pages later if it ever matters; at the cap, it can't.

### 4.4b Effect LAYOUT — see `docs/planning/Effects.md` (spec authored 2026-07-16)

§4.4 says WHICH effects exist and where they land. **`Effects.md` says how each one is LAID OUT so it costs what the machine can afford** — the author's tiering directive (*"the most basic tier being deliberately lightweight"*, §9 Q3) taken to a spec. Read it before porting any effect.

Its thesis is this plan's own, moved from the memory axis to the time axis: **tier 0 is the effect's coarse pin** — always compiled, always drawn, cheap enough for the floor card, never gated. Worst case is flat, never absent. *Water is always blue.* And it resolves `keyhole-stage6-effects-approach`'s standing tension (design the full feature set, ship a minimal slice, don't let the deferred list rot) by making the ladder and the deferred list **the same artifact**: tier 0 IS the MVP, tiers 1..N ARE the recorded feature set, ordered and costed, and a rung nobody's hardware reaches is visible rather than forgotten.

The two laws most likely to be violated by accident, both learned here the hard way:
- **Gating by uniform is NOT gating.** A `uniform(0)` multiply executes every pixel and pays for its bindings — exactly what the occlusion block did at `weights [0,0,0,0]` while being arithmetically an identity. Tier selection is a **JS `if` at graph-build time** so the nodes are never constructed. If turning a feature off does not shrink the compiled shader, it is not off.
- **Order the ladder by COST CLASS, not by prettiness** (constant → ALU → resident read → graph read → VT read → dependent read → extra RT → per-frame sim → geometry). Sorted that way, the cheap rungs cluster at the bottom — and the cheap rungs carry nearly all the perceptual return, because vision cares more about colour, contrast and motion than about correct refraction.

### 4.4c Effect CONTRACT — see `docs/planning/Effects-API.md` (research + spec, 2026-07-16)

`Effects.md` says how an effect is TIERED. **`Effects-API.md` says what an effect may TOUCH** — designed from a direct audit of V2's ~97,000 lines of effects, at the author's direction (*"look for the things that each effect consumes and produces... a sensible API structure... would turn a mess of individual effect concepts into a unified plan"*).

**The measurement that justifies §7's kill list:** `FloorCompositor` is 10,063 lines and knows **46 effects by name across 643 touch points** (~14 per effect). Effects reach into `window.MapShine` **479 times**, allocate **70 private render targets**, expose **5 different `render()` signatures** — and **zero** of them declare an input, an output, or a dependency. Nothing is declared, so everything is discovered by hand, by the caller, forever. `Lighting` reads `Fire`'s private `_glowBucketsByFloor`; `Fire` reads `Lighting`'s params. **A cycle, through a global, through privates.**

**THE finding, and it reframes what "design a better API" has to mean:** `legacy/effects/EffectComposer.js` ALREADY has the right design — declared layers with numeric order (`BASE:0 … POST_PROCESSING:500`), independently the same shape as this plan's own sort law. **It is used in one place outside its own file, a console helper. It has 5 importers; `FloorCompositor` has 92.** V2 did not fail from lack of design — the good abstraction existed and 46 effects walked past it, because the god-object was easier. **A good API that is optional is a good API that loses.** This is doctrine #5 (*"make relapse harder than doing it right"*) proven in this codebase at a cost of 97k lines — so the contract must be the ONLY door, enforced by absence (an effect's `ctx` holds exactly its declared reads and there is nothing else to reach with), never by policy.

**The hopeful finding:** the Lighting↔Fire knot is **fake**. `wallPaddingPx` is a *default param value* — a constant — that Fire fetches by rummaging in Lighting. Two effects SHARING AN INPUT, expressed as one reaching into the other. The real graph is a DAG. Declaring inputs does not manage that knot, it **dissolves** it — and most of V2's "interweaving" is likely the same shape, which makes Stage 6 less entangled than 97k lines suggests. Much of that bulk is *wiring* (bespoke setters, floor-index resolution, overlay lifecycle, perf plumbing) that exists ONLY because there is no contract, and evaporates under one.

### 4.5 Loading & floor switching — reliability > smooth > quick, made structural

- **Initial load:** mount page tables → stream **coarse pins** (tiny — the whole world soft-focus in well under a second of decode) → reveal behind the existing curtain with *honest* progress (pages resident / pages needed) → sharpen progressively under the upload governor. No 45-second all-or-nothing storm; no un-chunkable populate loop; no fake "Ready!". Interactive target on the torture scene: **≤ 10 s** on the 3070.
- **Floor switch = uniform write + working-set shift.** Coarse pins for *every* floor are always resident, so the target floor renders instantly (soft for ~200–500 ms while its sharp ring streams). **No curtain, no rebuild, no `canvas.scene.view` redraw cost** (and with proxy textures, even Foundry's own level redraw becomes ~100× lighter). The level-transition curtain is deleted with V2. This is the "floor changes without loading screens" headline promise, delivered by construction rather than by cache-warming heroics.

### 4.6 Enforcement — making the law physical

- `graph/ThreeAllocator` **throws** on any texture/RT allocation with a dimension > 2048 unless it is the page atlas itself or on the explicit whitelist (`fogExploration`, present chain). A world-res allocation is a crash *in dev, at the call site, with a stack* — not a context loss in the field three weeks later.
- `src/` may not import `legacy/` — enforced by a grep check in the release script (and ESLint if configured). Harvest = `git mv` into `src/` + fix imports; never a cross-boundary import.
- `diag/ledger` (harvested) runs in **assert mode** during dev: aggregate pressure > 0.9 logs an error with the last-allocation stack. Its reactive resize trigger from the 2026-07-15 session is **removed** — under a fixed-allocation core there is nothing to reactively resize. It becomes pure telemetry + tripwire.
- The crash reporter (harvested wholesale — it earned it) keeps the `vramLedger` section; a Keyhole report showing `overCeiling:true` is a *bug in the law's enforcement*, not weather.

---

### 4.7 Input & the camera — FOUNDRY OWNS ALL INPUT, MSA MIRRORS ITS CAMERA (author decision 2026-07-16, LOCKED)

**MSA's canvas is `pointer-events: none`. Every click, drag, drop, marquee, target and context-menu goes to Foundry exactly as it does without the module. MSA has NO camera of its own on a real scene — it FOLLOWS `canvas.stage`, read per-frame in the render loop.** This completes §4.3's split: MSA replaces **rendering**; Foundry keeps documents, simulation, *and interaction*.

**How it was found, because the bug is the argument.** The author dropped tokens onto a scene and none appeared. Four rounds went into the renderer. Then `diagnoseTokens` read `canvas.scene.tokens` directly and reported **`tokenDocsFound: 1`**: the scene contained ONE token document. Nothing was mis-collected or mis-rendered — **the drops never created documents at all.** MSA's canvas (`pointerEvents: 'auto'`, `zIndex: 5`, over Foundry's board) was swallowing them. Same cause as marquee-select doing nothing. The author reasoned to it before I did: *"Could it be a problem with adding tokens to the scene and not with rendering them?"* — while `occludingPixi: true` sat in every report, a field this plan had ALREADY twice named as the thing that blocked the safety slide (§4.3), without anyone asking what else it implied.

**Why this model, not the alternative.** Interaction is a large, well-tested surface that other modules hook into; re-implementing drop/select/drag/target/context-menus means owning it forever and breaking every module that expects Foundry's. And **a second camera is a second source of truth** — the moment MSA's view and Foundry's stage disagree, drops land at the wrong world point and every hit-test is subtly wrong. One camera, Foundry's, read not owned.

**The mapping, read from the v14 source rather than assumed** (`client/canvas/board.mjs:1703-1715`): `stage.pivot` IS the world centre, `stage.scale` is uniform screen-px-per-world-px, `canvasPan` fires on every change. So `halfSpanPx = (viewportHeight / 2) / scale`. **The axis is not a detail** — `viewToWorldRect` derives `halfX = halfSpanPx * aspect`, so `halfSpanPx` is the half-**VERTICAL** span and its own doc says so. Computing it from the WIDTH over-spanned by the aspect ratio (~1.76× on a 2239×1271 viewport), so MSA rendered 1.76× more zoomed-out than Foundry believed — Foundry mapped a click with ITS scale, MSA drew the result with a wider view, and a token dropped at the top-right landed short and toward the centre. **Foundry's hit boxes were correct throughout; the picture the author was aiming at was the thing that lied.**

**Three further live-found traps, all the same shape — two things one letter or one word apart, no error, silently wrong:**
- Gating the input LISTENERS was not enough. The render loop's camera integration runs **per-frame regardless of input**, easing toward a target captured at load and REPLACING `view` wholesale — so it overwrote each adopted value and dragged the view back every frame. *Two cameras fighting, reproduced inside the very change meant to prevent it.* **This also caused the "misplaced tiles while zooming"** (see the eviction bug in CURRENT STATUS — the fight was thrashing residency into the dangling-texel defect).
- The camera sync set `view.targetHalfSpanPx`; the real eased target is a **closure variable of the same name**. It created a property nothing reads.
- Driving the camera off the `canvasPan` hook and `await`ing a full residency rebuild per event made pan *laggy*. The frame loop reads `canvas.stage` directly instead — two property reads, so per-frame is cheaper than the hook AND cannot drift: no event to miss, no ordering to get wrong.

**What this costs, and it is scaffolding, not features.** MSA's own pan/zoom (right-drag, WASD, +/-, eased zoom) was built for the standalone VT torture-fixture viewer, which has no Foundry scene to follow and KEEPS them (`followFoundryCamera: false`). On the real-scene path they are gone. Note the keyboard handlers bind to `window` — `pointer-events:none` could never have stopped them stealing WASD from Foundry.

**Consequence for §4.3's gameplay severance:** "tokens/walls/templates rendered natively in `src/gameplay/`" still holds for *rendering*. It does **not** extend to input. Foundry hit-tests; MSA draws.

### 4.8 Tokens as drawables (`src/foundry/scene-tokens.js`) — landed 2026-07-16

Tokens are **not a subsystem**: they enter the ONE flat draw list at `SORT_LAYERS.TOKENS` (700) through the same law as everything else. No new pass, no new layering machinery — *the whole point of the law being one flat list is that a new kind of drawable is just another key.* No vision, no fog, no detection modes, no light, no rings (§4.7: Foundry hit-tests; and vision stays Foundry's per §4.3).

Every field read from the real v14 schema (`common/documents/token.mjs`), and each of these was a live bug or a near miss:
- **`width`/`height` are GRID UNITS; `x`/`y` are PIXELS.** The record mixes units and does not read that way. A 1×1 token would render one pixel wide and simply look absent.
- **`token.level` is a NATIVE level id** (`DocumentIdField`) — floors come out of core v14's own schema, confirming the no-third-party-Levels directive from the source. **But `includedInLevel` from `scene-layers.js` is the TILE test** and reads `doc.levels` — a SET, because a tile has a dropdown choosing its floors. Passing a token finds no set, takes the "no restriction, show everywhere" branch, and returns true: **every token on every floor.** Caught by a test before it shipped. `tokenOnLevel` is the singular test.
- **`token.level` initialises to the literal `defaultLevel0000`** (`BaseScene.metadata.defaultLevelId`), which no authored scene has — so a freshly dragged token matches no level and a strict test drops it from every floor. `resolveTokenLevel` treats an id the scene HAS as authoritative and falls back to the viewed level otherwise: **a token that exists must be visible somewhere.** The fallback is **opt-in** (needs the scene's FULL level list): with only the VISIBLE ids you cannot tell "unassigned" from "on a floor you cannot see", and guessing drags upstairs tokens downstairs. *A test caught that dangerous default.* **When the information needed to decide is absent, do not guess.**
- **Token art is CENTRE-anchored** (`anchorX/Y: 0.5`, `fit: "contain"`), unlike a tile's top-left. `computeQuadCorners` takes `x/y` as the ANCHOR POINT, so passing the footprint's top-left centres the art ON the corner — half a token up and left of Foundry's hit box, which is exactly what the author saw. `computeTokenPlacement` returns the footprint CENTRE.
- **`occludable.radius`** is real document data, carried now so the occlusion mask producer is purely additive.

**The draw list is derived from live documents, so it must WATCH them:** `createToken`/`updateToken`/`deleteToken` drive a refresh. `updateToken` matters as much as create — moving a token between floors changes `token.level`. Nothing watched them at first, so a token created while the camera sat still changed the document and never reached the screen.

## 5. The quarantine — "pack it in a box, disconnect every wire"

Exactly the author's instinct, made mechanical (Stage 0, ~an hour):

1. `git mv scripts legacy` — one commit, history preserved. (`assets/`, `styles/`, `templates/`, `lang/` stay shared.)
2. `module.json`: `esmodules: ["src/boot.js"]`, version `0.6.0-dev.0`. **From this commit forward the old runtime is physically unreachable** — every wire disconnected on purpose, nothing deleted.
3. `legacy/` rules: read anytime, harvest by `git mv` + import-fix, **never import across the boundary, never bug-fix** (it doesn't run; there is nothing to fix). It is deleted whole at Stage 7.
4. Dev A/B against the old behavior = install the last 0.5.x release zip in a second Foundry world. Not a code path.

This satisfies the fresh-white-sheet need *and* keeps the parts bin and the reference shaders one folder away.

---

## 6. Harvest manifest (move into `src/`, minimal edits)

**Infrastructure (near-verbatim):** `streaming/pyramid-indexed-db.js`, `texture-pyramid-builder.js` (re-slice to page format), `tile-decode-pool.js` + `tile-decode-worker.js` (add per-page extractors), `gpu-work-scheduler.js`, `view-projection-service.js`, `vram-ledger.js` + `pixi-vram-probe.js` (telemetry/assert mode), `core/webgl-crash-recovery.js` + `safe-call.js` + `log.js` + `yield-to-main.js` + `texture-leak-probe.js` + loading profiler.

**V3 pipeline (near-verbatim):** `compositor-v3/FrameGraph.js`, `ThreeAllocator.js` (+ law enforcement), `GpuPassTimer.js`, `v3-perf.js`, `v3-flags.js`, `FullscreenPresent.js`, `ForwardLightingPass.js`, `__tests__/` (extend, keep green).

**World & gameplay:** `core/LightingDirector.js`, `WeatherController.js`, `SceneWindField.js`, tod/timeline modules; `FogOfWarEffectV2` + `vision/VisionPolygonComputer.js` + `VisionSDF.js` (fog buffer re-capped per §4.4); TokenManager/VisibilityController family (audit for V2 coupling); `foundry/levels-scene-flags.js`, `gm-parity.js`, keybindings, level navigation, `fog-native-exploration-suppression.js`; `masks/mask-catalog.js` + `streaming/mask-channel-pack.js` (as the packing plan's input).

**UI shells (rebound to new internals):** loading-screen service/manager, graphics-settings manager+dialog (drops V2-era knobs), tweakpane panels per effect as each effect lands (the *parameter schemas* are part of the product).

**Reference-only (consult in `legacy/`, port shaders/params out, never the machinery):** every `*EffectV2` (the look lives in their GLSL + defaults), `GpuSceneMaskCompositor` (mask semantics/decode conventions — e.g. the `max(r,g,b)` 0.18–0.82 outdoors band), `FloorCompositor` (behavioral reference), `canvas-replacement.js` (the hook inventory — its 12k lines document every Foundry integration point the adapter must cover).

## 7. Kill list (dies with V2, replaced by construction)

`FloorCompositor` (10k lines) & per-level RT pool & LevelCompositePass · `GpuSceneMaskCompositor`'s world-res bakes & floor cache & pre-warm sweeps · per-effect populate/binding pipeline & load-slim compositor · `pixi-content-layer-bridge` + `extract.canvas` readbacks · `pixi-texture-demotion` (all sweeps — prevention supersedes) · adaptive controller's reactive degradation ladder (governor throttle survives inside vt/) · the three tile pacing queues (no giant uploads exist to pace) · level-transition curtain (floor switches) · safe-mode preset downgrade (crash recovery itself stays) · the 0%/98% two-gate warmup and its "Ready!" lie.

Every one of these was a correct band-aid on the wrong cost model. Honor them by deleting them.

---

## 8. Stages and gates — torture scene first

**Stage 0 — Fixture & rig** *(days)*
Generator script (`tools/make-torture-world.mjs`) emits a synthetic world: **12,000² × 3 floors** (labeled grids + per-floor tint so streaming errors are visually obvious), synthetic `_Outdoors/_Specular/_Fire/_Tree/_Bush` masks with known patterns, 60 lights, 1,000 walls. Plus `MapShine.soak(n)` console macro (n× load/switch/pan cycles, reports context losses + ledger peaks). Execute §5 quarantine. `src/boot.js` renders a colored triangle from new Three.
**Gate:** fixture imports into Foundry; soak harness runs; legacy unreachable; boot renders.

**Stage 1 — The law, running** *(~1 wk)*
Page cache + tables + analytic residency + decode/upload path, driven by the fixture's albedo. Grey→coarse→sharp world; pan/zoom/floor-switch by keyboard.
**Gate (on the 3070):** torture scene pans at 60 fps target / 30 floor; ledger flat within budget through 20-cycle soak; **zero context loss**; allocator throws on a deliberately-planted world-res alloc (negative test).

**Stage 2 — Real art + the proxy severance** *(~1 wk)*
Real scenes (Church, Mansion) through the pyramid/VT path. Foundry proxy-texture interception live.
**Gate:** both scenes render sharp albedo at native; **PIXI ≤ 60 MB**; zero `texImage2D` > 32 ms in a full session report; interactive ≤ 10 s. *(The crash class observed all 2026-07-15 is dead at this gate.)*

**Stage 3 — Unified geometry + attribute buffer + lighting** *(~1–2 wk, mostly harvest)*
MRT attr buffer, harvested lighting re-seated, CC/bloom post re-seated, DRS governor live.
**Gate:** RT inventory ≤ 250 MB at 3 MP (allocator-audited); lights visually match 0.5.x reference screenshots; native-res 20-cycle soak clean.

**Stage 4 — Masks virtualized** *(~1–2 wk)*
Packing audit → mask pyramids → `vtSample` consumers: indoor/outdoor ambient + contextual grade + surface-response (specular et al.) + per-page extractors (fire points, veg fields).
**Gate:** grep proves **no world-res mask allocation exists**; indoor/outdoor + specular parity vs reference; masks' VRAM = pages only. **Vegetation mask fidelity comes back for free here** — the 2048px Tree/Bush cap (commit 2633341) dies with the world-res model; pages serve the authored resolution through the keyhole. *(The author's original vegetation-resolution complaint from the session that birthed this plan is resolved at this gate.)*

**Stage 5 — Gameplay severance complete** *(~2–3 wk — the grind, but bounded)*
Walls/templates/drawings/notes native; interaction parity sweep (select, drag, HUD, hover); delete the content bridge.
**Gate:** `pixi-content-layer-bridge` deleted; a GM runs a real session's worth of interactions from a checklist without touching legacy.

**Stage 6 — Effects long tail, look-parity per effect** *(~3–6 wk, parallelizable; water first, then fire, vegetation render, weather/clouds, shadows-unified, stylizers)*
**Gate per effect:** side-by-side vs 0.5.x reference screenshots signed off by the author; budgets hold; soak clean. The module is *playable and pretty* throughout — effects arrive as upgrades, not as blockers.

**Stage 7 — Exorcism** *(days)*
`git rm -r legacy/`; Forward+.md archived with a header pointing here; ship **0.6.0 "Keyhole."**
**Gate:** repo grep clean; fresh-install world loads Church, Mansion, and the torture scene at native on the 3070 with zero context loss across a 50-cycle soak.

**Honest total: ~2.5–4 months to full parity**, with the crash class dead at ~week 2–3 (Stage 2), the architecture proven on the torture scene before any effect is ported, and a usable dev build from Stage 3 onward. Every stage ends with something the author can *see*.

---

## 9. Risks & open questions

**Risks (with mitigations):**
1. **Foundry API drift** (proxy interception + hooks) — all Foundry touchpoints isolated in `src/foundry/`, version-gated, fail loud. v14 source is vendored locally (`foundryvttsourcecode_v14/`) for tracing.
2. **First-run pyramid build of a 12K webp** spikes browser decode memory once per asset — paced, one-time, IndexedDB-persisted; offline pre-slicer tool later if authors want zero first-run cost.
3. **Page-seam filtering artifacts** at extreme zoom — 4-texel borders + mip clamp are the standard cure; torture fixture's labeled grid makes seams instantly visible in Stage 1, not in the field.
4. **Water cross-floor correctness** — highest-risk port; scheduled first in Stage 6 with its own design note; attribute buffer supplies the occluders that were V2's hardest plumbing.
5. **Relapse into band-aids** — the doctrine (§0), the allocator throw, and the import fence exist precisely to make relapse *harder than doing it right*.
6. **A player's hardware can't sustain Keyhole's best effort, mid-session** — the long-term mitigation is a tiered fallback (WebGPU → WebGL2 → native Foundry PIXI, auto-detected and GM-enforceable), decided in direction but explicitly deferred; see §4.3's "long-term direction" note. Not scheduled to a stage yet — natural fit alongside §16's W-track WebGPU work.

**Open questions (author decides at session zero; recommendations inline):**
- **Q1** Page size 128 vs **256 (rec)**.
- **Q2** Cache budget default **512 MB @ 8 GB tier (rec)**, scaled per tier.
- **Q3** ~~WebGL2 now~~ → **OVERTURNED 2026-07-16: WebGPU + TSL is the direction** (author decision; full reasoning in `docs/planning/Shaders.md`'s ⚡ DECISION block, recorded in project memory as `keyhole-webgpu-tsl-decision`). **Proven, not assumed:** `src/diag/tsl-spike.js` rendered the exact expected pixel on BOTH backends on the author's 3070 — testing the three things `vt-sample.glsl.js` does that a node port could break (`textureLoad` indirection, `DataArrayTexture` layer sampling, a dynamic mip `Loop`), not a spinning triangle. **The decisive argument is memory, not futureproofing:** WebGPU's EXPLICIT resource model (create/`destroy()`/know what exists) *is* §0's fixed-budget law; WebGL's implicit driver-managed one is what made §1's ceiling invisible. Key rules that survive: TSL runs on BOTH backends (`three.webgpu.js` has `WebGLBackend` + `WebGPUBackend`), so **ONE source per effect, never a WebGL2 twin**; and **tiers follow MEASURED performance, never the backend** — WebGPU-availability tracks browser recency, not GPU power, so coupling "fancy" to it would hand a 2017 laptop the expensive path, i.e. the exact crash this plan exists to prevent.
- **Q4** Offline pre-slicer tool: **after Stage 4 (rec)**.
- **Q5** Keep `useNativeFoundryRendering` off-switch: **yes (rec)**.

---

## 10. Session-zero protocol (for the next session — start here)

**Superseded by the CURRENT STATUS section right after §0's audience line — read that first.** Q1–Q5 are already answered (§9), Stage 0 is done, the quarantine already happened. This numbered list is kept as the ORIGINAL first-session protocol, for history and in case the project ever needs to be re-derived from scratch:

1. Read this file top to bottom. Then skim: `compositor-v3/README.md`, `docs/planning/v3/B0-1-floor-attribute-buffer.md`, `docs/planning/v3/B0-2-frame-graph.md`, Forward+ §4 (the three hard constraints: painted masks, water-under-floor, Foundry-owns-gameplay).
2. Confirm Q1–Q5 with the author (one message, defaults pre-filled).
3. Execute Stage 0 exactly as written (§8). Quarantine commit first — it is the point of no return and the point of the plan.
4. Update project memory: Keyhole is the vector; sessions report progress against stage gates, not against crash reports.
5. Doctrine reminder for every future turn: **no legacy imports, no world-res allocations, no fallback paths, hard case first.** When in doubt, the law wins.

**For a CONTINUING session:** read the CURRENT STATUS section, then pick up at its "Still open" list. The doctrine reminder in point 5 above still applies to every turn, always.

**Before writing any TSL, read `reference_tsl_method_chaining_trap`** (project memory). One method-chaining quirk cost a whole session and produced three simultaneous bugs that all read as correct code.

**Before creating/importing any Foundry document, calling an API, relying on a hook, or assuming schema behaviour: READ THE VENDORED SOURCE** (`foundryvttsourcecode_v14/resources/app/`). Every single time this session that a Foundry fact was checked rather than assumed, it was load-bearing and surprising — `token.level` is singular where a tile's `levels` is a set; `defaultLevel0000` is a literal no authored scene has; `width`/`height` are grid units while `x`/`y` are pixels; `stage.pivot` is the world centre. Every time one was assumed, it was a live bug.

**The debug panel is the standing debugging protocol** (`src/diag/debug-panel.js`, `keyhole-debug-panel`): tell the author which report to click and paste back, rather than asking for console logs. `MapShine.debug.registerReport(id, label, fn)` and `registerSelect(id, label, options, getValue, onChange)`. The **in-graph bisect** pattern — render ONE layer of a shader graph at a time, one observation per click — is what found the `.mix()` bug after six wrong theories, and is the tool to reach for when a shader is wrong. Build it early, not after two commits of guessing.

*V2 is dead. Long live the V3.*
