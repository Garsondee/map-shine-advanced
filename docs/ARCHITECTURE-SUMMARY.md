# Map Shine Advanced — Architecture Summary (V3 / Keyhole)

> ## ⚠️ CONCISENESS MANDATE — read before editing this file
>
> **This summary is kept short ON PURPOSE.** The V2 architecture summary grew to ~1,500 lines and went stale the moment the code moved (it now lives at `docs/archive/ARCHITECTURE-SUMMARY-v2.md`). The failure mode was **duplication**: it restated details that live in code, so every code change silently falsified it.
>
> **This file is a MAP, not a MIRROR.** It names _where the truth lives_ and states only what changes slowly (the laws, the zones, the division of labour). If you find yourself copying a pass list, a param, a file's internals, or a line count into this file — **stop.** Link to the authoritative source instead. The authority table (§7) is the point of the document.
>
> Rule of thumb: if a sentence here would be wrong after a normal code change, it does not belong here.

**Module:** `map-shine-advanced` · **Foundry:** v14 · **Renderer:** Three.js WebGPU (`WebGPURenderer` + `NodeMaterial` + TSL; GLSL deleted) · **Plan of record:** `docs/planning/Keyhole.md`

---

## 1. What MSA V3 is, in one breath

A per-scene cinematic renderer that **replaces Foundry's PIXI scene art** with a WebGPU/TSL pipeline built on a **fixed-size virtual-texture page cache** — nothing is ever allocated at world resolution. Foundry keeps documents, simulation, input, and vision; MSA draws the picture and mirrors Foundry's camera. It is **scene opt-in** (`flags['map-shine-advanced'].enabled`); a scene without the flag is stock Foundry, untouched.

Why it exists and why V2 was abandoned: `Keyhole.md` (the plan) and `v2-postmortem-the-failure-modes` (memory, the autopsy). **Read those two before any architectural decision.**

## 2. The load-bearing laws (each enforced by an artifact, not by memory)

| Law                                                                                        | Enforced by                                                                                  |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Nothing is allocated at world resolution; the VT page cache is the only large texture path | `src/graph/three-allocator.js` (throws >2048px); `src/vt/`                                   |
| One flat sort law for every drawable: `elevation → sortLayer → sort → zIndex`              | `src/scene/layer-order.js` (parity-fuzzed vs. Foundry's own comparator)                      |
| Foundry owns ALL input; MSA mirrors `canvas.stage`, `pointer-events:none`                  | `Keyhole.md` §4.7 (LOCKED); `keyhole-input-model-decision`                                   |
| MSA owns `primary`+`effects` (art); PIXI keeps `interface`+`visibility` (chrome, fog)      | `src/foundry/canvas-compositing.js`; `keyhole-interface-seam`                                |
| One source of truth for authored + derived masks                                           | `src/scene/mask-authority.js`; `keyhole-mask-authority`                                      |
| The bad path fails a build; the good path is the fast path                                 | `tools/verify-structure.mjs` + `tools/reachability.mjs` (in `npm run verify`); `Skeleton.md` |
| Safety slide: renderer failure hands rendering back to Foundry, loudly                     | `src/diag/render-fallback.js`; `feedback_safety_slide_outranks_doctrine`                     |

## 3. Zones — one public door each (`index.js`)

Cross-zone imports go through `index.js` only (ESLint `import/no-restricted-paths`). Each door opens with a covenant header stating what the zone owns and which doc governs it — **read the header, not this table**, for detail.

`src/vt/` virtual-texture cache · `src/graph/` frame graph + the only renderer-state owner · `src/scene/` sort law, masks, occlusion, world quad · `src/foundry/` the Foundry adapter (the ONLY place `canvas.`/`game.`/`Hooks.` may appear) · `src/world/` env/sun/time snapshot · `src/effects/` effect contracts (Stage 6) · `src/ui/` loading · `src/diag/` instruments (the only place clocks + GPU readbacks are allowed) · `src/boot.js` the composition root.

## 4. The frame is a validated pass graph — `src/graph/passes.js` is the authority

The render is a declared DAG of passes (status `live`/`seam`/`future`), run in array order by `src/graph/run-frame.js`. **Do not enumerate the passes here** — `passes.js` is machine-validated (`validatePassGraph`) and its own health is derived, not modelled (`src/graph/pass-health.js`; `Health.md`). To see the live frame, read `passes.js` or the `framePlan` diagnostics report. This is deliberately the one place the pipeline is written down.

## 5. Division of labour with Foundry

- **Foundry owns:** documents, game logic, input/hit-testing, camera authority (`canvas.stage`), vision & fog (PIXI `visibility` group), all UI/HUD/sidebar, the interface-group chrome of every placeable.
- **MSA owns:** the scene art (`primary`+`effects`) — backgrounds, foreground/roof art, tiles, token sprites — rendered from documents, ordered by §2's sort law, lit/graded by the pass graph.
- **The seam is Foundry's own group split**, so the two draw **disjoint sets**: no shared picture, no sync code. If you write code to make MSA and PIXI agree about a pixel, you are re-growing V2's `frame-coordinator.js` — stop.

## 6. Reliability — the safety slide

`WebGPU → WebGL2 → native Foundry PIXI`. A renderer failure must never cost the session: `engageFoundryFallback` removes MSA's canvas and announces the switch unmissably (`renderMode` in every diagnostics report). The last rung is **built and has fired live**; the auto-detect ladder above it is **deferred** (`Keyhole.md` §4.3). Parity, UX, and cross-module compatibility get their own governing doc: **`docs/planning/Parity-and-Compatibility.md`**.

## 7. Where the truth actually lives (use this instead of restating it here)

| You want…                                                                                | Authority (never duplicated into this file)                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The build plan + current stage/status                                                    | `docs/planning/Keyhole.md` + `keyhole-stage-status` (memory)                      |
| Why V2 failed / what not to repeat                                                       | `v2-postmortem-the-failure-modes` (memory) + `docs/planning/Engine-Postmortem.md` |
| The enforcement doctrine (walls)                                                         | `docs/planning/Skeleton.md` + `tools/verify-structure.mjs`                        |
| The live render pipeline                                                                 | `src/graph/passes.js`                                                             |
| Parity / UX-regressions / module cross-compat                                            | `docs/planning/Parity-and-Compatibility.md`                                       |
| A subsystem's design (effects, water, particles, light, environment, params, UI, health) | `docs/planning/*.md` (one doc per subsystem)                                      |
| What a V2 effect did (for a Stage-6 rebuild)                                             | `docs/reference/v2-effect-params/`                                                |
| Foundry v14 behaviour (schema, layering, lighting)                                       | `docs/reference/` + the vendored source at `foundryvttsourcecode_v14/`            |
| The V2 architecture (historical)                                                         | `docs/archive/ARCHITECTURE-SUMMARY-v2.md`                                         |

## 8. Status (pointer, not a snapshot)

Basic Foundry↔three.js parity is reached and author-confirmed (2026-07-19). Effects (Stage 6) and the cross-compatibility bridges are not yet built. **For anything more specific than that sentence, read `keyhole-stage-status` (memory) — this file does not track status, on purpose (see the mandate).**
