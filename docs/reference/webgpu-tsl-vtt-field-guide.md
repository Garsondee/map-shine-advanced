# WebGPU/TSL for a Top-Down VTT Renderer — External Field Guide (mid-2026)

**Purpose:** Document-only external research into the state of Three.js `WebGPURenderer` + TSL, the GPU techniques it newly unlocks (compute shaders, tiled lighting, JFA/SDF shadows, radiance-cascade global illumination), and how a PIXI-based host like Foundry VTT can be overlaid rather than replaced. **No design decisions are made in this document** — it exists so that whoever next touches `Shaders.md`, `Water.md`, `Particles.md`, `Forward+.md`, `Sun-Shadows.md` or `Performance.md` doesn't have to rediscover any of this from scratch. Supplied by the author 2026-07-29. Tie-backs to this project's own locked decisions and in-flight work are called out explicitly at the end, clearly marked as _things to consider_, not changes made.

**Source of record:** A single external research pass (primary sources: threejs.org docs, the three.js GitHub repo/issues, Foundry VTT release notes, browser-vendor blogs, arXiv papers), delivered as a finished report rather than raw agent output. The report's own caveats section flags that marketing/AI-generated secondary sources overstate maturity and that TSL's API is a moving target — treat anything not traceable to a primary source as directional, not verified.

---

## TL;DR

- **The timing is right and the platform is mature enough.** As of mid-2026, Three.js `WebGPURenderer` (stable r184, 16 Apr 2026; r185, 1 Jul 2026) is a ground-up WebGPU renderer with automatic WebGL2 fallback, and WebGPU is Baseline across Chrome/Edge (since Chromium 113, 2023), Firefox 141 on Windows (22 Jul 2025) and Safari 26 (Sept 2025). Foundry V13's desktop client bundles Electron 34.2.0 / Chromium 132 — comfortably past the WebGPU threshold. The main risks are TSL's still-churning API and Linux/Electron driver caveats, not fundamental capability.
- **A top-down VTT is an almost ideal target for the newest GPU techniques.** Because the scene is flat and orthographic, techniques prohibitively expensive in full 3D become viable: 2D global illumination via **radiance cascades**, **jump-flood** SDFs for soft shadows and fog-of-war, **clustered/tiled lighting** for hundreds of torches, and **compute-shader** particle/water/weather systems.
- **Architecturally, overlay rather than replace, driven by the host's data with incremental updates.** PIXI and Three.js cannot share a live GPU context robustly (and cannot at all across WebGL↔WebGPU), so the pragmatic path is a second transform-synchronised canvas fed by host hooks. There is no published prior art for exactly this Three.js-overlay technique — theripper93's Babylon.js-based *3D Canvas* (verified through Foundry V14) is the closest analogue, and it takes over the view rather than overlaying it.

## Key Findings

1. **`WebGPURenderer` is now the primary focus of Three.js development**, with `WebGLRenderer` in maintenance mode. Imported from `three/webgpu`; TSL from `three/tsl`. New node-based material system, TSL-based post-processing stack with built-in MRT, native compute. Still officially "experimental" but greatly matured.
2. **TSL is the correct abstraction layer.** Author shaders once in JavaScript, transpiling to WGSL (WebGPU) or GLSL ES 3.0 (WebGL2 fallback), with automatic optimisation. Raw WGSL escape hatch via `wgslFn()`.
3. **Compute shaders are the single biggest new capability.** Storage buffers, storage textures, atomics, workgroup memory unlock GPU-driven particles, fluid/wave simulation, jump-flood SDFs, fog-of-war accumulation, and radiance-cascade GI — none comfortable in WebGL2.
4. **Three.js already ships tiled and clustered lighting for WebGPU**, directly relevant to a map with many light sources.
5. **The 2D lighting/GI research frontier (radiance cascades) is highly mature and directly portable**, with multiple open-source Three.js/WebGPU implementations to study.
6. **For host-VTT integration, the building blocks all exist** (pan/zoom hooks, stage transform, PIXI↔Three interop guidance) but nobody has published this exact overlay technique.

## Details

### 1. Current state of Three.js WebGPU + TSL (mid-2026)

**Version and status.** Since ~r171 the WebGPU path became usable "out of the box" — a one-line import swap (`import * as THREE from 'three/webgpu'`) with automatic WebGL2 fallback. The official manual still flags the renderer as experimental and notes some scenes will see better performance or more complete features on `WebGLRenderer`. Pin a specific version and budget upgrades as scheduled work — TSL imports have already migrated (`three/nodes` → `three/tsl`) and functions renamed (`timerGlobal` → `time`).

Not supported from `WebGLRenderer` and must be rewritten in TSL: `ShaderMaterial`/`RawShaderMaterial` + `onBeforeCompile()`; `EffectComposer` (replaced by the `PostProcessing`/`RenderPipeline` TSL stack, renamed in r183, identical API).

**Why WebGPU helps a VTT specifically.** The binding model dramatically reduces CPU-side draw-call overhead and exposes compute shaders + explicit resource management. For a map with many lights/tokens/tiles/effects, CPU overhead reduction and compute access are the wins, not raw fill rate.

**Initialisation gotcha.** WebGPU initialises asynchronously. Use `renderer.setAnimationLoop(render)` (waits automatically) or `await renderer.init()` before a manual `requestAnimationFrame` loop.

**TSL fundamentals.** A node graph — compose small nodes (`float`, `vec3`, `sin`, `dot`, `mix`, `texture`, `uv`, `positionLocal`, `normalLocal`, `time`) and assign the result to a material slot.
- `Fn(() => {…})` defines a reusable shader function (vertex/fragment/compute).
- `uniform('float')` / `uniform(color())` are true GPU-side variables updated per-frame from JS.
- `attribute()` reads per-vertex data; `varying()` interpolates vertex→fragment.
- `storage(bufferAttribute, 'vec3', count)` / `instancedArray(count, 'vec3')` create persistent GPU buffers for compute.
- `struct()` builds custom types; `.toVar()` forces a mutable temporary; `.toConst()` a constant.
- Control flow: `If(cond, () => {…})`, `Loop({start, end, condition:'<'}, ({i}) => {…})`, `Switch`. Ordinary JS `if`/`for` runs at graph-build time (unrolled); `If`/`Loop` emit real GPU control flow.
- `wgslFn(\`…\`)` embeds raw WGSL; `code()` splits reusable WGSL fragments (entrypoints must be `wgslFn`). Sharp edge: storage buffers/samplers into `wgslFn` are awkward/partly unsupported (three.js issues #29401, #32969).

**A subtle TSL correctness note:** since ~r165 TSL auto-tracks node usage and inserts temporaries, so `toVar()` is often unneeded. But a node computed **outside** a `Loop` and reused **inside** it is **not** automatically cached (issue #31636) — silently recomputes every iteration. In hot loops, add `.toVar()` explicitly when in doubt.

**NodeMaterial slots** — the core customisation surface. Each built-in node material (`MeshBasicNodeMaterial`, `MeshStandardNodeMaterial`, `SpriteNodeMaterial`, etc.) exposes overridable slots: `colorNode` (albedo), `emissiveNode` (emission, drives bloom), `normalNode` (perturbed normal — where 2D normal-map lighting lives), `positionNode` (vertex displacement), `roughnessNode`/`metalnessNode`/`aoNode` (PBR inputs), `opacityNode`/`alphaTestNode`, `outputNode` (post-lighting final fragment), `depthNode`, `mrtNode` (multiple render targets), `fragmentNode`/`vertexNode` (full stage override). The core skill: inject TSL into the specific stage of the standard PBR pipeline you want to change, and let Three.js do the surrounding lighting maths.

**Documentation and debugging.** Official: TSL Specification page, TSL-Spec wiki, WebGPURenderer manual, `webgpu_*` examples. The **TSL Editor** and **TSL Transpiler** examples inspect generated WGSL/GLSL live and convert GLSL→TSL (imperfectly). A new **Inspector** addon (`three/addons/inspector/Inspector.js`) appears in recent examples for node-graph/devtools debugging. Third-party: sbcode.net TSL tutorials, Nik Lever's TSL series, Maxime Heckel's "Field Guide to TSL and WebGPU," the Three.js Roadmap blog, Wawa Sensei's R3F+TSL course, Pavel Boytchev's TSL-Textures library.

### 2. WebGPU-specific capabilities that unlock new techniques

**Compute shaders.** Dispatch many threads running the same `Fn`, distinguished by `instanceIndex`, batched into workgroups (typically 64/128) sharing on-chip memory with barrier sync:
```js
import { Fn, instancedArray, instanceIndex, deltaTime } from 'three/tsl';
const count = 1_000_000;
const positions = instancedArray(count, 'vec3');
const velocities = instancedArray(count, 'vec3');
const update = Fn(() => {
  const p = positions.element(instanceIndex);
  const v = velocities.element(instanceIndex);
  p.addAssign(v.mul(deltaTime));
})().compute(count);
renderer.compute(update); // or await renderer.computeAsync(update)
```
Key principle: **data stays on the GPU** — no CPU download of particle positions; dispatch compute then render from the same buffers as vertex attributes. Eliminates the CPU↔GPU transfer that caps WebGL particle systems (~50k) and lets WebGPU reach ~1M. Enables: GPU particle weather/spell effects, shallow-water/wave sim, jump-flood SDF passes, fog-of-war accumulation, radiance-cascade GI — all as compute passes.

**Storage textures.** `StorageTexture` + `textureStore(...).toReadWrite()` gives compute-writable textures (r8unorm, rgba8unorm, r16float, rgba16float, r32float) — exactly what persistent fog-of-war masks, SDF maps, and ping-pong simulation targets need.

**MRT / G-buffer.** `pass(scene,camera).setMRT(mrt({ output, normal: normalView, … }))` writes several targets in one pass, read back via `getTextureNode('normal')`/`getTextureNode('depth')` etc. — deferred/hybrid pipelines, or a cheap per-layer mask channel alongside colour.

**Clustered & tiled lighting (built in).** `ClusteredLighting`/`ClusteredLightsNode` — Forward+ clustered shading partitioning the frustum into an X×Y×Z grid, aimed at 3D depth complexity. A **tiled lighting** example (`webgpu_lights_tiled.html`) is compute-based 2D tiling — closer to what a flat top-down map needs. Theory: naive forward shading is O(pixels × lights); tiled/clustered culling bins lights into screen tiles first (a compute pass) so each pixel only iterates the lights whose radius overlaps its tile. For a flat map, full 3D clustering's Z-slicing is largely wasted — a custom 2D-tiled `LightsNode` is the better fit. Demo scene referenced: 16 torches, 22 lanterns, 91 candles (forum thread "Clustered Rendering on WebGPU," Usnul).

**Indirect / GPU-driven rendering.** `BatchedMesh` (multi-draw) works under WebGPU; full multi-draw-indirect with GPU-generated draw counts is only partially exposed — treat GPU-driven culling as possible but partly custom.

**Timestamp queries / profiling.** Construct with `trackTimestamp: true`; read via:
```js
import { TimestampQuery } from 'three/webgpu';
await renderer.computeAsync(update);
await renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE);
await renderer.renderAsync(scene, camera);
await renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
```
Real GPU milliseconds per pass. `stats-gl` wraps this. Not universally available (weaker on Safari). `renderer.info` gives draw-call/triangle counts.

**Render bundles, pipeline caching, bind groups** are managed internally by Three.js; influence indirectly by keeping materials/geometry stable. Deliberate abstraction — raw WebGPU bind groups are rarely touched directly unless dropping to raw WGSL.

**Browser/Electron support (2026).** WebGPU is Baseline: Chrome/Edge since Chromium 113 (2023); **Firefox 141 shipped WebGPU on Windows 22 Jul 2025** (Apple-Silicon macOS following in Firefox 145/147, Linux/Android still pending, targeted 2026); **Safari 26** shipped WebGPU on macOS Tahoe/iOS/iPadOS/visionOS Sept 2025. Two engine implementations: Dawn (Chromium) and wgpu (Firefox). **Foundry V13 stable bundles Electron 34.2.0 / Chromium 132** (per Foundry's 13.337 release notes; V13 minimum per 13.336 is Electron 33/Chromium 122/Firefox 127) — past the 113 threshold. Caveats: most players connect through an ordinary browser to the host's server, so browser support matters more than the Electron client; and **Linux Electron WebGPU is fragile** — Chromium's Vulkan backend isn't enabled by default in Electron, adapters can return `null` (electron#40929, #41763), sometimes needing `--enable-features=Vulkan --enable-unsafe-webgpu`. Foundry has published no statement confirming WebGPU testing in their Electron build — verify empirically per-platform.

### 3. Techniques for a top-down / bird's-eye 2.5D map renderer

**Faking 3D depth on flat art.** A top-down sprite/tile is a flat quad whose true normal points straight up. A normal map replaces the per-texel normal with an authored direction (RGB, 128/128/255 = flat/up); dotting it with light direction at shading time gives diffuse shading that reacts to moving lights on a static image. Set via `material.normalNode` (`unpackRGBToNormal`). Add roughness/metalness/AO for PBR response, height map for parallax. Authoring tools: Sprite Lamp, Sprite DLight, SpriteIlluminator, Laigter (open source). **Parallax occlusion / relief / steep parallax mapping** ray-marches the view ray through a height map for genuine self-occluding parallax as the camera pans — a fragment-stage loop sampling the height map, cost = steps × pixels, mitigated by limiting steps and using mip levels.

**Deferred vs Forward+/clustered for many lights.** **Forward+/tiled** (recommended): one geometry pass, lights culled into screen tiles by a compute pass first — scales well, keeps MSAA/transparency straightforward. **Deferred**: MRT G-buffer then screen-space shading — cost independent of overdraw, but transparency/MSAA harder, heavier bandwidth for a 2D scene. A custom 2D-tiled `LightsNode` is the sweet spot for a flat map.

**2D shadow casting / line of sight.** Alternatives/complements to a CPU radial-sweep polygon approach: **1D/radial shadow maps** — per light, render distance-to-nearest-occluder as a function of angle into a small 1×N buffer, compare per-pixel angle/distance in the fragment pass; soft penumbrae from filtering the 1D map. **Jump Flood Algorithm (JFA) → SDF** — seed a texture with occluder pixels, run log₂(n) flood passes (sampling neighbours at halving offsets) → Voronoi/nearest-seed map → signed distance field, from which soft 2D shadows / distance-based foam/edge masks fall out essentially for free. O(n log n), perfectly parallel, ideal for compute (Rong & Tan 2006 origin; demofox.org canonical 2D tutorial; RTSDF paper combines JFA+raytracing for real-time soft shadows). **Raymarched SDF shadows** give the softest results and unify with GI below.

**Global illumination for 2D — radiance cascades.** Invented by Alexander Sannikov at Grinding Gear Games (ExileCon 2023, used in *Path of Exile 2*): a radiance field stored in a hierarchy of probe grids — lower cascades have many probes/few ray directions (high spatial, low angular res); higher cascades have few probes/many directions (low spatial, high angular). Near-field lighting needs spatial detail, far-field needs angular detail — this trades off optimally, and cost is **independent of the number of lights**. Per Sannikov: *"encode radiance at a constant cost that is independent of scene complexity, number of light sources or polygons present in the scene"* — 2 vs 1002 particles, same ~12ms; a demo ran at 0.3ms/frame on a GTX 970 with no denoising/temporal accumulation. Noise-free without temporal accumulation. Each cascade is raymarched (often against a JFA-derived SDF of the scene), upper cascades interpolated down into lower ones. Study order: SimonDev's intro video → jason.today's two-part interactive Three.js tutorial (built from scratch) → GM Shaders deep dive (Xor & Alex/Yaazarai) → tmpvar's WebGPU flatland playground (with source) → Sannikov's ExileCon material → arXiv 2408.14425 (Osborne & Sannikov, foundational) → arXiv 2505.02041 (2025, "Holographic Radiance Cascades," state of the art) → Cody Bennett's `three-rc` (a Three.js implementation; its depth-aware upscaler is unlicensed — study, don't copy). Trade-offs: default RC has ringing near lights (fixed by the 2024 paper's "bilinear fix") and struggles with small penumbrae; shines for diffuse GI and light bleed — could replace flat lighting with genuinely bounced, coloured light spilling around corners.

**Volumetric light shafts / god rays / cone of vision.** In top-down view, "god rays" become radial light streaks masked by the LOS/SDF field — a screen-space radial blur from the light origin, masked by occlusion, or accumulated during the RC raymarch. "Cone of vision" is naturally the LOS polygon/SDF as a mask with soft falloff.

**Fog of war.** Maintain a persistent single-channel "explored" texture (a storage texture). Each frame, composite the current vision polygon/SDF into it with a max/accumulate compute pass, so revealed areas stay revealed. Soft edges from blurring or SDF distance; dithered/noise reveal from an FBM mask. Cheaper and smoother than CPU polygon fog, updates incrementally, and (being a storage texture) is readable back for gameplay logic if needed.

### 4. Effects systems

**Water (top-down).** Cheap→expensive: dual-scroll normal maps + flow maps (RG = flow direction, locally advecting UVs) driving `normalNode`; screen-space refraction/distortion (sample scene colour offset by water normal, Schlick's Fresnel blends reflection/refraction); caustics (scrolling textures masked to shallow areas, or the differential-area method — project light through the surface, brightness = originalArea/projectedArea; Three.js ships a `webgpu_caustics` example using `refract()` in TSL); shallow-water/wave sim (2D wave equation on ping-pong storage textures, discrete Laplacian, or FFT ocean for open water — `jeantimex/threejs-water` is a Three.js port of Evan Wallace's classic showing GPU wave sim + caustics + differential-area method; "Three.js Water Pro" is a commercial WebGPU/TSL FFT-ocean asset); foam/shoreline (threshold SDF distance-to-land).

**Fire, flame, candle, torch.** Emissive HDR + bloom. Procedural noise (FBM/domain-warped, scrolling upward, shaped by a flame gradient) written to `emissiveNode` at intensity >1.0 to exceed bloom threshold. Billboard sprites for volume. Flicker: sum a couple of low-frequency noises (candle flames flicker roughly 1/f) modulating both emissive intensity and the attached light's intensity/position. Use built-in MaterialX noise (`mx_noise_float`, `mx_fractal_noise`) rather than hand-rolled Perlin.

**GPU particles.** Libraries: `three.quarks` (mature, batched VFX, Unity-Shuriken-like, has an experimental `quarks.nodes` WebGPU-compute path); `@newkrok/three-particles` (opt-in WebGPU/TSL backend, 50k–350k+ particles, silent CPU fallback, needs Three.js r182+); `three-fluid-fx` (screen-space fluid coupling). Roll-your-own with compute (best control): `instancedArray` position/velocity/age buffers, init + per-frame update compute passes, rendered via `SpriteNodeMaterial` + `AdditiveBlending`. Curl-noise advection (curl of a noise field as divergence-free velocity) gives natural swirling smoke/dust/embers. Sorting for alpha blending is the hard part; additive blending sidesteps it for fire/magic.

**Weather.** Rain/snow/leaves as GPU particle systems; top-down readability trick — small parallax offset by simulated height + a soft shadow blob on the ground so particles read as above the map. Drifting fog/mist as scrolling FBM layers with soft alpha, all in one compute-driven buffer.

**Procedural noise in TSL.** MaterialX noise nodes (`mx_noise_float`, `mx_worley_noise_float`, `mx_fractal_noise_vec3`, cellular/Voronoi), plus hand-built FBM (sum octaves) and domain warping (offset noise input by other noise). Keep cheap: precompute static noise to a texture where possible, fewer octaves, reuse via `.toVar()`.

### 5. Post-processing and colour pipeline

`PostProcessing`/`RenderPipeline` composes TSL effect nodes as a graph, sharing scene data (depth/normal from MRT) between effects and fusing passes:
```js
import { pass, mrt, output, normalView, bloom, ao, denoise, fxaa } from 'three/tsl';
const post = new THREE.PostProcessing(renderer);
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, normal: normalView }));
const color  = scenePass.getTextureNode('output');
const depth  = scenePass.getTextureNode('depth');
const normal = scenePass.getTextureNode('normal');
const aoPass = ao(depth, normal, camera);
const lit    = denoise(aoPass.getTextureNode(), depth, normal, camera).mul(color);
post.outputNode = lit.add(bloom(lit, 0.3, 0.2, 0.1));
```
Available nodes: bloom (incl. selective/emissive bloom — drive glow off `emissive`, ideal for candle/spell systems), GTAO/SSAO, SSR, DoF/bokeh, motion blur, TRAA/FXAA/SMAA, outline, chromatic aberration, film grain, vignette, lens flare, plus WebGPU-exclusive SSGI/SSS/improved DoF. **Selective bloom** is the key one for a VTT — mark emissive tokens/effects and bloom only those, leaving the map crisp (`webgpu_postprocessing_bloom_emissive` example is the template).

**HDR & colour management.** Render linear HDR, tone-map at the end. ACES Filmic, AgX, Khronos PBR Neutral tone mappers; `THREE.ColorManagement` on by default; `outputColorSpace = SRGBColorSpace`. LUT nodes for colour grading. HDR display output is emerging but not reliable yet — target SDR with good tone mapping.

**Compositing stack for layered treatment.** Separate render targets composited with TSL (full control, more memory) vs a single MRT pass carrying a layer-ID/mask channel so post effects mask cheaply (e.g. bloom only the effects layer, grade only the map). MRT masks are far cheaper than extra passes.

### 6. Performance and architecture for large maps

**Large map textures.** KTX2/Basis Universal stays compressed in VRAM (~10× saving vs a decompressed PNG that can balloon to 20MB+). `KTX2Loader` works with WebGPU, but some transcoded formats have hit "Unsupported texture format" errors under WebGPU (three.js issue #26124) — test the target format, prefer UASTC→BC7/ASTC/ETC2 per platform, verify `detectSupport`. Tiling/streaming isn't a first-class Three.js feature (custom work), but an orthographic top-down camera makes the visible set trivial to compute (it's just the view rectangle). Mipmapping + anisotropic filtering essential for zoomed-out views; anisotropy matters less for straight-down ortho than oblique angles but still helps at grazing zoom.

**Draw-call reduction.** `InstancedMesh` for many identical tokens/tiles; `BatchedMesh` (multi-draw) for many different geometries sharing a material — both work under WebGPU, indexable per-instance in the node material. Texture atlases reduce binding changes. Target well under a few hundred draw calls.

**Culling & LOD.** Orthographic top-down → frustum culling is a 2D rectangle test. Occlusion culling is largely irrelevant for a flat scene. LOD can swap detail by zoom level.

**Memory & GC.** WebGPU is explicit: always `geometry.dispose()`, `material.dispose()`, `texture.dispose()`, `.destroy()` compute buffers on removal. Avoid per-frame allocations in long-running sessions. The r184 changelog specifically addressed large per-frame internal allocations.

**Profiling toolchain.** `renderer.resolveTimestampsAsync` + `stats-gl` for GPU pass timing; `renderer.info` for counts; Chrome DevTools Performance panel; the **WebGPU Inspector** browser extension (PIX/RenderDoc-equivalent for the web); `chrome://gpu`. Profile on a real target machine.

### 7. Host-VTT integration specifics (Foundry, generalizes to any PIXI-based VTT)

**How the host canvas works (Foundry V13/V14).** A hierarchy under `canvas.stage`: `PrimaryCanvasGroup` (tangible, lit objects — map/tokens/tiles/drawings/weather; a `CachedContainer` rendered to a texture); `EffectsCanvasGroup` (lighting/vision/fog/animations modifying the primary group); `InterfaceCanvasGroup` (interactive/UI, most placeable layers draw here); `EnvironmentCanvasGroup`/`RenderedCanvasGroup` wrapping those; `OverlayCanvasGroup` for elements not bound to the stage transform. Placeables live in `PlaceablesLayer`/`InteractionLayer` subclasses; vision is `ClockwiseSweepPolygon`/`PointSourcePolygon`; fog is `FogManager`; `CanvasEdges` holds wall segments (V13+). Foundry V13 deliberately postponed its own PIXI v8/WebGPU migration — core Foundry stays PIXI-v7-era WebGL for the foreseeable future, so a Three.js overlay coexists with, not inherits from, a WebGPU host.

**Integration strategy — overlay, don't fuse.** Two approaches: (1) **Transform-synchronised overlay canvas** — a second `<canvas>` (a WebGPU renderer) stacked over the host's, mirroring the host's stage transform (pivot/scale/position) onto an `OrthographicCamera` every frame, hooked to the host's pan/zoom event, keeping the host's canvas underneath/transparent so its interaction/hit-testing keeps working — the host owns input, the overlay owns visuals. Trade-off: two GPU contexts (memory/overhead), sizes must stay in sync. (2) **Full replacement** — disable the host's rendering of a group, draw everything in the overlay; far more work, must reimplement interaction, maximal control.

**Can PIXI and Three share a context?** Technically yes for **WebGL** — PixiJS 8.7.0 added shared-WebGL-context support with a published "Mixing PixiJS and Three.js" guide (pass Three's context to Pixi, create Three with `stencil:true`/`clearBeforeRender:false`, call `resetState()` on each renderer per frame). But textures/resources are NOT shared across the two, both fight over WebGL state, and — decisively — this is a **WebGL** interop story. A **WebGPU** renderer is a different context type entirely and **cannot** share with PIXI's WebGL context. Realistic architecture: a separate WebGPU canvas synced by transform, accepting no resource sharing. Browsers also cap active WebGL/WebGPU contexts at roughly 8–16.

**Reading scene data → scene graph, incrementally.** Translate host documents to the overlay's scene graph and update only what changed: walls → line segments feeding SDF/shadow/LOS; lights → the light list for tiled lighting/radiance cascades; tiles/background → textured quads (albedo + normal/roughness); tokens → instanced sprites with per-token normal maps and attached lights; elevation/multi-level data → 2.5D height layering. Listen to document CRUD hooks and mutate only affected objects — never rebuild the whole scene per change, mirroring how the host's own perception manager batches lighting/vision/sound updates.

**Prior art.** theripper93's ***3D Canvas*** (`levels-3d-preview`) — built on Babylon.js (stable 9.2.1), "Foundry Versions 11 to 14 (Verified 14)": *"Turn your maps into true 3D, load in 3D models… Supports lighting and animated models."* Takes over the scene view (not a synced overlay); includes its own spell/particle system, fog of war, environmental effects. The closest existing integration to study for lifecycle hooks and scene-data reading, though a different strategy (replace vs overlay) and engine (Babylon vs Three). `dev7355608/perfect-vision` and the host's own dynamic token-ring/lighting systems are useful for how the community extends the lighting/vision pipeline. Module packaging: a manifest-driven module loaded via the host's own hook API; check the host's package/licensing terms, and be careful that any GI code adapted (e.g. Sannikov's upscaler) is appropriately licensed — several radiance-cascade repos are deliberately unlicensed.

### 8. Learning resources & community

Official: three.js `webgpu_*` examples, TSL Specification page, TSL-Spec wiki, WebGPURenderer manual, TSL Editor & Transpiler, the new Inspector addon. Tutorials/blogs: Three.js Roadmap, Maxime Heckel "Field Guide to TSL and WebGPU," sbcode TSL tutorials, Nik Lever's TSL series, Wawa Sensei R3F WebGPU/TSL + GPGPU course, Codrops, ICS Media. 2D lighting/GI: jason.today RC tutorial, GM Shaders RC deep-dive, tmpvar WebGPU flatland playground, SimonDev video, arXiv 2408.14425, arXiv 2505.02041. Particles/water: three.quarks, @newkrok/three-particles, three-fluid-fx, jeantimex/threejs-water, Three.js Water Pro. Compute/SDF: WebGPU Fundamentals (timing/profiling), demofox.org JFA articles, RTSDF paper, CedricGuillemet/SDF resource collection. People: sunag (TSL lead), Mugen87 and mrdoob (three.js), the Graphics Programming Discord's Radiance Cascades thread.

## Recommendations (as given by the source report — not this project's plan of record)

- **Stage 0 — lock the foundation.** Pin a specific Three.js version, treat upgrades as scheduled work with a visual-regression pass. A WebGPU capability probe that detects backend and falls back gracefully, tested inside the actual host Electron client on Windows/macOS/Linux. Threshold to change plan: if Linux Electron can't get a WebGPU adapter even with flags, ship the WebGL2 fallback there rather than blocking.
- **Stage 1 — 2.5D lighting core.** Normal/roughness/AO-mapped materials via `normalNode`, then a 2D tiled light system fed by the host's lights. Benchmark: 60fps with ~100 dynamic lights on a mid-range GPU.
- **Stage 2 — shadows & fog of war on the GPU.** JFA→SDF from wall edges for soft 2D shadows, LOS masking, persistent storage-texture fog-of-war. Benchmark: SDF + fog update under ~1–2ms/frame at map resolution.
- **Stage 3 — radiance-cascade GI.** Layer on top of the SDF for bounced, coloured light, behind a quality toggle. Benchmark: full GI pass within frame budget at 2–3 cascades; watch for ring artefacts (bilinear fix).
- **Stage 4 — effects & post.** Emissive-driven selective bloom; compute-driven particles via curl-noise; water via caustics example + flow/normal maps; TSL post stack (bloom + AO + tone mapping + optional LUT + FXAA/TRAA). Single MRT pass with a layer-mask channel for differentiated post treatment.
- **Stage 5 — scale & harden.** KTX2 textures (verify format support), instancing/BatchedMesh, 2D frustum culling, rigorous dispose/destroy discipline, continuous profiling. Benchmark: stable memory over a multi-hour session, <200 draw calls.

## Caveats (from the source report)

- Marketing/AI-generated sources overstate maturity — primary sources were used for anything load-bearing; treat secondary blogs as directional.
- TSL is a moving target — expect deprecation warnings and occasional breaks on upgrade.
- "Experimental" is Three.js's own word for `WebGPURenderer` — validate any specific workload against `WebGLRenderer` too.
- Some WebGPU features are gated/partial: timestamp-query not universal (weaker on Safari), certain KTX2 formats error under WebGPU, multi-draw-indirect/GPU-driven culling only partly exposed, `wgslFn` interop with storage buffers/samplers has rough edges.
- The overlay technique is unproven for Three.js specifically — no published module does a transform-synced Three.js WebGPU overlay on a PIXI host canvas; the two-context (WebGPU + WebGL) coexistence needs empirical performance validation.
- Host licensing governs what can be shipped; several radiance-cascade reference implementations are deliberately unlicensed (authors ask that the upscaler specifically not be copied).
- Linux/Electron WebGPU may require launch flags or be unavailable; plan the WebGL2 fallback accordingly.

---

## Tie-backs to this project's own architecture

_Observations only — nothing below changes a locked decision or schedules new work. Flagged for whoever next touches the relevant area._

- **WebGPU+TSL direction** ([[keyhole-webgpu-tsl-decision]]): this report independently reaches the same conclusion the author locked in on 2026-07-16, from a source that didn't know about that decision. `package.json` pins `three@0.185.1` — exactly r185 (1 Jul 2026), the version this report treats as current. No version-upgrade gap exists right now.
- **Foundry's Electron/Chromium version is now a confirmed fact, not an assumption**: V13 bundles Electron 34.2.0/Chromium 132, past the WebGPU baseline. The one real caveat is Linux Electron specifically (Vulkan backend off by default, may need launch flags) — worth knowing if a Linux-hosted bug report ever describes an unexpected WebGL2 fallback or a missing adapter.
- **Overlay architecture, no shared GPU context** ([[keyhole-input-model-decision]], [[keyhole-interface-seam]]): this report's PIXI/Three interop research (§7) confirms a WebGPU renderer flatly cannot share a context with PIXI's WebGL — independent validation of why this project mirrors the host's camera onto a separate synced canvas rather than attempting any form of context fusion. theripper93's *3D Canvas* (Babylon.js) is the closest published prior art, but it fully replaces the view rather than overlaying — a different strategy from this project's.
- **Fog of war / vision** ([[keyhole-vision-fog-direction]], "scheduled next"): §3's JFA→SDF section and the radiance-cascades section are both concrete, citable technique write-ups for exactly the GPU-side work already planned there (consume Foundry's LOS polygon data, render smooth fog/shadows in Three). Worth reading before that build starts.
- **Radiance cascades** — genuinely new to this project's memory; not mentioned in any existing design doc. A 2D global-illumination technique whose cost is independent of light count. Potentially relevant to [[keyhole-sky-as-light-design]] if bounced/coloured light spilling from torches ever becomes a goal beyond the current per-light model — not scoped or decided, just now on the radar.
- **Water** ([[keyhole-water-tsl-design]]): already runs a JFA body SDF, so this project has independently arrived at a technique this report treats as best-practice. The caustics (`webgpu_caustics` TSL example) and differential-area method references are candidate reading for water's not-yet-built tier 4/5 (shore/refraction).
- **Particles** ([[keyhole-particles-tsl-decision]]): the locked decision (three.quarks cannot render under `WebGPURenderer`, verified 2026-07-16 at quarks@0.17.1) stands unchanged. This report notes quarks now advertises an experimental `quarks.nodes` WebGPU-compute path upstream — unverified against this project's own HEAD, logged only because that memory's own text says to re-verify if quarks majors change. The report's own recommendation for particle systems ("roll your own with compute — best for control") is what this project already committed to independently.
- **Large-map textures** ([[keyhole-device-loss-large-map]]): already solved via BC1/BC7 + native WebGPU upload. KTX2/Basis Universal is this report's alternative, not used here; its caveat (WebGPU "Unsupported texture format" on some transcoded formats, three.js issue #26124) would only matter if KTX2 is explored later.
- **Profiling** ([[keyhole-diagnostic-tools]]): `renderer.resolveTimestampsAsync` + `stats-gl` + the WebGPU Inspector browser extension are external tools that answer "how many GPU-ms did this pass cost," complementing rather than replacing this project's own pixel-probe/perf-lab instruments, which answer "what reached this pixel."
