# SceneWindField

**V2 class:** `SceneWindField` · **Source:** `legacy/core/SceneWindField.js`

**Rebuilt in V3 as:** `frame.snapshot`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Wind Profile Tuning

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Gap ratio tune | `gapRatioTune` | slider | 0.2 … 2 | 1 |  |
| | | | | | _Scales astrolabe-derived gap ratio for this scene._ |
| Gap softness tune | `gapSoftnessTune` | slider | 0.2 … 2 | 1 |  |
| | | | | | _Wider = softer gust-front ramps on vegetation._ |
| Storm floor tune | `spatialFloorTune` | slider | 0 … 2 | 1 |  |
| | | | | | _Scales minimum wind strength during storm-tier slider positions._ |
| Storm swing tune | `stormSwingTune` | slider | 0 … 2 | 1 |  |
| | | | | | _Scales rapid direction oscillation at high wind slider._ |
| Wave sharpness tune | `waveSharpnessTune` | slider | 0.2 … 2 | 1 |  |
| Vegetation attack | `windAttackRamp` | slider | 0.1 … 10 | 2.5 |  |
| | | | | | _How quickly trees/bushes ramp up when wind rises._ |
| Vegetation decay | `windDecayRamp` | slider | 0.05 … 5 | 0.88 |  |
| | | | | | _How slowly trees/bushes tail off when wind drops._ |
| Bend rise softness | `bendRiseSoftness` | slider | 0.05 … 1 | 0.35 |  |
| | | | | | _Softens spatial gust-front bend onset on canopies._ |

### Propagation & Gaps

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Wave spacing | `waveSpatialFrequency` | slider | 0.0001 … 0.01 | 0.0014 |  |
| | | | | | _Distance between gust fronts along the wind direction._ |
| Wave speed | `waveTravelSpeed` | slider | 0.05 … 4 | 0.7 |  |
| | | | | | _How fast gust fronts travel across the map._ |
| Wave sharpness | `waveSharpness` | slider | 0.5 … 8 | 3.5 |  |
| | | | | | _Higher = crisper gust peaks and longer lulls between them._ |
| Gap ratio | `gapRatio` | slider | 0 … 0.9 | 0.55 |  |
| | | | | | _Fraction of each wave cycle spent in calm lulls (canopies can reset)._ |
| Gap softness | `gapSoftness` | slider | 0.01 … 0.5 | 0.04 |  |
| | | | | | _Blend width at gust-front edges._ |
| Direction evolution | `directionEvolutionScale` | slider | 0 … 3 | 1 |  |
| | | | | | _Scales WeatherController heading meander (compass still sets base bearing)._ |

### Cloud Drift

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Cloud wind influence | `windInfluence` | slider | 0 … 2 | 1.33 |  |
| | | | | | _How strongly compass wind speed drives cloud advection._ |
| Cloud drift speed | `driftSpeed` | slider | 0 … 0.1 | 0.061 |  |
| Min cloud drift | `minDriftSpeed` | slider | 0 … 0.05 | 0.002 |  |
| | | | | | _Baseline advection in wind direction — clouds never fully stop._ |
| Cloud accel response | `driftResponsiveness` | slider | 0 … 1 | 0.75 |  |
| | | | | | _How quickly clouds speed up when wind rises._ |
| Cloud decel rate | `driftDecelFactor` | slider | 0.02 … 1 | 0.14 |  |
| | | | | | _Fraction of accel response used when wind drops (lower = slower coast-down)._ |
| Max cloud drift | `driftMaxSpeed` | slider | 0 … 2 | 0.5 |  |

### Water Coupling

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Water wind response | `windDirResponsiveness` | slider | 0.05 … 30 | 10 |  |
| Water wind override | `windOverrideEnabled` | boolean |  | true |  |
| Override bearing | `windOverrideBearingDeg` | slider | 0 … 360 | 90 |  |
| Override speed | `windOverrideSpeed01` | slider | 0 … 1 | 0.2 |  |

### Vegetation Response

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Vegetation wind response | `windResponse` | slider | 0 … 3 | 0.06 |  |
| | | | | | _How strongly trees/bushes respond to scene wind (not a second speed source)._ |
| Vegetation catch-up | `windRampSpeed` | slider | 0.1 … 10 | 1.32 |  |
| Gust strength mix | `vegetationWaveInfluence` | slider | 0 … 1 | 1 |  |
| | | | | | _How fully gust fronts drive bend (1 = full calm in lulls)._ |
| Clump wave field | `clumpWaveEnabled` | boolean |  | true |  |
| Clump wave mix | `clumpWaveMix` | slider | 0 … 1 | 1 |  |

### Particles & Rain

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Fire wind influence | `fireWindInfluence` | slider | 0 … 5 | 0.7 |  |
| Fire wind kill | `fireWeatherWindKill` | slider | 0 … 5 | 0.9 |  |
| Fog advection | `fogAdvectionSpeed` | slider | 0 … 5 | 1.7 |  |
| Fog wind response | `fogWindDirResponsiveness` | slider | 0.05 … 20 | 6 |  |
| Rain wind influence | `rainWindInfluence` | slider | 0 … 3 | 1 |  |
| Snow wind influence | `snowWindInfluence` | slider | 0 … 3 | 1 |  |
