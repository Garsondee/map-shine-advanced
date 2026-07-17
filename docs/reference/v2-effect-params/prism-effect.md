# PrismEffectV2

**V2 class:** `PrismEffectV2` · **Source:** `legacy/compositor-v2/effects/PrismEffectV2.js`

**Rebuilt in V3 as:** `surface.response`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Refraction

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Distortion | `intensity` | slider | 0 … 5 | 0.3 |  |
| Spectral Spread | `spread` | slider | 0 … 1 | 0.6 |  |
| Brightness Boost | `brightness` | slider | 0.5 … 3 | 1.5 |  |
| Opacity | `opacity` | slider | 0 … 1 | 0.25 |  |
| Mask Brightness Cutoff | `maskThreshold` | slider | 0 … 1 | 0.9 |  |

### Crystal Facets _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Facet Scale | `facetScale` | slider | 1 … 1000 | 254 |  |
| Animate Facets | `facetAnimate` | boolean |  | true |  |
| Animation Speed | `facetSpeed` | slider | 0 … 2 | 1.01 |  |
| Facet Softness | `facetSoftness` | slider | 0 … 1 | 0.85 |  |

### Camera Parallax _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Parallax Strength | `parallaxStrength` | slider | 0 … 5 | 2.4 |  |

### Surface Glint _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Glint Strength | `glintStrength` | slider | 0 … 2 | 0.4 |  |
| Glint Sharpness | `glintThreshold` | slider | 0 … 0.99 | 0.13 |  |
