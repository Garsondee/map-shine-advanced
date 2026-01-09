# PLAN: Sky Color Automation (Time-of-Day + Weather)

## Goals
- Upgrade `SkyColorEffect` from a purely preset-based outdoor grade into an **intelligent, continuous, physically-inspired** sky grading system.
- Keep the feature as a **post-processing grade** (no skybox / skydome rendering).
- Add **richer controls** so users can tune “atmosphere” (haze, warmth, contrast rolloff) without needing to hand-tune four separate presets.
- Drive the look from:
  - `WeatherController.timeOfDay`
  - `WeatherController.getCurrentState()` (`cloudCover`, `precipitation`, etc.)
  - Foundry `canvas.environment.darknessLevel` (authoritative darkness)

## Non-Goals
- Rendering an actual sky dome/skybox.
- Full physical atmospheric scattering (Preetham/Hosek) rendering.
- Introducing PIXI dependencies (Map Shine rendering is Three-first).

## Current State (Baseline)
- `SkyColorEffect` is a post-process pass that:
  - masks grading to outdoors / roof alpha / rope mask
  - blends between 4 time-of-day “presets” using time-of-day peaks
  - applies exposure/white balance, contrast/brightness/saturation/vibrance, lift/gamma/gain, optional tone mapping, optional vignette/grain
- Automation currently means “automatic time-of-day blending” unless `debugOverride` is enabled.

## Proposed Upgrade: Two Automation Modes

### Mode A: Preset Blend (Existing)
- Keep current behavior as a compatibility path.

### Mode B: Analytic Automation (New default option)
A new automation path produces the effective grading values by evaluating smooth functions of:
- **Sun elevation** derived from `timeOfDay` (continuous, not 4-peak)
- **Weather haze** derived from cloud/precip
- **Scene darkness** from Foundry

This is inspired by the parameterization used in Three.js `Sky.js` / `SkyMesh.js` (Preetham-style controls) without rendering a sky.

## New Parameters (User-Facing)

### 1) Automation Selection
- `automationMode`:
  - `0 = Preset Blend (legacy)`
  - `1 = Analytic (sun + weather)`

### 2) Sun / Time Controls
- `sunriseHour` (default 6.0)
- `sunsetHour` (default 18.0)
- `goldenHourWidth` (hours; default 2.5)
- `nightFloor` (0..1; minimum day factor at night; default 0.0)

### 3) Atmosphere / Haze Controls (Preetham-inspired)
- `turbidity` (0..1; proxy for dust/haze/overcast)
- `rayleighStrength` (0..1; proxy for “blue scattering”)
- `mieStrength` (0..1; proxy for “gray haze / washout”)
- `forwardScatter` (0..1; proxy for “sun glow / highlight lift”)

### 4) Weather Coupling
- `weatherInfluence` (0..1)
- `cloudToTurbidity` (0..2)
- `precipToTurbidity` (0..2)
- `overcastDesaturate` (0..1)
- `overcastContrastReduce` (0..1)

### 5) Output Shaping (how analytic values map into grading)
- `tempWarmAtHorizon` (0..1)
- `tempCoolAtNoon` (-1..0)
- `nightCoolBoost` (-1..0)
- `goldenSaturationBoost` (0..1)
- `nightSaturationFloor` (0..1)
- `hazeLift` (0..0.5)

### 6) Manual Override (Existing)
- Keep `debugOverride` and manual exposure/saturation/contrast.

## Core Math / Model

### 1) Time-of-Day → Sun Factor
Compute a normalized sun elevation proxy using sunrise/sunset:
- Map `timeOfDay` into a [0..1] day-progress between sunrise and sunset.
- Use a smooth sine curve so noon peaks at 1.0:
  - `sunFactor = sin(pi * dayProgress)` clamped to [0..1]
- Derive:
  - `dayFactor = max(nightFloor, sunFactor)`
  - `horizonFactor = 1 - dayFactor` (strong near sunrise/sunset)

### 2) Golden Hour Band
- Use a bell/peak around sunrise and sunset within `goldenHourWidth`.
- Example: `gold = peak( sunriseHour, goldenHourWidth ) + peak( sunsetHour, goldenHourWidth )`, then clamp.

### 3) Weather → Haze/Turbidity
Use `state = weatherController.getCurrentState()`:
- `overcast = clamp( cloudCover*0.8 + precipitation*0.6 )`
- `storm = clamp( precipitation )`
- `turbidityEffective = turbidity + weatherInfluence * (cloudToTurbidity*cloudCover + precipToTurbidity*precipitation)`

### 4) Darkness
- `sceneDarkness = canvas.environment.darknessLevel`
- `effectiveDarkness = clamp(sceneDarkness + (1-dayFactor)*0.25 + overcast*0.15 + storm*0.10)`

### 5) Produce Grading Values
Analytic outputs drive existing shader uniforms:
- Temperature:
  - warm at horizon: `+tempWarmAtHorizon * gold`
  - cool at noon: `+tempCoolAtNoon * dayFactor`
  - cool at night: `+nightCoolBoost * effectiveDarkness`
- Saturation:
  - base `1.0`, boost at golden hour, reduce in overcast, clamp to floor at night
- Contrast:
  - reduce under haze, reduce under darkness
- Exposure:
  - linked to dayFactor (brighter at day) and reduced by effectiveDarkness
- Brightness / Lift:
  - haze increases lift slightly (washed look)
- Optional tone mapping:
  - keep user-selectable (don’t auto-switch unless requested later)

## Implementation Plan

### Milestone 1: Add Params + UI Schema
- Extend `SkyColorEffect.params` with the new parameters.
- Update `SkyColorEffect.getControlSchema()`:
  - Add an “Automation” folder with `automationMode`, sunrise/sunset, weather influence, atmosphere controls.
  - Keep the existing Dawn/Day/Dusk/Night folders for compatibility.

### Milestone 2: Implement Analytic Automation in `update()`
- Introduce a branch:
  - if `debugOverride` -> keep manual
  - else if `automationMode === 1` -> compute analytic values
  - else -> existing preset blending
- Ensure no per-frame object allocations in hot path.

### Milestone 3: Weather Coupling Correctness
- Use `weatherController.getCurrentState()` and `weatherController.timeOfDay`.
- Use Foundry darknessLevel as the authoritative darkness.
- Ensure grade is still masked by outdoors/roof/rope.

### Milestone 4: Validation / Testing
- Verify time-of-day changes from Control Panel call `StateApplier.applyTimeOfDay()` and update sky immediately.
- Verify weather changes (cloud cover, precipitation) change turbidity/haze response.
- Verify `enabled=false` and `intensity=0` still produce a correct passthrough frame (no black screen).

## Risks / Notes
- Avoid fighting `ColorCorrectionEffect`: defaults should keep SkyColor subtle unless the user increases intensity.
- Be careful not to introduce allocations each frame in `update()`.
- Keep backwards compatibility: existing scenes tuned via preset params should still render the same when `automationMode=0`.
