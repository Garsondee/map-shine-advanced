# Halftone (print)

**V2 class:** `HalftoneEffectV2` · **Source:** `legacy/compositor-v2/effects/HalftoneEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Screen-space halftone: the scene is broken into dots/lines with optional scatter, evoking offset print and comic shading.

Artistic only — no masks. Fullscreen post on the composited image.

Performance: one fullscreen pass; cost is usually low.

Persistence: settings save with the scene (not World Based).

## The knobs, in the author's words

- **Strength** — How strongly the halftone pattern replaces the original color.
- **Radius** — Screen-space size of halftone cells (larger = bigger dots).
- **Shape** — Dot, ellipse, line, or square halftone element.
- **Blend mode** — How the halftone layer combines with the underlying image.
- **Scatter** — Random jitter of the pattern for a rougher print look.
- **Greyscale** — Convert to luminance before halftoning for a monochrome print read.

## Authored presets

`Subtle` · `Comic` · `Print` · `Noir`

## Controls, grouped as the author grouped them

### Look

| Control  | id         | Type   | Range                         | Default | Notes                                                                               |
| -------- | ---------- | ------ | ----------------------------- | ------- | ----------------------------------------------------------------------------------- |
| Strength | `strength` | slider | 0 … 1                         | 0.47    |                                                                                     |
|          |            |        |                               |         | _Intensity of the halftone treatment (0 leaves the image unchanged in the shader)._ |
| Radius   | `radius`   | slider | 1 … 16                        | 6.3     |                                                                                     |
|          |            |        |                               |         | _Cell size in pixels (coarser halftone as this increases)._                         |
| Shape    | `shape`    | select | Dot / Ellipse / Line / Square | 1       |                                                                                     |
|          |            |        |                               |         | _Geometry of each halftone spot._                                                   |

### Mix _(advanced)_

| Control    | id             | Type   | Range                                      | Default | Notes                                                                   |
| ---------- | -------------- | ------ | ------------------------------------------ | ------- | ----------------------------------------------------------------------- |
| Blend mode | `blendingMode` | select | Linear / Multiply / Add / Lighter / Darker | 1       |                                                                         |
|            |                |        |                                            |         | _Compositing mode between source and halftone._                         |
| Scatter    | `scatter`      | slider | 0 … 2                                      | 0       |                                                                         |
|            |                |        |                                            |         | _Random displacement of the halftone grid for an imperfect print feel._ |

### Output _(advanced)_

| Control   | id          | Type    | Range | Default | Notes                                               |
| --------- | ----------- | ------- | ----- | ------- | --------------------------------------------------- |
| Greyscale | `greyscale` | boolean |       | false   |                                                     |
|           |             |         |       |         | _Halftone from luminance only (monochrome output)._ |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | false   | hidden |
