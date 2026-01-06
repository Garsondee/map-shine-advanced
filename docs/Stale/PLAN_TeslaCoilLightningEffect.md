# PLAN: Tesla-Coil Style Arcing Lightning Effect (Three.js)

## Goal

Create a new lightning VFX that mimics a Tesla coil / electrical arc:
- a bright, noisy, branching arc that "reaches" through air
- a short-lived burst, optionally with multiple rapid strikes
- a clear origin and destination (from map points)
- integrates cleanly into the Map Shine Advanced Three.js renderer and UI

This is planning only. Implementation will come after approval.

## Constraints / Non-Goals

- **No PIXI rendering**: effect should be rendered entirely in Three.js.
- **No per-frame allocations**: avoid `new` in hot loops; pre-allocate buffers.
- **TimeManager only**: schedule animation using `timeInfo.elapsed/delta`.
- **Backwards compatibility**: consumes existing lightning map point groups.

## Inputs (Data Model)

### Primary authoring input: Map Points

- `effectTarget: 'lightning'`
- `type: 'line'`
- `points[0]` = origin
- `points[last]` = destination

### Optional authoring enhancements (future)

- interpret intermediate points as an explicit polyline path
- or add group metadata (e.g., `metadata.lightning = { mode: 'polyline' }`)

## Rendering Approach Options

### Option A (MVP): CPU-generated polyline + `THREE.Line`

- Generate a polyline of N points for each strike.
- Render as `THREE.Line` using `THREE.LineBasicMaterial`.
- Fake thickness via multi-pass (several lines offset slightly) or bloom.

**Pros**
- simplest, minimal shader work

**Cons**
- line thickness limited on many platforms (WebGL lineWidth not reliable)
- glow relies on bloom/overdraw tricks

### Option B (Revised, Recommended): GPU-Side Vertex Expansion ("MeshLine" technique)

Instead of calculating quad corners on the CPU, we pass the path points as attributes and expand them in the **vertex shader**.

- **Geometry**: Custom `BufferGeometry` (or `InstancedBufferGeometry` if we later want many independent strikes in one draw).
- **Attributes (conceptual)**:
  - `prevPos` (vec3)
  - `currPos` (vec3)
  - `nextPos` (vec3)
  - `side` (float, -1 or 1)
  - `uvOffset` (float, 0..1 along arc length)
  - optional: `width` (float) if we want per-vertex taper baked in (otherwise uniform + use `uvOffset`)
- **Vertex shader**:
  - projects `currPos` and `nextPos` to clip space
  - computes a screen-space normal
  - extrudes by `width * side` in screen space

**Pros**
- near-zero CPU cost for camera-facing thickness
- reliable thick lines on all platforms
- perfect base for "plasma" shading (flowing texture + soft alpha)

**Cons**
- requires custom shader + geometry packing

#### Vertex expansion GLSL sketch

```glsl
// Simplified billboard thick-line expansion
attribute vec3 prevPos;
attribute vec3 nextPos;
attribute float side; // -1.0 or 1.0
attribute float uvOffset;

uniform vec2 uResolution;
uniform float uWidth;

varying vec2 vUv;

void main() {
  vec4 clipCurr = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 clipNext = projectionMatrix * modelViewMatrix * vec4(nextPos, 1.0);

  vec2 a = clipCurr.xy / clipCurr.w;
  vec2 b = clipNext.xy / clipNext.w;

  vec2 dir = normalize(b - a);
  vec2 normal = vec2(-dir.y, dir.x);

  // Correct for aspect ratio so thickness is consistent.
  vec2 aspect = vec2(uResolution.y / uResolution.x, 1.0);
  normal *= aspect;

  // Screen-space extrusion scaled back into clip space.
  vec2 offsetNdc = normal * (uWidth / uResolution.y) * side;
  clipCurr.xy += offsetNdc * clipCurr.w;

  gl_Position = clipCurr;
  vUv = vec2(uvOffset, side * 0.5 + 0.5);
}
```

### Option C (High-end): Screen-space post-process lightning

- Render a strike mask to a buffer, then composite in post.

**Pros**
- glow is easy

**Cons**
- coordinate reconstruction / layering is more complex
- not needed for Tesla coil look initially

**Decision**: Start with Option B.

## Strike Generation (Arc Shape)

We want a Tesla coil feel: arcs *search* through the air with high-frequency jitter.

### Baseline path

1. Create a coarse guiding curve from origin to destination:
   - Use a cubic Bezier with a perpendicular offset to form an arc (like legacy v1.x `_generateBezierPath`).
2. Subdivide into `segments` points.

### Jaggedness / turbulence

Apply multi-scale displacement:
- coarse displacement: big bends (midpoint displacement)
- fine displacement: high frequency noise

Pseudo steps:
- start with curve points
- apply recursive midpoint displacement for macro jaggedness
- then apply per-point lateral noise for micro jitter

### Branching

Tesla arcs often fork briefly.

- Select branch start indices along main path (biased toward origin)
- Branch direction: mostly perpendicular + slight forward bias
- Branch lifetime shorter and width smaller

Branch data structure:
- `{ parentStrikeId, depth, points[], widthScale }`

## Animation Model

### Burst scheduling

Per lightning source:
- `nextBurstAt`
- `activeBursts[]`

A burst contains:
- `strikeCount` (random range)
- `strikeSpacing`
- `strikeDuration`

### Strike lifecycle

Each strike:
- `startTime`
- `endTime`
- `seed` (deterministic random)
- `pointsBufferIndex` (where in the shared buffers it lives)

### Flicker

Flicker is a key part of the look.

Use a cheap per-strike modulation:
- `intensity = base * (0.7 + 0.3*sin(seed + time*freq))`
- with a probability `flickerChance` to drop a frame or reduce intensity

## Materials / Shaders

### Visual layers

To mimic the legacy 3-layer glow:
- **Outer glow**: wide, blue-ish, low alpha
- **Mid glow**: medium width, bright
- **Core**: thin, near-white, hottest

Implementation options:
- Multi-material: 3 draw calls per strike (outer/mid/core)
- Single material: compute radial falloff in fragment shader using UV

Recommendation:
- Start with multi-material (clearer, easier to tune), then consolidate later.

### Texture & Flow ("Plasma" feel)

To avoid the "solid laser" look, we treat the bolt as a **plasma volume**:

- **Noise texture**: Seamless Perlin/Worley noise texture sampled in the fragment shader.
- **UV flow**:
  - `vUv.x` runs along the arc length
  - scroll noise along `vUv.x` at high speed using `uTime`

Conceptual fragment logic:

```glsl
uniform sampler2D uNoiseMap;
uniform float uTime;
uniform float uTextureScrollSpeed;

varying vec2 vUv;

void main() {
  float n = texture2D(uNoiseMap, vUv + vec2(uTime * uTextureScrollSpeed, 0.0)).r;
  // n drives alpha and subtle color variation to look like wispy plasma.
}
```

Notes:
- This lets the geometry remain mostly static while the "electricity" appears alive.
- If an external texture is undesirable, we can later replace this with compact procedural noise in GLSL.

### Blending

- Use `AdditiveBlending`
- `depthWrite: false`
- `depthTest`: probably `true` so it can be occluded by tiles/tokens if desired; may be toggled.

### Glow strength

In addition to Bloom, include a `glowStrength` multiplier in the shader so users can tune the emissive energy without changing geometry.

## Integration With Existing Pipeline

### Where it lives

- New effect: `scripts/effects/LightningEffect.js`
- Extend `EffectBase`
- Use `RenderLayers.ENVIRONMENTAL`

### Update loop

- `update(timeInfo)` handles scheduling and buffer updates
- `render(renderer, scene, camera)` is optional (if we only mutate a mesh that is already in the scene)

### UI

- Provide `static getControlSchema()`
- Register in `scripts/foundry/canvas-replacement.js` similar to other effects.

### Environmental Lighting (critical for believability)

Lightning must cast light.

- Each active lightning source manages 1 transient "bolt light".
- **Preferred integration**: register a temporary light contribution into Map Shine's lighting pipeline (so it actually affects the base plane), rather than relying on `THREE.PointLight` (which won't influence our custom lighting shader).
- **Behavior**:
  - position: origin, or "center of mass" of the current strike path
  - intensity: derived from bolt intensity/flicker
  - color: matches `coreColor`

MVP decision:
- Use a single transient light per source (not per strike segment) to keep CPU and lighting cost bounded.

### Grounding failures ("wild arcs")

To add fun unpredictability:

- With probability `wildArcChance`, a strike will **not** connect to the target.
- Instead, we pick a fake destination near the origin:
  - random direction
  - shorter range
  - stronger curvature and jitter

These "failed" strikes still produce glow and light flicker, but look like corona discharge.

### Audio hook

Even if we implement audio later, the effect should expose a clear trigger point:

- On strike start (or burst start), call a hook function, e.g. `onStrikeAudio({ sourceId, intensity, isWild })`.
- Default implementation can be a no-op.
- When integrated with Foundry, we can route this into a one-shot sound playback helper.

## Suggested Parameter Set (v1 compatible + Tesla-specific)

### Timing
- `enabled`
- `minDelayMs`, `maxDelayMs`
- `burstMinStrikes`, `burstMaxStrikes`
- `strikeDurationMs`
- `strikeDelayMs`

### Look
- `outerColor`, `coreColor`
- `brightness`
- `outerWidth`, `coreWidth`
- `taper`
- `flickerChance`

### Shape
- `segments`
- `curveAmount`
- `macroDisplacement`
- `microJitter`
- `branchChance`
- `maxBranchDepth`

### Behavior
- `endPointRandomnessPx` (destination wander)
- `anchorLock` (keep origin stable)

### Visuals (Advanced)
- `noiseTexturePath` (asset path)
- `textureScrollSpeed`
- `glowStrength`

### Interaction
- `lightIntensity` (0 disables the companion lightning light)
- `wildArcChance` (probability a strike fails to connect)

### Audio
- `audioEnabled`
- `audioStrikePath` (asset path)
- `audioVolume`

## Performance Plan

- Pre-allocate a fixed maximum number of strikes and points:
  - e.g. `MAX_STRIKES = 64`, `MAX_POINTS_PER_STRIKE = 128`
- Store all strike points in one large `Float32Array`
- Use `BufferGeometry` with dynamic draw
- Avoid generating new arrays per frame
- Deterministic randomness from `(sourceId + strikeIndex)` seed to reduce allocations

## Debug / Developer Tools

- optional debug toggle:
  - draw source endpoints as small spheres
  - show active strike count
  - freeze time (already possible via `TimeManager`)

## Milestones

1. **MVP Visual**
   - Single strike between map point endpoints
   - Basic ribbon mesh with additive blending
2. **Burst + Flicker**
   - Multiple rapid strikes, flicker
3. **Branching**
   - Short-lived forks
4. **Polish**
   - Better core/outer glow balance
   - Parameter tuning presets

## Risks / Open Questions

- **Line thickness**: avoid reliance on platform lineWidth by using ribbon mesh.
- **Occlusion semantics**: decide whether arcs should render above roofs or be blocked.
- **Coordinate conversion**: ensure consistent Foundry-to-Three conversion (Y flip).

