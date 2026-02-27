# Loading Stall at 30% — Deep Audit Report

## Executive Summary

Loading stalls at exactly **30%** because that is the boundary between the `assets.load` stage (weight 25, range 5–30%) and `effects.core` stage (weight 15, range 30–45%). The progress bar reaches 30% when `sceneComposer.initialize()` completes and the GPU texture warmup finishes. **Multiple downstream blocking points** can then prevent the bar from advancing further — which one fires depends on whether V1 or V2 compositor mode is active and on server/GPU responsiveness.

---

## 1. How Loading Stages Map to Percentages

The loading overlay uses weighted stages configured in `canvas-replacement.js:1715–1724`:

| Stage | Weight | Global Range |
|-------|--------|-------------|
| `assets.discover` | 5 | 0–5% |
| `assets.load` | 25 | 5–30% |
| `effects.core` | 15 | 30–45% |
| `effects.deps` | 10 | 45–55% |
| `effects.wire` | 5 | 55–60% |
| `scene.managers` | 15 | 60–75% |
| `scene.sync` | 15 | 75–90% |
| `final` | 10 | 90–100% |

**30% = `assets.load` at 100% = `effects.core` at 0%.**

The global progress is computed as `range.start + (range.end - range.start) * stageProgress`.

---

## 2. What Drives Progress to 30%

Inside `createThreeCanvas()`:

1. **Line 1726**: `setStage('assets.discover', 0.0)` + `startAutoProgress(0.08, 0.02)` — auto-creep to ~8%.
2. **Line 1895**: `await sceneComposer.initialize(...)` — the `onProgress` callback drives `assets.load` from 0→1 as masks load.
3. **Line 1981**: GPU texture warmup sets `assets.load` to 1.0 explicitly → **global = 30%**.
4. **Line 2098**: `setStage('effects.core', 0.0, ..., { immediate: true })` → global = 30%.
5. **Line 2099**: `startAutoProgress(0.55, 0.015)` — auto-creep from 30% toward 55%.

**For the user to see 30% and then a stall, `sceneComposer.initialize()` MUST have completed** — otherwise the bar would be stuck at ≤8%. The stall occurs in the code that runs *after* the 30% mark is set.

---

## 3. Critical Blocking Points After 30%

### 3.1 `weatherController.initialize()` (Line 2118) — **HIGH RISK**

The first `await` after the 30% mark. Internally it calls:

```
_loadDynamicStateFromScene()          — sync, reads scene flags
_loadQueuedTransitionTargetFromScene() — sync, reads scene flags
await _loadWeatherSnapshotFromScene()  — ASYNC, contains:
  └─ await canvas.scene.update(...)    — Foundry server call (line 927)
  └─ await stateApplier.applyTimeOfDay(...)  — can cascade
```

**Risk**: `canvas.scene.update()` is a Foundry server request. If the server is slow, unreachable, or if there's a socket.io backpressure issue, this `await` can hang indefinitely. The method is wrapped in `try-catch` so it *should* fail gracefully, but a hung promise (socket waiting forever) would stall the entire pipeline.

### 3.2 V2 FloorCompositor Warmup — Synchronous GPU Stall (Lines 2158–2177) — **MEDIUM RISK**

```js
const fc = effectComposer._getFloorCompositorV2();  // Creates 15+ effect instances
renderer.compile(fc._composeScene, warmupCamera);    // Synchronous GPU call
renderer.compile(fc._blitScene, warmupCamera);       // Synchronous GPU call
renderer.compile(fc._renderBus._scene, warmupCamera); // Synchronous GPU call
```

`_getFloorCompositorV2()` creates the full `FloorCompositor` with all V2 effects (Water, Lighting, Cloud, Specular, Fire, etc.). However, `renderer.compile()` only compiles materials **present in the scene**:

- `_blitScene`: 1 simple passthrough quad — trivial.
- `_renderBus._scene`: **empty** (populate hasn't been called yet) — no-op.
- `_composeScene`: likely null at this point — skipped.

**Conclusion**: The warmup is mostly a no-op in current code. The expensive shader compilation (69KB water fragment shader, etc.) actually happens lazily on the **first render frame** via `FloorCompositor.render()` → `populate()`. This means the warmup provides almost no protection against the first-frame stall.

**However**: The `_getFloorCompositorV2()` call itself constructs many ShaderMaterial instances (Lighting, Water, Cloud, etc.) which trigger GLSL compilation on `material.needsUpdate`. If `renderer.compile()` forces these to compile, and the GPU lacks `KHR_parallel_shader_compile`, this blocks the main thread for seconds. During this block, auto-progress cannot tick and the loading bar appears frozen at 30%.

This is wrapped in `safeCall(..., Severity.DEGRADED)`, so it won't permanently hang — but can cause a multi-second freeze.

### 3.3 V1 Effect Pipeline (Lines 2180–2545) — **HIGH RISK (if V1 mode)**

If `_v2Active` is `false` (V1 mode), the code enters a massive sequential initialization block:

- `registerEffectBatch()` with concurrency 4 (or 1 in debug mode) — initializes 20+ effects
- Each effect's `initialize()` can trigger shader compilation
- `await graphicsSettings.initialize()` — reads settings, may do server calls
- 7 dependent effects registered sequentially (`await effectComposer.registerEffect(...)`)
- Wire base meshes, connect to registry, etc.

Any hung `await` in this block stalls at ~30%.

### 3.4 `_v2Active` Computation — **MEDIUM RISK**

```js
const _v2Active = (() => {
    try { return !!game?.settings?.get('map-shine-advanced', 'useCompositorV2'); } catch (_) { return false; }
})();
```

If `game.settings.get()` throws (corrupted settings, module not registered yet), `_v2Active` falls back to `false` and the V1 path runs — potentially hitting V1-only stall points even when the user expects V2.

### 3.5 Auto-Progress Killed by `{ immediate: true }` — **COSMETIC RISK**

```js
// Line 2154 (V2 warmup):
loadingOverlay.setStage('effects.core', 0.0, 'Initializing V2 compositor…', { immediate: true });
```

`setProgress()` with `immediate: true` and no `keepAuto: true` **kills auto-progress** (`this._autoProgress = null`). The next line restarts it, but there's a window where auto-progress is dead. If a synchronous stall happens between the kill and restart, the bar doesn't move.

---

## 4. `sceneComposer.initialize()` — Internal Blocking Points

Even though `sceneComposer.initialize()` *does* complete (proven by reaching 30%), it's worth documenting its potential slow points for completeness:

### 4.1 `getFoundryBackgroundTexture()` (Line 491)

Three fallback paths:
1. **PIXI path**: Read `canvas.primary.background.texture` — synchronous, fast.
2. **Foundry loader**: `await loadTexture(bgSrc)` — server fetch.
3. **THREE.TextureLoader**: `await new Promise(loader.load(...))` — network fetch.

If the primary path fails and fallbacks are tried, this adds latency.

### 4.2 `loadAssetBundle()` (Line 531)

- `discoverAvailableFiles()` → `FilePicker.browse('data', dir)` — **Foundry server call**. Can hang if the server is slow.
- Mask loading with Semaphore(4) — 14 mask types probed, 4 concurrent fetches.
- `loadMaskTextureDirect()` → `fetch()` + `createImageBitmap()` — off-thread decode.

### 4.3 `_probeBestMaskBasePath()` Retry Loop (Lines 560–587)

If `loadAssetBundle()` returns zero masks, a retry loop runs **6 attempts × 50ms delay**:
- Each attempt calls `_probeBestMaskBasePath()` which iterates ALL tiles and calls `_loadMasksOnlyForBasePath()` for each.
- Each probe does `loadAssetBundle(basePath, null, { skipBaseTexture: true })`.
- This means potentially **6 × N tiles × FilePicker.browse()** server calls.

On a scene with many tiles and a slow server, this retry loop could take 10+ seconds.

---

## 5. TileManager Texture Loading (Background, Non-Blocking)

Tile textures load **non-blocking** — `tileManager.syncAllTiles()` fires `createTileSprite()` for each tile, which calls `loadTileTexture()` asynchronously. The concurrency limiter caps this at 6 parallel loads.

The loading pipeline implemented in the previous session (stage-specific timeouts, concurrency limiter) is correct and should prevent cascading failures. However, if the server is slow, tiles will still take a long time to appear — this is by design (non-blocking, tiles pop in when ready).

**Key observation**: `FloorRenderBus.populate()` (V2) also loads all tile textures independently via `THREE.TextureLoader`. This means in V2 mode, tiles are loaded **twice** — once by TileManager and once by FloorRenderBus. This doubles network/decode work and could contribute to resource contention.

---

## 6. V2 FloorCompositor First-Frame Stall

The V2 FloorCompositor warmup (lines 2158–2177) is **ineffective** because:

1. `_composeScene` is null during warmup (no compose scene exists yet).
2. `_renderBus._scene` is empty (populate hasn't been called).
3. `_blitScene` has only a trivial passthrough shader.

The **real** shader compilation happens on the first render frame when `FloorCompositor.render()` calls `populate()` and then `renderer.render()` with all the materials for the first time. This includes:

- WaterEffectV2's 69KB fragment shader
- LightingEffectV2's complex shader
- CloudEffectV2's multi-pass shaders
- All post-processing effect shaders

Without `KHR_parallel_shader_compile`, this first-frame compilation can block the main thread for **5–30+ seconds** depending on GPU/driver, appearing as a black screen or frozen loading overlay *after* the overlay has faded out.

---

## 7. Root Cause Summary

The 30% stall is caused by **one or more of these blocking points occurring after `assets.load` completes**:

| Priority | Cause | Type | Affected Mode |
|----------|-------|------|---------------|
| **P0** | `weatherController.initialize()` → `canvas.scene.update()` server call hangs | Async hang | Both V1 & V2 |
| **P0** | V1 effect pipeline (if V1 mode) — 20+ effect `initialize()` + shader compilation | Async + sync | V1 only |
| **P1** | `_getFloorCompositorV2()` material construction triggers synchronous GPU stall | Sync block | V2 only |
| **P1** | `_v2Active` silently falls back to false, entering V1 path unexpectedly | Logic bug | Both |
| **P2** | Auto-progress killed by `{ immediate: true }` during sync stall window | Cosmetic | Both |
| **P2** | Duplicate tile texture loading (TileManager + FloorRenderBus) | Resource waste | V2 only |

---

## 8. Recommendations

### 8.1 Immediate Fixes (P0)

1. **Add timeout to `weatherController.initialize()`**: Wrap the `canvas.scene.update()` call in a `Promise.race` with a 5s timeout. If the server doesn't respond, skip darkness restoration and continue.

2. **Add progress advancement before each major await**: Insert `loadingOverlay.setStage('effects.core', X, ..., { keepAuto: true })` calls between each blocking operation so the bar advances even if individual steps are slow.

3. **Log the exact blocking point**: Add `console.time`/`console.timeEnd` markers around each await between 30% and 60% so the user can identify exactly which step is hanging from the browser console.

### 8.2 Structural Fixes (P1)

4. **Fix V2 FloorCompositor warmup to actually compile shaders**: Instead of compiling empty scenes, explicitly create a temporary mesh with each post-processing material and add it to a throwaway scene before calling `renderer.compile()`. This would front-load the shader compilation during the loading screen instead of on the first render frame.

5. **Guard `_v2Active` with explicit logging**: If the setting lookup fails, log a warning so the user knows V2 mode was not activated.

6. **Always use `{ keepAuto: true }` with `setStage`**: The pattern of `setStage(..., { immediate: true })` followed by `startAutoProgress(...)` has a race window. Use `{ immediate: true, keepAuto: true }` or move auto-progress start before the stage set.

### 8.3 Optimization (P2)

7. **Deduplicate tile texture loading in V2 mode**: FloorRenderBus should read textures from TileManager's cache instead of loading them independently. This halves the network/decode work.

8. **Add a hard timeout safety net around the entire `createThreeCanvas` init**: If loading hasn't advanced past a certain point within 60 seconds, force-dismiss the loading overlay and log a diagnostic dump so the user isn't permanently locked out.

---

## 9. Diagnostic Checklist for Reproducing

When the stall occurs, the user should check:

1. **Browser Console**: Look for the last log message before the stall — this identifies which step is blocking.
2. **Network Tab**: Check if any requests are pending (hung `FilePicker.browse`, `canvas.scene.update`, or texture fetches).
3. **Performance Tab**: Record during the stall — look for long synchronous GPU tasks (shader compilation) or idle awaits.
4. **`KHR_parallel_shader_compile`**: Run `renderer.getContext().getExtension('KHR_parallel_shader_compile')` — if null, all shader compilation is synchronous and will block the main thread.
5. **V2 active?**: Check `game.settings.get('map-shine-advanced', 'useCompositorV2')` — if this is unexpectedly false, the V1 path is running.

---

*Report generated from static code audit of `canvas-replacement.js`, `composer.js`, `loader.js`, `FloorCompositor.js`, `FloorRenderBus.js`, `WeatherController.js`, `tile-manager.js`, and `styled-loading-screen-renderer.js`.*
