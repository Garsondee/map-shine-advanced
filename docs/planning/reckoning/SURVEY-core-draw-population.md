# Reckoning survey — WHAT POPULATES THE THREE CORE SCENES (the effects-off heretic's anatomy)

*Captured 2026-08-15 by Claude Fable 5 via a read-only scout, third sweep. vt-pan-viewer.js was
under live edit during capture (16,759→16,910 lines); its cites were re-verified post-shift but
may drift again. scene-depth.js / scene-attr.js / coverage-mesh.js / vendor cites are stable.*

## 0. The dominating structural fact

`runGeometryWorldPass` = depth pass → prepass (clear) → world draw. `depthScene` and
`depthPrepassScene` are exact 1:1 twins of the VISIBLE world tiles, **sharing the same
BufferGeometry objects** (`buildSceneDepthProxyMesh`, scene-depth.js:505-510). One visible tile
= **three rasterizations of the same triangles per frame** into three targets. The upper
floor's superset draw list multiplies all three.

## 1. World scene membership (per member: cost shape)

- Whole-image tiles (levelBackground/levelForeground/tile **and `token`** — see finding below):
  coverage mesh 65×65 verts / ≤24,576 idx or plain quad pre-grid; `transparent=true,
  depthTest=false, depthWrite=false, DoubleSide`, maskNode discard, **real attr mrtNode**;
  full quad never cropped; NOT effect-gated.
- Case-1 self-vegetation tiles: up to 129² verts / 98,304 idx; vegetation material chosen at
  BUILD time only (`vegActive`) — **disabling vegetation later does not swap it back** (accepted
  limitation); no maskNode (no early reject).
- Case-1/Case-2 vegetation shadows: padded quads with **every cell kept by design** (padPx>0 ⇒
  no coverage mask) — the shadow must hold the sun's sweep; 15 smear fetches/fragment;
  effect-gated visible.
- Case-2 canopy overlays: per (host,kind), up to 128 segments, effect-gated visible.
- Water tier-0 (2 meshes, AABB-cropped, renderOrder 0.5/0.51) and fluid surfaces (2 per item):
  effect-gated, attr mrtNode writers.
- **Nothing is ever removed from the world scene** — no `scene.remove` for any tile/vegetation
  mesh in the viewer; floor switches only set `.visible=false`. three's `_projectObject` walks
  every child every frame; `sweepWorldSceneDepthWrites` traverses ALL of them (hidden included)
  every residency pass.
- `frustumCulled = false` on everything (tiles, veg, proxies) — zero zoom-in savings; the full
  index buffer is submitted at every zoom.

### ⚠️ Tokens draw a full whole-image quad in the world scene — and the composition
### diagnostic reports the WRONG mesh for them
`finishResidencyPass` calls `ensureWholeImageMeshes` unconditionally for every item including
tokens; but `getGeometryComposition`'s token branch resolves the mesh from `occlusionDiscs`
(a DIFFERENT scene). The "what's inside worldDraw" tool therefore miscounts every token — a
live lead for the R0.2 repair (the 125× undercount).

## 2. Depth + prepass scenes

Membership: one proxy per visible tile + per visible Case-2 overlay; prepass = exact twin with
`colorWrite:false` (write-mask 0 on BOTH MRT attachments — vendored backend applies blend+mask
per attachment uniformly). Split tiles = 2-material array = 2 draws in each. Veg SHADOWS, water,
fluid have NO proxies. Materials pooled (`depthProxyMaterialPool`), signature built per request.
**`transparent=false`** ⇒ opaque sort (front-to-back) — the twins sort in a different list than
their colour originals.

### ⚠️ `alwaysOpaque` is decided by the WHOLE image's worst pixel
`alphaStats.min` is scanned over the entire source image BEFORE sub-tiling — one transparent
pixel anywhere in a 12000² background demotes EVERY sub-tile of that item to the
discard-bearing depth shader in BOTH depth passes. The per-cell split (S1a) is the counter, but
only where it engages.

## 3. Fragment cost, effects off, standard profile

Per surviving world-art fragment: **9 texture taps** — 1 depth query (maskNode, runs FIRST) +
5 albedo-clarity taps (profile-gated; 1 tap only on performance/low) + 1 unconditional
occlusion-mask screen fetch (**even when uOcclusionWeights=(0,0,0,0)** — provably cannot change
the result; a build-time fact kept as a per-fragment fetch) + 1 LOD-0 solidity tap (attr MRT)
+ 1 outdoors-mask tap when an `_Outdoors` mask exists. The in-code claim "6 taps" undercounts
by three.

MRT: both attachments (RGBA16F + RGBA8 attr) share the material's blend + write mask ⇒ a
blended fragment costs ~**24 B ROP traffic (+50% vs single attachment)** (structural, not
GPU-captured).

Layers at a mid-map upper-floor pixel (author's own coverage table): lower background (100%) +
roof/overheads (6.9-26% rasterized) + upper background (33-43%) + overheads + tiles + veg ≈
**4-6 blended layers vs 1-2 on ground** — and roofs/overheads have alpha holes BY CONSTRUCTION,
so they land in `passthrough` (blended + discard); two roofs on different floors never occlude
each other under the strictly-higher-rank rule.

## 4. Zoom dependence

Coverage meshing drops INDEX entries only — a 12000²-spanning layer is a 12000²-spanning quad
at every zoom. Two LOD-0 pins in the hot path (`physicalSolidityAlpha`; the depth writer's
alpha test — the latter paid TWICE per frame) are cache-hostile exactly at zoom-out (6-8×
minification ⇒ each fetch drags a mostly-wasted BC block), while the colour taps use implicit
LOD + aniso 16 correctly. Explicit-LOD sampling also bypasses anisotropic filtering.

## 5. CPU per frame (effects off)

Four unconditional itemStates sweeps (token sync · occlusion-elevation · vegetation motion —
**runs even with zero vegetation** · floor-attr — **unzoned**, O(visible tiles × floors)).
While the camera moves ≥1 screen pixel: a FULL residency pass per frame — `buildItems` from
live Foundry docs + **two** `depthAuthority.rebuild` sorts + stale-release over all items +
`rebuildSceneDepthProxies` (**removes 2N meshes, allocates 2N fresh THREE.Mesh + 2N-4N
signature strings per frame**) + `sweepWorldSceneDepthWrites` traversing every mesh ever added.
Parked: zero (the ≥1px filter works).

## The five structurally heaviest floor-scaled costs (ranked)

1. **The same superset draw list rasterized ×3 per frame** (depth + prepass + colour, shared
   geometry, superset = viewed + visible lower floors).
2. **Stacked `passthrough` layers the early reject cannot cull** (roofs/overheads fail
   `min===255` by construction; blended, depthTest:false, discard-bearing).
3. **Two LOD-0 pins × layers × 3 passes, worst at zoom-out** (solidity tap + depth alpha test).
4. **9 taps + 24 B dual-attachment blended RMW per fragment per layer** (profile-gated CAS +
   unconditional occlusion fetch + MRT blend on both targets).
5. **Per-frame residency + 2N depth-proxy rebuild + whole-scene traverse while panning**
   (occurrence-rate 1.0 on the touring baseline; grows with floors ever visited — nothing is
   ever removed).
