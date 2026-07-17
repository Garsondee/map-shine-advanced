# Building Shadows

**V2 class:** `BuildingShadowsEffectV2` · **Source:** `legacy/compositor-v2/effects/BuildingShadowsEffectV2.js`

**Rebuilt in V3 as:** `light.visibility`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Projects shadows from dark regions of the _Outdoors mask along the sun direction.

Indoor (roofed) pixels stay lit; outdoor pixels receive building penumbra in scene UV.

Pairs with GpuSceneMaskCompositor per-floor _Outdoors slots on multi-level maps.

## Controls, grouped as the author grouped them

### Building Shadows

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Opacity | `opacity` | slider | 0 … 1 | 0.9 |  |
| Strength boost | `shadowStrengthBoost` | slider | 1 … 10 | 1.3 |  |
| | | | | | _Extra darkening beyond opacity (×1 matches older behavior; use up to ×10 when shadows look too faint)._ |
| Length | `length` | slider | 0 … 0.6 | 0.1 |  |
| | | | | | _Peak shadow length at dawn/dusk (~400 px at default). Scales toward zero at solar noon and midnight._ |
| Softness | `softness` | slider | 0.5 … 8 | 0.5 |  |
| | | | | | _Lateral spread per ray step; grows toward the shadow tip for a softer umbra away from walls._ |
| Smear | `smear` | slider | 0 … 1 | 0.5 |  |
| | | | | | _Stretches and softens the shadow tail along the sun direction (higher = more smeared, painterly falloff)._ |
| Resolution | `resolutionScale` | slider | 1 … 2 | 1 |  |
| Penumbra | `penumbra` | slider | 0 … 1 | 0.11 |  |
| | | | | | _How quickly the shadow softens and lightens along its length (away from the building)._ |
| Shadow Curve | `shadowCurve` | slider | 0.5 … 1.6 | 1.6 |  |
| | | | | | _Gamma on integrated shadow strength; lower = gentler fade into light._ |
| Blur | `blurRadius` | slider | 0 … 4 | 4 |  |
| Contact preserve | `contactShadowPreserve` | slider | 0 … 1 | 1 |  |
| | | | | | _Blurs outward without eating the caster edge: merges pre-blur strength where the footprint is darkest, full blur where it fades. Lower = softer contact._ |
| Contact blend (low) | `contactSharpBlendLow` | slider | 0 … 0.35 | 0 |  |
| | | | | | _Lower bound for where pre-blur strength starts to dominate (shadow strength gamma). Raise slightly if fringe looks too crunchy._ |
| Contact blend (high) | `contactSharpBlendHigh` | slider | 0.2 … 0.98 | 0.98 |  |
| | | | | | _Upper bound toward full contact sharpness inside the silhouette. Lower to pull softness closer to walls._ |
| Edge inflate (px) | `shadowEdgeInflatePx` | slider | 0 … 8 | 0 |  |
| | | | | | _Expands shadow strength slightly in the shadow buffer (in RT pixels) so coverage tucks under the footprint and hides bright rim lines. 0 = off._ |
