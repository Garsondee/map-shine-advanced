# Reckoning opening survey — FLOOR BEHAVIOR: what "standing on an upper floor" schedules

*Captured 2026-08-15 by Claude Fable 5 via a read-only scout pass, for `docs/holy/V4-Reckoning.md`.
Treat as a MAP for pass R-16 (and R-27/R-05), not countersigned fact. Inferences marked UNVERIFIED.*

## 0. There are TWO floor authorities, not one

| # | State | Owner | Written by | Read by |
|---|---|---|---|---|
| A | `activeFloorContext` — {elevation, floorIndex, band, levelId} | boot.js | `updateActiveFloorContext()` | boot-side seams (anchors, doors, masks, reports) |
| B | `view.floorIndex` — integer in the viewer's `view` | vt-pan-viewer.js | `setFloorIndex()` | every per-frame render path |

A declared boot.js:1011 (siblings `lastKnownFloors` :1015, `coverItems` :1023); written :1030-1053; re-synced `syncActiveFloorContext` :1078-1085; scene-load write :6582; same-scene switch write :8295; painter stepper wiring :736 → ui/paint-mode.js:206; debug-panel action :3431-3437 (restore :3527-3528).
B declared vt-pan-viewer.js:12233-12240; written ONLY at :12035 inside `setFloorIndex` (:12026-12068; asserted in-source :12049-12050). The seam is deliberate and documented (boot.js:1059-1077; ui/paint-mode.js:188-189) — `setVtPanViewerFloor` (:15420-15424) moves B and knows nothing about A.

**activeFloorContext consumers (boot.js unless noted):** refreshDoors :1384-1387 (levelId door scope) · fire registration :1133 · candle anchor floorBinding :1505-1506 · lightning endpoint :1629-1630 · per-frame memos: `getCandleRenderState` :2310-2324, `getLightningRenderState` :2379-2386, `getFireRenderState` :2598-2642 · `sampleWindExposureAt` :2690 · diagnostics/reports/panels: :2841, :2863, :2927-2928, :4083, :4097, :4121, :4136, :4360, :4378, :4436, :4546, :4565, :4617, :4693, :4700, :5206, :5224, :5299, :5417, :5664. Anchor floor filter: `floorMatches` scene/anchor-authority.js:453-467 via anchorsForEffect :161-170.

**view.floorIndex consumers (vt-pan-viewer.js):** :2758 (region gating) · :3111-3126 (outdoors/fire bakes) · :3308-3311 (wind level) · :4767, :4869 (sun-shadow debug/fallback) · :4892/:4899 (water) · :4904 (fluid) · :5123 (window fallback) · :5287 (specular) · **:5440/:5445 (DoF gate)** · :7313, :8184, :8215, :9479, :9492 (floor-attr) · :10932, :11265 (draw-list rebuild) · :12634, :12645.

## 1. What renders when the active floor is an upper floor

**Rule: MSA composites floors, replicating Foundry v14 `Level#isVisible`** (module header vt-pan-viewer.js:31-49). The gate: `computeVisibleFloorIndices(floors, viewedIndex)` — foundry/active-scene-source.js:280-288. Viewed floor always included (:285); any OTHER floor only if the viewed floor's own `visibility.levels` names it. Deliberately asymmetric (:268-272). A floor ABOVE the viewed one normally gets no item built at all (vt-pan-viewer.js:5138-5142).

Applied in `buildItems(viewedFloorIndex)` boot.js:6597-6613 → `collectSceneLayers` :6606, `collectTokens` :6611. Level-art gating: scene-layers.js:265-326 (isVisible :276, the cut :286). **Tiles — deliberate divergence:** a tile draws if ANY currently-visible level includes it (scene-layers.js:332-341 rationale; :366 implementation) — an upper viewpoint pulls in every lower visible floor's furniture too.

No dimming/desaturation of lower floors (alpha:1 unconditional :309; tint authored-only :310). Non-viewed art above the viewed bottom gets occlusion.modes=2 (:314). `isUpper` computed at :317 — **no runtime consumer found** (only doc :222/:240, constant false :412, fixture boot.js:6332) — UNVERIFIED as dead beyond grep. The one real cross-floor visual treatment: **DoF blurs floors below the viewed one** (effects/depth-of-field-render.js:152-167).

**Overdraw note (load-bearing):** every draw runs depthTest:false except the depth pass — vt-pan-viewer.js:4598-4600 records a live measurement: a 12K-map upper floor colour pass at 133ms GPU mean from 22 draw calls — "every overlapping opaque layer at a pixel was fully shaded, always." Mitigation = earlyZComposition (:9783) + maskNode reject (:7268-7273), but the reject is a texture-lookup discard which itself disables hardware early-Z for the whole shader (:9765-9767); only certified `interior` tiles get the discard-free EqualDepth path (:10609-10665, :10757).

## 2. Per-frame paths that loop over floors or branch on floor index

### Loops over floors
1. `getActiveSceneFloors(canvas.scene)` — full scene.levels walk + sort + per-floor allocation, once per frame — call vt-pan-viewer.js:4795; body active-scene-source.js:193-234.
2. Sun-shadow bake check EVERY scene floor — :4867.
3. Sun-shadow slot→floor uniform push, all 6 slots every frame — :4877-4879 (SUN_SHADOW_MAX_FLOORS=6, sun-shadow-subsystem.js:341).
4. Window-surface prune of stale floors — :5130-5136.
5. Window-surface sync + RENDER, one per floor — :5137-5165 (rank===null guard :5160-5161).
6. Per-floor maybeBake internals: `getSunShadowRenderState()`, `JSON.stringify(state.params)`, `getMaskAuthorityVersion()` — PER FLOOR PER FRAME — sun-shadow-subsystem.js:1261, :1300, :1309.

### Loops over `itemStates` (grows with every floor ever loaded; NEVER reaped — created :6089, only mutations :6462 set; stale items hidden :11350/:11361-11364, never removed)
7. `runMaskOcclusionPass` uOcclusionElevation refresh over every item state — :6070-6080.
8. occluder gather over lastItems — :5993-6016.
9. `syncTokenPlacements()` every item state every frame — :6661-6680 (:10078).
10. `syncAllVegetationMotionForFrame()` every item × tiles × veg kinds — :9401-9431 (:4970).
11. `syncAllFloorAttrUniformsForFrame(floorsResult)` every attr item, re-resolving floor membership per item — :9463-9501 (:4979); body `computeFloorAttrValues` scene-attr.js:611-751 (floors.find :661, band resolve :664, second epsilon band resolve :699-700).

### Branches on floor index
12. **post.dof skipped entirely on ground floor** — `if ((view?.floorIndex ?? 0) === 0) return;` :5440.
13. Region-darkness elevation filter — :2758, :2765-2767.
14-17. Water body :4892 · water surface :4899 · fluid :4904 · specular :5287 — viewed floor each.
18. Sun-shadow debug quad :4765-4768. 19. Window rank guard :5159-5161. 20. Anchor memos keyed on activeFloorContext identity — boot.js:2315, :2379, :2611.

### Per-fragment floor work (fixed cost)
`blendSunVisibilityAcrossFloors` — one node per slot, arithmetic blend, no early-out (environmental-light.js:456-471, slots :394-402); slot count fixed 6, NOT scene floor count (sun-shadow-subsystem.js:1435-1475) — identical both floors. DoF composite 2× pickMip cascades of 4 taps per fragment (depth-of-field-render.js:134-140, :162) — upper floors only.

## 3. Per-floor instantiation vs singletons

| Subsystem | Per-floor? | Count | Cite |
|---|---|---|---|
| Sun-shadow field slots (RT + caster tex + bake material; slot N reads N-1) | fixed pool | ALWAYS 6, eager | sun-shadow-subsystem.js:341, :1435-1475 |
| Sun-shadow rect/floor uniforms in illum + every point-light material | yes | 6 | environmental-light.js:394-402 |
| **Window-light surface (own scene, mesh, material, mask texture)** | **lazy per floor** | one per floor passing rank guard; pruned | vt-pan-viewer.js:6924-6980, prune :5131-5135 |
| Level art/foreground/tiles/tokens (`itemStates`) | per drawable | unbounded, never reaped | :6083-6089 |
| Layer packs (VT) | per item×layer | | :6174-6198 |
| Depth proxies + prepass twins | per drawable | rebuilt per residency pass | :10910, :10832-10856 |
| Specular | singleton (one floor's quad) | 1 | :5287; specular-surface-subsystem.js:300-303 |
| Water body+surface | singleton with cross-floor BORROW | 1 | :4892/:4899; water-floor.js:37-68 |
| Fluid | singleton (mesh per masked item) | 1 | :4904 |
| Point-light pool | singleton; lights carry elevation RANK not floor slot | 1 | point-light-pool.js:1042, :165-176 |
| Candle/lightning/fire | singletons, anchor list filtered by active floor | 1 each | :4962, :4948, :10184 |
| Occlusion RT + disc pool · bloom chain · DoF chain · outdoors/fire-mask textures · wind field | singletons (bakes for viewed floor) | 1 each | :6054, :5343, :2273, :2076/:2141, :3184 |
| Door leaves | active floor's levelId only | | boot.js:1384-1387 |
| Depth-proxy material pool keys include floorIndex | more distinct floors ⇒ more pipelines | | depth-proxy-material-pool.js:132/:135 |

## 4. Work that runs ONLY when viewing from above

1. **The entire post.dof pass** — ground: one compare + return (:5440). Upper: 4 uniform writes + 4-step downsample pyramid (4 RT binds + 4 fullscreen 13-tap draws :5455-5461) + fullscreen NormalBlending composite sampling 2 mip cascades ×4 taps (:5468-5474; shader depth-of-field-render.js:134-170). Declared purpose :5432-5435.
2. **Lower floors' entire draw stack** — background + foreground (scene-layers.js:286) AND all tiles (:366) → buildItems (boot.js:6605-6612) → depthAuthority.rebuild (:11265) → visible meshes. Each adds a draw in geometry.world (:4670/:4680), the prepass (:4637), AND runSceneDepthPass (:4748) — each un-certified layer costs a full-screen fragment pass (discard reject :9765-9767).
3. **N× window-light sync+render instead of 1** — rank guard :5160-5161 means viewing ground = 1 iteration; viewing floor N = every visible floor: seam scan (window-seams.js:93-96), rankOf, sync (window-surface-subsystem.js:387-400 → getWindowMaskUrl → maskAuthority.authoredStatus, window-seams.js:64-68), and a `renderer.render(windowSurface.scene, camera)` (:5164) each.
4. **Extra anchors served** — `floorMatches` widens UPWARD only: 'own-and-above' anchors serve viewers above their band, never below (anchor-authority.js:461-465). Candles/fires/bolts accumulate as you climb (each a light in pointLights.update + a sprite draw). Ground never pays this.
5. **Water borrows from below** — upper floor with no local water resolves to nearest lower pack (water-floor.js:54-61). Same cost, different source.
6. **Bigger itemStates loops** — the 4 sweeps in §2 scale with everything ever loaded; upper-floor draw list is a superset; nothing removed.
7. **Shadow cascade** — slot N samples slot N-1 (sun-shadow-subsystem.js:1441-1443/:1462); lower rebake dirties every slot above (:1317-1323, 'cascade' :1328). UNVERIFIED as viewed-floor-dependent — the maybeBake loop runs over every scene floor on both views; no code path found making the cascade viewed-floor-dependent.
8. **No delta found (checked):** occlusion pass :5989, bloom :5343, particles/gusts :5310-5333, wind sim :3889, fluid sim :4002, doors (active floor only, boot.js:1386), sun-shadow slot count + per-fragment blend (fixed 6).

## 5. THE CONTRAST TABLE (V = visible floors composited, F = scene floors, I = |itemStates|)

| Work | ground (0) | upper (looking down) | cite |
|---|---|---|---|
| post.dof | not run (1 compare) | full pass: 4 RT binds + 4 downsamples + fullscreen composite (8 mip taps/fragment) | :5440; :5443-5476 |
| Window light floors iterated | 1 | **V** (each: seam scan + rankOf + sync + render) | :5137-5165 |
| Window subsystems alive | 1 | **V** (lazy, cached, pruned only on floor-list change) | :6924-6980 |
| geometry.world colour draws | viewed floor's items | + every visible lower floor's background/foreground/tiles | scene-layers.js:286/:366; boot.js:6605-6612 |
| Early-Z prepass draws | same set | same (larger) set | :4637 |
| scene.depth proxy draws | same set | same (larger) set | :4748 |
| Fullscreen overdraw | 1 world-covering layer | **V** layers, fully shaded unless interior-certified | :4596-4604; :9765-9767 |
| itemStates loops ×4/frame | I = ground items | I = union of floors ever visited | :6070, :6661, :9401, :9463 |
| getActiveSceneFloors · sun maybeBake · per-floor stringify · slot push · per-fragment slot blend | F / F / F / 6 / 6 | same — **no delta** | :4795, :4867, ss:1261/1309, :4877 |
| Specular/water/fluid | 1 floor each | 1 floor each (water may borrow) | :5287, :4892, :4899, :4904 |
| Anchors served | own floor | + every lower 'own-and-above' | anchor-authority.js:461-465 |
| Doors | active floor | active floor — no delta | boot.js:1384-1387 |
| Region darkness | floor-0 band regions | viewed band regions | :2758 |
| Depth-proxy pipeline key-space | 1 floor | **V** floors | depth-proxy-material-pool.js:132 |

**Net delta shape:** one unconditional new pass (DoF) + one V-scaled sync/render loop (window light) + a V-scaled draw list feeding three scene renders with V-scaled fullscreen overdraw + a monotonically growing itemStates walked 4×/frame + a widening anchor set. Everything else is F-scaled or fixed (identical both floors).

## 6. Floor-SWITCH one-time costs (keep distinct from steady state)

Entries: Foundry-native switch boot.js:8290-8302 (updateActiveFloorContext :8295 → refreshDoors :8298 → setVtPanViewerFloor :8299 → syncInterfaceSeam :8301; no curtain :8291-8293) · painter stepper ui/paint-mode.js:206 → boot.js:736/:1078-1085 · debug panel :3431-3437. All funnel to `setFloorIndex` (vt-pan-viewer.js:12026-12068): settle reset :12034 · view assign :12035 · **bakeWindField('floor-change')** :12057 (bake :3184, wall scoping :3270-3311) · **bakeOutdoorsTexture** :12063 (:2076-2132) · **bakeFireMaskTexture** :12065 (:2141-2183) · **await scheduleResidencyUpdate()** :12066.

Residency pass internals (`updateResidencyUnguarded` :11235): refreshCoarsePinBudget — `buildItems(f)` for EVERY floor 0..N-1 (:11243; :6153-6170) · primeCoverAlphaGrids — every floor's art (:11255; rationale :11245-11253) · depthAuthority.rebuild(buildItems(view.floorIndex)) :11265 · stampVegetationRenderOrders :11279 · second getActiveSceneFloors + buildVegetationDepthItems + second rebuild :11320-11331 · stale release :11343-11364 · finishResidencyPass → per-item refresh incl. BC compression for newly-entering floors :11543-11588 · **rebuildSceneDepthProxies (wholesale depthScene + depthPrepassScene rebuild)** :11600/:10910.

Boot-side: context reassign invalidates all three anchor memos at once (:2315/:2379/:2611; rationale :2282-2292); refreshDoors re-reads for new levelId; canvasInit proxies idempotent (:7086-7098).

Deliberately NOT paid on switch: no viewer restart/atlas realloc (:12016-12022), no curtain (:8291-8293), coarse pins permanent (:11339-11342), adjacent ±1 floors pre-compressed at startup (:12480-12505).
