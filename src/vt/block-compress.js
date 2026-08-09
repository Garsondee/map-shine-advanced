/**
 * @fileoverview vt/block-compress.js — pure, GPU-free BLOCK TEXTURE COMPRESSION.
 *
 * WHY THIS EXISTS (2026-07-18, measured): Chrome's WebGPU device loses itself at
 * ~2.5 GB of resident texture on this hardware, where its far-older, hardened
 * WebGL degrades gracefully instead. A 12000² floor is 549 MB as RGBA8; both
 * floors of the mansion exceed the wall (~2.75 GB). GPU-compressed textures are
 * WebGPU's FIRST-CLASS answer (a core feature here, not a WebGL-style extension):
 * BC1 stores the same image at 0.5 byte/px (8× smaller), BC7 at 1 byte/px (4×)
 * with much better quality. Foundry's security model forbids writing generated
 * files back to its data directory, so we encode in the BROWSER (off-thread) and
 * cache the blocks in IndexedDB — nothing ever touches Foundry's filesystem.
 *
 * THIS MODULE IS THE ENCODER CORE: pure arithmetic over Uint8 pixel data,
 * Node-testable without a GPU (see __tests__/block-compress.test.mjs — it
 * round-trips every encoder through its own decoder). Opaque content goes BC1
 * (8×), alpha content goes BC7 (4×), both behind the same
 * `encode*(rgba, w, h) → Uint8Array` shape. The consumer wraps the output in a
 * THREE.CompressedTexture whose `format` matches (RGBA_S3TC_DXT1_Format for BC1,
 * RGBA_BPTC_Format for BC7) and whose mips are `{ data, width, height }`.
 *
 * QUALITY, not just size (2026-08-06). Both encoders started as the simplest
 * thing that could be proven correct — one BC7 mode, and "the two texels
 * farthest apart" for endpoints — and that simplicity had a measurable cost the
 * averaged test bars could not see: individual texels landing on completely the
 * wrong colour (max channel error 119/255 on an antialiased cutout edge, 127 on
 * thin linework) while the MEAN stayed under 3. On screen that is speckle, and
 * the albedo-clarity sharpen in `vt-pan-viewer.js` amplifies it, which is what
 * the author reported as grain when zoomed out past 1:1. Three changes, each
 * with its own section header below and its own measurements:
 *   - THE LINE FIT — PCA endpoints + least-squares refinement, shared by both
 *     formats. Also stopped BC1 INFLATING contrast (a decode that came back
 *     with more RMS contrast than its source is posterisation).
 *   - BC7 MODE 5 — colour and alpha on separate index tracks.
 *   - BC7 MODE 7 — two subsets, for blocks holding three colour clusters.
 * Every block scores all applicable modes and emits the winner, so none of this
 * can regress a block the earlier encoder already handled well.
 *
 * ⚠️ THE BIT LAYOUTS ARE VERIFIED AGAINST REAL HARDWARE, NOT ONLY AGAINST OUR
 * OWN DECODER. This file's decoder shares an author with its encoder, so a
 * wrong field offset or mistranscribed table is used identically by both and
 * round-trips perfectly while a GPU renders noise
 * (memory: feedback_smooth_output_hides_ported_bugs).
 * `tools/shader-lab/bench-block-compress.js` uploads real encoder output as a
 * real CompressedTexture and compares the GPU's fixed-function decode against
 * `decodeBC7`/`decodeBC1` — the only oracle independent of our reading of the
 * spec. All three BC7 modes measured BYTE-EXACT there. BC1's two INTERPOLATED
 * palette entries legitimately differ (S3TC leaves their low bits
 * implementation-defined); its endpoints are exact. Read that bench's own
 * `BC1_INTERPOLANT_TOLERANCE` note before "fixing" a BC1 ±1.
 *
 * BC1 block = 8 bytes for a 4×4 texel group:
 *   bytes 0..1  color0 as RGB565, little-endian uint16
 *   bytes 2..3  color1 as RGB565, little-endian uint16
 *   bytes 4..7  sixteen 2-bit palette indices (texel 0 = bits 0..1 of byte 4)
 * If color0 > color1 (as uint16) the palette is 4 opaque colors
 *   [c0, c1, (2·c0+c1)/3, (c0+2·c1)/3]; otherwise it is 3 opaque colors plus a
 * transparent slot. We keep alpha out of BC1 entirely (opaque backgrounds are
 * BC1's job; alpha layers get BC7) and never emit index 3 in the 3-color case,
 * so no transparency ever leaks.
 */

/**
 * RGB888 → packed RGB565 uint16 (the value the GPU stores and expands).
 *
 * ⚠️ THIS ROUNDS ONCE, DELIBERATELY (2026-07-29). It used to read
 * `Math.round((v * 31 + 127) / 255)`, which rounds TWICE: `+127` is already the
 * rounding offset for a FLOOR division by 255, and applying `Math.round` on top
 * of that turns the whole expression into an effective CEILING. The result was
 * a systematic one-directional brightening of every BC1 endpoint — measured
 * over all 256 inputs, mean signed reconstruction error +4.08/255 and a worst
 * case of 8, against +0.0/4 for the plain `round(v * 31 / 255)` here now.
 *
 * WHY IT MATTERED, not just why it was untidy: the bias is one-directional, so
 * nothing downstream can cancel it. Both endpoint candidates (see the SECOND
 * ENDPOINT CANDIDATE header below) are quantized by THIS function, so the
 * error-scored choice between them picks the better of two equally-brightened
 * options, and the index search then snaps every texel onto a line that has
 * already drifted light. Measured on 256² fixtures, whole-pipeline encode→decode:
 *   dark ink linework on paper  mean |err| 3.43 → 2.00, bias +3.43 → +0.76, max 7 → 4
 *   saturated colour field      mean |err| 2.69 → 1.44, bias +2.11 → +0.13, max 16 → 6
 *   parchment gradient + noise  mean |err| 2.11 → 1.75, bias +0.45 → +0.03
 * Ink linework is the load-bearing case: it is the SAME "black outline goes
 * mushy" family the second-endpoint candidate was added for a day earlier, and
 * BC1 is what every fully-opaque floor/background painting encodes as.
 *
 * A tempting-looking `(v * 31 + 127) >> 8` is NOT equivalent to either form —
 * `>> 8` divides by 256, not 255, and differs from the old expression on 143 of
 * 256 inputs. Verified exhaustively; do not "simplify" this to a shift.
 *
 * Changing this changed the encoder's output bytes, which is why
 * bc-compress.worker.js's CACHE_VERSION went 7 → 8 in the same commit. The two
 * move together, always — see the encoder-output pin in this module's tests.
 */
function toRgb565(r, g, b) {
  const r5 = Math.round((r * 31) / 255);
  const g6 = Math.round((g * 63) / 255);
  const b5 = Math.round((b * 31) / 255);
  return ((r5 & 0x1f) << 11) | ((g6 & 0x3f) << 5) | (b5 & 0x1f);
}

/** Packed RGB565 uint16 → {r,g,b} expanded to 8-bit EXACTLY as a GPU decodes it
 * (replicate the high bits into the low bits — the canonical 565→888 expand). */
function fromRgb565(v) {
  const r5 = (v >> 11) & 0x1f;
  const g6 = (v >> 5) & 0x3f;
  const b5 = v & 0x1f;
  return {
    r: (r5 << 3) | (r5 >> 2),
    g: (g6 << 2) | (g6 >> 4),
    b: (b5 << 3) | (b5 >> 2),
  };
}

// ===========================================================================
// THE SECOND ENDPOINT CANDIDATE — "diagonal parts of the black outline
// disappear/are mushed" (author, 2026-07-28, cutout tile art zoomed out).
//
// MEASURED before touching anything: a 3px-wide black ink ring around a filled
// disc, BC7-encoded with NO mip reduction and NO sharpening involved at all —
// axis-aligned ink texels decoded EXACT (luma 10.0 of a source 10.0); diagonal
// ink texels averaged luma 59.1 (max 78.8) and lost a third of their alpha. The
// mechanism is pure block-endpoint selection, both BC1 and BC7's own encoders:
// the two endpoints are chosen as the texels FARTHEST apart in colour(+alpha)
// space, and every OTHER texel in the block is then index-snapped onto the
// single line between them — a block containing a genuine THIRD cluster (ink
// black, separate from both the interior fill and the transparent hole) has no
// endpoint of its own for it, so it gets crushed toward whichever line was
// actually chosen. In BC7 this is worse than it sounds: alpha's 0..255 swing
// dominates the squared-distance metric so completely that the chosen pair is
// almost always (some opaque texel, the transparent hole) — leaving black ink
// and the coloured interior, both opaque, to fight over ONE shared endpoint.
//
// WHY DIAGONAL SPECIFICALLY: a diagonal silhouette sweeps its alpha cut across
// every row of a 4×4 block (the classic staircase), so a block straddling it is
// far likelier to contain all three clusters — interior, ink, hole — at once.
// The SAME ring crossing a block along a horizontal/vertical run instead
// repeats one row/column identically, so a given block usually holds only two.
//
// THE FIX, kept inside mode 6 / BC1's existing 2-endpoint format (no bitstream
// change): score a SECOND candidate pair — the darkest vs lightest opaque
// texel (`lumaExtremalPair`, below) — against the existing max-distance pair by
// ACTUAL total reconstruction error, and keep whichever is lower. This cannot
// regress a block the old heuristic already got right (the old pair is always
// one of the two options actually scored), and directly recovers the exact
// case above: a genuine second opaque cluster the distance pair swallowed now
// gets a real chance at an endpoint of its own. Cost is ~2× today's per-block
// work (one more quantize + 16-texel index search) — negligible next to the
// existing O(120)-pair distance search, and this runs once per asset, off the
// main thread, cached to IndexedDB.
// ===========================================================================

/**
 * The darkest-vs-lightest texel among those with alpha ≥ 128 ("meaningfully
 * opaque"), by standard luma weighting. Shared by both encoders: for BC1's
 * always-fully-opaque input (BC1 is only ever chosen for a wholly opaque
 * image — see bc-compress.worker.js) the alpha gate is a no-op and every texel
 * qualifies; for BC7 it is what keeps this search from picking a transparent
 * (or dilated, edge-adjacent) texel as a "dark" endpoint by accident. Returns
 * `null` with fewer than 2 qualifying texels — the existing distance pair
 * already handles a block with at most one opaque cluster just fine.
 * @param {Uint8Array} texels flat [r,g,b,a,…] length 64 (the shared gather buffer)
 * @returns {[number,number]|null} texel indices [darkest, lightest]
 */
function lumaExtremalPair(texels) {
  let lo = -1,
    hi = -1,
    loL = Infinity,
    hiL = -Infinity;
  for (let i = 0; i < 16; i++) {
    if (texels[i * 4 + 3] < 128) continue;
    const l = 0.299 * texels[i * 4] + 0.587 * texels[i * 4 + 1] + 0.114 * texels[i * 4 + 2];
    if (l < loL) {
      loL = l;
      lo = i;
    }
    if (l > hiL) {
      hiL = l;
      hi = i;
    }
  }
  return lo >= 0 && hi >= 0 && lo !== hi ? [lo, hi] : null;
}

// ===========================================================================
// ALLOCATION-FREE INSIDE THE BLOCK LOOP (2026-07-29). Everything from here to
// the end of the BC7 encoder writes into buffers allocated ONCE per module, not
// per block. This is not premature tidiness: a 12000² layer is 9 MILLION blocks,
// and the shapes being allocated were per-block `new Array(64)` texel gathers,
// per-candidate `{r,g,b}` palette entries and per-endpoint `new Array(4)` pairs
// — on the order of 10⁸ short-lived objects for ONE floor, all of it inside a
// Web Worker that already fell over once on this exact image size (see the STRIP
// DRIVER header below for that receipt). Scavenging that much garbage is pure
// overhead on a job that is otherwise straight-line integer arithmetic.
//
// SAFE BECAUSE THE ENCODER IS SINGLE-THREADED AND NON-REENTRANT: a worker is one
// thread, these buffers never outlive the `encodeBC*Block` call that fills them,
// and nothing returned from this module aliases them (the block loops copy into
// `out` before the next block reuses the scratch). If a future caller ever wants
// to encode two blocks concurrently, THESE are the things that must be made
// per-call — hence the shared `_scratch` prefix, so a grep finds all of them.
//
// Every change in this pass is BIT-IDENTICAL to what came before — proven in
// __tests__/block-compress.test.mjs by re-asserting the same round-trip bars,
// and (during development) by byte-diffing a corpus against the previous
// encoder. Output bytes are cached in IndexedDB keyed by
// bc-compress.worker.js's CACHE_VERSION; a change that ALTERED the bytes would
// have to bump it. This one does not.
// ===========================================================================

/** The 4×4 texels of block (bx,by), edge-clamped so a width/height that is not a
 * multiple of 4 replicates its border rather than reading out of bounds. Writes
 * a flat [r,g,b,a, …] into `out` (length 64) — the caller owns and REUSES that
 * buffer across every block rather than taking a fresh array per block (see the
 * allocation header above; this is the single biggest allocation in the file). */
function gatherBlock(rgba, width, height, bx, by, out) {
  for (let ty = 0; ty < 4; ty++) {
    const sy = Math.min(by * 4 + ty, height - 1);
    const rowOff = sy * width;
    for (let tx = 0; tx < 4; tx++) {
      const sx = Math.min(bx * 4 + tx, width - 1);
      const si = (rowOff + sx) * 4;
      const di = (ty * 4 + tx) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
}

/** The one 4×4 texel gather both encoders fill and read, reused per block. */
const _scratchTexels = new Uint8Array(64);

/**
 * Do two candidate texel indices name the SAME unordered pair? Both scorers are
 * exactly symmetric under swapping their two endpoints — BC1 sorts c0/c1 into
 * descending order before doing anything else, and BC7's weight table satisfies
 * W[15−k] = 64−W[k], so a swapped pair produces the mirrored palette and the
 * identical total error (it is the same identity the anchor rule below already
 * relies on). Scoring it a second time therefore cannot beat the first (the
 * winner comparison is a STRICT `<`, so an equal total never displaces), which
 * makes skipping it bit-identical rather than an approximation.
 */
function isSamePair(a0, a1, b0, b1) {
  return (a0 === b0 && a1 === b1) || (a0 === b1 && a1 === b0);
}

// ===========================================================================
// THE LINE FIT — shared by BC1 and every BC7 mode below.
//
// Every BC block format stores a block as ONE (or, in partitioned modes, one
// per subset) straight LINE through colour space plus a per-texel index naming
// a point on it. So the whole quality question for a given block is: which line,
// and the answer this file used to give was "the two texels farthest apart".
//
// WHY THAT IS NOT GOOD ENOUGH (2026-08-06, measured before touching anything —
// the bench fixtures now pinned in block-compress.test.mjs):
//
//   BC7 soft antialiased cutout edge   mean err 2.89   MAX 119
//   BC7 thin linework + partial alpha  mean err 2.36   MAX 127
//   BC1 thin linework on parchment     mean err 7.00   MAX  39
//   BC1 saturated colour field         mean err 4.08   MAX  30
//
// A max of ~120/255 is a single texel landing on completely the wrong colour.
// Mean error stays small because most texels are fine — which is exactly why
// this survived four rounds of "the outlines are mushy" work: an AVERAGE cannot
// see it (memory: feedback_aggregate_cannot_name_the_source). On screen those
// stray texels are speckle, and the albedo-clarity sharpen amplifies them into
// the grain the author reported at zoom-out.
//
// A max-distance pair is a heuristic for the principal axis, and it is a poor
// one: it is decided by the two most EXTREME texels, so one outlier (a lone
// antialiased texel straddling ink and paper) drags the whole line off the
// direction the other fifteen actually lie along. Two standard fixes, both here:
//
//  1. PCA — take the real principal axis of the block's covariance, so the line
//     follows where the texels genuinely spread rather than where two of them
//     happen to sit. Outliers move a covariance slightly; they move a
//     max-distance pair completely.
//
//  2. LEAST-SQUARES REFINEMENT — once every texel has picked an index, the
//     endpoints that minimise total squared error are no longer the extremes;
//     they are the exact solution of a 2-parameter linear fit, in closed form.
//     Iterating (assign indices -> re-solve endpoints -> re-assign) is what
//     stb_dxt and squish do, and it is also what stops the encoder OVERSHOOTING:
//     snapping endpoints to block extremes is why the BC1 linework fixture came
//     back with MORE RMS contrast than its source (95.39 -> 101.34), i.e.
//     posterised. Least-squares has no reason to overshoot — it is minimising
//     error against the real texels, not reaching for the corners.
//
// Both are scored, never trusted: every candidate line these produce competes
// with the old max-distance pair on ACTUAL total reconstruction error and only
// wins by being strictly better, so this cannot regress a block the old
// heuristic already handled (the same discipline the SECOND ENDPOINT CANDIDATE
// section above established).
// ===========================================================================

/** Power-iteration steps for the principal axis. Deterministic and fixed: the
 * covariance of 16 texels in <=4 dimensions converges far inside this, and a
 * convergence-tested loop would make the encoder's output depend on a float
 * epsilon — the encoder's bytes are cached and hash-pinned, so it must be
 * bit-reproducible. */
const PCA_ITERATIONS = 8;

const _scratchPcaMean = new Float64Array(4);
const _scratchPcaCov = new Float64Array(16);
const _scratchPcaVec = new Float64Array(4);
const _scratchPcaNext = new Float64Array(4);

/**
 * The principal axis of `count` texels (named by `members`) over the channel
 * list `chans`, as an endpoint pair at the extremes of the projection onto that
 * axis. Writes 8-bit-clamped channel values into `outLo`/`outHi`.
 *
 * Returns `false` when the block has no meaningful spread (every texel on one
 * point, so the covariance is degenerate) — the caller keeps whatever candidate
 * it already had rather than fitting a line to a dot.
 *
 * @param {Uint8Array} texels flat [r,g,b,a,…] length 64
 * @param {Uint8Array|number[]} members texel indices to consider
 * @param {number} count how many entries of `members` are live
 * @param {Uint8Array|number[]} chans channel offsets (0=r,1=g,2=b,3=a)
 * @param {number} nc how many entries of `chans` are live
 * @param {Float64Array} outLo @param {Float64Array} outHi
 * @returns {boolean} whether a usable axis was found
 */
function pcaEndpoints(texels, members, count, chans, nc, outLo, outHi) {
  if (count < 2) return false;
  const mean = _scratchPcaMean;
  for (let c = 0; c < nc; c++) mean[c] = 0;
  for (let k = 0; k < count; k++) {
    const base = members[k] * 4;
    for (let c = 0; c < nc; c++) mean[c] += texels[base + chans[c]];
  }
  for (let c = 0; c < nc; c++) mean[c] /= count;

  const cov = _scratchPcaCov;
  for (let i = 0; i < nc * nc; i++) cov[i] = 0;
  for (let k = 0; k < count; k++) {
    const base = members[k] * 4;
    for (let i = 0; i < nc; i++) {
      const di = texels[base + chans[i]] - mean[i];
      for (let j = i; j < nc; j++) cov[i * nc + j] += di * (texels[base + chans[j]] - mean[j]);
    }
  }
  for (let i = 0; i < nc; i++) for (let j = 0; j < i; j++) cov[i * nc + j] = cov[j * nc + i];

  // Seed from the covariance row with the largest norm: deterministic, and
  // already pointing along a genuine direction of spread, so power iteration
  // starts inside the right half-space instead of risking a near-orthogonal
  // start vector that converges slowly.
  let seed = -1;
  let seedNorm = 0;
  for (let i = 0; i < nc; i++) {
    let n = 0;
    for (let j = 0; j < nc; j++) n += cov[i * nc + j] * cov[i * nc + j];
    if (n > seedNorm) {
      seedNorm = n;
      seed = i;
    }
  }
  if (seed < 0 || seedNorm <= 1e-12) return false;

  const v = _scratchPcaVec;
  const next = _scratchPcaNext;
  for (let i = 0; i < nc; i++) v[i] = cov[seed * nc + i];
  for (let it = 0; it < PCA_ITERATIONS; it++) {
    for (let i = 0; i < nc; i++) {
      let s = 0;
      for (let j = 0; j < nc; j++) s += cov[i * nc + j] * v[j];
      next[i] = s;
    }
    let norm = 0;
    for (let i = 0; i < nc; i++) norm += next[i] * next[i];
    if (!(norm > 1e-12)) return false;
    norm = Math.sqrt(norm);
    for (let i = 0; i < nc; i++) v[i] = next[i] / norm;
  }

  let tMin = Infinity;
  let tMax = -Infinity;
  for (let k = 0; k < count; k++) {
    const base = members[k] * 4;
    let t = 0;
    for (let c = 0; c < nc; c++) t += (texels[base + chans[c]] - mean[c]) * v[c];
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (!(tMax > tMin)) return false;

  for (let c = 0; c < nc; c++) {
    const lo = mean[c] + v[c] * tMin;
    const hi = mean[c] + v[c] * tMax;
    outLo[c] = lo < 0 ? 0 : lo > 255 ? 255 : lo;
    outHi[c] = hi < 0 ? 0 : hi > 255 ? 255 : hi;
  }
  return true;
}

/**
 * Given a FIXED index assignment, solve for the endpoint pair minimising total
 * squared error — the closed-form 2-parameter linear fit.
 *
 * Each texel `i` reconstructs as `e0·(1−t_i) + e1·t_i` where `t_i` is its
 * index's interpolation weight. Minimising `Σ(e0·a_i + e1·b_i − c_i)²` with
 * `a_i = 1−t_i`, `b_i = t_i` gives the normal equations
 *   [ Σa²  Σab ] [e0]   [ Σa·c ]
 *   [ Σab  Σb² ] [e1] = [ Σb·c ]
 * which is a 2×2 solve per channel against one shared, channel-independent
 * matrix.
 *
 * Returns `false` when the system is singular — every texel landed on the SAME
 * index, so the data constrains one point on the line and not two, and there is
 * no unique endpoint pair to solve for. Keeping the incoming endpoints is
 * correct there; inventing one would be fitting noise.
 *
 * @param {Uint8Array} texels @param {Uint8Array|number[]} members @param {number} count
 * @param {Uint8Array|number[]} chans @param {number} nc
 * @param {Uint8Array} idx per-texel index, addressed by texel id
 * @param {number[]|Int32Array} weights the mode's interpolation weight table (over 64)
 * @param {Float64Array} outLo @param {Float64Array} outHi
 * @returns {boolean}
 */
function refineEndpointsLsq(texels, members, count, chans, nc, idx, weights, outLo, outHi) {
  let saa = 0;
  let sab = 0;
  let sbb = 0;
  for (let k = 0; k < count; k++) {
    const t = weights[idx[members[k]]] / 64;
    const a = 1 - t;
    saa += a * a;
    sab += a * t;
    sbb += t * t;
  }
  const det = saa * sbb - sab * sab;
  if (!(Math.abs(det) > 1e-9)) return false;
  for (let c = 0; c < nc; c++) {
    let sac = 0;
    let sbc = 0;
    for (let k = 0; k < count; k++) {
      const m = members[k];
      const t = weights[idx[m]] / 64;
      const v = texels[m * 4 + chans[c]];
      sac += (1 - t) * v;
      sbc += t * v;
    }
    const e0 = (sbb * sac - sab * sbc) / det;
    const e1 = (saa * sbc - sab * sac) / det;
    outLo[c] = e0 < 0 ? 0 : e0 > 255 ? 255 : e0;
    outHi[c] = e1 < 0 ? 0 : e1 > 255 ? 255 : e1;
  }
  return true;
}

/** Every texel of a block, as a `members` list for the fitters above — the
 * common "one subset, all 16 texels" case. */
const ALL_TEXELS = Uint8Array.from({ length: 16 }, (_, i) => i);
/** Channel selectors for the fitters. */
const CHANS_RGB = Uint8Array.from([0, 1, 2]);
const CHANS_RGBA = Uint8Array.from([0, 1, 2, 3]);

/**
 * Encode RGBA8 pixels (row-major, 4 bytes/texel) to BC1 blocks.
 * @param {Uint8Array|Uint8ClampedArray} rgba length must be width*height*4
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} blocksX*blocksY*8 bytes, blocks in row-major order
 */
export function encodeBC1(rgba, width, height) {
  if (width <= 0 || height <= 0) throw new Error(`encodeBC1: bad size ${width}x${height}`);
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodeBC1: rgba length ${rgba.length} != width*height*4 (${expected})`);
  }
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(blocksX * blocksY * 8);
  let o = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      gatherBlock(rgba, width, height, bx, by, _scratchTexels);
      encodeBC1Block(_scratchTexels, out, o);
      o += 8;
    }
  }
  return out;
}

/**
 * One scored BC1 candidate pair. TWO of these exist (one per candidate a block
 * evaluates) and are reused for every block, so the second candidate's score
 * never clobbers the first's while they are being compared — the reason this is
 * two fixed slots rather than one buffer. The palette is held as three parallel
 * FLOAT arrays because BC1's interpolated entries are genuinely fractional
 * (`(2·e0 + e1)/3`) and the nearest search compares against them un-rounded,
 * exactly as the `{r,g,b}` objects it replaces did.
 */
function makeBC1Candidate() {
  return { c0: 0, c1: 0, idx: new Uint8Array(16), total: 0 };
}
const _scratchBC1A = makeBC1Candidate();
const _scratchBC1B = makeBC1Candidate();
/** Two more slots so the refine loop can alternate between "best so far" and
 * "trial" without copying a candidate on every improvement. */
const _scratchBC1C = makeBC1Candidate();
const _scratchBC1D = makeBC1Candidate();
const _scratchBC1PairLo = new Float64Array(3);
const _scratchBC1PairHi = new Float64Array(3);
const _scratchBC1FitLo = new Float64Array(3);
const _scratchBC1FitHi = new Float64Array(3);

/**
 * BC1's palette positions, expressed in the over-64 units `refineEndpointsLsq`
 * expects. NOT the same shape as BC7's tables: BC1 orders its palette
 * [c0, c1, (2c0+c1)/3, (c0+2c1)/3], so entry 1 is the FAR endpoint (t=1) and the
 * two interpolated entries sit at t=1/3 and t=2/3 — reading these as a
 * monotonic ramp, the way every BC7 weight table is, would put every texel's
 * least-squares contribution at the wrong position on the line.
 */
const BC1_LSQ_WEIGHTS = Float64Array.from([0, 64, 64 / 3, 128 / 3]);

/**
 * A PCA-seeded, least-squares-refined BC1 candidate — the third and best
 * endpoint heuristic (see THE LINE FIT section header for why the two
 * pick-a-texel heuristics leave quality on the table, with measurements).
 *
 * Returns the winning candidate in one of two alternating scratch slots, or
 * `null` when the block has no principal axis at all (every texel on one
 * colour), where the existing candidates already reconstruct it exactly.
 */
function fitBC1Line(texels) {
  const lo = _scratchBC1FitLo;
  const hi = _scratchBC1FitHi;
  if (!pcaEndpoints(texels, ALL_TEXELS, 16, CHANS_RGB, 3, lo, hi)) return null;
  let best = scoreBC1Colors(texels, lo, hi, _scratchBC1C);
  let spare = _scratchBC1D;
  for (let it = 0; it < LINE_REFINE_ITERATIONS; it++) {
    // `best.idx` is the assignment the solve is conditioned on, and `lo`/`hi`
    // are already in palette order (scoreBC1Colors keeps them there).
    if (!refineEndpointsLsq(texels, ALL_TEXELS, 16, CHANS_RGB, 3, best.idx, BC1_LSQ_WEIGHTS, lo, hi)) break;
    const trial = scoreBC1Colors(texels, lo, hi, spare);
    if (!(trial.total < best.total)) break;
    spare = best;
    best = trial;
  }
  return best;
}
const _scratchBC1PalR = new Float64Array(4);
const _scratchBC1PalG = new Float64Array(4);
const _scratchBC1PalB = new Float64Array(4);

/**
 * Quantize a BC1 candidate endpoint pair (texel indices bi/bj into `texels`),
 * build the palette the GPU will reconstruct, pick every texel's nearest entry,
 * and record the block's total squared RGB error for this pair — the metric
 * used to choose between competing candidates (see this file's "SECOND
 * ENDPOINT CANDIDATE" section header). Writes into `out` (a `makeBC1Candidate`
 * slot) instead of returning a fresh object; returns `out` for convenience.
 */
function scoreBC1Pair(texels, bi, bj, out) {
  const lo = _scratchBC1PairLo;
  const hi = _scratchBC1PairHi;
  for (let c = 0; c < 3; c++) {
    lo[c] = texels[bi * 4 + c];
    hi[c] = texels[bj * 4 + c];
  }
  return scoreBC1Colors(texels, lo, hi, out);
}

/**
 * The body of {@link scoreBC1Pair}, taking endpoint COLOURS rather than texel
 * indices — so a fitted line (PCA, least-squares) whose endpoints are not any
 * texel's actual colour can be scored on exactly the same footing as the two
 * pick-a-texel heuristics. Passing integer channel values reproduces the old
 * behaviour bit-for-bit; `toRgb565` rounds, so fractional input is simply the
 * general case of the same quantization.
 *
 * ⚠️ SWAPS `lo`/`hi` IN PLACE when it swaps c0/c1 for 4-colour mode. The palette
 * is built from the POST-swap order, so the indices this writes are only
 * meaningful against that order — and a least-squares refinement conditioned on
 * those indices must solve for the endpoints in the same order or it optimises
 * the line backwards. Keeping the caller's arrays aligned here is what makes the
 * refine loop in `fitBC1Line` correct rather than subtly mirrored.
 */
function scoreBC1Colors(texels, lo, hi, out) {
  let c0 = toRgb565(lo[0], lo[1], lo[2]);
  let c1 = toRgb565(hi[0], hi[1], hi[2]);
  // 4-colour (fully opaque) mode requires c0 > c1. If they collapsed to equal
  // (a solid block) we fall through to 3-colour mode, which is also opaque as
  // long as we never pick index 3 (the transparent slot) — the nearest search
  // below only ever considers the opaque palette entries, so it never does.
  if (c0 < c1) {
    const t = c0;
    c0 = c1;
    c1 = t;
    // Keep the caller's endpoint arrays in the same order as the palette — see
    // this function's own doc for why a refine loop depends on it.
    for (let c = 0; c < 3; c++) {
      const v = lo[c];
      lo[c] = hi[c];
      hi[c] = v;
    }
  }
  // The 565→888 expand, inlined rather than via fromRgb565, purely to avoid the
  // `{r,g,b}` allocation per candidate — identical arithmetic, see that function.
  const r0 = (c0 >> 11) & 0x1f,
    g0 = (c0 >> 5) & 0x3f,
    b0 = c0 & 0x1f;
  const r1 = (c1 >> 11) & 0x1f,
    g1 = (c1 >> 5) & 0x3f,
    b1 = c1 & 0x1f;
  const e0r = (r0 << 3) | (r0 >> 2),
    e0g = (g0 << 2) | (g0 >> 4),
    e0b = (b0 << 3) | (b0 >> 2);
  const e1r = (r1 << 3) | (r1 >> 2),
    e1g = (g1 << 2) | (g1 >> 4),
    e1b = (b1 << 3) | (b1 >> 2);
  const palR = _scratchBC1PalR,
    palG = _scratchBC1PalG,
    palB = _scratchBC1PalB;
  palR[0] = e0r;
  palG[0] = e0g;
  palB[0] = e0b;
  palR[1] = e1r;
  palG[1] = e1g;
  palB[1] = e1b;
  let usable;
  if (c0 > c1) {
    palR[2] = (2 * e0r + e1r) / 3;
    palG[2] = (2 * e0g + e1g) / 3;
    palB[2] = (2 * e0b + e1b) / 3;
    palR[3] = (e0r + 2 * e1r) / 3;
    palG[3] = (e0g + 2 * e1g) / 3;
    palB[3] = (e0b + 2 * e1b) / 3;
    usable = 4;
  } else {
    // 3-colour mode: index 3 is transparent black — deliberately never searched
    // (usable = 3), which is what keeps transparency from leaking into an
    // opaque BC1 image.
    palR[2] = (e0r + e1r) / 2;
    palG[2] = (e0g + e1g) / 2;
    palB[2] = (e0b + e1b) / 2;
    usable = 3;
  }
  const idx = out.idx;
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const r = texels[i * 4],
      g = texels[i * 4 + 1],
      b = texels[i * 4 + 2];
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < usable; p++) {
      const dr = r - palR[p],
        dg = g - palG[p],
        db = b - palB[p];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    idx[i] = best;
    total += bestD;
  }
  out.c0 = c0;
  out.c1 = c1;
  out.total = total;
  return out;
}

/** Encode one 4×4 block (flat rgba, length 64) into out[off..off+8). */
function encodeBC1Block(texels, out, off) {
  // Endpoints = the two texels FARTHEST apart in RGB space. A bounding box is
  // cheaper, but its corners can be colours present in NEITHER texel (a block of
  // pure red + pure blue has a box corner of magenta) — real quality loss the
  // tests caught. Max-distance lands both endpoints ON the actual colour axis.
  // O(120) pairs/block: fine for a one-time, cached encode; a principal-axis
  // method could speed this up later WITHOUT changing the format.
  let bi = 0,
    bj = 1,
    bd = -1;
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      const dr = texels[i * 4] - texels[j * 4],
        dg = texels[i * 4 + 1] - texels[j * 4 + 1],
        db = texels[i * 4 + 2] - texels[j * 4 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d > bd) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  }

  // THE SECOND CANDIDATE (this file's section header) — score it against the
  // distance pair above and keep whichever reconstructs the block more
  // faithfully. Structurally cannot regress: the distance pair is always one
  // of the two options actually evaluated. Skipped outright when the two
  // heuristics named the same pair (common on flat/two-tone map art), which
  // `isSamePair`'s own doc proves is bit-identical, not an approximation.
  let winner = scoreBC1Pair(texels, bi, bj, _scratchBC1A);
  const lumaPair = lumaExtremalPair(texels);
  if (lumaPair !== null && !isSamePair(lumaPair[0], lumaPair[1], bi, bj)) {
    const candidate = scoreBC1Pair(texels, lumaPair[0], lumaPair[1], _scratchBC1B);
    if (candidate.total < winner.total) winner = candidate;
  }
  // THE FITTED LINE (THE LINE FIT section header) — a principal axis plus
  // least-squares refinement, endpoints that need not be any texel's own colour.
  // Skipped when the block is already exact: nothing can beat zero error, and
  // flat blocks are most of a floor painting.
  if (winner.total > 0) {
    const fitted = fitBC1Line(texels);
    if (fitted !== null && fitted.total < winner.total) winner = fitted;
  }
  const { c0, c1, idx } = winner;

  // Little-endian: c0 then c1 as uint16.
  out[off] = c0 & 0xff;
  out[off + 1] = (c0 >> 8) & 0xff;
  out[off + 2] = c1 & 0xff;
  out[off + 3] = (c1 >> 8) & 0xff;
  // 16 × 2-bit indices, texel 0 in the low bits of byte 4.
  let idxBits = 0;
  for (let i = 0; i < 16; i++) idxBits |= idx[i] << (i * 2);
  out[off + 4] = idxBits & 0xff;
  out[off + 5] = (idxBits >> 8) & 0xff;
  out[off + 6] = (idxBits >> 16) & 0xff;
  out[off + 7] = (idxBits >> 24) & 0xff;
}

/**
 * Decode BC1 blocks back to RGBA8 — FOR TESTS AND VALIDATION ONLY. This is the
 * reference the GPU's fixed-function decoder matches, so a round-trip through
 * encodeBC1→decodeBC1 that lands close to the input proves the block layout and
 * palette math are correct without needing a GPU in the test runner.
 * @returns {Uint8Array} width*height*4
 */
export function decodeBC1(blocks, width, height) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(width * height * 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * 8;
      const c0 = blocks[off] | (blocks[off + 1] << 8);
      const c1 = blocks[off + 2] | (blocks[off + 3] << 8);
      const e0 = fromRgb565(c0);
      const e1 = fromRgb565(c1);
      const pal =
        c0 > c1
          ? [
              e0,
              e1,
              { r: (2 * e0.r + e1.r) / 3, g: (2 * e0.g + e1.g) / 3, b: (2 * e0.b + e1.b) / 3 },
              { r: (e0.r + 2 * e1.r) / 3, g: (e0.g + 2 * e1.g) / 3, b: (e0.b + 2 * e1.b) / 3 },
            ]
          : [e0, e1, { r: (e0.r + e1.r) / 2, g: (e0.g + e1.g) / 2, b: (e0.b + e1.b) / 2 }, { r: 0, g: 0, b: 0, a: 0 }];
      const idxBits = blocks[off + 4] | (blocks[off + 5] << 8) | (blocks[off + 6] << 16) | (blocks[off + 7] << 24);
      for (let ty = 0; ty < 4; ty++) {
        const y = by * 4 + ty;
        if (y >= height) continue;
        for (let tx = 0; tx < 4; tx++) {
          const x = bx * 4 + tx;
          if (x >= width) continue;
          const i = ty * 4 + tx;
          const p = pal[(idxBits >>> (i * 2)) & 0x3];
          const di = (y * width + x) * 4;
          out[di] = Math.round(p.r) & 0xff;
          out[di + 1] = Math.round(p.g) & 0xff;
          out[di + 2] = Math.round(p.b) & 0xff;
          out[di + 3] = p.a === 0 ? 0 : 255;
        }
      }
    }
  }
  return out;
}

/** BYTES a BC1 encoding of width×height occupies (blocks × 8). Callers size the
 * IndexedDB cache and the GPU upload from this without running the encoder. */
export function bc1ByteLength(width, height) {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
}

// ===========================================================================
// BC7 (mode 6) — the ALPHA-carrying compressor. BC1 has no alpha, so the
// multifloor overhead/roof overlays (which see the floor below through their
// alpha holes) stayed raw at 549 MB each and still lost the device on a floor
// switch. BC7 fixes that: 16 bytes/block (1 byte/px, 4× smaller than raw) WITH
// full alpha. Opaque content keeps using BC1 (8×, half of BC7's size); BC7 is
// specifically for the alpha layers.
//
// Mode 6 shipped FIRST, alone, deliberately — the simplest BC7 block (1 subset,
// 2 endpoints, no partitions or rotation) and so the one whose bitstream was
// easiest to get provably correct. It gives full 8-bit RGBA endpoints (7
// explicit bits + 1 shared p-bit) and 4-bit indices, and it can represent ANY
// content, so it was a complete encoder on its own.
//
// ⚠️ "CAN REPRESENT ANY CONTENT" IS NOT "REPRESENTS IT WELL" — mode 6 puts all
// FOUR channels on ONE line with ONE index per texel. A texel's colour and its
// alpha are therefore not independently addressable: moving along the line to
// get the right alpha necessarily moves the colour too. Measured cost of that
// coupling, mode 6 alone, no mips and no sharpening involved (fixtures now
// pinned in the tests):
//
//   soft antialiased cutout edge   mean err 2.89   MAX 119
//   thin linework + partial alpha  mean err 2.36   MAX 127
//
// Both are blocks where colour AND alpha vary together — an antialiased
// silhouette is exactly that, and it is most of the perimeter of every cutout
// prop in the author's art. A max of ~120/255 is a texel landing on completely
// the wrong colour; on screen that is speckle, and the albedo-clarity sharpen
// (vt-pan-viewer.js) amplifies it into the grain reported at zoom-out.
//
// THE MODES NOW IMPLEMENTED, and what each one is FOR:
//
//   MODE 6  1 subset, RGBA on one line, 4-bit indices, 8-bit endpoints.
//           Still the best choice for a block whose colour and alpha move
//           TOGETHER (a flat region, a clean two-tone edge) — 16 index levels
//           is the finest quantization any mode here offers.
//
//   MODE 5  1 subset, but colour and alpha get SEPARATE index sets (2 bits
//           each) and separate endpoints — 7-bit RGB, 8-bit alpha. This is the
//           direct answer to the coupling above: an antialiased edge can hold
//           its ink colour steady while alpha ramps independently. Costs index
//           precision (4 levels, not 16) to buy that independence, which is
//           why it is scored against mode 6 rather than replacing it.
//
//   MODE 7  2 subsets with a partition, RGBA, 5-bit endpoints + p-bit, 2-bit
//           indices. The answer to a block holding a genuine THIRD cluster —
//           ink black, coloured interior, transparent hole — which no
//           single-line mode can represent at all (the defect the SECOND
//           ENDPOINT CANDIDATE section above could only mitigate, never fix:
//           it chose a better single line, but one line was always the wrong
//           shape for three clusters).
//
// Every block scores all applicable modes by ACTUAL total reconstruction error
// and emits the winner. Mode 6 is always among them, so this structurally
// cannot regress any block the previous single-mode encoder handled well —
// the same discipline the second endpoint candidate established. The GPU
// decodes whatever mode each 16-byte block declares, so a block's mode is a
// pure encoder-side quality decision and needs no format or upload change.
//
// ── BIT LAYOUTS (all LSB-first; the mode marker is unary — mode m is m zero
//    bits followed by a 1, so the decoder counts leading zeros) ──────────────
//
// MODE 6 = 128 bits:
//   bits 0..6    mode marker: six 0s then a 1 (value 0b1000000)
//   bits 7..62   R0 R1 G0 G1 B0 B1 A0 A1, 7 bits each
//   bit  63      P0   endpoint-0 shared p-bit (LSB below all four channels)
//   bit  64      P1   endpoint-1 shared p-bit
//   bits 65..127 indices: texel 0 = 3 bits (anchor, MSB implied 0), texels
//                1..15 = 4 bits each, raster order. 3 + 15·4 = 63.
//   Reconstructed endpoint channel = (sevenBits << 1) | pbit   (8-bit)
//
// MODE 5 = 128 bits:
//   bits 0..5    mode marker: five 0s then a 1 (value 0b100000)
//   bits 6..7    rotation (2 bits) — we always emit 0, see BC7_MODE5_ROTATION
//   bits 8..49   R0 R1 G0 G1 B0 B1, 7 bits each (42 bits)
//   bits 50..65  A0 A1, 8 bits each (16 bits)
//   bits 66..96  COLOUR indices: texel 0 = 1 bit (anchor), 1..15 = 2 bits (31)
//   bits 97..127 ALPHA  indices: texel 0 = 1 bit (anchor), 1..15 = 2 bits (31)
//   Reconstructed RGB channel = (sevenBits << 1) | (sevenBits >> 6)  (8-bit)
//   Reconstructed alpha       = the stored 8 bits, verbatim (no expansion)
//   Total: 6 + 2 + 42 + 16 + 31 + 31 = 128 ✓
// ===========================================================================

/** BC7 4-bit index interpolation weights (over 64). Symmetric: W[15−i] = 64−W[i],
 * which is why inverting an index is identical to swapping the two endpoints —
 * the trick the anchor fix below relies on. */
const BC7_WEIGHTS4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

/** BC7 2-bit index interpolation weights (over 64) — modes 5 and 7. Symmetric
 * on the same identity as BC7_WEIGHTS4: W[3−i] = 64−W[i], so inverting an index
 * equals swapping the endpoints, which is what both modes' anchor rules use. */
const BC7_WEIGHTS2 = [0, 21, 43, 64];

/**
 * Mode 5's 2-bit ROTATION field, which swaps alpha with one of R/G/B before
 * encoding so the "odd one out" channel can ride the scalar track.
 *
 * ALWAYS 0 (no swap), deliberately. The whole reason mode 5 earns its place
 * here is that ALPHA is the channel moving independently of the other three in
 * this art — an antialiased silhouette ramps coverage while its ink colour
 * holds steady. That is precisely what rotation 0 already expresses. Searching
 * the other three rotations would quadruple mode 5's cost to buy a win only on
 * blocks where R, G or B is the independent channel instead, which is not a
 * shape hand-painted map art produces. Stated rather than silently assumed, per
 * memory:feedback_count_silent_preconditions — if a future asset class does
 * want it, this is the constant to search over.
 */
const BC7_MODE5_ROTATION = 0;

/** Least-squares refinement rounds per seed. Two is where the measured gain
 * flattens (the third round moved total block error by <0.5% on every bench
 * fixture); more would cost encode time for nothing. */
const LINE_REFINE_ITERATIONS = 2;

/** Quantize a channel to `qbits` and expand it back EXACTLY as the GPU will, so
 * the index search always scores the real reconstruction rather than the
 * unquantized ideal. qbits 8 is the identity; 7 replicates the high bit. */
function quantExpandChannel(v, qbits) {
  const r = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  if (qbits >= 8) return r;
  const max = (1 << qbits) - 1;
  const q = Math.round((r * max) / 255);
  return (q << (8 - qbits)) | (q >> (2 * qbits - 8));
}

/** The RAW quantized value `quantExpandChannel` expanded — what gets written to
 * the bitstream. Kept as its own function so the two can never drift apart. */
function quantRawChannel(v, qbits) {
  const r = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  if (qbits >= 8) return r;
  const max = (1 << qbits) - 1;
  return Math.round((r * max) / 255);
}

/** BC7's 6-bit (mode 7, 5 explicit + p) to 8-bit expand: replicate high bits. */
function expandBits(v, bits) {
  if (bits >= 8) return v & 0xff;
  return ((v << (8 - bits)) | (v >> (2 * bits - 8))) & 0xff;
}

/**
 * Quantize ONE endpoint of `nc` channels to `qbits` explicit bits plus, when
 * `usePbit`, a single p-bit SHARED by every channel of that endpoint.
 *
 * The shared p-bit is why this cannot be done channel-by-channel: one bit has to
 * serve all four, so both values are costed across the whole endpoint and the
 * cheaper total wins (ties keep p=0, matching `quantizeBC7Endpoint`'s original
 * "first candidate seen" rule so mode 6's bytes are unaffected by this
 * generalisation). Writes raw quantized values into `raw` and the 8-bit
 * reconstruction the GPU will interpolate into `rec`; returns the chosen p-bit.
 */
function quantizeEndpointInto(src, nc, qbits, usePbit, raw, rec) {
  if (!usePbit) {
    for (let c = 0; c < nc; c++) {
      raw[c] = quantRawChannel(src[c], qbits);
      rec[c] = quantExpandChannel(src[c], qbits);
    }
    return 0;
  }
  const total = qbits + 1;
  const maxQ = (1 << qbits) - 1;
  const levels = (1 << total) - 1;
  // ⚠️ ROUNDS EXACTLY ONCE. The reconstructed value is `expand((q<<1)|p)`, so q
  // solves `2q + p ≈ v·levels/255` — ONE division, ONE round. Writing this as
  // `round(round(v·levels/255) − p)/2` and rounding again turns the pair into an
  // effective ceiling and biases every endpoint one direction, which is the
  // exact defect `toRgb565`'s own doc records costing +4.08/255 mean brightening
  // across the whole BC1 path. Nothing downstream can cancel a one-directional
  // endpoint bias, so it must not be reintroduced here.
  const solveQ = (v, p) => {
    const q = Math.round(((v * levels) / 255 - p) / 2);
    return q < 0 ? 0 : q > maxQ ? maxQ : q;
  };
  let bestP = 0;
  let bestErr = Infinity;
  for (let p = 0; p <= 1; p++) {
    let err = 0;
    for (let c = 0; c < nc; c++) {
      const v = src[c] < 0 ? 0 : src[c] > 255 ? 255 : src[c];
      const d = v - expandBits((solveQ(v, p) << 1) | p, total);
      err += d * d;
    }
    // Strictly less, so p=0 keeps a tie — the same rule `quantizeBC7Endpoint`
    // already used, which is what leaves mode 6's bytes untouched by this
    // generalisation.
    if (err < bestErr) {
      bestErr = err;
      bestP = p;
    }
  }
  for (let c = 0; c < nc; c++) {
    const v = src[c] < 0 ? 0 : src[c] > 255 ? 255 : src[c];
    const q = solveQ(v, bestP);
    raw[c] = q;
    rec[c] = expandBits((q << 1) | bestP, total);
  }
  return bestP;
}

/** Palette scratch for the generic line fitter: nLevels (≤16) × 4 channels. */
const _scratchLinePal = new Int32Array(16 * 4);

/**
 * Assign every member texel its nearest index on the line `rec0`→`rec1` and
 * return the block's total squared error over the selected channels. Indices are
 * written into `outIdx` addressed by TEXEL id (not by member position), because
 * the bitstream is raster-ordered while a subset's members are not.
 */
function assignLineIndices(texels, members, count, chans, nc, rec0, rec1, weights, nLevels, outIdx) {
  const pal = _scratchLinePal;
  for (let k = 0; k < nLevels; k++) {
    const w = weights[k];
    const iw = 64 - w;
    for (let c = 0; c < nc; c++) pal[k * 4 + c] = (rec0[c] * iw + rec1[c] * w + 32) >> 6;
  }
  let total = 0;
  for (let m = 0; m < count; m++) {
    const t = members[m];
    const base = t * 4;
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < nLevels; k++) {
      let d = 0;
      for (let c = 0; c < nc; c++) {
        const diff = texels[base + chans[c]] - pal[k * 4 + c];
        d += diff * diff;
      }
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    outIdx[t] = best;
    total += bestD;
  }
  return total;
}

// Scratch for fitLine: seeds, working endpoints, and the best-so-far.
const _scratchFitLo = new Float64Array(4);
const _scratchFitHi = new Float64Array(4);
const _scratchFitRec0 = new Int32Array(4);
const _scratchFitRec1 = new Int32Array(4);
const _scratchFitBestLo = new Float64Array(4);
const _scratchFitBestHi = new Float64Array(4);
const _scratchFitIdx = new Uint8Array(16);
const _scratchFitSeedLo = new Float64Array(4);
const _scratchFitSeedHi = new Float64Array(4);
const _scratchFitPcaLo = new Float64Array(4);
const _scratchFitPcaHi = new Float64Array(4);
const _scratchFitRaw0 = new Int32Array(4);
const _scratchFitRaw1 = new Int32Array(4);

/**
 * THE LINE FIT, end to end: seed from the principal axis (and from the caller's
 * own extremes), then least-squares refine, scoring every step by real
 * reconstruction error and keeping only strict improvements.
 *
 * Writes the winning endpoints into `outLo`/`outHi` as UNQUANTIZED floats (the
 * caller re-quantizes them for its own mode's bit widths) and the winning
 * per-texel indices into `outIdx`. Returns the total squared error.
 *
 * Seeding from BOTH the principal axis and the plain min/max extremes is not
 * redundancy for its own sake: PCA is the better line for a spread-out block but
 * is genuinely worse for a block that is two tight clusters far apart (its
 * covariance points along the gap, so both endpoints land in empty space
 * between the clusters rather than on them). Scoring both costs one extra index
 * pass and removes the failure mode entirely.
 */
function fitLine(texels, members, count, chans, nc, weights, nLevels, qbits, usePbit, outLo, outHi, outIdx) {
  const lo = _scratchFitLo;
  const hi = _scratchFitHi;
  const rec0 = _scratchFitRec0;
  const rec1 = _scratchFitRec1;
  const bestLo = _scratchFitBestLo;
  const bestHi = _scratchFitBestHi;
  const seedLo = _scratchFitSeedLo;
  const seedHi = _scratchFitSeedHi;
  const workIdx = _scratchFitIdx;
  let bestErr = Infinity;

  const score = () => {
    quantizeEndpointInto(lo, nc, qbits, usePbit, _scratchFitRaw0, rec0);
    quantizeEndpointInto(hi, nc, qbits, usePbit, _scratchFitRaw1, rec1);
    return assignLineIndices(texels, members, count, chans, nc, rec0, rec1, weights, nLevels, workIdx);
  };
  const keepIfBetter = (err) => {
    if (!(err < bestErr)) return false;
    bestErr = err;
    for (let c = 0; c < nc; c++) {
      bestLo[c] = lo[c];
      bestHi[c] = hi[c];
    }
    for (let m = 0; m < count; m++) outIdx[members[m]] = workIdx[members[m]];
    return true;
  };

  // SEED A — per-channel min/max extremes. Cheap, and the right answer for a
  // two-tight-cluster block (see this function's own doc).
  for (let c = 0; c < nc; c++) {
    let mn = 255;
    let mx = 0;
    for (let m = 0; m < count; m++) {
      const v = texels[members[m] * 4 + chans[c]];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    seedLo[c] = mn;
    seedHi[c] = mx;
  }
  // SEED B — the principal axis. May legitimately not exist (a block with no
  // spread), in which case seed A alone carries the fit. Stashed into its own
  // scratch because `lo`/`hi` are the working pair the refine loop overwrites.
  const pcaLo = _scratchFitPcaLo;
  const pcaHi = _scratchFitPcaHi;
  const havePca = pcaEndpoints(texels, members, count, chans, nc, pcaLo, pcaHi);

  for (let seed = 0; seed < 2; seed++) {
    if (seed === 1 && !havePca) break;
    for (let c = 0; c < nc; c++) {
      lo[c] = seed === 0 ? seedLo[c] : pcaLo[c];
      hi[c] = seed === 0 ? seedHi[c] : pcaHi[c];
    }
    keepIfBetter(score());
    // REFINE. `workIdx` currently holds this seed's assignment, which is what
    // the least-squares solve is conditioned on. A round that fails to improve
    // means the fit has settled; iterating further only burns time.
    for (let it = 0; it < LINE_REFINE_ITERATIONS; it++) {
      if (!refineEndpointsLsq(texels, members, count, chans, nc, workIdx, weights, lo, hi)) break;
      if (!keepIfBetter(score())) break;
    }
  }

  for (let c = 0; c < nc; c++) {
    outLo[c] = bestLo[c];
    outHi[c] = bestHi[c];
  }
  return bestErr;
}

/**
 * Quantize an 8-bit RGBA endpoint (four consecutive channels at `texels[base…]`)
 * to mode 6's 7-bits-plus-shared-p-bit form, writing into `out` (a
 * `makeBC7Endpoint` slot) rather than allocating. The single p-bit is shared by
 * all four channels, so we cost p=0 and p=1 and keep whichever reconstructs the
 * four channels with least total error — STRICTLY less, so p=0 wins a tie
 * exactly as the "first candidate seen" rule it replaces did. Fills the
 * per-channel 7-bit values `q`, the chosen `p`, and the 8-bit `rec`onstructed
 * endpoint the GPU (and our index search, and our decoder) will actually use.
 *
 * The negative clamp the older shape carried is GONE, not overlooked: `e[c]` is
 * 0..255 and `p` is 0..1, so the smallest possible `(e[c] − p) / 2` is −0.5, and
 * `Math.round(-0.5)` is `-0` in JS — never below zero. Verified exhaustively
 * over all 512 (channel, p) inputs; it was unreachable code that only made the
 * hot loop look like it could branch.
 */
function makeBC7Endpoint() {
  return { q: new Uint8Array(4), rec: new Uint8Array(4), p: 0, err: 0 };
}
function quantizeBC7Endpoint(texels, base, out) {
  // Cost p=1 first WITHOUT writing anything, so the common p=0 answer is
  // written exactly once instead of being written and then overwritten.
  let err1 = 0;
  for (let c = 0; c < 4; c++) {
    const v = texels[base + c];
    let qc = Math.round((v - 1) / 2);
    if (qc > 127) qc = 127;
    const d = v - ((qc << 1) | 1);
    err1 += d * d;
  }
  let err0 = 0;
  for (let c = 0; c < 4; c++) {
    const v = texels[base + c];
    let qc = Math.round(v / 2);
    if (qc > 127) qc = 127;
    const d = v - (qc << 1);
    err0 += d * d;
  }
  const p = err1 < err0 ? 1 : 0;
  const q = out.q,
    rec = out.rec;
  for (let c = 0; c < 4; c++) {
    let qc = Math.round((texels[base + c] - p) / 2);
    if (qc > 127) qc = 127;
    q[c] = qc;
    rec[c] = (qc << 1) | p;
  }
  out.p = p;
  out.err = p === 1 ? err1 : err0;
  return out;
}

/**
 * One scored BC7 candidate pair — same two-fixed-slots reasoning as
 * `makeBC1Candidate`: the second candidate must not clobber the first while the
 * two totals are being compared.
 */
function makeBC7Candidate() {
  return { q0: makeBC7Endpoint(), q1: makeBC7Endpoint(), idx: new Uint8Array(16), total: 0 };
}
const _scratchBC7A = makeBC7Candidate();
const _scratchBC7B = makeBC7Candidate();
/** The 16 interpolated palette entries, hoisted out of the per-texel search
 * (see scoreBC7Pair). Uint8 is exact: every entry is `(x·(64−w) + y·w + 32) >> 6`
 * over 8-bit endpoints, which cannot leave 0..255. */
const _scratchBC7PalR = new Uint8Array(16);
const _scratchBC7PalG = new Uint8Array(16);
const _scratchBC7PalB = new Uint8Array(16);
const _scratchBC7PalA = new Uint8Array(16);

/**
 * Quantize a BC7 candidate endpoint pair (texel indices bi/bj into `texels`),
 * pick every texel's nearest index against the RECONSTRUCTED endpoints (what
 * the GPU will actually interpolate — so the decode matches bit-for-bit), and
 * record the block's total squared RGBA error for this pair — the metric used
 * to choose between competing candidates (see this file's "SECOND ENDPOINT
 * CANDIDATE" section header). Writes into `out` (a `makeBC7Candidate` slot).
 *
 * THE PALETTE IS BUILT ONCE PER PAIR, not once per texel. It depends only on the
 * two endpoints, so the previous shape recomputed all 16 interpolated colours
 * inside the 16-texel loop — 256 four-channel lerps per pair where 16 suffice,
 * and this inner search is where essentially the whole BC7 encode budget goes.
 * Same arithmetic, same tie-breaking (`<` keeps the lowest index), same bytes.
 */
function scoreBC7Pair(texels, bi, bj, out) {
  const q0 = quantizeBC7Endpoint(texels, bi * 4, out.q0);
  const q1 = quantizeBC7Endpoint(texels, bj * 4, out.q1);
  const palR = _scratchBC7PalR,
    palG = _scratchBC7PalG,
    palB = _scratchBC7PalB,
    palA = _scratchBC7PalA;
  const r0 = q0.rec[0],
    g0 = q0.rec[1],
    b0 = q0.rec[2],
    a0 = q0.rec[3];
  const r1 = q1.rec[0],
    g1 = q1.rec[1],
    b1 = q1.rec[2],
    a1 = q1.rec[3];
  for (let k = 0; k < 16; k++) {
    const w = BC7_WEIGHTS4[k];
    const iw = 64 - w;
    palR[k] = (r0 * iw + r1 * w + 32) >> 6;
    palG[k] = (g0 * iw + g1 * w + 32) >> 6;
    palB[k] = (b0 * iw + b1 * w + 32) >> 6;
    palA[k] = (a0 * iw + a1 * w + 32) >> 6;
  }
  const idx = out.idx;
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const r = texels[i * 4],
      g = texels[i * 4 + 1],
      b = texels[i * 4 + 2],
      a = texels[i * 4 + 3];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < 16; k++) {
      const dr = r - palR[k],
        dg = g - palG[k],
        db = b - palB[k],
        da = a - palA[k];
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    idx[i] = best;
    total += bestD;
  }
  out.total = total;
  return out;
}

/**
 * Score MODE 6 for this block: the single RGBA line, both endpoint-pair
 * heuristics, exactly as the single-mode encoder always did. Returns the winning
 * candidate (its `.total` is the comparable error).
 */
function scoreBC7Mode6(texels) {
  // Endpoints = the two texels farthest apart in 4-D RGBA space (same rationale
  // as BC1: a max-distance pair lands both endpoints on the real colour+alpha
  // axis, unlike a bounding box whose corners can be values present in neither).
  let bi = 0,
    bj = 0,
    bd = -1;
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      const dr = texels[i * 4] - texels[j * 4],
        dg = texels[i * 4 + 1] - texels[j * 4 + 1],
        db = texels[i * 4 + 2] - texels[j * 4 + 2],
        da = texels[i * 4 + 3] - texels[j * 4 + 3];
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d > bd) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  }

  // THE SECOND CANDIDATE (this file's section header) — score it against the
  // distance pair above and keep whichever reconstructs the block more
  // faithfully. Structurally cannot regress: the distance pair is always one
  // of the two options actually evaluated. Skipped outright when the two
  // heuristics named the same pair, which `isSamePair`'s own doc proves is
  // bit-identical, not an approximation.
  let winner = scoreBC7Pair(texels, bi, bj, _scratchBC7A);
  const lumaPair = lumaExtremalPair(texels);
  if (lumaPair !== null && !isSamePair(lumaPair[0], lumaPair[1], bi, bj)) {
    const candidate = scoreBC7Pair(texels, lumaPair[0], lumaPair[1], _scratchBC7B);
    if (candidate.total < winner.total) winner = candidate;
  }
  return winner;
}

/** Emit a scored mode-6 candidate into out[off..off+16). */
function emitBC7Mode6(winner, out, off) {
  const { idx } = winner;
  let { q0, q1 } = winner;

  // Anchor rule: texel 0's index stores only 3 bits, so its MSB must be 0. If it
  // isn't, swap the endpoints and invert every index (W[15−i] = 64−W[i] makes
  // that an exact equivalent) — after which idx[0] ≤ 7.
  if (idx[0] & 8) {
    for (let i = 0; i < 16; i++) idx[i] = 15 - idx[i];
    const t = q0;
    q0 = q1;
    q1 = t;
  }

  const write = makeBitWriter(out, off);
  write(0b1000000, 7); // mode 6 marker
  write(q0.q[0], 7);
  write(q1.q[0], 7);
  write(q0.q[1], 7);
  write(q1.q[1], 7);
  write(q0.q[2], 7);
  write(q1.q[2], 7);
  write(q0.q[3], 7);
  write(q1.q[3], 7);
  write(q0.p, 1);
  write(q1.p, 1);
  write(idx[0], 3); // anchor texel: 3 bits
  for (let i = 1; i < 16; i++) write(idx[i], 4);
}

/** Channel selector for mode 5's independent alpha track. */
const CHANS_A = Uint8Array.from([3]);

/** A scored mode-5 candidate. Endpoints are held UNQUANTIZED (the fitter's own
 * output); `emitBC7Mode5` quantizes them once, with the same bit widths the
 * scorer used, so the emitted block reconstructs exactly what was scored. */
function makeBC7Mode5Candidate() {
  return {
    rgbLo: new Float64Array(3),
    rgbHi: new Float64Array(3),
    aLo: new Float64Array(1),
    aHi: new Float64Array(1),
    cIdx: new Uint8Array(16),
    aIdx: new Uint8Array(16),
    total: 0,
  };
}
const _scratchBC7M5 = makeBC7Mode5Candidate();

/**
 * Score MODE 5: colour and alpha fitted as two COMPLETELY INDEPENDENT lines,
 * each with its own endpoints and its own per-texel index.
 *
 * This is the whole point of the mode and the reason it is here. Mode 6 must
 * spend one index per texel to satisfy colour and alpha at once, so an
 * antialiased silhouette — ink colour holding steady while coverage ramps —
 * forces a compromise on both. Here the two fits cannot interfere: the colour
 * line sees only RGB, the alpha line only A. The cost is index precision (4
 * levels each instead of mode 6's 16), which is exactly why the two modes are
 * scored against each other per block rather than one replacing the other.
 */
function scoreBC7Mode5(texels, out) {
  const cErr = fitLine(texels, ALL_TEXELS, 16, CHANS_RGB, 3, BC7_WEIGHTS2, 4, 7, false, out.rgbLo, out.rgbHi, out.cIdx);
  const aErr = fitLine(texels, ALL_TEXELS, 16, CHANS_A, 1, BC7_WEIGHTS2, 4, 8, false, out.aLo, out.aHi, out.aIdx);
  out.total = cErr + aErr;
  return out;
}

const _scratchM5QLo = new Int32Array(3);
const _scratchM5QHi = new Int32Array(3);

/** Emit a scored mode-5 candidate into out[off..off+16). */
function emitBC7Mode5(cand, out, off) {
  const qr = _scratchM5QLo;
  const qh = _scratchM5QHi;
  for (let c = 0; c < 3; c++) {
    qr[c] = quantRawChannel(cand.rgbLo[c], 7);
    qh[c] = quantRawChannel(cand.rgbHi[c], 7);
  }
  let a0 = quantRawChannel(cand.aLo[0], 8);
  let a1 = quantRawChannel(cand.aHi[0], 8);
  const cIdx = cand.cIdx;
  const aIdx = cand.aIdx;

  // Anchor rule, applied INDEPENDENTLY to each index array — mode 5 has two, and
  // they are separate bitfields with separate anchors. With 2-bit indices the
  // anchor texel stores 1 bit, so its MSB must be 0 (index ≤ 1). Inverting an
  // index (i → 3−i) alongside swapping that track's endpoints is exact, on the
  // same W[3−i] = 64−W[i] symmetry mode 6's anchor swap uses.
  if (cIdx[0] & 2) {
    for (let i = 0; i < 16; i++) cIdx[i] = 3 - cIdx[i];
    for (let c = 0; c < 3; c++) {
      const t = qr[c];
      qr[c] = qh[c];
      qh[c] = t;
    }
  }
  if (aIdx[0] & 2) {
    for (let i = 0; i < 16; i++) aIdx[i] = 3 - aIdx[i];
    const t = a0;
    a0 = a1;
    a1 = t;
  }

  const write = makeBitWriter(out, off);
  write(0b100000, 6); // mode 5 marker: five 0s then a 1
  write(BC7_MODE5_ROTATION, 2);
  write(qr[0], 7);
  write(qh[0], 7);
  write(qr[1], 7);
  write(qh[1], 7);
  write(qr[2], 7);
  write(qh[2], 7);
  write(a0, 8);
  write(a1, 8);
  write(cIdx[0], 1); // colour anchor: 1 bit
  for (let i = 1; i < 16; i++) write(cIdx[i], 2);
  write(aIdx[0], 1); // alpha anchor: 1 bit
  for (let i = 1; i < 16; i++) write(aIdx[i], 2);
}

// ===========================================================================
// MODE 7 — TWO SUBSETS. The only mode here that can hold a block containing a
// genuine THIRD colour cluster.
//
// THE SHAPE OF THE PROBLEM, which no single-line mode can fix: a cutout prop's
// silhouette crossing a 4×4 block routinely contains ink black, the coloured
// interior, AND the transparent hole. That is three clusters. Modes 5 and 6 fit
// ONE line, so whichever cluster is not near the line gets index-snapped onto
// it. The SECOND ENDPOINT CANDIDATE section above could only ever mitigate this
// — it picked a better single line, but one line is the wrong SHAPE for three
// clusters, and no choice of endpoints changes that.
//
// Mode 7 splits the block's 16 texels into two subsets by a partition pattern
// and fits each subset its OWN RGBA line. Ink+hole in one subset, interior in
// the other, and all three clusters get represented. The cost is precision:
// 5-bit endpoints (+1 p-bit) and 2-bit indices, against mode 6's 8-bit and
// 4-bit. So it is scored against the others per block, never assumed better.
//
// MODE 7 = 128 bits, LSB-first:
//   bits 0..7     mode marker: seven 0s then a 1 (value 0b10000000)
//   bits 8..13    partition index (6 bits, 0..63)
//   bits 14..93   R0 R1 R2 R3, G0 G1 G2 G3, B0.., A0.. — 5 bits each (80 bits);
//                 endpoints 0/1 belong to subset 0, endpoints 2/3 to subset 1
//   bits 94..97   P0 P1 P2 P3 — one p-bit PER ENDPOINT (not per subset)
//   bits 98..127  indices, 2 bits each, raster order, EXCEPT the two anchors
//                 (30 bits)
//   Reconstructed channel = expand6to8((fiveBits << 1) | pbit)
//   Total: 8 + 6 + 80 + 4 + 30 = 128 ✓
//
// ⚠️ TWO ANCHORS, NOT ONE. Every BC7 index array stores its anchor texel with
// the MSB implied 0, saving one bit. Mode 6 has a single subset so its anchor is
// always texel 0. A two-subset block has an anchor PER SUBSET: texel 0 for
// subset 0, and BC7_ANCHOR2[partition] for subset 1. Both write 1 bit instead of
// 2, which is exactly what makes the index field 30 bits rather than 32 — get
// this wrong and every subsequent bit is shifted, so the block decodes as noise
// rather than as a slightly-wrong colour.
//
// ⚠️ THE TABLES BELOW ARE FIXED BY THE SPEC AND WERE NOT DERIVED HERE. A
// mistranscribed entry is the worst failure mode in this file: our own decoder
// would use the same wrong table and round-trip perfectly, while a real GPU —
// using the real table — renders garbage (memory:
// feedback_smooth_output_hides_ported_bugs). So they were cross-checked
// mechanically against SEVEN independent lineages in four different storage
// encodings — the Khronos ARB BPTC spec, Khronos Data Format Spec 1.3,
// Microsoft DirectXTex, bcdec.h, Mesa (packed uint32, 2 bits/texel), bc7enc,
// and AMD Compressonator — agreeing entry-for-entry on all 1088 values, with
// the structural invariants re-checked after emission. The tests re-assert
// those invariants plus both checksums, so a future edit cannot quietly corrupt
// a table.
//
// (Noted because it cost time to run down: the Data Format Spec's bold-italic
// ANCHOR MARKERS in its partition table are wrong for partitions 23 and 35 —
// still wrong in 1.3. Its numeric tables are correct, and every other source
// agrees. Do not "fix" the anchors below against that document's formatting.)
// ===========================================================================

/** The BC7 two-subset partition table: 64 patterns × 16 texels, partition-major,
 * raster order (texel t is at x = t & 3, y = t >> 2). Value = subset id. */
// prettier-ignore
const BC7_PARTITION2 = new Uint8Array([
  0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,
  0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,
  0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,
  0,0,0,1,0,0,1,1,0,0,1,1,0,1,1,1,
  0,0,0,0,0,0,0,1,0,0,0,1,0,0,1,1,
  0,0,1,1,0,1,1,1,0,1,1,1,1,1,1,1,
  0,0,0,1,0,0,1,1,0,1,1,1,1,1,1,1,
  0,0,0,0,0,0,0,1,0,0,1,1,0,1,1,1,
  0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,
  0,0,1,1,0,1,1,1,1,1,1,1,1,1,1,1,
  0,0,0,0,0,0,0,1,0,1,1,1,1,1,1,1,
  0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,1,
  0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1,
  0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,
  0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,
  0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,
  0,0,0,0,1,0,0,0,1,1,1,0,1,1,1,1,
  0,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,1,0,0,0,1,1,1,0,
  0,1,1,1,0,0,1,1,0,0,0,1,0,0,0,0,
  0,0,1,1,0,0,0,1,0,0,0,0,0,0,0,0,
  0,0,0,0,1,0,0,0,1,1,0,0,1,1,1,0,
  0,0,0,0,0,0,0,0,1,0,0,0,1,1,0,0,
  0,1,1,1,0,0,1,1,0,0,1,1,0,0,0,1,
  0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,0,
  0,0,0,0,1,0,0,0,1,0,0,0,1,1,0,0,
  0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,
  0,0,1,1,0,1,1,0,0,1,1,0,1,1,0,0,
  0,0,0,1,0,1,1,1,1,1,1,0,1,0,0,0,
  0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0,
  0,1,1,1,0,0,0,1,1,0,0,0,1,1,1,0,
  0,0,1,1,1,0,0,1,1,0,0,1,1,1,0,0,
  0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
  0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,
  0,1,0,1,1,0,1,0,0,1,0,1,1,0,1,0,
  0,0,1,1,0,0,1,1,1,1,0,0,1,1,0,0,
  0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,
  0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0,
  0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1,
  0,1,0,1,1,0,1,0,1,0,1,0,0,1,0,1,
  0,1,1,1,0,0,1,1,1,1,0,0,1,1,1,0,
  0,0,0,1,0,0,1,1,1,1,0,0,1,0,0,0,
  0,0,1,1,0,0,1,0,0,1,0,0,1,1,0,0,
  0,0,1,1,1,0,1,1,1,1,0,1,1,1,0,0,
  0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,
  0,0,1,1,1,1,0,0,1,1,0,0,0,0,1,1,
  0,1,1,0,0,1,1,0,1,0,0,1,1,0,0,1,
  0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0,
  0,1,0,0,1,1,1,0,0,1,0,0,0,0,0,0,
  0,0,1,0,0,1,1,1,0,0,1,0,0,0,0,0,
  0,0,0,0,0,0,1,0,0,1,1,1,0,0,1,0,
  0,0,0,0,0,1,0,0,1,1,1,0,0,1,0,0,
  0,1,1,0,1,1,0,0,1,0,0,1,0,0,1,1,
  0,0,1,1,0,1,1,0,1,1,0,0,1,0,0,1,
  0,1,1,0,0,0,1,1,1,0,0,1,1,1,0,0,
  0,0,1,1,1,0,0,1,1,1,0,0,0,1,1,0,
  0,1,1,0,1,1,0,0,1,1,0,0,1,0,0,1,
  0,1,1,0,0,0,1,1,0,0,1,1,1,0,0,1,
  0,1,1,1,1,1,1,0,1,0,0,0,0,0,0,1,
  0,0,0,1,1,0,0,0,1,1,1,0,0,1,1,1,
  0,0,0,0,1,1,1,1,0,0,1,1,0,0,1,1,
  0,0,1,1,0,0,1,1,1,1,1,1,0,0,0,0,
  0,0,1,0,0,0,1,0,1,1,1,0,1,1,1,0,
  0,1,0,0,0,1,0,0,0,1,1,1,0,1,1,1,
]);

/** Which texel anchors SUBSET 1, per partition. Not derivable — it is the last
 * texel of subset 1 in only 32 of 64 partitions and the first in only 14, so the
 * table is mandatory rather than a cached computation. */
// prettier-ignore
const BC7_ANCHOR2 = new Uint8Array([
  15, 15, 15, 15, 15, 15, 15, 15,
  15, 15, 15, 15, 15, 15, 15, 15,
  15,  2,  8,  2,  2,  8,  8, 15,
   2,  8,  2,  2,  8,  8,  2,  2,
  15, 15,  6,  8,  2,  8, 15, 15,
   2,  8,  2,  2,  2, 15, 15,  6,
   6,  2,  6,  8, 15, 15,  2,  2,
  15, 15, 15, 15, 15,  2,  2, 15,
]);

/** How many partitions survive the cheap shortlist to be fully fitted. Fitting
 * all 64 is ~8× the cost of every other mode combined and measurably not worth
 * it; the cheap score is a good enough ranker that the true best partition is
 * almost always inside the top few. Raising this trades encode time for a
 * quality gain that the bench fixtures show flattening immediately. */
const BC7_PARTITION_SHORTLIST = 4;

/**
 * Total squared error, across the block's 64 channel-samples, below which mode 7
 * is not even attempted (see the gate's own comment in `encodeBC7Block`).
 *
 * 64 = an average of one 8-bit LSB per channel per texel. A block already that
 * close has no visible headroom left — the sharpen downstream cannot amplify an
 * error of ±1 into anything — while mode 7's fit is roughly the cost of every
 * other mode combined.
 *
 * MEASURED on a 1024² alpha fixture: without this gate 1134 ms, with it 253 ms
 * — 4.5× — and the bench fixtures come back BIT-FOR-BIT identical, same error
 * figures and the same 36 blocks still choosing mode 7. So this is not a
 * quality/speed trade at this setting; it is dropping work that was provably
 * changing nothing. Raise it and real three-cluster blocks WOULD start being
 * missed — the soft-cutout and ink-ring bars in the tests are what would catch
 * that, which is why they sit at measured values rather than round numbers.
 */
const BC7_MODE7_ERROR_GATE = 64;

const _scratchPartMembers0 = new Uint8Array(16);
const _scratchPartMembers1 = new Uint8Array(16);
const _scratchPartScores = new Float64Array(64);
const _scratchPartOrder = new Int32Array(64);
const _scratchPartSum = new Float64Array(8);
const _scratchPartSumSq = new Float64Array(8);

/**
 * Rank all 64 partitions cheaply, by how tightly each subset's texels cluster
 * around their own mean (total within-subset variance). A partition that cuts
 * ALONG the block's real colour boundary leaves two tight clusters and scores
 * low; one that cuts across it leaves two smeared clusters and scores high.
 *
 * This is a RANKER, not a decision — the shortlist it produces is then fully
 * fitted and scored on real reconstruction error. It only has to get the true
 * best partition into the top `BC7_PARTITION_SHORTLIST`, not identify it.
 *
 * One pass using `Σx² − (Σx)²/n`, so 16 texels × 4 channels per partition rather
 * than a mean pass plus a deviation pass.
 */
function rankBC7Partitions(texels, outOrder) {
  const sum = _scratchPartSum;
  const sumSq = _scratchPartSumSq;
  for (let p = 0; p < 64; p++) {
    for (let i = 0; i < 8; i++) {
      sum[i] = 0;
      sumSq[i] = 0;
    }
    let n1 = 0;
    const base = p * 16;
    for (let t = 0; t < 16; t++) {
      const s = BC7_PARTITION2[base + t];
      n1 += s;
      const o = s * 4;
      for (let c = 0; c < 4; c++) {
        const v = texels[t * 4 + c];
        sum[o + c] += v;
        sumSq[o + c] += v * v;
      }
    }
    const n0 = 16 - n1;
    let score = 0;
    for (let c = 0; c < 4; c++) {
      if (n0 > 0) score += sumSq[c] - (sum[c] * sum[c]) / n0;
      if (n1 > 0) score += sumSq[4 + c] - (sum[4 + c] * sum[4 + c]) / n1;
    }
    _scratchPartScores[p] = score;
    outOrder[p] = p;
  }
  // Partial selection sort — we only need the best few, not a full ordering.
  for (let k = 0; k < BC7_PARTITION_SHORTLIST; k++) {
    let best = k;
    for (let j = k + 1; j < 64; j++) {
      if (_scratchPartScores[outOrder[j]] < _scratchPartScores[outOrder[best]]) best = j;
    }
    const t = outOrder[k];
    outOrder[k] = outOrder[best];
    outOrder[best] = t;
  }
}

/** A scored mode-7 candidate. Endpoints stay unquantized for the same reason as
 * mode 5's: the emitter re-quantizes with the identical bit widths the scorer
 * used, so what ships is exactly what was measured. */
function makeBC7Mode7Candidate() {
  return {
    partition: 0,
    lo: [new Float64Array(4), new Float64Array(4)],
    hi: [new Float64Array(4), new Float64Array(4)],
    idx: new Uint8Array(16),
    total: 0,
  };
}
const _scratchBC7M7 = makeBC7Mode7Candidate();
const _scratchBC7M7Try = makeBC7Mode7Candidate();

/** Fit ONE partition: split the texels, fit each subset its own RGBA line, and
 * return the block's total error. */
function scoreBC7Mode7Partition(texels, partition, out) {
  const m0 = _scratchPartMembers0;
  const m1 = _scratchPartMembers1;
  let n0 = 0;
  let n1 = 0;
  const base = partition * 16;
  for (let t = 0; t < 16; t++) {
    if (BC7_PARTITION2[base + t] === 0) m0[n0++] = t;
    else m1[n1++] = t;
  }
  // The spec guarantees both subsets are non-empty for every partition, and the
  // tests assert it — but a fit over zero texels would silently produce garbage
  // endpoints rather than throw, so this stays as a real guard.
  if (n0 === 0 || n1 === 0) return Infinity;
  const e0 = fitLine(texels, m0, n0, CHANS_RGBA, 4, BC7_WEIGHTS2, 4, 5, true, out.lo[0], out.hi[0], out.idx);
  const e1 = fitLine(texels, m1, n1, CHANS_RGBA, 4, BC7_WEIGHTS2, 4, 5, true, out.lo[1], out.hi[1], out.idx);
  out.partition = partition;
  out.total = e0 + e1;
  return out.total;
}

/** Score MODE 7 across the shortlisted partitions, keeping the best. Two slots
 * alternate so a losing trial never overwrites the winner and no candidate ever
 * has to be copied. */
function scoreBC7Mode7(texels) {
  rankBC7Partitions(texels, _scratchPartOrder);
  let best = null;
  let trial = _scratchBC7M7;
  let other = _scratchBC7M7Try;
  for (let k = 0; k < BC7_PARTITION_SHORTLIST; k++) {
    const err = scoreBC7Mode7Partition(texels, _scratchPartOrder[k], trial);
    if (best === null || err < best.total) {
      best = trial;
      trial = other;
      other = best;
    }
  }
  return best;
}

const _scratchM7Raw = [new Int32Array(4), new Int32Array(4), new Int32Array(4), new Int32Array(4)];
const _scratchM7Rec = [new Int32Array(4), new Int32Array(4), new Int32Array(4), new Int32Array(4)];
const _scratchM7P = new Int32Array(4);

/** Emit a scored mode-7 candidate into out[off..off+16). */
function emitBC7Mode7(cand, out, off) {
  const partition = cand.partition;
  const anchor1 = BC7_ANCHOR2[partition];
  const idx = cand.idx;
  const base = partition * 16;

  for (let s = 0; s < 2; s++) {
    _scratchM7P[s * 2] = quantizeEndpointInto(cand.lo[s], 4, 5, true, _scratchM7Raw[s * 2], _scratchM7Rec[s * 2]);
    _scratchM7P[s * 2 + 1] = quantizeEndpointInto(
      cand.hi[s],
      4,
      5,
      true,
      _scratchM7Raw[s * 2 + 1],
      _scratchM7Rec[s * 2 + 1]
    );
  }

  // Anchor rule, PER SUBSET (see this section's header). Subset 0 anchors on
  // texel 0, subset 1 on BC7_ANCHOR2[partition]; each must have its MSB clear,
  // and the fix is to invert that subset's indices and swap that subset's
  // endpoints — exact on the W[3−i] = 64−W[i] symmetry.
  for (let s = 0; s < 2; s++) {
    const anchorTexel = s === 0 ? 0 : anchor1;
    if ((idx[anchorTexel] & 2) === 0) continue;
    for (let t = 0; t < 16; t++) if (BC7_PARTITION2[base + t] === s) idx[t] = 3 - idx[t];
    const a = s * 2;
    const b = s * 2 + 1;
    const tmpRaw = _scratchM7Raw[a];
    _scratchM7Raw[a] = _scratchM7Raw[b];
    _scratchM7Raw[b] = tmpRaw;
    const tmpP = _scratchM7P[a];
    _scratchM7P[a] = _scratchM7P[b];
    _scratchM7P[b] = tmpP;
  }

  const write = makeBitWriter(out, off);
  write(0b10000000, 8); // mode 7 marker: seven 0s then a 1
  write(partition, 6);
  for (let c = 0; c < 4; c++) for (let e = 0; e < 4; e++) write(_scratchM7Raw[e][c], 5);
  for (let e = 0; e < 4; e++) write(_scratchM7P[e], 1);
  for (let t = 0; t < 16; t++) write(idx[t], t === 0 || t === anchor1 ? 1 : 2);
}

/** A forward-only LSB-first bit writer over `out`, starting at byte `off`.
 * Shared by every mode's emitter so the bit-packing convention can only be
 * defined once. */
function makeBitWriter(out, off) {
  let bit = off * 8;
  return (val, n) => {
    for (let k = 0; k < n; k++) {
      if ((val >> k) & 1) out[bit >> 3] |= 1 << (bit & 7);
      bit++;
    }
  };
}

/**
 * Encode one 4×4 RGBA block (flat, length 64) into out[off..off+16), choosing
 * whichever implemented BC7 mode reconstructs it with least total squared error.
 * See this section's header for what each mode is good at and why the choice is
 * made per block rather than per image.
 */
function encodeBC7Block(texels, out, off) {
  const m6 = scoreBC7Mode6(texels);
  let bestMode = 6;
  let bestErr = m6.total;
  let m7 = null;

  // Mode 6 reconstructing the block EXACTLY leaves nothing for another mode to
  // win — and this is the common case by a wide margin in real map art (flat
  // interiors, solid floor, and the transparent padding that surrounds every
  // cutout prop). Skipping the remaining fits there is what keeps a multi-mode
  // encoder affordable; see the mode-cost note in encodeBC7's own doc.
  if (bestErr > 0) {
    const m5 = scoreBC7Mode5(texels, _scratchBC7M5);
    if (m5.total < bestErr) {
      bestErr = m5.total;
      bestMode = 5;
    }
    // MODE 7 IS GATED ON THE SINGLE-LINE MODES HAVING ACTUALLY FAILED. It is by
    // far the most expensive fit here — ranking 64 partitions, then fitting two
    // subsets across a shortlist of them — and it exists for one specific defect:
    // a block holding three colour clusters. A block that a single line already
    // reconstructs to within a fraction of an LSB per channel does not have that
    // defect, and paying mode 7's cost to confirm so is the difference between a
    // 5-second and a 50-second encode for one floor (measured, 6750²).
    if (bestErr > BC7_MODE7_ERROR_GATE) {
      m7 = scoreBC7Mode7(texels);
      if (m7 !== null && m7.total < bestErr) {
        bestErr = m7.total;
        bestMode = 7;
      }
    }
  }

  if (bestMode === 7) emitBC7Mode7(m7, out, off);
  else if (bestMode === 5) emitBC7Mode5(_scratchBC7M5, out, off);
  else emitBC7Mode6(m6, out, off);
}

/**
 * Encode RGBA8 pixels to BC7 (mode 6) blocks. Same shape as {@link encodeBC1};
 * carries alpha. 16 bytes per 4×4 block.
 * @param {Uint8Array|Uint8ClampedArray} rgba length must be width*height*4
 * @param {number} width @param {number} height
 * @returns {Uint8Array} blocksX*blocksY*16 bytes, row-major
 */
export function encodeBC7(rgba, width, height) {
  if (width <= 0 || height <= 0) throw new Error(`encodeBC7: bad size ${width}x${height}`);
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodeBC7: rgba length ${rgba.length} != width*height*4 (${expected})`);
  }
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(blocksX * blocksY * 16);
  let o = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      gatherBlock(rgba, width, height, bx, by, _scratchTexels);
      encodeBC7Block(_scratchTexels, out, o);
      o += 16;
    }
  }
  return out;
}

/**
 * Decode BC7 blocks to RGBA8 — FOR TESTS AND VALIDATION ONLY, and only for the
 * modes this module emits (a general BC7 decoder is the GPU's job). It matches
 * the GPU's fixed-function decode, so an encodeBC7→decodeBC7 round-trip proves
 * each mode's bit layout without a GPU.
 *
 * ⚠️ A ROUND TRIP THROUGH THIS DECODER IS NOT PROOF ON ITS OWN. It shares its
 * author with the encoder, so a bit layout that is wrong in BOTH agrees with
 * itself perfectly and renders garbage on real hardware — the failure class
 * memory:feedback_smooth_output_hides_ported_bugs names. The layouts here are
 * cross-checked against the spec field order, the tests assert the structural
 * invariants that a transcription slip would break, and the modes are confirmed
 * on a real GPU before shipping.
 * @returns {Uint8Array} width*height*4
 */
export function decodeBC7(blocks, width, height) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(width * height * 4);
  const e0 = new Int32Array(4);
  const e1 = new Int32Array(4);
  const cIdx = new Uint8Array(16);
  const aIdx = new Uint8Array(16);
  // Mode 7's four endpoints, as 4 × RGBA.
  const m7Raw = new Int32Array(16);
  const m7Rec = new Int32Array(16);
  const m7P = new Int32Array(4);
  let partition = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let bit = (by * blocksX + bx) * 16 * 8;
      const read = (n) => {
        let v = 0;
        for (let k = 0; k < n; k++) {
          if ((blocks[bit >> 3] >> (bit & 7)) & 1) v |= 1 << k;
          bit++;
        }
        return v;
      };
      // Mode = number of leading zero bits before the first 1 (unary).
      let mode = 0;
      while (mode < 8 && read(1) === 0) mode++;

      // `weights` is the primary (colour) index table; `aWeights` the alpha one.
      // They differ only in mode 5, the mode whose whole purpose is separating
      // the two — everywhere else alpha rides the primary index.
      let weights;
      let aWeights = null;
      if (mode === 6) {
        const r0 = read(7),
          r1 = read(7),
          g0 = read(7),
          g1 = read(7),
          b0 = read(7),
          b1 = read(7),
          a0 = read(7),
          a1 = read(7);
        const p0 = read(1),
          p1 = read(1);
        e0[0] = (r0 << 1) | p0;
        e0[1] = (g0 << 1) | p0;
        e0[2] = (b0 << 1) | p0;
        e0[3] = (a0 << 1) | p0;
        e1[0] = (r1 << 1) | p1;
        e1[1] = (g1 << 1) | p1;
        e1[2] = (b1 << 1) | p1;
        e1[3] = (a1 << 1) | p1;
        cIdx[0] = read(3);
        for (let i = 1; i < 16; i++) cIdx[i] = read(4);
        weights = BC7_WEIGHTS4;
      } else if (mode === 5) {
        const rot = read(2);
        if (rot !== 0) throw new Error(`decodeBC7: mode 5 rotation ${rot} not supported`);
        const r0 = read(7),
          r1 = read(7),
          g0 = read(7),
          g1 = read(7),
          b0 = read(7),
          b1 = read(7);
        // 7-bit RGB expands by replicating the high bit; 8-bit alpha is verbatim.
        const ex = (v) => (v << 1) | (v >> 6);
        e0[0] = ex(r0);
        e0[1] = ex(g0);
        e0[2] = ex(b0);
        e1[0] = ex(r1);
        e1[1] = ex(g1);
        e1[2] = ex(b1);
        e0[3] = read(8);
        e1[3] = read(8);
        cIdx[0] = read(1);
        for (let i = 1; i < 16; i++) cIdx[i] = read(2);
        aIdx[0] = read(1);
        for (let i = 1; i < 16; i++) aIdx[i] = read(2);
        weights = BC7_WEIGHTS2;
        aWeights = BC7_WEIGHTS2;
      } else if (mode === 7) {
        partition = read(6);
        // All four endpoints' R, then all four G, then B, then A — endpoint
        // order 0,1 = subset 0 and 2,3 = subset 1.
        for (let c = 0; c < 4; c++) for (let e = 0; e < 4; e++) m7Raw[e * 4 + c] = read(5);
        for (let e = 0; e < 4; e++) m7P[e] = read(1);
        for (let e = 0; e < 4; e++) {
          for (let c = 0; c < 4; c++) m7Rec[e * 4 + c] = expandBits((m7Raw[e * 4 + c] << 1) | m7P[e], 6);
        }
        // TWO anchors: texel 0 for subset 0, BC7_ANCHOR2[partition] for subset 1.
        // Each stores one bit instead of two — read that wrong and every later
        // bit is shifted, so the block decodes as noise, not as a near colour.
        const anchor1 = BC7_ANCHOR2[partition];
        for (let t = 0; t < 16; t++) cIdx[t] = read(t === 0 || t === anchor1 ? 1 : 2);
        weights = BC7_WEIGHTS2;
      } else {
        throw new Error(`decodeBC7: unsupported mode ${mode}`);
      }

      for (let ty = 0; ty < 4; ty++) {
        const y = by * 4 + ty;
        if (y >= height) continue;
        for (let tx = 0; tx < 4; tx++) {
          const x = bx * 4 + tx;
          if (x >= width) continue;
          const t = ty * 4 + tx;
          const w = weights[cIdx[t]];
          const iw = 64 - w;
          const di = (y * width + x) * 4;
          if (mode === 7) {
            // Per-subset endpoints: which pair a texel interpolates between is
            // decided by the partition, not by its position.
            const s = BC7_PARTITION2[partition * 16 + t];
            const a = s * 8;
            const b = a + 4;
            out[di] = (m7Rec[a] * iw + m7Rec[b] * w + 32) >> 6;
            out[di + 1] = (m7Rec[a + 1] * iw + m7Rec[b + 1] * w + 32) >> 6;
            out[di + 2] = (m7Rec[a + 2] * iw + m7Rec[b + 2] * w + 32) >> 6;
            out[di + 3] = (m7Rec[a + 3] * iw + m7Rec[b + 3] * w + 32) >> 6;
            continue;
          }
          out[di] = (e0[0] * iw + e1[0] * w + 32) >> 6;
          out[di + 1] = (e0[1] * iw + e1[1] * w + 32) >> 6;
          out[di + 2] = (e0[2] * iw + e1[2] * w + 32) >> 6;
          const aw = aWeights === null ? w : aWeights[aIdx[t]];
          out[di + 3] = (e0[3] * (64 - aw) + e1[3] * aw + 32) >> 6;
        }
      }
    }
  }
  return out;
}

/** BYTES a BC7 encoding of width×height occupies (blocks × 16). */
export function bc7ByteLength(width, height) {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}

/**
 * Which BC7 mode block `blockIndex` declares — the mode marker is unary, so this
 * is just a leading-zero count over the block's first byte.
 *
 * EXISTS SO A MODE CANNOT BE SILENTLY DEAD. Every mode here is chosen by scoring,
 * so a mode that never wins — because its fit is broken, its error is mismeasured,
 * or a threshold above it excludes it — costs encode time, changes nothing, and
 * reports no symptom at all. That is exactly the class
 * memory:feedback_seam_default_hides_unwired names, and a tolerance-band test
 * cannot catch it: the image still round-trips fine, just via the old mode. The
 * tests assert real mode DISTRIBUTIONS over content each mode should win, which
 * needs this.
 *
 * @param {Uint8Array} blocks @param {number} blockIndex
 * @returns {number} 0..7, or 8 for a block with no mode bit set (invalid)
 */
export function bc7BlockMode(blocks, blockIndex) {
  const byteOff = blockIndex * 16;
  let mode = 0;
  let bit = byteOff * 8;
  while (mode < 8 && ((blocks[bit >> 3] >> (bit & 7)) & 1) === 0) {
    mode++;
    bit++;
  }
  return mode;
}

/**
 * The two-subset partition and anchor tables, exposed FOR TESTS ONLY.
 *
 * They are fixed spec data, not derived here, and our own decoder reads the same
 * copy the encoder writes — so a mistranscribed entry round-trips perfectly on
 * CPU and renders noise on a real GPU. The tests therefore assert the SPEC's own
 * structural invariants (texel 0 always in subset 0, both subsets always used,
 * every anchor genuinely inside subset 1) plus both checksums, none of which a
 * self-consistent mistake can satisfy. Exported rather than duplicated into the
 * test file, because a second copy is a second thing to get wrong.
 */
export const BC7_PARTITION2_FOR_TEST = BC7_PARTITION2;
export const BC7_ANCHOR2_FOR_TEST = BC7_ANCHOR2;

/** Count of blocks per BC7 mode across a whole encoded image — the shape the
 * tests assert on, and a useful one-line answer to "is this mode earning its
 * encode time on real art". Index = mode, value = block count. */
export function bc7ModeHistogram(blocks) {
  const hist = new Uint32Array(9);
  const n = Math.floor(blocks.length / 16);
  for (let i = 0; i < n; i++) hist[bc7BlockMode(blocks, i)]++;
  return hist;
}

// ===========================================================================
// MIP CHAIN DIMENSIONS — the "MSA looks noisier than PIXI when zoomed out" fix
// (2026-07-19, author screenshot comparison at matched zoom levels).
//
// THE CAUSE: every whole-image texture (compressed AND raw fallback) was built
// with generateMipmaps:false + LinearFilter. That pairing was copied from
// atlas.js's page atlas, where it is CORRECT (an atlas slot's neighbours are
// arbitrary bookkeeping, so automatic mip selection across a page boundary is
// meaningless — see atlas.js's own header). A whole-image texture is not an
// atlas: it is one ordinary image, and minifying it with no mip chain is
// textbook aliasing — exactly what PIXI's own mipmapped textures don't show.
// The fix restores real prefiltering; it does not touch the atlas or the
// indirection texture, where the no-mipmap rule still applies.
//
// A block-compressed format (BC1/BC7) cannot have its mip chain
// GPU-auto-generated — `generateMipmaps` only drives the WebGPU/WebGL
// backend's own box-filter pass, which does not run on block-compressed data
// (verified: three.webgpu.js's `getMipLevels`/`needsMipmaps` key off
// `texture.mipmaps.length`, not the boolean, for exactly this reason — see
// bc-compress.worker.js's header for the encode-side half of this fix). So a
// REAL chain must be supplied, one BC-encoded level per mip, precomputed here.
//
// THIS FUNCTION is the pure geometry: given a level-0 size already padded to
// the 4×4 block grid, what size is every subsequent level? Verified against
// three.webgpu.js's `_copyCompressedBufferToTexture` (`bytesPerRow`/
// `textureWidth` are derived from `mipmap.width` ALONE, per level — there is
// no cross-level dependency at upload time), so the only thing that must
// match is what `device.createTexture` implicitly allocates per level, which
// is the standard GPU rule `max(1, base >> level)`. Iterating "halve the
// previous level" is PROVABLY identical to computing `base >> i` directly,
// because integer right-shift composes exactly: `(a >> 1) >> 1 === a >> 2`.
// That equivalence is what makes a level-by-level loop (needed anyway, since
// each level is independently re-downsampled from the source — see the
// worker) land on exactly the sizes a real GPU mip chain expects, with no
// separate "recompute from the top" step required.
// ===========================================================================

/**
 * The full GPU mip-chain size sequence for a block-compressed texture whose
 * level 0 is already padded to the 4×4 block grid (`Math.ceil(_/4)*4`). Pure;
 * no encoding happens here — this only says how big each level is.
 *
 * @param {number} padW0 - level 0 width, already a multiple of 4.
 * @param {number} padH0 - level 0 height, already a multiple of 4.
 * @returns {Array<{logicalWidth:number, logicalHeight:number, width:number, height:number}>}
 *   one entry per mip level, level 0 first, ending at a 1×1 (or 1×N/N×1 for an
 *   extreme aspect ratio) level. `logicalWidth/logicalHeight` is the exact
 *   resolution to render/encode this level AT (what the worker downsamples
 *   the source image to); `width/height` is that, re-padded to the block grid
 *   — the value to declare as the mipmap's own width/height (matches level 0's
 *   own convention of storing the padded size directly).
 */
export function computeMipChainDims(padW0, padH0) {
  if (!(padW0 > 0) || !(padH0 > 0)) {
    throw new Error(`computeMipChainDims: bad base size ${padW0}x${padH0}`);
  }
  const levels = [{ logicalWidth: padW0, logicalHeight: padH0, width: padW0, height: padH0 }];
  let w = padW0;
  let h = padH0;
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    levels.push({ logicalWidth: w, logicalHeight: h, width: Math.ceil(w / 4) * 4, height: Math.ceil(h / 4) * 4 });
  }
  return levels;
}

/**
 * TOTAL GPU-resident bytes for a block-compressed texture's FULL mip chain —
 * the honest VRAM number now that whole-image BC1/BC7 textures carry a real
 * chain (see this file's mip-chain header). A single-level `bc1ByteLength`/
 * `bc7ByteLength` call under-reports by ~33% (the chain's own geometric-series
 * overhead, 1 + 1/4 + 1/16 + ... → 4/3) — exactly the class of drift
 * memory:feedback_instruments_must_not_lie exists to catch, so this sums the
 * SAME per-level padded sizes the worker actually encodes and uploads
 * (`computeMipChainDims`), not an approximation of them.
 * @param {'bc1'|'bc7'} format @param {number} width @param {number} height -
 *   the LOGICAL (pre-padding) level-0 size, e.g. a tile's own `sw`/`sh`.
 * @returns {number} total bytes across every level.
 */
export function mipChainByteLength(format, width, height) {
  const perLevel = format === 'bc7' ? bc7ByteLength : bc1ByteLength;
  const padW0 = Math.ceil(width / 4) * 4;
  const padH0 = Math.ceil(height / 4) * 4;
  let total = 0;
  for (const lvl of computeMipChainDims(padW0, padH0)) total += perLevel(lvl.width, lvl.height);
  return total;
}

// ===========================================================================
// STRIP DRIVER — encode without ever holding the whole image in memory.
//
// WHY (2026-07-18, measured): the worker used to `getImageData(0,0,w,h)` the
// entire image — 576 MB for a 12000² floor — then hand that to encodeBC7. On a
// 144-megapixel alpha layer that peak (576 MB readback + the ImageBitmap + the
// block buffer) fell over inside the worker, the BC7 encode never returned, and
// the layer dropped to the raw path and uploaded itself at 549 MB, re-killing the
// device on a floor switch (bc7:0 in the flight recorder was the receipt).
//
// This driver pulls the image in 4-row-aligned BANDS via a caller-supplied
// `readStrip(y, h)` and encodes each band independently, writing its blocks to
// their block-row offset. BC blocks are independent and row-major (see the
// `for (by) for (bx)` in encodeBC1/encodeBC7), and every band starts on a 4-row
// boundary, so a full-height block-row is NEVER split across bands and NO band
// boundary introduces edge-clamping that the whole-image encode wouldn't also do.
// The concatenation is therefore BIT-IDENTICAL to encoding the whole image at
// once — proven in the tests (encodeStriped === encodeBC1/encodeBC7). This is a
// pure memory-bounding transform, not a quality tradeoff.
// ===========================================================================

/**
 * Encode an image to BC1/BC7 blocks band-by-band, never materializing the whole
 * image. `readStrip(y, h)` must return the RGBA8 bytes for rows [y, y+h) as a
 * length-(width*h*4) Uint8Array|Uint8ClampedArray. The caller owns HOW those rows
 * are produced (a worker draws a source band into a small canvas and reads it
 * back; a test slices an in-memory array) — this function only drives the bands
 * and stitches the output.
 * @param {(y:number,h:number)=>Uint8Array|Uint8ClampedArray} readStrip
 * @param {number} width
 * @param {number} height
 * @param {'bc1'|'bc7'} format
 * @param {number} [stripRows=512] requested band height; rounded DOWN to a
 *   multiple of 4 (the block height) so bands align to the block grid.
 * @returns {Uint8Array} identical bytes to encodeBC1/encodeBC7 of the same image.
 */
export function encodeStriped(readStrip, width, height, format, stripRows = 512) {
  if (width <= 0 || height <= 0) throw new Error(`encodeStriped: bad size ${width}x${height}`);
  if (format !== 'bc1' && format !== 'bc7') throw new Error(`encodeStriped: bad format ${format}`);
  const encodeFn = format === 'bc7' ? encodeBC7 : encodeBC1;
  const bytesPerBlock = format === 'bc7' ? 16 : 8;
  const rowStride = Math.ceil(width / 4) * bytesPerBlock; // bytes in one block-row
  const out = new Uint8Array(Math.ceil(height / 4) * rowStride);
  const step = Math.max(4, stripRows - (stripRows % 4)); // align band to the 4-row block grid
  for (let y = 0; y < height; y += step) {
    const h = Math.min(step, height - y);
    const strip = readStrip(y, h);
    if (!strip || strip.length !== width * h * 4) {
      throw new Error(
        `encodeStriped: readStrip(${y},${h}) returned ${strip ? strip.length : 'null'}, expected ${width * h * 4}`
      );
    }
    // y is always a multiple of 4 (starts at 0, step is a multiple of 4), so the
    // destination block-row index y/4 is exact.
    out.set(encodeFn(strip, width, h), (y / 4) * rowStride);
  }
  return out;
}
