# Acceptance Scenes & Verification Checklist

**Purpose:** Every Stage A/B change in the [Forward+ plan](Forward+.md) (§15) is verified against this fixed scene set before it merges. "Golden scenes are unchanged" is the safety net for the whole refactor — do not skip this on any item that touches rendering.

**Workflow reminder (author's setup):** edit locally → WinSCP auto-sync to the Foundry VM → hard-refresh browser (Ctrl+F5, so module JS isn't cached) → run the checklist.

---

## 1. The scene set (5 archetypes)

Fill in the actual scene names/IDs from your worlds. Each archetype exists to protect a specific subsystem the refactor touches.

| #   | Archetype                                                                                          | What it protects                                                                   | Actual scene (fill in) |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------- |
| S1  | **Single-floor, mid-size** (~4–6k px, lights + a few masks)                                        | The common case; regression canary for lighting/specular/water basics              | **\_\_**               |
| S2  | **Mansion — Multifloor** (12000², 2 Levels + overheads, `AgEdsalWg2JMzpLR`)                        | THE crash case (Forward+ §1.2); mask VRAM; load pipeline; floor transitions        | Mansion - Multifloor   |
| S3  | **Plank-prison over river** (lower-floor water visible through upper-floor gaps)                   | The Class D see-through contract (Forward+ §4.2, §12.3); water occluders; splashes | **\_\_**               |
| S4  | **Fire-heavy scene** (many `_Fire` map points, candles, overhead roofs above fires)                | Fire glow/heat-distortion floor gating (TODO §7 item 20); particle perf            | **\_\_**               |
| S5  | **144 MP stress** (any 12000²; can be S2) + one **8250² 3-floor** map with `_Fire`/`_Shadow` masks | Streaming, mask budget, load-slim, crash guardrails on 8 GB                        | **\_\_**               |

**Hardware matrix:** primary = the RTX 3070 8 GB laptop (the failing machine). Secondary = the 16 GB desktop (the working machine — protects against "fixed the laptop, broke the desktop").

---

## 2. Per-scene checklist (run after any rendering change)

For each affected scene (minimum: S1 + the archetype your change touches; **all five** before a release or a Stage gate):

1. **Load** — scene loads with no `webglcontextlost`, no safe-mode escalation, no console errors. Note load time roughly.
2. **Look** — compare against the baseline screenshot at the standard view (see §3). Lighting, water, shadows, fire, fog all present and unchanged.
3. **Pan & zoom** — full pan across the map, zoom out to full, zoom in tight. No missing tiles, no mask popping beyond known streaming behavior, no stutter regression.
4. **Floor switch** (S2/S3/S5-3floor) — walk the floor levels up and down twice. Transition completes; lower-floor water/effects show correctly through gaps (S3: the river must be visible through the planks, occluded BY the planks, splashes clipped under the deck).
5. **Token + vision** — drag a token; vision/fog updates; explored area persists after a refresh.
6. **Diagnostics snapshot** — open the diagnostic/perf report (or trigger `collectDiagnostics` from console) and record: renderer texture count, JS heap MB, mask VRAM totals, floor counts. Paste into the run log (§4).

**Pass bar:** identical visuals (within streaming-LOD noise), no new console errors, diagnostics within ±10% of baseline unless the change _intended_ to move them (then record the new number as the baseline).

## 3. Baseline screenshots (user task, one-time)

For each scene: standard view = whole map fitted to screen + one zoomed interior view + (S2/S3) one per floor. Store under `docs/planning/baselines/<scene>/<date>/`. Re-baseline only deliberately (note it in §4), never silently.

## 4. Run log

| Date                   | Change tested | Scenes run | Result | Notes |
| ---------------------- | ------------- | ---------- | ------ | ----- |
| _(add rows as you go)_ |               |            |        |       |

---

_Referenced by Forward+ §15 Stage A item A2. The Mansion investigation doc remains the deep-dive companion for S2 failures._
