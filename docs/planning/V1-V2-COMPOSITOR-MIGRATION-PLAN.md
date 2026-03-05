# V1 → V2 Compositor Migration Plan

## Date: 2026-03-02

---

## 1. The Nightmare — What's Actually Happening

We have **two complete rendering pipelines** running in the same codebase, gated by a single boolean setting (`useCompositorV2`). The V2 compositor is the future — it's the only path that supports Levels/Floors correctly — but the V1 pipeline is still present in its entirety: ~40 effect files, ~2.7MB of V1 effect code in `scripts/effects/`, a 108KB `EffectComposer.js`, and hundreds of V1 gates scattered across `canvas-replacement.js`, `tile-manager.js`, `token-manager.js`, and other managers.

### The Core Problem

The dual-pipeline creates **three categories of pain**:

1. **Confusion about what's running.** When V2 is active, `canvas-replacement.js` skips ~500 lines of V1 effect construction, mask wiring, registry seeding, and base mesh distribution. But V1 code is still _imported_, still _exists_, and V1 effects are still referenced by the UI system (`initializeUI` uses V1 `getControlSchema()` static methods). When something breaks, it's unclear whether the bug is in V1 code that shouldn't be running, V2 code that's missing something, or cross-contamination between the two.

2. **V1 blocks V2 progress.** Every new V2 effect requires: (a) writing the V2 implementation, (b) adding V2 UI wiring in `canvas-replacement.js`, (c) adding `_propagateToV2` callbacks, (d) verifying V1 code doesn't interfere. The V1 `EffectMaskRegistry`, `GpuSceneMaskCompositor`, `MaskManager`, `DepthPassManager`, and `FloorStack` visibility system are all still present and cause confusion even when V2 is active.

3. **V1 is actively broken.** The `TREE-BUSH-OVERHEAD-EFFECTS-BROKEN.md` doc (dated today) shows that even in V1 mode, the `EffectMaskRegistry` is completely empty — no subscribers, no textures. Trees, bushes, and overhead shadows are invisible. The V1 mask distribution pipeline is non-functional. Fixing V1 is a waste of effort when V2 is the target.

---

## 2. Current State Audit

### V2 Effects — Already Implemented (18 effects)

These live in `scripts/compositor-v2/effects/` and are self-contained:

| Effect | Type | Status | File Size |
|--------|------|--------|-----------|
| **SpecularEffectV2** | Bus overlay (per-tile) | ✅ Complete | 36KB |
| **FireEffectV2** | Bus overlay (particles) | ✅ Complete | 32KB |
| **WindowLightEffectV2** | Isolated scene overlay | ✅ Complete | 17KB |
| **LightingEffectV2** | Post-processing | ✅ Complete | 33KB |
| **SkyColorEffectV2** | Post-processing | ✅ Complete | 28KB |
| **WaterEffectV2** | Post-processing | ✅ Complete | 115KB |
| **CloudEffectV2** | Post-processing | ✅ Complete | 80KB |
| **ColorCorrectionEffectV2** | Post-processing | ✅ Complete | 10KB |
| **BloomEffectV2** | Post-processing | ✅ Complete | 8KB |
| **FilmGrainEffectV2** | Post-processing | ✅ Complete | 4KB |
| **SharpenEffectV2** | Post-processing | ✅ Complete | 4KB |
| **FilterEffectV2** | Post-processing | ✅ Complete | 13KB |
| **WeatherParticlesV2** | Bus scene particles | ✅ Complete | 21KB |
| **WaterSplashesEffectV2** | Bus scene particles | ✅ Complete | 73KB |
| **OutdoorsMaskProviderV2** | Shared infrastructure | ✅ Complete | 17KB |
| **BuildingShadowsEffectV2** | Shadow bake | ✅ Complete | 30KB |
| **OverheadShadowsEffectV2** | Shadow pass | ✅ Complete | 16KB |
| **specular-shader.js** | Shared GLSL | — | 26KB |
| **water-shader.js** | Shared GLSL | — | 77KB |
| **fire-behaviors.js** | Shared behaviors | — | 25KB |
| **water-splash-behaviors.js** | Shared behaviors | — | 29KB |

**Total V2 effect code: ~714KB** across 22 files.

### V1 Effects — Current `scripts/effects/` Reality (investigated Mar 2026)

The old “36+ V1 effects” count is stale. A direct filesystem audit shows `scripts/effects/` now contains a **much smaller core set** (plus shader helpers and one stub folder). Most previously-listed effects already live in `scripts/compositor-v2/effects/`.

| File in `scripts/effects/` | V2 Equivalent in `scripts/compositor-v2/effects/`? | Notes |
|---|---|---|
| DistortionManager.js (140KB) | ❌ No direct V2 replacement | Still the large V1 distortion hub (heat/water/magic distortion source system). |
| PlayerLightEffect.js (121KB) | ❌ No | Still V1-only and gameplay-critical. |
| IridescenceEffect.js (42KB) | ❌ No | Material overlay not yet ported. |
| PrismEffect.js (19KB) | ❌ No | Material overlay not yet ported. |
| LensflareEffect.js (26KB) | ❌ No | Camera-space flare pass not yet ported. |
| SelectionBoxEffect.js (39KB) | ❌ No | Token selection UI overlay still in V1 folder. |
| DetectionFilterEffect.js (13KB) | ❌ No | Detection visualization path still V1. |
| MaskDebugEffect.js (15KB) | ❌ No | V1 debug tooling. |
| DebugLayerEffect.js (18KB) | ❌ No | V1 debug tooling. |
| EffectComposer.js (64KB) | ⚠️ Partial | Still hosts shared frame/updatable orchestration + V2 delegation. |
| EnhancedLightsApi.js / LightEnhancementStore.js / LightRegistry.js / MapShineLightAdapter.js / ThreeLightSource.js / ThreeDarknessSource.js | ⚠️ N/A (shared/bridge infra) | These are lighting/support infrastructure, not standalone migrated effects. |
| DepthShaderChunks.js / Foundry*ShaderChunks.js / WaterSurfaceModel.js | ⚠️ N/A (shared shader/model helpers) | Shared utility code; not direct 1:1 effect classes. |
| `stubs/StubEffects.js` | N/A | Stub-only compatibility surface. |

**Audit summary:** the migration bottleneck is no longer “dozens of active V1 effects,” but a **small set of true V1 holdouts** (notably `DistortionManager` and `PlayerLightEffect`) plus shared infrastructure that still lives under `scripts/effects/`.

### V1 Infrastructure — Still Present

| System | File | Purpose | V2 Equivalent? |
|--------|------|---------|---------------|
| EffectMaskRegistry | `scripts/assets/EffectMaskRegistry.js` | Mask slot state manager | V2 effects load masks independently |
| GpuSceneMaskCompositor | `scripts/masks/` | GPU mask compositing | `OutdoorsMaskProviderV2` + per-effect mask loading |
| MaskManager | `scripts/masks/MaskManager.js` | Texture registry | Not needed in V2 |
| DepthPassManager | `scripts/scene/depth-pass-manager.js` | Per-floor depth capture | Not used in V2 |
| FloorStack visibility | `scripts/scene/FloorStack.js` | Per-frame visibility toggling | `FloorRenderBus.setVisibleFloors()` |
| TileEffectBindingManager | `scripts/scene/TileEffectBindingManager.js` | Per-tile overlay routing | V2 effects manage own overlays |

---

## 3. Analysis: Should We Delete V1?

### Arguments FOR deleting V1 now

1. **V1 is already broken.** The mask registry is empty, trees/bushes/overhead shadows don't work. Users on V1 already have a degraded experience.

2. **V2 covers the critical path.** Lighting, water, specular, fire, clouds, building/overhead shadows, weather particles, sky color, bloom, color correction, film grain, sharpen, filter, window lights, water splashes — all have V2 implementations.

3. **Eliminates confusion.** No more `_v2Active` gates, no more `_propagateToV2`, no more dual UI wiring. One pipeline, one truth.

4. **Unblocks Levels development.** V2 was built FROM THE GROUND UP for Levels/Floors. Every V2 effect has `onFloorChange()`, per-floor mask discovery, and floor-isolated rendering. V1 was retrofitted for floors and it shows (26+ failed fix attempts documented in `FLOOR-COMPOSITOR-REBUILD.md`).

5. **Massive code reduction.** Removing V1 effects + infrastructure would eliminate ~2MB of code that's already dead when V2 is active.

### Arguments AGAINST deleting V1 now

1. **14 effects have NO V2 equivalent.** These would stop working entirely:
   - ~~**WorldSpaceFogEffect** — Fog of war (critical for gameplay)~~ ✅ Migrated as `FogOfWarEffectV2`
   - **PlayerLightEffect** — Flashlight/torch (critical for gameplay)
   - **TreeEffect / BushEffect** — Animated vegetation (important for map makers)
   - **IridescenceEffect / PrismEffect / FluidEffect** — Material overlays (nice-to-have)
   - **DistortionManager** — Heat haze, water ripples (important)
   - ~~**AtmosphericFogEffect** — Distance fog (nice-to-have)~~ ✅ migrated to V2
   - **CandleFlamesEffect** — Weather/particle (medium priority)
   - **LensflareEffect** — Camera-space flares (nice-to-have)
   - **SmellyFliesEffect / DustMotesEffect / AshDisturbanceEffect** — Ambient particles (low priority)
   - **Artistic filters** — DotScreen, Halftone, ASCII, Dazzle, VisionMode (low priority)
   - **Debug** — MaskDebug, DebugLayers (dev only)

2. **`EffectComposer.js` is the frame loop owner.** It's not just V1 — it runs updatables (camera, interaction, movement, grid, doors) in both V1 and V2 modes. Deleting it would require moving the updatable loop into `FloorCompositor`.

3. **UI system references V1 static methods.** `initializeUI` in `canvas-replacement.js` calls `V1Effect.getControlSchema()` to build Tweakpane controls even in V2 mode.

### Verdict

**Don't delete V1 wholesale.** Instead, do a **phased migration** that:
1. Removes the V1/V2 toggle (force V2 always-on)
2. Strips V1 code from the hot path (no more `if (!_v2Active)` blocks)
3. Ports missing effects to V2 incrementally
4. Deletes V1 files only after their V2 replacement is validated

---

## 4. Recommended Strategy: "V2 Always-On + Incremental Port"

### Phase 0: Kill the Toggle (1-2 days)

**Goal:** V2 is the only renderer. No setting, no toggle, no fallback.

1. **Remove the `useCompositorV2` setting** from `scene-settings.js`.
2. **Hardcode `_v2Active = true`** in `canvas-replacement.js`.
3. **Delete all `if (!_v2Active)` blocks** in `canvas-replacement.js`. This removes:
   - V1 effect construction (`registerEffectBatch`, dependent effect registration)
   - V1 mask infrastructure (`MaskManager`, `EffectMaskRegistry` seeding, `connectToRegistry`)
   - V1 base mesh wiring (`wireBaseMeshes`)
   - V1 graphics settings wiring (`wireGraphicsSettings`)
   - V1 shader warmup
   - V1 `DepthPassManager`
   - V1 `VisibilityController`, `DetectionFilterEffect`, `DynamicExposureManager`
   - V1 `TileMotionManager`, `SurfaceRegistry`, `PhysicsRopeManager`
   - V1 floor pre-loading (`preloadAllFloors`, mask compositing, effect pre-warming)
4. **Delete all V2 check guards** in `tile-manager.js`, `token-manager.js`, and `EffectComposer.js`. These are the scattered `try { if (game?.settings?.get(..., 'useCompositorV2')) ... }` blocks.
5. **Simplify `EffectComposer.render()`** — remove the entire legacy render path below the V2 breaker fuse. Keep only the updatable loop and the `FloorCompositor.render()` delegation.
6. **Remove `_propagateToV2` dual-write UI callbacks** — UI changes should write directly to V2 effect params.

**Risk:** Effects without V2 equivalents will be invisible. This is acceptable because:
- Fog of war and player lights are the only gameplay-critical ones
- They'll be ported in Phase 1

**Validation:**
- Scene loads with V2 compositor
- All existing V2 effects render correctly
- Floor switching works
- UI controls work
- No console errors from V1 code paths

### Phase 1: Port Critical Missing Effects (1-2 weeks)

Priority order based on gameplay impact:

| Priority | Effect | Complexity | Why Critical |
|----------|--------|-----------|-------------|
| P0 | **WorldSpaceFogEffect** → FogOfWarEffectV2 | ✅ Complete | Fog of war migrated into V2 post-blit overlay path. |
| P0 | **PlayerLightEffect** → PlayerLightEffectV2 | High | Flashlight/torch is essential for dungeon crawling. |
| P1 | **TreeEffect** → TreeEffectV2 | Medium | Map makers expect trees. Mask-driven per-tile overlay. |
| P1 | **BushEffect** → BushEffectV2 | Medium | Same architecture as trees. |
| P1 | **DistortionManager** → DistortionEffectV2 | High | Heat haze over fire, water ripples — important visual quality. |
| P2 | **IridescenceEffect** → IridescenceEffectV2 | Low | Per-tile overlay, same pattern as Specular. |
| P2 | **PrismEffect** → PrismEffectV2 | Low | Per-tile overlay, same pattern as Specular. |
| P2 | **FluidEffect** → FluidEffectV2 | Medium | Per-tile overlay with animation. |
| P2 | **AtmosphericFogEffect** → AtmosphericFogEffectV2 | Medium | Screen-space depth fog post-process. |
| P3 | **LightningEffect** → LightningEffectV2 | Low | Global flash overlay. |
| P3 | **CandleFlamesEffect** → CandleFlamesEffectV2 | Medium | Light-position driven particles. |
| P3 | **LensflareEffect** → LensflareEffectV2 | Medium | Camera-space light quads. |
| P3 | **SmellyFliesEffect** → SmellyFliesEffectV2 | Low | Simple particle system. |
| P3 | **DustMotesEffect** → DustMotesEffectV2 | Low | Simple particle system. |
| P3 | **AshDisturbanceEffect** → AshDisturbanceEffectV2 | Low | Token-driven particle burst. |
| P4 | **VisionModeEffect** | Low | Darkvision/tremorsense overlay. |
| P4 | **Artistic filters** (Dot/Halftone/ASCII/Dazzle) | Low | Niche post-processing. |
| P4 | **Debug effects** (MaskDebug/DebugLayers) | Low | Dev only. |

### Phase 2: Delete V1 Effect Files (after Phase 1 P0-P1 complete)

Once fog, player lights, trees, bushes, and distortion have V2 implementations:

1. Delete all V1 effect files from `scripts/effects/` that have V2 equivalents.
2. Delete V1 infrastructure:
   - `scripts/assets/EffectMaskRegistry.js`
   - `scripts/masks/GpuSceneMaskCompositor.js`
   - `scripts/masks/MaskManager.js`
   - `scripts/scene/depth-pass-manager.js`
   - `scripts/scene/TileEffectBindingManager.js`
   - `scripts/effects/EffectBase` (if separate)
   - `scripts/effects/effect-capabilities-registry.js`
3. Delete V1 support code:
   - `scripts/foundry/effect-wiring.js` — replaced by V2 direct registration
   - V1-specific imports in `canvas-replacement.js`
4. Keep `EffectComposer.js` but slim it to just the updatable loop + FloorCompositor delegation.
5. Remaining V1-only effects (P2-P4) stay in `scripts/effects/` until ported.

### Phase 3: Clean Architecture (after Phase 2)

1. **Rename** `FloorCompositor` to just `Compositor` or `SceneRenderer`.
2. **Move** `EffectComposer` updatable loop into the compositor.
3. **Flatten** — `scripts/compositor-v2/` becomes `scripts/compositor/` (no more "v2" suffix).
4. **Delete** the `scripts/effects/` directory once all effects are ported.
5. **Simplify** `canvas-replacement.js` — it should be 50% smaller without V1/V2 branching.

---

## 5. How To Make V2 Effect Development Better

### Current Pain Points

1. **Every V2 effect needs manual wiring in 3+ places:**
   - `FloorCompositor.js` constructor (create)
   - `FloorCompositor.js` initialize() (init)
   - `FloorCompositor.js` render() (update + render)
   - `FloorCompositor.js` _applyCurrentFloorVisibility() (floor change)
   - `FloorCompositor.js` dispose() (cleanup)
   - `canvas-replacement.js` UI registration

2. **No standard V2 effect interface.** Each effect has its own lifecycle method names. Some have `initialize()`, some don't. Some have `update(timeInfo)`, some have `render(renderer, ...)`. Some have `onFloorChange(idx)`, some don't.

3. **FloorCompositor.js is growing.** At 1030 lines with 18 effects, it's already unwieldy. Adding 15 more effects will make it unmanageable.

### Proposed Improvements

#### A. Standard V2 Effect Interface

```javascript
/**
 * @interface V2Effect
 */
class V2Effect {
  /** @type {string} Unique ID for UI/persistence */
  get id() {}
  
  /** @type {object} User-tunable params object */
  get params() {}
  
  /** @type {boolean} Whether the effect should render */
  get enabled() {}
  
  /** @type {'bus'|'post'|'overlay'} Where in the pipeline this effect renders */
  get renderStage() {}
  
  /** @returns {object} Tweakpane control schema */
  static getControlSchema() {}
  
  /** One-time setup. Called during FloorCompositor.initialize(). */
  initialize(context) {}
  
  /** Async mask discovery + setup. Called on first render frame. */
  async populate(foundrySceneData) {}
  
  /** Per-frame update (advance simulations, sync uniforms). */
  update(timeInfo) {}
  
  /** Per-frame render (draw to RT or bus scene). */
  render(context) {}
  
  /** Active floor changed. Update visibility/masks. */
  onFloorChange(maxFloorIndex) {}
  
  /** Viewport resized. */
  onResize(width, height) {}
  
  /** Whether continuous rendering is needed. */
  wantsContinuousRender() {}
  
  /** Cleanup GPU resources. */
  dispose() {}
}
```

#### B. Effect Registry in FloorCompositor

Instead of hardcoding each effect as a named property:

```javascript
// In FloorCompositor constructor:
this._busEffects = [];      // Render in bus scene pass
this._postEffects = [];     // Post-processing chain (ordered)
this._overlayEffects = [];  // Isolated scene overlays

// Registration:
this.registerEffect(effect, { stage: 'bus' | 'post' | 'overlay', order: number });

// Render loop becomes generic:
for (const effect of this._busEffects) {
  if (effect.enabled) effect.update(timeInfo);
}
this._renderBus.renderTo(renderer, camera, sceneRT);
for (const effect of this._postEffects) {
  if (effect.enabled && effect.params.enabled) {
    const output = (currentInput === postA) ? postB : postA;
    effect.render({ renderer, camera, input: currentInput, output });
    currentInput = output;
  }
}
```

This eliminates per-effect wiring in the render loop. New effects just register themselves.

#### C. Declarative UI Registration

Instead of manual `_propagateToV2` callbacks for each effect:

```javascript
// Each V2 effect declares its own schema:
static getControlSchema() {
  return {
    id: 'fire-sparks',
    folder: 'Fire & Embers',
    category: 'particles',
    params: [
      { key: 'enabled', type: 'boolean', default: true },
      { key: 'intensity', type: 'number', min: 0, max: 2, default: 1 },
      // ...
    ]
  };
}

// FloorCompositor auto-registers all effects with the UI manager:
for (const effect of this._allEffects) {
  const schema = effect.constructor.getControlSchema?.();
  if (schema) {
    uiManager.registerEffect(schema.id, schema, (paramId, value) => {
      effect.applyParam(paramId, value);
    });
  }
}
```

No more per-effect UI wiring in `canvas-replacement.js`.

---

## 6. Effort Estimates

| Phase | Effort | Risk | Deliverable |
|-------|--------|------|-------------|
| Phase 0: Kill the toggle | 1-2 days | Low | V2 always-on, ~500 lines deleted from canvas-replacement.js |
| Phase 1 P0: Fog + Player Lights | 1 week | Medium | Core gameplay effects working in V2 |
| Phase 1 P1: Trees + Bushes + Distortion | 1 week | Medium | Visual quality parity for map makers |
| Phase 1 P2: Iridescence + Prism + Fluid + AtmoFog | 3-4 days | Low | Material effects parity |
| Phase 2: Delete V1 | 1-2 days | Low | ~2MB code removed |
| Phase 3: Clean architecture | 2-3 days | Low | Simplified codebase |

**Total: ~3-4 weeks** for complete migration.

---

## 7. Open Questions

1. **Should Phase 0 happen immediately, or after P0 effects are ported?**
   - Doing Phase 0 first is cleaner but means fog/player lights are temporarily missing.
   - Doing P0 effects first means living with the dual-pipeline slightly longer.
   - **Recommendation:** Phase 0 first. The V1 fog/player lights are also buggy (mask registry issues), so the loss is smaller than it appears.

2. **Should `EffectComposer.js` survive or be absorbed into `FloorCompositor`?**
   - It currently owns the updatable loop and RAF scheduling.
   - `FloorCompositor` could absorb this trivially (it already receives the updatable calls).
   - **Recommendation:** Absorb into FloorCompositor during Phase 3.

3. **How to handle V2 effects that share V1 code?**
   - `WeatherParticlesV2` wraps V1 `WeatherParticles`. 
   - `WaterSplashesEffectV2` uses behaviors from V1 particles.
   - **Recommendation:** Extract shared code into `scripts/shared/` or `scripts/particles/` (already partially done). Don't delete the shared code with V1.

4. **Should we port V1 effects or rewrite from scratch?**
   - V2 effects so far have been clean rewrites, not ports. This has worked well.
   - Some V1 effects are huge (PlayerLightEffect: 121KB, DistortionManager: 140KB).
   - **Recommendation:** Rewrite for simple effects, extract-and-adapt for complex ones. The shader code is often reusable; the lifecycle/wiring is not.

---

## 8. Implementation Progress

### Phase 0: Kill the Toggle — IN PROGRESS

**Status:** V2 is now the active renderer. Foundry loads successfully without freezing.

**Completed:**
- ✅ V2 compositor is running as the sole renderer
- ✅ Foundry loads without freezing
- ✅ Specular effect is working correctly

### Blocker: Camera-Locked Albedo / Stuck Overlay — UNRESOLVED

**Summary:** A semi-transparent “albedo-like” image remains stuck to the screen (camera-locked) in V2 mode. It appears perfectly aligned with the scene at initial load, then becomes screen-space locked during pan/zoom. The artifact can change when selecting/deselecting tokens (vision/fog refresh events), which suggests an interaction with Foundry’s internal PIXI rendering/vision pipeline.

**Why this blocks migration:** This prevents reliable validation of the V2 compositor as the exclusive renderer. Until PIXI’s scene output is fully suppressed (or the overlay source is conclusively removed), it’s not possible to confidently proceed with Phase 0 cleanup and Phase 1 effect ports.

**What we tried (high level):**

- **V2 final blit / clear hardening** (`scripts/compositor-v2/FloorCompositor.js`)
  - Forced an opaque clear before blitting the final fullscreen quad.
  - Forced the blit quad to be fully opaque (alpha=1 / no blending).
  - Adjusted renderer state restore so clearAlpha does not end frames as transparent.

- **Render cadence hardening** (`scripts/core/render-loop.js`)
  - Disabled adaptive frame skipping in V2 mode to reduce stale-frame artifacts during camera movement.

- **Renderer alpha hardening**
  - Forced `renderer.setClearColor(..., 1)` and `renderer.setClearAlpha(1)` in multiple locations (renderer setup, renderer attach, and V2 final blit).
  - Confirmed at runtime that `MapShine.renderer.getClearAlpha()` was returning `0` initially, and later `1` after adjustments — the overlay persisted even when `getClearAlpha()` reported `1`.

- **PIXI suppression attempts** (`scripts/foundry/canvas-replacement.js`)
  - Hid Foundry fog/visibility layers (`canvas.fog`, `canvas.visibility`) and disabled some layer filters.
  - Forced PIXI canvas opacity to 0.
  - Strengthened suppression to `display:none` / `visibility:hidden` for PIXI canvas.
  - Added explicit hiding for Foundry’s `#board` canvas after `dumpCanvasStack()` revealed it was visible with `z-index: 10` above `#map-shine-canvas` (`z-index: 1`).
  - Added hooks to re-apply suppression on common vision/token/UI events.

**Evidence gathered:**

- **DOM canvas stack dump** (`window.MapShine.dumpCanvasStack()`)
  - Enumerates all `<canvas>` elements and their computed styles.
  - Observed Foundry’s `#board` canvas (PIXI output) compositing above Three (e.g. `zIndex: 10` vs Three `zIndex: 1`).

**Root Cause Identified (final):**

The “camera-locked albedo / semi-transparent stuck overlay” was **PIXI’s `#board` canvas being left visible and composited above Three**.

Even if Three is rendering correctly, as long as `#board` is on-screen, you can see:

1. **Foundry fog-of-war** (not ported to V2 yet)
2. **Faint token artwork** (PIXI token meshes/sprites)

Disposing MapShine’s `FrameCoordinator` helps reduce extra PIXI flush rendering, but it **does not** prevent Foundry from drawing to (and compositing) its own `#board` canvas.

**Fix Implemented:**

- **Hard-hide `#board` in V2 during createThreeCanvas** (`scripts/foundry/canvas-replacement.js`)
  - Set `display:none`, `visibility:hidden`, `opacity:0`, `zIndex:-1`, `pointerEvents:none`.
  - This ensures PIXI cannot contribute any pixels in V2 gameplay.

- **Keep `#board` suppressed even if Foundry re-applies styles**
  - Added a `MutationObserver` in V2 to re-enforce the hidden styles on `#board` whenever `style`/`class` changes.

- **FrameCoordinator defense-in-depth**
  - In V2, dispose FrameCoordinator (do not initialize it).
  - Also gate `FrameCoordinator.flushPixi()` to no-op when `window.MapShine.__v2Active === true`.

**Validation (confirmed):**

- With `#board` hard-hidden, PIXI fog-of-war and token sprites no longer appear.
- The Three output is visually stable (no stuck semi-transparent overlay).

---

## 9. V2 Token Rendering — Root Causes + Fixes

### Symptoms

- Tokens were not visible in V2.
- Sometimes tokens existed (selectable / keyboard-movable) but were not rendered.
- Tokens could appear only when newly placed, but would disappear on hard refresh.

### V2 token render pipeline (authoritative)

- V2 only renders **`FloorRenderBus._scene`** via `FloorCompositor.render()`.
- Anything kept only in the main Three scene (`threeScene`) will not appear in V2.

### Root causes found

- **Wrong scene graph**
  - Tokens were initially being added to the main Three scene, but V2 renders the bus scene.
  - Additionally, the first attempt at bus-scene routing looked up the compositor on the wrong object (`sceneComposer`), so tokens kept falling back to the main scene.

- **Camera layer mismatch**
  - `FloorLayerManager.assignTokenToFloor()` moves tokens off layer 0 and onto a floor layer (1–19).
  - The V2 render path was only enabling layer 0 on the camera during bus render.

- **Depth/Z mismatch between V1 and V2**
  - V2 bus tiles are placed at `Z≈1000` (`GROUND_Z=1000`).
  - Tokens were placed at `Z≈3`, so they were behind the entire albedo stack.

- **Bus populate clearing / lifecycle ordering hazards**
  - `FloorRenderBus.populate()` calls `clear()`. The original clear behavior removed *all* children from the bus scene.
  - This could wipe tokens/effect objects added to the bus scene.

- **Hard refresh token sync ordering**
  - On some refresh/recovery init paths, `TokenManager` could initialize after `canvasReady` had already fired (or been skipped).
  - That meant `syncAllTokens()` didn’t run, so only *new* tokens created after load appeared.

### Fixes implemented (code)

- **Add tokens to the V2 bus scene (correct compositor lookup)** (`scripts/scene/token-manager.js`)
  - Use `window.MapShine.effectComposer._floorCompositorV2._renderBus._scene` as the authoritative bus scene.
  - Add token sprites to that bus scene so V2 can render them.

- **Enable floor layers during bus render** (`scripts/compositor-v2/FloorRenderBus.js`)
  - In `renderTo()`, temporarily enable layer 0, overlay, and floor layers 1–19 on the camera before rendering the bus scene.

- **Preserve tokens across bus repopulation** (`scripts/compositor-v2/FloorRenderBus.js`)
  - `clear()` no longer blindly removes all scene children.
  - Tokens are preserved by recognizing token objects (via `userData.type === 'token'` and/or naming).

- **Fix token Z placement for V2** (`scripts/scene/token-manager.js`)
  - Token Z now uses a V2-specific base (`TOKEN_BASE_Z_V2 = 1003.0`) when the V2 bus scene exists.
  - V1 continues to use a small base offset (`TOKEN_BASE_Z_V1 = 3.0`).

- **Refresh resilience: force initial token sync even if `canvasReady` hook is missed** (`scripts/scene/token-manager.js`)
  - On `TokenManager.initialize()`, if `canvas.ready` is already true, schedule `syncAllTokens()` immediately (microtask) and retry once shortly after.

- **V2 self-heal migration** (`scripts/scene/token-manager.js`)
  - Each frame, if a bus scene exists, ensure every token sprite is parented under the bus scene (handles lifecycle ordering issues).
  - Also repair stranded invisible sprites after migration (ensure `visible=true`, `opacity=1.0` when needed).

- **Token deletion correctness in V2** (`scripts/scene/token-manager.js`)
  - `removeTokenSprite()` now removes the sprite from `sprite.parent` (bus scene in V2) and also defensively removes from both main scene and bus scene.

### Current known follow-ups

- Mouse dragging / raycasting selection still needs investigation (keyboard movement works, mouse drag does not).

---

## 9. Immediate Next Steps

1. **Lock in PIXI suppression in V2**
   - Ensure Foundry’s `#board` canvas stays hard-hidden in V2 (`display:none`, etc.).
   - Keep the MutationObserver enforcement so Foundry/modules can’t re-enable it.
   - Keep FrameCoordinator disabled/gated in V2 as defense-in-depth.
2. **Bring V2 fog online next (highest priority missing visual)** ✅
   - Implemented by integrating `FogOfWarEffectV2` into the V2 `FloorCompositor` as a dedicated post-blit overlay pass.
   - **Where:**
     - `scripts/compositor-v2/FloorCompositor.js`
     - `scripts/foundry/canvas-replacement.js` (V2 Tweakpane registration)
     - `scripts/compositor-v2/effects/FogOfWarEffectV2.js` (critical circular-import hardening)
   - **Key details:**
     - V2 renders the bus scene into an RT and then blits; it does *not* render the main Three scene directly.
       Because of that, fog cannot rely on “fog plane lives in the main scene” like V1.
     - Solution: create a dedicated `FogOverlaySceneV2` and render it *after* `_blitToScreen(...)` using `autoClear=false`.
     - Fog uniforms/vision/exploration RT generation remains inside `FogOfWarEffectV2.update(timeInfo)`.
   - **Critical bug fixed (TDZ / circular import):**
     - Runtime error observed:
       - `ReferenceError: can't access lexical declaration 'EffectBase' before initialization`
     - Root cause:
       - `WorldSpaceFogEffect` imported `EffectBase` from `EffectComposer.js`.
       - `EffectComposer.js` imports the V2 `FloorCompositor`, which imports `WorldSpaceFogEffect`.
       - This created an ES module cycle where `EffectBase` was still in the TDZ when `WorldSpaceFogEffect` evaluated.
     - Fix:
       - `WorldSpaceFogEffect` no longer imports from `EffectComposer.js` and no longer extends `EffectBase`.
       - It now behaves as a standalone “effect-like” class with the same public fields (`id`, `layer`, `enabled`, `floorScope`, etc.).
       - Inlined `OVERLAY_THREE_LAYER = 31` to avoid importing the constant.
   - **UI wiring:**
     - V2 Tweakpane now registers Fog as `effectKey='_fogEffect'` so parameter changes flow into `FloorCompositor._fogEffect`.

3. **Then bring V2 player light online**
   - Port `PlayerLightEffect` to V2 after fog is stable.
4. **✅ FIXED: Specular background image support**
   - **Root cause:** `SpecularEffectV2.populate()` only iterated `canvas.scene.tiles.contents`, which contains placed tiles but NOT the scene background image.
   - **Background handling:** The scene background is processed separately by `FloorRenderBus` with special key `__bg_image__` (not in `tileDocs`).
   - **Fix:** Added background image processing to `SpecularEffectV2.populate()`:
     - Probes `canvas.scene.background.src` for `_Specular` mask before processing tiles
     - Creates overlay with `__bg_image__` key matching FloorRenderBus convention
     - Uses scene rect geometry from `foundrySceneData` (sceneWidth/sceneHeight/sceneX/sceneY)
     - Places at floor 0, Z = `GROUND_Z - 1 + SPECULAR_Z_OFFSET`
   - **Pattern for other effects:** Any V2 effect that needs to process the background image must explicitly check `canvas.scene.background.src` in addition to iterating `canvas.scene.tiles.contents`.

5. **✅ FIXED: Fire background image support**
   - **Root cause:** `FireEffectV2.populate()` only iterated `canvas.scene.tiles.contents`, missing background `_Fire` masks.
   - **Fix:** Added background image processing to `FireEffectV2.populate()`:
     - Probes `canvas.scene.background.src` for `_Fire` mask before processing tiles
     - Scans mask via `generateFirePoints()` to extract spawn point UVs
     - Converts background-local UVs to scene-global UVs using scene rect geometry
     - Assigns background fire to floor 0
     - Merges background points with tile points before building particle systems
   - **Result:** Fire particles now spawn from background `_Fire` masks correctly.
   - **✅ FIXED: Upper-floor fire not rendering (multi-floor scenes)**
     - **Symptom:** Fire masks were discovered and systems were registered in the Quarks `BatchedRenderer`, but nothing appeared visually when fire lived on an upper floor.
     - **Root cause:** `FloorRenderBus` tiles use very large `renderOrder` values (`floorIndex * 10000 + sort`). Fire’s `BatchedRenderer` and particle systems were using `renderOrder ~ 50`, so they rendered *before* tiles and were completely overwritten.
     - **Fix:** Raised V2 fire draw order well above the tile range:
       - `FireEffectV2._batchRenderer.renderOrder = 200000`
       - Fire/ember/smoke particle systems use `renderOrder = 200000 / 200001 / 200002`
     - **Additional fix:** Ensure systems actually start emitting by calling `system.play()` after creating each Quarks particle system.
   - **Diagnostics quality-of-life:** `EffectComposer._getFloorCompositorV2()` now exposes V2 instances on `window.MapShine` (`floorCompositorV2`, `fireEffectV2`, etc.) so runtime inspection is straightforward in V2 (effects are not registered in the legacy `EffectComposer.effects` map).
   - **Hosted/Levels hardening (mask discovery + spam control):**
     - **Problem observed:** On some hosted Foundry setups, `probeMaskFile()` can return null even when a valid `_Fire` mask exists and can be loaded via a normal browser `GET`.
       - Common causes include FilePicker browse restrictions and/or `HEAD` probing being blocked or unreliable.
     - **Fix:** `FireEffectV2.populate()` now falls back to direct `Image()` GET loading of `${basePath}_Fire.*` when `probeMaskFile()` fails.
       - Background tries common formats (webp/png/jpg/jpeg).
       - Tiles probe **webp only** to avoid multi-request 404 spam.
     - **Spam control:** Added negative-result caching for direct mask probes so each missing tile mask only causes at most a single request per session.
     - **Compatibility:** Works both when Levels floors are configured and when they are absent (all fire defaults to floor 0).

## 10. Success Story: FluidEffect → FluidEffectV2 (Per-tile overlay)

**Status:** Working in V2 (confirmed in Foundry).

**What it is:** A per-tile animated overlay driven by `_Fluid` luminance masks (same content workflow as V1). Each tile/background image with a `_Fluid` mask gets its own Three.js overlay mesh (ShaderMaterial) that animates over time.

**Implementation (V2 pattern):**
- New effect: `scripts/compositor-v2/effects/FluidEffectV2.js`
- Wiring:
  - `scripts/compositor-v2/FloorCompositor.js`
    - Constructed as `this._fluidEffect`
    - Initialized in `initialize()`
    - Populated alongside other overlays on first-frame bus population
    - Updated per-frame to advance `uTime`
    - Included in `wantsContinuousRender()` so animation stays smooth
  - `scripts/foundry/canvas-replacement.js`
    - V2 Tweakpane registration uses `FluidEffect.getControlSchema()`
    - Callback targets `FloorCompositor._fluidEffect`

**Behavior details:**
- Runs as a **bus overlay** via `FloorRenderBus.addEffectOverlay(...)` so it inherits floor visibility (no cross-floor bleed).
- Discovers `_Fluid` masks for:
  - The scene background (`__bg_image__` convention)
  - Individual tiles

**Known limitations (current V2):**
- V1 fluid supported roof-alpha gating and depth-occlusion integration.
- V2 FluidEffectV2 currently runs without:
  - Roof alpha map occlusion
  - Depth texture occlusion
- The effect is visually correct and animated, but may draw through geometry until V2 provides equivalent occlusion inputs.

## 11. Basic Version Working: BuildingShadowsEffectV2 + _Outdoors mask

**Status:** Basic version working in V2 (confirmed in Foundry).

**What this delivers now:**
- Building-projected ambient shadowing driven by indoor regions from `_Outdoors`.
- Shadow direction aligned with OverheadShadows.
- Shadow field anchored to the scene/world (not screen-space drifting).
- No border smear from out-of-bounds projection taps.

### Why `_Outdoors` is the critical dependency

`_Outdoors` is the authoritative indoor/outdoor classifier in this pipeline:
- Bright (`~1`) = outdoors receiver/caster space.
- Dark (`~0`) = indoor/building footprint.

BuildingShadowsEffectV2 projects indoor casters from this mask onto outdoor receivers. If `_Outdoors` is missing, stale, wrong-floor, or sampled in the wrong UV convention, the result immediately looks wrong (inverted direction/placement, full-scene suppression, or no visible contribution).

### Working V2 data path (current)

1. `GpuSceneMaskCompositor` composes per-floor scene-space `_Outdoors` textures (`source-over` policy).
2. `FloorCompositor` resolves the current outdoors texture with fallbacks and syncs all consumers.
3. `BuildingShadowsEffectV2` consumes keyed floor outdoors textures (with direct fallback texture support).
4. Building shadow RT is produced and consumed by `LightingEffectV2` as ambient dimming.

### `_Outdoors` handling hardening included

- Centralized outdoors-mask resolution in `FloorCompositor` with deterministic fallback order.
- Consumer fan-out now includes cloud/water/overhead/building + WeatherController roof map updates.
- Null-clobber protection during compositor warmup (retain last valid outdoors texture across transient gaps).
- Cloud floor-aware binding is guarded (only enabled when floor-id/per-floor slots are representable).

### Coordinate and sampling fixes that were required

- Building shadows were moved to scene-space target sizing to align with world/scene UV usage.
- Lighting composition removed the extra Y inversion when sampling building shadow RT (this was the persistent 100% Y-flip source once scene-space output was correct).
- Projection direction in BuildingShadows was inverted to match OverheadShadows' apparent cast direction.
- Kernel sampling now clips out-of-bounds taps from both numerator and denominator to avoid edge artifacts.

### Remaining scope (explicitly out of this “basic working” milestone)

- Fine-tuned artistic calibration of length/softness parity between overhead and building shadows.
- Optional debug visualizations (resolved outdoors source key, per-consumer binding state).
- Additional policy tuning for unusual multi-floor scenes with sparse floor-id coverage.

## 12. Success Story: Clouds Rendering Restored in V2 Baseline Path

**Status:** Fixed and confirmed in Foundry.

### Symptoms

- Cloud shadows could still influence lighting, but visible cloud tops were missing.
- Runtime diagnostics showed cloud passes executing every frame, yet output remained neutral.

### Root causes identified

1. **Baseline render-path omission:**
   - The temporary baseline early-return path in `FloorCompositor.render()` skipped the normal cloud-top blit block.
   - Result: cloud shadow RT could still be consumed by lighting, but cloud-top overlay never reached the final frame.

2. **Cloud cover source forcing neutral output:**
   - `CloudEffectV2._getWeatherState()` was resolving weather cloud cover to `0` in active weather-clear states, which forced neutral cloud output.
   - This overrode the effect's own `params.cloudCover` authoring intent in V2 baseline usage.

3. **Over-broad blocker masking:**
   - Cloud blocker capture treated all overhead-marked meshes as blockers regardless of floor relationship.
   - In multi-floor scenes this could suppress clouds too aggressively.

### Fixes applied

1. **Baseline cloud-top composite restored** (`scripts/compositor-v2/FloorCompositor.js`)
   - Added a baseline-compatible `cloudEffect.blitCloudTops(...)` call before final blit in the early-return path.

2. **Cloud-cover resolution hardened** (`scripts/compositor-v2/effects/CloudEffectV2.js`)
   - Updated weather/cloud merge logic so effective cover is:
     - `max(params.cloudCover, weather.cloudCover)`
   - Kept weather as a driver while preserving local cloud authoring floor.
   - Aligned `weatherEnabled` gating with V1 semantics (`WeatherController.enabled` respected).

3. **Floor-aware blocker filtering added** (`scripts/compositor-v2/effects/CloudEffectV2.js` + `scripts/compositor-v2/FloorRenderBus.js`)
   - Added `mesh.userData.floorIndex` to bus tiles.
   - Blocker pass now only treats overhead blockers above the active floor as cloud blockers.

### Outcome

- Cloud tops now render in the V2 baseline path.
- Cloud shadow + cloud-top composition is coherent again.
- Multi-floor blocker behavior is more accurate and no longer globally suppresses clouds.

## 13. Success Story: Building Shadows Multi-Floor Layering Fixed in V2

**Status:** Fixed and confirmed in Foundry.

### Symptoms

- On upper floors, ground-floor building shadows leaked through where they should be excluded.
- On ground floor, upper-floor overhang shadows appeared but were incorrectly cut out using upper-floor hole masking.
- In some scenes only ground-floor shadow contribution appeared, instead of active+above floor contributions.

### Root causes identified

1. **Source floor selection was not robust enough in multi-floor context:**
   - Shadow caster masks were not consistently resolved from compositor-cached floor keys by active level bottom.
   - This made contribution selection brittle when floor cache/state changed.

2. **Caster and receiver masking were coupled in projection:**
   - The same outdoors mask sample path was being used to both identify caster footprint and gate receiver visibility.
   - Result: when projecting upper-floor shadows to lower floors, upper-floor holes cut the projected result incorrectly.

3. **Fallback mask behavior could re-introduce leakage in multi-floor scenes:**
   - Ground/default fallback could be used in situations where strict floor-specific masking was required.

4. **Prior V2 composition paths could appear view-dependent unless sampled in scene UV space:**
   - Building shadow is authored in scene/world mask space, so composition must reconstruct world position per pixel before sampling.
   - Any direct screen-UV treatment would make shadow behavior more sensitive to camera zoom/pan.

### Fixes applied

1. **Active+above floor source compositing hardened** (`scripts/compositor-v2/effects/BuildingShadowsEffectV2.js`)
   - Source floor keys now resolve from compositor cache metadata and are filtered by active floor bottom elevation.
   - Behavior is deterministic: active floor and all floors above contribute; lower floors are excluded when viewing higher floors.

2. **Receiver mask decoupled from caster mask** (`scripts/compositor-v2/effects/BuildingShadowsEffectV2.js`)
   - Added separate receiver uniforms and sampling path:
     - `uReceiverOutdoorsMask`
     - `uHasReceiverMask`
     - `uReceiverOutdoorsMaskFlipY`
   - Shader now uses receiver-floor outdoors mask for receiver gate, while caster accumulation still uses per-source-floor caster masks.
   - This is the key layering fix that keeps upper-floor projected shadow shape on ground floor without inheriting upper-floor hole cutouts.

3. **Multi-floor fallback tightened + cache warmup added** (`scripts/compositor-v2/effects/BuildingShadowsEffectV2.js`)
   - Ground/global fallback mask is disabled for true multi-floor operation to avoid ambiguous leakage.
   - Added async preloading/warmup of floor outdoors masks so all relevant floor textures are ready before compositing.

4. **Scene-space sampling path confirmed and retained for zoom stability** (`scripts/compositor-v2/effects/BuildingShadowsEffectV2.js` + `scripts/compositor-v2/effects/LightingEffectV2.js`)
   - Building shadow RT remains scene-space authored (not tied to current screen size).
   - Lighting compose reconstructs world XY from camera frustum corners and converts to Foundry scene UV before sampling `tBuildingShadow`.
   - This keeps building-shadow contribution stable under camera zoom/pan and became the reference model used to diagnose overhead instability.

### Why the layering now works

- **Caster decision** answers: "Which floors cast into this view?" → active+above floors.
- **Receiver decision** answers: "Where can shadow land in this view?" → active/view floor outdoors mask.
- Separating those two decisions solved the mismatch that previously caused cross-floor cutout artifacts.

### Outcome

- Ground floor now receives combined building shadow from ground + upper floors.
- Upper floors no longer show leaked lower-floor building shadows.
- Upper-floor overhang shadows rendered on ground floor are masked by ground-floor receiver rules (correct), not upper-floor hole rules (incorrect).
- Building-shadow contribution is now consistently zoom-stable in V2 scenes.

## 14. Success Story: Overhead Shadows Region-Split + Zoom Stability Restored

**Status:** Fixed and validated in-scene.

### Symptoms

- Indoor-origin overhead shadows were leaking into outdoor receiver regions after projection.
- Attempts to block leakage accidentally broke the projected `_Outdoors` building-shadow contribution.
- Behavior became brittle when trying to preserve motion while also enforcing region correctness.
- Overhead shadow changed apparent softness and position while zooming.
- The `_Outdoors` dark-region building contribution inside overhead shadows remained zoom-unstable even after main roof-path improvements.

### Root causes identified

1. **Screen-space overhead path had mixed zoom regimes:**
   - Projection distance, blur kernel radius, and capture assumptions were not all scaled consistently.
   - Result: perceived softness drift and positional swim while zooming.

2. **Perspective zoom source could diverge from actual camera projection state:**
   - Using only stored zoom state can lag/quantize relative to the camera's current FOV during transitions.
   - Result: small but visible mismatch in projection offset behavior.

3. **`_Outdoors` dark-region contribution is world-UV based and must not inherit screen-UV zoom rules:**
   - The indoor dark-region term was sampled in scene/world mask UV, but portions of its length/jitter behavior were being driven like screen-space taps.
   - Result: this channel remained zoom-unstable after roof-path fixes.

### Fixes applied

1. **Strict region split for projected roof taps** (`scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`)
   - The roof projection tap gate now explicitly routes by binary receiver/caster region class:
     - indoor caster -> indoor receiver
     - outdoor caster -> outdoor receiver
   - This removed cross-boundary bleed while preserving projected motion.

2. **Projected `_Outdoors` building contribution restored to intended routing** (`scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`)
   - The dark-region term remains projected (so it still moves with sun direction).
   - The contribution is sourced from `_Outdoors` dark casters and applied to outdoor receivers as a separate building-shadow channel.
   - This restored the visual contribution that regressed during earlier leakage fixes.

3. **Perspective zoom derivation hardened + per-frame sync added** (`scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`)
   - Effective zoom is derived from the current camera FOV versus compositor base FOV for perspective cameras.
   - `uZoom` is refreshed during render so shader projection math and capture guard calculations share the same frame-consistent zoom value.

4. **Roof/tile blur footprint aligned with projection zoom regime** (`scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`)
   - Screen-space blur tap steps for roof/tile/fluid paths are scaled with zoom in the same regime as projection length.
   - This removed zoom-linked softening/sharpening drift on the main overhead path.

5. **`_Outdoors` dark-region path explicitly made zoom-stable in world UV** (`scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`)
   - Removed camera-zoom scaling from `_Outdoors` dark-region projection length base.
   - Added a dedicated non-zoom indoor mask jitter step for dark-region taps.
   - This fixed the remaining outdoor building-shadow instability within overhead shadows.

6. **Control schema copy re-aligned with actual runtime behavior** (`scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`)
   - Tweakpane labels/tooltips were updated back to “Outdoor Building Shadow (_Outdoors)” semantics.
   - This avoids tuning confusion and keeps authored settings consistent with shader routing.

### Why this is stable

- Projection motion and region masking are handled as separate concerns:
  - **Motion:** UV offsets follow sun direction as before.
  - **Validity:** contribution only survives if receiver/caster region pairing is allowed by the explicit split.
- The `_Outdoors` building shadow remains independent from the main roof same-region tap path, so it can be tuned without reopening indoor/outdoor leakage.
- Zoom behavior now follows UV-space ownership:
  - **Screen-space roof/tile/fluid taps:** projection + blur scale together with effective zoom.
  - **World/scene-space `_Outdoors` dark-region taps:** projection + blur remain zoom-independent.

### Outcome

- Indoor overhead shadows no longer project into outdoor receiver areas.
- Building-shadow contribution from `_Outdoors` dark regions is preserved and tunable.
- Shadow motion remains intact while region correctness is enforced.
- Overhead shadows are now zoom-stable for both the main roof contribution and the `_Outdoors` building-shadow contribution.

---

## Success Story — Foundry Editor Overlays Restored in V2 (Walls, Lights, Doors)

### Problem

In V2 gameplay mode, users could switch to **Walls** or **Lighting** tools, but wall lines/endpoints, light handles, and door controls/icons were not visible or interactive. Diagnostic snapshots showed:

- `canvas.walls.active` / `canvas.lighting.active` could be `true`
- while `window.MapShine.__forcePixiEditorOverlay` remained `false`
- and both `canvas.app.view` and `#board` stayed hidden (`display:none`, `visibility:hidden`, `opacity:0`).

### Root causes

1. **Suppression won the race**: gameplay PIXI suppression hooks kept hiding the board/canvas even after tool switches.
2. **No-op input transitions missed overlay updates**: when InputRouter was already in PIXI mode, early-return logic skipped reapplying overlay state.
3. **Detection split across systems**: overlay gating depended on one path (ControlsIntegration/InputRouter) instead of also being enforced at suppression point.
4. **Deprecated control accessor noise**: `activeControl` reads caused V13 compatibility warnings, obscuring debugging.

### Fixes applied

1. **InputRouter now updates overlay force state before no-op return**
   - `setMode()` computes editor-overlay need first and writes `window.MapShine.__forcePixiEditorOverlay` before any early return.
   - If mode is already PIXI and overlay is needed, it still re-applies PIXI/board visible styles.
   - File: `scripts/foundry/input-router.js`

2. **Suppression function became self-gating and self-healing**
   - `_enforceGameplayPixiSuppression()` now computes `needsEditorOverlay` from current runtime context (`walls/lighting active`, control/tool checks) instead of relying only on external flag timing.
   - When overlay is needed, it actively unsuppresses both `canvas.app.view` and `#board`, including pointer events.
   - File: `scripts/foundry/canvas-replacement.js`

3. **Suppression watchdog hooks were expanded**
   - Enforcement now runs on additional control/layer lifecycle hooks (including `activateCanvasLayer`) so tool changes cannot leave stale hidden styles.
   - File: `scripts/foundry/canvas-replacement.js`

4. **Active control reads were modernized**
   - Prefer `ui.controls.control?.name` and only fallback to `activeControl`.
   - Applied in routing/visibility integration paths to reduce deprecation churn and improve consistency.
   - Files: `scripts/foundry/input-router.js`, `scripts/foundry/controls-integration.js`, `scripts/foundry/layer-visibility-manager.js`, `scripts/foundry/canvas-replacement.js`

### Outcome

- Walls layer now shows wall lines/endpoints in edit mode.
- Lighting layer now shows light controls/icons in edit mode.
- Door controls/icons are visible again when appropriate.
- PIXI editor overlays and Three gameplay rendering now coexist via deterministic mode-aware gating.
