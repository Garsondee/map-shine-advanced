# Live perf sweep — 2026-08-09 — the first real measurement against the 2026-08 audit

**Raw report:** `2026-08-09-live-sweep.json` (author-captured, `msaVersion 0.6.0-dev.0`, route
`n_to_s:2kf/60000ms`, 2212 frames, 3840×1906 @ DPR 1.5). Companion to
`docs/planning/Performance-Audit-2026-08.md` (the code-read problem list) and
`docs/planning/Performance-Insights.md` (the historical measured ledger).

**Headline:** 38.6 avgFps, GPU p50 23.99ms / p95 29.16ms, 20 hitches >50ms over 57s (worse than the
historical "zero hangs" 60s sweep — but a different scene, and fire/DoF/window-glass/candle-ignite
have all landed since that measurement).

⚠️ **Two instrument-health caveats the report itself flags as "high severity"** — read before
trusting any single number in isolation:
- **1 unbalanced profiler bracket.** One zone's timing this run is poisoned (see `depth.proxyRebuild`
  and `residency.pass`'s own `"unbalanced": 1` field — one of the two).
- **GPU timestamp query pool overflowed** (>1024 outstanding passes). Some GPU zone numbers this run
  are **missing, not zero** — coverage (97.9%, "good") is still trustworthy at the top level, but
  don't treat every individual zone's absence of cost as proof of cheapness.

## What this confirms, with real numbers, against the code-read audit

| Audit finding | Live number | Verdict |
| --- | --- | --- |
| §4.3 `geometry.depthDraw` — never measured, "0.3–2 ms" guessed | **CPU 5.872ms mean, 46.6ms max, every frame** | Confirmed real, and roughly 3–20× the guessed range. Now the single largest unexplained CPU cost found. |
| §3.1 illum/coloration duplication | GPU 3.941+3.787=7.728ms combined; **CPU-encode 2.377+1.409=3.786ms combined** | Confirmed with hard numbers on both sides — the CPU-encode cost is new information the code-read couldn't size. |
| §8.4 VRAM inventory counts zero render targets | `"renderTargets": {"count": 0, ...}` | Confirmed verbatim, live. |
| §5B (Performance-Insights) candleFlame's own shader is cheap; real cost is downstream in the lights it drives | `method-disagreement:candleFlame`: zone sum 0.025ms vs sweep marginal 3.45ms, "one of the two is wrong, do not average" | Confirmed — the disagreement IS the signature this finding predicts. |
| §5.1/§6.8 aperture-gobo wall re-scan; §3.6–3.8 per-light CPU waste | `light.pointLightUpdate`: **3.686ms mean, 25.1ms max** | Confirmed the aggregate is real and substantial, not individually-negligible as first sized. |
| §7 "sweep cannot resolve anything under ~1.1ms" | noise floor this run: 1.15ms; **14 of 15 effects rejected**, only candleFlame resolved | Confirmed, same shape, still true. |
| Sun-shadow/water bake cost "still unmeasured" | Neither bake fired this window (both report the per-frame *check* cost only: 0.023ms / 0.005ms) | Confirmed still unmeasured — needs a sun-angle change or mask repaint mid-profile. |

## New information the code-read audit did not have

- **`residency.pass` (`scheduleResidencyUpdate`): 12.484ms mean per occurrence, 44ms peak, firing on
  42% of frames** (continuous pan). Amortised 5.271ms/frame — the single largest raw CPU number in
  the whole report. The instrument's own findings[] calls this out directly: *"over the 8.33ms frame
  budget on its own... as a one-frame stall it is a visible hitch."* No entry in the 2026-08 audit
  sized this — `depth.proxyRebuild` (0.257ms/occurrence) and the other named residency sub-costs are
  all far too small to account for it. **What's actually expensive inside `updateResidencyUnguarded`
  beyond what the audit catalogued is now an open question**, not a closed one.
- **`pass.geometry.world`'s CPU (7.195ms) is ~82% `geometry.depthDraw` alone** (0.348 worldDraw +
  0.971 doorDraw + 5.872 depthDraw ≈ 7.191, matches the pass total almost exactly). Strongly
  suggestive the depth-proxy material churn (§4.3/§5.4) is the real driver, not the draw call itself.
- **20 hitches, several clustering at `halfSpanPx ≈ 3009`** in the same hitch dump — consistent with
  a specific pan position/zoom triggering a decode or residency stall, not random GC noise. Worth a
  targeted repro at that exact half-span if chased further.

## Not yet reconciled

- Frame GPU total (23.99ms p50) vs the sum of all listed zone GPU means (~22ms) leaves a residual the
  pool-overflow caveat likely explains, at least in part — don't read the gap as "missing work,"
  read it as "missing measurement" per the instrument's own framing.
- `light.drawFire`'s CPU max (18.3ms) against a mean of 0.329ms, with `occurrenceRate: 2` (it fires
  twice some frames) — worth a dedicated look once fire is out of active development; not chased
  further here since the effect is still WIP.
