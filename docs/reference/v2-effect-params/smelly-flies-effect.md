# SmellyFliesEffect

**V2 class:** `SmellyFliesEffect` · **Source:** `legacy/particles/SmellyFliesEffect.js`

**Rebuilt in V3 as:** `sims.particles (sim)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Max Flies | `maxParticles` | slider | 1 … 30 | 10 |  |
| Buzz Intensity | `flying.noiseStrength` | slider | 500 … 3000 | 1500 |  |
| Tether Strength | `flying.tetherStrength` | slider | 5 … 50 | 20 |  |
| Max Speed | `flying.maxSpeed` | slider | 200 … 1500 | 600 |  |
| Land Chance | `flying.landChance` | slider | 0 … 0.2 | 0.08 |  |
| Fly Height | `flying.flyHeight` | slider | 20 … 200 | 80 |  |
| Walk Speed | `walking.walkSpeed` | slider | 10 … 100 | 40 |  |
| Takeoff Chance | `walking.takeoffChance` | slider | 0 … 0.1 | 0.03 |  |
| Flying Scale | `visual.flyingScale` | slider | 10 … 60 | 18 |  |
| Walking Scale | `visual.walkingScale` | slider | 10 … 60 | 16 |  |
| Motion Blur | `visual.motionBlurEnabled` | boolean |  | true |  |
| Speed | `speedMultiplier` | slider | 0.25 … 4 | 2.75 |  |
