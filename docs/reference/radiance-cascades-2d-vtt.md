# Radiance Cascades for a 2D Top-Down VTT Renderer (Three.js / WebGPU / TSL)

**Purpose:** Document-only external research into Radiance Cascades (RC) — a 2D/2.5D global-illumination technique — evaluated specifically against this project's own shape: Foundry's per-channel wall restriction types, painted map art, GM-authored point-light radii, multi-floor levels, and modest player hardware. **No design decisions are made in this document, and nothing here is scoped or scheduled.** Supplied by the author 2026-07-29 as an explicit **long-term / speculative** follow-up to the brief radiance-cascades mention in `docs/reference/webgpu-tsl-vtt-field-guide.md`. A "Status in this project" section is appended at the end, clearly marked as non-authorizing.

**Source of record:** A single external research pass (primary sources: the Osborne & Sannikov and Freeman/Sannikov/Margel papers on arXiv, the three.js/WebGPU ecosystem, Foundry VTT's own docs/module wikis, named open-source RC implementations). Treat anything not traceable to a primary source as directional, per the same standard this project already holds itself to.

---

## TL;DR
- **Radiance Cascades (RC) is an excellent fit for the *ambient/indirect/soft-shadow* layer of a top-down VTT, but you should adopt a HYBRID architecture:** compute crisp, GM-authored point-light radii and hard occlusion analytically per-light against your wall line-segments, and use RC for the soft, bounced, sky/ambient light that floods through doors and windows. Path of Exile 2 itself uses RC only for indirect/screen-space GI.
- **Windows (block-sight-not-light) fall out naturally** if you store a per-channel occluder field and accumulate *transmittance* along rays (`merge = radiance_near + transmittance_near · radiance_far`, identical to premultiplied-alpha compositing) rather than terminating on first hit — this is the core equation of the Osborne & Sannikov (2024) and Freeman/Sannikov/Margel (2025) papers.
- **The sun/moon "flooding indoors" effect is two separate problems:** (1) encoding an infinitely-distant directional source, which RC does elegantly by returning a direction-dependent *sky radiance* on ray-misses merged into the top cascade; and (2) the genuinely unsolved-in-pure-2D "light pool should be offset from the window by `wall_height / tan(sun_elevation)`" problem, which every 2.5D game fakes with a height property and a projected offset. Plan to fake it the same way.

## Key Findings

1. **RC's central insight (the penumbra hypothesis) is a resolution trade-off, not a lighting trick.** To resolve the light arriving at a point, you need *high spatial resolution close to occluders* but *high angular resolution far from them*, and these two requirements are inversely proportional. RC exploits this by storing a hierarchy of "cascades", each with 2× coarser probe spacing but 2× (or 4×) finer angular resolution, so every cascade costs roughly the same memory and the total is ~2× the base cascade. This is why cost is near-constant and independent of light count.
2. **The merge operation is compositing.** Each probe stores a *radiance interval* (radiance gathered over a limited distance range) plus a *transmittance*. Merging a near and far interval is `⟨r_n + t_n·r_f, t_n·t_f⟩` — mathematically identical to Porter–Duff "over". This single fact makes transmissive windows, coloured glass, and fog "free".
3. **The Holographic RC paper (arXiv 2505.02041, Freeman/Sannikov/Margel, submitted 4 May 2025) is the single most important source.** It is explicitly 2D, reformulates RC to remove redundancy and handle *hard shadows* and *small penumbras* (vanilla RC's worst weakness), and states verbatim: *"It runs at constant cost for a given scene size, taking 1.85 ms for a 512×512 pixel image and 7.67 ms for 1024×1024 on an RTX 3080 Laptop,"* improving *"the root mean squared error (RMSE) by 10× compared to naive path tracing with an equal number of samples."*
4. **For occluders that are already analytic line segments (this project's case), there is a genuine architectural choice.** The mainstream 2D-RC pipeline rasterises occluders and builds a signed distance field (SDF) via the Jump Flood Algorithm (JFA), then sphere-marches it. But because walls here are vector segments with *per-channel* flags, an analytic ray-vs-segment or BVH march avoids thin-wall leaking and lets light/sight/sound stay independent occluder sets cheaply.
5. **RC cost is famously independent of light count.** Sannikov states cascades *"encode radiance at a constant cost that is independent of scene complexity, number of light sources or polygons present in the scene,"* calculating lighting for **2, 10² (102), and 100² (1002) particles in the same ~12 ms**. Huge for a scene with 100+ torches — but it only holds for the *indirect/ambient* solve. Direct light from tiny bright emitters is exactly where RC is weakest (aliasing, flicker), reinforcing the hybrid recommendation.
6. **Multi-floor buildings are best handled as independent per-floor cascade stacks**, driven by elevation ranges a Levels/Wall-Height style system already stores, with optional cheap inter-floor coupling through explicit holes. There is no published "layered-2.5D RC" variant — this would be novel territory.

## Details

### PART 1 — Radiance Cascades theory, from first principles

**Where it came from.** Radiance Cascades was invented by **Alexander Sannikov** at Grinding Gear Games for *Path of Exile 2* and first presented at **ExileCon 2023**. It has since spawned an active research and hobbyist community and three key papers: Sannikov's original WIP paper (2023, the `Raikiri/RadianceCascadesPaper` repo); **Osborne & Sannikov, "Radiance Cascades: A Novel High-Resolution Formal Solution for Multidimensional Non-LTE Radiative Transfer," *RAS Techniques and Instruments* vol. 4, 2025 (arXiv 2408.14425, submitted 26 Aug 2024)** — the rigorous formulation introducing the penumbra-criterion maths and the *bilinear fix*; and **Freeman, Sannikov & Margel, arXiv 2505.02041 (2025)** — "Holographic Radiance Cascades", explicitly 2D. A 2026 follow-up, **"Split Radiance Cascades" (arXiv 2607.20384)**, extends RC to full 3D world-space using a sparse hashmap and "ray splitting" — not directly relevant here, but confirms the technique is still evolving fast.

**What RC actually is.** Strip away the lighting language and RC is *a data structure for representing a radiance field* — the incoming light from every direction at every point in an area — cheaply and without noise. It is not a ray tracer; it is a clever way to lay out and combine the results of many short rays.

**The penumbra hypothesis / penumbra criterion (the heart of it).** For a light source of width `w` at perpendicular distance `d` from a blocker, the penumbra has angular size `γ = 2·arctan(w / 2d)`, and at distance `h` from the blocker the penumbra's linear size is `H(h) = γ·h`. Two observations follow: the angle tolerated between adjacent rays must satisfy `Δω < w/D` (further away needs MORE rays); the spacing tolerated between adjacent probes grows with distance to the nearest object (further away needs FEWER probes). These are inverses of each other:
```
Δ_probe  ≲  D        (probe spacing may grow linearly with distance)
Δ_angle  ≲  1/D      (angular step must shrink with distance)
```
This is the entire justification for the cascade structure. m4xc's intuition: *"a wall is just a light source that emits no light, and a light source is just a wall that emits light"* — the criterion is about resolving *features* (occluders and emitters alike), not about lights specifically.

**The cascade hierarchy with worked numbers.** Cascade 0 has the densest probes and fewest rays each; each higher cascade halves probe density per axis (¼ the probes) and quadruples ray count, starting its ray interval further out (the GM Shaders "4× branching" scheme): Cascade 0: 16×16=256 probes, 64 rays each. Cascade 1: 8×8=64 probes, 256 rays each. Cascade 2: 4×4=16 probes, 1024 rays each. Cascade 3: 2×2=4 probes, 4096 rays each. Each cascade stores roughly the same number of ray values (probes × rays ≈ constant). Sannikov's paper notes the memory to store arbitrarily many cascades in 2D is *less than twice* cascade 0's memory. A **2× branching** scheme (kornelski's Bevy implementation, the HRC paper) doubles rays and halves probes per axis per step instead — cheaper per cascade but total interval count grows linearly with cascade count rather than staying flat.

**Ray intervals and near/far merging.** Each cascade only marches a limited distance range (its interval). A probe's interval stores the radiance it gathered plus a visibility/transmittance term (1 = ray hit nothing, 0 = fully blocked). Reconstructing a full ray merges intervals from cascade 0 upward: near radiance, then far radiance attenuated by near visibility. Cascades needed ≈ `ceil(log_base(diagonal)) + 1` — ~5-6 at base 4 for a 512px diagonal.

**Merging: bilinear interpolation, ringing and the "bilinear fix".** A cascade-`n` probe sits between four cascade-`n+1` probes; naïvely interpolating those four *first* and then merging biases the result and produces **ringing** — visible rings around bright sources in dark space (Osborne & Sannikov measure ~10% worst-case error). The **bilinear fix** (2024) reverses the order: cast 4 rays, one toward each bilinear parent probe, merge each with its own parent, *then* interpolate — continuous, and "also addresses potential issues related to light leaking through an occluder that is too small". Variants: **Bilinear-fix** (4 rays, best quality, ~2× cost), **Nearest-fix** (1 ray, cheap but pixelated), **Nearest-interlaced** (dithered compromise), kornelski's alternative "gear fix".

**Known artefacts and mitigations:**
- **Ringing** around bright small sources → bilinear fix, sRGB/linear correctness, non-linear accumulation.
- **Light leaking through thin walls** → the penumbra criterion being violated; mitigate with interval overlap between cascades, clamped merge sample coordinates, and analytic segment intersection instead of a lossy rasterised SDF.
- **Small-penumbra / small bright emitter errors** → *"Checkerboard patterns … and Moiré-like aliasing appear with light sources smaller than ~8× the base probe resolution"* (Emergent Mind's HRC review). HRC is the published fix.
- **Sharp shadows** → vanilla RC "is notoriously bad at representing very sharp shadows"; HRC improves hard-shadow handling.

### PART 2 — 2D ("Flatland") implementation specifics

**Canonical learning path:** SimonDev's video → jason.today's two interactive posts (built in **Three.js** — closest to this project's stack) → m4xc's "Fundamentals" → the papers. jason.today walks through raymarching a JFA distance field, codifies the penumbra hypothesis into a near/few-rays pass and a far/many-rays pass, generalises to N cascades, packs directions into texture quadrants, uses hardware bilinear filtering to upscale, and clamps merge offsets to avoid edge leaks.

**Texture layout and memory.** **Probe-major** (a probe's rays contiguous) vs **direction-major** (all rays of the same direction stored together — better data locality, enables hardware bilinear filtering across probes; superior). Format: **rgba16f** standard (radiance rgb, transmittance/visibility alpha). 4×-scheme total VRAM ≈ 2× cascade 0 — for 1024×1024 rgba16f that's ~8MB per cascade-0-equivalent, ~16MB total. Trivial. (Some implementers render at half resolution, `rcScale=2`, to halve this further.)

**The raymarch step — the most important implementation decision, and this project's situation (analytic line segments with per-channel flags) is unusual and advantageous:**
- **(a) SDF via JFA + sphere marching** — the default in almost every tutorial. Fast, GPU-friendly, but requires rasterising vector walls first, only stores distance-to-nearest (hard to encode "blocks light but not sight" without a separate SDF per channel), and can miss thin walls between texels.
- **(b) Analytic ray-vs-segment intersection** — precise, no thin-wall leaking, exact corners. Cost grows with segment count unless accelerated. This is what a VTT already does on the CPU for vision.
- **(c) DDA / grid traversal** — simple, reintroduces rasterisation error.
- **(d) BVH over the segments** — the acceleration structure for (b); `three-rc` uses `three-mesh-bvh` for exactly this.
- **(e) Mip-chain / hierarchical occupancy** — march coarser mips for longer far intervals.

**Recommendation from the source report:** a **hybrid raymarch** — a per-channel SDF (light-occluders only) via JFA for the fast approximate far-field GI march (cascades 2+), and **analytic segment intersection** for cascade-0/1 and direct-light visibility, where thin-wall correctness and per-channel flags matter. HRC goes further and abandons ray *tracing* entirely, approximating long rays by combining short precomputed ray intervals in an acceleration structure — performance independent of scene complexity.

**Reported performance.** HRC: 1.85ms (512²) / 7.67ms (1024²) on RTX 3080 Laptop. Sannikov's original demo: 0.3ms/frame on a GTX 970 (no denoising/temporal accumulation, rebuilt from scratch every frame) and ~12ms regardless of particle count. These are bare GI-solve numbers — scene render, blur, and compositing add on top.

**Open-source repos to study (mind the licences):** `CodyJasonBennett/three-rc` (Three.js + three-mesh-bvh, **deliberately unlicensed** — embeds an unlicensable depth-aware upscaler; read for structure, don't copy); tmpvar's flatland-2d WebGPU playground (readable WebGPU/WGSL reference); `Yaazarai/GMShaders-Radiance-Cascades` (best memory-layout/fix-variant explanation); `kornelski/bevy_flatland_radiance_cascades` (Rust/WGSL, direction-first + 2× scaling + "gear fix"); `entropylost/amida` (Rust/CUDA, bilinear fix + volumetrics, NVIDIA-only); `@typegpu/radiance-cascades` (WebGPU TypeScript runner, closest to drop-in); `fad`'s Shadertoy `mtlBzX` (the origin 2D implementation everyone forks, includes the sky integral).

### PART 3 — Transmissive / partial occluders (WINDOWS)

This is where RC shines, because **the merge equation already composites transmittance**. Instead of terminating a ray on first hit, transmittance accumulates multiplicatively (Beer-Lambert): `L = Σ (transmittance_so_far · emission_here)`, and interval merge is:
```
Merge(⟨r_n, t_n⟩, ⟨r_f, t_f⟩) = ⟨ r_n + t_n·r_f ,  t_n·t_f ⟩
```
The HRC paper states this "is identical to the formulas for premultiplied alpha blending, where the transmittance is `1 − α`" (Porter & Duff 1984). So a **window is just an occluder with transmittance between 0 and 1**. A ray passing through is attenuated but not stopped.

- **Coloured/stained glass** → store transmittance as an rgb triple, not a scalar. Merge is component-wise.
- **Wall that blocks SIGHT but not LIGHT** → a *channel-separation* problem, not an RC problem. Foundry defines `WALL_RESTRICTION_TYPES` as `["light", "sight", "sound", "move"]`, each independently *None, Normal, Limited, Proximity,* or *Reverse Proximity* (Proximity walls *"such as Window Walls"* pass light/vision/sound only within a threshold distance). The GI solve only cares about the **light** channel — a window with `light: None` (or partial transmittance for frosted glass) doesn't occlude the radiance march at all, while `sight: Normal` blocks vision in a completely separate pass that never touches RC. **Do not try to make one field serve all channels** — maintain separate occluder representations per channel that needs propagation (realistically only light, maybe sound).
- **Anisotropic/directional transmission** (shuttered/louvred windows) → since every RC ray has a known direction, `t(θ) = base_t · max(0, cos(θ - window_normal))^k` at the intersection — natural because intervals already carry direction.
- **Participating media / fog / volumetrics** → the same transmittance machinery gives volumetric fog for free: a small per-texel attenuation coefficient, integrated by RC. Torch-lit smoke, mist, coloured gas clouds come along for the ride.

### PART 4 — Exterior / directional lighting (SUN & MOON) flooding indoors

**Two distinct sub-problems, solved separately.**

**4a. Encoding an infinitely-distant directional source (well-solved).** An at-infinity source is encoded through *ray misses*: when a top-cascade ray reaches its interval end unoccluded, instead of black it returns a **sky-radiance** value as a function of the ray's direction: `sky(ω)`. The sun/moon is a sharp peak in that function. Because a directional source has no spatial variation, only angular variation, it belongs in the cascade with the **highest angular resolution** — the top cascade: *"You can integrate a skybox into RC by merging the sky integral into the highest angular resolution cascade… This does not affect occlusion either so it really does act like an actual skybox!"* (GM Shaders). A working reference (`Hybrid46/RadianceCascade2DGlobalIllumination`) exposes `_SkyRadiance, _SkyColor, _SunColor, _SunAngle`, added only for the top cascade. Because the sun doesn't affect occlusion, it correctly casts through openings — a probe indoors whose upward rays are all blocked sees no sun; a probe near a doorway whose ray escapes sees full sun.
```glsl
// pseudo-TSL, evaluated only when a top-cascade ray reaches its interval end unoccluded
vec3 skyRadiance(vec2 dir) {
    float sun = pow(max(0.0, dot(dir, sunDir)), sunSharpness); // sharp disc
    return skyColor * skyIntensity + sunColor * sunIntensity * sun;
}
```
The width of the doorway is the "light source width" `w`; depth into the room is `h`; the pool softens with `H(h) = γ·h` — RC reconstructs this automatically through cascade merging (sharp near the doorway, soft deeper in).

**4b. The 2.5D window-offset problem (genuinely unsolved in pure 2D — flag this clearly).** A pure flatland RC has no notion of wall height, so sunlight through a window appears exactly at the opening, not offset onto the floor along the sun's azimuth. In reality a 2m-high window at 30° sun elevation throws its pool `2 / tan(30°) ≈ 3.5m` into the room. No published RC variant solves this — it's fundamentally 3D information flatland discards. **Every 2.5D game fakes it:**
- Give each wall/window a `wall_height` property.
- Offset the emitter/aperture by `offset = wall_height / tan(sun_elevation)` along the azimuth (the far side of the opening from the sun). Reference points: at **45° elevation, offset = height**; at **30°, ≈1.7× height**; at **20°, ≈2.75× height**; toward **90° (noon), offset → 0**; toward the horizon, stretches to infinity.
- **Two shipped parameterisations to copy:** Matt Greer's 2012 top-down shadow shader (height map + sun `xyAngle`/`zAngle`, marching from each pixel toward the sun comparing heights); a Godot top-down shadow shader (`shadowAngle`, `wallHeight`, `floorStart`, `shadowOffset`, projecting via `floorCorner - ((floorDifference/direction)/wallHeight)`). Both adapt directly: project the *window aperture* as a displaced emissive slit (instead of a wall's shadow), then feed that displaced slit into RC as the light source.
- **Pragmatic implementation:** inject a synthetic emissive rectangle onto the floor at the offset position for each sunlit window (a "light pool decal"), coloured/tinted by the window's transmittance, and let RC treat it as an area emitter. Keeps RC pure flatland while giving the correct visual offset.

**Determining indoor vs outdoor.** Options: native "roof tile" mechanisms (an enclosure test using the roof image's own alpha as an outdoor-sky-visibility multiplier); flood fill from map edges through light-occluder walls (reachable from the boundary = outdoor); or — the elegant RC-native answer — **no explicit mask needed at all** if the roof itself is modelled as a light-occluder covering the interior: sky rays simply can't reach indoor probes except through openings, and the dimming is automatic and physically correct.

**Day/night cycle is free.** Because RC is recomputed from scratch every frame (no temporal accumulation), animating the sun costs nothing extra beyond changing `sunDir`/`sunColor`/`sunIntensity` uniforms — no static structure rebuild. Moonlight is the same function, dim/blue-shifted.

### PART 5 — Point lights in Radiance Cascades

**How emissive sources are injected.** Lights are not explicit objects with radii; they're **emissive texels in a scene-radiance texture** that rays sample when they hit something. This is why cost is independent of light count — rays don't iterate a light list, they sample whatever emission they hit.

**The small/bright emitter problem (RC's Achilles' heel, directly relevant to a VTT's candles and torches).** Cascade 0's limited angular resolution and probe spacing mean a candle flame a few pixels across can fall between probe rays — flicker, aliasing, temporal instability as light/camera move. HRC formalises the failure threshold; Emergent Mind's review: *"checkerboard patterns … and Moiré-like aliasing appear with light sources smaller than ~8× the base probe resolution."* Mitigations: minimum emitter radius (never smaller than ~8× cascade-0 spacing — simplest, most effective); Holographic RC itself (adjusts probe positions to keep spatial resolution perpendicular to the gathering direction, specifically for small penumbras); supersampling cascade 0 / conservative rasterisation / analytic light injection; the bilinear fix. **For a VTT specifically: don't use RC for the crisp core of a point light at all** — see the hybrid below.

**The hybrid architecture question — the single most important decision.** Practitioners overwhelmingly split lighting into **direct** (analytic per-light, explicit shadow/visibility test) and **indirect/ambient** (RC). *Path of Exile 2 itself uses RC for indirect/screen-space GI only.* Arguments for hybrid: a VTT needs crisp, precise, GM-controllable light radii — the dim/bright radius of an authored light must be exact and stable, not softened or flickering. Analytic direct lighting gives pixel-perfect radii and hard/soft shadow edges against wall segments (already ray-tested for vision), while RC adds only the ambient/bounce/sky layer on top — and sidesteps small-emitter aliasing entirely, since the candle's crisp core is analytic and RC only handles its soft spill.

**Mapping an authored light model onto RC.** Authored lights (dim radius, bright radius, colour, alpha/intensity, attenuation, animation) are *artistic*, not physical — a physical inverse-square falloff won't match an authored 40ft-bright/80ft-dim torch. **Bake the authored falloff into the emitter's radiance profile:** construct the emission texture from the authored curve, let RC propagate *that* profile. The direct pass reproduces the authored radii exactly; RC receives a physically-plausible but artist-shaped emitter so its bounce looks right without overriding intent. Expose a blend from 0 (pure authored) to full RC contribution.

**Number of lights, animation, colour, HDR.** RC's indirect solve is light-count-independent — decisive once light count exceeds ~100, where forward/clustered lighting cost scales with count × pixels; the analytic *direct* pass still scales with count, so cull it to viewport and let RC carry off-screen/bounced contribution. Animated/flickering torches are stable and cheap since RC is single-shot and noiseless (no temporal accumulation, no ghosting) — a real advantage over noisy stochastic GI for flickering firelight. Work in linear space, rgba16f (rgba32f only if very bright values band), tonemap at the end.

### PART 6 — Multi-floor / layered buildings

The clean architecture is **one independent RC stack per active floor**, fed only the walls/tiles/lights whose elevation range overlaps that floor (an elevation-range system already provides this data). Memory is N× a single stack (~16MB each at 1024² — 3 floors ≈ 48MB, fine); typically only 1-2 floors render at once. **Light between floors** (open staircases, holes) isn't handled by any published RC variant — fake it by injecting, into floor N's emission texture, a dimmed copy of floor N+1's resolved radiance sampled through the hole's footprint (and vice versa). Treat each hole as a portal copying radiance between the two stacks' emission inputs — an approximation (single-bounce coupling) but convincing. **No "layered-2.5D RC" exists in the literature** — this would be novel territory; the per-floor-stack + portal-coupling approach is the pragmatic path.

### PART 7 — Large maps, camera movement, practical scaling

**Screen-space vs world-space cascades.** PoE2 uses screen-space (motivated by its fixed camera). For a freely panning/zooming camera: **screen-space** is simplest (recomputed every frame anyway; the risk is off-screen light spill, solved with an off-screen margin sized to the largest cascade's interval, typically ~25-50% of viewport); **world-space** allows caching the solve for static lights/walls, attractive for mostly-static maps, but zoom breaks fixed probe density (needs re-anchoring, effectively rebuilding on zoom — fine since zoom is occasional). **Recommendation:** screen-space (+margin) for dynamic light; optionally a world-space cached **static bake** (map walls + static lights + sun at a given time) blended with a small dynamic screen-space solve for moving tokens/torches — this "static bake + dynamic delta" split is the practical way to hit frame budget on weak hardware.

**Very large maps.** Never solve RC over the whole map — only the visible viewport + margin at working resolution, regardless of map size. Cascade count is set by viewport diagonal, not map diagonal, so cost is bounded by screen resolution.

**Frame budget on integrated GPUs (critical for a VTT's actual player hardware).** HRC's 7.67ms at 1024² is on a discrete RTX 3080 Laptop; an integrated GPU could be 5-15× slower, potentially blowing a 16ms (60fps) or even 33ms (30fps) budget. Mitigations: half-resolution RC + upscale (4× cheaper); 2× branching instead of 4×; fewer cascades; compute over 2 frames (alternate cascades on alternate frames); lean on the static bake so per-frame cost is only the dynamic delta. Realistic target: ~4-8ms of RC at half-res on a mid iGPU, with a quality slider.

### PART 8 — Implementation in Three.js / WebGPU / TSL

RC's merge and raymarch are per-texel and embarrassingly parallel; both fullscreen-fragment-pass (ping-pong render targets, simplest, matches jason.today's Three.js tutorial) and compute-shader (storage textures, better for direction-first layouts and workgroup-local merging) models work. Recommendation: start with fragment ping-pong in TSL (easiest to debug), move the hot merge/march to compute with `storageTexture` once correct — verify current TSL storage-texture support in whatever three.js version is current at the time.

```
// Per frame:
1. Draw scene emission + per-channel occluder alpha  → sceneTex (rgba16f)
2. JFA passes on light-occluders                     → sdfTex  (rg16f, nearest-seed → distance)
3. for cascade i = N-1 downto 0:            // top → bottom
      dispatch/draw cascadeMerge(i):
        for each texel (a probe direction):
          dir     = directionFromTexel(texel, cascadeParams[i])
          <r,t>   = raymarch(probePos, dir, interval[i], sdfTex, sceneTex)
          if i == N-1: r += skyRadiance(dir) * t   // sun/sky in top cascade
          if i <  N-1: <r,t> = Merge(<r,t>, bilinearSampleParent(i+1, probePos, dir))
        store <r,t> → cascadeTex[i]
4. Resolve cascade 0 → per-pixel fluence (average directions) → giTex
5. Composite: finalColor = albedo * (directLightPass + giTex)   // hybrid
```
```glsl
// merge (premultiplied-alpha compositing):
vec4 Merge(vec4 near, vec4 far) {   // rgb = radiance, a = transmittance
    return vec4(near.rgb + near.a * far.rgb, near.a * far.a);
}
// transmissive raymarch against a density/occluder field:
vec4 raymarch(vec2 p, vec2 dir, vec2 interval) {
    vec3 rad = vec3(0.0); float tr = 1.0;
    float d  = interval.x; p += dir * d;
    for (int s = 0; s < MAX_STEPS && d < interval.y; s++) {
        float occ = sampleLightOccluder(p);     // 0 = clear, 1 = opaque, (0,1) = window/glass
        vec3  em  = sampleEmission(p);           // torches, sunlit pools, glowing tokens
        rad += tr * em;
        tr  *= (1.0 - occ);                      // Beer-Lambert transmittance
        if (tr < 0.001) break;
        float step = max(sampleSDF(p), MIN_STEP);
        p += dir * step; d += step;
    }
    return vec4(rad, tr);
}
```
Precision: rgba16f everywhere for cascades/scene radiance; rg16f for the SDF (scale distances to fit range); rgba32f only if HDR emitters band. sRGB↔linear conversion on read/write, as always.

### PART 9 — Alternatives & honest comparison

| Approach | Soft GI/bounce | 100+ lights cheaply | Crisp authored radii | Transmissive windows | iGPU-friendly | Fit |
|---|---|---|---|---|---|---|
| **RC (indirect) + analytic direct (hybrid)** | excellent | yes (indirect) | yes (direct pass) | native | tunable | **Best overall** |
| **Pure RC for everything** | yes | yes | flickers on tiny lights | yes | tunable | Good but risky for crisp radii |
| **Analytic shadow-casting + ambient** (Unity 2D URP style) | no bounce | scales with lights | yes | manual | yes | Solid, cheaper, less pretty |
| **2D radiosity / LPV** | partial | partial | no | partial | partial | Older, noisier or blurrier |
| **Screen-space GI (SSGI)** | misses off-screen | yes | no | partial | partial | Off-screen spill problems |
| **Ray-marched SDF direct only** | no | partial | yes | yes | yes | Cheapest; what most VTTs do today |
| **Baked lightmaps** | static only | yes | yes | yes | yes | No dynamic lights/day-night |

**When RC is overkill or a poor fit — say it plainly:** if maps are already hand-painted with baked lighting (shadows/highlights painted in), layering dynamic GI on top double-lights the scene — the **painted-lighting vs dynamic-lighting conflict**, and it is real. If players are on weak integrated GPUs and ~4-8ms isn't affordable, analytic shadow-cast + soft ambient (what most VTT lighting does today) may deliver 80% of the look for 20% of the cost.

**Resolving the painted-lighting conflict, in order of effort:** (1) use painted art as albedo only, let dynamic light do all lighting — ideal but demands new "flat" art; (2) de-light/albedo extraction — estimate and subtract baked lighting (standard in photogrammetry; hard to do perfectly on stylised art); (3) **blend factor** — treat painted art as an "ambient base" and add only a fraction of dynamic GI on top via a slider, so most maps keep their painted character and get a dynamic overlay, author's choice how far to push it. **The pragmatic recommendation.**

---

## Recommendations (as given by the source report — not a plan of record)

- **Stage 0 — Prototype the core.** Port jason.today's Three.js RC approach into a WebGPU/TSL pipeline as fullscreen fragment passes, ping-pong rgba16f targets. One floor, a few emissive-disc point lights, JFA-SDF raymarching. Verify the merge equation and linear-space correctness. Benchmark on a mid integrated GPU immediately — decides everything downstream.
- **Stage 1 — Go hybrid.** Split into an analytic direct pass (per-light, radii from the authored dim/bright model, visibility against wall segments) and an RC indirect/ambient pass. Composite `albedo × (direct + RC)` with a blend slider.
- **Stage 2 — Windows and channels.** Build occluder fields from the light-restriction flag only. Give windows a transmittance (per-channel rgb for stained glass). Confirm sight stays blocked in a separate vision pass while light floods through.
- **Stage 3 — Sun/moon.** Add `skyRadiance(dir)` in the top cascade; verify indoor probes go dark, doorway probes flood. Implement the 2.5D offset fake: per-wall height, displaced emissive light-pool slits at `offset = height / tan(sun_elevation)` along the azimuth. Prototype both the offset-diagonal and a subtler vertical-beam look. Drive day/night purely by uniforms.
- **Stage 4 — Scale and floors.** Screen-space + margin for dynamic light; a world-space static bake blended with a dynamic delta. One RC stack per active floor from elevation ranges; portal-couple through holes if needed. Quality slider (resolution scale, branching factor, cascade count, 2-frame spreading).
- **Stage 5 — Reconcile with painted art.** Ship a blend slider between painted-ambient and full dynamic GI; document that flat-lit maps get the best dynamic results; optional de-lighting for legacy maps.

**Thresholds that would change the plan:** if Stage 0 can't hit ~8ms at half-res on the target iGPU, drop pure-per-frame RC and commit hard to the static bake, or fall back to analytic-direct + soft ambient entirely. If small-emitter flicker survives the hybrid split, implement Holographic RC instead of vanilla RC and enforce the ≥8× base-probe minimum emitter size. If direct-pass light count becomes the bottleneck, cull to viewport and push more into RC.

## Caveats

- **The 2.5D window-offset problem is genuinely unsolved in pure 2D RC.** No paper or repo does it — it would be faked with a height property and a projected offset, art-directed rather than physical.
- **RC gives soft, physically-plausible light, not author-precise control — hence the hybrid.** Don't expect vanilla RC alone to reproduce a crisp authored torch radius without flicker.
- **Quoted timings (HRC 1.85/7.67ms; original 0.3ms on GTX 970; ~12ms regardless of particle count) are discrete-GPU, bare-solve numbers.** Integrated-GPU, full-pipeline reality will be materially slower — benchmark early and often, if ever attempted.
- **Several key repos are deliberately unlicensed** (`three-rc`, because of an unlicensable upscaler) — study for understanding, don't copy into a product without checking licences. The papers' equations are free to implement.
- **Some sources are secondary or community-reported** (forum/Discord claims) rather than primary papers/docs — treat as strong hints, not specifications.
- **RC is a fast-moving target** — between the 2023 talk, the 2024/2025 papers, and 2026's 3D "Split RC" work, best practices are still shifting.

## Curated reading list (recommended order)

1. SimonDev, "Exploring a New Approach to Realistic Lighting: Radiance Cascades" (YouTube) — gentlest visual intro.
2. jason.today — Part 1 (`/gi`) and Part 2 (`/rc`) — interactive, built in Three.js, closest to this stack.
3. m4xc.dev, "Fundamentals of Radiance Cascades" — best diagrams/intuition for the penumbra criterion.
4. radiance.wiki — community hub, curated links, fix/variant taxonomy.
5. Freeman, Sannikov & Margel, "Holographic Radiance Cascades for 2D Global Illumination", arXiv 2505.02041 (2025) — highest-priority paper.
6. Osborne & Sannikov, *RAS Techniques and Instruments* vol. 4, 2025 (arXiv 2408.14425, 2024) — penumbra-criterion maths, bilinear fix.
7. Sannikov (2023, `Raikiri/RadianceCascadesPaper`) — the original; PoE2 context.
8. (optional, 3D) "Split Radiance Cascades", arXiv 2607.20384 (2026) — where the technique is heading.
9. tmpvar flatland-2d WebGPU playground — readable WebGPU/WGSL reference.
10. `@typegpu/radiance-cascades` — WebGPU TypeScript runner, 2D RC in UV space.
11. `CodyJasonBennett/three-rc` — Three.js + three-mesh-bvh; unlicensed, structure only.
12. `Yaazarai/GMShaders-Radiance-Cascades` + the GM Shaders articles — memory layouts, fix variants, sky integral.
13. `kornelski/bevy_flatland_radiance_cascades` — Rust/WGSL, direction-first, 2× branching, "gear fix".
14. `fad`'s Shadertoy `mtlBzX` and "2D Volumetric Radiance Cascades" `wfyyDz` — origin implementation + volumetrics.
15. Matt Greer, "Dynamic Lighting and Shadows In My 2D Game" (2012, mattgreer.dev) — height-map + azimuth/elevation sun march.
16. Godot Shaders, "2D Top-Down Shadows (Tilemap Ready)" (WizardWand123) — shipped shadowAngle/wallHeight/floorStart/shadowOffset parameterisation.
17. Foundry VTT docs — Walls/Tiles, Wall Height & Levels module wikis — authoritative for per-channel flags and elevation.
18. Graphics Programming Discord — "Radiance Cascades" thread, and the dedicated RC Discord (linked from radiance.wiki).

---

## Status in this project — 🔮 LONG-TERM CONSIDERATION, NOT SCOPED

Added 2026-07-29 at the author's explicit request: *"it sounds too experimental to use much of at the moment... add this as potential future material and/or something that we might try to use some limited parts of. Not for worrying about today, but for consideration long term."* **Nothing in this document authorizes starting work.** Full cross-references and the project-specific analysis live in the memory file `keyhole-radiance-cascades-future.md` — read there first for what, if anything, is worth doing early.
