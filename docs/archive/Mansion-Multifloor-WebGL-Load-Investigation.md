# Mansion Multifloor — WebGL Load Crash Investigation

**Document created:** 2026-07-06  
**Status:** Ongoing — scene still does not load reliably on 8 GB VRAM laptop  
**Scene:** Mansion - Multifloor (`AgEdsalWg2JMzpLR`)  
**Module:** map-shine-advanced (disk `0.5.3.10`, runtime often reports `0.5.4.33` on mythicamachina.com)

---

## Executive summary

The user cannot load **Mansion - Multifloor** on a laptop with an **RTX 3070 (8 GB VRAM)**. The same scene loads successfully on a desktop with an **AMD GPU and 16 GB VRAM**. Foundry V14.364, Chrome on Windows.

The failure mode is repeated **`webglcontextlost`** during scene load — not a steady-state gameplay crash. Over 20 crashes have been recorded for this scene in local crash history. The scene never finishes loading; in-game Performance & Graphics settings are unreachable.

This is **not primarily a texture leak** (`primaryLeakId: "none"` in all reports). It is **GPU memory / work spikes during load**, compounded by:

- A **144 megapixel** map (12000×12000)
- **11 multifloor bands**
- Heavy **FloorCompositor V2** effect RT stacks
- **Mask texture uploads** and **tile streaming pyramid** mounting
- Foundry **PIXI** sharing the same GPU

Lowering render resolution to **800×450** and pinning **8 GB VRAM preset** helps but has **not** been sufficient alone.

---

## Hardware and configuration

| Item                  | Laptop (failing)       | Desktop (working)            |
| --------------------- | ---------------------- | ---------------------------- |
| GPU                   | RTX 3070, 8 GB VRAM    | AMD, 16 GB VRAM              |
| System RAM            | 16 GB                  | (not specified)              |
| Render preset at test | 800×450 (safe mode)    | native / higher              |
| GPU VRAM preset       | 8 GB (pinned)          | likely auto → 16 GB inferred |
| Drawing buffer        | ~781×450               | larger                       |
| Browser               | Chrome 150, Windows 10 | —                            |
| Foundry               | V14.364                | V14                          |

**Safe mode** is active for this scene/user (`storageKey`: `map-shine-advanced.graphicsOverrides.AgEdsalWg2JMzpLR.SLWaa0HoVxjFAQZN`), pinning conservative graphics after repeated crashes.

---

## Scene characteristics

| Property                    | Value                           |
| --------------------------- | ------------------------------- |
| Scene size                  | 12000 × 12000 (144 MP)          |
| Floors                      | ~11 visible during load         |
| Tiles                       | 6                               |
| Tokens                      | 1                               |
| Lights                      | 20                              |
| Walls                       | 1002                            |
| Outdoors mask bake estimate | 2458×2458 ≈ **23 MB per floor** |

---

## Crash pattern evolution

Investigation revealed a **multi-stage failure** that shifted as fixes were applied:

### Stage A — Early crashes (~30 s): compositor init

- **Reported phase:** `gpu.textureWarmup` (misleading — coordinator was `initializing_compositor`)
- **Top GPU allocators:** `BloomEffectV2`, `OverheadStampEffectV2`, `BuildingShadowsEffectV2`, `OverheadMaskCapturePass`, core `FloorCompositor` RTs
- **Streaming:** background grid not registered; `backgroundGridCount: 0`
- **Textures at crash:** ~19 Three.js counter

### Stage B — Second crash (~15 s after restore): camera / outdoors

- **Phase:** `scene.managers.cinematicCamera.init`
- **Trigger path:** `CameraFollower.initialize` → `_emitLevelContextChanged` → `_applyCurrentFloorVisibility` → `_repairVisibleBandOutdoorsFilesAsync` → `GpuSceneMaskCompositor.ensureSceneSpaceOutdoorsForFloor`
- **Shader errors** sometimes after context restore (broken WebGL state)

### Stage C — Progress: load-slim active, crash moves later

After load-slim compositor shipped:

- **Phase:** `initializeUI` (~46–60 s into load)
- **loadSlimCompositorActive:** true, **13 effects deferred**
- First time user saw scene **loading in background** before crash
- Second crash in same session at **`fadeIn`** with **256 textures**, **96 streaming cells**, **11 inflight uploads**

### Stage D — Latest crash (2026-07-06 14:40)

- **Phase:** `initializeUI` at **60.6 s**
- **loadSlimPendingEffects:** **13** (all still pending — `finishLoadSlimEffectInit` has not run yet)
- **Top allocators:** `loadTextureAsync` (12), `TileManager.loadTileTexture` (6), `FloorRenderBus._loadTileAlbedoFromUrlAsync`
- **No** OverheadStamp/BuildingShadows in top sites (onResize guard may be working, or not reached)
- **JS heap:** **2146 MB used** (unusually high — possible separate pressure)
- **Renderer textures:** only 9 (GPU counter low; failure likely driver/shared-memory spike, not Three.js counter alone)
- **Background streaming grid:** mounted (`backgroundGridCount: 1`) but **no textured cells** in view yet

---

## What is NOT the cause

| Ruled out              | Evidence                                                           |
| ---------------------- | ------------------------------------------------------------------ |
| Texture leak           | `primaryLeakId: "none"`, low orphan estimates                      |
| Software budget alone  | `overBudget: false`, 640 MB policy cap ≠ physical VRAM             |
| Resolution alone       | Still crashes at 800×450 + 8 GB preset                             |
| Single bad effect leak | Texture leak probe shows bounded allocations, not runaway GC leaks |

---

## Load pipeline (relevant order)

Understanding **when** things run explains **when** crashes happen:

```
createThreeCanvas()
  ├─ __msaSceneLoading = true
  ├─ ensureConservativeGraphicsForLoad()     [safe mode / 8 GB / 800×450]
  ├─ SceneComposer.initialize()              [masks, background textures]
  ├─ gpu.textureWarmup                       [skipped when load-slim]
  ├─ FloorCompositor.initialize()            [load-slim defers 13 heavy effects]
  ├─ … managers (CameraFollower, etc.) …
  ├─ ResizeHandler.setup + resize()          [⚠ was calling onResize on deferred effects]
  ├─ initializeUI                              [⚠ current crash phase, ~60 s]
  ├─ prewarmForLoading / preloadAllFloors
  ├─ finishLoadSlimEffectInit()              [deferred effect GPU init — moved before renderLoop]
  ├─ renderLoop.start()
  ├─ shaderCompile / warmupAsync
  ├─ fadeIn                                    [⚠ second crash: 256 textures, streaming burst]
  └─ post-load: outdoors repair, level context, onLoadSucceeded
```

**Key insight:** `initializeUI` runs **before** `finishLoadSlimEffectInit`. While `loadSlimPendingEffects: 13`, heavy compositor effects are intentionally **not** on GPU yet — but mask/tile texture loading during UI init can still spike VRAM.

---

## Fixes implemented (chronological)

### 1. WebGL crash recovery (`scripts/core/webgl-crash-recovery.js`)

- Stopped restoring native resolution **before** each load attempt (was causing crash loop)
- Resolution restore only on **`onLoadSucceeded`**
- **`ensureConservativeGraphicsForLoad()`** — pins 1280×720 or lower + 8 GB VRAM after recent crashes
- Safe mode escalation: 1280×720 → **800×450** on repeated failures
- Enhanced diagnostics: `shaderErrors`, `gpuVramPreset`, `outdoorsMaskBakeEstimate`, load-slim flags
- **`installWebGLShaderDiagnostics()`** for Three.js shader validation capture
- Diagnosis strings for load-slim, fadeIn streaming burst, outdoors baking

### 2. Client graphics settings (pre-scene access)

- **`scripts/settings/scene-settings.js`** — client-scoped GPU VRAM + render resolution Foundry settings
- **`scripts/ui/graphics-settings-menu-app.js`** — configure before Map Shine initializes
- **`scripts/ui/graphics-settings-manager.js`** — merges client defaults at bootstrap

### 3. Load-slim compositor (`scripts/compositor-v2/load-slim-compositor.js`)

**Policy:** defer heavy effect RT allocation when loading AND (≥130 MP OR ≤8 GB VRAM + ≥90 MP OR multifloor ≥90 MP on ≤12 GB).

**Deferred effects (13):**

- ShadowManagerV2, VegetationBillboardShadowPasses, UpperFloorAlphaCompositor, SkyOcclusionPrimitive
- LightingEffectV2, BloomEffectV2, OverheadShadowsEffectV2, BuildingShadowsEffectV2
- SkyReachShadowsEffectV2, PaintedShadowEffectV2, AtmosphericFogEffectV2, FogOfWarEffectV2, DistortionManagerV2

Also:

- Skip GPU mask **texture warmup** during load-slim
- Use **UnsignedByte** compositor RTs during load-slim (not HalfFloat)

### 4. FloorCompositor load-slim integration (`scripts/compositor-v2/FloorCompositor.js`)

- **`runOrDeferHeavyInit()`** — queues deferred inits
- **`finishLoadSlimEffectInit()`** — runs deferred inits after load (staggered with `yieldToMain` + rAF)
- **`_loadSlimPendingEffects`** Set — tracks which effects must not receive GPU work yet
- **`onResize` guards** — skip resize/onResize for pending effects; store pending dimensions
- **`_applyCurrentFloorVisibility`** — minimal path during `__msaSceneLoading` (no outdoors GPU bakes)
- **`flushDeferredBandOutdoorsRepair()`** — with `{ force: true }` after loading flag clears
- **`finishLoadSlimEffectInit` moved before `renderLoop.start()`** in canvas-replacement

### 5. Camera follower deferral (`scripts/foundry/camera-follower.js`)

- **`_emitLevelContextChanged`** deferred during `__msaSceneLoading`
- **`flushDeferredLevelContextEmit()`** after load completes

### 6. GpuSceneMaskCompositor guards (`scripts/masks/GpuSceneMaskCompositor.js`)

- **`ensureSceneSpaceOutdoorsForFloor`** and **`prepareVisibleFloorsForOutdoorsStack`** bail during scene loading and on context lost

### 7. Streaming burst cap (`scripts/streaming/streamed-background-grid.js`)

- For ≤8 GB VRAM + ≥90 MP scenes: max inflight pyramid uploads capped at **3** (was up to **8** when budget had headroom)
- During load: inflight capped at **1** for constrained huge scenes

### 8. Canvas replacement pipeline (`scripts/foundry/canvas-replacement.js`)

- Reordered: conservative graphics before resolution restore
- Skip texture warmup when load-slim
- Post-load order: finishLoadSlim → clear loading flag → outdoors repair → level context → onLoadSucceeded
- Progress label `scene.managers.compositor.init` during compositor warmup

---

## Diagnostic fields (crash report)

Use these when triaging new reports:

| Field                               | Meaning                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `load.phase`                        | Last progress label (may lag coordinator state)                |
| `graphics.loadSlimCompositorActive` | Load-slim was engaged at compositor init                       |
| `graphics.loadSlimPendingEffects`   | Effects still waiting for GPU init (13 = not yet past prewarm) |
| `graphics.loadSlimDeferredCount`    | Steps queued (same as pending until finish runs)               |
| `textureLeakProbe.topSites`         | Allocation stack traces — **best pointer to immediate cause**  |
| `memory.usedJSHeapMB`               | JS heap — latest report showed **2146 MB** (investigate)       |
| `tileStreaming.backgroundGrids`     | Whether 144 MP pyramid mounted                                 |
| `module.versionMismatch`            | Hard refresh (Ctrl+F5) required after deploy                   |

---

## Crash history summary (2026-07-06 session)

| Time (UTC) | Phase                | Textures | Notes                                                                |
| ---------- | -------------------- | -------- | -------------------------------------------------------------------- |
| 14:24:15   | gpu.textureWarmup    | 19       | Pre load-slim / compositor RT spike                                  |
| 14:24:30   | cinematicCamera.init | 13       | Outdoors repair path                                                 |
| 14:32:03   | initializeUI         | 9        | Load-slim active; onResize RT leak suspected                         |
| 14:33:16   | fadeIn               | **256**  | Streaming burst; 96 resident cells, 11 inflight                      |
| 14:40:42   | initializeUI         | 9        | All 13 effects still pending; mask/tile upload spike; JS heap 2.1 GB |

---

## Current hypothesis (latest crash)

1. **Load-slim onResize guard appears partially effective** — no OverheadStamp/BuildingShadows in latest topSites; `loadSlimPendingEffects: 13` confirms deferred effects were not materialized.

2. **Crash at `initializeUI` before `finishLoadSlimEffectInit`** — heavy compositor stack not yet allocated; pressure likely from:

   - **`loadTextureAsync`** — mask bundle GPU uploads (12 allocations)
   - **TileManager / FloorRenderBus** tile albedo loads
   - **Foundry PIXI** + **Chrome** sharing 8 GB with Map Shine
   - Possible **JS heap pressure** (2146 MB) contributing to overall system stress

3. **If load survives to `fadeIn`** — pyramid streaming can still spike to 256+ textures unless inflight cap and governor pacing hold.

4. **Version mismatch persists** on mythicamachina.com — always hard-refresh after deploy; mixed runtime/disk versions complicate testing.

---

## Workarounds

| Workaround                                                    | Effect                                           |
| ------------------------------------------------------------- | ------------------------------------------------ |
| **Native Foundry Rendering** (Configure Settings → Map Shine) | Bypasses Three.js entirely                       |
| **800×450 + 8 GB VRAM preset**                                | Reduces compositor RT size; not sufficient alone |
| Close other GPU tabs/apps                                     | Reduces shared VRAM contention                   |
| Hard refresh Ctrl+F5 after module update                      | Ensures latest JS is running                     |

---

## Remaining work (prioritized)

### P0 — Must investigate next

1. **Defer or pace mask `loadTextureAsync` during `initializeUI`** on load-slim + 8 GB + 144 MP — top crash site in latest report.
2. **Move or split `initializeUI`** so heavy Tweakpane/effect binding does not overlap with mask GPU uploads.
3. **Investigate JS heap 2.1 GB** during load — mask bundle retention, duplicate loads, or UI init leak.
4. **Confirm deploy + version sync** — eliminate `versionMismatch` on test server.

### P1 — Hardening

5. Run **`finishLoadSlimEffectInit` earlier** (before `initializeUI`) OR split into micro-batches across load phases.
6. **Stagger deferred effect init** through `gpu-work-scheduler` (EFFECT category) instead of tight loop.
7. **Cap initial pyramid resident cells** on 8 GB for first N seconds after background grid mounts.
8. Fix stale progress label (`gpu.textureWarmup` while `initializing_compositor`).

### P2 — UX / ops

9. Expose load-slim / pending-effect status on loading overlay for support.
10. Document safe mode + graphics presets in user-facing help.

---

## Key source files

| Path                                            | Role                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `scripts/foundry/canvas-replacement.js`         | Master load pipeline, resize handler, finishLoadSlim timing |
| `scripts/compositor-v2/FloorCompositor.js`      | Compositor init, load-slim, onResize, outdoors defer        |
| `scripts/compositor-v2/load-slim-compositor.js` | Load-slim policy                                            |
| `scripts/core/webgl-crash-recovery.js`          | Crash capture, safe mode, diagnosis                         |
| `scripts/masks/GpuSceneMaskCompositor.js`       | Outdoors mask GPU baking                                    |
| `scripts/foundry/camera-follower.js`            | Level context hook deferral                                 |
| `scripts/streaming/streamed-background-grid.js` | Pyramid streaming, inflight caps                            |
| `scripts/assets/loader.js`                      | `loadTextureAsync`, mask warmup                             |
| `scripts/scene/tile-manager.js`                 | Tile texture loading during UI phase                        |

---

## Testing checklist

After each fix deploy to mythicamachina.com:

- [ ] Hard refresh (Ctrl+F5) — verify `versionMismatch: false`
- [ ] Console: `FloorCompositor: load-slim GPU init (~144 MP, 8 GB VRAM tier)`
- [ ] Console: `GPU texture warmup skipped (load-slim…)` when applicable
- [ ] Console: `initializing 13 deferred effect(s) after load` **before** `Render loop started`
- [ ] Crash report: `loadSlimPendingEffects: 0` after prewarm phase
- [ ] Scene reaches fadeIn without context loss
- [ ] Background grid shows textured cells (not grey solid only)

---

## Related agent transcript

Full conversation history: agent transcript `92a45c0a-82f0-417f-9e34-6059dbb2422b` (Cursor agent transcripts folder).

---

_This document should be updated when the scene loads successfully on 8 GB hardware or when the root cause is confirmed and fixed._
