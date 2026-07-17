# Bush canopy (_Bush masks)

**V2 class:** `BushEffectV2` · **Source:** `legacy/compositor-v2/effects/BushEffectV2.js`

**Rebuilt in V3 as:** `geometry.world (billboards)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Animates **foliage-style motion** on tiles (and the scene background) that ship a matching **`_Bush`** texture next to the art.

Weather **wind** drives gusts, traveling waves, rigid bulk sway (per-island geometry), and leaf flutter. **Sun direction** (Foundry time or WeatherController) offsets a soft **canopy shadow** sample in the shader.

One overlay per masked tile, registered on the floor bus so level visibility stays correct.

Cost scales with overlay count; heavy motion uses more fragment work (shadow taps + distortion).

Settings save with the scene (not World Based).

## The knobs, in the author's words

- **Texture** — Whether the scene found at least one `_Bush` texture after load (row under Enabled).
- **Intensity** — Overall strength of the bush layer (alpha and shadow contribution).
- **Wind responsiveness** — How quickly the effect catches up when scene wind speed changes.
- **Rustle floor** — Minimum motion when wind reads calm so bushes never look frozen.
- **Canopy shadow** — Darkening from a blurred, offset sample of the mask opposite the sun.
- **Cloud shadows** — Screen-space darkening from the cloud shadow map (same pass as ground tiles).
- **Building shadows** — Scene-space darkening from BuildingShadowsEffectV2 (matches ground structural shade).
- **Painted shadows** — Scene-space darkening from PaintedShadowEffectV2 (artist-painted shadow masks).
- **Landscape lightning** — HDR brightening on foliage during distant strikes (Map Shine Control lightning).
- **Edge safety** — Pulls motion and shadow down near scene edges to hide UV seams.
- **Clump waves** — Transparent gaps in the mask define foliage clumps; wind waves roll across clump positions on the map.
- **Clump ID view** — Debug false-color of island labels — use to check whether antialiased edges share the same ID as the foliage body.

## Authored presets

`Calm` · `Windy` · `Soft shadow`

## Controls, grouped as the author grouped them

### Look

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Intensity | `intensity` | slider | 0 … 2 | 1 |  |
| | | | | | _Master strength of the bush layer and its shadow pass._ |

### Wind & waves

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Wave mix | `waveInfluence` | slider | 0 … 1 | 0.54 |  |
| | | | | | _How much the traveling wave modulates bend and flutter._ |
| Gust frequency | `gustFrequency` | slider | 0 … 0.05 | 0.0142 |  |
| | | | | | _Procedural gust noise scale on foliage (fine chop layered on scene wind)._ |
| Gust travel | `gustSpeed` | slider | 0 … 2 | 0.52 |  |
| | | | | | _How fast procedural gust noise scrolls across the canopy._ |
| Low-wind rustle | `minRustleSpeed` | slider | 0 … 0.6 | 0 |  |
| | | | | | _Optional flutter bump in the breeze band (0 = true calm at zero wind)._ |

### Bulk sway

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Sway amount | `bulkSway` | slider | 0 … 0.1 | 0.013 |  |
| | | | | | _Rigid whole-island motion — moves overlay geometry, not mask UV._ |
| Sway scale | `bulkSwayScale` | slider | 0 … 2.5 | 1.31 |  |
| | | | | | _Multiplier on bulk sway amplitude._ |
| Sway speed | `bulkSwaySpeed` | slider | 0.2 … 3 | 1.69 |  |
| | | | | | _How fast each island rocks (slow compared to leaf flutter)._ |
| Direction spread | `bulkSwaySpread` | slider | 0.08 … 0.75 | 0.32 |  |
| | | | | | _Per-island variation in sway direction (radians). Higher = more independent bushes._ |
| Springiness | `elasticity` | slider | 0.5 … 5 | 0.5 |  |
| | | | | | _Branch sway speed (slow oscillation — leaf flutter uses Flutter speed)._ |

### Leaf flutter

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Flutter amount | `flutterIntensity` | slider | 0 … 0.02 | 0.0002 |  |
| | | | | | _Fine per-pixel leaf UV shimmer (layer 3 — after canopy sway and branch bend)._ |
| Flutter speed | `flutterSpeed` | slider | 1 … 20 | 3.89 |  |
| | | | | | _How fast the flutter phase advances._ |
| Flutter scale | `flutterScale` | slider | 0.005 … 0.1 | 0.016 |  |
| | | | | | _World-space scale of noise driving flutter._ |

### Response curves _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Ambient motion | `ambientMotion` | slider | 0 … 0.35 | 0.02 |  |
| | | | | | _Extra bulk motion layered on the wind envelope (scales in above dead calm)._ |
| Rustle floor scale | `rustleFloorScale` | slider | 0 … 1 | 0.25 |  |
| | | | | | _Scales the low-wind rustle floor (see Low-wind rustle)._ |
| Flutter base drive | `flutterBaseDrive` | slider | 0 … 1 | 0 |  |
| | | | | | _Optional minimum flutter within the wind envelope (0 = envelope only)._ |
| Flutter wind start | `flutterWindStart` | slider | 0 … 0.4 | 0 |  |
| | | | | | _Scene wind level where flutter begins to ramp._ |
| Flutter wind full | `flutterWindFull` | slider | 0.01 … 0.6 | 0.6 |  |
| | | | | | _Scene wind level where flutter reaches full drive._ |
| Low-wind flutter boost | `flutterLowWindBoost` | slider | 1 … 2.5 | 1 |  |
| | | | | | _Scales breeze-tier flutter within the envelope (astrolabe may override)._ |
| Boost fade end | `flutterLowWindFadeEnd` | slider | 0.05 … 1 | 0.35 |  |
| | | | | | _Wind level where the low-wind boost has faded out._ |
| Flutter gust floor | `flutterGustFloor` | slider | 0 … 1 | 0 |  |
| | | | | | _Minimum gust pulse on HF flutter when breeze-tier motion is active._ |
| Bend minimum | `bendMinStrength` | slider | 0 … 1 | 0.08 |  |
| | | | | | _Light-wind bend scaler within the envelope (not an absolute motion floor)._ |
| Bend wind start | `bendWindStart` | slider | 0 … 0.8 | 0 |  |
| | | | | | _Wind level where branch bending starts ramping._ |
| Bend wind full | `bendWindFull` | slider | 0.1 … 1 | 1 |  |
| | | | | | _Wind level where bend drive reaches full strength._ |

### Color

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Exposure | `exposure` | slider | -2 … 2 | -0.4 |  |
| | | | | | _Extra stops on top of Camera Grade exposure._ |
| Brightness | `brightness` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _Extra linear offset after Camera Grade._ |
| Contrast | `contrast` | slider | 0.5 … 2 | 1 |  |
| | | | | | _Contrast around mid gray._ |
| Saturation | `saturation` | slider | 0 … 2 | 1 |  |
| | | | | | _1 = unchanged; 0 = grayscale._ |
| Temperature | `temperature` | slider | -1 … 1 | 0 |  |
| | | | | | _Warm/cool bias (pushes red vs blue)._ |
| Green/magenta | `tint` | slider | -1 … 1 | 0 |  |
| | | | | | _Shifts green vs magenta before brightness._ |

### Edge safety _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Edge fade start | `edgeFadeStart` | slider | 0 … 0.2 | 0 |  |
| | | | | | _Scene-edge band where motion begins to fall off._ |
| Edge fade end | `edgeFadeEnd` | slider | 0.02 … 0.4 | 0.02 |  |
| | | | | | _Scene-edge distance where motion and shadow are fully suppressed._ |

### Clump debug _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Clump ID view | `clumpIdDebug` | dropdown | Off / Baked island ID / Wind shader ID / Map vs shader / Unlabeled foliage / Wind UV split | 0 |  |
| | | | | | _False-color foliage clump labels (wind frozen except Wind UV split). Baked island ID = load-time map; Wind shader ID = sampleClumpField; Map vs shader = red when they disagree; Unlabeled foliage = magenta pixels with mask alpha but no clump label; Wind UV split = red when wind distortion samples a different island ID._ |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Wind scale | `windSpeedGlobal` | slider | 0 … 3 | 1.6 | hidden |
| | | | | | _Moved to Scene Wind → Vegetation response._ |
| Wind catch-up | `windRampSpeed` | slider | 0.1 … 10 | 7.64 | hidden |
| | | | | | _Moved to Scene Wind → Vegetation catch-up._ |
| Wave spacing | `waveSpatialFrequency` | slider | 0.0001 … 0.01 | 0.0018 | hidden |
| | | | | | _Moved to Scene Wind → Wave spacing._ |
| Wave speed | `waveTravelSpeed` | slider | 0.05 … 4 | 0.85 | hidden |
| | | | | | _Moved to Scene Wind → Wave speed._ |
| Wave sharpness | `waveSharpness` | slider | 0.5 … 6 | 2.2 | hidden |
| | | | | | _Moved to Scene Wind → Wave sharpness._ |
| Shadow strength | `shadowOpacity` | slider | 0 … 1 | 0.08 |  |
| | | | | | _Opacity of the offset canopy shadow pass._ |
| Shadow offset | `shadowLength` | slider | 0 … 0.1 | 0.02 |  |
| | | | | | _How far the shadow sample is pushed opposite the sun._ |
| Shadow softness | `shadowSoftness` | slider | 0.5 … 5 | 0.7 |  |
| | | | | | _Blur radius of the multi-tap shadow sample._ |
| Cloud shadows | `cloudShadowEnabled` | boolean |  | true |  |
| | | | | | _Darken canopy pixels where the cloud shadow map is shaded (matches ground tiles)._ |
| Shadow strength | `cloudShadowDarkenStrength` | slider | 0 … 3 | 1.25 |  |
| | | | | | _How strongly cloud shade darkens the foliage._ |
| Shadow curve | `cloudShadowDarkenCurve` | slider | 0.1 … 8 | 1.5 |  |
| | | | | | _Higher = softer penumbra, lower = harder cloud edges on leaves._ |
| Building shadows | `buildingShadowEnabled` | boolean |  | true |  |
| | | | | | _Darken canopy pixels where the building shadow map is shaded (scene UV, matches ground)._ |
| Shadow strength | `buildingShadowDarkenStrength` | slider | 0 … 3 | 0.8 |  |
| | | | | | _How strongly structural building shade darkens the foliage._ |
| Shadow curve | `buildingShadowDarkenCurve` | slider | 0.1 … 8 | 1 |  |
| | | | | | _Higher = softer penumbra, lower = harder building edges on leaves._ |
| Painted shadows | `paintedShadowEnabled` | boolean |  | true |  |
| | | | | | _Darken canopy pixels where PaintedShadowEffectV2 is shaded (scene UV, matches ground)._ |
| Shadow strength | `paintedShadowDarkenStrength` | slider | 0 … 3 | 1 |  |
| | | | | | _How strongly painted shadow shade darkens the foliage._ |
| Shadow curve | `paintedShadowDarkenCurve` | slider | 0.1 … 8 | 1.15 |  |
| | | | | | _Higher = softer penumbra, lower = harder painted edges on leaves._ |
| Landscape lightning | `lightningVegetationEnabled` | boolean |  | true |  |
| | | | | | _Brighten canopy sprites during distant landscape lightning and map-point strikes._ |
| Flash brightness | `lightningVegetationBrightnessBoost` | slider | 0 … 10 | 2.5 |  |
| | | | | | _Multiplicative lift plus extra HDR emission on sprites. Outdoor flash from weather is added automatically._ |
| Flash contrast | `lightningVegetationContrastBoost` | slider | 0 … 4 | 0 |  |
| | | | | | _Optional mid-tone punch — only affects brighter leaf pixels; leave at 0 for dark canopies._ |
| Flash tint | `lightningVegetationTintStrength` | slider | 0 … 1 | 0.5 |  |
| | | | | | _How much the strike color tints the canopy._ |
| Clump waves | `clumpWaveEnabled` | boolean |  | true | hidden |
| | | | | | _Moved to Scene Wind → Clump wave field._ |
| Clump unity | `clumpWaveMix` | slider | 0 … 1 | 1 | hidden |
| | | | | | _Moved to Scene Wind → Clump wave mix._ |
