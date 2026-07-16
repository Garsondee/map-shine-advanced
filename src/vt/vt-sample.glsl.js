/**
 * @fileoverview vt/vt-sample.glsl.js — THE shared virtual-texture sampler
 * (Keyhole.md §4.1): "Every consumer — geometry, masks, effects — samples
 * through this include and nothing else."
 *
 * MULTI-MIP with automatic coarse fallback (§4.1's core "not loaded yet means
 * SOFT, not wrong" guarantee). The single-mip cut that shipped through Stage 1
 * part 4b is gone: `vtSample()` now walks from the CPU-chosen requested mip
 * (analytic, from residency.js's chooseMip — top-down camera, no GPU feedback
 * pass) toward the coarsest, and samples the FINEST-RESIDENT level it finds.
 * A texel that isn't resident at the requested mip transparently resolves
 * through the next-coarser level, and ultimately through the always-resident
 * coarse pins (residency.coarsePinSet) — so the worst case a viewer can ever
 * show is BLUR, never black, never a miss. Magenta is retained purely as a
 * structural-bug tripwire: with coarse pins pinned it should be UNREACHABLE,
 * so seeing it means the pin invariant broke, not "still streaming".
 *
 * THE INDIRECTION IS A FLATTENED MIP PYRAMID (page-table.js's
 * computeIndirectionAtlasLayout): all mip levels' page grids packed into ONE
 * small RGBA8 texture, addressed per-mip via plain `ivec2`/`int` uniform
 * ARRAYS. This deliberately avoids a `sampler2D[]` per mip — GLSL ES 3.00
 * sampler-array indexing has inconsistent driver support on exactly the
 * weak/aging GPU class this project's crash campaign was about (the prior
 * deferred-target note flagged both options; the flattened-pyramid route needs
 * no sampler-array indexing anywhere, so it's the portable one).
 *
 * THE UNIFORM CONTRACT:
 *   uniform sampler2DArray uPageAtlas;   // the ONE physical cache (shared by
 *                                        // every virtual texture — see atlas.js)
 *   uniform sampler2D      uPageTable;   // THIS virtual texture's flattened-
 *                                        // pyramid indirection (all mips, one
 *                                        // texture). Plain 2D, NearestFilter,
 *                                        // no mipmaps generated.
 *   uniform int   uPagesPerAxis;         // atlas.js computeAtlasLayout().pagesPerAxis
 *   uniform int   uPagesPerLayer;        // computeAtlasLayout().pagesPerLayer
 *   uniform float uPageSizePx;           // computeAtlasLayout().pageSizePx (256)
 *   uniform float uBorderPx;             // (pageSizePx - payloadPx) / 2 (== 4)
 *   uniform float uAtlasSizePx;          // computeAtlasLayout().atlasSizePx
 *   uniform float uWorldSizePx;          // THIS virtual texture's PageTable.worldSizePx —
 *                                        // MUST be the real world size, never derived from
 *                                        // uPagesPerAxis*payloadPx (that "nominal" grid is
 *                                        // rounded UP by ceil() and does not equal it —
 *                                        // confirmed live 2026-07-15, see vtSample()'s comment).
 *   uniform int   uRequestedMip;         // residency.chooseMip() — the finest mip to TRY.
 *   uniform float uRequestedMipFrac;     // residency.chooseMipFraction() — SAME quantity as
 *                                        // uRequestedMip, not rounded down (2026-07-16, smooth
 *                                        // mip blending — see vtSample()'s own comment). Always
 *                                        // satisfies floor(uRequestedMipFrac) == uRequestedMip
 *                                        // (Node-verified in residency.test — this is what lets
 *                                        // the two values stay in lockstep without a shader-side
 *                                        // consistency check).
 *   uniform int   uMaxMip;               // PageTable.maxMip — the coarsest (top) level.
 *   uniform ivec2 uMipOrigin[VT_MAX_MIPS];      // per-mip texel origin in uPageTable
 *                                        //   (computeIndirectionAtlasLayout().origins[m].{x,y})
 *   uniform int   uMipPagesPerAxis[VT_MAX_MIPS];// per-mip page grid size (origins[m].pagesPerAxis)
 *
 * uPageTable texel encoding (RGBA8, written by the CPU when a page's
 * residency changes — see page-table.js's setSlot()):
 *   R = slot & 0xFF            (slot low byte)
 *   G = (slot >> 8) & 0xFF     (slot high byte — supports slot up to 65535,
 *                                 far past any real cache size, future-proof)
 *   B = unused (reserved)
 *   A = 255 if resident, 0 if not (the clear value is (0,0,0,0) == not
 *       resident, matching B0-1's "clear value is the not-present state"
 *       convention for ID-style attachments)
 *
 * SMOOTH MIP BLENDING (added 2026-07-16, author-reported: "zooming in and out
 * produces very ugly zoom levels" — the hard integer-mip pop at chooseMip()'s
 * threshold). `vtSample()` now samples the TWO mip levels bracketing the
 * continuous `uRequestedMipFrac` (its floor and ceil) and cross-fades between
 * them by the fractional part — the standard trilinear-filtering shape,
 * applied here across VIRTUAL-texture mips instead of a hardware mip chain.
 * NO residency/streaming change was needed: `planResidency()` already
 * requests mip M ('fine') and mip M+1 ('prefetchCoarser', clamped to
 * uMaxMip) as insurance against a fine-mip miss — those happen to be exactly
 * the two mips a blend needs. The single-mip WALK itself (requestedMip up to
 * uMaxMip, finest-resident-wins, coarse-pin-guaranteed termination) is
 * UNCHANGED — factored into `vtSampleFromMip()` below and called twice
 * (once per bracket) rather than rewritten, specifically so the nine
 * live-debugged bugs that walk logic survived (Y-flip, coordinate-space,
 * clamp-bound, texture-unit-cache, the UV-compounding bug — see
 * vt-pan-viewer.js's header) are not put at risk by this change. Magenta
 * stays a valid tripwire under blending: EVERY call to `vtSampleFromMip()`
 * terminates at `uMaxMip` (the coarse pin, always resident), so magenta is
 * exactly as unreachable in either bracket sample as it was in the original
 * single walk — no new fallback semantics were introduced.
 *
 * @module vt/vt-sample.glsl
 */

/**
 * Compile-time upper bound on mip levels the flattened-pyramid uniform arrays
 * carry. A 16K world is 8 mips (67,34,17,9,5,3,2,1); 16 is generous headroom
 * for any world size this design targets, and the fragment loop only ever
 * touches [uRequestedMip, uMaxMip] ⊆ [0, mipCount-1] — higher slots are skipped.
 * MUST match the JS-side array length in vt-pan-viewer.js.
 */
export const VT_MAX_MIPS = 16;

/**
 * The shared include. Concatenate this once per shader program that needs VT
 * sampling; call `vtSample(worldUV)` from the fragment shader.
 */
export const VT_SAMPLE_GLSL = /* glsl */ `
// ---- vt-sample.glsl (generated include, see src/vt/vt-sample.glsl.js) -----
#define VT_MAX_MIPS ${VT_MAX_MIPS}

uniform sampler2DArray uPageAtlas;
uniform sampler2D uPageTable;
uniform int uPagesPerAxis;
uniform int uPagesPerLayer;
uniform float uPageSizePx;
uniform float uBorderPx;
uniform float uAtlasSizePx;
uniform float uWorldSizePx;
uniform int uRequestedMip;
uniform float uRequestedMipFrac;
uniform int uMaxMip;
uniform ivec2 uMipOrigin[VT_MAX_MIPS];
uniform int uMipPagesPerAxis[VT_MAX_MIPS];

// Decode one indirection texel. Returns resident (a>0.5) + the slot index.
// NEAREST/texelFetch only — an indirection texel is an ID, never filtered
// (B0-1's rule for ID attachments applies identically here).
struct VTPage { bool resident; int slot; };

VTPage vtDecodeIndirection(ivec2 texel) {
  vec4 t = texelFetch(uPageTable, texel, 0);
  VTPage p;
  p.resident = t.a > 0.5;
  p.slot = int(t.r * 255.0 + 0.5) + int(t.g * 255.0 + 0.5) * 256;
  return p;
}

// slot -> atlas (tileX, tileY, layer). Must stay in exact lockstep with
// atlas.js's slotToAtlasPosition() — same row-major, layer-0-first packing.
void vtSlotToAtlas(int slot, out int tileX, out int tileY, out int layer) {
  layer = slot / uPagesPerLayer;
  int withinLayer = slot - layer * uPagesPerLayer;
  tileX = withinLayer % uPagesPerAxis;
  tileY = withinLayer / uPagesPerAxis;
}

// Sample the atlas at a resident page's slot, given the fractional position
// within that page's payload. Border-safe: maps into the payload region only
// (uBorderPx in from each edge), never sampling a neighbor's border texels.
//
// textureLod(...,0.0) — NOT texture() — is deliberate (found live 2026-07-16,
// "zooming out looks pixelated/ugly"; see atlas.js's matching comment for the
// full mechanism). A page's atlas slot is essentially arbitrary bookkeeping,
// so neighboring screen pixels can land on unrelated atlas locations at every
// page boundary; automatic (derivative-based) LOD selection reads those jumps
// as "zoom out further," picking a coarser atlas mip that was never even
// rebuilt as pages streamed in — worse the more pages are on screen, exactly
// matching the reported symptom. Forcing level 0 explicitly makes this
// structurally impossible regardless of any texture's filter settings, not
// just reliant on them being configured correctly elsewhere (atlas.js also
// disables the atlas's mip chain — this is the belt to that suspenders).
// Still bilinear WITHIN level 0 (LinearFilter) — only the (bogus) ACROSS-page
// mip selection is removed, not ordinary in-page texel smoothing.
vec4 vtSampleAtlasSlot(int slot, vec2 cellUV) {
  float payloadPx = uPageSizePx - uBorderPx * 2.0;
  int tileX, tileY, layer;
  vtSlotToAtlas(slot, tileX, tileY, layer);
  vec2 pagePx = vec2(tileX, tileY) * uPageSizePx + uBorderPx + cellUV * payloadPx;
  vec2 atlasUV = pagePx / uAtlasSizePx;
  return textureLod(uPageAtlas, vec3(atlasUV, float(layer)), 0.0);
}

/**
 * THE single-mip walk (UNCHANGED behavior from the pre-blend version — only
 * extracted into its own function so vtSample() can call it twice, once per
 * bracket mip): walks from startMip up to uMaxMip and returns the finest-
 * resident level's texel (automatic coarse fallback). With coarse pins
 * pinned this never returns magenta; magenta means a broken pin invariant,
 * not "streaming". worldPx/payloadPx are the caller's already-computed
 * values (both brackets share them -- no need to recompute per call).
 */
vec4 vtSampleFromMip(int startMip, vec2 worldPx, float payloadPx) {
  // No early return inside the loop (some weak drivers — the exact target
  // class — mis-optimize loop-body returns): accumulate into result + break.
  vec4 result = vec4(1.0, 0.0, 1.0, 1.0); // magenta tripwire (see vtSample()'s doc)
  bool found = false;
  // Constant bounds (0..VT_MAX_MIPS) so the compiler can unroll; the per-
  // iteration guards skip anything outside [startMip, uMaxMip]. All array
  // indices here are non-sampler (ivec2/int) — dynamic indexing is fully legal.
  for (int m = 0; m < VT_MAX_MIPS; ++m) {
    if (found) continue;
    if (m < startMip || m > uMaxMip) continue;

    float payloadSpan = payloadPx * float(1 << m); // world texels per page at mip m
    vec2 cellF = worldPx / payloadSpan;
    int ppa = uMipPagesPerAxis[m];
    ivec2 texel = clamp(ivec2(floor(cellF)), ivec2(0), ivec2(ppa - 1));
    ivec2 phys = uMipOrigin[m] + texel; // into the flattened-pyramid indirection

    VTPage page = vtDecodeIndirection(phys);
    if (page.resident) {
      result = vtSampleAtlasSlot(page.slot, fract(cellF));
      found = true;
    }
  }
  return result;
}

/**
 * Sample the virtual texture at world-normalized UV (0..1 across THIS virtual
 * texture's world extent — the caller maps its own world-space position into
 * this range). Cross-fades between the two mip levels bracketing
 * uRequestedMipFrac (its floor and ceil, each walked to finest-resident via
 * vtSampleFromMip — see this file's header for why blending needed no
 * residency change and doesn't put the walk's own proven correctness at risk).
 */
vec4 vtSample(vec2 worldUV) {
  // Texel index MUST be derived via actual world pixels / a FIXED payloadPx —
  // NEVER via worldUV * pagesPerAxis (confirmed live 2026-07-15). At mip m one
  // page covers payloadPx * 2^m world texels; cellF's integer part is the page
  // index at that mip, its fract() is the position within the page. See
  // page-table.js/decode-pool.js's own convention: floor(worldPixelX / payloadSpan).
  float payloadPx = uPageSizePx - uBorderPx * 2.0;
  vec2 worldPx = worldUV * uWorldSizePx;

  // OUT-OF-WORLD GUARD (found live 2026-07-15 — "the very edge of the map
  // causes a stretched blurred copy of the texture to appear... on all
  // edges"): viewToWorldRect() is DELIBERATELY unclamped (view-state.js's own
  // doc comment — lets computeVisiblePages naturally shrink the page COUNT
  // near a world edge instead of silently re-centering the view). That means
  // worldUV legitimately goes outside [0,1] whenever the framed rect extends
  // past the world boundary — panning near an edge, or just a screen wider
  // than the remaining world at the current zoom. Without this guard, the
  // per-mip texel lookup below clamps its ivec2 index into [0, ppa-1] to stay
  // in-bounds for the INDIRECTION array read (a real, still-needed safety
  // clamp against a garbage array index) — but that silently makes every
  // out-of-world UV re-sample the EDGE page over and over, which is exactly a
  // stretched/smeared copy of that page's content. The fix is a distinct
  // early-out BEFORE the mip walk: outside the world is its own case (matte
  // black, like the empty space outside a level in any tile-based renderer),
  // never resolved through the paging system at all.
  if (worldPx.x < 0.0 || worldPx.y < 0.0 || worldPx.x >= uWorldSizePx || worldPx.y >= uWorldSizePx) {
    return vec4(0.0, 0.0, 0.0, 1.0); // outside the world — matte black, not magenta (that's reserved for "broken pin invariant") and not a smear
  }

  // uRequestedMip (int) and uRequestedMipFrac (float) are set from the SAME
  // CPU computation every residency update (residency.chooseMip /
  // chooseMipFraction — Node-verified floor(frac)==int, always) — mipLo is
  // read from the already-clamped-and-rounded int uniform rather than
  // re-flooring the float here, so a shader-side rounding quirk on any driver
  // can never desync mipLo from what the residency/prefetch system actually
  // requested pages for.
  int mipLo = uRequestedMip;
  int mipHi = min(mipLo + 1, uMaxMip);

  vec4 colorLo = vtSampleFromMip(mipLo, worldPx, payloadPx);
  if (mipHi <= mipLo) {
    return colorLo; // top-of-pyramid degenerate case (no coarser mip exists) — no second sample needed
  }

  vec4 colorHi = vtSampleFromMip(mipHi, worldPx, payloadPx);
  float t = clamp(uRequestedMipFrac - float(mipLo), 0.0, 1.0); // fractional position between the two brackets
  return mix(colorLo, colorHi, t);
}
// ---- end vt-sample.glsl -----------------------------------------------
`;
