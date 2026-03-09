# Tile Mode Parity Investigation

## Objective
Restore full Foundry parity for Tile Mode in gameplay/hybrid rendering:
- Select tile
- Move/drag tile
- Open tile config/HUD
- Delete selected tile

Scope includes both ground and overhead workflows while keeping Three.js as visual owner.

---

## Current Failure
Switching to **Tiles** controls does not allow selection, move, edit, or delete.

---

## Foundry Baseline (Parity Target)
Foundry tile editing is driven by PIXI Placeables workflows:
- `TilesLayer` controls and create/select behavior
- `Tile` placeable drag/resize handlers
- `PlaceablesLayer._onDeleteKey` delete path

Reference files:
- `foundryvttsourcecode/resources/app/client/canvas/layers/tiles.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/placeables/tile.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/base/placeables-layer.mjs`

---

## Map Shine Control-Flow Audit

### A) New path (ControlsIntegration + InputRouter)
- `InputRouter.determineMode()` now routes Tiles -> PIXI.
- `ControlsIntegration` attempts to keep tiles interactive in tile context.

### B) Legacy arbitration path (still active in runtime)
`canvas-replacement.js` still runs legacy arbitration helpers:
- `updateLayerVisibility()`
- `updateInputMode()`
- `_enforceGameplayPixiSuppression()`
- `_reconcileInputArbitrationState()`

These can override controls-integration state during settles and tool changes.

---

## Root-Cause Hypotheses (from code)
1. Legacy `updateLayerVisibility()` hard-hides `canvas.tiles` in gameplay, including tile tool context.
2. Legacy `updateInputMode()` does not include Tiles in `editLayers`, so PIXI may be forced non-interactive.
3. `_enforceGameplayPixiSuppression()` can still hide/disable PIXI if `InputRouter` is temporarily unavailable, even when tile control is active.

Any one of these can zero out native Foundry tile interactions.

---

## Fix Strategy (Minimal-Risk)
1. Patch legacy arbitration to explicitly recognize Tile Mode as a PIXI-edit mode.
2. In legacy `updateLayerVisibility()`, keep `canvas.tiles` visible+interactive while tile mode is active.
3. In legacy `updateInputMode()`, include tiles in edit-layer routing.
4. In `_enforceGameplayPixiSuppression()`, add a fallback editor-overlay decision when InputRouter is not yet available but active control/layer is tile edit context.

---

## Validation Checklist
In Tile controls:
1. Click tile selects.
2. Drag tile moves.
3. Double click opens tile config.
4. Delete/Backspace removes selected tile.
5. Foreground toggle still allows expected overhead/ground editing behavior.

Console checks:
- No repeated arbitration flip-flops between PIXI and THREE while tiles control is active.
- No forced `canvas.tiles.visible=false` when tile controls are active.

---

## Notes
Once baseline parity is stable, reintroduce strict per-level edit filtering in a guarded phase with runtime checks and diagnostics.

---

## Iteration Log

### Iteration 1 — Legacy arbitration parity patch
Changes applied:
- Added Tiles handling to legacy `updateLayerVisibility()` / `updateInputMode()` paths.
- Added tile-context fallback in `_enforceGameplayPixiSuppression()` when InputRouter is missing/stale.
- Reasserted PIXI and board pointer ownership for tile context.

Observed result:
- Pointer/hit alignment improved (tile under cursor is identified correctly).
- Functional actions still failing: no select, no drag-move, no double-click tile config.

### Iteration 2 — Stronger tile-context ownership
Changes applied:
- Forced tile edit context to always count as PIXI-owned in suppression path.
- Explicitly re-enabled `canvas.tiles` and tile placeable interactivity in suppression editor branch.

Observed result:
- Still no native tile selection/dialog actions.

### Iteration 3 — New hypothesis (current)
Hypothesis:
- `canvas.primary.visible = false` is still being enforced in gameplay/V2 suppression during tile editing.
- In Foundry v12, tile rendering/interaction chain depends on Primary container visibility.
- Result: cursor targeting may still appear correct from Three.js, but native PIXI tile events never fully execute.

Planned fix:
1. In tile edit context, keep `canvas.primary.visible = true`.
2. Preserve tile visual suppression via per-tile alpha (do not re-enable full PIXI visuals).
3. Keep this scoped only to tile editing context; gameplay default remains primary hidden.

Applied:
- `canvas-replacement.js` now keeps `canvas.primary.visible = true` in tile edit context within both:
  - `_enforceGameplayPixiSuppression()` editor-overlay branch (V2 path)
  - `updateLayerVisibility()` when active layer is Tiles
- `controls-integration.js::_updateTilesVisualState()` now also forces `canvas.primary.visible = true` while tiles are active.

Expected effect:
- Restore Foundry native tile interaction chain (select/drag/double-click HUD) while retaining Three.js visual ownership via low tile alpha.

### Iteration 4 — Outcome + new hypothesis
Observed result:
- No change: cursor/hit behavior improves, but tile actions still fail (no select/move/config dialog).

New hypothesis:
- Tile layer ownership visuals are now mostly correct, but Foundry `TilesLayer` activation/event mode is still not fully restored in runtime.
- During control/tool transitions, layer activation may remain stale and placeables may not be in an event-accepting mode.

Planned fix:
1. In tile context, explicitly activate `canvas.tiles` when it is not the active layer.
2. Explicitly restore PIXI event handling mode for `canvas.tiles` and tile placeables.
3. Keep existing visual suppression (low alpha) to preserve Three.js visual ownership.

Applied:
- `controls-integration.js::_updateTilesVisualState()` now:
  - re-activates `canvas.tiles` when tile context is active and activeLayer is stale
  - forces `eventMode='static'` on `canvas.tiles`
  - forces `eventMode='static'` on each tile placeable

Validation:
- `node --experimental-default-type=module --check scripts/foundry/controls-integration.js` passed.

### Iteration 5 — Outcome + new hypothesis
Observed result:
- Still not fixed: no tile select/drag/double-click actions.
- No new click logs observed during tile attempts.

New hypothesis:
- `LayerVisibilityManager` still treats `primary`/`tiles` as always-replaced and can hide them during control churn.
- Our tile state code may be over-forcing interaction flags (`interactive`, `eventMode`) in ways that diverge from Foundry's own activation lifecycle.

Planned fix:
1. In `LayerVisibilityManager.update()`, preserve `primary` and `tiles` visibility while tile context is active.
2. In tile visual state update, keep only minimal required state (activate layer, visible/renderable, alpha suppression) and let Foundry own detailed interactivity/event mode.

Applied:
- `layer-visibility-manager.js::update()` now preserves `primary` + `tiles` visibility in tiles context (instead of always hiding them as replaced layers).
- `controls-integration.js::_updateTilesVisualState()` removed forced `interactive`, `interactiveChildren`, and `eventMode` assignments for tiles and placeables.
- Tile state now remains minimal: ensure tiles context activation + visibility + alpha suppression.

Validation:
- Pending syntax check + runtime verification.

### Iteration 8 — Router mismatch hardening + explicit tile diagnostics
Observed issue:
- Tile interactions still not firing consistently after Three-ownership pivot.

Applied:
1. `input-router.js::determineMode()` tile detection expanded to include:
   - `canvas.tiles.active`
   - layer options names (`tiles`/`tile`)
   - active scene control name/layer (`tiles`/`tile`)
2. `interaction-manager.onPointerDown()` router block now bypasses stale PIXI-mode reports when tile context is active.
3. Added warn-level diagnostics in tile paths so visibility does not depend on debug log filtering:
   - `TileInteraction.pointerDown.enter`
   - `TileInteraction.pointerDown.leftClick`
   - `TileInteraction.pointerDown.rightClick`
   - `TileInteraction.doubleClick`

Validation:
- `node --experimental-default-type=module --check scripts/foundry/input-router.js` passed.
- `node --experimental-default-type=module --check scripts/scene/interaction-manager.js` passed.

### Iteration 9 — Suspected UI over-blocking before tile path
Observed result:
- Still no improvement; tile actions do not fire.

New hypothesis:
- `InteractionManager.onPointerDown()` exits too early via `_isEventFromUI(event)`.
- In hybrid layout, `elementsFromPoint` can include broad Foundry containers (`#ui`) even for board clicks, causing false UI classification.
- If that happens, tile path (`_handleTilesLayerPointerDown`) is never reached.

Planned fix:
1. Add tile-context-aware bypass so broad UI container hits do not block tile board clicks.
2. Keep strict blockers for real app/dialog/form interactions.
3. Add warn-level entry diagnostics at `onPointerDown` tile context decision point.

Applied:
- `interaction-manager.js` now has `_isHardUIInteractionEvent(event)` for strict UI blockers (dialogs/forms/module overlays) without broad `#ui` container blocking.
- `onPointerDown()` now performs a tile-context-aware UI gate:
  - if event is UI-classified but tile context is active and no hard blocker is hit, pointer handling continues.
  - emits `TileInteraction.pointerDown.uiGate` warn log with decision metadata.
- Retained tile-context router bypass for stale InputRouter PIXI reports.

Validation:
- `node --experimental-default-type=module --check scripts/scene/interaction-manager.js` passed.

### Iteration 12 — Pointer-up visual commit + double-click UI-gate parity
Observed issue:
- Tile drag path is active, but on release the tile appears not to update immediately.
- Double left-click still fails to open tile config in some contexts.

Applied:
1. `onDoubleClick()` now mirrors tile-context UI bypass used by pointer-down:
   - if event is UI-classified but tile context is active and no hard UI blocker is present, continue handling.
   - emits `TileInteraction.doubleClick.uiGate` warn metadata.
2. Tile drag commit now applies optimistic local sprite transform on pointer-up before document round-trip:
   - computes center from committed top-left update
   - updates sprite position/matrix immediately
   - syncs attached tile effects (`tileManager.syncTileAttachedEffects`) for visual parity.

Expected effect:
- Tile appears to land in new position immediately on release.
- Double-click tile config open works through transparent overlay stacks.

### Iteration 13 — Document commit succeeds, FloorRenderBus visual desync
Observed result:
- Double-click now works.
- Tile document appears to move (pick/cursor confirms new position), but visible tile image stays at old position until reload.

Interpretation:
- Document update path is working.
- Visual desync is likely in V2 `FloorRenderBus` mesh transform refresh, not in tile doc persistence.

Applied:
1. Added explicit FloorRenderBus tile mesh sync in tile pointer-up optimistic path:
   - `interaction-manager::_syncFloorBusTileVisual(tileId, x, y, w, h)`
   - computes center via Foundry -> world conversion and updates bus mesh transform immediately.
2. Tile optimistic pointer-up move now updates BOTH:
   - TileManager sprite transform/effects
   - FloorRenderBus tile mesh transform

Expected effect:
- Visible tile plane should move immediately after drag release without requiring reload.

### Iteration 14 — Bus root-vs-mesh transform mismatch
Observed regression:
- Tile disappears from start position but does not appear at destination after drag.

Root cause:
- `FloorRenderBus` stores world transform on `entry.root` (group), while `entry.mesh` is local at (0,0).
- Previous optimistic sync updated mesh world position directly, effectively offsetting local transform incorrectly.

Applied:
1. `interaction-manager::_syncFloorBusTileVisual()` now updates:
   - `entry.root` when present (preferred)
   - fallback to `entry.mesh` only if root is absent
2. Immediate matrix/world-matrix refresh remains in place.

Expected effect:
- Bus tile stays visible and appears at destination immediately on drag release.

### Iteration 15 — first drag works, second drag no-op
Observed:
- A tile can be moved once, but subsequent drag attempts do nothing.

Hypothesis:
- Drag startup can fail when preview creation depends on selection state that may be temporarily desynced by document/control hook timing.
- When no leader preview is created, drag state exits early and pointer move has no active object.

Applied:
1. Hardened `startDrag()`:
   - force-add drag leader id into `selection` before `createDragPreviews()`.
2. Added leader-preview fallback path:
   - if `createDragPreviews()` misses the leader, clone `targetObject` directly into the active scene and continue drag.
3. Added richer failure diagnostics for preview bootstrap anomalies.

Expected effect:
- Tile can be dragged repeatedly (second, third, etc.) without reload or reselection rituals.

### Iteration 16 — rendered tile plane pick/selection parity
Observed:
- After first move, selecting/dragging same tile can fail.
- Selection rectangle remains invisible.

Root cause direction:
- Runtime-visible tiles are rendered by `FloorRenderBus` planes, while interaction/outline was still centered on TileManager sprites.
- If those diverge, pick and selection feedback target non-visible objects.

Applied:
1. Tagged FloorRenderBus tile nodes with ids:
   - `mesh.userData.foundryTileId`
   - `root.userData.foundryTileId`
2. Added `_pickFloorBusTileHit()` fallback in `InteractionManager`:
   - raycasts the actually rendered bus tile objects
   - maps fallback hit back to TileManager data by tile id
3. Added mirrored selection outline on bus tile root:
   - `_setFloorBusTileSelectionVisual(tileId, selected)`
   - called from `_setTileSelectionVisual(...)`

Expected effect:
- Tile remains selectable after first move.
- Repeated drags continue to work.
- Selection rectangle appears on the visible (bus-rendered) tile.
- `node --experimental-default-type=module --check scripts/foundry/input-router.js` passed.

### Iteration 10 — Confirmed entry path, fix pick-resolution failures
Observed evidence (from user logs):
- Tile handlers ARE entered (`TileInteraction.pointerDown.enter`).
- But pick result is consistently empty (`TileInteraction.pointerDown.leftClick` => `picked:false`, `tileId:null`).
- Double-click path also runs but pick is empty (`TileInteraction.doubleClick` => `picked:false`).

Conclusion:
- Input routing is no longer the primary blocker.
- The blocking point is now `_pickTileHit()` candidate/raycast resolution under runtime layer/filter states.

Applied:
1. `_pickTileHit()` candidate collection now has progressive fallbacks:
   - strict (foreground + level band)
   - ignore foreground
   - ignore both foreground and level-band filters
2. `_pickTileHit()` raycaster now uses full layer mask (`0xffffffff`) to avoid misses from runtime sprite layer shifts.
3. Added warn diagnostic when no tile hit resolves:
   - `TileInteraction.pick.noHit` with `{candidateSprites, rayHits, tileSpritesTotal}`

Expected effect:
- Three tile pick should resolve under mixed layer/filter state instead of returning null.
- New `pick.noHit` telemetry will reveal whether miss is from candidate selection vs geometric ray miss.

### Iteration 11 — Drag works, commit/selection visuals missing
Observed result:
- Tiles can now be dragged visually.
- On release, tile position does not persist/update.
- Tile selection rectangle/selection visual is missing.

Interpretation:
- Pointer + pick path is now active.
- Remaining issues are in commit source state and visual selection feedback.

Applied:
1. Drag commit source hardening in `onPointerUp()`:
   - commit IDs now come from `dragState.previews.keys()` + `selection` union (instead of `selection` only).
   - this prevents commit no-op when selection set desyncs during drag.
2. Added commit telemetry:
   - `TileInteraction.commit.tileUpdates` logs count + tile IDs being committed.
3. Added explicit Three-side tile selection visual:
   - `_setTileSelectionVisual(sprite, selected)` creates/removes a cyan `THREE.LineLoop` outline attached to tile sprite.
   - called from `selectObject()` and `clearSelection()` tile branches.

Validation:
- `node --experimental-default-type=module --check scripts/scene/interaction-manager.js` passed.

### Iteration 6 — Pivot: route tile interactions through existing Three handlers
Observed result:
- Still no tile actions and no new click logs from tile attempts.
- This strongly suggests the PIXI tile interaction path is still not receiving/processing events reliably in the hybrid stack.

New pivot strategy:
1. Route `TilesLayer` input ownership to `THREE` in `InputRouter.determineMode()`.
2. Use existing `InteractionManager` tile handlers (`_handleTilesLayerPointerDown`, tile branch in `onDoubleClick`) as the operative path for select/drag/sheet open.
3. Keep current visibility/pointer safeguards in place and validate end-user operability first.

Rationale:
- Avoid further arbitration churn in the PIXI path and use the already-integrated Three tile picking pipeline that correctly identifies tiles under cursor.

Applied:
- `input-router.js::determineMode()` now routes `TilesLayer` to `InputMode.THREE`.
- `canvas-replacement.js::_enforceGameplayPixiSuppression()` now defers to InputRouter ownership when available, and only uses tile-context PIXI fallback if InputRouter is unavailable.

Validation:
- `node --experimental-default-type=module --check scripts/foundry/input-router.js` passed.
- `node --experimental-default-type=module --check scripts/foundry/canvas-replacement.js` passed.

### Iteration 7 — Begin full Three.js tile interaction ownership
Implementation focus:
- Ensure tile select/drag/edit paths are entered from `InteractionManager` regardless of PIXI overlay stacking.

Applied:
1. `interaction-manager.initialize()` now registers `dblclick` on `window` capture phase (not only canvas element).
2. `_isTilesLayerActive()` now uses robust context detection:
   - `canvas.tiles.active`
   - active layer meta (`options/name/ctor`)
   - active scene control name/layer metadata
3. Pointer-down tile branch now uses `_isTilesLayerActive()` directly for routing into `_handleTilesLayerPointerDown()`.

Expected effect:
- Three-owned tile paths should now trigger even when transparent PIXI/board layers sit above the Three canvas.
- Double-click tile config open should be resilient to DOM event target differences.

Validation:
- Pending syntax check + runtime verification.
