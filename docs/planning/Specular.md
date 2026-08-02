# SHINE — the specular and reflection system (`surface.response`)

**Status:** DESIGN SPEC + **TIERS 0-3 BUILT** (2026-07-26). Authored from a direct read of `legacy/compositor-v2/effects/specular-shader.js` (780 lines) + `SpecularEffectV2.js` (2,840 lines) + the harvested control schema (`docs/reference/v2-effect-params/specular-effect.md`, 61 controls). `surface.response` is now `live` in `src/graph/passes.js`; its `NotBuiltError` door is deleted. Rungs 4-8 (§6) remain designed and unbuilt. **Tiers 0-2 shipped INVISIBLE and were corrected against measurement — see §10.** **Not yet live-verified in a browser** — the Node suite proves the material decode (73 assertions, `specular-material.test.mjs`), but the TSL transcription has never been compiled on a GPU.
**Owns:** the pass `surface.response` in `src/graph/passes.js` — which absorbs `SpecularEffectV2`, `IridescenceEffectV2`, `PrismEffectV2`, `RoughnessEffectV2`, `NormalEffectV2`.
**Companion:** `Effects.md` (the tier ladder — how much it may spend) · `Effects-API.md` §5 (the contract — what it may touch) · `Water.md` (the port pattern this follows, including its four hard-won corrections).
**Author directive, 2026-07-26:** _"a normal map seems like a natural addition but it's not currently something I want to do… the best possible 'top down birds eye view' of shiny metallic surfaces without adding more masks/textures that have to be created. Distinguish from indoors and outdoors metallic surfaces."_

---

## 0. The thesis, in one paragraph

V2's `_Specular` mask is an **RGB** file, and V2 read **one number** out of it — a luminance — plus a hue it used as a tint. Everything that made the effect look alive came from procedural noise laid on top. That was not laziness; it was forced, and §1.2 proves why. This design does three things instead: **read all three channels as a material** (§2), **synthesise the one quantity a top-down orthographic camera destroys** (§3), and stop treating indoors/outdoors as a blend slider — because looking straight up outdoors shows you the sky and looking straight up indoors shows you a ceiling nobody rendered, and those are not the same problem with a different weight (§4).

No new mask. No normal map. The `_Specular` file the author already paints, read properly.

---

## 1. THE AUTOPSY — what V2 actually computed

### 1.1 The whole shader, distilled

780 lines of GLSL reduce to this:

```
specular = maskColour(maskRGB, luma(maskRGB), saturation)
         × (1 + shimmer + cloudLit + sparkle)      // the modulator
         × intensity × tint
         × (ambientTint·lightLevel + Σ lightDiscs)  // "incident light"
         × buildingShadow
         + wetLayer + frostLayer
```

Blended **additively** onto the tile it overlays, one overlay mesh per masked tile. `shimmer` is three layers of anisotropic Gaussian blobs on a hashed lattice, blended (add/multiply/screen/overlay), multiplied by a 3-octave voronoi×value FBM. `Σ lightDiscs` is a per-light XY radial falloff — a **distance** test, with no direction in it anywhere.

### 1.2 Why it could not have been anything else

Search `specular-shader.js` for a surface normal. There isn't one. Search for a view vector. There isn't one. This is not an omission — it is a consequence, and the consequence is worth stating precisely because it governs the whole redesign:

> **The camera is `THREE.OrthographicCamera` (verified: `vt-pan-viewer.js:4908`). The map is flat. So the view vector V is constant across every pixel, and the normal N is constant across every pixel. For any light direction L, the half-vector H = normalize(L+V) is therefore also constant, and N·H — the entire angular content of every specular BRDF ever written — is a single number for the whole screen.**

A specular highlight is, by construction, _the place where the angles line up_. Flatten the geometry and remove the perspective and there is no "where" left: either the whole surface highlights or none of it does. V2 could compute `mask × light` and nothing more.

**So the shimmer was not decoration. The shimmer WAS the missing normal** — a procedural stand-in for the angular variation the setup had deleted. Once you see that, the 30 shimmer controls stop looking like over-engineering and start looking like someone building a normal map out of noise, by hand, in a shader, with sliders.

### 1.3 What the mask actually supplied — measured

| What the file carries | What V2 did with it                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| R, G, B               | `luma = dot(rgb, 0.299/0.587/0.114)` → **one scalar**: "how strong"                                            |
| R, G, B (again)       | `applySpecularMaskColor` → renormalised to that luma and **lerped toward white** by a global saturation slider |
| A                     | a fallback-to-opaque presence hack (`if (a < 1e-4) return lum;`)                                               |

Three channels in, **one degree of freedom out**, plus a hue that only ever multiplied the final colour. Two thirds of the authored signal was discarded.

And every material property that would have made the shine _specific_ was a **global uniform**: one grain angle for the whole map (3 of them, `stripe1/2/3Angle`), one cluster density, one elongation. A brass candlestick and a steel portcullis on the same map get the same brushed-metal direction, because the direction is a slider, not a property of the thing.

### 1.4 What is worth harvesting

Not much of the code. A lot of the _intent_:

- **The look targets are right.** Brushed anisotropy, micro-glints, wet sheen, frost glaze, cloud response, per-light tinting — that is the correct inventory of what makes metal read as metal. Keep all of it. Rebuild none of it the same way.
- **`worldPatternScale` was the right instinct** (patterns in world space, not screen space) and it is the reason V2's shimmer didn't swim when you panned. Keep the principle; §3.5 keeps it _and_ fixes the zoom aliasing it still had.
- **The `_Outdoors` gate already existed** (`outdoorStripeBlend`, `wetSpecular` outdoor-only). The instinct was correct and the mechanism was a lerp weight. §4 keeps the instinct and throws away the lerp.
- **`playerLightSpecularBoost`** — the observation that the torch you are _carrying_ should glint differently than an ambient lamp. Genuinely good. Survives as a property of the light, not a special case.
- **`dynamicLightTint`** — highlights taking the colour of the nearest lamp. Correct, and in V3 it is free: `buf:scene.coloration` already _is_ that field.

---

## 2. THE REFRAME — the mask is a MATERIAL, not a tint

### 2.1 One file, three channels, three material properties

Decompose the mask's linear RGB into HSV and assign each axis a physical meaning:

| Axis of the painted colour | Reads as                        | Because                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hue**                    | **F0 — the reflectance colour** | This is _literally_ what F0 is for a metal. Gold reflects gold (F0 ≈ 1.00/0.77/0.34), copper reflects copper. The author paints gold; the highlight is gold.                                                                             |
| **Saturation**             | ~~Metalness~~ → part of F0      | ⚠️ **This row was WRONG and it is what made the first build invisible — see §10.1.** Saturation carries WHICH metal, never WHETHER it is one: steel, iron, pewter, silver and chrome are all grey. Metalness is now a scene-level param. |
| **Value**                  | **Smoothness**                  | Brighter paint = more polished = tighter lobe. Dark grey = rough dark iron. Near-white = chrome. `roughness = 1 − value`, `α = roughness²`.                                                                                              |
| **Value near zero**        | **Presence**                    | The bottom of the range is the "is anything painted here at all" threshold, antialiased from the file's own edge exactly as `water-render.js` does it (`WATER_PRESENCE_EDGE0/1`).                                                        |

Concretely:

```
v      = max(m.r, m.g, m.b)
p      = smoothstep(EDGE0, EDGE1, v)           // presence, antialiased
rough  = clamp(1 − v, MIN_ROUGH, 1)
metal  = metalResponse × v                     // a SCENE param, scaled by value (§10.2)
F0     = mix(vec3(0.04), srgbToLinear(m / v), metal)
```

Presence and smoothness both key off value and **do not conflict**: presence is a threshold at the very bottom (`v > ~2/255`), smoothness uses the whole range. A pixel painted 8% grey is "present, very rough dark metal", which is the right answer.

### 2.2 It is backwards compatible BY CONSTRUCTION, and that is not a coincidence

A V2 mask painted the way V2 masks are painted — greyscale, mid-to-bright — decomposes to `metal ≈ 0`, `F0 ≈ 0.04 white`, `rough ≈ 0.4`. That is a modest, broad, neutral dielectric sheen: **almost exactly what V2 drew.** A mask painted gold, which V2 would have rendered as a yellow-tinted glow, now renders as gold _metal_.

The compatibility is not luck. V2's mask hue already multiplied the highlight, and a metal's F0 _is_ the colour of its highlight — so the hue axis means the same thing in both systems. The two new axes (saturation, value) were free channels V2 collapsed. Nothing is being reinterpreted against its old meaning; two thirds of the signal is being un-discarded.

### 2.3 The authoring story — the part that matters commercially

> An author paints a gold coin **gold**, a steel blade **steel-blue-grey**, a copper roof **copper**, a polished marble floor **pale grey**, a rusted hinge **dark brown-grey**. They get gold, steel, copper, marble and rust.

That is the whole authoring instruction. It is what a person would do _anyway_ if handed a layer called `_Specular` and told to paint the shiny bits. Compare V2's authoring instruction, which was "paint greyscale intensity, then set 30 global sliders to describe what kind of metal the whole map is made of."

This matters for `keyhole-authoring-and-distribution`: the Map Points successor paints into the mask authority, and a painting model where **the colour you pick is the material you get** needs no tutorial, no swatch chart, and no numeric panel.

### 2.4 ⚠️ SHINE IS TWO BLENDS, NOT ONE ADD — the water lesson, applied before it costs us

`keyhole-water-tsl-design` records this correction at the cost of three rejected builds: _"water is a MULTIPLY pass + an ADD pass, never one alpha."_ The same physics applies here and the same mistake is available.

**A metal has almost no diffuse albedo.** Real gold does not have a yellow diffuse surface _plus_ a gold highlight — it has a gold reflection and essentially nothing else. V2 could only ever ADD, because it was an overlay mesh drawn on top of a tile it had no way to modify. `surface.response` declares `modifies: ['buf:scene.color']`, so it can do the correct thing:

```
MESH 1  multiply   dst × (1 − metal · p · METAL_DIFFUSE_KILL)   Zero / SrcColor
MESH 2  add        + skyOrLampReflection + specularLobes         One / One
```

The diffuse knock-down is **gated on `metal`**, which is what keeps §2.2's compatibility true: a desaturated V2-style mask has `metal ≈ 0` and therefore suppresses nothing, behaving exactly like V2's pure add. Only a deliberately-coloured metal mask replaces the art beneath it — which is what a deliberately-coloured metal mask _means_.

> ⚠️ **The multiply pass must override its `attr` MRT output to `vec4(1)`.** `vt/scene-attr.js`'s renderer-global default writes `attr = vec4(0)`, which is the do-not-touch value **for NormalBlending only**. Blend state is not per-attachment on WebGL2, so a multiply pass applies `dst × src` to attachment 1 too, and `attr × 0` silently zeroes the floor attributes under every metal pixel. This is `feedback_blend_neutral_element_is_per_blend`, and water shipped it wrong once already. The neutral element is a property of the blend: white for multiply, black for add.

---

## 3. WHERE THE VARIATION COMES FROM — five sources, no new authoring

§1.2 established that a flat map under an orthographic camera has zero angular variation. Each subsection below manufactures some, from data that already exists.

### 3.1 The synthesised view vector — and yes, it is synthesised

The camera is orthographic. There is no view variation to recover; there is only view variation to **invent**, and the honest thing is to say so and then argue that inventing it is correct.

Treat the camera as sitting at a finite height `H` above the centre of the current view rect:

```
eye     = vec3(viewCentre.xy, H)
V       = normalize(eye − vec3(positionWorld.xy, 0))
```

> ⚠️ **`H` is a MULTIPLE of the visible width, not a length in world px — and that correction was found while building.** With an absolute height the angular spread across the view is `atan((visibleWidth/2) / H)`, so zooming _in_ drives it to zero: the highlight would sweep convincingly on a whole-map overview and go completely static the moment anyone zoomed in on the metal, which is exactly when they are looking at it. Nothing about that reads as a bug on screen — it reads as "subtle at this zoom". Scaling by the visible width fixes the _field of view_ instead of the altitude, which is what a real camera does, and the sweep is then present at every zoom.

Large `H` → V approaches straight down everywhere → the flat behaviour of §1.2 → the effect degrades gracefully to V2's look. Small `H` → V slants increasingly toward the screen edges. Default 1.5 puts the screen edge ~18° off-axis.

**Why this is right rather than a cheat:** the reason a real miniature's shield glints as you lean over a table is exactly this — your eye is a metre above a half-metre map, not at infinity. A VTT presents a top-down view of a physical-feeling space, and the physically-honest model of a person looking at that space is a finite eye height. Rendering it orthographically is the compromise; restoring a plausible eye position _inside the shading_ recovers what the projection threw away.

**What it buys, and this is the single biggest item in the document:** when the author pans, `viewCentre` moves, so V changes, so `N·H` changes, so **the highlight sweeps across the metal.** A sheet of polished marble develops a broad bright band that slides as you scroll. Nothing in V2 could produce that, and it is the most convincing "this is a real surface, not a decal" cue available in a top-down view. It costs one uniform and about six ALU ops (C1).

Two guards, both learned from V2's `parallaxStrength`: the motion must be **damped** (a highlight that swims faster than the map reads as a bug), and it must be **zero at strength zero** so the whole rung compiles out per Effects.md Law 4.

### 3.2 Fresnel — top-down's dirty secret, and why it works in our favour

Schlick: `F = F0 + (1 − F0)·(1 − N·V)⁵`. Looking straight down, `N·V = 1`, so `F = F0` — the **minimum**. Every reflection is at its weakest exactly where a top-down camera looks.

That sounds like bad news and is mostly not, but the first draft of this section over-claimed and the correction is worth keeping:

1. **It gives the dielectric/metal split its punch for free**, and this is the big one. At normal incidence a dielectric reflects ~4% and a metal reflects 60–100%. So under identical lighting, `metal ≈ 0` paint produces a whisper and `metal ≈ 1` paint produces a blaze — from the same shader, with no branch, purely because the author picked a saturated colour.
2. ⚠️ **The "edge-of-screen Fresnel sheen" is NOT where the motion comes from.** This section originally claimed the `N·V` falloff toward the screen edges would give "a gradient across a large polished floor… for one `pow(1−x, 5)`". Run the numbers at a plausible eye height (§3.1's default puts the edge ~18° off-axis, `N·V ≈ 0.95`) and Schlick's fifth power turns that into a change of order `10⁻⁶`. Invisible. Fresnel really is flat for a top-down shot, and no eye height anyone would tolerate changes that.
   **What actually sweeps is the GGX lobe**, and it sweeps hard: over the same 18° the half-vector's `N·H` moves ~0.06, and because the lobe is _sharp_, a small change in `N·H` is a large change in brightness. The motion is a highlight _band_ crossing the metal, not a rim of sheen at the screen edge. The mechanism in §3.1 is unchanged and correct; only this paragraph's account of which term carries it was wrong.

### 3.3 The albedo IS the height field

The map art is a painting of a lit three-dimensional scene. The artist has _already_ painted the highlights and shadows of every cobble, plank, rivet and fold. The luminance gradient of the albedo is therefore an extremely good proxy for surface slope — better, on hand-painted art, than a generated normal map would be, because it is the relief the artist intended rather than the relief an algorithm inferred.

```
g       = vec2(dFdx(luma(albedo)), dFdy(luma(albedo)))   // screen space
gWorld  = g / worldPxPerScreenPx                          // ⚠️ zoom-invariance
N       = normalize(vec3(−gWorld · reliefStrength, 1))
```

`dFdx` / `dFdy` / `fwidth` are all present in the vendored TSL build (verified). The division by `worldPxPerScreenPx` is load-bearing and is this repo's named recurring hazard in a new costume: without it, zooming in makes every surface flatter, because the same world feature spans more screen pixels and the per-pixel derivative shrinks.

A better-quality variant, and the reason to look at WebGPU: `texture(albedo, uv).gather(c)` returns a 2×2 neighbourhood in **one** instruction, native on WebGPU and emulated (`tsl_textureGather`) on WebGL2 — verified present at `three.webgpu.js:37471` and `:63424`. That gives a proper Sobel-ish gradient at fixed _world_ offsets, immune to screen-space derivative quantisation, for roughly the cost of one extra fetch instead of four.

> This is not a normal map and does not become one. It is a **relief cue derived from art that already exists** — the author's directive is "don't make me author another texture", and this authors nothing.

### 3.4 The specular SDF — grain that runs along the shape

`effects/water/water-body-subsystem.js` already bakes a jump-flood signed-distance pack from a mask on mask-version change, storing signed distance in R and the boundary **tangent** in BA. Run the identical machinery on `_Specular`.

The tangent of a mask boundary runs **along** the shape it bounds. For every long thin metal thing — a blade, a rail, a pipe, a hinge, a strip of trim, a chain — that is exactly the brushed-metal grain direction. So:

- **Anisotropy direction** = the SDF tangent. Per-pixel, per-object, correct. This is the single fix for §1.3's "one grain angle for the whole map".
- **The bevel** = a bright rim within `bevelPx` of the boundary. A real metal object's edge is chamfered or rounded, so it catches light at a completely different angle from its face. A thin bright line tracing the silhouette of every metal object is, empirically, the cheapest thing that makes flat art read as forged.
- **Polish gradient** = distance-driven wear: edges brighter than centres, or the reverse, one signed knob.

> ⚠️ **The SDF does not draw the edge.** `feedback_sdf_does_not_draw_the_edge` cost four rounds on water: a coarse point-sampled field has no sub-texel information and can never yield a smooth silhouette. **Silhouette from the mask file at real resolution; distance from the SDF.** The bevel is a _low-frequency band_ measured from the edge, which is exactly what a coarse SDF is good at — but the edge itself comes from `vt/mask-image.js`.

Apply the same **projection** correction water needed: `mix(current, t·dot(current, t), influence)`, because a tangent's sign flips across the medial axis and a raw tangent would seam a blade down its centreline.

### 3.5 The pixel footprint — glint that survives zoom

V2's sparkle is `hash(cell) × max(0, sin(t·speed + phase) − 0.8)` over a fixed world-space lattice. Zoom out and that lattice goes sub-pixel; the result is not "smaller sparkles", it is **aliasing** — a crawling boil of noise, the classic failure of every sparkle shader.

The principled fix is to model the _number of microfacets in the pixel footprint_ rather than a pattern:

```
fw    = max(fwidth(positionWorld.x), fwidth(positionWorld.y))  // world px per screen px
n     = (fw / facetSizePx)²                                     // facets in this pixel
```

- `n < 1` — zoomed in past a single facet. One hashed facet orientation, sharp lobe, discrete twinkle. Real sparkle.
- `n ≫ 1` — many facets. Their orientations average out; the correct output is a **smooth lobe with widened roughness**, not a flicker.
- Between: blend on `log(n)`.

The general form of the widening is Kaplanyan-style normal-variance filtering — `α'² = α² + 2σ²`, with `σ²` the normal variance over the footprint, obtainable from `fwidth(N)` once §3.3 supplies an N. This is also the fix for specular aliasing on the relief normal, so the two rungs share one mechanism.

**The result is a single phenomenon that resolves differently at different zooms instead of two effects fighting.** Zoom in on a mail hauberk and see individual links catch the light; zoom out and see a smooth metallic sheen. That is what actually happens when you lean over a table, and it is what V2's fixed-frequency lattice could not do at any setting.

---

## 4. INDOORS AND OUTDOORS ARE NOT A SLIDER

V2's answer was `outdoorStripeBlend` — a 0..1 lerp between "shimmer" and "shimmer, slightly less". This section argues that they are two genuinely different physical situations that share a shader and almost nothing else.

### 4.1 The question that settles it: _what is straight up?_

For a flat surface viewed from above, the reflection vector points **up**. So "what does this surface reflect" is answered entirely by "what is above it".

- **Outdoors, above you is the sky.** We have it, described analytically, already built: `effects/sky-access.js` gives a dome colour (`fill.colorRgb`), a sun colour and direction (`key.colorRgb`, `key.dirX/dirY`, `elevationDeg`) and their relative strengths, all derived from the one sun (`world/sun.js`) and the weather. That is a **complete environment** for a horizontal surface, for free, with no environment map, no cubemap, no probe.
- **Indoors, above you is a ceiling that this renderer does not draw.** There is no environment. There is nothing to reflect _except the light sources themselves._

That is the whole distinction, and everything else follows from it.

### 4.2 Outdoors — two analytic lobes

**The dome** is one enormous area source covering the entire upper hemisphere. For a near-horizontal surface, the split-sum approximation collapses to almost nothing:

```
sky = fill.colorRgb × fill.strength × F_schlick(F0, N·V) × visibility
```

Roughness barely enters, because a uniform source has no structure for roughness to blur — which is _exactly_ why an overcast day makes every polished thing look flat and matte. That is a real observation falling out of the model rather than being tuned in. When `cloudCover01` is low, `sky-access.js` reports a strongly key/fill-split sky, and the dome term gains a directional gradient brightening toward the sun's azimuth — which restores roughness dependence on a clear day, for one `dot`.

**The sun** is a small, intensely bright disc with a **known** direction:

```
L   = normalize(vec3(key.dirX·cos(el), key.dirY·cos(el), sin(el)))   // the sky handle, lifted to 3D
sun = GGX(N, V, L, α) × key.colorRgb × key.strength × sunVisibility
```

> ⚠️ **THE FIRST DRAFT OF THIS FORMULA WAS `vec3(cos(az)·cos(el), sin(az)·cos(el), sin(el))`, AND THAT WAS WRONG — the bug was in `sky-access.js` and this doc copied it.**
>
> `effects/sky-access.js` published `key.dirX = cos(az)`, `key.dirY = sin(az)`, with a comment claiming it was "derived from the SAME azimuth the shadow handle throws shadows along, so a highlight can never point away from its own shadow." The live, Node-tested, on-screen-verified convention is `shadowOffsetDirection(az) = (−sin az, cos az)` — Foundry's compass convention, clockwise from up. **The two differ by a 90° rotation AND a reflection**, so every highlight would have sat roughly perpendicular to the shadow cast by the same sun.
>
> It had never rendered wrong because it had never had a consumer: `grep dirX` across `src/` found the declaration, one finiteness assertion, and nothing else. The sun glint is the first, which is how it surfaced. `sky-access.js` now delegates to `marchDirectionToSun`, so the claim is true by construction, and `__tests__/sky-access.test.mjs` asserts the key direction is exactly antiparallel to the shadow throw at every azimuth — the mechanism the comment was standing in for.
>
> This is `env/one-sun`'s thesis arriving on schedule: a term derived twice is N−1 needless chances to disagree, and **prose asserting that two derivations agree is not a mechanism.**

`sunVisibility` is `res:vis` / the sun-occlusion field that `effects/lighting/sun-occlusion.js` already marches — so a metal roof-finial in a building's shadow correctly stops glinting, and this pass does not get its own shadow system. Not wired at tiers 0-2; it is part of rung 4 (`context`).

**What this looks like:** a broad even sheen everywhere metal is exposed, plus **one hard glint** whose position sweeps across the map as the day advances, elongating into a long streak near sunrise and sunset because a low sun makes the half-vector graze. Golden hour on a copper roof. That is a time-of-day effect V2 structurally could not have.

### 4.3 Indoors — ∇illum points at the lamp

The problem: lights in this renderer are **per-light meshes MAX-blended into `buf:scene.illum`** (`effects/lighting/point-light-pool.js` — each light gets its own fan-triangulated wall-clipped polygon and its own draw). There is no global uniform array of lights an arbitrary surface shader can loop over, and building one would duplicate the light system.

The solution needs no light list at all:

> **The gradient of the illumination buffer points at the light.**

For a point source at **p**, illumination is `I·f(r)` with `f` decreasing, so `∇illum = I·f′(r)·(x−p)/r`, and `f′ < 0` — the gradient points **from the fragment toward the source**. One buffer already in the graph, already declared as a read, gives a per-pixel light direction for whichever source dominates here.

```
gI   = worldGradient(illum)                    // 4 taps at ±ε world px, or one gather
L    = normalize(vec3(normalize(gI) · 1, lampHeightPx / distanceScale))
lamp = GGX(N, V, L, α) × coloration.rgb × illum.rgb
```

Everything about this behaves correctly at the edges, which is how you know it is the right mechanism and not a trick:

| Situation                                    | ∇illum              | Result                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Directly under a lamp (flat bright core)     | ≈ 0                 | L points straight up → highlight overhead. **Correct** — the lamp _is_ overhead.                                                                                                                                                                                                                                         |
| Off to one side of a lamp                    | points at it        | Highlight leans toward the lamp. **Correct.**                                                                                                                                                                                                                                                                            |
| Between two lamps                            | gradient of the MAX | Cleanly picks the dominant one, no mush. **Correct**, and a consequence of the pass being MAX-blended.                                                                                                                                                                                                                   |
| Uniform ambient / global illumination only   | 0                   | No directional highlight, just a flat Fresnel sheen. **Correct — and, until 2026-07-26, only STATED, never BUILT.** The implementation shipped with only the directional lobe below, gated on ‖∇illum‖; this row's own "flat sheen" was never wired in, so this exact case measured to literal 0. §10.8 has the account. |
| Steep gradient (small, close, bright source) | large ‖∇‖           | Use ‖∇‖ to tighten the lobe: near sources make sharper glints. **Correct.**                                                                                                                                                                                                                                              |

`lampHeightPx` is one intuitive param: low = grazing, dramatic streaks across a flagstone hall; high = tight pools directly under each sconce.

**Two honest caveats.** (a) `buf:scene.illum` has hard boundaries at wall-clipped polygon edges and at darkness-region borders; a raw derivative spikes there. Sample at a fixed ±ε _world_ offset and clamp ‖∇‖ rather than using `dFdx` directly. (b) This reads screen-space, so ε must be converted through `worldPxPerScreenPx` like everything else in §3.

### 4.4 The signature — what a player actually sees

|                     | **Outdoors**                                                                               | **Indoors**                                          |
| ------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Environment         | the sky dome — one vast source                                                             | none; the ceiling is not rendered                    |
| Base look           | broad, even, low-contrast sheen everywhere                                                 | **dark between the lamps**                           |
| Highlights          | **one** sharp sun glint, position set by time of day                                       | **several** glints, one per nearby lamp              |
| Highlight colour    | the sun's own warm/cool ramp; blue-shifted dome fill                                       | each lamp's own colour, from `buf:scene.coloration`  |
| Highlight motion    | sweeps with the **clock**                                                                  | moves with the **token / the lamp**                  |
| Effect of roughness | little on the dome; a lot on the sun glint                                                 | a lot — a rough floor smears each lamp into a streak |
| Overcast / no lamps | everything goes matte and flat                                                             | everything goes dark                                 |
| Wet (rain)          | mirror-smooth clear coat reflecting the sky — **this is why wet pavement looks blue-grey** | not applicable; rain is outdoors                     |

The lever is `buf:scene.attr.g` — per-pixel outdoors, already written by every real floor writer, a C3 read, no new mask, no new plumbing. The two branches are **mixed** by it rather than switched, so a covered porch transitions smoothly.

### 4.5 The correctness gate — and it does not ride the ladder

Water gets cross-floor occlusion free from the painter's algorithm, because it draws inside `geometry.world`. **This pass cannot**: it reads `buf:scene.illum`, which does not exist until `light.accumulate` has run, so `surface.response` is genuinely a pass in the `surface` stage and not a drawable. That makes it the first one in the renderer that is.

So it needs an explicit gate, and `buf:scene.attr` already carries it: `attr.r` is the floor index of whatever art is topmost at that pixel. `attr.r == myFloor` is the "which FLOOR is visible here" test — a genuinely different floor's roof (a different Level, a different R value) correctly overwrites it. `attr.a` (solidity) handles the partially-transparent case.

⚠️ **`attr.r` alone does NOT catch a same-floor Tile drawn over this Level's own background** — both share ONE floor index, so R cannot tell them apart (found live, 2026-07-29, reported as "the background's shine leaks through tiles above it"). Fixed with a second signal, `attr.b`'s TOP BIT (`PRESENCE_BIT_BACKGROUND_ART`, `vt/scene-attr.js`) — 1 only while the Level's own background image is still the topmost opaque draw, 0 the instant a Tile or this SAME Level's own foreground/roof paints over it. The real gate is `attr.r == myFloor && attr.b`'s top bit, not R alone.

⚠️ **This bit shipped at a LOW weight first (bit 2, weight 4) and went completely invisible, immediately, the same day** — `buildWholeImageMaterial`'s attr write is NormalBlending, not a hard overwrite, scaled by the background's OWN alpha (`≈1`, per this section's own R/A description — "almost", never guaranteed exact). R and G had never actually tested this because their correct values on an ordinary scene are both 0, alpha-scaling-invariant; this was the first non-zero value ever pushed through the write, and a tight margin (needing ≥87.5% of its strength to survive) failed on an alpha deficiency too small to see. Moved to the TOP bit (weight 128, decode threshold 64/255) for a much wider margin — see `keyhole-specular-built` memory, ROUND 11 and ROUND 12, for the full account.

⚠️⚠️ **AND THEN THE POLARITY WAS INVERTED, 2026-08-01 — §11 has the full account, and it supersedes the paragraph above on the one point that matters.** The bit now means **"something is COVERING the background here"** (`PRESENCE_BIT_OCCLUDES_BACKGROUND`, set by Tiles and by the Level's own foreground/roof, _not_ by the background), and the gate is `1 − step(threshold, attr.b)`. The reason is structural rather than cosmetic: `buf:scene.attr` clears to `(0,0,0,0)`, so under the old polarity **"a Tile is on top of me" and "nothing ever wrote attr here" were byte-identical, and both switched the entire effect off.** Any upstream failure at all — an unwired `mrtNode`, an unbound attachment, an art path nobody remembered — silently deleted the pass, with every JS status field reporting healthy. Inverted, an unwritten buffer reads "not occluded" and the effect draws; the residual α-attenuation hazard survives but changes sign, so the worst case is shine leaking through a faint tile (local, visible, cosmetic) instead of the pass vanishing (global, silent, indistinguishable from a dead shader). The wide margin is kept regardless.

Per Effects.md, **correctness never rides the ladder**: this gate lives in tier 0 and is never gated off, exactly as water's cross-floor borrow rule does.

**Law 6 compliance:** the pass draws **bounded geometry cropped to the specular mask's AABB per floor**, not a fullscreen quad. Metal covers 2–5% of a typical map; a fullscreen pass would be an O(screen) violation in a disguise.

---

## 5. WHAT WEBGPU AND MODERN THREE ACTUALLY BUY — verified, not assumed

Every row below was checked against the vendored `src/vendor/three/three.webgpu.js`, because the point of this section is to be useful rather than aspirational.

| Capability                                                              | Status                                                                                                           | What it is worth here                                                                                                                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `texture(t, uv).gather(c)`                                              | **Present**, `:37471`; native WGSL `textureGather` on WebGPU, `tsl_textureGather` emulation on WebGL2 (`:63424`) | 2×2 neighbourhood in one instruction — the albedo-gradient normal (§3.3) and the illum gradient (§4.3) at ~¼ the fetch cost                                                          |
| `dFdx` / `dFdy` / `fwidth`                                              | **Present**, TSL exports                                                                                         | The footprint-aware glint and roughness widening (§3.5); the cheap variant of the relief normal                                                                                      |
| TSL compute (`renderer.compute()`)                                      | **Present and in production** — `water-body-subsystem.js` already jump-floods a mask this way                    | The `_Specular` SDF + tangent bake (§3.4), as a precompute on mask-version change, not a per-frame cost                                                                              |
| `mx_fractal_noise_vec3`, `mx_worley_noise_float`, `mx_cell_noise_float` | **Present**                                                                                                      | Backend-identical procedural microstructure — no hand-rolled hash, no WebGL2 twin (Law 8)                                                                                            |
| MRT via `material.mrtNode`                                              | **Present and in production** (`vt/scene-attr.js`)                                                               | The two-blend composite of §2.4 without clobbering `buf:scene.attr`                                                                                                                  |
| Mip chain on a render target + roughness-indexed LOD                    | Available                                                                                                        | Rough reflections of the actual scene (§6, tier 8)                                                                                                                                   |
| `reflect`, `refract`, `faceForward`, `luminance`                        | **Present** as TSL exports                                                                                       | The BRDF plumbing, without hand-writing it                                                                                                                                           |
| Storage buffers                                                         | Available, **budget-constrained**                                                                                | ⚠️ `keyhole-storage-buffer-limit-fix`: WebGPU caps 8 per stage and this project has already hit it. This design deliberately needs **none** — every input is a texture or a uniform. |

**The one that is nearly free and worth calling out:** `post.bloom` already builds a dual-filter bright-pass pyramid from `buf:scene.color`. A roughness-indexed reflection needs precisely a multi-scale blur of the scene — and because it is a _bright-pass_ pyramid, it contains exactly what a dark polished floor actually reflects (torches, fire, windows, glowing things) and none of what it does not. That is a genuine coincidence in our favour.

The catch, stated rather than buried: `post.bloom` runs in the `post` stage, **after** `surface`. Reading it the same frame is a graph cycle. So tier 8 reads the **previous frame's** pyramid — one frame of lag on a heavily-blurred term, which is invisible when still and smears slightly during a fast pan. That is a real cost and it is why the rung sits at the top of the ladder, gated, rather than in the middle.

---

## 6. THE LADDER

Ordered by **cost class**, per Effects.md Law 3 — not by prettiness. Tier 0's C4 is the admission price and monotonicity governs 1..N upward from there, exactly the shape `water.js`'s own manifest already established and justified.

| Tier     | Name            | Class  | Adds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** ✅ | `presence`      | C4     | The mask, read as a reflectance colour, × `buf:scene.illum`, additive, cropped to the metal's AABB, gated to the visible floor by `buf:scene.attr.r`. **The metal is metal-coloured and responds to how lit the room is.** Never gated. Carries the correctness gate (§4.5).                                                                                                                                                                                                                                                                                                                                                                                                            |
| **1** ✅ | `material`      | C1     | The HSV→(F0, metalness, roughness) decomposition (§2.1) and the two-blend composite (§2.4). Pure ALU on tier 0's fetch. **Gold stops being a yellow glow and becomes gold.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **2** ✅ | `sky-and-lamps` | **C3** | The synthesised view vector + Schlick Fresnel (§3.1–3.2); outdoors two analytic sky lobes (dome + sun), indoors TWO analogous terms (an ambient dome off illum's own value + the ∇illum lamp lobe off its gradient, §4.2–4.3), mixed by the outdoors mask. **The rung where the highlight first MOVES.** The single largest perceptual jump on the ladder. _(C3, not the C1 first drafted here: the lamp direction costs four extra taps of `buf:scene.illum`. Still no new bandwidth — it is a buffer the graph already produced — but four taps is not ALU and the manifest should not say it is.)_ _(The indoor ambient half landed 2026-07-26, after shipping without it — §10.8.)_ |
| **3** ✅ | `relief`        | **C3** | The map art's own painted luminance gradient, read as surface slope (§3.3). **THE RUNG THAT MAKES THE OTHERS VISIBLE** — with a flat normal `N·H` is one number for the whole screen, so tiers 0-2 could only paint a flat wash; measured, tilting the normal toward the mirror angle takes the same pixel from 0.39 to 6.3. _Designed as rung 6 and mis-costed as a C4 VT read: `buf:scene.color` is already in the graph, so it is C3 and always belonged here._                                                                                                                                                                                                                      |
| **4**    | `microsurface`  | C2     | Footprint-aware glint + roughness widening (§3.5). One small resident noise fetch. **Sparkle that resolves instead of aliasing.** _(Now the first UNBUILT rung; its C2 sits below tier 3's C3, so the two swap places in the final ordering.)_                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **5**    | `context`       | C3     | `buf:scene.coloration` for per-lamp highlight colour; sun-occlusion visibility on the glint; weather — wet as a **smooth dielectric clear coat** and frost as roughness-up + cool F0 + finer facets. Buffers already in the graph; no new bandwidth.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **6**    | `grain`         | C4     | The `_Specular` SDF pack (§3.4): per-object anisotropy along the shape, the edge bevel, distance-driven polish. **A blade gets a highlight that runs along the blade.** One baked texture read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **7**    | `dispersion`    | C4     | Thin-film iridescence and prism dispersion as a function of the now-varying `cos θ` and a thickness from tier 5's distance field. Rides reads already paid for. **Absorbs `IridescenceEffectV2` + `PrismEffectV2`** — the last two of the five classes this pass owes.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **8**    | `reflection`    | C6     | Roughness-indexed sample of the previous frame's bloom pyramid along the reflection vector. **Torches smeared across a polished hall floor.** Coverage- and zoom-gated (Law 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Read it as a story.** Tiers 0–3 are one VT read, one small noise read, and arithmetic — and they buy the material, the motion, the indoor/outdoor split and the glint. A weak machine gets metal that a player would describe as metal, not as "missing effects". Everything from 5 up is the expensive half, and it is the half a player notices when present rather than when absent. That asymmetry is Law 3 working, not luck.

**Eleven controls replace sixty-one.** V2's 30 shimmer sliders, 11 wet controls, 4 sparkle controls and 4 frost controls are not ported: shimmer becomes a material property of the paint, wet becomes `roughness ×= (1 − wetness)` plus a clear coat, and frost becomes three parameter shifts on the same lobe. Anything that cannot be justified as a _material_ or an _environment_ property does not get a slider — `params/no-dead-controls` will enforce that a key exists only when something reads it.

---

## 7. THE DECLARATION

### 7.1 Module layout — the established split

Mirrors `bloom` / `candle` / `door-graphics` / `water`: a pure, Node-validatable declaration; THREE **injected**, never imported, in the render siblings.

```
src/effects/specular/
  specular.js               SPECULAR_PARAMS + the SPECULAR manifest. Pure data, no THREE.
  specular-material.js      HSV → (F0, metalness, roughness, presence). Pure TSL fn. Has a CPU twin.
  specular-lobes.js         GGX + Schlick; the sky pair; the ∇illum lamp lobe.
  specular-render.js        The two materials (multiply + add), the bounded quad, the MRT overrides.
  specular-body-subsystem.js  The JFA bake of the _Specular SDF+tangent pack (tier 5 only).
```

### 7.2 The pass entry

`graph/passes.js`'s `surface.response` needs one edit and one prerequisite:

```js
reads:    ['vt:masks', 'buf:scene.illum', 'buf:scene.coloration', 'buf:scene.attr', 'res:env'],
modifies: ['buf:scene.color'],
owns:     'docs/planning/Specular.md (the material model + the indoor/outdoor split)',
```

> **`buf:scene.coloration` was not declared, and now is (2026-07-26).** It was really allocated (`vt-pan-viewer.js:1327`), really rendered into from its own dedicated scene and really read by the composite — but `light.accumulate`'s `creates` listed only `buf:scene.illum`, so the buffer existed nowhere in the graph except that pass's prose. That is not bookkeeping: an undeclared resource cannot be READ by a later pass without tripping `validatePassGraph`'s reads-before-creates check, so the graph was quietly unable to express a consumer for a buffer that has existed since increment 3. Fixed as a prerequisite of tier 4; the read itself lands with that rung.

The shipped `reads` are narrower than the sketch above, deliberately: `vt:masks` is absent because the mask's COLOUR comes from the authored file (the VT/derivation path is extracted R-only, and for a colour mask R is not presence), and `res:env` is absent because the sky arrives as a handle rather than as a graph resource. A read appears in a `live` pass's declaration only when a producer for it does — declaring one otherwise is `pass-health.js`'s own STARVED.

### 7.3 The params, in the author's language

**Eight shipped for tiers 0-2**, against V2's sixty-one, and each one is a property of a _material_ or of the _world_, never of a noise generator. Rungs 3-5 add three more as their code lands — never ahead of it, because `params/no-dead-controls` fails the build on a key with no consumer (it fired on exactly that during this build, which is the wall doing its job). FOH/ROH split per `feedback_foh_roh_must_differ`.

| Control        | Category     | FOH?  | Status | What it is                                                                                                                                                                       |
| -------------- | ------------ | ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shine strength | Look         | **✓** | ✅     | Master intensity of the whole pass.                                                                                                                                              |
| Viewer height  | Look         | **✓** | ✅     | How far above the map the eye sits, **as a multiple of what is on screen** (§3.1). Low = highlights sweep dramatically as you pan; high = the flat, static V2 look.              |
| Sun glint      | Outdoor      | **✓** | ✅     | Strength of the single sharp sun highlight.                                                                                                                                      |
| Lamp glint     | Indoor       | **✓** | ✅     | Strength of the per-lamp highlights.                                                                                                                                             |
| Polish         | Look         |       | ✅     | Global bias on how smooth the painted metal reads. Left of centre = everything duller.                                                                                           |
| Metal response | Look         |       | ✅     | How far a saturated mask colour pushes toward true conductor behaviour — and therefore how much it suppresses the art beneath. **0 reproduces V2's pure-additive look exactly.** |
| Sky sheen      | Outdoor      |       | ✅     | Strength of the broad dome reflection.                                                                                                                                           |
| Lamp height    | Indoor       |       | ✅     | How high the lamps hang — grazing streaks vs. tight overhead pools.                                                                                                              |
| Facet size     | Microsurface |       | rung 3 | World px per microfacet. Sets the zoom at which sheen resolves into sparkle.                                                                                                     |
| Grain          | Grain        |       | rung 5 | How strongly the highlight stretches along an object's own axis.                                                                                                                 |
| Edge light     | Grain        |       | rung 5 | Brightness of the bevel rim tracing each metal silhouette.                                                                                                                       |

---

## 8. THE TRAPS — named up front, from the ledger

| Trap                                                              | Where it bites here                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`vt/mask-image.js` uploads **RED only**~~                       | **RESOLVED.** It grew a `channels: 'r' \| 'rgb'` fork (`RGBAFormat` for the latter) plus a `contentBounds` AABB measured in the same pass it was already making over the texels. `'r'` stays the default so water is untouched. The bounds are measured by **MAX of RGB, never red** — a blue-painted steel object has `r = 0` and would have been cropped out of existence. |
| ⚠️ `buf:scene.attr` had **no consumer at all** before this        | This pass is the first thing in the renderer to read MRT attachment 1 (`post.grade` is still a seam). If the attachment turns out not to be sampleable in practice, the floor gate compiles out via a JS branch and `getStatus().floorGate` reports `false`.                                                                                                                 |
| ⚠️ `attr.r` alone reads same-floor Tiles/roofs as "still visible" | **RESOLVED 2026-07-29** for Tiles and this Level's own foreground/roof — see §4.5's own correction and `keyhole-specular-built` ROUND 11. STILL open for tokens and anything relying on the safe-zero `buf:scene.attr` default (Case-2 vegetation overlays, doors) — that default carries no kind information at all.                                                        |
| `reference_tsl_method_chaining_trap`                              | `a.mix(b,t)` compiles to `mix(b,t,a)` **silently**. Function form only. This shader is nothing but mixes.                                                                                                                                                                                                                                                                    |
| `reference_tsl_fn_deferred_execution_trap`                        | `Fn(cb)()` is lazy; a closure var set inside is unset on the next line. Use `TSL.output` for the material's own result — which the MRT override in §2.4 needs.                                                                                                                                                                                                               |
| `feedback_doubleside_invisible_to_status_reports`                 | Every world quad needs `side: DoubleSide` or it culls silently while every JS field reports healthy.                                                                                                                                                                                                                                                                         |
| `feedback_blend_neutral_element_is_per_blend`                     | §2.4's multiply pass must write `attr = vec4(1)`, not `vec4(0)`.                                                                                                                                                                                                                                                                                                             |
| `feedback_y_flip_recurring_risk`                                  | Two new mappings here: world→specular-mask UV and world→SDF UV. Verify orientation at each.                                                                                                                                                                                                                                                                                  |
| `feedback_sdf_does_not_draw_the_edge`                             | Silhouette from the mask file; distance from the SDF. Never the reverse.                                                                                                                                                                                                                                                                                                     |
| `feedback_smooth_output_hides_ported_bugs`                        | The HSV→material decomposition gets a **CPU twin and a Node test** before it ships: assert gold in → gold F0 + high metalness out, and mid-grey in → V2-equivalent out. A plausible-looking sheen is exactly the output that hides a wrong decomposition.                                                                                                                    |
| Effects.md Law 4                                                  | Tiers are JS `if`s at graph-build time. A `uniform(0)` is not off.                                                                                                                                                                                                                                                                                                           |

---

## 9. WHAT THIS DELIBERATELY DOES NOT DO

- **No normal map, no `_Normal` mask, no `_Roughness` mask.** The author's directive, and the design is stronger for it: §3.3's relief comes from art that already exists, and §2.1's roughness comes from a channel that was already being painted and thrown away. `RoughnessEffectV2` and `NormalEffectV2` are absorbed by being made unnecessary, not by being ported.
- **No environment map, no probe, no cubemap.** Outdoors the environment is two analytic lobes from a handle that already exists; indoors there is no environment, which is the finding, not a limitation.
- **No second light system.** The indoor direction comes from the gradient of a buffer `light.accumulate` already writes. This pass never enumerates lights, never reads Foundry's light documents, and never learns what a wall is.
- **No decision on the `_Specular` VT pack format.** Tier 0 reads the high-res mask image (water's route); whether it also becomes a VT layer is the Stage 4 mask-audit question `surface-response.js`'s own seam already flags, and nothing above depends on the answer.
- **No governor policy.** Effects.md §6 gets built when there are ≥2 tiered effects to arbitrate between. After this there are exactly two.
- **⚠️ No per-TILE mask, only per-floor-BACKGROUND — a real gap, found chasing §10.8, not a deliberate scope line.** V2's own file header calls itself _"per-tile additive specular overlays"_ and supported a `_Specular` file beside an individual placed Tile's own image, not only beside the floor background. `effects/specular/specular-seams.js` only ever resolves the background case (mirroring water's identical, and identically narrowed, pattern). Confirmed by direct investigation of `scene/mask-authority.js`: `authoredStatus(levelId, kindId)` takes a **level id**, never an item id, and `layersForItem` explicitly refuses anything but `'levelBackground'` — the header there states outright _"Masks attach to LEVEL BACKGROUND art only… Tiles… carry no mask files of their own."_ The underlying matchers (`splitArtUrl`/`matchMaskFiles`/`candidateUrls` in `mask-discovery.js`) are already item-agnostic, so this is closer to focused wiring than a redesign: a parallel item-keyed path through discovery + the authority + a second seam function, onto shapes that already exist. Water and Fluid dropped the identical case from their own V2 ancestors, undocumented in either doc until now — systemic, not specific to this effect.

---

_V2 painted the shimmer because it had deleted the angles. Put the angles back and the shimmer is a material property._

---

## 10. WHAT SHIPPED INVISIBLE, AND WHAT THE NUMBERS SAID

Tiers 0-2 went live physically correct and **radiometrically unmeasured**. The author's first report was _"nothing is very visible about it right now."_ The decode had a CPU twin and 73 assertions; the **composition** — what those numbers actually add to a pixel — had none, so the one question that mattered was the one question nothing could answer.

The response was a second twin (`specular-lobes.js`) and a measurement suite (`__tests__/specular-lobes.test.mjs`) that asserts **brightness bands** rather than "does it run". `buf:scene.color` holds the lit map at roughly 0..1, so 0.008 is invisible, 0.05 is a sheen, 0.3 is unmistakable metal. Here is what it found.

### 10.1 Saturation is not metalness — the primary cause

| mask       | metalness | F0 (green) | sun term | dome term | **total**             |
| ---------- | --------- | ---------- | -------- | --------- | --------------------- |
| grey steel | 0.00      | 0.040      | 0.005    | 0.011     | **0.016** ← invisible |
| gold       | 0.95      | 0.529      | 0.003    | 0.134     | **0.139** ← fine      |
| white      | 0.00      | 0.040      | 0.0002   | 0.011     | **0.011**             |

The decode read HSV saturation as metalness on the reasoning that _a saturated reflectance is the defining optical property of a conductor_. That sentence is true and the inference from it runs the implication backwards: **coloured ⇒ metal** does not give **uncoloured ⇒ dielectric**. Steel, iron, pewter, silver, chrome and lead are all grey, and every one of them landed at `F0 = 0.04` — a 4% reflector, which viewed from directly above returns essentially nothing.

So the effect worked **only on gold**, and a screenshot of a gold coin would have confirmed it as working. Metalness is now a scene-level param (`metalResponse`), which is also the honest shape: the file is a metal mask, and "are this map's shiny things metal or wet glaze" is one statement about a map rather than a property of each brushstroke.

**Result: grey steel 0.016 → 0.280.**

### 10.2 …and metalness must scale with value, or the model inverts

With a flat scene metalness, dark grey paint (value 0.3) measured **1.06** against near-white polished paint's **0.217** — darker paint producing a five times brighter result. An author reaching for dark grey to mean "dull, tarnished iron" would have painted the hottest thing on the map.

Neither half is a bug on its own: `roughness = 1 − value` gives dark paint a very broad lobe, and a broad lobe catches an off-mirror sun that a polished razor lobe misses entirely. What was missing is that **a dark metal is dark because it is tarnished, and oxide is a dielectric** — so its F0 genuinely falls. `metalness × value` says exactly that and restores monotonicity with what the author meant.

### 10.3 A delta light on a flat map is a razor, not a highlight

Measured on a polished surface: the sun lobe returns ~0.1 across the whole map and **191** on the exact locus where the normal bisects light and view — a one-pixel line, blown out, crawling as the camera moves. That is what a punctual light on a mirror physically _is_. Real metal escapes it by being **curved**, so the locus sweeps across a surface; a flat map has no curvature to sweep with.

Fix: give the source an angular size (`SOURCE_ANGULAR_ALPHA`), the standard area-light treatment. It needs **no** energy normalisation because GGX's own `D` is already normalised, so it redistributes rather than adds — peak ÷150, tail ×120. A readable band instead of a spike.

### 10.4 Two unit errors, both invisible in review

- **`SUN_IRRADIANCE_RATIO` was 5, and should be 2.1.** "The sun is ~5× the sky" is the physical fact, but `fill.strength` is already 0.42, so setting the constant to 5 drove the sun at 5/0.42 ≈ 12× the dome. **The number that looks like the physical constant is not the number the code needs.**
- **The lamp lobe had no conversion at all.** `buf:scene.illum` is a 0..1 illumination _level_, not irradiance. Indoor metal measured 0.054 against outdoor's 0.39 — a sevenfold gap that was two quantities meeting in one equation, not physics. `LAMP_IRRADIANCE_SCALE` fixes it: indoors now 0.135.

### 10.5 One hypothesis measured and killed

The first guess for the invisible pass was "the dome integral is wrong — a rough surface should gather grazing microfacets and come out brighter". Implemented Karis's split-sum fit and measured it: on a rough dielectric it is **0.034 against bare Schlick's 0.040**, i.e. slightly _dimmer_. It is a better integral (it accounts for the energy a rough lobe loses) and it is kept, but it was **not** the explanation — which is exactly the value of measuring: it left the flat normal with nowhere to hide.

### 10.6 The conclusion: relief is not a luxury rung

With a flat normal, `N·H` is one number for the whole screen — §1.2, again, restated as a measurement. Tiers 0-2 could only ever paint a **spatially flat wash**, at 0.39 of scene brightness everywhere, with no highlight anywhere. Tilting the same pixel's normal toward the mirror angle takes it to **6.3**.

That sixteen-fold swing _is_ a highlight, and on a flat map there is no other source of one. **No amount of gain substitutes for it** — turning the wash up is V2's additive glow rebuilt at greater expense. So `relief` moved from rung 6 to rung 3, and the re-costing was not a judgement call: it had been priced as a C4 VT read of the albedo pack, and `buf:scene.color` is already in the graph, making it C3 — the same class as tier 2, and therefore always eligible to sit there under Law 3.

### 10.7 Where the calibration landed

Every material now lands **brighter than the art beneath it** (the two-blend composite must never make painting the mask darken the map — §2.4's suppression is deliberately under-physical at `METAL_DIFFUSE_SHARE = 0.35` for exactly this reason):

| mask                      | F0 (green) | additive total | net over map art at 0.5 |
| ------------------------- | ---------- | -------------- | ----------------------- |
| white polished            | 0.856      | 0.444          | 0.795                   |
| grey steel                | 0.618      | 0.394          | 0.775                   |
| gold                      | 0.477      | 0.267          | 0.618                   |
| dark iron                 | 0.285      | 0.150          | 0.606                   |
| glaze (`metalResponse` 0) | 0.040      | 0.026          | 0.526                   |

### 10.8 The indoor ambient floor — stated in §4.3's own table, never built

Found live, on a real scene, from a screenshot: an ornate hall — an astrolabe/orrery centrepiece, gold and brass throughout — showing **no shine anywhere**, on a build that had already passed every measurement in §10.1–10.7. The author's report: _"This is a scene full of golden/brassy metal. Nothing is visibly shining yet."_

Two wrong hypotheses were ruled out before the real one, in the order they were tested:

1. **Per-tile masking** — V2's own file header calls itself _"per-tile additive specular overlays,"_ and this port only ever wired the floor-background case. A real, separate gap (§9 should have named it and did not — logged now), but not this bug: the author confirmed the astrolabe **is** the floor's background art, not a placed Tile.
2. **A broken mask/rect/floor-gate pipeline** — the obvious next suspect, given the whole chain (discovery → CPU derivation → the hi-res image → the AABB crop → the floor gate) had never been exercised against real content. Re-reading `scene/mask-derive.js` end to end found the rasterisation machinery is generic over any `rasterize: true` kind regardless of its declared `channels`, so this was not it either — and the author confirmed a mask genuinely was authored.

The real cause was sitting in this very document, in §4.3's own table, one row above this section: _"Uniform ambient / global illumination only → No directional highlight, just a flat Fresnel sheen."_ **That sentence was always the intended design. It was never implemented.** Tier 2 shipped with ONLY the directional lamp lobe, gated on `‖∇illum‖`. A room lit by nothing but ambient/global fill — no torch placed close enough to the metal to create a local gradient, which is the common case for most interior architecture, including a museum-like hall built around a single centrepiece — has a gradient of essentially zero _everywhere_, so the entire indoor branch measured to **exactly 0**, regardless of the mask, the material, or how brightly the room was actually lit (`illum` could read 0.6 and the composite was still 0 — asserted in `specular-lobes.test.mjs`, the earlier version of which had actually encoded this AS the expected behaviour: _"indoor metal with NO lamp reaching it is dark — there is no sky to fall back on"_, mistaking "no directional source" for "no light of any kind").

The fix is the ambient half indoors already had an exact outdoor twin sitting one function away: `domeTerm` — the split-sum environment BRDF built in §10.5 — answers _"how much does a rough/smooth-F0 surface reflect of a uniformly-lit environment this bright"_, for the sky. A room's ambient fill **is** such an environment, and `illum` at that pixel is exactly the _"how bright is it here"_ scalar the same integral wants. So the indoor branch gained an **ambient dome term**, symmetric with the outdoor one, reusing `domeReflectance` (`f0·scale+bias`) **verbatim** rather than re-deriving it — `N·V` and roughness are the same quantities regardless of indoors/outdoors, so a second evaluation would be pure duplicated cost. It is **ungated by the lamp's gradient test**: a shiny surface in a lit room shows a flat sheen even with nothing nearby to catch a sharp highlight _from_, exactly as real metal does under diffuse light. The directional lamp lobe is additive on top when a gradient genuinely exists — a boost, never the only source.

| Case                                              | Before                                       | After                                                                                   |
| ------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Lit room (illum ≈ 0.5), no nearby lamp, gold mask | **0**                                        | visible, scaling with room brightness (0.19 at dim ambient → 0.72 at a bright interior) |
| Outdoor case (unchanged — regression check)       | 0.394                                        | 0.394, bit-for-bit                                                                      |
| Lit room + a nearby lamp                          | 0 (lamp math ran but had no floor to sit on) | ambient floor + an additional directional boost on top                                  |
| A genuinely dark room (illum = 0)                 | 0                                            | 0 — correctly still nothing, since there is nothing to reflect                          |

New control: `ambientSheen` (Indoor category, default 1, **front-of-house** — deliberately asymmetric with its outdoor twin `skySheen`, which stays ROH, because outdoor scenes already show a strong response at every default while this is the single most useful indoor troubleshooting lever there is, precisely because its absence was invisible until now).

_The equation being right does not make the picture right. Measure the output, in the units the screen uses._

---

## 11. THE INSTRUMENT WAS THE BUG — 2026-08-01

Twelve rounds of this effect (§10, plus ROUNDS 11–12 in `keyhole-specular-built`)
were diagnosed off its debug channels. **Most of those channels were structurally
incapable of returning anything but zero, and had been since they were written.**

### 11.1 What was actually wrong

`specular-render.js` built ONE debug material and picked a channel with a fold of
TSL `select()`s — the obvious shape, and the one every effect with debug channels
reaches for:

```js
let debugColor = vec3(0, 0, 0);
for (const ch of CHANNELS) debugColor = cond(ch).select(nodes[ch.id], debugColor); // ⛔
```

TSL's `select()` does **not** emit a ternary. It emits real control flow, and a
node's variable ASSIGNMENT is emitted wherever the graph walk first reaches it.
The walk runs from the LAST branch to the first, so every `.toVar()` in the
shared subgraph lands inside whichever branch pulled it first and every other
branch reads a `var<private>` that WGSL default-initialises to **zero**.

Dumped from the real compiled shader (`tools/shader-lab/bench-specular.js#dumpShader`):

```wgsl
if ( abs(uDebugChannel - 16.0) < 0.5 ) {
  nodeVar15 = textureSample( attr, ... );                 // ← assigned HERE, and only here
  specFloorMatch = 1.0 - smoothstep( ..., nodeVar15.x );
} else { ...
  if ( abs(uDebugChannel - 8.0) < 0.5 ) {
    specFloorMatch      = 1.0 - smoothstep( ..., nodeVar15.x );   // nodeVar15 is 0
    specBackgroundArtHere = step( 0.251, nodeVar15.z );           // → always 0
```

Measured on the bench with a known-good synthetic `attr` (b = 128/255), before
the fix — 12 of 20 channels dead, and the survivors explain themselves exactly:

| channel                          | read         | why                                                 |
| -------------------------------- | ------------ | --------------------------------------------------- | --- | ------------------------------------------------------------------------------ |
| 1 `quad`                         | `(1,0,1)` ✅ | a constant — no var to strand                       |
| 2–7, 9–15                        | `0` ❌       | every var assigned in some other branch             |
| 8 `floorGate`                    | `(1,1,0)` ⚠️ | R = `1 − smoothstep(…,                              | 0−0 | )` = 1 _because_ it read zero; G came from a fresh fetch; **B structurally 0** |
| 16 `finalBoosted`                | `1.83` ✅    | first channel in walk order to pull the whole chain |
| 19/20 `illumDirect`/`attrDirect` | ✅           | fresh, unshared `texture()` nodes                   |

`final` (ch 15) read **0** while `finalBoosted` (ch 16) — _the same node × 16_ —
read 1.83. That single pair is what ruled out every texture/mapping theory at
once and pointed at the selector.

### 11.2 What it cost

ROUND 12's live evidence was _"channel 8 showed red and yellow but no blue at all,
anywhere."_ **Channel 8's blue could never have been anything else.** The bit-weight
change made in response (4 → 128) addressed a real hazard on reasoning that was
sound, but its evidence was an artifact. Three rounds' worth of "the occlusion bit
is not reaching this pass" was the instrument describing itself.

This is `feedback_instruments_must_not_lie` in its most expensive form: the
diagnostic did not fail loudly, it **answered wrongly, plausibly, and repeatedly.**

### 11.3 The fix

`effects/debug-channel-select.js` — selection is now arithmetic (`step()`-built
0/1 pickers summed), with **no control flow at all**, so every channel's subgraph
is built in the material's main flow where "assigned before read" holds by
construction. The debug material evaluates every channel it offers; that cost is
irrelevant (it is attached to no mesh at channel 0) and a cheap wrong diagnostic
is worth less than an expensive right one.

`effects/window` had the identical fold and was fixed with it — never live-read,
so it cost nothing, which is the only reason it is a footnote rather than a
second §10.

**Verified on the bench after the fix:** all 20 channels alive and mutually
consistent — `mask` returns the painted bytes exactly, `strength` equals their
luma601, `illum` equals `EOTF(0.6)` to four places, `finalBoosted = final × 16`,
and `final` equals the shipping material's own contribution over the base scene.

### 11.4 What this does and does not settle

The bench proves the **shader** is correct given correct inputs: on a gold plate
at `illum` 0.6 it renders 3.66× the base scene's brightness after the real
`neutralToneMapping`, which is unmistakable. It **cannot** see a wiring bug in the
viewer — every input there is synthetic and correct by construction.

So the live invisibility is an INPUT problem, and §4.5's polarity inversion
removes the one input that could turn the whole pass off silently. Whether that
was the live cause is **not proven** — it is the only candidate whose failure mode
matches "invisible everywhere, unresponsive to `strength`", and the instrument
that would have confirmed or refuted it was lying at the time. The next live look
is what settles it, and for the first time the channels it reports will mean what
they say.
