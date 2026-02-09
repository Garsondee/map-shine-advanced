# Map Shine Advanced - Layering Architecture Plan

**Status**: ARCHITECTURAL DESIGN - REQUIRES APPROVAL BEFORE IMPLEMENTATION  
**Date**: 2024-11-18  
**Priority**: CRITICAL - Blocking all future effect development

---

## Executive Summary

Map Shine Advanced **completely replaces** Foundry VTT's PIXI-based canvas rendering with a THREE.js-based system. We render EVERYTHING visual (background, tiles, tokens, grid, effects, weather) in THREE.js, while Foundry provides only the data and UI.

### Critical Requirements

1. **Total Visual Control** - THREE.js renders all visual elements (no PIXI interleaving)
2. **Foundry Data Integration** - Read token positions, grid settings, tile data from Foundry API
3. **Multi-Layer Rendering** - Ground → Tiles → Tokens → Overhead Tiles → Weather → Post-FX
4. **Z-Order Flexibility** - Support complex layering (roofs above tokens, weather above roofs)
5. **Mask-Based Visibility** - Effects respond to luminance masks (e.g., indoor/outdoor detection)
6. **UI Preservation** - Keep Foundry's HTML/CSS UI (sidebar, chat, character sheets) untouched

---

## Current System Analysis

### What Exists Now

```
RenderLoop.render() {
  effectComposer.render(deltaTime);  // Updates effects
  renderer.render(scene, camera);     // Single THREE.js render pass
}
```

**Current State**:
- ✅ Foundry's PIXI canvas is **hidden** (opacity: 0)
- ✅ THREE.js canvas renders in its place
- ✅ Only renders background + specular effect
- ❌ No tokens, tiles, or grid yet
- ❌ No multi-layer system
- ❌ No z-ordering for complex scenes

### Foundry's Data Sources (What We Read)

Foundry VTT provides data through its API that we'll render in THREE.js:

```javascript
// Background image
canvas.scene.background.src → Load as THREE.Texture

// Grid configuration
canvas.scene.grid.size → Grid cell size in pixels
canvas.scene.grid.type → Grid type (square, hex, etc.)
canvas.scene.dimensions → World dimensions

// Tiles (background, foreground, overhead)
canvas.scene.tiles → Array of tile data
  .texture.src → Tile image path
  .x, .y, .width, .height → Position and size
  .z → Z-index (determines layer)
  .overhead → Boolean (renders above tokens)
  
// Tokens
canvas.tokens.placeables → Array of Token objects
  .document.texture.src → Token image
  .document.x, .document.y → Position
  .document.width, .document.height → Size
  .document.elevation → Height (for z-ordering)
  
// Lighting (future)
canvas.lighting.placeables → Array of light sources
```

**Key insight**: We **don't render** Foundry's PIXI layers—we **replicate** them in THREE.js using Foundry's data.

---

## Proposed Architecture: Full THREE.js Rendering Pipeline

### Design Philosophy

**THREE.js handles ALL visuals**, **Foundry handles data + UI**.

- Foundry provides: Token positions, tile data, grid settings, game logic
- THREE.js renders: Background, tiles, tokens, grid, effects, weather
- Foundry UI (sidebar, chat, buttons) remains as HTML/CSS overlay

We render in **multiple passes** to a single THREE.js scene, with z-ordering managed by THREE.js mesh layers and render targets.

---

## Scene Layer Definition

### Layer Stack (Render Order: Bottom to Top)

```javascript
export const SceneLayers = {
  // ===== GROUND LAYERS (Below Everything) =====
  GROUND_BASE: {
    order: 100,
    name: 'GroundBase',
    description: 'Scene background image (albedo)',
    zPosition: 0,
    depthWrite: true,
    depthTest: false
  },
  
  GROUND_MATERIAL: {
    order: 200,
    name: 'GroundMaterial',
    description: 'PBR material effects on background (specular, roughness, normal maps)',
    zPosition: 0.1,
    depthWrite: true,
    depthTest: true
  },
  
  GROUND_SURFACE: {
    order: 300,
    name: 'GroundSurface',
    description: 'Animated surface effects (water ripples, lava, iridescence)',
    zPosition: 0.2,
    depthWrite: true,
    depthTest: true
  },
  
  GROUND_DECALS: {
    order: 400,
    name: 'GroundDecals',
    description: 'Ground-level particles (fog, dust, ground shadows)',
    zPosition: 0.3,
    depthWrite: false,
    depthTest: true
  },
  
  GRID: {
    order: 450,
    name: 'Grid',
    description: 'Grid overlay (rendered as lines or textured plane)',
    zPosition: 0.4,
    depthWrite: false,
    depthTest: true
  },
  
  // ===== TILE LAYERS (Foundry tile data → THREE.js sprites) =====
  TILES_BACKGROUND: {
    order: 500,
    name: 'TilesBackground',
    description: 'Background tiles from Foundry (z < 0 in Foundry)',
    zPosition: 1.0,
    depthWrite: true,
    depthTest: true,
    foundrySource: 'canvas.scene.tiles (where overhead === false && z < 0)'
  },
  
  TILES_FOREGROUND: {
    order: 600,
    name: 'TilesForeground',
    description: 'Foreground tiles from Foundry (z >= 0, overhead === false)',
    zPosition: 5.0,
    depthWrite: true,
    depthTest: true,
    foundrySource: 'canvas.scene.tiles (where overhead === false && z >= 0)'
  },
  
  // ===== TOKEN LAYER (Foundry token data → THREE.js sprites) =====
  TOKENS: {
    order: 700,
    name: 'Tokens',
    description: 'Character/NPC tokens (rendered as billboarded sprites with elevation)',
    zPosition: 10.0, // Base z, modified by token elevation
    depthWrite: true,
    depthTest: true,
    foundrySource: 'canvas.tokens.placeables',
    elevationAware: true // z = zPosition + token.document.elevation
  },
  
  // ===== OVERHEAD TILE LAYER =====
  TILES_OVERHEAD: {
    order: 800,
    name: 'TilesOverhead',
    description: 'Overhead/roof tiles from Foundry (overhead === true)',
    zPosition: 20.0,
    depthWrite: true,
    depthTest: true,
    foundrySource: 'canvas.scene.tiles (where overhead === true)'
  },
  
  // ===== ENVIRONMENTAL EFFECTS (Above Tokens) =====
  ENVIRONMENTAL_LOW: {
    order: 900,
    name: 'EnvironmentalLow',
    description: 'Low-altitude environmental (canopy shadows, roof shadows)',
    zPosition: 25.0,
    depthWrite: false,
    depthTest: true,
    maskAware: true // Can be masked by _Outdoors luminance mask
  },
  
  PARTICLES_OVERHEAD: {
    order: 1000,
    name: 'ParticlesOverhead',
    description: 'Above-token particles (rain, snow, leaves)',
    zPosition: 30.0,
    depthWrite: false,
    depthTest: true,
    maskAware: true
  },
  
  ENVIRONMENTAL_HIGH: {
    order: 1100,
    name: 'EnvironmentalHigh',
    description: 'High-altitude environmental (cloud shadows, lightning, aurora)',
    zPosition: 40.0,
    depthWrite: false,
    depthTest: false,
    maskAware: true
  },
  
  // ===== POST-PROCESSING (Full Screen) =====
  POST_PROCESSING: {
    order: 1200,
    name: 'PostProcessing',
    description: 'Screen-space effects (bloom, color grading, vignette, DOF)',
    zPosition: null, // Render target pass, not scene object
    depthWrite: false,
    depthTest: false
  }
};
```

---

## Rendering Pipeline Architecture

### Pure THREE.js Multi-Pass Strategy

**Strategy**: All visual elements exist as THREE.js scene objects or render target effects. No PIXI integration needed.

#### Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: READ FOUNDRY DATA                                   │
│ - Load token positions from canvas.tokens.placeables        │
│ - Load tile data from canvas.scene.tiles                    │
│ - Load grid settings from canvas.scene.grid                 │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: UPDATE THREE.js SCENE OBJECTS                       │
│ - Update token sprite positions/textures                    │
│ - Update tile sprite positions/textures                     │
│ - Sync with Foundry data changes (reactive)                 │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 3: GROUND EFFECTS PASS (Multi-pass render targets)    │
│ - Base mesh with albedo texture → RT_Base                   │
│ - Apply PBR material effects → RT_Material                  │
│ - Apply surface effects (water, lava) → RT_Surface          │
│ - Result: Composited ground texture                         │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 4: MAIN SCENE RENDER (Single scene.render() call)     │
│ THREE.js scene contains (z-ordered):                        │
│   z=0    : Ground plane (with RT_Surface as texture)        │
│   z=0.4  : Grid overlay                                     │
│   z=1-5  : Background & foreground tile sprites             │
│   z=10+  : Token sprites (z = 10 + elevation)               │
│   z=20   : Overhead tile sprites                            │
│   z=25-40: Environmental effects (particles, weather)       │
│ → Renders to RT_SceneComposite                              │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 5: POST-PROCESSING PASS (Optional)                    │
│ - Read RT_SceneComposite                                    │
│ - Apply bloom, color grading, vignette, DOF                 │
│ - Render to screen (renderer.render to null target)         │
└─────────────────────────────────────────────────────────────┘
```

#### Implementation Strategy

```javascript
class LayeredRenderPipeline {
  constructor(renderer, sceneComposer, effectComposer) {
    this.threeRenderer = renderer;
    this.sceneComposer = sceneComposer;
    this.effectComposer = effectComposer;
    
    // Main THREE.js scene (contains all visual elements)
    this.scene = sceneComposer.scene;
    
    // Render targets for multi-pass effects
    this.groundRT = null;      // Ground material effects
    this.sceneRT = null;       // Composite scene (optional, for post-processing)
    
    // Scene object managers
    this.tokenManager = null;  // Syncs Foundry token data → THREE.js sprites
    this.tileManager = null;   // Syncs Foundry tile data → THREE.js sprites
    this.gridRenderer = null;  // Renders grid based on Foundry settings
  }
  
  initialize(width, height) {
    // Create render targets for multi-pass effects
    this.groundRT = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true
    });
    
    this.sceneRT = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true
    });
    
    // Initialize scene object managers
    this.tokenManager = new TokenManager(this.scene);
    this.tileManager = new TileManager(this.scene);
    this.gridRenderer = new GridRenderer(this.scene);
  }
  
  render(deltaTime) {
    // ===== PASS 1: Sync Foundry Data → THREE.js Scene =====
    this.syncFoundryData();
    
    // ===== PASS 2: Ground Material Effects (Multi-pass) =====
    this.renderGroundEffects();
    
    // ===== PASS 3: Main Scene Render =====
    // Single renderer.render() call renders entire scene with z-ordering
    this.effectComposer.render(deltaTime); // Updates all effects
    
    // If post-processing enabled, render to intermediate target
    if (this.postProcessingEnabled) {
      this.threeRenderer.setRenderTarget(this.sceneRT);
      this.threeRenderer.render(this.scene, this.camera);
      
      // ===== PASS 4: Post-Processing =====
      this.renderPostProcessing();
    } else {
      // Render directly to screen
      this.threeRenderer.setRenderTarget(null);
      this.threeRenderer.render(this.scene, this.camera);
    }
  }
  
  syncFoundryData() {
    // Update tokens from Foundry data
    this.tokenManager.syncTokens(canvas.tokens.placeables);
    
    // Update tiles from Foundry data
    this.tileManager.syncTiles(canvas.scene.tiles);
    
    // Update grid (only if settings changed)
    this.gridRenderer.updateGrid(canvas.scene.grid);
  }
  
  renderGroundEffects() {
    // Ground effects modify the base plane's material via render targets
    const groundEffects = this.effectComposer.getEffectsByLayers([
      SceneLayers.GROUND_MATERIAL,
      SceneLayers.GROUND_SURFACE
    ]);
    
    // Multi-pass: Each effect reads from previous RT, writes to next
    let currentRT = this.groundRT;
    
    for (const effect of groundEffects) {
      effect.update(this.effectComposer.timeManager.getTimeInfo());
      effect.renderToTarget(currentRT);
    }
    
    // Update base plane material to use final ground texture
    const basePlane = this.sceneComposer.getBasePlane();
    basePlane.material.map = currentRT.texture;
  }
  
  renderPostProcessing() {
    // Read from sceneRT, apply post-processing effects, render to screen
    const postEffects = this.effectComposer.getEffectsByLayers([
      SceneLayers.POST_PROCESSING
    ]);
    
    this.threeRenderer.setRenderTarget(null); // Render to screen
    
    for (const effect of postEffects) {
      effect.update(this.effectComposer.timeManager.getTimeInfo());
      effect.renderFullscreenQuad(this.sceneRT.texture);
    }
  }
  
}

/**
 * Token Manager - Syncs Foundry token data to THREE.js sprites
 */
class TokenManager {
  constructor(scene) {
    this.scene = scene;
    this.tokenSprites = new Map(); // foundryTokenId → THREE.Sprite
  }
  
  syncTokens(foundryTokens) {
    const currentTokenIds = new Set();
    
    for (const foundryToken of foundryTokens) {
      const tokenId = foundryToken.id;
      currentTokenIds.add(tokenId);
      
      // Get or create THREE.js sprite for this token
      let sprite = this.tokenSprites.get(tokenId);
      if (!sprite) {
        sprite = this.createTokenSprite(foundryToken);
        this.tokenSprites.set(tokenId, sprite);
        this.scene.add(sprite);
      }
      
      // Update sprite from Foundry data
      this.updateTokenSprite(sprite, foundryToken);
    }
    
    // Remove sprites for deleted tokens
    for (const [tokenId, sprite] of this.tokenSprites.entries()) {
      if (!currentTokenIds.has(tokenId)) {
        this.scene.remove(sprite);
        sprite.material.dispose();
        sprite.geometry.dispose();
        this.tokenSprites.delete(tokenId);
      }
    }
  }
  
  createTokenSprite(foundryToken) {
    const THREE = window.THREE;
    
    // Load token texture
    const texture = new THREE.TextureLoader().load(foundryToken.document.texture.src);
    
    // Create sprite material
    const material = new THREE.SpriteMaterial({ 
      map: texture,
      transparent: true
    });
    
    const sprite = new THREE.Sprite(material);
    sprite.userData.foundryTokenId = foundryToken.id;
    
    return sprite;
  }
  
  updateTokenSprite(sprite, foundryToken) {
    // Update position (Foundry uses top-left origin, THREE.js uses center)
    sprite.position.set(
      foundryToken.document.x + foundryToken.document.width / 2,
      foundryToken.document.y + foundryToken.document.height / 2,
      SceneLayers.TOKENS.zPosition + (foundryToken.document.elevation || 0)
    );
    
    // Update scale to match Foundry token size
    sprite.scale.set(
      foundryToken.document.width,
      foundryToken.document.height,
      1
    );
    
    // Update texture if changed
    const newTextureSrc = foundryToken.document.texture.src;
    if (sprite.material.map.image?.src !== newTextureSrc) {
      const newTexture = new THREE.TextureLoader().load(newTextureSrc);
      sprite.material.map.dispose();
      sprite.material.map = newTexture;
    }
  }
}

/**
 * Tile Manager - Similar to TokenManager but for tiles
 */
class TileManager {
  constructor(scene) {
    this.scene = scene;
    this.tileSprites = new Map();
  }
  
  syncTiles(foundryTiles) {
    // Similar implementation to TokenManager
    // Groups tiles into background/foreground/overhead based on z-index
  }
}

/**
 * Grid Renderer - Renders grid based on Foundry settings
 */
class GridRenderer {
  constructor(scene) {
    this.scene = scene;
    this.gridMesh = null;
  }
  
  updateGrid(gridConfig) {
    // Create/update grid mesh based on gridConfig
    // Support square, hex, gridless
  }
}

---

## Mask-Aware Rendering System

### Outdoor/Indoor Detection

**Use Case**: Weather effects (rain, cloud shadows) should not render indoors.

#### Mask Format

- `BattleMap_Outdoors.png` - Luminance mask
  - **White** (255) = Outdoor area (render weather)
  - **Black** (0) = Indoor area (skip weather)
  - **Gray** = Partial (e.g., under awning)

#### Shader Implementation

```glsl
// In weather effect fragment shader
uniform sampler2D uOutdoorsMask;
uniform float uMaskThreshold; // Default: 0.5

void main() {
  vec2 uv = vUv;
  
  // Sample outdoor mask
  float outdoorFactor = texture2D(uOutdoorsMask, uv).r;
  
  // Apply threshold
  float visibility = step(uMaskThreshold, outdoorFactor);
  
  // Calculate weather effect (rain, clouds, etc.)
  vec3 weatherColor = calculateWeather();
  
  // Modulate by outdoor visibility
  vec3 finalColor = weatherColor * visibility;
  
  gl_FragColor = vec4(finalColor, visibility);
}
```

#### Dynamic Zoom-Based Masking

**Advanced Feature**: Mask strength changes with zoom level.

```javascript
class WeatherEffect extends EffectBase {
  update(timeInfo) {
    // Get camera zoom level (orthographic size)
    const zoom = this.camera.zoom || 1.0;
    
    // At high zoom (zoomed in), indoor masking is stronger
    // At low zoom (zoomed out), masking fades (see weather from above)
    const maskStrength = THREE.MathUtils.clamp(zoom / 2.0, 0.2, 1.0);
    
    this.material.uniforms.uMaskThreshold.value = 0.5 * maskStrength;
  }
}
```

---

## Effect Migration Strategy

### Refactoring EffectBase Contract

**Current** (Material Replacement):
```javascript
class SpecularEffect extends EffectBase {
  render(renderer, scene, camera) {
    // Material is already applied, rendering happens in main loop
  }
}
```

**New** (Multi-Pass Render Target):
```javascript
class SpecularEffect extends EffectBase {
  constructor() {
    super('specular', SceneLayers.GROUND_MATERIAL, 'low');
    this.fullscreenQuad = null;
  }
  
  initialize(renderer, scene, camera) {
    // Create fullscreen quad with shader material
    this.fullscreenQuad = this.createFullscreenQuad();
  }
  
  render(inputRT, outputRT) {
    // Read from input render target
    this.material.uniforms.tDiffuse.value = inputRT.texture;
    
    // Render to output render target
    this.renderer.setRenderTarget(outputRT);
    this.renderer.render(this.fullscreenQuad, this.camera);
  }
  
  createFullscreenQuad() {
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uSpecularMap: { value: this.specularMask },
        // ... other uniforms
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader()
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    const scene = new THREE.Scene();
    scene.add(mesh);
    
    return scene;
  }
}
```

---

## Performance Considerations

### Render Target Budget

**Per-Frame RT Allocations**:
- Ground Pass: 2-3 RTs (ping-pong)
- Overhead Pass: 2-3 RTs (ping-pong)
- Post-Processing: 2 RTs (bloom, etc.)

**Total**: ~7 RTs × (1920×1080×4 bytes) = **56 MB** at 1080p

**Optimization**: Reuse RTs across frames, only allocate what's needed per GPU tier.

### GPU Tier Gating

```javascript
const TIER_BUDGETS = {
  low: {
    maxRenderTargets: 3,
    groundPassEffects: 2,
    overheadPassEffects: 1,
    postProcessing: false
  },
  medium: {
    maxRenderTargets: 5,
    groundPassEffects: 4,
    overheadPassEffects: 2,
    postProcessing: true
  },
  high: {
    maxRenderTargets: 8,
    groundPassEffects: 8,
    overheadPassEffects: 4,
    postProcessing: true
  }
};
```

---

## Implementation Roadmap

### Phase 1: Core Managers (Week 1-2)
- [x] **Implement `TokenManager`** - Sync Foundry tokens to THREE.js sprites
- [x] **Implement `TileManager`** - Sync Foundry tiles to THREE.js sprites  
- [x] **Implement `GridRenderer`** - Render grid based on Foundry settings
- [x] **Implement `InteractionManager`** - Select, Drag, Delete logic
- [x] **Test z-ordering** - Verify tokens render above ground, below overhead tiles

### Phase 2: Refactor Effect System (Week 3)
- [ ] **Update `EffectBase`** with new contract for render target effects
- [ ] **Refactor `SpecularEffect`** to use `renderToTarget()` method
- [ ] **Implement `LayeredRenderPipeline`** class
- [ ] **Integrate with existing `RenderLoop`**

### Phase 3: Token & Tile Rendering (Week 4-5)
- [ ] **Create token sprites** from Foundry data
- [ ] **Handle token updates** (position, texture, elevation changes)
- [ ] **Create tile sprites** with proper z-ordering
- [ ] **Test with real scenes** (tokens + overhead tiles)

### Phase 4: Environmental Effects (Week 6-7)
- [ ] **Implement weather system** (rain, snow)
- [ ] **Add mask-aware rendering** (_Outdoors mask integration)
- [ ] **Create particle systems** (GPU instancing)
- [ ] **Test overhead occlusion** (weather doesn't show through roofs)

### Phase 5: Polish & Optimization (Week 8+)
- [ ] **Dynamic zoom-based masking**
- [ ] **Post-processing pass** (bloom, color grading)
- [ ] **Performance profiling** and GPU tier gating
- [ ] **Module compatibility testing** with popular Foundry modules

---

## Decision Points

### ⚠️ REQUIRES APPROVAL

**Question 1**: Should token sprites be **billboarded** (always face camera) or **flat** (part of ground plane)?

**Recommendation**: **Billboarded** for isometric-style tokens, **flat** for top-down tokens. Make this a setting.

---

**Question 2**: Should we **cache token textures** or reload on every sync?

**Recommendation**: **Cache** with texture atlas. Reload only when Foundry texture actually changes.

---

**Question 3**: Should grid be **rendered every frame** or **cached to texture**?

**Recommendation**: **Cached texture** for grid. Only regenerate when grid settings change.

---

**Question 4**: Should we support **animated tokens** (sprite sheets for walk cycles, etc.)?

**Recommendation**: **Phase 2 feature**. Start with static token images.

---

## Open Questions

1. **Lighting Integration**: How do Foundry's light sources integrate with THREE.js PBR? (Use THREE.PointLight synced to canvas.lighting.placeables?)
2. **Fog of War**: Render as stencil mask in THREE.js or shader-based visibility?
3. **Token Shadows**: Should tokens cast real-time shadows on ground? (Expensive, maybe fake with decals)
4. **Performance Target**: 30fps minimum on low-tier GPUs (reduce particle counts, skip post-processing)
5. **Module Compatibility**: How to handle modules that expect PIXI canvas? (Provide compatibility shim?)

---

## Foundry VTT Integration Findings

**Source Code Analysis** (see `FOUNDRY-INTEGRATION-FINDINGS.md` for full details)

### Critical Discoveries

1. **No `overhead` boolean on tiles** - Instead, tiles with `elevation >= scene.foregroundElevation` are overhead
2. **Foundry uses top-left origin** - Must convert to center for THREE.js sprites
3. **Layer z-indexes are INVERTED** - TilesLayer has zIndex 300, TokenLayer has 200 (opposite of render order)
4. **Hooks available for incremental updates** - `createToken`, `updateToken`, `deleteToken`, etc.
5. **Grid system has 6 types** - Square, Hexoddr, Hexevenr, Hexoddq, Hexevenq, Gridless

### Foundry Data Access Points

```javascript
// Tokens
canvas.tokens.placeables // Array of Token objects
token.document.x, .y, .elevation, .width, .height
token.document.texture.src

// Tiles  
canvas.scene.tiles // TileDocument collection
tile.document.x, .y, .elevation, .width, .height
tile.document.texture.src, .scaleX, .scaleY

// Grid
canvas.scene.grid.type, .size, .style, .color, .alpha
canvas.scene.foregroundElevation // Threshold for overhead tiles

// Scene dimensions
canvas.scene.dimensions.width, .height, .size
```

### Hook-Based Synchronization

```javascript
// TokenManager hooks
Hooks.on("canvasReady", () => syncAllTokens());
Hooks.on("createToken", (doc) => createSprite(doc));
Hooks.on("updateToken", (doc, changes) => updateSprite(doc, changes));
Hooks.on("deleteToken", (doc) => removeSprite(doc.id));

// TileManager hooks (same pattern)
Hooks.on("createTile", ...);
Hooks.on("updateTile", ...);
Hooks.on("deleteTile", ...);
```

### Coordinate Conversion

```javascript
// Foundry → THREE.js
function toThreePos(foundryX, foundryY, width, height) {
  return {
    x: foundryX + width / 2,  // Center instead of top-left
    y: foundryY + height / 2,
    z: calculateZ(elevation)
  };
}
```

---

## Next Steps

1. **Review this document** - Confirm architecture makes sense
2. **Review Foundry integration findings** - `FOUNDRY-INTEGRATION-FINDINGS.md`
3. **Prototype `TokenManager`** with Foundry hooks - Start with incremental updates
4. **Test with real Foundry scenes** - Verify synchronization works
5. **Iterate based on learnings** - Adjust architecture if needed

---

**APPROVAL REQUIRED BEFORE PROCEEDING**
