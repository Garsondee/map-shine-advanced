# WINDOWS — light through an aperture (`light.accumulate`)

**Status:** DESIGN SPEC, nothing built. Authored from a direct read of `legacy/compositor-v2/effects/WindowLightEffectV2.js` (3,667 lines), its consumption inside `LightingEffectV2.js`'s compose (the half that actually decided what the effect looked like), and the harvested control schema (`docs/reference/v2-effect-params/window-light-effect.md`, **98 authored controls**).
**Owns:** no new pass. `graph/passes.js` already assigns `WindowLightEffectV2` to **`light.accumulate`**, and that assignment is correct for a reason this document is largely about: a window is a light, so it belongs in the light system rather than beside it.
**Companion:** `Specular.md` (the port pattern this follows — the autopsy → reframe → ladder shape, and its two shipped-invisible corrections) · `Light-and-Shadow.md` §1 (*"Window light is a light."*) · `Light-MSA-Ideas.md` §C (**gobo projection**, 🟢 C4, the author's own recommendation #2 of three) · `Sun-Shadows.md` (the throw formula this delegates to) · `Effects.md` (the ladder laws).

---

## 0. The thesis, in one paragraph

V2 made the **window glow**. A window does not glow; a window is a **hole**. Light arrives at one side of it and leaves from the other, and which way it flows is decided by which side is brighter — the sky, or the lamps in the room. Get that one noun right and almost everything V2 hand-built falls out for free: the eight time-of-day anchors become the sun we already compute, the cloud dimming becomes the sky handle we already build, the lightning coupling becomes "the sky got bright for 100 ms", and the single most beautiful thing a top-down map can do — **a shaped, coloured patch of sunlight lying on the flagstones, sliding across the floor as the day advances** — becomes possible at all, which under V2's architecture it was not.

No new mask. The `_Window` file the author already paints, read as **glass** rather than as a glow: hue is what colour the light becomes, value is how much gets through, and the paint's own shape is the pattern it throws.

---

## 1. THE AUTOPSY — what V2 actually computed

### 1.1 The whole effect, distilled

3,667 lines of JS and ~300 lines of GLSL reduce to this, evaluated at **the pixel the mask is painted on**:

```
emit = luma(windowMask)^falloff                    // one scalar from a colour file
     × prismaticRgbSplit(mask, angle, wobble)      // 3 more mask taps at an offset
     × color × intensity × 0.22                    // WINDOW_ILLUM_SCALE, a magic number
     × (1 + specularMask × specularBoost)          // reaches into ANOTHER effect's mask
     + sparkleField(cameraViewCells, time)         // procedural glints
     × todGrade(hour → 8 anchors × 6 params)       // a hand-keyframed timeline
     × cloudDim × cloudShadow
     ; emit /= (1 + emit × 0.14)                   // its own tone shoulder
```

written into a **scene-sized render target** (`SCENE_MASK_EMIT_MAX = 4096`, sized to the scene rect), which `LightingEffectV2`'s compose then samples at *the same scene UV as the pixel being lit* and folds in as `totalIllumination += winIllum`.

That last sentence is the whole finding, so it is worth isolating:

> **The window's light is sampled at the pixel the window is painted on, and nowhere else. Light never travels. There is no patch on the floor and no pool on the street, because there is no mechanism by which anything could appear anywhere but on the mask itself.**

Every apparent "spill" in a V2 screenshot is `BloomEffectV2` smearing a bright decal. The effect is an **emissive sticker with a weather-aware colour grade**.

### 1.2 …and the exterior half was multiplied by zero

`legacy/compositor-v2/effects/LightingEffectV2.js:3351`:

```glsl
winLights *= (1.0 - isOutdoorForInteriorDimSafe);
```

Window light is **zeroed on outdoor pixels.** So the single most recognisable use of the effect — *a town at night, warm lit windows* — was structurally unreachable, by an explicit line of code, in the consumer rather than in the effect.

The gate is not stupid; it is the least-bad patch available. Because the only thing the effect could produce was a bright decal *at the mask*, and a window's mask paint sits on the boundary between roofed and open sky, the decal leaked onto the sky. Clipping it to indoors was the only way to stop that. **The clip is the price of the wrong noun** — the same shape `Light-and-Shadow.md` §0 identifies in `DynamicLightShadowLift.js` (a whole module to un-darken shadows near lights, because shadow had been made to darken everything). A compensator is a receipt.

And it lands the effect on the exact hazard `feedback_membership_beats_derived_threshold` names: a window is *painted on the wall*, and the wall is the shared boundary of the `_Outdoors` mask, so whether a given window texel reads indoors or outdoors is decided by how the author feathered a brush stroke.

### 1.3 The keyframes were standing in for the physics

Eight time-of-day anchors × (hour, intensity scale, exposure, saturation, tint R, tint G, tint B) = **56 of the 98 controls.** They exist because nothing in the effect knew what the sun was doing, so the look had to be drawn by hand, hour by hour.

They also got it backwards, and the way they got it backwards is diagnostic:

| Anchor | V2 `intensityScale` | What a **vertical** window actually admits |
| --- | --- | --- |
| Noon (12:00) | **3.0 — the highest of all eight** | The **least** of the whole day. A vertical aperture at a sun elevation of 70–80° admits almost nothing; the light goes past it, not through it. |
| Dusk (18:00) | 0.5 | The **most**, and the longest — a low sun drives a long stretched beam deep into the room. |

The timeline is describing *how bright the pane looks*, not *how much light gets through* — which is exactly right, because the pane looking bright was the only thing the effect had. Fifty-six sliders is what it costs to keyframe a quantity by hand instead of deriving it, and `env/one-sun`'s thesis is that a term derived twice is N−1 needless chances to disagree. Here the second derivation is a human with a mouse.

### 1.4 Static geometry, re-derived per pixel, per frame

The shader needs two geometric facts about each window: **where its edge is** and **which way its wall faces.** Both are properties of a file that changes when the author repaints it, i.e. approximately never. V2 recomputed both, per pixel, every frame:

| Function | Taps | What it was deriving |
| --- | --- | --- |
| `wlMaskEdge` | **5** mask samples | the aperture's edge |
| `wlRainFlowDir` | **4** samples of `_Outdoors` | the wall's facing direction — at a **user-tunable radius, 1…160 px** (`rainGlassSlopeSamplePx`, default 42) |
| the prismatic split | 3 mask samples | |
| mask + soft mask + floor id + specular + cloud shadow | 5 | |

**Seventeen texture fetches per pixel**, over a target up to 4096², through **11 samplers** and **94 uniforms**, with every mask read routed through a four-way `if/else if` chain on a floor index decoded from a byte texture.

A slider whose job is to tune how far to look when guessing a static geometric fact is the tell. The fact should have been measured once.

### 1.5 The cache that could not cache

`_buildFullEmitCacheKey()` is a 28-field string built to let a per-floor emit target survive across frames. Two of those fields are:

```js
rgbShiftAnimate !== false ? Math.floor(uTime * 8) : 0,   // 8 invalidations per second
rainActive      ? Math.floor(uTime * 12) : 0,            // 12 more when it rains
```

`rgbShiftAnimate` **defaults to `true`.** So the cross-frame cache, in the shipping configuration, invalidates eight times a second by construction, and the effect re-renders a scene-sized RGBA16F target at ~17 fetches per pixel eight times a second forever. The optimization was defeated by the default it shipped with.

### 1.6 The VRAM, and the device it has already lost

A 4096² RGBA16F target is **134 MB**. `_floorEmitCache` holds **one per floor** (up to four), and `_shadowLiftEmitRT` is a fifth, independent one. Worst case for this one effect is **over half a gigabyte** — on a codebase whose logged history includes a large-map device loss (`keyhole-device-loss-large-map`) and a second, differently-caused one on floor switch (`keyhole-floor-switch-canvas-redraw-collision`). `windowLightUseHalfFloat` and `setEmitResolutionScale(0.25…1)` exist as escape hatches, which is the shape of an architecture apologising for itself.

### 1.7 Two consumers, two disagreeing definitions

The same emit buffer is thresholded twice, differently:

| Consumer | Gate |
| --- | --- |
| compose (`LightingEffectV2.js:3345`) | `smoothstep(0.008, 0.055, winLuma)` |
| the shadow-lift blit (`:191`) | `smoothstep(0.10, 0.24, winL)` |

A twelve-fold disagreement about what counts as "there is window light here". Neither is wrong given the other does not exist; both existing is the problem, and it is only possible because the buffer's units were never defined. The `WINDOW_ILLUM_SCALE = 0.22` constant — commented *"Scale emit RT values for compose `litColor *= (1 + win)`"* against a compose that no longer does `litColor *= (1 + win)` — is the same symptom.

### 1.8 The rest of the ledger

- **Ten independent `flipY` uniforms** (`uWindow0…3FlipY`, `uSpecular0…3FlipY`, `uOutdoorsMaskFlipY`, `uFloorIdFlipY`) — ten separate chances to get `feedback_y_flip_recurring_risk` wrong, each with its own JS push site.
- **`specularBoost` reaches into `_Specular`** — four more samplers, so the window effect's output depends on another effect's mask with no declared edge. Precisely the `window.MapShine` free-for-all `graph/passes.js` exists to make impossible.
- **Rain-on-glass (9 controls) is the wrong effect in the wrong place.** It warps the **window mask's UVs** with procedural droplets. The mask is a region marker, not the glass surface, so warping it wobbles *the aperture* — the hole moves. Water on glass is a wet-clear-coat question for `surface.response` or a particle question; it is not the aperture's business.
- **Sparkle density is measured in units of the camera view.** `wlSparklePointField` derives its cell size from `viewUvMax − viewUvMin`, so zooming re-lays out the glint lattice — on a feature whose own author note says *"Glints do not drift on the map."* Same failure mode `Specular.md` §3.5 names for V2's sparkle: a fixed-frequency lattice that aliases instead of resolving.
- **Dead instrumentation.** `windowLightDraw.outdoorsClip` (`:5499`) and `lightOverride.windowDraw.outdoorsClip` (`:5275`) are perf spans that begin and immediately end, bracketing **nothing** — the clip moved into compose and the timers stayed. `feedback_instruments_must_not_lie`.
- **Diagnostics as a symptom.** A 506-line overexposure probe console snippet, a 77-line health-utils module, RT read-back luma scanners, `uDebugForceMagenta`. That is what an effect with undefined output units costs to debug.

### 1.9 What is worth harvesting

The code, almost none. The instincts, several, and every one of them gets *cheaper* under the reframe rather than being ported:

| V2 instinct | Verdict |
| --- | --- |
| **`_Windows` / `_Structural` as aliases** | Already preserved — `scene/mask-catalog.js` accepts both as discovery aliases of `window`. V2-authored map folders keep working. Nothing to do. |
| **Lightning should blast through windows** (4 controls) | **Correct, and free.** `Light-and-Shadow.md`: *"Lightning is a light — same caster geometry, different direction/time — free."* Once the window is an aperture, a lightning flash is "the sky got very bright for 100 ms" and the valve (§3) does the rest. 4 controls → 0. |
| **Cloud dimming** (1 control) | **Correct, and free.** `effects/sky-access.js` already collapses the key light under `cloudCover01` and raises the dome's share. 1 control → 0. |
| **The prismatic fringe** (8 controls) | The *instinct* — light dispersing through glass — is real, and `_Prism` is already a reserved suffix. But it belongs on the **transmitted beam's edge**, not as an RGB texture-offset on the mask. Returns as tier 8, at a fraction of the controls. |
| **The `_Outdoors` gradient as wall direction** | **Right fact, wrong lifetime.** Bake it (§4.1) instead of guessing it 17 taps at a time. |
| **A window's light takes the glass's colour** | Right, and V2 could only apply it as one global colour picker for the whole map. §2 makes it per-brushstroke for free. |

---

## 2. THE REFRAME — the mask is GLASS

`_Window` is declared `channels: 'color'` in `scene/mask-catalog.js`. V2 read `luma()` out of it and multiplied by a global colour. Read all three axes instead, the same move `Specular.md` §2 makes for `_Specular`:

| Axis of the painted colour | Reads as | Because |
| --- | --- | --- |
| **Hue** | **Transmission colour** | This is literally what stained glass does. Paint the rose window red and blue; red and blue light lands on the flagstones. `Light-MSA-Ideas.md` §C calls this *"one of the most atmospheric shots a VTT can produce."* |
| **Saturation** | **How much the glass tints** | Bright and colourless = clear glass. Bright and saturated = stained. This is the one axis that is genuinely about the glass rather than about the hole. |
| **Value** | **Openness / transmittance** | Near-white = an open arch or clean glass, full light through. Mid = leaded, dirty, horn, shuttered. Dark = a slit. |
| **Value near zero** | **Presence** | The bottom of the range is "is anything painted here", antialiased from the file's own edge exactly as `water-render.js` does it. |

```
v      = max(m.r, m.g, m.b)
p      = smoothstep(EDGE0, EDGE1, v)        // presence, antialiased from the file
open   = clamp(v, 0, 1) × opennessBias      // how much light gets through
tint   = mix(vec3(1), m / v, tintStrength)  // hue+saturation as a transmission filter
```

> ⚠️ **`open` and `tint` are two quantities and must stay in two numbers.** `feedback_one_byte_two_quantities` is the four-round bug class in this repo: `alpha × height` in one byte could not be tuned into correctness. V2 collapsed *how open* and *what colour* into one luma × one global picker, which is why a dim stained pane and a bright dirty one were indistinguishable. Presence keys off the very bottom of value (a threshold), openness off the whole range (a value) — the same split `_Fluid` uses, with the same authoring caveat: **do not paint the ramp down to pure black**, or the darkest glass reads as "no window".

**It is backwards compatible by construction.** A V2-era mask — greyscale, mid-to-bright — decomposes to `tint ≈ white`, `open ≈ 0.6`: a plain, uncoloured aperture admitting most of the light. Which is what V2 drew. Nothing is reinterpreted against its old meaning; two thirds of the signal is being un-discarded.

**And the mask doubles as the gobo.** Whatever the author painted — mullions, tracery, the leading between panes, the rose window's whole pattern — *is* the shape that gets projected onto the floor (§5, tier 3). One file is simultaneously where the aperture is, what colour its light is, and the picture it throws. That is the authoring story, and it needs no tutorial: **paint the window; get its light.**

---

## 3. THE VALVE — which way does the light flow?

This is the mechanism the 56 anchor sliders were standing in for.

A window is a two-way aperture. Both sides are lit, and the net flow is set by the ratio — which the engine already knows both halves of:

```
outside = skyIrradiance(env.sun, env.weather)   // effects/sky-access.js — key + fill, cloud already folded in
inside  = illumInside(aperture)                 // buf:scene.illum, reduced over the aperture's own footprint
flow01  = outside / (outside + inside + EPS)    // 1 = light goes IN, 0 = light comes OUT
```

| Condition | `flow01` | What you see |
| --- | --- | --- |
| Noon, clear | → 1 | Light flows **in**. A short bright sliver near the wall (a vertical aperture admits little at high sun). |
| Late afternoon | → 1 | A **long stretched patch** reaching deep into the room. The golden-hour shot. |
| Dusk, lamps just lit | ≈ 0.5 | **Both at once** — a fading patch inside and a strengthening glow outside. Which is exactly what dusk looks like, and it falls out rather than being keyframed. |
| Night, lamps lit | → 0 | Light flows **out**. A pool on the ground outside, and the pane reads bright from the exterior. **The thing V2 multiplied by zero.** |
| Night, dark room | → 0, both terms ~0 | Nothing. Correct: an unlit room behind a window is a dark hole. |
| Lightning flash | → 1, hard | The sky spikes; the patch blazes for 100 ms. **Free** — no coupling controls. |

> ⚠️ **The inward and outward terms are TWO TERMS, and neither may gate the other.** `feedback_environment_term_gates_wrong_thing` cost this project a shipped-invisible specular build: an ambient floor gated on its directional partner's trigger measured *exactly zero* in the commonest case. `flow01` is a **mix weight between two additive contributions**, never an `if`. Both are always computed; both are always added; at `flow01 = 0.5` both are half-strength. A build where one of them is behind the other's test is the same bug in a new costume.

### 3.1 The ordering problem, and its answer

The valve reads `buf:scene.illum` — which is the buffer `light.accumulate` is in the middle of writing. Sampling a target the current pass is still writing is undefined on both backends (the constraint that made `surface.response` a real pass, `Specular.md` §status).

The answer here is **ordering inside the pass**, not a new pass:

```
light.accumulate:
  1. ambient / darkness / regions       →  buf:scene.illum
  2. point lights (MAX-blended)         →  buf:scene.illum
  3. REDUCE illum over each aperture    →  the per-window `inside` scalar   ← reads a finished buffer
  4. window contributions (pane, patch, pool) → buf:scene.illum
  5. UI window shadow (multiply)
```

Step 3 reads what steps 1–2 finished. Step 4 writes. No cycle, no extra pass, no new declared resource. The window's contribution then rides the rest of `light.accumulate`'s existing machinery — the darkness ladder, coloration, `post.bloom`, and one grade — for free.

**And the reduction is per-aperture, not per-pixel.** "How bright is this room" is one number per window, so a stray torch under one pane cannot make its neighbour flicker. §4.2 is how that reduction becomes cheap.

---

## 4. WHAT PING-PONG AND COMPUTE BUY — the part V2 could not have written

This is the section the question was really about, so it is concrete and each row is verified against the vendored build or against code already in production here.

### 4.1 Ping-pong: the aperture pack (jump flood)

`effects/water/water-body-subsystem.js` already bakes a jump-flood pack from a mask on **mask-version change** — log₂(dim) ping-pong fullscreen passes, ten of them over a ≤512 px grid, not on the frame budget at all. Run the identical machinery on `_Window`:

- **R** — signed distance to the aperture boundary, world px
- **G** — aperture **id** (the label from §4.2), so a pixel knows *which* window it belongs to
- **BA** — the boundary **normal**: the direction light travels through the aperture

Water stores the *tangent* (along the bank); a window wants the *normal* (through the wall). Same JFA offset, unrotated — the flood already stores the vector to the nearest boundary point, and *that offset, normalised, IS the gradient*. Exact, one fetch, **no finite differences** — so none of `dFdx`'s divergent-flow undefined behaviour and none of the quantisation noise a half-float 4-tap derivative carries.

This one bake deletes `wlMaskEdge` (5 taps/pixel/frame), `wlRainFlowDir` (4 taps/pixel/frame), and `rainGlassSlopeSamplePx` (the slider for tuning a guess at a static fact).

> ⚠️ `feedback_sdf_does_not_draw_the_edge` — four rounds lost on water. **The silhouette comes from the mask file at full resolution** (`vt/mask-image.js`, `channels: 'rgb'` + `contentBounds`, the fork `_Specular` already added); the SDF supplies **distance only**. A coarse point-sampled field has no sub-texel information and can never draw a clean window frame.

### 4.2 Compute: apertures are a LIST, not a texture — and this is the big one

V2 only ever knew *"is there window paint at this pixel."* It never knew *"there are fourteen windows on this map; #7 is at (2100, 880), is 120 px wide, faces east-north-east, is stained deep blue, and sits on floor 1."*

That is not a shader limitation, it is a **data-structure** limitation. A fragment shader can only read textures; it cannot build a list. So every geometric question had to be answered by re-deriving geometry from the mask, per pixel, per frame — which is literally what §1.4 measured.

Connected-component labelling turns the paint into **records**:

```
Aperture { id, floorId, itemId, centroidWorld, widthPx, axis, outwardNormal, meanTintRgb, meanOpenness, aabb }
```

Two viable routes, and **neither requires WebGPU** (Law 5: tier follows measured performance, never the backend):

- **CPU at decode time** — exactly how `effects/fluid/fluid-net.js` extracts its tube net from `_Fluid` (connected components, arc length, radius profiles). Precedent in this repo, works everywhere, runs on mask change.
- **GPU label-propagation flood** — a second ping-pong pass sharing the JFA's own machinery, then a small parallel reduction per label for the centroid/axis/mean colour.

**What the list buys is the entire cost model of the effect.** Once a window is a record, it is *a spotlight with a rectangular gobo* — and the effect becomes **one small instanced quad per aperture** instead of a 4096² fullscreen pass. That is `Effects.md` Law 6 (cost scales with covered pixels, not screen pixels) satisfied by construction, and it is the difference between 16.7 M pixel invocations and a few tens of thousands.

It is also what makes §3's per-aperture reduction cheap: with a list, "reduce illum over window #7's footprint" is a bounded loop over a known AABB. Without one, it is a mip pyramid per window.

### 4.3 Scatter vs gather — the mechanical reason V2 was a decal

Fragment shading is a **gather**: each pixel asks *"what is at me?"* Compute can **scatter**: each source says *"here is where my light goes."*

The natural formulation of "light leaves this aperture and lands over there" is a scatter. V2 had only gather, so every pixel could ask *"is there window paint here?"* and never *"is there a window somewhere that shines on me?"* — and answering the second question by gathering means every pixel searching for every window, which is the O(pixels × windows) shape nobody can afford.

**This is the mechanical reason V2's window light could only ever be a sticker.** Not an oversight; the available primitive.

(The projected-quad formulation of §5 tier 2 is a *third* answer, and the cheapest: let the rasteriser do the scatter. That is what a shadow map is, and what a light cookie is. Compute is not required for it — but it took having the list to see it.)

### 4.4 The verified capability table

| Capability | Status | What it is worth here |
| --- | --- | --- |
| Fragment ping-pong JFA | **In production** — `water-body-subsystem.js` | The aperture pack (§4.1). Both backends. |
| CPU component extraction at decode | **In production** — `fluid-net.js` | The aperture table (§4.2). Both backends. |
| `renderer.compute()` | **Proven on BOTH backends** — `diag/compute-spike.js`, then `effects/particles/particle-runtime.js` in production | The GPU route for §4.2's labelling + reduction, and the motes in the beam (tier 9). |
| `texture(t, uv).gather(c)` | **Present** — `three.webgpu.js:63424` (`tsl_textureGather` WebGL2 emulation; native `textureGather` on WebGPU) | 2×2 in one instruction for the mask edge and the illum reduction. |
| MRT via `material.mrtNode` | **In production** — `vt/scene-attr.js` | The pane's composite without clobbering `buf:scene.attr`. |
| `ClockwiseSweepPolygon` for an arbitrary position | **In production** — `src/foundry/scene-wall-clip.js` (built for candles, `keyhole-candle-wall-clip-fix`) | **The beam clipped by interior walls, for free** (tier 6). An aperture becomes a light source and inherits exactly the wall handling every `AmbientLight` gets. |
| `mx_*` noise | **Present** | Backend-identical dust/haze structure in the shaft, no hand-rolled hash, no WebGL2 twin (Law 8). |
| Storage buffers | Available, **budget-constrained** | ⚠️ `keyhole-storage-buffer-limit-fix`: WebGPU caps 8 per stage and this project has already hit it. The aperture table is **one** small buffer — and since N is tens, it can be a small `DataTexture` instead if that one is one too many. Design for either. |
| Temporal ping-pong accumulation | Available | Integrate the shaft's moving haze across frames instead of N taps per frame (tier 7). |

---

## 5. THE GEOMETRY — where the light actually lands

The heart of the effect, and it is arithmetic on numbers `src/` already computes.

### 5.1 The projection

A wall window is a hole between sill height `h₀` and lintel height `h₁`. A ray entering at height `y` travels horizontally `y / tan(el)` before meeting the floor. So for sun elevation `el` and azimuth `az`:

```
dir     = −marchDirectionToSun(az)          // the ONE azimuth→XY convention in this codebase
offset  = h₀ / tan(el)  ·  dir              // where the patch STARTS
length  = (h₁ − h₀) / tan(el)               // how far along `dir` it reaches
width   = the aperture's own width
penumbra= marchPenumbraPx({ distancePx: offset })
```

**Every term on the right already exists and is already tested.** `marchDirectionToSun` is `effects/lighting/sun-occlusion.js`'s single azimuth convention; `heightPx / tan(elevation)` is verbatim the sun shadow's own `projectShadowOffset`; `marchPenumbraPx` is the shadow's own contact-hardening curve. Nothing is re-derived.

That matters beyond tidiness:

> **A wall's shadow and the light through that wall's window travel in the same direction, by the same formula.** They cannot disagree, because they are one derivation with two consumers. `feedback_unconsumed_api_rots_silently` is the memory here — `sky-access.js`'s key direction was 90°-and-mirrored wrong for its entire life under a comment claiming it agreed with the shadows, because nothing read it. **Delegate, then assert the relationship in a test.**

### 5.2 What that produces, hour by hour

| Sun elevation | `tan(el)` | Patch length (window height 110 cm ≈ 1.1 grid) | Displacement (sill 90 cm) | Reads as |
| --- | --- | --- | --- | --- |
| 75° (noon) | 3.7 | **0.3 squares** | 0.25 squares | A short bright sliver hugging the wall |
| 45° | 1.0 | 1.1 squares | 0.9 squares | A clean parallelogram on the floor |
| 15° (evening) | 0.27 | **4.1 squares** | 3.3 squares | A long dramatic streak reaching across the hall |
| → 90° (overhead) | → ∞ | → 0 | → 0 | Nothing. **Correct** — a vertical window admits almost nothing at zenith |

The last row is the emergent behaviour that proves the model: it is precisely the case V2's hand-keyframed timeline made the **brightest** (§1.3). Nobody tuned this table; it is `1/tan`.

### 5.3 Skylights fall out of the LOCKED any-item rule

`keyhole-mask-any-item-decision` (LOCKED) requires every mask to attach to **any** item — tile, level background, or level foreground — symmetrically. For windows that is not a chore; it is a feature:

- `_Window` on the **level background** = a hole in a *vertical* wall. Longest beam at low sun, nothing at noon.
- `_Window` on an **overhead tile or level foreground** = a hole in a *horizontal* roof — **a skylight.** Which behaves the *opposite* way: brightest and most nearly overhead at noon, throwing a long displaced patch at low sun, with the throw set by ceiling height rather than sill height.

Same projection, one differing input (the aperture's plane). A cathedral with clerestory windows *and* an oculus gets both, correctly, from one mechanism — and the orientation is read off **which item the mask was found beside**, not from a slider.

> This is the one place this effect must not repeat the shared narrowing `Specular.md` §9 logged for itself, water, and fluid (all three quietly dropped V2's per-tile mask case). A skylight is a tile-attached mask by nature, and it is one of the two best-looking things in the whole design. `scene/mask-authority.js#layersForItem` currently refuses anything but `'levelBackground'`; that is the work, and `mask-discovery.js`'s matchers are already item-agnostic, so it is wiring rather than redesign.

### 5.4 ⚠️ OPEN DECISION — which side of the wall is outside?

The mask says *where* the window is. It does not say *which side of it is outdoors*, and the beam's direction depends on knowing. Three candidates:

| Option | How | Fails when |
| --- | --- | --- |
| **(a)** Sample `_Outdoors`' gradient at the aperture | Zero new authoring; works for any exterior wall | An **interior** window (a window onto a courtyard, an internal light well, a window between two rooms) has outdoors on neither side, or both |
| **(b)** The aperture pack's own baked normal (§4.1) | Same information as (a), measured once instead of guessed per-pixel, and available per-aperture in the table | Same blind spot as (a), but cheaper and stabler |
| **(c)** Let the author paint it — a value ramp across the wall's thickness, bright side = outside | Unambiguous, and precedent exists (`_Fluid`'s R channel is read *both* as presence by threshold and as flow direction by value) | Costs an authoring rule, and conflicts with §2's use of value for openness |

**Recommendation: (b) as the default, (c) available as an override on the apertures that need it** — but this is a genuine fork the author should settle, because (c) changes what §2's value axis means and therefore what the painting instruction says. Flagged rather than assumed.

---

## 6. THE LADDER

Ordered by **cost class** per `Effects.md` Law 3 — not by prettiness. Monotonic upward from tier 0's admission price.

| Tier | Name | Class | Adds |
| --- | --- | --- | --- |
| **0** | `aperture` | C4 | The mask read as glass (§2) — the pane itself, lit by whichever side is brighter, on the right floor, cropped to the aperture AABB. Carries the **correctness gate** (floor + item, §7.1); never gated off. **The window reads as glass instead of as a lamp.** |
| **1** | `valve` | C3 | The two-way flow ratio from the sky handle vs. the per-aperture illum reduction (§3). Both terms additive, neither gating the other. **Night windows glow outward; day windows brighten inward; dusk does both. Fifty-six sliders deleted.** |
| **2** | `patch` | C8 | One small instanced quad per aperture, projected by §5.1's offset/length/shear. **THE HEADLINE: a shaped patch of sunlight lies on the interior floor and slides with the clock.** C8 because it is geometry — but it is a handful of bounded quads, which is exactly how it replaces a 4096² pass. |
| **3** | `gobo` | C4 | The patch samples the mask **as its own pattern**. Mullions, tracery, leading, a rose window in full colour, thrown on the flagstones. `Light-MSA-Ideas.md` §C's 🟢 recommendation, and it costs one texture read on geometry already drawn. |
| **4** | `pool` | C3 | The outward half made real: a soft ground pool outside a lit window at night, penumbra from the same distance term. **A town at night.** The thing `LightingEffectV2.js:3351` multiplied by zero. |
| **5** | `pack` | C4 | The JFA distance+normal bake (§4.1). The beam exits perpendicular to the **actual** wall (diagonal and curved walls stop guessing), the sill depth reads from the mask's own thickness, and the pane gains an inner-reveal falloff. One baked read replaces nine per-pixel taps. |
| **6** | `occlude` | C3 | The beam clipped by walls. **Interior partitions come free from `foundry/scene-wall-clip.js`** — the aperture is a light source, so it gets `ClockwiseSweepPolygon` exactly as every `AmbientLight` does. Exterior blocking (a neighbouring building shadowing the window itself) comes from the caster-height field `sun-occlusion.js` already marches. |
| **7** | `shaft` | C6 | The visible fan of light in the air between aperture and patch — the god ray. Half-res, additive, temporally accumulated (§4.4). Honest 2D fake per `Light-MSA-Ideas.md` §D. Coverage- and zoom-gated (Law 7). |
| **8** | `dispersion` | C5 | Spectral spread on the transmitted beam's **edge** — V2's prismatic instinct, applied to the light instead of to the mask. Rides tier 2's geometry. |
| **9** | `motes` | C2+C7 | Dust in the beam, through the particle engine that already exists, brightest where the shaft passes. `Light-MSA-Ideas.md` §D: *"Compute-particles (WebGPU) make this cheap."* Ticks whether seen or not → coverage- and zoom-gated. |

**Read it as a story.** Tiers 0–2 are one mask read, one buffer reduction, and a few small quads — and they buy the material, the day/night direction, and *the sunbeam on the floor*. A weak machine gets the effect's entire identity. Everything from 5 up is the expensive half, and it is the half noticed when present rather than when absent. That asymmetry is Law 3 working.

**Thirteen controls replace ninety-eight.** The 56 anchor sliders become one sun. The 9 rain-on-glass controls leave the effect. The 8 prismatic controls become one dispersion knob at tier 8. The 4 lightning and 1 cloud controls become zero, because the sky handle already answers both.

---

## 7. THE DECLARATION

### 7.1 The correctness gate — and it does not ride the ladder

Per `Effects.md`, correctness never rides the ladder. Two gates live in tier 0 and are never compiled out:

- **Floor + coverage.** `buf:scene.attr.r` is the floor index of whatever art is topmost at a pixel; `attr.r == myFloor` is the "is this window actually visible" test, and `attr.a` (solidity) handles partial transparency. Same gate `surface.response` uses, and subject to the same honest caveat: `buf:scene.attr` is written by floor **art** only, so an overlay leaves the attributes beneath it untouched.
- **The patch must land indoors.** A beam projected from an aperture must be clipped to `_Outdoors == black` on the receiving side, or a window in an exterior wall throws its patch onto the street. This is the *correct* use of the outdoors mask here — clipping the **destination**, not the source, which is where V2 put it and why the exterior half died.

### 7.2 Module layout — the established split

Mirrors `water` / `specular` / `fluid`: a pure, Node-validatable declaration; THREE **injected**, never imported, in the render siblings.

```
src/effects/window/
  window.js                 WINDOW_PARAMS + the WINDOW manifest. Pure data, no THREE.
  window-glass.js           mask RGB → (transmission, openness, presence). Pure TSL fn + CPU twin.
  window-valve.js           sky irradiance vs. interior illum → flow01, and the two additive terms. Pure + CPU twin.
  window-beam.js            aperture + sun → the patch quad transform. Pure + CPU twin. DELEGATES to
                            marchDirectionToSun / the shadow throw formula / marchPenumbraPx.
  window-apertures.js       connected components → the aperture table. Pure, CPU, at decode (fluid-net.js precedent).
  window-render.js          the TSL materials, the instanced patch quads, the MRT overrides. THREE injected.
  window-pack-subsystem.js  the JFA distance+normal bake (tier 5). Mirrors water-body-subsystem.js.
  window-registration.js    the panel; FOH/ROH split.
```

### 7.3 What changes outside the folder

1. **`scene/mask-catalog.js`** — `window` gains `rasterize: true` (one line). The aperture table needs the per-floor grid and, more importantly, its **world rect**, which is what maps `positionWorld` to a mask UV. Exactly the case the flag exists to declare, and the third kind to use it after `water` and `fluid`.
2. **`scene/mask-authority.js`** — `layersForItem` must stop refusing anything but `'levelBackground'` (§5.3). This is the LOCKED any-item work, and windows are the effect with the strongest reason to want it: **skylights are tile-attached by nature.**
3. **`graph/passes.js`** — `light.accumulate`'s note gains the window terms; its `reads` gains nothing yet (the sky arrives as a handle, as it does for specular). No new pass entry. `absorbs` already lists `WindowLightEffectV2`.
4. **Nothing in `LightingEffectV2`'s shape survives.** No emit RT, no shadow-lift RT, no `_floorEmitCache`, no blit, no `WINDOW_ILLUM_SCALE`, no two-threshold disagreement, no `outdoorsClip` timer, no per-effect tone shoulder.

### 7.4 The params, in the author's language

Thirteen against ninety-eight. Each arrives **with its consumer** — `params/no-dead-controls` fails the build on a key nothing reads, and it has already fired on exactly that during the specular build. FOH/ROH split per `feedback_foh_roh_must_differ`: FOH is critical-and-plain (would they touch it mid-session?), ROH is technical.

| Control | Category | FOH? | Tier | What it is |
| --- | --- | --- | --- | --- |
| Window light | Look | **✓** | 0 | Master strength of everything this effect draws. |
| Sunbeams | Daylight | **✓** | 2 | Strength of the patch of daylight on the floor. The headline knob. |
| Lit windows | Night | **✓** | 1 | Strength of the outward glow when the room is brighter than the sky. |
| Glass colour | Look | **✓** | 0 | How strongly the paint's own colour tints the light passing through. 0 = every window throws white light regardless of what you painted. |
| Sill height | Daylight | | 2 | How high the window sits above the floor, in grid squares. **Sets how far the beam reaches into the room** — the one geometric knob, same shape as specular's `lampHeight`. |
| Ceiling height | Daylight | | 2 | The same number for **skylights** (§5.3) — how far below the roof the floor is. |
| Beam softness | Daylight | | 2 | How fast the patch's edge blurs with distance. Sharp at the wall, soft far away, always. |
| Openness | Look | | 0 | Global thumb on how much light the painted glass lets through. |
| Beam reach limit | Daylight | | 2 | Clamps the low-sun stretch before a 5° sun throws a patch across the whole map. |
| Shaft strength | Atmosphere | | 7 | The visible fan of light in the air. |
| Shaft reach | Atmosphere | | 7 | How far the fan carries before it fades. |
| Dispersion | Atmosphere | | 8 | Spectral fringing at the beam's edge. |
| Motes | Atmosphere | | 9 | Density of dust floating in the beam. |

---

## 8. THE TRAPS — named up front, from the ledger

| Trap | Where it bites here |
| --- | --- |
| `feedback_measure_the_output_not_the_equation` | **The one that has already cost this project twice** (water's flat wash, specular's 0.016 — and specular shipped invisible *twice*). Twin the **composition**, not the formula: assert brightness **bands** for pane / patch / pool at noon, dusk, midnight, and — the assertion no static test would think to make — **assert the patch MOVES**: monotonic displacement vs. sun elevation, and antiparallel to nothing but its own wall's shadow. A beautiful still frame is exactly the output that hides a beam that never travels. |
| `feedback_environment_term_gates_wrong_thing` | §3's two flow terms. Both additive, always both computed, `flow01` is a mix weight and never an `if`. This is the shape that zeroed specular's whole indoor branch. |
| `feedback_one_byte_two_quantities` | §2: openness (value) and tint (hue/sat) stay separate numbers. Presence is a threshold at the bottom of value, not a product with it. |
| `feedback_y_flip_recurring_risk` | **Three new mappings**, and one of them is the dangerous kind: world→mask UV, world→aperture-pack UV, and **the beam projection itself**. A Y-flipped beam does not look broken — it looks like a plausible sunbeam pointing the wrong way, which nobody catches from a screenshot. Assert against the sun shadow's own throw: same sun, same direction, one derivation. |
| `feedback_unconsumed_api_rots_silently` | §5.1 delegates the throw, the direction and the penumbra rather than re-deriving them — and then a test asserts the relationship, because prose claiming two derivations agree is not a mechanism. `sky-access.js`'s `dirX` was wrong for its whole life under exactly such a comment. |
| `keyhole-mask-any-item-decision` (LOCKED) | §5.3. Do not repeat the levelBackground-only narrowing that water, fluid **and** specular all shipped. A skylight is a tile mask. |
| `feedback_sdf_does_not_draw_the_edge` | Silhouette from `vt/mask-image.js` at full res; distance from the SDF. Never the reverse. |
| `feedback_blend_neutral_element_is_per_blend` | If dirty glass ever **multiplies** (darkening what shows through it), that mesh must write `attr = vec4(1)`, not `vec4(0)`. White is multiply's identity; black is add's. Water shipped this wrong once. |
| `feedback_doubleside_invisible_to_status_reports` | Every patch quad needs `side: DoubleSide` or it culls silently while every JS field reports healthy. |
| `keyhole-tsl-constructs-in-node` | **Call the builders in the Node suite.** A TDZ crash shipped with 4,460 green assertions because nothing ever invoked the builder. `three.webgpu.js` imports under plain Node; there is no excuse. |
| `reference_tsl_method_chaining_trap` | `a.mix(b, t)` compiles to `mix(b, t, a)` **silently**. Function form only. §3's valve is nothing but mixes. |
| `reference_tsl_fn_deferred_execution_trap` | `Fn(cb)()` is deferred; a closure var set inside is unset on the next line. Use `TSL.output`. |
| `keyhole-storage-buffer-limit-fix` | WebGPU caps 8 storage buffers per stage and this project has hit it. The aperture table is one small buffer, and must be able to be a `DataTexture` instead. |
| Law 4 | Tiers are JS `if`s at graph-build time. A `uniform(0)` is not off. |
| Law 6 | Bounded quads per aperture. V2's 4096² emit target **is** the violation this design exists to delete. |
| Law 5 | Nothing above tier 0 may require WebGPU. Both routes for §4.2 work on both backends; that is not an accident, it is the constraint. |

---

## 9. WHAT THIS DELIBERATELY DOES NOT DO

- **No new mask.** `_Window` supplies the aperture, the colour, and the gobo pattern. Three jobs, one file the author already paints.
- **No second light system.** The window **is** a light, inside `light.accumulate`, MAX/ADD-ing into `buf:scene.illum` alongside the point lights. It never enumerates lights, never builds its own shadow system, and gets wall clipping, coloration, bloom and the grade for free.
- **No per-effect tonemap and no per-effect grade.** V2's `emit / (1 + emit × 0.14)` shoulder and its 8-anchor exposure/saturation/tint stack both go. One sun, one grade — and the compensator this refunds is the same shape `sky-access.js`'s header describes for the ToD override.
- **No rain-on-glass.** Nine controls, and it belongs to `surface.response` (a wet clear coat) or to the particle engine. Warping the aperture mask moves the hole.
- **No `_Specular` read.** Cross-effect mask reach with no declared edge; four samplers deleted.
- **No screen-space emit target.** The 4096² RGBA16F buffer is **deleted**, not resized. Its resolution-scale and half-float escape hatches go with it.
- **No real volumetrics.** Tier 7's shaft is a 2D fake and says so (`Light-MSA-Ideas.md` §D). There is no third axis to march.
- **No decision on the `_Window` VT pack format.** Tier 0 reads the hi-res mask image (water's and specular's route). Whether it also becomes a VT layer is the Stage 4 mask-audit question; nothing above depends on the answer.

---

_V2 painted the pane bright because a hole is invisible. Model the hole and the light comes through it._
