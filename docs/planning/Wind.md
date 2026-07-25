# WIND — one field the whole map shares

**⚠ SUPERSEDED FOR THE "WHERE CAN WIND BE" QUESTION — see `docs/planning/Wind-Rethink.md` FIRST.** 2026-07-22: after ~8 consecutive patches each fixed their target and revealed the next failure, the author directed a full rethink of how wind PRESENCE is decided. Tier 1's relaxation bake (`bakeWindStructure`, §3.2 below) and Tier 1.5's wake turbulence (§3.2's own addendum) are **DELETED** — replaced by a single geometry-only scalar, `openness` (`world/wind-enclosure.js#floodFillOpenFromBoundary`), computed from walls/doors alone with no painted-mask involvement. `W = A · openness + gusts` is the new model; see the rethink doc's §4 for the full design and rationale. Tier 0 (`res:env.wind`) and Tier 2 (`world/wind-sim.js`/`wind-sim-gpu.js`, the transient door-gust sim) are **untouched** by this and stay exactly as documented below — this supersession is scoped to the D_rest/structure question only.

**Status (HISTORICAL, pre-rethink):** DESIGN SPEC, authored 2026-07-21 from an author directive. **Tier 0, Tier 1, Tier 1.5, AND Tier 2 are BUILT** (Tier 2 same day, a follow-up session; Tier 1.5 — wake turbulence — a later follow-up fixing a reported "dust glues to buildings" bug) — see §9's own honesty ledger for exactly what that does and doesn't mean, and `keyhole-wind-tier2-transient-sim` (memory) for the Tier 2 build log. Tier 3 (emergent pressure) remains spec-only. `graph/passes.js` does not yet carry a formal `sims.wind` pass entry — the whole Tier 0-2 stack is wired directly into `vt/vt-pan-viewer.js`'s own closure, the same pragmatic "not yet a registered graph pass" pattern the candle effect itself still uses; promoting it to a real pass declaration is a recorded follow-up, not done here.

**Author directive (verbatim intent):** _"Reimagine a very important driver of the V2 module. Wind. Use the GPU to store a vector field for the whole map. Cheaply simulate drafty corridors, doors opening causing movement. It doesn't need to be simulation quality — it drives effects — but the better the job, the better the effects look. It must be the single source of truth for wind in one place that other effects can access and contribute to in a well-organised manner. Candles are the case study."_

**Foundations this builds on (settled — do not relitigate):**

- `world/environment.js` — `DEFAULT_WIND {directionDeg, speed01, gustiness01}` is **built + Node-tested**, frozen, and already rides `res:env` every frame. That is the _authored ambient input_, and it stays exactly where it is.
- `graph/passes.js` — the DAG, the one-producer rule, and the resource grammar (`vt:` / `buf:` / `res:`). `sims.fluids` already reads `vt:masks`; a wind sim is the same species of pass.
- `core/frame-clock.js` — the one clock. Every integration below reads `res:env.time.dtSec`, already clamped against the monster-delta lurch. No new `performance.now()`.
- `core/params-schema.js` + `Effects-UI.md` — the params contract and the front-of-house / rear-of-house UI machinery. §8 is a straight application of it, not a parallel invention.
- `keyhole-webgpu-tsl-decision` — the sim is written once in TSL and runs on both backends.

---

## 0. WHAT EXISTS, AND WHY V2'S WIND ROTTED

Two real parts exist today, and the gap between them _is_ the bug this doc closes:

1. **The ambient scalar** — `res:env.wind` (direction / speed / gustiness). This is the "weather" wind: one vector for the whole scene. `frame.snapshot` already absorbs V2's `SceneWindField` (35 direction/speed/gustiness controls) into it. Good. Keep it.
2. **A proto-field, trapped inside the candle** — `candleWindLean()` (`effects/candle-flame-render.js:551`) is a genuine low-frequency world-space gust field... that only the candle _flame_ can see. Worse: the candle _light_ (`candle-flicker.js` tier 2) rolls its **own, separate** lean/gust noise. **A single candle's flame and its own light lean in two different winds today.** That is the whole disease in one object: wind re-derived per consumer, no shared truth, guaranteed to drift.

V2 did this at scale — every effect that wanted wind sampled or invented its own. There was no field, so there was no single source, so there was nothing to keep them agreeing. This doc's core claim: **wind must be a resource with exactly one producer, sampled through one function, contributed to as declared data** — the same cure the pass-DAG applied to everything else.

> The failure mode is `feedback_probed_constants_vs_derived` in the memory: a value that should be _derived once by an owner_ instead gets _voted on at runtime by every consumer_. Wind is that bug, class-wide. The fix is an owner.

---

## 1. THE SHAPE — one field, three terms, one owner

The mental model, in comp terms: **three stacked weather-map layers that flatten into one output every effect reads.**

```
         W(x)  =  A(x)        +   D(x)
                  ┌─────────┐      ┌────────────────────────────────────┐
                  │ ambient │      │  the owner's published field:       │
                  │ analytic│      │   • FROZEN → D_rest      (baked)    │
                  │ (a fn)  │      │   • LIVE   → D_rest+D_live (sim)    │
                  └─────────┘      └────────────────────────────────────┘

   consumers ALWAYS sample  W(x) = A(x) + D(x).  The state machine is invisible to them.
```

- **A — ambient.** The prevailing breeze, an analytic TSL function of `res:env.wind` + low-frequency gust noise + `skyReach` shelter (indoor stillness vs outdoor sway). Never stored; exact; free. This is `candleWindLean` promoted from "a thing the candle owns" to "the field everyone shares."
- **D_rest — structure (the baked layer).** The sim's _resting state_ with no transients: the ambient breeze threaded through the walls, so it channels down corridors and can't cross masonry. Immutable until re-baked on a wall/door/ambient change. **This is where "drafty corridors" live.**
- **D_live — transient.** Starts at zero, holds only the puffs (a door opening, a spell gust, a thermal), decays back to zero. Ticks _only_ while it has energy.

The owner composites `D_rest (+ D_live)` into the one field `res:wind`. Downstream, nobody knows or cares whether the sim is running — they call `sampleWind(worldXY)` and add it to `A`. **That single read is the single source of truth.**

Why split `A` out analytically instead of baking it into the texture: the ambient stays _exact_, so numerical drift in the sim can never accumulate into a permanent fake breeze, and the sim only ever simulates a _deviation_ that decays to zero — which is self-stabilising by construction.

---

## 2. RESOLUTION — decoupled from the map

The question the directive asks outright. The answer rests on one insight:

> **Wind is low-frequency. Field resolution tracks the _architecture_ (corridors, doorways ≈ one grid square), not the _pixels_.** The GPU's free bilinear filtering turns a coarse grid into a smooth continuous field, so a coarse texture reads as continuous air.

Recommendation: **~1 texel per grid square, clamped to `[64, 256]` per axis, aspect-correct. Velocity in `RG16F`** (add a channel for turbulence/updraft only when a consumer needs it — see §5).

| Map (grid squares) | Field texels      | VRAM (`RG16F`, ×2 ping-pong) |
| ------------------ | ----------------- | ---------------------------- |
| small 60×40        | 60×40             | ~20 KB                       |
| typical 100×80     | 128×96            | ~0.1 MB                      |
| big 200×150        | 256×192           | ~0.4 MB                      |
| mega 400×400       | 256×256 (clamped) | ~0.5 MB                      |

Even the mega-map is **half a megabyte**. Against the ~2.5 GB WebGPU ceiling that caused the 12k-map device-loss (`keyhole-device-loss-large-map`), wind is a rounding error — this is the reassurance for anyone scarred by that bug. A few-iteration sim step at 256² is **sub-millisecond** on any WebGPU-class GPU, and it is measurable per-effect in the 🔬 Performance lab (`keyhole-effect-perf-measurement`) the moment it exists.

The candle's own tuning already confirms the low-frequency claim: `WIND_SPACE_FREQ = 0.0016` puts a gust at ~600px ≈ one room. That number becomes a scene param (§8), not a hard-coded constant.

---

## 3. THE SIM — four small passes, and the freeze/thaw machine

The transient layer is the classic Stam **"Stable Fluids"** loop, trimmed hard for looks. Four fullscreen TSL passes, ping-ponged (read old `D`, write new `D`) — portable across both backends because they are fragment passes; a WebGPU compute variant is a later refinement, never a requirement.

```
1. ADVECT     D*(x) = D( x − W(x)·dt )        every patch looks a hair upwind and copies what was
                                              there — the pattern drifts downstream and smears,
                                              exactly like watching smoke move
2. SPLAT      D*(x) += Σ contributor(x)·dt     each contributor airbrushes a dab of push into the field
3. RELAX      cancel W's into-wall component    let the air relax a few times until it stops trying to
              (reflect, or N Jacobi iters)      pile into walls; it slides along them instead
4. DISSIPATE  D *= decay (≈0.97)                gusts quietly lose energy so they fade, not ring forever
```

Three properties worth stating:

- **Advection is unconditionally stable** — it cannot blow up regardless of `dt` (Stam's whole point), and `dtSec` is clamped anyway. The backtrace is one bilinear read.
- **Disturbances ride the _total_ wind** (`W = A + D`, not `D` alone), so a door-puff drifts downstream with the prevailing breeze.
- **Corridors emerge from step 3 for free.** Near a wall, ambient `A` may point into it; the relax step bends the total flow to slide along, and stores that correction _in D_. So D holds a standing "don't cross the wall" correction even at rest — and that standing part **is** `D_rest`. There is no separate baked "corridor texture"; structure is just the resting state of the sim.

### 3.1 The freeze/thaw state machine (this is what "Hybrid" means)

```
   ┌──────────  FROZEN  ──────────┐            ┌──────────  LIVE  ──────────┐
   │ D = D_rest, sim idle          │  thaw  →   │ tick D_live on top of D_rest │
   │ ZERO per-frame sim cost       │            │  advect · splat · relax · decay │
   │ sample A + D_rest             │  ← refreeze │  (refreeze when energy < floor) │
   └───────────────────────────────┘            └────────────────────────────┘
```

- **Frozen** is the common case: no active one-shot, no dynamic contributor. Sampling only. A candlelit room with a closed door costs **no sim at all**.
- **Thaw** the instant a one-shot fires (door, spell) or a genuinely dynamic contributor appears. `D_live` starts at zero and holds only the transient; total published field = `D_rest + D_live`.
- **Refreeze** when `D_live`'s total energy falls below a floor (one cheap reduction). Drop it to zero, stop ticking. **`log()` the transition** — an instrument must never report "frozen" while air still moves (`feedback_instruments_must_not_lie`).

### 3.2 The bake (how `D_rest` is made)

Triggered on wall/door change, or a throttled meaningful ambient-direction shift. It is a relaxation to steady state: run `relax + dissipate` with ambient as the only inflow for **K iterations** (the wall-correction propagates one cell per iteration, so threading a breeze down a 40-cell corridor needs ~40 steps; budget K≈64). That is a one-time burst of ~64 coarse passes — a few milliseconds — on a door toggle. If it ever hitches, amortise over a handful of frames while the previous `D_rest` stays valid.

---

## 4. WALLS, DOORS, DRAFTS — boundaries and the door recipe

The two ingredients already exist: **walls** (Foundry's `ClockwiseSweepPolygon`, already reused for candle light-clipping in `foundry/scene-wall-clip.js`) and **`vt:masks`** (already read by the sims stage).

- **The solid mask `S`** (`R8`, 0 = open, 1 = solid): rasterise wall segments into `S` **conservatively** — mark every cell a wall clips, minimum one texel thick. **The coarse-grid trap:** a hairline wall leaks diagonally through the corner between two solid cells. Over-seal rather than leak; you can thin later. (This is a fresh instance of `feedback_y_flip_recurring_risk`'s sibling — a new world→texture rasterisation is exactly where geometry bugs hide.)
- **Doors are walls with a toggle.** Foundry hands you open/closed → a closed door writes its cells `S=1`, an open door leaves them `S=0`. There is **no door-specific code in the sim** — a door is a wall segment that flips a boundary cell.
- **Free-slip, not no-slip.** Air slides frictionlessly along walls. Cheaper, and it reads better top-down (a no-slip boundary layer is invisible from above).

**The door-open recipe** (baseline — ship this; the emergent-pressure version is a top rung, §9):

1. Foundry's door-open hook fires → read the doorway's world centre and the wall segment's **normal** (the "through the doorway" axis).
2. Register a one-shot **impulse** contributor: `shape:'segment'` across the door width, `impulse` = normal × strength, `radius ≈ door width`, `lifetimeMs ≈ 800`, ease-out.
3. The sim splats it, advection carries it down the corridor, dissipation fades it. **Emergent draft, ~1 second, then gone.**

---

## 5. CONTRIBUTORS — access and contribute, governed

This is the directive's "well-organised manner," and it maps onto the **one-producer rule** already enforced by `validatePassGraph`:

- **`res:wind` has exactly one creator** — the `sims.wind` pass. The DAG validator _fails the build_ if any other pass creates it, or if anyone reads it before it exists. "One place," enforced, not promised.
- **Contributors never touch the texture.** They are declarative **`WindContributor`** records — the same species as anchor records and light descriptors. The pass gathers them, splats them, ticks. Contribution is _data the owner composites_, so it cannot devolve into 46 effects poking the field.
- **Consumers declare `reads: ['res:wind']` and call one `sampleWind()` TSL helper.** A new wall (§11) forbids ad-hoc `sin`/noise "wind" in effect shaders once the field exists — you _must_ sample the field. That permanently kills the candle's two-winds divergence and stops the next effect re-inventing it.

```js
// A WindContributor — frozen declarative data; the sim is the sole reader/writer.
{
  id: 'candle:1a2b',           // stable → dedup + pool reuse, like a light's sourceId
  kind: 'thermal',             // 'thermal' | 'vent' | 'impulse' | 'wake' | 'ambient'
  shape: 'point',              // 'point' | 'disc' | 'segment' (doorways) | 'region' (zones)
  at: { x, y },                // world px  (or a region ref for area contributors)
  radius: 90,                  // world-px falloff
  // WHAT it adds (per kind):
  vector:  { x, y },           // steady push        (vent / ambient)
  impulse: { x, y },           // one-shot kick      (door / spell)
  updraft: 0.2,                // temperature/vertical add (thermal)
  turbulence: 0.1,             // local gustiness
  strength: 0.05,              // master gain — candle tiny … bonfire huge, SAME code path
  // WHEN:
  mode: 'steady',             // 'steady' (re-applied each frame) | 'oneShot'
  startMs, lifetimeMs, easing, // oneShot only — envelope, read from the one clock
}
```

**The governance rule that keeps it from rotting: derive, don't register.**

- **Steady contributors are _derived_ from the authority that already owns the placement** — candle thermals fall out of the candle anchor catalog (`scene/anchor-catalog.js`) each frame; vents fall out of painted draft zones (a future authoring surface, `Authoring-and-Distribution.md`). No parallel registry to leak or desync — the same discipline as the mask/anchor authorities.
- **Only one-shots are registered explicitly** — a small queue the door/spell hooks push into, drained each tick.

Contributor kinds, all one code path scaled by `strength`: **thermal** (flame/fire updraft), **vent** (draft zone, bellows, open window), **impulse** (door, spell, explosion), **wake** (moving token — later), **ambient** (the built-in `A` layer).

> Ordering note: the `sims` stage runs before lighting/surface, so a contributor _discovered_ late in a frame feeds the _next_ frame's sim — a one-frame latency invisible for something as soft as wind. Steady contributors derived from authorities are known at frame start, so they have no latency at all.

---

## 5.1 THE HANDLE — how a consumer actually _gets_ the field

> **BUILT, verify-green (2026-07-23) — 3,138 assertions, 25 structure rules, all six consumers migrated. NOT YET LIVE-TESTED**: this touches two WebGPU compute kernels and four TSL materials, none of which can be exercised from a headless session. The refactor is behaviour-preserving by construction (every migrated call site produces the same node graph from the same inputs) and the node↔kernel parity test is real, but "the tests are green" is not "the wind still looks right." Ask for one live look before trusting it closed.

_(2026-07-23. Written when vegetation became the seventh consumer and the pattern above stopped scaling. This section is the ACCESS half of §5, which the original draft left as one sentence — "consumers declare `reads: ['res:wind']` and call one `sampleWind()`" — because `sims.wind` was going to exist. It doesn't; it is still `status: 'future'`. What exists instead needed writing down, and then building.)_

### The gap between the promise and the practice

There IS one wind function — `world/wind-field.js#sampleWind` — and every consumer genuinely calls it. That half worked. What rotted is the **assembly**: `sampleWind` needs five separate inputs, and every consumer hand-assembles them from closure locals in `vt/vt-pan-viewer.js`:

```js
ambientWind: { directionDeg: uWindDirectionDeg, speed01: uWindSpeed01 },
bakedField:  windBakedField,      // openness + exteriorOpenness
wallAvoidField: windWallAvoidField, // deflection direction + proximity
liveField:   windLiveField,       // Tier 2 transient, or null
// …plus the caller's own per-position `exposure`
```

That block is copy-pasted verbatim at four sites (light illumination, light coloration, candle flame, debug overlay). Two more consumers — `particle-runtime.js` and `gust-runtime.js` — take a **different shape entirely** (`opennessGrid: windOpennessGrid`, raw arrays uploaded as storage buffers), because a WebGPU compute kernel cannot sample a texture here. So there are seven consumers, two incompatible access shapes, and six hand-written wirings.

**Three proofs this rots, all from this project's own history, none hypothetical:**

1. **A consumer silently forgot an input for an entire phase.** `particle-runtime.js`'s `sampleWind` call never passed `bakedField`. Door-boosted turbulence therefore never reached the visible dust motes at all — only the candles, lights and overlay ever saw it. Found _by accident_, while building something else.
2. **A consumer silently froze an input forever.** `windOverlayMesh` kept pointing at whatever material object it was built with, so after a rebake it still held the _startup_ (windless) bake's texture. Symptom: "rebaking never visibly changes anything." Fixed by hand, in that one consumer. Nothing checks the other five.
3. **Shared math had to be rescued after the copies existed.** `computeWindTurbulence` was extracted only once two divergent copies were already live. Extraction-after-the-fact is the tax you pay for manual assembly; the copies existed because assembly was manual.

The lesson matches the V2 autopsy exactly: **more shared helpers don't stop drift — an abstraction you're allowed to bypass gets bypassed.**

### The fix: a handle, not another helper

**`world/wind-access.js#createWindHandle({...})`** — constructed ONCE, by the thing that owns the bake, carrying every ref. Consumers receive a handle. They never name an input.

| Shape                                                                             | Who it's for                                                            | What it takes                                                                                                                         |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `handle.node({ centerXY, exposure, windResponse })`                               | any TSL material (candle, light, vegetation, overlay)                   | TSL nodes → returns a `vec2` node. Wraps `sampleWind`, forwarding `bakedField`/`wallAvoidField`/`liveField`/`ambientWind` **itself**. |
| `handle.kernel({ centerXY, openness, exteriorOpenness, wallAway…, windSpeed01 })` | compute kernels that read storage buffers, never textures               | the SAME math over per-particle buffer reads — today's hand-copied ambient formula, owned in one place.                               |
| `handle.cpuAt(x, y)`                                                              | placement-time and per-anchor questions ("how sheltered is this bush?") | plain JS numbers. Subsumes `boot.js#sampleWindExposureAt`.                                                                            |

Plus one field that does structural work:

- **`handle.version`** — a counter bumped on every rebake. Every consumer binds graph-BUILD-time constants (`originX`, `cellSize`, `cols`, `rows` are baked into the node graph; only the texture object mutates). A consumer compares the version it built against and rebuilds when it moves. That is proof #2's bug, fixed **mechanically for every consumer at once**, instead of by hand for one.

**Why a handle rather than "just pass the bundle around":** because you cannot construct a partial handle. `createWindHandle` is the only constructor and it lives beside the baker, which is the only code that has all five refs. A consumer holding a handle _physically cannot_ forget `bakedField` — it never spells `bakedField`. Proof #1 becomes unwriteable, not merely discouraged.

### The wall that makes it stick — BUILT, at zero

Per the enforcement doctrine — rules live in `tools/verify-structure.mjs`, not in comments:

- **`wind/handle-only` (rule #25).** Outside `src/world/`, the identifiers `bakedField`, `wallAvoidField`, `liveField` and `opennessGrid` may not appear. Same shape and enforcement as the proven `masks/authority-only` wall. It **fired on its own birth commit**, exactly as that one did — and the two hits were _the rule being wrong_, not the tree: `ambientWind` had been included in the banned list, but the composition root legitimately has to hand the live direction/speed uniforms to `createWindHandle`, and Tier 2's sim materials (part of the wind system, not consumers of it) take the same pair. More decisively, **none of the three bugs in the rationale involve the ambient at all** — every one is a _baked_, graph-build-time ref being forgotten, frozen, or duplicated. So `ambientWind` came out of the pattern, with that reasoning written into the rule. A wall should ban exactly the mechanism it can name; wider than its own rationale and it just teaches people to route around it. (`feedback_too_fussy_over_lenient` says pick the stricter option when a rule is in _doubt_ — not when it is demonstrably over-broad.)
- **The node↔kernel parity test — REAL, not a promise.** This needed a thing that did not exist: a **numeric TSL stub** (`world/__tests__/tsl-numeric-stub.mjs`) that evaluates TSL node graphs to actual numbers in Node. `wind-field.test.mjs` had said plainly that no such harness existed and `sampleWind` was "browser-verified live, not unit-tested here." Now both access paths are evaluated over one synthetic 8×6 grid — sealed cells, a wall face, a live ambient — and asserted to agree at **every one of the 48 cell centres** (worst Δ < 1e-9). The stub's own header states, at length, what a green run does _not_ prove: it is not the real MaterialX noise, not a shader compiler, and not GPU float precision. It proves the two paths run the same arithmetic, which is the only thing it was ever aimed at.

`wind/sample-through-the-door` (§11 tripwire 2) stays as written — it forbids _inventing_ wind; this one forbids _assembling_ it by hand. Complementary, not redundant.

### What this did NOT change

`sampleWind`'s own signature, math and output are untouched — this is a wrapper over the existing function, not a rewrite. Every migrated consumer builds the same node graph from the same inputs; the change is call-site-only. `sampleWind` is no longer re-exported from `world/index.js` (only `world/` may call it directly), which is what makes the wall enforceable rather than advisory.

Three things fell out that were not the point but are worth recording: the duplicated **cell-lookup index arithmetic** in both compute kernels collapsed into one place; the gust kernel's momentum guard stopped doing a **second, identical storage-buffer fetch** at the same position it had just read; and `windOpennessGrid` — a whole second closure-local copy of the grid, pushed around separately — **stopped existing**, with the probe and the overlay now reading the handle. Two ratchets tightened on their own as a result (`time/one-clock` 38→35, `graph/reachable-from-boot` 8→3).

When `sims.wind` eventually becomes a real pass, the handle becomes what `reads: ['res:wind']` hands you, and §5's original sentence finally describes reality.

---

## 6. CANDLES — the worked case study (consumer _and_ contributor)

Candles prove both directions of the API at once, and fix a live bug doing it.

**As a consumer (and the bug it kills).** The flame material drops `candleWindLean(center,…)` for `sampleWind(center)` — the flame geometry _already_ bakes `center` + `windExposure` per vertex (`computeCandleFlameArrays`), so it is a drop-in. The candle _light_ (`candle-flicker.js`) samples the **same** field at the **same** position. Flame and light finally lean together. Bonus emergent beat: strong enough local wind → the flame gutters, or a real draft **snuffs the candle**.

**As a contributor.** A lit candle _derives_ a tiny **thermal** from its anchor — a gentle updraft that nudges nearby smoke, dust, and embers up and inward. A candelabra's thermals sum; the same code becomes a hearth's plume by turning up `strength`.

**The one subtlety Hybrid forces.** Candles flicker, so "thermal = dynamic → thaw" would keep the sim live forever in any candlelit room. Resolution: **bake the candle's _steady_ thermal into `D_rest`, and let the candle's own flicker noise carry the visible liveliness.** The field needn't pulse for the flame to look alive — it already flickers on its own seed. So **candles alone never thaw the sim.** Only true transients (doors, spells, later wakes) do — keeping "idle is free" true in the exact scene you will test most: a drafty castle full of candles.

---

## 7. WHERE IT SITS — the pass, the resource, the clock

A new pass in the `sims` stage. The declaration to drop into `graph/passes.js` (validator-passing):

```js
{
  id: 'sims.wind',
  stage: 'sims',
  kind: 'gpu',
  status: 'future',            // → 'seam' when the NotBuilt door lands → 'live' when it runs
  owns: 'docs/planning/Wind.md',
  creates: ['res:wind'],
  reads: ['res:env', 'res:scene', 'vt:masks'],   // ambient+dt+time · walls/doors/anchors · solid mask
  modifies: [],
  absorbs: [
    // V2-NOVELTY: V2 had no shared wind field — wind was re-sampled per effect.
    // The authored ambient (SceneWindField) stays absorbed by frame.snapshot as
    // this pass's INPUT; sims.wind is the field PRODUCER those effects will read.
    '(V2-novelty: per-effect wind sampling collapses to one res:wind producer)',
  ],
  note: 'The Hybrid field: analytic ambient + baked D_rest (corridor channeling) + ' +
        'transient D_live (doors/gusts/thermals), sim-res never world-res, ticks only ' +
        'while transient energy is live. One producer; every consumer reads res:wind.',
}
```

- **`res:wind`** is sim state (the `res:` grammar covers "sim state"), world-space, persistent — never a `buf:` (those are screen-sized and per-frame).
- **The clock:** advection scales by `res:env.time.dtSec`; one-shot envelopes read `tMs`. No new clock, no `performance.now()`.
- **Consumers** (`reads: ['res:wind']`) sit downstream in `sims < lighting < surface`: the candle light in `light.accumulate`, the flame and particle draws in `surface.particles`, smoke/dust/embers in the particle engine, water streaks in `surface.water`. All sample the one field.

---

## 8. FRONT OF HOUSE & REAR OF HOUSE — the controls

Wind has **two control faces**, and both are generated from declarations per `Effects-UI.md` — no hand-wired panel, no mirror.

### 8.1 The two faces

1. **Wind as a scene authority** — its own params schema + dials (the breeze, the sim). Lives beside weather in the scene environment surface.
2. **Wind as a per-effect coupling** — each consuming effect declares a `windResponse` knob (the fixed **Motion** category literally lists "wind response" as its example). The candle already carries the spatial half (`windExposure` from `skyReach`); `windResponse` is the per-effect gain.

### 8.2 Rear of house — the expert board (Tweakpane, generated, categorised)

`WIND_PARAMS`, sorted into the **fixed category set** so wind's board is navigable like every other effect's. `type`/`min`/`max`/`default`/`category`/`label`/`help`, validated by `validateParamsSchema`, written through `validateParamValue`:

| Category      | Param                    | Type                                 | Notes                                                                 |
| ------------- | ------------------------ | ------------------------------------ | --------------------------------------------------------------------- |
| **Presence**  | `enabled`                | bool                                 |                                                                       |
| **Presence**  | `simQuality`             | enum `off·low·standard·high·extreme` | **the tier the governor drives** (F5). `off` = ambient only, no sim.  |
| **Presence**  | `masterStrength`         | float 0..2                           | overall wind gain                                                     |
| **Motion**    | `gustiness`              | float 0..1                           |                                                                       |
| **Motion**    | `gustScalePx`            | float 200..2000                      | gust cell size (candle's `WIND_SPACE_FREQ`, now a knob; default ~600) |
| **Motion**    | `gustRate`               | float                                | how fast gusts rise and fall                                          |
| **Motion**    | `flutter`                | float 0..1                           | fast jitter riding the gust                                           |
| **Extent**    | `prevailingDirectionDeg` | float 0..360                         | shown as a compass, not a slider                                      |
| **Extent**    | `indoorResidual`         | float 0..1                           | how much sheltered spots still move (`WIND_INDOOR_RESIDUAL`)          |
| **Response**  | `weatherCoupling`        | float 0..1                           | storm weather raises wind                                             |
| **Technical** | `fieldResolution`        | int 64..256                          | _governed by `simQuality`; expert override_                           |
| **Technical** | `relaxIterations`        | int 0..20                            | reflect-only (0) → smooth curl (20); _governed_                       |
| **Technical** | `simRateHz`              | int 30/60                            | _governed_                                                            |
| **Technical** | `decay`                  | float 0.9..0.999                     | transient fade                                                        |
| **Technical** | `wallSealPx`             | float                                | conservative rasterisation thickness (the leak guard)                 |
| **Technical** | `thermalStrength`        | float                                | global thermal gain                                                   |

Per **F5**, the three perf knobs (`fieldResolution` / `relaxIterations` / `simRateHz`) are absorbed by the one `simQuality` tier the governor drives — they remain in Technical as expert overrides but are normally set by the profile, not hunted by hand. Harvested `help` prose becomes every tooltip for free.

### 8.3 Front of house — the honest dials (ApplicationV2, 3–6 max)

`WIND_DIALS` — plain language, each a **set-driven-key** (the author's Maya vocabulary: one master attribute driving many channels through a remap), validated against `WIND_PARAMS` at build time so a dial can never reference a ghost:

```js
export const WIND_DIALS = {
  draughtiness: {
    label: 'Draughtiness',
    help: 'From dead-still air to a room that never quite settles.',
    range: [0, 1],
    default: 0.2,
    drives: {
      masterStrength: { to: [0.0, 1.4], curve: 'ease-in' },
      indoorResidual: { to: [0.0, 0.5], curve: 'linear' },
    },
  },
  bluster: {
    label: 'Bluster',
    help: 'A steady breeze, or wild gusting that catches every flame.',
    range: [0, 1],
    default: 0.3,
    drives: {
      gustiness: { to: [0.0, 1.0], curve: 'linear' },
      gustRate: { to: [0.2, 1.4], curve: 'linear' },
      flutter: { to: [0.0, 0.8], curve: 'ease-out' },
    },
  },
  // Prevailing direction is a single value → a direct FOH compass control, not a dial
  // (a dial exists to drive MANY params; direction drives one).
};
```

**Presets** (the discrete cousin — named snapshots of rear values): **Still air** · **Draughty castle** (low ambient, `indoorResidual` up, doors matter) · **Blustery day** · **Storm outside** (high ambient, hard gusts, thermals visible). A preset sets a starting point; dials nudge from there. Defaults are Foundry-parity-plausible: **the out-of-box scene is calm**, and a GM who never opens the panel still gets a sensible, still room.

### 8.4 The dead-control cure, applied where it matters most

Wind is the sharpest test of the cure, because a GPU sim is precisely where V2 grew dead sliders — knobs feeding a shader nobody could prove were read. All four guards apply verbatim (`Effects-UI.md §4`), and one is load-bearing here:

- **Unconsumed param** — does moving `relaxIterations` or `thermalStrength` actually change the sim? The read-tracking `ctx.params` proxy records which keys the wind pass reads; **control-health = declared − read**, surfaced in the debug panel automatically. A wind knob wired to nothing **announces itself** instead of dying in silence.
- **Dead dial reference** — a dial driving a renamed sim param fails the build (`validateDialsSchema`).
- **Orphan / silent write** — impossible by generation; a bad write throws, naming the key.

Per-effect coupling closes the loop: the candle adds `windResponse` (Motion) to its own schema; on the candle's FOH it folds into a **Liveliness** dial that drives `windResponse` alongside the flame's flicker richness — one honest control over "how much the room's air moves this flame."

---

## 9. THE TIER LADDER — honest rungs

Recorded, not all built (`Effects.md §0` honesty). Each rung is default-on where cheap, governed where not.

- **Tier 0 — Unify. BUILT, verify-green (2026-07-21).** Extracted `candleWindLean` into `world/wind-field.js`'s `sampleWind()`; the candle flame _and_ light both sample it now — the two-winds bug is fixed. `WindContributor` (shape + `validateWindContributor`) stood up, Node-tested, no producer reads one yet. A live debug overlay (`diag/wind-field-overlay.js`, toggle in the Workshop zone) draws a grid of arrows sampling the identical field, pinned to the map's own grid (not the current view — a real bug caught and fixed from the author's own live testing), with a 1×-4× resolution lever. The glyph itself was rebuilt (2026-07-21, author-reported: the original round-cone shape borrowed from the candle flame read as ambiguous): a real thin shaft + triangular head, coloured on a calm→moderate→strong ramp (not brightness alone), with an honest "clipped" white-blend when the true magnitude exceeds the visual length cap. A SECOND `sampleWind` call at a nearby world position bends the shaft toward the midpoint sample's cross-wise component, so LOCAL curvature (shear — the edge of a swirl) shows in one glyph, not only by comparing neighbours.
- **Tier 1 — Bake structure. BUILT, verify-green (2026-07-21).** `world/wind-bake.js`: `rasterizeWallsToGrid` (conservative, with the diagonal-leak supercover guard) + `bakeWindStructure`. **Built as a discrete scalar-POTENTIAL relaxation (`-gradient(phi)`), not a direct two-axis velocity diffusion** — an earlier version of exactly that direct approach was implemented, Node-tested, and caught FAILING by its own tests: it dampened flow near a wall but never redirected it, because two independent per-axis scalars can't exchange the momentum a real deflection needs. The potential approach fixes this for free (Laplace's-equation-around-an-obstacle is the same maths as "air bending around a wall"), verified via a live debug printout showing genuine gap-funnelling (a nozzle-like speedup through a doorway) before the test assertions were finalised — not just "the assertions happened to pass." Walls read from live Foundry documents (`foundry/scene-walls.js#readSceneWallSegments`, verified against `common/documents/wall.mjs` source; a door is solid unless open). Baked ONCE (viewer start + a debug "Rebake" action + an ambient direction/speed change), never per frame; consumed by every Tier-0 consumer via `sampleWind`'s new optional `bakedField` param (a small HalfFloat DataTexture). **`createWall`/`updateWall`/`deleteWall` auto-invalidation — BUILT (2026-07-21).** `foundry/scene-walls.js#watchSceneWallStructure` subscribes to plain Wall CRUD (no door-specific code — a door toggling open/closed IS a `WallDocument#update` on `ds`, verified against Foundry's own `DoorControl#_onMouseDown` source), coalesced through a `queueMicrotask` flag (same idiom as `vt-pan-viewer.js`'s `onResize`) so a bulk wall edit in one synchronous tick still costs exactly one rebake, not N. This is what makes "an open door lets outside wind push into the house" a LIVE reaction instead of something a GM has to remember to click Rebake for — **but it is the STEADY half only**: the bake converges to a new resting state (§3.2's ~64-iteration relaxation), it does not produce a felt transient gust the instant the door swings — that is still Tier 2's job (§4's door-impulse recipe), not started. Node-tested (the no-`Hooks`-global guard path); **NOT yet live-verified in Foundry** (does opening a real door in a real scene actually funnel the arrows through it, promptly, without a hitch — an eyeballed confirmation, not just green tests). **NOT yet**: per-floor wall scoping (reads every wall regardless of level — an honest, stated simplification). **NOT yet formally a `graph/passes.js` entry** — wired directly into `vt-pan-viewer.js`, matching the candle effect's own not-yet-a-registered-pass status.
- **Tier 2 — Transient sim. BUILT, verify-green (2026-07-21).** `world/wind-sim.js` (pure, Node-tested — advect/splat/relax/dissipate as four independently-testable stage functions plus a composed CPU reference, verified against a throwaway probe script's REAL printed numbers before any assertion was written, the same discipline that caught Tier 1's own algorithm bug) + `world/wind-sim-gpu.js` (the TSL port, a direct stage-for-stage translation of the verified reference — browser-only, CONVENTIONS §4, could not be live-tested this session; every non-obvious line cites the reference formula it must match). Ping-pong render targets (allocated through `ThreeAllocator`, `gpu/allocator-only`) plus a THIRD, stable "published" target every consumer (candle flame, each light's illumination/coloration, the debug overlay) binds to ONCE — solves the real problem that D_live's ping-pong texture identity flips every tick while consumers build their shader graphs lazily and rarely (see `wind-sim-gpu.js#buildWindPublishMaterial`'s own header). The freeze/thaw machine is CPU-clock-driven, not GPU-energy-readback-driven (`no-gpu-readback` would forbid the latter anyway): a door impulse's own decay curve is solved analytically (`computeThawWindowMs`) for how long the sim needs to keep ticking, generously rounded up, never cut short. **The door recipe**: `foundry/scene-walls.js#watchDoorOpenings` (a NEW, narrower hook than Tier 1's `watchSceneWallStructure` — closed→OPEN transitions on an actual door only, verified against the real `Hooks.callAll('updateWall', doc, change, options, userId)` 4-arg signature in the vendored Foundry source, not assumed) feeds `doorwayImpulseFromWallSegment`, which derives the impulse DIRECTION from the current ambient's own component through the doorway (self-correcting sign, no "which side is inside" geometry needed — windless scenes correctly get zero impulse, emergent not special-cased) rather than the raw `normal × strength` this section originally sketched. A debug "🌬️ Trigger test gust" button and a "🌬️ Force sim running" perf-lab override exist so the sim can be exercised and measured without a real door in a real scene. **Two deliberate, named simplifications**: (1) `D_live`'s own relax step reuses Tier 1's FIRST-REJECTED per-axis into-wall-cancellation approach — deliberately, for a genuinely narrower job than the one it failed at (see `wind-sim.js`'s own header for the full reasoning: D_rest already provides the global redirect-toward-a-gap property; D_live's relax only needs to stop LOCAL wall-clipping on a transient that already rides the correct total field via advection). (2) The GPU advect pass's transport velocity is `ambient + D_rest` only — D_live's own self-velocity is dropped from its own backtrace (a second-order term, traded for one fewer ping-pong-tracked texture sample). Neither building-wake/lee-turbulence (Bridson's curl-noise technique, `keyhole-wind-realworld-research`) nor per-floor wall scoping (inherited, unchanged, from Tier 1) are in scope. **NOT YET BUILT**: `WIND_PARAMS`/`WIND_DIALS` exposure for Tier 2's own knobs (`relaxIterations`, `decayPerSecond`, etc. are code constants, not FOH/ROH controls yet — same gap Tier 0/1 already had) and `simRateHz` (the sim ticks once per rendered frame using real `dtSec`, not a separate fixed-rate accumulator). **NOT YET LIVE-VERIFIED** — `npm run verify` (2871 assertions, 15 suites) proves the pure math and the wiring, not the on-screen look; this is GPU/TSL code with no way to print-debug or screenshot it from this session. Ask the author to open a door in a live scene, and separately try the debug "test gust" button, before trusting this fully closed.
- **Tier 1.5 — Wake turbulence. BUILT, verify-green (2026-07-21).** Author-reported symptom: wind-driven particles (dust motes riding `res:wind`) lose speed and sit glued to a building's exterior instead of getting buffeted past it — the "dead grid space next to buildings" bug. Root cause, confirmed from the maths, not a hunch: Tier 1's `bakeWindStructure` is a discrete POTENTIAL-flow solve (`flow = -gradient(phi)`), which has **zero curl everywhere by construction** — it can correctly slow flow down facing a wall (a stagnation point) and speed it up through a gap, but it is mathematically incapable of producing a swirl. A stagnation point is the textbook-correct answer for this simplified model, but reads as "dead air," not "turbulent redirection." The fix, named in `docs/reference/wind-simulation-research.md` §2/§6 (Bridson, Houriham & Nordenstam, SIGGRAPH 2007): keep the potential-flow solve untouched (it's what makes wind correctly funnel through doorways and bend around corners), and separately sum in a small, **geometry-gated curl-noise** term — divergence-free by construction (derived from the rotation of a scalar noise potential, not its gradient), so it can only ever REDIRECT energy, never invent or delete it. Two smooth, multiplied gates control where it engages: a shell falloff (1 at a solid cell, 0 at `shellCells` away — `WAKE_TURBULENCE_SHELL_CELLS`, default 2) and a stagnation gate (0 once a cell's own total flow reads at or above `speedRatioThreshold` of the open-field ambient — `WAKE_TURBULENCE_SPEED_RATIO_THRESHOLD`, default 0.45; a cell that's actually SPEEDING UP at a doorway funnel is correctly left alone — that's real, already-working physics). A windless ambient always yields zero turbulence, emergent not special-cased. Landed entirely inside `world/wind-bake.js` (`applyWakeTurbulence` + `curlNoiseVector`, folded automatically into `bakeWindStructure`'s own `dvx`/`dvy` output, default-on, `wake:{strength:0}` the documented escape hatch to test the bare potential-flow relaxation in isolation) — **zero plumbing changes anywhere else**: `sampleWind`'s `bakedField` branch, the debug overlay/heatmap, the candle, and the dust particles' `windStructureGrid` (which already reads these raw `dvx`/`dvy` arrays directly per the particle-engine memory's fix-12/13) all pick it up for free, the same "one owner" discipline as the rest of this doc. A CPU-only hash-based value noise (`valueNoise2D`/`hashNoise2D`) stands in for `sampleWind`'s GPU-only `mx_noise_float`, since this whole file is deliberately TSL-free (bakes only run occasionally, on wall/door change, never per frame). Node-tested: divergence-free-ness is asserted EXACTLY (not approximately) by matching the outer finite-difference step to the curl's own internal `eps` — the same h≠eps mismatch measured a spurious ~0.5 divergence on a first pass, a fresh instance of `feedback_instruments_must_not_lie`'s own lesson (an instrument that isn't built right can lie about a correct implementation, not just a broken one). A second real test lesson: an early draft asserted "wake turbulence increases speed at this one stagnant cell" and that assertion legitimately FAILED — probing real numbers showed a divergence-free field only adds energy STATISTICALLY, not at every single point (a real eddy has slow cores too); the test was rewritten to assert what's actually guaranteed (the wiring reaches a stagnant cell at all, and the added delta scales EXACTLY linearly with `strength`) rather than a coincidence of one hash function's phase at one coordinate. **NOT yet live-verified** — same caveat as the rest of this tier ladder: `npm run verify` (2903 assertions) proves the pure math and the wiring, not the on-screen look. Ask the author to check the wind-field overlay/heatmap near a real building, and watch whether dust motes now get buffeted past building exteriors instead of sticking, before trusting this fully closed. A separate, NOT-fixed-here issue the particle-engine memory also flagged (`keyhole-particle-engine-next-session` round 11, fix-18): a "moat" of wrong exposure right at building edges (coarse exposure-grid resolution / mask edge-softening / possible no-slip-like behaviour) is a DIFFERENT mechanism (shelter/exposure, not velocity redirection) — this fix may make it far less noticeable or may reveal it as still-separate; re-check after a live look, don't assume this closes it.
- **Tier 3 — Emergent pressure (optional).** Region pressure differences so an open door/window drives flow with no scripted impulse, and a continuous vent while it stays open. The "simulation-adjacent" top rung — not needed to look good. Not started.

**THE WIND + PARTICLE PROBE — a diagnostic tool, BUILT, verify-green (2026-07-21), NOT yet live-verified.** Immediately after Tier 1.5 shipped, the author reported a precise, unexpected symptom from a live screenshot: interior rooms reading "awash with energy" (dust moving with similar-or-more energy than outdoors) while exterior particles still glued to a windward wall. Rather than patch blind again, the author asked for better diagnostics — specifically "like a pixel probe but for particles… I can click in hot and cold zones and get the information from the particles nearby." Built as the direct wind/particle analogue of the pixel probe (`diag/pixel-probe.js`): `MapShine.armWindProbe()` (or the debug panel's "🌬️🔍 Wind + Particle Probe" button) arms click-to-set-point mode (up to 3 points, 90s timeout, never steals a click from Foundry — the same discipline `armInteractivePixelProbe` already established); `MapShine.probeWindAndParticles([{x,y},...])` takes explicit world points from the console. For each point it reports TWO independent ground truths side by side: (1) the CPU-side bake's own decomposition (`diag/wind-probe.js#decomposeWindAt`) — ambient bias, the potential-flow structure term ALONE, the wake-turbulence term ALONE (previously inseparable — they arrived pre-summed in `dvx`/`dvy`), exposure, and whether the point is `enclosed` (inside a sealed room) or connected to open air, via a new flood-fill classifier (`world/wind-enclosure.js#floodFillOpenFromBoundary`, seeded from the map's own border); and (2) the ACTUAL nearest live particles' real GPU state (`particle-runtime.js#readbackNearestParticles`, a position-anchored cousin of the existing stride-based `readbackVelocities` — same buffers, same one-time GPU cost, no kernel/shader changes at all, since the selection is pure JS over already-transferred data). A mismatch between the two ground truths is the same species of smoking gun that found the particle engine's own fix-12/13 bugs. `bakeWindStructure`'s return grew `wakeDvx`/`wakeDvy` (the isolated wake delta, backward-compatible — `dvx`/`dvy` stay the full total every existing consumer expects) specifically so this split is possible. Two real lessons surfaced while Node-testing this tool itself: a divergence-free check must use the SAME finite-difference step as the curl's own internal `eps`, or it reports a spurious "leak" (an instrument bug, not an implementation bug); and "wake turbulence increases speed at this one cell" is not a real guarantee of a divergence-free field (it helps statistically, not pointwise) — both are recorded in the test files' own comments. **Live hypothesis this tool exists to confirm or refute**: the wake gate (geometry+stagnation only) cannot currently tell an exterior building face from a sealed room's interior — both produce the identical "near a wall, own flow suppressed" signature — and the particle kernel's own exposure-based damping (`stillness`, gated below exposure 0.2) leaves a real gap for rooms reading exposure 0.2–0.5 (per the particle engine's own fix-19 note: "real exposure masks rarely read a crisp 0"). NOT yet live-tested — ask the author to click a few interior and exterior points and compare `enclosed`/`wakeOnly`/the nearest particles' actual speed before drawing conclusions.

**ROOT CAUSE FOUND (using the probe above on its first live use) + TWO FIXES, BUILT, verify-green, same day.** The author's own probe data showed `exposure` reading `1` (fully outdoors) at all three points, including one confirmed 100%-black-pixel indoors — while the bake→particle wiring and the wall-redirect physics both checked out fine, ruling out the wake-gate theory above as the dominant cause. Root cause: `scene/mask-authority.js` is deliberately a PULL model ("staleness is lazy, not scheduled" — its own header) with no push notification; wind is the one consumer that CACHES exposure (`windExposureGrid`, for GPU-compute reasons), and its cache-invalidation triggers (`startup`/`manual`/`wall:*`/`ambient-change`) never included "the mask data changed" — so a snapshot baked before the outdoors mask streamed in (`bakeWindField('startup')` runs synchronously, before the async VT decode pipeline realistically could have delivered it) stayed wrong for the whole session. **Fix 1**: `mask-authority.js#getProductsVersion()` (cheap, never throws) polled every ~500ms by `vt-pan-viewer.js#pollMaskAuthorityForWindRebake`, triggering `bakeWindField('mask-change')` on any real change — the mask-driven analogue of the existing wall-change auto-rebake. **Fix 2, a separate author directive**: "the outdoors mask is a requirement not an option... if no outdoors mask is discovered then you need to just fail" — `outdoors` is now a `required` catalog kind (`scene/mask-catalog.js`); `sampleWorld`/`getDerived` throw `RequiredMaskMissingError` (propagating to `skyReach`) when a real floor has genuinely no discovered file, never for "discovered but not yet decoded" (a normal transient state). `boot.js#safeSampleOutdoors` catches it, logs loudly once per floor, and falls back to the old numeric default — now a REPORTED degradation, not a silent one. Full record: memory `keyhole-wind-wake-turbulence` (the diagnostic trail) + `keyhole-mask-authority` (the code change) + `feedback_required_masks_fail_loud` (the standing policy, including the author's named future direction: an in-app guided painting dialogue + Foundry regions as indoor/outdoor specifiers, neither built yet). NOT yet live-verified.

**Research groundwork for Tiers 2-3 now exists, separately from this design spec:** `docs/reference/wind-simulation-research.md` — real-world meteorology and urban-wind-engineering research, plus a paraphrased case study of _God of War_'s shipped production wind system (Sony Santa Monica, Sean Feely). Document-only; nothing in this file has been redesigned from it. Worth reading before Tier 2 design starts — it independently validates this doc's ambient+baked split and ~1-texel-per-grid-square resolution (a shipped AAA game uses literally the same shape, at literally 1 m³ voxels), and names concrete, portable techniques for magnitude scaling (Beaufort/Weibull-flavored continuous curves), hand-faked building wakes (Bridson's geometry-gated turbulence-behind-obstacles), diurnal variation (a 3-statistic cosine model), and noise seeding/coherence (Eiserloh's hash-based RNG; two production-proven noise-scale and cross-object-coherence fixes from _God of War_ itself) that a Tier 2/3 design would otherwise have to rediscover from scratch.

---

## 10. TRAPS (named now, so they can't rot in later)

- **Y-flip at the world→field seam** — a brand-new world→UV mapping. Verify orientation the first time and never assume (`feedback_y_flip_recurring_risk` — it has bitten the UI-shadow twice).
- **Conservative wall rasterisation** — coarse cells leak diagonally; over-seal, don't hairline (§4).
- **Derived once, not voted on** — the field is derived by the owner and _sampled_; never let a consumer re-derive wind. That re-derivation _is_ the V2 disease and the current candle bug (`feedback_probed_constants_vs_derived`).
- **It is for looks, not physics** — cap sim iterations, keep it coarse, and `log()` any cap (`feedback_instruments_must_not_lie`; no silent truncation dressed as full coverage).
- **Reflect-only doesn't conserve air** — an accepted look-cheat; the Jacobi iterations are the "more correct" dial, paid for only where the camera lingers.
- **BufferAttribute has no `dispose()`** — if any per-frame geometry ever feeds a contributor, reuse the array + `needsUpdate` (`reference_bufferattribute_no_dispose_trap`). The candle's batched geometry already does this correctly; copy that, don't the naive path.
- **VRAM is a non-issue** — half a megabyte at the worst map size; state it, because the 12k-map device-loss makes every new GPU texture look guilty until proven innocent.

---

## 11. WALLS & BUILD ORDER

**Tripwires** (each a build failure, not a comment — `Skeleton.md`):

1. **`wind/one-producer`** — falls out of `validatePassGraph` for free: only `sims.wind` may `create: ['res:wind']`.
2. **`wind/sample-through-the-door`** — no ad-hoc `sin`/noise "wind" in an effect shader once `res:wind` exists; you sample the field. (A `verify-structure` ratchet, sibling to `time/one-clock`.)
3. **`dials/valid-reference`** (existing) — every `WIND_DIALS.drives` key must exist in `WIND_PARAMS`, its `to` range within the param's `[min,max]`.
4. **`params/must-be-consumed`** (existing) — the sim's Technical knobs are checked read; an unconsumed one is surfaced by derived control-health.

**Build order** (declaration-first):

1. `world/wind-field.js` — the pure `sampleWind()` fn + `WindContributor` shape + `validateWindContributor` (Node-tested, before any GPU).
2. **Tier 0** — repoint candle flame + light at `sampleWind`; delete the two divergent noises. Live-verify the flame/light now lean together.
3. `WIND_PARAMS` + `WIND_DIALS` (validated) → the pass appears in both houses for free.
4. `sims.wind` seam (throwing `NotBuilt` door in `graph/pass-seams.js`).
5. Tier 1 bake (built) then Tier 2 sim (built, §9) — NEITHER yet measured in the 🔬 lab (needs a live session; the debug panel's "🌬️ Force sim running" select exists specifically so a future session can run Tier 2 through the sweep).

**The velocity test governs it** (`Skeleton.md` law 2): declaring a `WindContributor` + a `windResponse` knob must be _faster_ than an effect hand-rolling its own wind, or this loses exactly as V2's abstractions lost. One declaration → a shared field read, both UI houses, dead-control detection, all free. That asymmetry is the only thing that keeps the wall a rail.

---

## 12. LESSONS, CARRIED FORWARD

- **Wind is a resource, not a habit.** V2's wind rotted because it was re-derived per consumer with nothing to keep them agreeing. One producer, one `sampleWind()`, contribution as declared data — the pass-DAG's cure, applied to air.
- **Coarse is not crude.** Low-frequency + free bilinear + architecture-scale features means a half-megabyte grid _is_ the whole map's wind, convincingly.
- **Emergence where it's cheap, authoring where it counts.** Corridors fall out of a wall-bounded relaxation for free; the GM still gets honest dials and named presets over the top.
- **The sim must be able to sleep.** Hybrid freezes to zero cost when nothing is happening, which — in a candlelit castle — is most of the time.

---

_V2 gave every effect its own private wind and no way to keep them agreeing — a single candle's flame and its own light lean in different directions today. V3 gives the whole map one field: analytic where it can be exact, baked where it channels through walls, simulated only when a door actually opens — produced once, sampled everywhere, contributed to as declared data, and dialled by an average human through a few honest controls that cannot die in silence._
