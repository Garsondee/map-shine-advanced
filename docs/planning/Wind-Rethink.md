# WIND — THE RETHINK

**Status:** §4's design is BUILT (2026-07-22, same day) — verify-green (3043 tests, 24 structure rules, two ratchets tightened by the deletions), NOT YET LIVE-TESTED. Binary openness only, per §5 q1's own recommendation and the author's explicit "start with binary for testing... aim to do something more interesting if it works" — the graded-falloff option, funnelling, and turbulence (§5 q2-q4) are still open, unbuilt. See `keyhole-wind-openness-rebuild` (memory) for the implementation record. This document exists because the current approach had failed enough distinct ways, in one continuous debugging session, to prove the _architecture_ was wrong — not any single line.

**Author's directive (verbatim intent):** _"It's time to rethink the wind simulation because the current approach isn't working."_ And the recurring functional ask across the whole saga: _"Wind correctly pushes around buildings and looks amazing outside but it fails to do anything interesting when doors/windows open and the wind is allowed inside of a building… we're interested in just a general effect of wind that can then be used by anything which requires it."_

**The one sentence that matters:** the author proved, by **deleting every wall from the scene**, that wind still dies exactly where the painted `_Outdoors` mask goes dark — _"the wind dies because it ends up in the black pixels of the `_Outdoors` mask and not because it's sheltered from the wind."_ That is the whole bug, and it is architectural.

---

## 1. THE FAILURE CHRONICLE (what we tried, in order, and why each failed)

Every one of these was verify-green and individually reasoned. Each fixed its target and revealed the next failure. That pattern _is_ the diagnosis.

| #   | Change                                                                                                                     | What it fixed                                                                                             | What it revealed / why it failed                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Counter-wind fix** (`sampleWind`: stop exposure-scaling the ambient)                                                     | Indoor particles no longer blew _backwards_ at gale speed. **Author-confirmed live.**                     | Genuinely correct, but only unmasked the deeper problem: wind still wouldn't _enter_ an open building.                                                                                                                                             |
| 2   | **Door-chaos** (turbulence seeded near painted-outdoor openings)                                                           | (Intended) chaotic churn near doors.                                                                      | Never visibly worked — its signal never reached the visible particles, and it was gated on the same painted mask.                                                                                                                                  |
| 3   | **Storage-buffer limit** (raise `maxStorageBuffersPerShaderStage`)                                                         | A hard WebGPU crash when Wind Gusts added a 9th buffer.                                                   | Real fix, but unrelated to the actual wind behaviour — just unblocked testing.                                                                                                                                                                     |
| 4   | **Live-connectivity coherent gate** (gate on the relaxation's own flow magnitude)                                          | (Intended) door-awareness without a repaint.                                                              | Read the _never-converged relaxation_ as truth → manufactured full-speed "red energy" deep inside sealed corridors.                                                                                                                                |
| 5   | **Relax-iteration scaling** (iterations ∝ grid size)                                                                       | A convergence regression **I introduced** in the resolution fix.                                          | Bandaged a symptom of the relaxation being fundamentally too slow; the far ends of long corridors still never settled.                                                                                                                             |
| 6   | **windReach v1** (distance-decay flood-fill from painted-outdoor seeds, replacing the relaxation for "how sealed is this") | Removed the convergence problem entirely — a flood-fill is exact in one pass.                             | The decay was **anchored to the painted mask**, so the mask became the master switch: wind faded out with distance from painted-outdoor pixels and died in large interiors.                                                                        |
| 7   | **Fine reachability** (rasterize the reach mask 4× finer, no over-sealing)                                                 | The coarse over-sealed grid had fused a curved entrance into one solid band; removing a door did nothing. | Correct and necessary, but still built on top of windReach-v1's mask-anchored seeding.                                                                                                                                                             |
| 8   | **windReach v2** (binary connectivity to the map border, geometry-only)                                                    | (Intended) divorce wind presence from the painted mask.                                                   | The author's final test — **all walls deleted** — still showed wind dying at the `_Outdoors` boundary, proving a mask dependency _survives somewhere the coherent path still touches_, and that the whole layered edifice is too tangled to trust. |

**Eight changes. Each verify-green. The effect is still, in the author's words, "still bad, still broken, still not right, still very unimpressive."**

---

## 2. ROOT-CAUSE ANALYSIS (why it kept failing)

Not eight bugs. Four structural mistakes, each of which the patches kept circling without removing.

### 2.1 The painted `_Outdoors` mask was conflated with "where wind can be"

`_Outdoors` is **painted art**. Its job is _"is this pixel visually outdoors"_ — for shading, rain occlusion, atmosphere. It has **no knowledge of walls, doors, or openness**, and it never changes when a door opens. We repeatedly used it to **seed and gate the wind field** (exposure-damping, windReach seeding, door-chaos seeding). So the answer to _"can wind reach here?"_ was being read off a static painting of _"does this look like outside?"_ — two different questions that happen to correlate outdoors and diverge completely the moment you ask about an _open_ interior. **This is the bug the author isolated by deleting all walls: with no geometry left to matter, the painted mask was visibly the only thing still deciding where wind lived.**

### 2.2 The coarse bake grid destroys the geometry that actually matters

The physics grid is ~240×240 (~73 px/cell) for the whole scene, with a deliberate diagonal "over-seal" guard. At that resolution, with over-sealing, a curved mansion entrance — arches, columns, door frames — **fuses into one solid band**, and door openings smaller than a cell or two vanish. So even a _geometry-based_ answer was being computed on a geometry representation too crude to contain the openings the whole feature is about. (Patch #7 raised the reach grid to 4× — a real improvement, but it was bolted onto the mask-anchored model, so it couldn't fix the presence question by itself.)

### 2.3 The potential-flow relaxation is the wrong engine for this job

The baked "structure" field (`bakeWindStructure`) is a Jacobi relaxation of a scalar potential. It has three fatal properties for our use:

- **It converges one cell per iteration**, so a long corridor needs proportionally many iterations and, past a length, never settles in any sane budget (patches #4, #5 chased this).
- **It is irrotational by construction** — it _cannot_ produce a vortex, eddy, or turbulent wake. Wind hitting a wall correctly slows, but it can never _swirl_ around it. The author has asked for exactly that swirl more than once ("turbulent areas redirecting the force").
- Its indoor output is **unreliable**, so everything downstream had to add a _second_ mechanism to mask it — which is how we ended up with four overlapping "how sealed is this" systems.

### 2.4 Too many overlapping mechanisms, each patching the last

By the end there were **five** different things all trying to answer "how much wind is here": the exposure `amount` multiplier, the relaxation deviation `D`, `coherentGate`, `windReach`, and `door-chaos`. They fought each other, and the painted mask leaked into three of them. **No single place owned the answer**, so every fix had to reason about the interactions of all five — which is why each one broke something else.

### 2.5 The meta-lesson

We kept treating this as a **physics simulation** to be made more correct, when the author has said repeatedly it is **a general effect** to be made believable and cheap. Correctness of a potential-flow solve is not the goal; _"wind visibly gets into open buildings and not sealed ones, and looks good doing it"_ is. Those call for different architectures, and we kept building the first while being asked for the second.

---

## 3. THE SPEC, RESTATED CLEANLY (what "done" actually is)

Distilled from the entire saga. This is the contract the new design must meet:

1. **Outdoors:** wind blows in the ambient direction, gusting, and looks great. _(This already works and must be preserved.)_
2. **Sealed interior:** calm. A room with every door and window shut has still air (plus, optionally, a faint draft).
3. **Open interior:** when a door or window is open — **or a wall is missing** — wind gets _inside_, through the opening, and does something visibly interesting.
4. **Door-responsive:** opening/closing a door changes the result, live (a rebake is fine; it already triggers).
5. **Geometry decides presence, not paint:** whether wind can reach a cell is a function of **walls and doors only**. The painted `_Outdoors` mask must have **zero** influence on where wind can be. (It keeps its real jobs — shading, rain — elsewhere.)
6. **A general effect, not a simulator:** cheap, robust, believable. Physical plausibility is a nice-to-have, never a requirement. No convergence budgets, no per-frame solves.
7. **One source of truth:** exactly one field that everything (particles, gusts, candles, lights, the overlay) samples. One place owns "how much wind is here."

---

## 4. THE PROPOSED NEW ARCHITECTURE — "Openness-first"

One idea, applied ruthlessly: **collapse the five overlapping mechanisms into a single geometry-derived scalar field, `openness`, and divorce the painted mask from wind entirely.**

### 4.1 The whole model in one line

```
W(cell) = A · openness(cell)  +  gusts(cell)  +  turbulence(cell)
```

- **`A`** — ambient wind (direction + speed). Analytic, uniform, already exists (`res:env.wind`). Free.
- **`openness(cell) ∈ [0,1]`** — the star. "How exposed to the outside wind is this cell," from **walls + doors only**. This _replaces_ exposure-damping, the relaxation deviation, `coherentGate`, and `windReach` — all four collapse into this one field.
- **`gusts`** — the organic drift/flutter noise. Present everywhere, scaled by `openness` (a sealed room can keep a tiny always-on residual if desired — that is the _only_ thing the painted mask might still touch, and even that is optional).
- **`turbulence`** — the "interesting" churn: swirl near openings and behind obstacles. This is where the author's repeated "turbulent redirection" ask finally lives, and it is _additive_ and _local_, not a global solve.

No potential-flow relaxation. No painted-mask seeding. No five-way interaction.

### 4.2 How `openness` is computed (the crux)

A cheap, exact, geometry-only pipeline that runs on wall/door change (never per frame):

1. **Rasterize walls + doors at a FINE grid** (e.g. 4–8× the current physics grid), **without** the diagonal over-seal guard. A leak in a _connectivity_ mask only ever helps wind find a real opening; it can never corrupt anything (there's no solve to corrupt). This is patch #7, kept.
2. **Flood-fill from the map's open exterior** (its border) through open cells. A cell reached by the fill is **connected to the outside**; a cell not reached is **sealed**. This is pure graph connectivity — walls and doors only, **no painted mask**, exact in one linear pass at any building size.
3. **`openness = 1` for connected cells, `0` for sealed.** Downsample to whatever resolution consumers sample. _(Binary is the default and directly satisfies the author's "no walls → wind everywhere" test.)_
4. **OPTIONAL penetration falloff (a later polish, off by default):** if "wind should fade as it travels deep past an opening" is wanted, decay `openness` by graph-distance **from the opening itself** (the boundary between connected-interior and exterior), _not_ from the painted mask and _not_ from the map border. This is the only correct place for a falloff, and it must be opt-in so it can never re-introduce the "dies at the boundary" failure. **Ship binary first; add this only if the author asks.**

### 4.3 What each piece buys us

- **Sealed room → `openness 0` → `A·0 = 0` → calm.** Correct, and it doesn't matter what the relaxation would have said (there is no relaxation).
- **Open a door → the room joins the connected set → `openness 1` → full ambient wind fills it.** Door-responsive by construction.
- **Delete all walls → everything connected → `openness 1` everywhere → wind everywhere.** The author's exact test, passing by definition.
- **Outdoors → connected → `openness 1` → full `A` + gusts.** The good outdoor look, preserved, because outdoors is trivially connected.
- **The painted `_Outdoors` mask is not consulted for wind at all.** The single most-repeated failure cause is gone by construction, not by patch.

### 4.4 Funnelling and turbulence (the "looks amazing" and "interesting" parts)

The outdoor look the author loves is _mostly_ ambient direction + organic gusts (the probe data shows the structure/funnelling term is a modest ~0.27 vs the ambient's 1.0). So:

- **Funnelling (wind bending around building exteriors):** re-evaluate whether it's even load-bearing for the look. If it is, produce it with a **cheap, local wall-avoidance** (nudge the wind vector parallel to a nearby wall's face — a small per-cell correction from the fine wall mask, no global solve) rather than a potential-flow relaxation. If it isn't, **delete the relaxation entirely** and accept ambient+gusts outdoors.
- **Turbulence (swirl near openings and behind obstacles):** an _additive_, _local_ curl-noise term gated to the shell near solid cells and openings — the already-researched "geometry-gated turbulence" (Bridson) banked in `docs/reference/wind-simulation-research.md`. This is where wind gets _interesting_ indoors near an open door, and where it finally swirls behind a wall instead of sticking to it. Local and additive means it can never destabilise the whole field.

### 4.5 What gets deleted

- The **potential-flow relaxation** (`bakeWindStructure`'s Jacobi solve) — or demoted to an outdoor-only cheap wall-avoidance. All of patches #4/#5's convergence machinery goes with it.
- **Exposure-based wind gating** everywhere (`amount` on the coherent term is already gone; the remaining organic damping becomes optional and is the _only_ surviving mask touch, if kept at all).
- The **overlapping "how sealed is this" mechanisms** — `coherentGate`, `windReach`-as-decay, and the exposure gate all collapse into the one `openness` field.

### 4.6 What gets kept

- `res:env.wind` ambient scalar. Untouched.
- The **fine, non-over-sealed rasterization + border flood-fill** (patches #7 + #8's _geometry_ half) — this becomes `openness`.
- The **particle/gust engines**, the **texture-B-channel plumbing**, the **rebake-on-door-change trigger**, and the **wind+particle probe** — all reusable; they just read `openness` instead of the tangle.
- Door-chaos's _idea_ (local turbulence near openings) folds into §4.4's turbulence term.

---

## 5. OPEN QUESTIONS FOR THE AUTHOR (decisions this design needs)

1. **Binary vs. penetration falloff.** Default is binary (open→full wind, sealed→calm), which passes your "no walls" test cleanly. Do you want the optional deep-interior fade (§4.2 step 4), or is "the whole connected space is windy" the right feel? _(Recommendation: binary first, decide the fade after seeing it.)_
2. **Keep any funnelling?** Is the outdoor "looks amazing" carried by the ambient+gusts, or does it genuinely need wind to bend around building exteriors? If we can drop it, we delete the entire relaxation and all its pain. _(Recommendation: try deleting it; add cheap local wall-avoidance back only if the look regresses.)_
3. **How much turbulence, and where?** Just near open doors? Everywhere near walls? This is the "interesting" dial and it's a taste call. _(Recommendation: start with turbulence gated to the shell around openings, expand if it reads too subtle.)_
4. **Faint sealed-room draft?** Should a fully sealed room have _zero_ air, or a barely-perceptible residual stir? The latter is the only remaining reason to consult the painted mask at all. _(Recommendation: zero — simpler, and "sealed = still" is what you asked for.)_

---

## 6. WHY THIS ONE WON'T ROT THE SAME WAY

The eight failures all trace to **presence being answered by the wrong input (paint) on the wrong representation (coarse) by too many mechanisms (five)**. This design answers presence with the **right input (geometry)**, on the **right representation (fine mask)**, through **one mechanism (a flood-fill)**, and **never consults the painted mask for wind**. Every failure mode in §1 becomes impossible by construction rather than patched:

- Mask can't gate wind → it isn't in the wind path.
- Relaxation can't fail to converge → there is no relaxation.
- Openings can't be lost → fine mask, no over-seal.
- Mechanisms can't fight → there is one.

It is also **strictly cheaper**: one fine rasterization + one flood-fill per door change, no per-frame solve, no iteration budget. And it is **honest to the brief** — a general, believable effect, not a simulator straining to converge.

---

## 7. STATUS

**BUILT (2026-07-22, same day as this document).** §4's design shipped exactly as specified: `bakeWindStructure`/`applyWakeTurbulence`/`curlNoiseVector` and all five overlapping mechanisms (§2.4) are DELETED from `world/wind-bake.js`/`world/wind-enclosure.js`; `openness` (binary, §5 q1) is the one geometry-derived scalar every consumer (`particle-runtime.js`, `gust-runtime.js`, `sampleWind`, the wind+particle probe) now reads. **Part 1's counter-wind fix survived, as predicted** — it's a property of "ambient at full strength," which `coherentVec = ambientBias` (now gated by `openness` instead of a relaxation) still is. Verify-green (3043 tests, 24 structure rules) — NOT YET LIVE-TESTED; the author's own decisive "no walls" and "open a door" experiments are the next things to re-run.

**Still open, unbuilt, per §5:** q1 is answered (binary); q2 (keep any funnelling?), q3 (how much/where turbulence?), and q4 (faint sealed-room draft, or dead zero?) are all undecided — this build ships the doc's own recommended defaults for each (delete the relaxation outright, no turbulence yet, zero for a sealed room) as the starting point, not a final answer. Tier 2 (`world/wind-sim.js`/`wind-sim-gpu.js`, the transient door-gust sim) is untouched and still reads a `bakedField` texture whose R/G channels are now always zero — see that file's own header for the resulting, currently-unverified gap.

**Related memory:** `keyhole-wind-openness-rebuild` (this build's own record — read FIRST for current wind work), `keyhole-wind-rethink-doc` (this pivot's own trigger record), `keyhole-wind-indoor-counterwind-fix` (Part 1, the keeper). The granular patch-by-patch memories this document's own §1 chronicles (windReach, door-chaos, the relax-iteration fix, the bake-grid-resolution fix, the fine-reachability fix, the coherent-gate fix) are superseded and deleted — their content lives in §1's table above. **Related docs:** `Wind.md` (the original spec, now banner-flagged to point here for the presence question), `docs/reference/wind-simulation-research.md` (the banked Bridson turbulence, still unused, for a future §4.4 turbulence pass).
