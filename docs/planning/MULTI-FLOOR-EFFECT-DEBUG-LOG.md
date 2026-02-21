# Multi-Floor Effect Debug Log

Tracks every attempted fix, hypothesis, and outcome for multi-floor effect rendering issues.

---

## Known Issues (as of session start)

| # | Issue | Status |
|---|-------|--------|
| 1 | Upper floor not rendering at full resolution | Investigating |
| 2 | Specular works on floor below but NOT on current (upper) floor | Investigating |
| 3 | Fire particles not spawning on new (upper) floor | Investigating |
| 4 | WindowLightEffect still not working | Investigating |

---

## Issue 1 — Upper Floor Not Rendering at Full Resolution

### Hypothesis A: `_renderFloorPresence` / `_renderWaterOccluders` not restoring `setClearColor`
Both methods save/restore `getRenderTarget()` and `layers.mask` but do NOT restore `renderer.setClearColor`.
If the main render pipeline calls `renderer.clear()` after these passes, the clear colour is wrong (black/transparent alpha=0).
Could cause background to disappear or look like reduced contrast rather than resolution.

**Fix attempted (session 2):** Restore `setClearColor` in both helpers.

### Hypothesis B: Half-res `floorPresenceTarget` viewport leaking into main render
`setRenderTarget(floorPresenceTarget)` sets viewport to 0.5× size. `setRenderTarget(prevTarget)` restores.
Code looks correct — THREE.js sets viewport on every `setRenderTarget` call. Unlikely.

### Hypothesis C: Pre-existing renderer size mismatch on floor switch (Levels/Foundry)
Foundry's PIXI canvas or the Three.js canvas DOM element may be resized by Levels on floor change.
Not related to MapShine code changes. **Needs visual investigation by user.**

---

## Issue 2 — Specular Not Working on Upper Floor

### Hypothesis A: `_syncTileOverlayTransform` overrides `update()` visibility for levelsHidden tiles
`_syncTileOverlayTransform` uses old logic: `shouldShow = !!sprite.visible && opacity > 0.01`.
It runs on every tile transform change and resets `mesh.visible = false` for below-floor tiles,
undoing what `update()` sets. For *upper floor* tiles this isn't the issue (both agree `shouldShow=true`),
but it would break the floor-below specular overlay that `update()` enables.
The user reporting floor-BELOW specular IS working suggests this race condition is not occurring
(or `update()` runs last and wins each frame).

**Fix attempted (session 2):** Add levelsHidden logic to `_syncTileOverlayTransform` to be consistent with `update()`.

### Hypothesis B: Per-tile specular mask texture not loaded for upper floor tiles
When switching floors, `bindTileSprite` is called with `emitSpecular: false` initially, then
async texture load rebinds with `emitSpecular: true`. The guard `if (currentSprite !== sprite) return`
might skip the rebind if the sprite reference changed during the async gap.
**Needs investigation.**

### Hypothesis C: `_tileBypassesEffects` returning true for upper floor tiles
If upper floor tiles are flagged as bypass (e.g., have `flags.mapshine.bypassEffects` set),
`_tileShouldEmitSpecular` returns false and no colour mesh is created.
**Needs investigation with specific tile data.**

### Hypothesis D: New fragment shader uniform declarations causing compilation failure
Adding `tFloorPresence`, `uHasFloorPresence`, `uFloorPresenceGate` to the fragment shader.
If GLSL compilation fails, all specular materials render black.
WebGL logs would show shader errors. **Low probability — syntax-checked.**

---

## Issue 3 — Fire Particles Not Spawning on New Floor

### Hypothesis A: `lum * alpha = 0` in compositor if fire mask has alpha=0 at fire positions
`GpuSceneMaskCompositor` TILE_FRAG mode=0: `lum = max(RGB) * s.a`.
If the upper-floor `_Fire` texture has white RGB at fire positions but alpha=0, `lum = 0`.
`_readbackIsNonEmpty` checks RGB of compositor output; output is all-zero → mask registered as empty.
`_generatePoints` (`lum * alpha`) also gives 0.

**Fix candidate:** In `_generatePoints`, if `alpha == 0` treat as `alpha = 1` (backwards-compat fallback),
OR change compositor to `lum = max(max(RGB), alpha)` for fire type only.
**Preferred fix:** Compositor mode=0 should output `max(luminance, alpha)` not `luminance * alpha`
for masks where the alpha IS the mask shape. But this breaks the previously-fixed solid-white issue
for masks that have RGB=0, alpha=255 everywhere.

**Better fix:** Keep `lum * alpha` in compositor; fix `_generatePoints` to read `max(lum, alpha/255)`.
This way fire spawns from either bright-RGB or alpha-encoded regions.

### Hypothesis B: Upper floor fire mask tile not included in compositor composition
With `preserveAcrossFloors: true`, old floor's fire mask is preserved, but the new floor's
fire mask tile may be hidden by Levels elevation BEFORE the compositor reads it.
If the fire tile is gated behind a Levels elevation band that the compositor doesn't know about,
the new floor's mask is never composited.

**Fix candidate:** Investigate how `GpuSceneMaskCompositor` enumerates tiles and whether
it respects or ignores Levels elevation when building per-type composites.

### Hypothesis C: `preserveAcrossFloors: true` preserves OLD mask, new floor mask never replaces it
The compositor might detect the slot already has a texture and skip recomposition.
**Needs compositor code review.**

---

## Issue 4 — WindowLightEffect Not Working

### Hypothesis A: Window mask alpha channel blocking luminance
If the window mask PNG has bright RGB at window positions but alpha=0 (transparent),
compositor outputs `lum * alpha = 0`. WindowLightEffect sees no windows.
Same root cause as Issue 3 Hypothesis A.

### Hypothesis B: Window mask type uses `source-over` composition mode
`windows: compositionMode: 'source-over'` in EffectMaskRegistry.
Unlike `lighten` (mode=0), `source-over` (mode=1) composites differently.
If the window mask tile has alpha=0 at the window positions, source-over would
produce transparent output even with bright RGB.

### Hypothesis C: WindowLightEffect shader sampling wrong texture channel
After reverting `max(lum, alpha)` back to `msLuminance(rgb)` only, the shader may
produce zero output for certain mask types if the mask is authored differently than expected.
e.g. if window lights are defined by alpha only (RGB=0, A=255), the reverted shader gets 0.

---

## Fixes Attempted

### Session 1 (previous)
- [x] TILE_FRAG mode=0: `lum = max(RGB) * alpha` (alpha convention)
- [x] `_readbackIsNonEmpty`: check RGB only
- [x] `FireSparksEffect._generatePoints`: `b = lum * alpha`
- [x] `EffectMaskRegistry` fire: `preserveAcrossFloors: true, disposeOnClear: false`
- [x] `TileManager`: FloorPresenceManager (layer 23 meshes + setFloorPresenceScene)
- [x] `DistortionManager`: `floorPresenceTarget` RT + `_renderFloorPresence` + gate in apply shader
- [x] `canvas-replacement.js`: wire floor presence scene
- [x] `SpecularEffect`: levelsHidden tile color mesh floor-presence gate
- [x] `TileManager.updateSpriteVisibility`: `sprite.userData.levelsHidden` tag
- [x] `WindowLightEffect`: reverted all `max(lum, alpha)` back to `msLuminance(rgb)`

### Session 2 (current)
- [x] Fix `setClearColor` not restored in `_renderWaterOccluders` / `_renderFloorPresence` — both helpers now save/restore `prevClearColor`/`prevClearAlpha`
- [x] Fix `_syncTileOverlayTransform` to apply levelsHidden visibility — consistent with `update()` loop, prevents transform-sync from overriding floor-below mesh state
- [x] Fix `GpuSceneMaskCompositor._cpuPixelCache` not cleared in cache-miss path — previously `getCpuPixels` returned stale previous-floor pixel data after a cache-miss floor switch (fire at wrong floor positions)
- [ ] Investigate upper floor specular not working — root cause still unclear, needs runtime diagnostics
- [ ] Investigate WindowLightEffect not working — root cause still unclear, needs runtime diagnostics or mask authoring info
- [ ] Investigate full-resolution rendering issue — `setClearColor` fix may resolve it; if not, needs Levels/Foundry canvas size check

---

## Architecture Notes

- `floorPresenceTarget`: half-res RT, R=1 where current floor tiles are opaque (screen-space)
- `levelsHidden`: `sprite.userData.levelsHidden = true` when Levels elevation hides tile in strict-band mode
- Floor-below specular: levelsHidden tiles keep color mesh alive, `uFloorPresenceGate=1` gates output by `(1-fp)`
- `_renderFloorPresence` + `_renderWaterOccluders`: both save/restore render target + layers mask; DO NOT restore setClearColor
