# Point-Light Batching Design — Stage 2, full scope

Status: **DRAFT, awaiting the author's sign-off before implementation starts.** Written by
Claude Sonnet 5, 2026-08-11, per the author's direct choice ("Full scope, design note first")
after the narrower "swap the update mechanism" framing turned out to undersell the real
engineering surface. See `docs/holy/V4-Testament.md`'s Stage 2 section and petition P-004 for
the goal/gate this serves; this document does not re-litigate either.

Every claim below is grounded in a direct read of the real production files, not inference —
file:line citations throughout so this is checkable, not just trusted.

## 1. What's proven so far, and what it doesn't cover

`tools/shader-lab/bench-point-lights.js` proved the CORE mechanism: many differently-shaped,
differently-positioned, differently-coloured lights merged into ONE ungrouped mesh sharing ONE
compiled material draw at **1 real draw call instead of N**, byte-identical to N separate draws,
order-independent under MAX blending. That bench's per-light data was two numbers (origin,
radius) plus a per-vertex baked colour.

Real point lights carry far more. Reading `point-light-pool.js#createLightEntry` and
`update()`, plus `point-light-illumination.js#buildPointLightIlluminationMaterial` and
`point-light-coloration.js#buildPointLightColorationMaterial` in full, every light currently
gets:

- **Its own compiled material pair** (illumination + coloration), each a fresh `NodeMaterial`
  built once and reused — not two of a shared pool.
- **~15-20 independent scalar/vector uniforms per material** (see §3's full inventory).
- **A variable-length polygon edge-point array** (up to `MAX_LIGHT_EDGES = 64` vec2s,
  `point-light-illumination.js:161`) for the soft-edge SDF.
- **Up to `MAX_APERTURES_PER_LIGHT` (4, `aperture-gobo.js:163`) per-aperture uniform structs**
  (`uA`, `uDir`, `uNrm`, `uSLAWallLen` — `point-light-pool.js:1300-1319`), only on lights near a
  window.
- **A THIRD debug mesh** (`apertureShadowDebugMesh`) when apertures are present — diagnostic
  only, not part of the accumulate pass, out of scope here.

None of that surface was exercised by the bench. This document is the plan for closing that
gap, not a claim that the gap is already closed.

## 2. The central finding: avoid `uniformArray` + dynamic indexing entirely

This is the most important thing this investigation turned up, and it changes the design.

**Finding A (new, 2026-08-11):** the bench's third scenario built a per-vertex `lightSlot`
attribute indexing a shared `uniformArray` from the **vertex** stage (`positionNode`). Direct
device instrumentation — patching `UniformArrayNode`'s CPU-side `.value` and
`device.queue.writeBuffer` itself — proved the CPU-to-GPU write path is byte-correct end to end
for a moved light, and two further no-op re-renders stayed stuck on the pre-move image (ruling
out one-frame latency). The defect is real, reproducible, and narrowed to the bind-group/
buffer-resource layer of the vendored WebGPU backend, not root-caused. See
`tools/shader-lab/bench-point-lights.js`'s third scenario and `V4-Testament.md`'s P-004 second
addendum for the full evidence trail.

**Finding B (pre-existing, independently discovered — 2026-07-19, unconnected to Finding A
until this document):** `point-light-illumination.js:1289-1309`. The soft-edge margin term
(`edgeSoftFactor`) reads `edgePointsUniform` — a `uniformArray(edgePoints, 'vec2')` — through a
`Loop`-based SDF function (`sdPolygonEdgeDistance`) in the **fragment** stage. The code is
built, then explicitly discarded: `let combinedFalloff = falloff; void edgeSoftFactor;`. The
comment explains why: wiring it in was tried live once, and it turned the **entire scene solid
black** — all 79 active lights, not just the ones it should have touched. The author's own note:
*"something in this Loop/uniformArray/Fn SDF path is genuinely broken in the browser... Reading
the vendored THREE source (UniformArrayNode#update, updateType RENDER) did not turn up the
cause — it copies array\[i\].x/.y into its buffer every render call, which looks correct."* It
has stayed disabled ever since, unresolved.

**Read together:** this vendored WebGPU backend (three.webgpu.js, r0.185.1) has now produced
two independent, unexplained failures tied to `uniformArray` + dynamic/`Loop`-driven indexing —
one in the vertex stage, one in the fragment stage, discovered three weeks apart by different
investigations that never previously knew about each other. Different symptoms (frozen-stale
vs. solid-black), same suspect family. That is not proof the mechanism is categorically broken,
but it is a strong enough pattern that **this design does not use `uniformArray`-indexed reads
for per-light batching, in either shader stage, at all.** Re-attempting either existing disabled
use of the pattern is explicitly out of scope for Stage 2.

**What this rules in instead — both already proven, independently, elsewhere in this
codebase:**
- **Plain per-vertex attributes.** The bench's own scenario 2 already proved this: N lights'
  colour baked as a per-vertex attribute, one merged mesh, one draw, byte-identical output. No
  known failure mode anywhere in this codebase.
- **Texture sampling with a computed UV.** Used extensively and safely already —
  `attrTexNode.sample(screenUV)`, `depthTexNode.sample(screenUV)`,
  `texture(albedoTexture, screenUV)` all through the exact files read for this document. A
  completely different GPU code path from `uniformArray`/`Loop`, with zero history of this
  failure class anywhere in this project.

## 3. Full per-light data inventory, and where each piece goes

| Data | Source | Shape | Batching strategy |
| --- | --- | --- | --- |
| Position (x, y), radius | `light.x/y/radius` | 2×float | **Baked into vertex positions** at bucket-rebuild time (matches the workaround already approved for the vertex-stage bug — see §2). Not a runtime transform. |
| `uBackgroundColor`/`uDimColor`/`uBrightColor` | region-adjusted ambient, `point-light-pool.js:339-344`, recomputed per light per frame | 3×vec3 | Per-vertex attribute, rebuilt on change. |
| `uRatio`, `uAttenuationEased`, `uExposure` | `easeAttenuation`/`computeExposure`, per light | 3×float | Per-vertex attribute. |
| `uEdgeCount`, `uEdgeSoftMargin` | `computeEdgeSoftMarginNormalized` | 2×float (int, float) | Per-vertex attribute (int as a float attribute, cast in-shader — already how `vSlot` works in the bench). |
| Edge points (soft-edge SDF polygon) | `writeLightEdgePoints`, up to `MAX_LIGHT_EDGES=64` vec2 | variable-length | **Data texture**, one light per row/column, sampled by computed UV in the fragment shader (see §2's texture-sampling precedent). NOTE: this term is currently disabled in production (Finding B) — batching must not silently re-enable it; the data-texture rewrite is preparatory infrastructure only unless the author separately decides to re-attempt the SDF fix. |
| `uLightExpectedDepth` (elevation/depth gate) | `resolveExpectedDepth`, per light per frame | float | Per-vertex attribute. |
| Animation raw uniforms ×2 (illum + coloration) | `uSpeedRaw/uReverseSign/uSeed/uIntensityRaw`, `light.animation.*` | 2×4 floats | Per-vertex attribute (present only for animated lights — buckets already split by animation type, see §4, so a whole bucket has them or doesn't). |
| Wind uniforms ×2 (illum + coloration) | `uWindCenter/uWindExposure/uWindResponse` | 2×(vec2+2×float) | Per-vertex attribute, opt-in (candles carry these; plain Foundry lights don't — another bucket-key dimension, §4). |
| Aperture structs (up to 4/light) | `uA/uDir/uNrm/uSLAWallLen` ×2 (illum + coloration) | variable-length, capped at 4 | **Data texture**, same technique as edge points. Low priority — see §6, apertures fragment buckets by construction regardless of how the data itself is carried. |
| `uApLampHeight` ×2 | `resolveLampHeight` | float | Per-vertex attribute, opt-in with apertures. |
| `uColorationAlpha`, `uLightColor`, `uShadows` (coloration-only) | `computeColorationAlpha`, light colour, (disabled) shadows | float, vec3, float | Per-vertex attribute. `uShadows` is currently dead code (`point-light-coloration.js:431-441`, disabled 2026-07-21 after a build-time TSL failure) — carry the slot but do not wire it live. |

Every row above is either a scalar/vector (→ per-vertex attribute, the proven mechanism) or
genuinely variable-length (→ data texture, a different proven mechanism). Nothing in this table
needs `uniformArray`.

## 4. The bucket key (what makes lights shader-compatible)

Graph-BUILD-time choices — baked into the compiled shader, not read as data — force lights into
separate buckets. Verified against source, not assumed:

- **`animationType`** (`resolveLightAnimation`, `animations/registry.js`) — ~24 registered
  animations (torch, pulse, chroma, flame, siren, wave, fog, sunburst, dome, emanation, hexa,
  ghost, vortex, witchwave, rainbowswirl, radialrainbow, fairy, grid, starlight, smokepatch,
  candleFlicker, energy, revolving...) plus "none". Each builds a genuinely different TSL
  sub-graph (`buildIlluminationSeed`/`buildColorationSeed`), not just different uniform values.
- **`falloffModel`** (`'foundry'` | `'inverseSquare'`) — a JS `if` at graph-build time,
  `point-light-illumination.js:1269-1281`.
- **`animationQuality`** — forwarded as `quality` into the seed builder, a tier, per-animation
  build-time behaviour.
- **Wind presence** (`Number.isFinite(windExposure)`) — whether the wind uniforms/sampling
  exist in the graph at all is a JS `if` (`point-light-illumination.js:1196`), not runtime.
- **`apertureCount` × `apGoboCols` × `apGoboRows`** — confirmed graph-build-time (unroll counts,
  `aperture-gobo-render.js`'s own header, cited directly in
  `point-light-pool.js:1240-1249`'s own rebuild-key check). Two lights with different aperture
  counts, or the same count but different derived pane counts, **cannot** share a compiled
  material, full stop — no batching technique changes this.

Bucket key, concretely: `(animationType, falloffModel, animationQuality, windPresent,
apertureCount, apGoboCols, apGoboRows)`.

## 5. Rebuild-on-change, not cheap-array-mutation

Per the author's own direction after Finding A: **do not** rely on mutating a shared array and
expecting the GPU draw to pick it up. Instead, whenever any light in a bucket is added, removed,
or has any of its per-vertex-attribute values change, **rewrite that bucket's vertex buffer**
(plain typed-array `.set()` writes into the existing, reused `Float32Array` — never a new
allocation, matching this pool's own existing device-lost fix discipline,
`point-light-pool.js:735-754`) and flag `.needsUpdate = true`, exactly the mechanism the bench's
own scenario 2 already proved correct.

**This needs its own measurement, not an assumption.** A bucket rebuild is O(lights in bucket ×
vertices per light) CPU work, every frame that bucket has ANY dirty member. If one fast-animating
light (e.g. `candleFlicker`, which jitters every frame by design) shares a large bucket with many
static lights, the whole bucket rebuilds every frame regardless of the static members' own
stillness. Whether that's cheaper than today's 152-draws-of-5.886ms-CPU depends on real numbers
this document does not have yet — propose a bench scenario (extending `bench-point-lights.js`)
that measures rebuild cost at realistic bucket sizes (e.g. 20, 50, 100 lights) before committing
to a single-bucket-per-animation-type design. If large mixed-liveliness buckets prove expensive,
splitting "static this frame" from "dirty this frame" members into two sub-buffers (both still
one draw call, via one merged mesh with two `BufferAttribute` regions, similar to the
interior/boundary split S1a already built for coverage tiles) is a reasonable fallback — not
designed here, flagged as a fallback if measurement calls for it.

## 6. What does not batch cleanly

- **Aperture-lit lights fragment into many small buckets by construction** (§4) — a scene with
  varied window shapes near lights gets little draw-call reduction there regardless of technique.
  Recommend: measure how many of the real Mansion's active lights carry `apertureCount > 0`
  before deciding whether to batch them at all in v1, or leave them on today's per-light-mesh
  path indefinitely (their absolute count is likely small — apertures require a nearby
  `light:PROXIMITY` wall).
- **The two already-disabled shader terms** (`edgeSoftFactor`, coloration's `uShadows`) must
  stay disabled through this work. Building the data-texture infrastructure for edge points
  (§3) is reasonable prep, but flipping either term back on is a separate decision with its own
  live A/B verification — not a side effect of batching.
- **Per-light caches stay per-light.** `candleWallClipCache`/`lightningWallClipCache`/the
  re-triangulation dirty-check (`lastShapeX/Y/Radius/Points`,
  `point-light-pool.js:587-599`) all operate at the individual-light granularity today. A
  batched bucket needs an aggregating dirty-check (any member dirty → rebuild the bucket) layered
  on top, not a replacement for the existing per-light ones.
- **Draw ORDER within the accumulate pass.** MAX blending is commutative (already proven,
  bench scenario 2's `merge-order-does-not-matter`), so bucket draw order doesn't affect the
  illumination/coloration result. It has NOT been checked against the aperture shadow pass or
  any other consumer that might be order-sensitive — worth a specific check before assuming it
  generalizes.

## 7. Recommended build order

Mirrors Stage 1's own S1.1→S1.6 discipline: prove each piece in the lab against production-
faithful inputs, then wire behind a flag, then gate on a pixel-diff + bench measurement, in that
order, never skipping ahead to live wiring on an unproven piece.

1. **Census the real Mansion's lights** by bucket key (§4) — cheap, fast, answers "is this worth
   building" before any code. If most lights land in 1-2 large buckets (plausible: many static
   ambient lights + many candles), the ROI case is strong. If they're evenly spread across two
   dozen animation types in ones and twos, the payoff shrinks a lot and the scope should shrink
   with it.
2. **Bucket-key + grouping logic, CPU-only, Node-tested.** No rendering change. Verifies the key
   computation against real light snapshots.
3. **Bench: the simplest real bucket** (no animation, no aperture, `foundry` falloff) with the
   FULL uniform surface from §3's table (not just origin/radius) — colors, elevation, edge count/
   margin — proving the per-vertex-attribute techniqueSCALEs to the real data shape, still no
   `uniformArray`.
4. **Bench: the data-texture technique** for edge points, on a synthetic polygon, checked against
   the CPU-computed SDF the disabled `uniformArray` version was supposed to produce — infrastructure
   only, per §6, not a re-enable.
5. **Bench: rebuild-cost measurement** (§5) at realistic bucket sizes, on real device.
6. **Live wiring, flagged, one bucket shape at a time** — pixel-diff gate against today's
   per-light-mesh rendering (exact, per the Testament's own Stage 2 bullet), bench gate against
   P-004's proposed CPU/draw-count numbers, starting with whichever bucket the census (step 1)
   shows is largest.
7. **Extend to animated buckets**, ordered by the census, each animation type's seed function
   is a genuinely different shader graph and gets its own pixel-diff pass — do not assume torch
   working means chroma works.
8. **Apertures**: revisit after the above, scoped by what step 1's census shows; may reasonably
   stay out of v1 entirely.

## 8. Open questions for the author, before implementation starts

- Is aperture batching in scope for v1, or explicitly deferred (recommendation: defer, pending
  the census in step 1)?
- Given Finding B (the pre-existing disabled `edgeSoftFactor`), is re-investigating that bug now
  worthwhile on its own, given it's the same suspect family as Finding A and might share a root
  cause — or does it stay parked as a separate, lower-priority item?
- How much CPU rebuild cost (§5) is acceptable for a large mixed-liveliness bucket, before the
  split-buffer fallback becomes worth the extra complexity? A number to bench against, not a
  guess.
