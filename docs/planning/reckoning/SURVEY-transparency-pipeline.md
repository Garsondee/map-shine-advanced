# Reckoning opening survey — THE TRANSPARENT-vs-OPAQUE IMAGE PIPELINE

*Captured 2026-08-15 by Claude Fable 5 via a read-only scout pass, for `docs/holy/V4-Reckoning.md`.
The author's directive made this the campaign's first target. Key claims spot-verified first-hand
(material defaults :7253-7257; `canSplit` :10659 vs depth gate :11181; writer variants
scene-depth.js:470-485). Treat as a MAP for pass R-08/R-09/R-10, not countersigned fact.*

## 1. Where the three Foundry image sources become items

All three collapse into ONE item taxonomy before any THREE object exists.

- **Level background/foreground**: `src/foundry/scene-layers.js:265` `collectLevelTextures`, items at :297-320. `kind: 'levelBackground'|'levelForeground'`, `alpha: 1`, `alphaThreshold: cfg.alphaThreshold ?? 0.75` (:311). Background takes `elevation.bottom`, foreground `elevation.top` (:296); zIndex 0 vs 1 (:304).
- **Tiles**: `scene-layers.js:358` `collectTiles`, items at :377-415. `alpha: (tile.alpha ?? 1) * (hidden ? 0.5 : 1)` (:403), `alphaThreshold: tile.texture?.alphaThreshold ?? 0.75` (:405), occlusion modes packed :407.
- Merged at `scene-layers.js:457` `collectSceneLayers`. Placement: `scene-layers.js:495` → `scene-geometry.js:266` `computeLevelTexturePlacement` (level art fitted to `dimensions.sceneRect` — FULL-MAP footprint) or :312 `computeTilePlacement`.
- **No per-kind branch in mesh/material construction** — all three route through `vt-pan-viewer.js:11579` `ensureWholeImageMeshes`. `kind` is later only a depth-payload flag bit (`scene-depth.js:313-315`) and a diagnostic (:15171).

## 2. Creation sites

Compressed path (vt-pan-viewer.js): texture :8620 (`CompressedTexture`, BC1/BC7 :8616) · material :8640-8647 → `buildWholeImageMaterial` · geometry :8648 · filled :8699-8708 `setTileGeometry` · mesh :8709 (frustumCulled=false :8710, renderOrder :8712, scene.add :8714). Raw fallback: :8771/:8818-8824/:8825/:8840/:8841-8846.

Depth-authority proxy (second object set, SHARING `t.geometry`): :11180-11203, from `scene-depth.js:409` `buildSceneDepthWriterMaterial` + :505 `buildSceneDepthProxyMesh`. Prepass twin (third set, same geometry again): :10832 `addDepthPrepassTwin` → `depthPrepassScene` (:10856).

## 3. Material configuration

### 3a. Colour material defaults (vt-pan-viewer.js:7253-7257) — VERIFIED FIRST-HAND
```
material.transparent = true
material.depthTest   = false
material.depthWrite  = false
material.side        = THREE.DoubleSide
```
Blending: three's default NormalBlending (never set explicitly). `maskNode` (:7268-7273): `querySceneDepth(...).isAtOrBelow` — this IS the discard (NodeMaterial#setupDiffuseColor runs `bool(maskNode).not().discard()` first, :7173-7180). It kills hardware early-Z on the colour draw. No `alphaTest` anywhere on the colour material — alpha only via colorNode `c.a` × uAlpha × occlusionAlphaFactor (:7298-7302). `mrtNode` (:7310-7319) writes `buf:scene.attr` fed by `physicalSolidityAlpha` (:7251) — a SEPARATE `texture(tex,uv).level(float(0)).a` sample, LOD-0 pinned, deliberately NOT carrying the occlusion fade (:7193-7251: "the roof did not move, only its RENDERING did").

### 3b. Colour material states — `applyEarlyZTileState` (:10643-10737)
| state | transparent | depthTest | depthFunc | depthWrite | maskNode |
|---|---|---|---|---|---|
| legacy (flag OFF) :10680-10685 | true | false | LessEqual | false | restored |
| interior :10691-10699 | **false** | **true** | **EqualDepth** | false | **null** |
| passthrough :10700-10722 | true | false | LessEqual | false | restored |
| split (slot 1 = boundary) | same as passthrough | | | | |

Split slot 0 = separate material `ensureSplitInteriorMaterial` (:10760): transparent=false, depthTest=true, depthWrite=false, EqualDepth (:10768-10771), no maskNode, SHARES colorNode/mrtNode/positionNode by reference (:10764-10766). Material shape set at :10735: `[interior, boundary]` array or single. `sweepWorldSceneDepthWrites` (:10794) forces depthWrite=false on every world-scene material when the flag is on.

### 3c. Depth-writer material (scene-depth.js:409-487) — VERIFIED FIRST-HAND
side=DoubleSide, transparent=false, depthTest=true, depthWrite=true, LessDepth (:421-425). TWO STRUCTURAL VARIANTS:
- `alwaysOpaque || !tex` (:470-473): `fragmentNode = vec4(uFloorIndex, 0, uFlags, 1)` — no texture sample, NO discard, **early-Z alive**.
- otherwise (:474-485): `texture(tex).level(0).a` then `a.lessThan(uAlphaThreshold).discard()` — **early-Z dead for the whole shader** (mechanism comment :453-469).

## 4. THE KEY QUESTION — four independent alpha classifications

1. **Whole-image scan → format + alphaStats** (compile-time, worker): `bc-compress.worker.js:487-521`. opaque = no pixel a≠255 (:502) → **BC1 if opaque, BC7 if not** (:521); `alphaStats={min,max,mean}` (:519).
2. **Whole-image `alwaysOpaque`** (per residency pass): `vt-pan-viewer.js:11097` — `alphaStats.min/255 >= (item.alphaThreshold ?? 0.75)`. Governs the depth-writer variant. Bar is ≥0.75, not ===1.
3. **Whole-image `interior` verdict** (colour): :10609-10632 `earlyZInteriorVerdict`. Order load-bearing: vegetation → occlusionResponsive → authoredAlpha → noAlphaStats → **`alphaStats.min !== 255` = 'alpha'**; min===255 → interior.
4. **THE PER-CELL SPLIT (S1a)**: min-alpha grid ≤512px long side (`coarse-alpha.js:60`), built in the same worker scan (:158/:180, from bc-compress.worker.js:508-517; the mean-cannot-certify-a-min argument :128-147). Cell classification `coverage-mesh.js:255` `splitCoverageCellMask`: cell→texel rect via `cellGridSpan` (:214, ceil-overlap), require EVERY texel === 255 (:287); else boundary (:293-299); null fail-open on unusable input or zero interior (:304). Occupancy prerequisite: `buildCoverageCellMask` (:131), threshold 4/255 (:106), keep-if-any-texel-over (:163-177), dilated 1 cell (:188/:314) — the ring lands in boundary by construction (:234-237).

**Geometry per class** (vt-pan-viewer.js:8385-8437): ONE vertex grid, ONE index buffer in two contiguous spans, two draw groups (:8421-8431: group 0 interior, group 1 boundary). No second geometry. `t.splitDeclined` records refusals: 'noCoverageMask'|'noMinGrid'|'noFullyOpaqueCells' (:8403-8411). Teardown `clearCellSplit` :8451 (reverts material array :8455).

**Which passes consume the split:**
| pass | consumes? | since |
|---|---|---|
| colour (render :4670) | yes — [interior, boundary] :10735 | S1.4-S1.7 |
| depth (`runSceneDepthPass`, render :4748) | yes — :11190-11193 | commit 94362d5 |
| early-Z prepass (render :4637) | yes — `finalMaterial = [interiorMaterial, material]` :10846-10852 | commit 94362d5 |

The fixed mechanism (stated :11151-11158): proxy+twin already shared the two-group geometry, but a non-array material draws every group with itself — the split bought the depth zones NOTHING pre-94362d5. Fix: second `{...writerArgs, alwaysOpaque:true}` writer for group 0 (:11182), pooled (`depth-proxy-material-pool.js:104-114` disambiguates on alwaysOpaque+colorWrite). Safety: interior certification (every min-grid texel===255) strictly stronger than alwaysOpaque's bar (:11160-11167).

**Two pre-existing bugs the same commit fixed** (both made S1a silently vacuous on EVERY floor):
1. `wi.alphaStats`/`wi.alphaMinGrid` assigned AFTER the first `setTileGeometry` — moved to :8690-8691.
2. Nothing re-meshed when the min-grid landed async — fixed via `t.alphaMinGrid` (:8348) in the re-mesh gate (:8927).
Live result (Bug #20): splitInteriorCells 1233, splitBoundaryCells 773, zero noMinGrid declines, 0/2,073,600 pixels differ.

### ⚠️ Discrepancy (VERIFIED FIRST-HAND) — observation, not proposal
Comment :11172-11179 claims the depth-proxy gate matches `canSplit` "exactly". It does not: depth gate = `earlyZComposition && t.cellSplit` (:11181); `canSplit` additionally requires `!verdict.interior && verdict.reason === 'alpha'` (:10659). A tile refused for occlusionResponsive/authoredAlpha/vegetation that still has a cellSplit gets a split depth proxy while its colour mesh stays single-material. SAFE in effect (the depth writer never reads uAlpha or the fade) — arguably a bonus win — but the stated invariant is inaccurate. UNVERIFIED how often that combination is live-reachable.

## 5. Geometry shape

`setTileGeometry` (:8297) is the single builder. (1) Image split into sub-tiles by hardware cap: `texture-limits.js:254` `planImageTiles` (at 16384 a 12000² floor is ONE tile). (2) NEVER cropped to content bounds — full quad vertices, fewer indices (`coverage-mesh.js:33-45`). (3) Ordinary tile promoted to 64×64 cell grid purely to have cells to drop (:8320-8322; tuning table `coverage-mesh.js:80-103`). (4) Degenerate path: no coverage grid yet → plain 4-vertex quad (:8351-8367) — the normal state on first build.

Measured coverage (author's mansion, table at `coverage-mesh.js:12-20`): Ground painted 100%; Ground_Roof painted 3.7% but rasterizing 100% pre-meshing → 6.9% after; First-Floor 33.3% painted; First-Floor_Overhead 18.2% after meshing.

## 6. Draw order / frame order

One sort law: `layer-order.js:170` `compareLayerKeys` (elevation → sortLayer → sort → zIndex → tiebreak), `sortByLayer` stamps dense `renderOrder` 0..N-1 (:201-209). Depth values: `scene-depth.js:142` `rankToDepthZ = (rank+1)/(maxRank+1)`. Colour mesh z set at :10664 every pass. Elevation→floor: `scene-depth.js:347` `resolveSceneDepthFloorIndex` (levelId membership first :319-328). Floors above/below: NO special code — "5 < 10 does the rest" (`scene-layers.js:236-238`).

Frame order (`runGeometryWorldPass` :4595, flag ON): (1) :4617 depth pass → sceneDepth, clear 1, LessDepth; (2) :4633-4637 prepass → sceneColor, carries the frame's ONLY clear; (3) :4669-4671 world draw → sceneColor, autoClear off (:4667-4668). All three use `depthCamera` (:7028-7030, synced :7056-7062) — bit-identical transforms are the EqualDepth precondition.

## 7. The hole mechanism — albedo alpha as the only "surface here" truth

**There is no explicit hole code path.** A transparent upper-floor texel fails `a < alphaThreshold` in the depth writer → discard → nothing written to `buf:scene.depth` → the next rank down wins that pixel → the colour maskNode (`querySceneDepth().isAtOrBelow`) lets the floor below draw. The hole IS albedo alpha failing the depth alpha test.

Five thresholds, five different questions (deliberately not unified):
| threshold | value | question | site |
|---|---|---|---|
| COVERAGE_ALPHA_THRESHOLD | 4/255 | anything here at all (drop cells) | coverage-mesh.js:106/:167 |
| item alphaThreshold | 0.75 default | does this OCCLUDE (write depth) | scene-depth.js:477; sourced scene-layers.js:311/:405 |
| ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD | 0.5 | physically here (buf:scene.attr) | scene-attr.js:271, binarised :251-253 |
| alwaysOpaque | min/255 ≥ alphaThreshold | can the depth shader skip its discard | vt-pan-viewer.js:11097 |
| interior certification | exactly 255 | is unblended byte-identical to blended | :10630; per-cell coverage-mesh.js:287 |

Coarse alpha also feeds CPU cover physics via :6555 `onItemAlpha`, primed for EVERY floor at :11255 `primeCoverAlphaGrids` regardless of draw list.

## 8. DIFF TABLE — fully opaque vs partially transparent (Ground.webp vs First-Floor.webp)

| Stage | Fully opaque | Partially transparent |
|---|---|---|
| Compile-time | opaque=true → BC1; alphaStats.min=255 | opaque=false → BC7; min=0 (First Floor: 66.7% transparent, 300px alpha-0 border) |
| alwaysOpaque (depth writer) | true (255/255 ≥ 0.75) | false (0/255) — note an image with min 200 would pass HERE yet fail interior |
| interior verdict (colour) | interior (min===255) | 'alpha' → split-eligible only if that is the sole objection (:10659) |
| Geometry | 64×64 grid; all cells kept → single span, no groups | occupancy+dilation drops cells; split partitions → two groups (live: 1233 interior / 773 boundary) |
| Depth prepass | one twin, one alwaysOpaque material — no sample, no discard | [interior, boundary] — group 0 discard-free, group 1 samples+discards |
| Depth pass | one discard-free proxy | [interior(alwaysOpaque), boundary] |
| Colour pass | 'interior': single unblended EqualDepth material, maskNode null | 'split': [splitInterior, boundary-blended-with-maskNode]; declined → 'passthrough' whole-tile blended+discard |
| Blending | none (src·1+dst·0 = src, byte-identical) | interior cells unblended; boundary NormalBlending |
| Early-Z | ALL THREE passes | interior cells only (post-94362d5); boundary loses it in all three |
| Cost shape | full-canvas footprint, covered fragments rejected pre-shader | pre-fix: depthDraw 9.51× / earlyZPrepass 9.77× / worldDraw 1.4× Ground (Bug #20); post-fix: opaque shape over ~61% of kept cells, boundary remainder full cost |
| Fallbacks | n/a | fail-open at every stage: no grid → full quad; noMinGrid; noFullyOpaqueCells; raw-decode → noAlphaStats, everything blended |
| Revert | — | single flag `earlyZComposition` (:9783, default true) gates colour split (:10659), depth split (:11181), entire prepass (:10833/:4629) |

**Outstanding (in-repo statement):** the post-fix multi-floor capture confirming the gap narrowed — Bug #20 is `BUILT (unverified)`; "the pixel-diff proves correctness, not speed."
