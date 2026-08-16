# ✠ THE V4 TESTAMENT ✠

**This is a holy document.** It lives in `docs/holy/` — the special directory. Everything in
this directory is governed by **The Covenant** (memory: `the-covenant`), whose rules are
repeated here so no reader can miss them:

> **RULES OF THIS PLACE**
> 1. Only a **Fable-class or greater** model may create a holy document, restructure this one,
>    edit its Law, its definitions of done, its gates, or resolve a Petition.
> 2. **Any model** may execute tasks and record completion — flip `[ ]` to `[x]` and append an
>    evidence line. That is the full extent of a worker's editing rights here.
> 3. Only a **Fable-class** model may **countersign** (`✠`) — the judgment "was this carried
>    out how I would have liked? did it meet all the requirements I'd have had in mind?" —
>    and it does so by inspecting the actual work, never the worker's summary.
> 4. A worker who believes the plan is wrong does not edit the plan. It files a **Petition**
>    (§ at the bottom) and moves on. Fable adjudicates petitions.
> 5. Above everything in this file sits **the author**. Their LIVE verdict on a real scene
>    outranks any countersign; their word rewrites any Law.

**Task notation** (the only states that exist):

```
- [ ] open
- [x] claimed        · done <model> <date> — <one-line evidence: what changed, how verified>
-  ✠  countersigned  · ✠ <date> — <verdict, after inspecting the work itself>
-  ⚑  reopened       · ⚑ <date> — <findings; these findings ARE the next worker's brief>
```

**Created 2026-08-10 by Claude Fable 5, at the author's command.** Companion documents, in
authority order: this file (the plan and the feature bible) → `docs/planning/Moonshot-Plan.md`
(the menu that chose this path — analysis record) → `docs/planning/Moonshot.md` (evidence,
facts only).

---

## THE GOAL

**V4 = V2's full map-selling power, reborn on V3's foundation, at frame rates that make the
Mansion map's upper floor comfortable.** Working targets on the reference RTX 3070 Laptop at
3840×1906: acceptable = sustained **40+ fps**; good = **60 locked** (16.7 ms), worst frame
≤ 50 ms. Measured start point: 18.1 avgFps, 47.05 ms GPU, worst frame 783 ms.

Releasing maps is how the business makes money. Every priority call in this document bends
toward: *what lets the author ship beautiful maps again, soonest, without mortgaging the
engine's future.*

**The author's verdict on V3, recorded so no future reader mistakes it (2026-08-10):** V3 is
not a failure — the Mansion at 4K, two floors, many effects is the hardest possible test, and
V3 is *just starting to cope with it*. Some things are already better than V2, lots are about
the same, lots need more tuning. This Testament is renovation and completion, not rescue.

---

## THE LAW (binds every task below)

1. **The Covenant governs this file.** See the banner. No exceptions for velocity — the V2
   autopsy's one sentence is "structure loses to velocity"; the Covenant is structure.
2. **`BUILT (unverified)` ≠ `LIVE`.** Only the author's eyes on a real scene promote. A
   countersign confirms plan-fidelity and quality; it does not promote to LIVE.
3. **The `standard` profile keeps producing today's pixels** until the author says otherwise.
   Perf work must be pixel-diff-gated; look changes are their own, author-led tasks.
4. **The depth authority is the sole occlusion/rank system.** Renovation *promotes* it (the
   rank buffer becomes the hardware depth test); nothing may add a second scheme.
5. **The safety slide stands** — Foundry's own renderer remains the fallback at every commit.
   Every structural change ships behind a revert flag.
6. **Foundry owns input.** The interface seam stands.
7. **Vision/fog is never cached, baked, or approximated.** The known fog-of-war leak is a
   correctness bug with its own scheduled fix; player-facing information gating is sacred.
8. **`npm run verify` green before any `src/` work is called done** — necessary, never
   sufficient (Law 2).
9. **No hand-maintained dispatch lists** in anything V4 builds. Registration is data with a
   startup completeness check. (`EFFECT_REAPPLIERS` has struck six times.)
10. **All V4 work updates this document** — a task claimed before starting, evidence recorded
    after. Work that happened but isn't recorded here didn't happen (memory:
    `v4-testament-is-the-checklist`).
11. **The assistant never touches the author's real Foundry.** Parity data crosses in ONE
    direction only — the author's own export button → a portable file → the bench world. No live
    connection, no shared data directory, no writes to the author's worlds, ever. *(Promoted from
    P-002's resolution, 2026-08-10.)*

---

# BOOK I — THE RENOVATION
*The engine: staged Option 1 → Option 2, as chosen by the author 2026-08-10 from the menu.*

The strategy in one line: **do the anatomy surgery inside V3 now** (fast, revenue-relevant
wins; nothing thrown away), **then give the frame core its overdue rebuild** (the keel), onto
which the bake/cache pillar lands as a feature instead of a retrofit. Full technical detail
per stage lives in `Moonshot-Plan.md` §2; the checklists here are the working state.

### Stage 0 — Week Zero: measure before believing *(no pixels change)*

- ✠ 0a-0 · Live-verification harness *(added at Stage-0 close by P-001's resolution)* · done
      Claude Opus 5 2026-08-10 — Foundry v14 in-repo, Playwright driving real Chrome on the real
      GPU against the bench Mansion world; the six traps and the first real capture are recorded
      in P-001 below. · ✠ 2026-08-10 Claude Fable 5 — every other Stage-0 measurement ran through
      this harness, which is a stronger verification than any inspection of it could be.
- ✠ 0a-1 · Scene export/import bridge *(added at Stage-0 close by P-002's resolution)* · done
      Claude Sonnet 5 2026-08-10 — one-way file bridge from the author's real world into the bench
      world, round-trip proven with real walls/lights/regions/MSA flags; full record in P-002
      below. · ✠ 2026-08-10 Claude Fable 5 — inspected P-002's evidence trail; the `{keepId:true}`
      cross-reference check is the load-bearing proof and it was made directly, not assumed. Its
      safety pattern is promoted to Law 11.
- ✠ Pass census · done Claude Sonnet 5 2026-08-10 — answered via MSA's own zone taxonomy
      (`isPass:true` tags) rather than a literal `about:tracing`/Dawn capture: **8 passes/frame**
      real numbers, world draw confirmed as exactly ONE pass (176 draw calls inside
      `pass.geometry.world`). Full table in `Moonshot.md` §7. Fable should judge whether the
      in-engine method satisfies this item's intent or whether a literal Dawn capture is still
      wanted. · ✠ 2026-08-10 Claude Fable 5 — judged sufficient: the `isPass` brackets wrap the
      real beginRenderPass boundaries, so the item's actual question (is the world draw ONE pass)
      is answered from ground truth. A Dawn capture would only add three-internal passes that the
      report's own gpuMs caveat already scopes out. No Dawn capture required.
- ✠ The 7.7 ms CPU mystery: the migration experiment · done Claude Sonnet 5 2026-08-10 —
      a debug-only dummy 1-triangle `render()` (its own profiler zone,
      `geometry.debugFirstRenderProbe`) inserted immediately before `runSceneDepthPass`'s own
      setup, armed via a new `MapShine.setDebugFirstRenderProbe(true)`, captured through a real
      `perf-run-full` run on the Ground Floor Mansion Redux import. Real numbers, same capture:
      `masks.occlusionDraw` (genuinely the frame's first `renderer.render()` call in production)
      0.086ms mean; the new dummy probe (positioned second, immediately before the depth pass)
      0.09ms mean — both trivially cheap and within noise of each other; `geometry.depthRenderCall`
      (the real depth-pass call, third) 6.133ms mean — ~68× either. Re-run after fixing the
      fps-cap bug noted two rows below: 0.066/0.075/3.375ms respectively (~45×) — same conclusion,
      independently repeated. **Answer: the cost stays with the depth pass specifically, not with
      "first render of the frame."** The deeper "what about
      the depth pass" is NOT resolved by this (Moonshot.md §5's isolated-repro gap stands) — this
      experiment only distinguishes the two hypotheses the item poses, which it does cleanly.
      Non-obvious wiring bug found and fixed en route, real enough to be worth its own note: none
      of the three new debug setters were reachable from `MapShine` at all at first, despite being
      correctly added to `startVtPanViewer`'s returned object — that object is never itself spread
      onto `MapShine` (only captured locally as a scene-load result/report); every console-callable
      `MapShine.xxx` method here goes through a hand-written module-level wrapper
      (`export function setVtPanViewerXxx` in `vt-pan-viewer.js`, delegating through the
      module-level `_active` reference) plus an explicit `MapShine.xxx = wrapper` line in `boot.js`
      — added for all three flags (`src/vt/vt-pan-viewer.js`, `src/vt/index.js`, `src/boot.js`).
      `npm run verify` green throughout (8,254 tests, unchanged count). · ✠ 2026-08-10 Claude
      Fable 5 — inspected the flag/zone/wrapper code in the tree and both result JSONs (capped
      run 0.09 vs 6.133ms; uncapped rerun 0.075 vs 3.375ms — the same verdict twice,
      independently). Answers exactly the two-hypothesis question the item posed. Clean.
- ✠ Hitch autopsy · done Claude Sonnet 5 2026-08-10 — real capture, 20 hitches >50ms, top
      seven multi-second (3341.8ms down to 975.1ms), each correlated with rising
      `idbHits`/`residentPages` and zero decode/eviction/miss counts (cache never overflowed).
      Correlation established with real numbers; the specific mechanism turning a cache-hit IDB
      read into a multi-second stall is NOT identified — recorded as an open gap, not a solved
      one. Full detail in `Moonshot.md` §7 "Hitch autopsy." · ✠ 2026-08-10 Claude Fable 5 — the
      item asked for an autopsy, not a conviction: per-hitch decode/cache diagnostics are attached
      to every spike and the unexplained mechanism is recorded open rather than papered over.
- ✠ A/B capture: blending force-off on fully-opaque layers · done Claude Sonnet 5 2026-08-10
      — a live-mutation debug flag (`MapShine.setDebugForceOpaqueBlendOff`), gated on the same
      `alwaysOpaque` signal the depth-writer material already trusts; confirmed visually lossless
      (before/after screenshots identical, as predicted — blending is a no-op at alpha≡1). Measured
      WORSE, not better (avgFps 37.9 vs. this session's own 48.6 baseline) — but the maskNode A/B
      immediately below produced near-identical numbers testing a wholly unrelated code path,
      which is itself the finding: neither flag's own performance question was cleanly answered
      this round. **INCONCLUSIVE — not a confirmed win, not a confirmed loss.** A clean re-run on
      an otherwise-idle machine is the named prerequisite, not further code changes. Full detail:
      `Moonshot.md` §7. · ✠ 2026-08-10 Claude Fable 5 — countersigned as executed: the flag is
      real (inspected in-tree), the losslessness prediction was screenshot-verified, and
      INCONCLUSIVE is the correct reading of two unrelated flags producing identical regressions.
      The usable measurement now lives as Stage 1's amended reconcile precondition, so closing
      this box cannot bury it.
- ✠ A/B capture: `maskNode` discard force-off · done Claude Sonnet 5 2026-08-10 — a debug flag
      (`MapShine.setDebugForceMaskNodeOff`, armed pre-reload since the discard is baked in at
      material-build time) bypassing the rank-lookup discard entirely; no obviously wrong pixels
      visible in the after-screenshot at this zoom/route. Measured avgFps 37.5, `pass.geometry.world`
      8.43ms — within noise of the blend-off A/B's own numbers despite the two flags sharing no
      mechanism, pointing at a shared session confound (most likely real machine load) rather than
      either flag's own answer. **Same INCONCLUSIVE verdict as the item above, for the same reason.**
      Full detail: `Moonshot.md` §7. · ✠ 2026-08-10 Claude Fable 5 — same countersign, same
      scoping as its sibling above.
- ✠ ⚠️ Instrument bug found and fixed en route (not a checklist item, recorded because it
      changes how to read every number above and below it) · Claude Sonnet 5 2026-08-10 —
      `perf-run-full`/`perf-report-all-tiers` were silently capped to ~30fps by the author's
      video-recording feature (both drive their route through the SAME `playCameraPath()` the
      recording panel uses, and the render loop's 30fps throttle doesn't distinguish the two
      callers). Fixed: `playCameraPath(path, {capFrameRate})`, default `true` (author's manual
      recording completely unaffected), both perf actions now pass `false`. The two A/B captures
      above are already the POST-fix numbers. Full detail: `Moonshot.md` §7. · ✠ 2026-08-10
      Claude Fable 5 — the find of the stage: a real, mechanism-confirmed fix with the author's
      own recording path untouched, and the blast radius honestly bounded (every §7 number above
      the bug's introduction re-checked against timestamps). Instruments must not lie; this one
      was caught lying and fixed.
- ✠ Live-test the already-built CAS `performance`+`low` tiers · done Claude Sonnet 5
      2026-08-10 — flipped `performanceProfile` live (no reload needed), re-ran the real
      `perf-run-full` capture on both non-default tiers, restored to `standard` after each.
      avgFps: standard 48.6 → performance 56.7 → low 57.6. `pass.geometry.world` CPU (where
      CAS's taps live): 6.041 → 4.928 → 4.879ms — performance and low nearly identical, matching
      the commit's own claim that both tiers get the same 1-tap substitution. Hitches: 20 → 9 →
      8. Honest confound found and checked, not assumed: `sunShadows` is the only effect that
      actually disables on `low` in this scene (others keep their GM-level "on" override despite
      `fromProfile:'performance'` manifests) — so `low`'s numbers are "CAS + sun shadows off,"
      not CAS alone. Also honestly recorded: `low`'s single worst frame (75.1ms) was WORSE than
      both other tiers — not explained, not hidden. Full detail: `Moonshot.md` §7. · ✠ 2026-08-10
      Claude Fable 5 — the sunShadows-on-low confound was checked against the report's own
      `effects[]` rather than assumed, which is exactly the discipline this stage exists to
      enforce. Directional result stands; `low`'s worse worst-frame stays an honest open note.
- ✠ Probe RenderBundle on three 0.185.1 with our real material set · done Claude Sonnet 5
      2026-08-10 — standalone probe (`tools/shader-lab/renderbundle-probe.html`, not wired into
      the shader lab's bench system), real WebGPU confirmed live, 300 static textured quads.
      `THREE.BundleGroup` (three r0.185.1's real public API) cut CPU-side `renderer.render()`
      encode cost 1.80×–2.60× across two runs, consistent direction both times. Honest gap: a
      representative synthetic material, not the literal `buildWholeImageMaterial` (a nested
      closure, not extractable without a real refactor — out of scope for a prototype probe).
      Answers "is RenderBundle worth building toward" (yes), not "exactly how much on our real
      material set." Full detail: `Moonshot.md` §7. · ✠ 2026-08-10 Claude Fable 5 — for Stage 4's
      own gate wording ("if the Stage-0 probe passed") this PASSES; the real-material number lands
      with Stage 4's adoption bench, where it belongs. The synthetic-proxy gap is declared in the
      probe page's own header — verified there, not just claimed here.
- ✠ Write all results into `Moonshot.md` as its "§7 Phase-0 measurements" (facts only) · done
      Claude Sonnet 5 2026-08-10 — all four items above plus the instrument-bug discovery written
      up in full under `Moonshot.md` §7's new "Stage 0 — the four remaining measurement items"
      and "A discovered instrument bug" sections. · ✠ 2026-08-10 Claude Fable 5 — sections
      verified present; the facts-only rule held (the one "should" in them is a named
      precondition, which is a fact about trust, not a proposal).
- ✠ Record the author's CPU model in `Moonshot.md` §1 · done Fable 5 2026-08-10 —
      Ryzen 7 5800H / 16 GB RAM / 3840×2160@120Hz display, provided by Ingram in-session and
      recorded in §1 with the memory-pressure implication noted. · ✠ 2026-08-10 Claude Fable 5 —
      verified in §1.

**Gate:** every box checked, zero behavior changes shipped.

✠ **STAGE 0 COUNTERSIGNED CLOSED — 2026-08-10, Claude Fable 5, at the author's command.** Every
box above carries its own countersign, each made against the artifacts (result JSONs on disk
re-read and matched to §7's tables, screenshots, the flag/zone/wrapper code in the tree) — never
the workers' summaries. Scope note on "zero behavior changes," recorded rather than fudged:
player-facing pixels are untouched; two instrument-side changes shipped (three default-off debug
flags, and the perf actions' `capFrameRate:false` fix). The two A/B boxes close as
executed-but-inconclusive — their usable numbers are a precondition folded into Stage 1's
reconcile clause below, so they cannot silently be treated as known.

### Stage 1 — Shade every pixel once *(the biggest lever)*

*Restructured at Stage-1 open, 2026-08-10, by Claude Fable 5 — original intent and every
original gate preserved; the engineering design (the EQUAL-by-construction argument, the
min-grid certification, eligibility rules, the shared-attachment legality constraint) is
`docs/planning/Stage-1-Shade-Once.md`, created against the real code the same pass. One
correction to the original list, recorded rather than silently applied: "per-cell min alpha
from the existing coarse grid" is impossible — that grid is a box-averaged MEAN and a mean
cannot certify a min (rounding hides sub-255 pixels). S1.1 builds the true min grid from the
BC worker's existing full-pixel scan instead.*

- [x] S1.1 Per-texel MIN alpha grid: pure accumulator (`vt/coarse-alpha.js`, Node-tested) +
      accumulation in `bc-compress.worker.js`'s existing banded scan + cache format v10
      (`alphaMinGrid`; v9 records fail-open to no-split = today's pixels) + plumbed to
      `wi.alphaMinGrid`. · done Claude Fable 5 2026-08-10 — `createMinAlphaGrid` +
      `accumulateMinAlphaBand` (throws on short/out-of-range bands rather than certifying
      texels never seen), folded into `handle()`'s existing band loop; v10 comment carries the
      mean-cannot-certify-a-min argument; grid rides the worker reply's transfer list; landed
      inert at `wi.alphaMinGrid` (no consumer until S1.4). Node tests pin: min semantics (one
      254 pixel drops exactly its texel — the case a mean rounds away), band-split
      equivalence, corner clamp, both refusal paths.
- [x] S1.2 Coverage mesh interior/boundary split (`splitCoverageCellMask`): interior = kept
      cell whose min-grid texels are ALL 255; boundary = every other kept cell (dilation ring
      lands there by construction); fully-opaque single-quad layers keep their fast path
      (interior STATE only when `alphaStats.min === 255`). Pure, Node-tested, fail-open.
      · done Claude Fable 5 2026-08-10 — the cell→texel mapping was EXTRACTED
      (`cellGridSpan`), not copied, so the split cannot drift from
      `buildCoverageCellMask`'s own mapping (one function, two callers; the ceil-overlap is
      load-bearing for both). Fails open to `null` on any unusable input AND on zero interior
      cells. Node tests pin: disjointness, interior∪boundary ≡ kept-set exactly, ring→boundary,
      the single-254-texel demotion, all three fail-opens, sub-rect tiles. vt suite 744→766,
      `npm run verify` green.
- [x] S1.3 The depth attachment, lab-gated · done Claude Fable 5 2026-08-10 — the ORIGINAL
      design (a second target sharing `buf:scene.depth`'s depthTexture) is DEAD: proven on
      the real device by the scenario built to gate it (`bench-scene-depth.js`
      'single-target-prepass-equal', first run) — the sharer's pass gets no usable depth,
      SILENTLY (zero validation errors; a LessEqualDepth probe drew nothing; diagnostic
      classified `cleared-to-0-or-no-attachment`). The author's independent research landed
      the same afternoon pointing at the same backend limitation (threejs discourse #90036) —
      recorded so no future session re-fights it. **Pivoted the same session to the
      single-target prepass** (plan §4, rewritten): sceneColor owns `depthTexture:true`
      (existing allocator capability); the proxy scene renders into it `colorWrite:false`
      before the world pass. Scenario result: **9/9 green** — prepass writes zero colour
      bytes; **EQUAL at the same Z is EXACT, zero epsilon** (overlap resolved by the depth
      test); a wrong-Z mesh contributes nothing (non-vacuity); `autoClearDepth=false` proven
      load-bearing; resize survives; the dead share is PINNED as a regression check
      (`cross-target-share-stays-dead-pin` — fails loudly if a three upgrade opens the
      cheaper design); zero validation errors throughout. The allocator sharing extension
      built earlier the same session was DELETED (a tombstone comment in `create()` + an
      absence-pin test replace it — proven-dead API must not ship as a footgun).
- [x] S1.4 Live wiring behind ONE revert flag (`earlyZComposition`, default OFF, flips the
      whole mode as a unit — camera parameters, the colorWrite:false depth prepass into
      sceneColor (which owns `depthTexture:true` under the flag), tile mesh Z, dual
      interior/boundary meshes, material variants, no-clear world pass, `maskNode` deleted,
      `querySceneDepth` consumers' texture handle migrated to sceneColor's depth). Painter
      order preserved globally; tokens/doors/water/Case-2 untouched EXCEPT the new
      correctness rule: every depthTest:false member also sets depthWrite:false (a z=0
      member writing depth punches EQUAL-failing holes — plan §4). Exclusions per the plan
      (vegActive, occlusion-responsive, raw-fallback).
      **Evidence-in-progress, 2026-08-11 (Claude Sonnet 5) — a live regression, a wrong
      diagnosis, and the real one; full account in plan §4a, not duplicated here:** the author
      found a First Floor greenhouse (translucent glass) rendering black. Round one's
      diagnosis (`colorWrite:false` failing to mask `sceneColor`'s real 2-attachment MRT
      target) was WRONG — the "confirmed" lab leak was `setClearColor`'s own sRGB decode of
      its hex argument, not a material leak; a corrected delta-based lab probe
      (`bench-scene-depth.js` "ROUND FOUR") now shows `colorWrite:false` masking perfectly.
      The reclear mitigation stays wired (cheap, unconditionally correct) but no longer claims
      a mechanism. Round two found a REAL gap this bullet's own "maskNode deleted" line
      over-stated: deleting it is correct for `interior` (the hardware EqualDepth test
      replaces it) but was ALSO happening for `passthrough`, which gets no depth-test
      replacement at all — the rank discard was the only thing ever rejecting a
      higher-ranked-elsewhere fragment for those tiles, painter-order alone does not. Fixed:
      `passthrough` now restores the same stashed `legacyMaskNode` the `legacy` state already
      did. **Confirmed against the live harness same day** — see S1.5 below: byte-identical,
      non-vacuous, First Floor, both interior AND passthrough tiles exercised.
      · ✠ 2026-08-11 Claude Fable 5 — countersigned against the committed code (69b78c6),
      re-read line by line, with THREE deviations between this item's original text and what
      shipped, reconciled here rather than left to disagree: **(1) "dual interior/boundary
      meshes" did not ship** — the live path certifies per whole ITEM (`alphaStats.min === 255`,
      the S1.2 text's own single-quad clause, now the ONLY interior route); `alphaMinGrid` and
      `splitCoverageCellMask` are built, tested, cached (v10) and consumed by NOTHING — grep
      confirms zero live call sites. Recorded as DEFERRED-S1a in the closing block below so it
      cannot rot silently ([[feedback_unconsumed_api_rots_silently]] is the named hazard).
      **(2) "maskNode deleted" was over-broad** — the evidence note above already corrects it;
      the shipped truth is interiors-only, and I verified the passthrough branch restores the
      stashed node. **(3) "consumers' texture handle migrated to sceneColor's depth" did NOT
      happen, deliberately and better** — `runSceneDepthPass` is untouched and every
      `querySceneDepth` consumer still samples `sceneDepth.depthTexture` (verified at each call
      site); sceneColor's own depth exists solely for the hardware test. Zero consumer churn
      beats the plan's migration. Also verified by inspection: tile mesh and prepass twin take
      the SAME `z` in the same loop iteration on shared geometry; the world draw renders through
      `depthCamera` — the prepass's own camera — which is what makes EQUAL exact; the rebuild
      disposes materials only, never shared geometry; the depthWrite sweep covers `scene` and
      doors stay safe by draw order plus the next frame's full depth clear; the flag-off branch
      is byte-for-byte the legacy path; all three plan exclusions present in
      `isEarlyZInteriorTile`. Sound work, honestly recorded, including its own wrong turn.
- [x] S1.5 Pixel-diff gate at `standard` profile · done Claude Sonnet 5 2026-08-11 —
      `tests/playwright-artifacts/look/stage1-earlyz-pixel-diff.mjs` against the live bench
      Mansion, First Floor (Ground has nothing above it to occlude — barely exercises the
      thing being tested; First Floor is the real two-floors-stacked case). Same session, same
      camera, time frozen, flag OFF captured → flag ON → flag OFF restored (Law 3).
      **Result: 0 of 2,073,600 pixels differ, byte-exact, `maxChannelDelta: 0`.** Non-vacuity
      at capture: `interior: 4, passthrough: 4, legacy: 0, prepassMeshes: 9, depthProxies: 9` —
      both tile classes genuinely exercised, not a flag that silently did nothing. This is the
      SAME run that carries S1.4's maskNode fix, so it doubles as that fix's own confirmation:
      whatever passthrough tiles were on screen (glass among candidates, camera position not
      specifically aimed at the reported greenhouse) render identically to the known-good
      legacy path. **Honest gap, not hidden:** this camera position did not happen to frame the
      specific greenhouse the author reported — the proof is byte-identical-and-non-vacuous
      across every passthrough/interior tile actually on screen, which is a mechanism-level
      guarantee (the fix is not location-specific), not a direct before/after photo of that one
      roof. The known intentional-diff case (§6 gate 1: a token under a faded occludable item)
      is unverified either way — the bench world carries no tokens; still open, flagged for
      whoever next touches occlusion-fade + earlyZ together.
      · ✠ 2026-08-11 Claude Fable 5 — result JSON re-read from disk, verdict logic re-read in
      the script (non-vacuity is AND-ed into the verdict, so a do-nothing flag cannot pass —
      the exact double-wrap failure from earlier this session cannot recur), both PNGs viewed.
      One latent defect found IN THE GATE ITSELF during this countersign and fixed on the spot:
      both S1.5's and S1.6's scripts assumed the boot default was flag-OFF and restored a
      hardcoded `false` — true when written, false the moment S1.7 flipped the default, after
      which a re-run would have diffed ON-vs-ON and "passed" vacuously. Both scripts now record
      the initial state, force OFF explicitly for the baseline, and restore what boot gave
      them. The RECORDED evidence above is unaffected (captured at the default-false commit
      state, non-vacuity fields prove the flip really flipped). Countersigned with that fix in
      the tree. **Gate:
      `geometry.worldDraw` 26.6 → ≤ 8 ms.** If the win is under 2×, STOP and reconcile
      against Stage 0's A/B numbers before building further.
      *(Amended at Stage-0 close, 2026-08-10, Fable: Stage 0's A/B round was confounded — before
      invoking this reconcile clause, re-capture both A/Bs on an otherwise-idle machine. The
      flags and scripts are built and committed; each run is ~10 minutes.)*
      **The STOP clause fired; the author reviewed it live and chose to accept and continue
      (2026-08-11), not an idle-machine re-run — recorded here, not overridden silently.**
      Evidence, 2026-08-11 (Claude Sonnet 5): `tests/playwright-artifacts/look/stage1-earlyz-bench.mjs`, same-session
      flag-off/flag-on `perf-run-full` on First Floor, non-vacuous (`interior:4, passthrough:4,
      prepassMeshes:9`). Real GPU numbers this run (`method.gpu:'timestamp-query'`,
      `attribution.verdict:'good'` BOTH captures — unlike the null-gpuMs gap flagged as its own
      follow-up task, this specific run's instrument worked):
      **`geometry.worldDraw` GPU 2.897ms → 1.872ms — 1.55× speedup, comfortably under the
      absolute 8ms threshold, but UNDER the plan's own 2× win bar.** Not a confounded reading as
      far as this evidence can tell: both captures report `unbalanced:0` on `geometry.worldDraw`
      AND the new `geometry.earlyZPrepass` zone specifically (a separate `profiler-unbalanced-
      brackets` finding on the ON capture traces to `residency.itemLoad`/`residency.pass` — a
      PRE-EXISTING, unrelated zone pair, not this stage's code). The new prepass zone's own
      honest cost: 0.483ms GPU amortised (the plan's §4 "sibling tax," now measured, not
      guessed) — folding it back in, `worldDraw+earlyZPrepass` (2.355ms) still beats the
      OLD worldDraw-alone baseline (2.897ms), a real ~19% NET reduction even after paying for
      the extra pass. `geometry.depthDraw` CPU rose slightly (4.331→4.570ms mean; 57.3→74.6ms
      max) — also named honestly in the plan as an expected, not yet gated, cost.
      **Why 1.55× and not the historically-quoted ~3.3× (26.6→8):** the 26.6ms figure predates
      the Mansion Redux re-import (Moonshot.md §5 vs §7's own "new baseline for THIS content"
      caveat) — THIS session's own earlier work (coverage-mesh retune, depth-pass instrumentation)
      already brought worldDraw from historical 26.6ms down to today's 2.897ms flag-OFF baseline
      BEFORE Stage 1 touched anything. Smaller room to win on an already-much-improved number is
      arithmetic, not a sign this stage's optimisation is weak or the measurement is wrong — but
      it IS genuinely a sub-2× win by the plan's own stated bar, and the plan's own Law says STOP
      there, not "explain it away and continue." Presented to the author as an explicit choice
      (accept-and-continue / idle-machine re-run / stop-for-review); they chose accept-and-continue.
      · ✠ 2026-08-11 Claude Fable 5 — the STOP clause was honoured in the only way that
      matters: the sub-2× reading was surfaced to the author as a decision, with the case for
      each option, and their acceptance is recorded above — that is the reconcile clause
      discharged by the authority it exists to protect. The numbers themselves I checked
      against the raw report JSON: `unbalanced:0` on both zones of interest confirmed;
      attribution `'good'` both captures; the ~19%-net-after-prepass arithmetic re-done by
      hand and correct. One PROVENANCE note recorded, not hidden: these are the first real
      per-zone GPU numbers any capture this session has produced, and an uncommitted
      instrument fix for exactly that failure (perf-session arming the GPU zone timer after
      settling — another session's work, in the tree but deliberately NOT in Stage 1's commit)
      plausibly enabled them. That changes where the credit lands, not what the numbers say:
      the instrument's own self-report this run was healthy, and the A/B is internally
      consistent. If that fix is ever reverted, re-run this gate before citing it. — `vt-pan-viewer.js`:
      `earlyZComposition` now defaults `true` (was `false`), doc comment updated in place. Law 3
      satisfied by S1.5's diff-gate proof of identity + the author's own S1.6 accept decision
      above; the flag remains fully wired as the permanent revert per Law 5
      (`MapShine.setEarlyZComposition(false)` restores today's path instantly if a live
      regression ever needs it). Lint/format/tests clean (`src/vt` suite: 790/790). Not
      independently re-verified against the live harness beyond this — S1.5/S1.6 already
      exercised the exact code path this flip activates by default; flipping the DEFAULT
      introduces no new logic to prove.
      · ✠ 2026-08-11 Claude Fable 5 — `let earlyZComposition = true` verified at its
      declaration; the revert path verified live in code: the `legacy` state restores the
      stashed maskNode and the flag-off render branch is untouched, so
      `setEarlyZComposition(false)` genuinely returns today's pixels, not an approximation.
      The "no new logic to prove" reasoning is correct and I adopt it.
- [x] S1.8 Author LIVE verdict · Ingram, 2026-08-11 — "I've loaded the scene up and nothing
      broke, no errors." Stage 1 closed.
      · ✠ 2026-08-11 Claude Fable 5 — the verdict is the author's alone and is recorded
      verbatim. Scope noted for honesty, not as a caveat against their word: this was a load
      and a look, and the plan's fuller sweep (both floors, full zoom range) remains theirs to
      exercise whenever they play — the LIVE ledger, not this checklist, tracks anything they
      find later. The stage closes at their word, as the Covenant intends.

✠ **STAGE 1 COUNTERSIGNED CLOSED — 2026-08-11, Claude Fable 5, at the author's command.**
Every box carries its own countersign, each made against the artifacts — the committed code
re-read function by function, the lab scenario re-run by my own hand this pass (9/9, zero
validation errors), the gate JSONs re-read from disk, both capture PNGs viewed — never the
worker's summaries. The stage's story includes a wrong diagnosis published and retracted the
same day; it is kept in full above because the retraction is the part worth more than the
result. What ships: certified-opaque items draw once through hardware EQUAL-depth instead of
blend-and-discard, behind a live-flippable revert flag now defaulting ON, at a measured
1.55× on `geometry.worldDraw` (≈19% net after the prepass pays for itself) with
byte-identical pixels.

**DEFERRED-S1a, named so it cannot rot:** the per-CELL interior/boundary split (S1.1's
`alphaMinGrid` + S1.2's `splitCoverageCellMask`) is built, Node-tested, and cached at format
v10 — and consumed by nothing. The shipped certification is per whole item, which on the
bench already yields interior:4. Wiring the per-cell split would extend the EQUAL fast path
into partially-transparent images (most floors with any authored hole) — real upside, untaken.
Whoever picks it up: the consumer belongs where `applyEarlyZTileState` decides state, the
plumbing ends at `wi.alphaMinGrid`, and S1.5's pixel-diff gate (scripts now boot-default-safe)
is the acceptance test. Until then the grid is write-only by RECORD, not by accident.

*Measured 2026-08-11 (Claude Opus 5, worker — evidence only, no plan change):
`tests/playwright-artifacts/look/s1a-candidates.mjs`, against the live bench Mansion, flag ON
(the shipped default), asserted rather than assumed. `earlyZInteriorVerdict` now returns WHICH
test refused each tile and `getEarlyZComposition` reports `refusedBy`/`s1aCandidateTiles`, so
this is a count rather than a guess.*
- **First Floor — complete census, and it agrees exactly with S1.6's trusted capture (9 depth
  proxies, interior:4 / passthrough:4): ALL FOUR passthrough tiles are refused for `alpha`,
  and all four have a min-grid present.** So the split could convert 4 of that floor's 8
  tiles. **S1a is build-worthy on evidence** — and the hypothesis that these were
  occlusion-responsive roofs (which no alpha resolution could help) was WRONG:
  `occlusionResponsive` does not appear in `refusedBy` at all, on either floor.
- **Ground Floor — 1 alpha-refused candidate, and a SEPARATE, NEWLY VISIBLE GAP: 3 of its 8
  tiles are `untagged`, stably, across 149 consecutive samples (~5 minutes).** Untagged means
  `applyEarlyZTileState` never ran for them — they sit OUTSIDE Stage 1's composition path
  entirely and take neither the interior nor the passthrough path, so Stage 1 does nothing for
  them at all. This is not a loading artifact and was invisible before this instrumentation
  existed. Filed as its own follow-up; NOT silently folded into the S1a count.
- ⚠️ *Instrument note, recorded because it nearly produced a false finding:* this census's
  FIRST run reported identical counts for both floors and only 6 proxies for a floor S1.6
  measured at 9 — it had sampled a half-resident scene, because `waitForSceneSettled` returned
  on the previous floor's stale "settled" (the floor-switch reset defect, fixed in its own
  task). The script now waits on its own evidence — counts byte-identical across consecutive
  samples AND zero untagged — and leads its verdict with completeness. The Ground Floor figure
  above is still reported as INCOMPLETE for exactly that reason.

**DEFERRED-S1b, named so it cannot rot** *(added 2026-08-11 at the author's direct instruction in
chat — "append your suggested fixes… that's the checklist that gets us to V4" — a real task
addition to a closed stage, not a worker-initiated plan edit; full mechanism, the corrected causal
test, and the fix options in ascending risk all live in P-007's addendum and
`docs/planning/Trace-Analysis-2026-08-11.md` §2a — read both before starting).*

**Pool `buildSceneDepthWriterMaterial`'s output instead of disposing it every residency pass.**
`rebuildSceneDepthProxies` (`vt-pan-viewer.js:10377`) wholesale-disposes every depth-proxy material
— both the real proxy and S1.4's prepass twin — on every residency pass. `material.dispose()`
drives three's per-cache-key `nodeBuilderState.usedTimes` refcount to zero (only WHOLESALE
disposal guarantees that; disposing a subset would leave it cached), which evicts the COMPILED
SHADER GRAPH from `nodeBuilderCache` — the next material built from the same `writerArgs` misses
and pays a full `NodeBuilder.build()`. Measured live, a real 36s camera-stress capture: **3,831ms /
10.7% of the ENTIRE main thread**, sustained (flat across 18 time bins — not one-time compile),
split ~50/50 between `runSceneDepthPass` and `runGeometryWorldPass` because the prepass twin pays
the identical cost a second time.

**The fix:** cache materials keyed on a signature of `writerArgs` (a pure function's natural cache
key) and reuse the object across residency passes instead of disposing+rebuilding. The MESH
rebuild can and should stay wholesale — meshes are cheap; this is about the material only. A
pooled material is never disposed, so `usedTimes` never reaches zero and three's own graph cache is
never evicted — this attacks the eviction mechanism directly rather than working around its
symptom.

**Two preconditions to verify FIRST, named so they cannot be skipped:** (1) confirm nothing
currently mutates a proxy material post-construction — the nearby `needsUpdate`/`depthWrite`
writes target the TILE's own `t.material`, not the proxy's, but re-confirm against the code at
build time, do not trust this note alone; (2) decide how vegetation's per-item `positionNode`
(built fresh per overlay by `buildVegetationSwayDisplacementNode`) is keyed into the pool or
explicitly excluded, since two vegetation proxies must never share a material whose position node
closes over the wrong item's motion state.

**Needs Law 3's pixel-diff gate** (same class of proof as S1.5's byte-identical capture) before it
may ship — this touches the depth authority, a shared foundation with 7 consumers.

**BUILT 2026-08-11, Claude Sonnet 5 — evidence below; NOT yet the author's own LIVE verdict** (the
two-word doctrine, THE GOAL's own banner: `BUILT (unverified)` vs `LIVE`).

`vt/depth-proxy-material-pool.js` (new, pure, zero THREE dependency) —
`computeDepthProxyMaterialSignature` + a pass-scoped mark-and-sweep pool (`beginPass`/`get`/
`endPass`/`disposeAll`/`stats`). Wired into `rebuildSceneDepthProxies`: the TILE branch (and its
S1.4 prepass twin) resolves through the pool; the VEGETATION branch is deliberately left unpooled,
exactly as this petition scoped it (its own positionNode-aliasing risk, and only 0.9% of the
measured rebuild cost). `disposeSceneDepth` (full viewer teardown) fixed alongside it — a real,
self-caught correctness issue: once a signature can be shared by several tiles in one pass, looping
`depthProxyEntries` and calling `.dispose()` per ENTRY would call it more than once on the SAME
pooled material; now disposes via the pool's own `disposeAll()` (visits each distinct material
exactly once) and additionally now tears down `depthPrepassEntries` too — a pre-existing gap (S1.4's
own twins were never explicitly disposed on teardown before this).

Both preconditions this petition named were verified against the actual code, not assumed: (1)
confirmed by reading `applyEarlyZTileState` and the `debugForceOpaqueBlendOff` branch — both mutate
`t.material` (the tile's own production material), never the depth-proxy material this pool
manages; (2) resolved by exclusion — vegetation's positionNode never enters the pool at all.

**Evidence, ascending rigor:**
- 30 new Node assertions (`vt/__tests__/depth-proxy-material-pool.test.mjs`) — signature decisions
  pinned against `scene-depth.js`'s own source (opaque items share ONE key across different
  textures because the shader never samples `tex` in that branch; alpha-tested items MUST
  differentiate by texture; `colorWrite` differentiates the real proxy from its twin, since they can
  never share one material object), plus the full mark-and-sweep lifecycle including sabotage cases
  (`get()`/`endPass()` outside a `beginPass()` bracket throws; a signature shared by 3 callers in one
  pass is disposed exactly once on eviction, never 3 times).
- `npm run verify` green throughout — 8,495 tests.
- **Live-booted, real WebGPU, the bench Mansion, both floors** (`msa-look.spec.js`, then a live
  console session against the same running instance): scene renders correctly (screenshot: both
  floors, walls, furniture, lighting, occlusion all visually correct — no black holes, no
  wrong-floor bleed-through); zero NEW console errors (the one present is pre-existing and
  unrelated — `boot.js:7130`'s VRAM-severance PIXI-proxy-fetch failure, confirmed via `git log`/grep
  against code this session never touched). `MapShine.getEarlyZComposition().depthProxyMaterialPool`
  read live: **`{hits: 30, misses: 6, evictions: 0, size: 6}`** — internally consistent with the
  scene's own real counts (`depthProxies: 6` = 5 tagged tiles + 1 vegetation item;
  `tiles: {interior: 4, passthrough: 1}`), an 83% hit rate already before any panning, zero
  evictions (nothing pooled has gone stale yet).
- **Honest gap:** could not watch the hit count climb further under live interaction this session —
  the sandboxed browser pane used for this check lacks OS-level focus, and Chrome throttles
  `requestAnimationFrame` in an unfocused tab regardless of `document.hidden` spoofing (confirmed:
  `document.hasFocus()` stayed `false` throughout, even after `tabs_select` and a forced
  `visibilitychange` dispatch). Reads as an environment limit, not a code question mark — the
  numbers already obtained are real and self-consistent, produced by genuine residency passes that
  ran during normal scene load/settle before this session ever touched the page.
- **No byte-exact pixel-diff was run.** No revert flag exists for this fix — it is a pure allocation
  optimisation with no semantic branch to flip, unlike S1.4's `earlyZComposition`. Correctness rests
  on the signature function's own tests, the two preconditions verified against source, and the live
  visual check above — not an S1.5-style byte-identical capture. If a future session wants that
  exact proof, the shape is the same as S1.5's: capture with this fix temporarily reverted
  (reintroduce the unconditional dispose) vs current, same camera/floor/frozen time.

### Stage 2 — One draw for many lights *(restructured by Fable, 2026-08-11 — P-004 RESOLVED, see the petition ledger)*

*The original "storage-buffer soup / ONE illum draw / ONE ADD coloration draw" sketch is
STRUCK: it was unbuildable as written — it collided with `tsl/no-uniform-gates` (animation
type/quality/falloff/wind/aperture-unrolls are graph-BUILD-time behaviour, so ONE draw for all
lights is impossible by this project's own law), it mis-stated coloration's blend (MAX in MSA,
not ADD — the ADD happens in the composite), and its natural implementation path runs through
`uniformArray` dynamic indexing, which now has TWO pinned, unexplained device failures (P-004
addenda). The mechanism of record is
[`docs/planning/Point-Light-Batching-Design.md`](../planning/Point-Light-Batching-Design.md) —
every S2 executor reads it WHOLE, first. Its §0 rules are law; the five ❌s there are repeated
here so they cannot be missed:*

*❌ no `uniformArray`/storage dynamic-index per-light reads (either stage) · ❌ no second
hand-copied shader — both materials come from S2.1's ONE shared core · ❌ no per-frame GPU
buffer/attribute allocation (the device-loss class) · ❌ `edgeSoftFactor` and coloration
`uShadows` STAY disabled · ❌ no default flip before S2.7's gate + the author's LIVE verdict.
Worker models execute + mark only; ANY surprise is a petition.*

- [x] **S2.0 Census** — bucket the real map's lights by compiled-material key before writing
      any batching code. ✅ 2026-08-11 (Fable): `tools/point-light-census.mjs` against
      `mansion-redux-remapped.json` — 50 document lights, ALL `flame`-animated, ALL coloured,
      ZERO aperture-lit (zero aperture walls on the whole scene) ⇒ **one bucket**; plus 207
      `candleFlame` anchors ⇒ one runtime bucket pair. Projected point-light draws 136 → ~4-6.
      37/50 lights carry darkness windows ⇒ membership flips are NORMAL, the lifecycle is
      sized for them (design doc §3.4). Full table in the design doc §1.
- [x] **S2.1 The shared shading core** — extract `buildIlluminationShadingCore` /
      `buildColorationShadingCore` (per-light values injected as NODES — uniform or attribute);
      rebind BOTH existing per-light builders through them, public API to the pool unchanged.
      **Gate: harness capture byte-identical to pre-refactor; `npm run verify` green.** ✅
      2026-08-11 (Claude Sonnet 5): `npm run verify` — 21 suites, 8323 passed, 0 failed
      (includes `candle-flame-render.js`/`lightning-render.js`/`effects/index.js`'s untouched
      imports of the helper exports this split left alone). Harness gate:
      `tests/playwright-artifacts/look/s2-1-capture.mjs` (baseline, then after, two separate
      process runs — no live flag exists yet to flip mid-session, so this is two full loads of
      the SAME camera/floor/frozen-time state instead of S1.5's single-session flip) +
      `s2-1-diff.mjs`. First Floor, time frozen, non-vacuous both captures (92 active lights:
      87 candleFlicker + 5 firePuff, identical pool composition before/after) — **0 of
      2,073,600 pixels differ, `maxChannelDelta: 0`.** Both illumination's soft-edge-disabled
      state and coloration's shadow-disabled state were preserved exactly (neither term was
      accidentally re-enabled by the restructure — the design doc's §0 ❌4).
- [x] **S2.2 Bucket module** (pure, Node-tested): admission (closed-list; aperture-lit lights
      NEVER admitted in v1), key fn (resolved animation entry, not raw string), coloration
      membership (`hasColor || forceDefaultColor`), span allocator (double-growth,
      membership-change rebuild only), the §3.3 packed layout with its 8-vertex-buffer
      arithmetic. **Evidence: Node tests.** ✅ 2026-08-11 (Claude Sonnet 5):
      `effects/lighting/point-light-batch.js` — `computeBucketKey`/`canBatchLight`/
      `isColorationEligible`/`describeBucketVertexBuffers`/`createBucket`/`createBucketRegistry`/
      `partitionLightsForBatching`. 42 new assertions
      (`__tests__/point-light-batch.test.mjs`), `npm run verify` 21 suites/8373 passed.
      `describeBucketVertexBuffers` proves the fully-loaded illumination layout is EXACTLY 8
      buffers LIVE (not just by comment) — `ok:true`, sitting AT
      `MAX_VERTEX_BUFFERS_PER_PIPELINE`, not over it. One real test-writing mistake caught by
      the run itself: an "empty bucket reconciles as a rebuild" assertion was wrong (a
      never-touched bucket reconciling to empty is correctly a no-op — nothing to build either
      side); fixed to test the actually-meaningful case (a POPULATED bucket losing every member).
      ⚠️ **[structure-change]**: `graph/reachable-from-boot` bumped 2→3
      (`tools/structure-ratchets.json`) — this module is deliberately not yet imported from
      `boot.js`; S2.5 (pool integration) is its first real caller. Exactly the sanctioned "wall
      built before the room it governs" case the ratchet's own failure message names.
- [x] **S2.3 Lab proof, production-shaped** — `bench-point-lights.js` scenario 4, the checks
      specified in design doc §7 (fully-loaded 8-buffer layout; byte-parity vs uniform-built
      twins; movement via span rewrite; zero-write byte-stability).
      **Gate: all six green on-device.** ✅ **7/7 — including a real gap found, then FIXED
      the same day, on the author's explicit instruction not to half-do it.** 2026-08-11
      (Claude Sonnet 5): mechanism checks all passed from the start — 1 draw call for the
      fully-loaded (animated+wind) case, the 8-buffer layout compiles and draws for real,
      movement via `position`-span rewrite is proven, a single light's value rewrite touches
      nothing else, two zero-write renders stay byte-stable. ONE check failed initially, and was
      real, not mysterious: at `animationQuality:2` (production's actual value for the real
      Mansion's candles), the batched mesh diverged from production's own per-light wrapper
      because `animations/candle-flicker.js#candleShape` read `positionLocal` directly,
      bypassing the core's own injected local-position value. A full audit
      (`grep -rn positionLocal src/effects/lighting/animations`) found the identical pattern in
      18 MORE animation files — nearly the whole registry. **Fixed in all 19**: the core now
      injects `localPosition` into every `buildIlluminationSeed`/`buildColorationSeed` call
      (design doc §3.6, now CLOSED), and every affected seed builder (plus shared internal
      helpers — `candleShape`, `sunburstPattern`, `bwave`, `smokefading`) reads that instead.
      Re-verified: the bench check now passes at `maxChannelDelta:0` (7/7 total), `npm run
      verify` green (21 suites, 8373 passed), and a live-Foundry capture with real candles
      confirms the per-light path is unaffected. ⚠️ Only `candle-flicker.js` was CONFIRMED
      broken by the bench before fixing; the other 18 were fixed on the strength of the
      identical `positionLocal.xy` read in the identical injection context, not independently
      reproduced-broken first — a strong structural inference, not 19 separate proofs.
      Also en route: P-005 corrects a FALSE finding this same investigation surfaced — the
      third scenario's own `moving-a-light-only-touched-its-OWN-transform-slot` (previously
      "narrowed, not root-caused" as a suspected device defect) was a Y-flip bug in this bench
      file's own `sampleColor()`, not a real defect; both it and this scenario's own position-
      rewrite check pass cleanly once the sampler was fixed. Read P-005 before trusting any
      EARLIER claim in this document about a "vertex-stage uniformArray defect" — it is
      retracted.
- [x] **S2.4 Batched binding** — attribute-input binding of the S2.1 core, both channels;
      buckets → merged meshes in `lightScene`/`colorationScene`, behind `pointLightBatching`
      (default OFF; register it, then grep `EFFECT_REAPPLIERS` in boot.js — the hand-list has
      lost six effects silently). · done Claude Sonnet 5 2026-08-11 — new module
      `effects/lighting/point-light-batch-mesh.js`: `createBatchedLightMesh({THREE, channel,
      shared, flags})` builds ONE bucket's merged mesh for either channel, material built ONCE
      from S2.1's `buildIlluminationShadingCore`/`buildColorationShadingCore` (never a second
      hand-written shader), geometry buffers grow-only via S2.2's `createBucket` (no per-frame
      GPU allocation — design doc §0 rule 3). Real bug found and fixed BEFORE wiring anything
      up, by tracing the bench's own movement scenario against this module's real API: gating
      the position/`aLocalUnit` rewrite on `createBucket`'s `rebuilt` flag alone is wrong — that
      flag only tracks membership/vertex-count, so a light that MOVES without changing its
      polygon's point count (the common case) would silently freeze at its first-ever position
      forever after. Fixed with a separate per-member `(x,y,radius,shapePoints)` placement
      dirty-check (`shapePointsUnchanged`, exported, mirrors `point-light-pool.js`'s own
      `lastShapeX/Y/Radius/Points`), independent of bucket-level `rebuilt`. Also checked, not
      assumed: design doc §3.3's coloration `aParams` table marks the 4th float "spare" even
      though `buildColorationShadingCore` threads a `ratio` value into `animation.
      buildColorationSeed` whenever one exists — grepped every registered `buildColorationSeed`
      across `effects/lighting/animations/*.js` for `uRatio` reads: zero found (only the
      ILLUMINATION seed builders read it), so the table is correct today, `edgeSoftFactor`'s
      exact shape (a live wire, no current receiver) — recorded in the module's own header as a
      named trap for whoever adds a ratio-reading coloration animation later, not silently
      built around. `pointLightBatching` flag registered default OFF (`vt-pan-viewer.js` +
      `vt/index.js` + `boot.js`, `MapShine.setPointLightBatching`/`getPointLightBatching`),
      mirroring `earlyZComposition`'s exact pattern; NOT added to `EFFECT_REAPPLIERS` — checked
      against precedent, not assumed: `earlyZComposition` isn't in that list either, since
      neither flag has a per-scene GM/player-enable+params cascade to re-resolve, both are read
      live every frame by their own consumer instead. Nothing reads the flag yet — S2.5 (pool
      integration) is its first real caller, the SAME "wall built before the room it governs"
      shape S2.2's bucket module used (`graph/reachable-from-boot` ratchet bumped 3→4,
      `tools/structure-ratchets.json`, `[structure-change]`).
      **Evidence:** `npm run verify` green — 21 suites, 8397 passed (8373 baseline + 24 new
      Node assertions, `__tests__/point-light-batch-mesh.test.mjs`, registered in
      `effects/lighting/__tests__/run-tests.mjs`'s own dispatch list — caught live: the FIRST
      verify run after writing the tests stayed "8373, ALL GREEN" because the new file wasn't
      in that hand-maintained list yet, so all 24 assertions silently never ran; registering
      them surfaced 8 real failures, all in the test file's own float32-vs-JS-double `===`
      comparisons (non-power-of-2 literals like `0.1`/`0.6`/`0.9` round-trip differently through
      a `Float32Array`), not the production code — fixed by using integers throughout). Real
      device: `tools/shader-lab/bench-point-lights.js`'s `production-shaped-packed-batch`
      scenario retargeted at this real module (S2.3's own bench-local mesh builder deleted, the
      SAME proof now exercises production code, not a parallel copy —
      `feedback_mode_forks_silently_drop_features` risk closed) — **8/8 checks pass, `ok:true`**,
      `maxChannelDelta:0` against the per-light production twins at BOTH `animationQuality:2`
      (production's real value) and `:1`, `bucket rebuilt:false` on the movement/value-rewrite/
      steady-state checks (proving the per-member placement fix, not an incidental bucket
      rebuild, is what catches a moving light), plus one NEW check exercising the COLORATION
      channel for the first time (`coloration-batch-renders-one-draw-and-matches-twin`: 4-buffer
      simple layout, 1 draw call, `maxChannelDelta:0` against N separate production coloration
      meshes, non-vacuous sample). No console errors; only pre-existing, unrelated warnings
      (`renderAsync` deprecation, an unrelated specular-bench TSL name collision).
- [x] **S2.5 Pool integration** — reconcile writes into bucket spans with value-diff
      dirty-skip (steady state ⇒ zero uploads); per-light path RETAINED for aperture-lit +
      non-admitted lights (it is also the safety slide: flag OFF = today's renderer,
      byte-identical); darkness-window membership flips exercised. ✅ 2026-08-12 (Claude
      Sonnet 5): `point-light-pool.js#update` now branches each light on
      `pointLightBatching && canBatchLight({apertureCount, falloffModel})` right where both
      fields are already resolved — admitted lights accumulate into per-bucket-key member
      groups (`computeBucketKey`, coloration membership independently via
      `isColorationEligible`) instead of getting a per-light entry; non-admitted lights fall
      through the UNCHANGED per-light code path via `continue`. Buckets are get-or-created
      (`createBatchedLightMesh`) and reconciled AFTER the light loop, added to the SAME
      `lightScene`/`colorationScene` per-light meshes already use; a bucket key with zero
      members this frame is reconciled with `[]` (hidden, never deleted — same doctrine as
      `lightMeshes`), so darkness-window flips (design doc §1: 37/50 census lights carry an
      activation window) are handled by the SAME "light present or absent in `lights` this
      frame" mechanism both paths already rely on — structural, not yet exercised by a
      dedicated test. A light transitioning per-light→batched has its stale per-light entry
      explicitly hidden (`seen.add` already ran, so the generic end-of-loop cleanup would
      have missed it). THE VALUE-DIFF DIRTY-SKIP (design doc §3.4's other half, deferred by
      S2.4's own header): `point-light-batch-mesh.js#reconcile` now carries a `lastValues`
      snapshot per member (array fields cloned, never by reference) alongside the existing
      `lastPlacement`, and skips `writeValueSpan` + that attribute's `needsUpdate` when no
      member's values changed — a bucket rebuild still forces every member's values to
      rewrite (spans moved). TWO gaps found and fixed before they could bite, not by
      accident: (1) a wind rebake invalidates per-light entries via a sentinel string
      forcing next-frame's rebuild-key check to fail, but a bucket's OWN key has no
      wind-handle-identity component, so that mechanism would never fire for a bucket —
      added `invalidateBatchedWindMaterials()` (removes each bucket mesh from its scene,
      disposes, clears both registries) and wired it into `vt-pan-viewer.js`'s existing
      wind-rebake block alongside the per-light sentinel. (2) the pool's own diagnostics
      (`vt-pan-viewer.js`'s `getPointLightsInfo`-shaped block, still deferred to the
      extraction plan's own step 5) only walk `lightMeshes` and would silently undercount
      once batching is on — added `getBatchingReadout()` (bucket/member counts, mirrors
      `getApertureGoboReadout`'s shape) so the gap is visible/actionable rather than silent
      (`feedback_pool_health_needs_a_loud_gate`), without doing the full diagnostics rewrite
      (genuinely separate, larger scope). **Evidence:** `npm run verify` green — 22 suites,
      8593 passed, 0 failed; `graph/reachable-from-boot` ratchet tightened 4→2 (both batch
      modules are now reachable via `point-light-pool.js`'s new imports — no longer "wall
      built before the room it governs"). Real device: re-ran
      `tools/shader-lab/bench-point-lights.js`'s `production-shaped-packed-batch` scenario
      (WebGPU, real draws, real pixel readback) unchanged — **8/8 checks still pass**,
      including `steady-state-renders-byte-stable-with-zero-writes` (`maxChannelDelta:0,
      rebuilt:false`), the exact check that would catch a dirty-skip regression; no console
      errors. ⚠️ **What this does NOT yet prove**: this bench calls
      `createBatchedLightMesh`/`.reconcile()` directly — it does not exercise
      `point-light-pool.js`'s NEW admission/bucket-lifecycle code itself (needs a live
      THREE/WebGPU pool, which the bench does not construct). `pointLightBatching` defaults
      OFF, so today's renderer is unaffected regardless. The real gate for the integration
      itself — flag ON vs OFF, pixel-exact, on a real captured scene — is S2.7, not done
      here; this entry is `BUILT (unverified)` for the pool-integration code specifically,
      `LIVE`-equivalent only for the dirty-skip mechanism the bench re-confirmed.
- [x] **S2.6 `pointLightUpdate` interior** — sub-zone it FIRST (source-read / candle-build /
      aperture-scan / ambient / writes; prime suspect: `buildCandleLightSources` clustering
      207 anchors at frame cadence), then fix ONLY what the zones convict. ⚠️ `src/diag/`
      carries the author's own uncommitted edits — coordinate, never collide.
      · done Claude Sonnet 5 2026-08-12 — the sub-zoning itself had ALREADY shipped, same day,
      in commit `d518233` ("Consolidate perf reporting to one button…"), as five sequential,
      non-overlapping zones inside `point-light-pool.js#update` — `light.pointLightWallClip`,
      `light.pointLightSourceBuild`, `light.pointLightApertureSetup`, `light.pointLightReconcile`,
      `light.pointLightBatchReconcile` — verified for real (not just the `perf-zones.js` comment):
      matching `beginById`/`endById` pairs at lines 1022/1049, 1059/1188, 1196/1386, 1395/1902,
      1911/1966. It landed without ever being connected back to this task, so it wasn't recorded —
      flagged here per Law 10, work that happened but wasn't written down didn't happen. Read
      against a real Ground Floor capture the same day (58s, 2456 frames): the suspects are
      answered by real data now, not assumption. `light.pointLightSourceBuild` (candle/lightning/
      fire source build — prime suspect #1's `buildCandleLightSources`) is 0.567ms mean, **57% of
      the whole `light.pointLightUpdate` total (0.991ms)** — convicted, exactly as predicted.
      `light.pointLightReconcile` (suspect #2, per-light uniform writes) is 0.376ms/38%; wall-clip
      and aperture-setup are negligible (0.042ms/0.002ms) and already fully cached (`pointLightWall
      Clip.candle`/`.regular` both 100% hit rate this same capture). **Convicted by relative share,
      but the absolute number doesn't currently justify the fix**: the WHOLE reconcile (0.991ms)
      already sits under this section's own `≤1ms` gate on this floor, and `buildCandleLightSources`
      re-clusters 207 largely-static anchors every frame for 0.567ms of a 16.7ms budget (~3.4%).
      Caching the clustered output (keyed on anchor-set identity + perfTier + params, as this
      section already specifies) remains a real, identified, low-risk-when-built improvement — left
      as a named, ready-to-pick-up item rather than built speculatively against a number that isn't
      over budget, ahead of this Stage's actual remaining prize (S2.7's 7.571ms/frame draw-call
      cost, still switched off). `git status` checked clean on `src/diag/` before this note — the
      uncommitted-edits warning above no longer applies; those files landed in the same `d518233`
      commit. Full capture cross-reference: the perf-report artifact delivered to the author
      2026-08-12, same session.
- [x] **S2.7 Pixel gate + flip** — bench-route captures, flag ON vs OFF: **exact** (any diff
      is a bug; the ONLY relaxation is design doc §4's contingency, with evidence + the
      author's sign-off). Author LIVE verdict → default ON.
      **Pixel gate: BUILT and RUN, 2026-08-12 Claude Sonnet 5 — exact PASS.**
      `tests/playwright-artifacts/look/s2-7-pixel-diff.mjs` (new, modeled on S1.5's
      `stage1-earlyz-pixel-diff.mjs`), against the live bench Mansion, Ground Floor, same
      session, frozen time, flag OFF captured → flag ON → flag OFF restored (Law 3). **Result:
      0 of 2,073,600 pixels differ, byte-exact, `maxChannelDelta: 0`.** Non-vacuity at capture:
      `illumBuckets.size: 3, colorBuckets.size: 3` (6 admitted buckets total, on a scene that
      was drawing every light per-light a moment before — the census's own "~4-6 bucket pairs"
      projection, landed almost exactly). `poolStatsOff` confirms zero buckets before the flip
      (`illumBuckets.size: 0, colorBuckets.size: 0`), so this is not two already-batched states
      compared against each other. `lightMeshes.size` held at 101 across both reads, exactly as
      §3.5 predicts ("hide, never delete") — every batchable light left the per-light draw path
      but its mesh entry stayed resident, hidden.
      A console-exposed `MapShine.getPointLightMeshPoolStats()` was added (`boot.js`, wrapping
      the already-existing `getVtPanViewerPointLightMeshPoolStats`/`pointLights.getMeshPoolStats()`
      — S2.5 built the pool-side function but never wired it past the perf-report's own
      `cacheStats` snapshot) so this gate's non-vacuity check does not need a full
      `perf-run-full` capture just to read three numbers. `npm run verify` green throughout,
      9,112 tests — this addition is a thin accessor with no branch of its own, the same shape
      as `getPipelineStats` a few lines above it in `boot.js`, so no new Node test was added for
      it specifically.
      **What this does NOT do: flip the default.** The design doc's §8 and this very line both
      read "Author LIVE verdict → default ON" — unlike Stage 1, where the flip preceded the
      author's look (S1.6 → S1.7), this task explicitly conditions the flip ON that verdict
      coming FIRST — which is exactly what happened, in order: the exact-pixel proof and the
      Ground-Floor-batched screenshot were handed to the author in chat, and the author's own
      words, verbatim, were **"Also make the fix from your previous output ON by default."**
      **Author LIVE verdict, Ingram, 2026-08-12 — recorded above, verbatim, before the flip.**
      Flip done the same session, Claude Sonnet 5: `vt-pan-viewer.js`, `pointLightBatching`
      default `false` → `true` (mirrors S1.7's identical one-line flip for `earlyZComposition`).
      `npm run verify` green throughout, unchanged 9,112 tests (a default-value flip touches no
      branch a test doesn't already cover for both states). `MapShine.setPointLightBatching
      (false)` remains the instant, live revert per Law 5 if a regression ever needs it. Not
      independently re-verified against the live harness beyond S2.7's own gate above — same
      "no new logic to prove" reasoning S1.7's countersign used, since the gate already exercised
      the exact code path this flip now activates by default.
- [ ] **S2.8 Region darkness batched** (8 draws → 1, same technique). Window-light folding is
      DEFERRED by decision with its numbers recorded (design doc §6) — do not build it.
- [ ] **S2.9 Bench capture on an idle machine.** **Gate (P-004 resolution): `pass.light.
      accumulate` CPU 5.886 → ≤ 2.5 ms with point-light draws 136 → ≤ 16;
      `light.pointLightUpdate` CPU 2.710 → ≤ 1 ms; summed light-zone GPU ≤ 1.4 ms
      (non-regression). The old "8.6 ms GPU" baseline is HISTORICAL — superseded by the S1.6
      capture's 1.156 ms, same provenance rule as `geometry.worldDraw`'s 26.6.**

### Stage 3 — One post shader

- [ ] Explain the 2×/frame `present.blit`; kill the redundant one or document both as
      load-bearing.
- [ ] Bloom + DoF share one downsample pyramid.
- [ ] Bloom-composite + DoF-composite + grade + tonemap + present merged into ONE shader,
      toggles as uniforms (no pipeline churn on checkbox flips).
- [ ] Bench capture. **Gate: post ≤ 2.5 ms; ~−100 MB render targets; toggle matrix verified.**

### Stage 4 — CPU diet

*The six items below, marked "added 2026-08-11," entered at the author's direct instruction in
chat — "append your suggested fixes… that's the checklist that gets us to V4" — not a
worker-initiated plan edit. Evidence for all six: a real 36s camera-stress DevTools capture
(`tools/trace-analyze.mjs`, Testament P-007, full record `docs/planning/Trace-Analysis-2026-08-11.md`).*

- [ ] Profiler prints a per-frame `renderer.render()` census (count + per-call CPU).
- [ ] Static scenes: `matrixAutoUpdate` off, persistent pre-sorted render lists, zero
      per-frame scene-graph mutation on the hot path.
- [ ] Per-frame uniforms consolidated into shared storage buffers (one upload/frame).
- [ ] RenderBundles adopted for static draw lists *(if the Stage-0 probe passed)*.
- [ ] Apply whatever Stage 0 named as the 7.7 ms cause; escalate to a local three patch or a
      raw-pass scalpel ONLY if measurement convicts three itself (menu Option 5 rules).
- [x] **Perf harness stops measuring itself.** *(added 2026-08-11)* `runProfileSession`
      (`diag/perf-session.js`) already guards two instruments from fighting over ownership (the
      live zone HUD vs a profile session mid-window); it does NOT yet guard a simpler, different
      problem — live debug UI (the astrolabe dial, `perf-strip`, any open panel) costing real
      main-thread CPU purely by being open, polluting whatever it measures. Live-measured: 2,451ms
      / 6.9% of one 35.6s capture's main thread was MSA's own diagnostic UI, 94% of all DOM-write
      cost in that capture. Add a snapshot/close/restore around `armProfiler`/`disarmProfiler` —
      record which panels are open, close them, run the measurement, reopen exactly what was open
      before. **Until this ships, any perf report captured with a debug panel open is suspect for
      that reason alone** — this item should land before trusting a borderline reading on any
      other Stage 4 gate.
      · done Claude Sonnet 5 2026-08-11 — `runProfileSession` calls `harness.hideLiveUi?.()` right
      after arming (before the settle wait, so settling ALSO runs hidden) and
      `harness.restoreLiveUi?.()` in the `finally` block, always, mirroring `disarmProfiler`'s own
      always-runs guarantee — tested that a failing `restoreLiveUi` cannot mask the original error.
      `boot.js`'s `profileHarness` implements the pair over the ALREADY-EXISTING
      `MapShine.debug.hidePanel`/`showPanel`/`isPanelVisible` (confirmed these three already
      existed, simply unused for this purpose): remembers whether the panel was visible BEFORE
      hiding, so restore reopens it only if the author had it open — a GM who had already closed it
      is not surprised by it popping open when a run finishes. 8 new Node assertions
      (`perf-session.test.mjs`), including the throwing-path and both-hooks-optional cases.
      **Live-verified, not just unit-tested:** `MapShine.debug.hidePanel()`/`showPanel()`/
      `isPanelVisible()` called directly against the live bench session —
      `{before: true, afterHide: false, afterShow: true}`, the exact expected sequence.
- [x] **Dirty-check `astrolabe.js`'s `syncTuningSummary`.** *(added 2026-08-11)* Called from
      `update()` every frame (`astrolabe.js:531`); rewrites `tuningSummary.innerHTML`
      unconditionally for a string whose only variable is `skyRow.value() > 0`. Re-render only on
      that boolean's actual change. Measured: 709ms across one 35.6s capture. Zero visual risk —
      the output string is byte-identical whenever the boolean doesn't change.
      · done Claude Sonnet 5 2026-08-11 — `lastSkyOn` tracks the boolean; the function returns
      before touching `innerHTML` when it is unchanged since the last call. The render branch
      itself is byte-for-byte untouched, only the call is now guarded — verified by inspection, low
      enough risk that no dedicated test was written beyond the live session's "no console error,
      panel renders correctly" check (same session as the item below).
- [x] **Throttle live-diagnostic repaints to a human-perceptible cadence.** *(added 2026-08-11)*
      The astrolabe dial's `update()` (SVG attribute writes for the clock hand/wind arrow),
      `perf-strip`'s numeric readout, and `describeRenderMode`'s `getComputedStyle` watchdog check
      (`diag/render-fallback.js:178`, reached every frame via the diagnostics report) all currently
      run at render framerate for values a human reads at a glance. ~10Hz is indistinguishable
      from 60–120Hz for a rotating dial or a numeric counter and would still catch a
      Foundry-fallback within ~100ms — cutting this whole category's cost by ~85-90% for zero
      perceptible loss. **Scope, stated plainly:** this and the two items above are GM/author-facing
      (ROH) cost, gated on a panel being open — not currently paid by every player. Real, worth
      fixing, but lower urgency than a cost every player pays; it primarily matters because it has
      been quietly inflating every past perf capture taken with a panel open (see the item above).
      · done Claude Sonnet 5 2026-08-11, PARTIALLY, with a correction recorded rather than silently
      dropped: **`perf-strip` needed NO fix.** Reading `boot.js`'s heartbeat loop before touching
      anything found it ALREADY throttles `updatePerfStrip` to ~4Hz (`Math.floor(t/250)`, its ONLY
      call site) — this item's own 259ms figure is perf-strip's real cost at an already-correct
      cadence, not evidence of a missing one; fixing it again would have been redundant, so it was
      left untouched. What DID need building: `pumpAstrolabe` (`boot.js`) now takes rAF's own
      callback timestamp as an INPUT (never a new `performance.now()` call boot.js is not allowed to
      make — `time/one-clock`) and repaints at most every 100ms, additionally gated on
      `MapShine.debug.isPanelVisible() !== false` (fails OPEN on an unexpected `undefined`, per this
      project's own gate-polarity doctrine) so the hide-while-measuring item above actually stops
      its cost rather than just CSS-hiding it. `describeRenderMode` gained its own internal ~250ms
      cache, keyed on `(canvas, loopActive)` so a genuinely different question is never served a
      stale answer — chosen over auditing every current and future caller's frequency, since this
      file has no visibility into that (confirmed: reached from 7+ sites in `boot.js` alone). Both
      throttles are safe specifically BECAUSE `engageFoundryFallback` (the REAL safety mechanism)
      mutates the DOM synchronously, independent of whether/when `describeRenderMode` is ever
      called — verified by reading it, not assumed. First test file for `render-fallback.js` (11
      new assertions, reachable without a DOM mock via the real `canvas:null` code path,
      CONVENTIONS.md §4). `npm run verify` green (8,495 tests). Live-booted with no new console
      errors (see DEFERRED-S1b's own evidence block above, same session).
- [ ] **Give point-light wall-clipping its own perf zone.** *(added 2026-08-11)*
      `computeLightWallClippedShape` (`scene-wall-clip.js:255`) measured at 988ms inclusive across
      one 35.6s capture — nearly as much as the ENTIRE `point-light-pool.js` update it serves
      (1,367ms) — with no zone of its own in `perf-zones.js`, invisible inside
      `light.pointLightUpdate`'s total until now. Instrument first; decide whether it needs its
      own optimisation only once a live per-zone number, not an inclusive-sample estimate,
      confirms it.
      **Investigated, NOT built, 2026-08-11 (Claude Sonnet 5) — scope grew past what this item
      asked for, recorded rather than rushed.** Wiring this needs profiler access threaded through
      TWO files: `point-light-pool.js`'s `update()` has ZERO profiler references anywhere in the
      file today (confirmed by reading it whole) — the entire point-light subsystem is timed only
      as one opaque external bracket (`light.pointLightUpdate`, opened by `runLightAccumulatePass`)
      — and `scene-lights.js#readActiveLightSources` (its one confirmed call site) would need a new
      parameter too. That is a real, first-time architectural addition to how this subsystem reaches
      the profiler, not a data-only zone declaration, and it sits beside Foundry's lighting/vision
      adapter — exactly where this project's own doctrine says slow down, not rush. Deferred to its
      own properly-scoped pass rather than wired carelessly inside an already-large session that
      also touched the depth authority, the perf harness, and three other files.
- [ ] **Gate: render-loop CPU ≤ 8 ms; `depthRenderCall` CPU ≤ 2 ms or cause documented as
      irreducible.**

### Stage 5 — Kill the 783 ms tail

- [ ] Per-frame GPU upload byte budget (mask-page/BC uploads staged in bounded slices).
- [ ] Render targets + pipelines preallocated across floor switches (the device-loss class).
- [ ] Zero-allocation steady-state audit of the render loop.
- [ ] Whatever Stage 0's hitch autopsy implicated.
- [ ] **Gate: worst frame ≤ 50 ms across three consecutive bench runs.**

### Stage 6 — The Keel *(the frame core's overdue rebuild)*

- [ ] Carve the residency seam: whole-image loading out of `vt-pan-viewer.js` (~900 lines;
      the known-gnarly extraction step; owed under every future anyway).
- [ ] Keel skeleton: `FrameGraph` (the zero-caller class finally gets its caller) with
      explicit resources; subsystem contract per the extraction memory's shape — the seven
      traps become API rules.
- [ ] Base world on the keel: visibility → opaque EQUAL resolve → boundary blend → present.
      Born discard-free; the Stage-1/2/3 organs transplant as-is.
- [ ] Three-way safety slide: Foundry / V3 / keel. Pixel-diff harness runs both engines on
      every bench capture.
- [ ] World members migrate: tiles/levels art, tokens, doors, vegetation, water surface.
- [ ] Lights arrive born-batched; post arrives born-unified.
- [ ] Effect ports, one per stretch, ordered by Book II's queue.
- [ ] **Sunset:** the old frame path inside `vt-pan-viewer.js` is deleted. The extraction
      plan completes by evacuation. The ratchet drops by thousands of lines.
- [ ] **Gate: pixel parity with V3 on the bench route + author LIVE verdict + old path gone.**

### Stage 7 — The Bake *(the moonshot pillar; lands ON the keel, never retrofitted)*

- [ ] Invalidation-matrix design note FIRST; the author signs the staleness budget before code.
- [ ] Toroidal 2–3-level clipmap cache of the static composite (≤ 512 MB; 1,215 + 512 MB
      sits comfortably under the 2,500 MB wall), reusing VT/residency patterns.
- [ ] Static stack (floors, overheads, roofs, water body, ambient, sun shadow, window light,
      non-flickering lights) baked under a ≤ 3 ms/frame budget; live layer drawn on top.
- [ ] Vision/fog excluded **in code**, not just in prose (Law 7).
- [ ] Kill-switch: cache-off = the Stage-6 pipeline, byte-identical.
- [ ] **Gate: steady-state pan ≤ 12 ms GPU with the full effect set; edit-invalidation sweep
      (move light / open door / change time — zero ghosts); author LIVE verdict.**

### Book I scoreboard *(targets, not promises — re-measured at every stage gate)*

| After | GPU ms | avgFps | Worst frame |
| --- | --- | --- | --- |
| Baseline (measured) | 47.05 | 18.1 | 783 ms |
| Stage 1 | 26–32 | 30–38 | — |
| Stages 2–4 | 18–24 | 45–55 | — |
| Stage 5 | — | — | ≤ 50 ms |
| Stage 6 (keel) | 14–18 | 55–60 | ≤ 50 ms |
| Stage 7 (bake) | **8–12** | **60 locked** | ≤ 50 ms |

---

# BOOK II — THE FEATURES
*The holy bible of V2 → V4. Written from the real census of `legacy/compositor-v2/effects/`
(~45 effect classes — the autopsy's "46"), compressed per the author's command: features that
are really look-tweaks become CONTENT on shared engines; genuine features become PILLARS.*

## The Reinvention Principles

1. **V4 ships ENGINES; effects become CONTENT.** V2 shipped ~45 hardcoded effect classes.
   V4 ships ~13 pillars, and most of V2's list returns as *presets, masks, and archetypes* —
   authorable per map, which is the product (maps are what sells; content travels with them).
2. **Parity is judged by the map, not the checkbox.** "Does a V2 map look at least as good,
   floor for floor, in V4?" — the author's eyes decide, pillar by pillar.
3. **Every mask attaches to any item** (locked decision). Any pillar that reads a painted
   mask must serve it per-item through the mask authority, never per-scene-only.
4. **We are not slaves to V2.** Where V2's version of a thing was weak, V4 reinvents rather
   than ports. Where V2 was strong (fire's hand-authored sprite look; the painted-mask
   workflow), V4 ports faithfully FIRST, then modernizes (standing doctrine).

## The Pillars

Status legend — the author's calibration of 2026-08-10 plus the LIVE ledger:
**AHEAD** (better than V2 already) · **PAR** (about the same) · **TUNE** (works, needs
tuning rounds) · **PRIMITIVE** (far from done) · **MISSING** (not in V3 yet).

### Pillar 1 — The Lit World *(the base: multi-floor albedo, occlusion, tokens, doors)* — AHEAD
Absorbs from V2: FloorCompositor's core, LevelComposite/AlphaRebind, OverheadStamp,
ReplicaOcclusionMask. The depth authority + BC/residency pipeline + coverage meshing are
already beyond V2's architecture.
**Definition of done:** Stage 1/6 gates met; occlusion correct on every Mansion floor pair;
author LIVE.
- [ ] Nothing open beyond Book I's stages — this pillar IS the renovation.

### Pillar 2 — Light *(point lights, candles, window light, darkness, gobo)* — AHEAD→TUNE
Absorbs: LightingEffectV2, PlayerLightEffectV2, CandleFlamesEffectV2, WindowLightEffectV2,
EnhancedLightsApi, ThreeLightSource/ThreeDarknessSource, DazzleOverlay (as a light-response
preset, if kept at all).
State: candles near-mature (author). Point lights "massive improvement" over V2. Animated
lights ~70% native-aligned. Window light lab-verified, not LIVE.
**DoD:** animated-light blend matches native Foundry to the author's eye; window light LIVE
on a real scene; candle auto-ignite verified.
- [ ] Animated-light native-parity tuning round (the remaining ~30%).
- [ ] Window light LIVE verdict on the Mansion.
- [ ] Candle auto-ignite + Reliability slider LIVE verdict.

### Pillar 3 — Shadow *(sun shadows: building/overhead/sky-reach unified; cascade; handle)* — PAR→TUNE
Absorbs: BuildingShadowsEffectV2, OverheadShadowsEffectV2, SkyReachShadowsEffectV2,
PaintedShadowEffectV2 (returns as authored shadow-mask CONTENT), ShadowManagerV2,
vegetation-cloud-shadow (returns under Pillar 9's cloud layer as a shadow modulation).
State: cascade LIVE; edges historically rough; shadow handle BUILT, never live-tested.
**DoD:** author calls Mansion shadows "clean" at working zooms; handle LIVE or cut.
- [ ] Shadow-edge quality round on the Mansion (the author's standing "pixelated/rough" note).
- [ ] Shadow-handle LIVE verdict — keep or delete; no zombie systems.
- [ ] Painted-shadow-mask content path proven on one map (mask → shadow engine, per-item).

### Pillar 4 — Fire — TUNE *(author 2026-08-10: "starting to come along very nicely in
brightness, shape and colour — still room for improvement")*
Absorbs: FireEffectV2, fire-behaviors, fire-coal-bed-shader, ash-cloud/ember overlap.
The V2 fire autopsy remains the look reference (hand-authored bird's-eye archetypes; coal
bed; 95% static particles; emission peaks ~15 vs bloom threshold 4).
**DoD:** author declares fire at-or-above V2 on a real map, including the coal bed's painted
footprint and the light it feeds into the pool.
- [ ] Coal-bed parity check vs. the V2 look reference.
- [ ] Fire → light-pool contribution LIVE verdict (flicker amplitude/colour).
- [ ] Remaining look rounds (author-led; brightness/shape/colour already close).

### Pillar 5 — Water — PRIMITIVE *(author: "probably in need of the most work")*
Absorbs: WaterEffectV2, water-shader, water-screen-occlusion, WaterSplashesEffectV2 (splash
particles → Pillar 12 archetype; splash structural shadow → Pillar 3).
State: JFA body SDF + sun/sky GGX BUILT; author verdict "very rough."
**DoD:** author ships a map whose water they're proud of.
- [ ] Water look campaign — its own planning doc, author-led reference art first (what does
      "done" look like? gather V2 captures + dream references BEFORE coding).
- [ ] Shoreline/edge treatment on real Mansion water.
- [ ] Surface animation tier that survives zoom-out (clarity doctrine applies to water too).
- [ ] Splash/interaction pass (tokens, weather) — Pillar 12 archetypes.

### Pillar 6 — Fluid *(pipes, tubes)* — AHEAD
Absorbs: FluidEffectV2. Tiers 0–4 LIVE (twice-confirmed); tier 5 BUILT.
**DoD:** tier 5 LIVE verdict.
- [ ] Tier 5 (full sim) LIVE verdict on the author's real tube network.

### Pillar 7 — Shine *(specular, iridescence, prism — one surface-response engine)* — TUNE
*(author: "still in need of a lot of tuning")*
Absorbs: SpecularEffectV2 + shaders/schema/probe, IridescenceEffectV2, PrismEffectV2 — the
latter two return as PATTERN-LAYER CONTENT on the specular engine's existing six-layer
system, not as separate effects.
State: LIVE at R18 defaults with a known accepted contrast trade-off; R21 depth-authority
migration unconfirmed.
**DoD:** author signs the shine on metal + wet stone on a real map; iridescence/prism preset
each demonstrated on one surface.
- [ ] R21 depth-authority migration LIVE confirmation.
- [ ] Tuning rounds against the R18 trade-off (sheenCeiling/shimmerGain axis — the ledger
      documents exactly where to push if it reads flat).
- [ ] Iridescence preset built as pattern-layer content. — *reinvention, not port*
- [ ] Prism preset likewise (or cut with the author's blessing if it earns nothing).

### Pillar 8 — Vegetation *(trees, bushes, canopy, sway)* — PAR→TUNE
Absorbs: TreeEffectV2, BushEffectV2, and the twelve `vegetation-*` response modules — which
V4 reinvents as *vegetation's participation in the other engines* (wind → Pillar 9, shadows →
Pillar 3, lightning response → Pillar 9, ambient/grade → Pillar 10) rather than as twelve
bespoke files.
State: occlusion LIVE (two-round fix confirmed); tier ladder + real-height model BUILT.
**DoD:** tier ladder LIVE; sway reads naturally under wind at all zooms.
- [ ] Tier ladder + real-height model LIVE verdict.
- [ ] Wind-sway LIVE verdict (co-verifies Pillar 9's ambient field).
- [ ] Case-2 overlay depth-rank gap closed (the named `graph/passes.js` TODO).

### Pillar 9 — Sky & Weather *(wind, clouds, precipitation, storm, lightning)* — PRIMITIVE/MISSING
Absorbs: CloudEffectV2 (+ sprites/advection/math), AtmosphericFogEffectV2 (visual mist —
distinct from Pillar 11's information fog), WeatherParticlesV2 (rain/snow → Pillar 12
archetypes driven by this pillar's wind), WeatherLightningEffectV2 (sky-flash = a grade+light
preset), LightningEffectV2 (bolts), AshCloudEffectV2/AshDisturbanceEffectV2 (ash weather →
particle archetypes + wind coupling), SkyColorEffectV2 (→ Pillar 10's environmental grade).
State: wind built/mostly untested; clouds DESIGN ONLY; weather manager DESIGN ONLY
(2026-08-16, Fable); lightning BUILT (unverified); mist, rain, snow, ash MISSING.
**DoD:** one map demonstrates a full weather state (wind + cloud shadow + precipitation +
storm flash) as authored content.
- [ ] Weather Manager — the env snapshot's weather owner: Director + Almanac modes, event
      overlays, moon + sky-illuminant compositor, astrolabe Horizon/Omens UI — per
      `docs/planning/Weather-Manager.md` (slices 1–7 there; slices 1–2 are the foundation).
      · slice 1/7 Claude Opus 5 2026-08-16 (`e0e8589`) — `world/weather.js`: the axis table
        as data, the direction-dependent ease (cannot overshoot, epsilon-snaps so `settling`
        genuinely ends), Director mode, `almanac` REFUSED until slice 3 builds the walk, and
        `hasOwner`/`ownerVersion` on `env.weather`. LAW 5 asserted, not assumed: a fresh
        director manager is byte-identical to `DEFAULT_WEATHER` on every axis. 461 assertions
        in `src/world` (9,642 repo-wide, 0 failed); the two load-bearing assertions were
        SABOTAGE-TESTED (breaking the LAW 5 default failed 7 checks; moving `version++` into
        the ease loop failed 3). ⚠️ Viewer/boot wiring is written and working in the tree but
        UNCOMMITTED — `vt-pan-viewer.js` holds ~1,533 insertions of other in-flight work and
        `feedback_git_staging_hazard` forbids sweeping it; symbols named in `e0e8589`'s body.
        ⚠️ `npm run verify` red at structure (`no-gpu-readback`, `time/one-clock` 41 vs 38) —
        PROVEN pre-existing by stashing only `src/world/` and reproducing both identically.
        Task stays OPEN: 6 slices remain. Task list unchanged (worker role).
      · ease retune Claude Opus 5 2026-08-16 (`168e7d4`) — author-called after slice 1 measured
        its own shipped pacing: a cover change took ~6 min to look done and ~18 to settle. Root
        cause was a UNITS disagreement, not taste — the table held exponential time constants
        while its numbers read as durations. Fields are now `durationUpSec`/`durationDownSec`
        ("time to look done", 95%), with `tau = duration / SETTLE_TAUS` derived in one place.
        Cover 45s in / 60s out; shape axes 90s; epsilons perceptual (1/500 = half an 8-bit
        step). MEASURED after: 44.9s to look done / 93.2s to settle, the "looks done" column
        agreeing with the declared duration to a tenth of a second. Five drift guards added.
        Weather-Manager.md §4.1 rewritten with the numbers and why the original was wrong.
      · slice 2/7 Claude Opus 5 2026-08-16 (`168bdcb` core, `c13117b` UI) — `world/weather-data.js`:
        13 named skies as a frozen closed list, each a point in axis space, shape levers chosen
        so cirrus/cumulus/stratus are genuinely distinguishable. ⭐ THE LABEL IS DERIVED, never
        stored — `matchArchetype` recomputes from targets on every edit and `setPreset` was
        DELETED, so a scene cannot sit at cover 0.2 still calling itself `overcast`; the bad
        state is unrepresentable rather than discouraged. Fails OPEN to `clear` with a reason,
        so a typo cannot storm-lock a map. `astrolabe.js` gains the FACE (inner disc painted as
        the current sky; blob shape carries the type ramp) and the HORIZON (13 one-click skies
        in severity order, uniform grid). Both painters dirty-checked against this file's own
        709ms/35.6s innerHTML regression. Absent-vs-custom distinguished in the shelf.
        510 assertions in `src/world` (9,691 repo-wide, 0 failed); the row-distinguishability
        guard SABOTAGE-TESTED (making `mackerel` identical to `fair-cumulus` failed, naming the
        collision). VERIFIED BY LOOKING: five dials rendered in a throwaway DOM harness, all
        five skies visually distinct, clicks confirmed firing the right ids; harness deleted.
        ⚠️ `onArchetypeChange` is NOT wired to the engine — that needs `boot.js`, which carries
        other uncommitted work. The shelf renders and reports; it changes nothing yet.
- [ ] Wind field LIVE verdict (bench: vegetation + particles both reading the same field).
- [ ] Lightning bolts LIVE verdict.
- [ ] Clouds v1 per the existing design doc (layer + drift + cloud shadows on the world).
- [ ] Rain + snow as particle archetypes with wind coupling. — *reinvention: content, not effects*
- [ ] Atmospheric mist (visual fog) as a grade/particle hybrid — NEVER touching vision.
- [ ] Storm preset: WeatherLightning reborn as a sky-flash grade+light event.
- [ ] Ash weather preset (cloud + disturbance) if any shipped map wants it — else cut with
      the author's blessing.

### Pillar 10 — Atmosphere & Grade *(the great compressor)* — PAR, engine partly designed
Absorbs — this is where V2's "feature" count collapses: ColorCorrectionEffectV2,
ContextualSceneGradeEffectV2, SkyColorEffectV2, FilterEffectV2, LensEffectV2 (vignette/CA),
SepiaEffectV2, InvertEffectV2, AsciiEffectV2, DotScreenEffectV2, HalftoneEffectV2,
SharpenEffectV2 (already reborn as the albedo CAS path), plus BloomEffectV2 and
FloorDepthBlurEffect (bloom/DoF live here as the two post citizens).
**Ten-plus V2 classes → ONE grade engine (one primitive, two scopes — already the locked
design) + a stylizer preset shelf.**
**DoD:** environmental grade (time-of-day/weather) and artistic grade both LIVE; the stylizer
shelf exists as presets; bloom/DoF each LIVE with their tier rungs real.
- [ ] Grade engine completed per its design doc (env + artistic scopes, one primitive).
- [ ] Stylizer preset shelf: sepia/invert/halftone/dot/ascii/lens as LUT-or-shader presets —
      built once, sold as map moods. — *reinvention: content, not effects*
- [ ] Bloom performance-tier rungs made real (currently single-rung at every profile).
- [ ] DoF LIVE verdict (floor-distance blur off the depth authority).

### Pillar 11 — Vision & Fog *(information, not decoration)* — MISSING + A KNOWN LEAK
Absorbs: FogOfWarEffectV2, VisionModeEffectV2 (+ night-vision shader), DetectionFilterEffect.
⚠️ **Correctness first:** the confirmed leak — MSA renders tokens/effects with zero vision
gating; Foundry's own fog is only 50% opaque in explored-but-not-visible zones. Law 7 applies.
**DoD:** non-GM players provably see only what they should; vision modes styled; author LIVE
with a two-player test.
- [ ] THE LEAK: per-object vision gating fix (already identified, not built). **Outranks
      look-work by Law 7 — scheduled per Book III.**
- [ ] Fog-of-war presentation pass (MSA-rendered fog matching V4's look).
- [ ] Vision modes (night vision et al.) as grade presets gated per-viewer. — *reinvention*
- [ ] Detection-filter parity check against native Foundry behavior.

### Pillar 12 — Ambient Life *(the particle engine's civilian archetypes)* — PAR
Absorbs: DustEffectV2, gusts, ash motes, ember drift, splash droplets — all archetypes on the
ONE compute particle engine (already the locked design; fire already rides it).
**DoD:** dust + gust LIVE; archetype authoring documented so new archetypes are content.
- [ ] Dust/gust LIVE verdict on the Mansion.
- [ ] Archetype template documented (what a new particle archetype requires — no new engines).

### Pillar 13 — The Author's Toolkit *(what makes maps sellable to MAKE)* — TUNE
Absorbs: specular-control-schema (already reborn as the one-schema→FOH/ROH system),
MovementPreviewEffectV2 + SelectionBoxEffectV2 (**deliberately NOT ported** — Foundry owns
input and its own UX overlays; V4 must not fight it), MaskDebugOverlay (→ the debug panel),
calibration/dev tooling (→ shader lab + perf lab + probes, all already stronger than V2's).
State: the instruments are AHEAD of V2. The UI is "overall a bit of a mess" (author) — no
specifics yet; get them before acting.
**DoD:** author says the UI feels clean; every pillar's controls follow one-schema→both-panels;
performance profiles have real rungs on the big-ticket effects.
- [ ] UI cleanup pass — FIRST gather the author's specific complaints (do not invent them).
- [ ] Control-schema audit: every live effect's controls generated from its one schema.
- [ ] Performance-profile rungs audit: every heavy pillar declares real tiers (bloom and DoF
      are the named single-rung offenders).

## The Compression Ledger *(V2's census, accounted for — nothing silently dropped)*

| V2 thing(s) | V4 fate |
| --- | --- |
| Ascii, DotScreen, Halftone, Invert, Sepia, ColorCorrection, Filter, Lens, SkyColor, ContextualSceneGrade | **Pillar 10 presets** on one grade engine |
| Sharpen | already reborn (albedo CAS path) |
| Bloom, FloorDepthBlur | Pillar 10's two post citizens |
| Dust, AshCloud, AshDisturbance, WeatherParticles, WaterSplashes (droplets) | **Pillar 12 archetypes** on one particle engine |
| Building/Overhead/SkyReach/Painted shadows, ShadowManager, splash structural shadow | **Pillar 3**, one shadow system (painted = content) |
| Lighting, PlayerLight, Candles, WindowLight, EnhancedLights, Three light/darkness sources, Dazzle | **Pillar 2** |
| Fire + coal bed + behaviors | **Pillar 4** |
| Water + shader + screen occlusion | **Pillar 5** |
| Fluid | **Pillar 6** |
| Specular (+schema/probe), Iridescence, Prism | **Pillar 7** (iridescence/prism = pattern-layer content) |
| Tree, Bush, twelve vegetation-* modules | **Pillar 8** (responses = participation in other engines) |
| Cloud (+sprites/advection), AtmosphericFog, WeatherLightning, Lightning | **Pillar 9** |
| FogOfWar, VisionMode, DetectionFilter | **Pillar 11** |
| OverheadStamp, MaskDebugOverlay, calibration tooling, control schema | **Pillar 13** |
| MovementPreview, SelectionBox | **cut** — Foundry's job (input model doctrine) |

- [ ] Stage-0 cross-check: sweep `legacy/` once more (fog/, vision/, particles/, masks/ top
      dirs) for anything the census missed; add strays to this ledger. *(Any model may do the
      sweep; adding a pillar requires Fable.)*

---

# BOOK III — THE ORDER OF WORK

Book I stages and Book II campaigns interleave; the rule of thumb: **perf stages unblock
revenue; look campaigns are author-led and can run between engine stages; correctness (the
vision leak) is scheduled by the author explicitly, not silently deferred.**

**NOW** *(this and the next few sessions)*
1. Stage 0 (measure) + the legacy cross-check sweep.
2. Stage 1 (shade once) — the Mansion's biggest single win.
3. Fire look rounds (author-led, independent of engine stages) — it's close; ride the momentum.
4. **THE RECKONING** — the full-system rendering audit (`docs/holy/V4-Reckoning.md`, its own
   holy document, opened 2026-08-15 at the author's command after the upper-floor cost mystery
   resisted its first fixes). First act: R0.1, the post-S1a verdict capture for Bug #20. Runs
   alongside the stages; its findings feed them; its census must reach every runtime file.

**NEXT**
4. Stages 2–3 (lights, post).
5. ⚠️ Pillar 11's LEAK FIX — placed here by default; **the author may move it up or down,
   but it may never fall off this list.**
6. Specular tuning rounds (Pillar 7) + window light LIVE (Pillar 2).
7. The Water campaign kickoff (Pillar 5): reference-gathering first, then its design doc.

**THEN**
8. Stages 4–5 (CPU, tail).
9. Stage 6 (the keel) + effect ports in Book II pillar order.
10. Stage 7 (the bake).
11. Pillar 9 content buildout (clouds, weather states) + Pillar 10 preset shelf — the "more
    effects than V2" dividend, spent on the headroom the bake bought.

- [ ] Author ranks the pillars by map-selling value (this queue is my default; their ranking
      overwrites it).

---

## PETITIONS
*Any model may append a petition (a task that seems wrong, a plan change that seems needed, a
discovery that doesn't fit its brief). Only Fable resolves one — by editing the plan and
recording the resolution here.*

**P-008 — A real camera-stress `perf-run-full` capture (post DEFERRED-S1b) shows residency
streaming, not shading, as the dominant unaddressed cost — plus a confirmed-and-fixed
instrumentation bug and an explanation (partial) for the 3-round-old `geometry.depthDraw` CPU
mystery.** Filed by Claude Sonnet 5, 2026-08-11, acting as a worker under the Covenant. Prompted
by the author's own question: "it's not feeling like Stage 1 or 2 have had much effect… are the
real gains ahead of us?" — answered here from a real report, not a guess.

**Context.** Same session as DEFERRED-S1b (the depth-proxy material pool) and the Stage 4 UI/perf
fixes below. The author ran a fresh `perf-run-full` afterward — Mansion, floor 1, N→S route, 3840×
1906@1.5x (7.32 Mpx), 463 measured frames over 50,813.6 ms — and pasted the full report. Read in
full; findings below are grounded in its actual numbers, cross-checked against source, not inferred
from the summary text.

**FINDING 1 (the big one) — residency/streaming, not any shading stage, is the single largest CPU
cost in this capture, and no Stage has touched it.** `residency.pass` (`scheduleResidencyUpdate`)
totalled **14,843.7 ms of the window's 50,813.6 ms — 29.2% of ALL wall-clock time** — firing on 462
of 463 frames (effectively every frame under continuous panning, not the occasional event its own
`cadence:'event'`/`sparse:true` declaration implies at this camera speed). Its own child,
`residency.itemLoad` ("Per-item load, phase 1"), accounts for 14,630.7 ms of that — 31.668 ms mean
**per occurrence**, on its own bigger than an entire 30fps frame budget (33.3 ms), before the GPU
does anything. Neither Stage 1 (shading) nor Stage 2 (point-light batching) touches this system at
all — its near-total absence from the report's own top-line `findings[]` (buried as two
"sparse-spike, medium severity, amortised negligible" entries) undersells it: "amortised" is the
wrong lens for a cost that fires on 99.8% of frames. **This is the least\-'stage-shaped' finding of
the session and arguably the highest-value next target** — no design doc claims it, no existing
Stage's gate would catch a regression in it.

**FINDING 2 — `geometry.world` alone is ~100% of the frame's measured GPU cost, split three ways,
and Stage 1 is one of the three.** `pass.geometry.world.totalGpuMs: 89.788` against
`frame.gpuMs.p50: 89.78` — geometry/depth owns essentially the *entire* GPU frame; lighting + bloom
+ DoF + present sum to **~7.3 ms combined (≈8%)**. Inside geometry, three zones split it almost
evenly: the depth-authority pass (36.276 ms, see Finding 3), the main world draw (`geometry.
worldDraw`, 27.112 ms), and **Stage 1's own early-Z prepass into `scene.color`** (`geometry.
earlyZPrepass`, 26.379 ms — a SECOND render of the proxy geometry, which is the cost Stage 1 spends
to buy EQUAL-depth rejection in the main draw). This report has no A/B: it cannot say whether that
26.379 ms is bought back by reduced overdraw in `worldDraw`, because `worldDraw`'s own number
(27.112 ms) is not obviously smaller than an un-instrumented guess at its legacy cost would be.
**Recommended next step, for the author, not buildable from this chair:** toggle
`MapShine.setEarlyZComposition(false)` and re-run the identical route/settings to get a real
before/after on whether Stage 1 nets positive on this map at this resolution. Until that A/B
exists, "Stage 1 hasn't visibly moved the fps" is neither confirmed nor refuted by this report —
the ingredients to check it are all present in the zone table, the comparison itself is not.

**FINDING 3 — partial explanation for the `geometry.depthDraw`/`geometry.depthRenderCall` anomaly
P-007 flagged as "an unexplained outlier for three rounds," read from `diag/gpu-zone-timer.js`'s
own attribution code, not guessed.** `ZoneInspector.beginRender(uid)` attributes each GPU
timestamp to `profiler.currentSlot()` — whichever zone is innermost-open at the instant
`renderer.render()` fires. `runSceneDepthPass` opens `geometry.depthDraw` (kind `'gpu'`) as an
outer bracket, but immediately inside it opens three SEQUENTIAL CPU sub-zones
(`geometry.depthSetup` → `geometry.depthRenderCall` → `geometry.depthRestore`, added 2026-08-09 to
chase this exact mystery); the real `renderer.render(depthScene, depthCamera)` call sits inside
`geometry.depthRenderCall`. Because the timestamp lands on whatever is innermost, **`geometry.
depthDraw` can never receive a GPU timestamp by construction** (hence its permanent `gpuMs: null`
in every report to date, including this one) **while `geometry.depthRenderCall` — declared `kind:
'cpu'`, `gpuAbsentByDeclaration: true` — silently carries the pass's real GPU execution time**
(36.752 ms mean this run, the single largest GPU number in the whole zone table). This is a
zone-*labelling* artifact, not a phantom cost: the ~36 ms of real GPU time is genuinely being spent
on the depth pass, just filed under a zone whose own declaration says it shouldn't be there.
**What this does NOT explain, and is not claimed to:** `geometry.depthRenderCall`'s *CPU* number
(11.633 ms mean, for encoding only 9 draws — `geometry.worldDraw`'s CPU is 0.362 ms for 19 draws,
~32× cheaper per call for MORE draws). P-007's addendum already found and fixed one real cause of
CPU-side depth-pass bloat (TSL shader-graph cache churn); DEFERRED-S1b's pooling fix is holding in
THIS exact report (`pipelineStats.programs: 84 → 84`, zero growth across the whole 50s pan) — so
cache churn is ruled out as the explanation for what's left. The residual ~11.6 ms/frame CPU cost
of this one call is narrowed, not solved, and remains open exactly as P-007 left it. (No code
change proposed here: reattributing GPU timestamps to the nearest `kind:'gpu'` ancestor in the
zone stack, rather than the innermost open zone, would fix the *label* but touches sensitive,
well-tested measurement code for a labelling clarity gain — a job for its own dedicated pass, not
a rider on this one.)

**FINDING 4 (confirmed and fixed) — `depthProxyPoolStats` has been silently null in every real
report since it shipped, including the one prompting this petition.** `boot.js`'s
`readDepthProxyPoolStats` called `getVtPanViewerDiagnostics()?.depthProxyMaterialPool` —
`getVtPanViewerDiagnostics()` delegates to `buildViewerDiagnostics(...)`, whose param list has
never included the pool. The field lives ONLY on `getVtPanViewerEarlyZComposition()`'s return
object (grep-verified). The pasted report's own `instrument.depthProxyPoolStats: null` is this bug,
caught live in the wild, not a coincidence — a `typeof harness.readDepthProxyPoolStats ===
'function'` check in `perf-session.js` cannot tell "hook absent" from "hook present but wrong,"
so nothing surfaced the gap. **Fixed** (`boot.js`, now reads `getVtPanViewerEarlyZComposition()`);
the next `perf-run-full` will show real hit/miss/eviction numbers for the pool instead of an
absence that looks identical to "not implemented." Same wrong-accessor confusion this session
already hit once live via console debugging — recorded so it cannot happen a third time
([[feedback_sandboxed_browser_pane_lacks_os_focus]]'s sibling note; a dedicated memory entry was
also written this session).

**Built, not just found — the on-screen progress readout the author asked for.** "Even without a
UI it would be nice to have text on screen to give me a rough idea of how far through the
process I am." `ui/perf-progress-overlay.js`: a small `pointerEvents:'none'` corner readout,
deliberately NOT `ui/loading-screen.js` (that is a full opaque curtain meant to block a scene that
isn't ready — a perf run needs the camera path to stay visible, this just adds a few words that
never compete with it). Wired into both `perf-run-full` and `perf-report-all-tiers`'s
`onProgress` callbacks; `perf-session.js` now ticks `'measuring-tick'` progress once a second
(configurable, `harness.readProfile()`-driven, only when someone is listening — a caller with no
`onProgress` creates no timer and pays nothing extra) so there is something to show for the whole
span between "measuring" and "building," not just at phase boundaries. Routed through `ui/
index.js` (the zone's one door — `zones/one-door`'s ratchet caught and rejected a first attempt
that imported the file directly). 9 new Node tests (`ui/__tests__/perf-progress-overlay.test.mjs`)
+ 3 new `perf-session.test.mjs` blocks; live-injected the identical styled element into the real
bench Mansion DOM to confirm placement/legibility (correct rect, correct computed colours) —
`computer{screenshot}` itself is blocked by this pane's known focus limitation
([[feedback_sandboxed_browser_pane_lacks_os_focus]]), so this is DOM-level, not pixel-level,
verification. `npm run verify` green, 8,509 tests (+14 net over the previous session's 8,495).

**Open lead, not investigated this round:** `pipelineStats.uniformBuffers` grew **2,137 → 8,637**
(4.04×) across the same window that held `programs` flat at 84. Whether this is expected
(per-material/per-light UBO allocation scaling with new tiles entering residency, torn down
between passes) or a real per-frame leak is unknown — flagged for the next investigation, not
diagnosed here.

**Two of the report's OWN high-severity findings, worth a follow-up, not expanded on here:** `fire`
measured 2.25× its highest declared tier (1.578 vs 0.7 ms/Mpx) and `window` (light) measured 2.6×
(0.156 vs 0.06 ms/Mpx) — both manifests have never been checked against a measurement before this
report existed. Separately, `candleFlame`, `specular` and `window` all show zone-sum vs
sweep-marginal disagreements beyond the report's own 25% tolerance, flagged `method-disagreement`
— unresolved, not averaged away.

**The honest answer to "are Stage 1/2 gains real, is the real gain still ahead of us":** yes, and
yes. Stage 1 (shade once) and Stage 2 (light batching) each targeted a specific, real cost —
redundant per-pixel shading and per-light draw multiplication — that is **not what this capture's
frame time is made of**. Point lights cost ~3 ms combined here (Stage 2 had nothing to batch in
this scene/route); Stage 1 is a real ~26 ms GPU line-item whose payback is unmeasured, not
confirmed absent. The dominant costs exposed by THIS capture — residency streaming (29.2% of wall
time, no Stage owns it) and the raw geometry/depth GPU cost (~90 ms, ~100% of frame GPU) — sit
upstream and downstream of both Stages respectively. A frame median of 108.2 ms needs roughly a
3× cut to reach a steady 30fps (33.3 ms) and ~6.5× for 60fps (16.6 ms); GPU time ALONE (89.78 ms
p50) already exceeds the 30fps budget before any CPU cost is added. Nothing here says Stage 1/2
were a mistake — it says the biggest remaining levers, by this evidence, are residency streaming
first and the geometry/depth stage's raw cost second, neither of which either Stage was built to
move.

---

### ✅ ADDENDUM, same session — full residency audit, and a correction to this petition's own
### Finding 1

*Author directive: "Launch a full investigation into Residency streaming too. Create a report on
it... Full audit looking for performance pain points and looking for ways to win back as much
performance as possible." Full record: `docs/planning/Residency-Streaming-Audit-2026-08-11.md`
(archived per the standing long-report rule); only the plan-relevant summary lives here. Method
stated there in full: four parallel read-only research passes, one central claim independently
re-verified by direct reading before being written up — recorded honestly rather than presented as
uniformly first-hand.*

**A correction to this petition's own Finding 1, found while investigating it further.** Finding 1
above called residency streaming *"the single largest **CPU cost**"* while also correctly computing
*"29.2% of ALL **wall-clock** time"* two paragraphs later — inconsistent, and the inconsistency
matters. `residency.pass`/`residency.itemLoad`'s reported duration is a plain wall-clock delta
(`frame-profiler.js`'s `openSlot`/`closeSlot`, `now() − start`, verified directly: no thread-time
API, no idle-vs-busy distinction anywhere in the file) around a loop that genuinely `await`s real
network/IndexedDB round trips, one item at a time (`updateResidencyUnguarded`'s phase 1,
`vt-pan-viewer.js:10798-10839`). Both bracket call sites already say so in their own comments
("WALL time, not pure CPU-busy time"), and a prior audit two days earlier
(`Performance-Audit-2026-08.md` §14) already reached this same conclusion independently — this
petition should have cross-referenced it and didn't. **The fix this points at is latency/
concurrency (overlap the sequential round trips), not CPU speed** — a materially different target
than "the single largest CPU cost" implies.

**A sharper, related finding, found chasing the first one down: the reason this zone shows real-
looking `drawCalls: 365.1` / `triangles: 428448.2` despite being declared `kind:'cpu'` with no
draws of its own is a genuine instrumentation artifact, independently re-verified by direct
reading of `frame-profiler.js`.** `openSlot`/`closeSlot` sample `renderer.info.render.drawCalls`/
`.triangles` **unconditionally for every zone, with no check of that zone's declared `kind`**.
Because `scheduleResidencyUpdate()` runs fire-and-forget (never awaited by the render loop, which
keeps ticking via `renderer.setAnimationLoop` independently) and this zone's bracket genuinely
suspends across real animation frames, its begin/end drawCalls sample lands at two arbitrary points
in two DIFFERENT frames' independently-reset counters — a delta that looks like plausible data
(matching what one real frame's totals could be) rather than the noise it actually is. **Practical
consequence: residency's wall-clock time demonstrably overlaps normal frame rendering for at least
part of its span — it is concurrent time, not proven-exclusive main-thread-blocking time.** The
29.2%-of-wall-clock figure is real and residency is still the biggest unowned system in the engine
— but it should not be read as "29.2% of the frame budget was stolen from rendering."

**Six further findings, full detail and file:line citations in the archived report:**
1. The per-item/per-mask loading loops are strictly sequential `await` chains with zero
   parallelism, while the underlying decode pool already has unused 3-way concurrency
   (`SLICE_MAX_CONCURRENT_SOURCES=3`, `decode-pool.js:113`) — the likely biggest real lever, but
   flagged **risky**: this exact suspension point has twice before produced real, shipped live
   regressions when touched carelessly (a vegetation render-order flicker; a whole-screen magenta
   regression from two passes racing on shared pin state), both named with fix commits in the
   surrounding code. Needs a dedicated live-verification session, not a benchmark-only change.
2. `refreshCoarsePinBudget`/`primeCoverAlphaGrids` are PROVABLY invariant to camera movement (pure
   functions of scene documents, never of view state) yet re-run on every single camera-driven
   pass — currently cheap only because the bench scene is small; a real document-hook entry point
   already exists to gate them properly. Flagged **moderate** (sound from static reading, needs
   live proof before shipping per this project's own defensive-fix rule).
3. The stale-item release loop scans the FULL, monotonically-growing `itemStates` map every pass
   (one mutator, zero deletions, confirmed by grep) — not costly yet, but unbounded by session
   length/exploration breadth on a large multi-floor map.
4. Root cause of "fires on 462 of 463 frames": `syncFoundryCamera`'s 1-screen-pixel dirty
   threshold is correctly tuned for the specific regression it was built to fix (residual eased-
   camera jitter reporting movement after the user let go) but provides near-zero throttling
   during genuine deliberate panning. A coarser threshold is flagged **risky** — this project has
   already reverted one prior debounce attempt here for making panning feel laggy, and the current
   1px value exists to fix its own prior regression.
5. **A still-OPEN, unsolved mystery, not claimed to be answered:** the report's 20 worst hitches
   (250-667ms, spread across the whole capture) all show COMPLETELY IDLE decode/cache activity —
   ruling out mask-streaming I/O as their cause, but no smoking-gun mechanism was found in the
   cache-hit fast path either. Needs a live Chrome trace correlated against hitch timestamps
   (`tools/trace-analyze.mjs` already exists for this) — recorded as unresolved, not guessed at.
6. A genuinely cheap, zero-risk fix worth taking regardless of anything else: stop sampling
   drawCalls/triangles for zones not declared `kind:'gpu'`/`'both'` in `frame-profiler.js` (or
   suppress them at the report layer) — this exact artifact has now misled two separate
   investigations two days apart into treating noise as signal.

**Recommended order** (full reasoning in the archived report §6): (1) fix the drawCalls/triangles
instrument artifact — cheap, diagnostics-only; (2) pull the still-missing numbers from existing
tools before deciding anything further (`residency.itemLoad.maxMs`, real `itemStates.size`, whether
the worst hitches actually overlap an in-flight pass) — zero code risk; (3) gate the two
camera-invariant pre-phase scans to document-change triggers — moderate, needs live verification;
(4) parallelize the sequential load chains — the larger win, real risk, needs a dedicated live
session; (5) the camera-threshold and stale-release items — lower priority, same live-verification
discipline required.

**✅ (1) DONE, same session** — `buildZoneRows` (`perf-report.js`) now forces `drawCalls`/
`triangles` to `null` for any `kind:'cpu'` zone, reusing the existing `gpuAbsentByDeclaration`
condition rather than duplicating it. 4 new tests pin the suppression against a real 'cpu' zone
fed contaminated data, and confirm real 'gpu'/'both' zones are unaffected. `npm run verify` green,
8,513 tests. **✅ (2) PARTIALLY DONE** — `itemStates.size`/`documentSync.itemCount` pulled live
from the bench Mansion (`itemsLoaded: 8`, `documentSync.itemCount: 5`) via
`MapShine.debug.runReport('vt-pan-viewer-diagnostics')` — confirms the item count for this scene is
genuinely tiny, strengthening the front-loaded-burst reading of Finding 1 above. `maxMs` and the
hitch/pass-overlap questions still need a fresh capture and a Chrome trace respectively — not done
yet. Full detail and honest caveats: archived report §6/§7.

---

### ✅ ADDENDUM 2, same investigative thread, new session — the shader-rebuild culprit found, fixed,
### confirmed live; plus a general fix for how it hid, and a second related finding

*Prompted by three real Chrome traces the author captured, all showing 40-67% of a frame inside
three's `NodeBuilder.build()`. Full record, all evidence, all code cited:
`docs/planning/Shader-Rebuild-Investigation-2026-08-11.md`. Summary only, here.*

**The culprit:** `rebuildSceneDepthProxies`'s vegetation branch — deliberately excluded from
DEFERRED-S1b's material pool one commit earlier, in this same session, citing "0.9% of the total
rebuild cost." That number measured constructing the material; it never measured the consequence
one pass later, in a different zone, where the graph rebuild actually lands — the exact
"small zone timing hides a large downstream cost" trap this same session's own residency audit had
just named. **Fixed**: the position node is now cached per overlay, the pool's signature now
requires (and throws without) an explicit `variantKey` for any positionNode-bearing material so two
canopies can never silently alias. **Confirmed with a real re-trace**: ~8.3ms steady frames,
~120fps, up from the 13fps a 72.1ms frame implied before.

**The author's own critical finding, generalized past this one bug:** *"why the hell haven't we
been seeing useful, loud, informative errors generated as a result of the cache not working?"* The
pool's own hit-rate finding already existed and still didn't catch this, because a health check
scoped to one pool is structurally blind to code routed around it. Fixed generally: a new
`diag/shader-rebuild-probe.js` watches three's shader cache directly (not any one pool's proxy for
it), now **armed automatically** in every `perf-run-full` (same lifecycle as the GPU zone timer),
with an unconditional high-severity `shader-rebuild-churn` finding. Standing rule recorded in
memory: `feedback_pool_health_needs_a_loud_gate`.

**A second, related finding from the SAME confirming trace:** point-light wall-clipping
(`readActiveLightSources` → Foundry's own `ClockwiseSweepPolygon`) had no cache at all, unlike its
candle/lightning siblings — recomputing a full wall-sweep from scratch every frame for every light
Foundry's darkness gate disagreed with MSA's own model about (routine in Aesthetic mode, the
default). Measured at 9.9% of the confirming trace, the new #1 cost once the shader-rebuild fix
landed. Fixed the same session, stricter than its candle precedent (also invalidates on
position/angle/rotation, since a real light — unlike a candle — can be attached to a moving token).
**Not yet confirmed by a trace** — fixed by construction and 13 new unit tests only.

`npm run verify` green throughout, **8,593 tests** (from 8,509 at this addendum's start).

---

**P-007 — A committed trace-analysis tool, and the finding it found: TSL shader-graph REBUILDS are
running during rendering, sustained, at 10.7% of the main thread — independently confirming the
"unwanted pipeline recompilation" hypothesis round 6 instrumented and never got an answer for.**
Filed by Claude Sonnet 5, 2026-08-11, acting as a worker under the Covenant. Full long-form record:
`docs/planning/Trace-Analysis-2026-08-11.md` (archived per the standing long-report rule); only the
plan-relevant summary lives here.

**What the author asked for, and what shipped.** The author captured a second trace
(`Trace-20260811T155628.json.gz`, 158.4 MB, 645,219 events, **36.4 s**, Mansion **upper floor**,
camera moved deliberately to stress the engine) and asked for a real tool rather than another hand
analysis. Shipped: **`tools/trace-analyze.mjs`** + **`tools/trace-analyze.test.mjs`** (49
assertions, registered in `tools/run-tests.mjs`, `npm run verify` GREEN at 8,446). Reads `.json` or
`.json.gz`; emits Markdown + JSON; has a `--compare` mode for before/after pairs. Law 11 held
throughout — only the static file the author exported was ever read.

The tool encodes the three measurement bugs P-006 recorded so they cannot recur: interval-**merged**
busy time with `assertUtilizationSane` **throwing** on the impossible >100% figure that was caught
by hand last time; breadcrumb-based windowing (a `ts:0` metadata event once turned 11.3 s into
428,161,450 ms); and automatic profiler-artifact detection that **requires real containment** of
`CpuProfiler::StartProfiling`, so a genuine early hitch is never silently discarded — that sabotage
case is a test, not a comment. It detected and excluded an 826.9 ms artifact in this capture
unprompted.

**Headline, this capture (effective window 35,581 ms):** 871 presented frames → **24.5 fps**; main
thread **78.3%** busy; GPU submission **85.8%**; frame p99 68.9 ms; felt cadence p99 99.3 ms, max
607 ms; **236 hitches >50 ms**; 69% of frames ≥20 ms.

**A REGIME CHANGE worth naming, and a partial correction to P-006's headline.** P-006 read main
54.3% vs GPU 90.6% (36-point gap) and called MSA GPU-submission-bound. That was an **11-second idle
capture**. Under real camera stress the gap collapses to **7.5 points** — inside the tool's own
"neither dominates" band. Both are honest; they are two regimes, and the stress one is the one the
author plays in. **"GPU-bound" should not be carried forward as an unqualified property of the
engine** — it is a property of the idle case.

**FINDING 1 (the big one) — 3,831 ms / 10.7% of all main-thread samples is TSL graph building,
inside `_renderScene`, sustained across the whole capture.** Attribution: **`runSceneDepthPass`
48.4%** (1,855 ms) · **`runGeometryWorldPass` 46.3%** (1,775 ms) · 94.7% enters via three's
`_renderScene`. Present in **44.8% of frames (390/871)**. Binned 18× across 36 s it is **FLAT** —
first third 628 ms, last third 706 ms — so it is NOT one-time shader compile, which decays.
Verified as a genuine **cache miss**, not expensive key computation (the two need opposite fixes,
so it was checked rather than assumed): `getForRender` 3,876 ms inclusive ≈ the 3,831 ms of build
work, while all `getCacheKey` variants total ~383 ms and `_createNodeBuilder` only 26 ms — the cost
is rebuilding the graph because `nodeBuilderCache` is being missed.

This **independently confirms the hypothesis `keyhole-performance-audit-2026-08` round 6 built
`instrument.pipelineStats`/`pipeline-programs-grew` to test and never got a live answer for** — the
cost class `buildSceneDepthWriterMaterial`'s own header already named once at "3.4 ms mean / 43 ms
max CPU". That the DEPTH pass is the largest contributor is a strong hint, since
`geometry.depthDraw`'s CPU has been an unexplained outlier for three rounds (13.08 ms for 9 draws,
26× worldDraw's CPU for twice the draws).

**Honestly bounded:** the trace proves rebuilds happen and names the two passes; it **cannot** say
why the key churns. Unconfirmed candidates: S1.4's `interior`/`passthrough`/`legacy` material states
or `buildSceneDepthWriterMaterial`'s `alwaysOpaque` structural variant flipping mid-pan; residency
churn creating fresh materials; or a per-frame-varying node hash. **This is now a code question,
not a trace question** — and the highest-value next investigation in the capture.

---

### ✅ ADDENDUM, same session — THE CAUSE IS FOUND, and it is none of the three guesses above

*Author directive: "Go find out why the cache key is churning." Answered from the vendored three
source cross-examined against the trace. Recorded here as evidence on this petition; the plan is
untouched (worker remit).*

**The mechanism, end to end, every link read in source rather than inferred:**

1. **`rebuildSceneDepthProxies(items)`** (`vt/vt-pan-viewer.js:10377`), called from
   `updateResidencyUnguarded` (`:10823`) on **every residency pass**, opens by **wholesale
   disposing every proxy material** in BOTH lists:
   `for (const entry of depthProxyEntries) { depthScene.remove(entry.mesh); entry.material.dispose(); }`
   — and the same loop again for `depthPrepassEntries`.
2. **`material.dispose()` EVICTS THE COMPILED SHADER GRAPH.** three's `Nodes.delete()`
   (`three.webgpu.js:58628-58640`) does `nodeBuilderState.usedTimes--` and, **at zero**,
   `this.nodeBuilderCache.delete(this.getForRenderCacheKey(object))`. Refcount increments live at
   `:58537/58558/58593`.
3. **Wholesale disposal is what guarantees the refcount reaches zero.** Proxies sharing a cache key
   share ONE `nodeBuilderState` with `usedTimes = N`. Disposing all N drives it to 0 → evicted.
   Disposing a subset would leave `usedTimes > 0` and **the cache would survive**. The wholesale-ness
   is not incidental to the bug; it IS the bug.
4. Fresh materials are then built (`buildSceneDepthWriterMaterial`, `:10531`), so the new render
   objects carry an `initialCacheKey` no longer present in `nodeBuilderCache` — and
   `getForRender` (`:58505`) runs a full `NodeBuilder.build()`: prebuild + every build stage +
   `flowNodeFromShaderStage` over every node in the graph.
5. **S1.4 DOUBLED THE COST.** `addDepthPrepassTwin` (`:10319`) builds a SECOND material per tile
   (`{...writerArgs, colorWrite:false}`) into `depthPrepassScene`, disposed and rebuilt by the same
   wholesale loop. `earlyZComposition` is now **`true` by default** (`:9399`; the S1.4 text above
   says "default OFF" — it has since been flipped). That twin is rendered inside
   `runGeometryWorldPass` (`:4489`), which is **exactly why the cost splits ~50/50** between the two
   passes: 48.4% `runSceneDepthPass` (the proxies) / 46.3% `runGeometryWorldPass` (the twins). The
   split was never two independent problems — it is one cause paid twice.

**The causal evidence, measured (a first attempt at this test was WRONG and is recorded so the
method is not repeated):** a frame-level cross-tab said only 32.1% of residency frames contained
build work vs 25.3% of non-residency frames — near-parity, which read as *falsification*. That test
was flawed: `scheduleResidencyUpdate` (`:10974`) means residency runs in its **own task**, so the
rebuild and the build it causes land in **different frames by construction**. Re-run as a
time-window test over sample timestamps: of **85 build episodes**, **82.4% begin within 50 ms of a
`rebuildSceneDepthProxies` episode ending**, **median lag 24 ms — about one frame** — and **100%
within 1 s**. Episodes are large: median 48.5 ms, top ten 454–795 ms each.

**Ruled OUT, with numbers, not assumption:** cache-key *drift* on live render objects. three's
`getForRenderCacheKey` returns `renderObject.initialCacheKey`, fixed at construction; the drift path
does exist (`RenderObjects.get`, `:45986`, dispose-and-recreate when `getCacheKey()` no longer
matches, fed by `getDynamicCacheKey`'s lights node + `renderer.contextNode.version` + clipping) —
but `RenderObject.getCacheKey` totals only **83 ms inclusive across the whole 36 s capture**, orders
of magnitude too little for mass invalidation. **The eviction is the disposal, not key drift.** Also
checked and cleared: MSA sets `material.needsUpdate = true` in only four non-vendor places, none of
them per-frame on proxy materials.

**Three fixes, in ascending risk — none attempted, and deliberately so.** This is the depth
authority, a shared foundation with 7 consumers; Law 3 requires perf work be pixel-diff-gated, and
`keyhole-performance-audit-2026-08` already recorded the incremental reconcile as "highest value,
highest risk … left fully diagnosed for a session with live Foundry access," which this session does
not have.
- **(C) Early-out on an unchanged draw list** — signature the derived proxy set; skip the whole
  rebuild when identical. Lowest risk (pure short-circuit, zero semantic change). Bounded upside:
  214 proxy-rebuild episodes produced only 85 build episodes, so ~60% already hit cache; this
  removes the wasted disposal on those but not the 85 real ones.
- **(B) POOL THE MATERIALS, keep the wholesale mesh rebuild** — *the new option this investigation
  unlocks, and the recommended one.* `buildSceneDepthWriterMaterial` is a pure function of
  `writerArgs`, so cache materials on a signature of those args and reuse the same material objects.
  The draw list stays wholesale-rebuilt (meshes are cheap); because the materials are never disposed,
  `usedTimes` never reaches zero and **the graph cache is never evicted** — attacking step 3
  directly. Risk is materially lower than (A) because *draw-list semantics do not change at all*:
  same meshes, same order, same z, same state. Precondition to verify first: nothing mutates a proxy
  material after construction (the `needsUpdate`/`depthWrite` writes nearby operate on the TILE's
  `t.material`, not the proxy's), and vegetation's per-item `positionNode` must be keyed in or
  excluded from the pool.
- **(A) Incremental proxy reconcile** — the endgame already named in the audit. Highest value,
  highest risk, needs the author's own eyes on a real scene.

**Added to this petition's requests for Fable:** whether (B) is worker-executable behind a revert
flag with a pixel-diff gate, or belongs to the same "live Foundry access" queue as (A).

**FINDING 2 — the debug HUD costs 2,451 ms (6.9% of the main thread), but only while open.** DOM
writes total 2,617 ms and **94% of that is MSA's own diagnostic UI**: `astrolabe.js:506 update`
1,415 ms · `astrolabe.js:350 syncTuningSummary` 709 ms · `perf-strip.js` 259 ms ·
`render-fallback.js:177 describeRenderMode` 68 ms. Stated fairly: `pumpAstrolabe` (boot.js:5028)
gates on `astrolabe?.root?.isConnected`, so a closed dial costs one property read per frame — this
is **not** stolen from every player session, it is stolen from this MEASUREMENT and from the
author's authoring sessions. One piece is wasteful regardless: `syncTuningSummary` is called from
`update()` (astrolabe.js:531) **every frame** and writes `innerHTML` for a string whose only
variable is `skyRow.value() > 0` — 709 ms of HTML re-parsing for a value that changes when a slider
crosses zero. A dirty-check is near-free and unconditionally correct, the same shape as the
point-light re-triangulation and door-leaf fixes already landed.

**This closes P-006's Finding 4 open question: YES, the report builders are live-polled**, and
`describeRenderMode`'s `getComputedStyle` really does run per frame.

**FINDING 3 — P-006's rAF puzzle, resolved and downgraded.** 4,808 callbacks / 871 frame services =
5.52 per frame, but grouped by dominant module these are **multiple legitimate independent loops**,
not one loop misscheduling: three.webgpu.js (MSA's render loop) 21,315 ms across 1,147 callbacks;
foundry.mjs 210; **render-fallback.js 76; astrolabe.js 136; vt-pan-viewer-diagnostics.js 21;
perf-strip.js 7**; and 2,839 callbacks with no samples at all (each finishing inside one 0.25 ms
sampling interval — trivial bookkeeping). The real finding is smaller and different from the
suspicion: **~275 ms of rAF time belongs to diagnostics**, which is Finding 2 from another angle.

**FINDING 4 — a misreadable number, flagged so nobody quotes it wrong.** MSA-authored code is only
**3.0% of main-thread SELF time** (1,066 ms) against three-vendor's 19.0%. That does **not** mean
MSA costs 3% of the frame — our code's job is to drive three, and the work lands there. The
inclusive view: `renderFrame` 9,267 ms · `runPassPlan` 9,080 ms · `runGeometryWorldPass` 5,233 ms ·
`runLightAccumulatePass` 3,296 ms · `runSceneDepthPass` 2,348 ms. Also recorded so it is never
reported as a finding: `update` at three.webgpu.js:45346 (10,778 ms, the largest single entry) is
three's own rAF driver closure that CALLS `renderFrame` — the tree root, not a cost. Verified in the
vendored source.

**FINDING 5 (secondary, point lights) — `computeLightWallClippedShape` (scene-wall-clip.js:255) costs
988 ms, nearly as much as the entire `point-light-pool` update it serves (1,367 ms)**, with
`readActiveLightSources` at 1,024 ms. Wall-clipping geometry is a bigger share of light cost than
its position in the ledger suggests, and it has no perf zone of its own.

**Requested of Fable:**
1. Whether Finding 1 earns a **numbered task in Stage 2 or Stage 3** (it is squarely a frame-core
   cost and currently belongs to no box), or should wait for the paired zone-timer capture below.
2. Whether the **regime correction** above should amend how Stage gates quote "GPU-bound" — the
   Book I scoreboard's targets were set against numbers whose regime is now known to matter.
3. Whether the **paired capture protocol** (a DevTools trace and a `perf-run-full` over the SAME
   interaction) should become a standing requirement for perf claims — **the author has already
   agreed to it in-session** ("using this report to improve the performance report is a good idea,
   I'm happy with that compromise"), so this is a ratification, not a proposal.
4. Whether the ~709 ms `syncTuningSummary` dirty-check and the diagnostics polling cadence are
   worker-executable now (they are small, safe, and outside any current stage's scope) or should be
   queued.
5. Whether `computeLightWallClippedShape` earns its own `perf-zones.js` zone alongside
   `buildOneLightSource` (P-006's request 3, still open).

**P-006 — A live Chrome DevTools trace from the author's real production server independently
confirms MSA is GPU-submission-bound, not CPU-bound, and its own instrumentation nearly produced
a false 1.19-second "hitch."** Filed by Claude Sonnet 5, 2026-08-11, acting as a worker under the
Covenant (a worker may not add plan tasks). No Stage 0 or Stage 1/2 checklist item covers "analyze
an ad hoc DevTools capture the author dropped in," so this is filed as a discovery rather than
claimed against an existing box.

> ⚠️ **PARTIALLY SUPERSEDED BY P-007 (same day) — do not read Finding 1 standalone.** This capture
> was **11 seconds, idle** (no camera movement). P-007's 36-second camera-stress capture of the
> Mansion upper floor measures main 78.3% vs GPU 85.8% — a 7.5-point gap, not this petition's
> 36-point one. "GPU-submission-bound" is a property of the IDLE regime, not of the engine. P-007
> also RESOLVES this petition's Finding 4 (report builders are live-polled: yes) and Finding 5 (the
> rAF multiplier is several legitimate loops, ~275 ms of it diagnostics).

**Provenance, and Law 11 compliance stated explicitly:** the author placed
`chrome-performance-traces/Trace-20260811T154340.json.gz` directly in the repo (git status shows
it untracked — author-added, not fetched). Decompressed: 51.6 MB, standard Chrome DevTools JSON
(`metadata.source: "DevTools"`, NOT the Playwright harness), 186,766 trace events, one full V8 CPU
sample profile (38,942 samples, 422 chunks). Its own JS profile file-URLs prove it was captured
against `https://mythicamachina.com/modules/map-shine-advanced/...` — the author's real production
server, real MSA, real Foundry (`https://mythicamachina.com/scripts/foundry.mjs` appears too) —
**this session only ever read the static file the author had already exported; no connection was
made to mythicamachina.com or any live Foundry instance**, same one-way-only shape Law 11 requires
for [[reference_scene_export_import_bridge]]-class data, just for a trace file instead of a scene.
Recording window: **11.292 s** (`metadata.modifications.initialBreadcrumb.window`, cross-checked
against the trace's own event timestamps — see the self-caught bug below for why that
cross-check mattered). `hostDPR: 1.5`; exact canvas resolution not present in the capture.

**Finding 1 — GPU-submission-bound, confirmed by an independent measurement path.** Main JS
thread (`CrRendererMain`) true busy time — computed by merging overlapping `[ts, ts+dur)` spans
per thread, not by summing event durations by name (see the self-caught bug below for why that
distinction is load-bearing) — is 6,136.4 ms / 11,291.6 ms = **54.3%**; excluding the one-time
startup artifact (Finding 2) that falls to **≈49%**. The GPU process's actual command-submission
thread (`CrGpuMain`) merged-busy is **90.6%** (10,228.2 ms), of which the `GPUTask` span alone —
confirmed as a true subset, not double-counted — is **84.0%** of the entire 11.292 s window by
itself. Actually-presented frame rate, from `DrawFrame` instant markers (the same primitive
DevTools' own FPS meter uses): 306 frames / 11.292 s = **27.1 fps**. CPU has real headroom (~46–51%
idle-or-elsewhere); the GPU submission thread does not. This is a different measurement path
(browser-native tracing) independently landing on the same diagnosis
[[keyhole-performance-audit-2026-08]] already carries from MSA's own instrumented zone timer
(point lights are real fan-polygon geometry, ~16× bandwidth headroom but real fill-rate/pass
costs) — worth recording as corroboration, not a new discovery. **Ceiling on this trace: no
Dawn/GPU trace category was recorded, so it can say the GPU thread was busy, never WHICH MSA pass**
— `perf-session.js`'s own GPU zone timer remains the only tool that can attribute this to
`geometry.worldDraw` vs `pass.light.accumulate` vs anything else. Against THE GOAL (line 38–41
above): 27.1 fps sits between the recorded start point (18.1 avgFps) and "acceptable" (40+ fps) —
stated as a directional data point only, since resolution/route/scene here don't match the
3840×1906 reference benchmark and are not known from the trace.

**Finding 2 — a DevTools instrumentation artifact nearly read as a 1.19 s hitch; caught, not
chased.** The single largest main-thread event in the whole capture is one `RunTask`,
dur=1187.4 ms, starting 1.234 ms *before* the recording's own start marker — effectively the very
first thing captured. At the same instant (tsRel=0.066 ms), `CpuProfiler::StartProfiling` runs for
1155.5 ms. Two `V8.DeoptimizeAllOptimizedCodeWithFunction` calls (1.917 ms + 1.386 ms) land at
tsRel=1186.6 ms and 1188.6 ms — literally the instant the long task ends — which is exactly the
signature of a profiler attaching mid-session and deoptimizing already-JITed code so it can
reinstrument it. **Excluding this one event, the main thread recorded zero tasks over 50 ms for
the remaining ~10.1 s.** Recorded as a standing caveat for the next trace read: the first
~1.2–1.5 s after clicking Record (with JS Profiling on) is instrument overhead, not gameplay —
same lesson shape as [[feedback_playwright_fps_not_yet_trustworthy]]'s "the systematic error was
ours," just DevTools instead of Playwright.

**Finding 3 — CPU self-time corroborates two already-tracked costs; surfaces no new dominant MSA
hotspot.** Self-time only, from the CPU profiler's own per-node sample accounting — deliberately
NOT the naive "sum durations by event name" approach, which is unusable on this trace: the
Finding-2 artifact nests through `FunctionCall`/`EventDispatch`/`v8.callFunction`, inflating each
of their totals by over a second and producing a badly misleading "hottest event" ranking if taken
at face value. Of 38,942 samples: 38.8% `(program)`, 23.6% `(idle)` — ~62% of main-thread sample
time here is not attributable JS/DOM work at all. `point-light-pool.js:841`'s `update` — the exact
function this project's own perf ledger has tracked across three rounds of fixes (3.686 → 2.807 →
2.428 ms mean, [[keyhole-performance-audit-2026-08]]) — is the largest MSA-authored (non-vendored-
three) self-time cost: 189 samples (0.49%). Independent corroboration, via a wholly different
measurement method, that this remains real and present, consistent with "already improving," not a
regression. `effects/candle-flame-geometry.js:430`'s `buildOneLightSource` (145 samples, 0.37%) is
the *second*-largest MSA-authored self-time cost — larger than most of the point-light pool's own
sub-costs — and has no dedicated `perf-zones.js` zone separating it from the rest of `pass.light`.
No third MSA function clears ~0.2% self-time.

**Finding 4 — a real, DOM-churn-shaped cost, traced to two call sites by line number and verified
against source, neither confirmed as per-frame.** ~9.0% of all CPU samples went to raw DOM writes
(`set textContent` 4.02%+0.58%, `set innerHTML` 2.51%+0.24%, `setAttribute` 1.20%, `set innerText`
0.40%); `Layout`+`Paint`+`UpdateLayoutTree`+`PrePaint`+`HitTest` together cost 414.6 ms (3.7% of
the window) across 359–412 occurrences each — roughly once per rendered frame (306 `DrawFrame`s).
Read the actual source at both flagged line numbers rather than assume:
- `mask-authority.js:943` `requiredMissingAuthoredIds` (150 combined self-time samples across two
  profile nodes) is reached only through `buildMaskAuthorityReport` (`mask-authority-report.js:166`)
  — report-builder machinery. Its own doc comment already asserts it's cheap per call ("a handful
  of Map lookups... per host of one floor"), confirmed by reading it. The open question isn't its
  per-call cost — it's whether `buildMaskAuthorityReport` is polled on a live HUD interval or only
  built on-demand (a button click), and this trace cannot answer that.
- `diag/render-fallback.js:178` `describeRenderMode` (62 samples) calls `getComputedStyle` (a
  style-recalc-forcing read), reached through `vt-pan-viewer-diagnostics.js:606`'s big diagnostics
  report object — same report-builder family, same open question.

Both call sites are diagnostics/report code, not obviously the render loop itself, verified by
reading their actual callers — this downgrades the finding from "likely bug" to "open question
about polling cadence," recorded honestly rather than as a diagnosis I didn't check.

**Finding 5 — two puzzles reported without a guessed explanation.** `requestAnimationFrame` fired
~5× more often than frames were actually presented: 1,530 `FireAnimationFrame` events vs 306
`DrawFrame` events over the same 11.292 s (135.5/s vs 27.1/s). No per-callback stack attribution
exists in this trace to say whether that's several legitimate independent rAF loops (Foundry's own
ticker, MSA's render loop, UI animation) or one loop doing avoidable extra scheduling — left open,
not diagnosed. Separately, `PipelineReporter` async spans pair cleanly (0 unmatched begins/ends, 0
suspected id reuse — checked explicitly, since silent id reuse would corrupt every number
downstream of it) but count 1,736 spans against only 306 actually-presented frames, with a
percentile shape (p50=8.5 ms, p90≈p99≈108 ms, max=1200 ms matching Finding 2's artifact almost
exactly) that doesn't obviously map 1:1 to displayed-frame cadence. Reported as a secondary,
unverified-semantics metric — the 27.1 fps headline above comes from the simpler, standard
`DrawFrame` count instead, deliberately.

**Finding 6 — an environmental confound, instrument hygiene rather than an MSA finding.** ~1.86%
of all CPU samples landed in three `chrome-extension://` origins unrelated to Foundry/MSA (ids:
`hdokiejnpimakedhajhdlcegeplioahd`, `nngceckbapebfimnlniiiahkandclblb`,
`gighmmpiobklfepjocnamgkkbiglidom`). Real main-thread cost, not MSA's or Foundry's to fix. A
future capture from an extensions-disabled/incognito profile would remove this confound; a changed
number here between captures should not be read as an MSA regression or improvement.

**Two measurement bugs this petition caught in its own first draft, before they could ship into a
holy document — recorded because the mistake is instructive, not just the fix:** (1) a `ts:0`
metadata event (`process_name`/`thread_name`, common in Chrome traces) dragged a naive min/max scan
into reporting a **428-million-millisecond** trace duration instead of the real 11.292 s, until
cross-checked against the trace's own DevTools-recorded breadcrumb window and against duration-
bearing events only. (2) summing event durations per GPU thread by name, ignoring nesting, produced
a physically impossible **174.6%** utilization figure for `CrGpuMain` — fixed by merging overlapping
`[ts, ts+dur)` intervals per thread instead of summing them, the only way to get a true ≤100% busy
figure when parent and child spans coexist on one thread. Neither number above is the pre-fix one.

**Requested of Fable:**
1. Whether "exclude the first ~1.2–1.5 s of any DevTools capture (JS-profiler attach cost)"
   belongs as a standing methodology note somewhere durable — a memory beside
   [[feedback_playwright_fps_not_yet_trustworthy]], or wherever future author-captured traces will
   be read next.
2. Whether Finding 4's open question (is `buildMaskAuthorityReport`/`describeRenderMode` on a
   live-polled HUD interval, or on-demand only) is worth a one-session call-counter to settle, or
   small enough (≤0.4% self-time each) to leave alone.
3. Whether `buildOneLightSource` (candle geometry) earns its own `perf-zones.js` zone now that it's
   the second-largest MSA-authored self-time cost this profile surfaces.
4. Whether future ad hoc DevTools captures should be paired with a simultaneous MSA
   `perf-run-full`/`perf-report` run for the SAME interaction, so a future trace's GPU-busy time can
   be attributed to a specific MSA pass instead of stopping at "the GPU thread was busy."
5. The two self-caught measurement bugs recorded above — worth a line in
   [[feedback_instruments_must_not_lie]], or left as this petition's own record.

*(The two Node scripts used to produce these numbers are disposable session scratch, not committed
— gunzip + trace-event aggregation, rewritten once mid-session after catching the two bugs above.
Not proposed as a permanent `tools/` addition unless Fable or the author wants one.)*

**P-005 — CORRECTION: the "vertex-stage uniformArray defect" P-004's addenda relied on was never
real; it was a Y-flip bug in the bench's own pixel sampler.** Filed by Claude Sonnet 5, 2026-08-11,
acting as a worker under the Covenant. Not a plan change — a factual retraction, filed as its own
petition rather than a quiet addendum because it touches the evidentiary basis of an
ALREADY-RESOLVED petition (P-004) and a Fable-countersigned plan document.

**What was wrong:** `tools/shader-lab/bench-point-lights.js`'s `sampleColor(colorBuf, x, y)`
computed `row = fy * DIM` (`fy` = normalized world Y). `readRenderTargetPixelsAsync`'s row 0 is
actually HIGH world-Y, not low — confirmed directly, live: a quad authored at world Y∈[750,850]
reads back at buffer row ≈51 (near the top), never row ≈205 (near the bottom, what the
unflipped formula predicts). This is [[feedback_y_flip_recurring_risk]] — this project's own
named, "bitten five times" risk — for a sixth time, in a NEW place: the bench's own instrument,
not production code.

**Why this went undetected all session:** every check in this bench file that sampled a named
coordinate happened to use world Y=500 — `WORLD`'s exact vertical midpoint, which is
SELF-SYMMETRIC under a flip (`(1-0.5)*DIM === 0.5*DIM`). The bug was invisible to every check
until S2.3's own new movement checks (`span-position-rewrite-moves-a-light`, and the third
scenario's pre-existing `moving-a-light-only-touched-its-OWN-transform-slot`) sampled genuinely
asymmetric Y values (425, 650, 700, 750) — the first checks all session with any chance of
catching it.

**What this RETRACTS:** the "vertex-stage uniformArray defect" — P-004's second addendum and the
design doc's §0 rule 1 both cited a device-instrumentation finding (`UniformArrayNode.value` and
`device.queue.writeBuffer` both proven byte-correct, yet the render appeared "stuck" on stale
data) as one of TWO independent backend failures justifying a ban on `uniformArray` dynamic
indexing. That finding is WRONG. Re-running the third scenario's exact same check, unchanged,
with ONLY `sampleColor`'s flip fixed: `moving-a-light-only-touched-its-OWN-transform-slot` now
**passes cleanly** (`new spot=0,255,0; old spot=0,0,0` — correct). The mechanism was moving the
light correctly the entire time; the bench was reading the wrong pixel row and mistaking a
genuinely-relocated light for a frozen one. Every prior claim of "narrowed, not root-caused" for
this specific finding is withdrawn — there was nothing to root-cause.

**What REMAINS valid, unaffected:** the fragment-stage `edgeSoftFactor` finding
(`point-light-illumination.js:1289-1309`) is a COMPLETELY SEPARATE, PRE-EXISTING (2026-07-19)
observation, made in a REAL Foundry session (the whole scene going solid black), with no
dependency whatsoever on this bench file's `sampleColor` function or any bench measurement at
all. That finding stands as originally recorded.

**Why the actual DESIGN DECISION does not need to change:** the plan of record already chose
packed per-vertex attributes over `uniformArray` for reasons independent of the now-retracted
finding — they are simpler (no dynamic indexing at all), and the movement mechanism is now proven
correct twice over (this bench's third AND fourth scenarios, both passing cleanly). There is no
reason to reopen the mechanism choice; only the STATED JUSTIFICATION in §0 needed narrowing to the
one finding that is actually real. `docs/planning/Point-Light-Batching-Design.md` §0 rule 1 and
the project memory `keyhole-uniformarray-indexed-read-unexplained-failures` have both been
corrected to reflect this — read those directly for the corrected framing rather than relying on
this petition's own summary of them going stale.

**The honest meta-lesson** (`feedback_instruments_must_not_lie`, `feedback_plausible_diagnosis_
rots`): extensive, genuinely rigorous device-level instrumentation (patching
`device.queue.writeBuffer` itself, reading `UniformArrayNode.value` directly) correctly proved the
CPU-to-GPU write path was byte-correct — and that correct, hard-won proof was then read through a
BROKEN measurement instrument and mistaken for evidence of a stuck render. Proving the write is
correct is not the same as proving the READ (the sample) is correct; both must be independently
trustworthy before a "device defect" conclusion is safe to record permanently, let alone act on
architecturally.

*Requested of Fable:* no plan edit needed — the resolution stands, for the reason given above.
Countersign only if there is disagreement with that read; otherwise this stands as the corrected
record.

**P-004 — Stage 2's gate is already satisfied without doing Stage 2, and it measures the wrong
resource.** Filed by Claude Opus 5, 2026-08-11, acting as a worker under the Covenant, on being
asked to begin Stage 2. Not a request to weaken the stage — a request to re-aim it, because as
written it would pass vacuously.

*The gate as written:* "light stack 8.6 → ≤ 4 ms GPU; `pointLightUpdate` ≤ 1 ms CPU."

*What the light stack actually costs today* (read from `stage1-earlyz-bench-result.json`, the
S1.6 capture — real per-zone GPU timing, `attribution.verdict:'good'`, First Floor, flag ON):

| zone | GPU ms | CPU ms | draws |
| --- | --- | --- | --- |
| `light.drawColoration` | 0.352 | 0.825 | 68 |
| `light.drawPointLights` | 0.348 | 1.304 | 68 |
| `light.drawWindowLight` | 0.161 | 0.184 | 4 |
| `light.drawComposite` | 0.105 | 0.065 | 1 |
| `light.drawIllum` | 0.102 | 0.187 | 1 |
| `light.drawRegions` | 0.065 | 0.138 | 8 |
| `light.drawCandleFlame` | 0.023 | 0.067 | 2 |
| **every light GPU zone summed** | **1.156** | — | — |
| `light.pointLightUpdate` | (no GPU) | **2.710** | 0 |
| `pass.light.accumulate` (the whole pass) | — | **5.886** | **152** |

**The GPU half of the gate is already met by a factor of 3.5 — before Stage 2 changes
anything.** 1.156 ms against a ≤4 ms bar. The 8.6 ms baseline has the same provenance problem
Fable already documented for `geometry.worldDraw`'s 26.6 ms at S1.6: it predates both the
Mansion Redux re-import and this session's own optimisation work. A stage whose gate is
satisfied at the moment it opens cannot tell success from having done nothing —
[[feedback_instruments_must_not_lie]] applied to a gate rather than an instrument.

**Where the cost actually is: CPU, and specifically draw-call submission.** The light pass
spends **5.886 ms of CPU** issuing **152 draw calls** — 68 point lights + 68 coloration draws
being the bulk — against a whole-frame GPU time of 4.33 ms. That is ~39 µs of CPU per draw
call, the classic WebGPU/three submission overhead, and it means **the light stack is CPU-bound,
not GPU-bound**: the GPU finishes this work in a quarter of the time the CPU takes to ask for
it. `light.pointLightUpdate`'s 2.710 ms CPU (the one CPU number the gate does name) is real and
over its 1 ms bar, but it is less than half the story; the pass-level 5.886 ms is the headline.

**Stage 2's THESIS is untouched by this and is, if anything, better supported.** "Point-light
polygons pre-triangulated into one storage-buffer soup; ONE MAX-blend illum draw, ONE ADD
coloration draw" collapses ~136 draw calls to 2. On these numbers that is a CPU saving of
several milliseconds per frame — at 60 fps, a third of the frame budget — which dwarfs any
plausible GPU saving from the same change. The work is right; only its justification and its
gate are aimed at the wrong resource.

*Requested of Fable:* re-gate Stage 2 against what it actually improves. A suggested shape,
offered as a starting point and not as a plan edit (which is not mine to make):
- **CPU, the primary gate:** `pass.light.accumulate` CPU **5.886 → ≤ 2.5 ms**, and its draw
  count **152 → ≤ 20**. Both are measured today, on this content, by the same instrument.
- **`light.pointLightUpdate` CPU ≤ 1 ms** — keep exactly as written; it is a real, currently
  failing bar (2.710 ms).
- **GPU, as a NON-REGRESSION bound rather than a target:** the summed light GPU zones must not
  exceed **~1.4 ms** (today's 1.156 ms plus headroom). Stated this way it catches the real risk
  of the redesign — that one giant batched draw shades more pixels than 136 scissored small
  ones did — which the current "≤ 4 ms" ceiling is far too loose to notice.
- **Re-baseline honestly:** record 8.6 ms as historical, superseded by the 1.156 ms/5.886 ms
  pair above, the same way S1.6's entry handles 26.6 ms.

Until this is resolved I am proceeding only with work that is correct under either gate:
measurement, and the lab proof that one MAX-blended batched draw is order-independent and
pixel-exact against today's 68 separate draws. No live wiring, no default flips.

**Addendum, 2026-08-11 (Claude Sonnet 5, at the author's direct instruction to continue —
"let's get on with it" — recorded as authorization, not a Fable resolution):** the batching
mechanism itself is now PROVEN on the real device, `tools/shader-lab/bench-point-lights.js`
(wired into the lab at `point-lights-lab.js`), 6/6 checks green:
- Confirms in source AND on-device that `resolveLightAnimation` baking a specific animation
  variant into each light's compiled material at build time is the project's own
  `tsl/no-uniform-gates` discipline (`world/wind-access.js`'s own header names it), not an
  oversight — so "one uber-shader, runtime branch on animation type" is the WRONG shape for
  this codebase and was rejected before writing any of it.
- Confirms S1a's own technique (geometry groups + a material array) does NOT reduce real draw
  calls — `renderer.info.render.drawCalls` reads 2 for a 2-group mesh, not 1, because each
  group reaches the backend's low-level draw dispatch separately. Groups save shading cost
  (S1a's goal), not CPU dispatch cost (this stage's).
- Confirms the actual mechanism: N differently-shaped, differently-positioned,
  differently-coloured lights, MERGED into one ungrouped mesh sharing ONE already-compiled
  material (per-light data baked into extra vertex attributes, no new shader branch), draw at
  **1 real call instead of N**, byte-identical to N separate draws, order-independent, with
  real (non-vacuous) MAX-blend compositing confirmed at an overlap region.
- One false lead chased and ruled out, kept in the bench's own header rather than deleted
  quietly: the proof material's FIRST draft set `transparent:true` (a plausible guess) instead
  of copying `point-light-illumination.js:1487`'s real `transparent:false` — that one flag
  mismatch made `DoubleSide` look like it cost 2 draws per mesh (a real backend behaviour,
  just not one production hits), which looked like a free "switch to FrontSide, halve
  everything" win sitting unclaimed in production. Re-tested against the material's OWN real
  flags before believing it: at `transparent:false`, DoubleSide costs exactly 1 draw,
  byte-identical to FrontSide. No free win existed — a `bench must build inputs like
  production` catch, on my own bench, before it reached this record as a false finding.

Live wiring into `point-light-pool.js` is the next step, not yet started. The gate re-aim
above still needs Fable's resolution before a default flips; the mechanism it would flip TO is
no longer a proposal.

**Second addendum, 2026-08-11 (Claude Sonnet 5):** the bench gained a third scenario,
`indexed-transform-array-preserves-cheap-position-updates`, proving the part of the design the
first two didn't touch — cheap PER-FRAME position/radius updates without a vertex rewrite (local-
space fans + a per-vertex slot attribute indexing a shared `uniformArray` from the VERTEX stage,
the real code's own `triangulateLightFan` convention). This supersedes the "6/6 checks green"
line above: the bench is now 9/10. Three of the new scenario's four checks pass — one merged
draw call even with per-light transforms, each vertex reading its own slot correctly, untouched
slots staying byte-identical across frames. One does not: moving a light only touches its own
transform slot.

That failure was chased with direct device instrumentation rather than more bisection, and is
now narrowed, not root-caused. Patching `UniformArrayNode`'s CPU-side `.value` and
`device.queue.writeBuffer` itself and reading both back live: the CPU-side update is byte-correct
after the second render, and the GPU upload call fires with the fully correct, moved bytes for
both the origin and radius buffers. The write path is provably correct end to end. Yet the
rendered image keeps showing the light at its first-frame position, and two further no-op
re-renders (no mutation, no new writes) stay stuck on that same stale image — ruling out simple
one-frame latency. The gap is isolated to the bind-group/buffer-resource layer inside the
vendored WebGPU backend (three.webgpu.js's `Bindings`/`WebGPUBindingUtils`), downstream of a
confirmed-correct write, and was not chased further into that layer per the author's own
standing guidance against open-ended, unbounded debugging. Recorded honestly rather than fudged
or hidden, per [[feedback_instruments_must_not_lie]] and [[feedback_plausible_diagnosis_rots]] —
the design conclusion is unweakened (three of four checks pass, and the mechanism's CPU- and
upload-side correctness is now proven rather than assumed), but this specific gap should be
resolved, not just documented, before the merge design's cheap-update path carries production
light movement.

Live wiring into `point-light-pool.js` remains not started. The gate re-aim still needs Fable's
resolution.

**Third addendum, 2026-08-11 (Claude Sonnet 5):** reading `point-light-pool.js`,
`point-light-illumination.js`, and `point-light-coloration.js` in full (prompted by the author's
own choice, "full scope, design note first," on hearing how much bigger real production's
per-light data surface is than the bench's two-number proof) surfaced a second, independent,
unexplained failure in the same suspect family as the second addendum's gap:
`point-light-illumination.js:1289-1309`'s soft-edge SDF term (`edgeSoftFactor`) — a DIFFERENT
`uniformArray`, read via a `Loop` in the FRAGMENT stage rather than the vertex stage — has been
disabled since 2026-07-19 because wiring it in turned the entire scene solid black, root cause
never found despite reading the same vendored source this session re-read. Two independent
`uniformArray`-adjacent failures, different stages, different symptoms, discovered three weeks
apart by unrelated investigations. The full design — bucket keys, the complete per-light data
inventory, why this means the merge design should avoid `uniformArray`-indexed reads entirely
(favouring plain per-vertex attributes, already proven, plus data-texture sampling for
variable-length data like edge points and apertures, also already proven elsewhere in this
codebase) — is written up in
[`docs/planning/Point-Light-Batching-Design.md`](../planning/Point-Light-Batching-Design.md),
DRAFT, awaiting sign-off before any implementation begins.

**RESOLVED by Fable (claude-fable-5), 2026-08-11 — granted in full, and the stage restructured
around it.** The re-aimed gate is adopted verbatim into Stage 2's S2.9: CPU is the primary gate
(`pass.light.accumulate` 5.886 → ≤ 2.5 ms, point-light draws 136 → ≤ 16), `pointLightUpdate`
≤ 1 ms stands as written, GPU becomes a ≤ 1.4 ms non-regression bound, and the 8.6 ms baseline
is recorded as historical. The storage-buffer-soup sketch is STRUCK for the reasons this
petition's three addenda document; the mechanism of record is packed per-vertex attributes
through ONE shared shading core (no `uniformArray` dynamic indexing anywhere in it), specified
in `docs/planning/Point-Light-Batching-Design.md` — now PLAN OF RECORD, Fable-countersigned,
its DRAFT status and open questions resolved (apertures: deferred, zero exist on the flagship
map per S2.0's census; the fragment-stage `edgeSoftFactor` bug: stays parked, out of stage
scope; rebuild-cost ceiling: subsumed by the `pointLightUpdate` ≤ 1 ms gate itself). The second
addendum's failing bench check blocks nothing — the mechanism it tested is banned from
production use and the scenario stays as the pinned record of the backend defect;
root-causing that defect is explicitly outside Stage 2's scope.

**P-003 — Stage 0's instrument (the Playwright harness) needed its own trust check before any
measurement through it could count.** Filed by Claude Sonnet 5, 2026-08-10, acting as a worker
under the Covenant, in response to the author's direct question: *"performance seems to be
worse in the chrome browser you keep loading than when I load up the level, is it possible
playwright makes a browser with less resources or with lower CPU priority or something?"*

*What was checked, live, with real evidence (not the Stage-0 checklist itself — a
prerequisite to trusting it):*
- `document.hasFocus()` / `document.visibilityState` read `true` / `"visible"` across three
  separate 5-second fps windows, including before and after an explicit `page.bringToFront()`
  and a real mouse click on the canvas. **Chrome's own tab/window-backgrounding throttle is
  RULED OUT** as the cause — the page never left the state that throttle gates on.
- `Get-Process`/`Get-CimInstance Win32_Process` on the live Chrome process tree (8 processes:
  browser, GPU, 2 renderers, 3 utility, crashpad) showed `PriorityClass Normal` on every
  process except the GPU process, which ran **`AboveNormal`** — the opposite of "lower CPU
  priority." **OS-level process priority is RULED OUT.**
- The full command line was captured for every process. Playwright's own default launch args
  already include `--disable-background-timer-throttling`,
  `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` — i.e.
  Playwright is already defending against the exact throttling class the author asked about.
- **Two genuine, confirmed differences from a normal user Chrome launch, cause not yet
  determined:** every process (including the GPU process) runs with `--no-sandbox`, and the
  renderer is capped at `--num-raster-threads=4` on an 8-core/16-thread CPU — worth an A/B
  (raster-thread cap lifted; sandbox on vs. off) before trusting a Stage-0 number.
- **Still unexplained:** fps measured 20 → 7 → 32 across three consecutive 5-second windows on
  the SAME loaded scene with focus/visibility never changing. This means the earlier
  session's fps=6/37/67-style swings are **not yet safe to read as engine performance** —
  something is producing real per-window variance that none of the checks above account for
  (candidate causes not yet tested: thermal throttling under sustained laptop load, genuine
  MSA background work — residency/mask-bake — landing unevenly across windows, or GPU
  scheduler contention from something outside this investigation's process list).

*Requested of Fable:* decide whether Stage 0's checklist should gain an explicit prerequisite
item ("0a. instrument trust: raster-thread + sandbox A/B, then a same-scene Playwright-vs-
manual fps comparison at matched zoom/settle") before any of the other Stage-0 measurements
(pass census, CPU flame graph, hitch autopsy, blending/maskNode A/B, CAS tier test, RenderBundle
probe) are taken as reliable — none of those six have been started yet this session; this
petition is the trust-check that came first, not a substitute for them.

**RESOLVED 2026-08-10 by Claude Fable 5.** No new 0a prerequisite item — the checklist stands as
executed. Rulings, one per open thread: (1) `--no-sandbox` is Playwright's own automation default
(confirmed via chrome://version) — accepted as a permanent property of the instrument, unfixable
without patching Playwright itself. (2) The raster-thread-cap question was deliberately dropped
mid-investigation (its diagnostic risked the author's own live browser session) — it stays
unknown and non-blocking. (3) The largest systematic error found was OURS, not Chrome's:
`perf-run-full` ran silently 30fps-capped by the video-recording camera-path cap — found and
fixed at Stage-0 close (see the instrument-bug row in Stage 0 above). (4) The remaining variance
(the 20→7→32 swings; two unrelated A/B flags reading identically worse) is best explained by
concurrent machine load during captures. **Standing rule, distilled from all four:** harness
numbers are DIRECTIONAL unless the machine is otherwise idle; before/after claims must be
same-session paired captures; and any number a stage gate will RELY on must come from an
idle-machine capture. The trust memory (`feedback_playwright_fps_not_yet_trustworthy`) is
updated to match this resolution.

**P-002 — The Scene Exporter has no task in this plan.** Filed by Claude Sonnet 5, 2026-08-10,
acting as a worker under the Covenant (a worker may not add plan tasks).

Author directive, same session: parity work needs the author's REAL scenes (walls, lights,
regions, MSA flags) inside the bench world P-001 built — but the author must never hand an
assistant live access to their real development Foundry ("a very real danger of modules made
for Foundry VTT"). Built the one-way bridge instead: a button in the author's own world
produces a portable file; the assistant only ever reads that file and only ever writes to its
own bench world.

*Requested of Fable:* add this to Book I as a Stage-0-adjacent prerequisite (parity work in
Book II cannot proceed past bare geometry without it), and decide whether the safety pattern
it encodes — "the assistant never touches the author's real Foundry, ever" — belongs in the
Testament's own Law section (§ THE LAW) rather than living only in memory
([[project-mission-and-hardware]], [[feedback_pushback_and_quality_mandate]]).

*What was built and proven (a real round-trip, not a claim):*
- `src/foundry/scene-export.js` (ships in the module) — reads the active scene's Levels,
  Tiles, Walls, AmbientLights, Regions (via Foundry's own `.toObject()`, verified field-for-
  field against `common/documents/{scene,level,tile,wall,ambient-light,region}.mjs` in the
  installed v14.365 source) plus MSA's three scene-flag payloads (authored anchors, painted
  masks, camera path), through the same adapters those subsystems already use. Deliberately
  excludes Tokens/Drawings/Notes/Sounds — named in the module's own header, not silently
  dropped. 26 new Node tests (`src/foundry/__tests__/scene-export.test.mjs`).
- Two debug-panel registrations in the Bridge zone (`src/boot.js`): a `registerReport`
  (clipboard copy, also rides "Export everything" for free) and a `registerAction` (the actual
  file download the author hands over) — "📦 Export Scene (download for AI import)".
- `tools/scene-import.mjs` — deliberately NOT shipped (bench tooling only). Proven live: real
  walls (incl. a real door), a real light, and a darkness Region with an active behavior were
  authored in the bench Mansion scene, exported through the real UI action, and re-imported
  into a fresh scene via `createEmbeddedDocuments(..., {keepId:true})`. Verified directly, not
  assumed: the imported First-Floor's `visibility.levels` still resolves to the imported
  Ground's real id, and an imported Wall's `levels` field does too — the cross-reference the
  whole `{keepId:true}` design exists to preserve. MSA flag restoration also proven with a
  real (non-null) `authoredAnchors` payload, round-tripped and read back byte-identical.
- One real architectural catch worth recording: the first draft read `MapShine.version`
  directly inside `scene-export.js` — a `foundry/` leaf importing the composition root above
  it, exactly the inversion that file's own header (and the `zones/one-door` doctrine) warns
  against. `npm run lint` caught it as `no-undef` before it shipped; fixed by having the
  caller (boot.js) stamp the version in at the edge, matching `envelope()`'s existing shape.
- A second catch: a bare `Date.now()` in the filename tripped the "time is an input, never
  sampled privately" structure check. Fixed by mirroring `diag/flight-recorder.js#
  bundleFilename`'s existing injected-`wallClock` pattern rather than inventing a new one —
  now `sceneExportFilename(name, wallClock)`, tested with a fixed clock.

`npm run verify` green throughout (8,254 tests after this work, up from 8,228).

**RESOLVED 2026-08-10 by Claude Fable 5.** Granted in full: Stage 0 gains item 0a-1
(countersigned there), and the petition's safety pattern is promoted into THE LAW as Law 11 —
it was always a mission-priority-#2 rule wearing a memory's clothes.

**P-001 — The live-verification harness has no task in this plan.** Filed by Claude Opus 5,
2026-08-10, acting as a worker under the Covenant (a worker may not add plan tasks).

The author directly instructed installing Foundry in the working directory and setting up
Playwright, and that work is now DONE and demonstrated (evidence below). But Book I Stage 0
assumes measurements can simply be taken, while in fact **every** Stage-0 item — the pass
census, the 7.7 ms CPU experiment, the hitch autopsy, both A/B captures, the CAS-tier live
test — requires exactly this harness to exist first. It is an unlisted prerequisite of the
plan's own first stage.

*Requested of Fable:* add a Stage 0 item "0a-0. Live-verification harness" recording what now
exists, and consider whether Book III's NOW list should name it explicitly.

*What was built and proven (a real capture, not a claim):*
- `tools/foundry-server-boot.mjs` — runs Foundry v14 headless on the Electron build's own
  bundled Node 24 (system Node is 18), hiding `process.versions.electron` so Foundry does not
  try to open a desktop window and die on `app.setUserTasks`.
- `tests/playwright/foundry-launcher.js` — spawns through that shim, finds the repo-local
  install first, and ATTACHES to an already-running Foundry instead of fighting its data lock.
- `tests/playwright/msa-look.spec.js` — boots the world, waits for MSA's real load-completion
  signal, then writes viewport + canvas PNGs and a JSON summary (fps, GPU adapter, floors,
  console errors, MSA reports) to `tests/playwright-artifacts/look/`.
- `tests/playwright/map-shine-utils.js` — its readiness probe was V2-era (`MapShine.initialized`,
  `canvas.mapShine`, `MapShine.perf`), none of which exist in V3; it could never have returned
  and would have burned its timeout on every run. Now waits on `MapShine.__keyholeBooted`.
- A `msa-bench` system, an `msa-bench-world`, and a two-floor **Mythica Machina Mansion**
  scene built from the real 12,000×12,000 assets, with the upper floor's `visibility.levels`
  set so it renders the ground floor beneath it — the author's actual problem case.

*First capture, mansion, 1920×1080, both floors, Renderer=MSA:* **67 fps**, real
nvidia/ampere adapter, zero code errors. ⚠️ NOT comparable to the 18.1 fps baseline in
`Moonshot.md` §5, which is 3840×1906 while panning a benchmark route with effects configured.
Cold BC compression of the mansion measured ~52 s; a persistent Chrome profile keeps that
cache so later runs skip it.

**RESOLVED 2026-08-10 by Claude Fable 5.** Granted: Stage 0 gains item 0a-0 (countersigned
there). Book III's NOW list is left unedited — the harness is the floor every NOW item stands
on, not a queue entry beside them.

## SIGNATURES

- **Created** 2026-08-10 — Claude Fable 5, at the author's command, from the menu decision
  (staged 1 → 2) and the author's same-day calibration (fire nicely coming along; water most
  primitive; specular needs tuning; some things AHEAD of V2, lots PAR, lots TUNE).
- **Stage 0 countersigned closed** 2026-08-10 — Claude Fable 5, at the author's command, after
  inspecting the artifacts rather than the workers' summaries. Petitions P-001/P-002/P-003
  resolved the same pass; Law 11 added; Stage 1's reconcile clause amended. Still open from
  Book III's NOW list: the legacy cross-check sweep (Book II's ledger item — any model may run
  it).
- **Stage 1 countersigned closed** 2026-08-11 — Claude Fable 5, at the author's command, after
  re-reading the committed code, re-running the lab scenario by hand, and re-reading both gate
  artifacts from disk. Three text-vs-shipped deviations reconciled in S1.4's countersign; a
  wrong diagnosis retracted in the open; the bench STOP clause surfaced to the author and
  discharged by their explicit accept; one latent gate defect (boot-default assumption in both
  harness scripts) found during countersign and fixed. DEFERRED-S1a recorded: the per-cell
  interior split is built and tested but unconsumed — real untaken upside, named so it cannot
  rot.
- **The Reckoning opened** 2026-08-15 — Claude Fable 5, at the author's command: the
  upper-floor cost mystery (Bug #20's two zones at 9.5×/9.8×, fix `BUILT (unverified)`)
  escalated into a full-system audit campaign with its own holy document
  (`docs/holy/V4-Reckoning.md`): a 41-row census over all 259 runtime files, a pass protocol
  with twelve standard questions, a multiplier ledger, and fifteen seeded leads. Opening
  surveys archived in `docs/planning/reckoning/`. Registered in Book III's NOW list, slot 4.

## OPEN QUESTIONS TO THE AUTHOR

1. ~~Reference laptop's CPU model~~ — ANSWERED 2026-08-10: Ryzen 7 5800H, 16 GB RAM, 4K 120 Hz.
2. **Pillar ranking** by map-selling value (Book III's queue awaits your overwrite).
3. **Two proposed cuts** need your blessing: MovementPreview + SelectionBox (Foundry's job),
   and Prism-as-its-own-effect (returns as specular pattern content). Veto freely.
4. Where exactly the **vision-leak fix** sits in the queue (it defaults to NEXT, slot 5).

---

**P-009 â€” The perf report now answers its own diagnostic questions, the effect sweep is
retired from the default run, and one finding it produces contradicts P-008's addendum about
where residency's cost comes from.** Filed by Claude Sonnet 5, 2026-08-12, acting as a worker
under the Covenant. Prompted by the author directly: *"if you think the full performance
recording sweep contains a lot of time wasting efforts then streamline it. We need good data,
not useless data... make the performance report produce the answers you need automatically
because then it can monitor this situation and warn us if this sort of thing happens again."*
Commit `99b46c4`. `npm run verify` green, 8,725 tests (+212).

**FINDING 1 â€” the correction, and it is to this session's own predecessor.** The 2026-08-11
Residency Streaming Audit (Â§1, Â§6.4) and the P-008 addendum both concluded residency is *"a
latency/scheduling problem â€” how many sequential round-trips does loading incur, and can they
overlap"*, and ranked **parallelising the sequential `await` chains as "the larger win"**. That
conclusion is sound only for a window where the new-item path actually ran.
`residency.itemLoadDims`/`residency.itemLoadMasks` (`perf-zones.js:922-943`) open ONLY on
`ensureItemLoaded`'s new-item branch â€” the already-loaded branch returns before either bracket â€”
and `frame-profiler.js:477` emits **no row at all** for a zone that never fired. In the
2026-08-12 capture **both are absent while `residency.itemLoad` spent 6,189ms** (9.406ms mean
over 658 occurrences, peak 25.4ms). Zero new items loaded. Every call took the await-free fast
path. **Parallelising those awaits would have changed nothing on that window**, and the audit's
own Â§7 listed the numbers that would have shown this ("`itemLoadDims`/`itemLoadMasks` occurrence
counts â€” resolves steady-tax vs front-loaded-burst definitively") as still outstanding. They
were not outstanding; they were absent, and the absence WAS the answer. A new finding
(`residency-cost-is-not-io`) now says so in words on every future capture. **What this does NOT
say:** that residency is cheap, or that the concurrency work is wrong in general â€” only that
whatever those 6.19 seconds are, that window's cost is not the I/O the audit named, and the next
investigation must find what the pass does unconditionally per occurrence.

**FINDING 2 â€” the effect sweep is structurally incapable of its job and has been retired from
`perf-run-full`.** 18 configs, ~1.5-3 minutes, over half the action's runtime, and **zero usable
per-effect numbers across three consecutive real captures** â€” 15 of 15 rejected on 2026-08-12.
Not a tuning problem: it diffs two whole-frame GPU medians, so its floor is frame-scale variance
(7.3ms measured, against 12.8ms of its own opening-vs-closing baseline drift) while the effects
it prices cost ~0.5ms each inside a ~70ms frame. `includeSweep` is now `false` in boot's
`perf-run-full`; perf-lab remains wired and tested for anyone who wants it. The effects it was
the only route for (water, vegetation, fluid, grade) are now named by a new `effects-unpriceable`
finding as a **standing instrument gap needing a zone bracket** â€” their honest status, and more
useful than a column of rejected noise that made the gap look like bad luck.

**BUILT â€” `diag/perf-structural-ab.js`, and it settles S1.6/P-008's open early-Z question
without a second manual capture.** P-008 Finding 2 recommended toggling
`MapShine.setEarlyZComposition(false)` and re-running, explicitly *"for the author, not buildable
from this chair"*; Stage-1-Shade-Once Â§6.2's bench gate has only ever run on the far lighter
First-Floor scene (1.55x, under its own 2x bar). This arms the **zone** profiler in each toggle
state and diffs **per-zone** GPU, so it reports "earlyZPrepass cost X, worldDraw gave back Y"
rather than "the total moved". Three rules it enforces: **ON, OFF, ON**, so the two ON blocks'
disagreement IS the run's measured noise floor and a delta inside it earns no verdict; a
**representativeness check** comparing its parked-view zone numbers against the route window's,
which declines to generalise when they diverge; and **restore in a `finally`**. It also hides the
live UI for its duration â€” the perf HUD re-arms the profiler as a different owner ~4x/second and
`frame-profiler.arm()` throws on an owner mismatch, an exposure the sweep never had because it
never armed the profiler. `setStructuralToggle`/`readStructuralToggle` are new optional harness
hooks; the catalog lives in the diag module so it is Node-testable and so each toggle's QUESTION
travels with it.

**FIXED â€” the `geometry.depthDraw` anomaly P-007 flagged as "an unexplained outlier for three
rounds" and P-008 Finding 3 diagnosed but deliberately left alone.** GPU timestamps were
attributed to `profiler.currentSlot()` â€” the innermost open zone. `runSceneDepthPass` opens
`geometry.depthDraw` (`kind:'gpu'`) and then `geometry.depthRenderCall` (`kind:'cpu'`) around the
actual `renderer.render()`, so the depth pass's entire ~18ms/frame landed on a zone declared to
contain no draw calls, while the zone that exists to hold it read `gpuMs: null` â€” which the
report renders as "measurement failed", the exact opposite of what happened. `gpuTargetSlot()`
now walks to the nearest GPU-kind ancestor. **The attributed TOTAL is unchanged** (every sample
still lands in exactly one row, and `computeAttribution` sums every row), so coverage and the
residual are bit-identical; only the label moves. P-008 declined this as "sensitive, well-tested
measurement code for a labelling clarity gain" â€” reassessed because three separate investigations
have now had to re-derive it before they could read their own numbers, and a report-layer guard
(`zone-kind-contradiction`) stays behind to catch the next zone nested this way.

**FIXED â€” the hitch log was silently truncating, which violates this project's own stated rule
for every other ring.** `frame.hitchesDropped` has been READ by `perf-report.js` since it was
written and was produced by NOTHING, so `?? 0` quietly asserted no loss on every capture ever
made. Live proof in the 2026-08-12 report: `hangs.totalStalls` counted **630** frames over 50ms
from the profiler's own complete gap series, while `hitches.count` read exactly **200** â€”
`HITCH_LOG_MAX` to the digit. ~430 hitches discarded, reported as `dropped: 180`, all of it the
harmless display cap. Now produced, reset with the ring it counts, and split into `droppedByRing`
(real loss) vs `droppedFromReport` (display cap) so summing can never hide the first behind the
second again. `null`, not `0`, when a viewer cannot report it.

**BUILT â€” hitch/in-flight-zone correlation, which closes the audit's Â§5 method gap.** The
residency audit closed with 20 hitches of 250-667ms showing zero decode/cache activity, no
mechanism found, and the honest note that resolving it *"needs a live Chrome trace correlated
against `hitchLog` timestamps and residency in-flight windows"*. `frame-profiler.js#beginFrame`
is the only point where the frame gap and the open-zone stack are both in scope, so the
correlation now happens there â€” one comparison on the common path, a preallocated `Int32Array`,
no allocation. **It can only ever see zones that genuinely span frames** (the async residency
brackets), because every render-loop zone from frame N has closed by the time frame N's gap is
known at the start of N+1. That narrowness IS the question. **Both answers are findings**: a high
overlap is the first real evidence pointing at residency (with an explicit "overlap is not cause"
caveat and the occurrence-rate comparison a reader needs), and a **zero** overlap RULES IT OUT
and redirects the next investigation â€” which is worth as much, and is what the audit could not
establish at all.

**Also new, smaller:** `bottleneck` (GPU-bound vs not, at BOTH p50 and p95 because they disagree
on this capture â€” 94.4% vs 70.4% explained â€” and refusing to call the remainder "CPU time", since
mipmap generation and presentation are also outside `frame.gpuMs`); `duplicate-geometry`
(`geometry.earlyZPrepass` and `geometry.depthDraw` at identical 9.1 draws / 73,116.1 triangles,
~36ms/frame between them, previously unremarked in any report); `uniform-buffers-grew` (P-008's
own "open lead, not investigated this round" â€” 4.04x then, 3.13x now, still nobody's finding
until this one, and deliberately NOT called a leak). Plus a real bug: `estimateSweepNoiseFloor`
was called twice with different arguments (`perf-report.js:479` vs `:1207`), the second omitting
the measured floor â€” so the threshold the report PRINTED could disagree with the one its
rejections were actually made with. perf-lab's own header records that exact class of bug as
found and fixed once; this was it surviving in a second call site.

**NOT DONE, and named rather than left implied:** the epoch/temporal split of zone accumulators
(front-loaded burst vs steady tax) was designed and costed â€” widen the typed arrays to
`slots x EPOCHS`, recompute `epochBase` once per frame in `beginFrame`, ~10KB, zero allocation â€”
and NOT built this session. Finding 1 partly reframes the question it was meant to answer but
does not remove it. And nothing in this session was verified in live Foundry: it is 8,725 Node
assertions plus static wiring verification, and the author's next `perf-run-full` is its first
real execution.

---

**ADDENDUM to P-009, same day â€” the live regression P-009 itself shipped, fixed within the hour;
and the temporal split it left "NOT DONE" is now built.** Filed by Claude Sonnet 5, 2026-08-12.
Commits `779b135`, `efff64e`.

**The regression.** The author ran `perf-run-full` immediately after P-009 landed and hit it on
the first try: `waited 30s for 120 frames but only 0 were counted. The viewer is probably not
running â€” load a scene first.` â€” on a viewer rendering correctly. Root cause: `runStructuralAB`
called `harness.waitFrames(settleFrames)` for the toggle's settle period BEFORE
`harness.armProfiler(...)`. `createProfiledFrameWaiter` (`perf-session.js`) only advances while
the profiler is armed and receiving `beginFrame`/`endFrame` from the real render loop; at that
point in the sequence it was still disarmed (the main window's own teardown runs before this
function is ever reached), so the poll's count could never leave 0 regardless of real frame rate.
**Fixed** by arming once per block with the settle count baked in and running both waits inside
that one continuously-armed window â€” exactly the sequence `perf-session.js`'s own main window
already uses, and the same shape as a prior live incident this project fixed once before
(2026-08-11, the GPU zone timer race: *"arm only after `waitFrames(settleFrames)` proves frames
are actually flowing"*). The test fake had let `waitFrames` resolve unconditionally regardless of
arm state, which is exactly how this shipped past 62 passing tests; it now models the real
contract and pins the fix with a direct assertion that every `waitFrames` call across a full A/B
run has `armed:true`. Verified by temporarily reintroducing the bug and confirming the new test
throws the exact live error wording before restoring the fix. `npm run verify` green, 8,726
tests.

**The temporal split.** P-009 designed and costed this, then explicitly left it undone: *"widen
the typed arrays to `slots x EPOCHS`, recompute `epochBase` once per frame in `beginFrame`,
~10KB, zero allocation."* Built with one simplification found while implementing it â€” a full
N-epoch histogram was more than the actual question needs. The residency audit's own wording
("a steady cost... or a few expensive early passes dragging the average up") is a TWO-region
question, early vs. rest, not a fine-grained histogram, so the shipped design is a single
`earlyWindowMs` boundary (default 10s) rather than a configurable epoch count â€” simpler, cheaper,
and a closer match to what was actually asked. `frame-profiler.js` tracks, per zone, how much CPU
time landed within that boundary of the real post-settle window, classified by bracket OPEN time
so one sample is never split across two buckets. **CPU only, deliberately** â€” see the module's
own header for why GPU has no equivalent signal without a separate change to
`gpu-zone-timer.js`'s pending-uid bookkeeping, and the motivating question was CPU-only anyway.

`classifyTemporalShape` (`perf-report.js`) compares the ACTUAL early share against what a
UNIFORM zone would show for that window (`earlyWindowMs / durationMs`), not against zero â€” a
healthy steady zone still has some early cost, proportional to how much of the window "early"
covers. A new `temporal-shape:<zone>` finding fires in both directions: front-loaded (a burst â€”
settling, cache warm-up, a one-time setup cost) and back-loaded (thermal throttling, a growing
data structure, degrading cache behaviour), neither of which a flat mean over the whole window
would ever surface. Verified against the real 2026-08-12 numbers before writing permanent tests:
a fully front-loaded reading of `residency.itemLoad`'s 6,189ms verdicts `front-loaded` at 5.36Ã—
the expected share; the same total spread proportionally across the window verdicts `steady` at
exactly 1.0Ã— â€” confirming the design does not flag a healthy zone just for having any early cost
at all. `npm run verify` green, 8,758 tests.

**Both fixes are Node-verified only.** Neither has run against live Foundry yet â€” the author's
next `perf-run-full` is the first real execution of either.

---

**P-010 — "All four": a steady-zone spike finding, a window-composition diagnostic, a
pipeline-level rebuild probe, and the window-light occlusion gate — the last of which found and
fixed a real bug before it could ship.** Filed by Claude Opus 5, 2026-08-12, acting as a worker
under the Covenant. Prompted by the author directly, after a Chrome trace screenshot and three
questions: *"Looks like light accumulation is still the main performance bottleneck. Do you
agree? Investigate window light... Make the Early-Z part of the performance sweep."* — this
session answered with four numbered follow-ups, and the author's reply was *"All four — build
them - preferably make it so that I can run a performance report and give you all this
information."* Commits `41d72b7`, `2ae41bd`, `770a4ee`.

**BUILT — `steady-spike:<zoneId>`, the finding that names the shape behind the author's own
screenshot.** `pass.light.accumulate` and `light.pointLightUpdate` each read a healthy mean in
the 2026-08-12 capture (4.8ms and 0.76ms) while separately peaking at 32.7ms (6.8x) and 22.7ms
(30x) in the SAME window — invisible to every existing finding, because `dominant-zone`/
`bottleneck` only ever read the mean and `sparse-spike` only ever reads sparse-cadence zones. This
fires on any every-frame zone whose `max/mean` ratio clears 5x with a peak of at least 5ms — high
severity above 15x. A pass row's `cpuMs` is checked (an ordinary inclusive measurement); its
`gpuMs` is deliberately excluded, because `annotatePassResiduals` makes that column a residual,
not a total, and checking it would answer a different, uninteresting question — an early draft
excluded pass rows entirely and would have silently dropped the exact zone this exists to catch,
caught by hand-verifying against the real numbers before the permanent tests were written. The
finding names the shape, not the cause, and points at `shader-rebuild-churn`/`pipeline-rebuild-churn`
first — see below.

**BUILT — `window-surface-composition:<floorIndex>`, chasing a live anomaly (`drawCalls:4` where
the code predicts 1) that remains genuinely unresolved.** `getStatus()` now reports
`sceneChildCount`/`sceneChildren` per floor; the finding fires when a visible floor's count isn't
exactly 1. A Node test against the REAL vendored `three.webgpu.js` confirms the subsystem's OWN
construction is correct (one mesh, two triangles) — so if this ever fires, the anomaly is not in
how the mesh is built, and the mystery is narrowed to the live-runtime level, not solved.

**BUILT — `diag/pipeline-rebuild-probe.js`, one cache layer below `shader-rebuild-probe.js`.**
That probe answers "was the TSL node graph rebuilt"; this one answers "did that graph's shader
source need a brand-new GPU PIPELINE object" (`Pipelines._getRenderPipeline` to
`backend.createRenderPipeline`, synchronous and main-thread-blocking in the ordinary render loop)
— a graph can be perfectly cached while this cache still misses. Two designs were tried and
rejected before the shipped one: diffing `pipelines.caches.size` before/after fails because a
genuine rebuild can release the render object's previous pipeline in the SAME call that installs
the new one, netting `.size` to zero; a one-time wrap of `caches.set` goes silently dark after
`Pipelines.dispose()` (reachable from any renderer/context teardown mid-session) reassigns
`.caches` to a fresh Map. The shipped probe counts `.set()` calls directly via a wrap that
re-verifies and re-applies itself on every tracked `getForRender` call, so it survives a
mid-session `.caches` swap instead of quietly stopping. Wired through the same
auto-armed-per-report path as its sibling: `vt-pan-viewer.js` to `boot.js`'s `profileHarness` to
`perf-session.js` to a new `pipeline-rebuild-churn` finding — an id `steady-spike`'s own text
already named by anticipation before this probe existed to back it.

**BUILT, THEN A REAL BUG FOUND AND FIXED BEFORE IT SHIPPED — `gateGlass` on
`buildWindowSurfaceMaterial`, default OFF.** "ONE SUBSYSTEM PER FLOOR" (`vt-pan-viewer.js`,
2026-08-09) keeps every floor's window quad drawing for as long as that floor exists in the
scene, not just while it is viewed — so on a multi-floor map, every hidden floor pays the full
ten-simplex-tap glass field only to be zeroed by the floor gate at the very end. Follows
`specular-render.js`'s own proven `Fn()`/`If()` shimmer-gate idiom exactly: the maths must be
CONSTRUCTED inside the `If()` callback, not built outside and referenced, or (per that file's own
header) it hoists straight back out of the branch and skips nothing. The debug material's own
channels stay ungated always — `feedback_instruments_must_not_lie` — via a `buildGlassCookie()`
helper called once ungated (debug) and, when the gate compiles in, a second time inside the
branch (production only).

**The bug.** TSL's `Fn()` callback is deferred (`reference_tsl_fn_deferred_execution_trap`) — it
does not run when `buildWindowSurfaceMaterial` is called, only later, whenever three's
NodeBuilder first actually visits the graph (in practice, the mesh's first VISIBLE render).
`window-surface-subsystem.js` keeps the mesh hidden until its mask has finished loading and
`setMaskTexture()` has ALREADY been called once, asynchronously. The gated build's own `texture()`
taps, being constructed after that point, would have closed over the construction-time placeholder
texture forever — `setMaskTexture` can only update nodes that already exist, and a node built
later has no chance to receive an update that already happened. Found by tracing the actual load
sequence by hand, not by a failing test: no Node test can exercise a deferred `Fn()` callback's
body at all (no WebGPU device — the same ceiling `keyhole-tsl-constructs-in-node` already names),
so this would have shipped invisible to 8,899 green assertions and surfaced only as windows on
every floor rendering the wrong (stub) texture, live, in front of the author. **Fixed** with a
`liveMaskTexture` variable `setMaskTexture` updates in addition to its existing node loop, so a
`texture()` node built after the call still starts correct instead of depending on a retroactive
fix-up a not-yet-built node cannot receive. A test-only `debugGetLiveMaskTexture()` getter proves
the wiring moves, which is the most Node can prove of this fix at all.

**Live verification.** Two full `npx playwright test tests/playwright/msa-look.spec.js` runs
against the real Mythica Machina Mansion (two floors, real GPU) — one with `gateGlass:true` wired
in at the one call site, one with the shipped default — both completed with no crash and
structurally identical scene composition; a close pixel-region comparison found no difference
beyond one animated token's rotation phase (unrelated to window light, confirmed by inspection). A
third, more rigorous attempt — a same-technique adaptation of `stage1-earlyz-pixel-diff.mjs`'s
frozen-time, pixel-exact diff (`gateGlass` isn't live-flippable like `earlyZComposition`, so this
needed two separate frozen loads rather than one live flip) — hung with zero output after the
browser launched; Foundry's own server log shows login/game-ready succeeding in under 15 seconds,
so the hang is client-side in `map-shine-utils.js`'s wait chain, cause not diagnosed. Left
uncommitted at `tests/playwright-artifacts/look/capture-window-canvas.mjs` for whoever picks this
up next. **`gateGlass` ships default OFF** — this evidence is real but short of the pixel-exact
bar the Stage 1 precedent set, and per `feedback_safety_slide_outranks_doctrine` a shader
behaviour change earns the author's own eyes before defaulting on, not a worker's judgment call.

`npm run verify` green throughout, 8,899 tests. All four items the author asked for are built and
wired into a single `perf-run-full`/`gateGlass` combination — nothing here requires a second
manual step to observe, except turning `gateGlass` on, which is deliberately left to the author.

---

**P-011 — The residency "already-loaded" mystery, chased across four rounds since 2026-08-09 and
never closed, is CLOSED: root cause found, fixed, and proven live at 677×.** Filed by Claude
Sonnet 5, 2026-08-12, acting as a worker under the Covenant. Prompted by the author directly:
*"focus all your attention on 'The mystery that keeps coming back' — residency and streaming...
Dig deep, kill this performance problem at long last please."*

**The root cause.** `ensureItemLoaded` (`vt-pan-viewer.js`) is declared `async` even though its
"already loaded" branch (`itemStates.get` hits — the OVERWHELMING common case on a cache-warm pan,
confirmed zero new items by three separate captures running: P-008, its addendum, and this
session's own report) does no asynchronous work at all — a `Map.get`, a field write, a small
bounded loop. **That doesn't matter.** An `async function` always returns a Promise, and `await`
on a Promise — even one already resolved — always defers its continuation to the microtask queue.
That is correct, spec'd JavaScript, paid in full on every one of the ~5 already-loaded items PHASE
1's loop awaits, every single residency pass, whether or not anything needs to wait for anything.
On a busy frame, that deferred continuation shares the microtask queue with whatever else has
promise work pending at that instant — and the zone's wall-clock bracket (genuinely elapsed real
time, not a measurement bug; see this loop's own pre-existing comment on the closely related
draw-call-sampling contamination the 2026-08-11 audit already found) counts however long the
queue takes to drain, not just this item's own turn.

**How it was found — instrument before optimizing, the same move S2.6 just used on
`light.pointLightUpdate`, aimed at this system instead.** A new zone, `residency.itemLoadExisting`
(`perf-zones.js`, `ensureItemLoaded`'s existing-branch bracketed on its own), isolated the ONE
branch of this function nobody had directly measured. A real `perf-run-full` capture (Ground
Floor, 565 passes, 4,382... — window varies, see raw JSONs) read **`residency.itemLoadExisting`:
0.002ms mean, 6.2ms total** across the whole capture — genuinely trivial, exactly as every static
reading since 2026-08-09 always said. Against that, `residency.itemLoad` (the zone wrapping the
WHOLE per-item loop) totalled **3,828.3ms** the same capture. **6.2ms of measured work inside a
3,828.3ms bracket — 99.8% unaccounted for by any code inside `ensureItemLoaded`, on either
branch.** It was never in a branch body. It was the `await` boundary itself.

**The fix.** `ensureItemLoaded` split into three: `tryGetLoadedItem(item)` — the SAME already-
loaded logic, verbatim, now a plain synchronous function, no `async`, no Promise, ever;
`loadNewItem(item)` — the genuinely-new-item path, unchanged, still `async`, still pays real
`await`s for real I/O; `ensureItemLoaded(item)` — kept as a thin combined wrapper, byte-identical
behaviour to before, for its other two callers (the one-time initial scene load and the background
floor-prewarm loop — both already async top to bottom, both unaffected). **Only PHASE 1's own loop
changes**: it now calls `tryGetLoadedItem` first and only falls through to `await
ensureItemLoaded(item)` when that returns `undefined`. A pass where every item is already
loaded — the ordinary case, this whole loop long — now awaits **zero times** instead of once per
item.

**Evidence, before → after, same machine, same bench Mansion, same route (raw JSONs:
`tests/playwright-artifacts/look/perf-run-full-result.json`, overwritten between runs — numbers
transcribed here before the second run replaced the file):**

| zone | before | after |
| --- | --- | --- |
| `residency.itemLoad` mean | 6.776 ms | **0.01 ms** |
| `residency.itemLoad` total | 3,828.3 ms | **4.6 ms** |
| `residency.itemLoadExisting` mean | 0.002 ms | 0.001 ms (unchanged, as expected — its own body was never touched) |

**A 677× reduction in the zone's own mean cost**, from a change that touches nothing but WHERE an
`await` happens, not what any branch computes. `npm run verify` green throughout both edits,
9,112 tests, unchanged count (this is a scheduling change with no new branch a test doesn't
already cover for both states). No new console errors in either live capture (the one present,
`boot VRAM severance — canvasInit proxy registration failed`, is the same pre-existing, unrelated
failure DEFERRED-S1b's own evidence already named).

**Proof the real I/O path is untouched, not just unbroken:** the AFTER capture happened to include
two genuinely new items (`residency.itemLoadDims`: 2 occurrences, 487.25ms mean, 936.8ms max) —
real network fetches, front-loaded in the capture's first 10 seconds (a fresh session's initial
settle), costing real time exactly as they should. `loadNewItem` was never touched by this fix and
this is direct, live evidence it still works.

**Honest caveats, named rather than buried:**
- **fps is NOT the proof here, the zone number is.** avgFps varied across this session's several
  back-to-back captures (42.5 / 73.6 / 49.6) purely from ordinary machine-load noise (P-003's own
  standing rule: these need an idle machine to compare cleanly) — nowhere near clean enough for an
  fps-level before/after claim. The zone-level number is the trustworthy one: it isolates exactly
  the code path that changed, is immune to whatever else the machine was doing, and moved 677×.
- **The AFTER capture's own `hitches-overlap-zone` finding still shows `residency.pass` open
  during 90% of that run's hitches.** This is NOT a sign the fix failed — it is the two genuine
  new-item loads above, each a real ~487ms-average network wait, which legitimately stall whatever
  frame they land in. That is the Aug-11 audit's OWN separately-flagged, separately-risk-tagged
  lever (§6 item 4, "parallelize the sequential per-item/per-mask await chains") — real, still
  open, deliberately NOT touched by this fix, which was surgical: kill the cost paid for NOTHING,
  leave the cost paid for something real exactly as it was.
- **Not yet the author's own LIVE verdict.** Built, tested, measured twice live by this worker;
  the two-word doctrine (`BUILT (unverified)` vs `LIVE`) means this is the former until the author
  loads a real scene and looks. No revert flag exists — like DEFERRED-S1b, this is a pure
  scheduling/allocation change with no semantic branch to gate behind one; correctness rests on
  `tryGetLoadedItem` being a verbatim extraction (checked by re-reading both versions side by side
  during this edit) plus the two live captures above, not a byte-diff gate.

**What remains genuinely open, so the next reader doesn't assume this closes residency
entirely:** the sequential-await-chain cost for GENUINELY new items (audit §6 item 4) is real,
risk-tagged, and untouched; `uniform-buffers-grew` (10-27× across four separate sightings now,
2026-08-11 ×2, this session ×2) remains a live, un-investigated lead; whether the 20-worst-hitch
mystery from the original audit's §5 has any OTHER cause besides genuine new-item loads is still
not fully separated out. This petition closes the specific, named mystery the author asked for —
"already loaded, still costs 10ms" — not every open question about residency.

**Author LIVE verdict, Ingram, 2026-08-12 — "Nothing seems to be broken by it and performance on
the upper floor is hovering around 30-35 fps. That's a serious improvement."** Promoted from
`BUILT (unverified)` to `LIVE` by the author's own eyes on the real Mansion, upper floor — the
harder of the two floors by every measure this Testament has taken (multiFloor comparisons
throughout Book I). No revert flag exists to record a default flip against; this verdict IS the
promotion.

---

**ADDENDUM to P-011, same day — the fix's own before/after comparison exposed a second layer of
the identical bug, one level up the call stack, not yet fixed.** Filed by Claude Sonnet 5,
2026-08-12, acting as a worker under the Covenant, while building a requested before/after
comparison report.

A fresh `perf-run-full` capture (same route, same floor, ~78 minutes after the P-011 fix landed)
confirms `residency.itemLoad` holding at **9.6ms total this window vs the ORIGINAL baseline's
9,492ms — a 989× reduction**, matching the earlier mid-session proof closely. But
`residency.pass` — the zone wrapping the entire residency system — still cost **7,028.9ms**.
Before the fix, that number was ~98% explained by `itemLoad` alone. Now, with `itemLoad` fixed,
only **~1.6%** of it (~116ms) is accounted for by anything residency does — **the other ~98.4%
was always there, invisible behind the bigger cost, not introduced by this fix.**

**Code-verified, not guessed:** `scheduleResidencyUpdate` (`vt-pan-viewer.js:11349`) does exactly
`await updateResidencyUnguarded()` inside its `do`/`while`, bracketed by `residency.pass`. `update
ResidencyUnguarded` is still declared `async` (correctly — it genuinely needs to await real I/O
when new items appear) — which means **every single call to it still pays the identical
unconditional-microtask-yield tax P-011 just proved costs real time**, one level higher up the
stack than the fix already reaches. The shape is exact: same "always-async wrapper around
mostly-synchronous work" pattern, same mechanism, different call site.

**Not yet fixed, and harder than P-011's fix was:** phase 1's loop could be split cleanly because
the CALLER (the loop) already knows, per item, whether real async work is needed.
`scheduleResidencyUpdate` doesn't have that luxury — `updateResidencyUnguarded` is one function
whose OWN body decides, mid-execution, whether it needs to await anything, and the caller can't
peek that in advance the same way. A fix here likely needs `updateResidencyUnguarded` to signal
back synchronously when it did no real async work, so the do-while can skip the outer await on
that path — a real design question, not a one-line change.

**Honest caveat, stated plainly:** this session's own numbers drifted a lot from ordinary machine
load across four captures on the same route (avgFps 42.5 / 73.6 / 49.6 / 35.5) — confirmed via
`geometry.worldDraw`, untouched by any fix this session, itself costing 21% more in this same
capture (9.185ms → 11.086ms) with byte-identical geometry submitted. Some of `residency.pass`'s
remaining 7,028.9ms could be that same drift landing on an async boundary rather than a fixed,
reproducible cost. The CODE MATCH is exact and load-bearing; the MAGNITUDE claim is not yet proven
to P-011's own standard and needs the same live before/after treatment before anyone spends a fix
on it. Flagged as the clear next target, not yet chased.

---

**SECOND ADDENDUM to P-011, same day — chased, fixed, and proven live: ~33× on `residency.pass`
itself.** Filed by Claude Sonnet 5, 2026-08-12, acting as a worker under the Covenant. Prompted by
the author directly: *"You've made great progress and already you've identified the next
suspicious culprit. Investigate and fix please."*

**The fix.** `updateResidencyUnguarded` is no longer `async`. It now runs its full synchronous
prefix (coarse-pin budget, cover-alpha priming, both `depthAuthority.rebuild` calls, vegetation
ranking, stale-item release) exactly as before, then attempts PHASE 1 as ONE synchronous scan:
every item resolves through `tryGetLoadedItem` (P-011's own sync fast path) into a `stateById`
Map; an item that ISN'T loaded yet is collected into `pendingItems` rather than awaited inline, so
the scan itself never creates a Promise. **If `pendingItems` is empty — the ordinary case — the
whole pass, including PHASE 2 and the depth-proxy rebuild, finishes right there and the function
returns `null`.** Only when at least one item is genuinely new does it call the new
`loadPendingResidencyItems` (async, awaits each SEQUENTIALLY, never parallelised — deliberately
unchanged from the original loop's behaviour, per this exact suspension point's real history of
live regressions) and return that Promise. `scheduleResidencyUpdate`'s own `do`/`while` now reads:
`const pending = updateResidencyUnguarded(); if (pending) await pending;` — the `if` is load-
bearing, since `await null` still costs the same microtask tick this whole change exists to stop
paying. PHASE 2's body was extracted, unchanged line-for-line, into `finishResidencyPass`, called
by both the synchronous-complete path and the async continuation, so there is exactly one copy of
that logic rather than two that could drift — `states` is rebuilt from `items`' own order via
`stateById.get`, not from insertion order into the Map, so the final list is byte-identical in
shape to what the single original loop produced regardless of which path resolved which item.

**Evidence.** `npm run verify` green throughout, 9,116 tests (net +4 over this session's other
commits, unrelated to this change — no new tests were written for a pure control-flow/scheduling
change with no new branch a test doesn't already cover for both the sync-complete and async-
continuation shapes; same reasoning DEFERRED-S1b and P-011's own first fix already used). A live
`perf-run-full` capture, same bench Mansion, same route: **`residency.pass` — 7,028.9ms → 213.9ms,
a 32.9× reduction**, and against the session's ORIGINAL baseline (9,742.3ms) a **45.5× reduction**.
Genuinely new items still load correctly and pay real cost exactly as before — this same capture's
`residency.itemLoadDims` fired twice, 480ms mean, real network I/O, unaffected by this change. No
new console errors (the one present, `boot VRAM severance`, is the same pre-existing, unrelated
failure named in DEFERRED-S1b). **The hitch-correlation picture changed too, not just the number:**
this capture's `hitches-overlap-zone` finding now names `residency.itemLoadDims` (genuine new-item
I/O) at only 1.3% overlap with hitches — residency no longer dominates that finding at all, a
completely different shape from every earlier capture this session where residency's own cost was
the loudest signal in the report.

**Honest caveat, stated as plainly as the last one:** this capture's WHOLE-FRAME numbers
(avgFps 29, 93 hitches) look worse than the immediately-prior capture, and should NOT be read as
this fix regressing anything — two confounds, both checked, not assumed: (1) this specific capture
reports a DIFFERENT internal render resolution (1920×1080@1×, 2.07 Mpx) than every other capture
this session (3840×1906@1.5×, 7.32 Mpx) — a cause not chased down, flagged as its own open
question, not this petition's to solve; (2) even correcting for that, `geometry.worldDraw` — the
same untouched control zone the first addendum used — costs roughly double per-megapixel here
versus earlier in this exact session (≈2.82ms/Mpx vs ≈1.51ms/Mpx), consistent with real
accumulated machine/thermal load after several hours of continuous back-to-back captures in one
sitting, not with anything this fix changed. The zone-level number (`residency.pass` itself, the
thing this fix actually touches) is the trustworthy signal, exactly as the first addendum already
argued; this capture is further confirmation of that reading, not a contradiction of it. **Not yet
the author's own LIVE verdict** — built, verified by `npm run verify`, and measured live twice by
this worker; the two-word doctrine still applies. Recommend a fresh machine/browser restart before
trusting any further WHOLE-FRAME number from this session — the zone-level numbers don't need one,
the frame-level ones do.

---

**P-012 — Sharpening (Albedo Clarity) has no task in this plan: given a real UI, a real disable
switch, and accurate cost tracking, on the author's own direct instruction.** Filed by Claude
Sonnet 5, 2026-08-15, acting as a worker under the Covenant (a worker may not add plan tasks).

Author directive, this session: the CAS zoom-out sharpen was console-only, possibly visually
misaligned, and untracked in `perf-run-full`. Asked for a Make-panel tab, an attractive-but-smooth
look, and accurate cost tracking. Proceeded under "the author's word overrides the queue" — no
existing Book I/II task named this effect.

*What was built and proven:*
- **Extracted `vt/albedo-clarity.js`** out of `vt-pan-viewer.js` (schema + state + the two
  node-building functions, now exported) — the shader lab needs to import the real functions
  directly, and importing all of `vt-pan-viewer.js` risked pulling in Foundry-coupled transitive
  imports a standalone lab page has no business loading. `shouldUseFullAlbedoClarity()` (genuinely
  Foundry-settings-coupled) stayed in `vt-pan-viewer.js` on purpose.
- **Diagnosed the "too harsh/ringing" report with real instruments, not guesses.** Built
  `tools/shader-lab/bench-albedo-clarity.js` (3 scenarios, real BC1 encoder, real GPU). The leading
  hypothesis (CAS amplifying BC1 quantization noise in flat regions) measured out **negligible**
  (~1.01–1.03× on real hardware) — a real, kept negative result, not silently discarded. Climbed to
  the real harness next (`tests/playwright-artifacts/look/run-albedo-clarity-look-test.mjs`, real
  bench Mansion, on/off/high-sharpness captures at two zoom levels) and found the REAL mechanism by
  eye: at sharpness 0.4, every edge in the scene shows dramatic rainbow fringing. Traced to source:
  `buildAlbedoClarityNode`'s ringing guard (`amp`/`w`) is computed as `vec3` — PER CHANNEL — so R/G/B
  each get an independently-computed sharpen weight; confirmed numerically in the lab on a real
  coloured edge (R/G/B changed by −43%/−83%/−53% at the same boundary texel at the shipped default).
  Two candidate luma-locked fixes were tried and did NOT cleanly resolve the divergence in testing
  (the gamma-2.0 round trip complicates a uniform luma delta) — **left the algorithm UNCHANGED**
  rather than ship an unverified fix (`feedback_defensive_fix_needs_same_proof_as_bug`). The finding
  is preserved as a real, re-runnable regression scenario
  (`chromatic-fringing-on-a-coloured-edge`, deliberately reporting `fail` today, same convention
  `bench-floor-lighting.js`'s own "MUST FAIL, TODAY" scenario uses) for whoever builds the real fix.
- **`ALBEDO_CLARITY_PARAMS`** (6 knobs: sharpness/gateLo/gateHi/farLo/farHi/farFloor) + a real
  "Sharpening" card in the Make (Workshop) panel (`boot.js`), following Wind's *mechanics* (a direct
  get/set pair, no `effectRegistry`) with Grade's *substance* (a real schema + a real enable
  toggle) — deliberately NOT promoted into the full effect-registry/manifest/cascade system, a
  decision independently reached by two research passes and then CONFIRMED by
  `params/no-dead-controls`/`perf-zones.test.mjs`'s own "every EFFECT_ZONING key is a registered
  effect id" check (tried adding one, got a real, correct test failure, removed it — documented
  inline rather than silently worked around).
- **A real disable switch**, `enabled` on `_albedoClarity`: instant on screen (writes the live
  uniform to 0, keeps the stored sharpness for re-enabling) and — extending
  `shouldUseFullAlbedoClarity()` — compiles the taps back out entirely on the next material build,
  same "next scene load" cadence the existing performance-tier gate already established.
- **A real measured GPU-ms cost**, landing in `perf-run-full` as `report.sharpeningAB`
  (`src/diag/perf-sharpening-ab.js`) — a NEW restart-based structural A/B, not a rider on
  `perf-structural-ab.js`'s own orchestration loop (named "sensitive, well-tested measurement code"
  by this Testament; only its pure, already-exported math is reused). Necessary because
  `shouldUseFullAlbedoClarity()` is a material-build-time shader-graph fork with no rebuild-in-place
  path below a full `stopVtPanViewer`/`startVtPanViewer` cycle (confirmed by grepping every
  `registerAction` for a lighter alternative — there isn't one). Bolted onto the finished report
  after every `runProfileSession` sweep (same shape `multiFloor`/`rapidStressSweep` already use),
  NOT threaded through `buildPerfReport` — that path runs up to 3× per `perf-run-full` call, which
  would have meant 12+ restarts instead of 4. Gated OFF by default
  (`MapShine.setSharpeningAbEnabled(true)` to arm it) — the real cost of 4 full viewer restarts has
  never been measured live before this session, so the first real capture with it enabled IS the
  timing experiment that decides the default.

*Evidence:* `npm run verify` green throughout (9,457 tests, +52 new — 2 new suites,
`vt/__tests__/albedo-clarity.test.mjs` and `diag/__tests__/perf-sharpening-ab.test.mjs`, both
registered in their directory's `run-tests.mjs`, not just written). The restore-path test caught a
real bug before it shipped: the fake harness modelled `restartViewerWithAlbedoClarityForce`'s
documented resolved-`{ok:false}` failure shape, and the first draft's `.catch()`-only error
handling missed it entirely — fixed to check both the resolved result and a genuine throw.

*The first live capture, 2026-08-15:* `perf-run-full` with the A/B armed ran clean end-to-end
(`ok:true`, all 4 restarts succeeded, camera held) in **458s total** (the whole report — base
route, floor-2 route, rapid-stress route, multi-floor sweep, rapid-stress sweep, AND this new
phase; no isolated before/after wall-clock split was captured this run, so that total should
not be read as "the A/B alone costs 458s" — a real gap, named rather than implied away). The
measurement itself did exactly what `compareAbBlocks` is built to do when a run is genuinely
inconclusive: **`verdict: "within-noise"`**, delta 0.211ms against a 0.809ms noise floor
(needed 1.5×, i.e. ≥1.21ms, to call it either way) — its own `note` says so in plain words:
*"NO VERDICT... that is not 'no difference' — it is 'this run could not tell'."* One real,
usable data point survived anyway: `geometry.worldDraw` itself — the exact zone hosting the
5-tap CAS graph — measured 3.513ms (full CAS) vs 3.515ms (flat read), a −0.001ms "delta" that
is effectively zero on hardware nowhere near idle (this dev machine, mid-session, not the
quiet-machine precondition `feedback_playwright_fps_not_yet_trustworthy` already names for
trusting an FPS number — the same caution applies here). Read plainly: **the CAS sharpen may
simply be cheap on this hardware** (plausible — this project's own perf audit already found
bandwidth is not the binding constraint by roughly 16×, so five extra texture taps landing
inside an already-bandwidth-slack budget costing near-zero is not a surprising outcome) —
but this ONE run cannot promote that from "plausible" to "measured," and says so honestly
rather than rounding a coin-flip into a verdict. `MapShine.setSharpeningAbEnabled` stays
OFF by default pending a re-run on a genuinely idle machine, per the mandate the harness itself
was built under. One incidental finding worth naming, not burying: a single `THREE.Error
resolving queries: AbortError... Buffer was unmapped before mapping was resolved` surfaced in
console output from `WebGPURenderer.dispose()` during one of the four restarts — non-fatal
(the run completed `ok:true` regardless) but the first time this codebase has torn down and
rebuilt the renderer four times in rapid succession, and a real signal that
`stopVtPanViewer`'s disposal path has at least one in-flight-GPU-resource race under that
specific stress. Not chased further this session — named for whoever next touches restart
teardown.

The Make-panel card and disable switch, independently confirmed live: `railBtnFound:true`,
`cardFound:true` in the DOM at first check, and — because that check's own full-panel
screenshot cut off before scrolling to an `order:91` card sitting below Bloom, a gap caught by
looking at the actual pixels rather than trusting the DOM query alone — a second, scroll-
targeted capture confirms the card renders with real live values, not a broken or empty shell.
The toggle round-trip (`enabled:true → false → true`) held every other field
(`sharpness/gateLo/gateHi/farLo/farHi/farFloor`) exactly steady across both flips — no
cross-talk with unrelated state.

**Honest caveats, named rather than buried:**
- The chromatic-fringing root cause is real, characterised, and NOT fixed — the shipped look is
  unchanged from before this session (byte-identical unless the author says otherwise), and the new
  Sharpening card's live Sharpness slider is the interim answer: the author can now dial it to taste
  against a real scene directly, rather than waiting on a fix.
- The 458s figure above is the WHOLE report, not the A/B phase isolated — a clean before/after
  wall-clock split (arm it off, time a run; arm it on, time a run; subtract) is the next thing
  needed before deciding whether this default should flip to on, alongside the idle-machine
  re-run the noise floor itself is asking for.
- `docs/planning/Bug-Tracker.md` and several `src/effects/*.js` files show as modified in this
  working tree from a clearly separate, concurrent session (not this petition's work) — flagged so
  a future reader of `git blame` on this commit range isn't confused about attribution.

Not yet the author's own LIVE verdict on the look — `BUILT (unverified)` until Ingram loads the
real Mansion and looks at the new card / the (unchanged) sharpen look himself.
