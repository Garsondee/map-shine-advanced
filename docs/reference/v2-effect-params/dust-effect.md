# Dust Motes

**V2 class:** `DustEffectV2` · **Source:** `legacy/compositor-v2/effects/DustEffectV2.js`

**Rebuilt in V3 as:** `sims.particles (sim)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Floating dust particles from authored \_Dust masks on tiles and level backgrounds.

Bright mask pixels define spawn sites in a vertical volume; optional Map Points add extra sources.

Requires matching \_Dust files beside each battlemap you want motes over.

## Controls, grouped as the author grouped them

### Dust Motes

| Control       | id             | Type   | Range     | Default | Notes |
| ------------- | -------------- | ------ | --------- | ------- | ----- |
| Density       | `density`      | slider | 0 … 3     | 3       |       |
| Max Particles | `maxParticles` | slider | 0 … 20000 | 4000    |       |

### Appearance

| Control           | id                | Type    | Range | Default | Notes |
| ----------------- | ----------------- | ------- | ----- | ------- | ----- |
| Brightness        | `brightness`      | slider  | 0 … 3 | 3       |       |
| Opacity           | `opacity`         | slider  | 0 … 1 | 0.5     |       |
| Sky Tint Dust     | `skyTintEnabled`  | boolean |       | false   |       |
| Sky Tint Strength | `skyTintStrength` | slider  | 0 … 1 | 0       |       |

### Glitter _(advanced)_

| Control               | id                | Type    | Range    | Default | Notes |
| --------------------- | ----------------- | ------- | -------- | ------- | ----- |
| Enable Glitter        | `glitterEnabled`  | boolean |          | false   |       |
| Glitter Strength      | `glitterStrength` | slider  | 0 … 0.6  | 0.12    |       |
| Glitter Rate Min (Hz) | `glitterRateMin`  | slider  | 0.1 … 30 | 8       |       |
| Glitter Rate Max (Hz) | `glitterRateMax`  | slider  | 0.1 … 30 | 16      |       |

### Lifetime & Size _(advanced)_

| Control      | id        | Type   | Range     | Default | Notes |
| ------------ | --------- | ------ | --------- | ------- | ----- |
| Life Min (s) | `lifeMin` | slider | 0.2 … 30  | 4.5     |       |
| Life Max (s) | `lifeMax` | slider | 0.2 … 30  | 8.7     |       |
| Size Min     | `sizeMin` | slider | 0.1 … 80  | 15      |       |
| Size Max     | `sizeMax` | slider | 0.1 … 120 | 25      |       |

### Volume _(advanced)_

| Control | id     | Type   | Range    | Default | Notes |
| ------- | ------ | ------ | -------- | ------- | ----- |
| Z Min   | `zMin` | slider | 0 … 800  | 10      |       |
| Z Max   | `zMax` | slider | 0 … 1200 | 140     |       |

### Motion _(advanced)_

| Control       | id                   | Type   | Range     | Default | Notes |
| ------------- | -------------------- | ------ | --------- | ------- | ----- |
| Drift         | `motionDrift`        | slider | 0 … 80    | 1       |       |
| Curl Strength | `motionCurlStrength` | slider | 0 … 200   | 18      |       |
| Curl Scale    | `motionCurlScale`    | slider | 10 … 2000 | 40      |       |

### Ungrouped

| Control      | id        | Type    | Range | Default | Notes |
| ------------ | --------- | ------- | ----- | ------- | ----- |
| Dust Enabled | `enabled` | boolean |       | false   |       |
