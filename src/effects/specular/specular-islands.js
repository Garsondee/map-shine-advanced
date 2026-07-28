/**
 * THE ISLAND PACK — connected metal regions, each with its own parallax.
 *
 * ============================================================================
 * THE ONE THING V2 NEVER HAD
 * ============================================================================
 * V2's specular derived every pattern coordinate from ONE global world frame
 * shared by every overlay on every floor, and all of its spatial hashing was
 * keyed by world cell. Two identical brass shields 200 px apart got different
 * glint PLACEMENT and statistically identical BEHAVIOUR — same grain, same
 * phase, same parallax, same everything. Its per-overlay uniform set was four
 * entries and none of them varied the motion.
 *
 * So each metal object could never feel like its own surface. This module is
 * the fix the author asked for: label the mask's connected regions, hash each
 * one to its own **parallax depth AND direction**, and let a brass door slide
 * one way while a pile of coins slides another. Parallax only — not scale, not
 * phase, not grain angle. One property, chosen because it is the one that reads
 * as separate surfaces rather than as separate textures.
 *
 * ============================================================================
 * ⚠️ THE PACK IS A PURE FUNCTION OF THE LABELS AND A HASH
 * ============================================================================
 * There is **no per-island record array, no lookup table and no island cap** —
 * per-island parameters are written straight into the per-texel pack, so the
 * shader takes one fetch with no dependent read, and the island COUNT costs
 * nothing at render time. A map with four thousand coins packs exactly as fast
 * as a map with one door. Only the JS bake loop scales, and it is a single pass
 * over ≤512² texels.
 *
 * That is deliberately unlike `fluid-pack.js`, which needs real per-tube
 * records (arc length, radius profiles) because its consumer asks per-tube
 * questions. Ours asks one question — "which way does this texel's island
 * slide?" — and a hash answers it without remembering anything.
 *
 * ⚠️ **A JUMP FLOOD CANNOT DO THIS.** Water's JFA has a spare channel and could
 * propagate a seed id, but a flood propagates NEAREST-SEED attributes; it does
 * not compute connected components. `fluid-pack.js`'s header already states
 * this and it cost that effect a design round. `labelComponents` is the tool.
 *
 * @module effects/specular/specular-islands
 */

import { labelComponents } from '../fluid/fluid-net.js';

/**
 * Longest side of the label grid.
 *
 * **512, and the number IS the author's "cluster nearby specks" answer.** At
 * this resolution a scatter of gold coins on a 10k-wide map lands a few coins
 * per texel and labels as one island — which is the right reading: a coin pile
 * is one surface, and giving each coin its own parallax would read as noise
 * rather than as complexity. A brass door, a portcullis or an inlaid floor is
 * hundreds of texels and gets its own island comfortably.
 *
 * Matches `MASK_GRID_MAX_DIM`, so the label grid and the mask authority's own
 * derivation grid are the same shape — one fewer resolution in the system.
 */
export const SPECULAR_ISLAND_MAX_DIM = 512;

/**
 * Mask value (0..255, max of RGB × alpha) at which a texel counts as metal for
 * LABELLING. Deliberately lower than the render-side presence edge: a texel too
 * faint to shine can still be the one-texel bridge that joins two halves of a
 * door, and splitting one object into two islands that then slide apart is a
 * far worse artefact than labelling a texel that draws nothing.
 */
export const SPECULAR_ISLAND_PRESENCE_MIN = 4;

/**
 * Islands smaller than this keep the GLOBAL parallax instead of their own.
 *
 * Not a cost measure — the pack does not care how many islands there are. It is
 * a look decision: a 2-texel speck given its own random direction reads as a
 * flickering error, while the same speck moving with everything else reads as
 * part of the scene. 6 texels ≈ the smallest thing whose motion is legible.
 *
 * ⚠️ **Measured against TRUE (pre-clustering) painted texels, never the
 * dilated blob `SPECULAR_ISLAND_CLUSTER_RADIUS` grows.** A single isolated
 * texel, dilated by the cluster radius alone, already covers `(2·radius+1)²`
 * texels — comfortably over this floor regardless of what was actually
 * painted, which would make the floor filter nothing at all. `buildSpecular
 * IslandPack` sums the ORIGINAL presence texels that fall inside each
 * clustered group and tests THAT — see its own comment for why.
 */
export const SPECULAR_MIN_ISLAND_TEXELS = 6;

/**
 * How far island labels are grown before the pack is written, in texels.
 *
 * ⚠️ **Not optional.** The label grid is coarser than the mask the shader
 * samples, so the metal's true silhouette extends past the labelled texels. An
 * un-dilated pack returns "no island" in a band around every object, the
 * parallax there falls back to the global default, and every metal edge grows a
 * one-texel rim sliding at a different rate from its own interior. Two texels
 * covers the resolution gap.
 *
 * This is NOT the clustering step below. This one runs AFTER labelling and
 * grows an island's OWN footprint past its own edge; `SPECULAR_ISLAND_CLUSTER_
 * RADIUS` runs BEFORE labelling and merges SEPARATE nearby specks into one
 * island in the first place. Confusing the two was the bug: dilating labels
 * after the fact cannot join two components that were never connected.
 */
export const SPECULAR_ISLAND_DILATE = 2;

/**
 * How far separate painted specks are merged into ONE island BEFORE labelling
 * runs, in label-grid texels.
 *
 * ============================================================================
 * ⚠️ THIS IS THE REAL IMPLEMENTATION OF "CLUSTER NEARBY SPECKS" — LIVE-
 * DIAGNOSED MISSING, 2026-07-27
 * ============================================================================
 * The author's own framing of this feature was "gold coins are tiny points of
 * gold pixels in a sea of black", and the chosen answer (over "every speck its
 * own island") was resolution alone: downsample far enough that a pile of
 * coins blurs into one presence blob. That works for a TIGHT pile. It does
 * NOT work for coins, rivets or filigree dots that are individually a texel or
 * two across but a few texels APART — each one is a genuine, isolated,
 * 8-connected component of 1-3 texels, comfortably under
 * `SPECULAR_MIN_ISLAND_TEXELS`, and every one of them was silently dropped to
 * the global fallback. On a scene whose metal is mostly this kind of detail —
 * plausible for exactly the ornate-trim case the author described — the pack
 * could legitimately end up with ZERO surviving islands: not a bug in the
 * bake, but a size floor applied to the wrong quantity.
 *
 * The fix is a real morphological CLOSE on the presence grid: OR every texel's
 * value into its neighbours for this many rounds, so two specks within
 * `2 × RADIUS` texels of each other merge into one component before
 * `labelComponents` ever runs — their COMBINED size is what the threshold
 * tests, which is what "a coin pile is one surface" actually means.
 *
 * 3 texels, at the 512-grid resolution `SPECULAR_ISLAND_MAX_DIM` already caps
 * at: generous enough to bridge a scattered handful of coins or a dashed
 * decorative line, narrow enough that two genuinely separate large objects
 * (a door on one wall, a sconce on another) stay distinct rather than being
 * swallowed into one island and defeating per-object variety entirely.
 */
export const SPECULAR_ISLAND_CLUSTER_RADIUS = 3;

/**
 * Merge nearby presence texels together — a morphological CLOSE, run BEFORE
 * `labelComponents` so specks within `radius` of each other end up as ONE
 * component instead of several individually-too-small ones. See
 * `SPECULAR_ISLAND_CLUSTER_RADIUS`'s own header for why this exists.
 *
 * 8-connected growth, matching `labelComponents`'s own connectivity, so a
 * diagonal chain of coins clusters the same way it would label.
 *
 * @param {Uint8Array} present @param {number} w @param {number} h @param {number} radius
 * @returns {Uint8Array} a NEW array; the input is not modified.
 */
export function clusterPresence(present, w, h, radius) {
  let cur = present;
  for (let r = 0; r < radius; r++) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        let hit = false;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (cur[yy * w + xx]) {
              hit = true;
              break;
            }
          }
        }
        if (hit) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * THE PARALLAX RANGE THE BYTE ENCODING COVERS, +/- this in pattern units.
 *
 * The pack is `UnsignedByteType`, so each parallax component is stored as
 * `(v + RANGE) / (2 * RANGE)` and decoded back in the shader. 2 covers the full
 * hashed spread with room for an author pushing `islandSpread` to its maximum,
 * and quantises to 4/255 = 0.016 of a pattern unit -- a 1.6% step on a motion
 * vector, which is invisible.
 *
 * ⚠️ **BYTES, NOT FLOATS, AND THAT IS A BUG FIX RATHER THAN A SIZE CHOICE.**
 * The first version packed `RGBAFormat` + `FloatType`, and the shader read
 * ZERO from it live -- while the identical CPU bake was measured correct (40
 * islands, parallax varying). `vt-pan-viewer.js`'s own wind-grid note already
 * records the reason: *"FloatType has patchier linear-filtering support"*, and
 * WebGPU makes `rgba32float` filterable only behind an optional feature. The
 * project had learned this once already for the wind grid and this pack did not
 * inherit it. `fluid-pack.js` still uses `FloatType` and fluid is likewise
 * author-confirmed not working -- worth checking there next.
 */
export const ISLAND_PARALLAX_RANGE = 2;

/**
 * The spread of hashed parallax depths, as a signed range around 1.
 *
 * ±0.6 puts islands in roughly [0.4, 1.6] before the author's own `islandSpread`
 * scales it — so most slide near V2's 1:1 screen-locked rate, the fastest at
 * ~1.6× and the slowest at ~0.4×. Wide enough to read as different surfaces,
 * narrow enough that nothing detaches from the map and swims.
 */
export const ISLAND_DEPTH_SPREAD = 0.6;

/**
 * Extract a presence grid from a decoded RGBA mask, at label resolution.
 *
 * ⚠️ **MAX of RGB, then × alpha — never the red channel.** A blue-painted steel
 * object has `r = 0`, and measuring presence by red would delete it from the
 * island map while it still rendered, so its parallax would silently fall back
 * to global. Same reasoning `specular-surface-subsystem.js` already applies to
 * the AABB bounds, and the same decode the render side uses for `strength`.
 *
 * Box-MAX downsampling rather than mean: a single bright texel in an otherwise
 * dark block IS metal and must survive to the label grid. A mean would erase
 * exactly the coin-scatter case this is for.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba - RGBA bytes, row 0 = top.
 * @param {number} srcW @param {number} srcH
 * @param {number} maxDim
 * @returns {{present: Uint8Array, w: number, h: number}}
 */
export function presenceGridFromRgba(rgba, srcW, srcH, maxDim = SPECULAR_ISLAND_MAX_DIM) {
  const scale = Math.min(1, maxDim / Math.max(1, Math.max(srcW, srcH)));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const present = new Uint8Array(w * h);
  const sx = srcW / w;
  const sy = srcH / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(srcW, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let best = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * srcW + xx) * 4;
          const rgbMax = Math.max(rgba[i], Math.max(rgba[i + 1], rgba[i + 2]));
          const a = rgba[i + 3];
          // The alpha-missing fallback, matching the render-side strength
          // decode: a fully transparent-looking mask is the common
          // greyscale-no-alpha authoring case, not an empty one.
          const v = a < 1 ? rgbMax : (rgbMax * a) / 255;
          if (v > best) best = v;
        }
      }
      present[y * w + x] = best >= SPECULAR_ISLAND_PRESENCE_MIN ? 1 : 0;
    }
  }
  return { present, w, h };
}

/**
 * Grow labels outward by `radius` texels, so the pack stays valid past the
 * label grid's own silhouette. Chebyshev (8-connected) growth, matching the
 * connectivity `labelComponents` used, so a diagonal bridge dilates the way it
 * was labelled.
 *
 * Reads from a snapshot each round, never from the array being written — an
 * in-place dilation propagates a label across the whole grid in one pass
 * (the classic flood-fill-by-accident, and it would make every island one
 * island).
 *
 * @param {Uint16Array} labels @param {number} w @param {number} h @param {number} radius
 * @returns {Uint16Array} a new array; the input is not modified.
 */
export function dilateLabels(labels, w, h, radius = SPECULAR_ISLAND_DILATE) {
  let cur = labels;
  for (let r = 0; r < radius; r++) {
    const next = Uint16Array.from(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i] !== 0) continue;
        let found = 0;
        for (let dy = -1; dy <= 1 && !found; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const v = cur[yy * w + xx];
            if (v !== 0) {
              found = v;
              break;
            }
          }
        }
        if (found) next[i] = found;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * An island's parallax, from its label alone. Deterministic: the same map
 * always produces the same motion, so a scene does not reshuffle between
 * sessions.
 *
 * Depth and DIRECTION both, which is what makes this more than V2's single
 * signed scalar: an island can slide diagonally, or along its own axis, not
 * merely faster or backwards along the camera's own vector.
 *
 * @param {number} label - 1-based.
 * @param {number} spread - the author's `islandSpread`, 0 = every island moves
 *   identically (V2's behaviour exactly), 1 = the full hashed range.
 * @returns {{x: number, y: number}}
 */
export function islandParallax(label, spread = 1) {
  // Two decorrelated hashes: one for how fast, one for which way. Sharing one
  // would tie direction to speed and every fast island would slide the same way.
  const h1 = fract(Math.sin(label * 12.9898) * 43758.5453);
  const h2 = fract(Math.sin(label * 78.233) * 43758.5453);
  const depth = 1 + (h1 - 0.5) * 2 * ISLAND_DEPTH_SPREAD * spread;
  // A bounded angular wander rather than a free direction: at full spread an
  // island may lean up to ~34° off the camera's own axis. Free rotation would
  // let an island slide sideways to a pan, which reads as a bug rather than as
  // depth — the eye accepts "faster/slower/backwards", not "sideways".
  const angle = (h2 - 0.5) * 1.2 * spread;
  return { x: depth * Math.cos(angle), y: depth * Math.sin(angle) };
}

/** @param {number} x @returns {number} */
function fract(x) {
  return x - Math.floor(x);
}

/**
 * An island's DEBUG HUE, 0..1 -- a third decorrelated hash, and it is not
 * decoration.
 *
 * ⚠️ The first version stored `label / 255` here and the debug channel was
 * unreadable: with forty islands every value landed under 0.16, so every object
 * rendered the same near-black blue and "are the islands distinct?" -- the one
 * question the channel exists to answer -- could not be answered from it. A
 * hash spreads forty labels evenly across the whole hue circle, so adjacent
 * objects are adjacent in NOTHING and read as obviously different colours.
 *
 * @param {number} label @returns {number} 0..1
 */
export function islandHue(label) {
  return fract(Math.sin(label * 45.164) * 21943.7351);
}

/** Encode a signed parallax component into a 0..255 byte. @param {number} v
 * @returns {number} */
function encodeParallax(v) {
  const t = (v + ISLAND_PARALLAX_RANGE) / (2 * ISLAND_PARALLAX_RANGE);
  return Math.max(0, Math.min(255, Math.round(t * 255)));
}

/**
 * Label a decoded `_Specular` file's connected regions and pack each texel's
 * parallax. The whole bake, as one pure function.
 *
 * @param {object} args
 * @param {Uint8Array|Uint8ClampedArray} args.rgba - decoded mask bytes.
 * @param {number} args.width @param {number} args.height
 * @param {number} [args.spread] - the author's `islandSpread`.
 * @param {number} [args.maxDim]
 * @returns {{data: Uint8Array, w: number, h: number, islandCount: number,
 *   labelledTexels: number, droppedSmall: number, preClusterComponents: number}}
 *   `data` is RGBA BYTES: R,G = the parallax vector, encoded over
 *   +/-`ISLAND_PARALLAX_RANGE` · B = a hashed hue for the debug channel ·
 *   A = 255 where an island owns this texel. `preClusterComponents` is the
 *   count BEFORE the merge step (`clusterPresence`) is applied — the gap
 *   between it and `islandCount + droppedSmall` is exactly how many separate
 *   specks the clustering step joined into shared islands, the one number
 *   that tells a report whether clustering did anything at all.
 */
export function buildSpecularIslandPack({ rgba, width, height, spread = 1, maxDim = SPECULAR_ISLAND_MAX_DIM }) {
  const { present, w, h } = presenceGridFromRgba(rgba, width, height, maxDim);

  // Reported before clustering touches anything — see the return doc. Cheap:
  // one more pass over the same ≤512² grid, once per bake, never per frame.
  const preClusterComponents = labelComponents(present, w, h).sizes.length;

  // ⚠️ THE CLUSTERING STEP — merges nearby specks into ONE component BEFORE
  // labelling, so their COMBINED size is what the size floor tests. Without
  // this, a scatter of coins a texel or two apart are each their own tiny,
  // individually-sub-threshold component and ALL get dropped to the global
  // fallback — a pack that bakes without error and reports zero islands, which
  // is indistinguishable on screen from the effect being broken. See
  // `SPECULAR_ISLAND_CLUSTER_RADIUS`'s own header for the live diagnosis.
  const clustered = clusterPresence(present, w, h, SPECULAR_ISLAND_CLUSTER_RADIUS);
  const { tubeId, sizes } = labelComponents(clustered, w, h);

  // ⚠️ THE SIZE FLOOR MUST TEST TRUE PAINTED AREA, NOT THE DILATED FOOTPRINT —
  // caught before shipping. `sizes` above is the count of texels in the
  // CLUSTERED (grown) blob, and growing even ONE isolated texel by
  // `SPECULAR_ISLAND_CLUSTER_RADIUS` rounds already produces a
  // `(2·radius+1)²` = 49-texel blob at the default radius. Filtering against
  // THAT number would mean nothing could ever be small enough to drop — the
  // one job `SPECULAR_MIN_ISLAND_TEXELS` exists to do. So the floor is tested
  // against the TRUE (pre-dilation) texel count instead: for every texel that
  // was genuinely painted, look up which CLUSTER it ended up in and count it
  // there. A lone speck that clustered with nothing keeps a true count of 1
  // and is correctly dropped; four coins a texel apart that merged into one
  // cluster keep a true count of 4 each contributing — their COMBINED true
  // paint, which is what "cluster nearby specks" is actually supposed to mean.
  const trueCount = new Uint32Array(sizes.length + 1);
  for (let i = 0; i < present.length; i++) if (present[i]) trueCount[tubeId[i]]++;

  // Sub-threshold islands are cleared BEFORE dilation, so a dropped speck
  // cannot then grow back over its neighbours and steal their texels.
  let droppedSmall = 0;
  const keep = new Uint8Array(sizes.length + 1);
  for (let label = 1; label <= sizes.length; label++) {
    if (trueCount[label] >= SPECULAR_MIN_ISLAND_TEXELS) keep[label] = 1;
    else droppedSmall++;
  }
  const filtered = new Uint16Array(tubeId.length);
  for (let i = 0; i < tubeId.length; i++) filtered[i] = keep[tubeId[i]] ? tubeId[i] : 0;

  // ============================================================================
  // THE PER-ISLAND BOUNDS ESTIMATE (2026-07-28, the performance audit) —
  // JS-ONLY, BAKE-TIME, ZERO RENDER-TIME COST.
  // ============================================================================
  // Not used for rendering — `specular-surface-subsystem.js` still crops ONE
  // combined AABB. This answers a narrower question first: if it cropped to
  // N per-island quads instead, how much would that actually save? Building
  // real per-island geometry is a genuine lift (per-island bounds threaded
  // through to render, the mask-UV mapping moved from a uniform into a vertex
  // attribute so N quads share one draw call) on a file already mid-rework —
  // worth doing only once the number says it pays.
  //
  // Uses the SAME criterion the combined AABB uses (`vt/mask-image.js`'s scan
  // of the raw file for true painted texels) — TRUE paint, not the CLUSTERED
  // footprint `filtered` above or the DILATED one `labels` below. Clustering
  // exists to decide which specks merge into one island; dilation exists only
  // to keep the PARALLAX PACK sample valid past an island's edge (this file's
  // own header on `dilateLabels`). Neither is what a real render crop would
  // need to cover — `presence` (the shader's final gate) is zero whether the
  // pack is dilated there or not, since it comes from the mask, not the pack.
  // Basing the estimate on either would overstate the achievable win.
  let perIslandUnionTexels = 0;
  if (sizes.length > droppedSmall) {
    const minX = new Int32Array(sizes.length + 1).fill(w);
    const minY = new Int32Array(sizes.length + 1).fill(h);
    const maxX = new Int32Array(sizes.length + 1).fill(-1);
    const maxY = new Int32Array(sizes.length + 1).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!present[i]) continue;
        const label = tubeId[i];
        if (!keep[label]) continue;
        if (x < minX[label]) minX[label] = x;
        if (x > maxX[label]) maxX[label] = x;
        if (y < minY[label]) minY[label] = y;
        if (y > maxY[label]) maxY[label] = y;
      }
    }
    for (let label = 1; label <= sizes.length; label++) {
      if (!keep[label] || maxX[label] < 0) continue;
      perIslandUnionTexels += (maxX[label] - minX[label] + 1) * (maxY[label] - minY[label] + 1);
    }
  }
  // Fraction of the LABEL GRID, directly comparable to `aabbFractionOfItem`
  // (which is a fraction of the ITEM — the two are the same quantity, this one
  // just measured at 512² resolution instead of the mask's full resolution).
  // Coarser, but the rounding error is at most one grid cell per island edge —
  // negligible for a go/no-go read, not precise enough to build render geometry
  // from directly.
  const estimatedPerIslandGridFraction = w * h > 0 ? perIslandUnionTexels / (w * h) : null;

  const labels = dilateLabels(filtered, w, h, SPECULAR_ISLAND_DILATE);

  // Parallax is memoised per label rather than hashed per texel -- two trig
  // calls times 262,144 texels is real time for an answer that cannot vary
  // within an island by construction.
  const cache = new Map();
  const data = new Uint8Array(w * h * 4);
  const globalR = encodeParallax(1);
  const globalG = encodeParallax(0);
  let labelledTexels = 0;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const o = i * 4;
    if (label === 0) {
      // ⚠️ THE UNLABELLED DEFAULT IS THE GLOBAL PARALLAX (1, 0), NOT ZERO. A
      // zero would freeze the pattern solid wherever no island claimed a texel
      // -- which looks exactly like the effect having died, and would be read
      // as one. Unlabelled metal behaves precisely as V2's did.
      data[o] = globalR;
      data[o + 1] = globalG;
      continue;
    }
    let p = cache.get(label);
    if (!p) {
      p = islandParallax(label, spread);
      p.hue = islandHue(label);
      cache.set(label, p);
    }
    data[o] = encodeParallax(p.x);
    data[o + 1] = encodeParallax(p.y);
    data[o + 2] = Math.round(p.hue * 255);
    data[o + 3] = 255;
    labelledTexels++;
  }

  return {
    data,
    w,
    h,
    islandCount: sizes.length - droppedSmall,
    labelledTexels,
    droppedSmall,
    preClusterComponents,
    // See the block above this function's return — a bake-time-only estimate,
    // not used for rendering. Zero surviving islands genuinely IS zero covered
    // pixels — a real measurement, not an absence — so this is only ever null
    // in the defensive `w*h === 0` branch a real bake never reaches.
    estimatedPerIslandGridFraction,
  };
}
