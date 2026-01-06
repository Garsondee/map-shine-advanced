# PLAN: Window Rain Distortion + Outside Lightning Flash

## Goals

- **Raindrop distortions on window light**
  - Rivulets / streaks that move downward (south in Foundry coords).
  - Slight refraction/distortion of the *window light* contribution.
  - Slight darkening where water passes (like light being scattered/occluded).
  - Scales with `weatherController.getCurrentState().precipitation` so drizzle is subtle, storms are busy.
  - Must be performant (no per-frame CPU scanning, no heavy multi-pass chains).

- **Lightning (Outside) flash**
  - Sudden bright flash outside + slightly slower falloff.
  - During flash window lights become higher contrast / “pop”.
  - Ideally tied to actual lightning strikes (from `LightningEffect`) or a storm state.

## Relevant Existing Infrastructure

- **Window light is already a dedicated overlay mesh** (`scripts/effects/WindowLightEffect.js`)
  - Uses `_Windows` / `_Structural` mask + `_Outdoors` gating.
  - Outputs additive overlay (`THREE.AdditiveBlending`).
  - Also renders a **screen-space render target** (`lightTarget`) and publishes it via `maskManager` as `windowLight.screen` (alpha = brightness).

- **Weather state is centralized** (`weatherController.getCurrentState()`)
  - Has `precipitation` in `0..1`.

- **DistortionManager already exists** (`scripts/effects/DistortionManager.js`)
  - Post-processing system for screen-space distortion.
  - Already consumes `windowLight.screen` (for water caustics gating / lighting gating).
  - Has a “source slot” architecture (heat/water/magic) and shared noise snippets.

## Part 1: Window “Raindrop / Rivulet” Distortion

### Visual Requirements (What to simulate)

- **Streak field**
  - Predominantly vertical motion (downward/south).
  - Some lateral wobble (wind + surface tension), but not “wind-blown rain”; it’s water *on glass*.
  - Multiple scales:
    - Thin fast streaks (many) in storms.
    - Fewer thick rivulets (slow, heavy) that slightly magnify/warp.

- **Optical behavior**
  - **Refraction**: shift sampling of the window mask (and/or the computed light field) by a small offset.
  - **Darkening**: locally reduce brightness where water passes.
  - **Optional chromatic split**: can modulate `rgbShiftAmount` locally for “wet glass sparkle”, but keep it subtle.

### Key Performance Principle

- **Avoid extra full-screen passes if possible**.
  - WindowLightEffect is already a *single mesh pass* over the base plane.
  - Best-case implementation is “just more math” in that fragment shader.

### Option A (Recommended): Shader-only distortion inside `WindowLightEffect` (single-pass)

- **Approach**
  - Generate a procedural “rivulet field” in the WindowLightEffect fragment shader.
  - Use that field to:
    - Offset the sampling UVs used to read `_Windows` (and optionally `_Specular`).
    - Darken the final light in regions of high water coverage.

- **How it works (conceptual)**
  - Compute `rainK = smoothstep(precipStart, precipFull, precipitation)`.
  - Build `waterMask` as a sum of a few cheap layers:
    - **Thin streaks**: based on high-frequency noise in X, advected downward by time.
    - **Thick rivulets**: lower frequency noise, larger displacement, slower speed.
  - Compute an offset vector:
    - Mostly Y-direction flow, plus small X wobble.
    - IMPORTANT: offset should be in **pixels** then converted to UV using `uWindowTexelSize` (resolution-independent).
  - Apply:
    - `uvDistorted = vUv + offsetUv`
    - Re-sample `_Windows` using `uvDistorted` to get refracted light.
    - Multiply final brightness by `(1 - waterMask * darkenStrength)`.

- **Pros**
  - **Fastest**: single draw, no additional render targets.
  - No extra manager integration required.
  - Easy to scale with precipitation.

- **Cons**
  - If the shader becomes too complex (expensive noise), it could add noticeable cost.
  - Must be careful not to introduce aliasing/shimmering at high frequencies.

- **Notes**
  - Use `timeInfo.elapsed` only (no `performance.now()`), consistent with the project TimeManager.
  - Add a small “screen-space” component only if needed, but prefer mask-space so it stays pinned.

### Option B: Distort the precomputed `lightTarget` (extra pass, but only once per frame)

- **Approach**
  - After `WindowLightEffect.renderLightPass()` renders `lightTarget`, run a small full-screen quad pass that:
    - Takes `lightTarget.texture` as input.
    - Applies rivulet UV offsets + darkening.
    - Outputs to a second `lightTargetDistorted`.
  - Use `lightTargetDistorted` for:
    - `maskManager.setTexture('windowLight.screen', ...)` publication.
    - Any other downstream consumers.

- **Pros**
  - Window light brightness texture becomes “truth” for all other effects.
  - Keeps the main window overlay mesh shader simpler (could sample the distorted light texture instead of recomputing).

- **Cons**
  - Adds an extra full-screen pass every frame.
  - Requires careful handling so post chain never breaks (even when disabled).

### Option C: Integrate into `DistortionManager` as a dedicated “Window Rain” distortion source

- **Approach**
  - Add a new distortion source type inside DistortionManager:
    - Masked by `_Windows` or by `windowLight.screen` brightness.
    - Generates screen-space distortion vectors where windows are bright.
  - This would distort the *final scene* (or portions), which can read as “wet lens” rather than “wet window light”.

- **Pros**
  - Reuses existing distortion infrastructure and shared noise code.

- **Cons (major)**
  - Distorts everything behind/under the window light, not just the light itself.
  - Likely incorrect artistically for “rivulets refracting the glow” unless very carefully masked.

### Option D: Prebaked flow map / normal map texture (artist-driven)

- **Approach**
  - Ship a small tiling normal/flow texture for “rain on glass”.
  - Scroll it downward; use it to offset UVs and darken.

- **Pros**
  - Very cheap in shader (just texture fetches).
  - Very controllable look.

- **Cons**
  - Adds a new asset dependency and tuning complexity.
  - May look repetitive unless you add multi-scale blending.

### Option E: Particle-based screen-space droplets

- **Approach**
  - Render a transparent droplet/rivulet particle layer in screen space.
  - Use it as a mask and distortion field.

- **Pros**
  - Very “authentic” water droplet behavior.

- **Cons**
  - Highest complexity.
  - Risk of CPU/GPU overhead (sorting, updates) and aliasing.

### Recommendation

- **Recommended MVP**: **Option A** (single-pass WindowLightEffect shader).
- **Future upgrade**: Option D (tiling normal map) if you want more “real” droplet microstructure without heavy noise.

### Proposed Parameters / Uniforms (Window Rain)

- **`rainOnGlassEnabled`** (bool)
- **`rainOnGlassIntensity`** (0..1 or 0..2)
- **`rainOnGlassMaxOffsetPx`** (pixels; multiply by `uWindowTexelSize`)
- **`rainOnGlassDarken`** (0..1)
- **`rainOnGlassSpeed`** (downward scroll speed)
- **`rainOnGlassScaleThin`**, **`rainOnGlassScaleThick`** (UV scale)
- **`rainOnGlassWindInfluence`** (optional; couple to `weatherController.windSpeed`)

- **Weather coupling**
  - `rainK = clamp((precipitation - start) / (full - start), 0, 1)`
  - Final strength `= rainK * rainOnGlassIntensity`

## Part 2: Lightning (Outside) Flash

### Desired Behavior

- **Flash envelope**
  - Very fast attack (0–50ms).
  - Slower decay (300–1200ms).
  - Optional secondary flicker pulses.

- **Where it applies**
  - **Outside only** (areas where `_Outdoors` is “outdoors”).
  - Window lights: during flash, they should become more contrasty/brighter (even though they’re indoors).

### Option 1 (Recommended): Central “LightningFlash” scalar published by `LightningEffect`

- **Approach**
  - In `LightningEffect`, whenever `_spawnStrike()` is called, trigger a flash envelope state:
    - `flash = max(flash, strikeIntensity)`
    - Evolve `flash` over time with attack/decay.
  - Publish the scalar for other effects:
    - `window.MapShine.environment.lightningFlash = flash` (or similar stable location).
  - Consumers:
    - **LightingEffect** (outside brightness modulation).
    - **WindowLightEffect** (contrast/intensity boost while flash > 0).
    - Optional: **ColorCorrectionEffect** (global exposure spike) *if desired*.

- **Why this fits current architecture**
  - LightningEffect already exists and is the authoritative “strike happened now” source.
  - Avoids duplicating storm RNG in multiple systems.
  - Uses TimeManager (`timeInfo.elapsed/delta`) for the envelope.

### Option 2: Flash derived from weather storminess (independent of bolt visuals)

- **Approach**
  - WeatherController runs a stochastic process when precipitation is high.
  - Triggers flash events even if bolt visuals are disabled.

- **Pros**
  - Storm ambience can exist without bolts.

- **Cons**
  - Can desync: flash with no visible strike, or strike with no flash.

### How to apply “Outside only” brightening

- **Best masking**
  - Use `_Outdoors` mask in the lighting pipeline.
  - Conceptual blend:
    - `outdoorFactor = outdoorsMask(worldUv)`
    - `sceneColor *= 1 + flash * outdoorFactor * flashBrightness`

- **Where to implement**
  - **LightingEffect** is the most physically-correct place (light modulates albedo).
  - If LightingEffect is expensive to modify right now, a fallback is a post-pass in ColorCorrectionEffect that boosts exposure in outdoors regions (but that requires outdoors mask in screen-space).

### Lightning “Edge Shadow Map” (Outdoors-mask driven)

- **Idea**
  - Use the `_Outdoors` mask as a cheap occluder proxy for lightning flashes.
  - When a bolt strikes near an outdoors/indoors boundary, treat that boundary as a silhouette edge.
  - Create a transient shadow mask that darkens the opposite side of that edge (relative to the strike direction).

- **Minimal algorithm (screen-space)**
  - Inputs:
    - `tOutdoorsMask` (already packed into `tMasks.r` in LightingEffect)
    - `strikeScreenUv` (published by LightningEffect)
    - `strikeDir2D` (a 2D direction vector or angle)
  - Compute a local edge normal from the outdoors mask gradient near the strike (sample 4 taps around `strikeScreenUv`).
  - Define the “shadow side” as the half-plane behind the edge relative to the strike direction.
  - For each pixel, compute whether it lies on the shadow side (dot with the edge normal + sign).
  - Multiply the outdoor flash contribution by `(1.0 - shadowStrength * shadowMask)`.

- **Pros**
  - No geometry raymarching.
  - Works with any hand-painted outdoors mask.

- **Cons / limits**
  - It’s an artistic approximation (mask edge ≠ true occluder geometry).
  - Requires careful smoothing of the gradient to avoid noisy edges.

- **Performance note**
  - Keep it to 4–8 taps total and only evaluate if `lightningFlash > 0.001`.

### Window light “contrast boost” during flash

- **Simple, cheap mechanism (recommended)**
  - Add `uLightningFlash` uniform to WindowLightEffect.
  - During flash:
    - Increase intensity: `uIntensity *= (1 + flash * kIntensity)`
    - Increase contrast: apply a curve to `lightMap` like `pow(lightMap, mix(1.0, contrastPow, flash))` OR adjust `uFalloff`.
    - Optionally increase `rgbShiftAmount` slightly (wet glass sparkle).

- **Note**
  - Window light is indoors-only by default (`indoorFactor`). That’s fine: the lightning is “outside” but its effect on windows is the *perceived contrast* of the window glow.

## Integration Sketch (No code, just wiring)

- **Data sources**
  - `precipitation`: `weatherController.getCurrentState().precipitation`
  - `lightningFlash`: produced by LightningEffect during strikes

- **Consumers**
  - WindowLightEffect:
    - Reads `precipitation` each `update(timeInfo)` and sets uniforms.
    - Reads `lightningFlash` and boosts intensity/contrast.
  - LightingEffect (or later the refactored lighting post-pass):
    - Applies `lightningFlash` to outdoorFactor.

## UI Control Schemes (Art Direction)

This section proposes control schemas in the same spirit as `EffectBase.getControlSchema()` used across effects.

### A. WindowLightEffect — “Rain On Glass” controls

**Intent**: let you steer between:

- “Subtle wet shimmer” (small refraction, minimal darkening)
- “Heavy rivulets” (bigger offset, strong streak coverage)
- “Foggy runnels” (more darkening + thicker, slower bands)

**Suggested groups**

- **Status**
  - `textureStatus` (readonly)
  - `hasWindowMask` (hidden)

- **Rain On Glass**
  - `rainOnGlassEnabled`
  - `rainOnGlassIntensity`
  - `rainOnGlassPrecipStart`
  - `rainOnGlassPrecipFull`

- **Motion**
  - `rainOnGlassSpeed`
  - `rainOnGlassDirectionDeg` (default 90 = down in UV)
  - `rainOnGlassWobble`
  - `rainOnGlassWindInfluence` (optional)

- **Optics**
  - `rainOnGlassMaxOffsetPx`
  - `rainOnGlassDarken`
  - `rainOnGlassDarkenGamma`
  - `rainOnGlassChromaBoost` (optional, scales local RGB split)

- **Structure (Thin vs Thick)**
  - `rainThinEnabled`
  - `rainThinDensity`
  - `rainThinScale`
  - `rainThinSharpness`
  - `rainThinOffsetScale`
  - `rainThinDarkenScale`

  - `rainThickEnabled`
  - `rainThickDensity`
  - `rainThickScale`
  - `rainThickSharpness`
  - `rainThickOffsetScale`
  - `rainThickDarkenScale`

- **Quality / Stability**
  - `rainAntiShimmer` (bias toward lower freq / more smoothing)
  - `rainMaxCost` (low/med/high preset that reduces layers)

**Suggested parameter ranges (Tweakpane-style)**

- `rainOnGlassEnabled`: boolean, default `true`
- `rainOnGlassIntensity`: slider `0..2`, step `0.01`, default `1.0`
- `rainOnGlassPrecipStart`: slider `0..1`, step `0.01`, default `0.15`
- `rainOnGlassPrecipFull`: slider `0..1`, step `0.01`, default `0.70`
- `rainOnGlassSpeed`: slider `0..2`, step `0.01`, default `0.35`
- `rainOnGlassDirectionDeg`: slider `0..360`, step `1`, default `90`
- `rainOnGlassWobble`: slider `0..1`, step `0.01`, default `0.25`
- `rainOnGlassWindInfluence`: slider `0..1`, step `0.01`, default `0.15`
- `rainOnGlassMaxOffsetPx`: slider `0..8`, step `0.05`, default `1.25`
- `rainOnGlassDarken`: slider `0..1`, step `0.01`, default `0.25`
- `rainOnGlassDarkenGamma`: slider `0.2..4`, step `0.01`, default `1.25`
- `rainOnGlassChromaBoost`: slider `0..2`, step `0.01`, default `0.2`

- `rainThinEnabled`: boolean, default `true`
- `rainThinDensity`: slider `0..2`, step `0.01`, default `1.0`
- `rainThinScale`: slider `0.5..30`, step `0.1`, default `14.0`
- `rainThinSharpness`: slider `0.5..12`, step `0.1`, default `6.0`
- `rainThinOffsetScale`: slider `0..1`, step `0.01`, default `0.45`
- `rainThinDarkenScale`: slider `0..1`, step `0.01`, default `0.35`

- `rainThickEnabled`: boolean, default `true`
- `rainThickDensity`: slider `0..2`, step `0.01`, default `0.65`
- `rainThickScale`: slider `0.2..8`, step `0.05`, default `2.0`
- `rainThickSharpness`: slider `0.5..12`, step `0.1`, default `2.0`
- `rainThickOffsetScale`: slider `0..2`, step `0.01`, default `1.0`
- `rainThickDarkenScale`: slider `0..2`, step `0.01`, default `1.0`

- `rainAntiShimmer`: slider `0..1`, step `0.01`, default `0.5`
- `rainMaxCost`: list
  - `Low` / `Medium` / `High`

**Implementation detail**

- Distortion offset should be computed in **pixels** and converted via `uWindowTexelSize`.
- For stability: clamp max offset and ensure any high-frequency streak pattern is filtered by either:
  - lowering frequency when `rainAntiShimmer` is high
  - or adding a small neighborhood soften step (very small number of taps)

### B. LightningEffect — split “Bolt Visuals” vs “Outside Flash”

Lightning currently focuses on bolt visuals. For artistic flexibility, treat bolt visuals and global/outside flash as separate but coupled systems.

#### B1. Bolt Visuals (existing)

These already exist and should remain:

- **Timing**: min/max delay, burst counts, strike duration, strike spacing, flicker chance
- **Look**: colors, brightness, width, taper, glow, overhead order
- **Shape**: segments, curve, displacements, branching

#### B2. Outside Flash Envelope (new)

**Suggested groups**

- **Flash (Outside)**
  - `outsideFlashEnabled`
  - `outsideFlashGain`
  - `outsideFlashAttackMs`
  - `outsideFlashDecayMs`
  - `outsideFlashCurve` (shape of decay)
  - `outsideFlashFlickerAmount`
  - `outsideFlashFlickerRate`
  - `outsideFlashMaxClamp`

- **Window Lights During Flash**
  - `windowFlashIntensityBoost`
  - `windowFlashContrastBoost`
  - `windowFlashRgbBoost`

**Suggested parameter ranges**

- `outsideFlashEnabled`: boolean, default `true`
- `outsideFlashGain`: slider `0..5`, step `0.01`, default `1.5`
- `outsideFlashAttackMs`: slider `0..150`, step `1`, default `25`
- `outsideFlashDecayMs`: slider `50..2500`, step `10`, default `650`
- `outsideFlashCurve`: slider `0.25..4`, step `0.01`, default `1.6` (power curve)
- `outsideFlashFlickerAmount`: slider `0..1`, step `0.01`, default `0.25`
- `outsideFlashFlickerRate`: slider `0..40`, step `0.1`, default `12`
- `outsideFlashMaxClamp`: slider `0..10`, step `0.05`, default `4`

- `windowFlashIntensityBoost`: slider `0..5`, step `0.05`, default `1.0`
- `windowFlashContrastBoost`: slider `0..5`, step `0.05`, default `1.75`
- `windowFlashRgbBoost`: slider `0..3`, step `0.05`, default `0.35`

**Notes**

- The flash envelope should be computed from `timeInfo` and published as a single scalar (e.g. `lightningFlash01` plus an absolute intensity form if needed).
- Prefer the bolt itself to *trigger* the envelope, but do not require bolt visuals to be enabled to allow sky-flash storms.

## Weather Regimes: Making Lightning a First-Class Weather Output

### Why

Right now the WeatherController has strong concepts of storminess (`stormFactor` in `_environmentState`) and a Directed preset list that includes `Thunderstorm`, but lightning is not represented as a controllable regime output.

We want lightning to be:

- **Driven by weather** (so a thunderstorm naturally produces flashes)
- **Editable in Directed mode** (so GMs can force “rain but no lightning”, or “dry lightning”)
- **Bounded in Dynamic mode** (biome-specific likelihood)

### Proposed Weather Outputs

Add to WeatherController’s derived environment outputs (conceptually):

- `lightningActivity` (0..1): how “electrically active” the atmosphere is right now
- `lightningRate` (events/min): average strike frequency (can be 0)
- `lightningFlashGain` (0..N): how bright the flash is when it happens

These are *not* raw strike events; they describe a regime. The actual strike events are produced by an event process (Poisson / wait-time RNG) seeded by the regime.

### Dynamic Mode Integration

- Use existing latent variables:
  - `humidity` and `storminess` (already present)
  - plus optional new latent `electricalPotential` if needed later

- Derive `lightningActivity` from a curve:
  - High precipitation + high cloudCover + moderate freezeLevel (not blizzard) increases activity.
  - Example conceptual mapping:
    - `activity = saturate((precipitation - 0.35) * 1.8) * saturate((cloudCover - 0.4) * 1.5) * (1 - freezeLevel)`

- Biome tuning:
  - Extend `WeatherController.DYNAMIC_BIOMES[*]` with lightning knobs:
    - `lightningBaseline`, `lightningMaxRate`, `lightningGain`, `lightningStormBias`

- Event process:
  - Convert `lightningRate` into a wait-time distribution.
  - Keep the RNG in WeatherController (or a small LightningRegimeController) so it can be deterministic per scene seed if desired.

### Directed Mode Integration

- Extend the directed preset definitions (where `Thunderstorm` is defined) to include:
  - `lightningRate` (events/min)
  - `lightningGain`

- Add a small “Lightning” subsection in the Weather control panel for Directed mode:
  - `Lightning Enabled` toggle
  - `Lightning Rate`
  - `Lightning Brightness`

### Plumbing / Responsibilities

- WeatherController:
  - Owns the regime variables (`lightningActivity`, `lightningRate`, `lightningFlashGain`).
  - Optionally owns the strike scheduling RNG in Dynamic/Directed mode.

- LightningEffect:
  - Renders bolt visuals (map point-driven).
  - Also can subscribe to weather-driven strike events when in “weather-driven lightning” mode.
  - Publishes `lightningFlash` scalar envelope per strike.

### UI: Where the controls live

- **Art-direction (per effect)**
  - In LightningEffect and WindowLightEffect Tweakpane effect controls (fine-grained knobs).

- **Weather gameplay control (regime)**
  - In Control Panel Weather section (coarse-grained: rate, enable, intensity).
  - Directed preset `Thunderstorm` should set default lightning values.

### Verification checklist

- `Drizzle` / `Light Rain`: rainOnGlass works, but lightning remains 0.
- `Thunderstorm`: lightning strikes occur with plausible spacing, outside flash appears, window lights pop.
- Disabling `outsideFlashEnabled` disables global/outside flash but bolts can still render.
- Disabling bolt visuals still allows sky flash storms (if desired).

## Performance Notes / Guardrails

- **Avoid per-frame allocations**
  - Don’t allocate new `Vector2/Color` in `update()` loops; mutate existing values.

- **Keep offsets pixel-based**
  - Any UV offset magnitude should be “pixels → UV” via `uWindowTexelSize`.

- **Avoid heavy noise**
  - Prefer 1–2 cheap noise layers + some sin hashing.
  - If simplex is needed, keep octave count low.

- **Early-out when no precipitation**
  - If `precipitation < startThreshold`, skip rivulet math and use current shader path.

## Milestones

1. **MVP**
   - Shader-only window rain distortion (Option A).
   - Lightning flash scalar published by LightningEffect (Option 1).
   - WindowLightEffect intensity/contrast boost during flash.

2. **Polish**
   - Tiling flow/normal texture option (Option D) if procedural look isn’t convincing.
   - Outdoor-only brightness modulation in LightingEffect.

## Open Questions

- **Should raindrop distortion apply to the window-light-only (mask-derived) glow, or should it also distort any “window texture detail” in the base albedo?**
  - Current plan assumes *light-only* (WindowLightEffect) as requested.

- **Should lightning flash be tied strictly to visible strikes, or can there be "sky flashes" with no bolts?**
  - Option 1 ties to strikes; Option 2 enables ambient flashes.

---

## Implementation Summary (Completed)

### WindowLightEffect – Rain-on-Glass Distortion
- **New params**: `rainEnabled`, `rainK`, `rainStreakCount`, `rainStreakSharpness`, `rainSpeed`, `rainDarken`, `rainPrecipThresholdStart/End`
- **Shader helpers**: `msHash11`, `msStreak` added to both overlay and light-only fragment shaders.
- **Logic**: Procedural vertical streaks with horizontal wobble, UV offset + darkening, intensity scales with `precipitation` via smoothstep threshold.
- **Uniforms**: `uRainK`, `uRainStreakCount`, `uRainStreakSharpness`, `uRainSpeed`, `uRainDarken`, `uTime` wired in `update()`.

### WindowLightEffect – Lightning Flash Boost
- **New params**: `lightningBoostEnabled`, `lightningContrastGain`, `lightningIntensityGain`
- **Uniforms**: `uLightningFlash01`, `uLightningContrastGain`, `uLightningIntensityGain`
- **Shader**: Applies contrast curve + intensity boost gated by `uLightningFlash01` (0–1 envelope).

### LightningEffect – Outside Flash Envelope
- **New params**: `outsideFlashEnabled`, `outsideFlashAttackMs`, `outsideFlashDecayMs`, `outsideFlashFlickerHz`, `outsideFlashFlickerAmp`, `outsideFlashMaxClamp`
- **Published state**: `MapShine.environment.lightningFlash01`, `lightningStrikeUv`, `lightningStrikeDir`
- **Method**: `_registerStrikeForFlash(start, end, intensity, timeInfo)` projects strike endpoint to screen UV and triggers envelope.

### LightingEffect – Outdoor Lightning Brightening + Edge Shadow Mask
- **New params**: `lightningOutsideEnabled`, `lightningOutsideGain`, `lightningOutsideShadowEnabled`, `lightningOutsideShadowStrength`, `lightningOutsideShadowRadiusPx`, `lightningOutsideShadowEdgeGain`, `lightningOutsideShadowInvert`
- **Uniforms**: `uLightningFlash01`, `uLightningOutsideGain`, `uLightningStrikeUv`, `uLightningStrikeDir`, `uLightningShadow*`
- **Shader**: Outdoor multiplier boosted by `flash01 * gain * (1 - shadow)`. Shadow computed from `_Outdoors` mask gradient at strike UV, half-plane test, distance falloff.

### Files Modified
- `scripts/effects/WindowLightEffect.js`
- `scripts/effects/LightningEffect.js`
- `scripts/effects/LightingEffect.js`
