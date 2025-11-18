# Architecture Summary - THREE.js Total Rendering Control

**Date**: 2024-11-18  
**Status**: Approved Architecture

---

## Core Concept

**Map Shine Advanced renders EVERYTHING visual in THREE.js**. Foundry VTT provides only data and UI overlay.

### What THREE.js Renders
- ✅ Background image (with PBR effects)
- ✅ Grid
- ✅ Tiles (background, foreground, overhead)
- ✅ Tokens (synced from Foundry data)
- ✅ Effects (particles, weather, shadows)
- ✅ Post-processing (bloom, color grading)

### What Foundry Provides
- ✅ Data only (token positions, tile data, grid settings)
- ✅ UI overlay (sidebar, chat, character sheets, buttons)
- ✅ Game logic & module hooks

### What's Hidden
- ❌ Foundry's PIXI canvas (opacity: 0, pointer-events: none)

---

## Layer Stack (Z-Order)

```
z = 0     Ground (with PBR effects via render targets)
z = 0.4   Grid overlay
z = 1.0   Background tiles (from Foundry)
z = 5.0   Foreground tiles (from Foundry)
z = 10+   Tokens (from Foundry, z = 10 + elevation)
z = 20    Overhead tiles (roofs)
z = 25-40 Environmental effects (weather, particles)
Post-FX:  Screen-space effects (bloom, color grading)
```

**All rendered in a single THREE.js scene with automatic z-sorting.**

---

## Rendering Pipeline

### Step 1: Read Foundry Data
```javascript
const tokens = canvas.tokens.placeables;
const tiles = canvas.scene.tiles;
const gridConfig = canvas.scene.grid;
```

### Step 2: Update THREE.js Scene
```javascript
tokenManager.syncTokens(tokens); // Creates/updates THREE.Sprite objects
tileManager.syncTiles(tiles);     // Creates/updates THREE.Sprite objects
gridRenderer.updateGrid(gridConfig); // Updates grid mesh
```

### Step 3: Ground Effects (Multi-pass)
```javascript
// Apply PBR effects to ground plane via render targets
renderGroundEffects(); // Specular → Roughness → Water → RT
basePlane.material.map = groundRT.texture;
```

### Step 4: Main Scene Render
```javascript
// Single render call handles all scene objects with z-sorting
renderer.render(scene, camera);
```

### Step 5: Post-Processing (Optional)
```javascript
// Apply bloom, color grading, etc.
renderPostProcessing(sceneRT);
```

---

## Key Managers

### TokenManager
- Syncs `canvas.tokens.placeables` → `THREE.Sprite[]`
- Handles create, update, delete
- Respects elevation (z-position)

### TileManager
- Syncs `canvas.scene.tiles` → `THREE.Sprite[]`
- Groups by overhead flag and z-index
- Creates sprites at correct z-layers

### GridRenderer
- Renders grid based on `canvas.scene.grid`
- Caches to texture for performance
- Supports square, hex, gridless

---

## Benefits

1. **Complete Visual Control** - We render everything, no PIXI interference
2. **Simple Z-Ordering** - THREE.js handles sorting automatically
3. **One Render Call** - Entire scene rendered in single pass (except ground effects)
4. **PBR Effects** - Full control over lighting, materials, shaders
5. **Module Compatibility** - Foundry's game logic unchanged, modules work normally
6. **Performance** - No PIXI → THREE.js texture conversions

---

## Trade-offs

1. **Complexity** - Must sync Foundry data every frame
2. **Token Rendering** - We're responsible for all token visuals
3. **Module Conflicts** - Modules that modify PIXI canvas won't work
4. **Debugging** - Cannot use Foundry's built-in canvas tools

---

## Next Steps

1. ✅ Architecture approved
2. 🔄 Implement `TokenManager` (Phase 1)
3. 🔄 Implement `TileManager` (Phase 1)
4. 🔄 Implement `GridRenderer` (Phase 1)
5. ⏳ Test with real tokens/tiles
6. ⏳ Add environmental effects
7. ⏳ Polish & optimize

---

## 🔍 Foundry Integration Details

**Full Report**: See `FOUNDRY-INTEGRATION-FINDINGS.md`

### Key Data Sources

```javascript
// Tokens (from Foundry)
const tokens = canvas.tokens.placeables;
token.document.x, .y, .elevation, .width, .height, .texture.src

// Tiles (from Foundry)  
const tiles = canvas.scene.tiles;
tile.document.x, .y, .elevation, .width, .height, .texture.src

// Grid (from Foundry)
canvas.scene.grid.type, .size, .style, .color
canvas.scene.foregroundElevation // Overhead tile threshold
```

### Update Hooks

```javascript
// React to Foundry changes
Hooks.on("createToken", (doc) => tokenManager.createSprite(doc));
Hooks.on("updateToken", (doc, changes) => tokenManager.updateSprite(doc, changes));
Hooks.on("deleteToken", (doc) => tokenManager.removeSprite(doc.id));
// Same pattern for tiles
```

### Critical Findings

1. **No `overhead` boolean** - Tiles with `elevation >= scene.foregroundElevation` are overhead
2. **Top-left origin** - Foundry uses top-left, THREE.js uses center (must convert)
3. **Hook-based sync** - Use Foundry hooks for incremental updates (not polling)
4. **6 grid types** - Square, 4 hex variants, gridless
5. **Elevation in grid units** - Not pixels

---

**This architecture gives us total control while maintaining Foundry compatibility.**
