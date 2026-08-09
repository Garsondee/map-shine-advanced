# Depth of Field — blur the floors below you

**Status:** BUILT, verify-green, **not yet live-tested.** Ships **default-on**
(`enabledFromProfile: 'low'`). Owns the `post.dof` pass (`graph/passes.js`),
the SECOND `post`-stage effect and the first post-stage consumer of
`buf:scene.depth`.

Standing on an upper floor, looking down through a balcony, a stairwell or a
hole in the floor at whatever is below, should read as genuinely FAR AWAY —
the same optical cue a real elevated vantage point gives you. This effect is
that cue: the further below the currently-viewed floor a pixel's content
sits, the more it blurs, while the floor you're actually standing on stays
perfectly sharp.

---

## 1. The technique — a blurred mip chain, sampled at a floor-distance LOD

Not bloom's dual-band tent-upsample recombination (that solves a different
problem — soft highlight bleed). A single downsample pyramid of `scene.lit`,
sampled directly at a fractional level of detail:

```
scene.lit ──[downsample ×4, plain 13-tap]──▶ mip0 mip1 mip2 mip3
[composite]: per pixel, floorsBelow = viewedFloorIndex − floorIndexHere
             (read from buf:scene.depth's colour payload), mapped to a
             fractional LOD across the chain, mixed and written back with
             NormalBlending — alpha=0 wherever floorsBelow<=0.
```

- **Plain 13-tap downsample, no Karis average, no bright-pass threshold.**
  Bloom's Karis weighting exists specifically to stop one blown-out highlight
  from dominating a bright-pass pyramid; this effect blurs the WHOLE image,
  not just highlights, so neither concept applies. The same 13-tap kernel
  `bloom-render.js`'s own "plain" downsample already proves looks good
  (36 effective bilinear taps, avoids the blockiness of a naïve box filter)
  is reused here as the right technique independent of bloom's existence.
- **No upsample/recombination stage.** Each raw downsampled mip already IS
  "the blurred image at that LOD" — read directly, with ordinary bilinear
  upscaling on the way back to screen size. This is simpler and cheaper than
  bloom's own pipeline (no upsample passes at all), because the goal here is
  a smoothly *growing* blur radius, not a specific pair of independently-
  weighted bands.
- **A REPLACE composite, not an additive one.** Bloom adds light on top of
  the scene; this effect stands in for a region of it. The composite writes
  `vec4(blurredColor, alpha)` with `THREE.NormalBlending` — see §3.

---

## 2. The blur ramp — per-pixel LOD from floor distance

`buf:scene.depth`'s colour attachment (`sceneDepth.texture`, RGBA8, NEAREST)
already carries, per pixel, the floor index (R channel, 0-255) of the
topmost visible drawable — written behind a hard `depthTest:LessDepth` +
alpha-test discard, **winner-take-all, never blended**. That is exactly the
question this effect needs answered, and exactly why it reads
`buf:scene.depth` rather than `buf:scene.attr`'s own floor-index channel:
`buf:scene.attr` is written under ordinary `NormalBlending`, so at a soft
edge its floor value can be a meaningless blend of two different floors'
indices (e.g. "floor 1.5"). This is independent of — but fully compliant
with — the standing project rule that the depth authority is the only
occlusion/rank system for any new effect.

```
floorIndexHere = round(texture(sceneDepth.texture, uv()).r * 255)
present        = texture(sceneDepth.texture, uv()).a > 0.5
floorsBelow    = present && floorIndexHere < viewedFloorIndex
                   ? viewedFloorIndex − floorIndexHere : 0
blurLod        = clamp(floorsBelow * blurPerFloor, 0, (mipCount−1) * maxBlur)
```

`viewedFloorIndex` is a per-frame uniform written from `view.floorIndex` —
the viewer's own single source of truth for "the currently viewed floor,"
mutated in exactly one place (`vt-pan-viewer.js#setFloorIndex`). A pixel's
own `floorIndexHere` is guaranteed to agree with what `scene.lit` actually
shows there, because `buf:scene.depth`'s draw list is
`depthAuthority.rebuild(buildItems(view.floorIndex))` — the SAME
viewed-floor-scoped item list (`boot.js#buildItems`, via
`computeVisibleFloorIndices`) the colour pass itself draws with. (An earlier
design note in `Depth-Buffer.md` §5a describes an "all floors, regardless of
view" draw list for the depth pass — that was the original intent but is not
what the live code does; it was corrected in the same change that shipped
this effect, precisely because this effect's correctness depends on the real
behaviour.)

The `present` guard matters because the render target clears to
`(0,0,0,0)` and a genuine "floor 0" write also has `R=0` — without checking
`A>0.5`, an unrendered/void area viewed from an upper floor would spuriously
read as "very far below" and blur.

---

## 3. The clamp — why the current floor is guaranteed untouched

The composite is drawn with `material.transparent=true`,
`material.blending=THREE.NormalBlending`, into `scene.lit` — the SAME target
every earlier pass has already written the sharp, lit scene into. At
`floorsBelow<=0`, the shader outputs alpha EXACTLY `0`, and NormalBlending's
own arithmetic —

```
dst_new = src·srcAlpha + dst·(1 − srcAlpha) = dst·(1 − 0) + src·0 = dst
```

— leaves the destination pixel byte-identical. This is a guarantee **by
construction**, not a branch or a second draw call that could itself go
wrong: the current floor's own graphics (railings, walls, roof) are simply
never touched by this pass at all wherever `floorsBelow` is zero. This
composite never samples `scene.lit` itself either (only the blurred mips and
the separate `buf:scene.depth` colour texture) — there is no
read-your-own-render-target hazard to design around, because the shader was
never going to touch that texture in the first place.

---

## 4. Where it sits in the frame graph

`post.dof` is a **live** pass in the `post` stage (`graph/passes.js`), between
`post.bloom` and `post.grade` (a seam):

```
… → surface.particles → post.bloom → post.dof → [post.grade seam] → present.composite
```

It runs AFTER bloom so a bright, bloomed light seen through a lower-floor
hole blurs into a soft glow along with everything else, rather than staying
a sharp bloomed disc floating over a blurred background. It declares
`reads: ['buf:scene.depth']` and `modifies: ['buf:scene.color']` — the same
read-modify-write of the one HDR buffer light/bloom/present all touch. In
the live code that logical buffer is `scene.lit`. Runtime lives in
`vt/vt-pan-viewer.js` (`runPostDofPass`, a closure in the local `passImpls`
map, mirroring `runPostBloomPass`).

`post.dof` absorbs V2's `FloorDepthBlurEffect` (previously listed, unbuilt,
under `post.grade`'s own scope) — a modernised rebuild, not a port: V2 used a
Kawase multi-pass blur, re-rendering each floor below the active one
SEPARATELY and Porter-Duff compositing them together, with blur amount
proportional to integer floor-index distance from the active floor. The
INTENT survives exactly (more blur, further below); the mechanism is now one
unified pass reading the depth authority instead of N separate floor
renders.

### Render targets

Four half-resolution-and-below mips (`dof.mip0..3`), all `HalfFloat` /
`NoColorSpace` / `linear`, all `screenSized` through the allocator law. A
4-level HalfFloat chain is ~8 MB (the geometric area series `1/4 + 1/16 +
1/64 + 1/256` converges fast — dropping to 6 levels the way bloom's own
chain does would save almost nothing), already folded into Keyhole.md §4.2's
RT inventory. ~5 small passes per frame (4 downsample steps + 1 composite);
cheaper than bloom's 11-pass pipeline since there is no upsample chain.
Disabled, or viewing the ground floor (`view.floorIndex === 0`, nothing can
be below it) ⇒ the whole pass is a JS early-return, zero GPU work.

---

## 5. Controls & presets

**Params** (`effects/depth-of-field.js` `DOF_PARAMS`) — one schema → FOH
strip + full ROH (Effects-UI.md). Only 3 params (one blur band, not bloom's
two), so all of them promote to the front-of-house strip; the rear-of-house
"Advanced" section is correctly empty for this effect.

| Category | Params                              |
| -------- | ------------------------------------ |
| Look     | `strength`                           |
| Extent   | `blurPerFloor`, `maxBlur`            |

**Presets** (`DOF_PRESETS`): `Subtle`, `Moderate`, `Heavy` — reusing V2
`FloorDepthBlurEffect`'s own preset NAMES (only the intent carries over; a
Kawase-px radius has no equivalent parameter here).

---

## 6. Deferred rungs (recorded, not built)

- **`soft-floor-edge`** — a smoothstep-based feather across the floor-index
  boundary instead of a hard alpha cut. Cosmetic polish: the hard edge is
  already pixel-crisp (a NEAREST, full-screen-resolution sample), not
  blocky, and the boundary itself coincides with a real physical edge (a
  wall, a railing, the rim of a hole) — see §3's own reasoning for why a
  hard cut is not obviously wrong, only potentially improvable.
- **`fog-of-war-clip`** — skip/soften the blur under fog-of-war once MSA
  renders its own fog visibility texture (the same deferred hook bloom's own
  outdoor-spill clamp names — `keyhole-vision-fog-direction`).
- **`performance-tiers`** — governor-driven mip count / resolution scale per
  performance profile (Effects.md §6). Tier 0 is a fixed 4-mip chain.

---

## 7. Known unknowns (for the first live test)

- **The floor-distance metric is per-FLOOR, not continuous elevation.**
  Two floors authored close together in world-Z (e.g. a mezzanine) blur
  exactly as hard, one rung, as two floors authored far apart — matching
  V2's own INTENT (a floor is a discrete band, not a continuous height), but
  worth checking against a real multi-floor scene with unevenly-spaced
  floors before assuming it always reads right.
- **Interaction with a hole whose overlapping upper floor is itself hidden
  from view.** `buf:scene.depth`'s draw list is now confirmed to be scoped
  to exactly the same visible-floor set the colour pass uses (§2), so this
  is not expected to be a live bug — named here only because it was the
  first design risk considered and ruled out by reading the real
  `buildItems`/`computeVisibleFloorIndices` wiring rather than trusting the
  (now-corrected) design-doc prose.
- **Colour-space of the blur.** Downsampling happens in the SAME linear HDR
  space `scene.lit` already carries (matching bloom's own pyramid), so a
  very bright, blurred light source should stay energy-plausible rather than
  darkening the way a naive sRGB-space box blur would. Worth a direct look
  once a real bright light is visible through a hole from above.
