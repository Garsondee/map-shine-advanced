# Foundry Canvas Render-Parity Plan (Full Reproduction Scope)

## Goal

Map Shine replaces Foundry canvas rendering, so **every user-visible rendered canvas function must be reproduced in the Three pipeline** (with Foundry still authoritative for document data and game logic).

This plan expands from wall/light follow-up work into a full rendered-functionality parity roadmap.

---

## 1) Scope Definition: What Counts as “Must Reproduce”

“Must reproduce” means anything a user expects to see/update on the canvas from Foundry rendering systems, including:

1. Placeable visuals and edit affordances (icons, outlines, fields, handles).
2. Layer-specific overlays (doors, select rectangles, rulers, cursors, pings).
3. Perception-coupled visuals (LOS-clipped fields, darkness gating, hidden-state styling).
4. Tool-mode rendering behavior (active layer edit visuals vs gameplay visuals).

We are **not** replacing Foundry document ownership, permissions, or server sync logic. We are reproducing render + interaction visuals in Three.

---

## 2) Baseline Investigation Recap (Walls/Lights)

### 2.1 Foundry wall model

References:
- `foundryvttsourcecode/resources/app/client/canvas/placeables/wall.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/walls.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/containers/elements/door-control.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/controls.mjs`

Key takeaways:
1. Wall placeable controls line/endpoints/highlight refresh cycle.
2. Door controls are independent render elements with permission + visibility logic.
3. Door visibility is perception-aware (`canvas.visibility.testVisibility`).
4. Wall changes trigger perception and edge graph updates.

### 2.2 Foundry light model

References:
- `foundryvttsourcecode/resources/app/client/canvas/placeables/light.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/layers/lighting.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/containers/elements/control-icon.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/sources/base-light-source.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/sources/point-light-source.mjs`

Key takeaways:
1. `ControlIcon` is a reusable affordance pattern (icon/border/elevation tooltip).
2. Radius field is drawn from source polygon (`_refreshField`).
3. Source lifecycle (`initializeLightSource`) is tightly tied to perception refresh.
4. Lighting layer tool workflows govern create/drag/radius editing behavior.

### 2.3 Current Map Shine status for this baseline

References:
- `scripts/scene/wall-manager.js`
- `scripts/scene/light-icon-manager.js`
- `scripts/scene/enhanced-light-icon-manager.js`
- `scripts/scene/interaction-manager.js`
- `scripts/foundry/canvas-replacement.js`

Status:
1. Walls are functionally reproduced in Three (incl. door controls and level-aware visibility).
2. Ambient/elevated light icon and LOS-clipped radius rendering is in place.
3. Lifecycle is integrated in canvas replacement init/dispose flow.

---

## 3) Full Rendered Subsystem Inventory (Authoritative Scope)

Derived from Foundry canvas layer/placeable structure:
- `foundryvttsourcecode/resources/app/client/canvas/layers/_module.mjs`
- `foundryvttsourcecode/resources/app/client/canvas/placeables/_module.mjs`

### 3.1 Core scene content

1. Background/map surface
2. Grid
3. Tiles (ground + overhead)
4. Tokens

### 3.2 Placeable edit/overlay systems

1. Walls + door controls
2. Ambient lights (icons + radius fields)
3. Ambient sounds (icons + audible fields)
4. Drawings
5. Notes
6. Measured templates
7. Regions

### 3.3 Controls layer overlays

1. Door control container parity
2. Selection rectangle
3. Rulers/measurement paths
4. User cursors
5. Pings (onscreen and offscreen indicators)

### 3.4 Perception/effects-coupled rendered outputs

1. Vision/FOV/fog visuals
2. Darkness/light response visuals
3. Source-shape clipping against walls (lights/sounds/doors where applicable)

---

## 4) Current Coverage vs Required Coverage

## Already substantially covered

1. Background/grid/tiles/tokens (Three primary path)
2. Walls + doors
3. Ambient light icons/radius (plus Map Shine enhanced lights)
4. Drawings/notes/templates managers exist
5. Vision/fog/lighting custom rendering path exists

## Partial / parity-hardening required

1. Drawings: handle/state/style parity gaps in edit mode.
2. Notes: icon-state/hover/control parity hardening.
3. Templates: style/rotation/snapping parity hardening.
4. Tile edit overlays: edit handles and transform affordance parity.

## Missing / high-priority additions

1. Ambient sounds render subsystem parity (icon + field + state)
2. Shared ControlIcon-equivalent abstraction for all Three edit gizmos
3. Regions rendered authoring overlays
4. Controls-layer overlays parity (selection rect/rulers/cursors/pings) under Three ownership

---

## 5) Priority Plan (Full Reproduction)

## P0 - Critical parity blockers (must-do first)

### P0-A Ambient Sound rendering parity

References:
- `.../canvas/placeables/sound.mjs`
- `.../canvas/layers/sounds.mjs`

Deliverables:
1. `SoundIconManager` for Three icon + radius field rendering.
2. State parity: hidden/path-missing/audible-darkness conditions.
3. Live create/drag radius preview parity.
4. Visibility and wall-muffling visualization parity where rendered.

### P0-B Shared Three control-gizmo system

Reference:
- `.../canvas/containers/elements/control-icon.mjs`

Deliverables:
1. Shared `ControlGizmoFactory` (icon, border, optional elevation tag, hover/selected states).
2. Migrate existing light managers to shared primitives.
3. Reuse for sounds/notes/templates/regions for consistency.

### P0-C Controls-layer visual parity foundation

Reference:
- `.../canvas/layers/controls.mjs`

Deliverables:
1. Three-native selection rectangle parity.
2. Ruler path rendering parity.
3. Ping and cursor overlay parity.

## P1 - Existing subsystem parity hardening

### P1-A Drawings parity pass

1. Shape style parity (stroke/fill/text baseline).
2. Handle/hover/control visuals parity in edit mode.

### P1-B Notes parity pass

1. Icon/hover/control parity cleanup.
2. Strict visibility parity with Foundry placeable checks.

### P1-C Templates parity pass

1. Type-specific style parity.
2. Rotation/snapping and tool workflow parity.

### P1-D Tile edit affordance parity

1. Transform/rotate/resize overlay handles in Three.
2. Tool-mode behavior parity with active layer transitions.

## P2 - Remaining editor ecosystem parity

### P2-A Regions rendering + edit overlays

1. Region visual mesh/outline parity.
2. Region edit-mode handles and selection states.

### P2-B Overlay reliability and cleanup

1. Full lifecycle/teardown stress testing for all overlays.
2. Remove stale PIXI-only fallback paths once Three parity is confirmed stable.

---

## 6) Implementation Work Packages

### WP-1: Shared gizmo infrastructure

1. Build `ControlGizmoFactory`.
2. Centralize style tokens and state transitions.
3. Backport existing wall/light managers onto shared infrastructure.

### WP-2: Sound rendering subsystem

1. Add `scripts/scene/sound-icon-manager.js`.
2. Hook create/update/delete + canvasReady + darkness refresh.
3. Add interaction-manager create/drag preview integration.

### WP-3: Controls overlay migration

1. Add/expand Three overlay manager for select rect, ruler, pings, cursors.
2. Ensure tool/layer ownership avoids double-render with PIXI controls.

### WP-4: Parity hardening sweep

1. Drawings/notes/templates/tile edit overlays gap closure.
2. Region layer rendering/authoring parity.

---

## 7) Validation Gates (Required for “Parity Complete”)

A subsystem is complete only when all gates pass:

1. CRUD parity: create/update/delete visual sync.
2. Visibility parity: hidden/permission/LOS/darkness/elevation-floor behavior.
3. Tool parity: hover/select/drag/rotate/snap behaviors.
4. Overlay parity: active layer transitions do not show stale or duplicate overlays.
5. Lifecycle parity: scene switch and teardown leave no stale meshes/textures/hooks.
6. Performance parity: dense scenes stay responsive and avoid frame spikes.

---

## 8) Explicit Success Criteria

Map Shine can claim rendered parity when:

1. Every Foundry canvas-rendered feature in Sections 3.1-3.4 has an active Three render path.
2. PIXI rendering is not required for normal gameplay/edit visuals (except temporary compatibility bridges).
3. Layer/tool switches produce the same practical visual affordances users expect from Foundry.
4. Multi-level scenes preserve all parity behavior under perspective/elevation filtering.

---

## 9) Immediate Next Slice (Start Here)

1. Implement `ControlGizmoFactory` and migrate both light managers.
2. Implement `SoundIconManager` v1 (icon + radius + visibility + state styling).
3. Wire sound create/drag radius preview in `InteractionManager`.
4. Add parity checklist for controls-layer overlays (selection/ruler/ping/cursor) and begin migration.

This sequence maximizes parity impact while reusing the proven wall/light architecture pattern.

### Implementation Status Update (Mar 9, 2026)

Completed from this slice:
1. `SoundIconManager` v1 is implemented and wired in canvas lifecycle (`create/update/delete`, visibility refresh, radius ring rendering, state tint/icon updates).
2. `InteractionManager` now supports ambient sound create+drag radius preview parity on Sounds layer (sound draw tool, GM placement, live radius preview, drag-move updates).
3. Ambient sound creation now seeds Levels-compatible elevation/range defaults through `applyAmbientSoundLevelDefaults(...)`.
4. Added shared `ControlGizmoFactory` and migrated both `LightIconManager` and `EnhancedLightIconManager` to shared outlined sprite + radius material primitives.

Next active item:
1. Start controls-layer overlay parity migration checklist (selection rectangle / ruler path / pings / cursors) under Three ownership (P0-C / WP-3).

### Controls-Layer Overlay Parity Checklist (P0-C / WP-3)

Scope: overlays that are expected to remain visually correct while tools/layers switch and while Three owns input.

1. Selection rectangle (drag marquee)
   - [x] Three-owned screen-space overlay + world-projected shadow are active.
   - [x] Pointer-up teardown hides overlay/shadow and applies marquee selection.
   - [x] Layer/tool context teardown added to avoid stale marquee overlays when leaving token-selection context.
   - [ ] Validate behavior parity for additive/subtractive marquee semantics against Foundry edge cases.

2. Ruler / movement path overlay
   - [x] Movement preview rendering delegated to `MovementPreviewEffectV2`.
   - [x] Preview clear path exists and is called on move commit/cancel.
   - [x] Context teardown now clears stale path preview when switching away from token-selection context.
   - [ ] Add explicit ruler-only parity pass (waypoints, labels, and tool transitions).

3. Ping overlay
   - [x] Long-press ping arming/cancel flow mirrors ControlsLayer behavior.
   - [x] Context teardown cancels pending long-press timer when leaving token-selection context.
   - [ ] Validate pull-ping parity and multiplayer display timing under tool/layer transitions.

4. Cursor overlay
   - [x] Three-owned pointer move updates `canvas.mousePosition` and broadcasts cursor activity.
   - [ ] Confirm parity with Foundry cursor visibility rules across permissions and inactive tools.
   - [ ] Add regression checks for scene/layer switches to guarantee no stale cursor state.
