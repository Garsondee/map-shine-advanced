/**
 * OPENNESS — "is this cell connected to the map's open exterior through open
 * space?" (`docs/planning/Wind-Rethink.md` §4.2). This is the ENTIRE answer
 * to "how much outside wind reaches this cell," replacing what used to be
 * FIVE overlapping mechanisms (an exposure multiplier, a potential-flow
 * relaxation deviation, a live-connectivity gate, a windReach distance-decay,
 * and door-chaos) with ONE geometry-only flood-fill.
 *
 * PURE — no THREE, no Foundry, no TSL. A flood-fill over a small typed array,
 * the same cost class as `wind-bake.js#rasterizeWallsToGrid`: it only ever
 * needs to run when the bake itself reruns (wall/door change), never per
 * frame.
 *
 * ============================================================================
 * 2026-07-22 — THE RETHINK (read `docs/planning/Wind-Rethink.md` first)
 * ============================================================================
 * The author proved the OLD model wrong with one experiment: they deleted
 * EVERY WALL from the scene, rebaked, and wind still died exactly where the
 * painted `_Outdoors` mask went dark — proof that a static PAINTING, not
 * geometry, was deciding where wind could be. Every earlier mechanism this
 * module used to export (`distanceFromExposedAir`/`doorChaosFromDistance`,
 * `windReachFromDistance`) was seeded from that painted mask, directly or
 * indirectly, and is DELETED, not patched again. What survives —
 * {@link floodFillOpenFromBoundary} — never touches the painted mask at all:
 * it seeds from the mapped grid's own BORDER (by `wind-bake.js`'s own
 * convention, a cell off the mapped grid is open sky, so the grid's edge is
 * always potentially open to the outside), so "connected to the outside" is
 * answered by walls and doors alone. No walls → everything connects → wind
 * everywhere (the author's exact test, passing by construction). A sealed
 * room → unreached → 0. Open a door → the room joins the connected set → 1.
 *
 * `openness` SHIPPED BINARY (0 or 1) first, per `docs/planning/Wind-Rethink.md`
 * §5 q1's own staging ("start with binary for testing, aim to do something
 * more interesting if it works" — the author's own words) — confirmed live,
 * then graded (2026-07-22, SAME DAY, author: "the effect of the wind drops
 * off as it travels further away from the nearest door that is open... we'd
 * have something very subtle"). See {@link distanceFromDoorThreshold}'s own
 * header for the graded falloff this module now also provides — it composes
 * WITH {@link floodFillOpenFromBoundary}, not instead of it (the binary
 * flood-fill is still what decides 0 vs "reachable at all"; the falloff only
 * refines what a reachable cell's own strength is).
 *
 * @module world/wind-enclosure
 */

/**
 * Flood-fill OPEN (non-solid) cells starting from every OPEN cell on the
 * grid's own outer border, 4-connected. A cell the fill reaches is "open air
 * connected to the outside" — reads `1`. A cell the fill does NOT reach is
 * either solid (a wall) or a genuinely SEALED interior pocket with no path to
 * the border through open cells — both read `0` in this grid, deliberately
 * not distinguished here (a caller that needs "solid vs. enclosed" already
 * has the `solid` mask itself; this function answers ONE question:
 * "reachable from outside, yes or no").
 *
 * THIS IS `openness` (2026-07-22, THE RETHINK — see this module's own
 * header): run on a FINE, non-over-sealed rasterization
 * (`wind-bake.js#rasterizeWallsToGrid`'s `superCover:false`, at a resolution
 * several times finer than what consumers actually sample — see
 * `vt/vt-pan-viewer.js#bakeWindField`), then downsampled to consumption
 * resolution via {@link downsampleMax}. The fine grid matters: at coarse,
 * over-sealed resolution a curved or narrow real doorway can fuse into one
 * solid band and vanish (author-confirmed live) — a diagonal leak in a fine,
 * non-over-sealed connectivity mask is harmless (it can only help wind find
 * a real opening; there is no solve left for it to corrupt).
 *
 * A GRADED FALLOFF NOW BUILT (2026-07-22, same day — `docs/planning/
 * Wind-Rethink.md` §4.2 step 4, §5 question 1, was deferred, now shipped):
 * wind fading over some distance as it penetrates PAST an opening, rather
 * than filling the whole connected space uniformly. See
 * {@link distanceFromDoorThreshold} — it is a graph-distance from the
 * connected/disconnected BOUNDARY (i.e. from an opening itself), never from
 * the painted mask and never from the map border, composed on top of this
 * function's own binary result rather than replacing it.
 *
 * WHY THE BORDER, NOT A FIXED "OUTSIDE" POINT: `wind-bake.js`'s own
 * documented convention is "a cell OFF the mapped grid is open sky, never a
 * wall" — so the mapped grid's own edge is, by that same convention, always
 * potentially open to the outside. Seeding from every open border cell
 * (rather than guessing one "outdoors" point, or seeding from painted
 * exposure) makes this correct regardless of where a scene's buildings
 * happen to sit relative to the map's own bounding rect, and keeps the
 * painted `_Outdoors` mask OUT of the wind path entirely.
 *
 * A room with EVEN ONE open gap (a doorway, a broken wall segment) in its
 * boundary is connected transitively through that gap and reads `1`
 * throughout its interior — matching the physical intuition "a door lets the
 * outside in." A room with NO gaps at all reads `0` throughout its interior,
 * regardless of how large it is.
 *
 * @param {Uint8Array} solid - from `rasterizeWallsToGrid`; 1 = wall, 0 = open.
 * @param {number} cols @param {number} rows
 * @returns {Uint8Array} same length as `solid`; 1 = open-and-reachable from
 *   the grid's own border, 0 = solid OR sealed-off.
 */
export function floodFillOpenFromBoundary(solid, cols, rows) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const n = c * r;
  const open = new Uint8Array(n);
  if (n === 0) return open;
  const mask = solid instanceof Uint8Array && solid.length === n ? solid : new Uint8Array(n);
  const idx = (col, row) => row * c + col;

  // Seed the queue with every OPEN border cell — see this function's own
  // header for why the border (not one guessed "outdoors" point) is correct.
  const queue = [];
  const enqueueIfOpen = (col, row) => {
    const i = idx(col, row);
    if (mask[i] || open[i]) return; // solid, or already visited — both skip
    open[i] = 1;
    queue.push(i);
  };
  for (let col = 0; col < c; col++) {
    enqueueIfOpen(col, 0);
    if (r > 1) enqueueIfOpen(col, r - 1);
  }
  for (let row = 0; row < r; row++) {
    enqueueIfOpen(0, row);
    if (c > 1) enqueueIfOpen(c - 1, row);
  }

  // Plain BFS, 4-connected — O(n), and this only ever runs on a wall/door
  // change (the same rare-event cost class as the bake it classifies).
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const row = Math.floor(i / c);
    const col = i - row * c;
    if (col > 0) enqueueIfOpen(col - 1, row);
    if (col < c - 1) enqueueIfOpen(col + 1, row);
    if (row > 0) enqueueIfOpen(col, row - 1);
    if (row < r - 1) enqueueIfOpen(col, row + 1);
  }
  return open;
}

/**
 * A small summary report over a computed enclosure grid — how much of the
 * mapped area is open-air vs. sealed-interior vs. wall material. Meant for a
 * debug report line, not for anything performance-sensitive.
 *
 * @param {Uint8Array} solid
 * @param {Uint8Array} open - `floodFillOpenFromBoundary`'s own output, same length as `solid`.
 * @returns {{totalCells:number, solidCells:number, openCells:number, enclosedCells:number, enclosedPct:number}}
 */
export function summarizeEnclosure(solid, open) {
  const n = Array.isArray(solid) ? solid.length : solid?.length || 0;
  let solidCells = 0;
  let openCells = 0;
  for (let i = 0; i < n; i++) {
    if (solid[i]) solidCells++;
    else if (open[i]) openCells++;
  }
  const enclosedCells = Math.max(0, n - solidCells - openCells);
  return {
    totalCells: n,
    solidCells,
    openCells,
    enclosedCells,
    enclosedPct: n > 0 ? Math.round((enclosedCells / n) * 1000) / 10 : 0,
  };
}

/**
 * FINE-RESOLUTION SUPPORT (2026-07-22) — `openness` is computed on a grid
 * `factor`× FINER than what consumers (particle/gust storage buffers, the
 * `sampleWind` texture) actually sample, so a real door/arch opening
 * survives that a coarser rasterization would fuse shut (author-confirmed
 * live: a curved entrance sealed into one solid band at coarse resolution
 * regardless of which door was toggled — see `wind-bake.js#
 * rasterizeWallsToGrid`'s own `superCover` note). This downsamples the fine
 * flood-fill result back to the coarse grid every consumer reads.
 *
 * @param {Uint8Array|number[]} fineMask - 0/1, length `(coarseCols*factor)*(coarseRows*factor)`.
 * @param {number} coarseCols @param {number} coarseRows @param {number} factor
 * @returns {Float32Array} length `coarseCols*coarseRows`, each 0 or 1 — 1 if
 *   ANY fine cell in the coarse cell's footprint reads 1. Deliberately
 *   generous: if even a sliver of a coarse cell is connected to the outside
 *   through a narrow opening, the coarse cell counts as connected, so a door
 *   that only opens part of a coarse cell still admits wind.
 */
export function downsampleMax(fineMask, coarseCols, coarseRows, factor) {
  const cc = Math.max(0, Math.floor(coarseCols) || 0);
  const cr = Math.max(0, Math.floor(coarseRows) || 0);
  const f = Math.max(1, Math.floor(factor) || 1);
  const fc = cc * f;
  const out = new Float32Array(cc * cr);
  if (cc * cr === 0) return out;
  const src = fineMask && fineMask.length === fc * cr * f ? fineMask : null;
  if (!src) return out;
  for (let cy = 0; cy < cr; cy++) {
    for (let cx = 0; cx < cc; cx++) {
      let any = 0;
      for (let dy = 0; dy < f && !any; dy++) {
        const fy = cy * f + dy;
        for (let dx = 0; dx < f; dx++) {
          if (src[fy * fc + cx * f + dx]) {
            any = 1;
            break;
          }
        }
      }
      out[cy * cc + cx] = any;
    }
  }
  return out;
}

/**
 * Crop a fixed MARGIN of cells off all four sides of a grid, returning the
 * inner region as a new array of the same element type.
 *
 * ============================================================================
 * WHY THIS EXISTS — a MAP-EDGE openness leak (2026-07-23, author-reported)
 * ============================================================================
 *
 * `floodFillOpenFromBoundary`'s own header explains why it seeds from the
 * grid's OUTER BORDER rather than a guessed "outdoors" point — correct in
 * general, but it silently assumes the grid's own edge is always a safe
 * distance from any real wall. A building whose exterior wall happens to sit
 * AT (or a cell or two inside) the scene's own boundary breaks that
 * assumption: the border-seeded fill can reach a cell that is really INSIDE
 * the building, because there was never a genuinely-open cell between the
 * wall and the edge of the computable grid for the fill to stop at — author,
 * verbatim: "a building, fully enclosed with walls, sits right on the edge
 * of the map... wind just starts inside the building."
 *
 * THE FIX, and why it is geometry-only (no painted mask involved — see
 * `floodFillOpenFromBoundary`'s own header on why the mask is deliberately
 * NOT consulted anywhere in this file, `docs/planning/Wind-Rethink.md`'s
 * "cardinal rule"): `bakeWindField` now rasterizes + flood-fills the FINE
 * openness grid on a rect PADDED a few cells beyond the real scene rect on
 * every side, giving even an edge-flush wall a genuine open neighbour to
 * separate it from the grid's own outer border. This function is the "undo"
 * half — crops that margin back off BEFORE anything downstream (`downsample
 * Max`, the published openness texture, any consumer) ever sees it, so the
 * published grid's own EXTENT is byte-identical to before this fix (still
 * exactly the real scene rect — the 2026-07-23 "don't leak into the padding
 * margin" fix stays fully intact). The margin exists ONLY inside this one
 * bake step, as a scratch computation, never exposed.
 *
 * @param {Uint8Array|Float32Array} grid - the PADDED grid.
 * @param {number} paddedCols @param {number} paddedRows
 * @param {number} marginCells - cells removed from EACH side.
 * @returns {Uint8Array|Float32Array} the inner grid, `(paddedCols - 2×margin)
 *   × (paddedRows - 2×margin)`, same array type as `grid` (so a `Uint8Array`
 *   solid/open mask crops to a `Uint8Array`, matching what `downsampleMax`/
 *   `floodFillOpenFromBoundary`'s own callers already expect).
 */
export function cropGridMargin(grid, paddedCols, paddedRows, marginCells) {
  const pc = Math.max(0, Math.floor(paddedCols) || 0);
  const pr = Math.max(0, Math.floor(paddedRows) || 0);
  const m = Math.max(0, Math.floor(marginCells) || 0);
  const cols = Math.max(0, pc - 2 * m);
  const rows = Math.max(0, pr - 2 * m);
  const Ctor = grid?.constructor ?? Uint8Array;
  const out = new Ctor(cols * rows);
  if (cols === 0 || rows === 0) return out;
  const src = grid && grid.length === pc * pr ? grid : null;
  if (!src) return out; // shape mismatch — fail to all-zero, same "never garbage" posture downsampleMax uses
  for (let y = 0; y < rows; y++) {
    const srcRowStart = (y + m) * pc + m;
    const dstRowStart = y * cols;
    for (let x = 0; x < cols; x++) {
      out[dstRowStart + x] = src[srcRowStart + x];
    }
  }
  return out;
}

/** How many cells of open-air path the coherent (directional) wind penetrates
 * from a doorway threshold before fading to nothing (2026-07-22, author
 * request: "the effect of the wind drops off as it travels further away
 * from the nearest door that is open... we'd have something very subtle") —
 * a tune-by-eye starting value, not a physical constant, same posture as
 * every other reach constant in this module's own history. In COARSE-grid
 * (consumption-resolution) cells — the caller scales this UP by its own
 * fine/coarse refinement factor (`vt-pan-viewer.js#bakeWindField`'s own
 * `OPENNESS_REFINE`) to match the fine-grid distance values it's compared
 * against, same convention `DOOR_CHAOS_REACH_CELLS` used to.
 *
 * RETUNED 5× (2026-07-23, first live look, author: "When it intrudes into a
 * house it needs to travel about x5 further than it does currently. The
 * dropoff is good, but it needs to be a lot weaker.") — was 24, confirming
 * the LINEAR falloff shape itself reads correctly ("the dropoff is good"),
 * just reaching zero far too soon. A pure distance-scale retune — the
 * formula (`opennessFalloffFromDistance`, below) is untouched. */
export const DOOR_FALLOFF_REACH_CELLS = 120;

/**
 * THE GRADED PENETRATION FALLOFF (2026-07-22, docs/planning/Wind-Rethink.md
 * §4.2 step 4 / §5 q1, shipped same-day as binary openness after the
 * author's own live confirmation: "opening a door now floods the interior
 * with wind" — followed immediately by "we'd have something very subtle" if
 * it instead faded with distance from the door). Splits a cell's reachability
 * into two questions, geometry-only, painted mask never consulted:
 *
 *   - EXTERIOR: is this cell reachable from the map border WITHOUT crossing
 *     ANY door, open or closed (`world/foundry/scene-walls.js#
 *     deriveWallBlocksExterior` — a door counts as a permanent barrier here
 *     regardless of its live open/closed state)? This is the genuinely
 *     outdoors, in-the-open space — a courtyard, a field, the space around a
 *     building — the exact territory the author's "wind correctly pushes
 *     around buildings and looks amazing outside" already depends on. It
 *     NEVER falls off; distance from a door is a meaningless question for a
 *     cell that was never behind one.
 *   - INDOOR (reached only via a door): a cell that IS reachable in the real
 *     mask (doors-open passable, `floodFillOpenFromBoundary`'s own result)
 *     but is NOT part of the exterior set above — i.e. the ONLY reason it
 *     connects at all is that some door happens to be open right now. This
 *     function computes its hop-distance from the nearest THRESHOLD cell
 *     (an indoor cell directly adjacent to an exterior one — the doorway
 *     gap itself) through indoor territory only.
 *
 * A cell that is neither (not reachable at all, in either mask) reads -1,
 * same "no signal" convention as this module's own retired distance
 * functions used. Determinism/no-throw/degenerate-input discipline matches
 * {@link floodFillOpenFromBoundary} throughout.
 *
 * @param {Uint8Array} fullOpen - `floodFillOpenFromBoundary`'s own output on
 *   the REAL solid mask (doors open ⇒ passable).
 * @param {Uint8Array} exteriorOpen - `floodFillOpenFromBoundary`'s own output
 *   on a mask built from `deriveWallBlocksExterior` (doors ALWAYS solid).
 * @param {number} cols @param {number} rows - shared by both inputs.
 * @returns {Int32Array} same length; -1 = not reached at all, OR reached
 *   without ever crossing a door (exterior — the caller should treat -1
 *   AND "is this cell exterior" as two separate questions, not conflate
 *   them; see {@link opennessFalloffFromDistance}'s own header for how the
 *   two combine into one final multiplier).
 */
export function distanceFromDoorThreshold(fullOpen, exteriorOpen, cols, rows) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const n = c * r;
  const dist = new Int32Array(n).fill(-1);
  if (n === 0) return dist;
  const full = fullOpen instanceof Uint8Array && fullOpen.length === n ? fullOpen : new Uint8Array(n);
  const ext = exteriorOpen instanceof Uint8Array && exteriorOpen.length === n ? exteriorOpen : new Uint8Array(n);
  const idx = (col, row) => row * c + col;
  const isIndoor = (i) => full[i] === 1 && ext[i] !== 1;

  // Seed every INDOOR cell that has at least one EXTERIOR 4-neighbor — the
  // doorway threshold itself (the open door's own gap cell reads `isIndoor`
  // too, since it's blocked in the doors-always-solid exterior mask but open
  // in the real one — so it seeds at distance 0, exactly where the "how far
  // from the door" question should start).
  const queue = [];
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const i = idx(col, row);
      if (!isIndoor(i)) continue;
      const touchesExterior =
        (col > 0 && ext[idx(col - 1, row)] === 1) ||
        (col < c - 1 && ext[idx(col + 1, row)] === 1) ||
        (row > 0 && ext[idx(col, row - 1)] === 1) ||
        (row < r - 1 && ext[idx(col, row + 1)] === 1);
      if (touchesExterior) {
        dist[i] = 0;
        queue.push(i);
      }
    }
  }

  // Plain BFS, 4-connected, through INDOOR cells only — same O(n) cost class
  // as this module's other flood-fills, and the SAME rare-event trigger
  // (wall/door change), never per frame.
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const row = Math.floor(i / c);
    const col = i - row * c;
    const d = dist[i] + 1;
    const relax = (nc, nr) => {
      if (nc < 0 || nc >= c || nr < 0 || nr >= r) return;
      const ni = idx(nc, nr);
      if (!isIndoor(ni) || dist[ni] >= 0) return; // exterior, solid, or already reached — all skip
      dist[ni] = d;
      queue.push(ni);
    };
    relax(col - 1, row);
    relax(col + 1, row);
    relax(col, row - 1);
    relax(col, row + 1);
  }
  return dist;
}

/**
 * Turn {@link distanceFromDoorThreshold}'s hop-distance into the FINAL
 * `openness` value (2026-07-22) — 1 right at the threshold, ramping LINEARLY
 * to 0 by `reachCells` cells further in, same "1 at the source, fading to a
 * shell radius" shape this project's retired distance-falloff functions
 * already used. An EXTERIOR cell (never behind a door at all) reads 1
 * unconditionally — the outdoor look stays exactly what it was under binary
 * openness. A cell with no path at all (`distance === -1` AND not exterior)
 * reads exactly 0.
 *
 * @param {Int32Array|number[]} distance - `distanceFromDoorThreshold`'s own output.
 * @param {Uint8Array|number[]} exteriorOpen - the SAME exterior mask passed
 *   to `distanceFromDoorThreshold`, so this function alone can produce the
 *   complete, final per-cell value without the caller re-combining two
 *   arrays itself.
 * @param {{reachCells?: number}} [opts]
 * @returns {Float32Array} same length as `distance`, each value in [0,1].
 */
export function opennessFalloffFromDistance(distance, exteriorOpen, { reachCells = DOOR_FALLOFF_REACH_CELLS } = {}) {
  const n = distance?.length ?? 0;
  const out = new Float32Array(n);
  const reach = Math.max(1, Number(reachCells) || DOOR_FALLOFF_REACH_CELLS);
  const ext = exteriorOpen && exteriorOpen.length === n ? exteriorOpen : null;
  for (let i = 0; i < n; i++) {
    if (ext && ext[i] === 1) {
      out[i] = 1; // genuinely outdoors — never falls off, regardless of distance
      continue;
    }
    const d = distance[i];
    if (d == null || d < 0) continue; // stays 0 — no path to any open door at all
    out[i] = Math.max(0, 1 - d / reach);
  }
  return out;
}

/**
 * Downsample a FINE distance field (from {@link distanceFromDoorThreshold} on
 * the fine grid) to the coarse grid, taking the MINIMUM non-negative distance
 * over each coarse cell's `factor`×`factor` fine footprint — "the closest a
 * door threshold got to any part of this coarse cell." A coarse cell whose
 * whole footprint is unreached stays -1. Min (not average) is deliberately
 * generous, the mirror of {@link downsampleMax}'s any-cell-reached logic: if
 * ANY sliver of a coarse cell is close to a threshold, the coarse cell
 * reflects that proximity. Returned distances are in FINE-cell units (the
 * caller scales `reachCells` by the SAME factor to match).
 *
 * @param {Int32Array|number[]} fineDistance - length `(coarseCols*factor)*(coarseRows*factor)`.
 * @param {number} coarseCols @param {number} coarseRows @param {number} factor
 * @returns {Int32Array} length `coarseCols*coarseRows`; -1 = whole footprint unreached.
 */
export function downsampleDistanceMin(fineDistance, coarseCols, coarseRows, factor) {
  const cc = Math.max(0, Math.floor(coarseCols) || 0);
  const cr = Math.max(0, Math.floor(coarseRows) || 0);
  const f = Math.max(1, Math.floor(factor) || 1);
  const fc = cc * f;
  const out = new Int32Array(cc * cr).fill(-1);
  if (cc * cr === 0) return out;
  const src = fineDistance && fineDistance.length === fc * cr * f ? fineDistance : null;
  if (!src) return out;
  for (let cy = 0; cy < cr; cy++) {
    for (let cx = 0; cx < cc; cx++) {
      let best = -1;
      for (let dy = 0; dy < f; dy++) {
        const fy = cy * f + dy;
        for (let dx = 0; dx < f; dx++) {
          const fx = cx * f + dx;
          const d = src[fy * fc + fx];
          if (d < 0) continue; // unreached fine cell — ignore
          if (best < 0 || d < best) best = d;
        }
      }
      out[cy * cc + cx] = best;
    }
  }
  return out;
}

/**
 * ============================================================================
 * WALL-AVOIDANCE DEFLECTION (2026-07-23, author: "Walls perpendicular to the
 * wind aren't preventing the wind from penetrating... the wind is pushing
 * straight through the side of a building once an interior room becomes open
 * to the outside. How can we prevent wind from crossing walls with
 * confidence? How can we divert and diminish its strength so that it breaks
 * around objects instead of just losing all its energy.")
 * ============================================================================
 * ROOT CAUSE: `openness` (above) only ever answers "is this cell connected to
 * the outside, and how strongly" — a SCALAR. The coherent wind's DIRECTION is
 * always the raw ambient compass bearing, uniform everywhere, just scaled up
 * or down by that scalar. Nothing in that model knows a WALL is a SURFACE
 * with an ORIENTATION — a wall running perpendicular to the wind and a wall
 * running parallel to it are treated identically, so the ambient direction
 * happily "blows through" a wall it is geometrically facing head-on, same as
 * it would through open air, just dimmer.
 *
 * THE FIX, GEOMETRY-ONLY, SAME ARCHITECTURE AS `openness` ITSELF: a second
 * per-cell field, computed once per bake (never per frame) from the SAME
 * solid mask — "how close is the nearest wall" ({@link
 * distanceFromNearestSolid}) and, from its gradient, "which way is away from
 * it" ({@link wallAvoidanceDirectionFromDistance}), gated by a proximity
 * falloff ({@link wallProximityFromDistance}) so the effect is a genuine
 * no-op away from any wall. `world/wind-field.js#sampleWind` consumes all
 * three (packed into one small texture, `vt-pan-viewer.js#bakeWindField`) to
 * PROJECT the coherent wind vector against the nearest wall: the component
 * pointing INTO the wall is cancelled (this is the "prevent crossing, with
 * confidence" half — a mathematical projection, not a probabilistic damping),
 * and part of what was cancelled reappears as a TANGENTIAL push along the
 * wall, in whichever direction the flow was already leaning (the "breaks
 * around objects instead of losing all its energy" half). See that
 * function's own wall-deflection block for the exact formula.
 *
 * Runs on the COARSE (consumption) grid directly, reusing the ALREADY-
 * COMPUTED `solidMask` `bakeWindField` builds for Tier 2 — unlike `openness`,
 * this doesn't need `openness`'s own fine-grid trick (that exists to stop a
 * narrow doorway fusing shut at coarse resolution; wall-avoidance only needs
 * to know "roughly which way is away from the nearest wall," which coarse
 * resolution answers perfectly well). One extra BFS per bake, same O(n) cost
 * class and same rare-event (wall/door change) trigger as every other
 * geometry pass in this module.
 */

/**
 * Multi-source BFS: every cell's hop-distance to the nearest SOLID (wall)
 * cell. A solid cell itself reads 0. Mirrors {@link distanceFromDoorThreshold}'s
 * own BFS discipline (a `relax` closure, 4-connected, `Int32Array`), seeded
 * from every solid cell at once instead of from a door threshold. Unlike that
 * function, this BFS is NOT confined to a passable subset — every cell is a
 * valid stepping-stone toward measuring "how far to the nearest wall,"
 * including cells on the far side of some OTHER wall — this is a geometric
 * proximity measure, not a connectivity/reachability one (openness already
 * owns that separate question).
 *
 * @param {Uint8Array} solid - from `rasterizeWallsToGrid`; 1 = wall, 0 = open.
 * @param {number} cols @param {number} rows
 * @returns {Int32Array} same length as `solid`; 0 at solid cells, hop-distance
 *   to the nearest solid cell everywhere else. Every cell reads -1 ONLY when
 *   the grid has NO solid cells anywhere — a real, valid "no walls on this
 *   map at all" case, not a degenerate input.
 */
export function distanceFromNearestSolid(solid, cols, rows) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const n = c * r;
  const dist = new Int32Array(n).fill(-1);
  if (n === 0) return dist;
  const mask = solid instanceof Uint8Array && solid.length === n ? solid : new Uint8Array(n);
  const idx = (col, row) => row * c + col;

  const queue = [];
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  // Plain BFS, 4-connected — same O(n) cost class as this module's other
  // flood-fills, same rare-event (wall/door change) trigger, never per frame.
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const row = Math.floor(i / c);
    const col = i - row * c;
    const d = dist[i] + 1;
    const relax = (nc, nr) => {
      if (nc < 0 || nc >= c || nr < 0 || nr >= r) return;
      const ni = idx(nc, nr);
      if (dist[ni] >= 0) return; // solid, or already reached — both skip
      dist[ni] = d;
      queue.push(ni);
    };
    relax(col - 1, row);
    relax(col + 1, row);
    relax(col, row - 1);
    relax(col, row + 1);
  }
  return dist;
}

/**
 * The GRADIENT of {@link distanceFromNearestSolid}'s own output, per cell —
 * a UNIT vector pointing in the direction of INCREASING distance from the
 * nearest wall, i.e. AWAY from it. Central difference where both neighbors
 * exist, one-sided at the grid's own edge (dividing by the actual span used,
 * so an edge cell's estimate isn't silently halved) — never reads outside
 * the array.
 *
 * Reads (0,0) — no defined direction — at a cell exactly ON a wall (a solid
 * cell's own distance is a local minimum on both sides in the simple case,
 * so the gradient estimate is legitimately flat there; nothing should ever
 * sample wind AT a wall position in practice anyway), and everywhere on a
 * map with NO solid geometry at all ({@link distanceFromNearestSolid}'s own
 * all-`-1` case reads as a flat field here, zero gradient, not a cliff) —
 * both cases are harmless because {@link wallProximityFromDistance}
 * independently reads 0 in the same situations, so a (0,0) direction is
 * never actually consumed at a nonzero strength.
 *
 * @param {Int32Array|number[]} distance - `distanceFromNearestSolid`'s own output.
 * @param {number} cols @param {number} rows
 * @returns {{dirX: Float32Array, dirY: Float32Array}} same length as `distance`.
 */
export function wallAvoidanceDirectionFromDistance(distance, cols, rows) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const n = c * r;
  const dirX = new Float32Array(n);
  const dirY = new Float32Array(n);
  if (n === 0) return { dirX, dirY };
  const d = distance && distance.length === n ? distance : null;
  if (!d) return { dirX, dirY };
  const at = (col, row) => {
    const v = d[row * c + col];
    return v < 0 ? 0 : v; // no-solid-anywhere case: treat as a flat field, not a cliff
  };
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const leftCol = Math.max(0, col - 1);
      const rightCol = Math.min(c - 1, col + 1);
      const upRow = Math.max(0, row - 1);
      const downRow = Math.min(r - 1, row + 1);
      const gx = (at(rightCol, row) - at(leftCol, row)) / Math.max(1, rightCol - leftCol);
      const gy = (at(col, downRow) - at(col, upRow)) / Math.max(1, downRow - upRow);
      const len = Math.hypot(gx, gy);
      if (len > 1e-6) {
        const i = row * c + col;
        dirX[i] = gx / len;
        dirY[i] = gy / len;
      }
    }
  }
  return { dirX, dirY };
}

/** Default reach for the wall-avoidance deflection, in COARSE (consumption-
 * resolution) cells — a tune-by-eye starting value, same posture as
 * `DOOR_FALLOFF_REACH_CELLS`. Deliberately a "boundary layer," not a
 * whole-room fade: this only needs to matter right where a wall is actually
 * about to block flow — the deep interior of a room is `openness`'s own
 * falloff's job, not this one's. */
// RETUNED (2026-07-23, first live look at the particle/gust version of this
// effect, author: "they currently hit a brick wall quite a long way away
// from the actual walls themselves. We need to soften those walls so it's
// not so binary, repelling particles from walls but over a wider band and a
// softer effect") — was 6. A screenshot with a hand-drawn line showed the
// effect's visible onset sitting well outside the real wall edge; part of
// that WAS the reach itself reading small relative to what a moving particle
// needs to gently arc around rather than snap into line — widened
// substantially. Still a tune-by-eye guess, same posture as every other
// reach constant in this module — expect another pass.
export const WALL_DEFLECT_REACH_CELLS = 20;

/**
 * Turn {@link distanceFromNearestSolid}'s hop-distance into a [0,1] proximity
 * strength — 1 AT a wall (distance 0), fading to 0 by `reachCells` cells
 * away. Gates HOW STRONGLY `world/wind-field.js#sampleWind`/`deflectAroundWalls`
 * deflect the coherent wind (and, for particles/gust heads, their own
 * momentum) near a wall — far from any wall this reads 0, a guaranteed
 * no-op there.
 *
 * EASED, NOT LINEAR (2026-07-23, same author feedback as the reach widening
 * above: "so it's not so binary... a softer effect") — this used to be a
 * straight `1 - d/reach` ramp, deliberately copying {@link
 * opennessFalloffFromDistance}'s own shape. That shape is right for openness
 * (a graded PRESENCE question — "how much wind reaches here"), but wrong for
 * a REPULSION strength: a linear ramp is already at 50% strength halfway
 * out, which reads as an abrupt, wall-like reaction the moment a particle
 * enters the zone, not a gentle push that builds as it gets closer. Squaring
 * the linear falloff (`t²`, a standard ease-in curve) keeps the far two-thirds
 * of the band nearly imperceptible and concentrates the real push into the
 * last stretch before the wall — "wide band, soft effect" in one curve
 * change, no new parameter.
 *
 * @param {Int32Array|number[]} distance - `distanceFromNearestSolid`'s own output.
 * @param {{reachCells?: number}} [opts]
 * @returns {Float32Array} same length as `distance`, each value in [0,1].
 */
export function wallProximityFromDistance(distance, { reachCells = WALL_DEFLECT_REACH_CELLS } = {}) {
  const n = distance?.length ?? 0;
  const out = new Float32Array(n);
  const reach = Math.max(1, Number(reachCells) || WALL_DEFLECT_REACH_CELLS);
  for (let i = 0; i < n; i++) {
    const d = distance[i];
    if (d == null || d < 0) continue; // no solid anywhere on the map — stays 0
    const linear = Math.max(0, 1 - d / reach);
    out[i] = linear * linear;
  }
  return out;
}
