# Effect Tier Gradient Audit — 2026-08-29

**Ask (Ingram, verbatim intent):** (1) check every effect against the graphics performance-tier system — is the tier ladder actually being used, how much, and how; (2) plan a gradient per effect so the lowest graphics setting has almost everything disabled *except* the parts that cost almost nothing (the "water tint should still show" case) — find what's genuinely near-free per effect and keep only that at the floor.

**Method:** 5 parallel research passes (one per effect cluster) over `src/effects/`, each verifying every claim against current source — never against `docs/planning/*.md` or `docs/holy/*.md`, which this project has repeatedly found to lag shipped code (see `feedback_holy_docs_go_stale`). Every finding below carries a file:line citation traceable in the passes' own transcripts. Companion deliverable: a plain-language Artifact for the ranked summary, per the confirmed report format (`feedback_performance_report_format`).

**Scope:** the 15 effects registered through `src/effects/effect-cascade.js`'s `PERFORMANCE_PROFILES`/`tiers` cascade, plus precipitation, which turned out to sit entirely outside that system — 16 items total.

---

## 1. The system, briefly

`src/effects/effect-cascade.js` defines `PERFORMANCE_PROFILES = ['low','performance','standard','quality','extreme']` (rank 0–4). Every registered effect has a manifest (`src/effects/effect-manifest.js` validates the shape) carrying two independent axes:

- **`enabledFromProfile`** — the lowest profile at which the effect exists at all. Below it, `resolveEffectEnabled()` returns `false` (subject to a GM/player on/off override that can still force it).
- **`tiers`** — an array of rungs `{n, fromProfile, cost:{class}, adds}`, answering *how much* of the effect draws, given it's on. Tier 0 has no `fromProfile` — it's the unconditional floor ("the effect placed correctly, at its cheapest"), not part of the ladder proper. Tiers 1..N each declare the lowest profile that buys them and a cost class that must be non-decreasing from tier 1 up. `resolveEffectTier()` returns the highest *contiguous* affordable rung.
- **Cost classes**, cheapest→priciest: `C0` constant · `C1` ALU · `C2` resident texture read · `C3` graph read · `C4` virtual-texture read · `C5` dependent read (reads a target another pass wrote this frame) · `C6` extra render target · `C7` per-frame simulation · `C8` extra geometry/draw call.

**The known failure mode** (documented in `effect-cascade.js`'s own header): in the past, 14 effects declared a `tiers` ladder that nothing ever read — rungs existed on paper with no code behind them. This audit's central question, for every effect, is whether that has happened again.

---

## 2. Master table

| Effect | `enabledFromProfile` | Rungs | Consumption | Floor cost today | Category |
|---|---|---|---|---|---|
| WATER | low | 0–5 | ✅ CONSUMED — 5 real `if(activeTier>=N)` gates | Minimal (mandatory C4 mask read + C1 tint) | Leave alone |
| VEGETATION | low | 0–6 | ✅ CONSUMED incl. new tier 6 | Minimal (C1, no draw call) | Leave alone |
| SUN_SHADOWS | performance | 0–3 | ✅ CONSUMED (resize+rebuild+rebake live) | OFF entirely below `performance` | Leave alone |
| CANDLE_FLAME | low | 0–4 | ✅ CONSUMED, 2 call sites, best-tested ladder | Flame ~free; light maximally merged | Leave alone |
| LIGHTNING | low | 0–3 | ✅ CONSUMED across 3 files | Bursty, near-zero time-averaged | Leave alone |
| APERTURE_GOBO | low | 0 only | Moot — genuine shipped zero-cost bypass | Zero when no aperture nearby (the common case) | Leave alone |
| DOOR_GRAPHICS | low | 0 only | Moot, near floor already | Cheap per-fragment; one extra render pass when doors exist | Leave alone |
| UI_WINDOW_SHADOW | **extreme** | 0 only | Moot; already the cheapest shape for this class | Folded into existing shader, zero extra draw calls | Leave alone |
| **SPECULAR** | low | 0–5 | ⭐ **WIRED 2026-08-29** — `perfTier` now reaches the render seam | `low`/`performance` → tier 3 (shimmer+parallax+life, no islands/sun-sky); `standard`+ unchanged (tier 5, same as before) | **Reconnected (P1) — `BUILT (unverified)`** |
| **FLUID** | low | 0–5 | ⭐ **WIRED 2026-08-30** — `fluidTierPlan` gates 4 branches + the sim's own per-frame tick | `low`/`performance`/`standard` all now genuinely cheaper (tiers 0/1/3 — no real fill-simulation or structure marbling below `quality`); only `quality`/`extreme` (tier 5) are byte-identical to before, since NOTHING was gated pre-fix | **Reconnected (P7) — `BUILT (unverified)`** |
| **FIRE** | low | 0–5 | ⚠️ Still only clusterFactor + flicker wired (unchanged) — ⭐ manifest text FIXED 2026-08-29 to describe this honestly instead of the deleted volumetric material | Sprite layer flat-cost/untiered; only light-cluster count + flicker vary | **Docs fixed (P6) — reconnecting the other 4 axes not attempted** |
| **WINDOW** | low | **0–1** | ⭐ **WIRED 2026-08-29** — tier 1 ('glass') now reaches `glass` | `low` → cookie + tint only; `performance`+ unchanged (glass on, same as before) | **Split (P3) — `BUILT (unverified)`** |
| **GRADE** | low | 0 only | ⭐ **FIXED 2026-08-29** — LUT texture no longer compiled in at all (was always-dead weight, not tier-dependent) | ALU chain (cheap, unchanged) — LUT sample now genuinely absent, at every profile | **Fixed (P5) — `BUILT (unverified)`** |
| **BLOOM** | low | **0–1** | ⭐ **WIRED 2026-08-29**, construction-time only (not live) | `low` → 4-mip pyramid; `performance`+ unchanged (6-mip, same as before) | **Built (P4) — `BUILT (unverified)`** |
| **DEPTH_OF_FIELD** | low | **0–1** | ⭐ **WIRED 2026-08-29**, construction-time only (not live) | `low` → 2-mip pyramid; `performance`+ unchanged (4-mip, same as before) | **Built (P4) — `BUILT (unverified)`** |
| **PRECIPITATION** | *(no manifest)* | *(none)* | ⭐ **`tierScale` FIXED 2026-08-29** — now genuinely derived from the profile, no manifest still (out of scope) | `low`/`performance` now genuinely reduce live particle count (0.4×/0.7×); `standard`+ unchanged | **tierScale fixed (P2) — manifest gap still open** |

---

## 3. Category detail

### 3.1 Leave alone (8 of 16)

These are correctly designed and correctly wired. Touching them is out of scope for this plan — the project's own anti-drift tests (candle/vegetation/water/sun-shadow each have a dedicated cross-check block in `effect-tier.test.mjs`) exist specifically to catch a regression here, so any future edit must keep passing them.

- **WATER** (`src/effects/water/water.js:919` etc.) — the reference implementation. Tier 0 is a mandatory C4 mask read plus a C1 tint/opacity blend (`WATER_TIER0_TINT`, `water-render.js:324`) — genuinely the "water tint survives" case already shipped.
- **VEGETATION** (`vegetation.js:698`) — floor is placement + vertex sway only, C1, no draw call; flutter/shadow/torque-sway all layer on above it, fully wired through `vegetationTierPlan`.
- **SUN_SHADOWS** (`sun-shadows.js:275`) — the one effect correctly OFF entirely below `performance`, by explicit author directive quoted in the manifest itself.
- **CANDLE_FLAME** (`candle-flame.js:204`) — the model example: its ladder targets light *count* (via `clusterFactor`), the actually-expensive axis, while the flame sprite itself is ~600× cheaper and stays on unconditionally.
- **LIGHTNING** (`lightning.js:640`) — bursty by nature; the expensive rung (an actual point light, tier 3) is correctly isolated from the cheap procedural bolt path.
- **APERTURE_GOBO** (`aperture-gobo.js:338`) — `aperture-gobo-render.js:265`, `if (!(apertureCount > 0)) return null;` compiles zero gobo graph for the common no-aperture case. A real, shipped, load-bearing zero-cost path.
- **DOOR_GRAPHICS** (`door-graphics.js:69`) — near-minimal already; the only real cost is a dedicated render pass when doors exist at all, unrelated to tier.
- **UI_WINDOW_SHADOW** (`ui-window-shadow.js:145`) — folded into an existing composite shader with zero extra draw calls; already the cheapest possible shape for a screen-space decal.

### 3.2 Reconnect a ladder that already exists (3 of 16) — P1, P6, P7

The design work is done; the wiring is not.

- **SPECULAR — ⭐ FIXED 2026-08-29, `BUILT (unverified)`.** Was: `specular-registration.js:114-116`'s `getRenderState()` (the only seam the live path calls, `boot.js:10621`) returned `{enabled, params, layers, debugChannel}` — `perfTier` was captured into a UI-only readout (`:90-99`) and dropped before it reached rendering; `buildSpecularSurfaceMaterial` took no tier parameter, so all six shimmer layers, parallax, drift/pulse and sun-azimuth bias constructed unconditionally at every profile. The shader's own comment calls its cellular base "the DOMINANT COST OF THE WHOLE EFFECT" (`specular-render.js`), measured ~3.4ms at half today's layer count.
  **Now:** `getRenderState()` forwards `perfTier`; a new `specularTierPlan(tier)` (mirrors `candleTierPlan`/`vegetationTierPlan`) gates shimmer (tier 1 — skips the Worley/Perlin base entirely), parallax (tier 2), life/drift+pulse (tier 3), islands (tier 4 — swaps the texture sample for the same `(1,0)` global-parallax placeholder used pre-bake), and sun/sky bias (tier 5), each a JS-time branch (Effects.md Law 4), not a uniform multiply. `specular-surface-subsystem.js` rebuilds the whole material on a tier change, mirroring `water-surface-subsystem.js`'s own `buildSurfaceForTier` — needed because specular's material is a singleton built once, not per-tile like vegetation's. `SPECULAR_DEFAULT_TIER = 5` (the max rung) is asserted equal to what `standard` resolves to, so `standard`/`quality`/`extreme` are byte-identical to before this fix; only `low`/`performance` (both → tier 3) genuinely lose islands + sun/sky bias, the intended trade. Two re-push bugs (mask-crop bounds, debug bake-status uniform going stale after a rebuild) were caught by tracing the frame by hand and fixed before shipping. `npm run verify` green (12,506 tests, incl. a new specular anti-drift block). **Not yet seen live** — needs Ingram's own check that `standard` looks unchanged and that `low`/`performance` genuinely show less shimmer without breaking, given this file's 12-round history of subtle regressions on a *different* axis (visual correctness, `keyhole-specular-built`).
- **FIRE** — `fire-subsystem.js`'s own header (lines 9-24) states the volumetric slab-integral material the manifest's `tiers[].adds` text describes ("billow," "plume," sheet/slice counts) was fully replaced by a sprite/particle system on 2026-08-09; `buildFireMaterial`/`buildFireGeometry` are exported but never imported by the live viewer. What *is* wired: `fireTierPlan(tier).clusterFactor` (light-merge aggressiveness) via `point-light-pool.js:1199-1210`, and `animation.quality` (0–2) feeding the shared candle-flicker path. `fire.js:379`'s own comment already names the real lever: *"a fire costs what its LIGHT costs"* — `lightEnabled` is a separate param today, not a tier axis, and could become the natural tier-0 floor concept once the manifest is rewritten to match reality.
- **FLUID — ⭐ FIXED 2026-08-30, `BUILT (unverified)`.** Was: `fluid-render.js`'s `buildFluidSurfaceMaterials` had no tier parameter and zero `if` statements in the file; `fluid-surface-subsystem.js` never passed one — identical failure shape to specular, every profile paying full tier-5 cost. **Now:** see ranked action #7 below for the full account — a new `fluidTierPlan(tier)`, resolved by Ingram's own "visible, minimal cost" instruction after this section's original blocker (tier 1 vs tier 2's disagreement over who owns the shared pack read) was settled.

### 3.3 No cheap floor exists yet — needs building (4 of 16) — P3, P4, P5

These effects are honestly single-rung (only tier 0 is declared), so there's nothing to "reconnect" — the gradient itself doesn't exist yet. Two of the four (`BLOOM`, `DEPTH_OF_FIELD`) already *name* this gap in their own `deferredRungs`.

- **WINDOW** (`window.js:334-374`) — the clearest match for the "water tint" case in the whole audit. Tier 0 bundles a cheap daylight tint (`window-render.js:701`, one CPU-resolved `vec3` multiply) and highlight shoulder together with an expensive glass subgraph — 5 `simplexFloat` noise taps for the thickness field (`:463-477`) plus prism/fake-caustic math — and never separates them. The code already has a `glass: true/false` switch (`window-render.js:177`) that would skip all of it; it's simply never called with `false` (`window-surface-subsystem.js:194-216`). **The fix is almost entirely wiring, not new design**: promote the tint/shoulder to the real floor, gate `glass` behind a new tier 1 (`fromProfile: 'performance'` or higher).
- **GRADE** (`grade.js:148`) — the primary color-ops chain (exposure/contrast/saturation/temperature/tint, `grade-ops.js:278-309`) is already pure C1 ALU and already always-on — effectively the "tint" ideal already shipped. The one non-ideal part: a 3D LUT sample (C2) runs every frame against a placeholder identity texture even when the effect is "disabled" (`grade-present.js:132-159`, `vt-pan-viewer.js:5536-5544`) — a compile-time or profile-gated skip when `lutStrength≈0` would let this effect genuinely reach zero marginal cost, which it currently cannot.
- **BLOOM** (`bloom.js:234`) — `deferredRungs` (`:263-266`) already names the plan: *"governor-driven resolution scale + mip count per performance profile."* Today it's binary — full 6-mip Jimenez/COD pipeline or a genuine zero-cost full-pass skip when disabled (`vt-pan-viewer.js:6994`). No partial/cheap mode exists between those two states.
- **DEPTH_OF_FIELD** (`depth-of-field.js:143`) — same shape and same self-named gap (`:173-176`) as bloom; already has *two* real zero-cost early-outs (disabled, or ground floor). Separately confirmed still live: `maxBlur` is functionally inert at realistic floor counts (`depth-of-field-blur.js:97-111`; the cap only binds past ~20 floors at shipped defaults) — a real bug, unrelated to tier structure, worth fixing alongside.

### 3.4 Outside the tier system entirely (1 of 16) — P2

- **PRECIPITATION** — no file under `src/effects/precipitation/` contains `enabledFromProfile`, `visualWeight`, or any cascade keyword; it has no manifest and never passes through `effect-cascade.js`/`registry.js`. Cost is governed by two axes today, neither of them hardware-budget-aware: weather intensity (`precip01`, a content dial) and a per-species zoom-sleep LOD (`precip-subsystem.js:274-302`, visibility-driven, fires identically at every profile). A third axis, `resolveSpeciesFrame(..., tierScale)`, is explicitly documented in its own JSDoc as *"the effect cascade's own budget multiplier"* (`precip-species.js:1206`) and is genuinely multiplied into the live particle-count formula — but its one producer, `getPrecipRenderState()` (`vt-pan-viewer.js:3373`), hardcodes `tierScale: 1` as a literal. **This is worse than an absent lever — it reads as wired in its own documentation and isn't.** Precipitation is confirmed live (`sync()` runs every frame, `vt-pan-viewer.js:13077-13082`) and actively growing (P1 live, P2–P7 built), so this gap will only get more expensive to close the longer it's left. Also has no GM/player enable override and no `a11y.photosensitive` gate — both real parity gaps once precipitation's effect surface grows further (a future flash/lightning-adjacent species would need the a11y gate specifically).

---

## 4. The gradient — what LOW buys today vs. after this plan

Only effects that need to change are listed; the 8 "leave alone" effects already have the shape this column describes.

| Effect | LOW today | LOW after the fix |
|---|---|---|
| SPECULAR | Full shimmer/parallax/islands/sun-bias shader (~3.4ms), same as extreme | Tiers 1–3 only (shimmer + parallax + life, all C1) — islands and sun-bias (C3) reserved for `standard`+ as declared |
| FLUID ✓ | Full sim + iridescence + marbling, same as extreme | Tint/glow only, flat cross-section (tier 0) — the round cross-section itself waits for `performance`; film/fill/structure reserved for `standard`/`quality` |
| FIRE | Sprite always full-cost; only cluster factor + flicker vary | Same, but `lightEnabled` becomes an explicit tier concept and the manifest text matches what actually renders |
| WINDOW | Full glass warp/prism/caustic + tint, same as extreme | Flat cookie: mask + daylight tint + highlight shoulder only — glass gated to `performance`+ |
| GRADE | Always-on ALU chain + LUT sample | ALU chain stays on (it's the "tint"); LUT sample skipped entirely at low/zero-strength |
| BLOOM | Full 6-mip pipeline or fully off | A real cheap rung — fewer mips / half-res chain, as bloom's own `deferredRungs` already specifies |
| DEPTH_OF_FIELD | Full 4-mip pipeline or fully off (below ground floor) | A real cheap rung — fewer mips, as DoF's own `deferredRungs` already specifies |
| PRECIPITATION | Identical particle count on any hardware at a given weather+zoom | `tierScale` genuinely derived from the performance profile |

---

## 5. Ranked action list

1. ~~**Wire SPECULAR's existing ladder into the render path.**~~ **✅ DONE 2026-08-29**, `BUILT (unverified)` — see §3.2. Needs Ingram's live check before calling it closed.
2. ~~**Fix precipitation's `tierScale` hardcode.**~~ **✅ DONE 2026-08-29.** Added `precipTierScaleForProfile(profile)` (`precip-species.js`) — reads the raw performance profile directly (precipitation has no manifest of its own, the same "no manifest" shortcut `shouldUseFullAlbedoClarity` already established elsewhere in `vt-pan-viewer.js`), returns `1` at `standard`+ (unchanged), `0.7` at `performance`, `0.4` at `low`. Wired into `getPrecipRenderState()`'s own `tierScale` field, replacing the literal `1`. `npm run verify` green, incl. 7 new Node tests. **The larger follow-up — giving precipitation a real manifest, GM/player override, and a11y gate — is still open**, out of scope for this specific fix.
3. ~~**Split WINDOW's cookie from its glass.**~~ **✅ DONE 2026-08-29.** Added a real tier 1 ('glass', `fromProfile: 'performance'`) to `window.js` — the shader-level JS-time branch already existed (`window-render.js`'s `glass` construction flag), it just needed a resolved tier reaching it. `window-registration.js` now forwards `perfTier`; `window-surface-subsystem.js` gained a rebuild-on-tier-change mirroring specular's (needed because window's material, like specular's, is a long-lived singleton per floor, not rebuilt per-frame) — including re-pushing the mask-crop bounds and the world→UV ratio, both normally set once on mask load, after a rebuild. `npm run verify` green, incl. a new anti-drift block and an updated regression-guard test that used to assert the ladder stayed at exactly one tier.
4. ~~**Build the mip-count ladder BLOOM and DEPTH_OF_FIELD already name as deferred.**~~ **✅ DONE 2026-08-29.** Both effects' own shader builders (`bloom-render.js`, `depth-of-field-render.js`) turned out to already be fully generic in mip count — no shader changes needed. The gap was entirely in `vt-pan-viewer.js`: it always built and looped the full pyramid (6 mips bloom, 4 mips DoF) regardless of profile. Added a construction-time-only profile read (bloom/DoF's own new tier 1, `fromProfile: 'performance'`) that decides a shorter pyramid (4 mips / 2 mips) for `low` — render targets stay allocated at the full count either way (avoids touching the allocator), only the composite material's texture count and the downsample/upsample loop bounds are tier-sliced. **Construction-time-only, not live** — a profile change needs a scene reload to take effect, the same accepted limitation `vegetationTierPlan` already documents for itself; recorded as `deferredRungs.liveMipRebuild` in both manifests. `npm run verify` green, incl. a fix to an unrelated diag test that hardcoded bloom's old single-tier cost value.
5. ~~**Skip GRADE's LUT sample when it can't matter.**~~ **✅ DONE 2026-08-29.** `buildGradePresentMaterial`'s own `lutTexture ? texture3D(...) : null` branch already existed; `vt-pan-viewer.js` simply stopped feeding it the identity placeholder. Safe because `GRADE_LOOK_PARAMS` itself confirms `lutName`/`lutStrength` are "deliberately not declared yet" — no control anywhere can ever push LUT strength above its built-in-zero default until the `bundled-lut-loading` rung ships a real asset loader, so the fetch this compiled in could never have contributed anything. Not a tier change — applies at every profile equally. `npm run verify` green.
6. ~~**Rewrite FIRE's manifest to match its real (sprite) architecture.**~~ **✅ DONE 2026-08-29.** Rewrote all six `tiers[].adds` strings to describe what's actually wired — `clusterFactor` (light-merge aggressiveness) and `animation.quality` (clamped 0..2, so rungs 2-5 differ from each other in `clusterFactor` alone; the flicker axis maxes out at rung 2) — instead of the retired volumetric material's sheet/slice counts. Left `fromProfile`/`cost.class` boundaries and the (now-stale-for-a-different-reason) `estMsPerMp` numbers untouched — reclassifying those is a real measurement/design task, not a documentation fix, and inventing new numbers without a bench would be a worse lie than a labelled-stale true one. Promoting `lightEnabled` to a real tier concept (as this list originally floated) was NOT done — it's a user-facing param today, not a tier gate, and folding it into the ladder is a design decision for Ingram, not a documentation fix. Documentation-only change, no behavior difference; `npm run verify` green.
7. ~~**Wire FLUID, or keep deprioritizing it.**~~ **✅ DONE 2026-08-30**, `BUILT (unverified)`. Unblocked by Ingram's own resolving instruction: *"fluid should be visible in some way at the lowest setting but we need minimal cost to do that."* That settled the internal inconsistency this item was stuck on (tier 1's `adds` text claimed its cylinder shading rode on "a read tier 0 already paid for," while tier 2's own text claimed to own that same pack read, and the code showed only ONE real fetch, `fluid-render.js:278` pre-fix, feeding both) — the pack read now gates behind tier 1 (moved `fromProfile: 'low'` → `'performance'`, `cost.class: 'C1'` → `'C4'`, ceiling logic matching tier 4/5's own precedent in this file), and tier 0 alone (the mandatory mask read + flat tint/glow, unconditional at every profile, unchanged by this fix) is what now genuinely satisfies "visible, minimal cost" — a flat-shaded but real, correctly-tinted, correctly-glowing tube, not round-looking until `performance`+.
   **New `fluidTierPlan(tier)`** (`fluid-render.js`, mirrors specular/window's own shape) gates four JS-time branches: `cylinderEnabled` (t≥1: the pack fetch, `across`, cylinder thickness, wall rim), `filmEnabled` (t≥3: iridescence phase, needs nothing new — pure ALU on tier 1's own outputs), `fillEnabled` (t≥4: the REAL simulation dependent-read, `stateTexture`/meniscus), `structureEnabled` (t≥5: τ + the noise fetch). No `flowEnabled` for tier 2 ('flow') — honestly, it has no shader content of its own left to gate (its own text now says so plainly): `s` arrives as a side effect of tier 1's own fetch, and the windowing it used to own moved to `fill` before this ladder was ever wired. Below each gate, a coherent flat fallback (`thickness=1`, `fill=1`, `rim=0`, `tinted=uTint`, `marbled=tinted`, `grain=1`, `meniscus=0`) keeps the FINAL composition math (`body`/`radiance`/`opticalDepth`/`transmit`) completely untouched — only the inputs feeding it change shape.
   **The other real cost — not just the shader.** Unlike specular/window, fluid's most expensive rung (`fill`, C5) is not only a shader-graph cost: it is a genuine per-frame GPU simulation TICK (`fluid-surface-subsystem.js#prepareSimTick`'s advect render pass), running unconditionally regardless of tier before this fix. Added a tier-gated early return there too — below tier 4 the tick (and its real draw call) is skipped entirely, eliminating the effect's single largest per-frame cost at `low`/`performance`/`standard`. The sim's own one-time VRAM allocation (`buildSim`) stays unconditional, deliberately, to keep this fix scoped to the real per-frame win rather than adding a second rebuild lifecycle to manage.
   **Live wiring, fluid-shaped.** `fluid-registration.js#getRenderState()` now forwards `perfTier` (the identical transit-loss bug specular/window had). `fluid-surface-subsystem.js` gained a PER-ITEM `rebuildMaterialsForTier` (fluid is a per-item effect, unlike water/specular/window's per-floor singleton) — rebuilds only the two materials on a live tier change, never geometry/mesh/scene-membership/sim, storing `entry.maskTexture` so a tier-only rebuild never needs to reload or re-bake. `getStatus()` gained a per-item `perfTier: e.builtForTier` staleness cross-check, mirroring water's own (sourced from what was ACTUALLY built, not merely resolved).
   **Test coverage, honestly scoped.** `fluidTierPlan` and both boundary tiers (0 and max) get direct Node coverage in `fluid-sim-render.test.mjs`, plus a full anti-drift block in `effect-tier.test.mjs`. Fluid is back in `effect-tier-consumption.test.mjs`'s transit-loss guard (previously excluded specifically for this gap). The SUBSYSTEM-level changes (the rebuild-on-tier-change, the `prepareSimTick` gate) have NO automated Node coverage — `fluid-surface.test.mjs`'s own header already scopes this file to "the pure halves only... needs THREE and a browser" (a pre-existing, deliberate boundary this fix did not relitigate), so this piece was instead verified by careful manual trace, the same rigor specular/window's re-push bugs needed. `npm run verify` green (12,563 tests, zero regressions, only the same 2 pre-existing unrelated failures every fix this session has confirmed via `git diff`).
   **⚠️ Real blast radius, stated plainly — unlike every other fix this session.** Specular/window/bloom/DoF were all designed to keep `standard`+ byte-identical to before; fluid was NEVER gated at all pre-fix, so EVERY profile below the max previously got the FULL tier-5 look. That means this fix is a genuine visual change at THREE profiles, not two: `low`/`performance` were always the intended targets, but `standard` ALSO now loses the real fill-simulation (tubes read as permanently full) and the structure marbling/grain — only `quality`/`extreme` (tier 5) are unchanged. This is the correct, intended shape of the fix (a `standard`-profile machine should not have been silently paying `quality`-tier cost in the first place), but it is a bigger visible change than this document's other six fixes, and worth flagging as such before Ingram checks it live. **Not yet seen live** — needs Ingram's own check across all three affected profiles, not just `low`.
8. ~~**Add a structural guard against this recurring.**~~ **✅ DONE 2026-08-30**, two independent layers, matching the two distinct ways this bug actually happened:
   - **Transit-loss guard (build-time).** `src/effects/__tests__/effect-tier-consumption.test.mjs` exercises the REAL `createSpecularRegistration`/`createWindowRegistration`/`createWaterRegistration` factories against a stub `effectRegistry`, invokes the captured `apply` callback with a sentinel `perfTier`, and asserts `getRenderState().perfTier` survives the round trip — the exact shape of bug that shipped in specular and window (§3.2 above): `perfTier` resolved, even stored on the internal `readout`, but silently dropped before reaching the one seam the live viewer actually reads. This is a Node-level shape check, deliberately — the class of bug it catches (a field present on one object, absent on a sibling object two lines away) is a pure code-structure fact, not something that needs a live scene to observe. **FLUID IS DELIBERATELY EXCLUDED from this test's coverage**, with a prominent comment explaining why — it would fail today (item 7, still unwired) and an honest excluded-and-explained gap beats a red suite blocking unrelated work.
   - **Staleness guard (live).** A second, different failure mode exists that the transit-loss guard above cannot see: `perfTier` reaching `getRenderState()` correctly, but the surface subsystem's rebuild-on-tier-change logic (`resolvedTier !== builtForTier`) silently failing to fire later, leaving the live material stale at whatever it was last built at. Water already carried a live cross-check for exactly this (`water-surface-subsystem.js`'s `getStatus().perfTier`, sourced from `builtForTier` — the ACTUALLY-built tier — not from the raw resolved value), with its own comment naming the contract: *"they can disagree for at most one `sync()` between a resolve and its rebuild; agreeing every other frame is the proof the rebuild-on-change wiring is actually running."* Specular's and window's own `getStatus()` did not have this field at all. Added `perfTier: builtForTier` to both, mirroring water's field/comment exactly, plus a Node test on each (`specular-surface-subsystem.test.mjs`, `window-surface-subsystem.test.mjs`) proving the field both defaults correctly AND actually tracks a live tier change, not just a static read. This reaches the same general-purpose viewer diagnostics surface (`getVtPanViewerDiagnostics()`) water's own `.specular`/`.windowLight` entries already flow through.
   - **What this does NOT do**, stated plainly rather than left to be discovered later: neither layer is wired into a console-callable `MapShine.getSpecularHealthReport()`/`getWindowHealthReport()`, and neither reaches `perf-run-full`'s own top-level JSON the way `feedback_diagnostics_must_land_in_perf_report` asks of a genuinely NEW live diagnostic — water's own equivalent tool predates this fix and was not audited for that either. Building either is real, separate, larger scope (a new console tool, `boot.js` wiring, and doc updates) that was not attempted here; the data is real and live-reachable via `getVtPanViewerDiagnostics()`, just not yet plumbed to the single-button workflow `feedback_diagnostics_must_land_in_perf_report` describes. `npm run verify` green throughout (12,538 tests, incl. 6 new: 2 on the transit-loss guard × 3 effects, 2 apiece on specular's and window's own staleness field).

---

## 6. Round 2 (2026-08-30) — "is this actually well implemented now?"

Asked directly, after all 8 ranked items above closed. Correct instinct to check: "addressed" and "well implemented" are not the same claim. Re-audited with a skeptical Explore pass (not a confirmation pass) before answering.

**Scope re-check: still complete.** 15 registered manifests + precipitation = 16, re-verified three independent ways (every `effectRegistry.register()` call site, a `visualWeight` grep across `src/`, and `effects/index.js`'s own barrel export list). No effect with a real `tiers` array was ever missed.

**Three real gaps found, honestly ranked, one fixed:**

- **BLOOM / DEPTH_OF_FIELD's tier gate was construction-time-only — FIXED, `BUILT (unverified)`.** `bloomUsesFullPyramid`/`dofUsesFullPyramid` (`vt-pan-viewer.js`) decided the mip-pyramid size ONCE, at viewer startup, from a raw settings read — never re-evaluated if the player changed the graphics profile mid-session. Both manifests' own tier 1 rungs *claim* to be a live, switchable rung; the render never delivered on that claim without a scene reload. Picked as the biggest of the three gaps because it's the only one that's misleading rather than merely incomplete — the closest remaining thing in the whole system to `feedback_instruments_must_not_lie`.
  **The fix turned out smaller than feared.** The render-target allocator was never actually at risk — both mip chains already allocate at the FULL count regardless of tier, so VRAM was always paid at max. Only the two COMPOSITE materials needed live handling, and each needed genuinely different treatment: **BLOOM's** composite reads exactly two fixed texture nodes (`coreTexNode`=mips[0] always; `atmoTexNode`=mips[atmoTop], the ONE thing tier actually moves) — a tier change is a live re-point of `atmoTexNode.value`, never a rebuild; exposed the node from `bloom-render.js`'s return, re-pointed unconditionally every `runPostBloomPass` (cheap — matches every OTHER bloom uniform in that function, already re-pushed unconditionally each frame). **DEPTH_OF_FIELD** is genuinely different: its composite bakes mip COUNT into the compiled shader itself (`depth-of-field-render.js`'s own words: "TSL/WGSL has no runtime array indexing"), so a tier change needs a real `buildDofMaterials()` rebuild — added `rebuildDofForTier()`, guarded to fire only on the rare frame the resolved tier actually crosses the performance/standard boundary, mirroring water/specular/window/fluid's own `builtForTier` pattern but scoped to one screen-space composite instead of a per-item/per-floor mesh (`QuadMesh.material` confirmed freely settable — `QuadMesh extends Mesh` in the vendored source — before relying on it). Both `getBloomRenderState()`/`getDofRenderState()` (`boot.js`) had the SAME transit-loss bug specular/window/fluid all had (`perfTier` resolved into the readout, never forwarded to the seam) — fixed identically. Both manifests' now-stale `deferredRungs.liveMipRebuild` entries removed, the gap they named being closed rather than left stale. **New Node coverage** (`bloom-dof-render.test.mjs`): neither `buildBloomMaterials` nor `buildDofMaterials` had ANY Node test before this — proves both construct cleanly, and proves DoF's builder compiles at BOTH the 2-mip and 4-mip shapes, the exact pair a future edit could silently break only one half of. `npm run verify` green, 12,574 tests (+11), zero regressions, same 2 pre-existing unrelated failures.

- **PRECIPITATION has no manifest at all — left open.** No `enabledFromProfile`, no GM/player enable override, no `a11y.photosensitive` gate (a real parity gap for a weather effect that could someday grow a flash-adjacent species). Roughly half the remaining work is free once a manifest exists — `effect-cascade.js`'s GM/player-override and a11y machinery is fully generic, comes along automatically the instant a real `resolveAndApply` call exists for this effect — but the params schema is genuinely new authoring (deciding what should be author-tunable, categories, help text), not boilerplate. A real, moderate lift; not attempted this round.

- **FIRE's manifest declares 6 tiers but only 2 real levers vary — left open, but a concrete next step identified.** Already honestly documented as of the original audit's fix (not a lie, just shallow — `clusterFactor` light-merge aggressiveness and `animation.quality` are the only two real axes). New finding this round: a 3rd real, already-LIVE lever sits unused right beside them — `fire-subsystem.js`'s own `PER_FIRE`/`activeCount` sprite-count budgets (flame/ember/smoke particle counts per fire), read every frame, just never threaded from `tier` the way `clusterFactor` already is. Small, additive wiring if picked up — not a redesign, and categorically easier than resurrecting the orphaned volumetric material tiers 1/2/3/5's own text still describes.

- ~~**The structural guard's real coverage is narrower than its name implies.**~~ **✅ DONE 2026-08-30** — see §8 below. `effect-tier-consumption.test.mjs` originally only reached the 4 effects with a dedicated `*-registration.js` factory; now covers all 12 multi-tier effects.

## 7. Round 2, continued (2026-08-30) — fire's 3rd lever wired, precipitation given a real manifest

Ingram: "wire fire's third lever next and then precipitation." Both closed same session, `BUILT (unverified)`.

**FIRE's 3rd lever.** `fireTierPlan(tier)` (`fire-geometry.js#FIRE_TIER_PLANS`) gained `spriteCountScale` — a per-tier multiplier on `fire-subsystem.js`'s own `activeCount` (the flame/ember/smoke particle budget per fire, `PER_FIRE`'s values), the sprite layer's dominant per-frame cost and, until now, the one thing about fire that never varied by profile at all. Ramp: 0.35 → 0.6 → 0.8 → 1.0 (tiers 0-3), flat at 1.0 for tiers 3-5 — `standard`+ byte-identical to before, matching this session's own discipline (unlike `clusterFactor`'s own pre-existing ramp, which already varied continuously across all 6 rungs before this session ever started). Manifest text corrected: the header's old claim that "rungs 2 through 5 differ from each other ONLY in clusterFactor" was true only ABOVE rung 2 — now states three real levers, not two. Tested at both the plan-data level (`fire-geometry.test.mjs`) and full live-consumption level (`fire-subsystem.test.mjs`, using its own existing fake-engine harness to prove `activeCount` genuinely changes when `state.perfTier` changes mid-session, ember/smoke included, not just flame).

**PRECIPITATION's manifest — the last of the 16 audited effects without one.** New `precipitation.js#PRECIPITATION`: `enabledFromProfile: 'low'` (formalises, does not change, today's hardcoded `enabled: true`), `a11y.photosensitive: false` (with a comment flagging it for a future flash-adjacent species), a 3-rung `tiers` ladder reproducing `precipTierScaleForProfile`'s own existing 0.4/0.7/1.0 shape exactly — now resolved through the real `resolveEffectTier`, not a raw settings read. **`PRECIPITATION_PARAMS` is deliberately empty** — precipitation's actual "look" (which species falls, how hard) is weather-manager state (`MapShine.setPrecip`/`setPrecipKind`/`setPrecipitationTuning`), not a per-scene author dial the way water's `tint` is; inventing author-facing controls with no decided design would have been unrequested scope, and an empty schema is a legitimate, precedented state (`FLUID_PARAMS` shipped this way too, before that effect had real params). The GM/player enable override and the `a11y.photosensitive` gate both came free the moment the manifest registered — the System panel's own `effectRows` already builds itself generically off `effectRegistry.list()`, confirmed by reading it directly rather than assumed. `precipTierScaleForProfile` (profile-string form) was kept, not deleted — both it and the new `precipTierPlan` (tier-number form) now read one shared canonical ladder, `PRECIP_TIER_SCALES`, so the two can never quietly disagree.
**⚠️ A registration this size needs `EFFECT_REAPPLIERS`, and it would have been the exact silent-rot bug the audit was built to catch if missed** — `boot.js`'s own `EFFECT_REAPPLIERS` list carries a header naming bloom/water/fluid/specular/window as effects that ALL shipped missing from it at some point, each stuck at its pre-resolve seed until a console command. Added `['precipitation', () => reapplyPrecipitation()]` deliberately, not as an afterthought.

**Verification:** `npm run verify`'s test stage: 12,620 Node tests, zero regressions in anything this fix touched. 5 failures present, all confirmed NOT caused by this work: 2 are chart-room's checked-in page needing a rebuild (`node tools/chart-room/build-chart-room.mjs`) to pick up the new `precipitation` row — a real, expected, DOCUMENTED consequence of registering a new effect, deliberately left for Ingram's own chart-room workflow rather than run automatically (memory: "he syncs → tells me in chat"); 1 is specular's long-standing `incidentSteepness` mismatch (Ingram's own uncommitted edit, confirmed via `git diff` unrelated); 2 are a `GLOBAL_SETTING_KEYS` count test gone stale against an already-committed HiDPI-rendering setting — confirmed via `git diff` that `effect-settings.js` has ZERO uncommitted changes, meaning this shipped in a PRIOR commit from a **different, concurrent working session** on this same repository (its own commit message: "albedo clarity: pull the CAS far roll-off in, add a real HiDPI setting") — not this session's to fix.

## 8. The guard's narrow coverage, closed (2026-08-30)

Ingram: "go after the guard's narrow coverage next." Every multi-tier effect this project has is now covered — 12 of 12, not 4 of 12.

**The design question this turn actually hinged on**, stated plainly because it decided the whole shape of the fix: full extraction of the 8 inline effects into their own `*-registration.js` files (mirroring water/specular/window/fluid exactly) would have genuinely closed the gap, but it is real, invasive surgery on 8 pieces of LIVE, un-testable, deeply-Foundry-coupled code, for zero behaviour change — precisely the "large, deliberately-deferred refactor" this document's own earlier rounds correctly declined to attempt as a drive-by. A narrower question turned out to have a narrower, much safer answer: the actual bug this whole guard exists to catch is a field silently missing from a hand-typed object literal, ALWAYS at exactly one of two spots (the `register()` callback's readout, or the `getXRenderState()` projection) — and both spots have the IDENTICAL shape across all 8 inline effects, letter for letter, just duplicated 8 times.

**The fix:** two new pure functions, `src/effects/effect-readout.js#buildCascadeReadout(resolved)`/`projectCascadeRenderState(readout)`, extracting exactly that duplicated shape — nothing new designed, the existing pattern named and centralised. Every one of the 8 inline effects' registration in `boot.js` now DELEGATES to them (`xReadout = buildCascadeReadout(resolved)`; `getXRenderState = () => projectCascadeRenderState(xReadout)`, with each effect's own extra viewer-internal fields — candle's `anchors`, fire's `mPerPx`/`spawnCloud`/etc. — spread on top exactly as before) instead of hand-typing the same 5-key/3-key object literals. The readout VARIABLE itself, its name, every OTHER place that reads it directly (a console setter, a status line, a FOH/ROH card's `getReadout`) — all untouched; only the two literals that could previously drop a field silently are now single-line delegations to a tested function.

**Honest limit of what this proves**, stated in the guard test's own header: this is a NARROWER guarantee than section 1's factory-based test (which actually exercises the real, live registration code end to end). Testing the shared pure functions proves the PROJECTION logic is correct; it does not prove any specific inline effect's `getXRenderState` still calls it — `boot.js` needs a live Foundry `game` global no Node harness here constructs, so that delegation itself cannot be executed by a test. What it DOES achieve: the SAME field silently going missing would now require deleting or editing a conspicuous one-line function call, not omitting a key from a multi-line literal buried in a much bigger file — a far more visible change for review to catch. Narrower than section 1, but a real, verified improvement over "manual audit is the only guard," which was the honest state of things this morning.

**Verification:** `effect-tier-consumption.test.mjs` grew a new section (20 assertions total in the file now, up from 5), all passing, plus every existing suite unaffected — 12,697 Node tests, zero regressions in anything this fix touched. Only 3 failures remain, all already-confirmed not-mine (chart-room's same 2 expected-staleness checks; specular's `incidentSteepness`) — the `GLOBAL_SETTING_KEYS` mismatch from §7 resolved itself between rounds, presumably the concurrent session fixing its own test.

---

## Appendix: full per-effect research (verbatim from the 5 parallel audit passes, citations included)

Each pass follows the same structure: manifest snapshot → consumption trace → floor cost profile → per-rung breakdown → cheapest-component scouting → test coverage → red flags.

### A. Water, Fluid, Fire

# Performance-Tier Audit: WATER, FLUID, FIRE

## WATER

**1. Manifest snapshot** (`src/effects/water/water.js`)
`enabledFromProfile: 'low'` (line 919) · `visualWeight: 0.8` (917) · `a11y.photosensitive: false` (918). Tiers table:

| n | fromProfile | cost.class | adds (summary) |
|---|---|---|---|
| 0 placement | — | C4 (930-939) | mask tinted in place, cross-floor borrow, paint-order occlusion |
| 1 volume | low (940-951) | C1 | Beer-Lambert depth ramp + wet-ground band |
| 2 motion | performance (952-965) | C2 | surface field: foam + turbidity from one noise fetch |
| 3 light | standard (966-981) | C3 | GGX specular + Fresnel sky reflection |
| 4 shore | quality (982-1001) | C4 | shore foam filaments, wave shoaling, caustics |
| 5 refraction | quality (1002-1042) | C5 | bed refraction, dependent read of captured scene colour |

`deferredRungs`: sim:memory, sim:interactive, spray (1050-1067), honestly unbuilt.

**2. Consumption trace — CONSUMED.** `water-surface-subsystem.js:739` — `const rawResolvedTier = Number.isFinite(state.perfTier) ? state.perfTier : WATER_DEFAULT_TIER;` — then `resolveGatedWaterTier(rawResolvedTier)` and, on change, `surface = buildSurfaceForTier(resolvedTier)` (line 750), which calls `buildWaterSurfaceMaterial({..., tier, ...})`. Inside `water-render.js`, `activeTier` (line 1053) gates five real `if (activeTier >= N)` blocks: `>=1` at 1475, `>=2` at 1607, `>=3` at 1742, `>=4` at 1798 and again at 2066 (foam filaments/shoaling, then caustics), `>=5` at 2179. Below a rung's threshold the term compiles to a literal neutral value — never sampled, never bound. This is the cleanest of the three effects: manifest, builder, and live wiring all agree.

**3. Floor cost profile.** Tier 0 is priced C4, not C0/C1 — the mask is a full-resolution per-item texture fetch (`maskTexNode`, 1271), not a cheap resident lookup, so "placement" already costs a real virtual-texture read. On top of that fetch, tier 0 draws unconditionally as TWO bounded meshes (multiply-absorb + additive-inscatter, `WATER_TIER0_TINT` = [0.09,0.24,0.28] at line 324, `WATER_TIER0_OPACITY` = 0.15 at line 336) — pure ALU/blend once the fetch lands. Genuinely minimal beyond the unavoidable mask read.

**4. Per-rung breakdown.** 1: Beer-Lambert absorption + wet band, ALU only on a signed-distance fetch this rung introduces (~21-world-px grid, cheap). 2: one fractal-noise fetch scrolled along flow, read twice (foam, turbidity) — water stops being a flat decal. 3: real GGX specular + sky Fresnel, no new texture bandwidth (reuses tier 0-2's own reads). 4: a second, finer noise fetch for shore filaments, plus shoaling/caustics riding tier 2's existing fetch via two extra taps. 5: a same-frame capture-and-read of `buf:scene.color`, chromatic fringe, depth-validated fallback — the first rung that is a dependent read rather than a plain drawable.

**5. Cheapest-component scouting.** Tint/opacity blend (tier 0, on top of the mandatory C4 mask fetch) and tier 1's absorption/wet-band (C1, pure ALU on an already-cheap fetch) are the two candidates for "stays on at the very bottom." The mask fetch itself is the unavoidable floor — there is no way to draw water at all below C4 without it.

**6. Test coverage.** Dedicated, extensive anti-drift block, `effect-tier.test.mjs` ~350-386: pins `WATER_DEFAULT_TIER===3` against `resolveEffectTier(WATER,{profile:'standard'})`, checks each profile buys the right rung (low→1, performance→2, quality→5, extreme==quality), and asserts low genuinely resolves cheaper than default. The strongest-covered of the three effects.

**7. Red flags.** None structural — this is the reference-quality implementation the other two should be measured against. Only soft note: tier 0's C4 pricing means "cheap" water still costs a real per-item texture fetch, which the task's own framing example (tint = "nearly free") slightly undersells.

---

## FLUID

**1. Manifest snapshot** (`src/effects/fluid/fluid.js`)
`enabledFromProfile: 'low'` (147) · `visualWeight: 0.3` (145, deliberately low — "never integral to gameplay") · `a11y.photosensitive: false` (146, true only for tier 0; flags tier "fill"'s pump gulps as a future strobe risk, not yet built as a discrete step).

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 placement | — | C4 (158-172) | mask, two-pass multiply+add (tint + glow) |
| 1 tube | low (173-183) | C1 | cross-section optical path (cylinder shading) |
| 2 flow | standard (184-199) | C4 | geodesic arc-length coordinate `s`, meniscus axis |
| 3 film | standard (200-209) | C4 | thin-film iridescence from optical thickness |
| 4 fill | quality (210-223) | C5 | real semi-Lagrangian sim, dependent read |
| 5 structure | quality (224-256) | C5 | one noise fetch at material coordinate τ (marbling+grain) |

**2. Consumption trace — DECLARED-ONLY.** The manifest's own header claims "Tiers 0-5 RENDER... real code," and the feature code genuinely exists and works — but the resolved tier never reaches it. `buildFluidSurfaceMaterials` (`fluid-render.js:221-234`) has no `tier` parameter at all, and contains zero `if` statements in the entire file (verified by full-file grep). The call site, `fluid-surface-subsystem.js:384-392` (`buildMesh`), passes only `THREE, maskTexture, packTexture, stateTexture, tubeCount, timeMsNode, ...pickParams(renderState().params)`; `pickParams` (449-458) extracts exactly six LOOK params (tint/glow/iridescence/opacity/flowSpeed/structure) — no tier. Tracing further back, `fluid-registration.js`'s `getRenderState()` (82-91) returns only `{enabled, params}` — `resolved.perfTier` is captured at line 63 into the `readout` object for the Studio-card UI display only, and is never carried into `getRenderState()`. The chain is severed at that exact boundary. Every rung's shader term — including tier 5's `mx_fractal_noise_vec3` fetch and tier 4's dependent sim-state read — compiles and executes unconditionally, on every profile, the instant an item has a fluid mask.

**3. Floor cost profile.** Structurally there is no "floor" distinct from the ceiling: whatever tier 0 costs, tier 5 costs on the same draw, always. Two meshes per item (absorb multiply + emit add, mirroring water), sharing one geometry — not enormous per item, but non-decreasing cost regardless of resolved profile is the opposite of what the manifest promises.

**4. Per-rung breakdown.** All six rungs' code paths execute simultaneously and unconditionally: cylinder cross-section, arc-length/meniscus read, iridescence, the real 1-D sim tick, and the τ-coordinate noise fetch all run together on every enabled tube, on every profile.

**5. Cheapest-component scouting.** Tier 1 "tube" (C1, pure ALU cross-section) is the one rung that would cost nothing extra if gating were ever added — it is already effectively the cheapest possible extra. The tint/glow base blend (tier 0) is the true floor candidate. Tiers 4/5 (the sim + noise fetch) are exactly what should be first cut and currently cannot be, because there is no gate to cut.

**6. Test coverage.** Only the generic well-formed-manifest check (`effect-tier.test.mjs:209`, `[CANDLE_FLAME, WATER, SPECULAR, FLUID, BLOOM].every(m => resolveEffectTier(m,{profile:'low'}).tier >= 0)`). No dedicated per-rung cross-check exists for FLUID anywhere.

**7. Red flags.** This is the clearest live recurrence of the "14 effects declared a ladder nobody read" failure mode named in effect-cascade.js's own header — freshly reintroduced in a newer, otherwise well-engineered effect. Low-visual-weight (0.3) softens the blast radius, but a `low`-profile machine pays full C5 dependent-read + noise-fetch cost for every fluid tube on screen, identical to `extreme`.

---

## FIRE

**1. Manifest snapshot** (`src/effects/fire/fire.js`)
`enabledFromProfile: 'low'` (458) · `visualWeight: 1.0` (456, the maximum of all three — notably higher than water's 0.8 for what is usually a small decorative hazard) · `a11y.photosensitive: true` (457, unlike the candle — a large fire's light pulses near 1.5 Hz across a real screen fraction).

| n | fromProfile | cost.class | adds (as written) |
|---|---|---|---|
| 0 hearth | — | C8 (482-485) | one clustered light + posterized disc |
| 1 billow | low (486-491) | C1 | one noise sheet, cauliflower lobes |
| 2 plume | performance (492-498) | C1 | slab integral, two sheets/six slices |
| 3 smoke | standard (499-505) | C1 | three sheets/ten slices, smoke ramp |
| 4 flicker | quality (513-519) | C3 | light animates on puff clock, depth-gated |
| 5 inferno | extreme (520-526) | C8 | four sheets/fourteen slices |

**2. Consumption trace — PARTIALLY CONSUMED, and the manifest text describes dead code.** `fire-subsystem.js`'s own header (9-24) states plainly: until 2026-08-09 fire was a volumetric slab-integral material (exactly what the table above describes — sheets, slices, billow); it was fully replaced by a sprite/particle system, and "the size-class cache, the coverage rung and the slab plan are all gone with the material they served." Confirmed: `buildFireMaterial`/`buildFireGeometry` (`fire-render.js:361,1038`) are exported from `effects/index.js:598` but never imported by `vt-pan-viewer.js` or `boot.js` — pure orphan. `fireSlabPlan`/`fireSliceTable` (`fire-geometry.js:460,514`) are called only by that orphaned file and by tests. What IS live: `state.perfTier` genuinely flows `boot.js:3613` (`getFireRenderState` return) → `fire-subsystem.js:310` (`const tier = ... state.perfTier ... : FIRE_DEFAULT_TIER`) → `buildFireLightSources({tier,...})` (417-424) → `fireTierPlan(tier)` (`fire-geometry.js:878`), which reads exactly one field, `plan.clusterFactor` (886, light-clustering cell size), plus uses `tier` directly for `animation.quality` clamped 0-2 (939, feeds candle-flicker's own flicker-complexity ladder). Every other field on the tier plan (`sheets`, `maxSlices`, `octaveCap`, `bands`, `smoke`, `shear`) is dead.

**3. Floor cost profile.** Tier 0 is legitimately C8 (an extra draw call/light) by design — the manifest itself notes the monotonic-cost check starts at rung 2 because "a fire that emits no light reads as BROKEN." In the live path this really is what tier 0 buys: one light per cluster. Sprite rendering itself (flame/ember/smoke, the dominant visual cost) is entirely untiered.

**4. Per-rung breakdown (as actually wired, not as written).** Only two things change with tier: (a) `clusterFactor` shrinks 2.0→0.35 across rungs 0-5, so higher tiers merge nearby fires' lights less aggressively (more, smaller lights = more draw calls); (b) `animation.quality` (0/1/2) steps up flicker character on the shared candle-flicker path. Rungs 1/2/3/5's prose ("billow fold," "slab integral," "four sheets") corresponds to nothing that executes.

**5. Cheapest-component scouting.** `lightEnabled` (a bool param, not a tier) is explicitly named in its own help text as "by far the biggest performance saving fire offers — a fire costs what its LIGHT costs" (fire.js:379), and `clusterFireSources`' own header agrees: "THIS IS THE BUDGET LEVER, NOT THE SHADER" (fire-geometry.js:709). The sprite/particle layer itself has no cheap/expensive split at all today — it is flat-cost, author-count-driven, independent of profile.

**6. Test coverage.** Absent from `effect-tier.test.mjs` entirely (confirmed by full-file grep — FIRE is not among its imported manifests). Has its own separate anti-drift tests: `fire.test.mjs` pins `FIRE_DEFAULT_TIER` against `resolveEffectTier(FIRE,{profile: DEFAULT_PERFORMANCE_PROFILE})` and checks the per-profile ladder; `fire-geometry.test.mjs` exercises `fireTierPlan`/`fireSlabPlan` directly. These tests are internally consistent but they validate a ladder shape whose per-rung visual meaning no longer describes shipped rendering.

**7. Red flags.** The manifest's `adds` text is fiction relative to current code — it describes an abandoned rendering architecture in detail (sheet/slice counts) while the actual tier consumption is two narrow, unrelated levers (light clustering, flicker quality) that happen to still exist because `fireTierPlan` was never deleted alongside the material it was built for. Anyone tuning `fromProfile` values against the written descriptions is tuning against a system that no longer exists. This should be corrected or the manifest rewritten before anyone uses it to reason about fire's real cost curve.

### At a glance

| Effect | Verdict |
|---|---|
| WATER | CONSUMED — five real `if (activeTier>=N)` gates, manifest/code/tests all agree; reference implementation. |
| FLUID | DECLARED-ONLY — full 6-rung ladder exists in code but the render builder has no tier parameter and zero conditionals; every profile pays tier-5 cost. |
| FIRE | PARTIALLY CONSUMED — tier number reaches only light-clustering + flicker quality; the manifest's per-rung visual descriptions (sheets/slices/billow) describe a volumetric material replaced by particles in 2026-08-09 and now orphaned. |

### B. Vegetation, Sun Shadows, Specular

# VEGETATION

**1. Manifest snapshot** (`src/effects/vegetation.js`)
`enabledFromProfile: 'low'` (line 698) · `visualWeight: 0.6` (696) · `a11y.photosensitive: false` (697).

Tiers table (lines 753–828):

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 | — (unconditional) | C1 | placed-and-swaying: correct-placement overlay + real wind sway, one sample/mesh (754–763) |
| 1 | low | C2 | shimmer: per-fragment curl-noise leaf flutter, gated to foliage pixels (764–773) |
| 2 | performance | C8 | shadow-coarse: 3-station ground-shadow smear, first rung to pay for a 2nd draw call (774–783) |
| 3 | standard | C8 | shadow-smooth: 6-station smear — today's shipped look, the DEFAULT tier (784–793) |
| 4 | quality | C8 | shadow-finer: 9-station smear (794–803) |
| 5 | extreme | C8 | shadow-finest: 12-station smear, the ladder's original reserved top (804–812) |
| 6 | extreme | C8 (unmeasured) | torque-sway: rotation + lift spring, a whole new GPU sim pass (813–827) |

**2. Consumption trace — CONSUMED.** `vegetationTierPlan(tier)` (vegetation-render.js:910–915) is threaded live: `boot.js:2968–2973` forwards `perfTier: vegetationReadout.perfTier` through `getVegetationRenderState`; `vt-pan-viewer.js:11197` `const vegTier = vegActive ? vegetationTierPlan(vegState.perfTier) : null;` and again at `:11842`; `vegTier.shadowSmearTaps`/`.rotationLiftEnabled` are passed into `attachTileShadow` calls (11425–11426, 11563–11564) and gate real mesh/pass construction (`if (rotationLiftEnabled) {…}` at 10185; `if (rotationLiftEnabled) ensureVegetationSpringGrid(...)` at 10399). Even the proxy-mesh cache path resolves it fresh (14121–14123). Tier 6 is genuinely wired, not just declared.

**3. Floor (tier 0) cost profile.** Genuinely minimal: `VEGETATION_TIER_PLANS[0]` = `{flutterEnabled:false, shadowEnabled:false, shadowSmearTaps:0, rotationLiftEnabled:false}` (vegetation-render.js:955). No shadow mesh, no per-fragment flutter — just the overlay's own tessellated quad with vertex-only wind sway (`heightWeight01`, 618–621). Tessellation is explicitly vertex-stage-only and called "still trivial" even at its 128×128-segment ceiling (645–651).

**4. Per-rung breakdown:** 1 turns on per-fragment leaf shimmer. 2 adds a second (shadow) mesh at coarse (3-tap) smear. 3 refines that smear to 6 taps (shipped default). 4→9 taps, 5→12 taps. 6 adds an entirely new scene-wide GPU spring simulation driving rotation+lift.

**5. Cheapest-possible-component scouting:** The floor already is C1/ALU-only with no extra draw call — it IS the cheapest meaningful thing this effect can be while still existing as a drawn overlay. Nothing above it is C0/C1: tier 1 (shimmer) is C2, everything else is C8.

**6. Test coverage:** dedicated anti-drift blocks — "VEGETATION ANTI-DRIFT" (effect-tier.test.mjs:263–318) plus a further "TIER 6 (TORQUE-SWAY) ANTI-DRIFT" block (320–348), covering per-profile resolution, default-matches-shipped pin, monotonicity, and out-of-range/negative clamping.

**7. Red flags:** Tier 6 is `BUILT (unverified)` — its `estMsPerMp: 0.2` is explicitly marked "Unmeasured — new subsystem" (vegetation.js:817–818). The spring sim grid is scene-wide, not per-item (vegetation-render.js:810–857), so its cost is fixed regardless of how much vegetation is in view — one bush costs the same integrate/publish pass as a whole forest. The manifest's own `deferredRungs` admits tier 6 makes an existing clump-boundary seam worse, not better (840–849), and ships that way anyway.

---

# SUN_SHADOWS

**1. Manifest snapshot** (`src/effects/sun-shadows.js`)
`enabledFromProfile: 'performance'` (275) — confirmed the one effect off entirely at `low`, by explicit author directive quoted in-line: "the lowest performance tier should turn shadows off and remove the performance cost" (262–274). `visualWeight: 0.85` (260) · `a11y.photosensitive: false` (261).

Tiers table (303–336; arithmetic in `layer-smear.js` `LAYER_SMEAR_TIER_PLANS`, 185–190):

| n | fromProfile | cost.class | adds | fieldDim/steps/quantizeDeg |
|---|---|---|---|---|
| 0 | — | C3 | coarse: 4 occluder layers multiplied, lowest silhouette res (304–313) | 512/16/1° |
| 1 | standard | C5 | field+silhouette double (314–319) | 1024/24/0.5° |
| 2 | quality | C5 | fine roofline detail resolves (320–326) | 1536/32/0.5° |
| 3 | extreme | C5 | sharpest silhouette + smoothest sky-reach gradient (327–335) | 2048/48/0.4° |

`estMsPerMp` is identically 0.05 at every rung — deliberate, not a bug: this is a bake-cost effect, and the real gradient lives in `layerSmearBakeSamples` texel counts (4.5M→205M), stated explicitly in the manifest's own comment (295–302).

**2. Consumption trace — CONSUMED.** `layerSmearTierPlan(tier)` (layer-smear.js:211–216) is read every frame per floor inside `maybeBake()`: `sun-shadow-subsystem.js:1339–1342` (`const tier = state.perfTier ?? DEFAULT; const plan = layerSmearTierPlan(tier);`), then `applyFieldDim(plan.fieldDim)` (resize render target) and `applyQuality(plan)` (rebuild bake shader on step-count change) both run unconditionally at 1353–1355. `boot.js:2989–2997` wires `perfTier: sunShadowReadout.perfTier` into the seam. A second, independent consumer exists too: `boot.js:1974` `layerSmearTierPlan(resolved.perfTier).layerGridDim` sizes the shared caster-grid resolution.

**3. Floor (tier 0) cost profile.** No separate "unconditional floor" below the ladder the way vegetation has one — tier 0 ("coarse") is itself gated behind `enabledFromProfile:'performance'`. At `performance` it draws a real bake: 512² field, 16 march steps, 4 multiplied occluder layers — not free, genuinely the coarsest real picture. Below `performance` (`low`), the subsystem collapses to a 1×1 texture and bakes one pixel once per "off" spell (sun-shadow-subsystem.js:1313–1322).

**4. Per-rung breakdown:** every rung buys the identical picture at higher resolution/station-count — 0→1 doubles field+silhouette; 1→2 resolves fine roofline detail; 2→3 is the sharpest/smoothest this system draws. No rung adds a new visual feature (stated explicitly, 288–291).

**5. Cheapest-possible-component scouting:** none exists to scout — there is only one feature (the baked field), so nothing can be selectively kept at a floor below what's already there. Per-frame cost is already flat and minimal across every rung (one texture fetch). This effect's real cheapness lever is the enabledFromProfile gate itself, already correctly used.

**6. Test coverage:** dedicated "SUN-SHADOW ANTI-DRIFT CROSS-CHECK" (effect-tier.test.mjs:387–471), explicitly testing WHETHER and HOW MUCH as two separate mechanisms, plus monotonicity and a bake-sample cost-gradient check.

**7. Red flags:** the bake, though rare, is synchronous inside a frame — at Extreme (205M samples), across up to 6 floor slots, a profile change or floor-heavy scene could visibly hitch (readiness note, 276–280). The subsystem's own header (§5.8, sun-shadow-subsystem.js:346–372) documents that ANY unrelated mask-authority edit chains into a full rebake-eligibility check per resident floor slot — up to 6 redundant chains for one unrelated slider drag elsewhere in the scene, throttled at 150ms but explicitly called "worse than water's own version of this problem."

---

# SPECULAR

**1. Manifest snapshot** (`src/effects/specular/specular.js`)
`enabledFromProfile: 'low'` (731) · `visualWeight: 0.7` (729) · `a11y.photosensitive: false` (730, flagged: "Revisit if a sparkle rung ever lands").

Tiers table (742–805):

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 | — | C4 | presence: mask as strength+tint × light, AABB-cropped, floor/depth-gated (743–754) |
| 1 | low | C1 | shimmer: six anisotropic blob-lattice layers + voronoi cellular base (755–764) |
| 2 | low | C1 | parallax: pattern slides ~1:1 with camera (765–773) |
| 3 | low | C1 | life: slow drift + breathing pulse (774–783) |
| 4 | standard | C3 | islands: per-object connected-component parallax (784–794) |
| 5 | standard | C3 | sunAndSky: outdoors-gated sun-azimuth grain bias (795–804) |

**2. Consumption trace — DECLARED-ONLY (UNCONSUMED).** This is the audit's headline finding. `specular-registration.js:90–99` captures `perfTier: resolved.perfTier` into a local `readout`, but `getRenderState()` (114–116) — the ONLY seam actually wired into the live path (`boot.js:10621`: `getSpecularRenderState: specular.getRenderState`) — returns `{enabled, params, layers, debugChannel}` with `perfTier` dropped. `specular-surface-subsystem.js`'s `sync()` (442–563) never reads a tier. `buildSpecularSurfaceMaterial` (specular-render.js:467–497) takes no tier parameter at all; `SPECULAR_LAYER_COUNT = 6` is a flat constant (120); all six shimmer layers, parallax, drift/pulse, and sun-azimuth bias construct unconditionally, gated only by mask presence (`Fn()/If(presence.greaterThan(0))`, 895–901), never by tier. The island pack bakes on every mask load regardless of tier (specular-surface-subsystem.js:355). No `specularTierPlan` function exists anywhere in `src/`. `readout.perfTier` survives only in `getReadout()`, confirmed by `water-registration.test.mjs:63–75` to be the UI-display-only accessor, not one that reaches rendering.

**3. Floor (tier 0) cost profile.** Because the ladder is unconsumed, the true floor at `low` is not tier 0 — it's the full tier-5 shader every time: the 27-cell Worley + 3D Perlin cellular base is the code's own self-described "DOMINANT COST OF THE WHOLE EFFECT" (specular-render.js:818–819), and this same pass was measured (at half today's layer count) at ~3.4ms, ~6× its declared budget, ~93% fill cost (872–882) — explicitly "not re-measured" since layers doubled to six.

**4. Per-rung breakdown (as declared, not as behaving):** 1 shimmer, 2 parallax, 3 life/drift, 4 per-island parallax, 5 sun-azimuth bias — all of these are simply always-on in shipped code, at every profile.

**5. Cheapest-possible-component scouting:** notable irony — tiers 1–3 (shimmer, parallax, life) are declared C1 (pure ALU, cheaper than tier 0's own C4 texture read) and would be exemplary "keep on at the floor" candidates if the ladder were wired. Today that's moot since they're unconditional anyway. The one genuinely-gated, truly-zero-cost-when-off mechanism in this file is the debug-channel system (specular.js:494–498) — a real, working example of correct gating, just unrelated to performance tiers.

**6. Test coverage.** Generic only — the "well-formed manifest" loop (effect-tier.test.mjs:193–206) and a `.tier >= 0` sanity check (209). No dedicated anti-drift block exists, unlike CANDLE_FLAME/VEGETATION/WATER/SUN_SHADOWS — consistent with nobody having caught this gap.

**7. Red flags.** a live instance of the exact rot pattern effect-cascade.js's own header was written to stop (135–142) — SPECULAR is effect #15 in that shape. Real consequence: one of the costliest shaders in the codebase runs at full cost on `low`-profile hardware, contradicting the tier system's purpose. Manifest text is actively false of shipped behavior (e.g., "Pure ALU on tier 0 fetch. This is where it stops being a flat sheen" at 762–763 implies tier 0 alone ever runs — it doesn't). A naming trap compounds the risk: specular-render.js's own internal "TIER 1/2/3/4" comments (622, 663, 679) label pipeline construction order, not the performance ladder, and are numbered differently from — and out of order with — the manifest's tiers, which could mislead a future reader into thinking the gate exists. `perfTier` was wired into the readout 2026-08-19 "same fix as fluid-registration.js" — likely a reporting-only pass, not evidence render-gating was ever attempted, so this reads as unstarted work rather than a regression.

### At a glance

| Effect | Verdict |
|---|---|
| VEGETATION | Fully CONSUMED end-to-end incl. new tier 6; floor is genuinely C1/cheapest-possible; dedicated anti-drift tests; only risk is tier 6's unmeasured cost and scene-wide sim-grid scaling. |
| SUN_SHADOWS | Fully CONSUMED (resize + shader rebuild + rebake-threshold, live mid-session); architecturally a pure bake-resolution ladder with no separable cheap sub-feature to scout; dedicated tests; risk is bake-hitch size at Extreme × 6 floors. |
| SPECULAR | DECLARED-ONLY / UNCONSUMED — `perfTier` resolved and reported but dropped before reaching the render seam; full 6-layer, ~3.4ms-class shader runs unconditionally at every profile including `low`; no dedicated test would catch it; highest-priority fix candidate of the three. |

### C. Window, Door Graphics, UI Window Shadow

# Performance-Tier Audit: WINDOW, DOOR_GRAPHICS, UI_WINDOW_SHADOW

## WINDOW

**1. Manifest snapshot** (`src/effects/window/window.js`)
- `enabledFromProfile: 'low'` — line 334
- `visualWeight: 0.65` — line 332
- `a11y.photosensitive: false` — line 333
- `tiers` table (lines 345–374):

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 | — (floor) | C4 (`estMsPerMp: 0.06`) | mask read as light, added to `buf:scene.illum`, cropped to AABB, floor-gated — **plus the entire glass subgraph** (warp/prism/fake-caustic) and the astrolabe daylight tint, all folded into this one rung |

That's the whole ladder. `deferredRungs` (lines 375–472) names 11 unbuilt rungs (`skyDriven`, `drift`, `moon`, `glassPerfGate`, `glassConvergence`, `cloud`, `pointLights`, `occlude`, `stretch`, `bounce`, `shaft`, `motes`) — honestly recorded, none built.

**2. Consumption trace**: `resolved.perfTier` is registered and threaded into a readout (`window-registration.js:59-69`, `perfTier`/`maxPerfTier`/`perfTierSource`), but `getRenderState()` (`window-registration.js:86-97`) — the actual seam handed to the render path — returns only `{enabled, params, debugChannel}`. **perfTier never reaches `window-surface-subsystem.js` or `window-render.js` at all.** There is no `windowTierPlan(tier)` function anywhere. Classify: **DECLARED-ONLY**, though this is close to moot since there's only one rung to consume. The one real JS-time perf lever in the code — `glass: true/false` in `buildWindowSurfaceMaterial` (`window-render.js:177`) — is never called with `false` in production (`window-surface-subsystem.js:194-216` never passes `glass`), and the manifest's own deferred rung `glassPerfGate` (`window.js:396-409`) states plainly: *"nothing in this effect rebuilds its material when the profile moves."*

**3. Floor cost profile**: NOT minimal. Tier 0 = 1-3 mask taps (glass triples the tap for dispersion) + **five `simplexFloat` noise taps** for the thickness field (`window-render.js:463-477`) + prism/caustic math + highlight shoulder + daylight tint, every frame, on every visible window quad, because `glass` defaults `true` and is never toggled. The author's own `glassWarpPx = 0` is a *visual* off-switch only — window.js:407-408 confirms the noise still runs. One real, working cost saver does exist: `gateGlass: true` is hardcoded at `window-surface-subsystem.js:215`, which skips the glass computation per-fragment for floor-gated-invisible pixels (motivated by a 2026-08-25 measurement of window light at 5.5× its declared budget on a multi-floor scene) — but that's a visibility optimization, not a tier one.

**4. Per-rung breakdown**: N/A — only rung 0 exists.

**5. Cheapest-possible-component scouting**: The **daylight tint** (`window-render.js:701`, `cookieLight = shoulderedLight.mul(uDaylightTint)`) is a pure C1 per-fragment vec3 multiply — the JS side pre-resolves the day/night/dawn-dusk lerp on the CPU (`window-surface-subsystem.js:479-484`), so the GPU cost is one multiply. This is the exact "water-tint" analogy: a colour grade that should survive any cut. The **highlight shoulder** (`window-render.js:678-681`) is likewise cheap ALU. Both currently ship bundled with the expensive glass — the natural redesign is splitting "flat cookie + tint + shoulder" (cheap) from "glass warp/prism/caustic" (5 noise taps, genuinely the priciest part) into two different rungs, exactly what `glassPerfGate` names but doesn't build.

**6. Test coverage**: WINDOW appears in `effect-tier.test.mjs`'s "REAL shipped manifests" loop (line 203) but only gets the generic `validateEffectManifest(m).ok === true` check. No dedicated anti-drift block exists (confirmed: only candle/vegetation/torque-sway/water/sun-shadow have named `🔒 ANTI-DRIFT` blocks). In fairness, window has no `WINDOW_DEFAULT_TIER`-style fallback constant to drift against yet — the gap becomes consequential only once a second rung ships.

**7. Red flags**: (a) The `glass` cost-shedding lever exists in code but is dead — never wired to the profile system, an honestly-documented gap. (b) Cloud modulation confirmed a genuine no-op: `window-render.js:657` defaults `cloudFactorNode` to a constant, and `vt-pan-viewer.js:9266-9268` explicitly documents omitting it ("`world/cloud-field.js` does not exist yet"). (c) Tier 0 is already the most expensive thing this effect does — there is no cheaper floor to fall back to below it.

---

## DOOR_GRAPHICS

**1. Manifest snapshot** (`src/effects/door-graphics.js`)
- `enabledFromProfile: 'low'` — line 69
- `visualWeight: 0.75` — line 67 (comment lines 56-60: "a door is a load-bearing map element... defended after the structural world/lighting passes but before the pretty atmospherics" — higher than candle/UI-shadow deliberately)
- `a11y.photosensitive: false` — line 68
- `tiers` table (lines 77-84):

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 | — (floor) | C0 (`estMsPerMp: 0.01`) | each textured door renders as an animated leaf, open/close synced to Foundry door state |

Only rung. `deferredRungs` (lines 87-108) names 5 honest gaps: `fog-reveal-sync-close-and-multi-door` (open-direction already shipped 2026-08-27), `roof-occlusion`, `secret-door-visibility`, `per-floor-elevation`, `door-open-sound`.

**2. Consumption trace**: `boot.js:2003-2005` registers the manifest but the callback only refreshes `doorReadout = {enabled, params}` — **no `perfTier` field at all**, not even threaded to a readout the way window's is. `door-graphics-subsystem.js`'s entire per-frame `syncDoorGraphics` (lines 207-324) has zero tier/perfTier references. Classify: **DECLARED-ONLY** (trivially — there's nothing to consume).

**3. Floor cost profile**: Genuinely cheap per-fragment (`buildDoorMaterial`, `door-graphics-render.js:348-366` — one texture sample, tint multiply, alpha multiply) and genuinely cheap per-frame CPU-side (the animated-snapshot recompute is gated behind an `animChanged` check, `door-graphics-subsystem.js:298-320`, a 2026-08-09 perf fix so steady-state doors cost nothing). But it is **not free**: doors live in their own `THREE.Scene`, drawn via a dedicated `renderer.render(doorGraphics.scene, camera)` call (`vt-pan-viewer.js:5182-5188`), instrumented as its own profiler zone `Z.geomDoors` (`vt-pan-viewer.js:5694-5696`). That's structurally the same "whole extra render pass" cost class that UI_WINDOW_SHADOW's own v6 fix (see below) explicitly eliminated for itself — worth naming since these two effects are direct contrasts. It only skips when `leafCount === 0` (no doors in scene). Scoped correctly to the active floor only (`boot.js:1669-1674`, `3133-3137`) — no analogue of window's "every hidden floor still pays" bug.

**4. Per-rung breakdown**: N/A — single rung.

**5. Cheapest-possible-component scouting**: The whole floor already reads as close to the cheapest meaningful thing MSA could draw for a door — four vertices, one texture sample, no simulation, no per-fragment noise. If anything is separable, it's the **animation math itself** (`applyDoorAnimation`, pure CPU-side, already gated to only run on change) vs. the **extra render pass**, which is a fixed cost regardless of quality and not really a "component" to cut.

**6. Test coverage**: DOOR_GRAPHICS is **absent** from both `effect-tier.test.mjs`'s "REAL shipped manifests" loop and `effect-registration.test.mjs`'s shared loops (confirmed via grep — zero matches in either). It does have its own dedicated file, `door-graphics.test.mjs`, which validates the manifest and asserts one real value: `DOOR_GRAPHICS.tiers[0]?.n === 0 && /leaf/.test(...)` (line 48). So it's not un-tested, just not part of the shared cross-effect ladder machinery.

**7. Red flags**: The `cost.class: 'C0'` label is worth a second look against this project's own taxonomy, where C8 is explicitly "extra geometry/draw call" — doors are literally an extra `Mesh` per leaf plus a dedicated `renderer.render()` call. C0 ("constant") is likely intended in the `estMsPerMp` sense (cost doesn't scale with screen resolution, since it's a fixed few-vertex quad) rather than "no draw call," but the label sits oddly next to the taxonomy's literal wording — a naming tension, not a functional bug. No non-monotonic behavior found; no CANNOT-get-cheaper wall beyond what's already noted.

---

## UI_WINDOW_SHADOW

**1. Manifest snapshot** (`src/effects/ui-window-shadow.js`)
- `enabledFromProfile: 'extreme'` — line 145 (confirmed; the ONE effect gated to top-only)
- `visualWeight: 0.3` — line 135 ("decorative chrome — the first thing to drop")
- `a11y.photosensitive: false` — line 138
- `tiers` table (lines 147-154):

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 | — (floor) | C1 (`estMsPerMp: 0.1`) | open UI windows cast a soft, offset shadow on the map |

Only rung. `deferredRungs` (156-166): `parallax-by-floor`, `tinted-shadow`, `per-window-height`. Readiness note (139-143) is unusual and worth quoting: *"no draw call at all by design (the v6 perf fix removed its extra pass)."*

**2. Consumption trace**: Registered inline at `boot.js:688`, no dedicated `*-registration.js` (see pattern note below). No perfTier reference anywhere in its consumption path (`vt-pan-viewer.js` grep for `uiWindowShadow`/`uiShadow` returns zero perfTier hits). Classify: **DECLARED-ONLY** — again trivially, one rung.

**3. Floor cost profile**: This is the one genuinely interesting finding. The runtime (`light-visibility.js#buildUiShadowVisibility`, lines 469-538) builds **no material and no mesh** — it returns a bare TSL `visNode` (a fixed 6-slot unrolled box-SDF loop, `MAX_UI_SHADOW_STAMPS = 6`, line 374) that gets multiplied directly into `environmental-light.js`'s **already-running composite shader** (`environmental-light.js:488`, `illumTexNode.rgb.mul(uiShadowVisNode)`). The v5→v6 history (`environmental-light.js:238-253`) is explicit: the old version threw away a whole extra `render()` call because that pass itself — not the DOM read — was the dominant cost. This is a genuinely well-optimized floor.

**4. Per-rung breakdown**: N/A — single rung.

**5. Cheapest-possible-component scouting**: The floor **already is** the cheapest form this effect could take (C1, zero extra draw calls, zero extra render targets, folded into infrastructure that runs anyway) — matches the prompt's "state plainly that the floor already IS the cheapest meaningful thing."

**6. Test coverage — the real finding**: `UI_WINDOW_SHADOW` is the literal base fixture spread throughout both `effect-tier.test.mjs` (lines 47, 74, 91, 103, 160, 176, 183 — every synthetic ladder in the file starts as `{...UI_WINDOW_SHADOW, tiers: [...]}`) and `effect-registration.test.mjs`. Real values ARE asserted — `id`, `a11y.photosensitive`, `enabledFromProfile === 'extreme'` (`effect-registration.test.mjs:96-98`) — but its own actual `tiers[0]` content (name `'soft-offset'`, `cost.class: 'C1'`) is never checked anywhere: a repo-wide grep for `soft-offset` returns exactly one hit, the manifest source itself. Confirmed coverage gap exactly as hypothesized: the shape-testing machinery exercises this manifest constantly while its own shipped ladder values ride along untested.

**7. Red flags — genuinely surprising one**: `uiShadowVisNode: uiShadow.visNode` is passed **unconditionally** into the composite material at one-time construction (`vt-pan-viewer.js:2609`), and that composite material is never rebuilt per profile. So the 6-iteration box-SDF loop is permanently baked into the shader that runs on every screen fragment, every frame, at **every profile**, not just 'extreme' — `enabledFromProfile: 'extreme'` only controls whether `updateUiShadowStamps()` feeds it real geometry or all-zero uniforms (`vt-pan-viewer.js:2999-3007`). The visual result is a correct no-op below 'extreme', but this is the flip side of the `tsl/no-uniform-gates` doctrine this codebase otherwise enforces strictly ("if turning it off does not shrink the compiled shader, it is not off") — here there's no separate compiled shader to shrink, because the whole point of the v6 fix was folding this into shared infrastructure. Almost certainly immaterial in practice (6 cheap ALU iterations, matches its own honest C1 label) but worth flagging precisely since it doesn't fit this codebase's usual off-switch shape.

**Pattern note** (applies to all three): exactly 5 effects have a dedicated `*-registration.js` (`fluid`, `specular`, `window`, `aperture-gobo`, `water`) — the ones complex enough to need their own live-override/debug-channel/console-setter machinery. WINDOW is one of them. DOOR_GRAPHICS and UI_WINDOW_SHADOW register inline in `boot.js`'s `install()` instead — simpler effects, simpler seam.

### WINDOW / DOOR_GRAPHICS / UI_WINDOW_SHADOW at a glance

| Effect | Ladder | Consumption | Floor cost | Test gap |
|---|---|---|---|---|
| WINDOW | 1 rung (C4), 11 named-unbuilt deferred rungs | Declared-only; the one real perf lever (`glass:false`) exists but is never wired | Surprisingly expensive — 5 noise taps always run; tint/shoulder pieces are the cheap, keep-forever part | Generic shape-check only, no anti-drift block (though none is yet needed) |
| DOOR_GRAPHICS | 1 rung (C0) | Declared-only; not even threaded to a readout | Per-fragment nearly free, but a real dedicated render pass when any door exists | Absent from shared test loops; has its own manifest test file instead |
| UI_WINDOW_SHADOW | 1 rung (C1), gated to 'extreme' only | Declared-only; disable is a uniform-zeroing, not a shader-shrink | Already about as cheap as this class of effect gets — folded into existing composite, zero draw calls | Used constantly as the generic test fixture; its own real tier values are never asserted |

### D. Candle, Lightning, Aperture Gobo

## CANDLE_FLAME — audit findings

**1. Manifest snapshot** (`src/effects/candle-flame.js`)
`enabledFromProfile: 'low'` (line 204) · `visualWeight: 0.5` (line 202) · `a11y.photosensitive: false` (line 203).

Tiers table (lines 237–272):
| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 "ember" | — (floor) | C0 | calm flame at every candle + one merged warm pool per room |
| 1 "flicker" | low | C1 | cast light gains two-octave flicker + warm/cool temperature shift |
| 2 "life" | performance | C2 | chaotic per-candle guttering, wind lean, draft-snuff |
| 3 "boil" | standard | C2 | silhouette boils/curls; light gains breathing core + wavering edge |
| 4 "perCandle" | extreme | C8 | candles stop sharing a light — near one full point light each |

**2. Consumption trace — CONSUMED.** Two independent, real call sites. (a) `candle-flame-geometry.js:362`, `candleTierPlan(perfTier)` inside `buildCandleLightSources`, feeds `lightQuality`/`clusterFactor` into every cluster's light descriptor; called from `point-light-pool.js:1199-1210` with `perfTier: candleLightState.perfTier`. (b) `vt-pan-viewer.js:5098-5102`, `candleTierPlan(state.perfTier).flameQuality` picks the flame material's build-time `quality` (unless `animationQuality` is pinned explicitly). `state.perfTier` itself is threaded end-to-end: `boot.js:1789-1793` (`candleReadout.perfTier = resolved.perfTier`) → `boot.js:3222-3227` (`getCandleRenderState()` returns it). No gap anywhere in the chain.

**3. Floor cost profile.** Tier 0 draws every candle's flame billboard (one batched quad, one draw call for the whole scene — measured at 0.022ms total, header comment lines 229-233) plus at minimum one merged point light per room (`clusterFactor: 2.0`, the coarsest merge of any tier). The floor is genuinely cheap on the flame side; the light side is never literally free (a cluster light is a full Foundry-parity mesh through the shared pool), but tier 0 minimizes light *count* as hard as the ladder allows.

**4. Per-rung breakdown.** 1: pure ALU added to the already-drawn light shader (2-octave flicker + colour shift), no new draw calls. 2: per-candle noise (guttering/lean/snuff) on the flame shader — still same one draw call. 3 (today's default/shipped look): domain-warped silhouette + breathing/wavering light. 4: abandons clustering almost entirely (`clusterFactor: 0.25`) — draw-call count explodes, correctly classed C8.

**5. Cheapest-component scouting.** The entire flame *visual* axis (silhouette, colour ramp, core glow) is already effectively free — 0.022ms for every flame billboard in the scene, regardless of tier, vs 13.1ms in the two light passes (header comment, lines 229-233). There is no further sprite-side component worth trimming; a "light-only, no flame sprite" fallback would save almost nothing, because the sprite is already ~600× cheaper than the light. The correct (and already-built) lever is exclusively light *count*, via `clusterFactor` — this ladder already targets the right axis.

**6. Test coverage.** The best-tested ladder audited: dedicated anti-drift block in `effects/__tests__/effect-tier.test.mjs:207-244` — checks `CANDLE_DEFAULT_TIER` equals what `DEFAULT_PERFORMANCE_PROFILE` actually resolves to (no second authority), checks the default rung reproduces the shipped look exactly, and checks `clusterFactor` moves in the correct direction at both `low` and `extreme`.

**7. Red flags.** None structural. Genuinely well-designed: the ladder's cost classes track the real measured cost driver (light count, not flame prettiness), fully wired, well tested.

---

## LIGHTNING — audit findings

**1. Manifest snapshot** (`src/effects/lightning.js`)
`enabledFromProfile: 'low'` (line 640) · `visualWeight: 0.65` (line 638) · `a11y.photosensitive: true` (line 639 — the first genuinely-flashing MSA effect, force-disabled for photosensitive players ahead of any GM override).

Tiers table (lines 652–680):
| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 "strike" | — (floor) | C1 | solo ribbon bolt per burst: fractal path, leader growth, restrike flicker, additive glow, wild-arc |
| 1 "branching" | low | C1 | forking side-branches slaved to parent leader growth |
| 2 "flash" | low | C1 | screen-wide flash signal on return-stroke connect |
| 3 "originFlash" | performance | C6 | wall-clipped, darkness-punching point light at bolt origin/impact |

**2. Consumption trace — CONSUMED**, across three files, more thoroughly gated than candle's:
- Tier 1: `lightning-subsystem.js:191` — `perfTier < 1 ? {...params, branchMax: 0} : params`, forced at the one call site into `generateBurst`.
- Tier 2: `lightning-subsystem.js:344-345` — `if (perfTier >= 2) updateOutsideFlash(...); else resetOutsideFlash();`.
- Tier 3: `vt-pan-viewer.js:1281-1284` — `lightningState.enabled && ... && Number(lightningState.perfTier) >= 3 ? buildLightningLightSources(...) : []`. Below tier 3, *no* origin light sources are constructed at all.
- Shader detail: `lightning-subsystem.js:58-60`, `qualityForTier(perfTier) = perfTier>=2 ? 2 : 0`, drives `lightning-render.js`'s one `quality>=2` gate (line 486, core-static crackle).

**3. Floor cost profile.** Unlike candle, lightning's floor cost is *intermittent by construction*: bolts fire on a burst schedule (default 5-10s gaps), and `mesh.visible = activeStrands.length > 0` — the viewer skips the draw call entirely between bursts (`lightning-subsystem.js` `hasContent` getter). When active, up to 24 strands (main+branches) batch into one draw call. So the floor's *time-averaged* GPU cost is close to zero, punctuated by cheap spikes.

**4. Per-rung breakdown.** 1: branch paths are generated into the *same* batched mesh/pool — no extra draw call, correctly C1. 2: computes a scalar flash envelope, no draw at all; also happens to flip the shader to quality-2 core-static detail. 3: mints real point-light-pool entries — genuinely the expensive rung.

**5. Cheapest-component scouting.** The main-bolt path/branch generation is CPU-side procedural math (pure functions in `lightning-geometry.js`), effectively free next to a GPU draw; nothing to trim further there. The floor's own bursty, mostly-invisible nature already *is* the cheap floor for the visual axis — same story as candle: the expensive thing is exclusively the light (tier 3), correctly isolated as the top rung.

**6. Test coverage.** Absent from the centralized `effect-tier.test.mjs` (no `LIGHTNING` reference anywhere in that file, not even the generic `validateEffectManifest` loop). Instead: `lightning.test.mjs:18` carries the generic well-formed-manifest check standalone. A separate, thorough file, `lightning-subsystem.test.mjs`, drives the *real* tier gates through the actual `sync()` entry point with real THREE — explicitly written (per its own header, lines 9-16) because "the tier-ladder gating bug... had NO test watching it before the fix." It covers tiers 0-2 directly (branch presence, flash-signal gating, live mid-session tier-drop). Tier 3's origin-light gate has **no Node test** — its own header (lines 18-22) states this plainly: it lives in `point-light-pool.js`, browser-only, "left to live Shader Lab / Foundry verification, not faked here."

**7. Red flags.**
- Tier 2's entire output (`outsideFlash01()`, `lightning-subsystem.js:395`) has **zero consumers anywhere in `src/`** — grepped, only its own definition matches. The gate is real and tested, but the feature it unlocks currently does nothing visible; it's future-facing for the `weather-lightning-flash-merge` deferred rung.
- Tier 3's cost class `C6` ("extra render target") reads as a mismatch against its own "adds" text, "reusing the shared point-light pool" — no new render target is allocated, just more geometry into an existing one, which is structurally identical to candle's tier-4 rung (correctly labeled `C8`).
- Not present in the codebase's central cross-effect tier-test file at all, unlike every other manifest the task compared it against.

---

## APERTURE_GOBO — audit findings

**1. Manifest snapshot** (`src/effects/aperture-gobo.js`)
`enabledFromProfile: 'low'` (line 338) · `visualWeight: 0.35` (line 336) · `a11y.photosensitive: false` (line 337).

Tiers table (lines 345–359) — **only one tier exists**:
| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 "projection" | — (floor) | C1, `estMsPerMp: 0` | procedural mullioned pattern through one real Foundry aperture wall, multiplied into that light's own falloff |

Six `deferredRungs` are recorded (per-wall geometry, style library, hole-stack correctness, shutters, shared window art, elevation height) but none are a `tiers` rung — there is no ladder above the floor to audit.

**2. Consumption trace — PARTIALLY CONSUMED, and moot in practice.** `resolved.perfTier` is captured into the registration's `readout` (`aperture-gobo-registration.js:75-85`, including `maxPerfTier`/`perfTierSource`) and *is* surfaced to diagnostics (`boot.js:7638`, `8089`, `8120` all call `apertureGobo.getReadout()`). But `getRenderState()` — the one function the render path actually calls (`point-light-pool.js`'s `getApertureGoboRenderState`, wired at `boot.js:10637`) — returns only `{enabled, params, debugChannel}` (`aperture-gobo-registration.js:97-99`), matching its own JSDoc type (`point-light-pool.js:628`, no `perfTier` field). So perfTier resolves correctly and is visible to a human/debug tool, but is **not plumbed into the render-state seam at all**. Since only tier 0 exists, this has no current effect — but if a tier 1 were ever added, `getRenderState()` would need a companion edit before the render path could see it.

**3. Floor cost profile — a genuine, confirmed zero-cost bypass already exists**, exactly as the manifest's `visualWeight` comment implies (lines 317-322: "a light with no nearby aperture renders completely unchanged"). `buildApertureGoboTerm` (`aperture-gobo-render.js:265-266`): `if (!(apertureCount > 0)) return null;` — a graph-build-time JS branch, so a light with no nearby aperture wall (the overwhelming common case) compiles *none* of the gobo TSL graph in and "pays literally nothing" (the function's own doc, line 231-233). `apertureCount` itself comes from a cheap per-light CPU scan (`findAperturesForLight`, `point-light-pool.js:1681-1688`) — real but tiny, and CPU-side, not GPU. Only once a light *does* have ≥1 assigned aperture does the pattern math (frame/mullion/sill/head gates, two blur laws, glass warp) get baked into that light's *already-existing* illumination/coloration material — no new draw call, no new render target (manifest's own readiness note, lines 339-343).

**4. Per-rung breakdown.** Not applicable — there is exactly one rung, so there is no "1..N" to walk.

**5. Cheapest-possible-component scouting.** The floor already *is* the cheapest meaningful thing, and uniquely among the three effects audited here, the zero-cost path isn't hypothetical — it's shipped and load-bearing for the common case (most lights, most scenes, have no nearby window). Nothing cheaper is scoutable because nothing runs at all for the majority of lights.

**6. Test coverage.** Own-file only: `aperture-gobo.test.mjs:22` carries the generic `validateEffectManifest(APERTURE_GOBO).ok` check plus a same-file `enabledFromProfile === 'low'` check (line 28). Grepped for `tier`/`perfTier` (case-insensitive) across the whole file: zero matches. No anti-drift cross-check exists (there is only one rung, so there is nothing to cross-check against a resolved default the way candle's `CANDLE_DEFAULT_TIER` is).

**7. Red flags.**
- The render-state seam (`getRenderState()`) silently drops `perfTier` even though the registration layer already resolves and stores it — a latent gap, currently harmless only because there's nothing to gate.
- This is the only one of the three effects with no actual ladder — "per-rung breakdown" is inapplicable, worth flagging explicitly rather than padding.
- Nothing non-monotonic, nothing structurally uncheapenable beyond what's already built.

### At a glance

| Effect | Ladder | Consumption | Floor cost | Notable finding |
|---|---|---|---|---|
| CANDLE_FLAME | 5 rungs (0-4) | Fully consumed, 2 real call sites, best-tested ladder in the codebase | Flame ~free (0.022ms/scene); light merged as hard as possible | Flame visuals are already ~600× cheaper than the light — no light-only fallback needed, the ladder correctly targets light count only |
| LIGHTNING | 4 rungs (0-3) | Fully consumed across 3 files, more granularly gated than candle | Bursty/near-zero time-averaged (invisible between strikes) | Tier 2's flash signal is computed and gated correctly but has zero downstream consumers anywhere in `src/` yet |
| APERTURE_GOBO | 1 rung (floor only) | perfTier resolved but not forwarded to the render-state seam (moot today) | Genuine shipped zero-cost bypass for the common (no-aperture) case | No ladder above the floor exists — "per-rung breakdown" is structurally not applicable |

### E. Grade, Bloom, Depth of Field, Precipitation

# Performance-Tier Audit: GRADE, BLOOM, DEPTH_OF_FIELD, PRECIPITATION

## 1. GRADE (Colour Grade)

**Manifest snapshot** (`src/effects/grade/grade.js`):
- `enabledFromProfile: 'low'` (line 148) — on at every profile.
- `visualWeight: 0.75` (line 146). `a11y.photosensitive: false` (line 147).
- Tiers table: **one rung only**.

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 | — (unconditional) | C2 (`estMsPerMp: 0.15`) | full primary chain (exposure/WB/contrast/saturation/vibrance/split-tone) + selectable tone map + optional 3D LUT, folded into present (lines 155–162) |

`deferredRungs` (163–184) lists 5 future items — bundled/author LUT loading, HSL secondaries, gamma wheel, 1D curves. None of them is "performance tiers" — grade's manifest never even records an intention to build a cost ladder beyond the floor.

**Consumption trace**: `resolved.perfTier` reaches `gradeLookReadout.perfTier` at registration (`boot.js:1984-1995`) but `pushGradeLook()` (`vt-pan-viewer.js:7854-7886`) reads only `st.params` — never `st.perfTier`. **DECLARED-ONLY.** Structurally moot, though: the ladder has no rung above 0 to select.

**Floor cost profile — the interesting one**: GRADE is folded into the present-composite fragment shader (`grade-present.js`), which runs every frame unconditionally (present must always draw). `rebuildFragment()` (132–159) *always* calls `buildGradeNode` for both env and artistic scopes, and the artistic call always includes the tail with `lutTexture: lutTexNode`. A real `Data3DTexture` placeholder identity LUT is bound at construction (`vt-pan-viewer.js:5536-5544`, `lutPlaceholder = makeIdentityLutTexture(THREE)`), so a 3D-texture sample (C2) executes on **every pixel, every frame, regardless of whether the effect is enabled** — disabling GRADE only writes identity uniform values (`pushGradeLook`'s `st.enabled===false` branch, line 7856-7859), it does not remove the ALU chain or the LUT fetch. Only the tone-map curve is compile-time gated (`currentToneMapping`).

**Per-rung breakdown**: N/A — one rung.

**Cheapest-component scouting**: The primary ops chain itself (exposure/contrast/saturation/temperature/tint, `grade-ops.js:278-309`) is pure C1 ALU with no extra draw call — this is effectively already the project owner's "water tint" ideal case, and it's already folded into a mandatory pass at zero marginal cost. The one non-C1 piece is the 3D LUT sample (C2), already neutralized via `lutStrength` but not skipped.

**Test coverage**: Only the generic well-formed-manifest check (`effect-tier.test.mjs:202,205`). No dedicated cross-check block (unlike candle/vegetation/water/sun-shadow at lines 217, 263, 350, 387).

**Red flags**: (1) An effect that structurally cannot get cheaper than it already is — no full-pass early-out exists because present always runs, so even "disabled" pays the ALU+LUT-sample cost. (2) The declared frame-graph seam `post.grade` is literally unbuilt — `grade-pass.js:35-45` throws `NotBuiltError`; the real implementation lives entirely in `grade-present.js` instead (intentional per Grade.md §5, but a trap for a reader who greps `graph/passes.js`).

---

## 2. BLOOM

**Manifest snapshot** (`src/effects/bloom.js`):
- `enabledFromProfile: 'low'` (234). `visualWeight: 0.7` (232). `a11y.photosensitive: false` (233).

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 | — (unconditional) | C2 (`estMsPerMp: 0.3`) | Jimenez/COD 13-tap+Karis downsample + tent upsample, tight core + wide atmosphere bands, masked bright-pass input, additive composite (241–248) |

`deferredRungs` (250–267) **explicitly names `'performance-tiers'`** (263-266): *"governor-driven resolution scale + mip count per performance profile — tier 0 is fixed half-res, 6 mips"* — bloom's own manifest candidly admits the real ladder doesn't exist yet.

**Consumption trace**: `resolved.perfTier` reaches `bloomReadout.perfTier` (`boot.js:1865-1877`) for UI display only. `runPostBloomPass()` (`vt-pan-viewer.js:6992-7074`) reads only `st.params`; mip count is the hardcoded constant `BLOOM_MIP_COUNT = 6` (line 2867), never perfTier-derived. **DECLARED-ONLY.**

**Floor cost profile**: 6 screen-sized HalfFloatType render targets allocated upfront at viewer construction (2885-2888) regardless of enable state (fixed VRAM, not gated). Per-frame: genuine full-pass early-out — `if (!st.enabled) return;` (line 6994) — zero GPU time when off. When on, tier 0 IS the whole pipeline: bright pass → 5-step downsample → 2×3-step tent upsample (two independently-spread bands) → composite. Not minimal; it's the entire technique with no cheaper variant.

**Per-rung breakdown**: N/A — one rung.

**Cheapest-component scouting**: None found. Every stage is texture-read-driven (minimum C2); there is no standalone C0/C1 sub-feature — you cannot have "a little bloom" for ALU cost alone. The only real lever is the whole PASS, which is already skippable (see above).

**Test coverage**: Generic manifest check only (`effect-tier.test.mjs:198,205`). No dedicated cross-check.

**Red flags**: The ladder is one rung, and unlike GRADE, bloom is self-aware about it (`deferredRungs['performance-tiers']`). Coarse-grained saving (whole-pass skip) already exists and is the right shape for this effect — but there's no story yet for a mid-tier "cheaper bloom," e.g. fewer mips or half the taps.

---

## 3. DEPTH_OF_FIELD

**Manifest snapshot** (`src/effects/depth-of-field.js`):
- `enabledFromProfile: 'low'` (143). `visualWeight: 0.55` (141). `a11y.photosensitive: false` (142).

| n | fromProfile | cost.class | adds |
|---|---|---|---|
| 0 | — (unconditional) | C2 (`estMsPerMp: 0.15`) | 4-level downsample pyramid of scene.lit, fractional-LOD ring-sampled composite driven by floor distance, NormalBlending (150–159) |

`deferredRungs` (161-177) also **explicitly names `'performance-tiers'`** (173-176): *"governor-driven mip count / resolution scale per performance profile — tier 0 is a fixed 4-mip chain"* — same honest admission as bloom.

**Consumption trace**: `resolved.perfTier` reaches `dofReadout.perfTier` (`boot.js:1884-1894`) for UI only. `runPostDofPass()` (`vt-pan-viewer.js:7086-7139`) reads only `st.params`; `DOF_MIP_COUNT = 4` is a hardcoded constant (2921). **DECLARED-ONLY.**

**Floor cost profile**: Best-behaved of the three post effects — TWO independent zero-cost early-outs: `if (!st.enabled) return;` AND `if ((view?.floorIndex ?? 0) === 0) return;` (7088-7089), the second entirely game-state-driven (nothing below the ground floor). 4 mip targets allocated upfront regardless. When active: 4-step 13-tap downsample + one ring-sampled (8 taps/mip × up to 4 mips) composite.

**Per-rung breakdown**: N/A — one rung.

**maxBlur inertness — verified current**: `computeDofMipSample` (`depth-of-field-blur.js:97-111`) computes `lod = min(topLod·maxBlur, floorsBelow·blurPerFloor·strength)`. At shipped defaults (`strength=0.125, blurPerFloor=1.2`, `depth-of-field.js:52,64`) and `topLod=3`, the cap (`3·1.0=3`) only binds once `floorsBelow > 3/(1.2·0.125) ≈ 20` — unreachable in any realistic Foundry building. Even the "heavy" preset (`strength=0.25, blurPerFloor=2.2`, line 101) needs `floorsBelow > 3/(2.2·0.25) ≈ 5.5`. **Confirmed still functionally inert at realistic floor counts.** This does **not** connect to the tier ladder — the ladder has no rung beyond 0, so `maxBlur` is a plain author-facing param entirely orthogonal to tiering, not a rung-gated behavior. The 2026-08-27 live-feedback item's "controls aren't reliable" concern is a param-design issue, unrelated to tier-ladder structure.

**Cheapest-component scouting**: None — same texture-read-bound pipeline shape as bloom, no C0/C1 sub-feature.

**Test coverage**: Generic manifest check only (line 199, 205). No dedicated cross-check.

**Red flags**: `maxBlur` inert (above) — a real, unfixed bug independent of this audit's tier focus. Otherwise the cleanest floor-cost story of the three (two genuine zero-cost gates).

---

## 4. PRECIPITATION — outside the tier system entirely

Confirmed: no file under `src/effects/precipitation/` (or its `particles/precip-*runtime.js` siblings) contains `enabledFromProfile`, `tiers`, `PERFORMANCE_PROFILES`, or any profile/tier keyword tied to the effect-cascade — a targeted grep across the whole directory turned up zero hits beyond one deliberately-named-but-inert hook (below). Precipitation has no manifest and is invisible to `effect-manifest.js`/`effect-cascade.js`/`registry.js`.

**What actually governs its cost today — three independent axes, none of them "performance profile":**

1. **Weather intensity** (`precip01`, 0..1, from the weather manager) drives `evalCurve(species.respond.count, precip01)` → `liveCount = round(capacity × countFrac × tierScale)` (`precip-species.js:1216-1217`). This is a *content* axis (how hard is it raining), not a *hardware-budget* axis.

2. **A quasi-tier hook that exists but is permanently disconnected**: `resolveSpeciesFrame(species, axes, tierScale=1)`'s own JSDoc calls `tierScale` *"the effect cascade's own budget multiplier"* (`precip-species.js:1206`), and the formula genuinely multiplies live particle count by it (1214, 1217). But its **one and only producer**, `getPrecipRenderState()` in `vt-pan-viewer.js:3343-3375`, hardcodes `tierScale: 1` as a literal (line 3373) — never derived from `resolveEffectTier`, a profile, or anything else. This is a real, load-bearing parameter wired to a **constant**, not merely an unread field — worse than a silently-unread ladder rung, because it looks live in the formula and isn't. A LOW-profile machine gets exactly the same `liveCount` as an EXTREME one at the same weather intensity and zoom.

3. **The zoom gate** (`specimenAwake`, `precip-subsystem.js:274-302`): camera-distance LOD — below `species.zoomSleepPxPerBody` screen px, the specimen tier sleeps (a JS `continue`, line 623, zero draw calls) and the curtain (P4 impression tier) carries the picture alone. This is a real, cheap (Effects.md Law 7) cost-shedding mechanism, but it answers "is this visible" not "does this machine have budget" — it fires identically on every performance profile at a given zoom.

**Floor-state cost**: There is no "tier 0" concept, so the closest equivalent is "clear sky" — `sync()` returns early with zero allocation the moment `precip01 === 0` (`precip-subsystem.js:570-573`, Law 5), *except* the mantle (snow/puddle persistence) and drips (roofline tail), which deliberately keep running through a clear sky because their whole point is outliving the rain (546-566). `capacity` per species (rain 15000, snow 20000, ash 18000, sand 24000, etc.) is a fixed max-tier arena reservation, allocated once, independent of any profile — VRAM/buffer sizing for precipitation is profile-blind exactly like its draw-time count is.

**Species built-ness**: `PRECIP_SPECIES_IDS` names 8 (`rain, snow, hail, ash, sand, spore, petal, mote`); `PRECIP_SPECIES_PLANNED` is now **empty** as of P6 (2026-08-16, `precip-species.js:85-95`) — every named id has a fully-authored DATA row, so `isBuiltSpecies(id)` (1182-1185) is true for all 8. But `KIND_TO_SPECIES` in `precip-subsystem.js:56-68` — the router from a *weather* kind to a species — only maps `rain/snow/hail/ash`; `sand/spore/petal/mote` are fully "built" by the `isBuiltSpecies` test yet **unreachable** through the ordinary weather manager (they're intended for a future slice-4 event system). Reading `isBuiltSpecies` alone would overstate what's actually selectable today.

**Enable/override**: `getPrecipRenderState()` hardcodes `enabled: true` (line 3347) — precipitation has no GM/player on/off override wired at all, unlike every registered effect's full cascade. The only "off" path is weather reporting `precip01===0` or an unmapped species. There is also no `a11y.photosensitive` gate anywhere (no manifest to carry one); `flash01` is itself hardcoded to `0` today (line 3372, "sky-flash's own consumer is a later slice") so this is currently moot but worth flagging as a gap-in-waiting.

**Red flags**: (1) `createPrecipitationSubsystem` is confirmed genuinely live — `sync()` is called every frame (`vt-pan-viewer.js:13077-13082`) and `runSurfacePrecipitationPass` is wired into the real pass plan (`passImpls['surface.precipitation']`, line 7151) — this is not dormant scaffolding. (2) The `tierScale` hook is the most deceptive finding in this whole audit: it reads as "the effect cascade's own budget multiplier" in its own doc comment and is multiplied into a real cost formula, yet is permanently pinned to `1` — a wired-but-inert lever, not an absent one. (3) No performance-profile axis exists for precipitation at all today; the only cost relief is content-driven (weather intensity) or visibility-driven (zoom), never hardware-budget-driven.

### At a glance

| Effect | Tier ladder | Consumption | Floor cost | Cheapest-possible component | Test coverage |
|---|---|---|---|---|---|
| GRADE | 1 rung (floor only) | DECLARED-ONLY | Always-on ALU+LUT sample in present pass, even when "disabled" — cannot get cheaper | Primary ops chain (C1 ALU, no draw call) — already near-ideal | Generic manifest check only |
| BLOOM | 1 rung; manifest admits "performance-tiers" is deferred | DECLARED-ONLY | Zero when disabled (full early-out); full 6-mip pipeline otherwise, no partial mode | None found — every stage ≥C2 | Generic manifest check only |
| DEPTH_OF_FIELD | 1 rung; manifest admits "performance-tiers" is deferred | DECLARED-ONLY | Zero when disabled OR on ground floor (two real early-outs) | None found — every stage ≥C2; `maxBlur` confirmed still inert at realistic floor counts | Generic manifest check only |
| PRECIPITATION | No manifest, no ladder at all | N/A — outside the system; its one "budget" hook (`tierScale`) is wired but hardcoded to 1 | Zero on clear sky (except mantle/drip tail by design); cost scales with weather + zoom, never with hardware | Zoom-gate sleep is genuinely free but answers visibility, not budget | No coverage — not in effect-tier.test.mjs at all |
