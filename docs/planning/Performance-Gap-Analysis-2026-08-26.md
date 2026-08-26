# Performance Gap Analysis — 2026-08-26

**Purpose:** a full-corpus audit of every performance-related proposal in this project's documentation
(holy docs + planning docs + bug tracker + perf-report history), cross-referenced against current
source and the freshest live capture, specifically hunting for proposals that are partial, stalled,
or never actually landed. Requested by Ingram, 2026-08-26. Method: 7 parallel research passes plus
direct reads of ~15 shorter documents, ~13,000 lines of source documentation covered in total.

**Status vocabulary** (matches this project's own two-word convention — see `MEMORY.md`):
`NOT-STARTED` · `DESIGN-ONLY` (spec written, zero code) · `PARTIAL` (some of it shipped, real gap
remains) · `BUILT-NOT-LIVE` (code + tests exist, never confirmed on a real running scene by Ingram)
· `LIVE-CONFIRMED` (Ingram's own eyes verified it) · `DEFERRED-DELIBERATE` (a real decision to not
do it yet, with a stated reason) · `SUPERSEDED` (goal met a different way, or plan abandoned for
a good reason).

---

## Headline meta-findings (read these first)

1. **Both of the project's major roadmap documents have gone dormant while real work kept
   happening around them.** `docs/holy/V4-Testament.md` (the master "Book I" performance
   checklist) has not been edited since 2026-08-15 (P-012) — 11 days of real, substantial perf
   work (structure-gate fixes, the water/sun-shadow bake throttles, the `gateGlass` window fix,
   the floor-switch GPU warm-up) landed in that gap and is not recorded there. `docs/holy/
   V4-Reckoning.md` (the 41-subsystem audit campaign) has had **zero commits since the day it
   opened**, also 2026-08-15 — three of its four phases (R1 seeded strikes, R2 full sweep, R3
   cross-cutting sweeps, R4 close-out gates) are 100% untouched. Treat every "closed" status
   below as closed-as-of-the-source-doc's-last-edit, not closed-as-of-today.
2. **`docs/holy/Water-Testament.md` has exactly one git commit in its history — its creation.**
   Real, shipped, sometimes live-confirmed work (foam-memory, the pier-wake fix, two foam-bleed
   fixes, the sharpness recalibration, the bake-throttle) never got written back into it. Its own
   checklist currently shows the foam-memory system as not-started, which Ingram herself
   confirmed live on 2026-08-19 — the doc isn't just stale here, it's **factually wrong**.
3. **`geometry.worldDraw` — today's single dominant frame cost (25.49ms, 79.1% of frame GPU) —
   has no proposed fix anywhere in any document read across this entire audit.** Real fixes
   *have* landed against it before (coverage meshing, the depth-authority pass reorder — see
   §1), and they produced huge wins on the internal Mansion bench (−90% cumulative). But nothing
   currently on paper explains why it's back at the pre-fix ballpark on the Town River Bridge
   map, or proposes what to do about it.
4. **The "Shade Once" early-Z optimization (Stage 1) — this project's flagship fill-rate lever —
   has come back inconclusive on real map content in every single live capture that has ever
   tested it there (three independent captures, three different dates).** It only ever proved
   its value on the internal bench scene. Nobody currently knows whether it helps, hurts, or
   does nothing on the maps that actually ship.
5. **A cluster of measured, dramatic wins are sitting at `BUILT-NOT-LIVE` purely because nobody
   has looked at them yet** — not because anything is wrong. The residency-streaming fix alone
   (§3) is a confirmed 677×/32.9× reduction and only half of it has Ingram's sign-off.

---

## 1. Book I — The Performance Stages (`docs/holy/V4-Testament.md`)

Scoreboard target: 8–18ms total GPU by Stage 6/7, against a 47.05ms baseline.

| Stage | Goal | Status | Note |
|---|---|---|---|
| 0 | Instrument the frame | LIVE | Base perf-report tooling; RenderBundle probe passed (1.8–2.6× CPU win, see §10) |
| **1** | Shade every pixel once (early-Z via depth authority) | **LIVE-CONFIRMED (non-breakage only) + unresolved value** | Flag ON by default (`earlyZComposition`, `vt-pan-viewer.js:11956`). Ingram's own S1.8 verdict was "loaded the scene, nothing broke" — not a full sweep. Bench win was already sub-target (1.55× vs a 2× bar). **On real map content: inconclusive 3 times running** (v0.6.1 review, 2026-08-25, 2026-08-26 — none clear the noise floor either direction). |
| 1 (sub) | Per-cell interior/boundary split (DEFERRED-S1a) | **PARTIAL** | `alphaMinGrid`/`splitCoverageCellMask` built, tested, cached — zero live call sites. The wiring at `applyEarlyZTileState` was never written. A follow-up census also found 3 of 8 Ground Floor tiles are `untagged` — outside Stage 1 entirely, a separate never-addressed gap. |
| 1 (sub) | Depth-proxy material pooling (DEFERRED-S1b) | **BUILT-NOT-LIVE** | Fixed the TSL shader-graph rebuild churn (was 10.7% of the whole main thread, confirmed via Chrome trace). Re-traced result: 72.1ms/13fps frame → ~8.3ms/~120fps steady. No pixel-diff gate exists (pure allocation change); no recorded Ingram verdict for this specific fix. |
| 1 (sub) | `geometry.depthRenderCall` CPU cost | **NOT-STARTED / open mystery** | Narrowed across 3 investigation rounds (a mislabeled zone was fixed), the underlying ~11.6ms/frame CPU cost itself was never solved. |
| **2** | One draw for many lights (point-light batching) | **LIVE-CONFIRMED** | Ingram's own words drove the default-ON flip. Pixel gate byte-exact. Current live data: batched-bucket caches ~100% hit rate, the old unbatched pool shows zero activity — full cutover looks real. |
| 2 (sub) | S2.8 Region-darkness batching (8 draws → 1) | **DEFERRED-DELIBERATE** | Explicit written policy, not an oversight. `light.drawRegions` still shows 10 draws today, consistent with this being un-built. |
| 2 (sub) | Window-light folding into the batch | **DEFERRED-DELIBERATE** | Numbers recorded, explicitly not built. |
| 2 (sub) | S2.9 idle-machine bench gate | **NOT-STARTED** | The formal acceptance test for the whole stage was never run, even though today's real-world signal (near-100% batch hit rate) suggests it's fine in practice. Gate and reality have diverged without anyone closing the loop. |
| 3 | Merge bloom+DoF+grade+tonemap+present into one shader | **NOT-STARTED** | Source-confirmed: only `grade` has folded into present; bloom/DoF remain separate passes. The "is `present.blit` running twice redundantly" question was never investigated. |
| 4 | CPU diet | **PARTIAL** | See breakdown below. |
| 4 (sub) | RenderBundle adoption | **NOT-STARTED, despite a passed prerequisite** | 2026-08-10 probe confirmed a real 1.8–2.6× CPU-encode win on representative material, real WebGPU, twice. Zero adoption anywhere in MSA's own code since. |
| 4 (sub) | Static-scene CPU reduction (matrixAutoUpdate off, pre-sorted lists, consolidated uniforms, render-call census) | **NOT-STARTED**, all 4 items | |
| 4 (sub) | Perf-instrumentation self-cost (astrolabe HUD, `describeRenderMode` throttle) | **BUILT (dev-verified, not Ingram-verified)** | See §11. |
| 4 (sub) | Point-light wall-clip perf zone | **DEFERRED-DELIBERATE** | Honest reason given: needs a first-time architectural change beside the sensitive Foundry lighting/vision adapter. |
| 4 | Gate: render-loop CPU ≤8ms | **NOT-STARTED / not formally measured** | |
| 5 | Kill the 783ms tail | **NOT-STARTED**, mostly — one item silently progressed elsewhere | Stage 0's own hitch autopsy never identified the mechanism, so nothing downstream can be actioned yet. **Except:** "render targets + pipelines preallocated across floor switches" (still unchecked in the Testament) actually shipped 2026-08-24 as Bug #30's fix (floor `prepare` now does full GPU pipeline warm-up) — real progress, tracked entirely outside this document. Also independently flagged: `Moonshot.md` names this exact 783ms-class hitch as its own still-open, unchecked task with a proposed `PerformanceObserver` longtask diagnostic never built. |
| 6 | The Keel (FrameGraph rebuild) | **NOT-STARTED / DESIGN-ONLY** | `class FrameGraph` exists (`src/graph/frame-graph.js`) but is constructed only in its own test files — zero production call sites. |
| 7 | The Bake (toroidal clipmap static-composite cache) | **NOT-STARTED** | Zero code footprint anywhere in `src/` for this concept. The literal "moonshot pillar," fully designed, fully unbuilt. |

**Cross-cutting findings from this document, not tied to one stage:**

- **"GPU-submission-bound" is `SUPERSEDED` as a general claim.** An idle 11s capture found a
  36-point CPU/GPU gap (GPU-bound). A 36s camera-stress capture of the same machine found only a
  7.5-point gap — inside the "neither dominates" band. GPU-boundness is a property of the idle
  regime, not the engine.
- **Duplicate-geometry submission — open across at least 3 captures.**
  `geometry.earlyZPrepass`+`geometry.depthDraw` and `light.drawPointLights`+`light.drawColoration`
  each submit matching draw shapes twice per frame. Nobody has determined whether the second
  submission earns its keep, in three separate live reports.
- **CAS/Albedo-Clarity sharpening A/B — inconclusive, shipped OFF.** First live capture:
  `within-noise`. A real, root-caused chromatic-fringing bug (R/G/B channels sharpened
  independently) was found and **deliberately left unfixed** — two candidate fixes didn't cleanly
  resolve it, so the algorithm ships unchanged with a permanently-failing regression scenario
  documenting the gap for whoever picks it up next.
- **Bloom/DoF performance-tier rungs — confirmed genuinely not built**, and unusually
  well-self-documented: both `bloom.js` and `depth-of-field.js` carry their own in-code
  `deferredRungs` lists explicitly stating "recorded, NOT built."

---

## 2. The Reckoning (`docs/holy/V4-Reckoning.md` + `docs/planning/reckoning/SURVEY-*.md`)

A 41-subsystem audit campaign opened 2026-08-15, triggered by Ingram noticing that going up one
floor cost ~10× more render time where ~2× was expected. Canonical test: bench Mansion Redux,
parked camera, ground vs. first floor.

**Headline finding (`F-R0.1.1`):** with all 15 effects disabled, floor 0 hit its 120fps refresh
cap (GPU ~3.0ms) while floor 1 took 61.5ms/16.3fps — **only ~22% of that frame landed inside any
measured zone.** ~83% was invisible to every profiler bracket.

**Root cause found and fixed the same day (`F-R0.1.7` → Bug #21):** Foundry's own PIXI renderer
was still re-rendering the whole primary map layer into a texture every frame, in a separate GL
context no MSA zone can see — leftover from an earlier fog-of-war fix. Suppressing it: **26.9fps
→ 119.8fps (vsync-capped)**, hitches to zero. Status: **BUILT-NOT-LIVE, ON by default** — needs
Ingram's eyes with a controlled token specifically.

> ⚠️ **Caveat for anyone citing today's high attribution-coverage numbers (97.7%/95.8%) as proof
> this is fixed:** the only fresh capture on disk is a *different* configuration (Town River
> Bridge, floor 2, touring camera, effects ON) than the Reckoning's own canonical test (bench
> Mansion, floor 1, parked, effects OFF). High coverage on real map floors is circumstantially
> consistent with the fix working — it is not proof. The literal re-test (`R0.1`) has never been
> run.

**Campaign progress:** the opening phase (R0) got real work. **Phases R1 (7 seeded rows), R2 (34
more subsystems), R3 (7 cross-cutting sweeps), and R4 (7 close-out gates) are 100% untouched.**
Zero pass reports exist anywhere in `docs/planning/reckoning/` beyond the 7 opening scout surveys.

**Confirmed-still-open, never fixed:** `F-R0.1.4` — 2 map items silently fail texture
compression, fall back to raw decode with no alpha stats, pay full uncertified footprint forever.
Root cause never found, no owner.

**Seeded leads worth surfacing** (21 total identified, all `NOT-STARTED` — the formal audit
protocol was never run on any of them):

| Lead | Finding |
|---|---|
| SL-9 | **A second WebGPU device renders an empty scene every frame, forever** (the debug HUD's heartbeat). Never measured. |
| SL-16 | Triple rasterization: depth pass + early-Z prepass + colour pass all draw the same geometry (~3× fill for the same tiles). Was "prime suspect" for the 83% mystery, then deprioritized once the second-renderer cause was confirmed sufficient — but never independently falsified or fixed. |
| SL-8 | 6 sun-shadow slots sampled per fragment in every lighting material, unconditionally, even with 1 floor loaded. (Independently corroborated by the Performance-Audit doc's own §6.3.) |
| SL-12 | Sun-shadow bakes can cascade — one sun-tick can trigger 6 bakes in a single frame (per-floor chaining). |
| SL-18 | The albedo-sharpening shader is actually a 9-tap fragment (the in-code comment claims 6) with a dual-MRT blended write, and **fails OPEN to the expensive path** on a settings-read throw. |
| SL-19 | Panning triggers a full residency pass + 2N depth-proxy mesh allocations every frame; the world-scene sweep walks every mesh *ever added this session* — nothing is ever removed. |
| SL-20 | A silent IndexedDB quota-exceeded swallow, plus 9 generations of never-deleted cache-version records pushing toward the very quota limit that then silently breaks future writes. |
| SL-4 | Boundary/declined-split tiles still pay full blended+discard cost — Stage 1's per-cell rescue only ever reached ~39% of First Floor's kept cells. |
| O13 (survey) | A real correctness bug found along the way: Case-1 vegetation tiles **keep running their wind shader after the vegetation effect is disabled**, until scene reload. |
| O16 (survey) | Duplicate of SL-18's "fails open" pattern, independently found: CAS sharpening defaults to the expensive path if a settings read throws before the profile is ready. |

**`SURVEY-core-draw-population.md`'s own priority ranking** (the closest thing the campaign has
to an actual fix roadmap, all five `NOT-STARTED`): (1) triple rasterization [SL-16], (2) stacked
uncertified boundary layers [SL-4], (3) mip-0-pinned texture taps bypassing anisotropic
filtering, (4) the 9-tap/dual-MRT sharpen [SL-18], (5) the per-frame residency/proxy-rebuild
storm [SL-5/SL-19].

---

## 3. Residency streaming — the single largest confirmed win in the project

Two-layer fix (`docs/holy/V4-Testament.md` P-011): both `ensureItemLoaded` and
`updateResidencyUnguarded` were declared `async` even on their fully-synchronous "nothing to do"
fast path — every `await`, even on an already-resolved value, defers to the microtask queue and
pays real wall-clock latency.

- **Layer 1** (item-load fast path): `residency.itemLoad` mean **6.776ms → 0.01ms — a 677×
  reduction.** **LIVE-CONFIRMED** — Ingram's own words: *"Nothing seems to be broken by it and
  performance on the upper floor is hovering around 30-35 fps. That's a serious improvement."*
- **Layer 2** (pass-level fast path): `residency.pass` **7,028.9ms → 213.9ms — a 32.9×
  reduction** on top of that. **BUILT-NOT-LIVE.** The document's own closing line: *"Not yet the
  author's own LIVE verdict."*

A separate, earlier correction to this same area: `residency.pass`'s reported time was shown to
be **wall-clock, not CPU-busy** — it genuinely overlaps normal frame rendering for at least part
of its span, so the original "29.2% of wall-clock time" framing should not be read as "29.2%
stolen from the frame budget." A related **measurement artifact** (a CPU-only zone was
inheriting bogus drawCalls/triangles numbers from whichever frame happened to be rendering while
it sat open) was found and fixed the same investigation — confirmed still holding in today's
live data.

**Still open:** parallelizing the sequential per-item/per-mask await chains for genuinely NEW
items (a `Promise.all` rewrite, concurrency headroom already exists unused) — investigated,
found straightforward, **deliberately not attempted**: this exact suspension point has caused two
real shipped regressions before (a vegetation flicker, a whole-screen magenta bug). Needs a live
session, not a benchmark-only change. Also still open: 20 worst-case hitches (250–667ms) with
provably idle decode/cache activity — the mechanism was never identified, flagged unresolved in
two independent documents.

---

## 4. The structurally-unpriceable effects

Standing instrumentation gap named 2026-08-12: some effects draw inside a shared scene/material
with no bracket of their own, so their true GPU cost can never be isolated — not even by the
effect on/off sweep. **Today's live data still shows this true for fire, water, and grade** —
and this document found **no proposed fix for any of the three anywhere** in the whole corpus.

- **fire** — its state-sync and particle draw are zoned, but its *light sources* (built inside
  the same sync call) merge into the shared, null-owned point-light draw zones.
- **water** — the JFA body bake, surface sync, and flow-pack bake are zoned; the tier-0 surface
  draw itself sits at a fixed render order inside the shared world-scene pass, same structural
  situation as vegetation.
- **grade** — folded directly into the present-composite shader by deliberate, *conditional*
  design (`docs/planning/Grade.md` §5): *"the standalone pass lands only if a later rung needs a
  target between grade and present."* Not a gap — a named, self-documented, correctly-deferred
  choice. No current rung forces the split.
- **apertureGobo** — its own debug-visualization draw is zoned; the real per-fragment gobo
  pattern cost is baked into the shared point-light materials. `docs/planning/Aperture-Gobo.md`
  (1643 lines) never once discusses this measurement gap — it predates the whole
  instrumentation effort.
- **fluid** — same shape as water: sim tick and sync are zoned, the absorb/emit surface draw is
  not. `docs/planning/Fluid.md` names the *exact* trigger that would force this to become a real
  pass: tier 6 ("optics," a `buf:scene.color` dependent read) is the first rung that requires
  it. **NOT-STARTED** — tiers 0–6 through "structure" are done, tiers 7–8 aren't.

**Correction worth flagging:** `depthOfField` is **not** part of this list the way today's raw
report framing might suggest. It has real, declared zones (`post.dof`, CPU + 2 GPU sub-zones,
a stated budget) — better static coverage than any of the four above. It read as
`zoneCoverage:'none'` in one capture purely because that capture was on floor 0, where DoF is a
JS early-return by design (nothing can be "below" the ground floor to blur). A same-week capture
on a different floor measured it cleanly: 0.353ms, 32% of budget, fine.

**Also confirmed still open:** the automated reporting engine itself has an asymmetric blind
spot — `declared.verdict:'under'` is computed exactly like `'over'`, but only `'over'` ever
becomes an automatic finding. Named and deprioritized in the 2026-08-12 audit, never revisited.
Real, current cost: the 2026-08-25 report's human-authored synthesis had to manually call out
that Bloom/DoF/doors were comfortably under-budget — the automated findings engine can't surface
that on its own.

---

## 5. Water

Full tier-ladder/visual-fix history lives in `docs/holy/Water-Testament.md` and the project's
own memory system (extremely detailed) — not re-derived here. This section covers what's
specifically **performance**-relevant and not already tracked elsewhere.

- **Tier 5 refraction — only half live-confirmed.** Distortion is confirmed live (Ingram: *"no
  runaway feedback loop"*). The shadow-on-water regression that followed it was fixed the same
  day but its own commit ends *"Not yet confirmed live"* — no later commit re-confirms it.
  **Do not treat both halves as equally confirmed.**
- **Bake-throttle fix** (`ae737ff`, 2026-08-25) — root cause was `maybeBake`'s gate reading a
  single scene-wide version counter, so *any* unrelated scene edit anywhere triggered a full
  water rebake + JFA flood. Live-profiled cost: **`uploadMask` alone was 89.1ms, 47.9% of one
  captured frame.** Now throttled to 150ms. **BUILT-NOT-LIVE.**
- **Sun-shadow's identical bug is being fixed right now, uncommitted, mid-flight** —
  `sun-shadow-subsystem.js` shows a live +139/−16 diff and an untracked new test file as of this
  writing, explicitly modeled on water's fix.
- **Cache-report blind spot, since fixed:** the water bake-gate's cache-health row was silently
  reading `null` for 10 days after an unrelated shape migration — the exact regression the
  throttle fix addresses would **not** have shown up automatically in a report during that
  window. Fixed 2026-08-25.
- **Red-black SOR replacing plain Jacobi in the flow solve** — a real, *measured* ~6× GPU-cost
  increase deliberately traded for correctness (plain Jacobi's convergence was diagnosed as the
  actual cause of "water doesn't route around obstacles"). Contributed to the later live
  "Huge progress... foam pushed down stream" confirmation (2026-08-19).
- **Zero-speed ("pond") early-out for the flow bake — explicitly not built.** A still-water body
  runs the full 5-level solve cascade for no visual benefit. Named as "a reasonable follow-up,
  not required for correctness."
- **`WATER_FLOW_GRID_MAX_DIM` 1024→1536 — a perf-motivated coarse-resolution choice that was
  later proven wrong and reversed.** The original assumption ("velocity is smooth, doesn't need
  fine resolution") stopped holding once flow-warp/foam-nudge needed sharp obstacle-relative
  bending. Correctness required more resolution, cost more GPU/VRAM.
- **A 3× supersample attempt on the body-pack SDF was tried and reverted** — pure wasted cost,
  since the grid is point-sampled and has no sub-texel coverage to find at any sampling rate.
- **The water tier ladder is itself under a pending, unmerged revision.** A separate
  author-commanded doc (`Water-Simulation-Turn.md`, 1387 lines) proposes amending the Testament's
  own ladder and phase order — explicitly states the fold-in "never happened." It also confirms:
  clumping/breaking (S6) is genuinely `PARTIAL` (static tear-apart exists, dynamic doesn't); the
  sediment and particle/bubble/splash tiers (S7/S8) carry no status tag at all — untouched;
  whitecaps are blocked on a "wind covenant" prerequisite with zero related commits.

---

## 6. Window light

- **Today's live gap:** 0.691ms/frame, **1.57× over its declared budget** — real, measured
  progress from 5.67× as of the previous capture (2026-08-25), thanks to the `gateGlass` fix.
  **Still over.**
- **There are two separate, easily-confused gates, and only one is fixed.** `gateGlass` (skip
  the entire glass/dispersion/caustic computation on floors a per-pixel gate already zeroed) —
  **DONE**, wired 2026-08-25, currently sitting uncommitted in the working tree. `glass` (the
  *actual* original audit finding — a compile-time JS branch that should read
  `glassWarpPx > 0` so a zero value truly removes the noise/caustic subgraph at the shader-graph
  level, not just skip it per-fragment) — **confirmed still hardcoded `true`, unconditionally,
  at the one production call site.** This is the lever nobody has pulled yet.
- **No document proposes anything else that would close the residual gap.**
  `docs/planning/Windows.md`'s own forward roadmap (tiers 1–9: sky-drive, drift, moon, cloud,
  occlude, stretch, bounce, shaft, motes) is **entirely cost-additive** — every one of those
  rungs would make the current overage worse, not better, once built.
- The tier-0 architecture itself is confirmed correctly shaped (V2's 500MB+ per-floor emit
  buffer was deleted outright, not resized) — this is a tuning gap on an architecturally sound
  design, not a design flaw.

---

## 7. Sun shadows — three parallel threads, easy to conflate

1. **The band-height cascade** (`Sun-Shadow-Cascade.md`) — BUILT, lab-verified against real
   Tower Bridge art, **not live-confirmed** as of 2026-08-05. Net cost REDUCTION already shipped
   alongside the feature (13→10 texture reads per station). One real, costed, un-actioned lever
   named directly: `SHADOW_BAND_COUNT` is fixed at 2; raising it to 3 would add ~96MB across the
   6-slot floor pool at the Extreme tier — "should be measured, not assumed."
2. **The bake-cadence throttle** (matches water's fix, §5) — sun-shadow's half is **actively
   mid-flight, uncommitted, right now.**
3. **CORRECTION (2026-08-26, caught during the follow-up instrumentation session): the "march
   vs. smear" comparison below does not exist to run.** `Sun-Shadows-Redesign.md` (last touched
   2026-08-01) describes a live `shadowModel` toggle and calls the side-by-side comparison "the
   one thing blocking a decision" — but that document's own roadmap step 6 already said the
   toggle should be deleted once smear was approved, and a direct source check confirms **that
   step has since executed**: there is no `shadowModel` field, no `march` branch, and no toggle
   anywhere in current `src/`. `sun-shadow-subsystem.js`'s own header calls layer-smear "2026-08-02
   — replaces the column march and the averaged-mean smear that briefly followed it." One model
   exists today, unconditionally. This is the exact "holy/planning docs go stale" pattern this
   audit itself flagged as a standing risk — caught here by re-checking source before acting on
   the doc's claim, not by luck.

Also already done and confirmed real: the per-light CPU shadow march (16 steps × 3 grids × N
lights, every frame) was replaced with a single per-fragment GPU sample sharing the baked field
— removed a genuine per-frame CPU cost. March step count was also reduced 32→24 with a paired
length cap.

---

## 8. Cross-cutting engine & instrument gaps

| Item | Status | Note |
|---|---|---|
| `boot.js`'s Level/Tile CRUD hook (arity-1, discards Foundry's real signature) | **NOT-STARTED, confirmed still present** | Fires the full mask-authority re-derive cascade on *any* write to *any* Tile/Level document. The fix template exists two files away (`scene-walls.js`/`sky-persistence.js` both correctly filter on `change`). Named across 3 separate documents, none of which report it fixed. |
| RenderBundle adoption | **NOT-STARTED despite a passed probe** | See §1. |
| GPU timestamp query pool (1024 outstanding passes) overflowing on light-dense scenes | **Accepted limitation, not a live bug** | Investigated: root cause is real light density (~117 lights × 2 passes = 250-300+ passes/frame against a hardcoded, seemingly non-configurable 2048-slot vendor pool), not a stuck resolve. One Reckoning agent flagged this may be a hard WebGPU-level ceiling rather than a tunable constant — worth a feasibility check before assuming it's fixable at all. |
| `declared.verdict:'under'` finding blind spot | **NOT-STARTED** | See §4. |
| `describeRenderMode` diagnostic cache low hit rate | **NOT-STARTED, flagged in 3 separate dated reports** (v0.6.1: 41.5%, 2026-08-25: 37.1%, today: 40.4%) | Low priority (diagnostic-only), but nobody has ever looked at why its invalidation key churns. |
| No independent fallback for GPU-pass attribution | **Standing architectural gap** | MSA's own zone timer is the *only* instrument that can see per-pass GPU cost — Chrome traces can't see Dawn/WebGPU categories at all, so there's no cross-check if the zone timer is ever wrong. |
| VRAM headroom tripwire (~70% warning, naming top consumers) | **DESIGN-ONLY, proposed 2026-08 in the project's own foundational design doc, never built** | Confirmed still missing: today's VRAM section is a single end-of-window snapshot with no peak-over-time tracking. |
| Disk-quota (IndexedDB) governance — no cap/eviction policy across scenes/worlds | **NOT-STARTED** | Distinct from the already-thorough runtime cache-hit reporting (39 rows) — this is about the on-disk pyramid/BC-cache stores never being bounded. |
| BC-texture-encode worker pool (2 concurrent) | **NOT-STARTED, "flagged rather than built"** | Doubling it would roughly halve the ~20–40s first-load tax per item. |
| WebGL2 middle fallback rung + GM-enforceable mid-session forced downgrade | **PARTIAL** | The bottom rung (full Foundry-native fallback) is live. The middle rung isn't scheduled to any stage yet. |

---

## 9. UI / diagnostic self-cost

- **The astrolabe debug HUD's `innerHTML`-every-frame cost — mostly fixed.** Originally measured
  at 2,451ms / 6.9% of one 36-second trace while the panel was open (94% of *all* DOM-write cost
  in that capture was MSA's own diagnostic UI). The two largest contributors (89% of the total)
  were dirty-checked the same day the bug was found. A smaller tail (~13%, three minor
  contributors) was named in the same investigation's recommendations but never independently
  confirmed fixed.
- **Law 11's own UI performance budget (≤0.3ms steady-state, zero per-frame DOM writes while
  idle) has never actually been measured against.** The instrumentation to do it
  (`diag/ui-perf.js`) was built and wired into the perf report — but no number has ever appeared
  in any report showing a pass/fail against the 0.3ms figure. The master UI checklist item for
  this ("UI frame-cost row lands in the perf report") is also still unchecked, even though a
  separate narrative section of the same document describes the work as fully done — an
  internal doc contradiction.
- The "LAB department re-home" plan (moving the debug panel to a cleaner architecture) is
  explicitly a re-home, not a rewrite — worth noting that even once built, it would carry
  forward any remaining per-frame cost inside today's ~1,250-line debug panel unchanged, not fix
  it.

---

## 10. Performance-relevant entries from the Bug Tracker

Of 30 total logged bugs, 5 are performance-related. None have been promoted to `LIVE` — all sit
at `BUILT-NOT-LIVE` or `PARTIAL`.

- **Bug #21** — the Reckoning's second-renderer fix (§2). Measured **26.9fps → 119.8fps**
  suppressing it.
- **Bug #20** — First Floor's depth/early-Z passes cost ~9.5× Ground floor's; fixed and
  *measured engaged* (~5.2×/3.6× improvement) but not yet author-confirmed on the visual look.
- **Bug #16** — a real crash risk: an untiled specular mask on a 12,000px map can exceed
  WebGPU's buffer limit. Immediate ceiling-raise shipped; the durable fix (adaptive downscaling)
  hasn't started, pending Ingram's call on the visual tradeoff.
- **Bug #30** — floor switches could freeze the UI over a minute; a GPU pipeline warm-up fix
  landed but deliberately doesn't yet reach vegetation, doors, particles, or candles.
- **Bug #18** (borderline — primarily a correctness bug) — its fix deliberately gives back some
  suppressed per-frame render-to-texture cost; the one reading taken (53fps vs. a 67fps
  baseline) is explicitly disclaimed as not a controlled A/B.

---

## 11. Superseded / abandoned plans (for completeness, not action)

An entire earlier migration plan (`Forward+.md` + the `docs/planning/v3/B0-*.md` series) targeted
incrementally evolving the old `scripts/` V2 codebase. **That path was not taken** — a clean
rewrite happened instead (now `legacy/` holds the old code for reference only). Several of that
plan's *goals* did carry forward through different mechanisms and are worth knowing about:

- Collapsing per-floor render-target stacks into one unified pass — **LIVE-CONFIRMED** via the
  rewrite's own architecture.
- Eliminating the per-frame PIXI→Three GPU readback — **architecturally eliminated** via the
  "interface seam" locked decision (drawings/templates/sounds stay native in PIXI).
- A real production crash was root-caused to a GPU driver timeout from a blocking synchronous
  pixel readback (not memory pressure, as an earlier investigation had assumed) — this is now
  **permanently enforced** by a `no-gpu-readback` structural gate in the build. Worth flagging:
  that gate currently has one live, unaddressed violation
  (`src/effects/vision/vision-mask-render.js:857`), per this project's own most recent
  `verify:structure` run.
- SVT/tiled mask streaming — superseded by the current virtual-texture residency system, which
  does it better.
- KTX2/Basis texture compression — superseded by a different compression approach (BC1/BC7) in
  the same residency system.

---

## 12. Ranked "what to do next" — highest value, lowest effort first

1. ~~Get Ingram's live look at the sun-shadow "smear" model vs. "march."~~ **RETRACTED
   2026-08-26** — there is only one shadow model in current code; this comparison doesn't exist
   to run. See the correction in §7.
2. **Run one capture with the performance-profile setting switched off "standard."** A real,
   already-shipped material fix (1-tap vs. 7-tap sharpening) has never been exercised by any
   live report, because every capture to date has used the default profile.
3. **Give the residency-streaming Layer 2 fix (§3, a confirmed 32.9× reduction) and the
   vegetation depth-proxy pooling fix (~120fps confirmed by trace) a live look.** Both are
   sitting done and clearly working, just unsigned-off.
4. **Re-run the early-Z ("Shade Once") A/B on an idle machine, on real map content, not the
   bench scene.** Recommended in writing at least 3 times since 2026-08-13. The project's
   flagship optimization's real-world value is currently unknown.
5. **Fix `boot.js`'s arity-1 CRUD hook.** Named, exact function, exact known-good template two
   files away. Small, contained, been sitting untouched across 3 separate audits.
6. **Finish the sun-shadow bake-throttle** — already mid-flight, uncommitted, mirrors water's
   shipped fix exactly.
7. **Wire the actual `glass = glassWarpPx > 0` gate** (distinct from the already-shipped
   `gateGlass`) to close more of window light's residual 1.57× overage.
8. **Get Ingram's controlled-token verification on Bug #21** (the Reckoning's second-renderer
   fix) — the single biggest confirmed win in the whole project (up to 4.4× fps on the affected
   floor) is one live check away from being fully trusted.
9. **Adopt RenderBundles.** A proven 1.8–2.6× CPU-encode win from a 2026-08-10 probe has never
   been used anywhere in production code.
10. **Add the zero-speed ("pond") early-out to water's flow bake.** Small, explicitly named,
    pure GPU-cost win with no correctness tradeoff.
11. **Fix the `declared.verdict:'under'` blind spot in the reporting engine itself.** Small, and
    it's already causing extra manual work in every report's human-written summary.
12. **Dirty-check the remaining ~13% tail of debug-HUD DOM cost** (`perf-strip.js` ×2 and
    `describeRenderMode`) — the same fix shape already proven on the larger 89% that's done.

---

*Full agent-level source detail (file:line citations, git commit hashes, direct quotes) for every
finding above is available in this session's transcript. This document is the durable summary;
treat the live `perf-run-full` report as the ground truth for current numbers, and this document
as the map of what's been proposed against them.*
