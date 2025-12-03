# Feature Plan: Sky Color Effect

## 1. Overview
The **Sky Color Effect** is a centralized screen-space color correction system designed to simulate environmental lighting conditions based on **Time of Day**, **Weather** (Precipitation/Clouds), and **Location** (Indoor vs Outdoor).

It aims to replace static lighting with a dynamic, "cinematic" atmosphere that reacts to the game state.

### Goals
- **Dynamic Time of Day**: Golden hour, Blue hour, Deep Night.
- **Weather Response**:
  - **Clear Day**: Bright, vibrant, high contrast.
  - **Overcast/Rain**: Desaturated, lower contrast, diffuse lighting.
  - **Storm (High Precip)**: Dark, oppressive, heavily blue-shifted.
  - **Night + Storm**: Pitch black (moonlight blocked).
- **Masking**: Applied ONLY to "Outdoor" areas (masked by `_Outdoors` texture). Indoor areas retain their local lighting (or separate indoor grading).
- **Specular Integration**: Dampen surface reflectivity (specular/iridescence) during overcast weather.

---

## 2. Architecture

### 2.1 Class Structure
*   **Class**: `SkyColorEffect` extends `EffectBase`
*   **Location**: `scripts/effects/SkyColorEffect.js`
*   **Layer**: `RenderLayers.POST_PROCESSING` (Order: 505)
    *   *Rationale*: Must run **AFTER** `LightingEffect` (Order 500) to grade the lit scene, but **BEFORE** `FogEffect` (Order 510 - TBD) and `Bloom`.

### 2.2 Inputs & Dependencies
1.  **WeatherController**: Source of truth for:
    *   `timeOfDay` (0.0 - 24.0)
    *   `precipitation` (0.0 - 1.0)
    *   `cloudCover` (0.0 - 1.0)
2.  **_Outdoors Mask**:
    *   A texture defining which pixels are "Outdoors" and subject to sky lighting.
    *   Must be sampled in screen space (coordinate reconstruction required).
3.  **Scene Color (`tDiffuse`)**: The rendered scene from `LightingEffect`.

---

## 3. Implementation Details

### 3.1 Shader Logic (`SkyColorEffect.js`)
The effect will be a full-screen quad pass.

**Uniforms:**
*   `tDiffuse`: Scene color.
*   `tOutdoors`: Outdoor mask texture.
*   `uWorldToMaskParams`: Vector for mapping Screen UV -> World UV (offset/scale).
*   `uTimeOfDay`: 0-24.
*   `uPrecipitation`: 0-1.
*   `uCloudCover`: 0-1.
*   `uTint`: Calculated Sky Color (RGB).
*   `uSaturation`: Saturation multiplier.
*   `uContrast`: Contrast multiplier.
*   `uExposure`: Exposure multiplier.
*   `uEffectIntensity`: Master fader.

**Algorithm:**
1.  **Sample Mask**: Calculate World UV from Screen UV. Sample `tOutdoors`. If `mask == 0`, return original color (Indoor).
2.  **Color Grading**:
    *   Convert `tDiffuse` RGB to HSV/HSL or apply matrix ops.
    *   **Exposure**: `color *= uExposure`
    *   **Contrast**: `color = (color - 0.5) * uContrast + 0.5`
    *   **Saturation**: `color = mix(grayscale(color), color, uSaturation)`
    *   **Tint**: `color *= uTint` (Multiply blend) or Soft Light blend.
3.  **Mix**: `FinalColor = mix(Original, Graded, MaskValue * uEffectIntensity)`.

### 3.2 CPU-Side Color State (The "Director")
Instead of calculating complex sun curves in GLSL, `SkyColorEffect.update()` will calculate the target lighting parameters on the CPU using `WeatherController` state and pass them as simple uniforms.

**Logic Table (Draft):**
| Condition | Time | Precip | Effect |
| :--- | :--- | :--- | :--- |
| **Clear Day** | 12:00 | 0.0 | Tint: White, Sat: 1.1, Exp: 1.0, Con: 1.1 |
| **Golden Hour** | 06:00 / 18:00 | 0.0 | Tint: Warm Orange, Sat: 1.2, Exp: 1.0, Con: 1.2 |
| **Night** | 24:00 | 0.0 | Tint: Cool Blue, Sat: 0.6, Exp: 0.4, Con: 1.3 |
| **Overcast** | 12:00 | 0.4 | Tint: Gray-Blue, Sat: 0.8, Exp: 0.9, Con: 0.8 |
| **Storm** | 12:00 | 0.9 | Tint: Dark Teal, Sat: 0.6, Exp: 0.6, Con: 0.7 |
| **Storm Night** | 24:00 | 0.9 | Tint: Near Black, Sat: 0.0, Exp: 0.1, Con: 0.5 |

*Formula*:
`TargetParam = Lerp(DayParam, NightParam, TimeFactor)`
`FinalParam = Lerp(TargetParam, StormParam, PrecipFactor * CloudFactor)`

### 3.3 Specular Integration
We must modify `SpecularEffect.js` to accept weather influence.
*   **New Uniform**: `uEnvironmentDimming` (0.0 - 1.0).
*   **Logic**: `SpecularStrength *= (1.0 - uEnvironmentDimming)`.
*   **Update**: In `SpecularEffect.update()`, read `WeatherController.cloudCover`.
    *   High Cloud Cover = High Dimming (Matte appearance).
    *   Clear Sky = Low Dimming (Sharp reflections).

---

## 4. Integration Steps

1.  **Create `SkyColorEffect.js`**: Implement the shader and CPU "Director" logic.
2.  **Register in `canvas-replacement.js`**: Add to `stubEffects` (initially) or directly to `EffectComposer`.
3.  **Wire up `WeatherController`**: Ensure `WeatherController` is initialized and exposing `timeOfDay`.
4.  **Update `SpecularEffect.js`**: Add cloud cover dampening.
5.  **UI**: Add `Sky Color` debug folder to Tweakpane (or integrate into Weather tab).

## 5. Future Considerations
*   **Indoor Grading**: A separate "Indoor Color" effect?
*   **Light Source Tinting**: Should `SkyColor` also tint the color of dynamic point lights? (Probably not, magic fire is magic fire).
*   **God Rays**: Volumetric light shafts driven by the same logic.
