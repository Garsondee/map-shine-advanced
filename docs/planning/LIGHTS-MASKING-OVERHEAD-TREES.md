# Lights Masking: Overhead Tiles vs Trees (and Window Lights)

## Problem Statement
Lights are currently masked when the lights are under trees and when they are under overhead tiles.

We’re seeing a conflict between:
- Suppressing light when overhead tiles are visible
- Not suppressing light when overhead tiles or trees have faded away

Current symptom:
- We end up in a “binary” outcome: either light is visible through roofs/overhead/trees, or lights disappear entirely.
- Window lights are also affected by this masking logic.

## Goals (What “Correct” Looks Like)
1. Lights should only be suppressed when the occluders that should hide them are actually present/visible at the current moment.
2. Occlusion decisions should transition smoothly as tiles/trees fade in/out (no hard binary state).
3. Window lights should follow the same rules as other light sources (or follow explicit, documented exceptions).

## Non-Goals
- No code changes yet.
- No visual tuning yet (we first need to understand the data flow and occlusion/masking sources).

## Key Hypotheses to Verify
1. Masking is being computed from a “layer presence” signal that is too coarse (e.g., “layer exists” instead of “currently visible/active”).
2. Overhead masking and tree masking are combined incorrectly (e.g., AND/OR mismatch, missing reset on fade).
3. The masking signal is fed by stale state (timers, caches, or delayed updates) so when a layer fades away, the “mask still applied” state isn’t cleared.
4. Window lights use a different rendering path that shares the same masking inputs, causing the same binary bug.

## Systems to Investigate (Initial List)
### Lighting/compositing pipeline
- `scripts/compositor-v2/FloorCompositor.js`
- `scripts/compositor-v2/FloorLayerManager.js`
- `scripts/compositor-v2/FloorRenderBus.js`
- `scripts/compositor-v2/effects/LightingEffectV2.js`
- `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`
- `scripts/compositor-v2/effects/TreeEffectV2.js`

### Scene-layer inputs that drive masking
- `scripts/scene/FloorStack.js`
- `scripts/scene/tile-manager.js`
- `scripts/scene/DoorMeshManager.js`

### Window / “light source” handling
- Search for window light rendering paths and whether they route into `LightingEffectV2` or separate effects.

### Debugging / diagnostic UI
- `scripts/ui/diagnostic-center-dialog.js`

## Research Checklist
1. Locate the exact variables/signals that decide “should suppress light” in each relevant effect.
2. Determine how “visibility” is represented during fade (boolean? opacity? tick-based timers? z-order?).
3. Map how overhead tiles and trees each contribute to the masking decision.
4. Identify where state should be cleared/updated when tiles/trees fade away.
5. Identify whether window lights take the same code path (or diverge).

## Evidence to Collect
- Code locations where:
  - occlusion masks are computed
  - occlusion is combined across systems (overhead vs trees vs windows)
  - fade-in/out state is updated
  - stale caching is present
- Any relevant debug toggles or diagnostic outputs.

## Key Findings So Far (Research, No Fix)
### 1) Lighting gating inputs and how the shader combines them
- `LightingEffectV2` computes `roofLightVisibility` and then applies it to:
  - “source lights” (`visS` via `uApplyRoofOcclusionToSources`)
  - “window lights” (`visW` via `uApplyRoofOcclusionToWindow`)
- The `roofLightVisibility` signal comes from one of these paths:
  - Preferred: `ceilingTransmittance` texture (`tCeilingLightTransmittance`)
  - Fallback: `overheadRoofAlpha` + `overheadRoofBlock`

### 2) `FloorCompositor` always provides roof alpha/block + ceiling transmittance (unless a debug bypass is enabled)
- `FloorCompositor` binds and passes the following into `LightingEffectV2`:
  - `overheadRoofAlphaTex` from `OverheadShadowsEffectV2.roofAlphaTexture`
  - `overheadRoofBlockTex` from `OverheadShadowsEffectV2.roofBlockTexture`
  - `ceilingTransmittanceTex` from `OverheadShadowsEffectV2.ceilingTransmittanceTextureForLighting`
- Therefore, the lighting shader typically uses the ceiling-transmittance path, which depends on both roof alpha and the hard roof blocker.

### 3) `OverheadShadowsEffectV2` captures a “forced-opaque” roof blocker that ignores hover fade
- `OverheadShadowsEffectV2` produces:
  - `roofVisibilityTarget` (runtime roof visibility alpha; intended to reflect hover fade)
  - `roofBlockTarget` (forced-opaque roof blocker; intended for hard occlusion)
- During the roof blocker capture (“Pass 1b”), it explicitly overrides tree uniforms:
  - forces `uHoverFade.value = 1.0` for tree canopies while rendering `roofBlockTarget`
  - also zeroes animation-like uniforms (shadow opacity, wind, etc.) during the blocker capture
- This strongly suggests that even after trees/overhead tiles visually fade out, the blocker map used by lighting remains “present,” causing continued light suppression.

### 4) The ceiling transmittance texture combines roof visibility + roof blocker
- `OverheadShadowsEffectV2` computes `ceilingTransmittanceTarget` from:
  - roof visibility (`roofVisibilityTarget`) using a lower threshold
  - roof blocker (`roofBlockTarget`) using a higher threshold
- Because roof blocker is forced-opaque, the combined `T` can remain 0 even when roof visibility fades out.

### 5) Window lights are affected through TWO separate gating paths
- Window overlays emission gating (separate from `LightingEffectV2`):
  - `WindowLightEffectV2` uses `roofAlphaTexture` (runtime roof visibility alpha) to gate overhead-roof leakage for non-overhead overlays.
  - It also applies `uAllowRoofGate` as ground-floor-only.
- Final lighting composition gating:
  - `LightingEffectV2` multiplies the window glow channel (`winLights`) by the same `roofLightVisibility`.
  - Since `roofLightVisibility` is driven by ceiling transmittance (which depends on the forced blocker), the window channel will be suppressed by the same underlying issue.

## Most Likely Root Cause (Resolved Hypothesis / Targeted Fix)
The hard blocker path produced by `OverheadShadowsEffectV2` (especially its override of tree/roof hover-fade) is “too sticky,” so `ceilingTransmittanceTarget` stays blocked even after roofs/trees visually fade away.

This would produce the observed behavior:
- “Either lights are visible through roofs/trees OR lights are not visible at all”
- because the lighting shader is effectively fed a binary-ish transmittance signal derived from an always-on blocker texture.

## Targeted Fix Implemented
In `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`:
- The roof tile opacity/visibility overrides that keep roofs “fully opaque” are now restored immediately after the `roofTarget` pass, so the subsequent `roofBlockTarget` / `ceilingTransmittance` capture matches hover-visible roofs instead of staying stuck.
- During the `roofBlockTarget` capture, tree `uHoverFade` is no longer forced to `1.0` (it still zeroes the shadow/animation-like uniforms to keep the blocker stable, but it no longer ignores the fade state).

## Additional Shader Fix (Address Binary Transition)
After `WindowLightEffectV2` still wasn’t reappearing as expected, I updated the remaining “binary” thresholding:

- In `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js` (ceiling transmittance pass), replaced `step()` thresholds with `smoothstep()` so hover fading yields a gradual change in light transmittance `T`.
- In `scripts/compositor-v2/effects/LightingEffectV2.js`, replaced roof-alpha/roof-block `step()` thresholds (and related occlusion relief helpers) with `smoothstep()` so the fallback roof gating path also transitions smoothly.

## Rain-Mask Relationship and Final Direction
The blanket runtime decoupling approach in `FloorCompositor` (nulling blocker/transmittance during reveal) was too broad and let lights leak through visible trees/overheads.

Final direction now:
- Keep normal texture wiring in `FloorCompositor` (alpha + blocker + transmittance always available).
- Fix the occlusion math so hard blocker contribution is conditioned by live visibility:
  - In `OverheadShadowsEffectV2` transmittance pass, roof-block occlusion is multiplied by roof-visibility occlusion.
  - In `LightingEffectV2` fallback path, roof-block occlusion is multiplied by a roof-visibility weight.

Result intent:
- Visible trees/overheads block lights.
- Hover-faded trees/overheads fade that block out with them, instead of leaving a dark “stuck mask.”

## Invariant (Do Not Break)
Do not reintroduce runtime “decoupling” that nulls `roofBlockTexture` and/or `ceilingTransmittanceTextureForLighting` during hover-reveal.

The current behavior depends on shader-side gating:
- `OverheadShadowsEffectV2` multiplies roof-block occlusion by `roofVisOcc`
- `LightingEffectV2` multiplies roof-block occlusion by `roofVisWeight`

Changing those multiplications (or nulling inputs at runtime) will bring back either stuck suppression under faded canopies or light leakage through visible roofs.

## Controls to Watch During Further Research
- `LightingEffectV2` occlusion controls:
  - `upperFloorTransmissionEnabled` + `upperFloorTransmissionStrength`
  - `restrictRoofScreenLightOcclusionToTopFloor`
  These modulate `uApplyRoofOcclusionToSources` and `uApplyRoofOcclusionToWindow`, but the roof/tree visibility itself still comes from the ceiling transmittance / blocker textures.
- `WindowLightEffectV2` roof leakage control:
  - `lightOverheadTiles`
  When gating is applied, it uses a hard roof alpha test: `overheadGate = 1.0 - roofAlpha` for non-`lightOverheadTiles` mode.

## Next Steps (Once Research Is Enough)
- Propose a fix strategy (likely: change the occlusion decision from “layer present” to “layer visible/active”, and/or correct state clearing on fade).
- Add targeted debug logging/visual overlays before changing behavior.

