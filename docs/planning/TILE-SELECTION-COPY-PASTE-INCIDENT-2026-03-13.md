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

### Suggested Instrumentation (short-lived)

- Log at each tile click:
  - current input mode (`InputRouter.currentMode`),
  - canvas pointer-events owner (`board`, `canvas.app.view`, `map-shine-canvas`),
  - foreground mode value,
  - top 5 candidate tiles (id, overhead, in-band, interactive state).
- Log at paste completion:
  - created tile IDs,
  - whether each is present in `canvas.tiles`, `tileManager.tileSprites`, and current selection.
