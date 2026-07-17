# Metallic / specular (tile overlays)

**V2 class:** `SpecularEffectV2` · **Source:** `legacy/compositor-v2/effects/SpecularEffectV2.js`

**Rebuilt in V3 as:** `surface.response`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Draws **additive shine** on top of map tiles (and the scene background) wherever a matching **`_Specular`** texture exists beside the art.

Shimmer (micro-glint blobs), sparkles, rain wetness, frost, outdoor/cloud response, and Foundry lights all multiply into that mask — there is no separate PBR roughness or normal-map path.

Uses one overlay mesh per masked tile, rendered through the floor bus so level visibility stays correct.

Torch and flashlight from PlayerLightEffectV2 feed a separate analytic pass each frame (after player-light update). On multi-floor scenes they only add to specular overlays on the same floor band as the controlled token’s elevation.

Performance scales with how many `_Specular` overlays exist and how busy the shimmer/sparkle math is; heavy maps benefit from fewer shimmer layers or lower intensities.

Settings are stored on the scene (not World Based).

## The knobs, in the author's words

- **_Outdoors** — Whether an indoor/outdoor mask is bound (row under Enabled) — white = outdoor for shimmer and wet response.
- **_Specular** — Whether the scene found at least one `_Specular` texture after load (row under Enabled).
- **Intensity** — Overall strength of the shine pass.
- **Specular tint** — Color multiplied into highlights (white keeps the map neutral).
- **Mask colour saturation** — How much _Specular mask RGB tints highlights (0 = neutral white, 1 = full mask colour, up to 2 for extra punch).
- **World scale** — How large world-space shimmer patterns are — higher = bigger, calmer glint clusters.
- **Outdoor blend** — How much outdoor areas mix shimmer modulation with cloud-lit specular.
- **Wet surface** — Rain-driven sheen: albedo brightness gates where full-strength shimmer stripes appear (outdoor pixels only).
- **Building shadow suppression** — Pulls specular down where the building shadow map is dark.
- **Player light specular boost** — Scales analytic specular energy from the torch / flashlight ThreeLightSource pass (1 = match disk strength, higher = punchier highlights).

## Authored presets

`Gentle` · `Rainy sheen` · `Calmer shimmer`

## Controls, grouped as the author grouped them

### Look

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Intensity | `intensity` | slider | 0 … 2 | 1.23 |  |
| | | | | | _Master strength of the additive specular pass._ |
| Specular tint | `lightColor` | color |  | {"r":1,"g":1,"b":1} |  |
| | | | | | _Tint multiplied into specular highlights (linear 0–1 per channel)._ |
| Mask colour saturation | `specularMaskSaturation` | slider | 0 … 2 | 1 |  |
| | | | | | _How much _Specular mask RGB tints highlights. 0 = neutral white (legacy), 1 = full mask colour, up to 2 for extra chroma._ |
| Player light specular boost | `playerLightSpecularBoost` | slider | 1 … 2.5 | 1.2 |  |
| | | | | | _Extra strength where torch / flashlight (PlayerLightEffectV2) overlaps the floor specular pass. Uses the same world-space radii as the player light disks._ |

### Shimmer _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Shimmer on | `stripeEnabled` | boolean |  | true |  |
| | | | | | _Top-down micro-glint blobs and cellular shimmer modulate shine in world space._ |
| Layer blend | `stripeBlendMode` | list | Add / Multiply / Screen / Overlay | 0 |  |
| | | | | | _How shimmer layers 2–3 combine with layer 1._ |
| Parallax | `parallaxStrength` | slider | 0 … 2 | 1.5 |  |
| | | | | | _Subtle camera shift on shimmer coordinates (reduced vs legacy stripes)._ |
| Brightness gate | `stripeMaskThreshold` | slider | 0 … 1 | 0.45 |  |
| | | | | | _Shimmer only where the specular mask is brighter than this (reduces shine in dark mask areas)._ |
| World scale (px) | `worldPatternScale` | slider | 256 … 16384 | 16384 |  |
| | | | | | _Size of world-space shimmer pattern — larger values stretch glint clusters wider._ |

### Shimmer layer 1 _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| On | `stripe1Enabled` | boolean |  | true |  |
| Density | `stripe1Frequency` | slider | 0.5 … 20 | 11 |  |
| | | | | | _Glint cluster density along the grain axis._ |
| Speed | `stripe1Speed` | slider | -1 … 1 | 0 |  |
| | | | | | _Scroll speed along the grain (outdoors only when _Outdoors mask is bound)._ |
| Grain angle (°) | `stripe1Angle` | slider | 0 … 360 | 115 |  |
| | | | | | _Anisotropic grain direction in degrees._ |
| Cluster size | `stripe1Width` | slider | 0 … 1 | 0.59 |  |
| | | | | | _How large each bright glint cluster appears._ |
| Strength | `stripe1Intensity` | slider | 0 … 5 | 5 |  |
| | | | | | _How strong this layer is before blending._ |
| Parallax mix | `stripe1Parallax` | slider | -2 … 2 | 0.2 |  |
| | | | | | _Per-layer parallax weight vs global parallax._ |
| Scatter | `stripe1Wave` | slider | 0 … 2 | 1.7 |  |
| | | | | | _Per-cell rotation and UV warp to break regularity._ |
| Softness | `stripe1Gaps` | slider | 0 … 1 | 0.31 |  |
| | | | | | _Gaussian spread of each glint blob (higher = softer, wider)._ |
| Elongation | `stripe1Softness` | slider | 0 … 5 | 5 |  |
| | | | | | _Stretch ratio along the grain axis (brushed metal / wood)._ |

### Shimmer layer 2 _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| On | `stripe2Enabled` | boolean |  | true |  |
| Density | `stripe2Frequency` | slider | 0.5 … 20 | 15.5 |  |
| | | | | | _Glint cluster density along the grain axis._ |
| Speed | `stripe2Speed` | slider | -1 … 1 | 0 |  |
| | | | | | _Scroll speed along the grain (outdoors only when _Outdoors mask is bound)._ |
| Grain angle (°) | `stripe2Angle` | slider | 0 … 360 | 111 |  |
| | | | | | _Anisotropic grain direction in degrees._ |
| Cluster size | `stripe2Width` | slider | 0 … 1 | 0.49 |  |
| | | | | | _How large each bright glint cluster appears._ |
| Strength | `stripe2Intensity` | slider | 0 … 5 | 5 |  |
| | | | | | _How strong this layer is before blending._ |
| Parallax mix | `stripe2Parallax` | slider | -2 … 2 | 0.1 |  |
| | | | | | _Per-layer parallax weight vs global parallax._ |
| Scatter | `stripe2Wave` | slider | 0 … 2 | 1.6 |  |
| | | | | | _Per-cell rotation and UV warp to break regularity._ |
| Softness | `stripe2Gaps` | slider | 0 … 1 | 0.5 |  |
| | | | | | _Gaussian spread of each glint blob (higher = softer, wider)._ |
| Elongation | `stripe2Softness` | slider | 0 … 5 | 5 |  |
| | | | | | _Stretch ratio along the grain axis (brushed metal / wood)._ |

### Shimmer layer 3 _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| On | `stripe3Enabled` | boolean |  | true |  |
| Density | `stripe3Frequency` | slider | 0.5 … 20 | 5 |  |
| | | | | | _Glint cluster density along the grain axis._ |
| Speed | `stripe3Speed` | slider | -1 … 1 | 0 |  |
| | | | | | _Scroll speed along the grain (outdoors only when _Outdoors mask is bound)._ |
| Grain angle (°) | `stripe3Angle` | slider | 0 … 360 | 162 |  |
| | | | | | _Anisotropic grain direction in degrees._ |
| Cluster size | `stripe3Width` | slider | 0 … 1 | 0.61 |  |
| | | | | | _How large each bright glint cluster appears._ |
| Strength | `stripe3Intensity` | slider | 0 … 5 | 5 |  |
| | | | | | _How strong this layer is before blending._ |
| Parallax mix | `stripe3Parallax` | slider | -2 … 2 | -0.1 |  |
| | | | | | _Per-layer parallax weight vs global parallax._ |
| Scatter | `stripe3Wave` | slider | 0 … 2 | 0.4 |  |
| | | | | | _Per-cell rotation and UV warp to break regularity._ |
| Softness | `stripe3Gaps` | slider | 0 … 1 | 0.37 |  |
| | | | | | _Gaussian spread of each glint blob (higher = softer, wider)._ |
| Elongation | `stripe3Softness` | slider | 0 … 5 | 5 |  |
| | | | | | _Stretch ratio along the grain axis (brushed metal / wood)._ |

### Micro sparkle _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Sparkle on | `sparkleEnabled` | boolean |  | false |  |
| | | | | | _Tiny glints on top of shimmer modulation._ |
| Strength | `sparkleIntensity` | slider | 0 … 2 | 0.95 |  |
| | | | | | _Brightness of sparkle cells._ |
| Density | `sparkleScale` | slider | 100 … 10000 | 2460 |  |
| | | | | | _Higher = smaller, busier sparkles._ |
| Twinkle speed | `sparkleSpeed` | slider | 0 … 5 | 1.38 |  |
| | | | | | _How fast sparkles blink._ |

### Outdoor & clouds

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Cloud specular | `outdoorCloudSpecularEnabled` | boolean |  | true |  |
| | | | | | _Brighten outdoor specular where the cloud shadow map says “lit”. Requires cloud shadows from the cloud effect._ |
| Outdoor shimmer mix | `outdoorStripeBlend` | slider | 0 … 1 | 0.31 |  |
| | | | | | _How much `_Outdoors` reduces shimmer modulation (outdoor areas stay punchier)._ |
| Cloud lit boost | `cloudSpecularIntensity` | slider | 0 … 3 | 1 |  |
| | | | | | _Extra additive specular on sunlit outdoor pixels from the cloud pass._ |

### Wet surface (rain)

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Wet sheen | `wetSpecularEnabled` | boolean |  | true |  |
| | | | | | _Rain wetness gates shimmer stripes on bright outdoor albedo highlights._ |
| Input lift | `wetInputBrightness` | slider | -0.5 … 0.5 | -0.09 |  |
| | | | | | _Brightness bias before wet mask extraction._ |
| Input gamma | `wetInputGamma` | slider | 0.1 … 3 | 0.77 |  |
| | | | | | _Gamma on albedo grayscale before contrast._ |
| Input contrast | `wetSpecularContrast` | slider | 1 … 10 | 1 |  |
| | | | | | _Contrast after whiteness gate — higher isolates brighter albedo highlights._ |
| Black point | `wetBlackPoint` | slider | 0 … 1 | 0 |  |
| | | | | | _Only albedo highlights above this level receive rain sheen._ |
| White point | `wetWhitePoint` | slider | 0 … 1 | 1 |  |
| | | | | | _Ceiling for wet mask smoothstep._ |
| Wet strength | `wetSpecularIntensity` | slider | 0 … 5 | 2.3 |  |
| | | | | | _How bright the wet layer is after processing._ |
| Wet clamp | `wetOutputMax` | slider | 0 … 3 | 0.07 |  |
| | | | | | _Peak cap on wet specular RGB (scales down proportionally to preserve shimmer contrast)._ |
| Wet output gamma | `wetOutputGamma` | slider | 0.1 … 3 | 3 |  |
| | | | | | _Gamma before peak cap (1 = linear)._ |
| Outdoor baseline | `wetBaseSheen` | slider | 0 … 2 | 0 |  |
| | | | | | _Uniform wet shimmer add-on outdoors (still gated by wet mask)._ |
| Wind ripple | `wetWindRippleStrength` | slider | 0 … 3 | 1 |  |
| | | | | | _Worley caustic pools on wet outdoor surfaces, advected by wind._ |

### Frost / ice _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Frost on | `frostGlazeEnabled` | boolean |  | true |  |
| | | | | | _Ice glaze on specular when freeze level passes the threshold._ |
| Freeze threshold | `frostThreshold` | slider | 0 … 1 | 0.55 |  |
| | | | | | _Weather freeze level must pass this before frost ramps in._ |
| Frost strength | `frostIntensity` | slider | 0 … 3 | 1.2 |  |
| | | | | | _Brightness of the frost pass._ |
| Blue tint | `frostTintStrength` | slider | 0 … 1 | 0.4 |  |
| | | | | | _How icy-blue the frost appears._ |

### Dynamic light tint _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Tint from lights | `dynamicLightTintEnabled` | boolean |  | true |  |
| | | | | | _Shift specular tint toward the strongest nearby Foundry light color._ |
| Tint mix | `dynamicLightTintStrength` | slider | 0 … 1 | 0.65 |  |
| | | | | | _How far specular tint follows dynamic lights vs the base tint above._ |

### Wind-linked shimmer _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Wind-linked motion | `windDrivenStripesEnabled` | boolean |  | true |  |
| | | | | | _Integrates weather wind: shifts shimmer UVs outdoors and advects wet caustic pools._ |
| Wind amount | `windStripeInfluence` | slider | 0 … 1 | 0.5 |  |
| | | | | | _Scales accumulated wind drift on outdoor shimmer and wet caustics._ |

### Building shadow suppression _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Suppress in shadow | `buildingShadowSuppressionEnabled` | boolean |  | true |  |
| | | | | | _Reduce specular where the building shadow map is dark._ |
| Shadow mix | `buildingShadowSuppressionStrength` | slider | 0 … 1 | 0.8 |  |
| | | | | | _How strongly building shadows multiply specular down._ |
