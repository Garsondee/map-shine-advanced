# CloudEffectV2

**V2 class:** `CloudEffectV2` · **Source:** `legacy/compositor-v2/effects/CloudEffectV2.js`

**Rebuilt in V3 as:** `light.visibility (shadow half)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Cover & Sprite Pool

| Control             | id               | Type   | Range    | Default | Notes                                                                                        |
| ------------------- | ---------------- | ------ | -------- | ------- | -------------------------------------------------------------------------------------------- |
| Cloud Cover         | `cloudCover`     | slider | 0 … 1    | 0.84    |                                                                                              |
|                     |                  |        |          |         | _Density of active sprites. Overridden by Weather when Dynamic Weather is running._          |
| Max Sprites         | `spritePoolSize` | slider | 10 … 120 | 60      |                                                                                              |
|                     |                  |        |          |         | _Upper cap on billboard count (split across 3 depth layers). Rebuilds the pool immediately._ |
| Sparse Texture Bias | `sparseWeight`   | slider | -1 … 1   | 1       |                                                                                              |
|                     |                  |        |          |         | _-1 = auto from cover (wispy at low cover). 0 = balanced. 1 = always sparse wisps._          |

### Sprite Textures _(advanced)_

| Control            | id                 | Type   | Range      | Default | Notes                                                          |
| ------------------ | ------------------ | ------ | ---------- | ------- | -------------------------------------------------------------- |
| Min Sprite Size    | `spriteScaleMin`   | slider | 200 … 5000 | 1950    |                                                                |
|                    |                    |        |            |         | _Smallest random world-space size for a cloud PNG._            |
| Max Sprite Size    | `spriteScaleMax`   | slider | 500 … 8000 | 4350    |                                                                |
|                    |                    |        |            |         | _Largest random world-space size for a cloud PNG._             |
| Min Sprite Opacity | `spriteOpacityMin` | slider | 0.1 … 1    | 0.2     |                                                                |
| Max Sprite Opacity | `spriteOpacityMax` | slider | 0.1 … 1    | 0.6     |                                                                |
| Sprite Brightness  | `cloudBrightness`  | slider | 0.8 … 1.5  | 1.5     |                                                                |
|                    |                    |        |            |         | _Overall luminance multiplier after sky tint and sun shading._ |

### Sky & Time of Day _(advanced)_

| Control        | id                    | Type   | Range   | Default | Notes                                                                                                    |
| -------------- | --------------------- | ------ | ------- | ------- | -------------------------------------------------------------------------------------------------------- |
| Sky Tint       | `skyTintStrength`     | slider | 0 … 1.5 | 1.1     |                                                                                                          |
|                |                       |        |         |         | _How strongly cloud colour follows SkyColorEffectV2 tint (sunrise gold, noon blue-white, night indigo)._ |
| Sun Side Light | `sunLightingStrength` | slider | 0 … 1   | 1       |                                                                                                          |
|                |                       |        |         |         | _Soft lit-vs-shadow variation across each puff, aligned with the live sun direction._                    |
| Night Dimming  | `nightDimStrength`    | slider | 0 … 1   | 0.8     |                                                                                                          |
|                |                       |        |         |         | _How much scene darkness dims cloud luminance at night._                                                 |

### Motion & Domain Warp _(advanced)_

| Control             | id                          | Type   | Range    | Default | Notes                                                                                 |
| ------------------- | --------------------------- | ------ | -------- | ------- | ------------------------------------------------------------------------------------- |
| Overlay Domain Warp | `overlayDomainWarpStrength` | slider | 0 … 0.15 | 0.15    |                                                                                       |
|                     |                             |        |          |         | _Animated world-space UV warp on 3D overlay planes (cache-safe, runs every frame)._   |
| Sprite Boil         | `spriteBoilStrength`        | slider | 0 … 0.12 | 0.12    |                                                                                       |
|                     |                             |        |          |         | _Per-cloud UV boil in the capture pass. Values above 0 disable cloud-top RT caching._ |
| Warp Speed          | `domainWarpSpeed`           | slider | 0 … 3    | 0.06    |                                                                                       |
|                     |                             |        |          |         | _Animation rate for overlay warp and sprite boil._                                    |
| Independent Drift   | `driftOrbitStrength`        | slider | 0 … 1    | 0.05    |                                                                                       |
|                     |                             |        |          |         | _Per-sprite secondary orbit so puffs diverge from the main wind field._               |

### Lightning Flash _(advanced)_

| Control          | id                              | Type    | Range | Default | Notes                                                                                        |
| ---------------- | ------------------------------- | ------- | ----- | ------- | -------------------------------------------------------------------------------------------- |
| Lightning Flash  | `lightningCloudEnabled`         | boolean |       | true    |                                                                                              |
|                  |                                 |         |       |         | _Brighten and add contrast to clouds during landscape and map-point lightning strikes._      |
| Flash Brightness | `lightningCloudBrightnessBoost` | slider  | 0 … 8 | 3       |                                                                                              |
|                  |                                 |         |       |         | _Extra luminance multiplier at peak flash (3 ≈ 4× brighter)._                                |
| Flash Contrast   | `lightningCloudContrastBoost`   | slider  | 0 … 6 | 2.5     |                                                                                              |
|                  |                                 |         |       |         | _Contrast punch during strikes; also scales slightly with Weather Lightning flash contrast._ |
| Flash Tint       | `lightningCloudTintStrength`    | slider  | 0 … 1 | 0.8     |                                                                                              |
|                  |                                 |         |       |         | _How strongly clouds pick up the cold lightning flash colour._                               |

### Ground Shadows

| Control               | id                        | Type   | Range    | Default | Notes                                                                                                      |
| --------------------- | ------------------------- | ------ | -------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| Shadow Darkness       | `shadowOpacity`           | slider | 0 … 1    | 0.6     |                                                                                                            |
|                       |                           |        |          |         | _Alpha of black shadow silhouettes cast on the ground._                                                    |
| Shadow Softness       | `shadowSoftness`          | slider | 0.5 … 10 | 1       |                                                                                                            |
| Shadow Cast Distance  | `shadowOffsetScale`       | slider | 0 … 0.3  | 0.3     |                                                                                                            |
|                       |                           |        |          |         | _How far shadows offset opposite the sun (scales with sun elevation driver)._                              |
| Min Shadow Brightness | `minShadowBrightness`     | slider | 0 … 0.5  | 0       |                                                                                                            |
|                       |                           |        |          |         | _Floor for shadow factor — prevents fully black patches._                                                  |
| Scene Edge Fade       | `shadowSceneFadeSoftness` | slider | 0 … 0.15 | 0       |                                                                                                            |
|                       |                           |        |          |         | _Softens shadow clip at scene rect padding._                                                               |
| Shadow RT Scale       | `shadowResolutionScale`   | slider | 0.1 … 1  | 0.35    |                                                                                                            |
|                       |                           |        |          |         | _Internal resolution for ground/window cloud shadows only. Lower is faster; blur masks soften the result._ |

### Screen Cloud Layer _(advanced)_

| Control               | id                   | Type   | Range    | Default | Notes                                                                             |
| --------------------- | -------------------- | ------ | -------- | ------- | --------------------------------------------------------------------------------- |
| Screen Layer Opacity  | `cloudTopOpacity`    | slider | 0 … 1    | 1       |                                                                                   |
|                       |                      |        |          |         | _Strength of the captured sprite RT and 3D overlay planes._                       |
| Soft Edge Start       | `cloudTopAlphaStart` | slider | 0 … 0.8  | 0.2     |                                                                                   |
|                       |                      |        |          |         | _Alpha ramp on wispy cloud edges (overlay shader)._                               |
| Soft Edge End         | `cloudTopAlphaEnd`   | slider | 0.05 … 1 | 0.6     |                                                                                   |
| Hide Above Zoom       | `cloudTopFadeStart`  | slider | 0.1 … 1  | 0.24    |                                                                                   |
|                       |                      |        |          |         | _Zoom level where screen/overlay clouds begin fading (lower = zoomed out)._       |
| Hide Fully Above Zoom | `cloudTopFadeEnd`    | slider | 0.1 … 1  | 0.39    |                                                                                   |
|                       |                      |        |          |         | _Zoom level where screen/overlay clouds are fully hidden. Ground shadows remain._ |

### 3D Overlay Planes _(advanced)_

| Control                 | id                          | Type   | Range          | Default | Notes                                                                                                     |
| ----------------------- | --------------------------- | ------ | -------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| Overlay Coverage        | `cloudLayerCoverageScale`   | slider | 1 … 8          | 1.5     |                                                                                                           |
|                         |                             |        |                |         | _World-space plane size relative to scene (larger = softer horizon fade)._                                |
| Depth Scale Step        | `cloudLayerDepthScaleStep`  | slider | 0 … 0.6        | 0.03    |                                                                                                           |
|                         |                             |        |                |         | _Size variation between the three stacked overlay planes._                                                |
| Overlay Edge Softness   | `cloudLayerEdgeSoftness`    | slider | 0.01 … 0.5     | 0.5     |                                                                                                           |
| Near Plane Opacity      | `cloudLayerOpacityBase`     | slider | 0.1 … 1.5      | 0.96    |                                                                                                           |
| Far Plane Falloff       | `cloudLayerOpacityFalloff`  | slider | 0 … 1          | 0.79    |                                                                                                           |
|                         |                             |        |                |         | _Each higher plane gets dimmer by this fraction._                                                         |
| Near/Far Reveal         | `cloudLayerOuterReveal`     | slider | 0.05 … 1       | 0.9     |                                                                                                           |
|                         |                             |        |                |         | _Fraction of near/far overlay planes visible at any point (noise mask). Lower = less duplicate stacking._ |
| Mid Plane Reveal        | `cloudLayerMidReveal`       | slider | 0.05 … 1       | 0.82    |                                                                                                           |
|                         |                             |        |                |         | _Fraction of the middle overlay plane visible. Usually higher than near/far._                             |
| Depth Noise Scale       | `cloudLayerNoiseScale`      | slider | 0.0002 … 0.002 | 0.00125 |                                                                                                           |
|                         |                             |        |                |         | _Frequency of the smooth per-layer reveal noise (higher = finer patchwork)._                              |
| Depth Noise Softness    | `cloudLayerNoiseSoftness`   | slider | 0.02 … 0.25    | 0.205   |                                                                                                           |
|                         |                             |        |                |         | _Width of the soft transition on the layer reveal mask._                                                  |
| Overlay Wind Drift      | `cloudLayerDriftStrength`   | slider | 0 … 0.2        | 0.188   |                                                                                                           |
|                         |                             |        |                |         | _UV scroll on 3D overlay planes from wind._                                                               |
| Overlay Camera Parallax | `cloudLayerDriftDepthBoost` | slider | 0 … 0.2        | 0.068   |                                                                                                           |
|                         |                             |        |                |         | _Extra pan/zoom parallax on overlay planes per depth._                                                    |

### Overlay Plane Heights _(advanced)_

| Control                | id                                | Type   | Range        | Default | Notes                                                            |
| ---------------------- | --------------------------------- | ------ | ------------ | ------- | ---------------------------------------------------------------- |
| Base Height (fallback) | `cloudLayerHeightFromGround`      | slider | -2000 … 300  | 300     |                                                                  |
|                        |                                   |        |              |         | _Used when per-layer heights are unset._                         |
| Near Plane Height      | `cloudLayer1HeightFromGround`     | slider | 0 … 12000    | 330     |                                                                  |
| Mid Plane Height       | `cloudLayer2HeightFromGround`     | slider | 0 … 12000    | 350     |                                                                  |
| Far Plane Height       | `cloudLayer3HeightFromGround`     | slider | 0 … 12000    | 360     |                                                                  |
| Fallback Z Spacing     | `cloudLayerZSpacing`              | slider | 20 … 1200    | 20      |                                                                  |
|                        |                                   |        |              |         | _Vertical gap when per-layer heights are not used._              |
| Weather Emitter Offset | `cloudLayerBaseOffsetFromEmitter` | slider | -5000 … 2000 | -2200   |                                                                  |
|                        |                                   |        |              |         | _Fallback Z anchor relative to weather particle emitter height._ |

### Sprite Motion Parallax _(advanced)_

| Control             | id                   | Type   | Range | Default | Notes                                                            |
| ------------------- | -------------------- | ------ | ----- | ------- | ---------------------------------------------------------------- |
| Parallax Strength   | `layerParallaxBase`  | slider | 0 … 3 | 1       |                                                                  |
|                     |                      |        |       |         | _Global multiplier for sprite pan parallax (simulation layers)._ |
| Near Layer Parallax | `layer1ParallaxMult` | slider | 0 … 2 | 1       |                                                                  |
| Mid Layer Parallax  | `layer2ParallaxMult` | slider | 0 … 2 | 0.64    |                                                                  |
| Far Layer Parallax  | `layer3ParallaxMult` | slider | 0 … 2 | 0.28    |                                                                  |

### Wind & Drift

| Control             | id                    | Type   | Range    | Default | Notes  |
| ------------------- | --------------------- | ------ | -------- | ------- | ------ |
| Wind Influence      | `windInfluence`       | slider | 0 … 2    | 1.33    |        |
| Drift Speed         | `driftSpeed`          | slider | 0 … 0.1  | 0.061   |        |
| Min Drift Speed     | `minDriftSpeed`       | slider | 0 … 0.05 | 0.002   |        |
| Wind Responsiveness | `driftResponsiveness` | slider | 0 … 1    | 0.75    | hidden |
| Decel Rate          | `driftDecelFactor`    | slider | 0.02 … 1 | 0.14    | hidden |
| Max Drift Speed     | `driftMaxSpeed`       | slider | 0 … 2    | 0.5     |        |

### Performance _(advanced)_

| Control               | id                        | Type   | Range   | Default | Notes                                                                      |
| --------------------- | ------------------------- | ------ | ------- | ------- | -------------------------------------------------------------------------- |
| Screen Cloud RT Scale | `internalResolutionScale` | slider | 0.1 … 1 | 0.5     |                                                                            |
|                       |                           |        |         |         | _Resolution of the captured sprite texture used by screen/overlay clouds._ |
