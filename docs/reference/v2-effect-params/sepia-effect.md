# Sepia tone

**V2 class:** `SepiaEffectV2` · **Source:** `legacy/compositor-v2/effects/SepiaEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Warm brown photo grade by mixing the scene toward a classic sepia transform (photographic-style matrix).

Stylistic only — no masks. One fullscreen post pass on the merged composite (after bush/tree overlays and color correction). Does not change lighting in the 3D pass; when CC tone mapping is off, a smooth HDR shoulder is applied here so bright blooms grade cleanly (no hard knee).

Performance: very cheap (single pass, simple shader).

Persistence: settings save with the scene (not World Based).

## The knobs, in the author's words

- **Strength** — Blend between the original image and full sepia (0 = original, 1 = full sepia).

## Authored presets

`Soft` · `Balanced` · `Full`

## Controls, grouped as the author grouped them

### Look

| Control  | id         | Type   | Range | Default | Notes                                                        |
| -------- | ---------- | ------ | ----- | ------- | ------------------------------------------------------------ |
| Strength | `strength` | slider | 0 … 1 | 0.6     |                                                              |
|          |            |        |       |         | _How much sepia is mixed in (0 leaves the image unchanged)._ |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes  |
| ------- | --------- | ------- | ----- | ------- | ------ |
| enabled | `enabled` | boolean |       | true    | hidden |
