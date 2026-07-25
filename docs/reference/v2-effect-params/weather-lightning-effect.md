# WeatherLightningEffectV2

**V2 class:** `WeatherLightningEffectV2` · **Source:** `legacy/compositor-v2/effects/WeatherLightningEffectV2.js`

**Rebuilt in V3 as:** `light.accumulate`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Storm

| Control                | id                           | Type   | Range    | Default | Notes                                                                                                 |
| ---------------------- | ---------------------------- | ------ | -------- | ------- | ----------------------------------------------------------------------------------------------------- |
| Storm Intensity        | `stormIntensity`             | slider | 0 … 1    | 0       |                                                                                                       |
|                        |                              |        |          |         | _Automatic distant lightning activity when > 0._                                                      |
| Flash Brightness       | `flashBrightness`            | slider | 0 … 1    | 0.01    |                                                                                                       |
| Flash Frequency        | `flashFrequency`             | slider | 0 … 1    | 0.51    |                                                                                                       |
| Distance Variation     | `distanceVariation`          | slider | 0 … 1    | 0.8     |                                                                                                       |
|                        |                              |        |          |         | _Spread between dimmer distant strikes and bright near strikes._                                      |
| Shadow Length Scale    | `shadowLengthScale`          | slider | 0.5 … 8  | 2       |                                                                                                       |
|                        |                              |        |          |         | _Multiplier on building shadow ray length during a strike (2–3 recommended)._                         |
| Shadow Smear Mul       | `shadowSmearScale`           | slider | 0.25 … 2 | 2       |                                                                                                       |
|                        |                              |        |          |         | _Scales BuildingShadowsEffectV2 smear/softness (1 = same as building pass)._                          |
| Window Flash Boost     | `windowFlashBoost`           | slider | 0 … 3    | 3       |                                                                                                       |
|                        |                              |        |          |         | _Legacy scale; peak multiplier below drives visible window punch._                                    |
| Window Peak Multiplier | `windowFlashPeakMultiplier`  | slider | 1 … 20   | 20      |                                                                                                       |
|                        |                              |        |          |         | _At full flash, window intensity ≈ this many× normal (9 ≈ 10×)._                                      |
| Outdoor Flash Strength | `outdoorFlashStrength`       | slider | 0 … 24   | 1       |                                                                                                       |
| Day Flash Scale        | `dayFlashBrightnessScale`    | slider | 0 … 1    | 0.2     |                                                                                                       |
|                        |                              |        |          |         | _Lightning brightness at solar noon._                                                                 |
| Dawn Flash Scale       | `dawnFlashBrightnessScale`   | slider | 0 … 1    | 0.28    |                                                                                                       |
|                        |                              |        |          |         | _Lightning brightness around the dawn phase (morning twilight)._                                      |
| Dusk Flash Scale       | `duskFlashBrightnessScale`   | slider | 0 … 1    | 0.28    |                                                                                                       |
|                        |                              |        |          |         | _Lightning brightness around the dusk phase (evening twilight)._                                      |
| Night Flash Scale      | `nightFlashBrightnessScale`  | slider | 0 … 2    | 0.33    |                                                                                                       |
|                        |                              |        |          |         | _Lightning brightness near midnight._                                                                 |
| Day Shadow Scale       | `dayStructuralShadowScale`   | slider | 0 … 1    | 0       |                                                                                                       |
|                        |                              |        |          |         | _Building/sky-reach shadow flash at noon. 0 keeps existing sun shadows; outdoor flash still applies._ |
| Night Shadow Scale     | `nightStructuralShadowScale` | slider | 0 … 1    | 0.44    |                                                                                                       |
|                        |                              |        |          |         | _Building/sky-reach shadow flash near midnight._                                                      |
| Twilight Blend (h)     | `twilightFlashBlendHours`    | slider | 0.5 … 6  | 2.5     |                                                                                                       |
|                        |                              |        |          |         | _How many hours dawn/dusk scales stay influential around their phase anchors._                        |
| Night Ramp Curve       | `dayNightFlashCurve`         | slider | 0.2 … 4  | 2.9     |                                                                                                       |
|                        |                              |        |          |         | _How sharply flash strength rises from twilight toward midnight._                                     |
| Shadow Blend Weight    | `shadowBlendWeight`          | slider | 0 … 1    | 0.98    |                                                                                                       |
| Shadow Fade Length     | `shadowFadeDurationScale`    | slider | 1 … 6    | 3.5     |                                                                                                       |
|                        |                              |        |          |         | _How much longer lightning shadows linger vs the light flash._                                        |
| Shadow Fade Softness   | `shadowFadeCurve`            | slider | 0.2 … 2  | 2       |                                                                                                       |
|                        |                              |        |          |         | _Lower = gentler shadow release at end of strike._                                                    |
| Shadow Flash Floor     | `lightningShadowFlashFloor`  | slider | 0 … 0.5  | 0       |                                                                                                       |
|                        |                              |        |          |         | _Minimum flash in deep shadow (lower = darker umbra during strike)._                                  |
| Flash Contrast         | `lightningFlashContrast`     | slider | 0 … 3    | 3       |                                                                                                       |
| Shadow Darkness        | `lightningShadowDarkness`    | slider | 1 … 4    | 4       |                                                                                                       |
|                        |                              |        |          |         | _Power curve on lightning shadow depth (>1 = darker)._                                                |
| Flash Color R          | `lightningFlashColorR`       | slider | 0 … 2    | 0.43    |                                                                                                       |
| Flash Color G          | `lightningFlashColorG`       | slider | 0 … 2    | 0.5     |                                                                                                       |
| Flash Color B          | `lightningFlashColorB`       | slider | 0 … 2    | 0.67    |                                                                                                       |
|                        |                              |        |          |         | _Cold lightning defaults ~0.43 / 0.50 / 0.67._                                                        |

### Flash Envelope _(advanced)_

| Control           | id                   | Type   | Range         | Default | Notes                                                                          |
| ----------------- | -------------------- | ------ | ------------- | ------- | ------------------------------------------------------------------------------ |
| Attack (ms)       | `flashAttackMs`      | slider | 0 … 80        | 0       |                                                                                |
| Flicker Hold (ms) | `flashFlickerHoldMs` | slider | 0 … 4000      | 1400    |                                                                                |
|                   |                      |        |               |         | _Peak brightness with flicker before the slow fade._                           |
| Fade Out (ms)     | `flashDecayMs`       | slider | 200 … 8000    | 3850    |                                                                                |
| Fade Curve        | `flashDecayCurve`    | slider | 0.25 … 4      | 1.31    |                                                                                |
| Flicker Amount    | `flashFlickerAmount` | slider | 0 … 1         | 0.17    |                                                                                |
|                   |                      |        |               |         | _How deep dips and surges modulate the peak hold._                             |
| Flicker Chaos     | `flashFlickerRate`   | slider | 0 … 40        | 40      |                                                                                |
|                   |                      |        |               |         | _Irregular pulse density during hold (higher = busier, more micro-variation)._ |
| Flash Clamp       | `flashMaxClamp`      | slider | 0 … 10        | 0       |                                                                                |
| Brightness Min    | `brightnessMin`      | slider | 0 … 1         | 0.68    |                                                                                |
| Brightness Max    | `brightnessMax`      | slider | 0 … 1         | 1       |                                                                                |
| Min Delay (ms)    | `minDelayMs`         | slider | 500 … 60000   | 500     |                                                                                |
| Max Delay (ms)    | `maxDelayMs`         | slider | 1000 … 120000 | 1000    |                                                                                |

### GM Triggers _(advanced)_

| Control      | id                    | Type   | Range | Default | Notes |
| ------------ | --------------------- | ------ | ----- | ------- | ----- |
| Small Strike | `triggerSmallStrike`  | button |       |         |       |
| Big Strike   | `triggerBigStrike`    | button |       |         |       |
| 30s Series   | `triggerStrikeSeries` | button |       |         |       |

### Ungrouped

| Control                | id                   | Type    | Range       | Default | Notes  |
| ---------------------- | -------------------- | ------- | ----------- | ------- | ------ |
| enabled                | `enabled`            | boolean |             | true    | hidden |
| Small Strike Fade (ms) | `smallStrikeDecayMs` | slider  | 200 … 6000  | 2400    | hidden |
| Big Strike Fade (ms)   | `bigStrikeDecayMs`   | slider  | 500 … 12000 | 4500    | hidden |
