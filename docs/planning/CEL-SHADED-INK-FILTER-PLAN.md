# Cel-Shaded Ink Filter Plan (Water-First, Scene-Capable)

## 1) Visual read of the reference artwork

The reference style reads as a hybrid of:

1. **Ink-first linework** - dark hand-inked outlines around hard forms (pipes, planks, rocks).
2. **Limited tonal bands** - color and lighting are compressed into fewer steps (especially in water and shadows).
3. **Painterly texture** - subtle grit/wash overlays prevent gradients from feeling sterile.
4. **Low-chroma atmosphere** - restrained saturation with selective highlights.

To mimic this in Map Shine, we should combine:

- **Posterization/banding** (water first, optional full scene)
- **Screen-space ink outlines**
- **Optional paper/grain modulation**

---

## 2) Design goals

### Primary goals

- Add a stylization pass that makes water read as hand-painted/cel shaded.
- Support dark ink outlines that emphasize silhouettes and hard contrast transitions.
- Keep the effect stable across zoom/resolution.
- Integrate into existing Three.js post pipeline (no PIXI filter dependency).

### Secondary goals

- Offer presets ("Subtle Ink", "Comic Heavy", "Painterly Water").
- Allow water-only stylization first, then optional scene-wide expansion.

### Non-goals (v1)

- Physically accurate NPR rendering.
- Per-object material authoring pipelines.
- Replacing all existing post effects.

---

## 3) Architectural fit in current pipeline

Current post ordering already supports this cleanly:

- Lighting: priority `1`
- Water: priority `80`
- Distortion: priority `85`
- Vision mode: priority `95`
- Color correction: priority `100`

Relevant integration points:

- Post-process orchestration and ping-pong buffers: `scripts/effects/EffectComposer.js`
- Existing water post pass and final color write: `scripts/effects/WaterEffectV2.js`
- Existing late grading pass for look-dev controls: `scripts/effects/ColorCorrectionEffect.js`
- Effect registration and UI wiring tables: `scripts/foundry/effect-wiring.js`

### Recommended render order for new style pass

Introduce a new pass `CelInkEffect` in `POST_PROCESSING` with priority **90-94**.

Why:

- After Water (80) and Distortion (85), so it stylizes final water appearance.
- Before VisionMode/ColorCorrection if we want those to remain final creative controls.

---

## 4) Proposed technical approach

## 4.1 Pass A: Water posterization (fastest win)

Implement directly in `WaterEffectV2` first (single-file increment).

After water shading is assembled (`col` before final output), apply controlled quantization:

```glsl
vec3 posterizeRgb(vec3 c, float bands) {
  float b = max(2.0, bands);
  return floor(c * b) / b;
}
```

Better (less hue shift) option:

- Convert to luminance/chroma space
- Quantize luminance only
- Recompose color

```glsl
float y = dot(col, vec3(0.299, 0.587, 0.114));
float yq = floor(y * bands) / bands;
col = col * (yq / max(y, 1e-4));
```

### Water controls (new params)

- `waterCelEnabled` (bool)
- `waterCelBands` (2..12)
- `waterCelContrast` (0..2)
- `waterCelDitherStrength` (0..1)
- `waterCelPreserveSpecular` (0..1)

Notes:

- Dither should be subtle blue-noise/value-noise to reduce ugly hard contour crawl.
- Keep offsets/resolution logic pixel-based and scaled by texel size where needed.

## 4.2 Pass B: Screen-space ink outlines

Create a dedicated post effect (`CelInkEffect`) using `tDiffuse` + optional depth.

Edge sources:

1. **Luma edge** (Sobel/Scharr on scene color)
2. **Depth edge** (from depth pass for silhouette/object separation)
3. **Optional mask weighting** (stronger in water areas)

Edge metric (conceptual):

```glsl
edge = max(lumaEdge * uLumaWeight, depthEdge * uDepthWeight);
ink = smoothstep(uEdgeLow, uEdgeHigh, edge);
final = mix(color, uInkColor, ink * uInkOpacity);
```

### Outline controls

- `inkEnabled` (bool)
- `inkColor` (default near-black)
- `inkOpacity` (0..1)
- `inkWidthPx` (0.5..4)
- `inkLumaWeight` / `inkDepthWeight`
- `inkThresholdLow` / `inkThresholdHigh`
- `inkWaterBoost` (extra outline strength on water)

## 4.3 Pass C: Optional style texture (paper/grit)

If needed after A/B:

- Add light multiplicative wash/noise overlay.
- Keep very low amplitude to avoid muddying the map.

This can often be deferred because FilmGrain already exists and may be reused with tuned defaults.

---

## 5) Coordinate, mask, and stability rules

Implementation should follow existing project conventions:

- Keep all post-pass offsets in pixel units then multiply by texel size.
- Use existing scene-space vs screen-space conventions correctly.
- For zoom behavior, rely on `sceneComposer.currentZoom` patterns where relevant.
- Keep this entirely in Three.js pipeline (no PIXI filter path).

---

## 6) Implementation work packages

## WP-1: Water-only cel shading (low risk, immediate value)

Files:

- `scripts/effects/WaterEffectV2.js`

Tasks:

- Add water cel params/defaults/schema.
- Add posterization function in water fragment shader.
- Apply quantization to water output only.
- Add optional light dither.
- Add 3 presets in Water controls.

Success criteria:

- Water visibly bands into stylized tones.
- No major flicker under camera pan/zoom.
- <= ~0.3 ms average extra GPU cost at 1080p on mid-tier GPU.

## WP-2: Dedicated ink outline post effect

Files:

- `scripts/effects/CelInkEffect.js` (new)
- `scripts/foundry/effect-wiring.js`
- `scripts/effects/EffectComposer.js` (only if utility hooks are needed)

Tasks:

- Implement fullscreen pass with luma/depth edge detection.
- Register in effect wiring and graphics capabilities.
- Expose controls + presets.
- Set priority around 90-94.

Success criteria:

- Black outline appears on strong boundaries without heavy noise.
- Outline width remains stable across resolution changes.
- Effect composes correctly with Water/Distortion/ColorCorrection.

## WP-3: Unified style presets + tuning pass

Files:

- `scripts/effects/CelInkEffect.js`
- `scripts/effects/WaterEffectV2.js`
- Optional docs update in planning/status docs

Tasks:

- Create style presets blending water bands + ink edges.
- Tune defaults against day/night and indoor/outdoor scenes.
- Add conservative quality fallback toggles.

Success criteria:

- Presets look intentional out of the box.
- No readability regressions for tokens/UI-critical cues.

---

## 7) Performance and risk assessment

## Main risks

1. **Outline shimmer/noise** on high-frequency textures.
2. **Over-darkening readability** in already dark scenes.
3. **Extra pass cost** if depth+luma edge kernels are too wide.

## Mitigations

- Start with 3x3 edge kernel and clamp strength.
- Use threshold hysteresis (`low/high`) rather than a single hard cutoff.
- Default to subtle settings, not comic-max.
- Gate depth sampling behind toggle when unavailable.
- Add quality tier switches:
  - Low: luma edge only
  - Medium: luma + depth
  - High: luma + depth + water boost refinements

---

## 8) QA matrix

Scene coverage:

- Bright daylight water map
- Dark/night water map
- Indoor map with minimal water
- Dense overhead/roof map

Validation checklist:

- [ ] Water bands are visible but not posterized into mush.
- [ ] Ink outlines look hand-drawn, not noisy halos.
- [ ] Tokens remain readable and gameplay-critical visibility is preserved.
- [ ] No UV flip artifacts on masks.
- [ ] No major frame-time spikes during camera motion.

---

## 9) Rollout strategy

1. Ship **WP-1** first behind `waterCelEnabled` toggle (default off).
2. Gather visual/perf feedback.
3. Ship **WP-2** as separate `inkEnabled` toggle (default off).
4. Add presets once both are validated.

This staged rollout gives immediate artistic gains on water while isolating risk before adding global outlines.

---

## 10) Recommended initial defaults

Water cel:

- `waterCelEnabled = true` (in preset only, not global default)
- `waterCelBands = 5`
- `waterCelContrast = 1.15`
- `waterCelDitherStrength = 0.12`

Ink outline:

- `inkEnabled = true` (in preset only)
- `inkColor = #101010`
- `inkOpacity = 0.55`
- `inkWidthPx = 1.25`
- `inkLumaWeight = 1.0`
- `inkDepthWeight = 0.65`
- `inkThresholdLow = 0.08`
- `inkThresholdHigh = 0.22`

These values should approximate the attached style without crushing readability.
