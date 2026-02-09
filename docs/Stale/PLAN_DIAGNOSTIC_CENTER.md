# Diagnostic Center (Tweakpane Dialogue) – Planning Document

## Status
Planning

## Problem Statement
Map Shine Advanced can currently fail “silently” when an effect appears configured correctly (e.g. a valid `_Specular` mask exists in the map’s assets) but the visual effect does not show.

Today, users have no single place to interrogate:
- What data a specific tile *actually* has
- What the engine inferred from that data (surface kind, stack, layers)
- Whether the tile is being bypassed or filtered out
- Whether the effect is enabled but not affecting that tile
- What specific failure points are likely (missing registry entries, incorrect masking, disabled overlay, shader validation errors, etc.)

## Goal
Create a new Tweakpane “Diagnostic Center” dialog that:
- Lets you **select a tile** (from a canonical source of truth)
- Lets you **run an explicit diagnostic** on that tile
- Produces a structured report: **PASS / WARN / FAIL / INFO**
- Surfaces **silent failure points** with recommended fixes and quick actions

Additionally:
- Must support diagnostics for **all render layers** (not just Specular)
- Must support diagnostics scoped to:
  - a **tile** (tile-scoped)
  - the **scene** (pipeline-scoped)
  - a **specific effect** (effect-scoped)

Primary motivating case:
- A scene has a perfectly valid `_Specular` mask, but `SpecularEffect` is not visible.

Secondary motivating cases:
- Weather particles are missing indoors/outdoors incorrectly (roof/outdoor mask / roof alpha mismatch)
- Fog of war appears black/incorrectly pinned (vision/exploration bridge failure)
- Lighting looks wrong (roof occlusion, perception refresh, light source sync)
- Tiles appear but are not affected by effects (surface taxonomy, bypass flags, layer masks)
- Post-processing chain “breaks” (black screen / missing pass-through)

## Non-Goals (Initial Iteration)
- Full automated “repair” of user content
- GPU-side probing (reading back render targets) unless absolutely necessary
- Long-running per-frame diagnostics

## UX Overview
### Entry Points
- **Tweakpane → Global → Tools → “Diagnostic Center”** button
- (Optional follow-up) **Effect Stack → Tile row context action** (e.g. ctrl/alt-click opens diagnostics)

### Expected Flow
1. Open Diagnostic Center.
2. Choose “Target Tile”:
   - A searchable dropdown/list of tiles (reuse the Effect Stack tile list approach).
   - Or “Use last interacted tile” (if we add selection plumbing).
3. Press **Run Diagnostics**.
4. Dialog shows:
   - Summary banner (Green/Yellow/Red)
   - A table/list of checks grouped by category
   - “Copy Report” button (copies JSON or human-readable text)
   - Quick action buttons when possible (open tile config, pan to tile, toggle bypass, etc.)

### Diagnostic Modes
The dialog supports multiple scopes:
- **Tile Mode**: Run all tile-relevant checks (surfaces, masks, per-tile overlays, layer flags)
- **Effect Mode**: Choose an effect (lighting/fog/specular/weather/etc.) and run effect-specific checks
- **Pipeline Mode**: Validate the renderer pipeline integrity (buffers, pass-through, readiness, post chain)

## Architecture Proposal
### New UI Components
- `scripts/ui/diagnostic-center-dialog.js`
  - Tweakpane-based dialog container
  - Hosts:
    - target selection UI
    - report rendering UI
    - copy/export actions

- `scripts/ui/diagnostic-center.js` (or manager)
  - Owns dialog instance
  - Provides a stable public API:
    - `open()`
    - `close()`
    - `runForTile(tileId)`

### Integration Point
- Add a button in `scripts/ui/tweakpane-manager.js` near other tools:
  - Texture Manager
  - Effect Stack
  - Map Points

### Data Sources (Authoritative)
- **TileDocument**: `canvas.scene.tiles.get(tileId)`
- **TileManager** (Three sprite state): `window.MapShine.tileManager.tileSprites.get(tileId)`
- **Surface Registry / Report**: `window.MapShine.surfaceRegistry.refresh()` or `window.MapShine.surfaceReport`
- **Asset loader / bundles** (mask discovery): reuse the same “basePath → bundle.masks” probe used by `EffectStackUI`.

Additional sources (effect/pipeline):
- **EffectComposer**: to enumerate effect instances, layer scenes, and post-processing chain
- **LightingEffect / roof alpha target**: roof alpha render target dimensions + availability
- **WeatherController**: roof/outdoors mask availability + CPU-extracted mask sampling
- **Fog/Vision manager**: availability of vision polygons and exploration texture bridge
- **Graphics overrides** (client-side): per-effect enable/disable / intensity multipliers

### Report Format
A diagnostic run returns:
```js
{
  tileId,
  tileName,
  timestamp,
  summary: { pass, warn, fail },
  checks: [
    {
      id: 'tile.exists',
      category: 'Tile',
      status: 'PASS'|'WARN'|'FAIL'|'INFO',
      message: string,
      details?: any,
      actions?: [ { id, label, run: () => Promise<void> } ]
    }
  ]
}
```

The UI should render checks grouped by category with stable ordering.

### Check Framework (Generalized)
Checks should be declarative and composable:
- Each effect can contribute checks (e.g. `SpecularEffect.getDiagnostics(tileId)`)
- The Diagnostic Center aggregates checks by scope:
  - Tile checks
  - Scene/pipeline checks
  - Effect checks

Each check should prefer:
- Deterministic tests (data existence, flags, layer masks)
- “Likely cause” heuristics when data is incomplete
- Action hooks that are safe and reversible

## Layer / Effect Coverage Matrix
The Diagnostic Center must cover at least:

### Surface / Scene Layers
- Ground surfaces (background + ground tiles)
- Overhead surfaces (tiles with elevation ≥ scene.foregroundElevation)
- Roof surfaces (subset of overhead tiles tagged as roofs)
- Overlay-only content (bypassEffects, UI overlay meshes)

### Material Layer (surface shading)
- Specular
- Roughness
- Normal mapping
- Iridescence / thin-film (if enabled)

### Environmental Layer (in-world)
- Weather particles (rain/snow/splash)
- Fire / smoke particles
- Cloud shadows / canopy / overhead shadows

### Post-Processing Layer
- Lighting pass integrity (if screen-space)
- Bloom
- Color correction
- ASCII (and other post effects)
- Distortion pipeline

## Diagnostic Categories & Checks (v1)

### 1) TileDocument Integrity
- `tile.exists`: TileDocument exists in `canvas.scene.tiles`
- `tile.texture.src`: has texture src
- `tile.dimensions`: width/height non-zero
- `tile.visibility`: `hidden` state surfaced (INFO)

### 2) Module Flags / Feature Gates
- `tile.flags.bypassEffects`:
  - If true: WARN/INFO explaining that effects are bypassed for this tile
  - Provide action: toggle bypass
- `tile.flags.overheadIsRoof`:
  - If tile is overhead (elevation ≥ foregroundElevation), ensure this matches user intent
- `tile.flags.cloudShadowsEnabled`, `tile.flags.cloudTopsEnabled`, `tile.flags.occludesWater`
  - Surface as INFO + show expected Three layers

### 3) Three Sprite / Layering State (TileManager)
- `three.sprite.exists`: a Three sprite exists for this tile
- `three.sprite.visible`: sprite visible
- `three.userData.taxonomy`: `isOverhead`, `isWeatherRoof` correctness
- `three.layers`:
  - Ensure roof/weather roof/water occluder layers match expected based on doc + flags
  - If `bypassEffects` is true, ensure overlay layer is enabled instead

(There is already similar logic in `TweakpaneManager.runUIValidator()`; the Diagnostic Center should reuse the same concepts but scoped to a single tile.)

### 4) Surface Registry Consistency
- `surface.report.exists`: report available
- `surface.entry.exists`: tile present in surface report
- `surface.entry.taxonomy`: surface kind and stackId match expected (ground/overhead/roof)

### 5) Asset / Mask Discovery
Goal: detect cases where the user believes masks exist but the runtime doesn’t see them (for any effect).

Checks:
- `asset.basePath`: computed basePath from tile texture src (INFO)
- `asset.bundle.load`: can we load bundle masks for basePath (PASS/FAIL)
- `asset.mask.present._Specular`: is `_Specular` present in bundle.masks (PASS/FAIL)
- `asset.mask.present._Roughness`: present (INFO)
- `asset.mask.present._Normal`: present (INFO)
- `asset.mask.present._Outdoors`: present (INFO)
- `asset.mask.present._Fire`: present (INFO)
- `asset.mask.present._Water`: present (INFO)

Also surface likely mistakes:
- Wrong naming convention (case sensitivity, missing suffix separator)
- Tile is using a different base texture than expected

Optional (future) deep checks:
- `asset.mask.luma.sample`: sample a small set of pixels CPU-side to detect “present but effectively empty” masks
- `asset.mask.dimensions`: mask resolution mismatch (if a pipeline assumes matching sizes)

### 6) Effect State & Capability
For all effects:
- `effect.<id>.exists`: effect instance exists in composer
- `effect.<id>.enabled`: effect enabled
- `effect.<id>.readiness`: effect readiness promise resolved (if applicable)
- `effect.<id>.shaderValid`: shader validator errors (if exposed)
- `effect.<id>.overrides`: per-client graphics override state (if present)

For Specular:
- `effect.specular.hasMask`: effect believes it has a specular mask (use `params.hasSpecularMask` and/or internal fields)

Important nuance:
- Specular can be scene-wide or per-tile depending on implementation details.
- If specular is implemented as per-tile overlays, verify that an overlay exists for this tile.

For other layers, the same “tile participation” concept applies:
- A tile might be present but excluded from an effect due to:
  - bypass flags
  - surface taxonomy mismatch
  - mask not discovered for that tile
  - layer-only rendering path (overlay vs main)

### 7) “Silent Failure” Heuristics (Specular)
This is the heart of the Diagnostic Center.

If `_Specular` mask is present but the effect doesn’t show, we should emit targeted hypotheses:
- **Tile bypassed** (`bypassEffects=true`)
- **SpecularEffect disabled** (global or via per-client overrides)
- **Tile not part of the material layer** (wrong surface kind / stack)
- **Overlay not built** (tile not registered with specular overlay map)
- **Mask bundle load failed** (basePath mismatch, asset not found)
- **Mask exists but is fully black** (optional future: CPU sample a few pixels after load)
- **Render ordering / layers** (tile rendered only in overlay layer)

Each hypothesis should be actionable:
- open tile sheet
- pan to tile
- copy expected filename patterns
- show computed basePath

## Additional “Silent Failure” Heuristics (All Layers)

### A) Surface Taxonomy / Layer Masking
If a tile renders but effects don’t apply:
- **Tile is bypassing effects** (`bypassEffects=true`)
- **Tile is in an unexpected surface kind** (ground vs overhead vs roof mismatch)
- **Tile Three sprite layer mask excludes the effect’s render layer**

### B) Pipeline / Post Chain Integrity
If the screen goes black, or post effects stop applying:
- An effect in the post chain returned early without drawing a pass-through
- A required buffer or input texture is missing
- A render target is misconfigured (size/type)

Proposed checks:
- `pipeline.postChain.nonBreaking`: verify every enabled post effect either renders or explicitly pass-throughs
- `pipeline.buffers.present`: verify expected buffers exist
- `pipeline.buffers.type`: verify internal buffers use expected precision (e.g. float where required)

### C) Mask Space Contract Violations
If an effect exists but appears “offset”, inverted, or only works on some tiles:
- World-space vs screen-space mask sampling mismatch
- SceneRect vs padded canvas bounds mismatch
- Y-flip conventions mismatched

Proposed checks:
- `coords.sceneRect`: confirm sceneRect is used for world-space sampling bounds
- `coords.yFlip`: confirm world↔foundry conversion applied where required

### D) Roof/Outdoors Interactions (Common Root Cause)
If weather/light/fog behaves incorrectly indoors:
- `_Outdoors` (roof/outdoor mask) missing
- roof alpha target missing/out-of-date
- tile flagged as roof incorrectly

Proposed checks:
- `roof.mask.present`: outdoors mask available
- `roof.alpha.present`: roof alpha render target available
- `roof.alpha.size`: screen size uniform matches the roof alpha target

## Effect-Specific Check Sets (Minimum)

### Lighting
Goals:
- Ensure lighting sources are synced
- Ensure indoor occlusion is consistent with roofs

Checks:
- `lighting.effect.exists/enabled`
- `lighting.roofAlphaTarget.present`
- `lighting.roofAlphaTarget.size`
- `lighting.sources.count` (INFO)
- `lighting.indoorOcclusion.inputs`: outdoors mask + roof alpha map are wired

### Fog of War
Goals:
- Prevent “black screen” and ensure fog is pinned correctly

Checks:
- `fog.effect.exists/enabled`
- `fog.visionTexture.present`
- `fog.explorationTexture.present`
- `fog.lastUpdateAge` (INFO)
- `fog.fallbackActive` (WARN if fallback quad is used frequently)

### Weather Particles
Goals:
- Ensure rain/snow visibility rules are consistent indoors/outdoors/roof-visible

Checks:
- `weather.effect.exists/enabled`
- `weather.roofMask.present` (`_Outdoors`)
- `weather.roofAlpha.present` (screen-space roof alpha)
- `weather.visibilityMode`: show if using “roofVisible || outdoors” logic

### Distortion
Goals:
- Ensure distortion sources are registered and composited in the correct layer

Checks:
- `distortion.manager.exists`
- `distortion.sources.count` (INFO)
- `distortion.applyPass.present`
- `distortion.sourceMasks.present`

### Shadows (Overhead / Building / Canopy)
Goals:
- Ensure the expensive passes are not silently disabled and that cached textures exist when expected

Checks:
- `shadows.overhead.exists/enabled`
- `shadows.building.exists/enabled`
- `shadows.cache.present` (if using cached world-space map)
- `shadows.zoomScaling.valid` (if shadow offset depends on zoom)

### Post Effects (Bloom / Color Correction / ASCII)
Goals:
- Ensure the post chain is non-breaking and effects have correct inputs

Checks:
- `post.chain.activeEffects` (INFO)
- `post.effect.<id>.inputTexture.present`
- `post.effect.<id>.rendersOrPassThrough` (FAIL if neither)
- `post.buffers.precision` (INFO/WARN)

## Implementation Phases
### Phase 1: Planning + Dialog Skeleton
- Create Diagnostic Center dialog and add Tweakpane button
- Implement target tile selection using `canvas.scene.tiles`
- Implement report UI and copy-to-clipboard

### Phase 2: Core Tile Checks
- TileDocument + flags + TileManager sprite checks
- Surface report checks

### Phase 3: Specular Troubleshooting
- Mask discovery checks for `_Specular`
- Effect presence/enabled checks
- Add heuristics + recommended actions

### Phase 4: Expand to Other Effects
- Lighting / fog / weather / distortion diagnostics
- Cross-effect dependency checks

### Phase 5: Layer Coverage Completion
- Implement effect-specific check sets for all currently shipped effects
- Add a “coverage” panel:
  - shows which effects are active
  - shows which effects have tile-scoped diagnostics implemented
  - shows missing diagnostics as TODOs

## Open Questions
- What is the canonical “selected tile” concept in gameplay mode?
  - If selection isn’t already tracked, v1 can rely on explicit selection in the dialog.
- Where is the authoritative asset bundle loader entry point for per-tile mask discovery?
  - `EffectStackUI` uses `loadAssetBundle(basePath, ...)` which may be reused.
- How should we access effect instances (e.g. `SpecularEffect`) reliably?
  - Likely via `window.MapShine.effectComposer` or an effect registry.

- How should we represent layered composition for a tile?
  - Some effects are truly per-tile (tile overlays)
  - Some effects are scene-wide but influenced by tile masks or roof alpha
  - The diagnostics should reflect this distinction explicitly

## Acceptance Criteria (v1)
- User can open Diagnostic Center from Tweakpane.
- User can select a tile and run diagnostics.
- Report clearly indicates mask discovery status for the selected tile (including `_Specular`, `_Outdoors`, etc.).
- Report clearly indicates if tile is bypassing effects or missing Three sprite.
- Report includes at least one non-material layer check (e.g. Lighting or Weather roof/outdoor wiring) even in Tile Mode.
- Report is copyable.
- No significant performance impact when dialog is closed.
