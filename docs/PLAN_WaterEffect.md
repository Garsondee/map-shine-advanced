# PLAN: WaterEffect (WebGL2)

## Constraints / Non-Goals

- [ ] **Renderer constraint:** WebGL 2.0 only (no WebGPU features, no compute shaders).
- [ ] **Engine constraint:** Three.js rendering is authoritative; avoid PIXI rendering paths for the effect.
- [ ] **Non-goal:** Photoreal water simulation (no Navier–Stokes, no fluid sim).
- [ ] **Goal:** A high-impact, performant “stylized water” system that reads a `_Water` mask texture.

## Old module water system (reference feature inventory)

The old Map Shine module implemented water as a **multi-layer screen-space composite**, not a simulation. Key behaviors worth preserving (but implemented in Three.js):

- [x] **Primary mask**: `_Water` (used as a depth/coverage field).
- [x] **Optional overrides/aux masks**:
  - `_Shoreline` (explicit foam thickness)
  - `_NoWater` (exclude distortion on certain tiles like trees/boats)
  - `_Caustics` (additional caustics coverage independent of `_Water`)
  - `_Puddle` (separate puddle treatment)
- [x] **Wave distortion**: displacement-map driven refraction.
- [x] **Shoreline swirl displacement**: extra localized distortion at water edges.
- [x] **Depth displacement / parallax**: pseudo-underwater depth offset tied to mask value.
- [x] **Wall-gap handling**: smearing to hide “holes” when depth displacement pushes UVs past mask boundaries.
- [x] **Surface layer**:
  - open-water foam (coverage/sharpness driven)
  - specular highlight (normal from displacement + sun direction), gated by outdoors + cloud occlusion
- [x] **Caustics**: procedural line/filament caustics with cloud occlusion.
- [x] **Murkiness/sand**: subsurface noise to keep shallow water from looking flat.
- [x] **Flow direction**: global flow vector to advect patterns.
- [x] **Prewarm**: explicitly rendered water RTs during loading to avoid 45–65ms first-frame stalls.

## Rough reference notes from the old module (concepts only)

- [x] Old module treated “water” as a **multi-layered screen-space composite** (distortion + tint + foam + caustics), not a simulation.
- [x] It supported:
  - `_Water` as the primary mask.
  - optional `_Shoreline` override, otherwise **auto shoreline detection**.
  - `_NoWater` exclusion mask to prevent distortion on specific tiles (trees, etc.).
- [x] It explicitly **prewarmed** water render textures during loading to avoid first-frame stalls.

We should keep these *behaviors* but implement them cleanly in the Three/WebGL2 pipeline.

## Current Three.js implementation status (as of this repo)

The current implementation already covers a large portion of the old system, but with different building blocks:

- [x] **Water mask loading**: `scripts/assets/loader.js` includes `water: { suffix: '_Water' }`.
- [x] **Post pipeline integration**:
  - `scripts/effects/WaterEffect.js` registers source `id: 'water'` into `DistortionManager`.
  - `scripts/effects/DistortionManager.js` computes a composite distortion field and applies it to the scene.
- [x] **Scene-locked sampling**: Distortion uses `screenUv -> Foundry -> sceneUv` mapping so ripples stay pinned.
- [x] **Chromatic refraction**: RGB split implemented in the distortion apply pass.
- [x] **Depth-based tint/absorption**: implemented (mask interpreted as depth).
- [x] **Caustics**: implemented as a procedural pattern gated by:
  - outdoors (`_Outdoors`)
  - cloud shadows (`CloudEffect` target)
  - window light (`WindowLightEffect` target)
  - scene darkness/vignette parameters
- [x] **Wind foam (open water)**: implemented as streaky foam driven by wind direction/speed.
- [x] **Tile occluder suppression (screen-space)**: `DistortionManager` supports `tWaterOccluderAlpha` to suppress water where tiles are opaque.
- [x] **Quarks integration (already exists, separate from WaterEffect)**:
  - `scripts/particles/WeatherParticles.js` derives shoreline edge points from the `_Water` mask (CPU scan on texture change) and spawns:
    - shoreline foam particles
    - shoreline foam spray particles
    - rain “water hit” splashes

Main missing legacy behaviors:

- [ ] `_Shoreline` explicit override mask (currently shoreline is inferred from gradients).
- [ ] `_NoWater` explicit exclusion mask (current system only has screen-space occluder alpha, not an authored data mask).
- [ ] Dedicated “depth displacement + wall smear” pass (old underwater parallax trick).
- [ ] Puddles (`_Puddle`) as a separate treatment path.
- [ ] Optional flow direction control (global + optional `_Flow`).
- [ ] Water-specific prewarm step (Three.js equivalent).

## Primary Input: `_Water` mask

- [ ] **Input texture:** `_Water` (opaque).
- [ ] **Meaning:** brightness (white) indicates **water depth** at that point.
  - Proposed mapping: `depth01 = clamp(luma(_Water.rgb), 0..1)`.
  - Depth usage is artistic, not physical: drives color absorption, distortion strength, foam, particles.

### Mask coordinate convention

- [ ] Use the same scene UV conventions as other masks.
  - Current engine already maps:
    - screenUv -> Foundry coords -> sceneUv (see `DistortionManager`).
  - Decide once and stick to it:
    - If `_Water` comes from `AssetLoader` like other masks, it likely needs the same Y flip as `_Outdoors` (`heatUv = vec2(sceneUv.x, 1.0 - sceneUv.y)` pattern).

### Mask color space

- [ ] Treat `_Water` as **data/linear**, not sRGB.
  - In `AssetLoader`, most masks are currently treated as sRGB unless in `[normal, roughness]`.
  - We likely want to include `water` in the “data texture” set so depth math is stable.

## Where `_Water` plugs into the new engine

Findings so far:

- [x] **Mask loading system exists:** `scripts/assets/loader.js` uses suffix-based masks.
  - `_Water` entry is enabled.
- [x] **Scene bundle wiring exists:** `SceneComposer.initialize()` returns `bundle.masks`.
- [x] **A distortion path already has a ‘water’ slot:** `DistortionManager` has `tWaterMask`, `uWaterEnabled`, `waterRipple()`.

Notes:

- [ ] `DistortionManager` currently samples `tWaterMask` using `vUv`. For consistency with the heat path (scene-locked masks), we probably want water to use the same `sceneUv` mapping (and matching Y flip) so ripples stay pinned to the map and align to `_Water` exactly.

  - This is now implemented: composite/apply shaders derive `sceneUv` using `uViewBounds + uSceneRect` and sample the water mask in that space.

Planned wiring steps:

- [ ] **Enable `_Water` loading** in `EFFECT_MASKS` (AssetLoader).
- [ ] **Expose `_Water` texture** from the `SceneComposer` bundle.
- [ ] **Introduce a real `WaterEffect`** (not the stub) that:
  - registers a distortion source in `DistortionManager` (`id: 'water'`).
  - provides additional optional passes (foam, caustics, color grading) as the plan advances.

  - These plumbing steps are now done.

## Visual Model (stylized, performant)

We treat water as a layered “stack” of cheap illusions:

- **Layer A: Refraction/distortion**
  - Distort scene color behind water to suggest motion.
- **Layer A2: Chromatic refraction (RGB split)**
  - Fake dispersion by sampling the scene 3 times (R/G/B) with slightly different UV offsets.
  - Driven by depth + ripple intensity.
- **Layer B: Water tint / absorption**
  - Color grade pixels under water based on depth (darker / more saturated with depth).
- **Layer C: Surface detail**
  - Animated normals / ripples (procedural).
  - Optional “flow direction” to bias ripples, foam streaks, and micro-detail advection.
  - Fine sand/grit micro-motion (subsurface) to prevent “flat” water in still scenes.
- **Layer C2: Specular reflection (sky-driven)**
  - Treat water as a mirror of the sky (stylized, not physically correct).
  - Reflection color should react to both **SkyColorEffect** (time-of-day grading) and **CloudEffect** (cloud coverage/top shading).
- **Layer D: Shoreline foam**
  - Edge detection using the `_Water` depth field.
- **Layer E: Particles & decals (Quarks)**
  - Foam flecks, bubbles, small wakes. Spawn density modulated by depth.

Everything is mask-driven. Depth controls intensity.

## Performance budgets (WebGL2)

- [ ] **Default target:** 1–2 full-screen passes for MVP.
- [ ] **Advanced target:** 3–6 full-screen passes (only on high tier), with downsampled intermediates.
- [ ] **Avoid per-frame CPU mask scanning**.
  - Only scan `_Water` on the CPU when building a particle lookup-map (on load / on texture change), not every frame.

## Roadmap (simple -> advanced)

### Phase 0 — Plumbing + debug visualization (very simple)

- [x] Add `_Water` mask loading (`water: { suffix: '_Water', ... }` in AssetLoader).
- [ ] Add a simple debug mode that draws:
  - depth01 as grayscale overlay.
  - water/no-water threshold.
- [ ] Confirm UV orientation (Y flip) matches authored textures.
- [ ] Add an optional `_Shoreline` mask loading hook.
- [ ] Add an optional `_NoWater` mask loading hook.

Deliverable: you can see the water mask aligned perfectly.

### Phase 1 — MVP: Water distortion only

- [x] Implement real `WaterEffect` by registering a `DistortionManager` source.
- [x] Register distortion source:
  - mask: `_Water`
  - intensity: scaled by `depth01`
  - noise: existing `waterRipple()` in `DistortionManager`.
- [x] Ensure water distortion is **scene-UV pinned** (same convention as heat), not screen-UV.
- [ ] Add parameters:
  - `distortionIntensity`
  - `frequency`
  - `speed`
  - `depthToDistortionCurve` (simple power or remap)

Deliverable: water areas shimmer/move convincingly at low cost.

### Phase 1b — Chromatic refraction (RGB split) (easy win)

- [x] Add “RGB split refraction” to the water distortion application:
  - Sample scene color 3 times with slightly different offsets:
    - `uvR = uv + offset * (1.0 + chroma)`
    - `uvG = uv + offset`
    - `uvB = uv + offset * (1.0 - chroma)`
  - Compose `vec3(colorR.r, colorG.g, colorB.b)`.
- [ ] Modulate `chroma` by depth and/or distortion intensity:
  - shallow: subtle
  - deep: stronger (but clamp hard to prevent nausea)
- [ ] Add parameters:
  - `chromaticAberration` (0..1)
  - `chromaticDepthBoost`
  - `chromaticMaxPixels` (resolution-independent cap)

Deliverable: “expensive-looking” refraction without extra buffers.

### Phase 2 — Water tint/absorption (depth-based color)

- [x] Add a post-process blend that tints pixels under `_Water`.
- [ ] Depth controls:
  - shallow: lighter, more transparent
  - deep: darker, more saturated
- [ ] Optional: pseudo “light extinction” curve:
  - `tintFactor = 1 - exp(-depth01 * k)`

Deliverable: water reads as water even when distortion is subtle.

### Phase 2b — Sky/cloud-driven specular reflection (easy win)

Goal: water surface specular should read like a giant mirror of the sky.

- [ ] Add a “specular reflection layer” blended on top of water:
  - `spec = pow(NdotH, gloss)` style (stylized), or a cheaper fresnel-only highlight.
  - Use `depth01` + optional “roughness” to vary gloss (shallow can be glossier).
- [ ] Drive the reflection *color* from sky + clouds:
  - Base: a `uSkyColor` vector that matches the same automation as `SkyColorEffect`.
  - Modulator: a low-res “overhead clouds” texture derived from `CloudEffect`.
- [ ] Proposed “straight-up sky view” source (keep it easy):
  - Reuse `CloudEffect` noise shader with **camera-pinned coordinates** (infinite distance feel).
  - Render to a small `THREE.WebGLRenderTarget` (e.g. 256–512 square): `tCloudSkyView`.
  - Convert density to color using a simple ramp:
    - clear sky: `uSkyColor`
    - cloud: `mix(uSkyColor, uCloudTint, density)`
- [ ] Then in WaterEffect:
  - `reflectionColor = sample(tCloudSkyView, skyUv)`
  - `waterSpecular = reflectionColor * specIntensity * fresnel`
- [ ] Add parameters:
  - `specularIntensity`
  - `specularGloss`
  - `fresnelStrength`
  - `cloudReflectionStrength`
  - `cloudReflectionScale`

Deliverable: water “feels outdoors” and reacts to weather/time-of-day.

### Phase 2c — Sand & grit micro-motion (easy win)

Goal: add a **subsurface layer** that makes water feel like it contains suspended material (murk) and reveals bed texture (sand) without looking like surface foam.

This is a single additional “water sub-layer” computed in the existing `DistortionManager` apply pass (scene-UV pinned).

#### Visual model

- **Murkiness** (suspended silt/algae):
  - Primarily affects **color/contrast/saturation**, not opacity.
  - Stronger in **deeper** regions (default), but artist-controllable.
  - Has low-frequency animated variation so it doesn’t look like a flat overlay.

- **Sand bed detail** (shallow):
  - Warm-ish, subtle **albedo modulation** only.
  - Strongest in **shallow** water.
  - Uses anisotropic noise aligned to a direction (use wind direction for now; later can switch to flow).

#### Controls / parameters (WaterEffect -> DistortionManager)

- Murkiness:
  - `murkEnabled`
  - `murkIntensity` (0..2)
  - `murkColor` (RGB)
  - `murkScale` (world/sceneUv frequency)
  - `murkSpeed` (advection speed)
  - `murkDepthLo`, `murkDepthHi` (depth range where murk ramps in)

- Sand bed:
  - `sandEnabled`
  - `sandIntensity` (0..2)
  - `sandColor` (RGB)
  - `sandScale` (world/sceneUv frequency)
  - `sandSpeed`
  - `sandDepthLo`, `sandDepthHi` (depth range where sand fades out)

#### Implementation notes

- Use `sceneUv`/`waterUv` so patterns stay pinned to the map.
- Multiply both effects by `waterVisible` and the same softened edge mask used by tint/chroma.
- For alias stability:
  - fade out the sand detail when zoomed out (`zoomNorm`) to prevent shimmer.
- Do not add new passes or render targets.

Deliverable: shallow water reads as “over sand/riverbed” and deep water reads as “murky”, even when distortion is subtle.

### Phase 3 — Shoreline foam (mask edge work)

- [x] Compute a shoreline factor from `_Water` gradients (shader-based, used as a helper for caustics).
- [x] Spawn shoreline foam + spray particles from `_Water` edge points (Quarks, CPU scan on texture change).
- [ ] Add `_Shoreline` override support:
  - If `_Shoreline` exists, use it to drive foam thickness and optionally particle spawn density.
  - If not, fall back to derived shoreline/edge points.

Notes:

- The old module had a dedicated foam layer with many controls (blur turbulence, breakup, suppression, crest foam). In Three.js we should treat this as a tiered system:
  - **Low/Med**: particles only (cheaper, cinematic)
  - **High**: optional additional shader foam pass for “continuous” shoreline banding
  - Approach A (fast): sample `_Water` at 4–8 offsets and detect gradient magnitude.
  - Approach B (higher quality): blurred `_Water` minus original to get shoreline band.
- [ ] Optional override: if `_Shoreline` exists, use it to drive foam thickness instead of auto-detection.
- [ ] Render foam as:
  - additive/softlight noise band
  - animated UV noise
- [ ] Parameterize foam width/intensity and allow “only where shallow”.

Deliverable: strong visual improvement; coastlines pop.

### Phase 4 — Caustics (cheap and optional)

- [ ] Fake caustics as a tiled animated pattern modulated by depth.
- [ ] Render only in shallow water:
  - `causticsMask = smoothstep(a,b, depth01)`
- [ ] Optionally couple to scene darkness (like weather does): dim in night.

Deliverable: dramatic shallow-water shimmer without heavy computation.

### Phase 4b — Optional flow direction (easy first, scalable later)

- [ ] **Easy v1:** a global flow vector `uFlowDir` (normalized) + `uFlowSpeed`.
  - Use it to bias:
    - ripple/noise coordinates
    - grit advection
    - foam streak direction (Phase 3)
    - caustics drift (Phase 4)
- [ ] **Upgrade path:** optional `_Flow` mask
  - Encode direction in RG (signed), strength in B (optional).
  - Sample in the water shader and combine with global flow:
    - `flow = normalize(mix(uFlowDir, flowTex.xy*2-1, flowMapStrength))`
  - Treat `_Flow` as data/linear.

Deliverable: rivers/streams can be “directed” without simulation.

### Phase 5 — Quarks particles (foam flecks / bubbles / wakes)

Key rule from prior particle work:

- [ ] Use the **Lookup Map technique** for mask-driven particles:
  - CPU: scan `_Water` once, collect “eligible” pixels as UVs + depth.
  - GPU: vertex shader samples a `DataTexture` position map to place particles.
  - Never do per-frame rejection sampling against the mask.

Particle concepts:

- [ ] **Foam flecks:** spawn near shoreline band (uses derived foam mask / gradient).
- [ ] **Bubbles:** spawn more in deep areas, rise slowly, fade.
- [ ] **Wakes (later):** spawn along token movement paths where `depth01` > threshold.

Deliverable: water feels alive, still performant.

### Phase 6 — Interaction & integration polish

- [ ] Respect roof/overhead masking rules (similar to precipitation dual-mask logic).
- [x] Respect roof/overhead masking rules via `tRoofAlpha` and `tWaterOccluderAlpha` suppression in DistortionManager.
- [ ] Add “NoWater” exclusion concept for authored exclusions (optional `_NoWater`) in addition to `tWaterOccluderAlpha`.
  - dispose render targets
  - rebuild lookup maps when `_Water` changes
  - rebuild lookup maps when `_NoWater` / `_Shoreline` change
- [ ] Add quality tiers:
  - low: distortion only
  - medium: +tint
  - high: +foam +caustics +particles

### Phase 7 — Stutter prevention (prewarm)

- [ ] Prewarm the most expensive water passes during loading overlay (not on first animation frame).
  - Candidate prewarms (depending on which phases are enabled):
    - water composite/apply materials (compile)
    - any downsampled intermediate render targets used for future shoreline/caustics buffers
    - CPU shoreline/edge point generation (already done lazily on first texture use; consider moving to load time)

## Implementation notes (WebGL2)

- [ ] Prefer `THREE.WebGLRenderTarget` with half-float only if supported; otherwise use `UnsignedByteType`.
- [ ] Keep heavy passes downsampled (e.g., foam/caustics at 1/2 res then upsample).
- [ ] Reuse render targets via `EffectComposer.getRenderTarget()`.
- [ ] Ensure no depth writes; most of this is screen-space.

## Open questions (to resolve early)

- [ ] **Does `_Water` use sRGB or linear?**
  - For depth data, linear is preferable.
  - Current AssetLoader tags most masks as sRGB unless in `[normal, roughness]`.
  - We likely want `_Water` treated as data/linear.
- [ ] **Does water need a dedicated normal/flow map?**
  - Could be optional later (`_WaterNormal`, `_Flow`, etc.).
- [ ] **Where should “sky reflection” come from?**
  - Cheapest: derive `uSkyColor` from the same automation as `SkyColorEffect` and use `CloudEffect` density as a multiplier.
  - Nicer: render a dedicated low-res `tCloudSkyView` from `CloudEffect` (camera-pinned coordinates).
- [ ] **How to handle multiple water bodies (separate depth ranges)?**
  - Likely not needed; keep it artist-driven.

## Progress log (small chunks)

- [x] Found `DistortionManager` already has `tWaterMask`/`uWaterEnabled` and `waterRipple()`.
- [x] Found AssetLoader uses suffix masks and `_Water` is enabled.
- [x] Old module used blurred water mask for shoreline detection, with optional `_Shoreline` override and optional `_NoWater` exclusion.
- [x] Water uses sceneUv convention so it stays pinned and aligned.
- [ ] Next: implement `_Shoreline` override and `_NoWater` authored exclusion as first-class masks.
