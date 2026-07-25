# FogOfWarEffectV2

**V2 class:** `FogOfWarEffectV2` · **Source:** `legacy/compositor-v2/effects/FogOfWarEffectV2.js`

**Rebuilt in V3 as:** `present.composite (composite point)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Fog of War

| Control                 | id                             | Type    | Range      | Default | Notes |
| ----------------------- | ------------------------------ | ------- | ---------- | ------- | ----- |
| Unexplored              | `unexploredColor`              | color   |            | #000000 |       |
| Explored Tint           | `exploredColor`                | color   |            | #000000 |       |
| Explored Opacity        | `exploredOpacity`              | slider  | 0 … 1      | 0.5     |       |
| Edge Softness           | `softness`                     | slider  | 0 … 12     | 3       |       |
| Edge Distortion (px)    | `noiseStrength`                | slider  | 0 … 12     | 2       |       |
| Distortion Speed        | `noiseSpeed`                   | slider  | 0 … 2      | 0.2     |       |
| Reveal Token Bubbles    | `revealTokenInFogEnabled`      | boolean |            | false   |       |
| Door Sync               | `doorFogSyncEnabled`           | boolean |            | true    |       |
| Door Sync Thickness     | `doorFogSyncThickness`         | slider  | 0.01 … 0.5 | 0.08    |       |
| Door Sync Duration (ms) | `doorFogSyncDefaultDurationMs` | slider  | 50 … 2500  | 500     |       |

### Ungrouped

| Control | id        | Type    | Range | Default | Notes |
| ------- | --------- | ------- | ----- | ------- | ----- |
| enabled | `enabled` | boolean |       | true    |       |
