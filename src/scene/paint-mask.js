/**
 * PAINT MASK — the pure model + codec for MSA-painted effect masks.
 *
 * ============================================================================
 * WHAT A PAINTED MASK IS (and why it costs almost nothing new)
 * ============================================================================
 *
 * A painted mask is a `MaskGrid` (scene/mask-derive.js) sized over the scene
 * rect: the SAME fixed ≤512² Uint8 grid the mask authority already uses for
 * its derived products. So a mask the user PAINTS in MSA and a `_Fire` mask the
 * author makes in PHOTOSHOP and drops beside the map are the same shape of
 * thing — peers, not two systems. That is the author's "belts and braces": some
 * effects driven by a bundled `_Suffix` file, some painted in-app, both valid,
 * both travelling with the scene (docs/planning/Authoring-and-Distribution.md).
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
 * A fresh, empty painted layer sized over the scene rect — a MaskGrid, so it
 * samples and composites through the exact same code as authored/derived masks.
 * @param {{x:number, y:number, width:number, height:number}} sceneRect
 * @returns {import('./mask-derive.js').MaskGrid}
 */
export function createPaintLayer(sceneRect) {
  return createMaskGrid(computeMaskGridSpec(sceneRect));
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
  const rTexX = Math.max(1e-6, radiusWorld / spec.texelW);
  const rTexY = Math.max(1e-6, radiusWorld / spec.texelH);
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
 * @returns {{layer: import('./mask-derive.js').MaskGrid, dimensionsMatch: boolean}}
 */
export function decodePaintLayer(encoded, sceneRect) {
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
    spec = computeMaskGridSpec(sceneRect);
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
 * @returns {{layers: Record<string, import('./mask-derive.js').MaskGrid>, mismatched: string[]}}
 */
export function hydratePaintedMasks(payload, sceneRect) {
  const layers = {};
  const mismatched = [];
  for (const [key, enc] of Object.entries(payload || {})) {
    const { layer, dimensionsMatch } = decodePaintLayer(enc, sceneRect);
    layers[key] = layer;
    if (!dimensionsMatch) mismatched.push(key);
  }
  return { layers, mismatched };
}

/** Re-export so a painted layer can be sampled through the authority's own reader. */
export { sampleMaskGridWorld };
