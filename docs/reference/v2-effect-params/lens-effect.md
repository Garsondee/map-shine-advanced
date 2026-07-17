# LensEffectV2

**V2 class:** `LensEffectV2` · **Source:** `legacy/compositor-v2/effects/LensEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Optical distortions

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| distortionAmount | `distortionAmount` | slider | -0.5 … 0.5 | -0.07 |  |
| distortionCenterX | `distortionCenterX` | slider | 0 … 1 | 0.5 |  |
| distortionCenterY | `distortionCenterY` | slider | 0 … 1 | 0.5 |  |
| chromaticAmountPx | `chromaticAmountPx` | slider | 0 … 8 | 4.22 |  |
| chromaticEdgePower | `chromaticEdgePower` | slider | 0.1 … 4 | 2.11 |  |
| vignetteIntensity | `vignetteIntensity` | slider | 0 … 1 | 1 |  |
| vignetteSoftness | `vignetteSoftness` | slider | 0.05 … 1 | 0.34 |  |
| grainAmount | `grainAmount` | slider | 0 … 0.25 | 0.01 |  |
| grainSpeed | `grainSpeed` | slider | 0 … 6 | 1 |  |
| Adaptive Grain (Low-Light) | `adaptiveGrainEnabled` | boolean |  | true |  |
| Low-Light Grain Boost | `grainLowLightBoost` | slider | 0 … 3 | 0.25 |  |
| Grain Cell Size Bright | `grainCellSizeBright` | slider | 1 … 4 | 1.4 |  |
| Grain Cell Size Dark | `grainCellSizeDark` | slider | 1 … 8 | 3 |  |
| Enable Digital Chroma Noise | `digitalNoiseEnabled` | boolean |  | false |  |
| Digital Noise Amount | `digitalNoiseAmount` | slider | 0 … 0.15 | 0.066 |  |
| Digital Noise Chance | `digitalNoiseChance` | slider | 0 … 0.5 | 0.004 |  |
| Digital Noise Green Bias | `digitalNoiseGreenBias` | slider | 0 … 1 | 1 |  |
| Digital Noise Low-Light Boost | `digitalNoiseLowLightBoost` | slider | 0 … 4 | 3.37 |  |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| enabled | `enabled` | boolean |  | false | hidden |
| Enable Illumination-Driven Dynamics | `dynamicLayersEnabled` | boolean |  | true |  |
| Auto Texture Cycle (s) | `layerCycleSeconds` | slider | 8 … 180 | 36 |  |
| Light Fade Time (s) | `lumaSmoothingSeconds` | slider | 0 … 3 | 1 |  |
| Texture Swap Fade (s) | `layerSwapFadeSeconds` | slider | 0 … 3 | 0.8 |  |
| Enable Autofocus Defocus | `autoFocusEnabled` | boolean |  | true |  |
| Min Interval (s) | `autoFocusMinIntervalSeconds` | slider | 10 … 240 | 45 |  |
| Max Interval (s) | `autoFocusMaxIntervalSeconds` | slider | 10 … 300 | 130 |  |
| Defocus Duration (s) | `autoFocusDefocusDurationSeconds` | slider | 0.05 … 2 | 2 |  |
| Max Blur (px) | `autoFocusMaxBlurPx` | slider | 0 … 8 | 2.75 |  |
| Max Shift (px) | `autoFocusMaxShiftPx` | slider | 0 … 6 | 6 |  |
| Zoom Triggers Refocus | `autoFocusZoomTriggerEnabled` | boolean |  | true |  |
| Zoom Trigger Threshold | `autoFocusZoomTriggerThreshold` | slider | 0.05 … 3 | 3 |  |
| Zoom Trigger Cooldown (s) | `autoFocusZoomTriggerCooldownSeconds` | slider | 0 … 6 | 6 |  |
| Zoom Trigger Strength | `autoFocusZoomTriggerStrength` | slider | 0.1 … 2.5 | 0.3 |  |
| Enable Light Burn | `lightBurnEnabled` | boolean |  | true |  |
| Bright Threshold | `lightBurnThreshold` | slider | 0 … 1 | 0.99 |  |
| Threshold Softness | `lightBurnThresholdSoftness` | slider | 0.001 … 0.5 | 0.5 |  |
| Persistence (s) | `lightBurnPersistenceSeconds` | slider | 0.05 … 8 | 0.1 |  |
| Burn Response | `lightBurnResponse` | slider | 0.1 … 3 | 1.15 |  |
| Burn Intensity | `lightBurnIntensity` | slider | 0 … 2.5 | 0.15 |  |
| Burn Blur (px) | `lightBurnBlurPx` | slider | 0 … 8 | 5 |  |
| Gate Burn by Scene Darkness | `lightBurnDarknessGateEnabled` | boolean |  | true |  |
| Darkness Gate Start | `lightBurnDarknessStart` | slider | 0 … 1 | 0.45 |  |
| Darkness Gate End | `lightBurnDarknessEnd` | slider | 0 … 1 | 0.78 |  |
| Darkness Gate Influence | `lightBurnDarknessInfluence` | slider | 0 … 1 | 1 |  |
| Enable Camera Motion Blur | `motionBlurEnabled` | boolean |  | false |  |
| Motion Blur Strength | `motionBlurStrength` | slider | 0 … 2 | 1.77 |  |
| Motion Blur Max (px) | `motionBlurMaxPx` | slider | 0 … 10 | 5 |  |
| Zoom Blur Strength | `motionBlurZoomStrength` | slider | 0 … 8 | 1.25 |  |
| Motion Blur Smoothing (s) | `motionBlurSmoothingSeconds` | slider | 0 … 0.8 | 0.8 |  |
| Enable Viewfinder Overlay | `viewfinderEnabled` | boolean |  | true |  |
| Viewfinder Texture | `viewfinderSelection` | string | None / lens_overlay_01 / lens_overlay_02 | none |  |
| viewfinderIntensity | `viewfinderIntensity` | slider | 0 … 2 | 0.6 |  |
| viewfinderLumaReactivity | `viewfinderLumaReactivity` | slider | 0 … 1 | 0.1 |  |
| viewfinderLumaBoost | `viewfinderLumaBoost` | slider | 0.5 … 4 | 1.1 |  |
| viewfinderDriftX | `viewfinderDriftX` | slider | -0.001 … 0.001 | 0 |  |
| viewfinderDriftY | `viewfinderDriftY` | slider | -0.001 … 0.001 | 0 |  |
| viewfinderPulseMag | `viewfinderPulseMag` | slider | 0 … 0.3 | 0 |  |
| viewfinderPulseFreq | `viewfinderPulseFreq` | slider | 0 … 2 | 0 |  |
| Texture | `structuralSelection` | string | None / Auto / lens_dust_01 / lens_grease_01 / lens_grease_02 / lens_grease_03 / lens_scratches_01 | auto |  |
| structuralIntensity | `structuralIntensity` | slider | 0 … 2 | 0.6 |  |
| structuralLumaReactivity | `structuralLumaReactivity` | slider | 0 … 1 | 1 |  |
| structuralLumaBoost | `structuralLumaBoost` | slider | 0.5 … 4 | 4 |  |
| Reveal Luma Min | `structuralLumaMin` | slider | 0 … 1 | 0 |  |
| Reveal Luma Max | `structuralLumaMax` | slider | 0 … 1 | 1 |  |
| Reveal Influence | `structuralLumaInfluence` | slider | 0 … 1 | 1 |  |
| structuralClearRadius | `structuralClearRadius` | slider | 0 … 0.5 | 0.43 |  |
| structuralClearSoftness | `structuralClearSoftness` | slider | 0.01 … 0.3 | 0.1 |  |
| structuralDriftX | `structuralDriftX` | slider | -0.001 … 0.001 | 0.00006 |  |
| structuralDriftY | `structuralDriftY` | slider | -0.001 … 0.001 | 0.00004 |  |
| structuralPulseMag | `structuralPulseMag` | slider | 0 … 0.3 | 0.19 |  |
| structuralPulseFreq | `structuralPulseFreq` | slider | 0 … 2 | 0.08 |  |
| Texture | `opticalSelection` | string | None / Auto / lens_leak_01 / lens_leak_02 | auto |  |
| opticalIntensity | `opticalIntensity` | slider | 0 … 2 | 1.53 |  |
| opticalLumaReactivity | `opticalLumaReactivity` | slider | 0 … 1 | 1 |  |
| opticalLumaBoost | `opticalLumaBoost` | slider | 0.5 … 4 | 1.15 |  |
| Reveal Luma Min | `opticalLumaMin` | slider | 0 … 1 | 0 |  |
| Reveal Luma Max | `opticalLumaMax` | slider | 0 … 1 | 1 |  |
| Reveal Influence | `opticalLumaInfluence` | slider | 0 … 1 | 0.47 |  |
| opticalClearRadius | `opticalClearRadius` | slider | 0 … 0.5 | 0.28 |  |
| opticalClearSoftness | `opticalClearSoftness` | slider | 0.01 … 0.3 | 0.12 |  |
| opticalDriftX | `opticalDriftX` | slider | -0.001 … 0.001 | 0.00005 |  |
| opticalDriftY | `opticalDriftY` | slider | -0.001 … 0.001 | 0.00005 |  |
| opticalPulseMag | `opticalPulseMag` | slider | 0 … 0.3 | 0.17 |  |
| opticalPulseFreq | `opticalPulseFreq` | slider | 0 … 2 | 0.11 |  |
| Texture | `reactiveSelection` | string | None / Auto / light_leak_01 / light_leak_02 / rainbow_chroma_01 / rainbow_chroma_02 | light_leak_02 |  |
| reactiveIntensity | `reactiveIntensity` | slider | 0 … 2 | 0.97 |  |
| reactiveLumaReactivity | `reactiveLumaReactivity` | slider | 0 … 1 | 1 |  |
| reactiveLumaBoost | `reactiveLumaBoost` | slider | 0.5 … 5 | 1.95 |  |
| Reveal Luma Min | `reactiveLumaMin` | slider | 0 … 1 | 0 |  |
| Reveal Luma Max | `reactiveLumaMax` | slider | 0 … 1 | 1 |  |
| Reveal Influence | `reactiveLumaInfluence` | slider | 0 … 1 | 0.53 |  |
| reactiveClearRadius | `reactiveClearRadius` | slider | 0 … 0.5 | 0.28 |  |
| reactiveClearSoftness | `reactiveClearSoftness` | slider | 0.01 … 0.3 | 0.14 |  |
| reactiveDriftX | `reactiveDriftX` | slider | -0.001 … 0.001 | 0.0001 |  |
| reactiveDriftY | `reactiveDriftY` | slider | -0.001 … 0.001 | 0.00006 |  |
| reactivePulseMag | `reactivePulseMag` | slider | 0 … 0.3 | 0.11 |  |
| reactivePulseFreq | `reactivePulseFreq` | slider | 0 … 2 | 0.17 |  |
