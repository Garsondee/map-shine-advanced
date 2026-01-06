# PLAN — Player Light Effect (Torch + Flashlight)

## Goal
Create a new developer-facing and player-facing effect called **Player Light** which adds a cursor-driven light interaction for a selected token.

Two modes:
- **Torch**: a burning flame that follows the mouse cursor and behaves like a “handheld torch” tethered to the token.
- **Flashlight**: a directional cone of caustic light projected from the token toward the mouse cursor.

This effect is the next step after the Debug Layer: it reuses the token→cursor tether, distance measurement, and wall-block probe.

---

## Requirements

### Anti-Abuse / Fog of War Safety (Critical)
This effect **must not** allow a player to reveal information they could not already see under Foundry’s rules.

Constraints:
- Player Light visuals must be treated as **cosmetic-only** unless and until the implementation is proven to be gated by Foundry’s authoritative vision system.
- We must **not** rely on client-only “light” logic to reveal tiles/tokens under fog.
- The authoritative fog gate in this project is `WorldSpaceFogEffect`, which renders fog as a world-space plane overlay driven by Foundry vision/exploration inputs.
  - This means any Player Light visuals drawn *under* the fog plane will not reveal hidden content.
- Until we have a verified safe integration path, Player Light should:
  - Render as a **world-space visual** which is still occluded by the fog plane.
  - Avoid creating persistent Foundry `AmbientLightDocument`s for non-GMs.

Planned safety checks:
- Only allow the effect to run for a non-GM if `token.document.isOwner === true`.
- If we later implement real lighting contribution, gate it behind **additional checks**:
  - Token must be currently controlled by the user.
  - Token must be visible and not hidden.
  - The resulting light must not update Foundry’s fog exploration state.

### Ownership / Permissions
We need deterministic rules for who gets a Player Light.

- **GM**:
  - For testing, treat the GM as owning **the last token they touched**.
  - “Touched” means: last token the user controlled/selected/clicked (we can define this precisely in implementation).
  - Result: GM can trigger Player Light for any token by touching it.

- **Non-GM players**:
  - Only allow Player Light if the player has **full ownership** of the token.
  - Use Foundry authority for this:
    - Prefer `token.document.isOwner === true` (strict)
    - Optionally also require `token.document.canUserModify(game.user, 'update') === true`

### Interaction Contract
- **Active token**:
  - Primary: `canvas.tokens.controlled[0]`
  - GM override: “last touched token” can become the active token for Player Light.

- **Cursor target**:
  - Use `InteractionManager.viewportToWorld(clientX, clientY, groundZ)`.
  - Operate in Three world-space then convert to Foundry coords via `Coordinates.toFoundry` for collision.

### World Stability
- Distances must be computed in **scene distance units** (grid units) using:
  - `pxToUnits = canvas.dimensions.distance / canvas.dimensions.size`
  - `distanceUnits = distancePx * pxToUnits`

### Wall Blocking
- Use Foundry’s collision probe from the active token:
  - `token.checkCollision(dest, { mode: 'closest', type: 'move' })`
- Player Light must react to collision:
  - **Torch**: flame gutters/extinguishes when the cursor target is blocked by a wall.
  - **Flashlight**: cone should be attenuated or clipped when blocked (initial implementation may just reduce intensity to 0 when blocked).

---

## Architectural Constraints (Project Rules)
- Prefer Three.js rendering for visuals (no PIXI rendering for the light visuals).
- Foundry coords are top-left origin, Y-down.
- Three world is bottom-left origin, Y-up.
- Convert with `Coordinates.toWorld()` / `Coordinates.toFoundry()`.
- For any screen-space sampling (future), keep sampling spaces consistent (don’t mix world and screen UVs).

---

## Where This Lives

### New Effect
- `scripts/effects/PlayerLightEffect.js`
  - Extends `EffectBase`
  - Registers with `EffectComposer`
  - Provides `getControlSchema()` for Tweakpane

### Dependencies / Data Sources
- `window.MapShine.interactionManager`:
  - cursor→world projection (`viewportToWorld`)
- `window.MapShine.tokenManager`:
  - token sprite center in world-space (authoritative for visuals)
- Foundry token object:
  - `canvas.tokens.get(tokenId)` for `checkCollision` and permissions

### Particle Reuse
- Torch flame should reuse the *pattern* of Quarks-based particles from `FireSparksEffect`.
- IMPORTANT: For any new mask-driven particle systems, follow the project rule:
  - **Use Lookup Map technique** (precompute positions once; no per-frame rejection sampling)
  - (Torch flame is cursor-driven, so it does not need mask sampling, but it should follow the same “no per-frame allocations” and “Quarks BatchedRenderer” patterns.)

---

## Rendering Strategy
We need two different rendering responsibilities:

### A) Visual Flame / Cone (Three scene objects)
- Torch particles: render as particles in-scene (likely on `RenderLayers.PARTICLES`).
- Flashlight cone: render as a mesh/quad in-scene (likely `RenderLayers.ENVIRONMENTAL` or `SURFACE_EFFECTS`).

### B) Lighting Contribution (integration with LightingEffect)
Long-term, Player Light should contribute to the same lighting buffers as Foundry ambient lights.

Two implementation options:
- **Option 1 (preferred long-term):** create an ephemeral Foundry `AmbientLightDocument` and let `LightingEffect` pick it up through its existing hooks (`createAmbientLight` / `updateAmbientLight` / `deleteAmbientLight`).
  - Pros: maximum parity with Foundry lighting behavior and uses existing `ThreeLightSource` pipeline.
  - Cons: mutates Foundry documents; must be done carefully to avoid leaving orphan lights.

- **Option 2 (preferred short-term):** implement Player Light as a *pure Three-side light pass* that adds into `LightingEffect.lightScene` as a custom mesh.
  - Pros: no Foundry document mutation.
  - Cons: requires touching LightingEffect internals.

This plan starts with **Option 2 for MVP** and keeps Option 1 as a later parity step.

---

## Player Light Modes

### Mode 1 — Torch (cursor-follow flame)
**Behavior**:
- Visual flame follows mouse target position on ground plane.
- If tether distance exceeds `maxDistanceUnits`, fade intensity.
- If tether crosses a wall (collision exists), transition into a **gutter** state.
- When cursor comes back to valid unblocked range, re-ignite.

**“Living Flame” polish (target behavior)**:
- **Flicker logic**:
  - Apply a small noise-driven offset to:
    - intensity
    - cursor-follow position (a subtle XY wander)
  - Use a stable noise source (Perlin/simplex/fbm).
  - Note: `ThreeLightSource` already contains torch-like flicker logic and noise usage; we can reuse that approach for the intensity curve.
- **Tether physics**:
  - Instead of snapping the flame to the cursor, maintain a simulated `torchWorldPos` that is driven by a **spring lerp** toward the cursor target.
  - This gives momentum/lag when the user moves quickly.
- **Gutter / ember state**:
  - When blocked or beyond max distance, do not hard-off.
  - Transition to `dim_ember`:
    - low intensity
    - fewer particles
    - red/dark color
  - When returning to valid conditions, ease back to full torch.

**Visuals**:
- Quarks emitter placed at cursor world position.
- Spawn rate, lifetime, size, and color controlled by an `intensity` scalar.
- Optional small heat distortion hookup via `DistortionManager` similar to FireSparksEffect.

**State**:
- `torchIntensity` in [0,1]
- `torchBlocked` boolean
- `torchDistanceUnits`

### Mode 2 — Flashlight (directional caustics cone)
**Behavior**:
- Cone origin at token center (or slightly forward).
- Cone direction from token center → cursor target.
- Brightness decreases as user aims further away from token (distance) and/or if blocked.

**Visuals**:
- Project a “caustics” texture (torch/volumetric breakup) in a cone shape.
- Implementation v1:
  - A mesh (tri/quad) oriented in world space with a shader that:
    - uses a cone falloff (angle-based)
    - uses distance falloff along cone
    - samples a repeating caustics texture in cone UV space

**“Pro” flashlight features (target behavior)**:
- **Depth softening** (avoid the “hard triangle” on the ground):
  - Sample a depth buffer and fade alpha when the cone surface is close to scene geometry.
  - Current pipeline note: `EffectComposer.sceneRenderTarget` has `depthBuffer: true`, but does not currently expose a `DepthTexture`.
  - Plan:
    - Add an optional `depthTexture` to the scene render target (or add a dedicated depth RT) in a later phase.
    - Provide it to the flashlight shader as `tDepth`.
    - Use camera projection params to reconstruct world/view depth and compute a soft intersection.
- **Projective texture mapping (“cookies”)**:
  - Replace basic caustics with a *lens dirt / cookie* map.
  - Project the cookie along the cone direction so it appears on walls/geometry as a projected pattern.
  - Minimal v1: project in cone local space on the cone mesh; later: world-projected cookie when we have depth.
- **Distance clipping (wall stop)**:
  - Use `token.checkCollision(..., { mode: 'closest' })` to obtain the collision point.
  - Convert to world space and compute `wallDistanceUnits`.
  - Drive a uniform `uWallDistance` that shortens the cone length (and clamps falloff) so it visually stops at the wall.

**Attenuation Model (initial)**:
- `aimDistanceUnits = distance(token, cursor)`
- `aimFalloff = clamp(1 - aimDistanceUnits / maxDistanceUnits, 0, 1)`
- `blockedFalloff = blocked ? 0 : 1`
- `intensity = aimFalloff * blockedFalloff`

---

## Controls / UI
Tweakpane category: `debug` initially (until it’s player-facing UX).

Proposed parameters:
- `enabled` (bool)
- `mode` (enum: `torch` | `flashlight`)
- `maxDistanceUnits` (slider)
- `wallBlockEnabled` (bool)
- Torch:
  - `torchSpawnRate`
  - `torchSize`
  - `torchHeatDistortion` (bool)
- Flashlight:
  - `coneAngleDeg`
  - `coneLengthUnits`
  - `coneTextureScale`
  - `coneIntensity`

---

## Phased Roadmap

### Phase 0 — Scaffolding
- Add `PlayerLightEffect` class + UI schema.
- Add ownership gating rules.
- Track:
  - active token
  - cursor world position
  - distanceUnits
  - blocked + hit point

### Phase 1 — Torch MVP (visual only)
- Create a Quarks emitter that follows cursor.
- Drive intensity based on distance + wall block.
- No lighting contribution yet (pure visuals).

### Phase 1.5 — Torch “Living Flame” Polish
- Add spring-follow (`torchWorldPos`) with tunable stiffness/damping.
- Add noise-based flicker:
  - intensity flicker
  - subtle position wander
- Add gutter/ember state transitions.

### Phase 2 — Flashlight MVP (visual only)
- Create a cone mesh + shader with caustics texture.
- Orient from token toward cursor.
- Attenuate intensity as distance increases.
- Blocked state forces intensity to 0.

### Phase 2.5 — Flashlight “Pro” Features
- Add wall-distance clipping (`uWallDistance`).
- Add cookie/lens-dirt projection.
- Plan depth-softened intersection:
  - requires a depth texture exposure in the render pipeline.

### Phase 3 — Lighting Integration
- Implement additive light contribution:
  - Short-term: custom additive mesh pass integrated into LightingEffect accumulation.
  - Long-term: ephemeral Foundry `AmbientLightDocument` per player-light instance.

**Security note**: If we implement Foundry `AmbientLightDocument` creation, it must be:
- Disabled for non-GM by default until proven safe.
- Guaranteed to not mutate fog exploration or vision state.
- Auto-cleaned up on scene change / effect disable.

### Phase 4 — Gameplay Polish (torch rules)
- Add “gutter” behavior:
  - flicker when near limit
  - short cooldown after wall hit
  - re-ignite when valid
- Add optional UI/UX:
  - cursor flame sprite
  - audio hooks (optional)

---

## Performance Guardrails
- No per-frame allocations in `update()`:
  - reuse vectors
  - reuse geometries
  - reuse shader materials
- Torch particles:
  - one system per active token / user, not per frame
  - intensity drives spawn rate rather than rebuilding emitters
- Flashlight:
  - update a single mesh transform + a few uniforms per frame

---

## Open Questions
- **Definition of “last touched token” for GM**:
  - Control event? click event? hover? (Recommend: “last controlled token id”)
- **Lighting integration path**:
  - Do we accept ephemeral Foundry documents or keep it entirely Three-side?
- **Wall blocking for flashlight**:
  - Should it clip at collision point (shorten cone) vs hard-off?
