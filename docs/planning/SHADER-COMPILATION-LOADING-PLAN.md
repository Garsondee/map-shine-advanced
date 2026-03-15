# Shader Compilation & Loading Synchronization Plan

**Created:** 2026-03-15  
**Context:** Map Shine Advanced V2 compositor pipeline  
**Problem:** Scene becomes visible long before shaders finish compiling, causing the first-frame
stutter/flash that users see when the loading screen fades out.

---

## Current State Analysis

### What We Already Have

The codebase has a significant amount of infrastructure already built:

**`FloorCompositor.warmupAsync()`** (`scripts/compositor-v2/FloorCompositor.js:1413`):
- Uses `renderer.compileAsync(scene, camera)` — Three.js's async non-blocking compile API
- Traverses all effect scenes via a sniff list + optional `getCompileTargets()` interface per effect
- Enables all camera layers so hidden floors compile too
- Has a configurable timeout (`timeoutMs = 5000ms`) with a graceful fallback
- Resolves via `KHR_parallel_shader_compile` polling (`WebGLProgram.isReady()`) when the GPU
  extension is present; falls back to `setTimeout(10)` polling otherwise
- **Returns:** `Promise<boolean>` — true = all done, false = timed out or failed

**`EffectComposer.progressiveWarmup()`** (`scripts/effects/EffectComposer.js:786`):
- Does a single `FloorCompositor.render()` call to force program creation
- Counts `renderer.info.programs` before/after for diagnostics
- Does NOT await shader compilation — programs are submitted but not necessarily linked

**`renderer.compileAsync()`** (`scripts/vendor/three/three.module.js:29397`):
- Calls `renderer.compile()` to submit programs to the GPU driver
- Polls all materials' `program.isReady()` (backed by `COMPLETION_STATUS_KHR`) every 10ms
- Returns a Promise that resolves when every submitted program reports ready

**Loading stages** (`scripts/foundry/canvas-replacement.js:2931`):
```javascript
{ id: 'assets.discover', weight: 5  },
{ id: 'assets.load',     weight: 25 },
{ id: 'effects.core',    weight: 15 },  // ← currently uses this for FloorCompositor init (39 steps)
{ id: 'effects.deps',    weight: 10 },
{ id: 'effects.wire',    weight: 5  },
{ id: 'scene.managers',  weight: 15 },
{ id: 'scene.sync',      weight: 15 },
{ id: 'final',           weight: 10 },
```

### Why Shader Warmup Is Currently Skipped

`canvas-replacement.js:3893`:
```javascript
// Skip the expensive renderer.compile() warmup. Shaders will compile lazily
// on the first render frame instead. This prevents indefinite freezes on
// certain GPU/driver combinations (observed: NVIDIA on Windows).
```

The original code used synchronous `renderer.compile()` which blocks the main thread on the GPU
driver. NVIDIA Windows drivers are particularly slow here — observed multi-second freezes.

**The fix is already in Three.js:** `renderer.compileAsync()` uses `KHR_parallel_shader_compile`
to submit programs non-blocking. The GPU compiles in a background thread; we poll readiness every
10ms on the CPU side via `setTimeout`. There is NO main thread stall from `compileAsync()` itself.
The NVIDIA freeze was a `compile()` (sync) problem, not a `compileAsync()` (async) problem.

---

## Question 1 — Can We Tell When Shaders Are Finished?

**Yes, and the mechanism is already implemented.**

Three.js `WebGLProgram.isReady()` queries `gl.getProgramParameter(program, COMPLETION_STATUS_KHR)`
when `KHR_parallel_shader_compile` is available. Without the extension it returns `true` immediately
(meaning the program will stall when first drawn instead — the old behavior).

`renderer.compileAsync()` wraps this into a polling Promise. `warmupAsync()` wraps that across all
effect scenes into a single awaitable.

**What we can add for per-program progress reporting:**

```javascript
// Poll inside a rAF loop during compilation:
const before = renderer.info.programs.length;
renderer.compile(scene, camera); // submit all programs
// now poll:
const total = renderer.info.programs.length;
let ready = 0;
while (ready < total) {
  ready = renderer.info.programs.filter(p => p.isReady()).length;
  onProgress(ready / total, `Shaders: ${ready}/${total}`);
  await sleep(16); // one frame
}
```

`renderer.info.programs` is a live array — programs are added when submitted and stay in the array
permanently (until scene teardown). We can count how many report `isReady()` to get a progress %.

**Extension support reality check:**
- Chrome/Edge (V8 + ANGLE): `KHR_parallel_shader_compile` almost always available
- Firefox (WebGL2): generally supported
- Safari (Metal backend): variable — may not expose the extension
- Without extension: `isReady()` always returns `true`, so progress jumps to 100% instantly but
  the actual stall happens on first draw. Still better than nothing.

---

## Question 2 — The "Starting Line" Gate

**Goal:** Nothing renders to the user until ALL shaders in the post-processing chain are compiled.
Time should not advance during the wait (no wind, no particles). When the gate opens, everything
starts simultaneously.

### Design

A new stage `shaders.compile` is inserted into the loading pipeline AFTER the FloorCompositor is
initialized but BEFORE `fadeIn()`. The render loop is started but the FloorCompositor gate is held.

```
[FloorCompositor.initialize()] → [first render to submit programs] → [warmupAsync() polls KHR]
                                                                              ↓
                                                              [all programs isReady()]
                                                                              ↓
                                                              [release time gate → fadeIn()]
```

**Time freeze during compilation:**
- `FloorCompositor.render()` accepts a `timeInfo` param. If we pass `deltaTime: 0` (frozen) to all
  effects during the warmup window, particles don't advance and wind doesn't move.
- Alternatively, flag `_shaderGateHeld = true` on FloorCompositor and skip time-dependent updates
  in `render()`. Release on gate open.
- This is the "starting line" — when all shaders report ready AND the fade-out completes, the gate
  opens and all systems start simultaneously from `t=0`.

**Timeout safety:**
- Keep the existing 5000ms timeout in `warmupAsync()`. On timeout: open the gate anyway, log a
  warning. Users get the current behavior (lazy compile stutter) rather than hanging forever.
- Consider making timeout configurable in graphics settings (for slow integrated GPUs).

**Render loop behavior during gate:**
- Start the render loop normally so Three.js can advance the GPU work
- The render loop SHOULD call `FloorCompositor.render()` repeatedly — this causes Three.js to
  re-submit any newly created programs (effects that create materials lazily on first render need
  this)
- But suppress `fadeIn()` from completing until `warmupAsync()` resolves

### Implementation Sketch

In `canvas-replacement.js`, replace the current "skip warmup" comment block at ~line 3893:

```javascript
// NEW: async shader warmup using compileAsync (non-blocking, uses KHR_parallel_shader_compile)
if (fc) {
  loadingOverlay.setStage('effects.core', 0.95, 'Warming up shaders...', { keepAuto: false });
  
  // Single render pass to force-submit all programs to the GPU driver
  effectComposer.progressiveWarmup();
  await new Promise(r => setTimeout(r, 16)); // one frame for driver to process

  // Now await non-blocking async compilation
  const compiled = await fc.warmupAsync(8000); // 8s timeout
  if (!compiled) {
    log.warn('Shader warmup timed out — lazy compilation will occur on first frame');
  }
  
  loadingOverlay.setStage('effects.core', 1.0, 'Shaders ready', { keepAuto: false });
}
```

The `fadeIn()` at the end of loading naturally becomes the gate because it awaits after warmup.

---

## Question 3 — Shader Compilation as Loading Bar Checkpoints

### New Loading Stage

Add a dedicated `shaders.compile` stage to the loading pipeline:

```javascript
loadingOverlay.configureStages([
  { id: 'assets.discover', label: 'Discovering assets...',   weight: 5  },
  { id: 'assets.load',     label: 'Loading textures...',     weight: 25 },
  { id: 'effects.core',    label: 'Core effects...',         weight: 10 },
  { id: 'effects.deps',    label: 'Dependent effects...',    weight: 5  },
  { id: 'effects.wire',    label: 'Wiring effects...',       weight: 5  },
  { id: 'scene.managers',  label: 'Scene managers...',       weight: 10 },
  { id: 'scene.sync',      label: 'Syncing objects...',      weight: 10 },
  { id: 'shaders.compile', label: 'Compiling shaders...',    weight: 20 }, // ← NEW
  { id: 'final',           label: 'Finalizing...',           weight: 10 },
]);
```

Weight 20 reflects that this is where a significant amount of loading time actually goes.

### Per-Shader Progress Reporting

Extend `warmupAsync()` to accept an `onProgress` callback:

```javascript
async warmupAsync(timeoutMs = 8000, onProgress = null) {
  // ... existing setup ...

  // After submitting all compileAsync calls, poll for progress
  const pollProgress = async () => {
    const programs = this.renderer.info.programs ?? [];
    while (true) {
      const ready = programs.filter(p => p.isReady?.()).length;
      const total = programs.length;
      if (total > 0 && onProgress) {
        onProgress(Math.min(ready / total, 1.0), `Shaders: ${ready}/${total}`);
      }
      if (ready >= total && total > 0) break;
      await new Promise(r => setTimeout(r, 16));
    }
  };

  await Promise.race([
    Promise.all([...promises, pollProgress()]),
    timeoutPromise
  ]);
}
```

In `canvas-replacement.js`, wire this up to the loading overlay:

```javascript
const compiled = await fc.warmupAsync(8000, (progress, label) => {
  loadingOverlay.setStage('shaders.compile', progress, label, { keepAuto: false });
});
```

### Per-Effect Shader Labels with `getCompileTargets()`

Effects that implement `getCompileTargets()` can already be identified by label in `warmupAsync()`.
Extend this so individual effects are reported as they complete:

```javascript
// In warmupAsync(), per-effect reporting:
for (const { scene, camera, label } of targets) {
  const p = this.renderer.compileAsync(scene, camera);
  p.then(() => {
    onProgress?.(/* computed progress */, `Compiled: ${label}`);
  });
  promises.push(p);
}
```

This lets the loading bar message say things like:
- `Compiled: LightingEffectV2`
- `Compiled: WaterEffectV2`
- `Compiled: FloorRenderBus`

The heaviest shaders (water ~69KB fragment, lighting, building shadows) will naturally report last.

---

## Question 4 — Other Considerations

### Shader Variant Explosion

Three.js compiles a separate WebGL program per unique combination of `#define` flags. Map Shine's
water shader alone can produce many variants because `defines` like `FOAM_ENABLED`,
`WAVE_TRI_BLEND`, `RAIN_ENABLED` etc. change the program cache key.

**Mitigation:**
- `progressiveWarmup()` does a single render which triggers the current variant (current scene
  state). This compiles the "default" variant.
- Effects that have conditional defines should eagerly set ALL defines to their maximum configuration
  during warmup, then restore. This ensures the heaviest variant is compiled during loading.
- Consider a `getWarmupDefines()` method on effects that returns a set of define combinations to
  compile ahead of time.
- For water: compile the variant with all features on (rain + foam + wave blend + murk + specular)
  since that's the worst case for compile time.

### GPU Driver Quirks

Known issues and mitigations:

| Scenario | Symptom | Mitigation |
|---|---|---|
| NVIDIA Windows (old) | Sync `compile()` freezes main thread | Already fixed: use `compileAsync()` only |
| No `KHR_parallel_shader_compile` | `isReady()` always true, progress jumps to 100% | Accept it — compile happens synchronously on first draw |
| Integrated GPU (Intel/AMD APU) | Compilation extremely slow (20-30s+) | Increase timeout; show "this may take a while" message after 5s |
| WebGL context loss during warmup | `compileAsync()` rejects | Catch and continue with lazy compilation |
| Safari Metal backend | Shader translation to MSL adds latency | No specific fix — Metal is async anyway |

### Scene Reload / Re-entry

When a second scene loads after the first, shaders from the first scene may already be in the
driver cache (same program = same `cacheKey`). Three.js's `WebGLPrograms.acquireProgram()` reuses
existing `WebGLProgram` instances by `cacheKey`.

**Implication:** Second scene loads are FASTER because most programs are already compiled.
`warmupAsync()` will see `isReady() === true` for cached programs immediately — progress jumps fast.
This is correct behavior; no special handling needed.

### Disabled Effects Still Need Warmup

An effect that is disabled (e.g., Bloom, Lens) won't have its material submitted on the first
render because disabled effects skip their render call. Their shaders will still stall on the
first time the effect is enabled mid-session.

**Fix:** `warmupAsync()` should enable all layers and force materials to be collected from every
effect's scene, even when the effect's `enabled` flag is false. The `getCompileTargets()` method
on each effect should return its scenes regardless of enabled state.

**Alternative:** Implement `getWarmupMaterials()` on effects that returns their ShaderMaterial
instances directly (bypassing scene traversal). Three.js `compile()` can take a scene with those
materials on invisible meshes.

### Time Freezing Architecture Details

The cleanest implementation of the "starting line" gate in `FloorCompositor`:

```javascript
// New field in constructor:
this._shaderWarmupGateOpen = false;

// In render():
const effectiveDeltaTime = this._shaderWarmupGateOpen ? timeInfo.deltaTime : 0;
const frozenTimeInfo = { ...timeInfo, deltaTime: effectiveDeltaTime };
// Pass frozenTimeInfo to all effects' update() calls
```

`FloorCompositor.openShaderGate()` sets `_shaderWarmupGateOpen = true`. Called from
`canvas-replacement.js` after `warmupAsync()` resolves.

This means particles are positioned but don't advance, water waves are static, weather is
initialized. When the gate opens, everything starts simultaneously from their initial positions.
This prevents the jarring "catch-up" where all particles teleport to catch up with missed time.

### Diagnostic Improvements

Extend the existing `debugLoadingProfiler` (dlp) with shader compilation metrics:

```javascript
dlp.begin('gpu.shaderCompile', 'gpu');
// After warmupAsync():
dlp.event(`gpu.shaderCompile: ${totalPrograms} programs compiled in ${ms}ms`);
dlp.event(`gpu.shaderCompile: KHR_parallel_shader_compile = ${hasExtension}`);
dlp.end('gpu.shaderCompile');
```

Also: `renderer.info.programs` contains name/type info for each compiled program. The debug
loading profiler could dump these as a table, showing which shaders are the heaviest.

### Suggested `getCompileTargets()` Implementation Standard

Effects should implement this interface:

```javascript
/**
 * Return scenes + cameras to compile during warmupAsync().
 * Must return scenes regardless of this.enabled state.
 * @returns {Array<{scene: THREE.Scene, camera: THREE.Camera, label: string}>}
 */
getCompileTargets() {
  const targets = [];
  if (this._composeScene) {
    targets.push({ scene: this._composeScene, camera: this._composeCamera, label: this.constructor.name });
  }
  return targets;
}
```

The fallback sniff-list in `warmupAsync()` already handles effects without `getCompileTargets()`,
but explicit implementation is more reliable and gives better progress labels.

---

## Implementation Phases

### Phase 1 — Restore `warmupAsync()` call (High Priority)
- **Location:** `canvas-replacement.js` at the current "skip warmup" block (~line 3893)
- **Change:** Replace skip comment with `await fc.warmupAsync(8000, progressCallback)`
- **New loading stage:** Add `shaders.compile` to `configureStages()`
- **Expected result:** Loading screen stays up until shaders are ready; first render is clean
- **Risk:** Potential stall on GPUs without `KHR_parallel_shader_compile`. Mitigated by 8s timeout.

### Phase 2 — Time freeze gate (Medium Priority)
- **Location:** `FloorCompositor.js` — add `_shaderWarmupGateOpen` + `openShaderGate()`
- **Change:** Pass `deltaTime: 0` to all effect `update()` calls until gate opens
- **Expected result:** No particle catch-up, no wind jump on first frame
- **Risk:** Low. Frozen deltaTime is safe — effects already handle zero-delta gracefully.

### Phase 3 — Per-effect progress labels (Low Priority)
- **Location:** `warmupAsync()` in `FloorCompositor.js`
- **Change:** Per-target `.then()` callbacks report to `onProgress` with label
- **Expected result:** Loading bar message cycles through effect names during compilation
- **Risk:** None — purely cosmetic

### Phase 4 — Shader variant pre-baking (Low Priority / Future)
- **Location:** Per-effect `getCompileTargets()` methods
- **Change:** Effects with heavy define-based variants pre-set their maximum-feature defines
  during warmup and restore afterward
- **Expected result:** No stutter when features are enabled mid-session for the first time
- **Risk:** Medium — requires per-effect knowledge of which defines matter

### Phase 5 — `getCompileTargets()` adoption (Low Priority / Future)
- Target the 5-6 heaviest effects: `WaterEffectV2`, `LightingEffectV2`, `CloudEffectV2`,
  `BuildingShadowsEffectV2`, `OverheadShadowsEffectV2`, `BloomEffectV2`
- Implement explicit `getCompileTargets()` on each so `warmupAsync()` gets accurate labels
- The fallback sniff-list already covers these but with less precise labels

---

## Progress Bar Segment Breakdown (Updated)

| Stage | Weight | What happens |
|---|---|---|
| `assets.discover` | 5 | File existence probes for mask textures |
| `assets.load` | 25 | THREE.TextureLoader for albedo + mask images |
| `effects.core` | 10 | FloorCompositor.initialize() — 39 effect inits |
| `effects.deps` | 5 | (Currently skipped in V2) |
| `effects.wire` | 5 | (Currently skipped in V2) |
| `scene.managers` | 10 | Token/wall/light managers, floor assignment |
| `scene.sync` | 10 | Token positions, Foundry state sync |
| `shaders.compile` | **20** | **warmupAsync() — GPU shader compilation** |
| `final` | 10 | Floor preloads, scene fade-in |

The 20% weight for `shaders.compile` reflects that this is where the majority of real-time loading
happens on a typical scene. The progress within this stage is driven by the program readiness poll.

---

## Open Questions

1. **Should the time gate be per-effect or global?** Global (all effects freeze) is simpler and more
   correct for a synchronized "curtain up" moment. Per-effect would require individual state but
   isn't needed here.

2. **What is the right `warmupAsync()` timeout?** Currently 5000ms; probably should be 8-10s for
   complex scenes on slow hardware. Should this be a user-facing graphics setting?

3. **Should disabled effects be warmed up?** Compiling shaders for effects the user has off wastes
   loading time. But it prevents mid-session stutter. Proposed default: yes (they're cheap relative
   to the cost of a mid-session stall). Could be a setting: "pre-compile all effect shaders".

4. **Re-use `progressiveWarmup()` or go direct to `warmupAsync()`?** Current plan: call
   `progressiveWarmup()` first to submit programs, then `warmupAsync()` to wait for them. This
   matches the existing architecture.

5. **Can we give a "this scene has N shaders, expect ~Xs" estimate?** With KHR extension, yes —
   count unique materials/programs submitted per scene, multiply by a per-GPU calibration constant.
   Without extension, no. Nice-to-have, not required for Phase 1.
