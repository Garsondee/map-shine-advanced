# WATER — the pure-TSL/WebGPU design, tiers 0–8

**Status:** DESIGN SPEC, 2026-07-25. Supersedes §5–§7 of the 2026-07-16 research seed; §1–§4 below are that seed's measured findings, kept and extended.
**Pass:** `surface.water` (seam today — `src/effects/water/water-pass.js`), plus a new `sims.water`.
**Why water:** Keyhole §4.4 names it the honest hard case and the FIRST Stage 6 port; Keyhole §9 lists it as risk 4; `Effects.md` uses it as the tier ladder's worked example throughout; `Effects-API.md` §6 says the reads/writes/`build(ctx)` contract is deliberately unbuilt and **waits for water to define it**.
**Prerequisite reading:** `Effects.md` (the 8 laws), `Effects-API.md` (the contract), `Effects-UI.md` (FOH/ROH), `Params.md` §4 (the values are NOT the product), `v3/B0-1-floor-attribute-buffer.md`, `v3/B0-3-transparency.md`, `Wind-Rethink.md` (Rule 5), `Grade.md` (`grade/one-stack`), `Sky.md` (`sky/one-atmosphere`).

---

## 0. The one sentence

> **Everything water does visually is a function of a surface slope field and a body descriptor. Build those two things once, and every term — normals, specular, reflection, refraction, caustics, foam — is a read, not a derivation.**

V2 derived them all separately, per pixel, seven to fourteen times over. That is the whole difference.

**The corollary, and the reason this is not a port:** V2's look is not portable. It came out of a WebGL2/GLSL cost model that no longer applies — a 7-octave Gerstner sum evaluated **twice per pixel**, caustics from `dFdx`/`dFdy` after seventeen early `return`s (undefined behaviour, and the file knows it), rain "ripples" that are noise because the real solver TDR'd the GPU, and a 32-permutation `#ifdef` matrix recompiled mid-frame by mutating `material.defines`. Those are workarounds for a machine we are no longer on. `Params.md` §4 already says it for the numbers; it is equally true of the algorithms. **V2 is a checklist of things the author wanted to be able to see. Nothing else.**

---

## 1. The family, measured

| Lines      | File                        | Role                                                                     |
| ---------- | --------------------------- | ------------------------------------------------------------------------ |
| 5,174      | `WaterEffectV2.js`          | orchestration: mask discovery, per-floor compositing, cross-floor binding |
| **2,835**  | `water-shader.js`           | **THE LOOK**                                                             |
| 3,854      | `WaterSplashesEffectV2.js`  | splash particles (a second particle engine)                              |
| 1,683      | `water-splash-behaviors.js` | splash spawn logic (readback-driven)                                     |
| 358        | `water-screen-occlusion.js` | occlusion GLSL, hand-duplicated from `water-shader.js`                   |
| 218        | `water-splash-structural-shadow.js` | injected shadow samplers                                         |
| 1,304      | `FluidEffectV2.js`          | the fluid sim variant                                                    |
| **15,426** |                             | **the water family**, plus ~120 call sites and 22 water-only methods inside `FloorCompositor.js` |

**The ratio is the headline:** the product — the shader — is ~2.8k lines. The other ~12.6k is _plumbing_ this architecture derives. **The amazing part is 19% of the code.** And of that 19%, the *algorithms* are replaceable; what survives is the **feature list** and the **author's intent**.

## 2. The horror tour — each with its general lesson

Extended 2026-07-25 with a full re-audit. Numbers are measured, not estimated.

1. **324 uniforms declared in GLSL, 348 allocated in JS, 294 written unconditionally every frame** — with 220 `safeNum()` calls and 22 transcendentals per frame whether anything changed or not. The shader is compiled for its maximal self at all times. **Lesson:** the tier ladder is not a nicety — without it, every feature you ever add is a permanent tax on every machine forever.
2. **46 of those 348 uniforms (13%) are provably inert** — 27 allocated in JS that the shader never declares, 15 declared in GLSL that nothing reads, 4 read only by a function that is never called. **Every one has a UI slider.** The worst: a fully-labelled *"Bathymetry (Volumetric)"* folder with six controls, two colour pickers and a documented Beer-Lambert model, and **not one line of GLSL implementing it**. **Lesson:** a control that cannot be traced to an output is a lie the author tunes against. This gets a wall (§8.1).
3. **A 975-line `main()`, an 852-line `update()`, a 767-line control schema, a 577-line constructor** whose body is a 320-key flat object literal with no grouping, no schema, no validation. **Lesson:** the size ratchet exists because this is what "just one more knob" converges to.
4. **83 duplicated foam parameters.** Shore foam (43 uniforms) and floating foam (40) share **33 identical suffixes** and back two ~180-line blocks in `getFoamData` that are line-for-line duplicates with the identifiers swapped. Separately, **two independent GGX implementations** — base specular and "Specular Highlights" — with different `k` terms (`rough*0.5` vs `(r+1)²/8`), which can therefore never agree. **Lesson:** a fork in a shader is a fork in the tuning, forever.
5. **Eight suns and eight clocks.** `specSunAzimuthDeg`, `specHighlightsSunAzimuthDeg` and friends are eight separate sun declarations in one effect; `performance.now()` is read eight independent times. **Lesson:** already walled (`env/one-sun`, `time/one-clock`) — water is the evidence those walls were built from.
6. **The world's size is derived five ways with a silent fallback to `1`.** If every source is absent, water gets a one-pixel world rather than an error. **Lesson:** a degenerate silent default is an instrument that lies.
7. **Splash spawning reads the GPU back** — `readRenderTargetPixels` per floor per mask, described in a comment as the *optimised* path. Plus a synchronous 2048² `getImageData` per floor and a JS loop over 4.2M pixels. **Lesson:** per-page CPU extraction at decode time (Keyhole §4.1) exists precisely so spawn scans never touch the GPU. Walled (`no-gpu-readback`).
8. **~12 render targets and 9–17 draws per frame** for one effect, six of them allocated by `FloorCompositor` on water's behalf, and one of them — `LevelAlphaRebindPass` — a whole extra pass whose only job is to **undo water's own alpha side-effect** (`waterOutA = max(base.a, inside)`). Its file says so explicitly. **Lesson:** a pass that exists to repair another pass is the one-producer rule failing out loud.
9. **The debug views lie.** Five of nine entries in the debug dropdown render something other than their label: "Specular" renders `smoothFlow2D()`, which returns `vec2(0.0)` unconditionally; "Sky Reflection" renders a `vec3(0.0)` placeholder — black. "Distortion" renders the shore band, "Foam" the distortion mask, "Murk" the occluder. A sixth mode exists with no UI entry. **Lesson:** Doctrine #5 — an instrument that lies is worse than no instrument. This gets a structural cure (§8.6).
10. **Controls that silently override each other.** `_resolveAdvectionSpeed01`: if a hidden legacy param is finite **and** the exposed slider sits at its default, the legacy value wins — so moving the slider back to its default *re-enables the override* and the author cannot restore it. Same pattern in `_resolveWaveAppearanceDeg`. Plus `Math.max(0, Number(x) ?? 1.0)` — `Number(undefined)` is `NaN`, `NaN ?? 1.0` is `NaN`, so the fallback never fires and the result poisons `dt`, freezing all water motion permanently. Three sites.
11. **55 bare `catch (_) {}` blocks** in `WaterEffectV2.js`, including on the two-line `_setCrossSliceWaterDataUniform` — the healthiest tissue in the file. **Lesson:** `no-empty` is not a style rule. Walled (`no-silent-catch`).
12. **A whole subsystem exists because one shader is too big to compile.** 30→90s compile timeouts, 4-attempt retry with backoff, a passthrough placeholder material, a source-epoch cache-buster, `SafeShaderBuilder`, `ShaderCompileMonitor`, and permanent self-disable on the 4th failure. Water renders nothing for the first N frames of every session, silently.
13. **A manual "keep this GLSL in sync" contract** — `water-screen-occlusion.js` duplicates the occlusion GLSL for the splash particles, with a hand-maintained `SPLASH_OCCLUSION_SHADER_EPOCH = 12`. Twelve recorded desyncs.
14. **Indoor damping keys on the painted `_Outdoors` mask** (`waveIndoorDamping*`, `rainIndoorDamping*`). **Lesson:** this is exactly the pattern `Wind-Rethink.md` Rule 5 exists to destroy — *geometry decides presence, not paint*. Eight verify-green patches died on it before the rule was written.

## 3. What V2 could DO — the checklist (not the code)

The capability list, which is what carries forward. V2's delivery is noted only where it explains a design choice below.

| Group | The capability | How V2 delivered it |
| --- | --- | --- |
| **Placement** | mask-driven regions, per-floor + per-tile composite, cross-floor borrow, punch under opaque decks | 2048² readback per floor; two bespoke push-door setters |
| **Body** | tint, depth shadow, *declared* Beer-Lambert absorption | the absorption model was never implemented (§2.2) |
| **Waves** | 7-octave Gerstner, wind-aligned, dispersion, domain warp, breakup + micro-normal layers, sea-state evolution, gust inertia, **appearance decoupled from travel** | evaluated twice per pixel during a wind blend |
| **Flow** | global advection direction + speed, one master flow clock | one global vector — **a river and a pond behaved identically** |
| **Rain** | precipitation-driven agitation, wind shear on the ripples | noise, not propagation; the real solver was deleted after GPU hangs |
| **Specular** | GGX + a broad sheen lobe, anisotropy, dynamic + spatial roughness, sun-elevation falloff, sky tint, scene-light gate | two disagreeing GGX stacks, eight suns |
| **Reflection** | cloud-top reflection with Fresnel | real reflection was a `vec3(0.0)` placeholder |
| **Caustics** | from the Jacobian of the refractive displacement, dual-layer, brightness-gated | `dFdx`/`dFdy` in divergent control flow — UB |
| **Foam** | shore band, filaments, thickness variation, edge detail, evolution, floating foam, foam-cast shadow, flecks | duplicated wholesale (§2.4); `getFoamData()` called twice per pixel |
| **Murk** | layered turbidity, curl warp, patches, grain, depth gating, hue scatter | 34 uniforms |
| **Refraction** | screen-space, multi-tap, tap validation, border fade, chromatic aberration | 6 extra scene taps |
| **Splashes** | shoreline plumes, rain rings, bubbles, wind drift, occlusion, painted-shadow filtering at spawn | a second particle engine; readback spawn scans |
| **Integration** | cloud shadow, indoor damping, bloom emit, floor-depth-blur awareness | 15 sampler inputs, damping keyed on paint |

**The gaps worth closing — things V2 could not do at all:**

- propagating ripples of any kind, and therefore **no wave reflection off banks**
- any interaction: a token wading, a door swinging into water, an object dropped
- **per-region flow** — the single biggest reason V2 rivers read as ponds with a drift
- the wet band of ground *outside* the shoreline
- physically-grounded depth colour (declared, never built)
- caustics that do not rely on undefined behaviour

## 4. THE CROSS-FLOOR RULE — the one piece of logic ported deliberately

Found, read, and it is **fifteen clear lines** (`WaterEffectV2.js:4357`):

> _"When this level has no `_Water` pack, borrow the nearest lower floor's pack so the water surface visible through holes/bridges still renders correctly (composite + shader occluder will still suppress it under upper opaque geometry)."_

**Semantics to preserve, precisely:**

1. A floor with no local water **borrows the nearest lower floor's** water data, flagged `crossSlice`.
2. **Borrowed water is punched out wherever upper geometry is opaque** (decks, tiles).
3. A per-level override can pin which floor's water a given slice uses, falling back to the viewed floor.

**The Keyhole translation dissolves the plumbing and keeps every rule:**

```js
// src/effects/water/water-floor.js — pure, total, Node-tested in isolation
resolveWaterFloor({ viewedFloor, floorsWithWater, perLevelOverride })
  → { floorIndex, borrowed: boolean, reason: string }
```

- _Borrowing_ = which floor the body pack bakes. One pure function at bake time.
- _The punch_ = a `buf:scene.attr` read (§6) — both bespoke occluder textures and their setters dissolve.
- _The override_ = an input to the resolve, not mutable state on the effect.
- `reason` is a **derived readout**, never a param (`Effect-Registration.md`: readouts must not become params — V2's `HealthEvaluatorService` writing into product params is the corpse).

This was V2's hardest plumbing and Keyhole's §9 risk 4. **The rule is small and sound; the risk was always the machinery around it.** Risk assessment revised down. It rides **tier 0** — correctness never rides the ladder.

---

## 5. THE DESIGN — one field, many readers

The spine is the pattern this codebase has already proven twice: sun shadows (building + overhead + sky-reach = **one** height field, **one** march) and wind (**one** field, three fetch strategies). Water is the third and the largest.

### 5.1 The BODY pack — `res:waterBody`

Baked **on mask version change, never per frame**. One allocator-owned **1024² RGBA16F** target (`screenSized: false`, comfortably under `LAW_MAX_WORLD_RES_DIM`), built by GPU **jump-flood** ping-pong — ~10 `QuadMesh` draws — from the `water` mask VT layer:

| Ch | Contents |
| --- | --- |
| **R** | **signed distance to shore**, world px. Negative inside water. |
| **G** | **depth01** — authored where the mask paints it, else derived from `\|SDF\|`. |
| **BA** | **flow vector** — SDF gradient rotated to the channel tangent (water follows the bank, never into it) + authored flow + a global current param. |

A distance field is low-frequency by construction, so 1024² over a 12K map is not a compromise — a coarse SDF still yields an accurate distance, because distance is what is stored.

**One SDF replaces four V2 systems:** the shore band (at any width, with no bake-time `shoreWidthPx` decision), the depth ramp, foam placement, and — because the field is *signed* — the wet-ground band **outside** the water, which V2 never had and which costs nothing.

**Flow is the headline.** V2 had one global advection vector, which is why its rivers read as ponds with a drift. A per-texel flow vector derived from the channel geometry means a river bends, narrows, speeds up, and carries its chop, foam streaks and caustics downstream — with no authoring.

> ⚠️ **Trap named in advance.** The rebake trigger belongs in the frame loop's version poll, **never** inside a residency-triggered function. That is the bug that bit vegetation on 2026-07-23 (`feedback_residency_sync_vs_render_loop`) and that `Sun-Shadows.md` §7 names. The pack reports its bake count; a bake count that tracks the frame count is the failure, visibly.

### 5.2 The SURFACE field — `res:waterField`

Per frame, **tier 7 only**. One **512² RGBA16F tiling** world-space target, ping-ponged:

| Ch | Contents |
| --- | --- |
| **RG** | **surface slope** (∂h/∂x, ∂h/∂y). Every lighting term reads this and nothing else. |
| **B** | **foam / turbulence**, 0..1. |
| **A** | **height** — the integrator's own state; also modulates thickness. |

Three producers, **summed into the one field**:

1. **Spectral cascade.** A directional Phillips/JONSWAP spectrum, time-evolved and inverse-FFT'd through ping-pong butterfly passes at 256², **two cascades at coprime world scales** (swell + chop) so tiling is invisible. Driven by the **wind handle**'s ambient direction and speed. This is statistically real ocean — correct dispersion, correct wind anisotropy — and its **Jacobian yields foam-where-crests-fold for free, with no derivatives anywhere**. It replaces V2's fourteen-octave-per-pixel Gerstner sum with a texture fetch.
2. **Interactive ripple integrator.** A damped wave equation `h'' = c²∇²h − k·h'`, with the body pack's SDF as a **reflecting boundary** — waves bounce off banks. Impulse sources: rain (from `res:env.weather`), tokens wading, doors swinging into water, splash impacts, authored disturbance anchors. **V2 had nothing that propagated.**
3. **Flow advection.** The field is advected along the body pack's flow vector, two-phase ping-pong to hide the reset seam.

**Openness gates wave energy** — from the wind handle, **never from `_Outdoors`** (`Wind-Rethink.md` Rule 5: geometry decides presence, not paint). An indoor cistern is glassy; the same river outdoors is choppy, because of where the walls are.

### 5.3 Compute vs fragment — the decision, stated

**The body and field passes are fragment ping-pong on allocator-owned render targets, not compute + storage textures.** In order:

1. `textureStore` / `StorageTexture` is **WebGPU-only**. Law 8 forbids a hand-written twin, and this codebase ships both backends. A storage-texture field would make water WebGPU-exclusive by construction — precisely the "couple fancy to backend" failure Law 5 names, which hands the weakest hardware the most expensive path.
2. At 256²–512², nine butterfly passes as fragment draws and as compute dispatches are within noise of each other. Compute's real win is workgroup shared memory, and that starts to matter at 1024²+.
3. Render targets have **one legal door with lifetime ownership** (`graph/three-allocator.js`, `gpu/allocator-only`). Storage textures have none. Adding water's own would mean amending `gpu/textures-in-vt-only` — weakening a wall to buy nothing measurable.

Compute is used where compute wins: **splash particles at tier 8, through the ONE existing particle engine** (`effects/particles/`, `renderer.compute()`, proven live on both backends by `diag/compute-spike.js`). A compute butterfly is a recorded deferred rung, gated on a measurement, not a preference.

---

## 6. THE LADDER

Cost classes per `Effects.md` Law 3.

> **Clarification, recorded so it is not "fixed" later:** tier 0's class is the effect's **admission price** — what it costs to put the effect in the right place at all. Law 3's monotonicity governs rungs **1..N**. This is exactly how `Effects.md` §4's own worked table reads (`C4, C1, C2, C3, C4, C5, C6, C7, C8`), and under the strict reading both that table and this one look malformed. They are not; the rule has an implicit tier-0 exemption, and it is now explicit.

| Tier | Name | Class | Adds |
| --- | --- | --- | --- |
| **0** | `placement` | C4 | The water mask, tinted, in the right place on the right floor — cross-floor borrow + the `attr` punch. **Never gated.** |
| **1** | `volume` | C1 | Beer–Lambert absorption over depth (`exp(−σd)`) so deep reads deep and shallow reads sandy, plus the wet-ground band outside the shoreline. Pure ALU on reads tier 0 already paid for. |
| **2** | `motion` | C2 | A resident seamless tiling slope+foam texture, scrolled and blended at two scales **along the flow vector**. It stops being a decal. |
| **3** | `light` | C3 | GGX specular + Fresnel-weighted sky reflection from the **sky handle**, gated by `buf:scene.illum` and `buf:scene.vis`. No new bandwidth. |
| **4** | `shore` | C4 | SDF-driven shoreline detail — foam filaments along the bank, wave shoaling toward shore — and **caustics from the field's Jacobian** projected onto the bed. |
| **5** | `refraction` | C5 | Dependent read of `buf:scene.color` offset by slope × thickness, with a land-validity test, plus chromatic dispersion on the same offset. |
| **6** | `reflection` | C6 | A short screen-space march along the wave normal for shoreline objects and tokens, over the sky handle's base. First rung with a VRAM line in the ledger. |
| **7** | `sim` | C7 | The spectral cascade + interactive ripple integrator + flow advection, **added into** the tier-2 field. Rain rings, token wakes, waves reflecting off banks. Coverage- and zoom-gated (Law 7). |
| **8** | `spray` | C8 | Splash and spray particles through the **one** particle engine, spawned from decode-time extracted shore points and sim impact events. |

Rungs 1–8 are a clean `C1 → C8` staircase.

**Two placements worth defending:**

- **Foam arrives at tier 2, not tier 4.** It is a channel of a read already paid for. The 2026-07-16 seed predicted this from V2's shore-band packing; the SDF makes it more true, not less.
- **Tier 7 ADDS to the tier-2 field, it does not replace it.** Law 2 forbids substitution — a rung may never swap the technique behind an existing term. The resident tiling base keeps contributing at every tier; the sim adds structure noise cannot have (correct dispersion, banks reflecting, rain rings, wakes, flow-coherent crests). This is also simply true of real water: broadband chop *plus* coherent structure.

**Tiers 0–3 are nearly free and carry nearly the whole look.** That asymmetry is not luck — it is what Law 3 *is*. A weak machine gets water a player would describe as water, not as "missing effects".

**`deferredRungs` — recorded, not built:** compute-shader butterfly (gated on a measurement); two simultaneous water bodies visible through one hole; underwater depth-of-field; ice / lava / swamp material presets over the same field; authored flow painting through the Map Points successor (`Authoring-and-Distribution.md`).

---

## 7. Handles — water derives nothing it can be handed

V2's water re-derived the sun eight times, the sky twice, the wind privately, shadow atmospherics four times, and time eight times. Every one of those is a handle now.

| Water needs | Handle | What dies |
| --- | --- | --- |
| wave direction/energy, indoor calm | `world/wind-access.js` → ambient + **`openness`** | `windOverride*`, `waveIndoorDamping*`, `rainIndoorDamping*` |
| sky colour for reflection + Fresnel | `effects/sky-access.js` → `key` / `fill` / `ambientMultiplierRgb` | `specSkyTint`, `specHighlightsSkyTint`, `skyIntensity`, `cloudReflection*` — all would trip `sky/one-atmosphere` anyway |
| cloud / night / dawn behaviour of glints | `effects/shadow-access.js` → `shadowAtmosphere` | `cloudShadow*` (5), `murkShadow*`, `floatingFoamShadow*` |
| sun occlusion | `buf:scene.vis` (`light.visibility` is live) | water's private sun-occlusion notion |
| the sun | `res:env.sun` — **one** | V2's eight sun declarations |
| time | `core/frame-clock.js` `tMs` / `dtSec` (sim time; pauses with Foundry, 5s symmetric ramp) | V2's eight `performance.now()` reads |
| rain | `res:env.weather` | a private precipitation notion |
| the mask | `scene/mask-authority.js`, kind `water` (already declared, `_Water`, RGBA, `absentValue: 0`) | mask-suffix literals — `masks/authority-only` forbids them outside `mask-catalog.js` |
| colour grading | **nothing.** Water writes `buf:scene.color` *before* `post.grade`, so it is graded and must not pre-compensate or tone-map | ~14 V2 params by name (`shoreFoamBrightness/Contrast/Gamma`, `floatingFoam*` ditto, `causticsBrightnessGamma`, `murkSaturation`, `murkDensityContrast`, `distortionEdgeGamma`, …) — all would trip `grade/one-stack` |
| splashes | `effects/particles/` — the one engine | `WaterSplashesEffectV2`'s three.quarks engine |

**A handle is frozen at construction.** A rebake mints a new one with `version + 1` — cache the version you built against and rebuild when it moves. Water's own mask is *not* required (`absentValue: 0`), so a scene with no water is silently correct, not an error.

---

## 8. The walls this port installs

V2's water is the largest single body of evidence in the repo, so it should leave the most walls behind. Skeleton.md's covenant: *when you fix a bug class, add its tripwire.*

**Already walled — nothing to build:** private clocks (`time/one-clock`), GPU readback (`no-gpu-readback`), global reach-through (`no-global-bus`, `zones/one-door`), mask literals (`masks/authority-only`), uniform gates (`tsl/no-uniform-gates`), grade sprawl (`grade/one-stack`), sky sprawl (`sky/one-atmosphere`), RT sprawl (`gpu/allocator-only`), silent catches (`no-silent-catch`), hand-written controls (`ui/no-handwritten-controls`), the `.mix()` receiver trap (`tsl/no-mix-method`), file/function size (`SIZE_CAPS` + the ratchet).

**New:**

1. **`params/no-dead-controls`** *(structure rule)* — every key in an effect's `*_PARAMS` must appear at least once in that effect's render/builder module sources. Cures §2.2 directly: 46 inert uniforms, all with sliders, including a labelled folder with zero implementation. A source-text check is crude and it catches exactly this class.
2. **Cost-class monotonicity in `validateEffectManifest`** — `Effects.md` §7 specifies it ("non-decreasing cost class") and it is **not implemented**; today the validator checks only `n` contiguity and `adds`. Water is the first tiered effect, so this is the moment. Governs rungs 1..N with tier 0 exempt, and the exemption is written into the error text so §6's clarification cannot be lost.
3. **`effects/uniform-budget`** *(ratcheted)* — a cap on `uniform(` call sites per effect module, seeded at today's values. 324 uniforms on one shader is the largest measured instance of the disease in this repo, and a ratchet is this codebase's idiom for "never worse".
4. **Tier-shader-length report** *(debug panel)* — `Effects.md` §7's "Law 4 is checkable": build tier 0 and tier N, report both compiled shader lengths. **If disabling a rung does not shrink the shader, it was a uniform, not a gate.** Browser-only, so a report, not a Node test (CONVENTIONS §4).
5. **Coverage / overdraw report** — water reports `drawnPx / coveredPx`. Law 6 has no wall today, and *"a water pass that runs fullscreen while water covers 2% of the view"* is Law 6's own worked example. Bounded geometry is the design; the report is what proves it stayed that way.
6. **Debug views generated from one list** — the debug-view enum's values **are** the field channel names, consumed by both the UI schema and the shader. Cures §2.9, where five of nine labels rendered something else. One list, two consumers, no drift possible.
7. **Design invariants** (no mechanical wall; stated so a reviewer can point at them): **ONE** foam function, with three physical sources (Jacobian folding, flow divergence, shore band) summed into one channel — never a shore/floating fork. **ONE** GGX — never a second "highlights" stack. These are §2.4, and they are prevented by design rather than by regex.

---

## 9. Module layout, contract, and registration

All new, all inside `SIZE_CAPS` (file ≤1000, fn ≤500) — **no new entries in `size-budgets.json`**.

```
src/effects/water/
  water.js          declaration: WATER_PARAMS, WATER manifest, WATER_PRESETS, waterPreset   (~450)
  water-floor.js    resolveWaterFloor — §4's rule, pure, Node-tested                        (~120)
  water-body.js     TSL builders: JFA SDF + depth + flow bake                               (~350)
  water-field.js    TSL builders: spectral cascade, ripple integrator, advection            (~600)
  water-render.js   TSL builders: the surface material, tier-gated at graph-build time      (~800)
  water-pass.js     replaces the seam — buildWaterPass(ctx) wires body + field + render     (~450)
  __tests__/{water,water-floor}.test.mjs + run-tests.mjs
src/vt/scene-attr.js  the MRT attribute-buffer builder + descriptor (§10 Phase 0b)          (~300)
```

The split is bloom's, exactly: a **pure-data declaration** (no THREE, Node-validatable), **TSL builders with THREE injected and never imported**, and a **thin closure in the viewer**. Water's viewer footprint is `allocator.create(...)` calls plus a `runSurfaceWaterPass` closure of ~40 lines in the local `passImpls` map. Nothing else.

**Graph edits.** `surface.water` → `status: 'live'`; `reads` becomes `['vt:masks','buf:scene.illum','buf:scene.attr','buf:scene.vis','res:env','res:waterBody','res:waterField']`. A new `sims.water` pass creates `res:waterField`; `water.body` creates `res:waterBody`. **`res:fluidSim` drops from water's reads** — nothing produces it, and a live pass declaring an unproduced read is precisely `pass-health.js`'s STARVED. `buildWaterPass` leaves `PASS_SEAMS` and gains a `PASS_IMPLS` entry the same commit — `pass-declarations.test.mjs` asserts both directions. Update the hardcoded plan string in `src/graph/__tests__/run-frame.test.mjs`.

**Transparency contract** (`v3/B0-3` §4, the per-effect row): blend Normal; `depthTest: true`, `depthWrite: false`; **`gAttr = vec4(0)`** — water reads attributes, never writes them; Z placement inside the floor band below splashes (33) and vegetation (32), preserving V2's verified order *water → splashes → vegetation* so water never paints over vegetation; presence-mask gating replaced by `attr`.

**Registration** mirrors bloom in `src/boot.js`: `effectRegistry.register(WATER, resolved => …)`, a `waterLiveOverride` param layer + `reapplyWater()`, a `getWaterRenderState` seam injected into the viewer (`vt/` never imports `boot.js`), `MapShine.setWater`, and one `MapShine.debug.registerPanel('water-panel', 'Water', buildWaterPanel, { zone: 'workshop' })` built with `buildEffectCard`. Settings derive free: `water.gmEnable` (world), `water.playerEnable` (client).

**FOH dials** (`Effects-UI.md` §3.1, ceiling 6, plain language): **Wetness · Liveliness · Murkiness · Flow**. ROH is the full schema auto-categorised into the six fixed categories. Every `drives` key must exist in the schema with an in-range target, or the build fails.

---

## 10. Build order

Each phase ends green on `npm run verify` and is independently shippable.

| # | Phase | Ends when |
| --- | --- | --- |
| **0a** | ✅ DONE, live-verified — `vt-pan-viewer` extraction steps 2–3 (vegetation shadows, point-light pool) | the size ratchet goes **down** twice |
| **0b** | ✅ DONE, live-verified — **`buf:scene.attr`** — MRT, RGBA8/Nearest/NoColorSpace; opaques write; every transparent outputs `gAttr = vec4(0)` | a debug view shows floorId / outdoors / coverage / solidity; `geometry.world`'s partial-claim note is deleted (⚠️ bit 1/levelsHidden and the clear-value sentinel are the two honest gaps, see §12) |
| **1** | ✅ DONE — Declaration + `resolveWaterFloor` + walls §8.1–8.3 | manifest + schema validate; `water-floor.test.mjs` green; the three walls sit at zero |
| **2** | Body pack — JFA SDF, depth, flow; version-polled rebake | debug views of SDF/depth/flow; **bake count is not frame count** |
| **3** | **Tier 0** — placement, borrow, punch; registered, panelled, in the frame graph | S3: river visible through the planks, occluded by the planks |
| **4** | **Tiers 1–3** — volume, motion, light | side-by-side vs 0.5.x reference, author sign-off |
| **5** | **Tier 4** — shore + caustics | |
| **6** | **Tiers 5–6** — refraction, reflection | |
| **7** | **Tier 7** — the sim: cascade, integrator, advection, rain/token impulses | the coverage/zoom gate demonstrably drops it on zoom-out |
| **8** | **Tier 8** — spray, through the one particle engine | |

**Phase 0a is not optional.** `src/vt/vt-pan-viewer.js` is 11,957 lines with a 10,484-line function, frozen shrink-only by `tools/size-budgets.json`. Attr MRT and water wiring will grow it, and that fails the build — by design. `VT-Pan-Viewer-Extraction.md` is written, author-approved, and step 1 is done. Water is the forcing function for work already agreed.

Phases 3–8 each carry a **live-confirmed** line, not just verify-green. Too much of the tree currently reads *"verify-green, NOT live-tested"*; `V3-Development-Timeline.md` §6 asks for exactly this ledger.

---

## 11. Verification

**Machine, every phase:** `npm run verify` — lint, Prettier, structure rules, size budgets, the full suite. New Node suites: `water.test.mjs` (schema + manifest valid, no dead controls, cost classes monotonic) and `water-floor.test.mjs` (borrow / override / no-water, including the S3 shape).

**Browser reports** (`zone: 'workshop'`, per the debug-panel protocol — the author is told which report to click, never asked for console logs): water status (resolved floor, borrowed y/n **and why**, bake count vs frame count, mask completeness), the tier-shader-length ladder, the coverage/overdraw ratio, and the field debug views (SDF · depth · flow · slope · foam · height) generated from the one channel list.

**Per rung** (`Effects.md` §7): a forced-tier harness screenshots every rung — a rung nobody's hardware selects is a rung that silently rots, which is the exact failure the ladder exists to prevent. Monotonicity is diffed: tier `n+1` must not change tier `n`'s region.

**The named acceptance scene is S3, "Plank-prison over river"** (`docs/archive/planning/acceptance-scenes.md`): the river must be visible through the planks, occluded **by** the planks, splashes clipped under the deck. Plus the standing Stage 6 gate (Keyhole §8): side-by-side vs 0.5.x reference screenshots signed off by the author, budgets hold, soak clean, on the 12K × 3-floor torture scene.

**Budget.** Keyhole §4.2's RT inventory already reserves ~30 MB for water/fog screen buffers. Body 1024² RGBA16F ≈ 8 MB; field 512² RGBA16F ×2 ≈ 4 MB; two 256² cascades ×2 ≈ 2 MB. Comfortably inside it.

---

## 12. Risks and open questions

1. **Phase 0a is real work before any water exists** — ~1,100 lines of extraction. Already approved, independently valuable, but water is gated behind it.
2. **`buf:scene.attr` touches the hottest path in the renderer.** MRT on `geometry.world` plus the `gAttr = vec4(0)` convention on every transparent material is a wide, shallow change with a real regression surface. It ships and gets live-tested on its own, before water touches it.
3. **Soft vs binary occlusion is decided, not solved.** V2's deck occlusion was soft (`smoothstep(0.34, 0.66, deckAlpha)` — a 50%-alpha deck half-occludes the river); `attr` is binary by construction. Per B0-1's own guidance, **water derives a soft mask from `attr.a` and blurs it itself** — consumers blur their derived mask, never the buffer. If that reads worse than V2 on S3, the fallback is water-as-geometry with depth (B0-3's B5), which is a larger change.
4. **The spectral cascade is the least-proven piece.** If tier 7 proves expensive or fiddly, tiers 0–6 are a complete, shippable water effect on their own. That is what the ladder is for.
5. **Open:** where decode-time per-page extraction supplies tier 8's shore spawn points (Keyhole §4.1 is the sanctioned route; the exact extractor shape is undesigned). Whether authored flow painting lands with the Map Points successor or before it.

---

_V2's water was 15,426 lines to make one heightfield's slope. Build the field once._
