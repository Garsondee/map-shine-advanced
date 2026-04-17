# Water shader compile-time analysis

This document examines `water-shader.js` (fragment shader built from `getFragmentShader()` + `getFragmentShaderPart2()`, ~2.4k+ lines of GLSL in one compilation unit) and how `WaterEffectV2.js` feeds it. The goal is to identify **what most inflates driver compile time** and list **changes that improve compilation** with **minimal visible degradation**.

Compile cost is dominated by: **single-program size**, **control-flow + inlining depth**, **texture op count in inlined callees**, and **optional MRT / `#ifdef` variants** — not by moving GLSL across `.js` file boundaries (splitting strings does not split the program the driver sees).

---

## Executive summary

| Tier | Issue | Compile impact | Look-preserving mitigations |
|------|--------|----------------|-----------------------------|
| A | One monolithic fragment program | Very high | **Shader variants** (separate materials / presets), or **second pass** for optional blocks |
| A | `fbmNoise()` — 4 octaves × **16** `texture2DLodEXT` per call | Very high | Fewer octaves in `fbmNoise` behind `#ifdef`, or cheaper noise in low tier |
| A | `warpUv()` + `calculateWave()` + rain + murk + caustics all call `fbmNoise` / `valueNoise` heavily | Very high | **Compile-time** `#ifdef` to strip unused subsystems per preset |
| B | `calculateWave()` blends **two** full `calculateWaveForWind()` evaluations | High | Approximate single evaluation + small blend error, or uniform “wind mix” updated less often on CPU |
| B | Chromatic aberration block: **many** `refractTapValid` + `texture2D` taps | High | `#ifdef USE_WATER_CA` (default on); optional **separate lightweight pass** same visual |
| B | `getFoamData()` — very large always-resident body | High | `#ifdef USE_WATER_ADVANCED_FOAM` for filament/evolution/noise blocks |
| C | Fixed loops: Gerstner `WAVE_COUNT` 7 + secondary 3; `waterFbm` max 8; filament loops ×2 | Medium | Reduce `WAVE_COUNT` by 1, cap `waterFbm` at 6 (small look change) |
| C | `USE_WATER_SPEC_BLOOM_RT` (MRT + second output) | Medium–high | Separate bloom-spec **micro-shader** pass (two smaller compiles) |
| C | Huge uniform block + `DepthShaderChunks` splice | Low–medium | Fewer uniforms is minor vs FS size; depth chunk is small |

---

## 1. Architecture (why everything costs compile once)

- **Single `ShaderMaterial`** compiles **one** large fragment program (`WaterEffectV2._compileRealShaderNow` uses `getFragmentShaderSafe()` → currently **same source as** `getFragmentShader()` per file header).
- `WaterEffectV2` toggles **`USE_FOAM_FLECKS`**, **`USE_WATER_REFRACTION_MULTITAP`**, and (at runtime) **`USE_WATER_SPEC_BLOOM_RT`** via `defines` + `needsUpdate` — each change **recompiles** the whole program again.
- **Runtime** `if (uniform > 0.5)` branches still leave **all** branch bodies in the compiled program; the driver still analyzes and optimizes across them. **True** compile savings require **`#ifdef` / separate shader strings** or **separate passes**.

---

## 2. Worst offenders (ordered by typical compile stress)

### 2.1 `fbmNoise(vec2 p, …)` — texture fan-out in every octave

**Location:** `water-shader.js` (~lines 463–512)

Each octave performs **four** bilinear-style taps on `tNoiseMap` (RGBA channels staggered across octaves). Four octaves ⇒ **16 texture lookups per `fbmNoise` call** before the weighted sum.

**Call graph hotspots:**

- **`warpUv`**: six `fbmNoise` calls ⇒ up to **96** lod-texture ops in one helper (wind-aligned warp).
- **`computeRainOffsetPx`**: four `fbmNoise` calls ⇒ up to **64** ops when rain is enabled.
- **`applyMurk`**: multiple `fbmNoise` + **`curlNoise2D`** (four `fbmNoise` each) ⇒ very high op count when murk enabled.
- **`causticsPattern`**: two `waterFbm` calls (octaves 4 and 3 internally) ⇒ nested cost.

**Why it hurts compile:** drivers inline aggressively; repeated `texture2DLodEXT` grids inside nested helpers blow up the **intermediate representation** and **optimization passes** even when some paths are rarely taken at runtime.

**Low-visual-impact mitigations:**

- Add **`#ifdef USE_WATER_FBM_FULL`** vs reduced octave count (e.g. 3 octaves) for a “load / stability” preset; difference is subtle on water motion at normal scales.
- Replace one `fbmNoise` layer in **`warpUv`** with cheaper **`valueNoise2D`** (4 taps vs 16) for the smallest warp term — often visually negligible.

---

### 2.2 `calculateWave` / `calculateWaveForWind` — Gerstner stacks + wind blend

**Location:** ~689–830

- Primary stack: **`const int WAVE_COUNT = 7`** loop (sin/cos, phase, dispersion per octave).
- Secondary layer: **3** additional octaves.
- **`calculateWave`** interpolates **prev vs target wind** by evaluating **`calculateWaveForWind` twice** (`mix(a, b, s)`) whenever `uWindDirBlend` is in `(0,1)` — **double** wavefield cost in that common case.

**Low-visual-impact mitigations:**

- **`WAVE_COUNT` 7 → 6**: small reduction in high-frequency detail; often hard to notice with breakup noise on top.
- **Wind blend**: single evaluation with **mixed direction vector** (approximation) instead of two full fields — tiny directional error during wind transitions only.
- **`#ifdef USE_WATER_SECONDARY_SWELL`** to compile out the secondary 3-octave layer for a tier that keeps primary motion only.

---

### 2.3 `getFoamData` — large procedural foam (shore + floating)

**Location:** `getFragmentShaderPart2()` ~1002–1355

Very long function: many **`valueNoise` / `valueNoise2D`** samples, optional evolution, filaments (`for (int i = 0; i < 3)` ×2 for shore and floating), thickness, edge detail, lighting, shadows.

**Why it hurts compile:** massive static control-flow and math, **always present** in the fragment program even when sliders disable features at runtime.

**Low-visual-impact mitigations:**

- Split into **`#ifdef USE_WATER_SHORE_FOAM_FULL`** wrapping filament + evolution + multi-layer sections; keep a **single** shore noise + tail mask in baseline.
- **`#ifdef USE_WATER_FLOATING_FOAM`** — scenes with no floating foam could compile a variant without hundreds of lines.

---

### 2.4 Chromatic aberration — tap explosion on `tDiffuse`

**Location:** ~1791–1857 (inside `uChromaticAberrationEnabled > 0.5`)

Per pixel: multiple **`refractTapValid`** (each can sample occluder + `tWaterData` + raw mask path) and **many** `texture2D(tDiffuse, …)` for R/B Kawase-style spread.

**Low-visual-impact mitigations:**

- **`#ifdef USE_WATER_CHROMATIC`** — default **on** for quality preset; **off** for compile-fast preset (users who never use CA lose nothing).
- Or **second pass**: same look, **two smaller programs** compiled separately (often better than one giant FS).

---

### 2.5 `waterFbm` — loop `for (int i = 0; i < 8; i++)` with `break`

**Location:** ~948–961

GLSL still compiles for the **maximum** iteration count from the optimizer’s perspective in many backends; the `if (i >= octaves) break` reduces **runtime** more than **compile** unless octaves become **constant** per variant.

**Mitigation:** provide **`waterFbmMax4`** / **`waterFbmMax6`** `#ifdef` copies with **literal** loop bounds for caustics vs cheaper uses.

---

### 2.6 `USE_WATER_REFRACTION_MULTITAP` (`#ifdef USE_WATER_REFRACTION_MULTITAP`)

**Location:** ~1774–1789

Extra UV taps and blending — moderate extra code; **already** a good pattern. Ensure runtime toggles that flip this define are **rare** after load (each flip = **full recompile** of the mega-shader).

---

### 2.7 `USE_WATER_SPEC_BLOOM_RT` + `WebGLMultipleRenderTargets`

**Location:** top of FS (~70–77), `WaterEffectV2._syncBloomMrtShaderMode`

MRT changes output signature and often makes the compiler retain **both** color paths. Compile cost increases vs single `gl_FragColor`.

**Low-visual-impact mitigations:**

- **Bloom spec** into a **tiny separate pass** (copy spec mask with 50-line shader) — **two** cheaper compiles vs one giant MRT program.
- Or compile water **without** MRT first, then enable MRT only after first successful compile (staged complexity — UX care for one-frame pop).

---

### 2.8 `USE_FOAM_FLECKS` (`#ifdef USE_FOAM_FLECKS`)

**Location:** ~911–944

Moderate-size `getShaderFlecks`. Already isolated — good. Avoid toggling on/off every frame from UI debounce issues (recompile storms).

---

### 2.9 Specular (GGX + anisotropy + highlights + falloffs)

**Location:** ~1499+ and ~2121+

Heavy **math**, not thousands of texture ops, but adds **long dependency chains** on top of an already huge program.

**Low-visual-impact mitigations:**

- **`#ifdef USE_WATER_SPEC_HIGHLIGHTS`** for the second highlight block if it can be merged or optional.
- Keep GGX; avoid duplicating **similar** NDF code paths — merge if any copy-paste exists (reduces IR size).

---

### 2.10 `refractTapValid` / `waterOccluderAlphaSoft`

**Location:** ~1435–1474

`refractTapValid` is called **many times** from the chromatic block; each call pulls occluder + water mask logic. This **multiplies** work in the IR even when CA is off (callsites still exist unless `#ifdef`).

**Mitigation:** guard the **CA-only** `refractTapValid` fan-out with **`#ifdef USE_WATER_CHROMATIC`** so non-CA builds use a simpler valid test for the single refraction tap only.

---

## 3. `WaterEffectV2.js` — operational compile risks (not GLSL size)

- **`_syncBloomMrtShaderMode`** and **`_applyParamsToUniforms` / defines** toggling `needsUpdate: true` forces **full recompile** of the same large FS.
- **Deferred compile** (`_compileRealShaderNow`) is correct for **load**, but the **first** compile is still one big spike — consider **staged defines** (compile minimal variant first, then upgrade).

These do not replace reducing GLSL size; they **avoid repeat** compiles.

---

## 4. Recommended strategy (preserve look, improve compile)

1. **Named presets (material variants), not one shader with every `#ifdef` combo**  
   Example presets: `Water_Core` (waves + tint + refraction + specular + basic foam), `Water_Core+CA`, `Water_Full` (+ advanced foam + murk extras). Same **visual** defaults map to `Water_Full`; users pick lower only if needed.

2. **Keep “safe” as a smaller program, not only shorter timeout**  
   Today `getFragmentShaderSafe()` equals `getFragmentShader()`. A real **reduced-linecount** variant (fewer `#ifdef` sections removed from **source**) is what improves compile.

3. **Second pass for chromatic and/or bloom spec**  
   Same pixels, two compiles of **smaller** programs — often faster **and** more stable than one monolith.

4. **Reduce `fbmNoise` octaves or calls in `warpUv` first**  
   Highest ROI per pixel of “look” — warp is subtle compared to shoreline read.

5. **Wind blend double evaluation**  
   Worth a **small** approximation to halve wave math in the blended case.

---

## 5. What *not* to rely on

- **Splitting `getFragmentShaderPart2()` in JS only** — already done for maintainability; **does not** split GPU compilation.
- **Comments / whitespace** — stripped early; negligible.
- **“We’ll use shorter variable names”** — negligible.

---

## 6. File reference map

| Artifact | Role |
|----------|------|
| `water-shader.js` `getFragmentShader()` + `getFragmentShaderPart2()` | Entire FS source concatenation |
| `water-shader.js` `fbmNoise`, `warpUv`, `calculateWaveForWind`, `getFoamData`, `applyMurk`, CA block | Largest compile contributors |
| `DepthShaderChunks` splice | Depth linearize helpers (~tens of lines) |
| `WaterEffectV2.js` `defines`, `_syncBloomMrtShaderMode` | Triggers recompile on toggle |

---

*Generated for Map Shine Advanced compositor V2 water path.*
