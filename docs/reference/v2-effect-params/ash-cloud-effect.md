# AshCloudEffectV2

**V2 class:** `AshCloudEffectV2` · **Source:** `legacy/compositor-v2/effects/AshCloudEffectV2.js`

**Rebuilt in V3 as:** `surface.particles (draw)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Ground Ash Clouds _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Pool Size | `spritePoolSize` | slider | 4 … 48 | 24 |  |
| Sparse Weight | `sparseWeight` | slider | 0 … 1 | 0.65 |  |
| | | | | | _Prefer wispy sparse PNGs at higher values; full clouds at lower._ |

### Appearance

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Scale Min | `spriteScaleMin` | slider | 100 … 3000 | 400 |  |
| Scale Max | `spriteScaleMax` | slider | 200 … 4000 | 1400 |  |
| Opacity Min | `spriteOpacityMin` | slider | 0.05 … 1 | 0.35 |  |
| Opacity Max | `spriteOpacityMax` | slider | 0.05 … 1 | 0.85 |  |
| Ash Grey Tint | `ashColor` | color |  | {"r":0.082,"g":0.078,"b":0.072} |  |
| | | | | | _Dark charcoal grey — lower RGB = darker puffs._ |
| Opacity Cap | `opacityCap` | slider | 0.02 … 0.85 | 0.68 |  |
| | | | | | _Maximum alpha per puff. Raise for denser ground-haze; lower for subtle wisps._ |

### Fade Timing _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Fade In (s) | `fadeInDuration` | slider | 0.3 … 8 | 2 |  |
| Fade Out (s) | `fadeOutDuration` | slider | 2 … 40 | 18 |  |

### Motion _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Wind Influence | `windInfluence` | slider | 0 … 3 | 1.4 |  |
| Drift Speed | `driftSpeed` | slider | 0.001 … 0.06 | 0.014 |  |
| Min Drift Speed | `minDriftSpeed` | slider | 0 … 0.02 | 0.003 |  |
| Drift Response | `driftResponsiveness` | slider | 0.05 … 3 | 0.45 |  |
| Drift Max Speed | `driftMaxSpeed` | slider | 0.05 … 1.5 | 0.55 |  |
| Orbit Strength | `driftOrbitStrength` | slider | 0 … 0.5 | 0.12 |  |
| Height Above Ground | `ashHeightOffset` | slider | 0.05 … 2 | 0.28 |  |

### Organic Motion _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Domain Warp | `domainWarpStrength` | slider | 0 … 0.12 | 0.03 |  |
| Warp Speed | `domainWarpSpeed` | slider | 0 … 3 | 1 |  |
| Reveal Noise Scale | `revealNoiseScale` | slider | 0.00002 … 0.001 | 0.00012 |  |
| | | | | | _Lower = larger organic reveal patches._ |
| Reveal Threshold | `revealThreshold` | slider | 0.1 … 0.9 | 0.55 |  |
| Reveal Softness | `revealSoftness` | slider | 0.02 … 0.45 | 0.18 |  |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Enabled | `enabled` | boolean |  | true |  |
