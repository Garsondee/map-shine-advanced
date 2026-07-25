# Water Splashes

**V2 class:** `WaterSplashesEffectV2` · **Source:** `legacy/compositor-v2/effects/WaterSplashesEffectV2.js`

**Rebuilt in V3 as:** `sims.particles (sim)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Foam shoreline plumes and rain splash rings spawn from scanned \_Water mask edges and interiors.

Uses the same \_Water depth mask as the main Water effect (per tile and level background).

Parent Water must be enabled for splashes to render.

## Controls, grouped as the author grouped them

### Tint (Jitter) _(advanced)_

| Control  | id             | Type   | Range | Default | Notes |
| -------- | -------------- | ------ | ----- | ------- | ----- |
| Strength | `tintStrength` | slider | 0 … 2 | 2       |       |
| Jitter   | `tintJitter`   | slider | 0 … 2 | 0.75    |       |
| A R      | `tintAColorR`  | slider | 0 … 2 | 1.24    |       |
| A G      | `tintAColorG`  | slider | 0 … 2 | 1.54    |       |
| A B      | `tintAColorB`  | slider | 0 … 2 | 1.32    |       |
| B R      | `tintBColorR`  | slider | 0 … 2 | 0.1     |       |
| B G      | `tintBColorG`  | slider | 0 … 2 | 0.55    |       |
| B B      | `tintBColorB`  | slider | 0 … 2 | 0.75    |       |

### Foam (Shoreline)

| Control      | id                   | Type    | Range     | Default | Notes |
| ------------ | -------------------- | ------- | --------- | ------- | ----- |
| Enabled      | `foamEnabled`        | boolean |           | true    |       |
| Rate         | `foamRate`           | slider  | 0 … 200   | 20      |       |
| Peak Opacity | `foamPeakOpacity`    | slider  | 0 … 1     | 0.84    |       |
| Life Min     | `foamLifeMin`        | slider  | 0.05 … 20 | 0.8     |       |
| Life Max     | `foamLifeMax`        | slider  | 0.05 … 20 | 1.55    |       |
| Size Min     | `foamSizeMin`        | slider  | 1 … 1000  | 56      |       |
| Size Max     | `foamSizeMax`        | slider  | 1 … 1000  | 89      |       |
| Wind Drift   | `foamWindDriftScale` | slider  | 0 … 2     | 1.07    |       |
| Color R      | `foamColorR`         | slider  | 0 … 2     | 0.85    |       |
| Color G      | `foamColorG`         | slider  | 0 … 2     | 1.22    |       |
| Color B      | `foamColorB`         | slider  | 0 … 2     | 0.88    |       |

### Splashes (Rain on Water)

| Control           | id                     | Type    | Range      | Default | Notes |
| ----------------- | ---------------------- | ------- | ---------- | ------- | ----- |
| Enabled           | `splashEnabled`        | boolean |            | true    |       |
| Rate              | `splashRate`           | slider  | 0 … 400    | 10.1    |       |
| Peak Opacity      | `splashPeakOpacity`    | slider  | 0 … 1      | 0.7     |       |
| Life Min          | `splashLifeMin`        | slider  | 0.05 … 10  | 0.3     |       |
| Life Max          | `splashLifeMax`        | slider  | 0.05 … 10  | 0.8     |       |
| Size Min          | `splashSizeMin`        | slider  | 1 … 1000   | 8       |       |
| Size Max          | `splashSizeMax`        | slider  | 1 … 1000   | 25      |       |
| Splash Wind Drift | `splashWindDriftScale` | slider  | 0 … 2      | 2       |       |
| Anim Speed        | `splashAnimSpeed`      | slider  | 0 … 3      | 1       |       |
| Anim Travel       | `splashFlipbookTravel` | slider  | 0 … 2      | 1       |       |
| UV Expand         | `splashUvExpand`       | slider  | 0 … 1.5    | 0.38    |       |
| UV Curve          | `splashUvExpandCurve`  | slider  | 0.05 … 3   | 0.85    |       |
| Ring Focus        | `splashRingCompress`   | slider  | 0 … 1      | 0.48    |       |
| Ring Width        | `splashRingWidth`      | slider  | 0.02 … 0.6 | 0.22    |       |
| Spin              | `splashSpinScale`      | slider  | 0 … 2      | 0.22    |       |

### Mask Scan / Density _(advanced)_

| Control         | id                   | Type   | Range  | Default | Notes |
| --------------- | -------------------- | ------ | ------ | ------- | ----- |
| Water Threshold | `maskThreshold`      | slider | 0 … 1  | 0.15    |       |
| Edge Stride     | `edgeScanStride`     | slider | 1 … 16 | 2       |       |
| Interior Stride | `interiorScanStride` | slider | 1 … 32 | 4       |       |
