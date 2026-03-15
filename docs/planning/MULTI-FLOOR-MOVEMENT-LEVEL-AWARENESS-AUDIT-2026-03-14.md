# Multi-Floor Movement + Level-Awareness Audit — 2026-03-14

## Purpose

Deep audit of token pathfinding + movement execution + keyboard movement with a strict focus on **level-aware wall collision** in Levels-enabled scenes.

Primary bug context: preview may appear valid, but execution/keyboard still gets blocked by walls below token floor.

---

## Scope

This document covers:

1. Pathfinding preview flow (single + group)
2. Token movement execution flow (single + group + step updates)
3. Keyboard movement flow (`preUpdateToken` guard path)
4. Foundry payload / constrain options propagation
5. Levels-facing systems (active level context, perspective elevation, wall-height readers, synchronization bridge)
6. Cross-system interaction graph and potential mismatch points

---

## System Inventory (Movement + Levels)

### A) User Interaction Entry Points

- `scripts/scene/interaction-manager.js`
  - Right-click move preview + confirm: `_handleRightClickMovePreview`
  - Execute single/group move from preview confirmation: `_executeTokenMoveToTopLeft`, `_executeTokenGroupMoveToTopLeft`
  - Drag-preview path checks in drag mode
  - Drag commit updates (`executeDoorAwareTokenMove` / `executeDoorAwareGroupMove` and fallback `updateEmbeddedDocuments` path)
  - Keyboard nudge updates with `mapShineMovement.constrainOptions`

### B) Core Movement / Collision Engine

- `scripts/scene/token-movement-manager.js`
  - Segment collision: `_validatePathSegmentCollision`
  - Elevation resolver: `_resolveCollisionElevation`
  - Wall-hit height filtering: `_collisionResultBlocksAtElevation`, `_collisionVertexBlocksAtElevation`
  - Path truncation guard: `_validatePathWallIntegrity`
  - Main constrained path pipeline: `_computeConstrainedPathWithDirectAndEscalation`
  - Preview path APIs: `computeTokenPathPreview`, `computeDoorAwareGroupMovePreview`
  - Execution APIs: `executeDoorAwareTokenMove`, `executeDoorAwareGroupMove`, `runDoorAwareMovementSequence`
  - Keyboard hard guard: hook `preUpdateToken` -> `_guardKeyboardTokenUpdate` -> `_validateMoveStepTarget`
  - Foundry movement payload builder + floor bounds transport: `_buildTokenMoveUpdateOptions`, `_getFoundryConstrainOptions`

### C) Levels / Elevation Context

- `scripts/foundry/levels-scene-flags.js`
  - Wall height reader: `readWallHeightFlags` with wall-height + Levels fallback (`rangeBottom`/`rangeTop`)
- `scripts/foundry/elevation-context.js`
  - Canonical perspective resolver: `getPerspectiveElevation`
- `scripts/foundry/levels-perspective-bridge.js`
  - Bidirectional sync between MapShine floor context and Levels runtime perspective (`WallHeight.currentTokenElevation`, `levelsUiChangeLevel`, `levelsPerspectiveChanged`)
- `scripts/foundry/camera-follower.js`
  - Emits `mapShineLevelContextChanged`, writes `window.MapShine.activeLevelContext`
- `scripts/scene/level-interaction-service.js`
  - Level membership + `switchToLevelForElevation`

---

## Interaction Graph (How systems connect)

## 1) Right-click Preview -> Confirm -> Execute

1. `InteractionManager._handleRightClickMovePreview`
   - Computes destination top-left
   - Reads `window.MapShine.activeLevelContext`
   - Sends `destinationFloorBottom/top` into preview options
2. `TokenMovementManager.computeTokenPathPreview` / `computeDoorAwareGroupMovePreview`
   - Plans path via constrained path pipeline
   - Collision tests use `_validatePathSegmentCollision`
3. Confirm click executes via `_executeTokenMoveToTopLeft` / `_executeTokenGroupMoveToTopLeft`
   - Calls `executeDoorAwareTokenMove` / `executeDoorAwareGroupMove`
   - Floor bounds must match preview context
4. Sequenced step writes use `_buildTokenMoveUpdateOptions`
   - Optionally include Foundry movement payload + constrain options

Risk point: any missing `destinationFloorBottom/top` propagation in steps 3 or 4 causes preview/execution divergence.

## 2) Drag Move Flow

1. Drag preview path call in `interaction-manager`
2. Drag commit:
   - Preferred: door-aware sequencer paths
   - Fallback: direct `updateEmbeddedDocuments` movement payload
3. Both paths must carry floor bounds in constrain options when constrained

Risk point: fallback payload without floor bounds allows Foundry-side checks to evaluate wrong level.

## 3) Keyboard Flow

1. Keyboard handler issues `tokenDoc.update({x,y}, updateOptions)` with method `keyboard`
2. `preUpdateToken` hook in `TokenMovementManager` runs `_guardKeyboardTokenUpdate`
3. Guard extracts constrain options from `mapShineMovement` or `movement[tokenId]`
4. Guard runs `_validateMoveStepTarget` -> `_validatePathSegmentCollision`

Risk point: if keyboard update options omit floor bounds, guard evaluates with fallback elevation context.

## 4) Level Context Sync

1. `CameraFollower` sets active level and emits `mapShineLevelContextChanged`
2. Global listeners refresh visibility, walls, tiles, etc.
3. `LevelsPerspectiveBridge` pushes floor elevation into `WallHeight.currentTokenElevation`
4. `getPerspectiveElevation` can resolve from manual active-level or controlled token, depending on lock mode

Risk point: if lock mode / source precedence differs from movement assumptions, collision elevation source can drift.

---

## Level-Awareness Audit Matrix

| Subsystem | Guard/Decision | Level-aware inputs | Status |
|---|---|---|---|
| Path segment collision | `_validatePathSegmentCollision` | `collisionElevation`, `destinationFloorBottom/top`, wall-height bounds | Aware |
| Collision elevation selection | `_resolveCollisionElevation` | explicit collision elevation -> destination floor bounds -> perspective -> token doc | Aware |
| Wall-height filtering | `_collisionVertexBlocksAtElevation` | `readWallHeightFlags`, half-open `[bottom, top)` | Aware |
| Path post-validation | `_validatePathWallIntegrity` | forwards destination floor bounds + collision elevation | Aware |
| Keyboard blocking guard | `_guardKeyboardTokenUpdate` | parses constrain options and forwards floor bounds | Aware |
| Keyboard step check | `_validateMoveStepTarget` | forwards floor bounds into segment collision | Aware |
| Foundry movement payload | `_buildTokenMoveUpdateOptions` + `_getFoundryConstrainOptions` | writes destination floor bounds into movement constrain options | Aware |
| Right-click preview | `_handleRightClickMovePreview` | passes active level floor bounds to preview APIs | Aware |
| Right-click execution | `_executeTokenMoveToTopLeft`, `_executeTokenGroupMoveToTopLeft` | passes active level floor bounds into execute options | Aware |
| Drag preview | drag preview callsite | active level floor bounds now passed | Aware |
| Drag execution (sequencer) | group/single execute options | active level floor bounds now passed | Aware |
| Drag execution fallback | direct update payload constrain options | floor bounds now passed | Aware |
| Levels wall-height source | `readWallHeightFlags` | wall-height or Levels flags | Aware |
| Perspective source service | `getPerspectiveElevation` | controlled-token / active-level / background with manual lock precedence | Aware |
| MapShine <-> Levels bridge | `LevelsPerspectiveBridge` | syncs floor context to WallHeight and UI range | Aware |

---

## Critical Cross-System Couplings

## Coupling A: Active level context -> movement options

- Every interaction entrypoint must source floor bounds from `window.MapShine.activeLevelContext`.
- Missing this at *any* path branch means collision can revert to token elevation or perspective fallback.

## Coupling B: Movement options -> Foundry payload

- Sequenced updates can include movement payload and constrain options.
- If floor bounds are not serialized into constrain options, downstream Foundry logic may evaluate wrong floor.

## Coupling C: Perspective service -> collision fallback

- `_resolveCollisionElevation` falls back to `getPerspectiveElevation` when explicit floor bounds are absent.
- This is safe only if `getPerspectiveElevation` and active movement floor are aligned.

## Coupling D: Levels runtime perspective

- `LevelsPerspectiveBridge` keeps `WallHeight.currentTokenElevation` aligned with MapShine level context.
- If bridge is inactive/desynced, other Levels-owned systems can disagree with movement decisions.

---

## High-Risk Mismatch Zones (Still Under Investigation)

1. **Preview/execute parity timing differences**
   - Preview may use immediate Foundry parity, execution can await async parity.
   - Need runtime correlation logs from both phases for same request key.

2. **Per-step execution-time path recomputation/validation branches**
   - Confirm there is no hidden execution-only wall test using stale origin/elevation on intermediate steps.

3. **Group move planning vs execution floor context drift**
   - Confirm cached group plans and retry plans preserve identical floor bounds across preview and execute.

4. **External module/Foundry internal movement handling**
   - If another hook mutates token updates or movement payloads post-build, floor bounds may be dropped.

---

## Deep Dive: Token-vs-Wall Blocking Across Different Levels

This section models exactly when a wall should/should not block movement in multi-level scenes.

## 1) Blocking decision model (effective algorithm)

For each candidate movement segment (`from` -> `to`):

1. Resolve collision elevation (`_resolveCollisionElevation`)
   - Priority:
     1) `options.collisionElevation`
     2) `options.destinationFloorBottom/top`
     3) perspective elevation (`getPerspectiveElevation`) in specific cases
     4) token document elevation
2. Run Foundry move collision (`moveBackend.testCollision`) with that ray elevation
3. For each hit, read wall vertical bounds (`readWallHeightFlags`)
4. Treat wall as blocking only if: `wallBottom <= collisionElevation && collisionElevation < wallTop`
   - Half-open top boundary prevents seam false positives

Interpretation: walls only block movement at elevations where the wall has vertical occupancy.

## 2) Why seam handling matters

Current wall overlap test uses `[bottom, top)`.

Meaning for common floor bands:
- Ground band: `0-10`
- First floor band: `10-20`

Then:
- Wall `0-10` blocks elevations `>=0 and <10`
- Token at elevation `10` is **not** blocked by that wall

So if blocking still happens at seam elevation, the likely problem is no longer inclusive boundary math; it is usually context propagation (wrong collision elevation used at some branch).

## 3) Case study table: expected blocking behavior

| Case | Token collision elevation | Wall bounds | Expected |
|---|---:|---:|---|
| A. Lower floor wall, upper floor token | 10 | 0-10 | **Not blocked** |
| B. Upper floor wall, lower floor token | 5 | 10-20 | **Not blocked** |
| C. Same-floor wall overlap | 15 | 10-20 | **Blocked** |
| D. Infinite-height wall | 15 | -Inf..Inf | **Blocked** |
| E. Missing wall flags default | 15 | -Inf..Inf (default) | **Blocked** |
| F. Token exactly at wall top seam | 20 | 10-20 | **Not blocked** |
| G. Token exactly at wall bottom | 10 | 10-20 | **Blocked** |

Notes:
- Case E is critical in imported/malformed scenes: if wall-height flags are absent or unreadable, wall defaults to full-height blocker.
- Case G is intentional and matches half-open interval semantics.

## 4) Branch-by-branch level-awareness (token movement)

## Right-click single/group

- Preview and execute both source floor bounds from `window.MapShine.activeLevelContext`.
- Group preview/execute also pass floor bounds through options.
- Remaining risk: any internal replan branch that is invoked without the caller-provided floor bounds.

## Drag move

- Drag preview now passes floor bounds.
- Drag sequencer execution path now passes floor bounds.
- Drag fallback movement payload now includes `constrainOptions.destinationFloorBottom/top`.
- Remaining risk: external hook mutates fallback payload before `preUpdateToken` sees it.

## Keyboard

- Keyboard update sends `mapShineMovement.constrainOptions.destinationFloorBottom/top`.
- `preUpdateToken` guard parses both `mapShineMovement.constrainOptions` and `movement[tokenId].constrainOptions`.
- Guard path validates target via `_validateMoveStepTarget` using parsed floor bounds.
- Remaining risk: options are missing for some keyboard source (e.g., non-MapShine emitter).

## 5) Cross-floor route execution cases

Cross-floor execution (`_executeCrossFloorRouteSegments`) has two segment types:

1. `portal-transition`
   - Directly updates token position + elevation to target floor (`toFloor.bottom + 1`)
2. `walk`
   - Recomputes constrained path for that floor segment
   - Injects segment floor bounds into path compute and sequence options

Important behavior: after portal transition, selected token view is optionally switched to destination floor (`switchToLevelForElevation`) to keep perspective context aligned.

Potential mismatch case to validate:
- Portal transition succeeds and token elevation changes, but an immediate subsequent walk step uses stale caller options without segment floor bounds.
- Current code appears to override with segment floor bounds for walk path/sequence, but runtime tracing should verify this per segment.

## 6) Floor key / destination floor inference implications

Destination floor key resolution order:
1. explicit destination floor bounds
2. active level bounds
3. token elevation-derived floor key

Implication:
- If explicit bounds are absent and active level context is stale/wrong, path planning can classify route on wrong floor band.
- This affects cross-floor diagnostics and portal-route availability checks (even when raw wall-height filtering logic is correct).

## 7) Additional edge cases to test explicitly

1. **Upper-floor token, lower-floor wall, no wall-height flags**
   - Should block (full-height default) — confirms data quality issue vs logic issue.
2. **Wall with inverted flags (`top < bottom`)**
   - Reader swaps values; verify no accidental bypass/block.
3. **One-way walls with elevation mismatch**
   - Ensure direction + elevation both required to block.
4. **Large token footprint near seam**
   - Corner rays may hit different walls than center ray; ensure all rays use same collision elevation.
5. **Endpoint probe pass for 1x1**
   - Confirm probe-only collisions still respect wall height filtering.
6. **Fallback collision API path (`tokenObj.checkCollision`)**
   - Rare path when polygon backend unavailable; verify elevation propagation still holds.
7. **Manual lock mode vs controlled-token perspective mode**
   - Ensure movement branch and Levels bridge evaluate same effective floor when user manually changes floor.

## 8) Data-quality and integration factors (non-code-path causes)

Even with correct movement logic, cross-level blocking can still occur when:

- Wall documents lack valid finite bounds and default to full-height
- Levels flags are partially migrated (range fields inconsistent)
- Another module writes/overwrites movement options without floor bounds
- Levels runtime perspective (`WallHeight.currentTokenElevation`) desyncs from active floor context due to lifecycle timing

This means debugging must capture both decision logic and input data quality for each blocking hit.

---

## Research Tasks (Next Pass)

## Task 1 — Add cross-phase correlation IDs

Instrument preview/execute/step with a shared move correlation key containing:
- token id
- start top-left
- end top-left
- floor bounds
- resolved collision elevation

Goal: prove whether preview and execution are evaluating identical elevation context.

## Task 2 — Capture every collision decision that returns blocking

At `_validatePathSegmentCollision` blocking return points, log:
- reason
- from/to
- collisionElevation
- destinationFloorBottom/top
- wall hit ids + wall bounds for blocking wall

Goal: identify exactly which wall is still considered blocking and why.

## Task 3 — Validate hook chain integrity for keyboard and drag fallback

Trace update options entering `preUpdateToken` and verify constrain options survive unchanged.

Goal: catch any mutation/drop between interaction layer and guard.

## Task 4 — Confirm Levels bridge lifecycle per scene init/dispose

Verify `LevelsPerspectiveBridge` always initialized when scene is active and disposed on teardown.

Goal: eliminate desync periods where perspective source diverges from active level context.

---

## Initial Conclusions

- The core collision math is now level-aware (explicit floor bounds + wall-height filtering + seam-safe half-open intervals).
- Current failure signature likely comes from a **remaining branch-level context mismatch** (preview/execution/hook payload path divergence), not from the wall overlap formula itself.
- The audit should now shift from static propagation checks to **correlated runtime tracing** across one move request from preview -> execution -> step commit.

---

## Multi-Floor-First Rearchitecture Proposal

This section defines how to redesign movement systems so multi-floor behavior is first-class, not a propagated optional field.

## Design Goals

1. **Single source of floor truth** for every movement request
2. **Single collision contract** used by preview, execution, keyboard, and fallback
3. **No branch-specific floor guessing** once a move starts
4. **Deterministic preview/execute parity** from the same movement context object
5. **Module interoperability safety** when Foundry/Levels hooks mutate options

## Proposed Core Abstraction: `MovementContext`

Introduce a canonical immutable context object created at input time and passed through all movement stages.

Suggested shape:

```ts
type MovementContext = {
  id: string; // correlation id
  tokenId: string;
  source: 'right-click' | 'drag' | 'keyboard' | 'api' | 'group';
  floor: {
    mode: 'explicit' | 'active-level' | 'token-elevation';
    bottom: number;
    top: number;
    collisionElevation: number;
    floorKey: string;
  };
  collision: {
    ignoreWalls: boolean;
    ignoreCost: boolean;
    collisionMode: 'closest' | 'all';
  };
  foundry: {
    method: 'keyboard' | 'dragging' | 'api' | 'undo' | 'config' | 'paste';
    includeMovementPayload: boolean;
  };
};
```

Important rule: once `MovementContext` is created for a move, all pathfinding and execution must use that context directly.

## Proposed Architectural Split

### 1) `FloorContextResolver` (new service)

Responsibility:
- Build `MovementContext.floor` from explicit bounds, active context, token elevation
- Resolve floor key and collision elevation once
- Emit diagnostics when fallback modes are used

Outcome:
- Eliminates repeated floor/elevation resolution in many callsites

### 2) `CollisionPolicyEngine` (new service)

Responsibility:
- Own all wall-block checks using `MovementContext.floor.collisionElevation`
- Wrap Foundry backend hit parsing + wall-height overlap logic
- Return structured blocking detail (`wallId`, bounds, hit kind, segment)

Outcome:
- Preview and execution consume same policy implementation
- Debug output is standardized and always includes wall/floor context

### 3) `MovementPlanner` (refactor of constrained path flow)

Responsibility:
- Compute path candidates using `MovementContext`
- Perform parity/retry logic
- Produce immutable `PlannedRoute` with floor metadata per segment

Outcome:
- Preview and execute can share the same planned route artifact
- Reduces timing/parity divergence

### 4) `MovementExecutor` (refactor of token/group sequence runners)

Responsibility:
- Execute `PlannedRoute` without recomputing floor assumptions
- Serialize update payloads from `MovementContext`
- Enforce "no replan unless explicit" policy

Outcome:
- Mid-route behavior matches validated plan

### 5) `MovementHookBridge` (new guard adapter)

Responsibility:
- Validate incoming `preUpdateToken` options
- Reconstruct `MovementContext` from payload if needed
- Reject or repair updates missing required floor context in constrained mode

Outcome:
- Hardens against option mutation/drops by external hooks

## Preview/Execute Parity Redesign

Current weakness: preview and execution can run separate planning variants.

Proposed change:
1. Preview returns a `PlannedRoute` + `MovementContext` snapshot (cache key + hash)
2. Execute consumes that exact route/context when available
3. If replan is required, emit reason and context diff (`floor changed`, `door state changed`, etc.)

This makes parity mismatch explicit and debuggable.

## Multi-Floor Route Model Upgrade

Represent movement as explicit typed segments:

```ts
type RouteSegment =
  | { type: 'walk'; floorKey: string; floorBottom: number; floorTop: number; pathNodes: Point[] }
  | { type: 'portal-transition'; fromFloorKey: string; toFloorKey: string; portalId: string; target: Point };
```

Rules:
- Every `walk` segment must carry floor bounds
- Executor must reject `walk` segments missing bounds
- Floor switching side-effects happen only at `portal-transition` boundaries

## Data Contract Hardening

## A) Required fields in constrained movement

When `ignoreWalls=false`, movement payloads should require:
- `destinationFloorBottom`
- `destinationFloorTop`

If absent:
- either fail closed with clear reason, or
- fill via `FloorContextResolver` and mark context as fallback-derived

## B) Wall data quality policy

Add diagnostics tiers:
- `finite-bounds` (good)
- `infinite-default` (risky)
- `invalid-bounds` (error)

Track scene-level counts so false “cross-floor block” reports can be mapped to data quality.

## C) Levels sync health policy

Expose a small health object:
- `activeLevelContext`
- `getPerspectiveElevation()` result
- `WallHeight.currentTokenElevation`
- `lastBridgeSyncAt`

Warn if these diverge beyond tolerance during movement.

## Migration Plan (Low-Risk)

### Phase 1 — Contract introduction (no behavior change)

- Add `MovementContext` creation and logging
- Keep existing logic, but route all calls through context adapter

### Phase 2 — Collision engine extraction

- Move collision + wall filtering into `CollisionPolicyEngine`
- Keep same behavior; prove parity with golden logs

### Phase 3 — Planner/executor separation

- Output `PlannedRoute` artifact from preview/planner
- Execute from artifact; reduce execution-time replans

### Phase 4 — Hook bridge hardening

- Enforce required constrained movement fields
- Add warning/failure behavior for malformed external updates

### Phase 5 — Strict multi-floor mode

- Optional setting: reject constrained movement without explicit floor bounds
- Use for high-integrity multi-floor campaigns

## Regression Strategy for Rearchitecture

Build a fixed scenario matrix and require parity for each:

1. Same-floor wall block
2. Lower-floor wall non-block at seam
3. Upper-floor wall non-block from below
4. Portal transition + immediate walk
5. Keyboard constrained step on upper floor
6. Drag fallback payload path
7. Group movement with mixed start elevations

For each case, assert:
- preview decision
- execute decision
- final token position
- blocking wall metadata (if blocked)
- movement context hash unchanged between preview and execute (unless explicit replan)

## Architecture Decision Summary

The key redesign move is to stop treating floor data as optional ad hoc options and instead treat it as a required first-class context that is created once and consumed everywhere.

That single shift prevents most cross-level false blocking classes by design.

---

## Related Files to Keep Open During Next Debug Session

- `scripts/scene/interaction-manager.js`
- `scripts/scene/token-movement-manager.js`
- `scripts/foundry/elevation-context.js`
- `scripts/foundry/levels-scene-flags.js`
- `scripts/foundry/levels-perspective-bridge.js`
- `scripts/foundry/camera-follower.js`
- `scripts/scene/level-interaction-service.js`

---

## Concrete Implementation Plan (Execution Backlog)

This is the implementation-ready plan for the rearchitecture, sequenced to minimize risk and keep behavior stable during migration.

## Phase 0 — Baseline instrumentation (1-2 days)

### Goal
Establish hard evidence for preview/execute/keyboard divergence before structural refactors.

### Changes

1. Add move correlation id + context logging
   - File: `scripts/scene/token-movement-manager.js`
   - Add helper: `_createMovementCorrelationContext(...)`
   - Thread correlation id through:
     - `computeTokenPathPreview`
     - `executeDoorAwareTokenMove`
     - `_computeConstrainedPathWithDirectAndEscalation`
     - `_validatePathSegmentCollision`

2. Add blocking-wall structured diagnostics
   - File: `scripts/scene/token-movement-manager.js`
   - At each blocking return in `_validatePathSegmentCollision`, log:
     - correlation id
     - segment from/to
     - collisionElevation
     - destinationFloorBottom/top
     - blocking wall ids + wall bottom/top

3. Hook-chain visibility for keyboard and fallback payloads
   - Files:
     - `scripts/scene/interaction-manager.js`
     - `scripts/scene/token-movement-manager.js`
   - Log outbound constrain options and inbound parsed constrain options in `_resolveIncomingConstrainOptions`.

### Acceptance criteria
- Single move attempt can be traced end-to-end by one correlation id.
- Every collision block log includes wall id + bounds + elevation context.

---

## Phase 1 — Introduce canonical `MovementContext` (2-3 days)

### Goal
Create one immutable context object used by all movement entrypoints.

### Changes

1. Add `FloorContextResolver` utility module
   - New file: `scripts/scene/movement/floor-context-resolver.js`
   - Responsibilities:
     - resolve floor bottom/top source
     - resolve collision elevation
     - resolve floor key

2. Add `buildMovementContext(...)` factory
   - New file: `scripts/scene/movement/movement-context.js`
   - Called from:
     - right-click preview/execute
     - drag preview/execute
     - keyboard update path

3. Adapt interaction entrypoints to pass context, not loose options
   - File: `scripts/scene/interaction-manager.js`

### Acceptance criteria
- All movement entrypoints create and pass a `MovementContext`.
- No constrained path call is made without explicit floor bounds in context.

---

## Phase 2 — Extract collision policy engine (2-3 days)

### Goal
Single collision decision implementation for all paths.

### Changes

1. Create `CollisionPolicyEngine`
   - New file: `scripts/scene/movement/collision-policy-engine.js`
   - Move logic from:
     - `_validatePathSegmentCollision`
     - `_collisionResultBlocksAtElevation`
     - `_collisionVertexBlocksAtElevation`

2. Keep `TokenMovementManager` as orchestrator
   - File: `scripts/scene/token-movement-manager.js`
   - Replace direct collision internals with engine calls.

3. Return structured block details
   - Standard result shape: `{ ok, reason, blockDetail }`

### Acceptance criteria
- Preview, execute, keyboard all use engine output.
- Collision behavior parity with pre-refactor baseline logs (except intended fixes).

---

## Phase 3 — Planner/Executor split + parity artifact (3-4 days)

### Goal
Ensure preview and execute consume the same planned route when unchanged.

### Changes

1. Introduce `MovementPlanner`
   - New file: `scripts/scene/movement/movement-planner.js`
   - Wrap `_computeConstrainedPathWithDirectAndEscalation` and group planning paths.

2. Introduce `MovementExecutor`
   - New file: `scripts/scene/movement/movement-executor.js`
   - Wrap:
     - `runDoorAwareMovementSequence`
     - `_moveTokenToFoundryPoint`
     - group timeline execution

3. Add `PlannedRoute` artifact
   - Preview stores route + context hash.
   - Execute reuses route if context hash + topology revision unchanged.

### Acceptance criteria
- Confirm-click execute reports `routeSource: preview-artifact` for unchanged context.
- Replan path emits explicit diff reason (`door-revision-changed`, `floor-context-changed`, etc.).

---

## Phase 4 — Hook bridge hardening (1-2 days)

### Goal
Protect movement contract from option mutation by external hooks/modules.

### Changes

1. Add `MovementHookBridge`
   - New file: `scripts/scene/movement/movement-hook-bridge.js`
   - Integrate with `preUpdateToken` handling.

2. Validate constrained movement payload requirements
   - Require floor bounds when `ignoreWalls=false`.
   - If missing: repair from resolver (soft mode) or reject (strict mode).

3. Add strict-mode setting
   - Files:
     - `scripts/scene/scene-settings.js` (or existing settings registrar)
     - optional UI control panel mapping
   - Setting: `strictMultiFloorMovementContext`

### Acceptance criteria
- Missing floor bounds no longer silently pass in constrained mode.
- Warnings include token id + source branch + repair/reject action.

---

## Phase 5 — Levels sync health + data quality guardrails (1-2 days)

### Goal
Prevent hidden desync/data issues from masquerading as collision bugs.

### Changes

1. Add movement-time Levels sync snapshot
   - Files:
     - `scripts/foundry/levels-perspective-bridge.js`
     - `scripts/foundry/elevation-context.js`
   - Compare:
     - active level context
     - perspective elevation source
     - `WallHeight.currentTokenElevation`

2. Add wall-data quality summary in diagnostics
   - Files:
     - `scripts/foundry/levels-scene-flags.js`
     - `scripts/ui/diagnostic-center-dialog.js`
   - Report counts:
     - finite bounds
     - infinite defaults
     - invalid bounds

### Acceptance criteria
- Diagnostics clearly distinguish logic mismatch from data-quality issues.
- Sync divergence warnings include timestamp and movement correlation id.

---

## Testing and Rollout Gates

## Gate A (end Phase 0)
- Reproduce failing case with full correlation logs.
- Verify at least one captured blocking wall record for the failure.

## Gate B (end Phase 2)
- Collision regression pass on 7-case matrix:
  1. same-floor block
  2. lower-floor non-block
  3. upper-floor non-block
  4. seam top non-block
  5. seam bottom block
  6. keyboard constrained step
  7. drag fallback constrained payload

## Gate C (end Phase 3)
- Preview and execute route parity verified in unchanged contexts.
- Replan reason emitted and correct in changed contexts.

## Gate D (end Phase 5)
- Strict mode tested with expected reject behavior.
- Diagnostics panel shows sync/data quality status with no false criticals in healthy scenes.

---

## Suggested Delivery Sequence (PR slices)

1. PR-1: Phase 0 instrumentation only
2. PR-2: Phase 1 context foundation
3. PR-3: Phase 2 collision engine extraction
4. PR-4: Phase 3 planner/executor and planned-route artifact
5. PR-5: Phase 4 hook bridge + strict mode
6. PR-6: Phase 5 diagnostics and sync health

Each PR should include before/after log samples from the same reproducible scene.
