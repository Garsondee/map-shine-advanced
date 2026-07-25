# Bloom (glow)

**V2 class:** `BloomEffectV2` · **Source:** `legacy/compositor-v2/effects/BloomEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Separable Gaussian mip-chain bloom — smooth gradients without Vogel-disk grain. Mip downscaling provides wide atmospheric reach.

No tile masks required. Runs after the main scene is composited (post-processing).

Surface and atmosphere share threshold, fog clip, water specular inject, and lightning adaptation — only strength, radius, tint, and mix are independent.

Water specular can feed a dedicated linear mask (see Water → Bloom link) so sun glints bloom strongly without over-brightening the base image.

During lightning strikes bloom can adapt automatically (Lightning strike folder) to avoid banded halos from broad HDR flash lifts.

Fog clip (advanced) uses the Fog of War vision mask so bloom cannot spill into unexplored or out-of-LOS areas.

Performance: one shared mip-chain blur; surface and atmosphere differ in composite weights only. Disable atmosphere or lower radii on weak GPUs.

Persistence: these controls save with the scene (not World Based).

## The knobs, in the author's words

- **Strength** — Surface glow intensity — tight halo on bright pixels (lamps, fire, specular).
- **Radius** — Surface glow spread (0–2). Small values stay near the source; 2 is a wide surface halo.
- **Threshold** — Brightness cutoff (linear). Only pixels above this contribute to bloom.
- **Glow tint** — Tint on the surface bloom layer.
- **Blend opacity** — Mix for the surface bloom layer.
- **Atmosphere enabled** — Wide secondary bloom from the same bright extract (air catching light).
- **Atmosphere strength** — Intensity of the wide atmospheric scatter.
- **Atmosphere radius** — Atmospheric spread (0–12). Much larger than surface — simulates air glow.
- **Atmosphere tint** — Tint on the atmospheric layer (warm dusk haze by default).
- **Atmosphere blend** — Mix for the atmospheric bloom layer.
- **Water bloom (specular)** — Adds linear HDR from water specular/highlight mask before threshold — strong glints without crushing the beauty pass.
- **Water bloom strength** — How much of the water mask is added into the bloom input (linear).
- **Water bloom gamma** — Curve on the injected mask (<1 = punchier peaks, >1 = softer).
- **Lightning adapt** — While distant or map-point lightning is active, bloom raises its cutoff and softens the knee so broad HDR flashes do not turn into banded halos.
- **Lightning threshold boost** — Extra linear cutoff added during strikes (keeps the flash wash out of bloom).
- **Lightning strength mul** — Bloom strength multiplier at full strike intensity (0 = off).
- **Lightning radius mul** — Bloom radius multiplier at full strike intensity.
- **Lightning smooth width** — Wider high-pass knee during strikes — reduces banding at the cutoff edge.
- **Lightning blend mul** — Overall bloom mix multiplier at full strike intensity.
- **Lightning passthrough peak** — Above this strike weight, bloom is skipped for one frame path (flash already reads as glow).
- **Lightning map-point weight** — How much localized arc flashes contribute to adaptation (lower keeps arc bloom).
- **Outdoor spill suppress** — Stops window-light bloom halos from washing onto dark outdoor ground around buildings (\_Outdoors mask).
- **Outdoor spill lum lo** — Outdoor pixels darker than threshold × this keep no spill bloom.
- **Outdoor spill lum hi** — Full outdoor bloom returns when base HDR exceeds threshold × this.
- **Fog clip** — Zeros HDR bloom input outside token line-of-sight before the blur runs, so in-fog lights cannot bleed into visible areas.

## Authored presets

`Clear Noon` · `Golden Hour` · `Overcast Day` · `Storm` · `Moonlit Night` · `Interior Night` · `Subtle` · `Strong` · `Dreamy` · `Neon`

## Controls, grouped as the author grouped them

### Surface

| Control          | id          | Type   | Range | Default | Notes                                                                                                                                                                                     |
| ---------------- | ----------- | ------ | ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface strength | `strength`  | slider | 0 … 3 | 1.08    |                                                                                                                                                                                           |
|                  |             |        |       |         | _Tight surface glow on bright pixels (hot source / specular)._                                                                                                                            |
| Surface radius   | `radius`    | slider | 0 … 2 | 1       |                                                                                                                                                                                           |
|                  |             |        |       |         | _Spread of the tight surface halo (0–2)._                                                                                                                                                 |
| Threshold        | `threshold` | slider | 0 … 4 | 3.01    |                                                                                                                                                                                           |
|                  |             |        |       |         | _Linear brightness floor; only brighter pixels bloom. With the Linear HDR pipeline the merged scene can exceed 1.0, so this range was extended — 1.0 means "only true highlights bloom"._ |

### Atmosphere

| Control             | id                 | Type    | Range  | Default                   | Notes                                                                            |
| ------------------- | ------------------ | ------- | ------ | ------------------------- | -------------------------------------------------------------------------------- |
| Atmosphere enabled  | `atmoEnabled`      | boolean |        | true                      |                                                                                  |
|                     |                    |         |        |                           | _Wide secondary bloom from the same bright pixels — air catching surface light._ |
| Atmosphere strength | `atmoStrength`     | slider  | 0 … 3  | 0.42                      |                                                                                  |
|                     |                    |         |        |                           | _Intensity of the wide atmospheric scatter._                                     |
| Atmosphere radius   | `atmoRadius`       | slider  | 0 … 12 | 3.5                       |                                                                                  |
|                     |                    |         |        |                           | _Atmospheric spread (0–12). Much wider than surface — haze and air glow._        |
| Atmosphere tint     | `atmoTintColor`    | color   |        | {"r":1,"g":0.92,"b":0.78} |                                                                                  |
|                     |                    |         |        |                           | _Tint on the atmospheric layer (warm haze by default)._                          |
| Atmosphere blend    | `atmoBlendOpacity` | slider  | 0 … 1  | 0.72                      |                                                                                  |
|                     |                    |         |        |                           | _Mix for the atmospheric bloom layer._                                           |

### Water specular (bloom) _(advanced)_

| Control              | id                           | Type    | Range    | Default | Notes                                                                                                  |
| -------------------- | ---------------------------- | ------- | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| Link water specular  | `waterSpecularBloomEnabled`  | boolean |          | true    |                                                                                                        |
|                      |                              |         |          |         | _When on (and water renders a mask), add water specular energy into the bloom input before threshold._ |
| Water bloom strength | `waterSpecularBloomStrength` | slider  | 0 … 8    | 8       |                                                                                                        |
|                      |                              |         |          |         | _Linear HDR added from the water specular mask. Push high for aggressive sun glints._                  |
| Water bloom gamma    | `waterSpecularBloomGamma`    | slider  | 0.35 … 3 | 0.81    |                                                                                                        |
|                      |                              |         |          |         | _Shapes the injected mask before bloom (1 = linear). Lower emphasizes peaks._                          |

### Surface grade

| Control       | id             | Type   | Range | Default             | Notes                              |
| ------------- | -------------- | ------ | ----- | ------------------- | ---------------------------------- |
| Surface tint  | `tintColor`    | color  |       | {"r":1,"g":1,"b":1} |                                    |
|               |                |        |       |                     | _Tint on the tight surface bloom._ |
| Surface blend | `blendOpacity` | slider | 0 … 1 | 1                   |                                    |
|               |                |        |       |                     | _Mix for the surface bloom layer._ |

### Lightning strike _(advanced)_

| Control                | id                              | Type    | Range      | Default | Notes                                                                                                        |
| ---------------------- | ------------------------------- | ------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| Adapt during strikes   | `lightningBloomAdaptEnabled`    | boolean |            | true    |                                                                                                              |
|                        |                                 |         |            |         | _Raise bloom cutoff and soften the high-pass knee while lightning flashes are active to avoid banded halos._ |
| Strike threshold boost | `lightningBloomThresholdBoost`  | slider  | 0 … 4      | 2       |                                                                                                              |
|                        |                                 |         |            |         | _Added to the linear threshold at full strike intensity — keeps broad flash wash out of bloom._              |
| Strike strength mul    | `lightningBloomStrengthMul`     | slider  | 0 … 1      | 0.3     |                                                                                                              |
|                        |                                 |         |            |         | _Bloom strength multiplier when a strike is at peak (flash already adds glow)._                              |
| Strike radius mul      | `lightningBloomRadiusMul`       | slider  | 0 … 1      | 0.55    |                                                                                                              |
|                        |                                 |         |            |         | _Bloom spread multiplier at full strike intensity — tighter blur reduces banding._                           |
| Strike smooth width    | `lightningBloomSmoothWidth`     | slider  | 0.05 … 1.5 | 0.45    |                                                                                                              |
|                        |                                 |         |            |         | _High-pass knee width during strikes (wider = softer cutoff, fewer bands)._                                  |
| Strike blend mul       | `lightningBloomBlendMul`        | slider  | 0 … 1      | 0.65    |                                                                                                              |
|                        |                                 |         |            |         | _Blend opacity multiplier at full strike intensity._                                                         |
| Passthrough peak       | `lightningBloomPassthroughPeak` | slider  | 0.5 … 1    | 0.88    |                                                                                                              |
|                        |                                 |         |            |         | _Skip bloom entirely above this strike weight — useful for the brightest flash peak._                        |
| Map-point adapt weight | `lightningBloomMapPointWeight`  | slider  | 0 … 1      | 0.15    |                                                                                                              |
|                        |                                 |         |            |         | _How much localized arc flashes affect adaptation (lower preserves arc bloom)._                              |

### Outdoor spill (window glow) _(advanced)_

| Control                    | id                            | Type    | Range      | Default | Notes                                                                                                           |
| -------------------------- | ----------------------------- | ------- | ---------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| Suppress outdoor spill     | `outdoorSpillSuppressEnabled` | boolean |            | true    |                                                                                                                 |
|                            |                               |         |            |         | _Remove bloom on dark outdoor pixels (\_Outdoors) so indoor window glow does not halo onto surrounding ground._ |
| Spill lum lo (× threshold) | `outdoorSpillLumLoMul`        | slider  | 0.05 … 1.5 | 0.42    |                                                                                                                 |
|                            |                               |         |            |         | _Outdoor pixels below threshold × this lose spilled bloom entirely._                                            |
| Spill lum hi (× threshold) | `outdoorSpillLumHiMul`        | slider  | 0.1 … 2    | 0.92    |                                                                                                                 |
|                            |                               |         |            |         | _Outdoor pixels above threshold × this keep full bloom (sun, torches, water glints)._                           |

### Fog clip (vision) _(advanced)_

| Control              | id               | Type    | Range | Default | Notes                                                                                                                 |
| -------------------- | ---------------- | ------- | ----- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| Clip to vision (FoW) | `fogClipEnabled` | boolean |       | true    |                                                                                                                       |
|                      |                  |         |       |         | _Mask bloom source pixels to current token LOS before blur — stops distant in-fog glow from leaking into seen areas._ |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | true    | hidden |
