# Specular Tile Occlusion Deep Dive

## Scope

This document analyzes why specular from a lower tile can still appear through an upper tile in some cases, even when sort ordering appears correct.

Focus area:
- `scripts/effects/SpecularEffect.js`
- Supporting evidence from `scripts/scene/tile-manager.js`

---

## 1) Current Occlusion Pipeline (What the code is doing)

### 1.1 Tile sprite (visual tile) path

Tile visuals are rendered by `THREE.SpriteMaterial` with:
- `transparent: true`
- `alphaTest: 0.1`
- `depthTest: true`
- `depthWrite: true`

Evidence:
- `@scripts/scene/tile-manager.js#2339-2345`

Implication:
- Tile visibility silhouette is clipped at alpha 0.1.

### 1.2 Tile specular overlay path

Each tile gets a separate plane-mesh specular overlay.

Overlay material settings:
- `transparent: true`
- `depthTest: true`
- `depthWrite: true`
- `outputMode = 1.0` (specular-only shader branch)
- If mask exists: `AdditiveBlending`, `colorWrite=true`
- If mask missing: `NoBlending`, `colorWrite=false` (depth-only black occluder)

Evidence:
- Bind/create overlay: `@scripts/effects/SpecularEffect.js#948-1016`
- Material mode switching: `@scripts/effects/SpecularEffect.js#1018-1041`

### 1.3 Overlay transform and ordering

Per overlay, transform sync does:
1. copy/decompose sprite world transform
2. apply extra rotation from `sprite.material.rotation`
3. apply additional Z lift:
   - `baseLift = 0.02`
   - `sortLift = clamp(sort * 0.002, -0.015, 0.50)`
4. set renderOrder:
   - `sprite.renderOrder + 1 + (-sort * 0.00001)`

Evidence:
- `@scripts/effects/SpecularEffect.js#1073-1161`

Important implication:
- Overlay depth is intentionally moved **above** sprite depth.
- Occlusion between overlapping tiles in specular pass depends primarily on **overlay-vs-overlay depth/coverage**, not sprite depth.

### 1.4 Specular shader coverage and alpha behavior

For `uOutputMode > 0.5` (tile overlays):
- `maskCoverage = albedo.a`
- discard only when `maskCoverage <= 0.001`
- specular intensity uses `_Specular` alpha (`specularMask.a`) for highlight strength
- output alpha is `maskCoverage`

Evidence:
- `@scripts/effects/SpecularEffect.js#2430-2443`
- `@scripts/effects/SpecularEffect.js#2582-2584`
- `@scripts/effects/SpecularEffect.js#2723-2723`
- `@scripts/effects/SpecularEffect.js#2800-2807`

Implication:
- `_Specular.a` controls shine strength, not occlusion coverage.
- Occlusion coverage is driven by albedo alpha only.

---

## 2) Why this can work for some tiles and fail for others

This behavior profile (works on some tile pairs, fails on others) is consistent with **silhouette mismatch** and **ordering tie conditions**, not a single global sort failure.

### 2.1 Overlay silhouette can diverge from visible tile silhouette

The visible sprite uses `alphaTest = 0.1`, but overlay discard threshold is `0.001`.

Evidence:
- Sprite alpha test: `@scripts/scene/tile-manager.js#2340-2343`
- Overlay discard threshold: `@scripts/effects/SpecularEffect.js#2441-2443`

Result:
- The visual tile and occlusion carrier are not using identical cutout rules.
- Depending on source alpha edges, filtering, and mip selection, some assets can produce local mismatches.

### 2.2 Occlusion depends on overlay alignment quality, not sprite depth

Because overlays are Z-lifted above sprites (`+0.02 + sortLift`), the upper sprite's depth is no longer the primary blocker for lower specular.

Evidence:
- Z lift: `@scripts/effects/SpecularEffect.js#1114-1124`

Result:
- If upper overlay coverage misses a region (due transform or alpha mismatch), lower overlay can leak there even if upper tile sprite appears visually opaque.

### 2.3 Same-sort (or near-tie) tiles can still be unstable

Overlay order is derived from tile `sort` only. When tile stacking is resolved in Foundry using additional tie-breaks (doc order/elevation/internal sequence), overlay ordering may not perfectly mirror that tie resolution.

Evidence:
- Sort key source and renderOrder offset: `@scripts/effects/SpecularEffect.js#1107-1112`, `@scripts/effects/SpecularEffect.js#1149-1156`
- TileManager stores only one sort key on sprite: `@scripts/scene/tile-manager.js#3137-3139`

Result:
- Some pairs with equal/close sort can appear inconsistent even if "sorting looks right" in UI.

### 2.4 Rotation/flip combinations are higher risk

Overlay transform reconstructs sprite transform and then applies `sprite.material.rotation` at mesh level.

Evidence:
- `@scripts/effects/SpecularEffect.js#1089-1097`

Tile sprites can also carry sign-flipped scales from Foundry (`scaleX/scaleY < 0`).

Evidence:
- `@scripts/scene/tile-manager.js#3153-3171`

Result:
- For some rotated/flipped assets, overlay silhouette may be slightly offset relative to the sprite silhouette, creating localized leak-through.

---

## 3) Most likely failure mode for the reported "metal arms / globes" case

Given current behavior and current code, the highest-likelihood chain is:

1. Lower and upper tiles both have overlays (valid `_Specular`).
2. Upper overlay does not perfectly match visible upper sprite silhouette at some pixels (alpha threshold and/or transform edge case).
3. Since overlays sit above sprites in Z, lower overlay is blocked only where upper overlay writes depth.
4. In mismatch pixels, lower specular survives and appears as leak-through.

This exactly matches: "works for some tile pairs, fails for others".

---

## 4) Additional technical observations (relevant)

### 4.1 Tile albedo and tile mask texture conventions are mixed by role

- Albedo textures: sRGB, mipmapped (when allowed), anisotropy.
- Data masks (`_Specular`): `NoColorSpace`, linear filter, no mipmaps, `flipY` adjusted.

Evidence:
- Filtering config: `@scripts/scene/tile-manager.js#352-377`
- Specular mask load path: `@scripts/scene/tile-manager.js#901-936`

This is correct for data masks, but it means alpha transitions in albedo-vs-mask can differ in sampling behavior.

### 4.2 Current architecture is single-pass additive composition

No dedicated occlusion prepass is performed for tile specular overlays; color + depth are written in the same transparent/additive overlay pass.

Evidence:
- Overlay material configuration and output mode behavior: `@scripts/effects/SpecularEffect.js#981-1041`, `@scripts/effects/SpecularEffect.js#2800-2807`

This increases sensitivity to exact per-fragment coverage agreement.

---

## 5) Assessment Summary

The issue is not a simple "sort is wrong" bug.

The current model relies on overlay meshes as both:
- the emitter of specular color
- the occlusion carrier for stacked specular

Because overlays are intentionally lifted above sprites, any per-pixel mismatch between overlay coverage and visible tile silhouette can produce leaks. Those mismatches are asset-dependent (alpha edge content, rotation/flip combos, tie ordering), which explains the observed inconsistency across tiles.

---

## 6) Suggested next engineering direction

To make this robust, decouple occlusion from additive color pass:

1. **Tile spec occlusion prepass** (depth or mask-only), with the exact same coverage rules as tile visibility.
2. Then run additive specular color pass gated by that prepass.

Alternative (less robust): force overlay coverage/discard logic to exactly mirror sprite alpha-test semantics and tie-break ordering, but this remains fragile for edge cases.

---

## 7) Quick verification checklist for next iteration

- Compare sprite cutout vs overlay cutout in a debug view (same tile, same frame).
- Log per-tile values for: `sortKey`, `renderOrder`, effective overlay Z.
- Check whether failing pairs share equal `sort` or use flip/rotation combinations.
- Validate that top overlay writes depth in the exact region where leakage appears.

