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

**✅ RENDERER WIRING LANDED (`04e0d0e`) — UNVERIFIED IN-BROWSER.** The renderer is item-based and world-space: a floor's background, its foreground (roof) art and every tile are peers, each with its own virtual texture and its own quad in canvas space, all ordered by the one sort law. The camera replaces the fullscreen-quad/UV-remap model (and with it `reframeLayer`/`reframeVisibleLayers`, and the UV-compounding bug class that path produced live — a rewrite that reads its own previous output cannot compound if it does not exist). Residency now plans in each item's **image space** (`viewRectToImageRect` + `computeItemViewportPx`); passing the canvas size to `chooseMip` instead would make every small tile stream full resolution — O(tiles), the exact cost model this architecture exists to destroy. `view-state.js` is rectangular. `boot.js` feeds items from `collectSceneLayers` for real scenes and from a synthetic fabricator for the torture fixture — **one renderer, one path**. 574 Node assertions green, lint clean, boot bundles, fence clean. **None of it has rendered a pixel yet** — the risky math is Node-proven (orientation, placement, image-rect, the sort law) but the wiring is not.

**⬜ THE REMAINING PIECE: the occlusion mask PRODUCER.** The shader path is real and implements Foundry's algorithm verbatim in shape (`occlusion.mjs:16` — four channels, the elevation-index `step` test, `max` across weights, the alpha mix), fed by the ported model (`scene/occlusion.js`) with real document data. What is missing is the thing that WRITES the mask: rendering each occludable token's `vision.los` polygon and radial disc into a screen-space RGBA render target with **MIN blending**, rebuilt when perception changes, plus `_identifyOccludedObjects` (the alpha-thresholded hit test that sets each item's `occluded` boolean, which is what gates FADE). Until then the mask is an inert 1×1 using Foundry's own clear value `[0,1,1,1]` — literally "nothing occludes anything" — so every item renders unoccluded and switching the producer on is purely additive: build it, point the uniform at its render texture, feed real weights. **Also tracked:** `vt-pan-viewer.js` now imports from `scene/` and `foundry/` and is really the scene renderer — it belongs at `src/scene/scene-renderer.js`; a mechanical rename, deliberately not bundled into a structural commit.

---

## 📍 CURRENT STATUS (updated 2026-07-16 — read this before §8's stage narrative)

**Stage 0 and Stage 1: DONE, gates met with live evidence. Stage 2: core mechanism proven live, formal gate metrics not yet fully captured — but a substantial amount of Stage 4 (masks virtualized) has effectively landed early, live-confirmed under real pressure, plus two quality-of-life passes (mip blending, camera smoothing).** Branch `keyhole`. Detailed breakdown, honesty rule applied (never marked done without the evidence §8 specifies):

**⚠️ SESSION-END SELF-DIRECTED WORK (2026-07-16, author stepped away, explicit permission to push forward autonomously without live verification):** four pieces of work landed — see the dedicated subsection right after this status block for full detail, live-testing status, and what to check first on return. In short: (1) **multi-layer virtual textures + channel-packing are DONE and LIVE-CONFIRMED** (the mask-pile-up killer, §4.1's core promise, proven under the real "castle courtyard" 3-floor/8-layer worst case with zero crashes); (2) **smooth mip blending** (trilinear-style cross-fade between adjacent mips) — built, Node-tested, **UNVERIFIED live**; (3) **camera smoothing** (continuous held-key pan + eased zoom, replacing discrete jumps) — built, Node-tested, **UNVERIFIED live**; (4) this status update + a repo-wide gap sweep. Items 2–3 are real, contained, unverified changes — test them FIRST on return, per the checklist in that subsection.

- **Stage 0 (Fixture & rig): ✅ DONE.** Quarantine executed (`git mv scripts legacy`), torture fixture generator built + confirmed importing into Foundry, soak harness built, `src/boot.js` renders.
- **Stage 1 (The law, running): ✅ DONE, gate met.** Page cache/table/residency/atlas built and Node-tested (295 assertions across `src/vt`, `src/graph`, `src/foundry`, all green). Multi-mip coarse-fallback ("not loaded yet means soft, not wrong") built and LIVE-CONFIRMED. `MapShine.soak(20)` on the torture fixture: **0 context losses, 0 restores, 20 cycles in 209 ms.** `ThreeAllocator` throws on a planted world-res allocation (negative test, Node-verified). All four Stage 1 gate criteria met with real evidence.
- **Stage 2 (Real art + proxy severance): 🔶 core mechanism proven live; formal gate not yet fully closed.**
  - ✅ Visual severance — the VT view fills the scene area and occludes PIXI, live-confirmed. Two real bugs found live and fixed: an out-of-world edge smear (unclamped view rect sampling past the world boundary) and a boundary-page stretch (pages whose nominal span isn't an exact multiple of the world size were naively stretched instead of clamp-extended).
  - ✅ Real scene art streams through the VT pipeline — live-confirmed on a real **12,000×12,000px** two-floor scene (`Mansion - Multifloor`), not the synthetic fixture. Only one real scene tested so far, not "Church, Mansion" as originally scoped in this section's own gate.
  - ✅ Multi-floor rendering via Foundry's **NATIVE v14 `scene.levels` schema** (author directive, 2026-07-15: build around core Levels going forward, not the long-established third-party Levels module — its vendored copy was deleted from `othermodules/`; see §6's note on a related, still-open fixture mismatch). Cross-floor Z-compositing with real alpha-hole reveal, matching Foundry's own `visibility.levels`-driven algorithm exactly (`_configureLevelTextures`/`Level#isVisible`, verified from source, not approximated) — live-confirmed after diagnosing and fixing a floor-switch/view-desync bug and the repeated-GPU-reallocation crash it caused (one root cause: a full viewer restart was firing on every floor switch instead of a cheap same-scene sync).
  - ✅ **Foundry proxy-texture interception is LIVE AND WORKING — the actual crash-class kill, this plan's headline promise.** `PIXI.Assets.cache` pre-seeded with ≤1024px proxies at Foundry's own `canvasInit` hook (fires strictly before Foundry loads scene textures, confirmed from source), so PIXI never decodes the real file. Confirmed via a live residency report: both floors of the real 12,000×12,000 mansion scene resident in PIXI at exactly **1024×1024**, not 12,000×12,000. Default-on (author correction: this is core product behavior, not an optional debug toggle) — wired entirely to `canvasInit`/`canvasReady`, zero manual clicks required to get real-scene VT rendering + VRAM severance on every load.
  - ⬜ **Not yet done, tracked:** Tile document proxying (Level backgrounds only so far — this section's own other named target). Full PIXI residency measurement across everything (tokens, walls, tiles — not just the now-proxied Level backgrounds), `texImage2D` timing, and interactive-load-time are the remaining Stage 2 gate metrics, not yet captured. Only one real scene tested.
  - ⬜ **Known, deliberately deferred correctness gaps** (documented loudly in code, never silently dropped): non-square world images throw rather than mis-render (rectangular-world support isn't built); per-floor world-size reconciliation if two composited floors' art differs in native resolution (console-warns, doesn't reconcile); `tools/make-torture-world.mjs`'s own floor-generation macro still uses the old third-party Levels tile-flag convention, not the native schema this project now actually builds around — a real, tracked mismatch (see §6).
  - **Stages 3–7: not started.**

**Standing directives from this session, now part of the plan, not just a private note:**
- Multi-floor work targets Foundry's **native v14 `scene.levels`** schema exclusively — never the third-party Levels module.
- New capabilities that are part of what V3 actually does when someone plays (rendering, severance, anything gameplay-visible) ship **default-on**, wired to real Foundry lifecycle hooks — never gated behind a manual debug-panel toggle. Diagnostic/dev-only tools (torture fixture, soak harness, residency reports) correctly stay manual. See §4.3's long-term tiered-fallback note for the one sanctioned kind of off-switch.
- The long-term tiered reliability fallback (WebGPU → WebGL2 → native PIXI, §4.3, §9 risk 6) is a recorded direction, explicitly deferred — do not build it unprompted.

**Commit trail** (branch `keyhole`, oldest→newest since the Stage 0 quarantine): `445736f` quarantine, `1bded9d`/`bea9bd8` torture fixture + soak harness, `5d1851c`→`0fb3ecb` Stage 1 parts 1–4 (allocator law, page atlas, decode path, first pixels), nine live-debugging rounds `a3b9a83`→`6f451ac` (Y-flip → coordinate-space → clamp-bound → GL-interleaving → texture-unit-cache → diagnostic-bug → the real UV-compounding bug), `70f2fb5` lint/format tooling, `1e6a96f` Three r170→r185, `f0be6ea` coarse-mip fallback, `60245e3`/`cea299e` visual severance + edge-smear fix, `832643b`/`116c03a`/`9db9d68`/`2e14ea4` real scene art + native multi-floor + hole-compositing + boundary-stretch fixes, `cc04f55` VRAM severance first cut + reliability-fallback direction, `433494f`/`c835b3c` default-on wiring + the floor-sync/crash fix. `git log --oneline` on `keyhole` for the full trail with full messages (each one cites the source verification or live evidence behind it).

**⚠️ NOTHING FROM THIS EXTENDED SESSION (2026-07-15 evening → 2026-07-16) IS COMMITTED YET.** The commit trail above (`445736f`…`c835b3c`) is the LAST real commit on `keyhole`; everything described in the subsection below exists only in the working tree. Committing it (as a sequence of focused commits, not one giant one) is the single highest-priority next action — an evening this substantial should not sit uncommitted.

**Next real steps, in likely order:** (a) **commit the extended session's work** (see subsection below for the full list — 12+ logical units); (b) live-verify the two UNVERIFIED changes (smooth mip blending, camera smoothing — see their own entries below for exactly what to check); (c) live-verify channel-packing's residency numbers on a fresh load (the last live report predates it); (d) capture the remaining Stage 2 gate metrics (full PIXI residency, load time, `texImage2D` timing) to formally close Stage 2; (e) extend proxy interception to Tile documents; (f) test on a second real scene; (g) begin Stage 3 (unified geometry + attribute buffer + lighting) once Stage 2's gate is honestly closed.

---

### 📦 Extended session summary (2026-07-15 evening → 2026-07-16) — read this if picking up here

A long single session covering: native mouse pan/zoom, the full multi-layer virtual-texture core (the actual §4.1 mask-pile-up promise), a representative torture fixture matching the author's real mask taxonomy, a decode-memory fix, two real cache-ordering bugs found and fixed live (one via a whole-screen magenta repro, one via a diagnostic-vs-ground-truth mismatch), channel-packing, and — in a final self-directed push while the author stepped away with explicit permission to proceed without live verification — smooth mip blending and camera smoothing. Full blow-by-blow lives in project memory (`keyhole-stage-status.md`); this is the doc-of-record summary.

**✅ LIVE-CONFIRMED this session (real evidence, not just built):**
- **Native mouse pan/zoom** — grab-drag (1:1, cursor-anchored) + cursor-anchored wheel zoom, matching native Foundry's feel. Author-confirmed working.
- **Multi-layer virtual textures — THE §4.1 mask-pile-up promise, proven.** A "virtual texture" is now `(floor × layer-pack)`, not `(floor)`: every mask (`_Shadow`, `_Outdoors`, `_Fire`, `_Specular`, `_Window`, `_Tree`, `_Bush`) streams through the SAME fixed 512MB page cache as albedo — namespaced page keys, no atlas/cache changes needed. Live-confirmed under the real worst case (author's "castle courtyard" scenario: 3 floors, all mutually visible via alpha holes, all 8 layers per floor streaming simultaneously) — the page cache filled to capacity and degraded to graceful BLUR (evictions/misses, zero crashes, zero context loss), exactly the keyhole thesis. **This is V2's actual cause of death (masks × floors all held at once) now architecturally impossible, not just theoretically designed against.**
- **Decode-memory fix** — the OTHER half of "don't explode": source images are sliced to pages ONCE, persisted to IndexedDB, and the full ~576MB decoded bitmap is RELEASED (bounded 3-source concurrency ring) instead of held forever. Fixes a real live failure (mask decode errors under the full 22-source multi-layer load) with `heldSources` confirmed bounded and `idbHits` confirmed climbing (pages served without re-decode) across two live reports.
- **Two real cache-ordering bugs found live and fixed:**
  1. **Whole-screen magenta** under the castle-scenario test — `PageCache` treats `'coarse'` and `'view'` pins identically (no priority), so an earlier floor's large view-tier request could saturate the cache before a later floor's small coarse-pin request even ran, violating the "coarse pins are the guaranteed floor" invariant. Fixed: `updateResidency` now locks in EVERY visible floor's coarse pins first, in a dedicated phase, before any floor's view-tier streaming begins. Author-confirmed clean (`coarsePinShortfall: 0`).
  2. **"Stuck view-miss"** — a page that missed the cache once was incorrectly marked "resident" in tracking state, so it was never retried even after pressure relieved. Fixed to track ground truth (`cache.isResident()`), not intent.
- **Channel-packing** — the 3 single-channel masks (`_Shadow`→R, `_Outdoors`→G, `_Fire`→B, shared structural-hole→A) now composite into ONE RGBA texture at decode time (not on disk), cutting 7 masks → 4 packs. Built and wired; author had not yet re-verified the residency numbers with this specific change before the session ended.

**🔶 BUILT, Node-tested, UNVERIFIED IN-BROWSER (self-directed work, author absent) — test these FIRST on return:**
- **Smooth mip blending** (author-reported: "zooming in and out produces very ugly zoom levels" — the hard integer-mip pop). The shader (`vt-sample.glsl.js`) now cross-fades between the two mip levels bracketing a continuous fractional mip value, instead of hard-switching at `chooseMip()`'s threshold. No residency/streaming change was needed — `planResidency()` already fetches both bracketing mips as insurance against a fine-mip miss. The proven single-mip walk logic itself is UNCHANGED (factored into a helper, called twice, not rewritten) specifically to avoid risking the nine live-debugged bugs that walk survived. **Genuinely unverified — GLSL can't be tested outside a browser; every prior shader change in this project needed live iteration.**
- **Camera smoothing** (author-reported: "camera controls in a very jerky way... modern concepts... smooth and cinematic... not laggy/drunk"). Root cause: keyboard pan/zoom were discrete, one hard jump per keydown-repeat event (OS key-repeat timing, visibly steppy). Mouse-drag was already correct (1:1, no lag) and is deliberately UNCHANGED. Fix: held-key panning is now a continuous, frame-rate-independent eased velocity (short ~80ms ramp, not instant on/off); keyboard/wheel zoom now eases toward a target over ~120ms instead of jumping, reusing the existing cursor-anchor math every frame rather than a new formula. All the underlying math is pure and Node-tested (38 new assertions covering frame-rate-independence, convergence, clamping, edge cases); the WIRING (held-key tracking, per-frame render-loop integration) is real JS complexity that has not been exercised live.

**Verification snapshot:** 193 Node assertions across `src/vt` (up from 295 total across the whole tree at the last CURRENT STATUS checkpoint — the growth is almost entirely `src/vt`), `npm run verify` (lint+format) clean, `boot.js`'s full import graph bundles cleanly, import fence clean. None of this substitutes for the live verification the two UNVERIFIED items above still need.

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

### 4.5 Loading & floor switching — reliability > smooth > quick, made structural

- **Initial load:** mount page tables → stream **coarse pins** (tiny — the whole world soft-focus in well under a second of decode) → reveal behind the existing curtain with *honest* progress (pages resident / pages needed) → sharpen progressively under the upload governor. No 45-second all-or-nothing storm; no un-chunkable populate loop; no fake "Ready!". Interactive target on the torture scene: **≤ 10 s** on the 3070.
- **Floor switch = uniform write + working-set shift.** Coarse pins for *every* floor are always resident, so the target floor renders instantly (soft for ~200–500 ms while its sharp ring streams). **No curtain, no rebuild, no `canvas.scene.view` redraw cost** (and with proxy textures, even Foundry's own level redraw becomes ~100× lighter). The level-transition curtain is deleted with V2. This is the "floor changes without loading screens" headline promise, delivered by construction rather than by cache-warming heroics.

### 4.6 Enforcement — making the law physical

- `graph/ThreeAllocator` **throws** on any texture/RT allocation with a dimension > 2048 unless it is the page atlas itself or on the explicit whitelist (`fogExploration`, present chain). A world-res allocation is a crash *in dev, at the call site, with a stack* — not a context loss in the field three weeks later.
- `src/` may not import `legacy/` — enforced by a grep check in the release script (and ESLint if configured). Harvest = `git mv` into `src/` + fix imports; never a cross-boundary import.
- `diag/ledger` (harvested) runs in **assert mode** during dev: aggregate pressure > 0.9 logs an error with the last-allocation stack. Its reactive resize trigger from the 2026-07-15 session is **removed** — under a fixed-allocation core there is nothing to reactively resize. It becomes pure telemetry + tripwire.
- The crash reporter (harvested wholesale — it earned it) keeps the `vramLedger` section; a Keyhole report showing `overCeiling:true` is a *bug in the law's enforcement*, not weather.

---

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
- **Q3** **WebGL2 now (rec)** — §16 W-track conventions keep the WebGPU port mechanical later; do not block the rebirth on it.
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

**For a CONTINUING session:** read the CURRENT STATUS section, then pick up at "Next real steps." The doctrine reminder in point 5 above still applies to every turn, always.

*V2 is dead. Long live the V3.*
