# DazzleOverlayEffectV2

**V2 class:** `DazzleOverlayEffectV2` · **Source:** `legacy/compositor-v2/effects/DazzleOverlayEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Look

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Intensity | `intensity` | slider | 0 … 2 | 2 |  |
| Exposure Lift | `exposureLift` | slider | 0 … 3 | 0.9 |  |
| White Add | `whiteAdd` | slider | 0 … 2 | 0.65 |  |
| Desaturate | `desaturate` | slider | 0 … 1 | 0.35 |  |
| Glare Strength | `glareStrength` | slider | 0 … 2 | 0.55 |  |
| Glare Power | `glarePower` | slider | 0.1 … 8 | 2 |  |
| RGB Shift (px) | `rgbShiftPx` | slider | 0 … 8 | 1.35 |  |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| enabled | `enabled` | boolean |  | false | hidden |
