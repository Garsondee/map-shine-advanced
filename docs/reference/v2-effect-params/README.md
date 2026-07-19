# V2 effect parameters — a reference, not a schema

Machine-harvested from `legacy/` by `tools/harvest-params.mjs` on 2026-07-17: **45 effects, 2240 controls, 25 carrying the author's own prose.**

> **Do not port these values.** Every effect is being rebuilt from scratch in TSL (author, 2026-07-17: *"it's very likely that even using the exact same settings wouldn't give us the result we want"*). These numbers were tuned against V2's GLSL math, which is being deleted with `legacy/` at Stage 7. What survives a rewrite is **which knobs existed, what they were for, and what they were called** — a feature wishlist and a design vocabulary, in the author's own voice. That is the whole value here.

## By the V3 pass that replaces them

Cross-referenced against `src/graph/passes.js`'s `absorbs` declarations.

### `frame.snapshot`

- [SceneWindField](scene-wind-field.md) — `SceneWindField`, 35 controls
- [WeatherController](weather-controller.md) — `WeatherController`, 122 controls

### `geometry.world`

- [Bush canopy (_Bush masks)](bush-effect.md) — `BushEffectV2`, 56 controls
- [Tree canopy (_Tree masks)](tree-effect.md) — `TreeEffectV2`, 58 controls

### `light.accumulate`

- [Light Physics](lighting-effect.md) — `LightingEffectV2`, 83 controls
- [LightningEffectV2](lightning-effect.md) — `LightningEffectV2`, 65 controls
- [PlayerLightEffectV2](player-light-effect.md) — `PlayerLightEffectV2`, 160 controls
- [Sky Environment (exports)](sky-color-effect.md) — `SkyColorEffectV2`, 3 controls
- [VisionModeEffectV2](vision-mode-effect.md) — `VisionModeEffectV2`, 1 controls
- [WeatherLightningEffectV2](weather-lightning-effect.md) — `WeatherLightningEffectV2`, 43 controls
- [Window Light](window-light-effect.md) — `WindowLightEffectV2`, 99 controls

### `light.visibility`

- [Building Shadows](building-shadows-effect.md) — `BuildingShadowsEffectV2`, 13 controls
- [CloudEffectV2](cloud-effect.md) — `CloudEffectV2`, 58 controls
- [OverheadStampEffectV2](overhead-stamp-effect.md) — `OverheadStampEffectV2`, 21 controls
- [Painted Shadows](painted-shadow-effect.md) — `PaintedShadowEffectV2`, 9 controls
- [SkyReachShadowsEffectV2](sky-reach-shadows-effect.md) — `SkyReachShadowsEffectV2`, 10 controls

### `masks.occlusion`

- [OverheadStampEffectV2](overhead-stamp-effect.md) — `OverheadStampEffectV2`, 21 controls

### `post.grade`

- [ASCII art](ascii-effect.md) — `AsciiEffectV2`, 19 controls
- [Atmospheric Fog & Air](atmospheric-fog-effect.md) — `AtmosphericFogEffectV2`, 41 controls
- [Bloom (glow)](bloom-effect.md) — `BloomEffectV2`, 26 controls
- [Camera Grade (HDR to LDR)](color-correction-effect.md) — `ColorCorrectionEffectV2`, 145 controls
- [Contextual Scene Grade](contextual-scene-grade-effect.md) — `ContextualSceneGradeEffectV2`, 218 controls
- [DazzleOverlayEffectV2](dazzle-overlay-effect.md) — `DazzleOverlayEffectV2`, 8 controls
- [DistortionManager](distortion-manager.md) — `DistortionManager`, 5 controls
- [Dot screen (halftone)](dot-screen-effect.md) — `DotScreenEffectV2`, 6 controls
- [Filter (multiply / ink AO)](filter-effect.md) — `FilterEffectV2`, 18 controls
- [Floor depth blur](floor-depth-blur-effect.md) — `FloorDepthBlurEffect`, 4 controls
- [GridRenderer](grid-renderer.md) — `GridRenderer`, 11 controls
- [Halftone (print)](halftone-effect.md) — `HalftoneEffectV2`, 7 controls
- [Color invert](invert-effect.md) — `InvertEffectV2`, 2 controls
- [LensEffectV2](lens-effect.md) — `LensEffectV2`, 97 controls
- [Sepia tone](sepia-effect.md) — `SepiaEffectV2`, 2 controls
- [Sharpen (unsharp mask)](sharpen-effect.md) — `SharpenEffectV2`, 4 controls

### `present.composite`

- [FogOfWarEffectV2](fog-of-war-effect.md) — `FogOfWarEffectV2`, 11 controls

### `sims.fluids`

- [CandleFlamesEffectV2](candle-flames-effect.md) — `CandleFlamesEffectV2`, 77 controls
- [Fire](fire-effect.md) — `FireEffectV2`, 167 controls
- [FluidEffectV2](fluid-effect.md) — `FluidEffectV2`, 61 controls

### `sims.particles`

- [Ash Disturbance](ash-disturbance-effect.md) — `AshDisturbanceEffectV2`, 14 controls
- [Dust Motes](dust-effect.md) — `DustEffectV2`, 20 controls
- [SmellyFliesEffect](smelly-flies-effect.md) — `SmellyFliesEffect`, 12 controls
- [Water Splashes](water-splashes-effect.md) — `WaterSplashesEffectV2`, 37 controls

### `surface.particles`

- [AshCloudEffectV2](ash-cloud-effect.md) — `AshCloudEffectV2`, 23 controls
- [CandleFlamesEffectV2](candle-flames-effect.md) — `CandleFlamesEffectV2`, 77 controls
- [Fire](fire-effect.md) — `FireEffectV2`, 167 controls

### `surface.response`

- [Iridescence (_Iridescence masks)](iridescence-effect.md) — `IridescenceEffectV2`, 13 controls
- [PrismEffectV2](prism-effect.md) — `PrismEffectV2`, 12 controls
- [Metallic / specular (tile overlays)](specular-effect.md) — `SpecularEffectV2`, 67 controls

### `surface.water`

- [WaterEffectV2](water-effect.md) — `WaterEffectV2`, 277 controls
