# Sky Environment (exports)

**V2 class:** `SkyColorEffectV2` · **Source:** `legacy/compositor-v2/effects/SkyColorEffectV2.js`

**Rebuilt in V3 as:** `light.accumulate`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Computes time-of-day sky tint, sun angle, and weather data for water, windows, clouds, and weather-aware lighting.

Outdoor atmosphere grading is applied in **Camera Grade (HDR → LDR)** under the Outdoor atmosphere folder.

Use the controls here for downstream light tinting and exported environment strength.

## The knobs, in the author's words

- **Sun light tint** — How strongly Foundry sun/global lights follow the computed sky hue at night.

## Controls, grouped as the author grouped them

### Sky exports

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Tint Sun Lights | `skyTintDarknessLightsEnabled` | boolean |  | true |  |
| Sun Light Tint Intensity | `skyTintDarknessLightsIntensity` | slider | 0 … 5 | 4.27 |  |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| enabled | `enabled` | boolean |  | true | hidden |
