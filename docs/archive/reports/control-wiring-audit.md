# Control Wiring Audit

Generated: 2026-06-24T22:32:06.663Z

Heuristic static analysis — manual follow-up required. False positives are expected for dynamic access, cross-file bridges, and weather/controlState paths.

**Out of scope:** manual controls in `tweakpane-manager.js`, GPU/visual verification, Foundry runtime.

## Summary

- Params scanned: **2000** across **47** schema units
- High confidence (≥60): **24**
- Medium (30–59): **0**
- Low (10–29): **0**
- Info (<10): **1976**
- Report threshold: score ≥ **30**

## High confidence — check first

### `weather.roofDripDebugEmissionMul` — score 75

- **Label:** Drip Debug Emission ×
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripGlobalBudget` — score 75

- **Label:** Spawn Pool Budget
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripMaxPerTile` — score 75

- **Label:** Max Points / Source
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripGpuMaxSpawnCap` — score 75

- **Label:** GPU Roof Max Spawns
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripAlphaThresholdGpu` — score 75

- **Label:** GPU Alpha Threshold
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripPointsRefreshSec` — score 75

- **Label:** Pool Rebuild Interval (s)
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripGravityMul` — score 75

- **Label:** Drip Gravity × (vs rain)
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripScreenDownZMix` — score 75

- **Label:** Screen-Down Z Mix
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripWindBase` — score 75

- **Label:** Drip Wind Base
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripWindCoupling` — score 75

- **Label:** Drip Wind × Precip/Wind
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripCurlMul` — score 75

- **Label:** Drip Turb × Rain Turb
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripSpeedFactor` — score 75

- **Label:** Drip Streak Length
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripStreakAnchorHalf` — score 75

- **Label:** Streak Anchor (world)
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripParticleSpeedMin` — score 75

- **Label:** Start Speed Min
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripParticleSpeedMax` — score 75

- **Label:** Start Speed Max
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripSpawnInwardPull` — score 75

- **Label:** UV Centroid Pull
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripSpawnUvJitter` — score 75

- **Label:** UV Spawn Jitter
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripEmitterNormalJitter` — score 75

- **Label:** Emitter Normal Jitter
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripEmitterTangentialJitter` — score 75

- **Label:** Emitter Edge Jitter
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripKillZMargin` — score 75

- **Label:** Kill Floor Margin (Z)
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripTileEdgeSpacing` — score 75

- **Label:** Tile Fallback Edge Spacing
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripTreeEdgeSpacing` — score 75

- **Label:** Tree Edge Spacing
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripTreeInteriorSamples` — score 75

- **Label:** Tree Interior Samples
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

### `weather.roofDripUseGpuRoofEdges` — score 75

- **Label:** Use GPU Roof Edges
- **Signals:** NOT_IN_RUNTIME_PARAMS, ZERO_CODE_REFS
- **Schema:** `core/WeatherController.js`
- **Impl:** `core/WeatherController.js`

## Medium confidence

_None at this threshold._

## Low confidence

_None at this threshold._

## Reverse orphans (runtime params not in schema)

- **ash-disturbance:** colorStart, r, g, b, a, colorEnd, masterEnabled
- **ash-weather:** boardBase, three, nativePixiOverlay, masterEnabled, dynamicEnabled, dynamicPresetId, dynamicEvolutionSpeed, dynamicPaused, dynamicPlanDurationMinutes, dynamicBoundsEnabled, queueFromCurrent, startQueuedTransition, transitionDuration, presetTransitionDurationMinutes, simulationSpeed, wettingDuration, dryingDuration, precipThreshold, precipFlurryVariability, ashFlurryVariability, flurryTimeScale, flurryLullFloor, flurryBurstPeakMax, roofMaskForceEnabled, debugRainHighlight, roofDripEnabled, ashIntensity, ashIntensityScale, ashEmissionRate, ashSizeMin, ashSizeMax, ashLifeMin, ashLifeMax, ashSpeedMin, ashSpeedMax, ashOpacityStartMin, ashOpacityStartMax, ashOpacityEnd, ashColorStart, ashColorEnd, ashBrightness, ashMaterialTint, ashLifeBrighten, ashLifeAlphaFade, ashGravityScale, ashWindInfluence, ashWindBase, ashCurlStrength, ashCurlNoiseScale, ashCurlTimeScale, emberEmissionRate, emberSizeMin, emberSizeMax, emberLifeMin, emberLifeMax, emberSpeedMin, emberSpeedMax, emberOpacityStartMin, emberOpacityStartMax, emberOpacityEnd, emberColorStart, emberColorEnd, emberBrightness, emberGravityScale, emberWindInfluence, emberWindBase, emberCurlStrength, emberCurlNoiseScale, emberCurlTimeScale
- **atmospheric-fog:** manualFogDensity
- **bloom:** r, g, b, prep, index, count, highPass, blurMips, output
- **building-shadows:** sunLatitude, dynamicLightShadowOverrideEnabled, dynamicLightShadowOverrideStrength
- **bush:** windAttackRamp, windDecayRamp, paintedShadowDarkenStrength, paintedShadowDarkenCurve, clumpIdDebug, clumpWaveEnabled, clumpWaveMix
- **candle-flames:** indoorThreshold, r, g, b
- **colorCorrection:** dynamicExposure, contextGradeEnabled, contextExposure, contextSaturation, contextBrightness, contextContrast, contextVibrance, contextTemperature, contextTint, contextVignetteStrength, contextVignetteSoftness, contextVignetteInner, contextMasterGamma, contextSpatialEnabled, contextSpatialStrength, contextTokenOutdoorBias, contextAtmosphereCoupling, contextTreeDappleEnabled, contextTreeDappleStrength, contextTreeDappleScale, contextTreeDappleGreenR, contextTreeDappleGreenG, contextTreeDappleGreenB, todAnchors, r, g, b, todTimelineEnabled, localWarmLightPreserve, localTodOverrideExposure, localTodOverrideSaturation, localWarmEmissiveAdd, lampLightPreserve
- **contextualSceneGrade:** dramaPeakContrast, dramaPeakTemperature, dramaPeakGammaLift, outdoorExposure, outdoorSaturation, outdoorBrightness, outdoorContrast, outdoorVibrance, outdoorTemperature, outdoorTint, outdoorVignetteStrength, outdoorMasterGamma, indoorExposure, indoorSaturation, indoorBrightness, indoorContrast, indoorVibrance, indoorTemperature, indoorTint, indoorVignetteStrength, indoorMasterGamma, exposure, saturation, brightness, contrast, vibrance, temperature, tint, vignetteStrength, masterGamma
- **dust:** outdoorRejectThreshold, maskThreshold, masterEnabled
- **filter:** r, g, b
- **fire-sparks:** fireSize, t, r, g, b, overlayRole
- **fog:** order, name, requiresDepth
- **iridescence:** hasIridescenceMask
- **lens:** overlayIndex0, overlayIndex1, overlayIntensity0, overlayLumaReactivity0, overlayLumaBoost0, overlayClearRadius0, overlayClearSoftness0, overlayDriftX0, overlayDriftY0, overlayPulseMag0, overlayPulseFreq0, overlayPulsePhase0, overlayIntensity1, overlayLumaReactivity1, overlayLumaBoost1, overlayClearRadius1, overlayClearSoftness1, overlayDriftX1, overlayDriftY1, overlayPulseMag1, overlayPulseFreq1, overlayPulsePhase1, lens, lumaReactivity, lumaBoost, clearRadius, clearSoftness, pulseMag, pulseFreq, light, rainbow, lens.lumaReactivity, lens.lumaBoost, lens.clearRadius, lens.clearSoftness, lens.pulseMag, lens.pulseFreq, light.lumaReactivity, light.lumaBoost, light.clearRadius, light.clearSoftness, light.pulseMag, light.pulseFreq, rainbow.lumaReactivity, rainbow.lumaBoost, rainbow.clearRadius, rainbow.clearSoftness, rainbow.pulseMag, rainbow.pulseFreq
- **lighting:** darknessLevel, dayOutdoor, dayIndoor, nightOutdoor, nightIndoor, minIllum
- **lightning:** r, g, b
- **overhead-stamp:** verticalOnly, sunLatitude, indoorShadowEnabled, indoorShadowOpacity, outdoorBuildingShadowOpacity, indoorShadowLengthScale, outdoorBuildingShadowLengthScale, indoorShadowSoftness, indoorFluidShadowSoftness, indoorFluidShadowIntensityBoost, indoorFluidColorSaturation, tileProjectionSortBias, skyReachShadowEnabled, skyReachShadowOpacity, upperFloorTileShadowEnabled, upperFloorTileShadowOpacity, upperFloorTileShadowLengthScale, upperFloorTileCombineMode, dynamicLightShadowOverrideEnabled, dynamicLightShadowOverrideStrength
- **painted-shadow:** sunLatitude, dynamicLightShadowOverrideEnabled, dynamicLightShadowOverrideStrength
- **player-light:** r, g, b, lowLightVision, infravision, activeIR
- **prism:** hasPrismMask
- **sky-reach-shadows:** sunLatitude, useDriverUpperFloorComposite, dynamicLightShadowOverrideEnabled, dynamicLightShadowOverrideStrength
- **smelly-flies:** flying, spawnDuration, noiseStrength, tetherStrength, maxSpeed, drag, landChance, landingDuration, flyHeight, walking, walkSpeed, minIdleTime, maxIdleTime, minMoveDistance, maxMoveDistance, takeoffChance, rotationSpeed, visual, flyingScale, walkingScale, motionBlurEnabled, motionBlurStrength, motionBlurMaxLength, fadeInDuration, fadeOutDuration, minX, minY, maxX, maxY, centerX, centerY, width, height, SPAWNING, FLYING, LANDING, WALKING, TAKING_OFF, IDLE, ROTATING, MOVING, flying.spawnDuration, flying.drag, flying.landingDuration, walking.spawnDuration, walking.noiseStrength, walking.tetherStrength, walking.maxSpeed, walking.drag, walking.landChance, walking.landingDuration, walking.flyHeight, visual.spawnDuration, visual.noiseStrength, visual.tetherStrength, visual.maxSpeed, visual.drag, visual.landChance, visual.landingDuration, visual.flyHeight, masterEnabled
- **specular:** r, g, b
- **tree:** windAttackRamp, windDecayRamp, buildingShadowDarkenStrength, buildingShadowDarkenCurve, paintedShadowDarkenStrength, paintedShadowDarkenCurve, clumpIdDebug, clumpWaveEnabled, clumpWaveMix
- **underwater-bubbles:** edgeScanStride, interiorScanStride, maskThreshold
- **water:** r, g, b, rainPrecipitation, waveAppearanceOffsetDeg, waveDirFieldEnabled, waveDirFieldMaxDeg, waveDirFieldScale, waveDirFieldSpeed, advectionSpeed, foamColor, foamStrength, foamThreshold, foamShoreCorePower, foamShoreCoreStrength, foamShoreTailPower, foamShoreTailStrength, foamScale, foamSpeed, foamCurlStrength, foamCurlScale, foamCurlSpeed, foamBreakupStrength1, foamBreakupScale1, foamBreakupSpeed1, foamBreakupStrength2, foamBreakupScale2, foamBreakupSpeed2, foamBlackPoint, foamWhitePoint, foamGamma, foamContrast, foamBrightness, buildResolution, maskThreshold, maskChannel, maskInvert, maskBlurRadius, maskBlurPasses, maskExpandPx, shoreWidthPx, uWaterDepthShadowEnabled, uWaterDepthShadowStrength, uWaterDepthShadowMinBrightness, uMicroChopIntensity, uMicroChopScale, uMicroChopSpeed
- **weather:** wetnessWettingDuration, wetnessDryingDuration, wetnessPrecipThreshold, rainSplashIntensityScale, rainSplashLifeMin, rainSplashLifeMax, rainSplashSizeMin, rainSplashSizeMax, rainSplashOpacityPeak, ashIntensityScale, ashEmissionRate, ashSizeMin, ashSizeMax, ashLifeMin, ashLifeMax, ashSpeedMin, ashSpeedMax, ashOpacityStartMin, ashOpacityStartMax, ashOpacityEnd, ashColorStart, ashR, ashG, ashB, ashColorEnd, ashBrightness, ashMaterialTint, ashAshLifeBrighten, ashAshLifeAlphaFade, ashGravityScale, ashWindInfluence, ashCurlStrength, ashCurlNoiseScale, ashCurlTimeScale, ashAshWindBase, ashEmberEmissionRate, ashEmberSizeMin, ashEmberSizeMax, ashEmberLifeMin, ashEmberLifeMax, ashEmberSpeedMin, ashEmberSpeedMax, ashEmberOpacityStartMin, ashEmberOpacityStartMax, ashEmberOpacityEnd, ashEmberColorStart, ashEmberColorEnd, ashEmberBrightness, ashEmberGravityScale, ashEmberWindInfluence, ashEmberCurlStrength, ashEmberCurlNoiseScale, ashEmberCurlTimeScale, ashEmberWindBase, masterEnabled
- **weather-lightning:** lightningShadowFlashGamma
- **windowLight:** r, g, b, todTimelineEnabled, useCameraGradeAnchorHours

## Scoring reference

| Signal                | Score impact |
| --------------------- | ------------ |
| NOT_IN_RUNTIME_PARAMS | +40          |
| ZERO_CODE_REFS        | +35          |
| NOT_IN_UI_GROUP       | +10          |
| UI_BRIDGE_WIRED       | −45          |
| RUNTIME_RESOLVED      | −35          |
| PREFIX_WIRED          | −20          |
| SHADER_REF            | −15          |
| HIDDEN                | −30          |
| MARKED_UNUSED         | −40          |
