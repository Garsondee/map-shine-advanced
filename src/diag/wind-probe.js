/**
 * THE WIND + PARTICLE PROBE — pure decomposition math, the pixel-probe's own
 * pattern applied to wind (`diag/pixel-probe.js`'s header: "the load-bearing
 * instrument for 'the math is right but the picture is wrong'"). Born from a
 * live, precise author report this exact investigation could not resolve by
 * reasoning alone: interior rooms reading "awash with energy" right after
 * Wind.md Tier 1.5 (wake turbulence) shipped, while exterior particles still
 * glued to a windward wall. Every prior round of wind/particle debugging in
 * this codebase (memory: keyhole-particle-engine-next-session, 21+ rounds)
 * was eventually settled by an instrument reporting REAL NUMBERS, never by
 * re-reasoning about the code — this is that instrument, built proactively
 * instead of after another guess.
 *
 * TWO GROUND TRUTHS, cross-referenced:
 *   1. The CPU-side BAKE (`world/wind-bake.js#rasterizeWallsToGrid`,
 *      `world/wind-enclosure.js#floodFillOpenFromBoundary`) — exact,
 *      synchronous, no GPU round-trip. `decomposeWindAt` answers "what
 *      SHOULD this position show" by reading the same `openness` grid every
 *      consumer (candle, overlay, particles, gusts) already reads from,
 *      split into named terms instead of one fused total.
 *   2. The GPU's ACTUAL particle state — `findNearestParticles` answers
 *      "what did the kernel ACTUALLY compute nearby" from an already-read-
 *      back array of decoded particles (the GPU-glue layer in
 *      `effects/particles/particle-runtime.js` does the readback; this file
 *      only does the pure selection/summary math so it stays Node-testable).
 * A mismatch between the two is the same kind of smoking gun that found
 * fix-12/13 in particle-runtime.js's own history: two different, independent
 * sources of truth disagreeing points at a WIRING bug, not a tuning question.
 *
 * PURE — no THREE, no Foundry, no TSL, no GPU. The click-to-arm UX and the
 * actual GPU readback are thin glue in `vt/vt-pan-viewer.js` /
 * `effects/particles/particle-runtime.js`, mirroring the existing
 * pixel-probe's own "pure decode here, browser glue there" split
 * (CONVENTIONS.md §4).
 *
 * @module diag/wind-probe
 */

function round2(x) {
  return Math.round(x * 100) / 100;
}

// The ONE shelter-strength constant, imported rather than copied — see its own
// header. A probe with a private duplicate of a look constant drifts silently
// the first time the renderer's is retuned.
import { WIND_SHADOW_DEPTH } from '../world/index.js';

/**
 * Nearest-cell lookup — DELIBERATELY the exact same formula
 * `effects/particles/particle-runtime.js`'s update kernel uses for its own
 * `opennessGrid` reads (floor, then clamp to `[0, cols-1]`/`[0, rows-1]`).
 * This is not a stylistic choice: if this
 * probe's "ground truth" cell lookup ever drifted from the KERNEL's own
 * lookup, a reported mismatch between the two would be a false alarm (an
 * artifact of comparing two different conventions), not a real bug — so the
 * two MUST use byte-identical math, and this function exists specifically so
 * there is exactly one place that math is written.
 *
 * @param {number} x @param {number} y - world position.
 * @param {{originX:number, originY:number, cellSize:number, cols:number, rows:number}} grid
 * @returns {{col:number, row:number, index:number}|null} null only for a
 *   degenerate (zero-size) grid.
 */
/**
 * One human line describing what a wind-field bake actually produced.
 *
 * ⚠️ THIS EXISTS BECAUSE THE BUTTON THAT USED IT WAS LYING, FOR MONTHS. The
 * "Rebake wind structure" action formatted its note from `result.exposure.min`,
 * `.max` and `.varies` — fields `bakeWindField` stopped returning when the Wind
 * rethink deleted the exposure machinery. `undefined` is falsy, so EVERY click
 * printed the failure branch: a confident sentence claiming the outdoors mask was
 * being read as the same value everywhere and naming three things to go check.
 * A permanent false alarm about a mask wind no longer consults at all.
 *
 * Pure and Node-tested against the bake's REAL return shape, so the next time
 * that shape changes a test goes red instead of a button inventing a diagnosis
 * (`feedback_instruments_must_not_lie`). If a field it wants is missing, it says
 * the field is missing — it never infers a fault from an absent number.
 *
 * @param {object|null} result - `bakeWindField`'s return value.
 * @returns {string}
 */
export function describeWindBake(result) {
  if (!result || typeof result !== 'object') return 'no bake result at all — the viewer is probably not running.';
  if (!result.ok) return `bake failed (${result.reason ?? 'no reason given'}): ${result.error ?? 'no error given'}`;

  const parts = [];
  const has = (k) => Number.isFinite(result[k]);
  if (has('cols') && has('rows')) parts.push(`${result.cols}x${result.rows} cells`);
  if (has('wallCount')) {
    parts.push(
      has('totalWallCount')
        ? `${result.wallCount}/${result.totalWallCount} wall segments (this floor / whole scene)`
        : `${result.wallCount} wall segments`
    );
  }
  if (has('solidCells')) parts.push(`${result.solidCells} solid`);
  if (has('openCells')) parts.push(`${result.openCells} open to the exterior`);
  if (has('enclosedCells')) {
    parts.push(`${result.enclosedCells} sealed${has('enclosedPct') ? ` (${result.enclosedPct}%)` : ''}`);
  }
  if (parts.length === 0) return `baked (${result.reason ?? 'no reason given'}) — but it reported no cell counts.`;

  const head = `baked (${result.reason ?? 'no reason given'}): ${parts.join(', ')}.`;
  // The one genuinely actionable reading: no open cells means wind cannot get in
  // anywhere, which is what "the map is sealed" looks like from the bake's side.
  if (has('openCells') && result.openCells === 0 && has('cols')) {
    return `${head} NOTHING is open to the exterior, so ambient wind reaches nowhere on this floor.`;
  }
  return head;
}

export function nearestCell(x, y, grid) {
  const cols = Math.max(0, Math.floor(grid?.cols) || 0);
  const rows = Math.max(0, Math.floor(grid?.rows) || 0);
  if (cols <= 0 || rows <= 0) return null;
  const cellSize = Number.isFinite(grid.cellSize) && grid.cellSize > 0 ? grid.cellSize : 1;
  const originX = Number(grid.originX) || 0;
  const originY = Number(grid.originY) || 0;
  const col = Math.min(cols - 1, Math.max(0, Math.floor((x - originX) / cellSize)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y - originY) / cellSize)));
  return { col, row, index: row * cols + col };
}

/**
 * Search a small window around a cell for the nearest SOLID cell, reporting
 * the distance in CELLS (Euclidean) — a diagnostic-only cousin of
 * `world/wind-bake.js#applyWakeTurbulence`'s own internal search, but with a
 * caller-chosen radius (default wider than the wake gate's own
 * `WAKE_TURBULENCE_SHELL_CELLS`=2, since a human asking "how far am I from a
 * wall" wants the answer even outside the wake's own reach).
 *
 * @param {{col:number, row:number}} cell
 * @param {Uint8Array} solid @param {number} cols @param {number} rows
 * @param {number} [searchRadiusCells=8]
 * @returns {number|null} cells to the nearest solid cell, or null if none
 *   found within the search radius (never `Infinity` in a JSON-friendly report).
 */
export function nearestSolidDistanceCells({ col, row }, solid, cols, rows, searchRadiusCells = 8) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const n = c * r;
  const mask = solid instanceof Uint8Array && solid.length === n ? solid : new Uint8Array(n);
  const radius = Math.max(0, Math.floor(searchRadiusCells) || 0);
  let best = Infinity;
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (dc === 0 && dr === 0) continue;
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nc >= c || nr < 0 || nr >= r) continue;
      if (!mask[nr * c + nc]) continue;
      const d = Math.hypot(dc, dr);
      if (d < best) best = d;
    }
  }
  return Number.isFinite(best) ? round2(best) : null;
}

/**
 * THE GROUND-TRUTH DECOMPOSITION — "what does the CPU-side bake say SHOULD
 * be true at this exact world position," broken into named terms instead of
 * one fused total. This is what the wind overlay and the particle kernel
 * BOTH ultimately read from (the same grid, the same nearest-cell lookup);
 * this function just makes each term individually visible.
 *
 * ============================================================================
 * 2026-07-22 — THE RETHINK (read `docs/planning/Wind-Rethink.md` first)
 * ============================================================================
 * This used to report FIVE separate mechanisms (a wall-relaxation deviation,
 * a wake-turbulence delta, a painted-mask exposure grid, a door-chaos
 * distance field, a windReach decay) that all, one way or another, could be
 * traced back to the painted `_Outdoors` mask deciding wind PRESENCE — the
 * exact bug the author proved by deleting every wall in the scene and
 * finding wind still died at the mask's boundary. All five are gone. There
 * is now exactly ONE geometry-derived number, `openness`, and the coherent
 * wind is simply `ambientBias × openness` — no relaxation, no painted mask,
 * nothing left to reconcile.
 *
 * HONEST GAP, stated once here rather than re-litigated per caller: the
 * ORGANIC gust/flutter noise term (`world/wind-field.js#sampleWind`'s own
 * `mx_noise_float` calls) is GPU/TSL-only — there is no bit-exact CPU
 * reproduction of it in this codebase (this file's whole point is staying
 * pure and Node-testable). `coherentTotal` below therefore excludes it — a
 * real, useful ballpark for the direction-following push, but it will always
 * read a little different from a live GPU sample, which additionally carries
 * the organic term. `findNearestParticles`'s own GPU-sourced numbers are the
 * place to see that term's real contribution.
 *
 * @param {object} args
 * @param {number} args.x @param {number} args.y - world position to probe.
 * @param {number} args.ambientX @param {number} args.ambientY - the current
 *   ambient vector (`world/wind-bake.js#ambientVectorFromWind`'s own output).
 * @param {{solid:Uint8Array, openness:number[]|Float32Array,
 *   windShadow?:number[]|Float32Array, cols:number, rows:number,
 *   originX:number, originY:number, cellSize:number}} args.openness -
 *   the wind handle's own grid spec + per-cell arrays — THE one geometry-derived
 *   grid every consumer (particles, gusts, sampleWind) now reads. `windShadow`
 *   is optional so a caller predating it still reports (as "no shadow") rather
 *   than throwing.
 * @param {number|null} [args.paintedExposure] - REFERENCE ONLY, does NOT
 *   influence wind: the painted `_Outdoors` mask's raw value at this exact
 *   position (`world/index.js#sampleWindExposureAt`), included purely so a
 *   report can show "the paint says X but geometry says Y, and Y is what the
 *   wind actually does" side by side — the exact confusion this rethink
 *   exists to end. Omitted -> reports `null`.
 * @param {number} [args.nearestSolidSearchCells=8]
 * @returns {object} the full breakdown — see inline fields.
 */
export function decomposeWindAt({
  x,
  y,
  ambientX = 0,
  ambientY = 0,
  openness,
  paintedExposure = null,
  nearestSolidSearchCells = 8,
}) {
  const ax = Number.isFinite(ambientX) ? ambientX : 0;
  const ay = Number.isFinite(ambientY) ? ambientY : 0;
  const cell = nearestCell(x, y, openness);
  if (!cell) {
    return {
      ok: false,
      reason: 'the openness grid is degenerate (zero cols/rows) — no bake has run yet',
    };
  }
  const { index } = cell;
  const isSolid = !!openness.solid?.[index];
  const opennessValue = Math.max(0, Math.min(1, openness.openness?.[index] ?? 1));
  // THE WIND SHADOW (2026-08-01) — folded in here the same day it landed in
  // `sampleWind`/`kernel()`, because a probe reporting `ambientBias × openness`
  // while the renderer applies a third factor is an instrument that lies:
  // "coherentTotal says 0.6 but the grass isn't moving" would send the next
  // investigation somewhere there is no bug. Absent (a bake from before this
  // existed, or a caller that doesn't pass it) reads 0 = no shadow.
  const shadowValue = Math.max(0, Math.min(1, openness.windShadow?.[index] ?? 0));
  const shelterFactor = 1 - shadowValue * WIND_SHADOW_DEPTH;

  const coherentX = ax * opennessValue * shelterFactor;
  const coherentY = ay * opennessValue * shelterFactor;

  return {
    ok: true,
    world: { x: round2(x), y: round2(y) },
    cell: { col: cell.col, row: cell.row },
    solid: isSolid,
    // 1 = connected to the map's open EXTERIOR through open space
    // (walls/doors only); 0 = sealed off. THE number for "why does this cell
    // have coherent wind" — with no walls at all this reads 1 everywhere.
    openness: round2(opennessValue),
    // 0..1 RAW upwind occlusion — is a building between this cell and the
    // incoming wind. DIRECTIONAL, unlike `openness`: turning the compass moves
    // it to the other side of the same building. Reported raw, alongside the
    // `shelterFactor` it becomes, so "the geometry found nothing" is
    // distinguishable from "the geometry found it but the look constant is
    // gentle".
    windShadow: round2(shadowValue),
    shelterFactor: round2(shelterFactor),
    nearestSolidDistanceCells: nearestSolidDistanceCells(
      cell,
      openness.solid,
      openness.cols,
      openness.rows,
      nearestSolidSearchCells
    ),
    paintedExposureForReference: Number.isFinite(paintedExposure) ? round2(paintedExposure) : null,
    ambientBias: { x: round2(ax), y: round2(ay) },
    // THE coherent (direction-following) wind this cell ACTUALLY feels —
    // ambientBias × openness × shelterFactor. A sealed cell reads exactly
    // {0,0} regardless of ambientBias's own strength; an open, unsheltered
    // cell reads the full ambient.
    coherentTotal: { x: round2(coherentX), y: round2(coherentY), mag: round2(Math.hypot(coherentX, coherentY)) },
    note:
      'coherentTotal = ambientBias × openness × shelterFactor is what the particles/gusts ACTUALLY feel. ' +
      'The two geometry gates answer DIFFERENT questions and both apply: `openness` (post-Rethink 2026-07-22) ' +
      'is isotropic "does outside air reach here at all" — a sealed cell reads 0 whichever way the wind blows; ' +
      '`windShadow` (2026-08-01) is directional "is a building between me and the wind right now" — it moves to ' +
      'the other side of the same building when the compass turns. A cell can be fully open AND fully shadowed. ' +
      "coherentTotal excludes sampleWind's GPU-only organic gust/flutter noise term (findNearestParticles' own " +
      'live readback is the place to see that), which is deliberately NOT shadowed — sheltered air still stirs. ' +
      'paintedExposureForReference does NOT influence coherentTotal at all — it is shown purely to contrast ' +
      'against `openness` when cross-checking a report; if they disagree, that is expected, not a bug.',
  };
}

/**
 * Select the N particles nearest a query point from an already-decoded list
 * — pure selection/sort, so the GPU readback (which knows about buffer
 * strides and typed arrays) stays entirely in `particle-runtime.js`'s own
 * glue layer and this stays Node-testable with plain objects.
 *
 * @param {object} args
 * @param {Array<{i:number, pos:[number,number], vel:[number,number], [key:string]:*}>} args.particles -
 *   decoded samples (any extra fields, e.g. exposure/structure/stillness,
 *   pass through untouched).
 * @param {number} args.queryX @param {number} args.queryY
 * @param {number} [args.maxResults=12]
 * @param {number} [args.maxDistancePx=Infinity] - drop anything farther than this.
 * @returns {Array<object>} the nearest matches, nearest first, each with an
 *   added `distancePx`.
 */
export function findNearestParticles({ particles, queryX, queryY, maxResults = 12, maxDistancePx = Infinity }) {
  const list = Array.isArray(particles) ? particles : [];
  const qx = Number(queryX);
  const qy = Number(queryY);
  const cap = Number.isFinite(maxDistancePx) ? maxDistancePx : Infinity;
  const withDist = [];
  for (const p of list) {
    const px = p?.pos?.[0];
    const py = p?.pos?.[1];
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(qx) || !Number.isFinite(qy)) continue;
    const d = Math.hypot(px - qx, py - qy);
    if (d > cap) continue;
    withDist.push({ ...p, distancePx: round2(d) });
  }
  withDist.sort((a, b) => a.distancePx - b.distancePx);
  const n = Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 12;
  return withDist.slice(0, n);
}

/**
 * A small aggregate over a nearest-particles selection — mean speed, a
 * circular mean direction (the SAME mean-resultant-length shape
 * `particle-runtime.js#circularSpreadDeg` already uses, duplicated here in
 * miniature rather than imported, so this pure module stays independent of
 * `effects/particles/`'s own zone), and mean openness. Returns `null` for an
 * empty selection rather than NaN-filled zeros — an empty summary must read
 * as "nothing nearby", never as "everything reads zero".
 *
 * @param {Array<{vel:[number,number], openness?:number}>} nearest - `findNearestParticles`'s own output.
 * @returns {{count:number, meanSpeed:number, meanDirectionDeg:number|null, directionAlignment:number|null, meanOpenness:number|null}|null}
 */
export function summarizeNearestParticles(nearest) {
  const list = Array.isArray(nearest) ? nearest : [];
  if (list.length === 0) return null;
  let speedSum = 0;
  let sx = 0;
  let sy = 0;
  let moving = 0;
  let opnSum = 0;
  let opnCount = 0;
  for (const p of list) {
    const vx = p?.vel?.[0];
    const vy = p?.vel?.[1];
    if (Number.isFinite(vx) && Number.isFinite(vy)) {
      const mag = Math.hypot(vx, vy);
      speedSum += mag;
      if (mag > 0.01) {
        sx += vx / mag;
        sy += vy / mag;
        moving++;
      }
    }
    if (Number.isFinite(p?.openness)) {
      opnSum += p.openness;
      opnCount++;
    }
  }
  const R = moving > 0 ? Math.hypot(sx, sy) / moving : 0;
  return {
    count: list.length,
    meanSpeed: round2(speedSum / list.length),
    meanDirectionDeg: moving > 0 ? Math.round((Math.atan2(sy, sx) * 180) / Math.PI) : null,
    directionAlignment: moving > 0 ? round2(R) : null,
    meanOpenness: opnCount > 0 ? round2(opnSum / opnCount) : null,
  };
}
