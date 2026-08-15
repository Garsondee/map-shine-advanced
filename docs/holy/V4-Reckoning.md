# ✠ THE V4 RECKONING ✠
*The full-system rendering audit — every moving part named, measured, and judged.*

**This is a holy document.** It lives in `docs/holy/` and is governed by **The Covenant**,
whose rules are repeated here so no reader can miss them:

> **RULES OF THIS PLACE**
> 1. Only a **Fable-class or greater** model may create a holy document, restructure this one,
>    edit its Law, its definitions of done, its gates, or resolve a Petition.
> 2. **Any model** may execute passes and record completion — flip `[ ]` to `[x]` and append an
>    evidence line. That is the full extent of a worker's editing rights here. (Two additional
>    worker rights specific to THIS document: appending rows to the **Findings Ledger**, and
>    appending seeded-candidate lines to a census row's `leads:` field. Nothing else.)
> 3. Only a **Fable-class** model may **countersign** (`✠`) — by inspecting the actual work,
>    never the worker's summary.
> 4. A worker who believes the plan is wrong does not edit the plan. It files a **Petition**
>    (§ at the bottom) and moves on. Fable adjudicates petitions.
> 5. Above everything in this file sits **the author**. Their LIVE verdict on a real scene
>    outranks any countersign; their word rewrites any Law.

**Created 2026-08-15 by Claude Fable 5, at the author's command.** Subordinate to
`docs/holy/V4-Testament.md` (Law 10: all V4 work flows through the Testament — this campaign
is registered there, Book III). Companion evidence lives in `docs/planning/reckoning/` (pass
reports) and `docs/planning/perf-reports/` (captures).

**Task notation** (identical to the Testament's — the only states that exist):

```
- [ ] open
- [x] claimed        · done <model> <date> — <one-line evidence: what changed, how verified>
-  ✠  countersigned  · ✠ <date> — <verdict, after inspecting the work itself>
-  ⚑  reopened       · ⚑ <date> — <findings; these findings ARE the next worker's brief>
```

---

## WHY THIS DOCUMENT EXISTS

**The author's observation (2026-08-15):** going up one floor costs about **10× more
rendering**, where ~2× would be expected. Efforts so far haven't landed the fix. The author's
thesis: *the causes live in the places we rarely look.* The commissioned answer is not another
guess — it is an exhaustive, system-by-system audit of the entire renderer: every system named,
every subsystem inside it given its own investigative pass for **performance**, **correctness**,
and **cleanliness**, continuing PAST the first bug found until the whole map of the machine has
been walked.

**What the instruments already know (read before forming any theory):** the v0.6.1 baseline
(`docs/planning/Performance-Review-v0.6.1.md`, raw JSON
`docs/planning/perf-reports/2026-08-13-v0.6.1-baseline.json`) measured the author's experience
precisely:

| Zone | Ground (floor-0) | First Floor (floor-1) | Ratio |
| --- | --- | --- | --- |
| whole frame (GPU p50) | 15.93 ms · 57.8 fps | 31.39 ms · 30.5 fps | **1.97×** |
| `geometry.worldDraw` | 8.904 ms | 12.492 ms | 1.40× |
| `geometry.depthDraw` | 0.722 ms | 6.866 ms | **9.51×** |
| `geometry.earlyZPrepass` | 0.660 ms | 6.446 ms | **9.77×** |

So "10×" is real and it is *concentrated*: two depth-side passes carry it, while the main
colour draw grows only 1.4×. Bug-Tracker **#20** holds the confirmed mechanism for those two
zones (First Floor's art is 66.7% transparent; a `discard()`-bearing shader loses hardware
early-fragment tests and pays full-footprint fragment cost) and a fix — **S1a extended to the
depth proxies** — is `BUILT (unverified)`, commit `94362d5`, with **no fresh capture yet**.
That verdict capture is this campaign's first act (R0.1), and nobody gets to skip to theories
before it exists.

**Why the campaign doesn't end even if R0.1 comes back green:** the author's 2× expectation is
itself unmet — worldDraw's 1.4× and the whole-frame ~2× are products of *many* small
multipliers, this map is the *easiest* hard case we will ever ship (bigger maps, more floors
are the business plan), and the author has explicitly ordered the sweep to continue past the
first bug. A healthy upper floor on the Mansion is the gate; a renderer whose every part has
been inspected and either cleaned or exonerated is the goal.

---

## THE QUESTION, MADE MEASURABLE

**Canonical scenario — "the balcony case":** bench Mansion Redux, **the same viewpoint on both
floors**, chosen so that from floor-1 the camera sees ground-floor art through First Floor's
transparent holes (the author's literal complaint case). Two capture styles, both floors each:

- **Parked** — camera still at the canonical viewpoint. Isolates steady-state frame cost.
- **Touring** — the baseline's `n_to_s:2kf/60000ms` route, for comparability with v0.6.1 and
  to exercise streaming.

Fixed conditions for every capture: 3840×1906 @ 1.5 DPR, idle machine, and **check the JSON's
`window.resolution` field before believing anything** — two prior captures silently came back
at 1920×1080, cause never found (a standing question for the R-38/R-39 instrument passes).

**The Multiplier Ledger (§ near the bottom)** is the campaign's scoreboard: per-zone
Ground-vs-First ratios from the canonical captures. The campaign's perf claim is closed only
when every ratio above **1.5×** is either EXPLAINED-AND-FIXED or EXPLAINED-AND-ACCEPTED (author's
call), and the whole-frame ratio meets the Testament's own comfort bar (First Floor sustained
40+ fps acceptable, 60 target).

---

## THE LAW OF THE RECKONING (binds every pass)

1. **The Covenant governs this file.** Workers: flip boxes, append evidence, append Findings
   Ledger rows, file petitions. Nothing else.
2. **Measure before believing.** A suspicion without a number is filed as SUSPECTED and may
   not be called "the cause" — in the report, the chat, or the commit message. This project
   has been burned by plausible diagnoses rotting into false history.
3. **Past first blood.** A pass does not end because it found something juicy. Every pass
   answers ALL standard questions, files its exonerations, and confesses what it didn't read.
   The author's explicit command: keep going until the whole system has been looked at.
4. **Multipliers compound.** ~2× whole-frame is a *product* of many small factors. Every
   contributor ≥1.1× is ledger-worthy. Do not discard "only 20%" findings — three of them are
   the difference between 60 fps and 35.
5. **Exoneration is a result.** "Checked, clean, here's the evidence" prunes the search space
   and is recorded with the same care as a finding. No census row exits UNAUDITED.
6. **Audit the instruments too.** A diagnostic that lies is a finding of the highest class.
   Known liars at campaign open: `getGeometryComposition()` (125× undercount vs its neighbour
   zone, v0.6.1 §4.2 — repair is R0.2); the GPU timestamp pool silently drops samples past
   1024 pending (v0.6.1 §4.1 — R0.3).
7. **Findings are not fixes.** An audit pass changes NO runtime code. Findings go to the
   Findings Ledger; confirmed bugs get Bug-Tracker entries; fixes are separate, later work
   under Testament law with their own verification. (Exception: a pass may fix its OWN
   instruments/tooling, marked as such.) A worker itching to fix mid-pass writes the fix
   *sketch* in the report and moves on.
8. **Every claim cites.** Code claims: `file:line`. Measurements: the JSON path under
   `docs/planning/perf-reports/` plus its `window.resolution`. Pixel claims: the artifact
   path. "I saw it while scrolling" is not a citation.
9. **`BUILT (unverified)` ≠ `LIVE`.** Only the author's eyes promote. Standing project law.
10. **Bench = production inputs.** Perf evidence comes from the live harness on the bench
    Mansion (the author's real export, imported via `tools/scene-import.mjs`). Shader-lab
    results are hypotheses, never verdicts. Never touch the author's real Foundry (Testament
    Law 11).
11. **The census is machine-checked, not hoped.** `tools/audit-coverage.mjs` (built in R0.4)
    verifies every `src/` file is owned by exactly one census row. A file with no owner fails
    the check loudly. Hand-maintained lists forget things; this one isn't allowed to.
12. **One row, one session.** A worker session takes ONE census row (two only if both are
    trivially small). Evidence quality collapses when a session spreads thin — and the
    evidence trail is the product.

---

## FIELD DISCIPLINE (the traps that have already bitten — self-contained, no tribal knowledge required)

- **fps is directional, GPU-ms is the currency.** Trust per-zone GPU milliseconds from
  `perf-run-full`; fps only for headline sanity. Needs an idle machine.
- **`multiFloor.ranked` is a top-25.** The full per-floor comparison is
  `MapShine.getMultiFloorReport()` from the console — capture and archive it, don't re-pay
  for a second run.
- **An absent zone row IS a measurement.** A conditional zone that never fired tells you which
  branch ran. Two past audits read absence as "no data" and aimed fixes at code that never
  executed. State which branch the absence proves.
- **Touring and parked captures answer different questions** (streaming vs steady-state).
  Name which one you ran; conclusions from the wrong style are void.
- **The structural A/B tool (`src/diag/perf-structural-ab.js`) requires 1.5× clearance over
  its own noise floor.** Below that the verdict is "could not tell", never "no difference" —
  v0.6.1 §4.4 is the worked example.
- **A pixel-diff gate proves correctness, never speed; a capture proves speed, never
  correctness.** A perf fix claim needs both, named separately.
- **Async zones absorb concurrent frames.** A wall-clock bracket around an async span counts
  OTHER work that happened to run during it. Per-frame-reset counters or GPU zone sums only.
- **Check `window.resolution` in every capture JSON** (see canonical scenario above).
- **`git add -A` is forbidden** — the author live-edits while sessions run. Stage named files
  only.
- **`npm run verify` green before any tooling change under `src/` or `tools/` is claimed.**

---

## THE METHOD — five phases

### Phase R0 — Arm the instruments *(no theories allowed until this is done)*

- [ ] **R0.1 · The S1a verdict capture.** `perf-run-full`, bench Mansion, BOTH floors, same
      touring route as the v0.6.1 baseline, idle machine. Archive the JSON + the full
      `MapShine.getMultiFloorReport()` output under `docs/planning/perf-reports/`. Seed the
      Multiplier Ledger from it. Verdict required in the evidence line: did Bug #20's fix
      collapse `geometry.depthDraw` / `geometry.earlyZPrepass` toward ~1×? Update Bug #20's
      status accordingly. **This is the single most valuable act in the whole campaign and it
      costs one capture.**
- [ ] **R0.2 · Repair `getGeometryComposition()`.** It reports 4 meshes / 2,130 triangles
      beside a zone showing 13 draws / 266,398 triangles, with zero `unresolvedItems` — a
      closed-list walker that can't see what it can't name, reporting certainty anyway. Find
      what worldDraw actually contains that the tool doesn't walk; make the tool name it; the
      repaired numbers must land in the `perf-run-full` JSON (standing rule: diagnostics live
      in the report, console-only diagnostics have little value). This tool is R2's
      microscope for the biggest single cost on both floors — it must stop lying first.
- [ ] **R0.3 · GPU timestamp pool ceiling.** `maxPendingSize` hit 2020 against a 1024 cap in
      the baseline run; past the cap, zone samples silently vanish. Raise the cap to cover the
      standard route (measured headroom, not a guess) AND make overflow a loud verdict field
      in the JSON, not a buried boolean.
- [ ] **R0.4 · The coverage gate — `tools/audit-coverage.mjs`.** Parses this document's census
      (stable grammar: `- [ ] R-<nn> · <name>` rows followed by indented `files:` lines),
      walks `src/` (excluding `vendor/`), and reports: files owned by no row, files owned by
      two rows, files listed but missing on disk. Node-tested like every other tool. Report-only
      until R2 opens; hard red thereafter. New files appearing in `src/` after campaign start
      must claim an owner row to pass.
- [ ] **R0.5 · The ablation lever registry.** Enumerate every runtime kill-switch that can
      isolate a subsystem live (the structural-A/B toggle list, effect enables,
      `earlyZComposition`, fire/water/vegetation/weather enables, …). Record each census row's
      lever in its `lever:` field. A row with NO lever is flagged `lever: NONE` — which is
      itself a standing instrumentation finding: an unmeasurable subsystem.
- [ ] **R0.6 · The balcony pair.** Choose and record the canonical parked viewpoint (floor-1
      camera seeing ground-floor art through real holes; author may veto/replace). Capture the
      parked pair on both floors, archive JSONs + screenshots, add the parked columns to the
      Multiplier Ledger.

### Phase R1 — The seeded strike *(the author's directive: transparency first)*

The author ordered the first deep passes aimed at **how partially-transparent art is handled
differently from opaque art**, on the upper-floor-looking-down case. The seeded rows are walked
FIRST, in ledger-informed order, using the full pass protocol. Current seed order (Fable,
2026-08-15 — R0.1's numbers may reorder it; each row's SURVEY file is its opening brief):

1. **R-03 + R-10** — the geometry passes & the early-Z mode (SL-1's verdict lands here; SL-4's
   residual boundary/passthrough cost).
2. **R-16** — the floor model: the ground-vs-upper contrast table made measurable (SL-2, SL-5).
3. **R-08 + R-09** — the transparency fork's data & the colour material (SL-4; the author's
   literal directive).
4. **R-27** — window light's per-floor scenes (SL-3).
5. **R-07** — residency & paging across floors (SL-5).
6. **R-12** — depth authority & its seven consumers.
7. **R-22 + R-23** — point lights (SL-6 anchor widening, SL-8 slot sampling).

### Phase R2 — The full sweep *(every census row, no exceptions)*

Order: `prior:` suspicion descending → measured ledger cost descending → least-recently-read
first (the author's thesis is that bugs live where we rarely look; when in doubt, prefer the
dusty corner). Every row gets the full pass protocol and a filed report. The sweep is DONE
when the census shows zero `[ ]` rows and the coverage gate is green.

### Phase R3 — Cross-cutting sweeps *(costs no single row owns)*

- [ ] R3.1 · Render-target registry review: every target's size formula, format, clear policy,
      and actual refresh cadence vs need.
- [ ] R3.2 · Per-frame allocation & GC pressure (objects, arrays, closures born per frame).
- [ ] R3.3 · CPU orchestration: the frame driver's own cost, update-call ordering, redundant
      per-frame recomputation.
- [ ] R3.4 · Pass/draw census: pass count per frame vs the Stage-0 "8 passes" record; draw
      calls per pass; bind-group/pipeline churn.
- [ ] R3.5 · Cache health review: every instrumented cache's hit rate on the canonical pair
      (the cache-report tool), with named verdicts.
- [ ] R3.6 · Worker & async traffic: compressor/decode workers, transfer sizes, main-thread
      stalls.
- [ ] R3.7 · Event-driven work audit: Foundry hooks that fire per-frame-ish and what they
      trigger.

### Phase R4 — Close-out *(gates, all mandatory)*

- [ ] G1 · R0.1 verdict recorded and Bug #20 status updated.
- [ ] G2 · Coverage gate green: 100% of `src/` owned, zero double-owned, zero ghosts.
- [ ] G3 · Every census row `[x]` with a filed report; Fable has countersigned the batch
      (inspecting reports AND spot-inspecting the cited code, per Covenant).
- [ ] G4 · Multiplier Ledger: no UNEXPLAINED ratio >1.5× on the canonical pair.
- [ ] G5 · The instruments tell the truth: R0.2/R0.3 verified against a real capture.
- [ ] G6 · A fresh post-campaign capture pinned as the new baseline beside v0.6.1's.
- [ ] G7 · The author's LIVE verdict on First Floor comfort, recorded in SIGNATURES.

---

## THE PASS PROTOCOL (how one census row is audited)

1. **Claim** the row: append `· claimed <model> <date>` (do not flip the box yet).
2. **Read the prior evidence**: this doc top-to-here, the row's `leads:` lines, any linked
   Bug-Tracker entries and planning docs. Do not re-discover what is already written.
3. **Static pass**: read the manifest files — ALL of them; record per-file how much you
   actually read. Answer the Standard Questions from the code, `file:line` per claim.
4. **Dynamic pass**: exercise the row's zones on the canonical pair; flip its ablation lever
   if one exists and record the delta (respecting the A/B noise-floor rule); pull the relevant
   rows from the latest capture JSONs. If the row has neither zone nor lever, that absence is
   automatically Finding #1 of the pass (class: instrumentation).
5. **File the report** at `docs/planning/reckoning/R-<nn>-<slug>.md` using THE TEMPLATE.
   Findings get ledger rows; confirmed bugs ALSO get Bug-Tracker entries; plan disagreements
   become Petitions.
6. **Flip the box** with the one-line evidence (worst finding OR "clean", + report path).
7. **Stop.** Fixing is a different job under different law (Law 7).

**Session sizing:** one row per session (Law 12). If a row proves too big for one session,
file what you have, mark the row `· partial <model> <date> — <what remains>`, and petition to
split the row.

---

## THE STANDARD QUESTIONS (every pass answers all twelve; "n/a because <reason>" is legal)

**Performance lens**
- **Q1 — What runs per frame?** Every per-frame entry point of this subsystem, vs what merely
  *can* run. List both.
- **Q2 — What does it scale with?** Floor count · visible-floor set · tile count · light
  count · resolution · residency churn. THE campaign question: what is different when the
  active floor is upper vs ground? Measured where possible.
- **Q3 — What work happens for invisible things?** Other floors, disabled effects,
  zero-count populations, off-screen items. Name the gate that should stop the work and its
  polarity (does it fail open or closed?).
- **Q4 — What does it submit to the GPU?** Draws, passes, targets, bind groups. Does anything
  duplicate another subsystem's submission?
- **Q5 — What does it allocate per frame?** JS objects and GPU resources. Pool hit rates.
- **Q6 — Transparency.** Does this subsystem branch on alpha anywhere? Does it respect the
  S1a interior/boundary split, ignore it, or fight it?
- **Q7 — Is its cost visible?** Which zones cover it; what an absent row would mean; any cost
  with NO zone (invisible cost is unfixable cost).

**Correctness lens**
- **Q8 — Silent preconditions.** Which inputs can be absent/stale/late, and what happens then?
  (The S1a min-grid arrived late and the split sat dead for a whole session — this exact
  class.)
- **Q9 — Lifecycle.** Startup order, floor switch, resize, device loss, scene teardown: what
  breaks, what leaks, what re-arms?
- **Q10 — Hand-kept lists.** Does it maintain one? What forgets to join it, and would anything
  notice?

**Cleanliness lens**
- **Q11 — Conventions & rot.** `src/CONVENTIONS.md` conformance; dead code; exports nothing
  consumes; TODOs that are actually bugs.
- **Q12 — Misreadability.** Anything the next reader will misread: one value carrying two
  meanings, derived-vs-configured zeroes, same-name-different-registry fields, Y-flips.
  Name them even when currently harmless.

---

## THE TEMPLATE (copy verbatim for every pass report)

```markdown
# Reckoning pass R-<nn> — <subsystem name>
**Worker:** <model> · **Date:** <date> · **Census row:** R-<nn>
**Manifest:** <N files, X,XXX lines> · **Actually read:** <list any file NOT fully read + why>
**Instruments:** <capture JSONs (+ window.resolution), lever used + delta, zones consulted,
console reports> — "NONE, because <reason>" is legal but is itself a finding (Q7).

## Verdict
<CLEAN | n FINDINGS, worst: <one line>> — one sentence a tired author can trust.

## The upper-floor question
<What THIS subsystem does differently when the active floor is upper vs ground — measured
numbers if a lever/zone exists, else UNMEASURED + what it would take to measure.>

## Findings
### F-R<nn>.1 — <title>
- **Class:** perf | correctness | cleanliness | instrumentation
- **Suspicion (upper-floor multiplier):** S0 exonerated | S1 background cost | S2 plausible
  contributor | S3 likely contributor | S4 measured contributor (<n>× on zone <z>)
- **Evidence:** <file:line, numbers, JSON paths>
- **Falsification:** <the specific, runnable experiment that would prove or kill this>
- **Fix sketch:** <≤1 paragraph; fixing happens elsewhere>
- **Filed:** ledger row F-<id> [+ Bug-Tracker #<n> if confirmed-bug class]

## Exonerations
<Each thing checked and found CLEAN, with the evidence that clears it. This list is the pass's
real product when findings are few — it is what lets the next investigator skip this ground.>

## Standard questions Q1–Q12
<Terse answers, every one present.>

## Confession
<What this pass did NOT read, run, or verify; anything taken on faith. An honest confession
here is worth more than a padded findings list.>
```

**Suspicion scale** (used everywhere): **S0** exonerated · **S1** real cost, floor-neutral ·
**S2** plausible upper-floor contributor · **S3** likely contributor (mechanism identified,
unmeasured) · **S4** measured contributor (number attached). Only S4 may be spoken of as a
cause, and only in its measured size.

---

## THE CENSUS — every moving part, one owner row each

**The opening surveys.** Four scout reports captured at campaign creation (2026-08-15) are the
census's source data and every early pass's opening brief — `docs/planning/reckoning/`:
`SURVEY-inventory.md` (all 259 files, zones, caches, tools), `SURVEY-frame-anatomy.md` (the
ordered pass list, render-target registry, 11 cost surprises D1–D11),
`SURVEY-transparency-pipeline.md` (the opaque-vs-transparent fork, end to end),
`SURVEY-floor-behavior.md` (the ground-vs-upper contrast table). Spot-verified at key sites, not
countersigned line-by-line: treat them as maps, re-verify anything you build on.

**Ground rules.** 259 runtime `.js` files under `src/` (excluding `__tests__/`), every one owned
below; `tools/audit-coverage.mjs` (R0.4) enforces it. Two files are too big for one row and are
split by **`scope:`** (a named function-family within the file): `src/vt/vt-pan-viewer.js`
(16,649 lines) and `src/boot.js` (8,700). A scoped row audits its named functions/regions; the
coverage script counts a scoped file as owned when ≥1 row lists it. Row fields:

```
- [ ] R-<nn> · <name> — <one-line role>
      files: <manifest with line counts>            [scope: <function family> where split]
      inst: <singleton | per-floor | per-item | per-light | data> · hooks: <per-frame entry points>
      zones: <perf zone ids, or NONE> · lever: <kill switch, or TBD(R0.5) or NONE>
      prior: S<0-3> — <one-phrase reason>
      leads: <optional seeded pointers; workers may append here>
```

### SYSTEM A — Frame core & pass graph

- [ ] R-01 · Frame driver & loop body — who ticks, what runs each frame, in what order
      files: src/core/frame-clock.js (241) · scope in src/vt/vt-pan-viewer.js: `renderFrame` (:10001–10260), main loop start (:12461) · scope in src/boot.js: the HEARTBEAT second renderer + its loop (:8585–8669, `bootHeartbeat` :8534)
      inst: singleton (plus ONE extra WebGPU device: the heartbeat) · hooks: everything — this IS the per-frame list; also the camera-path 30fps cap gate (:10029, the P-003 trap)
      zones: tick.* (6) · lever: NONE (it's the loop) · prior: S2 — ordering/duplication errors here tax every frame; see SL-9 (heartbeat)
- [ ] R-02 · Pass graph & runner — the declared 15-pass plan and its law-enforcing allocator
      files: src/graph/passes.js (604), frame-graph.js (594), three-allocator.js (393), pass-impls.js (205), pass-health.js (141), run-frame.js (123), pass-seams.js (61), index.js (43)
      inst: frozen data + one allocator · hooks: runPassPlan (vt-pan-viewer.js:10218)
      zones: dynamic pass.* (≤32) · lever: NONE · prior: S2 — declared graph vs actual execution can drift; allocator sizes every target
- [ ] R-03 · The geometry passes — world draw, depth-authority draw, early-Z prepass
      files: src/vt/scene-depth.js (544), src/vt/depth-proxy-material-pool.js (220) · scope in vt-pan-viewer.js: `runGeometryWorldPass` (:4595), `runSceneDepthPass` (:4692), prepass block (:4629–4637)
      inst: singleton · hooks: all three renders per frame (order: depth → prepass(clear) → world)
      zones: geometry.worldDraw/depthDraw/depthSetup/depthRenderCall/depthRestore/earlyZPrepass/doorDraw · lever: earlyZComposition flag
      prior: **S3 — the two 9.5×/9.8× zones live here; Bug #20's fix is BUILT (unverified)**
- [ ] R-04 · Present composite & grade fold — the final blit and the Look folded into it
      files: src/effects/grade/grade-ops.js (365), grade.js (180), grade-present.js (160), lut-cube.js (157), grade-pass.js (45) · scope in vt-pan-viewer.js: `runPresentCompositePass` (:4755)
      inst: singleton · hooks: present.blit (:4769) · zones: present.blit (grade itself: NONE — EFFECT_ZONING 'none')
      lever: grade enable · prior: S1 — fixed-cost full-screen work, floor-neutral on its face
- [ ] R-05 · Post chain — bloom & depth-of-field
      files: src/effects/bloom.js (263), bloom-render.js (257), depth-of-field.js (160), depth-of-field-render.js (186), depth-of-field-blur.js (118) · scope in vt-pan-viewer.js: `runPostBloomPass` (:5343), `runPostDofPass` (:5437)
      inst: singleton · hooks: bloom.* (6 zones), dof.* (3) · lever: bloom/dof enables
      prior: **S3 for DoF — it is NOT floor-neutral: the whole pass is skipped on floor 0 (vt-pan-viewer.js:5440) and runs only on upper floors (SL-2)**; bloom S1

### SYSTEM B — Image surfaces & the VT core

- [ ] R-06 · Image ingest & block compression — source file → BC1/BC7 + alphaStats + min-grid
      files: src/vt/block-compress.js (2371), bc-compress.worker.js (629), compressed-textures.js (345), texture-limits.js (277), mip-resample.js (370), decode-primitives.js (378)
      inst: singleton + worker · hooks: none per-frame (async pipeline)
      zones: residency.decode (partial) · lever: NONE · prior: S1 — one-time cost, but its OUTPUTS (alphaStats, min-grid, format) gate everything in R-08/R-10
- [ ] R-07 · Decode, residency & paging — what is resident, per floor, and when it changes
      files: src/vt/decode-pool.js (1240), decode-pool.worker.js (220), residency.js (305), page-cache.js (363), page-table.js (210), pyramid-store.js (156), settle.js (165), vt-live-decode-report.js (88), index.js (129) · scope in vt-pan-viewer.js: `updateResidencyUnguarded` (:11235), `scheduleResidencyUpdate` (:11752), `ensureItemLoaded` (:6475)
      inst: singleton + worker · hooks: residency.* zones (11) — event/settle-driven, not strictly per-frame
      zones: residency.pass/decode/coarsePinBudget/coverAlphaPrime/staleRelease/itemLoad* · lever: TBD(R0.5)
      prior: **S3 — what does floor-1 keep resident/streaming for floor-0? P-008/P-009 history says this system's cost story has flipped twice**
- [ ] R-08 · Coverage meshing & alpha classification — the transparent-vs-opaque fork's data
      files: src/vt/coverage-mesh.js (367), coarse-alpha.js (215), mask-image.js (295) · scope in vt-pan-viewer.js: `setTileGeometry` (:8297–8460)
      inst: pure + per-tile data · hooks: rebuild on grid/min-grid arrival
      zones: NONE of its own · lever: NONE · prior: **S3 — author-directed first target; the four-classification stack (format/alwaysOpaque/interior/per-cell) decides every pass's cost**
- [ ] R-09 · Whole-image mesh & colour material — where background/foreground/tiles become draws
      files: src/scene/world-quad.js (410), src/vt/scene-attr.js (962) · scope in vt-pan-viewer.js: `buildWholeImageMaterial` (:7144–7330), `ensureWholeImageMeshes` (:11579), compressed/raw build paths (:8620–8846)
      inst: per-item mesh+material · hooks: drawn in geometry.worldDraw
      zones: geometry.worldDraw (shared) · lever: NONE · prior: **S3 — default state is transparent+depthTest:false+DoubleSide+maskNode discard; worldDraw's 1.4× lives here; the MRT attr write doubles every fragment's output**
- [ ] R-10 · Early-Z composition mode — the S1a split as a live mode
      files: (shares R-03/R-08 files) · scope in vt-pan-viewer.js: `earlyZInteriorVerdict` (:10609), `applyEarlyZTileState` (:10643), `ensureSplitInteriorMaterial` (:10760), `sweepWorldSceneDepthWrites` (:10794), `addDepthPrepassTwin` (:10832), `rebuildSceneDepthProxies` (:10910–11230)
      inst: mode over R-03/R-09 · hooks: per residency pass + per frame Z refresh
      zones: depth.proxyRebuild · lever: earlyZComposition (default true)
      prior: **S3 — Bug #20's fix lands here; gate drift already found (see SEEDED LEADS); boundary cells still pay full blended cost**
- [ ] R-11 · View state & camera — pan/zoom, view rects, camera-path playback
      files: src/vt/view-state.js (412), src/foundry/camera-path.js (494), camera-path-player.js (468) · scope in vt-pan-viewer.js: `updateCamera` (:7047), `updateContinuousInputs` (:11878)
      inst: singleton · hooks: tick.camera, tick.continuousInputs · zones: those two · lever: NONE
      prior: S1 — but view-rect math feeds residency and spawn rects; errors amplify elsewhere

### SYSTEM C — The authorities

- [ ] R-12 · Depth authority & the layering law — rank, sort, occlusion queries
      files: src/scene/depth-authority.js (305), layer-order.js (357), occlusion.js (309), sky-reach-access.js (224) · scope in vt-pan-viewer.js: authority rebuild sites (:11264, :11329), `querySceneDepth` consumers
      inst: singleton · hooks: depth.authorityRebuild (on demand), consumed per frame by every masked material
      zones: depth.authorityRebuild, depth.proxyRebuild · lever: NONE (sole occlusion system by law)
      prior: **S3 — seven consumer systems; the rank→depth mapping and its consumers are the campaign's second seeded strike**
- [ ] R-13 · Mask authority — catalog, discovery, derivation, paint, serving
      files: src/scene/mask-authority.js (1226), mask-derive.js (1158), mask-catalog.js (630), paint-mask.js (384), mask-authority-report.js (191), index.js (97), src/foundry/mask-discovery.js (357), paint-adapter.js (140)
      inst: singleton · hooks: version poll per frame (tick.windRebakePoll reads it); serving on demand
      zones: none direct · lever: NONE · prior: S2 — every effect pulls masks; a per-floor miss here fans out
- [ ] R-14 · Anchor authority — discrete authored points
      files: src/scene/anchor-catalog.js (540), anchor-authority.js (467), src/foundry/anchor-adapter.js (52), v2-anchor-import.js (333)
      inst: singleton · hooks: event-driven · zones: NONE · lever: NONE · prior: S0–S1 — small, event-driven

### SYSTEM D — Foundry adapter & gameplay objects

- [ ] R-15 · Scene document readers — layers, geometry, lights, walls, regions read from Foundry
      files: src/foundry/scene-layers.js (522), scene-geometry.js (413), scene-lights.js (654), scene-walls.js (314), scene-wall-clip.js (299), scene-regions.js (143), scene-occlusion-sources.js (115), scene-environment.js (175), index.js (256)
      inst: pure readers · hooks: read by consumers per frame (token/door/env/light sync)
      zones: costs land in tick.*/light.* consumers · lever: NONE
      prior: S2 — collectSceneLayers/collectLevelTextures define what EXISTS per floor; over-collection here multiplies everything downstream
- [ ] R-16 · The floor model & floor switch — active floor context, per-floor visibility law
      files: src/foundry/active-scene-source.js (288 — `getActiveSceneFloors`, `computeVisibleFloorIndices`) · scope in src/boot.js: `activeFloorContext` family (:1011–1085), `buildItems` (:6597–6613), floor-switch path (:8290–8302) · scope in vt-pan-viewer.js: `setFloorIndex` (:12026–12068), `view.floorIndex` consumer sweep
      inst: **TWO authorities** — boot's `activeFloorContext` + the viewer's `view.floorIndex` (deliberate seam, boot.js:1059-1077) · hooks: consulted everywhere per frame; `getActiveSceneFloors` runs per frame inside the light pass (:4795)
      zones: none direct · lever: the floor switch itself (compare floors = the campaign's core A/B)
      prior: **S3 — THE campaign question: what work does "active floor = upper" schedule that ground doesn't. Read SURVEY-floor-behavior.md first; its contrast table is this row's opening brief**
- [ ] R-17 · Tokens, doors & occlusion discs
      files: src/foundry/scene-tokens.js (331), scene-doors.js (239), src/effects/door-graphics-subsystem.js (361), door-graphics-render.js (332), door-graphics.js (105) · scope in vt-pan-viewer.js: `syncTokenPlacements` (:6661), `syncDoorGraphics`, occlusion disc pool
      inst: per-item pooled · hooks: tick.tokenSync, tick.doorSync, geometry.doorDraw, masks.occlusion*
      zones: those · lever: TBD(R0.5) · prior: S1 — pooled and small, but sync runs every frame regardless of change
- [ ] R-18 · Canvas compositing & lifecycle — the seam where MSA overlays Foundry
      files: src/foundry/canvas-compositing.js (541), canvas-lifecycle.js (109), pixi-proxy-textures.js (257)
      inst: singleton + rAF watchdog · hooks: canvas-lifecycle rAF (:93), proxy swaps event-driven
      zones: NONE · lever: NONE · prior: S2 — Foundry-side suppression already caused Bug #18 (frozen fog snapshot); what else does the seam hold half-suppressed?
- [ ] R-19 · Settings, persistence, export & time
      files: src/foundry/settings-adapter.js (80), sky-persistence.js (211), scene-export.js (202), game-time.js (214), scene-controls-button.js (118)
      inst: singleton · hooks: game-time read per frame via env snapshot · zones: within tick.envSnapshot · lever: NONE · prior: S0–S1

### SYSTEM E — World state

- [ ] R-20 · Environment snapshot, day clock, sun & sky handles
      files: src/world/day-clock.js (267), sun.js (244), environment.js (194), sky-settings.js (146), index.js (83), src/effects/sky-access.js (340), shadow-access.js (299) · scope in vt-pan-viewer.js: `updateEnvSnapshot` (:5569)
      inst: immutable handles re-created on version bump · hooks: tick.envSnapshot per frame
      zones: tick.envSnapshot · lever: NONE · prior: S1 — but handle re-creation frequency is worth an eye
- [ ] R-21 · Wind — field bake, enclosure, GPU sim, access
      files: src/world/wind-field.js (949), wind-enclosure.js (813), wind-sim.js (620), wind-access.js (489), wind-sim-gpu.js (434), wind-bake.js (184) · scope in vt-pan-viewer.js: `tickWindSim` (:3889), `bakeWindField` (:3184), `pollMaskAuthorityForWindRebake` (:3098)
      inst: singleton, handle re-created on rebake · hooks: sims.wind per frame, tick.windRebakePoll per frame
      zones: sims.wind, sims.windBake, tick.windRebakePoll · lever: TBD(R0.5)
      prior: S1 — sim is fixed-cost; the per-frame POLL and bake triggers are the floor-sensitive part

### SYSTEM F — Lighting

- [ ] R-22 · Point-light pool & batching — CPU update side
      files: src/effects/lighting/point-light-pool.js (2292), point-light-batch.js (303), point-light-batch-mesh.js (834), point-light-merged.js (416), lighting-pass.js (70)
      inst: ONE pool, mesh per light (pooled), optional batch path · hooks: light.pointLightUpdate + 5 sub-zones per frame
      zones: light.pointLightUpdate/WallClip/SourceBuild/ApertureSetup/Reconcile/BatchReconcile · lever: point-light batching toggle; light enables
      prior: **S2 — which floors' lights are in the pool when viewing from above? reconcile cost per frame?**
- [ ] R-23 · Point-light materials & draws — illumination/coloration scenes
      files: src/effects/lighting/point-light-illumination.js (1784), point-light-coloration.js (534) + animations/ (26 files, ~3.1k total: registry.js 366, candle-flicker.js 467, tsl-noise-toolkit.js 202, light-animation-clock.js 134, + 22 animation modules)
      inst: material per light (animations built in per light) · hooks: light.drawPointLights/drawColoration/drawPointLightsMerged/drawColorationMergedBlit
      zones: those four (animations: NONE of their own — declared shared-zone gap) · lever: batching toggle
      prior: S2 — draw cost scales with visible light count; upper-floor light sets vs ground unknown
- [ ] R-24 · Sun shadows, layer smear & shadow bands
      files: src/effects/lighting/sun-shadow-subsystem.js (1556), layer-smear.js (633), layer-smear-render.js (525), shadow-bands.js (291), sun-occlusion.js (172), sun-occlusion-render.js (69), sun-shadow-debug.js (289), src/effects/sun-shadows.js (367), vegetation-shadow-subsystem.js (411), ui-window-shadow.js (162)
      inst: ONE subsystem + bake gates · hooks: light.sunShadowBake, light.uiShadowStamps per frame
      zones: light.sunShadowBake, light.uiShadowStamps + cache gates · lever: sun shadows enable
      prior: **S2 — smear/bake interacts with floor stacking by design; bake gates' skip/run counters tell the story**
- [ ] R-25 · Aperture gobo
      files: src/effects/lighting/aperture-gobo.js (1522), aperture-gobo-render.js (621), src/effects/aperture-gobo.js (392), aperture-gobo-registration.js (175)
      inst: singleton + apertureSegCache · hooks: light.pointLightApertureSetup, light.drawApertureShadow
      zones: those (EFFECT_ZONING 'partial') · lever: gobo enable · prior: S1
- [ ] R-26 · Region darkness, environmental light & light visibility
      files: src/effects/lighting/region-darkness.js (796), region-geometry.js (687), environmental-light.js (790), light-visibility.js (538)
      inst: mesh pool per active region · hooks: light.regionSetup, light.ambient, light.drawIllum, light.drawRegions
      zones: those · lever: TBD(R0.5) · prior: S2 — region membership per floor; the darkness-gate second-authority hazard is documented history
- [ ] R-27 · Window light — cookie, glass, per-floor scenes
      files: src/effects/window/window-render.js (894), window-surface-subsystem.js (545), window.js (467), window-glass.js (441), window-cookie.js (240), window-registration.js (149), window-seams.js (98)
      inst: **PER FLOOR** (createWindowSurfaceForFloor, vt-pan-viewer.js:6925; lazy per floor :6976) · hooks: light.windowSync, light.drawWindowLight
      zones: those (coverage 'full') · lever: window enable
      prior: **S2 — the one effect instantiated per floor with its own scene; exactly the shape that silently doubles when floors stack**

### SYSTEM G — Surface effects

- [ ] R-28 · Specular ("Shine")
      files: src/effects/specular/* (8 files: specular-render.js 1551, specular.js 837, specular-pattern.js 731, specular-surface-subsystem.js 700, specular-islands.js 528, specular-material.js 383, specular-registration.js 198, specular-seams.js 95)
      inst: ONE subsystem, mask/pack swapped per viewed floor · hooks: surface.specularSync, surface.specularDraw
      zones: those + surface.specularIslandBake (coverage 'full') · lever: specular enable · prior: S1
- [ ] R-29 · Water — tier-0 surface, body pack, light response
      files: src/effects/water/* (11 files: water-render.js 896, water-body-subsystem.js 534, water-light.js 533, water-body.js 498, water-surface-subsystem.js 428, water.js 334, water-field.js 299, water-registration.js 143, water-seams.js 69, water-floor.js 69, water-pass.js 56)
      inst: ONE body + ONE surface subsystem, per-floor selection · hooks: light.waterBodyBake, light.waterSurfaceSync
      zones: those — **the tier-0 draw itself has NO zone (renderOrder 0.5 inside geometry.world)** · lever: water enable
      prior: S2 — an unzoned draw inside the biggest pass, floor-selected
- [ ] R-30 · Fire — mask → spawn → three engines + light sources
      files: src/effects/fire/* (7 files: fire-geometry.js 1249, fire-render.js 1052, fire-sprite.js 568, fire.js 532, fire-subsystem.js 445, fire-mask.js 416, fire-spawn-points.js 307), src/effects/particles/fire-particle-runtime.js (770)
      inst: ONE subsystem, three engines · hooks: light.fireSync (fire-subsystem.js:271), light.drawFire
      zones: those + fireMaskBakeGate/fireSpawnBakeGate (coverage 'partial' — its lights ride shared zones) · lever: fire enable
      prior: S1 — but confirm what a floor with NO fire pays
- [ ] R-31 · Fluid — tube nets, sim, per-item surfaces
      files: src/effects/fluid/* (8 files: fluid-net.js 849, fluid-surface-subsystem.js 756, fluid-render.js 533, fluid-sim.js 316, fluid.js 292, fluid-pack.js 244, fluid-registration.js 192, fluid-pump.js 185)
      inst: **mesh PER MASKED ITEM** (fluid-surface-subsystem.js:24) · hooks: light.fluidSurfaceSync, sims.fluid
      zones: those + light.fluidNetBake (coverage 'partial') · lever: fluid enable · prior: S1
- [ ] R-32 · Particle arena & civilian runtimes — dust, gusts
      files: src/effects/particles/particle-runtime.js (1827), gust-runtime.js (759), particle-arena.js (245), particle-system-schema.js (177), wind-gusts.js (143), wind-diagnostic-particles.js (121), particle-engine.js (49)
      inst: ONE arena allocated once, sub-ranged · hooks: sims.particlesDust, sims.particlesGusts, surface.drawDust, surface.drawGusts
      zones: those · lever: particle enables · prior: S1 — arena is the right shape; verify spawn-rect and floor gating
- [ ] R-33 · Vegetation — tiers, sway, shadows, proxies
      files: src/effects/vegetation-render.js (830), vegetation.js (631), vegetation-shadow-subsystem.js (411, shared with R-24 — owner: R-33) · scope in vt-pan-viewer.js: `syncAllVegetationMotionForFrame` (:9401), `stampVegetationRenderOrders` (:9536)
      inst: per-item meshes + proxy node cache · hooks: light.vegetationSync, vegetation.rankStamp, vegetation.depthItemsBuild per frame
      zones: those (coverage 'partial') · lever: vegetation enable
      prior: S2 — per-frame full-population sync sweeps; the third-mesh cleanup class of bug lived here
- [ ] R-34 · Candle flames
      files: src/effects/candle-flame-render.js (721), candle-flame-geometry.js (715), candle-flame.js (283), candle-ignite.js (79)
      inst: pooled per candle · hooks: light.candleSync, light.drawCandleFlame
      zones: those · lever: candles enable · prior: S1 — recently hoisted noise to vertex stage (confirmed live); still on the old occlusion gate per memory — verify during pass
- [ ] R-35 · Lightning
      files: src/effects/lightning-geometry.js (1058), lightning.js (695), lightning-render.js (539), lightning-subsystem.js (392)
      inst: ONE subsystem, ribbon batch · hooks: light.lightningSync, light.drawLightning
      zones: those · lever: lightning enable · prior: S1

### SYSTEM H — Governance, UI, diagnostics, vendor

- [ ] R-36 · Effect governance — registry, manifests, cascade, settings
      files: src/effects/registry.js (144), effect-manifest.js (214), effect-cascade.js (229), effect-settings.js (178), effects/index.js (575), debug-channel-select.js (108), src/core/params-schema.js (328)
      inst: frozen data + one registry · hooks: none per frame (cascade on change)
      zones: NONE · lever: n/a (it IS the lever rack) · prior: S1 — default-on vs actually-wired is a named hazard class
- [ ] R-37 · Authoring UI — paint/anchor modes, loading, astrolabe
      files: src/ui/* (12 files: anchor-mode.js 695, astrolabe.js 688, paint-mode.js 603, load-progress.js 393, camera-path-dialog.js 387, loading-screen.js 344, anchor-view-mode.js 340, paint-mode-canvas.js 234, paint-mode-toolbar.js 225, paint-mode-widgets.js 207, perf-progress-overlay.js 122, index.js 16)
      inst: per-activation · hooks: **own rAF loops outside the zoned frame** (anchor-mode.js:378, anchor-view-mode.js:303, paint-mode-canvas.js:136, loading-screen.js:217, load-progress.js:270, boot.js:8091 astrolabe)
      zones: NONE (by design — verify they truly idle when inactive) · lever: mode activation · prior: S1
- [ ] R-38 · Diagnostics runtime — profiler, zones, GPU timers, probes
      files: src/diag/perf-zones.js (1320), frame-profiler.js (702), gpu-zone-timer.js (391), gpu-probe.js (153), pixel-probe.js (141), orientation-probe.js (132), wind-probe.js (368), wind-field-overlay.js (542), marker-overlay.js (116), shader-rebuild-probe.js (254), pipeline-rebuild-probe.js (245), vram-inventory.js (150), render-fallback.js (276), soak.js (93)
      inst: one profiler + on-demand probes · hooks: beginFrame/endFrame brackets, gpuZoneTimer.collect
      zones: it IS the zones · lever: profiler arm/disarm
      prior: S2 — Law 6 duty: the instrument's own overhead and honesty; the 1024-pool overflow lives here (R0.3)
- [ ] R-39 · Perf reporting & harness — the report brain, lab, session, structural A/B
      files: src/diag/perf-report.js (2581), perf-session.js (557), perf-lab.js (1057), perf-strip.js (434), perf-hud.js (246), perf-structural-ab.js (418), flight-recorder.js (924), cache-report.js (809), effect-status-reports.js (323), debug-panel.js (1248), debug-panel-controls.js (374), settings-panel.js (395), effect-controls.js (831)
      inst: singletons · hooks: perf-hud re-arms profiler every 250ms; perf-lab own rAF sweep (:463)
      zones: n/a · lever: n/a · prior: S2 — Law 6: getGeometryComposition's 125× lie lives here (R0.2)
- [ ] R-40 · Boot wiring & console API — hooks, registrations, seams
      files: src/core/log.js (220), not-built.js (68) · scope in src/boot.js: everything EXCEPT the loop (install() :720–8513, syncInterfaceSeam :8514)
      inst: singleton · hooks: Foundry Hooks (audit which fire per-frame-ish)
      zones: NONE · lever: n/a · prior: S2 — 8.7k lines of wiring; hook-driven work that runs per frame belongs in a zone or doesn't belong
- [ ] R-41 · Vendored THREE boundary — the traps ledger, not a code audit
      files: src/vendor/three/three.webgpu.js (79,546 — vendored verbatim, NEVER edited/linted), .webgpu-entry.js (2)
      inst: n/a · hooks: n/a · zones: shaderNodeBuilderCache/shaderPipelineCache report rows
      lever: n/a · prior: S1 — pass = verify the documented traps still hold on r170 (cross-target depth share dead; MRT blend state renderer-global; uniformArray dynamic-index; BufferAttribute no dispose) and that MSA's guards against each are still wired. READ-ONLY.

### Excluded by design (recorded so the census is total)

- `legacy/` — frozen V2 (483 files), import-fenced by ESLint + release grep. Never audited, never run.
- `FoundryVTT/` — installed Foundry v14 Electron distro (harness server target), gitignored.
- `gamesystemsourcecode/`, `othermodules/` — third-party read-only references, gitignored.
- `dist/`, `node_modules/`, `module-staging/`, `chrome-performance-traces/`, example map fixtures — not runtime code.
- `src/**/__tests__/` (186 files) — exercised by `npm test`, audited only as evidence quality per pass.
- `tools/` + `tests/playwright/` — the instruments; audited through R0 and Law 6, not census rows.

---

## SEEDED LEADS (Fable's opening trace, 2026-08-15 — suspicions, NOT verdicts)

*Ranked by suspicion for the upper-floor multiplier. Every one obeys Law 2: nothing here is "the
cause" until measured. Each lead names its falsification so R0.1's capture (or a cheap A/B) can
promote or kill it. Detailed cites live in the four SURVEY files.*

**SL-1 · The measured 10× may already be dead — nobody has looked. — the gate, not a lead**
Bug #20 confirmed the mechanism behind `geometry.depthDraw` 9.51× / `geometry.earlyZPrepass`
9.77× (First Floor's 66.7%-transparent art forces the discard-bearing depth shader over the
full map footprint) and shipped the S1a split to both passes (commit `94362d5`) — pixel-diff
clean, **zero perf captures since**. Falsification: R0.1. Everything below is "what ELSE",
asked in parallel, per the author's don't-stop order.

**SL-2 · The DoF pass runs ONLY on upper floors. — S3 (mechanism certain, share unmeasured)**
`runPostDofPass` returns immediately on floor 0 (vt-pan-viewer.js:5440); on any upper floor it
runs 4 downsample draws + a fullscreen NormalBlending composite reading `scene.depth`
(:5443-5476). This is BY DESIGN (it blurs the floors below) — the finding is that a whole pass
is *definitionally absent from the ground-floor baseline*, so every ground-vs-upper comparison
silently includes it, and its share of the author's "10× feeling" has never been measured.
Falsification: `dof.*` zone rows in R0.1's full multi-floor report; or DoF-off A/B on floor 1.

**SL-3 · Window light syncs AND renders once per visible floor, every frame. — S3**
`light.drawWindowLight` loops floors (:5137-5165): ground floor ⇒ 1 iteration; floor N ⇒ every
visible floor pays a seam scan + `rankOf` + `windowSurface.sync` (which re-checks mask authored
status) + its own `renderer.render(windowSurface.scene, camera)` into `scene.illum`. Window is
the ONE effect instantiated per floor with its own scene (:6924-6980). V extra scene renders
per frame is exactly the shape that turns 2 floors into >2× light-pass cost.
Falsification: `light.windowSync`/`light.drawWindowLight` rows per floor in R0.1; window-off A/B.

**SL-4 · Boundary cells and passthrough tiles still pay the full blended+discard cost in all
three geometry passes — S1a only rescued interior cells. — S3 (the residual)**
Post-94362d5, First Floor's split is 1233 interior / 773 boundary cells (~39% of kept cells
still un-certified), plus any tile that declines the split entirely ('noMinGrid' at raw-decode,
'noFullyOpaqueCells', occlusion-responsive, authored alpha) runs whole-tile blended with the
maskNode discard. The colour material's DEFAULT is transparent + depthTest:false + DoubleSide +
discard (:7253-7273) — painter's algorithm with full overdraw is the resting state of this
renderer; early-Z composition is the exception, not the rule. `worldDraw`'s unexplained 1.40×
lives somewhere in: one extra floor's art + tiles (SURVEY-floor-behavior §5) × this cost shape.
Falsification: R0.1 worldDraw ratio + per-tile earlyZState census (`splitInteriorCells` etc. are
already reported); an experiment forcing First Floor art fully opaque (bench-only art swap)
would isolate the transparency share of worldDraw's growth.

**SL-5 · Residency + depth-proxy rebuild storms while the camera moves. — S3 on touring
routes (which is what the baseline measured)**
`updateContinuousInputs` schedules a residency pass on every camera movement (:11942);
in-source notes record `depth.proxyRebuild` at occurrence-rate 1.0 across a real 463-frame
capture and `residency.pass` at ~12.5ms/occurrence (:10981-10983, :9979-9982).
`rebuildSceneDepthProxies` rebuilds the ENTIRE depthScene + depthPrepassScene populations —
and the upper floor's item list is a superset (viewed + all visible lower floors), so every
rebuild is bigger there. A touring capture (the baseline route!) pays this near-continuously;
a parked capture pays ~none. This may inflate the FLOOR-1 numbers in ways that have nothing to
do with steady-state rendering. Falsification: R0.6 parked pair vs touring pair;
`depth.proxyRebuild` occurrence counts per floor.

**SL-6 · Ground-floor anchors climb the stairs with you. — S2/S3, cheap to check**
`floorMatches` widens UPWARD: anchors marked 'own-and-above' (candles, fires, lightning
endpoints) are served to viewers ABOVE their band, never below (anchor-authority.js:461-465).
Standing on First Floor may serve First Floor's own anchors PLUS the ground floor's — every one
a live point light (pool update + draw + 6 shadow-slot fetches per fragment of its radius) and
a sprite. The Mansion's ground floor is full of candles. Ground floor never pays the reverse.
Falsification: the candle/fire state reports (keyed on activeFloorContext) on both floors —
count served anchors + resulting pool size; or measured `light.drawPointLights` per floor.

**SL-7 · Four per-frame CPU sweeps walk an itemStates that NEVER shrinks. — S2**
`itemStates` is only ever added to (:6089, :6462); stale items are hidden, not removed
(:11350-11364). Four sweeps walk it every frame: occlusion-elevation refresh (:6070), token
sync (:6661), vegetation motion (:9401), floor-attr uniforms (:9463) — the last one
**deliberately unzoned** (:4975-4978) and O(items × tiles) with per-item floor-band re-resolves
(scene-attr.js:611-751). Visiting floor 1 permanently grows the set ground-floor frames then
walk forever after. Falsification: zone it (Law-6-sanctioned instrument fix), then compare
item counts + sweep ms per floor and across a floor-switch round-trip.

**SL-8 · Six sun-shadow slots are sampled per fragment in EVERY lighting material, always. —
S2 global tax, S1 for the floor DELTA**
SUN_SHADOW_MAX_FLOORS=6, slots eagerly built regardless of scene floor count; the visibility
blend loops all 6 with no early-out (environmental-light.js:456-471, deliberate) and is inlined
into the ambient quad, every point-light illumination material, and the merged material. Fill
cost of every light carries 6 dependent texture fetches per fragment on a 2-floor map.
Floor-neutral, so it does not explain the RATIO — but it inflates the baseline both floors pay,
and slot-count-aware codegen is a plausible big global win. Falsification: shader-lab A/B with
2 live slots vs 6, then live capture.

**SL-9 · A second WebGPU device renders an empty scene every frame, forever. — S1 (floor-
neutral), flagship of the "places we rarely look" class**
boot.js:8585-8669: the heartbeat constructs a second `THREE.WebGPURenderer` (own device, 8×8
canvas) and `setAnimationLoop`-renders an empty scene unconditionally, driving the flight
recorder + a 4Hz VRAM sweep. Almost certainly cheap per frame — but it is a second live GPU
device with per-frame submissions that no zone measures, and its existence surprised every
instrument to date. Falsification: gate it off in a bench build; measure; also check its VRAM
share in the inventory.

**SL-10 · getActiveSceneFloors() allocates and sorts scene.levels EVERY frame inside the light
pass. — S1/S2, CPU**
:4795, against its own comment saying it was designed for boot-time call sites (:4787-4789).
Per frame: a levels walk, a sort, `resolveAssetUrl` + `Array.from` per floor. The 2026-08-12
fix deduplicated 4 calls to 1; it did not cache across frames. F-scaled, both floors — a
background tax plus per-frame garbage. Falsification: memoize on scene/levels version, A/B the
tick.* CPU numbers.

**SL-11 · Three unconditional draws serve usually-empty scenes. — S1**
`regionScene` render with no hasContent gate (:5043); `apertureShadowScene` render always
(:5100, comment accepts it); occlusion mask full clear + render every frame even with zero
occluders (:6056-6061). Each is a render-pass begin/end + clear at 4K. Small, real, and free
to gate. Falsification: count empty-scene passes in a trace; gate; re-measure.

**SL-12 · Sun-shadow per-floor work runs per FRAME, and rebakes cascade. — S1/S2**
`maybeBake` per scene floor per frame with a `JSON.stringify(params)` key each (:4867;
sun-shadow-subsystem.js:1261-1309), and slot i rebakes when slot i-1 changed — one sun-quantum
tick can chain up to 6 bakes in one frame (:1317-1328). F-scaled (no floor delta) but a real
CPU/GPU spike source. Falsification: bake-gate skip/run counters + a sun-moving capture.

**SL-13 · Two floor authorities, one known bite. — correctness hygiene, S1 for perf**
boot's `activeFloorContext` vs the viewer's `view.floorIndex` (SURVEY-floor-behavior §0) — a
deliberate seam, already bitten once (the painter's stepper moved the view without syncing
context). Every pass answering "which floor does this subsystem think is active?" must name
WHICH authority it read. Falsification: n/a — a standing audit question (Q8/Q12) per row.

**SL-14 · The gate-comment drift on the depth-proxy split. — cleanliness, S0 for perf**
:11172-11179 claims the depth gate matches `canSplit` "exactly"; it lacks the
`reason === 'alpha'` clause (:11181 vs :10659). Effect-safe today (the depth writer ignores
authored alpha/fade) and arguably a bonus win — but a drifted invariant comment is how the next
regression hides. Fix is a comment/gate reconciliation, filed for a worker.

**SL-15 · Hygiene basket (each verified 2026-08-15).** `isUpper` computed, zero consumers
(scene-layers.js:317) · CONVENTIONS.md §1 declares a `gameplay/` directory that does not exist ·
six `package.json` scripts point at a nonexistent `scripts/` tree (`build:tsl`, `release`,
`release:test`, `chart:generate`, `preset:insight`, `audit:controls`) · `module.json`
recommends Dice So Nice/Sequencer for integrations absent from `src/` ·
`scene.pointLightMerged` (2× RGBA16F at full res) allocated unconditionally while its flag
defaults off (:1723-1731) · fire's compute bracketed under `light.drawFire` so that zone sums
sims+draw across two disjoint brackets (SURVEY-frame-anatomy D3 — Law 6 instrumentation
finding). All S0 for the multiplier; all worth a worker's afternoon.

---

## THE FINDINGS LEDGER (append-only; workers may add rows)

| F-id | Row | One line | Suspicion | Status | Filed |
| --- | --- | --- | --- | --- | --- |
| — | — | *(opens empty; R0.1 seeds it)* | — | — | — |

**Status chain:** SUSPECTED → MEASURED → CONFIRMED → FIX BUILT (unverified) → LIVE · or
EXONERATED at any point. Only the author's eyes write LIVE.

---

## THE MULTIPLIER LEDGER (the scoreboard)

Seeded from the v0.6.1 baseline (touring route, 3840×1906@1.5 —
`docs/planning/perf-reports/2026-08-13-v0.6.1-baseline.json`). **PRE-S1a-fix numbers** — R0.1
re-measures every row. `multiFloor.ranked` is a top-25; rows below are what its published slice
showed; R0.1 must archive the FULL `MapShine.getMultiFloorReport()` and extend this table.

| Zone | Ground ms | First Floor ms | Ratio | Status |
| --- | --- | --- | --- | --- |
| whole frame (GPU p50) | 15.93 | 31.39 | **1.97×** | UNEXPLAINED as a sum — decompose below |
| `geometry.depthDraw` | 0.722 | 6.866 | **9.51×** | EXPLAINED (Bug #20) · fix BUILT (unverified) → R0.1 |
| `geometry.earlyZPrepass` | 0.660 | 6.446 | **9.77×** | EXPLAINED (Bug #20) · fix BUILT (unverified) → R0.1 |
| `geometry.worldDraw` | 8.904 | 12.492 | **1.40×** | UNEXPLAINED · candidates SL-3, SL-4, SL-6 |
| `dof.*` (whole pass) | 0 by construction (:5440) | not yet isolated | structural ∞ | EXPLAINED-BY-DESIGN · share unmeasured → R0.1 (SL-2) |
| `light.drawWindowLight` + `light.windowSync` | 1 floor | V floors | unmeasured | candidate SL-3 → R0.1 |
| `light.drawPointLights` / pool update | ? | ? | unmeasured | candidate SL-6 (anchor widening) → R0.1 |
| `depth.proxyRebuild` / `residency.pass` (CPU) | ? | ? | unmeasured | candidate SL-5 → R0.6 parked-vs-touring |
| everything else in the full report | — | — | — | AWAITING R0.1 |

**Close rule (G4):** the campaign's perf claim closes only when every ratio >1.5× on the
canonical pair is EXPLAINED-AND-FIXED or EXPLAINED-AND-ACCEPTED (author's call), and the
whole-frame ratio meets the Testament comfort bar (First Floor 40+ fps sustained; 60 target).

---

## KICKOFF PROMPT (paste this to start a worker session)

```
You are a worker under the Covenant (docs/holy/ law): you may flip census boxes, append
evidence lines, append Findings Ledger rows, and file Petitions — never edit the plan, the
Law, or another row's text. Check which model you are before touching anything.

Open docs/holy/V4-Reckoning.md and read it top to bottom. Then:
1. If Phase R0 has any open box, take the LOWEST-numbered open R0 item.
2. Otherwise take the highest-priority open census row (Phase R1 seed order first, then the
   R2 ordering rule).
3. Run the PASS PROTOCOL exactly. Answer all twelve Standard Questions. File the report at
   docs/planning/reckoning/ using THE TEMPLATE. Update the census row, the Findings Ledger,
   and (for confirmed bugs) docs/planning/Bug-Tracker.md.
4. Do not fix runtime code. Do not stop at your first finding. Confess what you didn't read.
Hard rules: bench only, never the author's real Foundry; check window.resolution in every
capture; git add named files only; npm run verify before claiming tool changes.
```

---

## PETITIONS
*Any model may append a petition. Only Fable resolves one.*

*(none yet)*

---

## SIGNATURES

- **Created** 2026-08-15 — Claude Fable 5, at the author's command: an exhaustive audit of
  the whole rendering system, phrased as a professional would — instruments first, the
  author's transparency directive as the opening strike, then the full census, past the first
  bug, to the last row.
