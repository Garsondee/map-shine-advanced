# Point-Light Batching — Stage 2's Mechanism of Record

Status: **PLAN OF RECORD — countersigned by Fable (claude-fable-5), 2026-08-11.** Supersedes the
same-day DRAFT of this file (whose open questions are now decided) and the Testament's original
"storage-buffer soup" sketch (struck — see P-004's resolution in `docs/holy/V4-Testament.md`).
Executors: read this WHOLE file before touching any S2 task. Worker-class models execute and
mark only; ANY surprise — a check that won't pass, a limit hit, a shape that doesn't match this
document — is a petition, never an improvisation.

Every factual claim cites the real file it was read from. If this document and the code ever
disagree, the code is telling you something changed — stop and petition; do not silently adapt.

---

## §0 The verdict in one screen

**Build:** merge all point lights that share one compiled material into ONE non-indexed,
ungrouped mesh per (bucket × channel), per-light values carried as **packed per-vertex
attributes**, drawn with the SAME shading graph production already uses — extracted once into a
shared core so the batched and per-light materials cannot drift. One draw call per bucket per
channel instead of two per light.

**Never do these (each has cost this project already paid):**

1. ❌ **No `uniformArray`/storage-buffer DYNAMIC-INDEX reads of per-light data in the FRAGMENT
   stage** — the one confirmed, still-live production failure:
   (`point-light-illumination.js:1289` `edgeSoftFactor` — scene went solid black, disabled since
   2026-07-19, root cause never found). ⚠️ **CORRECTION, 2026-08-11:** this rule previously ALSO
   cited a second, "vertex-stage" failure (bench-point-lights.js scenario 3) as independent
   evidence — that finding was RETRACTED the same day: it was a Y-flip bug in the bench's own
   `sampleColor()` (`row = fy*DIM` instead of `row = (1-fy)*DIM`), not a device defect. The
   vertex-stage indexed-transform mechanism was measured again with the fix and passes cleanly.
   See V4-Testament.md's P-004 third addendum for the full account. The BUILD decision below is
   UNCHANGED (packed per-vertex attributes were already independently proven and remain the
   simpler, zero-indexing choice regardless of whether vertex-stage `uniformArray` also works) —
   only the STATED REASON narrows to the one still-real fragment-stage failure. Memory:
   `keyhole-uniformarray-indexed-read-unexplained-failures` (also corrected).
2. ❌ **No second hand-written shader.** The batched material is the S2.1 shared core with
   attribute inputs; the per-light material is the SAME core with uniform inputs. If you are
   copy-pasting shader graph code between two builders, you are building the
   `feedback_mode_forks_silently_drop_features` bug — stop.
3. ❌ **No per-frame GPU buffer/attribute allocation.** The 2026-07-18 device-loss autopsy
   (`point-light-pool.js:735-754`): `BufferAttribute` has no `dispose()`; churning them leaks
   native buffers until the device dies. Buckets pre-allocate, grow by doubling, rebuild only on
   membership change.
4. ❌ **Do not re-enable `edgeSoftFactor` or coloration `uShadows`.** Both are disabled in
   production with documented live failures. Batching must reproduce today's ACTUAL output —
   which does not include them — byte for byte.
5. ❌ **No runtime uniform-driven behaviour branches** (`tsl/no-uniform-gates`,
   `world/wind-access.js` header). Animation type, falloff model, quality, wind presence,
   aperture unroll counts are graph-BUILD-time. That is exactly why buckets exist.

---

## §1 Measured reality (what this stage is actually against)

From `stage1-earlyz-bench-result.json` (S1.6 capture, First Floor, flag ON, idle machine):

| zone                                                    | GPU ms           | CPU ms    | draws   |
| ------------------------------------------------------- | ---------------- | --------- | ------- |
| `light.drawPointLights`                                 | 0.348            | 1.304     | 68      |
| `light.drawColoration`                                  | 0.352            | 0.825     | 68      |
| `light.drawWindowLight`                                 | 0.161            | 0.184     | 4       |
| `light.drawRegions`                                     | 0.065            | 0.138     | 8       |
| `light.drawComposite` + `drawIllum` + `drawCandleFlame` | 0.230            | 0.319     | 4       |
| `light.pointLightUpdate` (CPU reconcile)                | —                | 2.710     | 0       |
| **`pass.light.accumulate` total**                       | **1.156 summed** | **5.886** | **152** |

The pass is CPU-bound: ~39 µs of CPU per draw call against a GPU that finishes the whole light
stack in 1.156 ms. The cost splits into two roughly equal halves — draw submission (~2.1 ms
across 136 point-light draws) and the JS reconcile (2.710 ms) — and Stage 2 attacks BOTH.

**S2.0 census of the real Mansion** (`tools/point-light-census.mjs` against
`tests/playwright-artifacts/look/mansion-redux-remapped.json`, 2026-08-11):

- 50 document lights: **every one `flame`-animated, every one coloured, zero hidden, zero
  aperture-lit** → exactly **ONE bucket** → 2 draws (was 100).
- **207 `candleFlame` anchors** → runtime candle lights, already clustered by perfTier before
  reaching the pool (`buildCandleLightSources`); all share one material identity
  (candleFlicker + inverseSquare + wind + one quality tier) → **one more bucket pair** → 2 draws.
- **Zero aperture walls on the entire scene** — deferring aperture batching costs nothing on the
  flagship content.
- 37 of 50 lights carry a darkness activation window — membership can CHANGE as darkness01
  drifts (lights entering/leaving the active set), so bucket membership transitions are a
  normal, recurring event, not a rare GM-edit event. The lifecycle in §3.4 is sized for that.

Projected steady state on this content: 136 point-light draws → **~4-6** (flame pair, candle
pair, plus a fire/lightning pair when active). The S2.9 draw gate (≤16) has real headroom.

---

## §2 The two lawful carriers for per-light data

1. **Packed per-vertex attributes** — for every fixed-size per-light value. Proven on this
   device: bench scenario 2 (per-vertex colour, merged mesh, byte-identical to separate draws)
   and production's own `vColor`-style attribute reads in fragment stage (auto-varying works —
   the bench's `fragmentNode` reads `attribute('vColor','vec3')` and renders correctly).
2. **Data textures sampled by computed UV** — for variable-length per-light data ONLY (edge
   points, apertures — neither needed in v1: `edgeSoftFactor` is disabled and aperture-lit
   lights stay per-light). The technique is this project's daily bread
   (`screenUV` sampling throughout the lighting stack); reserved here as the named escape hatch
   so nobody reinvents `uniformArray` when a variable-length need appears.

---

## §3 Architecture

### §3.1 Bucket key

`(channel, animationEntryIdentity, animationQuality, falloffModel, windPresent)` where:

- `channel` ∈ {illumination, coloration} — two meshes per bucket, mirroring today's two-mesh-
  per-light structure (`point-light-pool.js#createLightEntry`).
- `animationEntryIdentity` = the RESOLVED registry entry (`resolveLightAnimation`,
  `animations/registry.js:363`), with null (no/unported animation) as its own value. Key on the
  resolution, not the raw string: two unported type strings bake identical materials.
- `falloffModel` ∈ {foundry, inverseSquare} (`point-light-illumination.js:1276`).
- `windPresent` = `Number.isFinite(light.windExposure)` (`point-light-illumination.js:1196`) —
  candles true, document lights false.
- **Aperture-lit lights (`apertureCount > 0`) do not enter buckets at all in v1** — they keep
  today's per-light path unchanged (own meshes, own materials, own per-frame aperture uniform
  writes). Census: zero exist on the flagship map. Their unroll counts (`apertureCount`,
  `apGoboCols`, `apGoboRows`) are graph-build-time (`aperture-gobo-render.js` header;
  `point-light-pool.js:1240-1249`) and would fragment buckets by construction.

**Coloration membership:** a light joins a coloration bucket iff
`hasColor || animationEntry.forceDefaultColor` — Foundry's own `isRequired` gate
(`point-light-coloration.js` header). Today production draws a colourless light's coloration
mesh with alpha 0 (a visible-mesh workaround, `vt-pan-viewer.js`); batching culls it by
membership instead, which is both cheaper and closer to real Foundry. (Census: all 50 Mansion
lights are coloured, so this changes nothing there — the rule exists for other maps.)

### §3.2 The shared shading core (S2.1 — the load-bearing refactor)

Extract from `buildPointLightIlluminationMaterial` + `buildPointLightColorationMaterial` ONE
pair of core functions (same file, exported):

```
buildIlluminationShadingCore({ THREE, inputs, shared, flags }) -> { finalNode, alphaNode }
buildColorationShadingCore({ THREE, inputs, shared, flags }) -> { finalNode, alphaNode }
```

- `inputs` — per-light VALUES as NODES, the caller's choice of uniform or attribute:
  `localUnitXY` (replaces every internal `positionLocal.xy` read — the per-light binding passes
  `positionLocal.xy` itself; the batched binding passes `attribute('aLocalUnit','vec2')`),
  `ratio`, `attenuationEased`, `exposure`, `expectedDepth`, `backgroundColor`, `dimColor`,
  `brightColor` (illumination); `attenuationEased`, `colorationAlpha`, `lightColor`,
  `expectedDepth` (coloration); plus `anim: {speedRaw, reverseSign, seed, intensityRaw} | null`
  and `wind: {centerXY, exposure, response} | null`.
- `shared` — the pool-wide resources, unchanged and still uniforms/textures:
  `uGlobalTimeMs`, `depthTexNode`/`depthFlagsTexNode`/`attrTexNode`, `sunShadowSlotNodes`,
  `blendSunVisibilityAcrossFloors`, `albedoTexture`, `apertureGoboShared`.
- `flags` — the graph-build-time key fields (`animationEntry`, `quality`, `falloffModel`,
  `apertureCount`+`cols`+`rows` — batched bindings always pass `apertureCount: 0`, which
  compiles the gobo term out via the existing JS-time branch).

The EXISTING per-light builders become thin wrappers: create their uniforms exactly as today,
call the core, return the same `{material, u*}` handle objects — **their public API to
`point-light-pool.js` does not change in S2.1**, which is what makes S2.1 independently
gateable: harness capture before vs after must be byte-identical, proving the extraction moved
the graph without changing it.

### §3.3 Batched vertex layout (the 8-buffer arithmetic, done here so nobody redoes it wrong)

Non-indexed triangle list (matching `triangulateLightFan`'s own convention — no `setIndex`
anywhere in the pool), all member fans concatenated, per-light values DUPLICATED across that
light's vertices. Mesh transform identity; camera unchanged.

Illumination bucket:

| #   | buffer       | type | contents                                                                                                                                                                                                 |
| --- | ------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `position`   | vec3 | world-space fan vertex (x, y, 0) — placement BAKED at write time                                                                                                                                         |
| 2   | `aLocalUnit` | vec2 | unit-radius local coords, the fan builder's pre-placement output — reproduces the per-light path's `positionLocal.xy` through the identical attribute→varying path (this is what makes `dist` bit-exact) |
| 3   | `aParams`    | vec4 | (ratio, attenuationEased, exposure, expectedDepth)                                                                                                                                                       |
| 4   | `aColorA`    | vec4 | (background.r, background.g, background.b, dim.r)                                                                                                                                                        |
| 5   | `aColorB`    | vec4 | (dim.g, dim.b, bright.r, bright.g)                                                                                                                                                                       |
| 6   | `aColorC`    | vec4 | (bright.b, spare, spare, spare)                                                                                                                                                                          |
| 7   | `aAnim`      | vec4 | (speedRaw, reverseSign, seed, intensityRaw) — animated buckets ONLY                                                                                                                                      |
| 8   | `aWind`      | vec4 | (origin.x, origin.y, windExposure, windResponse) — wind buckets ONLY; wind centre IS the light origin (`point-light-pool.js:389`)                                                                        |

Coloration bucket: `position`, `aLocalUnit`, `aParams` = (attenuationEased, colorationAlpha,
expectedDepth, spare), `aLightColor` = (rgb, spare), `aAnim`, `aWind` — 6 buffers max.

**The fully-loaded illumination bucket sits EXACTLY at the 8-vertex-buffer pipeline limit**
(memory: `keyhole-vertex-buffer-limit-fix`). Adding ANY new per-light field requires re-running
this arithmetic first — the spares in `aColorC`/`aParams` are the first landing spots; an
interleaved-buffer investigation is the second; a petition is the third. S2.3's lab scenario
includes a fully-loaded-layout compile+draw check so the limit is proven, not assumed.

### §3.4 Bucket lifecycle

- **Build/grow:** per-bucket typed arrays sized to current membership with doubling headroom;
  per-light span registry (`sourceId → {bucketKey, vertexStart, vertexCount}`). Growth or
  membership change (add/remove/key change — including darkness-window activation flips, which
  the census says are NORMAL here, 37/50 lights) rebuilds that bucket's arrays: one allocation
  event, amortized, never per-frame.
- **Per-frame value writes:** the reconcile computes each light's CPU values exactly as today
  (ambient triple, eased attenuation, exposure, expectedDepth, …) then **compares before
  writing** into the span (value-diff dirty-skip). Any write → that attribute's
  `needsUpdate = true` (whole-buffer reupload is fine at this size: ~68 lights × ~33 verts ×
  ≤27 floats ≈ 250 KB worst case; `addUpdateRange` is a measured-need optimization, not v1).
  **Steady state — nothing changed — writes ZERO bytes**: animation jitter is GPU-side
  (`uGlobalTimeMs` + per-light seeds), so a static scene's buckets go fully quiet. This is the
  Testament's "unchanged lights upload zero bytes" bullet, made concrete.
- **Movement/reshape:** gated by the EXISTING per-light shape dirty-check
  (`lastShapeX/Y/Radius/Points`, `point-light-pool.js:587-599`); on change, re-triangulate into
  the span (positions + `aLocalUnit`), same `triangulateLightFan` output as today. A span that
  shrinks pads with degenerate (repeated-point) triangles; compaction rides the next rebuild.
- **Draw:** `geometry.setDrawRange(0, activeVertexCount)` per bucket; buckets live in the same
  `lightScene`/`colorationScene` alongside the per-light (aperture) meshes — MAX blending is
  order-independent (proven, bench scenario 2), so coexistence is free.

### §3.5 What stays per-light forever (v1)

Aperture-lit lights; anything failing bucket admission (unknown falloff string, etc. — admission
is a closed-list check, `feedback_category_string_must_be_in_closed_list`); and the per-light
CODE PATH itself, which is both the aperture path and the safety slide (flag OFF = today's
renderer, byte-identical). Nothing is deleted in Stage 2.

### §3.6 CLOSED — animation seed builders reading `positionLocal` directly

**Found 2026-08-11, S2.3, confirmed by an isolated per-quality-tier A/B; FIXED the same day, on
the author's explicit instruction not to half-do it.** S2.1's core split parameterizes
`positionLocal.xy` as `inputs.localUnitXY` for the CORE's own use (`dist`, falloff,
switchColor) — but did not, by itself, reach the animation SEED BUILDERS the core calls out to,
several of which read the TSL global `positionLocal` directly, bypassing the injected value.
`animations/candle-flicker.js#candleShape` (called only at `animationQuality >= 2` — production's
actual value for the real Mansion's candles) was the confirmed case; a full audit
(`grep -rn positionLocal src/effects/lighting/animations`) found the SAME pattern in 18 more
files — effectively every angular/UV-space animation in the registry.

**The fix, applied to all 19 files:** `buildIlluminationShadingCore`/`buildColorationShadingCore`
now pass `localPosition: localXY` into every `animation.buildIlluminationSeed`/
`buildColorationSeed` call (`point-light-illumination.js`/`point-light-coloration.js`). Every
affected seed builder (and the internal helpers some of them share — `candleShape`,
`sunburstPattern`, `bwave`, `smokefading`) now accepts `localPosition` as an explicit parameter
and reads THAT instead of `positionLocal` — for the existing per-light path, `localPosition` IS
`positionLocal.xy` (the exact same node, injected through unchanged), so this is provably
behaviour-preserving there; for the batched path, it is now the correct local-space value instead
of the world-baked one.

**Verified:** `bench-point-lights.js` scenario 4's `batched-byte-identical-to-uniform-twins`
(the real `animationQuality:2` case) now passes at `maxChannelDelta:0` — 7/7 checks green, up
from 6/7. `npm run verify` green (21 suites, 8373 passed). A live-Foundry capture (real candles,
quality 2) confirms the per-light path is unaffected. Only `candle-flicker.js` was confirmed
BROKEN before the fix (the other 18 were fixed alongside it on the strength of the identical
pattern, not independently reproduced-broken first — see V4-Testament.md's S2.3 entry for the
full account and what that does and doesn't prove).

---

## §4 Parity strategy

Parity is STRUCTURAL, not aspirational: one shading core means the batched material cannot
"forget" a term. The input path — uniform read vs attribute-varying read of the same float32 —
is proven bit-exact on-device (`batched-byte-identical-to-uniform-twins`, `maxChannelDelta:0`,
including the real `animationQuality:2` candle case since §3.6's fix). §3.6 has the full account
of the one gap this surfaced (animation seed builders reaching for `positionLocal` directly,
bypassing the core's injected local-position value) and its fix — a separate concern from the
core's own parity, now closed, not a residual risk.

**The pixel gate stays `exact`** (Testament S2.7). The ONLY lawful relaxation, should constant-
attribute interpolation wobble by 1 ulp on this hardware: max per-channel delta ≤ 1/255 with
zero pixels at ≥ 2/255 — and invoking it requires the failing-check evidence attached AND the
author's explicit sign-off, recorded in the Testament. Do not reach for it pre-emptively.

---

## §5 The reconcile half (`pointLightUpdate` 2.710 → ≤ 1 ms)

Instrument BEFORE optimizing (`feedback_aggregate_cannot_name_the_source`): S2.6 sub-zones the
reconcile into source-read / candle-build / aperture-scan / ambient / writes. Prime suspects,
in suspected order (to be convicted or cleared by the zones, not assumed):

1. **`buildCandleLightSources` over 207 anchors, every frame** — clustering runs at frame
   cadence for content that changes at author-edit cadence. If convicted: cache clustered
   output keyed on (anchor set identity, perfTier, params), invalidate via the anchor
   authority's own change signal.
2. **~30 uniform `.value` object writes × 68 lights** — becomes compare-and-maybe-memcpy into
   bucket arrays (§3.4) for batched lights automatically.
3. **Per-light region-ambient recompute** — already fast-pathed when no regions are active
   (`point-light-pool.js:1153-1166`); measure before touching further.

⚠️ `src/diag/` currently carries the author's own uncommitted edits (frame-profiler.js,
perf-session.js + test). S2.6's executor must coordinate before modifying instrumentation files
— check `git status` first; if they're still dirty, petition rather than colliding.

---

## §6 The other accumulate draws

- **Region darkness (8 draws → 1, S2.8):** same merged-mesh technique, far simpler (one shared
  material, simple polygons, no animation buckets). In scope.
- **Window light (4 draws, 0.161 GPU / 0.184 CPU ms):** folding it into the batch means
  entangling a separate per-floor subsystem for ~0.15 ms of CPU. **Deferred by decision** —
  recorded here with its numbers so the deferral is auditable. Revisit only if S2.9's capture
  shows the pass still over gate with these draws as the remainder.
- Composite/illum/candle-flame draws (4): untouched — they are already one-ish draw each.

---

## §7 Lab proof spec (S2.3 — scenario 4 of `bench-point-lights.js`) — DONE, 7/7 green

- `packed-batch-renders-one-draw` ✅ — fully-loaded layout (anim + wind, 8 buffers), N lights, 1
  real `drawCalls`.
- `fully-loaded-layout-fits-vertex-buffer-limit` ✅ — the §3.3 arithmetic proven by compile+draw,
  not arithmetic alone.
- `batched-byte-identical-to-uniform-twins` ✅ — production's actual `animationQuality:2`,
  `maxChannelDelta:0`. Failed once (§3.6's gap), then fixed the same session — not silently
  worked around by testing a lower quality tier.
- `batched-byte-identical-to-uniform-twins-below-quality-2` ✅ — the SAME comparison at
  `animationQuality:1`: byte-identical, ISOLATED §3.6's gap to `candleShape` before the fix (now
  redundant with the check above but kept as a narrower regression check).
- `span-position-rewrite-moves-a-light` ✅ — movement via span rewrite (the mechanism of record,
  replacing `uniformArray`); old footprint empty, new footprint correct. (This check, and the
  third scenario's sibling, were both false-failing earlier the same day on a Y-flip bug in this
  bench's own `sampleColor` — fixed; see V4-Testament.md P-005. Not a mechanism defect, never
  was.)
- `span-value-rewrite-touches-one-light-only` ✅ — rewrite one light's `aParams`/colour span;
  every other light byte-stable.
- `steady-state-renders-byte-stable-with-zero-writes` ✅ — two renders, no writes between:
  byte-identical frames.

---

## §8 Rollout

`pointLightBatching` flag, default OFF, in the same registry every other effect flag uses (and
— grep `EFFECT_REAPPLIERS` in boot.js after registering ANYTHING,
`feedback_hand_maintained_dispatch_lists_forgets_new_effects`). Order: S2.1 lands and gates
alone (byte-identical, flag-irrelevant) → S2.2-S2.5 behind the flag → S2.7 pixel gate ON-vs-OFF
exact → author LIVE verdict → default ON (`feedback_default_on_new_features`). Kill switch is
the flag; the per-light path remains in the codebase regardless (§3.5).

---

## §9 Explicitly out of scope for Stage 2

Root-causing the vendored backend's uniformArray defect (pinned, banned, moved past); any
re-enable of `edgeSoftFactor`/`uShadows`; the runtime-branch uber-shader (forbidden by
`tsl/no-uniform-gates`); window-light folding (deferred with numbers, §6); RenderBundles and
render-loop CPU work outside the light pass (Stage 4's mandate, not this one).
