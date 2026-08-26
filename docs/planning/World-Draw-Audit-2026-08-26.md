# `geometry.worldDraw` — end-to-end audit, 2026-08-26

Requested directly: *"dive into the 'base map art' rendering, audit it from end to end... note
anything and everything that MIGHT be costing us performance... no need to fix anything yet."*
This is a catalog, not a priority list — confidence is marked per item, nothing here is fixed.

**Scope**: `geometry.worldDraw` — 24.9ms, 80.3% of frame GPU, reproduced identically across every
capture this map has produced, from 17 draw calls / 546 triangles. Traced the full call path:
`runGeometryWorldPass` (`vt-pan-viewer.js:5264`) → `buildWholeImageMaterial` (`vt-pan-viewer.js:9164`)
→ `buildRealFloorAttrMrtNode`/`packFloorAttr` (`vt/scene-attr.js:929`) → `buildAlbedoClarityNode`
(`vt/albedo-clarity.js`, already fully read and measured last round).

## Already ruled out with real measurements (not part of this catalog's suspicion list)

Vegetation tessellation (0 triangles this content), tile-cropping/coverage-mesh yield (96.7%
already culled), Foundry's own hidden second renderer (confirmed off, live), CAS sharpening's 5
extra texture taps (measured 0.051ms delta against a 0.19ms noise floor — statistically zero).
None of these explain the 80%. See `Performance-Priorities-2026-08-26.md` for the receipts.

## What the pass actually does, per frame

`runGeometryWorldPass` is not one render call — with `earlyZComposition` on (default, confirmed a
real modest win last round), it's three real scene traversals, in this order:

1. **`runSceneDepthPass()`** — a full depth-only render of `depthScene` into `buf:scene.depth`
   (the depth-authority buffer every other effect's occlusion trusts). Measured cheap: 0.15–0.18ms.
2. **The Stage-1 early-Z prepass** — `depthPrepassScene` rendered into `sceneColor` with
   `buildSceneDepthWriterMaterial` (colour-write off, depth-only), seeding `sceneColor`'s own depth
   attachment so the main draw right after can reject fragments early. Measured cheap: 0.05–0.09ms.
3. **The main colour draw** — `scene` rendered into `sceneColor` with the FULL
   `buildWholeImageMaterial`. This is where all 24.9ms lives. Everything below is about this one
   render call specifically.

**Confidence: HIGH that the 3-traversal structure itself is not the story** — two of the three
passes are directly measured and cheap (~0.2–0.3ms combined). The redundancy is real (SL-16 in the
Reckoning campaign's own prime-suspect list named exactly this shape) but it isn't expensive here,
because those two extra passes use a depth-only shader, not the full one.

## Per-fragment cost inventory of the main colour draw

Every fragment that survives the depth-authority discard runs through this, traced end to end,
file:line cited:

| # | Operation | Where | Cost class |
|---|---|---|---|
| 1 | `querySceneDepth` — depth-authority sample + compare, decides discard | `vt-pan-viewer.js:9289` (`material.maskNode`) | 1 texture sample, runs BEFORE colorNode (three's own `setupDiffuseColor` ordering) |
| 2 | `physicalSolidityAlpha` — fixed-LOD-0 sample of the item's own art | `vt-pan-viewer.js:9271` | 1 texture sample, ALWAYS runs (not gated by the CAS tier) |
| 3 | Albedo clarity (CAS) — centre + 4 neighbour taps, CAS contrast math | `vt/albedo-clarity.js:298` | 5 texture samples — MEASURED negligible (0.05ms) |
| 4 | `occlusionAlphaFactor` — screen-space occlusion-mask sample + blend | `vt-pan-viewer.js:9152` | 1 texture sample, a DIFFERENT texture (`occlusionMask`), full-screen-sized |
| 5 | `buildWorldSpaceOutdoorsGate` — world-position sample of the outdoors mask | `environmental-light.js:796`, called for the `attr` MRT's G channel | 1 texture sample, a THIRD distinct texture |
| 6 | Tint/alpha multiply, alpha-test binarize for `attr`'s A channel | `vt-pan-viewer.js:9319-9321`, `scene-attr.js:251-254` | cheap ALU, no new samples |

**Real per-fragment texture-sample total: ~9, across 4 distinct textures** (the item's own art,
`buf:scene.depth`, the occlusion mask, the outdoors mask) — not the "6" figure
`Performance-Audit-2026-08` round 5 named, which only counted what's inside
`buildWholeImageMaterial`'s own colorNode + solidity read, missing the maskNode, occlusion, and
outdoors samples that also run on every fragment. **Confidence: MEDIUM-HIGH this matters, but
UNVERIFIED individually** — CAS's own 5 were just proven cheap; the other 4 have never been isolated
the same way. If they behave the same way (likely — same GPU, same cache-friendly access pattern),
this whole line of investigation is a dead end and the answer is elsewhere. Nobody has checked yet.

## Structural / architectural factors (not tap-counting)

1. **This is a blended pass, not an opaque one.** `material.transparent = true`,
   `depthTest = false`, `depthWrite = false` (`vt-pan-viewer.js:9274-9276`) — every fragment is a
   real alpha-blended read-modify-write against the destination, not a cheap overwrite. Necessary
   (soft edges, authored holes need blending) but a genuine cost class an opaque pass wouldn't pay.
   **Confidence: HIGH this is real, MEDIUM this is a big fraction of 24.9ms** — blending cost scales
   with pixels touched, so this compounds with the fill-rate question below, not a story on its own.

2. **Every real-writer fragment writes to TWO render targets simultaneously.** `sceneColor`'s own
   MRT descriptor (`vt/scene-attr.js:150-173`): attachment 0 (`output`, the visible colour) is
   HalfFloat RGBA (8 bytes/pixel), attachment 1 (`attr`, the floor-attribute buffer) is UnsignedByte
   RGBA (4 bytes/pixel) — 12 bytes/pixel written per surviving fragment instead of 8. The project's
   own prior calibration (`keyhole-performance-audit-2026-08`) found overall render-target bandwidth
   has ~16× headroom across the WHOLE frame — that calibration doesn't specifically rule out this
   ONE pass's own write pattern being a meaningful slice of its own 24.9ms. **Confidence: MEDIUM.**

3. **Discarded fragments still cost real GPU time before being thrown away.** The depth-authority
   discard (`maskNode`) happens per-fragment, on the GPU, after vertex processing and rasterization
   — a fragment that gets discarded still paid for setup, rasterizer work, and the maskNode's own
   texture-sample-and-compare. On a pass covering a large fraction of the frame, "fragments we
   correctly threw away" is not free just because nothing visible resulted. **Confidence: MEDIUM** —
   real mechanism, unknown magnitude (depends entirely on how much geometry overlaps per pixel,
   which is the fill-rate question below, unmeasured).

4. **`DoubleSide` rendering, unconditionally.** `material.side = THREE.DoubleSide`
   (`vt-pan-viewer.js:9277`) — a workaround for items placed with a negative X-scale (mirrored art),
   which flips triangle winding; rather than fix winding per-item, the whole material disables
   back-face culling. For a flat quad this shouldn't itself double fragment count (there's no
   "inside" to a flat plane from one camera), but it is a real, blanket removal of a standard GPU
   cost-saving path, worth naming for completeness. **Confidence: LOW this matters much** — named
   because it's unconditional and easy to check, not because anything points at it specifically.

5. **Screen coverage / overdraw is the biggest unmeasured factor, and the most likely real story.**
   546 triangles, 17 draws, background map art at real-world map dimensions (native mask images on
   this content measured 10650×4950px) against a 3840×1906 (7.32-megapixel) viewport. Low
   triangle/draw count + large real-world content strongly suggests each draw covers a LARGE
   fraction of the visible frame — the textbook "low draw-call count + huge per-draw cost" signature
   this project's own history already named for the Mansion's 12K-map case (worldDraw at 133ms
   there, before coverage meshing). Coverage meshing already cuts 96.7% of EMPTY cells here, but
   says nothing about how many overlapping LAYERS of real content still stack per pixel where art
   actually exists (tile + level-foreground + level-background, potentially all painting the same
   screen area). The confirmed early-Z win (~0.4–0.55ms) proves the depth-authority reject IS
   catching SOME redundant work — it doesn't say whether that's catching most of a small residual or
   a small fraction of a large one. **Confidence: HIGH this is where the real answer lives. Not
   measured directly — `geometry.worldDraw` cannot currently be sub-zoned without a new,
   architecturally risky `renderer.render()` call (a documented, standing limitation, not new).**

6. **The prepass "twin" material is a separate compiled shader from the main draw's, per item.**
   `addDepthPrepassTwin` (`vt-pan-viewer.js:13096`) builds a depth-only twin via
   `buildSceneDepthWriterMaterial`, pooled by signature (`depthProxyMaterialPool`) specifically to
   avoid the pipeline-recompilation cost this exact mechanism caused before it was pooled
   (2026-08-11 incident, since fixed, ~83% hit rate confirmed live on a different map). **Confidence:
   LOW this is currently a problem** — already fixed once, already measured healthy elsewhere;
   named for completeness of the "two materials for one item" picture, not as a live suspect.

## What this audit did NOT check (honest gaps, not silent ones)

- **Actual overdraw factor** — how many layers really stack per pixel where content exists. No
  instrument for this exists yet on this pass specifically (see point 5 above).
- **The 4 non-CAS texture samples' individual cost** — maskNode, occlusion, outdoors, solidity were
  never isolated the way CAS just was. Would need the same kind of forced-shader-variant A/B
  `perf-sharpening-ab.js` already proved out, extended to each of these independently.
- **The actual texture format/resolution of this map's own art** (compressed vs raw, native
  dimensions of the specific tile/level images in play) — general BC1/BC7 compression exists in the
  pipeline project-wide; this map's own specific textures were not individually checked here.
- **Whether `occlusionMask`/outdoors-mask sampling could be skipped for items where they're
  structurally inert** (e.g., an item known to be always-indoors, or occlusion disabled) — not
  checked whether any of these 4 extra samples has an existing cheap-path gate the way CAS does.

## Bottom line

Two of three scene traversals are directly measured and cheap. The main colour draw's per-fragment
work is real (alpha blending, a 2-target MRT write, ~9 texture samples across 4 textures, an
unconditional discard-after-rasterize cost) but every INDIVIDUALLY-tested piece of it so far (CAS's
5 taps) has come back cheap — which points AWAY from "too much math per pixel" and TOWARD "too many
pixels getting touched, by more than one layer" as the more likely explanation. That's a fill-rate/
overdraw question, unmeasured, and the next thing worth instrumenting rather than guessing at.
