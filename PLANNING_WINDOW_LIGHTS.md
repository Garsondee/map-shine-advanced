# Planning: Window Lighting & Shadows System

## Overview
This document outlines the plan for a new effect layer: **Window Lighting/Shadows**.
This system allows map makers to define static "light pools" cast by windows using a texture mask. These light pools will dynamically react to weather (clouds/overcast) and interact with the existing specular system.

## Asset System Updates

### New Suffixes
We need to register two new suffixes in `loader.js`:
1.  `_Windows` (Primary standard)
2.  `_Structural` (Backward compatibility for older modules)

Both suffixes map to the same logical `windows` effect mask.

### Texture Format
-   **Type**: Luminance Mask (RGB).
-   **Channel**: Red channel (or grayscale).
-   **Meaning**:
    -   Black (0.0) = No light.
    -   White (1.0) = Full window light intensity.
-   **Alpha**: Ignored (texture is solid opaque).

## Effect Architecture

### Class: `WindowLightEffect`
-   **Extends**: `EffectBase`
-   **Layer**: `SURFACE_EFFECTS` (rendered additively on top of base/material).
-   **Priority**: Medium (renders along with Iridescence/Fire).

### Dependencies
1.  **WeatherController**: Needs access to `cloudCover` (0.0 - 1.0) to dim lights during overcast weather.
2.  **AssetBundle**: Needs access to:
    -   `windows` mask (The effect source).
    -   `outdoors` mask (To occlude light from spilling outdoors).
    -   `specular` mask (Optional, to drive the "glint").

### Shader Logic (Fragment)

The shader performs a simple compositing operation:

```glsl
// Inputs
uniform sampler2D tWindows;    // The Window Light Map
uniform sampler2D tOutdoors;   // The Roof/Outdoor Mask
uniform sampler2D tSpecular;   // The Floor Specular Map (optional)
uniform float uCloudCover;     // 0.0 = Clear, 1.0 = Overcast
uniform vec3 uLightColor;      // Tint for the window light
uniform float uIntensity;      // Master intensity

void main() {
    // 1. Sample Window Light
    float windowStrength = texture2D(tWindows, vUv).r;
    
    // 2. Sample Outdoor Occlusion
    // We discard effect if it is "Outdoors" (White in Outdoors mask)
    float outdoorStrength = texture2D(tOutdoors, vUv).r;
    float indoorFactor = 1.0 - outdoorStrength;
    
    // 3. Apply Cloud Attenuation
    // Clouds kill the direct sunlight entering the window
    // Simple linear attenuation or thresholding
    float cloudFactor = 1.0 - (uCloudCover * 0.8); // Keep 20% ambient? Or kill completely?
    // User said: "Overcast... would kill all that light"
    // So maybe: float cloudFactor = smoothstep(0.8, 0.2, uCloudCover); 
    
    // 4. Calculate Diffuse Contribution
    vec3 diffuse = uLightColor * windowStrength * indoorFactor * cloudFactor * uIntensity;
    
    // 5. Calculate Specular Glint (Optional but requested)
    // "if the _Windows texture casts a light... give it a stronger specular highlight"
    float floorSpecular = texture2D(tSpecular, vUv).r;
    // Add a "Glossy" boost where window light hits floor
    vec3 specular = vec3(1.0) * floorSpecular * windowStrength * indoorFactor * cloudFactor * uIntensity;
    
    // Output Additive
    gl_FragColor = vec4(diffuse + specular, 1.0);
}
```

## Integration Steps

1.  **Update Loader**: Modify `scripts/assets/loader.js` `EFFECT_MASKS` definition.
2.  **Create Effect**: Implement `scripts/effects/WindowLightEffect.js`.
3.  **Register Effect**: Add to `scripts/foundry/canvas-replacement.js`.
4.  **Tweakpane**: Add controls for `intensity`, `lightColor`, and `specularBoost`.

## Future Considerations

### Godrays
-   Can be implemented as a separate volumetric pass or a screen-space radial blur originating from the "brightest" parts of the Window mask.
-   For now, strictly 2D surface lighting.

### Animation
-   User mentioned "subtle animation" when clouds pass.
-   Since `cloudCover` is global, this is a global dimming.
-   If we want drifting cloud shadows, we might need a `tCloudShadow` texture input later.

## Implementation Checklist

- [ ] Add `windows` and `structural` to `loader.js`.
- [ ] Create `WindowLightEffect.js` with `WindowLightShader`.
- [ ] Wire up `WeatherController` dependency for `cloudCover`.
- [ ] Implement "Indoor Only" logic using `_Outdoors` mask.
- [ ] Implement Specular boost using `_Specular` mask.
- [ ] Add UI controls to Tweakpane.
