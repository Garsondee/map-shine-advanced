# Drawing Layer Feature Parity Checklist (Foundry Baseline)

This checklist is based on Foundry VTT source behavior and is intended to drive **total feature parity** and **visual style parity** for drawings.

## Source Baseline (Foundry)

Primary references:
- `foundryvttsourcecode/resources/app/client/canvas/layers/drawings.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/placeables/drawing.mjs`
- `foundryvttsourcecode/resources/app/client/applications/ui/scene-controls.mjs`

Key baseline behaviors:
1. Drawings scene control group is `drawings`, layer is `drawings`, and selecting the control activates `canvas.drawings`.
2. Active drawing tools are: `select`, `rect`, `ellipse`, `polygon`, `freehand`, `text` (+ toggles/buttons like `role`, `snap`, `configure`, `clear`).
3. Creation uses DrawingsLayer drag lifecycle (`_onDragLeftStart` -> `_onDragLeftMove` -> `_onDragLeftDrop`).
4. Polygon uses chained point placement and double-click completion.
5. Freehand samples points continuously with `FREEHAND_SAMPLE_RATE` behavior.
6. Snap behavior:
   - Drawings snap to center/vertex/corner/side-midpoint by default.
   - Shift bypasses snap.
   - `canvas.forceSnapVertices` toggle changes snapping mode.
7. New drawing data is seeded from `core.defaultDrawingConfig` then tool-specific shape defaults are applied.
8. New drawing completion creates `DrawingDocument` and auto-controls the new drawing (`control({isNew: true})`, except freehand behavior differences).
9. Text tool supports in-place text editing (`enableTextEditing`), keyboard capture, Enter/Escape conclude, Backspace edit.
10. Drawing visibility, control eligibility, and HUD behavior are bound to layer active state and ownership rules.

---

## Parity Checklist

## P0 - Must Work (authoring)

- [ ] Drawings control always activates DrawingsLayer immediately.
- [ ] Tool switch to `rect/ellipse/polygon/freehand/text` immediately routes input to PIXI authoring path.
- [ ] Click-drag creates `rect` and `ellipse` drawings.
- [ ] Polygon point chaining works (single-click add, double-click finish).
- [ ] Freehand stroke capture works while dragging.
- [ ] Text drawing creation works and enters text editing mode.
- [ ] Escape cancels in-progress draw previews and text edit states.
- [ ] New drawings persist to scene and are visible after reload.

## P1 - Editing parity

- [ ] Select tool can single/multi-select drawing placeables.
- [ ] Move, rotate, and resize handles behave like Foundry.
- [ ] Double-click opens drawing config sheet.
- [ ] Right-click toggles drawing HUD where applicable.
- [ ] Delete key removes controlled drawings.
- [ ] Ownership checks match Foundry (`DRAWING_CREATE`, author/GM control constraints).

## P2 - Snap + interaction parity

- [ ] Shift-modifier bypasses snapping.
- [ ] `snap` toggle mirrors `canvas.forceSnapVertices` behavior.
- [ ] Grid size-dependent snap resolution matches Foundry behavior.
- [ ] Polygon/freehand point insertion cadence and smoothing are parity-checked.

## P3 - Visual style parity (close match)

- [ ] Stroke width rendering matches Foundry proportions at common zoom levels.
- [ ] Fill/stroke alpha matches Foundry compositing order.
- [ ] Text metrics (font, outline, shadow, alignment, wrapping) match Foundry as closely as possible.
- [ ] Polygon/freehand smoothing and joins match Foundry style (no visible corner artifacts).
- [ ] Z-order/sort/elevation behavior aligns with Foundry drawing stacking semantics.
- [ ] Hidden/locked/interface drawing style states match Foundry visuals.

## P4 - Controls/UI parity

- [ ] Drawings toolbar icons/order/toolclips match Foundry defaults.
- [ ] `role`, `snap`, `configure`, `clear` controls function like Foundry.
- [ ] Active tool state survives control changes the same way Foundry does.

## P5 - Cross-system parity

- [ ] Levels/elevation filtering of drawings matches expected floor visibility rules.
- [ ] Scene transitions and canvas re-init preserve drawing interactivity.
- [ ] PIXI/Three ownership handoff has no race conditions during rapid control/tool switching.

---

## Current Map Shine Notes (starting point)

- Map Shine currently mirrors drawings visually in Three via `scripts/scene/drawing-manager.js` (text + shape rendering) but authoring remains Foundry-native PIXI.
- Input routing and layer activation therefore must prioritize DrawingsLayer correctness over Three interactions while drawing tools are active.

---

## Verification Matrix

For each drawing tool (`rect`, `ellipse`, `polygon`, `freehand`, `text`), verify:
1. Control activation
2. Input routing mode (PIXI)
3. Preview appears during draw
4. Final document creation
5. Selection/editing after creation
6. Visual match against vanilla Foundry

Run at minimum on:
- Grid scene + gridless scene
- GM + player roles
- Levels-enabled scene (if active in world)
