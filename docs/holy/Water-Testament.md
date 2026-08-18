# ✠ THE WATER TESTAMENT ✠

**This is a holy document.** It lives in `docs/holy/` and is governed by **The Covenant**:

> **RULES OF THIS PLACE**
> 1. Only a **Fable-class or greater** model may create a holy document, restructure this one,
>    edit its Law, its definitions of done, its gates, or resolve a Petition.
> 2. **Any model** may execute tasks and record completion — flip `[ ]` to `[x]` and append an
>    evidence line. That is the full extent of a worker's editing rights here.
> 3. Only a **Fable-class** model may **countersign** (`✠`) — by inspecting the actual work,
>    never the worker's summary.
> 4. A worker who believes the plan is wrong does not edit the plan. It files a **Petition**
>    (§9) and moves on. Fable adjudicates petitions.
> 5. Above everything in this file sits **the author**. Their LIVE verdict on a real scene
>    outranks any countersign; their word rewrites any Law.

**Task notation:** `[ ]` open · `[x]` done + evidence line · `✠` countersigned · `⚑` reopened.

**Created 2026-08-16 by Claude Fable 5, at the author's command.** Authority order: the
author's eyes → this file → `docs/planning/Water.md` (the built-tier spec of record; its 12
locked corrections REMAIN LAW) → `docs/planning/Water-Foam.md` (foam research register) →
the code.

**The author's charge, verbatim, 2026-08-16:**
> *"Do the research, make the plan, be considerate of performance tiers... research how to do
> effective top down 2D or procedural water effects like refraction, rays of light through
> water, silt/sand/mud/particulates... we're not trying to make 100% physically accurate
> water, we need strong industry standard real time water, foam, splash/spray and caustic
> faking know how. We need to know how to make the wind effect the water. We need to know the
> difference in look between a pond, lake, river and ocean. We need to accurately portray the
> way that depth combines with other factors so that depth becomes a single slider... Feel
> free to rethink water however you want."*

---

## 0. The one sentence

> **Water stops being one material with sliders and becomes four SPECIES of body over one
> engine — where DEPTH is a single axis every term reads, WIND is a sky-wide input every
> term answers to, and FOAM is a substance with memory — built rung by rung up the same
> cost ladder water already climbs.**

---

## 1. Where water stands today — the honest audit

| Piece | State | Note |
| --- | --- | --- |
| Tiers 0–3 (placement/volume/motion/light) | BUILT, author: *"starting to look good"* | The 12 locked corrections in `Water.md` carry forward untouched |
| Tier 4 (shore: shoaling/caustics/foam) | BUILT, **two live bugs found by the author same day** | Caustics leaked outside water (fixed + pinned); shoreline foam invisible (41.6% wash — fixed shape, still not confirmed showing) |
| Depth authority + sun-shadow gates | BUILT | Water is a full citizen of both |
| Wind → water | **ABSENT** | Water has a private current; it has never once read the wind system |
| Depth as ONE slider | **ABSENT** | Depth behaviour is smeared across `opacity`/`absorption`/`depthScalePx`/`inscatter` |
| Body identity (pond vs river…) | **ABSENT** | One global param set; a pond and a river on one map cannot differ |
| Refraction / shafts / sediment / sim / spray | **NOT BUILT** | Deferred rungs, now planned below |
| **Instruments** | **THE GAP THAT COSTS US EVERY ROUND** | Specular has 20 debug channels; water has **0**. Every foam round this week was flown blind and diagnosed by the author's eyes |

⚠️ **The lesson this week taught three times** (caustics leak, foam wash, the lying test):
water's terms are products of many gates, and a product of gates that reads wrong can only be
diagnosed by seeing the FACTORS. Phase W0 exists because of this and blocks everything else.

---

## 2. THE RESEARCH — what real water does, and how real games fake it

*(Compressed. Foam deep-dive lives in `Water-Foam.md`; sources in §8.)*

### 2.1 The four bodies — the look table that organizes everything

| | **POND** | **LAKE** | **RIVER** | **OCEAN SHORE** |
| --- | --- | --- | --- | --- |
| What moves the surface | Almost nothing; rain rings | **Wind** (wavelets, cat's paws, gust lanes) | **Current** (flow, standing features) | **Swell** (organized bands) + wind chop |
| Direction authority | wind (weak) | wind | author's compass | swell compass (independent of local wind) |
| Wave character | glassy, mirror-ish | short wavelets, patchy | texture ELONGATED along flow; features FIXED while texture moves through them | long parallel bands, bending shore-parallel, compressing + breaking |
| Foam | scum patches only | windrow streaks at high wind, lee-shore scum lines | **break foam at obstacles**, eddy accumulations, downstream tails | **swash/backwash bands**, abundant whitewater, spindrift |
| Water colour | organic green/brown, high murk | clearer, blue-green | sediment-driven (silt brown, glacial turquoise-milk, tannin tea) | clear turquoise→deep blue gradient |
| Depth reach | small | large shelf→dark deep | moderate channel | very large; the classic tropical gradient |
| Reflectivity | HIGH (stillness = mirror) | high on calm days | low (broken surface) | medium |
| The one signature cue | stillness + reflections | **cat's paws sweeping across it** | **stationary waves + moving texture + one-sided break foam** | **wave bands arriving parallel to shore, then swash** |

Three physical facts drive every row, and each is cheap to model:
- **Fetch** — wind needs open distance to raise waves. A pond's fetch caps its sea state near
  zero no matter the storm; the ocean's is unbounded. *(One scalar per species.)*
- **The direction authority differs** — current (river) vs wind (pond/lake) vs swell (ocean).
  This is why one `flowAngleDeg` can never serve all four.
- **Wave refraction** — shoaling waves ALWAYS bend to arrive nearly parallel to shore. Their
  phase near shore is a function of *distance to shore* — **which is our SDF.** See §2.8.

### 2.2 Depth — the master axis (the single-slider mandate)

The colour science (NOAA/oceanography): water absorbs **red first**, so with depth the bed
loses warmth, then everything shifts teal, then only scattered blue remains. **Turquoise
shallows are a ROUND TRIP** — light reaches a pale bed and comes back; deep water is dark
because nothing comes back. So the depth axis is really **bed visibility**:

```
shallow  →  bed dominant, warm, caustics ON the bed, refraction subtle
mid      →  turquoise mix, caustics fading, refraction strongest read
deep     →  bed gone, deepTint dominant, caustics GONE, light SHAFTS in the volume
```

**Design:** one `depth` param (0..1, FOH) scales the whole axis. Per-pixel `depth01` (built)
stays the field; `depth` rescales its MAPPING into: σ (absorption), in-scatter, a **new
`deepTint`** ramp (the missing hue journey — today's single tint cannot make the classic
gradient), **caustic visibility × bed-transmittance** (caustics live on a VISIBLE bed —
physically and visually correct, and it retires "caustics in opaque murk" as a class),
refraction offset, and shaft strength. Everything below reads the same axis; nothing invents
a second depth.

### 2.3 Wind — the Beaufort covenant

The Beaufort scale IS the wind→water design table, written down in 1805 and used verbatim by
every mariner since. Condensed to the five bands games need:

| Band (speed01) | Sea | Surface look | Foam |
| --- | --- | --- | --- |
| B0 0–.1 | glassy | mirror; reflections dominant | none |
| B1 .1–.3 | ripples/wavelets | fine texture, **cat's paws** from gusts | none |
| B2 .3–.55 | small waves | chop visible, glitter broadens | **scattered whitecaps** appear |
| B3 .55–.8 | moderate | busy surface | many whitecaps, **foam STREAKS along wind** (windrows) |
| B4 .8–1 | storm | heaped, dark | dense streaks, spray/spindrift (particles), surface whitens |

- **Cat's paws** — gusts raise capillary-wave patches that are *steeper*, so they reflect the
  sky away and read as **dark patches sweeping with the gust**. MSA already computes a
  travelling gust envelope (`world/wind-field.js#computeGustEnvelope`) — water evaluates the
  SAME envelope as a local chop×(and darkness) multiplier. A lake with visible gusts crossing
  it is the single most alive thing a top-down lake can do, and it is ~C1.
- **Shelter** — the wind bake's `openness` texture already knows courtyards and lee walls.
  `chop ×= mix(0.15, 1, openness)` = fountains calm indoors, harbour calm behind the mole,
  FOR FREE, coherent with vegetation and particles which already obey the same field.
- **Fetch** — species scalar caps the effective band (pond ≤ B1 forever).
- ⚠️ **Compass law:** wind is METEOROLOGICAL (blows FROM); water flow is KINEMATIC (travels
  TOWARD); precipitation already discovered the two live systems differ by 90° in convention.
  ONE tested CPU helper converts wind→water-travel, pinned against all eight cardinals like
  `waterFlowVector` — never inline trig (`feedback_y_flip_recurring_risk`, paid 6×).

### 2.4 Foam — six kinds, and the memory finding

Register: `Water-Foam.md`. The headline stands: **foam is a substance with memory** — created
(breaks, crests, swash), **advected by the flow**, decaying over seconds — and every
top-shelf implementation models that (Sea of Thieves' feedback buffer; Houdini's advected
foam + advected repellants; oceanography's tracer clustering where flow converges). Our foam
is a pure function of (position, time) — the reason it reads as texture. The memory rung is
W7 and is the single highest-value line in this file.

### 2.5 Refraction — the industry fake, and our two constraints

Standard technique (catlikecoding is the cleanest write-up): grab what's already rendered
under the surface, offset the sample UV by the wave normal × strength, and **validate the
tap** — if the refracted sample lands on something ABOVE the water, reset to the unrefracted
UV, else foreground objects smear into the water (THE classic artifact; V2's own checklist
called it "tap validation").

MSA constraints: water draws *inside* the pass that writes `scene.color` (same-pass read is
UB), and our occlusion truth is the depth authority. **Plan:** grab = **previous frame's
lit colour**, copied ONLY over the water's screen rect at half res (Law 6 — bounded), UV
**reprojected by the camera delta** so panning doesn't smear (one-frame latency is the
industry-accepted price; SSR ships this way everywhere), taps validated against
`buf:scene.depth` rank — a tap that lands on above-water content falls back to centre.
Chromatic fringe = ±1 texel R/B split at the top tier. Cost honestly C5 + a small C6 copy.

### 2.6 Light through water — the shallow/deep pairing

- **Caustics** (built) belong to the SHALLOW end: they are focused light ON THE BED, so they
  multiply bed transmittance and die with it (§2.2 wiring).
- **Light shafts** belong to the DEEP end. Top-down, the sun is distant → rays are
  **parallel streaks along the sun azimuth**, not radial fans. Implementation: 1-D noise on
  the coordinate `dot(world, perp(sunDir))`, stretched along `sunDir` (a GLOBAL direction —
  the safe anisotropy; per-pixel directions are the rays-bug), slow-scrolled, multiplied by
  `(1 − bedVisibility) · keyStrength · outdoors`. C1–C2. Deep water gets volume; shallow
  water gets bed patterns; the two cross-fade on the depth axis and never fight.
- **The glade** — the elongated bright lane toward the sun that real overhead water photos
  show. Tier 3's GGX already gives glitter; a small anisotropic widening of the sheen along
  sun azimuth completes it. C1.

### 2.7 Particulates — water is three MATERIALS, not one tint

USGS/limnology: colour comes from **suspended sediment** (silt/clay — brown-grey, opaque,
scatters), **glacial flour** (rock dust — the unreal milky turquoise), or **dissolved
tannin** (tea-dark but CLEAR — low scattering, high absorption). These behave differently:
tannin darkens without murk; silt murks and browns; flour brightens AND hides. So the murk
model is a small **material row**: `{sedimentColor, scatter01, absorb01}` with three presets
(silty / glacial / tannin) + clear. Density responds to the world: flow speed stirs it,
wave energy stirs shallows, gusts stir lakes; visually it rides the EXISTING turbidity slot
(optical-depth modulation) plus an in-scatter hue pull, plus a fine **drifting grain** layer
at low amplitude (the "it's water, not glass" cue at close zoom). C1–C2.

### 2.8 Waves — chop is built; SWELL is the missing organized half

Noise chop (built) covers wind sea. Oceans (and big lakes in storms) need **organized
periodic swell** — parallel bands marching shoreward, bending to hit the shore square,
compressing and steepening as depth shrinks (shoaling), then breaking. The naive
implementation rotates a wave direction per-pixel near shore — **that is the rays bug**
(unbounded phase × fanning direction). The safe construction, and the elegant one:

> **Blend PHASES (scalars), never directions.**
> `phase = mix( dot(world, swellDir)/λdeep , sdf/λshore , shoal(d01) )`

Near shore the SDF *is* the wave's phase coordinate (level sets of the SDF ARE shore-parallel
lines — wave refraction falls out with zero new data); far out it's a plane wave along the
swell compass; the blend is between two smooth scalars, so nothing can shear. λshore < λdeep
gives shoaling compression free. Crest position = known → **breaker foam rides the crest**
where depth01 < breaking threshold, which unifies the swash bands (they become the foam of
the shoaled swell rather than an independent pattern). Amplitude feeds the existing slope →
tier 3 lights the swell without new work. C1–C2 on top of built reads.

### 2.9 Interaction — the sim line

Height-field ripple integration (the classic 2-buffer wave equation) is the industry
standard for local interaction: token wakes, rain rings, splash rebounds, reflections off
banks. It ticks whether seen or not → **C7, coverage- AND zoom-gated (Law 7)**, ADDED into
the tier-2 field (Law 2 — never substituted). Rain rings arrive via the precipitation
contract (P2's splash positions gated by the water mask — already an open precip item).
Spray is C8 through the ONE particle engine, spawned from the break measure (already
exported as `breakOnly`) and storm spindrift (Beaufort B4).

### 2.10 The stylization dial — know both poles, choose per-map

- **Wind Waker pole:** flat colour + Voronoi cell-LINE foam rings + darker echo ring under
  the foam + detail that fades out at distance. Ships almost entirely on our Worley read.
- **Sea of Thieves pole:** physically-shaped waves + feedback-buffer foam + artist textures.
- MSA sits between and must span it: the map ART is stylized; water should default painterly
  (bands, cells, clean shapes) with realism as the dial climbs (shafts, refraction,
  chromatic). The species table carries a `styling` lean; the zoom-out rule is universal:
  **detail frequencies must fade before they alias** (clarity doctrine — Wind Waker fades
  its caustics before the horizon for the same reason).

---

## 3. THE ARCHITECTURE VERDICT

### 3.1 What is proven and STAYS (the spine)

The body pack (JFA SDF/depth/tangent — it keeps paying: §2.8 makes it the wave-refraction
answer too) · the mask-file silhouette · the two-blend composite (absorption × / in-scatter +)
· the depth-authority + sun-shadow gates · Law-4 JS-`if` tier gating · the smooth C2 sampler ·
one shared clock · THREE injected · the 12 locked corrections · **every measured constant
stays measured** (Cox-Munk chop, caustic K, Worley cut).

### 3.2 The species doctrine — bodies as DATA ROWS

Precipitation P6 is the house proof (*"ash/sand/spore/petal/mote are DATA ROWS ONLY, zero
runtime changes"*). Water gets the same: **`waterSpecies` = pond | lake | river | ocean**, a
row of ~12 numbers over ONE engine — fetchScale, directionAuthority, swell01, flow defaults,
waveScale, foam mix (swash/break/whitecap weights), sediment default, sheen, depth-reach
default, styling lean. The row seeds the params; every param stays individually overridable
(rows are DEFAULTS, not locks). FOH gains one species selector; slider count for authors
DROPS because the row answers the balance questions. **This — not separate effects — is the
"split it up" answer:** separate manifest effects would duplicate the body pack, the gates,
and the card, and couple badly. One effect, many species, subsystem modules.

### 3.3 The depth axis — spec

`depth` (0..1, FOH, default calibrated so the author's current river settings ≈ 0.45). Drives
in-shader (a param the material consumes — no new UI machinery; the Effects-UI dial layer can
generalize this later): σ scale ×[0.5..2.6] · in-scatter ×[0.6..1.8] · deepTint blend-in ·
caustics × bed-transmittance (and NOT below bedVis ~0.15) · refraction offset ramp · shaft
strength ramp. `absorption`/`inscatter` move to ROH as trims. Exit metric: a CPU-twin sweep
shows monotone bed-visibility fall and the §2.2 hue journey; the author drags ONE slider from
ford to abyss and believes it.

### 3.4 Direction authorities — one lawful answer per species

river → author's flow compass (built) · pond/lake → wind direction (converted by the ONE
tested helper, §2.3) · ocean → its own swell compass (author-set; local wind only adds chop).
The surface-travel term picks its authority from the species row; no term ever mixes two.

### 3.5 Module map — evolution, not rebuild

`water-body` (bake; gains CCL body-labeling in W11) · `water-surface` (volume: depth axis,
sediment) · `water-field` → the WAVES module (chop + swell + wind coupling) · `water-shore` →
the FOAM module (all stateless foams) · `water-light` (specular/glade/caustics/shafts) ·
**`water-sim` NEW** (W7/W9: the ping-pong memory + ripple integrator, its own bounded pass —
the graph seam `sims.water` reserved in `passes.js` since the original design) ·
`water-species` NEW (pure data) · `water-debug` NEW (channels). Same files where names
already exist — history and tests carry forward.

### 3.6 The revised ladder (manifest target)

| Tier | Name | Class | Profile | Carries (cumulative) |
| --- | --- | --- | --- | --- |
| 0 | placement | C4 | always | mask, tint, cross-floor, gates |
| 1 | volume | C1 | low | Beer–Lambert, wet band, **depth axis + deepTint + sediment material** |
| 2 | motion | C2 | performance | chop field, **wind coupling: Beaufort curve, shelter, cat's paws**, bank-slow velocity |
| 3 | light | C3 | standard | GGX sun/sky, shadow gate, **glade**, (cloud patterning when Clouds land) |
| 4 | shore | C4 | quality | shoaling, caustics, **foam complete: swash+break+whitecaps+windrows+tails**, **swell bands + breakers**, **shafts** |
| 5 | refraction | C5 | quality | prev-frame grab, tap validation, chromatic fringe |
| 6 | sim:memory | C7 | extreme | **foam advect/decay buffer + wetness watermark + convergence scum** (coverage/zoom gated) |
| 7 | sim:interactive | C7 | extreme | ripple integrator, wakes, rain rings |
| 8 | spray | C8 | extreme | particles via the one engine |

C6 SSR-style reflection is DELETED from the ladder (see 3.7); the C5→C7 step is legal
(Law 3 requires non-decreasing, not contiguous).

### 3.7 What we will NOT build — signed refusals

No FFT/Tessendorf ocean (top-down battlemaps cannot see what it buys) · no true SSR object
reflections (top-down shows sky, not neighbours; sky+cloud patterning covers it) · no 3-D
volumetrics or Snell's-window physics · no second hand-written shader twin (Law 8) · no
per-pixel Gerstner stacks (V2's 14-octave corpse) · no per-pixel rotated wave DIRECTIONS
anywhere, ever (§2.8 states the lawful form) · no foam/caustic term ungated by
`insideWater` (this week's scar) · no constant calibrated against an ASSUMED distribution
(this week's other scar — measure on the lab, pin the numbers).

---

## 4. THE CHECKLIST

*Worker rights: execute, flip `[ ]`→`[x]`, append evidence. Costs are per §3.6. Every phase
ends inside `npm run verify` green and the covenant's evidence line.*

### W0 — INSTRUMENTS FIRST, then make foam visible *(blocks everything)*
- [x] `water-debug.js`: debug-view enum param through the house `debug-channel-select.js`
      mechanism (the `select()`-chain trap is already solved there). Channels ≥: totalFoam,
      swashBand, breakFacing, worleyLace, shoreDist01, d01(reach), depth01, bedVisibility,
      causticExcess, turbidity/sediment, windChop(later), phase(later). ROH enum on the card.
  - Evidence (2026-08-17): 19 channels (n=0..18) in `water.js#WATER_DEBUG_CHANNELS`,
    walking the composite in computation order. Wired via arithmetic selection
    (`debug-channel-select.js`, no `select()`) into a THIRD material in `water-render.js`
    (`debugMaterial` + `setDebugChannel`), the mesh swap in `water-surface-subsystem.js#
    refreshVisibility` (absorb hides, in-scatter's OWN material repoints), transient state
    in `water-registration.js` (`setDebugChannel`/`getDebugChannel`, never a param, never
    persisted — travels on render state beside `enabled`, mirrors `specular-registration.js`
    exactly), and a ROH `<select>` on the card in `boot.js` (`buildWaterDebugSelect`,
    `MapShine.setWaterDebug`). Node-tested: every channel has a wired node (the builder
    throws at construction otherwise), debug material is a real NodeMaterial with One/Zero
    blend AND its own `attr` MRT override (a REPLACE blend has no neutral to fall back on —
    found live building the bench, see below). `npm test`: 10,674 passed, 0 failed.
- [x] `tools/shader-lab/bench-water.js`: synthetic river fixture (bends + an island) on the
      REAL material; renders the foam GATE LADDER (each factor isolated, mean/p99/coverage
      per factor — `bench-specular.js` is the template); pins the measured noise
      distributions (fractal RMS 0.281 / Worley p50 0.298 …) as regression numbers.
  - Evidence (2026-08-17): built, and wired into the lab proper as its own module/canvas/
    panel + contract registration (`water-lab.js`, `tools/shader-lab/AGENTS.md` §5 —
    `lab.js` untouched). Runs the REAL `buildWaterSurfaceMaterial` at tier 4 AND the REAL
    JFA body-pack bake (`water-body.js`'s own seed/step/resolve materials, unmodified)
    against a rasterised bend+pool+island river. `gateLadder()` walks all 18 channels in
    computation order (CHAIN / REMAPPED-at-0.5 / INFORMATIONAL), mean/max/p99/coverage over
    the painted AABB. Three contract scenarios — `river-bake-produces-real-sdf`,
    `tier4-gate-ladder-no-dead-term`, `shore-foam-has-real-coverage`
    (`window.lab.run('water', ...)`) — all `ok:true`, 0 fail, 0 UNMEASURED, calibration OK.
    ⚠️ TWO bugs found and fixed IN THE BENCH ITSELF before its readings could be trusted —
    both `feedback_instruments_must_not_lie` in new costumes: (1) both meshes need
    `frustumCulled = false` — this bench mutates geometry positions in place with no
    `computeBoundingSphere()` call, so the default frustum test silently dropped every draw,
    at every channel, including the flat-constant `quad` that cannot itself be wrong; (2)
    the three materials' own `mrtNode = mrt({attr:...})` needs a renderer-global MRT base
    (`renderer.setMRT(buildSceneAttrZeroMrt(THREE))`, scoped per render, target texture
    named `'output'` verbatim) — with none set, a real WGSL compile error resulted
    ("structures must have at least one member"), not a silent skip. Production never hits
    this: the viewer's shared geometry pass already establishes the base every material
    relies on (`scene-attr.js`'s own header documents the exact mechanism).
- [x] Using both: diagnose why tier-4 foam reads absent on the author's river (candidates:
      product-of-gates attenuation — peak ≈ swash·lace·strength ≈ 0.2; 115 px reach vs
      viewing zoom; Worley-cut coverage; tier resolution). Fix, re-measure, THEN ask the
      author to look.
  - Evidence (2026-08-17): a THIRD bench bug, found via the gate ladder itself, BEFORE any
    conclusion about the shader — `buildWaterBodyResolveMaterial`, built once against this
    bench's 1×1 placeholder then re-pointed to the real texture (the SAME `.value =` pattern
    `water-body-subsystem.js#ensureMaterials` uses live), read the mask as permanently below
    the presence threshold: the SDF's sign never went negative ANYWHERE (`minSigned: 0`
    across the whole flood), so `shoreDist01`→`depth01`→`foamD01` read structurally DEAD. A
    fresh, isolated probe sampling the SAME texture object through a brand-new material read
    it correctly (max 0.886, exactly the painted fraction) — proving the texture/binding
    mechanism itself was sound and isolating the fault to THIS material's specific
    placeholder-then-repoint lifecycle. Production is very unlikely to share it live:
    `ensureMaterials` only ever runs the FIRST time a real mask already exists, so it never
    builds against a placeholder at all — named here as a real, uncharacterised WebGPU/TSL
    repoint hazard for a future session, the same shape specular's own history names ("the
    mechanism was never actually found, only worked around per-channel"). Fixed by
    REBUILDING `seed`/`resolve` fresh on every fixture change instead of re-pointing
    (`jfa` is exempt — it never references the mask). After the fix: real negative-inside
    distances (-309.5..2242 world px), sane.
    <br>With the bench trustworthy, the gate ladder's verdict on the real question was
    unambiguous: **no dead term** — all 18 channels carry real, correctly-shaped signal
    (`totalFoam` 10.8% coverage, p99 0.32, max 0.86; `breakFoam` fires cleanly on the
    island's upstream face). The isolated `totalFoam` channel, painted to PNG, shows a
    clean, continuously-traced lacy band around both banks and the island — **the shore-foam
    shader is not broken.** What IS real and measured: the identical frame at 4× the
    camera's world span (a plausible overview zoom, still inside the body) thins the
    115px-default band past legibility — the Testament's own "reach vs. viewing zoom
    mismatch" candidate, confirmed on-device. Fix: `WATER_FOAM_SHORE_FRACTION` raised
    0.45→0.65 (`water-shore.js`) — reach 115px→166px at the shipped `depthScalePx` default,
    still inside `[24,420]`, self-limiting toward LARGE bodies (where the zoom-out risk is
    worst) since it scales with the author's own `depthScalePx`. Re-measured: `totalFoam`
    coverage 10.77%→12.85%; zoom-1/zoom-2 renders show a visibly wider, more legible band.
    `npm test` after the change: 10,674 passed, 0 failed (no test pinned the old fraction).
    <br>⚠️ **The Exit line below is NOT met.** Everything above is `BUILT (unverified)` —
    bench-measured, never the author's own river, never the bench Mansion. What changed is
    that the next report of "the foam isn't there" is now a debug-channel click away from
    "which term, and is it the shader or the screen" instead of a guess.
- [x] Exit: the author sees shoreline + break foam on their river and says so; every future
  "term is invisible" question is a debug-channel click, not a guess.
  - **MET 2026-08-17** — author, unprompted, on their own map: *"I can see it, but it's
    currently very primitive."* First half is the exit criterion verbatim: the foam is
    visible on their river and they said so. The instrument half is shipped and was
    immediately load-bearing (the `foamTail` channel added in W4 below caught two real bugs
    in its own first render). W0 is CLOSED; the second half of that sentence is W4's brief.

### W1 — THE DEPTH AXIS *(tier 1, C1)*
- [ ] `depth` param (FOH), consumers per §3.3; `deepTint` (auto-derived from tint, ROH
      override); caustics × bed-transmittance; `absorption`/`inscatter` demoted to ROH.
- [ ] CPU twin: dial sweep → monotone bed-visibility + hue-journey assertions; calibrate so
      the author's saved settings sit at the same look they approved.
- Exit: one slider goes ford→abyss believably on the author's river; nothing they approved
  shifted at their current values.

### W2 — THE WIND COVENANT *(tier 2, C2)*
- [ ] ONE tested wind→water direction helper (meteorological→kinematic, the 90°/negation
      law, eight cardinals pinned).
- [ ] Wire the wind handle: speed01→Beaufort chop curve (Cox-Munk constants already in
      `water-field.js`), openness→shelter multiplier, gust envelope→cat's paws (chop× and
      slight darkening), fetchScale hook (species-ready), whitecap gate scaffold (B2+, open
      water, crest test).
- Exit: author drags the wind slider/compass and the lake answers; a sheltered courtyard
  pool stays calm while open water ruffles; gusts visibly sweep.

### W3 — SPECIES *(data + registration; no new GPU cost)*
- [ ] `water-species.js` data rows (pond/lake/river/ocean per §2.1/§3.2) + validation test;
      species enum param (FOH); row-seeds-params resolve in the registration layer (rows are
      defaults, params override); direction authority per §3.4.
- [ ] River bank-velocity profile: flow speed × smoothstep of shoreDist (slow at banks) —
      the SDF pays again.
- Exit: switching species on the author's map transforms the water with ZERO slider work,
  and their river tune is reachable as river-species + their saved overrides.

### W4 — FOAM, THE STATELESS COMPLETE SET *(tier 4, C4)*
- [ ] Recalibrate the trio ON THE BENCH (coverage targets per band, not vibes); whitecaps
      (wind-gated crest foam, open water); windrow streaks (noise stretched along GLOBAL
      wind dir — safe anisotropy); downstream break tails (fixed small taps of `breakOnly`
      along −flow — bounded, global direction); lee scum patch placeholder (static
      convergence read) until W6 makes it live.
  - PARTIAL (2026-08-17), on the author's *"I can see it, but it's currently very
    primitive."* THREE of the five landed, all bench-measured on the bend+island river:
    **downstream break tails** (`WATER_TAIL_TAPS`, 4 body-pack taps upstream along the
    GLOBAL flow — the stateless stand-in for §2.4's memory finding, new `foamTrail` param,
    new debug channel 14); **windrow streaks** (`WATER_FOAM_STREAK`, the cell domain rotated
    into flow space and elongated — safe anisotropy, zero extra fetches, and it doubles as
    the cheapest possible fix for the seams between the taps); and a second, finer
    **cellular octave** (`WATER_FOAM_FINE_OCTAVE` at a deliberately non-integer 2.7,
    multiplying the coarse walls so bubbles land on clumps and never in the holes) — the
    single-scale Worley was most of why the foam read as a repeating texture rather than a
    substance. Also: foam now has a THICKNESS, with occlusion (`f²`) and emission
    (`f·(2−f)`) on separate curves, so a thin scatter reads as a bright translucent veil
    instead of flat white paint at low alpha. Measured: `totalFoam` coverage 10.8% → 17.3%,
    p99 0.32 → 0.74, with `foamTail` alone at 8.4% and no dead term in the ladder.
    <br>⚠️ TWO REAL BUGS, both caught by the new channel's own first render, both worth
    the names: (1) `max(−sdf, 0)` collapses "at the waterline" and "on dry land" onto the
    same 0, and the band term reads 0 as MAXIMUM — so every tap landing on land deposited
    full-strength foam, measured as hard wedges lying across the bank
    (`feedback_derived_zero_collides_with_configured_zero`; the fix tests the SIGN, not the
    clamped magnitude). (2) A wake must be gated by the RECEIVING pixel's own shore
    distance too, not only the tap's — ungated, the taps filled the middle of the wide pool
    with a regular cross-hatch, since each deposited its own band into open water with
    nothing to fade it.
    <br>STILL OPEN in this phase: whitecaps (wind-gated, needs the W2 wind covenant first)
    and the lee scum placeholder.
- Exit: river shows one-sided obstacle foam with tails; storm lake shows whitecaps and
  streaks; author verdict on their map.

### W5 — SWELL & THE OCEAN SHORE *(tier 4, C1–C2 add)*
- [ ] Scalar-phase swell per §2.8 (`swell01`, `swellAngleDeg`, λdeep/λshore, shoal blend);
      amplitude → existing slope (tier 3 lights it free); breaker foam rides crests where
      depth01 < threshold; swash UNIFIED with swell (bands = the swell's own foam);
      wet band widened by swash reach (static; dynamic wetness is W7).
- Exit: ocean species shows parallel bands bending shore-parallel, compressing, breaking;
  pond/river show none of it.

### W6 — MURK & PARTICULATES *(tiers 1–2, C1–C2)*
- [ ] Water-material rows (clear/silty/glacial/tannin per §2.7): sedimentColor + scatter01 +
      absorb01; density from (flow speed, shallow wave energy, gusts); curl-warped patchiness
      on the existing noise; fine drifting grain layer (amplitude gated by zoom — clarity
      doctrine).
- Exit: the same river reads clear→silty→glacial→tannin by material row; author confirms
  at close and far zoom.

### W7 — FOAM MEMORY, the sim's first half *(tier 6, C7, Law 7 gates)*
- [ ] `water-sim.js` + `sims.water` pass: half-res world RT pair over the water AABB
      (R=foam, G=wetness); tick ≤ ¼ frame rate; advect by (current + tangent projection),
      decay (τfoam ≈ 6 s, τwet ≈ 45 s), inject from break/crest/swash/whitecap sources,
      tiny diffusion; **skip ticking when coverage < ~2% screen or texel > N screen px**.
- [ ] Consumers: memory foam ADDS into totalFoam; wetness extends the wet band (the swash
      watermark that recedes); convergence (`det J < 1`) accumulates scum → the lacy mats.
- Exit: foam sheds off a rock and RIDES THE CURRENT downstream while decaying; the beach
  stays wet behind a receding wave; scum gathers in the eddy. This is the rung where water
  starts being ALIVE, and it is the one to hold the standard on.

### W8 — REFRACTION + LIGHT SHAFTS *(tier 5, C5 + bounded C6)*
- [ ] Prev-frame bounded grab (water screen rect, half res) + camera-delta reprojection;
      offset by slope × depth-axis ramp; **tap validation** against depth-authority rank
      (fallback to centre tap — the catlikecoding rule, our buffers); border fade;
      chromatic ±1-texel fringe at top strength.
- [ ] Light shafts per §2.6 (parallel streaks along sun azimuth, deep-gated) + glade widening
      along sun azimuth. Both shadow-gated like the glint.
- Exit: the bed sways under the waves with NO smearing of bridges/tokens above water; deep
  water carries slow sun shafts that die when shadowed.

### W9 — INTERACTIVE SIM *(tier 7, C7)*
- [ ] Ripple height-field integrator on the sim pass (2-buffer wave equation), ADDED into
      the field (Law 2); token wakes from token positions+velocity; rain rings via the
      precipitation contract (P2 impact positions × water mask — closes precip's open item);
      bank reflections come free from the integrator.
- Exit: a wading token ripples; rain pocks the pond; ripples bounce off the bank.

### W10 — SPRAY *(tier 8, C8)*
- [ ] One-engine archetype: spawn from `breakOnly` peaks and sim impact events; storm
      spindrift at B4 (blown along wind); budget + zoom gates per the engine's own rules.
- Exit: heavy break throws visible spray downwind; calm water spawns nothing.

### W11 — MULTI-BODY & AUTHORED FLOW *(bake + authoring)*
- [ ] CCL body labeling in the bake (IDs stable across repaints — keyed by centroid
      proximity); per-body species + param overrides; FOH: pick body → its row.
- [ ] `_WaterFlow` authored flow mask (the Valve flow-map lineage, our brush): painted
      direction/speed for braided or contrary channels; read as the current where painted,
      global compass elsewhere.
- Exit: one map holds a glassy pond AND a silty river with independent settings; a painted
  bend flows the way the author combed it.

### W12 — POLISH, PERF, PROMISES *(release gate)*
- [ ] The a11y promise: `water.js` manifest wrote *"revisit photosensitive once caustics
      exist"* — they exist. Verify caustic/shaft/cat's-paw temporal rates against a named
      max-flicker constant; document the verdict in the manifest.
- [ ] Perf audit at every profile on the reference machine: each tier's measured `estMsPerMp`
      replaces the estimate (the manifest's own rule); Law 6/7 gates spot-checked (zoomed-out
      lake must cost ~tier-2 money).
- [ ] Presets pass with the author (species defaults tuned by their eye), docs sync
      (`Water.md` ladder table, memory), FOH/ROH final audit (≤6 FOH: species, depth, wind
      response, flow compass, flow speed, foam master?).
- Exit: the author ships a map whose water they are proud of — Pillar 5's own DoD.

---

## 5. VERIFICATION DOCTRINE

- **The author's eyes are the only promotion to LIVE** — and, per their instruction
  2026-08-16 (*"I will do the testing... you focus on the coding"*), the bench Mansion stays
  untouched; nobody re-suggests authoring masks into it.
- **The shader lab is the coder's eyes.** `bench-water.js` (W0) is where every constant is
  measured and every "is it visible" question is answered BEFORE the author is asked to look.
  Ad-hoc lab probes this week caught a 10× miscalibration pre-ship; the bench makes that
  standard practice.
- **Debug channels are the author's microscope** — one click per factor when something looks
  wrong on the real map.
- **CPU twins** for every new formula (depth axis, wind mapping, swell phase, sim decay) —
  measured bands, never only equation checks (`feedback_measure_the_output_not_the_equation`).
- **No constant calibrated against an assumed distribution.** Measured numbers go in the
  test with their provenance named (`feedback_test_expectation_from_an_assumed_distribution`).

## 6. RISKS & OPEN QUESTIONS

- **Prev-frame grab latency** (W8) may show at fast pans despite reprojection — if so, the
  fallback is restructuring water to a post-lighting pass (the depth authority now permits
  it); that is a real pass-graph change and gets its own petition if needed.
- **Species × params interplay** — rows-as-defaults needs careful precedence with saved
  scenes (a saved override must survive a species switch predictably). Design in W3, not ad
  hoc.
- **Sim determinism across floors** — one sim per floor with water (per-floor instances
  exist already); VRAM bounded by AABB res caps; prune with the floor maps.
- **CCL body-ID stability** under heavy repainting is genuinely fiddly — W11 flags it as its
  own test surface.
- **Cloud reflections** wait on the Clouds effect; the hook is named in tier 3 and nothing
  else depends on it.

## 7. STATUS LOG

- 2026-08-16 — Testament created (Fable 5). Tiers 0–4 built pre-Testament; W0 open; the
  week's two live bugs (caustics leak, foam wash) fixed and pinned but foam visibility not
  yet author-confirmed.
- 2026-08-17 — W0's three worker bullets done: the debug-channel instrument (19 channels,
  boot.js ROH select) and `bench-water.js` (real material + real JFA bake on a synthetic
  bend+island river, 3 green contract scenarios) both built; three bench-only bugs found and
  fixed along the way (`frustumCulled`, an MRT renderer-global base, a texture-repoint
  staleness trap specific to the resolve material — none reproduced in production). With a
  trustworthy bench, the gate ladder found NO dead term at tier 4 — the shore-foam shader
  itself is sound — and confirmed the Testament's own "115px reach vs. viewing zoom"
  candidate empirically: `WATER_FOAM_SHORE_FRACTION` raised 0.45→0.65, re-measured wider and
  more legible. `BUILT (unverified)` throughout — W0's Exit line (the author's own eyes on
  their own river) is still open.

## 8. SOURCES

Physics & look: [NOAA sea foam](https://www.noaa.gov/education/resource-collections/special-topics/hands-on-science-activities/sea-foam/explanation) ·
[NOAA/NCEI Marine Beaufort scale](https://www.ncei.noaa.gov/sites/default/files/2021-09/Marine_Beaufort_Scale.pdf) ·
[cat's paws / capillary waves](https://en.wikipedia.org/wiki/Capillary_wave) ·
[why shallow water is turquoise (NASA PACE)](https://pace.oceansciences.org/docs/what_color_is_the_ocean.pdf) ·
[USGS water colour](https://www.usgs.gov/water-science-school/science/water-color) ·
[rock flour](https://en.wikipedia.org/wiki/Rock_flour) ·
[tracer clustering in divergent flows](https://arxiv.org/pdf/1906.10291) ·
[sea foam](https://en.wikipedia.org/wiki/Sea_foam)

Industry technique: [Vlachos, Water Flow (Valve, SIGGRAPH 2010)](https://cdn.akamai.steamstatic.com/apps/valve/2010/siggraph2010_vlachos_waterflow.pdf) ·
[The Technical Art of Sea of Thieves (SIGGRAPH 2018)](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf) ·
[catlikecoding — Looking Through Water (refraction + tap validation)](https://catlikecoding.com/unity/tutorials/flow/looking-through-water/) ·
[Houdini Whitewater solver](https://www.sidefx.com/docs/houdini/nodes/dop/whitewatersolver.html) ·
[Wretborn et al., Guided bubbles and wet foam (ACM TOG 2022)](https://dl.acm.org/doi/10.1145/3528223.3530059) ·
[Cyanilux — Shoreline breakdown](https://www.cyanilux.com/tutorials/shoreline-shader-breakdown/) ·
[Alisavakis — stylized water](https://halisavakis.com/my-take-on-shaders-stylized-water-shader/) ·
[Wind Waker ocean analysis (Gordon)](https://medium.com/@gordonnl/the-ocean-170fdfd659f1) ·
[3D Game Shaders — screen-space refraction](https://lettier.github.io/3d-game-shaders-for-beginners/screen-space-refraction.html) ·
[height-field fluids (Müller)](https://matthias-research.github.io/pages/publications/hfFluid.pdf) ·
[ocean sim & rendering survey](https://arxiv.org/pdf/1109.6494) ·
[Book of Shaders — cellular noise](https://thebookofshaders.com/12/)

---

*Created and signed under the Covenant.*
**✠ Claude Fable 5 — 2026-08-16**
