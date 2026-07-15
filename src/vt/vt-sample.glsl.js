/**
 * @fileoverview vt/vt-sample.glsl.js — THE shared virtual-texture sampler
 * (Keyhole.md §4.1): "Every consumer — geometry, masks, effects — samples
 * through this include and nothing else."
 *
 * CURRENT CUT — single mip, no coarse fallback. Stage 1 part 4's smoke test
 * (vt/vt-smoke-test.js) proves atlas + indirection + this shader render real
 * pixels correctly for one fully-resident page block; it deliberately never
 * exercises a miss, so there was nothing to verify a fallback walk against
 * yet. Building that walk against an untested GPU mip-chain API would have
 * been speculative — building it against a passing smoke test is not. THE
 * DEFERRED TARGET (write it down so "ship the minimal version" doesn't quietly
 * become "the rest never gets built" — same discipline as the Stage 6 effects
 * methodology): once residency.js's real mip selection is wired (part 4b+),
 * add back `uRequestedMip`/`uMaxMip` and either (a) a real GPU mip chain on
 * `uPageTable` sampled via `texelFetch(sampler, texel, level)`, or (b) an
 * explicit per-mip uniform array with an UNROLLED (not dynamically-indexed)
 * lookup — GLSL ES 3.00 dynamic sampler-array indexing has inconsistent
 * driver support, which matters a lot on the exact class of weak/aging GPU
 * this project's whole crash campaign was about; unrolling is slightly
 * uglier but portable. A miss (not-resident texel) still returns loud magenta
 * (never black) as the placeholder for that future fallback.
 *
 * THE UNIFORM CONTRACT for this cut:
 *   uniform sampler2DArray uPageAtlas;   // the ONE physical cache (shared by
 *                                        // every virtual texture — see atlas.js)
 *   uniform sampler2D      uPageTable;   // THIS virtual texture's indirection
 *                                        // at ONE mip level (mip 0 today).
 *                                        // Plain 2D texture, NearestFilter,
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
uniform int uPagesPerAxis;
uniform int uPagesPerLayer;
uniform float uPageSizePx;
uniform float uBorderPx;
uniform float uAtlasSizePx;
uniform float uWorldSizePx;

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

/**
 * Sample the virtual texture at world-normalized UV (0..1 across THIS
 * virtual texture's world extent — the caller maps its own world-space
 * position into this range before calling). Single-mip cut (see header) —
 * a miss returns loud magenta, never black, as the not-yet-built fallback's
 * placeholder.
 */
vec4 vtSample(vec2 worldUV) {
  // THE FIX (confirmed live 2026-07-15): texel index MUST be derived via
  // actual world pixels / a FIXED payloadPx — NEVER via worldUV * pagesPerAxis.
  // pagesPerAxis*payloadPx (the "nominal" padded grid, e.g. 49*248=12152)
  // does NOT equal worldSizePx (e.g. 12000 — ceil() rounding leaves the grid
  // slightly larger than the world). Scaling worldUV (normalized against the
  // REAL worldSizePx) by pagesPerAxis silently assumes those two denominators
  // are equal — they're off by ~1.3% on the torture fixture, which drifts by
  // a whole texel over ~25 pages and showed up as a magenta strip exactly on
  // the far edge of a resident block. Must match page-table.js/decode-pool.js's
  // own convention exactly: pageIndex = floor(worldPixelX / payloadPx).
  float payloadPx = uPageSizePx - uBorderPx * 2.0;
  vec2 worldPx = worldUV * uWorldSizePx;
  vec2 cellF = worldPx / payloadPx;
  // Clamp bound MUST be the INDIRECTION texture's own real dimensions
  // (queried directly — e.g. 49x49 for the torture fixture), NOT
  // uPagesPerAxis (that uniform is the ATLAS's slot grid — e.g. 4x4 for a
  // small test atlas — a completely different number used only in
  // vtSlotToAtlas below). Conflating the two was a second, worse bug
  // introduced by the first fix: it clamped every texel lookup down into
  // [0, atlasPagesPerAxis-1], which is nowhere near where real pages are
  // indexed (23-25 on this fixture) — every sample missed, all magenta.
  ivec2 tableSize = textureSize(uPageTable, 0);
  ivec2 texel = clamp(ivec2(floor(cellF)), ivec2(0), tableSize - ivec2(1));

  VTPage page = vtDecodeIndirection(texel);
  if (!page.resident) {
    return vec4(1.0, 0.0, 1.0, 1.0); // magenta — matches FrameGraph's own
                                      // "clear aliased RTs to magenta" debug
                                      // convention (docs/planning/v3/B0-2-frame-graph.md §5.3)
  }

  int tileX, tileY, layer;
  vtSlotToAtlas(page.slot, tileX, tileY, layer);

  // Fractional position within this page cell, border-safe: map into the
  // payload region only (uBorderPx in from each edge), never sampling across
  // into a neighboring page's border texels. Same cellF as the texel lookup
  // above — one consistent coordinate space throughout, not two.
  vec2 cellUV = fract(cellF);
  vec2 pagePx = vec2(tileX, tileY) * uPageSizePx + uBorderPx + cellUV * payloadPx;
  vec2 atlasUV = pagePx / uAtlasSizePx;

  return texture(uPageAtlas, vec3(atlasUV, float(layer))); // bilinear (default sampler filter)
}
// ---- end vt-sample.glsl -----------------------------------------------
`;
