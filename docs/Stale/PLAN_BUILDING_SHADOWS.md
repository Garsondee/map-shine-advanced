# Plan: Building Shadows Effect

## Overview

We will implement a new **Building Shadows Effect** that generates dynamic, directional shadows from the map's `_Outdoors` mask. This effect simulates the shadows cast by walls and buildings onto the ground/outdoor areas.

Unlike overhead shadows (which use the overhead tiles), this effect uses the `_Outdoors` luminance mask (White = Outdoors, Black = Indoors/Obstacles) as the source of truth for height/occlusion.

## 1. Core Logic: The "Smear" Technique

Since the `_Outdoors` mask is a 2D top-down view where black pixels represent buildings, we can simulate a shadow cast by these buildings by "smearing" the black pixels along the direction of the shadow.

Technically, for every pixel on the screen (representing the ground), we look *towards* the light source. If we encounter a building (black pixel) within the shadow length, then the current pixel is in shadow.

**Shader Algorithm (Screen Space Raymarch):**

```glsl
// Start assuming fully lit (1.0)
float shadowFactor = 1.0;

// Raymarch towards the light (opposite to shadow direction)
for (int i = 0; i < uSamples; i++) {
    float t = float(i) / float(uSamples);
    
    // We look BACKWARDS along the shadow vector to see if something blocks the light
    vec2 sampleUv = vUv - (uSunDir * t * uLength);
    
    // Sample the outdoors mask
    // White (1.0) = Empty Space (Light passes)
    // Black (0.0) = Building (Light blocked)
    float occupancy = texture2D(tOutdoors, sampleUv).r;
    
    // If occupancy is 0.0 (Building), result becomes 0.0 (Shadow)
    // We use min() to accumulate shadows (if ANY sample hits a building, we are shadowed)
    shadowFactor = min(shadowFactor, occupancy);
}

// Output: 0.0 = Shadowed, 1.0 = Lit
```

## 2. Architecture: `BuildingShadowsEffect.js`

This class will mirror `OverheadShadowsEffect.js` but with a dedicated pass to render the `_Outdoors` mask into screen space first.

**Class Structure:**
*   **Extends:** `EffectBase`
*   **Layer:** `RenderLayers.ENVIRONMENTAL` (Runs before Lighting)
*   **Targets:**
    *   `outdoorsTarget`: Intermediate buffer. Holds the screen-space `_Outdoors` mask.
    *   `shadowTarget`: Final output buffer. Holds the generated shadow map.

**Render Pipeline:**
1.  **Outdoors Pass**: Render the `_Outdoors` texture (applied to a world-space mesh matching the map dimensions) into `outdoorsTarget`. This ensures the mask aligns perfectly with the map regardless of camera pan/zoom.
    *   *Note: We duplicate this logic from `LightingEffect` to keep the effect self-contained and ensure dependency order (Building Shadows must run BEFORE Lighting).*
2.  **Shadow Pass**: Render a full-screen quad using the "Smear" shader, reading from `outdoorsTarget` and writing to `shadowTarget`.

**Uniforms:**
*   `uSunDir` (vec2): Derived from `WeatherController.timeOfDay` (shared logic with Overhead Shadows).
*   `uLength` (float): Shadow length in UV space.
*   `uSamples` (int): Number of samples for the smear (defines quality/smoothness).
*   `uOpacity` (float): Shadow darkness.

## 3. Integration: `LightingEffect.js`

The `LightingEffect` is the consumer of all shadow maps. We will update the composite shader to include the building shadows.

**Changes:**
1.  **Uniforms**: Add `tBuildingShadow`, `uBuildingShadowOpacity`.
2.  **Binding**: In `render()`, detect `window.MapShine.buildingShadowsEffect` and bind its `shadowTarget`.
3.  **Fragment Shader**:
    ```glsl
    // Sample building shadow
    float buildingShadow = texture2D(tBuildingShadow, vUv).r;
    float buildingShadowFactor = mix(1.0, buildingShadow, uBuildingShadowOpacity);
    
    // Combine with existing shadows
    float combinedShadow = shadowFactor * buildingShadowFactor; // Multiply shadows
    ```

## 4. UI Strategy

We will move the "Building Shadows" settings to a new dedicated section.

*   **Category**: `Atmospheric and Environmental` (in `ui-manager.js` / `canvas-replacement.js`).
*   **Label**: "Building Shadows".
*   **Controls**:
    *   **Enabled**: Toggle.
    *   **Opacity**: Slider (0.0 - 1.0). Default 0.7.
    *   **Length**: Slider (0.0 - 0.2). Default 0.05.
    *   **Quality**: Slider (Samples) 10 - 50. Default 20.
    *   **Sun Latitude**: Slider (0.0 - 1.0). Shared concept with Overhead Shadows.

## 5. Cleanup

*   **Stub Removal**: Remove `BuildingShadowsEffect` from `scripts/effects/stubs/StubEffects.js`.
*   **Registry Update**: Remove the stub definition from `scripts/foundry/canvas-replacement.js` and register the real effect.

## Implementation Steps

1.  **Create `BuildingShadowsEffect.js`**: Implement the class with the rendering logic described above.
2.  **Update `LightingEffect.js`**: Add support for `tBuildingShadow` in the composite shader.
3.  **Update `canvas-replacement.js`**: Register the new effect and remove the stub.
4.  **Update UI**: Ensure the effect appears in the correct folder with the correct controls.
