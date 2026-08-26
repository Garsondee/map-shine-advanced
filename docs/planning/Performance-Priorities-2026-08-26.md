# Performance Priorities — 2026-08-26

Technical backing record for the "Performance Ledger — Priorities" Artifact delivered the same
session. Full citations live here; the Artifact is the plain-language delivery format
([[feedback_performance_report_format]]). Sequel to
[`Performance-Gap-Analysis-2026-08-26.md`](Performance-Gap-Analysis-2026-08-26.md) (proposed vs
implemented, built that morning) — this doc asks a narrower question: **given the two live
captures taken since, what should we actually go after next, ranked by bang-for-buck?**

## Evidence base

- **Primary**: the latest live `perf-run-full` capture, `generatedAt 2026-08-26T14:06:08.835Z`
  (Town River Bridge, Ground floor start, 3-floor sweep, 57s/1751 frames). Referred to below as
  **"the latest report."** Saved in full to this session's tool-results; condensed companion at
  `docs/planning/perf-reports/2026-08-26-town-river-bridge-ground-floor-round2-verify.json` (from
  the immediately-prior capture, `13:25:04Z`, numbers within noise of the latest — cited only where
  it adds a data point the latest report doesn't independently confirm).
- **Cross-referenced**: `Performance-Gap-Analysis-2026-08-26.md`, `keyhole-performance-audit-2026-08`
  memory (→ `Performance-Audit-2026-08.md`, `Performance-Insights.md`, `Trace-Analysis-2026-08-11.md`),
  `project-v4-reckoning-campaign` memory (→ `docs/holy/V4-Reckoning.md`), `keyhole-second-renderer-
  upper-floor-cause` memory, `docs/planning/Point-Light-Batching-Design.md`, `keyhole-current-state`
  memory (author's own live verdicts), `2026-08-25-town-river-bridge-roof-sweep.md` (prior capture,
  same map, Roof floor only).

## Where the frame actually goes, confirmed twice

`attribution.coverage: 0.997` (latest report), `bottleneck.verdict: 'gpu-bound'` at both median
(93.1% GPU-explained) and tail (95.3%) — the report's own top-level read is trustworthy, not a
lower bound, and the top row of `zones[]` really is where the frame time is.

**`geometry.worldDraw` is 80.3% of frame GPU (24.904ms of 31.0ms median GPU), from 17 draw calls,
546 total triangles** (`geometryComposition.totalTriangles`). Reproduced across every capture this
map has ever had: 25.11ms (2026-08-25 Roof), 25.807ms (13:25Z Ground), 24.904ms (14:06Z Ground) —
never below ~25ms, never a different dominant zone. `dominant-zone` finding fires severity `high`
in every one.

**Confirmed NOT vegetation-tessellation-driven** — `geometryComposition.coverageMeshSummary.
vegetationTriangles: 0` in every `byKind` entry this run. The "one vegetation item at 97% of a
zone's cost" mechanism `project_worlddraw_composition_instrumentation_2026-08-25` built this
exact diagnostic to test does not apply to this map/floor — ruled out with a number, not assumed.

**Confirmed coverage meshing is already doing real work here**: `rasterizedFractionPct: 3.3` —
96.7% of the coverage grid is already culled from rasterization, a MUCH more aggressive yield than
the Mansion 12K map's own retuned 40.1% (`keyhole-performance-audit-2026-08`, round 6). Coverage
meshing is not the lever left to pull on this map — it's already pulled, hard.

**The signature that remains — low draw count, tiny triangle count, huge per-draw GPU cost — is
identical to the "fill-rate/bandwidth-bound, not geometry-bound" regime the Mansion 12K
investigation diagnosed** (`geometry.worldDraw` 133ms from 22 draws before any fix landed there) and
the Reckoning campaign's own resolution A/B independently confirmed for the SAME reason on the
Mansion's upper floor (47% fewer pixels bought ≥4.4× — superlinear, i.e. bandwidth/cache
saturation, not per-object cost). Both prior investigations point at causes downstream of triangle
count: per-fragment shader cost × screen area, and/or GPU contention from something outside MSA's
own render passes entirely.

## RESOLUTION LOG (same day, both closed with real measurements)

**Priority 1 — CLOSED, ruled out.** Ingram checked `canvas.primary.renderable` live, with a token
selected: `false`. The fix is engaged. Also found and fixed a real gap while verifying: the routine
"Interface seam" health-check never actually read this specific lever (only the two older,
pre-Bug-#21 ones) — the only place it surfaced was the buried, temporary Reckoning Report. Fixed
(`f1317d1`) so the routine report now tells the truth about this on its own. Second-renderer
contention is eliminated as an explanation for `geometry.worldDraw`'s cost.

**Priority 2 — CLOSED, measured, NOT a real cost.** Ingram ran the never-before-used sharpening A/B
(`MapShine.setSharpeningAbEnabled(true)` + `perf-run-full`, 4 real viewer restarts, isolated
shader-graph comparison). Result: `verdict: 'within-noise'`, `deltaGpuMs: 0.051ms` against a
`0.19ms` noise floor — `geometry.worldDraw` itself measured 24.827ms (CAS on) vs 24.872ms (CAS off),
statistically indistinguishable, and if anything backwards. **The theoretical estimate this
priority was built on (~4 of 6 taps removable, "a real number not a rounding error") was wrong on
real content** — likely because the 5 taps are cheap, cache-friendly, screen-space-adjacent reads
against a per-fragment cost dominated by something else entirely. Two follow-ups landed same day:
(1) this result now folds into `findings[]` (was previously invisible there, same gap class as
Round 2 Item 1 — `structuralAbFindingsFor(sharpeningAB.toggles, {idPrefix:'sharpening-ab'})`); (2)
the Sharpening panel's own subtitle now says plainly that this is a look control, not a performance
lever, with the measured number cited, so nobody re-chases this. The look-vs-speed UX decision
(should the enable toggle also trigger a restart to be "fully honest") was deliberately NOT taken —
now that the measured cost is confirmed negligible, spending a 15-20s reload on every toggle to
chase a ~0.05ms saving is a bad trade; the honest-labeling fix addresses the actual complaint
(confusing UX) without the disruptive cost.

**Net effect: two of the four Bug-#21/CAS-adjacent hypotheses for `geometry.worldDraw`'s cost are
now eliminated with real, direct measurements — not theory.** Combined with the two Priority-3-era
eliminations already logged above (not vegetation, not under-culled tiles), FOUR real hypotheses are
now ruled out. `geometry.worldDraw`'s true cause is still genuinely unexplained — this is real
progress (eliminating wrong answers), not a dead end, but the next lever is not yet identified and
would need fresh investigation, not something already sitting diagnosed in the corpus.

## Priority 1 — Confirm Bug #21's fix is actually engaged on this content (zero code, do this first)

**Why this is #1, not a new investigation:** `docs/foundry/canvas-compositing.js` (Bug #21, fixed
`a1d899c`, 2026-08-15, ON by default) suppresses Foundry's own `canvas.primary` PIXI group, which —
left unsuppressed — silently re-renders the ENTIRE map into a canvas-resolution texture every
frame, in a SEPARATE GL context, purely to feed a fog filter MSA no longer needs it for. Measured
on the Mansion's upper floor: 37.14ms → 8.35ms frame time (4.4×) purely from disabling it — with
**zero MSA zone able to see the cost, because it runs on a different renderer entirely.**
`keyhole-second-renderer-upper-floor-cause` and `keyhole-current-state` both record this fix as
**still not confirmed by Ingram's own eyes with a controlled token, 11 days after it shipped** —
the exact condition (`visibilityVisible` gating) that hid the ORIGINAL bug (#18) for weeks.

**Why it's the top suspect for THIS map's worldDraw number specifically:** a hidden GPU-contention
cost from a second, invisible renderer would show up exactly as "the pass with the most bandwidth
pressure (worldDraw, the biggest render target writes on the frame) reads far more expensive than
its own triangle/draw count would predict" — which is precisely what 546 triangles costing 24.9ms
looks like. `attribution.coverage: 0.997` does NOT rule this out: that metric only proves MSA's
*own* zones sum correctly against MSA's *own* `frame.gpuMs` — it has no visibility into a second
renderer's GPU time at all, by construction (different context, different ticker, stated directly
in `canvas-compositing.js`'s own header).

**Action, no code change:** read `interface-seam`'s health check or the Reckoning report's own
`primaryRenderable` field live (`false` = healthy, `true` = the re-render is back), with a
controlled token active. If `true`, the fix has regressed or something is re-enabling it — find
what. If `false` and worldDraw is STILL 25ms, this hypothesis is cleanly eliminated and Priority 2
becomes the leading lever instead of a parallel one.

## Priority 2 — CAS sharpening's 5 unconditional texture taps: already diagnosed, blocked on a look decision, not more investigation

`buildWholeImageMaterial` costs 6 texture taps per surviving fragment: 5 for
`buildAlbedoClarityNode`'s CAS sharpening, 1 for `physicalSolidityAlpha`'s separate read
(`keyhole-performance-audit-2026-08`, round 5's "next lever, located and measured, NOT taken").
The sharpening taps are **unconditional** — the zoom gate scales the RESULT, never skips the
fetches — so every fragment on the dominant pass pays for all 5, regardless of whether sharpening
is visually contributing at that zoom level. This is a genuinely large potential win specifically
BECAUSE `geometry.worldDraw` is the dominant, near-full-screen pass: cutting ~4 of 6 fetches on the
single most expensive per-fragment cost in the frame is a real number, not a rounding error — but
it changes the LOOK (sharpening softens), so it was correctly left for the author to decide, not
guessed at. Still undecided 16 days later. **This is the single most concrete, already-quantified
lever sitting on the shelf** — worth a decision regardless of what Priority 1 turns out to show,
since it doesn't depend on Bug #21 either way.

**Coverage caveat, confirmed again this run**: `tierComparison.coverageCaveats` — the perf-tier
sweep's own transient profile override never reaches this gate (`shouldUseFullAlbedoClarity()`
reads the real persisted setting once, at material-build time), so no amount of re-running
`perf-run-full`'s tier sweep will ever show this lever's real cost. `MapShine.
setSharpeningAbEnabled(true)` exists specifically to do a real viewer-restart A/B for this — it has
never been run (`sharpeningAB.ran: false, skipped: 'disabled-by-default'` in every capture so far,
including the latest). **Recommended first step if Priority 1 doesn't fully explain worldDraw**:
enable it once and re-run, rather than debating the tradeoff blind.

## Priority 3 — Window light: 1.55–1.57× over its own declared budget, three captures running

`declared-cost-understated:window` fires `high` severity in every capture this map has produced:
0.094 ms/Mpx (13:25Z) → 0.093 ms/Mpx (14:06Z) against a declared ceiling of 0.06 ms/Mpx — 1.55–1.57×,
consistently, not noise. In absolute terms this is small (0.679–0.687ms, ~2% of frame) — **not a
frame-rate priority** — but it's a real, reproducible, first-ever-measured drift the report itself
keeps flagging loudly, and the multi-floor data makes the gap worse, not better: the Roof floor's
own window-light cost measured **2.1–2.2ms** in the 13:25Z capture's `floorStructuralAB`, over 3×
the Ground floor's number, consistent with the same declared budget being stale project-wide rather
than a Ground-floor-specific regression. **Cheap to resolve either way**: either the manifest
number (`0.06 ms/Mpx`) is simply out of date and should be raised to match reality (a documentation
fix, zero risk), or a real implementation drift happened since it was set and is worth a source
read (`window-render.js`, the `gateGlass` optimisation landed 2026-08-25 — confirm it's actually
wired at every call site, not just the one already checked). Low urgency, but a 10-minute look
either closes a standing `high`-severity finding or catches something worth knowing about.

## Priority 4 (methodology finding, not a code target) — point-light batching's A/B is testing the wrong axis on the wrong map

Three consecutive structural-AB reads on this map, three different(-looking) verdicts:
`within-noise` (13:25Z main), `within-noise` (13:25Z Roof), `within-noise` (14:06Z Roof), and
**`costs-more-than-it-saves`** (14:06Z main, `deltaGpuMs: 0.144ms` clearing a `0.036ms` noise
floor). Read the LAST one's own evidence before trusting the verdict: **`geometry.worldDraw` is
the #1 mover (+0.096ms of the +0.144ms total) — not any point-light zone.** `light.
drawPointLights` itself moved -0.003ms; `light.pointLightBatchReconcile` (the actual Stage-2
mechanism) is CPU-only (`kind:'cpu'`, `gpuAbsentByDeclaration:true`) and structurally **cannot
appear in a GPU-ms comparison at all** — its entire cost (0.03ms mean) is invisible to this test by
construction.

**Two structural reasons this toggle can't get a clean answer on this map, neither of which is a
code defect:**
1. **Wrong axis measured.** `Point-Light-Batching-Design.md` §1's own stated case for Stage 2 was
   ~half CPU reconcile time (2.710ms on the Mansion) and half draw-submission overhead — not GPU
   shading time. The structural-AB toggle compares whole-frame `onGpuMs`/`offGpuMs` only; it was
   built for `earlyZComposition` (a genuinely GPU-side question) and reused as-is for a toggle whose
   real payoff lives on the CPU side.
2. **Wrong map.** `light.drawPointLights` on Town River Bridge costs 0.027ms GPU from ~1 draw call
   — nowhere near the Mansion's own S2.0 census (50 document lights + 207 candle anchors, 136 real
   per-light draws pre-batching) the design doc's whole case was built against. `geometry.worldDraw`
   alone has enough natural run-to-run jitter (0.1–0.7ms swings between otherwise-identical blocks,
   visible throughout every structuralAB capture this session) to swamp a genuine point-light
   effect this small, whichever direction it actually goes.

**Not a recommendation to chase a fix** — this is a recommendation to stop re-spending measurement
cycles on this exact test. Either (a) build a CPU-reconcile-focused A/B for this specific toggle
(compare `light.pointLightUpdate` + `light.pointLightBatchReconcile` CPU sums on/off, not frame
GPU ms), or (b) re-run the existing test on the Mansion where the feature's real value proposition
(many lights) actually exists, or (c) accept "no measurable GPU-ms difference on a light-sparse map
like this one" as a real, sufficient answer and leave the flag wherever it currently defaults.

## Closed, no action needed

**Early-Z composition (Stage 1) is a confirmed, modest, real win — stop re-litigating it.** Ground
floor: `pays-for-itself` in BOTH captures this session, cleanly clearing its own noise floor both
times (-0.551ms/0.241ms floor at 13:25Z; -0.405ms/0.099ms floor at 14:06Z). Roof floor: sign and
magnitude consistent across three total measurements (2026-08-25: -2.534ms but didn't clear a loose
2.452ms floor; 13:25Z: -0.519ms, cleared a tight 0.087ms floor, `pays-for-itself`; 14:06Z: -0.552ms,
didn't clear a looser floor that run, `within-noise`) — the delta is CONSISTENTLY negative across
every single measurement on both floors; what varies is only whether that specific run's ambient
noise happened to be tight enough to call it. The gap-analysis doc's "inconclusive three times
running" headline predates the Round 2 A/B honesty upgrades (300 frames, multi-cycle, ambient
pre-check) that produced these newer, cleaner reads — **treat the newer captures as superseding it**,
not as a contradiction needing resolution. It's already live, default-on, and pulling its weight.

**No hidden cost is lurking in the unpriceable effects.** `fire`, `depthOfField`, `grade`, `water`,
`apertureGobo` all still read `zoneCoverage: partial` or `none` — a standing instrument gap, not new
this run — but `attribution.residualGpuMs` (0.098ms of 31.92ms `frameGpuMs`, both captures) proves
whatever's unattributed across the WHOLE frame is tiny. If one of these five were secretly large,
coverage would be far below 99.7%. Nothing here needs urgent investigation for perf purposes.

**`geometry.depthDraw` + `geometry.earlyZPrepass`'s "duplicate geometry" finding is already
answered by this same report's own structuralAB section** — the finding text says "this report
cannot tell which [a real prepass win or one submission too many]," but Priority "Closed" above
already answers it: the earlyZ prepass demonstrably pays for itself. Worth noting in case a future
session re-reads that finding cold and thinks it's still open.

## Named but out of scope for now (GPU-bound, not CPU-bound, on this map/report)

**RenderBundles — a proven 1.8–2.6× CPU win (tested 2026-08-10), never adopted in production**,
per `Performance-Gap-Analysis-2026-08-26.md`'s own headline finding (not independently re-verified
today — citing, not re-deriving). Worth keeping on the list, but `bottleneck.verdict` is solidly
`gpu-bound` (93–96% GPU-explained) on every capture this map has produced — a pure CPU win would not
move fps or frame time noticeably here right now. Good candidate to revisit if Priority 1/2 land and
shift the map into CPU-bound territory, or on lower-end hardware where CPU is more likely the
constraint already.

**`ensureItemLoaded`'s sequential-vs-parallel decode pipeline** (`keyhole-performance-audit-2026-08`)
— a real, identified `Promise.all` opportunity, deliberately not taken due to timing-sensitive bug
history in that exact code path (multiple prior live regressions from changing WHEN items become
available). Not touched by anything in this report; not re-surfaced by the latest capture either
(residency zones don't appear among this map's top costs at all — this map is likely small/fully
resident already). Leave deferred.

## What the NEXT live capture should specifically re-check

1. `interface-seam`/Reckoning `primaryRenderable` field, live, with a controlled token (Priority 1).
2. A `MapShine.setSharpeningAbEnabled(true)` run, if Priority 1 doesn't fully explain worldDraw
   (Priority 2) — the only way to see CAS sharpening's real cost through this instrument.
3. Whether `window`'s declared budget was updated or the implementation re-checked (Priority 3).
4. If point-light batching is ever tested again, do it on the Mansion, not Town River Bridge
   (Priority 4) — or build the CPU-side A/B this toggle actually needs.
