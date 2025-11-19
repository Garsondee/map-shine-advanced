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
- **Implemented**
- Syncs `canvas.tokens.placeables` → `THREE.Sprite[]`
- Handles create, update, delete via hooks
- Respects elevation (z-position)
- Manages selection visuals (orange ring/tint)

### TileManager
- **Implemented**
- Syncs `canvas.scene.tiles` → `THREE.Sprite[]`
- Groups by overhead flag and z-index (Background/Foreground/Overhead)
- Creates sprites at correct z-layers

### GridRenderer
- **Implemented**
- Renders grid based on `canvas.scene.grid`
- Caches to texture for performance
- Supports square and hex grids

### InteractionManager
- **Implemented**
- Handles mouse input (Select, Drag, Drop)
- Raycasts against scene objects with proper Z-plane intersection
- Handles grid snapping during drag
- Syncs updates to Foundry documents (with `animate: false` to prevent hangs)

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
1. **Core Rendering** (Tokens, Tiles, Grid) - Complete
2. **Interaction** (Select, Move, Delete) - Complete
3. **Environmental Effects** (Phase 2) - Next Priority
   - Weather (Rain, Snow)
   - Mask-aware rendering (Indoor/Outdoor)
4. **Post-Processing** (Phase 3)
   - Bloom, Color Grading
5. **Polish & Optimize**

---

## Foundry Integration Details

**Full Report**: See `FOUNDRY-INTEGRATION-FINDINGS.md`

### Critical Learnings
1. **Hanging Updates**: Token updates must use `{animate: false}` when the PIXI canvas is hidden, otherwise Foundry waits for animation promises that never resolve.
2. **Coordinate Conversion**: 
   - Foundry: Top-Left Origin (Y-down)
   - THREE.js: Center Origin (Y-up)
   - Conversion: `y_three = sceneHeight - (y_foundry + height/2)`
3. **Raycasting**: Simple unprojection fails for 2.5D. Must use **Ray-Plane Intersection** with the object's Z-plane to get accurate world coordinates.
4. **Layering**:
   - Background Tiles: z=1.0
   - Foreground Tiles: z=5.0
   - Tokens: z=10.0 + elevation
   - Overhead Tiles: z=20.0 (determined by `elevation >= foregroundElevation`)

---

**This architecture gives us total control while maintaining Foundry compatibility.**
