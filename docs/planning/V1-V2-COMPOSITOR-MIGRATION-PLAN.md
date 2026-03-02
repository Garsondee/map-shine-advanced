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

### V1 Effects — Still in `scripts/effects/` (36+ effects)

These are the V1 implementations. Many have V2 equivalents above:

| V1 Effect | Has V2 Equivalent? | Notes |
|-----------|-------------------|-------|
| SpecularEffect (145KB) | ✅ Yes | V2 is independent |
| LightingEffect (120KB) | ✅ Yes | V2 is independent |
| WindowLightEffect (163KB) | ✅ Yes | V2 is independent |
| WaterEffectV2 (247KB) | ✅ Yes (in compositor-v2) | Confusingly named — this is the V1 water in `scripts/effects/` |
| CloudEffect (109KB) | ✅ Yes | V2 is independent |
| DistortionManager (140KB) | ❌ **No V2** | V1-only; heat haze, water ripples, magic effects |
| OverheadShadowsEffect (74KB) | ✅ Yes | V2 is independent |
| WorldSpaceFogEffect (96KB) | ❌ **No V2** | Fog of war — critical, no V2 implementation |
| PlayerLightEffect (121KB) | ❌ **No V2** | Flashlight/torch — critical, no V2 implementation |
| SkyColorEffect (45KB) | ✅ Yes | V2 is independent |
| BuildingShadowsEffect (23KB) | ✅ Yes | V2 is independent |
| BloomEffect (33KB) | ✅ Yes | V2 is independent |
| TreeEffect (51KB) | ❌ **No V2** | Animated trees with wind |
| BushEffect (43KB) | ❌ **No V2** | Animated bushes with wind |
| ColorCorrectionEffect (14KB) | ✅ Yes | V2 is independent |
| IridescenceEffect (41KB) | ❌ **No V2** | Holographic thin-film |
| PrismEffect (19KB) | ❌ **No V2** | Refraction overlay |
| FluidEffect (64KB) | ❌ **No V2** | Fluid simulation overlay |
| AtmosphericFogEffect (36KB) | ❌ **No V2** | Distance/height fog |
| LightningEffect (38KB) | ❌ **No V2** | Weather lightning flashes |
| CandleFlamesEffect (38KB) | ❌ **No V2** | Candle/torch particles |
| LensflareEffect (25KB) | ❌ **No V2** | Camera-space light flares |
| SmellyFliesEffect | ❌ **No V2** | Particle effect |
| DustMotesEffect | ❌ **No V2** | Particle effect |
| AshDisturbanceEffect | ❌ **No V2** | Particle effect (token-driven) |
| SelectionBoxEffect (39KB) | ❌ **No V2** | Token selection UI |
| FilmGrainEffect (5KB) | ✅ Yes | V2 is independent |
| SharpenEffect (6KB) | ✅ Yes | V2 is independent |
| DotScreenEffect (5KB) | ❌ **No V2** | Artistic filter |
| HalftoneEffect (14KB) | ❌ **No V2** | Artistic filter |
| AsciiEffect (21KB) | ❌ **No V2** | Artistic filter |
| DazzleOverlayEffect (6KB) | ❌ **No V2** | Full-screen grade |
| VisionModeEffect (11KB) | ❌ **No V2** | Darkvision, tremorsense |
| DetectionFilterEffect (13KB) | ❌ **No V2** | Token detection overlay |
| MaskDebugEffect (14KB) | ❌ **No V2** | Dev overlay |
| DebugLayerEffect (18KB) | ❌ **No V2** | Dev overlay |
| EffectComposer (108KB) | Partially — delegates to FloorCompositor | Still the frame loop owner |

**Total V1 effect code: ~2.1MB** across 46+ files.

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

1. **15 effects have NO V2 equivalent.** These would stop working entirely:
   - **WorldSpaceFogEffect** — Fog of war (critical for gameplay)
   - **PlayerLightEffect** — Flashlight/torch (critical for gameplay)
   - **TreeEffect / BushEffect** — Animated vegetation (important for map makers)
   - **IridescenceEffect / PrismEffect / FluidEffect** — Material overlays (nice-to-have)
   - **DistortionManager** — Heat haze, water ripples (important)
   - **AtmosphericFogEffect** — Distance fog (nice-to-have)
   - **LightningEffect / CandleFlamesEffect** — Weather/particle (medium priority)
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
| P0 | **WorldSpaceFogEffect** → FogEffectV2 | High | Fog of war is core gameplay. Without it, players see everything. |
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

## 9. Immediate Next Steps

1. **Lock in PIXI suppression in V2**
   - Ensure Foundry’s `#board` canvas stays hard-hidden in V2 (`display:none`, etc.).
   - Keep the MutationObserver enforcement so Foundry/modules can’t re-enable it.
   - Keep FrameCoordinator disabled/gated in V2 as defense-in-depth.
2. **Bring V2 fog online next (highest priority missing visual)**
   - With PIXI fog suppressed, V2 needs its own fog to restore baseline gameplay readability.
   - Target: `WorldSpaceFogEffect` → V2 compositor integration.
3. **Then bring V2 player light online**
   - Port `PlayerLightEffect` to V2 after fog is stable.
4. **Investigate Specular layer parity**
   - Observation: Specular appears to work for one overhead layer but not the main background image layer.
   - Likely causes: layer classification / which meshes get the specular material / floor bus routing.
   - Action: confirm which FloorLayer(s) the background tile is assigned to, and whether its mesh uses the specular-enabled material.
