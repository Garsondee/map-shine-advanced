# V2 Effect Integration Plan

## Strategy

Reintroduce effects one at a time into the V2 compositor. Each effect must:

1. Work correctly on **all floors** — a ground-floor effect must not bleed into the
   upper floor, and vice versa.
2. Be **visually correct** when switching between floors via Levels.
3. Live in `scripts/compositor-v2/effects/` as a clean V2 implementation (not a copy
   of the V1 class with patches).
4. Be validated before the next effect is started.

### Per-floor isolation rule

The V1 system used `camera.layers.mask` + per-floor render passes to isolate effects.
V2 uses a single scene with Z-ordered meshes. For per-floor effects, we need to ensure
that mask textures and overlay meshes are **floor-scoped** — each floor gets its own
mask (composited from that floor's tiles only) and its own overlay geometry.

Effects that are screen-space post-processing (e.g. color correction, bloom) operate on
the final composited image and are inherently floor-agnostic — no isolation needed.

### Infrastructure that effects will need

As effects are added, we'll incrementally introduce:

- **Render targets** — when an effect needs to read the albedo as a texture input
  (e.g. lighting, water). Not pre-allocated; added when first needed.
- **Mask loading** — per-floor mask textures loaded from scene assets. V2 will load
  masks independently via `THREE.TextureLoader` (same approach as albedo tiles),
  NOT through the V1 `EffectMaskRegistry` or `GpuSceneMaskCompositor`.
- **Time uniforms** — for animated effects (water ripples, fire flicker, etc.).
- **Fullscreen quad** — for post-processing effects that sample the scene RT.

---

## Complete Effect Inventory

### Phase 1 — Priority Effects (present in test scene)

| # | Effect | V1 Layer | V1 floorScope | Mask(s) | Type | Notes |
|---|--------|----------|---------------|---------|------|-------|
| 1 | **Specular** | MATERIAL | floor | `_Specular`, `_Roughness`, `_Normal` | Per-tile overlay mesh | PBR highlights. Per-floor masks via bindFloorMasks. |
| 2 | **Fire Sparks** | PARTICLES | floor | `_Fire` | Particle system | Position map built from mask. Dependent effect (constructed separately). |
| 3 | **Window Lights** | SURFACE_EFFECTS | floor | `_Windows` | Per-tile overlay mesh | Emissive glow on windows. Per-floor masks. |
| 4 | **Water** | POST_PROCESSING | floor | `_Water` | Screen-space post | Tint, caustics, ripples. Reads scene RT + water depth mask. |

### Phase 2 — Remaining Mask-Driven Effects

| # | Effect | V1 Layer | V1 floorScope | Mask(s) | Type |
|---|--------|----------|---------------|---------|------|
| 5 | Iridescence | SURFACE_EFFECTS | floor | `_Iridescence` | Per-tile overlay mesh |
| 6 | Fluid | SURFACE_EFFECTS | floor | `_Fluid` | Per-tile overlay mesh |
| 7 | Prism | SURFACE_EFFECTS | floor | `_Prism` | Per-tile overlay mesh |
| 8 | Bushes | SURFACE_EFFECTS | floor | `_Bush` | Per-tile animated overlay |
| 9 | Trees | SURFACE_EFFECTS | floor | `_Tree` | Per-tile animated overlay |
| 10 | Overhead Shadows | ENVIRONMENTAL | floor | `_Outdoors` | Shadow map generation |
| 11 | Building Shadows | ENVIRONMENTAL | floor | `_Outdoors` | Shadow map generation |

### Phase 3 — Particle Systems

| # | Effect | V1 Layer | V1 floorScope | Mask(s) | Type |
|---|--------|----------|---------------|---------|------|
| 12 | Smoke (Particle System) | PARTICLES | floor | `_Fire` | GPU particles (dependent on Fire) |
| 13 | Dust Motes | PARTICLES | floor | `_Dust` | GPU particles |
| 14 | Ash Disturbance | PARTICLES | floor | `_Ash` | GPU particles |
| 15 | Smelly Flies | PARTICLES | floor | — | GPU particles |
| 16 | Candle Flames | ENVIRONMENTAL | global | — | Light position-driven particles |

### Phase 4 — Lighting & Environmental

| # | Effect | V1 Layer | V1 floorScope | Mask(s) | Type |
|---|--------|----------|---------------|---------|------|
| 17 | Lighting | POST_PROCESSING | floor | (composites from others) | Screen-space multiply/overlay |
| 18 | Player Lights | ENVIRONMENTAL | global | — | Flashlight/torch meshes |
| 19 | Sky Color | POST_PROCESSING | global | — | Screen-space tint |
| 20 | Clouds | ENVIRONMENTAL | global | `_Outdoors` | Animated overlay |
| 21 | Lightning | ENVIRONMENTAL | global | — | Flash overlay |
| 22 | Fog | ENVIRONMENTAL | global | `_Outdoors` | World-space overlay plane |
| 23 | Atmospheric Fog | ENVIRONMENTAL | global | — | Screen-space depth fog |

### Phase 5 — Screen-Space Post-Processing

| # | Effect | V1 Layer | V1 floorScope | Type |
|---|--------|----------|---------------|------|
| 24 | Bloom | POST_PROCESSING | floor | Bright-pass + blur |
| 25 | Distortion | POST_PROCESSING | floor | UV offset from masks |
| 26 | Color Correction | POST_PROCESSING | global | LUT / curves |
| 27 | Film Grain | POST_PROCESSING | global | Noise overlay |
| 28 | Sharpen | POST_PROCESSING | global | Convolution |
| 29 | Lensflare | SURFACE_EFFECTS | global | Light position quads |
| 30 | Vision Mode | POST_PROCESSING | global | Token vision filter |
| 31 | Dazzle Overlay | POST_PROCESSING | global | Full-screen grade |

### Phase 6 — Debug / Niche

| # | Effect | V1 Layer | V1 floorScope | Type |
|---|--------|----------|---------------|------|
| 32 | Dot Screen | POST_PROCESSING | global | Artistic filter |
| 33 | Halftone | POST_PROCESSING | global | Artistic filter |
| 34 | ASCII | POST_PROCESSING | global | Artistic filter |
| 35 | Mask Debug | POST_PROCESSING | global | Dev overlay |
| 36 | Debug Layers | ENVIRONMENTAL | global | Dev overlay |

---

## Phase 1 Detail — Priority Effects

### Step 1: Specular Effect ✅ IMPLEMENTED

**What it does:** Renders PBR-style specular highlights on tile surfaces using
`_Specular` (intensity), `_Roughness` (surface roughness), and `_Normal` (surface
detail) mask textures.

**V2 implementation:**

Files:
- `compositor-v2/effects/specular-shader.js` — GLSL vertex + fragment shaders
- `compositor-v2/effects/SpecularEffectV2.js` — Effect class (overlay management,
  mask loading, uniform sync, light tracking)
- `compositor-v2/FloorRenderBus.js` — Added `addEffectOverlay()` / `removeEffectOverlay()` API
- `compositor-v2/FloorCompositor.js` — Wired into initialize/render/dispose lifecycle

Architecture:
1. Per-tile overlay meshes with `AdditiveBlending` sit at Z+0.1 above their albedo tile.
2. Masks loaded directly via `probeMaskFile()` + `THREE.TextureLoader` (no EffectMaskRegistry).
3. Shared uniforms: all overlay materials reference the SAME uniform value objects —
   updating one value propagates to all overlays with zero per-material loop cost.
4. Floor isolation handled entirely by `FloorRenderBus.setVisibleFloors()` — overlay
   meshes registered with the bus via `addEffectOverlay()` and automatically hidden/shown.
5. No floor-presence gate, no depth-pass occlusion, no dual-pass occluder/color meshes.

V1 features preserved:
- Multi-layer animated stripes with parallax, waviness, gaps, softness
- Micro sparkles
- Wet surface (rain) specular derived from albedo grayscale + input/output CC
- Frost/ice glaze on frozen outdoor surfaces
- Outdoor cloud specular (cloud shadow map driven)
- Dynamic light falloff and color tinting (64 lights)
- Building shadow suppression
- Wind-driven ripple on wet surfaces
- Reinhard-Jodie tone mapping
- World-space pattern coordinates for seamless cross-tile patterns

**Validation:**
- [x] Specular highlights visible on ground floor tiles
- [x] Specular highlights visible on upper floor tiles
- [x] Switching floors hides/shows correct specular overlays
- [x] No specular from floor N bleeding onto floor M
- [x] Performance: no per-frame mask rebinding overhead

---

### Step 2: Fire Sparks Effect ✅ IMPLEMENTED

**What it does:** GPU particle system that spawns fire sparks, embers, and smoke from
areas marked by the `_Fire` mask. Uses three.quarks `BatchedRenderer` for efficient
GPU-instanced billboard rendering.

**V2 implementation:**

Files:
- `compositor-v2/effects/fire-behaviors.js` — Extracted behavior classes (FlameLifecycleBehavior,
  EmberLifecycleBehavior, SmokeLifecycleBehavior, FireSpinBehavior, FireMaskShape,
  ParticleTimeScaledBehavior) + gradient data + `generateFirePoints()` CPU mask scanner
- `compositor-v2/effects/FireEffectV2.js` — Effect class managing per-floor particle system
  sets, BatchedRenderer, mask discovery, floor switching
- `compositor-v2/FloorCompositor.js` — Wired into initialize/populate/update/dispose lifecycle

Architecture:
1. Per-tile `_Fire` mask discovery via `probeMaskFile()` + image loading.
2. CPU mask scanning (`generateFirePoints()`) produces (u, v, brightness) Float32Arrays.
3. Points merged per floor, spatially bucketed (2000px), each bucket → fire + ember + smoke systems.
4. `BatchedRenderer` added to bus scene via `addEffectOverlay()` — renders in same pass.
5. Floor isolation: system swapping — all floors `<= maxFloorIndex` have their systems
   in the BatchedRenderer; others are removed. Differential activation on floor change.
6. No EffectMaskRegistry, no GpuSceneMaskCompositor, no bindFloorMasks.

V1 features preserved:
- FlameLifecycleBehavior: temperature-driven blackbody gradients (cold/standard/hot), HDR emission
- EmberLifecycleBehavior: cooling color + emission curves
- SmokeLifecycleBehavior: warm/cool color blend, 3-point alpha envelope, size growth
- SmartWindBehavior: per-particle indoor/outdoor wind response
- FireSpinBehavior: random sprite rotation
- Weather guttering: rain + wind kills exposed fire
- Indoor life/time scaling
- Spatial bucketing for culling efficiency

**Validation:**
- [ ] Fire particles visible on ground floor
- [ ] Fire particles visible on upper floors
- [ ] Switching floors shows/hides fire correctly
- [ ] No fire from floor N appearing on floor M
- [ ] Particle animation runs smoothly

---

### Step 3: Window Light Effect

**What it does:** Emissive glow overlay on window areas using the `_Windows` mask.
Per-tile overlay meshes with additive blending that simulate interior light spilling
through windows. Intensity can be animated (day/night cycle).

**V1 coupling points:**
- `_Windows` mask from `EffectMaskRegistry`
- Per-tile overlay mesh creation via `TileEffectBindingManager`
- `bindFloorMasks()` for per-floor window mask swap

**V2 approach:**
1. Load `_Windows` mask via `THREE.TextureLoader`.
2. Create window light overlay meshes in the bus scene at same position as tiles,
   slightly higher Z (above albedo, below upper floor).
3. Additive or screen blending for the glow.
4. Per-floor: each floor's tiles get their own window mask.

**Infrastructure needed:**
- Mask texture loader (shared)
- Overlay mesh factory (reusable pattern for Specular/WindowLight/Iridescence)

**Validation:**
- [ ] Window glow visible on ground floor windows
- [ ] Window glow visible on upper floor windows
- [ ] No window glow bleed between floors
- [ ] Switching floors shows/hides window glow correctly

---

### Step 4: Water Effect

**What it does:** Screen-space post-processing effect that applies water tint,
caustic patterns, and ripple distortion to areas marked by the `_Water` depth mask.
Reads the rendered scene as input, outputs modified scene with water overlay.

**V1 coupling points:**
- `_Water` mask from `EffectMaskRegistry` (depth data texture)
- `WaterSurfaceModel` builds SDF from mask for caustic generation
- Screen-space post-processing (reads scene RT, writes to output RT)
- `DistortionManager` integration for ripple UV offsets
- `bindFloorMasks()` for per-floor water mask swap

**V2 approach:**
1. Load `_Water` mask via `THREE.TextureLoader`.
2. This is the first effect that requires **render targets**: the albedo scene must be
   rendered to an RT first, then the water post-process reads it and writes to screen.
3. Add RT allocation to `FloorCompositor.initialize()` (scene RT + post RT).
4. Modify `FloorCompositor.render()`: render bus → scene RT, then water post → screen.
5. Per-floor: water mask is floor-specific. Water tint only applied where that floor's
   water mask has data.

**Infrastructure needed:**
- Scene render target (first RT introduction since Milestone 1 stripped them)
- Fullscreen quad + ortho camera for post-processing passes
- Water shader (simplified V2 version — start with tint + caustics, add distortion later)
- Per-floor water mask compositing

**Validation:**
- [ ] Water tint visible on water areas
- [ ] Water only on correct floor (no ground-floor water bleeding to upper floor)
- [ ] Caustic animation runs
- [ ] No visual artifacts from RT pipeline introduction
- [ ] Camera pan/zoom still works after RT changes

---

## Shared Infrastructure Components

These will be built incrementally as effects need them:

### 1. MaskTextureLoader
- Discovers and loads `_Suffix` mask textures from the scene asset path.
- Uses `THREE.TextureLoader` (straight alpha, no canvas 2D).
- Caches loaded textures to avoid duplicate loads.
- Returns null gracefully if a mask doesn't exist for a scene.
- **Needed by:** Specular (Step 1), Fire (Step 2), Window Lights (Step 3), Water (Step 4),
  and nearly every subsequent effect.

### 2. OverlayMeshFactory
- Creates overlay meshes at the same world position/size as a tile mesh, with a
  configurable Z offset and custom material.
- Handles floor visibility integration (mesh.visible toggled by setVisibleFloors).
- **Needed by:** Specular (Step 1), Window Lights (Step 3), Iridescence, Fluid, etc.

### 3. PostProcessingPipeline
- Scene RT allocation and management.
- Fullscreen quad rendering utility.
- Ping-pong buffer management for multi-pass effects.
- **Needed by:** Water (Step 4), Lighting, Bloom, Distortion, Color Correction, etc.

### 4. TimeUniformProvider
- Exposes `uTime`, `uDeltaTime` for animated effects.
- Single source of truth, updated once per frame in `FloorCompositor.render()`.
- **Needed by:** Fire (Step 2), Water (Step 4), and all animated effects.

---

## Per-Floor Mask Strategy

V1 uses `GpuSceneMaskCompositor` to composite per-floor masks from individual tile
masks at 8192×8192. This is expensive and tightly coupled.

**V2 approach — start simple, optimize later:**

1. **Per-tile masks:** Each tile's mask texture is loaded independently. Overlay meshes
   are created per-tile with the mask as a texture input. The per-tile UV mapping handles
   spatial isolation automatically — no full-scene mask compositing needed.

2. **Floor isolation via Z-order + visibility:** Overlay meshes are Z-ordered by floor
   (same as albedo tiles). `setVisibleFloors()` hides upper-floor overlays when viewing
   a lower floor.

3. **Composited masks (if needed later):** If an effect needs a single full-floor mask
   (e.g. Water post-processing needs to know all water areas on floor 0 in one texture),
   we'll build a lightweight V2-specific compositor. This is NOT the V1
   `GpuSceneMaskCompositor` — it would be a simple render-to-texture of all floor-N
   mask tiles into one RT.

---

## Risk Log

| Risk | Mitigation |
|---|---|
| Per-tile mask approach doesn't work for screen-space effects (Water) | Build lightweight per-floor mask compositor when we reach Step 4 |
| Specular shader is too coupled to V1 material system | Extract just the GLSL, build new ShaderMaterial from scratch |
| Fire position map builder has V1 dependencies | Extract CPU scan logic into standalone utility |
| RT introduction (Step 4) breaks camera/renderer state | Use same save/restore pattern proven in FloorRenderBus.renderToScreen |
| Too many draw calls from per-tile overlays | Merge into instanced mesh or texture atlas if profiling shows issues |

---

## Progress Tracker

| Step | Effect | Status | Date |
|---|---|---|---|
| 0 | Albedo baseline (Milestone 1) | ✅ Complete | 2025-02-23 |
| 1 | Specular | ⬜ Not started | |
| 2 | Fire Sparks | ⬜ Not started | |
| 3 | Window Lights | ⬜ Not started | |
| 4 | Water | ⬜ Not started | |
| 5+ | Remaining effects | ⬜ Not started | |
