# SkyReachShadowsEffectV2

**V2 class:** `SkyReachShadowsEffectV2` · **Source:** `legacy/compositor-v2/effects/SkyReachShadowsEffectV2.js`

**Rebuilt in V3 as:** `light.visibility`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Sky Reach Shadows

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Opacity | `opacity` | slider | 0 … 1 | 0.5 |  |
| Length | `length` | slider | 0.02 … 0.6 | 0.1 |  |
| Softness | `softness` | slider | 0.5 … 8 | 8 |  |
| Smear | `smear` | slider | 0 … 1 | 1 |  |
| Resolution | `resolutionScale` | slider | 1 … 2 | 1.25 |  |
| Penumbra | `penumbra` | slider | 0 … 1 | 1 |  |
| Shadow Curve | `shadowCurve` | slider | 0.5 … 1.6 | 0.81 |  |
| Blur | `blurRadius` | slider | 0 … 4 | 0 |  |
| Upper-Floor Combine | `upperFloorCombineMode` | select | Max (union) / Multiply (single layer only) | max |  |
| Receiver: interior only | `castInteriorReceiverOnly` | boolean |  | false |  |
