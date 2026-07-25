# Filter (multiply / ink AO)

**V2 class:** `FilterEffectV2` · **Source:** `legacy/compositor-v2/effects/FilterEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Material-look filter for tint and ink-line “ambient occlusion” style darkening driven from the scene image.

Best on high-contrast linework maps; ink AO reads dark regions and edges from the current render. Optional **Only \_Outdoors Dark Regions** uses the outdoors mask when available.

Runs in the per-level material chain before the final Camera Grade. Use Color Correction for final-frame exposure, tone mapping, and vignette.

Performance: usually modest; higher spread/blur adds work. Lower intensity or disable sub-features if a map is heavy.

Persistence: scene-based (not World Based).

## The knobs, in the author's words

- **Intensity** — Master strength of the multiply filter (0 = no multiply contribution).
- **Tint (Multiply)** — Per-channel multiplier on the image (white = no change).
- **Ink AO** — Darkens ink-like regions using thresholds and edge detection on the scene texture.
- **Spread (px)** — Screen-space reach of the ink shading.
- **Spread Blur (px)** — Softens the spread sample for smoother shading.
- **Only \_Outdoors Dark Regions** — When an outdoors mask is present, limit ink AO to dark areas outside.
- **Vignette** — Legacy per-level edge darkening. Prefer Camera Grade vignette for multi-floor scenes.

## Authored presets

`Ink AO — Subtle` · `Ink AO — Bold`

## Controls, grouped as the author grouped them

### Look

| Control         | id          | Type   | Range | Default             | Notes                                                                       |
| --------------- | ----------- | ------ | ----- | ------------------- | --------------------------------------------------------------------------- |
| Intensity       | `intensity` | slider | 0 … 1 | 1                   |                                                                             |
|                 |             |        |       |                     | _How strongly the multiply filter is applied (0 disables the pass output)._ |
| Tint (Multiply) | `tintColor` | color  |       | {"r":1,"g":1,"b":1} |                                                                             |
|                 |             |        |       |                     | _Multiplies the scene color per channel; white keeps the map neutral._      |

### Ink AO (from scene) _(advanced)_

| Control                      | id                    | Type    | Range       | Default             | Notes                                                                                                      |
| ---------------------------- | --------------------- | ------- | ----------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Enabled                      | `inkAoEnabled`        | boolean |             | true                |                                                                                                            |
|                              |                       |         |             |                     | _Turn ink-line AO darkening on or off (independent of the effect Enabled toggle)._                         |
| Strength                     | `inkAoStrength`       | slider  | 0 … 2       | 0.65                |                                                                                                            |
|                              |                       |         |             |                     | _Overall strength of ink AO darkening._                                                                    |
| Dark Threshold               | `inkDarkThreshold`    | slider  | 0 … 1       | 0.72                |                                                                                                            |
|                              |                       |         |             |                     | _How dark a pixel must be to count as “ink” for the AO response._                                          |
| Dark Softness                | `inkDarkSoftness`     | slider  | 0.001 … 0.5 | 0.08                |                                                                                                            |
|                              |                       |         |             |                     | _Softens the transition at the dark threshold._                                                            |
| Edge Strength                | `inkEdgeStrength`     | slider  | 0 … 4       | 1                   |                                                                                                            |
|                              |                       |         |             |                     | _How much detected edges boost the ink shading._                                                           |
| Edge Power                   | `inkEdgePower`        | slider  | 0.25 … 4    | 1.25                |                                                                                                            |
|                              |                       |         |             |                     | _Exponent on edge response (higher = sharper, more contrasty edges)._                                      |
| Spread (px)                  | `inkSpreadPx`         | slider  | 0 … 96      | 12                  |                                                                                                            |
|                              |                       |         |             |                     | _Neighborhood size in pixels for ink darkening spread._                                                    |
| Spread Blur (px)             | `inkBlurPx`           | slider  | 0 … 24      | 2                   |                                                                                                            |
|                              |                       |         |             |                     | _Blur radius applied when sampling the spread (smoother contact shadows)._                                 |
| Only \_Outdoors Dark Regions | `inkOutdoorsDarkOnly` | boolean |             | false               |                                                                                                            |
|                              |                       |         |             |                     | _If an outdoors mask is available, apply ink AO only where the mask marks outdoors and the image is dark._ |
| AO Tint                      | `inkTintColor`        | color   |             | {"r":0,"g":0,"b":0} |                                                                                                            |
|                              |                       |         |             |                     | _Color mixed into shaded ink regions (black is typical)._                                                  |

### Advanced: legacy multiply vignette _(advanced)_

| Control          | id                  | Type    | Range      | Default             | Notes                                                                                                             |
| ---------------- | ------------------- | ------- | ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Enabled (legacy) | `vignetteEnabled`   | boolean |            | false               |                                                                                                                   |
|                  |                     |         |            |                     | _Legacy per-level multiply vignette. Prefer Camera Grade vignette so multi-floor composites darken consistently._ |
| Strength         | `vignetteStrength`  | slider  | 0 … 2      | 0.35                |                                                                                                                   |
|                  |                     |         |            |                     | _How strong the vignette multiply is._                                                                            |
| Inner            | `vignetteInner`     | slider  | 0 … 2      | 0.55                |                                                                                                                   |
|                  |                     |         |            |                     | _Radius where vignette falloff begins (normalized radial space)._                                                 |
| Outer            | `vignetteOuter`     | slider  | 0.01 … 2.5 | 1.15                |                                                                                                                   |
|                  |                     |         |            |                     | _Radius where vignette reaches full strength._                                                                    |
| Tint             | `vignetteTintColor` | color   |            | {"r":0,"g":0,"b":0} |                                                                                                                   |
|                  |                     |         |            |                     | _Color bias for vignette darkening (black = neutral darken)._                                                     |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | false   | hidden |
