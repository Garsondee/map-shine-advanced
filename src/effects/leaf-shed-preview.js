/**
 * LEAF SHED — THE DESIGN PREVIEWS: each droppable design drawn on the CPU with the shader's own shape
 * builders (`leaf-shed-shape.js` evaluated through `leaf-shed-shim.js`), at the current dial settings.
 *
 * The Studio card shows these as toggle buttons — which designs may drop on this map — that redraw as the
 * Leaves / Outline / Twigs sliders move (the author, 2026-10-31). Pure: no DOM, no THREE; the card runs it
 * in a worker (`leaf-shed-preview.worker.js`) so a slider drag never stalls the page.
 *
 * @module effects/leaf-shed-preview
 */

import { SHIM, shimNumbers } from './leaf-shed-shim.js';
import { buildShedLook, shedCoverage, SHAPE_KNOB_DEFAULTS, BROAD_FORM_KNOBS } from './leaf-shed-shape.js';
import { DEFAULT_TWIG_SRGB } from './leaf-shed-sources.js';

/**
 * Every design a map can allow or forbid, in the order the card shows them. `param` is the Studio toggle.
 * `form` indexes `BROAD_LEAF_FORM_NAMES` for the broad leaves.
 */
export const SHED_DESIGNS = Object.freeze([
  Object.freeze({ id: 'leaf', label: 'Pointed leaf', kind: 0, param: 'dropLeaf' }),
  Object.freeze({ id: 'palmate', label: 'Maple', kind: 1, form: 0, param: 'dropPalmate' }),
  Object.freeze({ id: 'trifoliate', label: 'Trefoil', kind: 1, form: 1, param: 'dropTrifoliate' }),
  Object.freeze({ id: 'cordate', label: 'Heart', kind: 1, form: 2, param: 'dropCordate' }),
  Object.freeze({ id: 'hastate', label: 'Spear', kind: 1, form: 3, param: 'dropHastate' }),
  Object.freeze({ id: 'serrated', label: 'Toothed', kind: 1, form: 4, param: 'dropSerrated' }),
  Object.freeze({ id: 'twig', label: 'Twig', kind: 2, param: 'dropTwig' }),
]);

/** A leaf green and the author's bark, for drawing a design without a map under it (straight sRGB 0..1). */
const PREVIEW_GREEN = [0.36, 0.6, 0.24];
const PREVIEW_BARK = DEFAULT_TWIG_SRGB.map((c) => c / 255);
/** Each design's dice: a typical one of its kind (the map gives every leaf its own). */
const PREVIEW_DICE = [
  [0.55, 0.45, 0.6, 0.4],
  [0.5, 0.5, 0.5, 0.5],
  [0.37, 0.61, 0.52, 0.7],
];

/** The design's length next to a plain leaf, as the shedding side sizes it (`leaf-shed-sources.js#makeBirth`). */
function kindSize(design, p) {
  if (design.kind === 2) return 2.6 * (p.twigSize ?? 1);
  if (design.kind === 1) return 1.45 * (p.broadLeafSize ?? 1);
  return 1;
}

/**
 * Draw one design.
 * @param {string} designId - one of {@link SHED_DESIGNS}' ids.
 * @param {object} params - resolved LEAF_SHED_PARAMS (missing keys take their defaults).
 * @param {number} [size] - the square tile, px.
 * @returns {Uint8ClampedArray} RGBA, straight alpha, `size × size`.
 */
export function renderShedPreview(designId, params = {}, size = 56) {
  const design = SHED_DESIGNS.find((d) => d.id === designId) ?? SHED_DESIGNS[0];
  const S = SHIM;
  const knobs = {};
  for (const [k, def] of Object.entries(SHAPE_KNOB_DEFAULTS)) knobs[k] = S.float(Number.isFinite(params[k]) ? params[k] : def);
  BROAD_FORM_KNOBS.forEach((k, i) => (knobs[k] = S.float(design.form === i ? 1 : 0)));
  const ls = Number.isFinite(params.leafSize) ? params.leafSize : 1;
  const outline = Number.isFinite(params.outline) ? params.outline : 1;
  // The runtime's own width: outline × 0.021 grid × max(0.6, size), over half the body's length.
  const inkW = (outline * 0.021 * Math.max(0.6, ls)) / (0.11 * ls * kindSize(design, params));
  const rgb = design.kind === 2 ? PREVIEW_BARK : PREVIEW_GREEN;
  const dice = PREVIEW_DICE[design.kind];
  // The design lies on the diagonal, tip up-right, filling the tile.
  const unitsAcross = design.kind === 2 ? 2.25 : 2.35;
  const pxPerUnit = size / unitsAcross;
  const ang = -0.75;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const out = new Uint8ClampedArray(size * size * 4);
  const aa = S.float(1 / pxPerUnit);
  const kindN = S.float(design.kind);
  const flipN = S.float(0);
  const rgbN = S.vec3(rgb[0], rgb[1], rgb[2]);
  const inkN = S.float(inkW);
  const lightN = S.float(1);
  // A pixel well clear of the body (past the brush's widest wobble) is skipped on the cheap distance alone —
  // most of a tile is empty, and the full look costs several times the distance.
  const noise = Number.isFinite(params.outlineNoise) ? params.outlineNoise : 1;
  const marginN = S.float(1.5 / pxPerUnit + 0.6 * inkW * Math.max(1, noise * 1.25));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const qx = (x + 0.5 - size / 2) / pxPerUnit;
      const qy = (y + 0.5 - size / 2) / pxPerUnit;
      const u = qx * ca - qy * sa;
      const v = qx * sa + qy * ca;
      const pN = S.vec2(u, v);
      if (shimNumbers(shedCoverage(S, pN, kindN, flipN, marginN, dice, knobs))[0] <= 0) continue;
      const look = buildShedLook(S, {
        p: pN,
        aa,
        kind: kindN,
        flip: flipN,
        rgb: rgbN,
        inkW: inkN,
        lightSide: lightN,
        rnd: dice,
        knobs,
      });
      const a = shimNumbers(look.alpha)[0];
      if (!(a > 0.002)) continue;
      const c = shimNumbers(look.rgb);
      const o = (y * size + x) * 4;
      out[o] = c[0] * 255;
      out[o + 1] = c[1] * 255;
      out[o + 2] = c[2] * 255;
      out[o + 3] = Math.min(1, a) * 255;
    }
  }
  return out;
}
