# Performance Audit — 2026-08-08 — the code-read problem list

**What this is:** a systematic read of every renderer subsystem, hunting for work that is done twice,
work that is done for pixels the camera cannot see, and patterns that are starting to cost more as
the codebase grows. It started as **a list of problems, not a list of fixes** — most of it still is.
**Update 2026-08-09:** a real live perf report landed and 8 CPU-only fixes went in on the strength of
it. See §12 for exactly which entries are now fixed, which were investigated and deliberately
deferred, and why — the rest of this document is otherwise unchanged from its original form.

**What it is NOT:** a measurement. `Performance-Insights.md` is the measured ledger and stays the
authority on what the frame actually costs. This document is upstream of it — it says *where to
point the instrument next*, and every entry carries the specific measurement that would settle it.

**Why now:** the last audit closed 2026-07-29. Since then the depth authority, the sun-shadow
layer-smear + cascade, the aperture gobo, the point-light pool, the vegetation tier ladder, depth of
field, `buf:scene.depth` and a 1,376-line BC7 rewrite all landed. **None of that has ever been
perf-reviewed, and two of the new items directly invalidate claims still printed as fact in
`Performance-Insights.md`.**

**Standing rule, unchanged (author, 2026-07-28):**

> _"We fix performance, we don't just hide performance problems."_

No entry below is closed by turning an effect off.

---

## 0. How this was produced, and how much to trust each line

Eleven independent readers, one per subsystem, each given the two existing performance documents so
they would not re-report known items. Six of the eleven were then handed to an **adversarial
verifier** whose job was to open the cited lines and try to refute the finding. That pass did its
job: it **refuted one finding outright**, and corrected the size estimate on five more — in every
case *downward*. The remaining five territories ran out of budget before verification.

**Confidence vocabulary used throughout, and it is load-bearing:**

| Tag | Means |
| --- | --- |
| ✅ **CONFIRMED** | A second reader opened the cited lines and the mechanism is exactly as described |
| 🟡 **PLAUSIBLE** | Verified as written, but something material (a runtime value, a real frequency, a driver behaviour) could not be settled by reading |
| ⬜ **UNVERIFIED** | One reader only. The mechanism is quoted from source, but nobody has independently checked it |
| ❌ **REFUTED** | Looked right, is wrong. Kept, because a killed theory is worth more than a live guess |

⚠️ **Even that was not enough.** Spot-checking the top recommendation afterwards found that **two
independent readers had both misread the same API** — see §4.3. Neither the readers nor the verifier
caught it. Treat every ⬜ entry accordingly: the mechanism is usually right, the surrounding claim
about *what to do* is the part that slips.

⚠️ **Sizes in this document are arithmetic, not measurements.** Where a size is given it is derived
from `Performance-Insights.md`'s own calibrations. This project has a recorded case of a perf
estimate being wrong by 4× from counting texture fetches as units of time
(`feedback_measure_the_output_not_the_equation`); every entry that could repeat that error says so.

### Coverage gaps — read before assuming this is complete

- **The surface stage was never audited.** The `specular / water / fluid / windows` reader died
  mid-response. Specular, the JFA water SDF, `fluid-net.js` and the window aperture are **not
  covered below** except incidentally. This is the single biggest hole and should be the next run.
- **Five territories are unverified** — culling, sun-shadows, geometry-effects, buffers-post,
  diag-ui-overhead. Their findings are marked ⬜ and their sizes should be treated as one reader's
  arithmetic, not as a second opinion.
- **No completeness critic ran.** `src/boot.js` (7,128 lines) and `src/foundry/` were only read
  incidentally, and nothing systematically asked about shader-permutation compile stalls at scene
  load, long-session memory growth, low-end GPU behaviour, or scene-switch cost.

---

## 1. Three things this audit established before anything else

These reframe the whole target list, so they come first.

### 1.1 ✅ Render-target bandwidth is **not** the constraint — counted, not assumed

The buffers reader was told to count every screen-sized target and produce a GB/s figure. It did:
**~390 MB of screen-sized targets across 19 attachments, ~865 MB of full-screen traffic per frame,
~52 GB/s at 60 fps.**

Then the calibration that settles it: `light.drawComposite` moves ~234 MB in a measured **0.28 ms**
— an effective **~836 GB/s**. A demand of 52 GB/s against a demonstrated supply above 800 GB/s means
**framebuffer bandwidth has ~16× headroom.** Format narrowing (§5.4) is VRAM hygiene, not a
millisecond lever, and should not be sold as one.

That same ratio is what exposed §3.4: `present.blit` moves only 88 MB but takes 0.67 ms — an
apparent 131 GB/s, **6.4× worse per byte than the composite on the same GPU**. Two zones cannot have
a 6× bandwidth spread. Present is not moving bytes; it is doing maths.

### 1.2 ❌ REFUTED — "a full-screen quad is drawn per point light"

This was the prime suspect named going in, and it is wrong. `point-light-pool.js:1211-1212` sets
`mesh.position` to the light origin and `mesh.scale` to `light.radius`, over geometry
`triangulateLightFan` normalises to unit radius. **The 91 draw calls in `Performance-Insights` §5B
are 91 real wall-clipped light polygons, not 91 screen quads.** The light zones are expensive for
other reasons — §3.1, §3.2 and §3.3 — and any plan built on "stop drawing full-screen per light"
should be dropped now.

### 1.3 ⬜ Branch (b) is literally in the code — and half of it landed *after* the last measurement

`Performance-Insights.md` §9 names one surviving hypothesis for `geometry.worldDraw`: *"mip-0
sampling of the 6750² BC7 atlas at arbitrary zoom, plus per-fragment MRT write bandwidth."* §1.1
just eliminated the bandwidth half. The mip-0 half is not a hypothesis — it is two explicit
`.level(float(0))` calls (§4.1), one of which was **added on 2026-08-04, after the measurement that
produced the hypothesis.** And the mask path has the identical defect by omission (§4.2).

---

## 2. The ranked target list

Ordered by expected value = (size × confidence) ÷ risk. The frame sits at **17.83 ms GPU straddling
the 16.67 ms vsync step**, so per §2B's own conclusion the next 1–2 ms is worth more than the last 8.

| # | Target | Est. | Conf. | Visual risk | § |
| --- | --- | --- | --- | --- | --- |
| 1 | Illumination + coloration are two draws recomputing one shared core | 0.6–0.9 ms typical · **2.6–3.9 ms** candle scene | ✅ | none | 3.1 |
| 2 | Half-res `scene.illum` + `scene.coloration` | **~2.0 ms** typical · ~9.8 ms candle scene | ⬜ | minimal | 3.2 |
| 3 | Six sun-shadow slots sampled per fragment on every scene | ~1 ms guess, **one-constant A/B settles it** | 🟡 ×4 finders | none | 3.3 |
| 4 | Uniform-valued wind + flicker noise evaluated per fragment | 1.3–2.6 ms if ALU-bound | ✅ | none | 3.5 |
| 5 | `geometry.depthDraw` — front-to-back opaque pass whose `discard()` disables early-Z, on ~5 layers of forced mip-0 taps | ~37 M unrejectable mip-0 taps/frame; **ms unmeasured** | ✅ **deep-dived** | none | 4.3 |
| 6 | Two forced mip-0 BC7 fetches per background fragment | unsized; working set 16–500× larger | ⬜ | minimal | 4.1 |
| 7 | Every mask texture has mipmaps disabled | 0.2–1.0 ms at zoom-out | ✅ | minimal | 4.2 |
| 8 | Present runs two grade stacks + LUT at identity | **0.25–0.45 ms, every frame, every scene** | ⬜ | none (byte-identical) | 3.4 |
| 9 | Sun-shadow bakes every floor on every sun step | unsized; **can fire every frame** | ⬜ | none | 6.1 |
| 10 | One slider/tile-edit cascades into sun-shadow + water + **wind + light-material rebuild + outdoors + fire** rebakes | unsized; editing-cadence, not frame-cadence | ✅ **mechanically confirmed, blast radius now 5 pipelines** | none | 5.8 |
| 11 | Aperture gobo: O(lights × walls)/frame + a shader-rebuild key | CPU + hitch risk | ✅ | none | 5.1 |
| 12 | Window glass gate never wired to `glassWarpPx` — always-on 5-noise-tap + caustic chain | unsized; confined to window coverage | ✅ | **none if fixed** (matches author's own stated intent) | 5.9 |

Below the line, in §§4–7: eleven more confirmed items that are cheap, safe and small, four
load-time stalls measured in whole seconds, and six instrument defects.

---

## 3. THE LIGHTING STAGE — the frame's centre of gravity

On a candle-heavy scene `light.drawPointLights` (6.571 ms) + `light.drawColoration` (6.541 ms) =
**13.1 ms of a 20.4 ms frame, 64%.** Four of the audit's top five items live here.

### 3.1 ✅ CONFIRMED — illumination and coloration are two full draws of the same geometry, recomputing a large shared core

`src/effects/lighting/point-light-pool.js:387,427` · `point-light-illumination.js:1476` · `point-light-coloration.js:451` · `src/vt/vt-pan-viewer.js:4481,4522`

`createLightEntry` builds **two meshes over one shared `geometry` object** and the frame issues two
separate `renderer.render()` calls over the same covered pixels.

The two shaders are **not** "the same thing plus an albedo tap". Verified line by line, they each
independently recompute: `dist = length(positionLocal.xy)`; the identical `falloff` (literally the
same imported function); `buildDepthHeightGateNode` **including its two `screenUV` samples of
`buf:scene.depth`**; `buildApertureGoboTerm` in its entirety for any light near a window; a full
`windHandle.node()` wind-field sample for any candle; and `buildAnimationTimeNode`. Coloration's
only unique work is one albedo tap + OETF + a BT.709 dot; illumination's is switchColor + exposure +
the sun-shadow block.

**Both write with byte-identical blend state** — the same seven `CustomBlending / MaxEquation /
OneFactor` assignments — **into byte-identical targets**, both `allocator.create(..., describeSceneColor())`.

> **The tell that the shared core dominates:** the two zones measure within **0.5%** of each other.
> If coloration were "illumination plus one albedo tap" it would read ~18% higher, as it does on the
> 17-light scene. It does not.

⚠️ **This invalidates `Performance-Insights.md` §5**, which closed the point-light asymmetry as
*"explained, not a defect… there is no waste."* The asymmetry was explained correctly; the
duplication underneath it was never examined.

**Settle it:** (a) confirm three's WebGPURenderer applies one `CustomBlending` state to both
attachments of a 2-attachment target — the MRT primitive itself is already proven live by
`scene-attr.js#describeSceneAttrMrt`. (b) Size it before building: comment out the coloration
`render()` and read the delta against `light.drawPointLights`.

### 3.2 ⬜ The concrete form of the DPR meta-lever: half-res illum + coloration

`src/vt/vt-pan-viewer.js:1477,1530,1539`

`Performance-Insights.md` §6 proposes *"render effects at reduced resolution while keeping the map at
full resolution"* and names no targets. **These are the targets.** Both are allocated at full
drawing-buffer resolution via `describeSceneColor()`, both are pure fill from the frame's two most
expensive zones, and **their content is low-frequency by construction** — an ambient colour uniform,
a sky tint, a sun-shadow field baked at 1024² over the whole map, and analytic SDF falloffs. The
composite already reads both with `filter: 'linear'`, so a half-res source upsamples bilinearly for
free.

Quartering the fragments in both zones: **2.72 ms → ~0.7 ms** typical, **13.1 ms → ~3.3 ms** on the
candle scene. `scene.color`, `scene.attr`, `scene.lit` and the depth authority all stay at full
resolution — **the pen-outline crispness §6 exists to protect is not involved at all.**

⚠️ **The obstacle, named rather than hand-waved:** `point-light-illumination.js:1374-1385` samples
`buf:scene.depth` at `screenUV` for its height gate and per-floor shadow attribution. A half-res
light pass sampling a full-res depth buffer is a resolution mismatch that must be reasoned about
before this is a two-line change.

**Settle it:** give `describeSceneColor` a `scale` and allocate only those two at 0.5×. Run the
route, read the two zones. This is an experiment before it is an architecture change.

### 3.3 🟡 PLAUSIBLE (found independently by **four** readers) — six sun-shadow slots sampled per fragment, on every scene, forever

`sun-shadow-subsystem.js:341,1417` · `environmental-light.js:394,701` · `point-light-illumination.js:1366,1386`

`SUN_SHADOW_MAX_FLOORS = 6`, and the slot pool is built **unconditionally, all six, at construction,
before any floor claims one**. `environmental-light` maps all six into `sunShadowSlots`; the pool
forwards all six into every light; both the full-screen ambient quad **and every point light's
illumination material** unroll over all of them. The only gate is `.length > 0` — never a scene
floor count, so the compile-out arm is dead code.

Per slot, per fragment, per light: 2 subs + 2 divs + 2 clamps + a `texture.sample()`, then an abs +
smoothstep + presence-mul + 2 adds in `blendSunVisibilityAcrossFloors`. **On a single-floor scene
five of the six read a 1×1 placeholder whose weight is provably zero.**

⚠️ **Sized as ALU, deliberately NOT as fetches.** The five wasted taps hit tiny cache-resident
textures; this is an instruction-count story, not a bandwidth one. Repeating §4's fetch-counting
error here would be the obvious trap. What is *removed* on a one-floor scene is ~65 scalar ops per
fragment per light, out of a shader whose other terms are falloff (~8), depth gate (~12),
switchColor (~10) and exposure (~12) — plausibly the single largest ALU term in the shader.

Also: 5 × 4 MB of never-written 1024² render targets, 96 MB at the extreme rung.

**Settle it — this is the cheapest high-value experiment in the document.** Temporarily set
`SUN_SHADOW_MAX_FLOORS = 1` on a single-floor scene, run the fixed route, read `light.drawPointLights`.
One constant, no design work.

### 3.4 ⬜ The present pass runs two full grade stacks plus the 3D-LUT bracket at ship-default identity

`src/effects/grade/grade-present.js:113-126` · `grade-ops.js:290,319` · `src/vt/vt-pan-viewer.js:4114,4121`

`rebuildFragment()` composes `buildGradeNode` twice (env scope, then artistic scope) and **always**
appends the LUT bracket, because `lutTexture` is always supplied — a 2³ identity placeholder. Per
pixel that is `pow(2, exposure)` + a vec3 gamma pow per scope, plus `sRGBTransferOETF` (3 pow) + a
texture3D fetch + `sRGBTransferEOTF` (3 pow), then `mix(c, out, 0)`. **≈14 `pow()` and one texture3D
fetch per pixel that cannot change a single output byte at ship defaults.**

Worse: the env scope's lift/gamma/gain are **provably identity forever** — `resolveEnvGrade`
hard-codes `lift:[0,0,0], gamma:[1,1,1], gain:[1,1,1]` on every return path, and
`scaleGradeToIdentity` only lerps toward the same identity. Three of those pow calls can never do
anything, at any time of day, under any weather.

The cross-check from §1.1 is what makes this credible: present reads one texture and takes 0.67 ms;
the composite reads three and takes 0.28 ms. Scaling the measured 0.67 ms by pow count gives
**~0.25–0.45 ms recoverable, on every frame of every scene, with byte-identical output.**

The mechanism to fix it already exists and is already proven — `rebuildFragment()` is already
re-invoked on a compile-time change (the tone-map swap).

### 3.5 ✅ CONFIRMED — a 13-noise wind sample whose every input is a uniform, evaluated per fragment, in both light shaders

`point-light-illumination.js:1181-1193` · `point-light-coloration.js:401-411` · `world/wind-field.js:659-762` · `animations/candle-flicker.js:189`

`windHandle.node()` is called with `centerXY: uWindCenter` (uniform, built from the light's fixed
x/y), `time: uGlobalTimeMs` (uniform), `exposure: uWindExposure` (uniform). **Every input is a
uniform, so the result is a per-draw constant** — and it lives in `material.fragmentNode`, so it is
evaluated at every pixel the light disc covers.

Counted from the bodies, not the comments: `sampleWind` does 5 `mx_noise_float`, then
`computeWindTurbulence` runs `curlNoise2D` twice at 4 perlins each = **13 2D perlins**, plus 2
clamped texture taps, plus the wall-deflection projection and two energy caps. `candleLife` adds 5
more perlins driven purely by the uniform time node. **≈18 uniform-valued perlin evaluations plus 2
texture taps per fragment** — and the whole block is built **twice** per light, since illumination
and coloration are separate materials (§3.1).

A `varying()` hoist moves this to **192 vertices per light per pass** — under 0.1% of the fragment
invocations. **A value constant across the primitive interpolates to itself exactly, so this is
lossless by construction.**

⚠️ The verifier corrected the light count *upward*: §5B's 91 draw calls appear in **each** of the two
zones, so that scene has ~91 lights, not ~45. The fragment multiplier is ~2× larger than first
estimated.

⚠️ This is the direct inverse of a decision already on record: §5D *"noted and deprioritised — the
per-fragment constants in the flame shader."* That was the right call for the **flame** shader,
measured at 0.022 ms. The same pattern in the **light** shaders sits inside 64% of the frame.

### 3.6 ✅ CONFIRMED — `computeAmbientColors` runs once per light per frame, producing an identical answer

`point-light-pool.js:1228` · `region-geometry.js:674` · `vt-pan-viewer.js:4239`

`computeRegionAdjustedDarkness` opens `if (!Array.isArray(regions) || regions.length === 0) return
darkness01;`. With no active regions — the common case, and exactly the state §2/§2B measured —
every light computes the identical three RGB triples, each with a `{...env}` spread of the whole
snapshot plus four `mixRgb` allocations. **~6 fresh objects per light per frame.** And the frame
loop already computed the un-adjusted answer 150 lines earlier (`lastAmbientColors`).

The per-light *uniforms* must stay — they fix a real live bug (the hard seam at a light's boundary
inside a darkening region). Only the recomputation is waste.

### 3.7 ✅ CONFIRMED — the soft-edge SDF is disabled by a `void`, and everything feeding it still runs

`point-light-illumination.js:1293` (`let combinedFalloff = falloff; void edgeSoftFactor;`)

Dead since 2026-07-19, under a 16-line comment saying not to re-enable it without a live A/B.
Nothing downstream was switched off: every material still allocates 64 `Vector2`s plus a
`uniformArray`, and `update()` still calls `writeLightEdgePoints` for every light every frame —
which calls `normalizeLightPolygon`, allocating **two fresh `Float64Array`s**, two lines after
`triangulateLightFan` allocated two more on the same polygon. **4 typed-array allocations per light
per frame, half of them feeding a term that is compiled out.** At 91 lights: ~22,000/second, ~11,000
pure waste.

### 3.8 ✅ CONFIRMED — every light's fan geometry is re-triangulated and re-uploaded every frame, moved or not

`point-light-pool.js:1191-1207`

No dirty check on `(x, y, radius, shapePoints)`. `entry.positionAttribute.needsUpdate = true` fires
on every ordinary frame. A wall-mounted torch is static for its whole lifetime; the candle's
wall-clipped *shape* is even explicitly cached because recomputing it is known to be expensive — and
then the triangulation of that cached shape is redone from scratch, every frame. At 91 lights with
polygons up to 64 edges that is **~210 KB of redundant vertex upload and 91 buffer writes per
frame.**

### 3.9 ✅ CONFIRMED — darkness-region quads rasterise 8–80× the shape's own area

`region-geometry.js:435,496` · `vt-pan-viewer.js:2470`

`computeShapeMeshBounds` returns `halfWidth = halfHeight = diag` for a rectangle, and the mesh is
scaled to `halfWidth * 2` on both axes — a square quad of side `2·diag`. Rasterised area is
`4(w²+h²)` against a true area of `w·h`: **exactly 8× for a square, 17× at 4:1, ~80× for a
1000×50 line shape.** Every excess fragment rasterises, interpolates, runs the point-in-shape test,
then `discard()`s. And the quad is centred on `shape.x/shape.y`, which for a Foundry rectangle is a
**corner**, not the centre.

Bounded above by the one real measurement that exists: §4 recorded `light.drawRegions` going
**0.000 → 0.515 ms** when one region became active — the confound that ate the vegetation-shadow
saving. A tight rotated-corner AABB is exact, is pure CPU arithmetic, and is already test-covered.

---

## 4. THE GEOMETRY STAGE — still the whale, and there is a second one nobody counted

### 4.1 ⬜ Two forced mip-0 fetches of the giant BC7 atlas, per background fragment, per frame

`vt-pan-viewer.js:6288` · `scene-depth.js:429`

1. `buildWholeImageMaterial`: `texture(tex, uv().mul(uUvScale)).level(float(0)).a` — an explicit
   LOD-0 tap feeding **only** the attr MRT's solidity channel. Its own comment dates the change to
   **ROUND 10, 2026-08-04 — after the measurement that produced branch (b).**
2. `buildSceneDepthWriterMaterial`: `texture(tex).level(float(0)).a` then
   `a.lessThan(uAlphaThreshold).discard()` — the same forced tap, on the same textures, for every
   visible tile, in the second full-scene pass (§4.3).

Both bypass the trilinear chain the loader **deliberately builds and binds** with `anisotropy = 16`
(`vt-pan-viewer.js:7506`) precisely so nothing has to sample mip 0.

⚠️ **Deliberately unsized in ms.** What is computable is the *working set*, which is what decides
cache behaviour: a 6750² BC7 mip 0 is **45.6 MB**; a 12000² is **144 MB**. The mip the sampler would
otherwise pick at 3× zoom-out is level ~1–2 (5–11 MB); at 12× zoom-out, level ~3–4 (0.3–2.8 MB).
**These two taps touch a working set 16–500× larger than the correctly-mipped taps beside them in
the same shader.**

⚠️ The level-0 choice is **load-bearing in both places** — a coarse implicit mip once averaged a
padded tile's alpha to a wrong value, which is the bug ROUND 10 fixed. The fix is not "delete the
`.level(0)`"; it is finding a formulation that keeps the alpha correct without pinning mip 0.

### 4.2 ✅ CONFIRMED — every high-resolution mask texture is uploaded with mipmaps disabled

`src/vt/mask-image.js:258-273`

`loadMaskImageTexture` builds a `DataTexture`, sets `minFilter = magFilter = LinearFilter`, and
**never touches `generateMipmaps`** — whose `DataTexture` default is `false` (verified in the
vendored three at `:13652`). So the specular mask (~119 MB), window mask (~53 MB), water mask
(~53 MB) and fluid mask (~53 MB) are **all sampled at LOD 0 at every zoom.**

**The contrast that makes this an oversight rather than a decision:** the same codebase already has
`createMaskDataTexture(data, w, h, filter, mipmaps)` at `vt-pan-viewer.js:1643`, which sets
`LinearMipmapLinearFilter` + `generateMipmaps = true` — and sun shadows is its one opting-in caller.

⚠️ **Verifier correction, and it matters:** mipping does **not** change the fetch *count* — still one
tap per covered fragment. It changes cache locality only. The original 0.3 ms attribution to
specular was unsupported (that zone's variable component covers the whole cropped quad's shading,
not one mask tap). Honest range: **0.2–1.0 ms at zoomed-out framings, approaching zero when zoomed
in.** Test at zoom-out or the result is a false negative.

### 4.3 ✅ **DEEP-DIVED 2026-08-08** — the depth pass does everything right for early-Z, then defeats it with one `discard()`

`vt-pan-viewer.js:4231,4235,9155,9243` · `scene-depth.js:403-440,458` · `three.webgpu.js:47250,47431`

This got a dedicated second pass. It is now the best-understood item in the document, and it changed
shape twice on the way.

**What it is.** `runGeometryWorldPass` ends with an unconditional `runSceneDepthPass()`: bind a
screen-sized RGBA8 + `depth32float` pair, `renderer.clear(true,true,true)`, render `depthScene`.
One proxy per visible tile, plus one per ready visible vegetation canopy. Each proxy **shares the
real item's geometry** — a full-map background contributes its full-map quad, a canopy all 32,768 of
its triangles — with `frustumCulled = false`. Each fragment: one **forced mip-0** alpha tap, a
compare, a `discard()`, and a `vec4` write.

**No gate, no dirty check, no cadence control.** Its inputs are the view rect (`depthCamera` is
synced from the same `computeCameraFrustum` as the world camera, `:6208-6212`), the proxy set
(rebuilt on residency only), and the live vegetation sway uniforms. On a still camera over a scene
with no wind-displaced canopy, **nothing can change this buffer and it redraws anyway.**

> ⚠️ **CORRECTION to both readers who found this** — I checked, and they had the mechanism backwards.
> Both said the zone was suppressed and needed a boolean flipped "to promote it to reported". It is
> not suppressed. `z(...)`'s 8th positional argument is **`detail`**, not `report`
> (`perf-zones.js:951`), and collapsing only applies when `detail === true` **and** the zone is
> insignificant (`perf-report.js:705`). `geometry.depthDraw` is declared `detail: false` — a
> **top-level, always-shown zone**. It is bracketed at `vt-pan-viewer.js:4231-4233` and indexed at
> `:8590`.
>
> **So the number is not missing — it has simply never been read.** It should already be sitting in
> any profile run taken since 2026-08-04. **Zero code change: take a profile and look at it.** That
> makes this the cheapest high-information action in this document by a wide margin.

#### 🔎 A measurement of this zone already exists — and it was never written down

`scene-depth.js:419-421` cites, in a code comment:

> *"live-measured at a **3.4 ms mean / 43 ms max CPU** cost for what is otherwise a **5-draw-call
> pass** (`docs/planning/Performance.md`, 2026-08-06 profile, zone `geometry.depthDraw`)."*

**That measurement appears nowhere in `docs/`.** I grepped every file: the only mentions of
`geometry.depthDraw` are `Depth-Buffer.md` describing the zone's *existence*, and this document. The
citation is dangling. Two facts survive it, and both matter:

1. **The 3.4/43 ms figure is the PRE-fix cost** — it was WebGPU pipeline compiles, caused by
   `float(literal)` baking floorIndex into shader source, and fixed by switching to `uniform()`.
   **The post-fix cost of this pass has never been measured.**
2. **The draw count is 5.** A real number off a real scene, and it substantially *deflates* the
   alarm: the world draw is 44 static / 39 under motion, so this is not "a second copy of the
   world". It is 5 draws. **But draw count is not fill** — and one of the 5 is the full-map
   background quad.

⚠️ **A live-measured number surviving only inside a code comment is the same class of loss as
`feedback_instruments_must_not_lie`.** Whatever the next profile says should land in
`Performance-Insights.md`'s ledger, not in a docstring.

#### 🔴 THE FINDING: this pass is configured perfectly for early-Z, then throws it away

Everything about the setup is right, and I verified each piece rather than assuming it:

| Property | Value | Verified at |
| --- | --- | --- |
| `material.transparent` | `false` → three's **opaque** list | `scene-depth.js:407` |
| `depthTest` / `depthWrite` / `depthFunc` | `true` / `true` / `LessDepth` | `:408-410` |
| Opaque sort | `painterSortStable` → `a.z - b.z` **ascending** | `three.webgpu.js:47250,47431` |
| Resulting order | higher rank ⇒ larger worldZ ⇒ smaller NDC z ⇒ **drawn first** | `rankToDepthZ:142` |

**The pass is already sorted strictly front-to-back — the optimal order for early-Z rejection.
Nothing needs fixing there; do not "optimise" the draw order.**

And then the fragment opens with:

```
const a = tex ? texture(tex).level(float(0)).a : float(1);
a.lessThan(uAlphaThreshold).discard();
```

**An unconditional `discard()` disables early-Z on essentially all hardware** — depth cannot resolve
before the shader decides whether the fragment exists. So every layer runs its fragment shader over
its full coverage, and **every one of those runs a forced mip-0 fetch of the BC7 atlas** (§4.1's
other half). At ~5 layers over 7.32 Mpx: on the order of **37 M cache-hostile mip-0 alpha taps per
frame, none of them rejectable**, against a 45.6 MB working set.

#### ✅ The data needed to remove the discard already exists, costs nothing, and is already in scope

`wi.alphaStats = { min, max, mean }` of the **decoded source alpha, pre-encode** — produced by the BC
worker in a full pass it already pays for (`bc-compress.worker.js:493`; §8.2 flags that same pass as
one of three source readbacks), stored on the whole-image state at `vt-pan-viewer.js:7647`.

**And the tile branch of `rebuildSceneDepthProxies` already holds it.** `:9231` does
`const state = itemStates.get(item.id); const tiles = state?.wholeImage?.tiles;` — so
`state.wholeImage.alphaStats` is **literally in scope, unused, twelve lines above the
`buildSceneDepthWriterMaterial` call at `:9245`.**

When `alphaStats.min / 255 >= alphaThreshold`, **no fragment of that item can ever discard.** For
such an item the material can omit the discard *and the texture tap entirely*, which:

- **restores early-Z for that item**, so lower-rank layers behind it are depth-rejected before their
  fragment shaders run at all;
- **removes one full-screen forced mip-0 BC7 fetch per frame** — attacking §4.1 directly;
- and applies hardest to exactly the right item: **a Level background is the largest quad in the
  pass, is usually fully opaque, and is the LOWEST rank — so it is drawn LAST**, i.e. it is the one
  whose fragments early-Z would reject most.

Safe by construction in both directions: `alphaStats` is a *whole-image* minimum, so if it clears the
threshold every sub-tile does; and when it is `null` (still loading, or the raw path) the current
discard-bearing material is the fallback. **Fail-safe, not fail-open.**

⚠️ **What I could NOT settle by reading:** how much of the screen the higher-rank layers actually
cover. Early-Z only pays where something above genuinely occludes. On an open outdoor map with one
background and nothing over it this recovers the mip-0 taps but no rejection; on an interior with a
roof and tiles it recovers both.

#### Two smaller things found on the way

- **The clear asks for a stencil buffer this target does not have.** `renderer.clear(true, true,
  true)` on a target whose `depthTextureType` is `FloatType` — `depth32float`, no stencil aspect.
  Harmless, but it is an untrue statement about the resource.
- **`material.side = THREE.DoubleSide`** (`:406`) on flat camera-facing quads — backface culling
  forfeited for nothing. Tiny, and worth noting only because
  `feedback_doubleside_invisible_to_status_reports` records this exact property going unnoticed
  before.

#### The three levers, re-ranked by what the dive established

1. **Skip the discard (and the tap) for provably-opaque items.** Best evidence, data already in
   scope, attacks §4.1 at the same time. **Design this one first.**
2. **Skip the whole pass when view rect, proxy-set version and vegetation sway are all unchanged.**
   Narrower than it first looks — wind-displaced canopies defeat it every frame — but on an
   interior/dungeon scene with a static camera it is 100% of the pass.
3. **Rebuild proxies incrementally** rather than dispose-all/rebuild-all (§5.4). CPU-side, and the
   pipeline-compile half was already fixed once.

⚠️ **New consumer, arrived mid-audit:** `src/effects/fire/` (untracked, created 2026-08-08, ~112 KB)
is already wired into the viewer at `vt-pan-viewer.js:2240` and samples `buf:scene.depth` for
occlusion (`fire-render.js:241,576`). It is a **consumer, not a producer** — it adds no proxies and
no draws here. But the depth buffer now has more readers than `Depth-Buffer.md` §11 lists, which
strengthens the case for making this pass *cheap* rather than *conditional*.

### 4.4 ⬜ `buildWholeImageMaterial` is a 7-tap material, not the 1-tap material the docs quote as fact

`vt-pan-viewer.js:6301,13071-13097`

`Performance-Insights.md` §4 still prints this material as `texture(tex, uv().mul(uUvScale))` plus
three multiplies and calls it *"One texture fetch and three multiplies"* — and reasons from that to
"it is not the shader, it is overdraw."

It is now a **5-tap CAS sharpen cross** (`buildAlbedoClarityNode`) plus the forced solidity tap plus
the occlusion tap. **Seven taps.** And the gate is applied *after* the fetches: `rampIn =
smoothstep(gateLo=1.0, gateHi=1.8, texelsPerPixel)` is multiplied into `w`, but the four neighbour
fetches are issued unconditionally before it, with no `Fn`/`If` anywhere in that function. **When
the camera is magnifying — any zoomed-in play view — `gate` is provably exactly 0 and `sharpened`
reduces algebraically to `eC`: four texture fetches and two gamma round-trips for a bit-identical
result.**

The `colorNode` **is** inside `Fn()`, so a real `If` is available — this is the exact fix §3 shipped
for specular. ⚠️ And §3 records the trap: **the taps must be constructed inside the `If` callback or
they hoist straight back out and the fix measures as zero.**

⚠️ Do **not** test with `setAlbedoClarity({sharpness: 0})` — that zeroes `w` but leaves the fetches in
the shader. It would read as a false negative.

### 4.5 ⬜ Every world layer pays a dependent texture fetch for a value that is a compile-time-known `1`

`vt-pan-viewer.js:6202` · `scene/occlusion.js:170` · `foundry/scene-layers.js:314`

Every whole-image material, every vegetation canopy and every vegetation shadow calls
`occlusionAlphaFactor(occ)` — `texture(occlusionMask.texture, screenUV)` plus a step, three maxes and
a mix. But `uOcclusionWeights` is set **once at build time** and, per the code's own comment, *"is
static for an item's lifetime this cut."* For `modes === 0` every branch of `computeOcclusionState`
is skipped, all weights stay 0, and the result is `mix(1, x, 0) = 1` **for every fragment forever**.
`scene-layers.js:314` gives the viewed floor's own background and foreground exactly `modes: 0`.

So the single biggest full-screen drawable in the frame, plus its canopies and shadows, each pay a
screen-space dependent read per fragment for a known no-op. **~7.3 M dead fetches per NONE-mode
layer per frame; with a background + 2 canopies + 2 shadows, ~37 M/frame.**

The fix needs no shader control flow: `modes` is a JS number at build time, so `if (modes === 0)
return float(1);` removes the fetch, the binding and the arithmetic from the compiled shader
entirely. (`Effects.md` Law 4 — do not construct it, do not multiply it by zero.) Independent
corroboration that the sampled buffer is a bare clear: §7 measures `masks.occlusionDraw` at 0.000 ms
/ 0 draw calls.

### 4.6 ⬜ Sparse overlay art pays full-screen blend and MRT cost on provably-zero-alpha fragments

`vt-pan-viewer.js:7144-7155,7955`

A vegetation Case-2 canopy overlay is **one tessellated quad spanning its host's entire world
placement** — for a Level background, the whole map, hence the whole screen. `ensureVegetationOverlay`
builds it from `computeQuadCorners(state.placement)` with **no coverage analysis at all**, and the
colorNode has **no `discard()` and no alpha test**. On a map where 5% of pixels carry foliage, 95% of
the screen still rasterises, samples the canopy texture, samples the occlusion mask, blends against
`scene.color` and writes `scene.attr` — to produce nothing.

The flutter gate at LOD 6 already proves a cheap coverage read is available in this exact shader
(`coarseFoliageAlpha`, `:6943`); it gates the noise block but never the draw. A CPU-side alpha
coverage grid also already exists (`vt/coarse-alpha.js`).

Lever (a), near-zero risk: `alpha.lessThan(eps).discard()`. An alpha-0 NormalBlend and an undrawn
fragment are numerically identical — **and it also stops the attr write, which per §8.1 is currently
a real overwrite, so this is a correctness improvement too.**

**Independently confirmable mechanism:** `frame.triangles` and `drawCalls` must stay identical while
the zone moves. If they do, it is fill, not geometry, which no thermal noise can fake.

### 4.7 ⬜ The vegetation tier ladder does not touch three of the biggest per-item costs

`vegetation-render.js:651,682,823` · `vt-pan-viewer.js:9089,7377`

The ladder changes exactly three things, all correct graph-build-time gates: `flutterEnabled`,
`shadowEnabled`, `shadowSmearTaps`. What it does **not** touch:

1. **Tessellation.** `vegetationMeshSegments = clamp(longest/60, 4, 128)` takes no tier argument, so
   a 12000 px map background is **128×128 = 32,768 triangles / 16,641 vertices at every rung
   including 0** — and every vertex runs the full sway displacement (3 clump hashes, a wind-field
   sample, sin/cos/pow, edge fade, two caps). *(Flagged as suspicion only — 16,641 vertices is
   genuinely cheap and two files say so.)*
2. **The depth proxy** — built for every ready canopy regardless of tier, and handed a **second copy
   of the same sway `positionNode`**, so that vertex work is paid twice per frame. Gating this on
   the same tier is real and free.
3. **The overlay's coverage** — §4.6.

The ladder's real dial today is `shadowEnabled`, worth the **0.644 ms raw / ~1.24 ms
noise-normalised** §4 already measured. **No rung touches `geometry.depthDraw` at all** — a
falsifiable prediction to test alongside §5C's still-missing `low` vs `standard` run.

### 4.8 ⬜ Door leaves are the one drawable family with no camera cull at all

`door-graphics-subsystem.js:156,195`

One `THREE.Mesh` per leaf, `frustumCulled = false`, added to `doorScene`, and `syncDoorGraphics`
reaps only doors that **no longer exist** — never one that is merely off-screen. Every other
drawable goes through `show = onScreen && …`. Fill cost is negligible (an off-screen leaf clips to
zero fragments); the cost is **N draws + N bind groups per frame** where N is 1–2 per door. On an
80-door dungeon that is 80–160 draws producing zero pixels, against measured scenes running ~40
draws total. §4's isolate test prices a removed draw at ~0.013 ms, so this is ~1–2 ms of encode on a
door-heavy scene — and one line of parity with everything else.

⚠️ Use the **open**-state bounds, or a leaf mid-swing pops.

### 4.9 ✅ `frustumCulled = false` is the codebase default — 14 sites, zero `= true`

The stated justification — *"world-space, camera bounds vary per frame"* — is factually wrong for an
ortho camera, and it is being copy-pasted into each new subsystem. This is the **pattern** worth
naming, more than any individual site.

⚠️ Not free to just flip: three will not recompute a `boundingSphere` for a dynamic position
attribute with `setDrawRange`, so each mesh needs one assigned explicitly. For the light fans the
geometry normalisation makes a unit sphere provably correct.

---

## 5. EMERGING BAD PATTERNS — the ones that will keep costing

These are ranked by how likely they are to be repeated in the *next* subsystem, not by size today.

### 5.1 ✅ CONFIRMED — per-frame Foundry document re-reads, in four places

Nothing caches a Foundry document read. Four independent instances, all confirmed:

| Site | What it re-reads, per frame | Correct cadence |
| --- | --- | --- |
| `point-light-pool.js:909` | **every wall in the scene**, allocating a fresh object per wall with three derive calls each | on wall CRUD |
| `vt-pan-viewer.js:8221` → `active-scene-source.js:193` | the **whole Level table**, allocating + sorting + `getRoute()`-resolving — **once per tile** | once per frame at most |
| `vt-pan-viewer.js:2350` → `scene-regions.js:87` | every region + `[...region.behaviors].map()` | on region change |
| `sun-shadow-subsystem.js:1294` | `JSON.stringify(state.params)` as a change key, **per floor per frame** | a version counter |

**The invalidation primitive for the worst one already exists and is unused:**
`scene-walls.js:236-257` documents a wall/door CRUD watcher added for exactly this caching class,
and `point-light-pool.js` — which owns the read — does not use it.

The gobo case is worse than a re-read: `findAperturesForLight` is then called **once per light** over
that whole list — **O(lights × walls) per frame**, ~91,000 iterations on a 1000-wall, 91-light scene.
A one-line pre-filter to `seg.aperture === true` once per frame turns that into a few hundred with
**zero behaviour change**.

⚠️ **And the sharper hazard, which is not throughput at all:** `apertureCount`, `apGoboCols` and
`apGoboRows` are the material **rebuild key**, and all three derive from live geometry. A light that
drifts across the 400 px aperture-distance boundary, or whose two nearest windows swap angular rank,
**disposes both NodeMaterials and rebuilds both node graphs mid-frame.** That is a hitch, not a
cost.

### 5.2 ✅ CONFIRMED — the same question answered by four independent implementations

`scene-depth.js:347` · `scene-attr.js:644` · `layer-order.js:308` · `mask-authority.js:571`

The same ~10-line "membership by `levelId` first, elevation band as fallback" resolution exists in at
least four places, **each calling `getActiveSceneFloors` for itself**, each on its own cadence, each
carrying its own allocations.

**The debt is declared, not hidden** — `scene-depth.js:329-336` names it and writes down its own
trigger: *"extracting both into one shared helper… ideally no later than a THIRD consumer needing
this."* **There are now four.** The trigger has fired.

⚠️ Verifier note: the two hoists in §5.1 do **not** depend on this refactor; each can be done
locally. Report this as a correctness-and-drift item whose perf value is removing the per-call
`new Map` in `maskHostFloorIndices`.

### 5.3 ✅ CONFIRMED — a point query on the mask authority re-scans the entire scene

`mask-authority.js:708,538` · `layer-order.js:310`

`sampleWorld` → `getDerived` → `assertMaskAvailable` → `blockedIdsForLevel` → `hostsOfFloor` — and
`hostsOfFloor` allocates a fresh `floorBands()`, **iterates every item in the scene**, calls
`maskHostFloorIndices(item, bands)` per item — which itself does **`new Map(floors.map(...))` per
item** — then sorts. **None of this depends on the query point.** It is the same answer for the same
floor, every time.

`getCandleRenderState()` maps over every candle anchor calling `safeSampleOutdoors(...)`, and that
closure is invoked **twice per frame** from adjacent lines in the render loop.

⚠️ Verifier corrected the size down: ~40 items, not the assumed 100–200, giving **~4,800 Map
allocations + 120 sorts per frame at 60 candles — roughly 0.05–1.5 ms CPU, and exactly 0 with no
candles.** Which is precisely why it has never shown up.

### 5.4 🟡 Dispose-and-rebuild-everything where an incremental reconcile belongs

`vt-pan-viewer.js:9071-9174`

`rebuildSceneDepthProxies` opens by disposing **every** proxy material and mesh, then rebuilds one
`NodeMaterial` + `Mesh` per visible tile and per vegetation overlay — **on every residency pass**,
which during a pan is continuous. For vegetation it additionally constructs a **brand-new TSL `Fn()`
position graph every pass**, for a graph whose structure never changes. `Object3D.remove` is an
`indexOf` + `splice`, so teardown is O(n²) in proxy count on top.

**This file has already paid for this once.** `scene-depth.js:413-424` records the previous round:
*a live-measured 3.4 ms mean / 43 ms max CPU* in pipeline compiles, fixed by moving floorIndex/flags
to uniforms. The shader-source half is fixed; the **object and bind-group churn remains**, and the
set is near-identical pass to pass.

The sibling instance: a window resize disposes and reallocates **all ~390 MB of screen-sized
targets** (`RenderTarget#setSize` calls `this.dispose()` on a real size change — verified in the
vendored source) with **no debounce**. The only rate limiting is an in-flight flag and a
`queueMicrotask`, which defers to the end of the *same* frame. A one-second window drag is up to 60
full destroy/recreate cycles plus 60 residency passes. The code's own comment says a debounce is
*"overkill here"* — and does not mention the `dispose()`.

### 5.5 ✅ CONFIRMED — nine consumers of one wind formula, and none of them share an evaluation

`wind-access.js:195,241` · plus 9 live call sites

`createWindHandle` exposes three fetch shapes over one formula, and **correctness succeeded** — every
consumer genuinely calls `sampleWind`. But **no shape returns a cached or pre-rasterised value.**
Nine live sites today (2 point-light passes, candle flame, lightning, vegetation sway, vegetation
flutter, 2 particle kernels, 2 debug overlays), each paying 13 perlins plus up to 3 taps. The
module's own header records the consumer list going **1 → 7** and the assembly rotting twice on the
way.

**The publishing machinery exists and is allocated and unused:** `windPing/Pong/PublishRT` are
≤256×256 half-float targets that tier 2 already ping-pongs. And `res:wind` — *"the single source of
truth"* per `Wind.md:51` — **is never built**: `passes.js:126` carries a literal
`(no res:wind resource yet)` comment, while two particle manifests already **declare `reads:
['res:wind']` against a resource nothing creates.** A live instance of
`feedback_unconsumed_api_rots_silently`.

The field is low-frequency by construction (600 px gusts, 667 px outdoor eddies), so a grid bake is
~65,536 texels × 13 perlins ≈ 850k evaluations against **tens of millions** today.

⚠️ Verifier correction to the *direction*, not the size: a single grid bake is **not** a drop-in
replacement. The ~125 px indoor turbulence would need to stay analytic; only the low-frequency
organic + outdoor turbulence can be baked. **Do §3.5's varying() hoist first** — it is lossless, is
a fraction of the work, and its measurement tells you whether the general fix is worth designing.

### 5.6 ✅ CONFIRMED — a wind rebake poisons every light's rebuild key

`vt-pan-viewer.js:3293` · `point-light-pool.js:1100-1131`

`bakeWindField` ends with `for (const entry of pointLights.lightMeshes.values()) entry.animationType
= '__wind_rebake_pending__';` — unconditional, every entry, wind-aware or not. On the next `update()`
every entry mismatches, so both meshes are removed, **both materials and the geometry disposed**, and
`createLightEntry` rebuilds both node graphs. On a 91-light scene that is **~182 material
constructions in one frame.**

Triggers are not rare in play: a 500 ms mask-authority poll, a wind-dial release, a floor change,
and the wall/door watcher — **i.e. a player opening a door.**

And the reason it exists is avoidable: `bakedField` is a graph-build-time shape only because the
texture *object* changes, and it changes only because the bake does `dispose()` then
`new THREE.DataTexture(...)`. `cols`/`rows`/`origin`/`cellSize` are unchanged on an ordinary rebake
(a regrid is separately detected). **Writing the payload into the existing texture's array with
`needsUpdate = true` removes the trigger entirely.**

⚠️ **Verifier correction — do not budget a day on the scary number.** The "~90 WGSL compiles ⇒ ~90 ms
freeze" framing is **not sound**: three's `Pipelines.js` caches `ProgrammableStage` by emitted shader
**source string**, and 91 candles with identical parameters emit identical source. The real cost is
~182 NodeMaterial graph constructions plus bind-group churn, not 182 shader compiles. Still worth
fixing; not worth panicking about.

**Addendum, 2026-08-08 — what `bakeWindField` itself does before it ever reaches the light-material
poison.** `world/wind-enclosure.js`'s header is explicit and, checked against its caller, accurate:
its flood-fill "only ever needs to run when the bake itself reruns… never per frame." Confirmed —
both calls (`vt-pan-viewer.js:3160,3187`) live inside `bakeWindField`, not the frame loop. The grid
it runs on is `cols * OPENNESS_REFINE` per axis with `OPENNESS_REFINE = 4` (`:3132`), and `cols`/`rows`
are Tier 1's own bake grid, independently confirmed elsewhere in this document as clamped to
`[64,256]` — so the fine grid tops out around 1024² plus a small margin, **bounded, not
map-size-scaling**, same discipline as the Tier 2 sim's own RTs. Two rasterizations
(`rasterizeWallsToGrid`) plus two flood-fills at that size, every time this function runs. Not a new
per-frame cost — it is CPU weight *inside* an event this section already names as "not rare in play"
(a wind-dial release, a floor change, a door opening, and — per §5.8's update above — a mask-version
poll every 500 ms during any edit). Folds into the same fix priority as the rest of this section:
make the *event* cheaper (the `needsUpdate` fix above) rather than trying to make the flood-fill
itself faster; it is already reasonably sized for what it does.

### 5.7 ✅ CONFIRMED — there is no render-on-demand path

`vt-pan-viewer.js:10268` · `boot.js:4599`

`setAnimationLoop(renderFrame)` is armed once and never gated. An `awk` scan of the whole body finds
**exactly one `return`** — the GPU-probe diagnostic throttle. No dirty flag, no change comparison;
the pass plan is reached unconditionally. Alongside it, `pumpAstrolabe` is a **second permanent rAF
loop** calling `refreshCandleIgnition()` every frame regardless of whether the astrolabe is open, and
it sits outside the profiler and outside the probe throttle. (There is a **third** — §7.2.)

⚠️ **Honest ceiling: low.** Wind sim, animated lights, candle flicker, specular shimmer and a running
day clock all advance every tick, so a genuinely unchanged frame is rare. The useful version is not
"skip the frame" but **"skip the sub-passes whose inputs did not change"** — which `passes.js`
already has the vocabulary for.

⚠️ **And that reframing's visual risk is not none:** nothing today proves the declared `reads`/`writes`
are complete, so a gate built on them could silently freeze an effect. That is exactly the failure
shape `feedback_seam_default_hides_unwired` describes.

### 5.8 ✅ **FOUND 2026-08-08, spans three subsystems** — one global invalidation counter, three unrelated expensive consumers, zero granularity

`mask-authority.js:248,1136` · `boot.js:2259,6896` · `sun-shadow-subsystem.js:1288` · `water-body-subsystem.js:137`

**Neither the sun-shadow reader nor the masks reader could see this, because each only looked at its
own consumer.** It only appears when you ask who *else* holds the same key.

`getMaskAuthorityVersion()` is `maskAuthority.getProductsVersion()`, whose entire body is:

```js
getProductsVersion() { recomputeIfDirty(); return productsVersion; }
```

— a full `deriveFloorProducts` over **every floor** if dirty, then **one scene-wide integer**. There
is no per-kind, per-floor or per-consumer version. And **three unrelated subsystems poll that single
integer every frame as their rebake key:**

| Consumer | Site | What a version bump costs it |
| --- | --- | --- |
| **Sun shadows**, per floor | `sun-shadow-subsystem.js:1288` | re-pack every floor's layer texture (1024² + 4.19 M stats iterations, §6.7), a 4 MB synchronous upload, and a full GPU bake (~262 M fetches, §6.5) — **× floor count** |
| **Water body** | `water-body-subsystem.js:137` | a full JFA rebake: seed + N flood rounds + resolve |
| **The mask authority itself** | `boot.js:2167` | the `deriveFloorProducts` re-derive, ~30–60 ms single-threaded at the default rung (§6.4) |

#### 🔴 **UPDATE 2026-08-08 — the blast radius is bigger than the table above.** A fourth and fifth consumer poll the same counter, and they cascade further

`vt-pan-viewer.js:2827,2840-2867` — `pollMaskAuthorityForWindRebake(nowMs)`, called **every frame**
from `renderFrame` (`:8825`), reads the identical `getMaskAuthorityVersion()` — confirmed the same
reference, not a re-derived one: it is a parameter threaded into `createVtPanViewer` from the exact
`boot.js:2259` closure sun-shadow and water both receive. On a detected change it fires:

```js
bakeWindField('mask-change');        // → wind Tier 1 rebake (rasterize walls, relax, upload)
bakeOutdoorsTexture(view?.floorIndex ?? 0);
bakeFireMaskTexture(view?.floorIndex ?? 0);
```

And `bakeWindField` is the **exact function §5.6 already documents as poisoning every point light's
material rebuild key** — it ends by marking every light entry `'__wind_rebake_pending__'`, forcing
`point-light-pool.js` to dispose and rebuild both materials for every light on the next `update()`.
**So the same slider drag or tile edit that rebakes sun shadows and water also, via this second
path, forces a full light-material rebuild across the whole scene.** Five bake pipelines from one
counter: sun shadows (×floor count), water JFA, wind Tier 1 (→ light materials), the outdoors
texture, and fire's mask clip.

**The one meaningful mitigation in the whole cascade lives here, and only here.** `vt-pan-viewer.js:2819-2826`
states the reasoning explicitly: *"mask-authority's own `version` bumps on every ingested page (there
can be dozens during a scene's initial decode burst), and re-running the ~64-iteration relaxation on
every single one would visibly cost real time during exactly the moment the app is already
busiest."* So this ONE consumer wraps the check in a 500 ms wall-clock throttle
(`MASK_VERSION_POLL_INTERVAL_MS = 500`) — polling the integer every frame (*"essentially free"*), but
only acting on a change at most twice a second.

⚠️ **Neither sun-shadow's gate nor water's gate has this throttle.** Both act on *every* distinct
value the counter takes, with no time-based debounce — confirmed directly in §5.8's own mechanical
test above (`V1`, `V2` each fired a rebake decision; only a genuinely *repeated* value, `V3`, was
free). During the exact "dozens of version bumps in a burst" scenario this comment describes, wind
would rebake at most twice a second while sun-shadow and water would each attempt to rebake on every
single one of those dozens. **The fix for the other two consumers already exists, in the same file,
written by the same hand — it just was never carried over.**

`touch()` has **six call sites** (`:281 reset`, `:300 setItems`, `:322 setDiscovery`, `:427` page
ingest, `:483 ingestItemAlpha`, `:1083 setCasterHeightSpec`). So:

- **Dragging the sun-shadow Wall-height slider rebakes the water JFA.** `setCasterHeightSpec` bumps
  the shared counter — and §6.3 already established that `wallHeightPx` **is not even consumed by
  the layer-smear bake any more.** A slider that affects neither the derivation nor the water now
  invalidates both, **every frame of the gesture.**
- **Editing one Tile rebakes every sun-shadow floor and the water — and "editing" means ANY field,
  not just placement or art.** `SCENE_LAYER_DOCUMENTS = ['Level', 'Tile']` (`scene-layers.js:439`) ×
  create/update/delete = six hooks, wired at `boot.js:6986-6995`:

  ```js
  const redrawOn = (hook) => {
    Hooks.on(hook, (doc) => {
      refreshVtPanViewerItems(hook).catch((err) => log.error(`${hook} redraw failed:`, err));
      if (MASK_AUTHORITY_HOOKS.has(hook)) refreshMaskAuthorityItems(hook, doc?.parent ?? null);
    });
  };
  ```

  **This handler's arity is 1 — it captures only `doc`, never the second argument.** Foundry's real
  hook signature for an update is `(document, changes, options, userId)` (verified against the
  vendored source elsewhere in this same codebase — see the contrast below), where `changes` is the
  DELTA: only the fields that actually moved. This handler discards it entirely. So `refreshMaskAuthorityItems`
  — a full `collectSceneLayers(sceneDoc, {...})` (re-collects every Level's art and every Tile) plus
  `maskAuthority.setItems(...)` → `touch()` — fires on **any write to any Tile or Level document,
  for any reason, by anyone.** A GM renaming a tile, locking it, changing its permissions, or a
  completely unrelated module writing its own flag onto the same document: all of them trigger the
  identical full cascade this section describes. The trigger condition is not "an edit that could
  plausibly affect masks" — it is "this document was touched."

  **The codebase already knows how to do this correctly, two files away.**
  `foundry/scene-walls.js#watchDoorOpenings` receives the real 4-arg hook signature and filters on
  it precisely: `if (!change || !('ds' in change)) return;` (only the door-state field), further
  narrowed to `change.ds !== WALL_DOOR_STATE_OPEN` (only the closed→open transition, not the reverse
  or any other wall edit). `foundry/sky-persistence.js#watchSceneSky` does the identical thing for
  its own concern: `if (!change?.flags?.[SKY_NAMESPACE]) return;`. **Both are a one-line addition of
  the exact same shape** — `if (!change || (fields the mask authority actually cares about are
  untouched)) return;` — sitting unused at the one hook that most needs it.
- **Repainting a water mask re-packs and re-bakes every sun-shadow floor**, and vice versa.

✅ **The healthy half, and it matters:** in **steady play with no editing** the counter is stable, all
three consumers hit their early-return, and this costs a comparison each. Page ingest is load-time
only (§8.3: there is no per-view page streaming left). **This is an editing-cadence problem, not a
frame-cadence one** — which is exactly why no benchmark route has ever caught it, and exactly why
the author feels it while authoring and the instrument does not.

⚠️ **This is `feedback_shared_field_two_meanings_two_registries` at subsystem scale** — one counter
being asked to mean "the mask products changed" for three consumers with completely different
notions of what would actually invalidate them.

**Settle it:** log `maskAuthority.getProductsVersion()` once per frame while (a) panning, (b)
dragging the Wall-height slider, (c) nudging a tile. Cross-check against
`sunShadows.getStatus().floors[].lastBake.reason` and the water subsystem's `bakes` counter. A
version that moves in (b) or (c) confirms the cascade end to end.

#### ✅ **CONFIRMED 2026-08-08 — mechanically, by executing the real module, not by reading it**

No Foundry server was running or discoverable on this machine (checked: nothing on port 30000, no
`FOUNDRY_PATH`/`FOUNDRY_DATA_PATH` env vars, no `FoundryVTT` folder under either `LOCALAPPDATA` or
`APPDATA`), so a live in-browser slider click was not available. Instead of stopping at that, the
**real, unmodified `scene/mask-authority.js`** — the exact factory `mask-authority.test.mjs`
constructs under plain Node, with no THREE/renderer dependency — was imported and driven directly
with the **exact call boot.js:987-1013 makes on every cascade resolve**, field name and shape copied
verbatim (`buildingHeightPx: resolved.enabled ? (p.wallHeightPx ?? 0) : 0`).

Result, running the real code:

```
V0 (baseline productsVersion, right after reset):        2
setCasterHeightSpec({ buildingHeightPx: 20 }) → changed=true   → V1 = 3
setCasterHeightSpec({ buildingHeightPx: 21 }) → changed=true   → V2 = 4
setCasterHeightSpec({ buildingHeightPx: 21 again }) → changed=false → V3 = 4   (still slider — correctly free)
```

Both consumers' own gate expressions were then transcribed **verbatim** from source (not
reworded) and evaluated against these real numbers:

- sun-shadow: `!casterFieldLoaded || version !== casterFieldVersion` (`sun-shadow-subsystem.js:1288-1293`)
- water: `!(version === bakedVersion && floorIndex === bakedFloor && overrideKey === bakedOverride)` (`water-body-subsystem.js:437-441`)

At V1 and V2, **both** evaluate to "rebake". At V3 (the repeated value), **both** evaluate to "skip".

**This proves the mask-authority half of the cascade directly, not by inference:** the one call the
Wall-height slider makes on every resolve tick bumps the one counter both subsystems poll, on every
distinct value a real drag would produce, and correctly does not on a still slider. It stops one
step short of a full live confirmation — `water-body-subsystem.js` and `sun-shadow-subsystem.js`
themselves are GPU-facing factories (THREE/allocator/renderer) that cannot be constructed under
plain Node without mocking the GPU surface, and a mocked GPU surface would no longer be "the real
thing" — but there is no other function standing between either gate check and its bake call (both
read directly from source, both quoted above with their real line numbers), so the mechanical proof
and the live behaviour are the same code path. **If a real Foundry session becomes available, the
remaining step is purely observational: drag the slider, watch `sunShadows.getStatus()` and the
water subsystem's `bakes` counter move together.**

Harness kept at
`C:\Users\HIVEDI~1\AppData\Local\Temp\claude\...\scratchpad\chase-5-8-cascade.mjs` (session-scoped
scratchpad — not part of the repo) if it needs re-running against a different scenario.

#### ✅ **AUDITED 2026-08-08 — every `effectRegistry.register(...)` callback, all 15. Sun-shadows is confirmed the ONE outlier, not one of several**

Given this section's own finding started with "the sun-shadow reader… only looked at its own
consumer," the obvious next question is whether any of the *other* 14 registered effects hide the
same shape — an `apply` callback that does real, unconditional work instead of writing a cheap
readout. Every one was read: the 10 registered inline in `boot.js` (UI window shadow, candle flame,
lightning, fire, vegetation, bloom, depth of field, sun shadows, grade, door graphics) and the 5
registered in their own dedicated modules (water, fluid, specular, window light, aperture gobo —
each following the exact template `water-registration.js` names itself as, down to the
`{enabled, params, perfTier}` readout shape).

**14 of 15 do nothing but write a plain object literal into a readout variable** the frame loop
reads on its own cadence — candle/lightning/fire additionally do one small `O(anchors)` filter with
a `new Set`, cheap and called at settings-change cadence, never per frame. **Sun-shadows alone calls
out to another subsystem's derivation (`maskAuthority.setCasterHeightSpec`) from inside its
`apply`.** This is a genuinely valuable negative result: the registry/cascade layer itself is clean
by construction, and §5.8 is not a symptom the next new effect is likely to repeat by accident — it
is one specific effect doing one specific thing its 14 siblings do not.

**One more piece confirmed while tracing this:** the debug panel's live slider drag for sun-shadows
goes through `MapShine.setSunShadows` → `reapplySunShadows()` → `effectRegistry.resolveAndApply
('sunShadows', layers)` — resolving and applying **only that one effect**, not
`reapplyAll(...)`. `reapplyAll` is reserved for real global events (`'ready'`, `'scene load'`,
`'settings change'` via Foundry's own settings-dialog save, `'perf tier report restore'`) and is
never on the per-drag-tick path. So the frequency claim earlier in this section — "every distinct
value a real drag produces" — is confirmed accurate for exactly one effect's cascade, not an
undercount of a wider sixteen-effect storm.

### 5.9 ✅ **FOUND 2026-08-08, closing the surface-stage gap** — a correctly-built compile-time gate that is never connected to the slider it exists for

`src/effects/window/window-render.js:169` · `window-surface-subsystem.js:150-156` · `window.js:79-86,398-408`

The window glass model does everything right at the mechanism level, which is exactly what makes the
gap easy to miss. `buildWindowSurfaceMaterial`'s header is explicit and correct:

> *"`glass` IS A JS-TIME BRANCH, NOT A UNIFORM. Everything below — five noise taps, two extra mask
> taps, the whole caustic chain — is simply NOT CONSTRUCTED when it is false, so the compiled shader
> genuinely shrinks (Effects.md Law 4 / `tsl/no-uniform-gates`)."*

That is the right discipline, and it is the same one that made specular's presence gate a real 4.4×
win (§3's fix). But **the flag is never wired to anything.** The function signature is
`glass = true` (`window-render.js:169`), and the **one call site**, `window-surface-subsystem.js:150`,
passes `{ THREE, maskTexture, depthTexture, uViewRect, cloudFactorNode }` — **no `glass:` key at
all.** So `glass` resolves to its default, `true`, unconditionally, on every window, on every scene,
forever. There is no code path anywhere that can make it `false`.

**The author-facing control this was meant to answer to already exists and already ships:**
`glassWarpPx` (`window.js:79-86`), default **60**, with its own help text — *"0 = perfectly flat
modern glass: no distortion, no prism, no caustics."* An author reading that text and setting it to 0
expecting a cheaper, flatter look gets the flat *look* (the displacement math still evaluates, just
to zero) but **pays the full ALU cost regardless** — five noise taps, two extra mask taps, the whole
caustic chain, every frame, on every covered pixel of every window.

**This is not a guess — the codebase names its own gap, in its own words, in a structured deferred-
rung note** (`window.js:398-408`, `name: 'glassPerfGate'`):

> *"PUT THE GLASS ON A REAL PERFORMANCE TIER. The expensive half of tier 0 … already has its JS-time
> off switch … What is MISSING is the machinery to flip it while running: a perf tier has to change
> with the profile selector, and this subsystem never rebuilds its material (specular carries exactly
> that machinery and is the template) … Until then the glass is always compiled in and
> `glassWarpPx = 0` is the author's exact, but runtime-cost-free-only-in-ALU, off switch."*

That note frames the gap as "no perf-tier rebuild machinery yet" — true, but it undersells the
finding: **there isn't even a `glassWarpPx > 0` check at the one call site.** Wiring `glass:
glassWarpPx > 0` into that single object literal, with a material rebuild on the same edge specular
already has the machinery for, would let `glassWarpPx = 0` do exactly what its own help text
promises, immediately — no perf-tier system required first.

⚠️ **Sizing, honestly bounded.** This is not full-screen — `cropGeometry()` (`window-surface-
subsystem.js:298`) crops to the painted AABB, and `hasContent()` gates the draw call itself
(`vt-pan-viewer.js:4654`, verified: `if (windowSurface.hasContent()) renderer.render(...)`), so the
cost is confined to actual window coverage, not the whole screen. Within that coverage: 5 noise
evaluations + 2 extra dependent mask taps (the dispersion path samples the mask **per channel** —
`sampleCookieAt`'s own header says so) + a caustic chain, per fragment, permanently. **Unsized in ms**
— no zone brackets this pass separately from `light.accumulate`'s wider window contribution — but the
mechanism, the missing wire, and the author's own acknowledgement are all confirmed by reading, not
inferred.

**A second thing the code names about itself, worth carrying into the duplication list (§5):** a
sibling deferred-rung note, `glassConvergence` (`window.js:410-417`), states outright that this
file's glass model and `aperture-gobo.js`'s glass model **both simulate medieval window panes and
share zero code** — *"aperture-gobo has facets/grime/broken panes over real wall geometry … tier 1
here has a 2-D displacement field with dispersion and caustics over a painted mask. Each has what the
other lacks."* Two independent noise-heavy glass simulations, for two different ways of encountering
the same physical object, kept apart by their own admission. Not sized — a design question as much
as a perf one — but it belongs beside §5.5's wind-consumer list as the same pattern: work that could
share a source of truth and currently does not.

**Settle it:** confirm at the console — `MapShine.debug` or a temporary log at the one call site —
that `glass` really does read `true` regardless of the author's `glassWarpPx` value on a live scene.
Then, if a fix is wanted: pass `glass: glassWarpPx > 0` at the call site and rebuild the material on
that boolean's edge (not on every `glassWarpPx` change — the value itself is already a uniform; only
the true/false transition needs a rebuild), mirroring the rebuild specular already does for its own
profile-driven gates.

### 5.10 ✅ **AUDITED 2026-08-08, closing two more brief questions — both come back HEALTHY**

The original brief asked, and nobody had directly answered: *"are off-screen particles simulated?"*
and *"is the wind simulated on GPU or CPU, at what grid resolution, and every frame or on a timer?"*
Both `src/effects/particles/` (stable, committed — not the untracked `fire-particle-runtime.js`
sitting alongside it, deliberately left alone) and `src/world/wind-sim*.js` + `wind-enclosure.js`
were read end to end to answer them directly. Reported here rather than as findings because that is
exactly what they turned out to be: **checked, and clean.**

**Particles (`particle-runtime.js`, `gust-runtime.js`) — genuinely well-built:**
- `capacity` is a **fixed, author-declared number per system** (default 4096 / 64), never derived
  from map size or screen area — so particle count cannot scale with a large map the way a
  naive "one particle per world tile" design would.
- Particles are seeded and redistributed within `windSpawnRect = clampRectToBounds(viewToWorldRect(
  view, …), dimensions.sceneRect)` — **the current camera view, clamped to the scene** — not the
  whole map. This is real, structural view-relative confinement: a capacity of 4096 covers whatever
  is on screen, wherever the camera is, not 4096 spread across a 12,000 px map. `fix-17`'s own
  in-code history (a documented "zoom in and it shoves particles together" bug, fixed by adding a
  redistribution window) is itself evidence this rect really does track the camera.
- `step(renderer, {...})` is called only `if (windParticlesEnabled && view && particleEngine)` — a
  real JS-level gate, not a uniform multiply — and its own per-frame body is three scalar uniform
  writes plus one `renderer.compute()` dispatch: no allocation, no loop, no per-particle JS work
  (simulation state is storage-buffer-only "by construction", per the module's own header).
- The one blemish is cosmetic, not a defect: both files set `mesh.frustumCulled = false` with the
  comment *"world-space bounds vary per frame; the gate is the GPU's job"* — the same wrong-for-an-
  ortho-camera justification §4.9 already names at 14 other sites. Listed as a 15th and 16th site
  for that pattern, not a new finding — the underlying behaviour here is already correct because the
  particle field is camera-relative, unlike e.g. point lights, which have no camera awareness at all.

**Wind (`wind-sim.js`, `wind-sim-gpu.js`, `wind-enclosure.js`) — genuinely well-built:**
- The transient sim (Tier 2, door-gusts) runs on **GPU**, at a **fixed, small grid — always ≤256 per
  axis** regardless of map size (`Wind.md §2`'s own "half a megabyte at the worst case" claim,
  confirmed by the allocator descriptor at `vt-pan-viewer.js:3331-3339`), reallocated only on a
  genuine regrid, never per frame.
- `tickWindSim` is called every frame but opens with a real idle gate: `const thawed = windForceThaw
  || nowMs < windThawUntilMs; if (!thawed) { …; return; }` (`:3609-3629`). The entire 7-pass ladder
  (advect+dissipate, splat, 4× relax, publish) **only runs while a door-gust impulse is actively
  decaying** — on a quiet scene with no recent gust, this function is one branch and a return. On
  refreeze it correctly clears the target rather than leaving a stale gust frozen on screen forever,
  with the reasoning stated in its own header: *"refreezing must mean 'gone,' not 'frozen
  mid-gust.'"* This is precisely the "does the loop do anything when nothing needs to change"
  question the original brief asked, answered in the affirmative for this one subsystem — worth
  treating as the template if §5.7's broader render-on-demand question is ever pursued.
- `wind-enclosure.js`'s flood-fill genuinely only runs inside `bakeWindField` (confirmed by call
  site, not assumed from its header's claim) and its grid is bounded (`cols * 4` per axis, capped by
  the same `[64,256]` clamp Tier 1 uses elsewhere) — not map-size-scaling. See §5.6's addendum for
  the one real consequence: this work happens *inside* an event already flagged as more frequent
  than the frame-time documents assume.

**One escalation this pass produced, filed at §5.8, not here:** `pollMaskAuthorityForWindRebake`
polls the *same* shared counter §5.8 covers, and its own 500 ms throttle — with its own comment
naming the exact "dozens of version bumps in a burst" scenario §5.8 describes — is the one piece of
the whole cascade that already got fixed once. It just never propagated to the other two consumers.

---

## 6. SUN SHADOWS — the largest unaudited subsystem

All ⬜ UNVERIFIED — the verifier for this territory did not run. Treat sizes as one reader's
arithmetic.

### 6.1 A sun-angle change rebakes every floor on the same frame, and the day clock can trigger that every frame

`sun-shadow-subsystem.js:1302` · `world/day-clock.js:140` · `vt-pan-viewer.js:4304`

Slot 0 rebakes when the sun moves past `quantizeDeg` (0.5° default). A real bake bumps `bakeSerial`;
slot 1 sees `lowerChanged` and rebakes; slot 2 sees slot 1's bump. **One sun step = N full bakes in
one frame.**

The sun is not static. `dayClock.tick(dtSec)` runs every frame, and three things move it: free
drift, `syncTo` walking at **6 game-hours per real second**, and `setHour` from an astrolabe drag.
Azimuth advances ~15°/game-hour, so a sync walk moves it **~90°/s ≈ 180 crossings of the 0.5°
threshold per second** — a rebake on essentially every frame for the walk's duration. **A GM jumping
8 hours ≈ 1.33 s ≈ ~80 consecutive all-floors bakes.**

`DEFAULT_RATE_HOURS_PER_MINUTE = 0`, so an untouched scene pays nothing. **This is a cost of the
feature working, not a default-config cost** — which is exactly why §7's *"bakes did not fire during
either window"* was true and misleading.

### 6.2 Every floor is baked, including floors the camera provably cannot see

`vt-pan-viewer.js:4302`

The bake loop iterates **every Level with usable art**. Foundry's real cross-floor visibility rule is
`computeVisibleFloorIndices(floors, viewedIndex)`, and **`boot.js:5110` already uses exactly that** to
decide which floors' art enters the draw list. A floor outside that set contributes zero pixels and
still gets a full layer-texture pack and a full GPU bake, with the cascade re-firing through it.

Ground-floor view of a 5-storey building: **5 bakes where 1 is needed.** Zero benefit on
single-floor scenes; the cascade forces the floor *below* a visible one to stay baked.

The comment justifying the current behaviour — *"baking N floors costs baking 1 floor N times only on
the rare frame something scene-wide actually moves"* — is true, and §6.1 shows **that frame is not
rare under a moving sun, and it is exactly the frame this waste lands on.**

### 6.3 Dragging one Look slider forces a full mask re-derivation and a rebake of every floor, every frame of the drag

`sun-shadow-subsystem.js:1288` · `mask-authority.js:248,1083` · `boot.js:975`

`maybeBake` re-runs `bakeLayerTexture` whenever `getMaskAuthorityVersion()` changes. That getter
calls `recomputeIfDirty()` — a full `deriveFloorProducts` over **every** floor — and returns a counter
bumped by `touch()`. `touch()` fires on mask page ingest, item-list change, discovery, **and
`setCasterHeightSpec`** — which the sun-shadow apply handler calls with `buildingHeightPx:
p.wallHeightPx`.

**So dragging the Wall-height slider bumps the mask version → re-derives every floor's products →
re-packs and re-uploads every floor's layer texture → re-bakes every floor's field. Every frame of
the gesture.**

And `wallHeightPx` **is not even consumed by the layer-smear bake any more** — `:1107` takes it
straight from `params.wallHeightPx`, and `boot.js:970-974` says so explicitly. It is fed to
`setCasterHeightSpec` only to keep a getter current for a future rain consumer. **A slider that does
not affect the derivation is invalidating the derivation.**

### 6.4 `deriveFloorProducts` rebuilds every floor from scratch, and one full-resolution pass is unconditional

`mask-authority.js:558,605` · `mask-derive.js:973`

**One dirty bit for the whole authority** — any `touch()` throws away every floor's products. Each
floor then allocates 9 grids at caster resolution and runs up to three full-grid passes.

**The free one:** the overhead-gating loop at `mask-derive.js:973` has **no enclosing `if` at all** —
verified by brace-checking. It runs even when `wantOverhead` is false and even when the floor
composited zero overhead items, gating an all-zero grid against a world-sampled mask. Its sibling
building loop **is** correctly guarded. Wrapping it removes `w×h` iterations per floor per recompute
— ~1.05 M at the default 1024² rung — and is **provably a no-op removal, zero visual risk by
construction.**

**The scaling one:** ~3.1 M `sampleMaskGridWorld` calls and ~28 MB of allocation per full rebuild at
3 floors on the default rung — **~30–60 ms of single-threaded JS**, and 16× that at the extreme rung.
Event-cadence, not per-frame — but §6.3 shows the event can be a slider drag.

### 6.5 The bake's own instrument under-counts by 10×

`layer-smear.js:229` · `layer-smear-render.js:327,354`

`layerSmearBakeSamples(plan)` returns `dim × dim × (steps+1)` — **one sample per station**. The
shader issues **ten**: 4 sharp layer taps, plus `DEPTH_SCALES = 3` more for each of the 2 band
layers. **The shader's own comment states the true figure** (*"4 sharp + 6 depth reads per station"*)
— so the shader knows and the counter does not. This number is quoted by the status report, the tier
ladder doc, and the manifest's *"the bake's cost gradient lives where it can be counted rather than
guessed"* note.

Corrected: default rung = **262 M fetches per bake per floor**, reported as 26 M. Extreme = 2.06 B,
reported as 205 M.

⚠️ **The reader correctly declined to claim a 10× time correction:** the 6 depth taps request mip
6.4–8.0, which per §9's own calibration cost ~1/20th of a mip-0 tap. **Honest time multiple ~4–5×,
not 10×.** And the ladder's claim that *"Extreme lands below the model it replaces"* is comparing a
correctly-tapped old number against a 1-tap-per-station new one.

### 6.6 Two provable no-ops in the bake shader

- **~100 `pow()` per fragment to raise a number to the power of exactly 1.** `SUN_SHADOW_FALLOFF_EXP`
  is `1` and is a declared **look constant, not a param** — nothing outside the module may write it.
  But it arrives as a uniform, so the compiler cannot fold it, and every evaluation is a real `pow`
  (typically `exp2(y·log2(x))`, two transcendentals). 4 layers × 25 stations = 100/fragment ×
  1024² = **105 M pow per bake per floor.** A graph-build-time branch on `=== 1` gives a
  **byte-identical** result, using the discipline `LAYER_HAS_DEPTH_GRADIENT` already uses ten lines
  away.
- **⬜ SPECULATION: ~250 `lodFor` chains per fragment whose every input is a uniform.** Every mip-LOD
  the bake requests traces back to uniforms and literals only — and `describeBakeBlur` already
  computes the identical arithmetic on the CPU for the report. **The payoff is explicitly labelled
  speculation:** modern backends have uniform-datapath and LICM passes that may hoist all of it.
  Settle by dumping the WGSL and counting surviving `log2`s.

### 6.7 The layer pack scans the whole grid four extra times to fill a status report

`sun-shadow-subsystem.js:587,417`

`packLayerTexelData` unconditionally ends `channelStats: describeLayerChannels(data, w, h)`, which
runs a full `w*h` loop **four times**. `bakeLayerTexture` then calls `describeSourceGrid` twice more.
**None of it feeds the render**; all of it exists for `getStatus()`, read only when a human opens the
report. At the default rung that is **4.19 M stats iterations on top of a 1.05 M-texel pack**, plus a
4 MB allocation and a synchronous DataTexture upload — **a ~4× multiplier on an already-large
synchronous loop, per floor, inside the frame.**

Making it lazy is the pattern `Performance-Insights` §3 already praises specular's `coverage` report
for.

### 6.8 The gobo pattern is evaluated twice per fragment, and its faceted-glass branch is multiplied by zero

`aperture-gobo-render.js:364-380` · `aperture-gobo.js:185`

`buildApertureGoboTerm` is called once from illumination and once from coloration with **identical
inputs**, producing an identical scalar — the §3.1 duplication again. Per aperture per evaluation:
a `simplexFloat`, a 2-octave `fbmFloat`, a `voronoiFloat` 3×3 cell search, **7 `tslHash2` calls**, an
`atan2`, 2 cos/sin pairs, 2 `pow`, ~5 smoothsteps, plus unrolled mullion bands — up to 4 apertures.

And `glassQuality` ships at **0**, so `facetOffset.mul(uGlassQuality)` is a multiply by zero — yet the
whole faceted kernel (pane-relative coords, `atan(localZ, localSW)`, a wedge divide/floor, `fract`
parity, `select`) is computed on every fragment of every windowed light. **Up to 8 `atan2`
evaluations per fragment, all × 0.** `cols`/`rows` already prove this pool can promote a uniform to a
rebuild key.

---

## 7. INSTRUMENT AND UI OVERHEAD — all ⬜ UNVERIFIED

The stated design goal was *"minimal performance cost when not active."* Mostly true; four exceptions.

### 7.1 The heartbeat polls the entire viewer diagnostics report 4×/second, for six scalars

`boot.js:7081,7095` · `vt-pan-viewer-diagnostics.js:606` · `diag/render-fallback.js:192`

`getVtPanViewerDiagnostics()` builds the **full ~50-field report** — with **no visibility gate
anywhere on the path**, open panel or closed. Per invocation: a `getComputedStyle(canvas)` **and** a
`getBoundingClientRect()` (**a forced style recalculation and a forced layout flush**, on a Foundry
document that also hosts the sidebar and notification queue); **five** separate `cache.stats()` calls
(each an O(2048) full slot scan its own comment marks diagnostics-only); `computeLayerResidency` over
every pack × coarse page (**808 pages on a measured 3-floor scene**); `buildDrawList` allocating ~14
fields + 2 `Vector.toArray()` per item; and twelve subsystem status calls.

**The repo already warns against this twice in its own words** — `vt-pan-viewer.js:12536` has a
*"deliberately not getDiagnostics()"* cheap path for exactly this reason.

Bound: 0.7–6 ms landing as a **spike on 4 frames per second** — ~6.7% of frames — on a frame whose GPU
p50 already straddles the vsync step. ⚠️ **And it is invisible to MSA's own instruments**, because it
runs in boot's rAF callback, outside every profiler bracket.

### 7.2 A second WebGPURenderer submits an empty render pass to an 8×8 canvas every frame, forever

`boot.js:7019,7031,7051`

A second `WebGPURenderer` on its **own GPUAdapter and GPUDevice**, with an explicitly empty scene,
`renderer.render(scene, camera)` unconditionally in a permanent rAF. Each call walks three's full
`_renderScene` → render list → `beginRenderPass`/`endRenderPass` → `queue.submit()`, plus a
`getCurrentTexture()` and a canvas present. **Registered during boot, before the viewer's own loop —
so whatever it costs is paid immediately in front of every rendered frame.**

The defence at `boot.js:298-305` gives three reasons; **two do not require a render.** The rAF
callback *firing* is already the liveness proof, and the gap sampling reads only `t`, never the
render. Only the context-loss watch needs a live device — and a device stays live without a
submission every frame. Rendering on the same 4 Hz cadence the perf strip already uses keeps all
three properties and removes ~99.6% of it.

### 7.3 A per-frame rAF poll can fire one Foundry scene write **and** one full panel DOM rebuild **per candle**, in one frame

`boot.js:4604,1332,1271` · `foundry/anchor-adapter.js:43` · `diag/effect-controls.js:83`

`pumpAstrolabe` calls `refreshCandleIgnition()` every frame, ungated. On a day/night phase flip it
loops every candle anchor and calls `updateCandleAnchor` per candle — which does, **per candle**:
`persistAuthoredAnchors()` → `await scene.setFlag(...)` (a **full Scene document update, a DB write, a
socket broadcast to every client, and an `updateScene` hook** that MSA itself subscribes to), **and**
`refreshControls()` → `renderBody()`, which is `bodyEl.innerHTML = ''` and a rebuild of every effect
card from scratch — a teardown the codebase documents in its own words.

On the 91-candle scene: **~91 scene writes all overwriting the same flag, and ~91 full panel DOM
rebuilds, on a single frame.** Estimated 270–1400 ms of synchronous DOM work — **past the flight
recorder's 50 ms hitch threshold and past the 250 ms "app looks dead" threshold.**

⚠️ Honest scoping: `autoIgniteEnabled` is opt-in, so this is latent, not a default-config cost. The
fix keeps every behaviour: collect the flips, apply them, then **one** persist and **one** refresh.

### 7.4 The armed profiler allocates four objects per bracket

`boot.js:2376,2428` · `frame-profiler.js:215,257` · `vt-pan-viewer.js:11185`

`openSlot` calls `readDrawCalls()` and `readTriangles()`; `closeSlot` calls both again — **four calls
per bracket**. Each is wired to `readVtPanViewerRenderInfo()`, which allocates **a fresh `Vector2`
plus a fresh 5-field object plus a `getPixelRatio()` call** to hand back one integer. At ~40 brackets
per frame: **~320 allocations/frame, ~19,000/second, ~2.2 MB/s of nursery garbage.**

**The comment directly above the wiring says the opposite of what the code does** —
*"two integer reads per bracket."*

Zero cost in normal play (the callbacks are null when disarmed). **The cost is measurement fidelity:**
a young-generation scavenge every 1–2 seconds *inside the measurement window*, charged to whichever
zone happened to be open. A plausible contributor to the 3.32 ms "CPU encode" figure and to the
run-to-run variance §0 warns about. And the file's own header states the rule it is breaking:
*"nothing allocates inside a frame. An instrument that triggers GC is measuring itself."*

### 7.5 The flight recorder patches the page's global console

`flight-recorder.js:466,885`

`captureConsole()` is called with **no argument**, so it replaces `console.log/info/warn/error/debug`
on the real global for the entire Foundry page. Every subsequent console call from **any** source —
Foundry core, other modules, three.js — now runs `JSON.stringify(toJsonSafe(a, 4))` (a depth-4
recursive walk with a fresh WeakSet), a `Date` + `toISOString()`, a ring push, and for warn/error a
`new Error()` stack capture and regex parse. **No dedup, no rate limit** — MSA imposing this on code
it does not control.

⚠️ **Genuinely unsized**, because it depends entirely on whether anything on the author's page logs at
frame rate, which code cannot tell you. Per-call: ~10–30 µs. **The settle is free and already
available:** read `MapShine.flight.snapshot().log.bySource` after a 60 s sweep. Thousands from
`foreign` on a ~3,600-frame run means it is live; tens means close it.

*(MSA's own logging is clean — the reader found no per-frame `log.*` call site.)*

---

## 8. LOAD-TIME AND CORRECTNESS ITEMS FOUND IN PASSING

### 8.1 ✅ `buf:scene.attr` is **not** blended on the WebGPU backend — the "safe `vec4(0)` default" is false

`three.webgpu.js:48519,48543` · `vt/scene-attr.js:48`

Traced through the vendored source: `MRTNode`'s constructor seeds `blendModes = { output:
_materialBlending }` **only**; `getBlendMode('attr')` therefore returns `_noBlending`; the pipeline
builder takes neither branch and pushes `{ format, blend: undefined, writeMask }`. MSA never calls
`setBlendMode`, and `compatibilityMode` is never set, so the fallback that would apply material
blending to all targets does not run.

**Consequences:** (a) attr costs 4 B/px write, not 8 B/px read-modify-write — so the frame is already
cheaper than the documented model assumed, and the whole-frame estimate drops from 24 to 20
B/px/layer; (b) `SCENE_ATTR_ZERO_MRT`'s `vec4(0,0,0,0)` **overwrites rather than skips**, so every
door leaf, vegetation shadow, token and untouched tile drawn on top of a real writer **erases that
writer's floor index, presence bits and solidity**; (c) `packFloorAttr`'s ROUND-15 alpha-test
binarisation writes a value into a channel nothing uses as a blend factor — **the entire fix is
inert.**

This settles the item `Performance-Insights.md` §9 flagged as *"now itself in doubt."* It is **not**
in doubt. ⚠️ It is primarily a **correctness** finding; its perf value is avoided waste — the depth
pre-pass design in §4 was priced against a blending contract that does not exist.

**Live check:** probe `buf:scene.attr` where a vegetation shadow quad overlaps a Level background. If
`attr.r` reads 0 rather than the background's floor index, the overwrite is real.

### 8.2 ✅ Four load-time stalls, measured in whole seconds

| Item | Cost | Files |
| --- | --- | --- |
| **BC1/BC7 encoding is single-threaded** on a workload that is **bit-identical when band-parallelised** — the file says so and tests it | **~5 s per 6750² BC7 level 0** (the repo's own measurement), ~6.5–7 s with mips; ~21 s at 12000². ~1 s on 8 threads. Bites on every cache miss, and `CACHE_VERSION` is at **v9** | `compressed-textures.js:44` · `block-compress.js:2181` |
| **`loadMaskImageTexture` blocks the main thread** — a full-res probe decode used only for two integers, then `getImageData` (**211 MB** for a 10650×4950 mask), then a 52.7 M-iteration JS loop | **0.5–1.0 s per full-scale mask.** Every other giant-image path in this codebase was deliberately moved to a worker; this one never was | `mask-image.js:181,195,211` |
| **The coarse-alpha worker fully decodes every cover image at native resolution to read `width`/`height`**, then throws the bitmap away. The comment above it claims the opposite of what the line does. The repo **already owns a 30-byte header reader** | ~125 ms + ~182 MB transient per 6750² item; ~26 items on a 3-floor scene | `bc-compress.worker.js:397` |
| **The mask pack decodes, PNG-encodes and IndexedDB-persists an entire coarse-pin pyramid (5–21 pages) of which exactly ONE is consumed** — the ingest seam is gated `if (a.page.mip !== pack.table.maxMip) continue`. Pass 3 was deleted 2026-07-22 | 0.3–1.4 s + 50–250 IDB writes on first load; 50–250 ms every warm load. The one page consumed is a 256² thumbnail `createImageBitmap` produces directly | `vt-pan-viewer.js:8839,5559` |

Plus: **`acquirePages` issues one sequential, individually-awaited IndexedDB transaction per page**
(~25–250 ms of pure serialised latency with the CPU idle, and it is the *entire* cost on a warm
reload); **every BC encode band-reads the whole source three times**; and **`bc-compress.worker.js`
has no serial queue** where its sibling `decode-pool.worker.js` explicitly does — reopening the
memory-overrun failure mode its own header documents.

### 8.3 ✅ The per-view residency planner is dead code

`chooseMip`, `chooseMipFraction`, `computeVisiblePages`, `planResidency` and `diffResidency` have
**zero non-test callers**. `pack.residentViewKeys` is only ever created empty and re-created empty.
Every pack still allocates a flattened-pyramid indirection `DataTexture` that the code's own comment
says no shader samples.

**This invalidates the framing of three questions this audit was asked:** there is no pan-direction
prefetch to add, no LRU thrash on a pan-and-back to fix, and no per-frame cost to maintaining a
resident set at 12k zoom-out — **because there is no per-view resident set.** The `PageCache` (512 MB
budget, 2048 slots, an O(2048) LRU scan) is now bookkeeping over a handful of mask coarse pages with
no GPU atlas behind it.

Worth a deliberate decision — kept for a future re-streaming, or retired. Unread structure is the rot
class this project has already named.

### 8.4 Two instruments that lie, under this project's own rule

- **`residency.upload` brackets no upload.** Its entire body is `for (const {decoded} of
  decodedForUpload) decoded.close?.();`. The zone is still labelled *"Page upload."* A reader
  comparing it to `residency.decode` concludes uploads are free, when the path was **deleted**.
  (`vt-pan-viewer.js:8883` · `perf-zones.js:759`)
- **The VRAM inventory counts zero render targets.** `readVram` passes only `vtEstimate` and
  `ceilingMb`; `targets` defaults to `[]`, so the whole `renderTargets` block reports nothing.
  `ThreeAllocator` has an `onCreate` accounting hook that exists for exactly this and is never
  passed. **The real figure is ~88 + 390 + 25 ≈ 503 MB — 20% of the measured 2500 MB device-loss
  wall, not the 3.5% on record.** Every future "add one more screen buffer" decision is being made
  against a number that cannot see screen buffers, on a project whose named crash class is device
  loss on large maps. (`boot.js:2405` · `vram-inventory.js:95`)

---

## 9. WHAT WAS RULED OUT — checked and healthy

Recorded so nobody spends a day re-deriving it.

- **Render-target bandwidth is not the constraint.** §1.1. Counted: 52 GB/s demand, >800 GB/s
  demonstrated supply.
- **Point lights are real radius-scaled fan polygons, not screen quads.** §1.2.
- **Redundant clears: none worth fixing.** The illum sequence correctly disables `autoClearColor`
  across its four draws into one target, and the reasoning was verified against the vendored
  `Background#update` rather than assumed. Every clear-then-fully-overwrite case is the *optimal*
  choice on a desktop GPU — `loadOp:clear` beats `loadOp:load`.
- **No redundant blits or copies anywhere.** Every pass renders directly into its target.
- **Bloom is genuinely well-built** — half-res mip0, Karis on the first step only, one reused
  downsample material, two bands out of one chain, 0.48 ms across six zones. Nothing to take.
- **Every optional pass has a real JS early-return, not a uniform gated to zero.** `runPostDofPass`
  additionally early-outs on `floorIndex === 0` — a genuine content-aware cull.
- **The pass runner is clean.** `planFrame` is computed once at closure construction; `passImpls` is
  a static literal; `profiler.passHooks` is one object built at construction. No per-frame graph
  compile, no hidden second copy of the frame order.
- **Draw items and floors are genuinely view-culled** — `rectsOverlap(state.worldBounds, worldRect)`,
  and floors by Foundry's own `visibility.levels` rule rather than a homegrown "always show one
  below". Vegetation and its shadows inherit that cull correctly; the depth pass inherits it again.
- **The sun-shadow bake is sized to the world, not the map and not the view** — a fixed 512–2048
  square, O(1) in map size. *"A 12000px map and a 2000px map both get exactly this."* Masks are
  likewise derived on a coarse fixed grid, lazily, off each pack's coarsest mip.
- **Candle flames are one batched mesh** whose geometry rebuilds only on a content-hash change, and
  whose draw measures 0.022 ms. Not worth culling. `candleFlameSignature` is an allocation-free
  integer hash.
- **The point-light buffer-reuse discipline is good** where it exists — `triangulateLightFan` writes
  into a scratch array with a high-water mark; `writeLightEdgePoints` mutates Vector2s in place.
  (Which makes §3.7's doubled allocation, in the same function, the odd one out.)
- **`updateUiShadowStamps` is frame-throttled** and its original cost (an extra render pass, not the
  DOM read) was already found and removed.
- **The debug-channel machinery costs nothing at ship defaults** — the material is swapped entirely,
  so channel 0 never binds it.
- **The keyhole allocation law is enforced** — nothing bypasses `enforceKeyholeLaw`, and
  `gpu/allocator-only` walls off raw `new *RenderTarget(`.
- **`masks.occlusionDraw` and `light.drawRegions` at 0.000 ms are genuinely empty passes.** Used as
  the calibration throughout: **an empty `renderer.render()` is free**, and §4's isolate test prices
  a removed draw call at **~0.013 ms**. No finding here rests on eliminating one.
**Added by the 2026-08-08 surface-stage follow-up (fluid + specular-islands):**

- **Fluid's bake is correctly and singularly gated, with a documented history of getting this
  exact thing wrong once already.** `fluid-surface-subsystem.js`'s own header: *"THE BAKE TRIGGER IS
  THE MASK URL, and it is the only one. A previous draft also shipped a version-polling module; two
  triggers for one bake is `feedback_mode_forks_silently_drop_features`, so the loser was deleted."*
  `getStatus()` reports `bakes` against `syncs` specifically so the claim can be *seen* to hold, not
  just asserted. `prepareSimTick`'s per-tick work writes into a reused `Float32Array`
  (`writeFluidTubeConstantsBuffer`'s own doc: "written in place … without a fresh allocation") and is
  skipped entirely while disabled. **One small, honestly-sized non-finding:** `getFluidMaskItems`
  rescans the whole scene item list every frame regardless of whether the floor has any fluid content
  at all — but `authoredStatusForItem` is two `Map.get`s, not a `hostsOfFloor`-style allocation
  avalanche (§5.3's pattern), so this is genuinely cheap and not worth its own top-level entry.
- **`specular-islands.js`'s rebake is correctly value-guarded against unrelated slider drags.**
  `specular-surface-subsystem.js:523-528`: `if (Number.isFinite(p.islandSpread) && p.islandSpread
  !== islandSpread) { … bakeIslandPack(...) }` — with the comment explicitly naming the trap it
  avoids: *"Guarded on an actual change so dragging any OTHER slider does not relabel the map: the
  params key above fires on all of them together."* Properly zoned
  (`profiler.beginById('surface.specularIslandBake')`).

- **The water JFA is correctly gated — it does NOT run per frame.** `maybeBake` early-returns on
  `version === bakedVersion && floor === bakedFloor && override === bakedOverride`
  (`water-body-subsystem.js:423-441`). The seed → N flood rounds → resolve ladder only fires on a
  real change. The per-frame poll itself is a resolve + three comparisons. *(Its gate key is the
  shared counter, which is §5.8's problem, not water's.)* The `runFlood`/`maybeBake` split, and the
  header's note that the trigger **must** live in the frame loop because "a mask repaint is not a
  camera event", are both right.
- **Specular's presence gate survived the uncommitted edits.** `specular-render.js:874-876` is still
  `Fn(() => { If(presence.greaterThan(float(0)), () => { … }) })`, with the header comment at
  `:863-874` still spelling out why the maths had to move *inside* `Fn()` rather than just be wrapped.
  The shipped 2.96 → 0.675 ms win is intact. **Re-check this after any specular edit** — it is the
  one gate in the codebase with a measured 4.4× behind it and a documented way to silently lose it.
- **`specular-islands.js` is NOT the per-island quad plan that §3 declared obsolete.** Similar name,
  different thing: it is a per-island *parallax texel pack* — parameters written straight into the
  pack, "one fetch with no dependent read", no record array, no lookup table, **no island cap**, so
  island count costs nothing at render time. Its own header says a map with four thousand coins packs
  as fast as one with a single door. **Nobody rebuilt the declined optimisation** — worth stating so
  a future reader doesn't read the filename and assume otherwise.
- **❌ REFUTED: "vegetation's fragment flutter recomputes a scalar the vertex stage already has."**
  It does not. The vertex stage samples at the **clump-cell centre**, quantised to `uClumpSizePx`
  (default 150 world px); the fragment stage samples at the actual fragment position. **Different
  values by design.** The hoist is still *directionally* available but it is **not free** — it costs
  a second vertex-stage wind sample — and its visual risk is **not** none, since flutter strength
  would move from per-pixel to per-vertex-interpolated.

**Added by the `boot.js` / `effectRegistry` follow-up, 2026-08-08:**

- **`effectRegistry`'s callback layer is clean.** All 15 registered effects' `apply` callbacks read
  end to end (§5.8's effectRegistry-audit note has the full breakdown) — 14 write a trivial readout
  object, none do unconditional heavy work. Sun-shadows is confirmed the **one** exception, not one
  instance of a wider pattern.
- **Two Foundry hook watchers already do exactly the field-level filtering §5.8 finds missing
  elsewhere — worth using as the template, not just naming the gap.** `scene-walls.js#watchDoorOpenings`
  takes Foundry's real `(doc, change)` hook signature and checks `'ds' in change` before doing
  anything, further narrowed to the specific closed→open transition. `sky-persistence.js#watchSceneSky`
  does the identical shape for its own flag namespace: `if (!change?.flags?.[SKY_NAMESPACE]) return;`.
  Both verified against this project's own vendored Foundry source for the hook's real argument
  order, not assumed. `scene-walls.js#watchSceneWallStructure` deliberately does NOT filter, and says
  so in its own header — "unfiltered, same posture as every other `read*`/`watch` function in this
  file… coalescing that burst into one rebake is the CALLER's job" — a conscious design choice with
  the responsibility named, not an oversight.
- **Particles and the wind sim's own hook-adjacent triggers are correctly scoped.** `wind-sim`'s
  door-gust impulses ride `watchDoorOpenings` above, not a naive wall-CRUD listen — confirmed while
  tracing §5.10.

---

## 10. The cheapest next actions

Ordered by information gained per unit of effort. **Four of the five still open need no code change
at all.** (#3 is already done — struck through, kept for the record.)

| # | Action | Cost | Settles |
| --- | --- | --- | --- |
| 1 | **Take any zone profile and read `geometry.depthDraw`.** It is already bracketed, already top-level, already reported — the number has simply never been looked at | **zero** | §4.3 — a whole second full-scene rasterisation running every frame that appears in no table anywhere |
| 2 | **Read the CPU zones that already exist and have never been quoted**: `light.pointLightUpdate`, `depth.proxyRebuild`, `masks.sync`, `light.regions`, `light.sunShadowBake` | zero | §§3.6–3.8, 5.1, 5.4, 6.1 at once. **No CPU-zone number appears anywhere in either performance document** |
| ~~3~~ | ~~Log `maskAuthority.getProductsVersion()` per frame while dragging the Wall-height slider~~ | — | **✅ DONE 2026-08-08** — mechanically confirmed by executing the real module (§5.8). The one thing still missing: watching it happen in an actual running Foundry session, if one becomes available |
| 4 | **Set `SUN_SHADOW_MAX_FLOORS = 1`** on a single-floor scene, run the route, read `light.drawPointLights` | one constant | §3.3 — the item four independent readers found |
| 5 | **Comment out the coloration `render()`**, read the delta | one line | §3.1 — sizes the MRT merge before any of it is designed |
| 6 | **Read `MapShine.flight.snapshot().log.bySource`** after a 60 s sweep | zero | §7.5 — closes it or proves it live |

Then, in order of expected value and only once measured: §3.1 (MRT merge), §3.2 (half-res illum +
coloration), §3.5 (`varying()` the wind sample), §3.4 (JS-gate the identity grade stack).

⚠️ **Before trusting any comparison:** `Performance-Insights.md` §0's rule still holds — back-to-back
runs with no code change have moved frame GPU by ~7% and individual light zones by ~30%. **Any "win"
smaller than that is noise.**

---

## 11. What this audit did not look at

Named so the gaps are not mistaken for clean bills of health:

1. **The surface stage — CLOSED, 2026-08-08.** Water's JFA gating, specular's presence gate,
   fluid's mask-URL-triggered bake, and specular-islands' value-guarded rebake are all chased down
   and all healthy (§9). The one real defect found — the window glass compile-time gate never being
   wired to `glassWarpPx` — is §5.9, and it is confirmed by reading, including the codebase's own
   admission of the gap in a structured deferred-rung note. The window/aperture-gobo glass-model
   duplication is folded into the same entry. Nothing in the surface stage remains unread at the
   level this document operates at.
1b. **`src/effects/fire/` — a whole new effect, untracked, ~112 KB, created 2026-08-08 while this
   audit was being written.** Already wired at `vt-pan-viewer.js:2240`. **Entirely unaudited** and
   deliberately so — auditing a half-written effect is neither fair nor useful. Revisit once it
   lands. All that is established: it *reads* `buf:scene.depth`, it adds no depth-pass draws.
2. **Verification for five territories** — culling, sun-shadows, geometry-effects, buffers-post,
   diag-ui-overhead. Given that verification refuted one finding and corrected five sizes downward
   in the six territories that got it, expect the ⬜ entries to shrink under the same scrutiny.
2b. **Particles and the wind simulation — CLOSED, 2026-08-08 (§5.10).** Both named directly in the
   original brief ("are off-screen particles simulated?", "is wind GPU or CPU, what grid, what
   cadence?") and never confirmed until this pass. Both came back healthy: particles are
   capacity-fixed and view-rect-confined, not map-scaling; the wind transient sim runs on a bounded
   GPU grid with a real idle/thaw gate. One escalation came out of this pass, filed at §5.8: the
   same shared mask-version counter also drives a wind/outdoors/fire rebake poll, which is where the
   light-material-rebuild storm (§5.6) actually gets triggered from — and that poll's own 500 ms
   throttle is the one place in the whole cascade this exact problem was already solved once.
3. **`src/boot.js` and `effectRegistry.register` callbacks — SUBSTANTIALLY CLOSED, 2026-08-08.** All
   15 registered effects' `apply` callbacks read directly (not incidentally): 14 are clean, one
   (sun-shadows) is the already-documented §5.8 outlier — a genuinely valuable negative result,
   since it rules out the registry layer as a source of more surprises like it. `boot.js`'s own
   `Hooks.on`/`Hooks.once` registrations (6 sites) and a representative sweep of `src/foundry/`'s (9
   sites across 7 files) were also read directly, which is what found the unfiltered Level/Tile hook
   handler sharpening §5.8, and the two correctly-field-filtered hook watchers (`watchDoorOpenings`,
   `watchSceneSky`) that serve as its fix template. **Not fully closed**: `boot.js` is 7,128 lines and
   this pass followed the effect-cascade and hook-registration threads specifically, not a
   line-by-line read of the whole file — the diagnostic/perf-lab machinery, the anchor CRUD block,
   and the scene-load sequencing were not examined with the same depth. `src/foundry/`'s remaining
   ~30 files beyond the ones this pass touched are likewise unaudited.
4. **Shader-permutation and pipeline-compile stalls at scene load** — §5.1's rebuild-key hazard and
   §5.6's rebuild storm were both found incidentally. Nobody swept for materials created outside
   arm/init.
5. **Startup time, long-session memory growth, low-end/integrated GPU behaviour, scene-switch cost,
   and many-tokens-moving-at-once.** All plausible, none examined.
6. **Anything requiring a running app.** Almost every claim here is a code read, with one exception:
   §5.8 was additionally confirmed by *executing* the real, unmodified `mask-authority.js` under
   Node — a genuine step up from reading, though still short of a live Foundry session, which
   remains unavailable on this machine (no server running, no discoverable data path). The whole
   point of §10 is that the instrument already exists and several of its dials have never been
   turned; §5.8 shows a cheaper middle path also exists — running the real *non-GPU* half of a
   subsystem directly, without needing the app at all.

---

## 12. 2026-08-09 — a real live perf report landed, and 8 fixes went in

**A real perf-profile JSON, captured by the author from a running session** (route
`n_to_s:2kf/60000ms`, 2212 frames, `msaVersion 0.6.0-dev.0`), is saved at
`docs/planning/perf-reports/2026-08-09-live-sweep.json` with a synthesis at the `.md` alongside it.
Read that file for the full cross-reference against every finding above — the headline is that
several "unsized, guessed 0.3–2 ms" entries turned out to be **larger than guessed**, and the
instrument's own `findings[]` array (sorted by severity) independently named the same top costs
this document already suspected.

### What the live report changed about this document's own priorities

- **§4.3 `geometry.depthDraw`: measured at 5.872 ms mean CPU, 46.6 ms max, every frame** — confirmed
  real, confirmed large (≈82% of the whole `geometry.world` pass's CPU cost, by arithmetic against
  the pass total), and confirmed as this document's single highest-value unfixed target. **Not
  fixed** — see below.
- **A cost this document never sized at all: `residency.pass` (`scheduleResidencyUpdate`) — 12.484 ms
  mean per occurrence, 44 ms peak, firing on 42% of frames during a pan.** The single largest raw CPU
  number in the whole report. Nothing this document catalogued inside `updateResidencyUnguarded`
  accounts for it (`depth.proxyRebuild` alone is 0.257 ms/occurrence). **This is now the single
  biggest open question this document does not answer.**
- **§3.1's illumination/coloration duplication got hard numbers on both sides**: GPU 3.941 + 3.787 ms
  combined, CPU-encode 2.377 + 1.409 ms combined — the CPU-encode figure is new information.
- **§8.4's VRAM-inventory gap was confirmed live, verbatim**: `renderTargets.count: 0`. **Fixed.**
- **§5B's (`Performance-Insights.md`) candle-flame methodology finding was independently
  reproduced**: the live report's own `method-disagreement:candleFlame` finding (zone sum 0.025 ms vs
  sweep marginal 3.45 ms) is exactly the signature that finding predicts.
- Two **instrument-health** flags the report raised as "high severity," inherited here: one
  unbalanced profiler bracket (one zone's number this run is suspect) and a GPU timestamp-query pool
  overflow (some GPU numbers this run are missing, not zero). Overall coverage was still 97.9%,
  "good" — the top-level picture is trustworthy; a specific number close to these caveats should be
  re-measured, not treated as final.

### Fixed (working tree, uncommitted pending review — 8 files, +421/−69 lines)

All CPU/JS-only. **Zero shader or TSL changes were made** — every fix below is either a pure
data-flow hoist (compute once, reuse where the value cannot differ), a dead-allocation removal, or a
diagnostic-only wiring fix. `npm run verify` is green throughout (8,157 tests, lint, format, all 29
structure rules). None of this has been seen live — see the caveat at the top of §11.

| Fix | Targets |
| --- | --- |
| `getActiveSceneFloors` hoisted out of the per-tile frame loop (was once per tile per frame, now once per frame) | §5's masks-depth-5 / frame-loop-1 |
| `computeAmbientColors` hoisted when no darkness regions are active (was once per light per frame) | §3.6 |
| The dead soft-edge SDF's doubled `normalizeLightPolygon` call removed — `triangulateLightFan` now returns its own normalization for `writeLightEdgePoints` to reuse instead of recomputing it | §3.7 |
| A real VALUE-comparison dirty-check added to per-frame light re-triangulation — skips `triangulateLightFan`/`writeLightEdgePoints`/buffer re-upload for a light whose (x, y, radius, shapePoints content) is unchanged | §3.8 |
| Aperture-gobo wall segments pre-filtered to `aperture === true` once per frame, before the per-light scan (was: every light scans every wall) | §5.1, §6.8 |
| The VRAM inventory wired to real render targets — `ThreeAllocator` gained a paired `onCreate`/`onDispose` hook; `vt-pan-viewer.js` exposes a live registry; all 3 `buildVramInventory` call sites in `boot.js` now pass real `targets` | §8.4 |
| The `residency.upload` zone renamed to `residency.releaseBitmaps` — its body has measured a bitmap `.close()` loop since the real upload was deleted 2026-07-22; the old name told a reader "uploads cost ~0 ms" about a path that no longer exists | §8.4 |
| The profiler's own per-bracket allocation overhead removed — `readDrawCalls`/`readTriangles` now read `renderer.info.render` directly (two zero-allocation accessors) instead of 4× `readRenderInfo()` per bracket, which allocated a fresh `Vector2` + 5-field object each time | §7.4 |

### Investigated and deliberately NOT attempted — with the specific reason, not a general one

- **Caching aperture-gobo wall segments across frames via `watchSceneWallStructure`** (the other half
  of §5.1/§6.8). Found unsafe to self-register inside `createPointLightPool`: `startVtPanViewer`/
  `stopVtPanViewer` is a confirmed real restart pair, and the watcher has no unsubscribe — registering
  it in the pool factory would leak one set of `Hooks.on` listeners per viewer restart. The correct
  fix threads a version counter from `boot.js` (the only place allowed to register raw hooks) through
  `vt-pan-viewer.js` into the pool as an injected getter — a three-file change across two large,
  active files, deferred as too invasive for this pass.
- **A wall-clock debounce on sun-shadow's and water's bake gates**, mirroring `pollMaskAuthority
  ForWindRebake`'s already-shipped 500 ms throttle (§5.8). The pattern does not transfer as directly
  as it looked: wind's throttle gates a *cheap check* (skipping it loses nothing, since any mid-burst
  version is equally unsettled); sun-shadow/water's problem is that their *expensive bake* fires on
  every distinct value once their own cheap check finds a real difference. Throttling the bake itself
  safely requires intercepting inside each subsystem's own `maybeBake`, right before the GPU call —
  an outer wrapper that skips calling `maybeBake` entirely would also skip the bookkeeping that keeps
  future checks correct. That means editing bake-decision logic inside two core GPU-effect files with
  no way to visually confirm a throttled bake doesn't leave stale-looking shadows. Deferred; the fix
  shape is fully designed for whoever has live Foundry access to verify it.
- **The `geometry.depthDraw` incremental proxy reconcile** — the highest-value target this whole
  document names, and the highest-risk. `buf:scene.depth` is a shared foundation multiple effects
  read (the point-light height gate, depth of field, specular, window, fire's occlusion, sun-shadow's
  floor attribution); no existing test could catch "the change-detection missed one field and this
  shared buffer is now subtly wrong for every consumer." Left fully diagnosed, not attempted, for a
  session with live visual verification.

### What still needs checking, unchanged from §11 plus one new item

Everything §11 already named (the five originally-unverified territories, `src/boot.js`'s remaining
~7,000 lines beyond the effect-cascade/hook threads, `src/effects/fire/`, startup time, memory
growth, low-end GPU behaviour) is still open. Added by this pass: **what, specifically, inside
`updateResidencyUnguarded` costs 12.484 ms per occurrence** — the single largest number in the live
report has no named culprit anywhere in this document.

## 13. 2026-08-09, round 2 — the before/after report confirmed the targeted wins; this round chases
the two things it left flat

The live before/after comparison (§12's report, captured 1 hour apart) confirmed `light
.pointLightUpdate` fell 23.8% (3.686ms → 2.807ms) and the VRAM/instrument fixes work exactly as
built (`renderTargets.count` 0 → 25, `unbalancedBrackets` 1 → 0) — real, attributable wins, entirely
in tail-latency (hitches 19 → 8, p99 50ms → 41.6ms) rather than average fps (flat at 38.6, because the
frame is GPU-bound and every round-1 fix was CPU-only). It also confirmed, by leaving them
untouched, that `geometry.depthDraw` (5.872ms → 5.792ms) and `residency.pass` (12.484ms →
11.438ms, essentially flat) are real, reproducible, NOT measurement noise — exactly the two named at
the end of §12 as the top remaining priorities. This round went after both, and against the third
deferred item from §12 (the aperture-gobo cache).

### Instrumentation added, not a fix — `residency.pass`'s 12ms mystery is now measurable, not solved

Read `updateResidencyUnguarded` end to end looking for what the four already-zoned sub-costs
(`depth.authorityRebuild`, `depth.proxyRebuild`, `vegetation.rankStamp`,
`vegetation.depthItemsBuild` — summing to ~0.3ms) don't cover. Five candidates had NO bracket at
all: `refreshCoarsePinBudget`, `primeCoverAlphaGrids`, the stale-item release/unpin loop, PHASE 1
(per-item load), PHASE 2 (per-item placement + mesh refresh). Reading each one's steady-state cost
by hand did not turn up an obvious single culprit — `ensureWholeImageMeshes` short-circuits
immediately for an already-loaded item, `refreshWholeImageItem`'s steady-state cost is two property
writes per tile, `refreshItemPlacement` is one arithmetic call + a string compare. Nothing read as
individually expensive; the 12ms may be O(item count) death-by-a-thousand-cuts across PHASE 1/2,
or concentrated somewhere this reading missed. **Rather than guess-fix on code-reading alone
(`feedback_measure_the_output_not_the_equation`), five new zones now bracket every previously-dark
line of this function**: `residency.coarsePinBudget`, `residency.coverAlphaPrime`,
`residency.staleRelease`, `residency.itemLoad`, `residency.itemRefresh` (`perf-zones.js`,
`vt-pan-viewer.js`). The next live capture will show the real breakdown; this pass only removed the
blindfold.

One real-but-probably-small finding surfaced along the way, deliberately NOT fixed: `refreshCoarsePin
Budget` calls `buildItems(f)` once per FLOOR, every single residency pass (not just on document
CRUD), to recompute the scene's total unique-item count for the coarse-pin budget. `depth
.authorityRebuild`'s own 0.011ms mean already includes one `buildItems(singleFloor)` call, so doing
it floorCount times is real but likely on the order of 0.02–0.05ms for a typical few-floor scene —
not a plausible explanation for a 12ms gap. A proper fix means threading document-CRUD-vs-view-change
awareness into a function that currently can't tell the two apart, which is exactly the kind of
correctness-sensitive redesign this document's own named bug classes warn against attempting without
a way to verify the invalidation is complete. Left diagnosed, not attempted — low priority given its
likely size.

### Fixed: aperture-gobo wall segments now cache across frames (closes the deferred half of §5.1/§6.8)

`point-light-pool.js` was calling `readSceneWallSegments(currentFloorId)` — a full walk of every wall
on the scene, re-deriving solid/blocksExterior/aperture per wall — once per frame, every frame,
whether or not any wall had moved since the previous frame. Walls only change on
createWall/updateWall/deleteWall (editing-cadence, exactly the same observation §5.8 already made for
sun-shadow/water's own bake gates). Fixed the way §12 said it would need to be fixed: a version
counter lives in `boot.js` (the only place allowed to register raw `Hooks.on` — `foundry/adapter-
only`), registered ONCE via the existing `watchSceneWallStructure` adapter, independent of the
confirmed `startVtPanViewer`/`stopVtPanViewer` restart pair — so it cannot leak a listener per scene
switch the way self-registering inside `createPointLightPool` would have. The counter reaches the
pool as a GETTER (`getApertureWallVersion`), threaded through `startVtPanViewer`'s own dependency
list exactly like `buildItems` already is, for the same reason `getWindHandle` is a getter and not a
captured value (this file's own "GETTERS VS VALUES" header trap) — capturing the number once would
freeze the cache forever at whatever version existed at pool construction. The pool caches the
aperture-filtered segment list keyed on `(currentFloorId, wallVersion)`; `enabled` is deliberately NOT
part of the key, since the (floor, wall-version) → segments mapping is correct regardless of whether
the effect happens to be on, so toggling it cannot invalidate anything the walls themselves didn't.
Defaulted (`= () => 0`) at both injection points so the torture/soak fixture, which passes no wall
context, still constructs a working pool. `npm run verify` green throughout (8,157 tests). Not seen
live — the cache-correctness argument is structural (a scene switch tears down and rebuilds the whole
pool, so a stale cache surviving a scene change is not a reachable state), not measured.

### Investigated, still NOT attempted — unchanged from §12

`geometry.depthDraw`'s incremental proxy reconcile and the sun-shadow/water wall-clock debounce are
untouched this round for the same reasons §12 already gave: both need a way to visually confirm
"nothing looks stale" that this session does not have. The before/after report's own flat numbers on
`geometry.depthDraw` (5.872ms → 5.792ms) make it, if anything, a more confident target for whoever
next has live Foundry access — two independent captures now agree on its cost.

### What still needs checking

Unchanged from §12, plus: **the actual breakdown across the five new residency zones** — this pass
built the instrument, not the answer. Whoever captures the next live report should look at
`residency.coarsePinBudget`/`coverAlphaPrime`/`staleRelease`/`itemLoad`/`itemRefresh` first, before
anything else in this document, since one of them is very likely to be most of `residency.pass`'s
remaining ~12ms.

### Instrumentation added: diagnostics for the GPU timestamp-query pool overflow

Both live reports carried `instrument.gpuTimer.poolOverflowed: true` (§12) with no named cause
anywhere in this document. Traced the mechanism as far as static reading allows:
`renderFrame`'s own GPU-probe throttle (`if (gpuProbe.isActive() && gpuProbe.isMeasuring()) return`,
`vt-pan-viewer.js`) skips `gpuZoneTimer.collect()` — the call that resets three's
`currentQueryIndex` — for every tick between submitting a frame and that frame's
`onSubmittedWorkDone()` resolving. Verified in the vendored source
(`three.webgpu.js:74987`) that the index reset happens the instant
`resolveTimestampsAsync` is CALLED, not when its promise settles — so under normal operation the
pool resets every single rendering frame and should almost never overflow. The plausible remaining
mechanism: `collect()`'s own `resolveInFlight` guard skips calling `resolveTimestampsAsync` again
while a PRIOR call is still awaiting `resultBuffer.mapAsync` — if that readback stalls behind a real
GPU backlog (the same backlog that would also produce the 44-66ms worst-case frames already in both
reports), enough frames could render while genuinely blocked to cross 1024 outstanding passes before
the stuck resolve ever clears. **Not confirmed — this is one hypothesis, not a diagnosis.**

Rather than guess a fix for an unconfirmed mechanism, added two counters to `gpu-zone-timer.js`
(`maxPendingSize`: the peak backlog a run ever reached, even short of the alarm threshold;
`maxResolveSkipStreak`: the longest run of consecutive `collect()` calls blocked by a still-in-flight
resolve) and rode them along on the *existing* `timestamp-pool-overflow` finding's evidence — a
mid-task correction: the first draft of this added a SECOND, duplicate finding
(`gpu-timestamp-pool-overflowed`) before checking whether one already existed. It did
(`method?.timestampPoolOverflowed`, `perf-report.js:830`, gated on the same underlying
`gpuStatus.poolOverflowed` value via a differently-named field) — caught before landing, reverted, and
the counters attached to the real finding instead. A high `maxResolveSkipStreak` right before an
overflow in the next live report would confirm the stuck-resolve hypothesis; a low one would rule it
out and point back at something else entirely. `npm run verify` green (8169 tests).

## 14. 2026-08-09, round 3 — a third live report closed the residency.pass mystery and overturned the pool-overflow hypothesis

A third live capture (`docs/planning/perf-reports/2026-08-09-live-sweep-after-round2.json`, generated
16:08:32, ~1h39m after §13's report, same route `n_to_s:2kf/60000ms`, same resolution) landed with
round 2's instrumentation actually built into the profiled binary — the first report ever to carry
the five new `residency.*` zones and the two new `gpuTimer` counters. Both paid off immediately.

### `residency.pass`'s 12ms mystery: SOLVED, not just instrumented

| Zone | Mean CPU (this report) | Share of `residency.pass` |
| --- | --- | --- |
| **`residency.itemLoad` (PHASE 1)** | **10.139 ms** | **~96%** |
| `residency.coarsePinBudget` | 0.077 ms | |
| `depth.proxyRebuild` | 0.218 ms | |
| everything else (coverAlphaPrime, staleRelease, itemRefresh, depthAuthorityRebuild, vegRankStamp, vegDepthItemsBuild) | ~0.08 ms combined | |
| **`residency.pass` total** | **10.524 ms** | **100%** |

Nearly the entire cost is PHASE 1 — the loop that does `await ensureItemLoaded(item)` per item. This
is NOT wasted CPU: `residency.itemLoad`'s own `drawCalls`/`triangles` figures (459.1 / 338,933.3) are
almost identical to `residency.pass`'s own (459.1 / 338,933.3) — meaning ordinary frames keep
rendering (and their draw calls land inside this zone's open bracket) while the await is genuinely
suspended, exactly as `updateResidencyUnguarded`'s own header describes. This is **wall-clock time
spent on real asynchronous loading work** (decode, ranged fetch, worker dimension round-trips — see
`ensureItemLoaded`'s own comments) as the pan continuously reveals new map content, not a CPU cycle
being burned pointlessly. The eight zones this document and round 2 sized as candidates (coarse-pin
budget, cover-alpha priming, stale-item release, PHASE 2, plus the four pre-existing residency zones)
were all correctly ruled out — they sum to ~0.4ms, matching the earlier code-reading estimate almost
exactly. **The mystery is closed. Whether the streaming pipeline itself (decode worker count, ranged
fetch batching) can be made faster is a new, well-defined, separate question — not the open one this
document has carried since §12.**

### The GPU-pool-overflow hypothesis from §13: likely WRONG, and the data says why

`maxPendingSize: 2019` (just past the 2000 alarm) but **`maxResolveSkipStreak: 3`** — far too short a
streak to accumulate 2019 pending queries through a stuck `resolveTimestampsAsync` alone (even at the
file's own "~25 passes/frame" estimate, 3 blocked frames account for under 150 queries). The
stuck-resolve hypothesis is not supported by this run.

The number that actually explains it: this scene carries **~117 point lights** (`light
.drawPointLights`/`light.drawColoration` both report `drawCalls: 117`), each drawing through two
passes. A single frame's total timestamped render-pass count is therefore easily 250-300+ — five to
ten times the "~25 render calls per frame" this file's own header comment (`gpu-zone-timer.js`) was
written against. Against a pool that holds only 1024 passes total, ordinary, non-pathological GPU
readback latency of even 3-4 frames is enough to overflow on a scene this light-dense — no stall
required. **This is very likely an inherent limitation of the fixed-size vendor pool on light-heavy
scenes, not a bug in this codebase**, and there is no known safe fix: the pool size (`2048`, `three
.webgpu.js:76495`) is hardcoded inside `WebGPUBackend` with no constructor option or injection point,
so raising it means patching vendored code — exactly the kind of blind vendor edit this project
avoids. Recommendation: stop treating `poolOverflowed` as an open question on light-dense scenes: note
it as an accepted instrument limitation (the report's own attribution.coverage of 97.4% already tells
the reader most of the run is still trustworthy) rather than a target for further investigation,
unless a future low-light-count scene ALSO overflows — that would revive the stuck-resolve theory.

### The improvement trend, now three points instead of two

| | Before (13:28) | After round 1 (14:29) | After round 2 (16:08) |
| --- | --- | --- | --- |
| p99 frame time | 50.0 ms | 41.6 ms | **33.5 ms** |
| Hitches (>50ms) | 19 | 8 | **6** |
| p1 Low fps | 20 | 24 | **29.9** |
| CPU encode p50 | 17.6 ms | 16.32 ms | **14.13 ms** |
| avgFps | 38.6 | 38.6 | **40.5** |
| `light.pointLightUpdate` mean | 3.686 ms | 2.807 ms | **2.428 ms** |
| `geometry.depthDraw` mean | 5.872 ms | 5.792 ms | 5.198 ms |

Every tail-latency metric has now improved on three consecutive captures — a trend, not one noisy
run. `light.pointLightUpdate`'s continued drop is consistent with round 2's aperture-gobo caching
fix. `geometry.depthDraw` also moved down this time despite nothing targeting it directly — read as
favourable run-to-run variance, not evidence its root cause (the unconditional `discard()` defeating
early-Z, §4.3) is fixed; that fix is still fully unattempted. Two honest wrinkles: `light
.pointLightUpdate`'s *max* rose (23.9ms → 29.1ms) even as its mean fell — plausibly one frame paying
the aperture cache's own invalidation cost on a floor/wall-change moment, not investigated further;
and the effect sweep measured nothing this run (`sweepEffectsMeasured: 0`) — its own finding explains
why (every effect fell inside this run's ±2.75ms noise floor) — a pre-existing sweep limitation
exposed by this run's particular noise level, not a regression.

### Investigated same session: `ensureItemLoaded`'s pipeline — instrumented further, NOT restructured

Read `ensureItemLoaded` end to end chasing `residency.itemLoad`'s 10ms. Found a real, well-evidenced
opportunity: PHASE 1's outer loop (`for (const item of items) { ... await ensureItemLoaded(item) ...
}`) and, one level down, `loadExtraLayerPacks`' own per-mask loop are BOTH plain sequential
`for`-await loops — items (and a single item's own masks) load strictly one at a time. The underlying
decode pipeline already supports real concurrency: `decode-pool.js`'s `_sliceSem`
(`SLICE_MAX_CONCURRENT_SOURCES = 3`) exists specifically to bound — not prevent — concurrent source
decodes, and multiple hitch samples show it sitting at `active: 0` alongside real work elsewhere,
meaning the 3-way concurrency headroom this semaphore provides is never exploited by either loop.
Parallelising both (`Promise.all` over items/masks, order preserved via `.map()`, per-item failure
isolation preserved via a try/catch inside each mapped async function so `Promise.all` never rejects)
is architecturally straightforward and the semaphore already makes it safe from a memory/decode-
concurrency standpoint.

**Deliberately NOT attempted.** This exact async-suspension point — `updateResidencyUnguarded`
genuinely yielding mid-pass while the render loop keeps ticking — has caused multiple real, subtle,
hard-to-reproduce live bugs already this project (the two-round vegetation rank-stamp flicker, the
whole-screen MAGENTA regression, the "permanently-broken item" retry storm `ensureItemLoaded`'s own
header documents). Changing WHEN items become available in `itemStates`/`states` — from strictly
one-at-a-time to a concurrent burst — is exactly the kind of timing change that class of bug hides
in, and this session has no way to visually confirm a change here doesn't reintroduce one. Instead,
added two finer zones, nested inside `residency.itemLoad`: `residency.itemLoadDims` (wraps
`getSourceDimensions`) and `residency.itemLoadMasks` (wraps `loadExtraLayerPacks`), firing once per
NEW item rather than once per pass — their own `occurrences` count will tell the next live report how
many new items typically load per pass (a number nothing currently exposes) and which of the two
sub-calls actually dominates. That evidence is what should decide whether the parallelisation is
worth the risk, and should ideally come from someone who can also confirm live that nothing broke.

### Fixed: door leaves were re-uploading GPU geometry every frame, animating or not

Found while scanning for OTHER steady-cadence zones with unexplained per-frame cost:
`tick.doorSync` measures 1.003ms mean, EVERY frame (`occurrenceRate: 1`), regardless of whether any
door is actually moving. Reading `syncDoorGraphics` (`door-graphics-subsystem.js`) found the cause:
the CLOSED placement was already correctly dirty-checked (`doorClosedSignature` + `leaf.closedSig`,
recomputed only when a door's geometry-affecting inputs actually change) — but the ANIMATED placement
one step later was not. `applyDoorAnimation` + `doorSnapshotToPlacement` + `buildQuadPositions` ran
unconditionally every frame for every leaf, and unconditionally set `posAttr.needsUpdate = true` —
forcing a real GPU buffer re-upload — even for a door sitting fully open or fully closed, which is the
overwhelming majority of a door's lifetime. Exactly the same bug shape as §3.8's point-light
re-triangulation fix (round 1), just one layer over in a different subsystem.

**Fixed** with the same shape of dirty check: `leaf.lastAnimSig`/`lastAnimDirection`/
`lastAnimStrength`/`lastAnimProgress`, covering every input `applyDoorAnimation` reads that the
existing `closedSig` does not (`door.animation.direction`/`strength`) plus `leaf.progress` itself —
verified by hand against 6 scenarios (first sight, steady state, mid-animation, an instant snap with
animation off, a live wall-geometry edit, a direction/strength-only change) rather than assumed.
`npm run verify` green (8169 tests, unchanged count — this stateful, THREE.js-dependent subsystem has
no direct unit harness, same as `point-light-pool.js`; only its pure math helpers are tested, and
those are untouched). **BUILT, not live-verified** — but this fix's failure mode is unusually
forgiving even if the dirty check were subtly wrong: the worst case is running every frame anyway
(correct, just unoptimised) or a one-frame-late update that self-corrects the next frame, never a
persistent wrong-state or a crash — a meaningfully safer risk profile than the residency-loop change
just above, which is why this one was attempted and that one was not.

### What still needs checking

`residency.itemLoad`'s real bottleneck is now instrumented two levels deep (`itemLoadDims`/
`itemLoadMasks`) but still not measured — the next live report should read those first. Whether the
door-graphics fix actually moves `tick.doorSync` toward zero on a mostly-idle scene is also unmeasured
until the next live capture. `geometry.depthDraw` and the sun-shadow/water debounce remain the two
committed, fully-diagnosed, not-yet-attempted targets from §12/§13, unchanged by anything found here.

### Correction, and a 4th report: a self-caught mis-attribution, a real bracket bug, and a genuinely
mixed result

**Correction first.** The "`tick.doorSync` measures 1.003ms mean" claim two sections up is WRONG —
that number is `geometry.doorDraw`'s (the draw-call encode cost, `renderDoorGraphicsInto`), not
`tick.doorSync`'s (the sync/animation-update cost, `syncDoorGraphics` — the function actually fixed).
The two zones were conflated while writing up the finding. The dirty-check fix itself is still sound
on its own logic (verified independently against source, not against the mis-cited number), but its
expected payoff was mis-sized — `geometry.doorDraw` was never the target and the fix cannot move it.

**A 4th live report** (16:33:52, ~25 minutes after the 3rd) surfaced a real bug: `instrument
.profilerAnomalies.unbalancedBrackets: 2`, with `residency.itemLoad`/`residency.pass` each showing
`unbalanced: 1`, and — separately — the two brand-new `residency.itemLoadDims`/`itemLoadMasks` zones
absent from the report entirely despite being committed before this capture. Root cause of the
bracket bug, found by reading rather than guessing: `ensureItemLoaded` has no try/catch of its own —
the caller's PHASE 1 loop does, specifically for item 1d's documented "permanently-broken item"
scenario (a 404'd asset, a real recurring case this exact codebase already has a name for). The new
zones' bare `begin()`/`await`/`end()` meant a throwing `getSourceDimensions` or `loadExtraLayerPacks`
would skip straight past `profiler.end()`, leaking that bracket open — an unbalanced bracket this
instrumentation would have CAUSED, not measured. **Fixed** with try/finally around both, preserving
the throw for the existing caller unchanged. Whether this bug actually explains this specific report's
`unbalancedBrackets: 2` is unconfirmed — the new zones' total absence from the report is at least as
consistent with the report simply predating the commit that added them (build/reload timing is
ambiguous — the commit landed only ~2-3 minutes before this report's `generatedAt`, well inside the
range a reload might or might not have happened in time for) as with the bracket leak itself. The fix
is correct either way and was made regardless of which explanation is true.

**The comparison itself is honestly mixed, not another improvement.** Several tail metrics moved the
WRONG direction versus the 3rd report: p99 frame time 33.5ms → 41.6ms, hitches 6 → 8, p1-low fps
29.9 → 24, worst frame 66.6ms → 83.3ms. `geometry.depthDraw` also went back up (5.198ms → 5.624ms),
which is exactly why that earlier drop was flagged as "favourable variance, not a fix" rather than
credited to anything — this report bears that caution out. Given the new `unbalancedBrackets` fault
lowers confidence in this specific run's precision, and given this project's own documented run-to-run
noise band, the most defensible read is that this is noise (possibly widened by the bracket fault),
not evidence that anything committed between the two reports made performance worse — but it should
not be filed as "still improving" either. `residency.itemLoad` (11.784ms mean) and the GPU-pool
overflow (`maxPendingSize: 2019`, `maxResolveSkipStreak: 4`) both landed close to their 3rd-report
values, consistent with both being stable, reproducible costs rather than noise-of-the-day.
