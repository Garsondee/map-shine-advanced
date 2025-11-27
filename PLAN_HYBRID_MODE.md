# Plan: Hybrid Rendering Mode (Three.js + Native PIXI)

## Objective
Allow the user to "swap" between our custom Three.js rendering engine and Foundry VTT's native PIXI-based layers for technical tasks (Walls, Lighting, Sounds, Drawings, Regions, Tiles). This ensures users can use the familiar Foundry tools for map building while keeping the high-fidelity Three.js engine for gameplay.

## Analysis of Foundry VTT Source Code
Examination of `foundryvttsourcecode/resources/app/client/canvas/layers` confirms the existence of the following layer implementations which we need to support:
- **Lighting**: `lighting.mjs` (`LightingLayer`)
- **Journals**: `notes.mjs` (`NotesLayer`)
- **Walls**: `walls.mjs` (`WallsLayer`)
- **Sounds**: `sounds.mjs` (`SoundsLayer`)
- **Drawings**: `drawings.mjs` (`DrawingsLayer`)
- **Regions**: `regions.mjs` (`RegionLayer` - V12+)
- **Tiles**: `tiles.mjs` (`TilesLayer`)
- **Templates**: `templates.mjs` (`TemplateLayer`)

## Strategy
We will implement a **Context-Aware Hybrid System** that monitors the active tool/layer in Foundry.
- **Gameplay Mode (Tokens/Exploration)**: Three.js renders everything. PIXI layers are hidden.
- **Edit Mode (Technical Layers)**: When a specific tool is selected (e.g., Wall Tool), the corresponding Three.js implementation is hidden (if applicable), and the native PIXI layer is revealed and made interactive.

## Implementation Steps

### 1. Modify `TileManager` (scripts/scene/tile-manager.js)
The `TileManager` needs a global visibility toggle to hide our 3D tile sprites when the user is editing tiles in the native PIXI layer.

- **Action**: Add `setVisibility(visible)` method.
- **Logic**: Iterate through `this.tileSprites` and set `sprite.visible = visible`. (Note: must respect individual hidden state when turning back on).

### 2. Modify `CanvasReplacement` (scripts/foundry/canvas-replacement.js)
This is the core controller. We need to refactor `configureFoundryCanvas` and `setupInputArbitration`.

#### A. PIXI Container Configuration
Currently, we set `opacity: 0` on the PIXI container. This must change.
- **Change**: Set `pixiCanvas.style.opacity = '1'` (Fully visible).
- **Change**: Explicitly hide the **Permanent Replacement Layers** (Background, Grid, Tokens) by setting their `.visible` property to `false`. This ensures they never show up, even when PIXI is visible.

#### B. Layer Visibility Management
Refactor `manageFoundryLayers` to `updateLayerVisibility()`.

**Logic**:
1. **Always Hide**: `canvas.background`, `canvas.grid`, `canvas.tokens`, `canvas.weather`/`environment`.
2. **Dynamic Layers**: Check `canvas.activeLayer`.
   - If **WallsLayer** is active:
     - Show PIXI `canvas.walls`.
     - Hide Three.js `wallManager`.
   - If **TilesLayer** is active:
     - Show PIXI `canvas.tiles`.
     - Hide Three.js `tileManager`.
   - If **LightingLayer** is active:
     - Show PIXI `canvas.lighting`.
   - If **SoundsLayer** is active:
     - Show PIXI `canvas.sounds`.
   - If **DrawingsLayer** is active:
     - Show PIXI `canvas.drawings`.
   - If **TemplateLayer** is active:
     - Show PIXI `canvas.templates`.
   - If **NotesLayer** is active:
     - Show PIXI `canvas.notes`.
   - If **RegionLayer** is active:
     - Show PIXI `canvas.regions` (if exists).

3. **Fallback (Gameplay Mode)**:
   - If none of the above are active (e.g., TokenLayer):
     - Hide all PIXI Dynamic Layers.
     - Show Three.js `wallManager` and `tileManager`.

#### C. Input Arbitration
Update `setupInputArbitration` to sync with the visibility logic.
- **Objective**: Intelligently route mouse/pointer events to either the PIXI canvas (for native tools) or the Three.js canvas (for gameplay/tokens).
- **Mechanism**:
  1. Listen to `changeSidebarTab` (switching between Token, Wall, Lighting controls, etc.).
  2. Listen to `renderSceneControls` (switching active tools within a tab).
  3. Listen to `canvasReady` (initial load).

- **Logic Flow**:
  ```javascript
  const activeLayer = canvas.activeLayer?.name; // e.g. "WallsLayer", "TokenLayer"
  const activeTool = game.activeTool; // e.g. "draw", "select", "target"
  
  // Define "Native Mode" layers
  const NATIVE_LAYERS = [
    'WallsLayer',
    'LightingLayer', 
    'SoundsLayer',
    'TemplateLayer',
    'DrawingsLayer',
    'NotesLayer',
    'RegionLayer'
  ];
  
  const isNativeMode = NATIVE_LAYERS.some(layer => activeLayer?.includes(layer));
  
  if (isNativeMode) {
      // ENABLE native inputs
      pixiCanvas.style.pointerEvents = 'auto';
      // Ensure PIXI is on top
      pixiCanvas.style.zIndex = '10';
      
      // OPTIONAL: Hide specific Three.js managers if they conflict visually
      // e.g., Hide Three.js walls if we are drawing native walls
      if (activeLayer.includes('WallsLayer')) {
          mapShine.wallManager.setVisibility(false);
      }
  } else {
      // GAMEPLAY Mode (Tokens, etc.)
      // DISABLE native inputs to let clicks fall through to Three.js
      pixiCanvas.style.pointerEvents = 'none';
      
      // Ensure Three.js managers are visible
      mapShine.wallManager.setVisibility(true);
      mapShine.tileManager.setVisibility(true);
  }
  ```

- **Z-Index Strategy**:
  - **PIXI Canvas**: `z-index: 10` (Always above Three.js).
  - **Three.js Canvas**: `z-index: 1` (Background).
  - **Input Blocking**: We control input *only* via `pointer-events`.
    - `pointer-events: none` on PIXI makes it "transparent" to clicks, allowing them to hit the Three.js canvas below.
    - `pointer-events: auto` on PIXI makes it catch all clicks.

- **Validation**:
  - Validated `game.activeTool` relies on `ui.controls.tool.name`, which is the standard way to check tool state.
  - Validated `renderSceneControls` hook fires whenever tools are clicked/changed.

### 4. Region Layer Strategy (V12+ Feature)
The `RegionLayer` (new in V12) requires specific handling due to its complex interaction model (holes, polygons) and UI components (`RegionLegend`).

- **Detection**: Check for existence of `canvas.regions` before attempting to access it.
- **Tools**: `select`, `rectangle`, `ellipse`, `polygon`, `hole`.
- **UI Integration**: 
  - The `RegionLayer` automatically renders a `RegionLegend` application when activated. 
  - Our hybrid mode must ensure this legend is visible and interactive when the Regions tool is active.
- **Z-Index**: The native layer uses `zIndex: 100` (inactive) and `zIndexActive: 600`. Our `manageFoundryLayers` logic usually hides layers, but for Regions, we simply let the Input Arbitration show/hide the entire PIXI container.
- **Hybrid Logic**:
  - When `RegionLayer` is active:
    - `pixiCanvas` -> `opacity: 1`, `pointerEvents: auto`.
    - The user can draw regions, holes, and interact with the legend.
    - Three.js background remains visible.

### 5. System Swapping & Map Maker Mode
We will wrap the "Master Enable" functionality into a user-facing toggle called **"Map Maker Mode"**.
- **Concept**:
  - **Map Maker Mode (Active)**: Full access to Foundry VTT PIXI tools. Three.js system is paused/hidden. Used for building the map (Walls, Lights, Sounds).
  - **Gameplay Mode (Inactive)**: Three.js system is active. PIXI layers are hidden. Used for play.

- **UI Implementation**:
  - Add a prominent "Map Maker Mode" button to the Tweakpane header or Global Controls.
  - This button toggles the System Swap logic defined above.

- **Future Lighting System**:
  - *Note*: Eventually, we will implement a custom "Map Shine Lighting" mode for placing unique 3D lights directly in the Three.js view.
  - *Current Strategy*: Users will use "Map Maker Mode" (PIXI) to place standard Foundry lights, which are then synced to Three.js via the `LightingManager` (already partially implemented).

### 6. Additional Rendering Requirements
To support a full Gameplay Mode where PIXI is hidden, we must render the following elements in Three.js:
- **Drawings**: Text and shapes from the `DrawingsLayer`.
- **Journal Icons**: Note icons from the `NotesLayer`.
- **Measurements**: Ruler lines and templates from the `TemplateLayer` / Ruler interaction.

## Task List
1. [ ] **Edit `scripts/scene/tile-manager.js`**: Add `setVisibility(visible)` method.
2. [ ] **Edit `scripts/foundry/canvas-replacement.js`**:
    - [ ] Implement `enableSystem()` and `disableSystem()` methods.
    - [ ] Implement `setMapMakerMode(enabled)` (wraps Master Enable logic).
    - [ ] Update `configureFoundryCanvas` to set opacity 1.
    - [ ] Implement `updateLayerVisibility` for Hybrid Mode.
    - [ ] Update `setupInputArbitration`.
3. [ ] **Edit `scripts/ui/tweakpane-manager.js`**:
    - [ ] Add "Map Maker Mode" button/toggle to Global Controls.
    - [ ] Wire it to `canvasReplacement.setMapMakerMode`.
4. [ ] **Create New Managers** (for Gameplay Mode rendering):
    - [ ] `scripts/scene/drawing-manager.js`: Sync Drawings/Text.
    - [ ] `scripts/scene/note-manager.js`: Sync Journal Icons (Billboards).
    - [ ] `scripts/scene/template-manager.js`: Sync Templates/Measurements.
5. [ ] **Testing**: 
    - [ ] Verify "Map Maker Mode" button cleanly swaps systems.
    - [ ] Verify Drawings, Notes, and Ruler are visible in Gameplay Mode (Three.js).

## Notes
- **Background**: Always rendered by Three.js in Gameplay Mode.
- **Regions**: Checked for V12 compatibility.
- **Lighting**: Placed via PIXI (Map Maker Mode), rendered via Three.js.
