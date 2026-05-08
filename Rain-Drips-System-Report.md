# Rain Drips System Report

## Executive Identification

The "Rain Drips" system in this codebase is implemented as the **roof/tree drip particle subsystem**:

- Primary runtime system: `roofDripSystem` in `scripts/particles/WeatherParticles.js`
- Runtime owner/bridge in V2 pipeline: `scripts/compositor-v2/effects/WeatherParticlesV2.js`
- Central tuning/config source: `weatherController.roofDripTuning` in `scripts/core/WeatherController.js`
- Edge extraction helpers:
  - `scripts/particles/RoofDripGpuSilhouetteReadback.js`
  - `scripts/particles/RoofDripEdgeSampling.js`

There is no separate standalone class/file literally named `RainDrips`; in practice, the feature is the `roofDripSystem` path.

## What It Does

The system emits streak-like droplets from:

- roof silhouette edges (overhead tiles)
- tree canopy edges/interiors (tree mesh alpha-based sampling)

It is designed to:

- run during rain and continue with a long post-rain tail
- align drip fall with screen-down/camera-informed gravity (with tunable Z mixing)
- render drips in an overlay-safe layer so they remain visible relative to overhead art
- support fallback modes for robustness (GPU extraction -> CPU extraction -> rectangle fallback)

## Architecture Overview

1. `WeatherParticles` builds and updates `roofDripSystem` as a Quarks `ParticleSystem`.
2. Spawn points are generated/rebuilt using sampled silhouette points from roof/tree sources.
3. Spawn points are stored in packed buffers and filtered to camera view.
4. Emission scales from weather/rain state, including a persistent decay tail after precipitation.
5. In V2, `WeatherParticlesV2` keeps the system attached/registered and ensures overlay rendering behavior.

## Data and Control Flow

### 1) Configuration and Defaults

`WeatherController` defines drip defaults under `roofDripTuning`, including:

- enable/disable
- rain vs tail emission multipliers
- gravity, wind coupling, turbulence, lifetime, size
- source sampling budgets/caps
- GPU edge extraction toggle and thresholds
- max particle budget

These are surfaced in parameter UI schema entries grouped under `roofDrips`.

### 2) Spawn Source Discovery

`WeatherParticles` collects candidate drip spawn points from:

- roof tile alpha contours
- tree canopy alpha contours and interior samples
- optional GPU roof-edge extraction when enabled

It computes/rebuilds source pools on a timed/signature basis (not every frame), then applies fair allocation and trimming logic (global budget, per-source caps, view filtering).

### 3) Edge Extraction Strategy

**GPU path** (`RoofDripGpuSilhouetteReadback`):

- renders roof alpha into a downscaled RT
- computes edge and normal-like fields in shader
- reads back pixels once
- floods exterior transparent regions
- labels connected components
- samples edges fairly per component
- maps screen-space points back to scene/world UV + direction

**CPU/shared edge utilities** (`RoofDripEdgeSampling`):

- 4-connected component labeling
- component centroiding
- silhouette edge pixel collection against exterior flood reachability
- proportional per-component angular stride selection
- optional farthest-point UV subsampling

### 4) Emission and Lifecycle

`WeatherParticles` keeps drips active while raining and into a post-rain tail window:

- rain-time emission multiplier
- tail emission multiplier
- tail duration control
- remembered recent rain intensity to avoid abrupt shutoff

### 5) Rendering and Layering

In V2 pipeline (`WeatherParticlesV2`):

- rain/snow generally remain in main layer flow
- roof/tree drips are marked for overlay path using emitter userData/layer policy
- this avoids visual loss behind overhead tile/tree rendering order

## Key Runtime Controls

Most important knobs from `roofDripTuning` / UI schema:

- `enabled`
- `emissionRainMult`, `emissionTailMult`, `tailDurationSec`
- `dripGravityMul`, `screenDownZMix`
- `windBase`, `windCoupling`, `curlMul`
- `lifeMin`, `lifeMax`, `particleSpeedMin`, `particleSpeedMax`
- `sizeMin`, `sizeMax`
- `globalPointBudget`, `maxPointsPerTile`, `maxParticles`
- `useGpuRoofDripEdges`, `gpuMaxSpawnCap`, `alphaThresholdGpu`, `pointsRefreshSec`

Debug-related flags include `debugRoofDrip`, `debugRoofDripDiag`, and optional mask bypass in debug contexts.

## Findings and Risk Notes

- **Naming ambiguity:** "Rain Drips" is functionally "roof/tree drips"; not a unique class name.
- **Performance sensitivity:** sampling/rebuild logic is complex and budget-driven; wrong caps can cause hitches or sparse coverage.
- **Render-order dependency:** visibility relies on overlay-layer routing in V2; registration/reattachment regressions can make drips vanish.
- **Feature complexity:** multiple fallback paths improve resilience but make behavior harder to reason about during regression testing.

## Recommended Verification Checklist

1. Enable rain and verify roof-edge drips under overhead tiles.
2. Stop rain and verify post-rain tail decays gradually (not instant off).
3. Toggle GPU roof edges and compare spawn coverage/perf.
4. Check tree canopy drip behavior on alpha-rich assets.
5. Validate render visibility around overhead tile/tree overlap areas.
6. Stress test large scenes while tuning `globalPointBudget`, `maxPointsPerTile`, and `maxParticles`.

## Bottom Line

The identified "Rain Drips" implementation is the `roofDripSystem` within `WeatherParticles`, controlled by `WeatherController.roofDripTuning`, with dedicated GPU/CPU silhouette sampling modules and V2 compositor integration to preserve render visibility and lifecycle behavior.
