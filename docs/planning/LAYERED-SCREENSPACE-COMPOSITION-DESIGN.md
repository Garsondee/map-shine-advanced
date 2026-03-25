# Layered screen-space composition and ceiling light transmittance

**Status:** design + Phase 1 implemented (2026-03-25)  
**Related:** [ARCHITECTURE-SUMMARY.md](../ARCHITECTURE-SUMMARY.md), [V2-EFFECT-DESIGN-CONTRACT.md](V2-EFFECT-DESIGN-CONTRACT.md)

## 1. Executive summary

Map Shine V2 already stacks **albedo** in [`FloorRenderBus`](../../scripts/compositor-v2/FloorRenderBus.js) with per-floor Z and overhead layer capture for [`OverheadShadowsEffectV2`](../../scripts/compositor-v2/effects/OverheadShadowsEffectV2.js). **Dynamic lighting** is accumulated into shared screen-space buffers in [`LightingEffectV2`](../../scripts/compositor-v2/effects/LightingEffectV2.js) and composed with the scene. That separation means **draw order for color** does not automatically define **how much light reaches a pixel**; ceiling and floor often share planimetric \((x,y)\) in top-down views, so the pipeline must carry an explicit **occlusion / transmittance** signal for lights.

This document records the research conclusions and the **Phase 1** step: a dedicated **ceiling light transmittance** texture \(T\) built in the overhead effect and consumed in lighting compose, so geometric gating is **single-sourced** instead of re-derived twice from roof alpha and block with drifting heuristics.

## 2. Two meanings of “occlusion”

- **Coverage / albedo:** which surface color wins at a screen pixel (bus, bridges, sort order).
- **Photometric / lights:** how much unshadowed dynamic light is applied at that pixel (light RT + compose).

Foundry-style light buffers are 2D; without an explicit carrier, “under roof” behavior becomes **heuristic** (roof RT + `_Outdoors` relief), which is fragile when scene-XY masks disagree with visible ceiling quads.

## 3. Current pipeline (ground truth)

- [`FloorCompositor`](../../scripts/compositor-v2/FloorCompositor.js): runs overhead capture, then bus → `sceneRT`, then lighting and the rest of the post chain.
- [`OverheadShadowsEffectV2`](../../scripts/compositor-v2/effects/OverheadShadowsEffectV2.js): `roofVisibilityTarget` (live opacity), `roofBlockTarget` (forced-opaque blocker), shadow factor RT, etc.
- [`LightingEffectV2`](../../scripts/compositor-v2/effects/LightingEffectV2.js): multiplies dynamic lights by a **roofLightVisibility** derived from roof textures and optional `_Outdoors` relief; **ambient** is handled separately (cloud / building / overhead shadow paths).
- **Lower floors (legacy):** `restrictRoofScreenLightOcclusionToTopFloor` (default **false**) re-enables the old behavior where roof light gating was **fully disabled** on non-top floors (`uApplyRoofOcclusionToSources = 0`), which caused lights to ignore overhead tiles on those levels. Default is now **gate on every floor**; turn the flag on only if you need the legacy cutout workaround.

## 4. Research decisions (best approach for this codebase)

1. **Prefer Model A (global light + transmittance)** over per-floor light RTs for early phases: keeps Foundry light integration, adds one geometric signal \(T\), avoids N× light accumulation cost.
2. **Do not** fold PIXI bridge world overlays into this pass in Phase 1: bridge composites **after** lighting by design; bridge pixels do not receive `LightingEffectV2` unless a separate pass is added (see [PIXI-CONTENT-LAYER-BRIDGE-PLAN.md](PIXI-CONTENT-LAYER-BRIDGE-PLAN.md)).
3. **VRAM / fill rate:** follow existing precedent—**half-resolution** helper RTs where possible ([`OverheadShadowsEffectV2` shadow path](../ARCHITECTURE-SUMMARY.md)); avoid new full-screen float targets unless necessary.
4. **`_Outdoors`:** keep as **semantic** indoor relief (windows, gameplay masks), not as a substitute for ceiling geometry in screen space.
5. **Do not** use `weatherController.roofMap` as the lighting outdoors mask (already excluded via `allowWeatherRoofMap: false` in [`FloorCompositor._resolveOutdoorsMask`](../../scripts/compositor-v2/FloorCompositor.js)).

## 5. Phase 1 implementation (shipped in repo)

**Goal:** One packed **ceiling light transmittance** texture aligned with the same thresholds the compose shader used for roof alpha (0.20) and roof block (0.55).

**Where:**

- [`OverheadShadowsEffectV2`](../../scripts/compositor-v2/effects/OverheadShadowsEffectV2.js):
  - `ceilingTransmittanceTarget`: half of drawing buffer size, RGBA8, linear filter.
  - Fullscreen blit pass samples `roofVisibilityTarget` and `roofBlockTarget`, writes \(T = (1 - step(0.2,a_{vis})) \times (1 - step(0.55,a_{block}))\) into **R** (and mirrored to G/B for sampling flexibility).
  - `ceilingTransmittanceTextureForLighting`: returns the texture **only** if the blit ran this frame (`_ceilingTransmittanceWritten`). Avoids treating resize-cleared white (T=1) as authoritative before the first blit.
- [`LightingEffectV2`](../../scripts/compositor-v2/effects/LightingEffectV2.js):
  - New uniforms `tCeilingLightTransmittance` / `uHasCeilingLightTransmittance`.
  - When bound, **stampedVis** = sample **R** at `vUv` (half-res upscaled by linear filtering); `_Outdoors` relief uses `ceilingPresent = step(0.25, 1.0 - stampedVis)` when \(T\) is active.
  - Fallback: previous on-the-fly roof alpha + block math if \(T\) is not bound.
- [`FloorCompositor`](../../scripts/compositor-v2/FloorCompositor.js): passes `ceilingTransmittanceTextureForLighting` into `LightingEffectV2.render` (respects `_disableRoofInLighting`).

**Non-goals in Phase 1:** changing ambient-only paths, moving bridge content into the bus, or per-band light RTs.

## 6. Transmittance math (reference)

**Hard gates (Phase 1 blit + lighting fallback, aligned):**

- \(T_{vis} = 1 - H(a_{vis} - 0.12)\) (slightly lower than legacy 0.20 for faint tiles / half-res soften).
- \(T_{block} = 1 - H(a_{block} - 0.45)\).
- \(T = T_{vis} \cdot T_{block}\).

**Compose:** `_Outdoors` indoor relief is capped (`reliefAtten` max 0.22 under ceiling) and suppressed when **occlusion is strong and albedo is dark** (typical roof), so the indoor footprint under the same XY cannot lift lights through visible roof art.

**Future:** optional `smoothstep` or multiplicative softening for stained-glass / partial ceilings; keep in the blit shader so `LightingEffectV2` stays a single sample.

## 7. Edge cases (catalog)

- **Hover-hidden roofs:** visibility pass uses live opacity; blocker pass forces opaque casters—\(T\) reflects that split intentionally.
- **Trees on WEATHER_ROOF_LAYER:** included in visibility/blocker captures used for \(T\); caster-only exclusions remain separate.
- **Orthographic vs perspective:** roof visibility stays **direct screen UV** (no guard-band on `roofVisibilityTarget`); \(T\) inherits that contract.
- **Overhead disabled:** if `roofBlockTarget` is not updated, no blit → lighting does not bind \(T\) (legacy path).

## 8. Open questions / Phase 2+

- Should `_Outdoors` be narrowed to **windows only** once \(T\) is trusted everywhere?
- Band-id texture for pixels when multiple floors are simultaneously visible?
- Author toggle: half-res vs full-res \(T\) for large 4K scenes?
- HealthEvaluator / Breaker Box: extend snapshots if diagnostics need to visualize \(T\).

## 9. References (code)

- [`scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`](../../scripts/compositor-v2/effects/OverheadShadowsEffectV2.js)
- [`scripts/compositor-v2/effects/LightingEffectV2.js`](../../scripts/compositor-v2/effects/LightingEffectV2.js)
- [`scripts/compositor-v2/FloorCompositor.js`](../../scripts/compositor-v2/FloorCompositor.js)
- [`scripts/foundry/pixi-content-layer-bridge.js`](../../scripts/foundry/pixi-content-layer-bridge.js)
