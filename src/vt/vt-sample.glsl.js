/**
 * @fileoverview vt/vt-sample.glsl.js — THE shared virtual-texture sampler
 * (Keyhole.md §4.1): "Every consumer — geometry, masks, effects — samples
 * through this include and nothing else."
 *
 * FIRST CUT, not yet wired into a real pass or visually verified — that
 * happens in Stage 1 part 3, against the torture fixture's labeled grid
 * (which exists specifically to make a sampling/streaming bug "visually
 * obvious", per Keyhole.md §8 Stage 0). GLSL can't be Node-tested (no WebGL
 * under Node); this is checked against the spec and the JS-side atlas.js/
 * page-table.js conventions it must stay consistent with, not against a
 * running GPU yet.
 *
 * THE UNIFORM CONTRACT every consumer binds, per (floor x layer-pack) virtual
 * texture it samples:
 *   uniform sampler2DArray uPageAtlas;   // the ONE physical cache (shared by
 *                                        // every virtual texture — see atlas.js)
 *   uniform sampler2D      uPageTable;   // THIS virtual texture's indirection,
 *                                        // real GPU mip chain, each level
 *                                        // written by the CPU (see below) —
 *                                        // NEVER hardware-mip-generated, an
 *                                        // averaged slot ID is a corrupt ID.
 *   uniform int   uRequestedMip;         // CPU-computed per frame by
 *                                        // vt/residency.js's chooseMip() —
 *                                        // mip selection is an analytic CPU
 *                                        // decision here (Keyhole.md §4.1:
 *                                        // "gives exactly the needed page
 *                                        // range and mip ... on the CPU"),
 *                                        // NOT a per-pixel GPU derivative LOD.
 *   uniform int   uMaxMip;               // this virtual texture's PageTable.maxMip
 *   uniform int   uPagesPerAxis;         // atlas.js computeAtlasLayout().pagesPerAxis
 *   uniform int   uPagesPerLayer;        // computeAtlasLayout().pagesPerLayer
 *   uniform float uPageSizePx;           // computeAtlasLayout().pageSizePx (256)
 *   uniform float uBorderPx;             // (pageSizePx - payloadPx) / 2 (== 4)
 *   uniform float uAtlasSizePx;          // computeAtlasLayout().atlasSizePx (4096)
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
 * @module vt/vt-sample.glsl
 */

/**
 * The shared include. Concatenate this once per shader program that needs VT
 * sampling; call `vtSample(worldUV)` from the fragment shader.
 */
export const VT_SAMPLE_GLSL = /* glsl */`
// ---- vt-sample.glsl (generated include, see src/vt/vt-sample.glsl.js) -----
uniform sampler2DArray uPageAtlas;
uniform sampler2D uPageTable;
uniform int uRequestedMip;
uniform int uMaxMip;
uniform int uPagesPerAxis;
uniform int uPagesPerLayer;
uniform float uPageSizePx;
uniform float uBorderPx;
uniform float uAtlasSizePx;

// Decode one indirection texel. Returns resident (a>0.5) + the slot index.
// NEAREST/texelFetch only — an indirection texel is an ID, never filtered
// (B0-1's rule for ID attachments applies identically here).
struct VTPage { bool resident; int slot; };

VTPage vtDecodeIndirection(ivec2 texel, int mip) {
  vec4 t = texelFetch(uPageTable, texel, mip);
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

/**
 * Sample the virtual texture at world-normalized UV (0..1 across THIS
 * virtual texture's world extent — the caller maps its own world-space
 * position into this range before calling).
 *
 * Automatic coarse fallback: starts at uRequestedMip and walks toward
 * uMaxMip until it finds a resident page. Worst case is a blurrier sample
 * from a coarser (always-resident, coarse-pinned) mip — never a hole, never
 * a crash (Keyhole.md §4.1's "worst case is blur, never black, never loss").
 */
vec4 vtSample(vec2 worldUV) {
  for (int mip = 0; mip <= 16; mip++) {
    if (mip < uRequestedMip) continue;   // GLSL loop bound is compile-time; skip below the start
    if (mip > uMaxMip) break;

    ivec2 tableSize = textureSize(uPageTable, mip);
    ivec2 texel = clamp(ivec2(worldUV * vec2(tableSize)), ivec2(0), tableSize - ivec2(1));
    VTPage page = vtDecodeIndirection(texel, mip);
    if (!page.resident) continue;

    int tileX, tileY, layer;
    vtSlotToAtlas(page.slot, tileX, tileY, layer);

    // Fractional position within THIS mip's page cell, border-safe: map into
    // the payload region only (uBorderPx in from each edge), never sampling
    // across into a neighboring page's border texels.
    vec2 cellUV = fract(worldUV * vec2(tableSize));
    float payloadPx = uPageSizePx - uBorderPx * 2.0;
    vec2 pagePx = vec2(tileX, tileY) * uPageSizePx + uBorderPx + cellUV * payloadPx;
    vec2 atlasUV = pagePx / uAtlasSizePx;

    return texture(uPageAtlas, vec3(atlasUV, float(layer))); // bilinear (default sampler filter)
  }
  // Nothing resident anywhere up to maxMip — should be structurally
  // impossible (the coarse pin set covers the whole top mip, always). If this
  // ever fires it's a bug in the residency/pin system, not a valid steady
  // state; return a loud, obviously-wrong color rather than black (which
  // would silently look like "correctly dark").
  return vec4(1.0, 0.0, 1.0, 1.0); // magenta — matches FrameGraph's own
                                    // "clear aliased RTs to magenta" debug
                                    // convention (docs/planning/v3/B0-2-frame-graph.md §5.3)
}
// ---- end vt-sample.glsl -----------------------------------------------
`;
