# Bloom — the environment's glow, and the `post` stage's first citizen

**Status:** BUILT, verify-green, **not yet live-tested.** Ships **default-on**
(`enabledFromProfile: 'low'`). Owns the `post.bloom` pass (`graph/passes.js`).

Bloom is a key part of making an environment read as _real_ — hot sources
(lamps, fire, sun-glints, windows) bleed light into the air around them, and the
eye reads that bleed as brightness the display can't actually reach. This is the
first **post-processing** effect in Keyhole, so it also lays down the `post`
stage as a real, reusable slot the next post effect copies.

---

## 1. The technique — Jimenez / COD "physically-based bloom"

The gold standard is the progressive **dual-filter** bloom from Jorge Jimenez's
_Next Generation Post Processing in Call of Duty: Advanced Warfare_ (SIGGRAPH
2014), the same method LearnOpenGL documents as "physically based bloom":

```
scene.lit ──[bright]──▶ m0 ──[downsample ×5]──▶ m1 m2 m3 m4 m5
                              (13-tap; KARIS AVERAGE on the first step)
      CORE  band: m2 ─tent▶ m1 ─tent▶ m0   (additive) → m0 = smooth blur of 0..2
      ATMO  band: m5 ─tent▶ m4 ─tent▶ m3   (additive) → m3 = smooth blur of 3..5
      [composite]: strength·(coreStrength·coreTint·m0 + atmoStrength·atmoTint·m3)
                   additively into scene.lit
```

Three moving parts, and _why each one matters_:

- **Progressive downsample with a 13-tap filter.** Each step shrinks the bright
  image by half using a 13-tap kernel (36 effective bilinear taps). This is a
  higher-quality reduction than a naïve box or a separable Gaussian per mip.
- **Karis average on the first downsample.** The single biggest quality win.
  Without it, one blown-out sub-pixel highlight dominates its whole
  neighbourhood and _pulses_ as the camera moves — the notorious "sparkly /
  grainy bloom." Karis weights each sample group by `1/(1+luma)`, so a firefly
  can't take over. The stock three `UnrealBloomPass` does **not** do this, which
  is exactly why its bloom is known for grain.
- **Tent-filter upsample, additive.** Adding each blurred level back up the
  pyramid with a soft 3×3 tent gives a _creamy, continuous_ falloff instead of
  five obviously-stacked blurry copies.

### Why not the stock `bloom()` node, and why not V2's

- **Stock `three/addons/tsl/display/BloomNode.js`** is a port of the old
  `UnrealBloomPass`: a hard-ish luminance threshold (grain), a separable
  Gaussian per mip (more passes, less creamy), no Karis, no input masking. It
  also allocates its **own** `RenderTarget`s, which would bypass this project's
  `gpu/allocator-only` law, and it isn't bundled into the vendored three build.
- **V2's `BloomEffectV2`** was also a separable-Gaussian mip chain. It had the
  right _intent_ (a tight "Surface" glow + a wide "Atmosphere" glow, a fog clip,
  an outdoor-spill suppressor — see `docs/reference/v2-effect-params/bloom-effect.md`)
  but the older math. We keep the intent, replace the math.

---

## 2. The two bands — tight core + wide atmosphere, from ONE pyramid

The author's ask: _"some blooms look better with a tighter core of bloom and
then a larger bloom of 'atmospherics'."_ That is not two bloom passes — it is
**two levels of the same pyramid**:

- **CORE** = the smooth accumulation of the _shallow_ mips (0, 1, 2). Tight,
  hugs the source. Its own `coreStrength`, `coreTint`, `coreSpread`.
- **ATMOSPHERE** = the smooth accumulation of the _deep_ mips (3, 4, 5). Wide,
  a wash of air-glow. Its own `atmoStrength`, `atmoTint`, `atmoSpread`.

The two bands are built by running the tent-upsample **within each band only**,
so they are genuinely independent (no cross-band accumulation) — which is what
lets a scene have a crisp core with almost no haze, or a dreamy haze with almost
no core. This is V2's Surface/Atmosphere split, delivered by one blur chain
instead of two.

The composite adds them in **linear HDR into `scene.lit`**, so the grade engine
then grades the scene _and_ its bloom together — bloom is light in the scene,
and the tonemap/look acts on the total, which is the physically-sensible model.

---

## 3. The clamp — bloom can't leak where it isn't visible

Bloom spreads bright energy outward. Sometimes it must **not**: a torch under
fog-of-war shouldn't glow _through_ the fog; window-light shouldn't halo onto the
dark ground _outside_ a building. The fix is to **darken the bright-pass INPUT**
wherever bloom shouldn't originate — a bright source in a masked region then
contributes **zero** energy to the pyramid and physically cannot bloom outward.

This is a first-class, always-present hook (`buildOutdoorsGate` in the bright
material). What it's wired to today, and what's honest about it:

- **Walls: mostly already handled, for free.** Point lights only illuminate
  _inside_ their wall-swept polygon, so `scene.lit` has no bright pixels behind a
  wall to bloom from in the first place. Bloom inherits that. The only residue is
  a few pixels of blur crossing a wall edge — inherent to any screen-space bloom.
- **Outdoor spill: LIVE, via the `_Outdoors` mask.** On outdoor pixels, dark
  ground (below `threshold × spillLumLo`) keeps no bloom; real outdoor highlights
  (above `threshold × spillLumHi`) keep full bloom; it fades between. Indoors, and
  when the toggle is off, the gate is a provable no-op.
- **Fog-of-war: NOT wired yet, and not faked.** MSA does not own a fog-of-war
  visibility texture today (Foundry still does — see
  `keyhole-vision-fog-direction`). The _input hook_ is built and ready; the fog
  _wire_ is a recorded rung (`deferredRungs.fog-of-war-clip`), to be connected
  the day MSA renders its own fog. There is deliberately **no dead "fog clip"
  toggle** in the UI — a control that does nothing is worse than an absent one.

---

## 4. Where it sits in the frame graph

`post.bloom` is a **live** pass in the `post` stage (`graph/passes.js`), between
`surface.particles` (which finishes compositing `scene.lit`) and
`present.composite` (the grade + sRGB encode):

```
… → surface.particles → post.bloom → [post.grade seam] → present.composite
```

It declares `modifies: ['buf:scene.color']` — the same read-modify-write of the
one HDR buffer that `light.accumulate` and the surface passes use. In the live
code that logical buffer is realized as `scene.lit`; bloom reads it, builds its
pyramid through allocator-owned mip targets, and additively writes the two-band
result back into `scene.lit`. Runtime lives in `vt/vt-pan-viewer.js`
(`runPostBloomPass`, a closure in the local `passImpls` map, mirroring
`surface.particles`).

**The post-stage contract (the template the next post effect copies):** a post
effect is a live pass in the `post` stage that reads `scene.lit`, does its work
through allocator-owned targets, and additively (or via ping-pong) writes back
into `scene.lit` _before_ present — so the grade grades its result too. `post.bloom`
is the worked example. `post.grade` remains a seam for the rest of the post chain
(fog, distortion, stylizers).

### Render targets

Six half-resolution-and-below mips (`bloom.mip0..5`), all `HalfFloat` /
`NoColorSpace` / `linear`, all `screenSized` through the allocator law (they are
fractions of the drawing buffer — O(screen), never world). ~8 MB total, already
budgeted in Keyhole.md §4.2's RT inventory ("bloom chain ~8"). ~11 small passes
per frame; the passes get cheap fast as the mips shrink. Disabled ⇒ the whole
pass is a JS early-return, zero GPU work (not a `uniform(0)` multiply).

---

## 5. Controls & presets

**Params** (`effects/bloom.js` `BLOOM_PARAMS`) — one schema → FOH strip + full
ROH (Effects-UI.md):

| Category | Params                                                                                  |
| -------- | --------------------------------------------------------------------------------------- |
| Look     | `threshold`, `knee`, `strength`, `coreStrength`, `coreTint`, `atmoStrength`, `atmoTint` |
| Extent   | `coreSpread`, `atmoSpread`                                                              |
| Response | `outdoorSpillSuppress`, `spillLumLo`, `spillLumHi`                                      |

FOH strip: `strength`, `threshold`, `coreStrength`, `atmoStrength`, `atmoTint`,
`atmoSpread`.

**Presets** (`BLOOM_PRESETS`, the `grade-ops.js` pattern — a preset is just a
param diff): `Subtle`, `Strong`, `Dreamy`, `Neon`, `Clear Noon`, `Golden Hour`,
`Overcast Day`, `Storm`, `Moonlit Night`, `Interior Night`. Ported from V2's set,
**re-tuned** for the new math (the old numbers were tuned against separable-Gaussian
GLSL that no longer exists, so only the _intent_ of each look carries over). The
bloom card ships a preset dropdown that applies one live.

---

## 6. Deferred rungs (recorded, not built)

- **`fog-of-war-clip`** — connect the input hook to MSA's native fog visibility
  texture (the whole point of the clamp architecture; blocked on native fog).
- **`selective-emissive-bloom`** — bloom only flagged emissive surfaces (candle
  flames, magic) via an MRT emissive channel; needs `geometry.world` to MRT
  `buf:scene.attr`'s emissive first.
- **`lens-dirt-and-streaks`** — a screen-space dirt texture + anamorphic streak
  tap for a lens feel.
- **`performance-tiers`** — governor-driven resolution scale + mip count per
  performance profile (Effects.md §6). Tier 0 is a fixed half-res, 6-mip pyramid.

---

## 7. Known unknowns (for the first live test)

- **Colour of the tint multiply.** Tints are decoded with `hexToRgb01` (sRGB
  0..1) and multiplied into linear bloom, matching how the candle handles colour.
  A warm `atmoTint` slightly warms the haze; if it reads too saturated or too
  weak live, the decode (sRGB-as-linear-multiplier vs. a true sRGB→linear
  convert) is the first knob to revisit.
- **Threshold range in HDR.** `scene.lit` is linear HDR and can exceed 1.0 where
  lights/coloration stack, so `threshold ≈ 1.0` means "only true highlights."
  The right default may want tuning once real lit scenes are on screen.
- **Highlight clipping.** Present does grade + sRGB but no dedicated filmic
  highlight roll-off, so very strong bloom can clip to white fast. If that reads
  harsh, a soft roll-off belongs in the grade/present, not here.
