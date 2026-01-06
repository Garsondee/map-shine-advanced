# WindowLightEffect Redesign

## Current State
The current `WindowLightEffect.js` attempts to project light pools into interiors using `_Windows` or `_Structural` masks. It includes logic for:
- Mask thresholding and softening (using `fwidth` and `smoothstep`).
- Cloud shadow occlusion (sampling `uCloudShadowMap`).
- Scene darkness dimming.
- RGB shift for refraction simulation.
- Color correction (Exposure, Brightness, Contrast, etc.).

## Problems Identified
1. **Hard Edges**: The current masking logic (`uMaskThreshold` + `uSoftness` + `fwidth`) often results in aliased or hard edges, especially when the mask resolution doesn't match the screen or when zooming.
2. **Unreliable Cloud Interaction**: Users report cloud shadows do not reliably darken the window lights. This suggests the composition order or the cloud shadow sampling (Screen Space vs World Space alignment) is flawed.
3. **Parameter Conflict**: "Parameters seem to fight each other." This likely refers to the complex interplay between `Intensity`, `Exposure`, `Brightness`, and the various dimming factors (Cloud, Night). Adjusting one requires retuning others.
4. **Complexity**: The shader attempts to do too much "shaping" of the input mask instead of trusting the asset or providing a simpler remapping.

## Proposed Solution

We will simplify the pipeline to focus on a robust "Additive Light" model that respects the environment.

### 1. Masking Strategy
Instead of complex edge detection and thresholding, we will use a smoother remapping of the input mask.
- **Input**: `_Windows` texture (Luminance).
- **Control**: `Gamma` (for falloff control) and `Gain` (Intensity).
- **Refraction**: Sample the mask 3 times with offsets for RGB channels to create the "Refraction" effect directly from the mask source.

### 2. Environmental Integration
- **Cloud Shadows**: Sample the Cloud Shadow Map (screen space, matching `CloudEffect`). This should *modulate* the light intensity.
  - Formula: `lightIntensity *= 1.0 - (cloudShadow * cloudInfluence)`.
- **Darkness**: Scene darkness should simply attenuate the light.
  - Formula: `lightIntensity *= 1.0 - (sceneDarkness * nightDimming)`.

### 3. Simplified Shader Logic
We will strip out the generic Color Correction (Saturation, Temp, Tint, Contrast) unless strictly necessary, or move them to a standard post-process if they are cluttering the specific effect. For now, we'll keep simple `Color` and `Intensity`.

**Core Fragment Logic:**
```glsl
// 1. Refraction / RGB Shift
vec2 rOffset = vec2(cos(angle), sin(angle)) * shiftAmount * texelSize;
vec2 bOffset = -rOffset;
float r = texture(mask, uv + rOffset).r;
float g = texture(mask, uv).g;
float b = texture(mask, uv + bOffset).b;
vec3 lightMap = vec3(r, g, b);

// 2. Apply Mask Power (Gamma/Contrast) to shape the falloff without hard edges
lightMap = pow(lightMap, vec3(uFalloff));

// 3. Environmental Attenuation
float envFactor = 1.0;
// Cloud
if (hasCloudShadow) {
    float shadow = texture(cloudShadowMap, screenUV).r;
    envFactor *= 1.0 - (shadow * uCloudDimming);
}
// Night
envFactor *= 1.0 - (uDarknessLevel * uNightDimming);

// 4. Composition
vec3 finalLight = lightMap * uColor * uIntensity * envFactor;
vec3 base = texture(baseMap, uv).rgb;
gl_FragColor = vec4(base + finalLight, 1.0);
```

### 4. Render Pipeline
- **Layer**: `SURFACE_EFFECTS` (unchanged).
- **Blending**: Keep as an overlay that *adds* to the base map.
- **Outdoors Mask**: Continue to use `_Outdoors` mask to prevent window lights from spilling onto the roof/exterior if desired (though "skylights" might validly be outdoors). We will keep the "Inverse Outdoors" logic (Windows are Indoors) but ensure it's soft.

## Implementation Plan
1. **Refactor `WindowLightEffect.js`**:
   - simplify `getFragmentShader`.
   - remove `fwidth`/`smoothstep` edge logic.
   - implement 3-tap RGB shift.
   - simplify uniforms.
2. **Verify Cloud Coupling**:
   - Ensure `uCloudShadowMap` is correctly passed from `CloudEffect` or `MaskManager`.
   - Debug the screen-space UV alignment.
3. **Verify Darkness**:
   - Check `uDarknessLevel` updates.

