# Reckoning opening survey — RUNTIME INVENTORY

*Captured 2026-08-15 by Claude Fable 5 via a read-only scout pass, for `docs/holy/V4-Reckoning.md`.
Spot-verified at several sites (src tree, stale npm scripts, S1a anchors); treat as a MAP for
your own census pass, not as countersigned fact. Re-verify any line you build on.*

## 0. Scope boundary (what ships)

`module.json` ships exactly one ESM entry: **`src/boot.js`**. Everything under `src/` is reachable from it (except `src/vendor/`, which is imported as the THREE bundle). Also shipped: `styles/module.css`, `styles/ui-color-themes.css`, `languages/en.json`, plus `templates/*.hbs` and `assets/`, `data/` (non-code).

- **259** runtime `.js` files under `src/` (excluding `__tests__/`).
- **186** files under `src/**/__tests__/` (Node test suites — not runtime).
- Non-JS in `src/`: `src/CONVENTIONS.md`, `src/vendor/three/LICENSE`.
- Taxonomy source: `src/CONVENTIONS.md` §1 (which defers to `docs/planning/Keyhole.md` §3).
- Note: `src/CONVENTIONS.md` §1 declares a `gameplay/` directory that **does not exist on disk** (verified 2026-08-15). Its stated contents (tokens, walls, doors, interaction) live in `src/foundry/` and `src/vt/vt-pan-viewer.js`.

## 1. Directory tree (runtime file counts)

```
src/                        1  boot.js — the ONE entry point
├── core/                   4  shared utilities (clock, log, schema, error)
├── graph/                  8  pass declaration, frame graph, allocator
├── vt/                    24  virtual-texture core + THE RENDER LOOP
├── scene/                 13  authorities: mask, anchor, depth, layer order
├── foundry/               26  the ONE Foundry adapter
├── world/                 11  sun, time, environment, wind
├── ui/                    12  paint/anchor modes, loading screen, astrolabe
├── diag/                  27  profiler, zones, reports, debug panel
├── effects/               31  (top level: declarations + standalone effects)
│   ├── lighting/          20  point lights, sun shadows, regions, gobo
│   │   └── animations/    26  Foundry light-animation ports + clock/registry
│   ├── particles/          8  GPU particle arena + 3 runtimes
│   ├── specular/           8  "Shine"
│   ├── water/             11
│   ├── fire/               7
│   ├── fluid/              8
│   ├── window/             7  window light / cookie / glass
│   └── grade/              5  colour grade + LUT
└── vendor/three/           2  vendored THREE WebGPU+TSL bundle
```

## 2. Files over 2000 lines

| File | Lines |
|---|---:|
| `src/vendor/three/three.webgpu.js` | **79546** (vendored, never linted/edited) |
| `src/vt/vt-pan-viewer.js` | **16649** |
| `src/boot.js` | **8700** |
| `src/diag/perf-report.js` | **2581** |
| `src/vt/block-compress.js` | **2371** |
| `src/effects/lighting/point-light-pool.js` | **2292** |

Next largest: `src/effects/particles/particle-runtime.js` at 1827.

## 3. Subsystem detail

### boot.js — module entry / wiring / console API
Singleton module side-effect; body is essentially one `install()` (:720–~8513) + `syncInterfaceSeam` (:8514) + `bootHeartbeat` (:8534). Owns the HEARTBEAT second renderer loop (`:8617`), the `pumpAstrolabe` rAF (:8091), the profiler instance, wall-change version counter, and every debug-panel registration. Debug-panel ids registered here — reports: boot, console, environment, fog-of-war-census, interface-preview-leak, interface-seam, loading-screen-state, mask-authority, pass-graph-health, pixi-residency-report, scene-settled, stage-gate-baseline, tokens, ui-shadow-status, vt-canvas-census, vt-pan-viewer-diagnostics, vt-pan-viewer-layers; panels: perf-lab/perf-hud/perf-last-result, bloom, dof, grade, candles, fire, lightning, sun-shadows, vegetation; actions: camera-path-open, mask-stack-probe, orientation-self-test, scene-depth-self-test, soak, vt-live-decode, vt-pan-viewer-start-real-scene, vt-pan-viewer-stop, vt-zoom-thrash-active.

### core/ (4)
`frame-clock.js` 241 (THE ONE CLOCK — only module allowed `performance.now()`), `params-schema.js` 328, `log.js` 220, `not-built.js` 68.

### graph/ (8)
`passes.js` 604 — 15 declared passes: frame.snapshot:75, vt.residency:103, sims.particles:117, sims.fluids:148, masks.occlusion:162, geometry.world:180, light.visibility:220, light.accumulate:254, surface.response:331, surface.water:380, surface.particles:428, post.bloom:455, post.dof:477, post.grade:499, present.composite:537. Plus `frame-graph.js` 594, `three-allocator.js` 393 (enforces `LAW_MAX_WORLD_RES_DIM`), `pass-impls.js` 205, `pass-health.js` 141, `run-frame.js` 123, `pass-seams.js` 61, `index.js` 43. `runPassPlan` invoked from `vt-pan-viewer.js:10218`. Dynamic `pass.<id>` zones (cap 32).

### vt/ (24) — the VT core AND the live renderer
Files: vt-pan-viewer.js 16649 · block-compress.js 2371 · decode-pool.js 1240 · scene-attr.js 962 · vt-pan-viewer-diagnostics.js 804 · bc-compress.worker.js 629 · scene-depth.js 544 · view-state.js 412 · decode-primitives.js 378 · mip-resample.js 370 · coverage-mesh.js 367 · page-cache.js 363 · compressed-textures.js 345 · residency.js 305 · mask-image.js 295 · texture-limits.js 277 · depth-proxy-material-pool.js 220 · decode-pool.worker.js 220 · page-table.js 210 · coarse-alpha.js 215 · settle.js 165 · pyramid-store.js 156 · index.js 129 · vt-live-decode-report.js 88.

Per-frame hooks (all vt-pan-viewer.js): `renderFrame` :10001; `updateContinuousInputs` :11878 (:10071) · `syncTokenPlacements` :6661 (:10078) · `syncDoorGraphics` (:10084) · `installPauseWatch` :5667 (:10091) · `updateEnvSnapshot` :5569 (:10094) · `pollMaskAuthorityForWindRebake` :3098 (:10116) · `tickWindSim` :3889 (:10125) · `tickFluidSim` :4002 (:10133) · `particleEngine.step` (:10155) · `gustEngine.step` (:10166) · `fireSubsystem.sync` (:10184) · `updateCamera` :7047 (:10196) · `runPassPlan` (:10218) · `sampleSceneSettle` :10906 · `gpuZoneTimer.collect()` (:10248) · `gpuProbe.endFrame` (:10253). Pass functions: `runGeometryWorldPass` :4595 · `runSceneDepthPass` :4692 · `runPresentCompositePass` :4755 · `runLightAccumulatePass` :4779 · `runSurfaceResponsePass` :5280 · `runSurfaceParticlesPass` :5310 · `runPostBloomPass` :5343 · `runPostDofPass` :5437 · `runMaskOcclusionPass` :5989. Per-frame CPU sweeps: `syncAllVegetationMotionForFrame` :9401 · `syncAllFloorAttrUniformsForFrame` :9463 · `stampVegetationRenderOrders` :9536 · `updateUiShadowStamps` :2341.

Event-driven: `updateResidencyUnguarded` :11235, `scheduleResidencyUpdate` :11752, `ensureItemLoaded` :6475, `setFloorIndex` :12026, `onResize` :12210, `reallocateScreenSizedTargets` :12141, `rebuildSceneDepthProxies` :10910, `bakeWindField` :3184.

Caches/pools owned: VT page cache, decode pool, pyramidStore (IndexedDB), depthProxyMaterialPool, vegetation proxy node cache, point-light wall-clip cache, point-light mesh pool, door pool, occlusion-disc pool, region-darkness mesh pool, door texture cache + leaf geometry pool, baked outdoors/fire-mask DataTextures (`bakeOutdoorsTexture` :2076, `bakeFireMaskTexture` :2141), specular/fluid pack textures (:1923/:1937). 79 zone bracket sites.

### scene/ (13)
mask-authority.js 1226 · mask-derive.js 1158 · mask-catalog.js 630 · anchor-catalog.js 540 · anchor-authority.js 467 · world-quad.js 410 · paint-mask.js 384 · layer-order.js 357 · occlusion.js 309 · depth-authority.js 305 · sky-reach-access.js 224 · mask-authority-report.js 191 · index.js 97. One instance each of mask/anchor/depth authorities, built inside the viewer closure (depthAuthority at vt-pan-viewer.js:6107). Zones: depth.authorityRebuild (:11264, :11329), depth.proxyRebuild (:11599).

### foundry/ (26)
scene-lights.js 654 · canvas-compositing.js 541 · scene-layers.js 522 · camera-path.js 494 · camera-path-player.js 468 · scene-geometry.js 413 · mask-discovery.js 357 · v2-anchor-import.js 333 · scene-tokens.js 331 · scene-walls.js 314 · scene-wall-clip.js 299 · active-scene-source.js 288 · pixi-proxy-textures.js 257 · index.js 256 · scene-doors.js 239 · game-time.js 214 · sky-persistence.js 211 · scene-export.js 202 · scene-environment.js 175 · scene-regions.js 143 · paint-adapter.js 140 · scene-controls-button.js 118 · scene-occlusion-sources.js 115 · canvas-lifecycle.js 109 (rAF watchdog :93) · settings-adapter.js 80 · anchor-adapter.js 52.

### world/ (11)
wind-field.js 949 · wind-enclosure.js 813 · wind-sim.js 620 · wind-access.js 489 · wind-sim-gpu.js 434 · day-clock.js 267 · sun.js 244 · environment.js 194 · wind-bake.js 184 · sky-settings.js 146 · index.js 83. Handles are immutable value objects re-created on version bump. Zones: sims.windBake, sims.wind, tick.envSnapshot, tick.windRebakePoll.

### ui/ (12)
anchor-mode.js 695 · astrolabe.js 688 · paint-mode.js 603 · load-progress.js 393 · camera-path-dialog.js 387 · loading-screen.js 344 · anchor-view-mode.js 340 · paint-mode-canvas.js 234 · paint-mode-toolbar.js 225 · paint-mode-widgets.js 207 · perf-progress-overlay.js 122 · index.js 16. Own rAF loops OUTSIDE the zoned frame: anchor-mode.js:378, anchor-view-mode.js:303, paint-mode-canvas.js:136, loading-screen.js:217, load-progress.js:270, boot.js:8091.

### diag/ (27)
perf-report.js 2581 · perf-zones.js 1320 (ZONES registry :141; EFFECT_ZONING :1145 — grade:none, vegetation/water/fire/fluid/apertureGobo:partial, uiWindowShadow/window/specular:full; FRAME_BUDGET_MS 8.33 :88) · debug-panel.js 1248 · perf-lab.js 1057 · flight-recorder.js 924 · effect-controls.js 831 · cache-report.js 809 · frame-profiler.js 702 (13 preallocated typed arrays; GAP_CAPACITY 4096; MAX_PASS_ZONES 32 :47) · perf-session.js 557 · wind-field-overlay.js 542 · perf-strip.js 434 · perf-structural-ab.js 418 · gpu-zone-timer.js 391 · settings-panel.js 395 · debug-panel-controls.js 374 · wind-probe.js 368 · effect-status-reports.js 323 · render-fallback.js 276 · shader-rebuild-probe.js 254 · pipeline-rebuild-probe.js 245 · perf-hud.js 246 (re-arms profiler every 250ms) · gpu-probe.js 153 · vram-inventory.js 150 · pixel-probe.js 141 · orientation-probe.js 132 · marker-overlay.js 116 · soak.js 93.

Cache-report rows: vtPageCache, vtDecodePool, vegetationProxyNodeCache, maskAuthorityBakeGate, coarseAlphaGridRequests, waterBodyBakeGate, fireMaskBakeGate, fireSpawnBakeGate, windFieldBakeGate, islandPackBakeGate, pyramidStore, anchorMarkerPool, anchorViewMarkerPool, pixiProxy, sunShadowCasterFieldBakeGate, sunShadowFieldBakeGate, paintModeGridCanvas, paintModeGridImageData, region-darkness mesh pool, token occlusion disc pool, door texture cache, door leaf geometry pool, depthProxyMaterialPool, shaderNodeBuilderCache, shaderPipelineCache.

### effects/ top level (31)
lightning-geometry.js 1058 · vegetation-render.js 830 · candle-flame-render.js 721 · candle-flame-geometry.js 715 · lightning.js 695 · vegetation.js 631 · index.js 575 · lightning-render.js 539 · vegetation-shadow-subsystem.js 411 · aperture-gobo.js 392 · lightning-subsystem.js 392 · sun-shadows.js 367 · door-graphics-subsystem.js 361 · sky-access.js 340 · door-graphics-render.js 332 · shadow-access.js 299 · candle-flame.js 283 · bloom.js 263 · bloom-render.js 257 · effect-cascade.js 229 · effect-manifest.js 214 · depth-of-field-render.js 186 · effect-settings.js 178 · aperture-gobo-registration.js 175 · ui-window-shadow.js 162 · depth-of-field.js 160 · registry.js 144 · depth-of-field-blur.js 118 · debug-channel-select.js 108 · door-graphics.js 105 · candle-ignite.js 79.

### effects/lighting/ (20)
point-light-pool.js 2292 · point-light-illumination.js 1784 · sun-shadow-subsystem.js 1556 · aperture-gobo.js 1522 · point-light-batch-mesh.js 834 · region-darkness.js 796 · environmental-light.js 790 · region-geometry.js 687 · layer-smear.js 633 · aperture-gobo-render.js 621 · light-visibility.js 538 · point-light-coloration.js 534 · layer-smear-render.js 525 · point-light-merged.js 416 · point-light-batch.js 303 · shadow-bands.js 291 · sun-shadow-debug.js 289 · sun-occlusion.js 172 · lighting-pass.js 70 · sun-occlusion-render.js 69. ONE pool (created vt-pan-viewer.js:2579) with two dedicated scenes; sub-zones bracketed at point-light-pool.js:1097/1132/1295/1516/2064.

### effects/lighting/animations/ (26)
candle-flicker.js 467 · registry.js 366 · tsl-noise-toolkit.js 202 · fairy.js 177 · ghost.js 163 · light-animation-clock.js 134 · flame.js 130 · grid.js 119 · vortex.js 116 · hexa.js 101 · siren.js 95 · energy.js 94 · smokepatch.js 89 · pulse.js 82 · sunburst.js 79 · dome.js 71 · witchwave.js 65 · torch.js 63 · fog.js 61 · starlight.js 58 · revolving.js 55 · emanation.js 51 · rainbowswirl.js 44 · wave.js 43 · chroma.js 40 · radialrainbow.js 37. Per-light, GPU-side via the animation clock; NO zones of their own (cost rides light.drawPointLights / light.drawColoration — the documented shared-zone gap).

### effects/particles/ (8)
particle-runtime.js 1827 · fire-particle-runtime.js 770 · gust-runtime.js 759 · particle-arena.js 245 (ONE arena, sub-ranged; sole `instancedArray` site :228) · particle-system-schema.js 177 · wind-gusts.js 143 · wind-diagnostic-particles.js 121 · particle-engine.js 49.

### effects/specular/ (8) · water/ (11) · fire/ (7) · fluid/ (8) · window/ (7) · grade/ (5)
specular: ONE subsystem (vt-pan-viewer.js:6834), own scene+mesh, per-viewed-floor mask swap; zones surface.specular* (coverage FULL).
water: ONE body + ONE surface subsystem; tier-0 surface draw has NO zone (renderOrder 0.5 inside geometry.world); zones light.waterBodyBake/waterSurfaceSync.
fire: ONE subsystem, three engines; light.fireSync bracketed at fire-subsystem.js:271; lights ride shared point-light zones.
fluid: mesh PER MASKED ITEM (fluid-surface-subsystem.js:24); zones light.fluidSurfaceSync, sims.fluid, light.fluidNetBake.
window: PER FLOOR subsystems (vt-pan-viewer.js:6925/6976), own scene each; zones light.windowSync (window-surface-subsystem.js:374), light.drawWindowLight (coverage FULL).
grade: folded into present.blit; NO zone (coverage 'none' by design).

## 4. Zone bracket map (registered ids × bracket sites)

tick.*: continuousInputs 10070 · tokenSync 10077 · doorSync 10083 · envSnapshot 10093 · windRebakePoll 10115 · camera 10195.
sims.*: windBake 3205 · wind 10124 · fluid 10132 · particlesDust 10154 · particlesGusts 10165.
masks.*: occlusionSync 5990 · occlusionDraw 6051.
geometry.*: worldDraw 4669/4678 · doorDraw 4686 · depthDraw 4616 · depthSetup 4734 · depthRenderCall 4747 · depthRestore 4750 · earlyZPrepass 4633 · debugFirstRenderProbe 4722.
light.*: ambient 4807 · sunShadowBake 4860 · waterBodyBake 4891 · waterSurfaceSync 4898 · fluidSurfaceSync 4903 · regionSetup 4939 · lightningSync 4947 · pointLightUpdate 4956 · candleSync 4961 · vegetationSync 4969 · windOverlaySync 4981 · uiShadowStamps 5029 · drawIllum 5034 · drawRegions 5042 · drawPointLights 5048 · drawPointLightsMerged 5061 · drawApertureShadow 5099 · drawWindowLight 5110 · drawColoration 5177 · drawColorationMergedBlit 5192 · drawComposite 5204 · drawCandleFlame 5213 · drawLightning 5226 · drawFire 5237/10183 · drawWindOverlay 5248. Elsewhere: pointLightWallClip/SourceBuild/ApertureSetup/Reconcile/BatchReconcile (point-light-pool.js 1097/1132/1295/1516/2064) · windowSync (window-surface-subsystem.js:374) · fireSync (fire-subsystem.js:271) · fluidNetBake (fluid-surface-subsystem.js:241).
surface.*: specularSync 5286 · specularDraw 5293 · specularIslandBake (specular-surface-subsystem.js:237) · drawDust 5322 · drawGusts 5327.
post: bloom.uniformPush/bright/downsample/upsampleCore/upsampleAtmo/composite 5349/5368/5375/5397/5406/5418 · dof.uniformPush/downsample/composite 5443/5454/5468.
present.blit 4769.
residency/depth: residency.pass 11782 · decode 10282 · coarsePinBudget 11242 · coverAlphaPrime 11254 · staleRelease 11343 · itemLoad 11413 · itemLoadDims 6434 · itemLoadMasks 6441 · itemLoadExisting 6374 · itemRefresh 11552 · releaseBitmaps 10355 · depth.authorityRebuild 11264 & 11329 · depth.proxyRebuild 11599 · vegetation.rankStamp 11278 · vegetation.depthItemsBuild 11319.

## 5. Unclaimed files

Empty — all 259 runtime files assigned. Qualifiers: `effects/debug-channel-select.js` (cross-effect shared), `effects/sky-access.js` + `effects/shadow-access.js` (world-shaped handles physically in effects/ — placement UNVERIFIED as intentional).

## 6. tools/ relevant to perf/verification

trace-analyze.mjs (+test) · verify-structure.mjs (+test, ratchets/exceptions/uniform-budgets JSON) · reachability.mjs (+test) · run-tests.mjs (+test) · point-light-census.mjs · make-torture-world.mjs · foundry-server-boot.mjs · scene-import.mjs · harvest-params.mjs · build-three-webgpu.mjs · shader-lab/ (serve.mjs, lab.js, contract.js, view-visibility.js, 13 bench-*.js + paired *-lab.js, fixtures/tower-bridge.js, runs/) · tests/playwright/ (perf-bench.spec.js, perf-effects.spec.js, perf-utils.js, foundry-launcher.js, map-shine-utils.js, msa-look.spec.js, msa-ground-floor-shot.mjs, msa-import-real-mansion.mjs, msa-verify-import.mjs).

**Stale (verified 2026-08-15):** `package.json` scripts `build:tsl`, `release`, `release:test`, `chart:generate`, `preset:insight`, `audit:controls` reference `scripts/build|release|tools/` — **no `scripts/` directory exists in the repo.**

## 7. Excluded-by-design trees

`legacy/` (frozen V2, 483 files, import-fenced) · `FoundryVTT/` (installed v14 Electron distro, harness target, gitignored) · `gamesystemsourcecode/`, `othermodules/` (third-party read-only refs, gitignored) · `dist/`, `node_modules/`, `module-staging/`, `chrome-performance-traces/`, example-map fixtures.
