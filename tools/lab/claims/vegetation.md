# Claims: vegetation (MSA Lab family, mmp-78u.33)

Written 2026-11-09. Expectations come first; the **Result** column is filled only by a measurement (lab scene
`Lab · Vegetation`, rig D, `tools/lab/veg-sway.mjs`). The plants are crops of the author's own Lone Hill art
(her wish, 2026-11-09), so sizes, alpha edges and painted shading are hers.

**Sources**, most trusted first:
- `Author`: rants (by date). Her live-tuned defaults win over physics: see the "STAR: RETUNED LIVE" header in
  `src/effects/vegetation.js` and the 2026-10-31 "new default" comments.
- `MSA`: param help text and code headers, which count as promises.
- `Physics`: cited below.
- `Memory`: an earlier measured finding.

Physics gives the baseline. Beauty wins a tie ("real numbers make a good baseline, then tune for looks").

## Units and real numbers

- **Scale:** her maps use 150 px per 5-ft square, so 98.4 px/m and 30 px/ft. The wind dial is linear: v = 70 · speed01 m/s
  (`world/wind-scale.js:74`). Beaufort: v = 0.836 · B^1.5 m/s. Speeds used here:
  - B2 2.1 m/s (dial .03)
  - B3 4.3 m/s (.062)
  - B5 9.3 m/s (.133)
  - B7 15.5 m/s (.221)
  - B8 18.9 m/s (.27)
  - B10 26.6 m/s (.38)
  - B12 35 m/s (.50)

  Trees read Beaufort/12, saturating at 34.8 m/s (`wind-field.js:152-156`).
- **Her plants**, measured from 15 tree and 16 bush layers:
  - Tree canopies have a median diameter of 540-600 px (5.5-6 m); bushes 120-230 px (1.2-2.3 m).
  - Alpha edges are hard (1-5% soft pixels), except Japanese Horror House, Wizard's Lair and Docklands bushes (30-43%).
- **Natural sway frequency:**
  - Moore & Maguire 2004 (Trees 18:195-203; 602 trees, 8 species): f is linear in DBH/H², so it is lower for
    taller, more slender trees. Typical whole-tree values are 0.2-1 Hz; branches 1-3 Hz; leaf flutter 3-10 Hz.
  - Damping: the internal damping ratio is usually < 0.05. Moore & Maguire 2005 (Trees 19:363-373) found
    unpruned trees at 0.08 to near-critical (the crown's aerodynamic drag).
  - So a real tree, once pushed, rings for 1-3 visible cycles. A bush barely rings.
- **Crown displacement:**
  - Scots pines 9.5 / 13.5 m tall bent their crown centre < 2 / < 5 cm at 4-8 m/s (Forest Systems, Dec 2015).
  - Static bending grows roughly with U², so about 10x that by B8 (20-50 cm).
  - Beaufort's own words: B3 leaves and twigs in constant motion; B5 small trees sway; B7 whole trees in motion;
    B8 twigs break off.
- **Falling leaves:**
  - They flutter (side-to-side) or tumble (spin), at Re ≈ 10³ (Andersen, Pesavento & Wang 2005, JFM).
  - Descent is on the order of 1-2 m/s for broad leaves (the brief's figure; a rigid-plate proxy gives about 0.1-0.3 m/s,
    so leaves sit between).
  - Gusts last seconds.
- **View:** the maps are seen from straight above, so sway shows as horizontal canopy displacement. There is no
  visible bending of the trunk.

## The model in numbers (master 0ebd1187, defaults)

- **Sway:**
  - disp = (bend + osc) · swayAmount 13 · windResponse 0.5 · kindMul (tree 1.3, bush 0.8) · edgeFade
    (`vt-pan-viewer.js` sway node).
  - osc = dir · |lean|^0.6 · ampJitter · sin 2π(C + phase·f).
  - bend = dir · |lean| · galeness² · galeBend 0.25.
  - One sinusoid for the whole scene: f = 0.33 · (1 + 0.45 · galeness) Hz for trees, ×3.5 for bushes. Plants differ only by
    a clump-hash phase (cells 750 px for trees, 500 px for bushes).
  - The spring model only runs at tier 6 ("extreme").
- **Tree shadows** (`shadow-access.js` forCaster):
  - Height 25 ft = 750 px (bush 2 ft = 60 px). Noon at lab latitude 30: L ≈ 214 px (bush 17 px), D = 0.565.
  - Not affected by Regions (they draw after the region overlay). No lamp casts one.

## Claims

| id | claim (wide band) | source | how measured | result |
|---|---|---|---|---|
| VEG-01 | Calm (0 m/s): no plant is displaced (RMS < 0.2 px); only the leaf shimmer moves | Physics, MSA | ladder, A/B/C rows | **pass**: RMS 0.0 px; flutter 0.43-0.52 (shimmer) |
| VEG-02 | B2-B3 (2-4 m/s): trees sway 0.3-5 px RMS (real crown 1-5 cm = 1-5 px) | Physics | ladder | **pass**: 0.6-2.0 px |
| VEG-03 | Sway grows monotonically with wind, from B2 to B12, for every plant | Physics, MSA help | ladder | **pass** (trees 0.6-1.1 -> 2.9-4.2 px) |
| VEG-04 | B7-B8 (15-19 m/s), "whole trees in motion": tree sway visibly larger than at B3, at least 2x | Physics (Beaufort) | ladder | **pass**: about 2x (1.5-2.9 vs 0.6-2.0 px) |
| VEG-05 | B8+: tree p2p sway >= 1% of canopy diameter (5 px for a 500 px tree), so it reads at play zoom | Physics (20-50 cm), Author ("a gale should visibly lay a canopy over", 2026-08-01) | ladder | measured: p2p ~4-14 px; borderline. **Taste call** (her 10-31 defaults) |
| VEG-06 | A gale holds a downwind lean (mean shift >= 0.5x the RMS sway) | Physics, MSA help ("Gale lean") | ladder, mean vs calm | **low**: about 3 px lean vs 3-4 px RMS at 35 m/s; ~0 below 19 m/s. By her default galeBend 0.25 (was 4) |
| VEG-07 | Trees sway at 0.2-1 Hz; bushes at 1-3 Hz | Physics | ladder, DFT | **pass**: trees 0.32-0.50, bushes 1.1-1.6 |
| VEG-08 | A larger tree sways slower than a smaller one (f falls with size) | Physics (DBH/H²) | ladder, A1..A6 | **fail**: one frequency for every size (by construction) |
| VEG-09 | After a gust passes, a tree rings down over 1-3 cycles (damping 0.05-0.3), then settles | Physics | gust run (MapShine.gustWind), envelope after the gust | pending |
| VEG-10 | No two plants move in lockstep: clone stamps 1050 px apart correlate < 0.7 | Author ("no clones, no lockstep") | ladder, B1-B5 corr | **pass**: max pair 0.57; mean 0.26 -> -0.08 |
| VEG-11 | Neighbouring trees in a dense grove (her forest density) are not in lockstep: displacement correlation between crowns < 0.7 at 1 crown spacing | Author | Deep Forest, 11 canopy cores, block-matching tracker (scratchpad vg/grovetrack.js) | **pass**: < 450 px apart mean 0.30 (max 0.66 @ 9.3 m/s, 0.73 @ 18.9), no pair > 0.9; but every tree at 0.4 Hz (same tempo, only phase differs) |
| VEG-12 | Gust fronts cross a grove as travelling waves: correlation peaks at lag ≈ distance / U downwind | Physics, MSA (fronts carried at U) | grove plot | pending |
| VEG-13 | Mirrored / turned stamps (B6) behave like any other tree (no sign error from flip/rot) | MSA | ladder | **pass** (B6 in the same band as B1-B5) |
| VEG-14 | Every plant moves as one body: no tearing, folding or blobs at B12 | Author (2026-11-01), Memory (74b2099e) | frames + fold meter | pending |
| VEG-15 | Plants never cross a wall or into black _Outdoors (D1 tree overlapping the house roof) | Author (2026-11-01) | D1, max displacement into the roof | pending |
| VEG-16 | Plants never tear away from the scene edge; the edge fade calms them near it | Author (2026-11-02) | edge plot | pending |
| VEG-17 | Bush flutter (shimmer + sub-pixel warp) rises with wind and stays below the art's line weight (< 2 px) | Author (no "liquified"), MSA (VEG_FLUTTER caps) | ladder flutter, frames | measured flutter rises 0.5 -> 13 (C3 rosette); look check pending |
| VEG-18 | Noon tree shadow: dark core D 0.45-0.6 at its base, length 150-300 px north, soft sides | MSA (forCaster), Author (2026-11-01 soft sides) | probe along north line | pending |
| VEG-19 | Tree shadows move with the canopy in wind (in sync with the canopy's displacement) | Author (2026-11-01 "two shadows out of sync") | shadow-edge vs canopy centroid | pending |
| VEG-20 | Inside a darkness Region, tree shadows follow the same rule as building shadows | Author (one shadow rule) | D2 in vs ref | **fail** (mmp-78u.18, confirmed on rig D: tree shadow kept, block shadow gone) |
| VEG-21 | A lamp lights the canopies within its reach; plants near a lamp read warmer at night | MSA (canopy-light), Physics | D3 at 22:00 | pending |
| VEG-22 | Lamps cast plant shadows (or decision: they deliberately don't) | Physics, MSA (no lamp shadow by design) | D3 | known: no lamp shadow. Decision pending |
| VEG-23 | Golden hour: canopies take the warm tint like the ground; shadows lengthen to 1000+ px | Author (all effects take the hour's colour) | 17:45 shots | pending |
| VEG-24 | Night: canopies are dark but not black; moonlit cool | Author (cool moonlit nights; no near-black) | 23:00 probe | pending |
| VEG-25 | No bush layer renders pitch black (JHH) | Author, bug mmp-xz5 | JHH on rig D | **pass** on master dd3b1696 (bushes in colour); mmp-xz5 closed |
| VEG-26 | Leaf shed starts near B7-B8 (15-19 m/s) and not below 11 m/s | Physics (B8 twigs break), MSA (startsAboveMps 15) | gale run, count births | pending |
| VEG-27 | Falling leaves descend at 1-5 m/s (MSA ~4.5 at defaults), flutter side to side, tumble | Physics, MSA | getLeafShedStatus / frames | pending |
| VEG-28 | Leaves land, rest, fade out within ~20 s; nothing piles up forever; cost bounded | MSA (groundSec 20, caps) | long gale run | pending |
| VEG-29 | First gale costs no shader-compile hitch (compile at load) | Author (no hitches), bug mmp-235 | frame times at first births | pending |
| VEG-30 | Leaf/twig shadows are soft blobs, not rectangles with dark edges | Author, bug mmp-y9q | gale frames | **fail -> fixed** 75c9a7f0 (blur cut by its quad) |
| VEG-31 | In a storm no leaf vanishes in one frame (the slot ring never laps a visible leaf) | Author (no snaps) | getLeafShedStatus birthRate + rewriteAgeSec | **fail -> fixed** dd3b1696 (Deep Forest 313 births/s, rewrite at 6.5 s) |
| VEG-32 | In wind the canopy outline never uncovers the ground-shadow cut-out under it (no bright or dark line round a plant) | Author (2026-11-09 report) | holeshot.js pair + sliver.py | **fail -> fixed** 64198c67: 0.34-0.54% -> 0.04-0.27% of the outline band |
| VEG-33 | On a cold first visit, canopies appear as soon as their art is ready, with the camera still | Author (never fail silently) | cache purge + cold reload + leaf-shed canopy count | **fail -> fixed** b1085763 (once 6+ min missing; with fix ready at 134 s) |
