# Token Movement Reliability Investigation (Drag + RMB Click-to-Move)

## Scope

Investigate why a user can see cases where:
- Drag-drop token movement does not execute
- RMB click-to-move does not execute
- Potential concern: pathfinding becomes stale if walls are added/edited mid-session

This document focuses on the current source behavior, concrete edge cases, and guardrails.

---

## Key Finding: Does adding walls mid-session break pathfinding?

### What is already guarded (good)

Pathfinding topology cache invalidation is wired to wall document lifecycle hooks:
- `updateWall`, `createWall`, `deleteWall` all call `_markPathfindingTopologyDirty(...)` in `TokenMovementManager`.
- That invalidates door/HPA/nav caches and schedules prewarm.

Relevant code:
- `scripts/scene/token-movement-manager.js` (`_setupHooks`) 
- `scripts/scene/token-movement-manager.js` (`_markPathfindingTopologyDirty`)

Effects of `_markPathfindingTopologyDirty`:
- increments `_doorStateRevision`
- clears `_doorSpatialIndex`, `_hpaSectorIndex`, `_hpaAdjacencyCache`, `_sceneNavGraphCache`
- schedules prewarm

Also, group preview cache reuse is signature-protected by `doorStateRevision`:
- stale preview plans are rejected if wall topology changed since preview.

Relevant code:
- `scripts/scene/token-movement-manager.js` (`_buildGroupPlanSignature`, `_consumeGroupPlanCacheEntry`)

### Mid-sequence guard (good, but abrupt UX)

Door-aware plan execution includes a `doorRevision` check:
- if topology changed after plan build, sequencer returns `door-revision-mismatch`.

Relevant code:
- `scripts/scene/token-movement-manager.js` (`buildDoorAwarePlan`, `runDoorStateMachineForPlan`)

### Remaining gap

If topology changes while a move is in-flight, behavior is safe-but-silent:
- move can abort (e.g., `door-revision-mismatch`)
- caller often logs warning only; user may see "nothing happened"

So: **it is unlikely to corrupt long-term pathfinding**, but it can still look broken to users in that moment.

---

## End-to-end movement paths analyzed

## 1) Drag-drop movement path

Flow:
1. `InteractionManager.onPointerDown` selects token and starts drag preview
2. `onPointerMove` updates ghost preview and optional path preview
3. `onPointerUp` computes final top-left target(s), then:
   - prefers `TokenMovementManager.executeDoorAwareGroupMove` / `executeDoorAwareTokenMove`
   - falls back to `updateEmbeddedDocuments` in limited cases

Relevant code:
- `scripts/scene/interaction-manager.js` (`onPointerDown`, `onPointerMove`, `onPointerUp`)
- `scripts/scene/interaction-manager.js` (drag commit block around tokenUpdates)
- `scripts/scene/token-movement-manager.js` (`executeDoorAwareTokenMove`, `executeDoorAwareGroupMove`)

## 2) RMB click-to-move path

Flow:
1. Empty-space RMB with selected token(s) arms `moveClickState`
2. Pointer-up executes `_handleRightClickMovePreview`
3. Depending on setting:
   - immediate mode: executes on first click
   - default mode: first click only previews/arms; second click on same tile+selection confirms

Relevant code:
- `scripts/scene/interaction-manager.js` (`_getClickToMoveButton`, `_armMoveClickState`, `onPointerUp`, `_handleRightClickMovePreview`)
- `scripts/settings/scene-settings.js` (`rightClickMoveImmediate`, default `false`)

---

## High-confidence causes for "drag and RMB both not working"

## A) RMB requires second click by default (expected but non-obvious)

`rightClickMoveImmediate` defaults to `false`, so first click only previews.
This is very easy for users to interpret as failure.

Relevant code:
- `scripts/settings/scene-settings.js` (`rightClickMoveImmediate` default)
- `scripts/scene/interaction-manager.js` (`_handleRightClickMovePreview` confirm logic)

## B) Click-to-move is canceled by minor pointer drift (>10 px)

`moveClickState` cancels if pointer move exceeds `threshold: 10` before pointer-up.
If user starts panning unintentionally or has shaky drag, move is canceled.

Relevant code:
- `scripts/scene/interaction-manager.js` (`moveClickState.threshold`, `onPointerMove` cancellation)

## C) InputRouter gating blocks interaction when not in token-select context

`onPointerDown` can return early when InputRouter says PIXI owns input, unless specific token-layer override conditions pass.
Wrong layer/tool state can look like movement is broken.

Relevant code:
- `scripts/scene/interaction-manager.js` (`onPointerDown` InputRouter checks)

## D) Constrained movement failure returns only logs, no user-facing notice

When pathfinding/sequencer fails (`no-path`, `door-revision-mismatch`, etc.), many call sites warn in logs only.
No toast/message means user perceives "it didn’t work" with no explanation.

Relevant code:
- `scripts/scene/interaction-manager.js` (`_executeTokenMoveToTopLeft`, `_executeTokenGroupMoveToTopLeft`, `_handleRightClickMovePreview`)
- `scripts/scene/token-movement-manager.js` (reason-coded failures)

## E) Topology changed during move => `door-revision-mismatch`

Safe behavior, but currently likely perceived as a random failed move.

Relevant code:
- `scripts/scene/token-movement-manager.js` (`runDoorStateMachineForPlan`)

## F) Permission-based hard stop

If token is not modifiable by user, movement is blocked immediately.

Relevant code:
- `scripts/scene/interaction-manager.js` (`tokenDoc.canUserModify(..., "update")`)

---

## Additional edge cases (medium confidence)

1. **Selection/key mismatch during 2-click RMB confirm**
   - second click must match same tile + same token selection key
   - if selection changed between clicks, command won’t execute

2. **No selected token for empty-space click-to-move**
   - empty-space RMB path depends on a selected/controlled token

3. **Strict fog/wall constraints can intentionally produce no-path**
   - this is correct behavior, but again not surfaced to user

4. **In-flight search not explicitly canceled on topology dirty**
   - `_markPathfindingTopologyDirty` updates revision/caches, but does not call `cancelActivePathSearches()`
   - can allow one stale search result window under heavy load

Relevant code:
- `scripts/scene/token-movement-manager.js` (`cancelActivePathSearches` exists but not used from topology-dirty path)

---

## Recommended guardrails (prioritized)

## P0 (user-facing clarity)

1. **Surface move failure reasons via notifications**
   - Add user-facing toasts for primary failure reasons:
     - `no-path`
     - `door-revision-mismatch`
     - `token-update-failed`
     - `group-plan-failed`
   - Include actionable copy (e.g., "Path blocked by walls/doors" / "Scene topology changed; retry")

2. **RMB confirmation UX hint**
   - On first click when not immediate mode, show explicit toast:
     - "Path preview set. Click same destination again to move."

## P1 (stability)

3. **Cancel active path searches when topology changes**
   - Call `cancelActivePathSearches()` inside `_markPathfindingTopologyDirty`.
   - Prevent stale in-flight expansions after live wall edits.

4. **Auto-retry once on `door-revision-mismatch`**
   - Replan immediately with fresh revision and retry once before surfacing failure.

## P2 (diagnostics/QA)

5. **Track last movement failure reason in runtime diagnostics**
   - Add a small diagnostic state object exposed in `window.MapShine` for support triage.

6. **Optional client setting for click-drift threshold**
   - Allow 10px default, but configurable for users with shaky input devices.

---

## Suggested QA matrix

1. **Wall added while token is idle**
   - Move token through newly blocked lane => expect no-path + user message

2. **Wall added while token is actively path-walking**
   - Expect graceful stop/replan (or single retry), and user-visible reason

3. **RMB mode = immediate OFF (default)**
   - First click should always provide explicit confirmation prompt

4. **RMB mode = immediate ON**
   - First click should execute without second click

5. **Pointer drift > threshold**
   - Verify cancellation reason is visible to user (not only console)

6. **InputRouter in PIXI mode / wrong active tool**
   - Verify user receives guidance instead of silent no-op

---

## Summary

Adding walls mid-session is **mostly handled correctly** from a cache invalidation standpoint. The bigger problem is UX resilience:
- valid guard behavior can still abort/reject movement
- failures are usually log-only
- users interpret this as "drag/RMB is broken"

Primary fix direction: **surface explicit failure reasons + add one-step retry/replan on topology revision mismatch + improve RMB first-click feedback**.
