# Health Wiring Badge Coverage

Purpose: Track which effects include the in-file health wiring requirement badge and have baseline contract wiring in `HealthEvaluatorService`.

## Rule

When an effect has a badge, any functional change to that effect must include a review/update of health evaluator wiring to prevent silent failures.

## Badged + Wired Effects

- `WaterEffectV2`
- `CloudEffectV2`
- `OverheadShadowsEffectV2`
- `WindowLightEffectV2`
- `PlayerLightEffectV2`
- `FireEffectV2`
- `LightingEffectV2`
- `WaterSplashesEffectV2`
- `DustEffectV2`
- `SkyColorEffectV2`
- `BuildingShadowsEffectV2`

## Expansion Queue

- `CandleFlamesEffectV2`
- `FloorDepthBlurEffectV2` (or equivalent bus blur path)
- `DistortionManager` / post-chain effects not yet contracted
