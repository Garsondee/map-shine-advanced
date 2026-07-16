/**
 * @fileoverview vt/vt-sample.tsl.js — THE virtual-texture sampler, in TSL.
 *
 * The direct port of `vt-sample.glsl.js`, which it replaces. One source, both
 * backends: Three's node system emits WGSL for `WebGPUBackend` and GLSL for
 * `WebGLBackend` from this same graph — so there is no WebGL2 twin to maintain
 * and no second thing to keep in sync (`docs/planning/Shaders.md`, and the
 * `keyhole-webgpu-tsl-decision` memory).
 *
 * ## Why this port was allowed to happen at all
 *
 * The GLSL original survived **nine live-debugged bugs** (Y-flip → coordinate
 * space → clamp-bound conflation → GL interleaving → texture-unit cache →
 * diagnostic bug → the UV-compounding bug). Rewriting it is re-opening every one
 * of them, so it was only sanctioned once `diag/tsl-spike.js` PROVED, with a real
 * pixel on the author's own 3070, that TSL can express the three things this file
 * does that a node port could plausibly break:
 *
 *   1. `textureLoad` on the indirection texture — a POINTER fetch, never filtered.
 *   2. Sampling the `DataArrayTexture` atlas by layer (WGSL `texture_2d_array`,
 *      GLSL `sampler2DArray`).
 *   3. A dynamic `Loop` with a runtime condition — the coarse-fallback mip walk.
 *
 * Both backends returned the exact expected pixel. That is why this is a port and
 * not an experiment.
 *
 * ## What is deliberately unchanged from the GLSL
 *
 * Every hard-won behaviour is carried across verbatim in *shape*, because each one
 * is a bug someone already paid for:
 *
 * - **The magenta tripwire.** A page with no resident data at ANY mip returns
 *   magenta, never black and never a smear. Magenta means "the coarse-pin
 *   invariant is broken" — a bug — and is reserved for that alone.
 * - **The out-of-world guard is a distinct early-out**, not a clamp. Clamping the
 *   texel index (which still happens, as a real array-bounds safety) silently
 *   re-samples the edge page forever, which is exactly the stretched-smear bug
 *   found live on 2026-07-15. Outside the world is its own case: matte black.
 * - **Texel index comes from world PIXELS / a fixed payload**, never from
 *   `worldUV * pagesPerAxis`. The nominal page grid is `ceil()`-rounded and does
 *   not equal the real world size — confirmed live, the same day.
 * - **`.level(0)` on the atlas fetch** (the GLSL's `textureLod(..., 0.0)`). A
 *   page's atlas slot is arbitrary bookkeeping, so neighbouring screen pixels can
 *   land on unrelated atlas locations at every page boundary; derivative-based LOD
 *   reads those jumps as "zoomed out" and picks a coarser atlas mip that was never
 *   rebuilt as pages streamed in. Forcing level 0 makes that structurally
 *   impossible rather than merely configured-against.
 * - **The single-mip walk is one function called twice** (once per bracket mip),
 *   not two code paths, for the same reason it was in the GLSL: the walk is the
 *   part that survived the nine bugs and must not fork.
 *
 * ## What changed, and why it is safe
 *
 * - GLSL's `for (m = 0; m < VT_MAX_MIPS; ++m) { if (found) continue; ... }` becomes
 *   a TSL `Loop` over the same constant bound with the same accumulate-then-break
 *   discipline. The original avoided a mid-loop `return` because weak drivers —
 *   this project's design floor — mis-optimise loop-body returns. That reasoning
 *   applies to whatever GLSL the node system emits, so the shape is kept.
 * - Uniform arrays (`uMipOrigin`, `uMipPagesPerAxis`) become `uniformArray`, which
 *   the node system marshals per backend. Dynamic indexing into them is legal on
 *   both (it is non-sampler indexing — the thing GLSL ES 3.00 actually forbids is
 *   dynamically indexing a `sampler2D[]`, which this has never done).
 *
 * @module vt/vt-sample.tsl
 */

/** Must match `page-table.js`'s pyramid depth ceiling. Same value the GLSL used. */
export const VT_MAX_MIPS = 16;

/**
 * Build the VT sampler node graph and its uniform handles.
 *
 * Returns the uniforms as live objects the renderer mutates per frame (`.value =`),
 * exactly as the GLSL version's `material.uniforms` were mutated — so the calling
 * code's update pattern is unchanged.
 *
 * @param {object} TSL - the node build's TSL namespace.
 * @param {object} args
 * @param {any} args.atlas - the `DataArrayTexture` page atlas.
 * @param {number} args.pagesPerAxis - atlas tiles per axis (`computeAtlasLayout`).
 * @param {number} args.pagesPerLayer - atlas tiles per array layer.
 * @param {number} args.pageSizePx - 256.
 * @param {number} args.borderPx - 4.
 * @param {number} args.atlasSizePx - 4096.
 * @returns {{uniforms: object, sample: (uvNode:any) => any}}
 */
export function createVtSampler(TSL, { atlas, pagesPerAxis, pagesPerLayer, pageSizePx, borderPx, atlasSizePx }) {
  const { Fn, If, Loop, uniform, uniformArray, texture, textureLoad, vec2, vec4, ivec2, int, float, select } = TSL;

  // Live uniform handles. Per-pack values (the page table, the image size, the
  // mip layout) are rebound by the viewer exactly as before.
  const uniforms = {
    uPageTable: uniform(null),
    uWorldSizePx: uniform(vec2(1, 1)),
    uRequestedMip: uniform(int(0)),
    uRequestedMipFrac: uniform(float(0)),
    uMaxMip: uniform(int(0)),
    uMipOrigin: uniformArray(
      new Array(VT_MAX_MIPS).fill(0).map(() => [0, 0]),
      'ivec2'
    ),
    uMipPagesPerAxis: uniformArray(
      new Array(VT_MAX_MIPS).fill(0).map(() => [1, 1]),
      'ivec2'
    ),
  };

  // Constants for the session — the atlas geometry never changes after boot, so
  // these are baked rather than uniformed.
  const payloadPx = pageSizePx - borderPx * 2;

  /**
   * Sample the atlas at a resident page's slot, given the fractional position
   * within that page's payload. Border-safe: maps into the payload region only
   * (`borderPx` in from each edge), never sampling a neighbour's border texels.
   */
  const sampleAtlasSlot = Fn(([slot, cellUV]) => {
    // slot -> (tileX, tileY, layer). Must stay in EXACT lockstep with atlas.js's
    // slotToAtlasPosition() — same row-major, layer-0-first packing.
    const layer = slot.div(int(pagesPerLayer));
    const withinLayer = slot.sub(layer.mul(int(pagesPerLayer)));
    const tileX = withinLayer.mod(int(pagesPerAxis));
    const tileY = withinLayer.div(int(pagesPerAxis));

    const pagePx = vec2(tileX.toFloat(), tileY.toFloat())
      .mul(float(pageSizePx))
      .add(float(borderPx))
      .add(cellUV.mul(float(payloadPx)));
    const atlasUV = pagePx.div(float(atlasSizePx));
    // .level(0) — see this module's header. NOT automatic LOD.
    return texture(atlas, atlasUV).depth(layer).level(0);
  });

  /**
   * THE single-mip walk: from `startMip` up to `uMaxMip`, return the finest
   * RESIDENT level's texel (automatic coarse fallback). With coarse pins pinned
   * this never returns magenta; magenta means a broken pin invariant, not
   * "streaming".
   */
  const sampleFromMip = Fn(([startMip, worldPx]) => {
    const result = vec4(1, 0, 1, 1).toVar(); // magenta tripwire — see the header
    const found = int(0).toVar();

    // Constant bound so the compiler can unroll; per-iteration guards skip
    // anything outside [startMip, uMaxMip]. No mid-loop return — weak drivers
    // mis-optimise those, and weak drivers are this project's design floor.
    Loop({ start: int(0), end: int(VT_MAX_MIPS), type: 'int', condition: '<' }, ({ i }) => {
      If(found.equal(int(0)).and(i.greaterThanEqual(startMip)).and(i.lessThanEqual(uniforms.uMaxMip)), () => {
        // World texels per page at mip i: payloadPx * 2^i.
        const payloadSpan = float(payloadPx).mul(float(2).pow(i.toFloat()));
        const cellF = worldPx.div(payloadSpan);
        const ppa = uniforms.uMipPagesPerAxis.element(i);
        // Clamp is a REAL array-bounds safety for the indirection read — the
        // out-of-world case is handled separately in sample(), precisely so this
        // clamp can never masquerade as one (that conflation was the live
        // edge-smear bug).
        const texel = ivec2(cellF.floor()).clamp(ivec2(0, 0), ppa.sub(ivec2(1, 1)));
        const phys = uniforms.uMipOrigin.element(i).add(texel);

        // Decode one indirection texel: RGBA8 where R|G<<8 is the atlas slot and
        // A>0.5 means resident. textureLoad, never filtered — an indirection texel
        // is an ID, and interpolating an ID is meaningless.
        const t = textureLoad(uniforms.uPageTable, phys);
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
    });
    return result;
  });

  /**
   * Sample at world-normalised UV (0..1 across THIS virtual texture's own image).
   * Cross-fades the two mip levels bracketing `uRequestedMipFrac`.
   */
  const sample = Fn(([worldUV]) => {
    // Texel index MUST come from real world pixels / a FIXED payload — NEVER from
    // worldUV * pagesPerAxis. See the header; confirmed live 2026-07-15.
    const worldPx = worldUV.mul(uniforms.uWorldSizePx);

    const mipLo = uniforms.uRequestedMip;
    const mipHi = mipLo.add(int(1)).min(uniforms.uMaxMip);

    const colorLo = sampleFromMip(mipLo, worldPx);
    const colorHi = sampleFromMip(mipHi, worldPx);
    const t = uniforms.uRequestedMipFrac.sub(mipLo.toFloat()).clamp(0, 1);
    // At the top of the pyramid mipHi === mipLo, so the blend is a no-op and
    // colorLo is returned unchanged — the GLSL's early-return, expressed as data.
    const blended = colorLo.mix(colorHi, select(mipHi.greaterThan(mipLo), t, float(0)));

    // OUT-OF-WORLD: a DISTINCT early-out, not a clamp. viewToWorldRect is
    // deliberately unclamped, so worldUV legitimately leaves [0,1] near an edge.
    // Resolving that through the paging system re-samples the edge page forever —
    // the stretched-smear bug. Outside the world is its own case: matte black,
    // never magenta (that is reserved for a broken pin invariant) and never a smear.
    const outside = worldPx.lessThan(vec2(0, 0)).any().or(worldPx.greaterThanEqual(uniforms.uWorldSizePx).any());
    return select(outside, vec4(0, 0, 0, 1), blended);
  });

  return { uniforms, sample };
}
