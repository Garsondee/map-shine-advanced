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
 * - **`.level(0)` on the atlas fetch** (the GLSL's `textureLod(...,0.0)`). Page
 *   slots are arbitrary bookkeeping, so neighbouring screen pixels land on
 *   unrelated atlas locations at page boundaries; derivative LOD reads those jumps
 *   as "zoomed out" and picks an atlas mip that was never rebuilt as pages
 *   streamed in. Level 0 makes that impossible rather than merely configured-against.
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
 * @param {any} args.initialPageTable - any valid texture; rebound per pack via
 *   `uniforms.pageTable.value`.
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

  // Live handles the viewer mutates per frame (`.value = …`) — the same update
  // pattern the GLSL material's uniforms had, so calling code barely changes.
  const pageTable = texture(initialPageTable);
  const uniforms = {
    pageTable,
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
    return texture(atlasTexture, pagePx.div(float(atlasSizePx)))
      .depth(layer)
      .level(0); // level(0): see header
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
        const t = textureLoad(pageTable, phys);
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

  return { uniforms, sample };
}
