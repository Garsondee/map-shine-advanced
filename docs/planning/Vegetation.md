# VEGETATION — `_Tree` and `_Bush` are one effect, and local wind is the reason

_Design, 2026-07-23. Nothing here is built. Written after reading V2's real implementation end to end, not from memory of it._

Related: `Wind.md` §5.1 (THE HANDLE — the access mechanism this depends on), `Effects.md`, `Effect-Registration.md`, `Keyhole.md` §"Per-page CPU extraction".

---

## 0. WHAT V2 ACTUALLY SHIPPED — read this before "porting" anything

Measured, not remembered (`legacy/compositor-v2/effects/`):

| File                             | Lines      |
| -------------------------------- | ---------- |
| `TreeEffectV2.js`                | 2,833      |
| `BushEffectV2.js`                | 2,362      |
| `vegetation-clump-field.js`      | 1,665      |
| `vegetation-bulk-wind.js`        | 606        |
| `vegetation-mask-load.js`        | 516        |
| `vegetation-streaming-bridge.js` | 476        |
| `vegetation-wind-params.js`      | 385        |
| + 7 more `vegetation-*.js`       | 1,537      |
| **total**                        | **10,380** |

**Tree and Bush are the same file twice.** Diff them: identical structure, identical `populate()`, identical uniform blocks, identical shadow model, identical clump wiring. The differences are ~40 default values (a tree sways slower and further than a bush) and one extra turbulence term. V2 shipped 5,195 lines to express "trees are bigger than bushes."

**How V2's wind actually worked — this is the important part.** It read exactly two numbers:

```js
const rawWind = sceneWindField.getSmoothedWind01(); // ONE scalar for the whole map
const windDir = weatherController.currentState.windDirection; // ONE direction for the whole map
```

Everything else — gust noise, travelling waves, turbulence, flutter — was **procedural noise over world position**, invented locally to fake the variation a single global scalar can't have. There was no geometry in it anywhere. **A tree in a sealed walled courtyard swayed exactly as hard as one on an open moor**, because nothing in the pipeline knew a wall existed.

That is why V2 needed eight "response curve" knobs per effect (`flutterWindStart`, `flutterWindFull`, `flutterLowWindBoost`, `flutterLowWindFadeEnd`, `flutterGustFloor`, `bendMinStrength`, `bendWindStart`, `bendWindFull`). They exist to hand-reshape a response that had no real input to respond to.

**What V2 got RIGHT, and we keep:**

- **The clump field.** Connected-component island labelling from the mask's alpha at load time, baked to a coordinate texture plus per-vertex attributes (`aClumpAnchor`, `aClumpId`, `aFoliageCover`). This is what makes a bush sway _as a bush_ — one rigid unit with its own phase — instead of the whole layer sliding like a rubber sheet. It is the single best idea in those 10,380 lines.
- **The three-layer motion stack.** Rigid bulk sway (vertex) → branch bend (UV distortion) → leaf flutter (fine fragment UV). The ordering is right and the visual reasoning is sound.
- **The offset canopy shadow.** Cheap, reads well, sells the "this is above the ground" illusion.

**What V2 got wrong beyond the wind:** four separate bolted-on shadow-coupling systems (`vegetation-cloud-shadow`, `-building-shadow`, `-painted-shadow`, `-landscape-lightning`), each with its own uniforms, defaults, schema group and sync call — because V2 had no shadow authority to ask. V3 has one.

---

## 1. THE HEADLINE CHANGE — wind becomes local, and it costs us nothing to get it

V3's wind field already knows things V2's could not:

| Signal                    | What it means for a plant                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openness`                | Flood-filled connectivity to open air through walls/doors, with door-distance falloff. **A courtyard tree barely moves; the one outside the wall thrashes.** No painting, no per-tree setup — geometry decides.               |
| `exteriorOpenness`        | "Genuinely outdoors" vs "indoors but reachable through an open door". Lets a potted plant behind a shut door sit _still_ while the one beside an open door gets hammered.                                                     |
| turbulence (two octaves)  | Indoor peak amplitude is **2.4** — deliberately larger than the coherent wind's own maximum, so vectors near a doorway genuinely point _backwards_. A hedge by an open door whips inconsistently instead of leaning politely. |
| wall-avoidance deflection | A shrub against a building leans **along** the wall, not into it.                                                                                                                                                             |
| `liveField` (Tier 2)      | A door swings open → the transient gust hits the bushes on the same frame it hits the candles and the dust.                                                                                                                   |

**None of this needs new vegetation code.** It is what `handle.node()` returns. The entire "much better job" the author asked for is, mechanically, _one function call at the right position_ — and then deleting the ~15 params V2 needed to fake it.

**And the requested property falls out for free:** the same call that moves a candle flame moves a bush. Same function, same position, same frame. Improve `sampleWind` — a new turbulence octave, a better door model, a thermal contributor — and vegetation inherits it without being edited, because vegetation contains no wind of its own to fall out of sync.

---

## 2. TREE AND BUSH ARE ONE EFFECT

**One declaration module (`effects/vegetation.js`) + one render module (`effects/vegetation-render.js`), parameterised by kind.** `_Tree` and `_Bush` become two entries in a `VEGETATION_KINDS` table: mask id, z-offset, and a tuning preset.

```js
export const VEGETATION_KINDS = Object.freeze([
  { id: 'tree', maskKind: 'tree', zOffset: 0.18, preset: TREE_TUNING },
  { id: 'bush', maskKind: 'bush', zOffset: 0.12, preset: BUSH_TUNING },
]);
```

Consequences worth naming:

- A third kind — `_Grass`, `_Crop`, `_Banner`, `_Kelp` — is **a preset plus one catalog line**, not a new 2,400-line file. (The catalog wall enforces this: a mask suffix literal outside `scene/mask-catalog.js` fails the build.)
- A wind improvement lands once, not twice-and-hope-they-match. V2's `syncVegetationWindParamsToUniforms` exists purely to keep two copies agreeing; it evaporates.
- `tree` and `bush` are **already declared** in `scene/mask-catalog.js` as `channels: 'rgba'`, `absentValue: 0`. Discovery works today, for free. Nothing to add.

---

## 3. THE CLUMP FIELD — kept whole, moved onto the sanctioned path

The idea survives; the plumbing does not. V2 read mask pixels with a world-resolution `getImageData` — the exact call class that appears in every crash report and that the `no-gpu-readback` wall now forbids.

V3's home for it is already designed and already named: **per-page CPU extraction in the decode worker** (`Keyhole.md` §"Per-page CPU extraction (kills the getImageData class)" literally lists _"vegetation clump fields"_ as a motivating use case). `vt/decode-pool.js#readPageBitmapPixels` is the sanctioned door.

So: label connected components per 248² page at decode time, accumulate world-space island records incrementally, stitch across page seams. Output per island: **centroid (world xy), area, bounding box, a stable id**. That is a few hundred bytes per island for a whole map — orders of magnitude less than V2's coordinate texture, and it never allocates at world resolution.

**Why the centroid is the load-bearing bit:** it is the position we sample wind at. One wind sample per island, not per vertex and emphatically not per fragment (see §7). A tree's whole canopy leans according to the wind _where that tree stands_ — which is the entire point.

---

## 4. THE MOTION STACK — three layers, one wind sample

One `handle.node()` call per island, at the island centroid. Everything below is a cheap transformation of that one vector.

| Layer               | Where                          | Driven by                                                                                                                                                                                                      |
| ------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Bulk sway**    | vertex                         | The island's wind vector, directly. Rigid — the whole clump leans as one body. Per-island phase from the clump id, so neighbours don't march in lockstep.                                                      |
| **2. Branch bend**  | vertex (or coarse fragment UV) | The same vector, scaled by height-within-island (`aFoliageCover` — top of the canopy moves more than the base). This is the layer that reads as "branches", and it's a free re-use of the layer-1 sample.      |
| **3. Leaf flutter** | fragment                       | Cheap local noise **modulated by** the island's wind magnitude — _not_ a second `sampleWind` call. Flutter is high-frequency detail; it needs to know _how hard_ the wind is here, not to re-derive the field. |

**The elastic response is the one genuinely new piece.** V2 had `elasticity` as a bare oscillation-rate multiplier with no memory. A plant should _lag_ the wind and _overshoot_ on release — that's what makes a gust look like a gust rather than a slider being dragged. One critically-damped spring per island (two floats of state), driven toward the sampled target. It is ~6 lines, and it is most of the difference between "convincing" and "shader demo".

This also finally makes Tier 2 legible: a door opens, the gust arrives, the hedge _snaps_ and then settles. V2 could not express that at any setting.

---

## 5. SHADOW — delete four systems, use the one that exists

V2 grew four shadow-coupling modules because there was nothing to ask. V3's shadow foundation is built and author-confirmed ("awesome" — `Light-and-Shadow.md` §5).

**Vegetation becomes a shadow _caster_, not a shadow _implementation_.** The canopy's alpha is a caster silhouette handed to the existing system; cloud shading, building shading, painted shading and lightning response then apply to vegetation the same way they apply to everything else, through the passes that already do it.

Keep exactly one bespoke thing: **the offset self-shadow** (the mask sampled again, pushed opposite the sun, blurred). It is not really a shadow — it's a cheap fake of canopy self-occlusion that makes foliage read as volumetric, and the real shadow system has no cheaper way to produce it. Three params, one multi-tap sample. Everything else in that folder goes.

**Deleted outright:** `vegetation-cloud-shadow.js`, `-building-shadow.js`, `-painted-shadow.js`, `-landscape-lightning.js`, `-ambient-light.js`, `-camera-grade.js` (≈1,331 lines). Grade and ambient are pass-level concerns in V3; vegetation should never have had its own exposure/contrast/saturation/temperature/tint block, and shipping one is how you get foliage that doesn't match the ground it sits on.

---

## 6. PARAMS — about 50 down to about 8 (⚠ SUPERSEDED — see §8.2, now 17)

_This section is the ORIGINAL pre-build estimate, kept for the design reasoning (which is still correct) even though the exact param names/count it predicted are not what shipped. §8.2 has the real, current schema._

V2 exposed ~50 sliders per kind. Most exist to fake spatial variation (§0) or to re-do a pass-level job (§5). With a real field and a real shadow system, the honest set is:

| Param                                    | Why it survives                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `windResponse`                           | The standard per-effect wind dial (`Wind.md` §8.1). Candles already have it; same name, same range, same meaning. 0 = a plant wind cannot touch. |
| `swayAmount`, `swaySpeed`                | Amplitude and the spring's natural frequency.                                                                                                    |
| `clumpIndependence`                      | Per-island phase spread — 0 = the whole layer moves as one, 1 = every plant its own creature.                                                    |
| `flutterAmount`, `flutterSpeed`          | Leaf-scale detail.                                                                                                                               |
| `selfShadowStrength`, `selfShadowLength` | The one kept bespoke shadow.                                                                                                                     |
| `intensity`                              | Master gain on the layer.                                                                                                                        |

Everything in V2's "Response curves" folder, both "wave" groups, and the entire "Color" folder is gone. One schema → FOH and ROH both generated, per the effects-UI directive; dead controls are cured by not shipping them.

**What actually happened (§8.2): the author reversed this minimalism call directly**, once the Tier-2 build gave them something to react to — "the more controls the better" — so the real `VEGETATION_PARAMS` has 17 entries, not 8. The STRUCTURE this section argues for (one shared schema for both kinds, FOH+ROH generated from it, V2's redundant folders gone) held; only the target _count_ did not.

---

## 7. THE HONEST OPEN QUESTION — cost

**Vegetation is the first wind consumer that wants wind across a whole visible layer, not at a handful of anchors.** Candles: dozens of points. Particles: a compute kernel with its own buffers. Vegetation: potentially every canopy in view, every frame.

Counted from the source, one `sampleWind` call is **~13 noise evaluations** (5 for drift/gust/flutter + 4 psi taps × 2 curl octaves) plus 2–3 texture fetches. That is fine per-island. It is **not** fine per-fragment across a full-screen canopy layer, and anyone who reaches for the convenient thing will write it per-fragment.

So this is a design constraint, stated up front rather than discovered in a frame-time regression:

> **Sample wind once per island, at its centroid, in the vertex stage. Never per fragment.** The fragment stage receives an interpolated wind magnitude and a phase, and does cheap local noise with them.

The open question this leaves — genuinely open, to be answered by measurement, not argument — is whether a dense map (hundreds of islands) is better served by `handle.node()` per island in the vertex shader, or by a small per-island wind buffer filled by one compute dispatch and read as an instance attribute. **The Effect Performance Lab exists precisely for this.** Build the vertex-sampled version first (simplest, no new buffers, no risk of re-hitting the WebGPU 8-storage-buffer-per-stage limit that already bit the gusts), measure it on the torture world, and only then decide whether the buffer is worth it.

---

## 8. THE TIER LADDER — honest rungs

| Tier  | What it adds                                                   | Status                                                                                                                                      |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Canopy at correct placement, with coverage alpha               | ✅ **BUILT** (2026-07-23), both attachment modes — a tile whose own texture is the mask, and a plain albedo with a discovered sibling file. |
| **1** | Bulk sway from the real local field                            | ✅ **BUILT** (2026-07-23).                                                                                                                  |
| **2** | Spatial variation, gale character, leaf flutter, ground shadow | ✅ **BUILT** (2026-07-23, same session — see §8.1).                                                                                         |
| **3** | True clump islands, spring transients, self-shadow             | ⏳ Deferred; recorded in `VEGETATION.deferredRungs`.                                                                                        |

### 8.1 What Tier 2 actually fixed (2026-07-23, author-reported)

> _"All trees/bushes sway in the exact same direction the exact same amount at the exact same time… At gale the trees look and act very much like they do at a light breeze. We have a wonderfully complex nuanced wind simulation, let's make that visible."_

The lockstep was **not** a tuning problem. The overlay was a **4-vertex quad**, so a `_Tree` mask painted across a whole map got exactly ONE wind sample for the entire forest — no parameter could turn one vector into many. Four changes:

1. **Tessellation** (`vegetationMeshSegments` / `buildTessellatedQuadGeometry`, both Node-tested). Each vertex samples the field at its own world position. Nearly free, because `computeQuadCorners` already emits world-space corners with no mesh transform, so `positionLocal.xy` _is_ the world position.
2. **Per-clump decorrelation.** A hash of the quantized ~150px world cell gives phase, amplitude and direction jitter. All vertices in a cell share it, so a plant-sized region moves _coherently_ instead of shearing — a poor-man's clump field with no CPU mask analysis.
3. **Gale character**, the actual "a gale looked like a breeze" fix. Amplitude was already scaling; _character_ was not. Added a **persistent downwind bend** growing with wind² (a gale leaves the canopy bent over rather than swinging wider about neutral), **rate scaling** (thrash vs undulate), and a >1 amplitude power curve. All driven by the **local** sampled magnitude, so a sheltered courtyard stays calm during the same gale.
4. **Mass-preserving leaf flutter.** A curl-noise UV shuffle — divergence-free by construction, therefore **area-preserving**, which is exactly the requested "mass preserving distortion": leaves move without the canopy stretching or thinning. Shares `world/wind-field.js#curlNoise2D` with wind turbulence rather than inventing private noise (`wind/sample-through-the-door`), and that divergence-free property is asserted exactly (<1e-12) in the world suite.

Plus the **ground shadow**, via the new shared shadow handle (`Light-and-Shadow.md` §6) — a twin mesh under each source, same tessellation and same wind motion, so a moving plant's shadow moves with it.

### 8.2 FOH/ROH controls + a default retune (2026-07-23, SAME DAY, author follow-up)

> _"I need you to add the FOH and ROH controls for this into the UI. Currently distortions are very very strong. I need controls over frequency, evolution rate, amplitude and things like that, the more controls the better. No sign of bush or tree shadows yet."_

Two bugs, one param expansion:

**Shadows were invisible — two independent, unrelated causes**, both silent (nothing rendered _wrong_, nothing rendered at all):

1. `syncVegetationShadowUniforms` used to take an `entry` it unwrapped internally (`entry.shadow?.uniforms`); Case 1's call site already passed the shadow record itself, so the internal unwrap silently read `t.shadow.shadow` (never set) and returned early forever — `uShadowStrength` never left its build-time default of 0. Fixed by having every call site pass the `uniforms` object directly, never an owner to unwrap.
2. The Case-2 (sibling-mask overlay) shadow's `renderOrder` was `item.renderOrder - 0.5` — but for Case 2, `item` **is the ground**, so the shadow drew _under_ its own (opaque) ground and was painted over and erased every frame. Fixed with a named `VEG_SHADOW_RENDER_ORDER_MAGNITUDE` constant whose sign is documented per call site, since Case 1 and Case 2 disagree about what `item` even means.

**Every internal tuning constant became a live param.** Tier 2 shipped `buildVegetationMaterial`'s sway curve, gale gains, flutter rate and clump spread as code constants (`VEG_SWAY_CURVE`, `VEG_GALE_BEND_GAIN`, `VEG_FLUTTER_GALE_RATE`, `VEG_CLUMP_*`, …) — deliberately minimal, Tier-1-honest. The author's follow-up reversed that call directly, so `VEGETATION_PARAMS` grew from 5 to 17: `swayFrequency`, `swayCurve`, `galeBendAmount`, `galeRateGain`, `flutterFrequency`, `flutterGaleFrequency`, `flutterUvScale`, `flutterScale`, `clumpSizePx`, `clumpPhaseSpread`, `clumpAmpSpread`, `clumpDirSpread` are all new; `shadowStrength` was recategorised from an ad hoc `'Shadow'` (which silently landed in the ROH's `Technical` bucket — `diag/effect-controls.js`'s category list doesn't include it) to `'Look'`, matching `ui-window-shadow.js`'s own `strength01` precedent.

Making these genuinely _live_ (not just declared) took one real discovery: `curlNoise2D`'s `spaceFreq`/`rate` are documented as plain JS numbers, baked into the shader graph at construction. Verified against the vendored TSL `ConvertType`/`float()` implementation that a NODE passed in is cast/passed-through rather than re-wrapped — so `flutterFrequency`/`flutterGaleFrequency`/`flutterScale` could become real uniforms instead of construction-time-only values, and `curlNoise2D`'s own JSDoc was broadened (not changed in behaviour) to say so. Every other new param was already inside plain TSL arithmetic and needed no such check. A new `syncVegetationMotionUniforms` (mirroring `syncVegetationShadowUniforms`'s own "take the uniforms object directly" shape) pushes all 12 motion params into every mesh's uniforms each frame — including the SHADOW mesh's own independent copy of the same uniforms (the shadow computes the identical `positionNode` displacement as its canopy), so a live retune can never desync a plant from its own shadow.

**Defaults moved down**, not just became tunable — "very very strong" was a complaint about the shipped LOOK, not only the absence of controls: `swayAmount` 20→14, `flutterAmount` 1→0.55, `galeBendAmount` (was `VEG_GALE_BEND_GAIN`) 1.6→1.0, `flutterGaleFrequency` (was `VEG_FLUTTER_GALE_RATE`) 7.0→4.0. `galeBendAmount` and `flutterGaleFrequency` were the two biggest contributors: the persistent bend stacks _additively_ with the oscillating sway, and flutter's amplitude scaled up to ~5.4× between calm and gale.

The FOH/ROH card itself (`boot.js#buildVegetationPanel`) is the same generic `diag/effect-controls.js#buildEffectCard` every effect uses — five plain-language dials up front (`intensity`, `windResponse`, `swayAmount`, `flutterAmount`, `shadowStrength`), the other twelve behind "Advanced ▾", categorised. `MapShine.setVegetation({...})` is the write path (mirrors `MapShine.setCandle` exactly), a transient override layered on top of the settings cascade — tune live, nothing persisted yet.

⚠ **NOT LIVE-TESTED.** Verify-green (3236). Live check: open the Vegetation card, confirm Advanced shows all 12 new sliders; drag `flutterGaleFrequency`/`galeBendAmount` up and down at a live gale and confirm the shader visibly responds with no rebuild; confirm both tree and bush now cast a visible ground shadow.

### 8.3 First live-test round, same day — gale blob, sway gradient, shadow direction

Shadows confirmed fixed. Three new reports, all from one round: _"at gale strength the trees can self intersect... a distorted dissolved blob... trees at the top of the map move a lot with 'sway' but trees near the bottom hardly move at all... we have to be careful to get leaf flutter and sway without them becoming a blender of nonsense at gale strength... the shadow is [] offset up and right, not down and right like the character sheets. Y-flip?"_

**The move that mattered: read the OLD V2 vegetation shader instead of guessing a fix.** V2 (`legacy/compositor-v2/effects/vegetation-bulk-wind.js` + `TreeEffectV2.js`/`BushEffectV2.js`) never dissolved into a blob at gale, so its actual mechanism is evidence, not a fresh guess about what "should" work.

**Gale blob — TWO missing mechanisms, both found in V2:**

1. **Rigidity.** V2's islands are true rigid bodies: `computeVegetationBulkWindOffset` depends only on the island's shared anchor, never an individual vertex's position — every vertex in one island gets the _identical_ offset, so it can only translate as a whole. This project's own per-vertex wind sampling (the Tier-2 fix for lockstep) let a single clump straddle a real spatial gradient in the field, so its own vertices could move differently enough to shear. Fixed: wind for bulk sway is now sampled **once per clump cell, at the cell's own centre** — every vertex sharing a cell reads the identical vector (rigid within a cell), while different cells still differ (lockstep stays fixed). Flutter, being a fragment-stage texture shuffle rather than a geometry displacement, keeps its per-fragment sample — it cannot shear the mesh, only look chaotic in amplitude, which the next two points address.
2. **Damping direction.** V2 actively _damps_ flutter as wind nears gale (`highWindFlutterDamp`, down to ~44% of baseline) while only the rigid bulk term grows — this project's own flutter was doing the reverse (amplitude effectively rising via the gale rate-ratio). Added the same asymmetric damping curve, not as a param — matching V2's own posture that this is a structural backstop, not a creative dial.

**Hard caps, on every displacement channel, none of which existed before.** V2 hard-clamps both bulk-sway and flutter to fixed ceilings and rescales (never distorts direction) if exceeded — literally why V2 never blew up regardless of input. Added the same "never exceed" idiom (already used elsewhere for wall deflection and turbulence energy) at three points: a cap on the raw wind _sample_ before it drives amplitude (`sampleWind`'s own docs warn it "is no longer bounded... once bakedField/liveField contribute"), a cap on the _final_ bend+oscillate world-px vector (several sliders maxed simultaneously), and a cap on the final flutter UV vector — matching V2's own proven number almost exactly.

**Top-vs-bottom sway gradient — the root-pinned/tip-swaying height weight (`vTop`) had no business existing.** Grepped V2's shader repo-wide: no per-image-height weighting exists anywhere. V2 doesn't need one, because a rigid island already moves as one piece; its only per-fragment weight is alpha-coverage-based, not image-position-based. This project's `vTop` used the texture's own v-coordinate as a root/tip proxy — meaningful for a single-plant sprite (Case 1) but meaningless for a large scene-wide painted mask (Case 2, the common case), where it was making whatever happened to sit near the mask's own v=0 row sway fully and v=1 barely, independent of wind. **Removed entirely, both cases** — matches V2, simpler than inventing a Case-1-only exception V2 itself never needed.

**Scene-edge-fade — a new feature, built to spec.** Mirrors V2's own `vegetationSceneEdgeFade` (smoothstep on normalised distance-to-nearest-edge, from the real scene rect), applied to both bulk sway and flutter. One improvement over V2: the new `edgeFadeWidthPx` param (world px, live) is normalised per axis in-shader, so an authored width is the same physical distance on both axes even for a non-square scene — V2's single combined normalised width doesn't have that property.

**Shadow direction — traced rigorously; found no code bug, changed nothing.** `shadowOffsetDirection` is the same function both UI-shadow (confirmed correct) and vegetation call, applied identically as a plain additive translation in the same "+Y down" world space (confirmed from `dimensions`'s own JSDoc). At the current hardcoded default (noon, azimuth 180° south), the shadow should point exactly straight up with zero horizontal lean — a real "and right" component isn't explained by that default at all, so this is most likely a leftover `setSunHour` debug-lever override from earlier testing (afternoon-ish hours produce exactly this direction, correctly). Character-sheet shadows use a different, intentionally-unrelated fixed light — the two were never meant to match. Diagnostic, not yet run: `MapShine.setSunHour(null)` then look again at true noon — should be dead vertical.

⚠ **This whole round is verify-green only, not live-tested yet.**

---

## 9. TRAPS (named now)

- **Y-flip at the mask→world seam.** A brand-new mapping, and this project's most reliably recurring bug class. The anchor system's flip already differs from legacy's. Verify against a deliberately asymmetric test mask before trusting anything.
- **Per-fragment wind.** §7. The convenient wrong thing.
- **`BufferAttribute` has no `dispose()`.** Per-island attribute arrays must be reused with `needsUpdate`, grown only on overflow.
- **Two kinds drifting apart.** The whole point of §2. If `TREE_TUNING` and `BUSH_TUNING` ever grow behaviour rather than numbers, the merge has failed — that is the V2 disease relapsing.
- **Clump labelling across page seams.** Islands that straddle two 248² pages must merge, or a big tree becomes two half-trees swaying out of phase. Union-find over page-edge runs; test it with an island deliberately placed on a seam.
- **A mask that is opaque RGB with no real alpha.** V2 carried a whole `deriveAlpha` path for author-supplied masks lacking transparency. Decide the policy explicitly — derive, or fail loud per the required-mask doctrine — rather than inheriting V2's silent guess.

---

## 10. BUILD ORDER (declaration-first, and wind first)

1. ~~**`world/wind-access.js` + the `wind/handle-only` wall + the node↔kernel parity test**~~ — **DONE (2026-07-23, verify-green, not yet live-tested).** All six existing consumers migrated; see `Wind.md` §5.1. Vegetation therefore starts by _taking a handle_, not by becoming hand-wired consumer number seven.
2. **Per-page clump extraction** in the decode worker, Node-tested against synthetic page fixtures (including the seam case) before any GPU work.
3. **`effects/vegetation.js`** — manifest + params schema. Data, testable immediately, no renderer.
4. **Tier 0** — static canopy. Live-verify V2-authored masks appear at authored resolution.
5. **Tier 1** — clump sway on `handle.node()`. **Live-verify the courtyard-vs-open-field difference**, because that single observation is the proof the whole design is worth having.
6. Measure in the perf lab (§7). Then Tiers 2–3.

**The velocity test governs this** (`Skeleton.md` law 2): adding `_Grass` after this lands must be _one catalog line and one tuning preset_. If it is anything more, the merge in §2 was cosmetic and V2's shape has quietly reassembled itself.

---

_V2 gave vegetation 10,380 lines and one global number for wind, so a tree in a sealed courtyard swayed like one on an open moor and eight response curves per effect existed to hide it. V3 already has a wind field that knows about walls, doors, openness and gusts — so the better `_Tree` and `_Bush` are mostly a matter of asking it, once per plant, at the place the plant stands, through a handle nobody can assemble wrongly._
