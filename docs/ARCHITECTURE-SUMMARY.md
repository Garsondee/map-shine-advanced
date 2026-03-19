# Map Shine Advanced — Architecture Summary

**Module**: `map-shine-advanced` v0.1.9.3  
**Foundry VTT Compatibility**: v13  
**Renderer**: Three.js r170 (PerspectiveCamera, FOV-based zoom)  
**Last Updated**: 2026-03-19

---

## 1. What Is Map Shine Advanced?

Map Shine Advanced is a Foundry VTT module that **completely replaces Foundry's PIXI-based canvas** with a custom Three.js 2.5D rendering engine. It renders battlemaps with cinematic PBR materials, GPU particle effects, dynamic weather, real-time lighting, fog of war, and a full post-processing stack — all driven by a **suffix-based texture system** that requires zero configuration from map creators beyond naming their image files.

The rendering system runs entirely in **Compositor V2** mode: a complete ground-up rewrite of the rendering pipeline built around the `FloorCompositor`, which supports multi-floor rendering (Levels module), per-floor GPU mask compositing via `GpuSceneMaskCompositor`, a dedicated `FloorRenderBus` scene for tile albedo rendering, and ~40 fully rebuilt V2 effect classes in `compositor-v2/effects/`.

### What Three.js Renders (Everything Visual)

- All tiles and base plane rendered via `FloorRenderBus` (straight-alpha textures, Z-ordered by floor)
- Grid overlay (square and hex, cached to texture)
- All tokens synced from Foundry (elevation-aware, assigned to Three.js floor layers)
- Walls, doors, drawings, notes, measurement templates, light icons
- Dynamic lighting with full indoor/outdoor occlusion (screen-space post-process, multiplicative)
- Fog of war (vision polygons + exploration texture)
- Weather particles (rain, snow, ash), fire, dust, flies, lightning, water splashes
- Animated vegetation (bushes, trees with wind)
- Water surfaces with reflections, caustics, flow, and foam
- Cloud shadows, building shadows, overhead shadows
- Post-processing (bloom, sky color, color correction, lens, film grain, sharpen, halftone, ASCII, dazzle, sepia, invert, vision modes, floor depth blur)
- Movement preview (path lines, ghost tokens, drag ghosts)
- Cinematic intro zoom on scene load

### What Foundry Provides (Data + UI Only)

- Authoritative game data (token positions, tile documents, wall segments, light sources)
- HTML UI overlay (sidebar, chat, character sheets, tool buttons)
- Game logic, hooks, and module API
- Camera state (PIXI stage pivot/zoom — Three.js follows it)
- PIXI world content composited into the Three.js frame via `PixiContentLayerBridge` (drawings, templates, notes, etc.)

### What's Hidden / Bridged

- Foundry's PIXI canvas world layers are rendered offscreen and composited into the Three.js frame via a texture bridge
- Foundry's PIXI UI (HUD, controls, sidebar) is overlaid on top of the final Three.js frame
- Token PIXI meshes remain interactive for Foundry's native hit detection

---

## 2. Project Structure

```
scripts/
├── module.js                    # Foundry hook entrypoint (init, ready)
├── types.jsdoc                  # Shared TypeScript-style type definitions
│
├── core/                        # Bootstrap, renderer, time, weather, profiling
│   ├── bootstrap.js             # Initialization orchestrator (GPU detect → renderer → scene)
│   ├── capabilities.js          # GPU tier detection (WebGL2/none)
│   ├── renderer-strategy.js     # Tiered renderer creation with fallback
│   ├── time.js                  # Centralized TimeManager (all effects MUST use this)
│   ├── render-loop.js           # RAF loop with adaptive idle throttling
│   ├── render-layers.js         # Canonical Three.js layer constants (floors 1-19, bloom 30, overlay 31)
│   ├── frame-coordinator.js     # PIXI↔Three.js frame synchronization
│   ├── frame-state.js           # Per-frame camera state snapshot
│   ├── WeatherController.js     # Global weather state machine (precip, wind, clouds, fog, wetness)
│   ├── DynamicExposureManager.js  # Token-based eye adaptation
│   ├── game-system.js           # Adapter-based game system compatibility (PF2e, D&D 5e, etc.)
│   ├── render-invalidation.js   # Dirty-flag caching for static scenes
│   ├── resource-registry.js     # Centralized GPU resource disposal
│   ├── load-session.js          # Scene load session tracking (staleness detection)
│   ├── loading-profiler.js      # Performance instrumentation
│   ├── profiler.js              # Runtime frame profiler
│   ├── scene-context.js         # Scene context helpers
│   ├── safe-call.js             # Safe async call wrapper with circuit-breaker integration
│   ├── circuit-breaker.js       # Circuit breaker for failing subsystems
│   ├── foundry-time-phases.js   # Time-of-day phase calculations (dawn, dusk, night, etc.)
│   ├── shader-validator.js      # GLSL compile-time validation
│   ├── log.js                   # Namespaced logger
│   ├── errors.js                # User-facing error notifications
│   └── levels-import/
│       ├── LevelsImportSnapshot.js  # Immutable frozen snapshot of Levels flag data per scene
│       └── LevelsSnapshotStore.js   # Per-scene cache with auto-invalidation hooks
│
├── assets/                      # Texture loading, policies, and VRAM tracking
│   ├── loader.js                # Suffix-based asset bundle loader with FilePicker probing
│   ├── texture-policies.js      # Standardized texture configs (ALBEDO, DATA_MASK, etc.)
│   └── TextureBudgetTracker.js  # VRAM budget tracking (80% ceiling, eviction, downscale fallback)
│
├── settings/
│   └── scene-settings.js        # Three-tier settings (Map Maker → GM → Player)
│
├── foundry/                     # Foundry VTT integration layer
│   ├── canvas-replacement.js    # THE MAIN ORCHESTRATOR — hooks, init, teardown, V2 wiring
│   ├── controls-integration.js  # PIXI overlay for Foundry tools (walls, lighting, floor-filtering)
│   ├── unified-camera.js        # Camera state helpers
│   ├── camera-follower.js       # PIXI→Three.js camera sync per-frame; emits level context changes
│   ├── camera-sync.js           # Legacy camera sync
│   ├── cinematic-camera-manager.js  # Cinematic camera animation sequences (pan, zoom)
│   ├── intro-zoom-effect.js     # Intro zoom-in animation on scene load
│   ├── input-router.js          # Routes pointer events between Three.js and PIXI
│   ├── pixi-input-bridge.js     # Pan/zoom on Three canvas applied to PIXI stage
│   ├── pixi-content-layer-bridge.js # Composites PIXI world + UI channels into Three.js frame
│   ├── layer-visibility-manager.js  # Hides/shows PIXI layers by mode
│   ├── mode-manager.js          # Rendering mode management (gameplay/edit/map-maker)
│   ├── drop-handler.js          # Drag-and-drop token/tile creation
│   ├── scene-controls.js        # Foundry scene control button definitions
│   ├── resize-handler.js        # Canvas resize handling
│   ├── selection-bridge.js      # PIXI↔Three.js selection sync
│   ├── effect-wiring.js         # V2 effect wiring + capability metadata exports
│   ├── manager-wiring.js        # Exposes all managers on window.MapShine
│   ├── elevation-context.js     # Elevation context helpers + tile elevation collision
│   ├── zone-manager.js          # Foundry region/zone integration
│   ├── levels-api-facade.js     # Levels module API compatibility (rescale, migrate, etc.)
│   ├── levels-compatibility.js  # Module conflict detection + warnings
│   ├── levels-create-defaults.js  # Wall/light default seeding per active floor
│   ├── levels-perspective-bridge.js # Bidirectional sync: MapShine level ↔ Levels module
│   ├── levels-scene-flags.js    # Levels scene flag reading utilities
│   ├── level-navigation-keybindings.js # Keyboard shortcuts for floor navigation
│   └── region-levels-compat.js  # Region↔Levels stair/elevator compatibility
│
├── compositor-v2/               # V2 rendering pipeline (the primary runtime)
│   ├── FloorCompositor.js       # V2 render orchestrator — owns FloorRenderBus, drives all passes
│   ├── FloorRenderBus.js        # Separate THREE.Scene with all tile meshes Z-ordered by floor
│   ├── FloorLayerManager.js     # Assigns tiles/tokens to Three.js layers (1-19) by floor index
│   └── effects/                 # All V2 effect implementations (~40 classes)
│       ├── SpecularEffectV2.js      # Per-tile additive specular overlays (_Specular mask)
│       ├── FluidEffectV2.js         # Animated fluid surface overlays (_Fluid mask)
│       ├── IridescenceEffectV2.js   # Holographic thin-film overlays (_Iridescence mask)
│       ├── PrismEffectV2.js         # Crystal/glass refraction overlays (_Prism mask)
│       ├── BushEffectV2.js          # Wind-animated bush sprites (_Bush mask)
│       ├── TreeEffectV2.js          # Wind-animated tree canopy sprites (_Tree mask)
│       ├── FireEffectV2.js          # Per-floor fire + embers + smoke particles (_Fire mask)
│       ├── fire-behaviors.js        # Quarks behavior classes for fire particles
│       ├── DustEffectV2.js          # Per-floor ambient dust particles (_Dust mask)
│       ├── WaterSplashesEffectV2.js # Per-floor foam plume + rain splash particles (_Water mask)
│       ├── water-splash-behaviors.js  # Quarks behaviors for water splash particles
│       ├── AshDisturbanceEffectV2.js  # Token-movement ash bursts (_Ash mask)
│       ├── WeatherParticlesV2.js    # Rain, snow, ash weather particles (shared BatchedRenderer)
│       ├── WindowLightEffectV2.js   # Window light pools in isolated scene (_Windows mask)
│       ├── LightingEffectV2.js      # Post-process: ambient + dynamic lights + cloud shadow + window light
│       ├── CloudEffectV2.js         # Cloud density, shadow RT (fed to Lighting), cloud-top RT
│       ├── WaterEffectV2.js         # Fullscreen water post-process (_Water mask, per-floor SDF)
│       ├── water-shader.js          # Water GLSL shader source (~900 lines)
│       ├── OverheadShadowsEffectV2.js # Overhead tile shadow projection (depth-pass gated)
│       ├── BuildingShadowsEffectV2.js # Raymarched building shadows (cached world-space RT)
│       ├── SkyColorEffectV2.js      # Time-of-day atmospheric color grading
│       ├── BloomEffectV2.js         # HDR bloom via UnrealBloomPass
│       ├── ColorCorrectionEffectV2.js # User-authored color grade
│       ├── FilterEffectV2.js        # Multiplicative overlay (ink wash, AO darkening)
│       ├── AtmosphericFogEffectV2.js  # Weather-driven distance fog (_Outdoors mask aware)
│       ├── FogOfWarEffectV2.js      # LOS vision polygons + exploration fog overlay
│       ├── DistortionManager.js     # Unified distortion pass (heat haze, water ripple, magic swirl)
│       ├── SharpenEffectV2.js       # Unsharp mask sharpening filter
│       ├── FloorDepthBlurEffect.js  # Kawase blur applied to below-active floors
│       ├── DotScreenEffectV2.js     # Dot-screen halftone filter
│       ├── HalftoneEffectV2.js      # CMYK halftone filter
│       ├── AsciiEffectV2.js         # ASCII art filter
│       ├── DazzleOverlayEffectV2.js # Bright-light exposure dazzle overlay
│       ├── VisionModeEffectV2.js    # Vision mode post-processing adjustments
│       ├── InvertEffectV2.js        # Color inversion filter
│       ├── SepiaEffectV2.js         # Sepia tone grading
│       ├── LensEffectV2.js          # Lens distortion, chromatic aberration, grime overlay
│       ├── lens-shader.js           # Lens GLSL shader source
│       ├── LightningEffectV2.js     # Map-point atmospheric lightning arc effect
│       ├── CandleFlamesEffectV2.js  # Map-point instanced candle flame billboards
│       ├── PlayerLightEffectV2.js   # Token-attached torch/flashlight (wall-collision aware)
│       ├── SmellyFliesEffect.js     # Map-point fly swarm particles
│       ├── MovementPreviewEffectV2.js # Path lines, ghost tokens, drag preview rendering
│       ├── SelectionBoxEffectV2.js  # Custom GPU drag-select rectangle (Blueprint/Neon/etc.)
│       └── specular-shader.js       # Specular GLSL shader source
│
├── scene/                       # Scene graph managers (Foundry data → Three.js objects)
│   ├── composer.js              # SceneComposer — scene setup, camera, base plane, mask discovery
│   ├── FloorStack.js            # Manages ordered floor bands from Levels; tracks active floor
│   ├── token-manager.js         # Tokens (hook-driven CRUD, animation, floor-layer assignment)
│   ├── tile-manager.js          # Tiles (ground/overhead/roof, per-tile effects, V2 bus sync)
│   ├── TileEffectBindingManager.js  # Binds V2 effects to specific tiles
│   ├── tile-motion-manager.js   # Moving/rotating tile animations with parent-child hierarchy
│   ├── token-movement-manager.js  # Full pathfinding, click-to-move, group movement, door awareness
│   ├── token-selection-controller.js  # Token selection state management
│   ├── wall-manager.js          # Wall segment visualization + floor-elevation filtering
│   ├── DoorMeshManager.js       # Animated door open/close graphics
│   ├── grid-renderer.js         # Grid overlay (square/hex, cached texture)
│   ├── interaction-manager.js   # All input handling (tokens, walls, lights, map points)
│   ├── light-interaction.js     # Light placement + live editing sub-handler
│   ├── map-point-interaction.js # Map point drawing + editing sub-handler
│   ├── selection-box-interaction.js # Drag-select box sub-handler
│   ├── level-interaction-service.js # Floor-aware create defaults + Levels interaction helpers
│   ├── mouse-state-manager.js   # Unified mouse/pointer state tracking
│   ├── control-gizmo-factory.js # Reusable control gizmo mesh creation
│   ├── depth-pass-manager.js    # Dedicated depth render pass (publishes depth texture to MaskManager)
│   ├── drawing-manager.js       # Freehand drawing visualization
│   ├── map-points-manager.js    # Map point groups (fire, candle, flies, lightning, ropes)
│   ├── multi-floor-graph.js     # Multi-floor navigation graph for pathfinding
│   ├── nav-mesh-builder.js      # Navigation mesh construction from wall geometry
│   ├── nav-mesh-pathfinder.js   # A* pathfinder on nav mesh with size/shape support
│   ├── physics-rope-manager.js  # Rope/chain physics simulation
│   ├── portal-detector.js       # Detects wall portals for multi-floor traversal
│   ├── surface-registry.js      # Tracks which surfaces exist (ground, overhead, roof)
│   └── LightMesh.js             # Light source mesh representation
│
├── effects/                     # Shared V1/V2 support layer
│   ├── EffectComposer.js        # Per-frame orchestrator; delegates to FloorCompositor in V2 mode
│   ├── WaterSurfaceModel.js     # SDF-based water surface simulation model (shared with V2)
│   ├── ThreeLightSource.js      # Per-light shader data packing
│   ├── ThreeDarknessSource.js   # Darkness source shader data packing
│   └── effect-capabilities-registry.js  # Registry for Graphics Settings capability metadata
│
├── masks/                       # Mask management and GPU compositing
│   ├── MaskManager.js           # Centralized mask registry (boost, blur, derive, per-floor lookup)
│   ├── GpuSceneMaskCompositor.js # GPU-based per-floor mask compositing (composeFloor, preloadAllFloors)
│   └── scene-mask-compositor.js # Scene mask compositing support (tile probe + union building)
│
├── particles/                   # Legacy particle support (V1; most particles now in compositor-v2)
│   ├── ParticleSystem.js        # Base particle system (three.quarks integration)
│   └── shaders/                 # Shared particle vertex/fragment shaders
│
├── vision/                      # Vision and fog subsystem
│   ├── VisionManager.js         # Vision polygon management (100ms throttle, object pooling)
│   ├── VisionPolygonComputer.js # Raycasting vision polygon with pooled allocations
│   ├── FogManager.js            # Fog state management
│   ├── FoundryFogBridge.js      # Bridge to Foundry's fog/exploration textures (zero-copy)
│   └── GeometryConverter.js     # PIXI polygon → Three.js shape conversion
│
├── ui/                          # User interface
│   ├── tweakpane-manager.js     # Main Tweakpane config UI (GM effect parameters, presets)
│   ├── control-panel-manager.js # Control Panel (time of day, weather, tile motion, presets)
│   ├── camera-panel-manager.js  # Camera controls panel
│   ├── graphics-settings-manager.js  # Player Graphics Settings (disable/reduce effects)
│   ├── graphics-settings-dialog.js   # Graphics Settings dialog
│   ├── effect-stack.js          # Effect parameter UI generation
│   ├── state-applier.js         # Centralized time/weather state application
│   ├── loading-overlay.js       # Cinematic loading screen with staged progress
│   ├── loading-screen/          # Loading screen preset system
│   ├── overlay-ui-manager.js    # World-anchored DOM overlays
│   ├── level-navigator-overlay.js  # Floor level navigation HUD overlay
│   ├── levels-authoring-dialog.js  # Levels setup authoring tools
│   ├── tile-motion-dialog.js    # Per-tile motion animation config dialog
│   ├── token-movement-dialog.js # Token movement style selection dialog
│   ├── gradient-editor.js       # Gradient color editor widget
│   ├── light-editor-tweakpane.js  # In-world light property editor
│   ├── enhanced-light-inspector.js  # Enhanced light inspector UI
│   ├── texture-manager.js       # Texture browser/manager UI
│   ├── parameter-validator.js   # Parameter range validation
│   └── diagnostic-center-dialog.js  # Debug diagnostic tools
│
├── utils/                       # Shared utilities
│   ├── coordinates.js           # Foundry↔Three.js coordinate conversion
│   ├── console-helpers.js       # Developer console helpers (MapShine.debug.*, EffectMaskRegistry)
│   └── scene-debug.js           # Scene state debugging tools
│
├── vendor/                      # Vendored dependencies (local, no CDN)
│   └── three/                   # Custom Three.js r170 build (tree-shaken)
│
└── libs/                        # Third-party libraries
    ├── quarks.core.module.js    # three.quarks particle engine (core)
    └── three.quarks.module.js   # three.quarks Three.js integration
```

---

## 3. Startup & Initialization Flow

The module boots through a precise sequence of Foundry hooks:

### Phase 1: `init` Hook (`module.js`)
1. Show black loading overlay immediately
2. Register Foundry settings (`scene-settings.js`)
3. Register UI settings (`tweakpane-manager.js`)
4. Register scene control buttons (Config, Control Panel, Graphics Settings, Player Lights)
5. Inject tile config UI (Roof toggle, Bypass Effects, Cloud toggles, Tile Motion)
6. Call `canvasReplacement.initialize()` — registers all Foundry hooks

### Phase 2: `ready` Hook (`module.js` → `bootstrap.js`)
1. Load Three.js from vendored build (`three.custom.js`)
2. Detect GPU capabilities (WebGL2/none)
3. Create `THREE.WebGLRenderer` with stencil+logarithmicDepthBuffer disabled
4. Initialize `GameSystemManager` (adapter-based PF2e, 5e, etc. compatibility)
5. Create placeholder scene + PerspectiveCamera
6. Install console helpers (`MapShine.debug.*`, `EffectMaskRegistry`)
7. Show success notification with GPU tier

### Phase 3: `canvasReady` Hook (`canvas-replacement.js`)
This is where the real work happens. If the scene has `map-shine-advanced.enabled = true`:

1. **Wait** for bootstrap completion and Foundry canvas readiness
2. **Create Three.js canvas** as a sibling to the PIXI `#board` element
3. **Configure PIXI** — replaced layers hidden, world rendered offscreen for texture bridge
4. **Initialize `PixiContentLayerBridge`** — captures PIXI world and UI channels as textures composited into the Three.js frame
5. **Capture Foundry state snapshot** for clean teardown later
6. **Initialize `LevelsSnapshotStore`** — caches Levels module floor data for the active scene
7. **Initialize `FloorStack`** — builds ordered floor bands from Levels snapshot (or single-floor fallback)
8. **Initialize `GpuSceneMaskCompositor`** — preloads per-floor mask composites for all levels
9. **Initialize `SceneComposer`** — loads scene background, sets up PerspectiveCamera, discovers and loads all suffix masks
10. **Initialize `MaskManager`** — registers discovered masks, defines derived masks (indoor, roofVisible, etc.)
11. **Wire `WeatherController`** — connects `_Outdoors` mask for indoor/outdoor awareness
12. **Initialize `FloorCompositor`** (V2) — creates `FloorRenderBus`, `FloorLayerManager`, all V2 effects; wires shared render targets
13. **Initialize `EffectComposer`** — creates `TimeManager`, registers `FloorCompositor` as the V2 delegate
14. **Initialize `DepthPassManager`** — sets up dedicated depth render pass, publishes to `MaskManager`
15. **Initialize Graphics Settings** — register V2 effect capabilities, wire effect instances
16. **Initialize scene managers** — `FloorStack` assignment, `TileManager`, `TokenManager`, `WallManager`, `DoorMeshManager`, `GridRenderer`, `DrawingManager`, `NoteManager`, `TemplateManager`, `LightIconManager`, `MapPointsManager`, `PhysicsRopeManager`, `TileMotionManager`, `TokenMovementManager` (parallelized where independent)
17. **Wire map points** to V2 particle effects (fire, candle, flies, lightning)
18. **Initialize `InteractionManager`** — selection, drag/drop, wall drawing, light placement, movement preview
19. **Initialize camera system** — `CameraFollower` (PIXI→Three.js each frame), `PixiInputBridge` (pan/zoom gestures)
20. **Initialize `ControlsIntegration`** — PIXI overlay for Foundry edit tools, floor-filtering for walls/lights
21. **Initialize `LevelsPerspectiveBridge`** — bidirectional floor sync with Levels module
22. **Initialize level navigation** — keybindings, `LevelNavigatorOverlay` HUD
23. **Start `RenderLoop`** — RAF with adaptive idle throttling
24. **Initialize `FrameCoordinator`** — PIXI ticker hook for vision/fog sync
25. **Initialize Tweakpane UI** — all V2 effect parameter panels
26. **Preload all floor masks** — `GpuSceneMaskCompositor.preloadAllFloors()`
27. **Wait for readiness** — effect promises, tile texture decoding, stable Three.js frames
28. **Apply time of day** from saved scene state
29. **Play intro zoom** — `IntroZoomEffect` cinematic camera animation
30. **Fade in** — cinematic 5-second overlay dissolve

### Teardown: `canvasTearDown` Hook
1. Pause `TimeManager`
2. Dispose `FrameCoordinator`
3. Dispose `MaskManager` and `GpuSceneMaskCompositor`
4. Dispose `FloorCompositor` (all V2 effects + `FloorRenderBus`)
5. Destroy Three.js canvas and all scene managers
6. Dispose `PixiContentLayerBridge`
7. Clear global references (preserves renderer/capabilities for reuse)

---

## 4. Coordinate System

Foundry and Three.js use different coordinate conventions:

| Property | Foundry (PIXI) | Three.js |
|---|---|---|
| Origin | Top-left | Bottom-left |
| Y axis | Down | Up |
| Position reference | Top-left corner of object | Center of object |
| Units | Pixels | Pixels (same scale) |

**Conversion** (via `utils/coordinates.js`):
```
Three.x = Foundry.x + width/2                                  (top-left → center)
Three.y = canvas.dimensions.height - (Foundry.y + height/2)    (Y flip + center)
```

**Camera**: PerspectiveCamera at fixed Z=2000 units (camera) with ground at Z=1000 (`GROUND_Z`). Zoom is achieved by adjusting FOV (`camera.fov = baseFov / zoomLevel`), not by moving the camera. This preserves 3D parallax for particles and avoids depth buffer precision issues.

**Camera Sync**: `CameraFollower` reads PIXI stage pivot and zoom each frame, converts to Three.js coordinates, and applies. `PixiInputBridge` handles pan/zoom gestures on the Three canvas and applies them to PIXI's stage, completing the loop. `sceneComposer.currentZoom` is the authoritative zoom value for all effects.

**Scene UV vs Screen UV**: Shaders must distinguish these carefully.
- **Scene UV** (`uSceneBounds`): world-space UV inside the actual map rect (excludes padding). Used for sampling world-space masks. V flip: `v = 1 - (y - sceneY) / sceneH`.
- **Screen UV** (`vUv` / `gl_FragCoord/uScreenSize`): normalized screen-space UV. Used for post-FX passes and roof alpha masks. Never mix these in the same shader.

---

## 5. Rendering Pipeline (V2 Compositor)

### Three.js Layer Assignments

```
Layer  0    Default (unused in V2 direct rendering)
Layer  1-19 Floor layers (floor 0 → layer 1, floor 1 → layer 2, etc.) — tiles + tokens
Layer 23    CLOUD_SHADOW_BLOCKER — overhead tiles that block cloud shadow
Layer 24    CLOUD_TOP_BLOCKER    — overhead tiles that block cloud tops
Layer 25    ROPE_MASK_LAYER      — rope meshes for rope mask sampling
Layer 29    GLOBAL_SCENE_LAYER   — floor-agnostic objects (rendered once per frame)
Layer 30    BLOOM_HOTSPOT_LAYER  — meshes that emit into the bloom threshold pass
Layer 31    OVERLAY_THREE_LAYER  — world-space overlay (rendered after post-FX)
```

### Z-Ordering in FloorRenderBus

```
z = 1000 + floorIndex   Ground tiles for floor N (floor 0 at z=1000, floor 1 at z=1001, …)
z = 1000.1              Grid overlay (cached texture, slightly above ground)
z = 1000 + elev/100     Token sprites (elevation mapped to sub-integer Z)
z = 1000 + floorIndex + 0.5  Overhead tiles for floor N
```

### Per-Frame Render Sequence (`FloorCompositor.render()`)

1. **Time Update** — `TimeManager.update()` produces `TimeInfo` (elapsed, delta, fps, paused, scale)
2. **Updatables** — All registered updatables receive `timeInfo`:
   - `CameraFollower` (PIXI → Three.js camera sync, emits floor context changes)
   - `WeatherController` (evolve weather state, Wanderer loop)
   - `DynamicExposureManager` (token-based eye adaptation)
   - `TileManager` (animated tiles, V2 bus sync)
   - `TileMotionManager` (moving/rotating tile animations)
   - `GridRenderer` (grid animation)
   - `DoorMeshManager` (door open/close animation)
   - `InteractionManager` (HUD positioning, movement preview, selection visuals)
   - `PhysicsRopeManager` (rope/chain simulation)
   - `TokenMovementManager` (pathfinding step advancement)
3. **PIXI Update** — Read PIXI world + UI channels via `PixiContentLayerBridge`
4. **Bus Scene Render** — `FloorRenderBus` renders all tile meshes + bus overlay effects to `sceneRT`:
   - Bus overlay effects (in the same scene, benefit from floor visibility): `SpecularEffectV2`, `FluidEffectV2`, `IridescenceEffectV2`, `PrismEffectV2`, `BushEffectV2`, `TreeEffectV2`, `FireEffectV2`, `DustEffectV2`, `WaterSplashesEffectV2`, `AshDisturbanceEffectV2`, `WeatherParticlesV2`
5. **Post-Processing Chain** — Sequential fullscreen passes reading from `sceneRT`:
   1. `OverheadShadowsEffectV2` — overhead tile shadow projection (depth-pass gated)
   2. `BuildingShadowsEffectV2` — raymarched building shadows (cached world-space RT)
   3. `CloudEffectV2` — generates shadow RT (fed into Lighting) + cloud-top RT
   4. `WindowLightEffectV2` — window light overlays fed into lighting accumulation RT
   5. `LightingEffectV2` — `Final = Albedo × Light` (ambient + dynamic + cloud shadow + window)
   6. Cloud tops blit
   7. `WaterEffectV2` — water tint/distortion/specular/foam driven by `_Water` masks
   8. `SkyColorEffectV2` — time-of-day atmospheric color grading
   9. `BloomEffectV2` — HDR bloom via `UnrealBloomPass`
   10. `ColorCorrectionEffectV2` — user color grade
   11. `FilterEffectV2` — multiplicative overlay (ink, AO)
   12. `AtmosphericFogEffectV2` — weather-driven distance fog
   13. `DistortionManager` — heat haze, water ripple, magic swirl
   14. `DotScreenEffectV2` / `HalftoneEffectV2` / `AsciiEffectV2` — stylistic filters
   15. `DazzleOverlayEffectV2` — bright-light dazzle
   16. `VisionModeEffectV2` — vision mode adjustments
   17. `InvertEffectV2` / `SepiaEffectV2` — color transforms
   18. `SharpenEffectV2` — unsharp mask
   19. `FloorDepthBlurEffect` — Kawase blur on below-active floors
   20. PIXI world channel composite (drawings, templates, notes, etc.)
   21. `FogOfWarEffectV2` — LOS + exploration fog overlay
   22. `LensEffectV2` — lens distortion, chromatic aberration, grime
6. **Late Overlays** — Rendered directly to screen in Three Layer 31:
   - `MovementPreviewEffectV2` path lines/ghost tokens
   - `SelectionBoxEffectV2` drag-select rectangle
   - `PlayerLightEffectV2` cone/flashlight overlay
   - Map-point particles (`CandleFlamesEffectV2`, `LightningEffectV2`, `SmellyFliesEffect`)
7. **PIXI UI Overlay** — Foundry's HTML/PIXI HUD composited on top
8. **Idle Throttling** — Static scenes render at 15fps; `requiresContinuousRender` bypasses throttle

### Render Targets

All post-processing buffers use `THREE.FloatType` (HDR throughout). The lighting shader includes dithering for smooth dark gradients. Key RTs:
- `sceneRT` — FloorRenderBus output (albedo + bus overlays)
- `cloudShadowRT` — Cloud shadow coverage (fed to LightingEffectV2)
- `cloudTopRT` — Cloud tops (blitted after lighting)
- `windowLightRT` — Window light accumulation (fed to LightingEffectV2)
- `depthRT` — Dedicated depth pass (device depth, DepthPassManager)
- Ping-pong pair `rtA`/`rtB` — Post-processing swap chain

---

## 6. Suffix-Based Asset System

Map creators provide effect masks by appending suffixes to their base map filename:

| Suffix | V2 Effect | Description |
|---|---|---|
| `_Specular` | `SpecularEffectV2` | Metallic/specular highlight mask |
| `_Roughness` | `SpecularEffectV2` | Surface roughness map |
| `_Normal` | `LightingEffectV2` | Normal map for lighting detail |
| `_Fire` | `FireEffectV2` | Fire placement mask (white = fire) |
| `_Ash` | `AshDisturbanceEffectV2` | Ash particle placement mask |
| `_Dust` | `DustEffectV2` | Dust mote placement mask |
| `_Outdoors` | Multiple | Indoor/outdoor area mask (white = outdoors) |
| `_Iridescence` | `IridescenceEffectV2` | Holographic/thin-film interference mask |
| `_Fluid` | `FluidEffectV2` | Animated fluid surface mask |
| `_Prism` | `PrismEffectV2` | Crystal/glass refraction mask |
| `_Windows` | `WindowLightEffectV2` | Window light pool mask |
| `_Bush` | `BushEffectV2` | Animated bush texture (RGBA) |
| `_Tree` | `TreeEffectV2` | Animated tree canopy texture (RGBA) |
| `_Water` | `WaterEffectV2` / `WaterSplashesEffectV2` | Water depth/area mask |

**Example**: For `TavernMap.webp`, placing `TavernMap_Specular.webp` alongside it automatically enables metallic reflections.

The `AssetLoader` (`assets/loader.js`) probes for all known suffixes via Foundry's `FilePicker` in `webp`, `png`, `jpg`, `jpeg` formats. Loading is concurrency-limited (4 parallel loads via `Semaphore`). `TextureBudgetTracker` monitors VRAM allocation and triggers eviction or resolution downscaling (0.5×) when usage exceeds 80% of budget. Masks that exist as `_X` suffixes on tile documents are also per-tile composited by `GpuSceneMaskCompositor`.

---

## 7. Effect System Architecture

### FloorCompositor (`compositor-v2/FloorCompositor.js`)

The V2 render orchestrator. It owns `FloorRenderBus`, `FloorLayerManager`, and all V2 effect instances:
- **Initialization** — Creates and initializes ~40 V2 effects with `concurrency=4` batch init
- **Per-frame render** — Drives the full post-processing chain described in §5
- **Floor change** — `onFloorChange(floorIndex)` propagates to all floor-aware effects; each effect independently swaps to its per-floor data
- **Effect enable/disable** — Graphics Settings toggle effects at capability-level; disabled effects skip initialization
- **Continuous render detection** — `requiresContinuousRender` on any effect forces full-rate RAF

### FloorRenderBus (`compositor-v2/FloorRenderBus.js`)

A standalone `THREE.Scene` that holds all tile meshes:
- **Texture loading**: Uses `THREE.TextureLoader` (HTML `<img>` element), which delivers **straight-alpha** data. This avoids the canvas-2D premultiplied-alpha corruption that plagued earlier approaches.
- **Z ordering**: Floor 0 tiles at Z=1000, floor 1 at Z=1001, etc. Standard depth sorting handles layering without any explicit render order tricks.
- **Bus overlay effects**: `SpecularEffectV2`, `FireEffectV2`, and other overlay effects add meshes to the same bus scene. They automatically benefit from the floor visibility system via the shared render loop.
- **Tile editing suppression**: Suppresses tile meshes that are being edited to prevent double-rendering

### V2 Effect Categories

**Bus Overlays** (meshes added to `FloorRenderBus` scene; rendered in step 4):
- `SpecularEffectV2` — Per-tile additive specular overlays driven by `_Specular` masks. Tile `flipY` is independent of compositor copy; texture is cloned with `flipY=true` for per-tile overlay pipeline.
- `FluidEffectV2` — Animated fluid surface driven by `_Fluid` masks
- `IridescenceEffectV2` — "Perturbed Spectral Phase" holographic thin-film (Screen UV + World noise + mask distort + time → spectral colors). Additive blending, separate mesh from base plane.
- `PrismEffectV2` — Crystal/glass refraction via `_Prism` mask
- `BushEffectV2` / `TreeEffectV2` — Wind-animated vegetation sprites (sin-wave + noise + `WeatherController` wind)
- `FireEffectV2` — Per-floor fire + embers + smoke particle systems. Uses **Lookup Map technique**: scan `_Fire` mask once → `DataTexture` of bright-pixel UVs → vertex shader samples position map (no per-frame rejection sampling).
- `DustEffectV2` — Per-floor ambient dust from `_Dust` mask
- `WaterSplashesEffectV2` — Per-floor foam plumes + rain splash impacts from `_Water` mask; own `BatchedRenderer`
- `AshDisturbanceEffectV2` — Token-movement-triggered ash bursts from `_Ash` mask
- `WeatherParticlesV2` — Rain/snow/ash with **drag-inertia physics** (rain: `pos = wind*(t - (1-exp(-3t))/3)`, snow: steeper curve), shared `BatchedRenderer`

**Post-Processing Effects** (fullscreen passes in step 5):
- `LightingEffectV2` — Ambient + Foundry token lights + darkness + cloud shadow + window light. Reconstructs world XY from screen UVs via `uViewBounds`. `Final = Albedo × Light`. Roof alpha pre-pass for indoor occlusion.
- `CloudEffectV2` — Procedural density field → shadow RT + cloud-top RT. Shadow RT fed to Lighting; cloud tops blitted after Lighting. Overhead-tile blocker pass for floor-aware shadow occlusion.
- `WaterEffectV2` — Complete water system: noise, rain ripples, storm distortion, waves, foam, sand, murk (advected dual-FBM with wind), specular (GGX), chromatic aberration. Per-floor SDF from `WaterSurfaceModel`. Murk grain uses animated multi-octave `valueNoise` with wind advection via `uWindOffsetUv`.
- `OverheadShadowsEffectV2` — Drop-shadow from overhead tiles. Depth-pass gated for tile projection shadows only; roof/indoor overhead contribution uses mask-derived depth (not `depthMod`).
- `BuildingShadowsEffectV2` — Raymarched building shadows, baked to 2048² world-space RT; re-renders only on time/param change
- `SkyColorEffectV2` — Time-of-day color tinting (dawn pink → dusk orange → night blue)
- `BloomEffectV2` — `UnrealBloomPass` with hotspot layer (Layer 30) for emissive meshes
- `ColorCorrectionEffectV2` — Brightness, contrast, saturation, hue grade
- `FilterEffectV2` — Multiplicative overlay (ink wash, AO darkening)
- `AtmosphericFogEffectV2` — Distance-based fog with `_Outdoors` mask awareness
- `DistortionManager` — Unified distortion accumulator: heat haze (fire), water ripple, magic swirl. `FireEffectV2` registers heat sources; distortion intensity is floor-isolated.
- `FogOfWarEffectV2` — LOS vision polygon rendering + exploration fog. Vision polygons from `VisionManager` (100ms throttle, object-pooled). Exploration texture shared zero-copy from Foundry PIXI via `FoundryFogBridge`.
- `LensEffectV2` — Lens distortion, chromatic aberration, barrel/pincushion, grime overlay
- `FloorDepthBlurEffect` — Kawase multi-pass blur applied to below-active floors to create depth-of-field separation
- `VisionModeEffectV2` / `InvertEffectV2` / `SepiaEffectV2` / `DotScreenEffectV2` / `HalftoneEffectV2` / `AsciiEffectV2` / `DazzleOverlayEffectV2` / `SharpenEffectV2` — Stylistic filters

**World-Space Overlays** (Layer 31, rendered after post-FX):
- `MovementPreviewEffectV2` — Path lines, ghost token positions, drag preview
- `SelectionBoxEffectV2` — GPU drag-select rectangle (Blueprint, Marching Ants, Neon presets)
- `PlayerLightEffectV2` — Token-attached torch/flashlight. Wall collision via Foundry `checkCollision` with prioritized types `['sight','light','move']`. Dynamic flashlight aims clamped to wall-blocked target.
- `CandleFlamesEffectV2` / `LightningEffectV2` / `SmellyFliesEffect` / `WindowLightEffectV2` — Map-point effects

### TimeManager (`core/time.js`)

**All effects MUST use the centralized TimeManager.** Never use `performance.now()` or `Date.now()` directly in effects.

- `timeInfo.elapsed` — Total scaled time (for sine waves, animation phases)
- `timeInfo.delta` — Frame delta in seconds (for physics, frame-rate independence)
- `timeInfo.paused` / `timeInfo.scale` — Supports Foundry pause integration and slow-motion
- Smooth pause transitions (ramps time scale to 0 over configurable duration)

---

## 8. Multi-Floor Architecture (Levels Integration)

### Overview

Map Shine Advanced supports multi-floor scenes via full integration with the Levels module. When a scene uses Levels, the module builds an ordered `FloorStack` from Levels floor-band data and renders each floor in isolation.

### FloorStack (`scene/FloorStack.js`)

Manages the ordered set of elevation floors:
- **Floor bands**: Each floor has `{ index, elevationMin, elevationMax, key, compositorKey, isActive }`
- **Derived from**: `LevelsImportSnapshot` (frozen Levels flag data) or single-floor fallback for non-Levels scenes
- **Active floor**: Tracks the player's current viewpoint floor; `setActiveFloor(index)` triggers `FloorCompositor.onFloorChange()`
- **Visibility toggling**: Per-floor render loop temporarily overrides `.visible` on tile/token sprites to show only objects in floor N, then restores via `restoreVisibility()`

### GpuSceneMaskCompositor (`masks/GpuSceneMaskCompositor.js`)

Replaces the old `SceneComposer`-based mask pipeline with a GPU-accelerated per-floor system:
- **`composeFloor(levelContext, scene, options)`** — Full pipeline: tile loading → GPU composition → bundle fallback → background basePath fallback → per-floor metadata cache
- **`preloadAllFloors(scene, options)`** — Preloads GPU-composited masks for every floor at scene load time
- **Per-floor cache**: `_floorMeta` Map tracks `basePath`, last mask state for change detection
- **Tile elevation filtering**: `_isTileInLevelBand()` determines which tiles belong to a given floor's elevation range
- **Output**: Per-floor `{ masks, masksChanged, levelElevation, basePath }` fed to effects via `FloorCompositor.onFloorChange()`

### Levels Integration Points

- **`LevelsImportSnapshot`** — Immutable snapshot of Levels module scene flags; cached by `LevelsSnapshotStore`
- **`LevelsPerspectiveBridge`** — Bidirectional sync between MapShine's active floor and Levels module's perspective; listens to `mapShineLevelContextChanged` and Levels' own perspective hooks
- **`LevelsApiFacade`** — Provides compatibility API surface for Levels module methods (rescale, migrate)
- **`LevelsCompatibility`** — Detects conflicting modules (Better Roofs, etc.) and warns
- **`LevelsCreateDefaults`** — Seeds wall heights and light elevations for newly created objects on the active floor
- **`LevelNavigatorOverlay`** — HUD overlay showing current floor, allows clicking to switch floors
- **`level-navigation-keybindings`** — Keyboard shortcuts (PgUp/PgDn) for floor navigation
- **Wall manager floor filtering** — `WallManager` filters visible wall segments by floor elevation range
- **`PortalDetector`** — Detects wall portals (stairs, elevators) for multi-floor traversal in pathfinding

---

## 9. Mask & Weather Systems

### MaskManager (`masks/MaskManager.js`)

Centralized registry for all texture masks:
- **Stores** raw masks from asset bundles with metadata (UV space, color space, lifecycle)
- **Per-floor policies**: Effects register interest in per-floor mask variants; `MaskManager` routes floor-specific masks on level changes
- **Derives** computed masks: `indoor.scene` (inverted outdoors), `roofVisible.screen`, `precipVisibility.screen`
- **GPU operations**: Boost (threshold + multiply), Blur (separable Gaussian), Composite (max, invert)
- **Depth texture**: `DepthPassManager` publishes the device depth texture to `MaskManager` for per-effect consumption (specular occlusion, fog depth fade, contact shadows)
- Effects request masks by ID; `MaskManager` handles all preprocessing

### WeatherController (`core/WeatherController.js`)

Global weather state machine driving all environmental effects:

- **State**: precipitation (0-1), precipType (rain/snow/hail/ash), cloudCover, windSpeed, windDirection, windOffsetUv (scene-UV wind vector), fogDensity, wetness, freezeLevel
- **Transitions**: Smooth interpolation between weather presets with configurable duration
- **Dynamic Weather**: Autonomous evolution system with Perlin noise-driven variability
- **Wanderer Loop**: Natural-feeling weather variation without repetition
- **GM Authority**: Weather state persisted to scene flags, replicated to all clients via `updateScene` hook
- **`_Outdoors` mask integration**: CPU pixel extraction for O(1) indoor/outdoor lookups; drives particle spawn-time tagging

### Indoor/Outdoor Awareness

The `_Outdoors` mask (white = outdoors, black = indoors) drives:
- **Weather particles**: Dual-mask visibility (world-space `_Outdoors` + screen-space roof alpha). Particles spawn-tagged at birth; `SmartWindBehavior` uses tag to scale wind force.
- **Fire guttering**: Outdoor fires reduced by precipitation; indoor fires immune
- **Lighting occlusion**: Indoor lights blocked by opaque roofs (roof alpha pre-pass in `LightingEffectV2`)
- **Cloud shadows**: `AtmosphericFogEffectV2` and `CloudEffectV2` sample `_Outdoors` to restrict shadow/fog to outdoor areas
- **Murk water**: `WaterEffectV2` advects murk using `uWindOffsetUv` from `WeatherController`

---

## 10. Scene Managers

### SceneComposer (`scene/composer.js`)

Sets up the Three.js scene from Foundry scene data:
- Creates `PerspectiveCamera` at Z=2000, ground plane at Z=1000 (`GROUND_Z`), `near=1`, `far=5000`
- Loads base map texture via `THREE.TextureLoader`, creates ground plane mesh
- Discovers and loads all suffix-based masks via `AssetLoader`
- Defines `groundZ`, `worldTopZ`, `weatherEmitterZ` for consistent layering
- Handles scene background color for padded regions outside `sceneRect`
- Tracks owned GPU resources for leak-free scene transitions

### TokenManager (`scene/token-manager.js`)

- Creates `THREE.Sprite` for each Foundry token, synced via hooks (`createToken`, `updateToken`, `deleteToken`)
- **Server-authoritative**: No optimistic updates. `updateSpriteTransform` merges `changes` into a `targetDoc` to avoid stale-position lag from hook timing.
- **Floor-layer assignment**: Tokens assigned to `FloorLayerManager` layers for floor-isolated rendering
- **`TokenMovementManager` integration**: Calls `captureBaseTransform` on tile updates; tracks current animation target
- Selection visuals (ring, tint); token movement callback for `AshDisturbanceEffectV2`

### TileManager (`scene/tile-manager.js`)

- Syncs all Foundry tiles to `THREE.Sprite` objects **and** `FloorRenderBus` bus meshes
- **Role classification**: Ground (`elevation < foregroundElevation`), Overhead, Roof (`overhead + overheadIsRoof`)
- **V2 bus sync**: Tiles loaded via `THREE.TextureLoader` (straight-alpha) into `FloorRenderBus`; Z set by floor index. `TileMotionManager.captureBaseTransform()` called on each tile update.
- **Per-tile flags**: `bypassEffects`, `cloudShadowsEnabled`, `cloudTopsEnabled`
- **`TileEffectBindingManager`**: Binds per-tile V2 effects (specular, water, etc.) to individual tile IDs
- **Specular texture isolation**: `loadTileSpecularMaskTexture` clones the shared compositor texture with `flipY=true` into `_tileSpecularMaskCache` to avoid shared-texture flip conflicts

### TokenMovementManager (`scene/token-movement-manager.js`)

Full pathfinding and click-to-move system:
- **Navigation mesh**: `NavMeshBuilder` constructs nav meshes from Foundry wall geometry; `NavMeshPathfinder` runs A* per token size/shape
- **Multi-floor graph**: `MultiFloorGraph` handles cross-floor traversal via `PortalDetector`
- **Group movement**: `executeDoorAwareGroupMove` preserves formation offsets from leader to all selected tokens; parallel move with per-token fallback
- **Door awareness**: Checks door state along path; opens closed doors if permitted
- **Move-lock safety**: Owner-aware lock entries prevent stale `finally` blocks from clearing newer locks
- **Cancellation**: Group timeline cancellation propagated into each step's `_groupCancelToken`; short interruptible loops replace single-shot sleeps
- **Movement preview**: Wired to `MovementPreviewEffectV2` for real-time path visualization

### TileMotionManager (`scene/tile-motion-manager.js`)

Moving/rotating tile animations:
- **Scene-flag state**: `flags.map-shine-advanced.tileMotion` (global: `playing`, `startEpochMs`, `speedPercent`; per-tile: `enabled`, `mode`, `parentId`, `pivot`, `motion`)
- **Parent hierarchy**: Ordered topological sort with cycle detection; parent inheritance = position + rotation only (no scale)
- **Pivot rotation**: Rotates tile mesh around custom pivot point each frame
- **Control Panel integration**: Start/Stop/Speed controls in `ControlPanelManager`'s `🧭 Tile Motion` section

### InteractionManager (`scene/interaction-manager.js`)

Handles all Three.js canvas input:
- **Token interaction**: Select, multi-select (drag box via `SelectionBoxInteraction`), drag-move with grid snapping, wall collision fallback
- **Group-aware right-click move**: `_executeTokenGroupMoveToTopLeft` preserves formation; confirm-click requires matching tile + selection set (`selectionKey`)
- **Wall drawing**: Click-to-place with half-grid snapping; floor-creates via `LevelInteractionService`
- **Light placement**: Drag-to-create with preview ring; `LightInteraction` sub-handler; elevation defaults from active floor
- **Map-point drawing**: `MapPointInteraction` sub-handler for polygon/circle map point groups
- **Movement preview**: Wired to `TokenMovementManager` and `MovementPreviewEffectV2`
- **In-progress polygon visibility**: `previewGroup` re-attached to `FloorRenderBus` scene each frame via `_ensureInteractionOverlaysInActiveScene`

### Other Scene Managers

- **`WallManager`** — Wall visualization + floor-elevation filtering (shows only walls within current floor's elevation band)
- **`DoorMeshManager`** — Animated door open/close graphics
- **`GridRenderer`** — Square and hex grid, cached to texture, per-frame updatable
- **`DepthPassManager`** — Renders dedicated depth pass each frame; publishes depth texture to `MaskManager`; debug visualizer with linear/device/layer display modes
- **`DrawingManager`** — Freehand drawing visualization
- **`MapPointsManager`** — Map point groups (fire, candle, flies, lightning, ropes)
- **`PhysicsRopeManager`** — Rope/chain physics simulation
- **`VisionManager`** — Vision polygon management (100ms throttle, object-pooled `VisionPolygonComputer`)

---

## 11. Foundry Integration Layer

### Hybrid Rendering Modes

The module operates in multiple modes, controlled by `mode-manager.js` and `canvas-replacement.js`:

**Gameplay Mode (Default)**:
- Three.js canvas visible, handles pointer events
- PIXI world layers rendered offscreen; composited into Three.js frame via `PixiContentLayerBridge`
- PIXI UI (HUD, sidebar) overlaid on top of the Three.js frame
- `InputRouter` dynamically enables PIXI input only when Foundry edit tools are active

**Map Maker / Edit Mode**:
- Three.js canvas hidden (`opacity: 0`, `pointer-events: none`)
- PIXI canvas fully visible and interactive
- All PIXI layers restored to visible
- Full access to Foundry's native editing tools

### PixiContentLayerBridge (`foundry/pixi-content-layer-bridge.js`)

Solves the PIXI/Three.js integration problem:
- Renders the PIXI world (drawings, templates, notes, tokens) to an offscreen canvas each frame
- Reads the result as a `THREE.Texture` and composites it at a specific step in the post-processing chain
- Renders PIXI UI separately (HUD, controls) as an HTML layer overlaid on the Three.js canvas
- Zero-copy path where possible; frame-synchronized with `FrameCoordinator`

### Camera System

- **PIXI as authority**: `CameraFollower` reads PIXI `stage.pivot` + zoom each frame → converts to Three.js world coordinates → applies to `PerspectiveCamera`
- **`PixiInputBridge`**: Pan/zoom gestures on the Three canvas forwarded to PIXI stage to maintain PIXI authority
- **FOV-based zoom**: `camera.fov = baseFov / zoomLevel`, camera stays at fixed Z=2000
- **`sceneComposer.currentZoom`**: Authoritative zoom value for all shaders (not `camera.zoom` — perspective FOV)
- **Floor changes**: `CameraFollower` emits `mapShineLevelContextChanged` hook when PIXI perspective changes floor

### FrameCoordinator (`core/frame-coordinator.js`)

Solves the dual-renderer synchronization problem:
- Hooks into Foundry's PIXI ticker at low priority (runs AFTER Foundry updates)
- Ensures vision masks, fog textures, and PIXI world content are fresh before Three.js renders
- `onPostPixi(callback)` for effects that need post-PIXI texture reads
- Forces PIXI render flush before `PixiContentLayerBridge` captures the world channel

### ControlsIntegration (`foundry/controls-integration.js`)

Orchestrates Foundry's native tool support:
- `LayerVisibilityManager` — Controls which PIXI layers are visible per mode
- `InputRouter` — Switches pointer events between Three.js and PIXI canvases; normalizes tool name to lowercase for comparison
- Wall visibility floor-filtering — `_isWallOnCurrentFloor(wall)` + `_updateWallsVisualState()` hide walls outside the active floor's elevation band during gameplay
- Door control transparency — `_makeWallTransparent()` hides door controls for walls on other floors
- Hooks `renderSceneControls` for tool-change detection; `mapShineLevelContextChanged` re-applies wall filter on floor change

### CinematicCameraManager (`foundry/cinematic-camera-manager.js`)

Drives programmatic camera animations:
- Pan + zoom sequences with easing curves
- `IntroZoomEffect` uses this for the per-scene intro zoom-in animation

---

## 12. Settings System

### Three-Tier Hierarchy

1. **Map Maker** — Baseline settings saved to scene flags (distributed with the map)
2. **GM** — Can tweak any setting; overrides saved to scene flags (can revert to Map Maker defaults)
3. **Player** — Final say; overrides saved client-local (not distributed); can only reduce intensity, never increase above Map Maker baseline

### Scene Opt-In

Map Shine is enabled per-scene via `scene.flags['map-shine-advanced'].enabled = true`. Scenes without this flag use Foundry's native PIXI rendering unchanged.

### Graphics Settings

Per-client settings allowing players/GMs to:
- **Disable** any effect entirely (toggle)
- **Reduce** intensity (0-1 multiplier)
- **Lazy initialization**: Disabled effects skip shader compilation during loading, initialized on demand if re-enabled
- Persisted to `localStorage` keyed by scene + user ID
- Accessible via dedicated Foundry toolbar button or the `graphicsSettingsDialog`

---

## 13. UI System

### TweakpaneManager (`ui/tweakpane-manager.js`)

The main GM configuration interface:
- All V2 effect parameter panels with live preview
- Presets, import/export, reset to defaults
- Effect folders with enable/status indicators
- UI scale control with debounced update to prevent feedback loops
- Settings persisted to scene flags via `SceneSettings`

### ControlPanelManager (`ui/control-panel-manager.js`)

Quick-access controls for live game sessions:
- Time of day slider with transition support
- Weather preset selector with smooth transitions
- Dynamic weather toggle with evolution speed
- Wind direction/speed controls
- **`🧭 Tile Motion`** section: Start/Stop/Speed controls for `TileMotionManager`
- State saved to scene flags and replicated to all clients via `updateScene` hook

### LevelNavigatorOverlay (`ui/level-navigator-overlay.js`)

HUD overlay for floor navigation:
- Shows current floor index and name
- Click buttons (or PgUp/PgDn) to switch floors
- Fades in/out based on cursor proximity
- Only visible for scenes with multi-floor Levels setup

### Loading Overlay (`ui/loading-overlay.js`)

Cinematic loading experience:
- Black overlay shown immediately on module init
- Staged progress bar (asset discovery → texture loading → effects → floor masks → scene sync → finalize)
- Loading screen preset system (`loading-screen/`) with configurable visuals
- 5-second fade-in reveal when scene is fully rendered
- Scene transition: fade-to-black before teardown, loading screen during rebuild

### Other UI Components

- **`StateApplier`** — Centralized time/weather state application; ensures consistency between Tweakpane and Control Panel
- **`CameraPanelManager`** — Camera controls (zoom, pan, cinematic sequences)
- **`LevelsAuthoringDialog`** — Guided setup for Levels module floor configuration
- **`TileMotionDialog`** — Per-tile motion animation config (mode, pivot, parent)
- **`TokenMovementDialog`** — Token movement style selection (pathfinding, speed, style)
- **`GradientEditor`** — Reusable gradient color editor widget
- **`DiagnosticCenterDialog`** — Debug diagnostics, mask viewers, `EffectMaskRegistry` state, performance stats

---

## 14. Performance Architecture

### Render Loop Optimization
- **Idle throttling**: Static scenes render at 15fps; `requiresContinuousRender` on any effect forces full-rate RAF
- **Camera motion detection**: `CameraFollower` sets a motion flag for 1 extra frame after any pan/zoom
- **Continuous render flag**: Effects with animated content set `requiresContinuousRender = true` on the `FloorCompositor`

### GPU Optimization
- **FloatType buffers**: HDR throughout the post-processing chain (prevents 8-bit quantization banding)
- **Half-resolution shadows**: `OverheadShadowsEffectV2` at 50% resolution (75% fill rate savings)
- **World-space baking**: `BuildingShadowsEffectV2` bakes raymarching to 2048² RT; re-renders only on time/param change
- **Lazy effect initialization**: Disabled effects skip shader compilation; initialized on first enable
- **Parallel effect init**: Concurrency=4 balances GPU driver contention vs speed
- **VRAM budget**: `TextureBudgetTracker` enforces 80% ceiling; triggers `evictStaleFloorCaches()` and `getDownscaleFactor() = 0.5` when exceeded
- **Floor mask preloading**: `GpuSceneMaskCompositor.preloadAllFloors()` precomputes GPU composites at load time (not on-demand during level changes)

### CPU Optimization
- **Object pooling**: `VisionPolygonComputer` reuses `_endpointMap`, `_seenAnglesSet`, `_endpointsPool`, `_intersectionsPool`, `_tempClosest` on every call
- **Throttled vision updates**: 100ms throttle (10 updates/sec max); wall changes and token create/delete bypass throttle
- **No per-frame allocations**: Cached `Vector3`/`Vector2`/`Matrix4` in all hot update loops
- **Spawn-time tagging**: Particles tagged at birth with outdoor factor from `_Outdoors` mask; no per-frame mask lookup
- **Aggregated fire emitters**: `FireEffectV2` + `WeatherParticlesV2` aggregate all points into 1-2 systems via `MultiPointEmitterShape`; emission rate scales by point count
- **Move-lock owner tagging**: `TokenMovementManager` uses owner-aware lock entries to prevent stale `finally` blocks from clearing newer locks

### Asset Optimization
- **Texture policies**: Standardized `ALBEDO`, `DATA_MASK`, `LOOKUP_MAP`, `NORMAL_MAP`, `RENDER_TARGET` configs prevent misconfiguration
- **Semaphore-limited loading**: Max 4 concurrent texture loads
- **Asset caching**: Loaded bundles cached by path; critical masks validated on cache hit
- **Fog texture sharing**: Exploration texture shared zero-copy from Foundry PIXI via `FoundryFogBridge`
- **Specular texture cloning**: `_tileSpecularMaskCache` clones compositor texture with independent `flipY=true` per-tile to prevent shared-object corruption on level changes

---

## 15. Key Architectural Decisions

| Decision | Rationale |
|---|---|
| **Compositor V2 as sole runtime** | FloorRenderBus straight-alpha textures + floor layer isolation solved premult corruption and per-floor rendering in one design. V1 pipeline removed. |
| **Full canvas replacement + PIXI bridge** | Complete rendering control. PIXI world composited via texture bridge so Foundry's native layers (drawings, templates) still work. |
| **PerspectiveCamera with FOV zoom** | Fixed Z prevents depth buffer precision issues. FOV zoom preserves 3D parallax for particles. Use `sceneComposer.currentZoom` not `camera.zoom`. |
| **FloorRenderBus with THREE.TextureLoader** | `<img>` element delivers straight-alpha data; avoids canvas-2D premultiplied-alpha corruption that plagued all earlier tile-loading approaches. |
| **PIXI as camera authority** | One source of truth. `CameraFollower` follows PIXI each frame. Eliminates bidirectional sync races. |
| **GpuSceneMaskCompositor for floor masks** | GPU-based tile compositing is fast enough to preload all floors at scene load. `composeFloor()` API makes floor mask management self-contained. |
| **Server-authoritative token movement** | No optimistic updates. `changes` merged into `targetDoc` prevents stale-position lag. Move-lock owner entries prevent stale finalize unlocks. |
| **Lookup Map for fire/dust particles** | Scan mask once → `DataTexture` → vertex shader samples position. O(1) per particle, no per-frame rejection sampling, deterministic placement. |
| **DistortionManager centralized pass** | All screen-space distortions (heat, water, magic) combine in one pass; effects register sources via API instead of each owning a distortion pass. |
| **Suffix-based assets** (not glTF) | Zero-config for map creators. 2.5D doesn't need 3D meshes. Full shader control over each mask type. |
| **Centralized TimeManager** | Synchronized animations, global pause, time scaling, testability. Never use `performance.now()` in effects. |
| **Three-tier settings** | Map creators set baselines, GMs tweak for their game, players control their own performance. |
| **Scene UV vs Screen UV discipline** | World-space masks use `uSceneBounds` + Y-flip; screen-space post-FX use `vUv`. Mixing them is the #1 shader bug source. |

---

## 16. Global State (`window.MapShine`)

All major systems are exposed on `window.MapShine` for debugging and inter-module communication:

```javascript
window.MapShine = {
  // Core
  renderer,            // THREE.WebGLRenderer
  sceneComposer,       // SceneComposer (scene, camera, base plane)
  effectComposer,      // EffectComposer (delegates to FloorCompositor in V2)
  floorCompositor,     // FloorCompositor (V2 orchestrator)
  floorRenderBus,      // FloorRenderBus (tile scene)
  floorStack,          // FloorStack (multi-floor state)
  renderLoop,          // RenderLoop (RAF control)
  timeManager,         // TimeManager (elapsed, delta, pause, scale)
  weatherController,   // WeatherController (precipitation, wind, clouds, etc.)
  maskManager,         // MaskManager (mask registry)
  gpuSceneMaskCompositor, // GpuSceneMaskCompositor (per-floor GPU compositing)
  depthPassManager,    // DepthPassManager (depth texture)

  // Scene Managers
  tokenManager, tileManager, wallManager, doorMeshManager,
  gridRenderer, interactionManager, mapPointsManager,
  physicsRopeManager, surfaceRegistry,
  tileMotionManager, tokenMovementManager, tileEffectBindingManager,

  // Foundry Integration
  cameraFollower, pixiInputBridge, pixiContentLayerBridge,
  controlsIntegration, frameCoordinator,
  levelsPerspectiveBridge, levelsSnapshotStore,

  // V2 Effects (all individually accessible via effect-wiring.js exports)
  lightingEffect, fogEffect, specularEffect, bloomEffect,
  cloudEffect, waterEffect, distortionManager, /* ...all ~40 V2 effects */

  // UI
  uiManager,           // TweakpaneManager
  controlPanel,        // ControlPanelManager
  graphicsSettings,    // GraphicsSettingsManager
  levelNavigator,      // LevelNavigatorOverlay
  stateApplier,        // StateApplier

  // Utilities
  sceneDebug, enhancedLights,
  setMapMakerMode, resetScene, isMapMakerMode,

  // Debug
  debug: { /* MapShine.debug.* console helpers, EffectMaskRegistry */ }
};
```

---

## 17. Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| Three.js | r170 | 3D rendering engine (vendored, custom tree-shaken build) |
| three.quarks | bundled | GPU particle system engine (`BatchedRenderer`, behaviors) |
| Tweakpane | loaded at runtime | Configuration UI panels |
| Playwright | dev only | Performance benchmarking and integration tests |
| esbuild | dev only | Build tooling (`scripts/build/build.js`) |

**No CDN dependencies.** All runtime libraries are vendored locally for offline/air-gapped use.

---

## 18. Compatibility Notes

- **Foundry v13** only (API contract verified against v13 source)
- **Levels module**: Full integration. Scenes without Levels use single-floor fallback. `LevelsCompatibility` warns on detected conflicts.
- **Game system agnostic**: `GameSystemManager` adapter pattern handles PF2e vision type differences, D&D 5e defaults, etc.
- **Module conflicts**: Modules that directly manipulate PIXI world layers may conflict in Gameplay mode (they work in Map Maker mode). `LevelsCompatibility` handles Better Roofs and similar.
- **Performance floor**: Requires WebGL2. No WebGPU requirement (but future path is open).
- **Scene opt-in**: Only affects scenes with `flags['map-shine-advanced'].enabled = true` — all other scenes use Foundry's native PIXI rendering unchanged.

---

## 19. Architectural Review — Findings & Considerations

_Added 2026-03-19. This section records the results of a codebase-backed investigation into
externally proposed architectural concerns and alternatives. Each point is evaluated against
the actual implementation, not just the documented intent._

### 19.1. Confirmed Strengths

These architectural choices were verified as correct and well-implemented:

**A. PIXI as Camera & UI Authority**
Confirmed in `camera-sync.js:159-167` and `composer.js:1012-1091`. `CameraFollower` reads
PIXI `stage.pivot` + zoom each frame and applies to the `PerspectiveCamera` via `fov = 2 *
atan(baseFovTanHalf / zoom)`. The one-directional flow (PIXI → Three.js) eliminates
bidirectional sync races. `PixiInputBridge` forwards Three.js canvas gestures back to PIXI
to maintain this authority. This is the correct design for Foundry module compatibility.

**B. Suffix-Based Asset System**
`EFFECT_MASKS` in `assets/loader.js` defines suffixes (`_Specular`, `_Water`, `_Fire`, etc.)
with `required: false`. The `AssetLoader` probes via `FilePicker` in `webp/png/jpg/jpeg`
formats with `Semaphore(4)` concurrency limiting. Map creators only need to name files
correctly — zero JSON configuration required. This is a genuine UX advantage.

**C. Idle Throttling**
`requiresContinuousRender` on `FloorCompositor` controls RAF rate. Static scenes fall to
~15fps. Any effect with animation sets the flag to force full-rate rendering. This is
critical for VTT sessions left open for hours.

**D. Straight-Alpha Texture Loading**
`FloorRenderBus` uses `THREE.TextureLoader` (HTML `<img>` element) to bypass the canvas-2D
premultiplied-alpha corruption. The file header documents the painful history of Attempts
1-4 that used `TileManager` sprites (canvas-2D `drawImage()` premultiplies internally).
The straight-alpha path with `NormalBlending` is correct and proven.

**E. FloorRenderBus / FloorCompositor Separation**
`FloorRenderBus` owns the spatial tile scene (Z-ordered meshes, straight-alpha textures,
visibility toggling). `FloorCompositor` owns the render pipeline (effect lifecycle, post-
processing chain, floor-change propagation). This separation allows bus overlay effects
(Specular, Fire, etc.) to live in the bus scene while post-processing effects remain
independent fullscreen passes.

---

### 19.2. Major Architectural Considerations

#### A. Post-Processing Ping-Pong Pipeline (Fill-Rate Concern)

**Claim**: ~20 sequential fullscreen passes will bottleneck GPU memory bandwidth at 4K.

**Codebase finding**: The chain in `FloorCompositor.render()` (lines 1942-2178) has these
post-processing passes: Lighting → SkyColor → ColorCorrection → Filter → Water →
Distortion → AtmosphericFog → Bloom → Sharpen → DotScreen → Halftone → ASCII →
DazzleOverlay → VisionMode → Invert → Sepia → PIXI composite → Fog overlay → Lens.
That is **up to 18 post passes** through ping-pong RTs (`_postA` / `_postB`).

**However**: Every single pass is gated by `params.enabled` or `.enabled`. In a typical
session, only **4-6 passes** actually execute (Lighting, SkyColor, Water, Bloom,
Fog overlay, Lens). The stylistic filters (DotScreen, Halftone, ASCII, Dazzle, Sepia,
Invert, VisionMode) are disabled by default and are novelty/debug tools. Sharpen is
disabled by default. Filter and AtmosphericFog are situational.

**Verdict on "Uber Shader" proposal**: Consolidating Color Correction + Sky Color + Sepia +
Invert into a single pass via `#define` macros is a **valid optimization** but the
expected gain is modest (~2-3 fewer RT swaps, saving ~2-4ms at 4K). The real bandwidth
cost comes from Lighting (3 sub-passes: lightRT, darknessRT, compose), Water (SDF +
noise + specular), and Bloom (threshold + mip blur chain). These cannot be consolidated
because they have fundamentally different input/output requirements.

**Recommendation**: Worth doing as a polish pass. Combine the "cheap" color-grade passes
(SkyColor + ColorCorrection + Filter + Sepia + Invert) into a single "FinalGrade" uber
shader with `#define` toggles. This saves 3-4 RT swaps in the worst case and is low-risk.
The Bloom and Water passes cannot be simplified this way. The current gating-by-enabled
already prevents the worst case from occurring in practice.

#### B. PIXI ↔ Three.js Texture Bridge

**Claim**: PIXI and Three.js run in separate WebGL contexts; texture transfer requires a
CPU round-trip (readPixels or Canvas2D intermediary).

**Codebase finding**: `PixiContentLayerBridge` (2910 lines) does **not** share a WebGL
context between PIXI and Three.js. The transfer mechanism is:

1. **Replay path** (default, most common): `_renderFoundryShapeReplay()` uses PIXI's
   `renderer.extract.canvas(shape, frame)` to extract each drawing shape to a CPU
   `HTMLCanvasElement`. These are composited via `ctx.drawImage()` onto `_worldCanvas`.
   The result is published as `THREE.CanvasTexture` with `needsUpdate = true`, which
   triggers a `texImage2D` GPU upload on the next Three.js render.

2. **Stage isolation path** (fallback for complex layers): Temporarily hides all non-UI
   stage children, renders the isolated stage to a `PIXI.RenderTexture`, extracts to
   canvas via `extract.canvas(tempRT, frame)`, then uploads as `CanvasTexture`.

3. **Throttling**: Capture is throttled at 66ms (replay) / 120ms (live preview) between
   frames. Idle scenes skip capture entirely (`skip:idle`). Post-dirty followup captures
   are limited to 200ms intervals. This makes the CPU cost negligible in practice.

**Verdict on "Shared ImageBitmap / OffscreenCanvas" proposal**: The current approach
already uses `HTMLCanvasElement` as the intermediary, which is the most browser-compatible
path. `createImageBitmap` would save one copy in theory, but the real bottleneck is the
PIXI `extract.canvas()` call itself, which performs the `readPixels` internally regardless
of the downstream consumer. Switching to `OffscreenCanvas` would not eliminate the
fundamental PIXI→CPU→Three.js hop.

**True optimization path**: The only way to eliminate the CPU round-trip entirely would be
to run PIXI and Three.js on the **same** WebGL2 context (sharing framebuffers directly).
This is architecturally infeasible with Foundry's PIXI initialization owning its own
context. The current throttled-capture approach is the pragmatic correct choice.

**Note**: The bridge is heavily optimized for the common case (drawings-only replay). It
caches settled sounds layers, uses content signatures to skip GPU uploads when unchanged
(`_lastReplayDocsSig`), and caps UI RT dimensions to 1024px. The actual per-frame cost is
near-zero when no drawings/templates/notes are being actively edited.

#### C. FOV-Based Camera Zoom vs. Z-Translation

**Claim**: High zoom-in creates near-orthographic projection (no depth); high zoom-out
creates fish-eye distortion.

**Codebase finding**: `composer.js:1012-1091` sets up the camera at Z=2000 with ground at
Z=1000 (`GROUND_Z`). The base FOV is calculated as `2 * atan(viewportHeight / (2 * 1000))`
scaled by `PERSPECTIVE_STRENGTH`. For a 1080p viewport, this gives a base FOV of ~29°.

Zoom is applied via `fov = 2 * atan(baseFovTanHalf / zoom)` with clamping to `[1°, 170°]`
(`camera-sync.js:164`). Zoom limits are derived from Foundry's own `Canvas.getDimensions`
formula (`composer.js:1173-1200`), which means the FOV range in practice is bounded by
Foundry's own min/max zoom (typically ~0.1x to ~6x).

At typical Foundry zoom ranges:
- **Zoom 6x** (max zoom-in): FOV ≈ 5°. Yes, nearly orthographic. But this is intentional
  — at max zoom, the player is looking at a small area and parallax would be disorienting.
- **Zoom 0.1x** (max zoom-out): FOV ≈ 170° (clamped). This would cause extreme distortion,
  but Foundry's own zoom limits prevent this from ever being reached in practice.
- **Zoom 1x** (default): FOV ≈ 29°. Mild perspective, pleasant parallax for particles.

**Verdict on Z-Translation alternative**: Z-translation would give consistent parallax but
introduces two serious problems that the current implementation explicitly avoids:
1. **Depth buffer precision**: Moving the camera from Z=1100 to Z=5000 while keeping
   `near=1` causes severe Z-fighting. Dynamically adjusting near/far adds complexity and
   can clip content unexpectedly.
2. **Ground plane stability**: The file header in `composer.js:994-1006` documents that
   ground-plane disappearing was the original motivating bug for FOV zoom. Camera Z
   movement changed the ground's depth buffer position, causing it to flicker.

The `PERSPECTIVE_STRENGTH` multiplier already exists as a tuning knob if the perspective
needs to be flattened further. The current approach is the correct trade-off for a 2.5D
top-down VTT.

**Particle parallax concern**: Particles at different Z heights (weather at Z=5300, ground
effects at Z=1000) do exhibit zoom-dependent parallax behavior. At high zoom-in (narrow
FOV), particles appear to move with the ground. At normal zoom, they exhibit subtle
depth separation. This is actually the desired behavior for a tabletop map — players
should not experience jarring 3D parallax when zoomed into their token's immediate area.

#### D. VRAM Preloading vs. JIT Generation

**Claim**: Preloading all floors via `preloadAllFloors()` could trigger aggressive
downscaling on large 10-floor dungeons.

**Codebase finding**: `GpuSceneMaskCompositor.preloadAllFloors()` (line 836) iterates all
Levels floor bands and calls `composeFloor()` with `cacheOnly: true` for each. The output
is cached in `_floorMeta` (metadata) and `_floorCache` (GPU RTs per mask type).

**Key mitigation already implemented**: The compositor does NOT preload the full-resolution
albedo textures for all floors. It only preloads the **composited mask textures** (Specular,
Water, Fire, Outdoors, etc.) per floor. These are typically much smaller than albedo (mask
textures are grayscale, often 1024² or 2048² vs 4096² albedo maps). The actual tile albedo
textures are loaded by `FloorRenderBus` on demand and remain in the `THREE.TextureLoader`
cache.

Additionally, the preload includes **stale-cache detection** (lines 917-947): if a tile's
`_tileEffectMasks` entry is empty (loaded before suffix files were ready), the cache is
evicted and recomposed. There's also a water-mask patching step that cross-references upper
floor geometry to suppress water under overhead tiles.

**Budget pressure**: `TextureBudgetTracker` enforces 80% VRAM ceiling, but this applies to
ALL textures (albedo + masks + RTs + depth textures). The mask preload contributes a
relatively small fraction. A 10-floor dungeon with 6 mask types × 2048² × RGBA8 per floor
≈ 10 × 6 × 16MB = ~960MB of mask RTs. This IS significant on integrated GPUs (4GB shared).

**Verdict**: The JIT/LRU alternative (only composite N-1, N, N+1) is a **valid
optimization for extreme cases** (8+ floors, integrated GPU). However, the current
preload approach has a critical advantage: the water-mask patching step
(`_patchWaterMasksForUpperFloors`) requires ALL floors to be composed before it can
suppress water under upper-floor geometry. A JIT approach would need to run this patch
lazily, which adds complexity and potential visual pops when switching floors.

**Recommendation**: Consider a hybrid approach: preload all mask metadata and water patches
at load time, but defer the actual GPU RT allocation for distant floors (|floorIndex -
activeFloor| > 2). Evict distant floor RTs when budget pressure exceeds a per-scene
threshold. This preserves the water-patch correctness while reducing peak VRAM.

---

### 19.3. Maintainability & DX Considerations

#### A. Global `window.MapShine` State

**Claim**: Global monolith makes unit testing impossible and creates hidden dependencies.

**Codebase finding**: `window.MapShine` is populated incrementally in `canvas-replacement.js`
after each manager/effect is constructed. Effects DO directly access `window.MapShine.*`
for cross-system references (e.g., `window.MapShine?.floorStack?.getActiveFloor()` in
`FloorCompositor.render()`, `window.MapShine?.weatherController` in particle effects).

**Nuance**: In the Foundry VTT module context, a DI container faces a unique challenge:
Foundry's hook-driven lifecycle means managers are constructed at different times during
`canvasReady`, and many need to reference each other bidirectionally. A service locator
pattern (`MapShineContext.get(TimeManager)`) would improve testability but wouldn't
eliminate the circular reference problem — it would just move it from global lookup to
container lookup.

**Verdict**: The suggestion is architecturally sound but the practical benefit is limited
in a Foundry module context. Unit testing individual effects is already difficult because
they depend on Foundry's `canvas`, `game`, `Hooks`, and `CONFIG` globals. A DI container
would help if the project ever moves to a standalone renderer, but for a Foundry module,
the global object pattern is pragmatic. The more impactful improvement would be **explicit
dependency declarations in effect constructors** (pass `timeManager`, `weatherController`,
`maskManager` as constructor args instead of reading from `window.MapShine`).

#### B. Event-Driven Architecture (Pub/Sub EventBus)

**Claim**: Direct calls (e.g., `TokenMovementManager` → `TileMotionManager.captureBaseTransform()`)
create tight coupling.

**Codebase finding**: The module already uses Foundry's `Hooks` system as a pub/sub
mechanism in several places: `mapShineLevelContextChanged`, `mapShineCameraSync`,
`renderSceneControls`, and the standard Foundry hooks (`createToken`, `updateToken`,
`deleteToken`, `updateWall`, etc.). Some effect-to-effect communication does go through
direct method calls (e.g., `FloorCompositor._syncFireHeatDistortionSource()` directly
calls `_distortionEffect.updateSourceParams()`).

**Verdict**: A custom `EventBus` would add indirection without clear benefit, since
Foundry's `Hooks` already serves as a pub/sub system. The direct calls are used in
**hot paths** (per-frame render loop) where event dispatch overhead is undesirable. For
cold paths (floor change, effect enable/disable), Foundry Hooks are already used. The
suggestion to decouple `AshDisturbanceEffectV2` from `TokenMovementManager` via events
is valid — but in practice, the effect is null-checked before invocation, so a disabled
effect already causes no errors.

#### C. Custom Effect Registration API

**Claim**: ~40 hardcoded effects in `FloorCompositor.js` prevent third-party extensibility.

**Codebase finding**: Effects are constructed explicitly in `FloorCompositor._initializeEffects()`
and wired into the render chain via named fields (`this._lightingEffect`,
`this._waterEffect`, etc.). The render order is hardcoded in `render()` as a sequential
chain of if-blocks. There is no dynamic registration mechanism.

**Verdict**: An `EffectRegistrationAPI` (`MapShine.registerPostEffect(pass, { order })`)
is a **genuinely good idea for future extensibility**. However, the current architecture
has a practical advantage: the render chain has complex inter-effect dependencies (Cloud
shadow RT → Lighting, Window light scene → Lighting, Sky color → Water sun direction,
Water → Distortion heat source). A dynamic registry would need a dependency graph resolver
to maintain correct ordering, which is significantly more complex than the current explicit
chain. This is a "Phase 2" improvement that should be designed carefully, not retrofitted.

#### D. Shader Code Management (Chunking)

**Claim**: Shared math (fog, depth, noise) should be extracted into reusable GLSL chunks.

**Codebase finding**: The module **already does this** in two forms:
1. **`DepthShaderChunks`** (`effects/DepthShaderChunks.js`): Exports `uniforms`,
   `linearize`, and `bindDepthPass()` as template-literal GLSL snippets that effects
   splice into their shader source via `${DepthShaderChunks.linearize}`.
2. **`DistortionNoise`** (`compositor-v2/effects/DistortionManager.js`): Exports
   `simplex2D`, `simplex4D`, `fbm`, `heatHaze`, `waterRipple` as GLSL string snippets
   spliced via `${DistortionNoise.simplex2D}`.

**Gap**: Fog math, coordinate conversion (`screenUvToFoundry`, `foundryToSceneUv`), and
basic noise (`valueNoise`, `hash`) are duplicated across several effect shaders rather
than centralized. The water shader (`water-shader.js`, ~900 lines of GLSL) has its own
noise implementations that overlap with `DistortionNoise`.

**Verdict**: Partially addressed. The existing chunking pattern is correct. Extending it
to cover coordinate conversion, fog math, and base noise would reduce divergent bugs (the
reviewer's concern about fog behaving differently in water vs. lighting is valid).

---

### 19.4. Minor Edge Cases

#### A. Token Elevation vs. Multi-Floor Z-Ordering

**Claim**: A token on Floor 1 that flies 40ft up might clip through Floor 2 tiles.

**Codebase finding**: `TokenManager._resolveTokenFloorIndex()` (line 688) iterates
`FloorStack` bands and assigns the token to the floor whose `[elevationMin, elevationMax)`
range contains the token's elevation. If a token's elevation exceeds all bands, it falls
back to floor 0.

**The concern is partially valid**: If Floor 1 covers elevation [0, 20) and Floor 2 covers
[20, 40), a token at elevation 15 that "flies" to elevation 25 WILL be reassigned to Floor
2 by `_resolveTokenFloorIndex()`. Its `renderOrder` updates accordingly via
`_applyV2TokenRenderOrder()`. So the token **does** dynamically change floors based on
elevation — the clip-through concern is already handled.

**Remaining gap**: The token's Three.js sprite Z position is set based on floor index, not
raw elevation. A "flying" token at elevation 35 on Floor 2 renders at the same Z as a
walking token at elevation 20 on Floor 2. True 3D flight visualization would require
Z-offset proportional to elevation within the band. This is a cosmetic limitation, not a
rendering bug.

#### B. InputRouter Third-Party Tool Handling

**Claim**: Modules like Monk's Active Tile Triggers add custom tools; the router needs a
generic fallback.

**Codebase finding**: `InputRouter` (615 lines) has:
- `pixiInteractiveLayers: Set<string>` — hardcoded set of known PIXI layers
- `pixiInteractiveTools: Set<string>` — hardcoded set of known PIXI tools
- `addPixiLayer(layerName)` — public method to register custom layers
- `addPixiTool(toolName)` — public method to register custom tools
- `determineMode()` — checks known layers first, then falls through to tool sets, then
  defaults to `InputMode.THREE`

**Verdict**: The public `addPixiLayer()` and `addPixiTool()` methods already provide the
extensibility hook that third-party modules need. If Monk's Active Tile Triggers adds a
custom tool called `'trigger'`, it can call `MapShine.inputRouter.addPixiTool('trigger')`
and the router will correctly switch to PIXI mode. The **default fallback to THREE** is
correct — unknown tools should not block Three.js interaction.

**Gap**: There is no documentation or API surface advertising `addPixiLayer`/`addPixiTool`
to other module developers. This should be documented in the module's public API or README.

#### C. Token Movement Latency (No Ghost Preview)

**Claim**: Server-authoritative movement with no optimistic updates causes perceived lag
on high-latency connections.

**Codebase finding**: `TokenMovementManager` has no "ghost preview" or optimistic position
update. The `MovementPreviewEffectV2` renders path lines and ghost positions during the
**planning phase** (before the move is committed), but once the player clicks to confirm,
the token waits for the Foundry server round-trip before animating.

**Nuance**: In Foundry VTT's architecture, token updates go through `TokenDocument.update()`
→ server → `updateToken` hook → all clients. On a local (self-hosted) game, latency is
<5ms and imperceptible. On a hosted server (Forge, Molten, etc.), typical latency is
30-80ms — still fast enough that most players won't notice. The 150ms scenario the reviewer
describes would require a geographically distant server.

**Verdict**: A client-side ghost preview is a **nice-to-have** but adds complexity: the
ghost must be reconciled with the authoritative position when the hook fires (what if the
server rejects the move due to a wall collision detected server-side?). The current
`MovementPreviewEffectV2` path-line preview provides visual feedback during planning, which
covers the most common "feeling sluggish" scenario (the player sees where they're going
before committing). True optimistic movement is a future enhancement that should be
carefully designed to handle rejection cases.

---

### 19.5. Summary Verdict on Proposed Changes

| Proposal | Priority | Verdict |
|---|---|---|
| Uber Shader (combine cheap color passes) | Medium | Valid. Saves 3-4 RT swaps. Low risk. |
| Shared ImageBitmap for PIXI bridge | Low | Marginal gain. Real bottleneck is `extract.canvas()`. |
| Z-Translation zoom | Reject | FOV zoom solved the ground-disappearing bug. Z-translation reintroduces it. |
| JIT floor mask generation | Medium | Valid for 8+ floor scenes on integrated GPUs. Hybrid approach recommended. |
| DI Container | Low | Architecturally sound but low practical value in Foundry module context. |
| EventBus | Low | Foundry Hooks already serve this role. Direct calls OK in hot paths. |
| Effect Registration API | High (future) | Genuine extensibility gain. Requires dependency graph design. |
| Shader chunk expansion | Medium | Partially done (`DepthShaderChunks`, `DistortionNoise`). Extend to coords/fog/noise. |
| Token floor reassignment | Already done | `_resolveTokenFloorIndex()` handles this. |
| InputRouter third-party API | Already done | `addPixiLayer()` / `addPixiTool()` exist. Needs documentation. |
| Token ghost preview | Low | Nice UX polish. Requires server-rejection reconciliation design. |
