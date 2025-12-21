# PLAN — Foundry Lighting & Darkness Parity (MapShine Advanced)

## Goal
Achieve **feature parity** with Foundry VTT’s lighting + darkness system while rendering everything with **Three.js** (not PIXI), preserving MapShine’s existing multi-pass architecture.

This plan covers:
- Foundry’s **conceptual model** (sources → layers → compositing)
- Foundry’s **animation registries** (`lightAnimations`, `darknessAnimations`)
- MapShine’s **current implementation status**
- A **checkbox parity checklist** and an implementation roadmap

---

## Foundry VTT Lighting System (Conceptual Overview)

### Core “source” types (scene-level)
- **PointLightSource**
  - Produces positive light.
  - Uses `CONFIG.Canvas.lightAnimations` for animation drivers and shader variants.
- **PointDarknessSource**
  - Produces darkness-as-an-effect (not just global darkness level).
  - Uses `CONFIG.Canvas.darknessAnimations`.
  - Always generates edges (important for interaction with other sources).

### Effects container and layering
Foundry organizes perception-related rendering into groups/layers. The important conceptual split:
- **Primary render texture**: the base scene (map, tiles, tokens, etc.)
- **Effects pipeline**: separate render targets/layers which modify or combine with the primary texture

Relevant Foundry container:
- `canvas.effects` (`EffectsCanvasGroup`)
  - Tracks:
    - `lightSources`
    - `darknessSources`
    - `visionSources`
  - Creates effect layers:
    - background alteration
    - illumination
    - coloration
    - darkness

### Foundry darkness sources (what they actually do)
Foundry’s `PointDarknessSource`:
- Has a **darkness layer** using `AdaptiveDarknessShader` (or a shader from `darknessAnimations`).
- The shader samples:
  - `primaryTexture`
  - `depthTexture`
  - `visionTexture` (optional masking)
- Has an extra **visual padding** concept for darkness sources (visual-only radius extension).
- Uses blend mode: `MAX_COLOR` (see `_layers()` in `point-darkness-source.mjs`).

Practical interpretation:
- A darkness source is **not additive light**.
- It is a localized effect that **pushes the sampled scene toward a “darkness coloration”**, often via procedural patterns.

### Animation registries (authoritative)
In Foundry `config.mjs`:
- `CONFIG.Canvas.lightAnimations` keys include:
  - `flame`, `torch`, `revolving`, `siren`, `pulse`, `reactivepulse`, `chroma`, `wave`, `fog`, `sunburst`, `dome`, `emanation`, `hexa`, `ghost`, `energy`, `vortex`, `witchwave`, `rainbowswirl`, `radialrainbow`, `fairy`, `grid`, `starlight`, `smokepatch`
- `CONFIG.Canvas.darknessAnimations` keys include:
  - `magicalGloom`, `roiling`, `hole`, `denseSmoke`

### Important behavioral notes to preserve
- **Timebase**:
  - Many animations are time-driven (`animateTime`).
  - Some are pulse/flicker driven (`animateTorch`, `animatePulse`, etc.).
- **Vision masking**:
  - Darkness sources can be masked by vision (so they don’t “apply” to unseen areas depending on settings).
- **Depth masking**:
  - Uses `depthTexture` and elevation logic.
- **Edges / LOS**:
  - Darkness sources always generate edges.
  - Light sources may generate edges based on priority.

---

## MapShine Current Lighting System (What Exists Today)

### What MapShine already does (Three.js)
- **Dynamic lights** are rendered using `LightingEffect` + `ThreeLightSource`.
  - Lights are accumulated in a dedicated Three scene (`lightScene`) and rendered into `lightTarget`.
  - A final full-screen composite shader multiplies the base scene by:
    - ambient term derived from `canvas.environment.darknessLevel`
    - plus accumulated dynamic light contribution

- **Light animations**
  - Implemented as a single combined `ShaderMaterial` in `ThreeLightSource`.
  - Animation patterns live in `FoundryLightingShaderChunks.js`.
  - `updateAnimation()` maps Foundry animation keys → `uAnimType` + time/intensity uniforms.

- **Roof occlusion + outdoor gating**
  - `roofAlphaTarget` provides a screen-space occlusion mask.
  - `_Outdoors` mask is projected to screen-space for safe sampling.

### What is missing today
- There is **no Three-rendered darkness sources pipeline**:
  - No `darknessScene`
  - No `darknessTarget`
  - No `ThreeDarknessSource`
  - No compositing term equivalent to Foundry’s darkness sources and `darknessAnimations`

---

## Desired Parity Architecture (MapShine “Darkness Side”)

### Concept: Add a Darkness Accumulation Pass
Mirror how lights are accumulated, but with different math:
- Create `darknessScene` rendered into `darknessTarget`.
- Add `ThreeDarknessSource` meshes into `darknessScene`.
- Composite stage uses `darknessTarget` to apply localized darkness.

### Data model (target)
- `LightingEffect` manages:
  - `this.lights: Map<id, ThreeLightSource>`
  - `this.darknessSources: Map<id, ThreeDarknessSource>` (new)

### Coordinate system
Follow existing MapShine coordinate rules:
- Foundry docs are top-left origin (Y-down)
- Three world is bottom-left origin (Y-up)
- Use `Coordinates.toWorld()` / `Coordinates.toFoundry()` for conversions.

### Masking requirements
To match Foundry conceptually, the darkness shader path will eventually need:
- **Roof alpha occlusion** consistency (if intended)
- **Vision masking** (if/when MapShine’s vision textures are available in Three)
- **Depth/elevation masking** (optional initially, but required for full parity)

---

## Parity Checklist

### A) Source collections and lifecycle
- [x] Lights: `AmbientLight` create/update/delete hooks wired to `LightingEffect`
- [ ] Darkness: `AmbientDarkness` (or equivalent) create/update/delete hooks wired
- [ ] Scene sync: full resync of darkness sources on scene load
- [ ] Geometry rebuild: darkness sources respect LOS/walls similar to lights (at minimum match Foundry suppression rules)

### B) Render targets & passes
- [x] Light accumulation target (`lightTarget`)
- [ ] Darkness accumulation target (`darknessTarget`)
- [x] Roof alpha target (`roofAlphaTarget`)
- [x] Outdoors mask projection target (`outdoorsTarget`)
- [ ] Composite shader extended to apply localized darkness from `darknessTarget`

### C) Blending / compositing semantics
- [x] Additive light accumulation semantics (Three blending)
- [ ] Darkness blending semantics (Foundry uses `MAX_COLOR` on darkness layer)
- [ ] Decide/implement Three equivalent to `MAX_COLOR` for darkness accumulation
- [ ] Ensure darkness sources interact correctly with global ambient darkness level

### D) Darkness source uniforms & masking
(These are required for true parity; implement in phases)
- [ ] `borderDistance` / padding radius behavior (visual-only extension)
- [ ] Vision masking integration
- [ ] Depth/elevation masking integration
- [ ] Support linking darkness sources to darkness level / global thresholds where applicable

### E) Foundry `darknessAnimations` parity
Implement all 4 animation keys:
- [ ] `magicalGloom` (Foundry: `MagicalGloomDarknessShader`)
- [ ] `roiling` (Foundry: `RoilingDarknessShader`)
- [ ] `hole` (Foundry: `BlackHoleDarknessShader`)
- [ ] `denseSmoke` (Foundry: `DenseSmokeDarknessShader`)

### F) Foundry `lightAnimations` parity (status)
- [x] `wave`
- [x] `fairy`
- [x] `chroma`
- [x] `energy`
- [x] `witchwave`
- [x] `revolving`
- [x] `siren`
- [x] `fog`
- [x] `sunburst`
- [x] `dome`
- [x] `emanation`
- [x] `hexa`
- [x] `ghost`
- [x] `vortex`
- [x] `rainbowswirl`
- [x] `radialrainbow`
- [x] `grid`
- [x] `starlight`
- [x] `smokepatch`
- [x] `torch`
- [x] `flame`
- [x] `pulse`
- [x] `reactivepulse`

### G) Debuggability
- [ ] Debug toggle to visualize darkness buffer directly
- [ ] Per-source debug labels/logging for animation key and intensity/time

---

## Implementation Roadmap (Phased)

### Phase 1 — Scaffolding (make darkness sources “exist”)
- Add `darknessScene` and `darknessTarget` to `LightingEffect`.
- Add a minimal `ThreeDarknessSource`:
  - Uses circle/LOS geometry like `ThreeLightSource`.
  - Writes a simple grayscale/vec3 “darkness influence” into `darknessTarget`.
- Extend composite shader to apply darkness influence.

### Phase 2 — Darkness animations
- Add `FoundryDarknessShaderChunks.js` (parallel to lighting chunks) OR extend existing chunk file.
- Implement `uDarkAnimType` mapping:
  - `magicalGloom`, `roiling`, `hole`, `denseSmoke`
- Match timebase to Foundry (`animateTime`).

### Phase 3 — Parity masking
- Implement vision masking integration (if/when MapShine has access to a vision mask texture in Three).
- Implement depth/elevation masking (if/when MapShine has access to an equivalent depth texture).
- Implement border distance and padding behavior.

---

## Open Questions (need decisions for true 1:1 parity)
- What is the exact desired compositing math for darkness sources inside MapShine’s HDR-light workflow?
  - Foundry’s darkness shader samples the scene and outputs a modified scene color.
  - MapShine currently does: `final = base * (ambient + lights)`.
  - We need to decide whether darkness sources are:
    - multiplicative reducers of illumination, or
    - an additional “darkness coloration” term applied to `base` before illumination, or
    - an overlay that remaps `ambient` locally.

- Where should darkness sources sit relative to roof occlusion and outdoor gating?

---

## Next Action
Implement **Phase 1 scaffolding**:
- New `darknessScene` + `darknessTarget`
- `ThreeDarknessSource` minimal implementation
- Composite shader reads `tDarkness` and applies it
