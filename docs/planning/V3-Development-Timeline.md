# V3 Development Timeline & Health Tracker

> **Purpose.** A living record of how the V3 (Keyhole) engine is progressing over
> time, and a recurring health check against the exact diseases that killed V2.
> This is the *human-readable* companion to the `keyhole-stage-status` session
> memory — that one is a per-session build log; this one is the long arc.
>
> **How to update.** Each time you want a fresh reading, re-run the commands in
> §3, add one dated column to the metrics table, and (if anything changed) update
> the scorecard in §4. Keep the god-object watch in §5 honest. Don't rewrite
> history — append.
>
> **Last measured:** 2026-07-25 · **Author-facing summary lives in §0.**

---

## 0. The one-paragraph answer

V3 (the *Keyhole* rebuild) is **10 days old** as of 2026-07-25, or ~2 weeks if you
count the forward-rendering prototype that fed straight into it. In that time it has
grown to ~62,000 lines of product code with **3,923 passing tests** and **28 machine
walls** that make V2's famous disasters physically impossible — and by every metric
that killed V2, this engine is dramatically healthier and, crucially, *still
improving* (two safety ratchets tightened themselves the day this was written). **But
there is one real, growing danger:** the file `vt/vt-pan-viewer.js` has become a
single **~10,400-line function** — already larger than V2's most infamous god-object —
and it is invisible to every wall we built, because **not one of our 28 rules measures
size.** That is the V2 disease we have *not* yet immunised against, and it is
compounding. See §5.

---

## 1. How long has V3 actually been under development?

Your "about 2 weeks" instinct is right — but "V3" has three layers, and it's worth
being precise about which one we mean:

| Layer | When | What it was | Status |
|---|---|---|---|
| **Scattered V3 experiments** | Feb–Jun 2026 | Odd commits tagged "V3" (a water effect, an "experimental V3 prototype") | ☠️ Deleted / superseded |
| **V3 forward-render prototype** | ~9–14 Jul 2026 | The "unified-forward / Forward+ / compositor-v3" pipeline — colour grade, bloom, indoor/outdoor. The *immediate* run-up. | Folded into Keyhole thinking, then quarantined |
| **Keyhole (the plan of record)** | **15 Jul 2026 →** | Clean-tree rebuild: `git commit 445736f "Keyhole Stage 0: quarantine V2, boot the new tree"`. **This is today's V3.** | 🟢 Active |

So: **the engine you're building now is 10 days old.** The push toward it — the point
where "we're really doing V3" became true — was ~16 days ago. Everything before that
was prototyping that got thrown away, which is itself a good sign: V3 proper started
by *quarantining* V2 rather than editing it.

> ⚠️ **The git history lies about this.** This repo's first commit is 2025-11-17, but
> that's **V2's** birth — the entire `legacy/` tree (~376k lines) lives in the same
> repo. Don't read the repo age as the engine age.

---

## 2. Milestone timeline (Keyhole era)

Dense because the velocity is genuinely ~V2-scale (2,000+ lines/day). Clusters, not
every commit. **Note:** `git HEAD` is at 2026-07-20, but **173 src/ files are
uncommitted** — the last week's work (wind, candles, grade, shadows, doors, sky) is
real and tested but not yet committed, so the commit log *understates* current progress.

| Date | Milestone | Why it matters |
|---|---|---|
| **15 Jul** | **Stage 0 + Stage 1** — quarantine V2, boot new tree; the allocator law, page-cache, physical atlas, shared VT sampler, first real pixels, residency streaming. **ESLint/Prettier/kebab-case tooling.** | The foundation + the first walls. 60 real issues caught on the tooling's first run. |
| **16 Jul** | Multi-layer VT core, off-thread decode, camera controls, the layering law, coordinate model, scene model (foreground/background/tiles/occlusion), Y-flip proven in a Node test, fail-loud renderer. **THE V2 AUTOPSY written.** | The design doctrine gets burned in. `v2-postmortem` + confidence assessment authored here. |
| **17 Jul** | Enforcement day: the test gate made real (94→1,151 assertions actually running), the pass runner, the reachability wall, **params harvest (45 schemas / 2,225 params)**, **the interface seam** (author: *"Working exactly like native Foundry"*), the mask authority, the flight recorder. | The skeleton stops being detached. Walls start firing on their own builder. |
| **18 Jul** | **CI release gate fixed** — `.github/workflows/main.yml` now runs `npm run verify` before packaging, and zips `src/` not the deleted `scripts/`. | Releases can no longer ship a broken or empty module. |
| **19 Jul** | *"Basic parity between Foundry VTT and three.js"* declared. Pixel-probe tool buffed into a durable instrument. | First "it actually looks right" milestone. |
| **20 Jul** | Floor switching, **BC1/BC7 texture compression** (fixed the 12K-map device-loss — author: *"bravo!"*), **27 animated light types**, effect-registration Stage A (UI-cast shadows), candle wall-clip fix. *(git HEAD)* | Big-map reliability solved; the effect-registration template lands. |
| **21 Jul** | **Wind Tiers 0/1/2** (ambient + relaxation + transient door-gust sim), candles wired to the whole wind field. *(uncommitted)* | The environment systems begin. |
| **22 Jul** | **Candle FOH/ROH controls** — the generic effect-UI template every future effect copies; live anchor add/remove/edit. *(uncommitted)* | Authoring UI pattern established. |
| **23–25 Jul** | Grade engine + God CC, bloom (author-confirmed live), sun shadows, door graphics, sky-as-light, astrolabe/day-clock, vegetation tiers. *(largely uncommitted)* | A week of effects built on the now-stable foundation. |
| **25 Jul** | **This timeline + the god-object audit.** Built the **size ratchet** (the one missing wall), froze all 10 god-objects shrink-only, and began the reversal: `region-darkness.js` split into pure geometry + TSL materials. *(uncommitted)* | Maintenance turn — stop the god-object growth, start shrinking it. |

---

## 3. Health dashboard (the living metrics)

**Re-run these to add a column.** All measured against the current working tree.

```bash
# assertions + suites
node tools/run-tests.mjs 2>&1 | tail -3
# structure walls + which ratchets moved
node tools/verify-structure.mjs 2>&1 | tail -6
# the god-object watch — largest files, and the biggest single function
find src -name "*.js" -not -path "*/vendor/*" -not -name "*.test.mjs" | xargs wc -l | sort -rn | head -5
# the V2-disease counters
grep -rn "window.MapShine" src --include="*.js" | grep -v vendor | wc -l   # global bus
cat tools/structure-ratchets.json                                          # all ratcheted debts
```

| Metric | 15 Jul¹ | 17 Jul¹ | 21 Jul¹ | **25 Jul (measured)** | Direction |
|---|---|---|---|---|---|
| Passing test assertions | ~60 issues found | 1,211 | 2,885 | **3,923** | 📈 healthy |
| Test suites | — | 11 | 15 | **16** | 📈 |
| Structure walls (rules) | ~14 | 19 | 24 | **28** (9 ratcheted) | 📈 |
| `window.MapShine` reaches | — | — | — | **2** *(V2: 479)* | 🟢 dead |
| Silent/empty catches | — | ~35 | ~29 | **29** *(V2: 2,670)* | 📉 shrinking |
| Unreachable "museum" files | 28 | 13 | 8 | **3** | 📉 shrinking |
| src/ product code (lines) | small | — | — | **~62,000** / 162 files | 📈 |
| **Largest single file** | — | 2,318 | — | **11,860** (`vt-pan-viewer.js`) | 🔴 **§5** |
| **Largest single function** | — | 1,778 | — | **~10,385** (`startVtPanViewer`) | 🔴 **§5** |

¹ Earlier columns are reconstructed from session memories (point-in-time, approximate).
The 25 Jul column is measured directly and is authoritative.

**Two ratchets auto-tightened the moment this was measured** (`time/one-clock` 38→35,
`graph/reachable-from-boot` 8→3). That means the code got *cleaner* than the last
recorded low-water mark without anyone forcing it — the ratchet mechanism working
exactly as designed. This is the single strongest signal that V3 is not decaying.

---

## 4. Are we repeating V2's mistakes? — the scorecard

Every row is a **measured** V2 failure mode from the autopsy, checked against V3 today.

| V2 disease | V2 measured | V3 today | Verdict |
|---|---|---|---|
| **Global bus** (`window.MapShine` rummaging) | 479 reaches, incl. into privates | **2** | 🟢 **Dead** — `no-global-bus` wall at 0 |
| **Silent failure** (empty `catch`) | **2,670** swallowed errors | **29**, ratcheting down | 🟢 **Contained** — `no-silent-catch` wall |
| **Nobody owns the renderer** | 452 `setRenderTarget` across 60 files | **0** outside graph | 🟢 **Dead** — `renderer-state/graph-only` |
| **World-res RT sprawl** (the VRAM death) | 70 private targets | **0** hand-allocated | 🟢 **Dead** — `gpu/allocator-only` throws |
| **Params as unowned blackboard** | 938 keys, 119 external writers | **0** violations | 🟢 **Dead** — `params/one-owner` |
| **Effects declare nothing** | all 46 | contract-based (`reads`/`writes`) | 🟢 **Dead** — frame graph derives order |
| **Eight suns / four darknesses** | computed in 8+ places | one owner each | 🟢 **Dead** — `env/one-sun`, `env/one-darkness` |
| **Optional structure** (good API, ignored) | EffectComposer 5 vs 92 importers | walls are mandatory in `npm run verify` + CI | 🟢 **Immunised** |
| **No tests** | ~none | **3,923 green** | 🟢 **Reversed** |
| **God-object** (one file eats everything) | FloorCompositor 10,063 lines; token-mgr 12,771 | **`vt-pan-viewer.js` 11,860 lines / one 10,385-line function** | 🔴 **REPRODUCING — see §5** |
| **Bespoke push-doors** (a setter per capability) | `?.setOutdoorsMask?.()` ×12, 643 touch points | **36 `setVtPanViewer*` doors** into one closure | 🟠 **Early-stage — same shape, better hygiene** |

**Read this honestly:** 9 of V2's diseases are *architecturally dead* — not
discouraged, not linted, *unavailable*. That is a genuinely excellent result and it is
the direct payoff of the "make the wrong thing impossible" doctrine. **But the two
that survive are the same one:** the god-object, and the push-door pattern that always
grows around a god-object. They survive for one reason — **they're the only V2 diseases
we never built a wall against.**

---

## 5. 🔴 The one real warning: the `vt-pan-viewer.js` monolith

> **✅ UPDATE 2026-07-25 — the ceiling is now locked.** The size ratchet (§6.1)
> freezes all 10 god-objects shrink-only, so the trajectory below is *reversed*: the
> monolith can no longer grow, and decomposition is the only legal path forward. The
> ratchet also found a **second god-function** — `boot.js` has a 3,467-line function.
> First reversal shipped: `region-darkness.js` (1,416 lines) split into a pure Node-
> tested `region-geometry.js` (660) + a slimmer `region-darkness.js` (776), one god-
> object eliminated, 3,942 tests still green. The **frozen inventory** (`size-budgets.json`):
> `vt-pan-viewer.js` file 11,870 / fn `startVtPanViewer` 10,395 · `boot.js` file 4,082
> / fn 3,467 · `particle-runtime.js` file 1,824 / fn `createParticleEngine` 1,066 ·
> `debug-panel.js` file 1,321 / fn `installDebugPanel` 1,249 · `decode-pool.js` 1,128 ·
> `paint-mode.js` file 1,083 / fn `installPainter` 867 · `candle-flame-render.js` 1,010
> · `mask-authority.js` fn `createMaskAuthority` 596 · `gust-runtime.js` fn
> `createGustEngine` 590. The narrative below stands as the record of *why* this
> mattered.

This is the finding that matters most, and it is not subtle once you look.

**The facts:**
- `src/vt/vt-pan-viewer.js` is **11,860 lines** — the largest file in V3 by 3×, and
  **larger than V2's `FloorCompositor.js` god-object (10,063 lines)** that the autopsy
  holds up as the central disaster.
- Inside it, `startVtPanViewer` is a **single function from line 742 to line 11,127 —
  ~10,385 lines.** Camera, residency, meshes, decode, occlusion, wind, candles, lights,
  particles, time, grade, masks — the entire live renderer is constructed inside one
  closure.
- **36 exported `setVtPanViewer*` functions** poke that closure's captured state from
  outside — the exact "bespoke door per resource" shape from autopsy §3.2, one level up.
- On **2026-07-17** the memory recorded it at **1,778 lines** and flagged it in plain
  words: *"That is EffectComposer's 5-vs-92 forming, and we are building it."*
  **Eight days later it is 5.8× bigger.**

**Why it's happening (and why it's not negligence):** there was a deliberate, *correct*
decision not to refactor this function — it took 9 rounds of live in-browser debugging
to get right (Y-flip, GL texture-unit staleness, UV compounding), and there is no way
to test a restructuring of it without a running Foundry, which no build session has had.
So every new effect got wired *into* the monolith because that was the only safe,
fast, testable-at-the-boundary move that afternoon. **That is precisely the V2
mechanism** — the autopsy's thesis is that FloorCompositor was never a bad decision, it
was 46 locally-rational ones. We are on move ~12 of the same sequence.

**Why it compounds:** the bigger it gets, the more true "too risky to touch" becomes,
which is exactly why it keeps getting bigger. Left alone, this is how you arrive at
10,000 lines — we're already there — and then 12,000, and then it's untestable in
isolation forever.

**Why the walls didn't catch it:** all 28 rules police *coupling between modules*
(imports, doors, globals, renderer ownership, one-sun, one-clock…). **Not one measures
the size of anything.** `npm run verify` is green with a 10,385-line function in the
tree, and it always will be. This is the blind spot the [[keyhole-confidence-assessment]]
explicitly predicted: *"the next disease won't be `window.MapShine` again."* It isn't. It's this.

**Mitigating truths (so we don't overreact):** the blast radius is *contained* in a way
V2's never was — this monolith is import-fenced from the rest of the tree, has zero
global reaches, and is covered by 396 boundary tests. It is one bad file in an otherwise
disciplined engine, not the whole engine. But size alone makes its *internals*
untestable and unmaintainable, and that is a real, growing cost.

---

## 6. Beyond lint & prettier — tools & processes that would help

Lint + Prettier caught 60 issues and enforce style; the 28 structure walls enforce
architecture. Here's what would close the remaining gaps, roughly in value order:

1. **🎯 A size ratchet — ✅ BUILT 2026-07-25.** `SIZE_CAPS = {file: 1000, fn: 500}` in
   `verify-structure.mjs`, per-file/function budgets in `size-budgets.json`, same
   shrink-only + loud + `--update-ratchets` contract as the other 9 ratchets;
   unit-tested (9 assertions) and sabotage-tested end-to-end (grow a budgeted file →
   build exits 1). Seeded at current sizes, so `vt-pan-viewer.js`/`startVtPanViewer`
   can now only SHRINK — **no new effect can be wired into the monolith without failing
   the build.** It immediately surfaced a *second* god-function nobody had flagged:
   `boot.js` holds a 3,467-line function. See §5 for the frozen inventory.
2. **Wire `knip` into the gate.** It's already a dependency (`npm run knip`) but sits
   *outside* `npm run verify`. It finds unused files, exports, and dependencies — dead
   code that the reachability wall (which only checks reach-from-boot) doesn't catch.
   Run it in the gate, or at least weekly, ratcheted.
3. **Run the gate on every push, not just on release.** CI currently runs `npm run
   verify` only when a release is *published*. A broken commit can sit on the `keyhole`
   branch indefinitely between releases. Add a `push` / `pull_request` trigger so the
   machine — not your memory — catches a regression the day it lands. (For a solo dev
   who runs verify locally every session this is a backstop, but backstops are the
   point.)
4. **A live-verification ledger.** The recurring phrase across the memories is
   *"verify-green, NOT live-tested."* A huge fraction of V3 is proven in Node but never
   seen on screen (grade engine shipped black-screen-broken for a while for exactly this
   reason). A simple tracked checklist of "built ✓ / live-confirmed ✓" per effect would
   stop unconfirmed work from silently piling up. §2 above is a start; formalise it.
5. **Commit more often.** 173 uncommitted files means a week of real, tested work is one
   `git` accident away from loss, and the history can't tell the progress story. Not a
   tool — a habit — but a cheap, high-value one.

---

## 7. What V3 has unambiguously gotten right

Balance, so this reads as an assessment and not a hit piece:

- **The specific catastrophe that killed V2 is dead.** Global bus, silent failure,
  renderer ownership, VRAM sprawl, unowned params — gone, and *enforced*, not hoped for.
- **The walls fire on their own builder** and each fix improves the tree — the autopsy's
  "make it impossible" doctrine is demonstrably working, repeatedly, in anger.
- **The debt is being paid down, not accrued** — ratchets auto-tighten; the unreachable
  museum went 28→3.
- **Real test culture from day one** — 3,923 assertions is not decoration; it caught
  black-screen bugs, stale-read bugs, and validation gaps before they shipped.
- **The instruments are taken seriously** — the pixel probe, flight recorder, and
  wind/particle probes exist because "instruments must not lie" is treated as law.

The engine is competent and, by V2's standards, *safe*. It has exactly one disease left
untreated, it's visible, and the cure is a tool we already know how to build.

---

*Update this document as development continues — that's the whole point of it.*
