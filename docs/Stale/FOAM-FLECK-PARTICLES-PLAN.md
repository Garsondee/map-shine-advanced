# Foam Fleck Particles Plan (WaterEffectV2)

## Goal
Add a subtle particle effect that represents tiny flecks of foam getting lifted into the air when wind speed is *increasing*.

- Spawn points should come from:
  - **Shoreline foam** (near the water boundary)
  - **Floating foam** (clumps drifting across open water)
- Particles should:
  - Spawn as **single-pixel (or near single-pixel) white flecks**.
  - Pop **upward** slightly, then **drift** with wind.
  - **Land** back down.
  - If they land on water, they should be influenced by water “distortion motion” briefly, then die.

This plan is written to fit MapShine Advanced’s performance goals: no per-frame allocations, no per-frame GPU readbacks.

Confirmed constraints for MVP:

- Outdoors-only: no foam flecks should spawn from indoor water.
- Rendering: 1–2px dot billboard texture (performance-first), not true GPU point rendering.

## Current Relevant Systems / Code Anchors

### Shoreline foam spawn points (already exist)
`scripts/particles/WeatherParticles.js` already generates shoreline edge points from the water mask and uses them for foam systems:

- `this._shoreFoamPoints = this._generateWaterEdgePoints(waterTex, ...)`
- `ShorelineFoamEmitter` and `ShorelineFoamSprayEmitter` both accept `setPoints(points)` where points are packed as:
  - `[u, v, nx, ny, u, v, nx, ny, ...]`
  - `u,v` are normalized scene-UVs
  - `nx,ny` are edge normals

This is the most robust way to get **shore foam spawn points** with correct world placement and normals.

### Floating foam (currently procedural in WaterEffectV2 shader)
`WaterEffectV2` computes floating foam entirely in the fragment shader (noise driven by `uTime`, `uFoamSpeed`, `uFloatingFoamScale`, etc.).

Important implication:
- There is **no CPU-side representation** of floating foam positions currently.
- Pulling “where are the clumps right now?” from the shader via readback each frame is not acceptable (perf + stutter risk).

Therefore, for floating foam spawn points we need a **CPU-side proxy** that is coherent with the shader but not identical.

## Proposed Architecture

### High-level approach
Implement a new particle sub-effect (likely as part of `WeatherParticles` because it already owns water-mask-based point sets and uses Quarks for CPU-simulated particles).

- **Source of spawn points**:
  - Shore foam: reuse `WeatherParticles._shoreFoamPoints`.
  - Floating foam: generate a separate point set derived from the water mask interior (deep water), then animate/spawn from it with a cheap CPU-side drift model.

- **Spawn gating**: emission occurs when wind speed is increasing.

- **Particle lifecycle**:
  - Airborne (short)
  - Landing (short “skitter” on water)
  - Die

### Why WeatherParticles is the right host
- Already has:
  - `weatherController` access
  - `waterEffect` reference (via EffectComposer)
  - water mask texture access (`waterEffect.getWaterMaskTexture()`)
  - cached point lists and update-on-uuid-change semantics
  - proven performance patterns (reuse vectors, mutate existing values)

WaterEffectV2 should remain primarily a post-process shader pass; it’s not a good place to host CPU particle simulation.

## Detailed Design

### 1) Spawn point sets

#### 1.1 Shoreline points
Reuse existing `_shoreFoamPoints`:
- Pros:
  - Already computed
  - Already includes edge normals
  - Stable and deterministic

We will create a new emitter shape:
- `FoamFleckShoreEmitter` that reads from the same packed points array.
- It should place particles at the point with a small jitter in tangent direction.

#### 1.2 Floating foam proxy points (CPU)
We need a point set representing “places where floating foam could plausibly exist”.

Option A (recommended Phase 1): **static interior water points**
- Generate `N` random samples in water interior using the existing water mask texture (CPU reads `waterTex.image` similarly to `_generateWaterSplashPoints`).
- Filter to “deep water” by rejecting points too close to shore. We can approximate this by:
  - Using the water SDF texture from `WaterEffectV2.getWaterDataTexture()` if accessible, OR
  - A cheap heuristic: reject points near the edge by checking local neighborhood (stride-based edge test).

Then, at spawn time, apply a deterministic pseudo-drift:
- Use global wind direction and an accumulated offset phase (similar to WaterEffectV2’s `uWindOffsetUv` concept) to bias the selected point.
- This gives the illusion that flecks originate from moving foam clumps.

Option B (Phase 2): **coherent noise field match**
- Re-implement a simplified version of the floating-foam noise in JS to compute a binary “clump exists here” predicate.
- Build a list of “active” clump points each second (throttled), not each frame.
- More accurate, but more engineering.

### 2) Wind acceleration detection (spawn trigger)
We want flecks primarily when wind speed is increasing.

We can compute a stable “wind acceleration” signal per update:
- `windSpeed01 = clamp(weather.windSpeed, 0..1)`
- `windDelta = windSpeed01 - lastWindSpeed01`
- `windAccel01 = clamp(windDelta / dt, 0..maxAccel) / maxAccel`
- `gustFactor = smoothstep(a0, a1, windAccel01)`

Then define emission rate:
- `emission = base * (windSpeed01^p) * gustFactor * intensity`

Important: `dt` must come from the centralized TimeManager via `timeInfo.delta` (already used across effects).

### 3) Particle system spec (visual)
We want “single pixel” white flecks.

Practical rendering constraints:
- True 1-pixel points in Three.js are hard to guarantee across DPR and post-processing.
- We can approximate with:
  - Small billboard quad texture (1–2px dot), additive or alpha blend
  - Or a `PointsMaterial`-like shader in Quarks if supported

Initial parameters (Phase 1):
- `startSize`: 1.0–2.5 (scaled by DPR/zoom if needed)
- `startLife`: 0.6–1.2s
- `startColor`: white with alpha 0.8–1.0
- `maxParticles`: 500–2000 (tunable)

### 4) Motion model (airborne → landing)
Quarks is CPU simulated; we can implement behaviors similar to existing snow/rain behaviors.

#### 4.1 Airborne behavior
- On initialize:
  - Set a vertical “hop” velocity (Z+) scaled by `windAccel01`.
  - Set a horizontal drift velocity along wind direction.

- During update:
  - Apply gravity: `v.z -= g * dt`
  - Apply mild drag so particles don’t shoot forever.

#### 4.2 Landing detection
Define a “water surface plane” Z for these flecks.
- Likely land at `groundZ + waterPlaneOffset` (the same Z as water hit splashes / foam overlays).
- When `particle.position.z <= 0` (or <= landingZ in local space), mark `particle._landed = true`.

#### 4.3 Drift-on-water after landing (“distortion carry”)
We cannot cheaply query WaterEffectV2’s per-pixel distortion vector on CPU.

So we implement a visually similar approximation:
- When landed:
  - Apply a small additional 2D drift driven by:
    - wind direction
    - a curl-ish noise field (CPU) OR a simple sin/noise wobble
  - Run for `landedLife` seconds (e.g. 0.2–0.6s)
  - Fade alpha out and kill.

This achieves the key perception (“it lands and skitters with the water motion”) without real shader sampling.

Phase 2 enhancement:
- Expose a low-res distortion vector field texture from DistortionManager / WaterEffectV2 and sample it at spawn/landing time only (throttled). This would require extra plumbing and careful perf validation.

### 5) Masking / visibility rules
- Only spawn if water is enabled and water mask exists.
- Optional: respect `_Outdoors` roof mask rules:
  - Indoor water? likely still fine, but if we want realism, we can dampen based on outdoors factor.

### 6) Integration points

#### Where the point lists live
- Shoreline points already live in `WeatherParticles` and update when water mask uuid changes.
- Floating proxy points should follow the same pattern:
  - Recompute only when water mask uuid changes or on explicit rebuild.

#### Where the wind acceleration signal lives
- `WeatherParticles.update()` already reads `weather.windSpeed`.
- Add cached `this._lastWindSpeed01` and `this._windAccel01Smoothed`.

#### New Quarks system
- Add a new system, e.g. `this._foamFleckSystem` with its own shape(s) and behaviors.
- Likely share existing `WorldVolumeKillBehavior`.

### 7) Performance constraints / invariants
- No per-frame creation of:
  - `Vector2/Vector3/ColorRange/IntervalValue` etc.
- Point set generation should occur:
  - On water mask change (uuid)
  - Potentially throttled for floating foam proxy points if it’s expensive
- Avoid per-frame CPU scanning of images.

## Phasing

### Phase 1 (MVP)
- Spawn points:
  - Shoreline foam points (existing `_shoreFoamPoints`)
  - “Floating” points: static interior water points (generated once from mask)
- Emission:
  - Triggered by wind acceleration + wind speed
- Motion:
  - Hop upward + drift + gravity
  - On landing: 0.3s drift (procedural) + fade out

### Phase 2 (Fidelity)
- Floating foam spawn points become time-coherent:
  - periodic (1–2Hz) rebuild of “active clump points” using a CPU noise proxy
  - optional coupling to WaterEffectV2 parameters (foam scales/speeds)
- Optional: sample a low-res water distortion vector field for landed drift.

## Open Questions (need your input)
- Outdoors-only and dot billboard texture are confirmed; proceed with MVP.
- Should flecks collide with roofs / overhead tiles (roofAlphaMap), or can we ignore that for now?

## Proposed Files to Change (after plan approval)
- `scripts/particles/WeatherParticles.js`
  - Add new point set for floating foam proxy
  - Add new Quarks system + behaviors
  - Drive emission based on wind acceleration
- Potentially add a small dot texture (if we don’t already have one)
  - Prefer reusing an existing texture in `assets/` if available

