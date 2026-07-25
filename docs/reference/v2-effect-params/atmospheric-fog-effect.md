# Atmospheric Fog & Air

**V2 class:** `AtmosphericFogEffectV2` · **Source:** `legacy/compositor-v2/effects/AtmosphericFogEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Adds air depth, fog color, and weather-driven atmosphere on the merged linear HDR frame (before Camera Grade).

Composites using aerial perspective (scene transmittance + scattered air radiance), not by boosting local brightness.

Fog density follows weather presets and Dynamic Weather when enabled. Map Shine Control → Fog adds manual haze in Directed mode.

Macro shape creates large fog banks and clear gaps; swirls add fluid detail; rain breaks up fog during storms.

Use Camera Grade for exposure and tone mapping — not this pass.

## The knobs, in the author's words

- **Macro shape** — Large-scale fog banks and clear-air pockets that stop the fog looking like a flat overlay.
- **Swirl depth** — Iterated domain warping — deeper settings produce more fluid, twisting tendrils.
- **Building encroachment** — Thick fog banks push closer to walls; clear gaps pull fog away from buildings.
- **Rain responsiveness** — How aggressively precipitation churns and shears the fog during storms.
- **Sky tint** — How much the current sky/environment color tints fog.
- **Night color** — How strongly fog shifts toward the night fog color at high darkness.
- **HDR haze** — Luminance-matched lift on the linear composite — visible air without crushing bright pixels.
- **Light smothering** — How strongly fog occludes Foundry lights and emissive hotspots instead of amplifying them.

## Authored presets

`Clear Noon` · `Golden Hour` · `Overcast Day` · `Storm` · `Moonlit Night` · `Interior Night`

## Controls, grouped as the author grouped them

### Density & Falloff

| Control               | id                    | Type   | Range | Default | Notes                                                                 |
| --------------------- | --------------------- | ------ | ----- | ------- | --------------------------------------------------------------------- |
| Weather Fog Influence | `weatherFogInfluence` | slider | 0 … 1 | 1       |                                                                       |
|                       |                       |        |       |         | _How much the weather panel Fog slider and presets affect this pass._ |
| Max Opacity           | `maxOpacity`          | slider | 0 … 1 | 0.72    |                                                                       |
|                       |                       |        |       |         | _Ceiling on fog strength at full density._                            |
| Falloff Start         | `falloffStart`        | slider | 0 … 1 | 0.1     |                                                                       |
|                       |                       |        |       |         | _Normalized view distance where edge haze begins._                    |
| Falloff End           | `falloffEnd`          | slider | 0 … 1 | 0.9     |                                                                       |
|                       |                       |        |       |         | _Normalized view distance where edge haze reaches full strength._     |

### Color & Lighting

| Control              | id                   | Type   | Range | Default | Notes                                                   |
| -------------------- | -------------------- | ------ | ----- | ------- | ------------------------------------------------------- |
| Fog Color            | `fogColor`           | color  |       | #c8d0d8 |                                                         |
| Night Fog Color      | `fogColorNight`      | color  |       | #1a1a2e |                                                         |
| Sky Tint Strength    | `skyTintStrength`    | slider | 0 … 3 | 0       |                                                         |
|                      |                      |        |       |         | _How much the live sky/environment color tints fog._    |
| Night Color Strength | `nightColorStrength` | slider | 0 … 3 | 0.75    |                                                         |
|                      |                      |        |       |         | _Blend toward night fog color as scene darkness rises._ |
| Darkness Strength    | `darknessStrength`   | slider | 0 … 3 | 0.65    |                                                         |
|                      |                      |        |       |         | _How much LightingDirector darkness affects fog color._ |
| Darkness Min Color   | `darknessColorMin`   | slider | 0 … 1 | 0.25    |                                                         |
|                      |                      |        |       |         | _Floor luminance when darkness crushes fog tint._       |

### HDR Composite _(advanced)_

| Control             | id                       | Type   | Range      | Default | Notes                                                                                         |
| ------------------- | ------------------------ | ------ | ---------- | ------- | --------------------------------------------------------------------------------------------- |
| HDR Haze Strength   | `hdrHazeStrength`        | slider | 0 … 2      | 1       |                                                                                               |
|                     |                          |        |            |         | _Luminance-matched haze on the linear HDR composite._                                         |
| Fog Glow Add        | `fogAdditive`            | slider | 0 … 1      | 0.35    |                                                                                               |
|                     |                          |        |            |         | _Extra air glow added in linear space._                                                       |
| Reference Luminance | `fogRefLuminance`        | slider | 0.02 … 0.5 | 0.14    |                                                                                               |
|                     |                          |        |            |         | _Target air radiance in linear HDR space. Fog scatter is anchored here, not to local lights._ |
| Light Smothering    | `lightOcclusionStrength` | slider | 0 … 1      | 1       |                                                                                               |
|                     |                          |        |            |         | _How strongly fog occludes Foundry lights and emissive hotspots. 0 = no extra occlusion._     |

### Fog Banks & Storms _(advanced)_

| Control               | id                     | Type   | Range      | Default | Notes                                                                             |
| --------------------- | ---------------------- | ------ | ---------- | ------- | --------------------------------------------------------------------------------- |
| Bank Scale            | `macroScale`           | slider | 0.01 … 0.3 | 0.05    |                                                                                   |
|                       |                        |        |            |         | _Size of macro fog banks and clear-air gaps. Lower = larger features._            |
| Bank Contrast         | `macroStrength`        | slider | 0 … 1      | 0.8     |                                                                                   |
|                       |                        |        |            |         | _How strongly macro noise carves dense banks vs clear pockets._                   |
| Building Encroachment | `buildingEncroachment` | slider | 0 … 1      | 1       |                                                                                   |
|                       |                        |        |            |         | _Thick fog banks hug walls; clear gaps pull fog away. 0 = static clearance only._ |
| Rain Responsiveness   | `rainResponsiveness`   | slider | 0 … 2      | 1       |                                                                                   |
|                       |                        |        |            |         | _How much precipitation breaks fog into turbulent streaks._                       |

### Swirls & Detail _(advanced)_

| Control         | id                | Type     | Range                   | Default | Notes                                                                                   |
| --------------- | ----------------- | -------- | ----------------------- | ------- | --------------------------------------------------------------------------------------- |
| Enable Swirls   | `noiseEnabled`    | boolean  |                         | true    |                                                                                         |
| Detail Scale    | `noiseScale`      | slider   | 0.5 … 10                | 2       |                                                                                         |
|                 |                   |          |                         |         | _Fine noise scale for micro fog texture._                                               |
| Detail Strength | `noiseStrength`   | slider   | 0 … 0.5                 | 0.15    |                                                                                         |
|                 |                   |          |                         |         | _Amplitude of fine noise variation on top of macro banks._                              |
| Detail Contrast | `noiseContrast`   | slider   | 0.5 … 2.5               | 1.35    |                                                                                         |
|                 |                   |          |                         |         | _Sharpens or softens fine noise variation._                                             |
| Swirl Strength  | `curlStrength`    | slider   | 0 … 3                   | 0.55    |                                                                                         |
|                 |                   |          |                         |         | _Intensity of domain-warp swirls._                                                      |
| Swirl Scale     | `curlScale`       | slider   | 0.1 … 6                 | 1       |                                                                                         |
|                 |                   |          |                         |         | _Size of swirl features in the domain warp._                                            |
| Swirl Depth     | `swirlIterations` | dropdown | Basic / Fluid / Chaotic | 2       |                                                                                         |
|                 |                   |          |                         |         | _Domain-warp iterations: Basic = simple swirls, Fluid = tendrils, Chaotic = turbulent._ |

### Wind & Motion _(advanced)_

| Control         | id                      | Type   | Range    | Default | Notes                                      |
| --------------- | ----------------------- | ------ | -------- | ------- | ------------------------------------------ |
| Animation Speed | `noiseSpeed`            | slider | 0 … 0.2  | 0.05    |                                            |
|                 |                         |        |          |         | _Base rate for fog noise evolution._       |
| Wind Drift      | `advectionSpeed`        | slider | 0 … 4    | 1       | hidden                                     |
|                 |                         |        |          |         | _Moved to Scene Wind → Fog advection._     |
| Wind Turn Rate  | `windDirResponsiveness` | slider | 0.1 … 10 | 6       | hidden                                     |
|                 |                         |        |          |         | _Moved to Scene Wind → Fog wind response._ |

### Indoor & Building Mask _(advanced)_

| Control                  | id                       | Type    | Range   | Default | Notes                                                                 |
| ------------------------ | ------------------------ | ------- | ------- | ------- | --------------------------------------------------------------------- |
| Reduce Indoors           | `useIndoorMask`          | boolean |         | true    |                                                                       |
|                          |                          |         |         |         | _Fade fog where the outdoors mask marks interior space._              |
| Indoor Reduction         | `indoorFogReduction`     | slider  | 0 … 1   | 0.9     |                                                                       |
|                          |                          |         |         |         | _1 = no fog indoors, 0 = full fog indoors._                           |
| Distance-Field Clearance | `useRoofDistanceFeather` | boolean |         | true    |                                                                       |
|                          |                          |         |         |         | _Soft fog falloff near building walls using the roof distance field._ |
| Building Clearance (px)  | `indoorBufferPx`         | slider  | 0 … 400 | 48      |                                                                       |
|                          |                          |         |         |         | _Hard clearance band before fog ramps in, measured from walls._       |
| Clearance Softness (px)  | `indoorSoftnessPx`       | slider  | 0 … 600 | 120     |                                                                       |
|                          |                          |         |         |         | _Width of the soft ramp after the hard clearance band._               |

### Low-Density Cutout _(advanced)_

| Control         | id               | Type    | Range    | Default | Notes                                                       |
| --------------- | ---------------- | ------- | -------- | ------- | ----------------------------------------------------------- |
| Enable Cutout   | `cutoutEnabled`  | boolean |          | true    |                                                             |
|                 |                  |         |          |         | _Large holes at low density to reduce the painted-on look._ |
| Cutout Scale    | `cutoutScale`    | slider  | 0.02 … 1 | 0.22    |                                                             |
| Cutout Strength | `cutoutStrength` | slider  | 0 … 1    | 0.4     |                                                             |
| Cutout Speed    | `cutoutSpeed`    | slider  | 0 … 0.2  | 0.02    |                                                             |
| Cutout Contrast | `cutoutContrast` | slider  | 0.5 … 3  | 1.25    |                                                             |

### Advanced _(advanced)_

| Control               | id                   | Type    | Range | Default | Notes                                                            |
| --------------------- | -------------------- | ------- | ----- | ------- | ---------------------------------------------------------------- |
| Depth Modulation      | `useDepthModulation` | boolean |       | false   |                                                                  |
|                       |                      |         |       |         | _Elevated tiles and tokens receive less fog via the depth pass._ |
| Force Full-Screen Fog | `debugForceFog`      | boolean |       | false   |                                                                  |
|                       |                      |         |       |         | _Ignore masks; show radial haze at density for debugging._       |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes |
| ------- | --------- | ------- | ----- | ------- | ----- |
| enabled | `enabled` | boolean |       | true    |       |
