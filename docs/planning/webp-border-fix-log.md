# WebP Border Artifact Fix Log

## Problem
Upper floor transparent .webp tile has ugly border artifacts when viewed from ground floor.

## Screenshot Analysis
- Screenshot 1 (original): Black interior, white/bright pixelated border around upper floor tile
- Screenshot 2 (after attempt 2): Tile content visible but wrong — upper floor artwork bleeding through incorrectly, white glow still present, UV mapping broken

## Attempts Made

### Attempt 1 — Texture loading / material fixes (tile-manager.js)
**Changes:**
- Added `premultiplyAlpha: 'none'` to `createImageBitmap` calls
- Disabled mipmaps for ALBEDO tile textures (`generateMipmaps = false`)
- Changed `alphaTest: 0.1` → `0` on SpriteMaterial
- Changed `depthWrite: true` → `false` on SpriteMaterial
- Tightened smoothstep in `_applyFloorAlphaClip` from `(0.1, 0.5)` → `(0.05, 0.2)`

**Result:** Did NOT fix the problem. Screenshot 1 still showed black interior + white border.

**Assessment:** These changes are probably harmless/correct but didn't address root cause.

### Attempt 2 — Replaced _applyFloorAlphaClip to use floorAlpha mask (EffectComposer.js)
**Changes:**
- Replaced `LightingEffect.outdoorsTarget` with `floorAlpha` mask from GPU compositor bundle
- Added `uViewBounds`, `uSceneRect`, `uCanvasHeight` uniforms for screen→scene UV conversion
- Added fallback to `compositor.getFloorTexture()` when bundle lacks floorAlpha
- Changed uniform name from `tOutdoors` to `tFloorAlpha`

**Result:** MADE THINGS WORSE. Screenshot 2 shows upper floor artwork visible in wrong places, UV mapping broken, white glow still present.

**Root cause of failure:** The UV conversion (screen UV → world XY → Foundry XY → scene UV) is likely wrong. The `floorAlpha` mask is scene-space but the view bounds calculation may be incorrect, causing the mask to sample at wrong coordinates.

**REVERT THIS CHANGE.**

## What NOT to try again
- Do not use `floorAlpha` mask with screen→scene UV conversion in the clip shader (UV math is fragile)
- Do not change `_applyFloorAlphaClip` to use a different mask without first verifying UV spaces match

## Current State of Files (after reverts needed)
- EffectComposer.js: NEEDS REVERT of Attempt 2
- tile-manager.js: Attempt 1 changes still in place (probably fine)

## Root Cause Identified
The compositor uses `One / OneMinusSrcAlpha` blending (premultiplied alpha-over). This requires `src.rgb` to already be premultiplied by `src.a`. But the floor RT contains **straight-alpha RGB** — SpriteMaterial renders with `SrcAlpha/OneMinusSrcAlpha` into the float RT, leaving `rgb` at full strength regardless of alpha.

Result: at a semi-transparent edge pixel with `rgba(200,150,100, 0.3)`:
- Compositor does: `result.rgb = (200,150,100) + ground.rgb * 0.7` — WRONG (too bright)
- Should be: `result.rgb = (60,45,30) + ground.rgb * 0.7` — premultiplied

This is the white/bright fringe at transparent tile edges.

### Attempt 3 — Premultiply in compositor fragment shader (EffectComposer.js)
**Changes:**
- Compositor fragment shader now outputs `vec4(c.rgb * c.a, c.a)` before the GPU blend
- Clip pass changed to only scale `color.a` (not RGB) to avoid double-premultiply

**Result:** NO CHANGE. The visual was identical. The premultiply mismatch was not the root cause.

**Assessment:** The fringe is not from premultiply mismatch. The real problem is the clip pass never fires because `outdoorsTarget.r` is always 0 for an all-indoors floor.

---

## Root Cause (confirmed by user)
The upper floor HAS a valid `_Outdoors` WebP. It is **black RGB with alpha transparency**:
- Alpha = opaque where the floor tile exists, transparent where it doesn't
- RGB = all black (entire floor is indoors — correct)

The bug: `outdoorsMaterial` was `transparent: false`, so `MeshBasicMaterial` only wrote RGB to `outdoorsTarget`. The alpha channel was **discarded**. The clip shader sampled `.r` (always 0 = all indoors) → `indoor = 1.0` everywhere → no clipping → upper floor rendered fully opaque everywhere.

### Attempt 4 — Use alpha channel of outdoors mask for clipping (LightingEffect.js + EffectComposer.js)
**Changes:**
- `outdoorsMaterial`: changed to `transparent: true, blending: THREE.NoBlending`
- `_applyFloorAlphaClip` shader: changed from sampling `.r` to `.a` from `tOutdoors`

**Result:** STILL BROKEN. The fast path in `bindFloorMasks` bypasses `_rebuildOutdoorsProjection` — the material change never takes effect for subsequent floors. Also, the clip pass is not the root problem.

---

## Root Cause (Attempt 5 diagnosis)
Two separate bugs found by reading the full pipeline:

**Bug 1 — Compositor blend mode wrong:**
`_compositeFloorToAccumulation` used `One/OneMinusSrcAlpha` (premultiplied alpha-over) but the floor RT contains **straight-alpha** RGB from SpriteMaterial/LightingEffect. Should be `SrcAlpha/OneMinusSrcAlpha`.

**Bug 2 — `_blitToScreen` uses `NoBlending`:**
`NoBlending` writes `(0,0,0,0)` directly over the Foundry WebGL canvas in areas where the accumulation buffer is transparent (scene padding, areas outside the map tile). This erases whatever Foundry drew there (grid, background), replacing it with black/transparent. Should use `NormalBlending` so transparent accumulation pixels let the Foundry canvas show through.

**Bug 3 — Attempt 3's premultiply still in place:**
The compositor fragment shader was outputting `vec4(c.rgb * c.a, c.a)` — wrong for straight-alpha content, and also wrong when used by `_blitToScreen`.

### Attempt 5 — Fix compositor blend + blit blending (EffectComposer.js only)
**Changes:**
- Compositor fragment shader: reverted to `gl_FragColor = texture2D(tFloor, vUv)` (pass-through)
- Compositor blend: `One/OneMinusSrcAlpha` → `SrcAlpha/OneMinusSrcAlpha` (straight alpha)
- `_blitToScreen`: `NoBlending` → `NormalBlending` (preserves Foundry canvas in transparent areas)

**Status:** Awaiting test

## What NOT to try again
- Do not use `floorAlpha` mask with screen→scene UV conversion in the clip shader (UV math is fragile, Attempt 2 made things worse)
- Do not premultiply RGB in the compositor fragment shader (Attempt 3 — made things worse)
- Do not use `NoBlending` in `_blitToScreen` (erases Foundry canvas in transparent areas)
- Do not use `One/OneMinusSrcAlpha` compositor blend with straight-alpha RT content
