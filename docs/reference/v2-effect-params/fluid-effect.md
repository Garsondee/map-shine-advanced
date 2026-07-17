# FluidEffectV2

**V2 class:** `FluidEffectV2` · **Source:** `legacy/compositor-v2/effects/FluidEffectV2.js`

**Rebuilt in V3 as:** `sims.fluids`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Appearance

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Intensity | `intensity` | slider | 0 … 3 | 1 |  |
| Opacity | `opacity` | slider | 0 … 1 | 1 |  |
| Color A (Young) | `colorA` | color |  | #ffffff |  |
| Color B (Old) | `colorB` | color |  | #ffffff |  |
| Age Gamma | `ageGamma` | slider | 0.1 … 4 | 1 |  |

### Mask Thresholds _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Low Threshold | `maskThresholdLo` | slider | 0 … 0.5 | 0 |  |
| High Threshold | `maskThresholdHi` | slider | 0 … 1 | 1 |  |

### Flow & Motion

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Flow Mode (0=Ping-Pong, 1=Directional) | `flowMode` | slider | 0 … 1 | 1 |  |
| Flow Speed | `flowSpeed` | slider | 0 … 2 | 0.21 |  |
| Slug Count | `pulseFrequency` | slider | 0.5 … 20 | 9.8 |  |
| Gap Transparency | `pulseStrength` | slider | 0 … 1 | 1 |  |
| Slug Width | `slugWidth` | slider | 0.05 … 0.95 | 0.58 |  |
| Edge Softness | `edgeSoftness` | slider | 0.005 … 0.2 | 0.095 |  |

### Noise & Bubbles _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Noise Scale | `noiseScale` | slider | 0.5 … 30 | 6 |  |
| Noise Strength | `noiseStrength` | slider | 0 … 1 | 0 |  |
| Bubble Scale | `bubbleScale` | slider | 1 … 60 | 18 |  |
| Bubble Strength | `bubbleStrength` | slider | 0 … 2 | 0 |  |

### Edge Effects _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Edge Noise Scale | `edgeNoiseScale` | slider | 0.5 … 20 | 0.5 |  |
| Edge Noise Amp | `edgeNoiseAmp` | slider | 0 … 0.3 | 0 |  |
| Meniscus Strength | `meniscusStrength` | slider | 0 … 1 | 0 |  |

### Foam _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Foam Strength | `foamStrength` | slider | 0 … 1 | 0 |  |
| Foam Scale | `foamScale` | slider | 5 … 80 | 30 |  |
| Foam Width | `foamWidth` | slider | 0.02 … 0.5 | 0.15 |  |
| Foam Tint | `foamTint` | slider | 0 … 1 | 0.15 |  |
| Trailing Foam | `foamTrailStrength` | slider | 0 … 1 | 0.15 |  |
| Edge Foam | `edgeFoamStrength` | slider | 0 … 1 | 0.2 |  |
| Foam Density | `foamDensity` | slider | 0 … 1 | 0.5 |  |
| Foam Frothiness | `foamFrothiness` | slider | 0 … 1 | 0.3 |  |

### Surface Effects _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Caustics Enabled | `causticEnabled` | boolean |  | false |  |
| Caustic Strength | `causticStrength` | slider | 0 … 2 | 0.65 |  |
| Caustic Scale | `causticScale` | slider | 1 … 60 | 12 |  |
| RGB Shift | `rgbShift` | slider | 0 … 10 | 3.45 |  |

### Iridescence _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Strength | `iridescenceStrength` | slider | 0 … 3 | 3 |  |
| Animation Speed | `iriSpeed` | slider | 0 … 3 | 0.5 |  |
| Film Scale | `iriScale` | slider | 0.5 … 15 | 2.3 |  |
| Edge Enhancement | `iriFresnel` | slider | 0 … 1 | 0.24 |  |
| Patchiness | `iriBreakup` | slider | 0 … 1 | 0.12 |  |
| Flow Advection | `iriFlowAdvect` | slider | 0 … 1 | 0.81 |  |
| Spectral Spread | `iriSpectralSpread` | slider | 0 … 1 | 0.71 |  |
| Thickness Contrast | `iriThicknessContrast` | slider | 0.2 … 3 | 0.2 |  |
| Swirl Scale | `iriSwirlScale` | slider | 0.5 … 8 | 2.3 |  |
| Swirl Speed | `iriSwirlSpeed` | slider | 0 … 0.5 | 0.165 |  |
| Detail Scale | `iriDetailScale` | slider | 1 … 30 | 21 |  |
| Detail Weight | `iriDetailWeight` | slider | 0 … 1 | 0.63 |  |
| Color Saturation | `iriSaturation` | slider | 0 … 2 | 1.52 |  |

### Churn & Distortion _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Enable Churn | `churnEnabled` | boolean |  | false |  |
| Distortion Amount | `churnStrength` | slider | 0 … 0.08 | 0.062 |  |
| Churn Scale | `churnScale` | slider | 0.5 … 15 | 2 |  |
| Churn Speed | `churnSpeed` | slider | 0 … 1 | 1 |  |
| Detail (Octave Mix) | `churnOctaves` | slider | 0 … 1 | 0.75 |  |
| Flow Bias | `churnFlowBias` | slider | 0 … 1 | 0.21 |  |

### HDR / Bloom Boost _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Enable HDR Boost | `hdrBoostEnabled` | boolean |  | true |  |
| Boost Intensity | `hdrBoostStrength` | slider | 0 … 5 | 3.75 |  |
| Pulse Speed | `hdrBoostPulseSpeed` | slider | 0 … 5 | 1.15 |  |
| Edge Glow | `hdrBoostEdge` | slider | 0 … 1 | 0.3 |  |
| Center Glow | `hdrBoostCenter` | slider | 0 … 1 | 1 |  |

### Endpoint Pools _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Start Pool | `poolStart` | slider | 0 … 0.5 | 0.16 |  |
| End Pool | `poolEnd` | slider | 0 … 0.5 | 0.16 |  |
| Pool Softness | `poolSoftness` | slider | 0.005 … 0.2 | 0.2 |  |

### Roof Occlusion _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Enable Roof Occlusion | `roofOcclusionEnabled` | boolean |  | true |  |
| Roof Alpha Threshold | `roofAlphaThreshold` | slider | 0 … 1 | 0.1 |  |
