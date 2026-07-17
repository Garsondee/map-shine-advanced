# DistortionManager

**V2 class:** `DistortionManager` · **Source:** `legacy/compositor-v2/effects/DistortionManager.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Global Settings

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Global Intensity | `globalIntensity` | slider | 0 … 2 | 2 |  |

### Debug _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Debug Mode | `debugMode` | boolean |  | false |  |
| Show Distortion Mask | `debugShowMask` | boolean |  | false |  |
| Show Water Shore Band | `debugShowWaterShoreBand` | boolean |  | false |  |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| enabled | `enabled` | boolean |  | true | hidden |
