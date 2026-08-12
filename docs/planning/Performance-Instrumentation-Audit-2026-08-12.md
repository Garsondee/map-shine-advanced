# Performance Instrumentation Audit — 2026-08-12

**Update, same day (author: "go fill out the report... this is critical work"):** the highest-value
items from §3/§4 below are now BUILT — `npm run verify` green throughout, live-capture attempted
against the bench world. See the "LIVE-VERIFIED" note at the end of §4 for the exact list of what
landed, what's still open, and where. The panel is also down to one performance button now, per
direct request.

**Update, later the same day (author: "I want this tool to do EVERYTHING... critique the actual
report... create a summary of the top ten worst performance issues and display warnings for things
like caches breaking"):** a second round, §5 — a numbers-backed critique of the live report's own
token density, the fixes that came out of it, a plain-language top-10-offenders + cache-warnings
summary aimed at a non-technical reader, and the two route phases the author personally designed
(multi-floor + rapid-diagonal stress). See §5 for all of it — what shipped, what's deliberately
deferred, and why.

**What this is:** an audit of the *instrument*, not the renderer. `Performance-Audit-2026-08.md`
reads the renderer's code hunting for slow work; `Performance-Insights.md` is the measured ledger.
This document is one level up from both: it asks what `perf-run-full` (the "🔬 Performance Report"
button, THE ONE BUTTON, `src/diag/perf-session.js` + `perf-zones.js` + `perf-report.js`) can and
cannot see *by construction*, so the next round of "why is this still slow" hunting knows which
blind spots to route around instead of re-discovering them live.

**Why now:** direct author request — the report tool itself, treated as a full module audit. Two
independent research passes (one over the four supporting instrument files, one over every planning
doc's self-admitted gaps) plus direct code verification confirm and extend each other throughout;
nothing below is single-sourced from a stale memory.

**A naming trap worth killing before anything else:** this codebase uses **"sweep" for two
unrelated things**, and the author's own question ("what does the full sweep get us") could mean
either:
1. The **benchmark route** — `perf-run-full` drives the camera in *"a north to south full sweep of
   the map"* (`boot.js`, `buildBenchmarkPath`'s own doc comment). This is almost certainly what was
   meant, and is what the rest of this document treats as "the full sweep."
2. The **effect on/off sweep** (`perf-lab.js`, `runSweep`) — a completely different instrument that
   toggles each registered effect and diffs whole-frame GPU medians. **This one was turned OFF by
   default on 2026-08-12** (Testament P-009): it produced zero usable per-effect numbers in three
   consecutive real captures, because its resolution floor (7.3ms, measured) is bigger than the
   ~0.5ms effects it was asked to price. It still exists, still runs if `includeSweep:true` is
   passed by hand, and is still the *only* route to a number for 4-5 specific effects — see §2B.

Everywhere below, "the full sweep" / "perf-run-full" means meaning (1) unless stated otherwise.

---

## §1 — What the full sweep gets you, right now

One click (`perf-run-full`) drives a fixed, regenerated (not hand-recorded) N→S camera traversal of
the currently-loaded floor for its full duration (~1-2 min), hides the debug UI for the run, and
hands back one JSON object. It used to be three separate buttons (a static zone profile, a
camera-driven benchmark with no sweep, and a zone-profile+sweep) — collapsed into one per direct
author instruction 2026-08-06 ("I don't mind if you make the report generation take much longer,
accuracy is more important... imagine this tool might be used by a lay person"). What's in the
object:

- **`window`/`method`** — frame count, duration, resolution, scene/floor identity, whether GPU
  timestamp queries were actually available *and actually armed this run* (`method.gpu` vs
  `gpuTimer.armResult` — these were conflated until 2026-08-11; a skipped arm used to silently read
  as `'timestamp-query'` while every zone's `gpuMs` came back `null`).
- **`zones[]`** — ~70 declared named cost centers (`src/diag/perf-zones.js`) across 10 frame stages
  (tick → sims → masks → geometry → lighting → surface → bloom → dof → present → residency), each
  with CPU mean/max/amortised and (where GPU-capable) GPU mean/max/amortised, draw calls, triangles,
  and an occurrence count. Declared taxonomy, not string literals scattered through the renderer —
  validated against the live pass graph and effect registry by Node test.
- **`frame`** — fps (avg/p1-low/percentiles), a hitch list (>50ms, count vs. dropped-by-ring vs.
  dropped-from-report kept as three *different* numbers on purpose), a frame-time histogram, a
  ~60-bucket shape series, and `inFlightDuringHitches` — which zones were still open when a hitch
  landed (see §2C for the sharp limit on what this can actually prove).
- **`bottleneck`** — a verdict on whether the frame is GPU-bound, CPU-bound, or "unexplained" at
  both the median AND the p95 tail, computed BEFORE any per-zone number is trusted (the report's own
  reading order puts this ahead of "biggest zone" on purpose — a trustworthy partition of a third of
  the frame is still only a third of the answer).
- **`effects[]`** — every registered effect (15 total) rolled up from the zones it owns, cross-checked
  against its own declared cost-tier manifest (`estMsPerMp` per performance class) and, when the
  optional sweep ran, against that too — flagging disagreement rather than averaging it away.
- **`instrument`** — pipeline-compile growth, shader-graph rebuild churn, GPU-pipeline rebuild churn,
  the depth-proxy material pool's hit rate, and window-surface scene composition — five separate
  "is the renderer doing something structurally wasteful" probes, each reporting `null` (not 0) when
  its harness hook isn't wired, never silently reading as "nothing happened."
- **`structuralAB`** — a parked-camera, same-run, noise-floor-aware A/B on **exactly one** toggle
  currently (`earlyZComposition` — see §2C for why this catalog is this short).
- **`vram`** — a render-target inventory + whole-image texture estimate, **snapshotted once** at the
  end of the window (see §2C for what this misses).
- **`findings[]`** — the auto-diagnosis layer, ~25 distinct rules, severity-sorted, that read
  everything above and name what's actionable — duplicate-geometry submission, front-loaded vs.
  back-loaded cost shape, a steady zone hiding a 30x spike behind a healthy mean, residency cost that
  is/isn't real I/O, declared-vs-measured cost drift, and a standing `effects-unpriceable` finding
  naming its own coverage gap (§2B) every single run rather than making the reader rediscover it.
- **`interpretation`** — a stated reading order (attribution verdict first, then findings top-down,
  then gap vs. gpu). The report tells you how to read itself, which is unusual and load-bearing: the
  same numbers misread bottom-up have already produced wrong conclusions at least once (Moonshot.md).

This is a lot, and it is genuinely good instrumentation — five self-admitted honesty rules
(`perf-report.js`'s own header: never 0 for "not measured," print the residual, sparse ≠ per-frame,
respect the clock's real resolution, sample don't dump) that most perf tooling doesn't bother with.
The rest of this document is about what still doesn't reach it.

---

## §2 — What it doesn't get you

### §2A — What the *route* never exercises, regardless of instrumentation

The benchmark is a **passive camera pan on one floor, one session, one physical machine.** Several
real cost classes structurally cannot appear in its output no matter how well-zoned the renderer is:

- **Document-edit / hook-triggered cascades.** Sliders, wall edits, token moves, tile CRUD, door
  open/close — the whole `§5.8` cascade class ("one `getProductsVersion()` counter drives 5 bake
  pipelines from one slider drag," `Performance-Audit-2026-08.md`) never fires, because the route
  never writes a Foundry document. The `boot.js:6986` arity-1 CRUD hook bug (any field write to ANY
  Tile/Level triggers the full cascade, not just a placement edit) is real and already found — and
  is *invisible to perf-run-full by construction*, forever, regardless of whether it's fixed.
- **Bake zones essentially never fire.** `light.sunShadowBake`/`light.waterBodyBake`/
  `sims.windBake`/`surface.specularIslandBake` are all declared, real, `cadence:'bake'` zones — but
  a bake needs a version-changing edit to trigger, and the route makes none. `Performance-Insights.md`
  §7 already recorded this directly: sun-shadow/water bakes "did not fire during either the static
  window OR the full 60s sweep." Their cost is exactly as invisible today as when that was written.
- **Floor switching.** The route stays on whichever floor was manually navigated to before clicking
  the button. Floor-switch cost has its own confirmed bug history (12k-map device loss, the
  floor-switch/settle-time finding) and zero coverage in the automated benchmark.
- **One machine, one session length.** Every capture to date is the author's own dev rig
  (Ryzen 7 5800H / RTX 3070 8GB), for 1-4 minutes. `Performance-Audit-2026-08.md` §11 names this
  directly and by category: **"Startup time, long-session memory growth, low-end/integrated GPU
  behaviour, scene-switch cost, and many-tokens-moving-at-once. All plausible, none examined."**
  `perf-report-all-tiers` varies the *effect profile* (Low/Med/High) but never the *hardware* — it
  cannot tell you whether "Low" is actually playable on a weak machine, only that it's cheaper on a
  strong one.
- **The UI the author actually plays with.** `hideLiveUi()` takes the debug panel away for the
  entire measured window on purpose (so the panel's own polling doesn't contend with the
  measurement) — which means perf-run-full is structurally blind to the cost of the HUD/panel/
  astrolabe the author has open during real play. A Chrome trace already caught this cost directly:
  **2,451ms / 6.9% of an 11-second capture's main thread was MSA's own diagnostic UI**, 94% of it one
  function (`syncTuningSummary`) writing `innerHTML` every frame for a string that only changes when
  sky light crosses zero (`Trace-Analysis-2026-08-11.md`). Fixed once for that one function; the
  report itself still cannot see this class of cost on any future regression, because it always hides
  the UI before measuring.
- **Multi-client / real player experience.** The route runs as a single client (the Bench/GM user)
  against a live Foundry server. A connected player's client — different hardware, a
  non-GM view — is never modeled.

### §2B — Named STANDING gaps in the taxonomy itself (true on every run, not just this benchmark)

- **Five effects are currently unpriceable by ANY method.** `grade` (folded into the present-composite
  shader, no draw of its own — sweep-only, and the sweep is off by default), `water` (tier-0 surface
  draw shares `geometry.world`'s scene), `vegetation` (mesh draw shares the same scene),
  `fluid` (absorb/emit draw, same situation), and — confirmed directly from `attributeZonesToEffects`'
  own logic, not named in the Testament's list of 4 — **`apertureGobo`** whenever its debug channel
  isn't selected (its only owned zone, `light.drawApertureShadow`, never opens, so it produces no row
  at all; the *real* per-fragment gobo cost is baked into the null-owned `light.drawPointLights`/
  `light.drawColoration` materials and was never zoned separately). Testament P-009 calls this "a
  STANDING GAP in the instrument, not a property of this run: re-running will not fix it." It's
  correct, and it's worth restating plainly: **if any of these five regresses, nothing currently
  notices.**
- **`point-light-pool.js` — 1,966 lines, the busiest single lighting subsystem (91 real wall-clipped
  polygon draws per the locked perf calibration) — has ZERO internal profiler brackets.** Confirmed
  directly: no `profiler.`/`zone.`/`zoneTimer` reference anywhere in the file. Every cost inside it
  (wall-clipping, fan-polygon triangulation, radius scaling, aperture-gobo pattern baking, per-light
  visibility culling) is lumped into ONE opaque `light.pointLightUpdate` CPU bracket. This already
  matters, live: that single zone measured a **0.76ms mean / 22.7ms max — a 30x spread** — in the
  same capture that motivated building the `steady-spike` finding in the first place, and the
  Testament separately confirms `computeLightWallClippedShape` (988ms of self-time in one trace) and
  `buildOneLightSource` (the 2nd-largest MSA self-time function measured) both have "no dedicated
  `perf-zones.js` zone" (V4-Testament.md, P-006/S2.6). Nobody can currently say which of the several
  things this file does caused either number.
- **Two more "found unwired" instances of a bug class this project has already fixed five times
  elsewhere.** `specularSurface.sync()`, `waterSurface.sync()`, `fluidSurface.sync()`, and the wind
  field bake were each found running with zero profiler coverage and given a zone (2026-08-06,
  `perf-zones.js`'s own comments document each discovery). **`windowSurface.sync()` and
  `fireSubsystem.sync()` are the two remaining instances, still live today.** Confirmed directly at
  the call sites (`vt-pan-viewer.js:4984` and `:9817`): both run every frame, immediately before
  their respective GPU-draw brackets open, and neither has a CPU zone of its own.
  - `windowSurface.sync()` pushes a depth-authority `resolveExpectedDepth` query every single frame
    (the exact class of per-frame cost that got `specularSurface.sync()` its own zone) plus mask
    loading and look-param comparisons — structurally near-identical to specular's sync, which *was*
    worth zoning.
  - `fireSubsystem.sync()` iterates active fires, manages per-engine visibility, and (fire being a
    brand-new TSL-compute particle system per the locked "particles are TSL compute" decision)
    likely dispatches real GPU compute work that isn't a `renderer.render()` draw call at all — so
    even the null-owned fallback that at least *partially* covers other unowned costs may not catch
    this. `src/effects/fire/` is separately confirmed **"entirely unaudited, deliberately so"**
    (`Performance-Audit-2026-08.md`), and fire's lights are explicitly documented as larger-radius
    than candles' — the exact effect whose cost hid unnoticed inside these same null-owned zones for
    a long time before anyone caught it (`Performance-Insights.md` §5B/§5C).
  - Both effects **silently default to `zoneCoverage:'full'`** in the report (the coverage-inference
    logic falls back to `'full'` whenever an effect owns ≥1 zone and has no explicit
    `EFFECT_ZONING` entry saying otherwise) — meaning the report actively asserts complete confidence
    in two measurements that are known-partial. This is a live instance of the exact
    `feedback_instruments_must_not_lie` bug class the project already has a name for, not a
    hypothetical.
  - `sims.wind`/`sims.fluid`/`sims.particlesDust`/`sims.particlesGusts` all get a `sims.*` zone for
    their simulation tick. **Fire does not** — there is no `sims.fire` (or equivalent) zone at all.
- **`geometry.worldDraw` cannot be sub-zoned** — one `render()` call, one timestamp
  (`Performance-Insights.md` §7). If it's ever the dominant cost again, the report can name the
  number but not which content inside the shared scene produced it.
- **~750 unattributed render passes per run**, root cause never chased down (`Performance-Insights.md`
  §7).
- **`residency.itemLoad`'s already-loaded (non-I/O) fast path cost is unknown.** Testament P-009
  found a capture where this zone cost 6.19 SECONDS with both its I/O sub-zones absent (meaning zero
  new items loaded) — proving the cost is NOT the sequential-await I/O latency the 2026-08-11 audit
  assumed. "The next investigation must find what the pass does unconditionally per occurrence" is
  still open.
- **No per-frame `renderer.render()` call census exists** — a plain count + per-call CPU cost across
  the whole frame, independent of the zone taxonomy. Named as wanted, not yet built
  (V4-Testament.md, Stage 4).
- **A minor but real asymmetry in the auto-findings engine itself:** `compareToManifest` computes a
  `'under'` verdict (measured well under the declared cost tier — "cheap to leave, but the
  declaration is pessimistic enough to be misleading") exactly as it computes `'over'`. Only `'over'`
  ever becomes a `findings[]` entry (`deriveFindings`, `declared-cost-understated`). A reader
  following the report's own stated reading order ("read findings[] top-down") will never learn that
  a manifest's cost-tier declaration has gone stale on the cheap side — they'd have to manually scan
  all 15 `effects[]` entries by hand to find it.

### §2C — Method-level ceilings (true no matter what gets zoned or which route runs)

- **The GPU timestamp query pool is hardcoded (1024-2048 slots) inside vendored `WebGPUBackend`, with
  no injection point, and overflows on light-dense scenes** (~117 point lights → 250-300+ real
  passes/frame against a budget sized for ~25). `zones[].gpuMs` goes silently missing past the
  overflow point on exactly the scenes most worth measuring. `Performance-Audit-2026-08.md` calls
  this explicitly: "there is no known safe fix... exactly the kind of blind vendor edit this project
  avoids." Accepted as a standing ceiling, not a bug to close.
- **The profiler is zero-allocation by design, which means no per-zone percentiles, variance, or
  stddev exist anywhere — only mean/max/amortised.** The `steady-spike` finding's own 5x-of-mean
  threshold is a hand-picked constant *because there is no real statistical distribution to derive
  one from*. A zone could be bimodal (cheap 95% of the time, expensive 5%) and the report has no way
  to say so beyond "the max is high."
- **Felt-frame timing and GPU-probe timing are two incommensurate clocks.** The (retired-by-default)
  effect sweep's FELT phase runs unthrottled; its GPU phase throttles the render loop to one frame in
  flight. `perf-lab.js` states directly that "Foundry / other" overhead cannot be derived once MSA's
  own GPU frame exceeds the felt gap — it's suppressed as `null`, not estimated.
- **A standard Chrome DevTools trace cannot attribute GPU busy time to a specific MSA render pass at
  all** — there are no Dawn/WebGPU categories in the capture. `trace-analyze.mjs` can say the GPU
  thread was 85.8% busy; it can never say which pass. **MSA's own zone timer is the only instrument
  that can answer that question** — which means every gap named in §2B (point-light internals, fire,
  window sync, the 5 unpriceable effects) has **no fallback instrument** that could independently
  corroborate a fix. If the zone timer is blind to something, nothing else in this project's toolkit
  currently sees it either.
- **Hitch→zone correlation can only ever catch zones that literally span multiple frames** — by the
  time a frame's gap is measured, every ordinary render-loop zone from that frame has already closed.
  The correlation can only implicate the async `cadence:'event'` residency brackets. An ordinary
  steady/conditional zone (say, a lighting or geometry pass) that happens to be the real cause of a
  hitch is invisible to this specific check by construction — not a bug, a stated structural limit
  (`frame-profiler.js`'s own header is explicit about this).
- **The structural A/B catalog has exactly one entry: `earlyZComposition`.** The file's own opening
  comment names "point-light batching" as a second conceptual example of a structural toggle worth
  A/B-testing — the Stage-2 plan-of-record shape this project has already committed to
  (`Point-Light-Batching-Design.md`) — but no catalog entry for it exists yet. When that work lands,
  its own perf validation path isn't wired.
- **`vram` is a single end-of-window snapshot, not a peak-over-time series.** It cannot catch a
  mid-run VRAM spike that later receded — exactly the shape of the historical 12k-map device-loss
  bug, which was only diagnosable via the *separate* flight-recorder tool's continuous capture.
  Separately, **the mask/page-cache pool's real VRAM usage is confirmed NOT included** in either the
  render-target total or the whole-image estimate (`Moonshot.md`) — a real, named accounting gap in
  what "VRAM used" even means in this report.
- **`perf-earlyz-sweep-ab` ("full effect sweep ×2," ~4-8 min) reintroduces the *retired* effect sweep
  for its one specific comparison** — meaning even when someone pays the extra minutes, its noise
  floor is explicitly the *weaker* cross-run "conservative approximation" kind
  (`compareSweepPair`'s own comment), not the same-run kind `perf-structural-ab.js` was built to
  provide instead. Paying more time here does not buy the stronger evidence type.

### §2D — Measured elsewhere, never folded into "the one button"

Three genuinely separate tools exist, each seeing something the others cannot, and nothing combines
them automatically:

1. **`perf-run-full`** — the per-zone CPU+GPU report this whole document is about. Bounded to
   1-4 minutes. Cannot see scene-load, session history, or environment.
2. **`flight-recorder.js`** — a black box installed once at boot, running continuously for the whole
   session. This is the *only* place `beginSpan`/`endSpan` scene-load timeline data lives, the only
   place a machine/environment fingerprint (GPU adapter/limits, JS heap size, browser/module list) is
   captured, and the only place frame history survives longer than a few minutes (three views:
   histogram over every frame, a 1-in-10 timeline, every hitch unsampled). But: its ring buffers are
   capped (3000 log lines / 900 frame samples / 150 hitches / 400 spans — sized to stay in "low
   hundreds of KB, not tens of MB") and **nothing auto-persists it** — someone has to click
   "Export everything" before the tab closes or the data is gone. `jsHeap` itself is a single
   point-in-time read at export, not a time series — so even this tool cannot answer "does memory
   grow over a real multi-hour session," despite being the closest thing to a long-session
   instrument this project has.
3. **`tools/trace-analyze.mjs`** — a third, also-manual instrument, needed specifically for the
   GPU-process/Dawn command-buffer layer neither of the above two can see (see §2C).

**Getting a full picture today means manually running and manually cross-referencing up to three
different tools by hand.** There is no single button that produces all three, and — aside from the
narrow hitch-zone correlation in §2C — no automatic correlation between what any two of them saw
during the same incident.

### §2E — No trend tracking, no regression gate, across any time horizon

- Every report is a one-off JSON snapshot. Historical reports live at
  `docs/planning/perf-reports/*.json` only when a human remembers to save one by hand — there is no
  automatic archive.
- `.github/workflows/main.yml` (the only CI in this repo) runs `npm run verify` — lint, format,
  structure walls, and the ~8,200-strong Node test suite — on every tagged release. That suite
  **does** test the instrument's own logic well (`perf-report.test.mjs`, `perf-lab.test.mjs`,
  `frame-profiler.test.mjs`, `perf-session.test.mjs`, all Node-tested against a fake harness with no
  browser). It **never runs the instrument against a real renderer** — no GPU, no live Foundry
  server, no browser exists in that CI environment at all, so this could not change without a
  fundamentally different CI setup.
- **Net effect: nothing catches a performance regression automatically, ever, on any cadence.** A
  fix landing today is only as durable as the next time a human remembers to click the button and
  compare by eye. `perf-lab.js` and `trace-analyze.mjs` both have a manual pairwise `--compare` mode
  for two specific files a human hands them — neither runs against history automatically.
- **No open Bug-Tracker entry exists for any gap in this document** (confirmed: all 17 current OPEN
  entries are rendering/behavior defects). Every gap named above lives only in planning-doc prose —
  which is exactly the kind of thing that's easy to lose track of, which is part of why this document
  exists.

---

## §3 — Where the next worst offender is most likely hiding (priority order)

Ranked by "most likely to currently be hiding a real, material cost," not by ease of fixing:

1. **Point-light-pool internals (§2B).** Already-confirmed 30x mean/max spread, already-confirmed
   2nd-largest MSA self-time function, feeding the single busiest draw pass in the lighting stage,
   with *zero* internal breakdown. This is the same shape that made `geometry.depthDraw` worth
   splitting into 3 sub-zones — except that split already happened there and never happened here.
2. **Fire.** Brand new, structurally identical to the exact bug class (cost hidden inside a
   null-owned zone) that already cost candles an unnoticed 13.1ms/20.4ms-frame regression, larger
   light radii than candles by the team's own description, zero zones of any kind, and explicitly
   flagged as never audited at all.
3. **`windowSurface.sync()`.** Sits directly upstream of an *already-open, already-investigated*
   mystery (`window-surface-composition`: ~4 draw calls per occurrence where the code predicts 1).
   Zoning this CPU cost is cheap and might directly help close that mystery, not just add coverage.
4. **The 5 unpriceable effects (water/vegetation/fluid/grade/apertureGobo).** Currently dark to every
   method that exists. Not necessarily expensive today — but a regression in any of them is
   undetectable by construction until someone adds a real zone bracket to at least one.
5. **Editing-cadence bake cascades.** Already known-expensive (§5.8's 5-pipeline-from-one-slider
   chain, unthrottled sun-shadow/water bakes), structurally invisible to the only automated
   benchmark that exists. This is a "we know it's bad, we just can't watch it happen automatically"
   gap, not an unknown.
6. **No regression gate.** Meta-level, but real: every item above, even once fixed, has no mechanism
   preventing silent recurrence. Worth weighing against the cost of fixing #1-5 individually.
7. **Long-session drift.** Nothing in the current toolkit — not perf-run-full, not flight-recorder —
   can currently confirm or deny "does this get worse the longer I play." If any of the user's felt
   "persistent performance issues" have that shape, no instrument here would show it yet.

---

## §4 — Full checklist: what could be tracked and currently isn't

Flat, for working through:

**Coverage additions to `perf-zones.js` (concrete, scoped):**
- [x] **BUILT 2026-08-12.** Internal sub-zones inside `point-light-pool.js` — five, not the
      originally-sketched per-mechanism split: `light.pointLightWallClip` (the 9.9%-of-frame cost,
      Testament's own named ask), `light.pointLightSourceBuild` (candle/lightning/fire assembly),
      `light.pointLightApertureSetup`, `light.pointLightReconcile` (the big per-light loop),
      `light.pointLightBatchReconcile`. Sequential siblings inside `update()`, same shape as
      `geometry.depthDraw`'s three. `npm run verify` green.
- [x] **BUILT.** `windowSurface.sync()` CPU zone (`light.windowSync`).
- [x] **BUILT, scoped down.** `fireSubsystem.sync()` CPU zone (`light.fireSync`) — covers the whole
      sync call including the per-engine `engine.step()` loop. No separate `sims.fire` zone: given
      the whole subsystem had zero coverage, closing that gap outright took priority over finer
      granularity: a natural next split once real numbers show whether bookkeeping or the compute
      dispatch itself dominates.
- [x] **BUILT.** `EFFECT_ZONING` entries for `fire` (`'partial'` — its light-source draw still hides
      in the null-owned `light.drawPointLights`/`light.drawColoration`, same as candles once did) and
      `window` (`'full'` — its own dedicated per-floor scene means nothing is left un-zoned).
- [ ] A real GPU-drawable bracket for at least one of water/vegetation/fluid/grade so it has a
      non-sweep route to a number (grade is the structurally hardest — folded into a shared shader —
      the others share `geometry.world`'s scene the same way vegetation/water/fluid already partially do).
      NOT attempted — real render-architecture work, not an instrumentation addition.
- [ ] A `light.drawApertureShadow`-independent path to aperture-gobo's *real* per-fragment cost, not
      just its usually-empty debug-visualization draw. Not attempted, same reason as above.

**Findings-engine completeness (cheap, in `perf-report.js`):**
- [ ] Surface the `declared.verdict === 'under'` case as a low-severity finding, not just `'over'`.
      Not attempted this pass — deprioritised below cache health.

**Cache health (2026-08-12, the second half of the same request — new section, not in the original
audit):**
- [x] **BUILT.** A generalised `caches[]` report section (`src/diag/cache-report.js`) — one normalized
      `{id, label, ownerEffectId, hits, misses, evictions, size, capacity, hitRatePct, note}` row per
      cache, fed by a new `readCacheStats()` harness hook, sampled before/after the window exactly like
      `pipelineStats`. A generalised `cache-low-hit-rate` finding (the `depth-proxy-pool-health`
      shape, applied to every row).
- [x] **BUILT.** Real hit/miss/eviction counters added where none existed: the point-light pool's four
      wall-clip caches (`candleWallClipCache`, `lightningWallClipCache`, `regularLightWallClipCache`
      via a new return field on `readActiveLightSources`, `apertureSegCache`), the vegetation
      depth-proxy node cache (`vt-pan-viewer.js`'s `vegetationProxyNodeCache`), and the mask-authority
      bake gate (`bakeRuns`/`bakeSkips` on `recomputeIfDirty` — directly tests the §5.8
      over-invalidation suspicion for the first time).
- [x] **BUILT.** Two already-instrumented, already-reachable caches surfaced into the unified view for
      the first time: `vt/page-cache.js` (VT atlas residency — the single most performance-relevant
      cache in the whole inventory) and `vt/decode-pool.js` (source bitmap + IndexedDB). The three
      existing probes (depth-proxy pool, shader node-graph cache, GPU pipeline cache) are mirrored in
      as summary rows without duplicating their own dedicated findings.
- [ ] **NOT attempted, from the 31-cache inventory** (see the session's cache-discovery pass) —
      documented here rather than silently dropped: `compressed-textures.js`'s BC1/BC7 cache,
      `water-body-subsystem.js`'s bakes/polls counter (already has one, just not mirrored in yet),
      `sun-shadow-subsystem.js` and `vt-pan-viewer.js#bakeWindField`'s bake gates (no counters exist
      yet, unlike water-body), `pyramid-store.js`'s IndexedDB persistence, `door-graphics-subsystem.js`'s
      texture/leaf caches, and roughly 15 lower-priority UI/editor caches (paint-mode's grid cache,
      anchor-mode's marker pool, `describeRenderMode`'s TTL cache). Full list and priority order in the
      cache-discovery findings this session produced — worth a follow-up pass, not worth blocking this
      one on.

**LIVE-VERIFIED, same session** — a real `perf-run-full` capture against the bench world
(`msa-bench-world`, 447 frames / 30s window), archived at
`docs/planning/perf-reports/2026-08-12-instrumentation-buildout-verify.json`:
- All 7 new zones populated with real numbers, not nulls. Standouts:
  **`light.fireSync` measured 0.664ms mean / 2.3ms max** — a previously totally-invisible cost now
  visible for the first time, comparable in size to the point-light reconcile loop itself.
  `light.pointLightSourceBuild` (0.694ms mean) was the single largest of the five new point-light
  sub-zones, ahead of `light.pointLightReconcile` (0.607ms). `light.pointLightBatchReconcile` read
  ~0ms, correctly confirming point-light batching is off by default on this scene.
- All 9 cache rows (5 newly-instrumented + mirrored) populated correctly, including the honest
  absences: `vtPageCache.hits` correctly `null` (no counter exists), `pointLightWallClip.lightning`
  correctly `hitRatePct: null` (zero activity, not a fake 0%). Every cache that WAS active read a
  100% (or 99.9%) hit rate — `vegetationProxyNodeCache` 484/0, `maskAuthorityBakeGate` 123,535/0,
  all three active wall-clip caches 100% — a healthy baseline on this bench scene, not evidence the
  finding can't fire (see `findLowHitRateCaches`' own dedicated tests for that).
- **A brand-new, real, high-severity finding surfaced that could not have existed before today:**
  `declared-cost-understated:window` — window light measured **9.47× its declared budget** (0.568 vs
  0.06 ms/Mpx). Zoning `window` to `'full'` coverage today is what made this comparison possible at
  all; before this session it silently defaulted to `'full'` with no manifest check ever run against
  it. This is exactly the class of previously-invisible offender the whole exercise was for.
- **One honest caveat, not swept under the rug:** the live capture's own
  `profiler-unbalanced-brackets` finding read `2` (vs. `0` and `1` in the two prior 2026-08-09
  captures preserved in this same folder) — a small, pre-existing class of anomaly, not a new one.
  Both new sync-zone wrappers (`window`/`fire`) use `try/finally`, and `point-light-pool.js`'s five
  new brackets sit inside a single-exit function with no early `return` between any of them (verified
  by reading the whole function) — neither can structurally leave a bracket open. Flagged here rather
  than silently assumed innocent; worth a closer look if it grows on a future capture, not
  investigated further this session given the structural argument above and the pre-existing
  baseline.

**Route/methodology additions (bigger, needs design thought — not just a zone declaration):**
- [ ] A way to exercise editing-cadence cascades (document writes) as part of an automated capture,
      not just passive panning.
- [ ] Multi-machine or at least a documented low-end-GPU baseline, distinct from tier-forcing on one
      machine.
- [ ] A floor-switch cost capture, distinct from steady-state panning on one floor.
- [ ] A way to measure the live-UI/HUD cost *without* it contaminating the renderer measurement
      (rather than hiding it entirely, which is correct for the renderer number but leaves the UI's
      own cost permanently unmeasured by this tool).

**Cross-tool integration (process/tooling, not a code fix):**
- [ ] Auto-archive every `perf-run-full` JSON to `docs/planning/perf-reports/` on capture, instead of
      relying on a human to remember.
- [ ] Some minimal auto-diff against the previous archived report (even just "these 5 zones moved
      >20%") — short of full CI, this alone would catch silent regressions between sessions.
- [ ] A documented habit/script for pairing a `perf-run-full` capture with a flight-recorder export
      and/or a Chrome trace for the same incident, since none of the three currently know the others exist.

**Long-horizon / structural (open questions, not yet even scoped):**
- [ ] Any signal at all for long-session drift (memory growth, GC pressure, cache degradation over
      hours) — currently zero instruments cover this.
- [ ] A `perf-structural-ab.js` catalog entry for point-light batching, ready for when that Stage-2
      work lands.
- [ ] Scene-load / startup time as a per-phase breakdown (flight-recorder's spans exist but are never
      summarized against a budget the way `zones[]` are).

---

## §5 — Round 2: report density, the top-10 summary, and two new route phases

### §5A — The report critique, with real numbers

Measured against the live capture archived at `docs/planning/perf-reports/2026-08-12-instrumentation-
buildout-verify.json` (124,648 bytes for the `report` object alone) — every claim below is a direct
byte-count on that file, not an estimate:

| Section | Bytes | % of report |
| --- | --- | --- |
| `zones[]` | 40,568 | 32.8% |
| `findings[]` | 26,457 | 21.4% |
| `frame` | 16,282 | 13.2% |
| `effects[]` | 14,024 | 11.3% |
| `structuralAB` | 6,830 | 5.5% |
| `instrument` | 6,565 | 5.3% |
| `vram` | 4,472 | 3.6% |
| `caches[]` | 3,165 | 2.6% |

Four concrete, verified sources of bloat, none of which added any real diagnostic value:

1. **`frame.hitches.items` — 13,129 of `frame`'s 16,282 bytes (80%).** Each of the 20 kept hitches
   carried a FULL `decodeStats` blob (12 fields, one nested object, one array) AND a FULL `cacheStats`
   blob (9 fields) — genuinely captured fresh at each hitch's own moment
   (`vt-pan-viewer.js`'s own header: "full context AT THE MOMENT it happened," confirmed correct, not
   a bug). But in this specific capture, **all 20 hitches shared the exact same 1 distinct
   `decodeStats` value and the exact same 1 distinct `cacheStats` value** — nothing was actively
   streaming during the window, so the same "nothing changed" snapshot repeated 20 times.
2. **`duplicate-geometry:*` findings — 12 findings, 8,108 bytes (30.6% of `findings[]`).** 11 of the
   12 were fullscreen post-process quad pairs (bloom/DoF/present/composite) that are GUARANTEED to
   match on draw-calls/triangles by construction (every fullscreen quad is exactly 2 triangles, 1
   draw call) — not a discovery, a structural certainty. Only 1 of 12 (`geometry.depthDraw` +
   `geometry.earlyZPrepass`, real scene geometry, 21.9ms/frame combined) was genuinely informative.
3. **`cpuEarlyMs` — carried on 61 of 63 zones, explained exactly 1 finding.** A full parallel stat
   block (mean/max/amortised/total/occurrences) exists on every zone to support the front-loaded/
   back-loaded temporal-shape check, but 60 of those 61 copies never produced any verdict at all —
   pure dead weight for this capture.
4. **Repeated static boilerplate** — `declared.note` read the IDENTICAL 172-character sentence for
   every partial-coverage effect (water/fluid/apertureGobo, verbatim), when `whyNotZoned` on the same
   object already carries the effect-specific mechanism.

### §5B — The fixes (all in `src/diag/perf-report.js`, all Node-tested, `npm run verify` green)

- **`dedupeHitchContext`** — collapses a BYTE-IDENTICAL repeat of `decodeStats`/`cacheStats` across
  kept hitches into `"unchanged since items[N]"`; a genuinely different value is never touched.
  Skipped entirely under `verbosity:'full'`.
- **`TRIVIAL_GEOMETRY_TRIANGLE_CEILING`** (8 triangles) — pairs at or under it fold into ONE
  `duplicate-geometry-fullscreen-quads` finding (every pair still listed in its `evidence`, nothing
  dropped); real geometry above the ceiling still gets its own full finding, unchanged.
- **`cpuEarlyMs` stripped** from any zone the `temporal-shape:*` finding did not flag, unless
  `verbosity:'full'` — new objects, `allRows` (what `deriveFindings` reads) left untouched.
- **`declared.note` shortened** to a pointer at `whyNotZoned`/`effects-unpriceable` for the
  partial-coverage case, instead of repeating the same paragraph per effect.
- Combined estimated savings on the reference capture: roughly 20-24KB off 124KB (~16-19%), verified
  by the fixes' own dedicated tests, not re-measured against a fresh capture yet (see §5D).

### §5C — The summary: top-10 offenders + cache warnings

New `summary` field, **first key in the report** (`buildOffenderSummary`/`formatOffenderSummaryText`,
`src/diag/perf-report.js`) — the single "just tell me what's wrong" answer the whole exercise was for:

- **`topOffenders`** — up to 10 entries, ranked by real ms/frame cost where one exists; high-severity
  findings with no ms number of their own (shader-rebuild churn, duplicate real geometry, an
  overflowed timestamp pool) rank just under the smallest measured cost rather than vanishing or
  jumping the queue. Every entry uses the EFFECT's human title, not a zone id — a zone owned by
  `candleFlame` reports as "Candles," directly answering the author's own framing ("say the problem is
  related to candles"). Each carries one plain sentence (`whatItMeans`) and `sourceIds` for a
  technical reader who wants the raw row.
- **`cacheWarnings`** — the existing `cache-low-hit-rate` finding, restated in plain language per cache
  ("X is only avoiding repeated work N% of the time").
- **`instrumentWarnings`** — unbalanced brackets, timestamp-pool overflow, and similar "the numbers
  above may be affected" findings, kept SEPARATE from `topOffenders` on purpose — an instrument fault
  is a different kind of warning than a real cost, and must never look like one.
- Also logged as **readable console text** the moment `perf-run-full` finishes
  (`formatOffenderSummaryText`, `boot.js`'s `log.info` call) — never requires opening or parsing the
  JSON at all to get the headline answer.

### §5D — Two new route phases, both author-designed

- **Multi-floor** (`src/boot.js`'s `perf-run-full`, phase 2) — after the steady sweep, detects
  whether another floor exists (`getActiveSceneFloors`/`resolveFloorDescriptor`), switches up one
  (`setVtPanViewerFloor`), waits on the REAL settle signal
  (`vt/settle.js`'s tracker via a new `createSceneSettleWaiter` in `perf-session.js` — event-driven,
  not a guessed fixed sleep, with a 4-minute safety-net timeout), then sweeps that floor too. The
  switch transient (time-to-settle, whether it timed out, what it was still blocked on) is measured
  SEPARATELY from steady-state cruising on floor 2, so one never contaminates the other. Always
  restores the original floor in a `finally`, on every exit path. The full second-floor report is not
  nested in the main report (the all-tiers report's own v1 already proved that's "~300KB, mostly
  duplication") — `MapShine.getMultiFloorReport()` from the console, mirroring `getTierReport`'s own
  escape-hatch shape. The lean inline `multiFloor` field reuses `summarizeTierComparison` (the
  all-tiers report's own comparison engine — "profile" just means "floor" here) for a ranked "which
  zone/effect is worst across floors" view, at zero new code for that part.
- **Rapid diagonal stress** (phase 3) — a new `sw_to_ne`/`ne_to_sw` preset in `foundry/camera-path.js`
  (bottom-left to top-right, or the reverse), run at `RAPID_STRESS_SWEEP_MS = 5000` instead of the
  steady 60s. Two real bugs caught by this preset's OWN test suite before it ever ran live: (1) a
  first draft reused `n_to_s`'s single-axis zoom-fit formula, which silently collapsed the OTHER axis
  to zero pan range on a square scene — looked like a working diagonal (2 distinct keyframes) while
  actually panning a straight line; fixed by reusing the `'full'` preset's own "fit both axes with
  real margin" formula. (2) `longJumpFadeCut` must be explicit `false` here too — a corner-to-corner
  diagonal is the LONGEST possible pair on the map, guaranteed to trip the exact heuristic that once
  silently turned the ORIGINAL north-south sweep into an instant teleport (a bug this project already
  paid for once, live). Reports p99/max frame time and hitch count — never the mean, which would
  average five seconds of deliberately-worst-case movement into looking unremarkable. Same
  full-report-not-nested / `MapShine.getRapidStressReport()` / `summarizeTierComparison` shape as
  multi-floor, reusing the identical pattern a third time in one session.

### §5D.1 — LIVE-VERIFIED, same session, and both new phases immediately found something real

Second live capture against the bench world, all three phases in one run (192s total), archived at
`docs/planning/perf-reports/2026-08-12-round2-multifloor-stress-verify.json`:

- **Multi-floor found a real 28x regime shift the standard sweep alone would never see.** Floor 0 →
  "First Floor" (index 1) switched and settled in 4.1s (not a cold load on this bench world — the
  event-driven waiter correctly reported `settled:true, timedOut:false`). `geometry.depthDraw`:
  **0.484ms → 13.729ms (28.4×)**. `geometry.earlyZPrepass`: 0.702ms → 9.967ms (14.2×).
  `geometry.worldDraw`: 5.301ms → 12.539ms (2.4×). This is precisely the class of finding this phase
  exists for — invisible to any single-floor capture, now one click away.
- **Rapid-diagonal found the SAME zones degrade under fast movement, independently.** 51 frames
  measured in the 5s window (avgFps 9.4 vs. 38.9 steady). `geometry.depthDraw`: 0.484ms → 6.615ms
  (13.7×). `geometry.earlyZPrepass`: 0.702ms → 5.222ms (7.4×). `geometry.worldDraw`: 5.301ms → 7.064ms
  (1.3×). Two independently-designed stress tests agreeing on the same three zones is a real signal,
  not a coincidence of one weird run.
- **The `summary` field worked exactly as intended** — top offender was `geometry.worldDraw`
  (5.301ms), and a REAL (non-trivial, 101 draw calls / 3,503 triangles) duplicate-geometry finding
  between `light.drawPointLights`/`light.drawColoration` (2.089ms) ranked #2, correctly distinct from
  the fullscreen-quad noise. `instrumentWarnings` correctly separated out the (already-known, already-
  accepted) timestamp-pool overflow rather than mixing it into the offender list. `cacheWarnings` was
  empty — every cache healthy this run.
- **The trimming fixes are confirmed working, dynamically, not just on the reference capture:** only 2
  individual `duplicate-geometry:*` findings this run (both real geometry) plus 1 consolidated
  fullscreen-quad finding, vs. 12 individual findings before the fix. `cpuEarlyMs` was RETAINED on 39
  of 66 zones this run (not stripped down to ~1) — verified this is correct, not a regression: this
  particular multi-phase capture genuinely triggered 41 real `temporal-shape:*` findings (this run's
  own residency/streaming pattern was more front-loaded than the reference capture's), and the
  mechanism is "keep it exactly where a real finding exists," which is what it did. 9 of 20 kept
  hitches had their `decodeStats`/`cacheStats` correctly collapsed to a same-as-earlier pointer.

### §5E — Deliberately NOT attempted this round, and why

The author's own framing was "I want this tool to do EVERYTHING" — everything below is real, was
scoped, and is not being silently dropped; it did not fit this session at the same tested/live-verified
bar as everything above without risking quality on what the author called critical work:

- **Zoom-thrash, scripted document-edit, and many-tokens-moving stress phases** — each is a real,
  separately-designed route addition (see the "menu of options" chat turn this document's own §5
  follows from). Deferred specifically because piling three MORE phases onto the same button in the
  same session, on top of the two just built, risks a sprawling, undertested mega-route rather than
  three well-verified ones.
- **Long-session soak** (loop the sweep for N minutes to catch memory growth/GC pressure/cache
  degradation) and **multi-client simulation** (a second Playwright context as a non-GM player) — both
  genuinely large, independent undertakings named in §2A/§2E above, not shrinkable to a same-session add-on.
  Per-effect INTERACTION cost (do two expensive effects together cost more than the sum of their
  parts) is similarly a real redesign, not an instrumentation addition.
- ~~**The remaining ~20 caches from the 31-cache discovery inventory** — compressed-textures' BC1/BC7
  cache, water-body/sun-shadow/wind bake counters (water-body already has one, the other two don't),
  `pyramid-store.js`'s IndexedDB persistence, door-graphics caches, and the UI/editor tier (paint-mode,
  anchor-mode, `describeRenderMode`). Priority order unchanged from §4's own checklist.~~ **SUPERSEDED
  — done in full, §5F below.** The author's own correction after reading this section: "You are right
  about everything except for cache stuff... We need every single cache system to be in this report."
- **Auto-diff against the last archived report** — named in §2E/§4, still real, still not built; the
  single highest-leverage NEXT item for catching silent regressions between sessions, given everything
  above already reuses `summarizeTierComparison` for exactly this kind of ranked comparison.

### §5F — Round 3: every remaining cache, wired

Direct author correction after §5E shipped: "You are right about everything except for cache stuff.
Ideally this report would include every cache. We need every single cache system to be in this report
so that's your next focus please." No other part of Round 2 was in question — this is a single-focus
completion pass over the ~20 caches §5E's own bullet had deferred, not a redesign.

**What `caches[]` reports now, by group** (39 distinct row ids possible in a fully-populated run — some
conditional, e.g. `shaderNodeBuilderCache`/`shaderPipelineCache` only appear once a probe has actually
installed, `windowSurfacesByFloor`/`windowMaskReloadGate` only once a floor has synced):

- **Tier A — already had native stats, just needed wiring** (5): `compressedTextureWorker` (BC1/BC7 +
  coarse-alpha worker, `compressed-textures.js`), `coarseAlphaGridRequests` (the CALLER-side per-item
  memoization layer — a DIFFERENT layer from the worker above, see that row's own note),
  `waterBodyBakeGate` (jump-flood bake-vs-poll, mirrors `maskAuthorityBakeGate`'s own doctrine),
  `framePassSlotAllocator` (`frame-profiler.js`'s own passId→slot Map, size-only — no hits/misses exist
  on that get-or-create branch), `windowSurfacesByFloor` (size-only, same reasoning).
- **Bake-gate sites** (6 new pairs across 4 files): `fireMaskBakeGate`/`fireSpawnBakeGate` (boot.js's own
  two single-slot caches), `sunShadowCasterFieldBakeGate`/`sunShadowFieldBakeGate` (TWO independent
  per-floor gates in sun-shadow-subsystem.js, summed across floors — they can diverge, see their own
  notes), `windFieldBakeGate` (misses-only — `bakeWindField` has no internal skip branch and its 5
  trigger reasons have incomparable upstream gating, so a fabricated hits counter was refused),
  `islandPackBakeGate` (misses-only, same doctrine, specular's `bakeIslandPack`).
- **Pool hit/miss sites** (11 rows across 3 mesh-pool groups + pyramidStore): point-light-pool.js's
  `lightMeshes`/`illumBuckets`/`colorBuckets` (a batched light never reaches `lightMeshes` at all — its
  activity shows up in the bucket rows instead), vt-pan-viewer.js's own `regionMeshes`/`occlusionDiscs`/
  `itemStates` (the last one gates the full async per-item asset load — by far the most expensive miss
  in this whole pass), door-graphics-subsystem.js's `doorTextureCache`/`doorLeaves`, and `pyramidStore`
  (the IndexedDB page-blob layer, `vt/pyramid-store.js` — module-level counters, no factory/closure to
  hold them, same treatment `pixiProxy` below needed).
- **UI/editor caches** (6 rows, explicitly lower priority — GM-only tooling, not a live-gameplay hot
  path, but the mandate was literal): `describeRenderMode` (`diag/render-fallback.js`'s own DOM-recompute
  throttle), `anchorMarkerPool`/`anchorViewMarkerPool` (the place/edit tool and its read/toggle sibling —
  two separate Maps, two separate rows), `paintModeGridCanvas`/`paintModeGridImageData` (ONE raw object
  with prefixed fields fans into two rows — a canvas hit can still pair with an ImageData miss on a
  resize).
- **Three special cases, each handled differently, on purpose** (this file's own header has the full
  reasoning): `graph/frame-graph.js`'s pool has **no adapter at all** — zero live callers
  (`graph/index.js`'s own header), so a row would either read permanently null or require importing
  deliberately-unexported machinery; wire it when it gets a real caller, not before. `maskDiscovery`
  reports the STORED one-shot result from scene load (`scene.discovery`, via a new
  `mask-authority.js#getDiscoveryStats`) as occupancy (`size`/`capacity`), not a per-window rate —
  `foundry/mask-discovery.js`'s own `listingCache`/`probeMemo` are function-local and gone by the time
  any report reads them. `pixiProxy` counts MSA's own write-ATTEMPT outcome into Foundry's
  `PIXI.Assets.cache`, explicitly never framed as a hit-rate against that store, which this codebase
  does not own and cannot see lookups against.

**Two real bugs caught by the project's own test/verify discipline before either reached a live run:**

1. **A structural mismatch, not a logic bug.** The first draft added `sunShadowCasterFieldBakeGate`/
   `sunShadowFieldBakeGate` as two keys inside `RAW_CACHE_ADAPTERS`'s per-key-matched map, but boot.js
   only provides ONE raw key (`sunShadowBakeGate`) both needed to read from — the exact
   `pointLightWallClip` shape (one raw object, many rows), which cannot live in a map keyed by
   adapter-name-equals-raw-key. `npm test` caught it immediately (`Cannot read properties of undefined
   (reading 'ownerEffectId')`); fixed by promoting both to a dedicated `buildSunShadowBakeGateRows`
   fan-out function, mirroring `buildPointLightWallClipRows`.
2. **A real crash risk in `mask-authority.js#getDiscoveryStats`, found by reading existing tests before
   trusting the new code.** The first draft read `scene.discovery.perFloor.length`/`.filter(...)`
   unconditionally. `mask-authority.test.mjs` already constructs multiple `setDiscovery(...)` payloads
   by hand with NO `perFloor` field (those tests only needed `byTargetId`/`method` for their own
   assertions) — a real, already-existing shape this new method would have thrown on the moment any of
   those fixtures flowed through it. Fixed with an `Array.isArray` guard before every `.length`/
   `.filter`, and a dedicated regression test added against that exact partial-fixture shape.

**Verification**: `npm run verify` green throughout, not just at the end (structure ratchet caught a
`masks/authority-only` violation — two label strings literally contained `_Fire`, reworded to drop the
literal mask-suffix pattern). Test count: 9022 → 9112 (+90 assertions) across `cache-report.test.mjs`
(the bulk), `render-fallback.test.mjs`, `pixi-proxy-textures.test.mjs`, `perf-session.test.mjs`, and
`mask-authority.test.mjs`.

### §5F.1 — LIVE-VERIFIED against the bench world, every new row populated with real data

Third live capture, bench world, 168s, archived at
`docs/planning/perf-reports/2026-08-12-round3-cache-completeness-verify.json`. **All 37 cache rows this
run's conditions could produce actually appeared, every single one carrying real, plausible numbers —
zero nulls-where-a-number-was-expected, zero fabricated-looking values.** (2 more possible ids,
`shaderNodeBuilderCache`/`shaderPipelineCache`, correctly did not appear — their probes were not armed
this particular run, which is the honest "not measured this window" absence, not a gap.)

- **The new low-hit-rate finding fired on a REAL cache, live, unprompted.** `findLowHitRateCaches`
  (built in Round 2, generalised from `depth-proxy-pool-health`) flagged
  `cache-low-hit-rate:describeRenderMode` — 41.4% (89 unnecessary rebuilds of 152 checks) — and the
  same number surfaced in the human-readable `summary.cacheWarnings` line ("worth a look before
  trusting it as healthy"). This is the whole point of Round 2's summary work, now proven on a cache
  that did not exist in the report until THIS round: the machinery built to make problems visible to a
  non-technical reader worked on its first real cache it had never seen before.
- **The all-zero rows are the correct answer, not a broken instrument.** `anchorMarkerPool`,
  `anchorViewMarkerPool`, `paintModeGridCache` (all four sub-fields), and `pixiProxy` (all four
  sub-fields) read exactly `0` across the board — correct, because this run never opened the anchor
  tool, the paint tool, or triggered a fresh floor-proxy registration. Distinguishing "genuinely zero
  activity" from "broken/unwired" was the whole design goal for these lower-priority rows; this run is
  the first live proof the distinction holds (a broken wiring would have produced `null`, not `0` —
  `buildCacheRows`'s own `if (!end) return null` guard is what would have fired instead).
- **`maskDiscovery` reported a real, specific fact about this bench scene**: `size:2, capacity:8` — 2
  of 8 discovered targets (floors + tiles) have at least one authored mask this run, `hits`/`misses`
  correctly `null` (the one-shot-summary design, not a rate).
- **The healthy bake gates are overwhelmingly skip-dominated, as expected**: `maskAuthorityBakeGate`
  748,762 hits vs. 2 misses; `sunShadowCasterFieldBakeGate`/`sunShadowFieldBakeGate` both 5,420
  hits vs. 4 misses per floor (2 floors, `slotsUsed:2`); `windowMaskReloadGate` 2,746 vs. 1.
  `windFieldBakeGate` (misses-only) read 3, `islandPackBakeGate` (misses-only) read 0 — both exactly
  the "rare, real work" shape the misses-only design predicted for a passive camera pan.
- **One honest surprise, noted rather than silently accepted or wrongly declared a bug**: on both
  floors, `sunShadowCasterFieldBakeGate` and `sunShadowFieldBakeGate` read IDENTICAL run/skip counts
  (5/2797 and 5/2797 at end, 3/87 and 3/87 at start — see the raw `instrument.cacheStats.end.
  sunShadowBakeGate.floors[].bakeGate` in the archived JSON). The source code checks two genuinely
  different conditions (`version !== casterFieldVersion` vs. `paramsChanged||geometryChanged||
  lowerChanged||sunNeedsRebake(...)`), re-verified by re-reading both branches after seeing this — not
  a copy-paste bug. Most likely explanation: on this bench scene, during a pure camera pan with no
  document edits, the ONLY thing driving either gate is periodic mask-authority version bumps from
  ongoing page-ingest during streaming, and floor 1's shadow bakes cascade from floor 0's
  (`lastBake.reason:"cascade"`) — a plausible real correlation for this specific scene, not proven
  either way without deeper tracing. Flagged here rather than buried; not a blocker for this round's
  own goal (prove every row is wired and populated), but worth a look before trusting the TWO gates as
  independent signals on this particular map.

---

*Companion documents: `Performance-Audit-2026-08.md` (renderer code-read), `Performance-Insights.md`
(measured ledger), `Residency-Streaming-Audit-2026-08-11.md`, `Trace-Analysis-2026-08-11.md`,
`Moonshot.md`, `docs/holy/V4-Testament.md` (P-006, P-008, P-009, P-010).*
