# Light Physics

**V2 class:** `LightingEffectV2` · **Source:** `legacy/compositor-v2/effects/LightingEffectV2.js`

**Rebuilt in V3 as:** `light.accumulate`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

This panel controls linear HDR light transport: Foundry point lights, ambient day/night fill, and shadow occlusion.

It does not own exposure, brightness, or tone mapping. Use Camera Grade for the HDR to LDR look.

Shadows dim ambient/sky light. Point lights are preserved so torches and lamps create readable pools at night.

## The knobs, in the author's words

- **Day ambient** — Foundry ambientBrightest at low darkness; outdoor vs indoor scales use the _Outdoors mask.
- **Night ambient** — Foundry ambientDarkness at high darkness; outdoor/indoor split for porches vs rooms.
- **Twilight darkness** — How dark the calendar curve is at dawn and dusk (before full night).
- **Twilight day floor** — Minimum day-ambient kept when the sun is on the horizon (solar strength ≈ 0).
- **Twilight min-light keep** — Extra minimum-light floor during daylight hours so porches and rooms do not clip black.
- **Point light gain** — Base emission multiplier on torch/flash and Foundry lamps before `_lightRT`. Use Foundry lamps for extra brightness/colour on scene AmbientLights only.
- **Foundry lamp brightness** — Per-phase extra multiplier on Foundry AmbientLight meshes. Blends by calendar hour (day at noon, twilight at dawn/dusk, night at midnight).
- **Foundry lamp colour** — Per-phase CI / chroma push on Foundry AmbientLight meshes. Does not affect candle or fire glow.
- **Minimum light floor** — Safety floor that prevents pure-black collapse without replacing actual lights.

## Controls, grouped as the author grouped them

### Ambient light (linear HDR)

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Day ambient — outdoor | `ambientDayScaleOutdoor` | slider | 0 … 3.5 | 1 |  |
| | | | | | _Scales Foundry ambient brightest on outdoor-classified pixels (porches, courtyards, sky reach)._ |
| Day ambient — indoor | `ambientDayScaleIndoor` | slider | 0 … 3.5 | 1 |  |
| | | | | | _Scales Foundry ambient brightest on indoor-classified pixels (rooms under roof capture)._ |
| Night ambient — outdoor | `ambientNightScaleOutdoor` | slider | 0 … 2 | 1 |  |
| | | | | | _Scales Foundry ambientDarkness on outdoor pixels at high darkness._ |
| Night ambient — indoor | `ambientNightScaleIndoor` | slider | 0 … 2 | 1.1 |  |
| | | | | | _Scales Foundry ambientDarkness on indoor pixels; usually slightly lower than outdoor._ |
| Minimum light floor | `minIlluminationScale` | slider | 0 … 3 | 0 |  |
| | | | | | _Scales the darkest-scene safety floor so interiors never clip to pure black._ |

### Dawn / dusk (twilight)

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Twilight darkness | `twilightDarkness` | slider | 0 … 0.85 | 0.32 |  |
| | | | | | _Calendar darkness at dawn and dusk. Lower = brighter golden hour; higher = sooner toward night._ |
| Day floor — outdoor | `twilightDayFloorOutdoor` | slider | 0 … 1 | 0.28 |  |
| | | | | | _Minimum day-ambient multiplier at sunrise/sunset on outdoor-classified pixels (porches, courtyards)._ |
| Day floor — indoor | `twilightDayFloorIndoor` | slider | 0 … 1 | 0.14 |  |
| | | | | | _Minimum day-ambient at the horizon inside rooms (usually lower than outdoor)._ |
| Min-light keep — outdoor | `twilightMinLightKeepOutdoor` | slider | 0 … 1 | 0.55 |  |
| | | | | | _Boosts the safety minimum-light floor during daylight hours outdoors._ |
| Min-light keep — indoor | `twilightMinLightKeepIndoor` | slider | 0 … 1 | 0.3 |  |
| | | | | | _Same floor boost for indoor pixels during daylight hours._ |

### Foundry lamps — Day

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Brightness boost | `foundryLightBrightnessDay` | slider | 0 … 16 | 1 |  |
| | | | | | _Foundry AmbientLight emission near solar noon. Does not affect candle/fire glow, window glow, or player torch._ |
| Colour boost | `foundryLightColorBoostDay` | slider | 0 … 8 | 1 |  |
| | | | | | _Foundry Color Intensity (gel) near solar noon on AmbientLight meshes only._ |

### Foundry lamps — Twilight

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Brightness boost | `foundryLightBrightnessTwilight` | slider | 0 … 16 | 1 |  |
| | | | | | _Foundry AmbientLight emission at dawn and dusk (horizon hours). Blends smoothly into day and night._ |
| Colour boost | `foundryLightColorBoostTwilight` | slider | 0 … 8 | 1 |  |
| | | | | | _Foundry Color Intensity (gel) at dawn and dusk on AmbientLight meshes only._ |

### Foundry lamps — Night

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Brightness boost | `foundryLightBrightnessNight` | slider | 0 … 16 | 1 |  |
| | | | | | _Foundry AmbientLight emission near midnight. Does not affect candle/fire glow, window glow, or player torch._ |
| Colour boost | `foundryLightColorBoostNight` | slider | 0 … 8 | 1 |  |
| | | | | | _Foundry Color Intensity (gel) near midnight on AmbientLight meshes only._ |

### Player / shared gain

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Shared point gain | `lightIntensity` | slider | 0 … 4 | 1 |  |
| | | | | | _Base emission multiplier on torch/flash and Foundry lamps (`uComposeLightGain`) before `_lightRT`. Foundry lamps also use Brightness boost above. Candle glow may follow this when “Follow point light gain” is enabled on Candles._ |

### Window glow (compose)

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Window indirect gain | `windowEmissiveGain` | slider | 0 … 4 | 0.55 |  |
| | | | | | _Scales HDR window spill in compose (emit strength is on Window Light → Intensity)._ |
| Window contrast | `windowIndirectContrast` | slider | 0.35 … 1.2 | 1.2 |  |
| | | | | | _Lower = hotter window cores and softer penumbra (less flat grey at high intensity)._ |
| Window warmth tint | `windowWarmthTint` | slider | 0 … 1 | 1 |  |
| | | | | | _How much emit colour tints nearby walls in compose (0 = neutral white spill)._ |
| Wall texture coupling | `windowAlbedoCoupling` | slider | 0 … 1.5 | 0 |  |
| | | | | | _Scales indirect spill by wall albedo luma so masonry keeps texture while floors brighten._ |
| Window core glow | `windowScreenSpill` | slider | 0 … 2 | 0 |  |
| | | | | | _Small additive warm highlight on lit pixels at window cores (HDR-linear; not a full-frame multiply)._ |

### Point light falloff (half-life)

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Halving dist. (att 0, bright) | `falloffHalfInAtAtt0` | slider | 0.01 … 2 | 0.15 |  |
| | | | | | _Bright-ring halving distance at the soft end (Foundry Attenuation 1). Larger = wider, softer pool._ |
| Halving dist. (att 1, bright) | `falloffHalfInAtAtt1` | slider | 0.005 … 1 | 0.05 |  |
| | | | | | _Bright-ring halving distance at the hard end (Foundry Attenuation 0). Smaller = tighter core._ |
| Halving dist. (att 0, dim) | `falloffHalfOutAtAtt0` | slider | 0.01 … 2 | 0.65 |  |
| | | | | | _Dim-ring hardness when attenuation is 0 (outer falloff to the photometric edge)._ |
| Halving dist. (att 1, dim) | `falloffHalfOutAtAtt1` | slider | 0.005 … 1 | 0.35 |  |
| | | | | | _Dim-ring hardness at Attenuation 1 — should stay high enough to reach the dim radius before the edge fade._ |
| Min halving step | `falloffHalfMin` | slider | 0.001 … 0.5 | 0.02 |  |
| | | | | | _Floor when lerping halving distances (prevents extreme hardness)._ |
| Edge soft → bright ring | `falloffEdgeSoftBoostIn` | slider | 0 … 1.5 | 0.1 |  |
| | | | | | _How much per-light edge softness widens the bright-ring halving distance._ |
| Edge soft → dim ring | `falloffEdgeSoftBoostOut` | slider | 0 … 1.5 | 0.08 |  |
| | | | | | _How much edge softness widens the dim-ring halving distance._ |
| Bright radius scale | `falloffBrightNormInfluence` | slider | 0 … 2 | 0.92 |  |
| | | | | | _Scales halving in the bright disk vs Foundry bright/dim radius ratio (larger bright radius → wider core)._ |
| Dim ring weight | `falloffDimRingWeight` | slider | 0.05 … 2.5 | 1 |  |
| | | | | | _Weight of the outer (dim) ring vs bright (Foundry sums both zones). 1.0 matches core Foundry balance._ |
| Rim AA width | `falloffRimAAScale` | slider | 0.02 … 2 | 0.38 |  |
| | | | | | _Width of the anti-alias fade at the photometric outer edge (fraction of fade band)._ |
| Attenuation curve | `falloffAttCurvePower` | slider | 1 … 4 | 1 |  |
| | | | | | _At 1.0, Foundry Attenuation 0 / 0.5 / 1 map evenly between the att=0 and att=1 halving distances (0.5 sits in the middle). Above 1.0 bends toward Attenuation 1 — at 2.5, Attenuation 0.5 looks almost like 0. Keep at 1.0 while tuning the halving-distance sliders._ |
| Rim band (att 0) | `falloffRimBandAtAtt0` | slider | 0.01 … 1 | 0.16 |  |
| | | | | | _Outer-edge AA band width at attenuation 0._ |
| Rim band (att 1) | `falloffRimBandAtAtt1` | slider | 0.005 … 0.5 | 0.08 |  |
| | | | | | _Outer-edge AA band width at attenuation 1._ |
| Falloff exponent bias | `falloffExponent` | slider | 0.5 … 8 | 2 |  |
| | | | | | _Slight modifier on legacy exponent uniform (2 ≈ neutral). Affects rim band + halving bias._ |

### Lamp colour (HDR radiance buffer) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| CI buffer scale | `colorationMixScale` | slider | 0 … 4 | 1 |  |
| | | | | | _Scales Foundry Color Intensity in the buffer (1.0 = full CI from the lamp; 0.4 = 40% max saturation)._ |
| Max CI mix | `colorationMaxMix` | slider | 0 … 1 | 0.69 |  |
| | | | | | _Caps how much Foundry Color Intensity can push the buffer toward lamp hue [0..1]._ |
| CI curve power | `colorationMixPower` | slider | 0.1 … 6 | 3.65 |  |
| | | | | | _Exponent on Foundry CI before compose (1 = linear; >1 widens gap between 0.5 and 1.0; <1 compresses mid CI)._ |
| Saturation boost gain | `colorationStrength` | slider | 1 … 12 | 1 |  |
| | | | | | _Extra lamp/albedo saturation that follows the soft light falloff (not the tight CI gel core). Does not change brightness halving. Leave at 1 unless you want punchier colour._ |
| Coloration reflectivity | `colorationReflectivity` | slider | 0 … 1 | 0 |  |
| | | | | | _0 = vivid lamp hue on stone; 1 = tint follows albedo luma (weaker on dark cobble). Use 0 for torches._ |
| Saturation boost | `colorationSaturationBoost` | slider | -2 … 6 | 1.4 |  |
| | | | | | _Pushes chroma after the lamp tint (0.5–1.5 typical). Does not change lamp brightness._ |
| Colour falloff start | `colorationFalloffStart` | slider | 0 … 2 | 0 |  |
| | | | | | _Lamp-energy level where colour tint begins (smoothstep low edge)._ |
| Colour falloff end | `colorationFalloffEnd` | slider | 0.001 … 4 | 0.01 |  |
| | | | | | _Lamp-energy level where CI reaches full strength. Lower this to 0.01 to keep lights colored all the way to their edges._ |
| Colour falloff curve | `colorationFalloffPower` | slider | 0.1 … 12 | 1 |  |
| | | | | | _Exponent on the colour penumbra mask (>1 = softer)._ |
| Colour energy gain | `colorationEnergyGain` | slider | 0 … 16 | 1 |  |
| | | | | | _Scales lamp energy before the colour penumbra smoothstep (extends colour toward the rim when >1)._ |

### Ambient occlusion from shadows _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Combined shadow strength | `combinedShadowEffectStrength` | slider | 1 … 4 | 2 |  |
| | | | | | _Amplifies unified shadow darkness on ambient only (1 = authored, 4 = very deep). Strong lights can still clear shadow override on structural paths._ |
| Cloud shadow on ambient | `cloudShadowAmbientInfluence` | slider | 0 … 1 | 1 |  |
| | | | | | _Reduces cloud (or combined) shadow on ambient only; dynamic lights stay full strength._ |
| Overhead shadow on ambient | `overheadShadowAmbientInfluence` | slider | 0 … 1 | 1 |  |
| | | | | | _Scales overhead tile shadow on ambient; torches and lamps still punch through._ |
| Dynamic light shadow override | `dynamicLightShadowOverrideStrength` | slider | 0 … 1 | 0 | **shadow-lift fossil — do not rebuild** (`shadow/no-lift-no-combine`) |
| | | | | | _Clears ambient shadow near bright gameplay lights (torch/flashlight). Uses stricter sensing than older builds so faint HDRI-style fill does not erase building/painted shadows; strong lights still lift._ |
| Structural shadow vs sky/day fill | `structuralSunAmbientOcclusion` | slider | 0 … 1 | 1 |  |
| | | | | | _For outdoor pixels under daylight: building + painted shadows stay darker than unified ambient lifts alone (minimum of unified shadow and structural occlusion). Dynamic shadow override still clears structural shadows near torches/player lights. Set to 0 for legacy behaviour._ |
| Structural occlusion on HDR lights | `directStructuralOcclusionStrength` | slider | 0 … 1 | 1 |  |
| | | | | | _Darkens the Foundry HDR light accumulation (ambient disks/torches/colour spill) wherever building+painted shadows are dark. Strong gameplay lights clear this via Structural shadow override. Set to 0 to restore fills that bypass structural shadows entirely._ |

### Roof / floor occlusion _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Wall Inset (px) | `wallInsetPx` | slider | 0 … 40 | 6 |  |
| Wall Padding (px) | `wallPaddingPx` | slider | 0 … 12 | 2 |  |
| | | | | | _Expands blocking wall segments during light LOS raycasts. Reduces glow bleeding through thin or diagonal walls. Also applies to candle/fire glow pools._ |
| Multi-floor: roof gate & building roof-cutout top floor only | `restrictRoofScreenLightOcclusionToTopFloor` | boolean |  | true |  |
| | | | | | _When on (recommended for 2+ floors), Foundry lights use screen-space roof alpha only on the top floor so upstairs stamps do not cut lower-floor lights. Building shadows skip roof-cutout on the uppermost band when 2+ floors exist (that band’s map art is often on the roof layer and would otherwise suppress all building shadows). Single-floor maps unchanged. Turn off for legacy “always gate” on lights._ |
| Upper Floor Through-Gaps | `upperFloorTransmissionEnabled` | boolean |  | false |  |
| Upper Light Strength | `upperFloorTransmissionStrength` | slider | 0 … 2 | 0.6 |  |

### Advanced darkness response _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Interior Darkness | `interiorDarkness` | slider | 0 … 1.5 | 0 |  |
| | | | | | _Extra dim on mask-classified interiors (ambient only). Fades out automatically under Foundry / window light so torches and overlap regions do not stay muddy; specular in the scene buffer scales with total illumination._ |
| Negative Darkness Strength | `negativeDarknessStrength` | slider | 0 … 3 | 2 |  |
| Darkness Punch Gain | `darknessPunchGain` | slider | 0 … 10 | 0 |  |

### Advanced light animation _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Wind Influence | `lightAnimWindInfluence` | slider | 0 … 3 | 1 |  |
| Outdoor Power | `lightAnimOutdoorPower` | slider | 0 … 6 | 2 |  |

### Performance (internal RT scale) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Foundry lights RT scale | `internalLightResolutionScale` | slider | 0.25 … 1 | 1 |  |
| | | | | | _Internal resolution for `_lightRT` and stacked light buffers. Lower values reduce fill rate; point lights may soften slightly._ |
| Window emit RT scale | `internalWindowResolutionScale` | slider | 0.25 … 1 | 0.5 |  |
| | | | | | _Scales the scene-UV emit RT relative to compositor mask resolution (1.0 = native mask size). Do not cap to drawing-buffer size — that smears glow in compose._ |
| Darkness RT scale | `internalDarknessResolutionScale` | slider | 0.25 … 1 | 1 |  |
| | | | | | _Internal resolution for the darkness accumulation RT._ |
| Window emit half-float | `windowLightUseHalfFloat` | boolean |  | true |  |
| | | | | | _When false, emit RT uses 8-bit (less VRAM/bandwidth; may band on bright windows)._ |
| Window emit cache | `windowEmitCacheEnabled` | boolean |  | true |  |
| | | | | | _Skips redundant full window-emit draws per floor when nothing changed (cross-frame). Disable if window glow ever looks stale._ |
| Light prepass reuse | `lightPrepassReuseEnabled` | boolean |  | true |  |
| | | | | | _Reuses the pre-bus Foundry light buffer at compose when floor/size/state match within the same frame. Disable if light rims flicker._ |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| enabled | `enabled` | boolean |  | true | hidden |
| Illumination scale (legacy) | `globalIllumination` | slider | 0 … 2 | 0 | hidden |
| | | | | | _Deprecated: use Day ambient and Night ambient. Kept so old module data still loads._ |
| Day ambient (legacy) | `ambientDayScale` | slider | 0 … 3.5 | 1 | hidden |
| | | | | | _Deprecated: use Outdoor/Indoor day ambient. Loaded for old saves._ |
| Night ambient (legacy) | `ambientNightScale` | slider | 0 … 2 | 0.32 | hidden |
| | | | | | _Deprecated: use Outdoor/Indoor night ambient._ |
| Brightness boost (legacy) | `foundryLightBrightness` | slider | 0 … 16 | 1 | hidden |
| | | | | | _Deprecated: migrated to Foundry lamps — Day / Twilight / Night._ |
| Colour boost (legacy) | `foundryLightColorBoost` | slider | 0 … 8 | 1 | hidden |
| | | | | | _Deprecated: migrated to Foundry lamps — Day / Twilight / Night._ |
| Lamp saturation | `colorationSaturation` | slider | -2 … 4 | 0 |  |
| | | | | | _Pushes lamp chroma before tint (0 = buffer hue)._ |
| Darken tinted | `colorationDarken` | slider | 0 … 3 | 0 |  |
| | | | | | _Scales down lit result where tint is active (deeper reds)._ |
| Brighten tinted | `colorationBrighten` | slider | -2 … 4 | 0 |  |
| | | | | | _Adds peak multiplier where tint is active (can wash colour)._ |
| Peak preserve | `colorationPeakPreserve` | slider | 0 … 1 | 1 |  |
| | | | | | _1 = match white-light max channel after tint; 0 = allow peak to change._ |
| Hue shift | `colorationHueShift` | slider | -1 … 1 | 0 |  |
| | | | | | _Rotates lamp hue before tint (-1..1 = full wheel)._ |
| Chroma curve | `colorationChromaCurve` | slider | 0.1 … 8 | 1 |  |
| | | | | | _Exponent on buffer color mix (higher = needs more CI before full tint)._ |
| Neutral bleed | `colorationAchromaticMix` | slider | 0 … 1 | 0 |  |
| | | | | | _Blends color mix toward 1 (tint even when buffer chroma is low)._ |
| Tone mapping (deprecated) | `composeToneMapping` | list | None | 0 | hidden |
| | | | | | _Deprecated: lighting pass always outputs linear HDR. Tone mapping is owned by Color Correction._ |
| Tone-map exposure (deprecated) | `composeToneExposure` | slider | 1 … 1 | 1 | hidden, **frozen (min===max)** |
| | | | | | _Deprecated: forced to 1.0. Use Color Correction exposure instead._ |
