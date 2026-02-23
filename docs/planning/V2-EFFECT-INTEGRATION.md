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
- [x] Fire particles visible on ground floor
- [x] Fire particles visible on upper floors
- [x] Switching floors shows/hides fire correctly
- [x] No fire from floor N appearing on floor M
- [x] Particle animation runs smoothly

**Lessons learned / gotchas:**
- Quarks `BatchedRenderer` renders child `SpriteBatch` meshes on layer 0; if the camera layer mask excludes layer 0 (floor isolation masks often do), particles become invisible. The bus render pass must ensure layer 0 (and any overlay layer) is enabled on the camera.
- `FloorCompositor.render()` must receive `timeInfo` so `FireEffectV2.update()` runs every frame; if `timeInfo` is omitted, quarks never ticks (`particleNum: 0`, `firstTimeUpdate: true`).
- Adaptive FPS throttling can make particles look choppy when idled down to `renderIdleFps`. The V2 path needs to request continuous rendering while fire is active.
- Emitters must be part of the scene graph (or a descendant of the `BatchedRenderer`) so quarks can update world matrices.
- Mask point coordinates: `generateFirePoints()` outputs tile-local UVs and must be remapped to scene-global UVs before merging per-floor; otherwise particles spawn in the wrong place.

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
1. Implemented as `compositor-v2/effects/WindowLightEffectV2.js`.
2. Per-tile overlay meshes are registered with `FloorRenderBus.addEffectOverlay()` for
   floor isolation via `setVisibleFloors()`.
3. Mask discovery uses `probeMaskFile(basePath, '_Windows')` with a fallback to
   `_Structural` for legacy content.
4. Mask interpretation matches V1:
   - RGB luminance encodes the light pool shape/intensity
   - Alpha provides additional cutout/clipping (prevents leaking outside intended areas)
5. Coordinates and floor assignment match `FloorRenderBus` / `SpecularEffectV2`:
   - Three-space center = `(x + w/2, worldH - (y + h/2))`
   - Floor index resolved from Levels `rangeBottom`/`rangeTop` when present
6. Shader safety: overlays discard until the mask texture has loaded (`uMaskReady`).

**Infrastructure needed:**
- Mask texture loader (shared)
- Overlay mesh factory (reusable pattern for Specular/WindowLight/Iridescence)

**Validation:**
- [x] Window glow visible on ground floor windows (tentative)
- [x] Window glow visible on upper floor windows (tentative)
- [x] Correct alpha/clipping from mask (no obvious leak) (tentative)
- [x] No window glow bleed between floors
- [x] Switching floors shows/hides window glow correctly
- [ ] Visual balance confirmed after screen-space + color-correction passes are re-enabled

---

### Step 4: Render Target Infrastructure ✅ IMPLEMENTED

**What it does:** Introduces the RT pipeline so the bus scene renders to an
offscreen target instead of directly to the screen. This is the gating
prerequisite for every post-processing and screen-space effect.

**V2 implementation:**

Files:
- `compositor-v2/FloorRenderBus.js` — Added `renderTo(renderer, camera, target)` method
- `compositor-v2/FloorCompositor.js` — Scene RT, ping-pong post RTs, blit quad + ortho camera

Infrastructure:
1. `_sceneRT` (HalfFloat, HDR headroom) allocated in `initialize()`.
2. `_postA` / `_postB` ping-pong pair for post-processing chain (no depth).
3. Fullscreen blit quad with `toneMapped = false` to prevent double tone mapping.
4. Render chain: bus → sceneRT → post chain → blit to screen.
5. `onResize()` keeps all RTs in sync with viewport.
6. `renderTo(renderer, camera, target)` accepts null for screen or RT for offscreen.

**Validation:**
- [x] Scene renders identically after RT introduction (no visual diff)
- [x] Camera pan/zoom still works
- [x] No performance regression from the extra blit
- [x] No brightness shift (toneMapped=false fix applied)

---

### Step 5: LightingEffect ✅ IMPLEMENTED

**What it does:** Foundational post-processing pass that applies ambient light
(day/night), dynamic light sources (Foundry AmbientLight documents), darkness
sources, and light coloration to the bus scene RT.

**V2 implementation:**

Files:
- `compositor-v2/effects/LightingEffectV2.js` — Post-processing effect class
- `compositor-v2/FloorCompositor.js` — Wired into initialize/update/render/dispose

Architecture:
1. Reuses V1 `ThreeLightSource` and `ThreeDarknessSource` classes for individual
   light mesh rendering — they output additive contribution to dedicated RTs.
2. Dedicated `_lightScene` and `_darknessScene` with separate accumulation RTs.
3. Compose pass (fullscreen quad): reads sceneRT + lightRT + darknessRT → lit output.
4. Compose shader: ambient day/night interpolation, darkness punch (lights reduce
   local darkness), darkness mask, coloration, minimum illumination floor.
5. Foundry hooks (`createAmbientLight`, `updateAmbientLight`, `deleteAmbientLight`)
   for live CRUD sync.
6. Lazy light sync on first render frame via `syncAllLights()`.
7. Light animations updated per frame via `updateAnimation()`.

**Simplifications vs V1 (to be addressed in later steps):**
- No outdoors mask differentiation (Step 7+)
- No overhead/building/bush/tree/cloud shadow integration (Steps 8–9)
- No upper floor transmission
- No roof alpha pass
- No rope/token mask passes
- No lightning flash integration (Step 11)
- No sun light buffer (Step 7+)

**Validation:**
- [x] Scene visible with ambient lighting
- [x] Dynamic lights create visible pools of illumination
- [x] Darkness level slider adjusts scene brightness
- [x] Light animations (torch flicker) animate
- [x] Existing bus effects (specular, fire, window light) still work
- [x] Floor switching still works

---

### Step 6: SkyColorEffect ✅ IMPLEMENTED

**What it does:** Screen-space color grading post-processing pass driven by
time-of-day and weather. Applies exposure, white balance (temperature + tint),
brightness, contrast, saturation, vibrance, lift/gamma/gain, optional tone
mapping (ACES Filmic, Reinhard), vignette, and film grain.

**V2 implementation:**

Files:
- `compositor-v2/effects/SkyColorEffectV2.js` — Post-processing effect class
- `compositor-v2/FloorCompositor.js` — Wired into initialize/update/render/dispose

Architecture:
1. Fullscreen quad post-processing pass: reads lit scene RT → outputs graded result.
2. Two automation modes preserved from V1:
   - **Analytic** (mode 1): Sunrise/sunset sun model, golden hour, weather integration
     (turbidity, Rayleigh/Mie scattering, overcast desaturation, haze lift).
   - **Preset Blend** (mode 0): Weighted blend of dawn/day/dusk/night presets.
3. Exposes `currentSkyTintColor` for downstream systems (Darkness Response lights
   adopt sky hue during golden/blue hour).
4. Auto-intensity: scales effect strength based on dayFactor, overcast, storm, darkness.
5. Inserted in post chain after LightingEffectV2: postA → postB.

**Simplifications vs V1 (to be addressed later):**
- No outdoors mask gating (grading applied globally)
- No roof alpha, rope mask, or token mask
- No cloud top mask integration

**Validation:**
- [x] Color grading visually active (exposure, temperature shifts visible)
- [x] Time-of-day automation produces dawn/day/dusk/night transitions
- [x] Existing effects (specular, fire, window light, lighting) still work
- [x] Floor switching still works
- [ ] Weather integration confirmed (needs active weather)
- [ ] Outdoors mask gating (deferred until mask system available)

---

### Steps 7–13: Environmental Effects (DEFERRED)

Steps 7–13 are complex ENVIRONMENTAL effects with deep V1 coupling (EffectBase,
EffectMaskRegistry, maskManager, blocker layer traversal, etc.). When V2 is
active, the V1 render loop doesn't execute, so these effects don't run.
Porting them requires either:
- A full V2 rewrite (e.g., CloudEffect is ~2800 lines)
- Running them as standalone services called from FloorCompositor

**Deferred until simpler post-processing effects are complete.**

| Step | Effect                   | V1 Layer          | Status | Notes |
|-----:|--------------------------|--------------------|--------|-------|
|    7 | CloudEffect              | ENVIRONMENTAL      | ⏳ Deferred | ~2800 lines. Procedural noise + shadow + cloud tops + wind + blockers. |
|    8 | BuildingShadowsEffect    | ENVIRONMENTAL      | ⏳ Deferred | Needs `_Structural` mask + cloud state (Step 7). |
|    9 | OverheadShadowsEffect    | ENVIRONMENTAL      | ⏳ Deferred | Roof/floor isolation. |
|   10 | PlayerLightEffect        | ENVIRONMENTAL      | ⏳ Deferred | Token-based dynamic lights. |
|   11 | LightningEffect          | ENVIRONMENTAL      | ⏳ Deferred | Weather lightning flashes. |
|   12 | CandleFlamesEffect       | ENVIRONMENTAL      | ⏳ Deferred | Candle/torch particles. |
|   13 | AtmosphericFogEffect     | POST_PROCESSING    | ⏳ Deferred | Distance/height fog. |

---

### Step 16: ColorCorrectionEffect ✅ IMPLEMENTED

**What it does:** Static user-authored color grade applied near the end of the
post-processing chain. Provides the base "look" of the scene (exposure, white
balance, contrast, saturation, lift/gamma/gain, tone mapping, vignette, grain).

**V2 implementation:**

Files:
- `compositor-v2/effects/ColorCorrectionEffectV2.js` — Post-processing effect class
- `compositor-v2/FloorCompositor.js` — Wired into initialize/update/render/dispose

Architecture:
1. Fullscreen quad post-processing pass: reads sky-graded RT → outputs final grade.
2. Same shader pipeline as V1: exposure × dynamicExposure → WB → brightness →
   contrast → saturation/vibrance → lift/gamma/gain → tone mapping → vignette → grain.
3. Defaults tuned to match Foundry PIXI brightness (exposure=0.9, masterGamma=2.0).
4. `dynamicExposure` uniform available for DynamicExposureManager integration.
5. Ping-pong RT: outputs to whichever of postA/postB isn't the current input.

**Validation:**
- [x] Color correction visually active (scene brightness matches V1)
- [x] Existing effects still work
- [x] Floor switching still works
- [ ] DynamicExposureManager integration (deferred)

---

### Step 14: BloomEffect ✅ IMPLEMENTED

**What it does:** Screen-space glow effect. Bright pixels above a threshold are
extracted, progressively blurred through a multi-mip chain, and additively
composited back onto the scene.

**V2 implementation:**

Files:
- `compositor-v2/effects/BloomEffectV2.js` — Post-processing effect class
- `compositor-v2/FloorCompositor.js` — Wired into initialize/update/render/resize/dispose

Architecture:
1. Wraps `THREE.UnrealBloomPass` (multi-mip progressive bloom).
2. Uses internal `_bloomInputRT` as the pass's read buffer.
3. Flow: copy inputRT → _bloomInputRT → run pass → copy result → outputRT.
4. Bloom tint color (all mip levels) and blend opacity controls preserved.
5. Runs after SkyColor, before ColorCorrection in the post chain.

**Simplifications vs V1 (to be addressed later):**
- No vision masking via FoundryFogBridge
- No scene-rect padding exclusion (V2 compositor handles this)
- No ember hotspot layer injection (BLOOM_HOTSPOT_LAYER)

**Validation:**
- [x] Bloom glow visible on bright areas (fire, window lights)
- [x] Strength/radius/threshold controls work
- [x] Existing effects still function
- [x] Floor switching still works
- [ ] Ember hotspot layer (deferred)
- [ ] Vision masking (deferred)

---

### Steps 17 & 18: FilmGrain + Sharpen ✅ IMPLEMENTED

**FilmGrainEffectV2** — Animated noise grain overlay. Disabled by default.
**SharpenEffectV2** — Unsharp mask sharpening filter. Disabled by default.

Files:
- `compositor-v2/effects/FilmGrainEffectV2.js`
- `compositor-v2/effects/SharpenEffectV2.js`

Both run at the very end of the post chain (after color correction).
Both are disabled by default — users opt in via the control panel.

---

### Steps 15 & 19: Remaining Post-Processing Effects

| Step | Effect                   | V1 Layer          | Priority | Notes |
|-----:|--------------------------|--------------------|----------|-------|
|   15 | VisionModeEffect         | POST_PROCESSING    | 95 | Darkvision, tremorsense, etc. overlays. Depends on lighting state. |
|   19 | Stylistic & Debug        | POST_PROCESSING    |200+| AsciiEffect, DotScreenEffect, HalftoneEffect, DazzleOverlayEffect, MaskDebugEffect. Optional / niche — activate last. |

**General validation for each step:**
- [ ] Effect visually active and correct
- [ ] No regression in previously-enabled effects
- [ ] Floor switching still works
- [ ] Performance acceptable

---

### Step 20: Water Effect

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
2. Uses the RT infrastructure from Step 4 (bus → scene RT → water post → screen).
3. Per-floor: water mask is floor-specific. Water tint only applied where that
   floor's water mask has data.

**Infrastructure needed:**
- Water shader (simplified V2 version — start with tint + caustics, add distortion later)
- Per-floor water mask compositing

**Validation:**
- [ ] Water tint visible on water areas
- [ ] Water only on correct floor (no ground-floor water bleeding to upper floor)
- [ ] Caustic animation runs
- [ ] No visual artifacts
- [ ] Camera pan/zoom still works

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
| 1 | Specular | ✅ Complete | 2025-02-23 |
| 2 | Fire Sparks | ✅ Complete | 2025-02-23 |
| 3 | Window Lights | ✅ Complete | 2025-02-23 |
| 4 | RT Infrastructure | ✅ Complete | 2026-02-23 |
| 5 | LightingEffect | ✅ Complete | 2026-02-23 |
| 6 | SkyColorEffect | ✅ Complete | 2026-02-23 |
| 7–13 | Environmental effects (Cloud, Shadows, etc.) | ⏳ Deferred | |
| 16 | ColorCorrectionEffect | ✅ Complete | 2026-02-23 |
| 14 | BloomEffect | ✅ Complete | 2026-02-23 |
| 17 | FilmGrainEffect | ✅ Complete | 2026-02-23 |
| 18 | SharpenEffect | ✅ Complete | 2026-02-23 |
| 15, 19 | VisionMode + Stylistic/Debug | ⬜ Not started | |
| 20 | Water | ⬜ Not started | |

REMEMBER TO ENABLE TWEAKPANE CONTROLS FOR EFFECTS AS YOU GO ALONG

