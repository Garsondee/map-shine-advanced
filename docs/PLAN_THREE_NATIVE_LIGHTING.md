# PLAN — Three.js-Native Lighting System (Detached from Foundry Requirements)

## Goal
Build a lighting system that is designed **for MapShine’s Three.js renderer first**, not for Foundry VTT parity.

## Implementation Status (as of 2026-01-12)

### Implemented
- **Foundry light rendering in Three.js**
  - `LightingEffect` renders Foundry `AmbientLight` sources using `ThreeLightSource` and `ThreeDarknessSource`.
  - Hooks are wired (`createAmbientLight`, `updateAmbientLight`, `deleteAmbientLight`, `lightingRefresh`).
- **Dual-source groundwork (Foundry + MapShine enhanced lights)**
  - `LightingEffect` has a `LightRegistry` and a MapShine light ingestion path via `MapShineLightAdapter`.
  - MapShine enhanced lights are rendered using the same `ThreeLightSource`/`ThreeDarknessSource` primitives as an incremental step.
- **Three.js authoring basics (Gameplay Mode)**
  - Three-side selection/drag for light icons in `InteractionManager`.
  - Three-side placement previews for both Foundry lights and MapShine enhanced lights.
- **Enhanced light editor UX (early)**
  - `EnhancedLightInspector` exists (dockable/overlay panel) and is shown when selecting a MapShine enhanced light.
  - `EnhancedLightIconManager` exists and draws a simple in-world gizmo (dim-radius fill + border + icon).

### Partially Implemented
- **Cookies / gobos for MapShine enhanced lights**
  - Schema fields exist (`cookieTexture`, `cookieRotation`, `cookieScale`) and `ThreeLightSource` supports an optional cookie texture.
  - Authoring UX is currently via the inspector (text path + numeric fields), not a curated picker.
- **Layer routing (ground/overhead/both)**
  - `targetLayers` exists in the enhanced light inspector and metadata is stored in `LightingEffect`.
  - Rendering-level behavior is not yet fully enforced across the full scene pipeline.

### Not Yet Implemented (Planned)
- **In-world radial “Ring UI”** (the elegant circular/radial quick-edit UI described below)
- **Transform gizmos (W/E/R style)** for lights (translate/rotate/scale handles)
- **Inner/outer radius draggable rings** (separate from the current visualization ring)
- **Falloff curve editor + baked 1D ramp texture workflow**
- **Advanced light types** (spot, area, decals) and volumetric controls
- **Static light caching** (`Texture_StaticLight`) and invalidation policy

### Current Behavior Note (why you see a dialog)
- **Double-click on a Foundry light icon** currently calls `light.sheet.render(true)` (Foundry’s config sheet/dialog).
- The planned “ring UI” is not hooked up for Foundry lights or enhanced lights yet, so selection shows gizmos/inspector (enhanced) or just selection (foundry), while double-click opens the Foundry sheet.

This means:
- Lighting is **author-authored** (map maker / GM), not derived from Foundry documents.
- Light behavior can be **physically-inspired**, stylized, or hybrid.
- The pipeline can prioritize **cinematic composition**, **PBR material response**, and **performance scaling**.

## Non-goals (Intentionally Dropped Constraints)
- Matching Foundry’s `AmbientLight` / `PointLightSource` semantics 1:1.
- Matching Foundry’s animation registry (`CONFIG.Canvas.lightAnimations`) or its shader set.
- Preserving Foundry’s “LoS polygon per-light” shape model (we may still optionally use wall/occluder data, but we are not forced into their polygon approach).
- Foundry’s blending/compositing semantics as the source of truth.

## Guiding Constraints (Project Reality)
- **Three.js is authoritative for rendering** (no PIXI layering).
- Coordinate rules must remain stable:
  - Foundry world is top-left origin, Y-down.
  - Three world is bottom-left origin, Y-up.
  - Any world-space mask sampling must use `uSceneBounds` with V-flip.
  - Any screen-space pass must treat offsets in **pixels** and convert via `uTexelSize`.
- All time-driven behavior must use the centralized **TimeManager** (`timeInfo.elapsed`, `timeInfo.delta`).

## What Becomes Possible (High-Level Feature Set)

### 1) True “Renderer-Native” Light Types
- **Physically-inspired point / spot lights** with optional inverse-square falloff.
- **Area lights** (rect / disk) for windows, fires, neon panels.
- **IES profiles** (or simplified IES-like radial curves) for believable fixtures.
- **Light cookies / gobos** (projected textures) for stained glass, foliage breakup, patterned lanterns.
- **Decal-lights**: light painted onto surfaces with normal-aware falloff (great for sci-fi panels).
- **Emissive materials that actually light** (coupled to a light injection pass).

### 2) Lighting That Understands Layers (Ground vs Overhead vs Roof)
- **Light linking**:
  - Affect only ground.
  - Affect only overhead.
  - Affect both.
  - Affect particles separately.
- **Roof-aware indoor/outdoor logic**:
  - Use `_Outdoors` (world-space) for semantic indoor/outdoor.
  - Use `roofAlphaTarget` (screen-space) for “roof currently visible” occlusion.
- **Per-layer exposure**:
  - Outdoor moonlight can be dim while indoor candles remain bright.

### 3) Modern Real-Time Lighting Pipelines (Performance Scalable)
- **Forward+ / Clustered lighting** (many lights at low cost).
- **Deferred shading** for the ground plane (and potentially tiles) to support:
  - Hundreds of lights.
  - Light decals/cookies.
  - Screen-space material response.
- **Tile/Token lighting policies**:
  - Keep token rendering simple (unlit/unshaded sprites) OR
  - Add optional “lit token mode” (normal-map + rim light) for premium tiers.

### 4) Global Illumination Options (From Cheap to Fancy)
- **Ambient probes / light probes**:
  - Place probes or auto-generate them on a grid.
  - Interpolate probe lighting for smooth GI-ish fill.
- **Irradiance volumes**:
  - Prebaked or semi-dynamic volume texture.
- **SSGI** (Screen Space Global Illumination) on high tier.
- **Reflective tricks**:
  - Planar reflection for water.
  - Screen-space reflections for wet stone.

### 5) Volumetrics and Atmospherics (Cinematic)
- **Volumetric cones** for spotlights (god-rays).
- **Height fog + light shafts** integrated with weather.
- **Light scattering** modulated by rain density, smoke masks, or fog of war.
- **Shadowed volumetrics** using a cheap shadow mask or signed-distance occlusion.

### 6) Shadows and Occlusion (Multiple Possible Models)
We can choose one of these (or mix by tier):
- **Simple “2D occluder” shadows** (fast):
  - Treat walls/tiles as 2D segments.
  - Compute shadow polygons in screen/world space.
  - Rasterize into a shadow mask buffer.
- **SDF occlusion** (very flexible):
  - Build a distance field from walls/occluders.
  - Raymarch for penumbra-like softness.
- **Baked lightmaps** (map-maker authored):
  - Author paints a lightmap texture.
  - Dynamic lights add on top.
- **Hybrid**:
  - Baked base + dynamic key lights.

### 7) “Lighting as Art Direction” Tools
- **Color grading per-light** (tint shadows, warm highlights).
- **Light temperature** (Kelvin slider) mapped to RGB.
- **Flicker libraries** (torch, candle, neon buzz) not tied to Foundry’s keys.
- **Timeline**:
  - Day/night curves.
  - Lightning bursts.
  - Ritual pulses.
- **Story cues**:
  - “Focus light” that subtly boosts party area.
  - Danger zones that pulse.

## Proposed System Architecture

### A) Data Model (Independent of Foundry)
A MapShine light is a “renderable entity” owned by MapShine:
- **Transform**: position (world), elevation, optional direction.
- **Shape**: point/spot/area/decal.
- **Photometry**: intensity (lumen-ish), range, falloff model.
- **Color**: RGB + temperature.
- **Masking**:
  - optional mask texture
  - optional indoor/outdoor gating
  - optional roof-occlusion participation
- **Layer routing**: ground/overhead/particles.
- **Animation**:
  - parameters + reference to a library function
  - time driven via `TimeManager`

Storage (proposal):
- **Scene flags** for map-maker defaults.
- **GM overrides** in scene flags.
- **Player overrides** client-local (if needed).

### B) Rendering Pipeline Options

#### Option 1: “2.5D Deferred Ground + Forward Sprites” (Recommended)
- Build a **ground GBuffer** (at least: albedo, normal, roughness/spec).
- Run a **lighting pass** that outputs HDR light accumulation.
- Composite:
  - `finalGround = shadePBR(albedo, normal, roughness, lights, ambient)`
  - then render tiles/tokens/overhead
  - post-fx afterwards

Pros:
- Best match for MapShine’s PBR ambitions.
- Many lights scale well.

Cons:
- Requires careful buffer management.

#### Option 2: Clustered Forward for Everything
- Keep single-pass shading, but compute light list per screen cluster.

Pros:
- Simpler buffers.

Cons:
- Harder to integrate custom material layers and stylized composites.

#### Option 3: Hybrid “Lightmap + Dynamic Accents”
- Base lighting from baked textures.
- Add dynamic lights for interactive highlights.

Pros:
- Very fast.

Cons:
- Less dynamic.

### C) Mask + Occlusion Interop (With Existing MapShine Systems)
- **Outdoors**:
  - Sample `_Outdoors` in world space using `uSceneBounds` and V-flip.
- **Roofs**:
  - Use `roofAlphaTarget` in screen space (UV from `gl_FragCoord/uScreenSize`).
- **Wall occlusion**:
  - Optional: build a lightweight occluder representation from Foundry walls.
  - But the lighting model does not depend on Foundry’s LOS polygon system.

### D) Performance Strategy
- Tiered features:
  - **low**: limited light count, no GI, no volumetrics, cheap occlusion
  - **medium**: clustered lights, cookies, simple shadow mask
  - **high**: deferred PBR ground, SSGI/SSR, volumetrics
- Always avoid allocations in hot paths (reuse vectors/textures, pool objects).

## Tooling / UX (What Map Makers & GMs Would Get)

### A) Light Authoring Mode (Three.js-First)
Lighting authoring should feel like a lightweight DCC tool (Blender/Unity/Unreal), but constrained to MapShine’s 2.5D world.

Core interaction goals:
- Creation and editing happens **in the Three canvas**.
- Controls are **spatial**, not form-driven.
- Every adjustable property has:
  - a **direct manipulator** (gizmo/handle), and
  - a **precise numeric input** (inspector panel).

### B) 3D-Oriented Controls (Gizmos + Handles)

#### 1) Transform Gizmo (W/E/R style)
- **Translate**: drag X/Y handles on the ground plane.
- **Rotate**: rotate around Z (for spotlights, projected cookies, and oriented area lights).
- **Scale**: optional (primarily for area lights or decal lights, not for point lights).

Status:
- **Not yet implemented** as a true multi-handle gizmo (W/E/R style).
- **Partially implemented**: basic click-select + drag-move is supported for light icons in `InteractionManager`.

Constraints / modifiers:
- **Shift**: snap (grid, angle increments).
- **Alt**: fine control (reduced sensitivity).
- **Ctrl**: axis lock / constrained movement.

#### 2) Range / Falloff Handles (Arbitrary size editing)
For point + spot lights, a light should expose multiple radius controls, not a single “range”:
- **Outer radius handle**: sets total influence radius.
- **Inner radius handle**: sets full-intensity core radius.

Both are edited via draggable rings in-world:
- Outer ring: larger circle.
- Inner ring: smaller circle.

Status:
- **Partially implemented** for MapShine enhanced lights: there is currently a **visual** dim-radius ring/fill via `EnhancedLightIconManager`.
- **Not yet implemented** as interactive draggable ring handles (outer + inner) for editing.

This supports “increase/decrease size of the falloff” in a way that is:
- spatial (drag ring),
- continuous (no fixed steps unless snapping is enabled),
- and decouples “how far the light reaches” from “how quickly it fades”.

#### 3) Falloff Shape Editor (Nonlinear falloff)
Add a per-light falloff model that can be shaped beyond simple linear/smoothstep:
- **Simple mode**:
  - Falloff curve type: linear / smooth / inverse-square-ish / custom
  - Exponent slider (e.g. 0.5..8)
- **Custom mode**:
  - A small curve editor (1D)
  - Internally bake the curve into a **1D ramp texture** sampled by the lighting shader

This gives map makers true “art-directable” falloff (e.g., tight pools, theatrical rolloff, neon bloom cores).

#### 4) Elevation / Height Handle (Optional)
Even in a 2.5D scene, a Z control is valuable for volumetrics and believable occlusion:
- Drag a vertical handle to set **height above ground**.
- The light’s “contact point” remains on ground (for intuitive placement), but shading can use height.

### C) Light Types & Their Editing Controls

#### 1) Point Light
In-world controls:
- Position gizmo (X/Y).
- Inner/outer radius rings.
- Optional height handle.

Inspector controls:
- Intensity.
- Color + temperature.
- Falloff model.
- Layer routing (ground/overhead/particles).

#### 2) Spot Light
In-world controls:
- Position gizmo.
- **Direction**: rotate handle around Z, plus an on-map “arrow” indicating aim.
- **Cone angle**: adjustable cone ring (angle handle).
- **Penumbra**: inner cone vs outer cone angle (two cone rings).
- Inner/outer range (same as point).
- Optional volumetric cone toggle + intensity.

Inspector controls:
- All point light controls, plus:
  - cone angle / penumbra
  - cookie/gobo texture
  - volumetric parameters (density, anisotropy, noise)

#### 3) Area Light (Rect/Disk)
In-world controls:
- Position + rotation.
- Scale handles to resize width/height.

Inspector controls:
- Softness / spread.
- Optional IES-like profile.

### D) “Nice UI” for Creating/Editing Lights

#### 1) Contextual HUD + Inspector Panel
Two-layer UI tends to feel best:
- **Context HUD (near cursor / near light)**:
  - quick intensity slider
  - quick radius slider
  - color swatch
  - light type dropdown (point/spot/area)
- **Inspector panel (dockable)**:
  - full parameter set with numeric entry
  - presets
  - advanced tabs (falloff curve, cookies, volumetrics, linking)

#### 2) Presets + Library Browser
- Presets should be first-class:
  - torch, candle, fluorescent, neon, window beam, campfire
- Applying a preset should be non-destructive:
  - keep transform, swap photometry/color/animation.

#### 3) Multi-Select and Batch Edit
- Shift-click to multi-select.
- Inspector shows:
  - shared fields (editable),
  - mixed fields (tri-state).

#### 4) Workflow Features (Quality of Life)
- Duplicate / copy-paste lights.
- Undo/redo for transforms and parameter edits.
- Snapping toggles:
  - grid snap
  - angle snap
  - radius snap (optional)
- Solo/mute selected lights for debugging.

#### 5) In-World Radial “Ring UI” (No Separate Dialog)
In addition to a dockable inspector, lights can expose a **radial ring UI** that is anchored around the light in-world (projected to screen space). This is meant to optimize “quick tweaks” while staying in flow.

Status:
- **Not yet implemented**. There is currently no world-anchored DOM ring or Three-rendered radial wedge UI.
- Current UX for editing is:
  - **Foundry lights**: double-click opens the Foundry light config sheet.
  - **MapShine enhanced lights**: selecting shows `EnhancedLightInspector` (dockable overlay panel) + a simple in-world radius visualization.

Design goals:
- **0-click visibility**: click/select a light and the ring appears.
- **1-gesture edits**: most common edits are drag-based and don’t require typing.
- **Minimal screen clutter**: ring fades out when not hovering/selected.

##### Ring Layout (Suggested Defaults)
Treat the ring as 6–10 “wedges” (segments) with small icons + labels. Suggested core wedges:
- **Intensity**: drag up/down (or clockwise/counterclockwise) to adjust.
- **Radius**: drag to change outer radius; secondary modifier adjusts inner radius.
- **Color**: tap to open a compact palette ring; or drag along a hue wheel.
- **Falloff**: cycle falloff type (linear/smooth/inverse-square-ish/custom) and a quick exponent slider.
- **Animation**: dropdown/picker for animation type + a small speed/intensity control.
- **Type**: point / spot / area toggle (with safe conversion behavior).

Optional wedges (if room / advanced mode enabled):
- **Cone** (spot only): angle + penumbra quick edit.
- **Height**: drag to adjust Z height (or “lift” above ground) for volumetrics.
- **Layer routing**: ground / overhead / particles toggles.
- **Solo/Mute**: isolate selected lights for debugging.

##### Control Behaviors (Fast + Precise)
- **Drag-to-edit**:
  - Dragging a wedge modifies its parameter continuously.
  - Use **Alt** for fine adjustments.
  - Use **Shift** to snap (grid/radius/angle).
- **Tap-to-toggle**:
  - Tap wedges for toggles (solo/mute, layer routing, enable).
- **Tap-and-hold**:
  - Opens a micro-popup next to the ring for numeric entry (optional).

##### Animation Picker UX
We want an animation selector that is fast but not a big modal dialog.

Two good patterns:
- **Radial submenu**:
  - Tap the Animation wedge to open a secondary ring listing animation types.
  - Each option shows a tiny preview glyph (e.g. wave rings, flame flicker).
- **Inline dropdown**:
  - Tap Animation wedge to open a small dropdown list anchored to the ring.

Animation parameters for the ring:
- **Type**: none / torch / candle / neon buzz / pulse / siren / etc.
- **Speed**: compact slider.
- **Intensity**: compact slider.
- **Color shift** toggle (if supported by that animation).

##### Presets (In-Ring)
Add a **preset chip** at the top of the ring (e.g. “Torch”, “Neon”, “Window Beam”, “Custom”).
- Tap to cycle presets.
- Long-press to open the preset list.
- Applying presets should keep transform and only change photometry/color/animation unless user explicitly chooses “Replace Everything”.

##### Multi-Light Editing
When multiple lights are selected:
- The ring attaches to the **selection centroid**.
- Wedges apply edits to all selected lights.
- Mixed values display as “—” and become concrete once you drag.

##### Visual Language
- Ring should be **world-anchored but screen-legible**:
  - project light world position to screen
  - clamp ring to screen edges
  - scale slightly with zoom (but keep readable)
- Use **immediate feedback**:
  - show numeric readout near the cursor while dragging (e.g. “Radius: 1240px”).
  - show a small tooltip label on hover.

##### Safety / Misclick Prevention
- Ring should not steal camera controls unless actively dragging a wedge.
- Drag threshold to distinguish click vs drag.
- ESC closes ring / cancels the current drag edit.

##### Accessibility & Keyboard Shortcuts
- Keyboard nudges for selected wedge:
  - arrows adjust current parameter
  - Shift = coarse
  - Alt = fine
- Consider a high-contrast mode and larger hit targets for wedges.

### E) Debug Views
- light complexity heatmap
- show clusters
- show occlusion mask
- show indoor/outdoor factor

### F) Bake Tools (Optional Future)
- bake probes
- bake lightmap

## Compatibility Notes
If we go fully native:
- Foundry lights become either:
  - ignored, or
  - an optional “import” source that creates equivalent MapShine lights.
- MapShine lights should never require Foundry to compute LOS polygons.

## Dual Support Requirement: Foundry Lights + Enhanced Three Lights
We want **both**:
- **Foundry default lights** (so the module remains compatible with core workflows and other modules).
- **Enhanced MapShine lights** (new features: spot/area/cookies/custom falloff/volumetrics/etc).

This implies a dual-source system where **both kinds of lights feed a single renderer**, and the editor UI can target either type.

### A) Unifying Concept: `ILightEntity`
Define an internal interface (conceptually; not necessarily TypeScript) that represents the minimum needed to render a light:
- identity: `id`, `sourceType` (`foundry` | `mapshine`)
- transform: world position (+ optional direction + height)
- type: point / spot / area / decal
- photometry: intensity, inner/outer radius, falloff model
- color: rgb + temperature
- animation: type, speed, intensity, flags
- routing: which layers it affects (ground/overhead/particles)
- extras: cookie texture, volumetric params (optional)

Future-proofing fields we should support immediately:
- z-range: `zMin?`, `zMax?` (token/Levels compatibility)
- performance: `isStatic` (eligible for cached static light buffer)
- gameplay: `activationRange?` (0 = always on)
- shadows: `castShadows` (default false), `shadowQuality?` (`hard` | `soft`)
- environment response: a way to express intensity driven by scene conditions (see Sun Light below)

The renderer only cares about `ILightEntity`.

#### `ILightEntity` Additions (Schema Sketch)
Conceptually:

```ts
interface ILightEntity {
  // ... existing fields ...

  // For Token/Levels compatibility
  zMin?: number;
  zMax?: number;

  // For Performance
  isStatic: boolean;

  // For Gameplay
  activationRange?: number; // 0 = always on

  // For 2.5D Shadows
  castShadows: boolean; // Defaults to false
  shadowQuality?: 'hard' | 'soft';
}
```

Notes:
- `isStatic` is not “baked” by itself; it is an eligibility flag for caching and (later) baking.
- `activationRange` is intended for cheap culling / gameplay gating (e.g., proximity lights).
- `zMin/zMax` is intended as a coarse compatibility feature for Levels-like behavior, not full 3D occlusion.

#### Static Light Contribution Caching (Pre-Bake, Immediate Win)
Even before true “baked textures”, we can treat static lights as a separate cached contribution.

High-level strategy:
- Maintain a `Texture_StaticLight` render target.
- Maintain a dirty flag (or version counter) for when static lights need to be re-rendered.

Frame behavior:
- **Frame N** (only when dirty):
  - Render all `ILightEntity` with `isStatic === true` into `Texture_StaticLight`.
- **Frame N+1** (every frame):
  - Composite `Texture_StaticLight` + dynamic light accumulation into the main light buffer.

Static cache invalidation events (examples):
- Any static light changes (transform, intensity, color, radius, cookie, falloff, animation state if applicable)
- Any change in masks/occlusion inputs that affect lighting (roof alpha / outdoors mask / wall occlusion mode)
- Renderer resize / quality tier switch

Policy detail:
- If a light is `isStatic === true`, its animation should default to `none`.
- If a user enables animation on a static light, either:
  - automatically flip `isStatic` off, or
  - treat it as “static except animation” (usually not worth the complexity).

### B) Data Sources

#### 1) Foundry Light Adapter (Existing)
Use Foundry documents and hooks as a source of `ILightEntity`:
- `Hooks.on('createAmbientLight'|'updateAmbientLight'|'deleteAmbientLight')`
- Current implementation already mirrors this into `LightingEffect.lights` via `ThreeLightSource`.

For the dual system, this becomes:
- **FoundryLightAdapter**: converts an `AmbientLightDocument` into an `ILightEntity`.
- Renderer consumes those entities in the same way it consumes MapShine lights.

Important note:
- Foundry lights have an existing notion of bright/dim radius, attenuation, color, animations.
- Foundry lights may rely on LOS polygons; we can continue using them when available, but the unified renderer should not depend on them.

#### 2) MapShine Enhanced Light Source (New)
Enhanced lights are stored and owned by MapShine:
- Stored in **scene flags** (map-maker defaults + GM overrides).
- Optional player-local overrides (client settings) if needed.

This becomes:
- **MapShineLightAdapter**: loads the scene flag objects and emits `ILightEntity`.
- Hooks:
  - on scene flag change, rebuild light entity list
  - on scene change (`canvasReady`), reload

### C) Renderer Integration Strategy (Single Pipeline)
We should avoid maintaining two separate render paths.

Proposed approach:
- `LightingEffect` owns a single `LightRegistry`.
- `LightRegistry` holds:
  - `foundryLights: Map<id, ILightEntity>`
  - `enhancedLights: Map<id, ILightEntity>`
- Each frame:
  - gather visible lights
  - render them through the same accumulation / shading pipeline

### D) Editing & UI Routing (What Happens When You Click)
The in-world UI must know which system it is editing.

Status:
- **Partially implemented**:
  - Selection differentiates Foundry light icons (`lightId`) vs MapShine enhanced light icons (`enhancedLightId`).
  - Enhanced lights show the `EnhancedLightInspector` on selection.
  - Foundry lights currently rely on Foundry’s sheet on double-click.

Selection rules:
- If you select a light icon/handle, store:
  - `selectedLightId`
  - `selectedLightSourceType` (`foundry` | `mapshine`)

Edit rules:
- If `sourceType === 'foundry'`:
  - UI edits are applied by updating the Foundry `AmbientLightDocument`.
  - This preserves module compatibility.
- If `sourceType === 'mapshine'`:
  - UI edits update MapShine’s scene flags.

### E) Conflict / Precedence Rules
We need clear rules when both systems overlap.

Recommended default policy:
- Foundry lights render normally.
- Enhanced lights render normally.
- If an enhanced light is explicitly “linked” to a Foundry light (import/upgrade), then:
  - **either** hide the Foundry light contribution (so we don’t double-light),
  - **or** keep Foundry as a fallback but disable it when enhanced is enabled.

This requires an explicit linkage field on the enhanced light:
- `linkedFoundryLightId?: string`
- `overrideFoundry: boolean`

### F) “Upgrade / Enhance” Workflow (Key UX Feature)
To avoid forcing users to recreate lights:
- Allow selecting a Foundry light and choosing:
  - **Enhance this Light** → creates an enhanced light seeded from the Foundry parameters.
  - Optionally sets `overrideFoundry = true`.

Reverse flow:
- “Bake down to Foundry” (optional): attempt to approximate enhanced light as a Foundry light (only for features Foundry supports).

### G) Permissions & Multiplayer
- Editing Foundry lights should continue to use Foundry’s permission checks.
- Editing MapShine enhanced lights should follow the same permission model as other MapShine scene-flag editing:
  - GM-only by default.
  - Optional map-maker role support.

### H) Animation System Expansion (Foundry Parity + Custom Animations)
We want all Foundry animation types for familiarity, but we should not constrain the enhanced system to Foundry’s set.

Plan:
- Keep `animation.type` supporting Foundry names for direct parity.
- Add `animation.type = 'custom'` with a `customId` that references a library entry.
- Custom animations should be composable (not hardcoded one-off strings) so we can support:
  - intensity flicker / pulses
  - subtle hue drift / temperature changes
  - positional jitter / orbiting / noise-driven motion
  - spotlight aim wobble
  - response to nearby tokens (proximity brighten/dim)
  - response to weather or other MapShine systems

Implementation direction (design-level):
- Define a small “animation graph” model (nodes like `noise`, `curve`, `pulse`, `ease`, `sampleTokenDistance`, `sampleDarkness`, `mix`).
- Each light evaluates its animation using a shared time source (e.g., TimeManager) and scene state samplers.
- Keep the output minimal: typically a multiplier for intensity + optional color shift + optional transform offsets.

### I) Sun Light (Darkness-Driven Intensity)
Critical feature: a light type/category whose intensity is driven by the scene’s darkness.

Use case:
- A “Sun Light” that floods into doorways/windows only when the scene is bright outdoors.

Behavior:
- Add an environment-driven intensity term such as:
  - `intensity = baseIntensity * f(sceneDarkness)`
- Where `f(sceneDarkness)` is typically:
  - `1.0` at daytime (`darkness ~ 0`)
  - `0.0` at night (`darkness ~ 1`)
  - optionally with a curve/exponent and a threshold.

Authoring UX:
- In the light creation menu, provide a dedicated category:
  - “Sun Light” preset type with sensible defaults (directional-ish look, soft falloff, wide cone for spot).
- Inspector controls for this category:
  - enable/disable darkness-driven intensity
  - response curve (linear / smooth / custom)
  - min/max clamp
  - optional outdoor-only gating (pairs naturally with the `_Outdoors` mask)


## Milestone Plan (Phased)

### Phase 0 — Prototype Direction (1-2 days)
- Decide pipeline option (recommended: deferred ground + forward sprites).
- Define minimal light schema.

### Phase 1 — Core Light Manager (1-2 weeks)
- Light entity model + serialization (scene flags).
- Basic point lights + simple falloff.
- HDR accumulation buffer and composite integration.

### Phase 2 — Authoring Tools (1-2 weeks)
- Add Three-based placement/editing mode.
- Presets + UI.
- Debug overlays.

### Phase 3 — Occlusion + Roof/Outdoors Integration (1-3 weeks)
- Indoor/outdoor gating using `_Outdoors`.
- Roof visibility/occlusion using `roofAlphaTarget`.
- One occlusion model (shadow mask or SDF), gated by tier.

### Phase 4 — PBR Integration & Advanced Lights (2-4 weeks)
- Deferred ground shading path.
- Area lights + cookies.
- Light linking to layers.

### Phase 5 — Cinematic Upgrades (Ongoing)
- Volumetrics.
- Probes / GI.
- SSR/SSGI (high tier).
- Bake workflows.

## Open Decisions
- Should the “native” lights be purely artistic (non-physical units) or use physical-ish units?
- Do we want dynamic occlusion from walls as a default, or keep it optional to avoid complexity?
- How tightly should lights integrate with the PBR material system (specular/roughness/normal), especially for tiles/tokens?
