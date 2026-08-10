# Moonshot — Evidence File

**Purpose, stated once so it doesn't need repeating in every section:** this document gathers
facts, not proposals. No solutions, no recommendations, no "should" statements below. The goal
is a single, accurate ground-truth reference for (1) how the MSA rendering engine actually
works today, (2) exactly what the Mythica Machina Mansion map demands of it, and (3) what the
target hardware can actually do — so that whenever solutions DO get designed, they're designed
against real numbers instead of assumptions. Every number below is either measured directly
(a live perf report, a real file decode) or computed from a stated, checkable formula — never
a guess presented as a fact. Where something is uncertain, it says so.

**Status:** complete first pass, assembled 2026-08-09. Every section below is sourced either to
a live measurement taken this session, a real file decode, or a direct source-code citation
(file, and line numbers where the citing pass recorded them). Two small items are explicitly
flagged in place as needing one more confirmation rather than being asserted outright — search
for "needing that confirmation" and "not yet directly confirmed" below.

---

## 1. The target hardware

**Laptop NVIDIA GeForce RTX 3070**, per manufacturer specs (LaptopMedia, GPUZoo, cross-checked
against the desktop part for contrast):

| Spec | Value |
| --- | --- |
| VRAM | 8 GB GDDR6 |
| Memory bus | 256-bit |
| Memory bandwidth | 384 GB/s |
| CUDA cores | 5,120 |
| Architecture | Ampere (GA104), 8nm |
| TDP variants | 80W–130W depending on laptop OEM config |
| Boost clock (130W variant) | ~1620 MHz |
| Boost clock (100W variant) | ~1290 MHz |
| Computed FP32 throughput (130W, CUDA cores × clock × 2) | ≈ 16.6 TFLOPS |
| Computed FP32 throughput (100W) | ≈ 13.2 TFLOPS |
| For reference: desktop RTX 3070 | 19.9 TFLOPS (fixed 220W desktop card, not what's being targeted) |

**CPU and system, provided by the author 2026-08-10: AMD Ryzen 7 5800H (8 cores / 16
threads, Zen 3), 16 GB system RAM.** Several of the measured costs in §5 are CPU-side
(residency loading, point-light pool bookkeeping, the as-yet-unexplained depth-pass CPU
cost) — now attributable to real silicon. The 16 GB RAM figure is itself load-bearing:
Chrome + Foundry + 12,000px-map decoding inside 16 GB makes system memory pressure a live
suspect for §5's hitch/tail-latency class, not an incidental spec.

**Tested display context, from the live reports themselves (measured, not assumed):**
captures this session ran at a 3840×1906 (or 3463×1906) canvas resolution with a 1.5×
`pixelRatio` — i.e. a physical/CSS window in the neighbourhood of 2560×1270 with 1.5× DPI
scaling applied, consistent with a high-DPI laptop panel — and confirmed by the author
2026-08-10: the physical display is **3840×2160 @ 120 Hz** (4K minus browser chrome at 1.5×
DPR reproduces the captured canvas sizes).

**The one number that matters most for a 12,000×12,000px-per-layer map: 8 GB of VRAM, hard
ceiling, no exceptions.** Laptop GPUs in this class do not come in higher-VRAM configurations
the way some desktop cards do — this is the real, final number for this specific machine, not
a placeholder. Unlike compute throughput, which laptop OEM power limits can vary by ~25%
(100W vs 130W), VRAM capacity does not vary by OEM — every RTX 3070 Laptop is 8GB.

Sources: [LaptopMedia RTX 3070 Laptop (130W)](https://laptopmedia.com/video-card/nvidia-geforce-rtx-3070-laptop-130w/) ·
[LaptopMedia RTX 3070 Laptop (100W)](https://laptopmedia.com/video-card/nvidia-geforce-rtx-3070-laptop-100w/) ·
[GPUZoo RTX 3070 specs](https://www.gpuzoo.com/GPU-NVIDIA/GeForce_RTX_3070.html)

---

## 2. The map: Mythica Machina Mansion — complete real asset inventory

Located at `mansion_example_map/mythica-machina-mansion-redux/assets/` in this repo. **This is
described by the project author as the largest map that will ever be built for this engine** —
i.e., not a synthetic stress test, a real, planned ceiling case.

**16 files total, two floors ("Ground" and "First-Floor"), 27,459,584 bytes (26.19 MiB) on disk
as WebP.** Every number below was measured by actually decoding each file and scanning its
real pixel data — not inferred from filename or file size (`getImageData` over a
1024px-long-edge downsample of the real decoded bitmap; painted/opaque percentages are of
total pixel count, alpha threshold 4/250 respectively).

| Layer | Dimensions | On-disk (WebP) | Alpha min–max | Painted % | Fully-opaque % | Likely BC format |
| --- | --- | --- | --- | --- | --- | --- |
| Ground | 12000×12000 | 10.70 MB | 255–255 | 100% | 100% | BC1 |
| Ground_Overhead | 12000×12000 | 1.18 MB | 0–255 | 1.1% | 0.9% | BC7 |
| Ground_Roof | 12000×12000 | 0.77 MB | 0–255 | 3.7% | 3.7% | BC7 |
| Ground_Tree | 12000×12000 | 1.67 MB | 0–255 | 11.9% | 11.6% | BC7 |
| Ground_Bush | 12000×12000 | 2.40 MB | 0–255 | 7.2% | 6.6% | BC7 |
| Ground-left-hatch | 450×450 | 0.02 MB | 255–255 | 100% | 100% | BC1 |
| Ground-right-hatch | 450×450 | 0.05 MB | 255–255 | 100% | 100% | BC1 |
| Ground-top-right-hatch | 1050×1050 | 0.14 MB | 255–255 | 100% | 100% | BC1 |
| Ground_Specular *(mask)* | 12000×12000 | 0.44 MB | 255–255 | 100% | 100% | n/a — see note |
| Ground_Windows *(mask)* | 12000×12000 | 0.31 MB | 255–255 | 100% | 100% | n/a — see note |
| Ground_Fire *(mask)* | 12000×12000 | 0.26 MB | 255–255 | 100% | 100% | n/a — see note |
| First-Floor | 12000×12000 | 6.90 MB | 0–255 | 33.3% | 33.1% | BC7 |
| First-Floor_Overhead | 12000×12000 | 0.87 MB | 0–255 | 1.0% | 0.9% | BC7 |
| First-Floor_Specular *(mask)* | 12000×12000 | 0.79 MB | 0–255 | 33.3% | 33.2% | n/a — see note |
| First-Floor_Windows *(mask)* | 12000×12000 | 0.49 MB | 0–255 | 33.3% | 33.2% | n/a — see note |
| First-Floor_Fire *(mask)* | 12000×12000 | 0.43 MB | 0–255 | 33.3% | 33.2% | n/a — see note |

**Note on `_Specular`/`_Windows`/`_Fire`/`_Tree`/`_Bush` — corrected after checking source, not
assumed from the alpha data alone.** `vt-pan-viewer.js`'s own doc comment (lines 750–758) names
the exact mechanism: these five suffixes are all "extra layer packs" — *"every painted mask
(`_Outdoors`, `_Fire`, `_Specular`, `_Tree`, `_Bush`…) … becomes its OWN virtual texture (own
PageTable → own namespaced page keys → own indirection texture), streamed through the SAME
fixed atlas + page cache"* used for coarse, paged mask data — **not** the full-resolution
whole-image BC1/BC7 pipeline the base albedo layers go through. `_Tree`/`_Bush` additionally
get a SEPARATE synthetic drawn overlay item built from that same mask data (Case-2 vegetation,
per this project's own design docs) — a dual role `_Specular`/`_Windows`/`_Fire` do not have,
since those only ever modulate an existing draw, never get their own geometry. `_Overhead`/
`_Roof` are NOT named in that comment's mask list and are believed to be independent Foundry
documents (Level foreground/background) going through the normal full-resolution pipeline like
the base layers — this is inferred from their absence from the mask list, not yet directly
confirmed against the scene-layers source, and is called out as needing that confirmation.

**Revised drawn-whole-image-at-full-resolution set, pending that one confirmation: 7 layers** —
Ground, First-Floor (bases), Ground_Overhead, First-Floor_Overhead, Ground_Roof, plus the 3
hatch tiles. `Ground_Tree`/`Ground_Bush` are excluded from this set (coarse paged masks, not
full-resolution BC-compressed textures) despite being visually "drawn" via their own overlay
mesh — that mesh samples the SAME coarse mask data, not a separate full-resolution texture.

**A striking, load-bearing fact for anything involving culling or fill-rate:** `Ground_Overhead`
paints only 1.1% of its own 144-megapixel canvas. `Ground_Roof` paints 3.7%. `First-Floor_Overhead`
paints 1.0%. These three files are each a full 12,000×12,000 canvas for a sliver of actual art.
`Ground_Tree`/`Ground_Bush` paint 11.6%/6.6% but — as previously measured this session — their
painted pixels are scattered across the ENTIRE canvas (a bounding-box crop would recover nothing),
unlike Overhead/Roof, whose paint is genuinely localized.

### Tile splitting — confirmed from source, not estimated

`src/vt/texture-limits.js#planImageTiles`'s own doc comment states the exact behavior: *"at
16384 a 12000² floor is ONE whole tile; on hardware capped at 8192 it becomes an even 2×2 of
~6000² tiles."* This engine caps whole-image tiles at **8,192px** (`MAX_WHOLE_TILE_DIM`,
`src/vt/vt-pan-viewer.js`) **regardless of what the GPU itself supports** — stated reason in
that constant's own comment: *"a single 12000² upload TDR'd the device on a floor switch"*
(a real, previously-observed device-loss incident, not a theoretical concern). Modern Ampere
GPUs including the RTX 3070 support `maxTextureDimension2D: 16384`, so this 8192 cap is a
deliberate engine-level choice, not a hardware ceiling being hit.

**Concrete result:** every one of the 12,000×12,000 layers in this map splits into a **2×2 grid
of four ~6,000×6,000px tiles** (`cols=ceil(12000/8192)=2`, `tileW=ceil(12000/2)=6000`). The
three small hatch tiles (≤1050px) do not split (`whole: true`, 1×1).

---

## 3. Storage and VRAM footprint

**Two different numbers matter and should not be confused: on-disk size (what the author
authors and stores) and GPU-resident size (what the engine must fit in 8 GB of VRAM while
rendering).** They differ by roughly 1–2 orders of magnitude in both directions from the raw
decoded size, for different reasons (WebP compresses aggressively for storage; BC formats
compress much less aggressively but are GPU-samplable directly, which WebP is not).

### Computed, from a stated formula (not measured)

Per drawn layer at full 12,000×12,000 resolution, with a complete mip chain (standard mip
pyramid data-volume factor ≈ 4/3 of the base level):

- Raw RGBA8, base level only: 12,000 × 12,000 × 4 bytes = 576,000,000 bytes ≈ **549.3 MiB**.
- Raw RGBA8, full mip chain: ≈ **732.4 MiB**.
- BC1 (8:1 vs. raw RGBA8, used for the fully-opaque `Ground` layer): ≈ **91.6 MiB**.
- BC7 (4:1 vs. raw RGBA8, used for every layer with any real transparency): ≈ **183.1 MiB**.

Summing the revised 7-layer full-resolution set (1 BC1 `Ground` + 4 BC7 layers — `First-Floor`,
`Ground_Overhead`, `First-Floor_Overhead`, `Ground_Roof` — + 3 negligible hatch tiles):
91.6 + (4 × 183.1) + ~5 ≈ **829 MiB** theoretical GPU-resident size for both floors' full-
resolution art, fully mip-chained, fully resident simultaneously.

**This is a close match to the measured number below (825 MB) — worth noting as the theoretical
model holding up reasonably well once `_Tree`/`_Bush`/the mask files are correctly excluded**,
not a coincidence to be suspicious of. The two numbers are close enough (829 vs. 825, ~0.5%
apart) that the remaining gap is well within the slop of the idealized 4/3 mip-factor and 4:1/
8:1 compression-ratio assumptions — no further reconciliation needed on this axis. This is also
indirect supporting evidence that the `_Overhead`/`_Roof` full-resolution-pipeline assumption
above is likely correct, though still worth confirming directly against source.

### Measured, from real live perf reports (this session, same map, same floor)

From the `vram` block of an actual captured report (2026-08-09, upper floor):

| Item | Value |
| --- | --- |
| `vtEstimateMb` (real texture atlas, BC-aware, from the viewer's own accounting) | **825 MB** |
| Named render targets (screen-sized buffers: colour, illum, lit, coloration, depth, occlusion, bloom/DoF mip chains, sun-shadow slots) | **390.54 MB**, 25 targets |
| **Estimated total** | **1,215.54 MB** |
| Ceiling (measured device-loss wall) | **2,500 MB** |
| Headroom fraction | **0.514** (51% free against the ceiling) |

**On the 2,500 MB ceiling specifically — this is not an arbitrary safety margin, it is a
previously crash-tested number, on this exact card.** This map has a documented history of
actually triggering WebGPU device loss at full resolution before a fix landed
(`keyhole-device-loss-large-map`, resolved 2026-07-18): *"The real ceiling was ~2.5 GB
Chrome-WebGPU TDR"* — Chrome's Timeout Detection and Recovery mechanism, not a Foundry or MSA
limit. **The reference machine for that original crash was already confirmed to be an RTX
3070** — the same card family named in §1 of this document. BC1/BC7 texture compression was
adopted specifically because it brought the real VRAM bill to roughly 4× under this 2.5 GB
wall; that fix is why a 12,000×12,000-per-layer map is renderable on this hardware at all,
not an incidental detail.

**One already-learned lesson, directly relevant to reasoning about "what can this hardware
do," worth stating explicitly so it is not re-learned the hard way a second time:** during
that same investigation, a WebGPU-reported `maxBufferSize: 268,435,456` (256 MB) was initially
read as evidence of "modest GPU" — it is not. That number is **Chrome's own default WebGPU
buffer-size limit, exposed identically regardless of the underlying hardware.** The
card underneath it was, again, an RTX 3070. Any reasoning in this document (or built on it
later) about hardware capacity should be checked against real, sourced hardware specs (§1) —
not against whatever a browser API surfaces as a "default," which may reflect the browser, not
the silicon.

**A constraint already tried and already measured as harmful, kept here so it is not
re-attempted blind:** shrinking the 512 MB mask/page-cache atlas (§3, above) to save VRAM was
tried and made things WORSE, not better — it "halves the cache and worsens the thrash,"
measured at the time as 20,211 cache misses and 1,723 evictions. This is unrelated to the
7-layer whole-image atlas math above; it is specifically about the mask/page-cache pool's own
512 MB budget.

The individual render targets, largest first: `v3:scene.color` 111.68 MB (rgba16f, 2
attachments), `v3:scene.illum`/`v3:scene.lit`/`v3:scene.coloration` 55.84 MB each (rgba16f),
`v3:scene.depth` 27.92 MB (the depth authority — see architecture section), `v3:occlusion.mask`
27.92 MB, `v3:bloom.mip0`/`v3:dof.mip0` 13.96 MB each, 4 sun-shadow slots at 4 MB each, with a
descending mip chain below that. These are resolution-dependent (3840×1906 at the time of
capture) and effect-count-dependent, not map-dependent — they would be roughly the same on any
map at the same window size.

### A third pool the live reports do not currently total: the mask/page-cache

Confirmed directly from source (`vt-pan-viewer.js:1141-1142`, `decode-pool.js:655`):
`_Tree`/`_Bush`/`_Specular`/`_Windows`/`_Fire` (and any other "extra layer" mask) stream through
a **fixed, separate 512 MiB budget** (`budgetBytes: 512 * 1024 * 1024`), divided into
**256×256-texel pages** (`pageSizePx = 256`, the RGBA8 default). 512 MiB ÷ (256×256×4 bytes)
= exactly **2,048 pages** — which is precisely the `capacityPages: 2048` reported live every
capture this session, a full, load-bearing reconciliation, not an approximation.

Live occupancy at capture time: `residentPages: 231` of 2,048 (231 × 256 KiB ≈ **57.75 MB**
actually resident, ~11% of this pool's own budget) — nowhere near its own ceiling. **This
pool's real usage is not currently included in either `vtEstimateMb` or the render-target
total above** — the live report's own `vram` section does not appear to total it in
`estimatedTotalMb`. That is a real, confirmed gap in what the instrument currently reports,
noted here as a fact about the measurement, not a claim about whether it matters.

**The important comparison:** even at the highest measured total this session
(≈1,215.54 MB, one floor viewed), this map uses well under half of the RTX 3070 Laptop's 8,192 MB
of VRAM. VRAM capacity, on the numbers gathered so far, does not appear to be the binding
constraint — the engine's own internal ceiling (2,500 MB) is itself only 30% of the physical
hardware limit.

---

## 4. Engine render pipeline and subsystem architecture

### 4.1 The depth authority (`buf:scene.depth`) — the sole occlusion/rank system

Defined in `src/vt/scene-depth.js`. A real hardware depth attachment (`depth32float`,
samplable — not an ordinary non-readable depth buffer) paired with a colour attachment,
rendered by its own dedicated pass (`runSceneDepthPass`) using its own scene, camera, and
proxy meshes — never a material swap on production meshes.

**What gets written:** every visible item (Level backgrounds/foregrounds, tiles, tokens,
vegetation Case-2 overlays) gets a rank — a plain integer from `sortByLayer`'s own total order
(elevation → sortLayer → sort → zIndex → tiebreak), the SAME comparator Foundry's own layering
already uses, never a second scheme. Rank is encoded into the depth-writer proxy mesh's own Z
position (`rankToDepthZ`) so a real hardware depth TEST decides "what's on top" — order-
independent by construction, no blend, no accumulation. The colour channels of this same pass
pack per-item metadata: floor index, per-item flags (`restrictsLight`, `restrictsWeather`, tile
vs. Level-foreground/background), and a reserved "outdoors" channel (a named, undone gap, not
silently missing).

**Who reads it (`querySceneDepth` consumers, confirmed live/built this session and prior):**
point lights (elevation occlusion), vegetation (canopy rank), specular shine (background-rank
comparison), lightning (elevation gate), window light (background-rank comparison), and — as
of this session's own work — the main colour pass itself (`buildWholeImageMaterial`'s
`material.maskNode`, discarding a fragment before shading if something higher-ranked is already
recorded as opaque there). Candle's flame sprite is the one remaining consumer still on an
older, pre-depth-authority gate (a documented, deliberate scoping decision, not an oversight).

**The alpha-test discard inside the depth-writer's own material
(`buildSceneDepthWriterMaterial`) is itself a real, measured cost** (this session's own
finding): any `discard()` in a fragment shader disables hardware early-fragment-tests for the
WHOLE shader, regardless of how rarely the discard condition is true. As of this session, this
is mitigated (not eliminated) for items whose real decoded source alpha (`wi.alphaStats`,
scanned once at BC-compression time) proves every texel is above the item's own alpha
threshold — for those items the discard is omitted from the shader graph entirely.

**A correction to the "sole occlusion/rank system" framing, from a dedicated source pass —
largely true, but not literally exception-free.** Confirmed strongly true for effects built or
migrated onto it (point lights, lightning, specular, window light, and depth-of-field's floor
blur all resolve "what's above me" through this one rank table). But three source-confirmed
exceptions exist: (1) `masks.occlusion`'s own `occlusion.mask` render target is a **separate**,
older, MIN-blended token-radial-occlusion-disc buffer answering a different question
(Foundry-style token fade under overhead art) — untouched by the depth authority; (2)
`buf:scene.attr` (the older per-pixel floor/outdoors/flags buffer this system was meant to
retire) is still written every frame as a second MRT attachment on the main colour pass and is
still the live read source for outdoor-gating elsewhere (bloom's spill clamp, grade's context
gate) — the depth authority has only superseded attr's floor-identity role for the specific
consumers named above, not attr's existence; (3) vegetation's "Case-2" overlays (canopy art
hosted on a tile rather than its own standalone item) are a named, still-open gap — they do
not yet participate in the ranked list (`graph/passes.js:210-214`, an explicit unresolved note
in source, not an inference).

**A documentation-vs-source gap worth recording as its own fact:** `docs/planning/Depth-Buffer.md`
is headed "Status: DESIGN. Nothing built" and describes a three-layer (solid/light/weather)
scheme — the code that actually ships implements only the single "solid" layer. That design
doc is stale relative to the real, running system; anyone reading it fresh would get a wrong
picture of what exists today. Separately, `computeExpectedStoredDepth` — the closed-form
formula letting a light with no drawn geometry of its own query the depth buffer — is
documented in its own source as algebra-derived and cross-checked against vendored Three.js
source, but its own planned empirical GPU-verification step ("scenario 6") was never built.

### 4.2 Coverage meshing — stop rasterizing canvas, start rasterizing art

`src/vt/coverage-mesh.js`, landed this session. **The problem it solves, stated with this
exact map's own real numbers:** `Ground_Overhead` is a full 12,000×12,000 canvas (144
megapixels) with only 1.1% of it actually painted. Before this fix, every one of those 144
million texels was rasterized, every frame, in both the colour pass and the depth-authority
pass, regardless of how little of it was real art.

**The mechanism:** the quad every whole-image tile already draws as is tessellated into an
n×n cell grid (`COVERAGE_MESH_CELLS`, currently 64). A coarse alpha grid for the source image
(already computed elsewhere in the residency pipeline) is sampled once per cell; any cell with
at least one texel above a low alpha threshold (4/255) is kept, with one ring of dilation
around kept cells for filtering safety. The **index buffer** is then rebuilt to reference only
the kept cells — same vertex buffer, smaller triangle list. A cell mask that would keep every
cell (a fully-opaque source image, e.g. this map's own `Ground` layer) returns `null` from the
mask builder as a deliberate signal, and the caller falls back to the ordinary single-quad
(2-triangle) geometry instead of a fine grid — confirmed, this session, to already correctly
apply to this map's own `Ground` layer.

**A structural detail that matters for reasoning about future changes to this constant:** the
index-buffer culling reduces triangle/fill count but does NOT reduce the vertex buffer — every
vertex in the (n+1)² grid is still processed by the vertex shader for every draw regardless of
how many cells the index buffer actually references, since culling only removes INDICES, not
VERTICES.

**Measured, against this exact map's real assets (not a synthetic test):** at
`COVERAGE_MESH_CELLS=64`, the overall rasterized fraction across all measured layers
(Ground/First-Floor and their Overhead/Roof/Tree/Bush siblings) is 40.1% of naive full-canvas
rendering, down from 50.9% at the previous cell count of 32. Per-layer, the sparse layers see
the largest cuts: `Ground_Roof` 11.5%→6.9% kept, `Ground_Overhead` 43.8%→26.0% kept,
`First-Floor_Overhead` 31.9%→18.2% kept (all percentages of that layer's own 64×64=4,096 total
cells).

**A real ceiling on how much finer this specific mechanism can ever get:** the coarse alpha
grid this whole mechanism samples from is itself capped at 512px on its long edge
(`COARSE_ALPHA_MAX_DIM`, `src/vt/coarse-alpha.js`) — for a 12,000px source, that is one grid
texel per ~23.4 source pixels. At `COVERAGE_MESH_CELLS=64` on a 12,000px layer, one mesh cell
already covers ~187.5 source px (~8 grid texels) — i.e. still coarser than the grid's own
resolution. Refining the cell count further keeps helping up to roughly 512 cells (one cell
per grid texel); past that point, multiple mesh cells would sample the identical grid texel
and stop adding real precision, only more triangles.

### 4.3 The texture/asset pipeline for large map art, and residency/streaming

Covered substantially in §2–§3 above with this map's own real numbers. Two genuinely
independent systems coexist in source; only one handles base albedo art today.

**Whole-image mode (the live path for base level art since 2026-07-17)** — a source image
over 8,192px on either axis (`MAX_WHOLE_TILE_DIM`) is split into an even grid of sub-tiles via
`planImageTiles` (`src/vt/texture-limits.js`) — confirmed, every 12,000×12,000 layer in this
map becomes a 2×2 grid of ~6,000×6,000px tiles. Each tile is compressed to BC1 (fully opaque)
or BC7 (any real transparency) via a dedicated worker (`bc-compress.worker.js`), decoding in
512-row bands to bound peak memory, which also computes real decoded-source alpha statistics
(min/max/mean) during that same pass — the data this session's own `alwaysOpaque` depth-writer
optimization (§4.1) consumes. Mip levels below 0 are generated in-worker (a block-compressed
texture's mips cannot be GPU-auto-generated on this backend) via an explicit Lanczos-2
reduction in premultiplied-alpha space, never re-derived from the base level. Results are
cached in IndexedDB, keyed by URL and validated against a live ETag/Last-Modified/Content-
Length HEAD request — a stale cache entry cannot silently serve wrong art. **This system
explicitly, completely replaced an older page-streaming/virtual-texture engine for base art**
— per that removal's own commit-level comment (confirmed by the research pass): "removed
entirely, not merely defaulted off."

**The older page-cache/virtual-texture stack is still real, instantiated code — but its
only live call site today feeds it exclusively mask layers, never base albedo.** Confirmed:
`_Specular`/`_Windows`/`_Fire`/`_Tree`/`_Bush` (and any other "extra layer" mask, discovered by
sibling-file naming convention) stream through this fixed 512 MiB page-cache pool at
256×256-texel page granularity — exactly reconciling this session's own live-reported
`capacityPages: 2048`. A `coarseReservePages` budget (25% of total capacity, 512 pages) is
recomputed every residency refresh, further divided per-mask-pack.

**Two stale-documentation gaps worth recording precisely, since a document like this one
depends on knowing which comments still describe reality:** (1) the one remaining call site
for this page-cache system still carries a doc comment describing it as "one virtual texture =
one floor × one layer (**albedo**, or a mask...)" — apparently unedited since before the
whole-image pivot, and no longer accurate (albedo does not go through this path today); (2)
`page-cache.js`'s own header describes its 512 MB budget as "scaled per tier," but no
tier-detection logic exists anywhere near its actual construction call — the number is a flat
constant in practice, the "per tier" framing describes something that was never built.

### 4.4 The existing performance/quality tier system

`src/effects/effect-cascade.js` defines a real, already-shipped global quality-profile ladder:
`PERFORMANCE_PROFILES = ['low', 'performance', 'standard', 'quality', 'extreme']`
(`DEFAULT_PERFORMANCE_PROFILE = 'standard'`), backed by a real Foundry client setting
(`performanceProfile`, `src/effects/effect-settings.js`) that the author can already change.
Individual effects declare a manifest mapping profile → tier ("how much" of that effect runs);
`resolveEffectTier`/`resolveEffectEnabled` (`effect-cascade.js`) resolve a manifest against the
current profile. Confirmed tiered consumers today: vegetation (flutter/shadow quality/smear
density), specular (illumination model complexity), candle flame. Confirmed NOT yet
differentiated by tier despite having the hook available: bloom and depth-of-field (both
explicitly list "performance tiers" under their own `deferredRungs` — built as a single rung
for every profile including `extreme`).

**A load-bearing, already-established project convention, confirmed directly from an existing
manifest's own doc comment (`vegetation-render.js`):** the DEFAULT profile (`standard`) is
required to reproduce today's shipped visual behaviour exactly, not merely the top (`extreme`)
tier — stated as a deliberate rule ("turning this system on must not silently restyle every
existing scene"), not something inferred. `extreme` itself is not uniformly "the most
expensive, unlimited" tier across effects — for vegetation it resolves to a HIGHER rung than
the shipped default; for specular, bloom, and depth-of-field it currently resolves identically
to `standard` (no extra behaviour built yet).

### 4.5 The render pass pipeline — the mechanism, and the real per-frame sequence

**Two separate pass-graph mechanisms exist in source; only one is actually driving frames.**
`src/graph/frame-graph.js` is a complete, tested `FrameGraph` class (topological sort, real
dependency-edge tracking, feedback-loop detection, render-target pooling) — but per its own
barrel file's comment, it has **zero callers**: "real, tested, harvested V3 machinery... it
stays internal until something real calls it." It is not part of the live pipeline; skip it
when reasoning about what actually executes.

What actually runs is `src/graph/passes.js` — a plain **data array** declaring each pass's
stage, a `status` of `live`/`seam`/`future`, and which named resources it reads/creates/
modifies, validated only for naming hygiene (never a real runtime dependency solver).
`run-frame.js#planFrame()` filters this array down to the currently-`live` entries and
preserves array order (not a derived topological order); `runPassPlan()` simply calls each
one's registered function in that order, passing a **bare empty object** as context — every
actual render target is a plain closure variable inside the main viewer function, not
something mechanically threaded through the pass graph at runtime. The declared `reads`/
`creates` lists are documentation and a hygiene check, not an enforced contract.

**Two passes are declared `status:'seam'` (officially "not built as their own pass") whose
real functionality nonetheless runs every frame, folded into a different pass's own shader:**
sun-shadow visibility (folded into `light.accumulate`'s own ambient math) and colour grade
(folded into `present.composite`'s own material). Anyone reading `passes.js` alone would
conclude these don't exist yet; they do, just not as declared.

**The real, confirmed per-frame sequence:**

| Stage → pass | Writes to | What it actually does | Always-on? |
| --- | --- | --- | --- |
| `sims` (wind/fluid/particle/fire compute ticks — run directly, outside the pass-plan mechanism entirely) | wind ping-pong RTs, fluid tube RTs, particle/fire arena buffers | transient sim steps | wind/fluid: yes; particles/fire: only if that content exists on scene |
| `masks.occlusion` | `occlusion.mask` RT | token radial-occlusion discs, MIN-blended (Foundry-style fade under overhead art) | yes |
| `geometry.world` | (i) `buf:scene.depth` (own camera/scene, run FIRST as of this session's own fix); (ii) `buf:scene.color` (MRT: colour + attr) | (i) depth-authority rank buffer; (ii) the full sorted world draw list — level art, tiles, tokens, vegetation billboards, water's own tier-0 surface, door leaves | yes |
| `light.accumulate` | `scene.illum`, `scene.coloration` → composited into `scene.lit` | ambient/global-illum fill, per-floor sun-shadow sample, water-body/fluid sync, region darkness, point lights (MAX-blend), per-floor window light (ADD), coloration, the `scene.lit` composite itself, then guarded additive draws (candle flame / lightning / fire / wind-debug overlay) | yes — many of its own sub-draws are individually gated |
| `surface.response` | `scene.lit` | specular/shine: multiply (suppress diffuse) + add (highlight) | no — true early-return if disabled or no `_Specular` mask exists |
| `surface.particles` | `scene.lit` | additive instanced dust/gust draw | no — early-return if both are off |
| `post.bloom` | 6-mip bloom chain → `scene.lit` | dual-filter bloom pyramid, additive | no — early-return if disabled |
| `post.dof` | 4-mip DoF chain → `scene.lit` | floor-distance blur sourced from `buf:scene.depth` | no — early-return if disabled or the viewed floor is the ground floor |
| `present.composite` | the canvas itself | reads `scene.lit`, applies environmental + artistic grade, tone map, LUT (all folded into this one shader — the "seam" grade pass, above), presents | yes — a sun-shadow debug view can replace this entirely |

**Not separate passes at all, worth naming since it affects how their cost should be read:**
water's own tier-0 surface and door leaves are ordinary members of the same scene
`geometry.world` already draws (water at a fixed sub-integer render order for free
painter's-algorithm layering) — there is no separate "water pass" or "door pass" to point at.

### 4.6 Full effect/subsystem inventory

| Effect | What it is | Where it lives | GPU/CPU character |
| --- | --- | --- | --- |
| Point lights | Foundry light sources, region/darkness-aware dim/bright, elevation-occluded via the depth authority, wall-clipped fan-triangulated polygon meshes (real geometry, not full-screen quads) | `light.accumulate`, own dedicated light+coloration scenes | Both — CPU per-frame reconcile + one GPU draw call per light |
| Sun shadows | Per-floor baked occluder height field, sampled as an ambient-fill multiplier | Folded into `light.accumulate` (declared `seam`, not a real separate pass) | Both — GPU bake only on sun/mask/floor change; per-pixel sample is cheap every frame |
| Water | Painted mask + signed-distance shoreline (tier 0) | Ordinary scene member inside `geometry.world`, fixed render order | Both — GPU bake only on mask change; ordinary draw otherwise |
| Fluid | Tube-based decor with true semi-Lagrangian transport | `sims` stage tick (outside the pass-plan mechanism) | Both — GPU ping-pong texture advection |
| Vegetation (trees/bushes) | Billboards swaying from a shared wind-field sample; own depth-authority proxy | Absorbed into `geometry.world`'s unified draw list | Both — GPU vertex-displaced draws + CPU per-frame motion-uniform sync |
| Fire | Archetypal sprite-based flame/ember/smoke (particle-based, not volumetric — see this project's own fire-design history); also feeds point-light descriptors into the light pool | `sims` stage compute dispatch + guarded additive draw in `light.accumulate` | Both — real GPU compute for particle motion; deliberately small fixed capacities |
| Specular / shine | Animated shimmer over painted metal, up to six pattern layers, indoor/outdoor reflection model, per-island parallax | `surface.response`, own dedicated scene | GPU-heavy (own pass); CPU limited to per-frame sync |
| Window light | Mask read as a light cookie, gated per floor by the depth authority | Folded into `light.accumulate`, per-floor draws | Both — GPU draw per floor + CPU rank lookup |
| Bloom | Dual-filter pyramid (13-tap downsample, firefly clamp, tent-filter upsample), independently-weighted "core"/"atmosphere" bands | `post.bloom`, 6-mip chain | GPU-heavy when on; zero-cost early return when off |
| Depth of field | Per-pixel blur strength chosen from how many floors below the viewed floor a pixel's own depth-authority floor-index says it sits | `post.dof`, 4-mip chain | GPU-heavy when on; zero-cost early return when off or on the ground floor |
| Particles | One shared GPU-compute engine (storage-buffer arena, no per-particle JS objects) driving dust/gust/fire | `sims` stage compute + `surface.particles` instanced draw | GPU-heavy — genuine compute-shader simulation |
| Wind simulation | Baked ambient field (tier 1) + transient "door-draft" sim (tier 2) | `sims` stage, ticked directly every frame outside the pass-plan mechanism | Both |
| Colour grade | Full tone/colour correction + a separate environmental (time-of-day/weather) grade | Declared `post.grade` (`seam`) but actually folded into `present.composite`'s own shader | GPU-only, effectively free at identity — no separate pass or target exists |

Also present, outside this table's original scope but confirmed in the same pass: region-driven
darkness (an analytic per-fragment shape, inside `light.accumulate`), UI-window shadow
(screen-space, composed directly into the present shader), lightning (guarded additive draw +
its own light-pool source), candle flames (own render module, also feeds the light pool), and
an aperture-gobo debug visualization (baked into the point-light mesh's own falloff).

### 4.7 The performance-instrumentation system (confirmed structurally; §5 below carries the real numbers)

`src/diag/frame-profiler.js` is the per-zone CPU/GPU timer — zones nest, and the whole
instrument checks an armed flag before touching the clock or allocating, so it costs
near-nothing while disarmed. `src/diag/perf-report.js` is the pure report-building logic
(profiler output + effect manifests + an optional sweep → one report object), with explicit
rules against ever reporting a zero for "not measured" or averaging a sparse/bake-cadence cost
into a per-frame figure. `src/diag/perf-session.js` orchestrates one full measurement run
against an injected harness (this is the "one button" behind every report referenced in §5),
waiting for profiler-counted frames rather than raw display ticks, and refusing to run at all
while the separate whole-frame GPU probe is mid-measurement (since the render loop
intentionally skips frames during that window).

---

## 5. Measured performance history — every live report this session, same map, same floor

All captures below are the SAME 12,000×12,000 mansion map, upper floor (First-Floor,
`floorIndex: 1`), same benchmark route (`n_to_s:2kf/60000ms`, a north-to-south pan). Resolution
varies slightly between captures (noted where it does) — everything else is held constant.
Numbers are the profiler's own reported means, not eyeballed.

| Capture | Resolution | avgFps | frame.gpuMs p50 | `geometry.worldDraw` GPU | `geometry.depthDraw`/`depthRenderCall` GPU | Worst frame |
| --- | --- | --- | --- | --- | --- | --- |
| **Original baseline** (before any fixes this session) | 3840×1906 | 4.9 | 116 ms | 133.1 ms (22 draws) | 44.3 ms (9 draws) | 583 ms |
| Round 4 (after early depth-authority/maskNode fix) | 3840×1906 | 11.5 | 87.16 ms | 43.6 ms | 35.8 ms | 141.7 ms |
| Round 6 (after coverage meshing landed) | 3463×1906 *(smaller window)* | 24.5 | 29.49 ms | 13.1 ms | 2.18 ms | 141.6 ms |
| **Most recent** (round 7, after `COVERAGE_MESH_CELLS` retune + depth-pass sub-zone instrumentation) | 3840×1906 | 18.1 | 47.05 ms | 26.7 ms | 7.9 ms | **783.3 ms** |

**Cumulative change, most recent vs. original baseline, same resolution (the clean comparison):**
avgFps +269% (4.9→18.1), frame GPU time −59% (116→47.05ms), `geometry.worldDraw` −80%,
`geometry.depthDraw` −82%. **Worst single frame got WORSE, not better** (583ms → 783ms) — an
unresolved tail-latency regression sitting alongside the average-case improvement.

**What is and isn't known about that 783ms frame, precisely:** the profiler's own hitch log
records it with full decode/cache diagnostics attached — `sourcesDecoded: 0`,
`mainThreadFallbackSourceDecodes: 0`, `idbHits: 231`, `rangedFetchMisses: 0`. In plain terms:
nothing was being freshly decoded, fetched over the network, or falling back to a slow path at
that moment — every relevant asset was already cached. **This rules out "a decode/network
stall" as the cause of this specific spike**, but does not identify what the actual cause was.

**One more precise detail from the same report's own hang log, not previously noted:** the
783.3ms spike (frame 347, at 19.9s into the capture) was immediately preceded by frame 346
recording its own 200ms gap, one frame earlier (at 19.12s). Two consecutive frames were both
abnormally delayed — a combined ~983ms of stall across two frames, not one isolated spike in
an otherwise-smooth stretch. This is consistent with (but does not prove) a single underlying
event that spanned more than one frame, rather than two unrelated causes landing back to back.

### Full zone breakdown, most recent capture (18.1 avgFps)

Every zone with a measurable GPU or CPU cost, most expensive first. "GPU per-frame" is the
profiler's own `amortisedMsPerFrame` (the correct basis for "% of frame GPU," since a couple of
these zones — `present.blit`, most notably — genuinely run more than once per frame; the raw
per-occurrence mean would understate their true frame cost):

| Zone | GPU per-frame | CPU mean | Draw calls | Triangles | % of frame GPU |
| --- | --- | --- | --- | --- | --- |
| `geometry.worldDraw` (main colour pass) | 26.598 ms | 0.398 ms | 18.3 | 146,232 | 56.5% |
| `geometry.depthRenderCall` (depth-authority `render()` call, isolated) | 7.923 ms | 7.679 ms | 9.1 | 73,116 | 16.9% |
| `light.drawWindowLight` | 2.527 ms | 0.202 ms | 4 | 8 | 5.4% |
| `light.drawPointLights` | 2.148 ms | 1.273 ms | 55 | 1,486 | 4.6% |
| `light.drawColoration` | 1.732 ms | 0.791 ms | 55 | 1,486 | 3.7% |
| `present.blit` (runs 2×/frame — this is the true per-frame cost, not the 0.751ms per-occurrence mean) | 1.498 ms | 0.136 ms | 2 | 2 | 3.2% |
| `light.drawComposite` | 1.026 ms | 0.064 ms | 1 | 1 | 2.2% |
| `surface.specularDraw` | 1.019 ms | 0.101 ms | 2 | 4 | 2.2% |
| `bloom.composite` | 0.666 ms | 0.039 ms | 1 | 1 | 1.4% |
| `light.drawIllum` | 0.613 ms | 0.188 ms | 1 | 1 | 1.3% |
| `light.drawRegions` | 0.569 ms | 0.154 ms | 8 | 16 | 1.2% |
| `dof.composite` | 0.484 ms | 0.045 ms | 1 | 1 | 1.0% |
| Everything else combined (bloom mip chain, DoF downsample, doors, candle, aperture gobo) | ≈0.4 ms | — | — | — | <1% each |

CPU-side, off the GPU critical path but real: `residency.pass` (5.195ms amortised, 40.6ms peak
— a wall-clock, async, once-per-view-change cost, not per-frame), `light.pointLightUpdate`
(2.493ms/frame), `pointLightUpdate`'s own peak spikes to 11.7ms on some frames.

**Instrument health at this capture (from the profiler's own self-report, not inferred):**
0 unbalanced brackets, GPU timestamp-query pool did not overflow (`maxPendingSize: 224`,
stable), effect sweep measured 3 of 15 effects (12 rejected as below the sweep's own 1.3ms
noise floor), `renderer.info.memory.programs` measured **flat at 88 across the entire
measurement window** (sampled once after settling, once at the end) — no shader pipeline
recompilation occurred during steady-state panning, ruling that out as an explanation for any
CPU cost measured this round.

### An open, unexplained gap

`geometry.depthRenderCall`'s live CPU cost (7.679 ms for calling `renderer.render()` on a
9-draw, real-texture, real-geometry scene) has been tested against three separate isolated
reproductions on the same real WebGPU device — real 12,000px textures bound, the real
production material builder, a write-then-sample-elsewhere frame pattern matching how other
effects actually read the depth buffer later in the same frame. **All three isolated tests
measured under 0.11 ms per call — roughly 70× smaller than the live number.** Pipeline
recompilation has been directly ruled out (flat `programs` count, above). The specific cause
of this gap has not been identified as of this document's last update.

---

## 6. What has already been tried this session (factual record, not a recommendation list)

In commit order, each with its measured or structurally-verified effect:

1. **Depth-authority pass reordered before the colour pass + `material.maskNode` early
   rejection** (`8e2b05b`) — colour-pass fragments whose rank is already covered by something
   higher-ranked are discarded before shading. Measured effect: `geometry.worldDraw` GPU time
   dropped from 133.1ms toward 43.6ms over the following rounds.
2. **`buildSceneDepthWriterMaterial` gained `alwaysOpaque`** (`3e7e532`) — when an item's real
   decoded source alpha (`wi.alphaStats`, scanned once at BC-compression time) proves every
   texel is above its own alpha threshold, the depth-writer's alpha-test discard is omitted
   from the shader entirely (not just made unreachable at runtime), restoring hardware
   early-Z for that item.
3. **Coverage meshing** (`7e103c9`) — the biggest single win. Instead of a full-canvas quad for
   every layer, each whole-image tile is tessellated into an n×n cell grid and the index buffer
   is culled to only the cells that actually contain painted pixels (with one ring of dilation
   for filtering safety). Measured effect: `geometry.worldDraw` 43.6ms→13.1ms,
   `geometry.depthDraw` 35.8ms→2.18ms in the same round.
4. **`COVERAGE_MESH_CELLS` retuned 32→64** — measured against the real mansion assets before
   changing (not guessed): overall rasterized fraction across all layers dropped from 50.9% to
   40.1% of full canvas.
5. **Sub-zone instrumentation added** (`cb48534`) — the depth pass split into setup/render/restore
   CPU zones, plus a new pipeline-health sample (`renderer.info.memory.programs` before/after
   the measurement window). This added measurement only, no behavior change; it is what
   produced the "flat at 88" and "7.679ms is genuinely inside render()" facts above.
6. **Albedo clarity sharpening gated behind the existing performance-profile system**
   (`18bef7f`) — on the `performance`/`low` profile tiers only, the 5-tap CAS sharpening filter
   (5 of `buildWholeImageMaterial`'s 6 texture taps) is replaced with a 1-tap read. The
   `standard` (default), `quality`, and `extreme` tiers are byte-for-byte unchanged. **Not yet
   live-tested** — requires switching the performance-profile setting away from the default to
   observe any effect.

All of the above are `npm run verify` green; none have been confirmed against a live capture
in the specific "did this actually help" sense except items 1–4, which the round-by-round
report table in §5 already reflects.

---

## 7. Phase-0 measurements — real Mansion Redux import, Ground Floor (2026-08-10)

**⚠️ NOT directly comparable to §5's table.** §5's rows are all the SAME floor (First-Floor,
upper) on whatever scene content existed at the time. Everything below is **Ground Floor**
(`floorIndex: 0`), on the **real, complete Mansion Redux import** (987 walls, 50 lights, 6
tiles, 207 candle anchors, real painted fire mask) that landed in the bench world this same
session — the first time this exact real content has been profiled this way at all. Resolution
is also smaller (1920×1080, not 3840×1906). Treat this as a new baseline for THIS content, not
a continuation of §5's trend line. Captured via `MapShine.debug.actions.get('perf-run-full')`,
the real instrumented action (`n_to_s:2kf/60000ms` route, 132s wall-clock incl. settle),
Playwright + real Chrome + real nvidia/ampere WebGPU, `channel:'chrome'` headed (see
[[reference_live_foundry_harness]]). **Caveat on precision, per the author's own direction
2026-08-10:** the harness's absolute fps numbers are not yet proven pixel-for-pixel comparable
to a manually-loaded session (investigated; backgrounding-throttle and OS process priority
were directly ruled out live, but a `--no-sandbox` flag, a `--num-raster-threads=4` cap, and an
unexplained 20→7→32 fps swing across three same-scene 5s windows remain open — full detail:
Testament Petition P-003 / `feedback_playwright_fps_not_yet_trustworthy`). Read everything below
as **directionally real, not pixel-precise** — exactly the author's own instruction: rough
numbers are still useful for "did this improve," just not for a tight before/after percentage.

### Headline frame numbers

avgFps 48.6 · median 59.9 · p5-low 29.9 · p1-low 24 · best 122 · worst 17.1. Frame time: median
16.7ms, p95 33.4ms, p99 41.7ms, worst-in-window 58.4ms. Histogram: 59.9% of frames landed
30–60fps, 27% landed 60–120fps, only 0.3% dropped under 20fps. VRAM: 399.4MB estimated /
2,500MB ceiling, 84% headroom, verdict `ok`.

**Instrument note, honestly recorded:** `method.gpu` reported `"timestamp-query"` (GPU timing
WAS available this run), yet `attribution.verdict` still came back `"unmeasured"` and every
zone's `gpuMs` is `null` — only `cpuMs` populated this capture. Every cost below is therefore
**CPU-side only**; no GPU-ms figures exist for this run despite the instrument believing it had
GPU timing available. This is flagged, not explained — a gap worth closing before the next
capture is taken as a full picture.

### Pass census — answers Stage 0's first checklist item directly

MSA's own zone taxonomy tags render-pass boundaries explicitly (`isPass: true`), which answers
"beginRenderPass count/frame, confirm the world draw is ONE pass" without needing a separate
Dawn/`about:tracing` capture:

| Pass (in frame order by stage) | Draw calls | Triangles | CPU mean |
| --- | --- | --- | --- |
| `pass.masks.occlusion` | 0 | 0 | 0.096 ms |
| `pass.geometry.world` | 176 | 334,378 | 6.041 ms |
| `pass.light.accumulate` | 236 | 9,416 | **8.76 ms** (single costliest pass) |
| `pass.surface.response` | 2 | 4 | 0.153 ms |
| `pass.surface.particles` | 0 | 0 | 0.001 ms |
| `pass.post.bloom` | 11 | 11 | 0.675 ms |
| `pass.post.dof` | 0 | 0 | 0.003 ms |
| `pass.present.composite` | 2 | 2 | 0.167 ms |

**8 passes/frame, confirmed. The world draw IS one pass** (`pass.geometry.world`) — 176
individual draw calls (interior + boundary + doors + depth, combined) all inside a single
beginRenderPass/endRenderPass boundary, matching the architecture the Testament's Law assumes.
`pass.light.accumulate` is the single most expensive pass this capture, at 8.76ms CPU — close
to §5's own baseline "light stack 8.6" figure, a rough but real cross-check between the two
captures despite their different floors/content.

Supporting per-zone detail: `geometry.depthDraw` + `geometry.depthRenderCall` together ≈9.1ms
CPU on just 6 draw calls / 67,666 triangles each — directly relevant to Stage 0's "7.7ms CPU
mystery" item, though the specific migration experiment (dummy 1-triangle `render()` before the
depth pass) has NOT been run yet; this is supporting evidence, not that experiment's answer.

### Effect-cost findings — real, actionable, from the profiler's own self-check

The profiler compares each effect's MEASURED cost against its own declared budget tier and
flags overshoots. Three fired this capture:

| Effect | Measured | Declared max | Ratio |
| --- | --- | --- | --- |
| **doorGraphics** | 0.411 ms/Mpx | 0.01 ms/Mpx | **41.1× over** |
| **candleFlame** | 1.908 ms/Mpx | 0.3 ms/Mpx | **6.36× over** |
| **specular** | 0.169 ms/Mpx | 0.08 ms/Mpx | **2.11× over** |

`fire` measured WITHIN its declared budget (0.459 vs 0.7 ms/Mpx max, ratio 0.66) — a clean
result, consistent with the author's own "fire is coming along nicely" read. 10 of 15 effects
fell below the sweep's own 0.15ms noise floor and were correctly rejected rather than reported
as a false reading (7 of those are legitimately CPU-only effects with no GPU draw cost at all
— `uiWindowShadow`, `lightning`, `vegetation`, `water`, `fluid`, `window`, `apertureGobo` —
each under 0.2ms/frame CPU).

### Hitch autopsy — real data, correlated but not yet explained

20 hitches over the 50ms threshold this window; the worst seven were multi-second: 3341.8ms,
2941.8ms, 2183.4ms, 1925.1ms, 1650ms, 1025ms, 975.1ms. Every one carries full decode/cache
diagnostics: `sourcesDecoded: 0` and `mainThreadFallbackSourceDecodes: 0` throughout (nothing
was being freshly decoded), while `idbHits` and `residentPages` both climb steadily alongside
each hitch (119→125→140→182→203 across the sequence), `evictions: 0` and `misses: 0`
throughout (the cache never overflowed or genuinely missed — capacity 2,048 pages, peak
resident only 203). Separately, `residency.itemLoad`/`residency.pass` each ran 427 times,
peaking at 22.5ms/23.4ms respectively (amortised negligible, ~3.2ms/frame — but a real
one-frame stall each time it spikes). **Correlation is real and repeatable; the specific
mechanism turning a same-cache IndexedDB read into a multi-second stall is not yet identified**
— worth the same isolated-reproduction treatment §5's `geometry.depthRenderCall` gap already
got, before attributing a cause.

### CAS performance-tier live-test (§6 item 6) — first positive Stage-0 result

`performanceProfile` flipped live (`standard` → `performance`, no reload, restored to
`standard` afterward) and the identical `perf-run-full` capture re-run on the same scene/floor.
**Not a laboratory-controlled A/B** — two independent 60s sweeps, each with its own real-world
variance (window durations 38446.9ms vs 38690.2ms; frame counts 1868 vs 2193) — but the
direction is consistent across every independent signal, which is what makes it a real result
rather than noise:

| Metric | `standard` | `performance` | Change |
| --- | --- | --- | --- |
| avgFps | 48.6 | 56.7 | **+16.7%** |
| Worst frame in window | 58.4 ms | 50.1 ms | improved |
| `pass.geometry.world` CPU mean (the pass CAS's texture taps live inside) | 6.041 ms | 4.928 ms | **−18.4%** |
| Hitches (>50ms) | 20 | 9 | **less than half** |
| Stalls (hangs.totalStalls) | 3 | 2 | improved |
| `geometry.worldDraw` CPU mean (narrower zone) | 0.341 ms | 0.324 ms | ~5%, within noise |

Median fps and p5-low fps were unchanged (59.9 / 29.9 both runs) — the improvement shows up in
the CPU-bound tail (worst frame, hitch count), not the already-fast median, consistent with CAS
sharpening being a fixed per-pixel tap-count cost rather than something that changes the
frame's floor. **Verdict: real, positive, and mechanism-consistent** (the biggest single delta
landed exactly in the pass the 5-tap→1-tap swap touches) — not yet re-run enough times to rule
out run-to-run variance contributing part of the gap (see Testament Petition P-003 on this
harness's own fps repeatability), but multiple independent indicators agreeing is itself
evidence per the author's own "rough numbers still show whether something improved" guidance.

### `low` tier — same test, third data point

Same method, `performanceProfile` → `low`, restored to `standard` after. **One real confound,
checked directly rather than assumed:** comparing `effects[].enabled` across all three captures,
only `sunShadows` actually differs — `true` on `standard`/`performance`, `false` on `low`.
Every other effect (`candleFlame`, `fire`, `vegetation`, `water`, etc.) stayed enabled on `low`
despite declaring `fromProfile: 'performance'` in their manifests — this scene's authored
GM-level overrides evidently win over the profile default for those, and only `sunShadows`
lacked one. So the `low` numbers are "CAS 1-tap + sun shadows off," not "CAS 1-tap alone."

| Metric | `standard` | `performance` | `low` |
| --- | --- | --- | --- |
| avgFps | 48.6 | 56.7 | **57.6** |
| Worst frame | 58.4 ms | 50.1 ms | **75.1 ms** (worse than both) |
| Hitches (>50ms) | 20 | 9 | 8 |
| `pass.geometry.world` CPU | 6.041 ms | 4.928 ms | 4.879 ms (matches `performance` closely) |
| `pass.light.accumulate` CPU | 8.76 ms | 7.275 ms | 7.093 ms |

`pass.geometry.world`'s near-identical cost between `performance` and `low` (4.928 vs 4.879ms)
is a genuine confirming signal — the commit describes the SAME 1-tap CAS substitution on both
tiers, and the measurement agrees almost exactly, independent of `low`'s sun-shadows
difference. avgFps and hitch count both continue improving from `standard`→`performance`→`low`.
**But `low`'s single worst frame (75.1ms) is worse than either other tier** — a genuine, honest
surprise, not smoothed over. Whether that traces to `sunShadows` toggling off mid-route, to
this specific sweep's own run-to-run variance (per Petition P-003), or to something tier-
specific has not been investigated further.

### A discovered instrument bug: `perf-run-full` was silently capped to ~30fps

Found live, 2026-08-10, while reading a first blend-off A/B result that looked wrong (avgFps
25.7 with a dead-flat ~41.7ms frame time across an entire 56s window — a cap signature, not
organic variance). `perf-run-full`/`perf-report-all-tiers` drive their benchmark route by
calling `playCameraPath()` (`foundry/camera-path-player.js`) — the SAME function the author's
own "🎥 Camera Path" recording panel calls. A separate, earlier-landed feature (author-requested,
2026-08-10: "I record at 30fps... limit rendering to 30fps... while the camera path tool is
running") throttles `renderFrame` (`vt-pan-viewer.js`) to ~30fps whenever ANY camera-path
playback is active — with no distinction between "the author is recording a video" and "a perf
capture is using the same player to drive its route." Every `perf-run-full`/`perf-report-all-tiers`
capture taken since that recording-cap feature landed was therefore silently throttled, without
that ever being noticed until this session's blend-off A/B result made it visible.

**Fixed**, not just noted: `playCameraPath(pathData, {capFrameRate})` — default `true` (the
author's manual recording panel is byte-for-byte unaffected), and a new
`isCameraPathPlayingCapped()` (which the render loop's throttle actually reads, via
`getCameraPathPlaying`) is `false` for a `capFrameRate:false` playback while `isCameraPathPlaying()`
still correctly reports the playback active for every other purpose. Both perf actions now pass
`capFrameRate:false`. `npm run verify` green throughout.

**What this means for every fps/CPU-ms number already in this document above this line:** every
capture in this file predates this bug's introduction (checked: this recording-cap feature's own
verification artifact is timestamped 15:43, after every number recorded above) — so nothing
already written into `Moonshot.md` needs revision on account of it. It only affects captures taken
during this same later session, addressed directly below.

### Stage 0 — the four remaining measurement items, 2026-08-10 (Ground Floor, uncapped after the fix above)

**1. The CPU-mystery migration experiment — ANSWERED.** A debug-only dummy 1-triangle `render()`
(its own zone, `geometry.debugFirstRenderProbe`), armed via `MapShine.setDebugFirstRenderProbe(true)`,
inserted immediately before `runSceneDepthPass`'s own setup. Real `perf-run-full` capture, uncapped:
`masks.occlusionDraw` (genuinely the frame's first `renderer.render()` call in production) 0.066–0.086ms
mean across two runs; the new dummy probe (second call, immediately before the depth pass) 0.075–0.09ms
mean; `geometry.depthRenderCall` (the real depth-pass call, third) 3.375–6.133ms mean — 45–68× either.
**The cost stays with the depth pass specifically, not with "first render of the frame."** The deeper
"what about the depth pass" remains open (the isolated-shader-lab-bench gap noted in §5 stands) — this
experiment only distinguishes the two hypotheses the Testament's own item poses, which it does cleanly
and repeatably across two independent captures (one still under the fps-cap bug, one after the fix —
same conclusion both times).

**2. A/B: blending force-off on fully-opaque layers — INCONCLUSIVE, not a confirmed win or loss.**
`MapShine.setDebugForceOpaqueBlendOff(true)` mutates already-built colour-pass materials live
(`t.material.transparent = false` + `needsUpdate = true`), gated on the same `alwaysOpaque` signal
`buildSceneDepthWriterMaterial` already trusts — expected to be visually lossless (blending is a
mathematical no-op at alpha≡1) and confirmed as such (before/after screenshots show no visible
difference). Measured, uncapped: avgFps 37.9 vs. this same session's own `standard`-tier baseline
48.6 (§7 above); `pass.geometry.world` CPU mean 8.385ms vs. 6.041ms — WORSE on both counts, the
opposite of the hypothesis. **Not trusted as a real regression from the flag** — see finding 3.

**3. A/B: maskNode discard force-off — the SAME numbers as finding 2, which is itself the finding.**
`MapShine.setDebugForceMaskNodeOff(true)`, armed before a reload (the discard is baked into the
compiled shader graph at material-build time, so a live toggle alone does nothing). Wrong pixels
expected (a fragment a real occluder should have discarded can now show through); no obviously wrong
pixels visible in the after-screenshot at this zoom/route regardless. Measured, uncapped: avgFps 37.5,
`pass.geometry.world` CPU mean 8.43ms — within noise of finding 2's 37.9fps / 8.385ms, despite testing
two unrelated code paths (one skips a discard at shading time, the other skips a blend state with no
shared mechanism). **Two independent, unrelated flags producing near-identical "regressions" is itself
evidence the regression belongs to neither flag** — most plausibly a shared confound this session
(sustained real load from other applications running on the same machine throughout; thermal
throttling was already an open, untested candidate per Petition P-003) rather than either A/B's own
answer. Neither A/B's own performance question (does blending/discard genuinely cost what Stage 1
predicts) was cleanly answered by this round — a clean re-run on an otherwise-idle machine is the
named prerequisite before trusting either number, not a code fix.

**4. RenderBundle probe on three 0.185.1 — VIABLE, real speedup, on a synthetic proxy workload.**
Not run through the Foundry harness (no scene-content dependency) — a standalone page
(`tools/shader-lab/renderbundle-probe.html`, served by the shader lab's existing static server, never
wired into its bench/scenario system) confirms `THREE.BundleGroup` (three r0.185.1's real, public
render-bundle API — a `Group` subclass the renderer detects via `.isBundleGroup`, driving the WebGPU
backend's real `GPURenderBundleEncoder` internally; no separate `renderer.renderBundle()` call exists)
cuts CPU-side `renderer.render()` encode cost for 300 static textured quads by **1.80×–2.60×** across
two runs (real WebGPU confirmed live, not a fallback). Honest gap: the probe's material is a
representative synthetic stand-in (one texture tap + a tint uniform via `NodeMaterial`), not the literal
`buildWholeImageMaterial` — that function is a nested closure inside `startVtPanViewer`, not
extractable at module scope without a real refactor, out of scope for a prototype-level probe. The
result answers "is RenderBundle worth building toward" (yes, real CPU win, consistent direction both
runs) — not "exactly how much it saves on our real material set."

### What's still open from Stage 0's checklist after these captures

All eight Stage-0 checklist items now have real evidence recorded (five in this document, three more
as their own Testament evidence lines — record keeping split between "facts" here and "what was
executed" there, per each document's own stated purpose). The one item this round could not cleanly
answer is embedded in finding 3 above: the blending/maskNode A/B's own performance questions need a
re-run on an otherwise-idle machine before either is trusted as a real number, not a code change.
