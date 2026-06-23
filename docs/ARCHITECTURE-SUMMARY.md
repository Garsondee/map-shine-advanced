# Map Shine Advanced — Architecture Summary

**Module**: `map-shine-advanced` v0.5.4.19  
**Foundry VTT Compatibility**: v14  
**Renderer**: Three.js r170 (PerspectiveCamera, FOV-based zoom)  
**Last Updated**: 2026-06-22

---

## 1. What Is Map Shine Advanced?

Map Shine Advanced is a Foundry VTT module that **completely replaces Foundry's PIXI-based canvas** with a custom Three.js 2.5D rendering engine. It renders battlemaps with cinematic PBR materials, GPU particle effects, dynamic weather, real-time lighting, fog of war, and a full post-processing stack — all driven by a **suffix-based texture system** that requires zero configuration from map creators beyond naming their image files.

The rendering system runs entirely in **Compositor V2** mode: a complete ground-up rewrite of the rendering pipeline built around the `FloorCompositor`, which supports multi-floor rendering (Levels module), per-floor GPU mask compositing via `GpuSceneMaskCompositor`, a dedicated `FloorRenderBus` scene for tile albedo rendering, **per-level RT pooling** (`LevelRenderTargetPool` + `LevelCompositePass`), unified shadow composition via `ShadowManagerV2`, and ~45 V2 effect classes in `compositor-v2/effects/`. Large maps can stream tile pyramids through `TileStreamingManager` instead of loading full-resolution backgrounds at once.

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
- Post-processing (per-level lighting, post-merge fog/bloom/camera grade, lens, film grain, sharpen, halftone, ASCII, dazzle, sepia, invert, vision modes, floor depth blur)
- Contextual per-client scene grading (token proximity, cover, outdoor bias)
- Third-party effect integration (Dice So Nice canvas composite, Sequencer/JB2A sprite mirrors)
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
│   ├── LoadCoordinator.js       # V14-aligned scene load state machine (idle → running/degraded)
│   ├── LightingDirector.js      # Single CPU authority for darkness, sun angles, calendar blend
│   ├── SceneWindField.js          # Spatial gust-field on top of WeatherController (vegetation/cloud/water)
│   ├── capabilities.js          # GPU tier detection (WebGL2/none)
│   ├── renderer-strategy.js     # Tiered renderer creation with fallback
│   ├── webgl-crash-recovery.js  # WebGL context loss detection + automatic scene rebuild
│   ├── time.js                  # Centralized TimeManager (all effects MUST use this)
│   ├── tod-timeline.js          # Time-of-day timeline helpers for camera grade
│   ├── render-loop.js           # RAF loop with adaptive idle throttling
│   ├── render-layers.js         # Canonical Three.js layer constants (floors 1-19, bloom 30, overlay 31-33)
│   ├── frame-coordinator.js     # PIXI↔Three.js frame synchronization
│   ├── frame-state.js           # Per-frame camera state snapshot
│   ├── WeatherController.js     # Global weather state machine (precip, wind, clouds, fog, wetness)
│   ├── wind-profile.js          # Wind speed/direction profile derivation
│   ├── DynamicExposureManager.js  # Token-based eye adaptation
│   ├── game-system.js           # Adapter-based game system compatibility (PF2e, D&D 5e, etc.)
│   ├── gm-parity.js             # GM/player capability parity helpers
│   ├── render-invalidation.js   # Dirty-flag caching for static scenes
│   ├── resource-registry.js     # Centralized GPU resource disposal
│   ├── load-session.js          # Scene load session tracking (staleness detection)
│   ├── loading-profiler.js      # Performance instrumentation
│   ├── profiler.js              # Runtime frame profiler
│   ├── scene-context.js         # Scene context helpers
│   ├── safe-call.js             # Safe async call wrapper with severity/fallback handling
│   ├── foundry-time-phases.js   # Time-of-day phase calculations (dawn, dusk, night, etc.)
│   ├── shader-validator.js      # GLSL compile-time validation
│   ├── texture-leak-probe.js    # Renderer texture sampling diagnostics
│   ├── yield-to-main.js         # Cooperative main-thread yielding during heavy loads
│   ├── log.js                   # Namespaced logger
│   ├── errors.js                # User-facing error notifications
│   ├── context-grade/           # Per-client contextual scene grade engine
│   │   ├── ContextualSceneGradeManager.js  # Runtime manager (token/cover/outdoor probes)
│   │   ├── context-grade-engine.js
│   │   ├── context-pack-resolver.js
│   │   └── …                    # coherence, dimensions, env/state evaluators
│   ├── diagnostics/             # Breaker Box, performance recorder, health graph
│   │   ├── RenderStackSnapshotService.js
│   │   ├── RenderStackRules.js
│   │   ├── HealthEvaluatorService.js
│   │   ├── PerformanceRecorder.js
│   │   └── …
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
├── streaming/                   # Frustum-driven tile pyramid streaming (large maps)
│   ├── tile-streaming-manager.js    # Orchestrator: LOD selection, pan mode, floor-transition pause
│   ├── streamed-background-grid.js  # Background/foreground streaming grids (`__bg_image__*`)
│   ├── texture-pyramid-builder.js   # Multi-LOD pyramid build + IndexedDB cache
│   ├── tile-decode-pool.js          # Worker-backed image decode pool
│   ├── gpu-work-scheduler.js        # Defers GPU uploads under budget pressure
│   ├── adaptive-budget-controller.js
│   ├── vegetation-streaming-bridge.js  # Cell-gated vegetation mask loading
│   ├── fire-streaming-bridge.js
│   └── view-projection-service.js
│
├── integrations/                # Third-party module bridges
│   └── external-effects/        # Dice So Nice + Sequencer/JB2A (see §20)
│
├── compositor-v2/               # V2 rendering pipeline (the primary runtime)
│   ├── FloorCompositor.js       # V2 render orchestrator — owns FloorRenderBus, drives all passes
│   ├── FloorRenderBus.js        # Separate THREE.Scene with all tile meshes Z-ordered by floor
│   ├── LevelRenderTargetPool.js # Per-level sceneRT/postA/postB allocation pool
│   ├── LevelCompositePass.js    # Bottom→top alpha blend of per-level final RTs
│   ├── LayerOrderPolicy.js      # Centralized render-order role bands (albedo/effects/overhead/overhead-fx)
│   ├── FloorLayerManager.js     # Assigns tiles/tokens to Three.js layers (1-19) by floor index
│   ├── LightingPerspectiveContext.js  # Shared lighting perspective uniforms
│   ├── msa-post-stylize-input.glsl.js  # Shared HDR shoulder compress for post-CC stylize passes
│   ├── shadow-system/           # Directional shadow projection, vegetation billboard shadows, sun direction
│   └── effects/                 # All V2 effect implementations (~45 classes + shared vegetation/shader modules)
│       ├── SpecularEffectV2.js      # Per-tile additive specular overlays (_Specular mask)
│       ├── FluidEffectV2.js         # Animated fluid surface overlays (_Fluid mask)
│       ├── IridescenceEffectV2.js   # Holographic thin-film overlays (_Iridescence mask)
│       ├── PrismEffectV2.js         # Crystal/glass refraction overlays (_Prism mask)
│       ├── BushEffectV2.js          # Wind-animated bush sprites (_Bush mask); layer 32 post-bloom
│       ├── TreeEffectV2.js          # Wind-animated tree canopy sprites (_Tree mask); layer 32 post-bloom
│       ├── vegetation-*.js          # Shared GLSL/uniforms: bulk wind, ambient light, painted shadow, camera grade
│       ├── FireEffectV2.js          # Per-floor fire + embers + smoke particles (_Fire mask)
│       ├── AshCloudEffectV2.js      # Ambient ash cloud particles (weather-driven)
│       ├── fire-behaviors.js        # Quarks behavior classes for fire particles
│       ├── DustEffectV2.js          # Per-floor ambient dust particles (_Dust mask)
│       ├── WaterSplashesEffectV2.js # Per-floor foam plume + rain splash particles (_Water mask); layer 33
│       ├── water-splash-behaviors.js  # Quarks behaviors for water splash particles
│       ├── AshDisturbanceEffectV2.js  # Token-movement ash bursts (_Ash mask)
│       ├── WeatherParticlesV2.js    # Rain, snow, ash weather particles (shared BatchedRenderer)
│       ├── WeatherLightningEffectV2.js  # Map-wide atmospheric lightning (weather-driven)
│       ├── WindowLightEffectV2.js   # Window light pools in isolated scene (_Windows mask)
│       ├── LightingEffectV2.js      # CPU ambient compose + dynamic lights; multiplies albedo × light
│       ├── ambient-compose-cpu.js   # CPU twilight/outdoor ambient illumination math
│       ├── CloudEffectV2.js         # Cloud density, shadow RT (fed to ShadowManager), cloud-top RT
│       ├── ShadowManagerV2.js       # Combines cloud + overhead + building + painted + sky-reach + vegetation shadows
│       ├── OverheadStampEffectV2.js # Directional overhead-tile stamp shadows + roof alpha for lighting
│       ├── BuildingShadowsEffectV2.js # Raymarched building shadows (cached world-space RT)
│       ├── PaintedShadowEffectV2.js # Hand-painted outdoor shadows (_Shadow mask)
│       ├── SkyReachShadowsEffectV2.js # Sky-reach shadow factor from stacked outdoors masks
│       ├── WaterEffectV2.js         # Fullscreen water post-process (_Water mask, per-floor SDF)
│       ├── water-shader.js          # Water GLSL shader source
│       ├── SkyColorEffectV2.js      # CPU-only sky environment exports (sun angles, tint) for consumers
│       ├── ContextualSceneGradeEffectV2.js  # Tweakpane params for per-client contextual grade overlays
│       ├── BloomEffectV2.js         # HDR bloom via UnrealBloomPass (post-merge)
│       ├── ColorCorrectionEffectV2.js # Sole HDR→LDR camera grade owner (post-merge)
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
│   ├── level-transition-curtain.js  # Fade curtain on floor/level switches
│   ├── scene-transition-curtain.js  # Fade curtain on scene transitions
│   └── LightMesh.js             # Light source mesh representation
│
├── effects/                     # Shared V1/V2 support layer
│   ├── EffectComposer.js        # Per-frame orchestrator; delegates to FloorCompositor in V2 mode
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
│   ├── register-ui-settings.js  # Foundry client settings registration (incl. LightingDirector)
│   ├── streaming-minimap.js     # Debug minimap for tile streaming cells
│   ├── tile-streaming-report.js # Streaming diagnostics report UI
│   ├── parameter-validator.js   # Parameter range validation
│   └── diagnostic-center-dialog.js  # Debug diagnostic tools (Breaker Box, mask viewers)
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
2. Register Foundry settings (`scene-settings.js` — includes `LightingDirector.registerSettings()`)
3. Register UI settings (`register-ui-settings.js`, `tweakpane-manager.js`)
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

1. **LoadCoordinator** begins tracking the session (`awaiting_canvas_ready` → … → `running` / `degraded`)
2. **Wait** for bootstrap completion and Foundry canvas readiness
3. **Create Three.js canvas** as a sibling to the PIXI `#board` element
4. **Configure PIXI** — replaced layers hidden, world rendered offscreen for texture bridge
5. **Initialize `PixiContentLayerBridge`** — captures PIXI world and UI channels as textures composited into the Three.js frame
6. **Capture Foundry state snapshot** for clean teardown later
7. **Initialize `LevelsSnapshotStore`** — caches Levels module floor data for the active scene
8. **Initialize `FloorStack`** — builds ordered floor bands from Levels snapshot (or single-floor fallback)
9. **Initialize `GpuSceneMaskCompositor`** — preloads per-floor mask composites for all levels
10. **Initialize `SceneComposer`** — loads scene background, sets up PerspectiveCamera, discovers and loads all suffix masks
11. **Initialize `MaskManager`** — registers discovered masks, defines derived masks (indoor, roofVisible, etc.)
12. **Wire `WeatherController`** — connects `_Outdoors` mask for indoor/outdoor awareness
13. **Initialize `FloorCompositor`** (V2) — creates `FloorRenderBus`, `LevelRenderTargetPool`, all V2 effects; wires shared render targets
14. **Initialize `ExternalEffectsCompositor`** — Dice So Nice + Sequencer/JB2A bridges (when modules active)
15. **Initialize `EffectComposer`** — creates `TimeManager`, registers `FloorCompositor` as the V2 delegate
16. **Initialize `DepthPassManager`** — sets up dedicated depth render pass, publishes to `MaskManager`
17. **Initialize Graphics Settings** — register V2 effect capabilities, wire effect instances
18. **Initialize scene managers** — `FloorStack` assignment, `TileManager`, `TokenManager`, `WallManager`, `DoorMeshManager`, `GridRenderer`, `DrawingManager`, `MapPointsManager`, `PhysicsRopeManager`, `TileMotionManager`, `TokenMovementManager` (parallelized where independent)
19. **Wire `TileStreamingManager`** — frustum-driven pyramid streaming for large `__bg_image__*` backgrounds
20. **Wire map points** to V2 particle effects (fire, candle, flies, lightning)
21. **Initialize `InteractionManager`** — selection, drag/drop, wall drawing, light placement, movement preview
22. **Initialize camera system** — `CameraFollower` (PIXI→Three.js each frame), `PixiInputBridge` (pan/zoom gestures), `LevelTransitionCurtain`
23. **Initialize `ControlsIntegration`** — PIXI overlay for Foundry edit tools, floor-filtering for walls/lights
24. **Initialize `LevelsPerspectiveBridge`** — bidirectional floor sync with Levels module
25. **Initialize level navigation** — keybindings, `LevelNavigatorOverlay` HUD
26. **Start `RenderLoop`** — RAF with adaptive idle throttling
27. **Initialize `FrameCoordinator`** — PIXI ticker hook for vision/fog sync
28. **Initialize Tweakpane UI** — all V2 effect parameter panels
29. **Preload all floor masks** — `GpuSceneMaskCompositor.preloadAllFloors()`
30. **Wait for readiness** — effect promises, tile texture decoding, stable Three.js frames
31. **Apply time of day** from saved scene state
32. **Play intro zoom** — `IntroZoomEffect` cinematic camera animation
33. **Fade in** — cinematic 5-second overlay dissolve
34. **LoadCoordinator** enters `running` (or `degraded` if invariant checks failed)

### Teardown: `canvasTearDown` Hook
1. **LoadCoordinator** cancels the active session → `idle`
2. Pause `TimeManager`
3. Dispose `FrameCoordinator`
4. Dispose `MaskManager` and `GpuSceneMaskCompositor`
5. Dispose `FloorCompositor` (all V2 effects + `FloorRenderBus` + `LevelRenderTargetPool`)
6. Dispose `ExternalEffectsCompositor`
7. Dispose `TileStreamingManager`
8. Destroy Three.js canvas and all scene managers
9. Dispose `PixiContentLayerBridge`
10. Clear global references (preserves renderer/capabilities for reuse)

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
Layer 32    VEGETATION_ABOVE_WATER_LAYER — bush/tree composited after bloom, before camera grade
Layer 33    WATER_SPLASH_ABOVE_WATER_LAYER — splash batches drawn after water, before vegetation
```

### Z-Ordering in FloorRenderBus

```
z = 1000 + floorIndex   Ground tiles for floor N (floor 0 at z=1000, floor 1 at z=1001, …)
z = 1000.1              Grid overlay (cached texture, slightly above ground)
z = 1000 + elev/100     Token sprites (elevation mapped to sub-integer Z)
z = 1000 + floorIndex + 0.5  Overhead tiles for floor N
```

### Render-Order Role Bands (LayerOrderPolicy)

`LayerOrderPolicy.js` assigns each bus-scene mesh a `renderOrder` based on floor
index and visual role. Each floor occupies a 10 000-slot band (N × 10 000) divided
into five role sub-bands:

```
Per floor (ascending):
  FLOOR_ALBEDO        0 – 2399   regular (non-overhead) tiles
  FLOOR_EFFECTS    2400 – 4799   effects above albedo, below overhead (default)
  FLOOR_OVERHEAD   4800 – 7199   overhead / roof tiles
  FLOOR_OVERHEAD_FX 7200 – 9599  effects above overhead (trees, canopy)
  FLOOR_MOTION_TOP 9600 – 9999   motion-forced above-tokens, reserved
```

All effects default to `FLOOR_EFFECTS` (under overhead) unless they explicitly
request `FLOOR_OVERHEAD_FX` (e.g. tree canopy). Per-tile surface effects
(specular, bush, prism, iridescence) use `tileRelativeEffectOrder()` which maps
the tile's band into the corresponding effects band.

Console diagnostic: `MapShine.floorRenderBus.dumpLayerOrder()` dumps every bus
scene object sorted by renderOrder with decoded role, floor, and visibility.

### Per-Frame Render Sequence (`FloorCompositor.render()`)

The pipeline is **per-level** for lighting, then **post-merge** for HDR grading. See `FloorCompositor.js` file header for the canonical summary.

#### A. Frame setup
1. **Time Update** — `TimeManager.update()` produces `TimeInfo`; `LightingDirector.update()` freezes canonical darkness/sun angles for all consumers
2. **Updatables** — All registered updatables receive `timeInfo`:
   - `CameraFollower`, `WeatherController`, `SceneWindField`, `DynamicExposureManager`, `ContextualSceneGradeManager`
   - `TileManager`, `TileMotionManager`, `GridRenderer`, `DoorMeshManager`, `InteractionManager`
   - `PhysicsRopeManager`, `TokenMovementManager`, shadow producers (`BuildingShadows`, `PaintedShadow`, `SkyReach`, `OverheadStamp`, vegetation billboard passes)
   - `SkyColorEffectV2` (CPU exports only), bus overlay effects

#### B. Global shadow + cloud prep (before bus render)
3. **Shadow producers** — Building, painted, sky-reach, overhead-stamp, vegetation billboard, tree canopy occlusion passes render/update their factor RTs
4. **ShadowManagerV2 combine** — Multiplies cloud + overhead + building + painted + sky-reach + vegetation billboard factors into unified `combinedShadowTexture` (runs pre-cloud with previous frame's cloud, then again after fresh cloud render)
5. **CloudEffectV2** — Generates shadow RT + cloud-top RT; feeds ShadowManager on the second combine
6. **External effects tick** — `externalEffects.tickBeforeBusRender()` syncs Sequencer/JB2A mirror transforms

#### C. Per-level pipeline (`_renderPerLevelPipeline`)
7. **Bus prepass** — For each visible floor (bottom→top): `FloorRenderBus.renderFloorRangeTo()` → per-level `sceneRT` from `LevelRenderTargetPool`. Bus overlays in this pass: specular, fluid, iridescence, prism, fire, dust, ash disturbance, ash cloud, weather particles
8. **Per-level lighting** — `LightingEffectV2` (CPU ambient compose + dynamic lights) multiplies each level's `sceneRT` into `levelPostA`; `WindowLightEffectV2` isolated scene rendered into the light accumulation RT first
9. **Per-level water** — `WaterEffectV2` runs **inside** the per-level loop only when a **single** floor is visible (preserves bloom MRT / specular path)
10. **Alpha rebind** — Each level's post-chain RT alpha is clamped to the raw `sceneRT` alpha (authoritative floor solidity mask)
11. **LevelCompositePass** — Blends per-level final RTs bottom→top using straight-alpha compositing
12. **Post-merge water** — On multi-floor scenes, `WaterEffectV2` runs **once** on the merged composite so stacking/holes are already correct
13. **Post-merge HDR chain** (single pass on merged composite):
    1. `AtmosphericFogEffectV2` — distance fog with stacked outdoors mask
    2. `BloomEffectV2` — HDR bloom (consumes water specular bloom texture when present)
    3. Water splashes (layer 33) + bush/tree vegetation (layer 32) composited into the merged frame
    4. `ColorCorrectionEffectV2` — **sole HDR→LDR owner** (exposure, white balance, ToD timeline, vignette, grain, tone mapping, contextual grade inputs)
    5. Post-CC stylization (`_runPostMergeStylizationPasses`): Filter → Sharpen → DotScreen → Halftone → ASCII → Dazzle → VisionMode → Invert → Sepia (each gated by `enabled`)

#### D. Global late passes (on merged composite)
14. **Dice So Nice** — `externalEffects.renderDsnPass()` composites DSN canvas (when rolling)
15. **DistortionManager** — Heat haze / water ripple / magic swirl; vegetation distortion mask prevents warping under canopy
16. **PIXI world composite** — Drawings, templates, notes via `PixiContentLayerBridge` (after stylization so they are not color-graded)
17. **FogOfWarEffectV2** — LOS + exploration fog composited into RT chain
18. **LensEffectV2** — Distortion, chromatic aberration, grime (runs above fog)
19. **Late overlays** (Layer 31, direct to screen): `MovementPreviewEffectV2`, `SelectionBoxEffectV2`, `PlayerLightEffectV2`, map-point particles
20. **PIXI UI overlay** — Foundry HUD composited on top
21. **Idle throttling** — Static scenes render at 15fps; `requiresContinuousRender` bypasses throttle

**Not in the main chain:** `SkyColorEffectV2` no longer performs a fullscreen color-grade pass — it exports CPU sky environment values (sun angles, tint) consumed by water, clouds, windows, and shadows. Outdoor atmosphere and ToD grading live in post-merge `ColorCorrectionEffectV2` + `ContextualSceneGradeManager`.

### Render Targets

All post-processing buffers use `THREE.FloatType` (HDR throughout the lighting chain). `ColorCorrectionEffectV2` is the mandatory HDR→LDR boundary (tone mapping, grain, vignette). Key RTs:
- `LevelRenderTargetPool` — Per-level `{ sceneRT, postA, postB }` acquired/released per visible floor
- `combinedShadowTexture` — `ShadowManagerV2` unified shadow factor RT (fed to lighting + water)
- `cloudShadowRT` / `cloudTopRT` — Cloud shadow and cloud-top coverage
- `windowLightRT` — Window light accumulation (fed to `LightingEffectV2`)
- `depthRT` — Dedicated depth pass (device depth, `DepthPassManager`)
- `_postA` / `_postB` — Global post-merge ping-pong swap chain
- `_hdrScenePreGradeRT` — Linear HDR buffer after bloom, before color correction (night-vision probe source)

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
| `_Outdoors_0` / `_Outdoors_1` | Per-level outdoors | Level-specific outdoors variants (Levels scenes) |
| `_Shadow` | `PaintedShadowEffectV2` | Hand-painted outdoor shadow mask |
| `_Iridescence` | `IridescenceEffectV2` | Holographic/thin-film interference mask |
| `_Fluid` | `FluidEffectV2` | Animated fluid surface mask |
| `_Prism` | `PrismEffectV2` | Crystal/glass refraction mask |
| `_Windows` / `_Structural` | `WindowLightEffectV2` | Window light pool mask |
| `_Bush` | `BushEffectV2` | Animated bush texture (RGBA) |
| `_Tree` | `TreeEffectV2` | Animated tree canopy texture (RGBA) |
| `_Water` | `WaterEffectV2` / `WaterSplashesEffectV2` | Water depth/area mask |

**Example**: For `TavernMap.webp`, placing `TavernMap_Specular.webp` alongside it automatically enables metallic reflections.

The `AssetLoader` (`assets/loader.js`) probes for all known suffixes via Foundry's `FilePicker` in `webp`, `png`, `jpg`, `jpeg` formats. Loading is concurrency-limited (4 parallel loads via `Semaphore`). `TextureBudgetTracker` monitors VRAM allocation and triggers eviction or resolution downscaling (0.5×) when usage exceeds 80% of budget. Masks that exist as `_X` suffixes on tile documents are also per-tile composited by `GpuSceneMaskCompositor`.

---

## 7. Effect System Architecture

### FloorCompositor (`compositor-v2/FloorCompositor.js`)

The V2 render orchestrator. It owns `FloorRenderBus`, `FloorLayerManager`, `LevelRenderTargetPool`, and all V2 effect instances:
- **Initialization** — Creates and initializes ~45 V2 effects with `concurrency=4` batch init
- **Per-frame render** — Drives the per-level + post-merge pipeline described in §5
- **Floor change** — `onFloorChange(floorIndex)` propagates to all floor-aware effects; each effect independently swaps to its per-floor data
- **Effect enable/disable** — Graphics Settings toggle effects at capability-level; disabled effects skip initialization
- **Continuous render detection** — `requiresContinuousRender` on any effect forces full-rate RAF
- **Stacked lit cache** — Reuses per-level lit RT snapshots when camera/floor context is stable across frames

### FloorRenderBus (`compositor-v2/FloorRenderBus.js`)

A standalone `THREE.Scene` that holds all tile meshes:
- **Texture loading**: Uses `THREE.TextureLoader` (HTML `<img>` element), which delivers **straight-alpha** data. This avoids the canvas-2D premultiplied-alpha corruption that plagued earlier approaches.
- **Z ordering**: Floor 0 tiles at Z=1000, floor 1 at Z=1001, etc. `depthTest` is off; stacking is entirely via `renderOrder` using `LayerOrderPolicy` role bands.
- **Render-order policy**: All tiles and effects obtain their `renderOrder` from `LayerOrderPolicy.js`. Albedo tiles use `FLOOR_ALBEDO`, effects default to `FLOOR_EFFECTS` (between albedo and overhead), overhead tiles use `FLOOR_OVERHEAD`, and above-overhead effects (trees) use `FLOOR_OVERHEAD_FX`.
- **Bus overlay effects**: `SpecularEffectV2`, `FireEffectV2`, and other overlay effects add meshes to the same bus scene. They automatically benefit from the floor visibility system via the shared render loop.
- **Tile editing suppression**: Suppresses tile meshes that are being edited to prevent double-rendering

### V2 Effect Categories

**Bus Overlays** (meshes in `FloorRenderBus`; rendered during per-level `renderFloorRangeTo`):
- `SpecularEffectV2`, `FluidEffectV2`, `IridescenceEffectV2`, `PrismEffectV2`
- `FireEffectV2`, `DustEffectV2`, `AshDisturbanceEffectV2`, `AshCloudEffectV2`, `WeatherParticlesV2`
- Bush/tree **sprites** live in the bus scene but are **drawn after bloom** on layer 32 (not in the bus albedo pass)
- `WaterSplashesEffectV2` draws on layer 33 after water, before vegetation

**Shadow Producers** (factor RTs combined by `ShadowManagerV2` before lighting):
- `CloudEffectV2` — procedural cloud shadow + cloud-top RTs
- `OverheadStampEffectV2` — directional overhead-tile stamp shadows + roof alpha / ceiling transmittance for lighting
- `BuildingShadowsEffectV2` — raymarched building shadows (cached world-space RT)
- `PaintedShadowEffectV2` — hand-painted outdoor shadows from `_Shadow` mask
- `SkyReachShadowsEffectV2` — sky-reach factor from stacked outdoors masks
- Vegetation billboard shadow passes (`shadow-system/VegetationBillboardShadowPass.js`) for bush/tree canopies

**Per-Level Post-Processing** (inside `_renderPerLevelPipeline`):
- `LightingEffectV2` — CPU ambient compose (`ambient-compose-cpu.js`) + dynamic Foundry lights + darkness; reads `LightingDirector` + `ShadowManagerV2` combined shadow; `Final = Albedo × Light`. Window light scene rendered into light RT first.
- `WaterEffectV2` — per-level when single floor visible; post-merge when multi-floor

**Post-Merge Post-Processing** (on merged composite):
- `AtmosphericFogEffectV2`, `BloomEffectV2`, splashes + vegetation overlays
- `ColorCorrectionEffectV2` — sole HDR→LDR camera grade (ToD timeline, exposure, grain, tone map, contextual grade)
- Stylization bundle via `_runPostMergeStylizationPasses`: `FilterEffectV2`, `SharpenEffectV2`, `DotScreenEffectV2`, `HalftoneEffectV2`, `AsciiEffectV2`, `DazzleOverlayEffectV2`, `VisionModeEffectV2`, `InvertEffectV2`, `SepiaEffectV2`

**CPU-Only / Non-Pass Consumers**:
- `SkyColorEffectV2` — exports sun angles and sky tint to water, clouds, windows, shadows (no fullscreen grade pass)
- `ContextualSceneGradeManager` — per-client token/cover/outdoor probes feed into `ColorCorrectionEffectV2`

**Global Late Passes**:
- `DistortionManager`, PIXI world composite, `FogOfWarEffectV2`, `LensEffectV2`

**World-Space Overlays** (Layer 31, rendered after post-FX):
- `MovementPreviewEffectV2`, `SelectionBoxEffectV2`, `PlayerLightEffectV2`
- `CandleFlamesEffectV2`, `LightningEffectV2`, `SmellyFliesEffect`, `WeatherLightningEffectV2`

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

### Breaker Box render stack (Phase 1 diagnostics)

The in-game **Breaker Box** panel includes a **render stack** column (metadata-only): ordered passes mirroring `FloorCompositor.render()`, with per-level lighting subpasses and `ShadowManagerV2` combine steps. Subpasses under `LightingEffectV2` include **WindowLightEffectV2 → lightRT**. Window glow is **not** drawn under bus albedo; it accumulates in the light buffer and is applied in the lighting compose step (`albedo × illumination`). Data is produced by `RenderStackSnapshotService` and stack rules by `RenderStackRules` (see `scripts/core/diagnostics/`).

For **WindowLightEffectV2**, the snapshot also carries a capped **per-overlay inventory** (`tileId`, `floorIndex`, `renderOrder`, `visible`, `uMaskReady`) surfaced in the Breaker Box pipeline detail panel. `RenderStackRules` emits extra findings when the **active floor** has no matching overlays but other tiles do, or when every overlay is still classified as floor `0` while a higher floor is active — typical clues for Levels / floor-index wiring issues.

**Health propagation (dependency graph):** degradation only flows along **`required`** / **`optional`** edges, not **`contextual`** (loose coupling). Propagation is **level-key scoped** (e.g. `floor:1` upstream does not stamp `floor:0` downstream). Stale rows for **active-floor-only** effects are **pruned** when the GM changes floors so the UI does not show misleading side-by-side `floor:0` / `floor:1` history. The Breaker Box shows **aggregate** status vs **current floor** status; the header dot follows **current floor** first.

### Window light vs Breaker Box “healthy” (multi-floor)

`WindowLightEffectV2` draws **transparent additive** quads in an isolated scene; `LightingEffectV2` renders that scene into the light RT, then **multiplies** `sceneRT` albedo by total illumination. A Breaker Box **healthy** result means masks loaded, meshes visible for the current floor slice, and key uniforms plausible — **not** a guarantee of correct final pixels.

Common reasons window glow can look “wrong” on an upper floor while still “healthy”:

1. **Draw order** — With `transparent: true`, Three.js may reorder draws unless `scene.sortObjects` is off and `renderOrder` encodes floor priority. Lower-floor quads overlapping the same footprint can otherwise win the blend on some frames or camera positions.
2. **Albedo multiply** — The same light field × different `sceneRT` content (different floor visible under the window) changes perceived brightness/color; this is expected compositor math, not a mask failure.
3. **Downstream passes** — `WaterEffectV2`, `DistortionManager`, `FloorDepthBlurEffect`, bloom, etc. run **after** lighting and change only some regions; they can make window-adjacent areas look floor-dependent.
4. **Screen-space gating** — Floor-0 overlays still use roof-alpha gating (`uAllowRoofGate`) in **screen UVs**; when multiple floors are visible, that can interact oddly with upper-floor views (upper-floor overlays disable roof gate by design).

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

- **State**: precipitation (0-1), precipType (rain/snow/hail/ash), cloudCover, windSpeed, windDirection, windOffsetUv (scene-UV wind vector), fogDensity, wetness, freezeLevel, effectiveDarkness
- **Transitions**: Smooth interpolation between weather presets with configurable duration
- **Dynamic Weather**: Autonomous evolution system with Perlin noise-driven variability
- **Wanderer Loop**: Natural-feeling weather variation without repetition
- **GM Authority**: Weather state persisted to scene flags, replicated to all clients via `updateScene` hook
- **`_Outdoors` mask integration**: CPU pixel extraction for O(1) indoor/outdoor lookups; drives particle spawn-time tagging

### LightingDirector (`core/LightingDirector.js`)

Single CPU authority for scene darkness and solar angles. Evaluated once per frame **before** lighting passes:

- **Inputs**: Foundry `canvas.scene.environment.darknessLevel`, calendar/time-of-day curve (`computeTimeOfDayDarkness01`), weather `effectiveDarkness`
- **Merge mode**: Configurable via `lightingDarknessPriority` setting (`max` legacy default, or `foundrySlider` / `calendar` / `weather` only)
- **Outputs**: `masterDarkness`, `hour`, `sunAzDeg` / `sunElDeg`, `calendarDayWeight` — consumed by `LightingEffectV2`, `ColorCorrectionEffectV2`, `ambient-compose-cpu.js`, shadow producers

### SceneWindField (`core/SceneWindField.js`)

Spatial gust-field layered on top of `WeatherController` base wind. Produces traveling wave fronts with lulls that couple to vegetation bulk wind (`vegetation-bulk-wind.js`), cloud advection, and water wind override. Updated each frame alongside weather.

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
- Shared **texture status row** pattern for mask-dependent effects (see `Docs/tweakpane-texture-status-instruction.md`)
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
- **Half-resolution shadows**: `OverheadStampEffectV2` tile projection at reduced resolution where configured (fill-rate savings)
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
- **Tile streaming**: `TileStreamingManager` loads multi-LOD pyramid cells on demand for large `__bg_image__*` backgrounds; pan mode defers sharpen; floor transitions pause decode
- **Fog texture sharing**: Exploration texture shared zero-copy from Foundry PIXI via `FoundryFogBridge`
- **Specular texture cloning**: `_tileSpecularMaskCache` clones compositor texture with independent `flipY=true` per-tile to prevent shared-object corruption on level changes
- **Stacked lit RT cache**: Per-level lit snapshots reused when multi-floor camera context is stable

---

## 15. Key Architectural Decisions

| Decision | Rationale |
|---|---|
| **Compositor V2 as sole runtime** | FloorRenderBus straight-alpha textures + floor layer isolation solved premult corruption and per-floor rendering in one design. V1 pipeline removed. |
| **Per-level RT pipeline + post-merge grade** | Each visible floor gets independent lighting; `LevelCompositePass` alpha-blends bottom→top; fog/bloom/CC run once on the merged HDR composite for mathematically correct multi-floor blending. |
| **ShadowManagerV2 unified combine** | Cloud, overhead, building, painted, sky-reach, and vegetation billboard factors multiply into one RT consumed by lighting/water — avoids divergent shadow math across effects. |
| **LightingDirector CPU authority** | One canonical darkness/sun-angle evaluation per frame; eliminates shader disagreements between lighting, sky, and camera grade. |
| **ColorCorrection as sole HDR→LDR owner** | Post-merge camera grade handles exposure, ToD timeline, grain, tone mapping — stylization passes run after with `msaPostStylizePrepareRgb` shoulder compress. |
| **Full canvas replacement + PIXI bridge** | Complete rendering control. PIXI world composited via texture bridge so Foundry's native layers (drawings, templates) still work. |
| **PerspectiveCamera with FOV zoom** | Fixed Z prevents depth buffer precision issues. FOV zoom preserves 3D parallax for particles. Use `sceneComposer.currentZoom` not `camera.zoom`. |
| **FloorRenderBus with THREE.TextureLoader** | `<img>` element delivers straight-alpha data; avoids canvas-2D premultiplied-alpha corruption that plagued all earlier tile-loading approaches. |
| **Tile streaming for large backgrounds** | Pyramid LOD cells loaded by frustum view rect; avoids loading 4096²+ backgrounds whole-cloth on scene entry. |
| **PIXI as camera authority** | One source of truth. `CameraFollower` follows PIXI each frame. Eliminates bidirectional sync races. |
| **LoadCoordinator state machine** | V14-aligned single authority for scene load lifecycle with invariant gates and `degraded` recovery path. |
| **GpuSceneMaskCompositor for floor masks** | GPU-based tile compositing is fast enough to preload all floors at scene load. `composeFloor()` API makes floor mask management self-contained. |
| **Server-authoritative token movement** | No optimistic updates. `changes` merged into `targetDoc` prevents stale-position lag. Move-lock owner entries prevent stale finalize unlocks. |
| **Lookup Map for fire/dust particles** | Scan mask once → `DataTexture` → vertex shader samples position. O(1) per particle, no per-frame rejection sampling, deterministic placement. |
| **DistortionManager centralized pass** | All screen-space distortions (heat, water, magic) combine in one pass; effects register sources via API instead of each owning a distortion pass. |
| **Vegetation after bloom (layer 32)** | Bush/tree overlays skip bus albedo and post-bloom composite so water tint never paints over canopy; distortion masked under foliage. |
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
  loadCoordinator,     // LoadCoordinator (scene load state machine)
  tileStreamingManager,// TileStreamingManager (pyramid streaming for large maps)

  // Scene Managers
  tokenManager, tileManager, wallManager, doorMeshManager,
  gridRenderer, interactionManager, mapPointsManager,
  physicsRopeManager, surfaceRegistry,
  tileMotionManager, tokenMovementManager, tileEffectBindingManager,
  levelTransitionCurtain, sceneTransitionCurtain,

  // Foundry Integration
  cameraFollower, pixiInputBridge, pixiContentLayerBridge,
  controlsIntegration, frameCoordinator,
  levelsPerspectiveBridge, levelsSnapshotStore,
  externalEffects,     // ExternalEffectsCompositor (DSN + Sequencer)

  // V2 Effects (all individually accessible via effect-wiring.js exports)
  lightingEffect, fogEffect, specularEffect, bloomEffect,
  cloudEffect, waterEffect, shadowManagerEffect, distortionManager, /* …all V2 effects */

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

- **Foundry v14** (minimum, verified, maximum all v14; API contract verified against v14 source)
- **Levels module**: Full integration. Scenes without Levels use single-floor fallback. `LevelsCompatibility` warns on detected conflicts.
- **Recommended modules**: Dice So Nice and Sequencer/JB2A integrated via `external-effects/` (Graphics Settings toggles)
- **Game system agnostic**: `GameSystemManager` adapter pattern handles PF2e vision type differences, D&D 5e defaults, etc.
- **Module conflicts**: Modules that directly manipulate PIXI world layers may conflict in Gameplay mode (they work in Map Maker mode). `LevelsCompatibility` handles Better Roofs and similar.
- **Performance floor**: Requires WebGL2. No WebGPU requirement (but future path is open).
- **Scene opt-in**: Only affects scenes with `flags['map-shine-advanced'].enabled = true` — all other scenes use Foundry's native PIXI rendering unchanged.

---

## 19. Architectural Review — Findings & Considerations

_Added 2026-03-19, pipeline notes refreshed 2026-06-22. This section records the results of a codebase-backed investigation into
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

**Codebase finding (2026-06-22)**: The pipeline has been restructured since the original review. Per-level work is now dominated by `LightingEffectV2` (CPU ambient compose + light RT sub-passes) inside `_renderPerLevelPipeline`. Post-merge passes on the **merged composite** are: AtmosphericFog → Bloom → (splashes/vegetation draw calls) → ColorCorrection (mandatory HDR→LDR) → up to 8 stylization passes in `_runPostMergeStylizationPasses`. Global late passes add Distortion, PIXI composite, Fog overlay, and Lens.

**However**: Stylization passes (DotScreen, Halftone, ASCII, Dazzle, Sepia, Invert, VisionMode, Sharpen, Filter) are all gated by `params.enabled`. In a typical session, only **5-8 post-merge passes** actually execute (fog, bloom, color correction, fog overlay, lens). Per-level lighting runs once per visible floor (typically 1-3).

**Verdict on "Uber Shader" proposal**: Partially addressed — `msa-post-stylize-input.glsl.js` now shared-compresses HDR shoulders for post-CC stylize passes. Consolidating Filter + Sepia + Invert + Sharpen into a single uber shader remains a valid polish (~2-3 fewer RT swaps). The dominant bandwidth cost is now per-level lighting (CPU compose + light RT) and post-merge bloom on true HDR input.

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

**Claim**: ~45 hardcoded effects in `FloorCompositor.js` prevent third-party extensibility.

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

---

## 20. External Effects Integration (Dice So Nice + Sequencer / JB2A)

Map Shine Advanced replaces Foundry's PIXI rendering with its own Three.js
scene, which means third-party modules that draw to PIXI (Sequencer / JB2A)
or stamp their own canvas on top of Foundry's (Dice So Nice) are invisible
or visually inconsistent with MSA's post-processing. The
`scripts/integrations/external-effects/` package bridges these modules into
MSA's compositor.

### 20.1. Subsystem Layout

```
scripts/integrations/external-effects/
├── ExternalEffectsCompositor.js  # orchestrator; owns adapters + facades
├── DiceSoNiceAdapter.js          # texture-mirror channel for DSN
├── ExternalDsnPass.js            # fullscreen composite pass (DSN canvas)
├── SequencerAdapter.js           # lifecycle owner; spawns one mirror per effect
├── SequencerEffectMirror.js      # per-effect THREE.Mesh + transform sync
└── ExternalLayerOrderPolicy.js   # re-export of externalEffectOrder()
```

Built once per scene from `canvas-replacement.js` after `FloorCompositor` is
initialized; exposed on `window.MapShine.externalEffects`. Disposed on
`canvasTearDown` so all third-party DOM/canvas state is restored.

### 20.2. Two Integration Channels

**Channel 1 — Sprite mirror (Sequencer / JB2A).** Each `CanvasEffect` created
by Sequencer spawns a `THREE.Mesh` in `FloorRenderBus._scene`:

- The PIXI container's `renderable` flag is set to `false`, so Sequencer's
  own renderer does not paint pixels anywhere.
- The mesh texture wraps the same media Sequencer is using:
  - **Video** (`.webm` — JB2A's default): `THREE.VideoTexture` over the
    `HTMLVideoElement` Sequencer is already playing. Zero-copy.
  - **Static sprite** (`.webp`/`.png`): `THREE.Texture` over the underlying
    `HTMLImageElement` / `HTMLCanvasElement` / `ImageBitmap`.
  - **Spritesheet** (`AnimatedSpriteMesh`): `THREE.Texture` over the base
    image; `map.offset`/`map.repeat` are updated per tick from the active
    frame's `texture.frame` rectangle.
- Transform sync (position/rotation/scale/opacity) runs once per
  `FrameCoordinator.onPostPixi` — Foundry's PIXI ticker — so meshes track
  PIXI without per-RAF reflow.
- `renderOrder` is computed via `externalEffectOrder(floorIndex,
  sortLayer, sort)` in `LayerOrderPolicy.js`, which maps Sequencer's
  `sortLayer` (300/600/700/800/900/1000) to the top slice of an existing
  MSA role band (`FLOOR_EFFECTS`, `FLOOR_OVERHEAD_FX`, `FLOOR_MOTION_TOP`).
  External effects therefore sit just above same-floor MSA overlays in the
  same band — preserving MSA's tile/sprite stacking underneath.

Sequencer's `screenSpace` / `screenSpaceAboveUI` paths (a separate
DOM-hosted PIXI app called `SequencerAboveUILayer`) are intentionally not
mirrored — they are screen-space by design, and the user expectation is
that they remain on top of MSA's UI overlays.

**Channel 2 — Texture mirror (Dice So Nice).** DSN bundles its own
Three.js r184 in a separate WebGL context, so we cannot share GL resources
with MSA's r170 renderer. Instead:

- The adapter wraps `game.dice3d.box.diceScene.renderer.domElement` (the
  DSN `<canvas>`) in a `THREE.CanvasTexture`.
- DSN's `renderer.render` is monkey-patched to mark the texture dirty
  (`needsUpdate = true`) once per DSN frame.
- The DSN canvas is hidden (`style.display = 'none'`) so it does not paint
  directly on top of MSA's WebGL canvas; the texture is composited inside
  MSA via {@link ExternalDsnPass}.
- The pass is enabled on `diceSoNiceRollStart` and disabled after
  `diceSoNiceRollComplete` plus a `hideAfterRoll` grace window
  (default 4s, capped at DSN's `timeBeforeHide` config when present).
- On dispose, the monkey-patch is reverted and the canvas's original
  `display` style is restored — so disabling MSA or this adapter fully
  restores DSN's stock behaviour.

### 20.3. Render-Chain Insertion (`FloorCompositor.render()`)

Two injection points in the existing render pipeline:

1. **`externalEffects.tickBeforeBusRender()`** — called immediately before
   `_renderPerLevelPipeline()` so Sequencer mirrors in
   `FloorRenderBus._scene` are validated before bus render.
2. **`externalEffects.renderDsnPass(renderer, currentInput, outputRT)`** —
   called after `_renderPerLevelPipeline()` (which includes post-merge fog, bloom,
   vegetation overlays, and color correction) and before the `distortion` /
   `pixi-world-composite` / `fog-of-war` / `lens` block. Dice therefore receive
   the camera-graded scene plus distortion, fog, and lens — but **not** a second
   bloom pass on top of themselves.

Sequencer mirrors render inside the bus albedo pass and receive per-level lighting
during `_renderPerLevelPipeline()`; they also receive post-merge bloom and camera grade
because those run on the merged composite before the late global passes.

### 20.4. Graphics Settings Integration

Two new capability rows are registered via `effect-wiring.js`:

| Capability ID | Display Name | Availability gate |
|---|---|---|
| `external-effects-dsn` | Dice So Nice Integration | `game.modules.get('dice-so-nice')?.active` |
| `external-effects-sequencer` | Sequencer / JB2A Integration | `game.modules.get('sequencer')?.active` |

The compositor exposes `ExternalEffectsCompositor.facades.{sequencer,diceSoNice}`,
each implementing the `setEnabled(boolean)` protocol expected by
`GraphicsSettingsManager.applyOverrides()`. These facades are registered
via `graphicsSettings.registerEffectInstance(...)` in `canvas-replacement.js`
so the toggles route to `setAdapterEnabled()`.

Disabling either adapter performs a clean rollback:

- **DSN disabled**: `ExternalDsnPass.enabled = false`, DSN canvas
  `display` restored. DSN rolls remain visible via its native overlay.
- **Sequencer disabled**: `_enabled = false`. New effects no longer spawn
  mirrors and their PIXI containers stay `renderable = true`, so Sequencer
  renders normally (though MSA's PIXI suppression makes those effects
  invisible in gameplay mode — this is identical to MSA's pre-integration
  behaviour).

### 20.5. Known Limitations

- DSN's per-frame `texImage2D` upload of its canvas is the practical
  ceiling on integration depth — cross-context texture sharing is not
  feasible across Three.js r184 (DSN) and r170 (MSA).
- Sequencer PIXI filters beyond `tint` and `alpha` (mask filters,
  displacement filters) are not mirrored in v1; effects that rely on
  those will look different in MSA than in vanilla PIXI.
- Sequencer's `screenSpace` / `screenSpaceAboveUI` paths are intentionally
  excluded — they remain in their own DOM-hosted PIXI app on top of
  everything.
- DSN's `showcase` and `editor` renderers (settings-UI dice preview) are
  left untouched — only the in-scene `'board'` renderer is intercepted.
