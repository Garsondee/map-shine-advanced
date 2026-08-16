# PARTICLES — the V2 autopsy + the buildable GPU-compute engine

**Status:** BUILDABLE ARCHITECTURE, 2026-07-21 (was RESEARCH + DESIGN SEED, 2026-07-16). Author: _"Particles are a mess too... from end to end. Since they are such a critical effect they deserve their own pass."_ Both claims verified: the mess is end-to-end, and "their own pass" is exactly the right shape for the fix. The 2026-07-21 pass turns the seed into an engine you can actually pour: memory model, GC doctrine, the compute kernel, behavior compilation, spawn, drawing, the passes, the walls, and a committed first slice — grounded in a live audit of the real code (`graph/passes.js`, `three-allocator.js`, `world/wind-field.js`) and a verified inventory of the TSL compute API in the vendored build.
**Companions:** `Water.md` (the sibling audit), `Effects.md` (tiers — particles are the C7/C8 rungs), `Effects-API.md` (the contract), `Effects-UI.md` (FOH/ROH controls), `Wind.md` (the field particles ride, and the template this doc follows), `Engine-Postmortem.md`.

**Reader's map.** §1–6 = the autopsy (_why_ — V2's five-architecture disease, unchanged evidence base). §7–8 = the shape (_what_ — one engine, weather as data; the declaration sketch other files cite as "§7"). **§9–24 = the buildable engine (2026-07-21): how you actually construct it.** The author's directive for this pass: _"organised and ready to serve the needs of lots of effects, think about GC, make the best possible single system through which other things can run."_ The chosen first slice (§23) is a **polished ambient-dust effect** riding `res:wind`.

---

## 1. The inventory

`legacy/particles/` is **16,117 lines** — and that is only the dedicated directory. Particle-shaped code also lives in `WaterSplashesEffectV2` (3,854 + 1,683 behaviors), `DustEffectV2` (1,443), `AshCloudEffectV2`/`AshDisturbanceEffectV2` (2,614), `CandleFlamesEffectV2` (3,570), fire's embers, and `SmellyFliesEffect` (1,971). Call it **~25k lines of particle systems** module-wide.

| Lines          | File                                                           | Note                                  |
| -------------- | -------------------------------------------------------------- | ------------------------------------- |
| **11,777**     | `WeatherParticles.js`                                          | rain + snow + ash + embers, ONE class |
| 1,971          | `SmellyFliesEffect.js`                                         | swarm behavior                        |
| 510 / 417      | `RainStreakGeometry.js` / `SnowGeometry.js`                    | bespoke geometry builders             |
| 465 + 287      | `RoofDripGpuSilhouetteReadback.js` + `RoofDripEdgeSampling.js` | drip spawn machinery                  |
| 126 / 101 / 77 | SmartWind / SmartUpdraft / world-volume-kill behaviors         | **product** — the feel                |

## 2. 🔴 THE HEADLINE — five particle architectures in one module

| Render model                                                                        | Where            |
| ----------------------------------------------------------------------------------- | ---------------- |
| `three.quarks` (vendored library: `BatchedRenderer`, behavior graph)                | WeatherParticles |
| `THREE.Points`                                                                      | 1 file           |
| `InstancedMesh`                                                                     | 3 files          |
| **`new THREE.Sprite()` PER PARTICLE** — a scene-graph object _and a draw call_ each | **8 files**      |
| Per-particle JS-object callbacks (`update(particle, delta, system)`)                | 11 files         |

**There is no particle engine. There are five.** Every particle-ish effect re-solved emission, lifetime, wind response, culling, pooling, and disposal from scratch — which is _why_ splashes, dust, ash, flies, drips and candles each cost a thousand-plus lines. The Sprite-per-particle model in 8 files is the worst of it: N particles = N scene objects = N draw calls, plus scene-graph overhead per flake. This is the same "no contract → everyone builds their own" mechanism as the effects layer (`Effects-API.md` §2), one level down.

**The one good call:** whoever wired weather chose `three.quarks` with `BatchedRenderer` — real batching, a behavior graph (TurbulenceField, CurlNoise, SizeOverLife, Bezier curves). The _instinct_ (one engine, batched, behavior-driven) was correct. It just never became mandatory, so five architectures coexist — the optional-structure law again, in miniature.

## 3. 🔴 355 private fields — the most stateful object in the module

`WeatherParticles` carries **355 distinct `this._*` fields** — beating the render loop (50) and even token movement (178). Inside the one class and one mutable namespace live at least four weather systems: **ash (826 mentions), rain (513), snow (210), embers (221)**. Any field can touch any system; every bug hunt walks 11,777 lines. This is the god-object pattern _recursed into a single effect_ — FloorCompositor's disease at one level lower, proving the pattern is scale-free unless structurally blocked.

**Keyhole answer:** a weather _type_ is **data, not a class** — an emitter config + behavior list + tier ladder consumed by ONE engine. Rain and snow are two configs, not two thousand-line siblings sharing a namespace.

## 4. 🔴 Spawn = CPU pixel scans; drips = brilliant CS on a doomed foundation

- Spawn points come from `getImageData` scans of mask canvases, with the pacing band-aids visible in the comments: _"Cache pixel readbacks... getImageData is expensive and allocates"_, _"Spread CPU tile getImageData work across control ticks."_ The band-aid signature: correct fix, wrong layer.
- **Roof drips are genuinely sophisticated CS wrapped around a genuinely broken foundation.** Union-find connected-component labeling over canvas pixels finds roof _edges_ correctly. But the screen→world mapping for those edge points is never derived — it is **voted on, at runtime, every extraction cycle** (`_probeBestNdcMode`): four Y-flip/NDC-sign combinations are ray-cast against a handful of sample points and whichever lands the most hits inside a loose (±5%) bounding box wins, uncached. Author-confirmed live (2026-07-16): _"roof drips were both an awesome idea in concept and they never reliably worked."_ This is why — a small or thin roof gives too few samples for a stable vote, the loose tolerance lets multiple modes pass simultaneously, and the winner can flip between cycles for the identical roof under the identical camera. It is [[feedback_y_flip_recurring_risk]] taken one step further: not "solved wrong, once," but **never solved, forever re-litigated, by a coin rigged to sometimes land wrong.**
- **Keyhole answer:** spawn extraction is the _canonical_ per-page decode-time extractor case (Keyhole §4.1) — same as fire. Edge labeling runs per-page in the worker at decode; drip points accumulate in world-space PAGE coordinates, which are already unambiguous (no screen involved at all, so there is no NDC mode to guess). The screen→world question this file exists to answer is **structurally impossible to need**, because extraction never touches the screen. The GPU is never consulted, and neither is a coin. The _feature_ (drips fall from roof edges — delightful) survives; the entire disease dies, not just the stalls.

## 5. The rest of the wiring (familiar diseases, particle edition)

67 `window.MapShine` reaches; 36 empty catches; 73 `Vector/Color` allocations in WeatherParticles (mostly config-time — quarks handles the per-particle hot path, which is partly why weather performed better than the Sprite-per-particle effects); a GPU readback in the spawn path; wind/updraft behaviors reaching for global controller state.

## 6. What is PRODUCT — harvest list

- **The behavior tuning**: turbulence/curl fields, size/color-over-life curves, emission rates per weather type — the _feel_ of the author's weather.
- **SmartWindBehavior / SmartUpdraftBehavior / world-volume-kill** — small, composable, and conceptually right (behaviors as pluggable units _is_ the modern particle model).
- **The roof-drip concept** (spawn on real roof edges) and the flies' swarm feel.
- The rain-streak/snow geometry ideas (stretched streaks vs tumbling flakes).

## 7. The Keyhole design — ONE engine, weather as data

- **One particle pass family** in the frame graph (`sims` stage): GPU-instanced, batched, camera-facing quads / streak geometry; **never** a scene-graph object per particle.
- **A particle system is a declaration**: `{ emitter, behaviors[], spawnSource, tiers, packs }` — consumed by the one engine. Adding hail is data, not a class.
- **Spawn sources are decode-time extractors** (`vt:` pack + extractor id) — fire points, water splashes, drip edges, dust zones: one mechanism.
- **Tiers per `Effects.md`** — particles are the ladder's C7/C8 rungs _by definition_, so every system is coverage- and zoom-gated (Law 7): rain that is sub-pixel does not simulate. Tier 0 for a particle system is legitimately **absent** (unlike surface effects) — but its _tier-0 stand-in_ is the cheap non-particle cue where one exists (wet tint, snow albedo shift) declared by the owning surface effect, so weather never vanishes entirely on weak machines.
- **Inputs are declared reads**: wind field, weather state, time — never reached for.
- **✅ RESOLVED (2026-07-16), was "Stage 6 spike": TSL-NATIVE GPU PARTICLES. `three.quarks` the LIBRARY cannot be used; `three.quarks` the DESIGN is harvested wholesale.**

  **Why quarks cannot be used — verified in source, at HEAD (0.17.1, freshly downloaded), not inferred:** it has `NodeMaterial: 0`, `TSL: 0`, `WebGPU: 0`, `wgsl: 0` — and `ShaderMaterial: 4`, `gl_FragColor: 5`, `onBeforeCompile: 10`. It builds raw-GLSL `ShaderMaterial`s patched via `onBeforeCompile`, **a hook the node renderer never calls** (4 hits in our build: a stub, two comments, a cache key). The exact failure path is in `three.webgpu.js`:

  ```js
  let nodeMaterial = renderer.library.fromMaterial(material); // ShaderMaterial => not in the registry => null
  if (nodeMaterial === null) {
    error(`NodeBuilder: Material "${material.type}" is not compatible.`);
    nodeMaterial = new NodeMaterial(); // => blank material
  }
  ```

  **This is NOT a cost of the TSL decision.** Quarks is incompatible with _modern three.js's material system_, which any current three.js path requires. Upstream's own roadmap lists WebGPU support as unchecked/planned. The only way to run quarks would be a second WebGLRenderer — i.e. `Engine-Postmortem.md` §1's ROOT BLUNDER (two renderers), knowingly re-committed. Never.

  **Why TSL is an UPGRADE, not a consolation — verified in our vendored build:** it exports `TSL.compute`, `TSL.storage`, `TSL.instanceIndex`, and **`TSL.instancedArray`** (three.js's purpose-built GPGPU particle helper), plus `StorageInstancedBufferAttribute`, `atomicAdd`, `workgroupBarrier`. **And compute runs on BOTH backends:** `WebGLBackend.compute()` is a real implementation that emulates compute via **transform feedback** (`RASTERIZER_DISCARD` + `beginTransformFeedback(POINTS)` + `drawArraysInstanced` + ping-pong `switchBuffers()`). So ONE TSL source gives GPU-simulated particles on WebGPU _and_ WebGL2 — exactly `keyhole-webgpu-tsl-decision`'s promise, and the safety slide is intact.

  |                             | three.quarks                                  | TSL-native                           |
  | --------------------------- | --------------------------------------------- | ------------------------------------ |
  | Simulation                  | **CPU**, per-particle JS objects              | **GPU** compute / transform feedback |
  | Backends under our renderer | **none** (blank material)                     | WebGPU **and** WebGL2                |
  | Per-particle CPU cost       | yes                                           | **zero**                             |
  | Keyhole doctrine            | violates one-source-TSL; needs a 2nd renderer | native                               |

  Quarks' CPU sim was _also_ the disease `Effects.md` and `Engine-Postmortem.md` name: per-particle JS objects (11 files did this). **TSL particles delete V2's actual particle bottleneck**, not just port around it.

  **What IS harvested — the design, which was always the good part:** `quarks.core` is **renderer-agnostic** (verified: `ShaderMaterial: 0`, `gl_FragColor: 0`, `onBeforeCompile: 0`) and its export list _is_ the vocabulary to reimplement: emitters (`ConeEmitter`, `GridEmitter`, `DonutEmitter`, `CircleEmitter`, `HemisphereEmitter`, `PointEmitter`), behaviors (`ApplyForce`, `ApplyCollision`, `ColorOverLife`, `SizeOverLife`, `ForceOverLife`, `OrbitOverLife`, `LimitSpeedOverLife`, `ColorBySpeed`, `TurbulenceField`, `CurlNoiseField`), generators (`IntervalValue`, `ConstantValue`, `PiecewiseBezier`, `Bezier`, `ColorRange`, `Gradient`), and `*FromJSON` deserializers — **proving the author's "weather as data" model was already quarks' own model.** Take the vocabulary, the JSON shape, and every tuned curve/rate value from `WeatherParticles`; implement the behaviors as TSL compute functions. `quarks.core` may even be usable as a _reference implementation_ to diff against.

## 8. Declaration sketch

> **2026-08-16:** the weather family this sketch gestures at now has its owning design — `docs/planning/Precipitation.md`: the species table (rain/snow/sleet/hail/ash/sand/spore as data rows), the FALL/ARRIVAL/STAY split, the sky-reach gate, the mantle (persistent snow), and a fourth runtime plan (`precip-runtime.js`, the first whose behaviors compile from a data table — the real first step toward §9's compiler). This sketch stands as the registration shape it will use.

```js
export const RAIN = {
  id: 'weather.rain',
  layer: LAYERS.PARTICLES,
  visualWeight: 0.6,
  reads: ['res:windField', 'res:weatherState', 'buf:scene.attr'], // attr: indoor/outdoor + roof coverage
  writes: ['buf:scene.color'],
  spawn: { kind: 'area', gate: 'outdoors' }, // vs { kind: 'extracted', extractor: 'roof-edges' }
  tiers: RAIN_TIERS, // density/streak-detail rungs; the whole system is coverage+zoom gated
  params: RAIN_PARAMS, // the quarks curves, as schema
};
```

---

# THE BUILDABLE ENGINE (§9–24)

_Everything below was written 2026-07-21 against the real code. The three settled facts it rests on: (1) `sims.particles` and `surface.particles` are already declared as `status:'seam'` passes in `graph/passes.js`, routed to `registerParticleSystem`; (2) the TSL compute toolkit is fully present in the vendored build — `compute` (`three.webgpu.js:36458`), `instancedArray` (`:49749`), `instanceIndex` (`:36337`), `atomicAdd` (`:51629`), `mx_fractal_noise_float` (`:54331`), `hash` (`:48875`), driven by `renderer.compute()` (`:62091`), with a real WebGL2 transform-feedback fallback in `WebGLBackend.compute` (`:68213`); (3) **nothing in the codebase has ever called compute yet** — the particle engine is the first, which is a milestone and a risk, and §23 de-risks it first._

## 9. THE ENGINE — one nucleus, four parts

The "single system" the author asked for is **not one buffer and not one kernel**. It is one owner of four responsibilities, and every particle effect in the module flows through all four:

1. **The compiler.** Turns a `ParticleSystemDecl` (data — already validated by `validateParticleSystem`, built and tested today) into two GPU programs: a **sim kernel** (a TSL `Fn` handed to `compute()`) and a **draw material** (a `NodeMaterial`). Built ONCE at register time, never per frame. This is the step that makes rain and snow _"two configs, not two thousand-line siblings sharing a namespace"_ (§3).
2. **The arena** (§10). Owns every particle byte on the GPU — one pre-allocated pool, sub-ranged per system. The ONLY place `instancedArray`/`storage` is ever called (a wall, §20).
3. **The scheduler** (§11). Each frame: update a handful of uniforms (time, dt, live counts, the wind handle), dispatch each _awake_ system's kernel, draw it — and skip the sleeping ones entirely. No allocation, no per-particle CPU work, ever.
4. **The two passes** (§17). `sims.particles` (the compute dispatches, `sims` stage) and `surface.particles` (the instanced draws, `surface` stage) — the seams already declared in `passes.js`.

> **Maya translation:** the compiler + arena + scheduler together are **the Nucleus** — one solver. A `ParticleSystemDecl` is **one nParticleShape's settings**. Behaviors are **fields** you plug in. The two passes are **the solve and the draw**. The single difference that matters: Maya's per-particle runtime expression runs on the CPU and dies past ~10k particles; here that expression _is_ a GPU compute kernel, so a million particles cost the CPU nothing.

## 10. MEMORY MODEL — one arena, sub-ranged (the "single system," made literal)

The most literal possible reading of _"one system through which other things run"_ is also the best-performing and the most GC-proof: **the whole engine owns exactly one set of attribute buffers, allocated once, and every system lives in a sub-range of them.**

**The attributes (Structure-of-Arrays, GPU-resident).** A particle is a _row_ across a few parallel buffers, never a struct and never a JS object:

| Buffer     | Type           | Meaning                                                                                                                   |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `position` | `vec2` (world) | where it is. `vec3` later if a pseudo-height earns its bytes.                                                             |
| `velocity` | `vec2`         | where it's going (world px/s).                                                                                            |
| `age`      | `float`        | seconds alive.                                                                                                            |
| `life`     | `float`        | total lifespan, set at spawn from a generator (§15).                                                                      |
| `seed`     | `float`        | per-particle RNG seed, set at spawn, stable for life — the whole source of per-particle variety, deterministically (§12). |
| `custom`   | `vec4`         | per-system packed extras (rotation, size jitter, a color-ramp index…).                                                    |

≈ 8+8+4+4+4+16 = **44 bytes/particle**. Start with clearly-named separate `instancedArray(N, type)` buffers; pack into `vec4`s only if the 🔬 perf lab (`diag/perf-lab.js`) proves bandwidth demands it. _Measure, then pack_ — never the reverse.

**The arena — allocate once, never free.**

- At engine init, allocate ONE `instancedArray(TOTAL, type)` per attribute, where `TOTAL` = the particle VRAM budget ÷ bytes-per-particle. A generous **96 MB budget ≈ 2.1M particles** — more than any scene will ask for, and a rounding error against the ~2.5 GB WebGPU ceiling that caused the 12k-map device-loss (`keyhole-device-loss-large-map`). _VRAM is a non-issue here; state it, because that crash makes every new GPU allocation look guilty until proven innocent._
- Each registered system **reserves a sub-range** `[offset, offset+capacity)`, where `capacity` = its **max-tier** particle count. A tiny CPU-side free-list tracks the ranges. Adding hail is a sub-range and a compiled kernel — not a subsystem.
- The kernel addresses its slots as `globalIndex = instanceIndex + offset` (offset is a uniform); the draw renders `liveCount` instances from the same base. One arena, many tenants.

**Why this is the answer to disposal (the one real GC unknown).** `StorageInstancedBufferAttribute` extends `BufferAttribute`, which **has no `dispose()`** (`reference_bufferattribute_no_dispose_trap` — the leak that cost a live device-loss in ~30s). So _how do you free a storage buffer_ is a genuine open question in this build. **The arena sidesteps it entirely: after init, the engine never allocates or frees a GPU buffer again.** Deregistering a system returns its sub-range to the free-list (a CPU array operation); the GPU memory is recycled, never destroyed. There is no disposal path to get wrong because there is no disposal. This is the same discipline as the VT atlas (one `DataArrayTexture`, allocated once by `vt/atlas.js`, never per-frame).

**Tier changes are free.** A system reserves its _max_-tier capacity but simulates and draws only its _active_-tier `liveCount ≤ capacity`. Tiering down = simulate fewer = cheaper instantly, with **zero reallocation and zero pipeline hitch**. Tiering up = raise `liveCount` (the newly-woken slots spawn fresh on their next kernel pass). The expensive "grow the buffer" event the BufferAttribute trap warns about simply never happens at runtime.

> For the first slice (one system) this is trivial: dust owns the arena at `offset 0`. The sub-ranging matters the moment a second system (rain) registers — and it costs nothing to design in from the start.

## 11. THE GC DOCTRINE — the pillars, stated as law

The author's explicit ask. Each pillar is a V2 corpse turned into a structural guarantee:

1. **State never touches JS.** Position/velocity/age live only in GPU buffers the GPU writes. There is no `Particle` object to allocate or collect — V2's actual bottleneck (a JS object per particle, in 11 files; §2) and Maya's ~10k ceiling are _structurally absent_, not merely optimized away.
2. **Allocate once.** All GPU memory is the arena (§10), taken at init. The hot path never calls `new` on anything GPU-side. The `new THREE.Buffer*Array(` / `new THREE.*BufferAttribute(` tell that flagged the last leak (`reference_bufferattribute_no_dispose_trap`) can only appear in engine init, never in a per-frame function — and a wall enforces it (§20).
3. **Idle is free.** The scheduler skips a sleeping system's compute _and_ draw completely (§9.3). A system sleeps when disabled, off-screen, zoomed past its gate (Law 7 — sub-pixel dust is _waste with a cost_, not "cheap"), or drained of particles with nothing emitting. The cheapest particle is the one that never runs — the exact freeze/thaw posture `Wind.md §3.1` already proved, applied to Lagrangian particles.
4. **A hard budget, one door.** The arena is a budget authority analogous to `ThreeAllocator` — except `ThreeAllocator` guards only _render targets_, so storage buffers slip past every existing law today. The arena caps total particle VRAM and is the sole site of `instancedArray`/`storage`. A registration that would exceed the budget fails loudly at the call site with a stack, in dev — never a device-loss three weeks later in the field (the `ThreeAllocator` posture, `three-allocator.js:88`).
5. **Per-frame CPU cost is a constant.** A few uniform writes + one `renderer.compute()` per awake system + one draw per awake system. No allocation, no readback, no per-particle anything. Independent of particle count.

## 12. THE COMPUTE KERNEL — the per-frame life of a particle

One `compute()` dispatch per awake system, over its `liveCount` slots. The compiled kernel, per slot `i = instanceIndex + offset`, in order:

1. **Read** this slot's row (`position[i]`, `velocity[i]`, `age[i]`, `life[i]`, `seed[i]`).
2. **Dead check.** If `age ≥ life`: recycle in place (steady systems) or leave dead/invisible (bursty systems) — see §14.
3. **Apply motion behaviors** in declared order (§13): accumulate force, sample wind, curl-noise turbulence, drag, collision, kill-volumes. Each is a TSL snippet composed into the kernel at compile time.
4. **Integrate** (semi-implicit Euler): `velocity += force·dt; position += velocity·dt`. `dt` is a uniform.
5. **Age**: `age += dt`.
6. **Write** the row back. In-place — no ping-pong.

**No ping-pong, and why that matters.** A grid fluid sim (Wind Tier 2) must double-buffer because advection reads _neighbors_. Particles are **embarrassingly parallel** — slot `i` reads and writes only slot `i` — so there is no read/write hazard and the kernel updates in place. That halves the memory and deletes a whole class of bug. (The one exception is flocking/boids, which reads neighbors; that's a hard, later rung and needs a spatial structure — §22, deferred. `SmellyFlies` swarm behavior is the eventual customer.)

**Determinism, and the one clock.** Every per-particle "random" value is `hash(seed + salt)` (`hash` exists at `three.webgpu.js:48875`, callable in-kernel), so a scene renders identically frame to frame and machine to machine, with _zero_ RNG state to store or evolve. **Time and `dt` are inputs** from the frame snapshot (`lastEnvSnapshot`, `vt-pan-viewer.js:4280`), never `performance.now()` — V2 had 8 independent `performance.now()` reads in one effect; the one-clock wall forbids it and the `stepParticles` door already says so (`particle-engine.js:118-127`).

**The exact TSL idiom** (create the compute node once, dispatch each frame) is settled in the §23 spike, not guessed here — the verified exports (`compute`, `instancedArray`, `.element(instanceIndex)`, `renderer.compute(node)`) are sufficient; the ergonomics around them are what the spike pins down.

## 13. BEHAVIORS — the field library (this is the Hypershade part)

A behavior is a **named TSL snippet** the compiler splices into a system's kernel or material. The vocabulary is already frozen in `particle-system-schema.js` (`BEHAVIORS`, harvested from `quarks.core` — proven against real content). The engine keeps a registry `behaviorName → (state, params, ctx) → void`, walks the declaration's `behaviors[]` at compile time, and composes them. **Adding a behavior is adding one file to the library; using it is one line of data in a decl.**

Behaviors split by _where they compile_, and the compiler routes them automatically:

| Splice site             | Behaviors                                                                                                                                                                                          | What they touch                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Sim kernel** (§12)    | `applyForce`, `forceOverLife`, `orbitOverLife`, `limitSpeedOverLife`, `turbulenceField`, `curlNoiseField`, `smartWind`, `smartUpdraft`, `applyCollision`, `worldVolumeKill`, `changeEmitDirection` | motion, lifetime, death                                                               |
| **Draw material** (§16) | `sizeOverLife`, `colorOverLife`, `colorBySpeed`                                                                                                                                                    | appearance only — read `age/life` or `speed`, output size/color via a curve LUT (§15) |
| **Both / spawn**        | `emitSubParticle`                                                                                                                                                                                  | a dying particle seeds another system (embers → smoke) — a later rung                 |

Two behaviors carry the author's V2 taste forward and are _conceptually right_ as pluggable units (§6): **`smartWind`** and **`smartUpdraft`**. `smartWind` is not free noise — **it samples `res:wind` through the one door**: it calls `sampleWind(TSL, {centerXY: position, time, exposure, wind, bakedField})` — the _exact_ function the candle flame and light already share (`world/wind-field.js:95`), composed straight into the particle kernel. A particle in a drafty corridor and the candle flame beside it lean in the _same_ baked field. This is `Wind.md`'s `sample-through-the-door` wall extended to particles: **no ad-hoc `sin`/noise "wind" in a particle kernel once `res:wind` exists (§20).**

> **Curl noise** has no built-in node (verified — `mx_fractal_noise_float` exists, a named `curl` does not). It's derived from the analytic gradient of `mx_fractal_noise` (curl of a potential field = divergence-free flow — the swirling that makes dust read as _air_, not falling sand). This is the one behavior with real shader work in it; everything else is arithmetic.

## 14. SPAWN — three rungs of difficulty, and only the first is needed now

Where a particle is born. Tiered so the engine grows only as far as the content needs:

1. **Steady loop** — _the only rung the first slice needs._ Population = capacity; a dead particle **respawns itself in place** from the emitter, using its own `seed` to pick a position/velocity within the shape. Density is set by capacity + lifespan, not a rate. No counters, no bookkeeping, no atomics. Rain, snow, ambient dust, wind-motes.
2. **Bursty / rate** — a per-frame emit budget (`rate·dt + carry`, one scalar computed CPU-side, no per-particle work) turned into live particles by an **`atomicAdd` counter** (`three.webgpu.js:51629`): a dead slot claims `idx = atomicAdd(emitCounter,1)`; if `idx < budget` it spawns, else stays dead. Embers, splashes. **⚠ Validate this rung on the WebGL2 backend specifically** — its transform-feedback compute has documented constraints (draws `gl.POINTS`, no indirect-count; `WebGLBackend` warns at `:68236`).
3. **Extracted** — spawn points computed **at decode time, per page, in the worker** (Keyhole §4.1), uploaded as a small point buffer the kernel samples. Roof-drip edges, fire points, splash sites. **This is a bug fix, not an optimization** (§4, and the schema's own note): V2 found spawn points by GPU readback and by _voting at runtime between four screen→world flips_ — which is precisely why roof drips _"never reliably worked."_ Extracted points live in world-space PAGE coordinates where no screen is involved, so the question stops being askable.

**Emitter shapes** (`EMITTER_SHAPES`, from `quarks.core`): point, circle, cone, donut, grid, hemisphere, shell — each a `seed → world position` sampler in the kernel. **Gating**: an `area` emitter may name a `gate` attribute (e.g. `outdoors`), read from `buf:scene.attr` (a C3 screen-space read — cheaper than a per-floor RT stack, `Effects.md`). Dust spawns only where the sky reaches; rain only outdoors.

## 15. GENERATORS & CURVES — the author's taste, baked to LUTs

The tuned curves are the irreplaceable part (§6): size-over-life, color-over-life, emission shapes, lifespan spread. `quarks.core`'s generator vocabulary is already named in the schema doc: `PiecewiseBezier`, `Bezier`, `Gradient`, `ColorRange`, `IntervalValue`, `ConstantValue`, `Noise`.

**On the GPU, a curve is a tiny 1-D LUT texture, baked once at register time.** A `PiecewiseBezier` for `sizeOverLife` becomes a 1×256 R-float texture; the draw material samples it at `age/life`. `colorOverLife`/`ColorRange` → a 1×256 RGBA texture. Cost per frame: one texture read. Cost to change the author's taste: rebake one small texture — the same "tear down and recreate on a param change" discipline the light pool and `Wind.md`'s `bakedField` already use. **The curves stay exactly as tuned; the runtime pays nothing for them.**

## 16. DRAWING — one instanced draw, never a scene object per particle

The law this whole module exists to enforce (§2, `particles/one-engine`): **N particles = 1 instanced draw = 1 draw call.** Not `new THREE.Sprite()` per particle (V2, 8 files, N scene objects and N draws).

- A single static unit-quad geometry, drawn `liveCount` instances. The `NodeMaterial.positionNode` reads `position[offset + instanceIndex]` from the arena and builds a **camera-facing billboard** (or a **velocity-stretched streak** for rain — the draw variant is chosen by the decl). The CPU never touches per-instance data — the whole point of GPU compute is that particle state is written by the GPU and read by the draw without a round trip. This is _simpler_ than the candle's per-frame CPU vertex mutation, and it cannot hit the BufferAttribute leak because there is no per-frame attribute write.
- Dead particles collapse to zero size in the vertex node (or `discard` in the fragment) — they cost a degenerate triangle, not a branch on the CPU.
- **One dedicated `particleScene`**, following the module's stated rule _"one `THREE.Scene` per render-target destination"_ (`vt-pan-viewer.js`), rendered into `buf:scene.color` in the `surface` stage. `frustumCulled = false` on the instanced mesh (the arena spans the whole map; per-instance culling is the GPU's job via the gate, not THREE's bounding sphere).

## 17. WHERE IT SITS — two passes, one resource, the pragmatic wiring

Already scaffolded. `graph/passes.js` declares both seams and the seam wiring routes them to the engine:

```
sims.particles     stage:'sims'     kind:'gpu'  creates:['res:particles']
                   reads:['res:env','res:view', 'res:wind', 'buf:scene.attr', 'vt:masks']
surface.particles  stage:'surface'  kind:'gpu'  reads:['res:particles']  modifies:['buf:scene.color']
```

- **`res:particles`** is the arena — sim state, world-space, persistent across frames (the `res:` grammar covers exactly this). Never a `buf:` (those are screen-sized and per-frame).
- **The wiring pattern is the pragmatic one wind and candles already use.** The module has _two_ pass systems: the live one (the data DAG + closures in `vt-pan-viewer.js` that capture the renderer/RTs/scenes lexically and receive an empty `{}` ctx) and a dormant, tested-but-zero-caller `FrameGraph` class that actually resolves `res:`/`buf:` names to handles. **We do not activate the dormant graph.** The compute step and draw wire in as closures capturing the engine + renderer, exactly as `Wind.md §9` did its bake (_"wired directly into `vt-pan-viewer.js`'s own closure… promoting it to a real pass declaration is a recorded follow-up"_). Promotion to the resolving graph is a whole-module future step, not particles' job.
- **One wiring chore:** the live loop's `framePlan` is currently scoped `fromStage:'masks'` (`vt-pan-viewer.js:2983`), so the `sims` stage isn't walked yet. Widen it to include `sims`, or invoke `stepParticles` directly in `renderFrame` before the draw passes (wind's approach). Either is a one-line change; widening the plan is the cleaner, more on-rails option.
- **Compute is synchronous.** `renderer.compute(node)` is sync post-`init()`; `renderAsync` is deprecated in this build. The frame loop stays fully synchronous — no async plumbing exists or is needed. The dispatch happens in a `sims`-stage closure _before_ the draw passes run.

## 18. TIERS, COVERAGE-GATING, AND HONESTY ABOUT THE GOVERNOR

Particles **are** the C7/C8 rungs of the effect ladder _by definition_ (`Effects.md` §3): C7 (per-frame sim — the compute dispatch, ticks whether or not it's seen) and C8 (geometry — the instanced draw, overdraw). So **every particle system takes Law 7's second gate: coverage and zoom, not just tier.** Zoomed out until dust is sub-pixel → the correct tier is 0 (absent) no matter how fast the machine is. This gate is _also_ the sleep trigger (§11.3) — the same test that saves the frame budget saves the GC.

**Honest ledger — the machinery the schema assumes is mostly not built** (verified in code, 2026-07-21):

- `visualWeight` is declared and validated on every system, and **read by nothing**. There is no per-effect tier governor. The only governor that exists is `RenderScaleGovernor` (a _global_ render-scale DRS, `graph/v3-perf.js:245`) — and it isn't even wired up (nothing instantiates it outside tests; its own doc admits _"nothing yet acts on a measurement"_). So **the engine does not lean on a governor that doesn't exist.** For now a system's tier is an explicit setting; the engine applies its own coverage+zoom gate. `visualWeight` is declared for the future cross-effect governor (`Effects.md §6`, _return-per-millisecond_ arbitration) so that when it lands, particles slot in for free. `perf-lab.js` already measures per-effect GPU cost — the input that governor will need.
- **Permission, a11y, and UI: register a particle system _as an effect_.** The particle schema has no `a11y`/`enabledFromProfile`, so a bare `ParticleSystemDecl` does _not_ plug into the Creator→GM→Player cascade or generate Foundry enable-settings (that machinery keys off `EffectManifest` fields via `describeEffectSettings`). **Resolution: a particle effect registers a normal `EffectManifest`** (id, `visualWeight`, `a11y`, `enabledFromProfile`, `params`, `tiers`) through the effect registry — inheriting cascade, settings, a11y hard-off, and UI for free — and its injected `apply(resolved)` closure calls `registerParticleSystem(decl)` and pushes live params in. The `EffectManifest` is the _outer_ registration (permission/enable/UI); the `ParticleSystemDecl` is the _inner_ GPU recipe. No parallel permission system, no schema bloat. This is the `ui-window-shadow.js` pattern (`boot.js:199`), applied to a particle effect.

## 19. FRONT OF HOUSE & REAR OF HOUSE — the controls

Per `Effects-UI.md`, both faces generate from one params schema — no hand-wired panel. **Honest caveat: the generated-UI renderer itself is doctrine-only today** (verified — `params-schema.js` is the source of truth, but no FOH/ROH generator exists in `src` yet; live tuning currently rides transient override layers, `boot.js:207`). So the schema is authored now; it renders when the generator lands. For dust:

- **ROH (expert board):** `DUST_PARAMS`, sorted into the fixed category set — Presence (`enabled`, `density`, `simQuality` [the tier the future governor drives]), Motion (`windResponse`, `turbulence`, `drift`, `swirlScale`), Extent (`gate: outdoors`, spawn area), Response (`sizeOverLife`, `opacityOverLife`, `color`), Technical (`capacity`, `lifespan`, `lifespanJitter`) — validated by `validateParamsSchema`.
- **FOH (honest dials, 3–6):** e.g. a **Dustiness** set-driven-key (the author's Maya vocabulary) driving `density` + `opacity` together; a **Liveliness** dial driving `windResponse` + `turbulence`. Validated against `DUST_PARAMS` at build so a dial can never reference a ghost.
- **The dead-control cure applies verbatim** (`Effects-UI.md §4`): a `windResponse` knob wired to nothing announces itself via `declared − read` control-health, instead of dying in silence the way V2's sliders did.

## 20. WALLS & TRIPWIRES — build failures, not comments

Each is machine-enforced (`Skeleton.md` — _a comment cannot fail a build; a check can_):

1. **`particles/one-engine`** (EXISTS, `verify-structure.mjs`). `THREE.Sprite`/`Points`/`InstancedMesh`/`three.quarks`/`BatchedRenderer` outside `effects/particles/` fails the build. The `InstancedMesh` the draw uses lives _inside_ the engine, where it's legal.
2. **`particles/allocator-only`** (NEW). `instancedArray(`/`new *StorageBufferAttribute(`/`storage(` outside the arena module fails the build — the exact sibling of `gpu/allocator-only` for render targets (`three-allocator.js:69`). Storage buffers get one door, like RTs do.
3. **`particles/sample-wind-through-the-door`** (NEW, extends wind's). No `sin`/`mx_noise`-as-wind in a particle kernel once `res:wind` exists — a `smartWind` behavior samples the field. Sibling of `wind/sample-through-the-door`.
4. **`particles/no-private-clock`** (falls out of the one-clock ratchet). No `performance.now()`/`Date.now()` in the engine; time is the frame snapshot. The `stepParticles` door already states it.
5. **The velocity test** (`Skeleton.md` law 2). Declaring a `ParticleSystemDecl` + an `EffectManifest` must be _faster_ than hand-rolling a particle effect — or this loses exactly as V2's quarks-the-good-engine lost: **by being optional, not by being wrong.** One decl → a compiled GPU sim, an instanced draw, both UI houses, dead-control detection, budget accounting, sleep-when-idle: all free. That asymmetry is the only thing that keeps the wall a rail.

## 21. TRAPS — named now so they can't rot in later

- **Compute is new to this codebase.** Nothing has called `renderer.compute()` yet. Slice 1's first job is to prove it fires on the design-floor card on _both_ backends (§23). The safety slide (`feedback_safety_slide_outranks_doctrine`) catches a device-loss gracefully, but a silent no-op must be distinguishable from a working dispatch (`feedback_instruments_must_not_lie`).
- **WebGL2 transform-feedback constraints.** The fallback compute draws `gl.POINTS` and forbids indirect-count. Fixed-capacity steady spawn (slice 1) is fine; the atomic emit counter (§14.2) must be validated on WebGL2 _specifically_ before shipping bursty systems.
- **Disposal is designed out, not solved** (§10). If the pre-allocated arena ever proves too costly to reserve up front (it won't at these sizes), the fallback is explicit backend buffer destroy — which is _unverified in this build_ and would need its own spike. Prefer the arena; don't quietly introduce per-system `dispose`.
- **Y-flip at the world→billboard seam.** A new world→screen mapping for the billboard corners is exactly where orientation bugs hide (`feedback_y_flip_recurring_risk` — it bit the UI-shadow twice). Verify the first mote sits where its world position says, before tuning anything.
- **Over-spawn is a silent cost.** Capacity is reserved; `liveCount` is the lever. A system that quietly saturates its capacity every frame is C8 overdraw dressed as "ambient." `log()` when a system pins its cap (no silent truncation, `feedback_instruments_must_not_lie`).
- **The "green tests, no pixels" trap.** This module has shipped tested modules with _zero callers_ twice (the arena law, the `FrameGraph`). A declaration validating in Node is not the engine running. Slice 1 is explicitly a _pixels-on-screen_ milestone, not a _tests-pass_ one — which is exactly why the author chose the polished effect over the substrate-only option.

## 22. THE TIER LADDER — honest rungs

Recorded, not all built (`Effects.md §0` honesty). A particle system's **tier 0 is special**: it is legitimately the cheap _non-particle stand-in_ or absent (§7, `Effects.md`) — the particles themselves are C7/C8 rungs. For ambient dust:

- **Tier 0 — the floor.** No motes. Optionally a near-free fullscreen _dusty-air_ grain/haze tint (a few ALU in the grade pass) so a design-floor machine reads "the air has weight" without a single particle. Absent is also an acceptable tier 0 for dust (`Effects.md` permits it for particles). **Never gated; always affordable.**
- **Tier 1 — motes exist.** A modest capacity of billboarded dust, steady spawn, `smartWind` drift, lifespan fade. The first _particle_ rung — coverage+zoom gated (Law 7).
- **Tier 2 — motes swirl.** Add `curlNoiseField` turbulence + `sizeOverLife`/`opacityOverLife` LUTs + a soft sprite. This is the "polished" in the author's choice.
- **Tier 3 — density & depth.** Higher capacity, pseudo-height parallax, gentle color-over-life warmth near light. The expensive half a player only notices when present.

_(The full engine's deferred rungs, across all systems: bursty spawn (§14.2), extracted spawn (§14.3), sub-particle emission (embers→smoke), and the hard one — flocking/boids with a spatial structure (§12), whose customer is `SmellyFlies`.)_

## 23. BUILD ORDER — declaration-first, compute-spike-first, then the look

Committed first slice (author's choice): **a polished ambient-dust effect on `res:wind`.** Because that slice is a superset of the walking skeleton, the plumbing comes first _inside_ it, and the single biggest risk (compute has never run here) is retired at step 0:

0. **The compute spike** (throwaway, like `diag/tsl-spike.js` was for the render port). Prove `renderer.compute()` over one `instancedArray` advancing N positions renders correctly on the 3070 on WebGPU _and_ WebGL2. Read one value back and assert it moved — _"it didn't throw"_ is the inert bar the legacy build already met (`keyhole-webgpu-tsl-decision`). Delete when green.
1. **The arena** (`effects/particles/particle-arena.js`) + the `particles/allocator-only` wall. Allocate the budget once; reserve/return sub-ranges; Node-test the free-list. No GPU needed for the bookkeeping tests.
2. **The compiler + `stepParticles`** — unlock the door: compile a trivial decl (area emitter, `smartWind` only, steady spawn) into a kernel; dispatch it. **Pixels: motes drift on the wind field you just built.** This is the walking skeleton, now real.
3. **The draw** — instanced billboards into `particleScene` → `buf:scene.color`; widen `framePlan` to include `sims`; flip both passes `seam → live` in `passes.js`, register real fns in `pass-impls.js`.
4. **The look** — `curlNoiseField`, the curve LUTs (§15), a soft sprite, the `outdoors` gate, coverage+zoom sleep. Measured in the 🔬 perf lab before defaulting on.
5. **Register it as an effect** (§18) — an `EffectManifest` for `ambientDust` so it inherits enable-cascade, a11y, and (when the generator lands) UI; author `DUST_PARAMS` + `DUST_DIALS`.

Each step leaves the tree green and the wall passable. Nothing here reaches into `legacy/`; the tuned V2 curves/rates in `WeatherParticles.js` are _read as reference and re-authored as data_ (§6), never imported.

## 24. LESSONS, CARRIED FORWARD

- **A particle is a datum, not an object — and the engine is one, not five.** V2 lost the good engine because using it was _optional_ (§2). Here the walls make the engine the path of least resistance, and hand-rolling fails the build.
- **The best GC is no allocation.** One arena, taken once, recycled forever; state on the GPU, never in JS. There is no disposal path because there is nothing to dispose.
- **Idle is free, or it isn't a budget.** A candlelit room full of settled dust must cost nothing but a gate test — the same sleep that saves the frame saves the memory.
- **Coarse is not crude, and cheap is not absent.** Tier 0 is dusty _air_, not dusty _nothing_; the motes are the rungs above, gated on whether the eye can even see them.
- **Declare the whole ladder; pour one rung.** The engine is designed end to end here; the first slice is one polished effect. Building the rest is filling in rungs whose contracts were written on day one.

---

_Five engines, zero contracts, one lesson: a particle is a datum, not an object — and weather is data, not a class. The sixth engine is the last one, because this time the wall, not the comment, holds the door._
