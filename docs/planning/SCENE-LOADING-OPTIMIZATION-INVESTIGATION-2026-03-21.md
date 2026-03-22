# Scene Loading Optimization Investigation (2026-03-21)

## Scope

This investigation focused on three questions:

1. Are we loading/compiling work we do not need?
2. Are scene transitions as efficient as they can be?
3. What happens when water shader compilation runs on scenes without `_Water` masks?

## Key Findings

- The load pipeline intentionally blocks on several expensive stages to avoid first-frame hitching: floor mask preload, compositor prewarm, floor-step prewarm, and shader warmup.
- `FloorCompositor` previously compiled broad shader targets even when scene mask coverage implied some effect families could not run.
- Water-specific path was wasteful on non-water scenes:
  - `WaterEffectV2.initialize()` always created shader resources.
  - `populate()` returned early when no `_Water` masks were found.
  - pass-level rendering could still be attempted if the effect gate remained enabled.
- V2 enabled-state propagation had a gap: some paths wrote `params.enabled` without reliably toggling the pass gate (`enabled`) on plain-property effects like `WaterEffectV2`.

## What Was Implemented

### 1) Scene Effect Hints for Warmup Filtering

- Added lightweight scene effect hints derived from discovered bundle masks in `canvas-replacement`.
- Hints are passed through `EffectComposer._getFloorCompositorV2(...)` into `FloorCompositor.initialize(...)`.
- `FloorCompositor.warmupAsync(...)` now filters compile targets for mask-driven effects when mask hints show they are not usable on the scene.

### 2) Water No-Mask Hard Gating

- `WaterEffectV2` now tracks whether any renderable water data was discovered.
- If no `_Water` masks are found during `populate()`, water is explicitly disabled.
- `WaterEffectV2.render()` now returns early when:
  - disabled,
  - no renderable water data exists,
  - or uniforms indicate no water data/mask is available.

### 3) Enabled-State Consistency

- Added `WaterEffectV2.setEnabled(...)` to keep pass gate and params in sync.
- Updated `FloorCompositor.applyParam(...)` to prefer `setEnabled(...)` when available.
- This closes the mismatch where V2 toggles could leave pass gate behavior inconsistent.

## Direct Answer: Water Compile on Non-Water Scenes

After these changes:

- Water still constructs as part of compositor setup, but
- warmup compilation for water is now gated by discovered renderable water data (`hasRenderableWater()`),
- and water pass rendering is hard-short-circuited when no water data exists.

Net effect: non-water scenes avoid unnecessary water shader warmup cost and skip water pass overhead.

## Scene Transition Efficiency Assessment

Current behavior still prioritizes deterministic readiness over minimum transition latency. The heavy steps are mostly intentional. The implemented changes reduce unnecessary compile work, but transition speed can improve further with policy controls.

## Phased Optimization Plan

### Phase 1 (Implemented in this pass)

- Compile target filtering for mask-driven effects.
- Water no-mask hard disable + render short-circuit.
- Enabled-state propagation fix for pass-gate correctness.

### Phase 2 (Next)

- Add per-scene loading policy toggles:
  - `prewarmFloorTransitions` on/off
  - `shaderWarmupTimeoutMs` tuning
  - aggressive vs conservative preload policy
- Optional “fast transition mode” that reveals earlier and allows some lazy compilation.

### Phase 3 (Advanced)

- Broader necessity-based initialization (not just warmup filtering) for clearly mask-driven optional effects.
- Adaptive floor cache policy by GPU tier and floor count.
- Pass-group fusion for cheap color-only post effects where safe.

## Benchmark Checklist (Before/After)

- Test scenes:
  - no-water single-floor map
  - water-heavy map
  - 6-10 floor Levels map
- Capture:
  - total load time (overlay start -> ready)
  - time spent in `shaders.compile` stage
  - warmup program count (`renderer.info.programs.length`)
  - first 5s frame pacing after reveal (stutter/hitches)
  - floor switch latency (cold and warm)
- Compare:
  - baseline branch vs this branch
  - integrated GPU and discrete GPU

## File Touchpoints

- `scripts/foundry/canvas-replacement.js`
  - derive/pass scene effect hints for V2 compositor creation.
- `scripts/effects/EffectComposer.js`
  - forward `effectHints` into `FloorCompositor.initialize`.
- `scripts/compositor-v2/FloorCompositor.js`
  - consume hints for warmup compile filtering.
  - use `setEnabled(...)` when applying `enabled` params.
- `scripts/compositor-v2/effects/WaterEffectV2.js`
  - add renderable-water tracking.
  - add `setEnabled(...)` and early-return pass gating.
