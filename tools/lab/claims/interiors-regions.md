# Claims: interiors and Regions (MSA Lab family 1)

Written 2026-11-09, BEFORE measuring (mmp-78u "expectations first"; Ingram 2026-11-08: "Build a wide set of
expectations and then compare what you find"). Nothing here has been run on the rig. Pure data.

**Sources**, most trusted first. `Foundry` = v14 source under `foundryvttsourcecode_v14/.../resources/app/`.
`MSA` = a module declaration (param help, header, guide page, mask catalog); help text is a promise. `Author` =
Ingram's rants (`~/.claude/rants/map-shine-advanced.md` and `Mythica Machina Press.md`), quoted by date.
`Physics` = plain physics or common sense. `Memory` = an earlier session's measured finding (auto-memory), used
only where it records a measurement. When two sources disagree the row says so; see "Conflicts" at the end.

**SUSPECT:** marks a claim that code reading says is already broken. The reason and the line are in the row.

## Metric and numbers used

Grey 128 floor: albedo linear 0.216, `OETF(albedo)` = 0.502. The composite is gamma-space:
`lit = EOTF(0.502 x illum)`, presented byte ~ `255 x 0.502 x illum` (Measure view drifts ~-2, as shipped ~-20).
`illum` is Foundry-space (sRGB-like) light, `buf:scene.illum`.

Foundry's ambient ladder (`client/config.mjs:641-642`, `client/canvas/groups/environment.mjs:218`):
daylight 0xEE = 0.933, darkness 0x30 = 0.188. Ambient at darkness `d`:
`A(d) = 0.933 (1 - d) + 0.188 (1 - r) d` where `r` is MSA's Night fader (the darkness-realism lever,
`vt-pan-viewer.js:11240-11253`, `environmental-light.js:98-122`). **Record `r` with every run**; all numbers
below assume `r = 0` unless stated.

| d | A(d), r=0 | lit | presented (MV) |
|---|---|---|---|
| 0 (noon) | 0.933 (measured 0.922/0.933/0.966 with the sky tint) | 0.186 | ~117 |
| 0.5 | 0.561 | 0.0645 | ~71 |
| 0.9 (author's interiors) | 0.263 (measured 0.264-0.285) | 0.0157 | ~33 |
| 1.0 | 0.188 | 0.0092 | ~24 |

Region modes (`client/data/region-behaviors/adjust-darkness-level.mjs:29-44`): OVERRIDE `d' = m`;
BRIGHTEN `d' = d (1 - m)`; DARKEN `d' = 1 - (1 - d)(1 - m)`. Overlaps: the MINIMUM adjusted value wins
(`client/canvas/layers/effects/illumination-effects.mjs:105-108`). MSA soft edge: Gaussian, sigma 7.5 px,
centred on the authored edge, coverage `c = Phi(x / 7.5)` with `x` px inside the region
(`src/effects/lighting/region-geometry.js:803-828`): c(-20)=0.004, c(-10)=0.09, c(0)=0.50, c(+10)=0.91,
c(+20)=0.996. MSA darkness by the clock: `d = max(1 - skyFactor01, savedSceneDarkness)`
(`src/world/environment.js:167-168`), skyFactor 1 down to elevation 0 and 0 at -18 deg
(`src/world/sun.js:120`); lab latitude 30 gives elevation `60 cos(2 pi (h-12)/24)`, so d = 0 at 18:00,
~0.5 at 18:35 (elev -9), 1 from ~19:10 to ~04:50.

Lamp ladder in a region (Foundry `environment.mjs:221-228`, MSA per light `point-light-pool.js:1402-1411`):
bright colour = mix(A(d'), 1.0, 1) = 1.0; dim colour = A(d') + 0.25 (1 - A(d')). Lab LAMP: bright 4 ft = 120 px,
dim 12 ft = 360 px (30 px/ft).

## Plots needed

Author conventions copied: interiors are black `_Outdoors` with hard 0-1 px edges plus an "indoor" Region
(Adjust Darkness Level, OVERRIDE 0.9, plus Suppress Weather) covering the black area; basements all black with a
whole-floor Region and no listed visible levels (`lab-spec.mjs:110-127`, `:357-363`). Grid 150 px.

| Plot | Layout (squares, inside a 10x10 cell, 8x8 test area) | Masks / documents | Regions / lights | Sweep |
|---|---|---|---|---|
| C3, C5, basement (exist) | as `lab-spec.mjs` | C3 room + U slab, C5 black half (no Region), basement black | C3 indoor Region, basement Region | noon, h=21 |
| R1 modes | 8x6 black band; six 2x2 regions in two rows of three, 0.6 sq of black-without-region between them; 1 sq white margin | `_Outdoors` black band, hard edge | a OVERRIDE 0.9, b OVERRIDE 0.5, c OVERRIDE 0.0, d BRIGHTEN 0.5, e DARKEN 0.5, f DARKEN 1.0; darkness behaviour only (no Suppress Weather) | h=12, 18:35, 21; r=0 and r=1 |
| R2 overlaps and seams | black area 8x8 | `_Outdoors` black | two overlapping 3x3 regions OVERRIDE 0.9 and 0.3 (1.5 sq overlap) created 0.3-first, and a twin pair created 0.9-first; one region of two 2x2 rectangles sharing an edge; two separate touching OVERRIDE 0.9 regions; a 3x3 region with a 1x1 hole shape; touching OVERRIDE 0.9 and 0.5; one region with two darkness behaviours (OVERRIDE 0.9 first, OVERRIDE 0.4 second); one region whose behaviour is disabled | noon |
| R3 outdoor regions | white area; three regions 2.5 wide x 3 tall in a row along the north half, each holding a 1x1 black block centred in its south third; one reference block in the south half, outside any region | `_Outdoors` white with the four blocks black | br BRIGHTEN 0.5, dk DARKEN 0.5, sw Suppress Weather only | noon, cloud 0.7, h=21 moon on, precip 1, a lightning strike |
| R4 level scoping | three 2x2 black blocks on Ground, under transparent Upper art | `_Outdoors` black blocks on Ground; Upper transparent there | A: OVERRIDE 0.5, levels [Ground], elevation null/null. B: OVERRIDE 0.5, levels [], elevation [0,20). C: none | view Ground, Upper, Basement |
| R5 lights in dark rooms | closed 6x6 room (normal walls) + a black band with a region over its east half and NO walls | `_Outdoors` black room and band | room OVERRIDE 0.9 + Suppress Weather; L1 LAMP at room centre-left; L2 LAMP with darkness {min 0.5, max 1} at centre-right; L3 LAMP on open ground outside; L4 LAMP 20 px west of the band's region edge (outside it) | noon, h=21 |
| D1 scene variants | copy of R1 a + one 2x2 black block on white | as R1 | scene environment darknessLevel 0 / 0.5 / 1; globalLight off, on (bright false, luminosity 0.5), on (bright true) | noon, h=21 |

Probe points (scene px, all must be on screen; probe v2 returns edge garbage off-screen, FRICTION #19):
`R1.a..f` region centres; `R1.gap` black without Region between a and b; `R1.open` white margin;
`R1.e-20, e-10, e0, e+10, e+20` across region a's west edge (negative = outside, on black).
`R2.ov`, `R2.ovB` overlap centres; `R2.only9`, `R2.only3`; `R2.seam` on the shared edge, `R2.seam+40`;
`R2.touch` on the edge between the two touching 0.9 regions; `R2.hole` hole centre; `R2.step0`, `R2.step-10`,
`R2.step+10` across the 0.9/0.5 boundary; `R2.dual`; `R2.off`; `R2.corner` the outer convex corner of the
seam region. `R3.k.open` (inside region k, >= 60 px from block and edge), `R3.k.north` (40 px north of the
block), `R3.k.south` (40 px south), k in br, dk, sw, ref. `R4.A`, `R4.B`, `R4.C` block centres.
`R5.L1b` (40 px from L1), `R5.L1d` (240 px from L1), `R5.L2` (40 px from L2), `R5.ref` (room floor >= 400 px
from lamps), `R5.L3b`, `R5.L3d`, `R5.L3ref`, `R5.L4in` (inside the band's region 100 px from L4),
`R5.L4ref` (inside it, 600 px from L4). `D1.open`, `D1.north` (40 px north of the block), `D1.room`.

Lab-design notes: (1) the basement Region is `levels: [Basement]`, so from Ground it is never "viewed"
(Foundry `board.mjs:1377-1382`); a variant with `levels: []` and elevation [-20,0) is needed for IR-58.
(2) R3 needs open ground north of each block inside the region (noon shadow 75 px north).

## Claims

| id | claim | source | probe check | conditions |
|---|---|---|---|---|
| IR-01 | OVERRIDE sets the darkness to the modifier at any hour. | Foundry `client/data/region-behaviors/adjust-darkness-level.mjs:29-34`; shader getter `client/canvas/rendering/shaders/region/adjust-darkness-level.mjs:42-50` | `R1.a foundry.darkness` = 0.90 +-0.01 at h=12, 18:35, 21. A reading of 0 means Foundry's darkness mesh never pre-rendered under MSA's suppression (`canvas-compositing.js:818`); then Foundry vision thinks the room is bright. | R1, all hours |
| IR-02 | BRIGHTEN is d(1-m). | Foundry same file `:35-38` | `R1.d foundry.darkness`: 0.00 at noon, 0.25 +-0.02 at 18:35, 0.50 +-0.02 at h=21 | R1 |
| IR-03 | DARKEN is 1-(1-d)(1-m). | Foundry same file `:40-43` | `R1.e foundry.darkness`: 0.50 at noon, 0.75 +-0.02 at 18:35, 1.00 at h=21; `R1.f` = 1.00 always | R1 |
| IR-04 | Fully inside a region (>= 30 px from its edge) MSA illum is exactly Foundry's baseline for the adjusted darkness: mix(daylight, darkness x (1-r), d'), grey. | Foundry `client/canvas/rendering/shaders/samplers/baseline-illumination.mjs:22-23`; MSA `src/effects/lighting/region-darkness.js:284-296` (overlay), `vt-pan-viewer.js:11240-11253` | `R1.a illum` = 0.263 +-0.02 (r=0), R=G=B within 0.01; `R1.b` 0.561 +-0.02; `R1.c` 0.933 +-0.02; `R1.f` 0.188 +-0.02 | R1 noon |
| IR-05 | An OVERRIDE interior ignores the clock: same illum at noon, dusk and midnight. | Foundry `:29-34` (constant); MSA `region-geometry.js:840-852` (a = m, b = 0) | `R1.a illum` at h=12, 18:35, 21 equal within 0.01 (r fixed) | R1 |
| IR-06 | DARKEN 0.5 tracks the clock (the bench Mansion convention). | Foundry `:40-43`; Memory `scene-environment.js` header (Mansion uses DARKEN 0.5) | `R1.e illum`: 0.561 +-0.02 noon, 0.375 +-0.03 at 18:35, 0.188 +-0.02 at h=21 | R1 |
| IR-07 | BRIGHTEN 0.5 lifts the night only. | Foundry `:35-38` | `R1.d illum`: 0.933 +-0.02 noon (= open ground), 0.561 +-0.02 at h=21 | R1 |
| IR-08 | OVERRIDE 0.0 is "full daylight here", even at midnight. | Foundry `:29-34`; MSA `region-geometry.js:635-646` (names the courtyard case) | `R1.c illum` = 0.933 +-0.02 at h=21, and `foundry.darkness` 0 | R1 h=21 |
| IR-09 | Even DARKEN 1.0 never goes black at r=0: Foundry floors darkness at its darkness colour. | Foundry `config.mjs:641`; MSA `environmental-light.js:98-111` | `R1.f illum` = 0.188 +-0.015 at noon; at r=1 it is 0.0 +-0.01 | R1 |
| IR-10 | Overlapping regions: the minimum (brightest) adjusted darkness wins. | Foundry `illumination-effects.mjs:105-108` and `client/canvas/groups/effects.mjs:390-397`; MSA `region-geometry.js:732-772` | `R2.ov foundry.darkness` 0.30 +-0.01; `R2.ov illum` 0.709 +-0.02; `R2.only9` 0.263, `R2.only3` 0.709 | R2 noon |
| IR-11 | Creation order does not matter. | Foundry sort by value, not order (`illumination-effects.mjs:107`); MSA `vt-pan-viewer.js:7223-7232` sorts by value | `R2.ovB illum` = `R2.ov illum` +-0.01 | R2 |
| IR-12 | Each overlapping region adjusts the SAME base darkness; they never chain. | Foundry (each mesh computes from `canvas.environment.darknessLevel`, shader `:44-48`); MSA `region-geometry.js:759-772` | add a temporary BRIGHTEN 0.5 overlapping R1.e (DARKEN 0.5) at h=21: overlap `foundry.darkness` = min(0.5, 1.0) = 0.50 +-0.02 | R1 variant, h=21 |
| IR-13 | Two shapes of one region that share an edge leave no bright seam. | Author 2026-11-04: "don't end up leaving bright areas between region shapes which are touching"; MSA `region-geometry.js:783-791` | `R2.seam illum` within 0.01 of `R2.seam+40` | R2 |
| IR-14 | Two separate regions of equal darkness that touch also leave no seam (the field is blurred after the union). | MSA `region-geometry.js:783-801` | `R2.touch illum` within 0.01 of either region's centre | R2 |
| IR-15 | A region's darkness fades in over ~30 px, half inside and half outside the authored edge. | Author 2026-11-04: "fade the darkness across something like 30px"; MSA `region-geometry.js:803-828` | normalise c = (I_out - I) / (I_out - I_in) from `R1.gap` and `R1.a`; at `e-20, e-10, e0, e+10, e+20`: c = 0.00, 0.09, 0.50, 0.91, 1.00, each +-0.07 | R1 noon |
| IR-16 | The fade width does not depend on the region's size (C3's 1200 px region vs the whole-floor basement region and the walls lab's scene-wide one). | MSA `region-geometry.js:943-982` (texel grows past 6144 px, sigma stays 7.5 px) | 10-90% width of the fade = 19 +-6 px on C3's west edge and on a walls-lab region edge | C3, Walls lab |
| IR-17 | A convex outer corner is rounded: coverage ~0.25 at the exact corner. Intended. | Author 2026-11-08: "I believe that's an intentional fade"; MSA soft field (Gaussian product) | `R2.corner` c = 0.25 +-0.08 | R2 |
| IR-18 | The step between two touching regions of different darkness is softened by the same fade, centred on the boundary. | MSA `region-geometry.js:788-791` | `R2.step0 illum` = mean of the two plateaus (0.263, 0.561) = 0.41 +-0.03; `step-10`/`step+10` at 9%/91% of the way | R2 |
| IR-19 | A hole shape removes the region inside it: the ambient fill shows untouched. | Foundry hole shapes (`common/data/data.mjs:124`, `:183`); MSA `region-darkness.js:203-207`, `region-geometry.js:430` | `R2.hole illum` = `R1.gap illum` +-0.02 (black-without-region value) and `foundry.darkness` = 0 at noon | R2 |
| IR-20 | Foundry's darkness fact is hard-edged while MSA's pixel is soft: within 15 px of an edge they legitimately disagree. Not a bug; the probe must not flag it. | Foundry `client/documents/region.mjs:228-230` (testPoint); MSA `region-geometry.js:803-828` | at `R1.e-10`: `foundry.darkness` 0 (outside) yet c ~0.09; at `R1.e+10`: `foundry.darkness` 0.9 yet c ~0.91 | R1 |
| IR-21 | A region only darkens the floors its elevation band overlaps; bands are half-open at the top. | Foundry shader depth gate `adjust-darkness-level.mjs (shader):55-62`; MSA `region-geometry.js:690-730`, `vt-pan-viewer.js:7165-7181` | view Upper: the C3 region (elev [0,20)) does not darken Upper art; view Basement: no ground region applies (`R4.C`-style points read the basement value 0.263) | C3, view Upper and Basement |
| IR-22 | A v14 region scoped to one Level (`levels: [Ground]`) is only active while that Level is viewed. | Foundry `client/canvas/board.mjs:1377-1382`, `client/documents/abstract/canvas-document.mjs:97-104` | view Basement: `R4.A illum` = 0.263 +-0.02 (basement Region only). SUSPECT: MSA never reads `region.levels`, only elevation (`src/foundry/scene-regions.js:99-120`, `vt-pan-viewer.js:7165-7181`); A's null/null elevation overlaps every band, so the min rule gives 0.561 | R4, view Basement |
| IR-23 | Seen from Upper through transparent art, ground pixels follow Foundry: A (levels [Ground]) is not viewed, B (levels [], elevation [0,20)) darkens the ground pixels by its depth test. | Foundry `board.mjs:1381`, shader depth test `(shader):86-89` | view Upper: `R4.A illum` = ground value without a region (as `R4.C`); `R4.B illum` = 0.561 +-0.03. SUSPECT: MSA gates per viewed floor, so it does the opposite (A applies, B does not) (`region-darkness.js:92-108`) | R4, view Upper |
| IR-24 | A region with no levels and no elevation applies on every floor. | Foundry `canvas-document.mjs:98` (empty levels = all); MSA `region-geometry.js:712-717` | temporary copy of A with levels [] : darkens its area on Ground, Upper and Basement views | R4 variant |
| IR-25 | A disabled darkness behaviour does nothing. | Foundry (behaviour events only when enabled); MSA `scene-regions.js:58` | `R2.off illum` = `R1.gap illum` +-0.02; `foundry.regions` lists no active darkness behaviour there | R2 |
| IR-26 | Two darkness behaviours on one region: Foundry makes a mesh for each, so the lower adjusted value (0.4) wins. | Foundry `adjust-darkness-level.mjs:65-90` (one mesh per behaviour) + min sort | `R2.dual foundry.darkness` 0.40; `illum` 0.635 +-0.02. SUSPECT: MSA reads only the FIRST active behaviour (`scene-regions.js:55-58`), giving 0.263 | R2 |
| IR-27 | Suppress Weather stops weather inside the region even where `_Outdoors` is white. | Foundry `client/data/region-behaviors/suppress-weather.mjs:31-36`; Physics (the author's interiors carry it for a reason) | precip 1, wind 0.3: std of `presented` over 30 frames at `R3.sw.open` <= std at a black interior control +1 byte, and well below `R3.ref.open`. SUSPECT: MSA's Suppress Weather is a documented stub (`scene-regions.js:13-20`, `:141`) | R3, precip 1 |
| IR-28 | Suppress Weather alone changes no light. | Foundry (no darkness mesh); MSA (behaviour not read) | `R3.sw.open illum` = `R3.ref.open illum` +-0.01 at noon | R3 |
| IR-29 | A black-`_Outdoors` area with no Region is NOT lit like open ground at noon. | Author 2026-11-08 (asked if a sealed room as bright as open ground is intended): "Obviously not."; MSA guide `guide/pages/mask-outdoors.md:11` ("the light inside them is kept apart from the daylight outside"); conflicts with Foundry parity (no mask concept) | `C5.indoorHard illum` <= 0.9 x `C5.open illum`; ideally near a region interior. SUSPECT, known mmp-78u.10: `environmental-light.js:769-774` leaves indoors at the untouched ambient | C5 noon |
| IR-30 | Indoors (black `_Outdoors`) never receives a sun shadow; a taller neighbour's shadow stops at the wall. | MSA `src/effects/lighting/layer-smear-render.js:284-289` (receiver gate) | at noon, points 20/60 px inside C5's black half next to its north edge read the same illum +-0.01 as its centre | C5 noon |
| IR-31 | Cloud shadows never darken an interior. | Author 2026-11-07: "Clouds shadows shouldn't block all light indoors during noon"; MSA `environmental-light.js:857-913` (cloud gate = outdoors x (1 - coverAbove)) | cloud 0.7 moving: `C5.indoorHard illum` and `C3.centre illum` vary <= 0.01 over 30 s while `C5.open` varies > 0.05 | cloud 0.7 |
| IR-32 | Interiors get no sky or golden-hour tint; outdoors does. | MSA `environmental-light.js:769-774` ("indoors keeps the untouched Foundry ambient") | golden hour (17:45): `C3.centre` R=G=B within 0.01; `C5.open` R/B > 1.1 | h=17.75 |
| IR-33 | Moonlight is added outdoors only. | MSA `environmental-light.js:983-987` | h=21 clear, moon on: `C5.indoorHard illum` = A(1) = 0.188 +-0.02 (r=0); `C5.open` > it by >= 0.08 (moon add ~0.13 luma) | h=21 |
| IR-34 | The author's interiors are brighter than unlit open ground at midnight under full cloud (OVERRIDE 0.9 is a constant 0.263, the night floor is 0.188). Foundry's rule, so expected; physics disagrees (see Conflicts). | Foundry `:29-34`; Physics | h=21, moon off: `C3.centre illum` 0.263 > `C5.open illum` ~0.188 | h=21, moonlight 0 (stands in for full overcast: the cloud field covers at most ~30% of the sky, so the moon still shows in its gaps) |
| IR-35 | A building inside an outdoor BRIGHTEN or DARKEN region still casts its sun shadow. | Physics; Author 2026-11-07 (regions as "implied darker regions", applied on top, real-light mode) | noon: `R3.br.north / R3.br.open` = 0.435 +-0.06 (same as `R3.ref.north / R3.ref.open`). SUSPECT: the region overlay replaces the whole illum value inside its footprint, sun visibility included (`vt-pan-viewer.js:7004`, `:11449-11457`; `region-darkness.js:284-296`), so the ratio reads 1.0 | R3 noon |
| IR-36 | Cloud shadows still cross the open ground inside an outdoor region. | Physics; MSA cloud doctrine `environmental-light.js:857-861` | cloud 0.7: `R3.dk.open illum` varies over 30 s like `R3.ref.open`. SUSPECT: same overwrite | R3 cloud 0.7 |
| IR-37 | Moonlight and the golden tint survive inside an outdoor region. | Physics; MSA `environmental-light.js:983-987` | h=21 moon on: `R3.br.open illum` - A(d'=0.5) >= 0.08. golden: `R3.br.open` R/B > 1.05. SUSPECT: same overwrite | R3 h=21, 17.75 |
| IR-38 | A storm flash lights the open ground inside an outdoor region. | MSA guide `learn-weather.md:28` ("the land lights up"); `environmental-light.js:988-997` | during a forced strike at h=21, `R3.dk.open illum` rises >= 0.2. SUSPECT: same overwrite | R3 strike |
| IR-39 | A scene saved at darkness 0.5 is never brighter than that at noon. | MSA guide `fix-too-dark.md:32-34`; `learn-light.md:23`; `world/environment.js:167-168` | D1 saved 0.5, noon: `D1.open foundry.darkness` 0.50 +-0.02, `illum` 0.561 +-0.03 | D1 |
| IR-40 | A scene saved at darkness 1 has no sun: no sun shadows at noon. | Physics; Memory parity-scene-darkness (open bead mmp-ynr.9 "sun effects on a dark-saved scene") | D1 saved 1, noon: `D1.north / D1.open` = 1.00 +-0.02. SUSPECT: the shadow atmosphere keys off sun elevation only (`src/effects/shadow-access.js:372-423`), so the ratio is ~0.435 | D1 noon |
| IR-41 | MSA publishes its own darkness to Foundry (client-local), so Foundry's darkness outdoors follows the clock. | MSA `src/foundry/scene-environment.js:256-311` (publish, step 1/64, 250 ms); Memory parity-scene-darkness | `C5.open foundry.darkness`: 0.00 at 12:00 and 18:00, 0.50 +-0.03 at 18:35, 1.00 at 19:15 and 21:00 | C5, hour sweep |
| IR-42 | Darkness is 0 at sunset and reaches 1 only when the sun is 18 deg down (blue hour exists). | Author 2026-07-23 via `src/world/sun.js:38-48` ("darkness to hit 1 at a point after dusk and before dawn"); `sun.js:120` | `C5.open` illum luma at 18:00 >= 0.85 (sky-tinted, and up to ~6% inside C5's own black half's long shadow); at 19:15 = A(1) +-0.02 with moon off | hour sweep |
| IR-43 | The Night fader pulls darkness toward black, and interiors follow it. | MSA `vt-pan-viewer.js:11240-11253`; guide `fix-too-dark.md:26-28` | r=1, h=21: `C5.open illum` (moon off) 0.00 +-0.01; `C3.centre` 0.093 +-0.02 (0.1 x 0.933) | r = 1 |
| IR-44 | Foundry's default scene Environment (dark luminosity -0.25) dims the art at night, x0.8 at darkness 1. | Foundry `common/documents/scene.mjs:133` (dark luminosity -0.25); MSA `src/effects/lighting/ambience-filter.js:10-11` | h=21, r=0, moon off: `C5.open presented` ~19 +-3 (128 x 0.8 x 48/255) not ~24 | h=21 MV |
| IR-45 | Inside a darkness Region the Environment dark filter applies by the region's darkness too (Foundry samples darkness per pixel). | Foundry `client/canvas/groups/environment.mjs:306-307` (darknessLevelTexture into the ambience filter) | noon: `C3.centre presented` ~28 +-3 (native) not ~34; Memory parity-scene-darkness measured native 28 vs MSA 27-34. SUSPECT: `ambience-filter.js:14-16` ("Darkness Regions do not yet shift the filter", mmp-ynr.11) | C3 noon MV |
| IR-46 | When the scene's Global Illumination is off and no system owns it, MSA publishes a GI window [0, min(0.25, darkest region floor - 1/64)], so outdoor tokens see by day and region interiors never qualify. | MSA `scene-environment.js:437`, `:482-500`; Author 2026-10-27: "Tokens ... always believe they are in a dark place even when they are outside at noon" | noon: `C5.open foundry.otherSources` contains a `globalLight` entry (probe v2.1; v2 listed it in `foundry.lights`); `foundry.darkness` there 0 (inside window), `C3.centre foundry.darkness` 0.9 (outside window). With PF2e owning GI the entry may be absent (`isGlobalLightSystemOwned`) | noon |
| IR-47 | A GM-enabled GI uses the GM's own window, unclamped. | MSA `scene-environment.js:487-489` | D1 GI on: the published window equals the scene's `environment.globalLight.darkness` | D1 GI on |
| IR-48 | GI's floor at night matches native Foundry's (native "barely lifts the ambient"). | Memory parity-scene-darkness (mmp-ynr.12 open: "GI floor is far too bright in MSA") | D1 GI on (bright false, luminosity 0.5), h=21, moon off: `D1.open illum` within 15% of native (foundry-parity-darkness.mjs). SUSPECT: MSA raises to the dim colour, 0.39 at r=0 (`environmental-light.js:207-214`) | D1 h=21 |
| IR-49 | Where a region's own darkness sits inside the GI window, GI still lifts it (Foundry feeds both from one per-pixel darkness). | Foundry `client/canvas/groups/effects.mjs:330-337`; MSA documents the gap `region-darkness.js:121-137` | D1 GI on (bright true) + temporary OVERRIDE 0.1 region, h=21: illum inside = max(region 0.858, GI bright floor) ~1.0. SUSPECT: MSA shows the region value (documented, undecided) | D1 variant |
| IR-50 | A lamp inside an OVERRIDE 0.9 room: bright core 1.0, dim zone 0.447 (the region-adjusted ladder). | Foundry `environment.mjs:221-228`; MSA `point-light-pool.js:1402-1411`, `:2312` | noon: `R5.L1b illum` 1.00 +-0.04; `R5.L1d illum` 0.447 +-0.08 (attenuation softens); `R5.ref` 0.263 +-0.02 | R5 noon |
| IR-51 | The same lamp on open ground at noon barely shows (MAX over 0.933). | Foundry ladder (dim = 0.95 at d=0); MSA `light-visibility.js:207-233` | `R5.L3b illum` 1.00 +-0.03; `R5.L3d` <= 0.96; `R5.L3ref` 0.933 +-0.03 | R5 noon |
| IR-52 | Lamps are never dimmed by a region beyond the ladder: a lamp's core in a dark room equals a lamp's core in open night. | MSA doctrine `environmental-light.js:589-605` (lights MAX on top) | `R5.L1b illum` at noon = `R5.L3b illum` at h=21, +-0.03 | R5 |
| IR-53 | A light's darkness activation range uses the SCENE darkness, not the region's: a "night only" lamp in a dark room stays off at noon. Foundry's rule; physics disagrees. | Foundry `client/canvas/placeables/light.mjs:158-160`; MSA `src/foundry/scene-lights.js:52-80` (re-checks against MSA's own darkness) | noon: `R5.L2 illum` = `R5.ref` +-0.02 and `foundry.lights` at `R5.L2` lists no lamp | R5 noon |
| IR-54 | That lamp turns on once MSA's own darkness passes 0.5 (Aesthetic clock), not Foundry's saved value. | MSA `scene-lights.js:52-80` | h=21: `R5.L2 illum` >= 0.95 | R5 h=21 |
| IR-55 | A lamp just outside a region (no wall between) lights the region's floor with the region's ladder, not daylight's. | Foundry per-pixel darkness (`base-light-source.mjs:239`, darknessLevelTexture) | noon: `R5.L4in illum` <= dim colour at d'=0.9 (0.447) +0.05. SUSPECT: MSA computes the ladder at the light's ORIGIN with hard containment (`point-light-pool.js:1409-1411`), so the lamp MAX-blends daylight's dim 0.95 into the dark region | R5 noon |
| IR-56 | The basement (black `_Outdoors`, whole-floor Region) is uniformly region-dark, sunless and untinted. | MSA `lab-spec.mjs:300-305`, `:376-381`; guide `mask-outdoors.md:31-33` | view Basement, noon and golden: 5 spread points `illum` 0.263 +-0.02, R=G=B within 0.01 | basement |
| IR-57 | No cloud shadow and no cloud top reaches an opaque floor's underground level. | Author 2026-10-28: "When underground ... I can see clouds across the whole map"; MSA `environmental-light.js:903-913` | view Basement, cloud 0.7: basement points vary <= 0.01 over 30 s | basement cloud 0.7 |
| IR-58 | Seen from Ground down the stairwell, the basement is dark only if its Region is active for that view. In Parity, with the lab's `levels: [Basement]` Region, Foundry does NOT darken it (not viewed); with a `levels: []`, elevation [-20,0) Region Foundry's depth test DOES. | Foundry `board.mjs:1381`, shader depth test; Physics says dark either way | variant `levels: []`: stairwell basement pixel `illum` 0.263 +-0.03 from the Ground view. SUSPECT for that variant: MSA's per-floor band gate cannot darken a lower floor seen through a hole (`region-darkness.js:92-108`) | stairwell, view Ground |
| IR-59 | The basement view never shows the ground floor drawn over it (it lists no visible levels). | Author 2026-11-08 + memory level-visibility; MSA `lab-spec.mjs:357-363`, guide `fix-wrong-floor.md:8-15` | view Basement: `floorIndex` at the C3 position = basement's index, `albedo` 128 | basement |
| IR-60 | Editing a region updates the picture promptly (the region field re-bakes on any change and never records a skipped draw as baked). | Memory region-darkness-soft-edge (bake-retry trap); MSA `region-geometry.js:1040` (hash) | set R1.b modifier 0.5 -> 0.2 by document update: `R1.b illum` reaches 0.784 +-0.02 within 2 s; revert | R1 |
| IR-61 | A region drawn partly off the scene affects nothing beyond its own edge's fade inside the scene. | MSA `region-geometry.js:930-962` (clipped to the canvas) | temporary region straddling the scene's north edge: points >= 20 px outside its in-scene edge unchanged +-0.01 | temporary |
| IR-62 | Every region interior and every no-region point read the floor art unchanged: regions change light, never albedo. | MSA `environmental-light.js:16-41` (illum multiplies albedo) | `albedo` 128 +-1 at `R1.a..f`, `R2.*`, `R3.*` | all |

## Conflicts between sources

1. **Black `_Outdoors` without a Region (IR-29).** Foundry has no mask, so parity says the room is lit like the
   street; the author says "Obviously not". The author's own maps solve it with Regions, so the rule that
   matters for her maps already holds; the no-Region case is MSA-only behaviour where her ruling wins.
2. **OVERRIDE interiors at night (IR-34).** Foundry's OVERRIDE is a constant, so the author's standard 0.9 room
   is brighter than unlit, cloud-covered open ground at midnight. Parity is the default mode (Author 2026-11-07:
   "new scenes start in Foundry Parity"), so Foundry wins; flagged for the real-light mode
   (Author 2026-11-07: "use these regions as implied darker regions").
3. **Light activation range (IR-53).** Foundry uses scene darkness; physics would light a lamp in a dark room.
   Foundry wins in Parity.
4. **Edge softness (IR-15).** Foundry's own darkness mesh is blurred only lightly (`createBlurFilter(8, 2)`,
   `adjust-darkness-level.mjs:69-73`) and its `getDarknessLevel` is hard; the author asked for ~30 px. Author
   wins for the picture; the probe's Foundry fact stays hard (IR-20).
5. **Basement through the stairwell (IR-58).** Physics says dark; Foundry with a level-scoped Region says lit
   like the floor being viewed. Parity wins for the lab's current Region.
6. **Suppress Weather (IR-27).** Foundry's behaviour erases Foundry's own weather layer; MSA draws its own
   weather. The author places it on every interior, so MSA honouring it is the reading taken here.

## Manager review (2026-11-09) — checked against the code, not yet measured
- IR-27 confirmed in code: Suppress Weather is a documented DELIBERATE STUB (src/foundry/scene-regions.js header + readSuppressWeatherStub). Not a hidden bug; still a real gap for outdoor Regions.
- IR-26 confirmed in code: only the FIRST active adjustDarknessLevel behaviour is read, a named "rare-edge-case simplification" (scene-regions.js deriveRegionDarknessAdjuster). Fixed 2026-11-09 (mmp-78u.22): every active behaviour is read (`deriveRegionDarknessAdjusters`), and the Region's `levels` too (IR-22, the A half of IR-23; mmp-78u.19).
- IR-35..38 confirmed in code: the region overlay is "exactly the old opaque overwrite" of the ambient fill at full coverage (region-darkness.js header; vt-pan-viewer.js draws it after illumQuad and BEFORE tree/bush shadows). So building/cloud shadows (in the ambient fill) vanish inside a Region while vegetation shadows survive. Needs an outdoor-Region plot to measure.
- IR-01 answered: probe foundry.darkness reads 0.90 inside the walls lab's override-0.9 Region (measured 2026-11-08), so Foundry attribution works inside Regions.
