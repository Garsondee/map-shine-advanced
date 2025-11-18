# Map Shine Advanced — Project Plan

## Vision
Replace Foundry VTT's rendering system with a three.js-based 2.5D engine that delivers cinematic visual effects (PBR materials, particles, weather, post-processing) while maintaining compatibility with Foundry's token workflow and gracefully handling non-compatible maps.

## Product Goals
- **Performance-first**: Avoid the "layers upon layers" performance trap of the original Map Shine
- **Intelligent resource management**: Shared effect dependencies (e.g., cloud shadows affecting specular surfaces)
- **Artist-friendly**: Suffix-based texture system (`BattleMap_Specular.png`, `BattleMap_Fire.png`, etc.)
- **User-friendly UI**: Consistent, non-overwhelming controls with contextual help for non-technical users
- **Foundry integration**: Token drag-drop works seamlessly; non-compatible maps bypass the system
- **Maintainable architecture**: Clean separation of concerns to prevent fragile interdependencies

## Guiding Principles
- Single entrypoint: `scripts/module.js` handles Foundry hooks, defers to bootstrap modules.
- Strong separation of concerns; small, focused modules.
- Explicit, typed JSDoc for public APIs and complex internals.
- No runtime dead code; avoid feature bloat.
- Prefer local vendored deps; use CDN only where dependency trees are large and optional.

## Proposed Directory Structure
- `scripts/`
  - `core/`
    - `bootstrap.js` — high-level startup orchestrator (called from `module.js`).
    - `capabilities.js` — GPU/WebGL/WebGPU detection helpers.
    - `renderer-strategy.js` — decides renderer tier and constructs the renderer.
    - `errors.js` — user-facing error helpers (dialogs, notifications).
    - `log.js` — centralized logging utility (namespaced).
  - `render/`
    - `webgpu/` — WebGPURenderer helpers, pipelines, materials.
    - `webgl/` — WebGLRenderer helpers, materials, post-processing.
    - `common/` — shared render utilities (cameras, lights, resize handling).
  - `scene/` — scene graph creation, loaders for assets, environment setup.
  - `assets/` — asset management, caching, preloading, texture utils.
  - `ui/` — settings panels, toolbars, Foundry app windows.
  - `settings/` — Foundry settings registration and accessors.
  - `utils/` — general helpers (math, async, guards).
  - `types.jsdoc` — shared JSDoc typedefs for editor intellisense.
- `styles/` — stylesheet(s) scoped to module UI.
- `docs/` — design and usage documentation (this file, ADRs if needed).
- `scripts/vendor/three/` — local three.js artifacts.

## Entrypoint Responsibilities (`scripts/module.js`)
- Register Foundry hooks (`init`, `ready`, etc.).
- On `ready`, call `core/bootstrap.bootstrap()`.
- Do not directly manage renderers, scenes, or UI.

## Bootstrap Flow
1. `capabilities.detect()` → returns capability object and computed tier.
2. `rendererStrategy.create(capabilities)` → chooses and constructs renderer.
3. `scene.createDefault(renderer)` → basic scene to validate pipeline.
4. `ui/status.notifyTier(tier)` → one-line user feedback.
5. Wire resize and lifecycle hooks.
6. If any stage fails → `errors.showCompatibility()` with actionable guidance.

## Renderer Strategy (Decision Outline)
- If `navigator.gpu` and WebGPU adapter available → try WebGPU.
  - If WebGPU init fails → fall through to WebGL2.
- Else if WebGL2 context available → WebGL2.
- Else if WebGL1 context available → WebGL1 (limited mode).
- Else → show compatibility error.

## Error Handling & Messaging
- Centralize dialogs/notifications in `core/errors.js`.
- Include detected capability summary and recommended actions.
- Prefer non-blocking notifications for success/normal operations.

## JSDoc Standards
- Use `@module`, `@public`, `@private`.
- Provide `@typedef` and `@typedef {Object}` patterns in `types.jsdoc`.
- Document module exports with `@returns`, `@param`, and error conditions.
- For Foundry hooks, document lifecycle expectations and side effects.

## Coding Conventions
- ES Modules only inside `scripts/`.
- No global state except `window.MapShine` (readonly facade where possible).
- Destructure imports explicitly; no wildcard imports.
- Short functions; prefer pure helpers.

## Asset System (Suffix-Based Texture Loading)
Maps can use suffixed textures alongside base texture for effect masks:
- `BattleMap.png` / `.jpg` / `.webp` — Base diffuse/albedo texture
- `BattleMap_Specular.png` — Colored luminance mask for specular highlights (black = non-specular)
- `BattleMap_Roughness.png` — Roughness map for PBR (optional, intelligent fallback if missing)
- `BattleMap_Normal.png` — Normal map for lighting detail
- `BattleMap_Fire.png` — Fire effect mask (may need transparency)
- `BattleMap_Outdoors.png` — B&W mask: indoor vs outdoor areas (enables targeted weather effects)
- `BattleMap_Iridescence.png` — Iridescence/oil-slick effect mask
- Additional masks as effects expand

**Supported Formats**: JPG, PNG, WebP (some masks need transparency, most are luminance)

**Asset Loader Responsibilities**:
- Detect available masks by probing filesystem/paths
- Load textures asynchronously with progress tracking
- Cache loaded assets for reuse
- Handle missing optional masks with intelligent fallbacks (e.g., derive roughness from specular)
- Support all three image formats with automatic detection

## Effect System Architecture

### Core Technical Approach
Map Shine Advanced uses **image-based PBR with layered effect composition**:
- **Masked Textures**: Suffix-based system (BattleMap_Specular.png, etc.)
- **Procedural Noise**: Perlin/simplex noise driving animation (heat distortion, water ripples)
- **Camera Parallax**: Multi-layer depth illusion for 2.5D
- **Custom Shaders**: GLSL shaders for advanced effects (heat distortion, iridescence)
- **GPU Particles**: Instanced rendering for fire, smoke, rain, etc.

### Effect Composition & Layering
Effects render in **ordered layers** with proper compositing:

1. **Base Layer**: Albedo texture (BattleMap.png)
2. **Material Layer**: PBR materials (specular, roughness, normal maps)
3. **Surface Effects Layer**: Water, iridescence, heat distortion
4. **Particle Layer**: Fire, smoke, rain (depth-sorted billboards)
5. **Environmental Layer**: Cloud shadows, fog, canopy shadows
6. **Post-Processing Layer**: Bloom, color grading, DOF

**Effect Composer** orchestrates:
- Dependency resolution (e.g., cloud shadows → specular lighting)
- Render order enforcement
- Shared render targets (shadow maps, depth buffers)
- Performance gating (disable expensive effects on low-tier GPUs)

### Effect Definition Structure
Each effect:
- Declares required/optional masks
- Provides custom GLSL shader code or material setup
- Exposes user-adjustable parameters (Tweakpane controls)
- Can read from shared effect outputs (render-to-texture)
- Defines GPU tier requirements (high/medium/low)

**Effect Categories**:
1. **Material Effects** (surface appearance)
   - Specular highlights (metallic shine, wet surfaces)
   - Iridescence (oily, magical shimmer)
   - Water (reflections, caustics, ripples)
   - Heat distortion
2. **Particle Effects** (animated sprites/geometry)
   - Fire, smoke, embers
   - Rain, snow
   - Dust, pollen
   - Magic sparkles
3. **Environmental Effects** (scene-wide)
   - Cloud shadows (move across outdoor areas, visible from above when zoomed out)
   - Weather systems (wind direction/gusts, precipitation)
   - Canopy shadows (tree coverage)
   - Day/night cycle
4. **Vegetation** (animated geometry)
   - Trees/bushes swaying with wind
   - Grass movement
5. **Post-Processing** (screen-space effects)
   - Color grading (Sin City selective color, LUTs)
   - Bloom, glow
   - Depth of field, rack focus
   - Grain, vignette, chromatic aberration
   - Film emulation presets

**Effect Dependency Graph**:
- Example: Cloud shadow writes to a "shadow map" texture
- Specular effect reads shadow map to darken shiny areas under clouds
- Managed by a central `EffectComposer` that resolves dependencies and render order

## Foundry VTT Integration
**Canvas Replacement Strategy**:
- **Completely replace** Foundry's canvas renderer (not overlay)
- Rationale: Full control over lighting, fog of war culling, rendering pipeline
- Must reimplement/respect:
  - Grid size and scene padding settings
  - Token distance measurements (cross-compatible with all game systems)
  - Fog of War rendering with intelligent culling optimization
  - Lighting system (full control for integration with effects)
- Use **Foundry's native hook system** (`canvasReady`, `canvasTearDown`) for v13 compatibility
- Maintain compatibility with other modules where possible

**Token Compatibility**:
- Hook into Foundry's token placement system
- Tokens rendered as billboards/sprites in three.js scene
- Maintain Z-order and selection behavior
- Token drag-drop updates three.js sprite positions in real-time
- Respect token distance calculations for game system compatibility

**Scene Enablement & Settings**:
- **Explicit opt-in**: Map must be enabled for Map Shine in scene settings (not auto-detected)
- Scene flag: `scene.flags['map-shine-advanced'].enabled = true`
- All effect settings stored in `scene.flags['map-shine-advanced'].effects`
- Settings packaged with scene for distribution
- **Version migration system**: Detect and migrate settings from older module versions

**Three-Tier Settings Control**:
1. **Map Maker Mode** (Author):
   - Creates baseline effect settings and saves to scene
   - Full control over all effects and parameters
   - Settings become the "original vision"
2. **GM Mode** (Game Master):
   - Can tweak Map Maker's settings for their table
   - "Revert to Original" button to restore Map Maker settings
   - GM tweaks saved separately per scene
3. **Player Mode** (End Users):
   - Can disable or reduce intensity of effects
   - Player preferences saved per-client (not distributed)
   - Always have final say over their visual experience

**Settings Integration**:
- Use Foundry's `game.settings` API for module-wide preferences
- Per-scene settings stored in scene flags (distributed with map)
- Per-user overrides stored in client settings (local only)
- Settings categories: Renderer, Effects, Performance, UI, Compatibility

## UI Architecture
**Design Goals**:
- Scalable: Handle 20+ effects without overwhelming users
- Contextual: Only show controls relevant to active effects
- Helpful: Every control has tooltip/help icon with usage guide
- Consistent: Standardized control types (sliders, toggles, color pickers)
- Performant: UI updates don't trigger expensive re-renders

**Proposed UI Structure**:
- **Effect Browser**: Collapsible tree/accordion view
  - Categories: Material, Particle, Environmental, Vegetation, Post-Processing
  - Each effect shows: Enable toggle, status indicator, parameter count
- **Effect Editor Panel**: Opens when effect selected
  - Parameter controls grouped logically
  - "How to use" section with setup instructions
  - Live preview thumbnails where applicable
- **Performance Monitor**: Optional overlay showing FPS, draw calls, memory
- **Preset System**: Save/load effect combinations as named presets

**UI Libraries** (Confirmed):
- **Tweakpane** for parameter controls (chosen for extensibility and contextual help support)
- Foundry's native `Application` class for window management
- Custom CSS components for effect browser

**In-App Effect Editing**:
- Allow users to create/edit effects without requiring suffixed texture files
- **Simple editors**:
  - Point placement tool for particle emitters (candles, torches, magic effects)
  - Area selection for discrete effects (fire zones, water areas)
- **Advanced editors** (later milestones):
  - Paint tool for indoor/outdoor masks directly in Foundry
  - Gradient tools for complex effect masks
  - Layer-based effect composition
- All in-app edits saved to scene flags as procedural data
- Can export procedural data to image masks for optimization

## Milestones (Detailed)

### v0.1 "Renderer Bootstrap" ✅ (Current)
- [x] Capabilities detection (`core/capabilities.js`)
- [x] Renderer strategy (`core/renderer-strategy.js`)
- [x] Bootstrap orchestrator (`core/bootstrap.js`)
- [x] Error handling (`core/errors.js`)
- [x] Centralized logging (`core/log.js`)
- [x] Module state and types (`types.jsdoc`)
- [x] Clean entrypoint (`module.js`)
- [x] Minimal scene with orthographic camera

### v0.2 "Asset Pipeline & Scene Foundation"
- [ ] Settings system (`settings/scene-settings.js`)
  - Scene flag schema for Map Shine enablement
  - Three-tier settings structure (Map Maker / GM / Player)
  - Version migration utilities
  - "Revert to Original" functionality
- [ ] Asset loader module (`assets/loader.js`)
  - Suffix-based texture detection (JPG, PNG, WebP)
  - Async loading with progress tracking
  - Texture caching and format detection
  - Intelligent fallbacks for missing optional masks
- [ ] Scene composition module (`scene/composer.js`)
  - Create 2.5D scene from base texture
  - Orthographic camera controller (pan, zoom, lock to top-down)
  - Respect Foundry grid size and scene padding
- [ ] Canvas lifecycle (`foundry/canvas-replacement.js`)
  - Hook into Foundry canvas with native hooks (`canvasReady`, `canvasTearDown`)
  - Canvas creation and destruction
  - Resize handling
  - Scene switching (enabled vs disabled scenes)

### v0.3 "PBR Pipeline & UI Framework"
- [ ] Effect system foundation
  - `effects/EffectBase.js` — base class for all effects
  - `effects/EffectComposer.js` — dependency resolution and render orchestration
  - Effect registry and lifecycle
- [ ] **PBR Material System** (Priority #1)
  - `materials/PBRMaterial.js` — advanced physically-based rendering
  - Specular highlights with proper lighting model
  - Normal map support
  - Roughness map with intelligent fallback (derive from specular if missing)
  - Metallic workflow
- [ ] Lighting system (`lighting/LightManager.js`)
  - Replace Foundry's lighting with three.js lights
  - Directional, point, and ambient lights
  - Integration with PBR materials
- [ ] UI framework with **Tweakpane**
  - Effect browser component (collapsible tree)
  - Effect editor panel with Tweakpane parameter controls
  - Three-tier settings UI (Map Maker / GM / Player modes)
  - Contextual help/tooltip system
  - "Revert to Original" button for GMs
- [ ] Performance metrics overlay (FPS, draw calls, memory)

### v0.4 "In-App Effect Editing & Additional Materials"
- [ ] **In-app effect editing foundation**
  - Point placement tool for particle emitters
  - Area selection tool for discrete effects
  - Procedural effect data storage in scene flags
- [ ] Material effects:
  - Water (reflections, caustics, ripples)
  - Iridescence (oil-slick shimmer)
  - Heat distortion (refraction)
- [ ] Particle system foundation
  - GPU particle system (instanced rendering or compute shaders for WebGPU)
  - Particle emitter system with point placement
- [ ] First particle effects:
  - Fire & smoke (candles, torches)
  - Embers and sparks

### v0.5 "Weather, Environmental Systems & Fog of War"
- [ ] **Fog of War system**
  - Reimplement Foundry's Fog of War in three.js
  - Intelligent culling: don't render obscured areas
  - Performance optimization over Foundry's default
- [ ] Weather system
  - Wind simulation (gusts, direction changes)
  - Cloud shadow movement with dependency system
  - Precipitation control (rain, snow)
- [ ] Environmental effects:
  - Cloud shadows (demonstrates effect dependencies)
  - Canopy shadows
  - Day/night cycle (optional)
- [ ] Vegetation animation
  - Tree/bush sway with wind
  - Grass movement

### v0.6 "Post-Processing & Polish"
- [ ] Post-processing pipeline
  - Bloom, glow
  - Color grading (LUTs, selective color)
  - Depth of field
  - Grain, vignette
- [ ] Effect presets system
  - Save/load preset combinations
  - Ship with example presets
- [ ] Performance optimization pass
  - LOD for particles
  - Culling and batching
  - Adaptive quality based on FPS

### v0.7 "Foundry Token Integration & Advanced Editing"
- [ ] Token rendering in three.js
  - Billboard sprites for tokens
  - Z-order management
  - Selection and hover states
  - Accurate distance measurements (game system compatible)
- [ ] Token interaction
  - Drag-drop updates positions in real-time
  - Hook into Foundry token lifecycle
  - Token lighting integration
- [ ] **Advanced in-app editing**
  - Paint tool for indoor/outdoor masks
  - Gradient tools for complex effect masks
  - Layer-based effect composition
  - Export procedural data to image files

### v0.8 "Beta & Documentation"
- [ ] User documentation
  - Setup guide
  - Effect usage tutorials
  - Artist guide for creating effect masks
- [ ] Performance testing across GPU tiers
- [ ] Bug fixes and stability improvements
- [ ] Beta release for community testing

## Decisions Made ✅
- **Asset System**: Image-based PBR with suffix textures (NOT glTF)
  - Rationale: 2.5D doesn't need true 3D assets, simpler for creators, faster loading, full material control
  - Core techniques: Masked textures, procedural noise, parallax, custom shaders, GPU particles
- **MVP Effect**: PBR material pipeline with specular highlights (intelligent roughness fallback)
- **Performance**: Flexible targets, smooth experience sufficient for TTRPG use case
- **Asset Formats**: JPG, PNG, WebP supported
- **UI Library**: Tweakpane for parameter controls
- **Canvas Strategy**: Full replacement (not overlay) for lighting and fog of war control
- **Settings System**: Three-tier (Map Maker / GM / Player) with scene flag storage
- **In-App Editing**: Required feature, starting with point placement, advancing to paint tools

## Open Questions (for Product Direction)
- **Foundry Versions**: Support only v13+ or backport to v11/v12?
- **Licensing**: Confirm three.js MIT licensing is acceptable
- **UI Paradigm**: Docked panel vs floating window vs sidebar integration?
- **Preset Sharing**: Export/import effect presets as JSON?
- **Migration Strategy**: How far back should version migration support go?

## Next Steps (Immediate)
1. Test current specular effect implementation in Foundry VTT
2. Complete v0.2 milestone:
   - ✅ Scene settings system with three-tier structure
   - ✅ Asset loader with multi-format support and intelligent fallbacks
   - ✅ Canvas replacement hooks with Foundry native hooks
   - ✅ Specular effect with custom PBR shader
3. Document effect mask authoring workflow for artists
4. Create example map with PBR masks (_Specular, _Normal, _Roughness) for testing
5. Begin v0.3: Tweakpane UI integration for real-time parameter adjustment
