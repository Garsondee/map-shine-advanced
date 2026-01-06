# PLAN — Cloud System

## Overview

A comprehensive cloud system that provides:
1. **Cloud Shadows** on outdoor areas (via `_Outdoors` mask)
2. **Interior Dimming** through windows when clouds pass overhead
3. **Time-of-Day Aligned Shadow Offset** matching `BuildingShadowsEffect` and `OverheadShadowsEffect`
4. **Zoom-Dependent Cloud Visibility** (cloud tops visible when zoomed out, only shadows when zoomed in)
5. **Sky Reflection in Specular Surfaces** (sky color + cloud reflections on outdoor shiny objects)

This is a multi-component system that touches several existing effects and introduces new rendering passes.

---

## 1. Core Components

### 1.1 CloudEffect (New Effect Class)

**Purpose**: Generate and animate procedural cloud coverage, producing:
- A **cloud density texture** (grayscale, animated)
- A **cloud shadow texture** (offset/stretched based on time of day)
- A **cloud color texture** (for sky reflections)

**Architecture**:
- **Extends**: `EffectBase`
- **Layer**: `RenderLayers.ENVIRONMENTAL`
- **Priority**: Before `LightingEffect`, after `OverheadShadowsEffect` and `BuildingShadowsEffect`

**Render Targets**:
| Target | Format | Purpose |
|--------|--------|---------|
| `cloudDensityTarget` | R8 | Raw cloud coverage (0=clear, 1=solid cloud) |
| `cloudShadowTarget` | R8 | Shadow factor after offset/stretch (0=shadowed, 1=lit) |
| `cloudColorTarget` | RGBA8 | Cloud color for reflections (white clouds on blue sky) |

### 1.2 Cloud Generation Strategy

**Procedural Noise Approach** (recommended for v1):
- Use layered Perlin/Simplex noise in the fragment shader
- Multiple octaves for realistic cloud shapes
- Animate by scrolling UV coordinates over time (wind-driven)
- `WeatherController.cloudCover` controls density threshold

**Alternative: Texture-Based** (future):
- Load a tileable cloud texture atlas
- Blend between cloud types based on weather state
- More art-directed but less flexible

**Shader Pseudocode**:
```glsl
float generateClouds(vec2 uv, float time) {
    vec2 windOffset = uWindDirection * time * uWindSpeed;
    
    // Multi-octave noise
    float n = 0.0;
    n += fbm(uv * 2.0 + windOffset, 4) * 0.5;      // Large billows
    n += fbm(uv * 8.0 + windOffset * 2.0, 3) * 0.3; // Medium detail
    n += fbm(uv * 32.0 + windOffset * 4.0, 2) * 0.2; // Fine wisps
    
    // Threshold by cloud cover
    float threshold = 1.0 - uCloudCover;
    float density = smoothstep(threshold - 0.1, threshold + 0.1, n);
    
    return density;
}
```

---

## 2. Cloud Shadow System

### 2.1 Shadow Casting on Outdoors

**Requirement**: Shadows only appear on the white (outdoor) regions of `_Outdoors` mask.

**Implementation**:
1. Generate cloud density in world-space UV
2. Apply time-of-day offset (see Section 3)
3. Multiply by `_Outdoors` mask to restrict to outdoor areas
4. Output to `cloudShadowTarget`

**Integration with LightingEffect**:
```glsl
// In LightingEffect composite shader
uniform sampler2D tCloudShadow;
uniform float uCloudShadowOpacity;

// Sample cloud shadow
float cloudShadow = texture2D(tCloudShadow, vUv).r;
float cloudShadowFactor = mix(1.0, cloudShadow, uCloudShadowOpacity);

// Apply to ambient light (clouds block sky light)
vec3 shadedAmbient = ambient * overheadShadowFactor * buildingShadowFactor * cloudShadowFactor;
```

### 2.2 Interior Dimming via WindowLightEffect

**Requirement**: When clouds pass over a building, the interior (lit by `WindowLightEffect`) should dim.

**Current State**: `WindowLightEffect` already has `uCloudCover` and `uCloudInfluence` uniforms that dim window light globally based on `WeatherController.cloudCover`.

**Enhancement**: Replace global dimming with **spatially-varying** cloud shadow sampling.

**Implementation**:
1. Pass `cloudShadowTarget` texture to `WindowLightEffect`
2. In the window light shader, sample cloud shadow at the window's UV position
3. Modulate window light intensity by local cloud shadow

**Shader Change in WindowLightEffect**:
```glsl
uniform sampler2D uCloudShadowMap;
uniform float uHasCloudShadowMap;

// In main():
float localCloudShadow = 1.0;
if (uHasCloudShadowMap > 0.5) {
    // Sample cloud shadow at this position
    // Use a slight offset to sample "above" the building (where the cloud is)
    localCloudShadow = texture2D(uCloudShadowMap, vUv).r;
}

// Apply to window light intensity
float cloudFactor = mix(1.0, localCloudShadow, uCloudInfluence);
cloudFactor = max(cloudFactor, uMinCloudFactor);
float windowStrength = m * indoorFactor * cloudFactor;
```

---

## 3. Time-of-Day Shadow Alignment

### 3.1 Shared Sun Direction

All shadow-casting effects must share the same sun direction for visual coherence:
- `OverheadShadowsEffect` — roof shadows
- `BuildingShadowsEffect` — building long shadows
- `CloudEffect` — cloud shadows

**Current Implementation**: Both overhead and building shadows derive sun direction from `WeatherController.timeOfDay`:
```javascript
const hour = weatherController.timeOfDay; // 0-24
const t = (hour % 24.0) / 24.0;
const azimuth = (t - 0.5) * Math.PI;
const x = -Math.sin(azimuth);
const y = Math.cos(azimuth) * sunLatitude;
```

**CloudEffect** will use the same formula, ensuring all shadows point the same direction.

### 3.2 Shadow Offset & Stretch

**Parameters**:
| Parameter | Description | Default |
|-----------|-------------|---------|
| `shadowOffset` | Base offset distance (world units) | 200 |
| `shadowStretch` | Stretch factor for dawn/dusk | 1.0 |
| `sunLatitude` | North/south component (shared) | 0.1 |

**Time-of-Day Behavior**:
- **Midday (12:00)**: Minimal offset, clouds cast shadows nearly directly beneath
- **Morning/Evening (6:00, 18:00)**: Maximum offset, shadows stretch far from clouds
- **Dawn/Dusk**: Additional stretch factor elongates shadows

**Stretch Calculation**:
```javascript
// Sun elevation: 1.0 at noon, 0.0 at horizon
const elevation = Math.cos((hour - 12) / 12 * Math.PI);
const clampedElevation = Math.max(0.1, elevation); // Prevent division by zero

// Offset scales inversely with elevation
const effectiveOffset = shadowOffset / clampedElevation;

// Stretch factor for dawn/dusk (elongates shadows)
const stretchFactor = 1.0 + (1.0 - clampedElevation) * shadowStretch;
```

**Shader Implementation**:
```glsl
uniform vec2 uSunDir;           // Normalized direction
uniform float uShadowOffset;    // Base offset in UV space
uniform float uShadowStretch;   // Stretch multiplier

vec2 getShadowUV(vec2 uv) {
    // Offset UV to sample "where the cloud is" relative to where shadow lands
    vec2 offset = uSunDir * uShadowOffset;
    
    // Apply stretch along sun direction
    vec2 stretchedUV = uv + offset;
    
    return stretchedUV;
}
```

---

## 4. Zoom-Dependent Cloud Visibility

### 4.1 Concept

**Zoomed Out**: Camera is high above the scene
- Cloud tops are visible as a semi-transparent layer
- Shadows are also visible on the ground
- Creates a "satellite view" aesthetic

**Zoomed In**: Camera is close to the ground
- Cloud tops fade out (we're "under" the clouds)
- Only shadows remain visible
- Maintains immersion at table-top scale

### 4.2 Implementation

**Cloud Layer Mesh**:
- Create a separate `THREE.Mesh` for cloud tops at a high Z position (e.g., Z=500)
- Use the same cloud density texture but render as visible geometry
- Apply alpha based on camera zoom level

**Zoom-Based Alpha**:
```javascript
// In CloudEffect.update()
const zoom = sceneComposer.currentZoom;

// Cloud tops visible when zoomed out (zoom < 0.5)
// Fully invisible when zoomed in (zoom > 1.0)
const cloudTopAlpha = 1.0 - smoothstep(0.3, 0.8, zoom);

this.cloudTopMesh.material.opacity = cloudTopAlpha * this.params.cloudTopOpacity;
```

**Parameters**:
| Parameter | Description | Default |
|-----------|-------------|---------|
| `cloudTopOpacity` | Max opacity of cloud tops | 0.7 |
| `cloudTopFadeStart` | Zoom level where fade begins | 0.3 |
| `cloudTopFadeEnd` | Zoom level where fully invisible | 0.8 |
| `cloudTopHeight` | Z position of cloud layer | 500 |

### 4.3 Cloud Top Rendering

**Material**:
```javascript
this.cloudTopMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tCloudDensity: { value: this.cloudDensityTarget.texture },
        uOpacity: { value: 0.7 },
        uCloudColor: { value: new THREE.Color(1.0, 1.0, 1.0) },
        uSkyColor: { value: new THREE.Color(0.5, 0.7, 1.0) }
    },
    vertexShader: /* ... */,
    fragmentShader: `
        uniform sampler2D tCloudDensity;
        uniform float uOpacity;
        uniform vec3 uCloudColor;
        uniform vec3 uSkyColor;
        
        varying vec2 vUv;
        
        void main() {
            float density = texture2D(tCloudDensity, vUv).r;
            
            // Soft cloud edges
            float alpha = smoothstep(0.3, 0.7, density) * uOpacity;
            
            // Cloud color with slight blue tint from sky
            vec3 color = mix(uSkyColor * 0.8, uCloudColor, density);
            
            gl_FragColor = vec4(color, alpha);
        }
    `,
    transparent: true,
    depthWrite: false
});
```

---

## 5. Specular Sky Reflections

### 5.1 Concept

Outdoor specular surfaces should reflect the sky, including:
- **Base sky color** (blue gradient, time-of-day tinted)
- **Cloud reflections** (white patches where clouds are)

This creates a more realistic appearance for water, metal, glass, etc.

### 5.2 Integration with SpecularEffect

**Current State**: `SpecularEffect` renders animated stripes and sparkles based on `_Specular` mask. It does not currently consider sky/environment.

**Enhancement**: Add a new "Sky Reflection" pass that:
1. Samples sky color based on view angle (simplified cubemap)
2. Overlays cloud density as white patches
3. Masks by `_Outdoors` (only outdoor surfaces reflect sky)
4. Blends with existing specular output

### 5.3 New Uniforms for SpecularEffect

```javascript
// Sky reflection uniforms
uSkyReflectionEnabled: { value: true },
uSkyColor: { value: new THREE.Color(0.5, 0.7, 1.0) },
uHorizonColor: { value: new THREE.Color(0.8, 0.85, 0.95) },
uSkyReflectionIntensity: { value: 0.3 },

// Cloud reflection
uCloudDensityMap: { value: null },
uCloudReflectionIntensity: { value: 0.5 },

// Masking
uOutdoorsMask: { value: null },
uHasOutdoorsMask: { value: 0.0 }
```

### 5.4 Shader Implementation

**New function in SpecularEffect fragment shader**:
```glsl
vec3 computeSkyReflection(vec2 uv, float specularMask) {
    if (!uSkyReflectionEnabled) return vec3(0.0);
    
    // Check if outdoors
    float outdoors = 1.0;
    if (uHasOutdoorsMask > 0.5) {
        outdoors = texture2D(uOutdoorsMask, uv).r;
    }
    if (outdoors < 0.5) return vec3(0.0); // Indoor, no sky reflection
    
    // Simple sky gradient (could be enhanced with proper reflection vector)
    vec3 skyColor = mix(uHorizonColor, uSkyColor, 0.5);
    
    // Sample cloud density for cloud reflections
    float cloudDensity = 0.0;
    if (uCloudDensityMap != null) {
        cloudDensity = texture2D(uCloudDensityMap, uv).r;
    }
    
    // Clouds appear as bright white patches in reflection
    vec3 cloudColor = vec3(1.0) * cloudDensity * uCloudReflectionIntensity;
    
    // Combine sky and clouds
    vec3 reflection = skyColor * uSkyReflectionIntensity + cloudColor;
    
    // Modulate by specular mask
    return reflection * specularMask;
}
```

**Integration in main()**:
```glsl
// Existing specular calculation
vec3 specular = computeStripes(...) + computeSparkle(...);

// Add sky reflection
vec3 skyReflection = computeSkyReflection(vUv, specularMask);

// Final output
vec3 finalSpecular = specular + skyReflection;
```

---

## 6. WeatherController Integration

### 6.1 Existing Cloud State

`WeatherController` already tracks:
- `cloudCover` (0.0 - 1.0): Overall cloud density
- `windSpeed` (0.0 - 1.0): Affects cloud movement speed
- `windDirection` (Vector2): Direction clouds drift

### 6.2 New Parameters

Add to `WeatherController`:
```javascript
// Cloud visual tuning
this.cloudTuning = {
    // Generation
    noiseScale: 4.0,           // Base noise frequency
    noiseOctaves: 4,           // Detail levels
    edgeSoftness: 0.15,        // Cloud edge falloff
    
    // Animation
    driftSpeed: 0.02,          // Base drift speed (UV/sec)
    turbulence: 0.3,           // Internal cloud motion
    
    // Shadows
    shadowOpacity: 0.4,        // How dark cloud shadows are
    shadowSoftness: 0.1,       // Shadow edge blur
    
    // Appearance
    cloudBrightness: 1.0,      // Cloud top brightness
    cloudTint: { r: 1, g: 1, b: 1 } // Cloud color tint
};
```

### 6.3 Time-of-Day Cloud Coloring

Clouds should tint based on time of day:
- **Midday**: Pure white
- **Sunrise/Sunset**: Orange/pink/purple tints
- **Night**: Dark gray/blue

This can be driven by `SkyColorEffect` or computed in `CloudEffect`:
```javascript
getCloudTint(hour) {
    // Sunrise (5-7): warm orange
    // Day (7-17): white
    // Sunset (17-19): warm orange/pink
    // Night (19-5): dark blue-gray
    
    if (hour >= 5 && hour < 7) {
        const t = (hour - 5) / 2;
        return lerpColor(SUNRISE_ORANGE, WHITE, t);
    }
    // ... etc
}
```

---

## 7. UI Controls

### 7.1 New "Clouds" Effect Section

**Category**: `atmospheric`
**Label**: "Clouds"

**Parameters**:
| Parameter | Type | Range | Default | Description |
|-----------|------|-------|---------|-------------|
| `enabled` | boolean | - | true | Master enable |
| `cloudCover` | slider | 0-1 | 0.3 | Overall cloud density |
| `driftSpeed` | slider | 0-0.1 | 0.02 | Cloud movement speed |
| `shadowOpacity` | slider | 0-1 | 0.4 | Shadow darkness |
| `shadowOffset` | slider | 0-500 | 200 | Shadow offset distance |
| `shadowStretch` | slider | 0-3 | 1.0 | Dawn/dusk stretch |
| `cloudTopOpacity` | slider | 0-1 | 0.7 | Visible cloud opacity |
| `cloudTopFadeStart` | slider | 0.1-1 | 0.3 | Zoom fade start |
| `cloudTopFadeEnd` | slider | 0.1-1 | 0.8 | Zoom fade end |

### 7.2 SpecularEffect Additions

Add to existing Specular UI:
| Parameter | Type | Range | Default | Description |
|-----------|------|-------|---------|-------------|
| `skyReflectionEnabled` | boolean | - | true | Enable sky reflections |
| `skyReflectionIntensity` | slider | 0-1 | 0.3 | Sky reflection strength |
| `cloudReflectionIntensity` | slider | 0-1 | 0.5 | Cloud reflection strength |

---

## 8. Render Order & Dependencies

### 8.1 Effect Execution Order

```
1. OverheadShadowsEffect    → shadowTarget (roof shadows)
2. BuildingShadowsEffect    → shadowTarget (building shadows)
3. CloudEffect              → cloudDensityTarget, cloudShadowTarget, cloudColorTarget
4. WindowLightEffect        ← reads cloudShadowTarget
5. SpecularEffect           ← reads cloudDensityTarget, outdoorsMask
6. LightingEffect           ← reads all shadow targets
7. [Post-processing...]
```

### 8.2 Texture Dependencies

```
CloudEffect produces:
├── cloudDensityTarget ──→ SpecularEffect (sky reflections)
│                      ──→ CloudEffect (cloud top mesh)
├── cloudShadowTarget  ──→ LightingEffect (ground shadows)
│                      ──→ WindowLightEffect (interior dimming)
└── cloudColorTarget   ──→ SpecularEffect (cloud reflections)

CloudEffect consumes:
├── _Outdoors mask (restrict shadows to outdoor areas)
├── WeatherController state (cloudCover, wind)
└── TimeManager (animation, time of day)
```

---

## 9. Implementation Phases

### Phase 1: Basic Cloud Shadows (MVP)
- [ ] Create `CloudEffect.js` with procedural noise generation
- [ ] Generate `cloudDensityTarget` with animated noise
- [ ] Generate `cloudShadowTarget` with `_Outdoors` masking
- [ ] Integrate shadow into `LightingEffect` composite
- [ ] Basic UI controls (enabled, cloudCover, shadowOpacity)

### Phase 2: Time-of-Day Alignment
- [ ] Implement sun direction sharing with other shadow effects
- [ ] Add shadow offset based on time of day
- [ ] Add shadow stretch for dawn/dusk
- [ ] Sync `sunLatitude` parameter across all shadow effects

### Phase 3: Window Light Integration
- [ ] Pass `cloudShadowTarget` to `WindowLightEffect`
- [ ] Implement spatially-varying cloud dimming
- [ ] Test with various building configurations

### Phase 4: Zoom-Dependent Cloud Tops
- [ ] Create cloud top mesh at elevated Z
- [ ] Implement zoom-based alpha fade
- [ ] Add cloud top rendering with proper blending
- [ ] UI controls for fade thresholds

### Phase 5: Specular Sky Reflections
- [ ] Add sky color uniforms to `SpecularEffect`
- [ ] Implement sky gradient reflection
- [ ] Add cloud density sampling for cloud reflections
- [ ] Mask by `_Outdoors` for outdoor-only reflections
- [ ] UI controls for reflection intensities

### Phase 6: Polish & Optimization
- [ ] Time-of-day cloud tinting
- [ ] Performance optimization (half-res rendering, caching)
- [ ] Weather preset integration
- [ ] Documentation

---

## 10. Performance Considerations

### 10.1 Render Target Sizes

Cloud effects are low-frequency; render at reduced resolution:
- `cloudDensityTarget`: 50% resolution
- `cloudShadowTarget`: 50% resolution
- `cloudColorTarget`: 25% resolution (only for reflections)

### 10.2 Update Frequency

- Cloud animation: Every frame (cheap noise sampling)
- Shadow offset recalculation: Only when `timeOfDay` changes
- Cloud top alpha: Only when zoom changes significantly

### 10.3 Shader Complexity

- Use separable blur for shadow softness
- Limit noise octaves based on GPU tier
- Consider baking noise to texture for low-end devices

---

## 11. Future Enhancements

- **Volumetric Clouds**: Ray-marched 3D clouds for dramatic skies
- **Cloud Types**: Cumulus, stratus, cirrus presets
- **Storm Clouds**: Dark, roiling clouds with lightning flashes
- **God Rays**: Light shafts through cloud gaps
- **Cloud Shadows on Tokens**: Tokens darken when under cloud shadow
- **Precipitation Coupling**: Rain/snow intensity tied to cloud density

---

## 12. File Structure

```
scripts/effects/
├── CloudEffect.js           (NEW - main cloud system)
├── LightingEffect.js        (MODIFY - add cloud shadow input)
├── WindowLightEffect.js     (MODIFY - spatial cloud dimming)
├── SpecularEffect.js        (MODIFY - sky/cloud reflections)
├── OverheadShadowsEffect.js (REFERENCE - sun direction logic)
└── BuildingShadowsEffect.js (REFERENCE - sun direction logic)

scripts/core/
└── WeatherController.js     (MODIFY - add cloudTuning params)

scripts/foundry/
└── canvas-replacement.js    (MODIFY - register CloudEffect, wire textures)
```

---

## 13. Stylized Aesthetic: Pretty Over Realistic

### 13.1 Design Philosophy

**Goal**: Clouds that look *pretty* and *painterly*, not physically accurate.

We're aiming for:
- **Studio Ghibli / Breath of the Wild** aesthetic — soft, dreamy, stylized
- **Readable silhouettes** — clear cloud shapes, not noisy mush
- **Gentle motion** — calming drift, not chaotic turbulence
- **Performance-friendly** — simple math, few texture samples

We're NOT aiming for:
- Physically accurate volumetric scattering
- Realistic cumulonimbus formations
- Complex atmospheric simulation
- Ray-marched 3D clouds (too expensive, wrong aesthetic)

### 13.2 Stylized Cloud Shapes

Instead of pure FBM noise (which can look "procedural"), use a **layered blob approach**:

**Technique: Soft Metaballs / Voronoi Blobs**
```glsl
// Stylized cloud shape using smooth Voronoi cells
float stylizedCloud(vec2 uv, float time) {
    // Large, soft blobs for main cloud masses
    float blobs = 1.0 - smoothVoronoi(uv * 2.0 + time * 0.01, 0.8);
    
    // Gentle edge wobble (not sharp detail)
    float wobble = sin(uv.x * 8.0 + time * 0.5) * 0.05;
    wobble += sin(uv.y * 6.0 + time * 0.3) * 0.03;
    
    // Soft threshold for puffy edges
    float density = smoothstep(0.3 - wobble, 0.6 + wobble, blobs);
    
    return density;
}
```

**Key Characteristics**:
- **Large scale** — clouds are big, soft shapes (not tiny wisps)
- **Smooth edges** — wide smoothstep bands, no hard cutoffs
- **Gentle wobble** — slow sine waves, not high-frequency noise
- **Readable gaps** — clear sky between clouds

### 13.3 Simplified Noise Strategy

**Avoid**: 4-8 octave FBM (expensive, looks "procedural")

**Use Instead**: 2-layer approach
1. **Shape Layer** — Low-frequency Voronoi or simplex (defines cloud blobs)
2. **Detail Layer** — Single octave of soft noise (adds subtle variation)

```glsl
float prettyCloud(vec2 uv, float time) {
    // Layer 1: Big soft shapes
    vec2 shapeUV = uv * 1.5 + time * 0.008;
    float shape = smoothNoise(shapeUV);
    
    // Layer 2: Gentle detail (much smaller contribution)
    vec2 detailUV = uv * 4.0 + time * 0.02;
    float detail = smoothNoise(detailUV) * 0.15;
    
    // Combine with soft threshold
    float raw = shape + detail;
    float threshold = 1.0 - uCloudCover;
    
    // Wide smoothstep for puffy edges
    return smoothstep(threshold - 0.15, threshold + 0.25, raw);
}
```

### 13.4 Color Palette

**Daytime Clouds**:
- Core: Pure white `#FFFFFF`
- Edge tint: Very subtle blue `#F8FAFF`
- Shadow side: Soft lavender `#E8E4F0`

**Sunset/Sunrise Clouds**:
- Highlight: Warm peach `#FFE4D0`
- Mid: Soft pink `#FFCCD0`
- Shadow: Muted purple `#D0B8D8`

**Night Clouds**:
- Highlight: Cool gray `#A0A8B8`
- Shadow: Deep blue-gray `#606878`

---

## 14. Multi-Layer Wind System

### 14.1 Concept: Altitude-Based Wind Speeds

Real clouds at different altitudes move at different speeds due to wind shear. We simulate this with **multiple cloud layers**, each with its own drift speed.

**Visual Effect**:
- High clouds (cirrus-like) drift faster
- Low clouds (cumulus-like) drift slower
- Creates **parallax depth** even in 2D
- Shadows blend from all layers

### 14.2 Cloud Layer Architecture

| Layer | Name | Altitude | Speed Multiplier | Opacity | Character |
|-------|------|----------|------------------|---------|-----------|
| 0 | Ground Shadows | 0 | - | - | Composite of all layers |
| 1 | Low Clouds | 200 | 0.5x | 0.8 | Big, puffy, slow |
| 2 | Mid Clouds | 400 | 1.0x | 0.6 | Medium, standard drift |
| 3 | High Clouds | 600 | 2.0x | 0.4 | Wispy, fast streaks |

### 14.3 Wind Integration with WeatherController

**Existing Wind State**:
```javascript
// WeatherController already has:
windSpeed: 0.0 - 1.0
windDirection: Vector2 (normalized)
gustStrength: 0.0 - 1.0
currentGustStrength: 0.0 - 1.0 (smoothed)
```

**New Cloud Wind Parameters**:
```javascript
this.cloudTuning = {
    // ... existing params ...
    
    // Per-layer wind multipliers
    lowCloudSpeedMult: 0.5,    // Slow, heavy clouds
    midCloudSpeedMult: 1.0,    // Base wind speed
    highCloudSpeedMult: 2.0,   // Fast upper atmosphere
    
    // Gust response per layer
    lowCloudGustResponse: 0.2,  // Heavy clouds resist gusts
    midCloudGustResponse: 0.6,  // Moderate response
    highCloudGustResponse: 1.0, // Light clouds follow gusts
    
    // Direction variance (higher clouds can drift slightly off-axis)
    highCloudDirectionVariance: 0.15 // Radians
};
```

### 14.4 Shader Implementation: Multi-Layer Drift

```glsl
uniform float uTime;
uniform vec2 uWindDirection;
uniform float uWindSpeed;
uniform float uGustStrength;

// Per-layer speed multipliers
uniform float uLowCloudSpeed;
uniform float uMidCloudSpeed;
uniform float uHighCloudSpeed;

// Per-layer gust response
uniform float uLowCloudGust;
uniform float uMidCloudGust;
uniform float uHighCloudGust;

vec2 getLayerOffset(float speedMult, float gustResponse) {
    // Base drift
    vec2 baseDrift = uWindDirection * uWindSpeed * speedMult * uTime;
    
    // Gust adds burst of speed in wind direction
    vec2 gustDrift = uWindDirection * uGustStrength * gustResponse * uTime * 0.5;
    
    return baseDrift + gustDrift;
}

float sampleAllLayers(vec2 uv) {
    // Layer 1: Low clouds (slow, puffy)
    vec2 lowOffset = getLayerOffset(uLowCloudSpeed, uLowCloudGust);
    float lowCloud = stylizedCloud(uv * 1.0 + lowOffset, uTime);
    
    // Layer 2: Mid clouds (standard)
    vec2 midOffset = getLayerOffset(uMidCloudSpeed, uMidCloudGust);
    float midCloud = stylizedCloud(uv * 1.5 + midOffset + vec2(0.3, 0.7), uTime);
    
    // Layer 3: High clouds (fast, wispy)
    vec2 highOffset = getLayerOffset(uHighCloudSpeed, uHighCloudGust);
    // Add slight direction variance for high clouds
    float variance = sin(uTime * 0.1) * 0.1;
    vec2 variedDir = vec2(
        uWindDirection.x * cos(variance) - uWindDirection.y * sin(variance),
        uWindDirection.x * sin(variance) + uWindDirection.y * cos(variance)
    );
    highOffset = variedDir * uWindSpeed * uHighCloudSpeed * uTime;
    float highCloud = wispyCloud(uv * 3.0 + highOffset, uTime);
    
    // Composite with layer opacities
    float composite = 0.0;
    composite = max(composite, lowCloud * 0.8);
    composite = max(composite, midCloud * 0.6);
    composite = max(composite, highCloud * 0.4);
    
    return composite;
}
```

### 14.5 Wispy High Clouds (Cirrus-Style)

High-altitude clouds should look different — stretched, streaky, translucent:

```glsl
float wispyCloud(vec2 uv, float time) {
    // Stretch along wind direction for streaky appearance
    vec2 stretchedUV = uv;
    stretchedUV.x *= 0.3; // Compress perpendicular to wind
    
    // Soft, elongated noise
    float wisp = smoothNoise(stretchedUV + time * 0.03);
    
    // Very soft threshold (translucent)
    float threshold = 1.0 - uCloudCover * 0.5; // Less dense than low clouds
    return smoothstep(threshold, threshold + 0.4, wisp) * 0.5;
}
```

### 14.6 Shadow Compositing from Multiple Layers

All cloud layers contribute to ground shadows, but with different characteristics:

```glsl
float computeCloudShadow(vec2 uv) {
    // Sample each layer with its time-of-day offset
    vec2 shadowOffset = uSunDir * uShadowOffset;
    
    // Low clouds: sharp, dark shadows (close to ground)
    float lowShadow = stylizedCloud(uv + shadowOffset * 0.5, uTime);
    
    // Mid clouds: medium shadows
    float midShadow = stylizedCloud(uv * 1.5 + shadowOffset * 1.0, uTime);
    
    // High clouds: soft, faint shadows (far from ground)
    float highShadow = wispyCloud(uv * 3.0 + shadowOffset * 2.0, uTime);
    
    // Composite: low clouds dominate, high clouds add subtle variation
    float shadow = 0.0;
    shadow = max(shadow, lowShadow * 0.9);   // Strong
    shadow = max(shadow, midShadow * 0.5);   // Medium
    shadow = max(shadow, highShadow * 0.2);  // Faint
    
    // Apply softness
    return shadow;
}
```

### 14.7 Fake AO for Soft Cloud Shading (Optional)

For the **cloud top mesh / heightfield** (when enabled), add a cheap, fake ambient occlusion based on cloud density curvature so puffy peaks feel sunlit and valleys feel softly shadowed.

**Concept**:
- Treat **high-density regions** as raised lobes
- Use neighboring samples of the **cloud density texture** to estimate concavity/convexity
- Darken concave regions (valleys) and slightly brighten convex ones (peaks)
- This is purely a **screen-space trick** in the cloud top fragment shader, no extra geometry

**Shader Sketch**:
```glsl
uniform sampler2D uCloudDensity;
uniform vec2 uTexelSize;      // 1 / cloudDensity resolution

float sampleDensity(vec2 uv) {
    return texture2D(uCloudDensity, uv).r;
}

vec3 shadeCloud(vec2 uv, vec3 baseCloudColor) {
    float d  = sampleDensity(uv);
    float dN = sampleDensity(uv + vec2(0.0,  uTexelSize.y));
    float dS = sampleDensity(uv + vec2(0.0, -uTexelSize.y));
    float dE = sampleDensity(uv + vec2( uTexelSize.x, 0.0));
    float dW = sampleDensity(uv + vec2(-uTexelSize.x, 0.0));

    // Simple Laplacian: negative in valleys, positive on peaks
    float avg = 0.25 * (dN + dS + dE + dW);
    float curvature = avg - d;

    // Map curvature to an AO term in [0.7, 1.1]
    float ao = clamp(1.0 + curvature * 0.6, 0.7, 1.1);

    // Darken valleys, slightly brighten peaks
    return baseCloudColor * ao;
}
```

**Usage**:
- Only apply in the **cloud top fragment shader** (heightfield rendering path)
- Keep it behind a simple toggle/threshold so it can be disabled on low-tier GPUs
- AO strength factor can be a single scalar param: `cloudAOIntensity` (0-1)

This gives clouds a gentle sense of volume and softness without true volumetric lighting.

---

## 15. Gust Behavior for Clouds

### 15.1 Gust Response Characteristics

When `WeatherController` triggers a gust:
- **Low clouds**: Barely respond (heavy, inertial)
- **Mid clouds**: Moderate acceleration, then settle
- **High clouds**: Quick response, dramatic movement

### 15.2 Smooth Gust Integration

```javascript
// In CloudEffect.update()
const gustStrength = weatherController.currentGustStrength; // Already smoothed

// Per-layer effective wind
const lowWind = baseWind * (1.0 + gustStrength * this.params.lowCloudGustResponse);
const midWind = baseWind * (1.0 + gustStrength * this.params.midCloudGustResponse);
const highWind = baseWind * (1.0 + gustStrength * this.params.highCloudGustResponse);
```

### 15.3 Visual Gust Effects

During gusts, clouds should:
1. **Accelerate** in wind direction
2. **Stretch slightly** (simulate being pushed)
3. **Brighten edges** (wind catching cloud tops)

```glsl
// Gust stretch effect
vec2 gustStretch = uWindDirection * uGustStrength * 0.1;
vec2 stretchedUV = uv + gustStretch * (cloudDensity - 0.5);

// Edge brightening during gusts
float edgeBright = fwidth(cloudDensity) * uGustStrength * 2.0;
vec3 cloudColor = mix(baseCloudColor, vec3(1.0), edgeBright);
```

---

## 16. Performance Budget

### 16.1 Target Metrics

| Metric | Budget | Notes |
|--------|--------|-------|
| Shader complexity | < 50 ALU ops | Simple noise, no raymarching |
| Texture samples | < 8 per pixel | 2-3 noise samples per layer |
| Render targets | 2 (density + shadow) | Half-res each |
| Update frequency | Every frame | Cheap enough for 60fps |

### 16.2 LOD Strategy

**Zoomed Out** (zoom < 0.5):
- Render all 3 cloud layers
- Full detail cloud tops visible
- All shadow layers active

**Zoomed In** (zoom > 1.0):
- Render only low + mid layers (skip high wisps)
- Cloud tops hidden
- Simplified shadow (single layer)

**Very Zoomed In** (zoom > 2.0):
- Single cloud layer
- Minimal shadow
- Maximum performance

### 16.3 GPU Tier Adaptation

**Low Tier**:
- 1 cloud layer
- No cloud tops mesh
- 25% resolution shadows
- 1 noise octave

**Medium Tier**:
- 2 cloud layers
- Cloud tops at 50% opacity
- 50% resolution shadows
- 2 noise octaves

**High Tier**:
- 3 cloud layers
- Full cloud tops
- Full resolution shadows
- Stylized noise + detail

---

## 17. Integration with Existing Wind Effects

### 17.1 Shared Wind State

The cloud system should feel connected to other wind-driven effects:

| Effect | Wind Response | Notes |
|--------|---------------|-------|
| Rain particles | High | Falls at angle, streaks |
| Snow particles | Medium | Drifts, flutters |
| Fire particles | Low-Medium | Flickers, leans |
| Tree/Bush sway | Medium | Branches move |
| **Clouds** | Varies by layer | Drift, stretch |

### 17.2 Visual Coherence

When wind increases:
1. Rain angles more severely
2. Trees sway more
3. **Clouds accelerate** (especially high layers)
4. Fire leans and gutters

When a gust hits:
1. Rain surges
2. Trees whip
3. **High clouds streak across**
4. Fire flares then dims

This creates a **unified weather system** where all elements respond together.

---

## Summary

The Cloud System is a multi-layered feature that:
1. **Generates** stylized, painterly clouds (not realistic simulation)
2. **Uses multiple layers** with altitude-based wind speeds for parallax
3. **Responds to gusts** with per-layer sensitivity
4. **Casts shadows** on outdoor areas, aligned with time-of-day
5. **Dims interiors** through windows when clouds pass
6. **Fades cloud tops** based on camera zoom for immersion
7. **Reflects** sky and clouds in outdoor specular surfaces
8. **Integrates with WeatherController** for unified wind behavior

**Aesthetic Priority**: Pretty, readable, performant — not physically accurate.

Implementation should proceed in phases, starting with basic shadows and progressively adding features. The system integrates tightly with existing effects (`LightingEffect`, `WindowLightEffect`, `SpecularEffect`) and shares sun direction logic with `OverheadShadowsEffect` and `BuildingShadowsEffect`.

---

## 18. Alternative: Texture-Based Clouds

### 18.1 When to Use Textures vs Procedural

**Procedural (Default)**:
- Infinite variation
- No asset loading
- Consistent style
- Easier to animate smoothly

**Texture-Based (Optional)**:
- Art-directed cloud shapes
- Specific cloud types (cumulus, stratus)
- Map-maker can provide custom `_Clouds` texture
- Better for stylized/hand-painted maps

### 18.2 Hybrid Approach

Support both methods with a fallback:

```javascript
// In CloudEffect.setBaseMesh()
const cloudTexture = assetBundle.masks.find(m => m.id === 'clouds');

if (cloudTexture) {
    // Use artist-provided cloud texture
    this.useProceduralClouds = false;
    this.cloudTexture = cloudTexture.texture;
    this.cloudTexture.wrapS = THREE.RepeatWrapping;
    this.cloudTexture.wrapT = THREE.RepeatWrapping;
} else {
    // Fall back to procedural generation
    this.useProceduralClouds = true;
}
```

### 18.3 Texture Animation

For texture-based clouds, animate by:
1. **UV Scrolling** — Simple drift in wind direction
2. **Dual-texture blend** — Cross-fade between two offset samples for variety
3. **Distortion** — Apply subtle noise-based UV distortion for organic movement

```glsl
// Texture-based cloud sampling with animation
float sampleTexturedCloud(vec2 uv, float time) {
    vec2 drift = uWindDirection * uWindSpeed * time * 0.01;
    
    // Sample 1: Primary
    float cloud1 = texture2D(uCloudTexture, uv + drift).r;
    
    // Sample 2: Offset for variation
    float cloud2 = texture2D(uCloudTexture, uv * 1.3 + drift * 0.7 + vec2(0.5)).r;
    
    // Blend based on time for evolving shapes
    float blend = sin(time * 0.1) * 0.5 + 0.5;
    float cloud = mix(cloud1, cloud2, blend * 0.3);
    
    // Apply cloud cover threshold
    float threshold = 1.0 - uCloudCover;
    return smoothstep(threshold - 0.1, threshold + 0.2, cloud);
}
```

### 18.4 Asset Suffix: `_Clouds`

Add new mask type to the asset loader:
- **Suffix**: `MapName_Clouds.png`
- **Format**: Grayscale (white = cloud, black = clear sky)
- **Tiling**: Should be seamlessly tileable
- **Resolution**: 512x512 or 1024x1024 recommended

---

## 19. Noise Function Reference

### 19.1 Smooth Value Noise (Simple, Fast)

```glsl
// Simple 2D hash
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Smooth value noise with cubic interpolation
float smoothNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    // Cubic Hermite curve for smooth interpolation
    vec2 u = f * f * (3.0 - 2.0 * f);
    
    // Four corners
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    
    // Bilinear interpolation
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
```

### 19.2 Smooth Voronoi (Soft Blobs)

```glsl
// Smooth Voronoi for soft, blobby shapes
float smoothVoronoi(vec2 p, float smoothness) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    float res = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 point = hash2(i + neighbor); // Returns vec2
            
            vec2 diff = neighbor + point - f;
            float d = length(diff);
            
            // Smooth minimum for soft blending
            res += exp(-smoothness * d);
        }
    }
    
    return -(1.0 / smoothness) * log(res);
}

vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}
```

### 19.3 Simplex-Like Noise (Better Quality)

For higher quality clouds, use a simplex-style noise:

```glsl
// Simplex-like 2D noise (simplified)
vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }

float simplexNoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                        -0.577350269189626, 0.024390243902439);
    
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m;
    m = m*m;
    
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    
    return 130.0 * dot(m, g);
}
```

---

## 20. Edge Cases & Fallbacks

### 20.1 No `_Outdoors` Mask

If no `_Outdoors` mask is present:
- Cloud shadows render everywhere (no indoor/outdoor distinction)
- Window light dimming uses global `cloudCover` instead of spatial sampling
- Log warning to console

### 20.2 Zero Wind Speed

When `windSpeed = 0`:
- Clouds still have gentle internal motion (time-based wobble)
- No directional drift
- Gusts can still occur (they add to base speed)

### 20.3 Night Time

When `timeOfDay` is night (19:00 - 5:00):
- Cloud shadows are very faint (moonlight is diffuse)
- Cloud tops tinted dark blue-gray
- Consider disabling cloud shadows entirely at night (optional param)

### 20.4 Extreme Cloud Cover

**cloudCover = 0.0** (Clear sky):
- No clouds rendered
- No shadows
- Skip all cloud passes for performance

**cloudCover = 1.0** (Overcast):
- Solid cloud layer
- Uniform shadow (no gaps)
- Consider switching to simpler "overcast" shader

---

## 21. Revised Implementation Phases

### Phase 1: Core Infrastructure (MVP)
- [ ] Create `CloudEffect.js` skeleton extending `EffectBase`
- [ ] Add `cloudTuning` params to `WeatherController`
- [ ] Implement basic smooth noise function in shader
- [ ] Generate single-layer cloud density texture
- [ ] Basic UI controls (enabled, cloudCover)

### Phase 2: Shadow System
- [ ] Generate `cloudShadowTarget` with `_Outdoors` masking
- [ ] Implement time-of-day shadow offset
- [ ] Integrate into `LightingEffect` composite shader
- [ ] Add shadow opacity/softness controls

### Phase 3: Wind & Animation
- [ ] Connect to `WeatherController` wind state
- [ ] Implement wind-driven UV drift
- [ ] Add gust response system
- [ ] Test with varying wind speeds

### Phase 4: Multi-Layer System
- [ ] Add low/mid/high cloud layers
- [ ] Implement per-layer wind multipliers
- [ ] Add wispy high cloud shader variant
- [ ] Composite shadows from all layers

### Phase 5: Window Light Integration
- [ ] Pass `cloudShadowTarget` to `WindowLightEffect`
- [ ] Implement spatial cloud dimming
- [ ] Test with various building configurations

### Phase 6: Cloud Tops (Zoom-Dependent)
- [ ] Create cloud top mesh at elevated Z
- [ ] Implement zoom-based alpha fade
- [ ] Add cloud top rendering with proper blending
- [ ] Time-of-day cloud coloring

### Phase 7: Specular Sky Reflections
- [ ] Add sky color uniforms to `SpecularEffect`
- [ ] Implement sky gradient reflection
- [ ] Add cloud density sampling for reflections
- [ ] Mask by `_Outdoors`

### Phase 8: Polish & Optimization
- [ ] GPU tier adaptation
- [ ] LOD based on zoom level
- [ ] Texture-based cloud fallback support
- [ ] Weather preset integration
- [ ] Performance profiling
- [ ] Documentation

---

## 22. Open Questions

1. **Should cloud shadows affect tokens?** 
   - Tokens under cloud shadow could be slightly darkened
   - Adds realism but increases complexity
   - Defer to Phase 8 or future enhancement

2. **Should clouds cast colored shadows at sunset?**
   - Orange/pink tinted shadows during golden hour
   - Visually striking but may look odd
   - Make it optional parameter

3. **How should clouds interact with fog?**
   - Heavy fog might obscure cloud shadows
   - Clouds above fog layer still visible when zoomed out
   - Needs design decision

4. **Should we support cloud "types" (cumulus, stratus, cirrus)?**
   - Could be presets that adjust noise parameters
   - Or separate texture sets
   - Defer to future enhancement

5. **Rain/snow coupling?**
   - Precipitation could spawn from cloud density
   - Heavier rain under denser clouds
   - Adds visual coherence but complexity

---

## 23. Potential Issues & Mitigations

### 23.1 Coordinate System Mismatch (The "UV Drift" Problem)

**Risk**: If cloud noise is calculated in Screen Space (`vUv`), clouds will appear to "follow" the camera as the player pans. The world is huge, but the screen is small.

**Symptoms**:
- Clouds slide with the viewport instead of staying fixed to the map
- Shadow positions shift when panning (not just when time changes)
- Breaks immersion — clouds should be pinned to geography

**Solution**: Always use **World Space Coordinates** for cloud generation.

```glsl
// BAD: Screen-space UV (clouds follow camera)
float cloud = generateClouds(vUv, uTime);

// GOOD: World-space UV (clouds pinned to map)
uniform vec2 uSceneSize;      // canvas.dimensions.sceneRect size
uniform vec2 uCameraOffset;   // Current camera position in world coords

vec2 worldUV = (vUv * uViewportSize + uCameraOffset) / uSceneSize;
float cloud = generateClouds(worldUV, uTime);
```

**Implementation Notes**:
- Pass `uCameraOffset` from `UnifiedCameraController` or `sceneComposer.camera.position`
- `uSceneSize` comes from `canvas.dimensions.sceneRect`
- Normalize to 0-1 range over the scene for consistent noise scale
- This matches how `BuildingShadowsEffect` and `OverheadShadowsEffect` handle world-space sampling

---

### 23.2 Shadow "Detachment" at Dawn/Dusk

**Risk**: At very low sun angles, a cloud at Z=500 might cast a shadow 2000+ units away. If `cloudShadowTarget` is only slightly larger than the screen, the shadow will "pop" out of existence when the cloud casting it scrolls off-canvas.

**Symptoms**:
- Shadows appear/disappear abruptly at screen edges
- Dawn/dusk shadows are truncated or missing
- Visible "shadow seams" at viewport boundaries

**Solutions**:

**Option A: Extended Sampling Padding**
```glsl
// Sample cloud noise with padding beyond visible area
vec2 paddedUV = worldUV;
float padding = uShadowOffset * 2.0; // Sample 2x the max offset distance
paddedUV = (paddedUV - 0.5) * (1.0 + padding) + 0.5;
float cloud = generateClouds(paddedUV, uTime);
```

**Option B: Tiling Noise (Wrap-Around)**
```glsl
// Use seamlessly tiling noise so off-screen clouds wrap
vec2 tiledUV = fract(worldUV * uNoiseScale);
float cloud = generateClouds(tiledUV, uTime);
```

**Option C: Larger Render Target**
- Render `cloudDensityTarget` at 150-200% of viewport size
- Sample shadow with offset, then crop to visible area
- More memory but cleanest solution

**Recommendation**: Use **Option B (Tiling Noise)** for procedural clouds. The noise functions in Section 19 already produce tileable output when using `fract()`. For texture-based clouds, ensure the `_Clouds` texture is seamlessly tileable.

---

### 23.3 Indoor Mask "Bleeding" (Shadow Blur Artifact)

**Risk**: If cloud shadows have "Softness" (blur), the shadow might bleed through walls into building interiors if the `_Outdoors` mask is applied *before* the blur pass.

**Symptoms**:
- Soft shadow edges creep into indoor areas
- Interior rooms near windows show cloud shadow gradients
- Mask boundary is visibly "fuzzy"

**Solution**: Apply the `_Outdoors` mask as the **final step** in the shadow composite, *after* any blur/softness processing.

```glsl
// WRONG ORDER: Mask before blur
float shadow = generateCloudShadow(worldUV);
shadow *= outdoorsMask; // Mask applied
shadow = blur(shadow);  // Blur spreads masked edge INTO interiors!

// CORRECT ORDER: Blur before mask
float shadow = generateCloudShadow(worldUV);
shadow = blur(shadow);  // Blur first
shadow *= outdoorsMask; // Mask applied LAST - clean indoor cutoff
```

**Alternative**: Dilate the `_Outdoors` mask slightly (erode the indoor regions) to create a buffer zone:
```glsl
// Erode indoor mask by 1-2 pixels to prevent bleeding
float erodedOutdoors = texture2D(uOutdoorsMask, uv).r;
erodedOutdoors = smoothstep(0.1, 0.2, erodedOutdoors); // Shrink outdoor region slightly
shadow *= erodedOutdoors;
```

---

### 23.4 Over-Darkening (Crushing Blacks)

**Risk**: With multiple shadow systems (Building, Overhead, Cloud, Bush, Tree), naive multiplication crushes shadows to black:
```glsl
// DANGEROUS: Multiplicative stacking
finalColor = ambient * buildingShadow * overheadShadow * cloudShadow;
// 0.5 * 0.5 * 0.5 = 0.125 (way too dark!)
```

**Symptoms**:
- Areas under multiple shadow sources become pitch black
- Players can't see tokens/map details in shaded areas
- Unnatural "ink pool" shadows

**Solutions**:

**Option A: Minimum Shadow Floor**
```glsl
float combinedShadow = buildingShadow * overheadShadow * cloudShadow;
combinedShadow = max(combinedShadow, 0.25); // Never darker than 25%
```

**Option B: Screen Blend for Shadows**
```glsl
// Screen blend: 1 - (1-a)*(1-b)*(1-c)
// Shadows add but never exceed full darkness
float invB = 1.0 - buildingShadow;
float invO = 1.0 - overheadShadow;
float invC = 1.0 - cloudShadow;
float combinedShadow = 1.0 - (invB * invO * invC);
```

**Option C: Max-Based Composition**
```glsl
// Only the darkest shadow wins (no stacking)
float combinedShadow = min(buildingShadow, min(overheadShadow, cloudShadow));
```

**Option D: Weighted Average**
```glsl
// Average shadows with weights
float combinedShadow = (buildingShadow * 0.4 + overheadShadow * 0.3 + cloudShadow * 0.3);
```

**Recommendation**: Use **Option A (Minimum Floor)** with a configurable `uMinShadowBrightness` uniform (default 0.2-0.3). This is simple, predictable, and ensures playability. The floor value could be exposed in UI as "Shadow Intensity Limit".

**Implementation in LightingEffect**:
```glsl
// In composite shader
uniform float uMinShadowBrightness; // Default 0.25

float combinedShadowFactor = shadowFactor * buildingFactor * bushFactor * treeFactor * cloudFactor;
combinedShadowFactor = max(combinedShadowFactor, uMinShadowBrightness);
```

---

## 24. Suggested Refinements

### 24.1 Cloud Parallax for Window Sampling

**Current Plan** (Section 2.2): Sample cloud shadow at the window's ground UV position.

**Problem**: If you sample at the ground position, the interior dims at the exact same moment the ground shadow hits the wall. This looks flat/2D — as if the cloud is at ground level.

**Refinement**: Sample the cloud shadow with a **slight offset in the sun direction** to simulate the cloud being high above the building.

```glsl
// In WindowLightEffect fragment shader
uniform vec2 uSunDir;
uniform float uCloudHeight; // Normalized cloud altitude (0.0-1.0)

// Offset sample position "upward" toward where the cloud actually is
vec2 cloudSampleUV = vUv + uSunDir * uCloudHeight * 0.1;
float localCloudShadow = texture2D(uCloudShadowMap, cloudSampleUV).r;
```

**Visual Effect**:
- Interior dims *slightly before* the ground shadow reaches the building
- Creates the illusion that the cloud is passing overhead at altitude
- More natural "rolling shadow" feel

**Parameter**: `cloudSampleOffset` (0.0 - 0.2) — how far "up" to sample relative to sun direction.

---

### 24.2 Specular "Wetness" Integration

**Current Plan** (Section 5): Sky reflections in specular surfaces.

**Enhancement**: When it's raining (via `WeatherController.precipitation`), **boost sky reflection intensity** to simulate wet surfaces.

```javascript
// In SpecularEffect.update()
const precip = weatherController?.currentState?.precipitation ?? 0;
const wetBoost = 1.0 + precip * 0.5; // 50% brighter reflections when raining

this.material.uniforms.uSkyReflectionIntensity.value = 
    this.params.skyReflectionIntensity * wetBoost;
```

**Rationale**:
- Wet surfaces are more reflective (water fills micro-roughness)
- Clouds look much better reflected on "wet" ground
- Creates powerful atmospheric link between rain and reflections
- Simple multiplier, no shader changes needed

**Formula**: `effectiveIntensity = baseIntensity * (1.0 + precipitation * wetnessFactor)`

**Parameter**: `wetReflectionBoost` (0.0 - 1.0) — how much rain boosts reflections.

---

### 24.3 Zoom Comfort: Separate Cloud Top Transparency

**Current Plan** (Section 4): Cloud tops fade based on zoom level.

**Problem**: When zoomed out (satellite view), cloud tops can obscure tokens and game state. Players often want:
- **Dark shadows** (atmosphere, drama)
- **Faint cloud tops** (playability, can see tokens)

**Refinement**: Add a **separate opacity slider** for cloud tops, independent of shadow opacity.

**New Parameters**:
| Parameter | Type | Range | Default | Description |
|-----------|------|-------|---------|-------------|
| `cloudTopMaxOpacity` | slider | 0-1 | 0.4 | Maximum cloud top visibility (even when fully zoomed out) |
| `shadowOpacity` | slider | 0-1 | 0.6 | Shadow darkness (independent of cloud top visibility) |

**Implementation**:
```javascript
// In CloudEffect.update()
const zoom = sceneComposer.currentZoom;

// Cloud tops: fade based on zoom AND respect max opacity cap
const zoomAlpha = 1.0 - smoothstep(this.params.cloudTopFadeStart, this.params.cloudTopFadeEnd, zoom);
const cloudTopAlpha = zoomAlpha * this.params.cloudTopMaxOpacity;

this.cloudTopMesh.material.opacity = cloudTopAlpha;

// Shadows: completely independent
this.material.uniforms.uShadowOpacity.value = this.params.shadowOpacity;
```

**UI Grouping**:
```
Cloud Visibility
├── Cloud Top Opacity: [====----] 0.4   (how visible cloud layer is)
├── Fade Start Zoom:   [======--] 0.3   (zoom level where fade begins)
└── Fade End Zoom:     [========] 0.8   (zoom level where fully hidden)

Shadow Settings
├── Shadow Opacity:    [======--] 0.6   (how dark shadows are)
└── Shadow Softness:   [====----] 0.3   (blur amount)
```

This lets map makers create dramatic shadows while keeping cloud tops subtle enough to not interfere with gameplay.

---

## 25. Additional Research Notes

### 25.1 Reference: Existing World-Space Effects

Several existing effects already solve the world-space coordinate problem:

**BuildingShadowsEffect** (`@scripts/effects/BuildingShadowsEffect.js`):
- Uses world-space baked shadow texture
- Samples with camera-compensated UVs
- Good reference for shadow offset math

**OverheadShadowsEffect** (`@scripts/effects/OverheadShadowsEffect.js`):
- Calculates sun direction from `weatherController.timeOfDay`
- Uses `uZoom` for consistent pixel-space offsets
- Lines 362-426 show the sun direction calculation

**WorldSpaceFogEffect** (from memory):
- Renders fog as world-space plane mesh
- Uses `sceneRect` for bounds
- Eliminates coordinate conversion issues

### 25.2 Reference: Shadow Composition in LightingEffect

`LightingEffect.js` (lines 226-274) already handles multiple shadow sources:
```glsl
float combinedShadowFactor = shadowFactor * buildingFactor * bushFactor * treeFactor;
```

Cloud shadows should integrate here with the same pattern. The `uMinShadowBrightness` floor should be applied to this combined factor.

### 25.3 Reference: WeatherController Precipitation State

`WeatherController.js` provides:
- `currentState.precipitation` (0.0 - 1.0)
- `currentState.cloudCover` (0.0 - 1.0)
- `currentState.windSpeed` (0.0 - 1.0)
- `currentState.windDirection` (Vector2)

All available for cloud system integration. The `wetness` property (line 30-31) tracks accumulated wetness with lag behind precipitation — useful for the specular wetness boost.

### 25.4 Noise Tiling Verification

Before implementation, verify that the noise functions in Section 19 produce seamless tiles:
1. Render noise to a test texture
2. Tile 2x2 and check for seams
3. If seams visible, add explicit tiling logic:
```glsl
// Force seamless tiling
vec2 tiledP = fract(p);
// Blend edges for seamless wrap
float edgeBlend = smoothstep(0.0, 0.1, min(tiledP.x, 1.0 - tiledP.x)) *
                  smoothstep(0.0, 0.1, min(tiledP.y, 1.0 - tiledP.y));
```

---

## 26. Pre-Implementation Checklist

Before starting Phase 1, verify:

- [ ] **Coordinate System**: Confirm `UnifiedCameraController` exposes camera offset in world coords
- [ ] **Render Target Size**: Decide on padding strategy for dawn/dusk shadow offset
- [ ] **LightingEffect Integration Point**: Identify exact line where cloud shadow uniform should be added
- [ ] **UI Category**: Confirm `atmospheric` category exists in TweakpaneManager
- [ ] **Asset Loader**: Check if `_Clouds` suffix needs to be added to `loader.js`
- [ ] **Performance Baseline**: Profile current frame time before adding cloud passes