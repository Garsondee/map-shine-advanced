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
- **Roof drips are genuinely sophisticated:** union-find connected-component labeling over canvas pixels to find roof *edges*, plus a GPU silhouette readback (`readRenderTargetPixels`) — real algorithms, spending real stalls, to answer "where is the edge of a roof?" — a question the art already encodes.
- **Keyhole answer:** spawn extraction is the *canonical* per-page decode-time extractor case (Keyhole §4.1) — same as fire. Edge labeling runs per-page in the worker at decode; drip points accumulate in world space before anyone asks. The GPU is never consulted. The *feature* (drips fall from roof edges — delightful) survives; the stalls die.

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
- **Open question (Stage 6 spike):** keep `three.quarks` under the node renderer, or subsume into TSL-native instanced particles? Quarks' WebGL-era internals vs one-source-TSL doctrine — decide by spike, not preference; its *behavior-graph shape* survives either way.

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
