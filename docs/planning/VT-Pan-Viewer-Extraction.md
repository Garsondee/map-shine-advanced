# EXTRACTING `vt-pan-viewer.js` — the 11,957-line god-object, split safely

**Status:** IN PROGRESS, 2026-07-26. Steps 1-3 (Sun shadows, Vegetation shadows, Point-light pool) DONE — see §7-9. Step 5 (Diagnostics) also DONE — see §10 — done OUT OF ORDER (§2's stated order runs 4 before 5); step 4 (whole-image loading) remains open. Author-requested after the size ratchet was bumped three times in one session; steps 2-3 done as Phase 0a of the Water rebuild, step 5 done as the unblock for Water Phase 2d, both `docs/planning/Water.md`.
**Standing doctrine, renegotiated 2026-07-26:** memory `feedback_ratchet_proactive_not_reactive` — a frozen file/function must be split BEFORE a feature phase touches it, as planned prep, never discovered as a mid-task blocker and never fixed by loosening the cap.
**Companions:** `Skeleton.md` (the enforcement doctrine), `Engine-Postmortem.md` §3, `Keyhole.md` §4.2, memory `keyhole-god-object-forming`.

---

## 0. The one sentence

> **`startVtPanViewer()` is a 10,484-line function — bigger than V2's `FloorCompositor` (10,063), the corpse this project exists to avoid. It grew because every subsystem it hosts needs 5–20 of its closure locals, and no seam ever forced those locals to be named.**

The cure is not "move code to another file". It is to **name the handful of things each subsystem actually needs**, hand them in, and get an object back. Once the dependency is written down as a parameter list, the code can live anywhere.

## 1. Why it grew (so the split does not just re-grow)

`startVtPanViewer` is one closure holding ~40 mutable locals: `renderer`, `scene`, `allocator`, `dimensions`, `view`, `THREE`, `shadowHandle`, `windHandle`, `envLight`, `sceneColor/illum/lit/coloration`, a dozen `let` caches, and the whole item-state `Map`. Every new effect reaches into that bag directly. That is *locally* the cheapest possible thing to do every single time — which is exactly the mechanism `v2-postmortem-the-failure-modes` describes, and precisely why a size wall (not taste) is what caught it.

**The rule for this work:** a subsystem may not be "extracted" while still reading closure state. If the extraction does not produce an explicit parameter list, it has not happened.

## 2. Extraction order — smallest blast radius first

Ordered so each step is independently shippable and independently live-testable. **Each step ends with the ratchet going DOWN**, which is the objective proof it worked.

| # | Subsystem | Est. lines | Why this order |
| --- | --- | --- | --- |
| 1 | **Sun shadows** (`bakeCasterTexture`, `bakeSunShadowField`, `maybeBakeSunShadow`, 6 constants) | ~250 | Newest, best-understood, already has its own pure core + render module + report. Its closure deps are few and already half-named. Lowest risk, and it is the code most likely to keep changing — getting it out first stops the bleeding. |
| 2 | **Vegetation shadows** (`attachVegetationTileShadow`, `vegetationShadowPadPx`, `syncVegetationShadowUniforms`, `padPlacement`, smear constants) | ~400 | Self-contained, has its own tests, and is the other actively-churning area. Shares `setTileGeometry` — that stays behind as a viewer primitive and is passed in. |
| 3 | **The point-light pool** (`updatePointLightMeshes` + entry lifecycle) | ~700 | Big, but its inputs are already an explicit list (`darkness01`, `activeRegions`, `env`, …) because it was written as a function, not inline. Mostly mechanical. |
| 4 | **Whole-image loading** (`ensureWholeImageMeshes`, `refreshWholeImageItem`, the load chain) | ~900 | Large and gnarly (device-loss hardening, BC compression, the serialized chain). Do it once the pattern is proven three times. STILL OPEN — step 5 landed first (§10) because it was the concrete Water Phase 2d blocker; this row's own reasoning (large, gnarly, wants the pattern proven first) is unaffected and still applies whenever it is picked up. |
| 5 | **Diagnostics assembly** (`getDiagnostics`'s body) | ~700 est., 533 actual | ✅ DONE 2026-07-26 (§10), taken OUT OF ORDER — see §10's own note for why skipping step 4 was safe here specifically. |

Stop after any step. There is no half-broken intermediate state — each is a complete move.

## 3. The shape every extraction takes

The precedent already exists in this codebase and should be copied exactly, not reinvented — `buildEnvironmentalLightMaterials`, `buildBloomMaterials`, `buildSunShadowBakeMaterial` are all this shape:

```js
// effects/lighting/sun-shadow-subsystem.js
export function createSunShadowSubsystem({
  THREE, renderer, allocator,        // the engine
  dimensions,                        // the world rect
  envLight,                          // the ONE shared rect uniform (never a copy)
  getCasterHeightField,              // injected seam, already exists
  getSunShadowRenderState,           // injected seam, already exists
  getMaskAuthorityVersion,
  getShadowHandle,                   // () => shadowHandle — a GETTER, see §4
}) {
  // …all the state that is currently viewer-closure locals lives HERE…
  return {
    texture,                         // for envLight/point lights to sample
    rectUniform,
    maybeBake(floorIndex),           // called once per frame by the viewer
    getStatus(),                     // for the report
    dispose(),
  };
}
```

The viewer then holds **one** local instead of eleven, and its frame loop reads:

```js
sunShadows.maybeBake(view?.floorIndex ?? 0);
```

## 4. The four traps, named in advance

1. **⚠️ MUTABLE LOCALS READ LIVE.** `shadowHandle` is *reassigned* every time the sky changes; `casterTexture` is swapped on rebake. Passing the **value** captures a stale one — the exact class as `feedback_residency_sync_vs_render_loop` and the wind-overlay freeze in `wind-access.js`'s own header. **Pass a getter, or return a setter.** Never a bare value for anything that is reassigned.
2. **⚠️ SHARED UNIFORMS MUST STAY SHARED.** `envLight.uSunShadowRect` / `uViewRect` / `outdoorsTexNode` are deliberately one object read by several materials (bloom, grade, point lights). An extraction that "tidies" these into per-module copies silently splits the map in half — `buildOutdoorsGate`'s own doc is about exactly this. Pass the node, never rebuild it.
3. **⚠️ DISPOSE ORDER.** The viewer's teardown disposes targets and textures in a specific order and nulls the closure locals. Each subsystem needs its own `dispose()`, called from the existing teardown — and `BufferAttribute` still has no `dispose()` (`reference_bufferattribute_no_dispose_trap`).
4. **⚠️ TDZ.** This session hit `Cannot access 'SUN_SHADOW_FIELD_DIM' before initialization` from exactly this kind of movement. Constants must be declared before first use, and in a module they simply move with their subsystem — which is one of the real wins here.

## 5. Verification per step (non-negotiable, in order)

1. `npm run verify` green — necessary, **not sufficient**: this session proved twice that Node tests cannot execute the viewer's real closure (both live crashes were invisible to a green suite).
2. **The ratchet goes DOWN.** `npm run ratchets:update` must record a SMALLER number. If it does not, the extraction moved text without moving dependencies.
3. **Author loads a real scene.** Non-negotiable for anything touching render-target wiring — the `.target`/`.samples` crash was only ever findable this way.
4. Diff review for trap #2: grep that no `uniform(` call appeared in the new module for something the viewer already owned.

## 6. What this is NOT

- Not a rewrite. Every extracted line should be the same line, in a new home, with its dependencies named. Behaviour changes and extractions must never share a commit — that is how a regression becomes unattributable.
- Not a chance to "improve" the extracted code. Note improvements, land them after.
- Not `boot.js`. That is a second god-object (4,115 lines / `install()` 3,500) with the same disease and it deserves its own plan, after this one proves the pattern.

## 7. Step 1 — DONE, 2026-07-25

`effects/lighting/sun-shadow-subsystem.js` (`createSunShadowSubsystem`) now owns everything §0 described: the 5 constants, the caster/field state, `bakeCasterTexture`/`bakeSunShadowField`/`maybeBake`, the status report, and (new) a real `dispose()` — see §7.3.

**Ratchet went down**, the plan's own objective proof: `vt-pan-viewer.js` file 11,957 → 11,718, `startVtPanViewer()` 10,484 → 10,255. `npm run verify` green (3,949 assertions, 28/28 structural rules).

### 7.1 A fifth trap, found live (not in the original four)

`renderer-state/graph-only` and `gpu/textures-in-vt-only` are scoped by **directory**, not by call pattern: they allow `.setRenderTarget(`/`new ...Texture(` only inside `vt/`, `graph/`, `diag/`. The sun-shadow bake does both (the march's render-to-target, the caster field's `DataTexture` upload) — legal only because that code used to live inside `vt-pan-viewer.js`. Moving the literal call sites into `effects/lighting/` tripped both walls immediately; this was not anticipated by the original 4-trap list.

**Fix, not a workaround:** the two GPU-touching operations became caller-supplied callbacks — `renderSunShadowPass(target, quad)` and `createCasterTexture(data, w, h)` — defined in `vt-pan-viewer.js` (so the literal `.setRenderTarget(`/`new ...Texture(` text stays inside `vt/`, exactly where both walls already sanction it) and invoked by the subsystem, which only decides *when* to bake and *with what data*. This is the same shape as the pre-existing `getCasterHeightField`/`getSunShadowRenderState` seams, and it is literally the frame-graph pattern the walls' own `instead:` text prescribes ("a pass declares reads/writes and is HANDED a target"), applied one step early.

**Add this as trap #5 for steps 2-5:** any extracted subsystem that allocates a render target's *texture* or calls `setRenderTarget` directly will trip these two walls the moment it leaves `vt/`. Check for both patterns in the code being moved BEFORE writing the new module's signature, not after `verify:structure` fails.

### 7.2 The leak this step fixed

Confirmed while extracting: neither `sunShadowRt` nor `sunShadowBake.material` had ever been disposed anywhere in `vt-pan-viewer.js` — every Stop/Restart cycle leaked one 1024² RGBA8 render target and one NodeMaterial. The subsystem's new `dispose()` fixes it; wired into `disposeActive()`'s list as `disposeSunShadows()`, same one-method-per-subsystem pattern as `disposeSceneColor`/`disposeLighting`.

### 7.3 Live-verified

2026-07-25, author loaded a real scene after steps 1-3 all landed: nothing broke. Sun shadows, vegetation shadows, and the point-light pool (candles, wind response, animated lights, sun-shadow sampling) all confirmed live in one pass — see §9.4.

## 8. Step 2 — DONE, 2026-07-25

`effects/vegetation-shadow-subsystem.js` (`createVegetationShadowSubsystem`) now owns: the 6 constants (`VEG_SHADOW_RENDER_ORDER_MAGNITUDE`, `VEG_SHADOW_SMEAR_TAPS`, and 4 more), `padPlacement`/`vegetationShadowPadPx` (pure, exported standalone — `setTileGeometry` and the Case-2 overlay build both still need them), and `attachTileShadow`/`syncUniforms` (the old `attachVegetationTileShadow`/`syncVegetationShadowUniforms`). Trap #1 confirmed live: `shadowHandle` is reassigned on every sky change (`vt-pan-viewer.js`), so it's taken as `getShadowHandle: () => shadowHandle`, not a value. Traps #2 (no new `uniform(` calls) and #5 (no `setRenderTarget`/`new *Texture`) both checked clean.

This step's before/after numbers are folded into a single large checkpoint commit (`e092f6d`) alongside ~150 files of previously-uncommitted V3 work, so a clean isolated delta isn't recoverable from git history — the honest number is step 3's, below, measured against that checkpoint as the baseline.

## 9. Step 3 — DONE, 2026-07-25

`effects/lighting/point-light-pool.js` (`createPointLightPool`) now owns: `lightScene`/`colorationScene` (exposed properties, read directly by the render loop), `lightMeshes`/`candleWallClipCache` (exposed Maps, read by wind-rebake marking and by `getPointLightsInfo` diagnostics — deliberately untouched, see §2 row 5), `INITIAL_LIGHT_FAN_VERTICES`, and `update()`/`dispose()` (the old `updatePointLightMeshes`/`disposePointLights`).

**Ratchet went down**, against the checkpoint baseline: `vt-pan-viewer.js` file 11,957 → 11,009, `startVtPanViewer()` 10,484 → 10,270 (well under its own frozen budget — no `ratchets:update` needed). `npm run verify` green (3,949 assertions, 28/28 structural rules).

### 9.1 A deliberate non-move: `uGlobalTimeMs`

The one shared animation-clock TSL uniform is written ONLY by this pool but read by roughly a dozen unrelated consumers (the wind sim's input bundle, vegetation motion sync, several TSL light-animation builders, diagnostics). Moving it into `point-light-pool.js` alongside its one writer would mean every unrelated caller reaching back into "the point-light module" for a general-purpose clock — the wrong owner, chosen only because that's where the one write happens to live. It stays a `vt-pan-viewer.js` primitive (like `dimensions`/`scene`), taken by this pool as a plain value.

### 9.2 Trap #6, found live: nesting doesn't shrink the ratchet's measurement

The first draft split the ~150-line "build a brand-new light entry" block into a function NESTED inside `createPointLightPool`'s own closure (so it could read `lightScene`/`envLight`/etc. for free). `verify-structure.mjs`'s `largestTopLevelFunction` measures the brace span of the outer, COLUMN-0 function only — a nested `function` declaration doesn't create a second measured span, it just adds lines to the one that already exists. The nested version made the violation WORSE (502 → 520 lines), not better.

**The fix:** `createLightEntry` had to become a genuine top-level (column-0) function, which meant every value it used to close over — `THREE`, `envLight`, `sunShadows`, `sceneColor`, `uGlobalTimeMs`, `lightScene`, `colorationScene` — became an explicit parameter instead. More verbose at the call site, but this is arguably the correct shape anyway: `createLightEntry`'s full dependency list is now written down rather than implicit, which is the extraction plan's own §1 rule applied one level deeper than the plan's own examples show.

**Add this as trap #6 for steps 4-5:** if a subsystem's own function is still over the 500-line cap after extraction, splitting a piece of it into a function nested INSIDE that same factory buys nothing — measure against the outer, column-0 span. The split must go all the way to top-level, with its dependencies named explicitly, same as the subsystem itself.

### 9.3 A real behavior-change caught before it shipped

The first draft of `dispose()` replaced the original's per-resource `try { ... } catch (err) { log.error(...) }` (log and continue to the next entry, always `.clear()` at the end) with `throw new Error(...)` on first failure. That is a real behavior change bundled into what was supposed to be a pure extraction — worse, on a real dispose failure it would now skip disposing every remaining entry AND skip the final `.clear()`. Caught by re-reading the diff against the original before running it, not by a test (a thrown dispose error has no test coverage either way). Restored to the original catch-log-continue shape, with `createLogger('PointLightPool')` replacing the viewer's own `log` reference.

### 9.4 Live-verified

2026-07-25, author loaded a real scene: nothing broke. Confirms steps 1-3 together — point lights, candles, wind response, and sun-shadow sampling all reconcile through this pool in the same pass as sun/vegetation shadows.

## 10. Step 5 — DONE, 2026-07-26 (taken out of order)

`vt/vt-pan-viewer-diagnostics.js` now owns `_active.getDiagnostics()`'s entire former body: `buildViewerDiagnostics(args)` (the orchestrator), plus three helpers it calls — `computeLayerResidency`, `buildDrawList`, `summarizeWholeImage` — each split out from what was already a self-contained loop or IIFE in the original, not a line cut arbitrarily to satisfy a count. `percentileMs` and `sampleDiagnostics` (two more viewer-closure functions with zero free variables of their own) moved wholesale alongside it and are now Node-tested (`vt/__tests__/vt-pan-viewer-diagnostics.test.mjs`) — the first real test coverage anything in this extraction has gotten, since the two are genuinely pure.

**Ratchet went down, by a lot:** `vt-pan-viewer.js` file 11,085 → 10,559 lines, `startVtPanViewer()` fn 10,345 → 9,835 — **~510 lines of headroom**, comfortably enough for Water Phase 2d's ~20-line body-pack wiring, which is exactly what this step exists to unblock. `npm run verify` green (4,120 assertions, 17 suites, 28/28 structural rules) with **zero new debt registered** — the auto-tightened budgets moved down on their own (see the ratchet-persistence fix below).

### 10.1 Why step 4 was skipped, and why that was safe specifically here

§2's stated order runs whole-image loading (step 4) before diagnostics (step 5) — "easiest once the subsystems above expose status objects" assumed sun shadows/vegetation/point-lights would be the ONLY subsystems `getDiagnostics` reads. Reading the actual 533-line body found it also reads whole-image state (`s.wholeImage`, `wi.status`, `wi.tiles`, …) directly off `itemStates` — but only as PLAIN DATA already sitting in that Map, never through anything step 4 would have introduced (there is no whole-image "subsystem object" yet to call `.getStatus()` on; the loader is still inline). So step 5 had no real dependency on step 4 having landed first — it depends on `itemStates`' own shape, which step 4 will not change (an extraction is required to preserve exact behavior, per §6). Skipping was a genuine independent move, not a shortcut.

### 10.2 A stale comment corrected in passing

`getDiagnostics`'s own call site (§ the zoom-thrash test's cheap read) carried a comment claiming it "does a real GPU readback (gl.readPixels + a full indirection-buffer scan)". Reading the actual body top to bottom found no such call anywhere: `sampleDiagnostics` (the indirection-buffer scan) reads `pack.buf`, a plain JS-side array already in memory — genuinely synchronous, zero GPU touch. The real pixel-readback path (`readRenderTargetPixelsAsync`) lives in a SEPARATE, async, click-triggered tool (the pixel probe, `MapShine.probePixels`) that `getDiagnostics` never calls. The comment was stale from an earlier version of the file; not corrected in the moved code (extractions preserve text, per §6) but worth recording here so a future reader trusts the actual body over the old comment.

### 10.3 The ratchet-persistence bug this step's own detour found

Extracting `mask-authority-report.js` earlier the same session (Water Phase 2c prep) shrank `mask-authority.js` under its frozen function budget, and `verify-structure.mjs` printed `✅ size/fn — ... budget tightened 607 → 606` — but the next run printed the SAME line again. All three ratchet families (rule counts, size, uniform budgets) computed the tightened value correctly and simply never wrote it: persistence only happened under `--update-ratchets`, contradicting the tool's own header ("a DECREASE auto-tightens the bound... never claims virtue it does not have"). Fixed the same day, downward-only (loosening still requires the loud explicit path) — see memory `feedback_ratchet_proactive_not_reactive` for the full renegotiation this was part of. This step's own ~510-line shrink is the first extraction to have its tightening actually persist without a manual `ratchets:update` run.

### 10.4 Trap #7, found while planning this step (not in the original six)

Before touching a 533-line function inside an 11,000-line file, its free-variable set was mapped PRECISELY (name, declaration site, mutable-vs-stable) before writing a single line of the new module — using an Explore agent rather than hand-transcription, specifically because a body this dense with forensic comments has zero room for a silent copy error. The destructured parameter names in the new module are IDENTICAL to the original bare identifiers, so the 500-line body needed no internal rewrites at all, only a new signature line — the lower the textual diff, the lower the chance a transcription mistake survives review. **Add this as trap #7: before extracting a large, closure-heavy function, get an authoritative dependency table first (agent-assisted if the count is large), and keep the moved body's internal variable names unchanged — rename at the call site, never inside the body being moved.**

### 10.5 Live-verified

2026-07-26, author loaded a real scene and pasted the full diagnostics report: **every field populates**, including all three extracted helpers' outputs (`layerResidency`/`layerResidencyTotals`, `drawList` with live-vs-rendered token deltas all at 0, `wholeImage` with per-item compression and the sun-shadow block). `lastError: null`, `renderMsAvgLast120: 1.12 ms`, frame gap P99 8.5 ms. This was the same pass that live-confirmed Water Phase 2, since water's own report reads through this function.

Which closes §5's verification list for this step: verify green ✅, ratchet down ✅ (−526 file / −510 fn at the time of the move), real scene ✅, no new `uniform(` calls ✅.

---

_The size wall did its job: it caught a 10,484-line function that every other rule in the file called healthy. The wall is not asking for tidiness — it is asking for the dependency list nobody has ever had to write down._
