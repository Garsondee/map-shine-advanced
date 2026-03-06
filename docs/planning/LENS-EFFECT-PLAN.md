---
description: Lens Effect plan — 12 real 4K textures, slot-based overlay system, scene-luma reactivity, Add blend before distortion
---

# Lens Effect Plan (Imperfection-First)

## 1) Objective

Build a dedicated **Lens Effect** post-processing pass that delivers a strong, stylish, imperfect camera vibe. Goal is a nice-looking visual effect, not a realistic camera simulation.

Core chain: lens texture overlays → distortion → chromatic aberration → vignette → grain.

---

## 2) Texture Catalog — 12 real 4K assets

All textures are in `assets/lens assets/`. All are predominantly black with bright content only where the effect should appear — this makes them **perfect colored luma masks for Add blending** (black contributes nothing, bright areas add their color to the scene).

### Group 1 — Structural / Static
These are always visible regardless of scene brightness. Content is concentrated at the **periphery** with naturally dark centers.

| ID | File | Character |
|----|------|-----------|
| 0 | `lens_dust_01.jpg` | Fine white dust specks and fibers, very edge-heavy, sparse center |
| 1 | `lens_grease_01.jpg` | Blue-teal grease smears, visible fingerprint (upper-left), wipe marks |
| 2 | `lens_grease_02.jpg` | Bold diagonal brush strokes, bokeh blur circles on left edge |
| 3 | `lens_grease_03.jpg` | Subtle broad cloud-like grease haze, corners and edges only |
| 4 | `lens_scratches_01.jpg` | Diagonal scratch cluster (upper-left), fine debris, two soft bokeh blobs |

### Group 2 — Optical Artifacts
Optical elements baked onto the lens. Moderate luma reactivity — more visible in brighter scenes.

| ID | File | Character |
|----|------|-----------|
| 5 | `lens_leak_01.jpg` | Teal/cyan/purple ring around center (natural clear center built-in) |
| 6 | `lens_leak_02.jpg` | Geometric ring arc fragments, green/yellow/grey segments |
| 7 | `lens_overlay_01.jpg` | Camera viewfinder HUD — corner brackets, center reticle, aperture scale |

### Group 3 — Light-Reactive
These should only become visible when the scene is bright. Very high luma reactivity.

| ID | File | Character |
|----|------|-----------|
| 8 | `light_leak_01.jpg` | Diagonal rainbow prismatic streak from top-left, vivid spectrum color |
| 9 | `light_leak_02.jpg` | Heavy green/teal/orange/warm color wash from corners — very bold |
| 10 | `rainbow_chroma_01.jpg` | Scattered prismatic rainbow fragments, lower-right area |
| 11 | `rainbow_chroma_02.jpg` | Scattered prismatic orbs, multiple colored specular blobs |

---

## 3) Layer Slot System

The shader supports **4 independent configurable layer slots** (A, B, C, D). No slot is tied to a specific texture category — any texture can go in any slot.

### Per-slot parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `textureIndex` | int (0–11) | Which catalog texture to use. -1 = disabled. |
| `intensity` | 0.0–2.0 | Base Add blend strength |
| `lumaReactivity` | 0.0–1.0 | How much scene brightness amplifies this slot |
| `lumaBoost` | 0.5–4.0 | Multiplier for when lumaReactivity is high (for light-leak behavior) |
| `centerClearRadius` | 0.0–0.5 | Extra radial mask to protect the center (UV distance from 0.5,0.5) |
| `centerClearSoftness` | 0.01–0.2 | Edge softness of the center mask |
| `driftSpeedX` | −0.001–0.001 | Very slow UV drift per second (horizontal) |
| `driftSpeedY` | −0.001–0.001 | Very slow UV drift per second (vertical) |
| `pulseMagnitude` | 0.0–0.3 | Amplitude of sine intensity modulation |
| `pulseFrequency` | 0.0–2.0 | Hz of intensity pulse |
| `pulsePhase` | 0.0–6.28 | Phase offset so slots don't pulse in sync |

### Why center clearance is mostly a non-issue

Viewing all 12 textures: **dust, grease, scratches, lens_leak rings** are already black in the center — no masking needed. **light_leak_02, rainbow_chroma_01/02** have content that bleeds toward center — these get `centerClearRadius = 0.25–0.30` by default to protect the viewing area.

---

## 4) Colored Luma Mask Treatment

Every texture is treated identically as a **colored luma mask**. The sampling formula per slot:

```glsl
// Sample the texture at aspect-safe UV
vec2 uvFit = vUv * slot.scaleOffset.xy + slot.scaleOffset.zw;
// Add per-frame drift animation
uvFit += vec2(slot.driftSpeedX, slot.driftSpeedY) * uTime;
vec3 texColor = texture2D(slotTex, uvFit).rgb;

// Luma of the texture drives how much it contributes
float texLuma = dot(texColor, LUM_WEIGHTS);

// Scene luma drives a reactivity multiplier
float reactivity = mix(1.0, sceneLuma * slot.lumaBoost, slot.lumaReactivity);

// Intensity pulse animation
float pulse = 1.0 + sin(uTime * slot.pulseFreq + slot.pulsePhase) * slot.pulseMag;

// Center clearance mask (radial, from screen center)
float dist = length(vUv - vec2(0.5));
float clearMask = smoothstep(
    slot.clearRadius - slot.clearSoftness,
    slot.clearRadius + slot.clearSoftness,
    dist
);

// Final contribution — Add blend
float effectiveFactor = slot.intensity * reactivity * pulse * clearMask;
sceneColor += texColor * effectiveFactor;
```

Because the textures are colored (not just greyscale), the Add blend preserves the natural color of each texture — light leaks contribute their rainbow hues, grease contributes their blue-teal cast, dust contributes near-neutral whites.

---

## 5) Scene Luma Estimation — Shader Side

No CPU readback needed. A cheap 9-point sparse grid sample in the fragment shader computes scene average brightness:

```glsl
vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

float estimateSceneLuma() {
    float s = 0.0;
    s += dot(texture2D(tDiffuse, vec2(0.2, 0.2)).rgb, LUM);
    s += dot(texture2D(tDiffuse, vec2(0.5, 0.2)).rgb, LUM);
    s += dot(texture2D(tDiffuse, vec2(0.8, 0.2)).rgb, LUM);
    s += dot(texture2D(tDiffuse, vec2(0.2, 0.5)).rgb, LUM);
    s += dot(texture2D(tDiffuse, vec2(0.5, 0.5)).rgb, LUM);
    s += dot(texture2D(tDiffuse, vec2(0.8, 0.5)).rgb, LUM);
    s += dot(texture2D(tDiffuse, vec2(0.2, 0.8)).rgb, LUM);
    s += dot(texture2D(tDiffuse, vec2(0.5, 0.8)).rgb, LUM);
    s += dot(texture2D(tDiffuse, vec2(0.8, 0.8)).rgb, LUM);
    return s / 9.0;
}
```

Cost: 9 texture samples, zero CPU overhead. Only computed once per frame, shared across all active slots.

### Recommended reactivity defaults by group

| Group | `lumaReactivity` | `lumaBoost` |
|-------|-----------------|-------------|
| Structural (dust, grease, scratches) | 0.15–0.30 | 1.2 |
| Optical artifacts (rings, HUD) | 0.40–0.60 | 1.5 |
| Light-reactive (leaks, rainbow) | 0.75–0.95 | 2.5–3.5 |

---

## 6) Execution Order — Overlays First

The user specified: **Add blend overlays to the scene first, then apply distortion and other effects.**

### Implementation approach — screen-space locked (recommended)

The overlays are sampled using `vUv` (undistorted screen UV) and added to a base color variable. The distortion then warps the underlying scene independently. In a single-pass shader this is:

```
1. Estimate sceneLuma (9 samples from tDiffuse at fixed grid)
2. sceneColor = vec3(0)
3. For each active slot: sceneColor += overlayContribution(vUv)
4. sceneColor += texture2D(tDiffuse, distortedUV)  // scene at warped UV
5. Apply chromatic aberration on distortedUV
6. Apply vignette (using vUv, screen-space)
7. Apply grain (using vUv)
8. Output final
```

This produces **screen-locked overlays** — grease and dust stay pinned to the screen while the world beneath distorts, which is the most natural behavior for "dirt on glass." The distortion is subtle enough that the two approaches are visually indistinguishable at typical settings.

> **Note**: If overlays should distort WITH the scene (e.g. a specific preset wants this), the `LensEffectV2` can allocate an internal ping-pong RT — overlay-add pass writes to tempRT, distortion pass samples tempRT. This is optional and can be added as a `distortOverlays: bool` per-slot parameter later.

### Full internal shader stage order

```
[ scene luma estimate ]
[ overlay Add blend × 4 slots, screen UV ]
[ radial distortion on scene sample ]
[ chromatic aberration ]
[ vignette ]
[ grain ]
```

---

## 7) Subtle Animation

Two independent animation channels per slot:

**1. UV drift** — Imperceptibly slow creep. Changes which part of the 4K texture is cropped over long sessions. Default speeds: `driftX = 0.00008`, `driftY = 0.00005`.

**2. Intensity pulse** — Very low-frequency sine modulation. Creates a gentle "breathing" feel. Light-reactive textures pulse slightly faster.
- Structural: `pulseMag = 0.05`, `pulseFreq = 0.08 Hz`
- Light-reactive: `pulseMag = 0.12`, `pulseFreq = 0.18 Hz`

Each slot has an independent `pulsePhase` so slots don't all breathe in sync.

---

## 8) Preset Profiles

| Preset | Slot A | Slot B | Slot C | Slot D |
|--------|--------|--------|--------|--------|
| **Clean** | — | — | — | — |
| **Dusty** | dust_01 @20% | — | — | — |
| **Grime** | grease_03 @25% | dust_01 @15% | scratches_01 @20% | — |
| **Fingerprint** | grease_01 @35% | — | — | — |
| **Light Leak** | light_leak_01 @60% | rainbow_chroma_01 @25% | — | — |
| **Lens Ring** | lens_leak_01 @50% | lens_leak_02 @30% | — | — |
| **Cinematic Grime** | grease_02 @30% | scratches_01 @25% | light_leak_01 @40% | rainbow_chroma_02 @20% |
| **Surveillance** | lens_overlay_01 @90% | dust_01 @10% | — | — |
| **Vintage** | grease_01 @20% | lens_leak_01 @40% | rainbow_chroma_02 @30% | — |
| **Horror** | grease_02 @40% | scratches_01 @35% | lens_leak_02 @20% | — |

---

## 9) Aspect-Safe UV Fitting (Cover Mode)

All 12 textures use the same **cover-fit** UV transform to avoid stretching on any screen ratio:

```javascript
function computeCoverScaleOffset(texW, texH, screenW, screenH) {
    const texAspect = texW / texH;
    const screenAspect = screenW / screenH;
    if (screenAspect > texAspect) {
        // Fit to width, crop top/bottom
        const scaleY = texAspect / screenAspect;
        return { scaleX: 1, scaleY, offsetX: 0, offsetY: (1 - scaleY) * 0.5 };
    } else {
        // Fit to height, crop left/right
        const scaleX = screenAspect / texAspect;
        return { scaleX, scaleY: 1, offsetX: (1 - scaleX) * 0.5, offsetY: 0 };
    }
}
```

Uniforms passed as `vec4(scaleX, scaleY, offsetX, offsetY)` per slot (the existing `uXScaleOffset` pattern in the current scaffold).

---

## 10) Texture Loading Strategy

Load textures **on demand** — only load textures referenced by at least one active slot. Textures are cached by path in `LensEffectV2` and disposed when no slot references them.

The 12-texture catalog is defined as a static array in `LensEffectV2.js`:

```javascript
static TEXTURE_CATALOG = [
    { id: 'lens_dust_01',       path: 'assets/lens assets/lens_dust_01.jpg',       group: 'structural' },
    { id: 'lens_grease_01',     path: 'assets/lens assets/lens_grease_01.jpg',      group: 'structural' },
    { id: 'lens_grease_02',     path: 'assets/lens assets/lens_grease_02.jpg',      group: 'structural' },
    { id: 'lens_grease_03',     path: 'assets/lens assets/lens_grease_03.jpg',      group: 'structural' },
    { id: 'lens_scratches_01',  path: 'assets/lens assets/lens_scratches_01.jpg',   group: 'structural' },
    { id: 'lens_leak_01',       path: 'assets/lens assets/lens_leak_01.jpg',        group: 'optical' },
    { id: 'lens_leak_02',       path: 'assets/lens assets/lens_leak_02.jpg',        group: 'optical' },
    { id: 'lens_overlay_01',    path: 'assets/lens assets/lens_overlay_01.jpg',     group: 'optical' },
    { id: 'light_leak_01',      path: 'assets/lens assets/light_leak_01.jpg',       group: 'reactive' },
    { id: 'light_leak_02',      path: 'assets/lens assets/light_leak_02.jpg',       group: 'reactive' },
    { id: 'rainbow_chroma_01',  path: 'assets/lens assets/rainbow_chroma_01.jpg',   group: 'reactive' },
    { id: 'rainbow_chroma_02',  path: 'assets/lens assets/rainbow_chroma_02.jpg',   group: 'reactive' },
];
```

---

## 11) What Changes vs Current Scaffold

The scaffolding wiring (`FloorCompositor`, `canvas-replacement`, `EffectComposer`) stays unchanged.

`LensEffectV2.js` and `lens-shader.js` need redesign:

| Feature | Current state | Target state |
|---------|--------------|--------------|
| Texture slots | 3 fixed (dust/grease/scratch) | 4 generic configurable slots |
| Texture catalog | Built-in fallbacks only | 12 named 4K assets |
| Blend mode | Thresholded luma-gate | Simple Add blend |
| Center clearance | None | Per-slot radial mask |
| Scene luma | Not computed | 9-sample in-shader estimate |
| Luma reactivity | Per-slot threshold | Per-slot reactivity + boost |
| Animation | None | Per-slot UV drift + intensity pulse |
| Execution order | Overlays after grain | Overlays first, then distort/CA/vignette/grain |
| Presets | None | 10 named profiles |

---

## 12) Implementation Phases

### Phase A+B — DONE (scaffolded)
- ✅ `LensEffectV2` class with lifecycle methods
- ✅ Wired into `FloorCompositor`, `canvas-replacement`, `EffectComposer`

### Phase C — Redesign core shader + slots (next)
- [ ] Redesign `lens-shader.js` to 4-slot Add blend system
- [ ] Add per-slot uniforms: `uSlotX_ScaleOffset`, `uSlotX_Params`, `uSlotX_ClearParams`, `uSlotX_AnimParams`
- [ ] Add in-shader scene luma estimation
- [ ] Fix execution order: overlays first, then distort/CA/vignette/grain
- [ ] Implement per-slot center clearance mask

### Phase D — JS slot management + catalog
- [ ] Add `TEXTURE_CATALOG` static array to `LensEffectV2`
- [ ] Implement on-demand texture loading keyed by catalog index
- [ ] Implement per-slot `params` objects in JS
- [ ] Push slot params to shader uniforms in `update()`
- [ ] Implement `onResize` cover-fit per active texture

### Phase E — Presets + UI
- [ ] Add 10 preset profiles in `LensEffectV2`
- [ ] Add `applyPreset(name)` method
- [ ] Expose slot params in Tweakpane `getControlSchema()`
- [ ] Add per-slot texture picker (catalog index dropdown)

### Phase F — Validation
- [ ] Verify no stretch on 16:9, 21:9, 4:3, portrait
- [ ] Verify center is protected for light_leak/rainbow_chroma by default
- [ ] Verify light-reactive slots respond visually to scene brightness changes
- [ ] Verify performance at 4K textures × 4 slots

---

## 13) Parameter Defaults (Stylized-First)

- Distortion: `-0.08` barrel (subtle)
- Chromatic aberration: `1.5px` edge-weighted
- Vignette: `intensity=0.20`, `softness=0.65`
- Grain: `amount=0.030`, animated
- Default preset: **Grime** (3 structural layers, moderate intensity)

---

## 14) Additional Optional Features — Implemented

### Autofocus defocus pulse (optional)

- ✅ Added an optional, infrequent autofocus-defocus event system in `LensEffectV2`.
- ✅ Defocus events trigger after randomized intervals (`autoFocusMinIntervalSeconds` → `autoFocusMaxIntervalSeconds`).
- ✅ During an event, the pass applies a temporary blur + subtle UV shift to simulate lens element refocusing, then snaps back to full focus.
- ✅ Full control schema support:
  - `autoFocusEnabled`
  - `autoFocusMinIntervalSeconds`
  - `autoFocusMaxIntervalSeconds`
  - `autoFocusDefocusDurationSeconds`
  - `autoFocusMaxBlurPx`
  - `autoFocusMaxShiftPx`

### Light burning persistence (optional)

- ✅ Added an optional bright-region persistence system ("light burn") using an internal low-res ping-pong burn map.
- ✅ Burn map captures high-luma regions above threshold and decays over time.
- ✅ Final lens pass composites the burn map additively (with optional light blur) to create residual persistence after bright flashes.
- ✅ Full control schema support:
  - `lightBurnEnabled`
  - `lightBurnThreshold`
  - `lightBurnThresholdSoftness`
  - `lightBurnPersistenceSeconds`
  - `lightBurnResponse`
  - `lightBurnIntensity`
  - `lightBurnBlurPx`
