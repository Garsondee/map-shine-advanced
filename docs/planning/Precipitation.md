# PRECIPITATION — everything the sky lets fall

**Status:** **DESIGN ONLY. NOTHING BUILT.** Authored 2026-08-16 (Fable, per the Covenant — a plan-creation act). This is the owning spec for Pillar 9's precipitation half: the falling weather, its arrival on every kind of surface, and what the world keeps afterwards. It is the designed elaboration of `Weather-Manager.md` §13 slice 7 ("precip→particles wiring, wetness→specular/water, the full thunderstorm choreography") — that slice stays the *wiring* milestone; this document is the thing being wired.

**Prerequisite reading:** `Weather-Manager.md` (the axes this consumes — LAW 2 there is LAW 2 here), `Particles.md` §9–24 (the compute engine this rides), `Wind.md`/`Wind-Rethink.md` (the field this leans in), `Clouds.md` (the representation discipline the impression tier copies), `Water.md` (the surface rain must disturb), `Depth-Buffer.md` (the occlusion authority), `Effects.md` (tiers, Law 4/Law 7), Testament Pillar 9.

---

## 0. The brief

### 0.1 What the author asked for (2026-08-16)

> *"…combine together the concepts of shader effects using WebGPU and TSL and/or particles using compute. The goal is to get a wonderfully varied, visually interesting and exciting range of precipitation effects that can change organically and unpredictably in line with the weather manager and the wind vector grid system so that it seems to live within the world. We need to simulate everything from a clear day, to a day of drizzle, to sleet, hail, snow, all the way to hurricane with rain lashing against the ground… effects as precipitation hits buildings, what happens when it hits water, what happens when it hits the normal ground (snow persisting on surfaces). Can we do volcanic ash fall for forest fires and burning cities? Sandstorms? Other exotic or magical atmospheric particles? Spores?"*

### 0.2 Coverage map — every ask, its section

| The ask | Where answered |
| --- | --- |
| Shaders AND/OR compute particles, combined | §1 (the medium law) |
| Varied, visually interesting range | §2 (species), §6 (recipes) |
| Organic, unpredictable change with the weather manager | §1.2, §2.3, §3.4 |
| Lives in the wind vector grid | §3.3 |
| Clear day → drizzle → sleet → hail → snow → hurricane | §2.2, §6 |
| Rain lashing the ground | §4.1, §6 (hurricane row) |
| Hits buildings | §4.3 (roofs, drips) |
| Hits water | §4.2 |
| Hits normal ground | §4.1 |
| Snow persisting on surfaces | §5 (the mantle) |
| Volcanic ash fall / burning cities | §2.2 (`ash`), §6 |
| Sandstorms | §2.2 (`sand`), §6 |
| Exotic / magical / spores | §2.2 (`spore`, `petal`, `mote`), §2.4 |

---

## 1. The shape of the system

### 1.1 ⭐ THE MEDIUM LAW — three media, each doing the one thing it is best at

The author's "shaders and/or particles" question has a crisp answer, and it is *and*, split by the physical nature of what is being drawn:

| Medium | Owns | Why |
| --- | --- | --- |
| **Compute particles** (TSL `compute`, the Particles.md arena) | **discrete bodies with trajectories** — a drop, a flake, a hailstone, an ember, a spore | a body has a position, a velocity, a life; that IS a particle row. Per-body variety comes from `hash(seed)`, free |
| **Analytic TSL fields** (zero textures, world-space noise — Clouds.md's representation) | **continuous media** — the distant rain curtain, the squall band, the sandstorm wall, blizzard whiteout, mist | a medium has no individuals; drawing 100k sub-pixel drops to depict "greyness moving in bands" is paying per-body cost for a field-shaped picture |
| **State textures** (small world-space render targets) | **memory** — snow cover, ash blanket, puddles, footprints | persistence is exactly what a texture is; particles forget when they die, fields forget every frame |

Every precipitation phenomenon decomposes into these three, and the split is the architecture:

```
              env.weather axes (precip01, precipKind, storm01, temp01, wind setpoints…)
                 │                          │                           │
                 ▼                          ▼                           ▼
        ╔═══ THE FALL ═══╗        ╔═══ THE ARRIVAL ═══╗        ╔═══ THE STAY ═══╗
        ║ bodies in the  ║  lands ║ the instant of    ║ feeds  ║ what the world ║
        ║ air            ║ ─────► ║ contact           ║ ─────► ║ keeps          ║
        ║ · specimen:    ║        ║ · ground splashes ║        ║ · the MANTLE   ║
        ║   compute      ║        ║ · water rings     ║        ║   (snow/ash/   ║
        ║   particles    ║        ║ · roof hits+drips ║        ║    sand cover) ║
        ║ · impression:  ║        ║ · hail bounces    ║        ║ · puddles      ║
        ║   curtain field║        ║ · settle          ║        ║ · footprints   ║
        ╚════════════════╝        ╚═══════════════════╝        ╚════════════════╝
```

Most renderers build only THE FALL. The "seems to live within the world" feeling is almost entirely THE ARRIVAL and THE STAY — V2's own evidence: its beloved weather was carried by four splash archetypes, water-hit splashes, and roof drips (`legacy/particles/WeatherParticles.js`), while its "snow persisting" was a 2-second fade fake (`SnowFloorBehavior` — land, pin, shrink, gone). We are keeping V2's instinct and building the memory it faked.

### 1.2 The five laws

**LAW 1 — One engine, species as data.** Every falling thing is a row in ONE species table (§2) consumed by ONE runtime. Adding graupel, blossom, or glowing rain is a row, never a class — `Particles.md` §7's doctrine, applied to its flagship customer. V2's 11,777-line `WeatherParticles` god-class with 355 private fields is the corpse this law is carved on.

**LAW 2 — Axes in, pictures out.** This system reads `env.weather` axes (`precip01`, `precipKind`, `stormActivity01`, `temperature01`, `fogDensity01`), the wind handle, and time from the snapshot. It never reads preset names, never branches on archetype ids, and never stores its own weather opinion (Weather-Manager LAW 2 and LAW 3). The Almanac walking `precip01` from 0.1 to 0.8 over a game hour IS the "changes organically" requirement — this system just has to be continuous in the axes, and drama arrives from upstream for free.

**LAW 3 — sky reach gates everything, through the door built for it.** `scene/sky-reach-access.js` exists *for this feature* — its own 2026-07-24 header quotes the author: *"repairing sky reach because it needs to be an API / service for other things like rain drops"*, and *"Rain will ask `isCovered`."* Three questions, already served: `openSkyAt(x,y)` (the derived `skyReach = outdoors × (1 − coverAbove)`, `scene/mask-catalog.js`), `coverHeightAt(x,y)` → `{heightPx, known}` (*"a raindrop under a bridge needs the deck's altitude, not merely the fact of it"*), and `isCovered(x,y)`. The FALL fades over covered texels (and dies at the deck's own height, §3.2), the ARRIVAL only fires on exposed surfaces, the STAY only accumulates where sky reaches. Rain indoors is *unrepresentable*, not discouraged — and because `coverAbove` counts physical art layers regardless of current visibility, an interior view of a ground floor under two hidden upper floors correctly stays dry. Polarity note, already correct upstream: `skyReach`'s absence default is **1** and `coverHeightAt` reports `known:false` distinctly — missing data means *keep raining*, never *mysteriously stop*. (`outdoors` itself is a required mask and throws loudly when undiscovered; sky-shelter is deliberately a different question from wind-shelter — conflating them was a real 2026-07-21 bug, and this system must ask each door its own question.)

**LAW 4 — The STAY is derived state, never authored art.** The mantle buffer is computed from weather history; it never overwrites an authored texture and rebuilds from scratch on load (§5.5). The one authored input is placement guidance (the optional `_Puddle` mask), which *positions* the effect the mantle *fills* — derived never overwrites authored, in both directions.

**LAW 5 — Defaults neutral, absence is free.** `precip01 = 0` ⇒ zero compute dispatched, zero draws submitted (a JS `if`, Effects.md Law 4 — never a uniform set to zero), mantle decaying toward empty, curtain term compiled out below its threshold. A clear day costs nothing and renders byte-identical to today. Feature defaults ON (the standing rule) *because* of this law.

---

## 2. The species table — what the sky can send

### 2.1 The schema

A species is a data row, closed-list validated like the archetype and biome tables (`feedback_category_string_must_be_in_closed_list`), fail-open to **no precipitation** with a loud report (gate polarity: a broken table must never storm-lock a scene, and silence is forbidden):

```
{ id, label,
  phase: 'liquid' | 'solid' | 'dust' | 'magic',
  fall: {
    speedPxS: [min, max],          // terminal fall speed (drives streak length + travel time)
    windCarry01,                    // 0 = ballistic (hail) … 1 = fully wind-borne (spore)
    flutter: { hz, ampPx } | null,  // the paper-fall sway (snow, ash, petal)
    spin: { radS, windScaled } | null,
    spawnHeightPx,                  // pseudo-height ceiling — the M(h) parallax budget (§3.2)
  },
  body: {
    mode: 'streak' | 'flake' | 'mote' | 'grain',   // draw variant
    sizePx: [min, max],
    palette,                        // color ramp; emissive01 for bloom-eligible species
    emissive01,
    softness01,
  },
  respond: {                        // response curves to the axes — §2.3
    count: curve(precip01), length: curve, speed: curve, veil: curve(precip01),
  },
  arrive: {
    kind: 'splash' | 'bounce' | 'settle' | 'none',
    splashArchetype01,              // which of the four V2 splash looks dominates
    bounces,                        // hail: 1–2
    restSec,                        // how long a landed body remains visible
    waterRing: bool,                // contributes to the water agitation term (§4.2)
    smearWithWind: bool,            // impact sprite elongates along the wind vector
  },
  stay: {
    channel: 'snow' | 'dust' | null, // which mantle channel it feeds (§5.2)
    ratePerHour,                     // full-intensity accumulation rate, game-time
    meltBy: { temperature: bool, fire: bool },
    surface: { tint, sparkle01, roughnessDelta },   // how the mantle renders for this channel
  },
  light: { dayMul, nightMul, flashBoost },   // §3.5 — V2's proven scalar lighting
  tiers: { … },                     // per-species entry rung (sand's specimen tier starts higher than rain's)
}
```

### 2.2 The closed list (ships across slices — §12 says which when)

| id | phase | The look | Fall | Arrival | Stay |
| --- | --- | --- | --- | --- | --- |
| `rain` | liquid | cool blue-white velocity-stretched streaks; per-drop brightness skewed to mid-tones with rare glints (V2's `pow(rand, 0.72)` skew, kept) | fast (V2: 1400–5200 px/s), moderate wind carry, dual-frequency lateral chaos | splash + water ring, smears with wind | none (drives the scalar `wetness01` integrator + puddles) |
| `drizzle` | — | **not a species** — `rain` at low `precip01`: the response curves (§2.3) thin it, shorten it, slow it, and raise mist. One species, one continuum | | | |
| `snow` | solid | soft white flakes, paper-fall flutter (V2: 0.5–1 Hz, 40–100 px sway), spin scaled by wind (V2: calm ×0.4 → storm ×3) | slow (V2: 40–115 px/s class), high wind carry | settle (rest a few seconds as a body, then hand off) | `snow` channel — THE persistence feature (§5) |
| `sleet` | mixed | **a blend, not a species**: the manager's temperature band (§2.5) yields a mix weight; the kernel splits the population per-particle by seed — wet heavy flakes among glassy streaks | both dynamics interleaved | weak splash + brief settle | thin `snow` accumulation, fast melt (slush reads as wet + pale) |
| `hail` | solid | white pellets, hard motes | fastest, near-ballistic (`windCarry` ~0.1 — mass wins) | ⭐ **bounce**: 1–2 visible pop-ups in the same particle slot (§4.4), then a resting pellet fading over ~10 s | brief white speckle, melts fast above freezing |
| `ash` | dust | grey flakes + a sparse companion population of glowing `ember` motes (additive, wind-twitchy) — V2 ran exactly this pair (`ashSystem` + `ashEmberSystem`) | slow, high flutter, high carry | settle | `dust` channel, grey tint — desaturates the world (§5.2); pairs with the `ash-storm` event's sodium-gloom sky |
| `sand` | dust | mostly IMPRESSION (§3.4): advected tan curtain walls + grain shimmer near ground; specimen tier only adds darting grain streaks when zoomed close | near-horizontal — wind IS the fall | none (grains are sub-splash) | `dust` channel, tan tint, thin |
| `spore` | magic | drifting emissive motes, slow pulse over life, bloom-eligible | slowest, fully wind-borne, curl-heavy | settle-and-glow briefly | optional faint `dust` tint (biome-skinnable) |
| `petal` | magic | the feywild's promised precip skin (`Weather-Manager.md` §5.2) — tumbling soft quads, gentle spin | snow dynamics, warmer palette | settle | none |
| `mote` | magic | the generic magical carrier (mana-storm glitter, gloom flecks, radiance sparks) — palette/emissive/curl fully data-driven | data | data | data |

`ember` is deliberately NOT a top-level species: fire's own effect owns embers rising FROM fires (`Fire.md` phase 2). Weather owns embers falling from the SKY (ash-storm, volcanic-unrest) as `ash`'s companion population. Same word, two owners, one boundary — stated here so nobody unifies them into a shared mesh and reintroduces the `feedback_shared_field_two_meanings_two_registries` disease.

### 2.3 Response curves — how one axis becomes organic variety

`precip01` is one number, but each species maps it through its own response curves, and this is where "a day of drizzle" and "rain lashing the ground" become the same species at different operating points:

- `rain.count`: ~quadratic — drizzle is *sparse* before it is *short*
- `rain.length`/`speed`: rise with precip01 — heavy rain falls harder, not just thicker
- `rain.veil` (the impression-tier weight): kicks in above ~0.5 — a downpour greys the air; drizzle does not
- `snow.count`: ~linear; `snow.flutter`: falls as `stormActivity01` rises (blizzard snow travels, it doesn't waltz)
- splash rate, ring density, mantle rate: each derived from the same axes, per species

Plus the two upstream sources of unpredictability this system inherits rather than invents: the manager's eases (nothing steps), and the Almanac's seeded walk (nothing repeats). The one piece of spatial texture the FALL adds itself is the squall field (§3.4) — so intensity *breathes across the map*, not just across time.

### 2.4 Extensibility proof

`blood-rain` (dramatic red palette, stains as thin `dust`), `glimmer-rain` (mana-storm skin: emissive cyan streaks, sparkle arrivals), `blossom-fall`, `gloom-flecks` (falls UP — negative fall speed is just a number). Each is a row. If one of these ever needs code, the schema failed and this section is the regression test.

### 2.5 One amendment to the Weather Manager (recorded here, woven there)

`Weather-Manager.md` §2.2 derives `precipKind` as `temperature01 < 0.25 ? snow : rain` — one hard threshold. Precipitation needs that to be a **band**: within `temperature01 ∈ [0.20, 0.30]`, `auto` yields `sleet` with a mix weight ramping across the band. Still one derivation, one place, closed enum — the enum already contains `sleet`. This is a *derivation refinement*, not a new axis; woven into `Weather-Manager.md` §2.2 alongside the pointer to this document.

---

## 3. THE FALL

### 3.1 The specimen tier — compute particles

Rides the Particles.md engine discipline exactly (§9–24 there): arena sub-range, in-place kernel (no ping-pong — slot `i` touches only slot `i`), steady-loop spawn (rung 1 — population = capacity, dead slots respawn from their own seed; density is capacity × lifespan, no counters, no atomics), one instanced draw per active species batch. `effects/particles/fire-particle-runtime.js` and its siblings are the proven in-repo idiom (the `particles/allocator-only` wall keeps `instancedArray` in that directory); precipitation's runtime is their next sibling — and the first one whose *behaviors are driven from a data table* rather than hand-set constants, i.e. the first real step toward the Particles.md compiler.

**Spawn:** an area emitter over the view rect + a margin (particles must already exist just off-screen when the camera pans — V2 learned this as `msAutoCull = false`). **The sky gate is a RENDER gate, not a sim gate:** the sim is spatially uniform (cheapest possible kernel, no per-slot mask read — texture sampling from compute is unproven on this renderer and the storage-slot budget is precious, §3.3); the *draw* samples a baked `skyReach` texture at the body's ground position (fire's `bakeFireMaskTexture` precedent — fragment/vertex sampling is ordinary there) and fades the body over covered ground, additionally comparing the body's own height against `coverHeightAt`'s baked deck altitude so a drop above a bridge still renders while one "under" it never existed. Fades, never hard steps — a streak legitimately crosses an indoor pixel while its body is over an outdoor one (`feedback_silent_cap_corrupts_hard_boundary`). The ARRIVAL's statistical spawns (§4.1) are CPU-weighted by the same grids, where sampling is free.

**The kernel, per slot:** read row → dead-check/respawn → sample wind (§3.3) → apply species dynamics (fall speed from seed, flutter/spin/chaos per §2.2's harvested V2 numbers) → integrate → age → write. Per-particle "random" is `hash(seed + salt)`, no RNG state, deterministic per frame (Particles.md §12).

### 3.2 Pseudo-height — the thing that makes it read as 3D under a flat camera

MSA's world camera is orthographic and never tilts; V2's weather looked three-dimensional because its perspective camera magnified anything high by `M(h) = 1000/(1000−h)` — and weather spawned at h ≈ 990, i.e. **100× magnification collapsing as it falls** (`reference_v2_fire_look_autopsy` §📷: the one place V2's perspective camera genuinely mattered). The fire runtime already ports this as a per-particle transform (`uCamCentre`/`uCamHeight`, height packed in `custom.w`): displace from view centre by M and scale by M — mathematically identical to what V2's camera did, no global camera change.

Precipitation reuses that idiom: a drop is born at `spawnHeightPx` with a large M (big, fast-moving, blurred), and *converges toward its true position and size as it falls*. That radial swarm-toward-the-ground is the whole "rain is coming down AT the map" read. Snow gets a taller `spawnHeightPx` and slower fall — the lazy vertical drift of flakes IS a long M-decay. Optional DoF hook (rung, §7): blur ∝ height, riding the existing depth-of-field effect.

### 3.3 Wind — sampled through the door, split by altitude

Two regimes, matching what air actually does and what the wind rethink built:

- **Above the rooftops** (most of a body's fall): the **prevailing/ambient** wind only — the same term clouds read (`Clouds.md`: prevailing only, never wall terms). Walls do not shelter the open sky.
- **Near the ground** (the last ~15% of fall, and everything in THE ARRIVAL): the **full wind field through `world/wind-access.js`** — the one door, same as candle and vegetation. A sheltered courtyard receives near-vertical rain while the open field beside it takes it at 40°; drips and settled spores drift in the local field. *Calm indoors by construction* extends to precipitation with zero special cases.

`windCarry01` scales how much of the sampled wind a species accepts (hail ~0.1, spore ~1.0). And the gust structure is NOT invented here: `world/wind-field.js#computeGustEnvelope` already computes **travelling gust fronts** — thresholded noise advected downwind at ~900 px/s, rate following `speed01`, pronouncedness following `gustiness01`, identical in node and kernel form (parity-tested). Precipitation samples that same envelope through the door, so the rain leans, the vegetation bows, and the gust ribbons fly **in the same gust at the same moment** — the whole scene breathes together, which is exactly the "lives within the world" ask, and it costs zero new mechanisms.

⚠️ **Storage-buffer arithmetic, counted now, not hoped later** (`keyhole-storage-buffer-limit-fix`; the 8-per-stage WebGPU floor is a previously-hit real failure): the arena's six attribute buffers are the fixed cost of any runtime. Fire's kernel = 6 + spawn cloud = **7** (it deliberately takes ambient wind as two *uniforms*, by reference — no grid slot); gust's kernel = 6 + trail ring + wind grid = **8, exactly at the floor**. Precipitation's FALL kernel follows **fire's pattern**: ambient uniforms + gust envelope (pure ALU) + curl, **no wind-grid buffer** → 7 with a spawn/points buffer, one slot of headroom. Only the ground-hugging kernels (drips, settled drift) may spend the 8th slot on the wind grid, gust-style. Texture-sampling from compute is unproven on this renderer and is **not** the escape hatch — the escape is fire's ambient+curl idiom.

### 3.4 The impression tier — the curtain field

An analytic world-space field (Clouds.md representation: pure TSL noise, zero textures, zero RTs, drift phases wrapped modulo period on the CPU) drawn as a translucent veil term (a bounded quad over the world, alpha from the field × `respond.veil(precip01)` × `skyReach` so indoor pixels stay clear), tinted per species (rain grey-blue, sand ochre, snow white, ash brown-grey). Its banded structure is **two factors, one of them already built**: the wind door's own `computeGustEnvelope` (the travelling front — §3.3) sampled at curtain scale, × one slow large-scale "weather cell" noise of its own, anisotropically stretched along the wind. Squalls are therefore *the same events* the bodies and the vegetation respond to, at a larger wavelength — never a second, private idea of gustiness. (Deferred rung, recorded: when `world/cloud-field.js` lands, the cell factor can read the cloud field itself so **rain visibly falls from the dense cells** — Clouds.md's own deferred-rung wish, "precipitation coupling", met at the curtain, not in the shadow path.)

Three jobs, one field:

1. **The distance stand-in.** Zoomed out until drops are sub-pixel, the specimen tier sleeps (Law 7 — its JS gate never submits the draw) and the curtain alone says "raining over there." This kills the zoom-out-mush failure mode for weather *by design*: what you see at distance was never made of dots.
2. **The spatial modulator.** The SAME field value scales specimen spawn density at each (x, y) — so the bands are visible in the bodies when zoomed in and in the veil when zoomed out. One field, two consumers, no fork (`Clouds.md` discipline: zoom ADDS the specimen draw, never switches what precipitation *is*).
3. **The heavy-weather wall.** Sandstorm fronts, blizzard whiteout, hurricane rain sheets: the same field at high amplitude and near-horizontal anisotropy. `fogDensity01` and the grade stay upstream (the manager's axes) — the curtain is *structured* obscuration; flat mist belongs to the mist axis.

⚠️ The two engineering traps from the wind research apply verbatim (recorded in `keyhole-clouds-design` addendum): never animate the field's *scale* (reads as sliding — bin octaves power-of-2), and never let per-band UV offsets advect independently (they decorrelate and never resync).

### 3.5 Lighting the fall — V2's proven cheat first, the luxury later

Bodies are unlit sprites modulated by scalars from the snapshot — exactly V2's tuning, harvested: day (`alpha ×1.62, rgb ×0.5`), night (`alpha ×0.34, rgb ×0.24`), and ⭐ the detail that sold every storm: **lightning flash boost `alpha ×6, rgb ×4`** riding the sky-flash event envelope — one frame of the whole sky's rain lighting up. (`WeatherParticles.js:104-113`.) Emissive species (`spore`, `ember`, `glimmer`) push past the bloom threshold deliberately — fire's lesson applies: bloom's default threshold is 4.0, so an emissive mote that wants to glow must be *authored* above it, not hoped.

**The luxury rung (tier 3):** sample `buf:scene.illum` at the body's ground-projected position — rain glitters passing a torch, snow glows crossing a lantern's pool. One texture read in the draw material, C3-class. Recorded as a rung so it is a decision, not a drift.

**Draw order:** the FALL draws after the lit composite (it is *above* the world, including roofs) and **before the vision/fog composite** — MSA owns vision now, and precipitation must never leak into unexplored fog. It writes `buf:scene.color` only; it must never touch any Pillar-11 vision input (`fogDensity01`'s "visual mist, NEVER vision" rule extends to every pixel this system draws).

---

## 4. THE ARRIVAL

### 4.1 Ground — splashes

**Statistical, not tracked** (the load-bearing decision): for dense precipitation, impact sites are drawn from the same distribution the falling bodies land in — `rate ∝ precip01 × skyReach(x,y) × squallField(x,y)` — with no per-drop bookkeeping. V2 quietly proved this equivalence: its per-drop impact queue capped at 512/frame and looked fine, i.e. it was *already* statistical under load. Killing the drop→splash coupling removes the atomics, the queue, and a whole failure class; nothing visible is lost at rain densities.

The splash itself: V2's four hand-tuned archetypes (2×2 atlas, one system per tile so each could be tuned — the author's taste) re-authored as per-fragment TSL variants (the fire-sprite precedent: continuous phase beats a baked 64px atlas at every zoom). Triangular alpha 0→peak→0, aggressive early growth (V2's bezier 0.4→9.0 over ~0.15 s), random rotation at spawn, ground-billboard. Splashes are bodies too — they live in the same arena as a `splash` sub-range with a trivial kernel (age, no motion — V2 gave them wind drift and no gravity; kept).

**Where:** on the *eye's first surface*, exposed to sky. v1 rule: ground splashes gate on the viewed floor's `skyReach`; roof splashes (§4.3) gate on the overhead item's own exposure. The full generalisation — per-texel "exposure of the depth-authority's winning item" — is recorded as a rung; the two-mask v1 covers every real scene shape the bench Mansion has.

**Wind smear:** above a wind threshold, the splash quad elongates along the wind vector (`arrive.smearWithWind`) — "lashing against the ground" is precisely an impact that cannot stay round.

### 4.2 Water — rings, not sprites

Rain on water must disturb the *water*, not decorate it. Water's own ladder already agrees in principle: `Water.md`'s tier-7 "interactive ripple integrator" (a damped wave equation, not built) **names "rain (from `res:env.weather`)" as an impulse source** — when that rung lands, precipitation feeds it and gets true propagating rings for free. But rain-on-water cannot wait for a wave equation, so the near-term ask is deliberately smaller — a **capability request against water's ladder, not an edit** (the protocol Weather-Manager.md used for clouds' cell-polarity/anvil asks):

> **REQUEST → Water.md (pre-sim stopgap, tier 2/3):** a `rainAgitation01` input on the water surface material. When > 0, add a procedural expanding-ring term to the wave-normal `slope`: hashed cell centres, each cell running a phase-offset expanding ring (radius ∝ fract(t + hash), amplitude fading with radius), density ∝ `rainAgitation01`, evaluated alongside the ONE noise fetch water already pays for. No per-drop data crosses the seam — the term is statistical like §4.1, and because it feeds the *normal*, tier-3 sun glints shatter over rained-on water, which is the actual look of rain on a lake. Plus (storm rung) a foam-fleck density boost — V2's `FoamFleckEmitter` heritage. Retired naturally the day tier 7's integrator subsumes it.

Precipitation's side of the seam: compute `rainAgitation01 = f(precip01, species.arrive.waterRing)` and hand it to the env/render-state water already reads. Sparse near-zoom water-hit splash sprites (V2's tile-locked `WaterMaskedSplashEmitter`, peak opacity 0.55 vs ground's boosted 0.275) ride the ordinary §4.1 machinery with the water mask as their gate — those ARE ours.

Ash on water (far rung, recorded): the `dust` channel damps `rainAgitation` and desaturates the water tint — a grey film. Data, not code, if the water request above lands generally enough.

### 4.3 Buildings — roofs take the hit, edges do the singing

Roofs are surfaces too: on the viewed stack, overhead/roof art that nothing higher covers takes splashes exactly like ground (§4.1's second gate). Rain *audibly* hits buildings in the mind's eye when the roofline does something — and V2 found the right move: **drips**.

- **Drip spawn points = roof and canopy edges, extracted at decode time** (Particles.md §14.3, per-page, in the worker, world-space page coordinates). This is the design that *kills* V2's roof-drip tragedy — union-find edge labeling was correct (`legacy/particles/RoofDripEdgeSampling.js` is harvest-grade), but its screen→world mapping was *voted on at runtime between four Y-flip candidates* (`_probeBestNdcMode`) and drips "never reliably worked" for exactly that reason. Decode-time extraction makes the question unaskable — and it is the mechanism `fire-spawn-points.js` + `packSpawnPoints` already implement and `fire-particle-runtime.js` already consumes. Each drip is born at its edge's own **`coverHeightAt` deck altitude** and falls the M(h) distance from there — a bridge drips from bridge height, an awning from awning height, with zero authoring.
- **Drip dynamics, harvested from V2 and kept:** slower gravity (×0.64), tiny size (1.2–2.4), short life, faint blue-white fading to nothing, a whisper of curl. And the detail that made it feel alive: ⭐ **the drip tail** — emission `×300` while raining but `×260` persisting *after rain stops*, decaying with the wetness integrator. The map keeps dripping for a minute after the sky clears. That is THE STAY leaking back into THE ARRIVAL, and it is the cheapest "the world is wet" signal there is.
- Walls/windows: non-goals for v1 (top-down reads almost no wall area). A `window-streaks` luxury is parked in the idea notebook, not the ladder.

### 4.4 Hail — the phase machine

Sparse discrete arrivals are the one place per-body continuity matters: a hailstone must visibly *bounce*. In-slot life phases (no cross-system spawn): `fall → bounce(×1–2, damped pop-up re-using the M(h) transform smaller each time) → rest (a white pellet on the ground, ~10 s) → fade`. Phase lives in `custom` alongside height; the kernel is a tiny state machine on `age`. This generalises V2's `_landed` flag into the shape snow's settle (§2.2) and spore's glow-rest also use — one mechanism, three species.

---

## 5. THE STAY — the mantle

The world's memory of weather, and the answer to "snow persisting on surfaces."

### 5.1 The buffer

One small world-space render target per floor (allocated through the allocator door, lazily, viewed-floor resident): max dimension ~2048 (≈5 world px/texel on the 10k bench map — footprint-legible, cheap: 2048×952 RGBA8 ≈ 8 MB), ping-pong updated at **low cadence** (a few Hz, or per sim-minute tick — never per frame).

Channels (one byte, one quantity, named — `feedback_one_byte_two_quantities`):
- **R `snow01`** — snow/slush depth
- **G `dust01`** — ash/sand blanket depth (species tint decides its rendered colour; two dust species don't co-occur in practice, and the *event* owns the palette while it runs)
- **B `puddle01`** — standing-water fill
- **A `trample01`** — disturbance (footprints, wheel ruts), recovers slowly

### 5.2 Sources and sinks — all game-time integrators

| Term | Rule | Notes |
| --- | --- | --- |
| accumulate | `+ ratePerHour × precip01 × skyReach × dtGameHours` | per species channel; squall field optionally modulates (drifting deposition) |
| melt | `− f(temperature01)` on `snow01` | the manager's temperature axis finally gets a visible spatial consumer |
| 🔥 fire melt | `− g(fireGrid proximity)` | the fire mask's derived grid already exists — **snow retreats in a halo around every burning hearth**, and nobody has to author it |
| dry | `− h(temperature01, cover01)` on `puddle01` | puddles outlive rain; sun dries them faster than overcast (cover is upstream, free) |
| trample | token movement stamps `trample01` (and dents `snow01`) along the motion segment | ⭐ footprints in fresh snow — small CPU-side stamp queue flushed at mantle cadence, positions from the token layer MSA already reads |
| recover | `trample01` decays over ~game-hours; fresh snowfall buries footprints | the mantle *heals*, which is what makes disturbing it delicious |

Paused game ⇒ frozen mantle. That is the **integrator pattern** — correct, and stated here so nobody "fixes" it into the sim-clock-throttle latch (`feedback_throttle_on_sim_clock_latches_when_paused`; same ruling as the Almanac walk).

### 5.3 Rendering the mantle

A world-space overlay mesh in the geometry stage (water's two-mesh precedent: bounded quads over the floor AABB, premultiplied blend), drawn over ground art **before lighting** so snow is lit and shadowed like the surface it is:

- `snow01`: albedo lerp toward snow white shaped by a soft threshold of depth + a static micro-noise (crystalline sparkle at high tiers via the specular system, below), edges dissolving in the noise so accumulation *creeps* rather than floods. Trample subtracts: compacted grey-blue in the prints.
- `dust01`: multiply-toward-tint (ash greys and darkens; sand warms) — dust *dims*, snow *brightens*; two channels because they are two different blend ops, not two colours of one op (`feedback_blend_neutral_element_is_per_blend` — and the overlay's MRT/attr write must be the correct neutral for every target it touches).
- `puddle01`: darken + specular/roughness push. **REQUEST → Specular:** a wetness input — `roughness × (1 − k·wet)`, spatially fed by `puddle01 × wetness01`, so rained-on courtyards sheen and dry interiors don't. (`wetness01` alone is the tier-0 scene-wide sheen; the mantle makes it spatial at tier 2+.) Optional authored `_Puddle` mask *places* pooling; absent, a low-frequency noise picks plausible hollows (LAW 4: authored guides, derived fills).

### 5.4 What the mantle is NOT

Not a fluid sim, not per-pixel physics, not a z-displacing heightfield, and **never a vision/fog input**. It is a stain buffer with taste.

### 5.5 Persistence

Rebuilt on scene load by seeding from weather history (the wetness integrator's own trick, spatialised: uniform depth from the recent Almanac trail × skyReach, plus placement noise). Footprints are ephemeral and proudly so. Serializing the mantle to the scene is a parked idea (notebook), not a rung — it costs a save-format commitment the current goal (release maps frequently) doesn't want yet.

---

## 6. The choreography gallery — axes in, drama out

No recipe below introduces machinery; each is a *point in axis space* plus the species table doing its job. This table is the acceptance test for "wonderfully varied":

| Scene | Axes (manager) | FALL | ARRIVAL | STAY |
| --- | --- | --- | --- | --- |
| **Clear day** | precip 0 | nothing dispatched (LAW 5) | — | yesterday's puddles drying |
| **Drizzle** | precip 0.15–0.3, cover 1.0 | sparse short slow streaks, no veil | occasional soft splash, rings on ponds | wetness creeping up, sheen rising |
| **Steady rain** | precip 0.5–0.7 | full streak population, squall bands breathing | splash carpet, drips running, water rippling | puddles filling |
| **Thunderstorm** | precip 0.85, storm 0.9, gusts | streaks leaning hard with gusts; ⭐ every body ×6 alpha in the sky-flash frame | wind-smeared splashes | wetness saturated |
| **Hurricane** | precip 1.0, storm 1.0, wind setpoint max | near-horizontal streaks, curtain sheets marching, debris motes (gust-borne `mote` skin) | smeared impacts everywhere, foam on water | trample irrelevant — everything is water |
| **Sleet** | temp in the band | interleaved glassy streaks + heavy flakes | weak splashes + slush settle | thin fast-melting slush |
| **Snowfall** | precip 0.6, temp 0.1 | fluttering flakes, tall spawn height, lazy M-decay | flakes settle and rest | ⭐ the mantle whitens; hearth halos stay green; the party's tracks write the session's history |
| **Blizzard** | + storm 0.8, wind high | flutter dies, flakes *travel*; whiteout curtain | — | fast accumulation, tracks bury in minutes |
| **Ashfall** (burning city, volcanic-unrest event) | event sets precipKind `ash`, cover 0.85 | grey flakes + ember sparks under a sodium sky | embers wink out on landing | the world greys street by street |
| **Sandstorm** | event/biome, `sand`, wind high | ochre curtain walls, grain shimmer | — | tan film on the windward town |
| **Spore bloom** (feywild) | biome skin, precip 0.2 | drifting glowing motes, curl-heavy | settle-and-glow | faint luminous dusting |

---

## 7. Tiers, performance, honesty

The C7/C8 rungs of the ladder, zoom- and coverage-gated (Effects.md Law 7). The **impression tier is the tier-0 stand-in** (Particles.md's rule that weather "never vanishes entirely on weak machines") — a curtain veil + wetness sheen + mantle are all cheap surface terms, never gated.

| Tier | Adds | Budget intent (4K, RTX 3070 laptop) |
| --- | --- | --- |
| 0 | curtain veil, scalar wetness sheen, mantle render | fractions of a ms — field ALU + one small overlay |
| 1 | specimen FALL (rain/snow), statistical splashes | sim: tens of thousands of rows, one dispatch, ~free; draw: the real cost is streak overdraw — measure at heavy rain, full screen, and set the pre-registered lab threshold *before* tuning (posture: `fire-light-budget`'s unbuilt lesson — the cost driver gets a bench first) |
| 2 | drips, hail phases, water request wired, M(h) parallax, spatial puddles | |
| 3 | illum-lit bodies, DoF-by-height, debris, sparkle | the luxury shelf |

Counts to design against (not to promise): heavy rain ~30–60k specimen rows; snow ~10–20k; splashes ~5–10k; drips ~2–5k. All arena sub-ranges reserved at max-tier capacity, `liveCount` doing the tiering (Particles.md §10 — tier changes are free). A system that pins its cap logs it (`no silent caps`).

**Zoom gates:** each species declares the screen-px-per-body threshold under which its specimen tier sleeps (a JS `if` — the draw is not submitted). Sand sleeps earliest (grains), snow latest (flakes are big). The curtain never sleeps; it is the picture that remains.

---

## 8. Architecture

| Piece | File | Notes |
| --- | --- | --- |
| Species table | `effects/precipitation/precip-species.js` (NEW) | frozen rows, closed list, validated at load, fail-open to none + loud |
| Runtime (FALL + ARRIVAL kernels) | `effects/particles/precip-runtime.js` (NEW) | fourth sibling of `particle-runtime` / `gust-runtime` / `fire-particle-runtime` — the allocator wall requires the arena calls live in `particles/`; follows the shipped idiom (a private `ParticleArena` per engine, `InstancedBufferGeometry` never `InstancedMesh`, storage reads vertex-stage-only so fragment data crosses as varyings, `DoubleSide` because the flipped camera inverts winding, sync `renderer.compute` never `computeAsync` in-frame); the first runtime whose behaviors are driven from a **data table** rather than hand-set constants — the real first step toward Particles.md's compiler |
| Curtain field | `effects/precipitation/precip-curtain.js` (NEW) | analytic TSL, Clouds.md representation discipline; consumed by the veil draw AND the runtime's spawn-density modulator |
| Mantle | `effects/precipitation/precip-mantle.js` + subsystem (NEW) | integrator + ping-pong targets through the allocator; overlay mesh into the geometry stage |
| Subsystem / lifecycle | `effects/precipitation/precip-subsystem.js` (NEW) | floor switches (mask + mantle + spawn re-sync — fire's floor-context lesson applies verbatim), view rect, seam pushes |
| Manifest + params | `effects/precipitation/precipitation.js` (NEW) | `EffectManifest` registration (cascade/a11y/UI for free) wrapping the runtime decls — Particles.md §18's two-layer pattern |
| Seams | boot | `skyReach` per floor from the mask authority (grid for gating; the derivation already exists), water mask (exists), fire derived grid (exists), token-motion stamps |
| Wiring | boot / vt-pan-viewer / graph | ⚠️ **the seven-station registration surface, walked in full at first light** — the named forgotten-list bug (fire round 2 went fully invisible on one missed station): ① the declaration file, ② the `effects/index.js` zone-door export, ③ `boot.js`'s `effectRegistry.register(...)` site (water's `create*Registration` module is the extraction template), ④ the bespoke `reapply*` closure beside its siblings, ⑤ the debug-panel `buildEffectCard` registration, ⑥ `graph/passes.js` (`sims.particles` already `live` and driven directly from `renderFrame` — the sims stage sits outside the pass plan, wind's pattern; `surface.particles` draws into `buf:scene.color`), ⑦ the `MASK_KINDS` row only if a new authored mask ever appears (none planned — LAW 3 reuses `skyReach`) |

**Who owns which number (one action, one control):** `precip01`, `precipKind`, `temperature01`, `stormActivity01` belong to the **weather manager** — the astrolabe is their UI, the Face already plans to render precip streaks in its live swatch. This effect's own FOH/ROH params are **look-only** (splash vigor, streak length feel, mantle depth scale, species palette skins). There is deliberately no second "intensity" slider here — a control that duplicates the manager's axis would be the FOH ≠ ROH violation wearing a raincoat.

**Time:** all animation from the snapshot's clock; all integrators on game time; UI throttles on real time. Nothing in this system may call `performance.now()` (the one-clock wall).

---

## 9. Traps — the named-bug-class audit

- **Dispatch lists forget new effects** → the §8 wiring row; first-light checklist includes the reappliers grep. Fire has already paid this tax twice.
- **Unbounded time × direction** → curtain advection and every drift phase wrap modulo period on the CPU (water correction 10; clouds' six-hour soak inherited as §11's own).
- **Y-flip** → the first body drawn gets the "does it sit where its world position says" probe before any tuning (bitten 5×; billboard corner math is the classic site).
- **Sim-clock latch vs integrator** → §5.2's explicit ruling; eases real-time upstream, integrators game-time here, throttles real-time.
- **Gate polarity fails open** → species table → none + loud; missing `outdoors` already throws upstream (required mask). A broken table yields a clear sky and a shout, never a locked storm or a silent one.
- **Silent preconditions** → the visibility product (`enabled × tier × precip01 × skyReach × zoomGate × squall`) is printed factor-by-factor in the status report; an invisible rain must be diagnosable from the report alone (windows paid this tax; we don't pay it again).
- **Seam default hides unwired** → the effect reports `axesSource` (manager vs defaults) the way `hasOwner` distinguishes the same thing upstream; a rain that renders at defaults while the manager thinks it's driving is the §8 wiring row's silent failure mode.
- **Bench must build inputs like production** → the lab renders into HalfFloat targets (the fire lab lied about every highlight on UnsignedByte), with production blend state; MRT blend state is renderer-global — the splash (premultiplied) and emissive (additive) draws must set/restore `renderer.setMRT` discipline.
- **One byte, two quantities** → mantle channels are named depths with one meaning each; species *tint* is looked up, never packed into the byte.
- **Half-open bands** → the sleet temperature band includes both endpoints' species by construction (mix weights, not exclusion).
- **Floor switch skips context sync** → mantle target, skyReach grid, spawn gating all re-resolve on the shared floor context, with the painter-stepper path included (fire's exact bug).
- **Smooth output hides ported bugs** → V2 numbers are re-authored as data with a CPU twin for spawn-density and mantle-integrator math; twin runs BEFORE any live claim (water's process lesson).
- **Aggregate cannot name the source** → per-species live counts and per-subsystem ms land in the perf report as separate rows, not one "weather" bucket (`feedback_diagnostics_must_land_in_perf_report`).
- **Storage-buffer ceiling** → §3.3's counting rule; the texture-sample fallback is the designed escape, chosen by arithmetic.

---

## 10. The V2 harvest ledger — the taste, with its numbers

`legacy/particles/WeatherParticles.js` (11,777 lines; the tuned values are the author's irreplaceable taste — `Particles.md` §6). Re-authored as species data, never imported:

| What | The numbers (source ≈ line) |
| --- | --- |
| Rain body | life 2.1–5.4 s, speed 1400–5200 px/s, size 0.65–3.6, stretched-billboard `speedFactor = 0.0065×0.25` (:4994–5017) |
| Rain colour | cool ramp `(0.96,0.98,1.0,α1.0) → (0.48,0.6,0.88,α0.38)`; per-drop brightness `pow(rand,0.72)` mid-tone skew with rare glints (:5002, :1466) |
| Rain chaos | grav-mul 0.72–1.48, dual-freq sway 3.5–10 Hz + 0.9–3.7 Hz, amp 28–100, gust term 11 Hz, velocity kick 140–660 (:1450–1505) |
| Rain turbulence/curl | turb scale (360,360,680) ×3 oct, strength (110,110,22); curl (480,480,820), strength (145,145,38), t×0.24 (:5167–5183) |
| Day/night/flash | day α×1.62 rgb×0.5 · night α×0.34 rgb×0.24 · **lightning α×6 rgb×4** (:104–113) |
| Snow | flutter 0.5–1.0 Hz, sway 40–100; spin 1.2–2.4 rad/s both directions, wind-scaled ×0.4→×3 (:1556–1663) |
| Splashes | 4 archetypes (2×2 atlas, per-tile tuning tables), life ~0.1–0.2 s, size 12–24 px, growth bezier 0.4→9.0, triangular α peak 0.1 (×2.75 ground boost; water-hit peak 0.55), wind-drift no gravity, random spawn rotation (:5185–5299, :115–117, :245) |
| Roof drips | gravity ×0.64, wind base 14, curl (420,420,950)/(22,22,12)/0.1, size 1.2–2.4, life 1.9–3.85 s, ⭐ tail emission ×260 after rain (vs ×300 during), refresh 0.75 s (:76–148, :5081–5135) |
| Caps that worked | rain maxParticles 15,000; splash 2,000×4; drips 5,000; impact queue 512/frame (already statistical — §4.1's licence) |
| The V2 state vector | `legacy/core/WeatherController.js`: `PrecipitationType {NONE, RAIN, SNOW, HAIL, ASH}` and `WeatherState {precipitation, precipType, …, fogDensity, wetness, freezeLevel, ashIntensity}` — the author's own earlier instinct for exactly the axes Weather-Manager.md now owns properly; `GUSTINESS_VARIABILITY = [0.25,0.45,0.7,0.85,0.95]` is a tuned gust-feel ladder worth an A/B when calibrating §3.3 |

**Dropped freely (CPU-era compromises, per the autopsy):** the `getImageData` spawn scans, the NDC-vote screen→world drip mapping, quarks' per-particle JS objects, prewarm-blocking-the-event-loop, per-frame material patching, the 355-field namespace — and `WeatherController`'s deepest disease, **the clock living inside weather** (`this.timeOfDay = 12.0`): time stays upstream, always.

---

## 11. Verification

- **CPU twins first** (before any live claim): spawn-density math (bodies per px² per precip01 — the response curves), mantle integrator (accumulate/melt/trample over simulated game-days: bounded, non-negative, footprints heal, hearth halos hold), sleet mix weights across the band.
- **Shader-lab benches** (`bench-precip`): kernel determinism (same seed+time ⇒ same rows), phase machine (hail bounces exactly N times), species matrix render (every row × every body mode compiles and draws on real WebGPU — the four-graphs-per-tier lesson from water pinned in Node), curtain six-simulated-hour soak (wrapped phases, no coarsening), HalfFloat targets + production blends throughout.
- **Perf lab, pre-registered:** heavy-rain full-screen draw cost at 4K and the sim dispatch cost, thresholds written down before tuning; per-species rows in the report.
- **Live rungs** (the only promotions that count): bench Mansion, real token, each slice's own look; floor-switch dwell honoured; the author's eyes promote `BUILT (unverified)` → LIVE, per the standing doctrine. The Almanac soak (weather thinking for an hour at high rate) doubles as precipitation's organic-variation acceptance run.

---

## 12. Build order — slices, each visibly alive on the bench

| Slice | Lands | The visible thing |
| --- | --- | --- |
| **P1** | `rain` + `snow` specimen FALL: runtime + species table + skyReach gate + ambient wind + M(h) + day/night scalars. **Ships `precip01`/`precipKindAuthored`/`temperature01` axes in the manager** (their first real consumer — the unconsumed-axis rule finally satisfied) + astrolabe quick slider via the manager | it rains on the Mansion; snow falls when cold; interiors stay dry |
| **P2** | ARRIVAL statistics: ground splashes (4 archetypes), water-hit splashes over the water mask, wind smear. Water `rainAgitation` request filed | rain lands *on* things |
| ↳ | **`BUILT (unverified)` 2026-08-16** — `effects/particles/precip-splash-runtime.js`, `arrive` on the species rows, two bench scenarios (9 checks, green). **Ground splashes + wind smear shipped; water-hit splashes and the `rainAgitation` request did NOT** — see the note below | |
| **P3** | THE STAY v1: mantle buffer (snow + puddle channels), melt by temperature + fire halo, trample stamps, scalar wetness → specular request | ⭐ snow persists; footprints; hearths keep their ground |
| **P4** | IMPRESSION curtain + squall modulation + zoom gates + storm choreography (flash boost, gust lean) | blizzards and downpours read at every zoom |
| **P5** | Drips (decode-time edges + the tail) + `hail`/`sleet` phase machinery | the roofline sings; hail bounces |
| **P6** | The exotic shelf: `ash`+embers, `sand`, `spore`/`petal`/`mote` skins + event/biome bindings (`ash-storm`, feywild petal-fall) + dust mantle channel | burning cities, sandstorms, the feywild |
| **P7** | Luxuries by measurement: illum-lit bodies, DoF-by-height, debris motes, mantle sparkle | the shelf you raid when the frame budget says yes |

P1 is the Weather-Manager slice-7 keystone and is independently shippable; every later slice is additive.

**⚠️ WHAT P2 LEFT ON THE TABLE, stated so nobody reads the row as finished.** Ground splashes and wind smear are built and green on the bench; §4.2's two halves are not:

- **Water-hit splashes** (the sparse near-zoom sprites over the water mask, V2 peak 0.55) need a SECOND gate texture injected — the water mask, alongside the sky-reach bake. That is real wiring through `vt-pan-viewer.js`'s bake sites, not a parameter, so it waits for its own commit rather than shipping half-armed.
- **The `rainAgitation01` REQUEST against `Water.md`'s ladder** is deliberately still just a request. Computing the value and handing it to the env snapshot today would create an input nothing reads — `feedback_unconsumed_api_rots_silently` on the far side of a seam, which is the same disease the species table's `arrive`/`stay` schedule exists to avoid. It lands with water's consumer.
- **§4.1's `squallField(x,y)`** is P4's; the rate is `precip01 × skyReach` until then, and the runtime says so rather than approximating it with a private noise.

Consequently the species rows carry `arrive.kind`/`splashArchetype01`/`smearWithWind` and the four archetypes — and still carry **no** `waterRing`, `bounces` or `restSec`, each of which is asserted absent by `precip-species.test.mjs` until its own reader exists.

**Ledger accounting:** these slices are how three of Pillar 9's open lines close ("Rain + snow as particle archetypes with wind coupling" ← P1; "Atmospheric mist… NEVER touching vision" ← P4's curtain + the manager's `fogDensity01`; "Ash weather preset" ← P6 — and P6 makes it *content*, so the "else cut" clause need never fire), and how Pillar 12's Compression-Ledger row (`WeatherParticles`, `AshCloud`/`AshDisturbance`, `WaterSplashes` droplets → "Pillar 12 archetypes on one particle engine") is discharged for the weather-shaped entries. Pillar 9's DoD scene — wind + cloud shadow + precipitation + storm flash on one authored map — is P4's exit criterion wearing its Sunday name.

---

## 13. One line

**Three media, one truth: bodies fall by compute, media veil by field, the world remembers in a stain — and all of it is a data row reading the same small vector of weather numbers everything else already trusts.**
