# Iridescence (_Iridescence masks)

**V2 class:** `IridescenceEffectV2` · **Source:** `legacy/compositor-v2/effects/IridescenceEffectV2.js`

**Rebuilt in V3 as:** `surface.response`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Adds a **thin-film / holographic** layer on tiles (and the scene background) that ship a matching **`_Iridescence`** texture next to the art.

The shader blends **screen-space flow**, **world noise**, and **mask-driven distortion** into shifting spectral color. **Foundry lights** tint the result; **ignore darkness** keeps color visible in shadow.

One overlay per masked source, on the floor bus — visibility follows level/floor rules like Specular/Bush.

Tile overlays are **parented to the same bus transform as the albedo tile** (like Specular V2) so mask UVs stay locked to the art.

**Mask rule:** **luminance × α** — paint **light** where shimmer goes; transparent stays empty. **Invert mask** flips black↔white for inverse paint.

**Noise scale** is a **0–1 UI** value mapped internally to shader frequency (higher = finer detail).

Settings save with the scene (not World Based).

## The knobs, in the author's words

- **Texture** — Whether the scene found at least one `_Iridescence` texture after load (row under Enabled).
- **Intensity** — Strength of the iridescent color contribution.
- **Opacity** — Master alpha for the additive layer (`alpha` uniform).
- **Flow speed** — How fast the phase field scrolls in screen UV space.
- **Parallax strength** — How much the view offset shifts the pattern (camera parallax).
- **Ignore darkness** — How much to resist Foundry darkness / night tint on the effect (0 = full scene darkening, 1 = mostly ignore).
- **Color cycle speed** — Rate of hue rotation over time.
- **Noise type** — Liquid = smoother bands; Glitter = grainier, sparklier noise.
- **Distortion strength** — How strongly the mask warps UVs into the noise field.
- **Noise scale** — UI 0–1 mapped to internal noise frequency (see summary).
- **Phase multiplier** — Scales interference fringe density.
- **Mask threshold** — Cutoff on decoded mask strength — higher keeps only stronger regions.
- **Invert mask** — Turn **on** to flip black↔white (shine follows **dark** pixels instead of bright).

## Authored presets

`Calm` · `Vivid` · `Subtle`

## Controls, grouped as the author grouped them

### Look

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Intensity | `intensity` | slider | 0 … 2 | 0.5 |  |
| | | | | | _Strength of the iridescent color._ |
| Opacity | `alpha` | slider | 0 … 1 | 0.5 |  |
| | | | | | _Master alpha for the additive overlay._ |

### Motion & parallax

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Flow speed | `flowSpeed` | slider | 0 … 5 | 1.5 |  |
| | | | | | _Screen-space scroll speed of the interference pattern._ |
| Angle | `angle` | slider | 0 … 360 | 0 |  |
| | | | | | _Flow direction in degrees._ |
| Parallax strength | `parallaxStrength` | slider | 0 … 5 | 3 |  |
| | | | | | _How much the pattern shifts with camera movement._ |

### Spectral & lighting _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Noise type | `noiseType` | list | Liquid (smooth) / Glitter (grain) | 0 |  |
| | | | | | _Liquid = smoother bands; Glitter = sharper, grainier sparkle._ |
| Ignore darkness | `ignoreDarkness` | slider | 0 … 1 | 0.5 |  |
| | | | | | _Higher = keep iridescence visible when the scene is dark or night-tinted._ |
| Color cycle speed | `colorCycleSpeed` | slider | 0 … 2 | 0.1 |  |
| | | | | | _How fast hues shift over time._ |

### Distortion & noise _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Distortion strength | `distortionStrength` | slider | 0 … 2 | 0.92 |  |
| | | | | | _UV warp from the mask into the noise field._ |
| Noise scale | `noiseScale` | slider | 0 … 1 | 0.68 |  |
| | | | | | _0–1 UI mapped to internal noise frequency (higher = finer detail)._ |
| Phase multiplier | `phaseMult` | slider | 0.5 … 6 | 4 |  |
| | | | | | _Density of interference fringes._ |

### Mask _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Mask threshold | `maskThreshold` | slider | 0 … 1 | 0.05 |  |
| | | | | | _Minimum decoded mask strength to show iridescence; trims weak edges._ |
| Invert mask | `invertMask` | boolean |  | false |  |
| | | | | | _Off = brighter `_Iridescence` pixels = more shine (usual white-on-black paint). On = invert luminance (black = shine)._ |
