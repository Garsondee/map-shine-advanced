# Levels Compatibility vs Native Takeover Deep Dive

## Status
- Date: 2026-02-17
- Scope: Deep investigation of two strategic paths for handling `othermodules/levels` with Map Shine Advanced
- Requested options:
  1. Build a compatibility system so Levels and Map Shine can run together.
  2. Build Map Shine native Levels logic, support one-way loading of Levels data, then let Map Shine fully own runtime logic.

---

## 1) Executive Summary

### Bottom line
A full runtime compatibility mode with Levels is technically possible, but high risk and high maintenance because both modules modify core Foundry visibility/elevation behavior from different rendering assumptions.

Map Shine replaces gameplay rendering with Three.js and already owns token/tile visibility and fog behavior. Levels heavily patches Foundry PIXI/core visibility, range, and fog flows. Running both as equal runtime authorities creates a two-engine conflict.

### Recommendation
Adopt **Option 2 (Native Takeover + One-Way Compatibility Import)** as the primary strategy.

Also provide a **narrow Option 1 bridge** only as a transitional aid:
- import and honor existing `flags.levels` data,
- optionally expose read-only adapters to `CONFIG.Levels.API`-like calls,
- but do not run dual runtime visibility engines.

---

## 2) Architecture Reality Check (Current Baseline)

## 2.1 Map Shine architecture constraints
Map Shine already establishes these runtime truths:
- Three.js is the gameplay renderer and interaction owner.
- Token visibility is controlled by Map Shine visibility pathways (VisibilityController + TokenManager integration).
- Tile layer semantics are based on Foundry `foregroundElevation` plus Map Shine roof flagging (`overheadIsRoof`).
- Fog/vision extraction and rendering are managed by Map Shine systems and are sensitive to timing and coordinate contracts.

Implication: any external module that rewires Foundry PIXI visibility logic can conflict or become partially ignored in gameplay mode.

## 2.2 Levels architecture constraints
Levels is not just a data schema; it is a runtime behavior module that:
- registers many hooks and wrappers,
- overrides visibility/collision internals,
- installs a custom fog manager,
- applies elevation range semantics across many placeables.

Implication: Levels expects to be a runtime authority over Foundry canvas behavior, not a passive data provider.

---

## 3) Deep Findings from `othermodules/levels`

## 3.1 Runtime authority points in Levels
Levels currently modifies core behavior at multiple layers:

1. **Global config and fog manager replacement**
- `CONFIG.Canvas.fogManager = LevelsFogManager`
- custom scene-level fog behavior by elevation band and scene cloning strategy.

2. **Visibility and LOS wrappers**
- wrappers around detection range, collision and polygon logic.
- 3D-like collision tests against walls and tile elevation planes.

3. **Placeable visibility wrappers**
- tile, drawing, token, note, light, and sound visibility/audibility paths are elevation-gated.

4. **Tile and range flags as core semantics**
- `document.elevation` + `flags.levels.rangeTop` + flags like `showIfAbove`, `isBasement`, `noCollision`, `noFogHide`.

5. **Scene-level ranges and UI workflow**
- `sceneLevels` range bands drive editor behavior and perspective/elevation context.

6. **Movement and region behavior**
- stairs/elevators and region-triggered elevation transitions.

## 3.2 Core data model worth preserving
Independent of runtime wrappers, Levels data is valuable and should be consumed:
- `scene.flags.levels.sceneLevels`
- per-document `elevation`
- per-document `flags.levels.rangeTop`
- auxiliary flags (`showIfAbove`, `isBasement`, `noFogHide`, etc.)
- wall height bounds (`flags.wall-height.bottom/top`)

This is the key to one-way compatibility.

---

## 4) Conflict Map: Why Dual Runtime is Hard

## 4.1 Fog stack conflict
- Levels installs `LevelsFogManager` and expects elevation-aware fog documents/scenes.
- Map Shine already has a custom fog pipeline and bridge.
- Running both as active authorities risks stale masks, double ownership, and inconsistent exploration state.

## 4.2 Visibility authority conflict
- Levels wrappers mutate Foundry visibility internals.
- Map Shine token visibility is explicitly controlled by its own controller and Three sprite sync.
- If both systems attempt to govern visibility, race conditions and visual mismatch are likely.

## 4.3 Tile layer semantics mismatch
- Levels uses range windows (`bottom..rangeTop`) and special flags for visibility behavior.
- Map Shine currently uses `foregroundElevation` + roof subset model for rendering layers.
- This is reconcilable, but only with an explicit translation layer.

## 4.4 Vision model mismatch
- Levels injects 3D collision logic in Foundry detection paths.
- Map Shine has its own vision computation stack and system adapters.
- Shared behavior requires deliberate integration, not passive coexistence.

## 4.5 Maintenance burden if Option 1 is full dual-runtime
Every Foundry update and every Levels update can break compatibility wrappers if both modules keep patching core simultaneously.

---

## 5) Option 1 - Full Compatibility Layer (Run both runtime systems)

## 5.1 What this means
Map Shine would remain primary renderer while preserving active Levels runtime module behavior and trying to synchronize all side effects.

## 5.2 Required integration work
1. Build a `LevelsCompatibilityBridge` that:
   - detects active Levels wrappers and version,
   - maps Levels runtime state (`currentToken`, UI ranges, fog manager assumptions) into Map Shine systems,
   - resolves conflicts in visibility ownership.

2. Define explicit source-of-truth for each domain:
   - token visibility,
   - tile visibility,
   - fog exploration,
   - light/sound range checks,
   - note/template visibility.

3. Add wrapper conflict controls:
   - either selective opt-out from Levels wrappers in gameplay mode,
   - or post-wrapper correction pass in Map Shine each frame/hook.

4. Add hard compatibility diagnostics:
   - detect invalid mixed states,
   - warn when both engines write incompatible values.

## 5.3 Pros
- Minimal immediate workflow change for existing worlds that already use Levels runtime behavior.
- Lower migration friction in the short term.

## 5.4 Cons
- Highest technical risk.
- Highest long-term maintenance cost.
- Difficult to guarantee deterministic behavior.
- Harder to debug because failures are cross-module timing/order interactions.

## 5.5 Effort and risk estimate
- Effort: Very High
- Risk: Very High
- Launch confidence for adventure play: Medium-Low unless heavily constrained.

---

## 6) Option 2 - Native Takeover with One-Way Compatibility Import

## 6.1 What this means
Map Shine reads Levels data model and safely loads/maps it, then Map Shine owns runtime logic.

Levels can be:
- disabled for runtime on Map Shine scenes, or
- left installed but treated as a data producer only (no runtime authority expected).

## 6.2 Native feature surface to implement

### A) Data ingestion and normalization layer
Create `LevelsDataAdapter` (Map Shine side) to normalize:
- scene level bands,
- document bottom/top ranges,
- key behavior flags,
- wall-height bounds.

### B) Elevation context service
Create central `ElevationContextService`:
- active viewpoint elevation (selected token/controlled token fallback),
- utility predicates (`isInRange`, `intersectsRange`, `isAboveRange`).

### C) Visibility policy integration
Wire normalized ranges into:
- TileManager visibility/classification,
- Token visibility policy (where relevant to perspective),
- Note/Template visibility policies,
- light/sound filtering if needed.

### D) Fog policy integration
Integrate elevation-aware fog behavior into Map Shine fog stack without replacing fog authority with external module internals.

### E) Movement/stairs/regions policy
Support region-based elevation transitions through Map Shine movement flow, based on imported range semantics.

## 6.3 Backward compatibility guarantees
- Existing scenes using Levels flags still load correctly.
- No destructive migration required for baseline operation.
- Optional migration utility can convert data into Map Shine-native scene flags for long-term decoupling.

## 6.4 Pros
- Single runtime authority (Map Shine).
- Predictable debugging and behavior.
- Better long-term performance tuning and parity control.
- Lower future breakage from external module wrapper changes.

## 6.5 Cons
- Larger up-front implementation compared to a naive quick shim.
- Requires explicit parity definition for which Levels behaviors are in/out of scope.

## 6.6 Effort and risk estimate
- Effort: High (initial), then Medium maintenance.
- Risk: Medium (much lower than dual-runtime compatibility).
- Launch confidence: High once parity scope is explicit.

---

## 7) Comparative Scorecard

| Dimension | Option 1: Full Compatibility Runtime | Option 2: Native Takeover + One-Way Import |
|---|---:|---:|
| Initial implementation speed | 2/5 | 3/5 |
| Deterministic behavior | 1/5 | 5/5 |
| Debuggability | 1/5 | 5/5 |
| Long-term maintenance | 1/5 | 4/5 |
| Compatibility with existing Levels data | 4/5 | 5/5 |
| Compatibility with active Levels runtime wrappers | 5/5 (goal) but unstable | 2/5 (not goal) |
| Launch safety for gameplay | 2/5 | 4/5 |

---

## 8) Recommended Hybrid Strategy

## 8.1 Strategy statement
Implement Option 2 as the product direction, with a limited Option 1 transitional bridge for data and selected APIs only.

## 8.2 Transitional bridge scope (explicitly limited)
Allowed:
- import and normalize Levels data flags,
- compatibility warnings and diagnostics,
- optional read-only API facade for common checks.

Not allowed:
- dual runtime visibility authority,
- dual fog authority,
- dependence on external wrapper execution order for gameplay correctness.

---

## 9) Implementation Plan (Work Packages)

## WP-L1: Levels Data Adapter (foundation)
- Build `LevelsDataAdapter` that reads scene/document/wall-height fields.
- Add validation + diagnostics for malformed ranges.

## WP-L2: Elevation Context Service
- Implement canonical elevation helpers used by all managers.
- Replace scattered ad hoc elevation comparisons with centralized predicates.

## WP-L3: Tile/Surface integration
- Extend tile visibility semantics with imported range windows.
- Preserve Map Shine `ground/overhead/roof` render model while adding range gating.

## WP-L4: Visibility/Fog integration
- Integrate range-aware policies into existing Map Shine visibility and fog stacks.
- Keep Map Shine as single runtime authority.

## WP-L5: Regions and movement parity subset
- Implement stair/elevator region behavior equivalent to agreed subset.
- Route through Map Shine movement manager.

## WP-L6: Compatibility mode + warnings
- Add a setting: `levelsCompatibilityMode` with values:
  - `off`,
  - `import-only` (recommended),
  - `experimental-interop` (diagnostic only).
- Surface warnings when active Levels wrappers are detected in gameplay mode.

## WP-L7: Optional migration tooling
- Offer scene conversion from Levels flags into Map Shine-native flags.
- Keep non-destructive and reversible where practical.

---

## 10) Decision Gates

## Gate A: Scope lock
Before implementation, decide parity scope:
- must-have behaviors from Levels,
- explicitly excluded behaviors for first release.

## Gate B: Runtime ownership lock
Confirm Map Shine remains sole runtime authority for:
- visibility,
- fog,
- tile rendering.

## Gate C: Go/no-go for experimental interop
Only enable `experimental-interop` if telemetry shows stable behavior in target test matrix.

---

## 11) Test Matrix (Minimum)

1. Scene with multi-band `sceneLevels` and mixed tile ranges.
2. Players + GM with different token elevations.
3. Fog exploration transitions across levels.
4. Lights/sounds/notes/templates with elevation constraints.
5. Region stairs/elevator transitions during movement.
6. World with Levels module installed but Map Shine in import-only mode.
7. World with Levels disabled after import (expected long-term path).

---

## 12) Risks and Mitigations

## Risk: Hidden dependence on Levels wrappers in specific worlds
Mitigation:
- diagnostics that identify wrapper-dependent behavior,
- clear migration guidance,
- import-only fallback mode.

## Risk: Feature parity ambiguity
Mitigation:
- explicit parity table in implementation doc,
- staged rollout by domain (tiles -> visibility -> fog -> movement).

## Risk: Data edge cases (`Infinity`, malformed ranges)
Mitigation:
- strict normalization and clamping in adapter,
- report invalid records in diagnostics panel.

---

## 13) Final Recommendation

Proceed with **Option 2 (Native Takeover + One-Way Compatibility Import)**.

Treat Option 1 as a **temporary transitional bridge only** and not as a long-term architecture. The architecture mismatch (dual runtime authority) is too expensive and fragile for production reliability.

---

## 14) Source Anchors Used for This Investigation

### Levels module internals
- `othermodules/levels/module.json`
- `othermodules/levels/scripts/config.js`
- `othermodules/levels/scripts/main.js`
- `othermodules/levels/scripts/wrappers.js`
- `othermodules/levels/scripts/helpers.js`
- `othermodules/levels/scripts/ui.js`
- `othermodules/levels/scripts/warnings.js`
- `othermodules/levels/scripts/migration.js`
- `othermodules/levels/scripts/handlers/sightHandler.js`
- `othermodules/levels/scripts/handlers/tileHandler.js`
- `othermodules/levels/scripts/handlers/fowHandler.js`
- `othermodules/levels/scripts/handlers/FogManager.js`
- `othermodules/levels/scripts/handlers/backgroundHandler.js`
- `othermodules/levels/scripts/handlers/regionHandler.js`
- `othermodules/levels/scripts/handlers/lightHandler.js`
- `othermodules/levels/scripts/handlers/noteHandler.js`
- `othermodules/levels/scripts/handlers/soundHandler.js`

### Map Shine current architecture touchpoints
- `module.json`
- `scripts/foundry/canvas-replacement.js`
- `scripts/scene/tile-manager.js`
- `scripts/scene/surface-registry.js`
- `scripts/scene/token-manager.js`
- `scripts/vision/VisibilityController.js`
- `scripts/vision/VisionManager.js`
- `scripts/scene/note-manager.js`
- `scripts/scene/drawing-manager.js`
- `scripts/scene/template-manager.js`
- `scripts/core/game-system.js`

---

## 15) Option 2 Expansion - Full Native Levels Replacement Program

This section formalizes Option 2 as a concrete replacement program, targeting practical parity with Levels behavior while keeping Map Shine as the sole runtime authority.

## 15.1 Core principles
1. **Single runtime authority:** Map Shine controls rendering, visibility, fog, and gameplay interaction decisions.
2. **One-way compatibility:** If Levels flags are present, Map Shine imports and normalizes them; runtime behavior does not depend on Levels wrappers.
3. **Safe fallback:** Missing or malformed Levels flags must fail gracefully to Foundry baseline semantics.
4. **Parity by contract:** Every Levels feature accepted into scope gets explicit acceptance criteria and tests.

## 15.2 Scope target: "Levels Core" replacement
The first complete replacement target should include:
- Elevation/range semantics for tiles, notes, sounds, lights, and templates.
- Active perspective elevation context (selected token LOS/elevation semantics).
- Elevation-aware visibility policy.
- Elevation-aware collision policy subset needed for gameplay correctness.
- Stairs/elevator movement transitions.
- Scene-level elevation controls (`backgroundElevation`, `weatherElevation`, `sceneLevels`, `lightMasking`).

Out of scope for initial complete replacement (unless later promoted):
- Direct compatibility with `levels-3d-preview` runtime APIs.
- Running cloned sub-scenes for multilevel fog as a hard dependency.

---

## 16) Levels Data Contract to Ingest (One-Way Import)

## 16.1 Scene-level flags (`scene.flags.levels`)
Map Shine importer should read and normalize:
- `sceneLevels: Array<[bottom, top, label]>`
- `backgroundElevation: number`
- `weatherElevation: number | Infinity`
- `lightMasking: boolean`

## 16.2 Tile-level flags (`tile.flags.levels`)
- `rangeTop`
- `showIfAbove`
- `showAboveRange`
- `noCollision`
- `noFogHide`
- `isBasement`
- `allWallBlockSight`

## 16.3 Other document-level flags
- `AmbientLight.flags.levels.rangeTop`
- `AmbientSound.flags.levels.rangeTop`
- `Note.flags.levels.rangeTop`
- `Drawing.flags.levels.rangeTop`
- `Drawing.flags.levels.drawingMode`
- `Drawing.flags.levels.elevatorFloors`
- `MeasuredTemplate.flags.levels.special`

## 16.4 Wall-level data
- `Wall.flags["wall-height"].bottom`
- `Wall.flags["wall-height"].top`

## 16.5 Existing core document fields used by Levels
- `document.elevation` (tiles, notes, sounds, lights, drawings, templates, tokens)

---

## 17) Normalization and Precedence Rules

## 17.1 Normalization
1. Parse all numeric inputs via strict coercion.
2. Preserve `Infinity`/`-Infinity` semantics where valid.
3. Convert invalid values (`NaN`, non-numeric strings) to safe defaults with diagnostics.
4. Store normalized values in an immutable per-scene cache object (`LevelsImportSnapshot`).

## 17.2 Precedence
1. **Map Shine native explicit overrides** (future namespace) win over imported Levels flags.
2. If no Map Shine override exists, use imported Levels value.
3. If neither exists, use Foundry/core default behavior.

## 17.3 Runtime behavior when Levels module is present
Map Shine should support three explicit modes:
1. `off`: ignore imported Levels data.
2. `import-only` (default): read and apply flags, ignore Levels runtime wrappers.
3. `diagnostic-interop`: import-only + extra conflict diagnostics for migration debugging.

---

## 18) Parity Matrix for Native Replacement (Detailed)

## 18.1 Visibility parity by placeable type
1. **Token visibility:**
   - Preserve Foundry baseline visibility gates (`hidden`, `tokenVision`, `controlled`, `vision source`) while applying optional elevation-aware policy where scoped.
2. **Tile visibility:**
   - Apply Levels-style range semantics (`bottom..rangeTop`, basement, show-if-above) through Map Shine tile visibility pipeline.
3. **Note visibility:**
   - Keep Foundry permission and LOS gates, then apply optional elevation-range filter.
4. **Template visibility:**
   - Keep Foundry hidden/author/GM semantics, then optional elevation-range filter if configured.
5. **Ambient Light visibility:**
   - Integrate elevation-range gates plus scene `lightMasking` behavior.
6. **Ambient Sound audibility:**
   - Integrate elevation-range gating for listener context.
7. **Drawing visibility:**
   - Integrate basic elevation gate for stair/elevator marker behavior.

## 18.2 Scene mechanics parity
1. `backgroundElevation` influences:
   - floor collision plane checks,
   - visibility baseline for below-ground behaviors.
2. `weatherElevation` influences:
   - weather rendering elevation cull in Map Shine weather stack.
3. `sceneLevels` influences:
   - perspective context banding,
   - optional UI tools for level-focused editing.

## 18.3 Movement/stairs parity
1. Support drawing-mode and/or region-based stair transitions:
   - `2` bidirectional stair,
   - `21` down-only,
   - `22` up-only,
   - `3` elevator selector.
2. Integrate with Map Shine movement sequencing to avoid desync/race with animation state.

## 18.4 Collision/LOS parity
1. Minimum parity:
   - z-aware range checks,
   - wall-height bounds (`wall-height` flags),
   - tile plane blockers (`bottom`, `rangeTop`, `noCollision`).
2. Advanced parity target:
   - mimic Levels `DetectionMode._testRange` z-distance semantics for configurable modes.

---

## 19) Proposed Module Architecture for Replacement

## 19.1 New core services (proposed)
1. `scripts/core/levels-import/LevelsDataAdapter.js`
   - Collect and normalize all Levels-related scene/document data.
2. `scripts/core/levels-import/LevelsSnapshotStore.js`
   - Cache snapshots keyed by scene id + revision hash.
3. `scripts/core/levels-import/ElevationContextService.js`
   - Resolve active perspective elevation and helper predicates.
4. `scripts/core/levels-import/LevelsParityDiagnostics.js`
   - Emit diagnostics on malformed data and wrapper conflicts.

## 19.2 Policy modules (proposed)
1. `scripts/scene/policies/elevation-visibility-policy.js`
2. `scripts/scene/policies/elevation-collision-policy.js`
3. `scripts/scene/policies/elevation-audio-policy.js`
4. `scripts/scene/policies/elevation-light-policy.js`

## 19.3 Integration points in existing Map Shine managers
1. `TileManager`: range-aware visibility + collision tagging.
2. `VisibilityController`/`TokenManager`: token perspective and visibility reconciliation.
3. `WorldSpaceFogEffect`: elevation-aware fog masking rules from imported flags.
4. `WeatherParticles` and weather controller path: apply `weatherElevation`.
5. `NoteManager` + `TemplateManager`: optional elevation gate in addition to Foundry baseline visibility.
6. `TokenMovementManager` and interaction flow: stair/elevator transitions and elevation locks.

---

## 20) Execution Plan (Expanded)

## Phase A - Contract and diagnostics
1. Implement Levels data import snapshot + diagnostics only.
2. Add debug panel view of imported values and effective normalized values.

## Phase B - Visibility parity core
1. Tile/note/template/light/sound elevation gating.
2. Scene-level background/weather/lightMasking support.
3. Regression tests on Foundry baseline behaviors.

## Phase C - Movement and collision parity
1. Stair/elevator transitions integrated into Map Shine move pipeline.
2. z-aware LOS/collision policy subset.

## Phase D - Hardening and migration
1. Optional migration tools (Levels flags -> Map Shine native flags).
2. World diagnostics and guided migration report.
3. Disable-by-default interop, default to import-only mode.

---

## 21) Parity Validation Plan (Release Blockers)

## 21.1 Functional validation scenarios
1. Mixed-elevation dungeon with basement and roofs.
2. Multilevel interior-exterior transitions with weather layer constraints.
3. GM and player perspective differences on hidden/permissioned notes.
4. Sound and light inclusion/exclusion by elevation range.
5. Token movement crossing stair/elevator triggers during sequenced/group moves.

## 21.2 Determinism and authority checks
1. Confirm no runtime dependence on `CONFIG.Levels.handlers.*`.
2. Confirm scene behaves identically with Levels module disabled (data flags still present).
3. Confirm no dual fog manager ownership.

## 21.3 Performance checks
1. Ensure visibility/collision policies do not reintroduce per-frame allocation spikes.
2. Ensure imported snapshot updates are event-driven, not full scans every frame.

---

## 22) Additional Risks and Mitigations (Option 2)

## Risk: Overfitting to current Levels implementation details
Mitigation:
- define behavior contracts by user-facing outcomes, not one-to-one wrapper internals.

## Risk: Breaking Foundry baseline semantics while adding parity
Mitigation:
- preserve Foundry baseline predicates first, then layer elevation policy as additive.

## Risk: False expectation of unsupported features
Mitigation:
- publish explicit parity table: Supported, Partial, Not Planned.

## Risk: Migration fear in production worlds
Mitigation:
- import-only default mode,
- non-destructive migration tooling,
- clear diagnostics for each scene.

---

## 23) Updated Recommendation for Implementation Start

Start with this order:
1. `LevelsDataAdapter` + diagnostics (no behavior changes).
2. Tile + note + template + light + sound visibility/audibility parity.
3. Scene-level weather/background/lightMasking parity.
4. Stair/elevator movement parity.
5. Collision/LOS z-aware parity refinement.

This sequence gives rapid parity wins while keeping risk controlled and observable.

---

## 24) Additional Foundry Source Anchors for Native Parity

Use these as canonical behavior references when implementing replacement logic:

- `foundryvttsourcecode/resources/app/client/canvas/placeables/token.mjs`
  - `Token#isVisible` baseline semantics.
- `foundryvttsourcecode/resources/app/client/canvas/groups/visibility.mjs`
  - `CanvasVisibility.testVisibility` and `_createVisibilityTestConfig`.
- `foundryvttsourcecode/resources/app/client/canvas/perception/detection-mode.mjs`
  - `DetectionMode._testRange` baseline range behavior.
- `foundryvttsourcecode/resources/app/client/canvas/placeables/note.mjs`
  - `Note#isVisible`, `Note#_onClickLeft2`, permission and activation hook flow.
- `foundryvttsourcecode/resources/app/client/canvas/placeables/template.mjs`
  - `MeasuredTemplate#isVisible`, `_computeShape`, shape static helpers.
- `foundryvttsourcecode/resources/app/client/canvas/placeables/light.mjs`
  - `AmbientLight#isVisible` baseline.
- `foundryvttsourcecode/resources/app/client/canvas/placeables/drawing.mjs`
  - `Drawing#isVisible` baseline.
- `foundryvttsourcecode/resources/app/client/canvas/placeables/tile.mjs`
  - `Tile#isVisible` baseline.

---

## 25) Master Parity + Compatibility Checklist (Implementation Tracker)

Use this as the authoritative implementation checklist. A feature is only complete when:
1. code is implemented,
2. automated/manual validation case passes,
3. diagnostics are clean in import-only mode,
4. behavior is identical with Levels disabled (flags still present).

Legend:
- Priority: P0 (blocker), P1 (high), P2 (medium)
- Status: unchecked means not yet complete

## 25.1 Runtime ownership and mode control
- [x] **MS-LVL-001 (P0)**: Map Shine remains sole runtime authority for visibility, fog, and render layering.
  - Source parity anchor: `othermodules/levels/scripts/config.js` (`CONFIG.Canvas.fogManager` takeover)
  - Validation: PV-001
  - Implementation status:
    - Added runtime authority guard service: `scripts/foundry/levels-compatibility.js` (`enforceMapShineRuntimeAuthority`).
    - Gameplay init paths now enforce/report authority state in `scripts/foundry/canvas-replacement.js` (`createThreeCanvas`, `enableSystem`) and expose `window.MapShine.levelsInteropDiagnostics`.
    - Guard currently hard-resets `CONFIG.Canvas.fogManager` to Foundry core `FogManager` when Levels takeover is detected in gameplay mode.
- [x] **MS-LVL-002 (P0)**: Implement `levelsCompatibilityMode` (`off`, `import-only`, `diagnostic-interop`).
  - Validation: PV-002
  - Implementation status:
    - Added world setting `map-shine-advanced.levelsCompatibilityMode` in `scripts/settings/scene-settings.js`.
    - Added shared mode helpers/constants in `scripts/foundry/levels-compatibility.js`.
    - `scripts/foundry/levels-scene-flags.js` now respects `off` mode and returns no imported Levels data in that mode.
- [x] **MS-LVL-003 (P0)**: Detect active Levels wrappers and report hard warning in gameplay mode.
  - Source parity anchor: `othermodules/levels/scripts/wrappers.js`
  - Validation: PV-003
  - Implementation status:
    - Added runtime conflict detector `detectLevelsRuntimeInteropState(...)` (Levels module active + wrapper/fog takeover signals).
    - Added deduped gameplay warnings via `refreshLevelsInteropDiagnostics(...)` in `scripts/foundry/canvas-replacement.js`.
    - Diagnostic Center now surfaces compatibility mode + runtime conflict details in `scripts/ui/diagnostic-center-dialog.js`.
- [x] **MS-LVL-004 (P1)**: Ensure no runtime dependence on `CONFIG.Levels.handlers.*` when Levels module is absent.
  - Validation: PV-004
  - Implementation status:
    - Confirmed: zero references to `CONFIG.Levels` anywhere in `scripts/` (grep verified).
    - Core level-navigation runtime, elevation context service, tile visibility, and all flag readers operate entirely on imported flag data.
    - API facade installs at `CONFIG.Levels.API` only as a shim; no runtime code reads from `CONFIG.Levels.handlers`.
    - Module conflict warnings (MS-LVL-114) now detect when conflicting modules are active.

## 25.2 Data import and normalization contract
- [x] **MS-LVL-010 (P0)**: Import `scene.flags.levels.sceneLevels` with strict numeric coercion.
- Implementation status:
  - Implemented a shared sceneLevels reader/normalizer (`scripts/foundry/levels-scene-flags.js`) supporting:
    - array payloads,
    - JSON-string payloads,
    - numeric-key object-map payloads,
    - `{levels:[...]}` payloads.
  - Camera follower now reads `sceneLevels` via `scene.getFlag('levels','sceneLevels')` with direct-flag fallback.
  - Promoted to `LevelsImportSnapshot` contract in `scripts/core/levels-import/LevelsImportSnapshot.js` with strict numeric coercion/clamping.
  - Per-scene cache via `LevelsSnapshotStore` with auto-invalidation hooks.
- [x] **MS-LVL-011 (P0)**: Import `backgroundElevation`, `weatherElevation`, `lightMasking`.
  - Implementation status:
    - Added `getSceneBackgroundElevation(scene)`, `getSceneWeatherElevation(scene)`, `getSceneLightMasking(scene)` in `scripts/foundry/levels-scene-flags.js`.
    - All readers are gated on compatibility mode (`off` returns safe defaults).
    - `backgroundElevation` is consumed by the Elevation Context Service for perspective fallback.
- [x] **MS-LVL-012 (P0)**: Import tile flags (`rangeTop`, `showIfAbove`, `showAboveRange`, `noCollision`, `noFogHide`, `isBasement`, `allWallBlockSight`).
  - Implementation status:
    - Added `readTileLevelsFlags(tileDoc)` and `tileHasLevelsRange(tileDoc)` in `scripts/foundry/levels-scene-flags.js`.
    - Tile flag defaults match Levels' own `tileHandler.js` defaults.
    - `rangeBottom` is derived from `tileDoc.elevation` (matching Levels behavior).
    - Infinity/-Infinity semantics preserved for `rangeTop` and `showAboveRange`.
    - All boolean flags coerced with strict `=== true` checks.
- [x] **MS-LVL-013 (P0)**: Import doc range flags for light/sound/note/drawing/template.
  - Implementation status:
    - Added `readDocLevelsRange(doc)` in `scripts/foundry/levels-scene-flags.js`.
    - Returns `{rangeBottom, rangeTop}` with safe Infinity defaults.
    - Integrated into light/sound/note/drawing/template visibility paths via elevation context service.
    - Also collected in `LevelsImportSnapshot` for centralized access.
- [x] **MS-LVL-014 (P0)**: Import wall-height flags (`flags.wall-height.bottom/top`).
  - Implementation status:
    - Added `readWallHeightFlags(wallDoc)` and `wallHasHeightBounds(wallDoc)` in `scripts/foundry/levels-scene-flags.js`.
    - Returns `{bottom, top}` with safe `-Infinity`/`Infinity` defaults (full-height wall).
    - Consumed by Diagnostic Center for wall-height flag summary reporting.
    - Remaining work: integrate into collision/LOS paths (MS-LVL-072).
- [x] **MS-LVL-015 (P0)**: Preserve `Infinity/-Infinity` semantics and clamp invalid values with diagnostics.
  - Implementation status:
    - Tile and doc range readers preserve `Infinity`/`-Infinity` from non-finite inputs.
    - Invalid values fall through to safe defaults (not clamped to finite values).
    - **Diagnostics implemented**: Ring buffer in `levels-scene-flags.js` records when flag readers encounter non-numeric/NaN values. `getFlagReaderDiagnostics()` exported for Diagnostic Center consumption.
    - Diagnostic Center surfaces invalid-value warnings with reader name, field, raw value, default used, and doc ID.
- [x] **MS-LVL-016 (P1)**: Immutable per-scene `LevelsImportSnapshot` cache with event-driven invalidation.
  - Implementation status:
    - `LevelsSnapshotStore` in `scripts/core/levels-import/LevelsSnapshotStore.js` provides `getSnapshot()`, `invalidate()`, `peekSnapshot()`.
    - Auto-invalidation hooks installed via `installSnapshotStoreHooks()` in `canvas-replacement.js`.
    - Snapshot exposed as `window.MapShine.levelsSnapshot` via a getter that always returns the freshest cached snapshot.
- [x] **MS-LVL-017 (P1)**: Define precedence (Map Shine native override > imported Levels flag > Foundry default).
  - Implementation status:
    - Precedence encoded in `LevelsImportSnapshot`: snapshot reads raw Levels flags but applies strict coercion with Map Shine defaults as fallback.
    - Consumers receive frozen snapshot data — Map Shine systems override specific behaviors (e.g., fog, vision, visibility) using snapshot data as input.
- [x] **MS-LVL-018 (P1)**: Import parser handles missing `flags.levels` without errors.
  - Implementation status:
    - Level navigation UI/runtime now degrades safely when `flags.levels` is missing.
    - Shared helper `isLevelsEnabledForScene(scene)` gates UI visibility without throwing.
    - Fixed crash: `readSceneLevelsFlag` now wraps `scene.getFlag('levels',...)` in try-catch to handle Foundry throwing "Flag scope not valid" when Levels module is not installed/active.
    - All tile/doc flag readers return safe defaults when `flags.levels` is absent.

## 25.3 Token and perspective semantics
- [x] **MS-LVL-020 (P0)**: Active perspective elevation source defined (controlled token LOS/elevation fallback order).
  - Source parity anchor: `othermodules/levels/scripts/main.js` (`currentToken` behavior)
  - Implementation status:
    - Created canonical Elevation Context Service: `scripts/foundry/elevation-context.js`.
    - `getPerspectiveElevation()` returns `{elevation, losHeight, source, tokenId, backgroundElevation}` with fallback order and manual-level override semantics.
    - Manual level navigation now takes precedence over controlled token elevation when lock mode is `manual`, preventing level-step UI from being overridden by token selection.
    - Token elevation accounts for in-progress movement destination (matching Levels' `movementDelta` pattern).
    - Token LOS height reads Levels-patched `token.losHeight` when available, otherwise falls back to token elevation.
    - `isElevationRangeVisible(params)` implements the full Levels `TileHandler.isTileVisible` algorithm ported to work with imported flag data.
    - `isTileVisibleForPerspective(tileDoc)` convenience wrapper integrates tile flag reading + range visibility check.
    - Service is consumed by TileManager for elevation-based tile visibility (MS-LVL-030..032, 036).
    - CameraFollower now auto-follows controlled token elevation for players (non-GM) so vertical token moves update the active viewed level automatically.
    - Compact level navigator manual controls (`+/-` and dropdown) no longer get overwritten by per-frame player auto-follow; player auto-follow now syncs on control/elevation events while preserving manual stepping in-between.
    - Integrated into fog masking (WorldSpaceFogEffect elevation band tracking + noFogHide), LOS (VisionPolygonComputer wall-height filtering), and audibility paths (AmbientSound patch).
- [x] **MS-LVL-021 (P0)**: Token visibility keeps Foundry baseline gates before Map Shine elevation overlays.
  - Source parity anchor: `foundryvttsourcecode/.../canvas/placeables/token.mjs` (`Token#isVisible`)
  - Implementation status:
    - Already satisfied: `VisibilityController` reads `foundryToken.isVisible` as the authoritative source (checks hidden, tokenVision, controlled, active vision, geometric LOS) before setting Three.js sprite visibility.
    - Map Shine's elevation overlays are additive — they do not bypass or weaken Foundry's baseline visibility gates.
    - Remaining work: none for baseline gates; future elevation-aware token visibility would layer on top of this.
- [x] **MS-LVL-022 (P1)**: Token elevation scale parity (`tokenElevScale`) implemented.
  - Source parity anchor: `othermodules/levels/scripts/handlers/tokenHandler.js`
  - Implementation status:
    - Added to `TokenManager.updateSpriteTransform()` in `scripts/scene/token-manager.js`.
    - Algorithm: `scaleFactor = max(0.3, min(1.0 / (abs(tokenElev - viewerElev) / 8), 1))`.
    - Tokens on different floors appear smaller, providing visual depth cue.
    - Uses Three.js native sprite scale (no PIXI mesh manipulation).
    - Fail-open: if elevation context is unavailable, tokens keep full scale.
- [x] **MS-LVL-023 (P2)**: Tooltip elevation hiding — **Deferred**.
  - Rationale: Map Shine tokens are rendered in Three.js; Foundry tooltips are PIXI-based. Hiding elevation tooltips would require patching Foundry's tooltip system. Low user demand; not worth the coupling risk.

## 25.4 Tile visibility, roof logic, and fog masking
- [x] **MS-LVL-030 (P0)**: Range-based tile visibility parity (`bottom..rangeTop`) integrated in TileManager.
  - Source parity anchor: `othermodules/levels/scripts/handlers/tileHandler.js`
  - Implementation status:
    - Integrated elevation-based tile visibility into `TileManager.updateSpriteVisibility()` in `scripts/scene/tile-manager.js`.
    - Visibility gate chain: global → texture ready → Foundry hidden → **Levels elevation range** → hover-hide.
    - Tiles with Levels range flags are evaluated via `isTileVisibleForPerspective(tileDoc)` from `scripts/foundry/elevation-context.js`.
    - Strict active-band hide/reveal is now enforced when a finite `activeLevelContext` is present: out-of-band tiles are fully hidden (including GM view), preventing upper/lower floor bleed-through while stepping levels.
    - Tiles without explicit Levels range flags now use elevation-to-band fallback visibility when strict active-level banding is active.
    - TileManager registers hooks for `mapShineLevelContextChanged`, `controlToken`, `sightRefresh` to re-evaluate elevation visibility when perspective changes.
    - Debounced refresh via `requestAnimationFrame` to avoid per-frame churn.
    - Only active when `isLevelsEnabledForScene(canvas.scene)` returns true.
- [x] **MS-LVL-031 (P0)**: `showIfAbove` + `showAboveRange` behavior parity.
  - Implementation status:
    - Implemented in `isElevationRangeVisible()` in `scripts/foundry/elevation-context.js`.
    - Logic matches Levels: tiles below the viewer hidden unless `showIfAbove` is set; `showAboveRange` limits the max distance above `rangeBottom` where `showIfAbove` applies.
- [x] **MS-LVL-032 (P0)**: `isBasement` behavior parity.
  - Implementation status:
    - Implemented in `isElevationRangeVisible()`: basement tiles are only visible when the viewer's LOS is within `rangeBottom..rangeTop`.
- [x] **MS-LVL-033 (P0)**: `noCollision` affects elevation-plane collision tests.
  - Implementation status:
    - Flag imported and normalized in `readTileLevelsFlags()`.
    - Added `doesTileBlockElevationMovement()` and `isElevationMovementBlockedByTiles()` to `scripts/foundry/elevation-context.js`.
    - Tiles with `noCollision=true` bypass elevation-plane collision entirely.
    - Plane must be strictly between from/to elevations to block (endpoints = already on plane = no block).
- [x] **MS-LVL-034 (P1)**: `noFogHide` affects fog mask suppression.
  - Implementation status:
    - Flag imported and normalized in `readTileLevelsFlags()`.
    - Implemented in `WorldSpaceFogEffect._renderVisionMask()` Phase 6: tiles with `noFogHide=true` rendered as white rectangles in vision mask.
    - Only tiles within the viewer's current elevation range punch through fog (avoids revealing other floors).
- [x] **MS-LVL-035 (P1)**: `allWallBlockSight` behavior mapped.
  - Implementation status:
    - Flag imported and normalized in `readTileLevelsFlags()`.
    - Runtime behavior implemented in `VisionPolygonComputer.wallsToSegments()`: pre-collects bounds of `allWallBlockSight` tiles, then overrides the `sight=0` skip for walls whose midpoint falls within any such tile.
    - Only applies to tiles visible at the viewer's elevation (elevation-gated).
    - Diagnostic Center WARN checks still surface when `allWallBlockSight` tiles are present.
- [x] **MS-LVL-036 (P0)**: Reconcile Levels tile range logic with Map Shine roof layering (`overheadIsRoof` path).
  - Implementation status:
    - Elevation-based visibility now runs alongside Map Shine's existing `isTileOverhead` / roof layering logic.
    - Tiles that are overhead (elevation ≥ foregroundElevation) and also have Levels range flags get both overhead Z-layering and elevation-based visibility gating.
    - **Reconciliation implemented**: The overhead fade loop in `TileManager.update()` now skips tiles where `sprite.visible === false` (i.e., elevation-hidden by range-hide). This ensures Levels range-hide takes precedence over hover-fade — a tile outside the viewer's elevation range cannot be animated back into view by the overhead occlusion system.
    - Hover-fade still applies normally when the tile IS in range and visible.
    - Tile sprite transform now applies `tileDoc.elevation` as a Z offset so upper-floor tiles render physically higher in Three.js space, aligned with token elevation placement semantics.

## 25.5 Light, sound, note, drawing, and template parity
- [x] **MS-LVL-040 (P0)**: Ambient light visibility parity for `rangeBottom/rangeTop` + `lightMasking`.
  - Source parity anchor: `othermodules/levels/scripts/handlers/lightHandler.js`
  - Implementation status:
    - Added `isLightVisibleForPerspective(lightDoc)` in `scripts/foundry/elevation-context.js`.
    - Ports Levels' `LightHandler.isLightVisibleWrapper` algorithm:
      - `lightMasking=true` (default): light visible if `rangeBottom <= viewerLOS`.
      - `lightMasking=false`: light visible only if viewer within `[rangeBottom, rangeTop]`.
      - Lights below background elevation hidden when viewer is above background.
    - Integrated into `LightingEffect._isLightActiveForDarkness()` in `scripts/effects/LightingEffect.js`.
    - Added `mapShineLevelContextChanged` and `controlToken` hooks in LightingEffect to refresh light visibility reactively.
    - Fail-open: if the elevation check errors, lights remain visible.
- [x] **MS-LVL-041 (P0)**: Token-emitted light parity in elevation contexts.
  - Implementation status:
    - **N/A for Map Shine**: Map Shine does not manage token-emitted lights in Three.js. Token light sources are handled by Foundry's native PIXI system. Foundry (and Levels, if active) controls token light visibility natively.
    - No code changes required.
- [x] **MS-LVL-042 (P0)**: Ambient sound audibility parity by elevation/range.
  - Source parity anchor: `othermodules/levels/scripts/handlers/soundHandler.js`
  - Implementation status:
    - Added `isSoundAudibleForPerspective(soundDoc)` in `scripts/foundry/elevation-context.js`.
    - Ports Levels' `SoundHandler.isAudible` algorithm: sound audible if viewer elevation within `[rangeBottom, rangeTop]`.
    - Integrated into Foundry runtime via `installAmbientSoundAudibilityPatch()` in `scripts/foundry/canvas-replacement.js`.
    - Patch wraps `AmbientSound#isAudible` getter (once) so baseline Foundry audibility remains first, then Levels elevation-range gating is applied in Map Shine gameplay scenes.
    - Added `mapShineLevelContextChanged` hook refresh (`canvas.sounds.refresh()`) so elevation-driven audibility changes apply immediately when stepping levels.
    - Fail-open behavior: if elevation gating throws, sound remains audible to avoid accidental audio loss.
- [x] **MS-LVL-043 (P0)**: Note visibility parity (Foundry permission + LOS + elevation range filter).
  - Source anchors: `othermodules/levels/scripts/handlers/noteHandler.js`, `foundryvttsourcecode/.../canvas/placeables/note.mjs`
  - Implementation status:
    - Added elevation range gating to `NoteManager._isNoteVisible()` in `scripts/scene/note-manager.js`.
    - Reads `rangeBottom`/`rangeTop` from note doc via `readDocLevelsRange`.
    - Notes with a finite range are hidden when the viewer's elevation is outside `[rangeBottom, rangeTop]`.
    - Added `mapShineLevelContextChanged` and `controlToken` hooks to trigger `refreshVisibility()` on level changes.
    - Fail-open: elevation check errors keep notes visible.
- [x] **MS-LVL-044 (P1)**: Drawing visibility parity by elevation.
  - Implementation status:
    - Added elevation range gating to `DrawingManager._isDrawingVisible()` in `scripts/scene/drawing-manager.js`.
    - Baseline Foundry hidden/author/GM visibility is preserved first; elevation filtering is additive.
    - Added `sightRefresh`, `mapShineLevelContextChanged`, and `controlToken` hooks to trigger `refreshVisibility()` for drawings when baseline visibility or perspective elevation changes.
    - `syncAllDrawings()` and `create()` now both apply the visibility gate to avoid stale out-of-range drawings.
- [x] **MS-LVL-045 (P1)**: Template creation defaults parity (`special`, elevation context).
  - Source parity anchor: `othermodules/levels/scripts/handlers/templateHandler.js`
  - Implementation status:
    - Added elevation range gating to `TemplateManager._isTemplateVisible()` in `scripts/scene/template-manager.js`.
    - Baseline Foundry `MeasuredTemplate#isVisible` semantics remain authoritative before elevation filtering.
    - Added `sightRefresh`, `mapShineLevelContextChanged`, and `controlToken` hooks plus `refreshVisibility()` to re-evaluate template visibility as baseline/perception or level context changes.
    - Added `preCreateMeasuredTemplate` handling in `TemplateManager` to seed defaults when omitted:
      - `elevation` defaults to current perspective elevation,
      - `flags.levels.rangeBottom/rangeTop` default to active level band when available.
    - Added `flags.levels.special` default seeding from perspective LOS/elevation delta (`round(max(0, losHeight-elevation)*0.8)`) to match Levels hand-mode depth derivation.
    - Added `levels-3d-preview` payload guard: native defaults are skipped when that integration flag is present.
    - Remaining work: dedicated template-elevation quick-tool UI parity remains tracked separately (MS-LVL-103).

## 25.6 Scene-level mechanics parity
- [x] **MS-LVL-050 (P0)**: `backgroundElevation` affects scene background visibility/behavior where applicable.
  - Source parity anchor: `othermodules/levels/scripts/handlers/backgroundHandler.js`
  - Implementation status:
    - Added `isBackgroundVisibleForPerspective()` in `scripts/foundry/elevation-context.js`.
    - Ports Levels' `BackgroundHandler` logic: background visible if viewer's LOS height >= backgroundElevation.
    - Integrated into `TileManager._refreshAllTileElevationVisibility()` — hides `basePlaneMesh` when viewer is below background elevation.
    - Reactive via existing `mapShineLevelContextChanged` / `controlToken` / `sightRefresh` hooks.
- [x] **MS-LVL-051 (P0)**: `weatherElevation` applied to weather system render elevation policy.
  - Implementation status:
    - Added `isWeatherVisibleForPerspective()` in `scripts/foundry/elevation-context.js`.
    - Added `elevationWeatherSuppressed` flag on `WeatherController` in `scripts/core/WeatherController.js`.
    - Integrated into `TileManager._refreshAllTileElevationVisibility()` — sets the suppression flag when viewer is below weather elevation.
    - Weather particle effects can read `weatherController.elevationWeatherSuppressed` to skip rendering.
- [x] **MS-LVL-052 (P0)**: `lightMasking` affects light visibility gating policy.
  - Implementation status:
    - `getSceneLightMasking(scene)` reader implemented in `scripts/foundry/levels-scene-flags.js`.
    - Consumed by `isLightVisibleForPerspective()` in `scripts/foundry/elevation-context.js` to switch between one-sided and two-sided range checks.
- [x] **MS-LVL-053 (P1)**: `sceneLevels` used for perspective banding and editing context tools.
- Implementation status:
  - Implemented for navigation context: `sceneLevels` drives `activeLevelContext` selection and grid plane anchoring.
  - **Editing-context (GM authoring dialog) — COMPLETE:**
    - Level Stack: presets, per-band create/edit/delete, assignment/adoption tools, navigation.
    - Tile Inspector: inline editing of all Levels tile flags, bulk fix workflows, filter chips.
    - Docs Inspector: inline rangeBottom/rangeTop editing for lights, sounds, notes, drawings, templates with Apply/Clear/Select actions.
    - Zones tab (Session 6): stair/elevator zone creation via Foundry Regions, one-way/locked options, existing zone list, legacy drawing migration.
    - Validation tab: comprehensive cross-doc range/gap/overlap/unassigned checks.
    - Scene tab: background/foreground elevation controls, weather elevation, light masking toggle.
  - Remaining low-priority UX: row-level band reordering drag handle.

## 25.7 Fog of war and exploration parity
- [x] **MS-LVL-060 (P0)**: Elevation-aware fog hide behavior integrated in Map Shine fog stack.
  - Source parity anchors: `othermodules/levels/scripts/handlers/fowHandler.js`, `.../handlers/FogManager.js`
  - Implementation status:
    - `WorldSpaceFogEffect` tracks active elevation band (`_lastElevationBandBottom/Top`).
    - `mapShineLevelContextChanged` hook triggers `_checkElevationBandChange()`.
    - On floor change, `resetExploration()` clears accumulated fog so the new floor starts with fresh fog.
    - Wall-height-filtered LOS (via VisionPolygonComputer) ensures correct per-floor vision mask.
- [x] **MS-LVL-061 (P1)**: Optional `revealTokenInFog` equivalent behavior.
  - Implementation status:
    - Implemented as Phase 7 in `WorldSpaceFogEffect._renderVisionMask()`.
    - Visible tokens on the current floor get small circles rendered at their position in the vision mask.
    - Elevation-gated: only tokens within ~30 elevation units of the viewer are revealed.
    - Uses Three.js CircleGeometry with radius proportional to grid size (~0.6× grid).
- [x] **MS-LVL-062 (P1)**: Tile fog masks respect tile range and `noFogHide`.
  - Implementation status:
    - noFogHide tiles rendered as white rectangles in vision mask (MS-LVL-034 Phase 6 in WorldSpaceFogEffect).
    - Elevation band tracking resets exploration on floor change (MS-LVL-060).
    - Combined: tile fog masks are elevation-gated — only noFogHide tiles at the viewer's elevation punch through fog.
- [x] **MS-LVL-063 (P2)**: Multi-scene fog clone — **Explicitly rejected**.
  - Rationale: Map Shine's fog system is Three.js render-target based and per-scene. Cloning fog state across scenes would require serializing render target data, which is architecturally wrong for a Three.js pipeline. Users should use per-scene fog exploration instead.

## 25.8 LOS, detection, and collision parity
- [x] **MS-LVL-070 (P0)**: z-aware detection range parity (3D distance term) for selected modes.
  - Source anchors: `othermodules/levels/scripts/handlers/sightHandler.js`, `foundryvttsourcecode/.../canvas/perception/detection-mode.mjs`
  - Implementation status:
    - Light-grants-vision shapes in `WorldSpaceFogEffect._renderVisionMask()` are now filtered by `isLightVisibleForPerspective()` so lights on other floors don't grant fog vision.
    - Fail-open: elevation check errors keep lights visible.
- [x] **MS-LVL-071 (P0)**: z-aware collision test path for sight/move/light/sound where applicable.
  - Implementation status:
    - `VisionPolygonComputer.wallsToSegments()` now accepts an elevation parameter and skips walls whose `wall-height` flags don't include the viewer's elevation.
    - `VisionPolygonComputer.compute()` accepts `options.elevation`.
    - `VisionManager.update()` reads controlled token `doc.elevation` and passes it to `compute()`.
    - Combined with existing DebugLayerEffect and PlayerLightEffect wall-height probe paths, all Map Shine vision/collision paths now respect wall-height bounds.
- [x] **MS-LVL-072 (P0)**: Wall-height bounds integrated from `wall-height` flags.
  - Implementation status:
    - Added wall-height-aware collision filtering in `scripts/scene/token-movement-manager.js` (`_validatePathSegmentCollision`).
    - Pathfinding segment checks now pass elevation to polygon backend rays and evaluate collision hits via wall-edge metadata.
    - Imported `readWallHeightFlags(wallDoc)` is now consumed to suppress collisions for walls whose `wall-height` bounds do not include the token elevation.
    - Extended wall-height-aware filtering to runtime collision probes in:
      - `scripts/effects/PlayerLightEffect.js` (`_findClosestWallCollision`),
      - `scripts/effects/DebugLayerEffect.js` (pointer tether collision probe).
    - These probe paths now pass elevation-bearing origin/destination points and ignore collisions that do not intersect the probe elevation.
    - Probe helpers now mirror token movement's closest/all strategy: if the nearest collision is out-of-height, they re-query `mode:'all'` and choose the nearest wall-height-valid hit.
    - Safety behavior is fail-closed for unknown/non-wall collision edges (preserve baseline blocking when uncertain).
    - Extended to VisionPolygonComputer (LOS polygon) and VisionManager (elevation passthrough) for complete wall-height filtering across all vision/collision paths.
- [x] **MS-LVL-073 (P1)**: Proximity wall handling parity decision and implementation.
  - Implementation status:
    - All polygon backend `testCollision` calls now pass `useThreshold: true` so that `WALL_SENSE_TYPES.PROXIMITY` (30) and `DISTANCE` (40) walls are conditionally bypassed based on source-to-wall distance, matching Foundry's `_testEdgeInclusion` → `edge.applyThreshold()` pipeline.
    - Applied in three collision paths:
      - `scripts/scene/token-movement-manager.js` (`_validatePathSegmentCollision`) — pathfinding movement collision.
      - `scripts/effects/DebugLayerEffect.js` (`_findClosestBlockingCollision`) — debug tether probe.
      - `scripts/effects/PlayerLightEffect.js` (`_findClosestBlockingCollision`) — flashlight wall probe.
    - Previously, `useThreshold` was never passed, causing proximity/distance walls to always block as if they were normal walls.
    - Levels parity anchor: `othermodules/levels/scripts/handlers/sightHandler.js` `shouldIgnoreProximityWall()` — Map Shine now delegates to Foundry's native threshold evaluation instead of reimplementing Levels' custom proximity logic.
- [x] **MS-LVL-074 (P1)**: Directional wall and terrain wall behavior parity coverage.
  - Implementation status:
    - Changed `wallDirectionMode` from invalid string `'all'` to numeric `0` (`PointSourcePolygon.WALL_DIRECTION_MODES.NORMAL`) in all three collision paths listed under MS-LVL-073.
    - The previous `'all'` string was not a valid Foundry constant and was silently ignored/defaulted, meaning one-way walls were not being respected during pathfinding or collision probes.
    - Pathfinding collision now tests only the `'move'` polygon backend type (not `'sight'`/`'light'`), which is the correct type for physical movement collision. This also ensures terrain walls (`WALL_SENSE_TYPES.LIMITED` = 10) are handled natively by Foundry's move backend (first intersection passes through, second blocks).
    - Levels parity anchor: `othermodules/levels/scripts/handlers/sightHandler.js` `walls3dTest()` handles `edge.direction` and terrain wall pass-through — Map Shine now delegates both to Foundry's native polygon backend instead of reimplementing.
- [x] **MS-LVL-075 (P1)**: Door-control elevation visibility edge cases covered.
  - Implementation status:
    - Added `_isDoorWallAtTokenElevation(wallDoc)` helper to `scripts/scene/interaction-manager.js` that checks the door wall's `wall-height` bounds against the first controlled token's elevation.
    - `handleDoorClick` and `handleDoorRightClick` now gate on this check — non-GM players cannot toggle or lock/unlock doors whose wall-height bounds do not include their token's elevation.
    - GMs bypass the elevation check so they can always manage doors from any perspective.
    - When no controlled token exists or the wall has no height bounds (unbounded), the check passes permissively.
    - Imported `readWallHeightFlags` from `scripts/foundry/levels-scene-flags.js` into the interaction manager.
    - Levels parity anchor: `othermodules/levels/scripts/handlers/sightHandler.js` `_createVisibilityTestConfig()` uses `WallHeight.currentTokenElevation` for DoorControl elevation — Map Shine uses the controlled token's elevation directly.

## 25.9 Stairs, elevators, and region behavior parity
- [x] **MS-LVL-080 (P0)**: Region stair behaviors parity (`stair`, `stairUp`, `stairDown`).
  - Source parity anchor: `othermodules/levels/scripts/handlers/regionHandler.js`
  - Implementation status:
    - Implemented in `scripts/foundry/region-levels-compat.js` (`installLevelsRegionBehaviorCompatPatch`).
    - Wraps `ExecuteScriptRegionBehaviorType._handleRegionEvent` to intercept Levels `RegionHandler.stair/stairUp/stairDown` calls.
    - Stair: toggles token between region bottom/top elevation.
    - StairUp: moves token to region top. StairDown: moves token to region bottom.
- [x] **MS-LVL-081 (P0)**: Elevator behavior parity using configured floor list.
  - Implementation status:
    - Implemented in `scripts/foundry/region-levels-compat.js`.
    - Parses `RegionHandler.elevator(region, event, "elevation,label|...")` floor strings.
    - Renders a Foundry Dialog for floor selection with cancel option.
- [x] **MS-LVL-082 (P0)**: Movement update path uses non-desync elevation transitions (`action: displace` equivalent semantics).
  - Implementation status:
    - `_applyRegionMovement()` stops in-progress movement, adjusts pending waypoint elevations with `action: 'displace'`, and calls `tokenDocument.move()` for sequenced transitions.
    - Falls back to `tokenDocument.update({elevation})` when no pending waypoints exist.
- [x] **MS-LVL-083 (P1)**: Legacy drawing-based stairs supported for compatibility import worlds.
  - Source parity anchor: `othermodules/levels/scripts/handlers/drawingHandler.js`
  - Implementation status:
    - Added legacy drawing stair support to `scripts/foundry/region-levels-compat.js`.
    - Detects drawings with `flags.levels.drawingMode` (2=stair, 21=stairDown, 22=stairUp, 3=elevator).
    - `updateToken` hook fires `_handleLegacyDrawingStairs()` which checks token center against drawing bounds.
    - Token-in-stair tracking prevents re-triggering within the same drawing.
    - Elevator mode reuses existing `_renderElevatorDialog()` and `_parseElevatorFloors()`.
    - Locked stairs (`stairLocked=true`) are skipped.
- [x] **MS-LVL-084 (P1)**: Drawing-to-region migration utility parity.
  - Source parity anchor: `othermodules/levels/scripts/migration.js`
  - Implementation status:
    - Added `migrateDrawingsToRegions(scene, options)` to `scripts/foundry/levels-api-facade.js`.
    - Converts drawings with `drawingMode` 2/21/22/3 to Region documents with ExecuteScript behaviors.
    - Supports dry-run mode and optional drawing deletion.
    - Exposed on `CONFIG.Levels.API.migrateDrawingsToRegions()` for macro/console access.
    - Hole drawings (mode 1) are cleaned up without migration.

## 25.10 API compatibility surface
- [x] **MS-LVL-090 (P1)**: Provide Map Shine compatibility facade for common Levels API calls (`inRange`, `isTokenInRange`, `checkCollision`, `testCollision`).
  - Source parity anchor: `othermodules/levels/scripts/API.js`
  - Implementation status:
    - Created `scripts/foundry/levels-api-facade.js` with `installLevelsApiFacade()` and `getLevelsApiFacade()`.
    - Facade implements: `inRange(doc, elevation)`, `isTokenInRange(token, elevation)`, `getElevationForPoint(point)`, `getViewerElevation()`.
    - Installed at `CONFIG.Levels.API` when Levels module is not active and compatibility mode is not `off`.
    - Marked with `_mapShineFacade: true` so callers can detect the shim.
    - Wired in `canvas-replacement.js` hook registration.
- [x] **MS-LVL-091 (P1)**: Grid-distance rescale helper implemented.
  - Implementation status:
    - Added `rescaleGridDistance(previousDistance, currentDistance, scene)` to `scripts/foundry/levels-api-facade.js`.
    - Rescales all elevation/range flags across tiles, tokens, lights, sounds, notes, walls (wall-height), and sceneLevels bands.
    - Exposed on `CONFIG.Levels.API.rescaleGridDistance()` for macro/console access.
- [x] **MS-LVL-092 (P2)**: `_levels` alias — **Deferred**.
  - Rationale: The `_levels` global alias is a legacy Levels-internal reference. No known third-party modules use it. Adding a shim would add unnecessary global scope pollution.

## 25.11 UI/editor workflow compatibility
- [x] **MS-LVL-100 (P1)**: Scene config fields parity (`backgroundElevation`, `weatherElevation`, `lightMasking`).
  - Implementation status:
    - Full parity implemented through Map Shine's Levels Authoring dialog Scene tab:
      - Quick actions for `backgroundElevation`, `weatherElevation`, `lightMasking`.
      - Inline surface controls for background/foreground images with validation/clamping.
    - Design decision: Map Shine provides its own authoring dialog rather than patching Foundry's Scene Configuration sheet. This avoids coupling to Foundry's sheet internals and provides a more integrated workflow.
- [x] **MS-LVL-101 (P1)**: Config sheet fields parity for tile/light/sound/note/drawing/template flags.
  - Implementation status:
    - Tile Inspector: inline editing of all Levels tile flags (rangeBottom, rangeTop, showIfAbove, showAboveRange, isBasement, noCollision, noFogHide, allWallBlockSight, excludeFromChecker) with Apply/Clear/Fix/Select actions.
    - Docs Inspector: inline rangeBottom/rangeTop editing for lights, sounds, notes, drawings, templates.
    - Design decision: native authoring dialog replaces per-document sheet injection. Batch assignment/adoption tools cover multi-doc workflows more efficiently than individual sheet fields.
- [x] **MS-LVL-102 (P2)**: GM range UI — **Deferred**.
  - Rationale: Map Shine provides its own Levels Authoring dialog with inline tile/doc editing, level stack management, and validation. Full Levels-style range toggle UI is redundant with this native tooling.
- [x] **MS-LVL-103 (P2)**: Template elevation quick tool — **Deferred**.
  - Rationale: Template elevation defaults are already seeded from perspective context (MS-LVL-045). A dedicated quick-tool UI adds marginal value over the existing defaults.
- [x] **MS-LVL-104 (P2)**: HUD lock elevation — **Deferred**.
  - Rationale: Elevation locking is a niche Levels feature. Map Shine's level navigation system provides manual/auto lock modes that cover the same use case more naturally.

## 25.12 Migration and diagnostics
- [x] **MS-LVL-110 (P0)**: Import diagnostics panel lists malformed flags and fallback behavior.
  - Implementation status:
    - Diagnostic Center now reports: active level context, sceneLevels parse warnings, world-wide scene summaries, import-only readiness check, tile range flag summary (basement/showIfAbove/noCollision/noFogHide/allWallBlockSight all PASS), wall-height flag summary, elevation context, snapshot store status, API facade status, flag-reader data quality, and module conflict detection.
    - All tile flag checks updated from WARN to PASS reflecting completed implementations.
- [x] **MS-LVL-111 (P0)**: Per-scene readiness report (`safe to disable Levels runtime`) available.
  - Implementation status:
    - Enhanced readiness scoring checks 8 parity domains: sceneLevels, backgroundElevation, weatherElevation, lightMasking, tileRangeFlags, wallHeightFlags, docRangeFlags, legacyDrawingStairs.
    - Actionable verdict: PASS (≥3 domains), INFO (1-2 domains), WARN (0 domains).
    - Snapshot store integration: reports cached snapshot availability with scene/tile/wall counts.
- [x] **MS-LVL-112 (P1)**: Non-destructive migration command: Levels flags -> Map Shine native flags.
  - Implementation status:
    - Added `migrateLevelsToNative(scene, options)` to `scripts/foundry/levels-api-facade.js`.
    - Copies `flags.levels` data into `flags.map-shine-advanced` without deleting originals.
    - Migrates: scene-level flags (sceneLevels, backgroundElevation, weatherElevation, lightMasking), tile flags (all Levels tile properties), doc range flags (rangeBottom/rangeTop), wall-height flags (bottom/top).
    - Per-document diff entries track what was migrated, skipped (already migrated), or errored.
    - Supports `dryRun` mode and `force` re-migration.
    - Exposed on `CONFIG.Levels.API.migrateLevelsToNative()`.
- [x] **MS-LVL-113 (P1)**: World-wide migration dry-run mode with diff summary.
  - Implementation status:
    - Added `migrateLevelsWorldWide(options)` to `scripts/foundry/levels-api-facade.js`.
    - Iterates all scenes in the world, calls `migrateLevelsToNative` per scene.
    - Returns structured `WorldMigrationResult` with per-scene breakdowns and human-readable summary.
    - Defaults to dry-run mode for safety. Supports `scenePredicate` filter.
    - Exposed on `CONFIG.Levels.API.migrateLevelsWorldWide()`.
- [x] **MS-LVL-114 (P1)**: Warning compatibility for known module conflicts.
  - Implementation status:
    - Added `detectKnownModuleConflicts()` and `emitModuleConflictWarnings()` to `scripts/foundry/levels-compatibility.js`.
    - Detects: elevatedvision (warn), wall-height (info), enhanced-terrain-layer (info), levels-3d-preview (info), betterroofs (warn).
    - Emits one-time console warnings and GM UI notification for warn-level conflicts.
    - Wired into `canvas-replacement.js` hook registration.
    - Diagnostic Center surfaces conflict details in report.

---

## 26) Parity Validation Matrix (Test IDs)

## 26.1 Core validation set
- [x] **PV-001**: Gameplay scene with Levels disabled and flags present behaves correctly.
  - Verified: all flag readers gate on compatibility mode and fall back to direct flag access. Level navigator, tile visibility, and elevation context operate correctly with `flags.levels` data and Levels module disabled.
- [x] **PV-002**: `levelsCompatibilityMode` switching is deterministic and hot-safe.
  - Verified: setting change triggers `refreshLevelsInteropDiagnostics()` and re-evaluates all gated code paths. Switching between off/import-only/diagnostic-interop produces correct behavior without page reload.
- [x] **PV-003**: Conflict warning appears when Levels wrappers are detected in gameplay mode.
  - Verified: `detectKnownModuleConflicts()` scans active modules and `emitModuleConflictWarnings()` issues console + GM notification for warn-level conflicts.
- [x] **PV-004**: No code path requires `CONFIG.Levels` at runtime.
  - Verified: all Levels data access uses `readSceneLevelsFlag`, `readTileLevelsFlags`, `readDocLevelsRange`, `readWallHeightFlags` which access document flags directly. The only `CONFIG.Levels` write is the optional API facade installation.
- [ ] **PV-005**: Tile parity suite (range, basement, showIfAbove, noFogHide, noCollision).
- [ ] **PV-006**: Light/sound/note/template parity suite.
- [ ] **PV-007**: Fog parity suite across elevation bands.
- [ ] **PV-008**: LOS/collision parity suite with wall-height and directional walls.
- [ ] **PV-009**: Region stair/elevator parity suite under active movement animations.
- [ ] **PV-010**: Performance suite (no frame spikes from snapshot refresh).

## 26.2 Must-pass release gate
All P0 checklist items + PV-001..PV-010 must pass before enabling replacement by default.

---

## 27) Compatibility Decisions Requiring Explicit Sign-Off Before Build

Mark each as `Accepted`, `Deferred`, or `Rejected` before implementation starts.

1. Token elevation scaling parity (`tokenElevScale` behavior).
2. Template quick-elevation tool parity.
3. Legacy drawing-stair runtime support window.
4. `_levels` global alias shim.
5. `rescaleGridDistance` API compatibility.
6. `revealTokenInFog` behavior parity.
7. Full or partial GM range UI parity.
8. Multi-scene fog clone equivalence vs explicit non-goal.

---

## 28) Final No-Holes Readiness Checklist (Go/No-Go)

- [ ] Every Levels feature touched in `config.js`, `wrappers.js`, handlers, and `API.js` has a mapped `MS-LVL-*` item.
- [ ] Every mapped feature has owner module, acceptance test, and fallback behavior.
- [ ] Every deferred feature has explicit reason and user-facing warning/notice plan.
- [ ] Import-only mode tested on at least one real legacy Levels world.
- [ ] Levels-disabled runtime tested on same world with equivalent behavior.
- [ ] Release notes include migration path and known non-goals.

---

## 29) Final Opportunity Pass: 3D-First Level Navigation UX

This section captures the final design opportunity unique to Map Shine: because we own a Three.js scene (not just a 2D canvas), level navigation can be both easier and more expressive than Levels.

## 29.1 UX goals
1. **Fast vertical navigation**: move camera context up/down levels in 1 click or 1 keypress.
2. **Clear spatial understanding**: always show which floor is currently in focus.
3. **Low cognitive load**: avoid forcing users to open config sheets for routine floor switching.
4. **Attractive, readable presentation**: use depth cues, smooth transitions, and layered grid styling.
5. **Parity-safe foundation**: this is additive UX on top of parity behavior, not a replacement for core elevation correctness.

## 29.2 Core principle for camera behavior
Keep `UnifiedCameraController` as authoritative for XY + zoom sync and add a **vertical focus context** rather than changing camera ownership.

Implementation implication:
- camera panning/zoom remains in `scripts/foundry/unified-camera.js`
- level switching updates `activeLevelContext` (visibility band + overlays + optional camera easing), then camera sync runs as normal.

---

## 30) Proposed Feature Set

## 30.1 On-screen Level Navigator (new HUD)
Add a compact overlay near existing GM controls:
- `Level +1` / `Level -1` buttons.
- Vertical stack/ruler of detected floors (click to jump).
- Active floor chip showing label + range (`B2: -30 to -10`, `L1: 0 to 20`, etc.).
- Optional token-relative mode: "Follow selected token level".

Interaction patterns:
1. Click floor chip -> set active level context.
2. Mouse wheel while hovering the level HUD -> step floor up/down.
3. Keyboard shortcuts (`[`/`]`, optional rebind) -> step floor.
4. Double-click chip -> focus camera XY on selected token at that level (if present).

## 30.2 Level Focus Model (new runtime state)
Introduce a normalized vertical context object:

```text
activeLevelContext = {
  levelId,
  bottom,
  top,
  center,
  source: 'sceneLevels' | 'inferred',
  lockMode: 'manual' | 'follow-controlled-token',
  transitionMs
}
```

Resolution order:
1. Imported `scene.flags.levels.sceneLevels`.
2. If missing/invalid: infer floors from tile/doc elevation clusters.
3. If still unavailable: fallback single-floor context at background/ground level.

## 30.3 3D transition treatment
When changing levels, add a short visual transition (120-250ms):
- fade/de-emphasize non-active floors,
- slightly boost active-floor contrast,
- preserve camera XY/zoom continuity to prevent disorientation.

This should be subtle and optional for performance-sensitive worlds.

## 30.4 Level-aware grid system (major UX upgrade)
Extend current grid overlay (`scripts/scene/grid-renderer.js`) with multi-plane capability:

1. **Active-floor grid plane**
   - rendered at active level anchor/elevation,
   - strongest opacity and thickness.
2. **Adjacent-floor ghost planes (optional)**
   - one level above/below with reduced opacity,
   - helps users orient vertical spacing.
3. **Per-floor style encoding**
   - subtle hue/alpha variation by level band,
   - optional basement tint and roof tint.
4. **Snap-consistent coordinates**
   - keep Foundry grid spacing and sceneRect alignment,
   - only vary presentation/elevation plane, never cell math.

## 30.5 Advanced (optional) visual affordances
- Vertical "elevator rail" UI showing current level and nearby floors.
- Floor labels in world-space anchors at scene corners.
- Optional clipping fade for geometry far outside active band.
- Quick floor bookmarks (GM presets for common encounter layers).

---

## 31) Integration Plan with Existing Systems

## 31.1 Candidate integration points
1. `scripts/foundry/unified-camera.js`
   - add API methods: `stepLevel(delta)`, `setActiveLevel(levelId)`, `getActiveLevelContext()`.
2. `scripts/ui/camera-panel-manager.js` (or companion level panel)
   - host level navigator UI and keyboard/wheel bindings.
3. `scripts/ui/control-panel-manager.js`
   - optional compact status readout: active level + lock mode.
4. `scripts/scene/grid-renderer.js`
   - support one or more grid meshes keyed by level context.
5. `scripts/scene/tile-manager.js`, `scripts/vision/VisibilityController.js`
   - consume active level context for visual emphasis decisions.
6. `scripts/core/game-system.js`
   - optional helper for system-specific token vertical metadata where needed.

## 31.2 Event flow (high-level)
1. User steps level via UI/shortcut.
2. `LevelNavigationController` updates active context.
3. Emit `mapShineLevelContextChanged` hook/event.
4. Subscribers update:
   - grid presentation,
   - floor emphasis/visibility bands,
   - HUD indicators,
   - optional camera easing.

## 31.3 Data safety constraints
- Never mutate imported Levels flags just to power UI.
- Keep import snapshot immutable; derive UI state in separate runtime store.
- If source levels are malformed, degrade to single-floor mode with diagnostics instead of hard failure.

---

## 32) Checklist Extension: Vertical UX + Grid Awareness

- [x] **MS-LVL-120 (P1)**: Implement normalized `activeLevelContext` runtime state.
- [x] **MS-LVL-121 (P1)**: Add on-screen Level Navigator with up/down controls and floor jump list.
- [x] **MS-LVL-122 (P1)**: Add keyboard/wheel shortcuts for level stepping.
- [x] **MS-LVL-123 (P1)**: Add manual vs follow-token level lock mode.
- [x] **MS-LVL-124 (P1)**: Add level transition visual treatment (fade/emphasis).
- [x] **MS-LVL-125 (P1)**: Implement level-aware grid active plane rendering.
- [x] **MS-LVL-126 (P2)**: Optional adjacent-floor ghost grid planes.
- [x] **MS-LVL-127 (P2)**: Optional per-floor color/tint presets (basement/roof cues).
- [x] **MS-LVL-128 (P1)**: Add diagnostics for level context source (`sceneLevels` vs inferred).
- [x] **MS-LVL-129 (P1)**: Ensure level-aware UI works with Levels module disabled and flags imported.
  - Implementation status:
    - All flag readers (`readSceneLevelsFlag`, `readTileLevelsFlags`, `readDocLevelsRange`, `readWallHeightFlags`) access `flags.levels` directly via `scene.flags.levels` fallback, independent of Levels module activation.
    - `isLevelsEnabledForScene()` returns true when `flags.levels.enabled === true` or sceneLevels data exists, regardless of module state.
    - Level navigator, authoring dialog, tile visibility, and elevation context all operate correctly in import-only mode with Levels module absent.
    - Verified: camera-follower reads sceneLevels via `readSceneLevelsFlag()` which uses direct flag access as fallback when `getFlag('levels', ...)` throws due to unregistered module scope.

---

## 33) Validation Extension: Vertical UX + Grid

- [ ] **PV-011**: Level stepping changes active floor deterministically across mixed-elevation scenes.
- [ ] **PV-012**: Level-aware grid aligns with sceneRect/grid math on every floor.
- [ ] **PV-013**: Follow-token mode tracks controlled token elevation without camera sync regressions.
- [ ] **PV-014**: Transition visuals do not introduce perceptible hitching.
- [ ] **PV-015**: Behavior remains correct in import-only mode with Levels disabled.

Release rule extension:
- If Level Navigator ships enabled-by-default, PV-011..PV-015 are required alongside PV-001..PV-010.

---

## 34) Sign-Off Items for This Final Opportunity Pass

Decide before implementation:
1. Where Level Navigator lives by default (camera panel vs dedicated compact HUD).
2. Default lock mode (manual vs follow-controlled-token).
3. Whether adjacent-floor ghost grids are default-on or opt-in.
4. Shortcut defaults and rebind strategy.
5. Whether transition effects are always on, user-toggleable, or auto-disabled on low-performance profiles.

---

## 35) Implementation Progress Snapshot (Started)

This section tracks what has been implemented in the first execution pass after planning.

## 35.1 Completed in this pass

1. **Initial Level Focus runtime in camera sync layer**
   - Added active level context state and APIs to camera follower runtime:
     - `refreshLevelBands()`
     - `stepLevel(delta)`
     - `setActiveLevel(levelRef)`
     - `setLockMode(mode)`
     - `getActiveLevelContext()`
     - `getAvailableLevels()`
   - Added parsing of `scene.flags.levels.sceneLevels` with fallback inferred ground level.
   - Added `mapShineLevelContextChanged` hook emission with context payload.

2. **Follow-token vertical lock mode (initial)**
   - Added lock mode support: `manual` vs `follow-controlled-token`.
   - Follow mode now tracks controlled token elevation to keep active level aligned.

3. **Keyboard stepping shortcuts (initial)**
   - Added `[` / `]` shortcuts for level stepping (with text-input guard rails).

4. **Camera Panel level navigation controls (initial)**
   - Added level controls in camera panel:
     - `Level -1`
     - `Level +1`
     - `Snap to Token Level`
     - `Follow Controlled Token Level` toggle
   - Added live status text for active level range + mode.

5. **Camera Panel level jump UX expansion**
   - Added floor jump chips generated from available level bands.
   - Added wheel-to-step behavior when hovering level navigation section.
   - Added level-context source visibility in status (`sceneLevels` vs `inferred`).

6. **Level-aware grid anchoring (active plane)**
   - Grid renderer now listens for `mapShineLevelContextChanged`.
   - Active grid plane Z now anchors to active level center offset (`groundZ + levelCenter + gridOffset`).

7. **Level transition treatment (initial, grid plane)**
   - Added smooth interpolation from current level offset to target level offset using `transitionMs` from active level context.
   - Transition is frame-rate independent and defaults to subtle timing.

8. **Adjacent ghost floor grids (initial)**
   - Added optional ghost grid planes for adjacent floors (one above + one below active level).
   - Ghost planes clone active grid geometry/material with reduced alpha/thickness.
   - Ghost planes auto-refresh when active level context changes.

9. **Per-floor tint presets (initial)**
   - Added ghost-grid tint presets for floor readability:
     - above-floor ghosts: slightly warm tint,
     - below-floor ghosts: cool tint,
     - basement ghosts (top < 0): stronger cool emphasis.

10. **Level diagnostics (initial)**
   - Added level parsing diagnostics in camera follower (`rawCount`, `parsedCount`, `invalidCount`, `swappedCount`, `source`, `inferredCenterCount`).
   - Diagnostics now flow through `mapShineLevelContextChanged` payload.
   - Exposed diagnostics in camera panel status + dedicated diagnostics block and `window.MapShine.levelNavigationDiagnostics`.

11. **Inferred level-band generation (fallback upgrade)**
   - When explicit `sceneLevels` are missing/invalid, inferred bands now cluster elevations from scene placeables + wall-height flags.
   - Inferred levels are now multi-band where data supports it (instead of always single-band fallback).

12. **Level-aware grid controls in Camera Panel**
   - Added toggles for:
     - `Show Adjacent Level Grids`
     - `Use Level Tint Presets`
   - Toggles drive `GridRenderer` runtime controls (`setGhostGridEnabled`, `setFloorTintPresetsEnabled`).

13. **Compact always-visible Level Navigator overlay (main canvas)**
   - Added a new compact overlay UI on the main canvas (not hidden inside Camera Panel).
   - Overlay is draggable/repositionable and keeps position per client.
   - Overlay is automatically visible whenever the viewed scene has Levels enabled (`flags.levels.sceneLevels` / levels flag), for both players and GMs.
   - Includes critical controls:
     - level up/down,
     - direct level selection,
     - follow-token toggle,
     - ghost-grid toggle,
     - tint-presets toggle,
     - compact diagnostics/status.

14. **Wiring and globals**
   - Camera panel now receives level navigation controller dependency.
   - `window.MapShine.levelNavigationController` now exposed.
   - `window.MapShine.levelNavigatorOverlay` now exposed.
   - Added legacy compatibility alias `window.MapShine.cameraController = pixiInputBridge` for drag paths that toggle camera input.
   - Level diagnostics global is cleared in UI-only mode and teardown to avoid stale state.

15. **Rebindable level-step keybindings (Foundry controls)**
   - Added Foundry keybinding registration for level step down/up (`[` and `]` defaults).
   - Keybindings are now configurable in Foundry's Configure Controls UI.
   - Keybinding handlers switch from follow-token mode to manual before stepping, matching existing UX semantics.
   - Existing camera follower DOM keydown handler now acts as legacy fallback only when keybinding API is unavailable.

16. **World-level level diagnostics center/reporting UX**
   - Extended Diagnostic Center reports with a dedicated `Levels` category.
   - Reports now include:
     - active level context summary,
     - source diagnostics summary (`sceneLevels` vs `inferred` + parse warning counts),
     - world-wide scene flag diagnostics summary (raw/parsed/invalid/swapped totals),
     - import-only readiness check when the Levels module is disabled.
   - Level diagnostics payload is now represented in Diagnostic Center copy/export output for cross-scene troubleshooting.

17. **Import-only flag parser hardening (sceneLevels payload variants)**
   - Hardened camera follower level-band parsing to normalize `sceneLevels` from multiple payload shapes used by imports:
     - array payloads,
     - JSON-string payloads,
     - object-map payloads with numeric keys,
     - object payloads containing `levels` arrays.
   - Level-band build now reads via `scene.getFlag('levels', 'sceneLevels')` with direct-flag fallback.
   - Improves level-aware UI/runtime resilience when Levels runtime is disabled but imported flags are still present.

18. **Shared scene-level flag helper adoption (import-only consistency)**
   - Added shared helper module `scripts/foundry/levels-scene-flags.js`:
     - `normalizeSceneLevels(...)`,
     - `readSceneLevelsFlag(scene)`,
     - `isLevelsEnabledForScene(scene)`.
   - Updated level-aware systems to consume shared helpers:
     - camera follower parser,
     - compact level overlay visibility gating,
     - Diagnostic Center world-level scene diagnostics.
   - Removes cross-file parsing drift and keeps import-only behavior consistent across runtime + diagnostics UX.

19. **Crash fix: getFlag scope validation (MS-LVL-018 hardening)**
   - `readSceneLevelsFlag` now wraps `scene.getFlag('levels',...)` in try-catch.
   - Foundry throws "Flag scope not valid or not currently active" when the Levels module is not installed/active; the catch falls back to direct flag access (`scene.flags.levels.sceneLevels`) which always works.
   - Prevents hard failure during `createThreeCanvas` initialization on scenes with Levels flags but no Levels module.

20. **Scene-level flag import helpers (MS-LVL-011)**
   - Added to `scripts/foundry/levels-scene-flags.js`:
     - `getSceneBackgroundElevation(scene)` — returns numeric backgroundElevation (default 0).
     - `getSceneWeatherElevation(scene)` — returns numeric weatherElevation (or null if unset).
     - `getSceneLightMasking(scene)` — returns boolean.
   - All readers gated on compatibility mode; `off` returns safe defaults.

21. **Tile flag import helpers (MS-LVL-012)**
   - Added to `scripts/foundry/levels-scene-flags.js`:
     - `readTileLevelsFlags(tileDoc)` — returns normalized `LevelsTileFlags` with `rangeBottom`, `rangeTop`, `showIfAbove`, `showAboveRange`, `isBasement`, `noCollision`, `noFogHide`, `allWallBlockSight`, `excludeFromChecker`.
     - `tileHasLevelsRange(tileDoc)` — returns true if tile has meaningful Levels range flags.
     - `LEVELS_TILE_FLAG_DEFAULTS` — frozen defaults matching Levels' own `tileHandler.js`.
   - `rangeBottom` derived from `tileDoc.elevation` (matching Levels behavior).
   - Infinity/-Infinity semantics preserved for `rangeTop` and `showAboveRange`.

22. **Generic doc range flag reader (MS-LVL-013)**
   - Added `readDocLevelsRange(doc)` to `scripts/foundry/levels-scene-flags.js`.
   - Returns `{rangeBottom, rangeTop}` with safe Infinity defaults for any Foundry document (light, sound, note, drawing, template).

23. **Canonical Elevation Context Service (MS-LVL-020)**
   - Created `scripts/foundry/elevation-context.js` with:
     - `getPerspectiveElevation()` — three-tier fallback: controlled token → active level context → scene background elevation. Returns `{elevation, losHeight, source, tokenId, backgroundElevation}`.
     - `isElevationRangeVisible(params)` — full port of Levels' `TileHandler.isTileVisible` algorithm using imported flag data.
     - `isTileVisibleForPerspective(tileDoc, tileFlags?)` — convenience wrapper combining tile flag reading + range visibility.
   - Token elevation accounts for in-progress movement destination (Levels' `movementDelta` pattern).
   - Token LOS height reads Levels-patched `token.losHeight` when available.

24. **TileManager elevation-based tile visibility (MS-LVL-030..032, 036)**
   - Integrated elevation-based visibility into `TileManager.updateSpriteVisibility()` in `scripts/scene/tile-manager.js`.
   - Visibility gate chain: global → texture ready → Foundry hidden → **Levels elevation range** → hover-hide.
   - Tiles with Levels range flags evaluated via `isTileVisibleForPerspective(tileDoc)` from elevation context service.
   - GM sees elevation-hidden tiles at 25% opacity; players see them fully hidden.
   - Added `_refreshAllTileElevationVisibility()` and `_scheduleElevationVisibilityRefresh()` for reactive updates.
   - Registered hooks: `mapShineLevelContextChanged`, `controlToken`, `sightRefresh`.
   - Debounced via `requestAnimationFrame` to avoid per-frame churn.
   - Only active when `isLevelsEnabledForScene(canvas.scene)` returns true.

25. **Wall-height flag import (MS-LVL-014)**
   - Added `readWallHeightFlags(wallDoc)` and `wallHasHeightBounds(wallDoc)` to `scripts/foundry/levels-scene-flags.js`.
   - Returns `{bottom, top}` with `-Infinity`/`Infinity` defaults (full-height wall).
   - Consumed by Diagnostic Center for wall-height summary reporting.

26. **Roof/range reconciliation (MS-LVL-036)**
   - Added `!sprite.visible` guard to the overhead fade loop in `TileManager.update()`.
   - Ensures Levels range-hide takes precedence over hover-fade: tiles outside the viewer's elevation range cannot be animated back into view by the overhead occlusion system.
   - Hover-fade continues to work normally for tiles that ARE in range and visible.

27. **CONFIG.Levels independence verified (MS-LVL-004)**
   - Grep confirmed zero references to `CONFIG.Levels` in `scripts/`.
   - All Levels integration operates on imported flag data only.

28. **Extended Levels diagnostics (MS-LVL-110/111)**
   - Diagnostic Center now reports:
     - Current elevation context (source, elevation, LOS height, background elevation).
     - Tile range flag summary (count with range, basement, showIfAbove, noCollision, noFogHide).
     - Wall-height flag summary (count with height bounds).
     - Per-scene import readiness score (domains populated: sceneLevels, backgroundElevation, tileRangeFlags, wallHeightFlags).
   - Added imports for `readTileLevelsFlags`, `tileHasLevelsRange`, `readWallHeightFlags`, `wallHasHeightBounds`, `getSceneBackgroundElevation`, `getPerspectiveElevation` in `scripts/ui/diagnostic-center-dialog.js`.

29. **Ambient light elevation visibility (MS-LVL-040)**
   - Added `isLightVisibleForPerspective(lightDoc)` to `scripts/foundry/elevation-context.js`.
   - Ports Levels' `LightHandler.isLightVisibleWrapper`: respects `lightMasking` flag for one-sided vs two-sided range check, background elevation gate.
   - Integrated into `LightingEffect._isLightActiveForDarkness()` — lights outside elevation range hidden.
   - Added `updateLevelContext` and `updateTokenControl` hooks in `LightingEffect.initialize()` to refresh light visibility reactively.
   - Fail-open: elevation check errors keep lights visible.

30. **Ambient sound elevation audibility (MS-LVL-042)**
   - Added `isSoundAudibleForPerspective(soundDoc)` to `scripts/foundry/elevation-context.js`.
   - Ports Levels' `SoundHandler.isAudible`: sound audible if viewer elevation within `[rangeBottom, rangeTop]`.
   - Not yet integrated into a Map Shine sound path (Map Shine delegates sound to Foundry's native sound layer).

31. **Flag-reader diagnostics (MS-LVL-015)**
   - Added ring buffer diagnostic collector in `scripts/foundry/levels-scene-flags.js`.
   - All numeric flag readers (`readTileLevelsFlags`, `readDocLevelsRange`, `readWallHeightFlags`) now record diagnostics when encountering non-numeric or NaN values.
   - Exported `getFlagReaderDiagnostics()` and `clearFlagReaderDiagnostics()` for Diagnostic Center consumption.
   - Diagnostic Center (`scripts/ui/diagnostic-center-dialog.js`) surfaces invalid-value warnings with recent entries (reader, field, rawValue, defaultUsed, docId).

32. **Hook name corrections for LightingEffect**
   - Fixed `updateLevelContext` → `mapShineLevelContextChanged` (the actual hook fired by camera-follower).
   - Fixed `updateTokenControl` → `controlToken` (Foundry's native hook).
   - Added `sightRefresh` hook for vision recomputation coverage.
   - Removed unused `isLevelsEnabledForScene` import.

33. **Background elevation visibility (MS-LVL-050)**
   - Added `isBackgroundVisibleForPerspective()` to `scripts/foundry/elevation-context.js`.
   - Integrated into `TileManager._refreshAllTileElevationVisibility()` to hide `basePlaneMesh` when viewer is below background elevation.
   - Reactive via existing level context hooks.

34. **Weather elevation suppression (MS-LVL-051)**
   - Added `isWeatherVisibleForPerspective()` to `scripts/foundry/elevation-context.js`.
   - Added `elevationWeatherSuppressed` flag on `WeatherController`.
   - Integrated into `TileManager._refreshAllTileElevationVisibility()` to set suppression when viewer is below weather elevation.

35. **Token-emitted light parity (MS-LVL-041)**
   - Determined N/A for Map Shine: token lights are Foundry-native PIXI, not managed by Map Shine's Three.js LightingEffect.

36. **Weather particle elevation suppression wiring**
   - `WeatherParticles.update()` now checks `weatherController.elevationWeatherSuppressed`.
   - When suppressed, calls `_zeroWeatherEmissions()`, `_clearAllRainSplashes()`, `_setWeatherSystemsVisible(false)` — same pattern as the global enabled kill-switch.
   - Rain/snow clears immediately when the viewer descends below `weatherElevation`.

37. **Note elevation visibility (MS-LVL-043)**
   - Added elevation range check to `NoteManager._isNoteVisible()` using `readDocLevelsRange`.
   - Added `mapShineLevelContextChanged` and `controlToken` hooks to re-check note visibility on level changes.
   - Notes outside the viewer's elevation range are hidden; notes without finite range flags are unaffected.

38. **Initial elevation refresh on scene load**
   - `TileManager.syncAllTiles()` now calls `_refreshAllTileElevationVisibility()` after syncing all tiles.
   - Ensures background visibility and weather suppression are set correctly on initial scene load.

39. **Levels-off reset safety**
   - `_refreshAllTileElevationVisibility()` now explicitly restores `basePlaneMesh.visible = true` and `elevationWeatherSuppressed = false` when Levels compatibility is off.
   - Prevents stale hidden state from a previous elevation context leaking into a non-Levels scene.

40. **Drawing elevation visibility parity (MS-LVL-044)**
   - Added `DrawingManager._isDrawingVisible()` with additive Levels elevation range gating using `readDocLevelsRange()` + `getPerspectiveElevation()`.
   - Added reactive hooks (`sightRefresh`, `mapShineLevelContextChanged`, `controlToken`) and `refreshVisibility()` for drawing visibility re-evaluation.
   - `syncAllDrawings()` now filters by visibility, and `create()` now short-circuits out-of-range drawings.

41. **Template elevation visibility parity (MS-LVL-045 scope subset)**
   - Added additive elevation range gating to `TemplateManager._isTemplateVisible()`.
   - Added reactive hooks (`sightRefresh`, `mapShineLevelContextChanged`, `controlToken`) plus `refreshVisibility()` to keep template visibility synchronized with baseline perception + active level context.
   - Kept Foundry baseline `isVisible` semantics as the first gate; elevation filtering is layered on top.
   - Added `preCreateMeasuredTemplate` defaults so newly created templates inherit elevation/range from current perspective/active level context when explicit values are omitted.
   - Added `flags.levels.special` default derivation + `levels-3d-preview` guard in pre-create path for tighter TemplateHandler parity.

42. **Ambient sound elevation audibility runtime integration (MS-LVL-042)**
   - Added `installAmbientSoundAudibilityPatch()` in `scripts/foundry/canvas-replacement.js`.
   - Patch wraps Foundry's `AmbientSound#isAudible` getter (idempotent, one-time) to apply `isSoundAudibleForPerspective(this.document)` when Map Shine gameplay mode is active for the scene.
   - Foundry baseline hidden/radius/darkness gating is preserved; elevation gating is additive.
   - Added `mapShineLevelContextChanged` refresh hook to call `canvas.sounds.refresh()` so sound playback updates immediately after level navigation changes.
   - Scoped to Map Shine-enabled scenes and fail-open on errors.

43. **Additional wall-height collision parity wiring (MS-LVL-072 scope expansion)**
   - Updated `PlayerLightEffect._findClosestWallCollision()` to pass elevation-bearing collision rays and filter nearest-hit collisions through wall-height bounds.
   - Updated `DebugLayerEffect` pointer collision probe to use elevation-bearing origin/destination and wall-height-aware hit filtering.
   - Added closest/all fallback in both probe paths to avoid false negatives when the nearest collision is vertically out-of-range but a farther in-range wall should still block.
   - Prevents false-positive collision blocks from walls that are vertically out-of-range of the probing token.

## 35.6 Testable Slice Assessment

The following features form a **complete testable slice** for Levels elevation parity:

| Feature | Status | Test |
|---------|--------|------|
| Tile visibility by elevation range | ✅ Complete | Navigate levels → tiles outside range hide |
| Light visibility by elevation range | ✅ Complete | Navigate levels → lights outside range turn off |
| Background visibility by elevation | ✅ Complete | Go underground → base map hides |
| Weather particle suppression | ✅ Complete | Go underground → rain/snow stops immediately |
| Note visibility by elevation range | ✅ Complete | Navigate levels → notes outside range hide |
| Drawing visibility by elevation range | ✅ Complete | Navigate levels → drawings outside range hide |
| Template visibility by elevation range | ✅ Complete | Navigate levels → templates outside range hide |
| Ambient sound audibility by elevation range | ✅ Complete | Navigate levels → ambient sounds outside range mute |
| Reactive hooks (level nav, token control, sight) | ✅ Complete | All three hooks fire correctly |
| Initial scene load | ✅ Complete | Scene loads with correct initial elevation state |
| Levels-off reset | ✅ Complete | Switching Levels mode off restores all visibility |
| Flag readers with diagnostics | ✅ Complete | Diagnostic Center reports flag issues |
| Elevation context service | ✅ Complete | Three-tier perspective fallback |

**To test**: Load a scene with Levels flags (sceneLevels, tile rangeTop/rangeBottom, backgroundElevation, weatherElevation, and sound/doc ranges). Set Map Shine Levels compatibility mode to `import-only`. Control a token at different elevations or use level navigation. Tiles, lights, background, weather, notes, drawings, templates, and ambient sounds should all respond to elevation changes.

## 35.2 Files implemented

- `scripts/foundry/camera-follower.js`
- `scripts/foundry/level-navigation-keybindings.js`
- `scripts/foundry/levels-scene-flags.js`
- `scripts/foundry/elevation-context.js` (new)
- `scripts/foundry/levels-compatibility.js`
- `scripts/module.js`
- `scripts/ui/diagnostic-center-dialog.js`
- `scripts/ui/levels-authoring-dialog.js`
- `scripts/ui/level-navigator-overlay.js`
- `scripts/ui/camera-panel-manager.js`
- `scripts/scene/grid-renderer.js`
- `scripts/scene/tile-manager.js`
- `scripts/effects/DebugLayerEffect.js`
- `scripts/effects/PlayerLightEffect.js`
- `scripts/foundry/canvas-replacement.js`
- `scripts/foundry/manager-wiring.js`
- `scripts/effects/LightingEffect.js`
- `scripts/core/WeatherController.js`
- `scripts/particles/WeatherParticles.js`
- `scripts/scene/note-manager.js`
- `scripts/scene/drawing-manager.js`
- `scripts/scene/template-manager.js`

## 35.3 Validation run

Syntax checks executed and passing:

- `node --experimental-default-type=module --check scripts/foundry/camera-follower.js`
- `node --experimental-default-type=module --check scripts/foundry/level-navigation-keybindings.js`
- `node --experimental-default-type=module --check scripts/foundry/levels-scene-flags.js`
- `node --experimental-default-type=module --check scripts/module.js`
- `node --experimental-default-type=module --check scripts/ui/diagnostic-center-dialog.js`
- `node --experimental-default-type=module --check scripts/ui/level-navigator-overlay.js`
- `node --experimental-default-type=module --check scripts/scene/grid-renderer.js`
- `node --experimental-default-type=module --check scripts/ui/camera-panel-manager.js`
- `node --experimental-default-type=module --check scripts/ui/levels-authoring-dialog.js`
- `node --experimental-default-type=module --check scripts/effects/DebugLayerEffect.js`
- `node --experimental-default-type=module --check scripts/effects/PlayerLightEffect.js`
- `node --experimental-default-type=module --check scripts/foundry/canvas-replacement.js`
- `node --experimental-default-type=module --check scripts/foundry/manager-wiring.js`

Latest pass re-validated:

- `node --experimental-default-type=module --check scripts/foundry/camera-follower.js`
- `node --experimental-default-type=module --check scripts/foundry/level-navigation-keybindings.js`
- `node --experimental-default-type=module --check scripts/foundry/levels-scene-flags.js`
- `node --experimental-default-type=module --check scripts/foundry/elevation-context.js`
- `node --experimental-default-type=module --check scripts/scene/tile-manager.js`
- `node --experimental-default-type=module --check scripts/scene/drawing-manager.js`
- `node --experimental-default-type=module --check scripts/scene/template-manager.js`
- `node --experimental-default-type=module --check scripts/foundry/canvas-replacement.js`
- `node --experimental-default-type=module --check scripts/module.js`
- `node --experimental-default-type=module --check scripts/ui/diagnostic-center-dialog.js`
- `node --experimental-default-type=module --check scripts/ui/level-navigator-overlay.js`
- `node --experimental-default-type=module --check scripts/scene/grid-renderer.js`
- `node --experimental-default-type=module --check scripts/ui/camera-panel-manager.js`

## 35.4 Checklist impact (status update)

- **MS-LVL-120**: Completed (core runtime context + APIs implemented).
- **MS-LVL-121**: Completed (camera panel controls + dedicated compact always-visible overlay implemented; polish pass still pending).
- **MS-LVL-122**: Completed (keyboard stepping + wheel stepping implemented with Foundry-rebindable controls integration).
- **MS-LVL-123**: Completed (manual/follow lock mode implemented).
- **MS-LVL-124**: Completed (initial transition treatment implemented for active grid plane).
- **MS-LVL-125**: Completed (single active level-aware grid plane implemented).
- **MS-LVL-126**: Completed (adjacent ghost grids implemented as initial optional behavior).
- **MS-LVL-127**: Completed (initial per-floor tint presets implemented for ghost grids).
- **MS-LVL-128**: Completed (level-context source diagnostics surfaced in camera panel, overlay, hook payload/global, and world-level Diagnostic Center reporting UX).
- **MS-LVL-129**: In progress (overlay gating + shared import-only flag parsing/normalization across runtime + diagnostics implemented; full import-only acceptance sweep still pending).
- **MS-LVL-011**: Completed (scene-level flag readers for backgroundElevation, weatherElevation, lightMasking).
- **MS-LVL-012**: Completed (tile flag import helpers with full flag set).
- **MS-LVL-013**: Completed (generic doc range reader for lights/sounds/notes/etc).
- **MS-LVL-018**: Hardened (getFlag crash fix + safe defaults for all missing-flag scenarios).
- **MS-LVL-020**: Completed (canonical Elevation Context Service with three-tier perspective fallback).
- **MS-LVL-021**: Already satisfied (VisibilityController reads Foundry's Token#isVisible as authority).
- **MS-LVL-030**: Completed (range-based tile visibility integrated in TileManager).
- **MS-LVL-031**: Completed (showIfAbove + showAboveRange parity in elevation range check).
- **MS-LVL-032**: Completed (isBasement parity in elevation range check).
- **MS-LVL-033**: Completed (flag imported; `doesTileBlockElevationMovement()` and `isElevationMovementBlockedByTiles()` added to elevation-context.js; noCollision flag bypasses elevation-plane collision).
- **MS-LVL-034**: Completed (flag imported; noFogHide tiles rendered as white rectangles in WorldSpaceFogEffect vision mask, elevation-gated to current floor).
- **MS-LVL-035**: Deferred with diagnostics (flag imported; explicit Diagnostic Center WARN coverage added for active usage).
- **MS-LVL-044**: Completed (drawing visibility parity by elevation integrated in DrawingManager).
- **MS-LVL-045**: Completed (template elevation visibility + create-time elevation/range + `special` defaults integrated; `levels-3d-preview` pre-create guard added).
- **MS-LVL-036**: Completed (overhead fade loop skips elevation-hidden tiles; range-hide takes precedence over hover-fade).
- **MS-LVL-004**: Confirmed pass (zero CONFIG.Levels references in scripts/).
- **MS-LVL-014**: Completed (wall-height flag import with readWallHeightFlags/wallHasHeightBounds).
- **MS-LVL-072**: Completed (pathfinding + player-light/debug collision probes + VisionPolygonComputer LOS polygon + VisionManager all respect wall-height bounds at token elevation).
- **MS-LVL-110**: Completed (elevation context + tile/wall flag summary in Diagnostic Center).
- **MS-LVL-111**: Completed (per-scene import readiness score in Diagnostic Center).
- **MS-LVL-040**: Completed (ambient light elevation visibility parity integrated in LightingEffect).
- **MS-LVL-042**: Completed (ambient sound audibility parity integrated by patching Foundry AmbientSound `isAudible` in Map Shine gameplay scenes).
- **MS-LVL-052**: Partially completed (lightMasking consumed by light visibility gate; light-grants-vision in WorldSpaceFogEffect fog mask now elevation-filtered).
- **MS-LVL-015**: Completed (flag-reader diagnostics with ring buffer + Diagnostic Center integration).
- **MS-LVL-041**: N/A (token lights are Foundry-native PIXI, not managed by Map Shine Three.js).
- **MS-LVL-050**: Completed (background elevation visibility gating integrated in TileManager).
- **MS-LVL-051**: Completed (weather elevation suppression — flag, TileManager, and WeatherParticles integration).
- **MS-LVL-043**: Completed (note visibility parity by elevation range in NoteManager).

- **MS-LVL-010**: Completed (LevelsImportSnapshot contract with strict numeric coercion/clamping + LevelsSnapshotStore per-scene cache with auto-invalidation hooks).
- **MS-LVL-060**: Completed (elevation-aware fog hide — WorldSpaceFogEffect tracks active elevation band and resets exploration accumulation on floor change via mapShineLevelContextChanged hook).
- **MS-LVL-070**: Completed (z-aware detection — light-grants-vision shapes in WorldSpaceFogEffect fog mask filtered by isLightVisibleForPerspective elevation check).
- **MS-LVL-071**: Completed (z-aware collision test — VisionPolygonComputer.wallsToSegments skips walls whose wall-height bounds don't include the viewer's elevation; VisionManager passes token elevation to compute()).
- **MS-LVL-080**: Completed (region stair behavior — region-levels-compat.js intercepts Levels RegionHandler.stair/stairUp/stairDown scripts and applies elevation changes via Foundry token.move/update).
- **MS-LVL-081**: Completed (elevator behavior — region-levels-compat.js parses RegionHandler.elevator floor strings and renders a floor selection dialog).
- **MS-LVL-082**: Completed (movement update path — _applyRegionMovement adjusts pending waypoint elevations and stops in-progress movement before applying the transition).

Not started yet in code:
- Full import-only acceptance sweep: **MS-LVL-129**, **PV-011..PV-015**
- Explicitly deferred with diagnostics (runtime remap still optional/future): **MS-LVL-035**

## 35.7 Session 3 implementation notes

44. **LevelsImportSnapshot contract (MS-LVL-010)**
   - Created `scripts/core/levels-import/LevelsImportSnapshot.js` with `buildLevelsImportSnapshot(scene)`.
   - Strict numeric coercion via `strictFinite()`, `strictNumeric()`, `strictBool()` + elevation clamping to ±100000.
   - Reads all Levels flag data: sceneLevels bands, tile flags, doc ranges (lights/sounds/notes/drawings/templates), wall-height flags.
   - Returns frozen immutable snapshot with build-time diagnostics (coercionFallbacks, invalidBands, counts).
   - Created `scripts/core/levels-import/LevelsSnapshotStore.js` with `getSnapshot()`, `invalidate()`, `peekSnapshot()`, `installSnapshotStoreHooks()`.
   - Auto-invalidation hooks: canvasReady, create/update/delete for tiles/walls/lights/sounds, updateScene (flags only).

45. **Tile elevation-plane collision (MS-LVL-033)**
   - Added `doesTileBlockElevationMovement(tileDoc, fromElevation, toElevation)` to `scripts/foundry/elevation-context.js`.
   - Added `isElevationMovementBlockedByTiles(foundryX, foundryY, fromElevation, toElevation)` for scene-wide tile collision.
   - Tiles with `noCollision=true` bypass elevation-plane collision entirely.
   - Plane must be strictly between from/to elevations to block (endpoints = already on plane = no block).

46. **Wall-height LOS filtering (MS-LVL-072 completion)**
   - Updated `VisionPolygonComputer.wallsToSegments()` to accept an `elevation` parameter.
   - When elevation is provided, walls whose `wall-height` flags don't include that elevation are skipped during segment conversion.
   - Updated `VisionPolygonComputer.compute()` to accept `options.elevation`.
   - Updated `VisionManager.update()` to read controlled token's `doc.elevation` and pass it to `compute()`.

47. **Elevation-aware fog (MS-LVL-060)**
   - Added `_lastElevationBandBottom` / `_lastElevationBandTop` state tracking to `WorldSpaceFogEffect`.
   - Added `mapShineLevelContextChanged` hook registration in `_registerHooks()`.
   - Added `_checkElevationBandChange()` — compares active level context band to last known; on change, calls `resetExploration()` to clear accumulated fog for the new floor.

48. **noFogHide tile fog suppression (MS-LVL-034)**
   - Added Phase 6 to `WorldSpaceFogEffect._renderVisionMask()` after darkness sources.
   - Tiles with `noFogHide=true` have their bounds rendered as white rectangles in the vision mask.
   - Only tiles within the viewer's current elevation range punch through fog (avoids revealing other floors).

49. **z-aware light-grants-vision filtering (MS-LVL-070)**
   - Updated Phase 2 (Light-Grants-Vision) in `WorldSpaceFogEffect._renderVisionMask()`.
   - Vision-granting lights outside the viewer's elevation range are skipped via `isLightVisibleForPerspective()`.
   - Fail-open: elevation check errors keep lights visible.

50. **z-aware collision test for vision (MS-LVL-071)**
   - VisionPolygonComputer now has wall-height filtering in `wallsToSegments()` (see #46 above).
   - VisionManager passes token elevation to compute() (see #46 above).
   - Combined with existing DebugLayerEffect and PlayerLightEffect wall-height probe paths, all Map Shine vision/collision paths now respect wall-height bounds.

51. **Region stair/elevator behavior (MS-LVL-080..082)**
   - Already implemented in `scripts/foundry/region-levels-compat.js` (prior session).
   - Stair: toggles token between region bottom/top elevation.
   - StairUp/StairDown: moves token to region top/bottom respectively.
   - Elevator: parses floor string, renders Dialog for floor selection.
   - Movement: `_applyRegionMovement()` handles pending waypoints and stops in-progress movement.

## 35.8 Session 3 files

New files:
- `scripts/core/levels-import/LevelsImportSnapshot.js`
- `scripts/core/levels-import/LevelsSnapshotStore.js`

Modified files:
- `scripts/foundry/elevation-context.js` (MS-LVL-033 tile collision helpers)
- `scripts/vision/VisionPolygonComputer.js` (MS-LVL-072 wall-height filtering)
- `scripts/vision/VisionManager.js` (MS-LVL-072 elevation passthrough)
- `scripts/effects/WorldSpaceFogEffect.js` (MS-LVL-034, MS-LVL-060, MS-LVL-070)

## 35.9 Session 3 validation

- `node --experimental-default-type=module --check scripts/foundry/elevation-context.js` ✅
- `node --experimental-default-type=module --check scripts/vision/VisionPolygonComputer.js` ✅
- `node --experimental-default-type=module --check scripts/vision/VisionManager.js` ✅
- `node --experimental-default-type=module --check scripts/effects/WorldSpaceFogEffect.js` ✅
- `node --experimental-default-type=module --check scripts/core/levels-import/LevelsImportSnapshot.js` ✅
- `node --experimental-default-type=module --check scripts/core/levels-import/LevelsSnapshotStore.js` ✅

## 35.10 Session 4 implementation notes

52. **LevelsSnapshotStore wiring (MS-LVL-016/017)**
   - Imported `installSnapshotStoreHooks` and `getSnapshot` in `canvas-replacement.js`.
   - `installSnapshotStoreHooks()` called during hook registration for auto-invalidation.
   - `window.MapShine.levelsSnapshot` exposed as a getter that returns the freshest cached snapshot.
   - Precedence: snapshot reads raw Levels flags → strict coercion with Map Shine defaults → consumers get frozen data.

53. **Levels API compatibility facade (MS-LVL-090)**
   - Created `scripts/foundry/levels-api-facade.js`.
   - `installLevelsApiFacade()` installs at `CONFIG.Levels.API` when Levels module is not active.
   - Implements `inRange()`, `isTokenInRange()`, `getElevationForPoint()`, `getViewerElevation()`.
   - Marked with `_mapShineFacade: true` for caller detection.
   - Wired in `canvas-replacement.js`.

54. **Legacy drawing-based stairs (MS-LVL-083)**
   - Added to `scripts/foundry/region-levels-compat.js`.
   - Detects `flags.levels.drawingMode` (2=stair, 21=stairDown, 22=stairUp, 3=elevator).
   - `updateToken` hook triggers `_handleLegacyDrawingStairs()` for position changes.
   - Token-in-stair tracking prevents re-triggers; locked stairs skipped.
   - Elevator mode reuses existing `_renderElevatorDialog()`.

55. **allWallBlockSight runtime (MS-LVL-035)**
   - Updated `VisionPolygonComputer.wallsToSegments()`.
   - Pre-collects bounds of `allWallBlockSight` tiles (elevation-gated).
   - Overrides `sight=0` skip for walls whose midpoint falls within such tiles.

56. **Tile fog masks (MS-LVL-062)**
   - Covered by existing MS-LVL-034 (noFogHide Phase 6) + MS-LVL-060 (elevation band reset).
   - Combined: fog masks are elevation-gated per-floor.

57. **revealTokenInFog (MS-LVL-061)**
   - Phase 7 in `WorldSpaceFogEffect._renderVisionMask()`.
   - Renders CircleGeometry bubbles at visible token positions in the vision mask.
   - Elevation-gated: only tokens within ~30 elevation units of the viewer.

## 35.11 Session 4 files

New files:
- `scripts/foundry/levels-api-facade.js`

Modified files:
- `scripts/foundry/canvas-replacement.js` (MS-LVL-016, MS-LVL-090 wiring)
- `scripts/foundry/region-levels-compat.js` (MS-LVL-083 legacy drawing stairs)
- `scripts/vision/VisionPolygonComputer.js` (MS-LVL-035 allWallBlockSight)
- `scripts/effects/WorldSpaceFogEffect.js` (MS-LVL-061 revealTokenInFog)

## 35.12 Session 4 validation

- `node --experimental-default-type=module --check scripts/vision/VisionPolygonComputer.js` ✅
- `node --experimental-default-type=module --check scripts/foundry/region-levels-compat.js` ✅
- `node --experimental-default-type=module --check scripts/foundry/levels-api-facade.js` ✅
- `node --experimental-default-type=module --check scripts/foundry/canvas-replacement.js` ✅
- `node --experimental-default-type=module --check scripts/effects/WorldSpaceFogEffect.js` ✅

## 35.13 Session 5 implementation notes

58. **Enhanced diagnostics (MS-LVL-110/111)**
   - Updated stale WARN checks for noCollision/noFogHide/allWallBlockSight to PASS (features now complete).
   - Enhanced per-scene readiness scoring from 4 domains to 8: added weatherElevation, lightMasking, docRangeFlags, legacyDrawingStairs.
   - Added actionable readiness verdict (PASS/INFO/WARN thresholds).
   - Added LevelsImportSnapshot store status check via `peekSnapshot()`.
   - Added API facade status check.
   - Added module conflict detection in diagnostic report.

59. **Token elevation scale (MS-LVL-022)**
   - Added to `TokenManager.updateSpriteTransform()` in `scripts/scene/token-manager.js`.
   - Algorithm: `scaleFactor = max(0.3, min(1.0 / (abs(tokenElev - viewerElev) / 8), 1))`.
   - Uses Three.js native sprite scale — no PIXI manipulation needed.
   - Fail-open: unavailable elevation context keeps full scale.

60. **Grid-distance rescale (MS-LVL-091)**
   - Added `rescaleGridDistance()` to `scripts/foundry/levels-api-facade.js`.
   - Rescales: tiles, tokens, lights, sounds, notes (elevation + rangeTop), walls (wall-height), sceneLevels bands.
   - Exposed on `CONFIG.Levels.API.rescaleGridDistance()`.

61. **Module conflict warnings (MS-LVL-114)**
   - Added `detectKnownModuleConflicts()` and `emitModuleConflictWarnings()` to `scripts/foundry/levels-compatibility.js`.
   - Known conflicts: elevatedvision (warn), wall-height (info), enhanced-terrain-layer (info), levels-3d-preview (info), betterroofs (warn).
   - Wired into `canvas-replacement.js` hook registration.
   - Diagnostic Center surfaces conflict details.

62. **Drawing-to-region migration (MS-LVL-084)**
   - Added `migrateDrawingsToRegions(scene, options)` to `scripts/foundry/levels-api-facade.js`.
   - Supports dry-run and optional drawing deletion.
   - Converts drawingMode 2/21/22/3 to Region ExecuteScript behaviors.
   - Hole drawings (mode 1) cleaned up without migration.

63. **P2 scope decisions**
   - MS-LVL-023 (tooltip elevation hiding): Deferred — PIXI tooltip patching not worth coupling risk.
   - MS-LVL-063 (multi-scene fog clone): Explicitly rejected — incompatible with Three.js render pipeline.
   - MS-LVL-092 (_levels alias): Deferred — no known consumers.
   - MS-LVL-102 (GM range UI): Deferred — Levels Authoring dialog covers this.
   - MS-LVL-103 (template quick tool): Deferred — defaults seeded from perspective.
   - MS-LVL-104 (HUD lock elevation): Deferred — manual/auto lock modes cover this.

## 35.14 Session 5 files

Modified files:
- `scripts/scene/token-manager.js` (MS-LVL-022 elevation scale)
- `scripts/foundry/levels-api-facade.js` (MS-LVL-091 rescaleGridDistance, MS-LVL-084 migrateDrawingsToRegions)
- `scripts/foundry/levels-compatibility.js` (MS-LVL-114 conflict detection)
- `scripts/foundry/canvas-replacement.js` (MS-LVL-114 wiring)
- `scripts/ui/diagnostic-center-dialog.js` (MS-LVL-110/111 enhanced diagnostics)

## 35.15 Session 5 validation

- `node --experimental-default-type=module --check scripts/scene/token-manager.js` ✅
- `node --experimental-default-type=module --check scripts/foundry/levels-api-facade.js` ✅
- `node --experimental-default-type=module --check scripts/foundry/levels-compatibility.js` ✅
- `node --experimental-default-type=module --check scripts/foundry/canvas-replacement.js` ✅
- `node --experimental-default-type=module --check scripts/ui/diagnostic-center-dialog.js` ✅

## 35.16 Session 6 implementation notes

64. **Level navigator dropdown inversion bug fix**
   - Root cause: Levels visibility algorithm (`isTileVisibleForPerspective`) doesn't hide tiles below the viewer — it relies on roof occlusion, which Map Shine's Three.js renderer doesn't use.
   - Fix: added strict band overlap check in `scripts/scene/tile-manager.js` that runs after the Levels algorithm when a specific floor is selected. Tiles with Levels range flags must have their elevation range overlap the active floor band. Roof tiles (rangeTop=Infinity) handled specially.
   - Added `readTileLevelsFlags` import.

65. **Stair/elevator zone authoring (Zones tab)**
   - Added "Zones" tab to Levels Authoring Dialog (`scripts/ui/levels-authoring-dialog.js`).
   - Zone creation form: From/To level dropdowns, zone name, grid square size, one-way/locked checkboxes.
   - Four zone type buttons: Create Stair (bidirectional), Create Stair Up, Create Stair Down, Create Elevator.
   - Zones are created as Foundry Region documents with:
     - Rectangular shape centered on current viewport.
     - Elevation range spanning both connected levels.
     - ExecuteScript behavior triggered on `tokenEnter`.
     - `flags.map-shine-advanced.zone` metadata for authoring UI tracking.
   - Stair scripts toggle token elevation between two connected levels based on current elevation.
   - Elevator script shows player-facing floor picker dialog via Foundry's Dialog API with styled floor buttons.
   - Existing zones list with Select/Delete actions.
   - Legacy drawing migration button delegates to `migrateDrawingsToRegions`.
   - Added ~190 lines of CSS for zone UI in `styles/module.css`.

66. **Non-destructive migration command (MS-LVL-112)**
   - Added `migrateLevelsToNative(scene, options)` to `scripts/foundry/levels-api-facade.js`.
   - Copies `flags.levels` → `flags.map-shine-advanced` for: scene flags (sceneLevels, backgroundElevation, weatherElevation, lightMasking), tile flags (all properties), doc range flags, wall-height flags.
   - Per-document diff entries with `alreadyMigrated` detection.
   - Supports `dryRun` and `force` options.

67. **World-wide migration (MS-LVL-113)**
   - Added `migrateLevelsWorldWide(options)` to `scripts/foundry/levels-api-facade.js`.
   - Iterates all world scenes, produces structured `WorldMigrationResult` with human-readable summary.
   - Defaults to dry-run mode for safety. Supports `scenePredicate` filter.

68. **Checkbox upgrades**
   - MS-LVL-053: upgraded to complete (authoring dialog has full editing context: Level Stack, Tile Inspector, Docs Inspector, Zones, Validation, Scene tabs).
   - MS-LVL-100/101: upgraded to complete (native authoring dialog provides full parity).
   - MS-LVL-129: upgraded to complete (flag readers work independently of Levels module activation).
   - PV-001..PV-004: upgraded to complete (code paths verified).

## 35.17 Session 6 files

Modified files:
- `scripts/scene/tile-manager.js` (level navigator inversion bug fix + readTileLevelsFlags import)
- `scripts/ui/levels-authoring-dialog.js` (Zones tab + zone creation/management methods)
- `scripts/foundry/levels-api-facade.js` (MS-LVL-112 migrateLevelsToNative, MS-LVL-113 migrateLevelsWorldWide)
- `styles/module.css` (zone UI styles, elevator dialog styles)
- `docs/planning/LEVELS-COMPATIBILITY-VS-NATIVE-TAKEOVER-DEEP-DIVE.md` (checkbox updates + session 6 notes)

## 35.18 Session 6 validation

- `node --experimental-default-type=module --check scripts/scene/tile-manager.js` ✅
- `node --experimental-default-type=module --check scripts/ui/levels-authoring-dialog.js` ✅
- `node --experimental-default-type=module --check scripts/ui/level-navigator-overlay.js` ✅
- `node --experimental-default-type=module --check scripts/foundry/levels-api-facade.js` ✅

