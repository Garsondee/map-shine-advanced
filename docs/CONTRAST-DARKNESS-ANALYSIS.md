# Contrast and Darkness Analysis Report

**Status: FIXES IMPLEMENTED** (see Implementation Status section below)

## Problem Statement
The Three.js render consistently appears **darker and higher contrast** than the original Foundry VTT PIXI-based rendering. Manual color correction adjustments are not effectively compensating for this difference.

---

## Root Cause Analysis

After analyzing the codebase, I have identified **5 primary causes** contributing to this issue:

### 1. Color Space Mismatch (CRITICAL)

**Location**: `scripts/scene/composer.js` (lines 184-191), `scripts/assets/loader.js` (lines 295-306)

**Issue**: The base texture is correctly tagged with `THREE.SRGBColorSpace` in `getFoundryBackgroundTexture()`, but mask textures loaded via `loadTextureAsync()` are **NOT** tagged with any color space.

```javascript
// composer.js - CORRECT
threeTexture.colorSpace = THREE.SRGBColorSpace;

// loader.js - MISSING color space assignment
const threeTexture = new THREE.Texture(resource.source);
threeTexture.needsUpdate = true;
// NO colorSpace assignment!
```

**Impact**: When Three.js performs lighting calculations, it may be treating sRGB textures as linear, causing:
- Darker midtones (gamma applied twice)
- Crushed shadows
- Blown highlights

**Foundry/PIXI Comparison**: PIXI.js operates entirely in sRGB space by default and does not perform gamma correction, so textures display "as authored."

---

### 2. Reinhard-Jodie Tone Mapping in Linear HDR Pipeline

**Location**: `scripts/effects/LightingEffect.js` (lines 204-314)

**Issue**: The composite shader applies Reinhard-Jodie tone mapping to compress HDR values:

```glsl
vec3 reinhardJodie(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 tc = c / (c + 1.0);
  return mix(c / (l + 1.0), tc, tc);
}
```

This tone mapper is designed for HDR content and **compresses all values toward 0.5**, which:
- Darkens bright areas
- Increases perceived contrast
- Reduces overall luminance

**Foundry/PIXI Comparison**: Foundry's PIXI renderer does NOT apply tone mapping. It is a simple multiply-blend of light textures onto the base, preserving the original brightness range.

---

### 3. Multiplicative Lighting Model with Reduced Master Intensity

**Location**: `scripts/effects/LightingEffect.js` (line 303)

```glsl
vec3 hdrColor = baseColor.rgb * totalIllumination;
```

**Issue**: The lighting is applied as a pure multiply operation. When `totalIllumination < 1.0` (which is common), the result is always darker than the input.

**Default Values Analysis**:
- `globalIllumination`: 1.4 (good)
- `lightIntensity`: 0.8 (reduces all light by 20%)
- `exposure`: 0.8 (further reduces by `pow(2, 0.8) = 1.74x` boost, but applied AFTER tone mapping)

The problem is that `lightIntensity = 0.8` is applied as a master multiplier to ambient light:
```glsl
float master = max(uLightIntensity, 0.0);
vec3 ambient = mix(uAmbientBrightest, uAmbientDarkness, uDarknessLevel) * max(uGlobalIllumination, 0.0) * master;
```

With `master = 0.8`, even full daylight scenes are reduced to 80% brightness before any other processing.

---

### 4. Contrast Applied After Tone Mapping

**Location**: `scripts/effects/LightingEffect.js` (line 317)

```glsl
vec3 finalRGB = (toneMappedColor - 0.5) * uContrast + 0.5;
```

**Issue**: Contrast is applied AFTER tone mapping, which means:
- The already-compressed range (0.0-1.0) is further manipulated
- Even `uContrast = 1.0` (neutral) does not cause issues, but the ORDER of operations matters
- Exposure is applied in HDR space, but contrast is in LDR space

**Better Approach**: Apply contrast in HDR space BEFORE tone mapping for more natural results.

---

### 5. Renderer Output Color Space Not Configured

**Location**: `scripts/core/renderer-strategy.js`

**Issue**: The WebGLRenderer is created without specifying `outputColorSpace`:

```javascript
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance'
});
// NO outputColorSpace or toneMapping configuration!
```

**Impact**: Three.js r152+ defaults to `THREE.SRGBColorSpace` for output, but since we are using custom shaders that output directly to `gl_FragColor`, the automatic sRGB conversion may not be applied consistently.

---

## Comparison: Foundry PIXI vs Map Shine Three.js

| Aspect | Foundry PIXI | Map Shine Three.js |
|--------|--------------|-------------------|
| Color Space | sRGB throughout | Mixed (sRGB textures, linear calculations) |
| Tone Mapping | None | Reinhard-Jodie |
| Lighting Model | Additive blend layers | Multiplicative HDR |
| Gamma Correction | None (browser handles) | Manual in shader |
| Default Brightness | 100% (no reduction) | 80% (lightIntensity default) |

---

## Recommended Solutions

### Solution 1: Quick Fix - Adjust Default Parameters (Immediate)

Change defaults in `LightingEffect.js`:

```javascript
this.params = {
  enabled: true,
  globalIllumination: 1.0,  // Was 1.4 - reduce to compensate
  lightIntensity: 1.0,      // Was 0.8 - restore full brightness
  darknessEffect: 0.5,
  exposure: 0.0,            // Was 0.8 - neutral exposure
  saturation: 1.0,
  contrast: 1.0,
  darknessLevel: 0.0,
};
```

**Pros**: Immediate improvement, no shader changes
**Cons**: Does not fix underlying color space issues

---

### Solution 2: Disable Tone Mapping for Daylight Scenes (Medium)

Add a toggle to bypass tone mapping when not needed:

```glsl
uniform float uUseToneMapping;

// In main():
vec3 finalColor;
if (uUseToneMapping > 0.5) {
  finalColor = reinhardJodie(hdrColor);
} else {
  finalColor = clamp(hdrColor, 0.0, 1.0);
}
```

**Pros**: Preserves original brightness for simple scenes
**Cons**: May cause clipping in scenes with bright lights

---

### Solution 3: Fix Color Space Pipeline (Recommended)

#### Step 3a: Tag all textures with correct color space

In `scripts/assets/loader.js`, add after line 296:

```javascript
// Determine color space based on mask type
// Data textures (normal, roughness) should be Linear
// Color textures (base, windows, fire) should be sRGB
const isDataTexture = ['normal', 'roughness'].includes(maskId);
if (THREE.SRGBColorSpace && !isDataTexture) {
  threeTexture.colorSpace = THREE.SRGBColorSpace;
}
```

#### Step 3b: Configure renderer output

In `scripts/core/renderer-strategy.js`, add after renderer creation:

```javascript
// Ensure correct output color space
if (THREE.SRGBColorSpace) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}
// Disable built-in tone mapping (we handle it in shaders)
renderer.toneMapping = THREE.NoToneMapping;
```

#### Step 3c: Linearize input in composite shader

```glsl
// Convert sRGB input to linear for calculations
vec3 linearBase = pow(baseColor.rgb, vec3(2.2));

// ... lighting calculations in linear space ...

// Convert back to sRGB for output
vec3 srgbOutput = pow(finalRGB, vec3(1.0/2.2));
gl_FragColor = vec4(srgbOutput, baseColor.a);
```

**Pros**: Physically correct pipeline, matches industry standards
**Cons**: Requires careful testing, may affect other effects

---

### Solution 4: Add "Match Foundry" Preset (User-Friendly)

Add a UI button that sets parameters to closely match Foundry's look:

```javascript
const foundryMatchPreset = {
  globalIllumination: 1.0,
  lightIntensity: 1.2,      // Slight boost to compensate for tone mapping
  darknessEffect: 0.3,      // Reduce darkness response
  exposure: 0.2,            // Slight exposure boost
  saturation: 1.0,
  contrast: 0.9,            // Slightly reduce contrast
};
```

---

### Solution 5: Hybrid Approach - Soft Tone Mapping (Best Balance)

Replace Reinhard-Jodie with a softer curve that preserves more of the original range:

```glsl
// Attempt to match PIXI's simpler blending
vec3 softToneMap(vec3 c) {
  // Only compress values above 1.0, leave 0-1 range mostly intact
  vec3 compressed = c / (c + 0.5);  // Softer curve
  return mix(c, compressed, step(1.0, max(c.r, max(c.g, c.b))));
}
```

Or use ACES Filmic which has a more natural shoulder:

```glsl
vec3 ACESFilm(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
```

---

## Implementation Priority

1. **Immediate**: Apply Solution 1 (adjust defaults) for quick relief
2. **Short-term**: Apply Solution 2 (tone mapping toggle) for user control
3. **Medium-term**: Apply Solution 3 (color space pipeline) for correctness
4. **Polish**: Apply Solution 4 (preset) for user convenience

---

## Testing Checklist

After implementing fixes:

- [ ] Compare side-by-side with Foundry PIXI on same scene
- [ ] Test with darkness level 0 (full daylight)
- [ ] Test with darkness level 0.5 (dusk)
- [ ] Test with darkness level 1.0 (night)
- [ ] Test with dynamic lights (torch, pulse animations)
- [ ] Test with overhead shadows enabled/disabled
- [ ] Verify no clipping in bright areas
- [ ] Verify shadow detail is preserved

---

## Files Modified

| File | Changes | Status |
|------|---------|--------|
| `scripts/effects/LightingEffect.js` | Adjust defaults, add tone mapping toggle, fix shader | ✅ Done |
| `scripts/assets/loader.js` | Add colorSpace to loaded textures | ✅ Done |
| `scripts/core/renderer-strategy.js` | Configure outputColorSpace and toneMapping | ✅ Done |
| `scripts/ui/tweakpane-manager.js` | Add "Match Foundry" preset button (optional) | ⏳ Future |

---

## Implementation Status

The following fixes have been applied:

### 1. LightingEffect.js
- **Removed all post-processing** from this effect (exposure, saturation, contrast, tone mapping)
- **Now only handles lighting math**: ambient light + dynamic lights + shadow compositing
- **Default parameters adjusted**:
  - `globalIllumination`: 1.4 → 1.0
  - `lightIntensity`: 0.8 → 1.0
- **Shader simplified** to output lit color directly without any color grading

### 2. loader.js
- **Color space assignment** added to mask texture loading
- Data textures (normal, roughness) remain Linear
- Color textures (windows, fire, outdoors, etc.) set to sRGB

### 3. renderer-strategy.js
- **`renderer.outputColorSpace`** set to `THREE.SRGBColorSpace`
- **`renderer.toneMapping`** set to `THREE.NoToneMapping` (we handle it in shaders)

### 4. ColorCorrectionEffect.js
- **Tone mapping** default changed from ACES (1) to None (0)
- **Brightness** default changed from 0.01 to 0.0
- **Contrast** default changed from 1.01 to 1.0
- **masterGamma** default changed from 1.15 to 1.0

### 5. SkyColorEffect.js
- **Intensity** default changed from 1.0 to 0.0 (opt-in atmospheric grading)
- This prevents double color correction stacking

### 6. Consolidated Post-Processing
- **LightingEffect** now ONLY handles lighting math (ambient + dynamic lights + shadows)
- **All color correction** (tone mapping, exposure, contrast, saturation) is now handled exclusively by **ColorCorrectionEffect**
- This eliminates the "triple processing" that was causing darkness and high contrast
