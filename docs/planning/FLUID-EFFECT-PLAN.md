# Fluid Effect (Mask-Driven) — Planning Document

## Status
Planning (Phase 0)

## Goal
Create a new high-level surface effect driven by a single `_Fluid` mask texture.

The effect should render semi-transparent, shiny “fluid in pipes” that:
- visually occupies the pipe lines/balls in the mask
- animates with convincing flow (without authoring a vector field)
- includes subtle bubbling / turbulence / shimmer
- supports different looks (water, potion, slime) via parameterized colors/material response
- stays reasonably simple and performant

## Asset Contract: `_Fluid` mask
Single RGBA texture.

### Intended meaning (current)
- **Alpha**: coverage / cutout (low alpha is transparent)
- **“Whiteness”**: indicates fluid presence (discard black / low opacity)
- **Red channel**: "age" (monotonic progression along each pipe run; white → red along length)
- **G/B**: reserved for future use

### Confirmed assumptions
- **Direction**: always treat *increasing red* as the positive direction of travel.
  - Some pipes may be authored “backwards” for visual interest, but the shader should not attempt to infer or correct this.
- **Color**: the mask’s white→red coloration is **coordinate-only**.
  - Final liquid coloration must be controlled purely via effect parameters.
- **Reservoirs**: reservoir-like behavior is desired, but the only reliable cue available in the mask is areas where the red value is locally constant.

### Practical sampling definitions (proposed)
Because pixels transition from **white** `(1,1,1)` to **red** `(1,0,0)`, using “whiteness” literally would incorrectly remove older segments (pure red has low whiteness). So we need an explicit, robust definition:

- **Presence / coverage**:
  - `coverage = alpha * luma(rgb)`
  - `luma(rgb) = dot(rgb, vec3(0.299, 0.587, 0.114))`
  - `mask = smoothstep(thresholdLo, thresholdHi, coverage)`

This keeps red pixels present (luma ~ 0.299) while still discarding dark background.

- **Age coordinate**:
  - `age = r` (0..1)

This makes red usable as a 1D “pipe coordinate” for animation.

## Where this fits in MapShine
### Rendering layer
There are two viable placement strategies:

#### Strategy A: Scene-wide (base plane) overlay
Implement as a **SURFACE_EFFECTS** overlay mesh similar to `IridescenceEffect`:
- clone base plane geometry
- transparent material
- `depthWrite: false`
- renderOrder below overhead tiles

#### Strategy B (preferred for Glassware): Per-tile attachment overlay
Attach the fluid to a *specific tile* (e.g. `*_Glassware.webp`) so the fluid is spatially and visually coupled to that art.

This matches existing patterns in the codebase:
- `TileManager` already discovers and binds per-tile overlays (e.g. tile specular via `SpecularEffect.bindTileSprite(...)`).

For the Glassware use-case:
- base tile: `mythica-machina-wizards-lair-laboratory_Glassware.webp`
- fluid mask: `mythica-machina-wizards-lair-laboratory_Glassware_Fluid.webp`

The Fluid overlay should render **under** the Glassware tile sprite, but remain aligned with it.

Occlusion/tinting behavior requirement:
- The Glassware tile should occlude and tint the fluid using its **normal** texture color + alpha.
- This falls out naturally from standard draw ordering and blending:
  - draw fluid first
  - draw Glassware after
  - Glassware alpha controls how much of the fluid shows “through the glass”

### Occlusion by overhead tiles
Follow the established pattern:
- sample `LightingEffect.roofAlphaTarget` (screen-space) as `uRoofAlphaMap`
- suppress/clip fluid where roof is visible so it never appears above overhead tiles

### Layering requirement: “under Glassware”
The fluid should appear underneath the Glassware tile, not on top of it.

Implementation detail (per-tile overlay):
- Render the fluid mesh with a `renderOrder` slightly lower than the owning tile sprite.
- Mirror the tile sprite’s transform (position/rotation/scale) so the fluid stays glued to the Glassware.
- Drive visibility from the tile’s visibility state.

Recommended render settings (per-tile overlay):
- Fluid material:
  - `transparent: true`
  - `depthWrite: false`
  - `depthTest: true`
- Glassware tile (existing TileManager sprite material):
  - already `transparent: true`, `depthWrite: true`
  - draws after fluid via `renderOrder`

This ensures the tile’s own alpha/color acts as the occluder without needing to sample the tile texture inside the Fluid shader.

## Core challenge
We want *directional flow* without authoring per-pixel flow vectors.

The only directional cue available today is the **red channel gradient** (age increases along pipes).

## Proposed shader approach (v1)
Use the red channel both as:
- a stable “longitudinal coordinate” for time animation
- a way to infer local flow direction from its spatial gradient

### 1) Coverage + edge softness
Compute a soft mask for anti-aliased pipe edges:
- `mask = smoothstep(thresholdLo, thresholdHi, alpha * luma(rgb))`
- optional extra edge feather using `fwidth(mask)` or `fwidth(age)` to reduce aliasing

### 2) Flow direction estimation from age gradient
Approximate a 2D direction field from the red channel:
- `grad = vec2(dFdx(age), dFdy(age))`
- `dir = normalize(grad + 1e-5)`

Notes:
- This assumes age increases monotonically along the intended flow direction.
- At junctions/bulbs, gradients may become small/unstable. We can damp or fallback when `length(grad) < eps`.

### 3) Advected noise / turbulence
Create a small-scale noise field (procedural) and advect it along `dir`:
- sample positions in **screen-UV or base-mesh UV** (choose one and stick to it)
- build turbulence using fBm/simplex
- advect coordinates:
  - `p = baseCoord * noiseScale + dir * (time * flowSpeed)`

This yields “motion along the pipes” without needing explicit UV unwrapping.

### 4) Traveling pulses / slugs (cheap ‘fluid motion’ cue)
Add a directional moving pattern in the **age domain**:
- `pulse = smoothstep(...) * sin((age * pulseFrequency) + time * pulseSpeed)`
- optionally distort `age` with turbulence: `ageWarped = age + warpStrength * noise`

This makes the motion read strongly as “something flowing” even if the vector field is imperfect.

### 5) Shading: fake specular + thickness
We can get a convincing “wet, glossy” look without full PBR by:
- treating the fluid as an overlay with a view-dependent highlight
- generating a fake normal from the same noise field

Example components:
- **Base tint**: blend between `youngColor` and `oldColor` driven by `age`
- **Transmission/thickness**: use `mask` plus a second noise term to vary opacity (looks like bubbles)
- **Specular**:
  - compute a 2D normal from noise derivatives (screen-space)
  - compute highlight factor vs a fake light direction (or reuse sky/dominant light patterns if desired)

### 6) Bubbles
Two cheap bubble signals (both masked by `mask`):
- **Cell noise** (Voronoi-like) thresholded into circular dots
- **Rising shimmer** (animated noise) modulating opacity slightly

Importantly: keep bubble density low and subtle; too strong will read like “sparkles.”

## Color story / “magic potion” styling (v1)
We can use the existing mask channels to drive a pleasing gradient:
- `fluidColor = mix(youngColor, oldColor, pow(age, ageGamma))`
- optional iridescence-style spectral tint *only on highlights*:
  - do NOT fully reuse IridescenceEffect; instead borrow the *idea*: add small hue shifts proportional to specular term.

## Algorithm options (evaluate before implementation)
### Option A (recommended first): Age-gradient + advected noise
- Uses `dFdx/dFdy` of red channel as local direction.
- Most likely to create convincing in-pipe motion with a single mask.
- No preprocessing.

Risks:
- gradient instability at junctions
- requires tuning to avoid noisy direction flicker

Mitigations:
- clamp `dir` when `|grad|` too low
- optionally blend toward a global fallback direction

### Option B: “Age-domain only” animation (no spatial dir)
- Use only `age` as 1D coordinate for motion cues (pulses, shimmer).
- Direction is implicit from age progression.

Pros:
- extremely robust
- no derivative instability

Cons:
- motion may read as “animated texture” rather than “flow” on curved pipes

### Option C (future): CPU preprocess to build a sparse flow field
If Option A is too unstable, we can preprocess once per scene:
- scan the mask (thresholded) and compute an approximate tangent field along the pipe skeleton
- pack a 2-channel direction map into a `DataTexture`

Pros:
- stable flow direction

Cons:
- more complexity; defeats “single mask only” purity (though it’s derived from the single mask)

## Proposed implementation phases
### Phase 0: Planning + mask validation
- Add `_Fluid` to loader mask suffix registry
- Add a `MaskDebugEffect` view for the `_Fluid` channels (or reuse existing debug) to verify
  - alpha coverage
  - red monotonicity
  - luma threshold suitability

Additionally (for per-tile attachments):
- Add optional per-tile `_Fluid` probing similar to tile `_Specular` probing.
- Confirm tile UV/origin alignment (Foundry top-left doc → Three sprite center).

### Phase 1: Minimal overlay (static)
- New `FluidEffect` (SURFACE_EFFECTS)
- Supports **scene-wide** mode and **per-tile attachment** mode.
- Renders base tint + alpha mask.
- Roof alpha occlusion wired (never above overhead).

### Phase 2: Motion
- Add age-domain pulses + noise shimmer
- Add advected noise with age-gradient direction (Option A)
- Add parameters for flowSpeed, pulseFrequency, turbulence

### Phase 3: Shiny + bubbles
- Add fake specular highlight
- Add bubble noise modulating opacity (subtle)
- Optional “magic tint” on highlights

### Phase 4: Polish / robustness
- junction stability improvements
- optional fallback mode switch (Option A vs B)
- performance tuning (uniform-driven branches vs shader defines)

## Performance considerations
- Avoid additional render targets in v1.
- Keep it as a single overlay mesh + single `ShaderMaterial`.
- Use derivative functions carefully (they’re cheap, but avoid pathological branching).
- Keep noise functions lightweight (2D simplex + small fBm; no heavy loops).

Per-tile overlays:
- Use one shared shader source, but expect one material instance per active Fluid tile (different textures/uniforms).
- Avoid per-frame allocations while syncing tile transforms (reuse temp vectors if needed).

## Integration checklist (codebase)
- `scripts/assets/loader.js`: add `fluid: { suffix: '_Fluid', ... }`
- `scripts/effects/FluidEffect.js`: new effect class
- `scripts/foundry/effect-wiring.js`:
  - export `FluidEffect`
  - add to `getIndependentEffectDefs()`
  - add to `BASE_MESH_EFFECTS` so it receives `setBaseMesh(basePlane, bundle)`
- `LightingEffect` integration: provide roof alpha target reference pattern (as Iridescence does)

Per-tile attachment wiring (preferred for Glassware):
- `scripts/scene/tile-manager.js`: probe for per-tile `_Fluid` companion mask and call `fluidEffect.bindTileSprite(tileDoc, sprite, fluidTex)`.
- `scripts/effects/FluidEffect.js`: implement `bindTileSprite(...)` / `unbindTileSprite(...)` and manage per-tile overlay meshes.

## Open questions (need your answers)
1. **Overhead rule for Glassware**: the Glassware tile is an overhead layer in your example, but you also said "hide the fluid if it's part of an overhead layer".
   - Decision: Fluid is allowed to render **under overhead tiles** (required for Glassware).
   - Hide Fluid when the owning tile is flagged as a **roof** (`overheadIsRoof` / `isWeatherRoof`) or when roof alpha occlusion indicates a roof is visually present above it.
2. **How to identify attachment tiles**:
   - Is the contract simply: if a tile has a sibling `*_Fluid` image next to it, bind Fluid to that tile?
   - Or should it only bind when the tile name contains `_Glassware` (or a future flag)?
3. **Reservoirs (bulbs)**: ok to approximate reservoirs by detecting low age-gradient magnitude (near-constant red) and increasing bubble/shimmer there?

