# Albedo / base-texture render audit — why zoom-out looks grainy, harsh and pixelated

**2026-08-30. Read-only audit. Nothing measured live — every claim below is traced to a
line of shipped source, and every claim that is a *hypothesis* is labelled as one.**

Author's report: *"too mushy, too grainy or too pixelated when zooming out. At 100% zoom
and further in things look great."*

---

## 0. The one-paragraph answer

MSA answers texture minification by **adding contrast in screen space, at reduced
resolution, twice** — instead of by resolving more pixels and building better mips. Every
symptom in the complaint is a predicted output of that choice. The three loudest
contributors are all *outside* the texture path that four previous rounds of work
optimised, which is exactly why those rounds kept measuring "the gap is only ~8%" while
the author kept seeing something much worse.

The single most important structural fact: **on a HiDPI display MSA currently shades
somewhere between 22% and 44% of the pixels the monitor actually has**, then bilinear-
upscales the result and sharpens it. That is a 2015-era upscaling pipeline, and it is
being asked to carry a hand-painted ink-art map.

---

## 1. What we do right now — the chain, end to end

The streaming/virtual-texture atlas was removed 2026-07-22 (`vt/index.js` header). Albedo
ships through the **whole-image path**: art is loaded whole, split into at most a handful
of static textures, and drawn as plain quads.

| # | Stage | Where | Effect on zoom-out clarity |
|---|---|---|---|
| 1 | Fetch + banded decode off-thread | `vt/bc-compress.worker.js` | neutral |
| 2 | Tile split if `> min(HW limit, 8192)` | `vt/texture-limits.js#planImageTiles` | **no gutter, no overlap** — see 2.6 |
| 3 | Mip chain: **cascaded Lanczos-2** halving, premultiplied, dilated, in **sRGB-byte (gamma) space** | `vt/mip-resample.js` | sharp but ringing; cascade compounds; stopband leakage → residual aliasing at coarse levels |
| 4 | Per-level block encode: **BC1 if fully opaque** (i.e. the base map), BC7 if any alpha | `bc-compress.worker.js:521` | BC1 = 4 colours per 4x4 block from RGB565 endpoints, applied to **every** level |
| 5 | Upload with `colorSpace = SRGBColorSpace` | `vt-pan-viewer.js:11471-11486` | resolves to `bc1-rgba-unorm-srgb` / `bc7-rgba-unorm-srgb` (`three.webgpu.js:71387,71408`) |
| 6 | Sampler: `LinearMipmapLinearFilter` + `LinearFilter` mag + `anisotropy 16` | same | **hardware decodes sRGB→linear BEFORE filtering** — so all trilinear blending happens in linear light, over mips that were authored in gamma |
| 7 | Fragment: 5-tap **CAS sharpen**, gamma-2.0 space, **per-channel weights**, gated on `texelsPerPixel` | `vt/albedo-clarity.js#buildAlbedoClarityNode` | full strength across the entire practical zoom-out range; amplifies 3, 4 and 6 |
| 8 | +1 extra `texture(...).level(0)` tap for `buf:scene.attr` solidity | `vt-pan-viewer.js:9866` | perf, not quality — but see 2.7 |
| 9 | Rendered into `scene.color` at `internalW x internalH = drawBuf x internalScale` | `describeSceneColor`, `vt-pan-viewer.js:1898` | governor default is **`auto`**; ladder `[1.0, 0.85, 0.7, 0.6, 0.5]` |
| 10 | Present: bilinear upscale internal→drawBuf, **plus a second CAS** | `effects/grade/grade-present.js` | mush, then a contrast boost applied to the mush |
| 11 | Browser composites drawBuf → physical pixels at `devicePixelRatio` | — | MSA sets `pixelRatio = min(foundryResolution, 1.5)`, and **forces `foundryResolution` to 1** — see 2.1 |

There is **no TAA, no jitter, no temporal accumulation anywhere in the codebase** (grepped:
`jitter|TAA|temporal|halton` — every hit is perf-timing jitter, none is antialiasing).

Internal targets are `HalfFloatType` / `NoColorSpace`, so precision/banding is *not* a
suspect. That one's clean.

---

## 2. The findings, ranked

### 2.1 — 🔴 MSA throws away most of a HiDPI display's pixels, on purpose, for every player

`boot.js:12615` forces `core.pixelRatioResolutionScaling = false` at every `ready`, for
every player. MSA's own comment (`vt-pan-viewer.js:1527`) states the consequence plainly:
*"`foundryResolution` should read 1 for everyone by the time this runs."*

So `resolvePresentPixelRatio(1, 1.5)` → **`pixelRatio = 1`**. The WebGPU drawing buffer is
CSS pixels. Then the governor's `internalScale` cuts *that* by up to half again.

On a 3840x2160 monitor at Windows' default 150% scaling (CSS viewport ~ 2560x1440):

| Governor rung | Internal buffer | Fraction of the monitor's real pixels | Upscale to display |
|---|---|---|---|
| 1.00 (best case) | 2560x1440 | **44%** | 1.50x |
| 0.85 | 2176x1224 | 32% | 1.76x |
| 0.70 | 1792x1008 | **22%** | 2.14x |
| 0.50 | 1280x720 | 11% | 3.00x |

The map art is minified into that buffer, then blown back up by a non-integer factor, and
CAS-sharpened on both sides of the upscale. Non-integer upscaling of an image that is
already packed with Nyquist-limit detail is *precisely* how you manufacture moiré,
shimmer and "pixelated."

Note the setting is re-forced every session — a player who sets it back cannot keep it.

**Why this fits the report so exactly:** at 100% zoom the art is *magnified*, so the image
is smooth and upscaling it is benign — and CAS is gated off entirely (`gateLo = 1.0`).
Zoomed out, all of it engages at once. The author's "great zoomed in, awful zoomed out" is
not a coincidence; it is the literal shape of the gate.

⚠️ **Verification gap, stated honestly:** the vendored Foundry v14 source is not present in
this checkout (`FoundryVTT/.../resources/app/` is absent), so I could not confirm from
Foundry's own code that `pixelRatioResolutionScaling: false` yields `resolution === 1`. That
step rests on MSA's own comment. It is trivially checkable live — see section 5.

### 2.2 — 🔴 We sharpen the same image twice, and the code says nobody has checked what that looks like

Two independent CAS passes can be live on the same frame:

- `buildAlbedoClarityNode` — per-material, on the albedo, strength **0.22** (stock
  FidelityFX CAS *maximum* is 0.2, so we ship above it).
- `buildPostUpscaleSharpenNode` — fullscreen at present, up to **0.12**, whenever
  `internalScale < 1`.

`albedo-clarity.js`'s own header:

> *"Two contrast boosts in a row risk compounding into something too harsh… This is a
> FLAGGED risk, not a solved one: it needs a live visual check stacking both passes on real
> art, not a static guess."*

That check has not happened. And since the governor defaults to `auto`, the second pass is
live for most players most of the time — the stacking is the *default* configuration, not
an edge case.

Compounding matters more than it sounds: CAS is not idempotent. Running it twice does not
give you 0.34 of one pass; it re-sharpens the *ringing* the first pass introduced.

### 2.3 — 🔴 The CAS roll-off is tuned to never engage in the range being complained about

Defaults: `gateLo 1.0`, `gateHi 1.8`, `farLo 6.0`, `farHi 16.0`, `farFloor 0.35`.

The code's own note: *"on the author's 6750² ground, the whole map on screen is about 5.4
texels per pixel, so the default keeps FULL strength through every normal zoom and only
backs off beyond a whole-map view."*

Read that again — the roll-off that exists specifically to stop CAS emphasising the texel
grid **does not start until past a whole-map view**. Every zoom level the author is
complaining about runs at full, unattenuated 0.22.

### 2.4 — 🟠 CAS weights are per-channel, which is chromatic fringing, and it is a known open bug

`sharpenCasCore` computes `mn`/`mx`/`amp`/`w` as `vec3` — R, G and B each get an
independently-derived sharpen weight from their own local min/max. On a coloured edge each
channel is pushed by a different amount: a **hue shift at the edge**, not a brightness one.

Already measured and documented in-file: a BC1-encoded tan/wine-red edge at the shipped
0.22 default moved R/G/B by **-43% / -83% / -53%** at the same boundary texel. On the bench
Mansion at 0.4 it is "a visible rainbow halo" on every wall and furniture edge.

Per-channel chroma noise on a minified image is a very good description of "grainy."

A luma-locked fix was attempted and abandoned as unverified. Worth noting: **AMD's own CAS
derives the weight from a shared value and applies it to all three channels** — the
reference implementation does not have this problem, and matching it is the fix.

### 2.5 — 🟠 Mips are built in gamma space; the GPU filters them in linear space

`mip-resample.js` performs Lanczos-2 on raw 8-bit RGBA straight out of `getImageData` —
**no linearization anywhere in the file** (grepped). Those are sRGB-encoded bytes.

The texture then uploads as an `-srgb` GPU format, and per the WebGPU/D3D/Vulkan spec,
sRGB formats are decoded to linear **on texel fetch, before filtering**. So:

- the *stored* mip levels match PIXI (gamma-averaged),
- but every runtime bilinear/trilinear/anisotropic blend between them happens in **linear
  light**, which PIXI never does.

Linear-space filtering of a black ink line on light paper gives a midpoint of sRGB ~188
where gamma-space filtering gives ~128. Ink edges come out **lighter and softer** than the
artist drew them, and lighter than PIXI shows them. The project's own bench already
isolated this at **-15% RMS contrast** — then classified it "real but small" and went
looking for a sharpening filter instead of fixing it.

This is not a preference call. It is an internal inconsistency: two halves of one filter
chain disagreeing about what space they are in.

### 2.6 — 🟠 Tiled maps have no gutters, so >8192px maps get seams at zoom-out

`planImageTiles` splits into sub-rects that tile the image *"EXACTLY (no gaps, no
overlap)"*. Each tile becomes its own texture with its **own independent mip chain** and
`ClampToEdge`. Adjacent tiles' edge texels never see each other at any level.

`MAX_WHOLE_TILE_DIM = 8192`, so the 12000² mansion loads as 2x2 of ~6000². At LOD *n*,
each side of a tile boundary shows ~2^(n-1) base texels of clamped constant colour. At LOD 4
that is roughly 8 base texels of smear on each side of a cross running down the middle of
the map — and the smear grows as you zoom out.

Under 8192 (a 6750² map) this is inert — one tile, no seam. So it is **size-dependent**,
which would explain it showing up on some maps and not others.

### 2.7 — 🟡 A full-resolution `level(0)` tap runs on every albedo fragment, and it is worst at zoom-out

`physicalSolidityAlpha` (`vt-pan-viewer.js:9866`) samples the art at a forced mip 0. The
reason is sound — a coarse mip's averaged alpha gave wrong answers to "is there real art
here" (documented round 10, 2026-08-04).

But the cost profile is nasty at exactly the wrong time: at LOD 4, adjacent screen pixels
read base texels ~16 apart, so every fragment's mip-0 tap is a fresh cache line on a 6750²
texture. This is the 6th of 6 taps in `geometry.worldDraw` — **80.5% of frame GPU** per the
ceiling analysis — and it is the only one whose cost *grows* as you zoom out. Plausibly a
meaningful slice of why the governor decides to downscale when you zoom out, which then
causes 2.1. Unmeasured; flagged as a hypothesis.

### 2.8 — 🟡 Cascaded Lanczos-2 is an aggressive choice for a mip chain

Lanczos-2 has real negative lobes — deliberately, and the file says so: *"sharper than the
box filter PIXI's `gl.generateMipmap` uses."* It also leaves stopband leakage above
Nyquist and overshoots at high-contrast edges.

The chain **cascades** (level *n* from level *n-1*, for memory reasons that are entirely
legitimate). That means ringing and leakage compound: by level 4 you are looking at four
generations of accumulated overshoot, and then BC1-quantising it, and then CAS-sharpening
it on screen. Three sharpening-flavoured operations stacked on one image.

### 2.9 — 🟡 BC1 is the lowest-quality format available, and we use it on the hero texture

The base map is fully opaque, so it routes to **BC1**: 4 bpp, four colours per 4x4 block,
interpolated between two RGB565 endpoints. BC7 (used only for alpha-bearing art) has 8
modes, up to 3 subsets and 7-bit endpoints.

The encoder has been improved twice (v8 endpoint bias, v9 PCA + least-squares) and is now
genuinely good *for BC1*. But the ceiling is the format. And the memory argument only
really applies to level 0: **mips 1 and below are one third of the chain's bytes**, and
they are where all the complaints live.

### 2.10 — ⚪ Anisotropy 16 does nothing for the base map (correctly)

Worth stating so nobody reaches for it as a lever. Under a top-down orthographic camera a
uniformly-scaled floor quad has an isotropic footprint; aniso only pays on rotated/
non-uniformly-scaled props, which is exactly what the constant's own doc says. It is not a
zoom-out lever here.

---

## 3. Why four previous rounds did not close this

Rounds 1-2 (2026-07-19) asked *"which mip level do we sample?"* and matched PIXI. Round 3
(2026-07-28) measured the whole MSA-vs-PIXI texture-path gap at **~8%** and correctly
concluded the loss is inherent to minification — then reached for CAS.

That measurement was right, and it is exactly why the complaint survived: **the bench
modelled the texture path only.** It did not model the render-scale downscale, the present
upscale, the pixel ratio, or two CAS passes stacking — because at the time, none of those
existed. Three of the four biggest contributors identified here postdate the bench that
exonerated the pipeline.

There is also an instrument caveat: the bench scores **RMS contrast**, which cannot tell
"restored detail" from "quantisation noise." The v9 note that BC1 *raised* RMS contrast
(95.39 → 101.34) is the tell — that was posterisation reading as a win.

---

## 4. How the best engines solve this

### 4.1 They do not sharpen to fix minification. They supersample — temporally.

The entire modern AAA answer is temporal supersampling: **TAA**, Unreal's **TSR**, NVIDIA
**DLSS**, AMD **FSR2/3**, Intel **XeSS**. Jitter the projection matrix by a sub-pixel
offset each frame (Halton(2,3) is the standard sequence), reproject the previous frame
using motion vectors, accumulate with a neighbourhood clamp.

This is the only family of techniques that genuinely **recovers detail below single-frame
Nyquist**, rather than faking its absence with local contrast. Over 8 frames you get
roughly 8x supersampled minification for the cost of one extra fullscreen pass.

**MSA is an unusually easy case for this.** TAA's hard problems are disocclusion, dynamic
geometry, and skinned characters producing bad motion vectors. MSA has an orthographic
camera over an essentially static 2D plane — motion vectors are a closed-form function of
the camera delta, and there is almost nothing to disocclude. This is TAA on easy mode, and
it is the highest-quality-per-effort option on the table.

It also converts the render-scale governor from a *quality tax* into a *temporal
upsampler* — which is precisely what DLSS/FSR2 are, and why modern engines can drop to 60%
internal resolution and still look sharper than native.

### 4.2 Sharpening is one pass, at the end, from a shared weight

AMD's CAS and FSR's RCAS are specified to run **once, on the final image, as the last
stage**. Not per-material. Not twice. And the weight is derived once and applied to all
channels — which is the documented fix for 2.4.

Running a sharpen inside a per-object material is not a technique any production renderer
uses, and it costs 4 extra texture taps in this project's most expensive pass.

### 4.3 Mip generation is an offline, per-texture, *tunable* decision — and it is rarely Lanczos

- **Unreal** exposes `MipGenSettings` per texture: `SimpleAverage` (the default),
  `Sharpen0`…`Sharpen10`, `Blur1`…`Blur5`, `Unfiltered`, `Angular`. Sharpening is opt-in
  *per asset*, because it rings and artists need to choose.
- **NVIDIA Texture Tools** and **AMD Compressonator** default to a **Kaiser-windowed
  sinc** with a tunable stretch/alpha parameter — chosen specifically so you can dial the
  stopband and avoid Lanczos's ringing.
- Production chains that care about the tail either use a cascade-stable filter or reduce
  each level **from the source** rather than from the previous level.

### 4.4 Statistic-preserving mip generation — the *right* home for what CAS is doing

Ignacio Castaño's **coverage-preserving alpha mipmaps** (NVIDIA, 2010) solved the identical
shape of problem for alpha-tested foliage: naive mip averaging makes leaves dissolve as
they minify, so each level is rescaled until its *coverage statistic* matches level 0. It
is now standard in every engine that ships foliage.

The direct analogue for ink linework: after each reduction, correct the level so a
**contrast statistic** (e.g. the 5th-percentile local luminance, or local RMS contrast)
matches the base level. Dark outlines then survive minification because the mip *itself*
preserves them.

This is strictly better than a fragment-shader sharpen in four ways: it is **deterministic**,
**temporally stable** (cannot shimmer as the camera moves), **free at runtime**, and it
**cannot amplify BC block error**, because it runs before the encoder.

If MSA does one structural thing from this document, it should be this one. It lets the
per-material CAS be deleted outright.

### 4.5 Format follows content

BC7 is the default basecolor format on desktop in both Unreal and Unity now; BC1 is the
"give me the memory back" fallback. Nobody compresses the small mips hard to save space —
the whole tail below level 0 is a third of the chain.

### 4.6 Rendering below display resolution is a *performance* trade, owned as one

Modern engines only pair sub-native rendering with a temporal upsampler, precisely so the
reconstruction is not bilinear-plus-sharpen. Bilinear + sharpen is what upscaling looked
like before DLSS existed.

### 4.7 One classic that does *not* apply here

Negative mip LOD bias (-0.5) plus 16x aniso is the standard cheap sharpness lever. It works
because aniso cleans up the extra aliasing the bias introduces. **Under MSA's orthographic
uniformly-scaled floor the footprint is isotropic, so aniso does not clean anything up** —
a bias here would be pure added aliasing. Noting it explicitly so it doesn't get proposed
later as free sharpness.

---

## 5. Options, ranked

### Tier A — costs nothing, answers the question today

| | Action | Answers |
|---|---|---|
| A1 | `MapShine.getRenderScaleState()` while zoomed out | Is `resolvedInternalScale < 1`? Then 2.1/2.2 are live right now. |
| A2 | Set **Render Resolution → "100% — Native"**, look again | Isolates the governor's contribution |
| A3 | `MapShine.setAlbedoClarity({ enabled: false })` — live, no reload | Isolates CAS. If the grain vanishes, we sharpen too hard. |
| A4 | `devicePixelRatio` in the console | If > 1, 2.1 is costing that fraction squared |

### Tier B — small, high-confidence, low-risk

| | Change | Why |
|---|---|---|
| B1 | **Pick one sharpen.** Drop the per-material CAS; keep the post-upscale one. | Kills the unverified stacking risk, kills the fringing bug, and removes 4 taps from `worldDraw` (80% of frame GPU) — a quality *and* perf win in one edit |
| B2 | **Luma-locked CAS weight** — derive `amp`/`w` from shared Rec.709 luma, apply to all channels | Matches AMD's reference; kills 2.4 |
| B3 | **Pull the roll-off in**: `farLo 6.0 → ~2.5`, `farHi 16 → ~6` | Right now full strength covers exactly the complaint range |
| B4 | **Stop forcing Foundry's checkbox off unconditionally.** Make present pixel ratio an MSA setting; let the *governor* be the perf lever it was built to be | Restores up to 2.25x the shaded pixels on a 150% display |
| B5 | **Encode mips 1+ as BC7 even when level 0 is BC1** | ~+33% VRAM on the mip tail only; removes BC1 block error exactly where the complaint lives |
| B6 | **Tile gutters** — 4-texel overlap per tile edge, or prefer a single texture where HW allows | Fixes 2.6 for >8192 maps |

### Tier C — structural, and the right long-term shape

| | Change | Why |
|---|---|---|
| C1 | **Resolve the colour-space mismatch.** Build mips in linear (keep the sRGB format), *or* upload non-sRGB and decode in-shader after filtering (PIXI parity). Either — but be consistent. | 2.5 is an internal contradiction, not a tuning choice |
| C2 | **Contrast-preserving mip generation** (4.4) | Moves the repair offline where it is deterministic, stable, free, and upstream of the encoder. Lets B1 delete the per-material CAS with nothing lost. |
| C3 | **Kaiser-windowed sinc** instead of cascaded Lanczos-2, or reduce from source | Removes one of three stacked sharpening operations |

### Tier D — raises the ceiling

| | Change | Why |
|---|---|---|
| D1 | **Temporal supersampling** — Halton jitter + reprojection + neighbourhood clamp | The actual answer to "clearest possible zoom-out." Ortho 2D static scene is the easy case. Also converts the governor from a quality tax into a temporal upsampler. |
| D2 | **Let `SCALE_LADDER` go above 1.0** (1.25 / 1.5) as an explicit SSAA option | `computeRenderSize` already handles it; only `Math.min(1, scale)` in `computeRenderSize` and `governorScale <= 1` in `resolveInternalScale` block it. Roughly a three-line change for a real quality tier on capable hardware. |

**If only three things happen: B1, B4, C2.** Those are, in order, the double-sharpen, the
thrown-away pixels, and the correct home for the repair.

---

## 6. Status

`BUILT (unverified)` does not apply — nothing was built. This is a read-only audit.
Every section-2 finding is traced to shipped source; 2.1's Foundry-side step and 2.7's cost
claim are explicitly marked as unverified hypotheses.
