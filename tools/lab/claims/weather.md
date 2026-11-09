# Claims: weather (MSA Lab family, Weather & particles lab, mmp-78u.34)

Written 2026-11-09, BEFORE measuring (expectations first). Plots are in `tools/lab/weather-spec.mjs`
(Lab · Weather, W1-W10). Each row: the claim, its source, the plot, how it is measured, and the band that passes.
Bands are WIDE on purpose: physics gives the baseline, her taste decides inside it ("real numbers make a good
baseline, then tune for looks", 2026-11-04 / 2026-11-09). A miss is classified as an MSA bug, a wrong claim, or a
taste call (decision bead), never silently re-banded.

**Sources.** `Physics` = cited literature. `MSA` = a declaration in the code (species table, param help, headers,
guide). `Author` = Ingram's words (rants archive, quoted by date). `Memory` = an earlier session's measurement.

## Units and constants

- Scale: her maps and this scene are 150 px per 5 ft square = **98.43 px/m** (`core/scene-scale.js`). Speeds are
  reported in px/s AND m/s. V2's harvested numbers assumed 65.6 px/m (100 px squares); the deck fall and the wind
  use the scene's own px/m (`uPixelsPerMetre` from the wind ambient).
- Wind dial: `speed01 x 70 m/s` (`world/wind-scale.js`, WIND_DIAL_MAX_METRES_PER_SECOND). Beaufort: 0.3 / 3.4 / 8 /
  13.9 / 20.8 / 28.5 / 32.7 m/s = calm / gentle / fresh / near gale / strong gale / storm / hurricane; so dial 0.05 =
  3.5 m/s (gentle), 0.2 = 14 m/s (near gale), 0.47 = 32.7 m/s (hurricane), 1.0 = 70 m/s (beyond any surface record
  of sustained wind; she wants "everything from still conditions to a hurricane (wind at 100%)", 2026-11-03).
- Camera: top-down. Vertical fall is seen only through parallax (a drop high above the map sits further from the
  view centre and shrinks toward its landing point as it falls) and through its lateral motion (wind).

## Real-world numbers used (cite these)

| quantity | value | source |
|---|---|---|
| raindrop terminal velocity | 2.0 m/s at 0.5 mm, 6.5 at 2 mm, 8.9 at 4.5 mm; v(D) = 9.65 - 10.3 e^(-0.6 D) | Gunn & Kinzer 1949; Atlas, Srivastava & Sekhon 1973 |
| drop size distribution | N(D) = 8000 e^(-Lambda D) m^-3 mm^-1, Lambda = 4.1 R^-0.21 | Marshall & Palmer 1948 |
| M-P, drops >= 0.5 mm, median D by count | 0.67 mm at 1 mm/h, 0.74 at 5, 0.83 at 25, 0.88 at 50 (v ~ 2.6-3.6 m/s) | computed from M-P (this file) |
| rain rates | drizzle < 1 mm/h; light < 2.5; moderate 2.5-7.6; heavy 7.6-50; violent > 50 | AMS Glossary / UK Met Office |
| drizzle drops | 0.2-0.5 mm, fall 0.7-2 m/s | AMS Glossary |
| snow fall speed | aggregates 0.5-1.5 m/s, rimed / graupel 1-3 m/s | Locatelli & Hobbs 1974 |
| hail fall speed | ~9 m/s (1 cm) to ~30 m/s (golf ball) | standard hail terminal-velocity tables |
| drop response time to wind | tau = v_t / g = 0.2 s (2 m/s) to 0.9 s (9 m/s); snow ~0.1 s | Stokes-regime estimate |
| rain lean in wind U | atan(U / v_t): U 10 m/s, v_t 6.5 -> 57 deg | kinematics |
| lightning flash | 0.2-0.5 s total; 3-4 return strokes typical (1-26); 40-80 ms between strokes | Rakov & Uman, *Lightning* (2003) |
| ground share of flashes | ~25% cloud-to-ground | Rakov & Uman |
| thunder delay | ~3 s per km | speed of sound 343 m/s |
| fog | visibility < 1 km by definition; mist 1-5 km | WMO |

## Rain: the falling body (plot W1, `MapShine.probePrecip`, deck mode)

| id | claim | source | measured how | pass band |
|---|---|---|---|---|
| WX-01 | Each drop's fall speed in deck mode is its terminal velocity: 2-9 m/s, i.e. 197-886 px/s at 98.43 px/m | MSA species `terminalMps [2, 8.9]`, `dropLaw`; Physics | probe: custom.z / ppm, and dh/dt between two reads | p5 >= 1.6 m/s, p95 <= 10 m/s; dh/dt within 15% of custom.z |
| WX-02 | The size/speed mix is plausible for rain: most drops small, few big | Physics (M-P median ~0.7-0.9 mm, 2.6-3.6 m/s); MSA comment "skews the shared draw toward the small/slow end" | probe: median fall m/s | median 2.5-5.5 m/s (SUSPECT: `mass = hash^0.7` skews LARGE: expect median ~8 m/s) |
| WX-03 | Drizzle (precip <= 0.15) is sparse AND fine; heavy rain is dense with fat drops | Physics (drizzle drops 0.2-0.5 mm); MSA `respond.count` pow 2, `length`, `speed` | probe: live count + median speed at precip 0.1 / 0.5 / 1 | count ratio 0.1:1 <= 0.03; median speed at 0.1 lower than at 1 |
| WX-04 | The live count follows precip^2 | MSA `respond.count` pow 2 | probe liveCount at 0.25, 0.5, 1 | within 10% of 0.0625 / 0.25 / 1 x full |
| WX-05 | Rain is born at the cloud deck and lands on the ground: heights span deck..0 evenly (steady state, no sheets) | MSA deck mode; Author 2026-11-03 "originates from the cloud height and falls to the ground to splash" | probe: height histogram | no 10% height band holds > 2x its share |
| WX-06 | Landing points cover the open view evenly: no clumps, holes or lockstep | Author taste (organic, no lockstep); MSA best-of-4 birthplaces | probe: landing-xy grid counts, chi-square / max-min | coefficient of variation of 8x8 cell counts < 0.35 at full rain |
| WX-07 | No drop body falls over a covered texel's landing point (indoor, roof, awning) | MSA Law 3 sky gate (`skyReach = outdoors x (1 - coverAbove)`) | probe: landing points vs sky reach at W2/W4/W5/W8 | 0 bodies inside covered areas beyond a 20 px edge band |
| WX-08 | Rain falls the same over a darkness Region without Suppress Weather (W9) as over open ground | Foundry: Adjust Darkness changes light only | probe: count density inside W9 vs W1 | ratio 0.8-1.25 |
| WX-09 | Inside a Suppress Weather Region over open ground (W3) there is no MSA rain | Foundry semantics; decision mmp-78u.25 (recommendation: honour) | probe density inside vs outside | SUSPECT (stub): today expected ratio ~1 |
| WX-10 | Paused world: no drop moves | Author 2026-11-08 "Everything should pause"; MSA mmp-syo | probe: two reads while paused | max |dh| and |dxy| = 0 |
| WX-11 | Calm air: drops fall straight (lateral speed ~0) | Physics | probe lateral m/s at wind 0 | p50 < 0.5 m/s |
| WX-12 | Lateral speed follows the wind: ~U after relaxation (rain), so lean = atan(U / v_t) | Physics; Memory (lean 47/71/84 deg at 10/28/70 m/s vs real 58/77/85) | probe lateral m/s at dial 0.05 / 0.2 / 0.5 | lateral p50 within 0.6-1.1 x U (rain carry 0.45 is a taste number: flag outside) |
| WX-13 | Wind direction: drops move downwind (the dial's direction), not upwind or sideways | Physics; MSA one-wind | probe mean lateral vector angle vs dial direction | within 20 deg |
| WX-14 | Streaks: length = apparent speed x 0.018 s exposure; short enough not to read as lines across the map | MSA DECK_STREAK_EXPOSURE_SEC; Author 2026-11-03 "very long ... perhaps too strong" | screenshot + streak length from probe speeds | taste: report px lengths at zoom 1 |
| WX-15 | Rain is dimmer at night and under full cloud than in sun; never a bright clear-sky shine at 100% rain under full cloud | Author 2026-11-06 (mmp-toy.1); MSA light.night* | presented-pixel streak contrast at noon clear vs noon overcast vs night | overcast streak contrast <= 0.7 x clear |

## Rain: arrival (splashes, drips)

| id | claim | source | measured how | pass band |
|---|---|---|---|---|
| WX-20 | Splashes are fed by real landings and sit where drops land (same sky gate): none indoors/under roofs | MSA 2fa8cc82; Author 2026-11-03 "link the rain splashes to actual particles" | probe splash positions vs sky reach | 0 inside covered areas beyond 20 px |
| WX-21 | Splash density is per GROUND area: zooming out shows more splashes over more ground, not a change in weather | MSA `splashesPerMegapixel` 42 | probe splash count per world MP at zoom 1 and 0.5 | density ratio 0.8-1.25 |
| WX-22 | Ground splashes are half the size of overhead (elevated) ones | Author 2026-10-27 | probe splash sizes on ground vs roof (Upper view) | ratio 0.4-0.6 |
| WX-23 | Splash direction: random up to 45 deg off the wind on a bell curve | Author 2026-10-27 | probe splash throw angles at wind 0.2 | sd 10-25 deg, |angle| < 50 deg for 95% |
| WX-24 | Roofline drips appear along eaves (W2, W5, W8) in rain and only there | MSA drip-edges (coverAbove boundary) | getPrecipitation().drips + probe | drip points within 30 px of a roof edge |
| WX-25 | Authored `_Drip` dots drip (W7) | MSA `_Drip` mask (#316) | status authoredDrip + probe | built, points ~5 clusters |
| WX-26 | Drips keep going briefly after rain stops, then stop (no endless dripping) | MSA status comment ("still dripping four minutes after the rain" is the failure) | status over time after precip -> 0 | stop within 2 min |
| WX-27 | Rain and drips are one liquid colour | Author 2026-10-27 | presented colour of streak vs drip | hue within 15 deg |

## Snow (plot W1, W2, W4)

| id | claim | source | measured how | pass band |
|---|---|---|---|---|
| WX-30 | Flakes fall at 0.5-1.5 m/s (49-148 px/s) | Physics; MSA `terminalMps [0.5, 1.5]` | probe dh/dt | p5 >= 0.4, p95 <= 1.8 m/s |
| WX-31 | Flakes drift with the wind at ~wind speed (tau ~0.1 s) | Physics; Memory (snow was 1.7x wind, now 1x) | probe lateral vs U | 0.8-1.15 x U |
| WX-32 | Flakes are ragged clumps, never circles or star shapes; sizes skewed small with a long tail | Author 2026-11-03; MSA clump shape | screenshot crop | taste |
| WX-33 | No flake lands indoors / under roofs; no snow mantle accumulates there | MSA Law 3, mantle | probe + mantle status | 0 |
| WX-34 | Light snow = gentle wonderland; heavy + wind = whiteout | Author 2026-11-03 | screenshots at 0.2/calm and 1/0.5 | taste |

## Fog, mist, clouds, cloud shadows

| id | claim | source | measured how | pass band |
|---|---|---|---|---|
| WX-40 | Cloud cover 0: no cloud shadow anywhere | Physics; mmp-6ib | probe illum over 60 s at W1 points | variation < 2 levels |
| WX-41 | Cloud shadows drift with the wind direction at a cloud speed (not ground wind) | Physics (clouds ride faster upper winds); MSA cloudDriftMetresPerSecond | probe a shadow edge over time | direction within 20 deg of wind |
| WX-42 | Fog mood: ground mist present outdoors, absent indoors (W2/W4) and feathered at walls | MSA mmp-63o.1 ground-mist gate | probe presented over open vs indoor at fog 0.7 | indoor change < 3 levels |
| WX-43 | Mist and storm fog are lit by the scene light (dark at night, golden at dusk) | MSA (lit by buf:scene.illum) | probe at noon/dusk/night | mist never brighter than the lit ground at night |
| WX-44 | Haze subtle, never "pea soup" at default | Author taste (grades/haze subtle) | probe contrast loss on W1 ruler at fog 0.7 | ruler contrast kept >= 40% |

## Lightning (night, Storm)

| id | claim | source | measured how | pass band |
|---|---|---|---|---|
| WX-50 | A flash lasts 0.2-0.5 s with 1-4 strokes 40-80 ms apart | Physics; MSA lightning-storm.js | getStormLightning() schedule + probe illum time series | inside the band |
| WX-51 | Strike light lights open ground and pours through windows (W2 pool), not through walls or roofs | MSA 79d62406; Author taste (nothing leaks through walls) | probe roomMid vs windowPool vs field during a strike | roomMid change < 10% of field change |
| WX-52 | All clients agree on strike times | MSA (server-clock hash) | n/a on one client; read schedule twice | identical |
| WX-53 | Lightning pauses with the world | Author 2026-11-08 | paused schedule | no new strikes while paused |

## Transitions and timing

| id | claim | source | measured how | pass band |
|---|---|---|---|---|
| WX-60 | 0 -> 100% rain and wind over a 1 min fade is smooth: no strobing, no thrash | Author 2026-10-27 | probe liveCount + lateral speed sampled every 2 s | monotone, no step > 15% of range |
| WX-61 | Rain stops cleanly: no sheet of drops left hanging, no pop | Physics | probe count after precip -> 0 | falls to 0 within one fall time (deck height / v) |

## Plots needed (all in weather-spec.mjs)

W1 open field (speeds, counts, coverage, wind, clouds); W2 room + window + roof (indoor gate, window light,
drips, lightning through windows); W3 Suppress Weather over open ground; W4 mask-only black; W5 awning (roof over
white ground); W6 soft mask edge; W7 `_Drip` dots; W8 alley (narrow open gap between roofs); W9 darkness Region
without Suppress; W10 scene corner.

## Suspects from code reading (before any measurement)

- WX-02: `precip-runtime.js#bodyConstants` draws `mass = hash^0.7`, which skews toward LARGE drops (mean 0.59), while its
  comment says it skews small. Expected median drop 3 mm / 8 m/s vs real ~0.8 mm / 3 m/s. Visual weight question:
  fewer, faster drops vs many slow fine ones.
- WX-03: the drop-size mix does not change with precip: drizzle drops are as fat and fast as a downpour's.
- WX-09: Suppress Weather is a stub (`foundry/scene-regions.js`, decision bead mmp-78u.25).
- WX-40: mmp-6ib (cloud shadows at cover 0).
