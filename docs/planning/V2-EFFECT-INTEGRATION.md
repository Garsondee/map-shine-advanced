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

**Status update:** Cloud rendering has been brought back as `CloudEffectV2` and is
now part of the V2 post chain. The remaining environmental effects are still
deferred.

| Step | Effect                   | V1 Layer          | Status | Notes |
|-----:|--------------------------|--------------------|--------|-------|
|    7 | CloudEffect              | ENVIRONMENTAL      | ✅ Implemented | `CloudEffectV2` generates a shadow RT (fed into `LightingEffectV2`) and a cloud-top RT (alpha-over blit). |
|    8 | BuildingShadowsEffect    | ENVIRONMENTAL      | ⏳ Deferred | Needs `_Structural` mask + cloud state. |
|    9 | OverheadShadowsEffect    | ENVIRONMENTAL      | ⏳ Deferred | Roof/floor isolation. |
|   10 | PlayerLightEffect        | ENVIRONMENTAL      | ⏳ Deferred | Token-based dynamic lights. |
|   11 | LightningEffect          | ENVIRONMENTAL      | ⏳ Deferred | Weather lightning flashes. |
|   12 | CandleFlamesEffect       | ENVIRONMENTAL      | ⏳ Deferred | Candle/torch particles. |
|   13 | AtmosphericFogEffect     | POST_PROCESSING    | ⏳ Deferred | Distance/height fog. |

---

### Step 8: Building Shadows — Research & Design

> **Status:** Research complete. Implementation not yet started.

---

#### 8.1 — What V1 Does (Ground Truth)

`BuildingShadowsEffect` (`scripts/effects/BuildingShadowsEffect.js`) works as follows:

1. **Input:** A single `_Outdoors` mask texture (white = outdoor/ground, black = building/wall
   interior). This is the same texture that `OutdoorsMaskProviderV2` already composites
   per floor.

2. **Occluder definition:** Black (indoor) pixels ARE the casters. The shadow is the dark
   region that an indoor/building pixel throws onto nearby outdoor pixels by marching
   *in the sun direction* away from each outdoor pixel. If any step hits an indoor pixel,
   that outdoor pixel is shadowed.

3. **Bake pass (expensive — world-space UV, baked into a 2048×2048 RT):**
   - UV-space fullscreen quad (bakeCamera covers 0..1).
   - Fragment raymarches `uSampleCount` steps of length `t * uLength` along `uSunDir`.
   - Penumbra: `uPenumbraSamples` perpendicular taps at each step, weighted by distance.
   - Output is a greyscale shadow factor (1.0=lit, 0.0=shadowed) stored in
     `worldShadowTarget` (2048×2048, fixed resolution, reused across frames).
   - Rebakes only when sun direction / params / mask change (`needsBake` + hash check).

4. **Display pass (cheap — every frame):**
   - `shadowMesh` = the same PlaneGeometry as `baseMesh`, world-positioned, sampling
     `worldShadowTarget` via standard UV.
   - Renders to `shadowTarget` (screen-space, viewport-sized).
   - `LightingEffect` samples `shadowTarget` and multiplies it into illumination via
     `uBuildingShadowOpacity * timeIntensity`.

5. **Sun direction:**
   - `x = -sin(azimuth)`, `y = -cos(azimuth) * sunLatitude`.
   - Azimuth sweeps from −π/2 (sunrise) to +π/2 (sunset) as hour goes 0→24.
   - `timeIntensity` fades shadows near dawn/dusk and zeroes them at night.
   - Sunrise/sunset anchors come from `getFoundryTimePhaseHours()` when time is Foundry-linked.

6. **Shadow suppression from `SpecularEffect`:**
   - V1 `SpecularEffect` samples `worldShadowTarget` to suppress specular in shadow.
   - This is a pure read dependency — the shadow map is the single source of truth.

---

#### 8.2 — Multi-Floor Problem Analysis

This is the core complexity of the V2 port.

##### 8.2.1 — What "longer shadows from stacked floors" means

In a multi-floor scene, the ground floor has building walls (black) that cast short
shadows across the outdoor ground. The upper floor has *its own* set of building walls
(again, black in its `_Outdoors` mask) at a higher elevation.

In reality, a tall building casts a **longer shadow** than a short one because the sun
strikes the top of the taller structure from a lower angle. In a 2.5D top-down map, we
cannot simulate true 3D height, but we *can* approximate this:

> **Key insight:** The combined (union) of all `_Outdoors` masks up to and including the
> currently viewed floor represents the *full silhouette* of all structures visible from
> above. A shadow baked from this union mask will naturally produce longer shadows where
> upper-floor building footprints extend further than the ground-floor footprint (stacked
> wall extensions). The length multiplier can additionally scale by floor count to
> simulate elevation-contributed length.

##### 8.2.2 — Per-floor vs. combined mask: what each approach produces

| Approach | What it produces | Risk |
|---|---|---|
| **A: Only active floor mask** | Shadow from walls at exactly the viewed floor. No contribution from other floors. Short shadows. | Shadows disappear or shrink when ascending floors, even though tall buildings should cast longer shadows. |
| **B: Only floor 0 (ground) mask** | Shadow always from ground-floor structures, regardless of active floor. | Upper-floor rooftop boundaries are ignored — shadow shape doesn't update for upper-floor structures. |
| **C: Union of all floors ≤ active** | Shadow from every structure at or below the viewed floor. Naturally longer where upper stories extend the footprint. | Need a fast per-frame mask union. Bake cost scales with N floors if re-baked separately. |
| **D: Union of ALL floors regardless of active** | Longest possible shadows (full building silhouette from any viewing level). Simpler — single bake. | May be visually wrong: shadows from upper-floor walls appear on the ground floor even when player hasn't ascended. |

**Recommended approach: C (union of floors ≤ active)** with a single bake that rebuilds
when the active floor changes.

- `OutdoorsMaskProviderV2` already composites per-floor masks separately. It has a
  `getFloorTexture(floorIndex)` and `getFloorTextureArray(count)` API.
- A union composite is cheap: draw floor 0, 1, ... N mask canvases with `ctx.globalCompositeOperation = 'lighten'` (union of white/black masks). Or in a shader: `max(floor0, floor1, ..., floorN)`.
- The union mask is stored in a dedicated `_unionShadowMaskRT` and passed to the bake shader.
- When `maxFloorIndex` increases (player ascends) → recomposite union + rebake. When player descends → same.

##### 8.2.3 — Shadow receiver: which pixels *receive* the shadow

The shadow is a darkening applied to **outdoor, ground-level pixels** in the scene. In V2:

- The shadow factor texture is consumed by `LightingEffectV2` as a multiplier on
  `totalIllumination` (exactly as V1 `LightingEffect` uses `uBuildingShadowOpacity`).
- The shadow receiver is simply the screen — every pixel of the final scene image.
- Indoor pixels (inside a building) do **not** need to be excluded from the shadow because
  they are already dark from the lighting pass. The shadow multiplier darkening an already-dark
  pixel is a no-op visually.

**This means the shadow factor can be applied globally as a screen-space multiply** — no
per-pixel floor classification is needed in the shadow itself.

##### 8.2.4 — Occluder isolation: which pixels *cast* the shadow

Only outdoor→indoor *boundaries* produce shadows. A solid-black outdoor mask pixel
(building interior) casts; a solid-white pixel (open ground) casts nothing. This is
handled entirely by the V1 raymarcher shader and requires no change.

The UV space of the bake uses the mask's native UV. As long as the mask is composited
in scene UV space (which `OutdoorsMaskProviderV2` does — Foundry Y-down, 1024px canvas),
the bake shader can directly sample it. The mask UV = scene UV, which = the display mesh
UV = baked shadow UV. All three align.

##### 8.2.5 — Shadow length scale by floor

To simulate a taller building casting a longer shadow:

```glsl
// In the bake shader, after receiving uFloorCount:
float heightScale = 1.0 + (uFloorCount - 1.0) * uFloorHeightShadowScale;
float effectiveLength = uLength * heightScale;
```

- `uFloorCount` = number of floors contributing to the union (= `maxFloorIndex + 1`).
- `uFloorHeightShadowScale` = tunable param (default ~0.5: each extra floor adds 50% more length).
- This is additive, not multiplicative — avoids explosion at high floor counts.

---

#### 8.3 — V2 Architecture Design

##### 8.3.1 — How V1 is decomposed for V2

V1 has three concerns mixed together:
1. **Input acquisition** — `outdoorsMask` via `EffectMaskRegistry` or `setBaseMesh`.
2. **Bake pass** — expensive UV-space raymarcher → `worldShadowTarget` (world-space RT).
3. **Display pass** — world-pinned mesh sampling `worldShadowTarget` → `shadowTarget` (screen-space RT).

V2 can simplify this because `OutdoorsMaskProviderV2` already owns mask acquisition and
union-compositing. The V2 effect only needs items 2 and 3.

##### 8.3.2 — Proposed V2 class: `BuildingShadowsEffectV2`

**Location:** `scripts/compositor-v2/effects/BuildingShadowsEffectV2.js`

**Inputs:**
- `_outdoorsMask` provider (via `subscribe()` callback from `OutdoorsMaskProviderV2`)
- `maxFloorIndex` (from `FloorCompositor._applyCurrentFloorVisibility`)
- `weatherController.timeOfDay` and phase anchors
- `SkyColorEffectV2.currentSunAzimuthDeg` / `currentSunElevationDeg` (already exposed — use this for sun direction instead of re-computing in the shadow effect)

**Outputs:**
- `shadowFactorTexture` (a `THREE.Texture`, the greyscale 1.0=lit map) — fed into `LightingEffectV2`.

**GPU resources:**
- `_unionMaskCanvas` + `_unionMaskTexture` — 2D canvas composite of ≤N floor masks (rebuilt on floor change).
- `_bakeRT` — fixed `BAKE_SIZE × BAKE_SIZE` (e.g. 1024×1024 or 2048×2048) world-space shadow factor.
- `_bakeMaterial` — the raymarching `ShaderMaterial` (same shader as V1, no changes needed).
- `_bakeScene` / `_bakeCamera` — orthographic 0..1 bake environment.
- **No display mesh / no screen-space pass.** In V2 the shadow factor is fed directly into
  `LightingEffectV2` as a texture input (exactly like `cloudShadowTexture`). The lighting
  compose shader samples it using `vUv` (screen UV). The world-to-UV mapping is already
  handled by the bake pass (bake is in mask UV = scene UV). We **do not need** the world-pinned
  display mesh at all — that was a V1 workaround to project world-space baked data back into
  screen-space. `LightingEffectV2` renders a fullscreen quad so `vUv` is already correct.

**This is a significant simplification over V1:** no `shadowMesh`, no `shadowScene`, no
`shadowTarget` (screen-space RT). The bake RT is consumed directly.

##### 8.3.3 — Integration into LightingEffectV2

Add to `LightingEffectV2`:
- New uniform: `tBuildingShadow` + `uHasBuildingShadow` + `uBuildingShadowOpacity`.
- In the compose shader:
  ```glsl
  if (uHasBuildingShadow > 0.5) {
    float shadowFactor = texture2D(tBuildingShadow, vUv).r;
    // Shadow only dims the ambient — dynamic lights still punch through.
    ambientAfterDark *= mix(1.0, shadowFactor, uBuildingShadowOpacity);
  }
  ```
- `render()` signature gains `buildingShadowTexture` parameter (same pattern as `cloudShadowTexture`).

Wire in `FloorCompositor.render()`:
```js
const shadowTex = this._buildingShadowEffect?.shadowFactorTexture ?? null;
this._lightingEffect.render(renderer, camera, currentInput, this._postA,
  winScene, cloudShadowTex, shadowTex);
```

##### 8.3.4 — Union mask compositing

`OutdoorsMaskProviderV2.getFloorTextureArray(count)` returns `THREE.CanvasTexture[]`. To
union N floor masks cheaply on the CPU:

```js
_rebuildUnionMask(maxFloorIndex) {
  const masks = this._outdoorsMaskProvider.getFloorTextureArray(maxFloorIndex + 1);
  // ctx.globalCompositeOperation = 'lighten' = max(src, dst) per channel.
  // Floor 0 is the base (ground = all black). Each successive floor adds more white.
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i <= maxFloorIndex; i++) {
    const img = masks[i]?.image; // CanvasTexture stores the source canvas as .image
    if (!img) continue;
    ctx.globalCompositeOperation = 'lighten';
    ctx.drawImage(img, 0, 0, w, h);
  }
  this._unionMaskTexture.needsUpdate = true;
}
```

This runs only on floor change — not every frame. The union canvas is at the same
1024px resolution as the individual floor canvases. The bake RT only needs to match
the mask resolution (1024×1024 is sufficient for shadow shapes; shadows are blurry anyway).

##### 8.3.5 — Bake trigger conditions

Rebake when any of the following changes:
- `sunDir` changes (hash of `x.toFixed(3), y.toFixed(3)`)
- `params.length`, `params.quality`, penumbra params change
- `maxFloorIndex` changes (→ new union mask → new shadow shape)
- Mask texture UUID changes (content changed)

Same hash-based `lastBakeHash` / `needsBake` pattern as V1.

##### 8.3.6 — Correct UV space for multi-floor bake

The bake shader samples `tOutdoors` (the union mask) using `vUv`, which is in scene UV
space (0..1 across the scene rect, Y-down). This is exactly how `OutdoorsMaskProviderV2`
composites the mask canvas — Foundry x/y relative to `sceneRect`, Y-down, no flip.

**The bake shader needs zero changes** — it already uses UV-space `vUv` to sample the mask
and to march along `uSunDir`. As long as the union mask is in the same UV convention as the
individual floor masks (which it is, being a lighten-composite of them), the bake is correct
for any number of floors.

The bake RT's UV matches the display mesh UV (both are scene UV). `LightingEffectV2`'s
fullscreen compose quad uses `vUv` which is 0..1 in screen space. 

**Problem:** The bake UV is *scene* UV (0..1 across the scene rect). But the compose quad's
`vUv` is *screen* UV (0..1 across the entire viewport, which includes padding). These can
differ when the Foundry canvas has padding.

**Solution (same as V1's world-pinned mesh approach):** Pass the scene rect bounds as
uniforms to the compose shader so it can remap screen UV to scene UV before sampling the
shadow texture:

```glsl
// In LightingEffectV2 compose shader:
uniform vec4 uSceneBounds; // (sceneX, sceneY, sceneW, sceneH) in world pixels
uniform vec2 uCanvasSize;  // full canvas size (width, height)

// Remap screen UV to scene UV:
vec2 sceneUv = (vUv * uCanvasSize - uSceneBounds.xy) / uSceneBounds.zw;
// sceneUv.y must be flipped because scene UV is Y-down, screen UV is also Y-down (for ortho camera)
// so if both are Y-down, no flip needed.
float shadowFactor = texture2D(tBuildingShadow, clamp(sceneUv, 0.0, 1.0)).r;
```

These bounds are cheap to update once per frame (read from `canvas.dimensions`).

Alternatively (simpler): Render the bake RT at **screen resolution** (not a fixed 2048×2048)
by using the world-pinned mesh approach BUT only in the compose pass — render the shadow mesh
into a screen-sized RT using the main camera, then sample that RT in the compose. This is
what V1 `shadowTarget` does. For V2 this could be a dedicated single-pass step in
`BuildingShadowsEffectV2.render()`.

**Verdict:** The UV remapping via `uSceneBounds` is cleaner (no extra RT, no world-mesh).
The bake is at fixed 1024px; the compose samples it with clamped UV. Aliasing at the
padding boundary is not visible because the shadow is always zero outside the scene rect
(no mask content in padding → no shadow there).

---

#### 8.4 — Risk Register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| **Union mask CPU compositing is slow** on very large tile counts | Low | Medium | `ctx.drawImage` with `lighten` blend is GPU-accelerated in most browsers. Even with 8+ floors it's < 1ms. Only runs on floor change, not per-frame. |
| **Bake cost spikes on floor change** when union mask changes | Medium | Low | Bake is 1024×1024 raymarcher at 80 samples = ~83M taps. GPU handles this in <2ms. Triggered at most once per floor change, not every frame. |
| **UV mismatch between bake and screen** (padding issue) | High | High | Use `uSceneBounds` remapping in the consume shader as detailed in §8.3.6. Test with scenes that have large Foundry padding. |
| **Mask canvas `.image` property is a `<canvas>` not `<img>`** | Confirmed | Low | `THREE.CanvasTexture` stores its canvas as `.source.data` (Three r150+) or `.image`. Check both. Alternatively call `OutdoorsMaskProviderV2` to expose the raw canvas elements. |
| **Sun direction disagreement** between building shadows and specular/cloud shadow | Medium | Medium | Use `SkyColorEffectV2.currentSunAzimuthDeg` / `currentSunElevationDeg` as the single source of truth for all effects. Wire in `FloorCompositor`. |
| **Shadow on upper floor bleeds down** through transparent tile regions | Low | Medium | Not an issue: the shadow factor is applied in the lighting compose (screen-space, fullscreen quad). It dims whatever the lit scene shows at those pixels. If the upper-floor tile is transparent, those pixels already show ground-floor content — which is correct (shadow falls on the ground there). |
| **Shadow shape wrong on upper floor** because union mask includes ground-floor buildings not visible from upper floor | Medium | Medium | Acceptable artistic trade-off. The union adds "more shadow" which reads as a taller building. If it becomes noticeable, an option is to weight each floor's contribution: `shadow = max(floor0 * 0.4, floor1 * 0.7, floor2 * 1.0)` so lower floors contribute less. |
| **SpecularEffectV2 needs building shadow suppression** | High | Low | V1 SpecularEffect samples `worldShadowTarget`. V2 SpecularEffectV2 will need to receive the bake RT texture and sample it. The shared UV remap (via `uSceneBounds`) should be identical. Deferred until building shadows are working. |

---

#### 8.5 — Implementation Plan (ordered tasks)

1. **`OutdoorsMaskProviderV2`: expose raw canvas per floor.**
   Add `getFloorCanvas(floorIndex): HTMLCanvasElement|null` to expose the 2D canvas that was
   used to build each floor's `CanvasTexture`. This avoids extracting `.image` from the texture
   and gives the union compositor a direct drawing source.

2. **`BuildingShadowsEffectV2`: class stub + bake pass.**
   - Subscribe to `OutdoorsMaskProviderV2` for per-floor canvases.
   - On floor change: `_rebuildUnionMask(maxFloorIndex)` → `needsBake = true`.
   - On bake trigger: render bake scene (0..1 ortho, raymarcher shader) → `_bakeRT`.
   - Expose `get shadowFactorTexture()` returning `_bakeRT.texture`.

3. **`BuildingShadowsEffectV2`: sun direction from `SkyColorEffectV2`.**
   Accept a `setSunAngles(azimuthDeg, elevationDeg)` call from `FloorCompositor` (same
   pattern as `_waterEffect.setSunAngles()`). Compute `uSunDir` from these angles.

4. **`LightingEffectV2`: accept building shadow texture.**
   Add `tBuildingShadow` + `uHasBuildingShadow` + `uBuildingShadowOpacity` uniforms.
   Add `uSceneBounds` + `uCanvasSize` for UV remapping. Amend compose shader.

5. **`FloorCompositor`: wire both effects.**
   - Instantiate `BuildingShadowsEffectV2`.
   - In `initialize()`: subscribe it to `OutdoorsMaskProviderV2`.
   - In `_applyCurrentFloorVisibility()`: call `buildingShadowEffect.onFloorChange(maxFloorIndex)`.
   - In `render()` update loop: call `buildingShadowEffect.update(timeInfo)`.
   - In `render()` after update: pass `buildingShadowEffect.shadowFactorTexture` to `lightingEffect.render()`.
   - Feed `SkyColorEffectV2` sun angles into `buildingShadowEffect`.

6. **UV remapping validation.**
   Test with a scene with heavy Foundry padding. Verify that the shadow aligns correctly with
   building edges at all zoom levels and pan positions.

7. **SpecularEffectV2 shadow suppression (deferred).**
   Once the bake RT is stable, wire it into `SpecularEffectV2` so specular is suppressed inside
   building shadows (matches V1 `buildingShadowSuppressionEnabled` behaviour).

---

#### 8.6 — Shader Changes Summary

**Bake shader (from V1 `BuildingShadowsEffect.bakeMaterial`):**
- Add `uniform float uFloorCount` and `uniform float uFloorHeightShadowScale`.
- Scale `uLength` by `1.0 + (uFloorCount - 1.0) * uFloorHeightShadowScale` before raymarching.
- No other changes needed.

**LightingEffectV2 compose shader addition:**
```glsl
uniform sampler2D tBuildingShadow;
uniform float uHasBuildingShadow;
uniform float uBuildingShadowOpacity;
uniform vec4 uSceneBounds;   // (sceneX_px, sceneY_px, sceneW_px, sceneH_px)
uniform vec2 uCanvasSize;    // (canvasW_px, canvasH_px) 

// Inside main(), after computing ambientAfterDark:
if (uHasBuildingShadow > 0.5) {
  // Remap screen UV → scene UV (both Y-down, no flip needed for ortho compose)
  vec2 fragPx  = vUv * uCanvasSize;
  vec2 sceneUv = (fragPx - uSceneBounds.xy) / uSceneBounds.zw;
  sceneUv = clamp(sceneUv, 0.0, 1.0);
  float shadowFactor = texture2D(tBuildingShadow, sceneUv).r;
  // Apply to ambient only — dynamic lights punch through
  ambientAfterDark *= mix(1.0, shadowFactor, uBuildingShadowOpacity);
}
```

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

### Step 20: Water Effect 🔧 IN PROGRESS

**What it does:** Screen-space post-processing effect that applies water tint,
wave distortion, multi-tap refraction, chromatic aberration, specular highlights
(GGX), caustic patterns, murk (silt/algae), sand sediment, shore foam, and rain
ripples to water areas defined by `_Water` depth masks. Reads the lit scene RT as
input, outputs a modified scene with all water layers composited on top.

---

#### Current V2 Status (as of 2026-02-24)

**Working:**
- [x] `_Water` mask discovery and per-floor compositing
- [x] `WaterSurfaceModel` SDF build from mask (R=SDF, G=exposure, B/A=normals)
- [x] Per-floor water data switching on floor change (`onFloorChange`)
- [x] Water tint applied inside SDF-gated region
- [x] Wave distortion (smooth, world-locked, zoom-stable) using verbatim V1 wave math
- [x] Distortion pinned at water edges — `refractTapValid()` continuous weight scales `offsetUv → 0` near boundary
- [x] Multi-tap refraction with renormalized weights for valid taps
- [x] Chromatic aberration (RGB shift) gated by occluder + `distMask`
- [x] Per-floor occluder mask (`_waterOccluderRT`) prevents distortion/tint/CA bleeding through upper-floor geometry
- [x] Sand layer (`USE_SAND` define)
- [x] Foam layer (shader-computed `getFoamBaseAmount` + `getShaderFlecks`)
- [x] Murk (`applyMurk` with wind-driven grain)
- [x] Rain ripples (`computeRainOffsetPx`)
- [x] `uTime` / `uWindTime` driven from `performance.now()` for smooth 120fps animation

---

#### Missing System Connections (critical for correct appearance)

The following V1 integrations exist in the shader and `WaterEffectV2.js` but are
**not yet wired into `FloorCompositor`** or their source systems. Each has a
dedicated section below.

---

##### 20a. Specular GGX — Partially Broken

**Symptom:** Specular highlights barely visible, no bright reflections on water surface.

**Root cause analysis:**
The GGX specular chain in the shader is:
```
spec = BRDF(N, L, V) * NoL
spec *= specMask               ← pow(distInside, specMaskGamma)
spec *= shoreBias               ← mix(1, shore, specShoreBias)
spec *= strength * sunIntensity
spec *= mix(1.0, 0.05, uSceneDarkness)
col += spec * skyCol * skySpecI ← skySpecI = mix(0.08, 1.0, uSkyIntensity)
```

**Known issues:**
1. **`uSkyColor` is hardcoded** — `vec3(0.5, 0.6, 0.8)` in `_buildUniforms`, never
   updated from `SkyColorEffectV2.currentSkyTintColor`. Sky tint mismatch kills the
   final spec multiply.
2. **`uSkyIntensity` was unbounded** — fixed in current session (now bound from
   `params.skyIntensity`), but still not fed from the actual sky system.
3. **`specMask = pow(distInside, specMaskGamma)`** — `distInside` is the SDF-gated
   inside metric. If the SDF is built but shallow, `distInside` is low everywhere
   and crushes spec. `specMaskGamma` default lowered to 0.5 to mitigate.
4. **Sun direction** is static (azimuth/elevation from params, not from a live sun
   position system). This is acceptable for now.

**Fix required:**
- Wire `SkyColorEffectV2.currentSkyTintColor` → `u.uSkyColor` in
  `FloorCompositor.render()` or `WaterEffectV2.update()`.
- Wire `SkyColorEffectV2.skyIntensity` (or a proxy) → `u.uSkyIntensity`.

---

##### 20b. Caustics — Look Grey, Not Like Light

**Symptom:** Caustic patterns visible but appear as grey smears instead of bright
warm-white light filaments.

**Root cause analysis:**
Caustics are correctly additive (`col += causticsColor * c * causticsAmt * 1.35`)
so the blending is right. The problem is that the scene has already passed through:
1. `LightingEffectV2` — ambient darkness applied, scene may be dark
2. `SkyColorEffectV2` — color grade shifts hue/saturation
3. Water shader reads `tDiffuse` which is the **pre-water lit RT**

Caustics are added on top of the already-darkened/graded scene. When the scene
is dark (night, dungeon) caustics have nothing bright to work with — they need to
be **rendered additively against the final bright scene**, or their intensity needs
to compensate for `uSceneDarkness`.

The shader does apply `col += causticsColor * c * causticsAmt * 1.35` but:
- `causticsAmt *= edge * causticsCloudLit * inside` — all three can be ≪ 1
- `causticsColor = mix(vec3(1.0, 1.0, 0.85), uTintColor, 0.15)` — tinted by water
  tint which may be dark blue

**Fix required:**
- Caustics should be rendered in the **same additive manner as `WindowLightEffectV2`**:
  boost the caustics color to be HDR (> 1.0) before the color grade clamps it, or
  ensure water runs **after** `SkyColorEffect` + `ColorCorrectionEffect` so caustics
  add directly on the final graded image.
- Currently water runs **before** sky grading. Consider moving water **after**
  `ColorCorrectionEffectV2` in the post chain, or separating caustics into their
  own additive overlay pass.
- Alternatively: scale `causticsColor` upward (e.g. `vec3(2.5, 2.3, 1.8)`) to punch
  through the downstream color grade.

---

##### 20c. Foam Particles — WeatherParticles Bridge ✅ FIXED

**Previous symptom:** No foam particles visible on water surface.

**Fix applied (weather integration session):**
`WeatherParticlesV2` (`scripts/compositor-v2/effects/WeatherParticlesV2.js`) was created as
a thin adapter that:
1. Creates a shared `BatchedRenderer` added to the FloorRenderBus scene.
2. Instantiates the V1 `WeatherParticles` pointed at that scene.
3. Exposes `window.MapShineParticles.weatherParticles` so the existing
   `WaterEffectV2._syncLegacyFoamParticles()` bridge works unmodified.
4. Drives `WeatherController.update()` each frame so weather state is live.

`WeatherParticlesV2` is initialized and driven by `FloorCompositor`:
- `initialize(busScene)` — called in `FloorCompositor.initialize()`
- `update(timeInfo)` — called before the bus render each frame
- `dispose()` — called in `FloorCompositor.dispose()`

`WeatherController.initialize()` is now called in V2 mode in `canvas-replacement.js`
(previously skipped). It provides wind/precipitation/cloud state to all V2 effects.

---

##### 20d. Cloud Shadow Integration ✅ WIRED

**Previous symptom:** `uHasCloudShadow` was always 0.0.

**Fix applied (weather integration session):**
- `WaterEffectV2.setCloudShadowTexture(shadowTex)` method added — accepts a
  `THREE.Texture` (from `CloudEffectV2.cloudShadowTexture` getter) and binds it
  to `tCloudShadow` / `uHasCloudShadow` each frame.
- `FloorCompositor.render()` now calls `this._waterEffect.setCloudShadowTexture(cloudShadowTex)`
  immediately after the lighting pass (where `cloudShadowTex` is already computed),
  before water renders. When clouds are disabled, passes `null` → fallback white
  texture → shadow factor = 1.0 (no effect).

Cloud shadows now dynamically suppress water specular and caustics under cloud cover.

---

##### 20e. Outdoors Mask ✅ WIRED

**Previous symptom:** `uHasOutdoorsMask` was always 0.0.

**Fix applied:**
`OutdoorsMaskProviderV2` (`scripts/compositor-v2/effects/OutdoorsMaskProviderV2.js`) was
created as a shared outdoors mask supplier. Architecture:

1. `populate(foundrySceneData)` — discovers `_Outdoors` mask images on all scene tiles
   (same `probeMaskFile` pattern as WaterEffectV2), composites per-floor into a
   scene-UV `THREE.CanvasTexture` (Foundry Y-down, `flipY=false`, 1024px).
2. `subscribe(callback)` — pub/sub distribution to all consumers. Fires immediately
   with current mask and again on every `onFloorChange()`.
3. `onFloorChange(maxFloorIndex)` — swaps to the best floor mask (highest ≤ max,
   fallback to floor 0), then notifies all subscribers.

**Consumers wired in `FloorCompositor.initialize()`:**
- `CloudEffectV2.setOutdoorsMask(tex)` — cloud shadow/tops gate to outdoor areas
- `WaterEffectV2.setOutdoorsMask(tex)` — wave/rain indoor damping now active;
  `uOutdoorsMaskFlipY` set to 0.0 (canvas is already Foundry Y-down)
- `WeatherController.setRoofMap(tex)` — foam fleck particle spawn gating

**Coordinate space note:**
The canvas composite is authored in Foundry Y-down space (matching tile `x`/`y`
Foundry coordinates). The cloud shadow shader samples `vUv` directly (also Y-down
on screen), so no flip is needed. The water shader's `sampleOutdoorsMask()` accepts
a `sceneUv01` already in Foundry space and the `uOutdoorsMaskFlipY=0` path is correct.

---

##### 20f. Sky Color Coupling — Partially Wired

**Symptom:** Water specular tint doesn't match the sky/time-of-day color (always a
fixed blue-grey).

**Root cause:**
`uSkyColor` is initialized to `vec3(0.5, 0.6, 0.8)` and never updated.
`SkyColorEffectV2` exposes `currentSkyTintColor` (a `THREE.Color`) that tracks the
live sky hue. This is not yet fed to `WaterEffectV2`.

`uSkyIntensity` is now bound from `params.skyIntensity` (fixed this session) but
not automatically linked to `SkyColorEffectV2`'s computed sky intensity.

**Fix required (low complexity):**
In `FloorCompositor.render()` after `_skyColorEffect.update()`:
```js
const skyTint = this._skyColorEffect.currentSkyTintColor;
if (skyTint) this._waterEffect.setSkyColor(skyTint.r, skyTint.g, skyTint.b);
```
Add `setSkyColor(r, g, b)` method to `WaterEffectV2` that writes `u.uSkyColor`.

---

#### Post-Chain Position

Water currently runs in `FloorCompositor.render()` **after** `LightingEffectV2` but
**before** `SkyColorEffectV2` and `ColorCorrectionEffectV2`. This means:
- Caustics and specular are added to the lit-but-ungraded image.
- Downstream color grading (exposure, saturation, tone mapping) applies on top.
- **Caustics appear grey** because their warm-white additive boost is desaturated
  by the color grade.

**Recommended fix:**
Move the water pass to run **after** `ColorCorrectionEffectV2`, immediately before
`BloomEffectV2`. This means:
- Caustics and specular add on the final-grade image → bloom picks them up → they
  glow correctly.
- `tDiffuse` in the shader will be the fully graded scene — this is the correct
  base for refraction.
- Water tint will also be grade-correct (currently tint is applied pre-grade).

Alternatively, run a two-phase water pass: refraction/tint/murk before grade,
caustics/specular after grade.

---

#### Validation Checklist

- [x] Water tint visible on water areas
- [x] Water only on correct floor (no bleeding to upper floor)
- [x] Distortion pinned at edges — no "holes" at water boundary
- [x] Upper-floor occluder mask prevents distortion bleeding through upper geometry
- [x] Wave animation smooth at 120fps
- [x] RGB shift (chromatic aberration) stays inside water boundary
- [x] Sand layer visible in shallow areas
- [x] Shore foam visible (shader-computed)
- [x] Murk (silt/algae) visible in deep areas
- [ ] Specular highlights visible as bright reflections on water surface
- [ ] Caustics look like light (bright warm-white filaments, not grey smears)
- [x] Foam particles (floating foam.webp clumps at water surface)
- [x] Cloud shadows suppress specular and caustics dynamically
- [x] Indoor/outdoor damping reduces wave strength under covered areas
- [x] Sky color tint propagated from SkyColorEffectV2 to water specular
- [x] Water runs after color grade so caustics/specular bloom correctly

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

This table is intended to be exhaustive and implementation-grounded.

**Legend:**
- **✅ Complete**: Implemented and wired in `FloorCompositor`.
- **🔧 In progress**: Implemented but still missing key visual parity or validation checks.
- **⏳ Deferred**: Not yet ported to V2.
- **⬜ Not started**: No V2 implementation exists.

| Step | Component | Status | Last change (date / commit) | Key files | Validation / notes |
|---:|---|---|---|---|---|
| 0 | Albedo baseline (FloorRenderBus) | ✅ Complete | 2026-02-24 / `c48d7a0` | `scripts/compositor-v2/FloorRenderBus.js` | Loads tile textures via `THREE.TextureLoader` (straight alpha). Floor isolation via `setVisibleFloors(maxFloorIndex)`. Includes solid bg + scene bg image plane. |
| 0b | V2 orchestrator (FloorCompositor) | ✅ Complete | 2026-02-24 / `c48d7a0` | `scripts/compositor-v2/FloorCompositor.js` | Owns RT chain, effect lifecycle, and floor-change hook (`mapShineLevelContextChanged`). V2 render path integrated via `EffectComposer` delegation. |
| 1 | Specular (tile overlays) | ✅ Complete | 2026-02-23 / `50ce5bd` | `scripts/compositor-v2/effects/specular-shader.js`, `scripts/compositor-v2/effects/SpecularEffectV2.js` | Per-tile additive overlays registered via `FloorRenderBus.addEffectOverlay`. No registry/compositor deps. Light tracking via Foundry light hooks. |
| 2 | Fire sparks (mask-driven particles) | ✅ Complete | 2026-02-23 / `b671a3b` | `scripts/compositor-v2/effects/fire-behaviors.js`, `scripts/compositor-v2/effects/FireEffectV2.js` | Mask scan → per-floor bucketed Quarks systems. Floor isolation via activation swap on `onFloorChange`. Requires continuous render when active. |
| 3 | Window lights (mask-driven overlay) | ✅ Complete | 2026-02-24 / `b640720` | `scripts/compositor-v2/effects/WindowLightEffectV2.js` | Rendered as an isolated scene and fed into `LightingEffectV2` so glow is tinted by albedo during lighting compose (prevents saturation wash-out). Floor isolation handled in `WindowLightEffectV2.onFloorChange`. |
| 4 | Render targets + post chain infrastructure | ✅ Complete | 2026-02-24 / `c48d7a0` | `scripts/compositor-v2/FloorCompositor.js` | `sceneRT` + ping-pong post RTs (`HalfFloat`, `LinearSRGBColorSpace`) + final blit quad with `toneMapped=false`. |
| 5 | Lighting (post) | ✅ Complete | 2026-02-24 / `c48d7a0` | `scripts/compositor-v2/effects/LightingEffectV2.js` | Composes ambient + dynamic lights + darkness onto bus `sceneRT`. Accepts window-light scene and cloud-shadow texture as inputs. |
| 6 | Sky color grading (post) | ✅ Complete | 2026-02-23 / `b671a3b` | `scripts/compositor-v2/effects/SkyColorEffectV2.js` | Time-of-day atmospheric grade. Exposes `currentSkyTintColor` and sun angles; used to drive water specular tint. |
| 7 | Clouds (shadow RT + cloud tops) | ✅ Complete | 2026-02-24 / `c48d7a0` | `scripts/compositor-v2/effects/CloudEffectV2.js` | Generates `cloudShadowTexture` (fed into lighting) and cloud-top RT (alpha-over blit after bloom/water chain). Overhead shadow occlusion uses FloorRenderBus visibility + blocker pass. |
| 7b | Weather particles bridge | ✅ Complete | 2026-02-24 / `c48d7a0` | `scripts/compositor-v2/effects/WeatherParticlesV2.js` | Wrapper around V1 `WeatherParticles`. Adds shared Quarks `BatchedRenderer` to bus scene. Drives `WeatherController.update()` and exposes `window.MapShineParticles.weatherParticles` for water foam sync. |
| 7c | Outdoors mask provider (shared infra) | ✅ Complete | (uncommitted / new file) | `scripts/compositor-v2/effects/OutdoorsMaskProviderV2.js` | Discovers `_Outdoors` masks and composites per-floor `CanvasTexture` (Foundry Y-down, `flipY=false`). Wired to Cloud/Water/WeatherController via subscriptions in `FloorCompositor.initialize()`. |
| 8 | Building shadows | 📋 Researched | — | — | Deep research complete — see Step 8 detail section below. Multi-floor mask combination, occluder-only bake, shadow receiver plane. |
| 9 | Overhead shadows | ⏳ Deferred | — | — | Not yet ported. Needs roof alpha / occluder semantics in V2. |
| 10 | Player lights | ⏳ Deferred | — | — | Not yet ported. Token-driven lights. |
| 11 | Lightning | ⏳ Deferred | — | — | Not yet ported. Weather-driven global flashes. |
| 12 | Candle flames | ⏳ Deferred | — | — | Not yet ported. Particle/light driven. |
| 13 | Atmospheric fog | ⏳ Deferred | — | — | Not yet ported. Screen-space depth fog. |
| 14 | Bloom (post) | ✅ Complete | 2026-02-24 / `b640720` | `scripts/compositor-v2/effects/BloomEffectV2.js` | Wraps `UnrealBloomPass`. Runs after water, before cloud-top blit + grain/sharpen. |
| 15 | Vision mode (post) | ⬜ Not started | — | — | No V2 implementation yet. |
| 16 | Color correction (post) | ✅ Complete | 2026-02-23 / `b671a3b` | `scripts/compositor-v2/effects/ColorCorrectionEffectV2.js` | Static grade near end of chain. Dynamic exposure integration deferred. |
| 17 | Film grain (post) | ✅ Complete | 2026-02-23 / `b671a3b` | `scripts/compositor-v2/effects/FilmGrainEffectV2.js` | Optional; disabled by default. |
| 18 | Sharpen (post) | ✅ Complete | 2026-02-23 / `b671a3b` | `scripts/compositor-v2/effects/SharpenEffectV2.js` | Optional; disabled by default. |
| 19 | Stylistic/debug post FX | ⬜ Not started | — | — | No V2 implementations yet (ASCII, dot screen, halftone, mask debug, etc.). |
| 20 | Water (post) | 🔧 In progress | 2026-02-24 / `c48d7a0` | `scripts/compositor-v2/effects/water-shader.js`, `scripts/compositor-v2/effects/WaterEffectV2.js` | Implemented + wired, including: per-floor SDF switching, upper-floor occluder RT, outdoors mask, cloud shadow, sky tint coupling, and post-chain ordering (after grading, before bloom). Remaining gaps are primarily **specular/caustics visual tuning** + manual parity validation. |