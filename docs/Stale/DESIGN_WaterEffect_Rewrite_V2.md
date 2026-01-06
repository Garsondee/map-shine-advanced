# WaterEffect Rewrite v2 (Design Document)

## Intent
The current `WaterEffect` has accumulated many features (distortion modes, chromatic refraction, tint/depth, murk, sand, caustics, multiple foam concepts, accumulation, debug views) across both `WaterEffect.js` and `DistortionManager.js`. It is now hard to reason about, tune, and extend.

This document proposes a **rewrite from scratch** that preserves the *kinds* of features we want, but reorganizes the system around one core idea:

**A coherent “water surface shape model” is the source-of-truth**, and everything else (displacement, RGB shift/refraction, caustics placement, whitecaps/foam) is derived from that model.

The existing implementation is treated as **v1 blueprint** and a reference for desired visuals.

---

## Goals
- **Surface shape is primary**
  - Represent natural water bodies (lakes/ponds, puddles, canals/streams) with a *plausible* surface behavior.
  - The shape model must directly inform:
    - Distortion/displacement amplitude + directionality
    - Chromatic refraction / RGB shift strength
    - Wind whitecaps + foam placement
- **Stable in world-space**
  - Patterns stay pinned to the map (no screen-space swimming).
- **Composable + testable**
  - Each “look” is a small number of inputs and outputs.
  - Debug visualizations exist for every important intermediate.
- **Performance-first**
  - No per-frame CPU work.
  - Any expensive CPU preprocessing happens once per `_Water` texture change.
  - Shader work is bounded and mostly constant-time per pixel.
- **Play nicely with the existing rendering architecture**
  - All time comes from the centralized `TimeManager` (`update(timeInfo)` -> uniforms).
  - Post chain must never break: even if water disabled, the post pass must still blit/forward.

---

## Non-Goals (for v2.0)
- True fluid simulation.
- Per-object interactions (boats pushing wakes, footsteps, projectiles).
- Flow-field accurate rivers (can be added later as an optional “flow map”).

---

## Constraints / Invariants (MapShine-specific)
- **Coordinate conventions** (must remain consistent):
  - Foundry docs/textures are **top-left origin, Y-down**.
  - Three world is **bottom-left origin, Y-up**.
  - For any world-space sampling into `_Water` and derived maps:
    - Use `uSceneBounds=(sceneX,sceneY,sceneW,sceneH)` and flip V: `v = 1 - (y-sceneY)/sceneH`.
  - For screen-space passes that reconstruct world XY, use `uViewBounds` and then convert Three->Foundry with `foundryY = uSceneDimensions.y - threeY`.
- **Do not mix sampling spaces**:
  - If a texture is world-space (e.g. `_Water`, `_Outdoors`) sample in scene UV.
  - If a texture is screen-space (roof alpha, occluder alpha targets), sample in `vUv`/`gl_FragCoord/uScreenSize`.
- **Zoom stability**:
  - Any “length” offsets in post shaders must be in **pixels** then multiplied by `uTexelSize`.
  - For perspective zoom, use `sceneComposer.currentZoom` (FOV-based), not `camera.zoom`.

---

## Proposed v2 Architecture

### High-level layering
- **WaterEffectV2 (CPU coordinator)**
  - Owns parameters and UI schema.
  - Detects `_Water` (and optional water-related masks).
  - Builds/updates derived textures *once per asset change*.
  - Registers a single source with `DistortionManager` (or a dedicated Water pass later).

- **WaterSurfaceModel (new module; CPU preprocessing)**
  - Input: `_Water` mask (+ optional overrides).
  - Output: a *small*, well-defined set of derived maps that represent “surface shape” and “exposure”.

- **DistortionManager (GPU apply/composite)**
  - Consumes the WaterSurfaceModel outputs + weather state.
  - Computes:
    - Displacement field
    - Refraction/chromatic offsets
    - Whitecap/foam masks
    - Optional caustics, murk, sand shading

The key change is that the shader is no longer a pile of unrelated noises. It becomes a set of functions that transform **shape maps** into visual outputs.

---

## Keeping the system clean: Water vs DistortionManager

### The current problem (v1)
Right now, water is “implemented inside” `DistortionManager` in practice:
- Water injects a large parameter surface into DistortionManager.
- DistortionManager owns water-only render targets (e.g. foam accumulation) and a large block of water-only shader code.
- This makes changes risky because water features and general distortion plumbing are coupled.

v2 should avoid repeating this by making **DistortionManager a generic distortion bus** and making **Water a self-contained subsystem**.

### Target boundaries

DistortionManager should be responsible for:
- Compositing **generic** distortion offset fields into a distortion map.
- Applying that offset map to the scene (or providing the distortion map to downstream passes).
- Global view mapping uniforms (`uViewBounds`, `uSceneRect`, `uSceneDimensions`, `uResolution`), roof masking, and other shared *infrastructure*.

DistortionManager should *not* be responsible for:
- Water shading (tint/murk/sand/caustics).
- Water reflections.
- Water foam accumulation / persistence.
- Water-specific debug views.

WaterEffectV2 / WaterPostEffect should be responsible for:
- Owning WaterData generation, lifetime, and precision decisions.
- Owning any water-only render targets (foam history, reflection cache, etc.).
- Owning the water shader(s) and all water-specific uniforms.

### Recommended architecture (cleanest)

Implement water as its own post-processing effect:
- **`WaterPostEffect`** (new EffectBase pass)
  - Inputs: `tScene` (the current scene buffer), `tWaterData`, optional `tSkyReflect`, and any lighting masks it needs.
  - Outputs: the composited scene with water applied.
  - Internally performs:
    - water-only distortion/refraction
    - chromatic refraction
    - foam/whitecaps (including optional persistence)
    - tint/murk/sand/caustics
    - reflections + parallax bottom

DistortionManager remains for other distortion sources:
- heat haze
- magic
- other future non-water distortions

This prevents the “everything ends up in DistortionManager” failure mode.

### Transitional option (minimum refactor)
If we need to keep using DistortionManager for water in the short term, enforce a strict plug-in boundary:
- DistortionManager exposes only common infrastructure and a small hook surface.
- Water is implemented as a separate module (e.g. `WaterDistortionPlugin`) that:
  - defines its uniforms
  - defines its GLSL snippets
  - provides `updateUniformsFromWaterEffect()`
- DistortionManager simply calls plugin hooks and does not contain water logic inline.

This is not as clean as a dedicated `WaterPostEffect`, but it localizes water complexity to a single module and keeps DistortionManager from accumulating more water-only responsibilities.

---

## The Core: Water Surface Shape Model

### Inputs (assets)
- **Required**
  - `_Water` mask
    - White-ish = water, black = non-water.
    - In v2, we treat `_Water` as a *binary-ish segmentation mask*.

- **Optional (future / overrides)**
  - `_Shoreline` (artist-controlled foam/shore band)
  - `_WaterDepth` or `_Bathymetry` (true depth map)
  - `_Flow` (2D flow direction, for rivers)

---

## Texture Packing & Resource Strategy
In WebGL, binding many textures per pass is expensive and can hit texture unit limits.

v2 should consolidate all derived water shape data into a single **WaterData texture (RGBA)**.

Recommended channel layout:
- **R**: Signed Distance Field (SDF), remapped to 0..1
  - `0.5` = shoreline
  - `< 0.5` = water
  - `> 0.5` = land
- **G**: Exposure / fetch proxy (`waterExposure01`)
- **B**: Flow X (or shore normal X if flow is not present)
- **A**: Flow Y (or shore normal Y if flow is not present)

Notes:
- Depth does not need its own channel if it is purely derived from distance. Compute a depth proxy in-shader from the SDF (e.g. `depth01 = saturate((0.5 - dist) * scale)` for inside-water distance).
- The flow channels enable a future river upgrade without changing shader structure: if flow is neutral, fall back to global wind.

### Derived maps (WaterSurfaceModel outputs)
These are the minimum set needed to express believable water behavior without new feature creep.

1) **Signed Distance Field (SDF)**: `waterSdf`
- Value meaning:
  - Negative inside water, positive outside.
  - Magnitude = distance-to-boundary (in pixels or normalized scene units).
- Why:
  - A single SDF gives us:
    - Distance-to-shore (inside)
    - A robust shoreline band
    - A stable gradient direction (approximate shore normal)
    - Shape classification heuristics (puddle vs lake vs canal)

2) **Depth Proxy**: `waterDepth01`
- Default: derived from distance-to-shore.
- Example mapping:
  - `depth01 = saturate( (shoreDistPx - d0) / (d1 - d0) ) ^ depthGamma`
- Why:
  - Makes shallow edges behave differently than deep centers:
    - Smaller ripples near shore
    - Different tint/caustics intensity
    - Whitecaps suppressed in very shallow water

3) **Exposure / Fetch Proxy**: `waterExposure01`
- Represents how much a pixel “feels wind waves”.
- Intuition:
  - A puddle in a courtyard should not get ocean-like chop.
  - A long canal should have directionality and limited cross-waves.
- Implementation options:
  - v2.0 (cheap): use local width from SDF:
    - `width01 ~ saturate( shoreDist / widthScale )`
    - Exposure increases with local width.
  - v2.1 (better): approximate **fetch along wind direction** via CPU line sweep or sparse raymarch in the SDF.

4) **Shore Normal (optional)**: `waterShoreDir`
- A 2-channel texture encoding the normalized gradient of SDF.
- Why:
  - Lets shoreline foam “wrap” around the shape.
  - Lets wind-driven foam accumulate on wind-facing shores.

---

## Resolution vs Precision (Bit Depth)
The “512 vs 1024” question matters, but the bigger risk is **SDF precision**.

Risk:
- If the SDF is stored in an 8-bit texture on a large scene, you can get visible banding/terracing in:
  - depth-based tint
  - foam bands
  - shoreline thresholds

Preferred solution:
- Store WaterData as **16-bit** where possible:
  - `HalfFloatType` for the `WaterData` texture (WebGL2 + extensions).

Fallback options:
- If limited to 8-bit:
  - Use a dithering strategy during SDF generation.
  - Or store SDF precision across two channels (high/low) and reconstruct in shader.

Resolution guidance:
- Start with **512** for WaterData.
- Because this is an SDF (smooth signal), bilinear filtering provides “sub-pixel” gradients for free.

### CPU responsibilities
WaterSurfaceModel is computed:
- On `setBaseMesh(basePlane, bundle)` when `_Water` becomes available.
- On any scene change that swaps the water texture.

Performance targets:
- One-time preprocessing cost is acceptable (tens of ms).
- Output textures should be relatively low-res if possible (e.g. 512–1024) and sampled in shader.

Recommended approach (v2.0):
- Build a binary mask from `_Water` (threshold).
- Compute approximate SDF at chosen resolution.
  - Start with a straightforward two-pass distance transform (good enough at low res).
  - If quality is insufficient, upgrade to Jump Flooding (CPU) or multi-source BFS.
- Derive depth/exposure maps from SDF.

---

## Real-Time Drawing / Editing Responsiveness
Foundry allows GMs to draw/modify shapes in real time. If SDF generation takes long enough to be noticeable, water editing will feel laggy.

Strategy:
- **Debounce regeneration**
  - Mark water data as dirty on each edit.
  - Regenerate the SDF only after a short idle window (e.g. 500ms after the last change).
- **Interactive fallback (“raw mode”)**
  - While dirty (during active drawing), the shader uses a cheap binary mask path (on/off water) with minimal effects.
  - When the new WaterData arrives, cross-fade from raw -> HQ over ~0.25–0.5s.
- **Web Worker**
  - SDF generation should run in a worker to avoid freezing the main thread.
  - Candidate algorithm: Meijster distance transform (or other O(N) EDT) at chosen resolution.

This implies WaterEffectV2 needs a small state machine:
- `mode = RAW` while edits are active
- `mode = HQ` when WaterData is ready
- `transition = mix` during cross-fade

---

## Integration & Interactivity

### Quark particle integration
The packed WaterData texture is valuable beyond the water shader. It can drive shoreline foam, splashes, and floating debris motion.

WaterEffectV2 should expose a small API for other systems:

```js
getWaterData() {
  return {
    texture: this.waterDataTexture,
    transform: this.waterTextureTransform,
    flowEnabled: this.flowEnabled,
    precision: this.waterDataPrecision
  };
}
```

Target uses:
- **Constraint (kill-on-land):** particles that should stay on water can sample `WaterData.r` and kill/alpha-out when `dist > 0.5`.
- **Shoreline spawning:** emit foam/spray only near the shore band (`abs(dist - 0.5) < eps`) rather than scanning the raw `_Water` edge.
- **Advection:** floating debris can sample flow (`WaterData.ba`) and follow rivers/streams. If flow is neutral, fall back to global wind.

Optional CPU readback:
- If any particle logic must run on the CPU (e.g. coarse “steering” or spawn-time tagging), keep a low-res copy of the flow/exposure arrays in JS memory alongside the GPU texture.

### 2.5D reflections (avoid the “plastic jelly” look)
Foundry top-down scenes do not have a skybox, so water needs a fake environment reflection to feel glossy and alive.

Strategy:
- Add a reflection/sky lookup: `sampler2D tSkyReflect`.
- Use the wave-derived normal (or slope) to offset the lookup.
- Keep it deliberately cheap: no true raymarching or cube maps.

```glsl
vec3 normal = calculateWaveNormal(waves);
vec2 reflectionUv = sceneUv + normal.xy * 0.1;
vec3 reflectionColor = texture2D(tSkyReflect, reflectionUv).rgb;
outputColor += reflectionColor * reflectionStrength;
```

Notes:
- This can be a MatCap, a static cloudy gradient, or a simple procedural texture.
- Reflection should be masked by `waterMask` and scale with wind/exposure.

### Parallax depth (surface vs bottom decoupling)
To sell water volume, the “bottom” should not be locked 1:1 to the surface.

Mechanic:
- When sampling bottom layers (sand/murk patterns), use a parallax-shifted UV:
  - `bottomUv = sceneUv + viewDir.xy * depth01 * parallaxScale`

Implementation notes:
- For a top-down camera, “viewDir” can be approximated from camera/view bounds (screenUv -> world delta) rather than true 3D view vectors.
- Parallax must remain pinned to world-space (scene UV), not screen UV.

### Cursor interaction (cheap “juice”)
Even subtle interactivity makes the map feel alive.

Approach:
- Add uniforms:
  - `uMouseWorld` (Foundry/world coords)
  - `uClickTime` (or `uMouseImpulse`)
- In-shader, add a localized radial wave contribution to the displacement/normal:
  - amplitude decays with distance and time
  - this is not fluid sim; it is a cheap procedural disturbance

### Foundry lighting integration (darkness response)
Water should respond to scene darkness:
- **Day:** more transparent/refractive; sand/bottom visible
- **Night:** more reflective/specular; bottom obscured

Add a uniform (or reuse existing lighting uniforms if already available in the post chain):
- `uSceneDarkness` in `[0..1]`.

```glsl
float darkness = uSceneDarkness;
float surfaceReflectivity = mix(0.2, 0.8, darkness);
float bottomVisibility = mix(1.0, 0.2, darkness);
```

---

## How the Shape Model Drives Visual Features

### 1) Displacement / Surface Motion
We separate motion into layers that correspond to real phenomena:
- **Micro ripples** (small scale)
  - Always present, weak.
  - Stronger in shallow areas or during rain.
- **Wind waves / swell** (macro)
  - Directional, aligned with wind.
  - Strength scales with `waterExposure01` and wind speed.
- **Chop** (mid/high frequency)
  - Adds crest sharpness.
  - Scales with gusts and exposure.

Key rule:
- Displacement amplitude is not uniform over the water. It must be modulated by:
  - `waterMask` (obvious)
  - `waterExposure01`
  - optional depth rule: shallow edges often have reduced large-wave amplitude.

### 2) Chromatic Refraction / RGB shift
Chromatic offsets should come from **surface slope proxies**, not a generic mask:
- Compute/approximate “slope” from the same height function used for waves.
- Gate chroma by:
  - `waterMask`
  - `waterExposure01` (more choppy => more refraction)
  - `shoreBand` (edges can show stronger distortion, but avoid halos)

### 3) Whitecaps (wind-driven)
Whitecaps should appear where waves break:
- Base signal: crestness from wave slope.
- Gates:
  - wind strength (including gust local variations)
  - `waterExposure01`
  - depth suppression in very shallow areas (optional)
- Secondary detail:
  - breakup noise
  - optional temporal persistence (accumulation)

### 4) Shoreline foam
Shore foam is not the same as whitecaps.
- Primary driver: shoreline band from SDF (`shoreBand = smoothstep(...)` of inside distance).
- Motion:
  - advect along wind direction (or flow map later)
  - optional wrapping using shore normal
- Optional override:
  - if `_Shoreline` exists, it replaces/augments the derived shore band.

Shoreline anti-aliasing:
- When using a threshold around the shoreline (`dist ~ 0.5`), use hardware derivatives to reduce stair-stepping.

```glsl
float dist = texture2D(tWaterData, waterUv).r;
float w = fwidth(dist);
float shoreLine = smoothstep(0.5 - w, 0.5 + w, dist);
```

### 5) Caustics, murk, sand
These become *shading* layers driven by depth proxy and water visibility:
- Caustics:
  - mostly in shallow water (low-to-mid `depth01`)
  - modulated by ripple field
- Murk:
  - increases with depth
- Sand bed detail:
  - strongest in shallow
  - fades with zoom to avoid shimmer

---

## Implementation Stages (Plan)

### Stage A — v2.0 (Minimal rewrite, highest leverage)
- Implement `WaterSurfaceModel` with outputs:
  - Single packed `WaterData` texture (RGBA)
    - R = SDF (0.5 shoreline)
    - G = exposure
    - BA = flow (or shore normal)
- Integrate new textures into `DistortionManager` water uniforms.
- Add a coordinate normalization step:
  - WaterSurfaceModel provides `uWaterTextureTransform` so the shader can sample the packed WaterData in correct scene alignment even if the WaterData texture is generated at a different resolution or covers a sub-rect.
- Rewrite water shader logic to be structured as:
  - `shape = sampleShapeMaps(sceneUv)`
  - `wind = sampleWindField(sceneUv, t)`
  - `waves = evalWaveField(shape, wind, t)`
  - `outputs = compose(shape, wind, waves)`
- Keep existing occluder masking (screen-space alpha suppression) behavior.
- Provide debug views:
  - water mask (post-softened)
  - SDF visualization
  - derived depth01 (computed from SDF)
  - exposure01
  - crestness
  - whitecap mask

### Stage B — v2.1 (Optional: persistence / accumulation)
- If we keep foam accumulation:
  - Make it explicitly a “history buffer” step driven by the *whitecap mask*, not a separate noise system.
  - Ensure reprojection uses `uPrevViewBounds` and remains stable.

### Stage C — v2.2 (Optional: better fetch + rivers)
- Add a real fetch approximation along wind direction:
  - CPU precompute a `fetch01` map via directional sweep.
- Add `_Flow` optional support:
  - Replace wind direction with flow direction for river motion.

Flow fallback logic (needed even before v2.2):
- The shader should always have a “direction of motion” for advection/scrolling.
- Sample flow from WaterData.BA.
- If flow is neutral, fall back to global wind.

```glsl
vec2 flow = texture2D(tWaterData, waterUv).ba * 2.0 - 1.0;
float flowLen = length(flow);
vec2 dir = (flowLen > 1e-3) ? (flow / flowLen) : normalize(uWindDir);
```

---

## Migration Strategy
- Keep the existing `WaterEffect` as “Water (Legacy)” until v2 matches it.
- Add `WaterEffectV2` behind a feature flag / schema toggle.
- Once v2 achieves parity:
  - Remove legacy code paths.
  - Keep only v2 and simplify the parameter surface.

---

## Open Questions (need your call)
- **Derived map resolution**: Start at 512. SDF + filtering gives good results for soft data; raise only if shore detail is visibly lost.
- **Depth proxy tuning defaults**: Default to “center = deep” (procedural). Most maps don’t ship bathymetry.
- **Canals/streams**: Default to calm flow (low exposure). Rivers read as directional motion, not chop.

---

## Immediate Next Steps
1) Decide the minimal derived maps for v2.0 (recommend: SDF + depth01 + exposure01).
2) Add debug view scaffolding so iteration is fast.
3) Rewrite the shader code around `shape -> waves -> outputs`.

---

## Summary Checklist for v2
- Architecture: CPU `WaterSurfaceModel` -> Web Worker -> packed `WaterData` texture
- Data: RGBA WaterData
  - R = SDF, G = exposure, BA = flow/shore-normal
- Precision: prefer HalfFloat WaterData (or 8-bit fallback with dithering/packing)
- Separation of concerns:
  - DistortionManager stays a generic distortion bus (heat/magic/etc.)
  - Water rendering lives in `WaterPostEffect` (preferred) or in a strict `WaterDistortionPlugin` boundary
- Shader: sampling-driven (shape maps first), minimal procedural work
- Responsiveness: debounce + raw interactive mode + cross-fade into HQ
- Particles: `WaterEffectV2.getWaterData()` provides texture + transform for Quark systems
- 2.5D look: fake reflections (MatCap/sky) + optional parallax bottom UV
- Immersion: cursor ripples + darkness-based day/night water behavior
