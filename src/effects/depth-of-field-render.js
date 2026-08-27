/**
 * DEPTH OF FIELD RENDER — the TSL material builders for the floor-distance
 * blur.
 *
 * Pure builders: THREE/TSL is INJECTED (never imported), no renderer, no
 * allocator, no RenderTargets — exactly the boundary `bloom-render.js` keeps.
 * The viewer (`vt/vt-pan-viewer.js#runPostDofPass`) owns the render targets
 * and the pass sequencing; this file owns the SHADERS and returns the
 * swappable uniform handles the viewer drives per frame.
 *
 * THE PIPELINE (docs/planning/Depth-of-Field.md) — simpler than bloom's:
 * no bright-pass threshold (the whole image blurs, not just highlights), no
 * upsample/recombination stage (each downsampled mip already IS "the blurred
 * image at that LOD," sampled directly):
 *
 *   scene.lit ──[downsample ×N, plain 13-tap]──▶ mip0 mip1 mip2 mip3
 *   [composite]: per pixel, floorsBelow = viewedFloorIndex − floorIndexHere
 *                (from buf:scene.depth's colour payload), mapped to a
 *                fractional LOD across the mip chain, RING-sampled (8 taps
 *                per mip, 2026-08-27 — see "BOKEH SHAPE" below) and mixed,
 *                written back with NormalBlending — alpha=0 wherever
 *                floorsBelow<=0.
 *
 * BOKEH SHAPE (2026-08-27, two rounds): the composite used to read each mip
 * at a single point, which just showed the downsample pyramid's own
 * square/diamond 13-tap grid pattern directly — square bokeh. Round 1:
 * `pickFromRing`/`ringSample` average a ring of samples per mip instead of
 * one point. Round 2 (Ingram's own live read of round 1: "bubble shaped"):
 * a RING alone, with nothing at the center, is a hollow-annulus kernel —
 * `CENTER_WEIGHT` blends in a weighted center tap so it reads as a filled
 * disc. See their own doc comments for the full account.
 *
 * TAP SPREAD (2026-08-27, round 3): Ingram's own live read — "still very
 * strong by default... controls aren't reliable." `uTapSpread` (downsample
 * material) scales the SAME 13-tap downsample pattern's footprint smaller
 * for the scene.lit→mip0 step only, so the LEAST-blurred rung this effect
 * can ever show is genuinely subtle instead of already-quite-blurred — see
 * its own doc comment for the full account of why this, not a formula
 * change, is the real fix.
 *
 * ⚠️ THE COMPOSITE NEVER SAMPLES `scene.lit` ITSELF — only the blurred mips
 * and the (separate) depth colour texture, both different render targets.
 * There is no read-your-own-render-target hazard to design around here (that
 * hazard is a shader `texture()`-sampling the EXACT target it is currently
 * bound to write, `graph/passes.js`'s own `surface.water`/`surface.response`
 * notes name it) — this material was never going to touch it. The "current
 * floor stays untouched" guarantee instead comes from `NormalBlending`'s own
 * arithmetic: an output alpha of exactly 0 leaves the destination pixel
 * byte-identical (`dst·(1−0)+src·0=dst`, the same zero-is-neutral property
 * `vt/scene-attr.js`'s own header states and `feedback_blend_neutral_
 * element_is_per_blend` names as blend-mode-specific — NormalBlending is the
 * side of that lesson this is safely on).
 *
 * ⚠️ THIS FILE IS A SEPARATE, MANUALLY-SYNCED REIMPLEMENTATION of
 * `depth-of-field-blur.js`'s pure formulas (`computeDofFloorsBelow`/
 * `computeDofMipSample`/`computeDofAlpha`) — Node cannot execute a TSL `Fn()`
 * body, so there is no way to share the literal code, only the shape. Each
 * TSL line below is commented with which pure function it mirrors.
 *
 * TSL traps heeded: `mix`/`select` are used in FUNCTION form
 * (reference_tsl_method_chaining_trap — `a.mix(b,t)` silently means
 * `mix(b,t,a)`, so method form is never used for either); `.clamp()`/
 * `.max()`/`.min()`/`.floor()`/`.round()`/comparisons are safe as methods
 * (the receiver is unambiguous). Every node method used below
 * (`.round()`, `.floor()`, `.greaterThan()`, `.greaterThanEqual()`, `.and()`,
 * `.lessThan()`, `select()`) is confirmed present in the vendored
 * `three.webgpu.js` build before use, not assumed from general TSL docs.
 *
 * @module effects/depth-of-field-render
 */

/**
 * Build every DoF material once. The viewer allocates the mip render targets
 * first, then hands their textures in here (the composite samples all of
 * them directly; the downsample material swaps its input per pass).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.depthColorTexture - `buf:scene.depth`'s colour attachment
 *   (`sceneDepth.texture`, RGBA8/NEAREST) — R = floor index/255, A = presence.
 * @param {*[]} args.mipTextures - the blur pyramid's textures, index 0 =
 *   least blurred (half-res), in ascending blur order. Length >= 1.
 * @returns {object} materials + uniform handles (see the return literal).
 */
export function buildDofMaterials({ THREE, depthColorTexture, mipTextures }) {
  const TSL = THREE.TSL;
  const { texture, uv, vec2, vec4, float, uniform, Fn, mix, select } = TSL;

  const mipCount = Math.max(1, mipTextures.length);
  const topLod = mipCount - 1;

  // ── DOWNSAMPLE (plain 13-tap, no Karis average, no bright-pass threshold —
  // unlike bloom's pyramid, the WHOLE image blurs here, not just highlights).
  // Reused once per mip step; the viewer swaps `inputNode`/`uInvTexel` and the
  // render target between calls, the same reuse-one-material idiom bloom's
  // own plain downsample uses.
  const inputNode = texture(null);
  const uInvTexel = uniform(new THREE.Vector2(1, 1));
  // TAP SPREAD (2026-08-27, round 3) — Ingram's own live read: "still very
  // strong by default... the controls around strength/blur amount aren't
  // reliable." Root cause: mip0 (the LEAST-blurred rung this whole effect
  // can ever show) was already a fairly heavy blur — the SAME wide 13-tap
  // pattern used for every downsample step, unscaled. That makes the
  // strength/blurPerFloor sliders feel like an on/off switch, not a dial:
  // the moment `lod` crosses 0, a below-floor pixel jumps straight from
  // byte-identical (alpha=0) to "at least mip0-blurry" (alpha=1, see
  // computeDofAlpha's own doc for why alpha itself can't be softened here —
  // a smooth alpha ramp was tried before and rejected for producing a
  // sharp/blurred GHOSTING double-image, not less blur). The real fix is
  // giving mip0 itself real headroom to be SUBTLE: this uniform scales the
  // SAME 13-tap pattern's footprint (multiplies `uInvTexel`, the tap
  // spacing) rather than being a second shader — the viewer sets it small
  // for the scene.lit→mip0 step only and 1.0 (unscaled, today's exact
  // behavior) for every later step, so the top of the pyramid (deep floors
  // below) keeps its existing strong blur while the FLOOR of the ramp
  // (one floor below, low strength) gets genuinely gentle. Defaults to 1.0
  // — the ORIGINAL, unscaled behavior — so this uniform being un-set (a
  // shader-lab bench, e.g.) never silently changes anything.
  const uTapSpread = uniform(1.0);
  const downsampleMaterial = new THREE.NodeMaterial();
  downsampleMaterial.depthTest = false;
  downsampleMaterial.depthWrite = false;
  downsampleMaterial.fragmentNode = Fn(() => {
    const base = uv();
    const x = uInvTexel.x.mul(uTapSpread);
    const y = uInvTexel.y.mul(uTapSpread);
    const S = (ox, oy) => inputNode.sample(base.add(vec2(x.mul(ox), y.mul(oy)))).rgb;
    // a b c / j k / d e f / l m / g h i — the same 13-tap pattern
    // bloom-render.js's own "plain" downsample proves looks good, without its
    // Karis firefly weighting (that exists only to protect a bright-pass
    // threshold this effect has none of).
    const a = S(-2, 2);
    const b = S(0, 2);
    const c = S(2, 2);
    const d = S(-2, 0);
    const e = S(0, 0);
    const f = S(2, 0);
    const g = S(-2, -2);
    const h = S(0, -2);
    const i = S(2, -2);
    const j = S(-1, 1);
    const k = S(1, 1);
    const l = S(-1, -1);
    const m = S(1, -1);
    const outc = e
      .mul(0.125)
      .add(a.add(c).add(g).add(i).mul(0.03125))
      .add(b.add(d).add(f).add(h).mul(0.0625))
      .add(j.add(k).add(l).add(m).mul(0.125));
    return vec4(outc, 1.0);
  })();
  downsampleMaterial.name = 'Dof_downsample';

  // ── COMPOSITE — floor-distance-driven fractional-LOD blur, NormalBlending ──
  const depthColorTexNode = texture(depthColorTexture);
  // Fixed at build time (mipCount is the pyramid's own length, never a
  // per-frame value), so this is a bound set of texture nodes, not a
  // dynamically-indexed array — TSL/WGSL has no runtime array indexing.
  const mipTexNodes = mipTextures.map((t) => texture(t));
  const uViewedFloorIndex = uniform(0);
  const uStrength = uniform(1.0);
  const uBlurPerFloor = uniform(1.2);
  const uMaxBlur = uniform(1.0);
  // BOKEH SHAPE (2026-08-27) — 1 texel in UV space AT MIP 0's resolution.
  // Refreshed every frame in `runPostDofPass` from mip0's own live width/
  // height (which already tracks internalW/H, the render-scale governor's
  // own tier — see vt-pan-viewer.js), so a resize never leaves this stale;
  // no separate resize hook needed, same "just re-push every frame" pattern
  // `uStrength`/`uBlurPerFloor`/`uMaxBlur` already use.
  const uMip0InvTexel = uniform(new THREE.Vector2(1, 1));

  // ── BOKEH SHAPE: a small ring of samples per mip, not one point ──────────
  // Ingram's own live read: the blur "always produces square bokeh." Root
  // cause, confirmed: a single point-sample here just showed the downsample
  // pyramid's own 13-tap grid pattern directly (a square/diamond footprint,
  // no aperture shape at all) — invisible on Bloom (the identical pyramid,
  // additively blended UNDER a sharp image) but fully exposed here
  // (NormalBlending, a hard 0/1 replace — nothing sharp left underneath to
  // hide the shape behind, see this file's own header). Fix: average
  // `RING_TAPS` points arranged in a circle around the sample point instead
  // of reading just one — the standard cheap "fake bokeh" technique.
  //
  // Radius DOUBLES each mip step (`2**mipIdx`) rather than staying constant:
  // each mip is itself a half-res downsample of the last, so "one texel"
  // doubles in UV-space size every step too — a constant UV radius would
  // cover fewer and fewer effective texels at the coarser (already blurriest,
  // most square-looking) mips, exactly backwards from where rounding the
  // shape matters most. `mipIdx` is always a plain JS loop index below
  // (0..mipCount-1), never a TSL runtime value, so `2**mipIdx` is a normal
  // JS number baked in at build time — no `pow()` node needed. Same reason
  // the 8 ring angles are pre-computed with `Math.cos`/`Math.sin` in JS, not
  // a TSL trig node: the angles never change, so there is nothing to gain
  // from computing them on the GPU every fragment.
  const RING_TAPS = 8;
  // At mip0; doubles per mip step below. The mechanism that actually rounds
  // the shape isn't "how big one radius is" — each mip is already a softened
  // (13-tap) image, not a sharp one, so 8 offset already-soft sample centers
  // combine into a visibly rounder COMBINED footprint even at a modest
  // radius. 2 texels is a deliberately conservative starting point; this is
  // the one constant to nudge up if a live look still reads too square, or
  // down if it reads noticeably softer than before.
  const RING_RADIUS_TEXELS = 2.0;
  // 2026-08-27, round 2 — Ingram's own live read of the ring-only version:
  // "no longer square but now 'bubble' shaped." Root cause: a ring of
  // samples with NOTHING at the center is, mathematically, a hollow-annulus
  // kernel — literally the same shape a catadioptric/mirror lens produces
  // (a physical secondary mirror blocks its own aperture center), which is
  // exactly what photographers call "donut" or "soap-bubble" bokeh. The fix
  // is not a bigger/smaller ring, it's giving the CENTER real weight so the
  // combined kernel reads as a filled disc instead of a hollow ring — one
  // more tap (the un-offset `uv()` point, weight `CENTER_WEIGHT`), the ring
  // average taking the rest.
  const CENTER_WEIGHT = 0.5;
  const RING_OFFSETS = Array.from({ length: RING_TAPS }, (_, t) => {
    const angle = (t / RING_TAPS) * Math.PI * 2;
    return [Math.cos(angle) * RING_RADIUS_TEXELS, Math.sin(angle) * RING_RADIUS_TEXELS];
  });
  /** One mip's disc-averaged color at `uv()` — a weighted center tap plus
   * the ring average, NOT the ring alone (see `CENTER_WEIGHT`'s own doc just
   * above for why a ring alone reads as a hollow bubble, not a filled disc).
   * @param {*} texNode @param {number} mipIdx */
  const ringSample = (texNode, mipIdx) => {
    const texelScale = 2 ** mipIdx; // mip0=1x, mip1=2x, mip2=4x, mip3=8x
    const rx = uMip0InvTexel.x.mul(texelScale);
    const ry = uMip0InvTexel.y.mul(texelScale);
    const center = texNode.sample(uv()).rgb;
    const [ox0, oy0] = RING_OFFSETS[0];
    let ringSum = texNode.sample(uv().add(vec2(rx.mul(ox0), ry.mul(oy0)))).rgb;
    for (let t = 1; t < RING_TAPS; t++) {
      const [ox, oy] = RING_OFFSETS[t];
      ringSum = ringSum.add(texNode.sample(uv().add(vec2(rx.mul(ox), ry.mul(oy)))).rgb);
    }
    const ringAvg = ringSum.mul(1 / RING_TAPS);
    return center.mul(CENTER_WEIGHT).add(ringAvg.mul(1 - CENTER_WEIGHT));
  };
  // One ring-sample PER MIP, computed ONCE and shared by both the lod0 and
  // lod1 picks below (`pickFromRing`) — half the tap count a "ring inside
  // pickMip, called twice" version would cost: mipCount×RING_TAPS total
  // texture reads (32 at the shipped 4-mip/8-tap settings), not ×2 again.
  const ringMips = mipTexNodes.map((tex, idx) => ringSample(tex, idx));

  /**
   * Pick `ringMips[floor(indexNode)]`, clamped into `0..mipCount-1`, via a
   * static (unrolled) `select` cascade — the standard TSL idiom for "a small,
   * FIXED candidate list, chosen by a RUNTIME value" (no dynamic indexing
   * exists). Walking idx upward and always overriding on `>=` means the
   * final result is exactly the candidate at `floor(indexNode)` (clamped),
   * for any indexNode this composite ever computes (already clamped to
   * `[0, topLod]` before this is called).
   */
  const pickFromRing = (indexNode) => {
    let result = ringMips[0];
    for (let idx = 1; idx < mipCount; idx++) {
      result = select(indexNode.greaterThanEqual(float(idx)), ringMips[idx], result);
    }
    return result;
  };

  const compositeMaterial = new THREE.NodeMaterial();
  compositeMaterial.depthTest = false;
  compositeMaterial.depthWrite = false;
  compositeMaterial.transparent = true;
  compositeMaterial.blending = THREE.NormalBlending;
  compositeMaterial.fragmentNode = Fn(() => {
    const depthSample = depthColorTexNode.sample(uv());
    // Mirrors computeDofFloorsBelow: R*255 = the floor index of whatever won
    // buf:scene.depth's hard depth-test here; A>0.5 guards the (0,0,0,0)
    // clear (an unwritten pixel) from reading as a false "floor 0".
    const floorIndexHere = depthSample.r.mul(255.0).round();
    const present = depthSample.a.greaterThan(0.5);
    const isBelow = present.and(floorIndexHere.lessThan(uViewedFloorIndex));
    const floorsBelow = select(isBelow, uViewedFloorIndex.sub(floorIndexHere), float(0));

    // Mirrors computeDofMipSample — uStrength scales the RADIUS (how far the
    // lod ramp climbs), not the composite's alpha below. That is what makes
    // low strength read as "less blurred" instead of "sharp/blurred ghosting."
    const lod = floorsBelow.mul(uBlurPerFloor).mul(uStrength).clamp(0.0, float(topLod).mul(uMaxBlur));
    const lod0 = lod.floor();
    const lod1 = lod0.add(1.0).min(float(topLod));
    const frac = lod.sub(lod0);
    const blurredColor = mix(pickFromRing(lod0), pickFromRing(lod1), frac);

    // Mirrors computeDofAlpha — a hard cut (0 or 1), never a ramp and never
    // `strength`-scaled: a below-floor pixel is always a full replace by ONE
    // coherent (blurred-per-uStrength) sample, never a cross-fade with the
    // sharp source. Also requires lod>0: mip0 is a half-res, pre-softened
    // sample, not a sharp source, so strength/blurPerFloor/maxBlur landing
    // the ramp at exactly 0 must disable the replace outright, or "every
    // slider at zero" would still visibly blur via mip0's own softness.
    const alpha = select(floorsBelow.greaterThan(0.0).and(lod.greaterThan(0.0)), float(1.0), float(0.0));

    return vec4(blurredColor, alpha);
  })();
  compositeMaterial.name = 'Dof_composite';

  return {
    downsampleMaterial,
    downsample: { inputNode, uInvTexel, uTapSpread },
    compositeMaterial,
    // Uniform handles the viewer writes each frame from the resolved params
    // (+ view.floorIndex for viewedFloorIndex).
    uniforms: {
      viewedFloorIndex: uViewedFloorIndex,
      strength: uStrength,
      blurPerFloor: uBlurPerFloor,
      maxBlur: uMaxBlur,
      mip0InvTexel: uMip0InvTexel,
    },
  };
}
