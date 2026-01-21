# Plan: Underwater Caustic Light Reflections (Water / Distortion Pipeline)

## Goal
Add a rich, controllable, **high-performance underwater caustics** effect that:

- Renders as moving light filaments/pools projected onto the scene *through water*.
- Is **pinned to world/scene UV** (no screen-space swimming when panning/zooming).
- Can be **masked to only appear in brighter parts of the scene** ("only where light is strong").
- Plays nicely with existing water features (tint, murk, sand, foam, refraction).

Also add a control to **reduce wave/refraction intensity when water is indoors/covered**, using the `_Outdoors` mask.

## Context (Current Architecture)
- `WaterEffectV2`:
  - Builds a water mask and a water SDF/flow field (`tWaterData`).
  - Generates water refraction distortion (screen-space UV offset) masked to water.
  - Already supports `_Outdoors`-driven *rain* damping (`rainIndoorDampingEnabled/Strength`).

- `DistortionManager` apply pass:
  - Has direct access to:
    - `tScene` (current scene color)
    - `tWaterMask` (actual water mask, not just composite alpha)
    - `tOutdoorsMask` (world/scene UV mask)
    - `tCloudShadow` and `tWindowLight` (optional light gating)
    - scene mapping uniforms (`uViewBounds`, `uSceneRect`, `uSceneDimensions`)
  - Already contains a caustics block (`uWaterCausticsEnabled` + `causticsPattern()`), but it is currently focused on shallow-water highlights rather than a full-feature underwater caustics system.

**Implementation placement recommendation**:
- Keep water refraction/waves in `WaterEffectV2`.
- Implement (or expand) underwater caustics in `DistortionManager` apply shader.
  - This keeps caustics in the same place as tint/murk/sand composition and allows direct access to `tScene` luminance for brightness masking.

## Proposed High-Performance Caustics Method
### Summary
Use a **procedural caustics field** built from:

- 2-3 layers of **tileable (torus) simplex noise** / FBM
- A **ridged transform** to turn blobs into filaments
- A light amount of **domain warping** to increase detail density
- Optional **multi-layer composition** (soft base + sharp detail) with independent speeds

This is all math-only (no additional textures required), so it is stable, cheap, and resolution independent.

### Why this method
- **Performance**: no extra render target, no large kernels, ~2 noise evaluations per layer.
- **Quality**: ridging + warp produces the "criss-cross caustic filaments" look.
- **Control**: easy to expose intensity/scale/speed/sharpness/detail weights.
- **Stability**: sample in scene/world UV, independent of camera.

### GLSL building blocks
1) **World-stable UV**
- Compute `sceneUv` via `screenUvToFoundry()` → `foundryToSceneUv()` (already present in apply shader).
- Use `sceneUvIso = aspectCorrectSceneUv(sceneUv)` to keep caustics isotropic.

2) **Tileable noise coordinates**
- Use the existing helper `torusNoiseCoords(sceneUvIso, period)` and `snoise(vec4)`.
  - This avoids visible seams while repeating.

3) **Filament shaping**
- Convert noise → [0..1], then ridge:
  - `ridge = 1.0 - abs(2.0 * n - 1.0);`
- Convert ridge to lines with a threshold/softness:
  - `lines = smoothstep(1.0 - width, 1.0, ridge);`

4) **Domain warp (small, cheap)**
- Warp UV by a low-frequency noise vector:
  - `warp = vec2(snoise(...), snoise(...)) * warpStrength;`
  - `p = p + warp;`

5) **Multi-layer caustics**
- `cSoft`: slower, larger scale, low sharpness
- `cSharp`: faster, smaller scale, high sharpness
- Mix: `c = clamp(softW*cSoft + sharpW*cSharp, 0..1)`

## Brightness Masking (Only in Brighter Scene Areas)
### Requirement
"Only appear in the brighter parts of the scene" should be interpreted as:

- If the underlying pixel is dark, caustics should fade out.
- If the underlying pixel is already bright (lit), caustics should be visible.

### Proposed approach (no extra buffers)
Compute a luminance gate from `tScene`:

- `lum = dot(sceneColor.rgb, vec3(0.299, 0.587, 0.114))`
- `gate = smoothstep(threshold, threshold + softness, lum)`
- Optional shaping:
  - `gate = pow(max(gate, 0.0), gamma)`
  - `gate *= intensity`

This is extremely cheap and robust, and it automatically respects lighting, shadows, fog-darkness, etc., because it is driven from the final scene color.

### Important detail
Use the *same* sample (or a dedicated pre-add sample) for luminance gating to avoid feedback artifacts:

- Prefer `baseColor = texture2D(tScene, distortedUv)` before adding caustics.
- Compute luminance from `baseColor`.

## Indoor vs Outdoor / Covered Light Gating
Keep the existing gating model and extend it:

- `_Outdoors` (`tOutdoorsMask`):
  - `outdoor = outdoorsMask`
  - `indoor = 1 - outdoor`
- Outdoors caustics suppression by cloud shadow:
  - `outdoorLight = cloudLit` (1 lit, 0 shadowed)
- Indoors caustics allowed only where window light is bright:
  - `indoorLight = windowLightAlpha`
- Combined light gate:
  - `lightGate = max(outdoor * outdoorLight, indoor * indoorLight)`

Then multiply caustics by the luminance-based brightness gate:

- `finalGate = lightGate * brightnessGate`

## Proposed Controls
### Group: Caustics (Underwater)
- `causticsEnabled` (bool)
- `causticsIntensity` (0..4)
- `causticsColor` (color)
- `causticsAdditiveStrength` (0..2)
- `causticsScreenBlend` (bool) (optional: switch blend model)

### Pattern / motion
- `causticsScale` (1..200)
- `causticsSpeed` (0..5)
- `causticsSharpness` (0.1..10)
- `causticsDetailWeight` (0..1) (sharp layer weight)
- `causticsBaseWeight` (0..1) (soft layer weight)
- `causticsWarpStrength` (0..1)
- `causticsWarpScale` (0.1..50)
- `causticsWarpSpeed` (0..5)

### Depth/shore masking
(Uses existing water mask as a pseudo-depth map.)
- `causticsDepthPower` (0.1..4) (how strongly caustics prefer shallow)
- `causticsDepthLo` / `causticsDepthHi` (0..1) (range where caustics exist)
- `causticsEdgeLo` / `causticsEdgeHi` (0..1) (edge fade)
- `causticsEdgeBlurTexels` (0..64) (edge softness)

### Brightness masking
- `causticsBrightnessMaskEnabled` (bool)
- `causticsBrightnessThreshold` (0..2) (note: HDR pipeline may exceed 1)
- `causticsBrightnessSoftness` (0..1)
- `causticsBrightnessGamma` (0.1..4)
- `causticsBrightnessMax` (0..1) (optional clamp so bright pixels don’t blow out)

### Environment gating
- `causticsRespectSceneDarkness` (bool)
- `causticsNightFadePower` (0.1..4)

### Debug
- `causticsDebugView` (enum: Off / Pattern / Gates / Luminance)

## Indoor / Covered Water Wave Damping
### Problem
Currently water waves/refraction are still active even when the water area is "indoors" per `_Outdoors` (covered/inside).

### Desired behavior
Introduce a control so wave motion/refraction calms down as `outdoorStrength` goes to 0.

### Proposed controls (WaterEffectV2)
- `waveIndoorDampingEnabled` (bool, default true)
- `waveIndoorDampingStrength` (0..1, default 1.0)
- `waveIndoorMinFactor` (0..1, default 0.15)

### Proposed shader logic
Sample outdoors strength in water world/scene UV (same mapping as rain damping):

- `outdoor = sampleOutdoors(sceneUv)` (1 outdoors, 0 indoors)
- `indoor = 1.0 - outdoor`
- `damp = mix(1.0, waveIndoorMinFactor, indoor * waveIndoorDampingStrength)`
- `effectiveWaveStrength = uWaveStrength * damp`
- (Optional) also damp `uDistortionStrengthPx` to reduce refraction amplitude.

This provides:
- Full waves outdoors.
- Calmer/near-static water indoors, controllable and not binary.

## Implementation Milestones
1. **Plumbing**:
   - Add caustics controls and uniforms (likely in `DistortionManager` params + apply shader uniforms).
   - Add wave indoor damping controls/uniforms in `WaterEffectV2`.
2. **Pattern upgrade**:
   - Replace/extend `causticsPattern()` with multi-layer + warp caustics.
3. **Brightness masking**:
   - Add luminance gate and controls; validate under different lighting conditions.
4. **Tuning + defaults**:
   - Ensure stable appearance across zoom levels and different scene aspect ratios.

## Acceptance Criteria
- Caustics are stable in world space and do not swim during camera pan/zoom.
- Caustics intensity increases only where the underlying scene is bright (based on luminance mask).
- Indoors water has noticeably reduced wave/refraction intensity when damping is enabled.
- Performance remains stable on "low" tier (no additional full-res render targets).

## Performance Notes
- Prefer 2 layers of caustics and a small warp; avoid large FBM octaves.
- Keep all lengths and offsets either:
  - in **scene UV**, or
  - in **pixels** converted via `uResolution` when needed.
- Avoid per-frame allocations in JS update loops.
