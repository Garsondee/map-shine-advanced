# Module-Wide Depth Pass Plan

## Status
- Date: 2026-02-16
- Owner: Rendering / Effects
- Scope: Introduce a centralized depth pipeline used by all tile/surface/effect masking decisions.

---

## 1) Problem Statement

Current masking and layering for some effects (notably tile specular overlays) rely on per-effect mesh ordering and local depth logic.

This causes fragile behavior in edge cases:
1. Multiple overlapping rotating/translating tiles.
2. Mixed tile stacks where only some tiles have effect masks.
3. Coplanar/equal-depth precision cases where pass-local ordering disagrees with visual intent.

The current approach is increasingly hard to reason about and debug because each effect solves occlusion independently.

---

## 2) Goal

Build a **single authoritative depth representation** per frame (or per invalidation event) that every effect can consume.

Primary outcomes:
1. Deterministic occlusion/masking for stacked tiles regardless of rotation/animation.
2. Consistent behavior across effects (specular, fluid, shadows, weather masking, future effects).
3. Reduced effect-specific layering hacks (per-effect z-lift tuning, tie-break duplication).
4. Better diagnostics (visualize one depth truth instead of many local approximations).

---

## 3) Non-Goals (Phase 1)

1. Do not redesign the entire render graph in one step.
2. Do not migrate every effect at once.
3. Do not attempt perfect per-pixel parity with all Foundry PIXI internals in first rollout.
4. Do not introduce workerized rendering changes in this phase.

---

## 4) Architectural Direction

### 4.1 New Runtime Component
Create a new manager/effect-layer component:
- `scripts/scene/depth-pass-manager.js` (or `scripts/effects/DepthPassEffect.js`)

Responsibilities:
1. Render scene occluders into dedicated depth targets.
2. Expose depth textures + metadata through a stable API.
3. Invalidate/rebuild on topology/transform/material changes.
4. Provide debug views and counters.

### 4.2 Core Depth Targets

Use at least two depth products:
1. **World Depth** (main geometry depth from current camera).
2. **Tile Occlusion Depth** (optional focused depth prepass for tile-driven masking).

Optional extensions (later):
- Layer-filtered depth (ground-only / overhead-only / roof-only).
- Min/max depth pyramid for fast queries.

### 4.3 Central API

Expose via `window.MapShine.depthPassManager` and composer wiring:
- `getDepthTexture(kind)`
- `getDepthParams(kind)` (near/far, projection type, texel size, resolution)
- `requestInvalidate(reason)`
- `setDebugMode(mode)`

---

## 5) Data & Coordinate Contract

Depth pass must define one strict contract for all consumers.

### 5.1 Coordinate conventions
- Foundry documents: top-left origin, Y-down.
- Three world: bottom-left, Y-up.
- Use existing conversion utilities (`Coordinates.toWorld` / `Coordinates.toFoundry`) for CPU-side placement.

### 5.2 Sampling conventions
- World-space sampled depth consumers must use shared scene bounds uniforms.
- Screen-space post effects must sample in screen UV consistently.
- Avoid mixing world-space and screen-space depth logic in one shader path unless explicitly reconstructed.

### 5.3 Depth decode
- Standardize perspective/orthographic depth decode helpers in one shared shader chunk.
- All consumers use the same linearization path to avoid subtle disagreement.

---

## 6) Render Pipeline Integration

## 6.1 Proposed order (high level)
1. Build/update depth targets (prepass or shared pass).
2. Render base scene color.
3. Run effects that consume depth for masking/occlusion.
4. Post-processing.

## 6.2 Incremental rollout mode
To minimize risk, start with:
- Existing color path unchanged.
- Depth pass generated in parallel.
- One consumer migrated first (SpecularEffect tile overlays).

---

## 7) First Consumer: SpecularEffect Tile Occlusion

### 7.1 Current weakness
Specular tile occlusion currently depends on local overlay depth behavior and pass ordering.

### 7.2 Migration target
Replace local overlap assumptions with depth-pass-driven mask decision:
1. Sample authoritative tile/world depth at fragment.
2. Compare fragment depth against occluder depth with epsilon policy.
3. Discard/attenuate specular where blocked.

### 7.3 Expected result
- Rotating/translating stacks follow one depth truth.
- Top tile occludes lower specular deterministically.
- Reduced need for per-effect z-lift heuristics.

---

## 8) Invalidation & Performance Strategy

### 8.1 Invalidation triggers
Depth pass invalidates on:
1. Tile transform/material/visibility updates.
2. Tile animation step updates.
3. Token transform changes (if included in pass).
4. Camera projection/resolution changes.
5. Layer membership changes.

### 8.2 Optimization strategy
1. Rebuild only when invalidated.
2. Optional partial redraw regions (future).
3. Resolution scaling controls (full/half for non-critical consumers).
4. Reuse render targets and avoid per-frame allocation.

### 8.3 Diagnostics
Track:
- Depth pass build count/frame.
- Build time ms.
- Invalidations by reason.
- Consumer sample counts (optional).

---

## 9) Debug Tooling

Add debug modes in control/diagnostic UI:
1. Depth grayscale visualization.
2. Linearized depth heatmap.
3. Occlusion mask preview for selected effect.
4. Per-tile depth rank overlays (id/sort/elevation).

These are required for validating stacked tile edge cases.

---

## 10) Implementation Plan (Phased)

## Phase 0 - Research/Contract (short)
1. Finalize depth texture format and decode contract.
2. Decide manager placement (`scene/` vs `effects/`).
3. Define invalidation hooks and API shape.

Deliverable:
- Depth contract section added to internal rendering docs.

## Phase 1 - Core Depth Manager
1. Create DepthPass manager with render target lifecycle.
2. Wire into `canvas-replacement.js` and `EffectComposer` update order.
3. Add invalidation hooks from TileManager/TokenManager/camera sync.

Deliverable:
- Stable depth target output + debug visualization.

## Phase 2 - Specular Migration
1. Update `SpecularEffect` to sample depth pass for tile occlusion.
2. Keep fallback path behind feature flag.
3. Remove/disable fragile local-only masking path once validated.

Deliverable:
- Specular overlap cases pass regression suite.

## Phase 3 - Additional Consumers
Potential next consumers:
1. Fluid/tile overlays.
2. Overhead/roof shadow gating.
3. Weather particle occlusion variants.

Deliverable:
- Unified depth consumer utility code and reduced duplicate logic.

## Phase 4 - Cleanup
1. Remove obsolete z-lift/order workarounds that depth pass supersedes.
2. Consolidate shared shader helpers.
3. Final perf tuning.

---

## 11) Risk Register

1. **Performance regression** from extra pass.
   - Mitigation: invalidation-based updates, resolution controls, profiling gates.

2. **Depth precision artifacts** (especially perspective + large ranges).
   - Mitigation: standardized linearization and epsilon policy; clamp near/far strategy.

3. **Pipeline ordering regressions** in existing effects.
   - Mitigation: feature flag + per-effect migration + A/B debug mode.

4. **Coordinate mismatch bugs** between world/screen sampling.
   - Mitigation: single contract and shared helper functions.

---

## 12) Acceptance Criteria

1. In scenes with overlapping rotating/translating tiles, lower-tile specular does not leak through top tiles when blocked visually.
2. Deterministic behavior across repeated runs (no frame-to-frame ordering flicker).
3. No major frame-time regression on representative scenes (target: <= 1.5 ms median overhead on baseline GPU tier for depth rebuild frames; near-zero on non-invalidated frames).
4. Debug depth/occlusion views clearly reflect masking decisions.

---

## 13) Proposed File Touch Map (Initial)

1. `scripts/scene/depth-pass-manager.js` (new)
2. `scripts/foundry/canvas-replacement.js` (wiring)
3. `scripts/effects/EffectComposer.js` (lifecycle/exposure)
4. `scripts/effects/SpecularEffect.js` (first consumer migration)
5. `scripts/scene/tile-manager.js` (invalidation hooks)
6. `scripts/ui/diagnostic-center-dialog.js` (debug view controls)

---

## 14) Recommended Next Action

Start Phase 0 + Phase 1 skeleton behind a feature flag:
- `map-shine-advanced.experimentalDepthPass`

Then migrate SpecularEffect as the first hard target to solve current overlap masking failures and validate the architecture before broader adoption.

---

## 15) Deep Research Addendum (Current Code Reality)

This section documents what the codebase is doing today so the depth-pass design fits the real pipeline.

### 15.1 EffectComposer realities

1. The main scene is rendered once into `sceneRenderTarget` when post-processing is active.
2. That target currently has `depthBuffer: true` but does **not** expose a shared `DepthTexture` for effect sampling.
3. Post FX consume color via `setInputTexture()` / `setBuffers()` only.
4. `getRenderTarget(...)` defaults to color targets (float RGBA), with optional depth buffer, but no standard depth contract.

Implication: we already have the right orchestration point (`EffectComposer`) but no stable API surface for depth consumers.

### 15.2 Existing mask ecosystem we should align with

`MaskManager` is already acting as a shared texture registry (`setTexture`, `getTexture`, metadata for `space`, `channels`, `lifecycle`, dimensions).

Multiple effects already publish dynamic screen-space products:
- `roofAlpha.screen`
- `weatherRoofAlpha.screen`
- `outdoors.screen`
- `ropeMask.screen`
- `tokenMask.screen`

Implication: depth should be published in the same way (not as a one-off private texture), so existing effect patterns can consume it with minimal friction.

### 15.3 Camera + coordinate invariants (must be honored)

1. Scene camera is `PerspectiveCamera` with fixed camera height and FOV-based zoom (`currentZoom` is authoritative).
2. Base plane uses `flipY=false` texture path plus `scale.y=-1`, so UV orientation and screen-space orientation are not interchangeable.
3. World-space scene bounds must use `sceneRect` semantics (exclude padded region) when reconstructing UVs.

Implication: depth decode helpers must include the same coordinate/zoom assumptions used by current screen-space effects and frame-state reconstruction.

### 15.4 Layer/depth behavior of major systems today

1. **Specular tile overlays** currently run their own depth logic (occluder + additive pass, EqualDepth usage, deterministic renderOrder bands, depth-lift).
2. **Tokens** intentionally render with `depthTest=false` / `depthWrite=false` in main pipeline behavior, while token masking is supplied separately (`tokenMask.screen`).
3. **Overhead/roof behaviors** are heavily screen-mask driven (`roofAlphaTarget`, outdoors masks) rather than generalized depth.
4. **Distortion and weather** also rely on mask products and custom occluder passes.

Implication: depth pass rollout must be incremental and coexist with current mask-driven architecture, not replace everything at once.

### 15.5 Why current local-depth techniques are fragile

Current per-effect solutions break composability:
- Same visual truth is recreated differently in each effect.
- Equal-depth/coplanar handling requires local hacks (z-lifts, custom ordering bands).
- New effects have no shared depth contract to plug into.

The centralized depth pass solves this by moving from "each effect invents occlusion" to "effects consume a shared geometric truth".

---

## 16) Depth Products to Build (Authoritative Set)

To keep this practical, define explicit products instead of one vague "depth texture".

### 16.1 `depth.screen.device`

- Type: hardware depth (non-linear), camera-relative, screen-space.
- Resolution: renderer drawing buffer resolution.
- Lifecycle: dynamic per frame (or per render).
- Primary consumers: advanced post FX that want raw device depth and do their own decode.

### 16.2 `depth.screen.linear`

- Type: linearized eye/view depth in a sampleable texture.
- Space: screen UV.
- Resolution: full (optionally half in degraded mode).
- Primary consumers: post FX and screen-space compositors (outlines, fog blend, depth fades).

### 16.3 `depth.screen.layers.<name>` (optional extension)

Layer-filtered depth variants for targeted consumers:
- `depth.screen.layers.tiles`
- `depth.screen.layers.roofs`
- `depth.screen.layers.tokens` (if/when tokens participate)

These are not Phase 1 requirements, but the API should reserve the naming convention now.

### 16.4 `depth.scene.linear` (optional extension)

Scene-UV/world-projected linear depth (map-space).

Useful for world-space shaders that do not want per-frame screen reprojection. Can be introduced after the screen-depth contract is stable.

---

## 17) Central Depth API (Runtime + Plugin Contract)

Depth must be consumable by core effects and external plugins.

### 17.1 Runtime manager interface

```js
window.MapShine.depthPassManager = {
  // lifecycle
  initialize(renderer, scene, camera, effectComposer),
  dispose(),

  // per-frame invalidation
  requestInvalidate(reason),
  markTopologyDirty(reason),
  markViewDirty(reason),

  // primary fetch API
  getDepthTexture(kind),                 // e.g. 'screen.linear'
  getDepthRecord(kind),                  // texture + metadata + revision
  getDepthParams(kind),                  // near/far/texelSize/resolution/projection
  getFrameContext(),                     // bundle of all active depth products

  // optional contribution system
  registerContributor(contributor),
  unregisterContributor(id),

  // diagnostics
  getStats(),
  setDebugMode(mode)
};
```

### 17.2 Data contract for `getDepthRecord(kind)`

```ts
type DepthRecord = {
  kind: string;                         // 'screen.linear'
  texture: THREE.Texture | null;
  width: number;
  height: number;
  space: 'screenUv' | 'sceneUv';
  encoding: 'device' | 'linearEye' | 'linear01';
  projection: 'perspective' | 'orthographic';
  near: number;
  far: number;
  texelSize: [number, number];
  sceneBounds?: [number, number, number, number];
  viewBounds?: [number, number, number, number];
  revision: number;
  frameId: number;
  source: 'depthPassManager';
};
```

### 17.3 Consumer helper API (to reduce copy/paste shader code)

Provide shared helpers under one module/chunk:

`scripts/effects/shader-chunks/depth.glsl.js`

Functions:
1. `msDecodeLinearDepth(...)`
2. `msDecodeViewZ(...)`
3. `msScreenUvToWorldXY(...)` (uses view bounds)
4. `msFoundryYFromWorldY(...)`
5. `msDepthCompareWithEpsilon(...)`

This avoids each effect writing slightly different depth math.

### 17.4 Contributor API (plugin-friendly)

Allow modules/effects to contribute custom occluders without editing core depth manager:

```ts
type DepthContributor = {
  id: string;
  enabled: () => boolean;
  getObjects: () => THREE.Object3D[];
  getMode?: () => 'default' | 'depthOnly' | 'customMaterial';
  getPriority?: () => number;
};
```

Use this sparingly in Phase 1, but lock the shape early so other systems can plug in later.

---

## 18) Consumer Matrix (Who uses depth and how)

### 18.1 Immediate target (Phase 2)

1. **SpecularEffect tile occlusion**
   - Replace local EqualDepth + lift assumptions with depth compare against `depth.screen.linear`.
   - Keep existing path as fallback behind feature flag.

### 18.2 High-value near-term consumers

2. **DistortionManager**
   - Replace some bespoke occluder logic with depth-aware attenuation where applicable.
3. **Water/shoreline distortion blending**
   - Use depth for contact attenuation near overhangs.
4. **OverheadShadowsEffect / BuildingShadowsEffect composition gates**
   - Depth-informed receiver validity and anti-leak gating in ambiguous overlaps.

### 18.3 Medium-term consumers

5. **Weather precipitation occlusion variants**
   - Optional depth-correct clipping for precipitation under occluders.
6. **Selection / detection / outline effects**
   - Robust edge detection from depth discontinuities.
7. **Future AO/contact shadows**
   - Screen-space AO-lite using linear depth.

### 18.4 Systems that should remain mask-driven (for now)

Do not force migration where masks are semantically stronger:
- outdoors/indoors classification (`_Outdoors`)
- roof visibility alpha policies
- gameplay visibility/fog semantics

Depth complements these masks; it does not replace semantic masks.

---

## 19) Integration Blueprint (Concrete)

### 19.1 New file(s)

1. `scripts/scene/depth-pass-manager.js` (core manager)
2. `scripts/effects/shader-chunks/depth.glsl.js` (shared shader helpers)

### 19.2 Wiring points

1. `canvas-replacement.js`
   - instantiate manager
   - expose `window.MapShine.depthPassManager`
   - dispose on teardown
2. `EffectComposer.js`
   - call depth manager update at deterministic point before main scene render and/or immediately after scene render depending on chosen mode
   - expose frame depth context to effects
3. `tile-manager.js`, `token-manager.js`, `tile-motion-manager.js`
   - call `requestInvalidate(...)` on relevant transform/topology changes

### 19.3 Publication through MaskManager (recommended)

Publish depth products like other dynamic shared textures:
- `depth.screen.linear`
- `depth.screen.device` (if sampleable)

Metadata example:
- `space: 'screenUv'`
- `source: 'depthPassManager'`
- `channels: 'r'` (for packed linear depth)
- `lifecycle: 'dynamicPerFrame'`

This immediately makes depth discoverable by existing effect patterns.

---

## 20) Capture Strategy: WebGL2 Preferred + Universal Fallback

### 20.1 Preferred path (WebGL2)

1. Attach/sample `DepthTexture` from the scene target where supported.
2. Provide decode helpers for device depth.
3. Optionally blit to linear depth texture for simpler consumers.

### 20.2 Universal fallback path (works across tiers)

1. Render depth-only prepass into color RT (R channel = linear depth).
2. Use override material or dedicated depth material variant.
3. Keep output format simple and sample-friendly (`RGBA`/`R` depending on capability).

### 20.3 Why both paths matter

The module targets multiple renderer capability tiers. A single-path implementation risks fragile behavior on lower tiers. The manager should internally choose the best strategy and keep one stable external API.

---

## 21) Occluder Inclusion Policy (Critical for correctness)

Depth truth depends on what writes into it.

### 21.1 Phase 1 inclusion

Include:
1. Base plane / map geometry
2. Tile sprites that visually occlude
3. Tile-attached overlays that must participate in geometric occlusion (as needed)

Exclude by default:
1. Overlay/UI-only meshes (overlay layer)
2. Pure additive post visuals that should not occlude
3. Debug meshes

### 21.2 Token policy

Tokens are currently mask-driven for some post behaviors. Introduce token depth participation as an explicit toggle/phase, not implicit behavior change.

---

## 22) Invalidation Model (Refined)

### 22.1 Separate reasons

`view` (camera/zoom/resolution)
`topology` (tile add/remove/layer membership)
`transform` (tile motion/transform updates)
`material` (alpha/depthWrite policy changes)
`force` (debug/manual)

### 22.2 Rebuild rules

1. `screen.*` depth products usually rebuild per render (view-dependent).
2. Extra layer-specific products may rebuild only when their producer set changes.
3. Degraded mode can reuse prior frame for non-critical consumers under load.

---

## 23) Debugging and Validation Tooling (Expanded)

Add to Diagnostic Center:

1. **Depth Visualizer**
   - raw device depth
   - linear depth heatmap
2. **Consumer Inspector**
   - pick pixel and show: sampled depth, reconstructed world XY, occluder decision, epsilon used
3. **Contributor Inspector**
   - show which objects/layers wrote to depth this frame
4. **Invalidation Timeline**
   - reasons and rebuild counts over time

This turns depth debugging from guesswork into observable state.

---

## 24) Performance Plan and Budgets (Expanded)

### 24.1 Targets

1. Depth build overhead on rebuild frames: target <= 1.5 ms median baseline tier.
2. Non-rebuild overhead: near-zero.
3. No sustained shader compile stutter after warmup.

### 24.2 Controls

1. Quality modes: full / half / quarter for non-critical consumers.
2. Consumer opt-in sampling frequency (every frame vs every N frames).
3. Dynamic degrade under frame pressure.

### 24.3 Instrumentation

Track per-frame:
- depth pass time
- texture resolution used
- number of contributors
- number of consumer samples (if available)
- degraded mode activation count

---

## 25) Test Plan (Regression-Focused)

### 25.1 Deterministic scene fixtures

1. Multi-overlap rotating tile stack (the primary specular leak repro).
2. Mixed masked/unmasked tile stack.
3. Overhead fade + tile motion + specular overlays simultaneously.
4. Large scene with many tiles to stress depth pass overhead.

### 25.2 Assertions

1. No lower-layer specular leak when top tile visually blocks.
2. No frame-to-frame flicker in identical camera/scene states.
3. Consumer output remains stable under resize/zoom.
4. Fallback path parity is acceptable (documented tolerances).

### 25.3 Tooling

Capture A/B screenshots with feature flag on/off and include depth visualizer snapshots in bug reports.

---

## 26) Migration Playbook (How to avoid risky big-bang)

1. Add manager + API + debug views first (no behavior changes).
2. Migrate one consumer (SpecularEffect) behind feature flag.
3. Validate on fixture scenes and real maps.
4. Migrate next consumer only after prior one is stable.
5. Remove obsolete local depth hacks only after parity passes.

---

## 27) Proposed Extended File Touch Map

1. `scripts/scene/depth-pass-manager.js` (new)
2. `scripts/effects/shader-chunks/depth.glsl.js` (new)
3. `scripts/effects/EffectComposer.js` (depth context plumbing)
4. `scripts/foundry/canvas-replacement.js` (manager lifecycle + global exposure)
5. `scripts/masks/MaskManager.js` (optional: publish depth records as standard masks)
6. `scripts/effects/SpecularEffect.js` (first migrated consumer)
7. `scripts/scene/tile-manager.js` (invalidation hooks)
8. `scripts/scene/token-manager.js` (optional invalidation hooks)
9. `scripts/scene/tile-motion-manager.js` (transform invalidation)
10. `scripts/ui/diagnostic-center-dialog.js` (depth debug UI)

---

## 28) Recommended Immediate Next Steps (Updated)

1. Keep feature flag: `map-shine-advanced.experimentalDepthPass`.
2. Implement Phase 1 manager skeleton with API + stats + debug visualization.
3. Publish `depth.screen.linear` via shared manager contract.
4. Integrate one consumer (SpecularEffect) with fallback path retained.
5. Run fixture-scene validation before any second consumer migration.

This preserves delivery safety while finally giving the module a reusable depth API that future effects and plugins can consume without reimplementing occlusion logic.
