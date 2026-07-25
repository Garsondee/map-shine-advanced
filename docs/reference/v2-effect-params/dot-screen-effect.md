# Dot screen (halftone)

**V2 class:** `DotScreenEffectV2` · **Source:** `legacy/compositor-v2/effects/DotScreenEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Stylized halftone: the image is mixed with a rotated sine grid so bright areas read as a dot pattern (print / comic look).

Purely artistic — no masks. Runs as fullscreen post-processing on the composited frame.

Performance: single fullscreen pass; typically inexpensive.

Persistence: settings save with the scene (not World Based).

## The knobs, in the author's words

- **Strength** — Blend between the original image and the dot pattern (0 = original only).
- **Scale** — Dot density / fineness; higher values pack more pattern into the frame.
- **Angle** — Grid rotation in radians (0 to ~2π).
- **Center X / Y** — Pattern origin in normalized UV (0–1), relative to the render.

## Authored presets

`Subtle` · `Classic` · `Diagonal`

## Controls, grouped as the author grouped them

### Look

| Control     | id         | Type   | Range                 | Default | Notes                                                        |
| ----------- | ---------- | ------ | --------------------- | ------- | ------------------------------------------------------------ |
| Strength    | `strength` | slider | 0 … 1                 | 1       |                                                              |
|             |            |        |                       |         | _How much of the dot pattern is mixed in (0 = bypass)._      |
| Scale       | `scale`    | slider | 0.1 … 10              | 10      |                                                              |
|             |            |        |                       |         | _Fineness of the dot grid (higher = smaller / denser dots)._ |
| Angle (rad) | `angle`    | slider | 0 … 6.283185307179586 | 1.57    |                                                              |
|             |            |        |                       |         | _Rotation of the halftone grid in radians._                  |

### Center _(advanced)_

| Control  | id        | Type   | Range | Default | Notes                                                          |
| -------- | --------- | ------ | ----- | ------- | -------------------------------------------------------------- |
| Center X | `centerX` | slider | 0 … 1 | 0.56    |                                                                |
|          |           |        |       |         | _Horizontal pattern origin in UV space (0 = left, 1 = right)._ |
| Center Y | `centerY` | slider | 0 … 1 | 0.5     |                                                                |
|          |           |        |       |         | _Vertical pattern origin in UV space (0 = bottom, 1 = top)._   |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | false   | hidden |
