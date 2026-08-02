# CLOUDS — terrain in the sky

**Status:** **DESIGN ONLY. NOTHING BUILT.** Authored 2026-08-01, rewritten the same day against the author's brief (§0.1). No code exists. Every claim about V2 was read out of `legacy/` and is cited to a line; every claim about V3 is a proposal.

**Prerequisite reading:** `Effects.md` (tier laws — esp. Law 4 gating, Law 6 O(covered screen), Law 7 the zoom/coverage gate), `Windows.md` §4 (the field sketch this adopts), `Sky.md`, `Sun-Shadows.md`. Memory: `keyhole-webgpu-tsl-decision`, `feedback_mode_forks_silently_drop_features`, `feedback_gamma_space_composite_arithmetic`, `keyhole-zoom-out-clarity`.

---

## 0. The brief

### 0.1 What the author asked for (2026-08-01)

> *"The primary element that we use is cloud shadows but we do also want the cloud tops rendering when you zoom far out… I'm happy for an entirely procedural WebGPU and TSL approach to cloud shapes. So when we zoom in and only see cloud shadows it would be nice to not have to pay the performance for clouds which aren't currently visible."*

Four rulings, all now closed:

| Question | Ruling |
| --- | --- |
| Shadows or tops? | **Both. Shadows are primary; tops appear when zoomed far out.** |
| Procedural or assets? | **Fully procedural.** No PNGs. (V2 shipped 31 at 2048², ~16 MB each.) |
| Cost when tops aren't visible? | **Must be genuinely zero**, not a faded-out draw. |
| Tiers? | **Design with the ladder in mind from rung 0.** |

### 0.2 The structural consequence

**The two halves have inverse visibility.**

| | Cloud shadow | Cloud tops |
| --- | --- | --- |
| **Zoomed IN** | the whole story — large, soft, slow | invisible (and would obscure the map) |
| **Zoomed OUT** | fine detail collapses toward sub-pixel | the spectacle |

They are never both at full cost. That is not a happy accident to exploit later — **it is the load-bearing fact the architecture is built around**, and §5 is that architecture.

The zoom gate the author asked for on *performance* grounds also solves two problems it wasn't designed for (§5.4): a cloud can never obscure a token a player is manipulating, and the cloud-to-shadow offset only has to look right at the zoom where the map is big enough to contain it.

---

## 1. Three ideas that make the system small

If only these survive review, the design still works.

### 1.1 ⭐ A top-down cloud is a HEIGHT FIELD, and this engine already marches height fields

From directly overhead you never see a cloud's underside or its sides. A cloud is not a volume here — it is **terrain, in the sky**:

```
H(x, y, t)   cloud-top altitude
T(x, y, t)   optical thickness
```

That is the same shape as the data `sun-occlusion.js` already marches for buildings. Clouds become *another height field, higher up, that moves*. Nothing new is invented; an existing algorithm gets a second, taller, softer input.

**And for a single deck there is no march at all.** If clouds sit at altitude `h`, the shadow at ground point `p` comes from the cloud directly up-sun of it:

```
shadow(p) = cloudAt( p + (h / tan(sunElevation)) · sunDirXY )
```

**One offset sample.** A march is only needed once a deck has real *thickness* or once there are two decks — both tier 2. That is why tier 0 can be genuinely trivial, and it uses `h / tan(elevation)`, the formula [sun-shadows.js:26](src/effects/sun-shadows.js:26) already states verbatim, instead of V2's `shadowOffsetScale × 5000` ([CloudEffectV2.js:1583](legacy/compositor-v2/effects/CloudEffectV2.js:1583)).

### 1.2 ⭐⭐ Softness is an OCTAVE COUNT, not a blur

The best idea in the document, and it deletes a subsystem.

A penumbra is a **low-pass filter**. Dropping high-frequency octaves from an fBm *is* low-passing it. Therefore:

> **Blurring a cloud shadow = evaluating fewer octaves. Softer is CHEAPER, exactly — no kernel, no taps, no render target, no second pass.**

V2 spent a 9-tap weighted blur ([cloud-shaders.js:126-137](legacy/compositor-v2/effects/cloud-sprites/cloud-shaders.js:126)) plus a `uShadowSoftness` uniform approximating this. We get it by not doing work.

One mechanism then serves **three** purposes:

| Purpose | Rule |
| --- | --- |
| **Penumbra** | higher deck → wider penumbra → fewer octaves. *High cirrus is cheaper than low cumulus, and that is physically why.* |
| **Antialiasing** | drop any octave whose wavelength is under ~2 screen px. Proper band-limiting — the right fix for `keyhole-zoom-out-clarity`'s shimmer, applied at the source rather than as a post filter. |
| **Performance tier** | the ladder's rungs *are* octave counts. |

The octave count is `min(penumbraLimit, screenLimit, tierLimit)`. Because the penumbra limit is *physical*, the cheapest configuration is also the most correct one.

### 1.3 ⭐ ONE knob — altitude — drives five things

```
altitude ──┬──→ shadow offset      (h / tan elevation)
           ├──→ shadow softness    (penumbra ∝ h → octave count, §1.2)
           ├──→ parallax           (cloud drawn at (x,y), shadow at (x+off, y+off))
           ├──→ drift speed        (higher deck, faster wind)
           └──→ how much sky it hides
```

**Verified:** the world camera is `new THREE.OrthographicCamera(...)` — [vt-pan-viewer.js:5611](src/vt/vt-pan-viewer.js:5611), commented "THE WORLD-SPACE CAMERA". (The `PerspectiveCamera` at `boot.js:5927` is the heartbeat probe's empty scene, not the view.) So **panning produces no cloud/ground parallax at all**: a cloud draws at its own `(x,y)` and its shadow lands offset. The entire visible cloud↔shadow separation is a function of sun angle and altitude, nothing else. That is what makes the single-knob model exact rather than approximate.

V2 had `shadowOffsetScale`, `uShadowSoftness`, three hand-tuned `LAYER_PARALLAX` constants, `driftSpeed`, `driftMaxSpeed`, `minDriftSpeed` and `windInfluence` as *seven independent numbers tuned into agreement*. Here they are one number, and they cannot disagree.

---

## 2. Brainstorm — six ways to represent a cloud

Evaluated against the brief: shadows always on, tops zoom-gated, **zero cost when tops aren't drawn**, fully procedural.

### R1 — Pure analytic (evaluate the noise where it is needed)
`mx_fractal_noise_float(vec3(worldXY + drift, boil))`, no storage of any kind.

- ✅ **Zero memory traffic. Zero VRAM. Zero residency. Nothing to allocate.** When the tops aren't drawn the cost is *exactly* zero — not a small texture sitting resident, not a bake tick still running. **This is precisely what the author asked for**, and no other option delivers it absolutely.
- ✅ Correct under pan and zoom by construction — no cache, nothing to swim.
- ✅ **Evolution ("boil") is free** — the noise already takes a `vec3`; advance the third axis. Every baked option must re-bake to get this.
- ✅ Scales down by dropping octaves (§1.2), which is also the antialiasing and the tier.
- ✅ Exact no-op at clear sky: `cover01 = 0` → returns exactly `1.0`.
- ⚠️ Cost is per-pixel *per consumer*. Mitigated in practice: only the ambient multiply is fullscreen; water/specular/windows/vegetation are sparse and largely disjoint.
- Cost class: **C1 (pure ALU)**.

### R2 — Compute-baked tileable "cloud page"
A 512²/1024² tile (R=height, G=thickness) regenerated by compute on a slow tick; drift by scrolling UVs.

- ✅ One cheap mipped fetch per consumer; mips band-limit for free.
- ❌ **Costs VRAM and a bake tick whether or not anything is visible** — fails the brief's core requirement.
- ❌ Tiling repetition across a 12K map (mitigable by multiplying two differently-scaled tiles — a second thing to tune).
- ❌ Boil needs re-baking; scrolling alone gives a *translating* cloudscape that never changes shape.
- ⚠️ This project has a device-loss history tied to VRAM (`keyhole-device-loss-large-map`). New resident textures deserve suspicion.

### R3 — Scene-space baked texture (covers actual scene bounds)
- ✅ No tiling artifacts.
- ❌ **Cloud quality becomes a function of map size** — a bigger map gets worse clouds. A bad scaling property to design in deliberately.
- ❌ Same always-resident cost as R2.

### R4 — Volumetric 3D texture + raymarch
`texture3D` / `storageTexture3D` are real TSL exports; 128³ at R8 is only ~2 MB.

- ✅ Physically unified — shape, self-shadowing, ground shadow and silver lining all fall out of one volume.
- ✅ The highest-quality possible answer for the tops.
- ❌ For a top-down view most of the volume is never seen — paying 3D for a 2.5D problem.
- ❌ 3D fetches cache poorly; marching a volume is the most expensive thing here.
- **Verdict:** not the architecture, but a legitimate far-future `extreme` rung for the tops *only*. Recorded as deferred, not built.

### R5 — Hybrid: baked low-frequency base + analytic high-frequency detail
- ✅ Cheap base, crisp pan-correct detail, boil on the analytic half.
- ❌ Two representations to keep in agreement — and **it bakes the wrong end.** The low-frequency half is the *cheap* half to evaluate analytically (few octaves); the expensive octaves are the high-frequency ones, which are exactly the ones that must stay analytic to survive zoom.

### R6 — Half-res screen-space cache of the world-space field
Compute the field once per frame into a half-res RT; consumers sample it.

- ⚠️ Superficially V2's sin, but genuinely different: V2's RT was the **authority** (clouds *lived* in screen space, hence the motion-compensation cache). This is a per-frame **cache of a world-space function**, recomputed from world coordinates every frame — nothing can swim.
- ✅ Turns N evaluations into 1 + N cheap fetches. Half-res is visually free on something this soft.
- ❌ Full-screen RT bandwidth and VRAM, always, even zoomed in.
- **Verdict:** the **escape hatch**, not the plan. If measurement ever shows consumer count hurting, this drops in cleanly — every consumer already reads one shared node (§4).

### 2.1 The verdict

**R1, pure analytic.** It is the only option that makes "don't pay for clouds you can't see" *exactly* true rather than approximately true, the only one where boil is free, and the only one that adds no VRAM to a renderer with a device-loss history.

> **The headline property: the entire cloud system reads zero bytes of memory.** No VT pages, no render targets, no textures, no storage buffers, no assets. Pure ALU. On a bandwidth-bound renderer — which every modern GPU is — that is close to free real estate, and it is why this scales to 4K without a resolution scale.

R6 is the documented escape hatch. R4 is a deferred `extreme` rung. R2/R3/R5 are rejected above, recorded so nobody re-proposes them in six months.

---

## 3. The shape of a cloud — making procedural look good

Fully procedural is approved, so the look budget goes into *which noise*, not *which PNG*.

### 3.1 Cloud type is ONE dial, not a noise-parameter panel

The right surface for a procedural-shading author is a **type ramp** driving the whole noise network, not eight exposed noise parameters:

| | **Cirrus** (high) | **Cumulus** (mid) | **Stratus / overcast** (low) |
| --- | --- | --- | --- |
| altitude | high | mid | low |
| basis | fBm, heavily domain-warped → streaks | **Worley billows** + fBm erosion | low-contrast fBm sheet |
| shadow | very soft, faint, wide | **crisp, dramatic, high contrast** | flat, near-uniform |
| octaves | few (softness is physical, §1.2) | many | few |
| drift | fast | medium | slow |

One dial sweeps cirrus → cumulus → stratus, drivable straight from `env.weather.preset` so a GM sets weather, not noise parameters.

### 3.2 Worley is what makes cumulus read as cumulus

**Verified:** `mx_worley_noise_float` is a real TSL export (`three.tsl.js:382`), as is `mx_heighttonormal` (`:353`). Cumulus tops are cauliflower, and cauliflower is Worley — `1 − worley` gives the round billowing lobes, with fBm subtracted to erode the edges. The single biggest look-win available for the tops, one extra noise call, and **it lives only in the tops shader — the shadow path never pays for it.**

### 3.3 The tops shading, in cost order

1. **Relief from the gradient.** `∇H` is the cloud's normal (`mx_heighttonormal`), lit by `sky.key.dirX/dirY` — the *one* azimuth convention ([sky-access.js:264](src/effects/sky-access.js:264)), which that file's own header records being wrong for its entire life until a real consumer appeared. Clouds must not become the second wrong derivation.
2. **Silver lining.** Thin edges with the sun behind — peaks at `T·(1−T)`, one multiply, and the most recognisable cloud look there is.
3. **Powder / dark edges.** `1 − exp(−2σd)` — the difference between "grey blob" and "cloud".
4. **Multiple-scattering cheat.** Real cloud interiors are *bright*, not dark; a slight interior brightening avoids the "dirty cotton wool" look Beer's law alone produces.

> **⚠️ `feedback_roughness_and_normal_are_one_model`.** A gradient normal over a nearly-flat height field is a contradiction that renders as *nothing*. Judge the tops by **coverage and headroom, never the mean** — a layer whose average brightness is correct can still be a flat wash with no relief anywhere. That is exactly how the specular build shipped invisible.

### 3.4 What V2 got right, kept

- **Broken cloud is the interesting weather.** Contrast peaks at `cover = 0.5` via `4c(1−c)` (Windows.md §4.2) — overcast has no cloud *shadows*, it is all shadow. Nobody tunes this.
- **Clouds never pop.** V2's `SPRITE_FADE_DURATION_SEC = 10` — cloud state is the slowest-changing thing on the map. Keep the principle.
- **Wind accelerates fast, decelerates slowly.** [cloud-wind-advection.js:65-72](legacy/compositor-v2/effects/cloud-wind-advection.js:65) — `driftDecelFactor` 0.14, deceleration ~7× lazier, plus a floor so clouds never fully stop. That asymmetry is why V2's clouds felt like weather. **Keep verbatim** — and it now applies to *one CPU-side `vec2`*, not 120 sprites.
- **Lightning lights the clouds.** [cloud-shaders.js:7](legacy/compositor-v2/effects/cloud-sprites/cloud-shaders.js:7); [sun-shadows.js:265](src/effects/sun-shadows.js:265) calls this "the one thing V2 got right here". Deferred rung.

---

## 4. The field is not an effect's property

`world/cloud-field.js` is a **world module** — sibling to `sun.js` and `wind-field.js` — serving a handle. `effects/clouds/` owns the manifest, params and ladder (one card in the UI, because "Clouds" is one thing to a user) and reads the field.

Six consumers, all already written:

| Consumer | Gets |
| --- | --- |
| **windows** (forcing function) | [window-render.js:169](src/effects/window/window-render.js:169)'s `cloudFactorNode` — **already wired, already consumed, defaulting to `float(1)`** |
| `shadow-access.js` | its scalar `cloudSoften`/`cloudStrength` become **spatial** |
| `environmental-light.js` | outdoor ambient dips as the cloud crosses (the one fullscreen consumer) |
| `water/water-light.js` | the sun glint dies under the same cloud |
| `specular` | the metal's sun lobe, likewise |
| `vegetation` | dappled light across a canopy — V2's most visible cloud consumer |

**Not the grade.** `grade-ops.js` is deliberately global; a spatially varying grade is a colourist per pixel. It keeps the scalar.

> **⚠️ The seam can already lie.** [effects/index.js:292](src/effects/index.js:292) is honest today, but this is `feedback_seam_default_hides_unwired` by name. The handle must carry **`hasField`** (the contract `windHandle.hasBake` already sets) so a status report can distinguish *"factor = 1 because the sky is clear"* from *"factor = 1 because nobody passed me a field."* Same pixel, completely different bug.

> **⚠️ The shadow multiplies `buf:scene.illum`, never albedo.** V2's [vegetation-cloud-shadow.js:39](legacy/compositor-v2/effects/vegetation-cloud-shadow.js:39) did `c *= (1.0 - cloudDarken)` on canopy *colour* — `feedback_gamma_space_composite_arithmetic`. Darkening albedo makes a shadowed leaf a muddier green; darkening illumination makes it the same leaf with less light on it.

> **⚠️ Cloud kills the KEY and boosts the FILL.** `sky-access.js` already splits these and is already cloud-aware. That split is what makes a passing cloud read as *weather* rather than an opacity slider — the patch goes from sunbeam to grey daylight. **The fill is never gated on the key** (`feedback_environment_term_gates_wrong_thing`, which cost this project a shipped-invisible specular build).

### 4.1 ✅ RULED: the combine happens at the READ site, not in the bake

**Author ruling, 2026-08-01: *"Read site, not the bake."*** This is the one decision here that overrides something already committed to code, so it is recorded in both places — the `cloud-shadows` entry in [sun-shadows.js](src/effects/sun-shadows.js)'s `deferredRungs` previously said the opposite and has been corrected to point here.

`sun-shadows.js` used to promise cloud cover would arrive as *"a fourth producer into the same height field"* — i.e. **into the bake**. One shadow authority: right, and kept. That specific mechanism: wrong, and wrong in a way that would have presented as a stutter bug rather than a design error.

| | The bake | A cloud |
| --- | --- | --- |
| refresh cadence | only when the sun passes `SUN_SHADOW_QUANTIZE_DEG` — a few times a minute | drifts **continuously** |
| why it exists | geometry-derived occlusion is expensive to *derive* | closed-form; ~10 ALU ops to evaluate inline |

Baked clouds would visibly jump between bakes. The obvious repair — bake every frame — would multiply this subsystem's bake cost by roughly two orders of magnitude in order to carry a term that is nearly free to evaluate where it is used. The bake is a cache for something expensive to compute; a cloud is not that thing.

**So the cloud term joins in `effects/shadow-access.js`** — the handle every caster already reads — turning its scalar `cloudSoften`/`cloudStrength` spatial. One authority is preserved by having exactly one place that *combines*, not by having exactly one place that *stores*.

> ⚠️ `feedback_composite_only_terms_miss_shared_buffers`: the combine must produce **one node every consumer reads**, never a term each consumer re-samples for itself. That re-sampling is precisely what V2 shipped (four reshaping knobs in windows, two more in vegetation, all disagreeing) and the reason `shadow-access.js` exists at all.

---

## 5. The zoom architecture — what the brief is really about

### 5.1 Three regimes, one JS-level gate

```
        zoomed IN ──────────────── crossover ──────────────── zoomed OUT
 tops:  NOT SUBMITTED              alpha 0→1 fade             full, optionally half-res
 shad:  full octaves               full octaves               octaves band-limited down
 cost:  shadow only                peak                       shadow-lite + tops
```

**Regime A — tops not drawn.** A JS-level `if` on world-pixels-per-screen-pixel decides whether the tops draw is *submitted at all*. The material is never bound, the geometry never sent, the node graph never built.

> **⚠️ This must not be an alpha or a uniform.** `Effects.md` Law 4: *"A uniform set to zero does not remove work."* This project has already paid for that once — the occlusion block ran on every drawable with `occlusionWeights = [0,0,0,0]`, arithmetically an identity, still sampling its mask texture every frame. **The test: if turning the tops off does not shrink the submitted draw list, they are not off.**

**Regime B — the crossover.** Alpha ramps 0→1 across a band so nothing pops. **The gate sits at the START of the fade** — below it you would pay for invisible geometry; above it clouds would pop in at partial opacity.

**Regime C — zoomed out.** Tops at full strength. Shadow octaves band-limit *down* (§1.2) because the fine detail is now sub-pixel. Optionally the tops render at half-res and upsample — visually free on something this soft, and V2 already shipped `internalResolutionScale: 0.5` for exactly this reason.

### 5.2 The cost curve, honestly

Detail leaves the shadow as the tops arrive, which flattens the curve — **but it does not flatten it completely, and I am not going to claim it does.** Band-limiting saves perhaps 2–3 octaves; the tops cost a gradient (≈3 extra field evaluations) plus lighting. Net cost still *rises* somewhat when zoomed out. Two things keep that acceptable: the tops shade only where cloud actually exists (Law 6 — bounded geometry, never a fullscreen pass), and half-res is available as a tier lever exactly where it is needed.

### 5.3 ⚠️ The fork trap, and how this avoids it

Two zoom regimes behaving differently is `feedback_mode_forks_silently_drop_features` shaped — proven three times in `vt-pan-viewer`, each time resolved by deleting the losing fork.

The discipline that makes this a **ladder rung and not a fork**: *both regimes read the same field.* Zoom **adds** the tops draw; it never **switches** how a cloud is defined. There is exactly one `H(x,y,t)`, and a cloud shadow at zoom 1 is the same cloud shadow at zoom 8, band-limited. If a future change ever makes the zoomed-out clouds a *different shape* rather than the same shape drawn differently, that is the fork arriving, and it should be rejected.

### 5.4 The gate solves two problems it wasn't designed for

1. **Token legibility.** A cloud drawn over the map can obscure a token a player is trying to move — a usability problem, not a rendering one. The gate means tops only exist at zoom levels where nobody is manipulating individual tokens.
2. **The shadow-offset framing question.** At 2000 px altitude and a 30° sun, the shadow lands ~3,460 px from its cloud. Zoomed in that is bewildering (a shadow with no visible cause); zoomed out it reads correctly as altitude, because the map is large enough to contain both. **The earlier draft raised this as an open question needing a fudge factor. The zoom gate dissolves it** — V2 needed `shadowOffsetScale: 0.3` to cheat the offset down precisely because it drew tops at every zoom.

Three problems, one gate. Usually the sign a structure is right.

---

## 6. The ladder

Rungs 1..N must be non-decreasing in cost class; tier 0 is exempt (the admission price). Note how much is `C1` — analytic noise touches no memory, so **the only C8 in the system is the tops draw itself.**

| n | name | class | from | adds |
| --- | --- | --- | --- | --- |
| **0** | `drift` | C1 | — | 2 octaves, one deck, one offset sample. A soft shadow crosses the map and the light dips. **Never gated.** |
| **1** | `relief` | C1 | performance | 4 octaves + thickness — shadows gain internal structure instead of being blobs; the key/fill split lands, so a cloud reads as weather not a dimmer |
| **2** | `deck` | C1 | standard | thickness march + a **second deck** at its own altitude and drift — genuine depth, replacing V2's three hand-tuned parallax layers |
| **3** | `tops` | C8 | standard | **THE PICTURE.** Zoom-gated draw; height-field relief lit by the shared sun |
| **4** | `billows` | C8 | quality | Worley billows, silver lining, powder — cumulus reads as cumulus |
| **5** | `boil` | C8 | extreme | the third noise axis advances: clouds **change shape** as they cross, not merely translate |

**Deferred rungs** (recorded, not built): lightning-lit deck (⚠️ flips `a11y.photosensitive` to **true** — a full-screen flash is exactly what that flag protects); precipitation coupling (rain falls from dense cells, not uniformly); moonlit night clouds; volumetric tops (R4) as an `extreme` alternative to rung 4; cloud shadows *on* clouds (a high deck shadowing a lower one).

**Params: 8, where V2 had 70** (`cloud-control-schema.js`) and 60 fields on `this.params`. `cloudType01`, `cover01` *(read from `env.weather`, not a second control)*, `altitudePx`, `scalePx`, `opacity01`, `driftOffsetDeg` (wind shear), `zoomFadeStart/End`, `debugView`. Everything V2 exposed to steer a sprite simulator — pool size, sprite scale/opacity ranges, spawn arcs, roam bounds, orbit strength, drift responsiveness, decel factor, max speed — has no referent here.

---

## 7. Traps

- **⚠️ Unbounded drift kills the noise.** `worldXY + drift·t` grows without bound and `mx_fractal_noise_float` loses precision in its fractional part — clouds coarsen and eventually stop evolving. **Invisible for the first ten minutes of any test anyone would write.** Fix on the CPU: wrap the drift offset modulo the noise's spatial period before upload, so the shader never sees an unbounded value. **The boil axis needs the same wrap.** Mandatory test: advance six simulated hours, assert spatial variance has not collapsed.
- **⚠️ Drift is safe from shearing, and that is a different property.** [fluid-render.js:105-114](src/effects/fluid/fluid-render.js:105) documents the rule: a *spatially constant* time shift cannot shear. Cloud drift is one uniform applied uniformly, so it is safe — but safe-from-shearing is not safe-from-precision. Both are needed.
- **⚠️ Clouds read PREVAILING wind only** — `windHandle.ambient`, never the ground field's `openness`/`wallProximity`/`windShadow`. A cloud at altitude does not care that there is a wall. A cloud that slows over a courtyard is a bug that will look like a feature.
- **⚠️ Blend identity is 1.0, because consumers multiply** (`feedback_blend_neutral_element_is_per_blend`). Any future consumer that *adds* needs 0 and must convert at its own site.
- **⚠️ `side: DoubleSide` on the tops quad** or it culls silently and every status report says it is fine.
- **⚠️ Tops `renderOrder` derives from the floor it sits above**, never a scene-wide constant.

---

## 8. Verification

Green tests mean nothing about whether an effect draws here (`keyhole-current-state`), so:

- **Node (the field is pure):** exact `1.0` at `cover01 = 0` (not "≈1" — the parity claim depends on it); mean transmittance monotonic in cover; shadow *contrast* peaks near `cover = 0.5`; the six-hour drift test (§7); `shadowOffset(h, elev)` matches `sun-occlusion.js`'s own throw **by calling it**, never by reimplementing it.
- **CPU twin** before claiming anything — `feedback_smooth_output_hides_ported_bugs`. This is a noise field; it will look plausible while being wrong.
- **Shader Lab first.** The field is a scalar function of `(x, y, t)` — precisely what the lab's profile plot is for. Sweep cover, sweep zoom, watch the octave band-limit engage, all before a pixel reaches the real renderer. Run it live in the shared pane so the author can drive it (`feedback_shader_lab_investment_priority`).
- **A zoom sweep is a REQUIRED test.** Sweep zoom continuously across the gate and assert (a) no discontinuity in mean shadow intensity, and (b) the tops draw is genuinely absent from the submitted draw list below the gate — the Law 4 check, measured rather than assumed.
- **Live:** the author's eyes. Nothing above promotes this past **BUILT (unverified)**.

---

## 9. Build order

| Slice | Lands | Why it's the right cut |
| --- | --- | --- |
| **1** | `world/cloud-field.js` + handle + Node tests | the foundation; unblocks nothing yet but is the whole system |
| **2** | `shadow-access.js` + `environmental-light.js` read it | **a cloud shadow visibly crosses the map — the money slice**, and a complete feature on its own |
| **3** | `window-render.js#cloudFactorNode` finally fed | closes the author's own goal: *"a cloud travels across the sky and the window light inside dims and dies"* |
| **4** | water, specular, vegetation | the whole map breathes together |
| **5** | tops, rungs 3–4, behind the zoom gate | the spectacle |
| **6** | boil, second deck | the polish |

Slices 1–2 are one pure module plus two consumer edits.

---

## 10. One line

**Clouds are terrain in the sky; softness is an octave count; and the zoom that hides the cloud is the same zoom that pays for it.**
