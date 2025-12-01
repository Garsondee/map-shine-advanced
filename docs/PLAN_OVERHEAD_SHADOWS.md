# PLAN — Overhead Shadows

## Goal
Create soft, directional shadows cast by **overhead geometry** (roofs, balconies, bridges) onto the ground plane. The simplest version:

- Uses the **opaque/solid regions of overhead tiles** as a **shadow stamp**.
- Blurs the stamp slightly to soften edges.
- Offsets the shadow **east/west (and optionally north/south)** to simulate the sun moving across the sky.
- Plays nicely with existing **LightingEffect** and future **Building Shadows** / `_Outdoors`-driven long shadows.

This feature is one half of the “building shadows” story:

1. **Overhead Shadows (this doc)** — short, local contact shadows directly under/near roofs.
2. **Long Landscape Shadows (future)** — `_Outdoors` mask–driven, smeared shadows stretching across the terrain.

---

## Inputs & Dependencies

- **Overhead tiles** from `TileManager`:
  - Already tagged via `sprite.userData.isOverhead` and `ROOF_LAYER` (20) for Lighting.
  - Represent the geometry that should **cast** shadows.

- **Scene base mesh**:
  - The same geometry used for base map / lighting passes.

- **Sun/Time-of-Day parameters** (initially manual):
  - `sunAzimuth` (angle in world space, e.g. 0° = East, 90° = North).
  - `sunElevation` (height; controls shadow length scale).
  - For v1, these can live on a simple **Overhead Shadows UI** or be piggy‑backed on `TimeOfDayEffect` later.

- **Existing lighting pipeline** (`LightingEffect`):
  - Already computes ambient + dynamic lights + roof occlusion using a **screen-space composite pass**.
  - Has a `tDiffuse` (base), `tLight` (HDR light buffer), and `tRoofAlpha` (overhead tile alpha) input.

- **GPU Layering** (`EffectComposer.RenderLayers`):
  - Overhead Shadows is conceptually **Environmental** (scene-wide modulation, not a local mesh effect).

---

## High-Level Design

### 1. Shadow Generation Strategy

We want a **screen-space shadow factor texture** that encodes “how much overhead geometry blocks sky light here”. That factor will be used to **darken** ambient and/or direct light.

Two plausible approaches:

1. **Tile-Driven Shadow Render (recommended for v1)**
   - Render overhead tiles into an off-screen **shadowRenderTarget** using a flat color.
   - Use a custom material that:
     - Writes alpha = 1 for solid roof areas (could leverage existing tile textures or a derived luminance threshold).
     - Optionally ignores transparent parts (e.g. gaps, skylights).
   - Blur this texture (1–2 pass separable Gaussian) to soften edges.
   - Apply a directional **UV offset** based on sun direction to “project” the roof stamp onto the ground.

2. **Mask-Driven Shadow Render (defer)**
   - If we eventually derive an explicit `_Overhead` luminance mask, we can sample that directly instead of rendering tiles.
   - Same blur + directional offset pipeline.

v1 uses (1) because tile-based overhead information is already wired via `TileManager` and `ROOF_LAYER`.

### 2. Integration with Existing Lighting Calculations

We have a few choices on where to apply the shadow factor:

- **Option A — Inside `LightingEffect` composite (preferred)**
  - Treat Overhead Shadows as an **input texture** to `LightingEffect` (e.g. `tOverheadShadow`).
  - In the Lighting composite shader:
    - Compute `shadowFactor = texture2D(tOverheadShadow, vUv).r` (0 = fully shadowed, 1 = unshadowed).
    - Modulate **ambient** and optionally **dynamic light**:
      - `totalIllumination = ambient * shadowFactor + light * mix(1.0, shadowFactor, kd)` where `kd` controls how much dynamic light is affected.
    - This keeps all “light math” centralized in **one** post-process.

- **Option B — Separate Environmental Effect (post-light darkening)**
  - Implement `OverheadShadowsEffect` in `RenderLayers.ENVIRONMENTAL`.
  - Render a full-screen quad that multiplies the output of `LightingEffect` by a shadow factor.
  - Simpler wiring, but splits light logic across multiple passes.

**Decision for v1:**

- Implement Overhead Shadows as its **own effect class** (for UI + lifecycle), but have it **produce a shadow texture** consumed by `LightingEffect`.
- Concretely:
  - `OverheadShadowsEffect` (ENVIRONMENTAL layer) owns:
    - A `shadowTarget` (`WebGLRenderTarget`) containing the **blurred, offset roof stamp**.
    - Parameters for blur radius, shadow opacity, sun direction/length.
  - `LightingEffect` gains a uniform + setter:
    - `uniform sampler2D tOverheadShadow;`
    - `setOverheadShadowTexture(texture)` (called by EffectComposer or the effect itself).
  - In the composite shader, apply `shadowFactor` when computing `totalIllumination`.

This keeps Overhead Shadows **tightly coupled to lighting math** (correct physical semantics) while letting the generation / blur / offsets live in a modular effect.

---

## Detailed v1 Behavior

### 1. Shadow Map Creation

- **Render Pass** (likely in `OverheadShadowsEffect.render`):
  1. Ensure `shadowTarget` matches drawing buffer size.
  2. Set camera layers to `ROOF_LAYER` (20) to render only overhead tiles.
  3. Use a **simple shadow material** override for those sprites:
     - Output grayscale/alpha = roof opacity.
     - Color not important; we care about luminance/alpha.
  4. Render scene into `shadowTarget` with transparent background.

- **Blur Pass**:
  - Option A (fast, v1): a simple **1-pass box blur approximation** in the Lighting composite, by sampling a few taps around `vUv` on `tOverheadShadow`.
  - Option B (nicer, later): proper 2-pass separable Gaussian blur using an intermediate RT.

- **Directional Offset**:
  - In the composite shader when sampling `tOverheadShadow`:
    - Compute an offset vector in UV space based on `sunAzimuth` and `shadowLength`.
    - `vec2 offset = shadowDir * shadowLength * uShadowScale;`
    - Sample `tOverheadShadow` at `vUv - offset` to “pull” the shadow away from the caster in sun-opposite direction.

### 2. Shadow Factor Application in Lighting

In `LightingEffect` composite fragment shader (conceptually):

```glsl
vec4 shadowSample = texture2D(tOverheadShadow, vUv);
float shadow = shadowSample.r; // 0..1 from blurred, offset roof stamp

float shadowOpacity = uOverheadShadowOpacity; // UI-controlled
float shadowFactor = mix(1.0, shadow, shadowOpacity);

vec3 ambient = mix(uAmbientBrightest, uAmbientDarkness, uDarknessLevel);
vec3 lightTerm = lightSample.rgb;

// Apply to ambient strongly, to direct light optionally
float kd = uOverheadShadowAffectsLights; // 0..1
vec3 shadedAmbient = ambient * shadowFactor;
vec3 shadedLights  = mix(lightTerm, lightTerm * shadowFactor, kd);

vec3 totalIllumination = shadedAmbient + shadedLights;
vec3 finalRGB = baseColor.rgb * totalIllumination;
```

This gives us:

- Strong, local darkening under roofs.
- Control over whether dynamic lights are also shadowed (`kd`).
- Shadows that naturally integrate with existing DarknessLevel and ambient colors.

---

## Parameters & UI Surface

Expose via a new **Overhead Shadows** effect entry (probably under `structure` or `atmospheric`):

- **Enabled**
- **Shadow Opacity** (`0–1`)
- **Softness / Blur Radius**
- **Sun Direction** (azimuth angle slider or 2D control)
- **Shadow Length Scale** (maps to UV offset magnitude)
- **Affects Dynamic Lights** (`0–1` blend)

Optional later:

- **Color Tint** (slightly warm/cool shadows, still multiplicative in practice).
- **Time-of-Day binding**: fetch sun direction from `TimeOfDayEffect`.

---

## Relationship to `_Outdoors` Long Shadows

The long smeared shadows you mentioned (the other half of building shadows) are best handled as a **separate, later effect**:

- Use `_Outdoors` as a **receiver mask** over the terrain.
- Convolve / smear that mask in a directional way to produce **large-scale, low-frequency shadows**.
- These can share the same **sun direction** and potentially feed a second shadow texture into `LightingEffect` (`tLandscapeShadow`).

Architecturally, Overhead Shadows should be:

- **Local / high-frequency**: detailed roof silhouettes, short offsets.
- `_Outdoors` shadows should be:
  - **Global / low-frequency**: big shapes, broad gradients.

Both can be multiplied together inside Lighting for a combined shadow factor.

---

## Answer: Lighting Calculations vs Different Approach

- **Yes, Overhead Shadows should ultimately plug into the lighting calculations.**
  - They represent occlusion of *sky/ambient* light by physical structures.
  - Treat them as a **shadow/occlusion term** that modulates the same `totalIllumination` used for everything else.

- **But** the *generation* of the shadow stamp (from overhead tiles) should live in its **own effect module**:
  - `OverheadShadowsEffect` is responsible for building a blurred, offset shadow texture.
  - `LightingEffect` is responsible for **applying** that texture as part of the light math.

This split keeps:

- Lighting math centralized and predictable.
- Shadow generation modular and re-usable (e.g., could also inform Cloud Shadows or Time-of-Day later).

---

## Implementation Phases

1. **Phase 1 — Prototype Overlay (Fast Path, Optional)**
   - Implement OverheadShadowsEffect that:
     - Renders ROOF_LAYER to `shadowTarget`.
     - Samples `shadowTarget` with blur + offset.
     - Multiplies final scene color directly (post-lighting) as a full-screen quad.
   - Good for quick visual validation.

2. **Phase 2 — Integrate into LightingEffect (Target)**
   - Add `tOverheadShadow` + uniforms to `LightingEffect` composite.
   - Wire OverheadShadowsEffect to provide its `shadowTarget.texture` to LightingEffect.
   - Move the blur + offset logic into Lighting composite or into the OverheadShadowsEffect shader, whichever is cleaner.

3. **Phase 3 — Unify with Time-of-Day & `_Outdoors` Long Shadows**
   - Share `sunAzimuth` / `sunElevation` across TimeOfDay, OverheadShadows, and future Landscape Shadows.
   - Add second long-shadow map from `_Outdoors` and multiply into the same lighting composite.
