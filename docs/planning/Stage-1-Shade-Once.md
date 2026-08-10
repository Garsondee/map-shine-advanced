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

## 4. The depth attachment — single-target prepass *(REVISED 2026-08-10, same day)*

**The original design here — `sceneColor` binding `buf:scene.depth`'s own `depthTexture` as
its depth attachment — is DEAD, proven so on the real device before any live wiring** (the
whole point of the scenario gate): `bench-scene-depth.js`'s first run showed a second target
referencing another target's depth texture gets NO usable depth on three r0.185.1's WebGPU
backend, and it fails SILENTLY — zero validation errors, just black (a `LessEqualDepth`
probe drew nothing anywhere). The author's independent research the same afternoon pointed
at the same backend limitation (threejs discourse #90036: GPU resources are managed per
RenderTarget; cross-target sharing does not resolve). The scenario now PINS the dead share
(`cross-target-share-stays-dead-pin`) — if a future three upgrade makes it work, the pin
fails loudly and the cheaper design reopens for the Stage-6 keel.

**The shipped design — the single-target prepass** (the backend's recommended shape, and
scenario-proven 9/9 green including zero-epsilon EQUAL):

- `sceneColor` (flag ON) is built with **its own `depthTexture: true`** — the allocator's
  EXISTING capability; no extension needed (the one built for sharing was deleted the same
  session, with a tombstone comment in `create()` and an absence-pin test).
- **Frame order becomes three renders:** (1) today's `sceneDepth` pass, UNCHANGED — the
  payload (floor/flags) colour + its own private depth (which may drop to a non-samplable
  renderbuffer, `depth: true`, since nothing samples it any more); (2) **the prepass**: the
  SAME proxy scene rendered again into `sceneColor` with `colorWrite: false` on its
  materials — depth lands, colour untouched (scenario check: zero colour bytes); this
  render carries the frame's world clear (colour + depth); (3) the world pass into
  `sceneColor`, nothing cleared (`autoClearDepth` AND `autoClearColor` false — both proven
  load-bearing), interiors `EQUAL`, boundaries `LessEqualDepth`.
- **`querySceneDepth` consumers migrate their texture handle**: the samplable depth becomes
  `sceneColor.depthTexture` (same rank-depth convention, same values the proxies write).
  Flag OFF keeps today's arrangement exactly — the handle switch rides the flag's rebuild.
- **Named cost, honestly:** one extra `renderer.render()` per frame of the ~6-draw proxy
  scene. The depth pass's own render call carries the unexplained 3.4–7.5ms CPU cost
  (Stage 0's measurement); the prepass may pay a sibling tax. This is measured at S1.6's
  bench, not guessed; if it eats the win, the reconcile path runs. (The prepass reuses the
  SAME `depthScene` object — no rebuild, no new proxies.)
- **A non-participant discipline the depth attachment makes correctness-critical:** every
  `depthTest:false` world member (tokens, doors, water, Case-2) must ALSO set
  `depthWrite:false` — a z=0 member silently writing ~0.4995 into the depth buffer would
  punch EQUAL-failing holes into any interior drawn after it. Sweepable, testable, part of
  S1.4's parity checks.

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
S1.3 lab scenario: single-target prepass + zero-epsilon EQUAL proven; dead share pinned →
S1.4 live wiring behind the flag (camera, prepass, dual meshes, materials, clears,
     depthWrite:false sweep, consumer handle migration) →
S1.5 pixel-diff gate → S1.6 bench gate → S1.7 default ON →
S1.8 author LIVE verdict.

**Out of scope, explicitly:** tokens/doors/water/Case-2 draw exactly as today; the light
stack (Stage 2); the Case-2 rank gap (Pillar 8); any change at `earlyZComposition:false`.
