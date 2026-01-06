# PLAN: Physics Ropes / Chains (Map Points) for Map Shine Advanced (Three.js)

## Goals
- Implement **physics-enabled rope and chain** visuals driven by **Map Points groups** of type `rope`.
- Support multiple rope archetypes (at minimum: `rope`, `chain`, `elastic`) with tunable parameters.
- Integrate into the current Three.js pipeline:
  - Built and updated through the **Three.js render loop** (no PIXI rendering).
  - Uses the centralized **`TimeManager`** (`timeInfo.delta`, `timeInfo.elapsed`).
  - Uses existing **coordinate conversion rules** (Foundry Y-down vs Three Y-up via `Coordinates.toWorld()` / `toFoundry()`).
- Be **high-performance**:
  - No per-frame allocations in hot paths.
  - Use typed arrays / pooled vectors.
  - Level-of-detail (LOD) and frame-skipping on low GPU tiers.

## Non-Goals (for v1)
- Full rigid-body simulation and collision response with arbitrary scene meshes.
- Complex interaction (dragging rope points in gameplay mode) beyond existing Map Points editing.
- Real-time rope self-collision.

---

## What the Old Module Did (Reference Summary)
Old module used:
- A `PhysicsRope` Verlet simulation:
  - Points have `{x,y, prevX, prevY, locked}`.
  - Endpoints are locked as anchors.
  - Forces:
    - Wind (global wind manager) + position multiplier so the middle “catches” more wind.
    - Restoring force towards a precomputed straight-line “rest position” (spring constant).
    - No gravity in the simulation; “sag” was purely a **visual taper/thickness** effect.
  - Constraints:
    - Multiple iterations (e.g. 8) to maintain segment lengths.
    - Increased stiffness near ends (“ropeEndStiffness”) to avoid end crushing.
- Rendering:
  - `PIXI.SimpleRope` ribbon mesh.
  - Manual vertex buffer manipulation per frame to apply tapering and UV tiling.
  - Optional endpoint fade mask.
  - Optional end-cap sprites at anchors.

Key takeaways:
- Verlet + constraints is stable, simple, and cheap.
- Rendering as a textured ribbon is visually strong and avoids modeling 3D links.

---

## Current v2 System Hooks (Where This Plugs In)
Existing v2 infrastructure:
- `MapPointsManager.getRopeConfigurations()` returns rope groups (currently includes `ropeType`, `texturePath`, `segmentLength`).
- `MapPointsManager` has `addChangeListener(callback)` and calls `notifyListeners()` after changes.
- `EffectComposer.addUpdatable(obj)` drives per-frame updates via `obj.update(timeInfo)`.
- `WeatherController` provides authoritative wind state (`windSpeed`, `windDirection`) and gust logic.

Required integration point:
- In `scripts/foundry/canvas-replacement.js`, after `mapPointsManager.initialize()`, create and register a new manager:
  - `ropeManager = new PhysicsRopeManager(threeScene, sceneComposer, mapPointsManager, weatherController, maskManager)`
  - `ropeManager.initialize()`
  - `effectComposer.addUpdatable(ropeManager)`

---

## Proposed Architecture (Three.js Native)

### New Modules
- `scripts/scene/physics-rope-manager.js`
  - Owns all rope instances.
  - Subscribes to map point changes.
  - Maintains per-rope simulation buffers and render objects.
- `scripts/scene/physics-rope-instance.js` (optional split)
  - Pure data + simulation for one rope (no scene-global policy).

### Data Flow
- **Authoritative user data**: stored in Scene flags by `MapPointsManager`.
- **Runtime simulation**:
  - Built from `mapPointsManager.getRopeConfigurations()`.
  - Stored as compact typed arrays for each rope (positions, prev positions, rest positions, segment lengths).
- **Render objects**:
  - One `THREE.Mesh` per rope (ribbon), plus optional endcap sprites.
  - Geometry updated per frame by writing into `BufferAttribute` arrays.

---

## Map Points Schema (Rope Groups)
Current v2 rope groups already include:
- `type: 'rope'`
- `points: [{x,y}...]` (Foundry space)
- `ropeType?: 'rope'|'chain'|'elastic'`
- `texturePath?: string`
- `segmentLength?: number`

Proposed additional per-group properties (all optional, defaulted by ropeType preset):
- `animationSpeed?: number`
- `damping?: number`
- `windForce?: number`
- `springConstant?: number`
- `tapering?: number`
- `ropeEndTexturePath?: string | null`
- `ropeEndScale?: number`
- `ropeEndStiffness?: number`
- `isIndoors?: boolean` (manual override)
- `indoorWindShielding?: number` (0..1)
- `endpointFade?: number` (0..1)
- `fadeStartDistance?: number` (0..0.5)
- `fadeEndDistance?: number` (0..0.5)

Compatibility policy:
- If older scenes lack these fields, the manager applies defaults from presets.
- We should **not** require any migration to render something reasonable.

---

## Rope Type Presets
Create a v2 preset object (similar intent to old module) but tuned for Three.js:
- `rope`
- `chain`
- `elastic`

Preset structure:
- `label`
- `texturePath`
- Physics: `segmentLength`, `damping`, `windForce`, `springConstant`, `animationSpeed`, `ropeEndStiffness`
- Visual: `tapering`, `endpointFade`, `fadeStartDistance`, `fadeEndDistance`, optional endcap settings

---

## Simulation Design

### Representation
For each rope instance:
- Anchor points: group `points[]` are treated as a polyline path.
- Subdivide into simulation points with a target `segmentLength`.
- Store in typed arrays:
  - `posX[]`, `posY[]`
  - `prevX[]`, `prevY[]`
  - `restX[]`, `restY[]` (straight-line between rope endpoints by default)
  - `segLen[]` (target segment length per segment)
  - `locked[]` (Uint8Array)

### Forces
- **Wind** (from `weatherController.getCurrentState()`):
  - Use `windSpeed` (0..1) as a scalar.
  - Use `windDirection` as a direction vector.
  - Apply a center-weighted multiplier: `centerFactor = sin(t * PI)` along rope length.
  - Apply rope-specific multiplier: `windForce`.
- **Indoor wind shielding**:
  - If `group.isIndoors === true`, reduce wind by `(1 - indoorWindShielding)`.
  - If `group.isIndoors` is not provided, derive automatically using the roof/outdoors mask:
    - Sample `_Outdoors` mask once on CPU (see WeatherController roof-mask extraction pattern).
    - Determine indoor-ness based on anchor midpoint or average along anchors.
    - Cache `outdoorFactor` per rope; recompute only when masks/scene change.
- **Restoring force**:
  - Pull each point towards `restX/restY` by `springConstant`.

### Constraint Solver
- Iterative constraint projection to maintain `segLen`.
- End stiffness:
  - Multiply correction strength near ends by `(1 + ropeEndStiffness * falloff)`.

### Time Stepping
- Use `timeInfo.delta` from `TimeManager`.
- Optional fixed-step substepping for stability at low FPS:
  - Accumulate dt and step in 1/60 increments up to a maximum.
- Allow update skipping on low tier:
  - If `capabilities.tier === 'low'`, update every 2 frames, but still render last geometry.

### Allocation Rules (Performance)
- No `new` in per-frame loops.
- Reuse scratch vectors (or avoid vectors entirely by using numbers/typed arrays).

---

## Rendering Design

### Primary Rendering: Textured Ribbon Mesh
- Build a `THREE.BufferGeometry` representing a triangle strip:
  - For N simulation points, create 2 vertices per point (left/right).
  - Indices: 2*(N-1) quads => triangles.
- Attributes:
  - `position`: Float32Array of size `N*2*3`.
  - `uv`: Float32Array of size `N*2*2`.
- UV tiling:
  - Compute cumulative distance along the rope.
  - Set `u = distance / textureWidthWorldEquivalent` (we can define a parameter for “pixels per tile”).
- Width/tapering:
  - Compute tangent along rope and a perpendicular normal.
  - Half-width = `baseWidth * taperFactor`.
  - Taper factor function (similar to old): `1 - sin(normPos*pi) * tapering * 0.7`.

Material:
- `THREE.MeshBasicMaterial` or `THREE.MeshStandardMaterial` depending on desired lighting interaction.
  - Start with Basic (unlit) for predictability; add tinting via scene darkness if needed.
- `transparent: true` if endpoint fade or alpha textures used.

### Endpoint Fade
Preferred approach for Three.js (instead of a PIXI mask):
- Encode a per-vertex attribute `vFade` (0..1) computed from normalized distance from ends.
- Custom `ShaderMaterial` (or `onBeforeCompile`) multiplies fragment alpha by `vFade`.
- This avoids extra draw calls and avoids stencil/mask complexity.

### Endcaps
- Optional: `THREE.Sprite` or small plane mesh at endpoints.
- Rotate to face along first/last segment.

### Z-Layering / Render Order
- Place ropes in world space at a small Z above ground (ex: `groundZ + 0.5`).
- Follow existing layering rules (keep below tokens, below overhead tiles unless explicitly configured).

---

## LOD / Scaling Rules
- Segment count can explode on long ropes; enforce bounds:
  - `minSegmentLengthPx` clamp.
  - `maxSegmentsPerRope` clamp (if exceeded, increase segment length for that rope).
- Zoom-aware simplification:
  - If zoomed out far, increase effective `segmentLength` (rebuild geometry only when threshold crossed).
- Offscreen culling:
  - Compute rope AABB in scene coords, skip simulation updates if fully offscreen for several frames.

---

## Integration with Weather + Roof Mask
- Wind source:
  - `weatherController.getCurrentState()` is the single source of truth.
- Indoors detection:
  - Follow the established pattern: CPU-side extraction of `_Outdoors` mask into `Uint8Array` once.
  - Provide `getOutdoorsIntensity(u,v)` helper (or reuse WeatherController if it already exposes one).
  - Convert rope world position to mask UV using `canvas.dimensions.sceneRect` bounds mapping.

---

## Debugging / Tooling
- Add a debug toggle (later) to render rope control points and segment constraints.
- Add a simple stats panel entry:
  - rope count
  - total simulated points
  - average update ms

---

## Milestones
1. **MVP**: Render static rope ribbon from map points (no physics), supports texture + UV tiling.
2. **Physics v1**: Verlet simulation + constraints + wind coupling, stable at normal FPS.
3. **Quality**: Endpoint fade via shader attribute, optional endcaps.
4. **Performance**: LOD clamping + update skipping + offscreen culling.
5. **Indoor logic**: Automatic indoor wind shielding via `_Outdoors` mask sampling.

---

## Acceptance Criteria
- A map point group with `type: 'rope'` renders as a textured rope in Three.js.
- Rope reacts to wind changes from WeatherController.
- No obvious stretching or exploding at low FPS (constraints stable).
- CPU and GC behavior remains stable while panning/zooming (no per-frame allocations).
- Works in both Gameplay mode and Map Maker mode (rendering only; authoring is handled by existing map points tools).
