# Record of Failure in Layering

## Problem Statement
When on the ground floor, the upper floor tile causes two visible artifacts in the water effect:
1. **Smooth curved cutout** — water effect completely absent in a shape matching the upper floor tile's alpha silhouette
2. **Squared rectangular border** — subtle darkening/clipping in a hard rectangle matching the upper floor tile bounds
3. **Distortion on upper floor** — water distortion from the ground floor bleeds up onto the upper floor tile surface

---

## Attempt 1 — Remove `floorPresence` gate from DistortionManager apply shader
**Files:** `DistortionManager.js`
**What was changed:** Removed `(1-floorPresence)` from `waterVisible`, `mask01`, `windowBright`. Removed below-floor water tinting block.
**Rationale:** `_activeFloorKey` pointed to the upper floor after the render loop, so `tFloorPresence` = upper floor's `floorAlpha` → `floorPresence=1` → `waterVisible=0` → water killed.
**Result:** ❌ No visible change. The smooth curved cutout and rectangular border remained. The `floorPresence` gate was a real bug but not the primary cause of the visible artifacts.

---

## Attempt 2 — Clamp `depthOccluder` in DistortionManager apply shader
**Files:** `DistortionManager.js`
**What was changed:** Clamped `aboveGround` to `0..10` before smoothstep in the apply shader's depth occluder.
**Rationale:** Upper-floor tiles at elevation 200+ produce `aboveGround=200` → `depthOccluder=1.0` → hard rectangular cutout.
**Result:** ❌ No visible change. The rectangular cutout remained.

---

## Attempt 3 — Fix `_activeFloorKey` usage in DistortionManager render method
**Files:** `DistortionManager.js`
**What was changed:** Used `window.MapShine.activeLevelContext` instead of `_compositor._activeFloorKey` to look up `floorAlpha` for `tFloorPresence`.
**Rationale:** `_activeFloorKey` was stale (pointing to upper floor after loop), causing wrong `floorAlpha` to be bound.
**Result:** ❌ No visible change. The `floorPresence` gate was already not the primary cause.

---

## Attempt 4 — Add `levelsAbove` flag to gate `waterOccluderMesh` visibility
**Files:** `tile-manager.js`
**What was changed:** Added `sprite.userData.levelsAbove` flag set during `updateSpriteVisibility` when a tile is visible but above the active floor band. Gated `waterOccluderMesh.visible` on `!levelsAbove && !levelsHidden` in all 4 places it's set.
**Rationale:** The smooth curved cutout follows the upper floor tile's alpha silhouette exactly — this is the `waterOccluderMesh` being active for the upper floor tile. `mesh.visible = !!sprite.visible` was true because the upper floor tile IS visible from the ground floor.
**Result:** ⚠️ Partially effective — smooth curved cutout reduced but distortion still bleeds onto upper floor. Rectangular border unchanged.

---

## Attempt 5 — Remove `depthOccluder` from DistortionManager COMPOSITE shader
**Files:** `DistortionManager.js`
**What was changed:** Removed `depthOccluder` calculation from the composite shader (set to `0.0`).
**Rationale:** The composite shader writes to an RT sampled next frame — depth-based gate here lags by one frame on camera movement, matching the "lagging rectangle" description.
**Result:** ⚠️ Lagging rectangle may be reduced but rectangular border still visible in screenshot.

---

## Attempt 6 — Remove `depthOccluder` from WaterEffectV2 (WRONG — reverted)
**Files:** `WaterEffectV2.js`
**What was changed:** Removed `depthOccluder` entirely from `WaterEffectV2`.
**Rationale:** Depth buffer contains all-floor geometry.
**Result:** ❌ Made things worse — water appeared across the upper floor tile surface. Reverted.

---

## Attempt 7 — Restore `depthOccluder` to WaterEffectV2 with clamped window
**Files:** `WaterEffectV2.js`
**What was changed:** Restored `depthOccluder` with `aboveActiveFloor` clamped to `0..10` window.
**Rationale:** Needed to suppress water on upper-floor tile surfaces. The clamped window prevents cross-floor contamination.
**Result:** ⚠️ Water on upper floor suppressed, but distortion still bleeds onto upper floor. Rectangular border still visible.

---

## Root Cause Analysis (confirmed)

### Depth value ranges (from DepthShaderChunks.js)
- Camera at Z=2000, ground at Z=1000, `uGroundDistance` ≈ 1000
- `aboveGround = uGroundDistance - linearDepth`
- Ground tiles: `aboveGround ≈ 0`
- BG tiles (Z+1): `aboveGround ≈ 1`
- FG tiles (Z+2): `aboveGround ≈ 2`
- Tokens (Z+3): `aboveGround ≈ 3`
- Overheads (Z+4): `aboveGround ≈ 4`
- **Upper floor tile at elevation 200: `aboveGround ≈ 200`**

### Why `clamp(aboveGround, 0, 10) + smoothstep(2.75, 3.25)` was WRONG
- For upper-floor tiles: `aboveGround=200` → clamped to `10` → `smoothstep(2.75, 3.25, 10) = 1.0` → `depthOccluder=1.0`
- This means the "fix" to clamp was actually making things WORSE — it was still firing for upper-floor tiles
- The clamp prevented values > 10 from being passed to smoothstep, but smoothstep(2.75, 3.25, 10) = 1.0 anyway
- The correct fix: use `if (aboveGround < 10.0)` to exclude cross-floor geometry entirely

### Why the composite shader's `depthOccluder` caused a lagging rectangle
- Composite shader writes to an RT sampled next frame → one-frame lag on camera movement
- The `depthOccluder` in the composite shader was suppressing distortion writing for upper-floor pixels
- But it was also the only thing preventing distortion from being written to upper-floor tile pixels

### Correct approach
- **Composite shader**: Use `step(10.0, aboveGround)` — hard cutoff that fires ONLY for cross-floor geometry (aboveGround ~200), never for same-floor geometry (aboveGround 0-4). This suppresses distortion writing to upper-floor pixels without lagging.
- **Apply shader (DistortionManager + WaterEffectV2)**: Use `if (aboveGround < 10.0) { smoothstep(...) }` — same-floor token/overhead occlusion only, cross-floor tiles excluded.

---

## Attempt 8 — Restore composite shader depth gate with `step(10.0, aboveGround)`
**Files:** `DistortionManager.js` composite shader
**What was changed:** Replaced the zeroed-out `depthOccluder` with `step(10.0, aboveGround)` — fires only for cross-floor geometry (aboveGround ~200), never for same-floor geometry (0-4).
**Rationale:** The composite shader must suppress distortion writing for pixels covered by above-floor tiles. Using `step(10.0)` correctly distinguishes cross-floor from same-floor geometry.
**Result:** ❌ Water flooded the upper floor — `step(10.0, aboveGround)` did NOT suppress it. Assumption about depth values was WRONG. The upper floor tile pixels are NOT registering `aboveGround >= 10` in the depth buffer. The depth pass camera may not capture upper-floor tiles at all, or their Z values are not what was assumed.

---

## Attempt 9 — Fix apply shader `depthOccluder` in DistortionManager and WaterEffectV2
**Files:** `DistortionManager.js` apply shader, `WaterEffectV2.js`
**What was changed:** Replaced `clamp(aboveGround, 0, 10) + smoothstep(2.75, 3.25)` with `if (aboveGround < 10.0) { smoothstep(2.75, 3.25, aboveGround) }`. Cross-floor tiles (aboveGround ~200) are now excluded from the depth gate entirely.
**Rationale:** The previous clamp approach was wrong — `smoothstep(2.75, 3.25, 10.0) = 1.0` so upper-floor tiles still triggered `depthOccluder=1.0` → rectangular border.
**Result:** ❌ Square border still visible. Water flooding upper floor. The `if (aboveGround < 10.0)` gate means cross-floor tiles now have `depthOccluder=0` → no suppression at all. This is the opposite of what was needed.

---

## CRITICAL INSIGHT: Depth-based approach is fundamentally broken for this use case

The depth buffer approach has failed repeatedly because:
1. We don't know the actual `aboveGround` values for upper-floor tiles in this scene
2. The depth pass camera may have tight near/far bounds that don't capture upper-floor tiles
3. Even if it does, the Z values depend on elevation settings that vary per scene
4. Every attempt to use depth to distinguish floors has either over-suppressed (killing ground water) or under-suppressed (flooding upper floor)

**The depth buffer is the WRONG tool for per-floor isolation.** It contains geometry from all floors with no reliable way to distinguish which floor a pixel belongs to.

## New Strategy: Stop using depth entirely for cross-floor isolation

The correct approach is to use **the water mask itself** as the gate — water should only appear where the water mask says there is water. The upper floor tile flooding means the water mask (SDF) extends into the upper floor area, OR the apply pass is applying water tint/caustics to pixels that are outside the water mask bounds.

The `waterVisible` gate in both shaders should be sufficient IF the water mask correctly excludes the upper floor area. The question is: why is water appearing on the upper floor at all when `waterVisible = (1 - waterOccluder) * (1 - depthOccluder)`?

Possible causes:
- `inside` (from SDF) is non-zero for upper floor pixels → water mask extends there
- The distortion RT has non-zero `waterMask` values for upper floor pixels → composite shader wrote them there
- The `tWaterOccluderAlpha` is 0 for upper floor pixels (no occluder mesh there) → `waterOccluder=0` → no suppression

---

## Attempt 10 — Above-floor blocker mesh in waterOccluderScene
**Files:** `tile-manager.js`, `DistortionManager.js`, `WaterEffectV2.js`
**What was changed:**
- All depth-based gates reverted to `depthOccluder = 0.0` (disabled) in both composite and apply shaders
- Added `_ensureAboveFloorBlockerMesh` / `_updateAboveFloorBlockerMeshTransform` to `tile-manager.js`
- The blocker mesh renders to `waterOccluderScene` (layer 22, same as `waterOccluderMesh`) using the tile's alpha texture
- Visible ONLY when `levelsAbove=true` — the inverse of `waterOccluderMesh`
- Writes `alpha=1` to `tWaterOccluderAlpha` → `waterOccluder=1` → `waterVisible=0` in both shaders
- Wired up at all 6 call sites alongside `_ensureWaterOccluderMesh`, plus cleanup on tile removal
- `updateSpriteVisibility` syncs blocker mesh visibility when `levelsAbove` changes
**Rationale:** Depth buffer cannot reliably detect upper-floor tiles (depth camera tight bounds may clip them). Instead, explicitly mark upper-floor tile pixels as "no water" by writing to the occluder RT from the CPU-side visibility system which already knows which tiles are above the current floor.
**Result:** ❌ FAILED — water still floods upper floor
**Root cause diagnosed:** The upper floor tiles in the scene are **overhead tiles of the current floor** (`isOverhead=true`, `levelsAbove=false`). They are NOT tiles from a different floor — they are the current floor's overhead/roof tiles rendered above the scene. Therefore:
- `levelsAbove=false` → `aboveFloorBlockerMesh.visible=false` → no blocking
- `occludesWater=false` (no `_Water` mask) → no `waterOccluderMesh` either
- Water SDF covers their world-space area → water floods them
The `levelsAbove` approach was a complete misdiagnosis. The problem is overhead tiles, not cross-floor tiles.

---

## Attempt 11 — Overhead tiles must write to tWaterOccluderAlpha
**Root cause:** Overhead tiles (`isOverhead=true`) are current-floor tiles rendered above the scene. They should suppress water effects beneath them — a roof tile should not show water tint/caustics/distortion on its surface. The `waterOccluderMesh` is only created for tiles with `occludesWater=true`, but overhead tiles typically don't have a `_Water` mask so they never get an occluder mesh.
**Fix:** The `aboveFloorBlockerMesh` (already created for all tiles) should be visible for overhead tiles too — not just `levelsAbove` tiles. Overhead tiles are the current floor's ceiling/roof and should block water just like any opaque tile.
**What was changed:**
- `updateSpriteVisibility`: `aboveFloorBlockerMesh.visible` now also fires for `isOverhead=true` tiles
- `_ensureAboveFloorBlockerMesh`: visibility init also checks `isOverhead`
**Result:** ❌ FAILED — water still floods overhead tiles
**Root cause diagnosed:** `setWaterOccluderScene` only migrated `waterOccluderMesh` objects, NOT `aboveFloorBlockerMesh`. The call order is:
1. Tiles load → `_ensureAboveFloorBlockerMesh` called → `this.waterOccluderScene` is still `null` → mesh added to `this.scene` (fallback)
2. `setWaterOccluderScene(distortionManager.waterOccluderScene)` called → migrates `waterOccluderMesh` only → blocker meshes stay in `this.scene`
3. `_renderWaterOccluders` renders `distortionManager.waterOccluderScene` → blocker meshes are NOT in it → `tWaterOccluderAlpha` stays black → no suppression
The blocker mesh was in the wrong scene the entire time.

---

## Attempt 12 — Fix setWaterOccluderScene to migrate aboveFloorBlockerMesh
**Files:** `tile-manager.js`
**What was changed:**
- `setWaterOccluderScene`: added migration of `aboveFloorBlockerMesh` alongside `waterOccluderMesh`
- Both mesh types now correctly move to the real `waterOccluderScene` when it is assigned
**Result:** ❌ FAILED — water still floods upper floor

---

## STOP. We are going in circles.

12 attempts. Every approach has been based on assumptions about what's happening at runtime that have never been verified. The correct next step is to add diagnostic tooling and READ the actual runtime state before writing any more fix code.

**What we have never verified:**
1. Whether `tWaterOccluderAlpha` actually has non-zero alpha at overhead tile pixels at runtime
2. Whether `aboveFloorBlockerMesh` objects are actually in `distortionManager.waterOccluderScene` at render time
3. Whether `shouldBlock` is actually `true` for the flooding tiles
4. Whether `WaterEffectV2` or `DistortionManager` apply pass is the actual source of the flooding visual
5. Whether `uHasWaterOccluderAlpha` is actually `1.0` when the shader runs

**Diagnostic approach (Attempt 13):**
- Add `window.MapShine.debugWaterOccluder()` console function that dumps all blocker mesh state
- Add debug view 8 to WaterEffectV2 (already exists) — user can call `window.MapShine.waterEffect.setDebugView(8)` to visualize `tWaterOccluderAlpha`
- Debug view 8 was unreachable (d < 12.5 fired before d < 8.5) — showed outdoors mask instead of occluder
- **Key insight from debug image**: the approach of using screen-space occluder meshes is fundamentally wrong. The water SDF is a world-space texture built from the `_Water` mask. It covers the entire scene including areas under overhead tiles. No screen-space occluder can fix this because the SDF is baked at composition time.

---

## Attempt 13 — World-space water mask patch in GpuSceneMaskCompositor
**Files:** `GpuSceneMaskCompositor.js`
**Root cause (final):** The water SDF (`tWaterData`) is built from the ground floor `_Water` mask via `WaterSurfaceModel.buildFromMaskTexture`. This mask covers the full scene area including pixels that are visually covered by upper floor overhead tiles. The water effect applies to ALL pixels where `inside > 0` in the SDF — regardless of what's rendered there. No screen-space fix can work because the SDF is baked before rendering.
**Correct fix:** Patch the ground floor's `water` RT in world space, at composition time, BEFORE the SDF is built:
1. Subtract upper floor tile albedo alpha (punch out where overhead tiles are opaque)
2. Add back upper floor `_Water` mask (if it exists — water on the upper floor)
**What was changed:**
- Added `WATER_PATCH_FRAG` shader: `result = clamp(water - upperFloorAlpha, 0, 1) + upperFloorWater`
- Added `_waterPatchMaterial`, `_waterPatchMesh`, `_waterPatchScene`, `_waterPatchTempRt` to compositor
- Added `_patchWaterMasksForUpperFloors(sortedFloorKeys)` — runs after all floors are composed, patches each lower floor's water RT using upper floor `floorAlpha` and `water` RTs
- Called from `preloadAllFloors` after the per-band composition loop
- Proper disposal in `dispose()`
**Result:** ❌ FAILED — water still floods upper floor identically. The patch either did not run, ran too late (after WaterEffectV2 already built the SDF from the un-patched RT), or the `floorAlpha` RT for the upper floor was not available at patch time.

**Conclusion:** The compositor-side patch approach is unreliable due to async timing between `preloadAllFloors` and `bindFloorMasks`. The SDF pipeline itself is the problem — it bakes a static texture that cannot be easily patched. Replace with direct raw mask sampling in the shader, eliminating the SDF entirely for the cross-floor isolation problem.

---

## Attempt 14 — Floor ID texture gate in WaterEffectV2 and DistortionManager shaders
**Files:** `WaterEffectV2.js`, `DistortionManager.js`
**Approach:** The `floorIdTarget` is a world-space texture (scene UV) where each pixel's R channel encodes the topmost floor index / 255. This is already built by `buildFloorIdTexture()` and updated on every floor transition. Gate `waterVisible = 0` in both shaders wherever `floorIdR > uActiveFloorIndex + 0.002`. This is:
- **Per-frame, live** — no baking, no async, no timing issues
- **World-space** — uses scene UV, same coordinate space as the water mask
- **Definitive** — if the floor ID says a higher floor is on top, water is suppressed regardless of what the SDF says

**What was changed:**
- `WaterEffectV2.js`: Added `tFloorIdTex`, `uHasFloorIdTex`, `uActiveFloorIndex` uniforms. In `main()`, after computing `waterVisible` from `tWaterOccluderAlpha`, added floor ID gate: if `floorIdR > uActiveFloorIndex + 0.002` → `waterVisible = 0`. Bound from `_syncUniforms` via `compositor.floorIdTarget.texture` and `floorStack.getActiveFloor().index`.
- `DistortionManager.js`: Same uniforms added to `applyMaterial`. Same gate added after `waterVisible` computation in the apply shader. Bound in the `au` block of `render()`.
**Result:** ❌ FAILED — but the diagnostic revealed the ACTUAL root cause for the first time.

**Actual root cause (confirmed by MapShine.diagWater()):**
- `uHasFloorIdTex=1`, `uActiveFloorIndex=1/255`, floor ID center pixel=1 — gate is correctly set up
- BUT: `_floorCache keys: ["10:20"]` — only the upper floor has GPU render targets
- `_floorMeta keys: ["0:10", "10:20"]` — ground floor bundle loaded from file, no GPU water RT
- `activeLevelContext: { bottom:10, top:20, index:1 }` — user IS on the upper floor
- The gate fires `if (floorIdR > activeIndex + 0.002)` = `if (1/255 > 1/255 + 0.002)` = **false** — gate never suppresses because the user is ON the upper floor and the floor ID correctly says upper floor everywhere

**The real problem**: `preserveAcrossFloors=true` on the `water` mask type causes the ground floor `_Water` mask (and its SDF) to be kept active when transitioning to the upper floor. The upper floor has no `_Water` mask. The preserved SDF covers the full scene including upper floor tiles. The floor ID gate cannot help — it only suppresses water when a HIGHER floor is on top of the current floor, not when the current floor has a preserved water mask from a lower floor.

**Correct fix**: When the active floor has no `_Water` mask of its own, disable the water effect entirely. The `preserveAcrossFloors` policy for water is wrong for this use case — water should NOT be preserved to floors that don't have their own `_Water` mask.

---

## Attempt 15 — Change water mask `preserveAcrossFloors` from `true` to `false`
**Files:** `EffectMaskRegistry.js` (1 line), `WeatherParticles.js` (comment update)
**Root cause confirmed:** `preserveAcrossFloors: true` on the `water` mask type caused the ground floor `_Water` mask (and its SDF) to be kept active in the registry when transitioning to the upper floor. The upper floor had no `_Water` mask, so the preserved ground floor SDF — which covers the full scene — remained bound to `WaterEffectV2`, flooding the upper floor.
**Fix:** `water: { preserveAcrossFloors: false, ... }` — when transitioning to a floor with no `_Water` mask, the water slot is cleared and `_notifySubscribers('water')` fires with `texture=null`.
**Result:** ❌ FAILED — the registry correctly cleared the water slot and notified subscribers, but the subscriber callback in `WaterEffectV2.connectToRegistry()` only nulled `_waterData`, `_waterRawMask`, `_lastWaterMaskUuid` and disposed the `_surfaceModel`. It **did not null `this.waterMask`** or `_lastWaterMaskCacheKey`. This caused two cascading failures:
1. `getWaterMaskTexture()` returned the stale ground-floor mask → DistortionManager's `waterSource.mask` stayed non-null → `uHasWaterMask=1` → caustics/tint/murk continued rendering on the upper floor.
2. `_rebuildWaterDataIfNeeded(false)` in `update()` found `this.waterMask` non-null and `_waterData?.texture` null (disposed), so it rebuilt the SDF from the stale mask, undoing the registry's clear entirely → `uHasWaterData` flipped back to 1.0 → WaterEffectV2 post-processing also showed water again.

---

## Attempt 16 — Null `this.waterMask` in registry subscriber null-texture callback
**Files:** `WaterEffectV2.js` (2 lines added), `EffectComposer.js` (comment update), `canvas-replacement.js` (comment update)
**Root cause (of Attempt 15 failure):** The `connectToRegistry` subscriber's `!texture` branch cleared derived state but left the source mask reference (`this.waterMask`) intact. All downstream paths that check `this.waterMask` continued using the stale ground-floor texture.
**Fix:** Added `this.waterMask = null;` and `this._lastWaterMaskCacheKey = null;` to the `!texture` branch of the registry subscriber callback. This ensures:
- `getWaterMaskTexture()` returns null → DistortionManager disables water source → `uHasWaterMask=0`
- `_rebuildWaterDataIfNeeded()` early-returns on `if (!this.waterMask) return` → SDF is never rebuilt from stale data
- `uHasWaterData` stays 0 → WaterEffectV2 post-processing exits early
**Result:** ❌ FAILED — Water on the ground floor stops working entirely when moving to the upper floor. The fix correctly killed water on the upper floor but ALSO killed ground-floor water visible through gaps in upper-floor tiles. This is because WaterEffectV2 and DistortionManager are both global POST_PROCESSING effects — they run once per frame for the entire screen. Setting `waterMask = null` disables water for ALL pixels. There is no per-pixel floor discrimination — the system can either show water everywhere or nowhere.

**Deeper insight:** Attempts 1–16 all operated on the assumption that water can be toggled on/off at the effect level during floor transitions. This is fundamentally wrong. The ground floor is still visible through gaps in upper-floor tiles — water must remain active on those ground-floor pixels while being suppressed under upper-floor tile coverage. This requires **per-pixel floor discrimination in the shader**, not effect-level state management.

---

## Architectural Analysis — Why This Bug Is So Persistent

### The Fundamental Problem

WaterEffectV2 (POST_PROCESSING) and DistortionManager (POST_PROCESSING) both run **once per frame for the entire screen**. They are excluded from the per-floor render loop in EffectComposer. When the user is on the upper floor, both floors are visible simultaneously — ground floor through gaps, upper floor tiles on top. Water must appear on ground-floor pixels and be suppressed on upper-floor pixels. No amount of effect-level enable/disable or mask preserve/clear can achieve this — it requires **per-pixel** decisions.

### The DistortionManager Entanglement

Water rendering is split across two independent systems:
1. **WaterEffectV2** — refraction, waves, specular (`uHasWaterData` gate)
2. **DistortionManager** — tinting, caustics, murk, sand, foam, chromatic aberration (`uHasWaterMask` gate)

WaterEffectV2 syncs its water mask + params to the DistortionManager via `dm.updateSourceMask('water', ...)` and `dm.updateSourceParams('water', ...)` in its `update()` method. This creates:
- **Double state management:** Every water state change must propagate to both systems
- **Stale state risk:** DistortionManager's `waterSource.mask` is a separate reference that lags one frame behind WaterEffectV2's authoritative state
- **Double floor-awareness:** Any per-pixel floor gating must be implemented in BOTH shader codebases independently
- **Double debugging surface:** Each system can independently re-infect the other with stale data

### Existing Infrastructure That Almost Works

1. **Floor ID texture** (`buildFloorIdTexture`) — world-space texture where R = topmost floor index / 255. Already bound to both shaders from Attempt 14. Correctly encodes 0 through gaps and 1 under upper tiles.

2. **Water mask patching** (`_patchWaterMasksForUpperFloors`) — GPU-level patching that subtracts upper floor tile alpha from ground floor water mask. But this only modifies per-floor cached render targets in `_floorCache`. The patched masks are used by `bindFloorMasks()` in the per-floor loop — which **excludes POST_PROCESSING effects**. The registry slot (which WaterEffectV2 subscribes to) receives the **unpatched** mask from `composeFloor()`.

### Why Attempt 14's Floor ID Gate Failed

Attempt 14 added floor ID gating with: `if (floorIdR > uActiveFloorIndex + 0.002) → waterVisible = 0`

When the user is ON the upper floor (index 1), `uActiveFloorIndex = 1/255`. Under upper floor tiles, `floorIdR = 1/255`. The gate evaluates `1/255 > 1/255 + 0.002` = **false** — it never fires because the user IS on the floor that needs suppression. The comparison was against the wrong reference.

### Correct Approach: Gate Against Water Mask Origin Floor

The gate should compare `floorIdR > uWaterMaskFloorIndex` — suppress water where the topmost floor at this pixel is **above the floor that owns the water mask** (not above the active floor).

- Gap pixels: `floorId=0/255`, `waterFloorIndex=0/255` → `0 > 0` = false → water shows ✓
- Upper floor tile pixels: `floorId=1/255`, `waterFloorIndex=0/255` → `1/255 > 0/255` = true → water suppressed ✓

This requires `preserveAcrossFloors: true` for water (revert Attempt 15) so the ground-floor mask stays bound, then the shader suppresses it per-pixel where upper floors have tile coverage.

### Future Simplification: Decouple Water from DistortionManager

Moving water tinting/caustics/murk into WaterEffectV2's shader would:
- Eliminate the dual-system sync problem
- Reduce floor-awareness to a single shader
- Remove the stale `waterSource.mask` reference risk
- Cut ~300 lines of GLSL from DistortionManager

This is not required for the fix but would make the system far less fragile.

---

## Attempt 17 — Corrected floor ID gating: `uWaterMaskFloorIndex` instead of `uActiveFloorIndex`

**Files:** `EffectMaskRegistry.js`, `WaterEffectV2.js`, `DistortionManager.js`, `EffectComposer.js`, `canvas-replacement.js`

**Reverts:**
- Attempt 15: `preserveAcrossFloors` restored to `true` for water — the ground-floor mask must persist when switching to the upper floor so water renders through gaps.
- Attempt 16: subscriber `!texture` branch kept (safety net) but `preserveAcrossFloors:true` means it won't fire for water.

**Key insight from Attempt 14 failure:** The floor ID gate compared `floorIdR > uActiveFloorIndex`. When the user is ON the upper floor (index 1), upper floor tile pixels have `floorIdR = 1/255`. The gate evaluated `1/255 > 1/255 + 0.002` = false — it never suppressed because the user IS on the upper floor.

**Correct comparison:** Gate against the floor that **owns** the water mask, not the user's active floor. The water mask belongs to the ground floor (index 0). Upper floor tile pixels have `floorIdR = 1/255`. The gate evaluates `1/255 > 0/255 + 0.002` = true → water suppressed under upper tiles. Gap pixels have `floorIdR = 0/255` → `0 > 0 + 0.002` = false → water shows through gaps.

**What was changed:**
- `EffectMaskRegistry.js`: Water `preserveAcrossFloors` restored to `true`.
- `WaterEffectV2.js`: Renamed `uActiveFloorIndex` → `uWaterMaskFloorIndex` in uniform declaration, GLSL declaration, and shader gate. Binding derives floor index from `effectMaskRegistry.getSlot('water').floorKey` matched against `FloorStack.getVisibleFloors()` by `compositorKey`.
- `DistortionManager.js`: Same rename and binding change in apply shader uniforms, GLSL, gate, and `update()`.
- `EffectComposer.js`, `canvas-replacement.js`: Comment updates reflecting `preserveAcrossFloors:true` + floor ID gating.

**Result:** ⚠️ PARTIAL SUCCESS — Masking appeared correct in shape but the water tint (DistortionManager apply pass) was Y-flipped on the upper floor. Ground floor water was unaffected.

**Root cause of Y-flip:** `tFloorIdTex` is built by the compositor's ortho camera using Three.js Y-up convention (`vSceneUv = position.xy * 0.5 + 0.5`, Y=0 at bottom). Both shaders compute `sceneUv` via `foundryToSceneUv(screenUvToFoundry(vUv))` which uses Foundry Y-down convention (Y=0 at top). Sampling `tFloorIdTex` with the unflipped `sceneUv` read the wrong row — the gate fired on the mirrored set of pixels.

**Fix applied:** In both `WaterEffectV2.js` and `DistortionManager.js`, the floor ID texture is now sampled with `vec2(sceneUv.x, 1.0 - sceneUv.y)` to convert from Foundry Y-down to Three.js Y-up before sampling.

**Result after Y-flip fix:** ❌ FAILED — The upper floor tile footprint now cuts a hard rectangular hole in the water on the **ground floor**. The gate fires correctly in coordinate space but the logic is wrong: the floor ID texture records `floorIdR = 1/255` under upper floor tiles even when the player is on the ground floor looking up. The gate `floorIdR > waterMaskFloorIndex` evaluates `1/255 > 0/255` = true and suppresses water under the upper floor tile from below — the exact opposite of what is needed.

**Root cause of all floor ID gating attempts:** The floor ID texture encodes which floor's tile is painted at each pixel, but it does not encode whether the player is above or below that floor. The gate has no way to distinguish "upper floor tile seen from above (suppress water)" from "upper floor tile seen from below (show water)". The floor ID texture is a world-space mask, not a view-dependent one. Any gate based solely on `floorIdR` will either suppress water from above AND below, or suppress it from neither.

---

## Architectural Analysis — Why All Attempts Have Failed

### The Core Contradiction

The system has two conflicting requirements:
1. **From the ground floor:** Water must render everywhere, including under the footprint of upper floor tiles (the player sees the underside of the upper floor, water is below them).
2. **From the upper floor:** Water must NOT render under upper floor tiles (the player is standing on the upper floor, water is on a different floor below).

Both requirements apply to the **same pixels** on screen — the upper floor tile occupies the same screen region regardless of which floor the player is on. A single global post-processing pass cannot satisfy both simultaneously without knowing the player's floor.

### Why Global Post-Processing Is The Wrong Layer

`WaterEffectV2` and `DistortionManager` are global screen-space passes. They run once, see the entire composited scene, and have no concept of "which floor is the player on relative to this water." Every attempt to inject floor-awareness into them has failed because:

- **State-based approaches (Attempts 1-16):** Toggling masks on/off at the effect level is binary — it kills water on ALL floors or none.
- **Floor ID gating (Attempts 14, 17):** The floor ID texture is world-space, not view-dependent. It cannot distinguish "above" from "below."
- **Water occluder mesh (previous attempts):** The occluder is also world-space and suffers the same problem.

### The Correct Architecture

**Water effects must be rendered PER-FLOOR, not globally.**

The per-floor render loop in `EffectComposer` already composites each floor's tiles into a layered scene. Water should be part of that per-floor composition — rendered into the floor's own render target — so that:
- Ground floor water renders into the ground floor RT, clipped to the ground floor's tile bounds.
- Upper floor water (if any) renders into the upper floor RT, clipped to the upper floor's tile bounds.
- The final composite stacks floor RTs in order, so upper floors naturally occlude lower floors.

This means water effects need to move from POST_PROCESSING (global, after composite) to FLOOR_LAYER (per-floor, before composite).

### Practical Path Forward

**Option A — Per-floor water RT (correct but large refactor):**
- Render water into each floor's own render target during the per-floor loop.
- Requires WaterEffectV2 to be instantiated per-floor or to render into a floor-specific RT.
- The final composite naturally handles occlusion — no floor ID gating needed.

**Option B — Active floor index gate (simple, correct for the common case):**
- Keep water as a global pass but gate it by the **active player floor**.
- When the player is on the ground floor: render water everywhere (no suppression needed — upper floor tiles are rendered on top of the water in the scene composite, naturally occluding it).
- When the player is on the upper floor: suppress water under upper floor tiles using the floor ID gate.
- Key insight: **the scene composite already handles occlusion from below**. Upper floor tiles are rendered into the scene on top of the ground floor. The water post-process runs after the composite, so it paints water on top of the already-composited scene — including on top of upper floor tiles. The gate is only needed when the player is on the upper floor.
- Implementation: `if (uActiveFloorIndex > uWaterMaskFloorIndex + 0.002)` → enable the floor ID gate. Otherwise skip it entirely.

**Option B is the minimal correct fix.** The gate should only activate when the player is ABOVE the water mask's floor. When the player is on the same floor as the water, the scene composite already handles tile occlusion correctly.

---

## Attempt 18 — Conditional floor ID gate: only suppress when player is above water floor

**Approach:** Keep `uWaterMaskFloorIndex` but add `uActiveFloorIndex` back as a second uniform. Only enable the floor ID gate when `uActiveFloorIndex > uWaterMaskFloorIndex + 0.002` (player is above the water's floor). When on the same floor, skip the gate entirely — the scene composite already occludes water under tiles correctly.

**Logic:**
- Player on ground floor (`uActiveFloorIndex == uWaterMaskFloorIndex`): gate skipped. Upper floor tiles are composited on top of the scene before the water post-process runs — they naturally occlude water from below. No shader suppression needed.
- Player on upper floor (`uActiveFloorIndex > uWaterMaskFloorIndex`): gate active. Suppress water on pixels where `floorIdR > uWaterMaskFloorIndex` — i.e. where an upper floor tile is painted.

**Files changed:** `WaterEffectV2.js`, `DistortionManager.js` — added `uActiveFloorIndex` uniform + binding in both; changed gate condition from `if (uHasFloorIdTex > 0.5)` to `if (uHasFloorIdTex > 0.5 && uActiveFloorIndex > uWaterMaskFloorIndex + 0.002)`.

**Result:** ❌ FAILED — Water is still suppressed under the upper floor tile footprint when on the ground floor. The assumption that "the scene composite already occludes water under tiles" was wrong. The water post-process runs AFTER the scene composite and paints tint/caustics over the entire scene — including over upper floor tiles that are already composited in. The gate was still firing because `uActiveFloorIndex (0) > uWaterMaskFloorIndex (0)` = false correctly skips the gate, but the water tint still renders over the upper floor tile pixels because the **water mask itself** covers that area.

**Root cause finally identified:** The water mask (`tWaterMask` / `waterSource.mask`) is the **raw unpatched registry texture** — the ground floor `_Water` mask painted by the map author. It covers the entire water area including the footprint of upper floor tiles. `_patchWaterMasksForUpperFloors()` in `GpuSceneMaskCompositor` creates a corrected version with upper floor tile footprints subtracted, but this patched version lives in `_floorCache` and is only used by the per-floor `bindFloorMasks()` loop — which **excludes POST_PROCESSING effects**. The water post-processing effects always receive the unpatched mask.

**All floor ID gating approaches (Attempts 14-18) were wrong** because they tried to suppress water per-pixel in the shader, but the water mask itself is the problem — it's the wrong texture. No shader gate can reliably distinguish "water under upper floor tile" from "water in gap" using only the floor ID texture without also knowing the exact tile footprint.

---

## Correct Approach — Use the Patched Water Mask

`GpuSceneMaskCompositor._patchWaterMasksForUpperFloors()` already creates the correct water mask for the ground floor: the raw water mask with upper floor tile alpha subtracted. This patched RT lives at `_floorCache.get(groundFloorKey).get('water')`.

The fix: when the player is on an upper floor, the water post-processing effects should use the **patched** ground floor water mask from `_floorCache` instead of the raw registry texture. This requires:
1. Exposing a method on `GpuSceneMaskCompositor` to retrieve the patched water mask for a given floor key.
2. In `WaterEffectV2.update()` and `DistortionManager.update()`, when the active floor is above the water mask's floor, swap `tWaterMask` to the patched version.
3. No shader changes needed — the mask itself will be correct.

This is architecturally clean: the patching logic already exists and is correct. We just need to route its output to the POST_PROCESSING effects.

---

## Attempt 19 — Use patched water mask from compositor cache

**Approach:** `GpuSceneMaskCompositor.getFloorTexture(floorKey, 'water')` already exists and returns the patched water mask RT from `_floorCache`. In both `WaterEffectV2.update()` and `DistortionManager.update()`, after the raw `tWaterMask` is set from `waterSource.mask`, check if the player is above the water mask's floor. If so, look up the patched mask and override `tWaterMask`. All floor ID gating uniforms and shader code removed — no shader changes needed.

**Files changed:** `WaterEffectV2.js`, `DistortionManager.js` — removed all `tFloorIdTex`, `uHasFloorIdTex`, `uWaterMaskFloorIndex`, `uActiveFloorIndex` uniforms and GLSL. Added patched mask swap in JS `update()` using `compositor.getFloorTexture(waterFloorKey, 'water')`.

**Result:** ❌ FAILED — Diagnosis revealed the patched mask swap never fired. Debug output:
- `_floorCache` only contained `"10:20"` (upper floor) — ground floor `"0:10"` was never GPU-composited
- `_patchWaterMasksForUpperFloors` built `sortedKeys` from `_floorCache.keys()` only — `"0:10"` was never in the list
- The patch function also skipped floors with no `_floorCache` entry (`if (!lowerTargets) continue`)
- `getFloorTexture("0:10", "water")` returned the raw file-based texture from `_floorMeta` — unpatched
- `activeIdx (0) > waterFloorIdx (0)` = false → swap never triggered anyway (player was on ground floor)
- The water was rendering over the upper floor tile **from the ground floor**, not from the upper floor

**Actual root cause:** The ground floor is always loaded via `_floorMeta` (file-based), never GPU-composited into `_floorCache`. The patch loop only iterated `_floorCache` keys, so the ground floor water mask was **never patched**. The water mask covers the upper floor tile footprint because the map author painted `_Water` there, and no subtraction was ever applied.

---

## Attempt 19b — Fix _patchWaterMasksForUpperFloors to include _floorMeta floors

**Files changed:** `GpuSceneMaskCompositor.js`

**Fix 1:** `sortedKeys` now built from union of `_floorCache.keys()` AND `_floorMeta` keys that have a water mask entry — so `"0:10"` is included.

**Fix 2:** In `_patchWaterMasksForUpperFloors`, when a lower floor has no `_floorCache` entry, bootstrap a GPU RT by blitting the `_floorMeta` water texture into a new RT, register it in `_floorCache`, then patch normally.

**Result:** ❌ FAILED — The bootstrap blit was wrong. `_floorMeta["0:10"]` water texture is the raw **tile-space** mask image from `currentBundle.masks` (loaded from disk). Blitting it with `uTileRect=(0,0,1,1)` stretched the tile-space texture across the full scene RT — producing a garbage scene-space mask. The patch shader then subtracted the wrong pixels.

**Root cause of bootstrap failure:** The ground floor is seeded into `_floorMeta` from `currentBundle.masks` before `preloadAllFloors` loops. The skip guard at line 939 (`if (this._floorMeta.has(bandKey)) continue`) prevents `composeFloor` from running for it — so it never gets a proper scene-space GPU RT in `_floorCache`.

---

## Attempt 19c — Force-compose ground floor to get scene-space GPU RT before patching

**Fix:** In `preloadAllFloors`, after all floors are composed, check for any floor in `_floorMeta` that has water but no `_floorCache` entry. Temporarily evict it from `_floorMeta` (bypassing the skip guard) and re-run `composeFloor(cacheOnly:true)` to produce a proper scene-space GPU RT. Then patch normally. Removed the broken `_floorMeta` bootstrap path from `_patchWaterMasksForUpperFloors`.

**Result:** ❌ FAILED — The force-compose ran but produced no `water` RT in `_floorCache`. Diagnostic confirmed:
- `_floorCache["0:10"]` had no `water` key after force-compose
- `_floorCache["10:20"]` also has no `water` key (only `specular`, `outdoors`, `fire`, `windows`, `floorAlpha`)
- Upper `floorAlpha` RT center pixel = R=255 (tile is there, data is correct)

**Definitive root cause:** `composeFloor`'s GPU compositor loop (line ~437) iterates `allMaskTypes` and calls `_composeMaskType`. But the `preserveAcrossFloors` filter in the fallback path (line 733) strips water from the bundle output. More critically: the GPU compositor itself at line 437 iterates ALL mask types and composes them into `_floorCache` RTs — BUT the `_patchWaterMasksForUpperFloors` function was designed to use these RTs, and water IS composed into `_floorCache` by the GPU path. The problem is that `composeFloor` for the ground floor goes through the **fallback path** (Step 3/4), not the GPU compositor path (Step 2), because there are no tile mask entries for the ground floor band — the ground floor uses the scene background image, not per-tile masks. The GPU compositor path only runs when `tileMaskEntries.length > 0`. With no tile entries, no GPU RTs are created, and `_floorCache["0:10"]` stays empty.

**The entire `_patchWaterMasksForUpperFloors` approach (Attempts 13, 19, 19b, 19c) was built on a false premise.** The function was designed to patch water RTs in `_floorCache`, but `_floorCache` never contains a `water` RT for the ground floor because the ground floor has no tile-based mask entries — it uses the scene background image loaded via the registry, not the GPU compositor.

---

## FULL ANALYSIS — Why Every Approach Has Failed

### The Actual Data Flow for Ground Floor Water

1. Scene loads → `SceneComposer.initScene()` → `assetLoader.loadAssetBundle(bgPath)` → loads `_Water.webp` → stores in `currentBundle.masks`
2. `effectMaskRegistry.transitionToFloor()` → distributes `currentBundle.masks` to subscribers → `WaterEffectV2` receives `_Water` texture → builds SDF → `tWaterData` bound
3. `DistortionManager` receives `waterSource.mask = _Water texture` → `tWaterMask` bound
4. Both effects run globally post-composite — water appears wherever the SDF/mask says so
5. The `_Water` mask covers the full scene area including where upper floor tiles are painted

### Why Patching Never Worked

`_patchWaterMasksForUpperFloors` patches RTs in `_floorCache`. But:
- Ground floor has no tile-based mask entries → GPU compositor never runs for it → no `_floorCache["0:10"]` water RT
- Even if it did, the patched RT lives in `_floorCache` — it is never pushed to the registry slot that `WaterEffectV2` subscribes to
- `WaterEffectV2` and `DistortionManager` always use `registry.getSlot('water').texture` — the raw unpatched file texture

The Attempt 19 series tried to swap `tWaterMask` to the patched RT in JS `update()`. But since `_floorCache` never has a water RT for the ground floor, `getFloorTexture('0:10', 'water')` always returns the raw registry texture (fallback path in `getFloorTexture`).

### What Actually Needs to Happen

The water mask texture that `WaterEffectV2` and `DistortionManager` use must have the upper floor tile footprint subtracted from it. This patched texture needs to be produced **once at scene load** and stored somewhere the effects can find it. The correct place to store it is directly in the registry slot — or as a separate cached reference the effects check first.

The GPU compositor CAN produce a scene-space water RT for the ground floor — it just needs tile entries. The ground floor water mask IS a tile (the scene background tile). The compositor needs to treat the background image as a tile entry for the ground floor band.

---

## Attempt 20 — Bootstrap water RT from registry texture (scene-space, correct source)

**Root cause of all 19b/19c failures:** The `_floorMeta` water texture is tile-space (raw file from disk). The registry water texture (`effectMaskRegistry.getSlot('water').texture`) IS scene-space — it's the background image mask loaded at scene init, same 4096×4096 as the `floorAlpha` RT. Blitting it with `uTileRect=(0,0,1,1)` is correct.

**Fix in `GpuSceneMaskCompositor.js`:**
1. `preloadAllFloors` sortedKeys now built from `_floorCache.keys()` PLUS the registry water slot's `floorKey` — so the ground floor key is always included even though it's never in `_floorCache`.
2. `_patchWaterMasksForUpperFloors`: when `lowerTargets` doesn't exist in `_floorCache`, create it via `_getOrCreateFloorTargets` instead of skipping.
3. Bootstrap path now uses `reg.getSlot('water').texture` (scene-space) instead of `_floorMeta` texture (tile-space).
4. Removed the broken force-compose step from 19c entirely.

**Result:** ⏳ Pending test
