# Painting System Audit — 2026-08-31

**Ask (Ingram, verbatim intent):** triggered by Bug-Tracker #31 (Clear+Save
not persisting — fixed same day, `2a8b0c0`/`e315027`): *"it might be worth
auditing the whole painting system's critical functionality."*

**Method:** 4 parallel independent audits over the full paint chain
(`src/ui/paint-mode*.js`, `src/scene/paint-mask.js`,
`src/foundry/paint-adapter.js`, `src/ui/rooms/studio/painter-department.js`,
the `mask-authority.js`/`mask-derive.js` ingestion boundary, and — on
explicit instruction — the sibling `anchor-adapter.js`/`params-schema.js`
patterns paint-mask.js cites as precedent), each verifying every claim
against current source (never against planning docs, which this project has
repeatedly found lag shipped code). One pass ran empirical measurements
(Node probes against the real modules — codec round-trips, brush-coverage
sub-texel sweeps, composite-math numeric traces) rather than reading alone.
Every finding below carries a file:line citation. Several findings were
independently reached by two or three of the four passes from different
angles — noted where it happened, since agreement across independent
readings is itself evidence.

**Scope:** the in-app brush/paint authoring tool end to end — UI, brush
math, persistence, floor/kind isolation, and how a painted mask actually
reaches (or fails to reach) the render. Two things surfaced outside that
strict scope and are included anyway because they sit on the same
ingestion pipeline and are high-value: a likely root-cause for the
previously-unsolved Bug-Tracker #19, and a latent instance of the same bug
class as #31 in `fade-persistence.js`.

**Status of this document:** a record of what four independent reads found
on one day, source-verified at the time. Two items are already fixed
(`2a8b0c0`, `e315027`). Everything else is `BUILT`-status-irrelevant — these
are audit findings, not shipped fixes. Re-verify against current source
before acting on an old line number.

---

## Already fixed this session

| # | Finding | Fix |
|---|---|---|
| — | Bug #31: `serializePaintedMasks` drops a cleared layer, `setFlag` merges rather than replaces, so Clear+Save never actually deletes persisted data | `2a8b0c0` — `savePaintedMasks` unsets before re-setting |
| — | Follow-up regression in that fix: unconditional unset+set, no try/catch — a rejected `setFlag` after a successful `unsetFlag` destroyed every painted mask on the scene, not just the one being saved, silently | `e315027` — fast-path (single `setFlag`) when nothing needs deleting, try/catch, best-effort restore on failure |

Both are documented in full in `docs/planning/Bug-Tracker.md` #31, and as a
named, reusable bug-class pattern in memory
(`feedback_omission_cannot_delete_under_merge_semantics`, two lessons).

---

## Ranked master list

Severity is about the failure a real GM/author hits, not about how
interesting the code is. `CONFIRMED` = traced against real current source
with a concrete repro. `⚠ HYPOTHESIS` = plausible, structurally sound, not
fully provable without a live Foundry session or the (currently absent)
vendored source.

### P0 — touches the project's own stated priorities (secrets safe from players / release reliably), or loses author work silently

| # | Finding | Confirmed by | Where |
|---|---|---|---|
| P0-1 | **Zero GM/permission gating anywhere in the paint chain.** `savePaintedMasks`/the whole painter is constructed unconditionally for every client, including players; the toolbar's `isGM` check is visibility-only, not authorization. A player with a console can open the painter and edit scene masks. The exact right guard already exists, unused, in a sibling file (`tile-motion-runtime.js#canEditScene`). | 1 pass | `foundry/paint-adapter.js:128`, `boot.js:1114,1435`, `foundry/tile-motion-runtime.js:89-100` |
| P0-2 | **`canvasReady#hydrateFromScene` silently wipes unsaved paint on every scene/floor transition**, no guard on `state.active`/`dirtySinceSave`, no warning, and resets the dirty flag to clean — so the unsaved-changes guard on Exit doesn't even fire afterward. | 3 independent passes | `boot.js:12183`, `ui/paint-mode.js:648-666` |
| P0-3 | **"Discard & close" discards nothing.** `exit()` touches only DOM/handlers, never `state.layers`/`state.undo`/`state.dirtySinceSave`. A later, unrelated Save re-persists (and re-renders) the edit the author explicitly told the app to throw away. | 2 independent passes | `ui/paint-mode.js:529-561` |
| P0-4 | **`ingestPaintedMask` aliases the painter's live `Uint8Array` by reference, not by copy.** Clear/Undo mutate the mask authority's already-ingested content in place, with no version bump — so the render stays stable (matching the "not live mid-stroke" doc) until an unrelated `touch()` (any Tile/Wall CRUD, a streaming page, a slider) fires, at which point unsaved or explicitly-discarded edits suddenly appear or disappear in the render with no correlation to any painter action. | 2 independent passes | `scene/mask-authority.js:567` |
| P0-5 | **A malformed `paintedMasks` flag throws with zero validation, and the throw aborts the entire `canvasReady` handler** — not just painting. Sky resolve, fade/cue load, V2 anchor import, the whole scene viewer bring-up, all abort together, and the only diagnostic points at the unrelated VT viewer. | 1 pass, `MEASURED` (6 malformed-payload shapes probed, all throw) | `scene/paint-mask.js` (`decodePaintLayer`), `boot.js:12183,12396` |
| P0-6 | **Painted `_Specular`/`_Window`/`_Tree`/`_Bush`/`_Fluid` cannot reach the render at all — ever — and the shipped in-app copy says the opposite.** These five kinds get their real GPU texture through `authoredStatus()`/`authoredStatusForItem()` (file-discovery only); `paintedIngests` is never consulted there. `painter-department.js`'s own UI text claims *"paint fire, see fire is now genuinely true... all six tiles below, today"* — true only for fire; water is partial; these four/five are false. Painting and saving one of these produces a success toast, a Painter-Department tile that still reads "not found," and nothing else — no error anywhere. | 1 pass, cross-checked against 5 consumer files | `mask-authority.js:1011-1038` vs `:723`; `specular-surface-subsystem.js:336`, `window-surface-subsystem.js:258`, `boot.js:10337`, `fluid-registration.js:199`; claim at `ui/rooms/studio/painter-department.js:10-16` |
| P0-7 | **Painted fire is structurally unreliable at low Strength and small brush sizes — two independent, compounding causes, both measured.** (a) Self-alpha compositing *squares* the painted byte (`out = raw²/255`), so the bottom ~20% of the Strength slider composites below fire's live sensitivity threshold and paints nothing at the render while showing normally in the preview; soft brushes lose up to 30% of their radius at render vs. preview. (b) The consumer grid for every kind except water is 512², an 8× downsample from the painter's 4096² grid, sampled with a single 2×2 bilinear tap per destination texel — a minimum-size single click/dab renders real fire only ~24% of the time depending on sub-texel phase, while the preview *always* shows it. This is very likely the mechanism behind historical "smallest brush sometimes paints nothing" reports, one layer deeper than the 2026-07-20 fix that made the *preview* reliable. | 1 pass, `MEASURED` (numeric composite traces + 120-phase sub-texel sweep) | `scene/mask-authority.js:570` (self-alpha), `scene/mask-derive.js:301-335` (the composite), `scene/paint-mask.js:75` vs `mask-derive.js:46` (4096 vs 512) |

### P1 — real, reproducible, worth fixing this pass

| # | Finding | Confirmed by | Where |
|---|---|---|---|
| P1-1 | Save has no re-entrancy guard (unlike the floor stepper's `floorSwitching` flag) — a double-click, or Save→Escape→"Save & close" while the first save is still in flight, fires two overlapping write sequences. | 2 independent passes | `ui/paint-mode-toolbar.js:177` |
| P1-2 | A failing/throwing save desyncs the mask-kind `<select>` from `state.kind` — the dropdown shows the newly-picked kind while every subsequent stroke still lands in the old one, with no visual indicator of the mismatch. | 1 pass | `ui/paint-mode-toolbar.js:111-139` |
| P1-3 | `undo()` is one global stack across every floor and mask kind. Two Ctrl+Z presses on the visible layer can silently revert a DIFFERENT floor's or kind's stroke — invisible because the preview only draws the active `kind::floor`. | 2 independent passes | `ui/paint-mode.js:276-290` |
| P1-4 | The adjacent-floor prewarm loop shares its generation counter with user-triggered floor prepares; a prewarm call can supersede an in-flight user floor switch, leaving the VT viewer, `activeFloorContext`, and the painter's own `state.floor` pointing at three different floors. | 1 pass | `vt/vt-pan-viewer.js:15687,16494-16502`, `boot.js:2271-2340` |
| P1-5 | Re-opening the painter seeds `state.floor` from Foundry's own `canvas.level`, which MSA's viewer floor changes never write back to — so after stepping floors once, closing and reopening the painter re-opens on the WRONG floor while the preview overlay reinforces the illusion by only drawing that floor's layers. | 1 pass | `foundry/paint-adapter.js:68-70` |
| P1-6 | `state.ctx` (scene rect, `boardElement`, floor count) is captured once at `enter()` and never refreshed. A canvas/scene rebuild while the painter is open leaves `boardElement` stale — clicks silently stop painting (the `event.target === boardElement` gate can never match again), no error, no notification, brush ring just stops appearing. | 2 independent passes (also explains why the click-target gate can fail even though the gate's own logic is sound) | `ui/paint-mode.js:516`, `foundry/paint-adapter.js:60,90` |
| P1-7 | `shadow`/`tree`/`bush` are offered in the paint-kind dropdown but are never composited into any render (`rasterize:false` in the catalog) — and `shadow` is the FIRST kind, so the quick-launch "🖌️ Paint masks" debug action opens on a dead kind by default. | 1 pass | `scene/mask-catalog.js`, `ui/paint-mode-toolbar.js:103-108`, `ui/paint-mode.js:87,136` |
| P1-8 | Merely browsing the mask-kind dropdown (to look for something else) auto-creates an empty layer for that kind; Save persists it; an empty painted layer still counts as `'authored'` provenance, which can silently break water's cross-floor borrow for the rest of the session — recoverable only by reload (the empty layer gets dropped from the *persisted* payload, making this intermittent and non-reproducible after a restart, the worst kind to report). | 2 independent passes | `scene/mask-derive.js:952-957`, `foundry/water-seams.js:21-25`, `world/water-floor.js:50` |
| P1-9 | No `pointercancel`/`blur` handling, no `e.buttons` check, no pointer capture on the paint stroke handlers — a release outside the browser window leaves `state.painting=true`, so re-entering the map paints a trail with no button held. Deterministically: holding the brush down, pressing Escape (opens the unsaved-changes modal), and continuing to move the mouse paints a stroke straight across the map toward the dialog's own Save button, which then saves it. The sibling authoring tool in the same directory (`anchor-mode.js`) already does this correctly (`setPointerCapture` + `pointercancel`). | 2 independent passes (one purely from code reading, one with a deterministic repro) | `ui/paint-mode.js:411-430` vs `ui/anchor-mode.js:398,425` |
| P1-10 | No text-input guard on the painter's `window`-level, capture-phase keydown handler. With the painter open (its overlay is `pointerEvents:none`, so Foundry's own chat box stays fully focusable), typing in chat routes through painter shortcuts: Ctrl+Z undoes a paint stroke instead of the chat's own undo, Enter/Backspace get intercepted and `preventDefault`-ed. The correct guard pattern already exists in a sibling file. | 1 pass | `ui/paint-mode.js:437-483` vs `ui/rooms/studio/shell.js:368` |
| P1-11 | "Clear" is destructive, has no confirmation (unlike two *less* destructive choices in the same toolbar that do get a modal), and its label doesn't say what it clears (current kind + current floor only) — it sits immediately next to Save. | 1 pass | `ui/paint-mode-toolbar.js:181`, `ui/paint-mode.js:321-328` |

### P2 — real, lower urgency or needs a product decision rather than a pure code fix

| # | Finding | Where |
|---|---|---|
| P2-1 | Realistic authoring payloads measured at ~2.55 MB (a single wandering stroke on a 12,000×8,000 scene), 27× over the 96 KB soft budget, which is warn-only. This is the actual trigger surface for P0-5's failure mode. Needs a product decision — enforce the budget as a real gate with a fallback, or stop deferring Mode B (bake-to-file) — not a unilateral code fix. | `scene/paint-mask.js:44` (`PAINT_EMBED_BYTE_BUDGET`), `ui/paint-mode.js:585-602` |
| P2-2 | Self-alpha compositing is not purely additive as its own doc claims ("can only ever ADD... never silently blank out") — measured: a soft brush stroke pulls a file-painted region's value DOWN toward the painted value anywhere the two overlap partially, not just at full strength. | `scene/mask-authority.js:544-546` vs `mask-derive.js:331-332`, `MEASURED` |
| P2-3 | The `hydrateFromScene` scene-resize `mismatched` report is computed, documented as "the caller is told," and then the one real caller discards the return value — a resized scene's masks can silently re-persist at the wrong resolution with zero warning anywhere. | `boot.js:12183` (3 independent passes) |
| P2-4 | The `kind::floor` storage-key parser has no validation — `""`, `"00"`, `"0x1"`, `" 2"`, `"1.5"` all parse without error, and some collide on the same downstream ingest key. Only reachable via malformed/hand-edited data (scene export/import, manual JSON edit), not through the UI. | `boot.js:1421-1434` |
| P2-5 | The LAB department's `isGM()` gate is on the sidebar rail button only; `switchDepartment` (used by at least one live caller) bypasses it entirely — a second, weaker door to the painter. | `ui/rooms/studio/shell.js:255` vs `:274`, `effects-department.js:438` |
| P2-6 | Save button reads visually disabled (dimmed) when clean but is not actually `disabled` — an accidental click re-runs the write. | `ui/paint-mode-toolbar.js:217-218` |
| P2-7 | Single-letter tool/brush shortcuts don't exclude Ctrl/Cmd, so e.g. Ctrl+S fires the native browser save dialog AND silently toggles paint-snap. | `ui/paint-mode.js:465-473` |
| P2-8 | The preview canvas backing store is sized in CSS px with no `devicePixelRatio` scaling, so on any HiDPI display (the author's own machine included, per prior memory) the mask preview/brush ring/vector draft render visibly softer than the map art underneath. | `ui/paint-mode.js:568-569`, `paint-mode-canvas.js:139-142` |
| P2-9 | `gridCanvases`/`gridImageData` preview caches are keyed by `kind::floor` and never pruned on exit or scene change — up to ~128 MB retained per key, indefinitely, across a whole session. Two passes both flagged this independently. | `ui/paint-mode.js:141-142` |
| P2-10 | `KIND_COLORS` (preview tint) has a dead `dust` entry and is missing `fluid` — a painted `_Fluid` layer previews in fire's own orange, indistinguishable from real fire on a floor with both. | `ui/paint-mode-canvas.js:20-31` |
| P2-11 | Anchors' persisted `overrides` store the FULL hydrated params (every schema default filled in), not a diff, despite the adapter's own comment claiming the same "store only what differs" discipline as paint-mask.js. A future catalog default retune (e.g. a candle's `flickerAmount`) silently never reaches any already-placed anchor. | `boot.js:2361-2371` |
| P2-12 | `fade-persistence.js#writeFadeState` has the identical merge-trap shape as Bug #31 — an object-map flag written via a bare `setFlag`, and `pruneExpired` already deletes keys from it. Currently latent only because nothing persists the pruned result; the obvious next edit ("also save after pruning") reproduces #31 exactly, with a faster feedback loop (`watchFadeState` re-reads on every `updateScene`). | `foundry/fade-persistence.js:50-58`, `world/fade-engine.js:298-304`, `boot.js:9161` |

### Confirmed clean / not currently reachable — worth knowing, no action needed

- **`anchor-adapter.js`'s tombstone pattern (`{overrides, removed}`)** is genuinely correct end-to-end — the one system in this audit that does "omission can't express deletion" right, and has a test that proves it.
- **The RLE codec itself** — round-trip tested exhaustively (all-255, all-zero, single-texel, the exact run-length cap boundary, every scene-rect edge/corner) — no bug found. (Coverage for these edges in the actual test suite is a separate, smaller gap — P2 territory, not listed above to avoid padding the table.)
- **The `event.target === boardElement` click-gate design** is structurally sound and immune to every sibling UI panel added since it shipped — its only weakness is the *reference* going stale (P1-6), not the *check* itself.
- **Stroke interpolation** (fast/slow drag continuity, the click-down point) is correct — no dropped points, no double-density build-up from event rate.
- **`markWorldDisc`'s dirty-rect under-invalidation** below 0.25 painter-texels is a real broken invariant but is currently unreachable — the Size slider's minimum (5 world units) keeps every realistic scene above the threshold. Flagged so nobody lowers that minimum without fixing this first.
- **Fire's cache-invalidation** (`fireMaskCache`/`fireSpawnCache`, keyed on authority version) is airtight for every ordinary mutation path — the one gap is P0-4's aliasing bypass, not the cache logic itself.

---

## Bonus: a likely root cause for Bug-Tracker #19 (open, unsolved, unrelated to painting per se)

While tracing the mask-authority ingestion boundary, one pass found that
`extractionPlanForLayer`'s own comment — *"the trio has exactly one
rasterized member, so alpha cannot diverge"* — is **false against the
current catalog**: the shadow/outdoors/fire packed trio has TWO rasterized
members (`outdoors`, `fire`), and `validateMaskCatalog` only enforces
*exactly one `ownsPackedAlpha`*, not "exactly one rasterized." The practical
effect: `_Fire` is ingested carrying **`_Outdoors`'s** packed alpha channel,
not its own — so a floor whose `_Outdoors` file is partially transparent
multiplicatively attenuates that floor's fire, while a floor with a fully
opaque `_Outdoors` does not. This matches Bug #19's exact evidence pattern
(identical fire pixels work on one floor, fail on another; partial-not-zero
signal at low sensitivity thresholds). Recommended before any fix: compare
Ground vs. First Floor `_Outdoors` alpha histograms on the bench Mansion via
`maskAuthority.getReport()`'s per-floor alpha counters. Full trace:
`scene/mask-authority.js:420-424,443-446` vs `scene/mask-catalog.js:418-431`.

---

## Suggested order, if tackling this as its own pass

1. P0-1 (permission gating) — small, fully precedented, and the one item
   that touches "secrets safe from players" directly.
2. P0-2/P0-3/P0-4 together — all three are "the author's own explicit
   choice (discard, or simply not saving) gets silently overridden later,"
   the same underlying design gap (no real snapshot-and-restore model for
   `state.layers`) wearing three different triggers.
3. P1-9 (pointer capture) — smallest fix in the whole list relative to
   its severity, and the correct pattern is a straight copy from
   `anchor-mode.js`.
4. P0-6 (five kinds can never render painted content) — decide whether to
   wire the four/five remaining kinds into the same door fire already uses,
   or correct the product copy that currently overclaims it. Either is a
   legitimate call; leaving the mismatch between the two is not.
5. P0-7 / P2-2 (self-alpha squaring + the 8× resolution mismatch) — the
   biggest "why does painted fire feel unreliable" lever, and the most
   architecturally involved item on this list; worth its own scoped design
   pass rather than a quick patch.
6. Everything else, roughly in P1 → P2 order, as time allows.
