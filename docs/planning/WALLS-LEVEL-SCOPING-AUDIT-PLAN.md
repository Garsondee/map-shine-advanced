# Walls Level-Scoping Audit and Remediation Plan

## Objective
Make wall/door/window behavior strictly floor-scoped and robust:
- Creation: walls authored on current floor only.
- Movement: walls from other floors do not block.
- Vision: walls from other floors do not occlude.
- Compatibility: works with `othermodules/levels` while keeping Map Shine runtime ownership coherent.

---

## Audit Scope (completed)
Reviewed wall-related creation, visibility, movement, and vision paths across:
- `scripts/scene/interaction-manager.js`
- `scripts/scene/wall-manager.js`
- `scripts/scene/token-movement-manager.js`
- `scripts/foundry/levels-create-defaults.js`
- `scripts/foundry/levels-scene-flags.js`
- `scripts/foundry/elevation-context.js`
- `scripts/effects/WorldSpaceFogEffect.js`
- `scripts/vision/FoundryFogBridge.js`
- `scripts/foundry/canvas-replacement.js`
- `othermodules/levels/scripts/ui.js`
- `othermodules/levels/scripts/main.js`
- `othermodules/levels/scripts/handlers/sightHandler.js`

---

## Current Runtime Architecture (wall-relevant)

### 1) Wall authoring path
- Wall drawing commit goes through `createEmbeddedDocuments('Wall', [data])` in InteractionManager.
- `getWallData(...)` seeds defaults via `applyWallLevelDefaults(...)`.
- `preCreateWall` in WallManager also seeds missing `flags['wall-height']`.

Refs:
- `scripts/scene/interaction-manager.js` (wall creation call)
- `scripts/scene/wall-manager.js` (`preCreateWall` seeding)
- `scripts/foundry/levels-create-defaults.js`

### 2) Movement collision path
- Token movement planner uses `CONFIG.Canvas.polygonBackends.move.testCollision(...)` and post-filters collisions against wall-height bounds.
- Collision elevation now resolves via `getPerspectiveElevation()`.

Ref:
- `scripts/scene/token-movement-manager.js`

### 3) Vision path actually in use
- Runtime uses Foundry vision/fog textures via `FoundryFogBridge` (`canvas.masks.vision.renderTexture`) and not the custom `VisionManager` path.
- `canvas-replacement` explicitly notes legacy vision manager is no longer used.

Refs:
- `scripts/vision/FoundryFogBridge.js`
- `scripts/foundry/canvas-replacement.js`

### 4) Levels module perspective path
- Levels UI floor selection sets `WallHeight.currentTokenElevation` and fires `levelsUiChangeLevel`.
- Levels module also tracks `CONFIG.Levels.currentToken` via `controlToken` hook.

Refs:
- `othermodules/levels/scripts/ui.js`
- `othermodules/levels/scripts/main.js`

---

## Findings

## Critical Finding A: Perspective source split (primary issue)
Map Shine wall logic (movement/door checks/wall editor filtering) uses `getPerspectiveElevation()` from `elevation-context`, but Foundry vision texture (used by fog) follows Foundry/Levels runtime perspective state.

There is no explicit bridge syncing:
- Map Shine active level context (`window.MapShine.activeLevelContext`)
- Levels UI range (`CONFIG.Levels.UI.range`)
- Levels runtime perspective (`WallHeight.currentTokenElevation`, `CONFIG.Levels.currentToken`)

Result: movement and vision can evaluate different floors at the same time.

## Critical Finding B: Vision path mismatch and dead/unused logic
Custom `VisionManager`/`VisionPolygonComputer` has wall-height filtering code, but runtime fog/visibility uses Foundry textures via `FoundryFogBridge`.

This means fixes in custom vision code do not necessarily affect visible in-game vision behavior.

## High Finding C: Wall default seeding still has edge-band risks
`getFiniteActiveLevelBand()` requires finite top/bottom. Any active band represented with non-finite values (e.g., `Infinity` top floor) can fail wall default seeding and create full-height walls.

## High Finding D: No post-create wall integrity enforcement
If wall creation bypasses expected defaults or a preCreate ordering issue occurs, there is no automatic repair pass to ensure new walls in multi-level scenes have wall-height bounds.

## Medium Finding E: Fallback movement path can bypass authored planner behavior
InteractionManager has raw token update fallback routes (`updateEmbeddedDocuments`) for degraded cases. If planner fails, movement behavior may defer to Foundry constraints without guaranteed floor-scoped parity diagnostics.

## Medium Finding F: Runtime ownership is ambiguous in import-only mode
`levels-compatibility` warns about active Levels runtime wrappers but mostly enforces fog manager only. Collision/vision wrappers remain likely active, creating mixed ownership.

---

## Root-Cause Hypothesis (most likely)
The remaining bug is not one single wall-height parser issue; it is a **cross-pipeline floor-context desynchronization**:
1. Wall data may be authored correctly in many cases.
2. Movement may use one elevation context.
3. Vision mask generation (from Foundry textures) may use a different elevation context.
4. In mixed Levels/Map Shine runtime states, wrappers and context sources can diverge.

---

## Remediation Plan (phased)

## Phase 1 — Single Source of Truth for active floor perspective (P0)
Create `levels-perspective-bridge` to unify floor context across systems.

### Deliverables
1. **Authoritative floor resolver** (new helper):
   - Resolve active floor from, in order:
     1) explicit Map Shine manual level context,
     2) Levels UI range when enabled,
     3) controlled token elevation,
     4) background fallback.
2. **Bidirectional sync hooks**:
   - Map Shine -> Levels: on `mapShineLevelContextChanged`, update `WallHeight.currentTokenElevation` (and optional `CONFIG.Levels.currentToken` compatibility handling).
   - Levels -> Map Shine: on `levelsUiChangeLevel` / `levelsPerspectiveChanged`, update Map Shine active level context (or trigger equivalent camera-follower level selection).
3. Replace direct floor lookups with resolver in:
   - movement collision elevation,
   - door wall elevation checks,
   - wall editor visibility filters,
   - any fog/vision floor filters that currently use divergent sources.

### Acceptance
- When changing floor from either Map Shine or Levels UI, movement and vision both switch floor behavior immediately and identically.

---

## Phase 2 — Wall data integrity hardening (P0)
Guarantee every newly created wall in multi-level context gets deterministic vertical bounds.

### Deliverables
1. Extend wall default band handling to support non-finite tops safely for authoring (e.g. upper floor represented as open-ended).
2. Add **post-create guard**:
   - On `createWall`, if scene is multi-level and wall has missing `wall-height`, patch it using active band and log warning.
3. Add lightweight diagnostic counter/logging:
   - walls created with bounds
   - walls auto-patched
   - walls missing bounds after patch attempt

### Acceptance
- New walls always have explicit expected bounds in wall document flags under all authoring paths.

---

## Phase 3 — Movement parity and fallback hardening (P1)
Ensure floor-scoped movement remains correct even under degraded planner/fallback paths.

### Deliverables
1. Instrument planner success/fallback frequency in InteractionManager and TokenMovementManager.
2. Ensure fallback movement path applies same elevation-aware wall filtering semantics where possible.
3. Add test/debug command to print nearest blocking wall bounds and collision elevation for failed moves.

### Acceptance
- No cross-floor false blocks in normal planner path or fallback path.

---

## Phase 4 — Vision pipeline ownership decision (P1)
Choose and enforce one authoritative vision path for wall-floor filtering.

### Option A (near-term stability)
Keep Foundry vision texture extraction path, but fully sync floor perspective into Levels/Foundry runtime state.

### Option B (long-term Map Shine ownership)
Re-enable/finish Map Shine-owned vision polygon path and retire dependency on Foundry runtime LOS for fog masking.

### Deliverables
- Decision record + implementation gating.
- Remove or deprecate dead/unused vision paths to avoid “fixing inactive code”.

### Acceptance
- Floor-specific wall occlusion in vision remains correct regardless of UI source.

---

## Validation Matrix (must pass)
1. Author wall on floor A, verify absent on floor B (movement + vision).
2. Author door/window on floor A, verify interaction only on floor A.
3. Switch floors via Map Shine UI, verify immediate movement/vision parity.
4. Switch floors via Levels UI, verify immediate movement/vision parity.
5. Controlled token on different floor from viewed floor (manual mode), verify behavior follows chosen authoritative policy.
6. Scene with no explicit sceneLevels but inferred levels, verify robust defaults.
7. Upper open-ended band (`Infinity` top) authoring behavior.
8. Planner failure/fallback path still floor-correct.

---

## Recommended Execution Order
1. Phase 1 (Perspective bridge)
2. Phase 2 (Wall integrity guard)
3. Phase 3 (Movement fallback parity)
4. Phase 4 (Vision ownership consolidation)

This order addresses the likely root cause first (context desync), then hardens data integrity, then closes fallback paths.
