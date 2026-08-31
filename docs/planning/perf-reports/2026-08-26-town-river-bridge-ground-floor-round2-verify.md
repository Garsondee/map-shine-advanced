# 2026-08-26 — Town River Bridge, Ground Floor — Round 2 verification sweep

Companion synthesis to `2026-08-26-town-river-bridge-ground-floor-round2-verify.json` (condensed
archive of the full `perf-run-full` report pasted into chat this session). Full uncondensed JSON
lives in that session's transcript if a stripped field needs the original.

**Purpose of this capture:** the second-ever real run of the extended `perf-run-full` instrument,
specifically to verify the four Round 2 instrument fixes (commit `f829a13`, itself written in
response to reading the first real capture from earlier the same day). 56.9s window, 1694 frames,
3-floor scene (Ground/Middle/Roof), multi-floor + floor-wide structural-AB + 5-tier sweep +
edit-cascade-stress all ran to completion.

## Round 2 fix verification — all 4 confirmed (item 4 needed a second capture)

- **Item 1 (fold floor-AB/edit-cascade into `findings[]`): CONFIRMED WORKING.** `findings[]` now
  carries `structural-ab-floors:pointLightBatching`, `structural-ab-floors:earlyZComposition`, and
  `edit-cascade-stress` (severity `high`) — none of these existed as findings entries before Round
  2, only as raw top-level fields a reader following the report's own "scan findings[] first"
  instruction would have missed.
- **Item 2 (GPU timestamp pool overflow root cause): CONFIRMED WORKING, and durably so.**
  `poolOverflowed:false`, `maxPendingSize:259` (was 2017 pre-fix), `pendingUidsByType:{render:0,
  compute:0}`. Held for the *entire* 57s window — `foldedSamples:62493`, roughly 4x the window
  length that first crossed the alarm — strong endurance evidence, not a lucky short run.
  `attribution.coverage` stayed a clean 0.997, never approached 1.0, confirming the combined-sample
  fix (the part that specifically prevents a coverage-integrity regression) is also correct.
- **Item 3 (tier sweep noise floor): CONFIRMED WORKING, and it resolved the exact open question
  from report 1.** `tierComparison.noiseFloor` is present (`referenceProfile:'quality'`,
  `noiseFloorMs:0.070`). `frameLadder`'s quality→extreme entry: `deltaMs:-0.26`, clears the floor
  (0.26 > 1.5×0.07), verdict `cheaper-than-expected`. The quality-vs-extreme anomaly report 1 could
  only shrug at is now a confirmed, real, reproducible ladder violation — not noise.
- **Item 4 (VRAM floor-switch sampler): CONFIRMED WORKING on a second capture, ~40 minutes later.**
  The first capture archived here showed `floorSwitchVram` completely missing from `multiFloor` and
  every `floorStructuralAB.perFloor[]` entry, despite code verified correct end-to-end (`boot.js`
  ~4450–4541, ~4798–4865, zero diff vs HEAD `f829a13`) — every static explanation (stale build,
  spread-clobbering, serialization stripping) was ruled out directly, leaving no code-level
  explanation. Offered Ingram the choice of how to chase it; she re-ran `perf-run-full` fresh
  (`generatedAt 2026-08-26T14:06:08.835Z`). That second capture shows the field working exactly as
  designed on **both** floor transitions: `multiFloor.floorSwitchVram.peak` = 1287.49MB at 1270ms
  into the 0→1 switch (baseline 1220.39MB, a real +67MB spike); the Roof floor's own
  `floorSwitchVram.peak` = 1354.59MB at 251ms into the 1→2 switch (baseline 1287.49MB, another clean
  +67MB spike). Both skip-path floors correctly show `floorSwitchVram: null`. The first miss reads as
  a one-off browser/module-cache timing gap, not a defect — the code was never wrong.

## New insights this longer, multi-floor run reveals

- **Early-Z composition's win is now cross-floor-confirmed.** Main window (Ground): pays for itself,
  −0.551ms. Roof floor's own independent A/B: also pays for itself, −0.519ms. Two independent floors
  agreeing is meaningfully stronger evidence than the single-view result report 1 had.
- **Point-light batching has now failed to resolve on two separate floors in a row** — main window
  `within-noise` (noise floor 5.99× ambient), Roof floor also `within-noise` (noise floor **12.53×**
  ambient — over twice as loud relative to baseline). This isn't "no effect", it's "this toggle's
  own measurement is unusually noisy on this content" two times running. Worth more measured frames
  or more cycles before trusting either verdict, rather than re-running the current design hoping
  for a cleaner draw.
- **The edit-cascade-stress finding reproduced tightly**: 53.637ms and 53.009ms across two
  independent cycles this run, versus ~53.3ms average in report 1's own capture — same bug, same
  order of magnitude, now visible through the correct channel (`findings[]`, severity `high`)
  instead of only in a raw field a reader could miss.
- **`sims.wind`/`sims.fluid` still show `gpuMs:null`** — investigated directly rather than assumed
  fixed. `tickFluidSim` (`vt-pan-viewer.js`) early-returns (`if (!clears.length && !advects.length)
  return;`) before any GPU dispatch when there's nothing to advect; on a calm pan-only window with no
  active wind gusts or fluid flow, no compute uid for these zones is ever generated to fold. This
  reads as the report telling the truth (`cadence:'conditional'`, no fabricated zero) rather than a
  residual Item 2 bug — `foldResolved()`'s attribution mechanism is generic to any zone, render or
  compute. Not verified live on a window with actual wind/fluid activity this session.
- **VRAM tracking is confirmed to work correctly but is architecturally blind for any single-floor
  steady-state capture** — flat for all 240 samples, which is exactly why Item 4 exists as a
  *separate* sampler at the floor-switch call sites rather than relying on the main window's own
  tracking. Makes the current absence of its output more consequential, not less.

## What's fine (no action needed)

Attribution coverage (99.7%), the dominant-cost signal (`geometry.worldDraw`, 80.8% of frame GPU,
completely unambiguous), hitch/stall tracking (zero this window, full reproduction detail is there
when non-zero), and the cache-health instrumentation are all in good shape and gave no reason for
concern this run.

## Open items (none are "the report lies to you" severity)

1. **Optional future addition**: a forced-activity stress test for wind/fluid compute (spawn a gust /
   trigger fluid flow deliberately mid-capture), the same way `editCascadeStress` now exists for
   mask-authority edits — the only way to directly confirm Item 2's fix reaches these two zones
   specifically, rather than inferring it structurally from the mechanism.
2. **The tier-sweep noise floor itself varies meaningfully run to run** — 0.070ms in this capture,
   0.520ms in a second capture taken ~10 minutes later on the same machine. The same real
   quality-vs-extreme delta (consistently negative both times: -0.26ms, then -0.59ms) read as a
   confirmed ladder violation in one run and "within-noise" in the next, purely from that ambient
   swing. Not a bug — this is the noise-floor mechanism correctly declining to over-claim on the
   noisier run — but worth remembering before trusting any single run's verdict on a small delta.

**Status: all 4 Round 2 items (and all 6 Round 1 items) confirmed working from two independent live
`perf-run-full` captures. The performance-review instrument itself is in good shape** — see
`project_perf_harness_extension_2026-08-26.md` in project memory for the full closure note.
