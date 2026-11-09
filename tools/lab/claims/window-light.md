# Claims: window light (MSA Lab family 3)

Written 2026-11-09, BEFORE measuring (mmp-78u "expectations first"). Nothing here has been run on the rig.

**Sources**, most trusted first: `Foundry` (walls and Levels only; Foundry has no window light), `MSA`
(declarations: `src/effects/window/window.js` params, whose help text is a promise; module headers in
`src/effects/window/`; `src/scene/mask-catalog.js`; guide `mask-window.md`, `mask-air.md`, `learn-weather.md`),
`Author` (rants, by date), `Physics`, `Memory`. **SUSPECT:** = code reading says this is already broken.

## The model in numbers (lab defaults)

`_Window` is the light itself, not an aperture (`mask-catalog.js:334-339`). Per texel
(`window-cookie.js:95-127`): `v = max(r,g,b)`, `level = (v x alpha)^contrast` (contrast 2; alpha 0 is read as
"no alpha channel", i.e. 1), `tint = rgb / v`, presence ramps from 1/255 to 20/255. Then
(`window-render.js:1081-1158`, `window-weather.js:183-251`):

* `raw = level x tint x strength (0.53) x overcastDim x noonBoost` (noonBoost = 1 + 0.3 x clearNoon01, so x1.3
  on any clear, non-golden day; `vt-pan-viewer.js:4025`, `:14794-14825`);
* `fill = 1 - exp(-2 x peak(raw))`, applied to all three channels by the same ratio;
* `target` = the outdoor light (ambient fill x sky colour + moon) leaning toward the window's hue, luminance kept,
  times "Brightness vs outdoors" 1.2 (capped at 1.2);
* `illum += grade(fill x target) - fill x roomLight`, where `grade` is the card's CC (default gamma 0.73, i.e.
  `x^1.37`) and `roomLight` is the room's own light after Regions, before lamps.

Worked values at clear noon in the author's OVERRIDE 0.9 room (roomLight 0.263, outdoor luma 0.933, target luma
1.12; r = Night fader = 0):

| painted grey | fill | expected illum | lit (grey 128 floor) |
|---|---|---|---|
| 255 | 0.75 | ~0.85 | ~0.16 |
| 224 | 0.66 | ~0.75 | ~0.12 |
| 220 (lab pools) | 0.64 | ~0.73 | ~0.115 |
| 128 | 0.29 | ~0.40 | ~0.032 |
| 64 | 0.08 | ~0.28 | ~0.018 |
| 32 or less | ~0.02 | 0.263 (nothing) | 0.0157 |

Sun & rooms (`window-room-light.js:132-147`, `:284-346`): a window facing the sun (`f` = smoothstep of its outward
normal . toSun) throws its DIRECT share away from the sun by `min(150, 120 / tan e)` px (69 px at noon, 150 px
below ~39 deg) and smears it back to where it was painted, fading to 0 at the far end; its rest (`1 - f`) is
DIFFUSE and stays as painted. Below 50 deg the direct share is boosted by `1 + 0.5 lowSun` and the diffuse share
dimmed by `1 - 0.45 lowSun`, `lowSun = 1 - smoothstep(0, 50, e)` (0.35 at 08:00 and 16:00). At night nothing
moves. Lab lat 30: 08:00 = elevation 30, azimuth 120 (sun ESE); 16:00 = elevation 30, azimuth 240 (WSW).

## Plots needed

Author conventions (measured on her modern maps, 2026-11-08): soft grey `_Window` pools with 52-72 px edges,
painted on the floor INSIDE the room against the window wall, frame bars left dark; Window-preset walls (move 20,
sight/light 30, thresholds 10, attenuation) as a 2-square feature segment in a normal wall; rooms black on
`_Outdoors` with an indoor Region (OVERRIDE 0.9 + Suppress Weather). Grid 150 px.

| Plot | Layout (squares) | Masks / documents | Sweep |
|---|---|---|---|
| W1 clock room | closed 6x6 room centred in the 8x8 area (1 square of white margin); a 2-square Window-preset segment in the middle of each wall; a pool against each window inside: 2 wide x 2 deep, grey 220, 60 px feather; two 8 px dark glazing bars across the south pool; `_Dust` over the west half of the room | `_Outdoors` room black; `_Window`; `_Dust`; indoor Region on the room | 08, 12, 16, 17:52, 21; cloud 0 / 0.6 / 1; rain 0.1 / 0.5 / 1 with wind 0.3; snow 0.5 / 0.9; a forced lightning strike at 21; latitude 0 at noon |
| W2 decode wedge | closed 6x6 room with NO window walls; a strip of hard-edged 1x1 chips on `_Window`: greys 0, 32, 64, 96, 128, 160, 192, 224, 255; red, green, blue, yellow at full value; red and blue at half value (128); white at alpha 128; white stored under alpha 0 | `_Window` saved RGBA with exact alpha (lossy WebP may scrub colour under alpha 0); room black + indoor Region | noon |
| W3 two rooms | room A 2.5 wide and room B 3.5 wide, both 5 tall, sharing a north-south wall with a closed door; A's west wall has a Window-preset segment and a pool 2 deep against it | `_Outdoors` both black, one indoor Region over both | 12, 16 |
| W4 outside and unregioned | a: a pool painted on white open ground, no walls; b: a closed 4x4 room, black, NO Region, west window and pool | `_Outdoors`, `_Window` | noon, 21 |
| W6 floors and alias | a closed 4x4 ground room with a west window and pool; an opaque Upper slab exactly over it (black Upper `_Outdoors`) carrying its own pool, the Upper mask named `_Structural` | Ground `_Window`, Upper `_Structural` | view Ground, view Upper |
| Walls lab pool row (exists) | `_Windows`-named pools against every wall type; its walls are open-ended, so each cell's indoor and outdoor halves are ONE room and Sun & rooms never moves these pools (no exterior window step) | | noon |

Probe points (all on screen). W1, per window k in S, W, E, N: `W1.k.c` pool centre (150 px from the wall),
`W1.k.far` (270 px), `W1.k.edge` (330 px, the painted pool's outer edge), `W1.k.beyond` (405 px, past the
painted pool), `W1.k.side` (300 px along the wall from the pool's centre, 75 px in), `W1.k.out` (75 px outside
the window wall, on white ground); `W1.S.bar` on a glazing bar;
`W1.ref` a room corner 100 px from two walls; `W1.open` white ground 75 px west and 75 px south of the room's SW
corner (never shadowed: the sun stays in the southern half). W2: `W2.<chip>` chip centres, `W2.ref` bare floor.
W3: `W3.Ac` (A's pool centre), `W3.Aw` (A, 30 px west of the shared wall at the pool's height), `W3.Bn` (B, 40 px
east of the shared wall, same height), `W3.Bref` (B's far corner). W4: `W4.a.c`, `W4.a.ref` (open ground 300 px
away), `W4.b.c`, `W4.b.ref`. W6: `W6.g.c` (ground pool centre), `W6.u.c` (Upper pool centre), `W6.slab` (bare
slab). Metric: `illum` (the room's ambient plus the window's pull) and `lit`; a pool's DELTA = illum(point) - illum(`ref`). The
default glass textures every pool (caustic strength 2, sharpness 6, thickness 3.5 px), so read each named point
as the mean of a 3x3 patch 10 px apart, and run W2's decode checks with Glass thickness 0 (glass off).

## Claims

| id | claim | source | probe check | conditions |
|---|---|---|---|---|
| WL-01 | `_Window`, `_Windows` and `_Structural` are all discovered as the same window mask. | MSA `src/scene/mask-catalog.js:321-340`; guide `mask-window.md:27` | walls lab (`_Windows`): `masks.masks.window` non-null at a pool point; W6 Upper (`_Structural`): non-null at `W6.u.c` | walls lab, W6 |
| WL-02 | If two aliases sit beside one art file, the canonical `_Window` wins. | MSA `mask-catalog.js:64-66` (canonical first) | temporary second file `_Windows` with a different pool next to W1's art: only `_Window`'s pool lights | W1 variant |
| WL-03 | The mask is the light: it lights where painted whatever the walls, even in a room with no window. | Author 2026-07-27 via `window-cookie.js:9-25` ("any bright pixel is where a bright light would fall on the interior"); MSA `mask-catalog.js:334-339` | `W2.255` delta >= 0.5 although W2 has no window walls | W2 noon |
| WL-04 | Window light changes light, never the art: albedo unchanged, illum raised. | MSA `window-render.js:14-24` ("THIS ADDS. IT NEVER TOUCHES COMPOSED SCENE COLOUR.") | `W1.W.c albedo` 128 +-1; `illum` > `W1.ref illum` + 0.3 | W1 noon |
| WL-05 | Level is the brightest channel: pure red, green and blue chips let in as much light (in their own channel) as white. | MSA `window-cookie.js:15-22`, `:105-127` | noon: delta of `W2.red` in R, `W2.green` in G, `W2.blue` in B each = `W2.255`'s delta in that channel +-0.04 | W2 noon |
| WL-06 | Tint is rgb / max: a pure blue patch adds blue light only. | MSA `window-cookie.js:19-20` (stained glass); guide `mask-window.md:17-18` | `W2.blue illum` R and G = `W2.ref` +-0.01; B up >= 0.5 | W2 noon |
| WL-07 | A saturated colour stays saturated at any brightness. | MSA `window-cookie.js:81-85` | `W2.red128` G and B = `W2.ref` +-0.01, R up | W2 noon |
| WL-08 | Black is no light; values up to 1/255 contribute nothing. | MSA `window-cookie.js:46-52`; guide `mask-window.md:19` | `W2.0` delta 0 +-0.005 | W2 noon |
| WL-09 | More paint never means less light (monotone wedge). | MSA `window-cookie.js:105-127` (level is a power of value) | deltas along `W2.0 ... W2.255` non-decreasing, each step >= -0.01 | W2 noon |
| WL-10 | Patch contrast 2 makes the falloff steep: mid-grey lets in about a quarter of white's light, dark greys nearly none. | MSA `window.js:68-80` help ("Above 1 sharpens the cookie") | `W2.128` delta / `W2.255` delta = 0.24 +-0.08; `W2.64` < 0.05; values at the worked table +-0.08 | W2 noon |
| WL-11 | Alpha scales the level like value does: white at alpha 128 equals grey 128 at full alpha. | MSA `window-cookie.js:105-111` (level from v x alpha) | `W2.alpha128` delta = `W2.128` delta +-0.03 | W2 noon |
| WL-12 | A fully transparent pixel is read by its hidden colour at full strength (the editor trap the guide warns about). | MSA `window-cookie.js:55-60`, `:107-109`; guide `learn-editors.md:30`, `mask-window.md:26` | `W2.alpha0white` delta = `W2.255` delta +-0.05 (only meaningful if the encoder kept the colour) | W2 noon |
| WL-13 | Indoors is never brighter than 120% of the open ground outside, at any hour. | Author 2026-11-04: "I'll allow only a 120% strength"; MSA `window.js:57-66` help, `window-weather.js:167-178` (clamp) | luma(illum) at `W1.S.c`, `W1.W.c` <= 1.2 x luma(`W1.open`) + 0.02 at 08, 12, 16, 17:52, 21 | W1 sweep |
| WL-14 | A fully painted pool sits roughly at the outdoor level at clear noon, neither much darker nor brighter. | Author 2026-10-27: "it should end up roughly the same brightness as the outdoors around it, neither much darker nor brighter" | `W2.255 illum` between 0.75 and 1.2 x `W1.open`; the lab's 220 pools between 0.65 and 1.0 x | W2, W1 noon |
| WL-15 | Window light works inside a darkness Region: it lifts the room from the Region's level, not from daylight. | MSA `window-render.js:379-384` (roomLight, the Wizard's Lair fix); Memory orrery-shadows-window-regions | noon: `W1.W.c illum` = 0.73 +-0.10 (room 0.263) | W1 noon |
| WL-16 | In a room without a Region (lit like the street, mmp-78u.10) a window adds at most ~20%. | MSA `window-weather.js:207-251` (pull toward 1.2 x outdoor) | `W4.b.c illum` <= 1.2 x `W4.b.ref` + 0.02 | W4 noon |
| WL-17 | A pool painted on open ground outside brightens it at most to 120% (the guide calls it wasted). | MSA guide `mask-window.md:23`; `window-weather.js:176` | `W4.a.c illum` <= 1.2 x `W4.a.ref` + 0.02 | W4 noon |
| WL-18 | Window light is gated to its own floor: an Upper slab covering a ground pool shows no ground window light, and the Upper's own pool lights the slab. | MSA `window.js:1095-1097` (tier 0 "gated to the visible floor"), debug channel 6 `window.js:897-913` | view Upper: `W6.slab illum` = bare slab value +-0.01 directly over the ground pool; `W6.u.c` delta >= 0.3. View Ground: `W6.g.c` delta >= 0.3 | W6 |
| WL-19 | At noon the window light carries the outdoor colour, no lean of its own. | MSA `window.js:83-92` help ("Fades to no tint by noon"); `window-weather.js:113-160` | noon: R/G and B/G of `W1.W.c`'s delta equal those of `W1.open` +-0.03 | W1 noon |
| WL-20 | Golden hour leans the window light warm, harder than the outdoors. | MSA `window.js:126-135` (Golden hour boost); Author 2026-10-27: golden hour "could be pushed into the more dramatic" | 17:52: R/B of `W1.W.c` delta >= R/B of `W1.open` | W1 17:52 |
| WL-21 | ...but golden hour is never blown out or "far too red". | Author 2026-10-27: "golden hour ... becomes extremely bright in the greenhouse, far too bright", and "far too red"; Author 2026-10-28: "about 20% less strong"; MSA `window-weather.js:110-111`, `:129-160` | 17:52: luma rule WL-13 holds; G/R of the delta >= 0.45 | W1 17:52 |
| WL-22 | At night the window light turns cool (moonlight). | Author 2026-10-27: "nighttime lighting which is presumably moon light and should be more dramatically cool in temp"; MSA `window.js:113-125` | 21:00 clear, moon on: B/R of `W1.W.c`'s delta (or of its illum) >= 1.15 | W1 21 |
| WL-23 | At night, with the moon up and a clear sky, a pool is brighter than the unlit room around it. | Author 2026-10-27: "too dark at night"; MSA `window-surface-subsystem.js:239-243` (the light let in includes the moon); Physics | 21:00 clear: `W1.W.c illum` >= `W1.ref illum` + 0.02. SUSPECT: same CC-before-subtraction mechanism as WL-25: the let-in light (~0.385 luma) is brighter than the room (0.263), yet incoming 0.21 graded to 0.12 against 0.14 removed leaves the pool at ~0.24, darker than the room (default ccGamma 0.73, `window.js:833-842`) | W1 21 |
| WL-24 | At night under full cloud a pool is never darker than the room it lies in. | Physics; Author 2026-10-27: "I still want light indoors during rainstorms and high cloud" | 21:00, moon off: `W1.W.c illum` >= `W1.ref illum` - 0.01. SUSPECT: the signed pull plus the OVERRIDE room (0.263 is above the night floor 0.188) gives ~0.18, a third darker than the room (`window-render.js:1140-1150`; Foundry OVERRIDE is constant) | W1 21, moonlight 0 (stands in for full overcast: the cloud field covers at most ~30% of the sky) |
| WL-25 | A cloud passing over a window dims its light, but the pool stays clearly brighter than its room: the glass still lets in at least the diffuse skylight (40% of the light outside). | MSA `window-render.js:123-130`, `:1052-1063` (floor 0.4, mmp-63o.32: "takes the SUN, never the sky"); Author 2026-10-27: "I still want light indoors during rainstorms and high cloud" | cloud 0.6 at noon: the minimum of `W1.W.c` delta over 60 s >= 0.05 (without the CC it would be ~0.12). SUSPECT: the CC's gamma 0.73 (x^1.37) is applied to the incoming light before the room's light is subtracted (`window-render.js:1148-1150`, `window-grade.js:95-103`), so any let-in light below ~0.43 luma nets ~0 or less against a 0.263 room: ~0.01 here | W1 cloud 0.6 |
| WL-26 | Full overcast makes window light dimmer (up to ~half), softer and less saturated, never off. | Author 2026-09-10 via `window-render.js:96-110` ("drop its overall brightness by up to 50%"); Author 2026-11-03: "more diffuse and less saturated/vibrant"; Author 2026-10-27: "dramatic, never dull" | cloud 1 at noon, Atmos 1: `W1.W.c` delta between 0.2 and 0.75 of clear; the pool edge 10-90% width wider than clear; R/B of the delta closer to 1 than clear's | W1 cloud 1, sky gradeEnvStrength (Atmos) 1 |
| WL-27 | Sun breaks are off by default (Overcast fill 1): heavy cloud adds no break pattern. | MSA `window.js:136-145` (default 1), `window-weather.js:46-50` | cloud 0.9: std of a 5x5 grid of `W1.W.c`-area deltas within 1.2x of the clear-sky std (the painted gradient) | W1 cloud 0.9 |
| WL-28 | Interior floor away from windows is untouched by cloud. | MSA `environmental-light.js:903-913` | cloud 0.6: `W1.ref illum` varies <= 0.01 over 60 s | W1 cloud 0.6 |
| WL-29 | Rain dims window light slightly overall and darkens it in waves that travel with the wind, never brighter than dry and never below the 3% floor dial. | Author 2026-10-27: "a darkening effect to the _Windows light which darkens where the current rain shader brightens"; MSA `window.js:156-271`, `window-weather.js:300-317` | rain 1, wind 0.3: time-mean of `W1.W.c` delta <= 0.94 x dry; its max over 60 s <= dry + 0.01; its min >= 0.5 x dry (with the default dials the light let in drops at most 22%) | W1 rain 1 |
| WL-30 | Rain waves start at precipitation 0.15. | MSA `window.js:213-222` | rain 0.1: `W1.W.c` delta = dry +-0.01 (no glass drops either, see WL-32) | W1 rain 0.1 |
| WL-31 | A dry pane is exactly the no-rain picture. | MSA `window-rain.js:19-20` ("EXACTLY (0, 0) and 1 when presence is 0") | precip 0 after a long dry spell: 5x5 grid over `W1.S` pool identical +-0.002 to a run with rain-on-glass off (rainResponse 0) | W1 dry |
| WL-32 | Raindrops show only in the brightest half of the window light. | Author 2026-11-08: "only the 50% brightest parts of the effect should show the rain"; MSA `window.js:648-657` (default 50) | rain 0.5: temporal std of illum at `W1.W.c` (bright core) > 2x the std at the pool's outer feather (dimmest half), which stays within 1.2x dry | W1 rain 0.5 |
| WL-33 | The number of drops follows the amount of rain. | Author 2026-11-03: "link the number of splashes to the amount of rain much more closely"; MSA `window.js:518-527` | spatial std inside the S pool core at rain 1 > at rain 0.5 > at rain 0.2 | W1 rain sweep |
| WL-34 | Drops dry off within the drying time after rain stops. | MSA `window.js:638-647` (7 s) | rain 1 -> 0 (Now): std inside the pool core back to dry +-20% within 12 s | W1 |
| WL-35 | Running drops run toward the window wall (down the pane), which needs `_Outdoors`. | MSA `window.js:558-567` help; `window-render.js:30-36`; debug channel 13 `window.js:983-997` | debug channel 13 (R = 0.5 + 0.5x, G = 0.5 + 0.5y of the run direction): S pool R ~0.5, G ~1 (south); W pool R ~0, G ~0.5 (west); E pool R ~1; N pool G ~0; no pool black | W1 rain 0.5 debug |
| WL-36 | Rain on the glass only ever touches window light, never bare floor. | MSA `window-rain.js:9-17` (it lenses the cookie) | rain 1: `W1.ref` and `W1.k.side` temporal std <= 0.002 | W1 rain 1 |
| WL-37 | Snow shows as flake shadows falling across the pool, their number linear in the snow. | Author 2026-11-03: "a flurry of snow outside ... from very small values all the way up to the highest values"; MSA `window-snow.js:8-17`, `window.js:671-680` | snow 0.2 vs 0.5: spatial std inside the pool core roughly doubles (x1.5 to x3) | W1 snow |
| WL-38 | In the heaviest snow the light turns diffuse, cool and softly bright (whiteout from 0.75). | MSA `window-snow.js:23-24`; `window.js:761-770` | snow 0.9: B/R of the `W1.W.c` delta >= 1.05; pool edge 10-90% width > snow 0.5's | W1 snow 0.9 |
| WL-39 | Snow drifts on the sill build over minutes and stay after the snow stops. | MSA `window.js:731-750` (melt 300 s) | snow 0.9 for 5 min then 0: the pool band nearest the wall stays dimmer than before the snow for >= 60 s | W1 snow |
| WL-40 | Sun drift: a window facing the sun throws its light away from the sun, ~69 px at noon for a south window. | Author 2026-10-28: "the _Window light also moved and smeared at different times of day"; MSA `window.js:277-306` help, `window-room-light.js:132-147` | noon: `W1.S.edge` delta > `W1.W.edge` delta + 0.02 (the south light reaches further in than the unmoved west light; the smear fades to 0 at its far end, so look just past the painted edge) | W1 noon |
| WL-41 | A window facing away from the sun keeps its light where painted, dimmed while the sun is low. | MSA `window.js:367-376` (Shaded side dim 0.45), `window-room-light.js:329-338` | 16:00: `W1.E.c` delta = 0.84 x its noon delta +-0.08 | W1 16 |
| WL-42 | The sunny side brightens and streams into the room at a low sun: east windows at dawn, west at dusk. | Author 2026-10-28: "make the _Window effect brighter on one side of the house at dawn and darker on the other and vice versa"; MSA `window.js:357-366` | 16:00: `W1.W.beyond` delta > its noon delta + 0.05; 08:00: `W1.E.beyond` likewise; `W1.W.beyond` at 08:00 ~ its noon value | W1 08, 16 |
| WL-43 | North windows never get the direct sun (northern hemisphere). | Physics; MSA `window-room-light.js:267-276` (facing = smoothstep of the dot) | at 08, 12, 16: `W1.N.beyond` delta = its 12:00 value +-0.02 (no streaming) | W1 sweep |
| WL-44 | The smear is brightest where painted and fades to nothing at its far end. | Author 2026-11-01: "brightest at one end and gradually blur and become dimmer till it hits 0% brightness at the extreme end of the smear"; MSA `window-room-light.js:31-38` | 16:00 along the W beam from `W1.W.c` eastward in 30 px steps: delta non-increasing, ~0 by 150 px past the painted far edge | W1 16 |
| WL-45 | The smear is smooth: no grain, no stripes. | Author 2026-11-04: "we get quite a noisy grainy effect, is there no smoother way"; MSA `window-room-light.js:39-46` | 16:00: 20 points 8 px apart along and across the W smear; no adjacent pair differs by more than 0.03 | W1 16 |
| WL-46 | Moving light never crosses into another room. | Author 2026-10-28: "what we never want is for that light to move accidentally into another room"; MSA `window.js:337-346` help ("Light never crosses into another room or outside either way") | 16:00: `W3.Bn illum` = `W3.Bref` +-0.01 while `W3.Aw` > `W3.Bn` | W3 16 |
| WL-47 | ...or outside the building. | Author 2026-10-28: "or outside the building"; MSA same help | at 08, 12, 16: every `W1.k.out` equals open ground at the same hour (rescaled for its own building shadow) +-0.01: zero window delta | W1 sweep |
| WL-48 | The moving light thins out against walls instead of ending on a line (wall fade 48 px). | Author 2026-10-28: "a sort of AO around each Foundry wall to create soft transitions"; MSA `window.js:337-356` | 16:00: `W3.Aw` (30 px from the shared wall) delta <= 0.6 x the delta 120 px from it on the same row | W3 16 |
| WL-49 | With the sun straight overhead the light is exactly as painted. | MSA `window-room-light.js:30-31` ("with the sun overhead the light is as painted") | latitude 0 at noon: `W1.S.edge` delta = `W1.W.edge` delta +-0.01 | W1 lat 0 noon |
| WL-50 | Paint pools for midday and the sun does the rest. | MSA guide `mask-window.md:29-31` ("paint it for midday and let the sun do the rest") | noon at lat 30: `W1.S` light lies where painted (centroid shift <= 20 px). SUSPECT (guide or code): the drift law moves a south window's direct light ~69 px at noon (`window-room-light.js:137-139`); see Conflicts | W1 noon |
| WL-51 | At night nothing moves. | MSA `window-room-light.js:124-131` (throw fades with dayFactor) | 21:00: `W1.S.edge` delta = `W1.W.edge` delta +-0.01 | W1 21 |
| WL-52 | Walls that only stop movement do not divide rooms; doors (open or shut) always do. | MSA `src/foundry/scene-walls.js:254-259`; `src/scene/room-map.js:12-14` | debug channel 16: W3's two rooms show different colours across the shut door | W3 debug |
| WL-53 | Both window conventions count as windows for the sunny side: the Window preset, and sight-Proximity with light None (Mad Scientist's Compound). | MSA `scene-walls.js:227-241` | debug channel 18 G (has a window) non-black near each W1 window; repeat with the S segment switched to sight Proximity / light None | W1 debug |
| WL-54 | A lightning strike turns window light cold and streams it away from the strike. | MSA guide `learn-weather.md:28` ("`_Window` light turns cold and streams away from the strike"); Author 2026-11-07: lightning "illuminating through building windows, brightening up the _Windows effect"; MSA `window-room-light.js:149-187` | 21:00, strike west of W1: during the flash `W1.W.c` delta rises and its B/R rises; the W beam shifts east (toward `W1.W.beyond`) by <= 150 px | W1 strike |
| WL-55 | Players who reduce flashing effects see no lightning, windows included. | MSA guide `learn-weather.md:28` | on a client with reduced flashing: `W1.W.c` delta unchanged +-0.01 through a strike | W1 strike, 2nd client |
| WL-56 | Dust motes show only where window light falls. | MSA guide `mask-air.md:8` ("The specks only show up where window light falls"); `dust.js:12-16` | over 3 s: max-min of `presented` at `W1.W.c` (dusty, lit) >= 3 bytes; at `W1.ref` (dusty, unlit) <= 1 byte | W1 noon |
| WL-57 | At night the motes drop to about a third of their daytime strength and take the light's colour. | Author 2026-10-28: "At night they need to be lower opacity and change to being the sun colour / moon colour. I'd say about 33%"; MSA `dust.js:273-291` | 21:00 vs noon: max-min of `presented` at `W1.W.c` <= 0.45 x the noon spread | W1 21 |
| WL-58 | Window strength 0 turns window light off entirely. | MSA `window.js:40-52` help ("Turn it to 0 to see the map with no window light at all") | strength 0: every W1 point = `W1.ref` +-0.005 | W1 param |
| WL-59 | Exposure +1 doubles the light the window lets in. | MSA `window.js:775-784` help ("+1 = twice as bright") | ccExposure 1: the incoming part at `W1.W.c` doubles (delta + fill x roomLight roughly x2, +-15%) | W1 param |
| WL-60 | Window light is cropped to its mask's footprint: nothing outside the painted area's box. | MSA `window.js:1095-1097` ("cropped to the mask own AABB (Law 6)") | 300 px beyond every W1 pool (inside the room, not on a drift path): delta 0 +-0.005 at noon | W1 noon |
| WL-61 | Frame bars painted dark stay dark in the light. | MSA guide `mask-window.md:15`, `:25` ("Leave the bars of the window frame dark") | noon: `W1.S.bar` delta <= 0.5 x `W1.S.c` delta | W1 noon |
| WL-62 | A building shadow lying across a window does NOT dim its light (the 'occlude' rung is deferred, not built). | MSA `window.js:1192-1196` (deferredRungs.occlude) | expectation recorded so a guide promise of it can be caught; no failure if a shadowed window stays lit | none |
| WL-63 | With the Atmos slider at 0 (the lab's `LAB_SKY.gradeEnvStrength`), overcast changes nothing in window light; only passing cloud shadows (WL-25) still dim it. Declared, so a lab run that shows no overcast response is not a bug. | Author 2026-11-03: "needs to be called Atmos and needs to change the _Window effect too"; MSA `vt-pan-viewer.js:3994-3997` ("Slider at 0 = windows ignore cloud"), `:14683` | cloud 1, Atmos 0: the max of `W1.W.c` delta over 60 s equals clear +-0.03 (between passing clouds the light is full: no global dim) | W1 cloud 1, Atmos 0 |

## Conflicts between sources

1. **"Paint it for midday" (WL-50).** The guide says the painted pool is the midday light; the drift law moves a
   sun-facing (south) window's direct share ~69 px at noon at latitude 30, and only stands still with the sun
   straight overhead (WL-49). East, west and north windows do stand still at noon. Either the guide or the throw
   law (e.g. measuring the throw relative to noon) needs to give.
2. **Night (WL-23, WL-24).** The author wants moonlight through windows; Foundry's OVERRIDE keeps her rooms at
   0.263 all night, above the night floor, and the window pull is signed, so a window can darken its room. The
   CC gamma 0.73 makes it worse by deepening dim incoming light before the room's light is subtracted.
3. **'moon' listed as deferred.** `window.js:1145-1148` still lists the moon rung as not built, while the target
   light has included the moon since 2026-10-27 (`window-surface-subsystem.js:239-243`). The manifest
   under-claims; harmless, but the "never describe planned features as working" rule has a mirror image here.
4. **Building shadow over a window (WL-62).** Physics says it should cut the light; MSA declares it deferred.

## Manager review (2026-11-09)
- WL-63: MSA's own DEFAULT_SKY.gradeEnvStrength is 0 (src/world/sky-settings.js), so the lab sky matches "as shipped"; windows ignoring overcast at Atmos 0 is a property of the defaults. Keep as a claim to measure, not a lab fix.
- The walls lab's open-ended walls make each cell one room (indoor + outdoor halves), so closed-room window claims need a new closed-room row (walls agent told).
- The default glass texture (strength 2, sharpness 6) textures every pool: read pool points as patch means.
