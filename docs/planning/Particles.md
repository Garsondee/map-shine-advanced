# PARTICLES — audit of V2's particle systems + the design seed for the unified pass

**Status:** RESEARCH + DESIGN SEED, 2026-07-16. Author: *"Particles are a mess too... from end to end. Since they are such a critical effect they deserve their own pass."* Both claims verified: the mess is end-to-end, and "their own pass" is exactly the right shape for the fix.
**Companions:** `Water.md` (the sibling audit), `Effects.md` (tiers — particles are the C7/C8 rungs), `Effects-API.md` (the contract), `Engine-Postmortem.md`.

---

## 1. The inventory

`legacy/particles/` is **16,117 lines** — and that is only the dedicated directory. Particle-shaped code also lives in `WaterSplashesEffectV2` (3,854 + 1,683 behaviors), `DustEffectV2` (1,443), `AshCloudEffectV2`/`AshDisturbanceEffectV2` (2,614), `CandleFlamesEffectV2` (3,570), fire's embers, and `SmellyFliesEffect` (1,971). Call it **~25k lines of particle systems** module-wide.

| Lines | File | Note |
|---|---|---|
| **11,777** | `WeatherParticles.js` | rain + snow + ash + embers, ONE class |
| 1,971 | `SmellyFliesEffect.js` | swarm behavior |
| 510 / 417 | `RainStreakGeometry.js` / `SnowGeometry.js` | bespoke geometry builders |
| 465 + 287 | `RoofDripGpuSilhouetteReadback.js` + `RoofDripEdgeSampling.js` | drip spawn machinery |
| 126 / 101 / 77 | SmartWind / SmartUpdraft / world-volume-kill behaviors | **product** — the feel |

## 2. 🔴 THE HEADLINE — five particle architectures in one module

| Render model | Where |
|---|---|
| `three.quarks` (vendored library: `BatchedRenderer`, behavior graph) | WeatherParticles |
| `THREE.Points` | 1 file |
| `InstancedMesh` | 3 files |
| **`new THREE.Sprite()` PER PARTICLE** — a scene-graph object *and a draw call* each | **8 files** |
| Per-particle JS-object callbacks (`update(particle, delta, system)`) | 11 files |

**There is no particle engine. There are five.** Every particle-ish effect re-solved emission, lifetime, wind response, culling, pooling, and disposal from scratch — which is *why* splashes, dust, ash, flies, drips and candles each cost a thousand-plus lines. The Sprite-per-particle model in 8 files is the worst of it: N particles = N scene objects = N draw calls, plus scene-graph overhead per flake. This is the same "no contract → everyone builds their own" mechanism as the effects layer (`Effects-API.md` §2), one level down.

**The one good call:** whoever wired weather chose `three.quarks` with `BatchedRenderer` — real batching, a behavior graph (TurbulenceField, CurlNoise, SizeOverLife, Bezier curves). The *instinct* (one engine, batched, behavior-driven) was correct. It just never became mandatory, so five architectures coexist — the optional-structure law again, in miniature.

## 3. 🔴 355 private fields — the most stateful object in the module

`WeatherParticles` carries **355 distinct `this._*` fields** — beating the render loop (50) and even token movement (178). Inside the one class and one mutable namespace live at least four weather systems: **ash (826 mentions), rain (513), snow (210), embers (221)**. Any field can touch any system; every bug hunt walks 11,777 lines. This is the god-object pattern *recursed into a single effect* — FloorCompositor's disease at one level lower, proving the pattern is scale-free unless structurally blocked.

**Keyhole answer:** a weather *type* is **data, not a class** — an emitter config + behavior list + tier ladder consumed by ONE engine. Rain and snow are two configs, not two thousand-line siblings sharing a namespace.

## 4. 🔴 Spawn = CPU pixel scans; drips = brilliant CS on a doomed foundation

- Spawn points come from `getImageData` scans of mask canvases, with the pacing band-aids visible in the comments: *"Cache pixel readbacks... getImageData is expensive and allocates"*, *"Spread CPU tile getImageData work across control ticks."* The band-aid signature: correct fix, wrong layer.
- **Roof drips are genuinely sophisticated CS wrapped around a genuinely broken foundation.** Union-find connected-component labeling over canvas pixels finds roof *edges* correctly. But the screen→world mapping for those edge points is never derived — it is **voted on, at runtime, every extraction cycle** (`_probeBestNdcMode`): four Y-flip/NDC-sign combinations are ray-cast against a handful of sample points and whichever lands the most hits inside a loose (±5%) bounding box wins, uncached. Author-confirmed live (2026-07-16): *"roof drips were both an awesome idea in concept and they never reliably worked."* This is why — a small or thin roof gives too few samples for a stable vote, the loose tolerance lets multiple modes pass simultaneously, and the winner can flip between cycles for the identical roof under the identical camera. It is [[feedback_y_flip_recurring_risk]] taken one step further: not "solved wrong, once," but **never solved, forever re-litigated, by a coin rigged to sometimes land wrong.**
- **Keyhole answer:** spawn extraction is the *canonical* per-page decode-time extractor case (Keyhole §4.1) — same as fire. Edge labeling runs per-page in the worker at decode; drip points accumulate in world-space PAGE coordinates, which are already unambiguous (no screen involved at all, so there is no NDC mode to guess). The screen→world question this file exists to answer is **structurally impossible to need**, because extraction never touches the screen. The GPU is never consulted, and neither is a coin. The *feature* (drips fall from roof edges — delightful) survives; the entire disease dies, not just the stalls.

## 5. The rest of the wiring (familiar diseases, particle edition)

67 `window.MapShine` reaches; 36 empty catches; 73 `Vector/Color` allocations in WeatherParticles (mostly config-time — quarks handles the per-particle hot path, which is partly why weather performed better than the Sprite-per-particle effects); a GPU readback in the spawn path; wind/updraft behaviors reaching for global controller state.

## 6. What is PRODUCT — harvest list

- **The behavior tuning**: turbulence/curl fields, size/color-over-life curves, emission rates per weather type — the *feel* of the author's weather.
- **SmartWindBehavior / SmartUpdraftBehavior / world-volume-kill** — small, composable, and conceptually right (behaviors as pluggable units *is* the modern particle model).
- **The roof-drip concept** (spawn on real roof edges) and the flies' swarm feel.
- The rain-streak/snow geometry ideas (stretched streaks vs tumbling flakes).

## 7. The Keyhole design — ONE engine, weather as data

- **One particle pass family** in the frame graph (`sims` stage): GPU-instanced, batched, camera-facing quads / streak geometry; **never** a scene-graph object per particle.
- **A particle system is a declaration**: `{ emitter, behaviors[], spawnSource, tiers, packs }` — consumed by the one engine. Adding hail is data, not a class.
- **Spawn sources are decode-time extractors** (`vt:` pack + extractor id) — fire points, water splashes, drip edges, dust zones: one mechanism.
- **Tiers per `Effects.md`** — particles are the ladder's C7/C8 rungs *by definition*, so every system is coverage- and zoom-gated (Law 7): rain that is sub-pixel does not simulate. Tier 0 for a particle system is legitimately **absent** (unlike surface effects) — but its *tier-0 stand-in* is the cheap non-particle cue where one exists (wet tint, snow albedo shift) declared by the owning surface effect, so weather never vanishes entirely on weak machines.
- **Inputs are declared reads**: wind field, weather state, time — never reached for.
- **✅ RESOLVED (2026-07-16), was "Stage 6 spike": TSL-NATIVE GPU PARTICLES. `three.quarks` the LIBRARY cannot be used; `three.quarks` the DESIGN is harvested wholesale.**

  **Why quarks cannot be used — verified in source, at HEAD (0.17.1, freshly downloaded), not inferred:** it has `NodeMaterial: 0`, `TSL: 0`, `WebGPU: 0`, `wgsl: 0` — and `ShaderMaterial: 4`, `gl_FragColor: 5`, `onBeforeCompile: 10`. It builds raw-GLSL `ShaderMaterial`s patched via `onBeforeCompile`, **a hook the node renderer never calls** (4 hits in our build: a stub, two comments, a cache key). The exact failure path is in `three.webgpu.js`:
  ```js
  let nodeMaterial = renderer.library.fromMaterial(material);   // ShaderMaterial => not in the registry => null
  if (nodeMaterial === null) {
    error(`NodeBuilder: Material "${material.type}" is not compatible.`);
    nodeMaterial = new NodeMaterial();                          // => blank material
  }
  ```
  **This is NOT a cost of the TSL decision.** Quarks is incompatible with *modern three.js's material system*, which any current three.js path requires. Upstream's own roadmap lists WebGPU support as unchecked/planned. The only way to run quarks would be a second WebGLRenderer — i.e. `Engine-Postmortem.md` §1's ROOT BLUNDER (two renderers), knowingly re-committed. Never.

  **Why TSL is an UPGRADE, not a consolation — verified in our vendored build:** it exports `TSL.compute`, `TSL.storage`, `TSL.instanceIndex`, and **`TSL.instancedArray`** (three.js's purpose-built GPGPU particle helper), plus `StorageInstancedBufferAttribute`, `atomicAdd`, `workgroupBarrier`. **And compute runs on BOTH backends:** `WebGLBackend.compute()` is a real implementation that emulates compute via **transform feedback** (`RASTERIZER_DISCARD` + `beginTransformFeedback(POINTS)` + `drawArraysInstanced` + ping-pong `switchBuffers()`). So ONE TSL source gives GPU-simulated particles on WebGPU *and* WebGL2 — exactly `keyhole-webgpu-tsl-decision`'s promise, and the safety slide is intact.

  | | three.quarks | TSL-native |
  |---|---|---|
  | Simulation | **CPU**, per-particle JS objects | **GPU** compute / transform feedback |
  | Backends under our renderer | **none** (blank material) | WebGPU **and** WebGL2 |
  | Per-particle CPU cost | yes | **zero** |
  | Keyhole doctrine | violates one-source-TSL; needs a 2nd renderer | native |

  Quarks' CPU sim was *also* the disease `Effects.md` and `Engine-Postmortem.md` name: per-particle JS objects (11 files did this). **TSL particles delete V2's actual particle bottleneck**, not just port around it.

  **What IS harvested — the design, which was always the good part:** `quarks.core` is **renderer-agnostic** (verified: `ShaderMaterial: 0`, `gl_FragColor: 0`, `onBeforeCompile: 0`) and its export list *is* the vocabulary to reimplement: emitters (`ConeEmitter`, `GridEmitter`, `DonutEmitter`, `CircleEmitter`, `HemisphereEmitter`, `PointEmitter`), behaviors (`ApplyForce`, `ApplyCollision`, `ColorOverLife`, `SizeOverLife`, `ForceOverLife`, `OrbitOverLife`, `LimitSpeedOverLife`, `ColorBySpeed`, `TurbulenceField`, `CurlNoiseField`), generators (`IntervalValue`, `ConstantValue`, `PiecewiseBezier`, `Bezier`, `ColorRange`, `Gradient`), and `*FromJSON` deserializers — **proving the author's "weather as data" model was already quarks' own model.** Take the vocabulary, the JSON shape, and every tuned curve/rate value from `WeatherParticles`; implement the behaviors as TSL compute functions. `quarks.core` may even be usable as a *reference implementation* to diff against.

## 8. Declaration sketch

```js
export const RAIN = {
  id: 'weather.rain', layer: LAYERS.PARTICLES, visualWeight: 0.6,
  reads: ['res:windField', 'res:weatherState', 'buf:scene.attr'],   // attr: indoor/outdoor + roof coverage
  writes: ['buf:scene.color'],
  spawn: { kind: 'area', gate: 'outdoors' },                        // vs { kind: 'extracted', extractor: 'roof-edges' }
  tiers: RAIN_TIERS,   // density/streak-detail rungs; the whole system is coverage+zoom gated
  params: RAIN_PARAMS, // the quarks curves, as schema
};
```

---

*Five engines, zero contracts, one lesson: a particle is a datum, not an object — and weather is data, not a class.*
