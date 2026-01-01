# Water Wind-Driven Foam v2 (Design + Implementation Checklist)

## Summary
Upgrade the current `WaterEffect` / `DistortionManager` “wind foam” from a scrolling ridge-noise overlay into a gust-reactive, spatially varied, crest-driven whitecap system.

Primary goals:
- Gusts should have strong, *localized* impact (fronts moving across the map).
- Foam should appear mainly on wave crests (whitecaps) and optionally as secondary wind-streak foam.
- Water should not look uniform across large surfaces.
- Maintain MapShine architecture (THREE.js, screen-space post in `DistortionManager`, time via `TimeManager`).

---

## Current Implementation (Baseline)

- **Control/Wiring**: `scripts/effects/WaterEffect.js`
  - Uses `weatherController.targetState.windDirection` for direction.
  - Uses `weatherController.currentState.windSpeed` for speed (gusts included).
  - Integrates `this._windFoamPhase += foamVelocity * dt` to avoid gust “ping-pong”.

- **Shader**: `scripts/effects/DistortionManager.js` apply fragment
  - Wind foam is currently “foam-from-noise”: directional ridge noise, thresholded to white.
  - Global wind scalar scales intensity everywhere at once.

---

## v2 Architecture Overview

We split the effect into three conceptual layers:

1. **Wind Field Layer (macro modulation)**
   - `windLocal01(sceneUv,t)` = base wind + gust fronts + patchiness.

2. **Wave Field Layer (height + slope proxies)**
   - Procedural height `H(sceneUvIso)` with multi-scale components.
   - Crestness `C` derived from slope (finite differences).

3. **Foam Layer (whitecaps + streaks + lifecycle)**
   - Whitecaps primarily from crestness and windLocal.
   - Optional secondary streak foam (Langmuir-ish lines).
   - Optional persistence via low-res accumulation RT (v2.1).

---

# Stage 0: Prep / Safety

- [x] Ensure the new water foam path does not break the post chain (DistortionManager must always draw).
- [x] Add a shader `debug` mode for visualizing:
  - [x] `windLocal01`
  - [x] crestness
  - [x] final foam mask
- [x] Confirm coordinate conventions:
  - [x] `sceneUv` is derived from `foundryToSceneUv(screenUvToFoundry(vUv))`.
  - [x] `_Water` mask sampling uses `waterY = (uWaterMaskFlipY > 0.5) ? 1.0 - sceneUv.y : sceneUv.y`.
  - [x] Wind direction already converted in `WaterEffect` to match water UV convention.

---

# Stage 1 (v2.0): Shader-Only Upgrade (No New Render Targets)

## 1. Add New Parameters (CPU-side)

- [x] Add `WaterEffect.params` entries for v2 controls (defaulted conservatively):
  - [x] **Gust Structure**
    - [x] `gustFieldEnabled`
    - [x] `gustFrontScale`
    - [x] `gustFrontSpeed`
    - [x] `gustFrontSharpness`
    - [x] `gustPatchScale`
    - [x] `gustPatchContrast`
    - [x] `gustLocalBoost`
  - [x] **Whitecaps**
    - [x] `windWhitecapsEnabled`
    - [x] `whitecapIntensity`
    - [x] `whitecapCrestLo`
    - [x] `whitecapCrestHi`
    - [x] `whitecapBreakupScale`
    - [x] `whitecapBreakupStrength`
    - [x] `whitecapColor`
    - [x] `whitecapColorMix`
    - [x] `whitecapAdditive`
  - [x] **Chop / Detail**
    - [x] `chopEnabled`
    - [x] `chopScaleBase`
    - [x] `chopSpeedBase`
    - [x] `gustChopBoost`
  - [x] **Compatibility**
    - [x] keep existing `windFoamEnabled` path as legacy toggle or map it to the new system.

- [x] Update `WaterEffect.getControlSchema()` UI grouping:
  - [x] Add “Gust Structure” folder
  - [x] Add “Wind Whitecaps” folder
  - [x] Add “Chop + Detail” folder
  - [x] Decide whether to keep “Wind Driven Foam” legacy group visible.

## 2. Wire Uniforms into DistortionManager

- [x] Add new uniforms to `DistortionManager` apply material (water section):
  - [x] gust uniforms (scale/speed/sharpness/patch/boost)
  - [x] whitecap uniforms
  - [x] chop uniforms

- [x] Extend DistortionManager’s “waterSource params → uniforms” copy section:
  - [x] Read new `waterSource.params.*` values
  - [x] Clamp/sanitize values consistently

## 3. Implement Spatial Gust Field (shader)

- [x] Implement `windLocal01` inside water block:
  - [x] `base = clamp(uWaterWindSpeed, 0..1)`
  - [x] `frontCoord = dot(sceneUvIso * gustFrontScale, windDir) - uTime * gustFrontSpeed`
  - [x] `frontWave = 0.5 + 0.5*sin(frontCoord*TAU + phaseJitter)`
  - [x] `front = smoothstep(...)` shaped by `gustFrontSharpness`
  - [x] `patch = fbm(sceneUvIso*gustPatchScale + windDir*uWaterFoamPhase*patchDrift, ...)`
  - [x] Contrast patch via `pow` using `gustPatchContrast`
  - [x] `gustMask = front * patch`
  - [x] `windLocal01 = clamp(base + gustMask * gustLocalBoost, 0..1)`

- [x] Ensure gust changes do NOT cause backtracking artifacts:
  - [x] Use `uWaterFoamPhase` for advection-like components (already monotonic).
  - [x] Use `uTime` only for “evolution” terms (appearance), not position integration.

## 4. Build Wave Height Field + Crestness

- [x] Implement a cheap multi-scale height function `H(p)`:
  - [x] 2–3 wind-aligned sin components (wave trains)
  - [x] 1 cross-wave component for break-up
  - [x] micro-chop via low-octave fbm
  - [x] Scale frequency/speed with `windLocal01` (gust increases chop frequency and motion)

- [x] Compute crestness from slope:
  - [x] Use forward differences (2 extra samples) for cost control
  - [x] Step size derived from `uWaterMaskTexelSize` (or a constant min)
  - [x] `slope = length(vec2(dHx, dHy))`
  - [x] `crest = smoothstep(whitecapCrestLo, whitecapCrestHi, slope)`

## 5. Generate Whitecaps (Foam-on-Crests)

- [x] Compute foam mask:
  - [x] `foam = crest * windLocal01`
  - [x] Multiply by depth factor (`smoothstep(depthLo, depthHi, depth)`) to suppress very shallow edges if desired
  - [x] Multiply by outdoors strength and water visibility gates (existing `outdoorStrength`, `waterVisible`)

- [x] Break up foam so it’s not continuous:
  - [x] `breakup = fbm(p*whitecapBreakupScale + advect, ...)`
  - [x] `foam *= mix(1.0, breakupMask, whitecapBreakupStrength)`

- [x] Composite appearance:
  - [x] Prefer a “tint mix + mild additive” instead of hard replacement
  - [x] Expose `whitecapColorMix` and `whitecapAdditive`

## 6. (Optional) Secondary Wind-Streak Foam

- [x] Keep streak foam as a secondary layer:
  - [x] Only when `windLocal01` is above a threshold
  - [x] Lower opacity than whitecaps
  - [x] Patch-modulated so it’s not uniform

- [x] If keeping the legacy ridge-noise foam:
  - [x] Retune it to read as “streak residue”, not primary foam
  - [x] Multiply by `(1 - crest)` so it doesn’t compete with whitecaps

## 7. Debug & Tuning

- [x] Add debug visualization switch(es):
  - [x] show `windLocal01`
  - [x] show `crest` / slope
  - [x] show final foam alpha

- [x] Tune defaults for:
  - [x] low wind: minimal foam
  - [x] medium wind: occasional whitecaps
  - [x] gust peaks: strong localized whitecaps + tighter/faster chop

---

## What's Left

- **Sanity pass**: Verify no black-screen, toggles work, and debugMask still functions.
- **Optional**: Minor tuning of domain warp strengths if testing shows artifacts.
- **Deferred**: Stage 2 (foam persistence) is postponed pending review of Stage 1.

---

# Stage 2 (v2.1): Foam Persistence via Low-Res Accumulation (Deferred)

This stage is currently deferred, pending review and refinement of the Stage 1 implementation.

## 1. Add Foam Accumulation Render Target

- [ ] Add `waterFoamAccumTarget` (e.g. 512–1024, sceneRect aspect aware).
- [ ] Add `foamAccumMaterial` (full-screen quad) that:
  - [ ] samples previous accumulation
  - [ ] advects it along wind direction
  - [ ] injects new foam from current crestness field
  - [ ] applies decay

## 2. Accum Update Pass

- [ ] Run accumulation update only when:
  - [ ] WaterEffect enabled AND `_Water` mask present
  - [ ] Persistence enabled

- [ ] Advect using backtrace:
  - [ ] `uvPrev = uv - windDir * (windLocal01 * advectSpeed) * dt`
  - [ ] Use stable dt via `TimeManager` (already passed into effects)

- [ ] Decay:
  - [ ] `foam *= exp(-decayRate * dt)` or `foam = max(0, foam - decay*dt)`

- [ ] Inject:
  - [ ] `foam = max(foam, crestFoam * injectGain)` or additive with clamp

## 3. Sample Accumulation in Main Apply Shader

- [ ] Add `tWaterFoamAccum` uniform.
- [ ] Replace (or modulate) instantaneous foam with accumulated foam.

## 4. Controls

- [ ] Add persistence controls:
  - [ ] `foamPersistenceEnabled`
  - [ ] `foamDecay`
  - [ ] `foamAdvection`
  - [ ] `foamInjectGain`

---

# Acceptance Criteria

- [x] **Low wind**: subtle chop, no big foam sheets.
- [x] **Medium wind**: intermittent whitecaps on crests; mild streak hints.
- [x] **Gust onset**: a coherent gust region/front sweeps across the water; chop frequency increases locally.
- [x] **Gust decay**:
  - [x] v2.0: foam reduces smoothly without global popping.
  - [ ] v2.1: foam lingers and drifts, then decays.
- [x] **Large lake**: spatial variation is obvious (patchy regions), not uniform tiling.

---

# Notes / Constraints

- Do not use PIXI for visuals.
- Use TimeManager-provided time (`timeInfo.elapsed`, `timeInfo.delta`) only.
- Keep offsets stable and resolution independent when operating in screen space.
- Preserve existing masking rules (`_Water` mask mapping, outdoors gating, roof occlusion where relevant).
