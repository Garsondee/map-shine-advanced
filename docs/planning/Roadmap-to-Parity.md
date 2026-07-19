# ROADMAP TO PARITY — from basic parity to V2's full look, on the clean architecture

**Status:** LIVING ROADMAP, authored 2026-07-19. The north star: **reach roughly the visual feature set V2 had before it was abandoned** — the cinematic look that made the module worth rebuilding — on Keyhole's architecture, tiered, and without re-growing V2's machinery.
**Audience:** the author, and any session picking "what's next." Read `Keyhole.md` (the plan) and `src/graph/passes.js` (the live authority on the pipeline) first.
**The authority is `passes.js`, not this file.** Every pass below is declared there with a machine-checked `status` (`live`/`seam`/`future`) and an `absorbs` list (the exact V2 classes it replaces). This document is the *narrative and the sequence* over that data — when the two disagree, `passes.js` wins and this file is stale.

---

## 0. THE REFRAME — "where V2 was" is far less code than 376k lines

Before any list: **most of V2 is not a parity target, and saying so is the single most important thing in this roadmap.** V2 was ~376,000 lines. A large fraction of it was *machinery the Keyhole decisions deleted outright* — not features to rebuild, but problems that no longer exist:

| V2 subsystem | Lines (approx) | Why it is NOT a parity target |
|---|---|---|
| `token-movement-manager.js` — the **sync/echo-defence machinery** (33 echo-flags, 104 "sync" mentions) | ~12,771 | The *machinery* is not a target — render position derives from the document as `f(doc, time)`, one authority, no echo-defence. **BUT its embedded navmesh/pathfinding engine + walk-style registry ARE product** (the postmortem flags them so) — they graduate to a real target: see **Animation & movement** in §2. |
| `interaction-manager.js` (selection/drag/delete) | 8,955 | Foundry hit-tests. The interface seam keeps all interaction chrome in PIXI (`keyhole-interface-seam`). |
| `pixi-content-layer-bridge.js` (compositing PIXI world into Three) | 4,574 | Drawings, templates, notes, sounds stay in PIXI's `interface` group, drawn on top. Nothing to composite. |
| `frame-coordinator` + `render-loop` + `frame-state` (two-renderer sync) | 1,838 | Two renderers drawing **disjoint sets** — no shared picture, no sync code (`Engine-Postmortem.md` §1). |
| `GpuSceneMaskCompositor` + streaming stack (world-res mask baking) | ~10,000 | **Superseded, not ported** — `vt.residency` does this better (`vtSample()`), and already runs. |
| Fog of war / vision | — | Stays Foundry's **by design** (`keyhole-vision-fog-direction`). Taking it is a deliberate *later* step, never part of "parity." |

**So the parity target is V2's *look* — the effects, lighting, shadows, water, weather, particles, and post — rebuilt as ~13 declared passes, tiered.** That is the 48→13 collapse already recorded in `passes.js`'s `absorbs` totals. The machinery that made V2 unmaintainable is exactly the machinery we are not rebuilding.

---

## 1. WHERE WE ARE (2026-07-19)

Author's live assessment: **"lighting and rendering of albedo is ~90% similar to Foundry, close enough that most users wouldn't complain about a significant difference. Performance seems very good so far."** Against `passes.js`, that means **5 of 13 passes are live**:

| Live pass | What it delivers today |
|---|---|
| `vt.residency` | The virtual-texture engine — streamed pages, BC1/BC7 compression, the whole "nothing at world resolution" law. Better than V2's streaming. |
| `geometry.world` | The unified world draw — level art, foreground/roof, tiles, tokens, one flat sort law. Live, author-confirmed on real multi-floor non-square scenes. |
| `masks.occlusion` | Radial (token-disc) occlusion. **SURFACE channel — the roof-fades-over-token case — is not yet built** (needs Foundry's Region/Surfaces system). |
| `light.accumulate` | Ambient/exterior + point lights + coloration + global illumination + region-driven darkness. **The ~90%.** More rungs pending (see §2). |
| `present.composite` | Tonemap, present, and the safety-slide boundary. |

Plus the spine that makes the rest cheap to add: the **pass runner** (`graph/run-frame.js`), the **params contract** (`core/params-schema.js`), the **mask authority**, the **safety slide's last rung**, and the **flight recorder / pixel probe** instruments — all built.

**The gap is 7 seams + 1 future pass**, listed next.

---

## 2. THE PARITY BACKLOG — flip the seams to live

This is the roadmap proper: each remaining pass, in **dependency order** (a pass may only read resources an earlier pass creates — `passes.js` enforces this). Each row names the visible win, the doc that owns the design, and the gate.

| # | Pass / work | Status | The visible win | Owning doc | Depends on |
|---|---|---|---|---|---|
| 1 | **`frame.snapshot`** — wire the env snapshot into the frame | `future` (pure core built) | The call sheet every later pass reads: time, sun, weather, wind, darkness — ONE source. Unblocks weather, particles, grade, shadows. | `Environment.md` | — (pure core done) |
| 2 | **`buf:scene.attr`** — complete the attribute buffer (B0-1) | partial | Per-pixel floorId/outdoors/coverage as cheap screen-space reads. Turns shadows/water/particles/grade from RT-stacks into one texture read. | `v3/B0-1-floor-attribute-buffer.md` | geometry.world |
| 3 | **`light.visibility`** — the shadow pass | `seam` | **Shadows.** Sun visibility = authored `_Shadow` ∧ building ∧ sky-reach ∧ cloud, min-combined. Dynamic lights already have Foundry wall-clipped LOS. Shadow = *absence of a specific light*, no lift, no combined-shadow. | `Light-and-Shadow.md` | frame.snapshot, scene.attr |
| 4 | **`light.accumulate` remaining rungs** | `live` (partial) | The last ~10% of lighting parity: the other coloration techniques, contrast/saturation/shadow adjustments, darkness sources, light animations, elevation occlusion. | `Light-Parity.md` §5 | light.visibility |
| 5 | **`surface.response`** — material shine | `seam` | Specular, iridescence, prism, wetness — one material term reading the packed specular VT × illum × weather. Five V2 classes, one tiered node. | `Effects-API.md` §5, `Effects.md` | light.accumulate, scene.attr |
| 6 | **`surface.water`** — water | `seam` | Water, tier 0 (blue in the right place, cross-floor correct) → refraction at the top. **Named "first Stage 6 port."** | `Water.md` | scene.attr, (sims.fluids for top rungs) |
| 7 | **`sims.particles` + `surface.particles`** — the one particle engine | `seam` ×2 | Rain, snow, ash, fire glow, dust, flies, splashes — TSL compute, one engine, a weather type is DATA, coverage/zoom-gated. Sim half + draw half. | `Particles.md` | frame.snapshot, scene.attr |
| 8 | **`sims.fluids`** — sim grids (top rungs only) | `seam` | Water flow and fire simulation at the top of their ladders (tier 0 needs no sim). | `Water.md` §5 | frame.snapshot |
| 9 | **`post.grade`** — the grade stack + finishers | `seam` | The whole post chain in ONE fixed order: base → ToD → weather → context gate → trim, then bloom, atmospheric fog, distortion, lens, stylizers (ascii/halftone/sepia/…). Four V2 colorists become one labeled node chain. | `Environment.md` §2.3 | scene.color, scene.attr, scene.depth, env |
| 10 | **`masks.occlusion` SURFACE channel** — roof fades over token | `live` (radial only) | The headline "see the token under the roof" case. Needs Foundry's separate Region/Surfaces system (`Scene#getSurfaces`, `polygonTree`). | `Keyhole.md` (occlusion) | Region/Surfaces adapter |

### Cross-cutting work (not a single pass, but parity needs it)

| Work | The win | Owning doc | Note |
|---|---|---|---|
| **The effects config UI** (front of house / rear of house) | The authoring surface for *every* effect above. Without it, effects are tuned by editing code. | **`Effects-UI.md`** (new) | A prerequisite for productively building 5–9; see that doc for the plan. |
| **External-effect bridges** (Dice So Nice, Sequencer/JB2A) | Ecosystem parity — spell video in the scene, dice graded by the scene. | `Parity-and-Compatibility.md` §4 | V2-proven, V3-unbuilt. Stage 6. |
| **The three-tier settings** (Map-Maker / GM / Player) | The distribution model V2 had — baselines ship with the map; GMs tweak; players cap their own perf. | `Params.md` §3.4 + `Effects-UI.md` | Rides the params service; persistence-as-diff already built. |
| **Per-pass GPU timing** (WebGPU timestamps) | "Effect X is slow" becomes a measured claim, not a mood. | `Keyhole.md` menu item 6 | Rides the pass runner. |
| **The tiered ladder** (WebGPU → WebGL2 auto-detect) | The reliability half — the rung above the safety slide's last rung. | `Keyhole.md` §4.3 | Mostly boot wiring; TSL already compiles both backends. |
| **Animation & movement** ⭐ | Token move animation (render pos = `f(document, time)`), pathfinding / click-to-move, walk-styles, tile motion, doors — the quality-of-life layer V2 had. **Harvest the navmesh/pathfinding engine + walk-style registry** from `legacy/scene/token-movement-manager.js` (genuine product buried in the machinery). | (own doc when picked up) | geometry.world (live); the floor system; the input model — MSA renders the animation, Foundry stays the movement authority |

### ⭐ The wishlist north-star: cross-floor 3D movement

Author's vision (2026-07-19), recorded because it is an excellent one: **select a token on a lower floor, cycle up through floors with no loading screens and snappy response, right-click a grid space on an upper floor, and watch the token walk there — across floors, in 3D.** Today moving a token between floors is clumsy; this would be a standout feature no other VTT renderer offers.

Why it fits the architecture instead of fighting it:
- **"No loading screens, snappy floor switching" is already most of the way built.** The VT page cache + BC compression + adjacent-floor prewarm (`Keyhole.md` compression section) exist precisely so floors stay resident and switching is instant. The wishlist cashes in that investment.
- **Cross-floor pathfinding** extends a single-floor navmesh to a multi-floor graph — and V2 already had `MultiFloorGraph` + `PortalDetector` (stairs/elevators) to harvest. The path is computed CPU-side, written to the token document (the one authority), and MSA renders the token animating along it.
- **The principle that keeps it clean:** MSA never becomes a second source of truth for the token's position — that was V2's 12k-line mistake. It computes a path and writes waypoints to the document; Foundry authorises; MSA renders the walk as `f(document + movement state, time)`. One authority, no echo-defence.

**Wishlist, not scheduled** — but it earns the top of the animation line because it is exactly the kind of thing MSA's architecture makes newly possible.

---

## 3. THE SUGGESTED SEQUENCE

Not a rigid schedule — a dependency-respecting order that lands **visible wins early** and never operates on an unmeasured engine.

1. **`frame.snapshot` + `buf:scene.attr`** (the spine). Almost everything downstream reads them. Low visible payoff alone, but every later item is cheaper once they exist. Pair with the **stage-gate baseline** run first (`Keyhole.md` menu item 5) — never operate on an unmeasured engine.
2. **`light.visibility`** → then **`light.accumulate`'s remaining rungs**. This closes the lighting/shadow story from ~90% to parity — the most-noticed visual gap, and the subsystem V2 fought hardest (`Light-and-Shadow.md`).
3. **The config UI** (`Effects-UI.md`). Do this *before* the effect-family ports (5–9), because it is the surface you tune them through. Building water or particles without it means hand-editing constants — exactly the friction that loses.
4. **`surface.response`** → **`surface.water`** → **particles** → **`sims.fluids`**. The material and environmental families, tier 0 first each time (correctness never rides the ladder).
5. **`post.grade`** — the finisher that makes everything above read as one graded image.
6. **`masks.occlusion` SURFACE**, external-effect bridges, the tiered ladder — the remaining parity items, slotted as their prerequisites land.

**Every step ships its tier 0 first** (`Effects.md`): a rough-but-correct rung that a weak machine can run, before the expensive rungs. Parity is reached at tier 0 across all families; the ceiling is reached by climbing each ladder.

---

## 4. HOW WE KNOW WE'RE THERE — the parity gate

"Roughly where V2 was" is measurable, not a vibe:

1. **Every pass in `passes.js` is `live`**, honestly (a `live` pass runs every frame against real data — not a stub that returns early).
2. **The acceptance scene set** (Church, Mansion, the torture fixture, a non-square multi-floor scene) renders every effect family at tier 0+, side-by-side comparable to V2's output.
3. **The `stage-gate-baseline` gates hold** on all of them (`Keyhole.md` §8): load ≤10 s, PIXI residency ≤60 MB, no device loss, healthy frame percentiles.
4. **The parity contract passes** (`Parity-and-Compatibility.md` §6, benchline B1–B10) — because a prettier scene that broke interaction is not parity.
5. **No re-grown machinery** — no god-object, no `window.MapShine` bus, no sync code, no world-res allocation. The walls in `tools/verify-structure.mjs` stay green. Reaching V2's *look* without V2's *shape* is the whole point.

---

*V2's look is the target; V2's machinery is not. Thirteen declared passes, tier 0 first, each flipping from a throwing seam to a live node — that is the whole distance from here to there.*
