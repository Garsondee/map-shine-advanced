# Plan: Rain-Driven Water Surface Distortion (WaterEffectV2)

## Goal
When precipitation increases, water should become progressively more distorted:

- 0% to 50% precipitation: subtle-to-moderate **raindrop ripple** distortion.
- 50% to 100% precipitation: transitions into a harsh, chaotic **storm-noise** distortion ("noisy distorted mess").

This is intended to read as *rain impacting the water surface* rather than regular wind/wave motion.

## Context (Current Architecture)
- `WaterEffectV2` is a screen-space post-process pass that:
  - Masks to water areas.
  - Computes water refraction via a UV offset (`offsetUv`) derived from wave normals (`waveGrad`) and flow (`tWaterData`).
  - Expresses distortion strength in **pixels** (`uDistortionStrengthPx`) and converts to UV via `texel = 1.0 / uResolution`.
- `WaterEffectV2.update()` currently couples to `WeatherController` for:
  - `windDirection` and `windSpeed`.
  - It does **not** currently read `precipitation`.

## Design Overview
Add a new “Rain Hit” distortion contribution inside `WaterEffectV2` with **two internal layers**:

1. **Raindrop Ripples Layer** (0–50% precipitation)
   - Sparse/medium-frequency circular ripple disturbances.
   - Reads as droplets striking the surface.

2. **Storm Noise Layer** (50–100% precipitation)
   - High-frequency, turbulent, noisy distortion.
   - Meant to overwhelm the normal wave refraction during heavy rain.

Both layers are driven from weather precipitation but can be tuned/disabled from controls.

## Precipitation Mapping
Let `p = clamp(weather.precipitation, 0..1)`.

Compute two weights with a smooth crossfade around 0.5:

- **Ripple weight** (`wRipple`): ramps up from 0 to 1 as `p` goes 0→0.5, then fades out as storm begins.
- **Storm weight** (`wStorm`): 0 below ~0.45, ramps to 1 by ~0.6, stays 1 through 1.0.

Suggested curve (smooth, stable):
- `wStorm = smoothstep(0.50 - blend, 0.50 + blend, p)` where `blend` default ~0.08.
- `wRipple = (1.0 - wStorm) * smoothstep(0.0, 0.5, p)`

This ensures:
- No ripple at p=0.
- Ripples present and strongest near p≈0.4–0.5.
- Ripples naturally give way to storm noise beyond ~0.5.

## Shader Approach (GLSL)
### A) Raindrop Ripples (Vector Distortion Field)
Generate a pseudo-random grid of ripple centers:

- Grid space: `cell = floor(sceneUv * rippleScale)`
- Random seed per-cell: `rnd = hash12(cell)` (already available in WaterEffectV2)
- Time phase: `t = fract(uTime * rippleSpeed + rnd)`
- Radial ripple: based on distance from cell center `r = length(fract(sceneUv * rippleScale) - 0.5)`
- Use a damped sinusoid ring profile (fast falloff so it doesn’t look like a global wave system).

Output a **2D offset direction** roughly aligned with the radial direction:
- `dir = normalize(gv)` (gv is the local cell vector)
- `rippleVec = dir * amplitude`

Key properties:
- Sparse by thresholding `rnd` (so only some cells spawn ripples).
- Scale should be in water-space UVs (sceneRect UV, not screen UV).

### B) Storm Noise (Turbulent / Harsh)
Use an aggressively high-frequency vector field:
- Base: `curlNoise2D(sceneUv * stormScale + uTime * stormSpeed)` (curlNoise2D already exists in WaterEffectV2)
- Optionally layer in additional fbm/value noise to break up coherence.

Output a **unit-ish** vector field (`stormVec`) then scale by a pixel-strength.

### C) Composition into Existing Water Refraction
Today the refraction direction is derived from:
- `waveGrad * uWaveStrength`
- `flowN * 0.35`

Add rain contributions:
- `combinedVec += rippleVec * (wRipple * uRainRippleStrength)`
- `combinedVec += stormVec * (wStorm * uRainStormStrength)`

Then keep the existing normalization/amp logic and continue converting to pixels using `uDistortionStrengthPx`-style pixel -> UV conversion.

Important invariants:
- Distortion magnitudes should remain *resolution independent* by using px→UV via `uResolution`.
- Respect existing water masking (`inside`, `shore`) so rain distortion is only applied on water.

## New Controls (WaterEffectV2)
Add a new control group, e.g. **"Rain Distortion"**.

### Enable / precipitation source
- `rainDistortionEnabled` (bool, default: true)
- `rainDistortionUseWeather` (bool, default: true)
- `rainDistortionPrecipitationOverride` (0..1, default: 0) (only used when `rainDistortionUseWeather=false`)

### Crossfade shaping
- `rainDistortionSplit` (0..1, default: 0.5) (threshold between ripple vs storm)
- `rainDistortionBlend` (0.0..0.25, default: 0.08) (crossfade width)

### Ripple layer
- `rainRippleStrengthPx` (0..64, default: ~3.0)
- `rainRippleScale` (e.g. 1..2000, default: ~220.0)
- `rainRippleSpeed` (0..5, default: ~1.2)
- `rainRippleDensity` (0..1, default: ~0.35) (fraction of grid cells active)
- `rainRippleSharpness` (0..5, default: ~1.5) (controls ring thickness/falloff)

### Storm layer
- `rainStormStrengthPx` (0..64, default: ~14.0)
- `rainStormScale` (e.g. 1..2000, default: ~900.0)
- `rainStormSpeed` (0..5, default: ~1.8)
- `rainStormCurl` (0..2, default: ~1.0) (multiplier on curl/noise vector amplitude before px scaling)

### Optional safety / stability
- `rainMaxCombinedStrengthPx` (0..64, default: 24) (hard clamp so storm never tears the image excessively)

## JS Integration Points
### 1) `WaterEffectV2.params`
Add the parameters above with defaults.

### 2) `WaterEffectV2.getControlSchema()`
Add the controls to the schema under `water` (or a new group nested under water).

### 3) `WaterEffectV2` material uniforms
Add uniforms (names tentative):
- `uRainEnabled`
- `uRainPrecipitation`
- `uRainSplit`
- `uRainBlend`
- Ripple: `uRainRippleStrengthPx`, `uRainRippleScale`, `uRainRippleSpeed`, `uRainRippleDensity`, `uRainRippleSharpness`
- Storm: `uRainStormStrengthPx`, `uRainStormScale`, `uRainStormSpeed`, `uRainStormCurl`
- `uRainMaxCombinedStrengthPx`

### 4) `WaterEffectV2.update(timeInfo)`
Retrieve precipitation similarly to wind retrieval:
- `const wc = window.MapShine?.weatherController ?? window.canvas?.mapShine?.weatherController;`
- `const ws = wc.getCurrentState?.() ?? wc.currentState;`
- `precip = clamp(ws?.precipitation ?? 0)`

Respect the override controls when `rainDistortionUseWeather === false`.

### 5) Shader modifications
- Implement ripple + storm vector fields.
- Blend based on the computed `wRipple`/`wStorm`.
- Convert to UV offset using pixel strengths and `uResolution`.

## Visual/Behavioral Acceptance Criteria
- **Dry (p=0)**: no added rain distortion.
- **Light rain (p≈0.2)**: small ripples; does not overpower wind waves.
- **Moderate rain (p≈0.5)**: ripple energy strong but still readable.
- **Heavy rain (p≈0.8–1.0)**: water becomes turbulent/noisy, with minimal coherent wave structure.

## Performance Notes
- Avoid texture lookups; stay procedural like existing `valueNoise`/`fbmNoise`.
- Keep ripple evaluation to a small neighborhood (e.g., current cell and a few neighbors) if needed; start with a single-cell version and only expand if the pattern is too grid-like.
- No per-frame allocations in `update()`.

## Implementation Milestones
1. **Plumbing**: Add params + UI schema + uniforms + precipitation sampling.
2. **Ripple layer**: Implement ripple distortion and validate at 0–50%.
3. **Storm layer**: Implement harsh noise distortion and validate at 50–100%.
4. **Tuning pass**: Defaults that look good across zoom levels and scene resolutions.

## Open Questions
- Should storm noise also modulate foam intensity/appearance, or remain purely refractive distortion?
- Should rain distortion be dampened indoors (e.g., via `_Outdoors`), or is it assumed water implies outdoors?
