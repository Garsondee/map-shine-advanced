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
 *                fractional LOD across the mip chain, mixed and written back
 *                with NormalBlending — alpha=0 wherever floorsBelow<=0.
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
  const downsampleMaterial = new THREE.NodeMaterial();
  downsampleMaterial.depthTest = false;
  downsampleMaterial.depthWrite = false;
  downsampleMaterial.fragmentNode = Fn(() => {
    const base = uv();
    const x = uInvTexel.x;
    const y = uInvTexel.y;
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

  /**
   * Pick `mipTexNodes[floor(indexNode)]`, clamped into `0..mipCount-1`, via a
   * static (unrolled) `select` cascade — the standard TSL idiom for "a small,
   * FIXED candidate list, chosen by a RUNTIME value" (no dynamic indexing
   * exists). Walking idx upward and always overriding on `>=` means the
   * final result is exactly the candidate at `floor(indexNode)` (clamped),
   * for any indexNode this composite ever computes (already clamped to
   * `[0, topLod]` before this is called).
   */
  const pickMip = (indexNode) => {
    let result = mipTexNodes[0].sample(uv()).rgb;
    for (let idx = 1; idx < mipCount; idx++) {
      result = select(indexNode.greaterThanEqual(float(idx)), mipTexNodes[idx].sample(uv()).rgb, result);
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
    const blurredColor = mix(pickMip(lod0), pickMip(lod1), frac);

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
    downsample: { inputNode, uInvTexel },
    compositeMaterial,
    // Uniform handles the viewer writes each frame from the resolved params
    // (+ view.floorIndex for viewedFloorIndex).
    uniforms: {
      viewedFloorIndex: uViewedFloorIndex,
      strength: uStrength,
      blurPerFloor: uBlurPerFloor,
      maxBlur: uMaxBlur,
    },
  };
}
