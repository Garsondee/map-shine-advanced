# Foundry VTT Scene Controls Integration Plan

## Executive Summary

This document outlines a comprehensive strategy for integrating Foundry VTT's left-hand palette controls (Scene Controls) with the Map Shine Advanced Three.js rendering system. The goal is to provide **reliable, globally safe access** to all Foundry editing tools while maintaining the visual quality of the Three.js renderer.

### Design Philosophy

**"Native First, Override Never"**

The core principle of this integration is to **preserve Foundry's native interaction systems** rather than replacing them. This ensures:
- Maximum compatibility with other modules
- Automatic support for future Foundry updates
- Reduced maintenance burden
- Predictable behavior for users familiar with Foundry

We achieve this by making the PIXI canvas a **transparent overlay** that handles all editing interactions natively, while Three.js provides the visual rendering layer beneath it.

### Scope & Non-Goals

**In Scope:**
- All left-hand palette controls (Scene Controls)
- PlaceableObject interactions (create, select, move, delete)
- HUD elements (Token HUD, Tile HUD, etc.)
- Ruler measurements and pings
- Keyboard shortcuts and hotkeys
- Module-added tools and controls

**Out of Scope (Explicitly Not Supported):**
- Modules that replace the PIXI renderer entirely
- Custom canvas rendering modules (e.g., isometric views)
- Modules that fundamentally alter coordinate systems

---

## Part 1: Current Architecture Analysis

### 1.1 Foundry VTT Scene Controls Structure

The Scene Controls (`ui.controls`) are defined in `scene-controls.mjs` and manage the left-hand toolbar. Each control set corresponds to a **Canvas Layer** that extends `InteractionLayer`.

#### Control Sets (in order):

| Order | Name | Layer Class | Document Type | GM Only | Description |
|-------|------|-------------|---------------|---------|-------------|
| 1 | `tokens` | `TokenLayer` | Token | No | Token selection, targeting, ruler |
| 2 | `templates` | `TemplateLayer` | MeasuredTemplate | No* | Spell/ability templates |
| 3 | `tiles` | `TilesLayer` | Tile | Yes | Background/foreground tiles |
| 4 | `drawings` | `DrawingsLayer` | Drawing | No* | Freeform drawings |
| 5 | `walls` | `WallsLayer` | Wall | Yes | Walls, doors, windows |
| 6 | `lighting` | `LightingLayer` | AmbientLight | Yes | Light sources |
| 7 | `sounds` | `SoundsLayer` | AmbientSound | Yes | Ambient audio |
| 8 | `regions` | `RegionLayer` | Region | Yes | V12+ Scene Regions |
| 10 | `notes` | `NotesLayer` | Note | No* | Map pins/journal links |

*Requires specific permission

#### Layer Z-Index Hierarchy (from Foundry source):

```
RegionLayer:     100 (inactive) / 600 (active)
TokenLayer:      200
TilesLayer:      300
TemplateLayer:   400
DrawingsLayer:   500
WallsLayer:      700
NotesLayer:      800
LightingLayer:   900
SoundsLayer:     900
ControlsLayer:   1000 (cursors, rulers, pings, doors)
```

### 1.2 Current Map Shine Implementation

Map Shine currently uses a **Hybrid Rendering System** with two modes:

#### Gameplay Mode (Default)
- Three.js canvas: Visible, receives pointer events
- PIXI canvas: Hidden (opacity: 0), pointer-events: none
- Specific PIXI layers hidden via `visible = false`
- Custom managers replace: Tokens, Tiles, Walls, Lights, Grid

#### Map Maker Mode (Editing)
- Three.js canvas: Hidden
- PIXI canvas: Fully visible and interactive
- All PIXI layers restored

#### Current Layer Visibility Logic (`updateLayerVisibility`):
```javascript
// Always hidden (replaced by Three.js):
canvas.background.visible = false;
canvas.grid.visible = false;
canvas.tokens.visible = false;
canvas.weather.visible = false;
canvas.environment.visible = false;

// Dynamic (shown when tool active):
canvas.walls.visible = (activeLayer === 'WallsLayer');
canvas.tiles.visible = (activeLayer === 'TilesLayer');
// etc.
```

### 1.3 Current Problems

1. **Coordinate Mismatch**: PIXI layers render at different positions than Three.js ground plane
2. **Input Routing Complexity**: Complex logic to determine which canvas receives events
3. **Incomplete Tool Support**: Some tools (Sounds, Templates, Regions, Notes) don't work reliably
4. **Double Rendering Risk**: When PIXI layers are shown, they may not align with Three.js
5. **HUD Positioning**: Token/Tile HUDs require manual repositioning
6. **Preview Objects**: PIXI preview objects (wall drawing, light placement) invisible in Three.js mode

---

## Part 2: Proposed Solution - PIXI Overlay Strategy

### 2.1 Core Concept: Transparent PIXI Overlay

Instead of hiding the PIXI canvas entirely, we **composite it above the Three.js canvas** with selective transparency:

```
┌─────────────────────────────────────────────┐
│  Foundry UI (Sidebar, Controls, HUD)        │  z-index: 100+
├─────────────────────────────────────────────┤
│  PIXI Canvas (Transparent Background)       │  z-index: 10
│  - Only "edit mode" layers visible          │
│  - Background/Primary groups hidden         │
├─────────────────────────────────────────────┤
│  Three.js Canvas (Full Scene Render)        │  z-index: 1
│  - Ground plane, effects, tokens, etc.      │
└─────────────────────────────────────────────┘
```

### 2.2 Key Architectural Changes

#### A. PIXI Canvas Configuration

```javascript
function configurePixiOverlay() {
  const pixiCanvas = canvas.app.view;
  
  // Always visible but transparent background
  pixiCanvas.style.opacity = '1';
  pixiCanvas.style.zIndex = '10';
  pixiCanvas.style.pointerEvents = 'none'; // Default: pass-through
  pixiCanvas.style.background = 'transparent';
  
  // Critical: Make PIXI renderer background transparent
  canvas.app.renderer.background.color = 0x000000;
  canvas.app.renderer.background.alpha = 0;
}
```

#### B. Layer Visibility Strategy

| Layer | Gameplay Mode | Edit Mode (Active) | Rationale |
|-------|--------------|-------------------|-----------|
| `background` | Hidden | Hidden | Replaced by Three.js |
| `primary` | Hidden | Hidden | Replaced by Three.js |
| `tokens` | Hidden | Hidden | Replaced by TokenManager |
| `tiles` | Hidden | Visible | Need PIXI for tile editing |
| `walls` | Hidden | Visible | Need PIXI for wall drawing |
| `lighting` | Hidden | Visible | Need PIXI for light placement |
| `sounds` | Hidden | Visible | Need PIXI for sound placement |
| `templates` | **Visible** | Visible | Always show templates |
| `drawings` | **Visible** | Visible | Always show drawings |
| `notes` | **Visible** | Visible | Always show notes |
| `regions` | Hidden | Visible | Need PIXI for region editing |
| `controls` | **Visible** | Visible | Cursors, rulers, pings |

#### C. Input Routing

```javascript
function updateInputMode() {
  const pixiCanvas = canvas.app.view;
  const activeLayer = canvas.activeLayer?.name;
  
  // Layers that require PIXI interaction
  const pixiInteractiveLayers = [
    'TilesLayer',
    'WallsLayer', 
    'LightingLayer',
    'SoundsLayer',
    'TemplateLayer',
    'DrawingsLayer',
    'NotesLayer',
    'RegionLayer'
  ];
  
  if (pixiInteractiveLayers.includes(activeLayer)) {
    pixiCanvas.style.pointerEvents = 'auto';
  } else {
    pixiCanvas.style.pointerEvents = 'none';
  }
}
```

### 2.3 Coordinate Alignment

The critical issue is ensuring PIXI and Three.js render at the same screen positions.

#### Current Three.js Ground Plane Setup:
```javascript
// SceneComposer creates plane at world origin
const geometry = new THREE.PlaneGeometry(width, height);
const plane = new THREE.Mesh(geometry, material);
plane.position.set(width/2, height/2, 0); // Centered
```

#### PIXI Stage Transform:
```javascript
// Foundry's stage transform
canvas.stage.position.set(offsetX, offsetY);
canvas.stage.scale.set(zoom, zoom);
```

#### Alignment Solution:

**Option A: Match Three.js Camera to PIXI Stage**
```javascript
function syncCameraToPixi() {
  const stage = canvas.stage;
  const camera = sceneComposer.camera;
  
  // PIXI stage position is the world offset
  const worldX = -stage.position.x / stage.scale.x;
  const worldY = -stage.position.y / stage.scale.y;
  
  camera.position.set(worldX + viewWidth/2, worldY + viewHeight/2, camera.position.z);
  camera.zoom = stage.scale.x; // For orthographic
  camera.updateProjectionMatrix();
}
```

**Option B: Match PIXI Stage to Three.js Camera** (Preferred)
```javascript
function syncPixiToCamera() {
  const camera = sceneComposer.camera;
  const stage = canvas.stage;
  
  // Calculate PIXI stage transform from Three.js camera
  const zoom = sceneComposer.baseDistance / camera.position.z;
  const worldCenter = {
    x: camera.position.x,
    y: camera.position.y
  };
  
  stage.scale.set(zoom, zoom);
  stage.position.set(
    (viewWidth / 2) - (worldCenter.x * zoom),
    (viewHeight / 2) - (worldCenter.y * zoom)
  );
}
```

### 2.4 Implementation Phases

#### Phase 1: Transparent Overlay Foundation
1. Configure PIXI renderer for transparent background
2. Set up proper z-index layering
3. Implement basic input routing
4. Test with TokenLayer (simplest case)

#### Phase 2: Camera Synchronization
1. Implement bidirectional camera sync
2. Hook into Three.js CameraController pan/zoom events
3. Hook into Foundry's `canvas.pan()` and `canvas.animatePan()`
4. Ensure pixel-perfect alignment

#### Phase 3: Layer-by-Layer Integration

##### 3a. Templates Layer (Priority: High)
- Always visible overlay
- No Three.js replacement needed
- Test: Create circle/cone/ray templates

##### 3b. Drawings Layer (Priority: High)
- Always visible overlay
- No Three.js replacement needed
- Test: Freehand, polygon, text drawings

##### 3c. Notes Layer (Priority: Medium)
- Always visible overlay
- Icons render via PIXI
- Test: Create/edit map pins

##### 3d. Walls Layer (Priority: High)
- Show PIXI layer when WallsLayer active
- Hide Three.js WallManager visuals
- Test: Draw walls, doors, windows

##### 3e. Lighting Layer (Priority: High)
- Show PIXI layer when LightingLayer active
- Hide Three.js LightIconManager
- Test: Create/edit lights, day/night buttons

##### 3f. Sounds Layer (Priority: Medium)
- Show PIXI layer when SoundsLayer active
- Test: Create/edit ambient sounds

##### 3g. Tiles Layer (Priority: Medium)
- Show PIXI layer when TilesLayer active
- Hide Three.js TileManager
- Test: Place/edit tiles, foreground toggle

##### 3h. Regions Layer (Priority: Low)
- V12+ feature
- Show PIXI layer when RegionLayer active
- Test: Create/edit regions

#### Phase 4: Controls Layer Integration
1. Ensure cursors render correctly
2. Ruler measurement works
3. Ping animations visible
4. Door controls functional

#### Phase 5: HUD Integration
1. Token HUD positioning
2. Tile HUD positioning
3. Drawing HUD positioning
4. Light/Sound config sheets

---

## Part 3: Technical Implementation Details

### 3.1 Hook Integration Points

```javascript
// Scene Controls activation
Hooks.on('activateCanvasLayer', (layer) => {
  updateLayerVisibility(layer);
  updateInputMode(layer);
});

// Camera sync
Hooks.on('canvasPan', (canvas, position) => {
  syncPixiToCamera();
});

// Tool changes
Hooks.on('getSceneControlButtons', (controls) => {
  // Inject Map Shine specific tools if needed
});
```

### 3.2 Layer Visibility Manager

```javascript
class LayerVisibilityManager {
  constructor() {
    this.alwaysVisibleLayers = ['templates', 'drawings', 'notes', 'controls'];
    this.editOnlyLayers = ['tiles', 'walls', 'lighting', 'sounds', 'regions'];
    this.replacedLayers = ['background', 'primary', 'tokens', 'weather', 'environment'];
  }
  
  update(activeLayerName) {
    // Hide replaced layers
    for (const name of this.replacedLayers) {
      const layer = canvas[name];
      if (layer) layer.visible = false;
    }
    
    // Always show certain layers
    for (const name of this.alwaysVisibleLayers) {
      const layer = canvas[name];
      if (layer) layer.visible = true;
    }
    
    // Show edit layers only when active
    for (const name of this.editOnlyLayers) {
      const layer = canvas[name];
      if (layer) {
        layer.visible = (canvas.activeLayer?.options?.name === name);
      }
    }
  }
}
```

### 3.3 Camera Synchronization Service

```javascript
class CameraSyncService {
  constructor(sceneComposer) {
    this.sceneComposer = sceneComposer;
    this.syncDirection = 'threeToPixi'; // or 'pixiToThree'
  }
  
  syncThreeToPixi() {
    if (!canvas.ready) return;
    
    const camera = this.sceneComposer.camera;
    const stage = canvas.stage;
    const rect = canvas.app.view.getBoundingClientRect();
    
    // Calculate zoom from camera distance
    const zoom = this.sceneComposer.baseDistance / camera.position.z;
    
    // Calculate stage position
    const stageX = (rect.width / 2) - (camera.position.x * zoom);
    const stageY = (rect.height / 2) - (camera.position.y * zoom);
    
    stage.scale.set(zoom, zoom);
    stage.position.set(stageX, stageY);
  }
  
  syncPixiToThree() {
    if (!canvas.ready) return;
    
    const stage = canvas.stage;
    const camera = this.sceneComposer.camera;
    const rect = canvas.app.view.getBoundingClientRect();
    
    // Calculate camera position from stage
    const zoom = stage.scale.x;
    const cameraX = (rect.width / 2 - stage.position.x) / zoom;
    const cameraY = (rect.height / 2 - stage.position.y) / zoom;
    const cameraZ = this.sceneComposer.baseDistance / zoom;
    
    camera.position.set(cameraX, cameraY, cameraZ);
    camera.updateProjectionMatrix();
  }
}
```

### 3.4 Input Arbitration System

```javascript
class InputArbitrator {
  constructor() {
    this.pixiInteractiveLayers = new Set([
      'TilesLayer', 'WallsLayer', 'LightingLayer', 
      'SoundsLayer', 'TemplateLayer', 'DrawingsLayer',
      'NotesLayer', 'RegionLayer'
    ]);
  }
  
  shouldPixiReceiveInput() {
    const activeLayer = canvas.activeLayer?.constructor?.name;
    return this.pixiInteractiveLayers.has(activeLayer);
  }
  
  update() {
    const pixiCanvas = canvas.app?.view;
    if (!pixiCanvas) return;
    
    if (this.shouldPixiReceiveInput()) {
      pixiCanvas.style.pointerEvents = 'auto';
    } else {
      pixiCanvas.style.pointerEvents = 'none';
    }
  }
}
```

---

## Part 4: Migration Path

### 4.1 Deprecation of Current Systems

The following Map Shine components will be **deprecated** in favor of PIXI overlay:

| Component | Current Role | New Role |
|-----------|--------------|----------|
| `InteractionManager.wallDraw` | Wall drawing | Removed (use PIXI) |
| `InteractionManager.lightPlacement` | Light creation | Removed (use PIXI) |
| `WallManager` (edit visuals) | Wall editing lines | Hidden during edit |
| `LightIconManager` | Light icons | Hidden during edit |

### 4.2 Retained Three.js Components

These components remain in Three.js for **gameplay rendering**:

| Component | Role |
|-----------|------|
| `TokenManager` | Token rendering with effects |
| `TileManager` | Tile rendering with effects |
| `WallManager` (gameplay) | Wall occlusion/shadows |
| `LightingEffect` | Dynamic lighting |
| `GridRenderer` | Grid overlay |
| All visual effects | PBR, particles, weather, etc. |

### 4.3 Backward Compatibility

- Map Maker Mode toggle remains functional
- Existing scene settings preserved
- v1.x map points continue to work

---

## Part 5: Testing Matrix

### 5.1 Per-Layer Test Cases

#### Tokens Layer
- [ ] Select token (Three.js)
- [ ] Drag token (Three.js)
- [ ] Token HUD (PIXI overlay)
- [ ] Target token
- [ ] Ruler measurement

#### Templates Layer
- [ ] Create circle template
- [ ] Create cone template
- [ ] Create rectangle template
- [ ] Create ray template
- [ ] Move/rotate template
- [ ] Delete template

#### Tiles Layer
- [ ] Place tile from browser
- [ ] Move tile
- [ ] Rotate tile
- [ ] Tile HUD
- [ ] Foreground toggle
- [ ] Delete tile

#### Drawings Layer
- [ ] Rectangle drawing
- [ ] Ellipse drawing
- [ ] Polygon drawing
- [ ] Freehand drawing
- [ ] Text drawing
- [ ] Drawing HUD

#### Walls Layer
- [ ] Draw basic wall
- [ ] Draw terrain wall
- [ ] Draw invisible wall
- [ ] Draw door
- [ ] Draw secret door
- [ ] Draw window
- [ ] Chain walls (Ctrl+click)
- [ ] Move wall endpoint
- [ ] Delete wall

#### Lighting Layer
- [ ] Create light (drag)
- [ ] Edit light config
- [ ] Day/Night buttons
- [ ] Reset fog button
- [ ] Delete light

#### Sounds Layer
- [ ] Create ambient sound
- [ ] Edit sound config
- [ ] Preview toggle
- [ ] Delete sound

#### Notes Layer
- [ ] Create map pin
- [ ] Edit note
- [ ] Toggle visibility
- [ ] Delete note

#### Regions Layer (V12+)
- [ ] Create region
- [ ] Edit region shapes
- [ ] Region legend
- [ ] Delete region

### 5.2 Cross-Cutting Concerns

- [ ] Camera pan syncs correctly
- [ ] Camera zoom syncs correctly
- [ ] Keyboard shortcuts work
- [ ] Copy/paste works
- [ ] Undo/redo works
- [ ] Multi-select works
- [ ] Grid snapping works

---

## Part 6: Module Compatibility Strategy

This section details how to ensure reliable operation with third-party modules that extend Foundry's controls and canvas systems.

### 6.1 Understanding Module Extension Points

Foundry provides several hooks that modules use to extend the Scene Controls:

```javascript
// Primary extension hook - modules add tools here
Hooks.on('getSceneControlButtons', (controls) => {
  // controls is a Record<string, SceneControl>
  // Modules can add new control sets or tools to existing sets
  controls.tokens.tools.myCustomTool = {
    name: 'myCustomTool',
    title: 'My Custom Tool',
    icon: 'fas fa-wrench',
    order: 100,
    button: true,
    onChange: () => { /* custom behavior */ }
  };
});

// Layer activation hooks - modules respond to layer changes
Hooks.on('activateCanvasLayer', (layer) => { /* ... */ });
Hooks.on('activateTokensLayer', (layer) => { /* ... */ });

// PlaceableObject lifecycle hooks
Hooks.on('createToken', (document, options, userId) => { /* ... */ });
Hooks.on('updateToken', (document, changes, options, userId) => { /* ... */ });
Hooks.on('deleteToken', (document, options, userId) => { /* ... */ });
Hooks.on('controlToken', (token, controlled) => { /* ... */ });
Hooks.on('hoverToken', (token, hovered) => { /* ... */ });
```

### 6.2 Module Compatibility Categories

#### Category A: Fully Compatible (No Action Required)
Modules that only:
- Add tools to existing control sets via `getSceneControlButtons`
- Listen to document lifecycle hooks (`createToken`, `updateToken`, etc.)
- Add UI elements to existing HUDs
- Extend PlaceableObject classes without overriding core methods

**Examples:** Token Action HUD, Drag Ruler, Combat Utility Belt

#### Category B: Compatible with Coordination
Modules that:
- Add custom canvas layers
- Override `MouseInteractionManager` callbacks
- Manipulate `canvas.stage` transform
- Add custom PIXI containers to layers

**Handling Strategy:**
```javascript
class ModuleCoordinator {
  constructor() {
    // Track modules that register custom layers
    this.customLayers = new Map();
    
    // Hook into layer registration
    Hooks.on('canvasInit', () => {
      this.detectCustomLayers();
    });
  }
  
  detectCustomLayers() {
    // Check CONFIG.Canvas.layers for non-standard entries
    const standardLayers = new Set([
      'background', 'drawings', 'grid', 'templates', 'tiles',
      'tokens', 'walls', 'lighting', 'sounds', 'notes', 
      'regions', 'controls', 'effects', 'interface'
    ]);
    
    for (const [name, config] of Object.entries(CONFIG.Canvas.layers)) {
      if (!standardLayers.has(name)) {
        this.customLayers.set(name, config);
        console.log(`Map Shine: Detected custom layer '${name}' from module`);
      }
    }
  }
  
  // Ensure custom layers remain visible and interactive
  preserveCustomLayers() {
    for (const [name, config] of this.customLayers) {
      const layer = canvas[name];
      if (layer) {
        // Don't hide module-added layers
        layer.visible = true;
        layer.interactiveChildren = true;
      }
    }
  }
}
```

#### Category C: Potentially Incompatible
Modules that:
- Replace the PIXI renderer
- Override `canvas.pan()` or `canvas.animatePan()`
- Modify `canvas.app.renderer` settings
- Implement custom coordinate systems (isometric, hex, etc.)

**Handling Strategy:** Detection and graceful degradation
```javascript
class IncompatibilityDetector {
  static KNOWN_INCOMPATIBLE = [
    'isometric-perspective',  // Changes coordinate system
    'levels-3d-preview',      // Has its own 3D renderer
  ];
  
  static check() {
    const warnings = [];
    
    for (const moduleId of this.KNOWN_INCOMPATIBLE) {
      if (game.modules.get(moduleId)?.active) {
        warnings.push(`Module '${moduleId}' may conflict with Map Shine controls`);
      }
    }
    
    // Check for renderer modifications
    if (canvas.app?.renderer?.background?.alpha !== 0) {
      // Another module may have changed renderer settings
      warnings.push('PIXI renderer background was modified by another module');
    }
    
    return warnings;
  }
}
```

### 6.3 Hook Priority Management

To ensure Map Shine's hooks run at the right time relative to other modules:

```javascript
class HookManager {
  static PRIORITIES = {
    FIRST: -1000,    // Run before most modules
    EARLY: -100,
    NORMAL: 0,
    LATE: 100,
    LAST: 1000       // Run after most modules
  };
  
  static register() {
    // Camera sync should run LAST to capture all changes
    Hooks.on('canvasPan', this.onCanvasPan.bind(this), { priority: this.PRIORITIES.LAST });
    
    // Layer visibility should run EARLY to set up before other modules
    Hooks.on('activateCanvasLayer', this.onActivateLayer.bind(this), { priority: this.PRIORITIES.EARLY });
    
    // Control buttons should run NORMAL to allow module additions
    Hooks.on('getSceneControlButtons', this.onGetControls.bind(this), { priority: this.PRIORITIES.NORMAL });
    
    // Document hooks should run LAST to sync after all processing
    Hooks.on('createToken', this.onCreateToken.bind(this), { priority: this.PRIORITIES.LAST });
    Hooks.on('updateToken', this.onUpdateToken.bind(this), { priority: this.PRIORITIES.LAST });
  }
}
```

### 6.4 Defensive Coding Patterns

#### Pattern 1: Null-Safe Layer Access
```javascript
function safeLayerAccess(layerName) {
  const layer = canvas?.[layerName];
  if (!layer) {
    console.warn(`Map Shine: Layer '${layerName}' not found`);
    return null;
  }
  return layer;
}
```

#### Pattern 2: State Validation Before Operations
```javascript
function validateCanvasState() {
  const issues = [];
  
  if (!canvas?.ready) issues.push('Canvas not ready');
  if (!canvas?.stage) issues.push('Stage not initialized');
  if (!canvas?.app?.renderer) issues.push('Renderer not available');
  
  // Check for expected layers
  const requiredLayers = ['tokens', 'walls', 'lighting', 'controls'];
  for (const name of requiredLayers) {
    if (!canvas[name]) issues.push(`Missing layer: ${name}`);
  }
  
  return { valid: issues.length === 0, issues };
}
```

#### Pattern 3: Graceful Degradation
```javascript
class ControlsIntegration {
  initialize() {
    const validation = validateCanvasState();
    
    if (!validation.valid) {
      console.error('Map Shine: Canvas state invalid, falling back to basic mode');
      console.error('Issues:', validation.issues);
      this.enableFallbackMode();
      return;
    }
    
    try {
      this.setupOverlay();
      this.setupCameraSync();
      this.setupInputRouting();
    } catch (error) {
      console.error('Map Shine: Integration failed, enabling fallback', error);
      this.enableFallbackMode();
    }
  }
  
  enableFallbackMode() {
    // Fallback: Just show PIXI canvas normally
    const pixiCanvas = canvas.app?.view;
    if (pixiCanvas) {
      pixiCanvas.style.opacity = '1';
      pixiCanvas.style.pointerEvents = 'auto';
      pixiCanvas.style.zIndex = '10';
    }
    
    // Hide Three.js canvas
    const threeCanvas = document.getElementById('map-shine-canvas');
    if (threeCanvas) {
      threeCanvas.style.display = 'none';
    }
    
    ui.notifications.warn('Map Shine: Running in compatibility mode due to conflicts');
  }
}
```

### 6.5 Module-Added Tools Handling

When modules add custom tools, we need to ensure they work correctly:

```javascript
class ToolHandler {
  constructor() {
    this.customTools = new Map();
  }
  
  // Called after getSceneControlButtons hook
  detectCustomTools(controls) {
    const standardTools = this.getStandardToolNames();
    
    for (const [controlName, control] of Object.entries(controls)) {
      for (const [toolName, tool] of Object.entries(control.tools || {})) {
        const fullName = `${controlName}.${toolName}`;
        
        if (!standardTools.has(fullName)) {
          this.customTools.set(fullName, {
            control: controlName,
            tool: toolName,
            config: tool,
            requiresPixi: this.toolRequiresPixi(tool)
          });
          
          console.log(`Map Shine: Detected custom tool '${fullName}'`);
        }
      }
    }
  }
  
  // Determine if a tool needs PIXI interaction
  toolRequiresPixi(tool) {
    // Tools with onChange that manipulate canvas objects need PIXI
    if (tool.onChange && typeof tool.onChange === 'function') {
      const fnString = tool.onChange.toString();
      
      // Heuristics for PIXI-dependent tools
      if (fnString.includes('canvas.') || 
          fnString.includes('layer.') ||
          fnString.includes('PlaceableObject') ||
          fnString.includes('preview')) {
        return true;
      }
    }
    
    // Button-only tools (toggles, dialogs) don't need PIXI
    if (tool.button === true && !tool.toggle) {
      return false;
    }
    
    // Default: assume PIXI needed for safety
    return true;
  }
  
  // Update input routing based on active tool
  updateInputForTool(controlName, toolName) {
    const fullName = `${controlName}.${toolName}`;
    const customTool = this.customTools.get(fullName);
    
    if (customTool?.requiresPixi) {
      // Enable PIXI interaction for this custom tool
      this.enablePixiInteraction();
    }
  }
}
```

### 6.6 Known Module Interactions

| Module | Compatibility | Notes |
|--------|--------------|-------|
| **Drag Ruler** | ✅ Full | Uses standard ruler APIs |
| **Token Action HUD** | ✅ Full | HTML overlay, no canvas changes |
| **Multilevel Tokens** | ⚠️ Partial | May need layer coordination |
| **Levels** | ⚠️ Partial | Custom layer visibility logic |
| **Wall Height** | ✅ Full | Extends wall data only |
| **Perfect Vision** | ⚠️ Partial | Modifies vision rendering |
| **FXMaster** | ✅ Full | Particle effects, no control changes |
| **Sequencer** | ✅ Full | Animation system, no control changes |
| **Monk's Active Tile Triggers** | ✅ Full | Tile data extensions |
| **Token Magic FX** | ⚠️ Partial | PIXI filters, may need coordination |
| **Isometric Perspective** | ❌ Incompatible | Different coordinate system |
| **3D Canvas** | ❌ Incompatible | Replaces renderer |

---

## Part 7: Reliability & Error Handling

### 7.1 State Machine for Integration

```javascript
const IntegrationState = {
  UNINITIALIZED: 'uninitialized',
  INITIALIZING: 'initializing',
  ACTIVE: 'active',
  SYNCING: 'syncing',
  ERROR: 'error',
  FALLBACK: 'fallback',
  DISABLED: 'disabled'
};

class IntegrationStateMachine {
  constructor() {
    this.state = IntegrationState.UNINITIALIZED;
    this.errorCount = 0;
    this.maxErrors = 3;
    this.lastError = null;
  }
  
  transition(newState, reason = '') {
    const oldState = this.state;
    this.state = newState;
    
    console.log(`Map Shine: State ${oldState} -> ${newState}${reason ? `: ${reason}` : ''}`);
    
    // Emit event for other systems to react
    Hooks.callAll('mapShineStateChange', { oldState, newState, reason });
  }
  
  handleError(error, context = '') {
    this.errorCount++;
    this.lastError = { error, context, timestamp: Date.now() };
    
    console.error(`Map Shine Error [${context}]:`, error);
    
    if (this.errorCount >= this.maxErrors) {
      this.transition(IntegrationState.FALLBACK, 'Too many errors');
      this.enableFallbackMode();
    } else {
      this.transition(IntegrationState.ERROR, error.message);
      // Attempt recovery
      setTimeout(() => this.attemptRecovery(), 1000);
    }
  }
  
  attemptRecovery() {
    if (this.state !== IntegrationState.ERROR) return;
    
    try {
      // Re-validate canvas state
      const validation = validateCanvasState();
      if (validation.valid) {
        this.transition(IntegrationState.ACTIVE, 'Recovery successful');
        this.errorCount = Math.max(0, this.errorCount - 1);
      } else {
        throw new Error(`Recovery failed: ${validation.issues.join(', ')}`);
      }
    } catch (error) {
      this.handleError(error, 'recovery');
    }
  }
}
```

### 7.2 Camera Synchronization Reliability

```javascript
class ReliableCameraSync {
  constructor(sceneComposer) {
    this.sceneComposer = sceneComposer;
    this.lastSyncTime = 0;
    this.syncThreshold = 0.001; // Minimum change to trigger sync
    this.lastPosition = { x: 0, y: 0, zoom: 1 };
    this.syncLock = false;
    this.pendingSync = null;
  }
  
  // Debounced sync to prevent rapid-fire updates
  requestSync(source = 'unknown') {
    if (this.syncLock) {
      // Queue for later
      this.pendingSync = source;
      return;
    }
    
    // Debounce: wait for rapid changes to settle
    clearTimeout(this._syncTimeout);
    this._syncTimeout = setTimeout(() => {
      this.performSync(source);
    }, 16); // ~60fps
  }
  
  performSync(source) {
    if (this.syncLock) return;
    
    this.syncLock = true;
    
    try {
      const camera = this.sceneComposer.camera;
      const stage = canvas.stage;
      const rect = canvas.app.view.getBoundingClientRect();
      
      // Calculate current Three.js camera state
      const zoom = this.sceneComposer.baseDistance / camera.position.z;
      const cameraX = camera.position.x;
      const cameraY = camera.position.y;
      
      // Check if change is significant
      const dx = Math.abs(cameraX - this.lastPosition.x);
      const dy = Math.abs(cameraY - this.lastPosition.y);
      const dz = Math.abs(zoom - this.lastPosition.zoom);
      
      if (dx < this.syncThreshold && dy < this.syncThreshold && dz < this.syncThreshold) {
        // No significant change
        return;
      }
      
      // Update PIXI stage
      stage.scale.set(zoom, zoom);
      stage.position.set(
        (rect.width / 2) - (cameraX * zoom),
        (rect.height / 2) - (cameraY * zoom)
      );
      
      // Record state
      this.lastPosition = { x: cameraX, y: cameraY, zoom };
      this.lastSyncTime = performance.now();
      
    } catch (error) {
      console.error('Map Shine: Camera sync failed', error);
      // Don't throw - camera sync failures shouldn't crash the system
    } finally {
      this.syncLock = false;
      
      // Process pending sync if any
      if (this.pendingSync) {
        const pending = this.pendingSync;
        this.pendingSync = null;
        this.requestSync(pending);
      }
    }
  }
  
  // Force full sync (useful for recovery)
  forceFullSync() {
    this.lastPosition = { x: 0, y: 0, zoom: 0 }; // Reset threshold check
    this.performSync('force');
  }
  
  // Validate sync accuracy
  validateSync() {
    const camera = this.sceneComposer.camera;
    const stage = canvas.stage;
    const rect = canvas.app.view.getBoundingClientRect();
    
    const expectedZoom = this.sceneComposer.baseDistance / camera.position.z;
    const expectedX = (rect.width / 2) - (camera.position.x * expectedZoom);
    const expectedY = (rect.height / 2) - (camera.position.y * expectedZoom);
    
    const actualZoom = stage.scale.x;
    const actualX = stage.position.x;
    const actualY = stage.position.y;
    
    const tolerance = 1; // pixels
    
    return {
      valid: Math.abs(expectedX - actualX) < tolerance &&
             Math.abs(expectedY - actualY) < tolerance &&
             Math.abs(expectedZoom - actualZoom) < 0.01,
      expected: { x: expectedX, y: expectedY, zoom: expectedZoom },
      actual: { x: actualX, y: actualY, zoom: actualZoom }
    };
  }
}
```

### 7.3 Input Event Reliability

```javascript
class ReliableInputRouter {
  constructor() {
    this.currentMode = 'three'; // 'three' or 'pixi'
    this.transitionLock = false;
    this.eventQueue = [];
  }
  
  // Atomic mode transition
  setMode(mode, reason = '') {
    if (this.transitionLock) {
      console.warn('Map Shine: Input mode transition already in progress');
      return false;
    }
    
    if (this.currentMode === mode) return true;
    
    this.transitionLock = true;
    
    try {
      const pixiCanvas = canvas.app?.view;
      const threeCanvas = document.getElementById('map-shine-canvas');
      
      if (!pixiCanvas || !threeCanvas) {
        throw new Error('Canvas elements not found');
      }
      
      if (mode === 'pixi') {
        // PIXI receives input
        pixiCanvas.style.pointerEvents = 'auto';
        threeCanvas.style.pointerEvents = 'none';
      } else {
        // Three.js receives input
        pixiCanvas.style.pointerEvents = 'none';
        threeCanvas.style.pointerEvents = 'auto';
      }
      
      this.currentMode = mode;
      console.log(`Map Shine: Input mode -> ${mode}${reason ? ` (${reason})` : ''}`);
      
      return true;
      
    } catch (error) {
      console.error('Map Shine: Input mode transition failed', error);
      return false;
    } finally {
      this.transitionLock = false;
    }
  }
  
  // Determine correct mode based on current state
  determineMode() {
    const activeLayer = canvas.activeLayer;
    
    if (!activeLayer) return 'three';
    
    const layerName = activeLayer.constructor.name;
    
    // Layers that need PIXI interaction
    const pixiLayers = new Set([
      'TilesLayer', 'WallsLayer', 'LightingLayer', 'SoundsLayer',
      'TemplateLayer', 'DrawingsLayer', 'NotesLayer', 'RegionLayer'
    ]);
    
    // Check for active tool that needs PIXI
    const activeTool = ui.controls?.activeTool;
    if (activeTool && this.toolNeedsPixi(activeTool)) {
      return 'pixi';
    }
    
    return pixiLayers.has(layerName) ? 'pixi' : 'three';
  }
  
  toolNeedsPixi(toolName) {
    // Tools that create/edit placeables need PIXI
    const pixiTools = new Set([
      'select', 'draw', 'walls', 'terrain', 'invisible', 'ethereal',
      'doors', 'secret', 'window', 'light', 'sound', 'note',
      'circle', 'cone', 'rect', 'ray', 'polygon', 'freehand', 'text',
      'tile', 'region'
    ]);
    
    return pixiTools.has(toolName);
  }
  
  // Auto-update mode when layer/tool changes
  autoUpdate() {
    const newMode = this.determineMode();
    this.setMode(newMode, 'auto');
  }
}
```

### 7.4 Health Monitoring

```javascript
class IntegrationHealthMonitor {
  constructor() {
    this.checks = [];
    this.lastCheckTime = 0;
    this.checkInterval = 5000; // 5 seconds
    this.healthHistory = [];
  }
  
  addCheck(name, checkFn) {
    this.checks.push({ name, check: checkFn });
  }
  
  registerDefaultChecks() {
    // Canvas state check
    this.addCheck('canvas', () => {
      return canvas?.ready && canvas?.stage && canvas?.app?.renderer;
    });
    
    // Camera sync check
    this.addCheck('cameraSync', () => {
      const sync = window.MapShine?.cameraSync;
      if (!sync) return false;
      return sync.validateSync().valid;
    });
    
    // Layer visibility check
    this.addCheck('layers', () => {
      // Verify expected layers are in expected visibility state
      const controls = canvas.controls;
      const templates = canvas.templates;
      return controls?.visible && templates?.visible;
    });
    
    // Input routing check
    this.addCheck('input', () => {
      const pixiCanvas = canvas.app?.view;
      const threeCanvas = document.getElementById('map-shine-canvas');
      
      // At least one canvas should receive input
      const pixiReceives = pixiCanvas?.style.pointerEvents === 'auto';
      const threeReceives = threeCanvas?.style.pointerEvents === 'auto';
      
      return pixiReceives || threeReceives;
    });
    
    // Performance check
    this.addCheck('performance', () => {
      const renderLoop = window.MapShine?.renderLoop;
      if (!renderLoop) return false;
      
      const fps = renderLoop.getFPS();
      return fps > 10; // Minimum acceptable FPS
    });
  }
  
  runChecks() {
    const results = {};
    let allPassed = true;
    
    for (const { name, check } of this.checks) {
      try {
        results[name] = check();
        if (!results[name]) allPassed = false;
      } catch (error) {
        results[name] = false;
        allPassed = false;
        console.warn(`Map Shine: Health check '${name}' threw error:`, error);
      }
    }
    
    this.healthHistory.push({
      timestamp: Date.now(),
      results,
      healthy: allPassed
    });
    
    // Keep last 100 checks
    if (this.healthHistory.length > 100) {
      this.healthHistory.shift();
    }
    
    return { healthy: allPassed, results };
  }
  
  startMonitoring() {
    this.registerDefaultChecks();
    
    setInterval(() => {
      const health = this.runChecks();
      
      if (!health.healthy) {
        console.warn('Map Shine: Health check failed', health.results);
        
        // Attempt auto-recovery for specific failures
        if (!health.results.cameraSync) {
          window.MapShine?.cameraSync?.forceFullSync();
        }
        
        if (!health.results.input) {
          window.MapShine?.inputRouter?.autoUpdate();
        }
      }
    }, this.checkInterval);
  }
  
  getHealthReport() {
    const recent = this.healthHistory.slice(-10);
    const failureRate = recent.filter(h => !h.healthy).length / recent.length;
    
    return {
      currentHealth: this.runChecks(),
      failureRate,
      recentHistory: recent,
      status: failureRate < 0.1 ? 'healthy' : failureRate < 0.5 ? 'degraded' : 'unhealthy'
    };
  }
}
```

---

## Part 8: Edge Cases & Special Scenarios

### 8.1 Large Scene Handling

Scenes with extreme dimensions (100k+ pixels) require special consideration:

```javascript
class LargeSceneHandler {
  static MAX_SAFE_DIMENSION = 16384; // WebGL texture limit
  
  static analyzeScene(scene) {
    const width = scene.dimensions?.width || 0;
    const height = scene.dimensions?.height || 0;
    
    return {
      width,
      height,
      isLarge: width > this.MAX_SAFE_DIMENSION || height > this.MAX_SAFE_DIMENSION,
      scaleFactor: Math.max(1, Math.max(width, height) / this.MAX_SAFE_DIMENSION),
      recommendations: this.getRecommendations(width, height)
    };
  }
  
  static getRecommendations(width, height) {
    const recs = [];
    
    if (width > this.MAX_SAFE_DIMENSION || height > this.MAX_SAFE_DIMENSION) {
      recs.push('Consider reducing scene dimensions for better performance');
      recs.push('Camera sync may be less precise at extreme zoom levels');
    }
    
    if (width * height > 100000000) { // 100 megapixels
      recs.push('Very large scene - some effects may be disabled');
    }
    
    return recs;
  }
}
```

### 8.2 Multi-User Synchronization

When multiple users are editing simultaneously:

```javascript
class MultiUserCoordinator {
  constructor() {
    this.activeEditors = new Map(); // userId -> { layer, tool, timestamp }
  }
  
  // Track who is editing what
  registerActivity(userId, layer, tool) {
    this.activeEditors.set(userId, {
      layer,
      tool,
      timestamp: Date.now()
    });
    
    // Clean up stale entries
    this.cleanupStale();
  }
  
  cleanupStale() {
    const staleThreshold = 30000; // 30 seconds
    const now = Date.now();
    
    for (const [userId, activity] of this.activeEditors) {
      if (now - activity.timestamp > staleThreshold) {
        this.activeEditors.delete(userId);
      }
    }
  }
  
  // Check if another user is editing the same layer
  hasConflict(layer) {
    const currentUser = game.user.id;
    
    for (const [userId, activity] of this.activeEditors) {
      if (userId !== currentUser && activity.layer === layer) {
        return {
          conflict: true,
          user: game.users.get(userId)?.name || 'Unknown',
          layer
        };
      }
    }
    
    return { conflict: false };
  }
}
```

### 8.3 Keyboard Shortcut Handling

Ensure keyboard shortcuts work regardless of which canvas has focus:

```javascript
class KeyboardHandler {
  constructor() {
    this.shortcuts = new Map();
  }
  
  initialize() {
    // Global keyboard listener that works regardless of focus
    document.addEventListener('keydown', this.onKeyDown.bind(this), { capture: true });
    document.addEventListener('keyup', this.onKeyUp.bind(this), { capture: true });
  }
  
  onKeyDown(event) {
    // Don't intercept if user is typing in an input
    if (this.isTypingInInput(event)) return;
    
    // Check for Foundry's standard shortcuts
    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;
    const alt = event.altKey;
    
    // Layer switching (1-9 keys)
    if (!ctrl && !alt && /^[1-9]$/.test(key)) {
      // Let Foundry handle layer switching
      // But ensure our input routing updates afterward
      setTimeout(() => {
        window.MapShine?.inputRouter?.autoUpdate();
      }, 0);
    }
    
    // Tool switching (letters)
    // Foundry handles this natively
    
    // Delete key - ensure it reaches the right canvas
    if (key === 'delete' || key === 'backspace') {
      const mode = window.MapShine?.inputRouter?.currentMode;
      if (mode === 'pixi') {
        // PIXI canvas should handle deletion
        // Don't prevent default
      }
    }
    
    // Escape - deselect/cancel
    if (key === 'escape') {
      // Let both systems handle escape
    }
    
    // Ctrl+Z / Ctrl+Y - Undo/Redo
    if (ctrl && (key === 'z' || key === 'y')) {
      // Foundry handles this globally
    }
  }
  
  isTypingInInput(event) {
    const target = event.target;
    const tagName = target.tagName.toLowerCase();
    
    return tagName === 'input' || 
           tagName === 'textarea' || 
           target.isContentEditable;
  }
}
```

### 8.4 Window Resize Handling

```javascript
class ResizeHandler {
  constructor(sceneComposer, cameraSync) {
    this.sceneComposer = sceneComposer;
    this.cameraSync = cameraSync;
    this.resizeTimeout = null;
  }
  
  initialize() {
    window.addEventListener('resize', this.onResize.bind(this));
    
    // Also handle Foundry sidebar collapse/expand
    Hooks.on('collapseSidebar', () => this.onResize());
  }
  
  onResize() {
    // Debounce resize handling
    clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => {
      this.handleResize();
    }, 100);
  }
  
  handleResize() {
    const threeCanvas = document.getElementById('map-shine-canvas');
    if (!threeCanvas) return;
    
    const rect = threeCanvas.getBoundingClientRect();
    
    // Update Three.js renderer
    window.MapShine?.renderer?.setSize(rect.width, rect.height);
    
    // Update camera aspect ratio
    if (this.sceneComposer?.camera) {
      const camera = this.sceneComposer.camera;
      if (camera.isOrthographicCamera) {
        // Orthographic camera - update frustum
        const aspect = rect.width / rect.height;
        // ... update camera
      }
      camera.updateProjectionMatrix();
    }
    
    // Force camera sync
    this.cameraSync?.forceFullSync();
  }
}
```

---

## Part 9: Risk Assessment (Expanded)

### 9.1 Risk Matrix

| Risk | Probability | Impact | Mitigation | Contingency |
|------|-------------|--------|------------|-------------|
| Camera sync drift | Medium | High | Threshold-based updates, periodic full sync | Force sync on user action |
| Module conflicts | High | Medium | Detection, graceful degradation | Fallback mode |
| Performance degradation | Medium | Medium | Aggressive layer hiding, render-on-demand | Disable effects |
| Input event loss | Low | High | Atomic transitions, event queuing | Manual mode override |
| PIXI version changes | Low | High | Version detection, abstraction layer | Conditional code paths |
| Memory exhaustion | Low | Medium | Texture sharing, cleanup on scene change | Reduce quality settings |

### 9.2 Detailed Risk Analysis

#### Risk 1: Camera Synchronization Drift
**Description:** Small floating-point errors accumulate over time, causing PIXI and Three.js to render at slightly different positions.

**Probability:** Medium - Floating-point math is inherently imprecise.

**Impact:** High - Misaligned canvases make editing impossible.

**Mitigations:**
1. Use threshold-based sync (only sync when change > 0.001)
2. Periodic full sync every 5 seconds
3. Force sync on user interaction (click, drag start)
4. Validation check after each sync

**Contingency:** If drift is detected, force full sync and log warning.

#### Risk 2: Third-Party Module Conflicts
**Description:** Other modules modify canvas state in ways that break our integration.

**Probability:** High - Many popular modules manipulate the canvas.

**Impact:** Medium - May break specific features, not entire system.

**Mitigations:**
1. Detect known incompatible modules at startup
2. Use hook priorities to run after most modules
3. Defensive null checks on all canvas access
4. Preserve module-added layers automatically

**Contingency:** Enable fallback mode that shows PIXI canvas normally.

#### Risk 3: Performance Degradation
**Description:** Running two renderers simultaneously causes frame rate drops.

**Probability:** Medium - Depends on scene complexity and hardware.

**Impact:** Medium - Poor UX but not broken functionality.

**Mitigations:**
1. Hide all unnecessary PIXI layers
2. Use render-on-demand for PIXI (only when editing)
3. Throttle camera sync to 60fps max
4. Disable expensive PIXI effects

**Contingency:** Provide "Performance Mode" setting that disables overlay.

#### Risk 4: Input Event Loss
**Description:** Events get lost during canvas mode transitions.

**Probability:** Low - Atomic transitions prevent most issues.

**Impact:** High - Lost clicks/drags frustrate users.

**Mitigations:**
1. Atomic mode transitions with locks
2. Event queuing during transitions
3. Never transition during active drag
4. Validate mode after transition

**Contingency:** Manual mode override in settings.

#### Risk 5: Foundry Version Incompatibility
**Description:** Foundry V13+ changes break assumptions about canvas structure.

**Probability:** Low - Core canvas API is stable.

**Impact:** High - Could break entire integration.

**Mitigations:**
1. Version detection at startup
2. Abstract canvas access through wrapper functions
3. Comprehensive test suite for each Foundry version
4. Monitor Foundry release notes

**Contingency:** Disable integration for unsupported versions.

### 9.3 Failure Mode Analysis

```
┌─────────────────────────────────────────────────────────────────┐
│                    FAILURE MODE TREE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Integration Failure                                            │
│  ├── Canvas State Invalid                                       │
│  │   ├── canvas.ready = false → Wait and retry                  │
│  │   ├── canvas.stage missing → Abort, fallback mode            │
│  │   └── Layers missing → Log warning, continue partial         │
│  │                                                              │
│  ├── Camera Sync Failure                                        │
│  │   ├── Stage transform locked → Queue sync for later          │
│  │   ├── Invalid camera state → Reset to default view           │
│  │   └── Sync validation fails → Force full sync                │
│  │                                                              │
│  ├── Input Routing Failure                                      │
│  │   ├── Both canvases receive input → Force PIXI mode          │
│  │   ├── Neither canvas receives input → Force Three.js mode    │
│  │   └── Mode transition fails → Retry once, then fallback      │
│  │                                                              │
│  └── Module Conflict                                            │
│      ├── Known incompatible module → Warn user, continue        │
│      ├── Unknown module breaks state → Detect via health check  │
│      └── Renderer settings changed → Restore on each frame      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 10: Implementation Checklist

### 10.1 Phase 1: Foundation (Week 1) ✅ COMPLETE

- [x] Create `ControlsIntegration` class in `scripts/foundry/controls-integration.js`
- [x] Implement PIXI canvas transparency configuration
- [x] Set up z-index layering (Three.js: 1, PIXI: 10)
- [x] Create `LayerVisibilityManager` class
- [x] Implement basic input routing (pointer-events toggle)
- [x] Add `IntegrationStateMachine` for state tracking
- [x] Create fallback mode implementation
- [ ] Write unit tests for state machine

### 10.2 Phase 2: Camera Sync (Week 2) ✅ COMPLETE

- [x] Create `ReliableCameraSync` class (as `CameraSync`)
- [x] Implement Three.js → PIXI sync direction
- [x] Hook into render loop for per-frame sync
- [x] Hook into Foundry's `canvasPan` hook
- [x] Implement sync validation
- [x] Add debouncing and threshold checks
- [x] Handle sidebar collapse/expand
- [ ] Handle window resize events (partial - via sidebar hook)
- [ ] Write integration tests for camera sync

### 10.3 Phase 3: Layer Integration (Weeks 3-5)

#### 3a. Templates Layer
- [ ] Ensure `canvas.templates` always visible
- [ ] Test circle template creation
- [ ] Test cone template creation
- [ ] Test rectangle template creation
- [ ] Test ray template creation
- [ ] Test template movement/rotation
- [ ] Test template deletion

#### 3b. Drawings Layer
- [ ] Ensure `canvas.drawings` always visible
- [ ] Test rectangle drawing
- [ ] Test ellipse drawing
- [ ] Test polygon drawing
- [ ] Test freehand drawing
- [ ] Test text drawing
- [ ] Test drawing HUD

#### 3c. Notes Layer
- [ ] Ensure `canvas.notes` always visible
- [ ] Test note creation
- [ ] Test note editing
- [ ] Test note visibility toggle
- [ ] Test journal entry linking

#### 3d. Walls Layer
- [ ] Show `canvas.walls` when WallsLayer active
- [ ] Hide Three.js wall visuals during edit
- [ ] Test basic wall drawing
- [ ] Test wall chaining (Ctrl+click)
- [ ] Test door creation
- [ ] Test wall endpoint movement
- [ ] Test wall deletion

#### 3e. Lighting Layer
- [ ] Show `canvas.lighting` when LightingLayer active
- [ ] Hide Three.js light icons during edit
- [ ] Test light creation (drag)
- [ ] Test light configuration
- [ ] Test day/night buttons
- [ ] Test light deletion

#### 3f. Sounds Layer
- [ ] Show `canvas.sounds` when SoundsLayer active
- [ ] Test sound creation
- [ ] Test sound configuration
- [ ] Test preview toggle
- [ ] Test sound deletion

#### 3g. Tiles Layer
- [ ] Show `canvas.tiles` when TilesLayer active
- [ ] Hide Three.js tile visuals during edit
- [ ] Test tile placement from browser
- [ ] Test tile movement
- [ ] Test tile rotation
- [ ] Test foreground toggle
- [ ] Test tile HUD

#### 3h. Regions Layer
- [ ] Show `canvas.regions` when RegionLayer active
- [ ] Test region creation
- [ ] Test region shape editing
- [ ] Test region deletion

### 10.4 Phase 4: Controls Layer (Week 6)

- [ ] Ensure `canvas.controls` always visible
- [ ] Test cursor rendering
- [ ] Test ruler measurement
- [ ] Test ping animations
- [ ] Test door controls
- [ ] Test multi-user cursors

### 10.5 Phase 5: HUD Integration (Week 7)

- [ ] Test Token HUD positioning
- [ ] Test Tile HUD positioning
- [ ] Test Drawing HUD positioning
- [ ] Test Light configuration sheet
- [ ] Test Sound configuration sheet
- [ ] Test Note configuration sheet

### 10.6 Phase 6: Module Compatibility (Week 8)

- [ ] Create `ModuleCoordinator` class
- [ ] Implement custom layer detection
- [ ] Create `IncompatibilityDetector` class
- [ ] Test with Drag Ruler
- [ ] Test with Token Action HUD
- [ ] Test with Levels (if applicable)
- [ ] Test with Perfect Vision (if applicable)
- [ ] Document known module interactions

### 10.7 Phase 7: Polish & Testing (Weeks 9-10)

- [ ] Implement `IntegrationHealthMonitor`
- [ ] Add health check dashboard (dev mode)
- [ ] Performance profiling
- [ ] Memory leak testing
- [ ] Multi-user testing
- [ ] Large scene testing (100k+ pixels)
- [ ] Write user documentation
- [ ] Create troubleshooting guide

---

## Part 11: Timeline Estimate (Revised)

| Phase | Duration | Dependencies | Risk Level |
|-------|----------|--------------|------------|
| Phase 1: Foundation | 1 week | None | Low |
| Phase 2: Camera Sync | 1-2 weeks | Phase 1 | Medium |
| Phase 3a-c: Templates/Drawings/Notes | 1 week | Phase 2 | Low |
| Phase 3d-e: Walls/Lighting | 2 weeks | Phase 2 | Medium |
| Phase 3f-h: Sounds/Tiles/Regions | 1 week | Phase 2 | Low |
| Phase 4: Controls Layer | 1 week | Phase 3 | Low |
| Phase 5: HUD Integration | 1 week | Phase 4 | Medium |
| Phase 6: Module Compatibility | 1 week | Phase 5 | High |
| Phase 7: Polish & Testing | 2 weeks | All | Medium |

**Total Estimate: 10-12 weeks**

### Critical Path
```
Foundation → Camera Sync → Walls/Lighting → Controls → HUD → Module Compat → Testing
```

The camera sync and walls/lighting phases are the highest risk and most likely to cause delays.

---

## Part 12: Open Questions & Decisions

### 12.1 Architectural Decisions Needed

1. **Map Maker Mode Toggle**
   - **Option A:** Keep toggle, overlay only active in "Gameplay Mode"
   - **Option B:** Remove toggle, overlay always active
   - **Recommendation:** Option B - simplifies code, better UX

2. **Camera Sync Direction**
   - **Option A:** Three.js is master, PIXI follows
   - **Option B:** PIXI is master, Three.js follows
   - **Option C:** Bidirectional with conflict resolution
   - **Recommendation:** Option A - Three.js controls camera, PIXI follows

3. **Token Interaction Mode**
   - **Option A:** Tokens always handled by Three.js
   - **Option B:** Tokens handled by PIXI when TokenLayer active
   - **Recommendation:** Option A - Three.js provides better visuals

4. **Fallback Trigger**
   - **Option A:** Automatic on error detection
   - **Option B:** Manual user setting
   - **Option C:** Both (auto with manual override)
   - **Recommendation:** Option C

### 12.2 Open Questions

1. How do we handle modules that add custom canvas layers?
   - **Proposed Answer:** Detect and preserve them automatically

2. Should Three.js managers be completely disabled during edit mode?
   - **Proposed Answer:** No, keep rendering but hide edit visuals

3. What's the fallback if camera sync fails repeatedly?
   - **Proposed Answer:** Show PIXI canvas normally, hide Three.js

4. How do we handle scenes with extreme dimensions (100k+ pixels)?
   - **Proposed Answer:** Warn user, reduce sync precision

5. Should we support touch/tablet input?
   - **Proposed Answer:** Yes, but as lower priority

### 12.3 Future Considerations

- **WebGPU Migration:** When Foundry moves to WebGPU, this architecture should still work
- **Mobile Support:** Touch events may need special handling
- **VR/AR:** Out of scope but architecture shouldn't preclude it
- **Performance Monitoring:** Consider adding telemetry for debugging

---

## Appendix A: Foundry Layer Class Hierarchy

```
CanvasLayer (base)
├── InteractionLayer (interactive)
│   ├── PlaceablesLayer (documents)
│   │   ├── TokenLayer
│   │   ├── TilesLayer
│   │   ├── DrawingsLayer
│   │   ├── WallsLayer
│   │   ├── LightingLayer
│   │   ├── SoundsLayer
│   │   ├── TemplateLayer
│   │   ├── NotesLayer
│   │   └── RegionLayer
│   └── ControlsLayer
└── (Non-interactive layers)
    ├── GridLayer
    ├── BackgroundLayer
    └── WeatherLayer
```

## Appendix B: Key Foundry Hooks

```javascript
// Layer activation
Hooks.on('activateTokenLayer', (layer) => {});
Hooks.on('activateWallsLayer', (layer) => {});
// ... etc for each layer

// Generic activation
Hooks.on('activateCanvasLayer', (layer) => {});

// Control changes
Hooks.on('getSceneControlButtons', (controls) => {});

// Canvas events
Hooks.on('canvasPan', (canvas, position) => {});
Hooks.on('canvasReady', (canvas) => {});
Hooks.on('canvasTearDown', (canvas) => {});
```

## Appendix C: Quick Reference - Input Mode by Layer/Tool

| Active Layer | Active Tool | Input Mode | PIXI Visible | Three.js Visible |
|--------------|-------------|------------|--------------|------------------|
| TokenLayer | select | Three.js | Controls only | Full |
| TokenLayer | target | Three.js | Controls only | Full |
| TokenLayer | ruler | PIXI | Controls | Full |
| TemplateLayer | * | PIXI | Templates + Controls | Full |
| TilesLayer | * | PIXI | Tiles + Controls | Background only |
| DrawingsLayer | * | PIXI | Drawings + Controls | Full |
| WallsLayer | * | PIXI | Walls + Controls | Background only |
| LightingLayer | * | PIXI | Lighting + Controls | Background only |
| SoundsLayer | * | PIXI | Sounds + Controls | Full |
| NotesLayer | * | PIXI | Notes + Controls | Full |
| RegionLayer | * | PIXI | Regions + Controls | Full |

## Appendix D: New Files to Create

```
scripts/foundry/
├── controls-integration.js      # Main integration orchestrator
├── layer-visibility-manager.js  # PIXI layer visibility control
├── camera-sync.js               # Camera synchronization service
├── input-router.js              # Input event routing
├── module-coordinator.js        # Third-party module handling
├── health-monitor.js            # Integration health monitoring
└── compatibility-detector.js    # Incompatible module detection
```

## Appendix E: API Surface

### Public API (window.MapShine)

```javascript
// Existing
window.MapShine.sceneComposer
window.MapShine.effectComposer
window.MapShine.tokenManager
// ... etc

// New (after implementation)
window.MapShine.controlsIntegration    // Main integration class
window.MapShine.cameraSync             // Camera sync service
window.MapShine.inputRouter            // Input routing service
window.MapShine.healthMonitor          // Health monitoring

// Methods
window.MapShine.controlsIntegration.getState()        // Current state
window.MapShine.controlsIntegration.enableFallback()  // Force fallback mode
window.MapShine.controlsIntegration.disable()         // Disable integration
window.MapShine.cameraSync.forceSync()                // Force camera sync
window.MapShine.healthMonitor.getReport()             // Health report
```

### Events (Hooks)

```javascript
// Map Shine emits these hooks for other modules to listen to
Hooks.on('mapShineStateChange', ({ oldState, newState, reason }) => {});
Hooks.on('mapShineInputModeChange', ({ mode, layer, tool }) => {});
Hooks.on('mapShineCameraSync', ({ position, zoom }) => {});
Hooks.on('mapShineHealthCheck', ({ healthy, results }) => {});
```

## Appendix F: References

### Foundry VTT Source Files
- `resources/app/client/canvas/board.mjs` - Canvas class
- `resources/app/client/canvas/layers/base/interaction-layer.mjs` - InteractionLayer base
- `resources/app/client/canvas/layers/base/placeables-layer.mjs` - PlaceablesLayer base
- `resources/app/client/canvas/interaction/mouse-handler.mjs` - MouseInteractionManager
- `resources/app/client/applications/ui/scene-controls.mjs` - SceneControls UI
- `resources/app/client/hooks.mjs` - Hook documentation

### Map Shine Source Files
- `scripts/foundry/canvas-replacement.js` - Current canvas integration
- `scripts/scene/composer.js` - SceneComposer (Three.js scene setup)
- `scripts/scene/camera-controller.js` - CameraController
- `scripts/scene/interaction-manager.js` - Current interaction handling
- `scripts/scene/token-manager.js` - Token rendering
- `scripts/scene/tile-manager.js` - Tile rendering
- `scripts/scene/wall-manager.js` - Wall rendering

### External Documentation
- [Foundry VTT API Documentation](https://foundryvtt.com/api/)
- [PIXI.js Documentation](https://pixijs.download/release/docs/index.html)
- [Three.js Documentation](https://threejs.org/docs/)

---

*Document Version: 1.0*
*Last Updated: December 2024*
*Author: Map Shine Development Team*
