# WEATHER MANAGER — one sky, one truth

**Status:** **DESIGN ONLY. NOTHING BUILT.** Authored 2026-08-16 (Fable, per the Covenant — this is a plan-creation act). Owns Pillar 9's missing keystone: the *weather owner* that `world/environment.js` and `Sky.md` have both flagged as "the last acknowledged gap in the env snapshot" since 2026-07-23.

**Prerequisite reading:** `Environment.md` (the snapshot is the call sheet; time is UPSTREAM of weather, never inside it — V2's clock lived *inside* `WeatherController.js` and that hierarchy entanglement is the disease this module must not reintroduce), `Clouds.md` (the locked cloud-field design this manager FEEDS), `Sky.md` (key/fill/veil — the sky-light skeleton this extends), `Sun-Shadows.md` + `effects/shadow-access.js` (the atmospheric shadow handle), `Grade.md` (the environmental grade reads weather; it is not redesigned here), Testament Pillar 9.

---

## 0. The brief

### 0.1 What the author asked for (2026-08-16)

> *"…the single source of truth for values that lots of effects will use… easy controls which can dramatically change the scene… transition from any one weather state realistically to a different one… allow time of day to influence the likelihood of weather events. I'd like two modes, one where the GM says exactly the conditions they want and the weather stays exactly as the GM authors it. The second mode allows the GM to set the type of location and a system would randomly walk between a realistic set of states… magical or event based things like ash clouds raining ash on a scene… a good UI for this as selecting the weather is going to be one of the fun controls… full permission to rethink how the astrolabe looks but I'd still like a circle for selecting the hour… a 'sky light' effect which allows us to change the quality of the lighting of the exterior of the map during day and night. This needs to work together with cloud shadows… moon light, northern lights, magical illumination, volcanic light flares… We don't need an accurate physics model, we just need to understand what the major levers are for creating different moods and create a strong system for evolving between them."*

And, opening the same message: *"reproduce the contours and shapes of real cloud patterns and place those cloud patterns into categories of weather."*

### 0.2 Coverage map — every ask, its section

| The ask | Where answered |
| --- | --- |
| Real cloud contours/shapes → weather categories | §3 |
| Single source of truth, many effect consumers | §1, §2, §10 |
| Easy GM controls, dramatic changes | §9 |
| Realistic any→any transitions | §4 |
| Time of day influences weather likelihood | §5.3 |
| Mode 1: authored, stays exactly as set | §5.1 ("Director") |
| Mode 2: location type + realistic random walk | §5.2 ("Almanac") |
| Magical / event things (ash rain, etc.) | §6 |
| UI in/around the astrolabe, hour circle kept | §9 |
| Sky light: exterior light quality, day & night | §7 |
| Works with cloud shadows (softness by ToD, offset by sun) | §8 |
| Moonlight, aurora, magical, volcanic patchy light | §6.3, §7 |
| Levers-not-physics; strong evolution system | §4, §7.4 |

---

## 1. The shape of the system, and its five laws

```
frame clock ──→ day-clock (todHour) ──→ sun = f(hour)        moon = f(hour, phase)
                       │                      │                    │
                       ▼                      ▼                    ▼
              ╔═══════════════════╗    ┌──────────────────────────────────┐
              ║  WEATHER MANAGER  ║──→ │ SKY ILLUMINANT COMPOSITOR (§7)   │
              ║ Director│Almanac  ║    │ key set → dominant key           │
              ║ targets → eases   ║    │ fill · veil · patchy overlays    │
              ║ events overlay    ║    └──────────────────────────────────┘
              ╚═══════════════════╝                  │
                       │          ┌──(setpoints)──→ wind authority (owns its own dynamics)
                       ▼          ▼
        env snapshot: env.weather · env.moon · env.skyKey   ← ONE call sheet, rebuilt each frame
                       │
   ┌─────────┬─────────┼──────────┬───────────┬────────────┬───────────┐
 clouds    shadow    sky-      grade (env   particles    water /     windows
 (field)   -access   access    stage)       (precip)     specular    (ceiling,
                                                          (wetness)   cloudFactor)
```

**LAW 1 — Two modes, ONE write path.** Director and Almanac both produce the *same state vector* through the *same* target→ease pipeline. The mode decides only WHO moves the sliders (the GM's hand or the walk); no consumer can tell which mode is active, and no axis exists in one mode but not the other. This is `feedback_mode_forks_silently_drop_features` applied before the fork can be born — the exact discipline that keeps Clouds.md's zoom regimes a ladder, applied here to modes.

**LAW 2 — Consumers read AXES, never preset names.** `env.weather.preset` stays (it already exists) as a *label of intent* for UI and diagnostics. No shader, no effect, no handle ever branches on it. An archetype is a *point in axis space*; if a consumer needs to know "is it storming," it reads `stormActivity01`, which is a number that can also be 0.3.

**LAW 3 — The manager owns WEATHER STATE and nothing else.** Time stays in the day-clock (upstream, per `Environment.md` — the manager *reads* the hour, never advances it). Wind keeps its own authority (`world/wind-*`): the manager writes wind a *setpoint* (target speed/direction/gust energy) and wind's own accelerate-fast/decelerate-slow dynamics do the rest. Darkness stays where the darkness-authority work put it. One new owner, zero stolen deeds.

**LAW 4 — Derived never overwrites authored.** Wetness is an integrator over precip history; precipKind is derived from temperature unless forced; sky-light outputs are pure functions. Derived values live in their own read-only slots. An authored `auto` is a *configured enum value*, never a magic zero (`feedback_derived_zero_collides_with_configured_zero` — 0 is a legal wetness).

**LAW 5 — Everything defaults NEUTRAL.** Manager on + Director + archetype `clear` + no events ⇒ every output equals today's `DEFAULT_WEATHER` and the frame renders exactly as it does now. The feature defaults ON (`feedback_default_on_new_features`) *because* its default state is a mathematical no-op; the sky-light *look* remains behind the existing `realism01` lever whose 0-default is separately locked (`sky-access.js`'s parity argument, not relitigated here).

---

## 2. The state vector

### 2.1 Authored axes (targets — set by the GM's hand or the Almanac's walk)

| Axis | Range | Meaning | Consumers (today → future) |
| --- | --- | --- | --- |
| `cloudCover01` | 0..1 | clear → overcast | shadow-access, sky-access, env grade **today**; cloud field, window ceiling future |
| `cloudType01` | 0..1 | 0 cirrus · 0.5 cumulus · 1 stratus — **exactly Clouds.md's one dial** | cloud field (future) |
| `cloudAltitudePx` | px | deck altitude — Clouds.md's ONE knob (offset, softness, parallax, drift, sky hidden) | cloud field (future) |
| `cloudScalePx` | px | feature size (streak length / cell size) | cloud field (future) |
| `precip01` | 0..1 | precipitation intensity | particle archetypes (future), wetness integrator (day one) |
| `precipKindAuthored` | enum | `auto` \| `rain` \| `snow` \| `sleet` \| `hail` \| `ash` \| `embers` — **closed list** | manager's own derivation (day one) |
| `windSetpoint01` + `windSetpointDeg` | 0..1, deg | handed to the wind authority as its ambient target | wind (existing) |
| `fogDensity01` | 0..1 | visual mist. **NEVER Pillar 11's information fog. Never vision.** | mist effect (future), sky veil (day one) |
| `stormActivity01` | 0..1 | storminess: lightning rate, gust energy, rumble hooks | lightning scheduling (future), wind gust setpoint (existing) |
| `temperature01` | 0..1 | cold → hot | precipKind + wetness dry-rate derivations (day one), biome plausibility |
| `wetnessAuthored` | `auto` \| 0..1 | GM override of the wetness integrator | manager (day one) |

**⚠️ The unconsumed-axis rule:** an axis SHIPS only in the build slice that wires its first real consumer (§13). Until then it exists in this table, not in code — `feedback_unconsumed_api_rots_silently` is a named disease and a weather system is its natural host.

### 2.2 Derived (read-only — the manager computes these every tick)

| Derived | From | Rule |
| --- | --- | --- |
| `wetness01` | precip history, temperature | integrator: wets in ~2 min of steady rain; dries over ~20–40 min scaled by temperature and cover (V2's own good idea, kept: wetting fast, drying slow, and it was *derived*, never authored) |
| `precipKind` | `precipKindAuthored`, temperature, events | `auto` ⇒ `temperature01 < 0.25 ? snow : rain` (one threshold, one place); events may override (ash storm ⇒ `ash`) |
| `env.moon` | hour, phase, config | §7.2 |
| `env.skyKey` | sun, moon, events, weather | the ONE dominant directional light — §7.3. Shadow-access reads THIS, not `env.sun`, once §7 lands |
| sky light block | all of the above | key/fill/veil strengths+colours, patchy overlay list — §7 |
| `env.weather.hasOwner` / `ownerVersion` | manager liveness | the `windHandle.hasBake` contract: *"cover = 0 because the sky is clear"* must be distinguishable from *"cover = 0 because nobody wrote it"* (`feedback_seam_default_hides_unwired`) |

### 2.3 Events (the overlay layer — §6)

Events are NOT states. They compose OVER the base state with per-axis operations, each with its declared neutral (`feedback_blend_neutral_element_is_per_blend`): `max` for cover-pushing events, `set` for precipKind, `add` for illuminants. Schema in §6.1.

**"That's a lot of data" — no, it isn't.** The *state* is ~a dozen numbers. The *recipes* are rows in two small tables (archetypes §3.2, biomes §5.2) — a few KB of validated JSON-shaped data, closed lists throughout (`feedback_category_string_must_be_in_closed_list`). Only the CONSEQUENCES are big, and those live in the effects that already exist.

---

## 3. Real skies, reproduced — contours, shapes, categories

### 3.1 What actually distinguishes real cloud forms from directly above

The ten classical genera collapse, for an orthographic bird's-eye renderer, into **five procedural levers** — this is the whole "reproduce real contours" problem, and Clouds.md's field already owns four of them:

| Lever | What it encodes | Real-sky signature |
| --- | --- | --- |
| **Spatial spectrum** (octave weights, basis) | blob vs streak vs sheet | cumulus = compact Worley billows; cirrus = long anisotropic fBm streaks; stratus = near-DC low-contrast sheet |
| **Coverage + cell polarity** | figure/ground | scattered cumulus = *open cells* (cloud islands in clear sky); stratocumulus = *closed cells* (cloud sheet with clear holes). The polarity flip as cover crosses ~0.6 is what makes a filling sky read real instead of "the blobs got bigger" |
| **Edge hardness** | the coverage smoothstep width | cumulus crisp on the sun side; cirrus feathered everywhere |
| **Anisotropy / shear** | domain warp along wind | cirrus streams with the high wind; cumulus tops smear slightly DOWNWIND (a cheap warp of only the high octaves) — the single cheapest "this is a real sky" tell |
| **Altitude** | Clouds.md's one knob | high = soft faint wide shadows, fast drift; low = crisp dark near shadows, slow |

Everything above is a *recipe input* to Clouds.md's existing `cloudType01`/`cover01`/`altitudePx`/`scalePx` surface. Three capabilities the type ramp will need that Clouds.md implies but does not spell out — recorded HERE as requests against the cloud ladder, not silent edits to a locked design: **(a)** the cell-polarity flip tied to cover, **(b)** the downwind smear warp on high octaves, **(c)** a second deck for the anvil story below. All three live inside the type-ramp/tops shader; none touches the shadow path's cost class.

### 3.2 The archetype table — weather categories as cloud recipes

The GM's vocabulary. Each row is a point in axis space that reproduces a real sky. **~12 archetypes, closed list**; biomes weight them, the shelf (§9) displays them, nothing branches on them (LAW 2).

| Archetype | Real sky | type01 | cover01 | altPx | scalePx | precip | fog | storm | wind bias | The shadow story |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `clear` | cloudless | — | 0 | — | — | 0 | 0 | 0 | calm | none — hard architectural shadows only |
| `high-veil` | cirrostratus | 0.05 | 0.35 | 3000 | 4200 | 0 | 0 | 0 | mild | barely-there wide soft dimming; halo-milk light |
| `streaks` | cirrus | 0.0 | 0.25 | 2800 | 4000 | 0 | 0 | 0 | brisk aloft | faint fast-drifting soft bands |
| `fair-cumulus` | cumulus humilis | 0.5 | 0.35 | 1400 | 1100 | 0 | 0 | 0 | mild | **the money look** — crisp dark island shadows sailing the map |
| `mackerel` | altocumulus | 0.4 | 0.5 | 1900 | 350 | 0 | 0 | 0 | mild | fine dappled grain, medium soft |
| `broken` | stratocumulus | 0.7 | 0.65 | 900 | 700 | 0 | 0 | 0.1 | mild | closed cells: moving HOLES of light in shadow (contrast peak — cover≈0.5–0.65 is the interesting weather, V2's own finding) |
| `overcast` | stratus/altostratus | 0.9 | 0.95 | 700 | 5000 | 0 | 0.05 | 0 | low | no cloud shadows — it is ALL shadow; architectural shadows fade to 15% (shadow-access already does this) |
| `drizzle` | nimbostratus, light | 0.95 | 1.0 | 550 | 5000 | 0.3 | 0.15 | 0 | low | flat silver gloom, wet sheen rising |
| `steady-rain` | nimbostratus | 1.0 | 1.0 | 500 | 5000 | 0.7 | 0.2 | 0.15 | med | dark, wetness saturates, glints die |
| `thunderstorm` | cumulonimbus | 0.6 | 0.8 | 900 **+ deck2 cirrus 2800, downwind** | 1600 | 0.85 | 0.1 | 0.9 | gusty, veering | the anvil story: dark low deck + streaked high blowoff offset downwind; flash events |
| `snow` | nimbostratus, cold | 0.95 | 0.9 | 600 | 4500 | 0.6 | 0.25 | 0 | low | bright-flat; precipKind derives `snow` from temperature — no separate archetype table for winter |
| `fog` | stratus at ground | 1.0 | 0.7 | 300 | 6000 | 0 | 0.85 | 0 | calm | shadows nearly gone; veil dominates; burns off mid-morning in the Almanac |
| `gale` | dry windstorm | 0.3 | 0.3 | 2200 | 2600 | 0 | 0 | 0.3 | **high** | fast ragged streak shadows — motion IS the look |

The `thunderstorm` row is why deck 2 (Clouds.md rung 2) earns its place: a storm read from above is *two* stories — the dark cell and its cirrus anvil streaming downwind — and no single-deck recipe tells it.

---

## 4. Transitions — nothing ever steps

### 4.1 The ease engine

Every authored axis moves toward its target through a per-axis slew with its own time constant — V2's one universally-praised behaviour ("clouds never pop", `SPRITE_FADE_DURATION_SEC = 10`) generalised to the entire weather state:

| Axis | τ up | τ down | Why asymmetric |
| --- | --- | --- | --- |
| cover | 120 s | 150 s | skies build slightly faster than they scrub clean |
| type / altitude / scale | 240 s | 240 s | a sky does not flip genus quickly; slowest movers |
| precip | 45 s | 90 s | rain arrives brisk, tapers long |
| wind setpoint | 20 s | 90 s | **V2's accelerate-fast/decelerate-slow, kept verbatim** (`cloud-wind-advection.js` asymmetry — the thing that made V2 feel like weather) |
| fog | 300 s | 200 s | creeps in, burns off a little faster |
| storm | 60 s | 60 s | |
| temperature | 600 s | 600 s | thermal mass |

**Clock ruling (⚠️ the named trap lives here):** eases run on **real time** — they are presentation pacing, same family as V2's 10 s sprite fade. The Almanac's WALK runs on **game time** (§5.4). UI throttles use `realMs`, never `tMs` (`feedback_throttle_on_sim_clock_latches_when_paused`). And because a GM can crank `rateHoursPerMinute` to 60, the manager enforces a **real-time floor between target changes (~45 s)**: time-lapse shows sped clouds via drift, never strobing weather.

A GM-facing **transition-speed** control scales all τ: `instant` (scene setup) · `brisk` (×1, Director default) · `realistic` (×3, Almanac default).

### 4.2 Fronts — the realistic shape of a big change (ladder rung, not slice 1)

Real weather doesn't crossfade in place; it *arrives from a direction*. Two canned **front scripts** — sequences of walk steps with shortened dwells — give the Almanac its most authentic texture at zero architectural cost:

- **Warm front** (the classic wedge, compressed): `streaks → high-veil → overcast → steady-rain` over tens of game-minutes. The sky *announces* the rain an hour early — GMs get dramatic irony for free.
- **Cold front:** `(anything) → thunderstorm → gale → clear`, wind veering, temperature stepping down. Violence, then a rinsed sky.

A later rung may make the boundary SPATIAL for the cloud field only — state A behind a moving line, state B ahead, blend band at the line (the field is analytic in world space; evaluating two recipes inside a bounded band is cheap and transition-only). Scalar axes cannot be spatial (they feed scene-wide handles), so they ramp in time matched to the front's crossing. Recorded as the dramatization rung; the temporal ease is the always-on base mechanism.

---

## 5. The two modes

### 5.1 DIRECTOR — the GM's exact sky

The GM clicks an archetype (or moves any axis slider directly); targets set; eases run; **state then holds forever**. No walk, no drift, no events the GM didn't trigger. Loading a scene restores the authored state exactly. This is the mode the existing astrolabe Cloud slider becomes a citizen of: that slider is now a *pin-write into the manager's cover axis* — same gesture, same feel, one authority behind it instead of a debug lever.

### 5.2 ALMANAC — a living sky for a chosen place

The GM picks a **climate** (biome), optionally a season and a **volatility** (dwell-time scale), and the sky walks itself. A biome is a *data row*, not code:

```
{ id, label,
  archetypeWeights: { clear: 0.5, fair-cumulus: 0.3, ... },     // long-run occupancy
  transitions: [ { from, to, weight, todCurve } ],               // the graph, closed ids
  dwellHours:  { archetype: { min, mean, max } },
  frontScripts: [ 'warm-front', 'cold-front' ] with rates,
  eventRates:  { aurora: perClearNight, ... },
  tempByHour01: [...24] or a named curve, seasonMods?, clamps? }
```

Ship ~10: `temperate-coast`, `continental-plains`, `desert`, `tropical-monsoon`, `boreal-tundra`, `high-mountain`, `moorland-mire`, `volcanic-waste`, and two magical proofs-of-data: `feywild-glade` (shimmer-event weight, petal-fall precip skin), `shadowfell-verge` (gloom clamp: cover floor 0.6, permanent veil). Magical biomes being *plain rows in the same table* is the extensibility claim, demonstrated.

**The walk** is semi-Markov: on entering archetype A, draw a dwell from `dwellHours[A]`; when it expires, choose the next from `transitions[from=A]` weighted by `weight × todCurve(hour) × seasonMod`, clamp-filtered. Adjacency lives in the graph — `clear → fair-cumulus → thunderstorm` is a path; `clear → blizzard` is not an edge, so the "realistic set of states" property is structural, not tuned.

**The GM keeps hands on the wheel:** clicking an archetype in Almanac mode *forces it now* (the walk adopts it as current and redraws dwell — "the Almanac takes requests"); dragging any axis slider **pins** that axis (pin icon shown, one click to release); biome `clamps` bound everything (V2's GM-clamped Dynamic Weather bounds, kept).

### 5.3 Time of day drives likelihood — the named curves

Transition weights multiply by ToD curves, closed list, each encoding a real mechanism (levers, not physics):

| Curve | Shape | Real mechanism it fakes |
| --- | --- | --- |
| `convectiveAfternoon` | peaks 14–18 h | surface heating → cumulus → storms (continental/tropical) |
| `radiativeDawn` | peaks 04–08 h, dies by 10 | overnight cooling → dawn fog, morning burn-off |
| `nocturnalCalm` | trough 22–06 h | convection dies with the sun; wind lays down |
| `monsoonClock` | hard peak ~15–17 h | the near-daily tropical deluge |
| `flat` | 1 everywhere | weather that doesn't care what time it is |

So: `desert` weights `clear` heavily with `convectiveAfternoon` on its rare storm edge; `moorland-mire` runs `radiativeDawn` on fog edges; `tropical-monsoon` fires `monsoonClock` almost daily. **Aurora `eventRates` gate on `darkness01 × (1 − cover01)`** — they simply cannot fire into a bright or overcast sky, and that emergence needs no special case (§6.3).

### 5.4 Determinism, clocks, and the forecast

The walk integrates **game time** (frozen clock ⇒ frozen weather — a paused session must not drift; this is the integrator pattern, not the sim-time-throttle latch, and the doc says so explicitly so nobody "fixes" it). Seeded RNG (`sceneSeed + epochIndex`): same seed + same clock path ⇒ same weather. Two payoffs: **replayable bug reports**, and the **forecast** — running the walk ahead without applying it is free, which the UI spends in §9. GM edits/pins invalidate the future; the forecast recomputes and says so.

---

## 6. Events — the magical layer

### 6.1 The overlay model

```
{ id, kind,                                  // closed list below
  intensity01,
  envelope: { attackSec, sustainSec | 'held', releaseSec },
  overrides: [ { axis, op: set|max|min|add|mul, value } ],   // op declares its neutral
  illuminant?: { rgb, strength01, patchScalePx, driftDegPerHour },  // §6.3 primitive
  precipKindOverride?, particleArchetype?, a11yFlash?: boolean }
```

Events stack over the base state (Director OR Almanac — overlays are mode-agnostic, LAW 1). Each is an envelope, so *everything* about an event is still "state evolving continuously" — there is no event bus, no callbacks; consumers keep reading the snapshot and see the ash arrive as numbers ramping. Flashes are just fast envelopes.

### 6.2 Built-ins (closed list)

| Kind | What it does |
| --- | --- |
| `ash-storm` | precipKind→`ash`, cover→max(cover, 0.85), type→stratus, sodium-gloom sky tint (§7.4), particle archetype `ashfall` |
| `aurora` | patchy illuminant, green→violet ramp, slow band drift; **fill-only — casts no shadows, correctly** |
| `blood-moon` | moon tint + strength override |
| `eclipse` | sun key strength → ~0 over its envelope; the Ring's sun and moon markers converge (§9) — the astrolabe *shows* the mechanics |
| `volcanic-unrest` | warm patchy under-glow illuminant + intermittent fast-attack `flare` sub-events + optional `embers` precip |
| `mana-storm` | the generic: GM-coloured patchy illuminant + any overrides — the "custom" door |
| `gloom` / `radiance` | magical darkness/brightness: veil and fill overrides, no precip |
| `sky-flash` | the storm's lightning flash: fill+veil spike over ~300 ms envelope. **Flips `a11y.photosensitive` handling ON — the full-screen flash is exactly what that flag protects.** Testament already names this reborn WeatherLightning |

### 6.3 ⭐ One primitive: the PATCHY SKY ILLUMINANT

Aurora, volcanic glow, mana-light and any future "the sky itself is patterned light" are **one mechanism with presets** (the grade engine's one-primitive-two-scopes discipline): an additive contribution to the sky FILL, spatially modulated by a 1–2-octave analytic world-space noise mask (Clouds.md's exact representation discipline — zero textures, drift wrapped modulo period, same azimuth convention). Its visibility term is `strength01 × (1 − cover01)^2 × darkness01` — **each factor printed in the status report** (`feedback_count_silent_preconditions`: a long product with an invisible zero ships an invisible feature; the windows effect already paid this tax once). Clouds drifting over an aurora dim it *patchily* by the same cover the shadow path samples — one field, another multiplying consumer, no new machinery.

---

## 7. Sky light — the illuminant compositor

### 7.1 The model

`Sky.md`'s skeleton — **KEY** (directional disc) · **FILL** (dome) · **VEIL** (additive scatter, the desaturator) — generalised one step: the sky is a small SET of illuminants composited into those same three channels, then attenuated by weather. Nothing downstream changes shape; `sky-access.js` stays THE door and grows inputs.

| Illuminant | Channel | Source |
| --- | --- | --- |
| Sun | key #1 | `world/sun.js` (exists) |
| Moon | key #2 | `world/moon.js` (NEW — §7.2) |
| Patchy events (aurora/volcanic/mana) | fill (+veil tint) | §6.3 primitive |
| Sky-flash | fill+veil spike | event envelope |
| Cloud/fog | attenuator | cover kills keys ×(1−cover), boosts fill (+0.6·cover — the shipped constant), raises veil; fog raises veil hard |

**The fill is never gated on the key** (`feedback_environment_term_gates_wrong_thing` — the shipped-invisible-specular lesson, inherited as law).

### 7.2 The moon — the missing night key

Today `grep -r "moon" src/` returns nothing, while the Bug-Tracker's window-ceiling entry already *needs* one ("night time lighting… 'moon light' so that we can have the window lights show up at night as long as it's not too cloudy"). Spec, deliberately non-astronomical: azimuth = sun azimuth + 180° + `moonLagDeg` (default 0); elevation mirrors the sun's night arc; `moonPhase01` scales strength; colour cool slate-blue; strength ~0.08 of the sun's key. Waxes/wanes on a slow calendar or GM-set — a *mood dial wearing a moon costume*, which is exactly the license the brief grants. Its light contribution rides the `realism01` gate like every sky-light term (parity preserved); its *direction* feeds shadows whenever sun-shadows are on (they're MSA-additive; no parity constraint).

### 7.3 ⚠️ The dominant-key handover — shadows at twilight

Shadow-access must keep receiving ONE direction (its whole contract: every caster, zero new sliders). With two keys the rule is: **dominant key by strength; never blend angles** — a blended azimuth points at a light that does not exist (the one-number-two-meanings family, angular edition). The direction *steps* at the dominance flip, and the step is invisible **by construction**: at the flip both keys are weak, and the existing twilight strength-fade (night floor ~12%, already shipped in shadow-access) has the shadows nearly gone. Strength crossfades; angle snaps under cover of dusk. `env.skyKey = { azimuthDeg, elevationDeg, strength01, source: 'sun'|'moon'|'event' }` is the one derived slot every directional consumer (shadow-access, cloud field, window daylight tint, water glint, specular lobe) reads from now on.

### 7.4 The mood table — the major levers, named

Four levers make every exterior mood: **key:fill ratio** (harshness), **key↔fill hue distance** (colour richness — two differently-coloured lights across one frame is where a clear day's chroma comes from, already `sky-access.js`'s insight), **veil** (desaturation/haze), **patchiness** (drama). Reference rows:

| Mood | key | fill | veil | patchy | Reads as |
| --- | --- | --- | --- | --- | --- |
| Harsh noon | 1.0 warm-white | 0.35 blue | 0.05 | — | hard short shadows, maximum chroma |
| Golden hour | 0.8 amber, low elev | 0.3 cool | 0.15 warm | — | long shadows, honeyed light |
| Silver overcast | 0.1 | 0.8 grey | 0.35 | — | shadowless, quiet, desaturated |
| Moonlit clear | 0.08 slate-blue | 0.05 deep blue | 0.02 | — | dim, crisp, faint shadows — windows glow |
| Storm dark | 0.05 | 0.45 blue-grey | 0.3 | flash spikes | pre-flash gloom, then the world blinks white |
| Sodium gloom | 0.2 dull orange | 0.3 brown-grey | 0.5 warm-dark | volcanic flares | ash on the wind, embers below the clouds |
| Eldritch veil | ~0 | 0.15 green-violet | 0.1 | aurora bands | patchy living light, no shadows at all |

These are *recipes over the compositor*, not new machinery — the archetypes and events land on them automatically.

---

## 8. Cloud shadows × sky light — what's emergent, what's new

Almost everything the brief asks for here **already falls out of shipped or locked designs**; this section exists to prove no second model is being built:

- **Offset moves as the sun moves:** `h / tan(elevation) · keyDirXY` — the law both `sun-shadows.js` and Clouds.md already state. With `env.skyKey`, the SAME formula serves the moon at night. Zero new code in clouds.
- **Softness by time of day:** penumbra ∝ altitude and widens as elevation drops ⇒ *octave count falls* (Clouds.md §1.2 — softer is cheaper). Dawn cloud shadows are long, soft, and less GPU work, in that order, for one reason.
- **Night:** moon-key strength ~0.08 ⇒ cloud shadows are faint by arithmetic; under `aurora`-only skies there is **no key**, so no directional cloud shadow — while clouds still patchily dim the aurora fill (§6.3). Both correct, both free.
- **Overcast:** cover kills the key ⇒ cloud shadows AND architectural shadows fade together through the same shadow-access multipliers that shipped in July. The manager just finally *drives* them.

---

## 9. The astrolabe, reimagined — four regions, one instrument

Selecting weather should feel like choosing a *sky*, not filling a form. The circle stays — and the instrument grows around it. Named regions so future UI work shares a vocabulary (**names author-confirmed 2026-08-16**: Director/Almanac modes; Ring/Face/Horizon/Omens regions):

```
        ╭──────────────────────────────╮
        │        THE RING              │  hour circle — KEPT, interaction unchanged.
        │   ☀ sun marker   ☾ moon      │  Moon marker rides anti-phase; an eclipse
        │      ┌────────────┐          │  event visibly converges the two.
        │      │  THE FACE  │          │  Dial centre = live animated sky swatch
        │      │ (live sky) │          │  rendering the CURRENT recipe (cover, type,
        │      └────────────┘          │  precip streaks) — the state, glanceable.
        │   ↗ wind arrow (existing)    │
        ╰──────────────────────────────╯
        ┌──────────────────────────────┐
        │ THE HORIZON — archetype shelf│  One click = that sky (Director sets it;
        │ [☀][🌤][☁][🌫][🌧][⛈][❄][💨] │  Almanac adopts it). Current = lit ring.
        ├──────────────────────────────┤
        │ mode ◐ Director | Almanac    │  Almanac row: biome ▾ · volatility ─○──
        │ forecast: ☁ → 🌧 in ~40 min  │  · transition-speed · 🎲 surprise-me
        ├──────────────────────────────┤     (hides the forecast for GMs who want
        │ THE OMENS (collapsed tray)   │      to be rained on unwarned)
        │ [aurora][ash][eclipse][🌕][+]│  Active events = chips with envelope
        └──────────────────────────────┘  progress + dismiss.
```

- **The forecast strip is the Almanac's killer feature** — free because the walk is seeded/deterministic (§5.4). **Visible by default (author-ruled 2026-08-16)**; the 🎲 surprise-me toggle is the opt-out. Frozen clock shows "—" honestly.
- **Pin-on-touch:** dragging Cloud/Wind (which stay, as quick sliders) in Almanac mode pins that axis with a visible 📌; the walk steers around pins. One action, one control.
- **ToD-likelihood arcs** (optional rung): in Almanac mode the Ring can tint its storm-prone hours faintly — the biome's character made visible on the hour circle. ROH toggle; default off to keep the Ring clean.
- **FOH:** Ring, Face, Horizon, mode+forecast, Omens triggers, quick sliders, transition-speed. **ROH:** full axis inspector with pins, biome picker + volatility/season/seed, event envelope tuning, per-axis τ, the state-vector JSON, forecast timeline. FOH ≠ ROH per the standing rule; nothing appears in both dressed differently.
- Existing folded controls (sky-light realism, atmosphere/grade strength, time rate, clock mode) stay folded — they are look-tuning, not weather state.

---

## 10. Architecture — files, ownership, wiring

| Piece | File | Notes |
| --- | --- | --- |
| Manager core | `world/weather.js` (NEW) | pure: state, ease engine, walk, events, derivations. `createWeatherManager(...)` + `tick({dtRealSec, dtGameHours, hour, darkness01})`. Node-tested exhaustively — it's the most CPU-twin-friendly module this project will ever get |
| Biome + archetype tables | `world/weather-data.js` (NEW) | frozen data rows, closed-list validated at load; **fail-open to `clear` + loud report** on any bad row (gate polarity: a broken table must never storm-lock a scene — but it must SHOUT, `feedback_required_masks_fail_loud` posture) |
| Moon | `world/moon.js` (NEW) | tiny sibling of `sun.js` |
| Illuminant compositor | `world/sky-illuminants.js` (NEW) | pure f(sun, moon, weather, events) → key/fill/veil/patchy + `skyKey`; called inside the snapshot build like `computeSun` |
| Snapshot | `world/environment.js` (EXTEND) | `DEFAULT_WEATHER` grows the §2 axes (additive, neutral defaults); `env.moon`, `env.skyKey` join; `hasOwner`/`ownerVersion` |
| Persistence | `world/weather-settings.js` (NEW) | sky-settings' validate-per-field pattern. **⚠️ `cloudCover01` RELOCATES here from `sky-settings.js`** — one field, one registry (`feedback_shared_field_two_meanings_two_registries`): sky-settings keeps time+look (todHour, rate, realism, gradeEnv); weather-settings owns every weather axis. Legacy read-fallback once, write path single, migration noted loudly in both files |
| UI | `ui/astrolabe.js` (EXTEND) | §9 regions; archetype shelf renders from the closed table |
| Consumers | — | **pull from the snapshot** — deliberately NO dispatch list of weather consumers anywhere (`feedback_hand_maintained_dispatch_lists_forgets_new_effects`) |
| Diagnostics | env diagnostics + status reports | `weatherSource` (joins `cloudSource`), mode, archetype, pins, active events, each patchy-illuminant visibility FACTOR (§6.3), forecast head. A weather block lands in perf-run-full's env section — `feedback_diagnostics_must_land_in_perf_report` |

Cost: the manager is a few dozen scalar eases and one table lookup per tick — CPU, effectively free, no per-tick allocation (targets/state reused). Its cost lives in its consumers, which all already exist or have their own ladders.

**Relationship to Clouds.md:** neither blocks the other. The cloud field reads `env.weather` axes that default neutral today; the manager feeds real values whenever it lands. They meet at the snapshot and nowhere else.

---

## 11. Traps — the named-bug-class audit

- **Mode fork** → LAW 1; the walk is an automated hand on the same sliders. Test: snapshot streams from both modes are indistinguishable to a consumer.
- **One field, two registries** → cloudCover01 migration (§10). The write path is single from day one.
- **Sim-clock latch** → eases realtime, walk game-time integrator, UI throttles realMs (§4.1, §5.4). Paused ⇒ frozen is CORRECT and documented as such.
- **Derived vs configured zero** → `auto` is an enum value; wetness 0 is legal data (§2).
- **Closed lists everywhere** → archetypes, biomes, event kinds, precip kinds, ToD curves. Unknown id = loud fail-open to clear.
- **Silent preconditions** → every multiplicative visibility chain prints its factors (§6.3).
- **Seam default hides unwired** → `hasOwner`/`ownerVersion` on env.weather (§2.2).
- **Unconsumed API rots** → the per-slice axis-shipping rule (§2.1, §13).
- **Fill gated on key** → inherited prohibition (§7.1).
- **Angular blending** → dominant-key snap under the twilight floor, never a lerped azimuth (§7.3).
- **One azimuth convention** — compass-cw-from-up, `sky-access.js`'s hard-won single derivation; moon, drift, and patchy-band directions all reuse it, none re-derive it.

---

## 12. Verification

- **CPU twin of the walk** (it IS CPU — the twin is the module): simulate 4 game-weeks per biome → occupancy histogram within tolerance of `archetypeWeights`; dwell means honored; zero non-edge transitions; storm-hour histogram peaks inside the declared ToD band. Determinism: same seed twice ⇒ identical trace; `forecast(k)` == realized future absent edits.
- **Ease engine:** monotone approach, no overshoot, per-axis τ respected; the 45 s real-time floor holds at `rateHoursPerMinute = 60`.
- **Compose ops:** per-op neutral identities; ash overrides precipKind and RESTORES on release; commuting ops order-independent.
- **Snapshot:** absent manager ⇒ byte-identical to today's `DEFAULT_WEATHER` build (fail-open); with manager at clear/Director ⇒ same again (LAW 5). `hasOwner` distinguishes the two.
- **Illuminants:** dominant-key handover — strength continuous, angle steps only while both keys ≤ the twilight floor; aurora visibility 0 at cover 1 AND at darkness 0; `realism01 = 0` stays exactly Foundry-parity with the manager running (the locked invariant, retested).
- **Soak:** six simulated DAYS at high rate — axes bounded, no NaN, drift/patchy phases wrapped (Clouds.md's own six-hour variance discipline, extended).
- **UI wired-not-declared:** shelf click reaches the manager; pins hold against the walk; forecast strip matches the twin's output (the `seams/viewer-wired` lesson — a declared-but-unwired shelf is invisible with every test green).
- **Live:** the author's eyes. Nothing above promotes past BUILT (unverified); the Almanac's first live soak should run on the bench Mansion with the clock at ~10 h/min while somebody actually watches the sky think.

---

## 13. Build order

| Slice | Lands | Why this cut |
| --- | --- | --- |
| **1** | `world/weather.js` core: axes cover/type/altitude/scale + ease engine + Director + persistence + snapshot wiring + `hasOwner`. The astrolabe Cloud slider rewires through it | **The gap closes** — env's weather owner finally exists; cover now EASES instead of stepping. Smallest honest slice |
| **2** | Archetype table + the Horizon shelf (Director one-click skies) + the Face swatch | The FUN control ships early — and it is dramatic *today* via the scalar consumers (shadows soften, sky greys, grade shifts) before any spatial cloud exists |
| **3** | The Almanac: biome tables, walk, ToD curves, pins, forecast strip | The living sky |
| **4** | Events core + the no-new-renderer built-ins: eclipse, blood-moon, gloom/radiance, sky-flash (grade+light preset, a11y-gated) | Testament's storm-preset line starts closing |
| **5** | Moon + illuminant compositor + `env.skyKey` + dominant-key handover in shadow-access | Night becomes a place — and the window-ceiling bug's moonlight wish gets its input |
| **6** | Patchy-illuminant primitive + aurora/volcanic/mana presets | The showpieces |
| **7** | Precip→particles wiring, wetness→specular/water, front scripts, the full `thunderstorm` choreography | Pillar 9's DoD scene: wind + cloud shadow + precipitation + storm flash, authored |

Slices 1–2 are one pure module, one data table, one UI region — and independently shippable. Clouds.md's own slices interleave freely (its slice 1–2 can land before, between, or after).

---

## 14. One line

**The GM chooses a sky, one small vector of numbers becomes the single truth, every effect reads the same weather — and the sky, in Almanac mode, chooses itself.**
