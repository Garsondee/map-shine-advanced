# PIXI-to-Three.js Interaction Replacement Plan

## Problem Statement

Map Shine Advanced replaces Foundry VTT's canvas rendering with Three.js, but three key PIXI-based interaction systems still rely on the PIXI canvas being overlaid on top. This causes:

- **Input routing confusion**: The `InputRouter` must constantly toggle `pointerEvents` between PIXI and Three.js canvases, leading to missed clicks, race conditions on layer transitions, and stale pointer state.
- **Visual artifacts**: In V2 mode the PIXI canvas is set to `opacity: 0` but still receives pointer events, so users click on invisible elements.
- **Module incompatibility**: Other modules that modify these PIXI systems (e.g., wall types, custom HUD buttons, lighting extensions) work through PIXI's event system, which breaks when our InputRouter interferes.

The three systems that need Three.js-native replacements are:

1. **Light placement mode** (drag-to-create ambient lights)
2. **Wall placement mode** (click-to-place wall segments with chaining)
3. **Token right-click HUD** (the context menu that appears on right-click)

---

## Current State (Map Shine)

### InputRouter (`scripts/foundry/input-router.js`)
- Toggles between `InputMode.PIXI` and `InputMode.THREE` by flipping `pointerEvents` CSS on both canvases.
- When walls or lighting layer is active → `InputMode.PIXI` (PIXI canvas receives all clicks).
- When tokens layer + select tool → `InputMode.PIXI` (Foundry handles token selection natively).
- Default → `InputMode.THREE` (Three.js canvas receives clicks).

### ControlsIntegration (`scripts/foundry/controls-integration.js`)
- `_isPixiEditorOverlayNeeded()` returns true for walls/lighting contexts.
- `_applyPixiEditorOverlayGate()` makes the PIXI canvas visible and interactive.
- In V2 mode, PIXI canvas gets `opacity: 0` but still `pointerEvents: auto` — invisible but interactive.

### InteractionManager (`scripts/scene/interaction-manager.js`)
- Handles Three.js raycasting for token selection, tile selection, light gizmo dragging.
- Already has light translate gizmo support (`_lightTranslate`).
- Already has token right-click → click-to-move behavior.
- Gates interactions via `_isTokenSelectionContextActive()`, `_isWallsContextActive()`, etc.

---

## System 1: Light Placement Mode

### How It Works in Foundry VTT

**Files:**
- `client/canvas/layers/lighting.mjs` — `LightingLayer`
- `client/canvas/placeables/light.mjs` — `AmbientLight`
- `client/canvas/placeables/placeable-object.mjs` — base `PlaceableObject`

**Flow:**

1. **Activation**: User selects the Lighting tool group. `LightingLayer.prepareSceneControls()` defines the tool palette (light, day, night, reset, clear). Active tool defaults to `"light"`.

2. **Layer activation**: `LightingLayer._activate()` is called. All existing AmbientLight placeables get `refreshField: true` to show their radius outlines. Each AmbientLight has a `ControlIcon` (a small lightbulb icon at its position).

3. **Drag-to-create flow** (`_onDragLeftStart` → `_onDragLeftMove` → `_onDragLeftDrop`):
   - `_canDragLeftStart` prevents creating if a preview already exists.
   - `_onDragLeftStart`: Snaps origin to grid (unless Shift held). Creates a temporary `AmbientLightDocument` at origin. Creates a preview `AmbientLight` placeable, adds it to `this.preview` container, and calls `preview.draw()`.
   - `_onDragLeftMove`: Calculates radius from origin to current mouse position. Sets `config.dim` (in scene distance units) and `config.bright = dim/2`. Calls `preview.initializeLightSource()` and `refreshState`.
   - On drop: The preview document is committed via `AmbientLightDocument.create()`.
   - `_onDragLeftCancel`: Cleans up preview, refreshes lighting.

4. **Existing light interaction**:
   - Right-click on an AmbientLight → toggles `hidden` (not a HUD, just `doc.update({hidden: !hidden})`).
   - Double-right-click → does nothing (`_canConfigure` returns false).
   - Drag existing light → moves it (standard PlaceableObject drag).
   - Mouse wheel on hovered light → rotates angle (if not 360°).

5. **ControlIcon**: Each light renders a 60×uiScale px icon at its center. Icon texture switches between `CONFIG.controlIcons.light` and `CONFIG.controlIcons.lightOff`. Border color is orange when hidden.

**Key data points for reproduction:**
- Grid snapping via `this.getSnappedPoint(origin)` (inherited from PlaceablesLayer).
- Radius calculation: `Math.hypot(dest.x - origin.x, dest.y - origin.y)` in pixels → converted to scene distance units via `radius * (canvas.dimensions.distance / canvas.dimensions.size)`.
- Document creation: `AmbientLightDocument.create(previewDoc.toObject(), {parent: canvas.scene})`.

**Module extension points:**
- `CONFIG.controlIcons.light` / `CONFIG.controlIcons.lightOff` — icon textures.
- `Hooks.callAll('drawAmbientLight', ...)` — after drawing.
- `Hooks.callAll('createAmbientLight', ...)` — after creation.
- `LightingLayer.prepareSceneControls()` — can be overridden to add tools.
- `AmbientLight._getLightSourceData()` — can be overridden for custom source data.

---

## System 2: Wall Placement Mode

### How It Works in Foundry VTT

**Files:**
- `client/canvas/layers/walls.mjs` — `WallsLayer`
- `client/canvas/placeables/placeable-object.mjs` — base `PlaceableObject`

**Flow:**

1. **Tool palette**: `WallsLayer.prepareSceneControls()` defines 12 tools:
   - `select` — select/move existing walls
   - `walls` — basic wall (blocks all senses)
   - `terrain` — limited sight/light/sound
   - `invisible` — blocks movement only
   - `ethereal` — blocks sight/light only
   - `doors` — standard door
   - `secret` — secret door
   - `window` — proximity-based sight/light
   - `clone` — clone last-used wall type
   - `snap` — toggle force-snap to vertices
   - `closeDoors` — button: close all doors
   - `clear` — button: delete all walls

2. **Wall data from tool**: `#getWallDataFromActiveTool(tool)` produces the `WallDocument` defaults:
   ```js
   { light: NORMAL, sight: NORMAL, sound: NORMAL, move: NORMAL }
   // Modified per tool type (e.g., terrain → LIMITED for sight/light/sound)
   // Doors get door: DOOR, secret gets door: SECRET
   // Windows get PROXIMITY sight/light with threshold
   ```

3. **Grid snapping**: `WallsLayer.getSnappedPoint(point)` uses high-resolution snapping:
   ```js
   mode: CENTER | VERTEX | CORNER | SIDE_MIDPOINT
   resolution: size >= 128 ? 8 : (size >= 64 ? 4 : 2)
   ```
   This is much finer than token snapping (which uses `TOP_LEFT_CORNER, resolution: 1`).

4. **Click-to-place flow** (`_onDragLeftStart` → `_onDragLeftMove` → `_onDragLeftDrop`):
   - `_onDragLeftStart`: Clears preview container. Gets wall data from active tool. Determines start point: if chaining (`_chain` or CTRL held) and a `_last.point` exists, uses that; otherwise snaps origin. Creates `WallDocument` with `c = [x1,y1,x1,y1]` (collapsed). Creates preview Wall, calls `wall.draw()`.
   - `_onDragLeftMove`: Updates the endpoint `c[2..3]` to the snapped destination. Calls `preview.refresh()`. Sets state to CONFIRMED.
   - `_onDragLeftDrop`:
     - If CTRL held → set `_chain = true`, prevent default.
     - If CONFIRMED → finalize coordinates, create via `WallDocument.create()`.
     - After creation completes → if chaining, immediately starts a new wall from the endpoint.
     - Collapsed walls (start == end) are ignored.
   - `_onDragLeftCancel` / `_onClickRight`: Cancels chaining, resets `_last`.

5. **Chaining mechanism**:
   - `_chain` boolean + `_last.point` track chaining state.
   - When chaining: the next wall's start point = previous wall's end point.
   - CTRL key initiates/continues chaining. Releasing CTRL ends it.
   - Undo during chaining (`_onUndoCreate`): deletes last wall, re-anchors preview to the prior wall's start point.

6. **Wall rendering**: Walls are rendered as PIXI Graphics lines between their two endpoints. Each wall has configurable sense types per-channel (light, sight, sound, move).

**Module extension points:**
- `Hooks.callAll('createWall', ...)` — after wall creation.
- `WallsLayer.prepareSceneControls()` — can add custom wall types.
- `#getWallDataFromActiveTool` — private, but modules can override via Libwrapper.
- Wall-Height module adds `flags['wall-height']` with `top`/`bottom` elevation values.

---

## System 3: Token Right-Click HUD

### How It Works in Foundry VTT

**Files:**
- `client/applications/hud/token-hud.mjs` — `TokenHUD`
- `client/applications/hud/placeable-hud.mjs` — `BasePlaceableHUD`
- `client/applications/hud/container.mjs` — `HeadsUpDisplayContainer`
- `templates/hud/token-hud.hbs` — Handlebars template
- `client/canvas/placeables/token.mjs` — Token's `_onClickRight`, `_canHUD`
- `client/canvas/placeables/placeable-object.mjs` — base `_onClickRight`

**Trigger flow:**

1. **Right-click on token** → `MouseInteractionManager` checks `permissions.clickRight` which calls `Token._canHUD()`:
   ```js
   _canHUD(user, event) {
     if (this.layer._draggedToken) return false;
     if (!this.layer.active || this.isPreview) return false;
     if (canvas.controls.ruler.active || ...) return false;
     return user.isGM || (this.actor?.testUserPermission(user, "OWNER") ?? false);
   }
   ```

2. If permitted → `PlaceableObject._onClickRight()`:
   ```js
   _onClickRight(event) {
     if (this.layer.hud) {
       const releaseOthers = !this.#controlled && !event.shiftKey;
       this.control({releaseOthers});
       if (this.hasActiveHUD) this.layer.hud.close();
       else this.layer.hud.bind(this);
     }
     if (!this._propagateRightClick(event)) event.stopPropagation();
   }
   ```
   - If HUD is already open for this token → close it (toggle behavior).
   - Otherwise → `hud.bind(this)` which calls `hud.render({force: true, position: true, object})`.

3. **Token overrides `_onClickRight2`** (double-right-click):
   - If owner + TOKEN_CONFIGURE permission → opens config sheet.
   - Otherwise → toggles target state.

**HUD Architecture:**

- `HeadsUpDisplayContainer` is an `ApplicationV2` rendered as `#hud` div, canvas-sized, positioned over the canvas using CSS transforms matching `canvas.primary.getGlobalPosition()` and `canvas.stage.scale`.
- `TokenHUD` extends `BasePlaceableHUD` which extends `ApplicationV2`.
- HUD is a `<form>` element inserted into `#hud` div.
- `BasePlaceableHUD._insertElement()` appends to `document.getElementById("hud")`.

**Positioning** (`BasePlaceableHUD._updatePosition`):
```js
_updatePosition(position) {
  const s = canvas.dimensions.uiScale;
  const {x: left, y: top} = this.#object.position;
  const {width, height} = this.#object.bounds;
  Object.assign(position, {left, top, width: width/s, height: height/s});
  position.scale = s;
  return position;
}
```
Position is in **canvas coordinates** (PIXI scene space), then scaled by `uiScale`. The `#hud` container's CSS transform handles the screen-space conversion.

**HUD Template** (`token-hud.hbs`): Three columns:
- **Left column**: Elevation input, sort up/down buttons, config gear button.
- **Middle column**: Bar1 and Bar2 attribute inputs (HP, etc).
- **Right column**: Visibility toggle (GM only), status effects palette, movement action palette, target button, combat toggle button.

**HUD Context** (`TokenHUD._prepareContext`):
```js
{
  canConfigure, canToggleCombat,
  displayBar1, bar1Data, displayBar2, bar2Data,
  combatClass, targetClass,
  statusEffects,        // from _getStatusEffectChoices()
  movementActions,      // from _getMovementActionChoices()
  movementActionsConfig // CONFIG.Token.movement.actions[current]
}
```

**HUD Actions:**
- `combat` → `#onToggleCombat` — toggles combatant status
- `target` → `#onToggleTarget` — toggles target state
- `effect` → `#onToggleEffect` — toggles status effect (left-click: toggle, right-click: overlay)
- `movementAction` → `#onSelectMovementAction` — sets movement action
- `config` → opens config sheet
- `visibility` → toggles hidden
- `locked` → toggles locked
- `sort` → send to back / bring to front
- `togglePalette` → expands effects/movement tray
- Form submission → `_onSubmit` → attribute bar changes, elevation changes

**Module extension points:**
- `CONFIG.Token.hudClass` — can replace the entire HUD class.
- `CONFIG.statusEffects` — array of status effects shown in the HUD palette.
- `CONFIG.Token.movement.actions` — movement action definitions.
- `Hooks.callAll('renderTokenHUD', ...)` — after HUD renders (modules add custom buttons here).
- `CONFIG.controlIcons` — icon paths used in HUD buttons.
- Template `token-hud.hbs` — can be overridden.
- The HUD is pure HTML/CSS, positioned in `#hud` div.

---

## Replacement Strategy

### Guiding Principles

1. **Delegate to Foundry APIs, not PIXI rendering**: The goal is to handle the *interaction* (pointer events, coordinate transforms) in Three.js space but still use Foundry's document APIs (`WallDocument.create()`, `AmbientLightDocument.create()`, `canvas.hud.token.bind()`) for the actual operations. This ensures module compatibility.

2. **HTML overlays, not Three.js meshes**: For the Token HUD, use HTML elements positioned over the Three.js canvas (same approach Foundry uses — HTML over PIXI). This preserves module compatibility for HUD extensions.

3. **Coordinate bridge**: All Three.js world coordinates must be convertible to Foundry canvas coordinates for document creation.

4. **Eliminate PIXI overlay for these modes**: Once Three.js handles the interaction, the InputRouter should no longer need to switch to PIXI mode for walls/lighting/token-HUD.

---

### Phase 1: Token Right-Click HUD (Highest Value, Lowest Risk)

**Approach**: Don't replace the HUD itself — just fix the *trigger mechanism*.

The TokenHUD is pure HTML rendered into `#hud`. It doesn't need PIXI at all. The problem is that the right-click that triggers it goes through PIXI's `MouseInteractionManager` → `PlaceableObject._onClickRight()` → `canvas.hud.token.bind(token)`.

**Plan:**

1. **Three.js right-click intercept**: In `InteractionManager.onPointerDown` (button === 2), when a Three.js token hit is detected:
   - Find the corresponding Foundry `Token` placeable via `canvas.tokens.get(tokenId)`.
   - Check `token._canHUD(game.user, event)` to respect permissions.
   - Call `canvas.hud.token.bind(token)` directly — this is the same call PIXI makes.
   - Call `token.control({releaseOthers: !event.shiftKey})` for selection consistency.

2. **HUD positioning fix**: `BasePlaceableHUD._updatePosition` reads `this.#object.position` (PIXI coords) and `this.#object.bounds`. Since the token PIXI placeable still exists (hidden), these values are still valid. The `#hud` container transform is based on `canvas.primary.getGlobalPosition()` + stage scale, which should align with Three.js if our camera is synced.

3. **Toggle behavior**: Check `token.hasActiveHUD` — if already active, call `canvas.hud.token.close()` instead.

4. **Module compatibility**: Since we call `canvas.hud.token.bind(token)` with the real Foundry Token placeable, the HUD renders normally through Foundry's template system. Module hooks (`renderTokenHUD`) fire as expected. Custom HUD classes via `CONFIG.Token.hudClass` work automatically.

**Risk**: Low. We're just providing an alternate trigger path, not replacing the HUD.

**Files to modify:**
- `scripts/scene/interaction-manager.js` — add right-click → HUD trigger
- `scripts/foundry/input-router.js` — remove token layer from PIXI-mode requirement (at least for right-click)

---

### Phase 2: Light Placement Mode (Medium Risk)

**Approach**: Reproduce the drag-to-create interaction in Three.js, but still create the document through Foundry APIs.

**Plan:**

1. **Three.js light placement state machine**:
   - States: `NONE` → `POTENTIAL` (pointerdown) → `CONFIRMED` (pointermove with distance) → `COMPLETED` (pointerup).
   - On pointerdown: Raycast to ground plane → get world XY → convert to Foundry coords → snap to grid.
   - On pointermove: Calculate radius from origin to current position.
   - On pointerup: Create `AmbientLightDocument` via `AmbientLightDocument.create(data, {parent: canvas.scene})`.

2. **Visual preview**: Render a Three.js circle mesh (wireframe or translucent disc) showing the light radius during drag. This replaces the PIXI preview that Foundry draws.

3. **Existing light interaction** (already partially working):
   - We already have `_lightTranslate` gizmo for dragging lights.
   - We already have `LightIconManager` for showing light icons.
   - Need to add: right-click on light icon → toggle hidden (`doc.update({hidden: !hidden})`).

4. **Grid snapping**: Use the same snapping logic as Foundry:
   ```js
   const snapped = canvas.grid.getSnappedPoint({x, y}, {mode: M.CENTER | M.VERTEX | M.CORNER | M.SIDE_MIDPOINT, resolution: ...});
   ```
   This calls Foundry's grid API directly, so any grid module customizations are respected.

5. **Radius calculation**: Same formula as Foundry:
   ```js
   const radiusPx = Math.hypot(dest.x - origin.x, dest.y - origin.y);
   const dim = radiusPx * (canvas.dimensions.distance / canvas.dimensions.size);
   const bright = dim / 2;
   ```

**Module compatibility:**
- Document creation goes through Foundry's API → `preCreateAmbientLight` / `createAmbientLight` hooks fire.
- We call `canvas.grid.getSnappedPoint()` → grid module overrides work.
- Light source initialization happens via Foundry's document system after creation.

**Files to modify:**
- `scripts/scene/interaction-manager.js` — add light placement state machine
- `scripts/scene/light-icon-manager.js` — ensure icons are interactive in gameplay mode
- `scripts/foundry/input-router.js` — remove LightingLayer from PIXI-only routing

---

### Phase 3: Wall Placement Mode (Highest Risk)

**Approach**: Reproduce the click-to-place + chaining interaction in Three.js.

**Plan:**

1. **Three.js wall placement state machine**:
   - States mirror Foundry: `NONE` → `POTENTIAL` → `CONFIRMED` → `COMPLETED`.
   - Track `_chain` boolean and `_lastWallEndpoint` for chaining.
   - Track active wall type from `game.activeTool` → map to wall data defaults (same logic as `#getWallDataFromActiveTool`).

2. **Pointer flow**:
   - **Click** (pointerdown): Raycast to ground → Foundry coords → snap. Store as wall start point. Begin drawing a preview line.
   - **Move** (pointermove while active): Update endpoint of preview line (snapped).
   - **Release** (pointerup or second click): Finalize wall. Create via `WallDocument.create()`. If CTRL held → chain (start new wall from endpoint).
   - **Right-click or Escape**: Cancel current wall, end chaining.

3. **Visual preview**: Render a Three.js `Line` or thin `BoxGeometry` between start and end points during placement. Color-code by wall type (same colors Foundry uses for different wall types).

4. **Grid snapping**: Use Foundry's `WallsLayer.prototype.getSnappedPoint()` or replicate:
   ```js
   canvas.grid.getSnappedPoint({x, y}, {
     mode: M.CENTER | M.VERTEX | M.CORNER | M.SIDE_MIDPOINT,
     resolution: size >= 128 ? 8 : (size >= 64 ? 4 : 2)
   });
   ```

5. **Wall type data**: Read from Foundry's tool system:
   ```js
   const tool = game.activeTool; // 'walls', 'terrain', 'invisible', 'doors', etc.
   // Map tool → wall data defaults (replicate #getWallDataFromActiveTool)
   ```
   To pick up module extensions, we can try to call Foundry's private method via the layer:
   ```js
   // Option A: Access via the layer instance (if not too private)
   // Option B: Replicate the mapping (less compatible but more reliable)
   ```

6. **Chaining**: Mirror Foundry's `_chain` / `_last` / CTRL-key logic exactly.

7. **Existing wall rendering**: Our `WallManager` already renders walls in Three.js. New walls created via document API will trigger `createWall` hooks which our WallManager picks up.

8. **Select tool**: For the wall `select` tool (moving endpoints, selecting walls), this is the hardest part. Foundry uses PIXI hit-testing on wall line segments. We may need to:
   - Render thin Three.js meshes for each wall segment that are raycast-hittable.
   - Handle endpoint dragging (grab closest endpoint, move it, update document).
   - Handle multi-select (drag rectangle).

**Module compatibility:**
- Document creation via Foundry API → all hooks fire.
- Wall-Height module: Our existing `levels-create-defaults.js` already seeds wall-height flags on preCreate.
- Custom wall types added via `prepareSceneControls` overrides → we read `game.activeTool` directly.

**Files to modify:**
- `scripts/scene/interaction-manager.js` — add wall placement state machine
- `scripts/scene/wall-manager.js` — add interactive wall meshes for select mode
- `scripts/foundry/input-router.js` — remove WallsLayer from PIXI-only routing

---

## Phase 4: Remove PIXI Overlay Dependency

Once all three systems are implemented:

1. **InputRouter simplification**: Remove walls/lighting from `pixiInteractiveLayers` and tool sets. The router should only fall back to PIXI for systems we haven't replaced (drawings, regions, sounds, notes, templates).

2. **ControlsIntegration cleanup**: Remove `_isPixiEditorOverlayNeeded()` checks for walls/lighting.

3. **V2 gate**: In V2 mode, the PIXI canvas should never need to be visible or interactive for these three systems.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| HUD positioning drift between Three.js and PIXI coordinates | HUD reads from PIXI token placeable (still exists). Camera sync keeps them aligned. |
| Module-added wall types not recognized | Read `game.activeTool` and call Foundry's snapping APIs directly. |
| Wall select/endpoint drag is complex | Defer to Phase 3b; keep PIXI fallback for select tool initially. |
| Other modules hook into PIXI MouseInteractionManager callbacks | Our approach calls Foundry document APIs which trigger the same hooks. |
| Token HUD modules add buttons via `renderTokenHUD` hook | We call `canvas.hud.token.bind()` → Foundry renders the HUD → hooks fire normally. |
| Performance of Three.js raycasting for wall endpoint selection | Use spatial indexing (existing WallManager data structures). |

---

## Implementation Priority

1. **Phase 1: Token HUD** — Quick win, low risk, high user-facing impact.
2. **Phase 2: Light placement** — Medium complexity, partially implemented already.
3. **Phase 3: Wall placement** — Highest complexity, biggest payoff for V2 elimination of PIXI.
4. **Phase 4: Cleanup** — Only after all three are stable.

---

## Key Foundry APIs to Use (Not PIXI)

These are the Foundry document-level APIs that bypass PIXI entirely:

```js
// Light creation
const cls = foundry.utils.getDocumentClass("AmbientLight");
await cls.create(data, {parent: canvas.scene});

// Wall creation
const cls = foundry.utils.getDocumentClass("Wall");
await cls.create(data, {parent: canvas.scene});

// Token HUD
canvas.hud.token.bind(tokenPlaceable);  // Opens HUD
canvas.hud.token.close();               // Closes HUD

// Grid snapping
canvas.grid.getSnappedPoint({x, y}, {mode, resolution});

// Token control
token.control({releaseOthers: true});

// Permission checks
token._canHUD(game.user, event);
user.isGM;
document.canUserModify(user, "update");
```

---

## Open Questions for User

1. For wall placement Phase 3: should we implement the `select` tool (move endpoints, multi-select) in Three.js immediately, or keep it as a PIXI fallback initially?
2. Should the light placement preview be a simple circle, or should we render an actual light effect preview (matching what Foundry shows)?
3. Are there specific modules that modify the Token HUD that we need to test against?
