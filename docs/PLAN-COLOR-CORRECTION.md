# Plan: Color Correction & Grading System

## 1. Overview
This document outlines the plan to implement a professional-grade Color Correction (CC) and Color Grading system for Map Shine Advanced. This system will operate as a post-processing effect, manipulating the final rendered image before it reaches the screen.

We will utilize **tweakpane-plugin-camerakit** to provide a visually rich and intuitive UI, moving beyond simple sliders to professional controls like color wheels and rings.

## 2. Architectural Changes

### 2.1. Render Pipeline Refactor
Currently, `EffectComposer` iterates through effects and lets them render directly to the screen (or whatever their target is). To support post-processing, we must capture the "Scene" (Base, Material, Surface, Particles, Environment) into an off-screen buffer.

**New Pipeline:**
1.  **Scene Pass**: Render all layers (0-400) into a `SceneRenderTarget` (Float/Half-Float type for HDR headroom if possible).
2.  **Post-Processing Pass**:
    *   Input: `SceneRenderTarget.texture`.
    *   Apply: Color Correction Shader.
    *   Output: Screen (or next PP effect).

**Action Items:**
*   Update `EffectComposer` to manage a `SceneRenderTarget`.
*   Modify `EffectComposer.render()` to bind this target before rendering layers < 500 (PostProcessing).
*   Ensure `ColorCorrectionEffect` reads from this target.

### 2.2. ColorCorrectionEffect
A new effect class `ColorCorrectionEffect` extending `EffectBase`.
*   **ID**: `colorCorrection`
*   **Layer**: `RenderLayers.POST_PROCESSING` (Order 500)
*   **Shader**: A single uber-shader to handle all CC operations in one pass for performance.

## 3. Feature Set (Shader Operations)
The shader will apply operations in a logical photographic order:

1.  **Input**: Linear RGB (from Scene Target).
2.  **White Balance**:
    *   *Temperature*: Adjust warm/cool (Blue <-> Orange).
    *   *Tint*: Adjust Green <-> Magenta.
3.  **Exposure**:
    *   Simple multiplier or EV adjustment.
4.  **Tone Mapping** (Critical for "Think Big"):
    *   *ACES Filmic*: Industry standard for cinematic look.
    *   *Reinhard*: Simple alternative.
    *   *None*: For debugging.
5.  **Color Grading (3-Way)**:
    *   *Lift*: Offset shadows (affects darks most).
    *   *Gamma*: Power function (affects midtones).
    *   *Gain*: Multiplier (affects highlights).
    *   *Note*: This requires determining luminance.
6.  **Basic Adjustments**:
    *   Brightness / Contrast.
    *   Saturation / Vibrance (Vibrance avoids clipping saturated colors).
    *   Hue Shift (Global).
7.  **Artistic Effects**:
    *   *Vignette*: Darken corners with softness control.
    *   *Film Grain*: Procedural noise.
8.  **Output**: Screen.

## 4. UI/UX Design (Camerakit)
We will integrate `tweakpane-plugin-camerakit` for intuitive controls.

### 4.1. Plugin Integration
*   **Source**: https://github.com/tweakpane/plugin-camerakit
*   **Loading**: We need to bundle this or load it dynamically in `TweakpaneManager`.
    *   *Strategy*: Add to `scripts/lib/`.
    *   *Fallback*: Standard sliders if plugin fails to load.

### 4.2. Control Mapping
*   **Exposure**: `Ring` controller (Rotation = value).
    *   *Visual*: Mimics a camera lens ring.
*   **White Balance**: `Wheel` controller (2D axis).
    *   *Axis X*: Temperature.
    *   *Axis Y*: Tint.
*   **Color Grading (Lift/Gamma/Gain)**: Three separate `Wheel` controllers.
    *   *Lift*: Shadow Color (RGB).
    *   *Gamma*: Midtone Color (RGB).
    *   *Gain*: Highlight Color (RGB).
*   **Look Library**: A dropdown of presets (LUT-style logic applied via parameters).
    *   *Examples*: "Cinematic Warm", "Horror Cold", "Noir B&W", "Cyberpunk Neon".

## 5. Implementation Plan

### Phase 1: Pipeline Plumbing
1.  Modify `EffectComposer` to support `SceneRenderTarget`.
2.  Implement basic "Pass-through" post-processing capability.

### Phase 2: The Uber-Shader
1.  Create `ColorCorrectionShader.js`.
2.  Implement algorithms for WB, ToneMapping, Grading.
3.  Create `ColorCorrectionEffect.js` boilerplate.

### Phase 3: UI Integration
1.  Acquire `tweakpane-plugin-camerakit.min.js`.
2.  Update `TweakpaneManager` to register the plugin.
3.  Build the `ColorCorrectionEffect` schema using custom view types.

### Phase 4: Preset System
1.  Define a library of good-looking defaults.
2.  Ensure saving/loading works with complex object parameters (Vectors for wheels).

## 6. Technical Considerations
*   **Performance**: Post-processing is a full-screen draw call. We must ensure the shader is optimized.
*   **Resolution**: The `SceneRenderTarget` must handle window resizing robustly.
*   **Color Space**: Ensure we are working in Linear space before Tone Mapping, and sRGB after (if outputting to screen).
