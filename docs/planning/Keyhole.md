# KEYHOLE — The V3 Rebirth Plan

**Status:** ACTIVE BUILD PLAN (authored 2026-07-15). This document **supersedes Forward+.md §14–§16 as the plan of record.** Forward+.md remains the diagnosis archive — the evidence lives there; the build lives here.
**Author decision (2026-07-15, verbatim intent):** *"V2 is dead, long live the V3."* No band-aids, no fallback paths, a serious and complete refactoring. This document is the main vector of thrust for every session that follows.
**Audience:** a fresh session with zero context, and the author. Everything needed to start is in this file.

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

1. Read this file top to bottom. Then skim: `compositor-v3/README.md`, `docs/planning/v3/B0-1-floor-attribute-buffer.md`, `docs/planning/v3/B0-2-frame-graph.md`, Forward+ §4 (the three hard constraints: painted masks, water-under-floor, Foundry-owns-gameplay).
2. Confirm Q1–Q5 with the author (one message, defaults pre-filled).
3. Execute Stage 0 exactly as written (§8). Quarantine commit first — it is the point of no return and the point of the plan.
4. Update project memory: Keyhole is the vector; sessions report progress against stage gates, not against crash reports.
5. Doctrine reminder for every future turn: **no legacy imports, no world-res allocations, no fallback paths, hard case first.** When in doubt, the law wins.

*V2 is dead. Long live the V3.*
