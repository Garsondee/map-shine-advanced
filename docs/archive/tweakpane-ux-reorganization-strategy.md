# Tweakpane UX Reorganization Strategy

**Goal:** Reduce parameter fatigue across the main Map Shine config panel **without removing a single control** — through strict hierarchy, consistent nomenclature, and smarter folders.

**Baseline inventory:** [tweakpane-main-config-controls-report.md](./tweakpane-main-config-controls-report.md) (full control list by section, generated from `getControlSchema()` sources).

**Regenerate inventory:** `node scripts/tools/audit-tweakpane-controls.mjs`

---

## Principles

| Principle                          | Rule                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero parameter loss**            | Reorganize labels and folders only; every `paramId` and persistence key stays stable unless explicitly migrated with a scene-flag bridge.          |
| **Progressive disclosure**         | Default view = artist-facing folders. Power-user / sim / RT controls live in nested **Advanced** folders, not scattered `advanced: true` bindings. |
| **Folder context strips prefixes** | Inside `Flame Texture`, use **Opacity** not **Flame Texture Opacity**.                                                                             |
| **One vocabulary**                 | Pick global terms (see Part 1) and apply across all effects.                                                                                       |
| **GM vs dev separation**           | GM transition / bounds / strike triggers near the top of weather & atmosphere; Hz, RT scale, stride scans in Advanced / Developer.                 |

---

## Part 1: Global UI & UX Standards

Apply these **before** effect-specific moves. They improve parseability across the entire panel.

### 1.1 Strip redundant prefixes in folders

If a folder is named **Flame Texture**, parameters inside should be:

- **Opacity**, **Brightness**, **Scale X** — not `Flame Texture Opacity`, etc.

**Implementation:** Change `label` in `getControlSchema()` only. Keep `paramId` unchanged for scene flags and presets.

### 1.2 Standardize unit suffixes

Use consistent suffixes in labels:

| Unit               | Suffix           | Examples                                     |
| ------------------ | ---------------- | -------------------------------------------- |
| Pixels             | `(px)`           | Pool Radius (px), Edge inflate (px)          |
| Seconds            | `(s)`            | Life Min (s), Warm-up (s)                    |
| Milliseconds       | `(ms)`           | Hide Delay (ms)                              |
| Degrees            | `(deg)`          | Heading (deg), Angle (deg)                   |
| Grid / world units | `(u)`            | Length (u), Beam length (u)                  |
| Normalized 0–1     | _(none or "01")_ | Intensity, Strength when already 0–1 sliders |

Avoid mixing **Min Interval (s)** with **Fade in (ms)** in the same sibling group without reason — prefer one time unit per folder.

### 1.3 Standardize terminology

| Concept               | **Pick one**                                           | Notes                                                                               |
| --------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Strength vs intensity | **Intensity** (recommended)                            | e.g. unify "Micro-Chop Intensity" and "Wave Strength" → Intensity in folder context |
| Opacity vs alpha      | **Opacity**                                            | Artist-facing                                                                       |
| Color vs tint         | **Color** = replacement; **Tint** = multiplier / grade | Camera Grade uses Tint correctly                                                    |
| Scale vs size         | **Scale** = multiplier; **Size** = absolute            | Size Min/Max (px), UV Scale                                                         |

Document the chosen glossary in `Docs/` and enforce in schema `label` strings.

### 1.4 Prefer Advanced **folders** over Advanced **tags**

**Today:** `TweakpaneManager` hides individual bindings marked `advanced: true` when Advanced Mode is off.

**Target:** Nest expert parameters in a folder titled **Advanced** (or **Simulation**, **Developer**) with `advanced: true` on the **folder**, not on 15 sibling sliders.

**Benefits:**

- Non-advanced view shows 4–6 top-level folders per effect, not 4 folders + 15 greyed hidden rows.
- Advanced Mode reveals whole subtrees at once.

**Migration pattern:**

```js
// Before: many parameters with advanced: true in a standard folder
// After:
{ name: 'waves-core', label: 'Waves', type: 'folder', parameters: ['waveScale', 'waveStrength', 'waveSpeed'] },
{ name: 'waves-advanced', label: 'Breakup & micro-chop', type: 'folder', advanced: true, parameters: [...] },
```

### 1.5 Toggle nomenclature

Avoid **folder title + Enabled** reading as redundant ("Glass Refraction: Enabled").

| Pattern               | Example                                                              |
| --------------------- | -------------------------------------------------------------------- |
| Folder + short toggle | Folder: **Glass Refraction** → toggle label: **On**                  |
| Descriptive toggle    | **Enable glass refraction** (no separate folder title duplication)   |
| Master enable         | Keep effect-level **Enabled** under standard chrome (already global) |

For sub-features (`smokeEnabled`, `coalBedEnabled`), prefer **Enable smoke** inside the **Smoke** folder.

---

## Part 2: Top-Level & Chrome Reorganization

### 2.1 Problem

**Quick Actions** mixes scene defaults, GM propagation, diagnostics, movement tools, and danger actions in one flat grid.

### 2.2 Proposed top-level sections

Reorganize `buildQuickActionsSection()` in `scripts/ui/tweakpane-manager.js` into **three visual groups** (same buttons — no removals):

#### Scene Management

- Defaults, Undo Defaults
- Texture Manager, Effect Stack
- Apply to All Scenes… _(GM)_
- Scene Recovery, Scene Reset

#### Camera & Movement

- Streaming Minimap, Tile Streaming Report
- Token Movement, Tile Motion
- Camera Path _(GM)_
- Map Points _(GM)_, Levels Authoring _(GM)_

#### Developer & Diagnostics _(advanced group — entire block hidden until Advanced Mode)_

- Diagnostic Center, Pixel Probe, Breaker Box, Performance Recorder
- Copy From Scene _(GM)_, Reset Effects… _(GM)_

**Note:** Tile Streaming Report stays visible in Camera & Movement (not advanced) — it is user-facing diagnostics, not dev-only.

### 2.3 Unchanged chrome

Keep as-is unless renamed for consistency:

- Universal toolbar: scene status, filter, Advanced Mode
- Presets bar
- Panel Appearance, Intros, Support & Links
- Category folders: Gameplay, Lighting, Atmosphere, Surface, Particles, Camera & Post, Developer Tools

---

## Part 3: Deep-Dive — "Monster" Effects

### 3.1 Player Light (`player-light`)

**Problem:** Night Vision has 30+ controls; Torch and Flashlight share structure but feel disconnected.

**Current state:** Already partially grouped (`Torch: Behavior`, `Flashlight: Beam`, many `Night Vision:` folders) in `PlayerLightEffectV2.getControlSchema()`.

**Target hierarchy:**

```
🔦 Flashlight
  Beam — Intensity, Angle (deg), Length (u), …
  Advanced/
    Dynamic Light
    Cookie / Gobo — Intensity mult, Size (px), Mask softness, Perspective, …

🔥 Torch
  Behavior — Base intensity, Color, Flicker amount, …
  Advanced/
    Dynamic Light
    Sparks & Flame VFX

🟢 Night Vision
  Core setup — Eyepiece style, Tint, Tint strength, Saturation, Brightness
  Advanced/
    Light amplification — Gain, Black level, Peak luma, Shadow lift curve
    Sensor noise — Noise amount, Low-light boost, Scanlines, Scanline speed, Phosphor flicker
    Optics & bloom — Bloom, Bloom threshold, Distort, Chromatic aberration
    Simulation — Warm-up (s), Shutdown (s), Auto-dim gate
```

**Work:** Merge/rename existing Night Vision folders; strip `Flashlight:` / `Torch:` prefixes inside child folders; move sim/noise/bloom clusters under **Advanced**.

---

### 3.2 Water (`water`)

**Problem:** Depth, waves, specular, caustics, foam, murk interleave — highest cognitive load in the panel.

**Current state:** Many folders already (`Core`, `Waves`, `Wind Coupling`, `Micro-Chop`, shore/floating foam groups, etc.) — see `WaterEffectV2.getControlSchema()`.

**Target hierarchy:**

```
💧 Water appearance & depth
  Core — Tint color, Tint strength, Distortion (px)
  Bathymetry (volumetric) — Max depth, Absorption, Deep scatter, Strength

🌊 Waves & wind
  Core waves — Wave scale, Wave intensity, Speed
  Wind coupling — Override scene wind, Lock travel to wind, Heading (deg)
  Advanced/
    Breakup & micro-chop — (strip water/wave prefixes in labels)

✨ Surface lighting (specular & bloom)
  Specular core — Spec model, Spec intensity, Roughness min/max, F0
  Highlights & bloom — Intensity, Sharpness, Bloom emit
  Environment reflections — Cloud reflection, Cloud shadow modulation

🫧 Foam & detail (advanced)
  Shoreline foam/ — Strength, Coverage, Color, Speed, Filaments (strip shoreFoam*)
  Floating foam/ — Strength, Coverage, Shadows, Edge detail (strip floatingFoam*)

🌫️ Murk & refraction (advanced)
  Refraction — Multi-tap, Edge center, Shore remap
  Murk visibility — Intensity, Depth low/high, Density contrast
  Caustics — Intensity, Scale, Speed, Brightness threshold
```

**Work:** Reorder existing groups; relabel only; map current folders → target tree in a migration table before editing.

---

### 3.3 Fire & particles (`fire-sparks`, `candle-flames`, ash variants)

**Problem:** Prefix noise (`fireGlow`, `coalBed`, `smoke`); Fire vs Candle vs Coal Bed structured differently.

**Target — Main Fire System:**

```
Flames — Intensity, Height, Temperature, Updraft
  Advanced/ — Mask brightness floor, spin, flipbook, …

Embers & smoke — Enable smoke, Density, Peak opacity, Ember rate, Updraft
  Advanced/ — Life/size limits grouped

Coal bed — Enable, Intensity, Opacity
  Advanced/ Coal appearance — Char color, Flare hot color, Smolder angle (strip coalBed* labels)

Fire glow (light emission) — Enable, Day/night auto-balance
  Outdoor/indoor balance/
    Day pool — (strip fireGlow* prefix in labels)
    Night pool —
```

**Candle Flames:** Align folder names with Fire where parameters are parallel; keep separate `effectId` and mask status row.

---

### 3.4 Camera & Post

#### Camera Grade (`colorCorrection`)

```
Exposure & color — Exposure, Temperature, Tint, Contrast, Brightness, Saturation
Outdoor atmosphere — Enable, Strength, Sunrise/sunset hour, Golden strength
Advanced/
  HDR tone mapping — Lift, Gamma, Gain
```

Consolidate empty **Env —** / **Mod —** headings in **Contextual Scene Grade** (see §4.1).

#### Lens (`lens`)

**Problem:** Repetitive `viewfinderIntensity`, `structuralIntensity`, etc.

```
Autofocus & motion — Motion blur, Zoom blur, Defocus pulses
Overlays/
  Viewfinder — Texture, Intensity, Luma reactivity, Drift
  Dust & scratches — …
  Leaks & chroma — …
Optical distortions — Distortion amount, Vignette, Chromatic edge power, Digital noise
```

#### Stylized post-processing (new master grouping)

**Effects:** Sharpen, Dot Screen, Halftone, ASCII Art, Dazzle Overlay, Color Invert, Sepia Tone.

**Problem:** Six niche stylistic effects dominate the **Camera & Post** root.

**Options (no param loss):**

| Approach                                | Pros                                                                                                                                       | Cons                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **A. Category subfolder**               | Register a Tweakpane folder **Stylized Filters** under `post`; move effect folders inside via `registerEffectUnderEffect` or display order | Still six expands                                  |
| **B. Single selector + dynamic schema** | One folder; dropdown picks active stylistic effect; show that effect's schema                                                              | Large refactor; persistence per effect must remain |
| **C. Collapsed default**                | Keep six folders; default `expanded: false`; add category separator label                                                                  | Least engineering risk                             |

**Recommendation:** Start with **C**, then **A** if still too noisy. Avoid **B** until stylistic persistence rules are fully mapped (`isStylisticEffectId` gate in `canvas-replacement.js`).

---

## Part 4: Specific Groupings & Cleanups

### 4.1 Contextual Scene Grade (`contextualSceneGrade`)

**Problem:** Many flat headings (`Env — Overcast`, `Mod — Canopy`, …).

**Target:**

| Folder                          | Contents                             |
| ------------------------------- | ------------------------------------ |
| **Engine logic**                | Probes, fades, adaptations           |
| **Environmental thresholds**    | Storm, overcast, night, day logic    |
| **Token modifiers**             | Canopy, window-lit, building shadows |
| **Base packs (indoor/outdoor)** | Tight grid or readonly JSON blocks   |

Keep live diagnostics button under standard chrome.

### 4.2 Shadows (Lighting & Shadows)

**Problem:** Four shadow types (Overhead, Building, Sky Reach, Painted) with nearly identical parameter sets — users open four menus for one artistic pass.

**Target:** **Shadow caster systems** — one panel, four enable toggles, shared Length/Softness/Smear when unified, or per-caster subtabs.

| Approach             | Engineering impact                                                    |
| -------------------- | --------------------------------------------------------------------- | ------------------------------ |
| **UI-only wrapper**  | New Tweakpane section that embeds/links to four `effectId`s; no merge | Low                            |
| **Facade effect**    | Single `shadow-casters` schema proxies to four compositor instances   | Medium — persistence migration |
| **Compositor merge** | One `ShadowCasterEffectV2`                                            | High — rendering coupling      |

**Recommendation:** **UI-only wrapper** first (Part 4.2 phase 2). Do **not** merge compositor effects without explicit rendering sign-off.

**Constraint:** Each shadow type has its own mask status row (`_Overhead`, building mask, etc.) — wrapper must preserve per-type texture rows.

### 4.3 Weather & atmosphere

| Current                          | Proposed display name                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| Weather                          | **Precipitation & global weather**                                     |
| Lightning                        | **Overhead lightning bolts** (or similar — local strikes)              |
| Landscape Lightning              | **Atmospheric flash lighting** (landscape / storm sync)                |
| Atmospheric Fog                  | Keep; add sub-area **Cloud systems**                                   |
| Ash Ground Clouds, Sprite Clouds | Under **Cloud systems** heading or inside Fog & Air as sibling folders |

**Wind** stays separate (scene-wide field — correct).

**Cross-category groups:** Weather rain/snow particle tuning already renders under **Particles & VFX** via `categoryId` — document in UI help text so users know where to find it.

### 4.4 Vegetation — Bush & Tree

**Problem:** Parallel parameters (wave mix, gust, sway, flutter, colors, shadows).

| Approach                  | Notes                                                             |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| **Unified Foliage panel** | Dropdown: Target = Bush / Tree / Both; single schema with routing | Requires dual callback or shared param namespace |
| **Mirrored layout**       | Keep two `effectId`s; enforce 1:1 folder order and labels         | Low risk — **recommended first**                 |

---

## Part 5: Implementation Roadmap

Phased delivery — each phase shippable without losing parameters.

### Phase 0 — Standards doc & audit (done)

- [x] Full control inventory report
- [x] This strategy document
- [ ] Agree global glossary (Intensity vs Strength, etc.)

### Phase 1 — Low-risk global chrome (1–2 sessions)

- [ ] Reorder Quick Actions into three groups (`buildQuickActionsSection`)
- [ ] Glossary pass on **unit suffixes** only (labels, not ids)
- [ ] Audit Advanced Mode: move top offenders from per-binding `advanced: true` to nested folders (start with Water wind coupling, Fire performance)

### Phase 2 — Label & folder cleanup per effect (ongoing)

Priority order by control count / user traffic:

1. Water — reorder folders to Part 3.2 tree; strip prefixes
2. Player Light — consolidate Night Vision under Advanced
3. Fire — prefix strip; glow day/night pool folders
4. Lens — overlay subfolders
5. Camera Grade + Contextual Scene Grade — collapse empty headings

**Per-effect checklist:**

- [ ] Update `groups` + `label` in `getControlSchema()`
- [ ] Run `audit-tweakpane-controls.mjs` — param count unchanged
- [ ] Verify presets still map to `paramId`s
- [ ] Verify mask-status rows still under **Enabled**
- [ ] User test in non-Advanced and Advanced Mode

### Phase 3 — Structural UI (medium risk)

- [ ] Stylized post **Stylized filters** subfolder (option A/C)
- [ ] Shadow caster **wrapper** section (four toggles, one scroll)
- [ ] Weather display renames + Cloud systems grouping
- [ ] Bush/Tree mirrored layout audit

### Phase 4 — Optional consolidations (high risk — needs design approval)

- [ ] Foliage unified panel (dropdown target)
- [ ] Shadow compositor facade / merge
- [ ] Stylistic single-selector panel

---

## Technical Constraints (do not break)

| Constraint                  | Source                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **paramId stability**       | Scene flags, world-based storage, presets, `applyCurrentEffectsToAllScenes`                                     |
| **Mask status rows**        | `createMaskStatusSchemaGroup(s)` under **Enabled** — see `Docs/tweakpane-texture-status-instruction-concise.md` |
| **World Based**             | Only `lighting` and `colorCorrection` today — renaming display titles is fine                                   |
| **Stylistic effects**       | ASCII, dot, halftone, etc. — special enabled/scene-flag gate; don't batch-enable blindly                        |
| **GM-only params**          | `gmOnly: true` — keep on bounds/transition controls                                                             |
| **Weather external groups** | `categoryId: 'particle'` — rain/snow folders live under Particles category                                      |
| **module.json version**     | Bump only after user confirms a phase works                                                                     |

---

## Success Metrics

- Time-to-first-tweak: new user finds **Water → Waves → Wave scale** in &lt; 10 seconds without Advanced Mode
- Advanced Mode toggle reveals ≤ 2× more visible rows, not 5× scattered bindings
- Zero regression in saved scene presets after label-only passes
- Audit script reports same param count per `effectId` before/after each phase

---

## Related Files

| File                                         | Role                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `scripts/ui/tweakpane-manager.js`            | Quick Actions, tokens, sun/shadows, post integrations, `registerEffect`, Advanced Mode |
| `scripts/ui/effect-categories.js`            | Category order and titles                                                              |
| `scripts/foundry/canvas-replacement.js`      | Effect registration order and categories                                               |
| `scripts/compositor-v2/effects/*EffectV2.js` | Per-effect `getControlSchema()`                                                        |
| `scripts/tools/audit-tweakpane-controls.mjs` | Regenerate inventory after changes                                                     |

---

_Last updated: 2026-06-24_
