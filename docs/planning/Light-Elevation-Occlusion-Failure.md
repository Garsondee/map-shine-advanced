# Light Elevation Occlusion — Failure Report

**Status: UNRESOLVED.** Fifteen+ rounds of work across multiple sessions have not produced a working feature. Two symptoms are live, right now, on the author's real scenes:

1. **A Tile with Foundry's own "Restrict Lighting" checkbox ticked, positioned above a point light, does not reliably occlude that light.** The most recent attempt (round 15, below) appeared to work for the first few frames of a cold scene load, then visibly reverted mid-session — the light "popped" back above the tile with no code change and no user action.
2. **A point light whose Foundry `elevation` field is set to anything other than the default (0) does not emit visible light at all, anywhere, including in fully open space with nothing above it.** A light left at the default elevation emits light normally, but is not occluded by anything (expected, and separately tracked as symptom 1) — the two symptoms may or may not share a root cause; this has not been established.

This document exists because the investigation kept producing confident, plausible-sounding "root cause found" claims that turned out to be wrong, several of which were only caught because the author checked the actual evidence rather than trusting the arithmetic. That pattern is itself the most important thing recorded here — see [Meta: why fifteen rounds didn't land it](#meta-why-fifteen-rounds-didnt-land-it) at the end.

> ### ⛔ STOP — READ THE 2026-08-04 SOURCE AUDIT FIRST
>
> Everything in rounds 1-15 was built on a premise that a full read of the vendored Foundry v14 source shows to be **false**: that Foundry does not occlude light by elevation and this project was inventing the capability. Foundry has a complete, working, per-pixel light-elevation occlusion system, and MSA has not ported any part of it. **Jump to [THE 2026-08-04 SOURCE AUDIT](#the-2026-08-04-source-audit--foundry-already-solves-this-and-msa-never-ported-it) before acting on anything above.** The rest of this document is preserved as the history of the wrong path, not as guidance.

## System model (for a reader with no prior context)

- `buf:scene.attr` (`src/vt/scene-attr.js`) is a second render-target attachment, rendered alongside the main scene color every frame. Per screen pixel it packs: R = floor index, G = an "outdoors" flag, B = a presence-bits byte (bit 0 = overhead/roof, bits 2-5 = a 0-15 "how high above this floor's own ground" value, bit 7 = occludes-background), A = the drawing fragment's own solidity alpha.
- Every whole-image tile/background material writes into this buffer via `buildWholeImageMaterial` (`src/vt/vt-pan-viewer.js`) → `buildRealFloorAttrMrtNode`/`packFloorAttr` (`src/vt/scene-attr.js`). The write rides ordinary GPU alpha blending (`attr_new = attr_old·(1−α) + attr_src·α`), not a hard overwrite.
- A point light is drawn by **two separate meshes sharing one geometry**: `point-light-illumination.js` (the ambient floor-lift) and `point-light-coloration.js` (the light's own authored, possibly-animated color). Both independently sample `buf:scene.attr` at their own fragment position and call the shared `buildHeightGateNode`/`computeHeightGate` (`point-light-illumination.js`) to decide how much of the light's own falloff survives.
- The gate compares two "ranks" (`elevationRank(floorIndex, unitsAboveFloorBottom)` — floor index dominates, height-within-floor is a fraction below 1.0): the light's own rank (from its Foundry `elevation` field, or a sentinel ~1e6 if that field was never touched — meaning "reach everything, unconditionally") against the receiver surface's rank (decoded from the `buf:scene.attr` pixel under the light). If the receiver's rank is far enough above the light's, the light's contribution fades to zero there.
- A light whose Foundry elevation is left at the schema default (0) is, by design, treated as "unconfigured" and gets the sentinel rank — its FINE height comparison never fires, but it's still supposed to be hard-blocked by the overhead bit if something with `restrictsLight`/roof-foreground content is drawn above it.

## Files (sent to the author 2026-08-04, current as of round 15)

- `src/vt/scene-attr.js` — encode/decode, the presence-bits packer, the round-15 change.
- `src/vt/vt-pan-viewer.js` (~12,700 lines) — the "god object." Contains `buildWholeImageMaterial` (the actual attr writer), the geometry render pass, `syncAllFloorAttrUniformsForFrame` (per-frame uniform refresh), and the pixel-probe diagnostics (`itemsCoveringWorldPoint`, `sampleOnePixel`).
- `src/effects/lighting/point-light-illumination.js` — the shared height-gate implementation (`buildHeightGateNode`/`computeHeightGate`), `elevationRank`, the sentinel constant.
- `src/effects/lighting/point-light-coloration.js` — the second material a light draws through; independently gates, IF `attrTexNode` was passed to `buildPointLightColorationMaterial` at its call site (unverified — see open questions).
- `src/effects/lighting/point-light-pool.js` — resolves each light's own elevation rank once per frame and pushes it into both materials' uniforms.
- `src/graph/passes.js` — the render-pass graph; declares which pass creates vs. only reads `buf:scene.attr`.
- Matching `__tests__/*.test.mjs` for all of the above — Node-level wiring tests only (this project's own convention: TSL shader construction is GPU/browser-only, these tests verify JS-side wiring and arithmetic, never actual rendered pixels).

## Timeline (condensed from `keyhole-light-elevation-occlusion` memory, rounds 1-15)

Full detail lives in the project's own memory system (`keyhole-light-elevation-occlusion.md`); this is the shape of it.

- **Rounds 1-3**: constant recalibration and a real cross-floor normalization bug, fixed. Neither was the actual reason the feature didn't work, because —
- **Round 4**: the gate was sampling `buf:scene.attr` through a texture node with no UV set, defaulting to mesh-local `uv()` on a light mesh that has no UV attribute at all — every fragment read the same constant texel. Fixed (`screenUV`).
- **Round 5**: a light is two meshes; only illumination was gated, coloration (the actual visible glow, including all animated effects) was not. Fixed by extracting one shared gate function both materials call.
- **Round 6**: candle flames and lightning bolts are separate batched meshes, not point-light-pool meshes; needed their own per-vertex elevation rank. Fixed.
- **Round 7**: `buf:scene.attr`'s solidity write was reading a Tile's on-screen alpha, which Foundry's own "roof fades so a player can see their token" mechanic already reduces — conflating "how should this look right now" with "is this physically here." A token walking into a room turned its own roof's occlusion off. Fixed by reading a pre-occlusion-fade alpha instead.
- **Round 8**: an unconfigured (elevation-0) light's fine height comparison can never fire by design (that's the sentinel), so it needed a second, numeric-authoring-free signal to be occludable at all — `PRESENCE_BIT_OVERHEAD`, set automatically for genuine roof/foreground content. Fixed.
- **Round 9**: a Tile's own Foundry-native "Restrict Lighting" checkbox (`item.restrictsLight`) was being read faithfully from Foundry's document schema this whole time and then never consumed anywhere — a real, live, screenshot-confirmed report ("cover tile ticked, still glows through") traced to this. Fixed by OR-ing it into the same overhead bit, scoped to Tiles only (a Level's own background has this flag `true` unconditionally and would self-block every light on its own floor if the scoping were missed).
- **Round 10**: round 9 alone did not fix the live report. Root cause: the solidity-alpha texture sample had no explicit mip level, and an implicit auto-selected mip on a small/padded/minified tile read alpha≈0 even over visibly-opaque paint, making the write a near-total no-op. Fixed with `.level(0)`.
- **Round 11**: a new diagnostic (an isolated second-render-target probe, built to verify rounds 9-10 without another full live round-trip) rendered production materials into a second target and **permanently corrupted their compiled GPU pipeline**, breaking all point-light rendering session-wide until a full reload. This is now a standing lesson in project memory (`feedback_diagnostic_must_not_render_production_materials_elsewhere`).
- **Round 12**: that diagnostic mechanism was deleted entirely (not patched) once the corruption was understood.
- **Rounds 13-14**: two new, deliberately safe (pure JS, no rendering) probe fields were added — `expected` (a fresh recompute of the CPU-side encode formula, right now) and `liveTiles` (a direct read of the actual `.value` sitting in each material's bound uniform, no recompute). Both agreed with each other exactly at every probed point, ruling out both the encode formula and a stale/unrefreshed uniform as the cause — the data going into the shader was provably correct, yet the rendered buffer still read a value matching neither the tile's true byte nor the background's.
- **Round 15**: with staleness and the formula ruled out, the remaining candidate was the alpha-blended write itself. The arithmetic checked out: the tile's true byte (169) blended at a specific fractional alpha (~0.355) against the background's byte (0) arithmetically produces exactly the wrong byte observed (60). A fix was shipped: `packFloorAttr` now alpha-**tests** its blend-driving component to a hard 0/1 at a 0.5 threshold, rather than packing a continuous value through, so a fragment either contributes nothing or writes as fully solid. Node-tests updated and green (7268 assertions). **This is the fix that appeared to work for a few frames on cold load, then reverted.**

## What round 15 got wrong, and why the fix is not trustworthy as shipped

Round 15's arithmetic (169 × 0.355 ≈ 60) is real and self-consistent, but the *explanation* built around it — that the "Restrict Lighting" tile's own art is painted with soft, low opacity (~35%) across most of its extent, so its packed metadata byte is legitimately getting attenuated by the blend — **was asserted with unwarranted confidence and is false.** The author supplied the actual source texture: it is a small number of fully-opaque icon-style lantern-cap shapes on an otherwise fully-transparent field, not a soft translucent wash. Nothing about that art should produce a steady ~35% alpha reading at arbitrary probed points, most of which fall in the fully-transparent majority of the texture, not on an icon.

This means:

- The *mechanism* identified (alpha-blended MRT writes are not hard overwrites, and can't safely carry a multi-bit value field without protection — already a named, precedented bug class in this codebase, `feedback_alpha_blended_write_needs_wide_margin`) may still be real and worth keeping in mind.
- But **the actual source of the ~0.355 alpha at the probed pixel is not understood.** It is not the art's own painted opacity. Candidates that were not checked before shipping round 15: BC7 texture-compression block artifacts at the edges of small opaque shapes on a mostly-empty texture (the tile is reported as BC7-compressed in the flight-recorder's own VRAM report); some other, unidentified contributor to that exact pixel that isn't either of the two items the CPU-side registry knows about; or something in the round-10 mip-level fix not actually taking effect the way it's assumed to.
- The round-15 fix's own threshold (0.5) was chosen assuming the false premise — "a genuinely soft, ~35%-opaque tile should be excluded, a genuinely near-opaque one should count." With that premise gone, there's no remaining justification for 0.5 specifically, or for the alpha-test approach at all, until the real source of the anomalous alpha is identified.
- The cold-load "worked for a few frames, then reverted" report is consistent with a texture-loading race (an early placeholder read as opaque, later replaced by the real, lower-alpha-at-that-texel content) but this is **also unconfirmed** — it was offered as a plausible explanation, not verified against the actual asset-loading code path.

**The round-15 change is still in the codebase as of this writing.** It has not been reverted, because the author asked for a document instead of further code changes. Whether to keep it, revert it, or replace it with something else is an open decision for whoever picks this up next.

## Symptom 2 is separately, completely unexplained

"A light with any non-zero configured elevation emits no light at all, anywhere, even fully in the open" is not explained by anything found in this investigation. The round-15 fix (and everything from round 9 onward) only touches behavior *under* an occluding tile — it should have no effect on a light sitting in open space with nothing drawn above it. If that symptom is real and reproducible independent of any tile, the corruption responsible is not scoped to "one translucent tile's alpha-blended write" — it would have to be affecting the receiver-elevation read far more broadly (e.g., scene-wide, or for every point queried against `buf:scene.attr` regardless of what's actually drawn there). This has not been investigated at all as its own, potentially separate bug — the entire session's attention was on the tile-occlusion symptom, and symptom 2 was only reported partway through, layered on top of an already-long investigation, and never isolated from it.

## Open questions for the next investigator

- What is actually producing the ~0.355 alpha reading at the probed pixel, given the source art is binary (opaque icon / fully transparent), not softly painted? Check BC7 compression artifacts specifically; check whether the round-10 `.level(0)` fix is genuinely taking effect at the exact texel being probed; check whether some other writer (not the two items the CPU-side `itemsAtPoint` registry currently enumerates) is contributing to that pixel.
- Is `attrTexNode` actually passed to `buildPointLightColorationMaterial` at every call site in `vt-pan-viewer.js`? If it's missing at even one, that light's visible glow (coloration, not illumination) never builds a height gate at all — a plausible, distinct explanation for "an elevation-0 light emits light but isn't masked" that has not been checked.
- Is symptom 2 reproducible with ZERO tiles/covers anywhere near the light — i.e., is it genuinely independent of the tile-occlusion investigation, or does it only appear near the same tile that's been under investigation? This has not been isolated.
- Should the round-15 alpha-test change be reverted as a debugging step, given its founding premise is now known to be false? It has not been reverted; it may be masking or interacting unpredictably with whatever the real bug is.
- Consider re-running the existing pixel probe (`itemsAtPoint`, already carries `expected` and `liveTiles` fields — see rounds 13-15 above) at a point that is DEFINITELY over the fully-transparent part of the tile's own texture (not guessed, actually confirmed against the source art) versus a point DEFINITELY over one of the opaque icon shapes, to see whether the anomalous byte is uniform everywhere (pointing at something scene-wide) or specific to certain texel neighborhoods (pointing at a compression/sampling artifact).

## Meta: why fifteen rounds didn't land it

Several rounds in this history followed the same shape: build a plausible causal story from indirect evidence (probe bytes, arithmetic that happens to match), ship a fix against that story, and only discover the story was wrong when the author supplied direct evidence (a screenshot, the actual source asset) that contradicted it. Round 15 is the most recent instance — the arithmetic was real, the interpretation of *why* the numbers came out that way was not checked against the actual texture before being presented as a finding. Earlier rounds (2, 3, 7) have the same shape in the existing memory record. The lesson each time was some version of "measure the actual thing, don't infer its content from downstream arithmetic" — and it kept needing to be relearned because each new round's evidence *looked* more direct than the last (a probe byte, then two independently-cross-checked probe fields, then agent-traced render-pass logic) without actually closing the gap between "the numbers are self-consistent" and "the numbers mean what I think they mean."

Anyone picking this up next should treat every claim in this document — including round 15's own — as a hypothesis to re-verify against the real asset/render state, not as an established fact, however confident the arithmetic backing it looks.

---

# THE 2026-08-04 SOURCE AUDIT — Foundry already solves this, and MSA never ported it

**Method, stated up front so its limits are clear:** this is a **static source audit** of the vendored Foundry v14 source (`foundryvttsourcecode_v14/`) and of MSA's own `src/`. Nothing here was run live, no GPU was involved, no screenshot was taken. Every claim about Foundry is a direct read of vendored source with a file:line citation, and every claim about MSA is a direct read of `src/` with a file:line citation. Claims that are **inferences** rather than reads are labelled as such. This does not close the investigation; it changes what the investigation is about.

## 0. The headline

The premise the entire feature was designed against is written down, in MSA's own source, at [`src/foundry/scene-lights.js:220`](src/foundry/scene-lights.js:220):

> `AmbientLightDocument.elevation` … **NOT part of LightData** (the rendering config Foundry's own shaders consume) and **read by NO Foundry render code at all** — verified by grep across `client/canvas/sources/*.mjs`, which never mention it. **Foundry itself does not occlude light by elevation**; this project is ADDING the capability, not catching up to parity.

**That is false in every clause.** Foundry v14 reads a light's elevation, maps it into a scene-global elevation rank, and compares it per-pixel against a dedicated depth mask written by exactly the objects that block light. It is the mechanism producing the correct picture the author sees in PIXI. The grep that "verified" it was scoped to the string `elevation` in `client/canvas/sources/*.mjs` — and the line it needed is *in that exact directory*: [`client/canvas/sources/base-light-source.mjs:232`](foundryvttsourcecode_v14/resources/app/client/canvas/sources/base-light-source.mjs:232), `u.elevation = this.data.elevation;`, inside `_updateCommonUniforms`.

This is [[feedback_discovery_scope_narrower_than_authority]] and [[feedback_plausible_diagnosis_rots]] in the same sentence: a negative result from one grep became a durable, load-bearing architectural premise, was written into a source comment as settled fact, and then justified building a bespoke parallel system — the height gate, the rank scheme, the 16-bucket quantizer, the overhead bit, the sentinel — none of which Foundry needs, because Foundry solved the same problem with a mechanism the project never looked at.

## 1. How Foundry actually does it (all cited, all verifiable)

### 1.1 A dedicated depth mask, not an MRT attachment

[`client/canvas/layers/masks/depth.mjs`](foundryvttsourcecode_v14/resources/app/client/canvas/layers/masks/depth.mjs) — `CanvasDepthMask`, a `CachedContainer` with its own render texture:

- `static textureConfiguration = { scaleMode: NEAREST, format: PIXI.FORMATS.RGB, multisample: NONE }` (lines 24-28), `clearColor = [0,0,0,0]` (line 31).
- Its `roofs` child's `render` (lines 109-119) is a hand-written loop: `for (const pco of canvas.primary.children) pco.renderDepthData?.(renderer);`

**It is a separate pass into a separate target, drawn by a separate shader.** It does not ride the scene-colour draw, and therefore inherits none of the scene draw's blending, alpha, tinting, occlusion-fade, or clarity behaviour.

### 1.2 The blend is MAX, not alpha

[`client/canvas/primary/primary-sprite-mesh.mjs:290-300`](foundryvttsourcecode_v14/resources/app/client/canvas/primary/primary-sprite-mesh.mjs:290):

```js
renderDepthData(renderer) {
  if ( !this.shouldRenderDepth || !this.visible || !this.renderable ) return;
  const shader = this._shader;
  const blendMode = this.blendMode;
  this.blendMode = PIXI.BLEND_MODES.MAX_COLOR;   // <— THIS
  this._shader = shader.depthShader;
  ...
}
```

`MAX_COLOR`. The depth channel is a **maximum over contributors**, never a weighted average. A partially-transparent fragment cannot dilute a value already written by a solid one, and stacking N soft layers cannot compound into a wrong number. This is the exact hazard `packFloorAttr` has been fighting since 2026-07-29 ([[feedback_alpha_blended_write_needs_wide_margin]], `PRESENCE_BIT_OCCLUDES_BACKGROUND`'s polarity inversion, round 15's alpha test) — Foundry does not fight it, it chose a blend where the hazard does not exist.

### 1.3 Only light-blocking objects write at all

[`client/canvas/primary/primary-occludable-object.mjs:257-259`](foundryvttsourcecode_v14/resources/app/client/canvas/primary/primary-occludable-object.mjs:257):

```js
_shouldRenderDepth() {
  return !this.#restrictionState.isEmpty && !this.hidden;
}
```

An object is in the depth mask **only** if it restricts light or weather. Who that is, exactly:

| object | restricts light? | source |
| --- | --- | --- |
| Tile | `document.restrictions.light` (author's checkbox, default `false`) | [`placeables/tile.mjs:347`](foundryvttsourcecode_v14/resources/app/client/canvas/placeables/tile.mjs:347) |
| Level **background** | **`true`, unconditionally** | [`groups/primary.mjs:301-304`](foundryvttsourcecode_v14/resources/app/client/canvas/groups/primary.mjs:301) |
| Level **foreground / roof** | **`false`** — never set, so `restrictionState.isEmpty`, so it never renders depth | same block: the `restrictsLight = true` assignment is inside `if (lt.isBackground)` |
| Token | not a restriction-state object | — |

**A Level's own foreground/roof art does not block light in Foundry.** Only the Level *background* (the floor slab of the storey above) and explicitly-ticked Tiles do.

### 1.4 The alpha test is `step`, at the object's own authored threshold

[`rendering/shaders/samplers/primary/depth.mjs:411-427`](foundryvttsourcecode_v14/resources/app/client/canvas/rendering/shaders/samplers/primary/depth.mjs:411), the whole fragment body:

```glsl
float inverseDepthElevation = 1.0 - depthElevation;
fragColor = vec3(inverseDepthElevation, depthElevation, inverseDepthElevation);
fragColor *= step(textureAlphaThreshold, textureAlpha);          // <— hard 0/1
vec4 weight = 1.0 - step(occlusionElevation, texture(occlusionTexture, vOcclusionCoord));
float occlusion = step(0.5, max(max(max(weight.r*fadeOcclusion, weight.g*radialOcclusion),
                                   weight.b*visionOcclusion), weight.a*surfaceOcclusion));
fragColor.r *= occlusion;
fragColor.g *= 1.0 - occlusion;
fragColor.b *= occlusion;
if ( !restrictsLight )   { fragColor.r = 0.0; fragColor.g = 0.0; }
if ( !restrictsWeather ) { fragColor.b = 0.0; }
```

`textureAlphaThreshold` is **the document's own authored field**, not a constant:

- Tile: `texture.alphaThreshold`, schema initial **0.75** — [`common/documents/tile.mjs:42`](foundryvttsourcecode_v14/resources/app/common/documents/tile.mjs:42), pushed to the mesh at [`placeables/tile.mjs:367`](foundryvttsourcecode_v14/resources/app/client/canvas/placeables/tile.mjs:367).
- Level background/foreground: `background.alphaThreshold` / `foreground.alphaThreshold`, initial **0.75** — [`common/documents/level.mjs:87,92`](foundryvttsourcecode_v14/resources/app/common/documents/level.mjs:87), pushed at [`groups/primary.mjs:300`](foundryvttsourcecode_v14/resources/app/client/canvas/groups/primary.mjs:300).
- The schema field's own doc: *"Only pixels with an alpha value at or above this value are consider solid w.r.t. to occlusion testing and light/weather blocking."* ([`common/data/data.mjs:575`](foundryvttsourcecode_v14/resources/app/common/data/data.mjs:575))

So round 15's instinct — binarize instead of blending a continuous alpha — **matches Foundry**. Its *threshold* does not: Foundry uses the author's own per-object number (0.75 by default), MSA hard-codes 0.5 (`ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD`, [`src/vt/scene-attr.js:271`](src/vt/scene-attr.js:271)) — while **already reading the authored value and throwing it away** (see §2.6).

### 1.5 Elevation is a rank in a table of the scene's real elevations — not a quantized height

[`layers/masks/depth.mjs:55-92`](foundryvttsourcecode_v14/resources/app/client/canvas/layers/masks/depth.mjs:55):

```js
mapElevation(elevation) {
  const E = this.#elevations;               // ascending, unique, ≤255 entries
  if ( elevation < E[0] ) return 0;
  let i = 0, j = E.length - 1;
  while ( i < j ) { const k = (i+j+1)>>1; if ( E[k] <= elevation ) i = k; else j = k-1; }
  return (i + 1) / 255;
}

_update() {                                  // rebuilt only when dirty
  const elevations = [];
  for ( const child of canvas.primary.children ) {   // already sorted
    if ( !child.shouldRenderDepth ) continue;
    if ( child.elevation === elevations.at(-1) ) continue;
    elevations.push(child.elevation);
  }
  ...
  this.#elevations = new Float64Array(elevations);
}
```

Read what this is: **the set of distinct elevations of the objects that actually block light in this scene, sorted, and each object's depth value is its index in that list.** Up to 255 distinct elevations, each getting its own exactly-representable 8-bit slot. Anything below the lowest maps to 0.

Properties that fall straight out, none of which MSA's scheme has:

- **No quantization collisions.** Two objects at different elevations get different depth values, period. There is no "range in world units" to guess, no bucket width, no `RECEIVER_ELEVATION_RANGE_UNITS` to be 10× wrong (rounds 1-2 of the timeline above).
- **No floor-relative frame of reference.** A basement at -40 and a tower at +400 are just two entries in one ordered list. There is nothing to normalize away — the exact failure [[feedback_normalization_erased_the_compared_axis]] names, which MSA hit and then patched with `elevationRank`'s floor-index-dominant composite.
- **The light is mapped by the *same function*.** [`rendering/shaders/lighting/base-lighting.mjs:27`](foundryvttsourcecode_v14/resources/app/client/canvas/rendering/shaders/lighting/base-lighting.mjs:27):
  ```js
  update() { this.uniforms.depthElevation = canvas.masks.depth.mapElevation(this.uniforms.elevation ?? 0); }
  ```
  One table, both sides. Two values are comparable by construction, not by two implementations agreeing.

### 1.6 The per-pixel test, in one line

[`rendering/shaders/lighting/base-lighting.mjs:392-399`](foundryvttsourcecode_v14/resources/app/client/canvas/rendering/shaders/lighting/base-lighting.mjs:392), `FRAGMENT_BEGIN`:

```glsl
vec4 depthColor = texture2D(depthTexture, vSamplerUvs);
float depth = smoothstep(0.0, 1.0, vDepth) * (globalLight ? 1.0
            : step(depthColor.g, depthElevation)                          // (A)
            * step(depthElevation, (254.5 / 255.0) - depthColor.r));      // (B)
```

and `FRAGMENT_END` is `gl_FragColor = vec4(finalColor, 1.0) * depth;` (line 406).

- **(A) `step(depthColor.g, depthElevation)`** — G is `MAX(depth)` over *non-occluded* light-restricting surfaces at this pixel, i.e. the **highest solid light-blocker here**. The light survives iff **the light's own rank is at or above it**. That is the whole feature.
- **(B) `step(depthElevation, 254.5/255 - depthColor.r)`** — R is `MAX(1 − depth)` over *currently occluded/faded* light-blockers, i.e. `1 − ` the **lowest faded blocker**. The light survives iff it is **strictly below** that faded blocker. This is the "a token walked under the roof, the roof faded, now don't let the outdoor light pour into the revealed interior" case.
- **Cleared buffer (0,0,0,0):** (A) = `step(0, x)` = 1, (B) = `step(x, 0.998)` = 1. **Fail-open by construction** — the same required polarity [[feedback_gate_polarity_must_fail_open]] names, arrived at the same way.
- `globalLight` (elevation `Infinity`, [`sources/global-light-source.mjs:25`](foundryvttsourcecode_v14/resources/app/client/canvas/sources/global-light-source.mjs:25)) is exempt outright.

The two channels are why Foundry can honour the occlusion fade **without** conflating "is it physically here" with "should it look faded" — it keeps both facts, in two channels, and applies opposite tests. Round 7 above solved the same problem by deleting one of the two facts.

*(Note: the class doc at `depth.mjs:6-7` labels R "top" and G "bottom"; the shader arithmetic above reads the other way round. The arithmetic is the authority — I did not resolve the comment.)*

### 1.7 Coloration is gated by the identical code

[`rendering/shaders/lighting/coloration-lighting.mjs:50-63`](foundryvttsourcecode_v14/resources/app/client/canvas/rendering/shaders/lighting/coloration-lighting.mjs:50) — `AdaptiveColorationShader._createFragmentShader` opens with `${this.FRAGMENT_BEGIN}` and ends `gl_FragColor = vec4(finalColor * depth, 1.0)`. Same inherited `depth` term. MSA rediscovered this the hard way in round 5 ("you aren't correctly occluding the animated light source"); it was always there to read.

### 1.8 What Foundry does **not** do — three negative results that matter

1. **It never hides a light because of its elevation.** [`placeables/light.mjs:150-161`](foundryvttsourcecode_v14/resources/app/client/canvas/placeables/light.mjs:150), `_isLightSourceDisabled()`, tests only `hidden`, radius, angle, the placeables-list filter, and the darkness window. No elevation term.
2. **A light's Level assignment cannot orphan it.** [`placeables/light.mjs:456-467`](foundryvttsourcecode_v14/resources/app/client/canvas/placeables/light.mjs:456) does `const level = canvas.inferLevelFromElevation(elevation, {levels})`, and [`board.mjs:1634-1652`](foundryvttsourcecode_v14/resources/app/client/canvas/board.mjs:1634) returns `this.level` (the viewed level) when nothing matches. A light with an out-of-band elevation stays on the viewed level rather than vanishing. **This rules out the tidiest possible explanation for symptom 2** — it is not Foundry withholding the source.
3. **`inferLevelFromElevation` bands are `[bottom, top]` INCLUSIVE at both ends**, with an explicit preference order (strict interior > sitting on the bottom > sitting on the top, then the viewed level wins ties). MSA's `resolveElevationFloorIndex` ([`src/scene/layer-order.js:343-357`](src/scene/layer-order.js:343)) is half-open `[bottom, top)`, first-match-wins, no preference order. This is a **third** authority on "which floor is this elevation on" in a codebase that has already been bitten twice by exactly this disagreement ([[feedback_half_open_band_excludes_its_own_member]]) — and it is the one Foundry itself uses, never consulted.

## 2. Divergence table — every place MSA differs, and what it costs

| # | Foundry | MSA today | Consequence |
| --- | --- | --- | --- |
| 1 | Dedicated depth target, own pass, own shader | `buf:scene.attr`, an MRT attachment on `scene.color` written by the ordinary geometry pass | inherits scene blending, tint, alpha, clarity, occlusion fade — every one of which has already caused a round in this log |
| 2 | `MAX_COLOR` blend | `NormalBlending` (`attr_old·(1−α) + attr_src·α`) | the whole "a multi-bit value field cannot survive an alpha blend" problem class; rounds 7, 10, 13-15 |
| 3 | Only `restrictsLight`/`restrictsWeather` objects write | **every** whole-image tile and background writes ([`src/vt/vt-pan-viewer.js:5944`](src/vt/vt-pan-viewer.js:5944)) | ordinary non-blocking art raises the receiver rank and can kill a light. A false-positive occluder class Foundry does not have |
| 4 | Depth = rank in a table of the scene's actual blocker elevations, ≤255 distinct | 4 bits (16 buckets) over an assumed 15-world-unit span, **measured from the item's own floor's bottom** ([`src/vt/scene-attr.js:425,458`](src/vt/scene-attr.js:425)) | collisions everywhere; the range constant has already been wrong by 10× once; the floor-relative frame had to be patched by composing with a floor index |
| 5 | Light mapped through the **same** table | `elevationRank(floorIdx, h)` = `floorIdx + h/32` ([`point-light-illumination.js:284`](src/effects/lighting/point-light-illumination.js:284)), duplicated CPU/GPU, plus mirrored constants pinned by a test | two implementations that must be kept in agreement by hand |
| 6 | Elevation **0 is an ordinary, comparable, lowest rank** → the *most* occludable light there is | elevation 0 ⇒ `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL = 1e6` ⇒ **unblockable** ([`point-light-illumination.js:189`](src/effects/lighting/point-light-illumination.js:189)) | **this is the direct cause of symptom 1's "a default-elevation light is not occluded by anything."** It is not a bug in the gate — the gate is doing exactly what the sentinel tells it |
| 7 | No "overhead" concept exists or is needed | `PRESENCE_BIT_OVERHEAD` hard-blocks any light under **any Level foreground** or any `restrictsLight` tile ([`src/vt/scene-attr.js:713`](src/vt/scene-attr.js:713)) | invented in round 8 purely to compensate for #6. And it is **backwards vs Foundry for Level foregrounds**: Foundry's roof art does *not* block light; MSA's does, unconditionally, for every light beneath it |
| 8 | Alpha test at the **document's own** `texture.alphaThreshold` (default 0.75) | hard-coded 0.5 (`ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD`) | art with alpha in [0.5, 0.75) counts as solid in MSA and transparent in Foundry — the two renderers disagree about where the holes are |
| 9 | Occlusion fade kept as a **second channel** with the opposite test | fade stripped out of solidity entirely (round 7) | the faded-roof case is silently unhandled rather than modelled |
| 10 | `[bottom, top]` inclusive + explicit preference order (`inferLevelFromElevation`) | `[bottom, top)` half-open, first match wins | a third floor-attribution authority; already the source of two logged bugs |

### 2.6 A live instance of [[feedback_unconsumed_api_rots_silently]], right now

`alphaThreshold` **is already read**, faithfully, for both level art and tiles:

- [`src/foundry/scene-layers.js:311`](src/foundry/scene-layers.js:311) — `alphaThreshold: cfg.alphaThreshold ?? 0.75` (level art)
- [`src/foundry/scene-layers.js:405`](src/foundry/scene-layers.js:405) — `alphaThreshold: tile.texture?.alphaThreshold ?? 0.75` (tiles)
- declared in the `SceneLayerItem` typedef ([line 218](src/foundry/scene-layers.js:218)), covered by a test (`scene-layers.test.mjs:157`)

A repo-wide grep for `alphaThreshold` finds **no renderer consuming it**. `src/scene/occlusion.js:196` even records that Foundry "honours `texture.alphaThreshold`" and that the pure module cannot. This is the same shape as round 9's `restrictsLight` discovery: the value was collected correctly, then sat unused, and a later session hard-coded a guess (0.5) in its place. The correct threshold for round 15's alpha test was already in the item descriptor.

## 3. Symptom 1, re-diagnosed

> *"A tile with Restrict Lighting ticked, above a point light, does not reliably occlude that light."* / *"A light at default elevation emits normally but is not occluded by anything."*

These are the same fact, and the mechanism is **divergence #6**, not the tile. A light at Foundry's default elevation (0) is handed `1e6` as its rank; the fine comparison is then mathematically incapable of ever firing, by design. The only thing that can occlude such a light is `PRESENCE_BIT_OVERHEAD`, which round 9 widened to include `restrictsLight` tiles — a single boolean bit riding an alpha-blended write, at the mercy of everything in divergences #1/#2/#3/#8. So the reliability of the whole feature, for the overwhelmingly common case of an untouched light, rests entirely on one bit surviving a blend it was never safe in.

Foundry has no such fragility because it never needed the bit: elevation 0 is a *real rank*, the tile's elevation is a *real rank*, and `step(g, lightRank)` compares them directly and per-pixel.

**Practical consequence for the author, worth checking before any code changes:** in Foundry, for the lantern-cap case to work at all, the cover Tile's `texture.alphaThreshold` matters. At the default 0.75, only pixels painted at ≥75% alpha block light; the transparent field around the icons does not. That is Foundry's own authored control for exactly the shape the author described (opaque icons on a transparent field), and MSA does not implement it.

## 4. Symptom 2 — what it cannot be, and what is left

> *"A light with any non-zero configured elevation emits no light at all, anywhere, including in fully open space."*

**Ruled out by arithmetic** (this is a derivation from the code above, not a live test):

The only thing that changes when the elevation field goes non-zero is `uLightElevationRank`, from `1e6` to a real rank. The gate darkens only when `receiverRank ≥ lightRank + (1+3)/32 = lightRank + 0.125`. So the light dies only where the *receiver's* rank outranks the light's by more than one eighth of a floor.

- In a **single-Level scene**, the receiver in the open is that Level's own background: floor index 0, height-above-own-bottom 0, so `receiverRank = 0`. No non-negative `lightRank` can satisfy `0 ≥ lightRank + 0.125`. **The fine gate provably cannot cause symptom 2 in a single-floor scene.**
- Raising a light's elevation can only ever *increase* its rank, i.e. give it **more** reach, never less. A light dying because its elevation went up cannot be explained by the light's own side of the comparison alone.

**Therefore the receiver side must be reading high.** Ranked hypotheses, all testable:

1. **(Most likely, structural.)** In a multi-Level scene, `buf:scene.attr`.R records the **topmost drawn floor's index**, and a Level's background is a **full-canvas image** ([`groups/primary.mjs`](foundryvttsourcecode_v14/resources/app/client/canvas/groups/primary.mjs) `mesh.resize(r.width, r.height, config)`; MSA mirrors this in `collectLevelTextures`). Wherever an upper Level's background is opaque enough to pass the 0.5 alpha test, every pixel there reports `receiverRank ≥ 1.0`. A ground-floor light with any configured elevation has `lightRank < 1.0` and is therefore dark across that entire region — which, with a full-canvas upper background, can be most or all of the map. The "fully in the open" part of the report is consistent with this if the upper Level's art is opaque (or ≥0.5 alpha) over open ground. **This is divergence #3 doing exactly what it must**: in Foundry, an upper Level background *does* block light — but only where it passes a **0.75** alpha test, and the light is compared against a rank drawn from the same table, so a ground light under open sky is never compared against a floor that isn't there.
2. **Level-foreground art.** Any Level's foreground sets `PRESENCE_BIT_OVERHEAD` (`isInForeground(elevation, {top})` is true by construction, since foreground art is placed *at* `elevation.top` — [`src/foundry/scene-layers.js:296`](src/foundry/scene-layers.js:296)) **and** quantizes to a high receiver level (`quantize(top − bottom)`, which at Foundry's default 20-unit band clamps to the maximum bucket 15). So foreground art kills all lights beneath it two independent ways. This is elevation-independent, so it cannot be the *whole* of symptom 2, but it will mask any test done under a roof layer.
3. **A floor-index mismatch between the two lookups.** The light resolves its floor via `resolveElevationFloorIndex` on the raw elevation ([`point-light-pool.js:171`](src/effects/lighting/point-light-pool.js:171)); level art resolves by `levelId` membership ([`scene-attr.js:641`](src/vt/scene-attr.js:641)). If a Level's authored band does not contain its own background's elevation — or bands overlap, or a band is `null` — the two can land on different indices for the same physical storey, and any mismatch of ≥1 index in the receiver's favour is a total blackout.

**The decisive test, using instruments that already exist and cost nothing:**

- The point-light status report already prints, per light, `configured`, `rank`, `floorIndex`, and `heightAboveFloorBottom` ([`src/vt/vt-pan-viewer.js:11079-11093`](src/vt/vt-pan-viewer.js:11079)) — deliberately split back into authored halves so it can be checked against Foundry's light sheet.
- The pixel probe already decodes the receiver side (`decodeReceiverElevationLevel`, `decodeOverheadBit`, imported at [`src/vt/vt-pan-viewer.js:105-106`](src/vt/vt-pan-viewer.js:105)).

Put a light with elevation ≠ 0 in the open, read its reported `floorIndex`/`heightAboveFloorBottom`, probe a pixel inside its radius, compute `receiverRank = attrFloorIndex + level/32`, and compare against `lightRank + 0.125`. That single comparison distinguishes all three hypotheses and takes one frame. **It has never been run** — every prior round probed the *tile* case, never an open-ground pixel under a configured light.

## 5. Round 15, re-assessed against the real reference

- **The direction is right and now has a source citation:** binarize, don't blend. Foundry does `fragColor *= step(textureAlphaThreshold, textureAlpha)`. Keep the alpha test.
- **The threshold is wrong:** it should be the item's own `alphaThreshold` (already collected, see §2.6), not 0.5. At the schema default this is 0.75 for both tiles and level art.
- **The founding story is still unexplained, and §1.2 is why it may not matter.** The 169×0.355≈60 arithmetic described an alpha-blended write. Under a MAX blend the question "what produced 0.355 at that pixel" stops being load-bearing for correctness — it would still be worth knowing, but it would no longer be able to corrupt a value field. Chasing the 0.355 is lower priority than removing the blend that made it dangerous.
- **The alpha test alone cannot fix the feature**, because it addresses divergence #2 only. #3, #4, #6 and #7 remain, and #6 is what actually breaks the common case.

## 6. Recommended path

Not a patch to the gate. **Port Foundry's mechanism**, which is small — the entire thing is `mapElevation` (13 lines), one `step`-pair in the light shader, and a blend-mode choice:

1. **Add a real elevation-rank table.** A CPU-side sorted-unique list of the elevations of everything that blocks light in the scene, plus a binary search — a direct port of `mapElevation`/`_update`. Rebuild on scene/level/tile change, not per frame. Pure, Node-testable, no GPU.
2. **Give the light its rank from that same table**, replacing `elevationRank` + `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL` entirely. **Deleting the sentinel is the single highest-value change in this list** — it is what makes a default-elevation light occludable at all, which is the reported bug.
3. **Write the blocker rank with a MAX-style write, not an alpha blend.** Either a dedicated small target with a max-equation blend (closest to Foundry, and cleanest given divergence #1), or — if it must stay in `buf:scene.attr` — a channel written under a max blend rather than the shared alpha blend. Note this is a real constraint to design against: `buf:scene.attr` currently shares one blend state with `scene.color`, so a max-blended channel probably wants its own attachment or its own pass. *(That trade-off is a design decision, not something this audit resolves.)*
4. **Only light-blockers write it** — `item.restrictsLight` for tiles, `true` for Level backgrounds, **`false` for Level foregrounds** (matching §1.3). This alone removes the false-positive occluder class in divergence #3.
5. **Alpha-test at the item's own `alphaThreshold`.**
6. Then `PRESENCE_BIT_OVERHEAD`, `RECEIVER_ELEVATION_LEVELS`, `RECEIVER_ELEVATION_RANGE_UNITS`, the mirrored constants, `ELEVATION_RANK_FRACTION_DIVISOR`, `HEIGHT_GATE_TOLERANCE_UNITS`, `HEIGHT_GATE_SOFTNESS_UNITS` and the cross-file pin test **all become deletable**. They exist to prop up a model Foundry does not use.
7. Keep the fade channel (§1.6 (B)) as a named, deferred rung rather than deleting the concept again.

Everything the port needs is already read from Foundry and already in the item descriptors: `restrictsLight` ✅, `alphaThreshold` ✅, per-item `elevation` ✅, per-light `elevation` ✅. **Nothing new has to be extracted from Foundry.** The missing pieces are the rank table, the blend, and the deletion of the sentinel.

## 7. What this audit did NOT establish

Stated plainly, because the failure mode this whole document is about is exactly the confident inference that outran its evidence:

- **Nothing was run.** No live scene, no GPU, no screenshot, no probe. Every MSA claim is "the source says this"; every Foundry claim is "the vendored source says this."
- **Symptom 2's actual cause is not proven.** §4 rules out one class of explanation arithmetically and ranks three hypotheses. It does not pick one. Run the probe comparison before believing any of them.
- **The ~0.355 alpha from round 15 is still unexplained.** §5 argues it becomes non-load-bearing under a MAX blend; that is a reason to deprioritize it, not an explanation.
- **I did not verify how three's WebGPU backend assigns blend state across MRT attachments** in the vendored build. The claim in `scene-attr.js`'s header (each attachment blends against its own output alpha) is plausible and matches both APIs' specs, but I read the header, not the vendored `three.webgpu.js` blend-descriptor code. If step 3 above is attempted inside the existing MRT, that needs checking first.
- **I did not read `canvas.masks.occlusion`** (`mapElevation` there is a second, similar table serving the fade/radial/vision/surface weights). Only its role as an input to the depth shader's `occlusion` term is described.
- **The Level-foreground divergence (#7) is a behaviour change, not obviously a bug fix.** Foundry not blocking light with roof art may or may not be what the author wants for MSA's own picture; the doctrine is parity-by-default with deliberate departures ([[keyhole-parity-compat-doctrine]]). Flagging it as a divergence is not a recommendation to silently adopt Foundry's answer.
