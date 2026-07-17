# Contextual Scene Grade

**V2 class:** `ContextualSceneGradeEffectV2` · **Source:** `legacy/compositor-v2/effects/ContextualSceneGradeEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Probes update intended grade targets each step; the engine morphs the live CC toward those targets every frame (no per-step transition restarts).

Indoor/outdoor uses a smooth _Outdoors weight blend at doorways — not a hard flip per grid square.

Tier 1: global weather/time env modifiers. Tier 2: cloud shadow, canopy, window-lit, building/painted/tree cover shadows.

Tree dapple at daytime uses a procedural leaf-noise pass in Color Correction (green tint + chunky light patches).

Tier 3: spatial blend at doorways + atmosphere/dazzle coherence with existing CC stack.

Vignette: each trigger pack can add edge darkening; night and indoor defaults are tuned for stronger corners. Shape is controlled globally in the Vignette folder.

Eye adaptation: after settling, each layer (indoor/outdoor base + shadow/modifier stack) fades toward neutral over ~60s — including building and painted shadow.

Outdoor/indoor packs favor exposure over brightness (avoids washed pale mids).

Presets scale the full logic set by intensity — Extreme, Cinematic, Moderate, Mild.

Per-client: each player's view follows their own token. GM uses the selected token (sticky last selection).

## Authored presets

`Neutral` · `Extreme` · `Cinematic` · `Moderate` · `Mild`

## Controls, grouped as the author grouped them

### Engine logic

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Probe interval (s) | `probeIntervalSec` | slider | 1 … 15 | 5 |  |
| | | | | | _Minimum time between outdoors mask samples when the token has not moved much._ |
| Move gate (px) | `moveGateGrid` | slider | 0 … 200 | 0 |  |
| | | | | | _Skip timer probes until the token moves this many scene pixels. 0 = half a grid square._ |
| Outdoor threshold | `outdoorThresholdHigh` | slider | 0.5 … 1 | 0.82 |  |
| | | | | | _Outdoors sample must reach this value to classify as outdoor._ |
| Indoor threshold | `indoorThresholdLow` | slider | 0 … 0.5 | 0.18 |  |
| | | | | | _Outdoors sample at or below this value classifies as indoor._ |
| Fade in (ms) | `fadeInMs` | slider | 0 … 30000 | 3600 |  |
| | | | | | _Duration when entering indoor/outdoor (base layer). Default is 3× the original 1.2s._ |
| Fade out (ms) | `fadeOutMs` | slider | 0 … 30000 | 7200 |  |
| | | | | | _Duration when returning to neutral or leaving a context (base layer)._ |
| Modifier fade (ms) | `modifierFadeMs` | slider | 0 … 30000 | 3600 |  |
| | | | | | _Cloud, canopy, and other token modifier cross-fades (modifier layer)._ |
| Cover shadow fade (ms) | `coverShadowFadeMs` | slider | 0 … 30000 | 3000 |  |
| | | | | | _Fade-in when entering building, painted, or tree cover shadow (default 3s)._ |
| Easing in | `easingIn` | dropdown | linear / smooth / easeIn / easeOut / easeInOut / exp / overshoot | smooth |  |
| Easing out | `easingOut` | dropdown | linear / smooth / easeIn / easeOut / easeInOut / exp / overshoot | easeOut |  |
| Eye adaptation | `eyeAdaptationEnabled` | boolean |  | true |  |
| | | | | | _After each layer settles, its offset fades toward neutral (like pupils adjusting). Indoor/outdoor uses the longer time; cover shadows use the shorter time when leaving shadow._ |
| Indoor/outdoor adapt (s) | `eyeAdaptationSec` | slider | 10 … 180 | 60 |  |
| | | | | | _Eye adaptation for indoor↔outdoor base grade and cloud/canopy modifiers._ |
| Cover shadow adapt (s) | `coverShadowEyeAdaptationSec` | slider | 1 … 120 | 3 |  |
| | | | | | _Fade in/out for building, painted, and tree cover shadow (default 3s)._ |
| Adaptation easing | `eyeAdaptationEasing` | dropdown | linear / smooth / easeIn / easeOut / easeInOut / exp / overshoot | easeOut |  |

### Transition drama

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Drama enabled | `dramaEnabled` | boolean |  | true |  |
| | | | | | _Bright dazzle when stepping from indoor to outdoor in daylight. Does not run at night, when selecting a token already outdoors, or without an indoor→outdoor walk._ |
| Daylight only | `dramaRequireDaylight` | boolean |  | true |  |
| | | | | | _Doorway dazzle only during calendar day phase with day weight above the Environment modifiers day threshold._ |
| Drama strength | `dramaStrength` | slider | 0 … 1.5 | 1 |  |
| Peak exposure boost | `dramaPeakExposure` | slider | 0 … 1.5 | 0.75 |  |
| | | | | | _Extra exposure stops at the dazzle peak (pow2 in shader)._ |
| Peak brightness | `dramaPeakBrightness` | slider | 0 … 0.5 | 0.04 |  |
| | | | | | _Prefer exposure for doorway dazzle; brightness lifts mids and can wash the scene pale._ |
| Peak saturation | `dramaPeakSaturation` | slider | 0 … 0.5 | 0.12 |  |
| Peak vibrance | `dramaPeakVibrance` | slider | 0 … 0.5 | 0.14 |  |
| Peak vignette lift | `dramaPeakVignetteLift` | slider | 0 … 0.35 | 0.1 |  |
| | | | | | _Temporarily reduces edge darkening during outdoor doorway dazzle (negative vignette bump)._ |
| Peak timing | `dramaPeakAt` | slider | 0.05 … 0.75 | 0.3 |  |
| | | | | | _When in the transition the dazzle peaks (0 = start, 1 = end)._ |
| Peak width | `dramaPeakWidth` | slider | 0.08 … 0.5 | 0.26 |  |
| | | | | | _How long the bright punch lingers._ |
| Settle delay | `dramaSettleDelay` | slider | 0 … 0.85 | 0.38 |  |
| | | | | | _Hold at the start grade until this fraction, then ease toward the target._ |
| Settle easing | `dramaSettleEasing` | dropdown | linear / smooth / easeIn / easeOut / easeInOut / exp / overshoot | easeOut |  |

### Environmental thresholds

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Env modifiers enabled | `envModifiersEnabled` | boolean |  | true |  |
| | | | | | _Global weather/time/darkness CC bias (Tier 1)._ |
| Env lerp (ms) | `envModifiersLerpMs` | slider | 50 … 2000 | 250 |  |
| Storm threshold | `envStormThreshold` | slider | 0.2 … 0.9 | 0.55 |  |
| Overcast threshold | `envOvercastThreshold` | slider | 0.1 … 0.7 | 0.35 |  |
| Night threshold | `envNightThreshold` | slider | 0 … 0.5 | 0.22 |  |
| Day threshold | `envDayThreshold` | slider | 0.4 … 0.9 | 0.62 |  |
| Heavy darkness threshold | `envDarknessHeavyThreshold` | slider | 0.4 … 1 | 0.72 |  |

### Token modifiers

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Cloud shadow low | `cloudShadowThresholdLow` | slider | 0 … 0.8 | 0.42 |  |
| Cloud shadow high | `cloudShadowThresholdHigh` | slider | 0.2 … 1 | 0.62 |  |
| Canopy shaded threshold | `canopyShadedThreshold` | slider | 0 … 0.8 | 0.38 |  |
| Canopy open threshold | `canopyOpenThreshold` | slider | 0.2 … 1 | 0.58 |  |
| Painted shadow lit low | `paintedShadowLitLow` | slider | 0.3 … 0.99 | 0.85 |  |
| Painted shadow lit high | `paintedShadowLitHigh` | slider | 0.4 … 1 | 0.94 |  |
| Tree shadow lit low | `treeShadowLitLow` | slider | 0.7 … 0.99 | 0.93 |  |
| | | | | | _Vegetation billboard lit factor at or below → tree dapple (soft canopy; higher = more sensitive)._ |
| Tree shadow lit high | `treeShadowLitHigh` | slider | 0.75 … 1 | 0.98 |  |
| Tree dapple day weight | `treeDappleDayThreshold` | slider | 0.1 … 0.9 | 0.35 |  |
| | | | | | _Calendar day weight must reach this for tree dapple._ |
| Outdoor overcast weight | `modOutdoorOvercastWeight` | slider | 0 … 1.5 | 1 |  |
| Cloud shadow weight | `modCloudShadowWeight` | slider | 0 … 1.5 | 1 |  |
| Canopy weight | `modCanopyWeight` | slider | 0 … 1.5 | 1 |  |
| Window-lit blend | `modWindowLitBlend` | slider | 0 … 1 | 0.65 |  |
| Building shadow weight | `modBuildingShadowWeight` | slider | 0 … 1.5 | 1 |  |
| Painted shadow weight | `modPaintedShadowWeight` | slider | 0 … 1.5 | 1 |  |
| Tree dapple weight | `modTreeDappleWeight` | slider | 0 … 1.5 | 1 |  |
| Tree dapple shader strength | `modTreeDappleStrength` | slider | 0 … 1.5 | 0.72 |  |
| | | | | | _Procedural leaf-noise intensity in Color Correction._ |
| Tree dapple cell scale | `modTreeDappleScale` | slider | 8 … 120 | 42 |  |
| Tree dapple green R | `modTreeDappleGreenR` | slider | 0.5 … 1.2 | 0.86 |  |
| Tree dapple green G | `modTreeDappleGreenG` | slider | 0.5 … 1.4 | 1.06 |  |
| Tree dapple green B | `modTreeDappleGreenB` | slider | 0.5 … 1.2 | 0.82 |  |

### Vignette

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Inner radius | `contextVignetteInner` | slider | 0.1 … 1.2 | 0.42 |  |
| | | | | | _Normalized radial distance where contextual vignette falloff begins (0 = center, 1 = edge). Lower = tighter vignette._ |
| Falloff width | `contextVignetteSoftness` | slider | 0.05 … 1.2 | 0.55 |  |
| | | | | | _How gradually the contextual vignette darkens from inner radius to screen edge._ |
| Max vignette strength | `coherenceMaxVignette` | slider | 0.1 … 1 | 0.55 |  |
| | | | | | _Safety clamp on stacked vignette from all active triggers._ |

### Stack coherence

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Coherence enabled | `coherenceEnabled` | boolean |  | true |  |
| Atmosphere coupling | `coherenceAtmosphereScale` | slider | 0 … 1 | 0.6 |  |
| Max context exposure | `coherenceMaxExposure` | slider | 0.5 … 2 | 1.35 |  |
| Dazzle gate during drama | `dazzleContextGradeGate` | slider | 0 … 1 | 0.45 |  |
| Spatial context blend | `contextSpatialEnabled` | boolean |  | true |  |
| Spatial blend strength | `contextSpatialStrength` | slider | 0 … 1 | 0.72 |  |

### Status

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Indoor / Outdoor | `statusIndoorOutdoor` | string |  | Unknown | **readout, not a knob** |
| Transition | `statusState` | string |  | Idle | **readout, not a knob** |
| Context key | `statusContextKey` | string |  | — | **readout, not a knob** |
| | | | | | _One active trigger per line (indoor/outdoor, env, cloud, canopy, cover shadow, etc.)._ |
| Cover shadow | `statusCoverShadow` | string |  | — | **readout, not a knob** |
| Eye adaptation | `statusEyeAdaptation` | string |  | — | **readout, not a knob** |
| Sky condition | `statusSkyCondition` | string |  | — | **readout, not a knob** |
| Day phase | `statusDayPhase` | string |  | — | **readout, not a knob** |
| Subject token | `statusSubject` | string |  | (none) | **readout, not a knob** |
| Outdoors sample | `statusOutdoorsSample` | string |  | — | **readout, not a knob** |
| Mask probe | `statusMaskProbe` | string |  | — | **readout, not a knob** |
| CC overlay | `statusCcOverlay` | string |  | Off | **readout, not a knob** |
| Last probe age | `statusProbeAge` | string |  | — | **readout, not a knob** |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Enabled | `enabled` | boolean |  | true |  |
| Outdoor Exposure | `outdoorExposure` | slider | -2 … 2 | 0.18 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Outdoor Saturation | `outdoorSaturation` | slider | -1 … 1 | 0.04 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Outdoor Brightness | `outdoorBrightness` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _Brightness offset._ |
| Outdoor Contrast | `outdoorContrast` | slider | -1 … 1 | 0.02 |  |
| | | | | | _Contrast delta from 1.0._ |
| Outdoor Vibrance | `outdoorVibrance` | slider | -1 … 1 | 0.05 |  |
| | | | | | _Vibrance offset._ |
| Outdoor Temperature | `outdoorTemperature` | slider | -0.5 … 0.5 | 0.04 |  |
| | | | | | _White-balance temperature offset._ |
| Outdoor Tint | `outdoorTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Outdoor VignetteStrength | `outdoorVignetteStrength` | slider | -0.25 … 0.75 | 0 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Outdoor MasterGamma | `outdoorMasterGamma` | slider | -1 … 1 | 0 |  |
| | | | | | _Gamma delta from neutral._ |
| Outdoor fade in override (ms) | `outdoorFadeInMs` | slider | 0 … 10000 | 0 |  |
| | | | | | _0 = use global fade in._ |
| Outdoor fade out override (ms) | `outdoorFadeOutMs` | slider | 0 … 15000 | 0 |  |
| | | | | | _0 = use global fade out._ |
| Outdoor easing in | `outdoorEasingIn` | dropdown |  / linear / smooth / easeIn / easeOut / easeInOut / exp / overshoot |  |  |
| Outdoor easing out | `outdoorEasingOut` | dropdown |  / linear / smooth / easeIn / easeOut / easeInOut / exp / overshoot |  |  |
| Indoor Exposure | `indoorExposure` | slider | -2 … 2 | -0.38 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Indoor Saturation | `indoorSaturation` | slider | -1 … 1 | -0.1 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Indoor Brightness | `indoorBrightness` | slider | -0.5 … 0.5 | -0.04 |  |
| | | | | | _Brightness offset._ |
| Indoor Contrast | `indoorContrast` | slider | -1 … 1 | -0.02 |  |
| | | | | | _Contrast delta from 1.0._ |
| Indoor Vibrance | `indoorVibrance` | slider | -1 … 1 | -0.05 |  |
| | | | | | _Vibrance offset._ |
| Indoor Temperature | `indoorTemperature` | slider | -0.5 … 0.5 | -0.02 |  |
| | | | | | _White-balance temperature offset._ |
| Indoor Tint | `indoorTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Indoor VignetteStrength | `indoorVignetteStrength` | slider | -0.25 … 0.75 | 0.22 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Indoor MasterGamma | `indoorMasterGamma` | slider | -1 … 1 | 0.06 |  |
| | | | | | _Gamma delta from neutral._ |
| Indoor fade in override (ms) | `indoorFadeInMs` | slider | 0 … 10000 | 0 |  |
| | | | | | _0 = use global fade in._ |
| Indoor fade out override (ms) | `indoorFadeOutMs` | slider | 0 … 15000 | 0 |  |
| | | | | | _0 = use global fade out._ |
| Indoor easing in | `indoorEasingIn` | dropdown |  / linear / smooth / easeIn / easeOut / easeInOut / exp / overshoot |  |  |
| Indoor easing out | `indoorEasingOut` | dropdown |  / linear / smooth / easeIn / easeOut / easeInOut / exp / overshoot |  |  |
| Clear threshold | `envClearThreshold` | slider | 0 … 0.4 | 0.18 |  |
| Normal darkness threshold | `envDarknessNormalThreshold` | slider | 0.2 … 0.8 | 0.55 |  |
| Building shadow sensitivity | `buildingShadowSensitivity` | slider | 0 … 100 | 75 |  |
| | | | | | _Higher = triggers on lighter partial shadow. Maps to the sunlit cutoff used when classifying building shadow at the token._ |
| Token footprint scale | `buildingShadowProbeFootprint` | slider | 0.25 … 2.5 | 1 |  |
| | | | | | _Sample center + edges/corners of the token. Higher = wider area (helps when the token straddles shadow edges). Darkest reading wins._ |
| Partial shadow detect | `buildingShadowPartialDetect` | boolean |  | true |  |
| | | | | | _When enabled, penumbra (soft partial shadow) counts as in shadow, not only deep umbra._ |
| Manual lit thresholds | `buildingShadowUseAdvancedThresholds` | boolean |  | false |  |
| | | | | | _Use Building shadow lit low/high below instead of the sensitivity slider._ |
| Building shadow lit low | `buildingShadowLitLow` | slider | 0.2 … 0.99 | 0.88 |  |
| | | | | | _Advanced only. Lit factor (R) at or below → definite shadow._ |
| Building shadow lit high | `buildingShadowLitHigh` | slider | 0.3 … 1 | 0.94 |  |
| | | | | | _Advanced only. Lit at or above → full sunlit (leave building shadow)._ |
| Overcast Exposure | `envOvercastExposure` | slider | -2 … 2 | -0.06 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Overcast Saturation | `envOvercastSaturation` | slider | -1 … 1 | -0.08 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Overcast Brightness | `envOvercastBrightness` | slider | -0.5 … 0.5 | 0.02 |  |
| | | | | | _Brightness offset._ |
| Overcast Contrast | `envOvercastContrast` | slider | -1 … 1 | -0.04 |  |
| | | | | | _Contrast delta from 1.0._ |
| Overcast Vibrance | `envOvercastVibrance` | slider | -1 … 1 | -0.05 |  |
| | | | | | _Vibrance offset._ |
| Overcast Temperature | `envOvercastTemperature` | slider | -0.5 … 0.5 | -0.04 |  |
| | | | | | _White-balance temperature offset._ |
| Overcast Tint | `envOvercastTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Overcast VignetteStrength | `envOvercastVignetteStrength` | slider | -0.25 … 0.75 | 0 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Overcast MasterGamma | `envOvercastMasterGamma` | slider | -1 … 1 | 0.02 |  |
| | | | | | _Gamma delta from neutral._ |
| Storm Exposure | `envStormExposure` | slider | -2 … 2 | -0.12 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Storm Saturation | `envStormSaturation` | slider | -1 … 1 | -0.12 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Storm Brightness | `envStormBrightness` | slider | -0.5 … 0.5 | -0.02 |  |
| | | | | | _Brightness offset._ |
| Storm Contrast | `envStormContrast` | slider | -1 … 1 | -0.06 |  |
| | | | | | _Contrast delta from 1.0._ |
| Storm Vibrance | `envStormVibrance` | slider | -1 … 1 | -0.08 |  |
| | | | | | _Vibrance offset._ |
| Storm Temperature | `envStormTemperature` | slider | -0.5 … 0.5 | -0.06 |  |
| | | | | | _White-balance temperature offset._ |
| Storm Tint | `envStormTint` | slider | -0.5 … 0.5 | 0.02 |  |
| | | | | | _White-balance tint offset._ |
| Storm VignetteStrength | `envStormVignetteStrength` | slider | -0.25 … 0.75 | 0.06 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Storm MasterGamma | `envStormMasterGamma` | slider | -1 … 1 | 0.04 |  |
| | | | | | _Gamma delta from neutral._ |
| Night Exposure | `envNightExposure` | slider | -2 … 2 | -0.1 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Night Saturation | `envNightSaturation` | slider | -1 … 1 | -0.06 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Night Brightness | `envNightBrightness` | slider | -0.5 … 0.5 | -0.03 |  |
| | | | | | _Brightness offset._ |
| Night Contrast | `envNightContrast` | slider | -1 … 1 | 0 |  |
| | | | | | _Contrast delta from 1.0._ |
| Night Vibrance | `envNightVibrance` | slider | -1 … 1 | -0.04 |  |
| | | | | | _Vibrance offset._ |
| Night Temperature | `envNightTemperature` | slider | -0.5 … 0.5 | -0.05 |  |
| | | | | | _White-balance temperature offset._ |
| Night Tint | `envNightTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Night VignetteStrength | `envNightVignetteStrength` | slider | -0.25 … 0.75 | 0.24 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Night MasterGamma | `envNightMasterGamma` | slider | -1 … 1 | 0.05 |  |
| | | | | | _Gamma delta from neutral._ |
| Twilight Exposure | `envTwilightExposure` | slider | -2 … 2 | -0.04 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Twilight Saturation | `envTwilightSaturation` | slider | -1 … 1 | -0.03 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Twilight Brightness | `envTwilightBrightness` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _Brightness offset._ |
| Twilight Contrast | `envTwilightContrast` | slider | -1 … 1 | 0 |  |
| | | | | | _Contrast delta from 1.0._ |
| Twilight Vibrance | `envTwilightVibrance` | slider | -1 … 1 | 0 |  |
| | | | | | _Vibrance offset._ |
| Twilight Temperature | `envTwilightTemperature` | slider | -0.5 … 0.5 | 0.03 |  |
| | | | | | _White-balance temperature offset._ |
| Twilight Tint | `envTwilightTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Twilight VignetteStrength | `envTwilightVignetteStrength` | slider | -0.25 … 0.75 | 0.1 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Twilight MasterGamma | `envTwilightMasterGamma` | slider | -1 … 1 | 0.02 |  |
| | | | | | _Gamma delta from neutral._ |
| Darkness Exposure | `envDarknessExposure` | slider | -2 … 2 | -0.08 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Darkness Saturation | `envDarknessSaturation` | slider | -1 … 1 | -0.05 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Darkness Brightness | `envDarknessBrightness` | slider | -0.5 … 0.5 | -0.02 |  |
| | | | | | _Brightness offset._ |
| Darkness Contrast | `envDarknessContrast` | slider | -1 … 1 | 0.02 |  |
| | | | | | _Contrast delta from 1.0._ |
| Darkness Vibrance | `envDarknessVibrance` | slider | -1 … 1 | -0.03 |  |
| | | | | | _Vibrance offset._ |
| Darkness Temperature | `envDarknessTemperature` | slider | -0.5 … 0.5 | -0.02 |  |
| | | | | | _White-balance temperature offset._ |
| Darkness Tint | `envDarknessTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Darkness VignetteStrength | `envDarknessVignetteStrength` | slider | -0.25 … 0.75 | 0.18 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Darkness MasterGamma | `envDarknessMasterGamma` | slider | -1 … 1 | 0.06 |  |
| | | | | | _Gamma delta from neutral._ |
| Outdoor overcast Exposure | `modOutdoorOvercastExposure` | slider | -2 … 2 | -0.05 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Outdoor overcast Saturation | `modOutdoorOvercastSaturation` | slider | -1 … 1 | -0.06 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Outdoor overcast Brightness | `modOutdoorOvercastBrightness` | slider | -0.5 … 0.5 | 0.01 |  |
| | | | | | _Brightness offset._ |
| Outdoor overcast Contrast | `modOutdoorOvercastContrast` | slider | -1 … 1 | -0.03 |  |
| | | | | | _Contrast delta from 1.0._ |
| Outdoor overcast Vibrance | `modOutdoorOvercastVibrance` | slider | -1 … 1 | -0.04 |  |
| | | | | | _Vibrance offset._ |
| Outdoor overcast Temperature | `modOutdoorOvercastTemperature` | slider | -0.5 … 0.5 | -0.03 |  |
| | | | | | _White-balance temperature offset._ |
| Outdoor overcast Tint | `modOutdoorOvercastTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Outdoor overcast VignetteStrength | `modOutdoorOvercastVignetteStrength` | slider | -0.25 … 0.75 | 0 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Outdoor overcast MasterGamma | `modOutdoorOvercastMasterGamma` | slider | -1 … 1 | 0 |  |
| | | | | | _Gamma delta from neutral._ |
| Cloud shadow Exposure | `modCloudShadowExposure` | slider | -2 … 2 | -0.14 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Cloud shadow Saturation | `modCloudShadowSaturation` | slider | -1 … 1 | -0.05 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Cloud shadow Brightness | `modCloudShadowBrightness` | slider | -0.5 … 0.5 | -0.03 |  |
| | | | | | _Brightness offset._ |
| Cloud shadow Contrast | `modCloudShadowContrast` | slider | -1 … 1 | -0.02 |  |
| | | | | | _Contrast delta from 1.0._ |
| Cloud shadow Vibrance | `modCloudShadowVibrance` | slider | -1 … 1 | -0.03 |  |
| | | | | | _Vibrance offset._ |
| Cloud shadow Temperature | `modCloudShadowTemperature` | slider | -0.5 … 0.5 | -0.08 |  |
| | | | | | _White-balance temperature offset._ |
| Cloud shadow Tint | `modCloudShadowTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Cloud shadow VignetteStrength | `modCloudShadowVignetteStrength` | slider | -0.25 … 0.75 | 0 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Cloud shadow MasterGamma | `modCloudShadowMasterGamma` | slider | -1 … 1 | 0.02 |  |
| | | | | | _Gamma delta from neutral._ |
| Canopy Exposure | `modCanopyExposure` | slider | -2 … 2 | -0.1 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Canopy Saturation | `modCanopySaturation` | slider | -1 … 1 | -0.04 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Canopy Brightness | `modCanopyBrightness` | slider | -0.5 … 0.5 | -0.02 |  |
| | | | | | _Brightness offset._ |
| Canopy Contrast | `modCanopyContrast` | slider | -1 … 1 | -0.02 |  |
| | | | | | _Contrast delta from 1.0._ |
| Canopy Vibrance | `modCanopyVibrance` | slider | -1 … 1 | 0.02 |  |
| | | | | | _Vibrance offset._ |
| Canopy Temperature | `modCanopyTemperature` | slider | -0.5 … 0.5 | -0.03 |  |
| | | | | | _White-balance temperature offset._ |
| Canopy Tint | `modCanopyTint` | slider | -0.5 … 0.5 | 0.01 |  |
| | | | | | _White-balance tint offset._ |
| Canopy VignetteStrength | `modCanopyVignetteStrength` | slider | -0.25 … 0.75 | 0.04 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Canopy MasterGamma | `modCanopyMasterGamma` | slider | -1 … 1 | 0.03 |  |
| | | | | | _Gamma delta from neutral._ |
| Window-lit Exposure | `modWindowLitExposure` | slider | -2 … 2 | 0.12 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Window-lit Saturation | `modWindowLitSaturation` | slider | -1 … 1 | 0.04 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Window-lit Brightness | `modWindowLitBrightness` | slider | -0.5 … 0.5 | 0.05 |  |
| | | | | | _Brightness offset._ |
| Window-lit Contrast | `modWindowLitContrast` | slider | -1 … 1 | 0.02 |  |
| | | | | | _Contrast delta from 1.0._ |
| Window-lit Vibrance | `modWindowLitVibrance` | slider | -1 … 1 | 0.03 |  |
| | | | | | _Vibrance offset._ |
| Window-lit Temperature | `modWindowLitTemperature` | slider | -0.5 … 0.5 | 0.06 |  |
| | | | | | _White-balance temperature offset._ |
| Window-lit Tint | `modWindowLitTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Window-lit VignetteStrength | `modWindowLitVignetteStrength` | slider | -0.25 … 0.75 | -0.08 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Window-lit MasterGamma | `modWindowLitMasterGamma` | slider | -1 … 1 | -0.03 |  |
| | | | | | _Gamma delta from neutral._ |
| Building shadow Exposure | `modBuildingShadowExposure` | slider | -2 … 2 | -0.4 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Building shadow Saturation | `modBuildingShadowSaturation` | slider | -1 … 1 | -0.05 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Building shadow Brightness | `modBuildingShadowBrightness` | slider | -0.5 … 0.5 | -0.02 |  |
| | | | | | _Brightness offset._ |
| Building shadow Contrast | `modBuildingShadowContrast` | slider | -1 … 1 | 0.05 |  |
| | | | | | _Contrast delta from 1.0._ |
| Building shadow Vibrance | `modBuildingShadowVibrance` | slider | -1 … 1 | -0.03 |  |
| | | | | | _Vibrance offset._ |
| Building shadow Temperature | `modBuildingShadowTemperature` | slider | -0.5 … 0.5 | -0.02 |  |
| | | | | | _White-balance temperature offset._ |
| Building shadow Tint | `modBuildingShadowTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Building shadow VignetteStrength | `modBuildingShadowVignetteStrength` | slider | -0.25 … 0.75 | 0.08 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Building shadow MasterGamma | `modBuildingShadowMasterGamma` | slider | -1 … 1 | 0.04 |  |
| | | | | | _Gamma delta from neutral._ |
| Painted shadow Exposure | `modPaintedShadowExposure` | slider | -2 … 2 | -0.18 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Painted shadow Saturation | `modPaintedShadowSaturation` | slider | -1 … 1 | 0 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Painted shadow Brightness | `modPaintedShadowBrightness` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _Brightness offset._ |
| Painted shadow Contrast | `modPaintedShadowContrast` | slider | -1 … 1 | 0 |  |
| | | | | | _Contrast delta from 1.0._ |
| Painted shadow Vibrance | `modPaintedShadowVibrance` | slider | -1 … 1 | 0 |  |
| | | | | | _Vibrance offset._ |
| Painted shadow Temperature | `modPaintedShadowTemperature` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance temperature offset._ |
| Painted shadow Tint | `modPaintedShadowTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Painted shadow VignetteStrength | `modPaintedShadowVignetteStrength` | slider | -0.25 … 0.75 | 0 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Painted shadow MasterGamma | `modPaintedShadowMasterGamma` | slider | -1 … 1 | 0 |  |
| | | | | | _Gamma delta from neutral._ |
| Tree dapple (uniform) Exposure | `modTreeDappleExposure` | slider | -2 … 2 | -0.06 |  |
| | | | | | _Additive exposure stops when this context is active._ |
| Tree dapple (uniform) Saturation | `modTreeDappleSaturation` | slider | -1 … 1 | -0.02 |  |
| | | | | | _Saturation delta from neutral (0 = unchanged)._ |
| Tree dapple (uniform) Brightness | `modTreeDappleBrightness` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _Brightness offset._ |
| Tree dapple (uniform) Contrast | `modTreeDappleContrast` | slider | -1 … 1 | 0 |  |
| | | | | | _Contrast delta from 1.0._ |
| Tree dapple (uniform) Vibrance | `modTreeDappleVibrance` | slider | -1 … 1 | 0.03 |  |
| | | | | | _Vibrance offset._ |
| Tree dapple (uniform) Temperature | `modTreeDappleTemperature` | slider | -0.5 … 0.5 | -0.02 |  |
| | | | | | _White-balance temperature offset._ |
| Tree dapple (uniform) Tint | `modTreeDappleTint` | slider | -0.5 … 0.5 | 0 |  |
| | | | | | _White-balance tint offset._ |
| Tree dapple (uniform) VignetteStrength | `modTreeDappleVignetteStrength` | slider | -0.25 … 0.75 | 0 |  |
| | | | | | _Contextual edge darkening when this trigger is active. Negative values lighten edges (e.g. window-lit). Stacks additively across triggers._ |
| Tree dapple (uniform) MasterGamma | `modTreeDappleMasterGamma` | slider | -1 … 1 | 0 |  |
| | | | | | _Gamma delta from neutral._ |
