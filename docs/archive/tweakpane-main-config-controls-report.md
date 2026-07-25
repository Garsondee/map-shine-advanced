# Map Shine Main Config Panel — Tweakpane Controls Report

Generated: 2026-06-24

Complete inventory of controls in the main **Map Shine Advanced** Tweakpane panel (`TweakpaneManager`).
Effect parameters are parsed from each effect's `getControlSchema()` source. Standard per-effect chrome (Enabled, Reset, etc.) is listed explicitly.

**Notes:**

- Controls tagged _advanced_ are hidden until **Advanced Mode** is enabled in the toolbar.
- Controls tagged _GM only_ render only for GMs.
- _Hidden_ parameters exist in schema but do not render in the panel.
- Weather **Rain Particles** group is registered under **Particles & VFX** via `categoryId`.

## Panel chrome (always visible)

### Universal toolbar

- **Scene status** — ON/OFF badge + Enable/Disable toggle _(GM only)_
- **Filter sections…** — search input
- **Advanced Mode** — checkbox _(reveals advanced-tagged controls)_

### Presets bar

- **Presets** — scene preset dropdown (built-in JSON presets + Custom)
- **Revert** — button _(visible after preset apply)_

---

## Top-level sections (outside effect categories)

### Quick Actions

Grid buttons _(several marked advanced — hidden until Advanced Mode)_:

| Button                | Advanced        |
| --------------------- | --------------- |
| Defaults              | yes             |
| Undo Defaults         | yes             |
| Texture Manager       | yes             |
| Effect Stack          | yes             |
| Streaming Minimap     | yes             |
| Tile Streaming Report | no              |
| Diagnostic Center     | yes             |
| Pixel Probe           | yes             |
| Breaker Box           | yes             |
| Performance Recorder  | yes             |
| Map Points            | no _(GM only)_  |
| Tile Motion           | no              |
| Token Movement        | no              |
| Camera Path           | no _(GM only)_  |
| Levels Authoring      | no _(GM only)_  |
| Copy From Scene       | yes _(GM only)_ |
| Reset Effects…        | yes _(GM only)_ |
| Apply to All Scenes…  | yes _(GM only)_ |
| Scene Recovery        | yes             |
| Scene Reset           | yes             |

### Panel Appearance

- **Colour scheme** (dropdown)

### Intros

- **Enable** (toggle)
- **Loading Screens…** (button)

### Getting Started _(onboarding only — scene not yet enabled)_

- Description text
- **Enable Map Shine Advanced for this Scene** / **Upgrade Scene…** (button)

### Support & Links _(advanced primary folder)_

- Report a Bug (link)
- Documentation (link)
- Discord (link)

---

## Gameplay & Interaction _(category)_

### Tokens & Character Rendering

#### Color Correction

- **Enabled**
- **Exposure**
- **Brightness**
- **Contrast**
- **Saturation**
- **Gamma** _(advanced)_
- **Temperature** _(advanced)_
- **Tint** _(advanced)_
- **Window Light Intensity** _(advanced)_
- **Reset Token CC** (button)

---

## Lighting & Shadows _(category)_

### Sun & Shadows

#### Direction

- **Sun latitude**

#### Time-of-day softness _(advanced folder)_

- **Noon (sharp)**
- **Golden hour (soft)**
- **Midnight (moon)**
- **Golden hour width (h)**
- **Noon peak width (h)**
- **Midnight peak width (h)**

#### Length & smear _(advanced folder)_

- **Noon length**
- **Golden hour length**
- **Midnight length**
- **Noon smear**
- **Golden hour smear**
- **Midnight smear**

#### Weather _(advanced folder)_

- **Cloud softness boost**

---

## Camera & Post _(category — external integrations)_

### Dice So Nice

- **Enabled**
- **Performance** _(advanced folder)_: Preset, Max Pixel Ratio, Max Upload FPS, Hide Delay (ms)
- **Look**: Opacity, Tint, Brightness, Saturation, Contrast, Gamma _(advanced)_
- **Reset Dice So Nice Look** (button)

### Sequencer / JB2A

- **Enabled**
- **Look**: Brightness, Tint
- **Mirror scale** _(advanced)_: Footprint multiplier
- **Placement** _(advanced)_: Along-cast delta, Toward target (+px), Z bias (world), Forward Pivot, Reverse Pivot
- **Diagnostics**: Probe Active Mirrors, Probe Active Mirrors (Deep)
- **Reset Sequencer Look + Placement** (button)

---

## Particles & VFX _(category)_

### Rope & Chain

- **Rope Texture** + Browse Rope Texture (button)
- **Chain Texture** + Browse Chain Texture (button)

#### Rope Defaults _(advanced)_

Segment Length, Damping, Wind Force, Wind Gust Amount, Invert Wind Direction, Gravity Strength, Slack Factor, Bend Stiffness, Constraint Iterations, Width, Tapering, UV Repeat (px), Window Light Boost, End Fade Size, End Fade Strength

#### Chain Defaults _(advanced)_

Same controls as Rope Defaults

---

## Developer Tools _(category — advanced primary folder)_

### UI

- **Run UI Validator** (button)

### Settings

- Copy Non-Default Settings, Copy Changed This Session, Copy All Current Settings (buttons)

### Scene

- Dump Surface Report, Pixel Probe — Pick on Map (A/B/C), Pixel Probe — Show Last Report, Pixel Probe — Cancel Pick, Paste Scene Settings, Copy effects from another scene… (buttons)

### Calibration

- **Calibration Mode** (dropdown)
- Chart Spec Path, Run Calibration Scan, Export Calibration Report, Run Calibration Scan (v2 tiled), **Workflow: apply neutral first**, Run Full Calibration Workflow, Apply Calibration Neutral Preset (buttons)

### Mask Registry

- Dump Registry State (button)
- Dump Tile Contributions (button)
- **Mask Type Toggles** _(folder)_: water, fire, outdoors, windows, specular, normal, tree, bush, dust, ash, iridescence, prism, roughness, fluid

### Mask overlay (V2)

- **Show overlay**
- **Mask** (dropdown)
- **Opacity**

### Indoors vs Outdoors (effective mask)

- **Show debug view**
- **View** (dropdown)
- **Replace scene (B&W)**
- **Overlay opacity**
- **Defringe strength**
- **Indoor edge cutoff**
- **Edge outdoor bleed**
- Rebuild masks (defringe), Log stack diagnostics (buttons)

### VRAM Budget

- Dump Budget State (button)

---

## Registered effects by category

## Gameplay & Interaction

### Player Light

- **Effect ID:** `player-light`
- **Category:** Gameplay & Interaction

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### General

- **Torch Max Dist (u)** (`torchMaxDistanceUnits`) — slider
- **Flashlight Max Dist (u)** (`flashlightMaxDistanceUnits`) — slider
- **Fade Band (u)** (`fadeOutDistanceUnits`) — slider
- **Wall Block** (`wallBlockEnabled`) — boolean
- **Debug Readout** (`debugReadoutEnabled`) — advanced, boolean

##### Day / Night

- **Auto Day/Night** (`autoDayNightBalance`) — boolean
- **Day Scale** (`dayIntensityScale`) — slider
- **Night Scale** (`nightIntensityScale`) — slider
- **Darkness Curve** (`dayNightCurve`) — slider
- **Darkness Cancel** (`lightDarknessCancel`) — slider
- **Night Cancel Boost** (`lightDarknessNightBoost`) — slider
- **Follow Point Light Gain** (`lightFollowLightIntensity`) — boolean

##### Flashlight _(advanced)_

- **Intensity** (`flashlightIntensity`) — slider
- **Legacy Cone Angle (deg)** (`flashlightAngleDeg`) — slider
- **Legacy Cone Length (u)** (`flashlightLengthUnits`) — slider
- **Angle (deg)** (`flashlightBeamAngleDeg`) — slider
- **Length (u)** (`flashlightBeamLengthUnits`) — slider
- **Width Scale** (`flashlightBeamWidthScale`) — slider
- **Near Width** (`flashlightBeamNearWidth`) — slider
- **Far Width** (`flashlightBeamFarWidth`) — slider
- **Width Curve** (`flashlightBeamWidthCurve`) — slider
- **Edge Softness** (`flashlightBeamEdgeSoftness`) — slider
- **Core Intensity** (`flashlightBeamCoreIntensity`) — slider
- **Core Sharpness** (`flashlightBeamCoreSharpness`) — slider
- **Mid Intensity** (`flashlightBeamMidIntensity`) — slider
- **Mid Sharpness** (`flashlightBeamMidSharpness`) — slider
- **Rim Intensity** (`flashlightBeamRimIntensity`) — slider
- **Rim Sharpness** (`flashlightBeamRimSharpness`) — slider
- **Near Boost** (`flashlightBeamNearBoost`) — slider
- **Near Boost Curve** (`flashlightBeamNearBoostCurve`) — slider
- **Long Falloff** (`flashlightBeamLongFalloffExp`) — slider
- **Noise Amount** (`flashlightBeamNoiseIntensity`) — slider
- **Noise Scale** (`flashlightBeamNoiseScale`) — slider
- **Noise Speed** (`flashlightBeamNoiseSpeed`) — slider

##### Torch _(advanced)_

- **Spring Stiffness** (`springStiffness`) — slider
- **Spring Damping** (`springDamping`) — slider
- **Enabled** (`torchLightEnabled`) — boolean
- **Base Intensity** (`torchBaseIntensity`) — slider
- **Ember Intensity** (`emberIntensity`) — slider
- **Gutter: Disable Light** (`torchGutterDisableLight`) — boolean
- **Gutter: Life Scale** (`torchGutterLifeScale`) — slider
- **Reignite Requires Touch** (`torchReigniteRequiresTouch`) — boolean
- **Reignite Touch Extra (u)** (`torchReigniteTouchExtraUnits`) — slider
- **Rise Speed** (`intensityRiseSpeed`) — slider
- **Fall Speed** (`intensityFallSpeed`) — slider
- **Color** (`torchLightColor`) — color
- **Flicker Amount** (`flickerIntensity`) — slider
- **Flicker Speed** (`flickerSpeed`) — slider
- **Wander (px)** (`wanderPixels`) — slider
- **Wander Speed** (`wanderSpeed`) — slider

##### Night vision _(advanced)_

- **Eyepiece Style** (`nightVisionEyepieceStyle`) — list
- **Eyepiece Radius** (`nightVisionEyepieceRadius`) — slider
- **Eyepiece Softness** (`nightVisionEyepieceSoftness`) — slider
- **Eyepiece Intensity** (`nightVisionEyepieceIntensity`) — slider
- **Eyepiece Edge Color** (`nightVisionEyepieceColor`) — color
- **Binocular Separation** (`nightVisionEyepieceSeparation`) — slider
- **Tint** (`nightVisionTint`) — color
- **Tint Strength** (`nightVisionTintStrength`) — slider
- **Saturation** (`nightVisionSaturation`) — slider
- **Brightness** (`nightVisionBrightness`) — slider

#### Ungrouped parameters

- **Cookie** (`flashlightCookieTexture`) — list
- **Rotate Cookie** (`flashlightCookieRotation`) — boolean
- **Rotation Speed** (`flashlightCookieRotationSpeed`) — slider
- **Intensity Mult** (`flashlightCookieIntensity`) — slider
- **Size (px)** (`flashlightCookieSizePx`) — slider
- **Size From Beam** (`flashlightCookieSizeFromBeam`) — slider
- **Mask Radius** (`flashlightCookieMaskRadius`) — slider
- **Mask Softness** (`flashlightCookieMaskSoftness`) — slider
- **Core Intensity** (`flashlightCookieCoreIntensity`) — slider
- **Core Sharpness** (`flashlightCookieCoreSharpness`) — slider
- **Rim Intensity** (`flashlightCookieRimIntensity`) — slider
- **Rim Radius** (`flashlightCookieRimRadius`) — slider
- **Rim Width** (`flashlightCookieRimWidth`) — slider
- **Perspective** (`flashlightCookiePerspectiveEnabled`) — boolean
- **Perspective Near** (`flashlightCookiePerspectiveNearScale`) — slider
- **Perspective Far** (`flashlightCookiePerspectiveFarScale`) — slider
- **Perspective Curve** (`flashlightCookiePerspectiveCurve`) — slider
- **Perspective Stretch** (`flashlightCookiePerspectiveAnamorphic`) — slider
- **Dim Radius (u)** (`torchLightDim`) — slider
- **Bright Radius (u)** (`torchLightBright`) — slider
- **Alpha** (`torchLightAlpha`) — slider
- **Attenuation** (`torchLightAttenuation`) — slider
- **Luminosity** (`torchLightLuminosity`) — slider
- **Animation** (`torchLightAnimType`) — list
- **Anim Speed** (`torchLightAnimSpeed`) — slider
- **Anim Intensity** (`torchLightAnimIntensity`) — slider
- **Scale With Torch** (`torchLightScaleWithIntensity`) — boolean
- **Size Min (px)** (`torchFlameSizeMin`) — slider
- **Size Max (px)** (`torchFlameSizeMax`) — slider
- **Rate Min** (`torchFlameRateMin`) — slider
- **Rate Max** (`torchFlameRateMax`) — slider
- **Updraft** (`torchFlameUpdraft`) — slider
- **Wind Influence** (`torchFlameWindInfluence`) — slider
- **Enabled** (`torchSparksEnabled`) — boolean
- **Rate** (`torchSparksRate`) — slider
- **Size Min (px)** (`torchSparksSizeMin`) — slider
- **Size Max (px)** (`torchSparksSizeMax`) — slider
- **Life Min (s)** (`torchSparksLifeMin`) — slider
- **Life Max (s)** (`torchSparksLifeMax`) — slider
- **Updraft** (`torchSparksUpdraft`) — slider
- **Wind Influence** (`torchSparksWindInfluence`) — slider
- **Streak Factor** (`torchSparksSpeedFactor`) — slider
- **Enabled** (`flashlightLightEnabled`) — boolean
- **Color** (`flashlightLightColor`) — color
- **Dim Radius (u)** (`flashlightLightDim`) — slider
- **Bright Radius (u)** (`flashlightLightBright`) — slider
- **Alpha** (`flashlightLightAlpha`) — slider
- **Attenuation** (`flashlightLightAttenuation`) — slider
- **Luminosity** (`flashlightLightLuminosity`) — slider
- **Animation** (`flashlightLightAnimType`) — list
- **Anim Speed** (`flashlightLightAnimSpeed`) — slider
- **Anim Intensity** (`flashlightLightAnimIntensity`) — slider
- **Use Cookie Pos** (`flashlightLightUseCookiePosition`) — boolean
- **Distance Scaling** (`flashlightLightDistanceScaleEnabled`) — boolean
- **Near Scale** (`flashlightLightDistanceScaleNear`) — slider
- **Far Scale** (`flashlightLightDistanceScaleFar`) — slider
- **Purkinje Strength** (`nightVisionPurkinjeStrength`) — slider
- **Purkinje Dark Start** (`nightVisionPurkinjeDarkStart`) — slider
- **Purkinje Bright End** (`nightVisionPurkinjeBrightEnd`) — slider
- **Purkinje Curve** (`nightVisionPurkinjeCurve`) — slider
- **Gain (× linear)** (`nightVisionGain`) — slider
- **Shadow Lift Curve** (`nightVisionGamma`) — slider
- **Peak Luma (soft knee)** (`nightVisionMaxLuma`) — slider
- **Black Level (linear)** (`nightVisionDarkLift`) — slider
- **Scanlines** (`nightVisionScanlinesEnabled`) — boolean
- **Scanline Intensity** (`nightVisionScanlinesIntensity`) — slider
- **Scanline Density** (`nightVisionScanlinesDensity`) — slider
- **Scanline Speed** (`nightVisionScanlinesSpeed`) — slider
- **Scanline Thickness** (`nightVisionScanlinesThickness`) — slider
- **Noise Amount** (`nightVisionNoiseAmount`) — slider
- **Noise Low-Light Boost** (`nightVisionNoiseLowLightBoost`) — slider
- **Noise Speed** (`nightVisionNoiseSpeed`) — slider
- **Noise Scale** (`nightVisionNoiseScale`) — slider
- **Phosphor Flicker** (`nightVisionPhosphorFlickerAmount`) — slider
- **Phosphor Flicker Speed** (`nightVisionPhosphorFlickerSpeed`) — slider
- **Phosphor Size** (`nightVisionPhosphorSize`) — slider
- **Phosphor Density** (`nightVisionPhosphorDensity`) — slider
- **Phosphor Intensity** (`nightVisionPhosphorIntensity`) — slider
- **Bloom / Burn-In** (`nightVisionBloomEnabled`) — boolean
- **Bloom Threshold (linear)** (`nightVisionBloomThreshold`) — slider
- **Threshold Softness** (`nightVisionBloomThresholdSoftness`) — slider
- **Bloom Intensity** (`nightVisionBloomIntensity`) — slider
- **Bloom Blur (px)** (`nightVisionBloomBlurPx`) — slider
- **Burn Persistence (s)** (`nightVisionBloomPersistenceSeconds`) — slider
- **Bloom Response** (`nightVisionBloomResponse`) — slider
- **Distortion** (`nightVisionDistortionAmount`) — slider
- **Chromatic Aberration (px)** (`nightVisionCAAmount`) — slider
- **CA Edge Power** (`nightVisionCAEdgePower`) — slider
- **Warm-up (s)** (`nightVisionWarmupSeconds`) — slider
- **Shutdown (s)** (`nightVisionShutdownSeconds`) — slider
- **Warm-up Power Flicker** (`nightVisionPowerFlickerEnabled`) — boolean
- **Power Flicker Intensity** (`nightVisionPowerFlickerIntensity`) — slider
- **Auto-Dim by Scene Darkness** (`nightVisionDarknessGateEnabled`) — boolean
- **Darkness Gate Start** (`nightVisionDarknessStart`) — slider
- **Darkness Gate End** (`nightVisionDarknessEnd`) — slider
- **Darkness Influence** (`nightVisionDarknessInfluence`) — slider

### Fog of War

- **Effect ID:** `fog`
- **Category:** Gameplay & Interaction

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Fog of War

- **Unexplored** (`unexploredColor`) — color
- **Explored Tint** (`exploredColor`) — color
- **Explored Opacity** (`exploredOpacity`) — slider
- **Edge Softness** (`softness`) — slider
- **Edge Distortion (px)** (`noiseStrength`) — slider
- **Distortion Speed** (`noiseSpeed`) — slider
- **Reveal Token Bubbles** (`revealTokenInFogEnabled`) — boolean
- **Door Sync** (`doorFogSyncEnabled`) — boolean
- **Door Sync Thickness** (`doorFogSyncThickness`) — advanced, slider
- **Door Sync Duration (ms)** (`doorFogSyncDefaultDurationMs`) — advanced, slider

### Vision Mode

- **Effect ID:** `visionMode`
- **Category:** Gameplay & Interaction

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameters (flat)

### Grid

- **Effect ID:** `grid`
- **Category:** Gameplay & Interaction

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameters (flat)

- **Style (Override)** (`style`)
- **Override Style** (`useStyleOverride`)
- **Thickness (Override)** (`thickness`)
- **Override Thickness** (`useThicknessOverride`)
- **Color (Override)** (`colorOverride`)
- **Override Color** (`useColorOverride`)
- **Opacity (Override)** (`alphaOverride`)
- **Override Opacity** (`useAlphaOverride`)
- **Show Adjacent Floor Grids** (`ghostGridEnabled`) — advanced
- **Adjacent Grid Opacity Scale** (`ghostGridAlphaScale`) — advanced
- **Floor Color Tinting** (`floorTintPresetsEnabled`) — advanced

### Floor Depth Blur

- **Effect ID:** `floor-depth-blur`
- **Category:** Gameplay & Interaction

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Look

- **Blur per level (px)** (`blurRadiusPx`) — slider
- **Smoothness passes** (`itersPerDepth`) — advanced, slider
- **Work limit** (`maxIters`) — advanced, slider

### Contextual Scene Grade

- **Effect ID:** `contextualSceneGrade`
- **Category:** Gameplay & Interaction

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)
- **Open live diagnostics…** (button)

#### Parameter groups

##### Engine logic

- **Probe interval (s)** (`probeIntervalSec`) — slider
- **Move gate (px)** (`moveGateGrid`) — slider
- **Outdoor threshold** (`outdoorThresholdHigh`) — slider
- **Indoor threshold** (`indoorThresholdLow`) — slider
- **Fade in (ms)** (`fadeInMs`) — slider
- **Fade out (ms)** (`fadeOutMs`) — slider
- **Modifier fade (ms)** (`modifierFadeMs`) — slider
- **Cover shadow fade (ms)** (`coverShadowFadeMs`) — slider
- **Easing in** (`easingIn`) — dropdown
- **Easing out** (`easingOut`) — dropdown
- **Eye adaptation** (`eyeAdaptationEnabled`) — boolean
- **Indoor/outdoor adapt (s)** (`eyeAdaptationSec`) — slider
- **Cover shadow adapt (s)** (`coverShadowEyeAdaptationSec`) — slider
- **Adaptation easing** (`eyeAdaptationEasing`) — dropdown

##### Transition drama

- **Drama enabled** (`dramaEnabled`) — boolean
- **Daylight only** (`dramaRequireDaylight`) — boolean
- **Drama strength** (`dramaStrength`) — slider
- **Peak exposure boost** (`dramaPeakExposure`) — slider
- **Peak brightness** (`dramaPeakBrightness`) — slider
- **Peak saturation** (`dramaPeakSaturation`) — slider
- **Peak vibrance** (`dramaPeakVibrance`) — slider
- **Peak vignette lift** (`dramaPeakVignetteLift`) — slider
- **Peak timing** (`dramaPeakAt`) — slider
- **Peak width** (`dramaPeakWidth`) — slider
- **Settle delay** (`dramaSettleDelay`) — slider
- **Settle easing** (`dramaSettleEasing`) — dropdown

##### Environmental thresholds

- **Env modifiers enabled** (`envModifiersEnabled`) — boolean
- **Env lerp (ms)** (`envModifiersLerpMs`) — slider
- **Storm threshold** (`envStormThreshold`) — slider
- **Overcast threshold** (`envOvercastThreshold`) — slider
- **Night threshold** (`envNightThreshold`) — slider
- **Day threshold** (`envDayThreshold`) — slider
- **Heavy darkness threshold** (`envDarknessHeavyThreshold`) — slider

##### Token modifiers _(advanced)_

- **Cloud shadow low** (`cloudShadowThresholdLow`) — slider
- **Cloud shadow high** (`cloudShadowThresholdHigh`) — slider
- **Canopy shaded threshold** (`canopyShadedThreshold`) — slider
- **Canopy open threshold** (`canopyOpenThreshold`) — slider
- **Painted shadow lit low** (`paintedShadowLitLow`) — slider
- **Painted shadow lit high** (`paintedShadowLitHigh`) — slider
- **Tree shadow lit low** (`treeShadowLitLow`) — slider
- **Tree shadow lit high** (`treeShadowLitHigh`) — slider
- **Tree dapple day weight** (`treeDappleDayThreshold`) — slider
- **Outdoor overcast weight** (`modOutdoorOvercastWeight`) — slider
- **Cloud shadow weight** (`modCloudShadowWeight`) — slider
- **Canopy weight** (`modCanopyWeight`) — slider
- **Window-lit blend** (`modWindowLitBlend`) — slider
- **Building shadow weight** (`modBuildingShadowWeight`) — slider
- **Painted shadow weight** (`modPaintedShadowWeight`) — slider
- **Tree dapple weight** (`modTreeDappleWeight`) — slider
- **Tree dapple shader strength** (`modTreeDappleStrength`) — slider
- **Tree dapple cell scale** (`modTreeDappleScale`) — slider
- **Tree dapple green R** (`modTreeDappleGreenR`) — slider
- **Tree dapple green G** (`modTreeDappleGreenG`) — slider
- **Tree dapple green B** (`modTreeDappleGreenB`) — slider

##### Base packs (Indoor / Outdoor)

- **outdoorExposure** (`outdoorExposure`)
- **outdoorSaturation** (`outdoorSaturation`)
- **outdoorBrightness** (`outdoorBrightness`)
- **outdoorContrast** (`outdoorContrast`)
- **outdoorVibrance** (`outdoorVibrance`)
- **outdoorTemperature** (`outdoorTemperature`)
- **outdoorTint** (`outdoorTint`)
- **outdoorVignetteStrength** (`outdoorVignetteStrength`)
- **outdoorMasterGamma** (`outdoorMasterGamma`)
- **Outdoor fade in override (ms)** (`outdoorFadeInMs`) — slider
- **Outdoor fade out override (ms)** (`outdoorFadeOutMs`) — slider
- **Outdoor easing in** (`outdoorEasingIn`) — dropdown
- **Outdoor easing out** (`outdoorEasingOut`) — dropdown

##### Vignette

- **Inner radius** (`contextVignetteInner`) — slider
- **Falloff width** (`contextVignetteSoftness`) — slider
- **Max vignette strength** (`coherenceMaxVignette`) — slider

##### Stack coherence

- **Coherence enabled** (`coherenceEnabled`) — boolean
- **Atmosphere coupling** (`coherenceAtmosphereScale`) — slider
- **Max context exposure** (`coherenceMaxExposure`) — slider
- **Dazzle gate during drama** (`dazzleContextGradeGate`) — slider
- **Spatial context blend** (`contextSpatialEnabled`) — boolean
- **Spatial blend strength** (`contextSpatialStrength`) — slider

##### Status

- **Indoor / Outdoor** (`statusIndoorOutdoor`) — readonly, string
- **Transition** (`statusState`) — readonly, string
- **Context key** (`statusContextKey`) — readonly, string
- **Cover shadow** (`statusCoverShadow`) — readonly, string
- **Eye adaptation** (`statusEyeAdaptation`) — readonly, string
- **Sky condition** (`statusSkyCondition`) — readonly, string
- **Day phase** (`statusDayPhase`) — readonly, string
- **Subject token** (`statusSubject`) — readonly, string
- **Outdoors sample** (`statusOutdoorsSample`) — readonly, string
- **Mask probe** (`statusMaskProbe`) — readonly, string
- **CC overlay** (`statusCcOverlay`) — readonly, string
- **Last probe age** (`statusProbeAge`) — readonly, string

## Lighting & Shadows

### Light Physics

- **Effect ID:** `lighting`
- **Category:** Lighting & Shadows

#### Standard effect chrome

- (?) Effect help (button)
- **World Based** (toggle)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Ambient light (linear HDR)

- **Day ambient — outdoor** (`ambientDayScaleOutdoor`) — slider
- **Day ambient — indoor** (`ambientDayScaleIndoor`) — slider
- **Night ambient — outdoor** (`ambientNightScaleOutdoor`) — slider
- **Night ambient — indoor** (`ambientNightScaleIndoor`) — slider
- **Minimum light floor** (`minIlluminationScale`) — slider

##### Dawn / dusk (twilight)

- **Twilight darkness** (`twilightDarkness`) — slider
- **Day floor — outdoor** (`twilightDayFloorOutdoor`) — slider
- **Day floor — indoor** (`twilightDayFloorIndoor`) — slider
- **Min-light keep — outdoor** (`twilightMinLightKeepOutdoor`) — slider
- **Min-light keep — indoor** (`twilightMinLightKeepIndoor`) — slider

##### Foundry lamps — Day

- **Brightness boost** (`foundryLightBrightnessDay`) — slider
- **Colour boost** (`foundryLightColorBoostDay`) — slider

##### Foundry lamps — Twilight

- **Brightness boost** (`foundryLightBrightnessTwilight`) — slider
- **Colour boost** (`foundryLightColorBoostTwilight`) — slider

##### Foundry lamps — Night

- **Brightness boost** (`foundryLightBrightnessNight`) — slider
- **Colour boost** (`foundryLightColorBoostNight`) — slider

##### Player / shared gain

- **Shared point gain** (`lightIntensity`) — slider

##### Window glow (compose)

- **Window indirect gain** (`windowEmissiveGain`) — slider
- **Window contrast** (`windowIndirectContrast`) — slider
- **Window warmth tint** (`windowWarmthTint`) — slider
- **Wall texture coupling** (`windowAlbedoCoupling`) — slider
- **Window core glow** (`windowScreenSpill`) — slider

##### Point light falloff (half-life)

- **Halving dist. (att 0, bright)** (`falloffHalfInAtAtt0`) — slider
- **Halving dist. (att 1, bright)** (`falloffHalfInAtAtt1`) — slider
- **Halving dist. (att 0, dim)** (`falloffHalfOutAtAtt0`) — slider
- **Halving dist. (att 1, dim)** (`falloffHalfOutAtAtt1`) — slider
- **Min halving step** (`falloffHalfMin`) — slider
- **Edge soft → bright ring** (`falloffEdgeSoftBoostIn`) — slider
- **Edge soft → dim ring** (`falloffEdgeSoftBoostOut`) — slider
- **Bright radius scale** (`falloffBrightNormInfluence`) — slider
- **Dim ring weight** (`falloffDimRingWeight`) — slider
- **Rim AA width** (`falloffRimAAScale`) — slider
- **Attenuation curve** (`falloffAttCurvePower`) — slider
- **Rim band (att 0)** (`falloffRimBandAtAtt0`) — slider
- **Rim band (att 1)** (`falloffRimBandAtAtt1`) — slider
- **Falloff exponent bias** (`falloffExponent`) — slider

##### Lamp colour (HDR radiance buffer) _(advanced)_

- **CI buffer scale** (`colorationMixScale`) — slider
- **Max CI mix** (`colorationMaxMix`) — slider
- **CI curve power** (`colorationMixPower`) — slider
- **Saturation boost gain** (`colorationStrength`) — slider
- **Coloration reflectivity** (`colorationReflectivity`) — slider
- **Saturation boost** (`colorationSaturationBoost`) — slider
- **Colour falloff start** (`colorationFalloffStart`) — slider
- **Colour falloff end** (`colorationFalloffEnd`) — slider
- **Colour falloff curve** (`colorationFalloffPower`) — slider
- **Colour energy gain** (`colorationEnergyGain`) — slider

##### Ambient occlusion from shadows _(advanced)_

- **Combined shadow strength** (`combinedShadowEffectStrength`) — slider
- **Cloud shadow on ambient** (`cloudShadowAmbientInfluence`) — slider
- **Overhead shadow on ambient** (`overheadShadowAmbientInfluence`) — slider
- **Dynamic light shadow override** (`dynamicLightShadowOverrideStrength`) — slider
- **Structural shadow vs sky/day fill** (`structuralSunAmbientOcclusion`) — slider
- **Structural occlusion on HDR lights** (`directStructuralOcclusionStrength`) — slider

##### Roof / floor occlusion _(advanced)_

- **Wall Inset (px)** (`wallInsetPx`) — slider
- **Wall Padding (px)** (`wallPaddingPx`) — slider
- **Multi-floor: roof gate & building roof-cutout top floor only** (`restrictRoofScreenLightOcclusionToTopFloor`) — boolean
- **Upper Floor Through-Gaps** (`upperFloorTransmissionEnabled`) — boolean
- **Upper Light Strength** (`upperFloorTransmissionStrength`) — slider

##### Advanced darkness response _(advanced)_

- **Interior Darkness** (`interiorDarkness`) — slider
- **Negative Darkness Strength** (`negativeDarknessStrength`) — slider
- **Darkness Punch Gain** (`darknessPunchGain`) — slider

##### Advanced light animation _(advanced)_

- **Wind Influence** (`lightAnimWindInfluence`) — slider
- **Outdoor Power** (`lightAnimOutdoorPower`) — slider

##### Performance (internal RT scale) _(advanced)_

- **Foundry lights RT scale** (`internalLightResolutionScale`) — slider
- **Window emit RT scale** (`internalWindowResolutionScale`) — slider
- **Darkness RT scale** (`internalDarknessResolutionScale`) — slider
- **Window emit half-float** (`windowLightUseHalfFloat`) — boolean
- **Window emit cache** (`windowEmitCacheEnabled`) — boolean
- **Light prepass reuse** (`lightPrepassReuseEnabled`) — boolean

#### Ungrouped parameters

- **Lamp saturation** (`colorationSaturation`) — slider
- **Darken tinted** (`colorationDarken`) — slider
- **Brighten tinted** (`colorationBrighten`) — slider
- **Peak preserve** (`colorationPeakPreserve`) — slider
- **Hue shift** (`colorationHueShift`) — slider
- **Chroma curve** (`colorationChromaCurve`) — slider
- **Neutral bleed** (`colorationAchromaticMix`) — slider

### Sky Environment

- **Effect ID:** `sky-color`
- **Category:** Lighting & Shadows

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Sky exports

- **Tint Sun Lights** (`skyTintDarknessLightsEnabled`) — boolean
- **Sun Light Tint Intensity** (`skyTintDarknessLightsIntensity`) — slider

### Window Light

- **Effect ID:** `windowLight`
- **Category:** Lighting & Shadows

#### Standard effect chrome

- (?) Effect help (button)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_outdoors mask status
- \_windows mask status

#### Parameter groups

##### Window Light

- **Intensity** (`intensity`) — slider
- **Falloff (Gamma)** (`falloff`) — slider
- **Light Color** (`color`) — color

##### Glass Refraction

- **Glass Refraction** (`glassRefractionEnabled`) — boolean
- **RGB Shift (px)** (`rgbShiftAmount`) — slider
- **RGB Shift Softness** (`rgbShiftSoftness`) — slider
- **Shift Angle (deg)** (`rgbShiftAngle`) — slider
- **Spectral Spread** (`rgbShiftSpread`) — slider
- **Edge Fringe Weight** (`rgbShiftEdgeWeight`) — slider
- **Fringe Saturation** (`rgbFringeSaturation`) — slider
- **Fringe RGB Balance** (`rgbFringeBalance`) — color

##### Refraction Animation _(advanced)_

- **Animate Refraction** (`rgbShiftAnimate`) — boolean
- **Animation Speed** (`rgbShiftAnimSpeed`) — slider
- **Angle Wobble (deg)** (`rgbShiftAnimWobbleDeg`) — slider

##### Rain on Glass

- **Rain on Glass** (`rainGlassEnabled`) — boolean
- **Weather Response** (`rainGlassWeatherResponse`) — slider
- **Distortion Strength** (`rainGlassStrength`) — slider
- **Drop Scale** (`rainGlassScale`) — slider
- **Streak Stretch** (`rainGlassStretch`) — slider
- **Flow Speed** (`rainGlassSpeed`) — slider
- **Wall Slope Influence** (`rainGlassSlopeInfluence`) — slider
- **Slope Sample Radius** (`rainGlassSlopeSamplePx`) — slider
- **Fallback Direction (deg)** (`rainGlassFallbackAngle`) — slider

##### Sparkle & Glint

- **Sparkle Enabled** (`sparkleEnabled`) — boolean
- **Sparkle Strength** (`sparkleStrength`) — slider
- **Sparkle Speed** (`sparkleSpeed`) — slider
- **Sparkle Density** (`sparkleScale`) — slider
- **Sparkle Core Threshold** (`sparkleThreshold`) — slider
- **Sparkle Edge Bias** (`sparkleEdgeBias`) — slider
- **Sparkle Tint** (`sparkleColor`) — color
- **Specular Boost** (`specularBoost`) — slider

##### Lightning on Windows _(advanced)_

- **Lightning Coupling** (`lightningWindowEnabled`) — boolean
- **Flash Intensity Boost** (`lightningWindowIntensityBoost`) — slider
- **Flash Contrast Boost** (`lightningWindowContrastBoost`) — slider
- **Flash RGB Shift Boost** (`lightningWindowRgbBoost`) — slider

##### Environment

- **Cloud Dimming** (`cloudInfluence`) — slider

##### Cloud Shadows

- **Shadow Contrast** (`cloudShadowContrast`) — slider
- **Shadow Bias** (`cloudShadowBias`) — slider
- **Shadow Gamma** (`cloudShadowGamma`) — slider
- **Min Light** (`cloudShadowMinLight`) — slider

##### Time-of-day window light _(advanced)_

- **todTimelineEnabled** (`todTimelineEnabled`)
- **useCameraGradeAnchorHours** (`useCameraGradeAnchorHours`)

### Bloom Highlights

- **Effect ID:** `bloom`
- **Category:** Lighting & Shadows

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Surface

- **Surface strength** (`strength`) — slider
- **Surface radius** (`radius`) — slider
- **Threshold** (`threshold`) — slider

##### Atmosphere

- **Atmosphere enabled** (`atmoEnabled`) — boolean
- **Atmosphere strength** (`atmoStrength`) — slider
- **Atmosphere radius** (`atmoRadius`) — slider
- **Atmosphere tint** (`atmoTintColor`) — color
- **Atmosphere blend** (`atmoBlendOpacity`) — slider

##### Water specular (bloom) _(advanced)_

- **Link water specular** (`waterSpecularBloomEnabled`) — boolean
- **Water bloom strength** (`waterSpecularBloomStrength`) — slider
- **Water bloom gamma** (`waterSpecularBloomGamma`) — slider

##### Surface grade

- **Surface tint** (`tintColor`) — color
- **Surface blend** (`blendOpacity`) — slider

##### Lightning strike _(advanced)_

- **Adapt during strikes** (`lightningBloomAdaptEnabled`) — boolean
- **Strike threshold boost** (`lightningBloomThresholdBoost`) — slider
- **Strike strength mul** (`lightningBloomStrengthMul`) — slider
- **Strike radius mul** (`lightningBloomRadiusMul`) — slider
- **Strike smooth width** (`lightningBloomSmoothWidth`) — slider
- **Strike blend mul** (`lightningBloomBlendMul`) — slider
- **Passthrough peak** (`lightningBloomPassthroughPeak`) — slider
- **Map-point adapt weight** (`lightningBloomMapPointWeight`) — slider

##### Outdoor spill (window glow) _(advanced)_

- **Suppress outdoor spill** (`outdoorSpillSuppressEnabled`) — boolean
- **Spill lum lo (× threshold)** (`outdoorSpillLumLoMul`) — slider
- **Spill lum hi (× threshold)** (`outdoorSpillLumHiMul`) — slider

##### Fog clip (vision) _(advanced)_

- **Clip to vision (FoW)** (`fogClipEnabled`) — boolean

### Overhead Shadows

- **Effect ID:** `overhead-shadows`
- **Category:** Lighting & Shadows

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Overhead Shadows

- **Shadow Opacity** (`opacity`) — slider
- **Shadow Length** (`length`) — slider
- **Softness** (`softness`) — slider
- **Affects Dynamic Lights** (`affectsLights`) — slider
- **Use Fluid Effect Colour** (`fluidColorEnabled`) — advanced, checkbox
- **Fluid Effect Transparency** (`fluidEffectTransparency`) — advanced, slider
- **Fluid Shadow Intensity Boost** (`fluidShadowIntensityBoost`) — advanced, slider
- **Fluid Shadow Softness** (`fluidShadowSoftness`) — advanced, slider
- **Fluid Colour Boost** (`fluidColorBoost`) — advanced, slider
- **Fluid Colour Saturation** (`fluidColorSaturation`) — advanced, slider

##### Tile Shadow Projection _(advanced)_

- **Enable Tile Shadow Projection** (`tileProjectionEnabled`) — checkbox
- **Tile Projection Strength** (`tileProjectionOpacity`) — slider
- **Tile Projection Length Scale** (`tileProjectionLengthScale`) — slider
- **Tile Projection Softness** (`tileProjectionSoftness`) — slider
- **Tile Alpha Threshold** (`tileProjectionThreshold`) — slider
- **Tile Alpha Contrast** (`tileProjectionPower`) — slider
- **Tile Outdoor Strength Scale** (`tileProjectionOutdoorOpacityScale`) — slider
- **Tile Indoor Strength Scale** (`tileProjectionIndoorOpacityScale`) — slider

##### Receiver Regions _(advanced)_

- **Outdoor Shadow Length Scale** (`outdoorShadowLengthScale`) — slider
- **Indoor Shadow Length Scale** (`indoorReceiverShadowLengthScale`) — slider

##### Debug _(advanced)_

- **Debug View** (`debugView`) — list

### Building Shadows

- **Effect ID:** `building-shadows`
- **Category:** Lighting & Shadows

#### Standard effect chrome

- (?) Effect help (button)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_outdoors mask status

#### Parameter groups

##### Building Shadows

- **Opacity** (`opacity`) — slider
- **Strength boost** (`shadowStrengthBoost`) — advanced, slider
- **Length** (`length`) — slider
- **Softness** (`softness`) — slider
- **Smear** (`smear`) — advanced, slider
- **Resolution** (`resolutionScale`) — advanced, slider
- **Penumbra** (`penumbra`) — advanced, slider
- **Shadow Curve** (`shadowCurve`) — advanced, slider
- **Blur** (`blurRadius`) — advanced, slider
- **Contact preserve** (`contactShadowPreserve`) — advanced, slider
- **Contact blend (low)** (`contactSharpBlendLow`) — advanced, slider
- **Contact blend (high)** (`contactSharpBlendHigh`) — advanced, slider
- **Edge inflate (px)** (`shadowEdgeInflatePx`) — advanced, slider

### Sky Reach Shadows

- **Effect ID:** `sky-reach-shadows`
- **Category:** Lighting & Shadows

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Sky Reach Shadows

- **Opacity** (`opacity`) — slider
- **Length** (`length`) — slider
- **Softness** (`softness`) — slider
- **Smear** (`smear`) — slider
- **Resolution** (`resolutionScale`) — advanced, slider
- **Penumbra** (`penumbra`) — advanced, slider
- **Shadow Curve** (`shadowCurve`) — advanced, slider
- **Blur** (`blurRadius`) — advanced, slider
- **Upper-Floor Combine** (`upperFloorCombineMode`) — advanced, select
- **Receiver: interior only** (`castInteriorReceiverOnly`) — advanced, boolean

### Painted Shadows

- **Effect ID:** `painted-shadows`
- **Category:** Lighting & Shadows

#### Standard effect chrome

- (?) Effect help (button)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_handPaintedShadow mask status

#### Parameter groups

##### Painted Shadows

- **Opacity** (`opacity`) — slider
- **Strength boost** (`shadowStrengthBoost`) — slider
- **Length** (`length`) — slider
- **Blur** (`blurRadius`) — slider
- **Contact preserve** (`contactShadowPreserve`) — advanced, slider
- **Contact blend (low)** (`contactSharpBlendLow`) — advanced, slider
- **Contact blend (high)** (`contactSharpBlendHigh`) — advanced, slider
- **Edge inflate (px)** (`shadowEdgeInflatePx`) — advanced, slider
- **Resolution** (`resolutionScale`) — advanced, slider

## Atmosphere & Weather

### Weather

- **Effect ID:** `weather`
- **Category:** Atmosphere & Weather

#### Standard effect chrome

- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Dynamic Weather _(advanced)_

- **Dynamic Weather** (`dynamicEnabled`) — boolean
- **Biome Preset** (`dynamicPresetId`)
- **Evolution Speed (x)** (`dynamicEvolutionSpeed`)
- **Pause Evolution** (`dynamicPaused`) — boolean

##### Dynamic Bounds (GM) _(advanced)_

- **Clamp To Bounds** (`dynamicBoundsEnabled`) — GM only, boolean
- **Precip Min** (`dynamicBoundsPrecipitationMin`) — GM only
- **Precip Max** (`dynamicBoundsPrecipitationMax`) — GM only
- **Cloud Min** (`dynamicBoundsCloudCoverMin`) — GM only
- **Cloud Max** (`dynamicBoundsCloudCoverMax`) — GM only
- **Wind Min** (`dynamicBoundsWindSpeedMin`) — GM only
- **Wind Max** (`dynamicBoundsWindSpeedMax`) — GM only
- **Fog Min** (`dynamicBoundsFogDensityMin`) — GM only
- **Fog Max** (`dynamicBoundsFogDensityMax`) — GM only
- **Temp Min** (`dynamicBoundsFreezeLevelMin`) — GM only
- **Temp Max** (`dynamicBoundsFreezeLevelMax`) — GM only

##### GM Transition _(advanced)_

- **Transition Time (s)** (`transitionDuration`)
- **Precipitation** (`queuedPrecipitation`) — GM only
- **Cloud Cover** (`queuedCloudCover`) — GM only
- **Wind Speed** (`queuedWindSpeed`) — GM only
- **Wind Direction (deg)** (`queuedWindDirection`) — GM only
- **Fog Density** (`queuedFogDensity`) — GM only
- **Temperature (Rain <-> Snow)** (`queuedFreezeLevel`) — GM only
- **Queue From Current** (button) — GM only
- **Start Transition** (button) — GM only

##### Environment _(advanced)_

- **Force Indoor Mask** (`roofMaskForceEnabled`) — boolean

##### Simulation _(advanced)_

- **Transition Time (s)** (`transitionDuration`)
- **Simulation Speed** (`simulationSpeed`)

##### Fog

- **Fog Density** (`fogDensity`)

##### Manual Override

- **Precipitation** (`precipitation`)
- **Cloud Cover** (`cloudCover`)
- **Wetness** (`wetness`) — readonly
- **Temperature (Rain <-> Snow)** (`freezeLevel`)
- **Ash Intensity** (`ashIntensity`)

##### Wetness _(advanced)_

- **Wetting Duration (s)** (`wettingDuration`)
- **Drying Duration (s)** (`dryingDuration`)
- **Rain Threshold** (`precipThreshold`)

##### Roof & tree drips _(advanced)_

- **Drips Enabled** (`roofDripEnabled`) — boolean
- **Drip Emission (rain)** (`roofDripEmissionRainMult`)
- **Drip Emission (tail)** (`roofDripEmissionTailMult`)
- **Post-Rain Drip Tail (s)** (`roofDripTailDurationSec`)
- **Particle Life Min (s)** (`roofDripLifeMin`)
- **Particle Life Max (s)** (`roofDripLifeMax`)
- **Drop Size Min** (`roofDripSizeMin`)
- **Drop Size Max** (`roofDripSizeMax`)
- **Max Particles** (`roofDripMaxParticles`)

##### Rain Splashes _(advanced)_

- **Splash 1 (Thin Ring) Intensity** (`rainSplash1IntensityScale`)
- **Splash 1 (Thin Ring) Life Min (s)** (`rainSplash1LifeMin`)
- **Splash 1 (Thin Ring) Life Max (s)** (`rainSplash1LifeMax`)
- **Splash 1 (Thin Ring) Size Min (px)** (`rainSplash1SizeMin`)
- **Splash 1 (Thin Ring) Size Max (px)** (`rainSplash1SizeMax`)
- **Splash 1 (Thin Ring) Peak Opacity** (`rainSplash1OpacityPeak`)
- **Splash 2 (Broken Ring) Intensity** (`rainSplash2IntensityScale`)
- **Splash 2 (Broken Ring) Life Min (s)** (`rainSplash2LifeMin`)
- **Splash 2 (Broken Ring) Life Max (s)** (`rainSplash2LifeMax`)
- **Splash 2 (Broken Ring) Size Min (px)** (`rainSplash2SizeMin`)
- **Splash 2 (Broken Ring) Size Max (px)** (`rainSplash2SizeMax`)
- **Splash 2 (Broken Ring) Peak Opacity** (`rainSplash2OpacityPeak`)
- **Splash 3 (Droplets) Intensity** (`rainSplash3IntensityScale`)
- **Splash 3 (Droplets) Life Min (s)** (`rainSplash3LifeMin`)
- **Splash 3 (Droplets) Life Max (s)** (`rainSplash3LifeMax`)
- **Splash 3 (Droplets) Size Min (px)** (`rainSplash3SizeMin`)
- **Splash 3 (Droplets) Size Max (px)** (`rainSplash3SizeMax`)
- **Splash 3 (Droplets) Peak Opacity** (`rainSplash3OpacityPeak`)
- **Splash 4 (Puddle) Intensity** (`rainSplash4IntensityScale`)
- **Splash 4 (Puddle) Life Min (s)** (`rainSplash4LifeMin`)
- **Splash 4 (Puddle) Life Max (s)** (`rainSplash4LifeMax`)
- **Splash 4 (Puddle) Size Min (px)** (`rainSplash4SizeMin`)
- **Splash 4 (Puddle) Size Max (px)** (`rainSplash4SizeMax`)
- **Splash 4 (Puddle) Peak Opacity** (`rainSplash4OpacityPeak`)

##### Flurries _(advanced)_

- **Rain/Snow Flurry** (`precipFlurryVariability`)
- **Ash Flurry** (`ashFlurryVariability`)
- **Flurry Time Scale** (`flurryTimeScale`)
- **Lull Floor** (`flurryLullFloor`)
- **Burst Peak Max** (`flurryBurstPeakMax`)

#### Cross-category groups

These groups render under another top-level category but persist under this effect.

##### Rain Particles → Particles & VFX _(advanced)_

- **Rain Intensity Scale** (`rainIntensityScale`)
- **Rain Streak Length** (`rainStreakLength`)
- **Rain Drop Size** (`rainDropSize`)
- **Rain Drop Size Min** (`rainDropSizeMin`)
- **Rain Drop Size Max** (`rainDropSizeMax`)
- **Rain Brightness** (`rainBrightness`)
- **Rain Gravity Scale** (`rainGravityScale`)
- **Rain Curl Strength** (`rainCurlStrength`)
- **Rain Chaos (per-drop)** (`rainChaosStrength`)
- **Rain Fine Turbulence** (`rainTurbulenceStrength`)
- **Rain Brightness Spread** (`rainBrightnessSpread`)
- **Rain Length Spread** (`rainLengthSpread`)
- **Rain highlight (magenta)** (`debugRainHighlight`) — boolean

##### Snow Particles → Particles & VFX _(advanced)_

- **Snow Intensity Scale** (`snowIntensityScale`)
- **Snow Flake Size** (`snowFlakeSize`)
- **Snow Brightness** (`snowBrightness`)
- **Snow Gravity Scale** (`snowGravityScale`)
- **Snow Curl Strength** (`snowCurlStrength`)
- **Snow Flutter Strength** (`snowFlutterStrength`)

#### Ungrouped parameters

- **Preset Transition (min)** (`presetTransitionDurationMinutes`)
- **Transition Duration (min)** (`dynamicPlanDurationMinutes`)
- **Ash Intensity** (`queuedAshIntensity`) — GM only

### Wind

- **Effect ID:** `scene-wind`
- **Category:** Atmosphere & Weather

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### About

##### Wind Profile Tuning

- **Gap ratio tune** (`gapRatioTune`) — slider
- **Gap softness tune** (`gapSoftnessTune`) — slider
- **Storm floor tune** (`spatialFloorTune`) — slider
- **Storm swing tune** (`stormSwingTune`) — slider
- **Wave sharpness tune** (`waveSharpnessTune`) — slider
- **Vegetation attack** (`windAttackRamp`) — slider
- **Vegetation decay** (`windDecayRamp`) — slider
- **Bend rise softness** (`bendRiseSoftness`) — slider

##### Propagation & Gaps

- **Wave spacing** (`waveSpatialFrequency`) — slider
- **Wave speed** (`waveTravelSpeed`) — slider
- **Wave sharpness** (`waveSharpness`) — slider
- **Gap ratio** (`gapRatio`) — slider
- **Gap softness** (`gapSoftness`) — slider
- **Direction evolution** (`directionEvolutionScale`) — slider

##### Cloud Drift

- **Cloud wind influence** (`windInfluence`) — slider
- **Cloud drift speed** (`driftSpeed`) — slider
- **Min cloud drift** (`minDriftSpeed`) — slider
- **Cloud accel response** (`driftResponsiveness`) — slider
- **Cloud decel rate** (`driftDecelFactor`) — slider
- **Max cloud drift** (`driftMaxSpeed`) — slider

##### Water Coupling

- **Water wind response** (`windDirResponsiveness`) — slider
- **Water wind override** (`windOverrideEnabled`) — boolean
- **Override bearing** (`windOverrideBearingDeg`) — slider
- **Override speed** (`windOverrideSpeed01`) — slider

##### Vegetation Response

- **Vegetation wind response** (`windResponse`) — slider
- **Vegetation catch-up** (`windRampSpeed`) — slider
- **Gust strength mix** (`vegetationWaveInfluence`) — slider
- **Clump wave field** (`clumpWaveEnabled`) — boolean
- **Clump wave mix** (`clumpWaveMix`) — slider

##### Particles & Rain

- **Fire wind influence** (`fireWindInfluence`) — slider
- **Fire wind kill** (`fireWeatherWindKill`) — slider
- **Fog advection** (`fogAdvectionSpeed`) — slider
- **Fog wind response** (`fogWindDirResponsiveness`) — slider
- **Rain wind influence** (`rainWindInfluence`) — slider
- **Snow wind influence** (`snowWindInfluence`) — slider

### Fog & Air

- **Effect ID:** `atmospheric-fog`
- **Category:** Atmosphere & Weather

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Density & Falloff

- **Weather Fog Influence** (`weatherFogInfluence`) — slider
- **Max Opacity** (`maxOpacity`) — slider
- **Falloff Start** (`falloffStart`) — slider
- **Falloff End** (`falloffEnd`) — slider

##### Color & Lighting

- **Fog Color** (`fogColor`) — color
- **Night Fog Color** (`fogColorNight`) — color
- **Sky Tint Strength** (`skyTintStrength`) — slider
- **Night Color Strength** (`nightColorStrength`) — slider
- **Darkness Strength** (`darknessStrength`) — slider
- **Darkness Min Color** (`darknessColorMin`) — slider

##### HDR Composite _(advanced)_

- **HDR Haze Strength** (`hdrHazeStrength`) — slider
- **Fog Glow Add** (`fogAdditive`) — slider
- **Reference Luminance** (`fogRefLuminance`) — slider
- **Light Smothering** (`lightOcclusionStrength`) — slider

##### Fog Banks & Storms _(advanced)_

- **Bank Scale** (`macroScale`) — slider
- **Bank Contrast** (`macroStrength`) — slider
- **Building Encroachment** (`buildingEncroachment`) — slider
- **Rain Responsiveness** (`rainResponsiveness`) — slider

##### Swirls & Detail _(advanced)_

- **Enable Swirls** (`noiseEnabled`) — boolean
- **Detail Scale** (`noiseScale`) — slider
- **Detail Strength** (`noiseStrength`) — slider
- **Detail Contrast** (`noiseContrast`) — slider
- **Swirl Strength** (`curlStrength`) — slider
- **Swirl Scale** (`curlScale`) — slider
- **Swirl Depth** (`swirlIterations`) — dropdown

##### Wind & Motion _(advanced)_

- **Animation Speed** (`noiseSpeed`) — slider

##### Indoor & Building Mask _(advanced)_

- **Reduce Indoors** (`useIndoorMask`) — boolean
- **Indoor Reduction** (`indoorFogReduction`) — slider
- **Distance-Field Clearance** (`useRoofDistanceFeather`) — boolean
- **Building Clearance (px)** (`indoorBufferPx`) — slider
- **Clearance Softness (px)** (`indoorSoftnessPx`) — slider

##### Low-Density Cutout _(advanced)_

- **Enable Cutout** (`cutoutEnabled`) — boolean
- **Cutout Scale** (`cutoutScale`) — slider
- **Cutout Strength** (`cutoutStrength`) — slider
- **Cutout Speed** (`cutoutSpeed`) — slider
- **Cutout Contrast** (`cutoutContrast`) — slider

##### Advanced _(advanced)_

- **Depth Modulation** (`useDepthModulation`) — boolean
- **Force Full-Screen Fog** (`debugForceFog`) — GM only, boolean

### Lightning

- **Effect ID:** `lightning`
- **Category:** Atmosphere & Weather

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Timing _(advanced)_

- **Min Delay (ms)** (`minDelayMs`) — slider
- **Max Delay (ms)** (`maxDelayMs`) — slider
- **Restrikes Min** (`burstMinStrikes`) — slider
- **Restrikes Max** (`burstMaxStrikes`) — slider
- **Strike Duration (ms)** (`strikeDurationMs`) — slider
- **Leader Phase** (`leaderFraction`) — slider
- **Flicker Chance** (`flickerChance`) — slider

##### Look

- **Outer Color** (`outerColor`) — color
- **Core Color** (`coreColor`) — color
- **Brightness** (`brightness`) — slider
- **Width (px-ish)** (`width`) — slider
- **Taper** (`taper`) — slider
- **Glow Strength** (`glowStrength`) — slider
- **Z Offset** (`zOffset`) — slider
- **Overhead Order** (`overheadOrder`) — list
- **Texture Scroll Speed** (`textureScrollSpeed`) — slider
- **Core Static Amount** (`coreStaticAmount`) — slider
- **Core Static Range** (`coreStaticRange`) — slider
- **Wind Drift** (`windDriftStrength`) — slider

##### Shape _(advanced)_

- **Segments** (`segments`) — slider
- **Curve Amount** (`curveAmount`) — slider
- **Fractal Chaos** (`macroDisplacement`) — slider
- **Micro Jitter** (`microJitter`) — slider
- **Endpoint Randomness** (`endPointRandomnessPx`) — slider
- **Branch Angle** (`branchAngleDeg`) — slider
- **Branch Chance** (`branchChance`) — slider
- **Branch Max** (`branchMax`) — slider
- **Branch Length Min** (`branchLengthMin`) — slider
- **Branch Length Max** (`branchLengthMax`) — slider
- **Branch Width Scale** (`branchWidthScale`) — slider
- **Branch Intensity Scale** (`branchIntensityScale`) — slider
- **Branch Duration Scale** (`branchDurationScale`) — slider
- **Wild Arc Chance** (`wildArcChance`) — slider

##### Outside Flash

- **Flash Enabled** (`outsideFlashEnabled`) — boolean
- **Flash Gain** (`outsideFlashGain`) — slider
- **Attack (ms)** (`outsideFlashAttackMs`) — slider
- **Decay (ms)** (`outsideFlashDecayMs`) — slider
- **Decay Curve** (`outsideFlashCurve`) — slider
- **Flicker Amount** (`outsideFlashFlickerAmount`) — slider
- **Flicker Rate** (`outsideFlashFlickerRate`) — slider
- **Flash Clamp** (`outsideFlashMaxClamp`) — slider

##### Origin Flash Light _(advanced)_

- **Enabled** (`originFlashEnabled`) — boolean
- **Anchor Point** (`originFlashAnchor`) — list
- **Radius (px)** (`originFlashRadiusPx`) — slider
- **Radius Strike Scale** (`originFlashRadiusStrikeScale`) — slider
- **Inner Radius Scale** (`originFlashInnerRadiusScale`) — slider
- **Light Intensity** (`originFlashIntensity`) — slider
- **Strike Intensity Scale** (`originFlashStrikeScale`) — slider
- **Darkness Cancel** (`originFlashDarknessCancel`) — slider
- **Night Cancel Boost** (`originFlashDarknessNightBoost`) — slider
- **Follow Point Light Gain** (`originFlashFollowPointLightGain`) — boolean
- **Edge Attenuation** (`originFlashAttenuation`) — slider
- **Hot Core Mix** (`originFlashHotMix`) — slider
- **Leader Precursor** (`originFlashLeaderPrecursor`) — slider
- **Flicker Amount** (`originFlashFlickerAmount`) — slider
- **Flicker Rate** (`originFlashFlickerRate`) — slider
- **Min Visible Gain** (`originFlashMinGain`) — slider
- **Wall Clip** (`originFlashWallClipEnabled`) — boolean
- **Clip Radius Scale** (`originFlashWallClipRadiusScale`) — slider
- **Wall Padding (px)** (`originFlashWallPaddingPx`) — slider
- **Allow Window Light** (`originFlashAllowWindows`) — boolean

##### Audio _(advanced)_

- **Audio Enabled** (`audioEnabled`) — boolean
- **Strike Sound Path** (`audioStrikePath`) — string
- **Volume** (`audioVolume`) — slider

### Landscape Lightning

- **Effect ID:** `weather-lightning`
- **Category:** Atmosphere & Weather

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Storm

- **Storm Intensity** (`stormIntensity`) — slider
- **Flash Brightness** (`flashBrightness`) — slider
- **Flash Frequency** (`flashFrequency`) — slider
- **Distance Variation** (`distanceVariation`) — slider
- **Shadow Length Scale** (`shadowLengthScale`) — slider
- **Shadow Smear Mul** (`shadowSmearScale`) — slider
- **Window Flash Boost** (`windowFlashBoost`) — slider
- **Window Peak Multiplier** (`windowFlashPeakMultiplier`) — slider
- **Outdoor Flash Strength** (`outdoorFlashStrength`) — slider
- **Day Flash Scale** (`dayFlashBrightnessScale`) — slider
- **Dawn Flash Scale** (`dawnFlashBrightnessScale`) — slider
- **Dusk Flash Scale** (`duskFlashBrightnessScale`) — slider
- **Night Flash Scale** (`nightFlashBrightnessScale`) — slider
- **Day Shadow Scale** (`dayStructuralShadowScale`) — slider
- **Night Shadow Scale** (`nightStructuralShadowScale`) — slider
- **Twilight Blend (h)** (`twilightFlashBlendHours`) — slider
- **Night Ramp Curve** (`dayNightFlashCurve`) — slider
- **Shadow Blend Weight** (`shadowBlendWeight`) — slider
- **Shadow Fade Length** (`shadowFadeDurationScale`) — slider
- **Shadow Fade Softness** (`shadowFadeCurve`) — slider
- **Shadow Flash Floor** (`lightningShadowFlashFloor`) — slider
- **Flash Contrast** (`lightningFlashContrast`) — slider
- **Shadow Darkness** (`lightningShadowDarkness`) — slider
- **Flash Color R** (`lightningFlashColorR`) — slider
- **Flash Color G** (`lightningFlashColorG`) — slider
- **Flash Color B** (`lightningFlashColorB`) — slider

##### Flash Envelope _(advanced)_

- **Attack (ms)** (`flashAttackMs`) — slider
- **Flicker Hold (ms)** (`flashFlickerHoldMs`) — slider
- **Fade Out (ms)** (`flashDecayMs`) — slider
- **Fade Curve** (`flashDecayCurve`) — slider
- **Flicker Amount** (`flashFlickerAmount`) — slider
- **Flicker Chaos** (`flashFlickerRate`) — slider
- **Flash Clamp** (`flashMaxClamp`) — slider
- **Brightness Min** (`brightnessMin`) — slider
- **Brightness Max** (`brightnessMax`) — slider
- **Min Delay (ms)** (`minDelayMs`) — slider
- **Max Delay (ms)** (`maxDelayMs`) — slider

##### GM Triggers _(advanced)_

- **Small Strike** (button) — GM only
- **Big Strike** (button) — GM only
- **30s Series** (button) — GM only

### Ash Ground Clouds

- **Effect ID:** `ash-clouds`
- **Category:** Atmosphere & Weather

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameters (flat)

### Sprite Clouds

- **Effect ID:** `cloud`
- **Category:** Atmosphere & Weather

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameters (flat)

## Surface & Materials

### Metallic / Specular

- **Effect ID:** `specular`
- **Category:** Surface & Materials

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_outdoors mask status
- \_specular mask status

#### Parameter groups

##### Look

- **Intensity** (`intensity`) — slider
- **Specular tint** (`lightColor`) — color
- **Mask colour saturation** (`specularMaskSaturation`) — slider
- **Player light specular boost** (`playerLightSpecularBoost`) — slider

##### Shimmer _(advanced)_

- **Shimmer on** (`stripeEnabled`) — boolean
- **Layer blend** (`stripeBlendMode`) — list
- **Parallax** (`parallaxStrength`) — slider
- **Brightness gate** (`stripeMaskThreshold`) — slider
- **World scale (px)** (`worldPatternScale`) — slider

##### Shimmer layer 1 _(advanced)_

- **On** (`stripe1Enabled`) — boolean
- **Density** (`stripe1Frequency`) — slider
- **Speed** (`stripe1Speed`) — slider
- **Grain angle (°)** (`stripe1Angle`) — slider
- **Cluster size** (`stripe1Width`) — slider
- **Strength** (`stripe1Intensity`) — slider
- **Parallax mix** (`stripe1Parallax`) — slider
- **Scatter** (`stripe1Wave`) — slider
- **Softness** (`stripe1Gaps`) — slider
- **Elongation** (`stripe1Softness`) — slider

##### Shimmer layer 2 _(advanced)_

- **On** (`stripe2Enabled`) — boolean
- **Density** (`stripe2Frequency`) — slider
- **Speed** (`stripe2Speed`) — slider
- **Grain angle (°)** (`stripe2Angle`) — slider
- **Cluster size** (`stripe2Width`) — slider
- **Strength** (`stripe2Intensity`) — slider
- **Parallax mix** (`stripe2Parallax`) — slider
- **Scatter** (`stripe2Wave`) — slider
- **Softness** (`stripe2Gaps`) — slider
- **Elongation** (`stripe2Softness`) — slider

##### Shimmer layer 3 _(advanced)_

- **On** (`stripe3Enabled`) — boolean
- **Density** (`stripe3Frequency`) — slider
- **Speed** (`stripe3Speed`) — slider
- **Grain angle (°)** (`stripe3Angle`) — slider
- **Cluster size** (`stripe3Width`) — slider
- **Strength** (`stripe3Intensity`) — slider
- **Parallax mix** (`stripe3Parallax`) — slider
- **Scatter** (`stripe3Wave`) — slider
- **Softness** (`stripe3Gaps`) — slider
- **Elongation** (`stripe3Softness`) — slider

##### Micro sparkle _(advanced)_

- **Sparkle on** (`sparkleEnabled`) — boolean
- **Strength** (`sparkleIntensity`) — slider
- **Density** (`sparkleScale`) — slider
- **Twinkle speed** (`sparkleSpeed`) — slider

##### Outdoor & clouds

- **Cloud specular** (`outdoorCloudSpecularEnabled`) — boolean
- **Outdoor shimmer mix** (`outdoorStripeBlend`) — slider
- **Cloud lit boost** (`cloudSpecularIntensity`) — slider

##### Wet surface (rain)

- **Wet sheen** (`wetSpecularEnabled`) — boolean
- **Input lift** (`wetInputBrightness`) — slider
- **Input gamma** (`wetInputGamma`) — slider
- **Input contrast** (`wetSpecularContrast`) — slider
- **Black point** (`wetBlackPoint`) — slider
- **White point** (`wetWhitePoint`) — slider
- **Wet strength** (`wetSpecularIntensity`) — slider
- **Wet clamp** (`wetOutputMax`) — slider
- **Wet output gamma** (`wetOutputGamma`) — slider
- **Outdoor baseline** (`wetBaseSheen`) — slider
- **Wind ripple** (`wetWindRippleStrength`) — slider

##### Frost / ice _(advanced)_

- **Frost on** (`frostGlazeEnabled`) — boolean
- **Freeze threshold** (`frostThreshold`) — slider
- **Frost strength** (`frostIntensity`) — slider
- **Blue tint** (`frostTintStrength`) — slider

##### Dynamic light tint _(advanced)_

- **Tint from lights** (`dynamicLightTintEnabled`) — boolean
- **Tint mix** (`dynamicLightTintStrength`) — slider

##### Wind-linked shimmer _(advanced)_

- **Wind-linked motion** (`windDrivenStripesEnabled`) — boolean
- **Wind amount** (`windStripeInfluence`) — slider

##### Building shadow suppression _(advanced)_

- **Suppress in shadow** (`buildingShadowSuppressionEnabled`) — boolean
- **Shadow mix** (`buildingShadowSuppressionStrength`) — slider

### Fluid

- **Effect ID:** `fluid`
- **Category:** Surface & Materials

#### Standard effect chrome

- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_fluid mask status

#### Parameter groups

##### Appearance

- **Intensity** (`intensity`) — slider
- **Opacity** (`opacity`) — slider
- **Color A (Young)** (`colorA`) — color
- **Color B (Old)** (`colorB`) — color
- **Age Gamma** (`ageGamma`) — advanced, slider

##### Mask Thresholds _(advanced)_

- **Low Threshold** (`maskThresholdLo`) — slider
- **High Threshold** (`maskThresholdHi`) — slider

##### Flow & Motion

- **Flow Mode (0=Ping-Pong, 1=Directional)** (`flowMode`) — slider
- **Flow Speed** (`flowSpeed`) — slider
- **Slug Count** (`pulseFrequency`) — slider
- **Gap Transparency** (`pulseStrength`) — slider
- **Slug Width** (`slugWidth`) — slider
- **Edge Softness** (`edgeSoftness`) — slider

##### Noise & Bubbles _(advanced)_

- **Noise Scale** (`noiseScale`) — slider
- **Noise Strength** (`noiseStrength`) — slider
- **Bubble Scale** (`bubbleScale`) — slider
- **Bubble Strength** (`bubbleStrength`) — slider

##### Edge Effects _(advanced)_

- **Edge Noise Scale** (`edgeNoiseScale`) — slider
- **Edge Noise Amp** (`edgeNoiseAmp`) — slider
- **Meniscus Strength** (`meniscusStrength`) — slider

##### Foam _(advanced)_

- **Foam Strength** (`foamStrength`) — slider
- **Foam Scale** (`foamScale`) — slider
- **Foam Width** (`foamWidth`) — slider
- **Foam Tint** (`foamTint`) — slider
- **Trailing Foam** (`foamTrailStrength`) — slider
- **Edge Foam** (`edgeFoamStrength`) — slider
- **Foam Density** (`foamDensity`) — slider
- **Foam Frothiness** (`foamFrothiness`) — slider

##### Surface Effects _(advanced)_

- **Caustics Enabled** (`causticEnabled`) — boolean
- **Caustic Strength** (`causticStrength`) — slider
- **Caustic Scale** (`causticScale`) — slider
- **RGB Shift** (`rgbShift`) — slider

##### Iridescence _(advanced)_

- **Strength** (`iridescenceStrength`) — slider
- **Animation Speed** (`iriSpeed`) — slider
- **Film Scale** (`iriScale`) — slider
- **Edge Enhancement** (`iriFresnel`) — slider
- **Patchiness** (`iriBreakup`) — slider
- **Flow Advection** (`iriFlowAdvect`) — slider
- **Spectral Spread** (`iriSpectralSpread`) — slider
- **Thickness Contrast** (`iriThicknessContrast`) — slider
- **Swirl Scale** (`iriSwirlScale`) — slider
- **Swirl Speed** (`iriSwirlSpeed`) — slider
- **Detail Scale** (`iriDetailScale`) — slider
- **Detail Weight** (`iriDetailWeight`) — slider
- **Color Saturation** (`iriSaturation`) — slider

##### Churn & Distortion _(advanced)_

- **Enable Churn** (`churnEnabled`) — boolean
- **Distortion Amount** (`churnStrength`) — slider
- **Churn Scale** (`churnScale`) — slider
- **Churn Speed** (`churnSpeed`) — slider
- **Detail (Octave Mix)** (`churnOctaves`) — slider
- **Flow Bias** (`churnFlowBias`) — slider

##### HDR / Bloom Boost _(advanced)_

- **Enable HDR Boost** (`hdrBoostEnabled`) — boolean
- **Boost Intensity** (`hdrBoostStrength`) — slider
- **Pulse Speed** (`hdrBoostPulseSpeed`) — slider
- **Edge Glow** (`hdrBoostEdge`) — slider
- **Center Glow** (`hdrBoostCenter`) — slider

##### Endpoint Pools _(advanced)_

- **Start Pool** (`poolStart`) — slider
- **End Pool** (`poolEnd`) — slider
- **Pool Softness** (`poolSoftness`) — slider

##### Roof Occlusion _(advanced)_

- **Enable Roof Occlusion** (`roofOcclusionEnabled`) — boolean
- **Roof Alpha Threshold** (`roofAlphaThreshold`) — slider

### Iridescence

- **Effect ID:** `iridescence`
- **Category:** Surface & Materials

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_iridescence mask status

#### Parameter groups

##### Look

- **Intensity** (`intensity`) — slider
- **Opacity** (`alpha`) — slider

##### Motion & parallax

- **Flow speed** (`flowSpeed`) — slider
- **Angle** (`angle`) — slider
- **Parallax strength** (`parallaxStrength`) — slider

##### Spectral & lighting _(advanced)_

- **Noise type** (`noiseType`) — list
- **Ignore darkness** (`ignoreDarkness`) — slider
- **Color cycle speed** (`colorCycleSpeed`) — slider

##### Distortion & noise _(advanced)_

- **Distortion strength** (`distortionStrength`) — slider
- **Noise scale** (`noiseScale`) — slider
- **Phase multiplier** (`phaseMult`) — slider

##### Mask _(advanced)_

- **Mask threshold** (`maskThreshold`) — slider
- **Invert mask** (`invertMask`) — boolean

### Prism

- **Effect ID:** `prism`
- **Category:** Surface & Materials

#### Standard effect chrome

- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_prism mask status

#### Parameter groups

##### Refraction

- **Distortion** (`intensity`) — slider
- **Spectral Spread** (`spread`) — slider
- **Brightness Boost** (`brightness`) — slider
- **Opacity** (`opacity`) — slider
- **Mask Brightness Cutoff** (`maskThreshold`) — advanced, slider

##### Crystal Facets _(advanced)_

- **Facet Scale** (`facetScale`) — slider
- **Animate Facets** (`facetAnimate`) — boolean
- **Animation Speed** (`facetSpeed`) — slider
- **Facet Softness** (`facetSoftness`) — slider

##### Camera Parallax _(advanced)_

- **Parallax Strength** (`parallaxStrength`) — slider

##### Surface Glint _(advanced)_

- **Glint Strength** (`glintStrength`) — slider
- **Glint Sharpness** (`glintThreshold`) — slider

### Bush

- **Effect ID:** `bush`
- **Category:** Surface & Materials

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_bush mask status

#### Parameter groups

##### Look

- **Intensity** (`intensity`) — slider

##### Wind & waves

- **Wave mix** (`waveInfluence`) — slider
- **Gust frequency** (`gustFrequency`) — slider
- **Gust travel** (`gustSpeed`) — slider
- **Low-wind rustle** (`minRustleSpeed`) — slider

##### Bulk sway

- **Sway amount** (`bulkSway`) — slider
- **Sway scale** (`bulkSwayScale`) — slider
- **Sway speed** (`bulkSwaySpeed`) — slider
- **Direction spread** (`bulkSwaySpread`) — slider
- **Springiness** (`elasticity`) — slider

##### Leaf flutter

- **Flutter amount** (`flutterIntensity`) — slider
- **Flutter speed** (`flutterSpeed`) — slider
- **Flutter scale** (`flutterScale`) — slider

##### Response curves _(advanced)_

- **Ambient motion** (`ambientMotion`) — slider
- **Rustle floor scale** (`rustleFloorScale`) — slider
- **Flutter base drive** (`flutterBaseDrive`) — slider
- **Flutter wind start** (`flutterWindStart`) — slider
- **Flutter wind full** (`flutterWindFull`) — slider
- **Low-wind flutter boost** (`flutterLowWindBoost`) — slider
- **Boost fade end** (`flutterLowWindFadeEnd`) — slider
- **Flutter gust floor** (`flutterGustFloor`) — slider
- **Bend minimum** (`bendMinStrength`) — slider
- **Bend wind start** (`bendWindStart`) — slider
- **Bend wind full** (`bendWindFull`) — slider

##### Color

- **Exposure** (`exposure`) — slider
- **Brightness** (`brightness`) — slider
- **Contrast** (`contrast`) — slider
- **Saturation** (`saturation`) — slider
- **Temperature** (`temperature`) — slider
- **Green/magenta** (`tint`) — slider

##### Canopy shadow _(advanced)_

- **Shadow strength** (`shadowOpacity`) — slider
- **Shadow offset** (`shadowLength`) — slider
- **Shadow softness** (`shadowSoftness`) — slider

##### Cloud shadows _(advanced)_

- **cloudShadowEnabled** (`cloudShadowEnabled`)
- **cloudShadowDarkenStrength** (`cloudShadowDarkenStrength`)
- **cloudShadowDarkenCurve** (`cloudShadowDarkenCurve`)

##### Building shadows _(advanced)_

- **buildingShadowEnabled** (`buildingShadowEnabled`)
- **Shadow strength** (`buildingShadowDarkenStrength`) — slider
- **Shadow curve** (`buildingShadowDarkenCurve`) — slider

##### Painted shadows _(advanced)_

- **paintedShadowEnabled** (`paintedShadowEnabled`)
- **paintedShadowDarkenStrength** (`paintedShadowDarkenStrength`)
- **paintedShadowDarkenCurve** (`paintedShadowDarkenCurve`)

##### Atmospheric flash lighting _(advanced)_

- **lightningVegetationEnabled** (`lightningVegetationEnabled`)
- **lightningVegetationBrightnessBoost** (`lightningVegetationBrightnessBoost`)
- **lightningVegetationContrastBoost** (`lightningVegetationContrastBoost`)
- **lightningVegetationTintStrength** (`lightningVegetationTintStrength`)

##### Edge safety _(advanced)_

- **Edge fade start** (`edgeFadeStart`) — slider
- **Edge fade end** (`edgeFadeEnd`) — slider

### Tree

- **Effect ID:** `tree`
- **Category:** Surface & Materials

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_tree mask status

#### Parameter groups

##### Look

- **Intensity** (`intensity`) — slider

##### Wind & waves

- **Wave mix** (`waveInfluence`) — slider
- **Gust frequency** (`gustFrequency`) — slider
- **Gust travel** (`gustSpeed`) — slider
- **Turbulence** (`turbulence`) — slider
- **Turbulence scale** (`turbulenceScale`) — slider
- **Low-wind rustle** (`minRustleSpeed`) — slider

##### Bulk sway

- **Sway amount** (`bulkSway`) — slider
- **Sway scale** (`bulkSwayScale`) — slider
- **Sway speed** (`bulkSwaySpeed`) — slider
- **Direction spread** (`bulkSwaySpread`) — slider
- **Springiness** (`elasticity`) — slider

##### Leaf flutter

- **Flutter amount** (`flutterIntensity`) — slider
- **Flutter speed** (`flutterSpeed`) — slider
- **Flutter scale** (`flutterScale`) — slider

##### Response curves _(advanced)_

- **Ambient motion** (`ambientMotion`) — slider
- **Rustle floor scale** (`rustleFloorScale`) — slider
- **Flutter base drive** (`flutterBaseDrive`) — slider
- **Flutter wind start** (`flutterWindStart`) — slider
- **Flutter wind full** (`flutterWindFull`) — slider
- **Low-wind flutter boost** (`flutterLowWindBoost`) — slider
- **Boost fade end** (`flutterLowWindFadeEnd`) — slider
- **Flutter gust floor** (`flutterGustFloor`) — slider
- **Bend minimum** (`bendMinStrength`) — slider
- **Bend wind start** (`bendWindStart`) — slider
- **Bend wind full** (`bendWindFull`) — slider

##### Color

- **Exposure** (`exposure`) — slider
- **Brightness** (`brightness`) — slider
- **Contrast** (`contrast`) — slider
- **Saturation** (`saturation`) — slider
- **Temperature** (`temperature`) — slider
- **Green/magenta** (`tint`) — slider

##### Canopy shadow _(advanced)_

- **Shadow strength** (`shadowOpacity`) — slider
- **Shadow offset** (`shadowLength`) — slider
- **Shadow softness** (`shadowSoftness`) — slider

##### Cloud shadows _(advanced)_

- **cloudShadowEnabled** (`cloudShadowEnabled`)
- **cloudShadowDarkenStrength** (`cloudShadowDarkenStrength`)
- **cloudShadowDarkenCurve** (`cloudShadowDarkenCurve`)

##### Building shadows _(advanced)_

- **buildingShadowEnabled** (`buildingShadowEnabled`)
- **buildingShadowDarkenStrength** (`buildingShadowDarkenStrength`)
- **buildingShadowDarkenCurve** (`buildingShadowDarkenCurve`)

##### Painted shadows _(advanced)_

- **paintedShadowEnabled** (`paintedShadowEnabled`)
- **paintedShadowDarkenStrength** (`paintedShadowDarkenStrength`)
- **paintedShadowDarkenCurve** (`paintedShadowDarkenCurve`)

##### Atmospheric flash lighting _(advanced)_

- **lightningVegetationEnabled** (`lightningVegetationEnabled`)
- **lightningVegetationBrightnessBoost** (`lightningVegetationBrightnessBoost`)
- **lightningVegetationContrastBoost** (`lightningVegetationContrastBoost`)
- **lightningVegetationTintStrength** (`lightningVegetationTintStrength`)

##### Edge safety _(advanced)_

- **Edge fade start** (`edgeFadeStart`) — slider
- **Edge fade end** (`edgeFadeEnd`) — slider

### Water

- **Effect ID:** `water`
- **Category:** Surface & Materials

#### Standard effect chrome

- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_water mask status

#### Parameter groups

##### Water Appearance & Depth _(advanced)_

- **Tint Color** (`tintColor`) — color
- **Tint Strength** (`tintStrength`) — slider
- **Distortion (px)** (`distortionStrengthPx`) — slider
- **Debug View** (`debugView`) — advanced, dropdown
- **Debug Wind Arrow** (`debugWindArrow`) — advanced, boolean

##### Waves & Wind _(advanced)_

- **Wave Scale** (`waveScale`) — slider
- **Wave speed scale** (`waveSpeed`) — slider
- **Wave intensity** (`waveStrength`) — slider
- **Wave Motion Blend** (`waveMotion01`) — slider
- **Lock wave travel to wind** (`lockWaveTravelToWind`) — boolean
- **Wave travel heading (deg)** (`waveDirOffsetDeg`) — slider
- **Normals vs travel (deg)** (`waveAppearanceRotDeg`) — slider

##### Surface Lighting _(advanced)_

- **Strength** (`specStrength`) — slider
- **Power** (`specPower`) — slider
- **Model** (`specModel`) — dropdown
- **Clamp** (`specClamp`) — slider
- **Sun Azimuth (deg)** (`specSunAzimuthDeg`) — slider
- **Sun Elevation (deg)** (`specSunElevationDeg`) — slider
- **Sun Intensity** (`specSunIntensity`) — slider
- **Normal Strength** (`specNormalStrength`) — slider
- **Normal Scale** (`specNormalScale`) — slider
- **Normal Mode** (`specNormalMode`) — dropdown
- **Micro Strength** (`specMicroStrength`) — slider
- **Micro Scale** (`specMicroScale`) — slider
- **AA strength** (`specAAStrength`) — slider
- **Wave Step Multiplier** (`specWaveStepMul`) — slider
- **Force Flat Normal** (`specForceFlatNormal`) — boolean
- **Disable Spec Masking** (`specDisableMasking`) — boolean
- **Disable Rain Slope** (`specDisableRainSlope`) — boolean
- **Roughness Min** (`specRoughnessMin`) — slider
- **Roughness Max** (`specRoughnessMax`) — slider
- **Surface chaos** (`specSurfaceChaos`) — slider
- **F0** (`specF0`) — slider
- **Mask Gamma** (`specMaskGamma`) — slider
- **Sky Tint** (`specSkyTint`) — slider
- **Sky Intensity** (`skyIntensity`) — slider
- **Shore Bias** (`specShoreBias`) — slider
- **Distortion Normal Strength** (`specDistortionNormalStrength`) — slider
- **Anisotropy** (`specAnisotropy`) — slider
- **Aniso Ratio** (`specAnisoRatio`) — slider

##### Foam & Detail _(advanced)_

- **Enabled** (`shoreFoamEnabled`) — boolean
- **Strength** (`shoreFoamStrength`) — slider
- **Threshold** (`shoreFoamThreshold`) — slider
- **Scale** (`shoreFoamScale`) — slider
- **Speed** (`shoreFoamSpeed`) — slider
- **Coverage** (`shoreFoamCoverage`) — slider
- **Seed Offset X** (`shoreFoamSeedOffsetX`) — slider
- **Seed Offset Y** (`shoreFoamSeedOffsetY`) — slider
- **Time Offset** (`shoreFoamTimeOffset`) — slider
- **Color** (`shoreFoamColor`) — color
- **Tint** (`shoreFoamTint`) — color
- **Tint Strength** (`shoreFoamTintStrength`) — slider
- **Variation** (`shoreFoamColorVariation`) — slider
- **Opacity** (`shoreFoamOpacity`) — slider
- **Brightness** (`shoreFoamBrightness`) — slider
- **Contrast** (`shoreFoamContrast`) — slider
- **Gamma** (`shoreFoamGamma`) — slider
- **Enable Lighting** (`shoreFoamLightingEnabled`) — boolean
- **Ambient** (`shoreFoamAmbientLight`) — slider
- **Scene Influence** (`shoreFoamSceneLightInfluence`) — slider
- **Darkness Response** (`shoreFoamDarknessResponse`) — slider
- **Filaments Enabled** (`shoreFoamFilamentsEnabled`) — boolean
- **Filaments Strength** (`shoreFoamFilamentsStrength`) — slider
- **Filaments Scale** (`shoreFoamFilamentsScale`) — slider
- **Filaments Length** (`shoreFoamFilamentsLength`) — slider
- **Filaments Width** (`shoreFoamFilamentsWidth`) — slider
- **Thickness Var** (`shoreFoamThicknessVariation`) — slider
- **Thickness Scale** (`shoreFoamThicknessScale`) — slider
- **Edge Detail** (`shoreFoamEdgeDetail`) — slider
- **Edge Scale** (`shoreFoamEdgeDetailScale`) — slider
- **Wave Distortion** (`shoreFoamWaveDistortionStrength`) — slider
- **Noise Dist Enabled** (`shoreFoamNoiseDistortionEnabled`) — boolean
- **Noise Dist Strength** (`shoreFoamNoiseDistortionStrength`) — slider
- **Noise Dist Scale** (`shoreFoamNoiseDistortionScale`) — slider
- **Noise Dist Speed** (`shoreFoamNoiseDistortionSpeed`) — slider
- **Evolution Enabled** (`shoreFoamEvolutionEnabled`) — boolean
- **Evol Speed** (`shoreFoamEvolutionSpeed`) — slider
- **Evol Amount** (`shoreFoamEvolutionAmount`) — slider
- **Evol Scale** (`shoreFoamEvolutionScale`) — slider
- **Core Width** (`shoreFoamCoreWidth`) — slider
- **Core Falloff** (`shoreFoamCoreFalloff`) — slider
- **Tail Width** (`shoreFoamTailWidth`) — slider
- **Tail Falloff** (`shoreFoamTailFalloff`) — slider
- **Strength** (`floatingFoamStrength`) — slider
- **Coverage** (`floatingFoamCoverage`) — slider
- **Scale** (`floatingFoamScale`) — slider
- **Wave Distortion** (`floatingFoamWaveDistortion`) — slider
- **Flecks Enabled** (`foamFlecksEnabled`) — boolean
- **Flecks Intensity** (`foamFlecksIntensity`) — slider

##### Murk & Refraction _(advanced)_

- **Multi-Tap Refraction** (`refractionMultiTapEnabled`) — boolean
- **Distortion Edge Center** (`distortionEdgeCenter`) — slider
- **Distortion Edge Feather** (`distortionEdgeFeather`) — slider
- **Distortion Edge Gamma** (`distortionEdgeGamma`) — slider
- **Shore Remap Low** (`distortionShoreRemapLo`) — slider
- **Shore Remap High** (`distortionShoreRemapHi`) — slider
- **Shore Power** (`distortionShorePow`) — slider
- **Shore Min** (`distortionShoreMin`) — slider

#### Ungrouped parameters

- **Enable Depth Shadow** (`waterDepthShadowEnabled`) — boolean
- **Shadow Strength** (`waterDepthShadowStrength`) — slider
- **Min Brightness** (`waterDepthShadowMinBrightness`) — slider
- **Intensity** (`microChopIntensity`) — slider
- **Scale** (`microChopScale`) — slider
- **Speed** (`microChopSpeed`) — slider
- **Warp Large Strength** (`waveWarpLargeStrength`) — slider
- **Warp Small Strength** (`waveWarpSmallStrength`) — slider
- **Warp Micro Strength** (`waveWarpMicroStrength`) — slider
- **Warp Time Speed** (`waveWarpTimeSpeed`) — slider
- **Breakup Strength** (`waveBreakupStrength`) — slider
- **Breakup Scale** (`waveBreakupScale`) — slider
- **Breakup Speed** (`waveBreakupSpeed`) — slider
- **Breakup Warp** (`waveBreakupWarp`) — slider
- **Breakup Distortion** (`waveBreakupDistortionStrength`) — slider
- **Breakup Specular** (`waveBreakupSpecularStrength`) — slider
- **Micro Normal Strength** (`waveMicroNormalStrength`) — slider
- **Micro Normal Scale** (`waveMicroNormalScale`) — slider
- **Micro Normal Speed** (`waveMicroNormalSpeed`) — slider
- **Micro Normal Warp** (`waveMicroNormalWarp`) — slider
- **Micro Distortion** (`waveMicroNormalDistortionStrength`) — slider
- **Micro Specular** (`waveMicroNormalSpecularStrength`) — slider
- **Evolution enabled** (`waveEvolutionEnabled`) — boolean
- **Evolution Speed** (`waveEvolutionSpeed`) — slider
- **Evolution Amount** (`waveEvolutionAmount`) — slider
- **Evolution Scale** (`waveEvolutionScale`) — slider
- **Wave speed at calm wind** (`waveSpeedWindMinFactor`) — slider
- **Wave speed at full wind** (`waveSpeedWindMaxFactor`) — slider
- **Gust ramp speed** (`waveGustSlewRate`) — slider
- **Strength Calm Baseline** (`waveStrengthWindMinFactor`) — slider
- **Indoor Damping Enabled** (`waveIndoorDampingEnabled`) — boolean
- **Indoor Damping Strength** (`waveIndoorDampingStrength`) — slider
- **Indoor Min Factor** (`waveIndoorMinFactor`) — slider
- **Tri Blend Angle (deg)** (`waveTriBlendAngleDeg`) — slider
- **Tri Blend Side Weight** (`waveTriSideWeight`) — slider
- **Advection Dir Offset (deg)** (`advectionDirOffsetDeg`) — slider
- **Advection Speed** (`advectionSpeed01`) — slider
- **Override scene wind** (`windOverrideEnabled`) — boolean
- **Flow bearing (deg)** (`windOverrideBearingDeg`) — slider
- **Flow strength** (`windOverrideSpeed01`) — slider
- **Enabled** (`chromaticAberrationEnabled`) — boolean
- **Strength (px)** (`chromaticAberrationStrengthPx`) — slider
- **Luma threshold** (`chromaticAberrationThreshold`) — slider
- **Threshold softness** (`chromaticAberrationThresholdSoftness`) — slider
- **Kawase blur (px)** (`chromaticAberrationKawaseBlurPx`) — slider
- **Sample spread** (`chromaticAberrationSampleSpread`) — slider
- **Edge center** (`chromaticAberrationEdgeCenter`) — slider
- **Edge feather** (`chromaticAberrationEdgeFeather`) — slider
- **Edge gamma** (`chromaticAberrationEdgeGamma`) — slider
- **Edge min** (`chromaticAberrationEdgeMin`) — slider
- **Deadzone** (`chromaticAberrationDeadzone`) — slider
- **Deadzone Softness** (`chromaticAberrationDeadzoneSoftness`) — slider
- **Enabled** (`rainDistortionEnabled`) — boolean
- **Use Weather Precipitation** (`rainDistortionUseWeather`) — boolean
- **Precip Override** (`rainDistortionPrecipitationOverride`) — slider
- **Distortion Strength (px)** (`rainDistortionStrengthPx`) — slider
- **Distortion Scale** (`rainDistortionScale`) — slider
- **Distortion Speed** (`rainDistortionSpeed`) — slider
- **Indoor Damping** (`rainIndoorDampingEnabled`) — boolean
- **Indoor Damping Strength** (`rainIndoorDampingStrength`) — slider
- **Enabled** (`specHighlightsEnabled`) — boolean
- **Strength** (`specHighlightsStrength`) — slider
- **Power (Sharpness)** (`specHighlightsPower`) — slider
- **Clamp** (`specHighlightsClamp`) — slider
- **Sun Azimuth** (`specHighlightsSunAzimuthDeg`) — slider
- **Sun Elevation** (`specHighlightsSunElevationDeg`) — slider
- **Intensity** (`specHighlightsSunIntensity`) — slider
- **Wave Response** (`specHighlightsNormalStrength`) — slider
- **Normal Scale** (`specHighlightsNormalScale`) — slider
- **Roughness Min** (`specHighlightsRoughnessMin`) — slider
- **Roughness Max** (`specHighlightsRoughnessMax`) — slider
- **F0** (`specHighlightsF0`) — slider
- **Sky Tint** (`specHighlightsSkyTint`) — slider
- **Mask Gamma** (`specHighlightsMaskGamma`) — slider
- **Shore Bias** (`specHighlightsShoreBias`) — slider
- **Bloom emit** (`bloomSpecularEmit`) — slider
- **Use Sun Angle** (`specUseSunAngle`) — boolean
- **Sun Elevation Falloff** (`specSunElevationFalloffEnabled`) — boolean
- **Falloff Start (deg)** (`specSunElevationFalloffStart`) — slider
- **Falloff End (deg)** (`specSunElevationFalloffEnd`) — slider
- **Falloff Curve** (`specSunElevationFalloffCurve`) — slider
- **Shadow enabled** (`cloudShadowEnabled`) — boolean
- **Darken Strength** (`cloudShadowDarkenStrength`) — slider
- **Darken Curve** (`cloudShadowDarkenCurve`) — slider
- **Specular Kill** (`cloudShadowSpecularKill`) — slider
- **Specular Curve** (`cloudShadowSpecularCurve`) — slider
- **Enabled** (`cloudReflectionEnabled`) — boolean
- **Strength** (`cloudReflectionStrength`) — slider
- **Enabled** (`causticsEnabled`) — boolean
- **Brightness Masking** (`causticsBrightnessMaskEnabled`) — boolean
- **Intensity** (`causticsIntensity`) — slider
- **Scale** (`causticsScale`) — slider
- **Speed** (`causticsSpeed`) — slider
- **Sharpness** (`causticsSharpness`) — slider
- **Edge Low** (`causticsEdgeLo`) — slider
- **Edge High** (`causticsEdgeHi`) — slider
- **Brightness Threshold** (`causticsBrightnessThreshold`) — slider
- **Brightness Softness** (`causticsBrightnessSoftness`) — slider
- **Brightness Gamma** (`causticsBrightnessGamma`) — slider
- **Fade Curve** (`shoreFoamFadeCurve`) — slider
- **Color** (`floatingFoamColor`) — color
- **Tint** (`floatingFoamTint`) — color
- **Tint Strength** (`floatingFoamTintStrength`) — slider
- **Variation** (`floatingFoamColorVariation`) — slider
- **Opacity** (`floatingFoamOpacity`) — slider
- **Brightness** (`floatingFoamBrightness`) — slider
- **Contrast** (`floatingFoamContrast`) — slider
- **Gamma** (`floatingFoamGamma`) — slider
- **Enable Lighting** (`floatingFoamLightingEnabled`) — boolean
- **Ambient** (`floatingFoamAmbientLight`) — slider
- **Scene Influence** (`floatingFoamSceneLightInfluence`) — slider
- **Darkness Response** (`floatingFoamDarknessResponse`) — slider
- **Shadow Enabled** (`floatingFoamShadowEnabled`) — boolean
- **Shadow Strength** (`floatingFoamShadowStrength`) — slider
- **Shadow Softness** (`floatingFoamShadowSoftness`) — slider
- **Shadow Depth** (`floatingFoamShadowDepth`) — slider
- **Filaments Enabled** (`floatingFoamFilamentsEnabled`) — boolean
- **Filaments Strength** (`floatingFoamFilamentsStrength`) — slider
- **Filaments Scale** (`floatingFoamFilamentsScale`) — slider
- **Filaments Length** (`floatingFoamFilamentsLength`) — slider
- **Filaments Width** (`floatingFoamFilamentsWidth`) — slider
- **Thickness Var** (`floatingFoamThicknessVariation`) — slider
- **Thickness Scale** (`floatingFoamThicknessScale`) — slider
- **Edge Detail** (`floatingFoamEdgeDetail`) — slider
- **Edge Scale** (`floatingFoamEdgeDetailScale`) — slider
- **Layer Count** (`floatingFoamLayerCount`) — slider
- **Layer Offset** (`floatingFoamLayerOffset`) — slider
- **Wave Distortion** (`floatingFoamWaveDistortionStrength`) — slider
- **Noise Dist Enabled** (`floatingFoamNoiseDistortionEnabled`) — boolean
- **Noise Dist Strength** (`floatingFoamNoiseDistortionStrength`) — slider
- **Noise Dist Scale** (`floatingFoamNoiseDistortionScale`) — slider
- **Noise Dist Speed** (`floatingFoamNoiseDistortionSpeed`) — slider
- **Evolution Enabled** (`floatingFoamEvolutionEnabled`) — boolean
- **Evol Speed** (`floatingFoamEvolutionSpeed`) — slider
- **Evol Amount** (`floatingFoamEvolutionAmount`) — slider
- **Evol Scale** (`floatingFoamEvolutionScale`) — slider
- **Enabled** (`murkEnabled`) — boolean
- **Intensity** (`murkIntensity`) — slider
- **Base Color** (`murkColor`) — color
- **Alt Color** (`murkColorAlt`) — color
- **Color Variation** (`murkColorVariation`) — slider
- **Hue Scatter** (`murkHueScatter`) — slider
- **Saturation** (`murkSaturation`) — slider
- **Brightness Variation** (`murkLumaVariation`) — slider
- **Scale** (`murkScale`) — slider
- **Speed** (`murkSpeed`) — slider
- **Seed Offset X** (`murkSeedOffsetX`) — slider
- **Seed Offset Y** (`murkSeedOffsetY`) — slider
- **Depth Low (mask)** (`murkDepthLo`) — slider
- **Depth High (mask)** (`murkDepthHi`) — slider
- **Depth Fade** (`murkDepthFade`) — slider
- **Cloud Threshold Low** (`murkCloudLo`) — slider
- **Cloud Threshold High** (`murkCloudHi`) — slider
- **Cloud Gamma** (`murkCloudGamma`) — slider
- **Patch Scale Mult** (`murkPatchScale`) — slider
- **Patch Mix** (`murkPatchMix`) — slider
- **Detail Scale Mult** (`murkDetailScale`) — slider
- **Detail Mix** (`murkDetailMix`) — slider
- **Density Contrast** (`murkDensityContrast`) — slider
- **Thickness Variation** (`murkThicknessVariation`) — slider
- **Thickness Chaos** (`murkThicknessChaos`) — slider
- **Strength Low** (`murkStrengthLo`) — slider
- **Strength High** (`murkStrengthHi`) — slider
- **Warp Strength** (`murkWarpStrength`) — slider
- **Chaos** (`murkChaos`) — slider
- **Chaos Speed** (`murkChaosSpeed`) — slider
- **Grain Scale** (`murkGrainScale`) — slider
- **Grain Speed** (`murkGrainSpeed`) — slider
- **Grain Strength** (`murkGrainStrength`) — slider
- **Shadow Enabled** (`murkShadowEnabled`) — boolean
- **Shadow Strength** (`murkShadowStrength`) — slider
- **Enabled** (`bathymetryEnabled`) — boolean
- **Depth Curve** (`bathymetryDepthCurve`) — slider
- **Max Depth** (`bathymetryMaxDepth`) — slider
- **Strength** (`bathymetryStrength`) — slider
- **Absorption** (`bathymetryAbsorptionCoeff`) — color
- **Deep Scatter** (`bathymetryDeepScatterColor`) — color

### Ink & Line AO

- **Effect ID:** `filter`
- **Category:** Surface & Materials

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Look

- **Intensity** (`intensity`) — slider
- **Tint (Multiply)** (`tintColor`) — color

##### Ink AO (from scene) _(advanced)_

- **Enabled** (`inkAoEnabled`) — boolean
- **Strength** (`inkAoStrength`) — slider
- **Dark Threshold** (`inkDarkThreshold`) — slider
- **Dark Softness** (`inkDarkSoftness`) — slider
- **Edge Strength** (`inkEdgeStrength`) — slider
- **Edge Power** (`inkEdgePower`) — slider
- **Spread (px)** (`inkSpreadPx`) — slider
- **Spread Blur (px)** (`inkBlurPx`) — slider
- **Only \_Outdoors Dark Regions** (`inkOutdoorsDarkOnly`) — boolean
- **AO Tint** (`inkTintColor`) — color

##### Advanced: legacy multiply vignette _(advanced)_

- **Enabled (legacy)** (`vignetteEnabled`) — boolean
- **Strength** (`vignetteStrength`) — slider
- **Inner** (`vignetteInner`) — slider
- **Outer** (`vignetteOuter`) — slider
- **Tint** (`vignetteTintColor`) — color

## Particles & VFX

### Fire

- **Effect ID:** `fire-sparks`
- **Category:** Particles & VFX

#### Standard effect chrome

- (?) Effect help (button)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_fire mask status

#### Parameter groups

##### Flames _(advanced)_

- **Global Intensity** (`globalFireRate`) — slider
- **Height** (`fireHeight`) — slider
- **Temperature** (`fireTemperature`) — slider
- **Peak Opacity** (`flamePeakOpacity`) — slider
- **Core Emission (HDR)** (`coreEmission`) — slider
- **Updraft** (`fireUpdraft`) — slider
- **Curl Strength** (`fireCurlStrength`) — slider
- **Anchored Flames** (`flameStationaryFraction`) — slider

##### Embers & Smoke _(advanced)_

- **Enable smoke** (`smokeEnabled`) — checkbox
- **Emission Density** (`smokeRatio`) — slider
- **Peak Opacity** (`smokeOpacity`) — slider
- **Density** (`emberRate`) — slider
- **Emission (HDR)** (`emberEmission`) — slider
- **Updraft** (`emberUpdraft`) — slider
- **Curl Strength** (`emberCurlStrength`) — slider

##### Coal Bed _(advanced)_

- **Enable coal bed** (`coalBedEnabled`) — checkbox
- **Intensity** (`coalBedIntensity`) — slider
- **Opacity** (`coalBedOpacity`) — slider

##### Fire Glow _(advanced)_

- **Enable glow** (`fireGlowEnabled`) — checkbox
- **Follow HDR Brightness Slider** (`fireGlowFollowLightIntensity`) — checkbox
- **Day scale** (`fireGlowDayIntensityScale`) — slider
- **Night scale** (`fireGlowNightIntensityScale`) — slider
- **Night Cancel Boost** (`fireGlowDarknessNightBoost`) — slider

##### Mask Pickup _(advanced)_

- **Min Mask White** (`fireMaskMinBrightness`) — slider
- **Min Mask Alpha** (`fireMaskMinAlpha`) — slider
- **Min Combined Strength** (`fireMaskPremulThreshold`) — slider
- **Min Tile Alpha** (`fireAlbedoMinAlpha`) — slider
- **Min Neighbour Distance (px)** (`fireMaskIsolationPx`) — slider

##### Heat Distortion _(advanced)_

- **Enable Heat Haze** (`heatDistortionEnabled`) — checkbox
- **Intensity** (`heatDistortionIntensity`) — slider
- **Frequency** (`heatDistortionFrequency`) — slider
- **Speed** (`heatDistortionSpeed`) — slider
- **Edge Softness** (`heatDistortionEdgeSoftness`) — slider

##### Environment _(advanced)_

- **Visual Speed** (`fireVisualSpeed`) — slider
- **Time Scale** (`timeScale`) — slider
- **HDR Brightness (Day)** (`lightIntensity`) — slider
- **Night HDR Brightness** (`nightHdrBrightness`) — slider
- **Indoor Life Scale** (`indoorLifeScale`) — slider
- **Indoor Time Scale** (`indoorTimeScale`) — slider
- **Rain Kill Strength** (`weatherPrecipKill`) — slider

##### Performance _(advanced)_

- **Simulation Rate (Hz)** (`fireSimHz`) — slider
- **Max Spatial Buckets / Floor** (`fireMaxSpatialBuckets`) — slider
- **Max Particle Systems / Floor** (`fireMaxSystemsPerFloor`) — slider
- **Outdoor Split Max Buckets** (`fireOutdoorSplitMaxBuckets`) — slider
- **View Streaming (Cull Off-Screen)** (`fireViewStreaming`) — checkbox
- **Max Flame Particles / Bucket** (`fireMaxParticles`) — slider
- **Max Ember Particles / Bucket** (`fireEmberMaxParticles`) — slider
- **Max Smoke Particles / Bucket** (`fireSmokeMaxParticles`) — slider

#### Ungrouped parameters

- **Brightness floor** (`flameBrightnessFloor`) — slider
- **Size Min** (`fireSizeMin`) — slider
- **Size Max** (`fireSizeMax`) — slider
- **Life Min (s)** (`fireLifeMin`) — slider
- **Life Max (s)** (`fireLifeMax`) — slider
- **Flipbook Cycles** (`flameFlipbookCycles`) — slider
- **Animation Speed** (`flameAnimSpeed`) — slider
- **Opacity** (`flameTextureOpacity`) — slider
- **Brightness** (`flameTextureBrightness`) — slider
- **Scale X** (`flameTextureScaleX`) — slider
- **Scale Y** (`flameTextureScaleY`) — slider
- **Offset X** (`flameTextureOffsetX`) — slider
- **Offset Y** (`flameTextureOffsetY`) — slider
- **Rotation (rad)** (`flameTextureRotation`) — slider
- **Flip X** (`flameTextureFlipX`) — checkbox
- **Flip Y** (`flameTextureFlipY`) — checkbox
- **Peak Opacity** (`emberPeakOpacity`) — slider
- **Size Min** (`emberSizeMin`) — slider
- **Size Max** (`emberSizeMax`) — slider
- **Life Min (s)** (`emberLifeMin`) — slider
- **Life Max (s)** (`emberLifeMax`) — slider
- **Animation Speed** (`emberAnimSpeed`) — slider
- **Indoor Life Scale** (`indoorEmberLifeScale`) — slider
- **Indoor Density Suppression** (`indoorEmberSuppression`) — slider
- **Outdoor Smoke & Embers Above Trees** (`smokeOutdoorAboveCanopy`) — checkbox
- **Indoor Smoke Suppression** (`indoorSmokeSuppression`) — slider

### Ash Disturbance

- **Effect ID:** `ash-disturbance`
- **Category:** Particles & VFX

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_ash mask status

#### Parameter groups

##### Burst Settings

- **Burst Rate (particles/s)** (`burstRate`) — slider
- **Burst Duration (s)** (`burstDuration`) — slider
- **Burst Radius (px)** (`burstRadius`) — slider
- **Max Particles** (`maxParticles`) — advanced, slider

##### Appearance

- **Size Min (px)** (`sizeMin`) — slider
- **Size Max (px)** (`sizeMax`) — slider
- **Life Min (s)** (`lifeMin`) — slider
- **Life Max (s)** (`lifeMax`) — slider
- **Opacity Start** (`opacityStart`) — slider
- **Opacity End** (`opacityEnd`) — slider

##### Motion _(advanced)_

- **Wind Influence** (`windInfluence`) — slider
- **Curl Strength** (`curlStrength`) — advanced, slider
- **Curl Scale** (`curlScale`) — advanced, slider

### Dust Motes

- **Effect ID:** `dust`
- **Category:** Particles & VFX

#### Standard effect chrome

- (?) Effect help (button)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_dust mask status

#### Parameter groups

##### Dust Motes

- **Density** (`density`) — slider
- **Max Particles** (`maxParticles`) — advanced, slider

##### Appearance

- **Brightness** (`brightness`) — slider
- **Opacity** (`opacity`) — slider
- **Sky Tint Dust** (`skyTintEnabled`) — advanced, boolean
- **Sky Tint Strength** (`skyTintStrength`) — advanced, slider

##### Glitter _(advanced)_

- **Enable Glitter** (`glitterEnabled`) — boolean
- **Glitter Strength** (`glitterStrength`) — slider
- **Glitter Rate Min (Hz)** (`glitterRateMin`) — slider
- **Glitter Rate Max (Hz)** (`glitterRateMax`) — slider

##### Lifetime & Size _(advanced)_

- **Life Min (s)** (`lifeMin`) — slider
- **Life Max (s)** (`lifeMax`) — slider
- **Size Min** (`sizeMin`) — slider
- **Size Max** (`sizeMax`) — slider

##### Volume _(advanced)_

- **Z Min** (`zMin`) — slider
- **Z Max** (`zMax`) — slider

##### Motion _(advanced)_

- **Drift** (`motionDrift`) — slider
- **Curl Strength** (`motionCurlStrength`) — slider
- **Curl Scale** (`motionCurlScale`) — slider

### Water Splashes

- **Effect ID:** `water-splashes`
- **Category:** Particles & VFX

#### Standard effect chrome

- (?) Effect help (button)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_water mask status

#### Parameter groups

##### Tint (Jitter) _(advanced)_

- **Strength** (`tintStrength`) — slider
- **Jitter** (`tintJitter`) — slider
- **A R** (`tintAColorR`) — slider
- **A G** (`tintAColorG`) — slider
- **A B** (`tintAColorB`) — slider
- **B R** (`tintBColorR`) — slider
- **B G** (`tintBColorG`) — slider
- **B B** (`tintBColorB`) — slider

##### Foam (Shoreline)

- **Enabled** (`foamEnabled`) — boolean
- **Rate** (`foamRate`) — slider
- **Peak Opacity** (`foamPeakOpacity`) — slider
- **Life Min** (`foamLifeMin`) — advanced, slider
- **Life Max** (`foamLifeMax`) — advanced, slider
- **Size Min** (`foamSizeMin`) — advanced, slider
- **Size Max** (`foamSizeMax`) — advanced, slider
- **Wind Drift** (`foamWindDriftScale`) — advanced, slider
- **Color R** (`foamColorR`) — advanced, slider
- **Color G** (`foamColorG`) — advanced, slider
- **Color B** (`foamColorB`) — advanced, slider

##### Splashes (Rain on Water)

- **Enabled** (`splashEnabled`) — boolean
- **Rate** (`splashRate`) — slider
- **Peak Opacity** (`splashPeakOpacity`) — slider
- **Life Min** (`splashLifeMin`) — advanced, slider
- **Life Max** (`splashLifeMax`) — advanced, slider
- **Size Min** (`splashSizeMin`) — advanced, slider
- **Size Max** (`splashSizeMax`) — advanced, slider
- **Splash Wind Drift** (`splashWindDriftScale`) — advanced, slider

##### Mask Scan / Density _(advanced)_

- **Water Threshold** (`maskThreshold`) — slider
- **Edge Stride** (`edgeScanStride`) — slider
- **Interior Stride** (`interiorScanStride`) — slider

### Underwater Bubbles

- **Effect ID:** `underwater-bubbles`
- **Category:** Particles & VFX

#### Standard effect chrome

- (?) Effect help (button)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_water mask status

#### Parameter groups

##### Tint (Jitter) _(advanced)_

- **Strength** (`tintStrength`) — slider
- **Jitter** (`tintJitter`) — slider
- **A R** (`tintAColorR`) — slider
- **A G** (`tintAColorG`) — slider
- **A B** (`tintAColorB`) — slider
- **B R** (`tintBColorR`) — slider
- **B G** (`tintBColorG`) — slider
- **B B** (`tintBColorB`) — slider

##### Bubbles (Shoreline)

- **Enabled** (`foamEnabled`) — boolean
- **Rate** (`foamRate`) — slider
- **Peak Opacity** (`foamPeakOpacity`) — slider
- **Life Min** (`foamLifeMin`) — advanced, slider
- **Life Max** (`foamLifeMax`) — advanced, slider
- **Size Min** (`foamSizeMin`) — advanced, slider
- **Size Max** (`foamSizeMax`) — advanced, slider
- **Wind Drift** (`foamWindDriftScale`) — advanced, slider
- **Color R** (`foamColorR`) — advanced, slider
- **Color G** (`foamColorG`) — advanced, slider
- **Color B** (`foamColorB`) — advanced, slider

##### Rings (Interior)

- **Enabled** (`splashEnabled`) — boolean
- **Rate** (`splashRate`) — slider
- **Peak Opacity** (`splashPeakOpacity`) — slider
- **Life Min** (`splashLifeMin`) — advanced, slider
- **Life Max** (`splashLifeMax`) — advanced, slider
- **Size Min** (`splashSizeMin`) — advanced, slider
- **Size Max** (`splashSizeMax`) — advanced, slider
- **Splash Wind Drift** (`splashWindDriftScale`) — advanced, slider

### Smelly Flies

- **Effect ID:** `smelly-flies`
- **Category:** Particles & VFX

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameters (flat)

- **Max Flies** (`maxParticles`) — slider
- **Speed** (`speedMultiplier`) — slider

### Candle Flames

- **Effect ID:** `candle-flames`
- **Category:** Particles & VFX

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Flames

- **Enabled** (`flamesEnabled`) — boolean
- **Max Flames** (`maxFlames`) — slider
- **Size (px)** (`flameSizePx`) — slider
- **Size Jitter** (`flameSizeJitter`) — slider
- **Opacity** (`flameOpacity`) — slider
- **Flicker Speed** (`flameFlickerSpeed`) — slider
- **Flicker Strength** (`flameFlickerStrength`) — slider
- **Flicker Speed Jitter** (`flameFlickerSpeedJitter`) — slider
- **Flicker Strength Jitter** (`flameFlickerStrengthJitter`) — slider
- **Ovality** (`flameOvality`) — slider
- **Wobble** (`flameWobble`) — slider
- **Wobble Speed** (`flameWobbleSpeed`) — slider
- **Shape Chaos** (`flameWobbleNoise`) — slider
- **Shape Distort** (`flameShapeDistort`) — slider
- **Indoor Sway** (`flameIndoorSway`) — slider
- **Draftiness (Indoor)** (`draftiness`) — slider
- **Wind Influence (Outdoor)** (`outdoorWindInfluence`) — slider
- **Outdoor Sway** (`outdoorSway`) — slider

##### Day / Night (Flames) _(advanced)_

- **Auto Day/Night** (`autoDayNightBalance`) — boolean
- **Day Scale** (`dayIntensityScale`) — slider
- **Night Scale** (`nightIntensityScale`) — slider
- **Darkness Curve** (`dayNightCurve`) — slider

##### Glow (Gameplay Light) _(advanced)_

- **Enabled** (`glowEnabled`) — boolean
- **Follow Point Light Gain** (`glowFollowLightIntensity`) — boolean
- **Day Pool Scale** (`glowDayIntensityScale`) — slider
- **Night Pool Scale** (`glowNightIntensityScale`) — slider
- **Night Cancel Boost** (`glowDarknessNightBoost`) — slider
- **Bucket Size (px)** (`glowBucketSizePx`) — slider
- **Max Buckets** (`glowMaxBuckets`) — slider
- **View Streaming (Cull Off-Screen)** (`candleViewStreaming`) — checkbox
- **Wall Clip** (`wallClipEnabled`) — boolean
- **Clip Radius Scale** (`wallClipRadiusScale`) — slider

##### Glow — Indoor Balance _(advanced)_

- **Intensity Scale** (`glowIndoorIntensityScale`) — slider
- **Cancel Scale** (`glowIndoorCancelScale`) — slider
- **Radius Scale** (`glowIndoorRadiusScale`) — slider
- **Night Boost** (`glowIndoorNightBoost`) — slider

##### Glow — Outdoor Balance

- **Intensity Scale** (`glowOutdoorIntensityScale`) — slider
- **Cancel Scale** (`glowOutdoorCancelScale`) — slider
- **Radius Scale** (`glowOutdoorRadiusScale`) — slider
- **Night Boost** (`glowOutdoorNightBoost`) — slider

##### Glow — Light Shape

- **Shape Motion** (`glowShapeMotionEnabled`) — boolean
- **Master Scale** (`glowShapeMaster`) — slider
- **Motion Speed** (`glowShapeSpeed`) — slider
- **Follow Flame Motion** (`glowShapeLinkFlameMotion`) — boolean
- **Standalone Chaos** (`glowShapeChaos`) — slider
- **Center Wander** (`glowShapeCenterShift`) — slider
- **Vertical Wander** (`glowShapeCenterVertical`) — slider
- **Oval Stretch** (`glowShapeOvalStretch`) — slider
- **Oval Rotation** (`glowShapeOvalRotate`) — slider
- **Pool Size Pulse** (`glowShapeReachPulse`) — slider
- **Hot Core Pulse** (`glowShapeCorePulse`) — slider
- **Brightness Link** (`glowShapeBrightnessLink`) — slider
- **Indoor Scale** (`glowShapeIndoorScale`) — slider
- **Outdoor Scale** (`glowShapeOutdoorScale`) — slider

##### Glow — Day Pool

- **Pool Warmth** (`glowWarmth`) — slider
- **Pool Intensity** (`glowIntensity`) — slider
- **Darkness Cancel (HDR)** (`glowDarknessCancel`) — slider
- **Flicker Strength** (`glowFlickerStrength`) — slider
- **Flicker Speed** (`glowFlickerSpeed`) — slider
- **Flicker Strength Jitter** (`glowFlickerStrengthJitter`) — slider
- **Flicker Speed Jitter** (`glowFlickerSpeedJitter`) — slider
- **Pool Radius (px)** (`glowRadiusPx`) — slider
- **Hot Core Scale** (`glowInnerRadiusScale`) — slider
- **Falloff Exponent** (`glowFalloffExponent`) — slider
- **Pool Edge Softness** (`glowEdgeSoftness`) — slider

##### Glow — Night Pool _(advanced)_

- **Pool Warmth** (`glowNightWarmth`) — slider
- **Pool Intensity** (`glowNightIntensity`) — slider
- **Darkness Cancel (HDR)** (`glowNightDarknessCancel`) — slider
- **Flicker Strength** (`glowNightFlickerStrength`) — slider
- **Flicker Speed** (`glowNightFlickerSpeed`) — slider
- **Flicker Strength Jitter** (`glowNightFlickerStrengthJitter`) — slider
- **Flicker Speed Jitter** (`glowNightFlickerSpeedJitter`) — slider
- **Pool Radius (px)** (`glowNightRadiusPx`) — slider
- **Hot Core Scale** (`glowNightInnerRadiusScale`) — slider
- **Falloff Exponent** (`glowNightFalloffExponent`) — slider
- **Pool Edge Softness** (`glowNightEdgeSoftness`) — slider

### Ash (Weather)

- **Effect ID:** `ash-weather`
- **Category:** Particles & VFX

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Ashfall

- **Ash Intensity** (`ashIntensity`) — slider
- **Intensity Scale** (`ashIntensityScale`) — slider
- **Emission Rate** (`ashEmissionRate`) — slider

##### Ash Appearance _(advanced)_

- **Size Min** (`ashSizeMin`) — slider
- **Size Max** (`ashSizeMax`) — slider
- **Life Min (s)** (`ashLifeMin`) — slider
- **Life Max (s)** (`ashLifeMax`) — slider
- **Fall Speed Min** (`ashSpeedMin`) — slider
- **Fall Speed Max** (`ashSpeedMax`) — slider
- **Opacity Start Min** (`ashOpacityStartMin`) — slider
- **Opacity Start Max** (`ashOpacityStartMax`) — slider
- **Opacity End** (`ashOpacityEnd`) — slider
- **Color Start (soot)** (`ashColorStart`) — color
- **Color End (pale ash)** (`ashColorEnd`) — color
- **Brightness** (`ashBrightness`) — slider
- **Material Tint** (`ashMaterialTint`) — slider
- **Life Brighten** (`ashLifeBrighten`) — slider
- **Life Alpha Fade** (`ashLifeAlphaFade`) — slider

##### Ash Motion _(advanced)_

- **Gravity Scale** (`ashGravityScale`) — slider
- **Wind Influence** (`ashWindInfluence`) — slider
- **Wind Base** (`ashWindBase`) — slider
- **Curl Strength** (`ashCurlStrength`) — slider
- **Curl Noise Scale** (`ashCurlNoiseScale`) — slider
- **Curl Time Scale** (`ashCurlTimeScale`) — slider

##### Embers _(advanced)_

- **Ember Rate** (`emberEmissionRate`) — slider
- **Ember Size Min** (`emberSizeMin`) — slider
- **Ember Size Max** (`emberSizeMax`) — slider
- **Ember Life Min (s)** (`emberLifeMin`) — slider
- **Ember Life Max (s)** (`emberLifeMax`) — slider
- **Ember Speed Min** (`emberSpeedMin`) — slider
- **Ember Speed Max** (`emberSpeedMax`) — slider
- **Ember Opacity Min** (`emberOpacityStartMin`) — slider
- **Ember Opacity Max** (`emberOpacityStartMax`) — slider
- **Ember Opacity End** (`emberOpacityEnd`) — slider
- **Ember Color Start** (`emberColorStart`) — color
- **Ember Color End** (`emberColorEnd`) — color
- **Ember Brightness (HDR)** (`emberBrightness`) — slider
- **Ember Gravity Scale** (`emberGravityScale`) — slider
- **Ember Wind Influence** (`emberWindInfluence`) — slider
- **Ember Wind Base** (`emberWindBase`) — slider
- **Ember Curl Strength** (`emberCurlStrength`) — slider
- **Ember Curl Noise Scale** (`emberCurlNoiseScale`) — slider
- **Ember Curl Time Scale** (`emberCurlTimeScale`) — slider

## Camera & Post

### Camera Grade (HDR → LDR)

- **Effect ID:** `colorCorrection`
- **Category:** Camera & Post

#### Standard effect chrome

- (?) Effect help (button)
- **World Based** (toggle)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Texture / mask status row(s)** (readonly status under Enabled)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Mask status (under Enabled)

- \_outdoors mask status

#### Parameter groups

##### Exposure & color

- **Exposure** (`exposure`) — slider
- **Temperature** (`temperature`) — slider
- **Tint** (`tint`) — slider
- **Contrast** (`contrast`) — slider
- **Brightness** (`brightness`) — slider
- **Saturation** (`saturation`) — slider
- **Vibrance** (`vibrance`) — slider

##### Outdoor atmosphere

- **Enable outdoor atmosphere** (`atmosphereEnabled`) — boolean
- **Outdoor atmosphere strength** (`intensity`) — slider
- **Sky color saturation** (`saturationBoost`) — slider
- **Sky color vibrance** (`vibranceBoost`) — slider
- **Shadow preserve** (`shadowGradePreserve`) — slider
- **Master darkness blend** (`calendarDarknessBlend`) — slider
- **Day/night color separation** (`dayNightGradePull`) — slider
- **Night color depth** (`nightExtraDarkness`) — slider
- **Auto Intensity** (`autoIntensityEnabled`) — boolean
- **Auto Strength** (`autoIntensityStrength`) — slider
- **Sunrise** (`sunriseHour`) — slider
- **Sunset** (`sunsetHour`) — slider
- **Golden Width** (`goldenHourWidth`) — slider
- **Golden Strength** (`goldenStrength`) — slider
- **Golden Power** (`goldenPower`) — slider
- **Golden Recolor** (`goldenOutdoorRecolorStrength`) — slider
- **Golden Recolor Color** (`goldenOutdoorRecolorColor`) — color
- **Night Floor** (`nightFloor`) — slider
- **Analytic Strength** (`analyticStrength`) — slider
- **Turbidity** (`turbidity`) — slider
- **Rayleigh** (`rayleighStrength`) — slider
- **Mie** (`mieStrength`) — slider
- **Forward Scatter** (`forwardScatter`) — slider
- **Weather Influence** (`weatherInfluence`) — slider
- **Cloud→Turbidity** (`cloudToTurbidity`) — slider
- **Precip→Turbidity** (`precipToTurbidity`) — slider
- **Overcast Desat** (`overcastDesaturate`) — slider
- **Overcast Contrast** (`overcastContrastReduce`) — slider
- **Warm Horizon** (`tempWarmAtHorizon`) — slider
- **Cool Noon** (`tempCoolAtNoon`) — slider
- **Night Cool** (`nightCoolBoost`) — slider
- **Golden Sat** (`goldenSaturationBoost`) — slider
- **Night Sat Floor** (`nightSaturationFloor`) — slider
- **Haze Lift** (`hazeLift`) — slider
- **Haze Contrast** (`hazeContrastLoss`) — slider

##### HDR tone mapping _(advanced)_

- **Tone mapping** (`toneMapping`) — list
- **Lift** (`liftColor`) — color
- **Gamma** (`gammaColor`) — color
- **Gain** (`gainColor`) — color
- **Master gamma** (`masterGamma`) — slider

##### Vignette & grain _(advanced)_

- **Vignette strength** (`vignetteStrength`) — slider
- **Vignette softness (reserved)** (`vignetteSoftness`) — slider
- **Grain strength** (`grainStrength`) — slider

##### Time-of-day camera timeline _(advanced)_

- **todTimelineEnabled** (`todTimelineEnabled`)
- **localWarmLightPreserve** (`localWarmLightPreserve`)
- **localTodOverrideExposure** (`localTodOverrideExposure`)
- **localTodOverrideSaturation** (`localTodOverrideSaturation`)
- **localWarmEmissiveAdd** (`localWarmEmissiveAdd`)
- **lampLightPreserve** (`lampLightPreserve`)

### Sharpen

- **Effect ID:** `sharpen`
- **Category:** Camera & Post

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Look

- **Amount** (`amount`) — slider
- **Radius (px)** (`radiusPx`) — advanced, slider
- **Threshold** (`threshold`) — advanced, slider

### Lens

- **Effect ID:** `lens`
- **Category:** Camera & Post

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Autofocus & motion _(advanced)_

- **Enable Camera Motion Blur** (`motionBlurEnabled`) — boolean
- **Motion Blur Strength** (`motionBlurStrength`) — slider
- **Motion Blur Max (px)** (`motionBlurMaxPx`) — slider
- **Zoom Blur Strength** (`motionBlurZoomStrength`) — slider
- **Motion Blur Smoothing (s)** (`motionBlurSmoothingSeconds`) — slider

##### Overlays _(advanced)_

- **Enable Viewfinder Overlay** (`viewfinderEnabled`) — boolean
- **Viewfinder Texture** (`viewfinderSelection`) — string
- **viewfinderIntensity** (`viewfinderIntensity`) — slider
- **viewfinderLumaReactivity** (`viewfinderLumaReactivity`) — slider
- **viewfinderLumaBoost** (`viewfinderLumaBoost`) — slider
- **viewfinderDriftX** (`viewfinderDriftX`) — slider
- **viewfinderDriftY** (`viewfinderDriftY`) — slider
- **viewfinderPulseMag** (`viewfinderPulseMag`) — slider
- **viewfinderPulseFreq** (`viewfinderPulseFreq`) — slider

##### Optical distortions

- **distortionAmount** (`distortionAmount`) — slider
- **distortionCenterX** (`distortionCenterX`) — slider
- **distortionCenterY** (`distortionCenterY`) — slider
- **chromaticAmountPx** (`chromaticAmountPx`) — slider
- **chromaticEdgePower** (`chromaticEdgePower`) — slider
- **vignetteIntensity** (`vignetteIntensity`) — slider
- **vignetteSoftness** (`vignetteSoftness`) — slider
- **grainAmount** (`grainAmount`) — slider
- **grainSpeed** (`grainSpeed`) — slider
- **Adaptive Grain (Low-Light)** (`adaptiveGrainEnabled`) — boolean
- **Low-Light Grain Boost** (`grainLowLightBoost`) — slider
- **Grain Cell Size Bright** (`grainCellSizeBright`) — slider
- **Grain Cell Size Dark** (`grainCellSizeDark`) — slider
- **Enable Digital Chroma Noise** (`digitalNoiseEnabled`) — boolean
- **Digital Noise Amount** (`digitalNoiseAmount`) — slider
- **Digital Noise Chance** (`digitalNoiseChance`) — slider
- **Digital Noise Green Bias** (`digitalNoiseGreenBias`) — slider
- **Digital Noise Low-Light Boost** (`digitalNoiseLowLightBoost`) — slider

#### Ungrouped parameters

- **Enable Illumination-Driven Dynamics** (`dynamicLayersEnabled`) — boolean
- **Auto Texture Cycle (s)** (`layerCycleSeconds`) — slider
- **Light Fade Time (s)** (`lumaSmoothingSeconds`) — slider
- **Texture Swap Fade (s)** (`layerSwapFadeSeconds`) — slider
- **Enable Autofocus Defocus** (`autoFocusEnabled`) — boolean
- **Min Interval (s)** (`autoFocusMinIntervalSeconds`) — slider
- **Max Interval (s)** (`autoFocusMaxIntervalSeconds`) — slider
- **Defocus Duration (s)** (`autoFocusDefocusDurationSeconds`) — slider
- **Max Blur (px)** (`autoFocusMaxBlurPx`) — slider
- **Max Shift (px)** (`autoFocusMaxShiftPx`) — slider
- **Zoom Triggers Refocus** (`autoFocusZoomTriggerEnabled`) — boolean
- **Zoom Trigger Threshold** (`autoFocusZoomTriggerThreshold`) — slider
- **Zoom Trigger Cooldown (s)** (`autoFocusZoomTriggerCooldownSeconds`) — slider
- **Zoom Trigger Strength** (`autoFocusZoomTriggerStrength`) — slider
- **Enable Light Burn** (`lightBurnEnabled`) — boolean
- **Bright Threshold** (`lightBurnThreshold`) — slider
- **Threshold Softness** (`lightBurnThresholdSoftness`) — slider
- **Persistence (s)** (`lightBurnPersistenceSeconds`) — slider
- **Burn Response** (`lightBurnResponse`) — slider
- **Burn Intensity** (`lightBurnIntensity`) — slider
- **Burn Blur (px)** (`lightBurnBlurPx`) — slider
- **Gate Burn by Scene Darkness** (`lightBurnDarknessGateEnabled`) — boolean
- **Darkness Gate Start** (`lightBurnDarknessStart`) — slider
- **Darkness Gate End** (`lightBurnDarknessEnd`) — slider
- **Darkness Gate Influence** (`lightBurnDarknessInfluence`) — slider
- **Texture** (`structuralSelection`) — string
- **structuralIntensity** (`structuralIntensity`) — slider
- **structuralLumaReactivity** (`structuralLumaReactivity`) — slider
- **structuralLumaBoost** (`structuralLumaBoost`) — slider
- **Reveal Luma Min** (`structuralLumaMin`) — slider
- **Reveal Luma Max** (`structuralLumaMax`) — slider
- **Reveal Influence** (`structuralLumaInfluence`) — slider
- **structuralClearRadius** (`structuralClearRadius`) — slider
- **structuralClearSoftness** (`structuralClearSoftness`) — slider
- **structuralDriftX** (`structuralDriftX`) — slider
- **structuralDriftY** (`structuralDriftY`) — slider
- **structuralPulseMag** (`structuralPulseMag`) — slider
- **structuralPulseFreq** (`structuralPulseFreq`) — slider
- **Texture** (`opticalSelection`) — string
- **opticalIntensity** (`opticalIntensity`) — slider
- **opticalLumaReactivity** (`opticalLumaReactivity`) — slider
- **opticalLumaBoost** (`opticalLumaBoost`) — slider
- **Reveal Luma Min** (`opticalLumaMin`) — slider
- **Reveal Luma Max** (`opticalLumaMax`) — slider
- **Reveal Influence** (`opticalLumaInfluence`) — slider
- **opticalClearRadius** (`opticalClearRadius`) — slider
- **opticalClearSoftness** (`opticalClearSoftness`) — slider
- **opticalDriftX** (`opticalDriftX`) — slider
- **opticalDriftY** (`opticalDriftY`) — slider
- **opticalPulseMag** (`opticalPulseMag`) — slider
- **opticalPulseFreq** (`opticalPulseFreq`) — slider
- **Texture** (`reactiveSelection`) — string
- **reactiveIntensity** (`reactiveIntensity`) — slider
- **reactiveLumaReactivity** (`reactiveLumaReactivity`) — slider
- **reactiveLumaBoost** (`reactiveLumaBoost`) — slider
- **Reveal Luma Min** (`reactiveLumaMin`) — slider
- **Reveal Luma Max** (`reactiveLumaMax`) — slider
- **Reveal Influence** (`reactiveLumaInfluence`) — slider
- **reactiveClearRadius** (`reactiveClearRadius`) — slider
- **reactiveClearSoftness** (`reactiveClearSoftness`) — slider
- **reactiveDriftX** (`reactiveDriftX`) — slider
- **reactiveDriftY** (`reactiveDriftY`) — slider
- **reactivePulseMag** (`reactivePulseMag`) — slider
- **reactivePulseFreq** (`reactivePulseFreq`) — slider

### Dot Screen

- **Effect ID:** `dotScreen`
- **Category:** Camera & Post

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Look

- **Strength** (`strength`) — slider
- **Scale** (`scale`) — slider
- **Angle (rad)** (`angle`) — slider

##### Center _(advanced)_

- **Center X** (`centerX`) — slider
- **Center Y** (`centerY`) — slider

### Halftone

- **Effect ID:** `halftone`
- **Category:** Camera & Post

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Look

- **Strength** (`strength`) — slider
- **Radius** (`radius`) — slider
- **Shape** (`shape`) — select

##### Mix _(advanced)_

- **Blend mode** (`blendingMode`) — select
- **Scatter** (`scatter`) — slider

##### Output _(advanced)_

- **Greyscale** (`greyscale`) — boolean

### ASCII Art

- **Effect ID:** `ascii`
- **Category:** Camera & Post

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Picture

- **Grid detail** (`resolution`) — slider
- **Row height** (`lineHeight`) — slider
- **Effect strength** (`opacity`) — slider

##### Letter shape _(advanced)_

- **Letter width** (`glyphScaleX`) — slider
- **Letter height** (`glyphScaleY`) — slider

##### Spacing _(advanced)_

- **Side padding** (`cellPaddingX`) — slider
- **Top/bottom padding** (`cellPaddingY`) — slider

##### Look & motion

- **Character style** (`charSet`) — list
- **Keep map colors** (`color`) — boolean
- **Invert light/dark** (`invert`) — advanced, boolean
- **Letter shuffle** (`churn`) — advanced, slider
- **Shuffle speed** (`churnSpeed`) — advanced, slider

##### Hybrid mode _(advanced)_

- **Block strength** (`blockOpacity`) — slider
- **Letter strength** (`textOpacity`) — slider

##### Brightness & contrast _(advanced)_

- **Shadow depth** (`blackPoint`) — slider
- **Highlight point** (`whitePoint`) — slider
- **Contrast** (`contrast`) — slider
- **Brightness** (`brightness`) — slider

### Dazzle Overlay

- **Effect ID:** `dazzleOverlay`
- **Category:** Camera & Post

#### Standard effect chrome

- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Look

- **Intensity** (`intensity`) — slider
- **Exposure Lift** (`exposureLift`) — slider
- **White Add** (`whiteAdd`) — slider
- **Desaturate** (`desaturate`) — slider
- **Glare Strength** (`glareStrength`) — advanced, slider
- **Glare Power** (`glarePower`) — advanced, slider
- **RGB Shift (px)** (`rgbShiftPx`) — advanced, slider

### Color Invert

- **Effect ID:** `invert`
- **Category:** Camera & Post

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Look

- **Strength** (`strength`) — slider

### Sepia Tone

- **Effect ID:** `sepia`
- **Category:** Camera & Post

#### Standard effect chrome

- (?) Effect help (button)
- **Preset** (dropdown)
- **Enabled** (toggle)
- **Reset to Defaults** (button)
- **Defaults prompt (for devs)** (button)

#### Parameter groups

##### Look

- **Strength** (`strength`) — slider

---

**Summary:** 46 effect folders documented across 6 categories, plus manual panel sections above.
