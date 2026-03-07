# V2 Migration Assessment (Research Pass)

Date: 2026-03-06
Scope: Full audit of V1→V2 compositor migration status, remaining legacy references, and validation readiness.

---

## 1) Executive Summary

The runtime is effectively **V2-only for rendering**, with `EffectComposer.render()` delegating directly to `FloorCompositor.render()` and returning early.

However, the codebase still contains:
- substantial **legacy imports and scaffolding** in `canvas-replacement.js`
- a non-trivial **V1 effects directory** (`scripts/effects/`)
- legacy infrastructure references (Mask/Depth/Binding managers) that appear mostly dormant but not fully deleted
- a **validation registry with no completed entries**, meaning migration confidence is currently implementation-driven, not validation-driven.

Bottom line: migration is advanced, but not fully closed out.

---

## 2) Current Runtime State (Observed)

### 2.1 V2 render path is active and authoritative

Evidence:
- `EffectComposer.render()` runs updatables, then calls `FloorCompositor.render(...)` and returns immediately.
- The legacy effect-pass path is bypassed by design comments and control flow.

References:
- `scripts/effects/EffectComposer.js` (V2 breaker fuse and early return path)
- `scripts/effects/EffectComposer.js` (`_getFloorCompositorV2()` lazy singleton)

### 2.2 FloorCompositor owns the V2 effect stack

`FloorCompositor` constructs and manages the active V2 effects, including post, bus overlays, weather/particles, fog, lighting, stylization, and material overlays.

Reference:
- `scripts/compositor-v2/FloorCompositor.js` (constructor imports and effect fields)

### 2.3 Legacy effect construction path is intentionally skipped at startup

`canvas-replacement.js` logs and code comments indicate legacy effect init/mask/prewarm are skipped in V2 mode, and an empty legacy `effectMap` is created for compatibility.

Reference:
- `scripts/foundry/canvas-replacement.js` (load phase around effect init and V2 warmup)

---

## 3) What Has Been Migrated to V2 (Repository Evidence)

The V2 effect directory currently includes a broad replacement set, including:
- lighting, sky, bloom, grading, sharpen, filter
- water + splashes + weather particles
- material overlays (specular/fluid/iridescence/prism)
- vegetation overlays (tree/bush)
- fog-of-war, atmospheric fog, player light
- stylized/global post effects (dot/halftone/ascii/dazzle/vision/invert/sepia/lens)
- map-point effects (lightning/candle flames), fire and ash systems

Reference:
- `scripts/compositor-v2/effects/` directory listing

This is materially ahead of the older migration plan assumptions in the original V1→V2 plan doc.

Reference:
- `docs/planning/V1-V2-COMPOSITOR-MIGRATION-PLAN.md`

---

## 4) Legacy/V1 Surface Area Still Present

### 4.1 V1 effects folder still exists with key holdouts/infrastructure

Notable remaining files:
- `DistortionManager.js`
- `LensflareEffect.js`
- `SelectionBoxEffect.js`
- `DetectionFilterEffect.js`
- debug tooling and light/shader bridge modules
- `EffectComposer.js` (now partly V2 host/orchestrator)

Reference:
- `scripts/effects/` directory listing

### 4.2 canvas-replacement still imports many legacy systems

Top-of-file imports still include:
- `MaskManager`
- `TileEffectBindingManager`
- `DepthPassManager`
- `DetectionFilterEffect`
- `DynamicExposureManager`
- `PhysicsRopeManager`
- other legacy-adjacent managers

Some may be dormant in V2 runtime, but import-level coupling remains and increases migration ambiguity.

Reference:
- `scripts/foundry/canvas-replacement.js` import block

### 4.3 V2 UI parameter plumbing still uses transitional compatibility pattern

V2 UI callbacks still route through `_propagateToV2` with pending queues until FloorCompositor exists, rather than direct effect-owned registration.

Reference:
- `scripts/foundry/canvas-replacement.js` (V2 effect control registration section)

### 4.4 effect-wiring.js is now mostly a compatibility shell

Observed state:
- V2 classes re-exported for UI schema access
- legacy independent effect definitions return `[]`
- graphics wiring map is empty
- legacy exposure table largely vestigial

Reference:
- `scripts/foundry/effect-wiring.js`

This file is not harmful, but indicates incomplete architecture cleanup.

---

## 5) Migration Plan Drift vs Actual Code

The original plan document still contains now-stale assumptions (for example, around which effects are not yet ported).

Examples of drift:
- Plan text marks some effects as missing/non-migrated that are present in `compositor-v2/effects` and instantiated in `FloorCompositor`.
- Plan still frames `useCompositorV2` toggle concerns, but repository search did not find active `useCompositorV2` references in scripts.

References:
- `docs/planning/V1-V2-COMPOSITOR-MIGRATION-PLAN.md`
- repository grep results for `useCompositorV2`

Conclusion: the migration plan doc should be treated as historical + partial, not as current status-of-record.

---

## 6) Validation State (Biggest Remaining Gap)

`VALIDATION-REGISTRY.md` currently reports no effects validated yet against the v2 alpha contract.

Reference:
- `scripts/compositor-v2/VALIDATION-REGISTRY.md`

This means we have implementation breadth but low formal verification coverage.

---

## 7) Risks Blocking “Fully Migrated” Status

1. **Dormant legacy dependencies** in startup orchestration (`canvas-replacement.js`) can regress unexpectedly when touched.
2. **Unvalidated effects** despite broad V2 implementation set.
3. **Residual V1-only modules** still in repo and still imported by some runtime modules.
4. **Architecture split remains** (`EffectComposer` as host + `FloorCompositor` as renderer), workable but not fully simplified.

---

## 8) Recommended Validation Program (Start Here)

### Phase A — Baseline Inventory Lock
- Freeze a canonical list of V2 effects from `FloorCompositor` constructor.
- Mark each as: `Implemented`, `Wired`, `UI Registered`, `Persisted Params`, `Validated`.

### Phase B — Contract Validation (per effect)
For each V2 effect:
1. Alpha preservation test
2. Premultiplied invariant test
3. Visual parity screenshots (baseline scenes)
4. Multi-floor behavior test (ground + upper floor + transparent overhead gaps)
5. Scene transition / reload persistence test

### Phase C — Runtime Isolation Validation
- Confirm no legacy effect instances are constructed in V2 sessions.
- Confirm no legacy mask/depth managers are ticking as updatables in V2 sessions.
- Confirm no PIXI visual contamination for rendering output.

### Phase D — Legacy Deletion Readiness Gate
Only after Phase B/C pass rates are acceptable:
- remove dead imports and shells
- remove no-op wiring paths
- delete obsolete V1 files that have proven V2 replacements
- update docs to reflect post-cleanup architecture

---

## 9) Initial Actionable Cleanup Candidates (Low-Risk)

1. Remove or isolate unused legacy imports in `canvas-replacement.js` behind explicit V2-safe boundaries.
2. Convert `effect-wiring.js` from transitional shell to a V2-only schema export module (or inline into V2 UI registration path).
3. Update `V1-V2-COMPOSITOR-MIGRATION-PLAN.md` with current reality and point to this assessment.
4. Start filling `VALIDATION-REGISTRY.md` effect-by-effect with objective pass/fail evidence.

---

## 10) Proposed Next Research Batch

1. Build a line-referenced matrix of every effect instantiated in `FloorCompositor` vs every UI registration in `canvas-replacement.js` to catch mismatch gaps.
2. Build a line-referenced matrix of legacy imports in `canvas-replacement.js` and classify each as:
   - active in V2 runtime
   - dormant compatibility only
   - safe to remove now
3. Identify all V1-only files with **zero runtime references** and stage deletion candidates.

---

## 11) Assessment Conclusion

You are in the **late migration stage**:
- V2 rendering is functionally primary and broad in scope.
- Most of the remaining work is now **validation, de-risking, and cleanup**, not major feature porting.
- The primary blocker to declaring completion is not missing V2 effects; it is lack of formalized validation coverage and lingering transitional scaffolding.
