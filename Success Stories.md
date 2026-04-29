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

## Success Story: Specular Not Working Across Floor Changes

### Problem We Saw

- Specular could look great on the first floor loaded, but disappear when switching floors.
- In some runs, specular was completely non-functional even with high intensity settings.
- Diagnostics looked structurally healthy, but visuals did not match expected output.

### What Was Wrong At The Start

This was also a layered failure, not one bug:

1. **Shared uniforms were not returned during deferred shader upgrade**  
   Deferred compile logic expected `_buildSharedUniforms()` to return uniforms. It only assigned `this._sharedUniforms`, causing upgrade path failures.

2. **Background specular overlay was floor-pinned incorrectly**  
   The background `_Specular` overlay was initially treated as floor 0, which mismatched active floor context in multi-floor scenes and caused wrong `_Outdoors` slot sampling.

3. **Specular effect was not floor-change aware in lifecycle wiring**  
   `SpecularEffectV2` was not notified on floor changes, so background overlay floor binding could drift from active floor state.

4. **Repopulate lifecycle reused placeholder overlays without re-upgrade**  
   After first successful compile, floor-triggered repopulates created black placeholder overlays, but skipped deferred upgrade because compile state was already marked done.

5. **Deferred compile monitoring produced misleading timeout/hung signals**  
   Compile monitor timeout behavior around deferred material setup created false “fallback/hung” signals, obscuring root cause analysis.

### What Fixed It Ultimately

### 1) Fix deferred shader plumbing correctness

- Made `_buildSharedUniforms()` return the uniform object.
- Added guardrails around deferred compile state transitions so failures cannot silently leave effect in dead-placeholder mode.

### 2) Make background specular truly floor-aware

- Assigned background overlay to active floor in multi-floor scenes (not hardcoded floor 0).
- Updated background overlay Z band and `uOutdoorsFloorIdx` to match active floor context.

### 3) Wire floor-change lifecycle explicitly

- Added `SpecularEffectV2.onFloorChange(...)` and invoked it from `FloorCompositor` floor-change flow (including fallback flow).
- Rebound background overlay registration in `FloorRenderBus` on floor changes so visibility rules stay aligned.

### 4) Make repopulate safe after first shader compile

- Stored a compiled shader template material once compile succeeds.
- On later repopulates, created new overlays directly from compiled shader template instead of black placeholders.
- Kept placeholder path only for true pre-compile startup.

### 5) Stabilize methodology for shader effects

- Treat “healthy structure, broken visuals” as a lifecycle/state bug until proven otherwise.
- Verify creation-time floor assignment, floor-change rebinding, and repopulate behavior separately.
- Distinguish compile-monitor telemetry from actual material state on overlays.
- Add effect-level diagnostics for material type and uniform presence to catch silent fallback paths quickly.

### Key Diagnostic Insights

- Overlay count alone was insufficient; floor histogram and per-overlay material state were required.
- The decisive signal was “works on initial floor only” — that pointed to repopulate + floor-change lifecycle drift, not mask authoring.

### Final Outcome

- Specular now survives floor changes instead of being limited to initial load context.
- Background `_Specular` follows active floor and samples the correct per-floor `_Outdoors` texture slot.
- Repopulate no longer leaves overlays in persistent black placeholder state.

## Success Story: Map Shine Control Clock Triggered Scene Reload

### Account

- Codex 5.3 (Cursor agent)

### Problem We Saw

- Changing time of day from the `Map Shine Control` clock caused the full loading screen to appear and the currently viewed scene to reload.
- This made time scrubbing disruptive and looked like a hard refresh instead of a local lighting/time update.

### What Was Wrong At The Start

- Clock actions (drag release and quick-time buttons) always queued `debouncedSave()`.
- That save path still wrote Scene flags via `scene.setFlag('map-shine-advanced', 'controlState', ...)`.
- In Foundry V12/V14 behavior, those same-scene document writes can trigger redraw/teardown paths that surface as full loading/reload transitions.

### What Fixed It

- Added a dedicated time-only save path for clock/quick-time actions that skips Scene `controlState` flag persistence.
- Kept one debounced darkness sync (`stateApplier.syncFoundryDarknessFromMapShineTime()`) so visual darkness still updates after time changes.
- Left existing weather-slider skip-persist behavior intact (including weather snapshot scheduling), so only time-driven saves changed.

### Final Outcome

- Time changes from `Map Shine Control` no longer trigger loading-screen scene reload behavior.
- Clock interactions remain responsive while still updating darkness correctly.

### Addendum: Clouds Slider Follow-Up

- A second trigger remained: changing `Clouds` could still surface the same reload behavior.
- Root cause was the skipped-persist branch still calling weather snapshot scheduling, which could write Scene flags and re-enter same-scene redraw/reload paths.
- Final fix: for skipped-persist saves, avoid all Scene document writes; keep only explicit time-only darkness sync where needed.
- Result: both clock changes and clouds slider changes now apply live without loading-screen scene reload transitions.

## Success Story: Dry Scene Loaded as Permanently Wet

### Account

- Codex 5.3 (Cursor agent)

### Problem We Saw

- Entering a scene with rain set to `0` still rendered wet-looking specular across the scene.
- Wet sheen persisted immediately on load, even though no rain was active in that scene.

### What Was Wrong At The Start

- The first attempted fix switched specular wet driving from `weather.wetness` to live rain intensity.
- That was incorrect for product intent, because wetness lag is desired during active weather transitions.
- The real issue was load/restore lifecycle behavior: serialized weather state could restore stale `wetness` into a scene that was otherwise dry at load time.

### What Fixed It

- Restored `SpecularEffectV2` to use `weather.wetness`, preserving intended lag behavior.
- Added restore-time normalization in `WeatherController`:
  - After applying serialized state, if there is no active rain in both current/target state and no transition in progress, clamp wetness to dry.
  - Applied to `currentState`, `startState`, and `targetState` to keep internal transition state coherent.

### Final Outcome

- Scenes that load with rain `0` now start visually dry.
- Wetness lag still works as designed during actual rain and dry-down transitions.

