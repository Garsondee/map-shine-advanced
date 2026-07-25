# Sharpen (unsharp mask)

**V2 class:** `SharpenEffectV2` · **Source:** `legacy/compositor-v2/effects/SharpenEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Adds local contrast on edges by blending a high-pass (detail) signal back into the image. Useful for soft maps or slight post-scale blur.

No masks or tile data required — full-screen post-processing on the composited frame.

Performance: one extra fullscreen pass with a few taps; cost is modest. Very high radius samples a wider neighborhood (still cheap vs bloom).

Persistence: settings save with the scene (not World Based).

## The knobs, in the author's words

- **Amount** — How strongly detail is boosted. 0 disables the filter in the shader.
- **Radius (px)** — Edge detection neighborhood in screen pixels (larger = coarser detail).
- **Threshold** — Minimum edge strength before sharpening applies; reduces grain and noise halos.

## Authored presets

`Subtle` · `Crisp` · `Strong`

## Controls, grouped as the author grouped them

### Look

| Control     | id          | Type   | Range    | Default | Notes                                                                |
| ----------- | ----------- | ------ | -------- | ------- | -------------------------------------------------------------------- |
| Amount      | `amount`    | slider | 0 … 2    | 0.5     |                                                                      |
|             |             |        |          |         | _Strength of the sharpen blend (0 = no effect)._                     |
| Radius (px) | `radiusPx`  | slider | 0 … 6    | 2       |                                                                      |
|             |             |        |          |         | _Blur radius in pixels used for the unsharp mask._                   |
| Threshold   | `threshold` | slider | 0 … 0.25 | 0       |                                                                      |
|             |             |        |          |         | _Ignore weak edges below this luma delta to limit noise sharpening._ |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | false   | hidden |
