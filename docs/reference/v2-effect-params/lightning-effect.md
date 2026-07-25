# LightningEffectV2

**V2 class:** `LightningEffectV2` · **Source:** `legacy/compositor-v2/effects/LightningEffectV2.js`

**Rebuilt in V3 as:** `light.accumulate`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Timing _(advanced)_

| Control              | id                 | Type   | Range      | Default | Notes                                                                                     |
| -------------------- | ------------------ | ------ | ---------- | ------- | ----------------------------------------------------------------------------------------- |
| Min Delay (ms)       | `minDelayMs`       | slider | 0 … 5000   | 5000    |                                                                                           |
| Max Delay (ms)       | `maxDelayMs`       | slider | 0 … 10000  | 10000   |                                                                                           |
| Restrikes Min        | `burstMinStrikes`  | slider | 1 … 10     | 7       |                                                                                           |
|                      |                    |        |            |         | _Minimum rapid flashes along the same plasma channel per burst._                          |
| Restrikes Max        | `burstMaxStrikes`  | slider | 1 … 16     | 16      |                                                                                           |
|                      |                    |        |            |         | _Maximum rapid flashes along the same plasma channel per burst._                          |
| Strike Duration (ms) | `strikeDurationMs` | slider | 20 … 2400  | 1000    |                                                                                           |
| Leader Phase         | `leaderFraction`   | slider | 0.1 … 0.35 | 0.15    |                                                                                           |
|                      |                    |        |            |         | _Fraction of strike duration spent searching downward before the return stroke connects._ |
| Flicker Chance       | `flickerChance`    | slider | 0 … 1      | 0.15    |                                                                                           |

### Look

| Control              | id                   | Type   | Range                           | Default                               | Notes                                                                                             |
| -------------------- | -------------------- | ------ | ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Outer Color          | `outerColor`         | color  |                                 | {"r":0,"g":0.21440094753601224,"b":1} |                                                                                                   |
| Core Color           | `coreColor`          | color  |                                 | {"r":1,"g":1,"b":1}                   |                                                                                                   |
| Brightness           | `brightness`         | slider | 0 … 10                          | 5                                     |                                                                                                   |
| Width (px-ish)       | `width`              | slider | 1 … 120                         | 30                                    |                                                                                                   |
| Taper                | `taper`              | slider | 0 … 1                           | 0.08                                  |                                                                                                   |
| Glow Strength        | `glowStrength`       | slider | 0 … 5                           | 5                                     |                                                                                                   |
| Z Offset             | `zOffset`            | slider | 0 … 50                          | 0                                     |                                                                                                   |
| Overhead Order       | `overheadOrder`      | list   | Below Overhead / Above Overhead | 0                                     |                                                                                                   |
|                      |                      |        |                                 |                                       | _Always draws above tokens. Below Overhead = under roof tiles; Above Overhead = top motion band._ |
| Texture Scroll Speed | `textureScrollSpeed` | slider | 0 … 30                          | 25                                    |                                                                                                   |
| Core Static Amount   | `coreStaticAmount`   | slider | 0 … 2                           | 1                                     |                                                                                                   |
|                      |                      |        |                                 |                                       | _Crackling sparkle intensity on the bright core near the bolt base._                              |
| Core Static Range    | `coreStaticRange`    | slider | 0.15 … 0.85                     | 0.85                                  |                                                                                                   |
|                      |                      |        |                                 |                                       | _How far along the bolt (from base) the core static reaches._                                     |
| Wind Drift           | `windDriftStrength`  | slider | 0 … 1.5                         | 0                                     |                                                                                                   |
|                      |                      |        |                                 |                                       | _Slow plasma ribbon drift after the return stroke connects._                                      |

### Shape _(advanced)_

| Control                | id                     | Type   | Range      | Default | Notes                                                                                         |
| ---------------------- | ---------------------- | ------ | ---------- | ------- | --------------------------------------------------------------------------------------------- |
| Segments               | `segments`             | slider | 4 … 96     | 96      |                                                                                               |
| Curve Amount           | `curveAmount`          | slider | 0 … 1      | 0.57    |                                                                                               |
| Fractal Chaos          | `macroDisplacement`    | slider | 0 … 400    | 96      |                                                                                               |
|                        |                        |        |            |         | _Root zigzag strength relative to bolt length. Values tuned for midpoint-displacement paths._ |
| Micro Jitter           | `microJitter`          | slider | 0 … 120    | 3       |                                                                                               |
| Endpoint Randomness    | `endPointRandomnessPx` | slider | 0 … 400    | 5       |                                                                                               |
| Branch Angle           | `branchAngleDeg`       | slider | 15 … 60    | 45      |                                                                                               |
|                        |                        |        |            |         | _Acute fork angle off the parent channel tangent._                                            |
| Branch Chance          | `branchChance`         | slider | 0 … 1      | 1       |                                                                                               |
| Branch Max             | `branchMax`            | slider | 0 … 6      | 6       |                                                                                               |
| Branch Length Min      | `branchLengthMin`      | slider | 0.05 … 1   | 0.17    |                                                                                               |
| Branch Length Max      | `branchLengthMax`      | slider | 0.05 … 1.5 | 0.52    |                                                                                               |
| Branch Width Scale     | `branchWidthScale`     | slider | 0.05 … 1   | 0.52    |                                                                                               |
| Branch Intensity Scale | `branchIntensityScale` | slider | 0.05 … 1   | 0.82    |                                                                                               |
| Branch Duration Scale  | `branchDurationScale`  | slider | 0.1 … 1    | 0.79    |                                                                                               |
| Wild Arc Chance        | `wildArcChance`        | slider | 0 … 1      | 0       |                                                                                               |

### Outside Flash

| Control        | id                          | Type    | Range     | Default | Notes |
| -------------- | --------------------------- | ------- | --------- | ------- | ----- |
| Flash Enabled  | `outsideFlashEnabled`       | boolean |           | true    |       |
| Flash Gain     | `outsideFlashGain`          | slider  | 0 … 5     | 1.09    |       |
| Attack (ms)    | `outsideFlashAttackMs`      | slider  | 0 … 150   | 111     |       |
| Decay (ms)     | `outsideFlashDecayMs`       | slider  | 50 … 2500 | 650     |       |
| Decay Curve    | `outsideFlashCurve`         | slider  | 0.25 … 4  | 1.6     |       |
| Flicker Amount | `outsideFlashFlickerAmount` | slider  | 0 … 1     | 0.21    |       |
| Flicker Rate   | `outsideFlashFlickerRate`   | slider  | 0 … 40    | 0.6     |       |
| Flash Clamp    | `outsideFlashMaxClamp`      | slider  | 0 … 10    | 2       |       |

### Origin Flash Light _(advanced)_

| Control                 | id                                | Type    | Range                                  | Default | Notes                                                                                             |
| ----------------------- | --------------------------------- | ------- | -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| Enabled                 | `originFlashEnabled`              | boolean |                                        | true    |                                                                                                   |
|                         |                                   |         |                                        |         | _Localized LightMesh at the strike origin that punches through darkness like candle glow._        |
| Anchor Point            | `originFlashAnchor`               | list    | Bolt Start / Strike Impact / Both Ends | 0       |                                                                                                   |
|                         |                                   |         |                                        |         | _World point(s) where the origin flash light is placed along the bolt path._                      |
| Radius (px)             | `originFlashRadiusPx`             | slider  | 40 … 2400                              | 40      |                                                                                                   |
| Radius Strike Scale     | `originFlashRadiusStrikeScale`    | slider  | 0 … 1.5                                | 0.48    |                                                                                                   |
|                         |                                   |         |                                        |         | _How much brighter/larger strikes expand the flash radius._                                       |
| Inner Radius Scale      | `originFlashInnerRadiusScale`     | slider  | 0.05 … 0.6                             | 0.05    |                                                                                                   |
| Light Intensity         | `originFlashIntensity`            | slider  | 0 … 4                                  | 1.62    |                                                                                                   |
| Strike Intensity Scale  | `originFlashStrikeScale`          | slider  | 0 … 3                                  | 0.73    |                                                                                                   |
|                         |                                   |         |                                        |         | _Scales the flash with each bolt's map-point intensity envelope._                                 |
| Darkness Cancel         | `originFlashDarknessCancel`       | slider  | 0 … 12                                 | 0.95    |                                                                                                   |
|                         |                                   |         |                                        |         | _HDR emission gain driving compose darkness punch (higher = cuts darkness harder)._               |
| Night Cancel Boost      | `originFlashDarknessNightBoost`   | slider  | 1 … 4                                  | 1.6     |                                                                                                   |
| Follow Point Light Gain | `originFlashFollowPointLightGain` | boolean |                                        | true    |                                                                                                   |
| Edge Attenuation        | `originFlashAttenuation`          | slider  | 0.05 … 1                               | 1       |                                                                                                   |
| Hot Core Mix            | `originFlashHotMix`               | slider  | 0 … 1                                  | 0.81    |                                                                                                   |
|                         |                                   |         |                                        |         | _Blend bolt colors toward white-hot at peak intensity._                                           |
| Leader Precursor        | `originFlashLeaderPrecursor`      | slider  | 0 … 0.5                                | 0.37    |                                                                                                   |
|                         |                                   |         |                                        |         | _Dim origin glow while the stepped leader is still searching._                                    |
| Flicker Amount          | `originFlashFlickerAmount`        | slider  | 0 … 1                                  | 0.87    |                                                                                                   |
| Flicker Rate            | `originFlashFlickerRate`          | slider  | 0 … 40                                 | 1       |                                                                                                   |
| Min Visible Gain        | `originFlashMinGain`              | slider  | 0 … 0.5                                | 0.04    |                                                                                                   |
| Wall Clip               | `originFlashWallClipEnabled`      | boolean |                                        | true    |                                                                                                   |
|                         |                                   |         |                                        |         | _Clip origin flash to wall line-of-sight (prevents light bleeding through walls)._                |
| Clip Radius Scale       | `originFlashWallClipRadiusScale`  | slider  | 0.1 … 2                                | 0.33    |                                                                                                   |
|                         |                                   |         |                                        |         | _Radius used for wall polygon raycast (can differ from visual radius)._                           |
| Wall Padding (px)       | `originFlashWallPaddingPx`        | slider  | 0 … 240                                | 1       |                                                                                                   |
|                         |                                   |         |                                        |         | _Expands blocking walls outward so light does not leak through thin geometry._                    |
| Allow Window Light      | `originFlashAllowWindows`         | boolean |                                        | false   |                                                                                                   |
|                         |                                   |         |                                        |         | _When enabled, uses Foundry light rules so flashes can pass through windows but not solid walls._ |

### Audio _(advanced)_

| Control           | id                | Type    | Range | Default | Notes |
| ----------------- | ----------------- | ------- | ----- | ------- | ----- |
| Audio Enabled     | `audioEnabled`    | boolean |       | false   |       |
| Strike Sound Path | `audioStrikePath` | string  |       |         |       |
| Volume            | `audioVolume`     | slider  | 0 … 1 | 0.7     |       |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | true    | hidden |
