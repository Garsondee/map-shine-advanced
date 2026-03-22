# Specular “wetness” driven by precipitation — V1 git history & current parity

**Date:** 2026-03-22  
**Scope:** Map how the Specular effect’s rain wetness worked in **V1** (`scripts/effects/SpecularEffect.js`, removed in `831404a`), how **WeatherController** surface wetness evolved, and how **V2** (`SpecularEffectV2.js` + `specular-shader.js`) carries the same shader logic today.

---

## Executive summary

1. **Weather `wetness` as a state field** exists since the first weather architecture commit (`b28cba6`, 2025-11-21). It was always **derived** in `_updateWetness`, not authored manually in the long term.

2. **Specular did not consume that wetness until much later.** The feature “exterior wetness in specular” landed in **`56fcb60`** (*Working exterior wetness effect*, 2026-02-12). It introduced **wet specular from albedo grayscale** plus **`uRainWetness`**, initially computed from **live precipitation** (rain only) and **`wetSpecularThreshold`**, not from `weather.wetness`.

3. **`7e593c2`** (*Exterior surfaces will become wet in the rain…*) switched Specular to read **`weather.wetness`** from `WeatherController.getCurrentState()` and replaced `_updateWetness` with **rain-only** accumulation, **transition holdoff**, and **tunable wetting/drying durations**. The UI slider `wetSpecularThreshold` was marked **DEPRECATED** (wetness comes from the tracker).

4. **V1 removal:** `831404a` (*Starting to remove V1 files*) deleted `SpecularEffect.js`. The last pre-removal snapshot is parent **`fcfc398`** (`831404a~1`).

5. **V2** (`50ce5bd` *Basic specular V2 effect is working*) moved the shader into **`scripts/compositor-v2/effects/specular-shader.js`** and logic into **`SpecularEffectV2.js`**. The **wet mask + `uRainWetness` + outdoor roof mask** pipeline matches the late-V1 design.

6. **Why “whole albedo” outdoor wet shine can look broken:** In both late-V1 and current V2 fragment code, **final wet specular is multiplied by `effectsOnly`** (animated stripes + outdoor cloud specular term + sparkles) **plus wind ripple**. So the **reflectivity** is derived from **full-tile albedo** (`wetMask`), but the **brightness** is still gated by **non-base effects**. If stripes/cloud spec/sparkles are off or near zero, wet shine is **mostly limited to wind ripple** — not a uniform damp sheen across the outdoor albedo. That matches the in-shader comment from the historical implementation: wet surfaces were intended to light up where **animated** effects sweep, not as a flat white overlay.

---

## Commits (chronological)

| Commit | Date (author) | Message |
|--------|----------------|--------|
| `b28cba6` | 2025-11-21 | Initial weather system architecture — `wetness` in state + simple `_updateWetness` (damp toward wet/dry from precip > 0.1). |
| `56fcb60` | 2026-02-12 | **Working exterior wetness effect** — Specular gains wet-surface params, `uRainWetness`, fragment wet path, roof/outdoor gating; **rain wetness from precipitation × threshold** (rain type only). |
| `7e593c2` | 2026-02-12 | **Exterior surfaces will become wet…** — Specular reads **`weather.wetness`**; WeatherController gets **wetness tracker** tuning + rain-only + transition holdoff; frost/wind/building-shadow additions bundled in same Specular commit. |
| `50ce5bd` | (history) | Basic specular **V2** effect — new compositor effect + extracted shader. |
| `831404a` | (history) | **Starting to remove V1 files** — `scripts/effects/SpecularEffect.js` deleted. |

Useful pickaxe search:

```bash
git log -S "wetness" -- "*.js"
```

---

## Phase A — `56fcb60`: precipitation + threshold (not yet tracker `wetness`)

**Intent:** Derive a **wet specular mask** from **grayscale albedo** (contrast / black-white points), modulated by **outdoor** regions (`outdoorFactor` from `_Roof` / roof mask), scaled by **rain intensity** encoded into `uRainWetness`.

**JS behavior (later replaced in `7e593c2`):** For `PrecipitationType.RAIN` only:

```text
rainWetness = clamp( (precipitation - threshold) / (1 - threshold), 0, 1 )
```

So **`wetSpecularThreshold`** was a real control: below threshold → dry.

**Shader behavior (carried forward to V2):**

- `uniform float uRainWetness` — 0 dry, 1 fully wet.
- Build `wetMask` from albedo luminance → input CC (brightness, gamma, contrast) → smoothstep black/white points → **`wetMask = processedGray * outdoorFactor * uRainWetness`**.
- **Outdoor-only:** `outdoorFactor` from roof texture so **indoors stays dry**.

---

## Phase B — `7e593c2`: `WeatherController.wetness` drives `uRainWetness`

**JS:** `rainWetness = clamp(weather.wetness ?? 0, 0, 1)` — **no precip-type check in Specular**; the controller only **increases** wetness when **`precipType === RAIN`** (snow/hail/ash do not wet surfaces — frost path is separate).

**WeatherController `_updateWetness` (conceptual):**

- `targetWetness`: if rain and `precip > precipThreshold` → `min(1, precip)`, else `0`.
- While **`isTransitioning`**: hold wetness (no drift until transition completes).
- Wetting: rate scales with **effective precipitation** and **`wettingDuration`**.
- Drying: rate from **`dryingDuration`** proportional to how wet it still is.

**Deprecated:** `wetSpecularThreshold` in params (slider may still exist in schema for old saves but **driver** is tracker wetness).

---

## V1 last snapshot (`fcfc398` / `831404a~1`)

- **File:** `scripts/effects/SpecularEffect.js` (~3295 lines).
- **Material:** Single PBR `ShaderMaterial` on the **base plane** when a scene `_Specular` mask existed; **per-tile overlays** for tiles with masks. Wetness applied to **shared** materials via `update()` pushing `uRainWetness` each frame.
- **Import:** `weatherController`, `PrecipitationType` from `WeatherController.js`.

---

## V2 current code (parity check)

| Concern | Location |
|--------|----------|
| Per-frame `rainWetness` from `weather.wetness` | `SpecularEffectV2.update()` — sets `u.uRainWetness` |
| Fragment: `wetMask` from albedo CC × `outdoorFactor` × `uRainWetness` | `specular-shader.js` fragment |
| `wetEffects = effectsOnly + windRipple` then wet specular | Same file — **multiplies wetMask by animated effects** |

**Outdoor region:** `outdoorFactor` from `uRoofMap` when `uRoofMaskEnabled` — white = outdoor, black = interior/roof-occluded (exact semantics depend on mask authoring).

---

## Implications for “weather-based whole albedo specularity outdoors”

- **Already partially there:** albedo-derived **`wetMask`** across the tile, gated to **outdoors** via **`outdoorFactor`**, scaled by **`uRainWetness`** from **`WeatherController`** (rain accumulation).
- **Not a uniform sheen:** **`wetSpecularColor`** is **`wetMask * (effectsOnly + windRipple) * …`**. For a **constant** outdoor wet sheen independent of stripes/clouds/sparkles, the shader would need a **separate term** (e.g. add a base `1.0` or `outdoorFactor`-only channel for wet, or a dedicated uniform), which is **different** from the preserved V1 behavior.

---

## Commands for follow-up archaeology

```bash
# Full V1 file at last revision before deletion
git show fcfc398:scripts/effects/SpecularEffect.js

# First wet-specular implementation diff
git show 56fcb60 -- scripts/effects/SpecularEffect.js

# Switch to tracker-driven wetness + WeatherController tuning
git show 7e593c2 -- scripts/effects/SpecularEffect.js scripts/core/WeatherController.js
```

---

## References (this repo, current tree)

- `scripts/compositor-v2/effects/SpecularEffectV2.js` — `update()` weather / `uRainWetness`
- `scripts/compositor-v2/effects/specular-shader.js` — `uRainWetness`, `wetMask`, `effectsOnly`, `wetSpecularColor`
- `scripts/core/WeatherController.js` — `wetnessTuning`, `_updateWetness`, rain-only wetting
