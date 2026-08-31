# UI Parity Gap Analysis — old panel vs. new Remote/Studio (2026-08-27)

Live-code audit, triggered by the author comparing a screenshot of both UIs side by side
for what looks like the first time. Everything below is read directly from current source
(not reconstructed from `docs/holy/UI-Testament.md`'s own checklist/status log, both of
which are stale — see the closing note). Check here before re-auditing old-vs-new parity
from scratch.

## The one structural fact that shapes everything else

`src/diag/debug-panel.js` has always organised its content into four internal zones —
`bridge` / `workshop` / `lab` / `settings` — displayed as tab labels **Bridge / Make / Lab /
Setup** (`ZONE_META`, debug-panel.js:465-470). A fifth zone, `toolbox`, was deleted
2026-07-27; its two working controls moved into `lab`.

`src/ui/rooms/studio/lab-department.js` mounts that **same registry**, calling
`debugPanel.renderLabBody()` → `renderLab()`, which filters to `zoneOf(id, entry) ===
'lab'` only (debug-panel.js:1029-1034). So:

- **Anything zoned `lab` already has 100% automatic parity, forever, by construction.**
  No porting work is ever needed for it — a new registration there just appears in both
  UIs.
- **Anything zoned `bridge` / `workshop` / `settings` is structurally invisible to the new
  Studio.** The only way it reaches the new UI is if someone builds a dedicated
  Remote/Studio surface for it. That's the entire shape of "what's missing."

## What's missing — verified against current source, not memory

### Bridge → Remote

| Old control | Where (boot.js) | New UI status |
| --- | --- | --- |
| **Renderer** (MSA / Foundry manual switch) | `render-compare` select, `ZONES['render-compare']='bridge'` (debug-panel.js:491) | ⚠️ **Missing.** Calls `restoreFoundryArt()` — a real, reversible, manual override of which renderer is drawing the canvas. The Remote's footer "Safety" button exists but is `plannedFooterBtn(...)` — a dead stub (`ui/rooms/remote/shell.js:550-553`). This is the closest thing to a manual escape hatch a GM has mid-session; right now it only lives in the old panel. |
| **Darkness at max** | `darkness-realism` select, boot.js:10692 | Missing. 3 presets (Foundry-readable / Halfway / Realistic-black), calls `setDarknessRealism`. No equivalent anywhere in `weather-board.js` or the SCENE department. |
| **Scene export (data)** | `scene-export` report, `{zone:'bridge'}`, boot.js:6041 | Missing. |
| **Export Scene (download for AI import)** | `scene-export-download` action, `{zone:'bridge'}`, boot.js:6051 | Missing. This is the Scene Export/Import Bridge feature (world → JSON, feeds the AI-import workflow). Zero presence in `scene-department.js` today. |
| Camera Path | `camera-path-open`, `ZONES[...]='bridge'` | ✅ Ported — `ui/rooms/remote/camera-path-popover.js`, rebuilt against the real `camera-path-dialog.js`/`camera-path.js` backend, full keyframe/easing/preset parity. |
| Astrolabe (time/weather dial) | `astrolabe` panel, `{zone:'bridge', order:-1}` | ✅ Ported (`astrolabe-dial.js` + `astrolabe-panel.js` + `weather-board.js`), with two acknowledged open sub-gaps: wind direction/speed has a read-only pill but no drag/edit surface, and the ring's manual time-stop dots have no new-UI home (no mock precedent either — named, not forgotten). |

### Make (Workshop) → Studio EFFECTS/PAINTER

- **Wind's whole diagnostic/tuning cluster has no Studio home at all**: `wind-overlay-toggle`,
  `wind-overlay-resolution`, `wind-particles-toggle`, `wind-rebake`, `wind-test-gust`,
  `wind-force-thaw`, `wind-sim-status` — all `zone:'workshop'` (boot.js ~9073-9077 area).
  Wind isn't one of the 15 registered effects, so it never got a card via
  `registerSimpleEffectCard` either. Nobody has decided where this goes yet.
- **Per-effect extras the shared card helper doesn't replicate**: specular's 3 shimmer-layer
  strips (`buildSpecularLayerStrips`), and debug-channel selects for water, specular, window,
  apertureGobo. Named honestly in `effects-department.js`'s own header, not silently dropped.
- `uiWindowShadow` / `doorGraphics` have **no card in either UI** — confirmed no old-panel
  precedent exists either (`registerPanel` never covers them). Not a migration gap, just a
  standing gap in both.

### Setup (Settings) → System/Player

- ⚠️ **Render Resolution is missing** — `diag/settings-panel.js:347-371`, the render-scale
  governor dropdown (Auto + fixed rungs), shipped **2026-08-27, today**. `ui/rooms/system-
  panel.js` (used by both the Studio's SYSTEM department and the standalone Player room) has
  no `renderScale` field at all — confirmed by reading it in full. This is the newest of all
  the gaps found here; the new UI simply hasn't caught up yet.
- Counter-note: the new System panel has two things the old one doesn't — **Reduced motion**
  and a **Theme** picker (LANTERN-only, no old-panel equivalent needed).

### Already-planned, not a parity issue (both UIs lack these equally)

Baseline-authoring / Scene presets / Levels-editing (`scene-department.js`, all
`status:'planned'`, waiting on the Fade Engine), cutscene Director mode (U9), a Scene Health
aggregate badge, keybindings (U8), per-cue delete/curve-editing, a truthful cross-client
suppression badge, and the Thunder impulse (needs audio infra that doesn't exist anywhere in
`src/`).

## What it takes to delete the old panel safely

1. **Port the Bridge-only items** — Renderer/manual-safety-toggle (treat as the one true
   blocker: it's the only manual override of what's drawing the canvas), Darkness at max,
   and the two Scene export buttons. Small, mechanical — same shape as everything else
   already wired through `ctx` in `shell.js`/`scene-department.js`.
2. **Port Render Resolution** into `system-panel.js` — same shape as the `profile` row
   already there, minutes of work.
3. **Decide Wind's new home** — a small Studio card, or folded into `weather-board.js`'s
   Channels rack. Nobody has made this call yet.
4. **Close or explicitly waive** the named per-effect extras (specular strips, 4 debug-
   selects) — these already have a worker-tier judgment call on record in
   `effects-department.js`'s own comments; they need the author's countersign either way,
   not necessarily new code.
5. **Get the author's own live eyes on the new Remote/Studio inside real Foundry.** Every
   round of this migration (`docs/holy/UI-Testament.md` §12, P10 through P35) shipped as
   `BUILT (unverified)` against preview harnesses — the screenshot behind this audit may be
   the first time the whole Remote has actually been seen live, side by side with the old
   panel, in the real module. Confirm it before flipping the toolbar's default.
6. **Once 1–5 hold**: retire the `map-shine-advanced` toolbar toggle
   (`foundry/scene-controls-button.js`), delete the Bridge/Workshop/Settings-zone code paths
   in `debug-panel.js` (keep the Lab *registry engine* itself — the new Studio's LAB
   department depends on it structurally), delete `ui/astrolabe.js`,
   `ui/camera-path-dialog.js`'s old consumer, and `diag/settings-panel.js` in favour of
   `system-panel.js`.

## A note on the doc trail

`docs/holy/UI-Testament.md`'s own §9 checklist still shows every U0–U7 box unchecked, and
its §13 Status Log stops at 2026-08-17 — the day the Testament was written. Neither reflects
the real ~30 rounds of shipped work; that history lives only in §12 Petitions (P1–P35) and
in `git log`. This audit was built from current source + `git log`, not from those two
sections — worth a pass to reconcile them, but that's Fable-tier territory
([[the-covenant]]), not this doc's job.
