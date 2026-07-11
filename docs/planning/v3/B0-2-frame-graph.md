# B0-2 — The V3 Frame Graph and Pass List

**Status:** DRAFT for author review (B0, no code). Written 2026-07-10; V2 pass inventory verified against `FloorCompositor.js` that day (line numbers will drift).
**Parent:** [Forward+.md](../Forward+.md) §14.4 (proposal), §12.2 (verified V2 phase map), §14.2 (end-state frame).
**Decides:** the minimal frame-graph API and the named V3 pass list every §12.2 phase maps onto.

---

## 1. Why a graph (one paragraph, then mechanics)

`FloorCompositor.js` is ~10k lines because pass ordering, RT lifetimes, ping-pong selection (`_pickOtherPost`), scissor/clear-state management, and effect wiring are all implicit in one imperative method — e.g. the stylization chain's own comment warns that picking the wrong ping-pong anchor causes a WebGL feedback loop → black frame ([FloorCompositor.js:1793–1798](../../../scripts/compositor-v2/FloorCompositor.js)). A declarative graph makes those bugs structurally impossible, gives per-pass timings to the §13 diagnostics for free, and produces the immutable-pipeline shape a WebGPU port wants (§8).

## 2. The API — deliberately small (~200 lines, not an engine)

```js
// A pass is a plain object. No classes, no lifecycle, no magic.
graph.addPass({
  name: 'lighting.clustered',           // unique; becomes the timing + diagnostics key
  reads:  ['albedo.color', 'attr', 'shadow.combined'],   // logical resource names
  writes: ['scene.hdr'],                // logical names; graph maps to physical RTs
  when: () => lightingEnabled,          // optional gate, evaluated per frame
  execute(ctx) {                        // ctx: { renderer, camera, get(name) → texture/RT, target(name) → RT }
    …
  },
});
const result = graph.execute(frameCtx); // topo-sort → allocate → run → timings
```

Rules the implementation must keep:
1. **Logical resources, physical pool.** A `writes` entry declares `{ size: 'screen' | [w,h], format, type, mrtCount? }` once, at registration. The scheduler allocates from a transient pool and **aliases** physical RTs whose logical lifetimes don't overlap — this replaces `postA/postB` ping-pong guesswork with computed correctness, and is where the RT-memory win comes from.
2. **Execution order is derived** (topological, stable-sorted by registration order for ties), never authored. A cycle or a read-before-write is a **loud registration-time error** (§14.1 principle 4 — no silent fallbacks).
3. **Every pass is timed** (CPU wall-clock always; `EXT_disjoint_timer_query_webgl2` GPU timings when available) into the same structure `_recordPassTiming` feeds today, so crash/perf reports name passes with zero extra work (§14.1 principle 6).
4. **External resources** (mask-compositor products, sim state, Foundry-owned textures) enter as `imports` — read-only names registered per frame. The graph never owns them and never disposes them.
5. **No retained state inside passes.** Effects keep their objects (materials, sims); the pass closure binds them. The graph owns only RTs it allocated.

Non-goals (rejected complexity): multi-queue scheduling, automatic pass splitting/merging, resource versioning across frames, render-bundle abstraction. If a need appears, it is a design change, not a feature toggle.

## 3. The V3 pass list — every §12.2 phase, named

Verified V2 sites in parentheses. **Bold** passes are new machinery; the rest wrap existing code.

### Imports (not passes)
Sim textures (P0 `update()` products — fire/water/weather sims stay untouched, Forward+ §14.2), mask-compositor bundles (outdoors low-res per floor, authored masks), vision/fog RTs from `FogOfWarEffectV2`, Foundry document state.

### Producers (screen-sized only — §14.1 principle 1)
| V3 pass | Wraps (V2 site) | Notes |
|---|---|---|
| `shadow.overhead` | `OverheadShadowsEffectV2.render` (:5417) + ceiling transmittance (:5428) | Producer P1 stays; *application* moves to the unified shader (B3) |
| `shadow.structural` | building + skyReach + painted producers (:5446–5459, incl. lightning re-render loop) | Same |
| `light.prepass` | `renderLightOverrideMasks` (:5403), `ShadowDriverState` publish (:5410) | Feeds cluster build |
| **`light.clusterBuild`** | *new* (CPU) | Screen-tile light bins → DataTexture/UBO (Phase 4 proper; B2) |
| `masks.screenOnce` | specular/iridescence/prism renders (:5317–5319) | Already once-per-frame; unchanged wiring, now declared |
| `cloud.render` | cloud producer | Unchanged |

### The unified pass (B1 core)
| V3 pass | Content |
|---|---|
| **`unified.geometry`** | ONE geometry pass over the already-Z-unified bus scene (Forward+ §12.1): all floors at real Z, hardware depth, alphaTest holes. MRT: `scene.hdr` + `attr` (B0-1). From B2 it also runs the clustered forward light loop per fragment; from B3, shadow application terms; B4 folds fire glow onto the shared primitive. |
| **`unified.transparents`** | Class B set drawn after opaques, `depthTest:true / depthWrite:false`, painter's-order within floor bands (B0-3). Zero-writes `attr` (B0-1 §3.1). |

### The Class D exception (kept explicitly — Forward+ §4.2/§12.3)
| V3 pass | Wraps |
|---|---|
| `water.seeThrough` | Post-merge water path: `setPostMergeWaterContext`, `_resolvePostMergeWaterOccluderRT`, bg-alpha-mask build, `WaterEffectV2.render` (:9454–9573). Unchanged through B1–B4; replaced by water-as-geometry at B5, at which point this pass shrinks to splash gating. |

### Post chain (once, on the single composite)
| V3 pass | Wraps (V2 site) |
|---|---|
| `post.fog` | AtmosphericFog (:9613) — reads `attr.g` instead of stacked outdoors (B2+) |
| `post.bloom` | Bloom (:9629) |
| `overlay.splashes` | splash composite, layer 33 (:9653) — stays a separate composite until B4 |
| `overlay.vegetation` | bush/tree composite, layer 32 (:9673) — same |
| `post.colorCorrection` | CC (:9718) — the HDR→LDR boundary; reads `attr.g` for outdoors, keeps light-buffer bindings until B2 retires them |
| `post.stylization` | `_runPostMergeStylizationPasses` chain (:1793): Filter→Sharpen→DotScreen→Halftone→Ascii→…, each becoming a gated pass so the feedback-loop hazard disappears |
| `post.fogOfWar`, `post.floorDepthBlur`, presentation/upscale | The late chain that today runs after `render()` returns (`mergedFinalRT` → "late pass chain", :9819) — imported into the graph last, unchanged behavior |

### What has no V3 pass (retired by design)
Per-level `{sceneRT, postA, postB}` pool + prepass loop (:9112–9140), per-level lighting/window-light/fire-glow/shadow-lit applications (:9178–9263), per-level water (:9271), alpha-rebind pass (:9352 — its *invariant* moves into `attr.a`, B0-1 §2.1), `LevelCompositePass` (:9433), stacked lit snapshots (:9164/9391), stacked light buffer (:9154/9257), stacked outdoors build (:9605). These retire **at B7**, after parity — not before.

## 4. Migration mechanics

- **Flag:** `MapShine.__v3Pipeline` (world setting + URL override), default off. V2 path untouched while off — §14.1 principle 7 (shippable at every step).
- **B1 scope:** graph + `unified.geometry` (albedo-only, lighting off) + `attr` + debug overlay. Exit: golden-scene *geometry* parity vs V2-with-lighting-off; attribute buffer visualizable.
- **A/B harness:** with the flag on, a debug command renders one frame through V2 and one through V3 and diffs the outputs (per-pixel abs-diff heat map to the diagnostics overlay). This is the per-milestone acceptance instrument for [B0-golden-scene-expectations.md](B0-golden-scene-expectations.md).
- **Diagnostics from day one:** graph registers its pass list + last-frame timings + RT pool stats into the crash-report collector (`collectDiagnostics`) the same session B1 lands.

## 5. Open questions for B1

1. **Where does the graph live relative to `FloorCompositor`?** Recommendation: new `scripts/compositor-v3/` root; V3 orchestrator is a thin file that registers passes and calls `graph.execute` — it must not grow methods. FloorCompositor stays V2-only until B7 deletes it.
2. **Scissor policy.** V2 scissors many passes to the scene rect; the graph should own scissor as a pass property (`scissor: 'sceneRect' | 'full'`) rather than letting executes toggle GL state — audit which V2 passes rely on out-of-rect pixels (the lighting pass deliberately runs unscissored, :9219–9221).
3. **Aliasing safety valve.** First implementation may allocate without aliasing (correctness first), then enable aliasing behind a debug flag with a validation mode that clears aliased RTs to magenta to catch stale-read bugs.
4. **`navigationRenderLite`** (:5316, :9673): the pan-time degraded mode gates several passes today; each V3 pass carries a `when:` — enumerate the lite set explicitly during B1 rather than inheriting scattered booleans.
