# Plan: LUT Color Correction Suite

## 1. Goal / Scope
Add a LUT-based color grading suite to Map Shine Advanced as a **post-processing** stage within the existing Three.js pipeline.

This plan is specifically about **LUT workflows** (import, selection, blending, and application) and how they integrate with the existing `ColorCorrectionEffect` (sliders / WB / tone mapping).

### 1.1 What “LUT Suite” means for this module
- **1D LUT (optional)**: per-channel curves, usually used for filmic look tweaks.
- **3D LUT (primary)**: transforms RGB → RGB in a cube (common in grading pipelines).
- **Preset library**: a small built-in set of LUTs and/or param presets.
- **User import**: allow a GM/map-maker to import LUTs and apply them per-scene.
- **Blend**: intensity slider for LUT application.

### 1.2 Non-goals (initially)
- Full node-based grading (DaVinci Resolve style).
- Multi-LUT stacking with per-LUT masks.
- Per-token/per-tile LUTs.


## 2. Current Architecture Fit
### 2.1 Existing hooks we can build on
- `ColorCorrectionEffect` already exists as a **post-processing effect** (`RenderLayers.POST_PROCESSING`).
- `canvas-replacement.js` already wires the effect into the UI via `ColorCorrectionEffect.getControlSchema()`.
- The EffectComposer pipeline already has the concept of a **scene render target** and then PP (as described in `docs/PLAN-COLOR-CORRECTION.md`).

### 2.2 Recommended integration point
Implement LUT as **part of `ColorCorrectionEffect`** (single uber-shader) rather than a second pass:
- **Pros**:
  - One fullscreen draw instead of two.
  - Single place to manage color-space/tone mapping ordering.
  - Simplifies UI: “Color Correction” owns “LUT”.
- **Cons**:
  - Slightly more complex shader / parameter set.

If you later want stacked LUTs or selective LUTs, split into a dedicated `LUTEffect` pass.


## 3. LUT Technical Approach
### 3.1 Texture representation
Use a **3D LUT stored as a 2D texture** (standard approach for WebGL/WebGPU compatibility):
- LUT size `N` (common: 16, 32, 64)
- Represented as a 2D image of size:
  - `width = N * N`
  - `height = N`
- Layout: slices by blue channel, where each slice is an `N x N` tile for red/green.

This avoids needing `sampler3D` support and works on all relevant renderers.

### 3.2 Shader sampling
Given input `rgb` in [0..1], sample the LUT with trilinear filtering implemented manually:
- Compute blue slice index and blend between two slices.
- Within each slice, sample bilinear in the 2D tile.

This is the typical “2D LUT atlas” method.

### 3.3 Color space rules (critical)
LUTs must be applied in the correct color space or results will look wrong.

Recommended ordering (assuming scene render is linear):
1. Input scene color in **linear** (from your HDR/Float render target).
2. Apply exposure/WB/basic adjustments in linear.
3. Apply LUT in linear **if the LUT was authored for linear**.
4. Tone-map.
5. Convert to display space (sRGB).

But: most creative LUTs in the wild are authored assuming **display-referred / sRGB-like** input.

So the plan should support two LUT modes:
- **Mode A (Display LUT / sRGB LUT)**:
  - Convert `linear → sRGB` before LUT.
  - Apply LUT.
  - Convert `sRGB → linear` if you still need to do operations in linear (often you don’t).
  - Tone mapping should generally happen before this in a display-referred workflow; but in engine pipelines tone mapping often happens after HDR adjustments.
- **Mode B (Linear LUT)**:
  - Apply LUT directly in linear.

**Practical recommendation for v1**:
- Keep your existing “WB/Exposure/ToneMap/etc” order.
- Add LUT stage **after tone mapping** and treat it as a **display LUT** by default.
  - This aligns with common LUT usage and reduces user confusion.
  - It also avoids LUT sampling of HDR values > 1.0.

Add an advanced toggle: `lutColorSpace: 'display' | 'linear'`.

### 3.4 Precision requirements
- LUT should be loaded as **8-bit** RGBA is acceptable for most looks, but can band.
- If possible, prefer **16-bit** or float LUT textures, but browser/three constraints apply.

Given the module already moved to Float render targets (per earlier work), the weak link becomes the LUT texture. Start with 8-bit LUTs but include dithering (already done in Lighting, may want it here too).


## 4. Supported LUT Formats
### 4.1 Phase 1 (fastest)
- **2D LUT image** in `.png` / `.webp`
  - You define the required layout (N*N by N).
  - This is easiest to load with Three.js texture loader.

### 4.2 Phase 2 (more user-friendly)
- `.cube` (Iridas / Resolve)
  - Parse text, build a `DataTexture` LUT atlas.
  - This is the standard interchange format.

### 4.3 Optional
- `.3dl`, `.lut` variants (often messy; defer).


## 5. UI/UX Plan
### 5.1 Controls (Tweakpane)
Add a new group under `Color Grading & VFX`:
- `lutEnabled` (bool)
- `lutIntensity` (0..1 or 0..2)
- `lutName` / `lutSource` (read-only status)
- `lutColorSpace` (list: Display / Linear)
- `lutSize` (read-only, derived)
- `lutDebugBypass` (bool) (optional)

### 5.2 “Suite” UX options
Two viable UI approaches:

**Option A: Minimal (recommended first)**
- Dropdown of built-in LUT presets
- “Import LUT” button (opens FilePicker / loads from URL)

**Option B: Full Suite**
- LUT browser with thumbnails
- Categories (Cinematic, Horror, Warm, Noir)
- Compare toggle (A/B)

Start with Option A; Option B can come later.

### 5.3 Storage/persistence
Align with your 3-tier settings model:
- **Map Maker**: choose default LUT + params saved to scene flags
- **GM override**: can override LUT selection + intensity
- **Player override**: optional; probably disabled for LUT (to preserve map intent)

Store:
- LUT reference (builtin id or file path)
- LUT size (for validation)
- LUT intensity + mode


## 6. Loading & Asset Management
### 6.1 Built-in LUTs
Add a small `assets/luts/` folder (or similar), with 3-6 curated LUTs.
- Use `.png` atlas format initially.

### 6.2 User LUT import
Support at least one of:
- **Foundry file picker path** (`FilePicker.browse` / user selects file)
- **URL** to a LUT image

Then:
- Load via Three texture loader.
- Validate dimensions match an `N*N by N` layout.
- Cache textures (don’t reload on every toggle).


## 7. Implementation Plan (Phases)
### Phase 0: Decide ordering + scope (0.5–1 day)
- Confirm whether LUT is applied **after tone mapping** (recommended) or before.
- Confirm which actor types can change it (GM-only vs player).

### Phase 1: Shader & params (1–2 days)
- Add LUT uniforms to `ColorCorrectionEffect`:
  - `uLutMap` (sampler2D)
  - `uLutEnabled` (float)
  - `uLutIntensity` (float)
  - `uLutSize` (float)
  - `uLutColorSpaceMode` (int)
- Implement 2D LUT atlas sampling in fragment shader.
- Blend: `color = mix(color, lutColor, intensity)`.

### Phase 2: Loading built-in LUTs (0.5–1 day)
- Add a tiny LUT manager/helper (or keep it in effect for now) to:
  - Load builtin LUT textures.
  - Validate size.
  - Provide `setLutTexture(texture, size, name)`.

### Phase 3: UI wiring (0.5–1 day)
- Extend `ColorCorrectionEffect.getControlSchema()` with LUT controls.
- Update UI wiring in `canvas-replacement.js` so param updates propagate.

### Phase 4: Scene settings + persistence (1–2 days)
- Add schema entries to your settings system so LUT choice persists.
- Migrate defaults.

### Phase 5: `.cube` import (2–4 days)
- Implement `.cube` parser.
- Convert to LUT atlas `DataTexture`.
- Add a UI path to load `.cube`.


## 8. Testing / Validation
### 8.1 Visual correctness tests
- Neutral LUT (identity) should be visually identical (within epsilon).
- Verify no color shift when `lutIntensity=0`.
- Compare with known LUT outputs from reference images.

### 8.2 Performance tests
- One LUT sample costs multiple texture fetches (typically 2–4).
- Ensure it remains a single fullscreen pass.
- Check GPU tier fallback (WebGL1/2) still works.

### 8.3 Resize / DPR
- Ensure LUT sampling is resolution independent.
- Ensure render target resizing doesn’t invalidate texture references.


## 9. Risks / Gotchas
- **Color space mismatch** is the #1 source of “LUT looks wrong”. Provide a clear mode toggle.
- **Banding** can show up with strong LUTs + 8-bit LUT textures; consider dithering.
- **User LUT layouts** vary; constrain and validate early.
- **Post chain integrity**: effects must still “pass through” even if LUT disabled.


## 10. Effort Estimate (Difficulty)
### Minimal viable LUT (builtin LUTs + intensity)
- **Difficulty**: Low–Medium
- **Time**: ~2–4 days

### “Suite” (import + preset library + cube parsing)
- **Difficulty**: Medium
- **Time**: ~1–2 weeks

### Full professional UX (browser, thumbnails, A/B compare)
- **Difficulty**: Medium–High
- **Time**: ~2–4 weeks


## 11. Proposed File Touch List
- `scripts/effects/ColorCorrectionEffect.js`
  - Add LUT params, uniforms, shader sampling.
- `scripts/foundry/canvas-replacement.js`
  - Wire new LUT UI params.
- (Optional) `scripts/color/LUTLoader.js` (new)
  - LUT validation, `.cube` parsing, atlas generation.
- `assets/luts/*` (new)
  - Built-in LUT atlas images.
- `docs/PLAN-LUT-COLOR-CORRECTION.md` (this file)

