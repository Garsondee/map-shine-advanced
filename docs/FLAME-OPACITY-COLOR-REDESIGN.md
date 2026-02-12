# Flame Opacity & Color Redesign

**Status**: Planning  
**Scope**: `scripts/particles/FireSparksEffect.js` (quarks pipeline)  
**Related**: `scripts/particles/shaders/rendering.js` (stateless pipeline — lower priority)

---

## Table of Contents

1. [Opacity Audit — What's Broken](#part-1)
2. [Color Audit — What's Missing](#part-2)
3. [Fire Science Reference](#part-3)
4. [Proposed Flame Color Architecture](#part-4)
5. [Proposed Smoke System](#part-5)
6. [Proposed Ember Improvements](#part-6)
7. [Implementation Plan](#part-7)
8. [Technical Deep-Dive: Quarks Integration](#part-8)
9. [UI & Presets](#part-9)
10. [File Changes & Migration](#part-10)

---

<a id="part-1"></a>
## Part 1: Opacity Audit — What's Broken



NON-GOAL IMPORTANT: We already have a candle effect, so no need to make this fire effect work for smaller flames.

### The Alpha Pipeline (Current)

A flame particle's final visible alpha is the **product** of all these multiplicative stages:

```
Final Alpha = ColorOverLife(t).w
            × startColor.w              ← quarks engine multiplies these
            × brightness²               ← spawn-time, from mask
            × weatherSurvival           ← spawn-time, from weather
            × materialOpacity           ← 0.85 from flameTextureOpacity
            × textureAlpha              ← from flame.webp
```

With typical values this produces alpha **0.03–0.07** — effectively invisible.

---

### Bug 1: Hidden 0.4× / 0.5× Multiplier in `update()` (CRITICAL)

**Location**: `update()`, lines 2276-2279

```javascript
const opacityMin = Math.max(0.0, Math.min(1.0, rawOpMin * 0.4));  // ← 0.4×
const opacityMax = Math.max(opacityMin, Math.max(0.0, Math.min(1.0, rawOpMax * 0.5))); // ← 0.5×
```

User sets `fireOpacityMin: 0.54`, `fireOpacityMax: 0.97` via UI, but actual values are **0.22** and **0.49**. The slider feels completely broken.

> `_createFireSystem()` (lines 1523-1524) does NOT apply this multiplier — first-frame "pop" artifact.

**Fix**: Remove the `* 0.4` / `* 0.5`. Additive blow-out managed by emission curve instead.

---

### Bug 2: `brightness²` Spawn-Time Alpha Kill (SEVERE)

**Location**: `FireMaskShape.initialize()`, lines 273-275

```javascript
p.color.w *= (brightness * brightness);
```

Medium mask pixel (0.5): `0.5² = 0.25` → alpha reduced to 25%. Combined with Bug 1: **0.12** effective alpha.

**Fix**: Move brightness to size/life only, not alpha. If needed, `sqrt(brightness)` at most.

---

### Bug 3: ColorOverLife × startColor Double Multiplication

Quarks engine multiplies `ColorOverLife` output by `startColor` (quarks.core.module.js:4120-4124). At birth: `1.0 × 0.35 ≈ 0.35`. At mid-life: `0.5 × 0.35 ≈ 0.175`.

**Fix**: Custom `FlameLifecycleBehavior` writes `particle.color` directly, bypassing startColor multiplication entirely. (See Part 8.)

---

### Bug 4: Weather Guttering Stacks on Already-Reduced Alpha

Line 252: `p.color.w *= (0.5 + 0.5 * survival)` — yet another multiplicative stage.

**Fix**: Weather reduces particle COUNT and SIZE, never alpha.

---

### Bug 5: Creation vs Update Opacity Mismatch

Creation uses full slider value; `update()` immediately overrides with reduced `× 0.4/0.5` values. Causes first-frame flash.

**Fix**: Unified via `FlameLifecycleBehavior` — single alpha path.

---

### Summary: Current Effective Alpha (Broken)

Defaults, medium-brightness mask pixel (0.5):

| Life % | ColorOverLife α | × startColor.w | × brightness² | × material | **Effective** |
|--------|----------------|-----------------|---------------|------------|---------------|
| 0%     | 1.0            | 0.35            | 0.25          | 0.85       | **0.074**     |
| 25%    | 0.75           | 0.35            | 0.25          | 0.85       | **0.056**     |
| 50%    | 0.50           | 0.35            | 0.25          | 0.85       | **0.037**     |
| 75%    | 0.25           | 0.35            | 0.25          | 0.85       | **0.019**     |

**0.037–0.074 under additive blending = invisible.** This is why fire looks broken.

---

<a id="part-2"></a>
## Part 2: Color Audit — What's Missing

### Current Color Model

- **`startColor`**: Two-point `ColorRange` lerp from `(fireStartColor.rgb × colorBoostMin, opacityMin)` to `(fireEndColor.rgb × colorBoostMax, opacityMax)`. Per-particle random selection within range.
- **`ColorOverLife`**: Another `ColorRange` interpolating two colors over life, then **multiplied** by startColor by the quarks engine.
- **Temperature**: Lerps between Cold (red/orange) and Hot (blue/white) palettes. Only affects hue.

### Problems

1. **No Smoke Stage**: Flames go orange → transparent. Real fire transitions through visible smoke. Additive blending makes dark colors invisible (`rgb(0.3, 0.3, 0.3)` additive = nothing), so smoke is literally impossible with the current single-system approach.

2. **No Emissive Modeling**: All flame stages have uniform visual "energy". Real fire has a blazing bright core (HDR > 1.0) that genuinely drives bloom, with brightness falling off through the body to near-zero at the tips.

3. **Flat Two-Point Gradient**: Real fire has 5+ distinct color zones — white core, yellow inner, orange body, dark red tips, grey smoke. A two-point lerp can't model this.

4. **Color Boost Double-Application**: `colorBoostMin/Max` multiplies RGB at both `startColor` AND `ColorOverLife`, causing double-boosted over-saturation.

5. **Temperature Only Shifts Hue**: Doesn't model energy output, smoke production, flame height, or burn rate — all properties that change dramatically with temperature.

6. **No Per-Particle Variation**: Every particle follows the exact same color trajectory. Real fire has variation — some tongues burn hotter/cooler — creating visual richness.

---

<a id="part-3"></a>
## Part 3: Fire Science Reference

### 3.1 Blackbody Radiation & Flame Color

Real fire color follows the blackbody radiation curve. A blackbody emitter at temperature T (Kelvin) produces light at a specific color. The Houdini/SideFX `blackbody(temperature, luminance)` VEX function computes CIE XYZ values from temperature (valid 1666K–25000K). For realtime VFX, we pre-bake a simplified sRGB ramp:

| Temperature (K) | Color | Real-World Source |
|-----------------|-------|-------------------|
| 800–1000 | Dark red / barely visible | Smoldering embers, very low fire |
| 1000–1200 | Cherry red → bright red | Glowing coals, dying fire |
| 1200–1400 | Orange-red → orange | Candle flame base, wood fire body |
| 1400–1600 | Orange → yellow-orange | Vigorous wood fire core |
| 1600–1800 | Yellow → white-yellow | Hot campfire core, torch center |
| 1800–2200 | White → blue-white | Gas flame, forge, very hot fire core |

**Approximate linear sRGB values for fire-relevant temperatures:**

```javascript
const BLACKBODY_FIRE = {
  900:  { r: 0.50, g: 0.05, b: 0.00 },  // Deep red glow
  1100: { r: 0.80, g: 0.15, b: 0.00 },  // Red-orange
  1300: { r: 1.00, g: 0.35, b: 0.02 },  // Orange
  1500: { r: 1.00, g: 0.58, b: 0.08 },  // Yellow-orange
  1700: { r: 1.00, g: 0.78, b: 0.28 },  // Warm yellow
  1900: { r: 1.00, g: 0.90, b: 0.55 },  // Pale yellow
  2100: { r: 1.00, g: 0.95, b: 0.80 },  // Near-white
  2500: { r: 0.85, g: 0.92, b: 1.00 },  // Cool white (blue tinge)
};
```

### 3.2 Anatomy of a Flame

A typical diffusion flame (wood fire, campfire) has these visual zones from bottom to top:

```
                    ╭─╮
                   ╱   ╲        ZONE 5: Smoke (grey/black, non-emissive, billowing)
                  ╱ ░░░ ╲       ────────────────────────────
                 ╱ ░░░░░ ╲      ZONE 4: Flame Tip (dark red, barely visible)
                │  ▓▓▓▓▓  │     ────────────────────────────
                │  ▓▓▓▓▓  │     ZONE 3: Outer Flame (orange, moderate brightness)
                │  ████▓  │     ────────────────────────────
                │  █████  │     ZONE 2: Inner Flame (yellow/amber, bright)
                │  █████  │     ────────────────────────────
                 ╲ █████ ╱      ZONE 1: Core / Base (white/yellow, HDR bright, bloom)
                  ╰─────╯
                 ═════════       FUEL SOURCE
```

In a particle system, these spatial zones map onto **particle lifetime**: young particles = core (bright, small, just born); mid-age = body (risen, expanded, orange); old = tip/smoke (highest, expanding, fading).

### 3.3 VFX Industry Best Practices

Research from VFX Apprentice, Unity/Unreal VFX community, and SideFX Houdini documentation:

1. **Layer Multiple Systems**: Fire core, body, and smoke should be separate particle systems with different blending modes, sizes, and behaviors. This is the standard in Unity, Unreal, and Houdini VFX pipelines.

2. **Vary Per-Particle**: Each flame tongue should vary in temperature/brightness. Use random-per-particle variation (±10-20%) so not every particle follows the identical curve.

3. **Emission > Opacity for Glow**: Instead of making flames "opaque", make them "bright". Use HDR color values (RGB > 1.0) with additive blending. Overlapping particles naturally build intensity. Bloom picks up HDR values automatically.

4. **Smoke Needs Normal Blending**: Dark smoke with additive blending = invisible. Always use a separate NormalBlending system. This is a universal rule in realtime VFX.

5. **Size Over Life Tells the Story**: Flames start small at the base, expand through the body. Smoke expands dramatically (billowing). The size curve is as important as color for selling the effect.

6. **Motion Creates Life**: Turbulence, curl noise, and wind interaction are critical. Slight random rotation per-particle breaks up the "sprite sheet" look. The current system already has good turbulence — this redesign focuses on the visual side.

7. **Multiple Textures**: Use different textures for flames vs smoke. Flame texture should have sharp, wispy detail. Smoke texture should be round, soft-edged, billowy. Using the same sprite for both looks wrong.

---

<a id="part-4"></a>
## Part 4: Proposed Flame Color Architecture

### 4.1 Custom `FlameLifecycleBehavior`

Replace the stock `ColorOverLife` with a custom behavior that takes **full control** of `particle.color` each frame. This follows the proven pattern from `DustFadeOverLifeBehavior` in `DustMotesEffect.js`, which stores per-particle base values at spawn and writes `particle.color` directly each update.

**Why custom behavior instead of quarks `Gradient` + `ColorOverLife`?**

The quarks `Gradient` class (line 3036, uses `ContinuousLinearFunction` with multi-stop interpolation) could handle the color curve itself. But `ColorOverLife` always multiplies by `startColor` (line 4124), which means:
- We'd still need `startColor.w = 1.0` (wasting the per-particle brightness channel)
- No way to add the emission multiplier (HDR > 1.0) cleanly
- No per-particle temperature variation
- No way to independently control alpha from a separate envelope

A custom behavior writing directly to `particle.color` gives us full control:

```javascript
class FlameLifecycleBehavior {
  constructor(ownerEffect) {
    this.type = 'FlameLifecycle';
    this.ownerEffect = ownerEffect;

    // Multi-stop gradient data (5 color stops, 6 emission stops, 7 alpha stops)
    // Updated per-frame by frameUpdate() from ownerEffect.params
    this._colorStops = [ /* see 4.2 */ ];
    this._emissionStops = [ /* see 4.3 */ ];
    this._alphaStops = [ /* see 4.4 */ ];

    // Cached per-frame values from params (avoid property lookups per particle)
    this._peakOpacity = 1.0;
    this._emissionScale = 1.0;
    this._temperature = 0.5;
  }

  initialize(particle) {
    // Per-particle random heat variation (±15% of base temperature)
    particle._flameHeat = 0.85 + Math.random() * 0.30;
    // Brightness set by FireMaskShape.initialize() before behaviors run
    if (particle._flameBrightness === undefined) {
      particle._flameBrightness = 1.0;
    }
  }

  update(particle, delta) {
    const t = particle.age / Math.max(0.001, particle.life); // 0 → 1
    const heat = particle._flameHeat ?? 1.0;
    const brightness = Math.max(0.3, particle._flameBrightness ?? 1.0);

    // 1. Sample multi-stop color gradient at time t
    const color = this._lerpColorStops(t);

    // 2. Sample emission multiplier (HDR for bloom)
    const emission = this._lerpEmissionStops(t) * heat * this._emissionScale;

    // 3. Sample alpha envelope
    const alpha = this._lerpAlphaStops(t) * this._peakOpacity;

    // 4. Write directly to particle.color (bypasses startColor multiplication)
    particle.color.x = color.r * emission * brightness;
    particle.color.y = color.g * emission * brightness;
    particle.color.z = color.b * emission * brightness;
    particle.color.w = alpha * brightness;
  }

  frameUpdate(delta) {
    // Read params once per frame, not once per particle
    const p = this.ownerEffect?.params;
    this._peakOpacity = p?.flamePeakOpacity ?? 1.0;
    this._emissionScale = p?.coreEmission ?? 1.0;
    this._temperature = p?.fireTemperature ?? 0.5;
    this._updateGradientsForTemperature(this._temperature);
  }

  reset() {}
  clone() { return new FlameLifecycleBehavior(this.ownerEffect); }
}
```

### 4.2 Multi-Stop Flame Color Gradient

Five stops mapped to particle life fraction `t`:

```
t=0.00  ──── Core:       white-yellow  (1.00, 0.95, 0.85)   ~1900K blackbody
t=0.12  ──── Inner:      rich amber    (1.00, 0.72, 0.20)   ~1500K
t=0.40  ──── Body:       deep orange   (1.00, 0.38, 0.05)   ~1300K
t=0.65  ──── Tip:        dark crimson  (0.60, 0.12, 0.02)   ~1000K
t=1.00  ──── Extinction: near-black    (0.15, 0.04, 0.01)   ~800K
```

**Temperature modulation**: Three pre-computed gradient sets (cold / standard / hot). Temperature lerps between them:

| Temp | Core | Inner | Body | Tip |
|------|------|-------|------|-----|
| 0.0 (Cold) | Dull orange (0.9, 0.5, 0.15) | Dark orange (0.8, 0.25, 0.03) | Dark red (0.5, 0.1, 0.02) | Near-black (0.2, 0.03, 0.01) |
| 0.5 (Standard) | White-yellow (1.0, 0.95, 0.85) | Amber (1.0, 0.72, 0.2) | Orange (1.0, 0.38, 0.05) | Crimson (0.6, 0.12, 0.02) |
| 1.0 (Hot) | Blue-white (0.85, 0.92, 1.0) | White (1.0, 0.95, 0.85) | Yellow (1.0, 0.78, 0.28) | Orange (1.0, 0.38, 0.05) |

### 4.3 Emission Multiplier Curve (HDR for Bloom)

A separate curve that controls HDR brightness, driving bloom via `BLOOM_HOTSPOT_LAYER` (layer 30):

```
t=0.00  ──── 2.50  (HDR bright — core blazes, drives bloom)
t=0.12  ──── 2.00  (inner flame — still very bright)
t=0.35  ──── 1.20  (body — moderate glow)
t=0.55  ──── 0.60  (outer body — dimming)
t=0.70  ──── 0.15  (tip — barely emissive)
t=1.00  ──── 0.00  (dead)
```

With additive blending, a white core at emission=2.5 contributes `(2.5, 2.4, 2.1)` per pixel — well into HDR range. The bloom pass (already using `BLOOM_HOTSPOT_LAYER`) picks this up automatically.

**Temperature also modulates emission**: hot fires have 1.5× emission, cold fires have 0.5×.

### 4.4 Alpha Envelope

A clean, predictable alpha curve with no external multiplicative stages:

```
t=0.00  ──── 0.00  (invisible at spawn — prevents "pop")
t=0.04  ──── 0.85  (rapid fade-in)
t=0.15  ──── 1.00  (full opacity core + inner)
t=0.50  ──── 0.90  (slight fade through body)
t=0.70  ──── 0.50  (noticeable fade at tip)
t=0.90  ──── 0.15  (mostly gone)
t=1.00  ──── 0.00  (dead)
```

**Only ONE modifier**: `brightness` from fire mask, clamped to `[0.3, 1.0]` (linear, not squared). Even dim mask pixels produce visible flames — they just get smaller size and shorter life.

### 4.5 Per-Particle Variation

Each particle stores a random `_flameHeat` value (0.85–1.15) at spawn time. This shifts the color sampling slightly, so:
- Hotter particles: slightly more yellow, higher emission, faster burn
- Cooler particles: slightly more orange/red, lower emission, longer life

Visual result: a campfire with natural variation — some tongues brighter/yellower, some dimmer/redder. Much more organic than uniform particles.

### 4.6 Size Over Life — Flames

Replace the current single bezier with a two-segment `PiecewiseBezier`:

```
t=0.00  ──── 0.30  (small at spawn — just igniting)
t=0.10  ──── 0.80  (rapid expansion)
t=0.25  ──── 1.00  (peak size)
t=0.50  ──── 1.10  (slight growth — expanding body)
t=0.75  ──── 0.90  (dissipating)
t=1.00  ──── 0.40  (shrinking as flame dies)
```

```javascript
new SizeOverLife(new PiecewiseBezier([
  [new Bezier(0.3, 0.9, 1.0, 1.1), 0],     // 0–50%: rapid grow to peak
  [new Bezier(1.1, 1.0, 0.7, 0.4), 0.5]    // 50–100%: gentle shrink
]))
```

---

<a id="part-5"></a>
## Part 5: Proposed Smoke System

### 5.1 Why Smoke Needs a Separate System

Additive blending + dark grey = invisible. This is a fundamental limitation, not a tuning issue. The flame system must stay additive (essential for glowing emissive look and overlap buildup). Smoke must use `NormalBlending`.

This is the standard approach in all professional realtime VFX (Unity, Unreal, Houdini): fire and smoke are always separate particle systems with different blend modes.

### 5.2 `_createSmokeSystem(opts)` — System Design

| Property | Value | Rationale |
|----------|-------|-----------|
| **Blending** | `NormalBlending` | Dark colors must occlude, not add |
| **Texture** | Soft round sprite (reuse `particle.webp` or new `smoke.webp`) | Round, soft-edged for billowing look |
| **Render Order** | 48 | Behind flames (50) and embers (51) |
| **Emission Rate** | `fireRate × smokeRatio` (default 0.3) | Proportional to fire |
| **Start Size** | `fireSizeMin × 0.4` to `fireSizeMax × 0.6` | Born smaller than flames |
| **Size Over Life** | Grow to 3–5× start size | Smoke billows dramatically |
| **Start Life** | `fireLifeMax × 1.5` to `× 2.5` | Persists longer than flame |
| **Updraft** | `fireUpdraft × 2.0` | Hot smoke rises faster |
| **Curl/Turbulence** | `fireCurlStrength × 2.5` | Smoke billows and curls more |
| **Max Particles** | 3000 | Lower than fire (10000) for perf |
| **Depth Write** | `false` | Smoke shouldn't occlude other particles |
| **Wind Susceptibility** | `3.0×` fire's value | Smoke is very wind-sensitive |

### 5.3 `SmokeLifecycleBehavior` — Color & Alpha

Similar pattern to `FlameLifecycleBehavior`, but simpler (no emission/HDR):

**Color gradient (warm grey → neutral grey):**
```
t=0.00  ──── (0.20, 0.15, 0.12)  Warm dark grey (born inside flame)
t=0.10  ──── (0.25, 0.20, 0.17)  Brownish grey (emerging)
t=0.25  ──── (0.30, 0.28, 0.26)  Warm grey (peak visibility)
t=0.50  ──── (0.25, 0.24, 0.23)  Cooling, neutral grey
t=0.75  ──── (0.18, 0.17, 0.17)  Thinning
t=1.00  ──── (0.12, 0.12, 0.12)  Fully dissipated
```

**Alpha (delayed bell curve — hidden inside flame, then emerges):**
```
t=0.00  ──── 0.00  (invisible at spawn — inside flame zone)
t=0.10  ──── 0.15  (beginning to emerge)
t=0.25  ──── 0.35  (clearly visible)
t=0.40  ──── 0.45  (peak opacity — billowing plume)
t=0.65  ──── 0.30  (thinning)
t=0.85  ──── 0.12  (nearly gone)
t=1.00  ──── 0.00  (dissipated)
```

### 5.4 Smoke Size Over Life — Billowing

Smoke's most distinctive visual: dramatic expansion over life.

```
t=0.00  ──── 0.40  (small, born inside flame)
t=0.15  ──── 0.80  (emerging, growing)
t=0.30  ──── 1.50  (expanding rapidly)
t=0.60  ──── 2.80  (large billowing plume)
t=0.80  ──── 3.50  (very large, thin)
t=1.00  ──── 4.00  (maximum spread before death)
```

```javascript
new SizeOverLife(new PiecewiseBezier([
  [new Bezier(0.4, 1.0, 1.5, 2.8), 0],     // 0–60%: rapid billow
  [new Bezier(2.8, 3.2, 3.8, 4.0), 0.6]    // 60–100%: slow expansion
]))
```

### 5.5 Smoke & Temperature

Temperature strongly influences smoke production:

| Temperature | Smoke Ratio | Smoke Color | Rationale |
|-------------|-------------|-------------|-----------|
| 0.0 (Smoldering) | 1.5× base | Near-black, heavy | Incomplete combustion = lots of dark smoke |
| 0.3 (Campfire) | 1.0× base | Warm grey | Normal wood fire |
| 0.5 (Standard) | 0.6× base | Medium grey | Balanced |
| 0.7 (Forge) | 0.2× base | Light grey, thin | Hot fires burn clean |
| 1.0 (Bunsen) | 0.0 (disabled) | N/A | Complete combustion, no visible smoke |

### 5.6 Smoke & Weather / Environment

- **Wind**: Smoke is highly susceptible — `windInfluence × 3.0` vs flames at `× 1.0`. Wind shears the smoke plume sideways.
- **Rain**: Heavy rain suppresses smoke (condenses/cools it). Reduce smoke opacity and life during high precipitation for outdoor particles.
- **Indoor**: Indoor smoke should rise slower (no wind), pool near ceiling (future: cap Z height at `groundZ + roomHeight`). For now, use reduced updraft `× 0.5`.

### 5.7 Smoke Integration with Fire Mask

Smoke spawns from the same `FireMaskShape` as flames. The mask brightness influences smoke:
- **Bright pixels**: More fire, less smoke (complete combustion at the hottest points)
- **Dim pixels**: More smoke, less fire (smoldering edges)

In `FireMaskShape.initialize()`, store brightness for the smoke behavior:
```javascript
p._smokeDensity = 1.0 - (brightness * 0.5); // Inverted — dim areas = more smoke
```

---

<a id="part-6"></a>
## Part 6: Proposed Ember Improvements

### 6.1 `EmberLifecycleBehavior`

Apply the same custom-behavior pattern to embers:

**Color (cooling ember):**
```
t=0.00  ──── (1.0, 0.9, 0.5)    Hot yellow-white (just broke off)
t=0.15  ──── (1.0, 0.6, 0.1)    Bright orange (still very hot)
t=0.40  ──── (0.9, 0.3, 0.02)   Orange-red (cooling)
t=0.70  ──── (0.5, 0.1, 0.01)   Dark red (nearly cooled)
t=1.00  ──── (0.2, 0.02, 0.0)   Almost black (dead ember)
```

**Emission (embers bloom brightly when fresh):**
```
t=0.00  ──── 3.0  (blazing hot, strong bloom)
t=0.10  ──── 2.0  (still very bright)
t=0.30  ──── 1.0  (moderate glow)
t=0.60  ──── 0.3  (dim)
t=1.00  ──── 0.0  (dead)
```

**Size (embers shrink as they cool — burning away):**
```
t=0.00  ──── 1.0
t=0.50  ──── 0.7
t=1.00  ──── 0.2
```

### 6.2 Ember → Smoke Interaction (Optional Enhancement)

When an ember dies, it could spawn 1-2 small smoke wisps via `SubParticleEmitMode.Death`. This creates the visual of embers trailing tiny smoke streams. Low priority but would add significant visual richness.

---

<a id="part-7"></a>
## Part 7: Implementation Plan

### Phase 1: Fix Broken Opacity (Critical — Immediate)

**Goal**: Make fire immediately visible and responsive to UI sliders. No visual redesign yet.

1. **Remove `× 0.4` / `× 0.5` multipliers** from `update()` lines 2276-2279
2. **Remove `brightness²` alpha kill** from `FireMaskShape.initialize()` line 274 — keep brightness on size/life only
3. **Remove alpha reduction from weather guttering** (line 252) — weather reduces count/size only
4. **Unify creation-time and update-time opacity** calculations
5. **Set `startColor.w = 1.0`** for fire systems — ColorOverLife alpha controls the shape

**Expected result**: Fire immediately visible. Sliders work as labeled. No other behavior changes.

### Phase 2: `FlameLifecycleBehavior` (Core Redesign)

**Goal**: Replace flat color with physically-inspired multi-phase lifecycle.

1. **Create `FlameLifecycleBehavior` class** (in `FireSparksEffect.js`):
   - 5-stop color gradient (blackbody-inspired)
   - 6-stop emission multiplier curve (HDR for bloom)
   - 7-stop alpha envelope
   - Per-particle `_flameHeat` variation (±15%)
   - `frameUpdate()` reads ownerEffect.params for temperature, peakOpacity, emission
2. **Update `FireMaskShape.initialize()`**:
   - Store brightness as `p._flameBrightness = brightness` (not modify `p.color.w`)
   - Keep size/life modulation by brightness
3. **Integrate into `_createFireSystem()`**:
   - Replace `ColorOverLife` with `FlameLifecycleBehavior` in behaviors array
   - Set `startColor = new ColorRange(new Vector4(1,1,1,1), new Vector4(1,1,1,1))` (neutral)
   - Remove `_msColorOverLife` from `system.userData`
4. **Update SizeOverLife**: Two-segment `PiecewiseBezier` (grow/shrink)
5. **Enable `BLOOM_HOTSPOT_LAYER`** on fire emitters (currently only on embers)
6. **Clean up `update()` loop**: Remove the color/opacity update code for fire systems (behavior handles it)

### Phase 3: Smoke System (Major Feature)

**Goal**: Add visible smoke that completes the fire look.

1. **Create `_createSmokeSystem(opts)`** factory:
   - `NormalBlending` material
   - Soft round texture
   - `SmokeLifecycleBehavior` for color/alpha
   - Large `SizeOverLife` (4× growth)
   - High updraft + turbulence
   - Render order 48
2. **Create `SmokeLifecycleBehavior`** (same pattern as flame):
   - Warm grey → neutral grey color
   - Delayed bell curve alpha
   - Per-particle `_smokeDensity` from mask brightness
3. **Wire into `setAssetBundle()` and `setMapPointsSources()`**:
   - Create smoke alongside fire for each bucket
   - Track in `this.globalSmokeSystems[]`
4. **Update `update()` loop**: include smoke systems, apply wind/updraft/emission
5. **Update `_destroyParticleSystems()`**: clean up smoke systems
6. **New params**: `smokeEnabled`, `smokeRatio`, `smokeColor`, `smokeRiseSpeed`, `smokeTurbulence`, `smokeMaxSize`
7. **Patch roof mask** on smoke material (same as fire)

### Phase 4: Ember Lifecycle Enhancement

**Goal**: Apply lifecycle treatment to embers for consistency.

1. **Create `EmberLifecycleBehavior`**: color + emission curves
2. **Integrate into `_createEmberSystem()`**: replace ColorOverLife
3. **Update ember SizeOverLife**: shrink-over-life curve

### Phase 5: Temperature Remodel

**Goal**: Temperature affects full fire character.

1. **Pre-compute 3 gradient sets** per behavior: cold / standard / hot
2. **Temperature drives**: color selection, emission multiplier, smoke ratio, height modifier, life modifier
3. **Update `update()` loop**: apply temperature modifiers consistently

### Phase 6: UI & Presets

**Goal**: Clean interface with instant-good presets.

1. **New UI groups**: "Flame Lifecycle", "Smoke"
2. **Presets** (see Part 9)
3. **Deprecate**: `fireStartColor`, `fireEndColor`, `fireColorBoostMin`, `fireColorBoostMax`
4. **New params**: `flamePeakOpacity`, `coreEmission`, `flamePreset`

---

<a id="part-8"></a>
## Part 8: Technical Deep-Dive: Quarks Integration

### 8.1 Why Custom Behavior Over `Gradient` + `ColorOverLife`

The quarks `Gradient` class (quarks.core.module.js:3036) uses `ContinuousLinearFunction` for multi-stop color + alpha curves. It supports arbitrary stops. However:

1. **`ColorOverLife` multiplies by `startColor`** (line 4121-4124). We lose per-particle brightness control through `startColor.w`.
2. **No emission multiplier concept**: Gradient outputs color + alpha but we need a THIRD curve (emission/HDR) multiplying RGB.
3. **No per-particle variation**: Every particle follows the identical curve. Custom behavior reads `particle._flameHeat` for variation.

### 8.2 The `DustFadeOverLifeBehavior` Pattern

`DustMotesEffect.js` already demonstrates the correct approach:

```javascript
// DustFadeOverLifeBehavior.update():
particle.color.x = baseR * this._brightness;   // Direct write
particle.color.y = baseG * this._brightness;
particle.color.z = baseB * this._brightness;
particle.color.w = baseA * envelope * this._opacity;
```

Key properties of this pattern:
- **Writes `particle.color` directly** — no `startColor` multiplication
- **Reads per-frame params in `frameUpdate()`** — cached, not per-particle lookup
- **Stores per-particle base values** at spawn in `initialize()`

Our `FlameLifecycleBehavior` follows the same pattern but adds multi-stop gradient sampling and emission.

### 8.3 Multi-Stop Interpolation Implementation

The `_lerpColorStops(t)` helper uses binary search + linear interpolation (matching the `ContinuousLinearFunction` approach in quarks):

```javascript
_lerpColorStops(t) {
  const stops = this._colorStops;
  // Find the two bracketing stops
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
  if (i >= stops.length - 1) return stops[stops.length - 1];

  const a = stops[i], b = stops[i + 1];
  const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
  return {
    r: a.r + (b.r - a.r) * f,
    g: a.g + (b.g - a.g) * f,
    b: a.b + (b.b - a.b) * f
  };
}
```

For 5-7 stops this is 5-7 comparisons per particle per frame — trivially cheap at typical particle counts (<10000).

### 8.4 Bloom Integration

The bloom pipeline already supports particle hotspots:
- `BLOOM_HOTSPOT_LAYER` = layer 30 (EffectComposer.js:29)
- `BloomEffect.js` renders only layer 30 into `_emberHotspotTarget`, composites with `sparksHotspotIntensity`
- Embers already use it (`system.emitter.layers.enable(BLOOM_HOTSPOT_LAYER)`)

**Change for flames**: Enable `BLOOM_HOTSPOT_LAYER` on fire system emitters too:
```javascript
system.emitter.layers.enable(BLOOM_HOTSPOT_LAYER);
```

The HDR emission values from `FlameLifecycleBehavior` (2.0-2.5 at core) will automatically drive bloom when rendered on layer 30.

### 8.5 Additive vs Normal Blending Split

| System | Blending | Render Order | Bloom Layer | Purpose |
|--------|----------|-------------|-------------|---------|
| Smoke | `NormalBlending` | 48 | No | Grey/black smoke behind flame |
| Flame | `AdditiveBlending` | 50 | Yes (30) | Emissive fire, builds with overlap |
| Ember | `AdditiveBlending` | 51 | Yes (30) | Sparks on top |

Three systems per fire source (already the pattern: fire + ember). Smoke is the third.

### 8.6 Performance Budget

| System | Max Particles | Typical Active | Behavior Cost |
|--------|--------------|----------------|---------------|
| Flame | 10000 | 200–1000 | 5-7 lerps + 3 multiplies per particle |
| Smoke | 3000 | 50–300 | 5-7 lerps + 2 multiplies per particle |
| Ember | 2000 | 50–200 | 5-7 lerps + 3 multiplies per particle |

Total per fire source: ~15000 max capacity, ~300–1500 typical active particles. The lerp operations are negligible compared to the quarks physics (curl noise, forces) already running.

**Mitigation strategies:**
- Smoke uses fewer, larger sprites (3000 max vs 10000 fire)
- Aggressive zoom LOD on all three systems (already implemented)
- Smoke disabled by default at low temperature (Bunsen)
- Per-bucket culling (already implemented)

---

<a id="part-9"></a>
## Part 9: UI & Presets

### 9.1 New Parameters

| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `flamePeakOpacity` | float | 0.95 | 0.0–1.0 | Maximum alpha for flame particles at peak life |
| `coreEmission` | float | 2.5 | 0.5–5.0 | HDR emission multiplier for flame core (drives bloom) |
| `smokeEnabled` | bool | true | — | Enable/disable smoke system |
| `smokeRatio` | float | 0.3 | 0.0–2.0 | Smoke particles per fire particle |
| `smokeColor` | color | (0.25, 0.22, 0.20) | — | Base smoke tint |
| `smokeRiseSpeed` | float | 2.0 | 0.5–5.0 | Smoke updraft multiplier relative to fire |
| `smokeTurbulence` | float | 2.5 | 0.5–5.0 | Smoke curl noise multiplier |
| `smokeMaxSize` | float | 4.0 | 1.0–8.0 | Max smoke particle size multiplier |
| `flamePreset` | enum | "standard" | see below | Quick-select flame style |

### 9.2 Flame Presets

Presets apply a batch of parameter overrides for instant good-looking fire:

| Preset | Temperature | Core Emission | Smoke Ratio | Height | Life | Description |
|--------|-------------|---------------|-------------|--------|------|-------------|
| **Campfire** | 0.4 | 2.0 | 0.5 | Medium | Normal | Warm orange, visible smoke, relaxed |
| **Torch** | 0.55 | 2.5 | 0.2 | Tall | Short | Bright yellow, minimal smoke, energetic |
| **Smoldering** | 0.15 | 0.8 | 1.5 | Short | Long | Dull red, heavy dark smoke, lazy motion |
| **Forge** | 0.8 | 3.5 | 0.05 | Very tall | Very short | White-hot, almost no smoke, intense |
| **Inferno** | 0.6 | 3.0 | 0.8 | Tall | Normal | Bright, lots of smoke, high rate |
| **Magical** | 0.5 | 4.0 | 0.0 | Normal | Normal | User-colored, no smoke, maximum bloom |
| **Candle** | 0.35 | 1.5 | 0.1 | Short | Long | Gentle, warm, minimal smoke |

Presets are applied via `applyParamChange('flamePreset', 'campfire')` which batch-sets the constituent params.

### 9.3 Deprecated Parameters

These become redundant under the new architecture:
- `fireStartColor` / `fireEndColor` → replaced by blackbody gradient + temperature
- `fireColorBoostMin` / `fireColorBoostMax` → replaced by `coreEmission`
- `fireOpacityMin` / `fireOpacityMax` → replaced by `flamePeakOpacity` (single value)

These should remain in `getControlSchema()` for backward compatibility but be hidden from new UI layouts. The `FlameLifecycleBehavior` ignores them.

---

<a id="part-10"></a>
## Part 10: File Changes & Migration

### Primary Files

| File | Changes |
|------|---------|
| `FireSparksEffect.js` | `FlameLifecycleBehavior`, `SmokeLifecycleBehavior`, `EmberLifecycleBehavior` classes; `_createSmokeSystem()` factory; fix opacity bugs in `FireMaskShape.initialize()` and `update()`; new params; preset system; smoke tracking/cleanup |
| `FireSparksEffect.js` | Deprecate `fireStartColor`/`fireEndColor`/`fireColorBoostMin`/`fireColorBoostMax`; replace `fireOpacityMin/Max` with `flamePeakOpacity` |

### Secondary Files (Lower Priority)

| File | Changes |
|------|---------|
| `rendering.js` | Update stateless fire shader's hardcoded color gradient to match new blackbody palette (vertex shader fire branch) |
| `BloomEffect.js` | Verify `sparksHotspotIntensity` works well with flame-layer bloom (may need separate intensity for flames vs embers) |

### Migration

1. Existing saved scenes with `fireStartColor`/`fireEndColor` should continue to work — the `FlameLifecycleBehavior` ignores these and uses its own gradient.
2. The deprecated params remain in `getControlSchema()` but are marked `deprecated: true`.
3. Scenes using custom temperature values continue to work (temperature slider is preserved and enhanced).
4. Default parameters are tuned so that fire looks good out of the box without any user adjustment.

---

## Appendix A: Current vs Proposed Alpha Comparison

### Current (Broken)
```
birth:    1.0 × 0.35 × 0.25 × 0.85 = 0.074    ← invisible
mid-life: 0.5 × 0.35 × 0.25 × 0.85 = 0.037    ← invisible
```

### Proposed (Fixed, medium-brightness pixel)
```
birth:    0.85 × 0.5 = 0.43                      ← visible, builds with overlap
core:     1.00 × 0.5 = 0.50                      ← solid flame
body:     0.90 × 0.5 = 0.45                      ← strong
tip:      0.50 × 0.5 = 0.25                      ← fading gracefully
```

(Where 0.5 is brightness applied linearly, α is from envelope, no material/startColor reduction)

## Appendix B: Proposed Alpha for Smoke

### Smoke (NormalBlending, medium-brightness)
```
birth:    0.00                   ← hidden inside flame
emerging: 0.15 × 0.75 = 0.11    ← barely visible wisps
peak:     0.45 × 0.75 = 0.34    ← visible billowing plume
thinning: 0.20 × 0.75 = 0.15    ← dissipating
death:    0.00                   ← gone
```

(Where 0.75 = inverted brightness for smoke — dim mask areas produce more smoke)

## Appendix C: System Layering Diagram

```
Render Order:
  ┌─────────────────────────────────────────────┐
  │  51: Embers (Additive, BLOOM_HOTSPOT_LAYER) │  ← On top, tiny bright sparks
  ├─────────────────────────────────────────────┤
  │  50: Flames (Additive, BLOOM_HOTSPOT_LAYER) │  ← Middle, emissive fire
  ├─────────────────────────────────────────────┤
  │  48: Smoke  (Normal, no bloom)              │  ← Behind, grey/black smoke
  └─────────────────────────────────────────────┘

Bloom pipeline:
  Layer 30 (BLOOM_HOTSPOT_LAYER) captures:
    - Flame core pixels (emission 2.0–2.5, HDR white/yellow)
    - Ember pixels (emission 2.0–3.0, HDR orange/yellow)
    - Smoke: NOT on bloom layer (dark grey shouldn't glow)
```
