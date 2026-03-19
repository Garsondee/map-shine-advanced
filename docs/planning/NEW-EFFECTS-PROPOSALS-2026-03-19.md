# New Effect Proposals — 2026-03-19

Six new effects proposed for the MapShine V2 compositor.  
Read alongside `V2-EFFECT-DESIGN-CONTRACT.md` and `V2-EFFECT-INTEGRATION.md`.

---

## Summary Table

| # | Effect | Mask(s) | Archetype | Priority | Complexity |
|---|--------|---------|-----------|----------|------------|
| 1 | **God Rays** | `_Windows`, dynamic lights | C — Post-process | High | Medium |
| 2 | **Ice / Frost Surface** | `_Ice` | A — Bus Overlay | High | Medium |
| 3 | **Lava / Magma Surface** | `_Lava` | A + B — Overlay + Particles | High | High |
| 4 | **Ground-Hugging Fog** | `_FogZone` or map points | C — Post-process | Medium | Medium |
| 5 | **Caustics Projection** | `_Water` (shared) | A — Bus Overlay (additive) | Medium | Medium |
| 6 | **Decay / Corruption** | `_Decay` | A + B — Overlay + Particles | Medium | High |

Archetype labels match the V2 Effect Design Contract.

---

## 1. God Rays (Volumetric Light Shafts)

### What it is
Screen-space crepuscular rays ("god rays") that bloom outward from light sources, windows, and
fire. Creates the atmospheric shaft-of-light look in dungeons, cathedrals, and forest clearings.
Completely distinct from `LensEffectV2` (point-source optical artefacts) and the standard
`LightingEffectV2` (multiplicative illumination model). God rays are an additive scattering halo
that radiates visibly through dusty/foggy air.

### Visual description
- Beams radiate outward from a screen-space origin (a window, a torch, the sun)
- Stronger where Dust/Ash particles are present — those layers naturally scatter light
- Intensity falls off with the `_Outdoors` mask (indoor spaces benefit most)
- Animated by the scene's wind state — beams shimmer slightly in wind
- Optionally partially occluded by overhead tile depth

### Technical approach
**Archetype C — Post-processing fullscreen quad.**

1. **Occlusion pass** — render bright light source positions into a small (quarter-res) screen-space
   occlusion map. Sources are: dynamic `ThreeLightSource` positions projected to screen, plus the
   brightest pixels from the `_Windows` mask (treated as emissive origin points).
2. **Radial blur pass** — for each source pixel, sample the lit scene texture along a ray from that
   source toward the pixel (classic Mittring / Epic-style shaft). 8–16 samples per pixel, sampled
   from the already-rendered scene color buffer. Accumulate weighted along the ray.
3. **Composite** — additive blend over the scene output, multiplied by `dustPresence` (sampled from
   the DustEffectV2 CPU mask) to boost where particles scatter light.

```glsl
// Core radial sample loop (simplified)
vec2 delta = (uv - lightScreenPos) / float(NUM_SAMPLES);
vec2 sampleUV = uv;
float illuminationDecay = 1.0;
for (int i = 0; i < NUM_SAMPLES; i++) {
    sampleUV -= delta;
    vec3 s = texture2D(tScene, sampleUV).rgb;
    s *= illuminationDecay * uWeight;
    color += s;
    illuminationDecay *= uDecay;
}
```

**Inputs / uniforms:**
- `tScene` — scene color before compositing (already available as post-process input)
- `uLightScreenPositions[MAX_SHAFTS]` — up to 8 projected light origins
- `uLightShaftColors[MAX_SHAFTS]` — per-shaft color (sunlight = warm, magic = blue, etc.)
- `uExposure`, `uDecay`, `uWeight`, `uDensity` — standard shaft tuning params
- `uDustInfluence` — how much dust presence boosts shaft intensity
- `uWindTime` — animated shimmer offset

### Integration with existing systems
- Sources collected from `LightRegistry` + `WindowLightEffectV2` UV hotspots each frame in `update()`
- Reads `WeatherController.dustLevel` for dust influence
- Reads `DistortionManager` wind state for shimmer
- Runs **after** `LightingEffectV2` and **before** `BloomEffectV2` in the post chain

### UI controls (Tweakpane)
```
God Rays
  ├ Enabled
  ├ Max shafts (1–8)
  ├ Samples per shaft (8/12/16)
  ├ Shaft density (0–1)
  ├ Shaft decay (0.9–1.0)
  ├ Shaft exposure (0–2)
  ├ Dust scattering influence (0–1)
  └ Wind shimmer (0–1)
```

### Mask convention
No new mask suffix required. Sources are derived at runtime from existing light + window data.
Optional `_GodRayOccluder` for user-placed opaque geometry that should block shafts.

### Implementation phases
- **P1** — Single fixed sun shaft from sun azimuth/elevation angle, no window integration
- **P2** — Dynamic light sources as shaft origins, windowed to MAX_SHAFTS closest
- **P3** — `_Windows` mask hot-spot injection + dust scattering boost
- **P4** — Bloom feedback: god ray output feeds back into bloom bright-pass

### Complexity estimate
**Medium.** Radial blur is a well-understood algorithm. The main unknowns are collecting stable
screen-space light positions without per-frame projection spikes, and compositing order.

---

## 2. Ice / Frost Surface

### What it is
A mask-driven PBR surface overlay for frozen/icy surfaces. Reads `_Ice` mask. The visual language
is crystalline — sharp caustic-like reflections, angular frost vein patterns animated slowly,
blue-white edge highlighting, and a subtle anisotropic sheen. This is the cold/winter counterpart
to `SpecularEffectV2` (which handles general wet/shiny) and extends the existing
`WeatherController.freezeLevel` system already embedded in SpecularEffectV2's frost glaze feature
into a full dedicated effect.

### Visual description
- Crystalline caustic highlights on icy surfaces (fast, high-contrast sparkles moving slowly)
- Frost vein / crack pattern overlay that emerges from the mask edges inward
- SDF-derived edge glow (mask border = frost buildup ring)
- Blue-tinted specular tint that pulses subtly ("ice breathing")
- Optional crackle animation: the crack network shifts very slowly, driven by time + noise
- Fully occluded by overhead tiles (depth test)

### Technical approach
**Archetype A — Bus Overlay (per-tile mesh), additive blending.**

```
_Ice mask → SDF (same WaterSurfaceModel approach) → frost edge channel
```

**Shader internals:**
```glsl
// Frost vein network (FBM-based crack approximation)
float frostVeins(vec2 uv, float t) {
    // Voronoi cells → invert → soft-threshold → animate slowly
    vec2 st = uv * uFrostScale;
    float v = voronoi(st + vec2(sin(t * 0.05), cos(t * 0.03)) * 0.02);
    return smoothstep(0.0, uFrostVeinWidth, 1.0 - v);
}

// Caustic-like sparkle from hash noise
float frostSparkle(vec2 uv, float t) {
    // Multi-octave hash noise, animated at ~0.2x water sparkle speed
    float h = hash(floor(uv * uSparkleGrid + t * 0.3));
    return pow(h, uSparkleSharpness);
}

// Final ice surface color
vec3 iceColor = uIceTint
    * (frostSparkle(sceneUV, uTime) * uSparkleIntensity
       + frostVeins(sceneUV, uTime) * uVeinIntensity
       + sdfEdge * uEdgeGlowIntensity);
```

**Uniforms:**
- `tIceMask` — the `_Ice` mask texture
- `uIceTint` — color (default: `vec3(0.7, 0.85, 1.0)`)
- `uFrostScale`, `uFrostVeinWidth` — crack network scale and width
- `uSparkleGrid`, `uSparkleSharpness`, `uSparkleIntensity` — sparkle tuning
- `uEdgeGlowIntensity` — edge/border buildup intensity
- `uWeatherFreezeLevel` — from `WeatherController.freezeLevel`, modulates overall strength
- `uTime`, `uWindDir` — animation

### Integration with existing systems
- `WeatherController.freezeLevel` drives global intensity multiplier — more freeze = stronger ice
- `SpecularEffectV2.frostGlazeEnabled` remains as a subtle outdoor-only frost tint on non-ice
  surfaces; this effect handles surfaces explicitly marked `_Ice`
- `DistortionManager` can register a subtle ice-surface distortion source (very low amplitude,
  makes the ice surface shimmer like heat but cold)
- Reads `DepthShaderChunks` for overhead occlusion (same as `SpecularEffectV2`)

### Mask convention
`_Ice` suffix. Single-channel (red = ice presence). Edge/SDF derived from mask boundary.

### UI controls (Tweakpane)
```
Ice Surface
  ├ Enabled
  ├ Overall intensity (0–2)
  ├ Frost vein scale (0.1–5)
  ├ Frost vein width (0–1)
  ├ Sparkle intensity (0–3)
  ├ Sparkle grid density (10–200)
  ├ Edge glow intensity (0–2)
  ├ Ice tint color (RGB)
  ├ Animation speed (0–2)
  └ Freeze level influence (0–1)
```

### Implementation phases
- **P1** — Static ice mask overlay with vein + sparkle shader, no SDF edge
- **P2** — SDF edge glow (reuse WaterSurfaceModel for SDF generation)
- **P3** — `WeatherController.freezeLevel` integration + animated crack drift
- **P4** — `DistortionManager` ice-shimmer registration

### Complexity estimate
**Medium.** Archetype A is well-understood. Voronoi/FBM crack shaders are established GLSL
patterns. SDF generation reuses the existing WaterSurfaceModel pipeline.

---

## 3. Lava / Magma Surface

### What it is
A mask-driven effect for volcanic/magmatic surfaces. Reads `_Lava` mask. The visual language is
the opposite of ice: dark cooling crust segmented by glowing orange-red fracture lines, with ember
and smoke particle systems rising from the surface. The surface should feel alive — crust plates
slowly drift and crack open, revealing the molten glow beneath.

This is the most ambitious of the six. It combines a surface overlay (Archetype A) with a particle
system (Archetype B) and hooks into `DistortionManager` for heat haze.

### Visual description
- Dark basalt crust plate network, slowly drifting apart
- Bright orange-red glow visible in the gaps (modulated emissive)
- Glow intensity pulses with a low-frequency heartbeat
- Integrated with `DistortionManager` — registers a strong heat distortion source over `_Lava` mask
- Ember particles rise from the brightest/hottest crevice areas (highest glow intensity)
- Optional sulfur smoke particles at lower altitude (slow, brownish)
- Scene ambient temperature: when lava is present, `WeatherController` gets a "heat pressure" input

### Technical approach
**Archetype A (surface shader) + Archetype B (particles) — both floor-scoped.**

**Crust shader:**
```glsl
// Crust plate network via Voronoi
float crustBoundary(vec2 uv, float t) {
    // Voronoi cell distance → threshold → animate plates drifting
    vec2 drift = vec2(sin(t * 0.01 + uv.y * 0.5), cos(t * 0.008 + uv.x * 0.4)) * 0.008;
    return voronoiDist(uv * uCrustScale + drift);
}

float hotness = 1.0 - smoothstep(0.0, uCrustThickness, crustBoundary(uv, uTime));
float pulse   = 0.85 + 0.15 * sin(uTime * uPulseFreq + uv.x * 3.14);

vec3 lavaGlow  = mix(uDeepColor, uShallowColor, hotness) * pulse;
float crustAlpha = smoothstep(uCrustThreshold, 1.0, 1.0 - hotness) * tLavaMask;

// Final: glow where crust is thin, dark where crust is thick
gl_FragColor = vec4(lavaGlow * uGlowIntensity, crustAlpha);
```

**Particle system (Archetype B):**
- CPU-scan `_Lava` mask for brightest crevice pixels → `_lavaHotspotPositionMap` DataTexture
- Using `MultiPointEmitterShape` pattern (same as `FireSparksEffect`) so N hotspots → 1-2 systems
- Ember system: fast upward velocity, small size, orange-red-white color gradient over life
- Smoke system: slow rise, large size, dark brownish, fades out quickly

**Heat distortion:**
```javascript
// In update()
distortionManager.updateSourceParams('lava-heat', {
    intensity: this._params.heatDistortionIntensity * maskPresence,
    frequency: this._params.heatDistortionFrequency,
    speed:     this._params.heatDistortionSpeed,
});
```

### Integration with existing systems
- Registers heat distortion source in `DistortionManager` (same as `FireSparksEffect` does)
- Uses `MultiPointEmitterShape` from `FireSparksEffect` patterns
- Emits `WeatherController` heat signal via a new `heatPressure` float (0–1), which suppresses
  freeze/rain and could eventually boost indoor temperature
- `DepthShaderChunks` for overhead tile occlusion of the surface overlay

### Mask convention
`_Lava` suffix. Red channel = magma presence. Bright areas treated as hottest/most active zones
for particle spawn weight.

### UI controls (Tweakpane)
```
Lava Surface
  ├ Enabled
  ├ Glow intensity (0–3)
  ├ Deep color (RGB) — hottest crevice color
  ├ Shallow color (RGB) — cooler crust edge glow
  ├ Crust scale (0.5–10)
  ├ Crust thickness (0–1)
  ├ Pulse frequency (0–2 Hz)
  ├ Heat distortion
  │   ├ Enabled
  │   ├ Intensity (0–2)
  │   └ Speed (0–3)
  ├ Embers
  │   ├ Enabled
  │   ├ Emission rate (0–200)
  │   └ Rise speed (0–3)
  └ Smoke
      ├ Enabled
      └ Emission rate (0–50)
```

### Implementation phases
- **P1** — Crust surface shader, no particles
- **P2** — `DistortionManager` heat source integration
- **P3** — Ember particle system from hotspot CPU scan
- **P4** — Sulfur smoke system + `WeatherController.heatPressure`

### Complexity estimate
**High.** Combining two archetypes (surface + particles) is the same challenge as
`FireEffectV2` but with a more complex surface shader. The crust-drift animation and
voronoi-based plate system require careful tuning.

---

## 4. Ground-Hugging Fog (Fog Creep)

### What it is
Dense volumetric fog that pools in hollows, rolls along floors, and flows around tokens. Entirely
distinct from `AtmosphericFogEffectV2` (which is distance-based depth haze) and `FogOfWarEffectV2`
(which is the exploration system). This is the classic horror/swamp/dungeon effect where smoke-like
fog lies at ground level, stirs when tokens move through it, and is driven slowly by wind.

### Visual description
- A rolling, billowing layer of dense fog that appears to sit ON the floor (not fill the air)
- Parted by token movement — tokens leave a wake/channel that slowly fills back in
- Wind-driven: fog drifts in the wind direction, forming trails and eddies
- Dissipates at edges and near heat sources (lava, fire mask proximity)
- Optionally constrained to user-defined zones (`_FogZone` mask or map-point areas)
- Color: cool grey-white, optionally tinted (green for swamp, red for volcanic)
- Falls off with vertical elevation — it doesn't climb above a configurable height band

### Technical approach
**Archetype C — Post-processing fullscreen quad, but with a world-space awareness pass.**

The fog is simulated as a layered 3D FBM noise volume sampled at a fixed world-space height plane,
not at the camera's perspective. This means tokens "push through" it correctly at ground level.

```glsl
// World position reconstruction from screen UV + view bounds (existing pattern)
vec2 worldXY = mix(uViewBounds.xy, uViewBounds.zw, vUv);

// Sample fog zone mask (or full-scene fallback)
float fogZone = texture2D(tFogZone, sceneUV).r;

// FBM cloud volume sampled at fog height plane
vec2 fogUV = worldXY * uFogScale + uWindOffset * uTime;
float fogDensity = fbm(fogUV, 4) * fogZone;

// Token wake: sample fog suppression from token position buffer
float wake = sampleTokenWakeField(worldXY);
fogDensity *= (1.0 - wake);

// Height attenuation: fog thins above uFogHeight
float heightFade = smoothstep(uFogHeight + uFogFalloff, uFogHeight, reconstructedZ);
fogDensity *= heightFade;

// Composite over scene
vec3 fogColor = mix(tScene.rgb, uFogTint, fogDensity * uFogOpacity);
```

**Token wake field:**
- A separate small render target (e.g. 256×256) updated each frame
- Token world positions are splatted as Gaussian footprints using their radius
- The field decays each frame (erosion rate = `uWakeDecay`) — fog fills back in over ~2–4 seconds
- Passed as `tTokenWake` uniform

**Fog zone mask:**
Option A: `_FogZone` mask image (same pattern as other masks)  
Option B: Map-point areas drawn by the user in the Map Point editor (reuses existing infrastructure)  
Option C: Full scene with `_FogZone` mask as an exclusion (fog is global but mask suppresses it)

### Integration with existing systems
- Reads `WeatherController.windDir`, `WeatherController.windSpeed` for drift
- `FireEffectV2` / `LavaEffectV2` presence can suppress fog (fire burns it away) — optional
- Token world positions read from `TileManager.getSpritePositions()` each frame for wake field
- Runs in post chain after `LightingEffectV2`, before `BloomEffectV2`
- `DepthShaderChunks` — fog is attenuated on elevated objects (doesn't coat overhead tiles)

### Mask convention
`_FogZone` suffix (optional). If absent, fog covers entire scene (density controlled by params only).
Map-point integration as alternative zone definition.

### UI controls (Tweakpane)
```
Ground Fog
  ├ Enabled
  ├ Density (0–1)
  ├ Fog height (px, floor-relative)
  ├ Fog falloff distance (px)
  ├ FBM scale (0.1–5)
  ├ Wind influence (0–2)
  ├ Fog tint (RGB)
  ├ Edge softness (0–1)
  ├ Token wake
  │   ├ Enabled
  │   ├ Wake radius multiplier (0.5–3)
  │   └ Wake fill-back speed (0.1–2)
  └ Fire dissipation influence (0–1)
```

### Implementation phases
- **P1** — Full-scene FBM fog without zone mask, no token wake
- **P2** — `_FogZone` mask integration
- **P3** — Token wake field (splat + decay render target)
- **P4** — Fire/lava suppression zones + map-point area support

### Complexity estimate
**Medium.** FBM ground fog shaders are established. The main novel piece is the token wake field
(a small dynamic render target updated each frame), which is analogous to the existing
`_maskScene` / `_maskCamera` pattern used by `WaterEffectV2` and others.

---

## 5. Caustics Projection

### What it is
Animated water caustic light patterns projected onto surfaces that are near or beneath water.
Caustics are the bright rippling network of light formed when sunlight or ambient light refracts
through a water surface and is focused onto a surface below.

While `WaterEffectV2` handles the water surface itself (refraction, ripples, foam), it does not
project light onto the floor and walls beneath/around it. Caustics Projection adds that layer —
a shimmering network of light rings and filaments that dance across underwater or poolside geometry.

### Visual description
- Bright rippling web of light projected on surfaces adjacent to `_Water` mask
- Pattern is generated from a time-animated noise function, NOT ray-traced
- Intensity follows the `_Water` mask (strong at center, fades at edges using the Water SDF)
- Color is a warm-tinted white (shallow water) or blue-shifted (deep water)
- Speed and distortion track `WeatherController.windSpeed` and rain intensity
- Attenuated by overhead tile occlusion so caustics don't appear on above-water roofs

### Technical approach
**Archetype A — Bus Overlay (per-tile mesh), additive blending.**

Caustics run as an additive overlay on the same tiles that have a `_Water` mask,
and also on any adjacent non-water tiles within a configurable radius (uses Water SDF falloff).

```glsl
// Classic caustic pattern from two offset FBM noise fields
float causticPattern(vec2 uv, float t) {
    vec2 p = uv * uCausticScale;
    float n1 = fbm(p + vec2(t * 0.15, t * 0.12), 3);
    float n2 = fbm(p - vec2(t * 0.13, t * 0.17) + vec2(0.5), 3);
    // Constructive interference produces the characteristic caustic network
    float c = 1.0 - abs(n1 - n2);
    return pow(max(0.0, c - uCausticThreshold) / (1.0 - uCausticThreshold), uCausticSharpness);
}

float waterPresence = texture2D(tWaterMask, sceneUV).r;
float caustic       = causticPattern(sceneUV, uTime);

vec3 causticColor   = uCausticTint * caustic * waterPresence * uIntensity;
gl_FragColor        = vec4(causticColor, caustic * waterPresence);
```

**Water SDF for adjacency:**
Reuse `WaterSurfaceModel` SDF data (already computed by `WaterEffectV2`). Request the SDF
texture via `WaterEffectV2.getCausticSdfTexture()` — a new accessor that exposes the existing
internal RT without exposing mutable state.

### Integration with existing systems
- Shares `_Water` mask discovery with `WaterEffectV2` — does NOT re-load mask textures; instead
  listens to `EffectMaskRegistry` 'water' slot via `connectToRegistry(registry)`
- Reads `WaterEffectV2` SDF data for edge proximity
- Reads `WeatherController.rainPrecipitation` → speeds up caustic animation during rain
- Reads `WeatherController.windSpeed` for ripple distortion
- Reads `DepthShaderChunks` for overhead tile occlusion

### Mask convention
No new mask suffix. Uses existing `_Water` mask via registry subscription.

### UI controls (Tweakpane)
```
Caustics
  ├ Enabled
  ├ Intensity (0–2)
  ├ Scale (0.1–5)
  ├ Sharpness (1–8) — how thin/sharp the light filaments are
  ├ Threshold (0–0.8) — how much of the pattern is cut off
  ├ Animation speed (0–3)
  ├ Rain speed boost (0–3)
  ├ Tint color (RGB)
  └ Edge falloff (0–1) — how far caustics spread from water edge
```

### Implementation phases
- **P1** — Full `_Water` mask area only, no SDF edge falloff
- **P2** — SDF-based adjacency spread beyond mask border
- **P3** — `WeatherController` rain/wind animation coupling
- **P4** — Depth-based intensity modulation (deeper water = stronger caustics)

### Complexity estimate
**Medium.** Archetype A is the simplest archetype. Two-FBM caustic GLSL is well-understood.
The novel integration is sharing SDF data with `WaterEffectV2` without ownership conflict.

---

## 6. Decay / Corruption

### What it is
A mask-driven organic surface overlay for corrupted, rotting, or supernaturally tainted surfaces.
Reads `_Decay` mask. The visual language is biological horror: pulsating dark veins, phosphorescent
fungal glow, slow liquid seep, and spore particle emissions. This is the supernatural/horror
counterpart to the natural effects above, useful for blighted ruins, necromantic altars, eldritch
zones, and plague maps.

The effect intentionally has a strong stylistic personality — it is not meant to be subtle.
All sub-elements are individually toggleable so GMs can tune it from "subtle rot tinting" to
"full eldritch horror."

### Visual description
- **Vein network**: dark branching vein pattern that pulses with a slow heartbeat rhythm
- **Fungal glow**: luminescent patches (sickly green, purple, or bioluminescent blue) that breathe
  in and out — slightly brighter on the inhale
- **Seep drips**: a subtle downward ooze animation on vertical-ish surfaces (UV offset drip)
- **Edge corruption**: SDF-derived inward creep — the decay "grows" from the mask boundary inward
  over time (driven by a slow `uDecayProgress` uniform, 0 = just starting, 1 = fully rotten)
- **Spore particles**: tiny mote-like particles emitted from the brightest fungal patches, slow
  upward drift with random lateral wander, very low density

### Technical approach
**Archetype A (surface shader) + Archetype B (spore particles) — both floor-scoped.**

**Surface shader:**
```glsl
// Vein network: FBM curl noise derivative lines
float veinMask(vec2 uv, float t) {
    vec2 q = vec2(fbm(uv + t * 0.01), fbm(uv + vec2(5.2, 1.3)));
    float v = fbm(uv + q * uVeinWarp + t * 0.008);
    return pow(smoothstep(0.45, 0.55, v), uVeinSharpness);
}

// Fungal glow: Worley (cellular) noise, slow pulse
float fungalGlow(vec2 uv, float t) {
    float w = worley(uv * uFungalScale);
    float pulse = 0.7 + 0.3 * sin(t * uBreathFreq + w * 6.28);
    return smoothstep(0.3, 0.0, w) * pulse;
}

// Seep: animated UV drip downward
vec2 drippingUV = sceneUV + vec2(0.0, mod(uTime * uSeepSpeed, 1.0)) * uSeepAmp;
float seepMask  = texture2D(tDecayMask, drippingUV).r * 0.3;

// Decay progress: how far the corruption has grown inward (SDF-based)
float sdfProgress = sdfDistance / uDecayRadius;
float decayEdge   = smoothstep(uDecayProgress + 0.1, uDecayProgress - 0.1, sdfProgress);

vec3 decayColor = uVeinColor  * veinMask(sceneUV, uTime)
                + uGlowColor  * fungalGlow(sceneUV, uTime)
                + uSeepColor  * seepMask;

gl_FragColor = vec4(decayColor * decayEdge * tDecayMask.r, /* alpha */ decayEdge * tDecayMask.r);
```

**Spore particles (Archetype B):**
- CPU-scan `_Decay` mask for brightest (most corrupted) pixels → spore spawn point map
- Single `QuarksParticleSystem`: tiny point sprites, very slow upward drift, random XY wander
- Very low emission rate (5–20 particles/sec total), but particles are long-lived (8–15s)
- Pale green/violet color, fades to transparent at top of life

**Animated decay growth:**
`uDecayProgress` can be keyed to a scene flag (`flags.map-shine-advanced.decayProgress`) so GMs
can animate the corruption growing in real time as a scene develops. Defaults to 1.0 (fully grown).

### Integration with existing systems
- Registers a subtle distortion source in `DistortionManager` (pulsing biological shimmer, very low
  amplitude, distinct from heat shimmer — uses a different noise pattern)
- `EffectMaskRegistry` — subscribes to 'decay' slot (new policy entry: `preserveAcrossFloors: false`)
- `DepthShaderChunks` for overhead tile occlusion
- Spore particles use `SmartWindBehavior` for minimal wind response (spores are light)

### Mask convention
`_Decay` suffix. Red channel = decay intensity/progress. Brighter = more corrupted = more particles.

### UI controls (Tweakpane)
```
Decay / Corruption
  ├ Enabled
  ├ Overall intensity (0–2)
  ├ Decay progress (0–1) — how far corruption has grown inward
  ├ Veins
  │   ├ Enabled
  │   ├ Color (RGB)
  │   ├ Scale (0.5–5)
  │   ├ Sharpness (1–8)
  │   └ Speed (0–1)
  ├ Fungal Glow
  │   ├ Enabled
  │   ├ Color (RGB)
  │   ├ Scale (0.5–5)
  │   └ Breathe frequency (0.1–2 Hz)
  ├ Seep
  │   ├ Enabled
  │   ├ Drip speed (0–1)
  │   └ Drip amplitude (0–0.1)
  └ Spores
      ├ Enabled
      ├ Emission rate (0–50)
      └ Lifetime (3–20 s)
```

### Implementation phases
- **P1** — Vein network + fungal glow surface shader, full decay progress (no SDF inward creep)
- **P2** — SDF inward decay progress animation + seep drip
- **P3** — `DistortionManager` biological shimmer source
- **P4** — Spore particle system + `decayProgress` scene flag hook

### Complexity estimate
**High.** Combining FBM vein + Worley glow + drip animation + SDF decay progress in a single
shader is complex to tune. The particle system is straightforward (follows `FireEffectV2` pattern).
The scene-flag-driven `uDecayProgress` is a novel runtime-controllable shader parameter.

---

## Shared Implementation Notes

### New EffectMaskRegistry policies to add
```javascript
// In EffectMaskRegistry.js DEFAULT_POLICIES
ice:   { preserveAcrossFloors: false, tileScoped: true },
lava:  { preserveAcrossFloors: false, tileScoped: true },
decay: { preserveAcrossFloors: false, tileScoped: true },
// caustics uses 'water' (existing), ground fog uses 'fogZone' (new or none)
fogZone: { preserveAcrossFloors: false, tileScoped: false },
```

### Render chain insertion order
```
LightingEffectV2
  → GodRaysEffectV2          ← NEW (before bloom, reads lit scene)
  → WaterEffectV2
  → CausticsEffectV2         ← NEW (additive over water tiles, then composited)
  → IceEffectV2              ← NEW (additive overlay on bus)
  → LavaEffectV2             ← NEW (additive overlay on bus)
  → DecayEffectV2            ← NEW (additive overlay on bus)
  → GroundFogEffectV2        ← NEW (screen-space after scene compositing)
  → AtmosphericFogEffectV2
  → BloomEffectV2
  → SkyColorEffectV2
  → ...
```

### Priority order for implementation
Given existing system health and user value:
1. **God Rays** — standalone, no new mask, high drama-per-line-of-code ratio
2. **Ice Surface** — extends existing freeze system, familiar Archetype A pattern
3. **Caustics** — reuses water mask + SDF, minimal new infrastructure
4. **Ground Fog** — medium complexity, high TTRPG atmosphere value
5. **Lava Surface** — complex but very requested for volcanic maps
6. **Decay** — most complex surface shader, best saved for when others are stable

---

*Document created: 2026-03-19. Author: Cascade.*
