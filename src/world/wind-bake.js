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
 * ⭐ THE ONE ANGLE→VECTOR CONVERSION. Every consumer of `directionDeg`, on
 * CPU or GPU, resolves through this function or its TSL twin
 * ({@link module:world/wind-field~windFlowVectorNode}). Nothing anywhere else
 * may write its own `sin`/`cos` of a wind bearing.
 *
 * ============================================================================
 * THE CONVENTION (settled 2026-09-04 by the author; mythica-machina-press#487
 * / #496 / #497 Stage 0)
 * ============================================================================
 * `directionDeg` is a COMPASS BEARING — 0° = NORTH, increasing CLOCKWISE —
 * and it names the direction the wind **BLOWS TOWARD**. Point the dial at
 * north and the air travels north. That is the author's own call, made
 * against the alternative (meteorological "blows FROM"), and it is now the
 * only reading in the codebase.
 *
 * In this engine's RAW WORLD SPACE (+X east, +Y SOUTH — the camera owns the
 * one Y-flip, per candle-flame-render.js's header) the flow vector is
 * therefore `(sin θ, −cos θ)`:
 *
 * ```
 *   θ =   0° (N) ⇒ ( 0, −1)  → screen up
 *   θ =  90° (E) ⇒ ( 1,  0)  → screen right
 *   θ = 180° (S) ⇒ ( 0,  1)  → screen down
 *   θ = 270° (W) ⇒ (−1,  0)  → screen left
 * ```
 *
 * This is byte-identical to `ui/widgets/param-control.js#buildCompassRow`'s
 * own needle trig, deliberately: the needle a GM drags and the direction the
 * air travels are now the same two lines of maths, so the dial cannot lie.
 *
 * ⚠️ WHAT THIS REPLACED, so the next reader does not "restore" it. Until
 * 2026-09-04 this function returned `−(cos θ, sin θ)` — 0° = EAST, read as
 * meteorological FROM. The codebase held THREE different readings at once
 * (this one; the dial and fire's `(sin θ, −cos θ)`; precipitation's
 * `(−sin θ, cos θ)`), a constant 90° apart in one case and a full 180° in
 * the other, with `effects/precipitation/squall-field.js` carrying a
 * hand-derived `−90` patch to bridge the gap. Two separate files
 * (`squall-field.js`, `particles/precip-runtime.js`) had already written down
 * that the real repair was "one exported helper every consumer calls, so
 * there is one implementation to be right or wrong". This is that helper.
 *
 * @param {number} directionDeg - compass bearing, 0 = north, clockwise.
 * @returns {{x: number, y: number}} a UNIT vector in raw world space.
 */
export function windFlowVector(directionDeg) {
  const rad = ((Number.isFinite(directionDeg) ? directionDeg : 0) * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/**
 * The ambient term of the model (`W = A · openness + gusts`) — {@link
 * windFlowVector} scaled by speed. Kept as its own export because callers
 * overwhelmingly want the scaled vector, not the bare direction.
 *
 * @param {{directionDeg?: number, speed01?: number}} wind
 * @returns {{x: number, y: number}}
 */
export function ambientVectorFromWind({ directionDeg = 0, speed01 = 0 } = {}) {
  const speed = Number.isFinite(speed01) ? Math.max(0, speed01) : 0;
  const dir = windFlowVector(directionDeg);
  return { x: dir.x * speed, y: dir.y * speed };
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
