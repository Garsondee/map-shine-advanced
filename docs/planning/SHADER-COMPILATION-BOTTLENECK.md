# Shader Compilation Bottleneck — Investigation & Fix Plan

## Problem Statement

Scene loading takes **~65 seconds**, with **57.5 seconds (88%)** spent in shader compilation. This is a hard block on the main thread — no JavaScript timeouts, intervals, or animation frames can fire during this period.

The loading screen is visible but frozen during this time, giving no feedback to the user.

## Root Cause (Confirmed via Profiler)

### The Hardware Constraint

| Fact | Value |
|------|-------|
| GPU | AMD Radeon R9 200 Series (2013 era) |
| WebGL Backend | ANGLE → Direct3D11 |
| `KHR_parallel_shader_compile` | **NOT available** |
| Shader Programs Compiled | **78** |
| Total Compilation Time | **57,574ms** |
| Average Per-Program | **~740ms** |

Without `KHR_parallel_shader_compile`, there is **no way for JavaScript to compile shaders asynchronously**. The ANGLE/D3D11 translation layer compiles HLSL bytecode synchronously on every `gl.useProgram()` call that encounters an un-compiled program. Each program stalls the main thread for 500-1500ms on this GPU.

### Where The 78 Programs Come From

| Phase | Programs | Source |
|-------|----------|--------|
| Phase 1: `compileAsync(threeScene)` | 32 | Scene-graph materials (effect meshes in the scene) |
| Phase 2: `effectComposer.render(0)` warmup | +44 → 76 | Post-processing full-screen passes, render targets, ping-pong buffers |
| First render loop frame | +2 → 78 | Late-bound materials (conditional paths, lazy effects) |

### Why Previous Fixes Didn't Help

| Fix Attempted | What It Did | Why It Didn't Help |
|---------------|------------|-------------------|
| `compileAsync()` before render loop | Queued GL compile commands for scene-graph materials | Without `KHR_parallel_shader_compile`, GL calls return immediately but compilation is deferred to first draw call. Also only covers scene-graph materials (32/78). |
| Warmup `effectComposer.render(0)` + `gl.finish()` | Moved the stall from `waitForThreeFrames` into the `gpu.shaderCompile` loading phase | Total time unchanged — the stall now happens during loading instead of after, but it's still 57s. The loading overlay is frozen during the block. |
| Reduced `waitForThreeFrames` parameters | Lowered frame/timeout requirements | The timeout couldn't fire anyway because the event loop was blocked. Now that warmup absorbs the block, `waitForThreeFrames` dropped to 2s — but total time is the same. |
| Particle prewarm disabled | Removed 1-3s of synchronous particle simulation | Negligible compared to 57s of shader compilation. |
| Tile canvas copy cap | Reduced `drawImage` cost for oversized tiles | Negligible. The tile fetch itself times out (server latency), not the canvas copy. |

**Bottom line: No amount of rearranging WHEN compilation happens will fix this. The only solution is to reduce HOW MANY programs need compiling, or HOW LONG each one takes.**

---

## Investigation Results (Codebase Audit)

### Full Shader Program Inventory

Searched every `new THREE.ShaderMaterial`, `new THREE.RawShaderMaterial`, and `new THREE.MeshBasicMaterial` across the codebase. Results:

- **73** `ShaderMaterial` creations across 47 files
- **3** `RawShaderMaterial` (all in LensflareEffect)
- **~30** `MeshBasicMaterial` (excluding vendor), most share the same GL program

Many `ShaderMaterial` instances share vertex+fragment source (e.g. DistortionManager's blurH/blurV), so 73 materials ≠ 73 unique programs. Estimated **~70-80 unique programs**, matching the observed 78.

### Program Ownership by Effect

| Effect | Materials Created | Est. Unique Programs | Default Enabled? |
|--------|:-:|:-:|:-:|
| **LightingEffect** | 5 SM + 1 MBM | **5** (3 are debug-only) | Yes |
| **CloudEffect** | 4 SM | **4** | Yes |
| **PlayerLightEffect** | 4 SM + 2 MBM | **6** | Yes |
| **DistortionManager** | 4 SM | **3** (blurH/V share) | Yes |
| **BloomEffect** | 3 SM + 1 MBM | **4** | **No** |
| **WorldSpaceFogEffect** | 3 SM + 4 MBM | **5** | Yes |
| **LensflareEffect** | 3 Raw + 1 MBM | **4** | Yes |
| **MaskManager** | 3 SM + 1 MBM | **4** | Yes |
| **VisionSDF** | 3 SM | **3** | Yes |
| **WindowLightEffect** | 2 SM | **2** | **No** (no mask) |
| **BushEffect** | 2 SM | **2** | Yes (mask present) |
| **TreeEffect** | 2 SM | **2** | Yes (mask present) |
| **SelectionBoxEffect** | 2 SM | **2** | Yes |
| **EnhancedLightIconMgr** | 2 SM | **2** | Yes |
| **WaterEffectV2** | 1 SM (massive) | **1** | Yes |
| **SpecularEffect** | 1 SM | **1** | Yes |
| **BuildingShadowsEffect** | 1 SM + 1 MBM | **2** | Yes |
| **OverheadShadowsEffect** | 1 SM | **1** | Yes |
| **CandleFlamesEffect** | 1 SM | **1** | Yes |
| **SkyColorEffect** | 1 SM | **1** | Yes |
| **ColorCorrectionEffect** | 1 SM | **1** | Yes |
| **AtmosphericFogEffect** | 1 SM | **1** | Yes |
| **LightningEffect** | 1 SM | **1** | Yes |
| **VisionModeEffect** | 1 SM | **1** | Yes |
| **DetectionFilterEffect** | 1 SM | **1** | Yes |
| **DynamicExposureMgr** | 1 SM | **1** | Yes |
| **SharpenEffect** | 1 SM | **1** | Yes |
| **AsciiEffect** | 1 SM | **1** | **No** |
| **DotScreenEffect** | 1 SM | **1** | **No** |
| **HalftoneEffect** | 1 SM | **1** | **No** |
| **FilmGrainEffect** | 1 SM | **1** | **No** |
| **DazzleOverlayEffect** | 1 SM | **1** | **No** |
| **IridescenceEffect** | 1 SM | **1** | **No** (no mask) |
| **PrismEffect** | 1 SM | **1** | **No** (no mask) |
| **MaskDebugEffect** | 1 SM | **1** | **No** |
| **DebugLayerEffect** | 2 MBM | **1** | **No** |

**Non-effect systems** (always created):

| System | Programs | Notes |
|--------|:-:|-------|
| ThreeLightSource | **1** | 1 per light, but all share same shader |
| ThreeDarknessSource | **1** | Same — shared program |
| grid-renderer | **1** | |
| light-icon-manager | **1** | |
| enhanced-light-icon-manager | **2** | |
| physics-rope-manager | **1** | |
| LightMesh | **1** | |
| RainStreakGeometry | **1** | Particle shader |
| SnowGeometry | **1** | Particle shader |
| particles/rendering.js | **1** | three-quarks batch shader |
| tile-manager | **1** | |
| composer.js (base plane) | **2** | MeshBasicMaterial variants |
| MeshBasicMaterial variants | **~3** | Shared across managers |

### Key Finding: EffectComposer Already Skips Disabled Effects

`resolveRenderOrder()` (EffectComposer.js line 418) checks `if (effect.enabled)` and excludes disabled effects from the render pass. Disabled scene effects also set `mesh.visible = false`, so Three.js skips them during `renderer.render(scene, camera)`.

**This means the 76 programs compiled during warmup are almost entirely from ENABLED effects.** The disabled effects (ASCII, DotScreen, etc.) already DON'T compile during warmup.

### Where The 76 Programs Actually Come From

| Category | Programs | Time @ 740ms each |
|----------|:-:|:-:|
| Core always-on effects | ~36 | ~26.6s |
| Scene-conditional effects (bush, tree, etc.) | ~10 | ~7.4s |
| Non-effect systems (grid, particles, lights, etc.) | ~16 | ~11.8s |
| Lensflare + PlayerLight + SelectionBox | ~12 | ~8.9s |
| **Total** | **~74** | **~54.8s** |

### Saveable Programs (Low-Hanging Fruit)

| Optimization | Programs Saved | Time Saved |
|-------------|:-:|:-:|
| LightingEffect: defer 3 debug materials | 3 | ~2.2s |
| WindowLightEffect: skip if no _Windows mask | 2 | ~1.5s |
| VisionSDF: lazy-create on first request | 3 | ~2.2s |
| PlayerLightEffect: defer flashlight materials | 4 | ~3.0s |
| SelectionBoxEffect: defer until first selection | 2 | ~1.5s |
| MaskManager: defer processing materials | 3 | ~2.2s |
| LensflareEffect: defer until first lensflare | 4 | ~3.0s |
| BloomEffect: skip if disabled | 4 | ~3.0s |
| **Total** | **~25** | **~18.5s** |

This would reduce compilation from **~57s to ~39s** — significant but still slow.

### Duplicate / Near-Duplicate Shader Analysis

- **DistortionManager** blurH/blurV: Same source → already share 1 program ✓
- **BushEffect / TreeEffect**: Very similar shaders but different fragment code → 4 separate programs
- **LightingEffect debug materials**: 3 trivial shaders that could be 1 with a uniform switch
- **ThreeLightSource / ThreeDarknessSource**: Similar radial gradient shaders → 2 programs, could be 1

### Browser Shader Cache Investigation

Chrome/ANGLE maintains an internal shader cache keyed by shader source hash. Investigation needed:

- [ ] **Test**: Load scene twice (F5 reload) and compare `gpu.shaderCompile` times
- [ ] **Risk**: If any shader source contains dynamic content (canvas dimensions, generated #defines), the cache key changes between loads and the cache misses
- [ ] **Audit**: Check if `window.innerWidth/innerHeight` or resolution values appear in shader source strings (vs uniforms)

Potential cache-busters found during audit:
- `WindowLightEffect`: `uResolution` is a uniform (safe ✓)
- `WaterEffectV2`: `uResolution` is a uniform (safe ✓)  
- Most effects: No dynamic content in shader strings (safe ✓)

**If the browser cache works, second load should be near-instant.** This needs testing.

---

## Proposed Fixes (Ordered by Impact)

### Fix A: Progressive Warmup with Event Loop Yields (HIGHEST PRIORITY)

**Goal:** Keep the loading UI responsive during the unavoidable ~57s compilation.

The current `effectComposer.render(0)` blocks for 57 seconds with a frozen loading screen. Even though we can't reduce total compilation time much on this GPU, we **can** make the loading bar move.

**Approach:**
1. Before starting the render loop, collect all unique materials from the scene graph
2. For each material (or small batch of 3-5):
   a. Assign it to a temporary mesh in a minimal scene
   b. Call `renderer.render(miniScene, camera)` to trigger compilation
   c. Call `gl.finish()` to ensure the GPU is done
   d. `await new Promise(r => setTimeout(r, 0))` to yield to the event loop
   e. Update loading overlay: `"Compiling shader 15/76…"`
3. Then do one final `effectComposer.render(0)` to catch any remaining post-processing materials
4. Total time is the same (~57s) but the loading bar updates every ~1s

**Estimated improvement:** 0 seconds saved, but loading screen shows live progress instead of freezing. Users know the app isn't broken.

### Fix B: Defer Non-Essential Material Creation (MEDIUM IMPACT, MEDIUM EFFORT)

**Goal:** Reduce program count from 76 to ~50, saving ~19 seconds.

**Defer these materials until first actual use:**

| Component | Programs | How to Defer |
|-----------|:-:|-------------|
| LightingEffect debug mats | 3 | Create on first `setDebugMode(true)` |
| VisionSDF | 3 | Create on first `computeSDF()` call |
| PlayerLightEffect flashlight | 4 | Create on first `_createFlashlightMesh()` call from token attachment |
| LensflareEffect | 4 | Create in first `onBeforeRender` instead of constructor |
| SelectionBoxEffect | 2 | Create on first `showBox()` call |
| MaskManager processing | 3 | Create on first `processTexture()` call |
| BloomEffect (if disabled) | 4 | Skip material creation in `initialize()` if `enabled=false` |
| WindowLightEffect (no mask) | 2 | Skip if no `_Windows` mask in bundle |

**Estimated savings:** ~25 programs × 740ms = **~18.5 seconds** → load drops from ~57s to ~39s.

### Fix C: Test Browser Shader Cache (LOW EFFORT, POTENTIALLY HUGE IMPACT)

**Goal:** Determine if second loads are fast (browser caches compiled shaders).

**Approach:**
1. Load the scene in debug mode, note `gpu.shaderCompile` time
2. F5 reload the page
3. Load the same scene again, note `gpu.shaderCompile` time
4. If dramatically faster → browser cache is working, and first-load is the only issue

**If cache works:** First load is ~57s but subsequent loads could be <1s. We only need to solve first-load UX (Fix A).

**If cache doesn't work:** We need to investigate why (shader source instability) and fix it.

### Fix D: Uber-Shader Consolidation (HIGH IMPACT, HIGH EFFORT)

**Goal:** Reduce unique programs by merging similar shaders.

**Candidates for consolidation:**

| Group | Current Programs | Merged To | Savings |
|-------|:-:|:-:|:-:|
| Simple post-processing (ColorCorrection, FilmGrain, DotScreen, Halftone, Sharpen, ASCII) | 6 | 1 | 5 |
| Shadow effects (Overhead, Building, Bush shadow, Tree shadow) | 4 | 1-2 | 2-3 |
| LightingEffect debug materials | 3 | 1 | 2 |
| ThreeLightSource + ThreeDarknessSource | 2 | 1 | 1 |
| Bush overlay + Tree overlay (similar structure) | 2 | 1 | 1 |

**Estimated savings:** ~11 programs × 740ms = ~8 seconds (on top of Fix B).

**Trade-offs:** Significant refactoring, uber-shaders are harder to maintain, GPU branching overhead.

### Fix E: GPU Tier Detection + User Messaging (LOW EFFORT, UX)

**Goal:** Set user expectations on slow GPUs.

**Approach:**
1. Detect `KHR_parallel_shader_compile` availability early
2. If missing, show: `"First load may take 30-60s on your GPU. Subsequent loads will be faster."`
3. Offer a "Lite Mode" button that disables non-essential effects before compilation
4. Show per-shader progress during progressive warmup (Fix A)

---

## Recommended Implementation Order

| Priority | Fix | Time Saved | Effort | UX Impact |
|:-:|-----|:-:|:-:|:-:|
| 1 | **A: Progressive warmup** | 0s | Medium | **Huge** — loading bar moves |
| 2 | **C: Test browser cache** | 57s on 2nd load? | Low | **Huge** if it works |
| 3 | **B: Defer non-essential materials** | ~18.5s | Medium | Large |
| 4 | **E: GPU tier messaging** | 0s | Low | Medium — set expectations |
| 5 | **D: Uber-shader consolidation** | ~8s | High | Medium |

**If Fix C confirms the browser cache works**, the problem is mostly a first-load issue. Fix A (progressive warmup with progress bar) + Fix B (defer ~25 programs) would bring first load from 57s → ~39s with a responsive loading UI, and all subsequent loads would be <1s.

---

## Quick Wins Checklist

- [ ] **Test browser shader cache** — Load scene twice, compare times (Fix C)
- [ ] **Implement progressive warmup** — Replace `effectComposer.render(0)` with per-material batches + yields (Fix A)
- [ ] **Defer LightingEffect debug materials** — 3 programs, trivial change
- [ ] **Defer VisionSDF** — 3 programs, create on first use
- [ ] **Skip BloomEffect materials when disabled** — 4 programs
- [ ] **Skip WindowLightEffect when no mask** — 2 programs
- [ ] **Defer PlayerLightEffect flashlight** — 4 programs, create on first token attach
- [ ] **Defer LensflareEffect internals** — 4 programs, create in first `onBeforeRender`
- [ ] **Add GPU tier message** — "Compiling shader 15/76…" during warmup

## Measurements Still Needed

1. **Browser shader cache test** — Does second load compile faster?
2. **Per-program compilation time** — Are some shaders much slower than others?
3. **Modern GPU baseline** — What does this look like WITH `KHR_parallel_shader_compile`?
