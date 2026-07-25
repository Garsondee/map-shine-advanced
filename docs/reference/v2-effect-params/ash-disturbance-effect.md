# Ash Disturbance

**V2 class:** `AshDisturbanceEffectV2` · **Source:** `legacy/compositor-v2/effects/AshDisturbanceEffectV2.js`

**Rebuilt in V3 as:** `sims.particles`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Kicks up ash puffs when tokens walk across bright pixels in authored \_Ash masks.

Masks are probed per tile and scene background; bursts respect Manual Weather ash intensity.

Place \_Ash beside each battlemap albedo you want foot-traffic dust on.

## Authored presets

`Light Disturbance` · `Standard` · `Heavy Disturbance` · `Volcanic`

## Controls, grouped as the author grouped them

### Burst Settings

| Control                  | id              | Type   | Range      | Default | Notes |
| ------------------------ | --------------- | ------ | ---------- | ------- | ----- |
| Burst Rate (particles/s) | `burstRate`     | slider | 50 … 2000  | 270     |       |
| Burst Duration (s)       | `burstDuration` | slider | 0.1 … 2    | 1.6     |       |
| Burst Radius (px)        | `burstRadius`   | slider | 50 … 800   | 170     |       |
| Max Particles            | `maxParticles`  | slider | 500 … 8000 | 3000    |       |

### Appearance

| Control       | id             | Type   | Range   | Default | Notes |
| ------------- | -------------- | ------ | ------- | ------- | ----- |
| Size Min (px) | `sizeMin`      | slider | 4 … 100 | 54      |       |
| Size Max (px) | `sizeMax`      | slider | 8 … 150 | 77      |       |
| Life Min (s)  | `lifeMin`      | slider | 0.2 … 6 | 4       |       |
| Life Max (s)  | `lifeMax`      | slider | 0.5 … 8 | 5.9     |       |
| Opacity Start | `opacityStart` | slider | 0.1 … 1 | 0.5     |       |
| Opacity End   | `opacityEnd`   | slider | 0 … 1   | 0.15    |       |

### Motion _(advanced)_

| Control        | id              | Type   | Range    | Default | Notes |
| -------------- | --------------- | ------ | -------- | ------- | ----- |
| Wind Influence | `windInfluence` | slider | 0 … 3    | 0.35    |       |
| Curl Strength  | `curlStrength`  | slider | 0 … 80   | 20      |       |
| Curl Scale     | `curlScale`     | slider | 50 … 800 | 140     |       |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes |
| ------- | --------- | ------- | ----- | ------- | ----- |
| enabled | `enabled` | boolean |       | false   |       |
