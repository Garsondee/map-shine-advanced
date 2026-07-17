# CandleFlamesEffectV2

**V2 class:** `CandleFlamesEffectV2` · **Source:** `legacy/compositor-v2/effects/CandleFlamesEffectV2.js`

**Rebuilt in V3 as:** `sims.fluids (sim)`, `surface.particles (draw)`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls, grouped as the author grouped them

### Flames

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Enabled | `flamesEnabled` | boolean |  | true |  |
| Max Flames | `maxFlames` | slider | 0 … 20000 | 20000 |  |
| Size (px) | `flameSizePx` | slider | 1 … 64 | 14.5 |  |
| Size Jitter | `flameSizeJitter` | slider | 0 … 1 | 0.45 |  |
| Opacity | `flameOpacity` | slider | 0 … 2 | 1.2 |  |
| Flicker Speed | `flameFlickerSpeed` | slider | 0 … 20 | 2.3 |  |
| Flicker Strength | `flameFlickerStrength` | slider | 0 … 1.5 | 0.3 |  |
| Flicker Speed Jitter | `flameFlickerSpeedJitter` | slider | 0 … 1 | 0.9 |  |
| Flicker Strength Jitter | `flameFlickerStrengthJitter` | slider | 0 … 1 | 0.76 |  |
| Ovality | `flameOvality` | slider | 0 … 0.85 | 0 |  |
| Wobble | `flameWobble` | slider | 0 … 0.8 | 0.2 |  |
| | | | | | _UV bend + tip lean. Higher = flames feel more restless._ |
| Wobble Speed | `flameWobbleSpeed` | slider | 0 … 12 | 9.5 |  |
| | | | | | _How fast the flame shape oscillates._ |
| Shape Chaos | `flameWobbleNoise` | slider | 0 … 0.5 | 0.06 |  |
| | | | | | _Organic pulsing of flame outline (smooth noise on radius)._ |
| Shape Distort | `flameShapeDistort` | slider | 0 … 2 | 1 |  |
| | | | | | _Multiplier on UV wobble displacement._ |
| Indoor Sway | `flameIndoorSway` | slider | 0 … 0.25 | 0.12 |  |
| | | | | | _Horizontal tip sway for indoor candles (draft-like)._ |
| Draftiness (Indoor) | `draftiness` | slider | 0 … 0.4 | 0.11 |  |
| | | | | | _Vertex lean from indoor air currents (stronger at flame tip)._ |
| Wind Influence (Outdoor) | `outdoorWindInfluence` | slider | 0 … 1 | 0.82 |  |
| | | | | | _How much weather wind bends outdoor candle tips._ |
| Outdoor Sway | `outdoorSway` | slider | 0 … 0.25 | 0.25 |  |
| | | | | | _Horizontal tip sway for outdoor candles._ |

### Day / Night (Flames) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Auto Day/Night | `autoDayNightBalance` | boolean |  | true |  |
| | | | | | _Scales flame sprites with scene darkness. Gameplay glow uses Glow (Gameplay Light) day/night scales._ |
| Day Scale | `dayIntensityScale` | slider | 0 … 1.5 | 0.53 |  |
| | | | | | _Flame sprite strength at full daylight (master darkness ≈ 0)._ |
| Night Scale | `nightIntensityScale` | slider | 0.25 … 4 | 1.6 |  |
| | | | | | _Flame sprite multiplier at full night (master darkness ≈ 1)._ |
| Darkness Curve | `dayNightCurve` | slider | 0.25 … 3 | 1.4 |  |
| | | | | | _Above 1 = flame sprites stay dim longer into dusk; below 1 = ramp up earlier._ |

### Glow (Gameplay Light) _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Enabled | `glowEnabled` | boolean |  | true |  |
| Follow Point Light Gain | `glowFollowLightIntensity` | boolean |  | true |  |
| | | | | | _Multiply cancel strength by Lighting → Point light gain so candle pools track torch brightness._ |
| Day Pool Scale | `glowDayIntensityScale` | slider | 0 … 2 | 0.09 |  |
| | | | | | _Gameplay-light pool strength at full daylight. Candles always emit; night adds darkness-cancel on top._ |
| Night Pool Scale | `glowNightIntensityScale` | slider | 0 … 3 | 0.66 |  |
| | | | | | _Brightness multiplier at full night (master darkness ≈ 1). Does not change glow hue._ |
| Night Cancel Boost | `glowDarknessNightBoost` | slider | 1 … 4 | 1 |  |
| | | | | | _Extra darkness-cancel strength at full scene night._ |
| Bucket Size (px) | `glowBucketSizePx` | slider | 64 … 2048 | 384 |  |
| | | | | | _Spatial cluster size for glow pools. Lower values improve wall clipping; large buckets merge distant candles and can bleed through walls._ |
| Max Buckets | `glowMaxBuckets` | slider | 1 … 512 | 256 |  |
| View Streaming (Cull Off-Screen) | `candleViewStreaming` | checkbox |  | true |  |
| | | | | | _Only simulate and render candle clusters inside the camera view. Off-screen clusters are torn down to save CPU._ |
| Wall Clip | `wallClipEnabled` | boolean |  | true |  |
| Clip Radius Scale | `wallClipRadiusScale` | slider | 0.1 … 2 | 0.3 |  |

### Glow — Indoor Balance _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Intensity Scale | `glowIndoorIntensityScale` | slider | 0 … 4 | 0.27 |  |
| | | | | | _Multiplies day/night pool intensity under roof. Outdoor candles use Glow — Outdoor Balance._ |
| Cancel Scale | `glowIndoorCancelScale` | slider | 0 … 4 | 0.61 |  |
| | | | | | _HDR darkness-cancel multiplier for indoor pools (after day/night cancel blend)._ |
| Radius Scale | `glowIndoorRadiusScale` | slider | 0.25 … 12 | 6 |  |
| | | | | | _Indoor pool reach multiplier (after day/night radius blend)._ |
| Night Boost | `glowIndoorNightBoost` | slider | 0 … 4 | 0 |  |
| | | | | | _Extra indoor glow at full darkness. Usually lower than outdoor — interior CC already lifts local light._ |

### Glow — Outdoor Balance

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Intensity Scale | `glowOutdoorIntensityScale` | slider | 0 … 4 | 2 |  |
| | | | | | _Multiplies day/night pool intensity in open air. Push high for torches vs midnight ToD._ |
| Cancel Scale | `glowOutdoorCancelScale` | slider | 0 … 4 | 1.85 |  |
| | | | | | _HDR darkness-cancel multiplier for outdoor pools. Primary control for bright outdoor candle rings._ |
| Radius Scale | `glowOutdoorRadiusScale` | slider | 0.25 … 3 | 1.28 |  |
| | | | | | _Outdoor pool reach multiplier — wider lit area under open sky._ |
| Night Boost | `glowOutdoorNightBoost` | slider | 0 … 4 | 1.15 |  |
| | | | | | _Extra outdoor glow at full darkness, on top of intensity/cancel scales._ |

### Glow — Light Shape

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Shape Motion | `glowShapeMotionEnabled` | boolean |  | true |  |
| | | | | | _Organic pool deformation: center wander, oval stretch, and size pulse synced to flame motion._ |
| Master Scale | `glowShapeMaster` | slider | 0 … 1.5 | 0.32 |  |
| | | | | | _Overall strength of all light-shape motion. Lower = calmer, more stable pools._ |
| Motion Speed | `glowShapeSpeed` | slider | 0.05 … 2.5 | 0.85 |  |
| | | | | | _How fast the pool shape oscillates. Does not affect glow brightness flicker._ |
| Follow Flame Motion | `glowShapeLinkFlameMotion` | boolean |  | true |  |
| | | | | | _When on, shape motion uses Flames folder wobble/sway/draft/wind. When off, uses Chaos only._ |
| Standalone Chaos | `glowShapeChaos` | slider | 0 … 1 | 0.25 |  |
| | | | | | _Agitation when Follow Flame Motion is off, or extra noise mixed in when on._ |
| Center Wander | `glowShapeCenterShift` | slider | 0 … 1 | 0.38 |  |
| | | | | | _How far the bright core drifts horizontally from the candle anchor._ |
| Vertical Wander | `glowShapeCenterVertical` | slider | 0 … 1 | 0.55 |  |
| | | | | | _Vertical component of center drift (0 = mostly horizontal lean)._ |
| Oval Stretch | `glowShapeOvalStretch` | slider | 0 … 1 | 0.28 |  |
| | | | | | _How much the pool breathes between wide and tall ellipses._ |
| Oval Rotation | `glowShapeOvalRotate` | slider | 0 … 1 | 0.22 |  |
| | | | | | _How much the ellipse orientation spins with draft or wind._ |
| Pool Size Pulse | `glowShapeReachPulse` | slider | 0 … 1 | 0.24 |  |
| | | | | | _Outer pool radius breathe — expands and contracts with flicker._ |
| Hot Core Pulse | `glowShapeCorePulse` | slider | 0 … 1 | 0.28 |  |
| | | | | | _Bright-core fraction pulse — mimics flame brightening without moving the rim._ |
| Brightness Link | `glowShapeBrightnessLink` | slider | 0 … 1 | 0.3 |  |
| | | | | | _How much flame flicker modulates glow intensity (separate from shape motion)._ |
| Indoor Scale | `glowShapeIndoorScale` | slider | 0 … 1.5 | 0.85 |  |
| | | | | | _Extra multiplier on shape motion for indoor (roof) pools._ |
| Outdoor Scale | `glowShapeOutdoorScale` | slider | 0 … 1.5 | 1 |  |
| | | | | | _Extra multiplier on shape motion for outdoor pools._ |

### Glow — Day Pool

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Pool Warmth | `glowWarmth` | slider | 0 … 1 | 1 |  |
| | | | | | _Daylight pool hue at full day. Blends toward Glow — Night Pool at darkness._ |
| Pool Intensity | `glowIntensity` | slider | 0 … 2.5 | 0.49 |  |
| | | | | | _Day flicker/intensity at full daylight._ |
| Darkness Cancel (HDR) | `glowDarknessCancel` | slider | 0 … 8 | 0.6 |  |
| | | | | | _Day HDR punch into the light buffer. Night value is in Glow — Night Pool._ |
| Flicker Strength | `glowFlickerStrength` | slider | 0 … 10 | 0.05 |  |
| Flicker Speed | `glowFlickerSpeed` | slider | 0 … 25 | 5.3 |  |
| Flicker Strength Jitter | `glowFlickerStrengthJitter` | slider | 0 … 1 | 0.24 |  |
| Flicker Speed Jitter | `glowFlickerSpeedJitter` | slider | 0 … 1 | 1 |  |
| Pool Radius (px) | `glowRadiusPx` | slider | 8 … 1200 | 514 |  |
| Hot Core Scale | `glowInnerRadiusScale` | slider | 0.05 … 1 | 0.55 |  |
| | | | | | _Bright pool fraction at full day. Remapped so the HDR core occupies most of the pool._ |
| Falloff Exponent | `glowFalloffExponent` | slider | 0.5 … 5 | 0.95 |  |
| | | | | | _Day halo softness. Lower = wider gentle rim (remapped for candle pools)._ |
| Pool Edge Softness | `glowEdgeSoftness` | slider | 0 … 1 | 0.72 |  |
| | | | | | _Feathers the glow rim in the HDR light buffer. Drives shader attenuation + rim geometry (higher = wider, softer pool)._ |

### Glow — Night Pool _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Pool Warmth | `glowNightWarmth` | slider | 0 … 1 | 0.75 |  |
| | | | | | _Night-only pool hue. Blends toward this at full darkness; day warmth is in Glow — Day Pool._ |
| Pool Intensity | `glowNightIntensity` | slider | 0 … 2.5 | 0.09 |  |
| | | | | | _Night flicker/intensity scale at full darkness._ |
| Darkness Cancel (HDR) | `glowNightDarknessCancel` | slider | 0 … 8 | 2 |  |
| | | | | | _Night HDR punch into the light buffer. Usually higher than the day value for midnight scenes._ |
| Flicker Strength | `glowNightFlickerStrength` | slider | 0 … 10 | 0.05 |  |
| Flicker Speed | `glowNightFlickerSpeed` | slider | 0 … 25 | 6.3 |  |
| Flicker Strength Jitter | `glowNightFlickerStrengthJitter` | slider | 0 … 1 | 0.78 |  |
| Flicker Speed Jitter | `glowNightFlickerSpeedJitter` | slider | 0 … 1 | 0.68 |  |
| Pool Radius (px) | `glowNightRadiusPx` | slider | 8 … 1200 | 802 |  |
| | | | | | _Night pool reach at full darkness. Blends from day radius as scene darkens._ |
| Hot Core Scale | `glowNightInnerRadiusScale` | slider | 0.05 … 1 | 0.48 |  |
| | | | | | _Bright pool fraction at full night. Values are remapped so the hot core reads as most of the flame, not a pinprick in an orange disc._ |
| Falloff Exponent | `glowNightFalloffExponent` | slider | 0.5 … 5 | 1.15 |  |
| | | | | | _Night halo softness. Lower = wider gentle rim; higher = tighter core (remapped for candle pools)._ |
| Pool Edge Softness | `glowNightEdgeSoftness` | slider | 0 … 1 | 0.72 |  |
| | | | | | _Night rim feather in the HDR light buffer._ |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| enabled | `enabled` | boolean |  | true | hidden |
