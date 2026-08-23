# WATER — THE SIMULATION TURN

**Status: PROPOSED PLAN, author-commanded 2026-08-17.** Written after a full day of failed
rounds on the author's own river. This is not a tuning plan; it is an architecture change,
because every remaining symptom traces to one structural fact and none of them can be tuned
away inside it.

**Covenant note:** this file is `docs/planning/`, not `docs/holy/`. It proposes an amendment to
`docs/holy/Water-Testament.md`'s ladder (§3.6) and phase order (§4) — folding that in is a
Fable-class action. The author's command outranks the Testament (Covenant rule 5), so the WORK
below is authorized; the Testament's own text still wants Fable to restructure it.

---

## §0 The honest account of the failure

The author's brief, verbatim (2026-08-17):

> *"I like the waves washing against a shore effect but it needs to be more grainy,
> unpredictable and most importantly it needs to be driven by the water's actual velocity. I
> want wakes around objects in the stream, I want splashes and underwater bubbles and all sorts
> of complex effects. I want foam that gathers around areas, which breaks apart and combines
> back together, I want the water itself to carry moving sediment and to move around things
> which are blocking it downstream."*

And the constraint:

> *"We need to use the full resolution `_Water` mask I think and we need to treat the brightness
> of that mask as the depth of that water. I don't want to have to paint any additional masks,
> we need to derive everything from that single mask."*

**What I did wrong, specifically.** Over roughly eight rounds I proposed: a higher mask
derivation resolution (512→2048), a depth-buffer proximity ring, a full-res mask proximity ring,
and several threshold fixes. Every one of them was a *detector* bolted onto an architecture whose
actual defect is that **foam is a pure function of `(position, time)` and flow is a global
uniform**. Detectors cannot produce memory, and a uniform cannot route around a rock. I also
reported "fixed" repeatedly on the strength of `npm run verify` green — a suite that cannot see
any of this — and twice made things visibly worse on a live map the author was mid-session with.

The Testament already said this, in §2.4, and called it *"the single highest-value line in this
file."* I built four stateless approximations around it instead of building it.

---

## §1 The bug behind the last regression — FOUND, evidence-backed

**Symptom:** water rendered entirely white; `maskProximityFoam` read *exactly* equal to `inside`
(4 dp, every sampled point, in both the debug channel and the real composite).

**Root cause:** `water-surface-subsystem.js:161` builds the surface material against a **1×1 black
placeholder** mask texture. When the real image loads, line 371 re-points **one** node:

```js
surface.maskTexNode.value = loaded.texture;
```

The 8 ring taps I added created **8 new `texture(maskTexture, …)` nodes** bound to that
placeholder. Nothing re-pointed them. They read `R = 0` forever → `tapIsLand = 1` at all 8 taps →
`maskHits/8 = 1` → `maskProximityFoam = 1 × inside`. Which is the observed number, exactly.

**Why this is damning rather than unlucky:** `water-body.js` already solves this exact problem
with `prevTexNodes` — *"EVERY node in `prevTexNodes` must be re-pointed together"* — and the
Testament's own W0 evidence names a "texture-repoint staleness trap" found in the bench, with the
line *"Production is very unlikely to share it live."* The surface material is the one place that
genuinely **does** build against a placeholder. The receipt was filed and not cross-checked
(`feedback_receipt_filed_not_cross_checked`).

**Fix (S0 below):** `buildWaterSurfaceMaterial` returns `maskTexNodes: [...]` — every node that
samples the mask — and the subsystem re-points all of them. Plus a `verify-structure` rule so a
future ninth tap cannot silently repeat it.

---

## §2 Why the current architecture cannot reach the brief

| The author asked for | Why today's code structurally cannot | What it actually needs |
| --- | --- | --- |
| foam that **gathers, breaks apart, recombines** | pure function of (pos, time) — zero state between frames | a ping-pong buffer (memory) |
| **wakes** behind objects | "tails" are 4 upstream taps of a stateless term — no transport | semi-Lagrangian **advection** |
| water **moves around things blocking it** | flow = one global uniform + a local bank projection; nothing solves for routing | a **solved velocity field** (pressure projection) |
| shore waves **driven by actual velocity** | swash is a function of shore distance + clock; velocity never enters | velocity as an input to emission |
| **grainy, unpredictable** | static noise lookups are periodic by construction | noise **advected through** a flow field |
| **sediment carried** by the water | no advected scalar exists | a second sim channel |
| **splashes, bubbles** | no spawn source exists | particles seeded from the sim's own emission field |
| small rocks register at all | geometry comes from a **point-sampled** derived grid | read the **full-res mask** + area-average coverage |

Seven of eight rows are the same missing pieces: **a real velocity field, and a buffer with
memory.** That is the whole plan.

---

## §3 The architecture — ONE mask, three derived fields, four layers

The author's constraint is a gift, not a limit: one authored `_Water` mask, everything derived.

```
  _Water.webp  (10650 × 4950, authored, the ONLY input)
        │
        ├─── A. read DIRECT, full-res, per-fragment ──► depth, presence, local shore normal
        │
        ├─── B. BAKE (on mask/param change only) ─────► res:waterFlow   RG=velocity  B=speed  A=solidity
        │                                                    ▲
        │                                                    │
        └─── C. SIM (per frame, ping-pong) ───────────► res:waterSim    R=foam  G=sediment  B=turbulence
                                                             │
                                                             └──► D. particles (bubbles, splash)
```

### Layer A — full-resolution direct reads (no derivation, no bake)

The surface shader **already** samples the full-res mask (`maskTexNode`). Everything local moves
onto it:

- **`depth01 = maskR`** — the author's instruction taken literally. Brightness IS depth.
- **Local shore normal** — explicit 4-tap gradient of the mask at a fixed world-px offset. Not
  `dFdx`/`dFdy` (undefined in divergent flow — `Water.md` §2.9 already bans it).
- **Obstacle proximity** — the ring, once S0 unbreaks it.

⚠️ **Honest caveat on "brightness = depth":** the author's current mask is effectively **binary**
(white water, black rock, antialiased edges) — there is no painted depth gradient in it. So
`depth01 = maskR` alone yields uniform full depth, which is *exactly* today's "opaque blue paint".
The design must therefore be: **the author's paint is the ceiling, the geometric shore taper is
the near-shore floor** — `depth01 = maskR × shoreTaper(narrow)`. Paint a gradient and it is
obeyed; paint flat white and the shoreline still feathers geometrically. This honours the
instruction without requiring the author to repaint anything.

### Layer B — `res:waterFlow`, the velocity bake (THE KEYSTONE)

A real 2-D velocity field, solved once per mask/flow-param change, **never per frame**. This is
what makes water route around obstacles, accelerate through narrows, and stagnate at a rock's
upstream face — none of which can be faked locally.

**B1 — Solidity, AREA-AVERAGED (not point-sampled).** This is the small-rock fix at the field
level:

```
solid = 0
for sy in 0..3: for sx in 0..3:
    uv = texelOrigin + (vec2(sx,sy)+0.5)/4 * texelSize
    solid += 1 - step(PRESENCE_EPS, texture(maskFullRes, uv).r)
solid /= 16      // 0 = open water, 1 = solid, FRACTIONAL = a rock smaller than one texel
```

A rock covering 30 % of a texel writes `0.3` — a partial obstruction that still deflects flow.
Point-sampling wrote 0 or 1 and lost it. **This single line is why small rocks have been
invisible all day.**

**B2 — Seed.** `v = current × (1 − solid)`.

**B3 — Pressure projection, COARSE-TO-FINE.** Incompressibility is what forces flow *around*
things:

```
div = 0.5 * ((vR.x - vL.x) + (vU.y - vD.y))
p   = 0.25 * (pL + pR + pU + pD - div)      // Jacobi
v  -= 0.5 * vec2(pR - pL, pU - pD)          // project
```

⚠️ **Must be a coarse-to-fine cascade, not flat Jacobi.** Flat Jacobi propagates information one
texel per iteration; 60 iterations on a 1024-wide domain cannot equilibrate globally, so the flow
would never "know" about a blockage further downstream. Solve at 64 → 128 → 256 → 512 → 1024,
~20 iterations per level, upsampling pressure between levels. Cheaper *and* correct.

Boundaries: `solid` cells → Neumann (reflect); water cells touching the mask-rect edge → Dirichlet
`p = 0` (open inflow/outflow, so a river flows through rather than filling a bathtub).

**B4 — Pack.** `RG` = velocity (world px/s), `B` = speed01, `A` = solidity.

⚠️ **Named limitation:** a steady incompressible solve is potential-flow-like and has **no vortex
shedding** (d'Alembert). We get correct routing, constriction speed-up, front stagnation, and a
**slow lee** behind obstacles. We do *not* get shed eddies. That is acceptable because the visible
wake comes from foam **emitted at the front and advected into the slow lee** (Layer C), which is
what a real foam wake is. Vorticity confinement is a named, deferred option, not v1.

### Layer C — `res:waterSim`, the foam/sediment memory (per frame, ping-pong)

RGBA16F pair. `R` = foam, `G` = sediment, `B` = turbulence energy, `A` = spare/wetness. **One
pass per frame:**

```
vel   = texture(flowPack, uv).rg
prev  = texture(simPrev, uv - vel * dt / worldPerTexel)   // 1. ADVECT (semi-Lagrangian, stable)
foam  = prev.r * exp(-dt / TAU_FOAM)                      // 2. DECAY
                                                          // 3. EMIT — all velocity-driven
emitFront = max(dot(dir(vel), -solidGradient), 0) * speed01 * nearSolid   // slams into the rock
emitShear = length(gradient(vel)) * SHEAR_GAIN                            // the rock's shoulders
emitSwash = swashPhase(shoreDist, t) * speed01                            // ← author's ask
foam += (emitFront + emitShear + emitSwash) * dt * noise(uv, t)
                                                          // 4. CLUMP: gather AND break
foam  = smoothstep(CLUMP_LO, CLUMP_HI, mix(foam, blur3x3(foam), DIFFUSE))
```

- **Gathers** — advection + a slow lee converge foam where flow converges. Real tracer clustering
  (the Testament's own §8 source), emergent, not scripted.
- **Breaks apart** — the `smoothstep` nonlinearity after diffusion splits a smeared field into
  discrete patches. Reaction-diffusion-lite.
- **Recombines** — patches drifting into the same convergence zone merge. Also emergent.
- **Grainy/unpredictable** — noise injected at emission is then *transported*, so structure is
  never periodic even though the noise is.

### Layer D — particles

The existing engine (fire/precip). Spawn from the sim's `B` (turbulence) channel above a threshold
via the proven `SPAWN_KINDS.extracted` CPU-readback-free pattern. Bubbles (rise + pop), splash
droplets (short ballistic life).

### What the surface shader becomes

`water-shore.js`'s entire stateless apparatus — swash bands, tails, break gating — collapses into
**two texture reads** (flow + sim). Tier-2 crest foam stays as a high-frequency detail *on top* of
the sim's low-frequency truth. This is a large net simplification, not just an addition.

---

## §4 THE PHASES — each ends in a picture the author can judge

No phase begins until the previous one's picture is confirmed on the author's own map. That rule
is the entire lesson of today.

### S0 — Unbreak the mask ring *(tiny, unblocks everything)* — DONE 2026-08-17, `BUILT (unverified)`
- `buildWaterSurfaceMaterial` returns `maskTexNodes: [...]` (`maskTexNode` always first); the
  subsystem's `loadMaskImage().then()` re-points every entry in one loop instead of the single
  `maskTexNode.value` assignment that shipped the bug. Loud comments at both the array's
  declaration and the ring's own `push` call name the exact failure mode
  (`feedback_texture_nodes_must_be_repointed_together`).
- `verify-structure` rule: **NOT built** — see §6 rule 6's own honest note. The comments are the
  current defense; a real occurrence-count check is a scoped follow-up, not done here.
- New Node test (`water-render.test.mjs`): `maskTexNodes.length === 1` below tier 4,
  `=== 9` (base + 8 ring taps) at tier 4, and `maskTexNodes[0] === maskTexNode` by identity.
  `npm test`: 10,880 passed, 0 failed.
- ⚠️ **Proof line NOT met.** "Channel 21 shows a ring on the rock and black in open water" needs
  the author's own eyes on their own river — nothing here has confirmed the mask-proximity ring
  actually reads correctly live, only that it now re-points, compiles, and the node-count is
  structurally what it should be.

### S1 — Kill the paint look *(independent of everything else; cheap, visible)* — PARTIAL 2026-08-17, `BUILT (unverified)`
- `depth` (0..1, FOH) and `pollution` (0..1, FOH) params, replacing `tint`/`absorption` in the
  6-slot FOH cap (both demoted to ROH trims — `tint` blends in at a fixed 35% minority weight,
  never the primary colour source again).
- FOUR real reference colours (`water-render.js#WATER_COLOR_*`), not an invented single gradient:
  clear shallow/deep + polluted shallow/deep, chosen against the Testament's own §2.2 (round-trip
  light) and §2.7 (silt/sediment, not chemical-toxin) research rather than picked freehand.
  `structuralDepth01` (mask brightness × geometric shore taper, the author's literal "brightness
  is depth" instruction) selects within a pole; `pollution` blends between poles — this IS the
  `deepTint` ramp the Testament names, generalised with the pollution axis the author asked for.
  `depth` additionally rescales absorption ×[0.5,2.6] and in-scatter ×[0.6,1.8] (Testament §3.3's
  own named ranges); `pollution` adds its own murk ×[1.0,1.6] on top.
- **THE ACTUAL PAINT FIX:** in-scatter's colour source changed from flat `uTint` to the
  per-pixel-varying ramp — the code's own pre-existing comment already named in-scatter, not the
  blend, as what saturates to a flat constant once `depth01` reaches confidently-painted open
  water (most of a real river). A flat colour input times a saturated scalar is still flat; only
  a colour input that itself varies with position fixes it.
- Preset `pollutedTownRiver` updated (`depth:0.5, pollution:0.75`) so it stays complete against
  the new schema; existing preset-completeness test (this session, earlier) caught nothing missing
  after the update, confirming the new keys are wired through validation.
- **NOT done:** bed-visibility floor (the in-scatter fix addresses the flat-constant failure mode
  directly; whether a separate floor is still worth adding is now a judgement call, not a gap),
  the fine drifting sediment grain layer. Both deferred, not forgotten — next pass if the colour
  fix alone doesn't fully read as "not paint" on the author's own map.
- `npm run verify`: lint/format/structure clean (structure: same one pre-existing failure,
  confirmed unrelated), 10,880 passed, 0 failed.
- ⚠️ **Proof line NOT met.** Nothing here has been seen on the author's own river yet.

### S2 — Solidity raster, area-averaged *(the small-rock fix, at last)* — DONE 2026-08-17, `BUILT (unverified)`
- `water-flow.js#buildWaterSoliditySeedMaterial`: B1 exactly (4×4 = 16 sub-samples/texel,
  `WATER_PRESENCE_EPS` — the SAME presence floor the body pack's own seed pass uses), against the
  FULL-resolution mask image (never the coarse derivation grid). `WATER_FLOW_GRID_MAX_DIM = 1024` —
  deliberately coarser than the mask/SDF's own 2048, because velocity is smooth/low-frequency and
  the area-average already captures the obstacle boundary at whatever resolution IT runs at.
- `water-flow-subsystem.js#createWaterFlowSubsystem`: owns `res:waterFlow`'s solidity target and the
  `maybeBake` cadence discipline (`bakes` vs `polls`, same honesty check as the body pack). ONE
  INSTANCE PER FLOOR (`waterFlowsByFloor`, `vt-pan-viewer.js`) from its first line — takes THIS
  floor's own `waterSurface`/`waterBody` handles wholesale (mirrors `createWaterSurfaceSubsystem`'s
  own `waterBody` argument) rather than a floorIndex, so there is no cross-floor question left for
  it to get wrong. REBUILDS against the real mask texture (never re-points a placeholder) —
  `feedback_texture_nodes_must_be_repointed_together`'s "prefer rebuild" option, applied here from
  the start rather than learned live a second time.
- Debug channel (n:22, `flowSolidity`) — un-gated by tier (solidity is not a foam-ladder concept).
  `flowSolidityTexNode` is NEVER null (unlike `bodyTexNode`): the mesh's own visibility gate does not
  wait on a flow bake, so `water-surface-subsystem.js` always supplies a real 1×1 placeholder,
  re-pointed on its own cadence (`setFlowSolidityTexture`, called from the frame loop right after
  `waterFlow.maybeBake()`) — a THIRD independent re-point cadence alongside the mask's and the body
  pack's own, never folded into either.
- New Node tests: `water-flow.test.mjs` (construction at 4 aspect ratios + the two constants pinned
  by value), `water-render.test.mjs` (`flowSolidityTexNode` present at tier 0 and tier 4 alike).
  `npm test`: 10,902 passed, 0 failed. `npm run verify`: lint/format/structure clean (structure: the
  same one pre-existing, unrelated ratchet failure noted at S0/S1, confirmed via `git diff` to
  predate this phase's own edits).
- ⚠️ **Proof line NOT met.** "The rock appears as a grey blob in the solidity channel" needs the
  author's own eyes on channel 22, live — nothing here has confirmed the bake actually runs on a real
  scene, only that it compiles, wires, and reports honestly when it hasn't baked yet.

### S3 — The flow bake ★ KEYSTONE — CPU reference AND TSL port DONE 2026-08-17, `BUILT (unverified)`
- **B2–B3 as a pure-JS CPU reference** (`water-flow-solve.js`), proven against hand-computable
  fixtures and brute force BEFORE any TSL port is attempted — this project's own
  `water-body.js#rebaseNeighborOffset` precedent, applied here because it caught a real bug the
  plan's own pseudocode would have shipped verbatim. `solveWaterFlowVelocity` runs the coarse-to-fine
  cascade the plan specifies (5 levels, `1/16→1/8→1/4→1/2→1` of the finest grid's own aspect-preserving
  dimensions — a generalisation of the plan's literal "64→128→256→512→1024" to whatever aspect ratio a
  real water body has; NOT yet done: B4's pack layout, and the TSL port itself — see below).
- ⚠️ **A REAL BUG, CAUGHT BY THE NODE TEST BEFORE IT REACHED A SHADER.** The plan's own pseudocode
  (`v -= 0.5 * vec2(pR - pL, pU - pD)`) assumes both pressure neighbours sit a full cell away — but a
  Neumann-mirrored neighbour (substituted with the CENTRE's own value, for a solid obstacle) sits at
  EFFECTIVE DISTANCE ZERO, so the naive formula silently HALVES the pressure gradient at every open
  cell touching so much as one solid neighbour. Found via a fully-sealed-box fixture (continuum
  answer, proven two ways: exactly zero interior velocity) that converged to a *stable, non-improving*
  residual — a perfectly linear pressure ramp at exactly HALF the required slope, independent of wall
  thickness (checked 1/2/3/4) and of iteration count (checked to 8000). Fixed: the gradient step now
  divides by the neighbours' actual EFFECTIVE combined span, not a hardcoded 2
  (`water-flow-solve.js#blendedNeighbor`/`axisGradient`).
- ⚠️ **A SECOND FIX WAS TRIED AND REVERTED THE SAME DAY** — applying the identical "blend toward the
  centre" idea to the DIVERGENCE computation itself (reasoning that the divergence "cliff" right at a
  solid/open interface was a discretisation artefact worth smoothing). It is not: removing it made the
  wall completely invisible to the solver — on the same sealed-box fixture, divergence collapsed to
  ~0 EVERYWHERE and the "projected" velocity came back bit-for-bit identical to the raw seed.
  Divergence must see the real discontinuity; only the gradient needed distance-awareness. Reverted.
- ⚠️ **HONEST REMAINING LIMITATION, NAMED RATHER THAN CHASED:** even with the gradient fix, a FULLY
  SEALED body of water (walls on every side, no outlet) only reaches roughly HALF suppression of a
  uniform seed at full Jacobi convergence, not the continuum's exact zero — a structural property of
  this simplified collocated-grid (not staggered/MAC) Neumann scheme. Matches B3's own "no vortex
  shedding v1" precedent: accepted because it does not affect this module's actual target (an OPEN
  river routing around LOCAL obstacles, where the far Dirichlet boundary dominates and this pathology
  never arises — the circular-obstacle fixture below shows correct routing throughout). A genuine
  staggered-grid rebuild would fix it properly; out of scope for v1.
- **Proof, on the CPU reference:** a circular-obstacle fixture shows flow correctly ACCELERATING
  beside the obstacle vs directly upstream AND downstream of it (the plan's own "constriction speed-up,
  front stagnation, slow lee" language), no solid texel ever carries a nonzero velocity, and divergence
  stays small away from any obstacle (not smeared across the field). 20 Node tests
  (`water-flow-solve.test.mjs`): helper-level (downsample/upsample/seed/divergence/one hand-verified
  Jacobi step), the circular-obstacle routing block, the sealed-box honesty check, a
  coarse-to-fine-vs-well-converged-flat-solve cross-check (mean disagreement < 0.15 at free-stream
  speed 1), a convergence-monotonicity check, and a determinism check.
- **Author sign-off, verbatim (2026-08-17), on the sealed-box limitation above:** *"Fine for now, push
  forward into the TSL port — We don't need an accurate physics simulation and if I understand your
  point correctly I will design maps to be either rivers or ponds but not both. Rivers will get their
  direction and impetus from a flow system and when that is turned to zero we get ponds."* This is a
  STRUCTURAL fact worth recording, not just a green light: a pond authored this way has `flowSpeedPx`
  (or the equivalent zero-magnitude seed) rather than a nonzero bulk seed forced against a sealed
  boundary, so the specific pathology S3's own investigation found (half-suppression in a fully
  enclosed body) cannot arise from how this project's own maps get authored — the limitation is real
  and stays named, but the case that triggers it is one the authoring model itself avoids.
- **The TSL port** (`water-flow.js`): four new material builders — `buildWaterVelocitySeedMaterial`
  (B2), `buildWaterDivergenceMaterial` (B3 line 1, deliberately NOT solid-aware — the reverted-fix
  lesson above, ported faithfully), `buildWaterJacobiStepMaterial` (B3 line 2, ping-ponged exactly like
  `water-body.js`'s own JFA step — one material per level, re-pointed and re-rendered
  `WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` times, never N materials), `buildWaterProjectPackMaterial`
  (B3 line 3 + B4, the actual site of the gradient-halving fix, via a shared
  `neighborForAxisGradient`/`axisGradientTSL` pair that is the literal TSL twin of
  `water-flow-solve.js#blendedNeighbor`/`axisGradient` — same bug, same fix, same shape, in both
  languages). `water-flow-subsystem.js` rewritten wholesale: the full 5-level cascade, coarsest to
  finest, each level's converged pressure read directly (bilinear) as the next level's Jacobi initial
  guess — no dedicated "upsample" pass exists or is needed, a GPU sampler upsamples for free when its
  source is smaller than the target it renders into. Solidity is derived FINEST-FIRST, then CASCADED
  down: only the finest level re-samples the raw mask (S2's own seed pass); every coarser level box-
  averages its own solidity from the next-finer level's already-computed result — see the 2026-08-18 fix
  below, which is what makes this sentence true (the first shipped version of this port got it wrong).
- **B4 RECONCILED** — the known inconsistency flagged at S2 (plan doc says RG/B/A, S2's own
  intermediate solidity-only pass used R) is resolved by construction, not by editing this doc's own
  spec: S2's per-level solidity texture stays exactly as built (an INTERNAL input to the cascade, R
  only, never the consumer-facing product); the NEW project+pack pass is what `res:waterFlow` actually
  means from S3 onward, and it packs exactly RG=velocity/B=speed01/A=solidity, matching this section's
  own original text. Velocity is NORMALISED (free-stream speed = 1.0, no notion of `flowSpeedPx` at
  all) — matching `water-flow-solve.js#solveWaterFlowVelocity`'s own `bearingDeg`-only signature, so
  the Node-tested algorithm and the shipped shader solve the identical problem. A real-world px/sec
  scale is a future CONSUMER's own multiply (S4+), never baked into the pack.
- **The debug channel** (n:23, `flowVelocity`) — direction as hue, speed as value, exactly as this
  section originally specified, via `hsb2rgb` (this project's own tested `mx_hsvtorgb` wrapper,
  `tsl-noise-toolkit.js` — reused, not a second hue-sector formula) and TSL's own 2-argument `atan`
  (verified elsewhere in this codebase to compile to `atan2`, `region-darkness.js`'s own citation).
  Channel 22 (`flowSolidity`, S2) now reads the pack's OWN `.a` rather than a standalone texture's
  `.r` — the same reconciliation as B4 above, one level up.
- ⚠️ **LIVE BUG #1, FOUND AND FIXED 2026-08-18 — the independent-per-level solidity re-derivation
  above was WRONG, and it shipped.** Author's live report on channel 23 (`flowVelocity`): a faint,
  POSITION-INDEPENDENT (identical regardless which part of the river was in view), diagonally-oriented
  (top-right/bottom-left, not a left-right mirror of the north-south flow) blue tint. Channel 22
  (`mask`, S2's own proof line) was screenshotted clean by the author — zero tint — which by itself
  ruled out any global screen-space post-process/vignette explanation. Ruled out next, in order, each
  by actual testing rather than by asking the author to test more: TSL sign-convention bugs (internally
  self-consistent, matched the CPU reference's own convention exactly); an algorithm-level flaw (the CPU
  reference re-run at production scale, 1024×476, with a real obstacle, came back perfectly clean);
  half-float rounding noise (bumped all 6 per-level render targets `HalfFloatType`→`FloatType`, live
  A/B via a forced rebake confirmed by `getWaterHealthReport()`'s own `flow.bakes` counter — RESULT
  IDENTICAL before/after, which is itself informative: real rounding noise would have shifted at least
  somewhat). Root cause, found by re-reading the port against the CPU reference side by side: S3's own
  text above (pre-fix) claimed independent per-level re-derivation "matches the CPU reference's own
  choice exactly" — it does not. `water-flow-solve.js#downsampleBoxAverage` cascades solidity DOWN from
  the finest level's own densely-sampled array; the TSL port instead re-ran `buildWaterSoliditySeedMaterial`
  independently at EACH level's own resolution, every time re-sampling the ORIGINAL raw mask with a
  FIXED `WATER_FLOW_SOLIDITY_SUBSAMPLES=4` (4×4=16) — sized correctly for the finest level's small
  mask-footprint-per-texel, badly undersampled at the coarsest level's much larger one. An undersampled,
  independently-seeded coarse solidity field is exactly the kind of coherent, non-physically-symmetric,
  view-independent noise the author described. **Fix:** `buildWaterSolidityDownsampleMaterial`
  (`water-flow.js`) — a 2×2 box average (4 taps at ±0.5 source-texel offsets) of the NEXT-FINER level's
  own already-rendered solidity, exploiting that every cascade fraction is exactly half the one before
  it. `runFullBake` restructured into 3 explicit phases (allocate every level's targets + solidity-
  independent materials → derive solidity FINEST-TO-COARSEST via the new `buildSolidityForLevel` →
  run the pressure cascade COARSEST-TO-FINEST as before) so the solidity pass for a level can depend on
  its already-built finer neighbour. Node-verified: construction tests at 4 aspect ratios
  (`water-flow.test.mjs`), plus a first-ever dedicated orchestration test
  (`water-flow-subsystem.test.mjs`, a fake-allocator/fake-render-pass harness with no GPU) pinning the
  exact pass count per bake (`1 solidity + 2 + 20 Jacobi + 1 pack, ×5 levels = 120`), exact target count
  (30), and the 1024×476 grid matching the author's own live health-report numbers exactly. **NOT YET
  live-confirmed** — this fix has not been seen against the real scene; channel 22/23 need the author's
  eyes again.
- Node tests: `water-flow.test.mjs` extended with construction tests for all five new materials
  (four B2/B3 cascade materials plus the 2026-08-18 solidity-downsample fix) at four aspect ratios,
  PLUS a pin on `jacobi.prevTexNodes.length === 5` and `pack.pressureTexNodes.length === 5` (centre +
  4 neighbours each) — the exact re-pointing-array discipline
  `feedback_texture_nodes_must_be_repointed_together` exists to guard, now guarded by a test instead of
  only a comment. `npm test`: 11,085 passed, 0 failed. `npm run verify`: lint/format clean; structure
  clean except the SAME two pre-existing, unrelated failures noted since S0 (confirmed via `git status`
  to touch none of the files this fix changed). The `graph/reachable-from-boot` `[structure-change]`
  from the CPU-reference phase REVERTED itself (3→2) the moment `water-flow-subsystem.js` started
  importing `WATER_FLOW_SOLVE_LEVEL_FRACTIONS`/`WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` directly from
  `water-flow-solve.js` — the CPU reference is now a genuine, reachable dependency of the shipped port,
  not a standalone proof with no consumer.
- **NOT done:** `maybeBake`'s trigger set does not yet include a check on `flowSpeedPx`-driven
  "is this effectively a pond" — a zero-speed pond still runs the FULL cascade (harmlessly, since the
  seed is exactly zero throughout and the solve is trivially divergence-free, but at unnecessary GPU
  cost); a cheap early-out is a reasonable follow-up, not required for correctness. S4 (rewiring
  swash/break/streak onto the real pack) has not started.
- ⚠️ **LIVE BUG #2, FOUND AND FIXED 2026-08-18 — a SECOND, independent bug on the same channel, found
  after bug #1's fix made zero visible difference.** Author's follow-up report: channel 23 unchanged,
  a debug colour washing across geometry the author confirmed was NOT water. Root cause:
  `flowPackTexNode`'s world→UV formula reuses `maskU`/`maskV`, clamped into `[0,1]` for a legal fetch —
  but a clamp only keeps the FETCH legal, it does not stop the effect at the rect
  (`feedback_uv_clamp_is_an_extrusion_not_a_boundary`, first found 2026-08-16 in this SAME file for the
  main `inside` presence term, which already guards itself with a rect-membership test, `inRect`).
  `flowPackTexNode` never multiplied by `inRect`. **Fix:** gate `flowPackTexNode` by `inRect` at its own
  single definition, so every future S4+ consumer inherits correct membership for free.
  ⚠️ **The FIRST diagnosis of the SYMPTOM here was wrong and the author corrected it sharply — worth
  recording plainly rather than quietly editing away.** The initial write-up of this bug claimed the
  author's screenshot showed "a room and a wooden loom" with water painted over them; the author's own
  reply: *"there is no fucking 'loom' and there isn't water happening where it shouldn't be... I was
  just looking at a river, no room and no loom."* The screenshot was the REAL Underground river and the
  REAL Tower Bridge deck (with its own lifting/pulley mechanism) the whole time — invented geometry that
  was never there, stated as fact. The `inRect` MECHANISM fixed here is real and independently confirmed
  below, but the specific "painting over a room" causal story was fabricated, not observed. See
  [[feedback_never_blame_the_authors_technique]]'s third occurrence for the full account.
- ✅ **BOTH FIXES CONFIRMED AGAINST THE REAL MAP, 2026-08-18 — not Node-only, not a screenshot: a new
  shader-lab scenario against real art, on a real GPU.** The author's own correction (*"YOU HAVE THE
  FILES for this map... use those and the shader lab to actually make this work yourself"*) is exactly
  what `tools/shader-lab/bench-water.js#real-underground-river-flow` does: loads the REAL
  `Tower_Bridge_Underground_Water.webp` via the REAL `loadMaskImageTexture` ingest, runs the REAL
  `createWaterFlowSubsystem` bake against it (own local render-target allocator, no synthetic fixture),
  wires the REAL resulting texture into a REAL `buildWaterSurfaceMaterial` as `flowPackTexture` from
  CONSTRUCTION (never null-then-repointed), and reads back actual pixels + saves PNGs. Baked at the
  IDENTICAL grid the author's own live health report showed (1024×476, 5 levels) — same map, same
  numbers. Measured: raw pack speed ranges 0→0.62 (real, spatially-varying, not degenerate); a point
  sampled well outside the water body's own rect reads pure black (`{0,0,0}` — bug #2's fix holding);
  the SAME frame's centre, genuinely inside the water, reads real non-black colour (bug #2's fix is not
  OVER-suppressing real water either — both directions checked, not just one). **Both bugs are now
  verified fixed against real production art, not just Node constructions.**
- ⚠️→✅ **A THIRD finding from the SAME real-map render, found AND resolved same session: a legibility
  gap, not a bug.** Even with correct data and correct gating, the first picture
  (`real-piers-channel23.png`, absolute-direction-as-hue) read as a near-uniform dark colour —
  `WATER_FLOW_SPEED01_HEADROOM=2.5`'s own generous ceiling (kept, for S4's future real consumers) means
  realistic speeds land at 10-30% of full HSV brightness. First fix (`pow(speed01, 0.4)` on the debug
  channel's own value) measurably brightened it (confirmed: a sampled point went `{32,0,66}` →
  `{72,0,149}`) but the underlying REPRESENTATION was still wrong: absolute direction as hue spends the
  whole colour wheel on a signal (bulk river direction) that is nearly constant everywhere by
  construction, so local routing — a small perturbation on top of that bulk direction — never moved the
  hue enough to see.
  **The actual fix: redesigned the channel to show DEVIATION from the river's own bulk direction
  (`uFlowDir`/`flowAngleDeg` — the SAME bearing the solve itself seeds from, never a second compass),
  not absolute direction.** Cyan = bent one way, orange = bent the other (a diverging pair, deliberately
  never adjacent on the wheel, never red/green), saturation carries deviation MAGNITUDE (zero deviation
  → zero saturation → reads as neutral grey/white, so "nothing happening here" is visually silent),
  value still carries the 2026-08-18 speed-legibility fix. Implementation: `sinDev`/`cosDev` from the
  2-D cross/dot of the local and bulk unit-direction vectors, `atan(sinDev,cosDev)` for the signed
  deviation angle, LINEAR saturation ramp (not `1−cos`, which is least sensitive exactly at the small
  angles this channel most needs to reveal) saturating fully by a 0.5 rad (~29°) bend.
  **Confirmed working, same bench, same real river:** the redesigned picture shows a clean neutral
  grey/white field over open water with a clearly visible cyan/orange fringe right at each pier's
  edges — flow splitting around the obstacle, exactly the "author sees flow visibly bending around the
  rock" signature this whole phase has been chasing. Centre-of-open-water sample went from a saturated
  `{144's-worth-of-purple}` under the old encoding to a near-neutral `{144,148,149}` under the new one —
  the numbers directly confirm "boring, undeviated water reads as boring" is now true, which is exactly
  what makes the coloured fringe at the piers stand out instead of blending into a wall of one hue.
  `npm test`: 11,214 passed, 0 failed throughout. **Still genuinely `BUILT (unverified)` until the
  author's own eyes confirm it live** — everything above is proven via the shader lab against the real
  mask file, on a real GPU, which is a large step up from a screenshot-relayed guess but is still not
  the author's own scene.
- 🔴→✅ **LIVE BUG #3, SAME DAY, SELF-INFLICTED BY THE `inRect` FIX ITSELF — found from the author's
  own live report, not from more bench testing.** Author: *"The flow pack velocity debug layer is black
  for me, not white with orange cyan tinge."* Root cause: bug #2's own fix (`texture(...).mul(inRect)`)
  was assigned back onto the name `flowPackTexNode` — the EXACT node
  `water-surface-subsystem.js#setFlowPackTexture` re-points every bake via `surface.flowPackTexNode.value
  = t`. A `.mul()` result is a derived arithmetic node (confirmed empirically: a `VarNode` in the
  vendored three.webgpu.js), not a `TextureNode`, and has no real `.value` setter of its own — assigning
  `.value = t` on it SUCCEEDS as an ordinary JS property write (reads back correctly!) while having ZERO
  effect on what the compiled shader actually samples. Production kept sampling the 1×1 all-zero
  placeholder forever, which reads as pure black — exactly the report.
  **The bench that "verified" bug #2's fix never caught this because it built the material with the real
  texture wired in at CONSTRUCTION and never re-pointed it — the one code path that matters
  (`setFlowPackTexture`'s own re-point) was never exercised.** A real, instructive verification gap, not
  an excuse: the SHAPE of the bug and the SHAPE of the test happened to be orthogonal.
  **Fix:** split the name. `flowPackTexNode` stays the raw, re-pointable `texture()` node (restoring the
  contract every consumer depends on); a NEW, separately-named `flowPackGated` carries the `inRect`
  multiply and is what the debug channels actually read.
  **Two new checks added, closing the gap for good, not just patching the symptom:** a Node-level pin
  (`water-render.test.mjs`) that `flowPackTexNode.isTextureNode === true` — the cheapest real
  discriminator between "a genuine re-pointable reference" and "a derived expression that merely looks
  like one from the outside" (a naive `.value` round-trip test was tried and explicitly REJECTED — proven
  empirically to pass identically on the broken node, since plain JS property assignment always
  round-trips regardless of whether anything downstream reads it — exactly the shape
  `feedback_instruments_must_not_lie` warns against); and a GPU-based re-point scenario added to
  `bench-water.js#real-underground-river-flow` that builds against the SAME placeholder production
  starts with, renders (must read black), calls the EXACT line `setFlowPackTexture` runs, renders again,
  and demands the pixel changed. Confirmed on the real river: black before, `{144,148,149}` after,
  matching the working state exactly — 7 of 7 checks pass, including both new ones. `npm test`: 11,254
  passed, 0 failed throughout.

### S3 (continued) — 2026-08-19: the flow bake does NOT meaningfully route around a small isolated obstacle — found, narrowed, NOT fixed

**Author, live, annotating a screenshot of the shader lab's own default `paintRiver`+ISLAND fixture with
arrows and marked points:** *"I can't see any evidence of the water itself going around structures...
test these points on the river... see if they end up pointing in the directions provided by the
arrows... get river flowing obstacle avoiding working in the shader lab first... just because it works
in Shader Lab doesn't mean it'll perfectly work in Foundry, so be careful about getting this right."*

**A genuine, previously-unnoticed testing gap, confirmed before anything else:** every scenario that
flow-bakes runs against the REAL Tower Bridge mask; every scenario that runs against the bench's OWN
default synthetic fixture (`paintRiver` — a winding channel with an island, `river-bake-produces-real-
sdf`/`tier4-gate-ladder-no-dead-term`/`shore-foam-has-real-coverage`) only body-bakes it, never flow-
bakes it. The flow solve had never once been run against the shape the author was actually looking at.

**New scenario built:** `synthetic-river-flow-avoids-island` — the real JFA body bake + real
`createWaterFlowSubsystem` bake against `paintRiver`'s own exact geometry (`riverCenterU`/
`riverHalfWidthU`/`ISLAND`, never eyeballed), sampling the solved velocity at world coordinates derived
from that SAME geometry at points either side of the island and at the sharpest channel bend, plus a
full-fixture-wide render of the already-live-confirmed channel 23 (`flowVelocity`) for a direct visual
check.

**Two real bugs in the NEW TEST ITSELF, found and fixed before trusting any of its numbers — worth
naming because both are exactly the "measure the actual output" discipline this file keeps re-learning:**
1. The first run read plausible-looking but internally-inconsistent numbers (a raw velocity magnitude of
   5.4 alongside a decoded `speed01` of 0.0002 — impossible from `buildWaterProjectPackMaterial`'s own
   `speed01 = clamp(length(velocity)/HEADROOM, 0, 1)` formula, which shares the same `vx,vy`). The
   rendered channel-23 PNG from the SAME run looked normal, which is what exposed it as a readback bug,
   not a solver bug: the pack's own render-target descriptor requests `THREE.FloatType` (full 32-bit,
   changed from `HalfFloatType` during the 2026-08-18 live-bug-#1 hunt above, for an unrelated reason),
   but the new readback assumed the `HalfFloatType`+`halfToFloat` convention nearly every OTHER target in
   this bench file uses, reinterpreting each 4-byte float as two unrelated 2-byte halves. Fixed: plain
   `Float32Array`, no decode step.
2. A second, ruled-out concern: whether "the last `.pack`-named target created" reliably identifies the
   currently-valid render target. Fixed defensively to match by IDENTITY against `flow.texture` itself
   (mirroring `real-underground-river-sim#readSimFoam`'s own proven pattern for `sim.texture`) — re-ran
   after the fix and got byte-identical numbers to before, confirming this was never actually the bug,
   but leaving the safer pattern in place costs nothing.

**With correct data, a real, repeatable finding: the solved field barely deviates from the bulk compass
direction anywhere sampled — under 2° even squeezing past the island at roughly 2.5 obstacle-radii from
its centre, and the narrow gap left of the island is NOT faster than the wide gap to its right (if
anything, very slightly slower) — the opposite of what incompressible flow through a constriction should
show.** Two candidate explanations tested and RULED OUT with real evidence before concluding this is a
genuine gap:
- **Is the island even recognised as solid?** Sampled dead centre of the painted island: `solidity=1`,
  `speed01=0` — correctly seeded and correctly zero-velocity. Not the cause.
- **Is 20 Jacobi iterations/level just not enough to converge?** Temporarily bumped
  `WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` 20→200 (10×) and re-ran: the sharpest bend's own deviation
  moved from −0.5° to −1.7°, and the narrow-vs-wide speed relationship stayed wrong. A 10× iteration
  budget producing only a marginal change means the solve has already converged at 20 — not an
  under-iterated, still-settling solution. Reverted immediately (`git diff` on `water-flow-solve.js`
  confirms zero net change) — this was a diagnostic-only test, not a fix, and iteration count is not
  the lever that moves this.
- **Does this contradict S3's own already-passing CPU-reference proof** (`water-flow-solve.test.mjs`'s
  circular-obstacle block, `speedNorth > 1.05` etc., ALREADY PASSING)? Reconciled, not just noted: that
  test's own probes sit only ~2 texels beyond a radius-6 obstacle (r_probe/R ≈ 1.33 from centre) — deep
  in the near-field, where even a weak solve shows some effect (potential-flow theory: ~56% expected
  speedup there). This investigation's own probes sit at r_probe/R ≈ 2.5 from the island's own centre —
  the SAME theory still predicts a clearly measurable ~16% speedup at that distance, not the ~3%
  DECREASE actually measured. The gap is real; it is not explained by "the probe was placed too far
  away to see a genuine but small effect."
- **What's still open, honestly:** the CPU reference's own circular-obstacle test runs at a single small
  resolution (64×32), never through the full 5-level coarse-to-fine cascade the TSL port and this new
  scenario both exercise (1024×1024 finest, 5 levels). Whether the gap lives in the TSL port
  specifically (a subtle divergence from the CPU reference no existing test catches — the one existing
  cross-check, "mean disagreement < 0.15 at free-stream speed 1," is coarse enough to miss exactly this
  class of under-response) or in the CASCADE itself (something about how a SMALL obstacle, well-resolved
  at the finest level but only a few texels wide at the COARSEST 64×64 level, seeds the coarse-to-fine
  refinement) is the natural next question — not yet answered.

**Verified:** the new scenario's own checks correctly FAIL where they should (2 of 5: the narrow-faster-
than-wide check, the bend-deflects-off-bulk check) and correctly PASS where the data supports it (bake
completed; every point resolved to a real reading; the island reads solid) — a genuine regression guard
that will turn green the day this is actually fixed, not a check weakened to get a clean run. All 5
PRE-EXISTING bench scenarios still pass unchanged (22 checks). Node suite 539/539. Full `npm test`:
11,510 passed, 0 failed. Lint clean.

**NOT fixed.** This is a real, now well-evidenced and narrowed gap in the flow solve's own obstacle
response for a small, isolated obstacle in an open channel — the exact shape the author's own map
mostly uses (see `keyhole-water-testament.md`'s own account of the recurring "small rock, no foam"
saga, a DIFFERENT subsystem but the same class of "solver under-responds to a small obstacle"
pathology). Closing it needs either a direct CPU-vs-TSL-port comparison on an IDENTICAL fixture (to
rule the port in or out) or an investigation of the coarse level's own obstacle representation — both
bigger, more careful undertakings than what fits inside further ad-hoc constant-guessing, and correctly
left for a dedicated follow-up rather than rushed. The author's own caution — *"just because it works in
Shader Lab doesn't mean it'll perfectly work in Foundry"* — is doubly apt here: this hasn't even been
shown working in the Shader Lab yet.

### S3 (continued, same day) — plain Jacobi replaced by red-black SOR — measured real improvement, honestly not a complete fix

**Author, after reading a researched menu of options (flow-map baking precedent, stream functions,
SOR/conjugate-gradient/multigrid, distance-field-direct routing — all confirmed against real sources,
not assumed): picked SOR as the starting point.** Chosen deliberately as the smallest, lowest-risk
change that directly targets the DIAGNOSED cause above (plain Jacobi's own `O(1/N^2)` convergence rate
for large-scale routing corrections) rather than a bigger architecture change.

**What SOR actually is here, and why "just add a relaxation factor" alone would not have been enough:**
literature is clear that the real asymptotic win (`O(1/N)` instead of `O(1/N^2)`) comes from
Gauss-Seidel's use of FRESH neighbour values within a sweep, which over-relaxation then extrapolates
further — over-relaxing plain Jacobi alone (no fresh values) only improves the constant, not the
scaling. Implemented as RED-BLACK (checkerboard) SOR instead of true sequential Gauss-Seidel
specifically so it stays GPU-parallel: a 5-point stencil's own structure means every cell's four
neighbours are ALWAYS the opposite checkerboard colour, so updating one whole colour per render has
zero read/write conflicts (exactly as parallel as plain Jacobi always was), while the OTHER colour —
refreshed on the immediately-preceding call — supplies the fresh-neighbour-data Gauss-Seidel needs.

**CPU reference first, proven at Node-test speed before touching the GPU (this file's own standing
discipline).** `water-flow-solve.js`: new `sorPressureStep` (checkerboard-masked, `omega`-extrapolated;
`jacobiPressureStep` stays exported UNCHANGED, still correct, kept as the "before" comparison point,
just no longer the production path); `solveVelocityLevel`'s own loop now runs it twice per "iteration"
(parity 0 then 1 — one caller-visible "iteration" is still one full pass over the WHOLE grid, the
existing meaning of `WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` unchanged). New `WATER_FLOW_SOLVE_OMEGA`
(1.7 — inside the theoretically-stable `(0,2)` range without sitting near its unstable edge; NOT the
per-grid analytically-optimal value, which needs a clean rectangular all-Dirichlet domain this solver's
mixed Neumann/Dirichlet, irregular obstacle boundary does not have).

**Proof, reproducing the EXACT live-reported failure at CPU-test scale before ever touching the GPU:**
a small-obstacle-far-probe fixture (r_probe/R ≈ 2.67, matching the island's own ~2.5) and an
off-centre-obstacle-in-a-wide-channel fixture (the narrow-vs-wide-gap check that actually failed on the
real river), both compared against a hand-assembled plain-Jacobi cascade on the IDENTICAL fixture (not
a different one, and not trusted from memory — `jacobiPressureStep` is still exported specifically so
this comparison never has to guess). Measured, not asserted:

| | plain Jacobi (old) | SOR (new) | theory (potential flow) |
|---|---|---|---|
| speed at r_probe/R≈2.67 | 2.9% above free-stream | 7.1–7.9% above free-stream | ~14% |
| narrow-gap vs wide-gap (off-centre obstacle) | narrow already faster, weakly | narrow faster, ~4× the margin | narrow faster |

An iteration-count sweep (20/40/80/160/320) on the SAME fixture confirmed SOR does NOT share plain
Jacobi's early plateau — it keeps improving through ~80 iterations, then genuinely converges (8.0% at
80, 8.1% at 320, and critically no oscillation or instability at any count tested, nor at `omega` up to
1.95). `WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` bumped 20→60 on that evidence (captures nearly all of
the available gain; a one-time bake cost, not a per-frame one — the author's own framing). The residual
gap against the ~14% textbook figure is NOT a convergence problem (more iterations provably do not
close it) — most likely finite-domain-boundary and coarse-circle-discretization effects, a different
and much less concerning source of imprecision than "the solver hasn't converged."

**TSL port, same day, mirroring the CPU reference exactly.** `buildWaterJacobiStepMaterial` → one
checkerboard half-step, `uParity`/`uOmega` uniforms; the checkerboard mask is PURE ARITHMETIC
(`isActive = 1 − |parity − uParity|`, then `centre + (sorValue − centre) × isActive`) — deliberately
NOT `select()` or `.mix()`, this codebase's own two named TSL traps
(`feedback_tsl_select_chain_strands_vars`, `reference_tsl_method_chaining_trap`'s backwards receiver
order), avoided from the start rather than hit a third time. `water-flow-subsystem.js#runLevel`'s own
loop now renders both parities per iteration, ping-ponging as before.

**Verified on the REAL 1024×1024 cascade, not just the CPU reference's own small test grids:**
`synthetic-river-flow-avoids-island`'s own bend-deflection check went from −0.5° (before this whole
round started) to −2.8° — a real, ~5.6× strengthening, just short of this test's own (somewhat
arbitrarily chosen) 3° bar. The SAME scenario's wide-fixture visual (`synthetic-river-channel23-wide.png`)
now shows CLEAR, structured cyan/orange deflection around the bends and the island, where the field
read as nearly flat before. **Honestly, NOT a clean sweep:** the narrow-vs-wide-gap check on this exact
fixture still fails, and by a WIDER margin than before SOR (0.045 gap the wrong way, vs 0.010 before).
Investigated, not just noted: the wide visual shows the ENTIRE right/wide side of the channel near the
island tinted orange — the SAME colour marking a real, LARGE-SCALE effect from the channel's own sharp
bend right at that point (real river bends run faster on the outer curve; a MUCH bigger-scale effect
than the island's own local gap-width constriction) — meaning this specific test's "left vs right"
comparison is confounded by bend curvature it was not designed to isolate from, not necessarily a sign
the routing fix failed. All 5 pre-existing bench scenarios (22 checks) still pass unchanged. Node suite
544/544 (5 new: 2 pinning `sorPressureStep`'s own math, 3 comparing SOR against Jacobi on matched
fixtures). Full `npm test`: 11,515 passed, 0 failed. Lint clean.

**Honest status:** a real, measured, multi-axis improvement (CPU comparison, GPU before/after, direct
visual confirmation) — not a complete fix. `BUILT (unverified live)` for the same reason every S3/S5
round this phase has carried it: no GPU-rendered visual proof of the composite look exists yet (the
reverted MRT gap), and now ALSO no author confirmation that the STRENGTHENED-but-not-yet-fully-clean
routing reads right in actual gameplay. The remaining menu options (stream function, distance-field-
direct, further omega/iteration tuning, conjugate gradient, true multigrid) stay available if this
round's improvement is not enough on its own.

### S4 — Rewire the existing terms onto real velocity — DONE 2026-08-18, `BUILT (unverified)`
- Swash amplitude/phase speed ← local velocity (the author's explicit ask). ✅
- Break foam ← the real local direction instead of the bare global compass. ✅
- Streak anisotropy ← local flow direction instead of the global uniform. ✅
- **Proof:** confirmed via `bench-water.js#real-underground-river-flow` against the real Underground
  river, real GPU: the real tier-4 composite (not a debug channel) shows a bright foam collar right at
  each pier's edge and diffuse crest/swash foam across open water, with NO sign of the radiating-ray
  artifact §"NEVER MULTIPLY A PER-PIXEL DIRECTION BY UNBOUNDED TIME" warns about. Sent to the author as
  the first real, non-diagnostic picture this whole phase has produced.
- ⚠️ **THE SAFETY ANALYSIS THIS PHASE HINGED ON, stated once so it is not re-derived wrong later.**
  `water-field.js`'s own header names the exact failure mode any future S4-adjacent change must respect:
  a PER-PIXEL-VARYING direction multiplied by an UNBOUNDED magnitude (elapsed time, or raw `worldXY`)
  shears neighbouring pixels apart in noise-sampling space — hard rays, worse the longer the scene runs.
  Every S4 site below was checked against this specific shape, not just "does it look right today":
  - **Break foam's `facing = dot(localDir, outward)`** — a pointwise dot of two per-pixel unit vectors,
    evaluated fresh every frame, no domain offset, no time term. Same risk shape as the EXISTING
    (already-safe) global version; only WHICH direction feeds it changed.
  - **Streak's `alongFlow`/`acrossFlow` rotation** — rotates the ALREADY-BOUNDED `cell` coordinate
    (built from the safe, capped `domainOffset`, never raw `worldXY`) by `localDir` instead of the
    global compass. Rotating a bounded vector by a per-pixel-varying angle stays bounded by that
    vector's own magnitude, regardless of how the angle differs next door — a DIFFERENT, and here
    sufficient, safety argument than "the direction is global".
  - **Swash's phase rate** (`tSec · WATER_SWASH_SPEED · speedAmp`) — `speedAmp` varies per pixel and DOES
    multiply time, which looks like the dangerous shape at first glance. It isn't: there is no 2-D
    domain being sampled here, only a 1-D phase feeding an already-periodic `sin()`, whose OUTPUT stays
    bounded in [-1,1] no matter how large the phase argument grows. Neighbouring pixels at different
    local speeds drift smoothly out of phase over long time (a bounded RATE difference × elapsed time),
    never a discontinuous spatial shear.
  - **`speedAmp` itself** is clamped to `[WATER_LOCAL_SPEED_AMP_MIN, WATER_LOCAL_SPEED_AMP_MAX]` (0.3–2.0)
    around the free-stream baseline (`WATER_LOCAL_SPEED01_BASELINE = 1/WATER_FLOW_SPEED01_HEADROOM`) —
    never open-ended, so even a transient bad solve value produces a bounded visual, not a spike.
  - Left DELIBERATELY untouched: the domain offset (`drift`+bank warp) and the foam tail's own march
    direction both stay on the GLOBAL `flowDir` — both are explicitly named, in their own files, as the
    reason this whole class of bug does not recur; rewiring either onto local velocity would be
    re-opening a bug this project already paid for once.
- ⚠️ **THE DEBUGGING DETOUR, NAMED SO IT IS NOT REPEATED:** verifying this cost a very long chase
  through WebGPU/TSL node-sharing theories (multiple isolated repros built and torn down) before the
  actual cause was found by simply reading the browser console: `bodyTexture: null` at tier 4 makes
  `buildWaterShoreFoam`'s own tail (`sampleBodyAt`) throw `NodeError: texture(value) expects a valid
  instance of THREE.Texture`, repeatedly, and the material that failed to fully construct rendered as
  black — which looked exactly like a re-pointing regression. `bodyTexture: null` was always a
  documented, safe shape below tier 1; it stopped being safe the moment tier 4 was reached without ALSO
  supplying a real body texture, and nothing said so out loud until the console was actually read. See
  `feedback_check_console_before_theorizing` (memory).
- 🔴→✅ **LIVE BUG, AUTHOR-REPORTED THE SAME DAY: swash read as "radiating rings rotating in space," not
  foam.** Author, live: *"I see wash moving against the direction of the river current... a series of
  radiating rings which are now just rotating in space... doesn't look like foam at all yet."* Root
  cause: the shipped swash phase term multiplied `speedAmp` (S4's local-speed amplitude, itself correct
  and bounded) into the RATE `tSec` is scaled by. The shearing-vs-time safety check this went through
  before shipping was real and still holds (`sin()`'s output stays bounded regardless of phase
  magnitude — no domain shift, no ray artifact) but missed a DIFFERENT consequence of this field's own
  geometry: `d01` (shore distance) is RADIAL around every pier-sized obstacle, not a linear beach
  coordinate, so "same `d01`, different angle around the pier" is the ordinary case — and local speed
  genuinely differs by angle around an obstacle (faster on the flanks, per the S3 solve itself). A
  per-pixel RATE multiplying time gives different angular sectors of the same ring a different phase
  rate; animated, a phase gradient around a closed ring reads as rotation. **Fix:** `speedAmp` reaches
  swash through the AMPLITUDE multiply only (unchanged, already correct); removed from the phase-rate
  term entirely, restoring the original, already-validated "bands travel radially, uniform rate" motion.
  Confirmed via the same real-map bench, two frames 2 seconds apart: the foam collar around each pier
  now brightens as a WHOLE RING between frames, not asymmetrically on one side.
- 🔴→✅ **OBSTACLE-PROXIMITY FOAM (the "eight tap") REMOVED, author's explicit repeated request.** This
  depth-buffer-sourced ring (`WATER_OBSTACLE_RING_TAPS`, `water-render.js`, 2026-08-17) lit up around
  ANY content the depth authority ranked above water — overhead tiles included, since it had no way to
  tell "a genuine in-water obstacle" from "anything solid nearby". `maskProximityFoam` (the SIBLING
  8-tap-ring system reading the water's own painted mask directly, not the depth buffer) stays — it
  cannot react to unrelated overhead content by construction, and the author's complaint was specifically
  about tiles, not about painted water features. Removed from `totalFoam`, its own debug channel (n:20),
  the water-health sweep list, and the shader-lab bench's channel classification — full sweep, not a
  disable flag.
- 🔴→✅ **`maskProximityFoam` — the SECOND eight-tap ring — removed too, same day, after the first
  removal alone changed nothing the author could see.** Author, live, after the `obstacleFoam` removal
  above: *"It looks exactly the same, the same 8 tap white edges. I've been very careful to check that
  files have been updated. Under the network tab I have 'disable cache' checked."* Two things were
  chased in parallel:
  - **Whether a performance-profile tier gate could explain it.** `water.tiers[4].fromProfile ===
    'quality'`, and `DEFAULT_PERFORMANCE_PROFILE === 'standard'` — tiers 0-3 all resolve by `standard`,
    so a default install never reaches tier 4 at all (`water-surface-subsystem.js`'s own comment: *"on a
    default `standard` install every shore-foam term is compiled out"*). Confirmed REAL via the live
    Playwright harness against the bench Mansion (`MSA_LOOK_EVAL="return await
    MapShine.getWaterHealthReport()"`): `resolvedTier: 3`, `inertControls: "swashFoam, breakFoam, …"` —
    the bench world's own current profile genuinely has every tier-4 control compiled out. Real bug, but
    the author, asked directly, was unambiguous: *"I'm looking at this on extreme profile. I always do.
    Stop assuming the profile is wrong."* Tier 4 was therefore active in the session that reported the
    bug — ruled out for THIS complaint, left standing as a real hazard on any `standard`/lower install.
  - **The actual cause:** the removal note written for `obstacleFoam` reasoned `maskProximityFoam` was
    safe to keep because it reads the water's own painted mask, not the depth buffer, so "it cannot react
    to unrelated overhead content." True, and beside the point — it is the SAME 8-tap-ring visual
    (a bright ring around every obstacle the mask itself excludes, piers included) from a different data
    source, and it had not been touched, so at tier 4 it had been rendering, completely unchanged,
    through the entire first round. The author was looking at the same thing the whole time. Removed:
    the tier-4 block, `WATER_OBSTACLE_RING_TAPS`/`WATER_OBSTACLE_REACH_PX` (now fully orphaned), its
    `totalFoam` contribution (`max(shore.foam, maskProximityFoam)` → `shore.foam` alone), its debug-node
    entry, its own channel (n:21, `water.js`), the water-health sweep list, and the bench's CHAIN
    classification — same full-sweep discipline as the first removal, not a disable flag.
  - **Proof:** `npm test` green (11263/11263) after updating the one test that asserted the OLD
    behaviour (`water-render.test.mjs` — "9 nodes in `maskTexNodes` at tier 4" is now "still 1, the ring
    is gone," which doubles as a regression guard against either ring ever coming back unregistered).
    `bench-water.js#real-underground-river-flow` against the real Underground river, real GPU, re-run
    clean on a freshly-started shader-lab server (no cache-busting needed): 8/8 checks pass with the
    production `buildWaterSurfaceMaterial` unmodified. A repo-wide grep confirms zero remaining code
    references to `maskProximityFoam`/`WATER_OBSTACLE_RING_TAPS`/`WATER_OBSTACLE_REACH_PX` outside this
    removal's own explanatory comments.
- 🔴→✅ **THE ACTUAL "SMALL ROCK GETS NO FOAM" BUG, TRACED TO ITS ROOT — the JFA seed pass point-samples.**
  Author, live, same round: *"This rock... the same one I've told you about many times before, has no
  wakes/ripples or foam... It's not even a small rock, it's big... yet again you've built a water system
  which doesn't notice this but which can detect a slightly larger thing."* A recurring, previously-
  reported complaint (2026-08-17's own "small-rock foam detection" round tried and abandoned a coarse-
  grid bump and both 8-tap rings) — `water-flow.js`'s S2 area-averaged solidity was believed to have
  covered this class of bug for good. It only covers the FLOW field. `shore.foam`'s presence (not just
  its direction) depends on `water-body.js`'s SDF, whose SEED pass (`buildWaterSeedMaterial`) was still a
  single point-sample per texel at whatever `getWaterMaskGrid` resolves to (`WATER_GRID_MAX_DIM = 2048`,
  ~5.2 world-px/texel on this map — that constant's own comment already named the residual risk: *"a rock
  this small a point-sample could still theoretically straddle... would need to be smaller than a d20"*).
  A rock landing between four texel centres seeds nothing, no matter how large it reads on screen.
  **Fix:** the seed pass's presence test now mirrors `water-flow.js`'s own proven area-averaging (a 4×4
  sub-grid per texel footprint, continuous fraction, thresholded back to a clean binary seed flag so
  `buildWaterJfaStepMaterial`'s downstream `mix(..., candValid)` chain sees the exact same 0/1 contract
  it always has). **Proof:** a controlled adversarial synthetic — a 3px rock inside an 8px grid texel,
  deliberately off-centre so its point-sample-at-centre reads pure water — correctly seeds a 5-cell cross
  centred on the rock, real GPU, real readback (half-float row-padding trap and a stale-module-cache
  false-negative both hit and resolved during verification, neither in production code). `npm test` green
  (11359/11359, water suite un-regressed at 466/466) and the real Underground-river scenario still 8/8 —
  the fix changes seed SENSITIVITY, not the flood/resolve math, so the known-good pier case is untouched.
  ⚠️ Not literally infinite resolution — a rock smaller than roughly 1/16th of one 5.2-world-px texel
  could still theoretically fall between all 16 sub-samples, same shape as `water-flow.js`'s own accepted
  residual risk, just far smaller odds than the single-point-sample version this replaces. No automated
  Node test added this round (TSL/GPU code, verified live via the shader lab rather than a permanent
  fixture) — a real gap worth closing next time this file is touched.
  - **Also found and fixed in passing:** `tools/shader-lab/water-lab.js`'s `registerWaterAdapter()` keeps
    a hand-maintained `scenarioNames` placeholder list (for `describe()` before the real bench builds)
    that was never updated when `real-underground-river-flow` was added — a small, pre-existing instance
    of `feedback_hand_maintained_dispatch_list_forgets_new_effects`, not fixed this round (works around
    it by running any placeholder-listed scenario first to force real bench init), left as a note for
    next time someone adds a water scenario and wonders why `window.lab.run` can't find it immediately.

### S5 — The sim buffer: advect + decay + emit ★ MEMORY — `BUILT (unverified live)`, 2026-08-18
- `water-sim.js` (the material: advect, decay, three emission terms, diffuse-toward-blur),
  `water-sim-subsystem.js` (the orchestration: ping-pong pair, per-frame `tick(dtSec)`, rebuild-on-
  identity-change for flow/body, persistent across param tweaks), wired into `vt-pan-viewer.js`
  (`waterSimsByFloor`, per-floor, mirroring flow/body exactly) and the `water-body` health report
  (`sim:` field). Per-floor instances, one ping-pong pair each.
- **Proof, against the REAL Tower Bridge Underground map** (`tools/shader-lab/bench-water.js`
  scenario `real-underground-river-sim` — real mask, real JFA body bake, real S2+S3 flow cascade,
  the REAL `createWaterSimSubsystem` ticked 150 times at a fixed 30Hz `dtSec`): foam sheds off a
  real pier and rides the real solved current downstream while fading, exactly the criterion above
  — the foam field's own world-space, foam-weighted centroid moved from 208px to 311px downstream
  of the pier between the 1s and 5s samples, monotonically, with zero NaN/Inf anywhere across
  1024×476 texels × 150 frames. Visual confirmation too (t=1s vs t=5s captures): wake trails behind
  each pier visibly lengthen and brighten. `npm run verify`'s full 11,508-test suite stayed green
  throughout (`verify:structure`'s two open failures are pre-existing and unrelated — flagged
  separately, not touched by this work).
- ⚠️ **A real bug, caught by this exact bench scenario before it ever reached the author**: the
  first version fed the CLUMP threshold (`smoothstep(CLUMP_LO, CLUMP_HI, foam)`) back into the
  ping-pong STATE itself, matching this section's own pseudocode literally. Against synthetic/stub
  textures in Node tests this looked fine (construction never throws); against the real map, ticked
  for real, the buffer measured EXACTLY zero everywhere, forever — `smoothstep` returns exactly 0
  below its low edge, one frame's own emission increment can never itself cross a threshold sized
  for the ACCUMULATED steady state, and a texel snapped to 0 by its own frame's threshold starts
  the NEXT frame from 0 too. The state was stuck the instant it was born. **Fix:** store the RAW
  accumulator (post decay/emit/diffuse, defensively clamped to `WATER_SIM_STORAGE_CEIL`), not the
  thresholded display value — `WATER_SIM_CLUMP_LO`/`HI` stay exported for whichever consumer reads
  this pack for DISPLAY (S6/task in progress below) to apply fresh at read time, never fed back into
  memory this file owns. **Lesson for every future ping-pong buffer in this codebase: never write a
  DISPLAY transform into the STATE a future frame will read as its own "previous value."**
- **Render path wired the same day.** `water-render.js` reads `res:waterSim` exactly like the flow
  pack (`waterSimTexNode`, a raw re-pointable node; `waterSimFoam`, the display-time
  `smoothstep(CLUMP_LO, CLUMP_HI, …)` transform this section's own bug write-up says belongs at read
  time, never in storage) and REPLACES `shore.foam` (the old swash/break/tail sum) with it in
  `totalFoam` — the actual collapse this section and §6 describe. `shore` itself is still built,
  unchanged, purely for its own diagnostic channels (`foamD01`/`worleyLace`/`swashBand`/
  `breakFacing`/`breakFoam`/`foamTail`) — full removal of that now-unused-for-display computation is
  a deliberate follow-up, not bundled into the same change as the swap. `water-surface-subsystem.js`
  gained the matching `waterSimPlaceholder`+`setWaterSimTexture` pair (identical shape to
  `flowPackPlaceholder`+`setFlowPackTexture`), and `vt-pan-viewer.js`'s per-floor sim tick now pushes
  `sim.texture` into it every frame, right after the tick, mirroring the flow pack's own re-point
  exactly. Two new debug channels (24 `simFoamRaw`, 25 `simFoam`) expose the buffer before/after the
  display transform.
- ⚠️ **A second real bug, pre-existing and unrelated to S5, found ONLY because wiring `waterSimTexture`
  meant re-running bench scenarios nobody had touched since the S2/S3 flow-pack work landed:** the
  shared bench's own material (`bench-water.js`, the non-real-map scenarios) had NEVER passed
  `flowPackTexture` at all, relying on its own `null` default. `buildWaterSurfaceMaterial` samples it
  unconditionally (Law 4 does not apply — see that param's own doc), and on this WebGPU backend
  `texture(null, …)` does not merely read as a degenerate value at the point it's used — it corrupts
  `debugMaterial`'s WHOLE combined shader (every channel is summed into one graph), so even the
  'quad' calibration channel — a bare constant, no relation to flow data — failed alongside the real
  foam-coverage checks. Three scenarios (`river-bake-produces-real-sdf`, `tier4-gate-ladder-no-dead-
  term`, `shore-foam-has-real-coverage`) had been silently red however long it's been since anyone
  last ran them. Fixed the same way `waterSimTexture` itself was: a real 1×1 placeholder at that one
  construction site. All 5 water-bench scenarios, 22 checks total, pass clean afterward.
- **`BUILT (unverified live)`, and the render-path proof is narrower than the wiring is** — read this
  precisely, not optimistically. Proven: the wiring is structurally correct (`water-render.test.mjs`'s
  own `isTextureNode === true` pair for `waterSimTexNode`, unconditional at every tier, matching
  `flowPackTexNode`'s own proven shape exactly); the SIMULATION is correct on the real map (this
  section's own centroid-drift proof); all 5 bench scenarios/22 checks stay green with
  `waterSimTexture` wired to either a placeholder or a real, ticked texture without breaking anything
  else. NOT yet proven on a real GPU: that the VISIBLE WATER COMPOSITE, rendered with a REAL ticked
  sim texture (not a placeholder), actually shows the foam on screen — an attempt to add exactly that
  check to `real-underground-river-sim` hit an unrelated WebGPU MRT/pipeline error
  ("structures must have at least one member") specific to that new render call, not reproduced in
  the proven `real-underground-river-flow` render path, and was reverted rather than shipped half-
  debugged. That specific visual proof is the honest gap before this can read `LIVE` — either a
  follow-up bench debugging session or the author's own live look closes it.
- **The author's own live look, same day, closed part of that gap and found a real combination bug.**
  Screenshot of channel 24 (`simFoamRaw`) against the REAL map: *"The debug channel shows the correct
  wake structure"* — the simulation itself is now LIVE-CONFIRMED correct, not just bench-proven. But
  the VISIBLE water: *"the actual foam at the moment is happening in a roughly even area around the
  whole circumference of the things that create wakes... If we can get the foam to appear only in the
  sim pack foam whiter areas that would be a good way to make it look better."*
  **Root cause:** `field.foam` (tier 2's own crest foam, `water-field.js`) is gated by `shoreGate` — a
  hard, non-directional "within `WATER_FOAM_SHORE_PX` (140px) of ANY shore or obstacle" cutoff, by
  construction exactly the "roughly even… whole circumference" shape the author named. `totalFoam`
  ADDED that to the sim's own correctly wake-shaped signal — the same mistake this codebase already
  retired once for the OLD swash/break/tail terms (`water-shore.js`'s own header: "summing would erase
  exactly the structure"). **Fix:** `MAX` instead of `add` — the sim's own bright wake pixels now stand
  at their full value instead of a diluted sum; tier 2's own near-shore crest foam only shows through
  where the sim genuinely has nothing to say. `field.foam`'s own `shoreGate` was deliberately NOT
  touched — `WATER_BANK_REACH_PX`'s own domain-warp safety margin is sized against foam staying
  bounded within `WATER_FOAM_SHORE_PX`, so widening that gate is a separate, later change, not bundled
  into a same-day fix. All 5 bench scenarios / 22 checks still pass. **Still open:** whether `MAX`
  alone reads as "only in the whiter areas" strongly enough, or whether tier 2's own halo (wherever it
  legitimately exceeds the sim, e.g. an obstacle's non-wake sides) still needs its own intensity
  reduced — not guessed at blind; needs the author's own next look.
- **The author's SECOND live look, same day, found the MAX fix wasn't enough — two more concrete
  bugs, both fixed and this time MEASURED, not just reasoned about.** *"Looks exactly the same to
  me. The foam around things isn't biased in the way that the sim pack foam debug channel shows...
  When I zoom in you can see a pixelated look. There is no obvious evidence of 'flow' pushing things
  around obstacles. Keep working, get this right."*
  - **Bug 1 — calibration mismatch.** `WATER_SIM_CLUMP_LO`/`HI` (0.15/0.55) were tuned against the
    bench's own `real-underground-river-sim` scenario, which deliberately runs at
    `testFlowSpeedPx=220` (documented in that scenario's own header as inflated on purpose, "well
    above the schema default," so the bounded-tick proof finishes fast) — but the author's live map
    runs the schema DEFAULT, `flowSpeedPx=90` (confirmed straight from their own control-panel
    screenshot). **Fix:** lowered to `WATER_SIM_CLUMP_LO=0.03`/`HI=0.15`. **Measured, not guessed:**
    temporarily swapped the bench's own `testFlowSpeedPx` to 90, hard-restarted, re-ran
    `real-underground-river-sim` — `maxFoamEver` at the REAL default was **0.3137**, actually
    slightly *higher* than the bench's own 220-speed run (0.2454; slower advection gives foam more
    residence time near the emission site before decay/transport carry it off). Against the OLD
    calibration, that peak would land at `(0.3137-0.15)/(0.55-0.15) = 41%` brightness at the
    ABSOLUTE PEAK, with the entire tapering wake below the old 0.15 floor reading as a hard zero —
    a concrete, measured account of "no evidence of the sim pack foam." Against the NEW calibration
    the same peak fully saturates (above `HI`) with more than `10×` headroom over `LO`, giving the
    tapering wake a real gradient instead of a cliff. The bench value was reverted back to 220
    afterward (that scenario's own "arrive downstream within a bounded tick budget" contract still
    wants the faster speed for its everyday regression role) — the measurement is recorded in that
    scenario's own comment, not left to bit-rot as a claim nobody could re-derive.
  - **Bug 2 — pixelation.** `waterSimTexNode` sampled the sim grid (1024×476 texels, ~10.4 world-px
    /texel) via a plain bilinear `texture()` call, mirroring the flow pack's own convention — fine
    for flow, because velocity is a smooth field with no sharp edges away from obstacles. Foam is the
    opposite: `waterSimFoam` pushes the raw accumulator through a SHARP `smoothstep(LO, HI, …)` at
    display time, and a sharp threshold applied to a bilinearly-interpolated coarse grid reads as
    visibly blocky at zoom — exactly "when I zoom in you can see a pixelated look." **Fix:** the same
    C2-continuous (quintic-eased) texel reconstruction `bodyTexNode` already uses for the identical
    reason (`buildSmoothTexelUv`, `water-sampling.js`), applied to `waterSimTexNode`'s own UV
    construction rather than wrapping its sampled result — preserving the "raw re-pointable
    `texture()` node" invariant `water-render.test.mjs` checks for. Needs the sim grid's real texel
    size, so a new `uWaterSimTexSize` uniform + `setWaterSimTexSize(w,h)` setter was threaded through
    the same three-file relay as `setWaterSimTexture` (`water-render.js` →
    `water-surface-subsystem.js` passthrough → `vt-pan-viewer.js`, pushed every frame right alongside
    the texture itself, reading `water-sim-subsystem.js`'s new `width`/`height` getters).
  - **Verified:** `node src/effects/water/__tests__/run-tests.mjs` — 541/541 green (up from 537,
    the new `waterSimTexSize`/getter coverage). All 5 bench scenarios / 22 checks still pass after a
    fresh server+tab restart, both immediately after the fix and again after the temporary
    `testFlowSpeedPx` measurement detour was reverted. **NOT yet verified:** the same honest gap as
    the MAX-fix round above — no GPU-rendered visual proof of the actual composite look, for the same
    reverted-MRT-bug reason. This calibration/pixelation round is reasoned-and-measured-safe, not
    self-verified by eye. The author's next live look is what closes it.
  - **A real bug caught by `npm run verify`'s lint step, not by any test or the bench.** The new
    `setWaterSimTexSize` passthrough was defined in `water-surface-subsystem.js` but never added to
    the subsystem's own returned object — `vt-pan-viewer.js`'s new per-frame call to
    `getWaterSurfaceForFloor(floor.index).setWaterSimTexSize(...)` would have thrown
    `TypeError: ... is not a function` every frame the moment this shipped. Neither the Node suite nor
    the bench exercises this file's own wrapper shape (both call `buildWaterSurfaceMaterial` — or
    lower — directly), so only ESLint's `no-unused-vars` rule stood between this and a live crash.
    Fixed by adding `setWaterSimTexSize,` alongside `setWaterSimTexture,` in the returned object.
    Confirms why `npm run verify`'s full chain, not just the test suite, is the standing bar. Full
    `npm test` re-run clean afterward: 27 suites, 11,512 passed, 0 failed.
- **The author's THIRD live look, same day, confirmed the calibration/pixelation fix worked and named
  the next problem precisely.** Screenshot showed real whiteness downstream of both piers for the
  first time this phase. *"Okay. Progress. Still a bit pixelated but there is whiteness downstream of
  obstacles. Keep going. Real foam is complex stringy mess, it's not a 'glow' effect. Real foam might
  break off and flow downstream."*
  - **Root cause:** `waterSimFoam` is the accumulator run through a display-time clamp — correctly
    SHAPED and SIZED now, but a clamp only rescales brightness, it cannot add structure to a field that
    has none. Advect+decay+emit+diffuse (`water-sim.js`) is fundamentally a SMOOTHING process; its
    output is a smooth gradient by construction, and a smooth gradient reads as a glow no matter how
    well-calibrated its brightness is. This is the EXACT failure shore foam's own first version shipped
    as, and already fully diagnosed and fixed once (`water-shore.js`'s own header: *"a net with holes,
    not veins"* — cellular Worley structure, two octaves, cut into walls at a measured distribution).
  - **Fix, reusing rather than re-solving:** extracted that exact mechanism —
    `cellPx`/`cell`/`alongFlow`/`acrossFlow`/`streakCell`/two Worley octaves/`cellWalls`/`fineWalls` —
    out of `buildWaterShoreFoam` into a new exported `buildFoamCellularStructure` (`water-shore.js`),
    returning `{cell, lace, structure}`. `buildWaterShoreFoam` is now a thin caller of it (byte-
    identical output — `cell` and `lace` are the same values it computed inline before), avoiding a
    second copy of six hard-won, already-tuned constants
    (`feedback_shared_field_two_meanings_two_registries`). `water-render.js` calls it a second time for
    the sim's own wake, reusing `field.domainOffset`/`localFlowDirSafe`/`uFoamReachPx` — all already
    computed, all unconditional (not tier-gated) — and multiplies `waterSimFoam` by the result's
    `.structure`, NOT `.lace`: shore foam's `.lace` deliberately never fully erases (a continuous
    swash/break sheet), but the wake is meant to read as discrete patches that can genuinely vanish
    between clumps — *"foam might break off"* needs true holes, not a floor-clamped minimum.
    `totalFoam` now combines `field.foam` against this structured product, still via `max` (unchanged
    from the previous round's fix).
  - **Two new debug channels** (n:26 `simFoamStructure`, the cellular mask ALONE with no accumulator
    involved, so the texture itself — cell size, streak stretch, hole density — can be judged
    independent of where the sim happens to be bright; n:27 `simFoamStructured`, channel 24 × channel
    26, the exact product `totalFoam` reads) so the author's next look can isolate which half of the
    product is responsible for anything that still looks wrong.
  - **Verified, this time with real GPU measurements of the new term itself, not just "nothing broke":**
    the bench's own `tier4-gate-ladder-no-dead-term` scenario (which asserts every CHAIN-classified
    channel is genuinely non-constant against the real river) confirms `simFoamStructure` is real: mean
    0.0249, max 1, min 0, 13.4% coverage, `DEAD:false` — true holes AND true walls both present, at
    roughly a fifth of sibling channel `worleyLace`'s own 99.76% coverage, which is the CORRECT and
    expected signature of `.structure` (can hit true zero) versus `.lace` (floored at
    `1-WATER_FOAM_CELL_BITE=0.25`, never zero) — confirms the "genuine holes, not shore foam's own
    softened version" design choice actually landed as intended, not just in the source comment. All 5
    bench scenarios / 22+2 checks pass. Node suite 541/541 (behaviour-preserving extraction — the
    refactor changed zero shore-foam test outcomes). Full `npm test`: 11,512 passed, 0 failed. Lint
    clean (0 errors, 0 new warnings) on every touched file.
  - **NOT yet verified:** same honest gap as every round this phase — no GPU-rendered visual proof of
    the actual composite (the reverted MRT bug). Additionally, genuinely UNKNOWN until the author's own
    next look: whether reusing shore foam's exact cell-size/streak-stretch tuning reads right at the
    sim wake's own scale (nothing measured says it's wrong, but nothing live-confirms it's right
    either), and whether stacking a SPARSE structure mask (13.4% coverage) onto an ALREADY-SHAPED
    accumulator produces a wake that's readable at a glance or reads as merely faint — the mechanism is
    proven non-degenerate, not proven "looks good." **What this round does NOT attempt:** genuine
    Lagrangian foam clumps that detach and travel independently downstream — the author's own
    "might break off and flow downstream" phrasing could ask for that as a literal simulated behaviour,
    not just a visual impression of patchiness. That is particle territory (this file's own ladder:
    "8-spray(C8)"), a materially bigger feature than a display-time noise mask, and deliberately not
    started without the author confirming this cheaper approximation isn't already enough.
- **The author's FOURTH live look, zoomed in on all three new debug channels individually: the
  calibration fix from round 2 confirmed working, and the structure mask itself confirmed broken.**
  *"Okay. Progress... there is whiteness downstream of obstacles."* Then, after the structure-mask
  round above shipped: *"26 shows concentric poles of almost magnetic like rings. 25 shows a huge
  amount of pixelated non-sense... No filament like structures. Nothing floating down stream. Lots of
  pixelated mess (could we increase texel resolution please?). Keep working."*
  - **Investigated by actually rendering the exact channels and reading the pixels — not by re-reading
    the shader source** (`tools/shader-lab/bench-water.js#real-underground-river-sim` extended with a
    new debug-channel render probe: real ticked sim texture, real flow, real body, a tight zoom on the
    real pier, PNG artifacts saved and read directly). First confirmed the author's report reproduces
    on a real GPU render, then bisected by rendering shore foam's OWN `worleyLace` channel (n:10)
    through the identical probe for comparison.
  - **Bug found and FIXED, verified: `mx_worley_noise_float` returns F1 (nearest-feature distance)
    alone.** F1's own local MAXIMA sit only at points equidistant from three-or-more cells (Voronoi
    VERTICES) — thresholding near those maxima lights small blobs AT vertices, never the EDGES
    connecting them, because F1 falls away from its own peak in every direction around a vertex just as
    fast as anywhere else. That is "disconnected specks" by construction, not a net — no threshold
    choice fixes it, because the wrong SCALAR was being thresholded. **Fix:** `mx_worley_noise_vec2`
    (confirmed by reading `three.webgpu.js`'s own source: returns the two smallest distances found in
    the same 3×3 search F1 already runs) gives F1 AND F2 for one extra tracked minimum. `F2−F1` is
    exactly zero ON a cell edge by construction and grows toward every cell's interior — thresholding
    it near zero traces the connected boundary instead. New `WATER_FOAM_EDGE_NEAR/FAR` supersede the
    retired `WATER_FOAM_CELL_EDGE0/1` (a genuinely different metric, not a recalibration of the same
    one). **This is shared code** (`buildFoamCellularStructure` — both this file's own structure AND
    shore foam's `worleyLace` read it), so shore foam's own cellular texture is ALSO fixed by this,
    not just the sim's — the SAME bug had been silently shipping in already-live-confirmed shore foam
    the whole time; nobody had zoomed in far enough on it to notice. Confirmed via direct pixel
    inspection: away from small obstacles, the field now shows genuine connected, angular cell-wall
    structure — the first time this phase actually looks like a net rather than a gradient or specks.
  - **A second, DEEPER contributing factor found — precisely diagnosed, NOT fixed, reverted rather
    than shipped half-measured.** Even after the F2−F1 fix, both `worleyLace` and the new structure
    channel show a clear spiral/vortex distortion specifically near small round obstacles (piers).
    Traced to rotating the Worley coordinate by `flowDir` (`buildFoamCellularStructure`'s own
    "STRETCHED ALONG THE CURRENT" step): this file's own S4 header proves that rotation safe against
    SHEARING (an already-bounded vector rotated by a per-pixel angle stays bounded), but never checked
    it against a DIFFERENT property — a Worley field's visual character depends on the geometric
    relationship between query point and feature points, so rotating the query by a SPATIALLY-VARYING
    angle warps the apparent cell layout into a spiral regardless of boundedness. Near a small pier,
    `localFlowDirSafe` genuinely sweeps close to a full circle (the S3 solve's own real circulation
    around an obstacle, not a bug in it) — and correctly-shaped foam wraps around at the tightest radii,
    which is exactly where the sim's own accumulator is strongest (the emission zone). Two dampening
    attempts on `bankWarp` (part of `field.domainOffset`, isolated from `drift` via
    `bankWarp = domainOffset − drift`, both newly exposed by `water-field.js` for this test) — ×0.15,
    then ×0.04 — barely changed the visible result, which is itself evidence `bankWarp` is not the
    dominant contributor; `flowDir`'s own rotation, shared with shore foam, is the more likely one.
    **Both attempts fully reverted** (`water-render.js` back to the plain, unmodified
    `field.domainOffset`; `water-field.js`'s `drift` exposure removed since nothing consumes it after
    the revert) rather than shipping a magic constant validated only against one pier, on one map, that
    demonstrably wasn't solving the actual problem. Fixing this properly means reconsidering whether
    rotating a FINE cellular noise's domain by a per-pixel flow angle is sound at all near small
    obstacles — a bigger, shared-with-already-shipped-code architectural question, not a constant to
    guess at under time pressure. **Open**, tracked here for whoever picks this up next (possibly a
    future me): candidates worth trying — reduce or drop the streak-rotation for fine cellular noise
    specifically (shore foam's swash bands are much lower-frequency and may tolerate the rotation fine,
    even if the cellular structure they share does not); or accept the spiral as a small-obstacle-only
    cosmetic artifact and scope `WATER_BANK_REACH_PX`-style fading of the structure term itself very
    close to a shore.
  - **A real, unrelated bug caught by the Node suite, not the bench, mid-investigation.** The bankWarp
    experiment (reverted above) briefly made `water-render.js` read `field.drift` unconditionally, and
    the NEUTRAL stub `field` object used below tier 2 only had `domainOffset`, not `drift` — every
    below-tier-2 construction threw. The bench never caught it (always builds at tier 4); `node
    src/effects/water/__tests__/run-tests.mjs` failed immediately with a clear stack trace. Both the
    stub and the consumer were reverted together, so this specific instance never shipped — kept here
    as a reminder that a stub object's shape needs to track a REAL return's shape even for fields a
    change only reads unconditionally, not just the ones already tier-gated at the read site.
  - **Verified:** F2−F1 fix — all 5 bench scenarios pass (`tier4-gate-ladder-no-dead-term`'s own
    dead-term ladder specifically confirms `simFoamStructure` is genuinely non-constant against the
    real river, not just visually plausible). Node suite 539/539 (down from 541 — the retired
    `WATER_FOAM_CELL_EDGE0/1` test block was replaced with fewer, more honest construction-only
    checks, documented in `water-shore.test.mjs`'s own comment). Full `npm test`: 11,510 passed, 0
    failed. Lint clean (0 errors, 0 new warnings). **NOT verified:** the vortex fix (there isn't one
    yet), and the usual GPU-composite gap every round this phase has carried (reverted MRT bug).

### S5 (continued, 2026-08-19) — make water actually READ as flowing: three real fixes, live-verdict-driven

**Why:** live report, verbatim: *"The foam does not flow around obstacles at all. That's just not
functional in Foundry right now. There is no evidence of any part of the water moving around things
or flowing."* Full end-to-end trace of the whole flow pipeline (bake → tick → every consumer) found
the real, structural reasons, not a single bug:

1. The base water surface — the thing visible 100% of the time — never read the real solved flow
   field at all, only foam's shape did, and only at tier 4.
2. The cellular foam structure's own known, previously-diagnosed-but-unfixed spiral artifact (this
   file's own account two entries above) was very likely reading as decorative and static rather than
   as directional transport — the actual reason foam never looked "pushed," on top of #1.
3. `localFlowDirSafe`'s dead-zone fallback (falls back to the global compass whenever local solved
   speed reads near zero) was, on the author's explicit instruction, removed entirely: *"get rid of
   the escape hatch... either flow works or breaks, no fallbacks."*

**Fix 1 — `flowWarp`, bankWarp's sibling (`water-field.js`).** The base surface's noise domain was
already safely warped by two terms: `drift` (global travel, safe because spatially constant) and
`bankWarp` (the shoreline tangent, safe because bounded to a fraction of one noise cell, never
multiplied by time). Added a third, `flowWarp`: the REAL solved local direction's deviation from the
global compass, magnitude-clamped to at most 1 (two unit vectors differ by at most 2) before a small
constant (`WATER_FLOW_WARP_INFLUENCE = 0.35`, matching `WATER_BANK_INFLUENCE`'s own weight) scales
it. Same safety contract as `bankWarp`, a new input. **Verified on the real baked GPU cascade**
(`synthetic-river-flow-avoids-island`): the warp responds ~8.8× more strongly at the sharper of two
bends (0.29px vs 2.57px) and never exceeds its own 53.2px cap at either — both checked against REAL
baked flow data, not just the constant in isolation.

**Fix 2 — the spiral, actually fixed (`water-shore.js#buildFoamCellularStructure`).** Root cause,
finally isolated: `WATER_FOAM_STREAK`'s own original docstring always said its rotation must use a
GLOBAL direction ("rotating into it cannot fan out anywhere... safe anisotropy") — S4 (2026-08-18)
violated that contract by feeding the real per-pixel `localFlowDir` into that exact rotation, to make
foam shape respond to obstacles. Near a small obstacle the real solve's direction sweeps through a
wide angle range, and rotating a Worley field's query by a spatially-varying angle warps its apparent
cell layout into a literal spiral regardless of how bounded the rotated vector's own magnitude is —
confirmed by two reverted `bankWarp`-dampening attempts (documented two entries above) that changed
almost nothing, because the actual cause was never `bankWarp`. The fix restores the original
GLOBAL-only contract for the rotation, and gets real per-obstacle responsiveness back a SAFE way: the
real local direction only NUDGES the sample point by a bounded, additive offset
(`WATER_FOAM_FLOW_NUDGE = 0.35`, same law as `bankWarp`/`flowWarp`) before that now-always-safe
rotation runs. One shared function, one fix, both call sites (shore foam's `worleyLace`, sim-foam's
`simFoamStructure`) fixed at once. **Verified visually** on the real Underground river
(`debug-ch26-simFoamStructure-zoom.png`): the pattern now reads as elongated, vertical, connected
fibres — no concentric rings, no pinwheels, anywhere in frame. This is the "complex stringy mess"
look the author asked for two rounds ago, not a side effect.

**Fix 3 — the escape hatch, removed (`water-render.js`).** `localFlowDirSafe` no longer mixes back to
`uFlowDir` below the old 0.02 dead-zone; it is `localDirSafe` directly, always, everywhere. Honest
consequence, not hidden: a texel where locally-solved velocity is exactly/near zero (solid interior,
or not-yet-baked) now reads a degenerate near-zero direction rather than a graceful default — real
river speeds measured on the bench (0.8-0.98 normalised, ~40-50× the old threshold) mean this is a
true edge case, not the common path, but it is a real behaviour change. It immediately caught a real
gap in the bench's OWN fixture: the shared harness's generic `flowPackTexture` placeholder was
all-zero, which the old fallback silently papered over; without it, `tier4-gate-ladder-no-dead-term`
correctly went from PASS to FAIL (`breakFacing` read constant — `dot((0,0), anything) = 0` regardless
of the real tangent's own variation). Fixed the placeholder itself (a real, non-degenerate free-stream
reading), not the production shader — the bench's fixture was unrealistic, not the removed fallback
wrong.

**Verified, all together, same day:**
- Node: 551/551 water tests (5 new: `WATER_FLOW_WARP_INFLUENCE`/`WATER_FOAM_FLOW_NUDGE` bounds,
  `buildFoamCellularStructure`'s own construction with/without `localFlowDir`). Full `npm test`:
  11,522 passed, 0 failed. Lint clean, format clean.
- GPU bench, fresh server+tab, all 5 water scenarios green (`tier4-gate-ladder-no-dead-term`
  regression found and fixed same round, see Fix 3).
- The existing `real-sim-foam-centroid-moves-further-downstream-over-time` check (built in an earlier
  round, unmodified) still passes with sensible numbers across 5 real time samples (139px at t=1s to
  227px at t=5s, monotonic) — real, multi-frame, numeric confirmation the sim's own advection reads as
  travel, not just a single static frame.
- **NOT verified:** the live Foundry look itself — the WebGPU MRT gap every S5 round has carried still
  blocks a full in-editor GPU composite from this side. Bench and Node proof is real and multi-angle,
  but the author's own eyes in their own session are still the thing that actually closes this out.
- **A separate, pre-existing, OUT-OF-SCOPE finding, flagged not fixed:** `npm run verify:structure`
  currently fails on two violations with zero relation to water (`no-gpu-readback` in
  `vision-mask-render.js`; the `time/one-clock` ratchet at 41 vs. a bound of 38) — confirmed via `git
  diff` that neither file was touched this session or by this round. Left alone rather than fixed
  silently as a side effect of a water task.

### S5 (continued, same day) — FIRST LIVE CONFIRMATION, and the next three real gaps it revealed

**The milestone this whole thread has been working toward:** author, live, in Foundry, after S5-continued's three fixes above: *"Huge progress. Foam is now being pushed down stream which is starting to look like actual wakes / turbulence around rocks."* This is the first round where the author's own eyes confirmed flow reads as flow, not a bench number or a Node test. Three new, real gaps came with it, each fixed the same session:

**1. Pixelation, base surface and foam alike.** `flowPackTexNode` (`water-render.js`) sampled the coarse flow-pack grid with plain bilinear — fine while it only fed foam shape, a forgiving consumer, but `flowWarp`/the foam flow-nudge (this session's own earlier entry) made it load-bearing for the base surface directly, exactly the condition that already made the SIM pack alias once before. Same fix, same file's own established pattern: `buildSmoothTexelUv` C2 reconstruction, a new `flowPackTexSize`/`uFlowPackTexSize`/`setFlowPackTexSize` end-to-end (mirroring `waterSimTexSize` exactly), wired into `vt-pan-viewer.js` alongside the existing per-bake `setFlowPackTexture` call.

**2. "Lots of pixel hard binary edges... need noisy, grainy, evolving, bubbling, turbulent foam."** Two real, separable causes, both fixed in `buildFoamCellularStructure` (`water-shore.js`):
   - **Aliasing** — a FIXED world-space transition band (`WATER_FOAM_EDGE_NEAR/FAR`) covers fewer screen pixels the more sharply the underlying F2−F1 field changes per pixel at whatever zoom is actually active; no single world-space constant can prevent this at every zoom. Fixed with `fwidth()`-based adaptive AA (`WATER_FOAM_EDGE_AA_PX`): the transition band is now `max(EDGE_FAR, fwidth(edgeDist) × AA_PX)`, so it is never narrower than a few real screen pixels, regardless of zoom — the standard signed-distance-style AA technique, applied to both the coarse and fine octave independently (they alias at different rates). The SAME technique, same reason, applied a second time to the sim accumulator's own `WATER_SIM_CLUMP_LO/HI` threshold (`WATER_SIM_CLUMP_AA_PX`), a second independent source of the identical symptom.
   - **No evolution** — the cellular pattern only ever TRANSLATED (via `drift`); nothing made individual walls reform or bubble over time the way real foam does. Fixed with a new, faster, independently time-varying noise (`WATER_FOAM_BUBBLE_AMOUNT/OCTAVE/TIME_SCALE`) nudging WHERE the edge threshold falls, frame to frame — small relative to the wall band on purpose (nudges the existing net, does not invent a second one). Required threading `timeMsNode` into `buildFoamCellularStructure` for the first time (both call sites already had it in scope).
   - Also widened `WATER_FOAM_EDGE_FAR` itself (0.35→0.7) — a direct, first real-feedback-informed response, still explicitly provisional.

**3. "Wake looks great downstream... but upstream there is no evidence of the water flow going AROUND objects"** — author illustrated with a ship-bow-shaped rock splitter, arrows curving around both sides. Root cause, not guessed: the sim's WAKE reads well because foam emission (`emitFront`, `water-sim.js`) plus advection create a strong "near obstacle" cue almost independent of how much the velocity ANGLE actually deflects; `flowWarp`'s own visible bend, by contrast, scales DIRECTLY with the S3 solve's real deviation magnitude, which this session's own SOR account already measured as real but incomplete (≈2.8° at the sharpest bend tested). Fix: raised `WATER_FLOW_WARP_INFLUENCE` 0.35→1.0 — still safety-bounded by construction at any value (the input is magnitude-clamped before this multiplies it; the safety property was never "under one cell", it is "a fixed constant, never scaled by time"), and reasoned (not just guessed) to matter more at an actual stagnation point than the gentle bend it was measured against: potential flow genuinely turns far harder right at a splitting point than along an open bend. **Honestly incomplete:** this amplifies whatever real signal the solve produces; it cannot manufacture signal the solve does not have, and no bow-shaped bench fixture exists yet to measure this specific geometry directly — the live look is what actually settles whether this is enough.

**Verified:** 556/556 water Node tests (10 new this entry: `flowPackTexSize`'s own construction path exercised via the full 15-file suite; `WATER_FOAM_EDGE_AA_PX`/`BUBBLE_AMOUNT`/`BUBBLE_OCTAVE`/`BUBBLE_TIME_SCALE`/`WATER_SIM_CLUMP_AA_PX` bounds; `WATER_FLOW_WARP_INFLUENCE`'s own bound test rewritten now that it and `WATER_BANK_INFLUENCE` are deliberately no longer required to match). Full suite 11,527/11,527, lint clean, format clean. GPU bench, fresh server+tab, all 5 scenarios — same 2 pre-existing SOR-era failures, unchanged (this round never touches the solve itself, only how strongly its output is displayed); the new `flowWarp` checks still pass at the new 1.0 influence (warpBend2 now 7.36px, cap 152px, both measured against real baked data). Visually confirmed on the real Underground river: the cellular structure channel reads visibly softer/grainier than the previous round's own screenshot — direct evidence for the AA half of fix #2; the bubble/evolving half and the upstream-splitting fix are both mechanism-verified (construction, safety bound, the right real signal is being read) but NOT yet visually confirmed live — same standing limitation every round has carried, and the thing the author's next look settles.

### S5 (continued, same day, third round) — a real sign bug found, a second pixelation source found, and the "no bubbling at all" report answered with proof, not reassurance

Author's own live look at the previous round's three fixes found three more real things:

**1. A genuine sign bug — `flowWarp`/the foam nudge were pushing water INTO obstacles.** *"the flow seems to push the water INTO the stockwork at this angle, almost inverted from what it should do."* Root cause, re-derived from FIRST PRINCIPLES against this file's own already-proven `drift = −current·speed·t` law ("a pattern moves opposite to its domain"): `flowWarp` is meant to approximate the DIFFERENCE between a hypothetical local-direction drift and the existing global-direction one — `−localDir·speed·t − (−current·speed·t) = −(localDir−current)·(…) = −deviation·(…)`. The shipped version added `+deviation`, not `−deviation`. `bankWarp` (unnegated, correct) never exposed this because its own job — bend the pattern to run ALONG a tangent — is sign-symmetric; `flowWarp`'s job — deflect AWAY from an obstacle — is not, and existing tests only ever checked magnitude/cap, never sign, so a flipped sign passed every one of them. Fixed by negating both `flowWarp` (`water-field.js`) and the foam structure's own nudge (`water-shore.js`, identical bug, identical fix). **Proven against the ACTUAL COMPILED SHADER, not a JS mirror that could carry the same mistake:** a new debug channel (28, `flowWarp` alone) rendered at a real baked point with known deflection, read back, and checked for the correct sign — passes.

**2. A second, independent pixelation source.** *"Still lots of examples of horrible texels appearing which have sawtooth edges, hard edges and pixelated areas."* The flow-pack fix from the prior round was real but not the whole story: the water PRESENCE edge (`maskTexNode`/`WATER_PRESENCE_EDGE0/1`, `water-render.js`) has now had TWO prior, independent, VALUE-space fixes for this exact symptom (a 2026-07-26 ramp-width fix, then a mask upload-resolution increase) — both real, both insufficient alone, because neither addresses screen-space: a fixed value-space ramp still compresses into fewer screen pixels at some zoom or some fine mask detail, at any resolution. Applied the same `fwidth()`-based AA floor as the foam edges (`WATER_PRESENCE_EDGE_AA_PX`) — never narrower than the author's own calibrated ramp, only ever widens when the current frame's own zoom needs it.

**3. "No sign of bubbles or animation from the foam... at all... I asked for gritty, grainy, bubbly, evolving foam."** The previous round's bubble-nudge amount (0.12) was a reasoned guess, not a measured one, and it showed: too small against `WATER_FOAM_EDGE_FAR` (0.7) to read once actually watched. Two changes: raised `WATER_FOAM_BUBBLE_AMOUNT` 0.12→0.4 (still bounded well under the wall band, just no longer invisible), and added a SECOND, independent mechanism — grain (`WATER_FOAM_GRAIN_AMOUNT/OCTAVE/TIME_SCALE`), a fast, fine, time-varying noise that MULTIPLIES the final structure brightness rather than nudging where an edge falls, visible everywhere the structure is non-zero rather than only at its boundary — the more direct answer to "gritty," which the bubble nudge alone was never designed to deliver. **Proven with a real number, not an assertion:** the same debug channel rendered at the SAME crop, two `tSec` values 4 seconds apart, read back and diffed — mean absolute pixel difference 108 (of a possible 255), against a bar of >3. The first attempt's own silence is exactly what a value that small would have measured, had this check existed then.

**Verified:** 562/562 water Node tests (14 new: the sign fix's own construction/identity checks, the presence-edge AA bound, the bubble/grain constants' own bounds and relative-ordering checks). Full suite 11,533/11,533, lint clean, format clean. GPU bench, fresh server+tab, all 5 scenarios — same 2 pre-existing SOR-era failures, unchanged; TWO new checks added to `synthetic-river-flow-avoids-island` and BOTH pass against real baked/rendered data: the sign-proof (channel 28 read back at bend2, correct sign) and the animation-proof (channel 26 read back at two real timestamps, genuine large change). This is the first round this whole thread where a live-reported "still not working" was answered with a NEW automated check that would have caught the exact reported failure, not just a fix plus a repeated claim.

**Honestly still open:** whether the sawtooth the author saw is FULLY explained by the presence-edge fix, or whether a third source remains (a genuinely hard-edged, non-anti-aliased region of the source mask art itself would not be fixable from the shader side at all — shader-side AA can soften a transition, it cannot invent gradient information a hard-edged source never had). The live look is what settles this, same as everything else in this document.

**Addendum, same day — the author pushed back correctly: "It's not my artwork, it's the low resolution texels."** They were right, and named the exact fact that proves it: `_Water` uploads at the SAME 10,650×4,950 resolution as the map art (`MASK_IMAGE_SCALE = 1`, `vt/mask-image.js` — a real, dated 2026-07-26 fix for this exact symptom, on this exact file). The presence edge (previous entry) reads that texture directly and was never the bottleneck. Two DERIVED packs are:

- **The flow/sim grid — raised 1024 → 1536** (`WATER_FLOW_GRID_MAX_DIM`, `water-flow.js`). Its own original 1024 was justified as "velocity is smooth, low-frequency" — true of its ORIGINAL job, no longer the whole story now that `flowWarp`/the foam nudge (this same day, earlier) use it for sharp, obstacle-specific bending. 1536 matches the water body-pack's own already-proven-safe operating point, comfortably under the Keyhole 2,048px cap. **Verified as actually in effect** on the real map: `getStatus().grid` now reports `1536x714` (was `1024x476`), all 5 bench scenarios still green, 562/562 water tests, full suite 11,533/11,533.

- **The body pack's own tangent/SDF grid — found to be a SEPARATE, still-unfixed, DEEPER bottleneck, genuinely at 512, not 1536.** Correcting my own earlier assumption: `WATER_BODY_SUPERSAMPLE` reads as `1`, not `3` — a 2026-07-26 fix REVERTED an earlier 3× attempt on the same grounds the flow-grid fix above almost repeated blind: *"the grid is POINT-sampled, so there is no sub-texel coverage between its texels to find, however finely you sample it"* (`water-body.js`'s own header). That means `tangentXY` — the input to `bankWarp`, live and shipped since S1 — runs at `MASK_GRID_MAX_DIM` (512, shared with fire/specular/wind, NOT water-owned) — ~20.8 world-px/texel on this map, coarser than even the PRE-fix flow grid. Simply raising the supersample again would repeat an already-reverted, already-proven-ineffective fix. The real fix, if pursued, is architectural, not a constant: give the body pack's own JFA seed a WATER-OWNED read of the already-full-res mask at its own dedicated resolution — the exact pattern `water-flow.js`'s own solidity pass already uses ("Samples the FULL-RESOLUTION mask, never the coarse [grid]") — not a supersample bump. **Not implemented this round**: bigger blast radius than anything else this session (touches the JFA seed/flood pipeline directly, an area with two prior costly false starts in its own history), and the responsible next step is confirming with the author before committing to it, not guessing at the right shape under time pressure.

### S5 (continued, 2026-08-19, fourth round) — the controls-and-tuning turn: a dead-control audit, 27 new ROH params, and the body-pack resolution fix from the previous round's "not implemented"

The author's own request, verbatim: *"I want to do some fine tuning of the effect. Look at all FOH
and ROH controls for water. Get rid of ones that no longer work. Add TONS more controls with very
wide ranges for everything you've worked on with water so far... Of critical importance will be
giving me controls that let me change things about flow... Make it so that changing a slider (once
I let go, not before) rebakes or rebuilds things that need rebuilding for this to work."* Plus a
direct, correct pushback on the previous round's own close: *"the sawtooth pattern looks the same
so perhaps you need to increase the resolution of the other grid to the same resolution."*

**1. Dead-control audit — clean.** Every key in `WATER_DIALS` (FOH) and `WATER_PARAMS` (ROH) traced
to a real consumer; nothing removed because nothing was found dead. (`params/no-dead-controls`, this
codebase's own zero-tolerance structural wall, agrees — see §6.)

**2. 27 new ROH params, all live uniforms, none behind a hidden rebake unless the underlying work
genuinely requires one** — the "commit on release, not during drag" behaviour the author asked for
needed NO new UI code at all: `ui/widgets/param-control.js#buildRangeRow` already only calls
`onChange` on the native `change` event (release), never on `input` (drag). Split by what each
control actually costs to change:

- **Bank bend / Flow bend** (`bankInfluence`, `flowWarpInfluence`) — live uniforms into
  `water-field.js#buildWaterSurfaceField`'s existing `bankWarp`/`flowWarp` terms, both previously
  hardcoded constants (`WATER_BANK_INFLUENCE`, `WATER_FLOW_WARP_INFLUENCE`). No rebake — a per-frame
  read, exactly like every other tier-1+ surface param.
- **Flow solve strength / iterations** (`flowSolveOmega`, `flowSolveIterations`) — the ONE pair in
  this round that genuinely rebakes: SOR omega and iteration count are baked into the pressure
  solve, not read per-frame. Threaded through `runLevel`→`runFullBake`→`maybeBake`'s own rebake gate
  (`water-flow-subsystem.js`), the exact same `unchanged` boolean `flowAngleDeg` already extends —
  a change to either now triggers one full rebake, then nothing further until the next change.
  Range: omega 0.1–1.95 (SOR's own hard stability wall is 2; 1.95 stays a hair under it, matching
  `WATER_FLOW_SOLVE_OMEGA`'s own doc), iterations 5–200.
- **9 foam-structure params** (`foamFlowNudge`, `foamEdgeFar`, `foamEdgeAaPx`, 3×bubble, 3×grain) —
  live uniforms into `buildFoamCellularStructure`'s own already-null-safe params (built during the
  prior round's own bubble/grain work), now exposed rather than hardcoded.
- **7 sim-pack params** (`simFoamDecaySec`, `simDiffuse`, `simShearGain`, `simNearSolidGain`,
  `simClumpLo/Hi/AaPx`) — the sim's own decay/diffuse/emission gains, and the display-time clump/
  break threshold band (`WATER_SIM_CLUMP_LO/HI/AA_PX`, `water-sim.js` — the S5-#3 bug write-up's own
  "never written back into the buffer" rule, still true; these tune the READ, not the state).
  The first four are pulled fresh every `tick()` in `water-sim-subsystem.js` (same pattern
  `flowSpeedPx`/`foam` already use) — no rebuild needed, since the sim step material already reads
  live uniforms every frame. The clump band is a `water-render.js` display uniform, same pattern as
  the foam-structure params above.

Ranges are deliberately WIDE per the author's own instruction — e.g. `flowSolveIterations` 5–200
against a default of 60, `foamGrainOctave` 0.5–40 against a default of 11 — so the author can push
past what looks "reasonable" and find the actual edges of the effect while tuning.

**3. The body-pack tangent/SDF grid — the previous round's own "not implemented this round" item,
now done.** The author's correction was right to press on: raising the flow/sim grid alone (previous
round) could not have moved a sawtooth caused by the body pack's own, separate, still-512 grid.
Architecture, exactly as scoped and deferred last round: `WATER_BODY_GRID_MAX_DIM = 1536`
(`water-body.js`), sized from the water body's own WORLD RECT (`water-body-subsystem.js#sizeBodyGrid`,
new), the identical technique `water-flow.js#WATER_FLOW_GRID_MAX_DIM`/`sizeFlowGrid` already uses —
never a multiplier on the shared, cross-effect 512 derivation grid (`WATER_BODY_SUPERSAMPLE`'s own
now-superseded mechanism, frozen at 1 and kept only for its historical record). Combined with the
seed pass's own existing full-resolution, area-averaged mask read (2026-08-18, unchanged this
round), the flood now both sees the real mask at full detail AND has enough of its own output
texels to place a distinct seed near a small or closely-packed obstacle — the JFA flood's own
tangent field's real bottleneck, and a genuinely different problem from the interpolation-crease bug
`water-sampling.js`'s C2 reconstruction already fixed (that file's own header now says so explicitly,
to head off exactly the "we already proved resolution doesn't matter" confusion this round's own
research had to work through before implementing). 1,536 matches the flow pack's own cap exactly —
the two grids no longer drift apart — and stays comfortably under the Keyhole allocator's 2,048px
cap with no exception needed, at the same VRAM cost the 2026-07-26 reverted 3× supersample attempt
already budgeted for.

**Verified:** 568/568 water Node tests (6 new: the SOR rebake-gate tests mirroring the existing
`flowAngleDeg` one, the body-pack grid-cap assertions replacing the now-superseded 1:1 assertion).
Full suite 11,539/11,539, lint clean, format clean. `effects/uniform-budget` — `water-render.js`
crossed its 40-call soft cap (42, from this round's new live uniforms) and the debt was registered
(`tools/uniform-budgets.json`) rather than the file split, a judgment call: the author explicitly
asked for many more controls, growing this count is the direct and intended consequence of that
ask, and the tool's own guidance names debt-registration as the sanctioned path when a file
"genuinely needs this many uniforms right now." `verify:structure` otherwise clean except two
PRE-EXISTING, unrelated failures (a `no-gpu-readback` violation in `vision-mask-render.js` and a
`time/one-clock` ratchet break across `boot.js`/`decode-pool.js`/etc.) — confirmed via `git status`
to be untouched by this session's own changes, not investigated or fixed here as out of scope for a
water-controls turn.

**Honestly not done this round:** no GPU-bench scenario exercises `water-body-subsystem.js`'s own
`sizeBodyGrid`/`uploadMask` path directly — that subsystem has no dedicated fake-GPU test harness by
existing precedent (`water-flow-subsystem.test.mjs`'s own header names the precedent explicitly: its
own GPU-orchestration glue is judged too coupled to real render targets, and leans on live/bench
verification instead), and standing up the full mask-authority/floor-resolution chain the shader-lab
bench's own scenarios use was judged out of scope for this round. The resolution fix is Node-test-
proven (the sizing arithmetic mirrors `sizeFlowGrid`, already bench-proven for the flow grid) and
consistent with the architecture the author explicitly authorized, but — same as every fix in this
whole document — the author's own live look in Foundry is what actually confirms the sawtooth
resolves, not this write-up.

### S6 — Clumping and breaking
- The diffusion step already lives in `water-sim.js` (gather, via blend-toward-blur, applied to the
  STATE). The nonlinearity/threshold step does NOT — see S5's own bug writeup above: it is a
  DISPLAY-time transform for whichever pass reads `res:waterSim`, tuned with `TAU_FOAM`, `DIFFUSE`,
  `CLUMP_LO/HI` on the bench, never written back into the ping-pong buffer itself.
- **Proof:** foam patches visibly gather, tear apart, and re-merge.
- ⚠️ **PARTIALLY ANTICIPATED EARLY, inside S5's own third live-feedback round (2026-08-19)** — not a
  full start of this phase, worth naming so the two don't get confused. `waterSimFoam.mul(structure)`
  (S5's own entry above) gives foam a STATIC spatial "tear apart" (true holes, cellular walls) but not
  a DYNAMIC one — the holes do not open, close, or migrate over time, and nothing here makes a patch
  visibly detach and travel independently. This phase's own "gather, tear apart, and re-merge" proof
  criterion is still open; what exists today is closer to "always torn apart in a fixed pattern."

### S7 — Sediment
- `G` channel: picked up in fast water, settles in slow water, tints via the §2.7 material rows.
- **Proof:** visible drifting silt that pools in the slack water.

### S8 — Particles: bubbles and splashes
- Spawned from the sim's turbulence channel.
- **Proof:** the rock throws spray; the pool bubbles.

---

## §5 Cost and VRAM budget

Sim/flow grid: **1024 × 476** (aspect-matched, ~10.4 world px/texel, well under the Keyhole
2048 cap — no allocator exception needed).

| Item | Cost | Cadence |
| --- | --- | --- |
| Solidity raster (16 taps) | ~7.8 M texel-ops | mask change only |
| Pressure cascade (5 levels × 20 it.) | ~13 M texel-ops | mask/flow-param change only |
| **Flow bake total** | **~3–6 ms** | **not per frame** |
| Sim pass (advect+emit+clump) | ~5 M texel-reads, **< 0.2 ms** | per frame, gated |
| Surface shader | **+2 texture taps** | per frame |
| VRAM: flow pack | 3.9 MB | |
| VRAM: sim ping-pong | 7.8 MB | |
| **VRAM total** | **~11.7 MB** | inside the water reservation |

The per-frame addition is one small pass and two taps. The expensive part is a bake that runs when
the author repaints, which is the same discipline the JFA flood already follows.

**Ladder placement (proposed amendment to Testament §3.6):** the flow field costs *nothing* per
frame once baked — it is a texture read replacing a uniform — so it belongs **low** on the ladder
(tier 2, `performance`), not gated behind `extreme`. Only the per-frame sim (S5+) is tier 5–6.
This is a genuine improvement on the Testament's own placement.

---

## §6 The rules this must not break

1. **No fragment-stage `uniformArray` dynamic indexing.** One confirmed live-Foundry failure
   (scene went black). Fixed-count unrolled taps and baked textures only.
2. **Tier gating is JS-time `if (activeTier >= N)`** — features compile *out*, never multiply by a
   uniform zero (Effects.md Law 4).
3. **Bake count ≠ frame count**, with the counters to prove it (`feedback_residency_sync_vs_render_loop`).
4. **Law 7:** the sim ticks whether seen or not → coverage and zoom gates are mandatory, not
   optional.
5. **Law 2:** the sim ADDS into the foam total; tier 2's crest foam is never substituted away.
6. **NEW, from §1 — every texture node built against a re-pointable texture must be returned in an
   array and re-pointed together.** Fixed at S0 (`maskTexNodes`, both loud comments at the array's
   declaration and at the ring loop that pushes into it) — **NOT yet a `verify-structure` wall**;
   a naive regex cannot tell "pushed to the tracked array" from "not", and shipping a rule that
   only LOOKS like it checks this would be worse than the comments alone. A real check needs the
   tool to compare occurrence counts (`texture(maskTexture,` vs `maskTexNodes.push(` + 1), which
   is a real, scoped follow-up, not done here under an already-large turn.
7. **No constant calibrated against an assumed distribution** — measure on the bench, pin the
   number with its provenance (this project's own repeated scar).
8. **`npm run verify` green is a floor, not evidence.** It cannot see any bug in this document.
   Only the author's map promotes anything to LIVE.

---

## §7 What this supersedes

- **`water-shore.js`'s tail taps** (`WATER_TAIL_TAPS`) — the stateless fake of memory. Deleted at
  S5, replaced by real advection.
- **The obstacle/mask proximity rings** — demoted from "the foam mechanism" to *emission inputs*
  for the sim.
- **The derived-grid dependency for local geometry** — replaced by full-res direct reads.
- **Testament W4's remaining stateless bullets** (whitecaps, lee-scum placeholder) — the lee-scum
  placeholder is made redundant by S6 (real convergence accumulation); whitecaps still want the W2
  wind covenant.
- **Testament ladder §3.6** — flow field enters at tier 2; sim memory stays tier 6.

---

## §8 Honest limitations, stated up front

- **No vortex shedding** in v1 (§3 Layer B). Wakes come from advected emission, not from shed
  eddies. If the author judges the lee too clean, vorticity confinement is the named next step.
- **Sim resolution is ~10 world px/texel.** Foam finer than that comes from shader-side noise
  modulated by the sim, not from the sim itself. This is the standard split and it is why the
  grain survives at close zoom.
- **Tokens do not yet displace flow.** The bake reads the mask only. Dynamic obstacles are a
  follow-on (rebake on move is affordable; a per-frame perturbation pass is the alternative).
- **One-frame latency** anywhere the sim reads its own previous state. Invisible at these decay
  rates; stated so nobody re-derives it as a bug.
- **This is a plan, not a result.** Nothing in it is proven on the author's map. Each phase's
  proof gate exists precisely because today demonstrated that my confidence is not evidence.
