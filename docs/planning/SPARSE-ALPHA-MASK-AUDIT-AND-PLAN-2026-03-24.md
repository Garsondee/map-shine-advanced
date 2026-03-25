# Sparse Alpha Mask Audit and Plan (2026-03-24)

## Goal

Determine whether masks beyond `_Outdoors` can suffer the same upper-floor artifact class:
- bloated/expanded silhouette
- blocky/pixelated mask edge
- incorrect indoor/outdoor-like classification when sparse upper-floor mask data is present

This document captures research findings and a remediation plan.

## Core Finding

Yes. Any mask consumer that treats mask value as `texture2D(mask, uv).r` (or RGB) without checking alpha validity can misclassify sparse no-data texels on upper floors.

The known-safe pattern (confirmed by the Sky fix) is:

```glsl
vec4 m = texture2D(mask, uv);
float value = clamp(mix(defaultValue, m.r, m.a), 0.0, 1.0);
```

Where:
- `m.a` is "is this texel valid/authored"
- `defaultValue` is mask-specific (for `_Outdoors`, default outdoors = `1.0`)

## Why This Happens

Upper-floor composited masks often contain sparse coverage. Unwritten regions can be `RGBA=(0,0,0,0)`.

If a shader reads only `.r`, those no-data texels become hard "0" and can be interpreted as real semantic data (e.g., indoors, blocked, no effect). After reprojection/filtering, this appears as expanded blocky silhouettes.

## What We Audited

- `scripts/compositor-v2/effects/*` shader sampling paths
- `scripts/masks/GpuSceneMaskCompositor.js` mask composition behavior
- mask-dependent particle paths
- CPU-side roof/outdoor sampling (`WeatherController`)

## Current Safe vs Risky Consumers

### Safe (alpha-validity already handled or equivalent guard)

- `scripts/compositor-v2/effects/SkyColorEffectV2.js`
  - Uses `mix(1.0, m.r, m.a)` for `_Outdoors`.
- `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`
  - Uses `mix(1.0, m.r, m.a)` for `_Outdoors`.
- `scripts/compositor-v2/effects/BuildingShadowsEffectV2.js`
  - Uses alpha-valid `_Outdoors` reads.
- `scripts/compositor-v2/effects/LightingEffectV2.js`
  - Uses alpha-aware gating in roof/outdoor logic.

### Risky (raw `.r` reads for semantic gating)

- `scripts/compositor-v2/effects/CloudEffectV2.js`
  - `_Outdoors` reads from single/per-floor samplers are `.r` only.
- `scripts/compositor-v2/effects/FilterEffectV2.js`
  - `_Outdoors` AO gating uses `.r` only.
- `scripts/compositor-v2/effects/water-shader.js`
  - `_Outdoors` sample uses `.r` only.
- `scripts/compositor-v2/effects/DistortionManager.js`
  - `_Outdoors` strength uses `.r` only.
- `scripts/compositor-v2/effects/specular-shader.js`
  - roof/outdoor factor uses `.r` only.
- `scripts/particles/WeatherParticles.js`
  - weather mask logic assumes channel-only values.
- `scripts/particles/SnowGeometry.js`
  - roof cover gate uses `.r` only.
- `scripts/particles/shaders/rendering.js`
  - outdoor factor uses `.r` only.
- `scripts/core/WeatherController.js` (CPU path)
  - extracts/uses red-channel roof mask data; alpha validity discarded.

## Mask Types Beyond `_Outdoors`

Question: could other upper-floor masks be affected the same way?

Short answer: yes, if all are true:
1. mask can be sparse/no-data in parts of the RT,
2. consumer uses channel-only semantic decisions (`.r` thresholds),
3. effect interprets zeros as meaningful "off/indoors/blocked".

Likely vulnerable semantic masks:
- outdoors/roof-class masks
- any binary coverage mask used for clipping, suppression, or spawn gating

Less vulnerable (but still worth review):
- continuous artistic masks where zero is acceptable and no binary semantic decision is made
- pure visual multipliers not used as hard gates

## Project Standard Proposal

Adopt a mask-sampling convention for semantic masks:

- **Rule A**: Use RGBA validity-aware decode
  - `value = mix(defaultValue, m.r, m.a)`
- **Rule B**: Document default semantic per mask
  - `_Outdoors`: default `1.0` (outdoors) when invalid
  - others: define per mask contract
- **Rule C**: Apply thresholding only after validity decode
  - `step(threshold, value)`
- **Rule D**: Keep one helper per shader file for consistency

## Priority Remediation Plan

### Phase 1 (highest visual risk)

Patch these to validity-aware `_Outdoors` reads:
- `CloudEffectV2`
- `water-shader.js` (WaterEffectV2)
- `DistortionManager.js`
- `FilterEffectV2`
- `specular-shader.js`

Expected impact:
- remove blocky upper-floor contamination in any pass using `_Outdoors`.

### Phase 2 (weather/particle stability)

Patch:
- `WeatherController.js` CPU roof mask extraction + lookup
- particle shaders (`WeatherParticles`, `SnowGeometry`, `particles/shaders/rendering.js`)

Expected impact:
- prevent weather/particle indoor/outdoor misclassification on sparse upper-floor masks.

### Phase 3 (contract hardening)

- Add "semantic default" comments where masks are sampled.
- Add a short "mask validity contract" section to architecture docs.
- Add a smoke-test checklist for floor 0 vs upper floor transitions.

## Verification Checklist

After each phase:
- Upper floor: check previously problematic silhouettes at high contrast.
- Toggle each effect independently (sky/water/cloud/distortion/filter/specular).
- Validate indoor/outdoor correctness on both ground and upper floors.
- Verify no regression in performance or obvious mask flicker during floor transitions.

## Notes

- The SkyColor fix proved the root class of issue is real and not effect-specific.
- This should be treated as a cross-effect mask contract problem, not a one-off shader bug.

## Continued Research (2026-03-24, pass 2)

This pass extends the audit into CPU weather masking, particle spawn/render paths,
and mask policy plumbing.

### New Evidence Found

- `scripts/core/WeatherController.js`
  - `_extractRoofMaskData()` stores only the red channel from RGBA (`pixels[i * 4]`), discarding alpha validity.
  - `getRoofMaskIntensity()` returns `roofMaskData[idx] / 255.0`, so no-data sparse texels can become semantic zero.
- `scripts/particles/WeatherParticles.js`
  - precipitation fragment code samples `_Outdoors` as `texture2D(uRoofMap, uvMask).r` and thresholds directly.
- `scripts/particles/DustMotesEffect.js`
  - spawn gating reads dust/structural/outdoors from red-channel only CPU data, with no alpha validity decode.
- `scripts/masks/GpuSceneMaskCompositor.js`
  - composition correctly preserves RGBA in source-over mode, but downstream consumers frequently read `R` only.
  - this confirms the issue is mostly at consumer decode sites, not mask composition itself.

### Mask Semantics Matrix (Extended)

| Mask Type | Typical Meaning | Current Common Decode | Recommended Decode | Default When `A=0` |
|---|---|---|---|---|
| `_Outdoors` / roof map | outdoors=1, indoors=0 | `m.r` | `mix(1.0, m.r, m.a)` | `1.0` (outdoors) |
| dust | dust allowance/strength | `m.r` | `mix(0.0, m.r, m.a)` | `0.0` (no dust) |
| structural | interior/structure gate for dust/etc | `m.r` | `mix(1.0, m.r, m.a)` | `1.0` (do not hard-block unknown) |
| water (binary gating) | water present/absent | `m.r` or luminance | `mix(0.0, value, m.a)` | `0.0` (no water) |
| water data (flow vectors, foam controls) | continuous data field | channel reads with ad-hoc fallback | if `m.a` invalid treat as "no sample" path | feature-specific fallback |
| fire / ash spawn masks | spawn allowance | `m.r` | `mix(0.0, m.r, m.a)` | `0.0` (no spawn) |
| windows/light contribution masks | additive light shaping | `m.r`/luma | `mix(0.0, value, m.a)` | `0.0` (no contribution) |
| floor alpha | tile coverage | alpha-extract path | keep current | `0.0` (no coverage) |

### Architectural Gap

Current architecture has:
- a composition contract (blend mode, preserveAcrossFloors behavior),
- but no explicit semantic contract for invalid texels (`A=0`) at consumption time.

Result: each effect or CPU path invents its own default implicitly (usually via raw `.r`),
which is exactly what causes upper-floor sparse-mask regressions.

### Proposed Contract Addendum

Add a "semantic decode contract" per mask type:

- Every semantic mask read must be validity-aware (`A` is authoritative validity).
- Default value for invalid texels is defined per mask type, in one central table.
- Thresholding/gating happens only after decode.
- CPU readbacks must keep alpha (or reconstruct validity) if the value participates in semantic gating.

### Suggested Implementation Shape

1. Add a central table (mask type -> default semantic + decode mode), near mask registry/policies.
2. Add shared helpers:
   - GLSL helper snippets per effect file (or injected utility chunk),
   - JS helper for CPU readback decode (WeatherController + particle spawn scans).
3. Migrate highest-risk consumers first (`_Outdoors` in particles/weather), then other binary gates.
4. Keep existing composition/blend behavior; focus on consumer decode normalization.

### Additional Risk Notes

- Any path that downsamples masks to CPU arrays and stores only one channel is high-risk unless it also stores validity.
- Distinguish two cases:
  - missing texture: often already handled by global fallback,
  - present texture with sparse alpha: currently the main regression source.

## Full Mask Inventory Coverage

This pass explicitly checked all mask IDs declared in `scripts/assets/loader.js` (`EFFECT_MASKS`):

- `specular`
- `roughness`
- `normal`
- `fire`
- `ash`
- `dust`
- `outdoors`
- `iridescence`
- `fluid`
- `prism`
- `windows`
- `structural`
- `bush`
- `tree`
- `water`

### Coverage Width (Issue-Focused)

- Mask types covered: **15/15 (100%)**
- Issue lens: **sparse-alpha semantic misclassification** (`A=0` interpreted as meaningful zero)
- Consumer classes covered:
  - compositor V2 shader consumers
  - particle shader consumers
  - CPU mask readback/scan consumers
  - mask composition/preserve policy layer

### Per-Mask Risk Classification (for this issue class)

| Mask | Coverage Status | Risk for Sparse-Alpha Semantic Bug | Notes |
|---|---|---|---|
| outdoors | fully audited | **High** | many semantic gates still use raw `.r` in non-Sky paths |
| water | fully audited | **High** | raw-channel gating exists in shader + particle paths |
| dust | fully audited | Medium | mixed: some alpha-aware (`lum*a`), some raw-channel reads |
| structural | fully audited | **High** | CPU gating in dust spawn path uses raw red only |
| ash | fully audited | Medium | CPU spawn scanning uses red-channel thresholding |
| fire | fully audited | Low-Medium | core fire point scan uses luminance*alpha (good baseline) |
| windows | fully audited | Low | mostly contribution masks; not primary semantic hard-gate class |
| specular | fully audited | Low (current) / Medium (future misuse) | mostly continuous shading, not indoor/outdoor semantics |
| roughness | fully audited | Low (current) / Medium (future misuse) | same as specular |
| normal | fully audited | Low | vector/detail data, not binary semantics |
| iridescence | fully audited | Low-Medium | thresholded artistic mask; no critical semantic gating |
| fluid | fully audited | Low | current decode already uses RGBA-aware coverage (`a*luma`) |
| prism | fully audited | Low-Medium | thresholded artistic mask; not world semantic gating |
| bush | fully audited | Low | alpha-driven (`safeAlpha`) rendering path |
| tree | fully audited | Low | alpha-driven (`safeAlpha`) rendering path |

### What "100% coverage" means here

It means all declared mask *types* were examined for this specific defect class.

It does **not** mean every single texture sample in the repository was exhaustively proven bug-free for unrelated classes (precision noise, UV transforms, filtering artifacts, etc.). This plan remains specifically targeted at sparse-alpha semantic decode errors on upper floors.
