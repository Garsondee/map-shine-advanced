/**
 * THE SHADOW BAND PLAN — how tall is the stack above this floor, really.
 * Plan of record: `docs/planning/Sun-Shadow-Cascade.md`.
 *
 * ============================================================================
 * THE GAP THIS CLOSES
 * ============================================================================
 * Author, 2026-08-05: *"buildings which are several stories tall might cast
 * their building, sky reach and overhead shadows and have a much longer larger
 * shadow produced as a result of having access to the information for all
 * floors… allows the black part of _Outdoors to cast a shadow downwards into
 * the zero opacity gaps in the scene and have them cascade downwards until
 * they hit a solid albedo surface."*
 *
 * The layer-smear model (`layer-smear.js`) already casts a shadow from
 * everything above a floor — but it did so from ONE silhouette (`coverAbove`,
 * every floor above merged) at ONE **authored** height (`aboveHeightPx`, a
 * slider). So a two-storey wing and a five-storey tower threw shadows of
 * exactly the same length, and no amount of extra floors ever made a shadow
 * longer. `effects/sun-shadows.js`'s own header already named this as a
 * simplification awaiting real elevation data:
 *
 *   > heights for overhead tiles and the floor above were meant to come from
 *   > Foundry's own elevation data … that derivation is not built yet
 *
 * This module is that derivation.
 *
 * ============================================================================
 * THE DECOMPOSITION — cumulative bands, NOT per-floor silhouettes
 * ============================================================================
 * `mask-derive.js` already produces, per floor F, a `coverAbove` grid: the
 * union of every item's art alpha at or above floor F's own ceiling. Read
 * across floors that is already a **nested ladder**:
 *
 *   coverAbove(F)   = art of floors F+1, F+2, …   (the widest silhouette)
 *   coverAbove(F+1) = art of floors F+2, …        (a subset of the above)
 *   coverAbove(F+2) = art of floors F+3, …        (a subset of that)
 *
 * so band `k` for a receiver on floor F is simply `coverAbove(F+k)` — a grid
 * that ALREADY EXISTS, for a floor the mask authority ALREADY derives. No new
 * mask product, no new derivation pass, no second texture upload: the bands
 * are three existing grids read at three existing floor indices.
 *
 * **Each band carries the elevation of its LOWEST member**, because its taller
 * members are already covered — more narrowly, and therefore more correctly —
 * by the next band up. A setback (a wide second storey under a narrow tower)
 * falls out for free: the wide part sits only in band 0 and throws band 0's
 * short shadow; the tower sits in both and `max` picks band 1's long one.
 *
 * ⚠️ THE LAST BAND MUST ABSORB EVERYTHING ABOVE IT, so it carries the TOP of
 * the stack rather than its own lowest member. With {@link SHADOW_BAND_COUNT}
 * bands and more floors than that above the receiver, the last band therefore
 * OVER-estimates its lowest members by the height of the floors it swallowed.
 * That is a deliberate direction to err in: the author's ask is explicitly
 * "much longer", the alternative (carry the lowest member and lose the top)
 * silently truncates a skyscraper to two storeys, and `feedback_silent_cap_
 * corrupts_hard_boundary`'s lesson is that a cap must be visible — so
 * {@link resolveShadowBandPlan} reports `mergedFloorsAbove` rather than
 * quietly rounding.
 *
 * ============================================================================
 * WHY ELEVATION → PIXELS IS A READ, NEVER A GUESS
 * ============================================================================
 * Foundry elevation is in GRID DISTANCE UNITS (feet, usually), and every
 * height in the smear model is in WORLD PIXELS. The conversion is Foundry's
 * own `canvas.dimensions.distancePixels`, which
 * `foundry/scene-occlusion-sources.js#readGridDistancePixels` already reads
 * verbatim for the light-radius formula — the same number, read from the same
 * place, never re-derived from `grid.size / grid.distance`
 * ([[feedback_read_the_producer_never_invent_its_shape]]).
 *
 * A sanity check worth keeping, because it is the reason this derivation was
 * trusted enough to replace a hand-tuned slider: the author's own River Town
 * Bridge map bands its three floors 0-20 / 20-40 / 40-∞ at Foundry's default
 * 100px/5ft grid, i.e. 20 px per elevation unit — so ONE storey is exactly
 * 400 world px, and `aboveHeightPx`'s hand-tuned default was ALSO exactly 400.
 * The derivation reproduces the number the author arrived at by eye, on their
 * own map, before it existed.
 *
 * @module effects/lighting/shadow-bands
 */

/**
 * How many cumulative bands the stack above a receiver is split into — the B
 * and A channels of the layer texture (`layer-smear-render.js`'s own packing
 * header). A hard, stated bound rather than an open-ended list, for the same
 * reason `SHADOW_LAYER_COUNT` is one: the packing is ONE RGBA texture, and
 * growing past it costs a whole second upload per floor slot.
 *
 * Two bands resolve a THREE-storey stack exactly (band 0 = the first floor
 * above at its own elevation, band 1 = everything higher at the stack's top),
 * which is the shape of every multi-floor scene this project has shadowed.
 * Beyond that the last band merges — see this module's own header.
 */
export const SHADOW_BAND_COUNT = 2;

/** Which layer index each band occupies in `layer-smear.js`'s 4-layer stack —
 * exported so the subsystem, the shader and the debug view all index the same
 * two slots rather than three files agreeing by coincidence. */
export const SHADOW_BAND_LAYER_INDICES = Object.freeze([2, 3]);

/**
 * A plan with nothing in it — every band off. Returned whenever the scene
 * cannot answer the elevation question AND no fallback height was offered, so
 * a caller never has to distinguish "no plan" from "a plan of zeroes": zero
 * height is already this model's own OFF switch (`layerThrowPx` returns 0, the
 * station loop contributes nothing, the transmittance factor is exactly 1).
 */
const EMPTY_BANDS = Object.freeze([0, 0]);

/**
 * Read one floor's own bottom elevation, in Foundry distance units.
 *
 * ⚠️ `null` IS NOT `0`. `getActiveSceneFloors` returns `elevationBottom: null`
 * for a floor with no authored elevation (and for the legacy single-background
 * fallback, which has no Level document at all) — a genuinely unknown value,
 * not a floor at ground level ([[feedback_derived_zero_collides_with_
 * configured_zero]]). Treating it as 0 would make a real upper floor read as
 * being at the same height as the ground and cast nothing at all.
 *
 * @param {{elevationBottom?: number|null}} floor
 * @returns {number|null}
 */
function bottomElevationOf(floor) {
  const v = floor?.elevationBottom;
  return Number.isFinite(v) ? v : null;
}

/**
 * The elevation of the TOP of the whole stack — what the last band carries.
 *
 * Foundry's `Level.elevation.top` is a real, separate, authored field
 * (`common/documents/level.mjs`, schema default 20), and
 * `foundry/active-scene-source.js` already reads it verbatim. When the topmost
 * floor declares one, THAT is the answer and nothing is invented. When it does
 * not (Foundry's own "+Infinity" convention for an unbounded top floor — the
 * author's own bridge map bands its roof `40-∞`), the only honest stand-in is
 * the one height in this whole system that has no scene-data source anyway:
 * the authored wall height, converted back into elevation units.
 *
 * @param {object} topFloor
 * @param {number} topBottomElev
 * @param {number} wallHeightPx
 * @param {number} pxPerElevationUnit
 * @returns {{elevation: number, source: 'elevationTop'|'wallHeight'}}
 */
function resolveTopOfStack(topFloor, topBottomElev, wallHeightPx, pxPerElevationUnit) {
  const declared = topFloor?.elevationTop;
  // `> topBottomElev`, not merely finite: a degenerate band whose top equals
  // (or sits below) its own bottom would hand the last band a height of zero
  // and silently switch the tallest shadow in the scene OFF.
  if (Number.isFinite(declared) && declared > topBottomElev) {
    return { elevation: declared, source: 'elevationTop' };
  }
  const wallElev = wallHeightPx > 0 ? wallHeightPx / pxPerElevationUnit : 0;
  return { elevation: topBottomElev + wallElev, source: 'wallHeight' };
}

/**
 * Resolve the per-band occluder heights for ONE receiver floor.
 *
 * PURE + TOTAL: every degenerate scene (one floor, no elevations, a
 * non-finite grid scale, a receiver index off the end) resolves to a stated
 * `source`/`reason` and a usable height array, never `undefined` and never a
 * throw — this runs inside a bake, and a bake that throws is a black map.
 *
 * @param {object} args
 * @param {Array<{index?: number, elevationBottom?: number|null, elevationTop?: number|null}>|null} args.floors -
 *   `getActiveSceneFloors().floors`, ASCENDING by elevation (that function
 *   sorts them itself — this module relies on that order and does not re-sort,
 *   [[feedback_read_the_producer_never_invent_its_shape]]).
 * @param {number} args.receiverFloorIndex - the floor whose field is being baked.
 * @param {number} args.pxPerElevationUnit - `readGridDistancePixels().distancePixels`.
 * @param {number} [args.wallHeightPx=0] - the authored wall height, used ONLY
 *   as the top-of-stack stand-in when the topmost floor declares no
 *   `elevation.top` (see {@link resolveTopOfStack}).
 * @param {number} [args.fallbackAboveHeightPx=0] - `SUN_SHADOW_PARAMS.
 *   aboveHeightPx`, the slider this derivation replaces. Used for band 0 ONLY
 *   when the scene genuinely cannot answer — a single-floor scene with a loose
 *   raised tile above it still deserves the old behaviour rather than nothing.
 * @returns {{
 *   heightsPx: number[],
 *   source: 'elevation'|'fallback'|'nothing-above',
 *   reason: string|null,
 *   topOfStackPx: number,
 *   topOfStackSource: string|null,
 *   mergedFloorsAbove: number,
 * }} `heightsPx` is {@link SHADOW_BAND_COUNT} long, band-ordered, world px.
 *   `mergedFloorsAbove` is how many floors the LAST band had to swallow beyond
 *   its own lowest member (0 = every band is exact) — reported so a silent cap
 *   can never masquerade as full coverage.
 */
export function resolveShadowBandPlan({
  floors,
  receiverFloorIndex,
  pxPerElevationUnit,
  wallHeightPx = 0,
  fallbackAboveHeightPx = 0,
}) {
  const fallback = (reason) => ({
    heightsPx: [Math.max(0, fallbackAboveHeightPx) || 0, 0],
    source: 'fallback',
    reason,
    topOfStackPx: 0,
    topOfStackSource: null,
    mergedFloorsAbove: 0,
  });

  if (!Array.isArray(floors) || floors.length === 0) {
    return fallback('no floor list — the scene has not resolved its levels yet');
  }
  if (!Number.isInteger(receiverFloorIndex) || receiverFloorIndex < 0 || receiverFloorIndex >= floors.length) {
    return fallback(`receiver floor ${receiverFloorIndex} is not in the scene's ${floors.length}-floor list`);
  }
  if (!Number.isFinite(pxPerElevationUnit) || pxPerElevationUnit <= 0) {
    return fallback(`pxPerElevationUnit was ${JSON.stringify(pxPerElevationUnit)}, not a positive finite number`);
  }

  const topIndex = floors.length - 1;
  if (receiverFloorIndex === topIndex) {
    // NOT a fallback: this is a fully-answered question whose answer is "the
    // sky". The topmost floor has nothing above it to cast, and handing it the
    // fallback slider instead would invent a phantom storey over the roof.
    return {
      heightsPx: [...EMPTY_BANDS],
      source: 'nothing-above',
      reason: null,
      topOfStackPx: 0,
      topOfStackSource: null,
      mergedFloorsAbove: 0,
    };
  }

  const receiverElev = bottomElevationOf(floors[receiverFloorIndex]);
  if (receiverElev === null) {
    return fallback(`floor ${receiverFloorIndex} declares no elevation.bottom`);
  }
  const topBottomElev = bottomElevationOf(floors[topIndex]);
  if (topBottomElev === null) {
    return fallback(`the topmost floor (${topIndex}) declares no elevation.bottom`);
  }

  const top = resolveTopOfStack(floors[topIndex], topBottomElev, wallHeightPx, pxPerElevationUnit);
  const topOfStackPx = Math.max(0, (top.elevation - receiverElev) * pxPerElevationUnit);
  if (!(topOfStackPx > 0)) {
    // Every floor above sits at or below the receiver's own elevation — an
    // authoring state, not a code state (two Levels sharing one bottom), and
    // one where a derived height of 0 would switch the whole cast off. Say so
    // and take the slider rather than rendering nothing.
    return fallback(
      `floors above floor ${receiverFloorIndex} resolve to a stack top of ${topOfStackPx.toFixed(1)}px — ` +
        `no usable height difference between this floor and the ones above it`
    );
  }

  const heightsPx = [];
  let mergedFloorsAbove = 0;
  for (let k = 0; k < SHADOW_BAND_COUNT; k++) {
    // Band k's silhouette is `coverAbove(receiver + k)` — the union of floors
    // `nextIndex` and above. An empty set (we have run off the top of the
    // stack) is a height of 0, which IS this model's own "off".
    const nextIndex = receiverFloorIndex + k + 1;
    if (nextIndex > topIndex) {
      heightsPx.push(0);
      continue;
    }
    const isLastBand = k === SHADOW_BAND_COUNT - 1 || nextIndex === topIndex;
    if (isLastBand) {
      heightsPx.push(topOfStackPx);
      mergedFloorsAbove = Math.max(0, topIndex - nextIndex);
      // Every remaining band is empty by construction — the last band already
      // carries the whole rest of the stack.
      for (let rest = k + 1; rest < SHADOW_BAND_COUNT; rest++) heightsPx.push(0);
      break;
    }
    const memberElev = bottomElevationOf(floors[nextIndex]);
    if (memberElev === null) {
      return fallback(`floor ${nextIndex} declares no elevation.bottom`);
    }
    heightsPx.push(Math.max(0, (memberElev - receiverElev) * pxPerElevationUnit));
  }

  return {
    heightsPx,
    source: 'elevation',
    reason: null,
    topOfStackPx,
    topOfStackSource: top.source,
    mergedFloorsAbove,
  };
}
