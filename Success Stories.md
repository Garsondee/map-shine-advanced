# Success Story: Trees and Bushes Floor Leakage

## Problem We Saw

- `_Tree` / `_Bush` visuals appeared on floors where they did not belong (most visibly: underground).
- On floor changes, canopies sometimes appeared briefly for a few frames and then disappeared.
- During some transitions, this happened twice before stabilizing.

## What Was Wrong At The Start

This issue was not a single bug. It was a stack of smaller floor-context bugs that combined into one symptom:

1. **Wrong floor assignment path in V14 scenes**  
   Tree/Bush floor resolution initially relied on legacy range/elevation checks before V14-native level assignment, causing incorrect floor mapping in mixed/migrated content.

2. **Background mask handling was floor-agnostic**  
   Background `_Tree`/`_Bush` overlays were initially treated too globally (hardcoded floor assumptions and non-authoritative background source usage), so a valid canopy mask could leak into the wrong floor context.

3. **Scene/floor repopulate sequencing caused transient stale renders**  
   During level-context changes, effect repopulation could happen in overlapping phases. Old overlays could remain visible briefly while async populate jobs progressed.

4. **Background canopy overlays were being rebuilt even for non-active floors**  
   This allowed short-lived wrong-floor overlays during transition windows, even when they were eventually hidden.

## What Fixed It Ultimately

### 1) Correct floor identity for tile overlays

- Added/standardized V14-native floor resolution support (`resolveV14NativeDocFloorIndexMin`) in Tree/Bush effects.
- Ensured floor metadata is attached to overlay meshes (`userData.floorIndex`).

### 2) Correct background canopy sourcing and floor mapping

- Switched from simple `scene.background.src` assumptions to level-aware background handling.
- Mapped level backgrounds against FloorStack floor indices.
- Most importantly: **during populate, only build background canopy overlays for the currently active floor**.

### 3) Remove transition-time stale overlay windows

- Cleared Tree/Bush overlays at `forceRepopulate` start so old canopies cannot linger while async jobs run.
- Added repopulate coalescing in `FloorCompositor.forceRepopulate()` to avoid duplicate rebuild waves during the same transition burst.

### 4) Harden visibility enforcement

- Added explicit floor-clamp visibility enforcement in Tree/Bush lifecycle points (`update`, `onFloorChange`, creation, enabled-state changes), using safe floor index fallback logic.

## Key Diagnostic Insight

The most useful clue was:

- `TreeEffectV2 populated: 1 overlays` while `tileDocCount: 0`.

That proved the leakage source was **background canopy overlay construction**, not tile canopy masks.

## Final Outcome

- Trees/Bushes no longer persist on wrong floors.
- Underground transitions no longer show transient canopy leaks.
- Floor changes now stabilize with correct per-floor canopy behavior.

