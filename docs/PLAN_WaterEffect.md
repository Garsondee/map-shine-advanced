# PLAN: WaterEffect (WebGL2)

## Constraints / Non-Goals

- [ ] **Renderer constraint:** WebGL 2.0 only (no WebGPU features, no compute shaders).
- [ ] **Engine constraint:** Three.js rendering is authoritative; avoid PIXI rendering paths for the effect.
- [ ] **Non-goal:** Photoreal water simulation (no Navier–Stokes, no fluid sim).
- [ ] **Goal:** A high-impact, performant “stylized water” system that reads a `_Water` mask texture.

## Rough reference notes from the old module (concepts only)

- [x] Old module treated “water” as a **multi-layered screen-space composite** (distortion + tint + foam + caustics), not a simulation.
- [x] It supported:
  - `_Water` as the primary mask.
  - optional `_Shoreline` override, otherwise **auto shoreline detection**.
  - `_NoWater` exclusion mask to prevent distortion on specific tiles (trees, etc.).
- [x] It explicitly **prewarmed** water render textures during loading to avoid first-frame stalls.

We should keep these *behaviors* but implement them cleanly in the Three/WebGL2 pipeline.

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
  - `_Water` entry is currently commented out.
- [x] **Scene bundle wiring exists:** `SceneComposer.initialize()` returns `bundle.masks`.
- [x] **A distortion path already has a ‘water’ slot:** `DistortionManager` has `tWaterMask`, `uWaterEnabled`, `waterRipple()`.

Notes:

- [ ] `DistortionManager` currently samples `tWaterMask` using `vUv`. For consistency with the heat path (scene-locked masks), we probably want water to use the same `sceneUv` mapping (and matching Y flip) so ripples stay pinned to the map and align to `_Water` exactly.

Planned wiring steps:

- [ ] **Enable `_Water` loading** in `EFFECT_MASKS` (AssetLoader).
- [ ] **Expose `_Water` texture** from the `SceneComposer` bundle.
- [ ] **Introduce a real `WaterEffect`** (not the stub) that:
  - registers a distortion source in `DistortionManager` (`id: 'water'`).
  - provides additional optional passes (foam, caustics, color grading) as the plan advances.

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

- [ ] Add `_Water` mask loading (uncomment/add `water: { suffix: '_Water', ... }` in AssetLoader).
- [ ] Add a simple debug mode that draws:
  - depth01 as grayscale overlay.
  - water/no-water threshold.
- [ ] Confirm UV orientation (Y flip) matches authored textures.
- [ ] Add an optional `_Shoreline` mask loading hook (future-proof), but keep it disabled until Phase 3.
- [ ] Add an optional `_NoWater` mask loading hook (future-proof), but keep it disabled until Phase 6.

Deliverable: you can see the water mask aligned perfectly.

### Phase 1 — MVP: Water distortion only

- [ ] Implement real `WaterEffect` (WebGL2 `ShaderMaterial` full-screen pass or via `DistortionManager`).
- [ ] Register distortion source:
  - mask: `_Water`
  - intensity: scaled by `depth01`
  - noise: existing `waterRipple()` in `DistortionManager`.
- [ ] Ensure water distortion is **scene-UV pinned** (same convention as heat), not screen-UV.
- [ ] Add parameters:
  - `distortionIntensity`
  - `frequency`
  - `speed`
  - `depthToDistortionCurve` (simple power or remap)

Deliverable: water areas shimmer/move convincingly at low cost.

### Phase 1b — Chromatic refraction (RGB split) (easy win)

- [ ] Add “RGB split refraction” to the water distortion application:
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

- [ ] Add a post-process (or scene pass) that blends a water color under `_Water`.
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

Goal: keep shallow water from looking static by adding subtle sub-surface motion.

- [ ] Add a cheap “micro-detail” pattern under water, strongest in shallow regions:
  - `shallowMask = smoothstep(shallowA, shallowB, 1.0 - depth01)`
  - Use 1–2 octaves of noise (or a small tiling texture) advected over time.
- [ ] Make it read as *bed detail*, not surface foam:
  - affect tint/albedo slightly (not alpha)
  - optionally modulate distortion intensity very subtly
- [ ] Add parameters:
  - `gritIntensity`
  - `gritScale`
  - `gritSpeed`
  - `gritShallowOnly`

Deliverable: shallow water has life even with low ripple speeds.

### Phase 3 — Shoreline foam (mask edge work)

- [ ] Compute foam mask from `_Water`:
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
- [ ] Add “NoWater” exclusion concept for tiles that should not distort (optional `_NoWater`).
- [ ] Add scene-change lifecycle:
  - dispose render targets
  - rebuild lookup maps when `_Water` changes
- [ ] Add quality tiers:
  - low: distortion only
  - medium: +tint
  - high: +foam +caustics +particles

### Phase 7 — Stutter prevention (prewarm)

- [ ] Prewarm the most expensive water passes during loading overlay (not on first animation frame).
  - Candidate prewarms (depending on which phases are enabled):
    - shoreline blur buffer
    - caustics buffer
    - any downsampled intermediate render targets

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
- [x] Found AssetLoader uses suffix masks and `_Water` is currently commented out.
- [x] Old module used blurred water mask for shoreline detection, with optional `_Shoreline` override and optional `_NoWater` exclusion.
- [ ] Next: decide UV convention (sceneUv vs vUv) for water distortion so it stays pinned and aligned.
