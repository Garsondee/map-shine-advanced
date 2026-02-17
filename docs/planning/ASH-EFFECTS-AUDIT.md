# Ash Effects Audit — Why Both Effects Are Broken

**Date**: 2025-02-16  
**Status**: Initial Audit  
**Scope**: `AshDisturbanceEffect` (token movement bursts) AND ash weather precipitation (WeatherParticles ashSystem/ashEmberSystem)

---

## 1. Ash Weather Precipitation (WeatherParticles)

### 1.1 ROOT CAUSE — `ashIntensity` Is Never Non-Zero By Default

**Severity: CRITICAL — This alone prevents all ash weather particles from ever appearing.**

- `WeatherController.currentState.ashIntensity` starts at `0.0` (WeatherController.js:54).
- `WeatherController.targetState.ashIntensity` starts at `0.0` (WeatherController.js:85).
- **No weather preset sets `ashIntensity`** — all 15 presets in `getControlSchema().presets` (WeatherController.js:2905-2920) only set `precipitation`, `cloudCover`, `windSpeed`, `fogDensity`, and `freezeLevel`. None include `ashIntensity`.
- The `_applyVariability()` wanderer loop (WeatherController.js:2015-2092) **does NOT touch `ashIntensity`** — it only modulates `windSpeed` and `windDirection`. So even with high variability, ashIntensity stays at exactly 0.0.
- The only way to get ash is to **manually** drag the "Ash Intensity" slider in the Weather UI or set `weatherController.targetState.ashIntensity` via console/API. There is no preset or automated path.

**Result**: `ashEmission.value = rate * tunedIntensity * clusterBoost` where `tunedIntensity = 0 * 1.0 = 0`. Emission is permanently zero.

### 1.2 No Ash-Specific Weather Presets

The preset system has rain, snow, and blizzard presets but no "Ash Fall", "Volcanic", or similar preset that would set `ashIntensity > 0`. Users have no discoverable way to activate ash weather without finding the manual slider buried in the Weather UI or the separate "Ash (Weather)" Tweakpane panel.

### 1.3 Ash System Init Looks Structurally Sound

The ash particle system creation in `_initSystems()` (WeatherParticles.js:3204-3239) appears correct:
- Creates `ParticleSystem` with `RandomRectangleEmitter`, proper material, forces, behaviors
- Emitter positioned at `(centerX, centerY, safeEmitterZ)` with `rotation.set(Math.PI, 0, 0)` (shoot downward)
- Added to scene and batchRenderer
- Ash ember system also created (lines 3274-3308)
- Batch materials patched for roof masking (lines 3324-3337)
- Force references cached for per-frame coupling (lines 3339-3349)

### 1.4 Ash Update Path Looks Structurally Sound (IF ashIntensity > 0)

The `update()` method (WeatherParticles.js:5292-5503) handles:
- Batch material patching via `_ensureBatchMaterialPatched`
- Emission rate driven by `ashIntensity * intensityScale * clusterBoost`
- Particle size, lifetime, speed, color, opacity all driven by `ashTuning`
- Curl noise and roof mask uniforms propagated
- Ash ember system similarly updated (lines 5420-5503)
- Wind/gravity coupling (lines 5568-5598)

### 1.5 Potential Issue — Emitter Shape Clustering May Zero-Out Visibility

Even if `ashIntensity > 0`, the clustering logic (WeatherParticles.js:4033-4041) accesses `this.ashSystem.emitterShape` and constrains the emitter rectangle to `clusterRadius * 2` around `_ashClusterCenter`. If `_ashClusterRadius` is very small or `_ashClusterCenter` is off-screen, particles may spawn outside the camera frustum. This is not necessarily broken but could produce "invisible" ash if the cluster drifts to an edge.

### 1.6 Potential Issue — `ashSystem.emitterShape` vs `shape` Property Name

The code accesses `this.ashSystem.emitterShape` (WeatherParticles.js:4033) to resize the emitter rectangle at runtime. In three.quarks, the property is indeed `emitterShape` (confirmed in three.quarks.module.js:915), so this access is valid. However, the `RandomRectangleEmitter` shape must expose `.width` and `.height` as mutable properties for the resize to work. If `RandomRectangleEmitter` doesn't have those properties, the clustering resize silently fails and the emitter stays at the full scene size.

### 1.7 Potential Issue — Ash Texture Atlas Tile Index Range

The ash system uses `startTileIndex: new IntervalValue(0, 4)` for a 2×2 atlas (`uTileCount: 2, vTileCount: 2`). Valid tile indices for a 2×2 atlas are 0, 1, 2, 3. `IntervalValue(0, 4)` generates values in `[0, 4)` which could produce index 3.999... — this *should* be fine since three.quarks floors the tile index, but it's worth verifying that index 4 isn't produced (which would be out-of-bounds).

---

## 2. Ash Disturbance Effect (AshDisturbanceEffect.js)

### 2.1 ROOT CAUSE — `_Ash` Mask Is Almost Certainly Missing

**Severity: CRITICAL — Without the `_Ash` mask, the effect falls back to random full-scene points, but even then token movement handling may silently fail.**

- `setAssetBundle()` (line 196-224) looks for a mask with `id === 'ash'` or `type === 'ash'` in `bundle.masks`.
- The `_Ash` suffix is registered in `loader.js:47` (`ash: { suffix: '_Ash', required: false }`).
- **If the map's background image is `MyMap.webp`, the user must also provide `MyMap_Ash.webp`** for the mask to exist. Most maps won't have this.
- When the mask is missing, the code falls back to `_generateFallbackPoints()` which creates 12,000 random UV points across the scene. This fallback path IS reached, so the effect should at least have spawn data.

### 2.2 ROOT CAUSE — `handleTokenMovement` Is Never Called If `_spawnPoints` Has No Length

The guard at line 240: `if (!this.enabled || !this._spawnPoints || !this._spawnPoints.length) return;`

If `_spawnPoints` is null (both `_generatePoints` and `_generateFallbackPoints` failed), nothing happens. `_generateFallbackPoints` can return null if `canvas?.dimensions` is undefined at the time `setAssetBundle` is called.

### 2.3 LIKELY ROOT CAUSE — Timing: `setAssetBundle` Called Before `canvas.dimensions` Is Available

In `canvas-replacement.js:1741-1743`:
```js
ashDisturbanceEffect = new AshDisturbanceEffect();
await effectComposer.registerEffect(ashDisturbanceEffect);
if (bundle) {
  ashDisturbanceEffect.setAssetBundle(bundle);
}
```

`registerEffect` calls `initialize(renderer, scene, camera)` which checks for `window.MapShineParticles`. This is set in `ParticleSystem.initialize()` (registered at Step 3.8, before Step 3.11). So the batchRenderer should be available.

However, `_generateFallbackPoints()` uses `canvas?.dimensions` which must exist at this point. If the Foundry canvas is still initializing, this could return null, leaving `_spawnPoints = null` and the effect permanently dead.

### 2.4 LIKELY ROOT CAUSE — `_rebuildSystems()` Guard Prevents System Creation

`_rebuildSystems()` (line 468) has the guard:
```js
if (!this.batchRenderer || !this.scene || !this._spawnPoints) return;
```

If ANY of these are null/falsy, zero burst systems are created and `_burstSystems` stays empty. Then `handleTokenMovement` (line 262) tries:
```js
const system = this._burstSystems[this._burstIndex++ % this._burstSystems.length];
```
With an empty array, `this._burstSystems.length === 0`, so `0 % 0 = NaN`, and `this._burstSystems[NaN]` is `undefined`. The guard on line 263 catches this: `if (!system || !system.userData || !system.userData.burstShape) return;` — silently bailing out.

**Probable chain**: `_spawnPoints` is null → `_rebuildSystems` skips → no burst systems → `handleTokenMovement` always returns early.

### 2.5 ISSUE — `initialize()` Called Before `setAssetBundle()`

The `initialize()` method only sets up `batchRenderer` and loads the particle texture. It does NOT call `_rebuildSystems()`. Systems are only built inside `setAssetBundle()` → `_rebuildSystems()`. So the timing dependency is:
1. `registerEffect` → `initialize()` → batchRenderer acquired ✓
2. `setAssetBundle(bundle)` → `_generatePoints(null)` returns null (no _Ash mask) → `_generateFallbackPoints()` → depends on `canvas.dimensions` → `_rebuildSystems()`

If `canvas.dimensions` is not yet populated, step 2 produces null spawn points and the effect is permanently broken.

### 2.6 ISSUE — `_isAshAtWorld()` Returns `true` When No Mask Data Exists

Line 437: `if (!this._ashMaskData || !this._ashMaskSize.width) return true;`

This means when there's no mask, EVERY position passes the "is there ash here?" check. This is intentional (full-scene fallback), but combined with the empty `_burstSystems` issue above, it never matters.

### 2.7 ISSUE — Particle Texture May Not Load

`_ensureParticleTexture()` (line 335-353) loads `modules/map-shine-advanced/assets/particle.webp` via `THREE.TextureLoader`. This is an async load with no callback or error handling. If the file hasn't loaded by the time `_rebuildSystems()` creates materials, the material's `map` will be a blank/placeholder texture. The file `particle.webp` does exist in the assets directory, but the texture may not be decoded by the time systems are built.

### 2.8 ISSUE — `update()` Called by EffectComposer But Does Nothing Without Active Bursts

The `update(timeInfo)` method (line 275) has the guard:
```js
if (!this.enabled || !this._burstSystems.length) return;
```

With zero systems, it always returns early. Even if `handleTokenMovement` somehow managed to trigger, the countdown timer logic in `update()` that turns off emission after `burstDuration` seconds would never run.

---

## 3. Shared / Cross-Cutting Issues

### 3.1 No User-Facing Documentation or Presets for Ash

Neither the ash weather nor the ash disturbance effect has an intuitive entry point:
- No weather preset activates ash
- The `_Ash` mask suffix is undocumented for map makers
- The "Ash Disturbance" and "Ash (Weather)" panels exist in Tweakpane but are likely collapsed and non-obvious

### 3.2 No Console Warnings When Effects Are Inert

Both effects silently return when conditions aren't met. Adding warning-level log messages when:
- `ashIntensity === 0` and ash systems exist (weather)
- `_spawnPoints` is null after `setAssetBundle` (disturbance)
- `_burstSystems.length === 0` after `_rebuildSystems` (disturbance)

...would make debugging much easier.

### 3.3 WeatherController `_applyVariability` Should Optionally Modulate `ashIntensity`

Just like `windSpeed` gets noise-modulated by the wanderer loop, `ashIntensity` could benefit from slight variation to simulate gusts of ash. Currently it's a flat value with zero variation.

---

## 4. Summary — Fix Priority

| # | Issue | Effect | Severity | Fix Complexity |
|---|-------|--------|----------|----------------|
| 1 | No presets set `ashIntensity > 0` | Weather | **CRITICAL** | Easy — add presets |
| 2 | `ashIntensity` default is 0, no automation | Weather | **CRITICAL** | Easy — add presets + wanderer |
| 3 | `_spawnPoints` null due to timing / no mask | Disturbance | **CRITICAL** | Medium — defer rebuild |
| 4 | `_rebuildSystems` guard blocks all systems | Disturbance | **CRITICAL** | Medium — add retry/lazy init |
| 5 | No `_Ash` mask on most maps | Disturbance | **HIGH** | Easy — fallback works IF timing fixed |
| 6 | No ash weather presets in UI | Both | **HIGH** | Easy — add to presets object |
| 7 | Silent failure with no logging | Both | **MEDIUM** | Easy — add warn logs |
| 8 | Async texture load race | Disturbance | **LOW** | Easy — await or use onLoad |
| 9 | Tile index range `[0, 4)` edge case | Weather | **LOW** | Trivial — use `IntervalValue(0, 3)` |
| 10 | Ash clustering may push emitter off-screen | Weather | **LOW** | Easy — clamp to viewport |

---

## 5. Recommended Fix Plan

### Phase 1: Make Ash Weather Actually Visible
1. Add ash weather presets to `WeatherController.getControlSchema().presets` (e.g., "Light Ash Fall", "Heavy Ash Fall", "Volcanic")
2. Consider adding `ashIntensity` to `_applyVariability()` so it gets slight noise modulation
3. Verify ash particles are visible at `ashIntensity = 0.5` with no other changes

### Phase 2: Fix Ash Disturbance Lifecycle
1. Add deferred/lazy `_rebuildSystems()` that retries on first `handleTokenMovement` if systems are empty
2. Ensure `_generateFallbackPoints()` handles missing `canvas.dimensions` gracefully (retry later)
3. Add warning logs when `_spawnPoints` is null after `setAssetBundle`
4. Add warning logs when `_burstSystems` is empty after `_rebuildSystems`

### Phase 3: Quality of Life
1. Add "Ash Fall" and "Volcanic Storm" presets to the Weather UI
2. Document `_Ash` mask suffix for map makers
3. Add diagnostic logging for both effects

---

## 6. Fixes Applied

All fixes below have been implemented and syntax-checked.

### 6.1 WeatherController (`scripts/core/WeatherController.js`)

- **Added 4 ash weather presets** to `getControlSchema().presets`:
  - "Light Ash Fall" (`ashIntensity: 0.3`)
  - "Ash Fall" (`ashIntensity: 0.6`)
  - "Heavy Ash Fall" (`ashIntensity: 0.85`)
  - "Volcanic Storm" (`ashIntensity: 1.0`, with light precipitation + heavy fog)
- **Fixed `transitionToPreset()`** to include `ashIntensity` in the transition target state. Previously, preset `ashIntensity` was silently dropped and never propagated to the weather transition. Non-ash presets now explicitly set `ashIntensity: 0` to clear any active ash.
- **Added `ashIntensity` to `_applyVariability()` wanderer loop**: When `targetState.ashIntensity > 0`, a subtle pink-noise perturbation (±15% of variability) is applied each frame, giving ash a natural "breathing" feel. Idle scenes (ashIntensity=0) are unaffected.

### 6.2 AshDisturbanceEffect (`scripts/particles/AshDisturbanceEffect.js`)

- **Deferred rebuild system**: Added `_needsRebuild` flag, `_rebuildAttempts` counter (capped at 10), `_tryRebuildSystems()` and `_attemptDeferredRebuild()`. If `setAssetBundle()` runs before `canvas.dimensions` is available, systems are built lazily on the first `handleTokenMovement()` or `update()` call.
- **Lazy BatchedRenderer acquisition**: `_ensureBatchRenderer()` retries acquiring the batch renderer from `window.MapShineParticles` if it wasn't available at `initialize()` time. The effect no longer permanently disables itself on init failure.
- **Safe modulo in `handleTokenMovement()`**: Guards against `0 % 0 = NaN` when `_burstSystems` is empty.
- **Texture load callbacks**: `_ensureParticleTexture()` now uses `onLoad`/`onError` callbacks. On load completion, if a deferred rebuild is pending, it retries immediately.
- **`_generateFallbackPoints()` guard**: Now checks `dims.sceneWidth` and `dims.sceneHeight` exist (not just `dims`), so it won't return garbage data from partially-initialized dimensions.
- **Comprehensive diagnostic logging** at all critical decision points: mask found/missing, fallback generation, deferred rebuild attempts/success/failure, texture load status, batch renderer acquisition.

### 6.3 WeatherParticles (`scripts/particles/WeatherParticles.js`)

- **Fixed tile index range**: Changed `startTileIndex: new IntervalValue(0, 4)` to `IntervalValue(0, 3)` for both `ashSystem` and `ashEmberSystem`. A 2×2 atlas has valid tile indices 0–3; index 4 was out-of-bounds.
- **Added one-time activation log**: When ash emission first goes non-zero, logs `Ash weather activated: ashIntensity=X, tunedIntensity=Y`. Resets when ash goes back to zero so the next activation is also logged.

---

## 7. Round 2 Fixes — Root Cause Analysis

After testing confirmed both effects were still non-functional, a deeper trace revealed two additional critical bugs:

### 7.1 Root Cause: Ash Weather Preset Buffer Missing `ashIntensity`

**File**: `scripts/foundry/canvas-replacement.js`, `onWeatherUpdate()` callback.

The weather preset flow works via a buffering mechanism:
1. TweakpaneManager sends `_preset_begin` → creates empty buffer
2. TweakpaneManager iterates preset properties, calling callback for each
3. TweakpaneManager sends `_preset_end` → passes buffer to `transitionToPreset()`

The buffer **allowlist** only included: `precipitation`, `cloudCover`, `windSpeed`, `windDirection`, `fogDensity`, `freezeLevel`. **`ashIntensity` was not in the list**, so it was silently dropped during step 2. `transitionToPreset()` never received it.

**Fix**: Added `paramId === 'ashIntensity'` to the buffer allowlist.

### 7.2 Root Cause: AshBurstShape Per-Particle Rejection Sampling Too Weak

**File**: `scripts/particles/AshDisturbanceEffect.js`, `AshBurstShape` class.

The original `initialize()` method randomly sampled 24 points from ALL spawn points (potentially 12K–260K across the full scene) and checked if each fell within the 180px burst radius. On a typical 4000×3000 scene:
- Burst circle area / scene area ≈ 0.85%
- Probability of finding a hit in 24 tries ≈ 18%

**~82% of bursts produced zero visible particles.**

**Fix**: Replaced per-particle rejection sampling with per-burst pre-filtering. `setCenter()` now scans all spawn points once (O(N), sub-millisecond) and collects indices within the radius into `_candidateIndices`. `initialize()` picks from this pre-filtered list with 100% hit rate.

### 7.3 Additional Diagnostic Logging

Added to `handleTokenMovement`:
- One-time warnings when spawn points or burst systems are missing
- Debug log when token isn't found or isn't on ash mask
- One-time confirmation log on first successful burst (center, candidate count, rate, duration, system count)

Added to `_rebuildSystems`:
- Completion log with spawn point count, scene dimensions, offset, groundZ, mask presence, texture readiness
