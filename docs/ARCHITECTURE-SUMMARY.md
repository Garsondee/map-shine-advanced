# Map Shine Advanced — Architecture Summary

**Module**: `map-shine-advanced` v0.1.8  
**Foundry VTT Compatibility**: v13  
**Renderer**: Three.js r170 (PerspectiveCamera, FOV-based zoom)  
**Last Updated**: 2025-02-08

---

## 1. What Is Map Shine Advanced?

Map Shine Advanced is a Foundry VTT module that **completely replaces Foundry's PIXI-based canvas** with a custom Three.js 2.5D rendering engine. It renders battlemaps with cinematic PBR materials, GPU particle effects, dynamic weather, real-time lighting, fog of war, and a full post-processing stack — all driven by a **suffix-based texture system** that requires zero configuration from map creators beyond naming their image files.

### What Three.js Renders (Everything Visual)

- Background plane with PBR material effects (specular, roughness, normal maps)
- Grid overlay (square and hex, cached to texture)
- All tiles (ground, foreground, overhead/roof) synced from Foundry
- All tokens synced from Foundry (with elevation, animation, selection visuals)
- Walls, doors, drawings, notes, measurement templates, light icons
- Dynamic lighting with full indoor/outdoor occlusion
- Fog of war (vision + exploration)
- Weather particles (rain, snow, ash), fire, dust, flies, lightning
- Animated vegetation (bushes, trees with wind)
- Water with reflections, caustics, and depth-based rendering
- Cloud shadows, building shadows, overhead shadows
- Post-processing (bloom, lensflare, color correction, film grain, distortion, etc.)

### What Foundry Provides (Data + UI Only)

- Authoritative game data (token positions, tile documents, wall segments, light sources)
- HTML UI overlay (sidebar, chat, character sheets, tool buttons)
- Game logic, hooks, and module API
- Camera state (PIXI stage pivot/zoom — Three.js follows it)

### What's Hidden

- Foundry's PIXI canvas is set to `opacity: 0` and `pointer-events: none`
- Specific PIXI layers (background, grid, primary, weather, environment) are `visible = false`
- Token PIXI meshes are made transparent (`alpha = 0`) but remain interactive for hit detection

---

## 2. Project Structure

```
scripts/
├── module.js                 # Foundry hook entrypoint (init, ready)
├── types.jsdoc               # Shared TypeScript-style type definitions
│
├── core/                     # Bootstrap, renderer, time, weather, profiling
│   ├── bootstrap.js          # Initialization orchestrator (GPU detect → renderer → scene)
│   ├── capabilities.js       # GPU tier detection (WebGPU/WebGL2/WebGL1/none)
│   ├── renderer-strategy.js  # Tiered renderer creation with fallback
│   ├── time.js               # Centralized TimeManager (all effects MUST use this)
│   ├── render-loop.js        # RAF loop with idle throttling and motion detection
│   ├── frame-coordinator.js  # PIXI↔Three.js frame synchronization
│   ├── frame-state.js        # Per-frame camera state snapshot
│   ├── WeatherController.js  # Global weather state machine (precip, wind, clouds, fog)
│   ├── DynamicExposureManager.js # Token-based eye adaptation
│   ├── game-system.js        # Game system compatibility (PF2e, D&D 5e, etc.)
│   ├── render-invalidation.js # Dirty-flag caching for static scenes
│   ├── resource-registry.js  # Centralized GPU resource disposal
│   ├── load-session.js       # Scene load session tracking (staleness detection)
│   ├── loading-profiler.js   # Performance instrumentation
│   ├── profiler.js           # Runtime frame profiler
│   ├── shader-validator.js   # GLSL compile-time validation
│   ├── log.js                # Namespaced logger
│   └── errors.js             # User-facing error notifications
│
├── assets/                   # Texture loading and policies
│   ├── loader.js             # Suffix-based asset bundle loader with caching
│   └── texture-policies.js   # Standardized texture configs (ALBEDO, DATA_MASK, etc.)
│
├── settings/
│   └── scene-settings.js     # Three-tier settings (Map Maker → GM → Player)
│
├── foundry/                  # Foundry VTT integration layer
│   ├── canvas-replacement.js # THE MAIN ORCHESTRATOR — hooks, init, teardown, wiring
│   ├── controls-integration.js # PIXI overlay for Foundry tools (walls, lighting, etc.)
│   ├── unified-camera.js     # Single source of truth for camera state
│   ├── camera-follower.js    # One-way Three.js→PIXI camera sync (per-frame)
│   ├── camera-sync.js        # Legacy bidirectional sync (kept but superseded)
│   ├── input-router.js       # Routes pointer events between Three.js and PIXI
│   ├── pixi-input-bridge.js  # Pan/zoom on Three canvas applied to PIXI stage
│   ├── layer-visibility-manager.js # Hides/shows PIXI layers by mode
│   ├── drop-handler.js       # Drag-and-drop token/tile creation
│   └── scene-controls.js     # Foundry scene control button definitions
│
├── scene/                    # Scene graph managers (Foundry data → Three.js objects)
│   ├── composer.js           # SceneComposer — scene setup, camera, base plane, assets
│   ├── token-manager.js      # Tokens (hook-driven CRUD, animation, selection)
│   ├── tile-manager.js       # Tiles (ground/overhead/roof, occlusion layers)
│   ├── wall-manager.js       # Wall segment visualization and selection
│   ├── DoorMeshManager.js    # Animated door graphics
│   ├── grid-renderer.js      # Grid overlay (square/hex, cached texture)
│   ├── interaction-manager.js # Input handling (select, drag, drop, walls, lights)
│   ├── drawing-manager.js    # Freehand drawings
│   ├── note-manager.js       # Map notes/pins
│   ├── template-manager.js   # Measurement templates
│   ├── light-icon-manager.js # Light source gizmos
│   ├── enhanced-light-icon-manager.js # Extended light icons (cookies, colors)
│   ├── map-points-manager.js # V1.x backwards-compatible map point groups
│   ├── physics-rope-manager.js # Rope/chain physics simulation
│   ├── surface-registry.js   # Tracks which surfaces exist (ground, overhead, roof)
│   ├── camera-controller.js  # Legacy standalone camera controller
│   └── LightMesh.js          # Light source mesh representation
│
├── effects/                  # Visual effect implementations
│   ├── EffectComposer.js     # Effect orchestrator (layers, render order, shared targets)
│   ├── effect-capabilities-registry.js # Registry for Graphics Settings integration
│   ├── LightingEffect.js     # Dynamic lighting (screen-space post-process)
│   ├── ThreeLightSource.js   # Per-light shader representation
│   ├── ThreeDarknessSource.js # Darkness source representation
│   ├── WorldSpaceFogEffect.js # Fog of war (world-space plane mesh)
│   ├── SpecularEffect.js     # PBR specular/metallic with micro-sparkle
│   ├── IridescenceEffect.js  # Thin-film holographic interference
│   ├── PrismEffect.js        # Refraction/prism effect
│   ├── WaterEffectV2.js      # Full water system (reflections, caustics, depth)
│   ├── WaterSurfaceModel.js  # Water surface simulation model
│   ├── WindowLightEffect.js  # Interior window light pools + specular
│   ├── BushEffect.js         # Wind-animated bushes
│   ├── TreeEffect.js         # Wind-animated tree canopy
│   ├── CloudEffect.js        # Procedural cloud shadows + cloud tops
│   ├── AtmosphericFogEffect.js # Volumetric atmospheric fog
│   ├── OverheadShadowsEffect.js # Roof drop-shadow projection
│   ├── BuildingShadowsEffect.js # Raymarched building shadows (cached)
│   ├── BloomEffect.js        # HDR bloom with threshold
│   ├── LensflareEffect.js    # Screen-space lens flare
│   ├── DazzleOverlayEffect.js # Dazzle/glare overlay
│   ├── ColorCorrectionEffect.js # Color grading, brightness, contrast
│   ├── SkyColorEffect.js     # Time-of-day sky color grading
│   ├── FilmGrainEffect.js    # Film grain noise overlay
│   ├── SharpenEffect.js      # Unsharp mask sharpening
│   ├── DotScreenEffect.js    # Halftone dot screen
│   ├── HalftoneEffect.js     # Advanced halftone rendering
│   ├── AsciiEffect.js        # ASCII art rendering
│   ├── DistortionManager.js  # Centralized screen distortion (heat haze, water, magic)
│   ├── LightningEffect.js    # Lightning bolt particle effect
│   ├── CandleFlamesEffect.js # Candle flame billboards
│   ├── PlayerLightEffect.js  # Player-controlled torch/flashlight
│   ├── SelectionBoxEffect.js # Custom selection rectangle rendering
│   ├── MaskDebugEffect.js    # Debug visualization of texture masks
│   ├── DebugLayerEffect.js   # Debug layer viewer
│   └── Foundry*ShaderChunks.js # GLSL chunks matching Foundry's lighting math
│
├── particles/                # GPU particle systems
│   ├── ParticleSystem.js     # Base particle system (three.quarks integration)
│   ├── FireSparksEffect.js   # Fire particles from _Fire mask + map points
│   ├── WeatherParticles.js   # Rain, snow, ash with dual-mask indoor/outdoor
│   ├── DustMotesEffect.js    # Floating dust motes from _Dust mask
│   ├── SmellyFliesEffect.js  # Insect swarm particles
│   ├── AshDisturbanceEffect.js # Token-movement-triggered ash bursts
│   ├── RainStreakGeometry.js  # Custom rain drop geometry
│   ├── SnowGeometry.js       # Custom snowflake geometry
│   ├── AshGeometry.js        # Custom ash particle geometry
│   ├── SmartWindBehavior.js   # Indoor/outdoor-aware wind physics
│   ├── ParticleBuffers.js    # Shared GPU buffer management
│   └── shaders/              # Particle vertex/fragment shaders
│
├── masks/
│   └── MaskManager.js        # Centralized mask registry (boost, blur, derive)
│
├── vision/                   # Vision and fog subsystem
│   ├── VisionManager.js      # Vision polygon management (throttled, pooled)
│   ├── VisionPolygonComputer.js # Raycasting vision polygon computation
│   ├── FogManager.js         # Fog state management
│   ├── FoundryFogBridge.js   # Bridge to Foundry's fog textures
│   └── GeometryConverter.js  # PIXI polygon → Three.js shape conversion
│
├── ui/                       # User interface
│   ├── tweakpane-manager.js  # Main Tweakpane config UI (GM effect parameters)
│   ├── control-panel-manager.js # Control Panel (time of day, weather, presets)
│   ├── graphics-settings-manager.js # Player Graphics Settings (disable/reduce effects)
│   ├── graphics-settings-dialog.js  # Graphics Settings Tweakpane dialog
│   ├── effect-stack.js       # Effect parameter UI generation
│   ├── state-applier.js      # Centralized time/weather state application
│   ├── loading-overlay.js    # Cinematic loading screen with staged progress
│   ├── overlay-ui-manager.js # World-anchored DOM overlays
│   ├── light-editor-tweakpane.js # In-world light property editor
│   ├── enhanced-light-inspector.js # Enhanced light inspector UI
│   ├── texture-manager.js    # Texture browser/manager UI
│   ├── parameter-validator.js # Parameter range validation
│   └── diagnostic-center*.js # Debug diagnostic tools
│
├── utils/                    # Shared utilities
│   ├── coordinates.js        # Foundry↔Three.js coordinate conversion
│   ├── console-helpers.js    # Developer console helpers (MapShine.debug.*)
│   └── scene-debug.js        # Scene state debugging tools
│
├── vendor/                   # Vendored dependencies (local, no CDN)
│   └── three/                # Custom Three.js build (tree-shaken)
│
└── libs/                     # Third-party libraries
    ├── quarks.core.module.js # three.quarks particle engine (core)
    └── three.quarks.module.js # three.quarks Three.js integration
```

---

## 3. Startup & Initialization Flow

The module boots through a precise sequence of Foundry hooks:

### Phase 1: `init` Hook (`module.js`)
1. Show black loading overlay immediately
2. Register Foundry settings (`scene-settings.js`)
3. Register UI settings (`tweakpane-manager.js`)
4. Register scene control buttons (Config, Control Panel, Graphics Settings, Player Lights)
5. Inject tile config UI (Roof toggle, Bypass Effects, Cloud toggles)
6. Call `canvasReplacement.initialize()` — registers all Foundry hooks

### Phase 2: `ready` Hook (`module.js` → `bootstrap.js`)
1. Load Three.js from vendored build (`three.custom.js`)
2. Detect GPU capabilities (WebGPU → WebGL2 → WebGL1 → none)
3. Create renderer with tiered fallback strategy
4. Initialize `GameSystemManager` (PF2e, 5e compatibility)
5. Create placeholder scene + camera
6. Install console helpers (`MapShine.debug.*`)
7. Show success notification with GPU tier

### Phase 3: `canvasReady` Hook (`canvas-replacement.js`)
This is where the real work happens. If the scene has `map-shine-advanced.enabled = true`:

1. **Wait** for bootstrap completion and Foundry canvas readiness
2. **Create Three.js canvas** as a sibling to the PIXI `#board` element
3. **Configure PIXI** as transparent overlay (background alpha = 0, replaced layers hidden)
4. **Capture Foundry state snapshot** for clean teardown later
5. **Initialize SceneComposer** — loads scene background, sets up PerspectiveCamera, discovers and loads all suffix masks
6. **Initialize MaskManager** — registers discovered masks, defines derived masks (indoor, roofVisible, etc.)
7. **Wire WeatherController** — connects `_Outdoors` mask for indoor/outdoor awareness
8. **Initialize EffectComposer** — creates TimeManager, shared render targets (FloatType for HDR)
9. **Batch-initialize independent effects** (26 effects, concurrency=4, respecting Graphics Settings lazy-skip)
10. **Initialize Graphics Settings** — register capabilities, wire effect instances
11. **Initialize dependent effects** sequentially (ParticleSystem → Fire → Dust → Ash → LightEnhancementStore → Lighting → CandleFlames)
12. **Wire base mesh** to surface effects (Specular, Water, Bushes, Trees, Lighting, Clouds, etc.)
13. **Initialize scene managers** — Grid, Tokens, Tiles, Walls, Doors, Drawings, Notes, Templates, Lights, MapPoints (parallelized where independent)
14. **Wire map points** to particle effects (fire, candle, flies, lightning)
15. **Initialize InteractionManager** — selection, drag/drop, wall drawing, light placement
16. **Initialize camera system** — CameraFollower (Three follows PIXI), PixiInputBridge (pan/zoom)
17. **Initialize ControlsIntegration** — PIXI overlay for Foundry edit tools
18. **Start RenderLoop** — RAF with idle throttling
19. **Initialize FrameCoordinator** — PIXI ticker hook for vision/fog sync
20. **Initialize Tweakpane UI** — all effect parameter panels
21. **Wait for readiness** — effect promises, tile texture decoding, stable Three.js frames
22. **Apply time of day** from saved scene state
23. **Fade in** — cinematic 5-second overlay dissolve

### Teardown: `canvasTearDown` Hook
1. Pause TimeManager
2. Dispose FrameCoordinator
3. Dispose MaskManager
4. Destroy Three.js canvas and all managers
5. Clear global references (preserves renderer/capabilities for reuse)

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
Three.x = Foundry.x + width/2          (top-left → center)
Three.y = canvas.dimensions.height - (Foundry.y + height/2)  (Y flip + center)
```

**Camera**: PerspectiveCamera at fixed Z=1000 units. Zoom is achieved by adjusting FOV (`camera.fov = baseFov / zoomLevel`), not by moving the camera. This prevents depth buffer precision issues while preserving 3D parallax for particles.

**Camera Sync**: `CameraFollower` reads PIXI stage pivot and zoom each frame, converts to Three.js coordinates, and applies. `PixiInputBridge` handles pan/zoom gestures on the Three canvas and applies them to PIXI's stage, completing the loop.

---

## 5. Rendering Pipeline

### Scene Layer Stack (Z-Order)

```
z ≈ groundZ      Ground plane (base map with PBR effects applied as surface meshes)
z ≈ groundZ+0.4  Grid overlay (cached to texture)
z ≈ 1-5          Ground tiles (Foundry background tiles)
z ≈ 10+elev      Tokens (elevation-aware)
z ≈ 20           Overhead tiles (roofs) — assigned to Layer 20 for occlusion passes
z ≈ 25-50        Environmental meshes (fog plane at z=50, weather volumes)
```

### Per-Frame Render Sequence

The `EffectComposer` orchestrates the following each frame:

1. **Time Update** — `TimeManager.update()` produces `TimeInfo` (elapsed, delta, fps, paused, scale)
2. **Updatables** — All registered updatables receive `timeInfo`:
   - `CameraFollower` (sync camera)
   - `WeatherController` (evolve weather state)
   - `DynamicExposureManager` (adjust exposure)
   - `TileManager` (animated tiles, occlusion updates)
   - `GridRenderer` (grid animation)
   - `DoorMeshManager` (door open/close animation)
   - `InteractionManager` (HUD positioning, selection visuals)
   - `PhysicsRopeManager` (rope/chain simulation)
3. **Scene Effects** — Effects in the scene graph (meshes, particles) update their uniforms
4. **Main Scene Render** — Render scene to `sceneRenderTarget` (FloatType for HDR)
5. **Post-Processing Chain** — Sequential fullscreen passes:
   - Lighting (screen-space, multiplicative: `Final = Albedo × Light`)
   - Bloom (HDR threshold extraction → blur → composite)
   - Distortion (heat haze, water ripple, magic)
   - Color Correction / Sky Color
   - Film Grain, Sharpen, Halftone, ASCII (stylistic)
6. **Overlay Layer** — Rendered directly to screen after post-FX (Three Layer 31)
7. **Idle Throttling** — Static scenes render at 15fps; continuous effects force full-rate RAF

### Render Targets

All internal post-processing buffers use `THREE.FloatType` to maintain HDR data throughout the chain (prevents banding artifacts from 8-bit quantization). The lighting shader includes dithering for smooth dark gradients.

---

## 6. Suffix-Based Asset System

Map creators provide effect masks by appending suffixes to their base map filename:

| Suffix | Effect | Description |
|---|---|---|
| `_Specular` | SpecularEffect | Metallic/specular highlight mask |
| `_Roughness` | SpecularEffect | Surface roughness map |
| `_Normal` | LightingEffect | Normal map for lighting detail |
| `_Fire` | FireSparksEffect | Fire placement mask (white = fire) |
| `_Ash` | AshDisturbanceEffect | Ash particle mask |
| `_Dust` | DustMotesEffect | Dust mote placement mask |
| `_Outdoors` | Multiple | Indoor/outdoor area mask (white = outdoors) |
| `_Iridescence` | IridescenceEffect | Holographic/thin-film mask |
| `_Prism` | PrismEffect | Refraction mask |
| `_Windows` | WindowLightEffect | Window lighting mask |
| `_Structural` | WindowLightEffect | Legacy window mask |
| `_Bush` | BushEffect | Animated bush texture (RGBA) |
| `_Tree` | TreeEffect | Animated tree canopy texture |
| `_Water` | WaterEffectV2 | Water depth data mask |

**Example**: For `TavernMap.webp`, placing `TavernMap_Specular.webp` alongside it automatically enables metallic reflections.

The `AssetLoader` (`assets/loader.js`) probes for all known suffixes in `webp`, `png`, `jpg`, `jpeg` formats, with concurrency-limited parallel loading and caching.

---

## 7. Effect System Architecture

### EffectComposer (`effects/EffectComposer.js`)

Central orchestrator that manages:
- **Effect registry** — `Map<string, EffectBase>` with deterministic render order
- **Render layers** — BASE(0), MATERIAL(100), SURFACE_EFFECTS(200), PARTICLES(300), ENVIRONMENTAL(400), POST_PROCESSING(500)
- **Shared render targets** — Managed pool with consistent FloatType precision
- **Batch initialization** — Parallel effect init with concurrency limit (4)
- **Updatable system** — Any object with `update(timeInfo)` can be registered
- **Continuous render detection** — Effects can request full-rate RAF via `requiresContinuousRender`

### Effect Categories

**Surface Effects** (meshes in the scene, cloned from base plane):
- `SpecularEffect` — PBR specular with animated stripe highlights and micro-sparkle
- `IridescenceEffect` — Thin-film holographic colors (additive blending)
- `PrismEffect` — Refraction/chromatic aberration
- `WaterEffectV2` — Full water system with reflections, caustics, flow, depth
- `WindowLightEffect` — Indoor light pools from windows, cloud-dimmed
- `BushEffect` / `TreeEffect` — Wind-animated vegetation sprites

**Lighting & Shadows** (screen-space post-process or world-space cached):
- `LightingEffect` — Complete replacement for Foundry's illumination. Reconstructs world coordinates from screen UVs, applies `Final = Albedo × Light`. Supports indoor occlusion via roof alpha pre-pass.
- `OverheadShadowsEffect` — Drop-shadow from overhead tiles (half-resolution, zoom-stable)
- `BuildingShadowsEffect` — Raymarched building shadows (cached to 2048² world-space texture)
- `CloudEffect` — Procedural cloud shadows + cloud-top overlay (105KB of shader logic)

**Particle Effects**:
- `FireSparksEffect` — Fire particles using Lookup Map technique (scan mask → DataTexture → vertex shader sample). Smart weather guttering (rain extinguishes outdoor fires).
- `WeatherParticles` — Rain, snow, ash with dual-mask visibility (world-space `_Outdoors` + screen-space roof alpha), drag/inertia physics, stateless gust displacement
- `DustMotesEffect` — Floating dust from `_Dust` mask
- `SmellyFliesEffect` — Insect swarm around map points
- `AshDisturbanceEffect` — Token movement triggers ash bursts from `_Ash` mask
- `CandleFlamesEffect` — Candle billboard sprites linked to lighting
- `LightningEffect` — Procedural lightning bolts

**Post-Processing** (screen-space passes):
- `BloomEffect` — HDR bloom with hotspot layer support
- `LensflareEffect` — Screen-space lens flare
- `DistortionManager` — Centralized distortion with layered sources (heat haze, water ripple, magic swirl). Effects register distortion sources via API.
- `ColorCorrectionEffect` — Color grading, brightness, contrast
- `SkyColorEffect` — Time-of-day color tinting
- `FilmGrainEffect`, `SharpenEffect`, `DotScreenEffect`, `HalftoneEffect`, `AsciiEffect` — Stylistic filters

**Fog & Vision**:
- `WorldSpaceFogEffect` — Fog of war as a world-space plane mesh at z=50. Vision polygons rendered to world-space render target. Exploration texture shared from Foundry's PIXI via WebGL texture handle (zero-copy).
- `AtmosphericFogEffect` — Volumetric distance-based fog

**Player Features**:
- `PlayerLightEffect` — Token-attached torch/flashlight with cone, per-token flags
- `SelectionBoxEffect` — Custom drag-select rectangle with presets (Blueprint, Marching Ants, Neon)

### TimeManager (`core/time.js`)

**All effects MUST use the centralized TimeManager.** Never use `performance.now()` or `Date.now()` directly in effects.

- `timeInfo.elapsed` — Total scaled time (for sine waves, animation phases)
- `timeInfo.delta` — Frame delta in seconds (for physics, frame-rate independence)
- `timeInfo.paused` / `timeInfo.scale` — Supports Foundry pause integration and slow-motion
- Smooth pause transitions (ramps time scale to 0 over configurable duration)

---

## 8. Mask & Weather Systems

### MaskManager (`masks/MaskManager.js`)

Centralized registry for all texture masks:
- **Stores** raw masks from asset bundles with metadata (UV space, color space, lifecycle)
- **Derives** computed masks: `indoor.scene` (inverted outdoors), `roofVisible.screen`, `precipVisibility.screen`
- **GPU operations**: Boost (threshold + multiply), Blur (separable Gaussian), Composite (max, invert)
- Effects request masks by ID; MaskManager handles all preprocessing

### WeatherController (`core/WeatherController.js`)

Global weather state machine driving all environmental effects:

- **State**: precipitation (0-1), precipType (rain/snow/hail/ash), cloudCover, windSpeed, windDirection, fogDensity, wetness, freezeLevel
- **Transitions**: Smooth interpolation between weather presets with configurable duration
- **Dynamic Weather**: Autonomous evolution system with Perlin noise-driven variability
- **Wanderer Loop**: Natural-feeling weather variation without repetition
- **GM Authority**: Weather state persisted to scene flags, replicated to all clients via `updateScene` hook
- **Roof Mask Integration**: CPU-extracted `_Outdoors` mask data for O(1) indoor/outdoor lookups

### Indoor/Outdoor Awareness

The `_Outdoors` mask (white = outdoors, black = indoors) drives multiple systems:
- **Weather particles**: Dual-mask visibility (world-space `_Outdoors` + screen-space roof alpha)
- **Fire guttering**: Outdoor fires reduced by precipitation; indoor fires immune
- **Lighting occlusion**: Indoor lights blocked by opaque roofs
- **Wind physics**: `SmartWindBehavior` tags particles at spawn time with outdoor factor
- **Cloud shadows**: Only affect outdoor areas

---

## 9. Scene Managers

### SceneComposer (`scene/composer.js`)

Sets up the Three.js scene from Foundry scene data:
- Creates PerspectiveCamera with FOV-based zoom (fixed Z=1000, `fov = baseFov / zoom`)
- Loads base map texture and creates ground plane mesh
- Discovers and loads all suffix-based masks via `AssetLoader`
- Defines `groundZ`, `worldTopZ`, `weatherEmitterZ` for consistent layering
- Handles scene background color for padded regions
- Tracks owned GPU resources for leak-free scene transitions

### TokenManager (`scene/token-manager.js`)

- Creates `THREE.Sprite` for each Foundry token, synced via hooks (`createToken`, `updateToken`, `deleteToken`)
- **Server-authoritative**: No optimistic updates. Visual state waits for `updateToken` hook with `changes` merged into `targetDoc` to prevent stale-position lag.
- Elevation → Z position mapping
- Selection visuals (ring, tint)
- Token movement callback for ash disturbance effect

### TileManager (`scene/tile-manager.js`)

- Syncs all Foundry tiles to `THREE.Sprite` objects
- **Role classification**: Ground (`elevation < foregroundElevation`), Overhead, Roof (overhead + `overheadIsRoof` flag)
- **Layer assignment**: Roof tiles added to Three.js Layer 20 for occlusion pre-pass
- **Per-tile flags**: `bypassEffects`, `cloudShadowsEnabled`, `cloudTopsEnabled`
- Animated tile support, specular effect wiring, water occluder routing

### InteractionManager (`scene/interaction-manager.js`)

Handles all Three.js canvas input (287KB — the largest single file):
- **Token interaction**: Select, multi-select (drag box), drag-move with grid snapping, wall collision ("fall back" to last valid grid space)
- **Wall drawing**: Click-to-place endpoints with half-grid snapping (resolution=2)
- **Light placement**: Drag-to-create with preview ring, radius calculation from drag distance
- **Wall endpoint dragging**: Move wall vertices with snapping
- **Right-click**: Opens Foundry Token HUD (projects Three.js position to screen CSS)
- **Selection box**: Custom GPU-rendered selection rectangle with presets
- **Keyboard**: Delete selected objects, Escape to deselect, Shift modifiers

### Other Managers

- **WallManager** — Wall segment visualization, selection, highlight states
- **DoorMeshManager** — Animated door open/close graphics
- **GridRenderer** — Square and hex grid rendering, cached to texture, per-frame updatable
- **DrawingManager** — Freehand drawing visualization
- **NoteManager** — Map note/pin icons
- **TemplateManager** — Measurement template shapes
- **LightIconManager** / **EnhancedLightIconManager** — Light source gizmos with cookie preview
- **MapPointsManager** — V1.x backwards-compatible map point groups (fire, candle, flies, lightning locations)
- **PhysicsRopeManager** — Rope and chain physics simulation from map point rope configurations

---

## 10. Foundry Integration Layer

### Hybrid Rendering Modes

The module operates in two modes, controlled by `canvas-replacement.js`:

**Gameplay Mode (Default)**:
- Three.js canvas visible, handles pointer events
- PIXI canvas transparent overlay (for Foundry's drawings, templates, notes layers)
- PIXI layers replaced by Three.js managers are hidden
- `InputRouter` dynamically enables PIXI input only when Foundry edit tools are active

**Map Maker Mode (Editing)**:
- Three.js canvas hidden (`opacity: 0`, `pointer-events: none`)
- PIXI canvas fully visible and interactive
- All PIXI layers restored to visible
- Full access to Foundry's native editing tools

### Camera System

- `UnifiedCameraController` / `CameraFollower`: PIXI is the authority for camera state
- Every frame: Read PIXI `stage.pivot` + zoom → convert to Three.js coordinates → apply
- `PixiInputBridge`: Pan/zoom gestures on Three canvas forwarded to PIXI stage
- FOV-based zoom: `camera.fov = baseFov / zoomLevel`, camera stays at fixed Z
- `sceneComposer.currentZoom` is the authoritative zoom value for all effects

### FrameCoordinator (`core/frame-coordinator.js`)

Solves the fundamental dual-renderer sync problem:
- Hooks into Foundry's PIXI ticker at low priority (runs AFTER Foundry updates)
- Ensures vision masks, fog textures, and token positions are fresh before Three.js renders
- Provides `onPostPixi(callback)` for effects that need post-PIXI texture sampling
- Forces PIXI render flush before texture extraction

### ControlsIntegration (`foundry/controls-integration.js`)

Orchestrates Foundry's native tool support:
- `LayerVisibilityManager` — Controls which PIXI layers are visible per mode
- `InputRouter` — Switches pointer events between Three and PIXI canvases
- `CameraSync` — Legacy camera sync (superseded by CameraFollower)
- Hooks Foundry's `renderSceneControls` to detect tool changes

---

## 11. Settings System

### Three-Tier Hierarchy

1. **Map Maker** — Baseline settings saved to scene flags (distributed with the map)
2. **GM** — Can tweak any setting, overrides saved to scene flags (can revert to Map Maker defaults)
3. **Player** — Final say, overrides saved client-local (not distributed), can only reduce intensity

### Scene Opt-In

Map Shine is enabled per-scene via `scene.flags['map-shine-advanced'].enabled = true`. Scenes without this flag use Foundry's native PIXI rendering unchanged.

### Graphics Settings (Essential Feature)

Per-client settings allowing players/GMs to:
- **Disable** any effect entirely (toggle)
- **Reduce** intensity (0-1 multiplier, never increase above Map Maker baseline)
- **Lazy initialization**: Disabled effects skip shader compilation during loading
- Persisted to `localStorage` keyed by scene+user
- Accessible via dedicated Foundry toolbar button

---

## 12. UI System

### TweakpaneManager (`ui/tweakpane-manager.js`)

The main GM configuration interface (184KB):
- Registers all effect parameter panels with live preview
- Supports presets, import/export, reset to defaults
- Effect folders with status indicators (green/red/grey dots)
- UI scale control with debounced update to prevent feedback loops
- Settings persisted to scene flags

### ControlPanelManager (`ui/control-panel-manager.js`)

Quick-access controls for live game sessions:
- Time of day slider with transition support
- Weather preset selector with smooth transitions
- Dynamic weather toggle with evolution speed
- Wind direction/speed controls
- State saved to scene flags and replicated to all clients via `updateScene` hook

### Loading Overlay (`ui/loading-overlay.js`)

Cinematic loading experience:
- Black overlay shown immediately on module init
- Staged progress bar (asset discovery → texture loading → effects → scene sync → finalize)
- Auto-progress animation between stages
- 5-second fade-in reveal when scene is fully rendered
- Scene transition: fade-to-black before teardown, loading screen during rebuild

### StateApplier (`ui/state-applier.js`)

Centralized utility for applying time/weather state changes:
- Ensures consistency between Configuration Panel and Control Panel
- Handles time-of-day transitions (gradual darkness changes)
- Debounced Foundry darkness updates

---

## 13. Performance Architecture

### Render Loop Optimization
- **Idle throttling**: Static scenes render at 15fps; motion or animated effects trigger full-rate RAF
- **Camera motion detection**: Reads PIXI pivot/zoom (1-frame latency free) to detect panning
- **Continuous render flag**: Effects with `requiresContinuousRender = true` bypass idle throttling

### GPU Optimization
- **FloatType buffers**: HDR throughout the post-processing chain (no 8-bit quantization)
- **Half-resolution rendering**: OverheadShadowsEffect at 50% res (75% fill rate savings)
- **World-space caching**: BuildingShadowsEffect bakes raymarching to 2048² texture, re-renders only on time/param change
- **Lazy effect initialization**: Disabled effects skip shader compilation, initialized on demand
- **Parallel effect init**: Concurrency=4 to balance GPU driver contention vs speed

### CPU Optimization
- **Object pooling**: VisionPolygonComputer, WeatherParticles, FireSparksEffect all reuse objects in hot paths
- **Throttled vision updates**: 10 updates/sec max (100ms throttle), bypassed for wall/token changes
- **No per-frame allocations**: Cached Vector3/Vector2/Matrix4 in all update loops
- **Spawn-time tagging**: Particles tagged at birth (indoor/outdoor) to avoid per-frame mask lookups
- **Multi-point aggregation**: Map points consolidated into 1-2 particle systems instead of N

### Asset Optimization
- **Texture policies**: Standardized configs (ALBEDO, DATA_MASK, LOOKUP_MAP, NORMAL_MAP, RENDER_TARGET) prevent misconfiguration
- **Semaphore-limited loading**: Max 4 concurrent texture loads to prevent GPU/network stalls
- **Asset caching**: Loaded bundles cached by path; critical masks validated on cache hit
- **Foundry texture sharing**: Fog exploration texture shared via WebGL handle (zero pixel copying)

---

## 14. Key Architectural Decisions

| Decision | Rationale |
|---|---|
| **Full canvas replacement** (not overlay) | Complete control over lighting, fog, render pipeline. No PIXI→Three.js texture conversion overhead. |
| **PerspectiveCamera with FOV zoom** | Fixed Z prevents depth buffer issues. FOV zoom preserves 3D parallax for particles. |
| **Server-authoritative token movement** | Eliminates desync from optimistic updates conflicting with hook-driven animation. |
| **Suffix-based assets** (not glTF) | Zero-config for map creators. 2.5D doesn't need 3D meshes. Full shader control. |
| **Screen-space lighting** (not additive overlay) | `Albedo × Light` matches Foundry's pipeline. Correct darkness, no "foggy" additive artifacts. |
| **World-space fog mesh** (not post-process) | Eliminates coordinate conversion issues. Camera-independent. Simpler shader. |
| **PIXI as camera authority** | One source of truth. Three.js follows PIXI each frame. Eliminates bidirectional sync races. |
| **Lookup Map for fire particles** | Deterministic placement from mask scan. No per-frame rejection sampling. O(1) per particle. |
| **Centralized TimeManager** | Synchronized animations, global pause, time scaling, testability. |
| **Three-tier settings** | Map creators set baselines, GMs tweak for their game, players control their own performance. |

---

## 15. Global State (`window.MapShine`)

All major systems are exposed on `window.MapShine` for debugging and inter-module communication:

```javascript
window.MapShine = {
  // Core
  renderer,           // THREE.WebGLRenderer
  sceneComposer,      // SceneComposer (scene, camera, base plane)
  effectComposer,     // EffectComposer (effects, render targets, time)
  renderLoop,         // RenderLoop (RAF control)
  timeManager,        // TimeManager (elapsed, delta, pause)
  weatherController,  // WeatherController (precipitation, wind, clouds)
  
  // Managers
  tokenManager, tileManager, wallManager, doorMeshManager,
  gridRenderer, interactionManager, mapPointsManager,
  physicsRopeManager, surfaceRegistry,
  
  // Effects (all individually accessible)
  lightingEffect, fogEffect, specularEffect, bloomEffect,
  cloudEffect, waterEffect, distortionManager, /* ...etc */
  
  // UI
  uiManager,          // TweakpaneManager
  controlPanel,       // ControlPanelManager
  graphicsSettings,   // GraphicsSettingsManager
  lightEditor,        // LightEditorTweakpane
  stateApplier,       // StateApplier
  
  // Integration
  cameraFollower, pixiInputBridge, controlsIntegration,
  frameCoordinator, maskManager,
  
  // Utilities
  sceneDebug, enhancedLights,
  setMapMakerMode, resetScene, isMapMakerMode
};
```

---

## 16. Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| Three.js | r170 | 3D rendering engine (vendored, custom build) |
| three.quarks | bundled | GPU particle system engine |
| Tweakpane | loaded at runtime | Configuration UI panels |
| Playwright | dev only | Performance benchmarking |
| esbuild | dev only | Build tooling |

**No CDN dependencies.** All runtime libraries are vendored locally for offline/air-gapped use.

---

## 17. Compatibility Notes

- **Foundry v13** only (verified and tested)
- **Game system agnostic**: `GameSystemManager` handles PF2e vision differences, D&D 5e defaults, etc.
- **Module conflicts**: Modules that directly manipulate Foundry's PIXI canvas layers will not work in Gameplay mode (they work in Map Maker mode)
- **Performance**: Requires WebGL2 minimum. WebGPU preferred for best performance.
- **Scene opt-in**: Only affects scenes explicitly enabled — other scenes use Foundry normally
