/**
 * THE STRUCTURE BAKE — geometry-only prep for `world/wind-enclosure.js`'s
 * openness flood-fill (`docs/planning/Wind-Rethink.md` §4). Everything here
 * is PURE (no THREE, no Foundry, no TSL) — Node-tested, because it only ever
 * runs OCCASIONALLY (on wall/door change, or a manual rebake), never per
 * frame.
 *
 * ============================================================================
 * 2026-07-22 — THE RETHINK: THE POTENTIAL-FLOW RELAXATION IS GONE
 * ============================================================================
 * This file used to also bake `D_rest`, a Jacobi relaxation of a scalar
 * potential (`bakeWindStructure`) that computed a per-cell wall-cancellation
 * DEVIATION from the ambient. It is deleted, not demoted — after ~8
 * consecutive verify-green patches that each fixed their target and revealed
 * the next failure (the full chronicle is `docs/planning/Wind-Rethink.md`
 * §1), the author directed a full rethink rather than another patch. Three
 * reasons this specific piece had to go (doc §2.3):
 *   - it converged ONE CELL PER ITERATION, so a long corridor needed a
 *     proportional iteration budget and, past a length, never finished;
 *   - it is IRROTATIONAL BY CONSTRUCTION — mathematically incapable of a
 *     vortex/wake, however it was tuned;
 *   - its indoor output was unreliable enough that FOUR separate downstream
 *     mechanisms grew just to mask it (exposure gating, a live-connectivity
 *     gate, windReach-as-decay, door-chaos) — a tangle that fought itself.
 * The replacement (`world/wind-enclosure.js#floodFillOpenFromBoundary`,
 * driven from THIS file's `rasterizeWallsToGrid`) answers "how much outside
 * wind reaches this cell" with ONE flood-fill: exact in a single linear pass,
 * at any corridor length, with no iteration budget to run out of. See
 * `world/wind-field.js#sampleWind`'s own header for how the result —
 * `openness` — is consumed.
 *
 * WHAT SURVIVES FROM TIER 1, AND WHY: `ambientVectorFromWind` (still the one
 * angle↔vector conversion every wind consumer must agree on) and
 * `computeWindBakeGridSpec`/`rasterizeWallsToGrid` (still the one wall
 * rasterization — `rasterizeWallsToGrid`'s `superCover` option is MORE
 * important now, not less: openness is computed on a fine, non-over-sealed
 * rasterization specifically so a curved/narrow real opening cannot fuse into
 * a solid band the way it did at coarse, over-sealed resolution — see that
 * function's own header).
 *
 * @module world/wind-bake
 */

/**
 * Convert an ambient direction+speed into a vector — still the single
 * ambient term of the new model (`W = A · openness + gusts`,
 * `docs/planning/Wind-Rethink.md` §4.1).
 *
 * ANGLE CONVENTION (documented explicitly — a fresh direction↔vector mapping
 * is exactly this project's own recurring Y-flip bug class,
 * feedback_y_flip_recurring_risk): `directionDeg` is METEOROLOGICAL — the
 * direction the wind blows FROM, matching every real-world weather report
 * and the debug panel's own compass-labeled dropdown ("East" means an east
 * wind, blowing FROM the east TOWARD the west — not a wind blowing toward
 * the east). Measured CLOCKWISE from +X in the engine's own RAW WORLD SPACE
 * (+Y down — the same space every world mesh in this codebase already works
 * in with zero manual flipping, per candle-flame-render.js's own header:
 * "the viewer's camera owns the ONE Y-flip"). So 0° ("East") blows FROM +X,
 * i.e. the flow vector points toward -X (screen west); 90° ("South") blows
 * FROM +Y toward -Y (screen north/up); 180° ("West") blows toward +X (east);
 * 270° ("North") blows toward +Y (south/down) — the flow vector is always
 * the NEGATION of the raw (cos,sin) bearing. No camera-space flip is applied
 * here, deliberately: this function's output feeds code that is already on
 * the raw-world-space side of that one camera flip, same as the candle
 * quad's own `center` attribute — the negation below is the FROM→flow
 * correction, an entirely separate thing from a Y-axis flip.
 *
 * MUST match `world/wind-field.js#sampleWind`'s own live ambient branch —
 * the two are summed/compared against the same convention throughout the
 * wind system.
 *
 * @param {{directionDeg?: number, speed01?: number}} wind
 * @returns {{x: number, y: number}}
 */
export function ambientVectorFromWind({ directionDeg = 0, speed01 = 0 } = {}) {
  const deg = Number.isFinite(directionDeg) ? directionDeg : 0;
  const speed = Number.isFinite(speed01) ? Math.max(0, speed01) : 0;
  const rad = (deg * Math.PI) / 180;
  // The FROM→flow negation — see this function's own header.
  return { x: -Math.cos(rad) * speed, y: -Math.sin(rad) * speed };
}

/**
 * Decide the bake's own grid — ~1 cell per grid square, clamped to
 * [minAxisCells,maxAxisCells] per axis so even a huge map stays a fraction of
 * a megabyte.
 *
 * @param {object} args
 * @param {number} args.sceneX @param {number} args.sceneY @param {number}
 *   args.sceneWidth @param {number} args.sceneHeight - world-px bounds to
 *   cover (e.g. `foundry/scene-geometry.js#computeSceneDimensions`'s own
 *   `rect`, the padded canvas — covering the WHOLE canvas, not just the
 *   inset sceneRect, so a candle placed in the padding still bakes correctly).
 * @param {number} args.gridSizePixels - the scene's own grid square size.
 * @param {number} [args.minAxisCells=64] @param {number} [args.maxAxisCells=256]
 * @returns {{minX:number, minY:number, cols:number, rows:number, cellSize:number}}
 */
export function computeWindBakeGridSpec({
  sceneX,
  sceneY,
  sceneWidth,
  sceneHeight,
  gridSizePixels,
  minAxisCells = 64,
  maxAxisCells = 256,
}) {
  const w = Number.isFinite(sceneWidth) && sceneWidth > 0 ? sceneWidth : 4000;
  const h = Number.isFinite(sceneHeight) && sceneHeight > 0 ? sceneHeight : 3000;
  const grid = Number.isFinite(gridSizePixels) && gridSizePixels > 0 ? gridSizePixels : 100;
  // One cell per grid square along the LONGER axis, then clamp — the
  // shorter axis keeps the SAME cellSize (square cells), just fewer of them,
  // so a corridor's own aspect ratio isn't distorted by independent per-axis
  // clamping.
  const longAxisCells = Math.max(w, h) / grid;
  const clampedLongAxis = Math.min(maxAxisCells, Math.max(minAxisCells, Math.round(longAxisCells)));
  const cellSize = Math.max(w, h) / clampedLongAxis;
  const cols = Math.max(1, Math.round(w / cellSize));
  const rows = Math.max(1, Math.round(h / cellSize));
  return { minX: Number(sceneX) || 0, minY: Number(sceneY) || 0, cols, rows, cellSize };
}

/**
 * Rasterize wall segments into a coarse SOLID mask at the bake's own
 * resolution. Each segment is walked in sub-cell steps (finer than the cell
 * size, so no cell along its path is skipped); a supercover guard
 * additionally fills the two cells that share an EDGE with both the previous
 * and current sample whenever a step crosses a column AND a row boundary at
 * once — otherwise two only-corner-touching solid cells would leave a
 * diagonal gap air could leak through.
 *
 * `superCover` (default true) is that diagonal-leak guard. It is correct and
 * necessary for a PHYSICS solve (a leak there would corrupt it) — but it
 * OVER-SEALS: a curved or diagonal wall (a mansion's arched entrance, curved
 * steps) triggers it on nearly every step, filling a thick band of extra
 * solid cells that can seal a real opening shut at coarse resolution
 * (2026-07-22, author-confirmed live: removing physical door walls did
 * nothing because the curved entrance STRUCTURE around them rasterized into
 * one solid band, so no through-path existed regardless). Pass `superCover:
 * false` for OPENNESS (world/wind-enclosure.js#floodFillOpenFromBoundary's
 * own input) — a small diagonal leak there is harmless (it can only make
 * wind find its way IN, never corrupt anything, since there is no solve left
 * to corrupt), and dropping the over-seal lets real door/arch openings
 * survive. Openness additionally runs at a FINER resolution than this
 * function's own default caller (see vt-pan-viewer.js#bakeWindField) so
 * sub-coarse-cell openings survive too.
 *
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,solid:boolean}>} walls
 * @param {{minX:number, minY:number, cols:number, rows:number, cellSize:number}} gridSpec
 * @param {{superCover?: boolean}} [opts]
 * @returns {Uint8Array} length `cols*rows`, row-major, 1 = solid.
 */
export function rasterizeWallsToGrid(walls, { minX, minY, cols, rows, cellSize }, { superCover = true } = {}) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const solid = new Uint8Array(c * r);
  const size = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 1;
  const mark = (col, row) => {
    if (col >= 0 && col < c && row >= 0 && row < r) solid[row * c + col] = 1;
  };
  for (const wall of Array.isArray(walls) ? walls : []) {
    if (!wall?.solid) continue;
    const { x1, y1, x2, y2 } = wall;
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(length / (size * 0.5)));
    let prevCol = null;
    let prevRow = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      const col = Math.floor((x - minX) / size);
      const row = Math.floor((y - minY) / size);
      mark(col, row);
      if (superCover && prevCol !== null && col !== prevCol && row !== prevRow) {
        mark(col, prevRow); // the supercover guard — see this function's header
        mark(prevCol, row);
      }
      prevCol = col;
      prevRow = row;
    }
  }
  return solid;
}
