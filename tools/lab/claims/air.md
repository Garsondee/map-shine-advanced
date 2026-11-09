# Claims: the air in 3-D (Lab · Air, 2026-11-09)

Written 2026-11-09, before any measurement, for Ingram's brief of the same day: "focus on JUST the WIND ... coarse in
resolution but something where opening a door causes a turbulent draft to enter a building, something where the 'wind
shadow' of a building exists, where potentially narrow funnels increase wind pressure ... surely wind loses strength when
it enters a tunnel or building, surely wind must either go around a building or be pushed upwards to go above it? We're
requiring a 3D representation of that energy." (rants archive, 2026-11-09).

Wind physics numbers and sources shared with the 2-D lab are in `claims/wind.md` (Beaufort, gust factor, turbulence
intensity, building wakes, courtyards, indoor drafts). This file adds the third dimension. The **Result** column is filled
only by a measurement (offline model: `tools/lab/air-bench.mjs`; live: `MapShine.air.*` on the rig).

## 1. What we have (master 942ed95e) and why it cannot do what she asked

| Piece | What it is | What it gets wrong |
|---|---|---|
| Analytic field (`world/wind-field.js#sampleWind`, the default) | mean x gust envelope + curl-noise turbulence, then GATED by geometry: openness (doors, a distance fade), a 24-cell upwind "shadow" march, a wall deflection | Nothing carries momentum or conserves air. A room behind any open door fills with ~0.85 U of the OUTDOOR wind, pointing the OUTDOOR way; the lee is a rectangle cut out of the field; nothing goes over anything. A fire in a windward-door room leans straight downwind (her report). |
| Living Wind (`world/wind-flow*.js`, off) | 2-D stable-fluids solver on the bake grid: advect, relax to the analytic driver, vorticity confinement, Jacobi projection | Fixes the rooms (mass conservation: a dead-end room gets a weak exchange). But every wall is infinitely tall: the third dimension is ONE number, a screened Poisson (`verticalEscapeM` 6 m) that lets convergence "leak upward". No building height, no roof lid, no air above a roof, no faster air aloft, no turbulence energy (a door draft is either a laminar jet or nothing). |

## 2. The reimagined model — "Air": a coarse 3-D box of air

- **A stack of layers over the map**, not one sheet: 0-1, 1-2, 2-3.5, 3.5-5, 5-7, 7-10, 10-14, 14-20 m. One column per
  grid square (her 5-ft squares, ~1.5 m), plus a ring of open margin round the scene for inflow and outflow.
- **Walls have height.** A wall that bounds a roofed room stands to the building's height (default 6 m); a free-standing
  wall between two open-sky cells is a garden wall (2 m). An open door is a hole in the bottom 2 m of its wall; a closed
  door or window is wall. A roof is a LID at the building's height: air above it flows over, air under it is indoors.
  A roof with no walls (a pavilion, an arcade, a tunnel) lets air through underneath.
- **Air is a fluid on a staggered (MAC) grid**: velocities live on cell faces, each face has an OPEN fraction (a wall is a
  closed face, so a thin wall costs no cells and a 1-square door is still a door). Each step: advect momentum, relax the
  upper air toward the weather (the dial's wind, faster with height by the log law, with its gust fronts), drag at the
  ground, mix momentum between layers, then a pressure solve so every cell keeps its air (what enters a room must leave).
  The pressure solve is what makes air climb a windward face, spill over a roof, squeeze through a gap and refuse to
  enter a dead end.
- **Turbulence energy, carried as its own field (k).** A coarse grid cannot resolve the churn at a doorway, so the energy
  of that churn is a scalar that is made by shear (doors, corners, roof edges, wakes), carried by the air, spread by
  mixing (this is how a dead-end room near a windward door gets a draft with no net through-flow) and burned off
  (faster in small rooms). Effects get the mean air PLUS swirl scaled by sqrt(k): a door makes a turbulent draft, not a
  hose.
- **Runs on the CPU in a worker** (a spare core, not her GPU), a few steps a second; the ground layers are handed to the
  same baked field every effect already reads (so vegetation, fire, rain, flies, candles inherit it with no change), and
  the whole 3-D box is there for the wind view and for height-aware effects later (smoke climbing into faster air).

## 3. Behaviours I want to see

1. **Up and over, and around.** Air meeting a building climbs its windward face (and some dives to the ground and runs
   round the corners); it crosses the roof and comes down behind.
2. **A wind shadow.** Behind a building: slow, gusty air, partly REVERSED near the ground (smoke drifts back toward the
   wall), a few building heights long, longer behind taller buildings, healing back to the open wind.
3. **Funnels.** A narrow gap between buildings speeds the wind up (dynamic pressure, what pushes flames and leaves,
   goes as speed squared) but less than a garden-hose Venturi would, because air can also go over the top.
4. **Streets.** A street along the wind channels it; a street across the wind is sheltered with a slow reversed rotor.
5. **A windward door into a dead-end room**: a short, churning draft through the door, air curling round the room and
   back out the same door; turbulent near the door, nearly still at the back.
6. **Two doors (cross-ventilation)**: a real draught through the room along the line between them.
7. **A lee door**: a little suction and swirl, almost nothing.
8. **Tunnels and arcades**: wind goes through, weaker than outside (entry loss, friction, and the easier path over).
9. **Pavilions** (a roof on posts): wind blows underneath, a little slower.
10. **Courtyards**: a slow rotor, gusty, direction confused.
11. **Higher is windier**: tree-tops and rising smoke feel more wind than the grass.
12. **Gusts arrive as fronts**, buildings soften them, and a door draft surges with each gust.
13. **Garden walls** make a short strip of shelter.
14. **Sealed rooms are still.**
15. **Soft everywhere**: no rectangles cut from the field, no grid steps, no snaps in time.

## 4. Claims

Wind toward +x. U = the dial's wind at 1.5 m over open ground (the dial keeps its meaning: what a person, a fire or a
bush feels in the open). H = the obstacle's height. "Ground" = the 1-2 m layer (what effects read).

### A. The open field and height

| ID | Claim | Source | Result |
|---|---|---|---|
| AIR-A1 | Open ground (1-2 m layer, 60-s mean) = the dial within ±10%. | MSA (the dial's meaning), `claims/wind.md` WD-A1 | |
| AIR-A2 | Speed grows with height like the log law over grass (z0 ≈ 0.03-0.1 m): 5 m ≈ 1.15-1.35 U, 10 m ≈ 1.3-1.6 U, 17 m ≈ 1.4-1.8 U. | Physics (EN 1991-1-4 §4.3.2 log profile) | |
| AIR-A3 | No vertical motion over open ground: \|w\| < 0.05 U. | Physics | |

### B. A lone house (12 x 12 m, H = 6 m)

| ID | Claim | Source | Result |
|---|---|---|---|
| AIR-B1 | Windward face: air rises up the face (w > 0.1 U at 2-5 m, 1-2 m in front of the wall) and slows toward it (ground ≤ 0.6 U within 1.5 m). | Physics (stagnation; Hunt et al. 1978) | |
| AIR-B2 | Over the roof: the air just above the roof (6-10 m) runs 1.0-1.5 U; air goes OVER, not just round. | Physics (roof speed-up), her brief | |
| AIR-B3 | Lee: the near-ground air 1-2 H behind the house is ≤ 0.35 U and its along-wind part ≤ 0.1 U (stalled or reversed). | Physics (recirculation bubble 1-2.5 H for a cube) | |
| AIR-B4 | Lee recovery: ground speed rises with distance and is ≥ 0.75 U by 8-10 H. | Physics (wake recovery 5-10 H) | |
| AIR-B5 | Lee downwash: w < 0 somewhere 1-3 H behind the house at roof height. | Physics | |
| AIR-B6 | Corner streams: ground speed at the windward corners/flanks 1.1-1.5 U. | Physics (Penwarden & Wise 1975) | |
| AIR-B7 | Height matters: the lee behind a 15 m tower stays below 0.6 U at least 2x farther than behind a 3 m shed. | Physics (wake length scales with H) | |

### C. Gaps, streets, funnels

| ID | Claim | Source | Result |
|---|---|---|---|
| AIR-C1 | A narrowing gap (funnel) between two buildings along the wind: throat ground speed 1.1-1.5 U (wind-blocking keeps it below a Venturi's area ratio). | Blocken, Moonen, Stathopoulos & Carmeliet 2008 (J. Wind Eng. Ind. Aerodyn. 96) | |
| AIR-C2 | A street along the wind: 0.9-1.3 U. A street across the wind (W ≈ H): ≤ 0.35 U, near-ground flow reversed or stalled. | Physics (Oke 1988 skimming flow) | |

### D. Doors and rooms

| ID | Claim | Source | Result |
|---|---|---|---|
| AIR-D1 | Windward door into a dead-end room: the room's mean ground speed is 0.03-0.25 U; 1 m inside the door 0.15-0.5 U; the back of the room ≤ 0.12 U. | Physics (single-sided ventilation), `claims/wind.md` WD-F3 | |
| AIR-D2 | That room's air LOOPS: somewhere in it the ground air points back toward the door (along-wind component < -0.03 U), i.e. it is not a straight jet with the outdoor heading. | Physics (mass conservation: in = out through one door) | |
| AIR-D3 | That room is TURBULENT near the door: sqrt(k) near the door ≥ 2x sqrt(k) at the back, and ≥ the room's mean speed. | Physics, her brief ("turbulent draft") | |
| AIR-D4 | Cross-ventilated room (windward + lee door): ground speed on the line between the doors 0.25-0.7 U, along the wind. | Physics (orifice flow, Cd 0.6, ΔCp ≈ 1) | |
| AIR-D5 | Lee-door room: mean ground speed ≤ 0.15 U. | Physics | |
| AIR-D6 | Sealed room: ≤ 0.02 U everywhere inside. | Physics, MSA | |
| AIR-D7 | A second room behind an inner door gets less than the first (≤ 0.6x its mean). | Physics, `claims/wind.md` WD-F4 | |

### E. Roofs without walls, tunnels, walls without roofs

| ID | Claim | Source | Result |
|---|---|---|---|
| AIR-E1 | Tunnel / arcade along the wind (walled sides, roof, both ends open): 0.3-0.8 U inside, below the open field. | Physics (entry loss + friction; the over-the-top path) | |
| AIR-E2 | Pavilion (roof on posts, no walls): 0.5-1.05 U underneath. | Physics | |
| AIR-E3 | Walled courtyard (open sky): centre 0.1-0.4 U, turbulence ≥ the open field's. | Physics, `claims/wind.md` WD-E6 | |
| AIR-E4 | A 2 m garden wall: ≤ 0.5 U on the ground 1-4 m behind it, ≥ 0.75 U by ~25 m. | Physics (2-D fence wake) | |

### F. Time, softness, cost

| ID | Claim | Source | Result |
|---|---|---|---|
| AIR-F1 | A gust front crossing the open field reaches the lee later and weaker; the windward-door draft surges with it (its sqrt(k) or speed rises within ~3 s of the front). | Physics, her brief | |
| AIR-F2 | No cell-to-cell jump > 30% of U in the open ground layer; no step in the field from one step to the next > 10% of U in the open. | Author (soft, no snaps) | |
| AIR-F3 | Paused world: the air holds exactly. | Author 2026-11-08 (one clock) | |
| AIR-F4 | A step on the Lab · Air grid costs ≤ 15 ms on one CPU core (Node, her PC), so 10 steps a second take ≤ 15% of a core; zero extra GPU passes beyond one small upload + the existing bake. | MSA (no hitches; her GPU is the busy part) | |

### G. Effects inherit it (first round: through the baked ground field)

| ID | Claim | Source | Result |
|---|---|---|---|
| AIR-G1 | A fire in the dead-end windward room no longer leans along the outdoor wind: its mean lean ≤ ⅓ of an open-field fire's, and it flickers/turns with the room's churn. | Her brief | |
| AIR-G2 | A fire 1-2 H behind a house leans weakly, and sometimes back toward the house. | Physics | |
| AIR-G3 | A fire in the cross-ventilated room leans along the draught. | Physics | |

## 5. Results, first round (2026-11-09)

Offline: `node tools/lab/air-bench.mjs --mps 10.5` (steady and `--gust 1`, `--dt 0.4`). Live: rig E, Lab · Air, dial 10.5 m/s,
the baked field read at each fire (`MapShine.readWindField`), air on vs today's analytic wind. Unit tests: `src/world/__tests__/air.test.mjs`.

| Claim | Result |
|---|---|
| A1 dial at 1.5 m | **Held**: empty field 1.000 U. Probes 1-2 H upwind of a building read 0.77 (upstream blockage: real, the claim's probes were too close). |
| A2 log law | **Held**: 10 m 1.55 U (want 1.55). |
| B1 windward face | **Wrong claim, model right**: below ~0.6 H the face flow goes DOWN into the base vortex (w −0.30 U at 1.5 m), above it climbs (w up to 0.48 U). |
| B2 over the roof | **Held**: 1.39 U at 7 m. |
| B3 lee stalled/reversed | **Held**: −0.31 U along 1.5 m behind, −0.24 at 3 m. |
| B4 recovery | **Held**: 0.87 U at 24 m (4 H), 0.99 at 72 m. |
| B6 corners | **Held**: 1.08 U at the windward corner. |
| B7 height matters | **Held**: tower 0.55 U at 12 m behind, shed 0.95 U. |
| C1 funnel | **Held**: throat 1.08-1.14 U (open ground in that lane 0.93): ×1.2. |
| C2 streets | **Held**: across-wind street rotor, ground reversed (−0.21 U), up/down at the walls ±0.36 U. |
| D1 windward-door room | **Held** after the doorway exchange: 0.17 U 1 m in, 0.00 at the back. Without it: 0.01 (one opening cannot carry net flow). |
| D3 churn by the door | **Held**: σ 0.30 U by the door, 0.03 at the back. |
| D4 cross-ventilation | **Held**: 0.26-0.32 U mid-room. Manor corridor front→back door: 0.30 U along 45 m. |
| D5 lee door / D6 sealed / D7 deeper rooms | **Held**: 0.04-0.06 U; still (exactly 0 at draftiness 0); 0.00-0.01 U. |
| E1 tunnel / E2 pavilion / E3 courtyard / E4 garden wall | **Held**: 0.44 U; 0.53 U; rotor −0.24 U, σ 0.48 U; 0.27 U 1.5 m behind, 0.91 U at 30 m. |
| F4 cost | **Not yet**: lab (113k cells) 145 ms/0.1 s step in Node, ~180-220 ms in the rig's worker; real maps are 2-4× smaller. Follow-up bead (GPU or multigrid). |
| G1-G3 effects inherit | **Held for the field every effect reads**: fire in the windward-door room 5.2 m/s straight downwind today → 0.3 m/s, no lean; lee-door room 6.1 → 0.3; courtyard 8.0 downwind → 3.2 reversed; tunnel 9.8 → 2.3; behind the house 9.8 → 3.5. Flames themselves not yet judged on screen. |
| Draftiness (her 2nd brief) | Shut doors leak through their own height, panes through the bottom 3 m, by the draftiness value; a crack carries its flow, never a gale (≤ 0.07 U at full draftiness). Churn behind leaky windward glass 0.02 → 0.05 → 0.07 U at 0 / 0.35 / 1. |
