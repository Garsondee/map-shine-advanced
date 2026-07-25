# WeatherController

**V2 class:** `WeatherController` · **Source:** `legacy/core/WeatherController.js`

**Rebuilt in V3 as:** `frame.snapshot (state)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Authored presets

`Clear Noon` · `Golden Hour` · `Overcast Day` · `Storm` · `Moonlit Night` · `Interior Night` · `Clear (Dry)` · `Clear (Breezy)` · `Partly Cloudy` · `Overcast (Light)` · `Overcast (Heavy)` · `Mist` · `Fog (Dense)` · `Drizzle` · `Light Rain` · `Rain` · `Heavy Rain` · `Thunderstorm` · `Snow Flurries` · `Snow` · `Blizzard` · `Light Ash Fall` · `Ash Fall` · `Heavy Ash Fall` · `Volcanic Storm`

## Controls, grouped as the author grouped them

### Dynamic Weather _(advanced)_

| Control             | id                      | Type       | Range                                                                                                                                                                                                                                              | Default          | Notes |
| ------------------- | ----------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----- |
| Dynamic Weather     | `dynamicEnabled`        | boolean    |                                                                                                                                                                                                                                                    | false            |       |
| Biome Preset        | `dynamicPresetId`       | (inferred) | Temperate Plains / Coastal Breeze / Misty Vale / Urban Heat Island / Desert / Steppe Winds / Volcanic Wastes / Tropical Jungle / Monsoon Season / Swamp & Marsh / Tundra / Arctic Blizzard / Permafrost Night / Highland Peaks / Thunderhead Ridge | Temperate Plains |       |
| Evolution Speed (x) | `dynamicEvolutionSpeed` | (inferred) | 0 … 600                                                                                                                                                                                                                                            | 15               |       |
| Pause Evolution     | `dynamicPaused`         | boolean    |                                                                                                                                                                                                                                                    | false            |       |

### Dynamic Bounds (GM) _(advanced)_

| Control         | id                              | Type       | Range | Default | Notes |
| --------------- | ------------------------------- | ---------- | ----- | ------- | ----- |
| Clamp To Bounds | `dynamicBoundsEnabled`          | boolean    |       | false   |       |
| Precip Min      | `dynamicBoundsPrecipitationMin` | (inferred) | 0 … 1 | 0       |       |
| Precip Max      | `dynamicBoundsPrecipitationMax` | (inferred) | 0 … 1 | 1       |       |
| Cloud Min       | `dynamicBoundsCloudCoverMin`    | (inferred) | 0 … 1 | 0       |       |
| Cloud Max       | `dynamicBoundsCloudCoverMax`    | (inferred) | 0 … 1 | 1       |       |
| Wind Min        | `dynamicBoundsWindSpeedMin`     | (inferred) | 0 … 1 | 0       |       |
| Wind Max        | `dynamicBoundsWindSpeedMax`     | (inferred) | 0 … 1 | 1       |       |
| Fog Min         | `dynamicBoundsFogDensityMin`    | (inferred) | 0 … 1 | 0       |       |
| Fog Max         | `dynamicBoundsFogDensityMax`    | (inferred) | 0 … 1 | 1       |       |
| Temp Min        | `dynamicBoundsFreezeLevelMin`   | (inferred) | 0 … 1 | 0       |       |
| Temp Max        | `dynamicBoundsFreezeLevelMax`   | (inferred) | 0 … 1 | 1       |       |

### GM Transition _(advanced)_

| Control                     | id                      | Type       | Range   | Default | Notes |
| --------------------------- | ----------------------- | ---------- | ------- | ------- | ----- |
| Transition Time (s)         | `transitionDuration`    | (inferred) | 0 … 60  | 0       |       |
| Precipitation               | `queuedPrecipitation`   | (inferred) | 0 … 1   | 0.88    |       |
| Cloud Cover                 | `queuedCloudCover`      | (inferred) | 0 … 1   | 0.93    |       |
| Wind Speed                  | `queuedWindSpeed`       | (inferred) | 0 … 1   | 0.1     |       |
| Wind Direction (deg)        | `queuedWindDirection`   | (inferred) | 0 … 360 | 205     |       |
| Fog Density                 | `queuedFogDensity`      | (inferred) | 0 … 1   | 0       |       |
| Temperature (Rain <-> Snow) | `queuedFreezeLevel`     | (inferred) | 0 … 1   | 0       |       |
| queueFromCurrent            | `queueFromCurrent`      | button     |         |         |       |
| startQueuedTransition       | `startQueuedTransition` | button     |         |         |       |

### Environment _(advanced)_

| Control           | id                     | Type    | Range | Default | Notes |
| ----------------- | ---------------------- | ------- | ----- | ------- | ----- |
| Force Indoor Mask | `roofMaskForceEnabled` | boolean |       | false   |       |

### Simulation _(advanced)_

| Control             | id                   | Type       | Range    | Default | Notes |
| ------------------- | -------------------- | ---------- | -------- | ------- | ----- |
| Transition Time (s) | `transitionDuration` | (inferred) | 0 … 60   | 0       |       |
| Simulation Speed    | `simulationSpeed`    | (inferred) | 0.05 … 3 | 1       |       |

### Fog

| Control     | id           | Type       | Range | Default | Notes |
| ----------- | ------------ | ---------- | ----- | ------- | ----- |
| Fog Density | `fogDensity` | (inferred) | 0 … 1 | 0.35    |       |

### Manual Override

| Control                     | id              | Type       | Range | Default | Notes                   |
| --------------------------- | --------------- | ---------- | ----- | ------- | ----------------------- |
| Precipitation               | `precipitation` | (inferred) | 0 … 1 | 0.34    |                         |
| Cloud Cover                 | `cloudCover`    | (inferred) | 0 … 1 | 0.53    |                         |
| Wetness                     | `wetness`       | (inferred) | 0 … 1 | 0       | **readout, not a knob** |
| Temperature (Rain <-> Snow) | `freezeLevel`   | (inferred) | 0 … 1 | 0       |                         |
| Ash Intensity               | `ashIntensity`  | (inferred) | 0 … 1 | 0       |                         |

### Wetness _(advanced)_

| Control              | id                | Type       | Range    | Default | Notes |
| -------------------- | ----------------- | ---------- | -------- | ------- | ----- |
| Wetting Duration (s) | `wettingDuration` | (inferred) | 1 … 120  | 30      |       |
| Drying Duration (s)  | `dryingDuration`  | (inferred) | 10 … 600 | 180     |       |
| Rain Threshold       | `precipThreshold` | (inferred) | 0 … 0.5  | 0.05    |       |

### Rain Particles _(advanced)_

| Control                  | id                       | Type       | Range      | Default | Notes |
| ------------------------ | ------------------------ | ---------- | ---------- | ------- | ----- |
| Rain Intensity Scale     | `rainIntensityScale`     | (inferred) | 0 … 6      | 2       |       |
| Rain Streak Length       | `rainStreakLength`       | (inferred) | 0.05 … 2.5 | 0.25    |       |
| Rain Drop Size           | `rainDropSize`           | (inferred) | 0.5 … 16   | 5.55    |       |
| Rain Drop Size Min       | `rainDropSizeMin`        | (inferred) | 0.5 … 64   | 9.4     |       |
| Rain Drop Size Max       | `rainDropSizeMax`        | (inferred) | 0.5 … 64   | 10.1    |       |
| Rain Brightness          | `rainBrightness`         | (inferred) | 0.1 … 12   | 12      |       |
| Rain Gravity Scale       | `rainGravityScale`       | (inferred) | 0.05 … 6   | 2.35    |       |
| Rain Curl Strength       | `rainCurlStrength`       | (inferred) | 0 … 12     | 11.35   |       |
| Rain Chaos (per-drop)    | `rainChaosStrength`      | (inferred) | 0 … 3      | 0.8     |       |
| Rain Fine Turbulence     | `rainTurbulenceStrength` | (inferred) | 0 … 4      | 0.5     |       |
| Rain Brightness Spread   | `rainBrightnessSpread`   | (inferred) | 0 … 2      | 0.25    |       |
| Rain Length Spread       | `rainLengthSpread`       | (inferred) | 0 … 2      | 0.05    |       |
| Rain highlight (magenta) | `debugRainHighlight`     | boolean    |            | false   |       |

### Roof & tree drips _(advanced)_

| Control                 | id                         | Type       | Range       | Default | Notes |
| ----------------------- | -------------------------- | ---------- | ----------- | ------- | ----- |
| Drips Enabled           | `roofDripEnabled`          | boolean    |             | false   |       |
| Drip Emission (rain)    | `roofDripEmissionRainMult` | (inferred) | 0 … 2000    | 300     |       |
| Drip Emission (tail)    | `roofDripEmissionTailMult` | (inferred) | 0 … 2000    | 260     |       |
| Post-Rain Drip Tail (s) | `roofDripTailDurationSec`  | (inferred) | 0 … 900     | 300     |       |
| Particle Life Min (s)   | `roofDripLifeMin`          | (inferred) | 0.2 … 12    | 1.9     |       |
| Particle Life Max (s)   | `roofDripLifeMax`          | (inferred) | 0.2 … 16    | 3.85    |       |
| Drop Size Min           | `roofDripSizeMin`          | (inferred) | 0.02 … 8    | 0.28    |       |
| Drop Size Max           | `roofDripSizeMax`          | (inferred) | 0.02 … 12   | 0.52    |       |
| Max Particles           | `roofDripMaxParticles`     | (inferred) | 200 … 80000 | 22000   |       |

### Rain Splashes _(advanced)_

| Control                              | id                          | Type       | Range      | Default | Notes |
| ------------------------------------ | --------------------------- | ---------- | ---------- | ------- | ----- |
| Splash 1 (Thin Ring) Intensity       | `rainSplash1IntensityScale` | (inferred) | 0 … 10     | 8.45    |       |
| Splash 1 (Thin Ring) Life Min (s)    | `rainSplash1LifeMin`        | (inferred) | 0.005 … 1  | 0.2     |       |
| Splash 1 (Thin Ring) Life Max (s)    | `rainSplash1LifeMax`        | (inferred) | 0.01 … 1.5 | 0.35    |       |
| Splash 1 (Thin Ring) Size Min (px)   | `rainSplash1SizeMin`        | (inferred) | 2 … 128    | 8       |       |
| Splash 1 (Thin Ring) Size Max (px)   | `rainSplash1SizeMax`        | (inferred) | 2 … 256    | 16      |       |
| Splash 1 (Thin Ring) Peak Opacity    | `rainSplash1OpacityPeak`    | (inferred) | 0 … 1      | 0.14    |       |
| Splash 2 (Broken Ring) Intensity     | `rainSplash2IntensityScale` | (inferred) | 0 … 10     | 8.7     |       |
| Splash 2 (Broken Ring) Life Min (s)  | `rainSplash2LifeMin`        | (inferred) | 0.005 … 1  | 0.09    |       |
| Splash 2 (Broken Ring) Life Max (s)  | `rainSplash2LifeMax`        | (inferred) | 0.01 … 1.5 | 0.22    |       |
| Splash 2 (Broken Ring) Size Min (px) | `rainSplash2SizeMin`        | (inferred) | 2 … 128    | 2       |       |
| Splash 2 (Broken Ring) Size Max (px) | `rainSplash2SizeMax`        | (inferred) | 2 … 256    | 3       |       |
| Splash 2 (Broken Ring) Peak Opacity  | `rainSplash2OpacityPeak`    | (inferred) | 0 … 1      | 0.14    |       |
| Splash 3 (Droplets) Intensity        | `rainSplash3IntensityScale` | (inferred) | 0 … 10     | 9.1     |       |
| Splash 3 (Droplets) Life Min (s)     | `rainSplash3LifeMin`        | (inferred) | 0.005 … 1  | 0.2     |       |
| Splash 3 (Droplets) Life Max (s)     | `rainSplash3LifeMax`        | (inferred) | 0.01 … 1.5 | 0.79    |       |
| Splash 3 (Droplets) Size Min (px)    | `rainSplash3SizeMin`        | (inferred) | 2 … 128    | 6       |       |
| Splash 3 (Droplets) Size Max (px)    | `rainSplash3SizeMax`        | (inferred) | 2 … 256    | 27      |       |
| Splash 3 (Droplets) Peak Opacity     | `rainSplash3OpacityPeak`    | (inferred) | 0 … 1      | 0.33    |       |
| Splash 4 (Puddle) Intensity          | `rainSplash4IntensityScale` | (inferred) | 0 … 10     | 9.25    |       |
| Splash 4 (Puddle) Life Min (s)       | `rainSplash4LifeMin`        | (inferred) | 0.005 … 1  | 0.305   |       |
| Splash 4 (Puddle) Life Max (s)       | `rainSplash4LifeMax`        | (inferred) | 0.01 … 1.5 | 1.4     |       |
| Splash 4 (Puddle) Size Min (px)      | `rainSplash4SizeMin`        | (inferred) | 2 … 128    | 10      |       |
| Splash 4 (Puddle) Size Max (px)      | `rainSplash4SizeMax`        | (inferred) | 2 … 256    | 24      |       |
| Splash 4 (Puddle) Peak Opacity       | `rainSplash4OpacityPeak`    | (inferred) | 0 … 1      | 0.08    |       |

### Snow Particles _(advanced)_

| Control               | id                    | Type       | Range    | Default | Notes |
| --------------------- | --------------------- | ---------- | -------- | ------- | ----- |
| Snow Intensity Scale  | `snowIntensityScale`  | (inferred) | 0 … 6    | 3       |       |
| Snow Flake Size       | `snowFlakeSize`       | (inferred) | 0.05 … 3 | 1.5     |       |
| Snow Brightness       | `snowBrightness`      | (inferred) | 0.1 … 3  | 1       |       |
| Snow Gravity Scale    | `snowGravityScale`    | (inferred) | 0.01 … 3 | 0.01    |       |
| Snow Curl Strength    | `snowCurlStrength`    | (inferred) | 0 … 12   | 11.25   |       |
| Snow Flutter Strength | `snowFlutterStrength` | (inferred) | 0 … 6    | 4.65    |       |

### Flurries _(advanced)_

| Control           | id                        | Type       | Range   | Default | Notes |
| ----------------- | ------------------------- | ---------- | ------- | ------- | ----- |
| Rain/Snow Flurry  | `precipFlurryVariability` | (inferred) | 0 … 1   | 0       |       |
| Ash Flurry        | `ashFlurryVariability`    | (inferred) | 0 … 1   | 0       |       |
| Flurry Time Scale | `flurryTimeScale`         | (inferred) | 0.1 … 6 | 1       |       |
| Lull Floor        | `flurryLullFloor`         | (inferred) | 0 … 0.5 | 0.05    |       |
| Burst Peak Max    | `flurryBurstPeakMax`      | (inferred) | 1 … 6   | 3       |       |

### Ungrouped

| Control                    | id                                | Type       | Range        | Default | Notes  |
| -------------------------- | --------------------------------- | ---------- | ------------ | ------- | ------ |
| Preset Transition (min)    | `presetTransitionDurationMinutes` | (inferred) | 0.5 … 60     | 0.5     |        |
| Transition Duration (min)  | `dynamicPlanDurationMinutes`      | (inferred) | 0.1 … 60     | 6       |        |
| Ash Intensity              | `queuedAshIntensity`              | (inferred) | 0 … 1        | 0       |        |
| Enabled                    | `enabled`                         | boolean    |              | true    |        |
| Rain Wind Influence        | `rainWindInfluence`               | (inferred) | 0 … 4        | 2.3     | hidden |
| Drip Debug Emission ×      | `roofDripDebugEmissionMul`        | (inferred) | 0.1 … 20     | 2.5     |        |
| Spawn Pool Budget          | `roofDripGlobalBudget`            | (inferred) | 500 … 200000 | 90000   |        |
| Max Points / Source        | `roofDripMaxPerTile`              | (inferred) | 16 … 20000   | 4000    |        |
| GPU Roof Max Spawns        | `roofDripGpuMaxSpawnCap`          | (inferred) | 512 … 120000 | 60000   |        |
| GPU Alpha Threshold        | `roofDripAlphaThresholdGpu`       | (inferred) | 0.02 … 0.6   | 0.16    |        |
| Pool Rebuild Interval (s)  | `roofDripPointsRefreshSec`        | (inferred) | 0.15 … 8     | 0.75    |        |
| Drip Gravity × (vs rain)   | `roofDripGravityMul`              | (inferred) | 0.05 … 3     | 0.64    |        |
| Screen-Down Z Mix          | `roofDripScreenDownZMix`          | (inferred) | 0.05 … 0.95  | 0.65    |        |
| Drip Wind Base             | `roofDripWindBase`                | (inferred) | 0 … 120      | 14      |        |
| Drip Wind × Precip/Wind    | `roofDripWindCoupling`            | (inferred) | 0 … 1        | 0.12    |        |
| Drip Turb × Rain Turb      | `roofDripCurlMul`                 | (inferred) | 0 … 2        | 0.38    |        |
| Drip Streak Length         | `roofDripSpeedFactor`             | (inferred) | 0.002 … 0.08 | 0.0065  |        |
| Streak Anchor (world)      | `roofDripStreakAnchorHalf`        | (inferred) | 0 … 80       | 4       |        |
| Start Speed Min            | `roofDripParticleSpeedMin`        | (inferred) | 0 … 400      | 40      |        |
| Start Speed Max            | `roofDripParticleSpeedMax`        | (inferred) | 0 … 600      | 115     |        |
| UV Centroid Pull           | `roofDripSpawnInwardPull`         | (inferred) | 0 … 0.45     | 0       |        |
| UV Spawn Jitter            | `roofDripSpawnUvJitter`           | (inferred) | 0 … 0.2      | 0       |        |
| Emitter Normal Jitter      | `roofDripEmitterNormalJitter`     | (inferred) | 0 … 30       | 1       |        |
| Emitter Edge Jitter        | `roofDripEmitterTangentialJitter` | (inferred) | 0 … 30       | 0.6     |        |
| Kill Floor Margin (Z)      | `roofDripKillZMargin`             | (inferred) | 0 … 800      | 220     |        |
| Tile Fallback Edge Spacing | `roofDripTileEdgeSpacing`         | (inferred) | 8 … 256      | 20      |        |
| Tree Edge Spacing          | `roofDripTreeEdgeSpacing`         | (inferred) | 8 … 256      | 36      |        |
| Tree Interior Samples      | `roofDripTreeInteriorSamples`     | (inferred) | 0 … 2000     | 280     |        |
| Use GPU Roof Edges         | `roofDripUseGpuRoofEdges`         | boolean    |              | false   |        |
| Snow Wind Influence        | `snowWindInfluence`               | (inferred) | 0 … 2        | 0.85    | hidden |
