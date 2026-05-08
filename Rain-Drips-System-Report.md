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

## Active Issues (Current Session)

### Issue 1: No drip particles appear

Observed symptom from user: roof/tree drips are currently not visible at all.

### Issue 2: Freeze when rain starts

Observed symptom from user: first rain start triggers spawn pool building and stalls Foundry (large hitch/freeze).

## Working Hypotheses (Live Notes)

### A) Why drips may be invisible right now

Likely causes to validate first (highest probability first):

1. `roofDripTuning.enabled` is false at runtime (settings/UI state mismatch).
2. `roofDripSystem` exists but has zero (or near-zero) effective `emissionOverTime` due to weather/tail gating logic.
3. Spawn pool built as empty (`_roofDripPoints` empty) because source detection returns no overhead/roof/tree edges.
4. Drips are emitting but masked/culled:
   - overlay layer routing mismatch in V2
   - roof-mask discard path too aggressive for edge streaks
   - emitter/batch not attached or not registered in `BatchedRenderer`.
5. Drips are present but short-lived/too small/too transparent due to combined tuning values.

Quick high-signal runtime probes to add:

- particle system registration state in `WeatherParticlesV2`
- `roofDripSystem.emissionOverTime.value`
- point pool counts (total + view-filtered)
- last rebuild signature + rebuild duration
- reason code when emission forced to zero

### B) Why rain-start causes a freeze

The freeze is consistent with synchronous, heavy spawn pool construction inside first-use rain path:

- tile/tree alpha reads + component labeling + flood fill + selection + merge/truncate
- potentially repeated within one update if source signature invalidates
- CPU cost amplified on large scenes and high texture dimensions

Even with existing caps/strides, doing this at the moment rain begins is too late for UX.

## Design Direction: Prebuild During Load (Recommended)

Goal: move expensive drip pool generation out of "rain starts now" path.

### Proposed strategy

1. **Warmup trigger timing**
   - schedule drip source scan/pool build during scene/module initialization, or first stable render tick after scene load
   - run only when camera + roof map + tile manager data are available
2. **Incremental build budget**
   - split pool build into chunks over multiple frames (tiles per tick, trees per tick, merge finalization later)
   - maintain a frame-time budget guard (example: 2-4 ms/tick for warmup work)
3. **State machine**
   - `idle -> warming -> ready -> stale`
   - rain start should use latest `ready` pool immediately (no forced sync rebuild)
4. **Stale handling**
   - when tiles/trees/levels change, mark pool `stale` and refresh in background
   - keep previous ready pool active until replacement is ready
5. **Fallback behavior**
   - if warmup is incomplete and rain starts, use last known pool or minimal fallback seed set; do not block frame

### Suggested implementation points

- Add warmup orchestration in `WeatherParticlesV2.initialize()` and/or early `update()` gate.
- Expose non-blocking build step methods in `WeatherParticles`:
  - `beginRoofDripWarmup()`
  - `stepRoofDripWarmup(frameBudgetMs)`
  - `isRoofDripWarmupReady()`
- Refactor current rebuild code path so "build all now" becomes optional/debug only.

## Initial Mitigation (Before Full Refactor)

Low-risk changes to reduce pain immediately:

1. Build once shortly after scene load with conservative caps, cache results, and avoid rebuild at rain start unless required.
2. Lower startup costs:
   - temporary lower `globalPointBudget`
   - lower `maxPointsPerTile`
   - increase `pointsRefreshSec`
3. Add guard to skip rebuild if rain starts within N seconds of load and a valid cached pool exists.

## Instrumentation To Add (for deterministic debugging)

Add structured diagnostics (toggleable) with:

- total build time and per-phase time:
  - source collection
  - edge extraction
  - merge/truncate
  - view filter
- counts:
  - candidate points
  - final pooled points
  - per-source contribution (tile/tree/gpu/fallback)
- runtime emit stats:
  - emission rate
  - active particle count
  - culled/hidden state

This will make "invisible drips" and "startup freeze" root causes measurable rather than guesswork.

## Thought Log (Continuing)

- Current belief: both issues share the same subsystem pressure point (spawn pool pipeline). If pool build is heavy and also intermittently empty/failing, that explains both freeze and no-visible-output outcomes.
- Most practical direction: treat drip pool as scene data prepared ahead of weather events, not a just-in-time rain artifact.
- Next coding step (if approved): implement warmup state + background stepping, then add hard runtime probe HUD/console counters for drip readiness and emission.

## Investigation Findings (Evidence-Based)

This section captures what was verified in code, what is likely, and what is unlikely based on direct inspection.

### Confirmed: Rebuild is rain-gated and cannot be prewarmed today

Current control flow explicitly avoids drip-pool work unless drips are actively emitting:

- Rebuild idle condition includes:
  - drips disabled, or
  - precipitation suppressed, or
  - no live rain and no tail
- In idle mode, code clears cached pool:
  - `_roofDripBasePoints = null`
  - `_roofDripSourceSignature = null`

Implication:

- Prebuilding at load is not supported by current logic.
- Even if you prebuilt once externally, idle logic would clear it when weather is inactive.

### Confirmed: Freeze risk still exists in first rebuild path

There is already partial slicing, but it is not fully non-blocking:

1. CPU tile slicing only happens when `tileEligible.length > ROOF_DRIP_CPU_TILES_PER_CONTROL_TICK`.
   - If eligible tiles are small in count (for example 1-3), rebuild runs synchronously in one control tick.
2. Tree extraction is always done in one phase (`trees`) in `_roofDripRebuildJobTick()`, not chunked.
3. Each tile/tree alpha extraction does expensive canvas readback (`ctx.getImageData`) and component/flood operations.
4. Signature checks (`_computeRoofDripSourceSignature`) still walk all eligible roof tiles + tree overlays periodically.

Implication:

- A large scene can still hitch hard at rain start, especially when first build lands in the synchronous branch or tree phase is heavy.

### Confirmed: `roofDripSystem` visibility depends on source pool existence

The emitter behavior intentionally kills particles when no points exist:

- `RoofEdgeDripEmitter.initialize()`:
  - if points exist -> spawn from points
  - if no points -> force particle dead (`age = life` or huge age)

And update path sets points to null when base pool is absent.

Implication:

- If source pool generation yields empty/null, drips will never visibly spawn even if emission rate is non-zero.

### Confirmed: No-drips can be caused by strict source eligibility

Roof tile eligibility requires either:

- explicit overhead signal, or
- `map-shine-advanced.overheadIsRoof` flag.

If neither is present, tile is ignored for drip sources. Trees are separate and depend on overlay mesh/mask availability.

Implication:

- Worlds/scenes with roof-like art that is not marked overhead (or not flagged as roof) can produce an empty drip source pool.

### Confirmed: V2 culling/layering is probably not the primary blocker here

Evidence in current code:

- Roof drips are explicitly marked `msOverlayLayer = true` and routed to layer 31.
- Roof drips explicitly opt out of V2 frustum pause/play culling via `msAutoCull = false`.
- V2 has reattach + system registration guards to recover from bus clears.

Implication:

- Layer/culling regressions remain possible in edge cases, but code has dedicated safeguards and is less likely to be the root of "never appears" than empty pool/eligibility/gating.

### Confirmed: Drip shader path already avoids a known alpha-mask invisibility trap

Drip update explicitly sets drip alpha-map uniform path off (`uHasRoofAlphaMap = 0` for drips) with comments explaining prior wipeout on stretched billboards.

Implication:

- The known "roof alpha discards all drips" bug appears already addressed in this branch.

## Hypothesis Status Matrix

### Strongly Supported

- Rain-start freeze is caused by first-time synchronous-heavy spawn pool construction.
- Current architecture prevents true prewarm because drip pool work is rain/tail gated and idle-cleared.
- No-drips can occur when source pool is empty due to eligibility/filtering/data-availability.

### Plausible but Not Yet Runtime-Confirmed

- `elevationWeatherSuppressed` or global weather suppression may be true in the affected scene, forcing drip emission/visibility to zero.
- Drip emission may be non-zero but source point count remains zero due to tile/tree source mismatch in that specific scene.

### Weaker / Partially Ruled Down

- Pure V2 layer-culling issue as sole cause (mitigations exist: overlay layer forcing + no auto cull).
- Pure roof-alpha shader discard as sole cause (explicitly disabled for drips in current code path).

## Direct Answers to the Two Reported Issues

### 1) "No drip particles appear currently."

Most evidence-backed likely causes in current code:

1. Empty source pool (no eligible roof/tree sources after filters).
2. Weather suppression state active (`enabled === false` or `elevationWeatherSuppressed === true`).
3. Drips disabled via tuning (`roofDripTuning.enabled` false).

Notably, if pool is empty, particles are intentionally killed at initialize even if emission is configured.

### 2) "When rain starts, building spawn points freezes Foundry."

This is consistent with architecture:

- first rebuild occurs in active rain/tail path
- expensive alpha readback and edge processing happen on main thread
- slicing is partial, not full (especially trees and low tile-count synchronous branch)

## Recommended Next Engineering Moves (Evidence-Driven)

1. Keep drip pool alive across idle weather; do not clear `_roofDripBasePoints` in idle mode.
2. Add true prewarm lifecycle:
   - scene-ready kick
   - incremental frame-budgeted stepping
   - ready/stale states
3. Slice tree phase similarly to tile phase.
4. Add hard diagnostics always available behind a toggle:
   - source counts (`tileEligible`, tree overlay count)
   - pool counts (`basePoints`, viewPoints)
   - suppression/enable state
   - emission value
   - rebuild phase timings

With these in place, we can separate "no sources", "suppressed weather", and "rendering visibility" immediately in live sessions.
