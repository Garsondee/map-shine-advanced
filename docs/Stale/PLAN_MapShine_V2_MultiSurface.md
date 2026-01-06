# MapShine V2 Planning: Multi-Surface / Multi-Stack Rendering

## 0) Goal
Build a MapShine architecture that reliably supports scenes with:

- Multiple tiles representing distinct “floors” / “stacks” (Ground, FirstFloor, etc.)
- Different effects enabled per stack (water, fog, windows, clouds, bloom, etc.)
- A consistent UX/API where “scene background” and “tiles” are treated as the same kind of surface
- Overhead tiles and a new “Roof” type that integrates cleanly with weather visibility, lighting, and post FX

**Primary success criterion**
- The system must never silently fall back to “one bundle wins” behavior. If multiple surfaces exist, MapShine must either:
  - render them as distinct stacks, or
  - explicitly define compositing rules (union/max, override order, masks-per-surface) and surface a clear report.

### 0.1 Design principles (V2)
- **Explicitness over inference**
  - If the author intends multiple floors, the system must have explicit stack membership and explicit compositing rules.
- **Determinism**
  - Same scene state => same resolved surfaces/stacks/passes every time.
- **Single source of truth**
  - A surface is the authoritative unit of “what is being rendered and how it should respond to effects”.
  - Effects do not decide which surface they target; the graph builder does.
- **Coordinate correctness is a contract**
  - Every mask/texture resource must declare its coordinate space and flip conventions.
  - Effects are forbidden from sampling a resource in the wrong space.
- **Debuggability is a feature, not an afterthought**
  - The UI must report how the renderer resolved the scene.
  - Failures are visible and actionable.

### 0.2 Non-negotiable invariants
- **No silent overrides**
  - If multiple surfaces provide a mask of the same semantic type (e.g. `water`), V2 must:
    - either keep them distinct (stack/surface-scoped resources),
    - or combine them with an explicit declared rule,
    - but never “last loaded wins”.
- **Every controllable UI element must map to a real render decision**
  - If the UI exposes `cloudTopsEnabled` for a surface, the render graph must contain a resource/pass that actually reads that flag.
- **Every dynamic resource has an owner and a lifecycle**
  - Render targets and derived textures are tagged as `staticPerScene`, `dynamicOnDemand`, or `dynamicPerFrame`.
- **Background and tiles are the same category**
  - The system must represent the “background” as a surface (`scene:background`) even if it is a solid color.
  - This prevents a second, special-case pipeline.


## 1) Current V1 Architecture (As Implemented)
### 1.1 Rendering topology
- A single Three scene is rendered once per frame into an HDR render target.
- Post-processing effects run as a single chain over that screen texture.
- Tile sprites are synchronized from Foundry tiles into Three (`TileManager` creates a `THREE.Sprite` per tile).
- Some features use “special layers” to render masks into targets (roof alpha, cloud blocker masks, etc.) by:
  - setting `camera.layers` to a layer
  - rendering the main scene into a render target

### 1.2 Asset loading and masking
- SceneComposer produces a single “bundle” (`currentBundle`) containing:
  - baseTexture (scene background texture or fallback)
  - masks loaded from one basePath (or composed horizontally in limited cases)
- Most effects are fed from this single bundle.

### 1.3 Control model
- Per-tile toggles are stored as tile flags.
- Those flags generally impact behavior by mutating the Three sprite’s layers or render state.


## 2) Why V1 Breaks Down for Multi-Tile / Multi-Floor Scenes
### 2.1 The fundamental mismatch: **one global post chain** vs **many surfaces needing independent semantics**
Effects like water, caustics, fog, roof masking, outdoors, cloud tops/shadows, and “bypass effects” are often semantically **surface-scoped**:

- “Apply water distortion only where this surface’s _Water mask says so”
- “This surface receives cloud tops but not cloud shadows”
- “This surface is a roof and occludes weather unless hovered”

But V1 is implemented as:

- One global post chain operating on the final composited image
- One global mask bundle (or ad-hoc composites)

This causes:

- **Mask source ambiguity**: which tile’s `_Water` is authoritative?
- **Control drift**: the UI can update a tile flag, but the actual mask pass may not include the intended Three object.
- **Inconsistent per-surface behavior**: some features may be “per tile” (layer-based blockers) while others remain “per scene” (bundle-based masks).

### 2.2 “One bundle wins” is an anti-feature
The current approach often reduces to:

- select a basePath
- load masks
- effects read from that single mask set

In multi-floor scenes, this is effectively random/unstable unless we explicitly define ordering.

### 2.3 Ad-hoc compositing does not scale
Unioning masks (e.g., `_Water`) can solve a specific symptom, but it doesn’t define a coherent future system for:

- “Water is per floor, but clouds are per tile, but fog is per tile group, but roofs are overhead-only”
- “Some effects need depth/occlusion relative to other surfaces”

### 2.4 “Tiles vs background” is currently treated differently
Even if the scene background is a tile in practice, the codebase has conceptual split paths:

- `SceneComposer.createBasePlane()` is special
- Tile sprites are separate

In V2 we want a unified model: background and tiles are both **surfaces**.


## 3) MapShine V2: Proposed Conceptual Model
V2 introduces three foundational ideas:

1) **Surfaces** (things that can be shaded/affected)
2) **Stacks** (ordered collections of surfaces that should be composited together)
3) **Render Graph** (explicit passes and dependencies, not implicit “one chain”)

### 3.1 Surface
A `Surface` is an abstraction over “something rendered on the ground plane”:

- Scene background (if used)
- A Foundry tile
- Future: decals, special terrain meshes, etc.

Each surface has:

- **Identity**: `surfaceId`
- **Geometry mapping**: rect in Foundry space, transform, rotation
- **Z/ordering semantics**: elevation/overhead/roof classification, sort key
- **Material inputs**: albedo/base texture
- **Mask set**: `_Water`, `_Outdoors`, `_Specular`, `_Structural`, etc.
- **Per-surface flags**: receivesCloudTops, receivesCloudShadows, bypassPostFX, occludesWater, roofType, etc.

#### 3.1.1 Surface data model (concrete)
V2 needs a concrete surface model (conceptually “typed”, regardless of JS/TS implementation).

```text
Surface {
  surfaceId: string              // tiles: tileDoc.id, background: 'scene:background'
  source: 'tile'|'background'

  // Foundry-space geometry
  rectFoundry: { x, y, w, h }    // top-left origin, Y-down
  rotationDeg: number
  elevation: number

  // Classification
  kind: 'background'|'ground'|'floor'|'overhead'
  roof: 'none'|'roof'|'weatherRoof'

  // Ordering
  sortKey: number                // derived from tile sort/z + elevation rules
  stackId: string                // explicit authoring value

  // Visual sources
  albedo: { basePath, textureRef? }
  masks: { basePath, registryVersion }

  // Surface-level toggles (authored as flags)
  flags: {
    bypassPostFX: boolean
    cloudTopsEnabled: boolean
    cloudShadowsEnabled: boolean
    occludesWater: boolean
  }
}
```

Key design choice: **`stackId` is not inferred at runtime in V2** (a fallback can exist, but it must be converted into explicit flags as soon as the user confirms authoring).

### 3.2 Stack
A `Stack` is a conceptual group of surfaces that share a consistent compositing context.
Typical stack examples:

- Ground stack
- First floor stack
- Overhead stack

A stack defines:

- **which surfaces it contains**
- **how they composite** (alpha blend, override, depth, etc.)
- **which effects apply to that stack** and how they feed into global post

#### 3.2.1 Stack data model
```text
Stack {
  stackId: string
  label: string
  kind: 'background'|'floor'|'overhead'
  surfaces: Surface[]             // already sorted deterministically

  // Composition rules within the stack
  composeMode: 'alphaOver'|'alphaCutout'|'max'|'custom'
  depthMode: 'none'|'perSurface'  // start with 'none' for sprites, evolve later

  // Stack-scoped flags
  enabled: boolean
}
```

### 3.3 Render Graph
Instead of “render scene once then run a post chain”, V2 uses an explicit render graph with named resources:

- `Color[stack]`, `Depth[stack]`, `Normals[stack]`, `Mask[stack, water]`, etc.
- Passes that read/write these resources

This enables:

- stack-specific effects (water distortion per floor)
- cross-stack occlusion rules (overhead roofs occlude weather)
- stable compositing and debugability

#### 3.3.1 Why a render graph is mandatory for reliability
V1’s “single scene render + global post chain” hides dependencies. V2 must make them explicit:

- If `CloudEffect` needs a blocker mask, that mask is a first-class resource with a defined producer pass.
- If `WaterEffect` needs per-stack distortion, it must read `Mask[stackId, water]` (not “whatever bundle was last loaded”).
- If roof/weather needs `roofAlpha`, it must be produced from surfaces that have `roof != none`.


## 4) Proposed V2 API / Systems
### 4.1 SurfaceRegistry + SurfaceProvider API
We need a central registry that provides a stable set of surfaces each frame.

**`SurfaceProvider`**
- `getSurfaces(): Surface[]`

Providers:
- `SceneBackgroundProvider`
- `TileSurfaceProvider`

**Surface normalization rules**
- Always represent the background as a surface (even if it’s a solid color)
- Always represent each Foundry tile as a surface

This ensures “tiles and backgrounds are the same kind of thing”.

### 4.2 AssetBundleManager (per-surface)
Replace “one bundle per scene” with:

- `getBundleForSurface(surfaceId)` => loads textures/masks based on that surface’s basePath
- caching keyed by `basePath + maskRegistryVersion`

Key features:
- batch loading
- failure states exposed to UI
- explicit mask presence reporting

### 4.3 MaskManager V2
Currently many masks are implicit textures on effects.
V2 should treat masks as first-class resources with metadata:

- coordinate space: `sceneUv`, `screenUv`, `worldUv`
- channel semantics: `r`, `a`, luminance
- flip conventions (Foundry top-left vs Three bottom-left)

This prevents mixing world-space sampled masks with screen-space post FX (per the coordinates memory).

### 4.3.1 Coordinate-space contracts (non-negotiable)
To avoid the class of bugs we’ve already hit (world/screen UV mixing), V2 must standardize resource spaces.

#### Core spaces
- **Foundry space**
  - Origin: top-left
  - Y increases downward
- **Three world space**
  - Origin: bottom-left (in our MapShine convention)
  - Y increases upward
  - Convert Foundry -> Three: `(x, y) -> (x, canvas.dimensions.height - y)`
- **SceneRect vs padded canvas**
  - Use `canvas.dimensions.sceneRect` for authored mask UV mapping.

#### Resource sampling rules
- **Scene/world-authored masks** (e.g. `_Outdoors`, `_Water`) are sampled in **scene UV**:
  - `u = (foundryX - sceneX) / sceneW`
  - `v = 1 - (foundryY - sceneY) / sceneH`
- **Screen-space post resources** (cloud tops overlay, roof alpha targets) are sampled in **screen UV** (`vUv` or `gl_FragCoord / screenSize`).
- **Never mix**: A screen-space pass must not sample a world mask unless that mask is explicitly projected into screen space by a dedicated pass.

#### Stability rules
- Any blur/edge offsets in post shaders must be specified in **pixels** and multiplied by `uTexelSize`.
- Use the project’s perspective zoom source (`sceneComposer.currentZoom`) rather than camera zoom shortcuts.

### 4.4 StackResolver
A deterministic system that groups surfaces into stacks.

Potential initial rule set:

- **Background stack**: scene background surface (if any)
- **Ground/floor stacks**: non-overhead tiles grouped by an explicit tile flag `stackId` (user-set) or inferred from naming
- **Overhead stack**: tiles with elevation >= foregroundElevation

No inference-only solutions long-term: we need explicit user intent via flags.

#### 4.4.1 Stack authoring strategy (recommended)
To maximize control and reliability:

- **Primary**: `tile.flags['map-shine-advanced'].stackId = 'ground'|'firstFloor'|...`
- **Optional helper**: a one-time “Auto-detect stacks from naming” button that:
  - proposes assignments,
  - writes explicit flags,
  - and never runs silently.

This mirrors the philosophy used elsewhere in the module: runtime systems should not depend on filename heuristics.

### 4.5 Effect routing model: “global effect” vs “stack effect” vs “surface effect”
Not every effect needs per-surface isolation. Categorize:

- **Global post effects**: bloom, color grading
- **Stack-scoped effects**: water distortion, fog, material shading that depends on the stack’s masks
- **Surface-scoped modifiers**: per-tile blockers/receivers (cloud receive, bypassPostFX)

V2 should formalize this so effects declare:

- required inputs (resources)
- output target(s)
- scope

### 4.6 RenderGraphBuilder + Pass API (new)
V2 needs a formal pass interface so the engine can schedule work deterministically.

```text
Pass {
  id: string
  scope: 'global'|'stack'|'surface'
  reads: ResourceKey[]
  writes: ResourceKey[]
  run(ctx): void
}

ResourceKey examples:
  Color:stack:ground
  Depth:stack:firstFloor
  Mask:surface:<surfaceId>:water
  Mask:stack:ground:water
  CloudBlocker:stack:ground:tops
  RoofAlpha:global
```

Design requirement: resources are created/owned by the graph, not by individual effects ad-hoc.


## 5) Overhead + Roof Integration (V2)
We currently have overhead and a “roof” concept (`overheadIsRoof`, plus roof alpha passes).
V2 should clarify the taxonomy:

- **Overhead**: a surface that is rendered above the ground stack (visual layering)
- **Roof**: a surface that also participates in *weather visibility rules* (occluding precipitation, affecting outdoors/indoors)

Proposed:

- `surface.kind = 'ground' | 'floor' | 'overhead'`
- `surface.roof = 'none' | 'roof' | 'weatherRoof'` (or a single enum)

Required behaviors:

- Roof surfaces render into roof masks/resources
- Weather simulation uses those masks to decide where precipitation appears
- Roof hover-hide (or occlusion fade) updates mask contribution

Coordinate handling requirements (must match existing project rules):

- Roof alpha targets are screen-space resources sampled in screen UV
- Outdoors mask is world/scene UV sampled, with V flip rules

### 5.1 Roof should be a first-class surface role, not a side-channel
In V1, “roof-ness” is often inferred from overhead status and a flag.
In V2:

- A roof is a **surface property** that causes that surface to participate in:
  - weather visibility rules
  - indoor/outdoor lighting and precipitation masking
- Roof masking must be produced by a graph pass that is explicitly defined and validated.


## 6) Recommended V2 Rendering Strategy
There are two viable “big picture” approaches.

### Option A: Multi-pass per stack + final composite
1) Render each stack into its own `Color/Depth` target.
2) Apply stack-scoped post effects to each stack independently.
3) Composite stacks in a final pass using explicit ordering.
4) Apply global post effects at the end.

Pros:
- clean semantics per floor
- easy to debug

Cons:
- potentially expensive (multiple full-screen passes)

### Option B: Single scene render + auxiliary per-stack mask/material resources
1) Render the full scene once.
2) Produce stack id buffers / surface id masks.
3) Apply effects conditioned on stack id/surface id.

Pros:
- fewer scene renders

Cons:
- complex; requires ID buffers and careful edge rules

**Recommendation**
Start with Option A for correctness and clarity; optimize later.

### 6.1 Option A, specified (baseline render graph)
Option A only becomes reliable once the passes/resources are explicitly spelled out.

#### 6.1.1 Resources
Per stack (for each `stackId`):
- `Color[stackId]` (HDR)
- `Depth[stackId]` (optional at first; required once we add proper occlusion)
- `Normals[stackId]` (optional; required for advanced material shading)

Auxiliary global resources:
- `RoofAlpha[global]` (screen UV)
- `WeatherRoofAlpha[global]` (screen UV)
- `CloudShadowBlocker[stackId]` (screen UV)
- `CloudTopBlocker[stackId]` (screen UV)

Per-surface resources (loaded/cached):
- `Albedo[surfaceId]`
- `Mask[surfaceId, water/outdoors/... ]` (scene UV)

Derived resources:
- `Mask[stackId, water]` (scene UV) = explicit composition of `Mask[surfaceId, water]` for surfaces in that stack

#### 6.1.2 Passes (minimum viable)
For each stack:
- **Pass: RenderStackColor**
  - draws the stack’s surfaces into `Color[stackId]`
  - respects `surface.flags.bypassPostFX` by routing that surface into an overlay path (or skipping stack FX)
- **Pass: BuildStackMasks**
  - produces derived masks such as `Mask[stackId, water]`
  - uses explicit rules (e.g., `max/lighten` for water where multiple surfaces contribute)
- **Pass: ApplyStackEffects**
  - water distortion on `Color[stackId]` using `Mask[stackId, water]`
  - future: stack fog, local grading, etc.

Global passes:
- **Pass: RenderRoofAlpha**
  - renders roof surfaces (across all stacks) into `RoofAlpha` / `WeatherRoofAlpha` targets
- **Pass: RenderCloudBlockersPerStack**
  - renders blocker masks per stack (or global, if we decide clouds are global)
- **Pass: CompositeStacks**
  - composites `Color[stackId]` in explicit order into `Color[final]`
- **Pass: ApplyGlobalPost**
  - bloom/color grade over `Color[final]`

#### 6.1.3 Explicit compositing order
Recommended default order:

1) `background`
2) floor stacks in numeric order (`ground`, `firstFloor`, ...)
3) `overhead`
4) overlay-only renderables (bypassed surfaces, debug layers)

This order must be user-visible and overridable.


## 7) Tile/Background API and “Effect Stack UI” alignment
### 7.1 The UI must not lie
When the UI says “tile X has cloud tops disabled”, that must correspond to:

- a surface entry exists
- that surface participates in the blocker/receiver resource used by CloudEffect

V2 should provide a diagnostic report per surface:

- bundle load state
- which masks exist
- which stacks/effects include it
- whether it contributes to each auxiliary mask (roof, cloud blockers, water occlusion)

### 7.2 A unified control surface
Controls should target `surfaceId` not “tileDoc id” directly.

- For tiles, `surfaceId == tileDoc.id`
- For background, a stable synthetic id, e.g. `scene:background`

This allows us to treat background and tiles identically.

### 7.3 Authoring UX (V2)
The author must be able to understand and control the resolved surface graph.

Minimum required UX elements:
- **Surface list (accordion)**
  - each surface row shows:
    - `stackId`, `kind`, `roof` status
    - mask presence (`_Water`, `_Outdoors`, etc.)
    - active flags (cloud tops/shadows, bypass)
- **Stack view**
  - list stacks, their surface membership, and stack order
- **Validation panel**
  - “why is this not working?” answers:
    - surface exists? bundle loaded? mask found? included in stack? used by pass?

Critical requirement: authoring changes must be **write-through to flags** so the runtime does not depend on transient UI state.

### 7.4 Diagnostics and failure policy
When something fails, we must prefer “safe visual result + explicit warning”:

- Missing mask => treat as zero mask, but warn.
- Conflicting definitions (two surfaces marked as background) => choose deterministic winner and warn.
- Stack has no surfaces => keep stack but mark disabled and warn.
- Bundle load errors => display file picker path, basePath, and exception.


## 8) Migration / Implementation Plan (No Half Measures)
### Phase 0: Instrumentation & invariants
- Add a “Surface Report” debug output (console + UI) that lists:
  - surfaces discovered
  - stacks resolved
  - bundle load state per surface
  - effect routing per surface/stack
- Add invariants:
  - If multiple eligible surfaces have a given mask (e.g. `_Water`), V1 must either union or error-report; never silent override.

Deliverables:
- A single “Surface Report” object exported globally (and optionally displayed in UI):
  - `surfaces[]` (resolved)
  - `stacks[]` (resolved)
  - `resources[]` (declared)
  - `passes[]` (scheduled)
- A “UI Validator” pass that asserts invariants and reports actionable causes.

### Phase 1: SurfaceRegistry + per-surface AssetBundleManager
- Introduce `SurfaceRegistry` and providers.
- Introduce `AssetBundleManager` that loads masks per surface.
- Keep rendering pipeline mostly the same for now, but remove “one bundle” assumption.

### Phase 2: StackResolver + explicit stack flags
- Add tile flags:
  - `mapshine.stackId` (string)
  - `mapshine.surfaceRole` (optional: background/ground/floor/overhead)
- Build stacks deterministically.

### Phase 3: Render Graph v1 (Option A)
- Render `Color/Depth` per stack.
- Implement stack-local versions of the most problematic effects first:
  - Water (distortion mask per stack)
  - Cloud receive/blockers per surface (within a stack)
- Composite stacks.

Deliverables:
- Render targets per stack
- A deterministic stack compositor
- Water moved to stack-scoped resources (no more single bundle dependency)
- Cloud blockers produced by an explicit pass per stack (or explicitly declared global)

### Phase 4: Roof/weather integration
- Move roof alpha into the render graph.
- Clarify roof semantics and ensure consistent sampling spaces.

### Phase 5: Optimize & extend
- Introduce selective resolution scaling per stack.
- Cache static stacks when no movement occurs.
- Add new effects confidently because the resource model is explicit.

### Phase 6: Test scenes and regression harness (required)
We need a repeatable way to ensure MapShine doesn’t regress when new effects are added.

Deliverables:
- A set of “golden scenes” (developer-only) that cover:
  - single background only
  - ground + firstFloor full-scene tiles
  - overhead roofs + weatherRoof behavior
  - mixed small tiles + large tiles + rotation
- A debug capture tool:
  - capture `Color[stackId]`, derived masks, and final composite as images
  - include a JSON dump of the Surface Report for the capture


## 9) Immediate Learnings from the Current Bug Pattern
Given your reported behavior (some tiles respond to cloud toggles while others do not), V1 likely has at least one of:

- surface discovery mismatch (tile exists in Foundry but not in Three)
- stack/ordering mismatch (tile is rendered, but not rendered into the relevant blocker resource)
- bundle/mask mismatch (mask exists but is loaded from a different basePath)

V2 addresses this by:

- making surfaces explicit
- making stack membership explicit
- making effect inputs explicit
- making debugability a first-class feature


## 10) Decisions (recommended defaults)
These decisions are chosen to maximize control, reliability, and future extensibility.

### 10.1 Stack identity
- **Decision**: Stack identity is authored via explicit flags (`stackId`).
- **Fallback**: optional “suggest stacks” tool exists only as an authoring helper and writes explicit flags.

### 10.2 Primary rendering approach
- **Decision**: Implement Option A first (multi-pass per stack + explicit composite).
- **Rationale**: correctness and debuggability dominate; we can optimize later.

### 10.3 Per-surface vs per-stack post FX
- **Decision**: Most effects are stack-scoped; per-surface control is expressed via:
  - per-surface masks (receiver/blocker masks)
  - explicit surface flags that are consumed by a producing pass
- **Rationale**: keeps the graph manageable while still giving per-surface control.

### 10.4 Occlusion between stacks
- **Decision (near-term)**: explicit compositing order with alpha.
- **Decision (mid-term)**: introduce “cutout masks” (e.g. `_Cutout` or `_Interior`) for floor reveal rules.
- **Rationale**: depth-only occlusion is not reliable with sprites and mixed authoring; cutouts are controllable and deterministic.

## 11) Remaining open questions (keep small)
- Do we want to standardize a canonical set of stack IDs (`ground`, `floor1`, `floor2`, `overhead`) or allow arbitrary strings?
- Should clouds be treated as global (single cloud field) with per-surface receiver masks, or per-stack cloud layers?
- How far do we want to go with true geometry depth (non-sprite meshes) for floors in the future?

## 12) Non-goals
- Reintroducing PIXI rendering for alignment or masking. The direction is full Three control.

