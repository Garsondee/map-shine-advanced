# Console Warning Investigation (2026-02-18)

## Scope
Investigated the provided warning list to determine whether each warning originates from Map Shine Advanced code, from Foundry/Three internals, or from an interaction between them.

---

## Findings Summary

| Warning | Source Attribution | Verdict |
|---|---|---|
| `Map Shine Advanced | AssetLoader | Roughness derivation not yet implemented, using default` | Map Shine Advanced logger and loader fallback path | **From Map Shine Advanced** |
| `TileDocumentPF2e#overhead is deprecated` | Foundry compatibility warning triggered by Map Shine reading `tileDoc.overhead` | **Triggered by Map Shine Advanced** |
| `THREE.WebGLProgram: Program Info Log ... X4000/X3595` | Three.js compile log output for shader code | **Emitted by Three.js; likely caused by one or more active shaders (possibly Map Shine shaders)** |
| `Map Shine Advanced | UI | Parameter rainMaxCombinedStrengthPx not found in schema` | Map Shine Tweakpane schema/group mismatch | **From Map Shine Advanced** |
| `Map Shine Advanced | RenderLoop | First frame took 28876ms — possible residual shader compilation` | Map Shine first-frame timing diagnostic | **From Map Shine Advanced** |
| `WebGL warning: drawElementsInstanced ... illegal feedback ... DEPTH_ATTACHMENT` | Browser/WebGL validation warning, likely due read/write same depth texture in a render pass | **Likely Map Shine pipeline interaction (high confidence)** |

---

## Per-warning Evidence

### 1) Roughness derivation warning
**Warning:** `Map Shine Advanced | AssetLoader | Roughness derivation not yet implemented, using default`

- The warning text is emitted directly in `deriveRoughnessFromSpecular` via `log.warn(...)` at @scripts/assets/loader.js#1016-1022.
- The fallback path is reached when roughness is missing but specular exists at @scripts/assets/loader.js#976-983.

**Conclusion:** Directly from Map Shine Advanced (intentional fallback behavior, not a crash).

---

### 2) PF2e `TileDocumentPF2e#overhead` deprecation
**Warning:** `TileDocumentPF2e#overhead is deprecated`

- Map Shine’s `isTileOverhead` checks `tileDoc?.overhead !== undefined` and also logs `tileDoc.overhead` in debug payload at @scripts/scene/tile-manager.js#61-67.
- Accessing `tileDoc.overhead` is what triggers Foundry’s compatibility warning in PF2e.
- This helper is called from composer tile filtering in `_getLargeSceneMaskTiles` at @scripts/scene/composer.js#217-223.

**Conclusion:** The warning is emitted by Foundry, but it is being triggered by Map Shine code path.

---

### 3) Three shader compile warnings (X4000 / X3595)
**Warning:** `THREE.WebGLProgram: Program Info Log ... potentially uninitialized variable ... gradient instruction used in a loop with varying iteration`

- These messages are printed by Three.js WebGL program compilation (engine-level logging), not by a custom `log.warn` call in Map Shine.
- The warning means one or more active shader programs compiled with potentially risky patterns.
- From this log alone, shader ownership is not uniquely identifiable (could be custom Map Shine shader code and/or third-party shader chunks).

**Conclusion:** Emitted by Three.js; likely shader-source-related. Not a direct Map Shine logger message, but may still involve Map Shine shaders.

---

### 4) Missing UI schema parameter
**Warning:** `Map Shine Advanced | UI | Parameter rainMaxCombinedStrengthPx not found in schema`

- Generic warning originates from Tweakpane builder when a group references a missing key at @scripts/ui/tweakpane-manager.js#2295-2299.
- `rainMaxCombinedStrengthPx` is referenced in Water effect group parameters at @scripts/effects/WaterEffectV2.js#749-750.
- The same parameter exists in runtime defaults and shader uniforms (`this.params.rainMaxCombinedStrengthPx`) at @scripts/effects/WaterEffectV2.js#189-189 and @scripts/effects/WaterEffectV2.js#1359-1359.
- But there is no `rainMaxCombinedStrengthPx: {...}` entry in the `parameters` schema block around @scripts/effects/WaterEffectV2.js#903-1047.

**Conclusion:** Direct Map Shine schema mismatch.

---

### 5) First-frame residual shader compilation warning
**Warning:** `Map Shine Advanced | RenderLoop | First frame took 28876ms — possible residual shader compilation`

- Logged explicitly when first frame render time exceeds 100ms at @scripts/core/render-loop.js#257-259.

**Conclusion:** Direct Map Shine diagnostic warning. Indicates severe first-frame stall, but message itself is intentional instrumentation.

---

### 6) WebGL illegal feedback warning (`drawElementsInstanced` / `DEPTH_ATTACHMENT`)
**Warning:** `Texture level 0 would be read ... but written by framebuffer attachment DEPTH_ATTACHMENT`

- This warning is browser/WebGL validation output (not Map Shine logger text).
- Map Shine depth pass renders scene into a depth target (`renderer.setRenderTarget(this._depthTarget); renderer.render(scene, depthCamera);`) at @scripts/scene/depth-pass-manager.js#415-419.
- Multiple Map Shine materials bind depth-pass texture from `depthPassManager.getDepthTexture()` (for example fluid + specular bindings) at @scripts/effects/FluidEffect.js#652-659 and @scripts/effects/SpecularEffect.js#2220-2227.
- This is a known pattern that can create read/write feedback if the same depth texture is sampled while it is attached for writing.

**Conclusion:** Very likely caused by Map Shine render pipeline interaction (high confidence), even though warning is emitted by WebGL/Three.

---

## Practical classification requested by user

If your question is strictly "is this coming from Map Shine Advanced?":

- **Yes / directly Map Shine:**
  - AssetLoader roughness derivation warning
  - UI missing parameter warning (`rainMaxCombinedStrengthPx`)
  - RenderLoop first-frame warning

- **Yes / triggered by Map Shine but emitted by host engine:**
  - PF2e `tile.overhead` deprecation (Foundry warning)
  - WebGL illegal feedback warning (browser/WebGL warning)

- **Engine-level compile output, attribution uncertain without shader source dump:**
  - `THREE.WebGLProgram` info-log warnings (X4000/X3595)
