# Water Splashes + Bubbles Visibility Investigation (2026-03-17)

## Goal
Restore visible V2 water splashes and underwater bubbles in-scene (including after floor/scene transitions), without relying on manual refresh or debug console toggles.

---

## Current Runtime Truth (from probes)

### Confirmed alive/wired
- `WaterSplashesEffectV2` exists and is initialized.
- Effect/bubbles enabled flags are true.
- `_batchRenderer` exists and is parented to `Scene`.
- Overlay `__water_splash_batch__` is registered and visible.
- `systemToBatchIndexSize` is non-zero (systems are registered in quarks).
- Per-system `emissionOverTime.a/b` are non-zero for sampled systems.
- Emitters are parented to `BatchedRenderer`.
- Water mask texture and floor occluder texture are present.

### Current sampled state
- `sampleUseWaterMaskClip_source = 0`
- `sampleUseWaterMaskClip_batch = 0`
- `waterRenderOrder = 14999` (active floor band render-order fix active)
- `hasPlay = true`, `hasPause = true`, `hasSystem = true`
- `emissionA/B` non-zero
- Still no visible particles

Interpretation: simulation + registration + emission + render-order all appear alive; visibility failure is now likely deeper in render path/material batch behavior rather than simple lifecycle gating.

---

## What Was Changed During Investigation

### 1) FloorCompositor lifecycle retry lock fix (completed)
- `_populatePromise` reset on failed/incomplete populate to prevent one-way lock.
- Populate state reset on dispose.
- Outcome: addresses scene-swap population deadlock class of failures.

### 2) Floor-presence clipping made opt-in (completed)
- Water systems no longer always clipped by floor-presence RT.
- Outcome: avoids self-occlusion path that can zero particle alpha.

### 3) View-dependent spawn fail-open (completed)
- Added fallback when filtered visible points collapse to zero.
- Later disabled view-dependent spawn filtering from update path entirely.
- Outcome: avoids `_msEmissionScaleDynamic=0` silencing buckets.

### 4) Water batch render-order aligned to active floor band (completed)
- Added `_updateBatchRenderOrder(maxFloorIndex)` and call in `onFloorChange`.
- Outcome: water batch now tracks floor band (e.g. 14999 on floor 1), same approach as Fire.

### 5) Water mask clip fail-open (completed)
- Hard-disabled `uUseWaterMaskClip` for water systems to prevent world->mask UV mismatch fully discarding particles.
- Verified clip uniforms now 0 in runtime probes.

### 6) Explicit `system.play()` on all water systems (completed)
- Added `system.play()` in all four water system constructors:
  - foam
  - splash
  - bubble foam
  - bubble splash
- Outcome: aligns startup behavior with Fire; avoids paused-system possibility.

### 7) Hard-visible lifecycle override (completed, temporary diagnostic)
- In `water-splash-behaviors.js` set temporary force-visible logic:
  - bright cyan/magenta tints
  - alpha floor >= 0.9
  - size floor >= 180
- Outcome: behavior-side alpha/size suppression should no longer hide particles. Still no visibility.

---

## What We Have Ruled Out

1. **Not disabled settings**
   - Effect and bubble flags are enabled.

2. **Not missing systems**
   - Floor state has many systems (foam/splash + bubbles variants).

3. **Not zero emission**
   - Sample emission values are > 0.

4. **Not missing scene registration**
   - Batch renderer in scene, emitters parented, systems indexed by quarks.

5. **Not only view-culling mismatch**
   - View-dependent filtering removed from active path.

6. **Not water-mask clipping**
   - Clip now explicitly off (source and batch uniforms), still invisible.

7. **Not floor-band render-order mismatch**
   - Render-order now correctly follows active floor band.

8. **Unlikely caused by Fire color/emissive-over-time work**
   - Fire gradients/emission-over-life live in `fire-behaviors.js` and are not shared with water lifecycle classes.

---

## Most Likely Remaining Failure Zones

### A) Quarks batch material/shader path for water systems
Even with high alpha and size in behavior code, particles do not appear. This points to possible failure in batch shader/material output path, such as:
- batch material alpha being multiplied/overwritten unexpectedly,
- shader patch interaction in water material path,
- batch not drawing expected quads despite registration.

### B) Effective camera/layer pass interaction specific to water batch
Although batch exists and overlay is registered, final composited passes may still exclude/overwrite this content in a way not affecting fire.

### C) Spawn Z / world-space placement edge case
Spawn Z is `GROUND_Z + floorIndex + 0.3`. If another stage or pass assumes different Z/depth semantics for water compared to fire, quads could be effectively hidden despite additive blend.

---

## Code Audit Findings (2026-03-17)

### Render Pass Slot — Step 1 Only (Bus → sceneRT)

`WaterSplashesEffectV2` registers its `_batchRenderer` via:
```javascript
this._renderBus.addEffectOverlay('__water_splash_batch__', this._batchRenderer, 0);
```
`addEffectOverlay` calls `this._scene.add(mesh)` — the mesh (BatchedRenderer Group) is added to the **FloorRenderBus scene**.

The FloorRenderBus scene is rendered at **Step 1** of `FloorCompositor.render()`:
```
renderBus.renderTo(renderer, camera, this._sceneRT)  // Step 1: albedo+overlays → sceneRT
```
After that, the post chain runs sequentially over `_sceneRT`:
```
LightingEffectV2 → SkyColor → ColorCorrection → Filter → WaterEffectV2 → Distortion → AtmosphericFog → Bloom → Sharpen → ... → blit to screen
```

**Particles live in `_sceneRT`. Every post pass reads and rewrites that result.** The water particles are not late-overlay or screen-space — they are baked into the scene RT like tiles.

---

### What Renders ON TOP of Water Particles

#### 1. All Bus Tiles (renderOrder mismatch — HIGH PRIORITY)

Inside `FloorRenderBus`, tile renderOrder is:
```
regular tile:  floorIndex * 10000 + sortWithinFloor        // ~2400 for typical tiles
overhead tile: floorIndex * 10000 + 5000 + sortWithinFloor // ~7400
```
`sortWithinFloor` = `Math.round(rawFoundrySort + 2400)` clamped to 0–4800.

Water particle systems are created with **`renderOrder: 49` hardcoded** in all four `_create*System()` methods. In Three.quarks, `BatchedRenderer.addSystem()` assigns each system to an internal `Batch` (SpriteBatch mesh). The `renderOrder` the SpriteBatch uses depends on three.quarks internals — it likely comes from the particle system's own `renderOrder: 49`, **not** from the `BatchedRenderer` container.

`_updateBatchRenderOrder()` sets **`this._batchRenderer.renderOrder = floorIndex * 10000 + 4999`**, but this updates only the **Group container's** renderOrder. In Three.js, a Group's `renderOrder` does not propagate to its Mesh children — each Mesh sorts independently. The internal SpriteBatch children remain at `renderOrder: 49`.

**Result:** With `depthTest: false` on all materials, Three.js sorts transparent objects by `renderOrder` ascending (lower = drawn first = behind). Particles at renderOrder 49 draw before tiles at renderOrder ~2400. Tiles subsequently composite over the particle pixels via `NormalBlending`, effectively erasing the additive contribution in any tile-covered region.

**Verification query (runtime):**
```javascript
const br = window.MapShine.effectComposer._floorCompositorV2._waterSplashesEffect._batchRenderer;
const batch = br.batches?.[0];
console.log('SpriteBatch renderOrder:', batch?.renderOrder, 'BatchedRenderer renderOrder:', br.renderOrder);
```
If SpriteBatch renderOrder ≠ BatchedRenderer renderOrder, the mismatch is confirmed.

**Fire comparison:** Check whether `FireEffectV2` particle systems also use `renderOrder: 49` or use a higher value. If Fire uses a value above tile range (e.g. ≥ 5000), that explains why Fire shows but Water does not.

#### 2. WaterEffectV2 Post-Processing Pass (fullscreen rewrite)

After lighting, `WaterEffectV2.render()` takes `currentInput` (the lit sceneRT) and writes to `waterOutput`. This is a **fullscreen shader that rewrites all pixels in the water mask area**. If it composites over the existing pixel rather than adding to it, the particle contribution baked into the scene RT could be tinted/replaced by the water composite.

The particle pixels survive as pixel color data through the lighting pass (unless darkness multiplies them to near-zero — but `DEBUG_FORCE_WATER_VISIBLE` forces alpha ≥ 0.9 which should survive even 50% darkness). Post-`WaterEffectV2`, the water zone pixels reflect the water shader's output. Whether the particles are preserved depends on whether `WaterEffectV2` composites (alpha-over) or replaces those pixels.

#### 3. `OVERLAY_THREE_LAYER` on BatchedRenderer Does Not Help Late-Overlay Pass

`initialize()` enables `OVERLAY_THREE_LAYER` (layer 31) on the **BatchedRenderer Object3D container**. The `_renderLateWorldOverlay()` pass uses:
```javascript
camera.layers.set(OVERLAY_THREE_LAYER);  // layer 31 only
renderer.render(scene, camera);           // renders to screen, bypasses post chain
```
Three.js visibility tests are per-object: the camera sees the BatchedRenderer Group (layer 31 match), but the internal SpriteBatch Mesh children are on **layer 0 only** (three.quarks does not replicate parent layers to children). So **no particles render in the late overlay pass**. The `OVERLAY_THREE_LAYER` enable on `_batchRenderer` has no useful effect on particle visibility.

---

### `vMsWorldPos` Shader Patch — worldSpace Particle Issue

`_patchFloorPresenceMaterial` tries to inject `vMsWorldPos` via:
```glsl
vMsWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;
```
For `worldSpace: true` particle systems, each particle's world position is stored in particle attributes, **not** in `offset` (which is the emitter Group's center). The `modelMatrix` of the emitter Group is effectively identity (offset = 0,0,0). This means `vMsWorldPos` would equal the emitter Group origin for all particles in the batch, not the actual per-particle screen position.

The floor presence block uses `vMsWorldPos` only when `uUseWaterMaskClip > 0.5` (currently disabled, value = 0) or `uHasFloorPresenceMap > 0.5` (also currently disabled). So this bug is dormant with current settings but would produce fully wrong clipping if either is re-enabled.

---

### `_filterSceneEdgeUvPoints` — Possible Over-Filtering

With `edgeInsetPx = 24` (hardcoded), the filter removes points within 24px of the scene border:
```javascript
if (u <= uInset || u >= (1.0 - uInset) || v <= vInset || v >= (1.0 - vInset)) continue;
```
For a small scene or a map where water is positioned near the scene edge (e.g. a coastal tile that runs to the edge), this can eliminate most or all valid edge scan points, leaving no spawn locations. If `_loggedPopulateCountsOnce` shows `edgePoints: 0` for a floor despite a confirmed water mask existing, this filter is the cause.

---

### Texture Assets

Systems use:
- `modules/map-shine-advanced/assets/foam.webp` — foam plumes and bubbles
- `modules/map-shine-advanced/assets/particle.webp` — splash rings

If either path returns 404, the texture is null, and `material.map = null`. With `MeshBasicMaterial` and null map, the mesh renders **solid white** at whatever alpha the lifecycle behavior sets — still additive white, but potentially invisible against a white/light background. Confirm both files exist in the assets directory.

---

### `SplashRingLifecycleBehavior._precipMult` 

`frameUpdate()` reads:
```javascript
this._precipMult = Math.max(0.0, Math.min(1.0, precip));
```
When precipitation = 0, `particle.color.w = 0`. **However**, `DEBUG_FORCE_WATER_VISIBLE = true` overrides this to `Math.max(0.9, 0) = 0.9`, so splash particles are not silenced by the precipitation gate in debug mode. This path is ruled out while the debug flag is active.

---

### `FoamPlumeLifecycleBehavior` ownerEffect for Bubble Systems

Bubble foam/splash systems pass `{ params: bubblesParams }` as `ownerEffect`:
```javascript
new FoamPlumeLifecycleBehavior({ params: p })
```
`frameUpdate()` accesses `this.ownerEffect?.params`. This resolves correctly. No bug here.

---

## Render Pipeline Summary (exact order)

```
1. overheadShadows.render()         (captures roof alpha RT)
2. buildingShadows.render()         (captures building shadow RT)
3. syncRuntimeTileState()           (sync tile opacity from TileManager)
4. renderBus.renderTo(sceneRT)      ← WATER PARTICLES DRAW HERE (renderOrder 49)
   - bg solid (Z 998)
   - bg image (Z 999)
   - tiles: renderOrder ~0–9800
   - water BatchedRenderer SpriteBatch: renderOrder 49 (BEHIND tiles)
5. cloudEffect.render()             (cloud shadow RT for lighting)
6. lightingEffect.render(sceneRT→postA)   ← multiplies scene by ambient/darkness
7. skyColor (ping-pong)
8. colorCorrection (ping-pong)
9. filter (ping-pong)
10. waterEffect.render()            ← fullscreen water rewrite pass
11. distortion (ping-pong)
12. atmosphericFog (ping-pong)
13. bloom (ping-pong)
14. sharpen, artistic effects (ping-pong)
15. pixiWorldComposite
16. fogOverlay.compositeToRT
17. lens (ping-pong)
18. blitToScreen
19. _renderLateWorldOverlay()       ← layer 31 only, water batch NOT drawn here
20. cloudTops.blit
21. _renderPixiUiOverlay
```

**Particles at renderOrder 49 render in Step 4, before tiles at ~2400. Tiles overwrite them.**

---

## Next Actions (recommended order, post-audit)

### 1. Verify SpriteBatch renderOrder (fastest confirmation)
Run in browser console:
```javascript
const br = window.MapShine.effectComposer._floorCompositorV2._waterSplashesEffect._batchRenderer;
const batches = br.batches ?? [];
batches.forEach((b,i) => console.log(`batch[${i}] renderOrder:`, b?.renderOrder, 'mesh.renderOrder:', b?.mesh?.renderOrder));
console.log('batchRenderer container renderOrder:', br.renderOrder);
```
Expected if broken: SpriteBatch renderOrder = 49. Expected if somehow working: renderOrder matches `br.renderOrder`.

Also run for fire to compare:
```javascript
const fr = window.MapShine.effectComposer._floorCompositorV2._fireEffect._batchRenderer;
const fb = fr.batches ?? [];
fb.forEach((b,i) => console.log(`fire batch[${i}] renderOrder:`, b?.renderOrder));
```

### 2. Fix renderOrder if mismatch confirmed

In `_createFoamSystem`, `_createSplashSystem`, `_createBubbleFoamSystem`, `_createBubbleSplashSystem`: change hardcoded `renderOrder: 49` to a value above the overhead tile ceiling. The correct value should be computed at system-creation time from the floor band, matching what `_updateBatchRenderOrder` sets on the container:

```javascript
// Replace hardcoded renderOrder: 49 with:
renderOrder: (Number(floorIndex) || 0) * RENDER_ORDER_PER_FLOOR + OVERHEAD_OFFSET,
```

This puts water particles above tiles (renderOrder 5000+ for floor 0, 15000+ for floor 1), consistent with how fire should be rendering. Also update `_updateBatchRenderOrder` to propagate the new floor renderOrder down to all active SpriteBatch children in `_batchRenderer.batches`, not just the container.

### 3. Verify foam.webp and particle.webp exist
```javascript
fetch('modules/map-shine-advanced/assets/foam.webp').then(r => console.log('foam status:', r.status));
fetch('modules/map-shine-advanced/assets/particle.webp').then(r => console.log('particle status:', r.status));
```
404 on either → textures are null → silent rendering failure.

### 4. A/B: temporarily set particle renderOrder above overhead range at creation and retest
If the renderOrder fix in step 2 makes particles appear, the root cause is confirmed. If they still don't appear, move to:

### 5. Check WaterEffectV2 composite behavior over particle pixels
Determine whether the water post-processing pass replaces or preserves existing pixel values in the water zone. If it always writes output (non-additive, replaces), particle pixels baked into the scene RT are overwritten.

### 6. Remove `OVERLAY_THREE_LAYER` from `_batchRenderer` if renderOrder fix is enough
`_batchRenderer.layers.enable(OVERLAY_THREE_LAYER)` has no effect on particle rendering (SpriteBatch children stay on layer 0). Remove the call to avoid confusion.

---

## Notes
This document is a live investigation log. Keep updates incremental and retain failed hypotheses so regressions can be traced quickly.
