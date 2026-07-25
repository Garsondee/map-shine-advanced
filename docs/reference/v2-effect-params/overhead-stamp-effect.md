# OverheadStampEffectV2

**V2 class:** `OverheadStampEffectV2` · **Source:** `legacy/compositor-v2/effects/OverheadStampEffectV2.js`

**Rebuilt in V3 as:** `masks.occlusion (token-fade half)`, `light.visibility (shadow half)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Overhead Shadows

| Control                      | id                          | Type     | Range    | Default | Notes                                                                                                      |
| ---------------------------- | --------------------------- | -------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| Shadow Opacity               | `opacity`                   | slider   | 0 … 1    | 1       |                                                                                                            |
| Shadow Length                | `length`                    | slider   | 0 … 0.3  | 0.12    |                                                                                                            |
| Softness                     | `softness`                  | slider   | 0.5 … 5  | 1       |                                                                                                            |
| Affects Dynamic Lights       | `affectsLights`             | slider   | 0 … 1    | 0.7     |                                                                                                            |
|                              |                             |          |          |         | _Scales how strongly overhead roof shadows lift dynamic-light shadow regions (0 = no lift, 1 = full lift)_ |
| Use Fluid Effect Colour      | `fluidColorEnabled`         | checkbox |          | false   |                                                                                                            |
|                              |                             |          |          |         | _Tints overhead shadows with FluidEffect colour when fluid overlays are attached to overhead tiles_        |
| Fluid Effect Transparency    | `fluidEffectTransparency`   | slider   | 0 … 1    | 0.35    |                                                                                                            |
|                              |                             |          |          |         | _Opacity of FluidEffect colour tint in overhead shadows_                                                   |
| Fluid Shadow Intensity Boost | `fluidShadowIntensityBoost` | slider   | 0 … 5    | 1       |                                                                                                            |
|                              |                             |          |          |         | _Boost multiplier for FluidEffect shadow contribution (up to 500%)_                                        |
| Fluid Shadow Softness        | `fluidShadowSoftness`       | slider   | 0.5 … 10 | 3       |                                                                                                            |
|                              |                             |          |          |         | _Blur radius for FluidEffect tint on outdoor receivers (up to 2x regular shadow softness range)_           |
| Fluid Colour Boost           | `fluidColorBoost`           | slider   | 0 … 4    | 1.5     |                                                                                                            |
|                              |                             |          |          |         | _Boosts fluid colour intensity used to tint overhead shadows_                                              |
| Fluid Colour Saturation      | `fluidColorSaturation`      | slider   | 0 … 3    | 1.2     |                                                                                                            |
|                              |                             |          |          |         | _Saturation multiplier for fluid shadow tint colour_                                                       |

### Tile Shadow Projection _(advanced)_

| Control                       | id                                  | Type     | Range    | Default | Notes                                                                                               |
| ----------------------------- | ----------------------------------- | -------- | -------- | ------- | --------------------------------------------------------------------------------------------------- |
| Enable Tile Shadow Projection | `tileProjectionEnabled`             | checkbox |          | true    |                                                                                                     |
|                               |                                     |          |          |         | _Adds tile alpha from Tile Motion (per-tile Shadow Projection) as an extra projected shadow source_ |
| Tile Projection Strength      | `tileProjectionOpacity`             | slider   | 0 … 1    | 0.45    |                                                                                                     |
|                               |                                     |          |          |         | _Overall strength of tile-projected shadows_                                                        |
| Tile Projection Length Scale  | `tileProjectionLengthScale`         | slider   | 0 … 30   | 1       |                                                                                                     |
|                               |                                     |          |          |         | _Projection distance for tile shadows (independent of Outdoor/Indoor receiver length scales)_       |
| Tile Projection Softness      | `tileProjectionSoftness`            | slider   | 0.5 … 10 | 3       |                                                                                                     |
|                               |                                     |          |          |         | _Blur radius for tile-projected shadows_                                                            |
| Tile Alpha Threshold          | `tileProjectionThreshold`           | slider   | 0 … 1    | 0.05    |                                                                                                     |
|                               |                                     |          |          |         | _Ignores very low tile alpha values before projection_                                              |
| Tile Alpha Contrast           | `tileProjectionPower`               | slider   | 0.1 … 4  | 1       |                                                                                                     |
|                               |                                     |          |          |         | _Shapes tile alpha falloff before converting to shadow strength_                                    |
| Tile Outdoor Strength Scale   | `tileProjectionOutdoorOpacityScale` | slider   | 0 … 2    | 0.1     |                                                                                                     |
|                               |                                     |          |          |         | _Additional multiplier applied to tile-projected shadow strength on outdoor receivers_              |
| Tile Indoor Strength Scale    | `tileProjectionIndoorOpacityScale`  | slider   | 0 … 2    | 1       |                                                                                                     |
|                               |                                     |          |          |         | _Additional multiplier applied to tile-projected shadow strength on indoor receivers_               |

### Receiver Regions _(advanced)_

| Control                     | id                                | Type   | Range  | Default | Notes                                                                                            |
| --------------------------- | --------------------------------- | ------ | ------ | ------- | ------------------------------------------------------------------------------------------------ |
| Outdoor Shadow Length Scale | `outdoorShadowLengthScale`        | slider | 0 … 30 | 2       |                                                                                                  |
|                             |                                   |        |        |         | _Scales projected overhead shadow distance on outdoor receivers (0 disables outdoor projection)_ |
| Indoor Shadow Length Scale  | `indoorReceiverShadowLengthScale` | slider | 0 … 30 | 0.25    |                                                                                                  |
|                             |                                   |        |        |         | _Scales projected overhead shadow distance on indoor receivers_                                  |

### Debug _(advanced)_

| Control    | id          | Type | Range                                                                                                               | Default | Notes |
| ---------- | ----------- | ---- | ------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| Debug View | `debugView` | list | Final / ReceiverOutdoors / RoofCoverage / RoofVisibility / RoofBase / RoofCombinedStrength / TileProjectionStrength | final   |       |
