/**
 * PAINT MASK — the pure model + codec for MSA-painted effect masks.
 *
 * ============================================================================
 * WHAT A PAINTED MASK IS (and why it costs almost nothing new)
 * ============================================================================
 *
 * A painted mask is a `MaskGrid` (scene/mask-derive.js) sized over the scene
 * rect — the SAME grid TYPE the mask authority uses for its derived products,
 * just at a HIGHER resolution (`PAINT_GRID_MAX_DIM`, not mask-derive's coarse
 * `MASK_GRID_MAX_DIM` — see that constant's own comment for why the two must
 * differ). So a mask the user PAINTS in MSA and a `_Fire` mask the author makes
 * in PHOTOSHOP and drops beside the map are the same shape of thing — peers,
 * not two systems. That is the author's "belts and braces": some effects
 * driven by a bundled `_Suffix` file, some painted in-app, both valid, both
 * travelling with the scene (docs/planning/Authoring-and-Distribution.md).
 *
 * This module is the PURE half — model, brush, codec, persistence — Node-tested
 * in isolation. The browser half (the overlay canvas, pointer capture, live
 * preview, the Foundry file/flag writes) is ui/paint-mode.js, verified live.
 *
 * COORDINATES: all brush positions are WORLD coordinates = Foundry canvas space,
 * +Y DOWN, exactly as mask-derive.js documents. `stampBrushWorld` maps world→
 * cell with the identical formula `sampleMaskGridWorld` reads back with; the
 * Node suite paints a point and reads it with the authority's OWN sampler to
 * prove the two agree — the anti-Y-flip guarantee (feedback_y_flip_recurring_risk),
 * bought by cross-checking against tested code rather than re-deriving a mapping.
 *
 * PERSISTENCE (Mode A, embed): a painted grid RLE-compresses hard (masks are
 * sparse) into a JSON-native `{w,h,rle}` payload that rides in a scene flag and
 * therefore travels inside an adventure automatically. A per-mask byte budget
 * flags a mask too detailed to embed cheaply — the signal to bake it to a file
 * instead (Mode B, ui/paint-mode.js).
 *
 * @module scene/paint-mask
 */

import { computeMaskGridSpec, createMaskGrid, sampleMaskGridWorld } from './mask-derive.js';

/** Per-mask embed budget (bytes of the JSON payload in a scene flag). Over this,
 *  the UI should offer "bake to a file" instead of embedding — a detailed mask
 *  bloats every scene in a compendium. Cross-referenced in the package-readiness
 *  gate (Authoring-and-Distribution.md §4.4). */
export const PAINT_EMBED_BYTE_BUDGET = 96 * 1024;

/**
 * Longest grid side for a PAINTED layer. Deliberately its OWN constant,
 * separate from mask-derive's `MASK_GRID_MAX_DIM` (512) — that one is tuned
 * for cheap, coarse DERIVED coverage products (building footprints are
 * hundreds of pixels; ~31 world-units/texel on a 16K scene is already "an
 * order of magnitude finer than any footprint", mask-derive.js's own words).
 * A PAINTED mask is authored DETAIL — a flame lick, a thin water line — and
 * the smallest brush is only as fine as the grid: at 512 on a 12,000-wide
 * scene (a real scene size used elsewhere in this project), one texel is
 * ~23 world units, so no brush radius under that paints anything visibly
 * finer than a blob (author-reported, 2026-07-20: "the smallest paint/spray
 * size doesn't really work").
 *
 * 2048 (4x) brings that down to ~6 world units/texel on the same scene —
 * close to what a mouse-drawn brush can usefully resolve — while staying
 * cheap: worst case ~4MB of in-memory `Uint8Array` (irrelevant), and RLE on
 * a modest painted area (flat regions compress to ~2 numbers regardless of
 * resolution; only the painted EDGE gets costlier) stays well inside
 * `PAINT_EMBED_BYTE_BUDGET` for ordinary use — a mask detailed enough to
 * blow that budget is exactly the case Mode B (bake-to-file) exists for.
 * A chosen, documented number — not probed at runtime
 * (feedback_probed_constants_vs_derived).
 */
export const PAINT_GRID_MAX_DIM = 2048;

/**
 * A fresh, empty painted layer sized over the scene rect — a MaskGrid, so it
 * samples and composites through the exact same code as authored/derived masks.
 * @param {{x:number, y:number, width:number, height:number}} sceneRect
 * @param {number} [maxDim] - defaults to `PAINT_GRID_MAX_DIM`; pass the SAME
 *   value to `decodePaintLayer`/`hydratePaintedMasks` when decoding, or a
 *   real resolution change will be misreported as one (see those functions).
 * @returns {import('./mask-derive.js').MaskGrid}
 */
export function createPaintLayer(sceneRect, maxDim = PAINT_GRID_MAX_DIM) {
  return createMaskGrid(computeMaskGridSpec(sceneRect, maxDim));
}

/**
 * Stamp a soft round brush into a painted layer, in WORLD units.
 *
 * The brush stays circular in WORLD space even when texels are non-square
 * (a non-square scene grid), because distance is normalised per-axis by the
 * world radius before the falloff — a rectangular scene does not paint ovals.
 *
 * @param {import('./mask-derive.js').MaskGrid} layer
 * @param {number} wx @param {number} wy - brush centre, world coords (+Y down).
 * @param {number} radiusWorld - brush radius in world units.
 * @param {object} [opts]
 * @param {number} [opts.hardness=0.5] - 0 = fully soft, 1 = hard edge.
 * @param {number} [opts.value=255] - painted strength 0..255.
 * @param {'paint'|'add'|'erase'} [opts.mode='paint'] - paint = max-composite (a
 *   single dab never exceeds `value`); add = airbrush build-up (dabs accumulate,
 *   clamped at 255); erase = subtract.
 * @returns {import('./mask-derive.js').MaskGrid} the same layer, mutated.
 */
export function stampBrushWorld(layer, wx, wy, radiusWorld, { hardness = 0.5, value = 255, mode = 'paint' } = {}) {
  const { spec, data } = layer;
  // THE COVERAGE FLOOR — author-reported bug (2026-07-20): a thin dragged
  // line broke into dots, and the smallest brush sometimes painted nothing
  // at all. Root cause, derived exactly, not guessed: a texel's centre sits
  // at grid-coordinate k+0.5 for integer index k, so the worst-case offset
  // from a stamp's continuous centre to its NEAREST texel centre is 0.5 grid
  // units per axis (the stamp lands exactly on a texel boundary) — 0.5 in
  // BOTH axes at once (a grid corner) gives a worst-case normalized distance
  // of sqrt(0.5^2+0.5^2) = 1/sqrt(2) = Math.SQRT1_2 (~0.7071) once divided by
  // a brush radius of exactly that many texels. Below that radius, there
  // exist real sub-texel alignments where EVERY candidate texel fails the
  // `d < 1` test below — the stamp is a silent no-op — and that alignment
  // shifts continuously as the mouse moves, which is exactly what a dotted
  // line under a smooth drag looks like. Clamping the TEXEL-SPACE radius
  // (never the requested world radius, which stays whatever the author
  // asked for) to just above that exact threshold guarantees the nearest
  // texel is always included, on every alignment. Below this floor, "Size"
  // reliably paints one texel — the grid resolution (PAINT_GRID_MAX_DIM) IS
  // the real floor of paintable detail; it should never be a coin-flip.
  const MIN_STAMP_RADIUS_TEXELS = 0.75; // > Math.SQRT1_2 (~0.7071), margin for the exact-corner edge case
  const rTexX = Math.max(radiusWorld / spec.texelW, MIN_STAMP_RADIUS_TEXELS);
  const rTexY = Math.max(radiusWorld / spec.texelH, MIN_STAMP_RADIUS_TEXELS);
  const cgx = (wx - spec.x) / spec.texelW; // fractional centre cell
  const cgy = (wy - spec.y) / spec.texelH;
  const gx0 = Math.max(0, Math.floor(cgx - rTexX));
  const gx1 = Math.min(spec.w - 1, Math.ceil(cgx + rTexX));
  const gy0 = Math.max(0, Math.floor(cgy - rTexY));
  const gy1 = Math.min(spec.h - 1, Math.ceil(cgy + rTexY));
  const inner = Math.min(1, Math.max(0, hardness));

  for (let gy = gy0; gy <= gy1; gy++) {
    const ny = (gy + 0.5 - cgy) / rTexY;
    for (let gx = gx0; gx <= gx1; gx++) {
      const nx = (gx + 0.5 - cgx) / rTexX;
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d >= 1) continue;
      let f;
      if (inner >= 1 || d <= inner) f = 1;
      else {
        const t = (d - inner) / (1 - inner); // 0 at inner edge, 1 at rim
        f = 1 - t * t * (3 - 2 * t); // smoothstep falloff
      }
      const applied = Math.round(value * f);
      const i = gy * spec.w + gx;
      if (mode === 'erase') data[i] = Math.max(0, data[i] - applied);
      else if (mode === 'add')
        data[i] = Math.min(255, data[i] + applied); // airbrush build-up
      else data[i] = Math.max(data[i], applied); // 'paint': max-composite, a dab never exceeds `value`
    }
  }
  return layer;
}

/**
 * Rasterize a FILLED polygon (with optional holes) into a layer — the vector
 * equivalent of a brush fill, into the SAME MaskGrid, so a drawn polygon and a
 * painted region are one mask (Shapes-and-Regions.md §2). Even-odd scanline
 * fill: hole rings are just more loops in the crossing count, so a point inside
 * a hole comes out correctly OUTSIDE the fill with no special-casing. Vertices
 * are WORLD coords, mapped to cells with the identical formula the brush and
 * `sampleMaskGridWorld` use (the anti-Y-flip cross-check the suite pins).
 *
 * @param {import('./mask-derive.js').MaskGrid} layer
 * @param {Array<{x:number,y:number}>} vertices - outer ring, WORLD coords (≥3).
 * @param {object} [opts]
 * @param {number} [opts.value=255]
 * @param {'paint'|'add'|'erase'} [opts.mode='paint']
 * @param {Array<Array<{x:number,y:number}>>} [opts.holes] - hole rings, WORLD coords.
 * @returns {import('./mask-derive.js').MaskGrid} the same layer, mutated.
 */
export function rasterizePolygon(layer, vertices, { value = 255, mode = 'paint', holes = [] } = {}) {
  if (!Array.isArray(vertices) || vertices.length < 3) return layer;
  const { spec, data } = layer;
  const toCell = (p) => ({ gx: (p.x - spec.x) / spec.texelW, gy: (p.y - spec.y) / spec.texelH });
  const loops = [vertices, ...holes].map((loop) => loop.map(toCell));

  let minGy = Infinity;
  let maxGy = -Infinity;
  for (const loop of loops)
    for (const p of loop) {
      if (p.gy < minGy) minGy = p.gy;
      if (p.gy > maxGy) maxGy = p.gy;
    }
  const gy0 = Math.max(0, Math.floor(minGy));
  const gy1 = Math.min(spec.h - 1, Math.ceil(maxGy));

  const apply = (i) => {
    if (mode === 'erase') data[i] = Math.max(0, data[i] - value);
    else if (mode === 'add') data[i] = Math.min(255, data[i] + value);
    else data[i] = Math.max(data[i], value);
  };

  const xs = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    const sy = gy + 0.5; // sample at the row's texel centre
    xs.length = 0;
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        // Half-open crossing test: each edge counted once, vertices never double-counted.
        if ((a.gy <= sy && b.gy > sy) || (b.gy <= sy && a.gy > sy)) {
          xs.push(a.gx + ((sy - a.gy) / (b.gy - a.gy)) * (b.gx - a.gx));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // A cell gx is inside iff its centre (gx+0.5) lies within the span.
      const xStart = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xEnd = Math.min(spec.w - 1, Math.floor(xs[k + 1] - 0.5));
      const rowBase = gy * spec.w;
      for (let gx = xStart; gx <= xEnd; gx++) apply(rowBase + gx);
    }
  }
  return layer;
}

/**
 * Rasterize a STROKED polyline (a line of a given world width) into a layer —
 * "draw a line of fire OR paint a line of fire, either way fire across the
 * whole thing" (author, 2026-07-20). Implemented by walking the segments and
 * stamping the round brush along them, so it reuses `stampBrushWorld` verbatim
 * (including its sub-texel coverage floor — a thin line never breaks into dots).
 *
 * @param {import('./mask-derive.js').MaskGrid} layer
 * @param {Array<{x:number,y:number}>} vertices - WORLD coords (≥1).
 * @param {number} widthWorld - stroke width in world units.
 * @param {object} [opts]
 * @param {number} [opts.value=255]
 * @param {'paint'|'add'|'erase'} [opts.mode='paint']
 * @param {number} [opts.hardness=1] - 1 = a crisp solid stroke (the default for a line).
 * @returns {import('./mask-derive.js').MaskGrid} the same layer, mutated.
 */
export function rasterizeStrokedLine(layer, vertices, widthWorld, { value = 255, mode = 'paint', hardness = 1 } = {}) {
  if (!Array.isArray(vertices) || vertices.length < 1) return layer;
  const radius = Math.max(1e-6, widthWorld / 2);
  const stamp = (x, y) => stampBrushWorld(layer, x, y, radius, { value, mode, hardness });
  stamp(vertices[0].x, vertices[0].y);
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const spacing = Math.max(radius * 0.4, 1e-3); // fine enough that dabs overlap into a solid stroke
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      stamp(a.x + dx * t, a.y + dy * t);
    }
  }
  return layer;
}

/** True if any texel is painted — used to skip storing an untouched layer. */
export function isPaintLayerEmpty(layer) {
  const d = layer.data;
  for (let i = 0; i < d.length; i++) if (d[i] > 0) return false;
  return true;
}

/**
 * RLE-encode a layer into a JSON-native payload. Masks are sparse, so the
 * run-length pairs stay small; no base64 is used, so the payload is portable
 * (Node + browser) and human-inspectable in a flag dump.
 * @param {import('./mask-derive.js').MaskGrid} layer
 * @returns {{w:number, h:number, rle:number[]}}
 */
export function encodePaintLayer(layer) {
  const { spec, data } = layer;
  const rle = [];
  let i = 0;
  while (i < data.length) {
    const v = data[i];
    let run = 1;
    while (i + run < data.length && data[i + run] === v && run < 65535) run++;
    rle.push(v, run);
    i += run;
  }
  return { w: spec.w, h: spec.h, rle };
}

/**
 * Decode an RLE payload back into a layer. The spec is rebuilt from the live
 * `sceneRect` (so world↔cell mapping matches the current scene) when supplied;
 * a payload whose stored `w×h` disagrees with the current scene rect is a
 * resolution change — the caller is told via `dimensionsMatch` rather than
 * silently stretched.
 * @param {{w:number, h:number, rle:number[]}} encoded
 * @param {{x:number, y:number, width:number, height:number}} [sceneRect]
 * @param {number} [maxDim] - MUST match what `createPaintLayer` used to
 *   encode this payload (defaults to `PAINT_GRID_MAX_DIM`, same as
 *   `createPaintLayer`'s default) — a mismatched maxDim here would rebuild
 *   the comparison spec at the WRONG resolution and report every ordinary
 *   load as a false "scene resized" (a real bug this project shipped once:
 *   this parameter used to be silently absent and always compared against
 *   mask-derive's unrelated 512 default).
 * @returns {{layer: import('./mask-derive.js').MaskGrid, dimensionsMatch: boolean}}
 */
export function decodePaintLayer(encoded, sceneRect, maxDim = PAINT_GRID_MAX_DIM) {
  const { w, h, rle } = encoded;
  const data = new Uint8Array(w * h);
  let di = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const v = rle[i];
    const run = rle[i + 1];
    for (let k = 0; k < run && di < data.length; k++) data[di++] = v;
  }
  let spec;
  let dimensionsMatch = true;
  if (sceneRect) {
    spec = computeMaskGridSpec(sceneRect, maxDim);
    dimensionsMatch = spec.w === w && spec.h === h;
    if (!dimensionsMatch)
      spec = {
        x: sceneRect.x,
        y: sceneRect.y,
        width: sceneRect.width,
        height: sceneRect.height,
        w,
        h,
        texelW: sceneRect.width / w,
        texelH: sceneRect.height / h,
      };
  } else {
    spec = { x: 0, y: 0, width: w, height: h, w, h, texelW: 1, texelH: 1 };
  }
  return { layer: { spec, data }, dimensionsMatch };
}

/** Estimated JSON byte size of an encoded layer — checked against PAINT_EMBED_BYTE_BUDGET. */
export function encodedByteEstimate(encoded) {
  return JSON.stringify(encoded).length;
}

/**
 * Serialize a set of painted layers into the scene-flag payload. Keyed
 * `"<kind>::<floorIndex>"` (e.g. `"fire::0"`). Empty (unpainted) layers are
 * dropped — nothing untouched is stored, mirroring params persistence's
 * store-only-what-differs (Params.md §3.4).
 * @param {Record<string, import('./mask-derive.js').MaskGrid>} layersByKey
 * @returns {Record<string, {w:number, h:number, rle:number[]}>}
 */
export function serializePaintedMasks(layersByKey) {
  const out = {};
  for (const [key, layer] of Object.entries(layersByKey || {})) {
    if (!layer || isPaintLayerEmpty(layer)) continue;
    out[key] = encodePaintLayer(layer);
  }
  return out;
}

/**
 * Rehydrate painted layers from a scene-flag payload against the live scene rect.
 * Reports any layer whose stored resolution no longer matches (a scene resized
 * since it was painted) rather than silently rescaling.
 * @param {Record<string, {w:number, h:number, rle:number[]}>} payload
 * @param {{x:number, y:number, width:number, height:number}} sceneRect
 * @param {number} [maxDim] - see `decodePaintLayer`'s note; defaults consistently.
 * @returns {{layers: Record<string, import('./mask-derive.js').MaskGrid>, mismatched: string[]}}
 */
export function hydratePaintedMasks(payload, sceneRect, maxDim = PAINT_GRID_MAX_DIM) {
  const layers = {};
  const mismatched = [];
  for (const [key, enc] of Object.entries(payload || {})) {
    const { layer, dimensionsMatch } = decodePaintLayer(enc, sceneRect, maxDim);
    layers[key] = layer;
    if (!dimensionsMatch) mismatched.push(key);
  }
  return { layers, mismatched };
}

/** Re-export so a painted layer can be sampled through the authority's own reader. */
export { sampleMaskGridWorld };
