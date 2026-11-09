# Claims: wind (MSA Lab family, mmp-vm1.1)

Written 2026-11-09, before any measurement. Expectations come first; the **Result** column is filled only by a
measurement on rig E (`Lab · Wind`, `tools/lab/wind-meter.mjs`, `MapShine.readWindField`). Each claim names its
source and how it is measured. Wide ranges on purpose: a claim that fails is a lead, not a verdict, until triaged as
**MSA bug**, **wrong claim** or **taste call** (decision bead).

**Sources**, most trusted first:
- `Author`: her rants, by date (`~/.claude/rants/Mythica Machina Press.md`, `map-shine-advanced.md`). Her live-tuned
  values win over physics.
- `MSA`: code headers, constants and param help (they are promises).
- `Physics`: cited in the next section.

Physics gives the baseline; beauty wins a tie ("real numbers make a good baseline, then tune for looks").

## Units and real numbers

- **Scale.** Her maps: 150 px per 5-ft square = 98.43 px/m. The lab scene uses the same. Dial: `v = 70 · speed01` m/s
  (`world/wind-scale.js:74`). Field vectors are in dial units: m/s = ×70, world px/s = ×70 × px/m
  (`world/wind-field.js:129`). At 98.43 px/m one dial unit is 6890 px/s.
- **Beaufort** (WMO): `v = 0.836 · B^1.5` m/s. B3 gentle breeze 3.4-5.4 m/s (dial .05-.08), B5 fresh 8.0-10.7 (.11-.15),
  B7 near gale 13.9-17.1 (.20-.24), B8 gale 17.2-20.7 (.25-.30), B10 storm 24.5-28.4 (.35-.41), B12 hurricane ≥ 32.7
  (≥ .47). Land criteria: B3 "leaves and small twigs in constant motion", B5 "small trees in leaf begin to sway",
  B7 "whole trees in motion", B8 "twigs break off trees".
- **Gust factor** G = peak 3-s gust / 10-min mean (WMO 3-s gust definition; Harper, Kepert & Ginger 2010, WMO/TD-1555):
  ≈ 1.3-1.4 over open water/flat open land, ≈ 1.4-1.6 over open country with obstacles, ≈ 1.6-2.0 among buildings.
  Durst (1960): 3-s gust / hourly mean ≈ 1.5 in open country.
- **Turbulence intensity** `I = σu / U`. EN 1991-1-4 §4.4: `I = 1 / ln(z/z0)`. At z = 2 m (a person, a bush, a
  candle on a table): open grass z0 = 0.03 m → 0.24; scattered obstacles z0 = 0.1 → 0.33; suburban z0 = 0.3 → 0.53.
  At 10 m: 0.17 / 0.22 / 0.29. Lateral σv ≈ 0.75 σu (neutral surface layer).
- **Direction scatter.** `σθ ≈ σv / U ≈ 0.75 · I` rad: about 8-15° at moderate wind near the ground; much larger in
  light wind (σθ 20-60° below ~2 m/s, meandering). Over minutes to hours the mean direction veers and backs by tens
  of degrees.
- **Length and time scales.** Integral length scale of u (EN 1991-1-4 Annex B: `L = 300 (z/200)^α`,
  `α = 0.67 + 0.05 ln z0`): about 25-65 m between 2 and 10 m height. Lateral scale ≈ ⅓ of that, so gust patches are
  ~3× longer along the wind than across it. Integral time scale `T = L / U`: 2.5-6.5 s at 10 m/s. Kaimal spectrum: the
  u-energy peaks near `f·z/U ≈ 0.05` (10 m, 10 m/s → ~0.05 Hz, a 20 s rhythm) and falls as `f^(-5/3)` above it.
- **Taylor's hypothesis.** Gust patterns ride downwind at about the mean speed (0.8-1.0 U near the ground).
- **Buildings** (Penwarden & Wise 1975, BRE; Blocken & Stathopoulos reviews; Hunt et al. 1978):
  - upwind face: flow slows into a stagnation zone, a horseshoe vortex at the base;
  - corners and flanks: 1.2-1.5× free stream at pedestrian height (up to ~2× at tall-building corners);
  - lee: a recirculation bubble ~1-3 H long (H = building height; a two-storey house H ≈ 6-8 m → 6-24 m), mean
    speed 0.1-0.4 U with REVERSED near-ground flow, strong turbulence; the wake recovers to ~90% over ~5-10 H;
  - gaps between buildings (passage effect): up to 1.3-2× when the gap is narrow; streets along the wind channel
    (≈ 1.0-1.3×), streets across the wind are sheltered (skimming flow, ~0.1-0.3 U, reversed vortex at the bottom).
- **Courtyards** (closed on four sides, open above, W/H ≈ 1-4): one recirculating vortex, centre mean speed
  ≈ 0.1-0.35 of free stream at 2 m, gusty, direction confused.
- **Indoors.** Sealed room: 0.05-0.2 m/s (convection, drafts): still air for anything we draw. Through an open
  windward door: a jet of ~0.3-0.6 U at the opening that spreads and decays over a few metres; single-sided openings
  ~0.05-0.2 U. Closed glass lets no wind through.
- **Candles** gutter from ~1-2 m/s and blow out at ~3-5 m/s (draught); real outdoor flames lean visibly from ~1 m/s.

## The model in numbers (master 1e0218f7)

- **Source.** One scene dial: direction (deg, the way the wind blows TOWARD; 90 = toward +x) and speed01, plus
  gustiness (debug select, default 1) and the scene's px/m. Nothing changes them except the GM (and Fade Engine
  fades). No weather mood sets wind; the direction never wanders.
- **Field** (`world/wind-field.js#sampleWind`), per world point and sim time:
  `coherent = flow · speed01 · gust(x,t)`, deflected off walls (≤ 1.35× speed), × openness × (1 − 0.85 · shadow);
  `+ turbulence` = 4-octave curl fBm (32 → 4 m eddies, gain 2^(-1/3)), Taylor-advected by ∫U dt, size
  `I · U · gust` with I = 0.02 sealed → 0.75 at a doorway shear → 0.16-0.30 outdoors × (1 + 1.2 · gale), gale
  ramping to 1 at 33 m/s; `+ liveField` (Tier-2 door gusts, only while thawed).
- **Gust envelope** (`computeGustEnvelope`): two Perlin octaves sliding at U, thresholded:
  lull 0.7, crest 1.75, ±0.18 ripple, bounded [0.4, 2.2]; threshold falls from z = 0.9 (calm) to −0.35 (33 m/s);
  along-wind gust length `U · 2.5 s` clamped to 9-60 m; across-wind length 2.5× the along-wind one (broad fronts).
- **Bake** (`vt-pan-viewer.js#tickWindFieldBake`): the field is drawn every frame into a grid-sized RG half-float
  target, ~one cell per grid square (64-256 cells on the long axis), plus a `groundLagSec` slice and a 0.6 s gust
  history atlas. Openness (doors, ~120 cells × reach scale 0.12 → 3 → 4 with speed) and the wind shadow (24 cells
  upwind march) are baked on the CPU when walls, doors, floor, direction or speed change.

## A. The dial means what it says

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-A1 | At an open point the 60-s **mean speed** equals the dial within ±10% (dial 0.05, 0.15, 0.30, 0.50). | Physics (the dial is a 10-min mean), MSA "one real speed" | probe series, mean \|field\| × 70 | |
| WD-A2 | The mean **direction** at an open point is the dial's within ±5°. | MSA | probe, circular mean | |
| WD-A3 | Dial 0 → the field is exactly 0 everywhere (indoors too). | MSA #498, Author 2026-07-23 | probe full grid | |
| WD-A4 | Speeds convert at 98.43 px/m on her 150-px grid (`uWindPixelsPerMetre`). | MSA | read ambient | |

## B. Gusts in time

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-B1 | Gust factor (peak 3-s mean / 60-s mean) at an open point is 1.3-1.7 at B5-B8; ≤ 2.2 anywhere. | Physics (WMO), MSA crest 1.75 | probe series, 3-s running mean | |
| WD-B2 | σu / U at an open point is 0.15-0.35. | Physics (EN 1991-1-4 at 2 m), MSA I_open 0.16 | probe series | |
| WD-B3 | A gust (3-s mean above 1.2× the 60-s mean) lasts 1-10 s; a lull (below 0.8×) lasts 1-15 s. | Physics, MSA period 2.5 s | event durations | |
| WD-B4 | Gust rate rises with the dial: at B3 a gust every 10-40 s ("few and far between"); at B10+ several per 10 s ("a maelstrom"). | Author 2026-08-15 | event counts at 4 speeds | |
| WD-B5 | Gust crests differ: crest heights spread (CV ≥ 0.1) and gaps between gusts spread (CV ≥ 0.3); no two in a row alike. | Author ("distance between gusts is always the same", "amplitude identical") | event stats | |
| WD-B6 | The speed spectrum at a point is broadband: no single spectral line holds > 25% of the variance, slope near −5/3 above the peak. | Physics (Kaimal), MSA spectrum header | PSD of 60-120 s | |
| WD-B7 | The signal never repeats: the autocorrelation has no secondary peak > 0.5 beyond 5 s, and two 30-s windows a minute apart are uncorrelated (|r| < 0.3). | Author 2026-11-09 ("evolving"), Physics | autocorrelation | |
| WD-B8 | Gust fronts ride downwind at 0.7-1.1 U: the speed series at two points d apart along the wind correlate best at lag d / U. | Physics (Taylor), MSA 2026-10-27 | cross-correlation | |
| WD-B9 | Lulls are real at a breeze: the 3-s mean drops below 0.6 U at least once a minute at B3-B5. | Physics (light winds lull), MSA lull 0.7 | probe series | |

## C. Direction and turbulence

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-C1 | At an open point, σθ (1-s means over 60 s) is 5-20° at B5-B8 and larger at B2-B3. | Physics | probe series, circular std | |
| WD-C2 | The mean direction wanders over minutes (tens of degrees over 10 min). | Physics | dial history / probe 10 min | |
| WD-C3 | Outdoor turbulence grows with the dial: absolute σ at B10 ≥ 3× that at B3. | Author 2026-10-27 ("turbulence at higher wind"), MSA gale boost | probe | |
| WD-C4 | Near an open door, vectors swing widely, some pointing against the prevailing wind. | Author 2026-07-23, MSA shear peak 0.75 | grid snapshot, angle histogram | |

## D. Space

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-D1 | Along-wind correlation length of speed (r = 1/e) is 10-60 m at B5-B8. | Physics (L ≈ 25-65 m), MSA gust length 9-60 m | grid snapshots, spatial autocorr | |
| WD-D2 | Gust patches are elongated: along-wind correlation length ≥ 1.5× across-wind. | Physics (Lv ≈ Lu/3) | same | |
| WD-D3 | At any instant the open field holds both gusts and lulls (3-s speed CV across the open field ≥ 0.15) — "waves and sheets", never uniform. | Author 2026-10-27 | grid snapshot | |
| WD-D4 | The field is smooth: no cell-to-cell jump > 30% of U in the open (no grid steps). | Author (soft, no hard lines) | grid snapshot gradient | |

## E. Buildings, walls and gaps

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-E1 | Lee of a building (1-3 H behind it): mean speed 0.1-0.5 U. | Physics, MSA shadow 0.85 | probe | |
| WD-E2 | In the near lee the mean flow REVERSES or turns (component along the wind ≤ 0.1 U). | Physics (recirculation) | probe direction | |
| WD-E3 | The wake recovers with distance: speed rises monotonically from the lee wall to ≥ 0.8 U by ~5-10 H. | Physics | transect | |
| WD-E4 | Building flank / corner: 1.1-1.5× U. | Physics, MSA corner 1.35, Author 2026-10-27 ("AROUND buildings") | probe | |
| WD-E5 | Upwind face: speed drops toward the wall (≤ 0.6 U within 1 m); no wind passes through. | Physics, MSA deflect | transect | |
| WD-E6 | Walled courtyard (open sky, walls all round): centre mean 0.1-0.4 U, more turbulent than the field. | Physics | probe | |
| WD-E7 | Alley along the wind: 1.0-1.4× U. Alley across the wind: ≤ 0.4 U. | Physics | probe | |
| WD-E8 | Wind never crosses a solid wall: just behind any wall the coherent part drops to the lee value. | MSA (2026-07-23), Author | transect | |

## F. Indoors

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-F1 | Sealed room (walls, closed doors, closed windows, black `_Outdoors`): field ≤ 0.02 U (≤ 0.3 m/s at 15 m/s). | Physics, MSA openness 0, Author | probe | |
| WD-F2 | A closed window lets no wind in (same as F1 for a room whose only opening is glass). | Physics | probe | |
| WD-F3 | Room behind an OPEN windward door: ~0.3-0.6 U at the door, decaying to ≤ 0.3 U 3-5 m in. | Physics | transect | |
| WD-F4 | Deeper rooms beyond a second open door get less than the first room. | Physics | probe | |
| WD-F5 | Painted-black `_Outdoors` with no walls (mask-only "indoors") — wind? (MSA: geometry only, so full wind.) | MSA 2026-07-22 rethink | probe | |

## G. One wind: every effect at a point sees the same air

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-G1 | Effects that read the baked field (vegetation, leaves, candles, lights, ropes, water, lightning) and effects that read the kernel path (dust motes, critter motes, gust ribbons, trails, fire openness) agree at one point to ≤ 5% of U. | MSA wind-access parity, Author 2026-10-27 ("tie everything together") | code + readback | |
| WD-G2 | Rain and snow drift with the field's direction and gusts at their own position. | Author 2026-10-27 | code + MapShine.readPrecipParticles | |
| WD-G3 | Fire flames, embers and smoke lean with the LOCAL wind (gusts surge them, the lee shelters them). | Author 2026-10-27, Physics | code + capture | |
| WD-G4 | Flies and fireflies are carried by the local air (nothing indoors, sheltered in the lee). | Physics, Author ("effects respect indoors") | code | |
| WD-G5 | Window rain/snow on glass follow the real gusts (sheets sweep when a front passes the window). | Author 2026-10-27 (rain in waves) | code | |
| WD-G6 | Direction agrees: leaves, smoke, rain, clouds and the overlay all go the same way (within ±20° of the local field). | Author ("one wind") | code + shots | |
| WD-G7 | Clouds (aloft) ignore walls and shadows but move with the prevailing direction. | Physics, MSA cloud-field | code | |

## H. Time base

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-H1 | Pause freezes the field: two reads 2 s apart while paused are identical. | Author 2026-11-08 ("everything should pause") | readback | |
| WD-H2 | A wind fade (0 → 0.5 over 60 s) moves the field smoothly: no frame-to-frame jump > 10% of U in the open. | Author 2026-10-27 (fade strobing) | readback during fade | |
| WD-H3 | Field-reading effects and the field share the sim clock (no consumer on wall time). | MSA one clock (2026-11-08) | code | |

## I. Cost

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-I1 | The per-frame field bake + gust history costs ≤ 0.3 ms GPU on her card at 256² cells. | MSA ("noise-floor next to one frame") | timestamp query / A-B | |
| WD-I2 | A dial change never rebuilds a shader (pipeline count unchanged). | MSA (2026-10-07 invariant) | pipeline count before/after | |

## J. Her look

| ID | Claim | Source | How | Result |
|---|---|---|---|---|
| WD-J1 | At 50% (35 m/s) the overlay reads as a storm: most of the open field is in a gust at any moment, not "single waves alone in a sea of inactivity". | Author 2026-10-27 | grid snapshot: fraction above U | |
| WD-J2 | Energy a gust puts into an effect dissipates over seconds after it passes (no snap back). | Author 2026-11-06 (water) | consumer readback | |
| WD-J3 | Waves of wind are visible crossing the map at the wind's pace (fronts, sheets). | Author 2026-10-27 | overlay frames | |
