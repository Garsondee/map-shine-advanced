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
  source is smaller than the target it renders into. Every level's own solidity is re-derived FRESH
  from the original full-resolution mask (S2's own seed pass, re-run at each level's resolution) rather
  than cascaded level-to-level, matching the CPU reference's own choice exactly.
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
- Node tests: `water-flow.test.mjs` extended with construction tests for all four new materials at
  four aspect ratios, PLUS a pin on `jacobi.prevTexNodes.length === 5` and
  `pack.pressureTexNodes.length === 5` (centre + 4 neighbours each) — the exact re-pointing-array
  discipline `feedback_texture_nodes_must_be_repointed_together` exists to guard, now guarded by a
  test instead of only a comment. `npm test`: 11,055 passed, 0 failed. `npm run verify`: lint/format
  clean; structure clean except the SAME two pre-existing, unrelated failures noted since S0
  (confirmed via `git diff` to predate this whole plan). The `graph/reachable-from-boot`
  `[structure-change]` from the CPU-reference phase REVERTED itself (3→2) the moment
  `water-flow-subsystem.js` started importing `WATER_FLOW_SOLVE_LEVEL_FRACTIONS`/
  `WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` directly from `water-flow-solve.js` — the CPU reference is
  now a genuine, reachable dependency of the shipped port, not a standalone proof with no consumer.
- **NOT done:** `maybeBake`'s trigger set does not yet include a check on `flowSpeedPx`-driven
  "is this effectively a pond" — a zero-speed pond still runs the FULL cascade (harmlessly, since the
  seed is exactly zero throughout and the solve is trivially divergence-free, but at unnecessary GPU
  cost); a cheap early-out is a reasonable follow-up, not required for correctness. S4 (rewiring
  swash/break/streak onto the real pack) has not started.
- ⚠️ **Proof line NOT met — needs the author's own eyes on channel 23, live.** Everything above is
  numerically proven on the CPU reference and structurally verified to construct/wire/test clean; NONE
  of it has been seen bending around a real rock on the author's own river yet. "The author sees flow
  visibly bending around the rock" remains the exit criterion, unchanged.

### S4 — Rewire the existing terms onto real velocity
- Swash amplitude/phase speed ← local velocity (the author's explicit ask).
- Break foam ← `emitFront` from the real field instead of the SDF tangent dot product.
- Streak anisotropy ← local flow direction instead of the global uniform.
- **Proof:** shore waves respond to the flow compass and speed; still stateless, but alive.

### S5 — The sim buffer: advect + decay + emit ★ MEMORY
- `water-sim.js`, `sims.water` pass (the graph seam is already reserved), Law 7 coverage/zoom
  gates, per-floor instances.
- **Proof:** foam sheds off the rock and **rides the current downstream while fading**. This is
  the rung where water becomes alive.

### S6 — Clumping and breaking
- The diffusion + nonlinearity step; tune `TAU_FOAM`, `DIFFUSE`, `CLUMP_LO/HI` on the bench.
- **Proof:** foam patches visibly gather, tear apart, and re-merge.

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
