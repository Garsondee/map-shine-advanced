# PLAN: Candle Flames (Map Points)

## Summary
Add a new feature called **Candle Flames** driven by the existing Map Points system (`effectTarget: candleFlame`). Candle Flames place:

- A **tiny top-down flame VFX** (THREE-based, efficient for many candles)
- A **flickering light illusion** (THREE-based glow; performance-first)
- **Indoor vs Outdoor** behavior determined by the `_Outdoors` mask (black = indoors)

This document defines the intended architecture and performance strategy.

## Goals
- Efficiently render **many** candle flames (potentially hundreds to thousands).
- Candle flames read from Map Points (`MapPointsManager`) and update dynamically when points change.
- **Indoor vs Outdoor classification** using `_Outdoors` (Roof mask) sampling.
- Candle glow is **clustered + wall-clipped by default**, without depending on Foundry `AmbientLight` documents.
- Flicker that is stable and synchronized with the engine time system.

## Non-Goals (Initial)
- Per-candle shadow casting in the 3D scene.
- Physically correct flame volumetrics.
- Runtime simulation that requires per-frame CPU work per candle.

## Existing System Hooks / Reuse
- **Map points already support** `candleFlame`:
  - `scripts/scene/map-points-manager.js` includes `candleFlame` in `EFFECT_SOURCE_OPTIONS`.
- **FireSparksEffect already consumes** `getGroupsByEffect('candleFlame')` and aggregates points into bucketed particle systems.
- **LightingEffect already has a dedicated light accumulation buffer** (`tLight`) and an internal `lightScene` which is rendered into it.
  - We can inject our own candle glow meshes into `LightingEffect.lightScene` without creating Foundry light documents.
  - `LightMesh` is a lightweight helper for an additive radial falloff mesh.

## Coordinate & Mask Conventions
### Coordinate spaces
- Foundry documents / Map Points store **top-left origin, Y-down**.
- MapShine THREE world is **bottom-left origin, Y-up**.
- Convert Foundry -> THREE using the existing convention:
  - `Coordinates.toWorld(x, y)` or `worldY = canvas.dimensions.height - y`.

### Scene bounds vs padding
- Any UV mapping for masks must use the **scene rectangle** (not padded canvas):
  - `sceneRect = canvas.dimensions.sceneRect`
  - `(sceneX, sceneY, sceneW, sceneH)`

### `_Outdoors` mask sampling
- `WeatherController.getRoofMaskIntensity(u, v)` expects normalized UVs where **(0,0) is top-left of the image**.
- To classify a candle point at Foundry coords `(fx, fy)`:
  - `u = (fx - sceneX) / sceneW`
  - `v = (fy - sceneY) / sceneH`
  - Clamp to `[0,1]`
  - `outdoorFactor = weatherController.getRoofMaskIntensity(u, v)`
  - **Indoors** if `outdoorFactor < 0.5` (configurable threshold)

## Architecture Overview
Candle Flames is conceptually two coupled render elements:

1. **CandleFlamesEffect (VFX)**
   - A THREE-based instanced/batched procedural flame system.
   - Designed for very large counts.

2. **CandleGlowContribution (Lighting)**
  - Produces a *visual glow* by drawing additive meshes into `LightingEffect`’s light buffer.
  - Must be carefully clustered for performance.

### 1) CandleFlamesEffect (VFX)
#### Responsibilities
- Consume MapPoints groups with `effectTarget === 'candleFlame'`.
- Render tiny flame visuals at candle locations.
- Apply indoor/outdoor behavior differences.
- Avoid per-candle per-frame allocations.

#### Rendering strategy
- Use a single `THREE.InstancedMesh` of `THREE.PlaneGeometry` (simple quads).
- Each instance has:
  - World position (x, y, z)
  - Seed/random
  - Intensity scalar (from group emission intensity)
  - OutdoorFactor (0..1)

#### Animation strategy (no per-instance CPU updates)
- Use shader animation driven by centralized time:
  - `uTime = timeInfo.elapsed`
- Flicker is computed in shader using per-instance seed.

#### Visuals: The CandleFlamesEffect (Shader Strategy)
Since we want “tiny top-down flames” and “hundreds/thousands” of them, do **not** use sprite sheets.

- **Infinite variety**: offset noise by instance seed so no two candles flicker the same.
- **Resolution independence**: stays crisp across zoom.
- **Performance**: no atlas sampling; optionally one small noise texture.

Shader logic (conceptual):

- **Geometry**: `InstancedMesh` of `PlaneGeometry`.
- **Instance attributes**:
  - `instancePosition`
  - `instanceColor`
  - `instancePhase` (random 0..1)
  - `outdoorFactor` (0..1 from `_Outdoors`)
- **Vertex shader**:
  - Quads lie flat (top-down 2.5D), centered on candle.
  - Pass `vUv`, `instancePhase`, `outdoorFactor`.
- **Fragment shader**:
  - Radial gradient from center.
  - Distort radius with noise driven by `uTime + instancePhase`.
  - Color ramp: Transparent -> Red -> Orange -> White (core).
  - Outdoor sway: if `outdoorFactor > 0.5`, apply subtle UV shift over time.

#### Indoor vs Outdoor VFX differences
- **Outdoors**:
  - Slightly more flicker/jitter.
  - Optional “weather guttering” (storm reduces visibility/opacity, can extinguish).

- **Indoors**:
  - More stable flame.
  - Reduced sway.
  - Immune (or less sensitive) to precipitation/wind.

#### Z positioning
- Place flames at `groundZ + smallOffset` so they visually sit on the map plane.

### 2) CandleGlowContribution (Lighting)
#### Goal
Create a *visual glow* by drawing additive meshes into `LightingEffect`’s light buffer.

#### Integration point: `LightingEffect`
`LightingEffect` already renders a light accumulation buffer (`tLight`) by rendering `lightScene` into it.

Plan: add candle glow meshes to `LightingEffect.lightScene` (or an internal child group owned by CandleFlames).

#### Geometry strategy
Default approach (avoids Foundry light sources):

- **Clustered + wall-clipped (default)**
  - Spatially cluster candles into buckets.
  - For each bucket, compute a wall-clipped LOS polygon using `scripts/vision/VisionPolygonComputer.js`.
  - Render that polygon using `scripts/scene/LightMesh.js` into `LightingEffect.lightScene`.
  - Flicker is driven by a per-bucket `phase` and `uTime` (GPU-side intensity modulation).

Fallback approach (safety valve):

- **Clustered + non-clipped**
  - Render a simple radial falloff (circle) per bucket (no LOS compute) if wall clipping is disabled or too costly.

#### Clustering (required for performance)
Default plan is to cluster candles into buckets (grid-space or fixed pixel buckets) and render 1 glow per bucket.

- Accumulate:
  - Total intensity
  - Average color
  - Representative position (centroid)
  - OutdoorFactor average

Suggested defaults:

- Bucket size: start with a fixed world-space bucket (e.g. 256px–512px) and tune.
- Hard caps: cap the number of glow buckets rendered per scene to prevent worst-case spikes.

Wall-clip compute frequency:

- Only recompute polygons when walls change or candle points change.
- Never recompute per-frame.

#### Flicker
Flicker stays GPU-driven:

- Each glow instance (or bucket) has `phase`.
- Light buffer shader uses `uTime` and `phase` to modulate intensity.

## Data Flow
- `MapPointsManager` (scene flags) -> CandleFlamesEffect + CandleGlowContribution
- `_Outdoors` mask -> CPU classification per candle point (spawn/build time)
- Optional: `WeatherController.getCurrentState()` -> affects outdoor candles (visual + optional light dimming)

## Key Performance Requirements
- VFX must be:
  - 1-2 draw calls
  - No per-frame allocations
  - No per-candle CPU loops per frame

- Glow must:
  - Be clustered/bucketed by default
  - Avoid per-frame CPU-side geometry rebuilds
  - Wall-clip in the cluster domain (1 polygon per bucket, not per candle)
  - Cache wall-clip results and only rebuild on wall/point changes

## Open Questions (Need Your Call)
- Do you want the default glow to be:
  - Always on (visual only), or
  - Toggleable (VFX-only vs VFX+glow)?
- What target scale?
  - “Hundreds” vs “thousands” changes the default mode choice.
- Should outdoor candles be extinguished by weather (like fire), or merely dimmed?

Wall clipping quality knobs:

- Bucket size (bigger buckets = fewer polygons, less accurate occlusion)
- Vision radius per bucket (smaller radius = cheaper compute)
- Polygon segment count / epsilon tuning in `VisionPolygonComputer`

## Implementation Phases
### Phase 1: VFX-only Candle Flames (Fast)
- New `CandleFlamesEffect` that renders instanced candle sprites from map points.
- Indoor/outdoor classification using `_Outdoors`.

### Phase 2: Clustered + wall-clipped glow in `LightingEffect` (No Foundry lights)
- Cluster candles into buckets.
- Use `VisionPolygonComputer` to compute LOS polygon per bucket.
- Render each bucket via `LightMesh` into `LightingEffect.lightScene`.

### Phase 3: Scalability + polish
- Clustering defaults based on candle count.
- Optional distance/vision culling (do not render VFX outside view or fog).
- UI controls:
  - Enabled
  - Glow mode (Off / Clustered Wall-Clipped / Clustered Non-Clipped)
  - Indoor/outdoor thresholds
  - Flicker intensity/speed overrides
