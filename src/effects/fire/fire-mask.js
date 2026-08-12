/**
 * FIRE — THE PAINTED REGION BECOMES FIRES. Pure math over a `MaskGrid`, no
 * THREE, no GPU, Node-tested.
 *
 * ============================================================================
 * WHY A DISTANCE TRANSFORM AND NOT "ONE FIRE PER BLOB"
 * ============================================================================
 *
 * The author paints `_Fire`; the region's own WIDTH is supposed to set each
 * fire's diameter, because diameter is the one knob the whole scale chain hangs
 * off (`fire-geometry.js#fireScaleChain`). The obvious implementation —
 * connected components, then `diameter = 2·√(area/π)` — is wrong for the case
 * that matters most: a thin line of fire painted along a burning wall has a
 * large AREA and a small WIDTH, and area-based sizing turns it into one
 * enormous slow-pulsing bonfire instead of a row of small fast flames.
 *
 * So this computes a **chamfer distance transform** — every painted texel's
 * distance to the nearest unpainted one — and puts fires on the RIDGE of that
 * field. A texel's distance IS the local half-width of the region there, which
 * is exactly the quantity wanted:
 *
 *   - a round blob has one ridge peak at its centre → one fire, correct size
 *   - a long thin line has a ridge running down its spine → a ROW of small
 *     fires, each sized by the line's width where it sits
 *   - two blobs joined by a neck get a fire in each, not one averaged giant
 *
 * This is the same signed-distance idea `water-body.js` runs as a GPU jump
 * flood. It is done on the CPU here, once per mask version rather than per
 * frame, over the COARSE derived grid — a fire's placement does not need
 * sub-texel precision, and the alternative (a second GPU JFA target and a
 * readback) would cost a render target and a stall to buy nothing visible.
 *
 * ⚠️ Chamfer distance is an APPROXIMATION of Euclidean distance (~2% error with
 * the 3-4 weights used here), which is far inside the tolerance of "how big is
 * this fire" and is said out loud rather than left to be re-derived.
 *
 * @module effects/fire/fire-mask
 */

/** Painted-ness above which a texel counts as fire. */
const PAINT_THRESHOLD = 0.25;

/**
 * Chamfer weights. 3-4 is the classic integer approximation of Euclidean
 * distance on a square grid: orthogonal steps cost 3, diagonal 4, and the whole
 * field is divided by 3 at the end. Max error ~2% against true Euclidean.
 */
const CHAMFER_ORTHO = 3;
const CHAMFER_DIAG = 4;
const CHAMFER_SCALE = 3;

/** A fire must be at least this many texels across to be worth drawing. */
const MIN_PEAK_TEXELS = 1.0;

/**
 * How far apart fires are kept, as a multiple of the larger one's radius. Below
 * ~1.4 a wide region fills with overlapping duplicates that cost light and add
 * nothing; above ~2.5 a long line gets visible gaps between its flames.
 */
const PEAK_SEPARATION = 1.7;

/** Hard cap. A whole-map paint must not mint a thousand lights. */
const MAX_FIRES = 64;

/**
 * Distance from every painted texel to the nearest UNPAINTED one, in texels.
 *
 * Two sequential passes (forward: top-left → bottom-right, backward: the
 * reverse) is the standard two-pass chamfer algorithm and is exact for this
 * neighbourhood — no iteration to convergence needed.
 *
 * ⚠️ THE BORDER COUNTS AS UNPAINTED. A region running off the edge of the grid
 * would otherwise measure as infinitely wide there and produce one absurd fire
 * pinned to the map edge. Treating outside-the-grid as unpainted makes a
 * region clipped by the map boundary read as exactly as wide as it looks.
 *
 * @param {Uint8Array} data - w*h, row-major, row 0 = minY.
 * @param {number} w @param {number} h
 * @returns {Float32Array} distance in texels; 0 wherever unpainted.
 */
export function chamferDistance(data, w, h) {
  const n = w * h;
  const dist = new Float32Array(n);
  const BIG = 1e9;
  const threshold = PAINT_THRESHOLD * 255;

  for (let i = 0; i < n; i++) dist[i] = data[i] >= threshold ? BIG : 0;

  // Forward pass. Out-of-grid neighbours are treated as unpainted (distance 0),
  // so a painted texel on the border resolves to one step from an edge.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (y > 0) {
        best = Math.min(best, dist[i - w] + CHAMFER_ORTHO);
        if (x > 0) best = Math.min(best, dist[i - w - 1] + CHAMFER_DIAG);
        if (x < w - 1) best = Math.min(best, dist[i - w + 1] + CHAMFER_DIAG);
      } else {
        best = Math.min(best, CHAMFER_ORTHO);
      }
      if (x > 0) best = Math.min(best, dist[i - 1] + CHAMFER_ORTHO);
      else best = Math.min(best, CHAMFER_ORTHO);
      dist[i] = best;
    }
  }

  // Backward pass.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (y < h - 1) {
        best = Math.min(best, dist[i + w] + CHAMFER_ORTHO);
        if (x > 0) best = Math.min(best, dist[i + w - 1] + CHAMFER_DIAG);
        if (x < w - 1) best = Math.min(best, dist[i + w + 1] + CHAMFER_DIAG);
      } else {
        best = Math.min(best, CHAMFER_ORTHO);
      }
      if (x < w - 1) best = Math.min(best, dist[i + 1] + CHAMFER_ORTHO);
      else best = Math.min(best, CHAMFER_ORTHO);
      dist[i] = best;
    }
  }

  for (let i = 0; i < n; i++) dist[i] /= CHAMFER_SCALE;
  return dist;
}

/**
 * Label connected painted components (4-connectivity — a diagonal-only touch
 * does not merge two blobs, the conservative reading of "is this one shape").
 * An explicit stack, not recursion: a 512×512 grid's components can hold tens
 * of thousands of texels.
 *
 * @param {Uint8Array} data @param {number} w @param {number} h @param {number} threshold
 * @returns {{labels:Int32Array, boxes:Array<{minX:number,maxX:number,minY:number,maxY:number}>}}
 */
function labelComponents(data, w, h, threshold) {
  const labels = new Int32Array(w * h).fill(-1);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== -1 || data[start] < threshold) continue;
    const label = boxes.length;
    labels[start] = label;
    stack.push(start);
    let minX = start % w;
    let maxX = minX;
    let minY = (start / w) | 0;
    let maxY = minY;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && labels[i - 1] === -1 && data[i - 1] >= threshold) {
        labels[i - 1] = label;
        stack.push(i - 1);
      }
      if (x < w - 1 && labels[i + 1] === -1 && data[i + 1] >= threshold) {
        labels[i + 1] = label;
        stack.push(i + 1);
      }
      if (y > 0 && labels[i - w] === -1 && data[i - w] >= threshold) {
        labels[i - w] = label;
        stack.push(i - w);
      }
      if (y < h - 1 && labels[i + w] === -1 && data[i + w] >= threshold) {
        labels[i + w] = label;
        stack.push(i + w);
      }
    }
    boxes.push({ minX, maxX, minY, maxY });
  }
  return { labels, boxes };
}

/**
 * How many multiples of its OWN peak radius a component's long axis may span
 * before it counts as elongated (a real line) rather than compact (one blob
 * that merely isn't round).
 *
 * ⚠️ MEASURED, NOT GUESSED, AND A SINGLE SUPPRESSION-RADIUS THRESHOLD CANNOT
 * REPLACE THIS. A tall archway/hearth opening (author-painted, live,
 * 2026-08-08 — screenshot showed "two blobs... looks like flames seen from the
 * side") and this file's own tested LINE fixture produce the IDENTICAL local
 * ridge-spacing pattern — both are regions of roughly constant width with a
 * ridge running down the middle — so no `PEAK_SEPARATION` value can collapse
 * one without collapsing (or gapping) the other: sweeping it from 1.7 to 5.0
 * against both fixtures never separated them (archway needed >=4.5 to reach
 * one fire; at that separation the line fixture's own count had already more
 * than halved, and this file's own `PEAK_SEPARATION` comment already names
 * "above ~2.5 a long line gets visible gaps" as the failure mode). The two
 * shapes differ only in ELONGATION — how many peak-radii long they are — which
 * `PEAK_SEPARATION` has no way to see because it only ever compares a
 * candidate to its NEIGHBOURS, never to the shape's own overall extent.
 *
 * Measured on the reproductions: a tall hearth/archway (~14×44 texels, one
 * paint region, no real neck) landed at span/radius ≈ 5.5 and must stay ONE
 * fire; the tested line fixture landed at ≈ 20 and must stay MANY. 8 sits with
 * wide margin on both sides of that gap.
 */
const ELONGATION_RATIO = 8;

/**
 * Turn a painted `_Fire` grid into fire sources.
 *
 * Greedy ridge extraction: repeatedly take the widest remaining point and
 * suppress everything within its own radius, so a blob yields its centre and a
 * line yields a spaced row down its spine. Deterministic — the same grid always
 * yields the same fires in the same order, which matters because the light
 * pool reuses meshes by `sourceId` and an unstable id rebuilds every light
 * every frame.
 *
 * ⚠️ SCOPED PER CONNECTED COMPONENT, not pooled across the whole grid. A
 * component whose long axis is not many multiples of its own peak radius (see
 * {@link ELONGATION_RATIO}) contributes ONLY its single best peak — it is one
 * blob that happens to be taller than it is wide, not a row of small flames.
 * An elongated component keeps the original multi-peak ridge walk unchanged.
 *
 * @param {{spec: object, data: Uint8Array}} grid - from `maskAuthority.getDerived('fire', floorIndex)`.
 * @param {object} [opts]
 * @param {number} [opts.maxFires=MAX_FIRES]
 * @param {number} [opts.minDiameterPx=8] - below this a fire is not worth a draw or a light.
 * @returns {Array<{id:string,x:number,y:number,diameterPx:number,intensity:number}>}
 */
export function extractFiresFromMask(grid, { maxFires = MAX_FIRES, minDiameterPx = 8 } = {}) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  if (!spec || !data) return [];
  const w = spec.w | 0;
  const h = spec.h | 0;
  if (w <= 0 || h <= 0 || data.length < w * h) return [];

  const dist = chamferDistance(data, w, h);
  const { labels, boxes } = labelComponents(data, w, h, PAINT_THRESHOLD * 255);

  // Candidate ridge texels, widest first. Anything under MIN_PEAK_TEXELS is a
  // one-texel speck of paint, not a fire.
  const candidates = [];
  for (let i = 0; i < w * h; i++) if (dist[i] >= MIN_PEAK_TEXELS) candidates.push(i);
  if (candidates.length === 0) return [];
  // Tie-break on index so the order is total and the output is reproducible.
  candidates.sort((a, b) => dist[b] - dist[a] || a - b);

  // Classify each component ONCE, off its own bounding box and its own widest
  // ridge point (the first candidate in sorted order carrying that label).
  const isBlobByLabel = new Map();
  for (const i of candidates) {
    const label = labels[i];
    if (isBlobByLabel.has(label)) continue;
    const box = boxes[label];
    const span = Math.max(box.maxX - box.minX + 1, box.maxY - box.minY + 1);
    const r0 = dist[i]; // widest remaining candidate for this label — sorted desc, so this IS the component's peak.
    isBlobByLabel.set(label, span <= r0 * ELONGATION_RATIO);
  }
  const blobLabelTaken = new Set();

  const texelW = Number.isFinite(spec.texelW) && spec.texelW > 0 ? spec.texelW : spec.width / w;
  const texelH = Number.isFinite(spec.texelH) && spec.texelH > 0 ? spec.texelH : spec.height / h;
  // Fires are round; a non-square texel would otherwise make diameter depend on
  // which axis it was measured along.
  const texelPx = (texelW + texelH) / 2;

  /**
   * ⚠️ THE ONLY SIZE GUARD IS `minDiameterPx`, IN WORLD UNITS — deliberately
   * NOT a texel count, and this was measured rather than reasoned.
   *
   * A first version also rejected any peak with fewer than two painted
   * orthogonal neighbours, on the theory that an isolated texel is a stray
   * brush tap. Run against the author's real `Tower_Bridge_Middle_Fire.webp`
   * (2026-08-08) that filter deleted every fire on the map below a 512-wide
   * grid, and the map derives at EXACTLY 512 (`MASK_GRID_MAX_DIM`):
   *
   *     grid 1024 → 214 painted texels → 22 fires
   *     grid  512 →  61 painted texels → 20 fires   ← what actually ships
   *     grid  256 →   8 painted texels →  5 fires
   *
   * (Re-measured 2026-08-08 after the elongation fix below; the exact counts
   * drift with any tuning constant in this file and are not load-bearing —
   * what matters, and what stayed true across every retune so far, is that the
   * connectedness filter took the 512-wide row to exactly zero and nothing
   * else has.)
   *
   * Real authored fires are SMALL DOTS — hearths, braziers, campfires — and at
   * the derivation grid's own resolution a "one-texel speck" over a 10,650 px
   * map is a 20 px painted dot the author placed on purpose. The downsample has
   * already averaged away anything genuinely accidental before this ever runs.
   *
   * `minDiameterPx` is the correct guard precisely because it is scale-aware:
   * a lone texel on a FINE grid yields a tiny diameter and is dropped, while
   * the same lone texel on a COARSE grid yields a real fire and is kept. A
   * texel-count guard gets that backwards on exactly the maps that matter.
   */
  const taken = [];
  const fires = [];
  for (const i of candidates) {
    if (fires.length >= maxFires) break;
    const label = labels[i];
    // A compact (non-elongated) component only ever contributes its single
    // best peak — already taken the first time this label was seen, since
    // `candidates` is sorted widest-first. Everything else from the SAME
    // component is a smaller point on the SAME blob, not a second fire.
    if (isBlobByLabel.get(label) && blobLabelTaken.has(label)) continue;

    const radiusTexels = dist[i];
    const cx = i % w;
    const cy = (i / w) | 0;

    let suppressed = false;
    for (const t of taken) {
      const sep = Math.max(radiusTexels, t.r) * PEAK_SEPARATION;
      if ((cx - t.x) ** 2 + (cy - t.y) ** 2 < sep * sep) {
        suppressed = true;
        break;
      }
    }
    if (suppressed) continue;

    const diameterPx = radiusTexels * 2 * texelPx;
    if (diameterPx < minDiameterPx) continue;

    if (isBlobByLabel.get(label)) blobLabelTaken.add(label);
    taken.push({ x: cx, y: cy, r: radiusTexels });
    fires.push({
      // Stable across frames AND across mask re-derivations at the same
      // resolution, because it is derived from the texel this fire sits on.
      id: `mask:${cx}_${cy}`,
      // Texel centre → world. Row 0 is minY (MaskGrid's own convention), and
      // world +Y is DOWN, so this needs no flip — the camera owns the one flip
      // this renderer has.
      x: spec.x + (cx + 0.5) * texelW,
      y: spec.y + (cy + 0.5) * texelH,
      diameterPx,
      // How white the paint is here scales how hard this fire burns, so an
      // author can shade a region rather than only outline it.
      //
      // ⚠️ NOT DIVIDED BY THE PAINT THRESHOLD. The first version did
      // `min(2, v/255/PAINT_THRESHOLD)`, which saturates at 2 for ANY paint
      // above 25% grey — so mid-grey and pure white burned identically and the
      // shading control silently did nothing. The threshold decides whether a
      // texel is fire AT ALL; it has no business scaling how hot it is.
      intensity: 0.5 + (data[i] / 255) * 0.75,
    });
  }
  return fires;
}

/**
 * A cheap signature over what `extractFiresFromMask` reads, so the extraction
 * runs once per mask change rather than once per frame. Samples rather than
 * hashing every texel: a 512² grid is 262k bytes and this is called per frame.
 *
 * ⚠️ SAMPLED, SO IT CAN MISS A SMALL EDIT. That is a deliberate trade and the
 * consumer must also invalidate on the mask authority's own version counter —
 * this is a cheap "did it obviously change", not a content hash. Stated because
 * a signature that silently misses a change is exactly how a stale bake
 * survives an edit (`feedback_url_keyed_cache_needs_a_content_validator`).
 *
 * ⚠️ MUST MIX `spec.width`/`spec.height`, NOT JUST `spec.w`/`spec.h` — its
 * sibling `fireSpawnSignature` (fire-spawn-points.js) already does, and this
 * one didn't. `w`/`h` are the TEXEL GRID dimensions; `width`/`height` are the
 * WORLD-SPACE rect they cover. A region's world bounds can change (a resize,
 * or a different item hosting the same texel resolution) with `w`/`h`/`x`/`y`
 * all unchanged, and every downstream `x`/`y`/`diameterPx` this function's
 * caller caches depends on `width`/`height` too (`extractFiresFromMask` reads
 * `texelW = spec.width / w`). Without this, that resize reads as "unchanged"
 * and `fireMaskCache` (boot.js) serves stale positions/sizes past the edit.
 *
 * @param {{spec: object, data: Uint8Array}} grid @returns {number}
 */
export function fireMaskSignature(grid) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  if (!spec || !data) return 0;
  let hash = 2166136261 >>> 0;
  const mix = (v) => {
    hash ^= v | 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  mix(spec.w);
  mix(spec.h);
  mix(Math.round(spec.x));
  mix(Math.round(spec.y));
  mix(Math.round(spec.width));
  mix(Math.round(spec.height));
  const stride = Math.max(1, Math.floor(data.length / 4096));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += stride) {
    mix(data[i]);
    sum += data[i];
    count++;
  }
  mix(sum);
  mix(count);
  return hash;
}
