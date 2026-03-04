# V2 Effect Design Contract

## Date: 2026-03-04

This document defines the authoritative contract for implementing a V2 effect in the MapShine
compositor. It captures patterns from all currently completed V2 effects, known failure modes,
and a per-effect checklist to verify before shipping.

Read this **before** writing a new V2 effect. Read the relevant archetype section for your effect
type. Complete the checklist at the end.

---

## 1. The Four Effect Archetypes

Every V2 effect belongs to exactly one of these archetypes. Choose the correct one before writing
any code — changing archetype midway requires a full rewrite.

### Archetype A: Bus Overlay (Per-Tile Mesh)

**When to use:** The effect adds an additive or blended layer on top of individual tiles/background.
The output is a separate mesh aligned to each tile that discovered a relevant `_MaskType` image.

**Current examples:** `SpecularEffectV2`, `FluidEffectV2`

**How it works:**
- During `populate()`, for each tile with a `_MaskType` mask, create one `THREE.Mesh` with a
  `THREE.ShaderMaterial`. Register it into the `FloorRenderBus` via `addEffectOverlay(key, mesh, floorIndex)`.
- The bus renders all overlay meshes in the same pass as albedo tiles. Floor visibility (showing
  floors 0..N) is handled automatically by `FloorRenderBus.setVisibleFloors()`.
- The effect does NOT need to manage visibility on floor change — the bus handles it.

**Z placement (CRITICAL):**
```javascript
const GROUND_Z = 1000;          // Must match FloorRenderBus
const Z_PER_FLOOR = 1;          // Must match FloorRenderBus
const MY_Z_OFFSET = 0.1;        // Small positive: above albedo. Negative: below albedo.
const z = GROUND_Z + floorIndex * Z_PER_FLOOR + MY_Z_OFFSET;
```

**renderOrder (CRITICAL):**
Tiles use `floorIndex * 10000 + (overhead ? 5000 : 0) + sortWithinFloor`. Your overlay must use
a renderOrder slightly above the tile it covers:
```javascript
mesh.renderOrder = (floorIndex * 10000) + (isOverhead ? 5000 : 0) + sortWithinFloor + 1;
```

**Blending:**
- Additive specular/light: `THREE.AdditiveBlending`, `depthWrite: false`, `depthTest: false`
- Fluid/overlay: `THREE.NormalBlending`, `transparent: true`, `depthWrite: false`, `depthTest: false`

---

### Archetype B: Bus Particle Effect

**When to use:** The effect emits particles from positions driven by a mask scan or from Foundry
data (token positions, map points). Particles render via a `three.quarks` `BatchedRenderer`.

**Current examples:** `FireEffectV2`, `WaterSplashesEffectV2`, `AshDisturbanceEffectV2`

**How it works:**
- During `initialize()`, create a `BatchedRenderer` and add it to the bus scene via
  `renderBus.addEffectOverlay(key, batchRenderer, 0)`.
- During `populate()`, CPU-scan mask images to build spawn point lists. Create
  `QuarksParticleSystem` instances. Group systems by floor index into `_floorStates`.
- During `onFloorChange(maxFloorIndex)`, add/remove systems from the `BatchedRenderer` based on
  which floors are now active.
- During `update(timeInfo)`, call `batchRenderer.update(delta)` and sync weather/wind uniforms.

**renderOrder (CRITICAL):**
Particles MUST use `renderOrder >= 200000`. Tiles use up to ~190000. If particles use low
renderOrder they render behind tiles and are completely invisible.
```javascript
this._batchRenderer.renderOrder = 200000;
system.renderOrder = 200000;
emberSystem.renderOrder = 200001;
```

**System lifecycle:**
Always call `system.play()` after creating a `QuarksParticleSystem`. Systems are not
automatically started.

**Floor swap pattern:**
```javascript
onFloorChange(maxFloorIndex) {
  for (const [floorIndex, state] of this._floorStates) {
    const shouldBeActive = floorIndex <= maxFloorIndex;
    const isActive = this._activeFloors.has(floorIndex);
    if (shouldBeActive && !isActive) {
      for (const sys of state.systems) this._batchRenderer.addSystem(sys);
      this._activeFloors.add(floorIndex);
    } else if (!shouldBeActive && isActive) {
      for (const sys of state.systems) this._batchRenderer.deleteSystem(sys);
      this._activeFloors.delete(floorIndex);
    }
  }
}
```

---

### Archetype C: Post-Processing Effect

**When to use:** The effect reads the rendered scene (as a `WebGLRenderTarget`) and outputs a
modified version. It operates on screen-space pixels, not on individual tiles.

**Current examples:** `LightingEffectV2`, `WaterEffectV2`, `SkyColorEffectV2`, `CloudEffectV2`,
`BloomEffectV2`, `ColorCorrectionEffectV2`, `FilmGrainEffectV2`, `SharpenEffectV2`, `FilterEffectV2`

**How it works:**
- Takes `(renderer, camera, inputRT, outputRT, ...)` in `render()`.
- Reads `inputRT.texture` via a `tDiffuse` uniform on a fullscreen quad.
- Writes result to `outputRT`.
- Returns `true` if it wrote (so FloorCompositor advances `currentInput`), `false` if it skipped.
- FloorCompositor ping-pongs between `_postA` and `_postB`. Your effect picks the opposite RT:
  ```javascript
  const output = (currentInput === postA) ? postB : postA;
  effect.render(renderer, camera, currentInput, output);
  currentInput = output;
  ```

**ColorSpace (CRITICAL):**
All intermediate RTs must use `THREE.LinearSRGBColorSpace`. Do **not** set `outputColorSpace` or
`toneMapping` on intermediate passes. sRGB gamma encoding happens **once** in the final screen blit.

**RT type:**
Prefer `THREE.HalfFloatType` for HDR headroom (specular highlights, additive window light can
exceed 1.0). FloorCompositor probes for HalfFloat support at init time and falls back to
`UnsignedByteType` if needed. Match that pattern when creating your own RTs.

**Floor handling:**
Post effects generally operate on the fully composited image. Floor isolation for their inputs
(e.g. water mask, outdoors mask) is handled by swapping which texture is bound in `onFloorChange()`.

---

### Archetype D: Isolated Scene Overlay

**When to use:** The effect must composite on top of the final blitted image (after all
post-processing) and must NOT be affected by any post-processing pass. Typically used for
effects that need alpha-blending over the completed scene.

**Current examples:** `WorldSpaceFogEffect` (fog of war overlay)

**How it works:**
- Given a dedicated `THREE.Scene` by FloorCompositor.
- FloorCompositor renders it **after** `_blitToScreen()` with `autoClear = false`:
  ```javascript
  renderer.setRenderTarget(null);
  renderer.autoClear = false;
  renderer.render(this._fogScene, this.camera);
  ```
- The effect's own plane/mesh uses `transparent: true` and renders via
  `NormalBlending` so it alpha-blends over the final frame.

**Import safety (CRITICAL):**
Effects in this archetype that are imported by `FloorCompositor.js` must NOT import from
`EffectComposer.js` or `EffectBase`. Doing so creates an ES module circular import where
the class is still in the temporal dead zone (TDZ) when evaluated. The error is:
`ReferenceError: can't access lexical declaration 'EffectBase' before initialization`
Inline any constants you need (e.g. `const OVERLAY_THREE_LAYER = 31`) instead of importing them.

---

## 2. Universal Rules (All Archetypes)

These rules apply to every V2 effect regardless of archetype.

### 2.1 No V1 Infrastructure

V2 effects must NOT depend on:

| Forbidden V1 System | Why |
|---------------------|-----|
| `EffectMaskRegistry` | V2 effects load masks independently |
| `GpuSceneMaskCompositor` | V2 uses `OutdoorsMaskProviderV2` + per-effect loading |
| `MaskManager` | Not present in V2 |
| `DepthPassManager` | V2 renders MeshBasicMaterial; no depth pass |
| `TileEffectBindingManager` | V2 effects manage their own overlays |
| `EffectBase` | Not present when V2 path is used |
| `FloorStack.setFloorVisible()` | V2 uses `FloorRenderBus.setVisibleFloors()` |

### 2.2 Background Image Support

Every tile-scanning effect must ALSO probe the scene background image. The background is NOT in
`canvas.scene.tiles.contents`. The bus uses the key `'__bg_image__'` for its background mesh.
Your effect should use the same key.

```javascript
// Check background BEFORE iterating tiles
const bgSrc = canvas?.scene?.background?.src ?? '';
if (bgSrc) {
  const basePath = bgSrc.replace(/\.[^.]+$/, '');
  const maskUrl = await probeMaskFile(basePath, '_MyMask');
  if (maskUrl) {
    // use foundrySceneData.sceneWidth/sceneHeight/sceneX/sceneY for geometry
    // use foundrySceneData.height for world Y conversion
    this._createOverlay('__bg_image__', maskUrl, 0 /* floor 0 */);
  }
}
```

### 2.3 Mask Probe Fallback (Hosted Foundry)

`probeMaskFile()` can return `null` on hosted Foundry setups where `HEAD` requests are blocked.
Always fall back to a direct `Image()` GET if the probe fails:

```javascript
// Primary probe
let maskUrl = await probeMaskFile(basePath, '_MyMask');

// Fallback: direct image load
if (!maskUrl && !this._negativeCache.has(basePath)) {
  for (const ext of ['webp', 'png', 'jpg', 'jpeg']) {
    const candidate = `${basePath}_MyMask.${ext}`;
    const found = await tryLoadImage(candidate); // resolves true/false
    if (found) { maskUrl = candidate; break; }
  }
  if (!maskUrl) this._negativeCache.add(basePath);
}
```

Cache negative results so missing tiles don't re-request on every populate.

### 2.4 Floor Index Resolution

Use the standard floor-resolution pattern. Do NOT invent your own:

```javascript
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';

_resolveFloorIndex(tileDoc, floors) {
  if (!floors || floors.length <= 1) return 0;
  if (tileHasLevelsRange(tileDoc)) {
    const flags = readTileLevelsFlags(tileDoc);
    const mid = (Number(flags.rangeBottom) + Number(flags.rangeTop)) / 2;
    for (let i = 0; i < floors.length; i++) {
      if (mid >= floors[i].elevationMin && mid <= floors[i].elevationMax) return i;
    }
  }
  const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
  for (let i = 0; i < floors.length; i++) {
    if (elev >= floors[i].elevationMin && elev <= floors[i].elevationMax) return i;
  }
  return 0;
}
```

### 2.5 Coordinate System

Foundry uses top-left origin, Y-down. The bus uses Three.js convention: bottom-left, Y-up.

```
worldY = canvas.dimensions.height - foundryY
```

For tiles (top-left anchored in Foundry):
```javascript
const worldH = foundrySceneData.height;  // full canvas height including padding
const centerX = tileDoc.x + tileDoc.width  / 2;
const centerY = worldH - (tileDoc.y + tileDoc.height / 2);
const z       = GROUND_Z + floorIndex * Z_PER_FLOOR;
```

For the background image (covers scene rect, not full canvas):
```javascript
const centerX = foundrySceneData.sceneX + foundrySceneData.sceneWidth  / 2;
const centerY = worldH - (foundrySceneData.sceneY + foundrySceneData.sceneHeight / 2);
```

### 2.6 Texture FlipY Convention

| Texture source | `flipY` | Why |
|----------------|---------|-----|
| `THREE.TextureLoader` tile images | `true` (default) | Standard Three.js image convention |
| Background image (`__bg_image__`) | `false` | Paired with `mesh.scale.y = -1` to avoid double-flip |
| Mask images via canvas 2D | `false` | Canvas is Y-down, matches Foundry UV space |
| RenderTarget textures | `false` (automatic) | RTs are Y-up natively |

### 2.7 Renderer State Save/Restore

Any effect that changes renderer state MUST save and restore it. Non-restoration causes downstream
effects to render into wrong targets or with corrupted blend states.

```javascript
const prevTarget    = renderer.getRenderTarget();
const prevAutoClear = renderer.autoClear;
const prevColor     = renderer.getClearColor(new THREE.Color());
const prevLayerMask = camera.layers.mask;

// ... do work ...

camera.layers.mask = prevLayerMask;
renderer.autoClear = prevAutoClear;
// CRITICAL: Never restore clearAlpha to 0. A clearAlpha of 0 makes the Three.js
// canvas transparent and reveals underlying stale PIXI content as a ghost overlay.
renderer.setClearColor(prevColor, 1);
renderer.setRenderTarget(prevTarget);
```

### 2.8 Outdoors Mask

The outdoors mask is provided by `OutdoorsMaskProviderV2` — **do not discover it independently**.
Subscribe via `FloorCompositor.initialize()`:

```javascript
this._outdoorsMask.subscribe((tex) => {
  try { this._myEffect?.setOutdoorsMask?.(tex ?? null); } catch (_) {}
});
```

Your effect must implement `setOutdoorsMask(tex)` to receive the texture. On floor change,
`OutdoorsMaskProviderV2.onFloorChange(maxFloorIndex)` automatically pushes the correct
per-floor mask to all subscribers.

### 2.9 Sun Direction

Single source of truth is `SkyColorEffectV2`. FloorCompositor pushes sun angles after sky
updates. Effects that need sun direction should implement `setSunAngles(azimuthDeg, elevationDeg)`.
Never read sun direction independently.

### 2.10 Error Handling

All effect calls in FloorCompositor are wrapped in `try/catch`. Your effect must NOT throw
during normal operation but also must not silently corrupt state on error. Pattern:
- Critical path errors: log + skip frame (don't crash)
- Recoverable errors: log warn + set an internal error flag that disables the effect for the session

### 2.11 Circuit Breaker Registration

Register your effect in FloorCompositor with a circuit breaker gate:
```javascript
this._myEffect = this._circuitBreaker.isDisabled('v2.myEffect') ? null : new MyEffectV2(...);
```
The key `'v2.myEffect'` can be set via `localStorage.setItem('msa-cb-v2.myEffect', '1')` or the
Foundry circuit breaker admin UI, giving users an emergency kill switch for problematic effects.

---

## 3. Standard Lifecycle Contract

Every V2 effect MUST implement these methods with these exact signatures. Missing methods cause
silent failures — FloorCompositor calls them with `?.` optional chaining but the feature simply
won't work.

```javascript
class MyEffectV2 {
  constructor(renderBus) {          // renderBus only for bus overlay/particle types
    this._renderBus = renderBus;
    this._enabled   = true;
    this._initialized = false;

    // Public params object — ALL tunable values live here.
    // FloorCompositor.applyParam() writes directly to this.params[key].
    this.params = {
      enabled: true,
      // ... all effect-specific params with defaults
    };
  }

  // ── Enabled getter/setter ─────────────────────────────────────────────────
  // REQUIRED: Use a proper getter/setter backed by _enabled.
  // FloorCompositor.applyParam() detects get/set accessors and routes enabled
  // changes through this path so internal uniform state stays in sync.
  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    // Sync to any uniforms or per-material state here.
  }

  // ── initialize(context?) ──────────────────────────────────────────────────
  // One-time GPU resource creation. Called during FloorCompositor.initialize().
  // May receive renderer/scene/camera for effects that need them (shadow effects).
  initialize(renderer, busScene, camera) {
    if (!window.THREE) return;
    // Create: ShaderMaterials, RTs, Geometries, hook IDs
    this._initialized = true;
  }

  // ── populate(foundrySceneData) ────────────────────────────────────────────
  // Async mask discovery + per-tile object creation.
  // Called once per scene (lazy on first render frame).
  // Must be safe to call multiple times (clear previous state first).
  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this._clear(); // dispose previous state
    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    // ... probe masks, create overlays/systems ...
  }

  // ── update(timeInfo) ──────────────────────────────────────────────────────
  // Per-frame: advance simulations, sync uniforms from params/weather.
  // MUST NOT allocate new objects in hot paths.
  update(timeInfo) {
    if (!this._enabled || !this._initialized) return;
    const { time, delta } = timeInfo;
    // ... advance time, read weatherController, push to uniforms ...
  }

  // ── render(renderer, camera, ...) ─────────────────────────────────────────
  // Per-frame GPU work: draw calls, RT writes.
  // For post-processing effects: returns true if output RT was written.
  render(renderer, camera, inputRT, outputRT) {
    if (!this._enabled || !this._initialized) return false;
    // ... do rendering ...
    return true;
  }

  // ── onFloorChange(maxFloorIndex) ──────────────────────────────────────────
  // Called by FloorCompositor._applyCurrentFloorVisibility().
  // Update visibility / swap active state for the new floor set.
  onFloorChange(maxFloorIndex) {
    // Bus overlays: handled by bus automatically. Override only if extra work needed.
    // Particle effects: swap systems in/out of BatchedRenderer.
    // Post effects: swap active SDF data / mask binding.
  }

  // ── onResize(width, height) ───────────────────────────────────────────────
  // Called when the drawing buffer size changes.
  // Must resize any internal RTs to avoid sampling wrong-resolution data.
  onResize(width, height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this._myRT?.setSize(w, h);
  }

  // ── wantsContinuousRender() ───────────────────────────────────────────────
  // Return true to request the adaptive FPS cap to run at "continuous" rate.
  // Use when the effect animates (particles, fluid, animated shader time).
  wantsContinuousRender() {
    return this._enabled && (this._activeFloors?.size ?? 0) > 0;
  }

  // ── dispose() ─────────────────────────────────────────────────────────────
  // Release ALL GPU resources. Must be safe to call multiple times.
  dispose() {
    // Unhook Foundry hooks
    for (const id of Object.values(this._hookIds)) {
      try { Hooks.off(id); } catch (_) {}
    }
    // Dispose materials, geometries, RTs
    // Remove from renderBus
    this._initialized = false;
  }

  // ── static getControlSchema() ─────────────────────────────────────────────
  // Returns the Tweakpane parameter schema used by canvas-replacement.js.
  // Must match the keys in this.params exactly.
  static getControlSchema() {
    return {
      enabled: true,
      groups: [ /* ... */ ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        // ... rest of params
      }
    };
  }
}
```

---

## 4. FloorCompositor Wiring Checklist

After writing the effect class, you must wire it into FloorCompositor and the UI. Every step
must be done or the effect will silently not work.

### 4.1 FloorCompositor.js

- [ ] **Import** the effect at the top of the file
- [ ] **Constructor**: Add `this._myEffect = this._circuitBreaker.isDisabled('v2.myEffect') ? null : new MyEffectV2(this._renderBus);`
- [ ] **initialize()**: Call `this._myEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera);` (adjust args for your archetype)
- [ ] **initialize() — outdoors subscriber**: If your effect needs the outdoors mask, add a `this._outdoorsMask.subscribe(...)` call (before any populate() can run)
- [ ] **render() lazy populate block**: Call `this._myEffect?.populate?.(sc.foundrySceneData).then(...)` in the bus population block
- [ ] **render() update loop**: Call `this._myEffect?.update?.(timeInfo);` in the update section
- [ ] **render() render stage**: Call `this._myEffect?.render?.(...)` at the correct pipeline position
- [ ] **_applyCurrentFloorVisibility()**: Call `this._myEffect?.onFloorChange?.(maxFloorIndex);`
- [ ] **onResize()**: Call `this._myEffect?.onResize?.(w, h);`
- [ ] **wantsContinuousRender()**: Check `this._myEffect?.wantsContinuousRender?.()` if effect animates
- [ ] **dispose()**: Call `try { this._myEffect?.dispose?.(); } catch (_) {}`

### 4.2 canvas-replacement.js (UI Registration)

The UI registration happens in `initializeUI()`. Find the relevant section (V2 effects use the
same schema/registration path as V1 but need `_propagateToV2` or direct V2 routing).

- [ ] **Import**: Import `MyEffectV2` (or reuse the V1 effect's `getControlSchema()` if params are identical)
- [ ] **Schema**: Call `MyEffectV2.getControlSchema()` (or the V1 class static if schema is shared)
- [ ] **Callback**: Write `onMyEffectUpdate(effectId, paramId, value)` that:
  - Handles `'enabled'` / `'masterEnabled'` → `_propagateToV2('_myEffect', paramId, value)`
  - For all other params → `_propagateToV2('_myEffect', paramId, value)`
- [ ] **Register**: Call `uiManager.registerEffect('my-effect', 'My Effect', schema, callback, 'category')`
- [ ] **V2-only effects**: Wrap registration in `// Register V2 effect controls in Tweakpane` if the effect has no V1 equivalent

### 4.3 EffectComposer.js — EFFECT_KEY_MAP

For param replay on lazy FloorCompositor initialization (UI fires before compositor exists):

- [ ] Add `'my-effect': '_myEffect'` to `EFFECT_KEY_MAP` in `EffectComposer._getFloorCompositorV2()`

---

## 5. Pipeline Position Reference

When deciding where your effect runs in `FloorCompositor.render()`, use this reference:

```
[Pre-pass]
  1. BuildingShadowsEffectV2.render()   — bake sun shadow factor
  2. OverheadShadowsEffectV2.render()   — capture overhead tile alpha

[Bus scene → sceneRT]
  3. Bus Overlay effects (Specular, Fluid) — contribute meshes in bus scene
  4. Bus Particle effects (Fire, WaterSplashes, Ash) — contribute BatchedRenderers
  5. WeatherParticlesV2 — rain/snow/ash BatchedRenderer
  6. renderBus.renderTo(renderer, camera, sceneRT)

[Cloud passes — before lighting]
  7. CloudEffectV2.render()             — outputs cloudShadowTexture + cloudTopRT

[Post-processing chain: sceneRT → postA → postB → ...]
  8. LightingEffectV2.render()          — ambient + dynamic lights + darkness
  9. SkyColorEffectV2.render()          — time-of-day atmospheric grading
 10. ColorCorrectionEffectV2.render()   — user color grade
 11. FilterEffectV2.render()            — multiply/darken overlay
 12. WaterEffectV2.render()             — water tint/distortion/specular
 13. BloomEffectV2.render()             — screen-space glow
 14. CloudEffectV2.blitCloudTops()      — cloud tops alpha-over
 15. FilmGrainEffectV2.render()         — film noise
 16. SharpenEffectV2.render()           — unsharp mask

[Final output]
 17. _blitToScreen(currentInput)        — opaque blit to screen framebuffer

[Post-blit overlays — autoClear=false]
 18. WorldSpaceFogEffect (fogScene)     — fog of war alpha-blend overlay
```

> **NOTE (March 2026):** Steps 9–15 are currently disabled via an early `return` in the render
> loop. They are unreachable dead code. Only steps 1–8, lighting (8), water (12), blit (17), and
> fog (18) are actually executing. New post effects added between steps 9–15 will also be dead
> unless the early return is removed.

---

## 6. Known Pitfalls & Failure Modes

Each of these has burned us before. Check them during implementation.

### 6.1 Particles Invisible (Wrong renderOrder)

**Symptom:** Particle systems are registered and `play()` is called, but nothing appears.
**Cause:** `BatchedRenderer.renderOrder` and particle system `renderOrder` default to ~50, which
renders them behind all tiles (tiles use up to ~190000).
**Fix:** Set `batchRenderer.renderOrder = 200000` and all systems to `200000+`.

### 6.2 Upper-Floor Effect Not Rendering

**Symptom:** Effect works on floor 0 but is invisible on floor 1+.
**Cause A:** `onFloorChange()` not implemented — active systems/overlays never swap.
**Cause B:** Floor index resolved as 0 for all tiles (bad `_resolveFloorIndex`).
**Cause C:** Bus visibility showing correct floors but overlay's floor assignment is wrong.

### 6.3 Background Image Missing From Effect

**Symptom:** Effect works on placed tiles but not on the scene background image.
**Cause:** `populate()` only iterates `canvas.scene.tiles.contents`.
**Fix:** Add background probe before the tile loop (see Section 2.2).

### 6.4 Cross-Floor Bleed (Effect Appears on Wrong Floor)

**Symptom:** Water/fire/specular from floor 0 shows through upper-floor geometry.
**Cause:** Depth occlusion gated on absolute world elevation, not active-floor-relative elevation.
**Fix for post effects:** Use `uActiveLevelElevation` uniform and test `aboveGround - uActiveLevelElevation`.
**Fix for bus overlays:** `setVisibleFloors()` should handle it; verify overlay floor index is correct.

### 6.5 Effect Receives Stale Params on Load

**Symptom:** Effect uses constructor default values even though the scene has saved params.
**Cause:** The Tweakpane UI fires param callbacks before `FloorCompositor` is created (lazy init).
**Fix:** Add the effect to `EFFECT_KEY_MAP` in `EffectComposer._getFloorCompositorV2()`.

### 6.6 Circular Import / TDZ Error

**Symptom:** `ReferenceError: can't access lexical declaration 'EffectBase' before initialization`
**Cause:** Effect imports from `EffectComposer.js` while `FloorCompositor.js` also imports
the effect. ES module circular dependency puts `EffectBase` in TDZ.
**Fix:** Remove all imports from `EffectComposer.js` in your V2 effect. Inline any constants.

### 6.7 Stuck Ghost Overlay (Transparent Canvas)

**Symptom:** Semi-transparent image stuck to screen, aligned with scene at first load.
**Cause:** Renderer `clearAlpha` restored to `0` by a render pass, making the Three.js canvas
transparent. PIXI's `#board` canvas (hidden behind) bleeds through.
**Fix:** Never restore `clearAlpha` to a value below `1` in any render pass.

### 6.8 Fog / Background Visible on PIXI Layer

**Symptom:** Foundry's fog of war or token art appears as a screen-locked overlay.
**Cause:** The PIXI `#board` canvas became visible (some Foundry hook re-applied styles).
**Note:** This is handled by the `MutationObserver` in `canvas-replacement.js`. Not your concern
in V2 effects, but be aware that effects should not accidentally make `#board` visible.

### 6.9 Texture Black Until Next Frame

**Symptom:** Effect shows black for one frame at scene load.
**Cause:** `THREE.TextureLoader` delivers textures asynchronously. The mesh/material exists but
has `map = null` until the texture loads.
**Fix:** This is expected behaviour. Create the mesh with `map: null` immediately (so it exists
in the scene at the right position/floor) and fill in `material.map` in the TextureLoader callback.

### 6.10 Bus Repopulate Destroys Effect Overlays

**Symptom:** Effect overlays disappear after a scene/tile update triggers `renderBus.clear()`.
**Cause:** `clear()` removes all non-token objects from the bus scene. Effect overlays registered
via `addEffectOverlay()` are also removed.
**Fix:** Re-register effect overlays in the `populate()` path, which is called after `clear()`.
Do not cache overlay references across repopulations.

---

## 7. Per-Effect Implementation Checklist

Use this checklist for EVERY new V2 effect. Tick every item before marking an effect complete.

### Class Structure
- [ ] Effect does not extend `EffectBase` and has no import from `scripts/effects/EffectComposer.js`
- [ ] `this.params` object declared in constructor with all tunable values and correct defaults
- [ ] `get enabled() / set enabled(v)` accessor pair — NOT a plain property
- [ ] `this._initialized = false` guard respected in all methods
- [ ] `this._enabled` gate respected in `update()` and `render()` (bail early if false)

### Initialization
- [ ] `initialize()` creates all GPU resources (materials, RTs, geometries)
- [ ] `initialize()` registers all Foundry hook IDs into a tracked collection for `dispose()`
- [ ] `initialize()` is safe to skip if `window.THREE` is not available

### Mask Discovery & Populate
- [ ] `populate()` handles the scene background (`canvas.scene.background.src`) — key `'__bg_image__'`
- [ ] `populate()` iterates `canvas.scene.tiles.contents`
- [ ] `populate()` uses `tileHasLevelsRange()` + `readTileLevelsFlags()` for floor assignment
- [ ] `populate()` handles `probeMaskFile()` returning null (fallback direct image GET)
- [ ] `populate()` uses a negative probe cache to avoid repeat 404s on missing masks
- [ ] `populate()` calls `this._clear()` / cleans up previous state before rebuilding

### Coordinate System
- [ ] All Foundry Y positions converted to Three world Y: `worldY = worldH - foundryY`
- [ ] Tile center: `(tileDoc.x + tileDoc.width/2, worldH - (tileDoc.y + tileDoc.height/2))`
- [ ] Background center uses `sceneX + sceneWidth/2` and `worldH - (sceneY + sceneHeight/2)`
- [ ] Z uses `GROUND_Z + floorIndex * Z_PER_FLOOR ± small_offset` (GROUND_Z = 1000)

### Z-Ordering & Blending
- [ ] **Bus overlays**: renderOrder = `floorIndex * 10000 + (overhead ? 5000 : 0) + sort + 1`
- [ ] **Particles**: renderOrder >= `200000` for all systems and BatchedRenderer
- [ ] `depthTest: false` and `depthWrite: false` on all overlay/particle materials
- [ ] Blending mode chosen intentionally (Additive for light effects, Normal for opaque overlays)

### Floor Isolation
- [ ] `onFloorChange(maxFloorIndex)` correctly shows/hides or swaps state for each floor
- [ ] Effect does NOT rely on V1 `FloorStack.setFloorVisible()` or `EffectMaskRegistry`
- [ ] Upper-floor effects don't bleed onto lower floors (test with a 2-floor scene)
- [ ] Lower-floor effects don't appear on upper floors (test visibility in both directions)

### Resource Management
- [ ] `dispose()` removes all meshes from renderBus and disposes materials + geometries
- [ ] `dispose()` disposes all `WebGLRenderTarget` instances
- [ ] `dispose()` unregisters all Foundry hooks by their saved IDs
- [ ] `dispose()` is safe to call multiple times without crashing
- [ ] No `new THREE.Vector3()` or similar allocations in `update()` hot path (use cached instances)

### Renderer State
- [ ] Every custom render sub-pass saves and restores `renderTarget`, `autoClear`, `clearColor`
- [ ] `clearAlpha` is NEVER restored to `0` (always pass `1` as the alpha argument)
- [ ] Camera `layers.mask` saved and restored after any custom layer manipulation

### Integration
- [ ] FloorCompositor constructor: effect created with circuit breaker guard
- [ ] FloorCompositor.initialize(): effect initialized (correct signature for archetype)
- [ ] FloorCompositor.render() populate block: `populate()` called with `.then(() => _applyCurrentFloorVisibility())`
- [ ] FloorCompositor.render() update loop: `update(timeInfo)` called (correct position in update order)
- [ ] FloorCompositor.render() render stage: `render()` called at correct pipeline position
- [ ] FloorCompositor._applyCurrentFloorVisibility(): `onFloorChange(maxFloorIndex)` called
- [ ] FloorCompositor.onResize(): `onResize(w, h)` called
- [ ] FloorCompositor.dispose(): `dispose()` called with try/catch
- [ ] FloorCompositor.wantsContinuousRender(): consulted if effect animates
- [ ] `EFFECT_KEY_MAP` in `EffectComposer._getFloorCompositorV2()`: entry added for param replay
- [ ] `canvas-replacement.js`: UI registered via `uiManager.registerEffect(...)`
- [ ] UI callback routes `enabled`/param changes to the correct `FloorCompositor` property key

### Visual Validation
- [ ] Effect renders correctly on a single-floor scene
- [ ] Effect renders correctly on the ground floor of a multi-floor scene
- [ ] Effect renders correctly on an upper floor of a multi-floor scene
- [ ] Switching from ground floor to upper floor: old-floor effect disappears correctly
- [ ] Switching from upper floor to ground floor: ground-floor effect reappears correctly
- [ ] Scene reload (F5) produces the same result as first load
- [ ] Pan and zoom do not cause the effect to drift or become misaligned
- [ ] No visible flash or black frame on first render
- [ ] Disabling the effect via UI immediately suppresses it (next frame)
- [ ] Re-enabling the effect via UI immediately restores it (next frame)

---

## 8. EFFECT_KEY_MAP Reference (Current)

This is the mapping in `EffectComposer._getFloorCompositorV2()`. New effects must be added here.

```javascript
const EFFECT_KEY_MAP = {
  'lighting':           '_lightingEffect',
  'specular':           '_specularEffect',
  'sky-color':          '_skyColorEffect',
  'windowLight':        '_windowLightEffect',
  'fire-sparks':        '_fireEffect',
  'water-splashes':     '_waterSplashesEffect',
  'underwater-bubbles': '_underwaterBubblesEffect',
  'bloom':              '_bloomEffect',
  'colorCorrection':    '_colorCorrectionEffect',
  'filter':             '_filterEffect',
  'filmGrain':          '_filmGrainEffect',
  'sharpen':            '_sharpenEffect',
  'cloud':              '_cloudEffect',
  // ADD NEW EFFECTS HERE:
  // 'my-effect':       '_myEffect',
};
```

---

## 9. Effect Classification — What Goes Where

This section clarifies where upcoming missing effects should be implemented.

| Missing Effect | Archetype | Mask Key | Notes |
|----------------|-----------|----------|-------|
| TreeEffectV2 | A (Bus Overlay) | `_Tree` | Vertex-animated shader; wind from WeatherController |
| BushEffectV2 | A (Bus Overlay) | `_Bush` | Same architecture as Tree |
| IridescenceEffectV2 | A (Bus Overlay) | `_Iridescence` | AdditiveBlending thin-film shader |
| PrismEffectV2 | A (Bus Overlay) | `_Prism` | Refraction — needs sceneRT as input; special pipeline |
| FluidEffectV2 | A (Bus Overlay) | `_Fluid` | ✅ Already complete |
| DustMotesEffectV2 | B (Bus Particle) | `_Dust` | Simple floating mote emitter |
| CandleFlamesEffectV2 | B (Bus Particle) | none | Spawns at Foundry AmbientLight positions |
| LensflareEffectV2 | D (Isolated Scene) | none | Camera-space quads; needs post-blit position |
| SmellyFliesEffectV2 | B (Bus Particle) | MapPoints | Spawn area from MapPointsManager |
| DistortionEffectV2 | C (Post-Processing) | `_Fire` heat | Reads fire mask CPU pixels for heat source positions |
| AtmosphericFogEffectV2 | C (Post-Processing) | none | Depth-based screen-space fog |
| LightningEffectV2 | D (Isolated Scene) | none | Full-screen flash + bolt overlay; global, no floor |
| PlayerLightEffectV2 | D (Isolated Scene) | none | Token-driven; needs ThreeLightSource per token |
| VisionModeEffectV2 | C (Post-Processing) | none | Overlay tint for darkvision modes |
| DotScreenEffectV2 | C (Post-Processing) | none | Simple artistic post filter |
| HalftoneEffectV2 | C (Post-Processing) | none | Artistic post filter |
| AsciiEffectV2 | C (Post-Processing) | none | Artistic post filter |

---

## 10. WeatherController Integration

Most V2 effects need weather data. Always access it via the singleton:

```javascript
import { weatherController } from '../../core/WeatherController.js';

update(timeInfo) {
  const ws = weatherController.getCurrentState();
  // ws.windDirection: { x, y }  — normalized world-space wind vector
  // ws.windSpeed: number        — m/s equivalent
  // ws.precipitation: 0..1     — current rain/snow intensity
  // ws.gustStrength: 0..1      — current gust multiplier
  // ws.wetness: 0..1           — accumulated surface wetness
  // ws.freezeLevel: 0..1       — frost/ice buildup
  // weatherController.currentZoom — for zoom-scale adjustments
}
```

For wind accumulation (stripe drift, particle advection) use **monotonic integration** — never
raw `windDirection * time` which can reverse direction:
```javascript
const windVec = weatherController.getCurrentState()?.windDirection ?? { x: 0, y: 0 };
const windSpeed = weatherController.getCurrentState()?.windSpeed ?? 0;
this._windAccumX += windVec.x * windSpeed * delta * MY_INFLUENCE;
this._windAccumY += windVec.y * windSpeed * delta * MY_INFLUENCE;
// Wind accumulation is monotonically increasing — particles/stripes drift but never reverse.
```
