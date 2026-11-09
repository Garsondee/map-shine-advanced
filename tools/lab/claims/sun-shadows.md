# Claims: sun and building shadows (MSA Lab family 2)

Written 2026-11-09, BEFORE measuring (mmp-78u "expectations first"). Nothing here has been run on the rig.

**Sources**, most trusted first: `Foundry` (v14 source; Foundry has no sun, so it only rules on edges and
floors here), `MSA` (declarations: `src/effects/sun-shadows.js` params, whose help text is a promise; headers of
`layer-smear.js`, `layer-smear-render.js`, `shadow-bands.js`, `shadow-access.js`, `sun-shadow-subsystem.js`,
`sun-shadow-debug.js`; guide pages), `Author` (rants, by date), `Physics`, `Memory` (a measured finding).
**SUSPECT:** = code reading says this is already broken; reason and line in the row.

## The model in numbers (lab defaults)

`illum = ambient x sunVis` before lamps MAX on top (`environmental-light.js:589-605`). Use the RATIO
`R(p) = illum.g(p) / illum.g(S1.ref)` (same plot, same frame), which cancels exposure and the sky tint.

* Sun: elevation `e = (90 - |lat|) cos(2 pi (h-12)/24)`, azimuth `180 + 15 (h-12)` (`src/world/sun.js:98-103`,
  `vt-pan-viewer.js:14247`). Lab lat 30: max 60 deg. Shadows fall AWAY from the sun: noon -> north (-y),
  09:00 -> NW, 15:00 -> NE, dawn -> W, dusk -> E (`light-visibility.js:236-255`, `sun-occlusion.js:64-67`).
* Darkness of an opaque caster's core: `D = min(0.97, 0.665 (1 + 0.6 g)) x strength01 (0.85) x strengthMul`
  (`shadow-access.js:155-166`, `:223-226`; `sun-shadow-subsystem.js:1330-1383`), where `g` = golden01
  (`sun.js:132-133`) and `strengthMul = (1 - 0.85 c) x dayDisc`, `c` = cloud cover CAPPED at the clouds card's
  visual cap (default 0.3, `vt-pan-viewer.js:3939`, `:14376-14378`), dayDisc = smoothstep((e + 0.5)/3)
  (`shadow-access.js:385-387`). Core: `R = 1 - D`.
* Length: `L = C tanh(t / C)`, `t = h / max(tan e / (0.5 (1+g)), 1 / (4 (1+g)))`, `C` = 10 squares = 1500 px on
  the lab's 150 px grid (`layer-smear.js:277-315`, `sun-shadows.js:175-214`). Falloff is LINEAR
  (exponent 1, `sun-shadow-subsystem.js:369`): `R(x) = 1 - D (1 - x / L)` for `x` px out along the shadow.
* Heights: walls 260 px (`wallHeightPx`), overhead tiles 220 px (`overheadHeightPx`), the floor-above band =
  top of the Level stack: Upper's elevation top 40 x 30 px/ft = 1200 px (`shadow-bands.js:243-281`).

| hour (lat 30) | e | az | g | D | wall L | 1200 px band L |
|---|---|---|---|---|---|---|
| 06:30 / 17:30 | 7.8 | 97.5 / 262.5 | 0.63 | 0.78 | 1158 | 1500 |
| 09:00 / 15:00 | 42.4 | 135 / 225 | 0 | 0.565 | 142 | 618 |
| 12:00 | 60 | 180 | 0 | 0.565 | 75 | 340 |
| 17:00 | 15.5 | 255 | ~0 | 0.565 | 453 | 1340 |
| 17:52 (golden peak, e = 2) | 2 | 268 | 1 | 0.76 | 1324 | 1500 |
| 18:00 | 0 | 270 | 0.84 | 0.06 | 1284 | 1500 |
| 21:00 | -42 | | 0 | 0 | none | none |

Noon core illum = 0.933 x 0.435 = 0.406 (lit 0.034, presented ~52 in Measure view). Lat 60: noon wall L = 224 px;
lat 0: noon L = 0.

## Plots needed

Author conventions: buildings are black `_Outdoors` with hard 0-1 px edges (Wizard's Lair 10 px); upper floors
are opaque art with a matching black `_Outdoors`; roofs and awnings are tiles. Grid 150 px.

**Isolation rule (new, important):** a caster throws up to 10 squares (1500 px) at low sun. No other black
`_Outdoors`, Upper-floor art or tile may stand within 10 squares east and west, or 4 squares north, of a shadow
plot's casters. Row 0 is useless for noon shadows: they fall north into the padding, where shadows are cut. And
the control C2 "empty open" is not a clean leak detector at low sun: C3's room (260 px walls) and its Upper slab
(1200 px band) throw up to 10 squares west in the morning, across C2.

| Plot | Layout (squares) | Masks / documents | Sweep |
|---|---|---|---|
| S1 lone block | one 2x2 hard black block centred in an 8x8 white area | `_Outdoors` | hours 06:30, 09, 12, 15, 17, 17:30, 17:52, 18, 21; cloud 0 / 0.5 / 1; strength01, lengthScale, dawnDuskLength, wallHeightPx, longestShadowSquares, softnessBias, debugView; latitude 0 / 30 / 60 / -30; profile low |
| S2 pair and L | blocks A and B (2x2) one square apart east-west; a 3x3 L block two squares south | `_Outdoors` | 09, 12, 17, 17:30 |
| S3 storeys and bridge (needs Upper) | a: 2x2 ground block with a 2x2 Upper slab above it; b: bridge, a 5x1.5 Upper slab over WHITE ground; c: setback, 3x3 ground block with a 1.5x1.5 Upper slab over its north-east quarter | Ground `_Outdoors` (a, c black), Upper art opaque + black `_Outdoors` on the slabs only | 12, 15, 17:52; cloud 0.5 |
| S4 overhead tiles | a: 2x2 opaque grey tile at elevation 10 on Ground over white ground; b: the same at elevation 20 | tiles, no masks | 09, 12 |
| S5 scene edge (column 5, a row >= 1) | a 1-square-tall black strip from 3 squares inside to the scene's east edge, crossing it; a 1x1 block whose east face is 100 px from the edge | `_Outdoors` | 12, 15, 17:30 |
| S6 thin and soft | 4-square east-west black lines 1 px and 4 px wide; reuse C5's 10 px soft block | `_Outdoors` | 12, 17:30 |
| C3, C5, basement (exist) | | | 09, 12, 15 |

Probe points: `S1.ref` 2.5 squares south of the block (the sun is always in the southern half, so it is never
shadowed); `S1.N(x)`, `S1.S(x)`, `S1.E(x)`, `S1.W(x)` at x px out from each face's midpoint (x = 5, 10, 20, 40,
and fractions 0.25/0.5/0.75/1.0/1.15 of L); `S1.in` the block's centre; `S1.NWc(x)`, `S1.NEc(x)` along the 09:00
and 15:00 diagonals from those corners. `S2.gap(x)` x px east of A's east face inside the gap; `S2.Bw5`,
`S2.Bw40` 5 and 40 px west of B's west face; `S2.ov` east of B inside both dusk shadows. `S3.a.N(x)`;
`S3.b.mid` (ground under the deck centre), `S3.b.in20` (20 px inside the deck's south edge), `S3.b.in150`,
`S3.b.out` (40 px south of the deck, open), `S3.b.N(x)`; `S3.c.N(x)`. `S4.a.top` (on the tile), `S4.a.N(x)`,
`S4.b.N(x)`. `S5.d100`, `S5.d192`, `S5.d300`, `S5.d500` (north of the strip at those distances from the edge),
`S5.pad` (50 px east of the edge, in the padding). `S6.n1(x)`, `S6.n4(x)` north of the lines.

## Claims

| id | claim | source | probe check | conditions |
|---|---|---|---|---|
| SS-01 | Shadows fall away from the sun: north at noon, the south face stays lit. | MSA `src/world/sun.js:98-103`, `src/effects/lighting/light-visibility.js:236-255`; Physics | noon: `S1.N(40)` R <= 0.80; `S1.S(40)` R >= 0.97 | S1 noon |
| SS-02 | The shadow turns with the sun: NW at 09:00, NE at 15:00, west at dawn, east at dusk. | MSA `sun.js:103`; Physics | 09:00 `S1.NWc(100)` R <= 0.85 and `S1.NEc(100)` R >= 0.97; mirrored at 15:00; 06:30 `S1.W(300)` < `S1.E(300)`; 17:30 the reverse | S1 sweep |
| SS-03 | Length is height / tan(elevation), halved (Shadow length 0.5): wall 75 px at noon, 142 px at 09:00 and 15:00, 453 px at 17:00. | MSA `sun-shadows.js:30`, `:203-214`; `layer-smear.js:277-287` | `R(0.5 L)` = 1 - D/2 +-0.08 and `R(1.15 L)` >= 0.96 along the shadow axis | S1 12, 15, 17 |
| SS-04 | The falloff is linear from the wall to the tip. | MSA `sun-shadow-subsystem.js:367-369` (exponent 1, author-tuned 2026-08-02); `layer-smear.js:332-337` | at 17:00: R at 0.25/0.5/0.75 L = 1 - 0.75D / 1 - 0.5D / 1 - 0.25D, each +-0.08 | S1 17 |
| SS-05 | THE LAW: walking away from a caster along the shadow, it only ever gets lighter. | Author (quoted in `layer-smear.js:30-33`): "never ... goes from black to grey to white to grey to white"; MSA `layer-smear.js:28-50` | 12 points from x = 5 px to 1.2 L: R non-decreasing, each step >= -0.02 | S1, S2, S3 every hour |
| SS-06 | No gap at the wall: the darkest point is against the caster, dusk included. | Author 2026-10-28: "a gap between the outer edge of the building and where the shadow starts ... these should be the darkest regions"; MSA `layer-smear-render.js:356-370` | 17:52: R(5) <= R(50) and R(5) <= 1 - D + 0.08 | S1, C5 17:52 |
| SS-07 | Noon core: an opaque wall removes 56.5% of the sun (core 0.665 x Shadow strength 0.85). | MSA `shadow-access.js:139-155`, `:247-248`; `sun-shadows.js:97-112` | noon `S1.N(5)` R = 0.435 +-0.06; illum.g ~0.406 | S1 noon |
| SS-08 | Shadow strength scales the darkness: 0 removes every sun shadow. | MSA `sun-shadows.js:111` help: "How dark a fully-shadowed patch of ground goes" | strength01 0.425: `S1.N(5)` R = 0.72 +-0.06; 0: R = 1.00 +-0.01 | S1 noon, param |
| SS-09 | Lamps light shadowed ground straight back up: a lamp's bright core reads the same in a building's shadow as on open ground. | MSA `sun-shadows.js:111` help ("Torches and other lights still light it back up"); `light-visibility.js:207-233` | a LAMP centred 60 px north of the S1 block vs one on open ground: illum at 30 px from each lamp equal +-0.03 | S1 + 2 lamps, noon |
| SS-10 | Golden hour: much darker and much longer (x2 length, up to 0.97 core). | Author 2026-10-27: "building shadows should be very strong and very long at the golden hour"; MSA `shadow-access.js:156-166` | 17:52: `S1.E(5)` R = 0.24 +-0.07; `S1.E(0.5 L = 660)` R = 0.62 +-0.08; `S1.E(1400)` R >= 0.96 | S1 17:52 |
| SS-11 | No shadow runs further than "Longest shadow" (10 squares = 1500 px here). | MSA `sun-shadows.js:190-202` help: "The furthest any shadow reaches, in grid squares"; `layer-smear.js:289-315` | 17:52: the S3a two-storey block's shadow: R >= 0.97 at 1550 px; longestShadowSquares 5: R >= 0.97 at 790 px | S3, 17:52 |
| SS-12 | Height still reads through the day: a taller caster throws proportionally longer. | MSA `layer-smear.js:297-299` (tanh leaves short throws untouched) | 09:00: the S3a block's shadow end (R >= 0.96) lies >= 3x further than S1's wall shadow end (~618 vs ~142 px) | S1, S3 09:00 |
| SS-13 | Dawn/dusk length caps how far a shadow stretches at low sun. | MSA `sun-shadows.js:175-189` help ("the main knob for taming long evening shadows") | 17:30: dawnDuskLength 1 makes `S1.E(450)` R >= 0.96 (L shrinks from 1158 to ~412 px) | S1 17:30, param |
| SS-14 | Shadow length scales every shadow at every hour. | MSA `sun-shadows.js:203-214` | noon lengthScale 1.0: L = 150 px (R(75) = 0.72 +-0.08) | S1 noon, param |
| SS-15 | Wall height sets the walls' throw; 0 switches walls off. | MSA `sun-shadows.js:113-122` | noon wallHeightPx 520: L ~150 px; wallHeightPx 0: `S1.N(10)` R = 1.00 +-0.02 | S1 noon, param |
| SS-16 | Indoors never takes a sun shadow (the receiver gate). | MSA `layer-smear-render.js:284-289`; `sun-occlusion.js:105-133` | 17:00: `S1.in` illum equal +-0.01 to a black point in C5 at the same hour (both untouched indoor ambient) | S1, C5 17:00 |
| SS-17 | The sunward side gets no shadow beyond a few px of contact. | Physics; Author 2026-11-01 complaints about bright and dark bands at the wall | noon `S1.S(15)`, `S1.S(40)`, `S1.S(75)` R >= 0.97. SUSPECT, known mmp-78u.11 (a halo 60-75 px on all sides): the walls channel spills past a hard edge on the 512-cell shared grid (17.6 px/cell on the 9000 px lab) and the self rule leaves occ = s(1-s), up to 0.25, there (`layer-smear.js:669-670`, `layer-smear-render.js:507-509`) | S1 noon |
| SS-18 | The lateral faces (east and west at noon) get only a penumbra, no halo. | Physics | noon `S1.E(20)`, `S1.W(20)` R >= 0.97. SUSPECT: same halo | S1 noon |
| SS-19 | No lighter band or bright ring between a building and its own shadow. | Author 2026-11-01: "a brighter penumbra around building shadows ... Between the long and short shadow, a brighter ring"; MSA `environmental-light.js:745-753` | noon: R(3), R(10) <= R(20) + 0.02 on the shadow side | S1 noon |
| SS-20 | ...and not an extra-dark line hugging the wall either. | Author 2026-11-01: "Now that area looks too dark." | noon: R(3) >= 1 - D - 0.05 (no darker than the core) | S1 noon |
| SS-21 | A face lying inside another building's shadow shows no bright line along it. | Author 2026-11-01: "a line of brighter where it should just be the shadow of the other building" (west side); MSA `layer-smear-render.js:331-340` | 17:00 (A shadows the gap and B's west face): `S2.Bw5` R <= `S2.Bw40` R + 0.02 | S2 17:00 |
| SS-22 | Overlapping shadows never compound: the darker one wins. | MSA `layer-smear.js:674-693` (union, darkness applied once); `light-visibility.js:159-185` | 17:30: `S2.ov` R >= min(R of A alone, R of B alone) - 0.03, measured by hiding one block at a time (temporary mask) | S2 17:30 |
| SS-23 | A cloud over a building's shadow does not darken it twice (min, not product). | MSA `environmental-light.js:969-982` ("A building's shadow under a cloud's was 0.435 x 0.215"); `light-visibility.js:126-128` | cloud 0.5: the darkest `S1.N(5)` reading over 60 s >= min(building core R at this cover ~0.58, darkest cloud-core R on open ground) - 0.03 | S1 noon cloud |
| SS-24 | Cloud cover fades building shadows. Under full overcast there is "barely a shadow at all". | MSA `shadow-access.js:104-111` (CLOUD_SURVIVING_STRENGTH 0.15, quoting the author's "softer as cloud increases"); MSA `src/effects/clouds/clouds.js:138-148` help ("100% overcast sky still feels maximally gloomy through the shadow/grade/window terms even at this cap"); Physics | cloud 1: `S1.N(5)` R >= 0.90. SUSPECT: shadows read the cover CAPPED at the clouds card's visual cap (0.3 by default, `vt-pan-viewer.js:3939`, `:14376-14378`; `shadow-access.js:389-397`), so full overcast keeps 74.5% of the darkness (R ~0.58) | S1 noon cloud 1 |
| SS-25 | Partial cover fades building shadows partly and spatially (the cloud field does the rest). | MSA `shadow-access.js:389-397` | cloud 0.5: away from cloud cores `S1.N(5)` R = 1 - 0.565 x (1 - 0.85 x 0.3) = 0.58 +-0.06 | S1 noon cloud 0.5 |
| SS-26 | Cloud softens shadow edges; night softens them too; night under cloud is softest. | MSA `shadow-access.js:96-102`, `:296-301`, `:417-421` | the 10-90% width of S1's east penumbra at 15:00 grows >= 1.5x from cloud 0 to cloud 1 | S1 15 cloud |
| SS-27 | No sun shadow at night (none survives). | MSA `shadow-access.js:113-127` (NIGHT_SURVIVING_STRENGTH 0) | 21:00 moon on: `S1.N(5)` R = 1.00 +-0.01 | S1 21 |
| SS-28 | Shadows fade out through sunset over ~3 deg of elevation, never popping. | MSA `shadow-access.js:375-387` | 17:52 -> 18:00 -> 18:05 in 1-minute steps: `S1.E(5)` R rises monotonically, no step > 0.25 between steps | S1 dusk sweep |
| SS-29 | Moonlight casts no shadow (by design: the moon is added after every sun shadow). | MSA `shadow-access.js:121-126` | 21:00 moon on: `S1.N(40)` = `S1.S(40)` +-0.01 | S1 21 |
| SS-30 | At night a lightning strike throws its own hard building shadows, away from the strike. | MSA guide `learn-weather.md:28`; `environmental-light.js:532-538`, `:993-997`; Author 2026-11-08: "use a duplicate of the building and veg shadows to throw the scene into relief" | 21:00, force a strike west of S1: during the flash `S1.E(40)` illum rise < 50% of `S1.W(40)`'s rise | S1 strike |
| SS-31 | Shadows fade out near the map edge over "Map-edge fade" (384 px). | MSA `sun-shadows.js:229-238` help: "Stops a hard line appearing where the scene ends"; `layer-smear-render.js:523-525` | 15:00: shadow darkness at `S5.d100 / d192 / d300 / d500` = D x 0.17 / 0.50 / 0.89 / 1.0, each +-0.1 | S5 15 |
| SS-32 | Nothing is drawn in the padding: no shadow outside the scene rectangle. | Author 2026-10-27: "restrict rendering to only happen within the actual bounds of the scene"; MSA `environmental-light.js:843-852` | 15:00 and 17:30: `S5.pad` illum equals a padding point far from any caster +-0.01 | S5 |
| SS-33 | A building whose black runs off the map keeps casting "into the distance". | MSA `layer-smear-render.js:119-122` (clamp-to-edge is "the author's edge rule") | 15:00: north of the strip 500 px from the edge, R = 1 - D +-0.06. Conflict: the edge fade (SS-31) still weakens it inside 384 px | S5 15 |
| SS-34 | An Upper floor's art casts onto the ground below with a height read from the Levels (top of the stack, 1200 px here). | MSA `sun-shadows.js:36-63`; `shadow-bands.js:243-281` | noon: `S3.a.N(x)` reaches R >= 0.96 only at ~340-400 px (wall alone would end at 75); 15:00: ~618 px NE | S3 noon, 15 |
| SS-35 | Under a bridge (Upper art over open ground) the ground is shadowed, darker toward the middle, never black. | MSA `sun-shadows.js:157-174` help ("Roughly HALF the width of your widest covered span puts the darkest point at its middle"); Author 2026-08-02 via `layer-smear.js:410-414` ("still a little bit of light should leak through") | noon: R(`S3.b.mid`) <= R(`S3.b.in150`) <= R(`S3.b.in20`) < 0.85; R(`S3.b.mid`) >= 0.30; `S3.b.out` R >= 0.97 | S3 noon |
| SS-36 | The derived masks agree: under Upper art coverAbove 255 and skyReach 0; open ground 0 and 255; indoors skyReach 0. | MSA `src/scene/mask-catalog.js:486-502` | `masks.derived` at `S3.b.mid`: coverAbove 255 +-3, skyReach 0 +-3; at `S1.ref`: 0 and 255; at `S1.in`: skyReach 0 | S3, S1 |
| SS-37 | Cloud shadows never reach under a bridge or a floor above. | Author 2026-11-04: "Does this also work in the sky reach sense where we prevent clouds underneath bridges?"; MSA `environmental-light.js:903-913` | cloud 0.7 moving: `S3.b.mid` illum varies <= 0.01 over 30 s while `S3.b.out` varies > 0.05 | S3 cloud 0.7 |
| SS-38 | Stacked storeys do not darken a shadow further: a 3-storey core is no darker than a 2-storey one. | MSA `layer-smear.js:695-725` (bands combine by max) | `S3.a.N(5)` R >= `S1.N(5)` R - 0.03 at noon | S3, S1 noon |
| SS-39 | An opaque floor keeps the floor above's shadows off the floor below; shadows only fall through holes. | Author 2026-10-28: "If there were a hole we would want the shadow to reach downwards"; MSA `layer-smear-render.js:559-581` | view Basement at 15:00: 5 basement points equal +-0.01 (no ground or Upper shadow anywhere) | basement 15 |
| SS-40 | Shadows on a lower floor show through a hole in the floor above. | MSA `sun-shadow-subsystem.js:73-117` (section 5, multi-floor) | view Upper at noon: S1's shadow (seen through Upper's transparent art) has R(`S1.N(5)`) = 0.435 +-0.06 | S1, view Upper |
| SS-41 | An overhead tile casts from the overhead height (220 px) and never shadows itself. | MSA `sun-shadows.js:123-132`; `layer-smear.js:628-672` (Author 2026-08-02: "It should be underneath.") | noon: `S4.a.top` illum = open ground +-0.02 (tile art 128 assumed); `S4.a.N(x)` reaches R >= 0.96 at ~64-80 px | S4 noon |
| SS-42 | Every overhead tile throws the same length whatever its elevation (one height for all, a declared limitation). | MSA `sun-shadows.js:131` help: "until that lands, it is one height for all of them" | the elevation-10 and a temporary elevation-15 copy of S4a throw equal lengths +-10 px | S4 variant |
| SS-43 | A roof tile at or above the floor's top joins the floor-above band and casts from the top of the stack (1200 px here), not from its own 20 ft (declared over-estimate). | MSA `shadow-bands.js:50-59`, `mask-catalog.js:488-494` | noon: `S4.b.N(x)` reaches R >= 0.96 only at ~340-400 px (vs ~64 for S4a) | S4 noon |
| SS-44 | A 10 px soft `_Outdoors` edge (Wizard's Lair) and a hard one give the same shadow: same core, contact within 10 px. | MSA `sun-occlusion.js:105-135` (gate sharpening); `lab-spec.mjs:212-229` | noon: C5's soft block north shadow core R = 0.435 +-0.06, and its R(x) curve matches S1's shifted by <= 10 px | C5, S1 noon |
| SS-45 | A thin wall line still casts one continuous shadow, never dotted or striped along its length. | MSA `layer-smear.js:51-57` (each station samples a footprint at least as wide as its spacing) | noon: 8 points along `S6.n4(20)` vary <= 0.03; the 1 px line's shadow is present (R <= 0.95) and as even | S6 noon |
| SS-46 | Long shadows do not step into bands. | Author 2026-11-01: "Is there any way to defeat this 'stepping' effect on long shadows?"; MSA `layer-smear-render.js:315-330` | 17:52: 40 points 10 px apart along `S1.E` from 100 to 500 px: no adjacent pair differs by > 0.03 and no run of 4 equal values then a jump > 0.04 | S1 17:52 |
| SS-47 | A paused clock still moves shadows when the hour is set, and a cloud change re-bakes their darkness at once. | MSA `sun-shadow-subsystem.js:354-364` (sky rebake), memory (bake retry: "a bake that did not draw is not a bake") | rate 0: set 12 -> 15, `S1.NEc(100)` darkens within 2 s; cloud 0 -> 0.5, `S1.N(5)` lightens within 2 s | S1 |
| SS-48 | Latitude sets the noon height: 90 - abs(lat). | MSA `vt-pan-viewer.js:15209-15221`, `:14247` | lat 60: noon `S1.N(0.5 x 224)` R = 0.72 +-0.08; lat 0: noon `S1.N(20)` R >= 0.96 | S1 noon, lat |
| SS-49 | South of the equator the noon sun stands in the north, so shadows fall south. | Physics | lat -30 noon: `S1.S(40)` R <= 0.80 and `S1.N(40)` R >= 0.97. SUSPECT: the noon azimuth is fixed at 180 and only abs(lat) is used (`sun.js:33-37`, `vt-pan-viewer.js:14247`), so shadows still point north | S1 lat -30 |
| SS-50 | At the horizon a shadow stays finite (capped), with almost no darkness. | MSA `layer-smear.js:250-254` (HARD_CAP 8192), `shadow-access.js:385-387` | 18:00: `S1.E(5)` R = 0.94 +-0.04; nothing changes beyond 1500 px | S1 18:00 |
| SS-51 | 'Shadows - all, on white': open ground white, shadows grey, lit = white. | MSA `sun-shadows.js:239-261` help; `sun-shadow-debug.js:80-87` | debugView shadow-all at noon: `S1.ref presented` >= 250; `S1.N(5)` <= 200 and darker than `S1.N(40)` | S1 debug |
| SS-52 | 'building/wall only' isolates walls: the floor-above band vanishes. | MSA `sun-shadow-debug.js:108-114`, `:211-213` | shadow-building at noon: `S3.a.N(200)` presented >= 250 (band only) while `S3.a.N(5)` < 200 | S3 debug |
| SS-53 | 'sky-reach only' shows only the band shadows. | MSA `sun-shadow-debug.js:122-131` | shadow-skyreach at noon: `S1.N(5)` >= 250 (walls hidden); `S3.b.mid` < 230 | S1, S3 debug |
| SS-54 | 'walls, from the outdoors mask (R)' shows black `_Outdoors` as white. | MSA `sun-shadow-debug.js:155-163` | caster-walls: `S1.in` presented >= 250, `S1.ref` <= 5 | S1 debug |
| SS-55 | The lowest performance profile turns sun shadows off completely. | Author 2026-07-29 via `sun-shadows.js:282-295` ("the lowest performance tier should turn shadows off") | profile low, noon: `S1.N(5)` R = 1.00 +-0.01 | S1 profile low |
| SS-56 | Building shadows, cloud shadows and (later) tree shadows share one darkness at one hour. | Author 2026-11-01: "The goal is consistency of visual appearance between all shadow producers"; MSA `shadow-access.js:129-154` | noon, cloud 0.5: a solid cloud core on open ground darkens by D x 0.5 where D is the building core darkness at the same cover (~0.42, so R ~0.79; the cloud share is halved, `light-visibility.js:95-101`); add a tree plot later | S1 noon cloud |
| SS-57 | A shadow never darkens the floor art itself: albedo unchanged in shadow. | MSA `environmental-light.js:16-41` | `albedo` at `S1.N(5)` = 128 +-1 | S1 noon |
| SS-58 | A scene saved dark has no sun, so no sun shadows. | Physics; Memory parity-scene-darkness (mmp-ynr.9 open) | scene darkness saved 1, noon: `S1.N(5)` R = 1.00 +-0.02. SUSPECT: the atmosphere keys off sun elevation only (`shadow-access.js:372-423`) | S1, saved darkness 1 |
| SS-59 | Diagonal shadow edges are smooth at the default tier (no visible stairs). | Author 2026-10-16 via `layer-smear.js:185-194` ("the stepped look is still there, we need higher resolution") | 15:00: along S1's NE shadow side, 10 points 5 px apart across the edge rise smoothly (no plateau > 2 points) | S1 15 |

## Conflicts between sources

1. **The halo (SS-17, SS-18).** Physics says nothing darkens the sunward side; the author guessed on 2026-11-08
   ("It's a building shadow AO right? Something like that?") but did not ask for it. Physics wins until she
   rules; a contact darkening of a few px would satisfy both.
2. **Full overcast (SS-24).** `shadow-access.js:104-111` still promises "barely a shadow at all" at full cloud;
   the 2026-11-01 cap (`:389-397`) keeps ~75% of the darkness at full cover. The newer cap is deliberate, but its
   own header and the older promise disagree; physics sides with the promise.
3. **The map edge (SS-31 vs SS-33).** Two MSA rules: a building crossing the edge keeps casting (clamp-to-edge),
   and every shadow fades within 384 px of the edge. The fade is applied to the result, so it wins near the edge.
4. **Roof tiles and overhead height (SS-42, SS-43).** Physics: a shadow's length follows the caster's own
   height. MSA declares one overhead height and an over-estimating top band; declared limitations, not bugs.
5. **Latitude below zero (SS-49).** The Remote's latitude fader is bipolar (-90..90, `vertical-fader.js:98`), but
   the sun model has no southern hemisphere. Physics wins.

## Manager review (2026-11-09) — checked against the code, not yet measured
- SS-24 confirmed in code: shadows read `Math.min(cloudCover01, cloudVisualCoverMax)` (vt-pan-viewer.js ~14376) and cloudVisualCoverMax defaults to 0.3 (~3939), a value tuned for the cloud VISUALS; shadow-access.js promises CLOUD_SURVIVING_STRENGTH 0.15 at full cloud. Full overcast therefore keeps ~75% of shadow strength. Measure before filing.
- SS-49 confirmed in code but by design: world/sun.js uses a stage convention (noon azimuth fixed at 180, latitude only sets max elevation = 90 - |lat|). A southern latitude does not flip the sun north. Taste/decision, not a bug.
- Lab-layout notes taken: noon shadows in row 0 fall north into the padding (shadow plots need clear ground to their north); C2 is not a clean leak control at low sun (C3's long shadows reach it).
