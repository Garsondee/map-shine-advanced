# Big Picture Systems Review (Map Shine Advanced)

## Purpose
This document captures “big picture” architectural observations now that many effects/managers are working together. The goal is to surface gaps, subtle mistakes, and high-leverage improvements that become apparent only when the full stack is running.

Scope:
- Runtime architecture (render loop + effect chain + managers)
- Cross-effect correctness (coordinate spaces, layering/occlusion, masks)
- Resource lifecycle (scene transitions, cache ownership, disposal)
- Performance and quality risks (GC, fill-rate, precision, color pipeline)
- Roadmap items (prioritized)

---

## Current Runtime Architecture (as implemented)

### Boot & lifecycle
- `scripts/module.js`
  - Registers settings and UI settings during `init`.
  - Installs canvas replacement hooks.
  - Runs `bootstrap()` on `ready`.

- `scripts/core/bootstrap.js`
  - Loads bundled three (`vendor/three/three.custom.js`) and exposes `window.THREE`.
  - Detects GPU capabilities and creates renderer via `renderer-strategy.js`.

- `scripts/foundry/canvas-replacement.js`
  - Hooks `canvasConfig` to make PIXI transparent.
  - Hooks `canvasReady` to build the Three scene.
  - Hooks `canvasTearDown` / wraps `Canvas.tearDown` to fade-to-black and clean up.
  - Owns the “system swap” behavior (Map Maker vs Gameplay).

### Rendering pipeline
- `scripts/core/render-loop.js`
  - Single `requestAnimationFrame` loop.
  - If `EffectComposer` exists, it owns rendering.

- `scripts/effects/EffectComposer.js`
  - Updates `TimeManager` once per frame.
  - Updates “updatables” (managers) once per frame.
  - Runs “scene effects” (mostly update + optional render) then a single authoritative `renderer.render(scene,camera)`.
  - If post-processing effects exist:
    - Renders world to `sceneRenderTarget` (FloatType)
    - Ping-pongs through post buffers (`post_1`, `post_2`) (FloatType)
    - Renders overlay-only Three objects (layer 31) directly to screen afterward.

### Scene composition + asset conventions
- `scripts/scene/composer.js` (`SceneComposer`)
  - Creates the base plane and camera (Perspective w/ FOV-based zoom).
  - Discovers suffix masks (via background src or large full-scene tiles).
  - Forces `flipY=false` on base textures + masks; expects geometry/shader conventions to handle Foundry’s top-left origin.

- `scripts/assets/loader.js`
  - Suffix-based mask registry (e.g. `_Specular`, `_Outdoors`, `_Water`, `_Fire`, ...).
  - Uses FilePicker browse to discover files when possible; probes in limited cases.
  - Converts PIXI textures to Three textures (sometimes via canvas clone for masks).

### Key managers (per-frame updatables)
- `TokenManager` (authoritative movement via `updateToken` hooks; animations updated per-frame)
- `TileManager` (tiles + overhead/roof categorization; drives roof alpha behavior; manages water occluder meshes)
- `WallManager` (walls for collision/selection)
- `InteractionManager` (selection, drag/drop, HUD positioning)
- `CameraFollower` + `PixiInputBridge` (pan/zoom input applied to PIXI; Three camera follows PIXI)
- `OverlayUIManager` and related UI elements

### Core system invariants already in place
- Centralized time: effects should use `TimeManager` / `timeInfo`.
- Coordinate conversion rules are known and documented (Foundry Y-down vs Three Y-up).
- Post chain precision is FloatType and dithering is enabled where needed.

---

## Cross-Effect Gaps / Risks / Potential Mistakes

### 1) Camera authority and “two-camera” complexity
Current approach (per `canvas-replacement.js`):
- Input on Three canvas is applied to PIXI (`PixiInputBridge`).
- Three camera follows PIXI (`CameraFollower`).

Risk:
- This is stable, but it means any system which samples Foundry/PIXI state “mid-frame” can desync from Three unless it uses the `frameCoordinator` pattern.
- Some effects/managers may be using “current camera” values without using `frameCoordinator.getFrameState()` (or without capturing frame-consistent bounds). This becomes visible as subtle jitter in masks / sampling / selection overlays.

High leverage improvement:
- Establish one “authoritative frame camera state” object and require all screen-space effects to use it.
  - Either fully standardize on `frameCoordinator.getFrameState()`
  - Or publish a `MapShine.frameState` snapshot updated once per frame before any effect updates.

### 2) Mask space consistency: world-space vs screen-space vs scene-UV
There are now multiple mask spaces:
- World-space sampled masks (e.g. `_Outdoors` for indoor/outdoor in scene UV)
- Screen-space masks (roof alpha, some distortion layers)
- Hybrid packed masks (`LightingEffect` packs roofAlpha/rope/token/outdoors into a combined target)

Risk:
- Effects can accidentally mix these spaces. Example failure modes:
  - Sampling roof alpha (screen-space) using world-space UVs
  - Sampling outdoors/world mask using `gl_FragCoord` screen UV
  - Inconsistent V flip depending on which path generated the texture

High leverage improvement:
- Define and enforce a formal “mask contract”:
  - **Mask record schema**: `space` (`sceneUv` | `screenUv` | `worldUv` | `foundryWorld`), `uvFlipY`, `channels`, `lifecycle`.
  - Centralize the conversion helpers: `sampleSceneUvFromWorld()`, `sampleScreenUvFromFragCoord()`, etc.
  - For each shared mask, document:
    - how it’s generated
    - how it must be sampled

### 3) Depth, occlusion, and lighting ordering is not yet a single coherent model
Some systems rely on:
- Three scene depth (meshes, z offsets, `renderOrder`)
- Off-screen prepasses (roof alpha, token masks)
- Shader-level occlusion decisions (lighting multiplying by roof alpha)

Risk:
- When you combine many effects, you can get contradictory occlusion semantics:
  - An object is “above roof” in world Z but still affected by a screen-space roof alpha texture (because the roof alpha pass doesn’t know about it).
  - A distortion pass distorts content that should be occluded by an overhead tile.
  - A post effect uses only screen-space roof alpha and cannot distinguish “hidden roof” vs “not a roof tile” without additional channels.

High leverage improvement:
- Introduce a **unified GBuffer-lite** strategy (minimal):
  - A single low-cost ID/depth/feature buffer for major layers: ground, overhead, token, UI-overlay.
  - Doesn’t need full deferred shading; just enough to disambiguate “what is at this pixel.”

### 4) Asset pipeline: color space + mipmap policy is inconsistent across sources
Observed:
- Renderer output is sRGB; toneMapping disabled.
- Base textures from Foundry are created as `THREE.Texture(resource.source)` with sRGB and `flipY=false`.
- Masks loaded through `loader.js` default to `LinearMipmapLinearFilter` with mipmaps enabled, then some masks disable mipmaps later.

Risk:
- The same underlying bitmap might exist as:
  - a canvas-cloned texture for masks
  - a direct image texture for albedo
  - multiple textures with different mipmap/filter configs
This can cause:
- shimmering/aliasing at certain zoom levels
- small brightness mismatches between “base plane” and “tile textures”

High leverage improvement:
- Standardize texture policies by “texture role”:
  - **Albedo**: sRGB, mipmaps on, anisotropy
  - **Data masks**: NoColorSpace, mipmaps off, Linear
  - **Lookup maps/DataTextures**: NoColorSpace, Nearest/Linear depending on use
- Add a single helper to apply these policies so effects/managers can’t drift.

### 5) Scene transitions / disposal: ownership and cache boundaries are still easy to leak
Good:
- `SceneComposer` tracks “owned textures” and tries to dispose them.
- There’s a global asset cache and `clearCache()` exists.

Risk:
- With many effects and derived textures (MaskManager, Lighting packed targets, distortion targets, etc.), it is easy to leak:
  - render targets
  - cloned canvas textures
  - GPU programs
- Also easy to *over-dispose* shared textures if ownership isn’t explicit.

High leverage improvement:
- Create a single “SceneResourceRegistry” that every effect registers GPU resources with.
  - On teardown, dispose by registry.
  - Prevents silent leaks and clarifies ownership.

### 6) Performance scaling: hot-path allocations and full-scene passes
You already addressed several GC hotspots (vision, particles, etc.).

Remaining systemic risks:
- Post chain does full-resolution passes even when effects are “enabled but intensity=0”.
- Some effects may render auxiliary buffers every frame regardless of changes.
- Multiple effects sample many textures; sampler pressure grows and can hurt WebGL1 fallback.

High leverage improvements:
- Add “render invalidation” to expensive passes:
  - Only redraw a cached target when inputs changed (time threshold, camera moved, params changed, tile data changed).
- Add “effective enabled” gating:
  - Distinguish `uiEnabled` from `renderEnabled` (renderEnabled false when intensity==0).

### 7) Integration coverage: Foundry features not yet mirrored in Three
This is the most important “big picture” category: what visuals/gameplay affordances Foundry users expect that aren’t yet mirrored (or may be partially mirrored).

Potential gaps to audit:
- **Measured templates** edge cases (cone/line, snapping, rotation, elevation)
- **Token vision / LOS** tie-ins beyond fog plane (e.g., token-level dimming, hidden tokens)
- **Overhead tile behaviors** (occlusion rules, “hide roof” interactions, visibility toggles)
- **Grid types** parity (hex variants, gridless) and interaction snapping in Three modes
- **Perception refresh triggers**: ensure all relevant hooks cause vision/fog updates

---

## Suggested "Next Architecture Upgrades" (Prioritized)

### P0 (correctness + stability)
1) **Document and enforce mask spaces**
   - Create a single "Mask Contract" section in docs and link every shared mask to it.
   - Add helper functions and (lightweight) runtime asserts in debug builds.

2) **Frame-consistent camera state**
   - Publish one `FrameState` snapshot every frame.
   - Make effects use that for screen-space reconstruction.

3) **Resource registry for teardown**
   - Centralize disposal of render targets and derived textures.
   - Prevent leaks during scene transitions and module reloads.

5) **Texture role policy**
   - Standardize mipmaps/filtering/colorSpace per role.

6) **Invalidation-based auxiliary passes**
   - Convert “always render” aux passes into cached targets.

### P2 (feature parity + authoring)
7) **Parity audit checklist**
   - List Foundry expectations and verify each is fully represented.

8) **Central “Scene Data Graph”**
   - One place where Foundry docs → derived render state is computed.
   - Effects read from the graph, not from `window.MapShine.*` ad-hoc.

---

## Concrete Audit Checklist (to run through)
- Camera:
  - Verify every screen-space shader uses the same bounds source.
  - Verify zoom scalar usage is consistent (FOV-based zoom vs camera.zoom).

- Masks:
  - Identify every mask texture in use and classify as `sceneUv` vs `screenUv`.
  - Validate Y inversion rules (flipV or flipY) per mask.

- Occlusion:
  - Decide and document what “roof” means for each system:
    - lighting occlusion
    - weather visibility
    - distortion masking

- Resource lifecycle:
  - Confirm teardown calls `dispose()` for every effect and manager.
  - Confirm render targets are disposed on scene change.

- Performance:
  - Identify all full-res passes.
  - Identify passes that can be cached.

---

## Notes / References
- `scripts/foundry/canvas-replacement.js` is the true runtime orchestrator.
- `EffectComposer` already provides float precision post chain and overlay isolation.
- `SceneComposer` now has non-trivial logic for mask source selection and composite masks.

---

## Additional Findings (Reliability + Foundry Parity)

### A) Foundry v12+ Tile model: overhead vs roof vs restrictions (important parity anchor)
From `foundryvttsourcecode`:
- `common/documents/tile.mjs`
  - `tile.overhead` is **deprecated** (v12→v14) and is derived as:
    - `tile.elevation >= tile.parent.foregroundElevation`
  - `tile.roof` is **deprecated** and migrates to `tile.restrictions.{light,weather}`.
  - Tiles have:
    - `restrictions.light` and `restrictions.weather`
    - `occlusion.mode` and `occlusion.alpha`
- `client/canvas/layers/tiles.mjs`
  - Foreground tool filters controllables by:
    - `overhead = tile.document.elevation >= scene.foregroundElevation`
- `client/canvas/placeables/tile.mjs`
  - `tile.isVisible = !tile.document.hidden || game.user.isGM`
  - `_refreshMesh()` wires:
    - `mesh.restrictsLight = tile.document.restrictions.light`
    - `mesh.restrictsWeather = tile.document.restrictions.weather`
    - `mesh.occlusionMode = tile.document.occlusion.mode`
    - `mesh.occludedAlpha = tile.document.occlusion.alpha`
    - `mesh.hoverFade = mesh.isOccludable`

Implications for MapShine:
- **We should treat `restrictions.weather` as the canonical “roof blocks weather” signal**, not a custom boolean like `tile.overhead` (deprecated) and not only `overheadIsRoof`.
- **We should treat `occlusion.mode` + `occlusion.alpha` as the canonical “roof hiding/fading” behavior**, rather than inventing semantics that don’t map onto Foundry’s.

Reliability/compatibility risk in current TileManager:
- `syncAllTiles()` currently uses:
  - `isOverhead = (tileDoc.elevation >= foregroundElevation) || !!tileDoc.overhead`
  - `tileDoc.overhead` is deprecated and may be removed in v14.

Recommendation:
- Remove reliance on `tileDoc.overhead` and derive overhead strictly from `elevation >= foregroundElevation`.
- Incorporate `tileDoc.restrictions.weather` into our “roof” pipeline:
  - It should drive weather visibility and roof alpha passes.
  - `overheadIsRoof` can remain as a MapShine-specific override, but should default to (or merge with) `restrictions.weather` for parity.

### B) Roof/overhead occlusion parity: Foundry uses occlusion state + hover-fade
Foundry’s occlusion stack is not just “tile visible vs hidden”. It has:
- A per-object occlusion state machine (hover fade, vision occlusion, etc.)
- A dedicated concept of “occludable” and a debounce around rapid changes

MapShine parity risk:
- Our roof/overhead handling is currently split between:
  - Screen-space roof alpha target
  - Custom fade/hide logic
  - DepthWrite toggling when alpha approaches 0
This can diverge from Foundry’s rules for:
- When a roof should fade
- What alpha it should fade to
- Whether it continues to restrict weather/light while faded

Recommendation:
- Define a single internal “roof state” model for a tile which is derived from:
  - `hidden`, `alpha`
  - `restrictions.weather` and `restrictions.light`
  - `occlusion.mode` and `occlusion.alpha`
Then make:
- Lighting roof alpha pass
- Weather roof visibility
- Any roof-depth behavior
all depend on that same model.

### C) Teardown correctness: risk of clobbering Foundry (and other modules) state
`destroyThreeCanvas()` currently calls `restoreFoundryRendering()` which:
- Forces **many** canvas layers to `visible = true`.
- Forces `canvas.visibility.filter.enabled = true`.
- Forces `canvas.app.renderer.background.alpha = 1`.

Reliability risk:
- This “force to defaults” approach can override:
  - Foundry’s own internal decisions
  - user toggles / GM debugging states
  - other modules that intentionally hide or filter layers

Recommendation:
- When enabling MapShine, capture a snapshot of the relevant Foundry layer state (visibility + key filter states).
- On teardown, restore from that snapshot rather than hardcoding everything to “true”.
- Keep the current `restoreFoundryRendering()` as a fallback recovery path, but prefer snapshot restore.

### D) WebGL context loss: context restore likely requires a full scene rebuild
We register `webglcontextlost`/`webglcontextrestored` handlers.

Reliability risk:
- On WebGL context loss, GPU resources (textures, render targets, shader programs) are invalidated.
- Simply resuming the render loop after restore is often insufficient; you may need to recreate:
  - `WebGLRenderTarget`s
  - `THREE.Texture`s
  - Effect materials/programs

Recommendation:
- On `webglcontextrestored`, automatically trigger `resetScene()` (or a lighter “recreate render targets and re-upload textures” path) rather than only resizing/restarting.

### E) Input system invariants are currently contradictory
The doc and some code paths imply “Three handles gameplay interaction”, but `enableSystem()` sets:
- `threeCanvas.style.pointerEvents = 'none'`
- `pixiCanvas.style.pointerEvents = 'auto'`
meaning PIXI owns all interaction.

Reliability risk:
- This mismatch can lead to “Heisenbugs” where interaction works during initial init (when pointerEvents may be `auto`) and then stops after mode toggles.
- It also makes it unclear which layer is authoritative for selection/dragging and which hooks should drive state.

Recommendation:
- Pick one explicit invariant and enforce it:
  - **Option A (PIXI-first interaction)**: treat `InteractionManager` as a visual/selection helper only, and ensure all input comes through Foundry.
  - **Option B (Three-first interaction)**: keep PIXI overlay-only and route primary interaction to Three.
- Whichever is chosen, make `createThreeCanvas()`, `enableSystem()`, and `updateInputMode()` consistent.

### F) Foundry alpha + occlusion math (Tiles): concrete parity details
From Foundry source:
- Tile alpha in the Primary mesh is composed of:
  - `tile.alpha = tile._getTargetAlpha()` (from `PlaceableObject`)
  - `mesh.alpha = tile.alpha * (hidden ? 0.5 : 1)` (Tile `_refreshState`)
  - `mesh.unoccludedAlpha = document.alpha` and `mesh.occludedAlpha = document.occlusion.alpha` (Tile `_refreshMesh`)
- `_getTargetAlpha()` (base `PlaceableObject`) is **drag/preview dependent**:
  - If dragging:
    - Preview object: `0.8`
    - Original object while preview exists: `0.4`
    - Otherwise: `1`
  - If not dragging: `1`
- Occlusion shader multiplies by a mix of `unoccludedAlpha` and `occludedAlpha` based on the occlusion mask:
  - `fragColor *= mix(unoccludedAlpha, occludedAlpha, occlusion)`
  - `occlusion` is derived from RGB occlusion mask channels and the object’s `fade/radial/vision` occlusion state.

Reliability/parity implications:
- If MapShine implements roof fading or “occluded roofs”, we should be careful not to fight Foundry’s own concept of:
  - drag preview alpha
  - hidden-to-GM half-alpha
  - occlusion alpha as a separate multiplier

Practical recommendation:
- Adopt the same conceptual layering:
  1) **Interaction alpha** (drag/preview)
  2) **Hidden alpha scaling** (GM-only visibility scaling)
  3) **Occlusion alpha** (occlusion mode + occludedAlpha)
Even if we don’t replicate every nuance, matching the structure helps compatibility.

### G) Foundry visibility rules (Tokens): tokenVision is part of visibility, not just fog
From Foundry source (`Token#isVisible`):
- If `token.document.hidden` and user is not GM: not visible.
- If `!canvas.visibility.tokenVision`: visible.
- If token is controlled: visible.
- Otherwise, it calls `canvas.visibility.testVisibility(center, {tolerance, object})`.

Parity risk in MapShine:
- Our Three token visibility currently appears to be mostly:
  - hidden tokens visible only to GM
  - otherwise visible
This may diverge from Foundry when `tokenVision` is enabled: tokens outside sight polygons should not render (for non-GMs).

Recommendation:
- TokenManager visibility should consult Foundry visibility when tokenVision is enabled:
  - Prefer using Foundry’s own `token.object.isVisible` if available.
  - Otherwise replicate the minimal call: `canvas.visibility.testVisibility(token.center, {tolerance, object: token.object})`.

### H) Texture loading consistency risk: TileManager uses `fetch/createImageBitmap`
Current state:
- MapShine base/mask textures are generally loaded via Foundry’s `loadTexture` (PIXI-backed), then wrapped into Three textures.
- `TileManager.loadTileTexture()` uses `fetch` + `createImageBitmap` when possible.

Reliability/compatibility risks:
- `fetch()` can fail in Foundry environments depending on:
  - auth/session routing
  - remote storage providers
  - CORS
  - cache-busted query strings
- It also bypasses Foundry’s texture cache, which can cause:
  - duplicate decoding
  - duplicate GPU uploads
  - inconsistent lifetime management (harder to dispose/track)

Recommendation:
- Prefer a single loading path for all scene imagery:
  - Use Foundry’s `loadTexture` (or FilePicker aware loader) as the authoritative fetch/decode path.
  - If `createImageBitmap` is needed for perf, use it only as an optimization on top of a central cache.

### I) Loading screen robustness: async tasks extend beyond overlay fade-in

**Current state:**
The loading overlay fades in at line 1840 (`await loadingOverlay.fadeIn(5000)`), signaling to the user that the scene is ready. However, several critical async tasks continue in the background:

1. **Effect texture loading** (e.g., Water, Lighting, Player Lights):
   - Effects call `loadTexture()` or `THREE.TextureLoader.load()` **after** registration completes.
   - These are fire-and-forget promises; no await blocks the loading screen.
   - Example: `ThreeLightSource` loads cookie textures via `loadTexture(path, {suppressProbeErrors: true}).then(...)` without blocking.

2. **Tile texture loading** (TileManager):
   - Tiles load textures asynchronously in `createTileSprite()`.
   - The `waitForInitialTiles()` call waits only for **overhead tiles** (line 1805), not all tiles.
   - Ground/water tiles may still be decoding when the overlay fades.

3. **Mask loading and GPU operations**:
   - Effects like Water, Specular, and Prism call `setBaseMesh(basePlane, bundle)` which may trigger mask loading.
   - Mask operations (blur, threshold, composite) are GPU-driven but not awaited.

4. **Vision polygon prewarming** (WorldSpaceFogEffect):
   - Fog effect prewarms vision computation in the background (line 1207-1210 in WorldSpaceFogEffect).
   - This is intentionally async to avoid blocking, but it means vision may not be fully ready.

**Reliability/UX implications:**
- **White flash / pop-in**: If a tile texture finishes loading after the overlay fades, it may appear suddenly.
- **Shader stutter**: GPU mask operations may cause frame drops after the overlay is gone.
- **Incomplete state**: Players see a "ready" scene but some effects are still initializing (e.g., water ripples, lighting cookies).
- **Inconsistent experience**: On slow systems, the gap between "overlay fades" and "all effects ready" is large; on fast systems, it's imperceptible.

**Root causes:**
1. **No unified async tracking**: Effects don't report when they're "truly ready" (textures loaded, GPU ops complete).
2. **Fire-and-forget texture loading**: `loadTexture()` and `TextureLoader.load()` are not awaited in effect initialization.
3. **Partial tile wait**: Only overhead tiles are waited for; ground/water tiles are ignored.
4. **No GPU stall detection**: The loading screen doesn't wait for GPU to finish pending operations.

**Recommendations for robustness:**

1. **Introduce an effect readiness API**:
   - Add a `getReadinessPromise()` method to EffectBase that effects can override.
   - Effects that load textures should return a promise that resolves when all textures are loaded and GPU operations are complete.
   - Example:
     ```javascript
     class WaterEffect extends EffectBase {
       async getReadinessPromise() {
         await Promise.all([
           this._waterTexturePromise,
           this._normalMapPromise,
           this._foamTexturePromise
         ]);
         // Optionally wait for GPU to finish mask operations
         await this._ensureMaskCompute();
       }
     }
     ```

2. **Wait for all effects before fading overlay**:
   - After all effects are registered, collect their readiness promises.
   - Await them before calling `loadingOverlay.fadeIn()`.
   - Update the overlay message to "Finishing textures…" during this phase.
   - Example:
     ```javascript
     const readinessPromises = [
       waterEffect.getReadinessPromise?.(),
       lightingEffect.getReadinessPromise?.(),
       // ... all effects
     ].filter(Boolean);
     
     await Promise.race([
       Promise.all(readinessPromises),
       new Promise(r => setTimeout(r, 15000)) // 15s timeout
     ]);
     ```

3. **Wait for all tiles, not just overhead**:
   - Change `waitForInitialTiles()` call to wait for all tiles:
     ```javascript
     await tileManager?.waitForInitialTiles?.({ overheadOnly: false, timeoutMs: 15000 });
     ```
   - This ensures ground/water tiles are decoded before the overlay fades.

4. **GPU stall detection**:
   - After effects are ready, issue a small GPU operation and wait for it to complete.
   - This ensures the GPU pipeline is flushed and no pending operations will cause stutter.
   - Example:
     ```javascript
     const stallDetectRt = new THREE.WebGLRenderTarget(1, 1);
     renderer.setRenderTarget(stallDetectRt);
     renderer.render(new THREE.Scene(), new THREE.Camera());
     renderer.setRenderTarget(null);
     ```

5. **Timeout and graceful degradation**:
   - Set a reasonable timeout (e.g., 20s) for all async operations.
   - If timeout is exceeded, fade the overlay anyway (don't block forever).
   - Log a warning so developers can investigate slow effects.

6. **Per-effect timeout tracking**:
   - Track which effects are slow to initialize.
   - Log this to the console or a debug panel so GMs can identify problematic effects.
   - Example: "Water effect took 3.2s to load textures; consider optimizing."

7. **Deferred texture loading for non-critical effects**:
   - For effects that are "nice-to-have" (e.g., lensflare cookies, player light cookies), defer texture loading to after the overlay fades.
   - Mark these as "background loading" and don't block the main loading sequence.
   - Example:
     ```javascript
     if (isNonCriticalEffect) {
       setTimeout(() => loadCookieTextures(), 500); // Load after overlay is gone
     } else {
       await loadCookieTextures(); // Block loading screen
     }
     ```

**Implementation priority:**
1. **High**: Introduce effect readiness API + wait for all effects before fading overlay.
2. **High**: Wait for all tiles (not just overhead).
3. **Medium**: GPU stall detection to flush pipeline.
4. **Medium**: Per-effect timeout tracking for debugging.
5. **Low**: Deferred texture loading for non-critical effects (optimization).
