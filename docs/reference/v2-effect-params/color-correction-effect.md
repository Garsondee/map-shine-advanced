# Camera Grade (HDR to LDR)

**V2 class:** `ColorCorrectionEffectV2` · **Source:** `legacy/compositor-v2/effects/ColorCorrectionEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Final camera grade after the HDR scene composite: exposure, white balance, basic adjustments, lift/gamma/gain, tone mapping, vignette, and film grain.

**Dynamic exposure:** when token Dynamic Exposure is enabled, its multiplier is applied on top of the Exposure slider (`DynamicExposureManager` writes `params.dynamicExposure` each frame — not a Tweakpane control).

**Persistence:** this effect supports **World Based** in the GM panel (shared across scenes) or per-scene storage when World Based is off.

Fullscreen post; cost is modest (single pass).

**Time-of-day timeline:** eight clock anchors each with global and interior exposure, saturation, and RGB tint multipliers (1 = neutral, 0–3 per channel); blends as scene time changes.

**Outdoor atmosphere:** procedural weather/golden-hour offsets on sky-eligible outdoor pixels (after timeline, before tone map). Requires \_Outdoors for interior vs outdoor timeline splits and atmosphere gating.

**Local ToD override:** under gameplay lights (HDR light buffer), blends from the timeline grade toward a bright neutral local grade — cancels midnight tint/exposure in lit pools without a circular cutout.

**Note:** Vignette **softness** is written to a uniform but the current fragment shader uses a fixed falloff — the slider is reserved for a future shader hook.

## The knobs, in the author's words

- **Exposure** — Linear intensity before white balance (also multiplied by dynamic exposure when active).
- **Temperature** — Warm vs cool white balance.
- **Tint** — Green–magenta balance.
- **Contrast** — Scales color around mid gray.
- **Saturation** — Overall chroma.
- **Vibrance** — Boosts low-saturation colors more than already-saturated ones.
- **Lift** — Shadows lift (added before gain/gamma).
- **Gamma** — Per-channel gamma pivot (shader uses as pow curve).
- **Gain** — Per-channel multiply after lift.
- **Master gamma** — Global gamma after LGG.
- **Tone mapping** — HDR-style curve (ACES or Reinhard) after the grade.
- **Vignette** — Edge darkening strength.
- **Grain** — Animated film noise amplitude.

## Authored presets

`Clear Noon` · `Golden Hour` · `Overcast Day` · `Storm` · `Moonlit Night` · `Interior Night` · `Cinematic` · `Noir` · `Warm & Cozy` · `Cold Horror`

## Controls, grouped as the author grouped them

### Exposure & color

| Control     | id            | Type   | Range        | Default | Notes                                                                                                |
| ----------- | ------------- | ------ | ------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| Exposure    | `exposure`    | slider | 0.25 … 2     | 1       |                                                                                                      |
|             |               |        |              |         | _Final camera exposure multiplier before tone mapping. Dynamic exposure multiplies this at runtime._ |
| Temperature | `temperature` | slider | -1 … 1       | 0       |                                                                                                      |
|             |               |        |              |         | _Warm (positive) vs cool (negative) white balance._                                                  |
| Tint        | `tint`        | slider | -1 … 1       | 0       |                                                                                                      |
|             |               |        |              |         | _Green vs magenta cast._                                                                             |
| Contrast    | `contrast`    | slider | 0.5 … 1.6    | 1       |                                                                                                      |
|             |               |        |              |         | _Scales distance from 0.5 luma (1 = unchanged)._                                                     |
| Brightness  | `brightness`  | slider | -0.25 … 0.25 | 0       |                                                                                                      |
|             |               |        |              |         | _Small constant offset after exposure and white balance. Prefer Exposure for physical brightness._   |
| Saturation  | `saturation`  | slider | 0 … 1.6      | 1       |                                                                                                      |
|             |               |        |              |         | _0 = grayscale, 1 ≈ natural, above 1 boosts color._                                                  |
| Vibrance    | `vibrance`    | slider | -1 … 1       | 0       |                                                                                                      |
|             |               |        |              |         | _Selective saturation boost (affects muted colors more)._                                            |

### Outdoor atmosphere

| Control                     | id                             | Type    | Range      | Default             | Notes                                                                                                                                       |
| --------------------------- | ------------------------------ | ------- | ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable outdoor atmosphere   | `atmosphereEnabled`            | boolean |            | false               |                                                                                                                                             |
|                             |                                |         |            |                     | _Weather-aware golden hour / overcast offsets on sky-eligible outdoor pixels._                                                              |
| Outdoor atmosphere strength | `intensity`                    | slider  | 0 … 1      | 1                   |                                                                                                                                             |
|                             |                                |         |            |                     | _Blend of procedural outdoor atmosphere on sky-visible pixels. Also exported as environment strength for water and weather-aware lighting._ |
| Sky color saturation        | `saturationBoost`              | slider  | -0.5 … 0.5 | 0                   |                                                                                                                                             |
| Sky color vibrance          | `vibranceBoost`                | slider  | -0.5 … 0.5 | 0                   |                                                                                                                                             |
| Shadow preserve             | `shadowGradePreserve`          | slider  | 0 … 1      | 0.35                |                                                                                                                                             |
|                             |                                |         |            |                     | _Keeps shadowed outdoor pixels from full atmospheric recolor._                                                                              |
| Master darkness blend       | `calendarDarknessBlend`        | slider  | 0 … 1      | 1                   |                                                                                                                                             |
| Day/night color separation  | `dayNightGradePull`            | slider  | 0 … 2.5    | 1                   |                                                                                                                                             |
| Night color depth           | `nightExtraDarkness`           | slider  | 0 … 0.45   | 0                   |                                                                                                                                             |
| Auto Intensity              | `autoIntensityEnabled`         | boolean |            | false               |                                                                                                                                             |
| Auto Strength               | `autoIntensityStrength`        | slider  | 0 … 1      | 1                   |                                                                                                                                             |
| Sunrise                     | `sunriseHour`                  | slider  | 0 … 24     | 6                   |                                                                                                                                             |
| Sunset                      | `sunsetHour`                   | slider  | 0 … 24     | 18                  |                                                                                                                                             |
| Golden Width                | `goldenHourWidth`              | slider  | 0.25 … 6   | 1.3                 |                                                                                                                                             |
| Golden Strength             | `goldenStrength`               | slider  | 0 … 4      | 1                   |                                                                                                                                             |
| Golden Power                | `goldenPower`                  | slider  | 0.5 … 3    | 1                   |                                                                                                                                             |
| Golden Recolor              | `goldenOutdoorRecolorStrength` | slider  | 0 … 4      | 0                   |                                                                                                                                             |
| Golden Recolor Color        | `goldenOutdoorRecolorColor`    | color   |            | {"r":1,"g":1,"b":1} |                                                                                                                                             |
| Night Floor                 | `nightFloor`                   | slider  | 0 … 0.5    | 0                   |                                                                                                                                             |
| Analytic Strength           | `analyticStrength`             | slider  | 0 … 4      | 0.85                |                                                                                                                                             |
| Turbidity                   | `turbidity`                    | slider  | 0 … 1      | 0.22                |                                                                                                                                             |
| Rayleigh                    | `rayleighStrength`             | slider  | 0 … 1      | 0.63                |                                                                                                                                             |
| Mie                         | `mieStrength`                  | slider  | 0 … 1      | 0.35                |                                                                                                                                             |
| Forward Scatter             | `forwardScatter`               | slider  | 0 … 1      | 0.3                 |                                                                                                                                             |
| Weather Influence           | `weatherInfluence`             | slider  | 0 … 1      | 0.67                |                                                                                                                                             |
| Cloud→Turbidity             | `cloudToTurbidity`             | slider  | 0 … 2      | 0.25                |                                                                                                                                             |
| Precip→Turbidity            | `precipToTurbidity`            | slider  | 0 … 2      | 0.72                |                                                                                                                                             |
| Overcast Desat              | `overcastDesaturate`           | slider  | 0 … 1      | 0                   |                                                                                                                                             |
| Overcast Contrast           | `overcastContrastReduce`       | slider  | 0 … 1      | 0                   |                                                                                                                                             |
| Warm Horizon                | `tempWarmAtHorizon`            | slider  | 0 … 1      | 0                   |                                                                                                                                             |
| Cool Noon                   | `tempCoolAtNoon`               | slider  | -1 … 0     | 0                   |                                                                                                                                             |
| Night Cool                  | `nightCoolBoost`               | slider  | -1 … 0     | 0                   |                                                                                                                                             |
| Golden Sat                  | `goldenSaturationBoost`        | slider  | 0 … 1      | 0                   |                                                                                                                                             |
| Night Sat Floor             | `nightSaturationFloor`         | slider  | 0 … 1      | 0                   |                                                                                                                                             |
| Haze Lift                   | `hazeLift`                     | slider  | 0 … 0.5    | 0                   |                                                                                                                                             |
| Haze Contrast               | `hazeContrastLoss`             | slider  | 0 … 1      | 0                   |                                                                                                                                             |

### HDR tone mapping _(advanced)_

| Control      | id            | Type   | Range                         | Default                   | Notes                                                                                                                                                                                               |
| ------------ | ------------- | ------ | ----------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tone mapping | `toneMapping` | list   | None / ACES Filmic / Reinhard | 0                         |                                                                                                                                                                                                     |
|              |               |        |                               |                           | _HDR → LDR curve. With the Linear HDR pipeline (Lighting/Sky output unclamped linear values), ACES is recommended. "None" leaves the merged HDR scene unmapped, which clips highlights on display._ |
| Lift         | `liftColor`   | color  |                               | {"r":0,"g":0,"b":0}       |                                                                                                                                                                                                     |
|              |               |        |                               |                           | _Shadow tint added before gain (scaled in shader)._                                                                                                                                                 |
| Gamma        | `gammaColor`  | color  |                               | {"r":0.5,"g":0.5,"b":0.5} |                                                                                                                                                                                                     |
|              |               |        |                               |                           | _Per-channel gamma exponent (shader uses pow(rgb, 1/gamma); 1 = neutral)._                                                                                                                          |
| Gain         | `gainColor`   | color  |                               | {"r":1,"g":1,"b":1}       |                                                                                                                                                                                                     |
|              |               |        |                               |                           | _Per-channel multiply after lift._                                                                                                                                                                  |
| Master gamma | `masterGamma` | slider | 0.1 … 6                       | 2                         |                                                                                                                                                                                                     |
|              |               |        |                               |                           | _Overall gamma after lift/gamma/gain (1 = neutral)._                                                                                                                                                |

### Vignette & grain _(advanced)_

| Control                      | id                 | Type   | Range   | Default | Notes                                                             |
| ---------------------------- | ------------------ | ------ | ------- | ------- | ----------------------------------------------------------------- |
| Vignette strength            | `vignetteStrength` | slider | 0 … 2   | 0       |                                                                   |
|                              |                    |        |         |         | _How much edges darken (0 = off)._                                |
| Vignette softness (reserved) | `vignetteSoftness` | slider | 0 … 1   | 0       |                                                                   |
|                              |                    |        |         |         | _Reserved: uniform is updated but shader falloff is fixed today._ |
| Grain strength               | `grainStrength`    | slider | 0 … 0.5 | 0       |                                                                   |
|                              |                    |        |         |         | _Animated film grain amplitude (0 = off)._                        |

### Time-of-day camera timeline _(advanced)_

| Control                     | id                           | Type    | Range   | Default | Notes                                                                                                                                                                                                               |
| --------------------------- | ---------------------------- | ------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable time-of-day timeline | `todTimelineEnabled`         | boolean |         | true    |                                                                                                                                                                                                                     |
|                             |                              |         |         |         | _Blends eight clock anchors (global + interior grades) as Map Shine time advances. This is the camera-grade owner for visible time-of-day exposure._                                                                |
| Local ToD Override Strength | `localWarmLightPreserve`     | slider  | 0 … 1   | 1       |                                                                                                                                                                                                                     |
|                             |                              |         |         |         | _Blends from the scene timeline grade toward a bright neutral local grade under gameplay lights (HDR light-buffer alpha). 0 = full midnight/global tint everywhere; 1 = full local override inside lit pools only._ |
| Local Override Exposure     | `localTodOverrideExposure`   | slider  | -2 … 5  | 1       |                                                                                                                                                                                                                     |
|                             |                              |         |         |         | _Base exposure stops added inside local-light pools on top of the timeline grade. Stronger lights gain extra stops automatically — counters midnight darkness and blue tint._                                       |
| Local Override Saturation   | `localTodOverrideSaturation` | slider  | 0.5 … 2 | 1       |                                                                                                                                                                                                                     |
|                             |                              |         |         |         | _Minimum saturation multiplier inside local-light pools when overriding toward neutral tint. Brighter pool cores push slightly higher._                                                                             |
| Fire / Emissive Preserve    | `localWarmEmissiveAdd`       | slider  | 0 … 1.5 | 1       |                                                                                                                                                                                                                     |
|                             |                              |         |         |         | _Skips time-of-day and atmosphere darkening on HDR flames, sparks, and other emissive art (1 = full preserve). Base exposure/WB still apply._                                                                       |
| Lamp Light Preserve         | `lampLightPreserve`          | slider  | 0 … 1   | 0.9     |                                                                                                                                                                                                                     |
|                             |                              |         |         |         | _Foundry AmbientLight pools resist interior timeline / context darkening so 0.5 vs 1.0 luminosity stays visible indoors._                                                                                           |

### Noon (~12:00) _(advanced)_

| Control                  | id                       | Type   | Range  | Default | Notes                                                                                                                                  |
| ------------------------ | ------------------------ | ------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clock hour               | `tod4Hour`               | slider | 0 … 24 | 12      |                                                                                                                                        |
|                          |                          |        |        |         | _When the scene clock is near this anchor (12:00 by default). Anchors blend smoothly around the 24h cycle, including across midnight._ |
| Global exposure          | `tod4GlobalExposure`     | slider | -3 … 3 | 0.7     |                                                                                                                                        |
|                          |                          |        |        |         | _Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme._                |
| Global saturation        | `tod4GlobalSaturation`   | slider | 0 … 2  | 1.2     |                                                                                                                                        |
|                          |                          |        |        |         | _Global saturation multiplier for this time anchor._                                                                                   |
| Global tint R            | `tod4GlobalTintR`        | slider | 0 … 3  | 0.9     |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint G            | `tod4GlobalTintG`        | slider | 0 … 3  | 0.9     |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint B            | `tod4GlobalTintB`        | slider | 0 … 3  | 1.13    |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Interior exposure offset | `tod4InteriorExposure`   | slider | -3 … 3 | -1      |                                                                                                                                        |
|                          |                          |        |        |         | _Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night._ |
| Interior saturation      | `tod4InteriorSaturation` | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior-only saturation multiplier for this time anchor._                                                                            |
| Interior tint R          | `tod4InteriorTintR`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint G          | `tod4InteriorTintG`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint B          | `tod4InteriorTintB`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |

### Afternoon (~15:00) _(advanced)_

| Control                  | id                       | Type   | Range  | Default | Notes                                                                                                                                  |
| ------------------------ | ------------------------ | ------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clock hour               | `tod5Hour`               | slider | 0 … 24 | 15      |                                                                                                                                        |
|                          |                          |        |        |         | _When the scene clock is near this anchor (15:00 by default). Anchors blend smoothly around the 24h cycle, including across midnight._ |
| Global exposure          | `tod5GlobalExposure`     | slider | -3 … 3 | 0.9     |                                                                                                                                        |
|                          |                          |        |        |         | _Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme._                |
| Global saturation        | `tod5GlobalSaturation`   | slider | 0 … 2  | 1.08    |                                                                                                                                        |
|                          |                          |        |        |         | _Global saturation multiplier for this time anchor._                                                                                   |
| Global tint R            | `tod5GlobalTintR`        | slider | 0 … 3  | 1.15    |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint G            | `tod5GlobalTintG`        | slider | 0 … 3  | 0.98    |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint B            | `tod5GlobalTintB`        | slider | 0 … 3  | 1.04    |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Interior exposure offset | `tod5InteriorExposure`   | slider | -3 … 3 | -1      |                                                                                                                                        |
|                          |                          |        |        |         | _Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night._ |
| Interior saturation      | `tod5InteriorSaturation` | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior-only saturation multiplier for this time anchor._                                                                            |
| Interior tint R          | `tod5InteriorTintR`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint G          | `tod5InteriorTintG`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint B          | `tod5InteriorTintB`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |

### Dusk (~18:00) _(advanced)_

| Control                  | id                       | Type   | Range  | Default | Notes                                                                                                                                  |
| ------------------------ | ------------------------ | ------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clock hour               | `tod6Hour`               | slider | 0 … 24 | 18      |                                                                                                                                        |
|                          |                          |        |        |         | _When the scene clock is near this anchor (18:00 by default). Anchors blend smoothly around the 24h cycle, including across midnight._ |
| Global exposure          | `tod6GlobalExposure`     | slider | -3 … 3 | -0.4    |                                                                                                                                        |
|                          |                          |        |        |         | _Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme._                |
| Global saturation        | `tod6GlobalSaturation`   | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Global saturation multiplier for this time anchor._                                                                                   |
| Global tint R            | `tod6GlobalTintR`        | slider | 0 … 3  | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint G            | `tod6GlobalTintG`        | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint B            | `tod6GlobalTintB`        | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Interior exposure offset | `tod6InteriorExposure`   | slider | -3 … 3 | -2      |                                                                                                                                        |
|                          |                          |        |        |         | _Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night._ |
| Interior saturation      | `tod6InteriorSaturation` | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior-only saturation multiplier for this time anchor._                                                                            |
| Interior tint R          | `tod6InteriorTintR`      | slider | 0 … 3  | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint G          | `tod6InteriorTintG`      | slider | 0 … 3  | 1.39    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint B          | `tod6InteriorTintB`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |

### Night (~21:00) _(advanced)_

| Control                  | id                       | Type   | Range  | Default | Notes                                                                                                                                  |
| ------------------------ | ------------------------ | ------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clock hour               | `tod7Hour`               | slider | 0 … 24 | 21      |                                                                                                                                        |
|                          |                          |        |        |         | _When the scene clock is near this anchor (21:00 by default). Anchors blend smoothly around the 24h cycle, including across midnight._ |
| Global exposure          | `tod7GlobalExposure`     | slider | -3 … 3 | -2      |                                                                                                                                        |
|                          |                          |        |        |         | _Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme._                |
| Global saturation        | `tod7GlobalSaturation`   | slider | 0 … 2  | 2       |                                                                                                                                        |
|                          |                          |        |        |         | _Global saturation multiplier for this time anchor._                                                                                   |
| Global tint R            | `tod7GlobalTintR`        | slider | 0 … 3  | 0       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint G            | `tod7GlobalTintG`        | slider | 0 … 3  | 0       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint B            | `tod7GlobalTintB`        | slider | 0 … 3  | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Interior exposure offset | `tod7InteriorExposure`   | slider | -3 … 3 | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night._ |
| Interior saturation      | `tod7InteriorSaturation` | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior-only saturation multiplier for this time anchor._                                                                            |
| Interior tint R          | `tod7InteriorTintR`      | slider | 0 … 3  | 0.55    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint G          | `tod7InteriorTintG`      | slider | 0 … 3  | 0.71    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint B          | `tod7InteriorTintB`      | slider | 0 … 3  | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |

### Midnight (~00:00) _(advanced)_

| Control                  | id                       | Type   | Range  | Default | Notes                                                                                                                                  |
| ------------------------ | ------------------------ | ------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clock hour               | `tod0Hour`               | slider | 0 … 24 | 0       |                                                                                                                                        |
|                          |                          |        |        |         | _When the scene clock is near this anchor (00:00 by default). Anchors blend smoothly around the 24h cycle, including across midnight._ |
| Global exposure          | `tod0GlobalExposure`     | slider | -3 … 3 | -1      |                                                                                                                                        |
|                          |                          |        |        |         | _Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme._                |
| Global saturation        | `tod0GlobalSaturation`   | slider | 0 … 2  | 2       |                                                                                                                                        |
|                          |                          |        |        |         | _Global saturation multiplier for this time anchor._                                                                                   |
| Global tint R            | `tod0GlobalTintR`        | slider | 0 … 3  | 0.5     |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint G            | `tod0GlobalTintG`        | slider | 0 … 3  | 0.5     |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint B            | `tod0GlobalTintB`        | slider | 0 … 3  | 2       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Interior exposure offset | `tod0InteriorExposure`   | slider | -3 … 3 | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night._ |
| Interior saturation      | `tod0InteriorSaturation` | slider | 0 … 2  | 2       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior-only saturation multiplier for this time anchor._                                                                            |
| Interior tint R          | `tod0InteriorTintR`      | slider | 0 … 3  | 0.55    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint G          | `tod0InteriorTintG`      | slider | 0 … 3  | 0.71    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint B          | `tod0InteriorTintB`      | slider | 0 … 3  | 2.29    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |

### Pre-dawn (~03:00) _(advanced)_

| Control                  | id                       | Type   | Range  | Default | Notes                                                                                                                                  |
| ------------------------ | ------------------------ | ------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clock hour               | `tod1Hour`               | slider | 0 … 24 | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _When the scene clock is near this anchor (03:00 by default). Anchors blend smoothly around the 24h cycle, including across midnight._ |
| Global exposure          | `tod1GlobalExposure`     | slider | -3 … 3 | -2      |                                                                                                                                        |
|                          |                          |        |        |         | _Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme._                |
| Global saturation        | `tod1GlobalSaturation`   | slider | 0 … 2  | 2       |                                                                                                                                        |
|                          |                          |        |        |         | _Global saturation multiplier for this time anchor._                                                                                   |
| Global tint R            | `tod1GlobalTintR`        | slider | 0 … 3  | 0       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint G            | `tod1GlobalTintG`        | slider | 0 … 3  | 0       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint B            | `tod1GlobalTintB`        | slider | 0 … 3  | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Interior exposure offset | `tod1InteriorExposure`   | slider | -3 … 3 | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night._ |
| Interior saturation      | `tod1InteriorSaturation` | slider | 0 … 2  | 0.98    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior-only saturation multiplier for this time anchor._                                                                            |
| Interior tint R          | `tod1InteriorTintR`      | slider | 0 … 3  | 0.55    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint G          | `tod1InteriorTintG`      | slider | 0 … 3  | 0.71    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint B          | `tod1InteriorTintB`      | slider | 0 … 3  | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |

### Dawn (~06:00) _(advanced)_

| Control                  | id                       | Type   | Range  | Default | Notes                                                                                                                                  |
| ------------------------ | ------------------------ | ------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clock hour               | `tod2Hour`               | slider | 0 … 24 | 6       |                                                                                                                                        |
|                          |                          |        |        |         | _When the scene clock is near this anchor (06:00 by default). Anchors blend smoothly around the 24h cycle, including across midnight._ |
| Global exposure          | `tod2GlobalExposure`     | slider | -3 … 3 | -0.4    |                                                                                                                                        |
|                          |                          |        |        |         | _Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme._                |
| Global saturation        | `tod2GlobalSaturation`   | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Global saturation multiplier for this time anchor._                                                                                   |
| Global tint R            | `tod2GlobalTintR`        | slider | 0 … 3  | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint G            | `tod2GlobalTintG`        | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint B            | `tod2GlobalTintB`        | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Interior exposure offset | `tod2InteriorExposure`   | slider | -3 … 3 | -2      |                                                                                                                                        |
|                          |                          |        |        |         | _Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night._ |
| Interior saturation      | `tod2InteriorSaturation` | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior-only saturation multiplier for this time anchor._                                                                            |
| Interior tint R          | `tod2InteriorTintR`      | slider | 0 … 3  | 3       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint G          | `tod2InteriorTintG`      | slider | 0 … 3  | 1.39    |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint B          | `tod2InteriorTintB`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |

### Morning (~09:00) _(advanced)_

| Control                  | id                       | Type   | Range  | Default | Notes                                                                                                                                  |
| ------------------------ | ------------------------ | ------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clock hour               | `tod3Hour`               | slider | 0 … 24 | 9       |                                                                                                                                        |
|                          |                          |        |        |         | _When the scene clock is near this anchor (09:00 by default). Anchors blend smoothly around the 24h cycle, including across midnight._ |
| Global exposure          | `tod3GlobalExposure`     | slider | -3 … 3 | 0.9     |                                                                                                                                        |
|                          |                          |        |        |         | _Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme._                |
| Global saturation        | `tod3GlobalSaturation`   | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Global saturation multiplier for this time anchor._                                                                                   |
| Global tint R            | `tod3GlobalTintR`        | slider | 0 … 3  | 1.2     |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint G            | `tod3GlobalTintG`        | slider | 0 … 3  | 1.02    |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Global tint B            | `tod3GlobalTintB`        | slider | 0 … 3  | 1.06    |                                                                                                                                        |
|                          |                          |        |        |         | _Global per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                  |
| Interior exposure offset | `tod3InteriorExposure`   | slider | -3 … 3 | -1      |                                                                                                                                        |
|                          |                          |        |        |         | _Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night._ |
| Interior saturation      | `tod3InteriorSaturation` | slider | 0 … 2  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior-only saturation multiplier for this time anchor._                                                                            |
| Interior tint R          | `tod3InteriorTintR`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint G          | `tod3InteriorTintG`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |
| Interior tint B          | `tod3InteriorTintB`      | slider | 0 … 3  | 1       |                                                                                                                                        |
|                          |                          |        |        |         | _Interior per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour._                                                                |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | true    | hidden |
