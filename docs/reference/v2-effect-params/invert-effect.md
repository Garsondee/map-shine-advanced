# Color invert

**V2 class:** `InvertEffectV2` · **Source:** `legacy/compositor-v2/effects/InvertEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Blends each pixel toward its photographic inverse (1 − RGB) for negative / sci-fi / puzzle-map looks.

Stylistic only — no masks. One fullscreen post pass on the composited image.

Performance: very cheap (single pass, simple shader).

Persistence: settings save with the scene (not World Based).

## The knobs, in the author's words

- **Strength** — Blend between the original image and full inversion (0 = original, 1 = full invert).

## Authored presets

`Partial` · `Half` · `Full`

## Controls, grouped as the author grouped them

### Look

| Control  | id         | Type   | Range | Default | Notes                                                            |
| -------- | ---------- | ------ | ----- | ------- | ---------------------------------------------------------------- |
| Strength | `strength` | slider | 0 … 1 | 1       |                                                                  |
|          |            |        |       |         | _How much inversion is mixed in (0 leaves the image unchanged)._ |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | false   | hidden |
