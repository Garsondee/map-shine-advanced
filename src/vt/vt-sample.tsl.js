/**
 * @fileoverview vt/vt-sample.tsl.js — THE virtual-texture sampler, in TSL.
 *
 * Replaces `vt-sample.glsl.js`. One source, both backends: Three's node system
 * emits WGSL for `WebGPUBackend` and GLSL for `WebGLBackend` from this same graph,
 * so there is no WebGL2 twin to keep in sync (`docs/planning/Shaders.md`;
 * `keyhole-webgpu-tsl-decision` in memory).
 *
 * ## Why this port was allowed to touch the riskiest code in the project
 *
 * The GLSL original survived **nine live-debugged bugs** (Y-flip → coordinate
 * space → clamp-bound conflation → GL interleaving → texture-unit cache →
 * diagnostic bug → UV compounding). Rewriting it re-opens every one, so it was
 * sanctioned only after `diag/tsl-spike.js` PROVED — with a real pixel, on the
 * author's own 3070, on BOTH backends — that TSL can express the three things this
 * file does that a node port could plausibly break: `textureLoad` on an
 * indirection texture, sampling a `DataArrayTexture` by layer, and a dynamic
 * `Loop` with a runtime condition.
 *
 * ## Carried across verbatim in SHAPE (each is a bug someone already paid for)
 *
 * - **The magenta tripwire.** No resident data at ANY mip → magenta. Never black,
 *   never a smear. Magenta means "the coarse-pin invariant is broken" — a bug —
 *   and is reserved for that alone.
 * - **The out-of-world guard is a DISTINCT early-out, not a clamp.** The texel
 *   clamp still exists as a real array-bounds safety, but must never masquerade as
 *   the world bound: conflating them IS the stretched-smear bug of 2026-07-15.
 *   `viewToWorldRect` is deliberately unclamped, so UVs legitimately leave [0,1].
 * - **Texel index from world PIXELS / a fixed payload**, never `worldUV *
 *   pagesPerAxis`. The nominal grid is `ceil()`-rounded and does NOT equal the real
 *   world size — confirmed live.
 * - **NOT `.level(0)`** — the one GLSL behaviour deliberately dropped, because it
 *   cost the entire render (black + transparent, no error). The GLSL's
 *   `textureLod(...,0.0)` guarded against derivative LOD picking a coarser atlas
 *   mip; `atlas.js` already makes that impossible (`generateMipmaps:false` +
 *   `LinearFilter`), so the guard was redundant, and on WebGPU it samples an
 *   explicit level of a texture declared with no mip levels → (0,0,0,0). See
 *   `sampleAtlasSlot`.
 * - **One walk function, called twice** (once per bracket mip) — never forked.
 * - **No mid-loop return.** Weak drivers mis-optimise them, and weak drivers are
 *   this project's design floor. The `Loop` keeps the accumulate-then-guard shape.
 *
 * ## The one real change: the mip layout is COMPUTED, not passed
 *
 * The GLSL took `uMipOrigin[16]` and `uMipPagesPerAxis[16]`. This takes two
 * integers, because the layout is fully derivable:
 *
 *   - `pagesX(m) === ceil(pagesX0 / 2^m)` — `page-table.js` halves iteratively, and
 *     `ceil(ceil(a/b)/2) === ceil(a/2b)`, so the closed form is exact.
 *   - `origins[m].x` is **always 0** — `computeIndirectionAtlasLayout` stacks the
 *     pyramid vertically — so the origin is one running Y total the walk
 *     accumulates as it descends, not an array.
 *
 * This is not a shortcut for its own sake. It removes `uniformArray`'s update path
 * — an API whose per-backend upload semantics could not be verified without a
 * browser, and whose failure mode (a silently stale mip layout) is magenta with no
 * obvious cause. Two integers have no update path to get wrong.
 *
 * **It is only legitimate because the closed form is PROVEN, not remembered:**
 * `vt-core.test.mjs` asserts it against the real `PageTable` across 121 size pairs
 * at every mip, plus the origin accumulation. If that test ever fails, this file is
 * reading a different grid than residency is streaming.
 *
 * @module vt/vt-sample.tsl
 */

/** Must match `page-table.js`'s pyramid depth ceiling. Same value the GLSL used. */
export const VT_MAX_MIPS = 16;

/**
 * Build one virtual-texture sampler: its node graph and its live uniform handles.
 *
 * Called ONCE PER ITEM MESH (not once globally) — each drawable samples its own
 * page table with its own image size and mip depth, exactly as each had its own
 * `ShaderMaterial` uniforms before. The atlas is the one shared thing.
 *
 * @param {object} TSL - the node build's TSL namespace (`THREE.TSL`).
 * @param {object} args
 * @param {any} args.atlasTexture - the shared `DataArrayTexture` page atlas.
 * @param {any} args.initialPageTable - MUST be a real 2D indirection texture of the
 *   right KIND (not the atlas, not a placeholder of another type). A TextureNode
 *   bakes its type into the graph at build time, so this decides what sampling code
 *   is emitted; `.value` can later be swapped only for another texture of the SAME
 *   kind (albedo's page table <-> a mask's page table, both 2D). Seeding it with the
 *   DataArrayTexture atlas compiled array-texture sampling, made every binding
 *   invalid, and WebGPU silently skipped the draw — the 2026-07-16 black screen.
 * @param {number} args.pagesPerAxis - atlas tiles per axis (`computeAtlasLayout`).
 * @param {number} args.pagesPerLayer - atlas tiles per array layer.
 * @param {number} args.pageSizePx - 256.
 * @param {number} args.borderPx - 4.
 * @param {number} args.atlasSizePx - 4096.
 * @returns {{uniforms: object, sample: (uvNode:any) => any}}
 */
export function createVtSampler(
  TSL,
  { atlasTexture, initialPageTable, pagesPerAxis, pagesPerLayer, pageSizePx, borderPx, atlasSizePx }
) {
  const { Fn, If, Loop, uniform, texture, textureLoad, vec2, vec4, ivec2, int, float, select, sRGBTransferEOTF, mix } =
    TSL;

  // NEVER use TSL's .mix() METHOD. Its receiver is the INTERPOLANT, not the first
  // value: three.js defines `mixElement = (t, e1, e2) => mix(e1, e2, t)`, so
  // `a.mix(b, t)` compiles to `mix(b, t, a)` -- silently, with no type error. That
  // cost a full session: it made `uUnoccludedAlpha.mix(uOccludedAlpha, occ)` into
  // mix(0, occ, 1) == 0, so alpha was multiplied by zero and the whole map went
  // black while every printed uniform was correct. Always the FUNCTION form,
  // mix(a, b, t), which reads the way it behaves. (.smoothstep() is the same trap:
  // `smoothstepElement = (x, low, high) => smoothstep(low, high, x)`.)

  // THE PAGE TABLE IS THE RAW TEXTURE, not a TextureNode.
  //
  // `textureLoad` is literally `(...params) => texture(...params).setSampler(false)`
  // (three.webgpu.js:37562) — it BUILDS a node from a texture. Handing it a node
  // that was already built wraps a node inside a node, and the binding silently
  // dies: black, alpha 0, no error. That is the same mistake as seeding the page
  // table with the atlas, one layer down — treating a node graph like a uniform
  // block, twice.
  //
  // The TSL spike that rendered a correct pixel passed the RAW texture. This now
  // does exactly what the proven thing did.
  //
  // Consequence, accepted deliberately: the texture is baked into the graph, so
  // switching the DISPLAYED pack (the debug-only mask view) needs the material
  // rebuilt rather than a `.value` swap. `setDisplayLayer` is a diagnostic; making
  // the hot path correct beats making the diagnostic convenient.
  const uniforms = {
    pageTableTexture: initialPageTable,
    worldSizePx: uniform(vec2(1, 1)),
    pages0: uniform(ivec2(1, 1)), // pagesX(0), pagesY(0) — the whole mip layout, see header
    // 0 = these pages are DATA, sample them raw. 1 = these pages are COLOUR, decode
    // sRGB->linear on fetch.
    //
    // This cannot be a property of the atlas texture, which is where it would
    // normally live: ONE atlas holds both the map's colour pages and mask pages, so
    // texture.colorSpace = SRGBColorSpace would correctly fix the map and silently
    // corrupt every mask. Colour space belongs to the DATA, and this texture carries
    // two kinds of it -- so the decode is per-pack, here, driven by pack.name.
    srgbDecode: uniform(float(0)),
    requestedMip: uniform(int(0)),
    requestedMipFrac: uniform(float(0)),
    maxMip: uniform(int(0)),
  };

  // Session constants — the atlas geometry never changes after boot, so these are
  // baked into the graph rather than uniformed.
  const payloadPx = pageSizePx - borderPx * 2;

  /** Sample the atlas at a resident page's slot, given the position within its payload. */
  const sampleAtlasSlot = Fn(([slot, cellUV]) => {
    // slot -> (tileX, tileY, layer). MUST stay in exact lockstep with atlas.js's
    // slotToAtlasPosition() — same row-major, layer-0-first packing.
    const layer = slot.div(int(pagesPerLayer));
    const withinLayer = slot.sub(layer.mul(int(pagesPerLayer)));
    const tileX = withinLayer.mod(int(pagesPerAxis));
    const tileY = withinLayer.div(int(pagesPerAxis));

    // Border-safe: into the payload region only (borderPx in from each edge), so a
    // neighbour's border texels are never sampled.
    const pagePx = vec2(tileX.toFloat(), tileY.toFloat())
      .mul(float(pageSizePx))
      .add(float(borderPx))
      .add(cellUV.mul(float(payloadPx)));
    // NO .level(0) HERE — and its absence is deliberate, not an omission.
    //
    // The GLSL used textureLod(...,0.0) as belt-and-braces against derivative-based
    // LOD picking a coarser atlas mip that was never rebuilt as pages streamed in.
    // But atlas.js ALREADY makes that impossible (generateMipmaps:false +
    // LinearFilter, atlas.js:169-171 — its own comment calls the textureLod "the
    // belt to that suspenders"). The atlas has exactly ONE level, so automatic LOD
    // cannot select a coarser one: there isn't one.
    //
    // Keeping the belt cost the whole render. `.level(0)` on an array texture emits
    // a sample-at-explicit-level against a texture the WebGPU backend declares with
    // no mip levels, and it returned (0,0,0,0) — a black, fully transparent screen
    // with no error anywhere (found live 2026-07-16; it was the ONE thing this
    // differed by from the TSL spike that rendered a correct pixel).
    const texel = texture(atlasTexture, pagePx.div(float(atlasSizePx))).depth(layer);
    // WHY this is needed at all: the node renderer's outputColorSpace defaults to
    // SRGBColorSpace (verified in the vendored build), so it encodes linear->sRGB on
    // the way out. The old raw-GLSL path converted at NEITHER end and happened to
    // balance. Feed sRGB bytes in tagged as linear and they get encoded a SECOND
    // time -- which reads as WASHED OUT, exactly as reported live 2026-07-16. Same
    // phenomenon that faked out the TSL spike (linear 96 arriving as 165); it has
    // now cost me twice, hence the essay.
    //
    // Alpha is deliberately untouched: alpha is linear in every colour space.
    return vec4(mix(texel.rgb, sRGBTransferEOTF(texel.rgb), uniforms.srgbDecode), texel.a);
  });

  /**
   * THE walk: from `startMip` up to `maxMip`, return the finest RESIDENT level's
   * texel — the automatic coarse fallback that makes "not loaded yet" mean SOFT
   * rather than WRONG.
   *
   * `foundMipOut` receives the mip the walk ACTUALLY landed on, which is not
   * always `startMip` — that difference is the whole point, and ignoring it was
   * the ghost bug (see `sample`). Stays `startMip.sub(1)`-style sentinel `-1`
   * when nothing was resident at any level (the magenta case).
   */
  const sampleFromMip = Fn(([startMip, worldPx, foundMipOut]) => {
    const result = vec4(1, 0, 1, 1).toVar(); // magenta tripwire — see header
    const found = int(0).toVar();
    foundMipOut.assign(int(-1));
    // The running Y origin into the flattened pyramid. Accumulates over EVERY
    // iteration including skipped ones — that is what makes it correct without an
    // array (origins[m].x is always 0; see header).
    const originY = int(0).toVar();

    // Constant bound so the compiler can unroll; per-iteration guards skip anything
    // outside [startMip, maxMip]. No mid-loop return — see header.
    Loop({ start: int(0), end: int(VT_MAX_MIPS), type: 'int', condition: '<' }, ({ i }) => {
      const scale = float(2).pow(i.toFloat());
      const pagesXm = float(uniforms.pages0.x).div(scale).ceil().toInt().max(int(1));
      const pagesYm = float(uniforms.pages0.y).div(scale).ceil().toInt().max(int(1));

      If(found.equal(int(0)).and(i.greaterThanEqual(startMip)).and(i.lessThanEqual(uniforms.maxMip)), () => {
        const cellF = worldPx.div(float(payloadPx).mul(scale)); // world texels per page at mip i
        // A REAL array-bounds safety for the indirection read. The world bound is a
        // separate early-out in sample() — precisely so this can never stand in for
        // it, which was the live edge-smear bug.
        const texel = ivec2(cellF.floor()).clamp(ivec2(0, 0), ivec2(pagesXm.sub(int(1)), pagesYm.sub(int(1))));
        const phys = ivec2(texel.x, texel.y.add(originY));

        // One indirection texel: RGBA8, R|G<<8 = the atlas slot, A>0.5 = resident.
        // textureLoad, never filtered — an indirection texel is an ID, and
        // interpolating an ID is meaningless.
        const t = textureLoad(uniforms.pageTableTexture, phys);
        If(t.a.greaterThan(float(0.5)), () => {
          const slot = t.r
            .mul(255)
            .add(0.5)
            .floor()
            .toInt()
            .add(t.g.mul(255).add(0.5).floor().toInt().mul(int(256)));
          result.assign(sampleAtlasSlot(slot, cellF.fract()));
          found.assign(int(1));
          foundMipOut.assign(i);
        });
      });

      originY.addAssign(pagesYm); // every iteration, skipped or not — see header
    });
    return result;
  });

  /**
   * Sample at world-normalised UV (0..1 across THIS virtual texture's own image).
   * Cross-fades the two mip levels bracketing `requestedMipFrac`.
   */
  const sample = Fn(([worldUV]) => {
    // Texel index from real world PIXELS / a fixed payload — NEVER worldUV *
    // pagesPerAxis. See header; confirmed live 2026-07-15.
    const worldPx = worldUV.mul(uniforms.worldSizePx);

    const mipLo = uniforms.requestedMip;
    const mipHi = mipLo.add(int(1)).min(uniforms.maxMip);
    const foundLo = int(-1).toVar();
    const foundHi = int(-1).toVar();
    const colorLo = sampleFromMip(mipLo, worldPx, foundLo);
    const colorHi = sampleFromMip(mipHi, worldPx, foundHi);

    // ONLY CROSS-FADE TWO LEVELS THAT BOTH RESOLVED WHERE THEY WERE ASKED TO.
    //
    // THE GHOST (author-reported 2026-07-17, after a thrash test: "a partially
    // transparent version of a section of the map appearing very large and in
    // the wrong position... fully zooming in doesn't cause it to get evicted").
    // Every one of those four words is this blend, and the author's own report
    // carried all three numbers that prove it:
    //
    //   prefetchSkippedPacks: 7 (of 11) — under pressure, streamPackResidency
    //     DECLINES the speculative tiers, so `plan.prefetchCoarser` (mip 2)
    //     never streams while `plan.fine` (mip 1) always does.
    //   requestedMip: 1, requestedMipFrac: 1.494 — so t = 0.494.
    //   coarseTopMips: 4 — mips 3..6 are coarse-PINNED, never evictable.
    //
    // So `colorLo`'s walk finds mip 1 (sharp) and `colorHi`'s walk finds NOT
    // mip 2 (declined) but mip 3 — the coarse pin. The blend then cross-fades
    // the sharp image with a FOUR-TIMES-COARSER one at 49.4%: partially
    // transparent (literally the mix weight), very large (4x coarser features),
    // and permanent, because mip 3 is pinned and mip 2 is never coming.
    //
    // The fallback was never the bug — "not loaded yet means SOFT, not WRONG"
    // (§4.1) is exactly right. The bug is BLENDING a fallback against a
    // non-fallback, which produces something WRONG out of two things that are
    // each individually correct. When the brackets disagree, `colorLo` is by
    // construction the finest resident level, so passing it through alone is
    // both the sharpest and the honest answer.
    //
    // Note the asymmetric case is already harmless and stays supported: if
    // `colorLo` ITSELF fell back (foundLo > mipLo), then its walk and
    // `colorHi`'s converge on the same level, so foundLo === foundHi and the
    // two colours are identical — blending them is a no-op either way. This
    // guard only ever suppresses the mismatched pair.
    const bracketsResolvedAsAsked = foundLo.equal(mipLo).and(foundHi.equal(mipHi));
    // At the pyramid's top mipHi === mipLo, so the blend weight is forced to 0 and
    // colorLo passes through — the GLSL's early-return, expressed as data (a node
    // graph has no control flow to return from).
    const t = select(
      mipHi.greaterThan(mipLo).and(bracketsResolvedAsAsked),
      uniforms.requestedMipFrac.sub(mipLo.toFloat()).clamp(0, 1),
      float(0)
    );
    const blended = mix(colorLo, colorHi, t);

    // OUT OF WORLD: its own case, matte black. Not magenta (reserved for a broken
    // pin invariant) and not a smear (what resolving it through the pager gives).
    const outside = worldPx.lessThan(vec2(0, 0)).any().or(worldPx.greaterThanEqual(uniforms.worldSizePx).any());
    return select(outside, vec4(0, 0, 0, 1), blended);
  });

  return { uniforms, sample };
}
