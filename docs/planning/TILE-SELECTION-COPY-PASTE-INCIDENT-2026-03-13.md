---
title: Tile Selection / Copy-Paste Incident (Unresolved)
date: 2026-03-13
status: open
owner: map-shine
---

# Tile Selection / Copy-Paste Incident (Unresolved)

## Current Problem Statement

Tile workflows are still broken in production behavior.

### 1) Wrong tile is selected in normal tile mode
- In Tiles layer, when **not** in overhead mode, clicking a tile that sits under a full-scene overhead tile still attempts to select the overhead tile.
- Expected: overhead tile should be non-selectable unless explicitly in overhead/foreground tool mode.

### 2) Pasted tile does not display immediately
- After paste, the tile is created but does not render/appear immediately.
- Expected: pasted tile should become visible in the scene right away and be selectable.

### 3) Selection and copy/paste behavior is unstable
- Tile selection and clipboard operations are inconsistent across overlapping tiles and mode/tool changes.
- Impact is broad: selecting, copying, pasting, and deleting tiles can behave unpredictably.

---

## Reproduction Scenarios

### Scenario A — Under-overhead selection failure
1. Open a scene containing:
   - one very large overhead tile spanning most/all of scene
   - one or more regular tiles beneath it
2. Activate Tiles controls.
3. Ensure tool is **not** overhead/foreground mode.
4. Click a lower tile area beneath the overhead tile.

**Observed:** selection still resolves to the overhead layer behavior.

**Expected:** underlying non-overhead tile is selected.

### Scenario B — Paste not visible immediately
1. Select a tile.
2. Copy and paste in Tiles layer.
3. Observe new tile render state immediately after create.

**Observed:** pasted tile may not appear right away.

**Expected:** pasted tile is visible instantly after paste.

---

## Suspected Failure Domains

1. **Mode resolution drift**
   - Tool/layer foreground mode state may still be stale or inferred from inconsistent sources.

2. **Pick-resolution ordering under large overhead occluders**
   - Hit testing may still allow topmost overhead candidates to dominate even when filtered out by mode.

3. **Selection target identity mismatch**
   - Selected ID/source may differ between Three sprite selection and Foundry controlled placeables.

4. **Post-paste visual sync gap**
   - Tile document creation and Three/FloorRenderBus visual refresh may not be synchronized in the same frame window.

5. **Delete / stale visual lifecycle**
   - Inconsistent cleanup paths can leave visual remnants or stale selection visuals.

---

## Investigation Plan (Priority Order)

### P0 — Instrument exact pick decision path
Add temporary debug logs for each tile pick attempt:
- active tool + resolved foreground mode
- all candidates at click point (id, overhead classification, band eligibility, opacity hit)
- winning candidate and reason

Goal: prove exactly why overhead candidate survives in non-overhead mode.

### P1 — Enforce hard mode gate before winner selection
In Tiles context:
- if mode is non-overhead, discard overhead candidates before ranking
- if mode is overhead, discard non-overhead candidates before ranking

No fallback pass should relax this gate in tile-editing context.

### P2 — Unify selection authority
Ensure one authoritative tile ID path for:
- click selection
- control() state
- delete target
- copy source

Avoid mixed identity paths between Three sprite IDs and Foundry placeables.

### P3 — Force immediate visual sync after paste
After createEmbeddedDocuments('Tile', ...):
- trigger deterministic refresh path for new tile IDs
- verify sprite + floor bus entry exist and are visible
- verify selection outline/control binds to the created IDs in the same tick or next microtask

### P4 — Add runtime assertions for stale entries
Temporary guards for:
- selected tile IDs missing from scene docs
- visual entries without matching docs
- bus entries not cleared on delete

---

## Acceptance Criteria

1. In non-overhead tile mode, clicking under a scene-wide overhead tile selects the intended underlying tile every time.
2. In overhead mode, overhead selection still works as expected.
3. Pasted tiles appear immediately and can be selected/deleted right away.
4. Copy/paste/delete behavior remains stable across repeated operations and mode switches.

---

## Notes

This incident remains unresolved as of 2026-03-13 and should be treated as a blocker for reliable tile authoring workflows.

---

## Investigation Addendum (2026-03-13)

### Confirmed Findings

1. **Tiles layer ownership is internally conflicting (Three vs PIXI).**
   - InputRouter says Tiles should be handled by Three (`return InputMode.THREE` for tiles layer).
     - `scripts/foundry/input-router.js` (determineMode), tiles branch.
   - But ControlsIntegration force-enables PIXI pointer events in tile context.
     - `scripts/foundry/controls-integration.js` in `_updateTilesVisualState()` sets:
       - `pixiCanvas.style.pointerEvents = 'auto'`
       - `board.style.pointerEvents = 'auto'`
       - `threeCanvas.style.pointerEvents = 'none'`
   - Result: native Foundry PIXI tile hit-testing can take control even when Map Shine expects Three tile picking.

2. **All PIXI tiles are intentionally left interactive, including full-scene overhead tiles.**
   - `_updateTilesVisualState()` loops all `canvas.tiles.placeables` and applies:
     - `tile.visible = true`
     - `tile.renderable = true`
     - `tile.mesh.alpha = 0.01`
   - The tile is visually hidden, but still fully hittable.
   - A scene-wide overhead tile therefore remains a giant active hit target in PIXI.

3. **No explicit overhead-vs-background filter is applied in the PIXI tile path.**
   - The current comment assumes Foundry will handle foreground/background filtering.
   - In this hybrid path, that assumption is not reliable enough for our mode constraints.

4. **Three-side tile picking logic is mostly correct, but can be bypassed by PIXI ownership timing/state drift.**
   - `InteractionManager` already enforces tool-aware overhead filtering via:
     - `_getTileForegroundMode()`
     - `_isTileAllowedByCurrentForegroundMode()`
     - `_isTileSelectableForCurrentTool()`
     - `_pickTileHit()` strict tile-mode candidate filtering
   - This means the bug is primarily routing/ownership and PIXI interactive-state leakage, not only pick ranking.

5. **Hook timing makes this worse during fast control/tool switches.**
   - In `registerHooks()`, both `activateCanvasLayer` and `renderSceneControls` updates are deferred with `setTimeout(..., 0)` then reasserted again with another `setTimeout(..., 25)`.
   - This creates windows where mode, active layer, and pointer-event owner can briefly disagree.

6. **Copy/paste tile creation path exists and is functional, but visibility/selectability can lag when selection ownership is split.**
   - Tile copy/paste is custom in `InteractionManager`:
     - `_copySelectedTilesToClipboard()`
     - `_pasteTilesFromClipboard()`
     - paste calls `canvas.scene.createEmbeddedDocuments('Tile', createData)` and then controls created placeables via `canvas.tiles.get(id).control(...)`.
   - If active picking/selection authority is split between Three and PIXI at that moment, newly created tiles can appear inconsistent (selected in one path, not yet represented in the other).

7. **Visual sync gap on newly created tiles.**
   - When `canvas.scene.createEmbeddedDocuments('Tile', ...)` is called during paste, the Foundry hook `createTile` fires.
   - `TileManager.setupHooks` handles `createTile` by calling `createTileSprite(tileDoc)`.
   - However, `createTileSprite` immediately triggers asynchronous texture loading (`loadTileTexture(texturePath)`).
   - The sprite is added to the scene (`this.scene.add(sprite)`), but it starts with `sprite.visible = false` and `sprite.userData.textureReady = false`.
   - Visibility is only set to true *after* the texture finishes loading (`this.updateSpriteVisibility` inside the `.then()` block).
   - The `paste` function attempts to select the tile immediately (`canvas.tiles.get(id).control(...)`), which delegates to `InteractionManager.selectObject`.
   - Furthermore, `InteractionManager._isTileSelectableForCurrentTool` strictly requires `sprite.visible === true`, meaning you cannot pick or drag the newly pasted tile until its texture fully downloads. This causes the "ghost paste" effect.

8. **Overhead tile misclassification (V12 elevation logic mismatch)**
   - Even when MapShine handles Three.js pointer logic correctly, the cursor could still think "the entire scene is a tile" while in background mode.
   - Why? `TileManager.isTileOverhead` and `InteractionManager._isTileAllowedByCurrentForegroundMode` were checking `tileDoc._source.overhead` and skipping the dynamic `tileDoc.overhead` getter.
   - In Foundry V12, `_source.overhead` is often `false`, and the true overhead status is derived dynamically from `elevation >= scene.foregroundElevation`.
   - Because MapShine misclassified the giant overhead tile as a *background* tile, it allowed it to be hovered and selected while in the background tool mode, intercepting all clicks.
   - Fix: Prioritize `sprite.userData.isOverhead` in the interaction manager, and ensure `TileManager` respects the native `tileDoc.overhead` getter before falling back to `_source.overhead`.

### Failed Fix Attempts (2026-03-13)

The following attempted remediations were implemented but **did not fully resolve** the "entire scene appears clickable as one tile" behavior:

1. **PIXI event suppression pass (incomplete in runtime effect).**
   - Change attempted: set native tile `interactive = false` and `eventMode = 'none'` (including mesh) in controls integration.
   - Why this failed: despite this, scene-wide tile-like hover behavior still reproduced, indicating another interception or gating path remains active.

2. **Overhead classification correction (not sufficient by itself).**
   - Change attempted: prioritize runtime overhead truth (`sprite.userData.isOverhead`) and use `tileDoc.overhead` getter ahead of legacy `_source.overhead` fallbacks.
   - Why this failed: mode classification became more correct, but click/hover behavior still reported a full-scene clickable tile in user testing.

3. **Tile selectability loosening for paste flow (side fix, not root fix).**
   - Change attempted: removed strict `sprite.visible` requirement for selecting freshly pasted tiles.
   - Why this failed: improved ghost-paste timing, but did not address the primary scene-wide hit-target problem.

4. **UI gate adjustment in pointer-down path (still unresolved).**
   - Change attempted: refined UI-event blocking to avoid rejecting canvas-originated clicks when global UI roots appear in `elementsFromPoint`/event path.
   - Why this failed: even with improved canvas-origin checks, the pointer still behaves as if a single tile spans the scene.

Status: root cause remains unresolved; additional instrumentation is required around final hit winner selection and any non-tile cursor ownership path.

### Foundry VTT Source Investigation Findings (2026-03-13)

Direct review of `foundryvttsourcecode` surfaced several high-risk mismatch areas for our integration:

1. **Foundry tile interactivity is controlled by per-tile `eventMode` state, not just layer-level settings.**
   - In core `Tile._refreshState()`, Foundry computes `overhead` as `elevation >= parent.foregroundElevation` and sets tile `eventMode` to `"static"` when it matches current foreground tool mode, otherwise `"none"`.
   - This means stale or skipped `refreshState` calls leave stale hit eligibility on tiles.

2. **Foreground filtering is elevation-driven in V12+, while legacy `overhead` is compatibility-only.**
   - Core `BaseTile` keeps `overhead` as a deprecated getter derived from elevation and scene foreground elevation.
   - Any integration path that treats `_source.overhead` or legacy booleans as authoritative can drift from Foundry's actual selectable set.

3. **Tile layer activation globally enables interaction on the layer container.**
   - `InteractionLayer.activate()` sets `eventMode = "static"` and `interactiveChildren = true` for the active layer.
   - In Tiles context, this creates a broad interactive surface where correctness depends on every placeable having accurate per-object event gating.

4. **Foundry expects hover/cursor state to be resynchronized via synthetic pointermove when interactivity changes.**
   - Core frequently calls `MouseInteractionManager.emulateMoveEvent()` when position, visibility, or `eventMode` changes.
   - If MapShine reroutes input ownership without triggering equivalent move resync at the same time, the cursor can remain latched to stale targets.

5. **Foreground tool changes in Foundry explicitly refresh tile state and release controls.**
   - `TilesLayer` foreground toggle and tool change paths call tile `refreshState` and release controlled tiles.
   - If our integration delays or overrides these transitions, temporary stale control/hover state can survive across tool switches.

Net: Foundry's model is coherent internally, but it relies on strict sequencing of layer activation, per-tile refresh, and move-event resync. Our hybrid Three/PIXI ownership can violate that sequencing and produce the scene-wide clickable tile symptom.

### Applied Fix Attempt — Three-Owned Tiles Hard Gate (2026-03-13)

Implemented in `scripts/foundry/controls-integration.js` (`_updateTilesVisualState`):

1. Removed accidental debug breakage and restored valid method execution.
2. In tiles context, hard-disabled PIXI tile layer interactivity:
   - `canvas.tiles.eventMode = 'none'`
   - `canvas.tiles.interactiveChildren = false`
3. Kept PIXI canvas/board non-interactive and Three canvas interactive in tiles mode.
4. For every native tile placeable, force-disabled hitability:
   - `tile.eventMode = 'none'`, `tile.interactive = false`, `tile.interactiveChildren = false`
   - `tile.mouseInteractionManager?.cancel?.()` to clear stale hover/drag state
5. Added a defensive reset of canvas mouse workflow during ownership swaps:
   - `canvas.mouseInteractionManager?.reset({ state: false })`

Goal of this fix pass: prevent any residual PIXI tile or stale PIXI hover manager from presenting a scene-wide clickable tile while Tiles are handled by Three.

Validation completed:
- `node --experimental-default-type=module --check scripts/foundry/controls-integration.js` (pass)

### Root Cause Summary

The main failure is **input/hit-test ownership mismatch** in tile context:

- Architecture intends Three tile interactions (`InputMode.THREE` for tiles).
- Runtime tile visual-state code forces PIXI to own pointer events and keeps every PIXI tile interactive.
- A full-scene overhead tile remains a top-level interactive target, so pointer perception becomes "the whole scene is one tile".

This directly explains:

- inability to reliably click underlying non-overhead tiles,
- unstable selection identity,
- downstream copy/paste instability when selecting or controlling newly created tiles.

### High-Confidence Remediation Plan

1. **Pick one authority for Tiles and enforce it hard.**
   - Recommended: keep Tiles fully Three-owned (aligns with current InputRouter policy).
   - In `_updateTilesVisualState()`, do not force PIXI pointer ownership for tile context.

2. **If PIXI tile interop must remain enabled, apply strict per-tile interactivity gating.**
   - Only interactive tiles should match current foreground mode + active level band.
   - Non-eligible tiles (especially scene-wide overhead in background mode) must be non-interactive, not only alpha-hidden.

3. **Eliminate timing gaps during layer/tool switch for tile ownership.**
   - Reassert ownership synchronously for tile context before first click, then keep deferred pass as backup.

4. **After paste, force deterministic tile sync in same authority path.**
   - After `createEmbeddedDocuments`, ensure both selection and pick caches reflect created IDs in the same tick/microtask.
   - Add temporary diagnostics to confirm ownership mode at paste time.

5. **Solve async texture loading visibility gap.**
   - Allow sprites to be `visible = true` (or at least `selectable`) even while their initial texture is resolving, so immediate selection outlines and interactions can occur immediately after paste.

---

## Architectural Rethink — PIXI-Owned Tile Editing (2026-03-13)

### Why Every Three-Owned Fix Has Failed

The Three.js tile picking path (`InteractionManager._pickTileHit`) reimplements
Foundry's foreground/background tile filtering in ~200 lines across four methods:

| Method | Purpose | Lines |
|--------|---------|-------|
| `_getTileForegroundMode()` | Detect active tool → boolean foreground flag | 2568-2605 |
| `_isTileAllowedByCurrentForegroundMode()` | Check tile overhead ↔ foreground agreement | 2533-2566 |
| `isTileOverhead()` (tile-manager.js) | Classify tile as overhead via multi-fallback chain | 64-86 |
| `_isTileSelectableForCurrentTool()` | Combine band + foreground filter | 2521-2531 |

Foundry does the same thing in **one line** inside `Tile._refreshState()`:

```javascript
this.eventMode = overhead === foreground ? "static" : "none";
```

Where `overhead = elevation >= this.document.parent.foregroundElevation` and
`foreground = this.layer.active && ui.controls.control.tools?.foreground.active`.

Every incremental fix has failed because our reimplementation diverges from
Foundry's single-line truth in some edge case:
- `sprite.userData.isOverhead` not set at the right time
- `isTileOverhead()` fallback chain evaluating differently than Foundry's getter
- `_getTileForegroundMode()` tool name matching missing an edge case
- Timing: our filter runs BEFORE Foundry's `_refreshState` recalculates overhead

**This is a category error.** We are reimplementing proven platform behavior and
then debugging why our reimplementation doesn't match. The solution is to stop
reimplementing and let the platform do what it already does correctly.

### The Working Pattern We Already Use

For **tokens**, MapShine already uses a hybrid pattern that works:
- PIXI tokens are **transparent but interactive** (alpha 0.01, `visible = true`)
- Three.js renders the visual token
- Foundry's native PIXI click/drag/HUD/selection just works
- No reimplementation of Foundry's token interaction logic in Three.js

For **walls** (editing), PIXI owns interaction via overlay when the wall layer
is active. Three.js renders visuals.

**Tiles should follow the same pattern.** When the Tiles layer is active, PIXI
owns interaction. Foundry's native tile tools handle everything. Three.js renders.

### Proposed Architecture: PIXI-Owned Tile Editing

#### Principle

When the Tiles layer is active, let Foundry/PIXI handle ALL tile interactions
natively. Three.js only renders visuals. When NOT in tile editing mode, Three.js
owns everything as usual (gameplay, token interaction, etc.).

#### What Foundry Handles Natively (For Free)

These all work without any MapShine code when PIXI owns tile interaction:

- **Foreground/background filtering** — `Tile._refreshState()` sets `eventMode`
- **Select/multi-select** — `TilesLayer.controllableObjects()` filters correctly
- **Drag** — native `PlaceableObject` drag workflow
- **Copy/paste** — `TilesLayer.copyObjects()` / `pasteObjects()`
- **Delete** — `TilesLayer._onDeleteKey()`
- **Select All** — `TilesLayer._onSelectAllKey()`
- **Double-click config** — `Tile._onClickLeft2()` opens sheet
- **Right-click HUD** — native tile HUD
- **Foreground tool toggle** — refreshes all tile states automatically
- **Selection border/handle** — drawn by `Tile._refreshState()`
- **New tile creation** — drag from file browser, native workflow

#### Implementation Plan

**1. InputRouter — return PIXI for tiles context**

```javascript
// input-router.js — determineMode()
if (isTilesLayer) {
  return InputMode.PIXI;  // was: InputMode.THREE
}
```

**2. ControlsIntegration._updateTilesVisualState() — keep PIXI tiles interactive**

When tiles context is active:
- `pixiCanvas.style.pointerEvents = 'auto'` (PIXI gets clicks)
- `threeCanvas.style.pointerEvents = 'none'` (Three doesn't intercept)
- `canvas.tiles.visible = true`
- `canvas.tiles.interactiveChildren = true`
- **DO NOT** override individual tile `eventMode` — let Foundry's `_refreshState()` handle it
- **DO NOT** set `tile.visible = false` — breaks hit testing
- **DO NOT** set `tile.interactive = false` — breaks native interactions
- Set `tile.mesh.alpha = 0.01` — near-invisible but PIXI hit-tests against mesh bounds
- Optionally set `tile.alpha = 0.01` for the container to hide the PIXI visual
  while keeping hitArea active (Three.js shows the real visual)

When tiles context is NOT active:
- `canvas.tiles.visible = false` — hide layer
- Tiles go back to non-interactive state naturally via layer deactivation

**3. InteractionManager — disable Three-side tile picking in PIXI mode**

Guard all Three-side tile interaction code behind an input mode check:

```javascript
_handleTilesLayerPointerDown(event, currentTool) {
  // When PIXI owns tile interaction, don't intercept in Three
  if (this.inputRouter?.currentMode === 'pixi') return false;
  // ... existing Three-side code (kept for potential future use)
}
```

Same guard on: tile hover, tile drag start, tile selection, tile paste.

**4. Three-side tile rendering — unchanged**

`TileManager` continues to create `THREE.Sprite` objects and render them.
No changes needed to the visual pipeline.

#### Synchronization Between PIXI Editing and Three.js Visuals

| Event | Source | Three.js Response |
|-------|--------|-------------------|
| Tile moved (drag) | `refreshTile` hook | TileManager updates sprite position |
| Tile created | `createTile` hook | TileManager creates new sprite |
| Tile deleted | `deleteTile` hook | TileManager removes sprite |
| Tile config changed | `updateTile` hook | TileManager updates properties |
| Foreground toggle | `refreshTile` hook (all) | TileManager updates overhead state |

These hooks already exist and work. No new sync mechanism needed.

#### Edge Cases

1. **Overhead tile hover-hide (gameplay)**
   - Not affected. Hover-hide is a gameplay feature, not a tile-editing feature.
   - In gameplay mode, Three.js owns interaction. Tile hover-hide works via
     `InteractionManager` as before.

2. **Tile drag preview lag**
   - During PIXI drag, Foundry updates tile document position each frame.
   - `refreshTile` hook fires → TileManager moves Three.js sprite.
   - May have 1-frame lag. Acceptable for editing UX.

3. **Selection visuals**
   - Foundry's native selection border renders in PIXI at alpha ~0.01.
   - We can overlay a Three.js selection highlight via `refreshTile`/`controlTile`
     hooks if the native PIXI border is too faint. This is cosmetic, not functional.

4. **Tile creation from file browser**
   - Fully native Foundry workflow. Creates tile document → hooks fire →
     TileManager creates sprite. No MapShine code involved.

#### What We Remove / Disable

In `InteractionManager` (interaction-manager.js), when PIXI owns tiles:
- `_pickTileHit()` — not called
- `_handleTilesLayerPointerDown()` — returns false immediately
- `_isTileSelectableForCurrentTool()` — not called
- `_isTileAllowedByCurrentForegroundMode()` — not called
- `_getTileForegroundMode()` — not called
- Tile hover cursor logic — not called
- Tile copy/paste keyboard handling — not called (Foundry handles natively)

These methods can remain in the codebase (guarded by input mode check) for
potential future use or as fallback, but they are not active when PIXI owns tiles.

#### Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| PIXI selection border invisible at alpha 0.01 | High | Overlay Three.js highlight or increase alpha slightly |
| 1-frame drag position lag | Medium | Acceptable for editing; can optimize later |
| Foundry version changes tile interaction | Low | We inherit changes automatically |
| Other modules interfere with tile eventMode | Low | Same risk as vanilla Foundry |

#### Migration Effort

- **InputRouter**: 1 line change
- **ControlsIntegration._updateTilesVisualState()**: Rewrite (~40 lines, simpler than current)
- **InteractionManager**: Add input-mode guards (~10 lines across several methods)
- **Testing**: Select, foreground toggle, copy/paste, drag, delete, double-click config

This is a **small, subtractive change** — we are removing our reimplementation,
not adding new complexity.

---

## Implementation Status (2026-03-13)

### Applied Changes

**1. `scripts/foundry/input-router.js`** — `determineMode()` now returns
`InputMode.PIXI` for tiles layer (was `InputMode.THREE`).

**2. `scripts/foundry/controls-integration.js`** — `_updateTilesVisualState()`
rewritten:
- Computes `isForegroundMode` using same logic as `Tile._refreshState()`
- Per-tile: checks `elevation >= foregroundElevation` to classify overhead
- **Matching tiles**: `visible = true`, `alpha = 0.01`, `eventMode = 'static'`
- **Non-matching tiles**: `visible = false`, `renderable = false`, `eventMode = 'none'`
- Tile `frame.alpha` counteracts parent alpha so selection borders are visible
- PIXI canvas gets `pointerEvents = 'auto'`; Three canvas gets `pointerEvents = 'none'`
- **Fix (v2)**: Explicitly sets `eventMode` per-tile instead of relying on
  `_refreshState()` timing. The previous approach left overhead tiles with stale
  `eventMode = 'static'` when `_updateTilesVisualState()` was called from hooks
  where `_refreshState()` hadn't just run (e.g. `renderSceneControls`,
  `controlToken`), causing the scene-wide overhead tile to absorb all clicks.

**3. `scripts/scene/interaction-manager.js`** — PIXI-mode guards added:
- `_isPixiOwnedTileMode()` helper checks InputRouter current mode
- `onPointerDown` PIXI-mode block: removed `!isTilesContextActive` exception
- Double-click tile handler: skipped when PIXI owns tiles
- Tile hover cursor logic: skipped when PIXI owns tiles
- Ctrl+C tile copy: skipped when PIXI owns tiles
- Ctrl+V tile paste: skipped when PIXI owns tiles
- Delete key: excludes controlled tile IDs when PIXI owns tiles

### Syntax Validation

All three files pass `node --experimental-default-type=module --check`.

### Runtime Testing Required

- [ ] Tile selection (click non-overhead tile in background mode)
- [ ] Overhead tile correctly ignored in background mode
- [ ] Foreground toggle selects overhead tiles only
- [ ] Multi-select (shift-click)
- [ ] Tile drag
- [ ] Copy/paste (Ctrl+C / Ctrl+V)
- [ ] Delete selected tiles
- [ ] Double-click opens tile config sheet
- [ ] Right-click shows tile HUD
- [ ] New tile creation (drag from file browser)
- [ ] Selection borders/handles visible
- [ ] Three.js tile visuals still render correctly
- [ ] Switching away from tiles layer restores Three.js interaction

---

## Decisive Migration Plan — PIXI-Only Tile Manipulation (2026-03-13)

### Goal

Make tile manipulation fully Foundry-native while keeping Three.js as the tile visual renderer.

- **PIXI owns tile interaction/manipulation 100%** when Tiles layer is active.
- **Three.js owns tile rendering only** in that context.
- Remove all mixed-ownership tile input behavior.

### Ownership Contract (to freeze)

In Tiles layer:
- Selection/multi-select
- Hover cursor
- Drag/move
- Copy/paste
- Delete
- Double-click config
- Tile creation

All of the above must be handled by Foundry/PIXI only.

Outside Tiles layer:
- Existing Three.js ownership for gameplay/token/walls remains unchanged.

### Implementation Phases

#### Phase 1 — Hard-disable Three tile manipulation paths

In `scripts/scene/interaction-manager.js`, in Tiles context + PIXI mode:
- Return early from tile pointer-down handling
- Return early from tile hover-cursor handling
- Return early from tile copy/paste handling
- Return early from tile delete handling
- Return early from tile double-click tile-sheet handling

Rule: Three input handlers may run, but they must not execute tile-specific mutation logic when PIXI owns tiles.

#### Phase 2 — Make ControlsIntegration tile logic visual-only

In `scripts/foundry/controls-integration.js` (`_updateTilesVisualState`):
- Keep PIXI pointer ownership enabled in tile context
- Keep Three canvas pointer-events disabled in tile context
- Keep tile visuals transparent enough to reveal Three rendering
- **Do not own tile hit-testing semantics in this method**

This function should only control rendering visibility/transparency and pointer routing, not selection eligibility policy.

#### Phase 3 — Force Foundry refresh sequencing on control/tool transitions

On relevant lifecycle hooks (`renderSceneControls`, tile layer activation/deactivation, foreground toggle paths):
- Reassert tile visual state
- Trigger Foundry tile refresh sequencing so `eventMode` is recomputed before next interaction

Purpose: eliminate stale state windows during fast mode switches.

#### Phase 4 — Add temporary ownership diagnostics

Add concise diagnostics while validating:
- InputRouter mode (`PIXI`/`THREE`)
- Active control/tool
- Tile `eventMode` counts (`static` vs `none`)
- Any Three tile handler entry while PIXI mode is active (should be zero)

Diagnostics are temporary and should be removed/reduced after validation.

### Validation Matrix (must pass before closing incident)

1. Background tool mode: scene-wide overhead tile is not selectable/hittable.
2. Overhead/foreground mode: overhead tile is selectable and draggable.
3. Shift multi-select works for eligible tiles only.
4. Ctrl/Cmd+C and Ctrl/Cmd+V use Foundry-native tile behavior.
5. Delete key deletes selected eligible tiles once (no double-delete).
6. Double-click opens tile config sheet in correct mode.
7. New tile creation from file browser works.
8. Cursor reflects correct target class (no scene-wide false tile hover in background mode).
9. Switching out of Tiles layer restores normal Three.js interaction for non-tile workflows.

### Exit Criteria

The incident can be marked resolved only when all validation matrix items pass in user runtime testing, without fallback code paths masking failures.

---

## Failure Log — PIXI Tile Ownership Migration Attempts (2026-03-13, continued)

### Current User-Verified Runtime Status (still broken)

1. In non-overhead/background mode, the scene-wide overhead tile can still be selected/moved.
2. In overhead mode, tile interaction can trigger, but movement does not reliably update rendered position.
3. Net: tile manipulation remains unstable and does not satisfy acceptance criteria.

### Attempted Changes and Outcomes

#### F-01: Input ownership switched to PIXI for tiles
- Change: `InputRouter.determineMode()` returns `InputMode.PIXI` for tiles layer.
- Intended effect: Foundry native tile interaction should fully own selection eligibility.
- Outcome: insufficient by itself; wrong tile still controllable in user runtime.

#### F-02: Disabled Three-side tile manipulation paths in InteractionManager
- Change: early returns added for tile pointer-down/hover/double-click/copy/paste/delete paths in tiles context.
- Intended effect: remove mixed ownership and prevent Three from selecting/moving tiles.
- Outcome: still unresolved; overhead tile remains controllable in background mode.

#### F-03: ControlsIntegration visual-only tile path
- Change: `_updateTilesVisualState()` reduced to pointer routing + transparency only.
- Intended effect: Foundry owns eligibility (`eventMode`) while Three remains render-only.
- Outcome: unresolved in runtime; stale/incorrect control behavior persisted.

#### F-04: Forced tile interaction resync via `_refreshState()` + move-event emulation
- Change: `_resyncFoundryTileInteractionState()` added and invoked on mode/control hooks.
- Intended effect: eliminate transient stale `eventMode` state after tool/layer transitions.
- Outcome: unresolved in runtime; user still reported overhead tile movable in background mode.

#### F-05: Per-tile eligibility hardening during resync
- Change: explicit eligibility calculation + `tile.eventMode = static/none` + release ineligible controlled tiles.
- Intended effect: hard clamp tile eligibility even if Foundry state refresh lags.
- Outcome: unresolved in runtime.

#### F-06: Live drag visual sync attempt in TileManager `refreshTile`
- Change: refresh path attempted to use live placeable transform values for immediate Three sprite updates.
- Intended effect: overhead tile movement should visually update while dragging.
- Outcome: initial implementation caused runtime crash due assigning getter-only document fields.

#### F-07: Crash hotfix for refreshTile
- Change: replaced direct assignment with proxy-based read overlay for live geometry values.
- Outcome: crash fixed, but user still reports movement rendering not reliably updating.

#### F-08: `controlTile` hard guard
- Change: added `Hooks.on('controlTile')` guard to release ineligible tiles immediately.
- Intended effect: prevent overhead tile control in background mode even if transiently selected.
- Outcome: unresolved in runtime per latest user verification.

### Diagnostic Evidence Collected

Console diagnostics (user-provided) show that when foreground is explicitly toggled off:
- overhead tile resolves to `eventMode = none`
- non-overhead tiles resolve to `eventMode = static`
- summary includes `overheadStatic: 0`

This indicates overhead classification and resync can appear correct in sampled state, yet runtime interaction still allows invalid control in real workflow.

### Interpretation

The failure is not a simple overhead-classification boolean mismatch. It appears to be a deeper control/interaction lifecycle issue where control can still be acquired or retained outside expected eligibility windows, and visual transform sync may diverge during live manipulation.

### Constrained Next-Step Debug Direction

1. Instrument the exact `controlTile` / drag-start / drag-move / drag-end sequence for the specific problematic tile ID, including timestamps and tool-state snapshots.
2. Confirm whether control is acquired before or after eligibility gate transitions on the same tick.
3. Verify whether Three sprite transform source-of-truth should be placeable transform, document transform, or both (during drag vs commit).
4. Block incident closure until both of these are true in user runtime:
   - overhead tile cannot be controlled in background mode
   - overhead tile movement visually updates immediately and persists after drop

---

## Long Failure Log — NPC Token Selection Fade Regression (2026-03-13)

User runtime status remains unresolved: selecting some NPC tokens still causes a smooth scene fade-out, while selecting PC tokens does not.

### LF-01: Input ownership hardening (failed to fix)
- Attempt: hardened `input-router.js` Three-mode canvas style enforcement and ownership reassertions.
- Goal: prevent transient PIXI ownership or board visibility leaks during token selection.
- Result: no runtime improvement; fade still reproduced on NPC selection.

### LF-02: controlToken ownership reassertion in controls integration (failed to fix)
- Attempt: added `controlToken` hook-side `inputRouter.autoUpdate()` and ownership reassert paths.
- Goal: eliminate mode drift after token control events.
- Result: no runtime improvement; selection still triggers fade on affected NPCs.

### LF-03: VisibilityController/token visibility hypothesis (invalidated)
- Attempt: investigated token sprite visibility gates (`TokenManager` + `VisibilityController`).
- Goal: prove token hidden-state regression as root cause.
- Result: diagnostics showed Three token sprites remained visible; this path was not the primary failure.

### LF-04: Renderer clear-alpha leak hypothesis (not confirmed)
- Attempt: traced WebGL renderer state (`setClearAlpha`, `setClearColor`, `setRenderTarget`, render calls).
- Goal: catch transparent clear-state leak causing board/show-through fade.
- Result: sampled state stayed `clearAlpha: 1`; no decisive alpha leak captured.

### LF-05: Fog bypass logic patch in `FogOfWarEffectV2` (failed to fix)
- Attempt: expanded GM fog bypass to require renderable active vision source, fail-open otherwise.
- Goal: prevent darkness/fog collapse when selecting non-vision NPCs.
- Result: user runtime still broken even when `_shouldBypassFog()` returned `true`.

### LF-06: Overhead hover-hide guard (partial hypothesis, unresolved outcome)
- Attempt: restricted Three overhead hover-hide flow to Three-owned tile-editing context.
- Goal: stop scene-wide roof/occluder fade animation from firing during token gameplay selection.
- Result: no user-verified resolution; smooth fade symptom still reported.

### LF-07: Additional tile interactivity hard guards (failed to fix)
- Attempt: repeated controls-integration hardening (`controlTile` release guard, interaction resync, per-tile eligibility enforcement).
- Goal: prevent stale scene-spanning overhead control paths from interfering with runtime.
- Result: issue persisted in user runtime.

### LF-08: Net conclusion after above attempts
- The failure has survived input-mode hardening, fog bypass changes, visibility checks, and tile interaction guards.
- Current evidence indicates a deeper lifecycle/cross-system interaction bug (selection event chain + hover/occlusion/fade state coupling) not yet isolated to one deterministic gate.
