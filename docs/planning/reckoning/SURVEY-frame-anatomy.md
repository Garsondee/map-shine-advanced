# Reckoning opening survey — FRAME ANATOMY: passes, targets, and per-frame surprises

*Captured 2026-08-15 by Claude Fable 5 via a read-only scout pass, for `docs/holy/V4-Reckoning.md`.
Treat as a MAP for passes R-01/R-02/R-03 and the R3 cross-cutting sweeps, not countersigned fact.*

## A. Frame driver

| Fact | Site |
|---|---|
| Frame pump is three.js `setAnimationLoop`, NOT a Foundry hook/PIXI ticker | vt-pan-viewer.js:12461 `renderer.setAnimationLoop(renderFrame)` |
| Resolves to rAF inside vendored three | vendor/three/three.webgpu.js:45348, :61512 |
| Top-level per-frame function | vt-pan-viewer.js:10001 `renderFrame(nowMs)` |
| Loop gate / teardown | :12460 · :555, :1501 |
| Viewer construction | boot.js:8252 `Hooks.on('canvasReady', …)` |
| Camera POLLED (Foundry `canvas.stage` read every frame), not hooked | :11889-11899 |

**Additional independent rAF loops beside the main loop:**
- **HEARTBEAT: a SECOND `THREE.WebGPURenderer` (own device, own 8×8 canvas) rendering an EMPTY scene every frame, forever, unconditionally** — boot.js:8585 (renderer), :8617 (`setAnimationLoop`), :8618 (render), :401 (HEARTBEAT_CANVAS_PX=8), started :8476/:8488. Also drives `MapShine.flight?.recordFrame` :8628 and a 4Hz VRAM/diagnostics sweep :8642-8669.
- Live marker overlay (DOM only) vt-pan-viewer.js:13012/:13036 (opt-in) · astrolabe pump boot.js:6091-6093 · UI-mode rAFs (see inventory survey).

## A.2 Ordered calls inside `renderFrame` (vt-pan-viewer.js)

0a GPU-probe throttle early-return :10016 (perf-lab only) · 0b **camera-path 30fps cap early-return :10029** (the P-003 fps trap) · 0c hitch/gap bookkeeping :10036-10063.
1 updateContinuousInputs :10071 [tick.continuousInputs] — **calls `scheduleResidencyUpdate()` at :11942 whenever the camera moved**.
2 syncTokenPlacements :10078 [tick.tokenSync] · 3 syncDoorGraphics :10084 [tick.doorSync] · 4 installPauseWatch :10092 (unzoned) · 5 updateEnvSnapshot :10094 [tick.envSnapshot] (pushes grade :5624/:5631).
profiler/gpuProbe beginFrame :10096-10104.
6 pollMaskAuthorityForWindRebake :10116 [tick.windRebakePoll] · 7 tickWindSim :10125 [sims.wind] · 8 tickFluidSim :10133 [sims.fluid] · 9 spawn-rect clamp :10152 · 10 particleEngine.step :10155 [sims.particlesDust] (windParticlesEnabled default FALSE :4213) · 11 gustEngine.step :10166 [sims.particlesGusts] · 12 **fireSubsystem.sync :10184 — bracketed under `Z.lightDrawFire`** (see D3) · 13 updateCamera :10196 [tick.camera].
14 **runPassPlan :10219** — framePlan computed once at :5497 (`planFrame(PASSES, {fromStage:'masks', toStage:'present'})`); passImpls :5482-5491; runner graph/run-frame.js:98; order = PASSES array filtered to status:'live' (run-frame.js:52-68).
15 sampleSceneSettle :10227 · 16 profiler.endFrame :10231 · 17 gpuZoneTimer.collect :10238 · 18 gpuProbe.endFrame :10242.

**Resolved plan (8 live passes):** masks.occlusion → geometry.world → light.accumulate → surface.response → surface.particles → post.bloom → post.dof → present.composite. (`surface.water` :380 and `post.grade` :499 are status 'seam' — never run; grade folds into present, water tier-0 draws inside geometry.world.)

## B. Pass-by-pass

### B.0 Pre-plan sims (deliberately before any RT bind — invariant :10176-10181)
wind advect/splat/relax×4/publish (7 quad draws into wind.sim ping/pong/publish) :3961-3980 when thawed+baked · refreeze clear :3906-3908 · fluid clear×N (first tick post-bake) :4013-4016 · fluid advect ×N items :4019-4022 · dust compute (particle-runtime.js:1488, seed :1467) · gust compute (gust-runtime.js:705, seed :681) · fire compute flame/ember/smoke (fire-subsystem.js:403 → fire-particle-runtime.js:714) — one dispatch per engine.

### B.1 masks.occlusion (runMaskOcclusionPass :5989)
masks.occlusionSync CPU scan of lastItems + disc pool reconcile :5990-6050 (O(tokens)) · **masks.occlusionDraw :6051-6064 — setRenderTarget(occlusionMask.rt) + setClearColor + CLEAR + render(occlusionScene) UNCONDITIONALLY every frame, even with zero occluders** · uOcclusionElevation refresh over every drawn item :6066+.

### B.2 geometry.world (runGeometryWorldPass :4595; depth FIRST since 2026-08-09 :4596-4615)
debugFirstRenderProbe :4722-4726 (off) · depthSetup :4734-4746 · **depthRenderCall :4747-4749 render(depthScene, depthCamera) → scene.depth** (proxies added :11056/:11192/:11200) · depthRestore :4750-4753 · setMRT(sceneAttrZeroMrt) :4623 (restored :4690) · **earlyZPrepass :4633-4666 — bind sceneColor, setClearDepth(1), clear(true,true,true) [THE frame's only clear], render(depthPrepassScene, depthCamera), colour-only reclear :4665** — flag default true :9783 · **worldDraw :4669-4671 render(scene, depthCamera) → scene.color MRT** (non-earlyZ branch :4678-4681) · doorDraw :4686-4688 → renderDoorGraphicsInto :4192-4196 (early-return leafCount===0 :4193).

### B.3 light.accumulate (runLightAccumulatePass :4779)
CPU phase every frame: **getActiveSceneFloors :4795 (UNZONED; own comment :4787-4789 says it was designed for boot-time call sites, not a per-frame hot path — walks scene.levels, sorts, resolveAssetUrl + Array.from per floor = allocations/frame)** · ambient resolve :4807-4834 [light.ambient] · **sun-shadow maybeBake PER FLOOR :4860-4880 (loop :4867; per-slot push :4877-4879)** [light.sunShadowBake] · water body :4891 · water surface :4898 · fluid surface :4903 · region reconcile :4939 (updateRegionDarknessMeshes :2795) [light.regionSetup] · lightning :4947 · **pointLights.update :4956 → point-light-pool.js:1042** [light.pointLightUpdate + 5 nested zones :1097/:1132/:1295/:1516/:2064; wall-clip's own comment :1094-1096 records 9.9% of a frame] · candles :4961 · vegetation :4969 · **syncAllFloorAttrUniformsForFrame :4979 → :9463 — NO ZONE, explicitly (:4975-4978), O(items×tiles + items×vegKinds) per frame** · wind overlay :4981 · UI-shadow stamps :5029.

GPU phase (autoClearColor=false :5033-:5167): drawIllum :5034 (1 fullscreen quad; 6 sun-slot samples/fragment) · **drawRegions :5042 — UNCONDITIONAL even when regionScene empty** · drawPointLights :5048 (mesh per light + batch buckets; MAX blend; fill ∝ Σradius²) · drawPointLightsMerged :5059-5084 (flag off — permanently-empty mergedScene documented :5053-5058) · **drawApertureShadow :5099 — UNCONDITIONAL (justified :5096-5098)** · **drawWindowLight :5110-5166 — PER-FLOOR loop: prune :5131, rank gate :5160, sync :5163, render :5164** · drawColoration :5177 (clears; mesh per light) · colorationMergedBlit :5192 (off) · drawComposite :5204 → scene.lit · candle :5213 · lightning :5226 · fire :5237 · wind overlay :5248 (debug off).

### B.4-B.8
surface.response :5280 — specularSync :5286 (always, pre-gate :5281-5285) · early-return !hasContent :5289 · specularDraw :5293 (2 meshes, MULTIPLY+ADD, AABB-cropped quad).
surface.particles :5310 — early-return :5313 · drawDust :5322 · drawGusts :5327 (additive into scene.lit).
post.bloom :5343 — early-return disabled :5345 · uniformPush :5349 · bright (½ res) :5368 · downsample ×5 :5375-5394 · upsampleCore ×2 :5397 · upsampleAtmo ×2 :5406 · composite → scene.lit :5418. **10 draws; scales with resolution only.**
post.dof :5437 — early-return !enabled :5439 · **early-return `view.floorIndex === 0` :5440 — RUNS ONLY ON UPPER FLOORS** · uniformPush :5443 · downsample ×4 :5454-5462 · composite (NormalBlending, reads scene.depth) :5468-5474. **5 draws, upper floors only.**
present.composite :4755 — debug-quad swap :4765-4768 · **present.blit :4769-4771 — 1 fullscreen quad to the canvas; material = gradePresent.material (:4548/:4557)**.

## C. Render-target / storage registry

Allocation walled to graph/three-allocator.js:323; tracked `allocatedTargets` (:1567/:1638); exposed `getVtPanViewerRenderTargets()` (:15351/:13339).

| Name | Site | Size | Format | Re-rendered |
|---|---|---|---|---|
| scene.color | :1682 (desc :1677; scene-attr.js:150) | drawBuf (device px) | **MRT×2** RGBA16F + attr RGBA8 nearest, + Float32 depthTexture (:1679-1680) | every frame |
| scene.depth | :1690 (scene-depth.js:114) | drawBuf | RGBA8 nearest + Float32 depth | every frame |
| scene.illum | :1713 | drawBuf | RGBA16F no depth | every frame |
| scene.lit | :1714 | drawBuf | RGBA16F | every frame |
| scene.coloration | :1722 | drawBuf | RGBA16F | every frame |
| scene.pointLightMerged | :1732 (point-light-merged.js:296) | drawBuf | MRT×2 RGBA16F | **only when pointLightMrtMerge on (default OFF) — allocated unconditionally :1723-1731** |
| occlusion.mask | :5883 (desc :5870) | drawBuf | RGBA8 nearest no depth | every frame (clear+draw) |
| bloom.mip0..5 (6) | :2239 (desc :2225; count :2220) | ceil(drawBuf/2^(k+1)) | RGBA16F | when bloom on |
| dof.mip0..3 (4) | :2290 (desc :2275; count :2273) | same halving | RGBA16F | when DoF on AND floor>0 |
| scene.sunShadow.slot0..5 (6) | sun-shadow-subsystem.js:792, loop :1446-1475 | activeFieldDim² (512→2048 tier :782-785; 1×1 when off :1267) | RGBA8 — NOT screenSized (world-space) | on bake only (gates :1259, cascade :1317-1319) |
| water.body + water.jfa.ping/pong | water-body-subsystem.js:226-230 | mask grid ≤512 | RGBA16F | on bake |
| wind.sim.ping/pong/publish (3) | :3616-3618 (desc :3607) | cols×rows clamped [64,256] :3597-3601 | RGBA16F | every frame while thawed (7 draws) |
| fluid.sim.ping/pong.<id> | fluid-surface-subsystem.js:303-304 → :1963 | ≤512×64 | RGBA16F | every frame per active fluid item |
| debug.firstRenderProbe | :4713 | 4×4 | RGBA8 | debug only |
| particle storage buffers | particle-arena.js:228 (sole instancedArray site) | budget ÷ bytes-per-particle (:96) | storage | compute kernels |

Resize: `reallocateScreenSizedTargets` :12141 (scene.color :12161, scene.depth :12172, illum/lit/coloration :12176-12178, merged :12179, bloom :12190, dof :12197, occlusion :12207, then scheduleResidencyUpdate :12208). Sun-shadow resize separate (ss:844).

**Steady-state screen-res surfaces: 11 always-live** (scene.color×2+depth, scene.depth×2, illum, lit, coloration, pointLightMerged×2, occlusion.mask) + 10 mips + 6 world-space shadow squares.

## D. Per-frame cost surprises (each carries its own cite — candidates, not verdicts)

**D1. Six sun-shadow slots sampled per fragment in EVERY lighting material, no early-out.** SUN_SHADOW_MAX_FLOORS=6 eager (ss:341/:1445-1475); blendSunVisibilityAcrossFloors loops every slot, sample+smoothstep, no branch (environmental-light.js:701-728, deliberate :416-419); inlined into ambient illum (env-light:394-402), EVERY point-light illumination material (point-light-illumination.js:1358-1384), merged (point-light-merged.js:213-227). light.drawPointLights fill carries 6 dependent fetches/fragment/light.

**D2. post.dof exists only on upper floors.** :5440. Ground pays zero; upper pays 5 draws incl. fullscreen composite. Definitionally absent from the ground baseline.

**D3. Fire's compute is bracketed under `light.drawFire`, not a sims zone.** :10183/:10190 use Z.lightDrawFire around sync; :5237/:5242 use the SAME zone around the draw. No Z.lightFireSync binding exists (grep zero). Declared `light.fireSync` (perf-zones.js:553) only fires nested inside fire-subsystem.js:271. Net: light.drawFire = sims compute + lighting draw summed across two disjoint brackets.

**D4. syncAllFloorAttrUniformsForFrame is O(items×tiles)/frame and deliberately un-instrumented.** :4979/:9463; comment :4974-4978. The one per-frame O(items×floors) loop in the light pass with no measurement.

**D5. getActiveSceneFloors() every frame inside the light pass.** :4795; own comment :4787-4789. Walks+sorts+allocates per frame. 2026-08-12 fix reduced 4 calls/frame to 1; didn't remove it.

**D6. Three unconditional draws with (usually) empty scenes.** regionScene :5043 (no hasContent gate) · apertureShadowScene :5100 (accepted :5096-5098) · occlusion mask clear+render :6056/:6061 with zero occluders.

**D7. The heartbeat: a second WebGPU device renders an empty scene every frame, forever.** boot.js:8585/:8617-8618; 8×8 canvas :401/:8587; unconditional :8476/:8488. Drives flight recorder :8628 + 4Hz VRAM sweep :8642-8669.

**D8. Camera motion triggers residency from inside the frame loop; proxy rebuilds effectively per-frame while panning.** updateContinuousInputs :11878 → scheduleResidencyUpdate :11942 on view change. In-source note :10981-10983: depth.proxyRebuild occurrenceRate 1.0 across a real 463-frame capture; residency.pass ~12.5ms/occurrence (:9979-9982). rebuildSceneDepthProxies (:10910, called :11600) rebuilds depthScene AND depthPrepassScene populations.

**D9. Per-floor subsystem loops in light.accumulate are O(floors) per frame, not per bake** — sun shadows :4867/:4877-4879; window light :5137-5165. Documented multi-floor fixes (:4839-4854, :6905-6919); cost intentional, proportional to floor count every frame.

**D10. Sun-shadow rebakes cascade.** Slot i rebakes when slot i-1's serial changed (ss:1317-1319) — one scene-wide trigger (sun quantum) can chain up to 6 bakes in a frame, each an unrolled multi-step march (activePlan.steps :806).

**D11. module.json advertises Dice So Nice + Sequencer compositing; no integration exists in src/.** module.json:29-46 relationships.recommends with pipeline-integration reasons; grep src/ (excl. vendor) for diceSoNice|dice-so-nice|Sequencer|sequencer → zero files. Stale manifest copy, or the feature lives only in legacy/.
