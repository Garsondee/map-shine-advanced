# Water Murkiness Feature Plan

## Overview
Implement a sophisticated "Murkiness" system for WaterEffectV2 that adds animated, grainy sediment layers to water surfaces. This represents deep silt and mud moving around, creating dynamic opacity blocking that obscures the surface below in aesthetically interesting ways.

**Goal**: Create a complex, layered sediment effect that feels alive and organic, with fine-grained control over appearance and behavior.

---

## Feature Concept

### Visual Intent
- **Deep Silt & Mud**: Suspended particles in water column that move with currents and settling patterns
- **Opacity Blocking**: Sediment reduces visibility of surface details (refraction, specular, caustics) in depth-dependent zones
- **Organic Motion**: Multiple noise layers at different scales create natural-looking swirling, settling, and resuspension
- **Depth Stratification**: Different sediment densities at different water depths (shallow vs. deep)

### Aesthetic Modes (Configurable)
1. **Murky River** - Fast-moving, turbulent sediment with high visibility blocking
2. **Swamp Water** - Thick, slow-moving organic matter with strong color tinting
3. **Coastal Silt** - Fine sediment layers that settle and resuspend with wave action
4. **Underwater Haze** - Subtle, atmospheric depth-based opacity that increases downward
5. **Storm Surge** - Chaotic, rapidly moving sediment clouds during weather events

---

## Technical Architecture

### 1. Core Shader Implementation (DistortionManager.js)

#### Uniforms to Add
```glsl
// Murkiness Master Controls
uniform float uWaterMurkEnabled;           // Toggle on/off
uniform float uWaterMurkIntensity;         // Overall strength (0-1)
uniform vec3 uWaterMurkColor;              // Sediment tint color
uniform float uWaterMurkDepthLo;           // Depth range start (0-1)
uniform float uWaterMurkDepthHi;           // Depth range end (0-1)

// Multi-Scale Noise Layers
uniform float uWaterMurkLargeScale;        // Large billowing clouds (1-50)
uniform float uWaterMurkLargeSpeed;        // Large layer animation speed (0-2)
uniform float uWaterMurkLargeStrength;     // Contribution weight (0-1)

uniform float uWaterMurkMidScale;          // Medium swirls (10-200)
uniform float uWaterMurkMidSpeed;          // Medium layer animation speed (0-2)
uniform float uWaterMurkMidStrength;       // Contribution weight (0-1)

uniform float uWaterMurkGrainScale;        // Fine grain detail (100-1000)
uniform float uWaterMurkGrainSpeed;        // Grain animation speed (0-2)
uniform float uWaterMurkGrainStrength;     // Contribution weight (0-1)

// Settling & Turbulence
uniform float uWaterMurkSettlingRate;      // Vertical settling speed (0-1)
uniform float uWaterMurkTurbulence;        // Chaotic motion intensity (0-1)
uniform float uWaterMurkWindInfluence;     // How much wind affects sediment (0-1)

// Opacity & Blocking
uniform float uWaterMurkOpacityMin;        // Minimum opacity at surface (0-1)
uniform float uWaterMurkOpacityMax;        // Maximum opacity at depth (0-1)
uniform float uWaterMurkOpacityCurve;      // Opacity falloff curve (0.1-3.0)

// Advanced Effects
uniform float uWaterMurkCloudiness;        // Soft diffusion of sediment (0-1)
uniform float uWaterMurkEdgeSoftness;      // Feather edges of sediment clouds (0-1)
uniform float uWaterMurkVortexStrength;    // Swirling vortex effect (0-1)
uniform float uWaterMurkVortexScale;       // Size of vortex patterns (1-100)
```

#### Shader Algorithm (Fragment Shader)

```glsl
// Multi-octave FBM for large-scale sediment clouds
float murkLarge = fbm(
  (waterUvIso * uWaterMurkLargeScale) - (windUvDir * uTime * uWaterMurkLargeSpeed),
  4,      // octaves
  2.0,    // lacunarity
  0.5     // persistence
);

// Mid-scale swirling patterns (adds turbulence)
float murkMid = fbm(
  (waterUvIso * uWaterMurkMidScale) + (perpUvDir * uTime * uWaterMurkMidSpeed),
  3,
  2.1,
  0.55
);

// Fine grain detail (high-frequency noise for grit)
float murkGrain = snoise(
  (waterUvIso * uWaterMurkGrainScale) - (windUvDir * uTime * uWaterMurkGrainSpeed)
);

// Combine layers with weighted blending
float murkBase = 
  murkLarge * uWaterMurkLargeStrength +
  murkMid * uWaterMurkMidStrength +
  abs(murkGrain) * uWaterMurkGrainStrength;

// Normalize to 0-1 range
murkBase = clamp(0.5 + 0.5 * murkBase, 0.0, 1.0);

// Apply settling (vertical gradient based on depth)
float settlingMask = mix(
  uWaterMurkOpacityMin,
  uWaterMurkOpacityMax,
  pow(depth, uWaterMurkOpacityCurve)
);
murkBase *= settlingMask;

// Apply settling rate (particles sink over time)
float verticalPhase = mod(uTime * uWaterMurkSettlingRate, 1.0);
murkBase *= mix(1.0, verticalPhase, 0.3);

// Turbulence (chaotic motion that resuspends sediment)
if (uWaterMurkTurbulence > 0.01) {
  float turbulence = snoise(waterUvIso * 3.0 + uTime * uWaterMurkTurbulence);
  murkBase = mix(murkBase, turbulence, uWaterMurkTurbulence * 0.5);
}

// Wind influence (sediment drifts with water currents)
if (uWaterMurkWindInfluence > 0.01) {
  float windDrift = snoise(
    (waterUvIso + windUvDir * uTime * 0.5) * 5.0
  );
  murkBase = mix(murkBase, windDrift, uWaterMurkWindInfluence * 0.3);
}

// Vortex effect (optional swirling pattern)
if (uWaterMurkVortexStrength > 0.01) {
  vec2 centerUv = waterUvIso - 0.5;
  float angle = atan(centerUv.y, centerUv.x);
  float radius = length(centerUv);
  float vortex = sin(angle * 3.0 + radius * uWaterMurkVortexScale - uTime) * 0.5 + 0.5;
  murkBase = mix(murkBase, vortex, uWaterMurkVortexStrength);
}

// Cloudiness (soft diffusion)
murkBase = mix(murkBase, smoothstep(0.2, 0.8, murkBase), uWaterMurkCloudiness);

// Edge softness (feather the sediment clouds)
murkBase = pow(murkBase, 1.0 - uWaterMurkEdgeSoftness * 0.5);

// Final opacity calculation
float murkOpacity = murkBase * uWaterMurkIntensity;
murkOpacity = clamp(murkOpacity, 0.0, 1.0);

// Apply murkiness to scene
if (murkOpacity > 0.01) {
  // Desaturate and tint the scene
  float lum = dot(sceneColor.rgb, vec3(0.299, 0.587, 0.114));
  vec3 desaturated = mix(sceneColor.rgb, vec3(lum), murkOpacity * 0.4);
  
  // Blend with murkiness color
  sceneColor.rgb = mix(desaturated, uWaterMurkColor, murkOpacity * 0.6);
  
  // Reduce specular/caustics visibility through sediment
  sceneColor.rgb *= (1.0 - murkOpacity * 0.3);
}
```

---

### 2. Parameter Schema (WaterEffectV2.js)

#### Control Schema Group
```javascript
{
  name: 'murkiness',
  label: 'Murkiness (Sediment)',
  type: 'folder',
  expanded: false,
  parameters: [
    'murkEnabled',
    'murkIntensity',
    'murkColor',
    'murkDepthLo',
    'murkDepthHi',
    
    'murkLargeScale',
    'murkLargeSpeed',
    'murkLargeStrength',
    
    'murkMidScale',
    'murkMidSpeed',
    'murkMidStrength',
    
    'murkGrainScale',
    'murkGrainSpeed',
    'murkGrainStrength',
    
    'murkSettlingRate',
    'murkTurbulence',
    'murkWindInfluence',
    
    'murkOpacityMin',
    'murkOpacityMax',
    'murkOpacityCurve',
    
    'murkCloudiness',
    'murkEdgeSoftness',
    'murkVortexStrength',
    'murkVortexScale'
  ]
}
```

#### Parameter Definitions
```javascript
murkEnabled: { type: 'boolean', label: 'Murkiness Enabled', default: false },
murkIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
murkColor: { type: 'color', label: 'Sediment Color', default: { r: 0.08, g: 0.12, b: 0.10 } },
murkDepthLo: { type: 'slider', label: 'Depth Range Start', min: 0.0, max: 1.0, step: 0.01, default: 0.2 },
murkDepthHi: { type: 'slider', label: 'Depth Range End', min: 0.0, max: 1.0, step: 0.01, default: 0.9 },

murkLargeScale: { type: 'slider', label: 'Large Cloud Scale', min: 1.0, max: 50.0, step: 0.5, default: 8.0 },
murkLargeSpeed: { type: 'slider', label: 'Large Cloud Speed', min: 0.0, max: 2.0, step: 0.01, default: 0.08 },
murkLargeStrength: { type: 'slider', label: 'Large Cloud Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.4 },

murkMidScale: { type: 'slider', label: 'Mid Swirl Scale', min: 10.0, max: 200.0, step: 1.0, default: 50.0 },
murkMidSpeed: { type: 'slider', label: 'Mid Swirl Speed', min: 0.0, max: 2.0, step: 0.01, default: 0.15 },
murkMidStrength: { type: 'slider', label: 'Mid Swirl Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.35 },

murkGrainScale: { type: 'slider', label: 'Grain Detail Scale', min: 100.0, max: 1000.0, step: 10.0, default: 400.0 },
murkGrainSpeed: { type: 'slider', label: 'Grain Detail Speed', min: 0.0, max: 2.0, step: 0.01, default: 0.25 },
murkGrainStrength: { type: 'slider', label: 'Grain Detail Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.25 },

murkSettlingRate: { type: 'slider', label: 'Settling Rate', min: 0.0, max: 1.0, step: 0.01, default: 0.3 },
murkTurbulence: { type: 'slider', label: 'Turbulence', min: 0.0, max: 1.0, step: 0.01, default: 0.2 },
murkWindInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 1.0, step: 0.01, default: 0.4 },

murkOpacityMin: { type: 'slider', label: 'Opacity @ Surface', min: 0.0, max: 1.0, step: 0.01, default: 0.1 },
murkOpacityMax: { type: 'slider', label: 'Opacity @ Depth', min: 0.0, max: 1.0, step: 0.01, default: 0.8 },
murkOpacityCurve: { type: 'slider', label: 'Opacity Curve', min: 0.1, max: 3.0, step: 0.1, default: 1.5 },

murkCloudiness: { type: 'slider', label: 'Cloudiness (Diffusion)', min: 0.0, max: 1.0, step: 0.01, default: 0.3 },
murkEdgeSoftness: { type: 'slider', label: 'Edge Softness', min: 0.0, max: 1.0, step: 0.01, default: 0.4 },
murkVortexStrength: { type: 'slider', label: 'Vortex Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
murkVortexScale: { type: 'slider', label: 'Vortex Scale', min: 1.0, max: 100.0, step: 1.0, default: 20.0 },
```

---

### 3. Preset Configurations

Define aesthetic presets that users can select to quickly achieve different looks:

```javascript
const MURKINESS_PRESETS = {
  'Murky River': {
    murkEnabled: true,
    murkIntensity: 0.65,
    murkColor: { r: 0.15, g: 0.18, b: 0.12 },
    murkDepthLo: 0.1,
    murkDepthHi: 0.8,
    murkLargeScale: 12.0,
    murkLargeSpeed: 0.12,
    murkLargeStrength: 0.45,
    murkMidScale: 60.0,
    murkMidSpeed: 0.2,
    murkMidStrength: 0.4,
    murkGrainScale: 350.0,
    murkGrainSpeed: 0.3,
    murkGrainStrength: 0.3,
    murkSettlingRate: 0.25,
    murkTurbulence: 0.4,
    murkWindInfluence: 0.6,
    murkOpacityMin: 0.2,
    murkOpacityMax: 0.85,
    murkOpacityCurve: 1.2,
    murkCloudiness: 0.2,
    murkEdgeSoftness: 0.3,
    murkVortexStrength: 0.0,
  },
  
  'Swamp Water': {
    murkEnabled: true,
    murkIntensity: 0.8,
    murkColor: { r: 0.10, g: 0.15, b: 0.08 },
    murkDepthLo: 0.05,
    murkDepthHi: 1.0,
    murkLargeScale: 6.0,
    murkLargeSpeed: 0.04,
    murkLargeStrength: 0.5,
    murkMidScale: 30.0,
    murkMidSpeed: 0.08,
    murkMidStrength: 0.45,
    murkGrainScale: 500.0,
    murkGrainSpeed: 0.15,
    murkGrainStrength: 0.35,
    murkSettlingRate: 0.1,
    murkTurbulence: 0.1,
    murkWindInfluence: 0.2,
    murkOpacityMin: 0.3,
    murkOpacityMax: 0.95,
    murkOpacityCurve: 2.0,
    murkCloudiness: 0.6,
    murkEdgeSoftness: 0.5,
    murkVortexStrength: 0.0,
  },
  
  'Coastal Silt': {
    murkEnabled: true,
    murkIntensity: 0.45,
    murkColor: { r: 0.18, g: 0.16, b: 0.12 },
    murkDepthLo: 0.3,
    murkDepthHi: 0.95,
    murkLargeScale: 15.0,
    murkLargeSpeed: 0.1,
    murkLargeStrength: 0.35,
    murkMidScale: 80.0,
    murkMidSpeed: 0.25,
    murkMidStrength: 0.3,
    murkGrainScale: 600.0,
    murkGrainSpeed: 0.4,
    murkGrainStrength: 0.4,
    murkSettlingRate: 0.35,
    murkTurbulence: 0.3,
    murkWindInfluence: 0.7,
    murkOpacityMin: 0.05,
    murkOpacityMax: 0.7,
    murkOpacityCurve: 1.8,
    murkCloudiness: 0.25,
    murkEdgeSoftness: 0.35,
    murkVortexStrength: 0.1,
  },
  
  'Underwater Haze': {
    murkEnabled: true,
    murkIntensity: 0.35,
    murkColor: { r: 0.12, g: 0.14, b: 0.16 },
    murkDepthLo: 0.0,
    murkDepthHi: 1.0,
    murkLargeScale: 20.0,
    murkLargeSpeed: 0.05,
    murkLargeStrength: 0.3,
    murkMidScale: 100.0,
    murkMidSpeed: 0.1,
    murkMidStrength: 0.25,
    murkGrainScale: 800.0,
    murkGrainSpeed: 0.2,
    murkGrainStrength: 0.2,
    murkSettlingRate: 0.15,
    murkTurbulence: 0.05,
    murkWindInfluence: 0.1,
    murkOpacityMin: 0.05,
    murkOpacityMax: 0.6,
    murkOpacityCurve: 2.5,
    murkCloudiness: 0.7,
    murkEdgeSoftness: 0.6,
    murkVortexStrength: 0.0,
  },
  
  'Storm Surge': {
    murkEnabled: true,
    murkIntensity: 0.9,
    murkColor: { r: 0.20, g: 0.18, b: 0.14 },
    murkDepthLo: 0.0,
    murkDepthHi: 1.0,
    murkLargeScale: 25.0,
    murkLargeSpeed: 0.3,
    murkLargeStrength: 0.5,
    murkMidScale: 120.0,
    murkMidSpeed: 0.4,
    murkMidStrength: 0.5,
    murkGrainScale: 300.0,
    murkGrainSpeed: 0.6,
    murkGrainStrength: 0.4,
    murkSettlingRate: 0.0,
    murkTurbulence: 0.8,
    murkWindInfluence: 1.0,
    murkOpacityMin: 0.4,
    murkOpacityMax: 1.0,
    murkOpacityCurve: 1.0,
    murkCloudiness: 0.1,
    murkEdgeSoftness: 0.2,
    murkVortexStrength: 0.3,
  }
};
```

---

## Implementation Phases

### Phase 1: Core Shader & Uniforms
- [ ] Add all murkiness uniforms to DistortionManager.js shader
- [ ] Implement multi-octave FBM noise layers
- [ ] Implement depth-based opacity masking
- [ ] Implement settling and turbulence logic
- [ ] Test shader with basic parameters

### Phase 2: Parameter Integration
- [ ] Add all murkiness parameters to WaterEffectV2.js `params` object
- [ ] Add control schema group to `getControlSchema()`
- [ ] Add parameter definitions to control schema
- [ ] Wire uniforms in `_updateWaterUniforms()` method
- [ ] Test UI controls in Tweakpane

### Phase 3: Advanced Features
- [ ] Implement wind influence coupling
- [ ] Implement vortex/swirl effects
- [ ] Implement cloudiness/diffusion
- [ ] Implement edge softness feathering
- [ ] Test all advanced features

### Phase 4: Presets & Polish
- [ ] Create preset configurations
- [ ] Add preset selector to UI
- [ ] Add preset quick-apply buttons
- [ ] Fine-tune default values
- [ ] Document presets and use cases

### Phase 5: Integration & Testing
- [ ] Test with different water masks
- [ ] Test with varying zoom levels
- [ ] Test performance impact
- [ ] Test with weather system (wind coupling)
- [ ] Test with different lighting conditions

---

## Design Considerations

### Performance
- **Shader Complexity**: Multi-octave FBM is relatively expensive; consider LOD based on zoom
- **Texture Lookups**: Minimize additional texture samples; reuse existing water mask
- **Resolution Scaling**: Grain detail should scale with screen resolution to maintain visual consistency

### Aesthetic Quality
- **Layering**: Three noise scales (large/mid/grain) create visual depth and prevent repetition
- **Temporal Coherence**: Smooth animation speeds prevent jarring transitions
- **Depth Stratification**: Opacity curve creates natural settling appearance
- **Color Tinting**: Desaturation + color blend creates realistic sediment effect

### User Experience
- **Presets**: Five aesthetic modes cover common use cases (river, swamp, coastal, underwater, storm)
- **Granular Control**: Individual scale/speed/strength for each noise layer
- **Intuitive Naming**: Parameters use domain-specific language (settling, turbulence, cloudiness)
- **Visual Feedback**: Real-time preview in Tweakpane

---

## Shader Optimization Tips

1. **Conditional Compilation**: Use bitmask defines to skip expensive calculations when features disabled
2. **Noise Function Reuse**: Cache noise results where possible
3. **Depth Sampling**: Use existing water depth data; don't recalculate
4. **Wind Coupling**: Sample wind direction once per frame, pass as uniform
5. **LOD Strategy**: Reduce grain detail at high zoom levels

---

## Future Extensions

1. **Particle Interaction**: Sediment responds to nearby particle systems (rain, splashes)
2. **Dynamic Depth**: Sediment density varies based on water depth from bathymetry
3. **Seasonal Variation**: Sediment load changes with weather/time of year
4. **Caustic Suppression**: Murkiness blocks caustics proportionally
5. **Refraction Distortion**: Sediment clouds distort refraction differently than clear water
6. **Animated Settling**: Particles visibly settle over time (advanced GPU simulation)

---

## Testing Checklist

- [ ] Shader compiles without errors
- [ ] All uniforms update correctly from UI
- [ ] Presets apply and look correct
- [ ] Performance acceptable (60 FPS on target hardware)
- [ ] Murkiness blocks surface details appropriately
- [ ] Wind influence couples correctly with weather
- [ ] Settling creates natural depth stratification
- [ ] Vortex effect creates interesting swirl patterns
- [ ] Works with all water mask types
- [ ] Works at all zoom levels
- [ ] Works in day/night lighting
- [ ] Works with caustics enabled/disabled
- [ ] Works with foam enabled/disabled

---

## Notes

- **Existing Infrastructure**: Leverage existing FBM, snoise, and wind direction uniforms already in DistortionManager
- **Coordinate System**: Use `waterUvIso` (isometric UV) for consistency with existing water effects
- **Depth Calculation**: Reuse existing `depth` variable from water mask sampling
- **Wind Direction**: Use `windUvDir` already calculated for sand/foam effects
- **Color Blending**: Follow existing pattern of desaturation + tint for consistency
