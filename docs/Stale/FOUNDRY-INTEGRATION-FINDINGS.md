# Foundry VTT Integration - Fact Finding Report

**Date**: 2024-11-18  
**Source**: Foundry VTT v12+ source code analysis  
**Purpose**: Determine best integration approach for THREE.js canvas replacement

---

## 🔍 Key Discoveries

### 1. Canvas Layer Z-Index System

Foundry uses PIXI.js with explicit z-index values for layers:

```javascript
// From Foundry source code:
TokenLayer.layerOptions = {
  zIndex: 200  // Tokens layer
}

TilesLayer.layerOptions = {
  zIndex: 300  // Tiles layer
}
```

**Observation**: Tiles have a HIGHER z-index (300) than tokens (200), but this is INVERTED from what we expect because tiles can be below OR above tokens based on elevation.

---

### 2. Token Data Structure

**Location**: `client/canvas/placeables/token.mjs`

```javascript
// Token properties accessible via document:
token.document.x           // X position in pixels
token.document.y           // Y position in pixels  
token.document.elevation   // Height in grid units
token.document.width       // Width in pixels
token.document.height      // Height in pixels
token.document.texture.src // Texture path
token.document.rotation    // Rotation in degrees
```

**Key Properties**:
- Position is **top-left origin** in pixels
- `elevation` is in grid units, not pixels
- Tokens have `shape` property (rectangle, circle, polygon, ellipse)
- Tokens have visibility filters and effects
- Tokens have bars, tooltips, borders, target markers

**Source Code Insight**:
```javascript
// From token.mjs line 1178:
this.document.x = Math.clamp(this.document.x, -cx, d.width - cx);
this.document.y = Math.clamp(this.document.y, -cy, d.height - cy);
```
Foundry clamps token positions to scene boundaries.

---

### 3. Tile Data Structure  

**Location**: `client/canvas/placeables/tile.mjs`

```javascript
// Tile properties:
tile.document.x              // X position (top-left)
tile.document.y              // Y position (top-left)
tile.document.width          // Width in pixels
tile.document.height         // Height in pixels
tile.document.elevation      // Elevation in grid units
tile.document.rotation       // Rotation in degrees
tile.document.texture.src    // Texture path
tile.document.texture.scaleX // Texture X scale
tile.document.texture.scaleY // Texture Y scale
tile.document.hidden         // Visibility flag
```

**Critical Discovery - Overhead Tiles**:
```javascript
// From tiles.mjs line 63:
const overhead = placeable.document.elevation >= placeable.document.parent.foregroundElevation;
```

**There is NO `overhead` boolean property!** Instead:
- Tiles with `elevation >= scene.foregroundElevation` are overhead tiles
- Tiles with `elevation < scene.foregroundElevation` are foreground/background tiles
- The `scene.foregroundElevation` threshold determines which tools can interact with them

---

### 4. Grid System

**Location**: `common/grid/base.mjs`

```javascript
// Grid properties:
grid.size      // Size of grid space in pixels
grid.sizeX     // Width of grid space
grid.sizeY     // Height of grid space  
grid.distance  // Distance in grid units
grid.units     // Distance units (e.g., "ft", "m")
grid.style     // "solidLines", "dashedLines", etc.
grid.thickness // Line thickness
grid.color     // Grid color (Color object)
grid.alpha     // Grid opacity (0-1)
```

**Grid Types** (from `GRID_TYPES` constants):
- `GRIDLESS = 0` - No grid
- `SQUARE = 1` - Square grid
- `HEXODDR = 2` - Hex grid (odd rows)
- `HEXEVENR = 3` - Hex grid (even rows)
- `HEXODDQ = 4` - Hex grid (odd columns)
- `HEXEVENQ = 5` - Hex grid (even columns)

---

### 5. Update Hooks & Synchronization

**Token Hooks**:
```javascript
// When tokens are created/updated/deleted:
Hooks.call("createToken", document, options, userId)
Hooks.call("updateToken", document, changes, options, userId)
Hooks.call("deleteToken", document, options, userId)

// When token rendering changes:
Hooks.call("refreshToken", token)
```

**Tile Hooks**:
```javascript
Hooks.call("createTile", document, options, userId)
Hooks.call("updateTile", document, changes, options, userId)  
Hooks.call("deleteTile", document, options, userId)
```

**Canvas Hooks**:
```javascript
Hooks.on("canvasReady", canvas => {
  // Canvas fully initialized, all layers created
  // Access: canvas.tokens.placeables, canvas.scene.tiles
});

Hooks.on("canvasPan", (canvas, position) => {
  // Camera panned: position = {x, y, scale}
});
```

---

### 6. Scene Dimensions & Coordinates

```javascript
// Scene dimensions:
canvas.scene.dimensions = {
  width: 4000,              // Scene width in pixels
  height: 3000,             // Scene height in pixels
  sceneWidth: 4000,         // Same as width
  sceneHeight: 3000,        // Same as height
  size: 100,                // Grid size in pixels
  distance: 5,              // Distance per grid square
  ratio: 0.05,              // size / distance
  rect: PIXI.Rectangle,     // Scene bounds
  sceneRect: PIXI.Rectangle // Scene bounds
}
```

**Coordinate System**:
- **Origin**: Top-left (0, 0)
- **Units**: Pixels
- **Grid alignment**: Tokens/tiles snap to grid based on settings

---

### 7. Elevation & Z-Ordering

**Key Finding**: Foundry uses elevation to determine rendering order WITHIN layers, not between layers.

```javascript
// From tile.mjs line 391:
const overhead = elevation >= this.document.parent.foregroundElevation;
```

**Elevation Rules**:
1. Tiles below `scene.foregroundElevation` → Background/Foreground tiles
2. Tiles above `scene.foregroundElevation` → Overhead tiles (roofs, ceilings)
3. Tokens use `elevation` for height display and sight/light calculations
4. Higher elevation = rendered above lower elevation (within same layer)

---

## 🎯 Integration Strategy

### Recommended Approach for THREE.js Managers

#### 1. TokenManager - Sync Strategy

```javascript
class TokenManager {
  constructor(scene) {
    this.scene = scene;
    this.tokenSprites = new Map(); // tokenId → THREE.Sprite
    
    // Hook into Foundry updates
    this.setupHooks();
  }
  
  setupHooks() {
    // Initial load
    Hooks.on("canvasReady", () => {
      this.syncAllTokens();
    });
    
    // Incremental updates
    Hooks.on("createToken", (doc, options, userId) => {
      this.createTokenSprite(doc);
    });
    
    Hooks.on("updateToken", (doc, changes, options, userId) => {
      this.updateTokenSprite(doc, changes);
    });
    
    Hooks.on("deleteToken", (doc, options, userId) => {
      this.removeTokenSprite(doc.id);
    });
  }
  
  syncAllTokens() {
    // Read from canvas.tokens.placeables
    const tokens = canvas.tokens?.placeables || [];
    
    for (const token of tokens) {
      this.createTokenSprite(token.document);
    }
  }
  
  createTokenSprite(tokenDoc) {
    const sprite = new THREE.Sprite(/* ... */);
    
    // Position (convert from top-left to center)
    sprite.position.set(
      tokenDoc.x + tokenDoc.width / 2,
      tokenDoc.y + tokenDoc.height / 2,
      10.0 + (tokenDoc.elevation || 0) // Base z + elevation
    );
    
    // Scale
    sprite.scale.set(tokenDoc.width, tokenDoc.height, 1);
    
    this.tokenSprites.set(tokenDoc.id, sprite);
    this.scene.add(sprite);
  }
  
  updateTokenSprite(tokenDoc, changes) {
    const sprite = this.tokenSprites.get(tokenDoc.id);
    if (!sprite) return;
    
    // Only update changed properties
    if ("x" in changes || "y" in changes) {
      sprite.position.x = tokenDoc.x + tokenDoc.width / 2;
      sprite.position.y = tokenDoc.y + tokenDoc.height / 2;
    }
    
    if ("elevation" in changes) {
      sprite.position.z = 10.0 + (tokenDoc.elevation || 0);
    }
    
    // Update texture if changed
    if ("texture" in changes) {
      this.updateTokenTexture(sprite, tokenDoc.texture.src);
    }
  }
}
```

#### 2. TileManager - Elevation-Based Grouping

```javascript
class TileManager {
  constructor(scene) {
    this.scene = scene;
    this.tileSprites = new Map();
    this.foregroundElevation = canvas.scene.foregroundElevation;
    
    this.setupHooks();
  }
  
  syncAllTiles() {
    const tiles = canvas.scene.tiles || [];
    
    for (const tileDoc of tiles) {
      this.createTileSprite(tileDoc);
    }
  }
  
  createTileSprite(tileDoc) {
    const sprite = new THREE.Sprite(/* ... */);
    
    // Determine z-position based on elevation
    const isOverhead = tileDoc.elevation >= this.foregroundElevation;
    let zPos;
    
    if (isOverhead) {
      // Overhead tiles (roofs, ceilings)
      zPos = 20.0 + (tileDoc.elevation || 0);
    } else if (tileDoc.elevation >= 0) {
      // Foreground tiles
      zPos = 5.0 + (tileDoc.elevation || 0);
    } else {
      // Background tiles (negative elevation)
      zPos = 1.0 + (tileDoc.elevation || 0);
    }
    
    sprite.position.set(
      tileDoc.x + tileDoc.width / 2,
      tileDoc.y + tileDoc.height / 2,
      zPos
    );
    
    // Handle rotation
    if (tileDoc.rotation !== 0) {
      sprite.rotation = THREE.MathUtils.degToRad(tileDoc.rotation);
    }
    
    // Handle texture scaling
    sprite.scale.set(
      tileDoc.width * (tileDoc.texture.scaleX || 1),
      tileDoc.height * (tileDoc.texture.scaleY || 1),
      1
    );
    
    // Visibility
    sprite.visible = !tileDoc.hidden || game.user.isGM;
    
    this.tileSprites.set(tileDoc.id, sprite);
    this.scene.add(sprite);
  }
}
```

#### 3. GridRenderer - Type-Aware Rendering

```javascript
class GridRenderer {
  constructor(scene) {
    this.scene = scene;
    this.gridMesh = null;
    this.gridTexture = null; // Cached texture
    this.lastConfig = null;  // Detect changes
  }
  
  updateGrid() {
    const grid = canvas.scene.grid;
    const config = {
      type: grid.type,
      size: grid.size,
      style: grid.style,
      thickness: grid.thickness,
      color: grid.color?.css || "#000000",
      alpha: grid.alpha || 1
    };
    
    // Check if config changed
    if (this.configEquals(config, this.lastConfig)) {
      return; // No update needed
    }
    
    this.lastConfig = config;
    
    // Remove old grid
    if (this.gridMesh) {
      this.scene.remove(this.gridMesh);
      this.gridMesh.geometry.dispose();
      this.gridMesh.material.dispose();
    }
    
    // Render grid to texture (cached)
    this.gridTexture = this.renderGridToTexture(config);
    
    // Create mesh
    const geometry = new THREE.PlaneGeometry(
      canvas.scene.dimensions.width,
      canvas.scene.dimensions.height
    );
    
    const material = new THREE.MeshBasicMaterial({
      map: this.gridTexture,
      transparent: true,
      opacity: config.alpha,
      depthTest: false
    });
    
    this.gridMesh = new THREE.Mesh(geometry, material);
    this.gridMesh.position.set(
      canvas.scene.dimensions.width / 2,
      canvas.scene.dimensions.height / 2,
      0.4 // Grid z-position
    );
    
    this.scene.add(this.gridMesh);
  }
  
  renderGridToTexture(config) {
    // Render grid lines to canvas, convert to THREE.CanvasTexture
    const gridCanvas = this.drawGridLines(config);
    return new THREE.CanvasTexture(gridCanvas);
  }
  
  drawGridLines(config) {
    // Draw grid based on type (square, hex, etc.)
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // ... draw grid lines based on config.type ...
    
    return canvas;
  }
}
```

---

## 🚨 Critical Integration Points

### 1. Coordinate System Conversion

```javascript
// Foundry uses top-left origin, THREE.js typically uses center
function foundryToThree(x, y, width, height) {
  return {
    x: x + width / 2,
    y: y + height / 2
  };
}
```

### 2. Elevation Mapping

```javascript
// Map Foundry elevation (grid units) to THREE.js z-position (pixels)
function elevationToZ(elevation, baseZ, gridSize) {
  return baseZ + (elevation || 0) * (gridSize / 10); // Scale factor
}
```

### 3. Scene Dimension Synchronization

```javascript
// Ensure THREE.js camera frustum matches Foundry scene
function syncCameraToScene() {
  const dims = canvas.scene.dimensions;
  camera.left = 0;
  camera.right = dims.width;
  camera.top = dims.height;
  camera.bottom = 0;
  camera.updateProjectionMatrix();
}
```

---

## 📋 Implementation Checklist

### Phase 1: Token Integration
- [ ] Hook into `canvasReady` to load initial tokens
- [ ] Hook into `createToken`, `updateToken`, `deleteToken`
- [ ] Convert Foundry token positions to THREE.js sprites
- [ ] Handle token elevation mapping
- [ ] Test with multiple tokens and elevations

### Phase 2: Tile Integration  
- [ ] Load all tiles from `canvas.scene.tiles`
- [ ] Group tiles by elevation (background/foreground/overhead)
- [ ] Map tiles to correct z-positions
- [ ] Handle tile rotation and scaling
- [ ] Test with complex tile setups

### Phase 3: Grid Rendering
- [ ] Detect grid type (square, hex, gridless)
- [ ] Render grid to cached texture
- [ ] Update grid when settings change
- [ ] Support all grid styles (solid, dashed, etc.)

### Phase 4: Synchronization
- [ ] Optimize update handlers (batch updates)
- [ ] Handle scene changes (teardown/rebuild)
- [ ] Test with real-time token movement
- [ ] Profile performance with 50+ tokens

---

## 🎯 Recommendations

### 1. **Use Foundry Hooks for Reactivity**
Instead of polling `canvas.tokens.placeables` every frame, use hooks for incremental updates.

**Benefits**:
- Lower CPU overhead
- Instant synchronization
- Cleaner code

### 2. **Cache Grid as Texture**
Grid rarely changes, so render it once and cache.

**Benefits**:
- No per-frame grid drawing
- Easy to update when settings change
- Low memory overhead

### 3. **Respect Foundry's Elevation System**
Use `scene.foregroundElevation` as the threshold for overhead tiles.

**Benefits**:
- Compatible with Foundry's UI controls
- Works with existing modules
- Predictable behavior

### 4. **Batch Updates**
When multiple tokens move at once (e.g., group movement), batch updates.

**Benefits**:
- Reduced scene graph updates
- Better performance
- Smoother animations

---

## 🔄 Next Steps

1. ✅ Architecture approved
2. 🔄 **Implement TokenManager with hooks** (start here)
3. ⏳ Implement TileManager with elevation grouping
4. ⏳ Implement GridRenderer with caching
5. ⏳ Test integration with real scenes
6. ⏳ Optimize and profile

---

**This fact-finding establishes the foundation for proper Foundry VTT integration.**
