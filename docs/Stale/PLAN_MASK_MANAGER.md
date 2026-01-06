# PLAN — Mask Manager

## Why this exists

Mask usage is becoming a “cross-cutting concern” across the whole renderer:

- `_Outdoors` is used for weather gating, indoor/outdoor classification, and lighting/occlusion logic.
- `LightingEffect.roofAlphaTarget` is a screen-space roof visibility mask used by multiple systems.
- `DistortionManager` has grown mask responsibilities: world↔screen coordinate mapping, blur utilities, and ad-hoc mask routing (`tHeatMask`, `tWaterMask`, etc.).
- Multiple effects need *combinations* of masks (e.g. “outdoors AND not roof-visible”, “water AND outdoors”, “window light indoors only”, etc.).

We need a dedicated **MaskManager** to be the grand central station for:

- canonical mask coordinate conventions
- mask lifecycle and caching
- robust GPU mask processing (blur, thresholds, unions, intersections, etc.)
- optional CPU-side sampling / lookup-map generation (spawn-time tagging patterns)
- debug/inspection tooling

This will let `DistortionManager` focus on *distortion* again, and lets other effects share mask work safely.

---

## Core goals

- [ ] Provide a **single authoritative way** to reference a mask by ID and ask for:
  - a GPU `THREE.Texture` in a known coordinate space
  - optional CPU sampler for O(1) “what is the mask at (u,v)?” queries
- [ ] Provide a **mask processing pipeline** (GPU) that can build derived masks:
  - combine (union / intersection / subtract)
  - invert
  - threshold / smoothstep
  - blur / dilate / erode
  - edge/gradient/shores (basic derivatives)
  - downsample / upsample
- [ ] Provide **stable coordinate mapping rules** between:
  - screen UV (`vUv`)
  - Foundry world coords (top-left origin, Y-down)
  - Three world coords (Y-up)
  - scene-rect UV (`sceneUv`) used for authored suffix masks
- [ ] Avoid per-frame CPU work; prefer GPU caching. CPU extraction is allowed only when necessary (e.g., particle spawn tagging or lookup-map creation).
- [ ] Be robust with resize, DPR changes, and scene swaps.
- [ ] Integrate with existing rendering architecture: Three.js is authoritative (per `threejs.md`).

---

## Non-goals (for v1)

- [ ] No compute shaders / WebGPU-only features.
- [ ] No “universal pixel-perfect Foundry parity” for every mask case; we define module conventions and stick to them.
- [ ] No general-purpose material graph editor UI (debug tooling only).

---

## Existing mask landscape (current state)

### Author-authored suffix masks (scene space)

These are textures loaded from assets and aligned to the scene rectangle.

- `_Outdoors` (wired into `WeatherController.roofMap`)
- `_Fire` (FireSparks lookup-map + distortion heat mask)
- `_Water` (WaterEffect distortion, tint, caustics)
- `_Specular`, `_Roughness`, `_Normal`, etc. (material pipeline)

### Runtime-generated masks

- `LightingEffect.roofAlphaTarget`: screen-space roof visibility/opacity (Layer 20 prepass)
- Fog/vision textures (WorldSpaceFogEffect / vision bridges)
- Cloud shadow target, building/overhead shadow targets (when enabled)

### Ad-hoc mask processing (to be migrated)

- `DistortionManager.blurMask()` (GPU blur utility)
- CPU-side extraction/sampling:
  - `WeatherController._extractRoofMaskData()` and `getRoofMaskIntensity()`
  - `TileManager._extractMaskData()` (window/outdoors gating)
- “mask logic embedded in shaders” in multiple places:
  - WeatherParticles dual-mask gating (roof alpha + outdoors)
  - Distortion composite/apply shaders

---

## Research findings (grounding in current code)

### 1) AssetLoader mask color space rules (important)

In `scripts/assets/loader.js`, masks are currently assigned color space like this:

- **Data/linear**: `normal`, `roughness`, `water`
- **sRGB**: everything else (`outdoors`, `fire`, `windows`, etc.)

This means the Mask Manager cannot assume “all masks are linear data” today.
If we want all masks to behave as data, that would be a deliberate migration.

### 2) There are already TWO outdoors representations

We currently have:

- **Scene-space authored outdoors**: `_Outdoors` loaded by AssetLoader and used in many world-space UV computations.
- **Screen-space outdoors projection**: `LightingEffect.outdoorsTarget`
  - Rendered every frame by drawing the base plane with the outdoors texture using the main camera.
  - This allows `LightingEffect` (and others, e.g. `SkyColorEffect`) to sample outdoors with plain `vUv` without world-space pinning errors.

MaskManager should treat these as distinct masks (same semantic “outdoors”, different `space`).

### 3) Screen-space roof alpha is a first-class runtime mask

`LightingEffect.roofAlphaTarget` is rendered every frame from `ROOF_LAYER` (20) using the main camera.

Multiple systems already depend on it (lighting occlusion, precipitation dual-mask visibility, distortion roof masking).

### 4) RenderTarget pooling constraints

`EffectComposer.getRenderTarget(name, ...)` currently:

- creates targets with `RGBAFormat` + `FloatType`
- caches by name

But many masks should be `UnsignedByteType` (or even single-channel) for bandwidth/perf, and LightingEffect already uses `UnsignedByteType` for `roofAlphaTarget` and `outdoorsTarget`.

Therefore MaskManager will likely need either:

- its own RT pool for mask targets, or
- an extension to `EffectComposer.getRenderTarget` to allow format/type options (so MaskManager can reuse the same pooling mechanism).

---

## Three.js best practices to enforce (MaskManager-specific)

### 1) Color management: keep display and data paths separate

- Renderer is configured with `renderer.outputColorSpace = SRGBColorSpace` and `renderer.toneMapping = NoToneMapping`.
- MaskManager should treat most masks as **data**, not “colors”, even if AssetLoader currently loads some as sRGB.

Practical rule for v1:

- MaskManager must store/forward a mask’s **declared color space** and make consumers explicit about whether they are sampling:
  - “as authored color” (rare), or
  - “as scalar data” (common).

### 2) RenderTarget formats: use the smallest format/type that matches the job

Observed patterns already in the codebase:

- Lighting accumulation uses `HalfFloatType` (HDR-ish)
- Most masks use `UnsignedByteType`
- Fog exploration uses `RedFormat` + `UnsignedByteType`

MaskManager guidance:

- Prefer `RedFormat` + `UnsignedByteType` for single-channel masks when supported.
- Prefer `UnsignedByteType` for boolean/thresholded masks and lookups.
- Use `HalfFloatType` only when we need intermediate precision (e.g. multi-pass blur, gradients).

### 3) Disable unused attachments on mask targets

For mask-like `WebGLRenderTarget`s, explicitly disable features we don’t need:

- `depthBuffer: false`
- `stencilBuffer: false`
- `generateMipmaps: false`

This reduces GPU memory and avoids hidden work.

### 4) Texture orientation: treat flipY as metadata, not tribal knowledge

- `WebGLRenderTarget.texture` is effectively screen-space and treated as `uvFlipY: false`.
- Suffix mask textures may require Y-inversion depending on how UVs are derived.

MaskManager should own this as an explicit `uvFlipY` flag and provide canonical sampling helpers so effects stop doing one-off Y fixes.

---

## Key design decision: “Mask Space” and mapping

MaskManager must label every mask with a **space** (how it is meant to be sampled):

- **`sceneUv`**: UVs in the scene rectangle, authored suffix masks. (0..1 over `canvas.dimensions.sceneRect`)
- **`screenUv`**: UVs in the renderer drawing buffer / post-process quad. (0..1 over frame)
- **`foundryWorld`**: world positions in Foundry pixel coords (top-left origin, Y-down)
- **`threeWorld`**: world positions in Three coords (Y-up)

MaskManager must provide canonical helper mapping functions (CPU + GLSL snippets) so every effect does the same thing.

### Proposed canonical rule

- A suffix mask is sampled in **scene UV** derived from Foundry world coords:
  - `sceneUv = (foundryPos - sceneRect.xy) / sceneRect.zw`
  - Many masks need a Y-flip depending on how they are loaded; MaskManager centralizes this as metadata.

- A screen-space render target (roof alpha) is sampled via:
  - `screenUv = gl_FragCoord.xy / uScreenSize`
  - (not `vUv` if the target is tied to drawing buffer resolution and we care about DPR correctness)

---

## MaskManager responsibilities

### 1) Registry

Maintain a registry of named masks and their metadata.

**Mask record** should include:

- `id`
- `type` (semantic tags: `outdoors`, `roofAlpha`, `water`, `fire`, `vision`, `shadow`, etc.)
- `space` (`sceneUv` / `screenUv` / `threeWorld` / `foundryWorld`)
- `texture` (GPU)
- `channels` (e.g. `r`, `a`, `luma`, or custom decode)
- `colorSpace` (`linear` vs `sRGB`), with an explicit default for masks: **linear/data**
- `uvFlipY` (bool) for authored textures
- `resolutionPolicy`:
  - `native` (use texture’s own res)
  - `full` (match drawing buffer)
  - `half` / `quarter`
  - `fixed(N)`
- `lifecycle`:
  - `staticPerScene` (rebuilt on scene change)
  - `dynamicPerFrame` (rebuilt on each frame or when dirty)

Additionally (based on current engine needs), the record should include:

- `source`:
  - `assetMask` (suffix texture)
  - `renderTarget` (produced by an effect)
  - `derived` (MaskManager-produced)
- `format/type` preferences for derived outputs (`UnsignedByteType` vs `HalfFloatType` etc.)

### 2) Derived mask graph

Provide a way to declare a derived mask as a **graph recipe** instead of embedding it in random effects.

Examples:

- `precipVisibilityMask = roofVisible OR outdoors`
- `indoorMask = invert(outdoors)`
- `waterOutdoors = water AND outdoors`
- `heatUnderRoof = heat AND invert(roofAlpha)` (or the inverse, depending on semantics)

The graph must support:

- node types: `input`, `binaryOp`, `unaryOp`, `filter`, `warp` (optional)
- caching: avoid re-rendering nodes unless inputs changed
- render target reuse: ping-pong + pooled RTs via `EffectComposer.getRenderTarget()` (preferred pattern)

### 3) GPU processing passes (core ops)

Minimum operation set for v1:

- **Unary**
  - `invert`
  - `threshold(lo, hi)` / `smoothstep(lo, hi)`
  - `gain/bias`
  - `clamp`

- **Binary**
  - `max` (union)
  - `min` (intersection)
  - `add` (with clamp)
  - `sub` (difference)
  - `mul`

- **Filters**
  - `blurGaussian(radius, passes)` (separable, like DistortionManager)
  - `dilate/erode` (optional v1b; can be approximated via max/min filters)

- **Edge / gradient helpers** (optional v1b)
  - `gradientMagnitude` for shoreline-style detection

All passes should be full-screen quad renders to a target in a predictable space (usually `sceneUv` or `screenUv`).

### 4) CPU extraction + samplers

Provide opt-in CPU samplers for masks where needed:

- Roof/outdoors sampling for spawn-time tagging (`WeatherController.getRoofMaskIntensity` pattern)
- Particle lookup-map generation (per the Lookup Map technique memory)

Rules:

- CPU extraction is **never per-frame**.
- CPU data must be cached with clear invalidation (scene change / texture change).
- CPU sampling must document its UV convention (top-left vs bottom-left) and be consistent with the GPU decode.

### 5) Debug tooling

This system will be central; it must be inspectable.

- A global API to list masks and show metadata.
- A debug overlay mode to render a chosen mask on screen:
  - view raw channel
  - view thresholded
  - view derived node outputs
- Optional pixel inspector (click to print mask values at cursor in multiple spaces).

---

## Proposed public API (draft)

### Construction / ownership

MaskManager should be owned by the core runtime (`canvas-replacement.js` / EffectComposer lifecycle), similar to WeatherController and DistortionManager.

### Registration

```js
maskManager.registerTextureMask({
  id: 'outdoors',
  type: 'outdoors',
  texture,                 // THREE.Texture
  space: 'sceneUv',
  channels: 'r',
  uvFlipY: true,
  colorSpace: 'linear',
  lifecycle: 'staticPerScene'
});

maskManager.registerRenderTargetMask({
  id: 'roofAlpha',
  type: 'roofAlpha',
  texture: lightingEffect.roofAlphaTarget.texture,
  space: 'screenUv',
  channels: 'a',
  uvFlipY: false,
  lifecycle: 'dynamicPerFrame'
});
```

### Derived masks (graph)

```js
maskManager.defineDerivedMask('indoor', {
  op: 'invert',
  input: 'outdoors'
});

maskManager.defineDerivedMask('precipVisibility', {
  op: 'max',
  a: 'roofAlphaVisible',
  b: 'outdoors'
});

maskManager.defineDerivedMask('roofAlphaVisible', {
  op: 'threshold',
  input: 'roofAlpha',
  lo: 0.1,
  hi: 1.0
});
```

### Rendering / retrieval

```js
const tex = maskManager.getTexture('precipVisibility');

// Explicitly request a specific output space/resolution
const tex2 = maskManager.getTexture('precipVisibility', { space: 'screenUv', resolution: 'half' });

// Optional CPU sampling
const sampler = await maskManager.getCpuSampler('outdoors');
const v = sampler.sample01(u, v);
```

### Update hooks

- `maskManager.onResize(width, height)`
- `maskManager.onSceneChanged(bundle)`
- `maskManager.update(timeInfo)` for any time-driven mask generation (rare; most masks are static).

---

## Integration plan with existing systems

### DistortionManager

- DistortionManager should stop owning generic mask utilities.
- It should consume a small set of inputs from MaskManager:
  - `heatMaskExpanded`
  - `waterMask`
  - any future magical masks
- MaskManager becomes the place where blur/expand/dilate occurs for distortion masks.

### WeatherParticles / FireSparksEffect

- Both currently patch materials and sample `uRoofMap` + `uRoofAlphaMap`.
- MaskManager can provide:
  - canonical UV mapping GLSL snippets
  - a derived `precipVisibility` mask if we decide to unify that logic as a single texture

Important: for particles, it may still be cheaper to keep the current shader logic (two texture reads) instead of introducing an extra pass. The MaskManager should support both approaches:

- either “computed mask texture” route
- or “provide consistent inputs + mapping helpers” route

### Lighting / shadows / clouds

- Cloud shadows and overhead/building shadows are already framed as texture producers.
- MaskManager can register those outputs and allow other effects (Specular, Water caustics gating, WindowLight) to reference them by ID.

### WeatherController

- WeatherController remains the canonical *weather state*.
- MaskManager becomes the canonical *mask state*.
- Roof/outdoors CPU extraction can either:
  - remain in WeatherController but be fed by MaskManager, or
  - be moved into MaskManager with WeatherController calling `maskManager.getCpuSampler('outdoors')`.

v1 recommendation: **feed WeatherController from MaskManager** but keep the CPU extraction in one place (decide after first implementation pass).

---

## Migration map (what moves where, and when)

This section is the practical “do this first” path to avoid a huge refactor.

### Stage 0 (no refactors): register what already exists

- **Register authored suffix masks** from the bundle (`SceneComposer.currentBundle.masks`):
  - `_Outdoors` (sceneUv)
  - `_Fire` (sceneUv)
  - `_Water` (sceneUv)
  - `_Windows` / `_Structural` (sceneUv)
- **Register runtime masks produced by LightingEffect**:
  - `roofAlphaTarget` (screenUv)
  - `outdoorsTarget` (screenUv)

Deliverable: effects can start querying by ID instead of holding local references.

### Stage 1 (low risk, high leverage): unify naming + access

- **Do not change shaders yet.** Just standardize how effects obtain the same textures.
- Preferred IDs (example):
  - `outdoors.scene`  → authored `_Outdoors` texture
  - `outdoors.screen` → `LightingEffect.outdoorsTarget.texture`
  - `roofAlpha.screen` → `LightingEffect.roofAlphaTarget.texture`

Rationale: we already know some consumers want scene-pinned sampling and others want screen-UV sampling.

### Stage 2: migrate generic blur/threshold utilities out of DistortionManager

Move these responsibilities into MaskManager:

- **Separable blur pass** (current `DistortionManager.blurMask`)
- **Threshold/smoothstep/invert** ops as first-class nodes

Keep in DistortionManager:

- the distortion composite/apply shaders
- distortion-specific noise functions

Deliverable: DistortionManager consumes derived masks (e.g. `fire.heatExpanded.scene`), instead of owning preprocessing.

### Stage 3: formalize “mask spaces” and stop re-implementing mapping snippets

MaskManager should become the canonical place for:

- `screenUv -> foundryWorld -> sceneUv` mapping rules used in multiple post passes (Distortion, Water, future post effects)
- `gl_FragCoord / screenSize` sampling rule for screen-space RTs

Non-goal for this stage:

- rewriting all effects to depend on MaskManager-provided GLSL chunks immediately (that’s a long tail). Start with new effects and touch old ones only when you’re already editing them.

### Stage 4: decide per-system whether “derived combined mask textures” are worth it

Some systems are likely *better* staying as “multiple texture reads + a little logic”:

- **WeatherParticles dual mask** (`_Outdoors` + roofAlphaTarget):
  - Very cheap to sample two textures in the particle shader.
  - A precomputed `precipVisibility` mask would add an extra fullscreen pass.

So the decision rule should be:

- If a mask combination is used by many consumers *and* is expensive/duplicated → derive it once.
- If it is used by one consumer and the shader logic is already simple → keep it in-shader.

### Stage 5: migrate CPU samplers to MaskManager (optional)

Candidates:

- Roof/outdoors CPU sampling currently in `WeatherController` (`_extractRoofMaskData`, `getRoofMaskIntensity`).

Keep the existing behavior until MaskManager has:

- a clear CPU cache invalidation story
- a settled convention for UV orientation (so CPU samples match GPU samples)

### Stage 6: masks as cross-effect outputs

MaskManager should ultimately register and expose the following “mask-like” RTs by ID:

- `cloudShadowTarget` (CloudEffect)
- `overheadShadowTarget` / `buildingShadowTarget` (shadow effects)
- `vision` / `explored` (WorldSpaceFogEffect)

Note: Fog is world-space; it’s valid for MaskManager to *catalog* these textures, but not necessarily to own their rendering.

---

## Implementation checklist (by effect)

This is the concrete, per-effect punch list for moving the renderer to the MaskManager model.

Legend (per effect):

- **Consumes**: mask inputs the effect samples
- **Produces**: mask-like outputs the effect renders (RTs) that other effects should reference
- **Checklist**: implementation steps for MaskManager integration

### SpecularEffect (`specular`)

- **Consumes**:
  - `_Specular` (sceneUv)
  - `_Roughness` (sceneUv)
  - `_Normal` (sceneUv)
  - `cloudShadowTarget` (screenUv) (from CloudEffect)
- **Produces**: none
- **Checklist**:
  - [ ] Replace direct bundle mask lookups with `maskManager.getTexture('specular.scene')`, `roughness.scene`, `normal.scene` (exact IDs TBD).
  - [ ] Replace direct `window.MapShine?.cloudEffect` sampling with `maskManager.getTexture('cloudShadow.screen')` (or equivalent).
  - [ ] Ensure Specular’s sampling intent is explicit: these are *data* maps (normal/roughness/specular), not “color masks”.

### IridescenceEffect (`iridescence`)

- **Consumes**:
  - `_Iridescence` (sceneUv)
  - (any shared masks referenced in shader, if present)
- **Produces**: none
- **Checklist**:
  - [ ] Replace bundle lookups with MaskManager IDs.
  - [ ] Ensure `colorSpace` expectation is declared (mask-as-data vs mask-as-color).

### WindowLightEffect (`window-light`)

- **Consumes**:
  - `_Windows` and/or `_Structural` (sceneUv)
  - `roofAlpha.screen` (from LightingEffect) when gating window light vs roofs (if used)
- **Produces**:
  - `windowLightTarget` (screenUv) (if the effect renders an RT for particles/materials)
- **Checklist**:
  - [ ] Register the produced window-light RT in MaskManager (if one exists).
  - [ ] Replace bundle mask lookups (`windows/structural`) with MaskManager IDs.
  - [ ] If sampling roof alpha, resolve via MaskManager rather than `window.MapShine.lightingEffect`.

### ColorCorrectionEffect (`color-correction`)

- **Consumes**: none (operates on `tDiffuse`)
- **Produces**: none
- **Checklist**:
  - [ ] No MaskManager work expected (unless you add mask-driven grading later).

### AsciiEffect (`ascii`)

- **Consumes**: none (operates on `tDiffuse`)
- **Produces**: none
- **Checklist**:
  - [ ] No MaskManager work expected.

### PrismEffect (`prism`)

- **Consumes**:
  - `_Prism` (sceneUv)
- **Produces**: none
- **Checklist**:
  - [ ] Replace bundle lookups with MaskManager IDs.
  - [ ] Ensure shader uses canonical sceneUv mapping helpers (when added).

### WaterEffect (`water`)

- **Consumes**:
  - `_Water` (sceneUv) (data)
- **Produces**:
  - Distortion source mask(s) for DistortionManager (currently passed directly)
- **Checklist**:
  - [ ] Register `_Water` as `water.scene` in MaskManager with explicit `colorSpace: linear/data`.
  - [ ] Change WaterEffect to resolve the water mask via MaskManager.
  - [ ] (Phase 2/3) If WaterEffect needs blurred/expanded variants, define them as derived masks in MaskManager rather than ad-hoc preprocessing.

### WorldSpaceFogEffect (`fog`)

- **Consumes**:
  - Vision mask (world-space) as an internal input
  - Exploration mask (world-space) as an internal input
- **Produces**:
  - `vision.world` (world/sceneUv equivalent) (RT)
  - `explored.world` (world/sceneUv equivalent) (RT)
- **Checklist**:
  - [ ] Register the fog RTs with MaskManager for other effects to reference if needed (debug overlays, future effects).
  - [ ] Clearly label the fog targets’ sampling `space` (world/scene pinned, not screenUv).
  - [ ] Keep ownership of rendering inside WorldSpaceFogEffect (MaskManager catalogs; does not drive fog generation).

### LightingEffect (`lighting`)

- **Consumes**:
  - `_Outdoors` (sceneUv) as authored input to build `outdoorsTarget`
  - `overheadShadowTarget` (from OverheadShadowsEffect)
  - `buildingShadowTarget` (from BuildingShadowsEffect)
- **Produces**:
  - `roofAlpha.screen` (`roofAlphaTarget`)
  - `outdoors.screen` (`outdoorsTarget`)
  - (optionally) light accumulation target (HDR-ish) (not a “mask” but may be cataloged later)
- **Checklist**:
  - [ ] On init, register `roofAlphaTarget.texture` and `outdoorsTarget.texture` with MaskManager (as `screenUv`, `UnsignedByteType`).
  - [ ] Resolve `overheadShadowTarget` / `buildingShadowTarget` via MaskManager IDs instead of `window.MapShine.*` direct references.
  - [ ] Ensure any mask sampling in the composite shader is explicit about `screenUv` conventions (prefer `gl_FragCoord / screenSize` when DPR correctness matters).

### BushEffect (`bush`)

- **Consumes**:
  - Any authored masks it references (often `_Bush` RGBA texture; may be treated as color+alpha)
  - Shadow targets (if it samples them)
- **Produces**:
  - Potential shadow target(s) (if it renders them)
- **Checklist**:
  - [ ] If BushEffect produces any RTs consumed elsewhere, register them.
  - [ ] If it consumes cloud/building/overhead shadows, resolve via MaskManager IDs.
  - [ ] Ensure `_Bush` is treated as color+alpha (not a scalar mask) if that is the intended semantics.

### TreeEffect (`tree`)

- **Consumes**:
  - Any authored masks/textures it references (often `_Tree` RGBA)
  - `roofAlpha.screen` if it uses roof masking
- **Produces**: none
- **Checklist**:
  - [ ] Resolve roof alpha via MaskManager IDs.
  - [ ] Ensure tree texture(s) are not accidentally treated as “mask data”.

### OverheadShadowsEffect (`overhead-shadows`)

- **Consumes**:
  - `_Outdoors` (sceneUv) (for gating)
  - `roofAlpha.screen` (or it may render its own roof stamp)
- **Produces**:
  - `overheadShadow.screen` (`shadowTarget`)
- **Checklist**:
  - [ ] Register `shadowTarget.texture` in MaskManager.
  - [ ] Resolve `_Outdoors` and/or `roofAlpha.screen` via MaskManager IDs.
  - [ ] When MaskManager blur ops exist, consider moving softness/blur into derived-mask ops (only if multiple consumers need the same blur).

### BuildingShadowsEffect (`building-shadows`)

- **Consumes**:
  - `_Outdoors` (sceneUv)
- **Produces**:
  - `buildingShadow.screen` (`shadowTarget`)
  - `buildingShadow.world` (`worldShadowTarget`) (cached/baked)
- **Checklist**:
  - [ ] Register produced targets with MaskManager (both screen + world variants, if both are used).
  - [ ] Resolve `_Outdoors` via MaskManager IDs.
  - [ ] Ensure target formats are appropriate (byte mask or half-float only if needed).

### CloudEffect (`cloud`)

- **Consumes**:
  - `_Outdoors` (sceneUv) (for gating)
- **Produces**:
  - `cloudDensity.world`/`cloudDensity.screen` (depending on implementation)
  - `cloudShadow.screen` (`cloudShadowTarget`)
  - cloud top targets (if enabled)
- **Checklist**:
  - [ ] Register `cloudShadowTarget.texture` with MaskManager (most common consumer).
  - [ ] If other cloud targets are used cross-effect, register them too.
  - [ ] Resolve `_Outdoors` via MaskManager IDs.

### DistortionManager (`distortion-manager`)

- **Consumes**:
  - Distortion source masks: `water.scene`, `fire.scene` (heat), future masks
  - `roofAlpha.screen` (for `UNDER_OVERHEAD` masking)
- **Produces**:
  - internal distortion composite targets (not necessarily exposed)
- **Checklist**:
  - [ ] Resolve `roofAlpha.screen` via MaskManager IDs (stop referencing LightingEffect directly).
  - [ ] Change source registration so sources can register by mask ID (MaskManager texture) rather than passing raw textures.
  - [ ] (Phase 3) Migrate `blurMask()` into MaskManager and treat “expanded heat mask” as a derived mask.
  - [ ] Ensure distortion composite targets use appropriate formats (likely half-float/float), distinct from mask targets.

### BloomEffect (`bloom`)

- **Consumes**: none (post-process)
- **Produces**: none
- **Checklist**:
  - [ ] No MaskManager work expected.

### LensflareEffect (`lensflare`)

- **Consumes**: (likely) brightness / light buffers, not masks
- **Produces**: none
- **Checklist**:
  - [ ] No MaskManager work expected unless it gates by outdoors/roof in the future.

### SkyColorEffect (`sky-color`)

- **Consumes**:
  - `outdoors.screen` (`LightingEffect.outdoorsTarget.texture`)
- **Produces**: none
- **Checklist**:
  - [ ] Resolve `outdoors.screen` via MaskManager IDs instead of `window.MapShine?.lightingEffect`.
  - [ ] Keep outdoors sampling in screenUv (this effect is explicitly screen-space).

### ParticleSystem (`particles`) + WeatherParticles

- **Consumes**:
  - `roofAlpha.screen`
  - `_Outdoors` (sceneUv) or `outdoors.screen` depending on shader strategy
- **Produces**: none
- **Checklist**:
  - [ ] Replace `window.MapShine.lightingEffect.roofAlphaTarget` access with MaskManager lookup.
  - [ ] Decide and document which outdoors representation WeatherParticles should use:
    - keep current world-space / sceneUv approach, or
    - switch to `outdoors.screen` for simpler `vUv` sampling.
  - [ ] Keep dual sampling in the particle shader (likely cheaper than a derived combined mask).

### FireSparksEffect (`fire-sparks`)

- **Consumes**:
  - `_Fire` (sceneUv) for spawn distribution
  - (heat distortion) derived/boosted fire mask
- **Produces**:
  - heat distortion source mask (passed to DistortionManager)
- **Checklist**:
  - [ ] Resolve `_Fire` via MaskManager IDs.
  - [ ] Preserve the lookup-map technique (CPU scan once → DataTexture position map → GPU sampling) for spawn placement.
  - [ ] (Phase 3) Move “boosted heat mask” creation into MaskManager derived ops (threshold/blur/gain) so DistortionManager gets a canonical derived heat mask.

### SmellyFliesEffect (`smelly-flies`)

- **Consumes**:
  - Potentially outdoors/window gating masks if enabled (depends on current implementation)
- **Produces**: none
- **Checklist**:
  - [ ] If it uses any mask gating, route through MaskManager (no direct bundle lookups).

### DustMotesEffect (`dust-motes`)

- **Consumes**:
  - `_Dust` (sceneUv)
  - window light texture (if used)
- **Produces**: none
- **Checklist**:
  - [ ] Resolve `_Dust` via MaskManager IDs.
  - [ ] If using `windowLightTarget`, resolve it via MaskManager IDs (and ensure WindowLightEffect registers it).

### Not currently registered (audit-only)

- **FogEffect / FogEffect.old**:
  - [ ] No integration needed unless re-enabled; if re-enabled, it must be treated as a producer/consumer like WorldSpaceFogEffect.

---

## Performance / correctness requirements

- **No per-frame allocations in hot paths** (follow existing project pattern).
- **RenderTarget pooling**: reuse intermediate RTs; do not create/destroy per frame.
  - Note: `EffectComposer.getRenderTarget` is currently FloatType-only, so MaskManager needs a plan for pooling non-float mask targets.
- **Dirty tracking**:
  - derived masks re-render only when inputs or parameters change
  - dynamic masks (roof alpha) update in their owning effect and only update MaskManager’s references
- **DPR correctness**:
  - screen-space masks sampled using `gl_FragCoord / uScreenSize` where needed
- **Time correctness**:
  - any animated mask uses `TimeManager` (`timeInfo.elapsed`) per the time system memory

---

## File structure (proposal)

- `scripts/masks/MaskManager.js` (new)
- `scripts/masks/MaskOps.js` (optional: op definitions + small GLSL snippets)
- `scripts/masks/MaskDebugEffect.js` (optional: debug overlay)

Wiring:

- `scripts/foundry/canvas-replacement.js` creates and exposes `window.MapShine.maskManager`.
- Effects register their masks (and query derived masks) through this manager.

---

## Rollout phases

### Phase 1 — Minimal registry + coordinate conventions

- [ ] Implement MaskManager registry (inputs only, no derived graph yet).
- [ ] Define and document canonical mapping functions.
- [ ] Register:
  - `_Outdoors` (sceneUv)
  - `outdoorsTarget` (screenUv) from `LightingEffect` (already exists)
  - `roofAlphaTarget` (screenUv)
  - `_Fire`, `_Water` (sceneUv)

Deliverable: single place to ask “what mask texture is X?” with correct metadata.

### Phase 2 — Derived mask graph MVP

- [ ] Implement a small graph system (DAG) with caching.
- [ ] Implement core ops: invert, threshold, min/max, mul.
- [ ] Provide derived masks:
  - `indoor = invert(outdoors)`
  - `roofVisible = threshold(roofAlpha)`
  - (optional) `precipVisibility = max(roofVisible, outdoors)`

Deliverable: effects stop re-implementing common boolean mask logic.

### Phase 3 — GPU filters + migration off DistortionManager

- [ ] Add blur support (move/duplicate `DistortionManager.blurMask` into MaskManager).
- [ ] Provide “expanded” variants:
  - `heatExpanded = blur(threshold(fireMask))` (or other recipe)

Deliverable: DistortionManager no longer has generic mask processing.

### Phase 3b — Formalize pooled mask render targets

- [ ] Decide and implement one of:
  - MaskManager-managed RT pool for `UnsignedByteType` / mask-specific formats, or
  - extend `EffectComposer.getRenderTarget` to accept `{ format, type, depthBuffer }` options.

Deliverable: derived masks don’t accidentally allocate FloatType full-res targets when a byte mask would do.

### Phase 4 — Debug overlay tooling

- [ ] Implement mask preview effect that can show any registered/derived mask.
- [ ] Provide a developer API for inspection.

Deliverable: mask graph is testable in live scenes.

---

## Open questions

- [ ] **Canonical Y-flip convention for authored masks**: formalize and enforce via metadata instead of ad-hoc flips.
- [ ] **Color space for masks**: ensure masks are treated as data/linear (avoid sRGB surprises).
  - Current state: `outdoors`, `fire`, `windows` are loaded as sRGB; `water` is treated as data.
- [ ] **Do we want derived mask textures for particles?**
  - Might be cheaper to keep per-fragment dual sampling instead of a pre-computed combined mask.
- [ ] **Where does CPU extraction live long-term?**
  - MaskManager seems like the natural owner, but WeatherController currently owns roof CPU sampling.

---

## Status

Planning document complete. Next step is to implement Phase 1 registry + wiring, then migrate the most painful duplication (blur/threshold/coordinate mapping) out of `DistortionManager` and into the new MaskManager.
