/**
 * HOW BIG IS A PIXEL, REALLY — the one conversion from a Foundry scene's own
 * grid to real-world metres.
 *
 * ============================================================================
 * ⚠️ WHY THIS EXISTS: `distancePixels` IS NOT PIXELS PER METRE
 * ============================================================================
 * `canvas.dimensions.distancePixels` is pixels per ONE UNIT OF THE SCENE'S OWN
 * DISTANCE MEASURE — per FOOT on a scene authored in feet, per metre on one
 * authored in metres, per whatever `grid.units` says. Verified against this
 * project's vendored Foundry v14 source rather than assumed:
 * `client/canvas/placeables/light.mjs:110` computes a light's pixel radius as
 * `this.config.dim * canvas.dimensions.distancePixels`, where `config.dim` is
 * authored in scene distance units — so `distancePixels` carries the unit, not
 * metres.
 *
 * Two places in this codebase disagreed about that, which is the bug
 * mythica-machina-press#485 hit and could not resolve:
 *
 *   - `vt/vt-pan-viewer.js` passed `distancePixels` STRAIGHT IN as
 *     `getPxPerMeter` — wrong by a factor of `metresPerDistanceUnit` (≈3.28×
 *     on a feet-authored scene, which is nearly every real map).
 *   - `boot.js#getFireRenderState` did convert (`feetPerSquare * 0.3048 /
 *     pxPerSquare`) but hardcoded FEET, so a metre-authored scene came out
 *     3.28× the other way.
 *
 * #485's own audit recorded the consequence: `pxPerMeter` "could plausibly be
 * anywhere from ~20 to ~100 depending on the scene's own grid setup", which is
 * what made fire's wind push unverifiable and forced it to self-scale to its
 * sprite size instead. This module is that constant made verifiable.
 *
 * PURE — no Foundry, no canvas, no THREE. The caller reads
 * `scene.grid.{size,distance,units}` and passes plain numbers/strings in, so
 * the conversion is Node-tested independently of ever having a live scene.
 *
 * @module core/scene-scale
 */

/**
 * Real metres per one unit of a scene's distance measure.
 *
 * `grid.units` is FREE TEXT in Foundry — a GM types it — so this matches on a
 * normalised form (lowercased, trimmed, trailing period dropped) and accepts
 * the spellings that actually turn up on real maps rather than one canonical
 * token per unit. Anything unrecognised returns `null`, which the caller turns
 * into an explicit "assumed" reading rather than a silent wrong number.
 */
const METRES_PER_UNIT = Object.freeze({
  ft: 0.3048,
  foot: 0.3048,
  feet: 0.3048,
  "'": 0.3048,
  in: 0.0254,
  inch: 0.0254,
  inches: 0.0254,
  '"': 0.0254,
  yd: 0.9144,
  yds: 0.9144,
  yard: 0.9144,
  yards: 0.9144,
  m: 1,
  meter: 1,
  meters: 1,
  metre: 1,
  metres: 1,
  km: 1000,
  kilometer: 1000,
  kilometers: 1000,
  kilometre: 1000,
  kilometres: 1000,
  mi: 1609.344,
  mile: 1609.344,
  miles: 1609.344,
});

/**
 * The fallback assumption when a scene's units are unreadable: the standard
 * D&D 5 ft square. Matches `boot.js#getFireRenderState`'s own long-standing
 * `?? 5` fallback, deliberately — a fallback that disagrees with the one
 * already shipping would just be a third answer.
 */
export const ASSUMED_DISTANCE_PER_SQUARE = 5;
export const ASSUMED_METRES_PER_UNIT = 0.3048; // feet

/**
 * @param {string} units - `scene.grid.units`, free text.
 * @returns {number|null} metres per unit, or null if unrecognised.
 */
export function metresPerDistanceUnit(units) {
  if (typeof units !== 'string') return null;
  const key = units.trim().toLowerCase().replace(/\.$/, '');
  if (key === '') return null;
  return METRES_PER_UNIT[key] ?? null;
}

/**
 * ⭐ PIXELS PER REAL METRE, from a scene's own grid.
 *
 * `gridSizePixels / gridDistance` is pixels per distance UNIT (Foundry's own
 * `distancePixels`); dividing by metres-per-unit converts it to pixels per
 * metre. Both steps are needed — dropping either is exactly how the two
 * disagreeing derivations described in this module's header came about.
 *
 * NEVER THROWS AND NEVER RETURNS A SILENT GUESS. When the scene cannot answer
 * (no grid, a nonsense distance, a unit nobody recognises), this falls back to
 * the standard 5 ft square AND says so via `ok:false` + `reason`, so a caller
 * that cares can log it and a probe can report it honestly rather than
 * presenting an assumption as a measurement (`feedback_instruments_must_not_lie`).
 *
 * @param {object} grid
 * @param {number} grid.gridSizePixels - `scene.grid.size`, px per square.
 * @param {number} grid.gridDistance - `scene.grid.distance`, units per square.
 * @param {string} grid.gridUnits - `scene.grid.units`, e.g. "ft".
 * @returns {{pixelsPerMetre: number, ok: boolean, reason: string|null,
 *   metresPerUnit: number, pixelsPerDistanceUnit: number}}
 */
export function derivePixelsPerMetre({ gridSizePixels, gridDistance, gridUnits } = {}) {
  const reasons = [];

  const sizePx = Number(gridSizePixels);
  const validSize = Number.isFinite(sizePx) && sizePx > 0;
  if (!validSize) reasons.push(`grid.size is not a positive number (${gridSizePixels})`);
  const pxPerSquare = validSize ? sizePx : 100;

  const distance = Number(gridDistance);
  const validDistance = Number.isFinite(distance) && distance > 0;
  if (!validDistance) reasons.push(`grid.distance is not a positive number (${gridDistance})`);
  const distancePerSquare = validDistance ? distance : ASSUMED_DISTANCE_PER_SQUARE;

  const resolvedMetresPerUnit = metresPerDistanceUnit(gridUnits);
  if (resolvedMetresPerUnit === null) {
    reasons.push(`grid.units "${gridUnits}" is not a recognised length — assuming feet`);
  }
  const metresPerUnit = resolvedMetresPerUnit ?? ASSUMED_METRES_PER_UNIT;

  const pixelsPerDistanceUnit = pxPerSquare / distancePerSquare;
  return {
    pixelsPerMetre: pixelsPerDistanceUnit / metresPerUnit,
    ok: reasons.length === 0,
    reason: reasons.length === 0 ? null : reasons.join('; '),
    metresPerUnit,
    // Foundry's own `distancePixels`, recomputed here so a caller can see both
    // numbers side by side — the whole confusion this module ends is that they
    // are different quantities that look interchangeable.
    pixelsPerDistanceUnit,
  };
}
