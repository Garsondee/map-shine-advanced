# Foundry VTT v14 — Core Lighting Systems Audit

**Purpose:** A full read-through of Foundry v14's lighting code, written so we can rebuild it in Three.js and match _brightness, radius, shape, falloff, colour, darkness, and animation_ as closely as possible — then go further.

**Source of record:** `foundryvttsourcecode_v14/resources/app/` (vendored). Every claim below is grepped from that tree; file paths are given so you can re-open the exact code. No guessing.

**Audience note:** This translates the GLSL/PIXI jargon into Hypershade-ish terms where it helps, but keeps the real formulas intact so nothing is lost in the port.

---

## 0. The one-paragraph mental model

A Foundry light is **not** a single glowing sprite. It is up to **four separate meshes**, each running its own fragment shader, each blended into its **own full-screen render texture**, and those textures are then composited over the map with **different blend modes**. The split is deliberate and it is the answer to "how are lights bright _and_ colourful": one channel (**illumination**) carries **luminance** and _multiplies_ the map; a different channel (**coloration**) carries the **hue** and _adds_ to the map. Brightness and colour never fight for the same number. A fifth idea — **darkness sources** — is the same machinery with the sign flipped. "Global illumination" (the sun) is just a light the size of the scene whose visibility is gated by a per-pixel **darkness-level field** that regions can paint into — exactly like the dark parts of an `_Outdoors` mask.

---

## 1. Authored data — what a light actually stores

**File:** `common/data/data.mjs` → `class LightData` (line 42). This is the schema on every `AmbientLight` and on token light. Everything downstream is derived from these.

| Field                   | Type / range    | Default | Meaning                                                          |
| ----------------------- | --------------- | ------- | ---------------------------------------------------------------- |
| `negative`              | bool            | false   | **Darkness source** instead of light (sign flip)                 |
| `priority`              | int ≥ 0         | 0       | Who wins when light meets darkness (see §11)                     |
| `alpha`                 | 0–1             | **0.5** | Light "opacity" → drives `colorationAlpha` and `backgroundAlpha` |
| `angle`                 | 0–360°          | 360     | Cone aperture (beam)                                             |
| `bright`                | ≥ 0, grid units | 0       | **Bright radius** (in scene distance units, e.g. feet)           |
| `dim`                   | ≥ 0, grid units | 0       | **Dim radius** (scene distance units)                            |
| `color`                 | hex / null      | null    | Tint. `null` ⇒ colourless (white-ish) light                      |
| `coloration`            | int             | **1**   | Coloration **technique** id (0–10, 100, 101 — see §6)            |
| `attenuation`           | 0–1             | **0.5** | Falloff strength (edge softness)                                 |
| `luminosity`            | 0–1             | **0.5** | Brightness/exposure. 0.5 = neutral                               |
| `saturation`            | −1–1            | 0       | Saturation push on the map under the light                       |
| `contrast`              | −1–1            | 0       | Contrast push on the map under the light                         |
| `shadows`               | 0–1             | 0       | Fake self-shadowing from map luminance                           |
| `animation.type`        | string / null   | null    | Which animation (`torch`, `flame`, …)                            |
| `animation.speed`       | int 0–10        | 5       | Animation speed                                                  |
| `animation.intensity`   | int 1–10        | 5       | Animation intensity                                              |
| `animation.reverse`     | bool            | false   | Reverse direction                                                |
| `darkness.min` / `.max` | 0–1             | 0 / 1   | Darkness-level window in which this light is **active**          |

Key point for the port: **`dim` and `bright` are in grid/scene distance units, not pixels.** They become pixels only at the placeable:

```
dimRadius   = config.dim   * canvas.dimensions.distancePixels
brightRadius= config.bright * canvas.dimensions.distancePixels
```

(`client/canvas/placeables/light.mjs:109-121`). `distancePixels` = pixels-per-distance-unit = `gridSize / gridDistance`. So `dim: 30` on a 5 ft / 100 px grid ⇒ `30 × (100/5) = 600 px`.

---

## 2. Source pipeline — from document to GPU

The class tower (all under `client/canvas/sources/`):

```
BaseEffectSource                     base-effect-source.mjs   (data, shape, add/remove, testPoint)
  └ RenderedEffectSource             rendered-effect-source.mjs (layers, meshes, shaders, animate)
      └ BaseLightSource              base-light-source.mjs      (light math, uniforms, animations)
          ├ PointLightSource         point-light-source.mjs     (+ PointEffectSourceMixin)
          ├ PointDarknessSource      point-darkness-source.mjs  (negative light)
          └ GlobalLightSource        global-light-source.mjs    (the sun)
```

`PointEffectSourceMixin` (`point-effect-source.mjs`) adds the **geometry**: radius, `angle`, `rotation`, wall-constraint, and edge creation.

**Shape is baked into geometry, not the shader.** `_createShapes()` builds a `PointSourcePolygon` (a ClockwiseSweepPolygon) from `{radius, angle, rotation, walls}` using `CONFIG.Canvas.polygonBackends[sourceType]`. That polygon is triangulated by `PolygonMesher` into a mesh whose vertices are **normalized to [-1,1]** and then the mesh is **scaled by `radius`** at draw time (`_updateGeometry` + `_drawMesh`, `point-effect-source.mjs:166-190`). Consequences for the shader:

- **Walls / cone shape** = the physical triangle mesh. Light simply doesn't exist outside the swept polygon. (In Three.js: either a stencil/clip from the vision polygon, or sample a mask.)
- Inside the mesh, `vUvs` runs 0→1 across the radius box, and the shaders compute a **normalized radial distance**:
  ```glsl
  float dist = distance(vUvs, vec2(0.5)) * 2.0;   // 0 at center, 1 at radius edge
  ```
  Every falloff/animation is expressed in this normalized `dist`. This is the number to reproduce.

**Radius, and the dim:bright ratio.** `radius = max(dim, bright)` (`point-light-source.mjs:44`), and:

```
ratio = clamp(|bright| / radius, 0, 1)   // point-light-source.mjs:60
```

`ratio` is the fraction of the radius that is "bright". It is the pivot for the bright→dim transition (§5).

---

## 3. The four channels & how they composite

Each light source declares its **layers** and each layer's **per-mesh blend mode** (`base-light-source.mjs:68-83`):

| Channel          | Default shader               | Per-mesh blend | Routed into           | Layer-level blend onto scene |
| ---------------- | ---------------------------- | -------------- | --------------------- | ---------------------------- |
| **background**   | `AdaptiveBackgroundShader`   | `MAX_COLOR`    | `background.lighting` | `NORMAL` (masking filter)    |
| **coloration**   | `AdaptiveColorationShader`   | `SCREEN`       | `coloration`          | **`ADD`**                    |
| **illumination** | `AdaptiveIlluminationShader` | `MAX_COLOR`    | `illumination.lights` | **`MULTIPLY`**               |
| **darkness\***   | `AdaptiveDarknessShader`     | `MAX_COLOR`    | `darkness`            | `NORMAL` (void filter)       |

\* darkness channel exists only on `PointDarknessSource` (`point-darkness-source.mjs:33-40`).

Routing happens in `groups/effects.mjs:303-310` (`#addLightEffect`): every active source calls `drawMeshes()` and its per-channel mesh is added to the matching container. Vision sources feed the same background/illumination/coloration containers (`#addVisionEffect`, line 285).

Layer-level blends & masks live in `layers/effects/*`:

- `illumination-effects.mjs:123` — the whole illumination texture is applied with **`MULTIPLY`**.
- `coloration-effects.mjs:47` — coloration applied with **`ADD`**.
- `background-effects.mjs:60` — background applied `NORMAL` via the masking filter.

`MAX_COLOR` (a custom PIXI blend, used per-mesh in illumination/background/darkness/vision) means **overlapping lights take the brighter value per channel, they don't sum to white.** Two dim torches overlapping stay two dim torches. `SCREEN` on coloration does the same softly for hue.

### The illumination render texture (this is the crux of "brightness")

The illumination container is pre-filled with a **baseline** before any light draws (`illumination-effects.mjs:63-83`). The baseline mesh runs `BaselineIlluminationSamplerShader` (`rendering/shaders/samplers/baseline-illumination.mjs`):

```glsl
float illuminationRed = texture2D(sampler, vUvs).r;              // the darkness-level field
vec3 finalColor = mix(ambientDaylight, ambientDarkness, illuminationRed);
gl_FragColor = vec4(finalColor, 1.0) * tintAlpha;
```

So the illumination texture **starts** as the ambient floor: bright daylight where darkness-level is 0, dark where it's 1. Then each light's illumination mesh `MAX_COLOR`s its own (brighter) luminance on top. Finally that whole texture **multiplies** the map. That is why an unlit map goes dark and a lit patch shows the map at full brightness: it's a multiply against a luminance field.

> The `sampler` for both the baseline and the shaders' `darknessLevelTexture` is `canvas.effects.illumination.renderTexture`, which is the **`DarknessLevelContainer`** (RED-channel-only, `illumination-effects.mjs:169-193`). This is the per-pixel darkness field that regions paint into (§11).

---

## 4. The shader family (assembly)

**Files:** `client/canvas/rendering/shaders/lighting/`

```
AbstractBaseShader (base-shader.mjs) + BaseShaderMixin (mixins/base-shader-mixin.mjs)  ← GLSL toolkit
  └ AdaptiveLightingShader (base-lighting.mjs)      ← shared fragments, techniques, illumination math
      ├ AdaptiveBackgroundShader   (background-lighting.mjs)
      ├ AdaptiveIlluminationShader (illumination-lighting.mjs)
      ├ AdaptiveColorationShader   (coloration-lighting.mjs)
      └ AdaptiveDarknessShader     (darkness-lighting.mjs)
          └ …25 light + 4 darkness animation subclasses (lighting/effects/*.mjs)
```

Shaders are assembled by **string concatenation** of static GLSL blocks. The important shared blocks in `base-lighting.mjs`:

- `FRAGMENT_BEGIN` — runs `COMPUTE_ILLUMINATION`, computes `dist`, samples the depth texture for occlusion, samples the primary (map) texture. Every channel starts here.
- `COMPUTE_ILLUMINATION` — derives the ambient colours (below).
- `SWITCH_COLOR`, `TRANSITION`, `FALLOFF`, `EXPOSURE`, `CONTRAST`, `SATURATION`, `SHADOW` — the reusable operators.
- `SHADER_TECHNIQUES` — the 13 coloration techniques (§6).

The toolkit in `base-shader-mixin.mjs` (reuse these verbatim in Three.js — they're standard GLSL): `PERCEIVED_BRIGHTNESS` (BT.709 luminance, `sqrt(dot(BT709, c*c))`), `SIMPLEX_3D`, `NOISE`, `FBM`/`FBMHQ`, `VORONOI`, `HSB2RGB`, `WAVE`, `ROTATION`, `PIE`, several `PRNG`s, and sRGB⇄linear helpers.

---

## 5. Brightness — the illumination channel in full

### 5a. Ambient colour derivation (CPU and GPU agree)

Both the environment group (CPU, `groups/environment.mjs:213-241`) and `COMPUTE_ILLUMINATION` (GPU, `base-lighting.mjs:357-386`) compute the same ladder from three scene colours + the darkness level + four weights.

Scene inputs (`groups/environment.mjs`):

- `ambientDaylight` (default `#EEEEEE`), `ambientDarkness` (`#242448`), `ambientBrightest` (`#FFFFFF`) — configurable per scene/`CONFIG.Canvas`.
- `darknessLevel` ∈ [0,1] — the scene's global darkness (night dial).
- `weights = { dark:0, halfdark:0.5, dim:0.25, bright:1 }` (`CONFIG.Canvas.lightLevels`, line 165).

The GPU version (per pixel, so it can read the region-painted darkness field):

```glsl
computedDarknessLevel  = texture2D(darknessLevelTexture, vSamplerUvs).r;   // per-pixel!
computedBackgroundColor= mix(ambientDaylight, ambientDarkness, computedDarknessLevel);
computedBrightColor    = mix(computedBackgroundColor, ambientBrightest, weightBright);  // weightBright=1 ⇒ ≈ambientBrightest
computedDimColor       = mix(computedBackgroundColor, computedBrightColor, weightDim);  // weightDim=0.25
// then remap through the active vision mode's lighting levels (getCorrectedColor)
computedDimColor   = max(computedDimColor,   computedBackgroundColor);
computedBrightColor= max(computedBrightColor,computedBackgroundColor);
```

**The critical fact:** the illumination channel's colour is built from the **scene's ambient palette**, _not_ from the light's own `color`. A white torch and a red torch produce the **same** illumination (luminance); their difference lives entirely in the coloration channel. That decoupling is what lets a light be fully bright and fully coloured at once.

### 5b. Lighting levels (dim / bright / darkest)

`LIGHTING_LEVELS` (`common/constants.mjs:302`): `DARKNESS:-2, HALFDARK:-1, UNLIT:0, DIM:1, BRIGHT:2, BRIGHTEST:3`. A vision mode can remap what "dim" and "bright" resolve to via `getCorrectedLevel`/`getCorrectedColor` (`rendered-effect-source.mjs:561-591`) and the `dimLevelCorrection`/`brightLevelCorrection` uniforms. Light uses DIM/BRIGHT; darkness uses HALFDARK/DARKNESS (`base-light-source.mjs:49-56`, `point-darkness-source.mjs:22-25`).

### 5c. Bright→dim transition (this is the dim/bright _radius_ render)

`illumination-lighting.mjs:63` assembles: `FRAGMENT_BEGIN → TRANSITION → …ADJUSTMENTS → FALLOFF → FRAGMENT_END`.

```glsl
// TRANSITION (base-lighting.mjs:342)
finalColor = switchColor(computedBrightColor, computedDimColor, dist);

// SWITCH_COLOR (base-lighting.mjs:314)
vec3 switchColor(in vec3 innerColor, in vec3 outerColor, in float dist) {
  float attenuationStrength = attenuation * 0.7;
  float lowerEdge = 0.99 - attenuationStrength;
  float upperEdge = 1.01 + attenuationStrength;
  return mix(innerColor, outerColor,
             smoothstep(ratio * lowerEdge, clamp(ratio * upperEdge, 0.0001, 1.0), dist));
}
```

Read it as: inside `dist < ratio` you get **bright** colour; past `ratio` you cross-fade to **dim**; `attenuation` widens the cross-fade band around the `ratio` boundary. So **`ratio = bright/radius` is literally where the bright ring ends** and dim begins, and `attenuation` is how soft that ring is.

Illumination final write (`illumination-lighting.mjs:12`):

```glsl
gl_FragColor = vec4(mix(computedBackgroundColor, finalColor, depth), 1.0);
```

Where `depth` (0..1) is the soft-edge × occlusion mask (§9). Outside the light `depth→0` so it falls back to ambient — which, under MAX_COLOR + MULTIPLY, is a no-op. Inside, it reveals the lit luminance.

### 5d. Luminosity → exposure (the brightness dial)

`base-light-source.mjs:217-218`:

```
u.luminosity = data.luminosity;               // 0..1, default 0.5
u.exposure   = data.luminosity * 2.0 - 1.0;   // -1..+1, default 0
```

`exposure` brightens/darkens in the `EXPOSURE` block. Illumination uses a _gentler_ exposure (quarter-strength near center) to avoid the light visually inflating its radius (`illumination-lighting.mjs:29-43`). Background/coloration use half-strength (`base-lighting.mjs:293`).

---

## 6. Colour — the coloration channel in full

`coloration-lighting.mjs:55` assembles: `FRAGMENT_BEGIN → finalColor = color * colorationAlpha → COLORATION_TECHNIQUES → ADJUSTMENTS → FALLOFF → FRAGMENT_END`, and writes:

```glsl
gl_FragColor = vec4(finalColor * depth, 1.0);   // then SCREEN per-mesh, ADD onto scene
```

`colorationAlpha` is derived from `alpha` **per technique** (`base-light-source.mjs:141-160`):

- technique 0 (Legacy): `alpha²` (needs to be weak or it washes out).
- techniques 4,5,6,9 (burns/invert): `alpha`.
- everything else: `alpha * 2` (adaptive techniques look good in [0,2]).

### The 13 coloration techniques (`base-lighting.mjs:417-546`)

These modulate the **light's tint** by how bright the underlying **map pixel** is (`reflection = perceivedBrightness(baseColor)`), so light "reacts" to the surface it falls on. `id` is the `coloration` field.

| id  | Name                             | Behaviour (paraphrased)                                                                         |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0   | Legacy                           | flat tint, no sampling                                                                          |
| 1   | **Adaptive Luminance** (default) | `finalColor *= reflection` — tint scaled by surface brightness                                  |
| 2   | Internal Halo                    | bright core, luminance-darkened rim (`switchColor`)                                             |
| 3   | External Halo                    | luminance-darkened core, bright rim                                                             |
| 4   | Color Burn                       | photographic burn against the surface                                                           |
| 5   | Internal Burn                    | burn core → reflection rim                                                                      |
| 6   | External Burn                    | reflection core → burn rim                                                                      |
| 7   | Low Absorption                   | `reflection *= smoothstep(0.35,0.75,reflection)`                                                |
| 8   | High Absorption                  | `smoothstep(0.55,0.85,…)` — only bright surfaces reflect                                        |
| 9   | Invert Absorption                | `reversePerceivedBrightness^5` — dark surfaces glow                                             |
| 10  | **Natural Light**                | luminance reflect **+** a background-muting term that tints the map by ambient at high darkness |
| 100 | Natural Attenuation              | Natural Light **+** exponential radial falloff (see §7)                                         |
| 101 | Adaptive Attenuation             | Adaptive + exponential falloff, no background muting                                            |

The technique block is auto-generated as an `if (technique == N) {…}` chain (`getShaderTechniques`, `base-lighting.mjs:203`).

### Why "bright AND colourful", stated plainly

1. **Illumination** (luminance, from ambient palette) → `MAX_COLOR` per light → **MULTIPLY** on the map. Governs _how visible_ the map is. Colour-agnostic.
2. **Coloration** (the light's `color`, technique-shaped) → `SCREEN` per light → **ADD** on the map. Governs _what hue_ sits on the map. Brightness-agnostic (it's additive).
3. **Background** (below) → tweaks the map's own look (contrast/sat/shadow) under the light.

Because (1) is multiplicative luminance and (2) is additive chroma, a saturated red light at full brightness delivers _both_ full map visibility (mult by bright red-neutral luminance) _and_ a strong red cast (add red) — no trade-off. A single-texture "tinted glow" sprite can't do this; it has to pick.

---

## 7. Falloff & attenuation — every variant

There are **three** falloff mechanisms; a light may use one or two at once.

**(a) The bright↔dim cross-fade** — `SWITCH_COLOR` (§5c). Softens the _internal_ ring, not the outer edge.

**(b) The outer-edge `FALLOFF`** (`base-lighting.mjs:349`), applied in every channel near the end:

```glsl
if ( attenuation != 0.0 ) depth *= smoothstep(1.0, 1.0 - attenuation, dist);
```

Fades the light out toward `dist = 1` (the radius edge). Higher `attenuation` = the fade starts further in = softer, smaller-looking pool.

**(c) Exponential falloff** — only techniques **100/101** (`base-lighting.mjs:502-545`), applied to `depth` in _both_ coloration and illumination:

```glsl
float k = 1.0 + attenuation * 13.33;
float s = 0.05;                               // flat core radius
float fall = mix(exp(-k*(dist - s)), 1.0, step(dist, s));
depth *= max(0.095, fall);                    // never fully zero (0.095 floor)
```

This is a physically-flavoured inverse-exponential — much closer to real light falloff than the smoothstep. **For a Three.js port that wants "nicer" light, technique 101's curve is the one to copy.**

**The attenuation remap** (user value → shader value), `base-light-source.mjs:225-231`:

```
computedAttenuation = (cos(PI * attenuation^1.5) - 1) / -2      // maps [0,1]→[0,1], eased
```

(Author's own Desmos: `https://www.desmos.com/calculator/e7z0i7hrck`.) The eased value is what the shader's `attenuation` uniform actually receives.

---

## 8. The background channel — the map's look under a light

`background-lighting.mjs`. It samples the map (`useSampler=true`, `backgroundAlpha=alpha`) and applies the **colour-correction operators** so a light can locally change the map's _appearance_, not just brighten it:

- **CONTRAST** (`base-lighting.mjs:268`): `(c-0.5)*(contrast+1)+0.5`.
- **SATURATION** (line 280): `mix(grey, c, 1+saturation)` where `grey = perceivedBrightness(c)`.
- **EXPOSURE** (line 293): radius-aware brighten.
- **SHADOW** (line 328): `mix(1, smoothstep(0.5,0.8,perceivedBrightness(c)), shadows)` — darkens dim parts of the map, a cheap fake AO.

`isRequired` (line 75) skips this whole channel unless one of `contrast/saturation/shadows/exposure/technique` is non-default — an optimisation worth mirroring.

---

## 9. Occlusion — soft edges & elevation/roofs

Inside `FRAGMENT_BEGIN` (`base-lighting.mjs:392`):

```glsl
float dist = distance(vUvs, vec2(0.5)) * 2.0;
vec4 depthColor = texture2D(depthTexture, vSamplerUvs);
float depth = smoothstep(0.0, 1.0, vDepth)
            * (globalLight ? 1.0
                           : step(depthColor.g, depthElevation)
                           * step(depthElevation, (254.5/255.0) - depthColor.r));
```

- `vDepth` (per-vertex, `smoothstep`ed) = the **soft edge** blur (from `EDGE_OFFSET = -8px`, `_initializeSoftEdges`). Circles skip it; walls/cones use it.
- The two `step(depthColor…)` terms = **elevation/roof occlusion** read from `canvas.masks.depth`. Green channel = lower bound, `254.5/255 - red` = upper bound; the light only lands on surfaces whose encoded elevation is within the light's `depthElevation`. This is Foundry's "foreground tile / roof hides the light" mechanism (relevant to our `coverAbove` / mask-authority work — see [[keyhole-mask-authority]]).
- `globalLight` bypasses depth entirely (the sun is everywhere at once, `elevation: Infinity`).

---

## 10. Colour-correction summary (per-channel matrix)

| Operator             | background          | illumination | coloration            | Uniform source                  |
| -------------------- | ------------------- | ------------ | --------------------- | ------------------------------- |
| Contrast             | ✓                   | —            | —                     | `contrast` (clamped ×0.5 if <0) |
| Saturation           | ✓                   | ✓            | ✓                     | `saturation`                    |
| Exposure             | ✓ (½)               | ✓ (¼)        | —                     | `exposure = luminosity*2-1`     |
| Shadow               | ✓ (map lum 0.5–0.8) | ✓            | ✓ (map lum 0.25–0.35) | `shadows`                       |
| Coloration technique | ✓\*                 | ✓\*          | ✓                     | `technique`                     |

(`ADJUSTMENTS` getter differs per channel: `base-lighting.mjs:253`, `illumination-lighting.mjs:19`, `coloration-lighting.mjs:19`.)

---

## 11. Global illumination (the sun) and how regions block it

### The sun is a scene-sized light

`GlobalLightSource` (`global-light-source.mjs`): `elevation: Infinity`, `priority: -Infinity`, `walls: false`, its shape is the **whole scene rect** (`canvas.dimensions.sceneRect.toPolygon()`), soft edges off. It's owned by the environment group and (re)initialised in `#configureGlobalLight` (`groups/environment.mjs:320-331`):

```
dim   = globalLight.bright ? 0    : maxR      // maxR = canvas.dimensions.maxR * 1.2
bright= globalLight.bright ? maxR : 0
disabled = !globalLight.enabled
```

### The darkness-level window (the gate)

`global-light-source.mjs:73-81` sets two uniforms from the scene's `globalLight.darkness = {min, max}`:

```glsl
u.globalLight = true;
u.globalLightThresholds[0] = min;
u.globalLightThresholds[1] = max;
```

And `COMPUTE_ILLUMINATION` ends with the gate (`base-lighting.mjs:385`):

```glsl
if ( globalLight &&
     ((computedDarknessLevel < globalLightThresholds[0]) ||
      (computedDarknessLevel > globalLightThresholds[1])) ) discard;
```

**So the sun renders only where the per-pixel darkness level sits inside its `[min,max]` window.** Push darkness above `max` in some area and the sun _discards_ there. This is exactly the `_Outdoors`-mask behaviour: paint darkness → the sun stops.

### Regions paint the darkness-level field — "Adjust Darkness Level"

**Behaviour:** `client/data/region-behaviors/adjust-darkness-level.mjs`. Modes (`MODES`, line 29):

- `OVERRIDE (0)`: `darknessLevel = modifier`
- `BRIGHTEN (1)`: `darknessLevel = sceneDarkness * (1 - modifier)`
- `DARKEN (2)`: `darknessLevel = 1 - (1 - sceneDarkness) * (1 - modifier)`

When such a region is viewed it spawns **two** meshes (line 65-90):

1. `AdjustDarknessLevelRegionShader` → added to `canvas.effects.illumination.darknessLevelMeshes` (**the RED-channel darkness field** the light shaders sample). Optionally blurred (8px) for soft region edges.
2. `IlluminationDarknessLevelRegionShader` → added to `canvas.visibility.vision.light.global.meshes` (so the sun's **vision/visibility** mask matches).

The darkness-field shader (`rendering/shaders/region/adjust-darkness-level.mjs:75`):

```glsl
vec2 depthColor = texture2D(depthTexture, vScreenCoord).rg;
float depth = step(depthColor.g, top) * step(bottom, (254.5/255.0) - depthColor.r);   // elevation clip
gl_FragColor = vec4(darknessLevel, 0.0, 0.0, 1.0) * tintAlpha * depth;                // writes R = darknessLevel
```

The container (`DarknessLevelContainer`, `illumination-effects.mjs:169`) is RED-format, NEAREST, and its children are **sorted by darkness level descending so the final pixel = the minimum darkness** among overlapping regions (`invalidateDarknessLevelContainer`, line 100-110). `_preRender` maps the region's `elevation.bottom/top` through `canvas.masks.depth.mapElevation` so a region only darkens within its own elevation band.

**Net effect for us:** the darkness-level field is a screen-space, region-authored, elevation-aware mask in exactly one channel. Our `_Outdoors` dark areas map onto this precisely: a dark `_Outdoors` texel ≈ a region-painted high darkness-level texel ≈ "sun discards here." The whole thing is a one-channel float field; reproducing it in Three.js is a single R-target you sample in the light/sun shader with the same `discard`/`step` gate.

---

## 12. Darkness sources — negative light

`PointDarknessSource` (`point-darkness-source.mjs`) is a `BaseLightSource` with the sign flipped:

- **One channel only**, `darkness`, `AdaptiveDarknessShader`, `MAX_COLOR`.
- `radius = bright = dim = max(dim,bright)` — no bright/dim split for darkness.
- Default darkness colour `#8651d5` (a violet), _not_ black — darkness reads as a cold gloom, not a hole (`darkness-lighting.mjs:44`). Base shader body:
  ```glsl
  finalColor *= (mix(color, color * 0.33, darknessLevel) * colorationAlpha);   // darkness-lighting.mjs:118
  ```
- A **visual padding** (`darknessSourcePaddingMultiplier`) lets the darkness texture bleed past its light-blocking radius; `borderDistance` fades that padding (`FRAGMENT_BEGIN`, `darkness-lighting.mjs:82`), and it can mask by the vision texture (`enableVisionMasking`).

**Light vs darkness arbitration** is by `priority` + edges, not by blend math:

- Light is suppressed inside a darkness of `≥` priority: `suppression.darkness = testInsideDarkness(origin, {condition: ds => this.priority <= ds.priority})` (`point-light-source.mjs:31-34`).
- Darkness is suppressed inside a light of strictly `>` priority (`point-darkness-source.mjs:88-91`).
- Darkness sources emit **edges** that block light & sight like walls; a light's edge priority is `priority - 0.5` so "light loses to darkness at equal priority" (`point-light-source.mjs:80-86`, `point-darkness-source.mjs:97-107`).

Darkness also has its own 4 animations (§13).

---

## 13. The animation system

### Framework

An animation = **an update function** (mutates uniforms each frame) **+ optional replacement shaders** per channel. Registry: `CONFIG.Canvas.lightAnimations` and `.darknessAnimations` (`client/config.mjs:828-980`). Each entry:

```js
torch: {
  label: "LIGHT.ANIMATION.Torch",
  animation: PointLightSource.prototype.animateTorch,      // runs every frame
  illuminationShader: TorchIlluminationShader,             // swapped in for this animation
  colorationShader:   TorchColorationShader
}
```

On init the source deep-clones the config into `this.animation` (`base-light-source.mjs:127`), `_configureShaders` swaps the per-channel shader (`rendered-effect-source.mjs:274`), and each frame `animate(dt)` calls the function (`rendered-effect-source.mjs:522`).

### The animation update functions (drive the uniforms)

All in `rendered-effect-source.mjs` / `base-light-source.mjs`:

- `animateTime` (base): `time = (speed * tickerTime)/5000 + seed`; sets `u.time`, `u.intensity`. The default clock for most animations.
- `animateTorch` → `animateFlickering(amplification=intensity/5)`: `SmoothNoise` drives `brightnessPulse ∈ [0.55,1.0+]` and jitters `ratio` (`base-light-source.mjs:269`).
- `animatePulse`: cosine wave drives `pulse` (coloration) and `ratio` (illumination) (`base-light-source.mjs:300`).
- `animateSoundPulse` (**"reactive"**): reads `game.audio` bass/mid/treble bands, `intensity` blends bass→treble, exponential smoothing → `pulse`/`ratio` (`base-light-source.mjs:339`). This is a hook worth keeping — audio-reactive lights.

Key animation uniforms the shaders read: `time`, `intensity`, `pulse`, `brightnessPulse`, `ratio`, plus the per-frame `seed` for de-syncing identical lights.

### Full animation catalogue (light — 25)

Each row: what technique it demonstrates (from `lighting/effects/*.mjs`). "ill/col" = which channels it replaces.

| type            | ill | col | Technique of note                               |
| --------------- | :-: | :-: | ----------------------------------------------- |
| `flame`         |  ✓  |  ✓  | FBM flame tongues, `brightnessPulse`            |
| `torch`         |  ✓  |  ✓  | `color * brightnessPulse` + SmoothNoise flicker |
| `revolving`     |     |  ✓  | rotating beam via `PIE`/angle                   |
| `siren`         |  ✓  |  ✓  | rotating warning beam                           |
| `pulse`         |  ✓  |  ✓  | `pfade` radial breathing                        |
| `reactivepulse` |  ✓  |  ✓  | pulse driven by audio bands                     |
| `chroma`        |     |  ✓  | `hsb2rgb(time)` hue cycle (`forceDefaultColor`) |
| `wave`          |  ✓  |  ✓  | sine rings                                      |
| `fog`           |     |  ✓  | FBM drifting fog                                |
| `sunburst`      |  ✓  |  ✓  | angular `fract(angle*16)` rays + core pulse     |
| `dome`          |     |  ✓  | hemispherical shell                             |
| `emanation`     |     |  ✓  | radiating beams                                 |
| `hexa`          |     |  ✓  | hex-grid dome                                   |
| `ghost`         |  ✓  |  ✓  | wandering FBM ghost light                       |
| `energy`        |     |  ✓  | **3D voronoi** energy field                     |
| `vortex`        |  ✓  |  ✓  | swirling FBM                                    |
| `witchwave`     |  ✓  |  ✓  | bewitching wave                                 |
| `rainbowswirl`  |     |  ✓  | swirling rainbow (HSB)                          |
| `radialrainbow` |     |  ✓  | radial rainbow (HSB)                            |
| `fairy`         |  ✓  |  ✓  | multi-point fairy sparkle                       |
| `grid`          |     |  ✓  | force-grid lines                                |
| `starlight`     |     |  ✓  | rotating `tan(fbm)` star rays                   |
| `smokepatch`    |  ✓  |  ✓  | drifting smoke                                  |

### Full animation catalogue (darkness — 4)

`darknessAnimations` (`config.mjs:959`): `magicalGloom` (radial-projection interference ring), `roiling` (RoilingDarknessShader), `hole` (**Black Hole** — `beamsEmanation` swallowing beams), `denseSmoke`. All use `animateTime` + a `darknessShader`.

### Anatomy of an animation shader (the pattern to copy)

Animations override only `_createFragmentShader`, reusing the scaffold and changing how `finalColor` (and sometimes `depth`) is built. Torch coloration in full:

```glsl
void main() {
  ${FRAGMENT_BEGIN}                                    // dist, ambient, occlusion
  finalColor = color * brightnessPulse * colorationAlpha;   // the ONLY animated line
  ${COLORATION_TECHNIQUES}
  ${ADJUSTMENTS}
  ${FALLOFF}
  ${FRAGMENT_END}                                      // finalColor*depth, SCREEN, ADD
}
```

Flame coloration is the same skeleton with an FBM field building tongues around `dist` (`effects/flame.mjs:53-87`). This regularity means a Three.js port can implement the scaffold **once** (a base light material with `#include`-style chunks) and express each of the 29 animations as a short body swap — matching Foundry's own architecture, and leaving the door open to add new modes the same way.

---

## 14. End-to-end frame (how it all lands on screen)

1. **Darkness field**: scene darkness + region "Adjust Darkness Level" meshes → RED render texture (`DarknessLevelContainer`).
2. **Baseline illumination**: `mix(daylight, darkness, field.r)` fills the illumination texture.
3. **Per light** (`drawMeshes`): background/illumination/coloration (+darkness) meshes, each running its channel shader, each `MAX_COLOR`/`SCREEN` blended into its container. Sun is gated by the darkness window (`discard`).
4. **Composite onto the map** (primary render texture): background `NORMAL`, illumination **`MULTIPLY`**, coloration **`ADD`**, darkness `NORMAL`.
5. **Mask by visibility**: `VisualEffectsMaskingFilter` (modes BACKGROUND/ILLUMINATION/COLORATION) multiplies the effects by the vision/fog texture so unseen areas aren't lit (`layers/effects/*` `_draw`).

---

## 15. Reconstruction cheat-sheet (Foundry → Three.js)

| You want to match…                     | Reproduce this                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------------------------------------- |
| **Radius (px)**                        | `dim/bright(grid) × (gridSize/gridDistance)`; `radius = max(dim,bright)`                                                                         |
| **Shape / cone / walls**               | Build the swept polygon on CPU (walls, `angle`, `rotation`); clip/stencil the quad to it. Don't do walls in-shader.                              |
| **Normalized falloff coord**           | `dist = distance(uv,0.5)*2` (0 center → 1 edge) after scaling the mesh by radius                                                                 |
| **Dim vs bright ring**                 | `ratio = bright/radius`; `smoothstep(ratio*lo, ratio*hi, dist)` cross-fade; `attenuation` sets `lo/hi` band                                      |
| **Outer falloff (default)**            | `depth *= smoothstep(1, 1-attenuation, dist)`                                                                                                    |
| **Outer falloff (nice/physical)**      | technique 101: `depth *= max(0.095, exp(-(1+att*13.33)*(dist-0.05)))`                                                                            |
| **Attenuation feel**                   | remap user value `(cos(π·a^1.5)-1)/-2` before use                                                                                                |
| **Brightness**                         | illumination = ambient-derived luminance, `MAX` across lights, **multiply** the map. Not the light's colour.                                     |
| **"bright AND colourful"**             | keep luminance (multiply) and hue (add/screen) in **separate targets**                                                                           |
| **Colour**                             | coloration = `color * colorationAlpha`, shaped by a technique that samples the map's luminance, **add** to scene                                 |
| **colorationAlpha**                    | `alpha²` (legacy) / `alpha` (burns) / `alpha*2` (adaptive)                                                                                       |
| **Exposure**                           | `exposure = luminosity*2-1`; ¼ strength in illumination, ½ in bg/col                                                                             |
| **Sat/Contrast/Shadow**                | the exact `mix(grey,c,1+sat)` / `(c-0.5)(contrast+1)+0.5` / `smoothstep`-shadow blocks (§8/§10)                                                  |
| **Sun (global light)**                 | scene-rect light, no walls, gated by `discard` on a darkness-level window                                                                        |
| **Sun blocked by `_Outdoors`/regions** | a one-channel darkness field; `discard` where `field < min                                                                                       |     | field > max`; elevation-clip via depth |
| **Darkness source**                    | violet `#8651d5` default, single MAX channel, priority-based suppression + light/sight edges                                                     |
| **Animation**                          | one scaffolded material; per-mode body swap driving `time/intensity/pulse/brightnessPulse/ratio`; reuse the GLSL toolkit (FBM/voronoi/HSB/noise) |
| **Overlap behaviour**                  | `MAX_COLOR`, never additive sum — two dim lights stay dim                                                                                        |

**Where we can go further than Foundry** (your stated goal): Foundry is stuck on WebGL1 GLSL-string concatenation and per-mesh full-screen textures. In our TSL/WebGPU stack we can (a) use the technique-101 exponential falloff everywhere by default, (b) drive animations from GPU-compute noise instead of CPU `SmoothNoise`, (c) keep the luminance/chroma split but in HDR (no `MAX_COLOR` clamping needed), and (d) treat the darkness-level field, `_Outdoors`, and `coverAbove` as one unified elevation-aware mask sampled once. All of that preserves Foundry's _look contract_ (radius, ratio, attenuation curve, ambient ladder) while removing its engine-era compromises.

---

## 16. File index

**Sources** `client/canvas/sources/`

- `base-effect-source.mjs` — lifecycle, `testPoint`, wall/surface collision
- `rendered-effect-source.mjs` — layers, meshes, shader swap, `animate`, `getCorrectedColor`
- `base-light-source.mjs` — light uniforms, ambient wiring, `animateTorch/Flickering/Pulse/SoundPulse`
- `point-effect-source.mjs` — polygon shape, angle/rotation, edges, normalized geometry
- `point-light-source.mjs` — light, `ratio`, darkness suppression
- `point-darkness-source.mjs` — negative light, single channel, padding/borderDistance
- `global-light-source.mjs` — the sun, darkness-window uniforms

**Lighting shaders** `client/canvas/rendering/shaders/lighting/`

- `base-lighting.mjs` — **the important one**: FRAGMENT_BEGIN, COMPUTE_ILLUMINATION, SWITCH_COLOR, FALLOFF, EXPOSURE/CONTRAST/SATURATION/SHADOW, 13 techniques
- `illumination-lighting.mjs`, `coloration-lighting.mjs`, `background-lighting.mjs`, `darkness-lighting.mjs`
- `effects/*.mjs` — 29 animation shaders
- `../base-shader.mjs`, `../mixins/base-shader-mixin.mjs` — GLSL toolkit (noise/fbm/voronoi/hsb/perceivedBrightness/colour-space)
- `../samplers/baseline-illumination.mjs` — the ambient floor

**Composition** `client/canvas/`

- `groups/environment.mjs` — ambient colours, weights, darkness level, global light config
- `groups/effects.mjs` — routes source meshes into layer containers
- `layers/effects/{illumination,coloration,background,darkness}-effects.mjs` — layer blend modes + `DarknessLevelContainer`

**Regions (sun blocking)**

- `client/data/region-behaviors/adjust-darkness-level.mjs` — the behaviour + modes
- `client/canvas/rendering/shaders/region/adjust-darkness-level.mjs` — writes the darkness field

**Data**

- `common/data/data.mjs` → `LightData` — the authored schema
- `common/constants.mjs` → `LIGHTING_LEVELS`
- `client/config.mjs:828-980` → animation registries
- `client/canvas/placeables/light.mjs` — document→source data, `dimRadius`/`brightRadius`

---

## 17. Two light types — the project decision

The rebuild ships **two** light kinds, and they have different success criteria:

- **Type A — "Parity" lights (default).** Any light Foundry created normally. **Goal: indistinguishable from native Foundry.** Same brightness, radius, shape, falloff, colour, animation. These are judged by A/B against Foundry, so they must obey the parity contract in §18 _exactly_ — including the boring parts (colour space, blend equations, grid-unit radius). This is the track V2 lost; it does not get to "look nice," it has to "look **same**."
- **Type B — "MSA" lights (opt-in).** MSA-only, never expected to run in vanilla Foundry. **Goal: do things Foundry can't** — HDR bloomable cores, GPU-compute noise, volumetric shafts, true light-linking, tone-mapped exotic falloffs, WebGPU-only tricks. Free of the parity contract _by design_.

**The boundary rule:** a Type-B light must be visibly, deliberately its own thing and must be **opt-in on a per-light basis** (an MSA flag on the light, or an MSA-only light class). A Type-B light may never be silently substituted for a Foundry-authored light — the moment a GM's normal light renders as something "fancier," you've reintroduced the V2 complaint ("my lights don't match"). Parity is the default; flair is the exception you ask for. (This is the same shape as the safety-slide doctrine — reliability/faithfulness is the default, per [[feedback_safety_slide_outranks_doctrine]].)

Both types can share the _scaffold_ (§13 — the channel materials, the GLSL toolkit, the animation dispatch). They differ in the **compositing target and colour space** (§18.1) and in what liberties the fragment body takes.

---

## 18. The parity contract — what a Type-A light MUST reproduce

If you do all of these, in this order, in this space, a Type-A light matches. Miss any one and it won't. Ranked roughly by "how badly V2-style pipelines get it wrong."

### 18.1 Colour space & output — the make-or-break one

Foundry's canvas is created with **no colour management**: `transparent:false, antialias:false`, no `outputColorSpace`, no linear working space, **no tonemap** (`board.mjs:713-725`; a full grep of the canvas tree for `tonemap|linear|SRGB|colorSpace` returns nothing but opt-in helpers). Every operation — the ambient `mix()`es, `perceivedBrightness`, the MULTIPLY, the ADD — happens on **gamma-encoded sRGB values treated as if linear**. Textures are sampled raw.

**Therefore the parity light must composite in the same gamma space with no tonemap.** A modern Three.js pipeline (`renderer.outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, linear textures) running the _identical_ GLSL will be brighter, less saturated, and have a different falloff shoulder — because it linearizes, tone-maps, then re-encodes. This is the single most likely reason V2 "never matched." Options for the port:

- render the parity lights' composite into an **sRGB-data (no-tonemap) target**, i.e. do the multiply/add on the stored values and blit, tonemap disabled for that pass; **or**
- keep the pipeline linear but _replicate Foundry's operations bit-for-bit_ including "mix in gamma space," and disable tonemap on the final light composite.
  Either way: **tone mapping OFF and gamma-space math for Type-A.** (Type-B may do whatever — HDR + ACES is where the fun lives.)

### 18.2 The exact composite (the pixel equation)

Stage order, bottom to top (§14):

```
scene = primary group rendered at FULL brightness (map + tiles + tokens)     // never pre-dimmed
illum  = baseline(ambientFloor)  MAX  Σ_light illuminationMesh_i             // per-mesh MAX_COLOR
color  = 0                       ADD  Σ_light colorationMesh_i               // per-mesh SCREEN, layer ADD
bg     = per-light background meshes (MAX_COLOR), NORMAL onto scene
out    = ((scene ∘ bg) × illum) + color                                       // × = MULTIPLY, + = ADD
out    = visionMask(out)                                                       // §16 replacement/tint
```

- **`MAX_COLOR` is `result = max(src, dst)` per channel (RGB _and_ A)** — `blend-modes.mjs:7`. Not additive. Overlapping equal lights do **not** brighten. In WebGPU: `blend.color = {op:'max', src:'one', dst:'one'}`, same for alpha.
- **Illumination MULTIPLIES the map.** Light does not "add glow"; it _reveals_ a map that is already drawn at full brightness, by multiplying a luminance field over it. An unlit pixel = map × ambientDarkness. This is the inverse of the usual "additive light sprite" instinct and is trap #2 below.
- **Coloration ADDS** (after per-mesh SCREEN). Hue only.

### 18.3 The numeric checklist (each is a §-reference)

| #   | Quantity                | Exact rule                                                                                   | §       |
| --- | ----------------------- | -------------------------------------------------------------------------------------------- | ------- |
| 1   | Radius                  | `max(dim,bright) × gridSize/gridDistance` (grid units → px)                                  | §1      |
| 2   | Bright/dim pivot        | `ratio = bright/radius`, cross-fade `smoothstep(ratio·(0.99−0.7a), ratio·(1.01+0.7a), dist)` | §5c     |
| 3   | Normalized dist         | `distance(uv,0.5)·2`, mesh scaled by radius                                                  | §2      |
| 4   | Attenuation easing      | uniform = `(cos(π·a^1.5)−1)/−2` before use                                                   | §7      |
| 5   | Outer falloff           | `depth *= smoothstep(1, 1−a, dist)` (or exp for tech 100/101)                                | §7      |
| 6   | Ambient floor           | `mix(ambientDaylight, ambientDarkness, darknessField.r)`                                     | §3, §5a |
| 7   | Bright colour           | `mix(background, ambientBrightest, 1.0)` — **from ambient, not light colour**                | §5a     |
| 8   | Dim colour              | `mix(background, bright, 0.25)`                                                              | §5a     |
| 9   | Luminance               | `sqrt(dot(vec3(.2126,.7152,.0722), c·c))` (exact BT.709, squared)                            | §4      |
| 10  | colorationAlpha         | `alpha²` (legacy) / `alpha` (burns 4,5,6,9) / `alpha·2` (rest)                               | §6      |
| 11  | Exposure                | `luminosity·2−1`; ¼ strength in illum, ½ in bg/col                                           | §5d     |
| 12  | Weights                 | `{dark:0, halfdark:0.5, dim:0.25, bright:1}`                                                 | §5a     |
| 13  | Default darkness colour | `#8651d5`, not black                                                                         | §12     |
| 14  | Overlap                 | channel-wise MAX, never sum                                                                  | §3      |

### 18.4 What the darkness field must be

A single **R-channel** screen-space float (`DarknessLevelContainer`, RED format, NEAREST). Seeded by scene darkness, painted by regions (§11), elevation-clipped by the depth mask. Both the parity light's ambient math _and_ the sun's `discard` gate sample it. On our side this is the same object as the `_Outdoors` dark areas and folds into the mask-authority hub ([[keyhole-mask-authority]]).

---

## 19. The fidelity traps — ranked list of "why lights don't match"

Each: **trap → symptom you'd see → fix.** These are the checklist to run when a Type-A light looks off. (V2's specific architectural scars — eight suns, shadow-as-paint, darkness feedback bus — are in [[v2-postmortem-the-failure-modes]] / `docs/planning/Light-and-Shadow.md`; these here are the _perceptual/shader_ traps that make even a correctly-placed light render wrong.)

1. **Linear + tonemapped pipeline.** _Symptom:_ lights read too bright and washed-out/desaturated, falloff shoulder too soft, colours drift toward pastel. _Fix:_ §18.1 — gamma-space math, tonemap OFF for the parity composite. **Most likely V2 culprit.**
2. **Additive light instead of multiplied luminance.** _Symptom:_ lit areas blow toward white, overlaps stack to white, dark map regions glow where they shouldn't, black map stays black under light. _Fix:_ draw the map at full brightness and **multiply** an ambient-derived luminance field (§18.2).
3. **Illumination tinted by the light's own colour.** _Symptom:_ a red light is dimmer than a white one; you can't get "bright AND red." _Fix:_ illumination uses the **ambient palette** only; colour lives in the separate additive coloration channel (§5a, §6).
4. **Overlap via ADD not MAX.** _Symptom:_ two dim torches overlapping make a bright spot. _Fix:_ `MAX_COLOR` = `max(src,dst)` (§18.2).
5. **Radius in pixels, not grid units.** _Symptom:_ lights are the right size on one scene and wrong on another; rescaling the grid breaks them. _Fix:_ `× gridSize/gridDistance` (§1).
6. **Skipping the attenuation easing.** _Symptom:_ the attenuation slider feels wrong/non-linear versus Foundry, especially near 0 and 1. _Fix:_ `(cos(π·a^1.5)−1)/−2` (§7).
7. **Wrong `ratio` handling.** _Symptom:_ the bright core is the wrong size, or bright/dim boundary is hard when it should be soft. _Fix:_ `ratio=bright/radius` + the `switchColor` band (§5c).
8. **Coloration/background not sampling the actual map.** _Symptom:_ coloration techniques (luminance, burns, absorption) do nothing; light doesn't "react" to the surface it falls on; `NaturalLight` looks flat. _Fix:_ feed the primary (map) render texture as `primaryTexture`; techniques read `perceivedBrightness(baseColor)` (§6).
9. **Premultiplied-alpha mismatch on custom blends.** _Symptom:_ faint dark fringing or wrong edges where meshes overlap. _Fix:_ Foundry remaps PM/NPM for custom blend modes (`board.mjs:820`); match the premultiply state of your targets to the blend.
10. **`perceivedBrightness` in the wrong space / wrong coefficients.** _Symptom:_ saturation/shadow/coloration thresholds land at the wrong luminance; greys shift. _Fix:_ exact `sqrt(dot(BT709, c·c))` with BT.709 `(0.2126,0.7152,0.0722)` (§4).
11. **Elevation/roof occlusion done geometrically instead of via the depth field.** _Symptom:_ lights bleed under roofs or clip at wrong heights. _Fix:_ the two `step(depth…)` tests against `depthElevation` (§9).
12. **Soft edge ignored (or applied to circles).** _Symptom:_ hard aliased light rims where Foundry is feathered; or over-soft circular lights. _Fix:_ `EDGE_OFFSET=-8px` blur via `vDepth`, **disabled for complete circles** (§2, §9).

**Suggested validation harness:** drop one Foundry light and one Type-A light with identical params on the same scene, screenshot both, diff. Walk the params one at a time — `dim/bright`, then `attenuation`, then `luminosity`, then `color`, then each `coloration` technique, then each animation. Any param whose diff isn't ~flat points at exactly one trap above. (This is the "instruments must not lie" discipline, [[feedback_instruments_must_not_lie]] — a visible diff, not a vibe.)

---

_Audit performed against the vendored v14 tree; cross-reference [[reference_foundry_v14_layering_law]] for how the lit result then sorts against the primary group, and [[keyhole-mask-authority]] for how the depth/`coverAbove` masks referenced in §9/§11 are served on our side. §17–19 added 2026-07-17 to serve the two-light-type plan and the parity track that V2 lost._
