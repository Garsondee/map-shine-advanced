/**
 * THE LIGHT METER — how bright the scene's LIGHT is, in stops, as numbers (mmp-dpw.10).
 *
 * WHY: every lighting change so far was judged screenshot against screenshot. "Balanced"
 * had no number, so two rounds could disagree forever. This turns the picture into figures
 * anyone can compare: how much of the view sits in each band of brightness, how much is
 * crushed to black or blown past white, where the median light is.
 *
 * INPUT is the Dynamic Range meter grid (effects/dynamic-range-render.js): one cell per
 * patch of the screen, R = mean luminance of scene.lit (the finished linear picture, before
 * the present pass's tone curve), G = mean luminance of scene.illum (the light alone). Cells
 * outside the map read exactly 0 and are left out.
 *
 * STOPS: EV = log2(illum). 0 EV is an illum of 1.0, which is full outdoor daylight in MSA's
 * scale (noon measured ~0.93, auto-exposure-2026-11-04). Each stop is a doubling.
 *
 * Pure: arrays in, plain objects out. The live adapter (vt) reads the grid; the overlay
 * (diag/light-meter-overlay.js) paints `falseColour` per cell.
 *
 * @module diag/light-meter
 */

/**
 * The false-colour bands, darkest first. `max` is the upper EV edge (exclusive); the last band
 * is open-ended. Colours follow the camera-world convention: blue/purple dark, green middle,
 * yellow/orange bright, red blown.
 */
export const LIGHT_METER_BANDS = Object.freeze([
  Object.freeze({ id: 'crushed', label: 'below -7 EV (black)', max: -7, rgb: [20, 0, 30] }),
  Object.freeze({ id: 'deep', label: '-7 to -5 EV', max: -5, rgb: [80, 20, 140] }),
  Object.freeze({ id: 'dark', label: '-5 to -3 EV', max: -3, rgb: [30, 60, 200] }),
  Object.freeze({ id: 'dim', label: '-3 to -2 EV', max: -2, rgb: [0, 160, 200] }),
  Object.freeze({ id: 'low', label: '-2 to -1 EV', max: -1, rgb: [0, 180, 90] }),
  Object.freeze({ id: 'mid', label: '-1 to 0 EV (daylight)', max: 0, rgb: [120, 210, 40] }),
  Object.freeze({ id: 'bright', label: '0 to +1 EV', max: 1, rgb: [240, 220, 0] }),
  Object.freeze({ id: 'hot', label: '+1 to +2 EV', max: 2, rgb: [255, 140, 0] }),
  Object.freeze({ id: 'blown', label: 'above +2 EV', max: Infinity, rgb: [230, 20, 20] }),
]);

/** Below this illum a cell counts as no light at all (log2 would run away). */
export const ILLUM_FLOOR = 1 / 1024;

/** @param {number} illum @returns {number} EV, floored */
export function illumToEv(illum) {
  return Math.log2(Math.max(ILLUM_FLOOR, illum));
}

/** @param {number} ev @returns {number} index into LIGHT_METER_BANDS */
export function bandIndexForEv(ev) {
  for (let i = 0; i < LIGHT_METER_BANDS.length; i++) if (ev < LIGHT_METER_BANDS[i].max) return i;
  return LIGHT_METER_BANDS.length - 1;
}

/** Percentile of a SORTED array (nearest rank). */
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

/**
 * Statistics of one meter grid.
 * @param {ArrayLike<number>} px RGBA floats, row-major, `w*h*4`
 * @param {number} w @param {number} h
 * @returns {{cells:number, evMedian:number|null, evP5:number|null, evP95:number|null,
 *   litMedian:number|null, bands: {id:string,label:string,share:number}[],
 *   crushedShare:number, blownShare:number, overWhiteShare:number, perCellEv:(number|null)[]}}
 */
export function lightMeterStats(px, w, h) {
  const evs = [];
  const lits = [];
  const perCellEv = new Array(w * h).fill(null);
  let overWhite = 0;
  const counts = new Array(LIGHT_METER_BANDS.length).fill(0);
  for (let i = 0; i < w * h; i++) {
    const lit = px[i * 4];
    const ill = px[i * 4 + 1];
    if (!(lit > 0) && !(ill > 0)) continue; // outside the map
    const ev = illumToEv(ill);
    perCellEv[i] = ev;
    evs.push(ev);
    lits.push(lit);
    counts[bandIndexForEv(ev)]++;
    if (lit >= 1) overWhite++;
  }
  const n = evs.length;
  evs.sort((a, b) => a - b);
  lits.sort((a, b) => a - b);
  const share = (c) => (n ? Math.round((c / n) * 1000) / 1000 : 0);
  return {
    cells: n,
    evMedian: r2(pct(evs, 50)),
    evP5: r2(pct(evs, 5)),
    evP95: r2(pct(evs, 95)),
    litMedian: r2(pct(lits, 50)),
    bands: LIGHT_METER_BANDS.map((b, i) => ({ id: b.id, label: b.label, share: share(counts[i]) })),
    crushedShare: share(counts[0]),
    blownShare: share(counts[LIGHT_METER_BANDS.length - 1]),
    overWhiteShare: share(overWhite),
    perCellEv,
  };
}

/**
 * RGBA bytes for the overlay: one pixel per meter cell, alpha 0 outside the map.
 * @param {(number|null)[]} perCellEv @param {number} alpha 0..255
 * @returns {Uint8ClampedArray}
 */
export function falseColourPixels(perCellEv, alpha = 170) {
  const out = new Uint8ClampedArray(perCellEv.length * 4);
  perCellEv.forEach((ev, i) => {
    if (ev === null) return;
    const [r, g, b] = LIGHT_METER_BANDS[bandIndexForEv(ev)].rgb;
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = alpha;
  });
  return out;
}
