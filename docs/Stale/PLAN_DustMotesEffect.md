# PLAN: Dust Motes Effect (Quarks) + Window-Light Illumination

## Goal
Create a new Dust Motes particle effect in the Three.js renderer using `three.quarks`, where motes are **mostly dark** and become **brightest when inside the projected window-light pools** produced by the `_Windows` (fallback `_Structural`) effect.

This is intended to produce the classic “sunbeam dust” look:
- Dust is subtle and mostly invisible in shadow.
- Dust becomes visible only where bright exterior light enters interiors.

## Key Constraints / Project Rules
- Rendering is **THREE.js-first** (avoid PIXI rendering paths).
- Use the **centralized TimeManager** (`timeInfo.elapsed`, `timeInfo.delta`) for all animation.
- Prefer mask-driven particle placement techniques that avoid per-frame rejection sampling. For luminance masks, the preferred pattern is to **scan once on CPU and provide a lookup/position map**.

## Old Module Behavior (Reference)
The old module’s dust system (PIXI particles) had these notable behaviors:
- **Trigger**: `_Dust` mask.
- **Composite Spawn Mask**: For dust specifically, it multiplied `_Dust` with `_Structural` via a screen-sized `PIXI.RenderTexture` (see `CompositeMaskGenerator.generate(...)`).
- **Config knobs** (from old defaults):
  - `maskThreshold`, `maskInfluence`, `frequency`, `lifetime`, `scale`, `speed`, `blendMode`.
  - “Lighting” behavior (`mapShineLighting`) that:
    - Darkened particles by scene darkness.
    - Added an emissive boost via an emissive gradient.

What we want to keep:
- Mask-driven spatial control.
- Long-lived, slow-moving particles.

What we want to change:
- Switch to **Quarks** and Three.js.
- Replace “global darkness/emissive” logic with **window-light-driven visibility**.

## New System Integration Points (Current Codebase)
Relevant existing systems:
- **Quarks renderer**: `scripts/particles/ParticleSystem.js` creates a global `BatchedRenderer` and exposes it as `window.MapShineParticles`.
- **Window light buffer**:
  - `scripts/effects/WindowLightEffect.js` can create a `lightTarget` via `createLightTarget()`.
  - `renderLightPass(renderer)` renders a light-only pass (RGBA; alpha carries brightness).
  - `getLightTexture()` returns the texture.
- **Material patch pattern**:
  - `scripts/particles/WeatherParticles.js` patches Quarks SpriteBatch shaders by injecting varyings + uniforms and fragment discard logic.

We should reuse these patterns for Dust.

## Proposed Effect Design

### 1) Effect Identity and Layering
- Implement as a new `EffectBase` subclass (e.g. `DustMotesEffect`) in `RenderLayers.PARTICLES`.
- Use the shared Quarks `BatchedRenderer` from `ParticleSystem` (like `SmellyFliesEffect` does).
- Render ordering:
  - Dust should render above the ground plane and under/over overhead tiles depending on intended look.
  - Recommendation:
    - Default: render **under visible roofs** (so roof still covers interior dust if roof is visible).
    - Optional toggle: render as an “overlay” (like rain) for stylized visibility.

### 2) Spawn Placement (Mask-driven)
We have three plausible spawn strategies. Recommendation: start with (A), keep (B) as a follow-up if we need ultra-high density.

#### (A) CPU “point list” sampling (simple, robust)
- On initialize / on mask change:
  - Read `_Dust` mask pixels once.
  - If `_Structural` exists, multiply intensities per pixel: `dust * structural`.
  - Build a compact list of world-space points (or UVs) weighted by brightness.
- Emitter shape:
  - Similar to `FireMaskShape` / `MultiPointEmitterShape` approach.
  - Spawns directly at a randomly-chosen point, optionally jittered within a small radius.

Pros:
- Simple.
- Deterministic density.
- No per-frame shader changes.

Cons:
- Large masks can produce big point lists; must cap / stride.

#### (B) CPU “position map” (lookup texture) (preferred for very large masks)
- Follow the “Lookup Map technique”:
  - Scan mask once.
  - Pack valid spawn positions into a `THREE.DataTexture` (position map).
  - Vertex shader samples the position map to position particles.

Pros:
- Scales better for huge spawn sets.

Cons:
- Requires deeper integration with Quarks shader pipeline.

#### (C) Rejection sampling in custom spawn shape (avoid unless necessary)
- Similar to the `AreaSpawnShape` used by flies.
- Not recommended for full-scene dust.

### 3) Particle Motion (Subtle, Attractive)
Design goal: “slow life, micro-motion, no obvious looping.”

Recommended motion stack:
- **Brownian drift**: very low constant velocity + small random walk.
- **Curl noise field**: ultra-low strength curl to create gentle swirling.
- **Vertical bob**: slight sinusoidal Z offset per particle with randomized phase.
- **Camera-relative parallax** (optional): not physically correct, but can enhance depth (tiny response to camera pan for “volumetric feel”).

Two-layer approach (recommended):
- **Near layer**:
  - Fewer, larger motes.
  - Stronger parallax and motion.
  - Slight defocus/softness (if we later add a small blur or sprite texture).
- **Far layer**:
  - More, smaller motes.
  - Minimal motion.

### 4) Window-Light-Driven Illumination (Core Requirement)
We want dust visible primarily inside window light.

#### Data source
Use `WindowLightEffect.getLightTexture()`:
- The light-only pass outputs:
  - RGB = tinted light
  - A = brightness (clamped 0..1)

#### Mapping
`lightTarget` is rendered in screen space via the same camera; therefore dust shading can sample it in **screen space**:
- In the dust fragment shader:
  - `vec2 screenUv = gl_FragCoord.xy / uScreenSize;`
  - `vec4 w = texture2D(uWindowLightTex, screenUv);`

#### Proposed shading model
- Base dust color is *dark*, e.g. near-black / cool-gray.
- Final alpha (or brightness) should be shaped by window light brightness:
  - `light = w.a` (0..1)
  - `visibility = smoothstep(lightMin, lightMax, light)`
  - `alpha = baseAlpha * visibility * intensity`
- Optional “forward scattering” feel:
  - Use `w.rgb` tint to slightly warm the dust.
  - Add a small “bloom-friendly” highlight: `color += w.rgb * visibility * highlightStrength`.

#### Indoor/outdoor gating
Dust motes should be primarily an interior phenomenon:
- Use `_Outdoors` mask if present:
  - Spawn only where `outdoor < threshold`.
  - Or: spawn anywhere but fade out outdoors.

### 5) Blending
Default blend recommendation:
- `NormalBlending` but with very low alpha; relies on window light to lift it.
Alternative:
- `AdditiveBlending` for “sparkle in sunbeam” look, but can look gamey.
- Plan: expose blend mode as a UI option.

## Proposed Controls (Tweakpane)
Minimal, artist-friendly controls:
- **enabled**
- **density** (particles per area / max particles)
- **lifetime** (min/max)
- **size** (min/max)
- **motion**
  - driftStrength
  - curlStrength
  - verticalBobStrength
  - verticalBobSpeed
- **window light coupling**
  - lightMin (threshold)
  - lightMax (softness range)
  - lightIntensity (multiplier)
  - lightTintInfluence (how much RGB tint affects dust)
- **appearance**
  - baseDarkness (how dark in shadow)
  - contrast (how sharply it “pops” in light)
  - blendMode
- **debug**
  - showLightTextureSample (visualize `w.a` sampling)

## Enhancement Ideas (Beyond Original)
- **Sunbeam “shafts” option**: sparse elongated motes / streaks aligned to a user-set angle (only when window light is strong).
- **Depth stratification**: distribute Z across a shallow volume, not a flat plane, for true 3D parallax.
- **Occlusion by roofs**:
  - If roof is visible, optionally attenuate dust behind roof alpha.
  - Similar concept to the dual-mask precipitation logic, but inverted for interiors.
- **Adaptive density**:
  - Increase density slightly when window light is strong (late afternoon “dusty room” vibe).
  - Decrease in darkness / at night.
- **Micro sparkle** (very subtle): rare glints when `w.a` is high, using a high-frequency noise seeded per particle.
- **Air disturbance**:
  - Weak coupling to `WeatherController.windSpeed` indoors should generally be near-zero.
  - Optionally add “door gust” events later (hooked to door open/close) that briefly increases swirl.

## Performance Plan
- Prefer **1-2 Quarks systems total** (near + far) rather than one system per region.
- Avoid per-frame allocations in update loops.
- Avoid per-frame CPU sampling of masks/textures.
- Use shader sampling of `lightTarget` (screen-space) instead of CPU light queries.
- Be cautious about render target size:
  - `WindowLightEffect.lightTarget` currently uses `UnsignedByteType`; that’s likely fine for dust visibility.

## Implementation Sequence (Milestones)
1. **Data plumbing**
   - Ensure `WindowLightEffect.createLightTarget()` is called when dust is enabled.
   - Ensure `renderLightPass(renderer)` runs each frame (or when needed) so dust sees up-to-date light.
2. **Dust spawn mask extraction**
   - CPU scan `_Dust` and optionally `_Structural` and `_Outdoors`.
   - Generate a compact spawn list.
3. **Quarks system**
   - One system (then optional second for near/far).
   - Custom emitter shape for spawn list.
4. **Shader patch**
   - Patch Quarks SpriteBatch fragment shader to sample `uWindowLightTex` in screen space.
   - Drive uniforms: `uWindowLightTex`, `uScreenSize`, coupling params.
5. **Tuning + UI**
   - Expose the control set.

## Acceptance Criteria
- Dust is **barely visible** outside window light.
- Dust becomes **noticeably visible** within window light pools.
- Motion is subtle and non-repeating (no obvious looping drift).
- No measurable pan/zoom hitching compared to baseline (no per-frame CPU-heavy work).

## Open Questions
- **Render order vs roofs**: Should interior dust render under visible roofs by default, or should it always be visible as an “overlay effect”?
- **Mask authoring**:
  - Should `_Dust` be optional (fallback to procedural indoor dust)?
  - Or require `_Dust` for explicit placement only?
- **Structural coupling**:
  - Should `_Structural` multiplication be mandatory (like old) or optional?
