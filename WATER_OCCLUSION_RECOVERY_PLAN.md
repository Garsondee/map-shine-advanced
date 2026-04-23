# Water Occlusion Recovery Plan

## Problem Summary

- Current validated baseline: water renders above the ground layer correctly, including upstairs visibility behavior.
- Remaining issue: water is not correctly occluded by upper floors.
- **Update:** Subsequent work (scene RT alpha union occluder, default multi-floor binding, shader debug passes, `sliceOcclusionAlpha` RGB boost in the union) has **not** fixed occlusion in user validation; water still reads above layers that should hide it.
- Known good historical behavior (last committed version): water layered correctly over ground content, but upper-level alpha occlusion was incomplete.

## Intended Behavior

- Water remains visible where it should be visible from the active view floor.
- Upper-level authored alpha (background floor images and intended cutouts) occludes lower-floor water only where those upper levels are solid.
- No global water disappearance when moving to upper floors.

## What Was Tried In This Session

### Attempt 1: Strict per-level water ownership + always alpha rebind

Changes made:
- `WaterEffectV2.setLevelContext()` stopped borrowing lower-floor water data.
- `FloorCompositor` always ran `LevelAlphaRebindPass` (no cross-slice skip).

Outcome:
- Regressed behavior: from upper floors, water rendered behind scene content.
- Conclusion: strict ownership removed the path needed for upstairs visibility.

Status:
- Reverted.

### Attempt 2: Restore cross-slice; force shader gating by current slice alpha

Changes made:
- Restored `setLevelContext()` borrowing behavior (`uCrossSliceWaterData` path).
- Restored conditional alpha rebind skip for cross-slice mode.
- In `water-shader`, changed cross-slice gating to always multiply by current slice alpha.

Outcome:
- Still failed in user validation (upstairs invisibility persisted).
- Conclusion: cross-slice gating change alone did not solve occlusion correctly.

Status:
- Reverted.

### Attempt 3: Narrow occluder source to upper background alpha only

Changes made:
- In `FloorCompositor` call to `renderFloorMaskTo(...)`, used `backgroundOnly: true` with `includeBackground: true`.

Outcome:
- Still failed in user validation.
- Conclusion: this occluder-source change was not sufficient.

Status:
- Reverted.

### Attempt 4: Restore baseline from HEAD (`e9fece5`)

Changes made:
- Restored:
  - `scripts/compositor-v2/FloorCompositor.js`
  - `scripts/compositor-v2/effects/WaterEffectV2.js`
  - `scripts/compositor-v2/effects/water-shader.js`

Outcome:
- Water is again visible above the ground layer and on upper views.
- Occlusion by upper floors remains incorrect.

Status:
- Active baseline.

### Attempt 5: Per-level scene RT prepass + max-alpha union occluder (replace tile mask)

Changes made:
- `FloorCompositor._renderPerLevelPipeline`: prepass renders every visible level’s `levelSceneRT` via `renderFloorRangeTo(..., clearAlpha: 0)` before the per-level post chain.
- Water occluder built with `_buildUpperSceneAlphaOccluder`: ping-pong fullscreen shader unions `texture.a` across all `levelSceneRT`s strictly above the current slice index.
- Replaced prior `renderFloorMaskTo`-driven occluder for this path.
- Default gating: occluder enabled when **two or more** floors are in `getVisibleFloors()` unless `window.MapShine.__alphaIsolationDebug.disableWaterOccluder === true`. Previously, missing `__alphaIsolationDebug` behaved like “always disable,” so the occluder often never bound.

Outcome:
- User validation: **failed** — water still appears above layers that should occlude it.

Conclusion:
- Binding an RT and unioning `.a` did not achieve correct clipping in practice.

Status:
- Still in codebase as the current V2 approach; **not meeting acceptance** until a follow-up fix lands.

### Attempt 6: Debug instrumentation (`uDebugWaterPassTint`, `WaterEffectV2`)

Changes made:
- `water-shader.js` / `WaterEffectV2.js`: pass-tint modes (magenta = occluder texture bound, cyan = not bound, yellow = water data gate would skip the pass).
- Iterations: fixed misleading “fullscreen cyan” (water pass is a fullscreen quad), then fixed wrong gate on uniforms (`uHasWaterData` is global per pass), then gated tint on per-pixel `inside` from `tWaterData`, then mixed debug color toward `base` by occluder strength so debug matches culling.

Outcome:
- Useful for bisecting “bound vs not bound” vs “mask empty”; **did not fix occlusion**.

Status:
- Keep for diagnostics; not the product fix.

### Attempt 7: `sliceOcclusionAlpha` in union shader (RGB peak boost)

Changes made:
- `FloorCompositor` union fragment: besides `rgba.a`, add conservative coverage from **RGB peak** when peak materially exceeds stored alpha (addresses upper-floor `premultipliedAlpha: true` tiles in `FloorRenderBus` where `.a` alone under-reports coverage).

Outcome:
- User validation: **failed** — water still draws above occluding layers.

Conclusion:
- Weak union alpha may be one failure mode, but correcting it did not resolve the symptom; other or primary causes remain.

Status:
- In codebase pending further diagnosis.

## Current Technical Read

- Cross-slice water borrowing is required for upstairs visibility in current architecture.
- Previous attempts that changed ownership/rebind policy too broadly caused regressions.
- The unresolved piece is clipping water coverage by upper-floor authored alpha without breaking upstairs visibility.
- **As of this update:** scene-RT alpha union, multi-floor default occluder enable, debug plumbing, and RGB-aware union (`sliceOcclusionAlpha`) have all been **tried in user validation and failed** the acceptance criterion (water still visible above layers that should occlude it).

## Recovery Strategy (Next Steps)

**Tried and failed (see Attempts 5–7):** scene-RT alpha union occluder; default binding when `getVisibleFloors().length >= 2`; PM-aware union via `sliceOcclusionAlpha`.

**Hypotheses still worth pursuing:**

1. **UV / space alignment** — `waterOccluderAlphaSoft(vUv)` must use the same UV basis as `levelSceneRT` content (scene rect, DPR, Y-flip, partial RT). Misalignment reads an empty or shifted mask.

2. **Wrong “upper” slice set** — Confirm `levelSceneRTs` order matches `getVisibleFloors()` bottom→top and that `slice(li + 1)` matches the floors that should occlude pass `li` (gaps if `acquire` skips, non-contiguous floor indices).

3. **Mask magnitude vs thresholds** — Early discard uses `smoothstep(0.36, 0.64, occ) > 0.995`; final mix uses the same `occluderBlend`. If `occ` never approaches 1 under opaque upper art, water stays visible. Add a raw `tWaterOccluderAlpha` debug view (existing `uDebugView` branch near occluder in `water-shader` may help) to see whether the problem is signal strength vs plumbing.

4. **Composite / output alpha** — Water path ends with `waterOutA = max(base.a, …)` and `mix(..., base.a, occluderBlend)`; verify `LevelCompositePass` straight-alpha ordering does not re-expose lower water where the upper slice should win.

5. **A/B vs legacy tile mask** — Temporarily re-enable `renderFloorMaskTo` as occluder source (bisect with `__alphaIsolationDebug`) to see if tile union occludes correctly. If yes, bug is in scene RT contents or union; if no, bug may be in `WaterEffectV2` sampling or composite.

**Acceptance tests (unchanged):**

- Test A: Ground-floor view still matches known-good water-over-ground behavior.
- Test B: Upper-floor view keeps water visible through intended openings and hides it under solid upper coverage.

## Guardrails

- Preserve known-good layering trait from baseline (water above ground where appropriate).
- Avoid changes that make upstairs views lose all water.
- Change one variable at a time and test immediately to avoid circular debugging.

