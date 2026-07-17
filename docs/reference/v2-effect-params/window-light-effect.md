# Window Light

**V2 class:** `WindowLightEffectV2` · **Source:** `legacy/compositor-v2/effects/WindowLightEffectV2.js`

**Rebuilt in V3 as:** `light.accumulate`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Emissive window glow from _Windows masks (scene UV, per-floor stack); legacy _Structural is supported and shown on the texture row when that is what loads.

_Outdoors marks roofed vs open sky (same mask Specular uses for outdoor gating).

Glass Refraction splits R/G/B mask samples for prismatic window fringes; Sparkle & Glint adds animated highlights (_Specular mask).

Rain on Glass uses precipitation plus the _Outdoors edge gradient to steer water along plausible wall-facing directions.

Cloud dimming ties window glow to overcast weather and cloud shadow maps.

Time-of-day timeline uses the same eight clock anchors as Camera Grade.

## Controls, grouped as the author grouped them

### Window Light

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Intensity | `intensity` | slider | 0 … 20 | 1 |  |
| | | | | | _Window glow strength — multiplicative brighten (1 + light), not flat overlay._ |
| Falloff (Gamma) | `falloff` | slider | 0.5 … 5 | 1 |  |
| Light Color | `color` | color |  | {"r":1,"g":1,"b":1} |  |

### Glass Refraction

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Glass Refraction | `glassRefractionEnabled` | boolean |  | true |  |
| | | | | | _Per-channel mask RGB shift for prismatic window fringes. Set RGB Shift to 0 to disable fringes while leaving this on._ |
| RGB Shift (px) | `rgbShiftAmount` | slider | 0 … 16 | 12.89 |  |
| | | | | | _Chromatic offset in mask texels along the shift angle._ |
| RGB Shift Softness | `rgbShiftSoftness` | slider | 0 … 1 | 0 |  |
| | | | | | _Blends prismatic fringes toward neutral window glow (0 = full chromatic split, 1 = soft/monochrome)._ |
| Shift Angle (deg) | `rgbShiftAngle` | slider | 0 … 360 | 30 |  |
| Spectral Spread | `rgbShiftSpread` | slider | 0 … 1 | 0.46 |  |
| | | | | | _Widens R vs B separation (0 = symmetric)._ |
| Edge Fringe Weight | `rgbShiftEdgeWeight` | slider | 0 … 1 | 1 |  |
| | | | | | _1 = chromatic shift strongest on mask edges (pane borders)._ |
| Fringe Saturation | `rgbFringeSaturation` | slider | 0 … 3 | 1 |  |
| Fringe RGB Balance | `rgbFringeBalance` | color |  | {"r":1,"g":1,"b":1} |  |
| | | | | | _Per-channel multiplier on chromatic fringe before falloff._ |

### Refraction Animation _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Animate Refraction | `rgbShiftAnimate` | boolean |  | true |  |
| Animation Speed | `rgbShiftAnimSpeed` | slider | 0 … 3 | 0.45 |  |
| Angle Wobble (deg) | `rgbShiftAnimWobbleDeg` | slider | 0 … 90 | 28 |  |
| | | | | | _Peak swing of refraction angle while animated. Higher = more visible rainbow drift._ |

### Rain on Glass

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Rain on Glass | `rainGlassEnabled` | boolean |  | true |  |
| | | | | | _Weather-driven procedural water streaks that refract window mask samples._ |
| Weather Response | `rainGlassWeatherResponse` | slider | 0 … 2 | 1 |  |
| | | | | | _Multiplier for precipitation intensity before it drives glass distortion._ |
| Distortion Strength | `rainGlassStrength` | slider | 0 … 0.15 | 0.045 |  |
| | | | | | _How far water droplets warp the window mask UVs._ |
| Drop Scale | `rainGlassScale` | slider | 8 … 240 | 90 |  |
| | | | | | _Higher values make smaller, denser droplets. Lower values make larger streaks._ |
| Streak Stretch | `rainGlassStretch` | slider | 0.05 … 1 | 0.25 |  |
| | | | | | _Lower values elongate drops along the flow direction._ |
| Flow Speed | `rainGlassSpeed` | slider | 0 … 4 | 1.2 |  |
| | | | | | _How quickly the procedural droplets slide across the pane._ |
| Wall Slope Influence | `rainGlassSlopeInfluence` | slider | 0 … 1 | 0.85 |  |
| | | | | | _0 = fallback direction only; 1 = follow the local _Outdoors gradient around building edges._ |
| Slope Sample Radius | `rainGlassSlopeSamplePx` | slider | 1 … 160 | 42 |  |
| | | | | | _How far from each window pixel to sample the _Outdoors mask when estimating wall direction. Larger values smooth diagonal and thick-wall cases._ |
| Fallback Direction (deg) | `rainGlassFallbackAngle` | slider | 0 … 360 | 90 |  |
| | | | | | _Flow direction used when the _Outdoors/window gradient is too flat. 0 = left to right, 90 = top to bottom._ |

### Sparkle & Glint

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Sparkle Enabled | `sparkleEnabled` | boolean |  | true |  |
| Sparkle Strength | `sparkleStrength` | slider | 0 … 5 | 1.35 |  |
| Sparkle Speed | `sparkleSpeed` | slider | 0 … 4 | 1.2 |  |
| | | | | | _Twinkle rate and how fast spawn locations shuffle (higher = quicker repopulation). Glints do not drift on the map._ |
| Sparkle Density | `sparkleScale` | slider | 12 … 120 | 38 |  |
| | | | | | _Glint cells across the visible camera view (not the whole map). Higher = more sparkles in what you see. Lower = fewer, larger gaps._ |
| Sparkle Core Threshold | `sparkleThreshold` | slider | 0 … 1 | 0.12 |  |
| Sparkle Edge Bias | `sparkleEdgeBias` | slider | 0 … 1 | 0.72 |  |
| | | | | | _0 = bright mask cores; 1 = pane edges._ |
| Sparkle Tint | `sparkleColor` | color |  | {"r":1,"g":0.98,"b":0.92} |  |
| Specular Boost | `specularBoost` | slider | 0 … 5 | 2 |  |
| | | | | | _Multiplies emit where _Specular mask is bright._ |

### Lightning on Windows _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Lightning Coupling | `lightningWindowEnabled` | boolean |  | true |  |
| Flash Intensity Boost | `lightningWindowIntensityBoost` | slider | 0 … 5 | 5 |  |
| Flash Contrast Boost | `lightningWindowContrastBoost` | slider | 0 … 4 | 4 |  |
| Flash RGB Shift Boost | `lightningWindowRgbBoost` | slider | 0 … 3 | 3 |  |

### Environment

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Cloud Dimming | `cloudInfluence` | slider | 0 … 1 | 1 |  |
| | | | | | _How much overcast weather and cloud shadows dim window glow (0 = ignore clouds)._ |

### Cloud Shadows

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Shadow Contrast | `cloudShadowContrast` | slider | 0 … 4 | 4 |  |
| Shadow Bias | `cloudShadowBias` | slider | -1 … 1 | -1 |  |
| Shadow Gamma | `cloudShadowGamma` | slider | 0.1 … 4 | 4 |  |
| Min Light | `cloudShadowMinLight` | slider | 0 … 1 | 0 |  |

### Time-of-day window light _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Enable time-of-day timeline | `todTimelineEnabled` | boolean |  | true |  |
| | | | | | _Blends eight clock anchors as Map Shine time advances. Adjusts window glow intensity, exposure, saturation, and tint per anchor._ |
| Use Camera Grade anchor hours | `useCameraGradeAnchorHours` | boolean |  | true |  |
| | | | | | _When enabled, blend points follow Camera Grade clock-hour sliders instead of the local hour sliders below._ |

### Noon (~12:00) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clock hour | `tod4Hour` | slider | 0 … 24 | 12 |  |
| | | | | | _When the scene clock is near this anchor (12:00 by default). Ignored when "Use Camera Grade anchor hours" is on._ |
| Intensity scale | `tod4IntensityScale` | slider | 0 … 3 | 3 |  |
| | | | | | _Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider._ |
| Exposure | `tod4Exposure` | slider | -3 … 3 | 0.15 |  |
| | | | | | _Exposure in stops for window glow at this anchor._ |
| Saturation | `tod4Saturation` | slider | 0 … 2 | 1.55 |  |
| | | | | | _Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes._ |
| Tint R | `tod4TintR` | slider | 0 … 3 | 0.8 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint G | `tod4TintG` | slider | 0 … 3 | 0.95 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint B | `tod4TintB` | slider | 0 … 3 | 1.35 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |

### Afternoon (~15:00) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clock hour | `tod5Hour` | slider | 0 … 24 | 15 |  |
| | | | | | _When the scene clock is near this anchor (15:00 by default). Ignored when "Use Camera Grade anchor hours" is on._ |
| Intensity scale | `tod5IntensityScale` | slider | 0 … 3 | 1.12 |  |
| | | | | | _Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider._ |
| Exposure | `tod5Exposure` | slider | -3 … 3 | 0.12 |  |
| | | | | | _Exposure in stops for window glow at this anchor._ |
| Saturation | `tod5Saturation` | slider | 0 … 2 | 1.6 |  |
| | | | | | _Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes._ |
| Tint R | `tod5TintR` | slider | 0 … 3 | 1.3 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint G | `tod5TintG` | slider | 0 … 3 | 1.05 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint B | `tod5TintB` | slider | 0 … 3 | 1 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |

### Dusk (~18:00) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clock hour | `tod6Hour` | slider | 0 … 24 | 18 |  |
| | | | | | _When the scene clock is near this anchor (18:00 by default). Ignored when "Use Camera Grade anchor hours" is on._ |
| Intensity scale | `tod6IntensityScale` | slider | 0 … 3 | 0.5 |  |
| | | | | | _Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider._ |
| Exposure | `tod6Exposure` | slider | -3 … 3 | 0.3 |  |
| | | | | | _Exposure in stops for window glow at this anchor._ |
| Saturation | `tod6Saturation` | slider | 0 … 2 | 1.8 |  |
| | | | | | _Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes._ |
| Tint R | `tod6TintR` | slider | 0 … 3 | 3 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint G | `tod6TintG` | slider | 0 … 3 | 1.2 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint B | `tod6TintB` | slider | 0 … 3 | 0.9 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |

### Night (~21:00) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clock hour | `tod7Hour` | slider | 0 … 24 | 21 |  |
| | | | | | _When the scene clock is near this anchor (21:00 by default). Ignored when "Use Camera Grade anchor hours" is on._ |
| Intensity scale | `tod7IntensityScale` | slider | 0 … 3 | 0.5 |  |
| | | | | | _Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider._ |
| Exposure | `tod7Exposure` | slider | -3 … 3 | 0.1 |  |
| | | | | | _Exposure in stops for window glow at this anchor._ |
| Saturation | `tod7Saturation` | slider | 0 … 2 | 2 |  |
| | | | | | _Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes._ |
| Tint R | `tod7TintR` | slider | 0 … 3 | 0.65 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint G | `tod7TintG` | slider | 0 … 3 | 0.7 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint B | `tod7TintB` | slider | 0 … 3 | 2.15 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |

### Midnight (~00:00) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clock hour | `tod0Hour` | slider | 0 … 24 | 0 |  |
| | | | | | _When the scene clock is near this anchor (00:00 by default). Ignored when "Use Camera Grade anchor hours" is on._ |
| Intensity scale | `tod0IntensityScale` | slider | 0 … 3 | 0.98 |  |
| | | | | | _Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider._ |
| Exposure | `tod0Exposure` | slider | -3 … 3 | -1.04 |  |
| | | | | | _Exposure in stops for window glow at this anchor._ |
| Saturation | `tod0Saturation` | slider | 0 … 2 | 1.85 |  |
| | | | | | _Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes._ |
| Tint R | `tod0TintR` | slider | 0 … 3 | 0 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint G | `tod0TintG` | slider | 0 … 3 | 0.72 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint B | `tod0TintB` | slider | 0 … 3 | 3 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |

### Pre-dawn (~03:00) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clock hour | `tod1Hour` | slider | 0 … 24 | 3 |  |
| | | | | | _When the scene clock is near this anchor (03:00 by default). Ignored when "Use Camera Grade anchor hours" is on._ |
| Intensity scale | `tod1IntensityScale` | slider | 0 … 3 | 0.5 |  |
| | | | | | _Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider._ |
| Exposure | `tod1Exposure` | slider | -3 … 3 | 0.05 |  |
| | | | | | _Exposure in stops for window glow at this anchor._ |
| Saturation | `tod1Saturation` | slider | 0 … 2 | 1.55 |  |
| | | | | | _Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes._ |
| Tint R | `tod1TintR` | slider | 0 … 3 | 1.4 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint G | `tod1TintG` | slider | 0 … 3 | 0.85 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint B | `tod1TintB` | slider | 0 … 3 | 2.3 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |

### Dawn (~06:00) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clock hour | `tod2Hour` | slider | 0 … 24 | 6 |  |
| | | | | | _When the scene clock is near this anchor (06:00 by default). Ignored when "Use Camera Grade anchor hours" is on._ |
| Intensity scale | `tod2IntensityScale` | slider | 0 … 3 | 0.5 |  |
| | | | | | _Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider._ |
| Exposure | `tod2Exposure` | slider | -3 … 3 | 0.25 |  |
| | | | | | _Exposure in stops for window glow at this anchor._ |
| Saturation | `tod2Saturation` | slider | 0 … 2 | 1.75 |  |
| | | | | | _Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes._ |
| Tint R | `tod2TintR` | slider | 0 … 3 | 3 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint G | `tod2TintG` | slider | 0 … 3 | 1.15 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint B | `tod2TintB` | slider | 0 … 3 | 0.85 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |

### Morning (~09:00) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clock hour | `tod3Hour` | slider | 0 … 24 | 9 |  |
| | | | | | _When the scene clock is near this anchor (09:00 by default). Ignored when "Use Camera Grade anchor hours" is on._ |
| Intensity scale | `tod3IntensityScale` | slider | 0 … 3 | 1.15 |  |
| | | | | | _Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider._ |
| Exposure | `tod3Exposure` | slider | -3 … 3 | 0.2 |  |
| | | | | | _Exposure in stops for window glow at this anchor._ |
| Saturation | `tod3Saturation` | slider | 0 … 2 | 1.65 |  |
| | | | | | _Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes._ |
| Tint R | `tod3TintR` | slider | 0 … 3 | 1.45 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint G | `tod3TintG` | slider | 0 … 3 | 1.2 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |
| Tint B | `tod3TintB` | slider | 0 … 3 | 0.95 |  |
| | | | | | _Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour._ |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| hasWindowMask | `hasWindowMask` | boolean |  | true | hidden |
