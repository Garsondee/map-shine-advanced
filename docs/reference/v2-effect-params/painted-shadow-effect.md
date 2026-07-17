# Painted Shadows

**V2 class:** `PaintedShadowEffectV2` · **Source:** `legacy/compositor-v2/effects/PaintedShadowEffectV2.js`

**Rebuilt in V3 as:** `light.visibility`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Projects hand-painted _Shadow masks along the sun direction into a scene-space lit-factor texture.

Outdoor pixels only — gated by the same _Outdoors mask Building Shadows uses.

Multi-floor maps stack per-floor _Shadow slots; bundle fallback loads per-level art when compositor slots are empty.

## Controls, grouped as the author grouped them

### Painted Shadows

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Opacity | `opacity` | slider | 0 … 1 | 0.5 |  |
| Strength boost | `shadowStrengthBoost` | slider | 1 … 10 | 1 |  |
| | | | | | _Extra darkening beyond opacity (×1 matches older behavior; use up to ×10 when shadows look too faint)._ |
| Length | `length` | slider | 0 … 0.6 | 0.075 |  |
| Blur | `blurRadius` | slider | 0 … 4 | 4 |  |
| Contact preserve | `contactShadowPreserve` | slider | 0 … 1 | 1 |  |
| | | | | | _Blurs outward without eating the caster edge: merges pre-blur strength where shadow is darkest, full blur where it fades._ |
| Contact blend (low) | `contactSharpBlendLow` | slider | 0 … 0.35 | 0.04 |  |
| | | | | | _Lower bound for where pre-blur strength starts to dominate. Raise slightly if fringe looks too crunchy._ |
| Contact blend (high) | `contactSharpBlendHigh` | slider | 0.2 … 0.98 | 0.78 |  |
| | | | | | _Upper bound toward full contact sharpness inside the silhouette. Lower to pull softness closer to walls._ |
| Edge inflate (px) | `shadowEdgeInflatePx` | slider | 0 … 8 | 1.25 |  |
| | | | | | _Expands painted shadow slightly in this pass’s pixel grid (often lower-res than canvas) so it tucks under assets and hides bright rim cracks. 0 = off._ |
| Resolution | `resolutionScale` | slider | 0.75 … 2 | 2 |  |
