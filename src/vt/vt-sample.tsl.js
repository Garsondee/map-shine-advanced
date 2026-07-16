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
  const { Fn, If, Loop, uniform, texture, textureLoad, vec2, vec4, ivec2, int, float, select } = TSL;

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
    return texture(atlasTexture, pagePx.div(float(atlasSizePx))).depth(layer);
  });

  /**
   * THE walk: from `startMip` up to `maxMip`, return the finest RESIDENT level's
   * texel — the automatic coarse fallback that makes "not loaded yet" mean SOFT
   * rather than WRONG.
   */
  const sampleFromMip = Fn(([startMip, worldPx]) => {
    const result = vec4(1, 0, 1, 1).toVar(); // magenta tripwire — see header
    const found = int(0).toVar();
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
    const colorLo = sampleFromMip(mipLo, worldPx);
    const colorHi = sampleFromMip(mipHi, worldPx);
    // At the pyramid's top mipHi === mipLo, so the blend weight is forced to 0 and
    // colorLo passes through — the GLSL's early-return, expressed as data (a node
    // graph has no control flow to return from).
    const t = select(mipHi.greaterThan(mipLo), uniforms.requestedMipFrac.sub(mipLo.toFloat()).clamp(0, 1), float(0));
    const blended = colorLo.mix(colorHi, t);

    // OUT OF WORLD: its own case, matte black. Not magenta (reserved for a broken
    // pin invariant) and not a smear (what resolving it through the pager gives).
    const outside = worldPx.lessThan(vec2(0, 0)).any().or(worldPx.greaterThanEqual(uniforms.worldSizePx).any());
    return select(outside, vec4(0, 0, 0, 1), blended);
  });

  /**
   * THE IN-GRAPH BISECT. Four guesses at a black screen were four too many; each was
   * a real bug and none put a pixel on screen. So the graph reports on ITSELF, one
   * stage at a time, and every stage eliminates half of what remains:
   *
   *   'uv'          -> the uv attribute as colour. Black here = the vertex data or
   *                    the attribute name is wrong and NOTHING downstream matters.
   *   'atlas'       -> the atlas sampled directly at layer 0, ignoring the page
   *                    table entirely. Black here = the atlas texture is empty or
   *                    unbound, i.e. copyTextureToTexture is not landing on WebGPU.
   *   'indirection' -> the page table's raw texel as colour. Black here = textureLoad
   *                    or the page-table binding is broken; a visible pattern means
   *                    the pointers are arriving.
   *   'walk'        -> the full mip walk, but NOTHING after it: no tint, no alpha
   *                    chain, no occlusion, no out-of-world guard. Black here with
   *                    'atlas' and 'indirection' both working = the walk is wrong.
   *                    NOT black here = the bug is downstream, in the item material.
   *
   * Each returns opaque alpha deliberately: alpha is the very thing under suspicion,
   * so no stage may depend on it to be visible.
   *
   * @param {string} stage
   * @param {any} worldUV
   * @returns {any} a vec4 node
   */
  const debugStage = (stage, worldUV) => {
    if (stage === 'uv') return vec4(worldUV.x, worldUV.y, 0, 1);
    if (stage === 'atlas') {
      // Straight at the atlas, layer 0, no indirection. Isolates "is there content
      // in the atlas at all" from "can we find it".
      return vec4(texture(atlasTexture, worldUV).depth(int(0)).rgb, 1);
    }
    if (stage === 'indirection') {
      // Reads the CURRENT mip's rows, not mip 0's. The first cut of this read mip 0
      // unconditionally and drew black while the view sat at mip 2 -- whose rows are
      // legitimately empty. It contradicted 'walk', which needs the same table and
      // draws a correct map. An instrument that disagrees with a working system is
      // reporting on itself.
      //
      // The texels are POINTERS, so this is a PATTERN, not a picture: any structure
      // is a pass, uniform black is the fail.
      const worldPx = worldUV.mul(uniforms.worldSizePx);
      const originY = int(0).toVar();
      const out = vec4(0, 0, 0, 1).toVar();
      Loop({ start: int(0), end: int(VT_MAX_MIPS), type: 'int', condition: '<' }, ({ i }) => {
        const scale = float(2).pow(i.toFloat());
        const pagesXm = float(uniforms.pages0.x).div(scale).ceil().toInt().max(int(1));
        const pagesYm = float(uniforms.pages0.y).div(scale).ceil().toInt().max(int(1));
        If(i.equal(uniforms.requestedMip), () => {
          const cellF = worldPx.div(float(payloadPx).mul(scale));
          const texel = ivec2(cellF.floor()).clamp(ivec2(0, 0), ivec2(pagesXm.sub(int(1)), pagesYm.sub(int(1))));
          const t = textureLoad(uniforms.pageTableTexture, ivec2(texel.x, texel.y.add(originY)));
          out.assign(vec4(t.r, t.g, t.a, 1));
        });
        originY.addAssign(pagesYm);
      });
      return out;
    }
    if (stage === 'walk-alpha') {
      // 'walk' forces alpha to 1; this keeps the walk's REAL alpha. Splits "the walk
      // returns a black colour" from "the walk returns a transparent one" -- over a
      // black page those look identical to the eye, and the pixel readback is not
      // trusted (it read all-zero against a visibly red frame).
      return sampleFromMip(uniforms.requestedMip, worldUV.mul(uniforms.worldSizePx));
    }
    if (stage === 'sample') {
      // The FULL sampler: the walk plus the two things layered on top of it inside
      // this file -- the mip cross-fade, and the out-of-world guard. Nothing from the
      // item material. 'walk' draws and this does not => the bug is one of those two.
      return sample(worldUV);
    }
    if (stage === 'sample-opaque') {
      // As 'sample', alpha forced opaque. Draws here but black in 'sample' => the
      // sampler's ALPHA is the culprit. Black in both => its RGB is.
      return vec4(sample(worldUV).rgb, 1);
    }
    if (stage === 'walk') {
      const worldPx = worldUV.mul(uniforms.worldSizePx);
      return vec4(sampleFromMip(uniforms.requestedMip, worldPx).rgb, 1);
    }
    return null;
  };

  return { uniforms, sample, debugStage };
}
