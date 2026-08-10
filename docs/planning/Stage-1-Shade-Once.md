# Stage 1 — Shade Every Pixel Once: THE PLAN

**Status: PLAN OF RECORD for Book I Stage 1. Created 2026-08-10 by Claude Fable 5, at the
author's command, against the real code (every symbol below was read this session, not
recalled).** The Testament's Stage 1 checklist is the working state; this document is the
engineering design it executes. Companion facts: `Moonshot.md` §5/§7.

**The goal, restated:** the world draw rasterizes every overlapping opaque layer at every
pixel because the colour pass runs `depthTest:false` with a `maskNode` texture-lookup discard
as its only occlusion — which still launches the shader for occluded fragments and disables
hardware early-Z. Stage 1 makes the already-existing depth authority the *hardware* occlusion
for the colour pass, so occluded interior fragments are skipped before shader launch.
**Gate: `geometry.worldDraw` 26.6 → ≤ 8 ms GPU** (the §5 4K/upper-floor regime).

---

## 1. The construction — why `EQUAL` can be exact, by construction

The depth pass (`runSceneDepthPass`) renders proxy meshes that **share the item's own
`t.geometry`** (world-space vertex positions baked into the geometry; the proxy adds only its
own `position.z = rankToDepthZ(rank, maxRank)`), through a dedicated
`OrthographicCamera` whose parameters are exported constants: `DEPTH_PASS_CAMERA_Z = 5`,
`DEPTH_PASS_NEAR = 0.01`, `DEPTH_PASS_FAR = 10` (`vt/scene-depth.js`), with X/Y frustum set
per-frame from the SAME `computeCameraFrustum(rect)` the world camera uses.

For the colour pass to produce **bit-identical window depth** (the precondition for
`depthFunc: EQUAL`), it must run the identical transform:

1. **Colour tile meshes take `position.z = rankToDepthZ(rank, maxRank)`** — the same value
   their depth proxies already use, set in the same residency pass that already refreshes
   `t.uExpectedDepth` (`rebuildSceneDepthProxies` and the residency loop share the rank).
2. **The colour pass renders through the depth camera's parameters.** ⚠️ NOT by mutating the
   world camera — `scene-depth.js`'s own header explicitly warns that the world camera's
   `near=-1/far=1 @ z=0` is consumed by other passes (the occlusion mask pass renders discs
   with it, and its screenUV alignment guarantee depends on shared X/Y framing only). The
   world camera object stays untouched for every other consumer; `runGeometryWorldPass`
   simply renders the scene with a camera carrying the depth pass's own Z parameters and the
   same per-frame X/Y frustum. Existing `z=0` members (tokens, doors, water, Case-2 overlays)
   sit mid-frustum under those parameters (depth ≈ 0.4995, unclipped) and keep
   `depthTest:false`, so nothing about their rendering changes.
3. **Same vertex path** — neither the proxy material nor `buildWholeImageMaterial` has a
   `positionNode`, so both compile three's standard transform chain: identical matrices in,
   identical `gl_Position` out. (Vegetation-material tiles DO have a `positionNode` — they
   are excluded; see §3.)

Draw ORDER is preserved exactly: each tile's interior/boundary meshes occupy the tile's
existing painter slot (interior sub-ordered just before its boundary sibling). `EQUAL` is
order-independent, so interleaving interiors through the painter sequence costs nothing —
and every `depthTest:false` member (tokens, doors, water, Case-2 canopy) keeps today's
draw-over-what-came-before semantics untouched.

## 2. Interior certification — why the existing coarse grid CANNOT do it

Byte-stability demands interior fragments have **source alpha exactly 255**: today a
topmost-opaque fragment lands as `src.rgb·a` (blended over discarded-below = clear); an
unblended draw lands `src.rgb`. Only `a ≡ 1` makes those equal.

The existing coarse alpha grid is a **box-averaged mean** (`createImageBitmap` resize —
`coarse-alpha.js`'s own doc: "a texel's value is the FRACTION of it that is opaque").
A mean texel of 255 does not certify min=255: at ~23²px/texel, one 254-alpha pixel among
529 still rounds to 255. **A mean cannot certify a min** — same bug class as
"an aggregate cannot name the source."

**The sound source:** `bc-compress.worker.js#handle()` already walks every source pixel in
512-row bands (the full-pass alpha scan that produces `alphaStats`). A per-texel **MIN grid**
at `coarseAlphaGridDims` resolution accumulates in that same loop for one extra pass over
each band (~free next to the BC encode). Cache format bumps to **v10** (`alphaMinGrid` field;
the cache is ALREADY at v9 — the 2026-08-06 multi-mode encoder — checked, not assumed);
v9 records fail-open — no min grid → no interior split → today's pixels, no win, no harm —
and re-encode on their normal validation cadence (one-time ~52s/map cold cost, flagged).

## 3. The split, and who is eligible

`splitCoverageCellMask` (new, `vt/coverage-mesh.js`) partitions the existing kept-cell mask:
**interior** = kept cell whose min-grid texels are ALL 255 (the cell→grid-rect mapping is the
builder's own, `ceil`-overlapped — one texel of overlap into neighbours automatically
demotes edge-adjacent cells to boundary, which also covers bilinear filter reach at ~23px
resolution vs the filter's ~1px); **boundary** = every other kept cell (the dilation ring
lands here by construction — its texels touch alpha 0).

- **Interior mesh:** `depthTest:true`, `depthFunc:EQUAL`, `depthWrite:false`,
  `transparent:false`, no `maskNode`, no discard anywhere in the shader.
- **Boundary mesh:** exactly today's blended material minus `maskNode`, plus
  `depthTest:true, depthFunc:LessEqualDepth, depthWrite:false` — a fragment under a
  recorded-opaque surface early-Z-skips (replacing the discard's job); a fragment that IS or
  is above the recorded surface blends exactly today's math.

**Excluded from the split entirely** (keep today's single mesh, minus `maskNode`, depth
test off — pixels preserved by painter order, the discard's savings forgone):
1. **Vegetation-material tiles** (`vegActive`) — live `positionNode`; the depth-proxy-
   animation parity rule makes them correctness-critical to leave out (the code already
   excludes them from `uExpectedDepth` — same precedent, same reason).
2. **Occlusion-responsive items** (any nonzero occlusion weights — roofs/overheads): their
   per-pixel token-fade multiplies OUTPUT alpha at runtime; fade ≠ solidity, and fade needs
   blending. (Their painted area is 1-4% of canvas — the fill win lives in floors, which
   don't fade.)
3. **Raw-fallback tiles** (no `alphaStats`/`alphaMinGrid` — opacity unknown; fail open).
4. **Single-quad fully-opaque items** stay on their fast path; they may take the interior
   STATE (EQUAL/unblended) only when `alphaStats.min === 255` (Ground qualifies; a
   min-in-[threshold,255) item does not — its alpha < 1 needs blending).

## 4. Sharing the depth attachment

`sceneColor` (the MRT colour target) must bind `buf:scene.depth`'s own `depthTexture` as its
depth attachment, cleared by the depth pass only — never by the colour pass.

- **Allocator extension** (`graph/three-allocator.js` — the one door;
  `gpu/allocator-only` stays intact): a descriptor field to REFERENCE an existing
  depth texture rather than create one; resize keeps the single shared texture consistent
  (sized once, by its owner `sceneDepth`); dispose must not double-free.
- **Clear discipline:** the world pass clears COLOUR only. Audit the current clear path
  (autoClear vs explicit) before wiring; the door render into the same target already
  proves the no-clear composite pattern.
- ⚠️ **WebGPU validation constraint, load-bearing:** a texture cannot be a pass's depth
  attachment AND a sampled binding in the same pass. Today `maskNode` SAMPLES the depth
  texture during the colour pass — so sharing is only legal once `maskNode` is gone. The
  revert flag therefore flips the WHOLE composition mode (camera + meshes + materials +
  attachment + maskNode) as one unit; there is no legal half-way state.
- **Verified in the lab BEFORE live wiring** (`bench-scene-depth.js` scenario 7): pass A
  writes depth through the proxy material; pass B binds the same depth texture with a
  colour-material clone at the same Z and `EQUAL`; assert full coverage (bit-exactness of
  the shared transform) and zero validation errors. This retires the two biggest unknowns
  (API viability + EQUAL precision) for minutes instead of live-loop hours.

## 5. The revert flag, and defaults

`earlyZComposition` — one boolean, read at material/mesh build time, toggled via the standing
`MapShine.setXxx` wrapper pattern, rebuild via the existing refresh path. **Default OFF while
building; flipped ON only after the pixel-diff gate passes** (Law 3: `standard` keeps
today's pixels — satisfied by *proof of identity*, not by assertion), with the flag kept as
the permanent revert (Law 5).

## 6. Gates

1. **Pixel-diff** (harness, one session): freeze time (time-authority rate 0), capture the
   world buffer via the display-layer debug view with flag OFF → toggle ON (same session,
   same camera) → capture → in-page canvas diff. Interior: zero differing pixels. Boundary:
   tolerance-only (16f blend LSBs). ⚠️ One HONEST known diff, flagged now: where a token
   stands under a faded occludable item, maskNode-discarded under-content previously left
   void; painter-covered content now shows through the fade — verify in code whether this
   case is reachable, and show the author (bench world has no tokens, so the automated gate
   is clean either way).
2. **Bench** (`perf-run-full`, uncapped, 4K viewport, First-Floor — §5's regime): gate
   `geometry.worldDraw ≤ 8ms` GPU. Under 2× win → STOP per the Testament's amended
   reconcile clause (idle-machine A/B re-runs first).
3. **Author LIVE verdict** — both floors, full zoom range, on the Mansion. Theirs alone.

## 7. Step order (the Testament checklist mirrors this)

S1.1 min-grid (pure accumulator + worker + v10 + plumbing, fail-open) →
S1.2 coverage split (pure, tested) →
S1.3 allocator sharing + lab scenario 7 →
S1.4 live wiring behind the flag (camera, dual meshes, materials, attachment, clears) →
S1.5 pixel-diff gate → S1.6 bench gate → S1.7 default ON →
S1.8 author LIVE verdict.

**Out of scope, explicitly:** tokens/doors/water/Case-2 draw exactly as today; the light
stack (Stage 2); the Case-2 rank gap (Pillar 8); any change at `earlyZComposition:false`.
