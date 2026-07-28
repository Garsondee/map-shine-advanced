# FLUID — goo in glass tubes, the pure-TSL/WebGPU design, tiers 0–8

**Status:** DESIGN SPEC, 2026-07-26. **PHASES 1–4 BUILT AND AUTHOR-CONFIRMED LIVE** (2026-07-27: "I can see fluid moving around in the pipes"). `src/effects/fluid/`: declaration, tube-net extractor, pack builder, TWO TSL surface materials (the full two-blend split), surface subsystem, registration; wired through `boot.js` + `vt-pan-viewer.js` with a **Fluid** card + a **Fluid** diagnostic report in the workshop panel, and `MapShine.setFluid`. **Tiers 0–3, both halves of the two-blend split, LIVE.**
**Phase 5 — tier `fill`, THE SIM — BUILT AND AUTHOR-CONFIRMED LIVE, 2026-07-27.** A genuine semi-Lagrangian transport (`fluid-sim.js`), a per-tube pump with its own personality (`fluid-pump.js`), and a per-item ping-pong pair wired end to end through `fluid-surface-subsystem.js#prepareSimTick` + `vt-pan-viewer.js#tickFluidSim`. This SUPERSEDES the analytic PRESCRIBE scroll tier `flow` shipped with — `fluid-render.js` now reads the sim's own state as a dependent read, never the old `fract()` window. **First live report was "no longer visible" — a pacing bug, not a wiring bug (§11.3):** `FLUID_PUMP_BASE_Q` was calibrated against small synthetic test tubes; the author's real tube (7,048px long, 147px radius) computed to OVER 600 SECONDS to visibly cross at that constant alone. Fixed with `computeFluidLengthQScale` — a per-tube multiplier targeting constant traversal time regardless of tube size, proven on the real sim (a 300px and a 7,048px tube now both fill in ≈9s). Author then confirmed: _"It works again. Visible fluid moving around."_ Tiers 0–3 AND tier `fill` are now both LIVE.
**Phase 6 — tier `structure`, THE MATERIAL COORDINATE τ — BUILT (unverified), 2026-07-27, same day.** ONE `mx_fractal_noise_vec3` fetch (`fluid-render.js`) at `(τ, across)`, reading two channels as marbling (tint) and grain (brightness) — the SAME vendored MaterialX noise node water/wind/specular already use (Law 8: no hand-rolled hash). `τ = s − v̄·t`, a per-tube SPATIALLY CONSTANT time shift (never per-pixel — the safe half of `water-field.js`'s own "never multiply a per-pixel direction by unbounded time" trap), with `v̄` reusing `computeFluidLengthQScale`'s own calibration so τ's drift rate matches how fast the fill actually moves, live-scaled by the same `flowSpeed` control. Reclassified to **C5** from the design sketch's original C2 guess — `cost.class` in this manifest is the CEILING a rung runs within (tier 3 `film`, pure ALU, is ALREADY C4 for the identical reason), and `structure` reads `s`/`tinted` from tiers already at C4/C5; its own marginal cost stays genuinely cheap (`estMsPerMp: 0.02`). **Not yet seen by the author** — built and Node-verified the same day tier `fill` was confirmed live, but that confirmation covered `fill` only, not this. Still unbuilt: bubbles, optics, emission-as-light and spray.
**Shipped invisible twice before this** (wrong-kind-of-host lookup, both fixed 2026-07-27) — see §11 for the full ledger and the two live bugs each round caught before they reached a browser, plus §11.2 for four MORE caught while wiring the sim in.
**Pass:** `sims.fluids` (seam today — `src/effects/water/water-pass.js#buildFluidSimPass`), plus a tier-0 drawable in `geometry.world` and a `surface.fluid` pass that stays a seam until tier 6.
**Effect id:** `fluid`. **Mask kind:** `fluid` — declared in `scene/mask-catalog.js` as of Phase 1. The suffix literal lives there and only there (`masks/authority-only`, which caught this doc's own first draft putting it in a manifest string).
**The brief, verbatim (author, 2026-07-26):** _"fluid moving around in thin glass tubes seen from above moving along a gradient defined by the `_Fluid` mask… a fun, bubbly 'magic or strange science' goo that moves around as the players watch. It's never integral to the gameplay, just a decoration so it doesn't need to remember what it was doing or be exactly the same for all users."_
**Prerequisite reading:** `Effects.md` (the 8 laws), `Water.md` (§5.3 compute-vs-fragment, §8 the walls — both apply here unchanged), `Effects-API.md`, `Effects-UI.md` §3.1. Memory: `feedback_sdf_does_not_draw_the_edge`, `feedback_blend_neutral_element_is_per_blend`, `feedback_mode_forks_silently_drop_features`, `keyhole-water-tsl-design` (the six locked corrections — four of them apply verbatim).

---

## 0. The one sentence

> **A tube network is a one-dimensional graph embedded in two dimensions. The embedding is painted art and never changes — bake it once. The transport is one-dimensional — simulate it in a texture the size of a postage stamp.**

V2 simulated nothing and drew a scrolling stripe pattern in a painted scalar field. Everything it could not do traces to that one choice. Everything the redesign can do traces to replacing it — and the replacement is **cheaper**, because a 512×64 sim grid is 0.03 megapixels against a 2 megapixel screen.

**The corollary:** the interesting question in the brief — _"what would WebGPU and ping-pong shaders get us?"_ — has an asymmetric answer, and the honest half is the deflating one. **Ping-pong gets us nearly everything. WebGPU gets us almost nothing here, and reaching for it would violate Law 8.** §4 argues both halves.

---

## 1. What V2 actually was, measured

`legacy/compositor-v2/effects/FluidEffectV2.js`, 1,305 lines. One file, no family.

| Measure                         | Value                        |
| ------------------------------- | ---------------------------- |
| GLSL `uniform` declarations     | **73**                       |
| JS uniform slots                | 73 (they match — no orphans) |
| `params` keys / schema controls | 62 / 61                      |
| Fragment shader                 | 475 lines                    |
| `main()`                        | **277 lines**                |
| Provably dead uniforms          | **0**                        |

**Credit where it is due, because it changes the tone of this audit:** unlike water (§2.2 of `Water.md`: 46 inert uniforms, a fully-labelled folder with zero implementing GLSL, five debug views rendering the wrong thing), the Fluid effect is _honest_. Every uniform it declares, it reads. Every control does something. It is a small, coherent, well-behaved shader. **It is not a mess — it is a ceiling.** The redesign is not a cleanup; it is a change of algorithm, and V2's own defaults are the evidence for why (§3).

### What it computes

1. **The mask read.** `coverage = a · luma(rgb)`, `age = 1 − (g + b)/2`. The author paints the tube's shape and a brightness ramp along it; `age ∈ [0,1]` is the position along the tube, bright = young.
2. **Flow direction** from a **two-tap finite difference of `age` at a fixed ±12-texel offset**, normalised. `isFlowing = smoothstep(0.01, 0.04, |∇age|)` gates everything where the ramp is flat.
3. **Slugs.** `rawPhase = age·slugCount − t·speed`; `slugPhase = fract(rawPhase)`; a slug is the window `[leadBound, trailBound]` in phase space, with `fwidth`-adaptive smoothstep edges and fbm-jittered bounds. Two full evaluations per pixel — once to derive a churn mask, once again after warping the phase by it.
4. **Endpoint pools.** Near `age≈0` and `age≈1`, `slugAlpha` is forced to 1 so the ends read as reservoirs.
5. **Decoration**, each an independent noise field: bubbles (a 3×3 cell loop with per-cell birth phase), foam (lead / trail / edge, three separate fbm evaluations), caustics (fbm ridge), iridescence (**13 parameters**, fbm thickness → per-channel `sin` phase), churn (fbm UV warp gated to slug boundaries), HDR boost (emissive push for bloom), RGB shift (chromatic fringing by resampling the mask twice more).
6. **Placement.** A `PlaneGeometry` per tile, `NormalBlending`, `depthWrite: false`, drawn **beneath the tile's own albedo** — `FLUID_Z_OFFSET = −0.05`, `renderOrder = baseOrder − 0.01`. The code says why, and it matters (§5.5): _"Do not use `tileStackedOverlayOrder` here; that would paint fluid after albedo and change the authored 'under the texture' look."_

---

## 2. The limitations, each with its general lesson

1. **It is stateless. Every frame is a pure function of `(age, time)`.** No history, therefore no causality, therefore no surprise. Slugs are perfectly periodic, identically spaced, identically sized, marching in lockstep forever. They cannot merge, split, stretch, stall, accelerate, or arrive. **Lesson:** a decoration whose whole job is _"interesting to watch"_ cannot be a pure function of time — a pure function of time is, by definition, something you have already seen.
2. **Nothing is conserved, because nothing is transported.** Fluid is _drawn_, not _moved_. So the tube cannot fill, cannot drain, cannot run dry, cannot back up. The endpoint "pools" are `slugAlpha = 1` — a fade, not a fill. **Lesson:** the difference between "animated" and "alive" is a conservation law. It is also the cheapest one to add.
3. **The mask's channels are entangled.** `coverage = a·luma(rgb)` and `age = 1−(g+b)/2` read the _same_ bytes. A greyscale ramp painted to black at the far end reads as **maximum age _and_ zero coverage simultaneously** — the tube fades out exactly where the fluid is oldest, and the author's only cure is to never paint the ramp dark, which silently costs them half their dynamic range. **Lesson:** presence and parameterisation must live in different channels, or the author is tuning two things with one brush. Fixed by construction in §5.1.
4. **Flow direction is a two-tap finite difference at a fixed 12-texel offset.** Resolution-dependent (the same tube at two mask resolutions flows at two different qualities), noisy on a compressed mask, undefined where the ramp is flat, and meaningless at a junction. **Lesson:** already learned twice on this project — `Water.md` §5.1 correction 3 (_"the gradient is analytic"_) and `feedback_sdf_does_not_draw_the_edge`. Do not difference a texture to find a direction that geometry already knows.
5. **Speed is uniform in `age`-space, not world-space.** A slug crosses a painted ramp at constant `d(age)/dt`, so its speed in pixels/second is whatever the author's brush pressure happened to be. A narrow tube does not speed up; a wide one does not slow down. **Lesson:** real fluid obeys `v = Q/A`. That is one divide, and it needs the cross-sectional area — which nothing in V2 knows.
6. **Everything is a function of `age` alone.** The tube is 2-D but the shader is 1-D, so nothing varies _across_ the tube: no path-length darkening in the middle, no bright rim at the glass, no bubble riding one wall, no meniscus curvature. `meniscusStrength` was V2's attempt, and it is `pow(1 − smoothstep(0, 0.15, mask), 8)` — **a function of distance to the wall, used to draw a feature that lives at the slug FRONT.** Wrong axis entirely. It defaults to 0.
7. **Decoration does not ride with the fluid.** Bubbles live in screen-space cell noise with a bolted-on drift (`globalDrift = flowDir · t · 0.15`); foam and caustics are evaluated at the _static_ UV. So the fluid moves and its contents do not. **Lesson:** this is the single reason the bubbles read as noise, and §5.4's material coordinate is the whole fix.
8. **No topology.** Twelve separate tubes on a map are one scalar field to this shader: one clock, one phase, one speed. Junctions, branches, valves, reservoirs and separate circuits are all invisible. **Lesson:** connected components are free and buy twelve independent personalities.
9. **`discard` on `mask <= 0.001`, plus a hash-jittered mask sample and `fwidth`-adaptive softness.** Three separate band-aids for the absence of a distance field. `discard` also costs early-Z, and this project has a named bug class where `discard()` was a silent no-op (`keyhole-region-discard-noop-bug`).
10. **One `ShaderMaterial` per tile, 73 uniforms written per material per frame**, with a per-tile `PlaneGeometry` and a per-tile mask texture load. The V2 disease, mild but present.

---

## 3. What the defaults confess — the most useful thing in the file

The shipped defaults are the author's own verdict on their own features, and they are unusually clear.

| Turned OFF at default                                                                                                                               | Turned UP at default                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noiseStrength` 0 · `bubbleStrength` 0 · `edgeNoiseAmp` 0 · `meniscusStrength` 0 · `foamStrength` 0 · `causticEnabled` false · `churnEnabled` false | `iridescenceStrength` **3.0 — pinned at the top of its own slider range** · `rgbShift` 3.45 · `hdrBoostEnabled` true at **3.75/5** · `iriSaturation` 1.52/2 |

And: **`colorA` and `colorB` are both `#ffffff`.** The entire five-control "Appearance" group — two colour pickers, an age gamma, the young/old lerp — is **inert in the shipped configuration**. The base colour is white. All colour comes from `computeIridescence`, an _advanced_ folder the author had to go looking for.

Trace it: `baseColor = white`, `depthFactor = 1`, `surfDetail = 1`, bubbles/meniscus/caustics 0. Then
`col = mix(col, col·iri·2, iridescenceStrength·0.5)` — with `iridescenceStrength` at 3.0 that interpolant is **1.5**, so the `mix` _extrapolates past its own endpoint_. Then RGB shift fringes the tube walls, then HDR boost blows it into bloom.

> **The shipped look is: white slugs, an over-extrapolated oil-slick rainbow, chromatic fringing at the glass, blown out into bloom, seen through the map art from underneath.** That is the "magic goo", and it is a good look.

**Three conclusions that drive the whole redesign:**

1. **The author's taste is confirmed and must be preserved.** Iridescence + emission + slugs is the product. Rungs 1–2 of the new ladder reproduce it at cost class C1.
2. **Eight of twelve decoration families were tried and switched off, and they all share one property: they are noise fields that do not move with the fluid.** They failed for the same reason, once. §5.4 fixes all eight with one channel.
3. **A slider pinned at the top of its range is a design finding.** The author ran out of iridescence and had nowhere to go. The redesign re-derives iridescence from real optical thickness (§5.5), which both looks better and gives the knob somewhere to go.

---

## 4. The question, answered: what ping-pong buys, and what WebGPU does not

### 4.1 Ping-pong (state) — this is the whole win

State turns a _drawing_ into a _system_. Concretely, and each of these is impossible without it:

| Capability                                                                                                      | Why state is required                                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Slugs with identity** — they stretch in wide sections, compress in narrow ones, catch up, merge, and separate | position is integrated, not evaluated                         |
| **The tube fills and drains**                                                                                   | φ is conserved; a bulb accumulates what arrives               |
| **Continuity: `v = Q/A`** — the goo genuinely speeds up through a constriction                                  | flux is a state variable                                      |
| **Dye that mixes and marbles**                                                                                  | composition is advected and keeps a record of its own history |
| **Gas that collects, rises, and burps**                                                                         | bubbles accumulate where the pressure drops                   |
| **Reaction to the world** — a token walks past, a door slams, a GM triggers it                                  | an impulse must persist beyond the frame it was applied in    |
| **It never repeats**                                                                                            | the state wanders through a space it will not revisit (§6)    |

**The cost is astonishing in the right direction.** The state is `512 × 64` RGBA16F = **0.03 megapixels, 256 KB**, ticked once per frame. A single 1080p fullscreen pass is 2 megapixels. **The sim is 1.6% of one fullscreen pass, and it is constant — independent of zoom, map size, and tube count.** Effects.md's cost class C7 ("per-frame sim that ticks whether or not it is seen") is written for grids that cost real money. A 1-D sim is not that, and §7's ladder handles the classification honestly rather than mis-classing a rung upward (which Law 3 explicitly calls malformed).

### 4.2 WebGPU specifically — the deflating half

**Nothing in this design requires WebGPU, and nothing should.**

- `Water.md` §5.3 already decided this and the reasoning transfers unchanged: `textureStore` / `StorageTexture` is **WebGPU-only**, Law 8 forbids a hand-written twin, and coupling "fancy" to "has WebGPU" hands the weakest hardware the most expensive path (Law 5 — WebGPU availability tracks browser recency, not GPU power).
- Compute's real advantage is workgroup shared memory at 1024²+. Our domain is 512×64. There is nothing to share.
- Render targets have **one legal door with lifetime ownership** (`graph/three-allocator.js`, `gpu/allocator-only`). Storage textures have none. Adding one would mean weakening `gpu/textures-in-vt-only` to buy nothing measurable.
- Storage buffers are not free either: `keyhole-storage-buffer-limit-fix` records a live crash from exceeding WebGPU's 8-per-stage cap.

**Where compute genuinely wins, it is already built and already backend-neutral:** tier 8's spray/vapour particles go through the **one** particle engine (`effects/particles/`, `renderer.compute()`, proven on both backends by `diag/compute-spike.js`).

So the answer to the brief's question, stated plainly: **the transformation is ping-pong, and ping-pong is a fragment pass on two allocator-owned render targets that runs identically on WebGL2 and WebGPU.** A compute implementation of the 1-D solver is a `deferredRung` gated on a measurement, not a preference.

---

## 5. THE DESIGN — bake the embedding, simulate the line

### 5.0 The three-source rule, inherited

`feedback_sdf_does_not_draw_the_edge` cost four rounds on water. Its resolution is the load-bearing principle here too, so it is stated up front:

| What                                                                 | From where                                                                       | Why                                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **The silhouette** — where the tube's edge is, exactly               | the **mask file at its authored resolution** (`vt/mask-image.js`)                | only the source art has sub-texel edge information; no derived grid ever gains it                                 |
| **Topology + arc length + profiles** — everything the tube net knows | the **CPU extractor, on the mask file's pixels**, capped at `FLUID_PACK_MAX_DIM` | see correction #2 — this row said "the coarse mask grid" and that was wrong                                       |
| **Distance to the wall** (`across`)                                  | a chamfer transform in the **same CPU pass**, not a GPU flood                    | see correction #3 — three of the pack's four channels are CPU-only, so a GPU pass for the fourth is pure overhead |

Each source does only what it is good at. Mixing them is the bug class.

> ⚠️ **CORRECTION #2 (Phase 2, 2026-07-26) — TOPOLOGY IS NOT A LOW-FREQUENCY QUANTITY, and the row above originally claimed it was.**
>
> The original table sent arc length, profiles **and topology** to the CPU extractor "on the coarse mask grid", on the reasoning that they are integrals and a coarse grid is enough for an integral. That is true of the integrals and **false of the topology**, which is the highest-frequency question in the whole effect: _are these two tubes the same tube?_
>
> The numbers make it unarguable. `MASK_GRID_MAX_DIM` is **512** on the long side, so on a 10,650 px map a derived-grid texel is **~21 world px**. A thin glass tube — the entire subject of this effect — is perhaps 30–50 world px wide, i.e. **1–2 texels**. At that resolution two tubes running parallel a tube's width apart **merge into one component**, and once merged there is no downstream fix: they get one arc length, one pump, one flow direction, forever. The radius and cross-section profiles are quantised to ±50% on top.
>
> So the extractor reads the **mask file's own pixels**, capped at the pack's resolution (1,536 long side → ~6.9 world px/texel → a 40 px tube is ~6 texels across). Measured on a twelve-tube fixture at that size: **365 ms, all twelve separated, orientation correct**, which is a once-per-mask-version cost that never touches the frame budget. The extractor itself needed **no change** — it already takes a `{spec, data}` grid and does not care where the grid came from, which is the interface being right for the reason interfaces are supposed to be right.
>
> The general lesson, and it is the same one twice now: `feedback_sdf_does_not_draw_the_edge` says _silhouette from source art, distance from the field_. This adds **_separation_ from source art too** — anything that answers "are these one thing or two" belongs with the silhouette, not with the integrals.

> ⚠️ **CORRECTION #3 (Phase 2, 2026-07-26) — THE PACK IS ASSEMBLED ON THE CPU AND UPLOADED. There is no GPU jump flood.**
>
> §5.2 stage B originally specified "three fragment passes, the JFA machinery `water-body.js` already proved". Building it exposed why that is the wrong shape **here**, and the reason is specific rather than a general preference for CPU work:
>
> **Three of the pack's four channels can only come from the CPU.** Arc length needs a geodesic (an iterative constrained wavefront — not what a JFA computes), tube id needs connected components, and the radius profile needs per-component binning. Those are already computed, already walk every tube texel three times, and already produce a distance transform as a by-product. A GPU flood would recompute _one_ channel that the CPU pass already has, into a _separate_ target, which then has to be combined with a CPU-uploaded texture anyway. That is strictly more machinery — render targets, allocator lifetimes, ping-pong, the `renderer-state/graph-only` callback dance — for no output that differs visibly.
>
> Water's flood is on the GPU for a reason that does not apply: its SDF spans the whole scene rect and nothing on the CPU wanted it. Fluid's tubes are **sparse**, and the CPU is already there.
>
> What this buys: the entire bake becomes a pure function plus one texture upload, so **all of it is Node-testable** — no browser report needed to know the pack is right. What it costs: chamfer is ~2% approximate against a flood's exactness, which is invisible under a `√(1−across²)` shading term, and the bake is ~365 ms of main-thread JS once per mask version rather than ~0 on the GPU.
>
> **Recorded, not built:** a _feature-transform_ chamfer (propagating the offset to the nearest wall texel alongside the distance, exactly as a JFA does) would give the **sign** of `across` and an analytic tube normal for free. Tier 5's bubbles are the first rung that needs the sign — see §5.2's channel table, which ships `across` **unsigned** until then.

### 5.1 The mask — `fluid` / `_Fluid`

One line lands in `scene/mask-catalog.js` (the literal is already reserved; the wall fails the build otherwise). RGBA, `absentValue: 0`, `rasterize: true` (the CPU extractor is the consumer that makes `rasterize` true, exactly as water's GPU bake was).

| Ch    | Meaning                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| **R** | **PRESENCE by THRESHOLD** (`R > ε` is tube interior) **and, by VALUE, the flow HINT** — the brightest end is `s = 0`. |
| —     | Nothing else is read. G, B and A are ignored entirely.                                                                |

> ⚠️ **CORRECTION #1, made while building Phase 1 (2026-07-26). This section originally put presence in ALPHA and the hint in RGB. That is wrong for two independent reasons and the replacement is better.**
>
> **Why the split was unbuildable as written:** `scene/mask-catalog.js#extractionPlanForLayer` serves **exactly one channel per unpacked kind, hardcoded to `r`**. Its own doc anticipates the case (_"a kind that genuinely needed a second channel on the CPU would extend this plan to return two entries"_) — but doing so for one effect means a second `contentId`, a second grid through `mask-derive`, and a second `getDerived` key, i.e. changing shared machinery that four other kinds already use correctly. That is a large bill for an authoring nicety.
>
> **Why sharing R is actually right, not a compromise:** the `water` kind already ships this exact pattern (`R > 0` is water; R also carries depth), so this is one pattern in the codebase rather than two. And crucially — **V2's bug was the MULTIPLY, not the sharing.** `coverage = a · luma(rgb)` makes a dim ramp _partially present_, so the tube visibly fades out toward its dark end. `presence = R > ε` is a **threshold**: any nonzero R is fully present, and the tube does not fade. §2.3 is still fixed, by the change that actually mattered.
>
> ⚠️ **The residual risk is `feedback_one_byte_two_quantities`, and it is real: at an ANTIALIASED TUBE EDGE the byte genuinely is `coverage × rampValue`.** That memory's test — _"when a value is stored as A × B, ask which one a consumer actually needs"_ — bites precisely at the boundary texels, which is exactly where the naive orientation check (compare the hint at the two endpoints) would read. **Mitigation, and it is not optional:** the orientation is never decided from endpoint texels. It is decided by **correlating the hint against the geodesic distance over INTERIOR texels only** (texels whose eight neighbours are all present, so coverage is 1 and the byte is pure ramp). That uses every good sample instead of two suspect ones, is robust to a non-monotone paint job, and yields a **confidence** the extractor reports — so "this tube's hint was unusable" is a readout, never a silent guess.
>
> **The one authoring constraint this creates:** do not paint the ramp down to pure black, because 0 reads as "not tube". Painting `1/255 → 255/255` is fine and gives the full range. This is a far weaker constraint than V2's (where painting dark cost coverage continuously), and it is stated in the kind's own `meaning`.

**Existing V2-authored maps keep working, and keep flowing the same direction.** V2's `age = 1 − (g+b)/2` with `fract(age·N − t)` runs bright→dark; `s = 0` at the bright end runs bright→dark too.

**The hint is a hint, not a parameterisation — and this is the anti-fork decision.** The obvious design is _"use the painted ramp if it looks usable, otherwise derive the geometry."_ That is a mode fork, and `feedback_mode_forks_silently_drop_features` records it going wrong **three times**, resolved each time by deleting the losing fork. So:

> **There is ONE path. `s` is ALWAYS the derived geodesic. The painted RGB supplies exactly one bit per tube: which end is the root.** If RGB is flat, the extractor orders the component's two extremes by world position — stable, arbitrary, and fine (the brief grants that clients need not agree).

The author's brush now controls the thing they actually cared about (which way it flows) and the geometry supplies everything they were painting _badly by hand_ (arc length, and therefore speed uniformity).

### 5.2 The tube net — `res:tubeNet`, baked on mask-version change

**Stage A — the CPU extractor** (`fluid-net.js`, pure, Node-tested, runs on the **mask file's own pixels** downsampled to the pack's resolution — see correction #2; the original "coarse rasterised grid" would merge adjacent tubes):

1. **Connected components** → `tubeId` per texel, and the tube count. _Twelve tubes become twelve independent systems for free._
2. **Endpoints and junctions** → the tube **graph**: nodes (degree 1 = open end, degree ≥3 = junction), edges, lengths.
3. **Geodesic distance from the root**, constrained to the mask (a BFS / fast-marching wavefront — trivial in JS on a coarse grid) → `s ∈ [0,1]` per texel and total length `L_px` per tube. _This is the thing V2 asked the author to paint and then differenced badly._
4. **The 1-D profile**, binned by `s`: cross-sectional **area `A(s)`**, **radius `R(s)`**, and a node marker.

`A(s)` is the quiet hero. It gives continuity (`v = Q/A`, §4.1) — and it means **a painted flask or bulb at the end of a tube is not a special case: it is a bin with a large area.** Conservation then makes it fill and drain correctly with no reservoir code at all.

**Stage B — the pack** (`fluid-pack.js`, pure, Node-tested): the extractor's per-texel outputs written into one interleaved RGBA buffer and uploaded as a single world-aligned RGBA16F texture — **no GPU passes at all**, see correction #3.

| Ch    | Contents                                                                             |
| ----- | ------------------------------------------------------------------------------------ |
| **R** | `s` — arc length along the tube, 0..1                                                |
| **G** | `across` — **UNSIGNED** distance from the centreline, 0 at the centre, 1 at the wall |
| **B** | `tubeId` (integer-valued; fp16 is exact to 2048, and the cap is 64)                  |
| **A** | `radiusPx` — local tube half-width, world px                                         |

⚠️ **`across` is unsigned, deliberately.** Every tier-0-to-4 consumer of it is even in `w`: the optical path length is `√(1−across²)`, and the wall rim is a band near `across → 1`. Neither needs to know _which_ wall. The sign requires the **offset** to the nearest wall texel, which a jump flood stores and a chamfer transform does not — so shipping a signed channel now would mean either fabricating a sign or building the feature-transform variant four rungs before anything reads it. Tier 5 (bubbles pinning to the upper wall) is the first real consumer; when it lands, the channel widens to −1..1 and every existing consumer that uses `abs()` is unaffected by construction.

Baked **on mask version change, never per frame** (`water-body-subsystem.js` is the template, and `feedback_residency_sync_vs_render_loop` is the trap: the version poll belongs in the frame loop, never inside a residency-triggered function — the pack reports its bake count and a bake count that tracks the frame count is the visible failure).

### 5.3 The state — `res:tubeFlow`, 512 × T, ping-ponged

Two RGBA16F targets, `S=512` samples × `T` tubes (T rounded up, capped at 64). **256 KB each.**

| Ch    | Contents                                                              |
| ----- | --------------------------------------------------------------------- |
| **R** | **φ** — fill fraction 0..1. A slug is a run of φ≈1; a gap is φ≈0.     |
| **G** | **c** — dye / composition. Passively advected; two injections marble. |
| **B** | **g** — gas fraction. Buoyant, collects, drives bubbles.              |
| **A** | **τ** — the **material coordinate** (§5.4).                           |

Static companion `res:tubeProfile` (`S × T`, baked with the net, never ping-ponged): `A(s)`, `R(s)`, curvature, node marker.

**The pass has two modes and they are a PASS concern, not a tier concern:**

- **PRESCRIBE** — one line: `φ = window(fract(s·N − v̄t))`. This is V2's slug pattern, written into the same target.
- **TRANSPORT** — semi-Lagrangian advection of `(φ, c, g, τ)` along `v(s,t) = Q_tube(t)/A(s)`, with the profile's `A` supplying continuity and the endpoint bins acting as reservoirs.

Everything downstream reads the same texture the same way. **The surface shader has exactly one path** — which is why the mode lives here and not in the ladder. This is the same shape as `res:waterBody`: a target whose _content_ changes and whose _identity_ never does (`wind-sim-gpu.js#buildWindPublishMaterial` documents the pattern and why it matters when a ping-pong texture's identity flips every tick).

**The pump** (`fluid-pump.js`, pure, Node-tested) produces `Q_tube(t)` — one float per tube per frame, ≤64 numbers, computed on the CPU and uploaded as a `1 × T` strip:

```
Q(t) = base
     + Σ aᵢ·sin(2π·fᵢ·t + φᵢ)     // frequencies in irrational ratio — never repeats
     + slowNoise(t)                 // drift
     + gulps(t)                     // Poisson surges
     + impulses                     // tokens, doors, GM macros, day clock
```

**The personality of the entire effect is 64 floats, computed in JS, unit-testable, and driveable from a Foundry hook.** That is deliberate: it is the one place a future session should reach to make the goo behave differently, and it costs nothing to reach there.

### 5.4 The material coordinate τ — the cheapest big win in the design

`τ` is initialised to `s` and **advected with the fluid**. So `τ(s,t)` answers _"where did this parcel start?"_ — and **any procedural pattern evaluated at `τ` instead of `s` rides with the fluid exactly**, including stretching where the flow accelerates and bunching where it compresses.

That is the single fix for every one of V2's eight abandoned decorations (§3, conclusion 2). Bubbles, striations, marbling, grain and foam all become `noise(τ, w)` — one channel, no extra maths, and they now move _with_ the goo instead of past it. V2's `globalDrift = flowDir · t · 0.15` was reaching for this and could not get there without state.

Unbounded stretching is the known failure mode; the known fix is **two out-of-phase copies cross-faded**, which `Water.md` §5.2 already names for the same reason ("two-phase ping-pong to hide the reset seam"). Same trick, same justification.

At tier 3 (before the sim reads land) `τ` has an analytic form, `τ = s − v̄·t`, so the rung works with no state at all.

### 5.5 Rendering — what makes it read as a GLASS TUBE from above

Per fragment: one pack read → `(s, w, tubeId, R_px)`; one tiny dependent read → `(φ, c, g, τ)`. Then:

1. **The cylinder.** Seen from directly above, a round tube's optical path length through the liquid is `∝ √(1 − w²)` — **maximum at the centreline, zero at the walls.** So the goo is _darker and more saturated down the middle of the tube and pales toward the glass_, which is exactly what a real capillary looks like and which V2 had no way to express. Beer–Lambert over that thickness is the same `exp(−σd)` water tier 1 already ships. **Pure ALU, and it is the single largest "these are tubes, not painted lines" cue in the design.**
2. **The wall rim.** A thin bright band at `|w| → 1` (the glass edge / total internal reflection). One `smoothstep`.
3. **The meniscus — on the RIGHT AXIS this time.** A meniscus lives at the _slug front_, where `∂φ/∂s` is large, not at the wall. In a thin tube it is a curved lens: a bright core with a dark rim. Drive it from `∂φ/∂s` (one extra tap into a 256 KB texture). This is §2.6 fixed.
4. **Iridescence, re-derived rather than re-tuned.** Thin-film interference is a function of _optical thickness_, and we now have a real one: `T = √(1−w²) · φ · c`. So `hue = f(T)`, which means **the rainbow bands across the tube's cross-section and shifts at every slug front automatically**, coherent with the geometry instead of an unrelated fbm. **13 parameters collapse to 3** (strength, spectral spread, saturation), and the strength knob gets somewhere to go (§3, conclusion 3).
5. **Bubbles as objects.** Ellipses in `(τ, w)`: they ride with the flow, bunch at constrictions, pin to the upper wall, and pop at a free surface. Sized by `R_px` so they are physically plausible in a narrow tube.
6. **Emission → the real bloom pass.** V2's `hdrBoost` hand-rolled its emissive push because it had no bloom to feed. `post.bloom` is live and author-confirmed (`keyhole-bloom-built`). The goo writes HDR radiance and the graph does the rest.

### 5.6 The blend — a MULTIPLY pass and an ADD pass, never one alpha

**This is `keyhole-water-tsl-design`'s locked correction #5, and it applies here verbatim.** The goo does two physically different things and one `NormalBlending` alpha cannot express both:

- **Absorption** — the goo tints the map art beneath it. That is a **multiply**.
- **Emission, specular, iridescent sheen, bubble highlights** — that is an **add**.

V2 collapsed both into one alpha and compensated by making the base colour white and the emission enormous, which is exactly why it needed `hdrBoostStrength` at 3.75 to be visible at all.

> ⚠️ **`feedback_blend_neutral_element_is_per_blend` is a live trap for this pass.** The transparency contract says every transparent writes `gAttr = vec4(0)` to leave `buf:scene.attr` untouched. **That is only neutral for `NormalBlending`. The identity element of a MULTIPLY blend is WHITE.** Writing `vec4(0)` from the multiply pass would silently zero `scene.attr` under every tube. Named here because this design introduces the first multiply pass that will meet that convention.

**The under-art placement is preserved and it is correct.** V2's comment is explicit that _"under the texture"_ is the authored look, and it is a good deal: the map art carries the glass, the fittings, the labels and the highlights, and the effect supplies what is inside. The multiply pass sits below the tile albedo (V2's `renderOrder − 0.01`); the **add** pass sits _above_ it, because a specular streak on glass is physically on top. Two passes, one material graph, one authored look preserved and improved.

---

## 6. Fun, and why it never repeats — the actual brief

The brief asks for _fun to watch_, which is a real engineering requirement, so it gets a real answer. Seven independent sources of non-repetition, all cheap:

1. **Incommensurate pump frequencies.** Sines at golden-ratio-spaced frequencies never return to the same phase. Free.
2. **Poisson gulps.** Discrete surges at random intervals — the apparatus _does something_ every so often.
3. **Conservation with finite reservoirs.** The system's state wanders; when the source bulb empties the flow stalls, gurgles, and draws gas in. Emergent, not scripted.
4. **Twelve tubes, twelve phases.** The _ensemble_ period is astronomically long even if each tube were periodic. Free from connected components.
5. **Gas accumulation.** Bubbles form where pressure drops, collect at high points, and burp irregularly.
6. **Dye history.** Two injections at different times leave a marbled record that is different every session.
7. **The world.** A token steps near a tube → a pressure pulse. A door slams → a surge. A GM macro injects dye, reverses the pump, or cracks a tube. **The hook surface is `Q_tube` and an impulse queue — ~10 lines of Foundry adapter, and the toy writes itself.**

### The three freedoms the brief grants, and what each one buys

The author explicitly said this need not be deterministic, need not persist, and is never gameplay-integral. That is not a caveat — **it is the license that makes a C7-class feature affordable**:

| Freedom granted                                       | What it buys architecturally                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _"doesn't need to be exactly the same for all users"_ | **No state sync, no shared seed, no netcode.** Each client runs its own sim. This deletes an entire category of work.                                             |
| _"doesn't need to remember what it was doing"_        | **Free reset** on tab hide, floor switch, zoom-out, or tier change. A cold start that fills the tube over three seconds is _charming_, not a bug.                 |
| _"never integral to the gameplay"_                    | **Law 7's coverage/zoom gate can be aggressive.** Stall the sim entirely below a zoom threshold or off-screen; nobody can tell, and there is nothing to catch up. |

State that once, loudly, so a future session does not "helpfully" add persistence and a sync protocol.

---

## 7. THE LADDER

Cost classes per `Effects.md` Law 3. Tier 0's class is the effect's **admission price** — Law 3's monotonicity governs rungs 1..N (`Water.md` §6 records this clarification; it is not re-litigated here).

| Tier  | Name        | Class | Adds                                                                                                                                                                                                                       |
| ----- | ----------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | `placement` | C4    | The `_Fluid` mask, tinted, in the right place on the right floor, drawn under the art. The tube has goo in it. **Never gated.**                                                                                            |
| **1** | `tube`      | C1    | Cross-section from `w`: Beer–Lambert over `√(1−w²)` path length, plus the wall rim. **It stops being a painted line and becomes a glass tube.** Pure ALU on the pack read tier 0 already paid for.                         |
| **2** | `film`      | C1    | Thin-film iridescence driven by that same optical thickness, plus HDR emission into the live `post.bloom`. **This is V2's shipped look (§3), at C1, from reads already paid for.**                                         |
| **3** | `structure` | C2    | One resident tiling noise fetch in the **material coordinate** `τ` (analytic at this rung). Marbling, striation and grain that ride WITH the fluid. First motion; fixes all eight of V2's abandoned decorations at once.   |
| **4** | `fill`      | C4    | The `res:tubeFlow` read: **φ, c, g, τ**. Slugs with identity, the meniscus on the right axis, dye that marbles, bulbs that fill and drain, and `v = Q/A` so the goo speeds up through a constriction.                      |
| **5** | `bubbles`   | C4    | The gas channel rendered as real bubbles in `(τ, w)` — riding, bunching at constrictions, pinning to the upper wall, popping at a free surface. Same fetch, more ALU.                                                      |
| **6** | `optics`    | C5    | Dependent read of `buf:scene.color`: the tube as a **cylindrical lens** magnifying the art beneath, chromatic dispersion on the same offset, bubble lensing. First rung that forces `surface.fluid` to become a real pass. |
| **7** | `emission`  | C6    | The goo becomes a **real light source** — its emission injected so the glow spills onto the floor and the nearby walls. An extra small target and a stage-crossing read into `light.accumulate`.                           |
| **8** | `spray`     | C8    | Particles through the **one** engine: vapour at open ends, drips, condensation running down the glass, spill from a broken tube.                                                                                           |

`C4 → C1 → C1 → C2 → C4 → C4 → C5 → C6 → C8`. Non-decreasing from rung 1. ✅

**Two placements worth defending:**

- **The sim is not a rung.** It is `sims.fluids`, a pass, with Law 7's coverage/zoom gate at the pass level — exactly as `sims.particles` is a live pass whose cadence is not a tier of any effect, and exactly as `res:waterBody`'s bake appears in no ladder. Tier 4 is _"read the state"_, and the state exists whether it was prescribed or transported (§5.3). This keeps the surface shader single-path and keeps a 0.03 MP sim from being mis-classed as C7 — which Law 3 itself calls malformed, because it strands cheap detail above an expensive rung.
- **Tiers 0–3 carry the whole V2 look for essentially nothing**, and they are all C2 or below. Everything the redesign is _for_ sits at tier 4 and above. That asymmetry is Law 3 working, not luck.

**`deferredRungs` — recorded, not built:** junction routing through the tube graph (fluid splitting and merging at a Y); a momentum/flux channel so the column can slosh, surge and oscillate; reaction–diffusion in `c` for precipitates and colour fronts; a compute-shader 1-D solver (gated on a measurement, never a preference); authored flow painting and per-tube presets through the Map Points successor (`Authoring-and-Distribution.md`); ice/crystal/plasma material presets over the same state.

---

## 8. Handles — fluid derives nothing it can be handed

| Fluid needs                 | Handle                                                          | What dies                                                                                                                         |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| time                        | `core/frame-clock.js` `tMs` / `dtSec`                           | V2 read `uTime` from one place — already clean; the wall (`time/one-clock`) keeps it that way                                     |
| the mask                    | `scene/mask-authority.js`, kind `fluid`                         | `probeMaskFile(base, '_Fluid')` and the per-tile `TextureLoader` — `masks/authority-only` forbids the literal outside the catalog |
| bloom                       | `post.bloom` (live)                                             | `hdrBoost*` (5 params) becomes one emission term                                                                                  |
| colour grading              | **nothing.** Fluid writes `buf:scene.color` before `post.grade` | any temptation to pre-compensate — `grade/one-stack`                                                                              |
| floor placement / occlusion | `buf:scene.attr` + painter's-algorithm draw order               | V2's `uDepthTexture`/`uRoofAlphaMap` uniforms, both permanently disabled and dead weight                                          |
| tile opacity                | the drawable's own material state                               | `uTileOpacity` written per-material per-frame                                                                                     |
| lighting response (tier 7)  | `buf:scene.illum`, `light.accumulate`                           | —                                                                                                                                 |
| impulses                    | `foundry/` adapter → the pump's impulse queue                   | —                                                                                                                                 |

**A handle is frozen at construction.** Fluid's mask is **not** required (`absentValue: 0`), so a scene with no tubes is silently correct, not an error.

---

## 9. The walls this port installs

**Already walled — nothing to build:** `time/one-clock`, `no-gpu-readback`, `no-global-bus`, `zones/one-door`, `masks/authority-only`, `tsl/no-uniform-gates`, `grade/one-stack`, `gpu/allocator-only`, `no-silent-catch`, `ui/no-handwritten-controls`, `tsl/no-mix-method`, `params/no-dead-controls`, `effects/uniform-budget`, `particles/one-engine`.

**New — two, both small, both earned by this audit:**

1. **`masks/presence-not-luma`** _(structure rule)_ — a mask consumer may not compute presence from a luma or channel product of the same fetch it reads a parameterisation from. Cures §2.3 (`coverage = a·luma(rgb)` next to `age = 1−(g+b)/2`), which is a general authoring trap and not specific to fluid. The catalog's `meaning` field is where presence is declared; a consumer inventing its own is the disease.
2. **Blend-neutrality assertion in the transparency contract test** — the `gAttr = vec4(0)` convention is asserted today; extend it to check the **blend mode** and require the blend's own identity element (white for multiply). `feedback_blend_neutral_element_is_per_blend` is recorded in memory but has no wall, and §5.6 introduces the first pass that can trip it.

**Design invariants** (no mechanical wall; stated so a reviewer can point at them):
**ONE** parameterisation of `s` — the derived geodesic, always, with the paint supplying only the root end (§5.1). **ONE** state read in the surface shader, whether the state was prescribed or transported (§5.3). **ONE** noise fetch feeding all internal structure, evaluated at `τ` (§5.4) — never a second decoration field in screen space, which is the mistake that killed eight of V2's twelve.

---

## 10. Module layout, graph edits, registration

All inside `CONVENTIONS.md`'s guidance. Bloom's/water's split exactly: **pure-data declaration** (no THREE, Node-validatable), **TSL builders with THREE injected and never imported**, **a thin closure in the viewer**.

```
src/effects/fluid/
  fluid.js                     FLUID_PARAMS + the FLUID manifest — pure data
  fluid-net.js                 CPU extractor: components, geodesic s, A(s)/R(s), profiles
  fluid-pack.js                the RGBA world-aligned pack (s, across, tubeId, radius) — pure
  fluid-pump.js                Q(t)/inject(t) per tube, deterministic from a hash — pure
  fluid-sim.js                 the CPU twin (advectTubeStep) + its TSL transcription, THREE injected
  fluid-render.js              TSL builders: the two-blend surface material, THREE injected
  fluid-surface-subsystem.js   owns the whole per-item chain: bake, sim ping-pong, mesh
  fluid-registration.js        cascade layer, live override, MapShine.setFluid, card
  __tests__/{fluid,fluid-net,fluid-pack,fluid-pump,fluid-sim,fluid-sim-render,fluid-surface}.test.mjs
```

⚠️ **`fluid-pass.js` was never built, and there is no `sims.fluids` graph pass.** The design originally sketched the sim as a frame-graph pass mirroring `buildFluidSimPass`'s stub in `water-pass.js`; what was actually built instead is `fluid-surface-subsystem.js#prepareSimTick` (all JS-side sim bookkeeping — rewrite the pump texture, decide what "current" means, re-point every node) handing a small job list to `vt-pan-viewer.js#tickFluidSim` (the actual `renderer.setRenderTarget`/`quad.render` calls, walled to `vt/` by `renderer-state/graph-only`) — the SAME split `world/wind-sim-gpu.js`/`tickWindSim` already use. This avoids adding a graph-pass seam for an effect whose own per-tick cost is one tiny fused pass per masked item, and avoids growing `vt-pan-viewer.js`'s own already-oversized frame function by more than a short, generic loop (`keyhole-god-object-forming`). The `sims.fluids` seam named in §10's graph-edits paragraph below is accordingly stale design language, not a built resource.

**Graph edits.**

- `sims.fluids`: `seam → live`. `creates: ['res:tubeFlow']`, `reads: ['res:env', 'res:view']` (view for the zoom gate). Rewrite the note: the tube sim is **1-D and shares no machinery with a 2-D fire or candle sim** — `absorbs` narrows to `FluidEffectV2`, and `FireEffectV2(sim)` / `CandleFlamesEffectV2(sim)` stay listed as unbuilt with a flag that this pass will need to split when they land. Declaring one pass that absorbs three unrelated solvers was a guess made before any of them was designed.
- **`res:tubeNet` and `res:tubeProfile` are deliberately NOT in the graph.** They are precomputes baked on mask-version change, exactly as `res:waterBody` is — and `passes.js` already states the rule and the reason: _"a resource whose producer is not a frame pass has no honest place in it."_
- The **tier 0–5 surface is a drawable in `geometry.world`**, not a pass — the same call `surface.water` makes for its own tiers 0–4, for the same reason. `surface.fluid` becomes real at **tier 6**, the first dependent read of `buf:scene.color`.

**Transparency contract:** two blends (§5.6) — multiply below the tile albedo, add above it. `depthTest: true`, `depthWrite: false`. `gAttr` = **the blend's identity element**, not reflexively `vec4(0)`.

**Registration** mirrors `water-registration.js` (which was built to be exactly this template): `effectRegistry.register(FLUID, …)`, a live-override param layer, `MapShine.setFluid`, and one `registerPanel('fluid-panel', 'Fluid', buildFluidPanel, { zone: 'workshop' })` built with `buildEffectCard`. Settings derive free.

**FOH dials** (`Effects-UI.md` §3.1, ceiling 6, plain language, and `feedback_foh_roh_must_differ`'s test — _would they change it mid-session, or only while tuning?_):

> **Colour · Speed · Liveliness · Glow · Bubbles**

Five, all mid-session knobs, but only **four exist as real controls today** — `tint`, `glow`, `flowSpeed`, `iridescence` (`boot.js`'s own `fohKeys`). "Liveliness" and "Bubbles" are still aspirational: `Liveliness` has no live control because the pump's own per-tube personality (gulp timing, duty cycle — `fluid-pump.js`) is currently baked from a hash, not exposed; `Bubbles` has no control because the tier does not exist yet. Iridescence spread, absorption, wall rim, and every tier threshold are ROH — the full schema auto-categorised.

⚠️ **`speedPx`/`slugCount`/`slugWidth` — the ORIGINAL tier `flow` scroll's three params — are GONE, not renamed**, once the real sim (tier `fill`, §11) superseded that scroll: there is no global "how many blobs" or "how wide" left to tune once each tube's own pump personality decides that per-tube. `speedPx` was repurposed as `flowSpeed` (now a multiplier on the pump's `Q`, not a scroll rate) because it is the one control with a direct, honest sim-side meaning; `slugCount`/`slugWidth` had no equivalent and would have been dead controls (`params/no-dead-controls`) had they been left in the schema.

---

## 11. Build order

Each phase ends green on `npm run verify` and is independently shippable. Each carries a **live-confirmed** line, not just verify-green.

| #     | Phase                                                                                                                                                                                                                                                                                      | Ends when                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | ✅ **DONE 2026-07-26** — Declaration + the mask catalog line + `fluid-net.js` (Node-tested against straight, U-bend, Y-junction, 1-px diagonal, two disjoint, bulbed fixtures)                                                                                                             | ✅ manifest + schema validate; geodesic matches an independent brute-force Dijkstra to 1e-9 on every fixture; `npm run verify` green — 28 structure rules, 4,262 tests, 106 of them fluid's |
| **2** | ✅ **DONE 2026-07-26** — `fluid-pack.js` (the pack, pure). The version-polling `fluid-bake.js` was built and then DELETED: correction #2 moved the extractor onto the mask FILE, which has no version to poll, so the url became the only trigger and two triggers would have been a fork. | ✅ **bakes do not track frames** — now true BY CONSTRUCTION (a url changes on floor/scene change and at no other time), and reported as `bakes` vs `syncs`.                                 |
| **3** | ✅ **DONE 2026-07-26, LIVE-CONFIRMED 2026-07-27** — tiers 0–3 wired end to end; author: _"I can see fluid moving around in the pipes."_ Two real live bugs found and fixed on the way — see §11.1.                                                                                         | ✅ visible on a real map with a real `_Fluid` tile mask.                                                                                                                                    |
| **4** | ✅ **DONE 2026-07-27** — the MULTIPLY half: `fluid-render.js` rebuilt as `buildFluidSurfaceMaterials` (absorb + emit, mirroring `water-render.js`'s absorb/inscatter exactly), `fluid-surface-subsystem.js` now builds two meshes per item sharing one geometry.                           | ✅ `npm run verify` green (5,176 tests); manifest tier 0 text names both passes. ⬜ NOT yet live-confirmed — built after the author's last live check.                                      |
| **5** | ✅ **DONE 2026-07-27 — tier `fill`, THE SIM.** `fluid-pump.js` (per-tube `Q(t)`/`inject(t)`, deterministic from a hash, no private clock/RNG), `fluid-sim.js` (the CPU twin `advectTubeStep` + its TSL transcription `buildFluidAdvectMaterial`, a genuine semi-Lagrangian ping-pong), wired end to end via `fluid-surface-subsystem.js#prepareSimTick` + `vt-pan-viewer.js#tickFluidSim`. SUPERSEDES tier `flow`'s original analytic `fract()` scroll outright — matching this codebase's own precedent that no shipped effect keeps a live per-tier code switch (the governor that would need one is unbuilt, `Effects.md` §6). | ✅ 232 Node tests, `npm run verify` green. ✅ **LIVE-CONFIRMED** after one pacing-bug round-trip (§11.3) — author: _"It works again. Visible fluid moving around."_ |
| **6** | ✅ **DONE 2026-07-27, same day — tier `structure`, THE MATERIAL COORDINATE τ.** ONE `mx_fractal_noise_vec3` fetch at `(τ, across)` (`fluid-render.js`), read as marbling + grain. `τ = s − v̄·t`, analytic, spatially constant per tube (renumbered from the original design sketch's tier 3 — see `fluid.js`'s own `deferredRungs` comment for why the build order diverged from the design order; reclassified C5 from the sketch's C2 guess, same reasoning tier `fill` already needed). | ✅ 243 Node tests, `npm run verify` green (5,326 tests total). ⬜ **NOT live-confirmed** — built the same day `fill` was confirmed, but that confirmation covered `fill` only. |
| **7** | **Tier `bubbles`**                                                                                                                                                                                                                                                                         | bubbles bunch at a constriction on a real map                                                                                                                                               |
| **8** | **Tiers `optics`, `emission`**                                                                                                                                                                                                                                                             |                                                                                                                                                                                             |
| **9** | **Tier `spray`**, through the one engine                                                                                                                                                                                                                                                   |                                                                                                                                                                                             |

**Phases 1–4 are a complete, shippable effect that is already better than V2** and contain no sim at all. That is deliberate: if the sim proves fiddly, there is a product either way. **Phase 5 is where the sim landed** — built, Node-verified against the one claim that matters most (the goo speeds up through a constriction, matching a measured ratio to the predicted `v = Q/A` curve), and now live-confirmed. **Phase 6 is where the material coordinate landed** — the one channel that lets any future procedural pattern ride with the flow instead of past it, built the same day but not yet seen.

### 11.1 The two live bugs that shipped invisible, and the two more that never reached a browser

**Both of Phase 3's live-invisible rounds were LOOKUP bugs, never the shader.** The design assumed fluid could copy water's/specular's mask seam verbatim, and both times that assumption was wrong in a way no test caught, because every test used a synthetic grid handed directly to `extractTubeNet` — never the actual authority lookup:

1. **Unwired entirely.** The mask seam existed and nothing supplied it — the exact `feedback_seam_default_hides_unwired` shape.
2. **Wrong KIND of host.** The seam asked `authoredStatus(levelId, 'fluid')` — the level-BACKGROUND door water and specular both use correctly for themselves. The author's tubes are painted on an **overhead tile**. `authoredStatus`'s own docstring says plainly it covers only _"this level's own background file"_ — a tile was never reachable through it, so the lookup returned null every frame, forever, with nothing erroring anywhere. `keyhole-mask-any-item-decision` already states the fix as standing doctrine (_every mask attaches to ANY item, symmetrically_); the miss was not applying it. Fixed by switching to `authoredStatusForItem` and making fluid genuinely per-item: one mesh per masked item, each the item's own quad, sampled by `uv()` instead of a world rect — which also makes a rotated tile correct for free, a case the world-rect version could not have handled at all.

**Building the MULTIPLY pass (Phase 4) then caught two more, both before anything ran in a browser:**

3. **The render-order story in this file's own header was backwards.** It claimed the emissive pass draws "over" the masked tile's art. `scene/layer-order.js#sortByLayer` proves otherwise: the floor background is always index 0, every real item gets an integer index ≥ 1, and fluid's fixed fractional order sits in `(0, 1)` — strictly BELOW every item, by construction. The number was already correct (that is why the author could see it); the documented reason for the number was invented and wrong. Corrected rather than left to rot (`feedback_plausible_diagnosis_rots`).
4. **The MRT key was `gAttr`; the real key is `attr`.** `MRTNode` matches an `mrt({...})` key against the bound render target's attachment name by EXACT STRING EQUALITY (`vt/scene-attr.js`'s own header, verified against `three.webgpu.js`) — a key with no match is silently skipped, no error. The shipped emit pass used `gAttr`, which matched nothing; its per-material override never applied, and the renderer's global default (`attr: vec4(0,0,0,0)`) took over instead. That was harmless for the emit pass by pure coincidence — zero is additive's own identity. It would NOT have been harmless for the new multiply pass: combined with a multiply blend state, the same wrong-key fallback would have silently zeroed `buf:scene.attr` under every tube — precisely the failure `feedback_blend_neutral_element_is_per_blend` exists to name. Caught by checking water's own working `attr` key against `vt/scene-attr.js` before trusting a one-round-old assumption; never shipped.

> ✅ **PHASE 1 SHIPPED, 2026-07-26 — what the build actually taught, beyond correction #1 (§5.1).**
>
> **Two units of "area", and naming them apart mattered more than computing them.** The first draft returned one `areaProfile` — plan-view area per bin — which is the quantity that CONSERVES. But continuity (`v = Q/A`, the whole reason a constriction speeds the goo up) divides by the CROSS-SECTION, which in a top-down 2-D world is a LENGTH, not an area. One name for two quantities differing by a bin-length factor would have put a constant error into every velocity — and a velocity wrong by a constant reads as a badly-tuned speed slider, not as a bug, for as long as anyone cares to tune it. They are now `binAreaProfile` and `crossSectionProfile`, the second DERIVED from the first (never measured separately — `Water.md` §2.4's two disagreeing GGX stacks are what two independent measurements of one geometry look like after a year).
>
> **A chamfer distance measures centre-to-centre, and half a texel of that is a lie.** The middle texel of a three-texel band sits two texels from the nearest absent texel's CENTRE, but only 1.5 from the band's EDGE. Subtracting half a texel is what turns `2 × radiusProfile ≈ crossSectionProfile` from "two numbers that are roughly similar" into a real invariant the suite asserts — which is the difference between a cross-check and a coincidence.
>
> **Empty profile bins are a division singularity, not a cosmetic gap.** A tube shorter than `samplesPerTube` texels leaves bins with no texel in them; left at zero, `v = Q/A` would fling a slug the length of the tube in one step. `fillEmptyBins` takes the NEAREST populated bin in either direction (not a forward copy, which would drift a short tube's whole profile toward whichever end was scanned first) and reports its own count.
>
> **The suite is adversarially verified, and one sabotage exposed a defect in the SUITE.** Five deliberate breaks — hop-count step costs, no half-texel correction, never flipping on a positive hint correlation, 4-connectivity, no bin fill — each turned it red, naming the mechanism. But 4-connectivity shredded the diagonal fixture into 19 speckles, dropped them all, and the suite then CRASHED on `net.tubes[0]` with a `TypeError` that named nothing and killed the sibling suites in the same process. A test that crashes instead of reporting is `feedback_instruments_must_not_lie` in the test layer; every tube access now goes through a guard that fails loudly with the tube count in the message.
>
> **The `masks/authority-only` wall fired on PROSE** — the literal `_Fluid` inside a manifest's `adds` string. It does not distinguish a comment from a lookup, and it is right not to: V2's suffix knowledge spread by exactly this kind of harmless-looking copy. Reworded, not weakened.
>
> Not live-tested and cannot be: nothing renders yet, and there is no browser surface to look at. The first live-confirmed line belongs to Phase 2.

### 11.2 Four more caught wiring the sim in, none of them reached a browser

Building Phase 5 (the sim, §11) surfaced four defects while writing the wiring itself — none required a live GPU to find, all would have shipped invisibly or produced a wrong picture without a live symptom pointing at the cause:

1. **`stateTexNodes` had to be an ARRAY, not one node.** `fluid-render.js`'s meniscus reads the sim's state a SECOND time at an offset UV (`fillAhead`, a two-tap finite difference), and that is a genuinely separate `texture()` call — there is no `.uv()` chain method on a built TextureNode in this vendored THREE (confirmed against `world/wind-sim-gpu.js`'s own header, which names this exact trap). Exposing only the first sample and re-pointing just that one every tick would have left the meniscus reading a stale, non-alternating half of the ping-pong pair FOREVER — a bug with no error and a plausible-looking (if slightly wrong) picture. Both samples now live in `stateTexNodes`, and the construction test reads the array length back (`=== 2`) so a future regression that drops one is a red assertion, not a silent miss.
2. **`fillAhead`'s UV needed an explicit clamp.** Near a tube's tip (`s` close to 1), `s + epsilon` can exceed 1.0; left to the render target's own wrap mode, that would have wrapped around and sampled the tube's ROOT instead of holding at the edge — a false gradient spike comparing the tip against the opposite end, right where the meniscus should read flattest. `fluid-sim.js`'s own backtrace already clamps its UV explicitly rather than trusting wrap mode; the same discipline was applied here rather than assumed to already hold.
3. **Both buffer builders needed RGBA stride, not stride 1 or 3.** `buildFluidProfileBuffer` (one value per bin) and `writeFluidTubeConstantsBuffer` (`Q`/`inject`/`lengthPx` per tube) were both written assuming a tight, single-purpose layout — but `createFluidPackTexture`, this codebase's one confirmed float-DataTexture recipe, is RGBA. Uploading a stride-1 or stride-3 buffer into an RGBA texture would have scrambled every bin/tube across the wrong channels the first time either builder's output actually reached a texture, since nothing about calling the function itself would throw — the corruption is purely in how the bytes land. Both now write stride 4 (unused channels zeroed or set to 1), confirmed by tests that check the whole interleaved layout, not just the first tube's values.
4. **A genuinely dead pump-buffer writer was deleted, not left to rot.** `fluid-pump.js` had shipped its OWN `writeFluidPumpBuffer` (RG, no tube length) alongside `fluid-sim.js`'s `writeFluidTubeConstantsBuffer` (RGB→now RGBA, WITH tube length) — two candidate mechanisms for the same "upload the pump state" job, only one of which `buildFluidAdvectMaterial` actually reads. `feedback_mode_forks_silently_drop_features` names this exact shape and its resolution (delete the loser); the RG-only writer had 183 assertions covering it and precisely zero real consumers, which is not a contradiction this codebase treats as safe — a Node-tested function with no caller is still `keyhole-tsl-constructs-in-node`'s whole point, generalised: tests prove a thing runs, never that anything reaches it.

None of these needed a browser to find. All four were caught by working through the actual data flow (what layout does the texture require, what does each node actually re-point, which function does the real consumer call) rather than trusting that "it compiles and the tests pass" meant the wiring was right.

### 11.3 The FIRST bug this rung found from a live report — a real map's tube is nothing like the test fixtures

Reloaded after §11.2's fixes landed, the author reported: **"Fluid is no longer visible."** The diagnostic report showed everything green — `simBuilt: true`, `simPingIsCurrent` toggling (ticks running), no warnings, the mesh `visible: true` — the exact "instruments all say fine, nothing draws" shape this project's memory names repeatedly. The report's own tube data was the clue: `lengthPx: 7048`, `maxRadiusPx: 147`.

**`FLUID_PUMP_BASE_Q` (`fluid-pump.js`) was calibrated — and Node-tested — against `fluid-sim.test.mjs`'s own synthetic fixtures: tubes a few hundred px long, 8–32px cross-section.** The author's actual map has tubes an order of magnitude WIDER and several times LONGER. `v = Q/A` is the correct formula (proven against the neck-speedup fixture), but a single flat `Q` cannot look right at both scales — at the SAME `Q`, a 10× wider tube moves 10× slower. Measured directly against this exact tube's own numbers: **over 600 SECONDS to cross it at `FLUID_PUMP_BASE_Q`'s own nominal value**, worse once the pump's own drive factor (which spends most of its time below 1) is folded in. The fluid was not invisible — it was moving at a pace no one would ever sit and watch long enough to notice.

**Fixed with `computeFluidLengthQScale` (`fluid-sim.js`):** a per-tube multiplier, computed once at bake time from that tube's own `lengthPx` and mean `crossSectionProfile`, solving for a roughly CONSTANT traversal time (`FLUID_TARGET_TRAVERSAL_SECONDS`, 8s) regardless of the tube's absolute size — the same length/cross-section-invariant pacing the old analytic scroll had **by accident** (its `s` coordinate was already normalised 0..1), now achieved **on purpose** for a sim whose native units are real world px. Proven on the actual semi-Lagrangian CPU twin, not algebra: a 300px test tube and this exact 7,048px real tube now both fill in ≈9 seconds — a 23× length and 24× cross-section difference collapsed to a <1.01× difference in fill time.

**The lesson, stated plainly:** `feedback_measure_the_output_not_the_equation` is usually read as "check the shader's output," but this is the same failure one layer up — **a physically-correct formula, whose CONSTANT was measured only against small synthetic test geometry, silently fails outside that regime.** A green Node suite proved the physics; it never claimed the physics would be visible on THIS map's actual scale, because nothing in the suite ever tried a tube that size until this fix's own test did.

> ✅ **CONFIRMED, same day, after this fix.** The author reloaded and reported: _"It works again. Visible fluid moving around."_ Tier `fill` (the sim) is now LIVE, the same standing as tiers 0–3 — see `keyhole-current-state.md`.

---

## 12. Verification

**Machine, every phase:** `npm run verify`. New Node suites — `fluid.test.mjs` (schema + manifest valid, no dead controls, cost classes monotonic), `fluid-net.test.mjs` (**the important one**: components, geodesic vs brute-force BFS, `A(s)` vs a counted reference, junction detection, root-end selection from a flat hint), `fluid-pump.test.mjs` (bounded output, no NaN, gulps fire at the declared rate, impulses decay).

> **The CPU twin is mandatory before any "it works" claim.** `feedback_smooth_output_hides_ported_bugs` was written after a smooth, plausible, wrong output shipped twice; `keyhole-water-tsl-design`'s process lesson is _run the CPU twin BEFORE claiming a fix_. The advection step gets a JS twin diffed against the shader's own primitives, and the invariant asserted is **conservation**: total φ in + injected − removed = total φ out, per tube, per step. A transport bug that leaks mass looks _fine_. A conservation assertion sees it immediately.

**Browser reports** (`zone: 'workshop'`, per `keyhole-debug-panel` — the author is told which report to click, never asked for console logs): tube count and per-tube length/area, bake count vs frame count, the pack's four channels as debug views (`s` · `w` · `tubeId` · `R_px`), the state's four channels as a strip, the pump's `Q(t)` as a live trace, and the coverage/overdraw ratio (Law 6).

**Per rung** (`Effects.md` §7): the forced-tier harness screenshots every rung; monotonicity is diffed. **Law 4 is checkable** — build tier 0 and tier 8 and compare compiled shader lengths; if disabling a rung does not shrink the shader, it was a uniform, not a gate.

**Named acceptance scene:** a map with **at least three disjoint tubes, one bend, one Y-junction and one bulbed end**, on a floor with art _over_ the tubes. It must show: three independent behaviours, goo speeding up through the narrow section, the bulb filling, the under-art look preserved, and the whole thing degrading to a flat tint at maximum zoom-out with the sim stalled.

---

## 13. Risks and open questions

1. **The geodesic on a coarse grid may not be monotone enough.** If the rasterised mask grid is too coarse relative to tube width, the BFS wavefront can produce small non-monotonicities in `s` that read as a stutter. Mitigation is a 1-D smoothing pass over the profile (cheap, and `s` is low-frequency by construction), but it is unproven and it is the first thing to measure at Phase 1.
2. **The tube-count cap.** T ≤ 64 is a guess. A map with 200 painted capillaries would exceed it. The fallback — merge the smallest components into a shared row — is silent and therefore wrong per `feedback_instruments_must_not_lie`; whatever the cap does, it must `log()` what it dropped.
3. **`w` degenerates at a junction.** The cross-section coordinate assumes a locally 1-D tube; at a Y it is ill-defined over a small disc. Visible as a smudge at each junction. Tolerable for a decoration, named so nobody rediscovers it as a bug; the real fix rides with junction routing in `deferredRungs`.
4. **The under-art placement caps how much the effect can do.** Multiply-under can only darken and tint; everything bright must come from the add pass _over_ the art, and if the art's painted glass is opaque the goo is invisible regardless of tier. This is the authored contract and it is correct, but it means **the effect's ceiling is set by the map art**, and the acceptance scene must include a tube the art draws opaquely so that limit is visible rather than mysterious.
5. **The first multiply pass in the renderer.** §5.6's blend-neutrality trap is real and the wall for it does not exist yet (§9.2). Build the wall in the same phase as the pass, not after.
6. **Open:** whether the tube graph should be exposed to Foundry at all — a junction with a valve is one macro away from being a puzzle element, which the brief explicitly says this is not. Recorded as a temptation to resist unless the author asks.
7. **Open:** whether `sims.fluids` should be renamed. It was declared to absorb three unrelated solvers before any was designed, and this design uses none of what a fire sim would need.

---

_V2 drew a stripe pattern in a painted gradient and turned off two-thirds of its own features. The gradient was never the parameterisation — the geometry was. Bake the line, simulate the line, and let everything else be a read._
