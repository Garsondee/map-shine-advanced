# Fire — the vertical slab integral

**Status:** flame + smoke + light **BUILT (unverified)**. Lab-green on real WebGPU; not yet seen by the author on a real scene. Mask-driven sizing, embers, coal bed and room-filling smoke are **not built** — see §9.

**Author decisions, 2026-08-08:** mask-first authoring with anchors as a second source · separate from the candle but sharing its physics · phase 1 stops at flame + light + smoke crown.

---

## 1. Why this exists

V2's fire was the most-loved effect and the worst code. `FireEffectV2.js` is **6,861 lines** — the largest single file in the V2 tree — plus 2,825 lines of behaviours and a 667-line coal-bed shader. It reached into `window.MapShine.lightingEffect` while lighting reached back into fire's private `_glowBucketsByFloor`; it scanned masks with CPU `getImageData`, allocated four full copies of the point cloud per populate, monkey-patched `system.emitter.spawn` at runtime, and rotated physics across floors at 1/N rate to stay in budget. Its own comments admit it: `// FAST FAKE CURL: Replaces 4 expensive Simplex noise3D calls with layered trig.`

V3 had **no fire at all**. The `_Fire` mask kind sat in `scene/mask-catalog.js` with zero consumers, next to two already-painted fixture files.

---

## 2. The model, and why it does not violate the marching ban

Three rejections are on the books, and none of them binds this:

- `layer-smear.js:8` — *"a COMPOSITING problem, not a ray-marching one (author, 2026-08-02, after two marching models failed)."*
- `Clouds.md` R4 — volumetric 3D texture rejected as *"paying 3D for a 2.5D problem"*, whose stated objection is that **3D texture fetches cache poorly**.
- `candle-flame-render.js:71` — *"a 3D mesh buys zero here and costs more."*

The camera is a never-moving `OrthographicCamera` looking exactly down −Z (`vt-pan-viewer.js:6103`; `position`/`lookAt`/`up`/`rotation` are never assigned anywhere in the repo). **So every view ray is parallel to world up**, and integrating a fire's volume is a **1-D column integral at a fixed (x,y)** with every fragment marching the same heights in lockstep. No ray setup, no per-pixel ray direction, no empty-space skipping, no 3D texture — and because `mx_fractal_noise_float` is analytic, **zero bytes of memory read**, exactly like the Clouds R1 design that won.

The candle doctrine is **scale-dependent** and correct for a candle: 20 mm of flame whose plume shear is sub-pixel at any usable zoom. A campfire is 1.5 m of flame under 5 m of plume. Three things a footprint structurally cannot produce are the entire look:

| | Why a footprint can't |
|---|---|
| Self-occlusion — the rust seams between lobes | Needs ≥2 layers of *different* noise at *different* heights |
| Downwind shear — smoke streaming off one side | `uLean` steers one *point*; a footprint has no "as it rises" |
| An accumulated soft edge | A `smoothstep` edge is a fixed width; an accumulated one varies with how many slices overlap |

Note also that the candle's own `h = clamp(dot(p, tip) / dot(tip, tip))` is literally "project onto a spine to recover a height" — a one-slice slab integral with a hand-authored density. This generalises that file rather than contradicting it.

### 2.1 Sheets are not slices

A plume is not N independent noise fields; it is **one field, advected**. A parcel at height *h* was lower and upwind a moment ago:

```
D(x, y, h) ≈ D₀(xy − shear(h), φ − h/riseSpeed)
```

Stacking N *decorrelated* fields reads as boiling static — a look failure before a cost one. But it also means the field varies smoothly in *h*, so the number of **noise evaluations (M sheets)** can be far smaller than the number of **composite steps (N slices)**. Each slice still gets its own scalar geometry — shear, radius, softness, temperature, absorption — and scalars are uniform-flow and effectively free.

**N buys per-slice geometry. M buys field decorrelation. They cost ~40× differently.**

---

## 3. Measured cost

`tools/shader-lab/bench-fire.js`, reference machine (RTX 3070 Laptop). Two scenarios, both gated on a non-vacuity probe that proves the timer can resolve a cost difference before any ratio is believed.

**`noise-fold-ab`** — settles the question that gated the whole design:

| check | measured |
|---|---|
| `noise-affects-every-variant-equally` | **1.002** |
| `detector-is-not-vacuous` (6 oct ÷ 3 oct) | **2.000** — the theoretical prediction, within 0.2% |
| `vec2-and-explicit-const-z-are-the-same-shader` | **1.000** |
| **`live-third-coordinate-cost`** | **1.047× → THIRD_AXIS_IS_FREE** |

`mx_fractal_noise_float` has **no vec2 path** — `three.webgpu.js:53743` holds `p` as a `vec3` local, and `NodeBuilder.format` (`:57770`) silently pads a vec2 argument with `0.0`. So the ~40 existing `fbmFloat(vec2)` call sites in `src/` already compile to 3D noise. The open question was whether the compiler folds that constant `0.0` back to 4 lattice corners — if it did, every slice fire adds would cost double. **It does not.** A live third coordinate costs 4.7%.

**`octave-cost-curve`** — perfectly linear across octaves 1–6, fixed cost 0.0004 ms/Mpx ≈ zero:

| quantity | measured | the design had derived |
|---|---|---|
| one lattice hash | **0.00549 ms/Mpx** | 0.008 (31% pessimistic) |
| one 3D Perlin octave | **0.0439 ms/Mpx** | 0.06 |
| **a 3-octave 3D fBm** | **0.1323 ms/Mpx** | 0.19 |

Worley is 27 lattice hashes ≈ 0.148 ms/Mpx — more than an entire 3-octave fBm. **Do not use it for the cauliflower.** The billow fold `1 − |fbm|` generates lobed silhouettes from ordinary Perlin at zero extra cost; that *is* the generator.

⚠️ **The instrument found an error in itself first.** The original layout timed each variant in its own block, and the *same* variant measured twice in one run came back 25% apart — GPU clock ramp landing entirely on whichever variant went first. Round-robin sampling fixed it, and the guard that protects it (`noise-affects-every-variant-equally`) measures spread **disparity across variants**, not absolute jitter: jitter cancels in a ratio, uneven jitter does not.

---

## 4. The scale chain — one knob

One authored quantity, `diameterPx`. `mPerPx` derives from the scene's own grid, never a constant.

⚠️ **The pixel sizes are not intuitive.** At 100 px per 5 ft, **one pixel is 15 mm**, so a metre is 66 px. A real campfire is ~66 px; 520 px is a *seven-and-a-half-metre* fire. Two consequences: the range fire must serve is roughly **5–700 px**, and a real candle flame is 8 mm ≈ **half a pixel** — the physical reason the candle stays its own effect with a hand-tuned *visual* size.

| Derived | Formula | lamp 5px | campfire 66px | inferno 660px |
|---|---|---|---|---|
| `D_m` | `diameterPx × mPerPx` | 0.08 m | 1.0 m | 10.1 m |
| **`puffHz`** | **`1.5 / √D_m`** (Cetegen–Ahmed) | **5.4 Hz** | **1.5 Hz** | **0.47 Hz** |
| `riseSpeed` | `1.9 × √D_m` m/s | 0.54 | 1.91 | 6.03 |
| `turb01` | `smoothstep(0.05, 0.70, D_m)` | laminar | turbulent | turbulent |
| `heightPx` | `D × (4.0 − 2.8·turb01)` | 4.0× tall | 1.2× | 1.2× squat |
| **`shearPx(h)`** | **`wind × (h·heightPx) / riseSpeedPx`** | ~0 | streak | long streak |
| `lightRadiusPx` | `6 × D`, clamp [120, 1400] | 120 | 396 | 1400 |

Three of these carry the design:

- **`puffHz` is right across three orders of magnitude**, which is why it is used instead of a tuned constant — it cannot be tuned wrong.
- **`shearPx` costs zero art constants.** Downwind offset = wind × time-of-flight, and time-of-flight = height / riseSpeed. The plume streams off one side because two physical quantities already in hand say it must. It scales as **√D**, not D — a bigger fire rises faster and so shears proportionally *less*.
- **`turb01` is the cue that sells scale.** Laminar → turbulent, one smoothstep, driving lobe count, billow amplitude, octave count and height ratio together.

⚠️ `smoke01` and `smokeDensity` are **two numbers because they answer two questions** — *how much of the plume is smoke* (shape, strictly 0..1) versus *how thick it is* (opacity, allowed past 1 so oil billows black). One clamped field made every fuel smoke identically above ~1 m (`feedback_one_byte_two_quantities`).

---

## 5. Four bugs the pictures caught that the numbers did not

Every one of these passed its checks while looking wrong. They are recorded because each is a *class*, not a typo.

1. **Posterization was being integrated away.** Banding each of ten slices and then summing them averages the bands back out — ten staircases at ten offsets add to a ramp. `uPosterize` at 0.85 was visually identical to 0. Fixed by accumulating a density-weighted **temperature** and evaluating the ramp **once** at the end, which is also cheaper (one ramp instead of N).

2. **Flame and smoke were averaged as one substance.** They are an *emitter* and an *absorber*, and a weighted mean of "glowing" and "not glowing" is just "dimmer" — so smoke won everywhere its coverage was larger, which is always (the plume spreads to 1.35× the fuel bed while the flame tapers to 0.34×). The fire's own core rendered **(60, 56, 52)**: grey. Now accumulated separately and combined by share, each with its own gain.

3. **Three frame-of-reference errors in one file** (`feedback_normalization_erased_the_compared_axis`) — noise frequency scaled to the *quad* instead of the fire radius (26 lobes across the fire instead of 3, giving a sea-urchin silhouette); edge softness likewise (360 px of gradient on a 292 px blob, so nothing had a silhouette and the bands had nothing to land on); and the smoke's axis-clear term measured against the *slice's* radius instead of the flame's (a 50 px clear channel through a 137 px flame, rendering it as a bright dot inside a grey lid).

4. **Two checks that passed on nothing.** `the-fire-is-warm` tested `r ≥ g ≥ b` and passed a grey; it now requires `(r−b)/r > 0.45`. `wind-shears-the-plume` compared two centroids and passed on **two completely black frames** — the centroid of an empty frame is (0,0), which is 3310 px from the anchor. It now refuses to compare until both frames contain a fire (`feedback_instruments_must_not_lie`).

The black frames had a cause worth its own line: `createWindHandle`'s `ambientWind` fields are **TSL nodes, not JS numbers** (`sampleWind` does `wind.directionDeg.mul(...)`), and passing plain numbers built a material that rendered nothing with no thrown error.

---

## 5a. What the FIRST LIVE RUN caught that the lab could not

The lab renders one fire on black. Three defects only appeared on a real map.

**1. The whole fire wobbled sideways.** Author, watching it: *"the entire effect is parented to a single spot… fire shouldn't wobble sideways like this."* Two causes, both real modelling errors:

- The slice spacing `1 − (k+0.5)/N` put the **lowest** slice at h = 0.05, so it carried 5% of the wind shear. The bright flame slices live in the bottom third, so the fire's *root* slid with every gust. The bottom slice now sits at exactly **h = 0**.
- Shear was **linear** in height. It should be **quadratic**: a parcel leaving the fuel bed is momentum-dominated and moving almost straight up — it only acquires the wind's horizontal velocity as it decelerates. `h²` pins the base hard and leaves the top's lean untouched.

Plus `sampleWind` always returns a large **organic** gust term — correct for grass, wrong for fire, which is anchored to burning fuel. It is now damped to 0.35 and `WIND_PX_PER_SEC` came down 420 → 120 → **55**. Measured after: a 200 px fire drifts **10 px over 1.2 s** of wind, a lean rather than a wobble. Guarded by `the bottom slice sits at EXACTLY h = 0` and `shear is quadratic, not linear`.

**2. A per-frame flood of `computeBoundingSphere(): Computed radius is NaN`** out of `runLightAccumulatePass`. **One non-finite vertex poisons an entire batched geometry** — every healthy fire or light sharing that buffer stops drawing, so the failure is never local. Both producers now check every number at the boundary: `fireCirclePolygon` returns `null` rather than a NaN polygon, `buildFireLightSources` drops a descriptor whose radius/luminosity/alpha is not finite, and `computeFireQuadArrays` validates the resulting **quad size**, not just its inputs. Hostile-input tests feed NaN/Infinity/garbage at five different `mPerPx` values (including 0 and NaN) and assert not one non-finite float reaches a buffer.

**3. Fire was missing from the Workshop panel entirely** — registering the effect is not the same as giving it a card. Each Workshop row is its own `registerPanel` call.

And the reason the author saw nothing at first: **the mask path did not exist.** The plan said mask-first; the first build shipped anchors-only. `_Fire` now declares `rasterize: true` and `fire-mask.js` extracts sources from the painted region.

**4. Fire appeared once, then vanished on the next reload — no error, nothing on screen.** The material, the mask extraction and the pure math were all fine (Shader Lab's `draws-at-all`, run against the exact production `buildFireMaterial`/`buildFireGeometry`, rendered a correct bright frame the whole time). The bug was one line away from the effect entirely: `reapplyFire()` existed but was reachable from nowhere except `MapShine.setFire`, so `fireReadout` sat at its boot seed of `{enabled:false,...}` on every real `ready`/scene-load/settings-change. `EFFECT_REAPPLIERS` (`boot.js`) is the hand-maintained list that drives every effect's cascade on those three triggers — its own header already names this exact failure mode (it was added *because* bloom, water, fluid, specular and window light had each fallen out of one or more of the three hand-lists it replaced) — and fire fell into it anyway, because writing `reapplyFire()` and adding it to the list are two separate steps and only the first one happened. What made it appear "once": a manual `MapShine.setFire(...)` call during testing calls `reapplyFire()` directly, which resolves and applies the cascade for that session only. Fixed by adding the missing line; no wall catches this class of bug today, so it stays a one-line discipline, not an enforced one.

---

## 5b. Round two, live: two blobs, spiky, slow

Fire rendering was confirmed (§5a #4 fixed) and the author sent a screenshot: a tall archway hearth rendering as **two same-size blobs stacked vertically**, with an edge described as *"bendy spikes... moves very slowly and doesn't really look like flames seen from above, it more looks like flames seen from the side."* Two independent root causes, one per complaint.

**The two blobs were two real, separate fires.** `extractFiresFromMask`'s chamfer ridge-walk has no way to tell "a tall archway, one paint region, no real neck" from "a genuine thin line" — both are regions of roughly constant width with a ridge running down the middle, and the algorithm's only lever (`PEAK_SEPARATION`) compares a candidate to its *neighbours*, never to the shape's own overall extent. Confirmed by reproduction: a synthetic archway (14×44 texels) minted 3 fires; sweeping `PEAK_SEPARATION` from 1.7 to 5.0 never separated the archway from this file's own tested line fixture — collapsing the archway to one fire required a separation wide enough to start gapping the line (the failure mode the file's own comment already named). Fixed with a real discriminator instead of a bigger constant: connected components are labelled, and a component only mints multiple fires when its long axis is genuinely many multiples of its own peak radius (`ELONGATION_RATIO = 8`, measured against the archway's ≈5.5 and the line fixture's ≈20). Re-verified against the real `Tower_Bridge_Middle_Fire.webp`: 23 → 20 fires at the shipping 512 grid (the over-split duplicates merged; the genuinely separate hearths did not).

**The spikes and the slow motion shared one cause.** `LOBES_PER_RADIUS` (1.6) was correctly scaled to the fire's own radius (fixing an earlier sea-urchin bug), but at that frequency a typical hearth's turbulence produced only a handful of lobes — so `BILLOW_DIMINISH`'s low falloff (0.22, tuned to suppress thin tendrils) left octave 1 carrying almost the whole silhouette: a few big rounded points radiating from a disc, which *is* the classic side-view cartoon-flame silhouette, not a top-down cauliflower cloud. The same coarse frequency made the boiling motion read as slow, independent of the actual phase rate: marching a Z-phase through a few large features reshapes them gradually no matter how fast the phase advances, while the same rate visibly reshapes many small features every frame. Fixed by doubling `LOBES_PER_RADIUS` (1.6→3.2) so even the first octave alone produces many small lobes, nudging `BILLOW_DIMINISH` back up slightly (0.22→0.28) now that the base frequency itself is fine-grained, and lowering the billow amplitude caps (0.42/0.34→0.30/0.24) so more, smaller lobes don't just read as a finer spiky fringe. Checked visually at hearth scale (48px, `motion-check` scenario) and across three sizes (`style-plate`): consistently mottled, rounded edges, no dominant "points," at every scale tested.

Both fixes are algorithmic/tuning changes with Node/visual verification, not yet re-confirmed against the actual archway on the live map.

---

## 5c. Round three, live: one blob now, but wrong on three more counts

The archway fix worked — the author confirmed one fire, not two. But the substance of the complaint moved from "two blobs" to the flame itself: *"It's a circle, why is it a circle? The fireplace has a half circle of mask and the shape of the fire... doesn't conform to the shape of the actual mask... The colours are fairly good but there is no hot whiter center. The wiggling tendrils don't look like flames... The fire isn't very good so far."* Plus a technical hint about the reference art: *"constructed from noises interacting with each other."* Three separate fixes, not more tuning of the same knobs.

**No hot core.** `baseTemp` scaled from 0.6 up to 0.95 with fire *diameter* — physically backwards. A match flame and a bonfire burn at similar combustion temperatures; what actually changes with size is turbulence (`turb01`, already modelled separately), not peak heat. Every hearth-scale fire (0.3–1 m — what is actually painted on a real map) topped out around 0.6–0.7 and never reached the ramp's pale-core stop. Fixed by making `baseTemp` mostly size-independent (0.88 baseline, only a small residual push for a genuine inferno).

**Tendrils, not lobes.** Author's own diagnosis was right: the silhouette was a single fbm folded once (`1 − |fbm|`), which is close-to-radially-symmetric noise and reads as a handful of spikes radiating from a centre, not an organic boil — domain warping (a second, cheaper/lower-frequency noise field displacing the coordinate the main field samples) is the standard fix for exactly this, and is what most real-time fire/cloud shaders since Perlin's own "flow noise" actually do. Added: `fbmVec3` gives two decorrelated displacement channels from one sample position (cheaper than two independent evaluations), offset in frequency/phase/z from the field it warps. Cost measured before/after on the same 300px fire: 0.079 ms → 0.112 ms (≈1.4×), still cheap. Visually confirmed at hearth scale and three sizes: hotter core, visibly asymmetric/organic lobes, no dominant radial points.

**The flame ignored the mask's shape entirely — the deepest gap.** Until this round, `_Fire` only ever set a fire's *centre* and *diameter* (the chamfer ridge extraction); the rendered silhouette was pure procedural noise with zero knowledge of what shape was actually painted, so a half-circle fireplace always rendered as a full circle. Fixed by giving fire a GPU-sampled mask for the first time: `bakeFireMaskTexture` (vt-pan-viewer.js) bakes the same coarse `_Fire` grid `extractFiresFromMask` already reads into a texture (mirroring `bakeOutdoorsTexture`/`buildWorldSpaceOutdoorsGate`'s existing pattern — `gpu/textures-in-vt-only` means the actual `DataTexture` has to live in `vt/`, not `effects/fire/`), sampled in the fragment shader at each fragment's world position and multiplied into per-slice density. FLAME slices are clipped hard; SMOKE slices blend back toward unclipped (real smoke drifts past a fireplace opening into the room — clipping it to the same tight outline as the flame would look like it hit a glass wall). A new per-vertex flag (`fireParams` widened vec3→vec4, the fourth slot `maskClip`) means a mask-derived fire is clipped and an anchor-placed fire never is, even sharing a batch — an anchor has no painted shape to conform to, and clipping it against whatever the mask happens to read at that point would be `feedback_gate_polarity_must_fail_open`'s exact mistake in a new outfit.

This last one is the only fix in the whole fire effort so far that Node tests structurally cannot verify at all — compiling and running a TSL fragment shader is real-GPU-only. Built a dedicated Shader Lab scenario (`mask-clip`) that bakes a real left-half-disc mask texture, renders through the exact production `buildFireMaterial`/`computeFireQuadArrays` path, and checks the lit-pixel centroid: clipped shifts 19.6px toward the painted half, the identical texture with the per-fire flag off stays at 0px shift, and `maskClip:true` with no texture wired *also* stays at 0px (fail-open confirmed). Read the saved PNG and it is unambiguous — a clean flame confined to the painted half with a dim smoke halo drifting past the edge.

All three fixed, Node suite 285/285 (fire) and 8015/8015 (repo) green, structure clean. Not yet seen live — this round changes the flame's actual silhouette logic in a way the previous two didn't, so it is the least predictable of the three to look right on the first try.

---

## 6. The light is the effect

Measured on the candle (`Performance-Insights.md`): every flame billboard in a scene cost **0.022 ms**; its lights cost **13.1 ms of a 20.4 ms frame across 91 draw calls**, because a 24 px billboard covers ~576 px² against a 400 px-radius light's ~785,000, drawn twice — roughly **1,363×**.

Fire's radii are larger. So:

1. **One light per fire.** Never per lobe, never per ember.
2. **Clustered by tier** (`clusterFactor` 2.0 → 0.35; cell area goes as the square), and clusters combine diameter **in quadrature** — two 100 px fires burn as one ~141 px fire, never a 200 px one.
3. **Radius derives from `6 × diameterPx`**, clamped — never a code default. The candle's hard-coded 400 px is exactly the mistake that made lights un-budgetable.
4. **Flicker is in lockstep because both halves call the same pure function** — `firePuffPhase(tMs, puffHz, seed)`, once per fire per frame on the CPU for the light and once per fragment on the GPU for the flame. Lockstep comes from calling one function, not from sharing a GPU node.
5. **`ownerEffectId: 'fire'` is set on every descriptor, and `light.drawFire` is its own zone.** `light.drawPointLights` and `light.drawColoration` bill to nobody, which is why candles' 13.1 ms went unnoticed.

---

## 7. Files

| File | Role |
|---|---|
| `src/effects/fire/fire.js` | Declaration — params + manifest + tier ladder. Pure data. |
| `src/effects/fire/fire-geometry.js` | Pure math, Node-tested: the scale chain, puff law, slice table, coverage gate, clustering, light descriptors, vertex bake, params→runtime. |
| `src/effects/fire/fire-render.js` | TSL material + geometry builder. THREE injected. |
| `src/effects/fire/fire-subsystem.js` | Lifecycle: size-class batches, material-variant cache, coverage rung. |
| `tools/shader-lab/bench-fire.js` + `fire-lab.js` | The bench. |
| `src/effects/fire/__tests__/` | 229 Node assertions. |

Wired through `effects/index.js` → `boot.js` (registration + `getFireRenderState`) → `vt-pan-viewer.js` (subsystem construction, `sync`, guarded additive draw, light merge, dispose). A `fire` anchor kind is in `scene/anchor-catalog.js`.

**Five vertex buffers, three spare.** The natural attribute set is exactly 8 — on WebGPU's guaranteed limit, with no room for the next idea. `lightning-render.js` had to widen a vec3 to vec4 rather than open a 7th after a real compile failure at 12. If an eighth thing ever needs to reach a fragment, **widen an existing vec, do not add a buffer.**

**Fires are grouped into size classes** (octaves of diameter, one batch each) so every per-slice shape constant folds into the shader. A real map has one to three classes.

---

## 8. Tiers, and the coverage gate

| n | name | fromProfile | class | est ms/Mp |
|---|---|---|---|---|
| 0 | `hearth` | — | C8 | 0.05 |
| 1 | `billow` | low | C1 | 0.14 |
| 2 | `plume` | performance | C1 | 0.29 |
| 3 | `smoke` | standard | C1 | 0.45 |
| 4 | `flicker` | quality | C3 | 0.49 |
| 5 | `inferno` | extreme | C8 | 0.70 |

Rung 0 is C8 and that is legal — the monotonic-cost check starts at i=2, the same shape water uses. A fire that emits no light reads as *broken*, not simple.

**Coverage is a second, independent axis** — Law 7's first real consumer (`Effects.md` step 4, declared and never built). Tier says which terms exist; coverage says how many slices. Since N is a build-time constant, a rung change is a **pipeline swap**, which is why it carries ±35% hysteresis and a 500 ms dwell and climbs one rung at a time.

⚠️ **The one unresolved tension.** Zoomed *in*, the fBm's high octaves become many screen pixels wide, so fire wants *more* octaves exactly when cost is worst — the mirror image of Clouds, which drops octaves as you zoom out. Current resolution: hold octaves fixed and let slices absorb the zoom. Reasoned, not measured.

---

## 9. Not built

- **Smoke is in the wrong blend mode.** It rides the flame's *additive* pass, so it can only add light and reads as a warm haze rather than something that darkens the map beneath it. The correct shape is a second, alpha-blended pass — which is what V2 did (flame additive, smoke `NormalBlending`). This is the top of the list.
- **Mask-driven sizing.** The painted region's own width should set each blob's diameter via a jump flood (`water-body.js`'s `jfaStepCount`/`jfaStrideForStep`/`rebaseNeighborOffset` are generic and importable; the three material builders are the pattern to mirror). Needs `rasterize: true` on the fire entry in `mask-catalog.js` — one line. Anchors serve today.
- **Embers, stray sparks, coal bed** — via the shared `ParticleArena` and `SPAWN_KINDS.extracted`, which was explicitly designed for fire spawn points. Must add **zero** new storage buffers; the arena already uses 6 of 8.
- **Room-filling smoke** — belongs in `world/smoke-field.js` as a sibling of `wind-field.js`, not inside this effect. Needs a *room* concept the codebase does not have.
- **Fire whirl** — a `rotate2d` on the noise coordinate as a function of height. Uniquely legible from directly above.
- **A steady-state cost bench for the material itself.** The per-slice scalar ALU is still estimated at ~0.004 ms/Mpx; only the noise term is measured.

---

## 10. How to look at it

```bash
node tools/shader-lab/serve.mjs
```

Then in the page console:

```js
window.lab.run('fire', 'draws-at-all')        // compiles, draws, right way up
window.lab.run('fire', 'the-reference-look')  // shear + core survival at three sizes
window.lab.run('fire', 'style-plate')         // close-ups for judging the LOOK
window.lab.run('fire', 'noise-fold-ab')       // the cost question, ~260 timed frames
window.lab.run('fire', 'octave-cost-curve')
```

`style-plate` deliberately asserts **nothing** — it produces pictures to compare against the reference image. Taste is the lab's stated blind spot (`Shader-Lab-Proving-Ground` §7) and a green check there would be a lie about who decides.

**Lab-green is `BUILT (unverified)`. Only the author, on a real scene, says `LIVE`.**
