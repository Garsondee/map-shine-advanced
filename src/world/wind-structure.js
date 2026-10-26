/**
 * THE WIND BAKE, SPLIT BY WHAT EACH PIECE DEPENDS ON (2026-10-07).
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * `vt-pan-viewer.js#bakeWindField` used to be one 600-line closure that, on
 * EVERY change of the wind dial, re-read the walls, re-rasterized and
 * flood-filled a multi-million-cell fine grid, rebuilt every texture, and then
 * threw away and rebuilt every wind-reading shader in the scene (all point
 * lights, the candle flames, the overlays). The author reported a 10+ second
 * freeze each time the dial left 0%. Measured: the CPU half of that bake is
 * 40–280 ms even at 3.2M fine cells — the freeze was the shader rebuild it
 * triggered, in front of the player, after the load-time warm-up that exists to
 * hide exactly that.
 *
 * The bake is really three computations with three different triggers, and only
 * the first is expensive:
 *
 *   1. STRUCTURE — {@link bakeWindStructure}. Walls, doors, floor. The rasterize
 *      + flood-fills + distance transforms. Depends on NOTHING the dial can
 *      change. Runs at load, and again on a wall/door/floor edit.
 *   2. OPENNESS — {@link deriveWindOpenness}. How far an open door's air
 *      penetrates scales with wind speed (`doorReachScaleForWindSpeed`). A
 *      single O(coarse cells) pass over structure's two small arrays.
 *   3. SHADOW — {@link deriveWindShadow}. Which cells a building shelters from
 *      the wind is a function of DIRECTION. One O(coarse cells × reach) march.
 *
 * Splitting them is what lets a dial change cost a few milliseconds and
 * rewrite two texture channels IN PLACE, instead of redoing (1) and rebuilding
 * the world around it.
 *
 * PURE — no THREE, no Foundry, no TSL. The two things that need THREE (the
 * texture constructors, which `gpu/textures-in-vt-only` keeps in vt/, and
 * `DataUtils.toHalfFloat`) are injected, so this whole file is Node-tested end
 * to end (CONVENTIONS §4).
 *
 * @module world/wind-structure
 */
import { rasterizeWallsToGrid, windFlowVector } from './wind-bake.js';
import {
  floodFillOpenFromBoundary,
  cropGridMargin,
  distanceFromDoorThreshold,
  downsampleOpennessClasses,
  opennessFalloffFromDistance,
  doorReachScaleForWindSpeed,
  DOOR_FALLOFF_REACH_CELLS,
  distanceFromNearestSolid,
  wallAvoidanceDirectionFromDistance,
  wallProximityFromDistance,
  WALL_DEFLECT_REACH_CELLS,
  upwindShelter,
} from './wind-enclosure.js';

/**
 * How many times finer than the consumption grid the connectivity flood-fill
 * runs. A narrow real doorway fuses shut at coarse resolution (author-confirmed
 * live, 2026-07-22), so connectivity is decided fine and reduced afterwards.
 */
export const WIND_OPENNESS_REFINE = 4;

/**
 * Fine cells of open padding added on every side of the flood-fill grid, so a
 * building whose wall sits ON the scene edge still has a genuinely open
 * neighbour to separate it from the grid's own border (which the fill treats as
 * outside). Cropped back off before anything downstream sees it
 * (2026-07-23 map-edge leak; see `cropGridMargin`).
 */
export const WIND_OPENNESS_MARGIN_CELLS = WIND_OPENNESS_REFINE * 2;

/**
 * @typedef {object} WindGridSpec
 * @property {number} minX @property {number} minY - world px of cell (0,0)'s corner.
 * @property {number} cols @property {number} rows
 * @property {number} cellSize - world px per coarse cell.
 */

/**
 * @typedef {object} WindStructure
 * @property {WindGridSpec} gridSpec
 * @property {number} cols @property {number} rows
 * @property {Uint8Array} solidMask - coarse wall rasterization, 1 = wall.
 * @property {Float32Array} wallAvoidDirX @property {Float32Array} wallAvoidDirY
 * @property {Float32Array} wallProximity
 * @property {Float32Array} exterior - 1 where a coarse cell is genuinely outdoors (never behind a door) and has no sealed pocket.
 * @property {Float32Array} sky - 0..1 per coarse cell: the painted `_Outdoors` value there (1 = open sky, 0 = under a roof),
 *   or 1 where no mask was supplied / the cell is off the mask. NOT wind: it answers "does rain fall here", which a walled
 *   yard and a closed room answer differently from how the wall bake does. Read by fire's weather stress.
 * @property {Int32Array} doorDistance - threshold distance in FINE cells for a cell reached only through an open door, else -1.
 */

/**
 * THE FINE CONNECTIVITY PASS — the expensive half of the structure bake, and
 * the input both openness reductions (the old "any reached cell wins" and the
 * current "sealed side wins") consume. Exported so a test can run BOTH rules on
 * identical fine data and prove the old one leaked.
 *
 * Rasterizes the walls on a grid {@link WIND_OPENNESS_REFINE}× finer than the
 * consumption grid, padded by {@link WIND_OPENNESS_MARGIN_CELLS}, flood-fills
 * from the border twice (doors passable / doors always solid), measures
 * distance from each open door's threshold, and crops the padding back off.
 *
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,solid:boolean,blocksExterior:boolean}>} walls
 * @param {WindGridSpec} gridSpec
 * @returns {{fineSolid: Uint8Array, fineOpen: Uint8Array, fineOpenExterior: Uint8Array, fineDoorDistance: Int32Array}}
 *   every array is `(cols×refine) × (rows×refine)`, row-major.
 */
export function computeFineConnectivity(walls, gridSpec) {
  const { cols, rows } = gridSpec;
  const refine = WIND_OPENNESS_REFINE;
  const margin = WIND_OPENNESS_MARGIN_CELLS;
  const fineCellSize = gridSpec.cellSize / refine;
  const fineCols = cols * refine;
  const fineRows = rows * refine;
  const padded = {
    minX: gridSpec.minX - margin * fineCellSize,
    minY: gridSpec.minY - margin * fineCellSize,
    cols: fineCols + margin * 2,
    rows: fineRows + margin * 2,
    cellSize: fineCellSize,
  };
  const crop = (grid) => cropGridMargin(grid, padded.cols, padded.rows, margin);

  const paddedSolid = rasterizeWallsToGrid(walls, padded, { superCover: false });
  const fineSolid = crop(paddedSolid);
  const fineOpen = crop(floodFillOpenFromBoundary(paddedSolid, padded.cols, padded.rows));

  // The same fill with every door — open OR closed — as a barrier: "reachable
  // without ever crossing a door" is what genuinely-outdoors means.
  const wallsExteriorView = walls.map((w) => ({ ...w, solid: w.blocksExterior }));
  const paddedSolidExterior = rasterizeWallsToGrid(wallsExteriorView, padded, { superCover: false });
  const fineOpenExterior = crop(floodFillOpenFromBoundary(paddedSolidExterior, padded.cols, padded.rows));

  const fineDoorDistance = distanceFromDoorThreshold(fineOpen, fineOpenExterior, fineCols, fineRows);
  return { fineSolid, fineOpen, fineOpenExterior, fineDoorDistance };
}

/**
 * A coarse cell whose painted `_Outdoors` value is at least this reads as open
 * sky ({@link applyOpenSky}).
 */
export const OPEN_SKY_THRESHOLD = 0.5;

/**
 * The painted `_Outdoors` mask, sampled at the centre of every coarse wind cell.
 *
 * @param {{spec:{x:number,y:number,width:number,height:number,w:number,h:number}, data:ArrayLike<number>}|null|undefined} grid
 *   the mask authority's outdoors grid (row 0 = minY, 0..255).
 * @param {WindGridSpec} gridSpec
 * @returns {Float32Array|null} cols×rows in [0,1], or `null` for a cell off the
 *   mask's rect (that cell keeps whatever the geometry said), or no grid at all.
 */
export function sampleOutdoorsAtCells(grid, gridSpec) {
  const s = grid?.spec;
  const data = grid?.data;
  if (!s || !data || !(s.w > 0) || !(s.h > 0) || !(s.width > 0) || !(s.height > 0)) return null;
  if (data.length < s.w * s.h) return null;
  const { cols, rows, cellSize, minX, minY } = gridSpec;
  const out = new Float32Array(cols * rows).fill(-1);
  const texelW = s.width / s.w;
  const texelH = s.height / s.h;
  for (let r = 0; r < rows; r++) {
    const ty = Math.floor((minY + (r + 0.5) * cellSize - s.y) / texelH);
    if (ty < 0 || ty >= s.h) continue;
    for (let c = 0; c < cols; c++) {
      const tx = Math.floor((minX + (c + 0.5) * cellSize - s.x) / texelW);
      if (tx < 0 || tx >= s.w) continue;
      out[r * cols + c] = data[ty * s.w + tx] / 255;
    }
  }
  return out;
}

/**
 * OPEN SKY IS NOT A SEALED ROOM (2026-10-19). Wall connectivity alone reads a
 * yard enclosed by a perimeter wall as a closed pocket — openness exactly 0 — so
 * a campfire standing in the open air of a walled compound felt no wind at all
 * (author: "it's clearly outdoors, wind is nearly full strength, the fire isn't
 * concerned at all"). Walls decide where wind goes through a DOOR; whether a
 * space has a ROOF is the `_Outdoors` mask's question. A walled cell that is
 * painted open sky now counts as exterior — it reaches 1 at every speed, like any
 * open ground.
 *
 * Only ever RAISES a cell, so the no-walls case (everything already 1) and every
 * roofed room (mask dark) are exactly what geometry alone said. Solid cells are
 * left alone: a wall belongs to neither side.
 *
 * @param {WindStructure} structure - mutated in place (`exterior`, `doorDistance`).
 * @param {Float32Array|null} outdoors - from {@link sampleOutdoorsAtCells}.
 * @returns {number} how many cells were raised.
 */
export function applyOpenSky(structure, outdoors) {
  if (!outdoors || outdoors.length !== structure.exterior.length) return 0;
  let raised = 0;
  for (let i = 0; i < outdoors.length; i++) {
    if (structure.exterior[i] === 1 || structure.solidMask[i]) continue;
    if (outdoors[i] >= OPEN_SKY_THRESHOLD) {
      structure.exterior[i] = 1;
      structure.doorDistance[i] = -1;
      raised++;
    }
  }
  return raised;
}

/**
 * The per-cell sky exposure the particle kernels read: the sampled `_Outdoors` value, with "no opinion" (-1: no mask,
 * or a cell off the mask's rect) read as open sky. The same fallback `safeSampleOutdoors` documents for a missing mask.
 *
 * @param {Float32Array|null} sampled - from {@link sampleOutdoorsAtCells}.
 * @param {number} n - cell count.
 * @returns {Float32Array} length n, each in [0,1].
 */
export function skyExposureFromCells(sampled, n) {
  const out = new Float32Array(n).fill(1);
  if (!sampled || sampled.length !== n) return out;
  for (let i = 0; i < n; i++) if (sampled[i] >= 0) out[i] = Math.min(1, sampled[i]);
  return out;
}

/**
 * A cheap fingerprint of an outdoors grid: its rect and resolution plus a strided
 * checksum of the pixels. Two grids with the same signature bake the same wind,
 * which is what lets the mask-version poll skip the rebake when only an
 * unrelated mask moved.
 *
 * @param {{spec:object, data:ArrayLike<number>}|null|undefined} grid
 * @returns {string}
 */
export function outdoorsGridSignature(grid) {
  const s = grid?.spec;
  const data = grid?.data;
  if (!s || !data) return 'none';
  const n = Math.min(data.length, (s.w | 0) * (s.h | 0));
  const stride = Math.max(1, Math.floor(n / 8192));
  let sum = 0;
  let sky = 0;
  for (let i = 0; i < n; i += stride) {
    sum += data[i];
    if (data[i] >= OPEN_SKY_THRESHOLD * 255) sky++;
  }
  return `${s.w}x${s.h}@${s.x},${s.y},${s.width},${s.height}:${sum}:${sky}`;
}

/**
 * A fingerprint of a wall list: its length plus a rolling hash of every segment's
 * coordinates (to 1/8 px) and the two derived flags the structure bake reads
 * (`solid`, `blocksExterior`). Door state reaches the bake only through `solid`,
 * so an opened door changes the signature. Cheap — one pass, no allocation.
 *
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,solid?:boolean,blocksExterior?:boolean}>} walls
 * @returns {string}
 */
export function wallsSignature(walls) {
  let h = 0x811c9dc5 | 0;
  const mix = (v) => {
    h = Math.imul(h ^ (v | 0), 0x01000193);
  };
  for (const w of walls ?? []) {
    mix(Math.round(w.x1 * 8));
    mix(Math.round(w.y1 * 8));
    mix(Math.round(w.x2 * 8));
    mix(Math.round(w.y2 * 8));
    mix((w.solid ? 1 : 0) | (w.blocksExterior ? 2 : 0));
  }
  return `${(walls ?? []).length}:${h >>> 0}`;
}

let identitySeq = 0;
const identityIds = new WeakMap();
/**
 * A stable small id for an object, for building cache keys from "is this the same
 * array as last time". The mask authority hands back the SAME product object until
 * something that feeds it changes, so identity is an exact version stamp there.
 * @param {object|null|undefined} o @returns {number|string}
 */
export function objectIdentity(o) {
  if (!o || (typeof o !== 'object' && typeof o !== 'function')) return 'none';
  let id = identityIds.get(o);
  if (id === undefined) {
    id = ++identitySeq;
    identityIds.set(o, id);
  }
  return id;
}

/**
 * Memoise {@link bakeWindStructure} per floor (loading audit P-06, 2026-10-25).
 *
 * The structure bake (rasterise walls, flood-fill connectivity, distance fields)
 * is the 40-360 ms CPU part of a wind bake, and it used to run on the commit
 * frame of every floor change. It is a pure function of (walls, grid spec,
 * outdoors grid), so floor PREPARE can run it for the target floor while the old
 * one is still on screen, and the commit finds it already done.
 *
 * The key includes the outdoors grid's object identity AND its strided signature,
 * so a re-derived mask is never served a stale structure.
 *
 * @param {(args: object) => object} [bake] - injected for tests.
 */
export function createWindStructureMemo(bake = bakeWindStructure) {
  const byFloor = new Map();
  let hits = 0;
  let misses = 0;
  return {
    /**
     * @param {number|string} floorKey
     * @param {{walls: Array<object>, gridSpec: object, outdoors?: object|null}} inputs
     * @returns {{structure: object, hit: boolean}}
     */
    get(floorKey, { walls, gridSpec, outdoors = null }) {
      const key = [
        JSON.stringify(gridSpec),
        wallsSignature(walls),
        objectIdentity(outdoors?.data),
        outdoorsGridSignature(outdoors),
      ].join('|');
      const cached = byFloor.get(floorKey);
      if (cached && cached.key === key) {
        hits++;
        return { structure: cached.structure, hit: true };
      }
      misses++;
      const structure = bake({ walls, gridSpec, outdoors });
      byFloor.set(floorKey, { key, structure });
      return { structure, hit: false };
    },
    stats: () => ({ hits, misses, floors: byFloor.size }),
    clear() {
      byFloor.clear();
    },
  };
}

/**
 * Everything that depends on walls, doors and the viewed floor and on nothing
 * else. The expensive part of the old `bakeWindField`, unchanged in substance
 * except for the final reduction, which now lets a sealed pocket win
 * ({@link downsampleOpennessClasses}).
 *
 * @param {object} args
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,solid:boolean,blocksExterior:boolean}>} args.walls
 * @param {WindGridSpec} args.gridSpec - from `computeWindBakeGridSpec`.
 * @param {{spec:object, data:ArrayLike<number>}|null} [args.outdoors] - the viewed
 *   floor's painted `_Outdoors` grid. Omitted/null = geometry alone (a fixture
 *   with no mask authority). See {@link applyOpenSky}.
 * @returns {WindStructure}
 */
export function bakeWindStructure({ walls, gridSpec, outdoors = null }) {
  const { cols, rows } = gridSpec;

  // The COARSE solid mask: the wind probe's display, Tier 2's solid texture,
  // the wall-avoidance field and the shadow march all read this one.
  const solidMask = rasterizeWallsToGrid(walls, gridSpec);

  // WALL AVOIDANCE — direction/speed independent, so it belongs to structure.
  const wallDistance = distanceFromNearestSolid(solidMask, cols, rows);
  const wallAvoidDir = wallAvoidanceDirectionFromDistance(wallDistance, cols, rows);
  const wallProximity = wallProximityFromDistance(wallDistance, { reachCells: WALL_DEFLECT_REACH_CELLS });

  // CONNECTIVITY, fine, then reduced to the coarse grid with the sealed side
  // winning wherever a wall splits a coarse cell.
  const { exterior, doorDistance } = downsampleOpennessClasses(
    computeFineConnectivity(walls, gridSpec),
    cols,
    rows,
    WIND_OPENNESS_REFINE
  );

  const structure = {
    gridSpec,
    cols,
    rows,
    solidMask,
    wallAvoidDirX: wallAvoidDir.dirX,
    wallAvoidDirY: wallAvoidDir.dirY,
    wallProximity,
    exterior,
    doorDistance,
  };
  const outdoorsCells = sampleOutdoorsAtCells(outdoors, gridSpec);
  applyOpenSky(structure, outdoorsCells);
  structure.sky = skyExposureFromCells(outdoorsCells, cols * rows);
  return structure;
}

/**
 * HOW FAR THE WIND PUSHES IN, at this speed — the only thing about openness the
 * dial changes (`doorReachScaleForWindSpeed`: ×0.12 at a dead calm, ×2 at a
 * gale). One pass over structure's two arrays; nothing is re-flooded.
 *
 * Exactly 0 for a sealed cell at EVERY speed, exactly 1 for outdoors at every
 * speed — the dial only ever moves the fade between a door and the dark end of
 * a room.
 *
 * @param {WindStructure} structure @param {number} speed01
 * @returns {Float32Array} length cols×rows, each in [0,1].
 */
export function deriveWindOpenness(structure, speed01) {
  return opennessFalloffFromDistance(structure.doorDistance, structure.exterior, {
    reachCells: DOOR_FALLOFF_REACH_CELLS * WIND_OPENNESS_REFINE * doorReachScaleForWindSpeed(speed01),
  });
}

/**
 * THE WIND SHADOW at this direction — the one directional term in the bake.
 * `directionDeg` names where the wind blows TOWARD (`windFlowVector`), so the
 * direction it comes FROM — what a shelter search walks toward — is that
 * vector negated.
 *
 * @param {WindStructure} structure @param {number} directionDeg
 * @returns {Float32Array} length cols×rows, each in [0,1].
 */
export function deriveWindShadow(structure, directionDeg) {
  const flow = windFlowVector(directionDeg);
  return upwindShelter(structure.solidMask, structure.cols, structure.rows, {
    upwindX: -flow.x,
    upwindY: -flow.y,
  });
}

/**
 * Whether two grid specs describe the SAME grid. Consumers bake origin,
 * cellSize, cols and rows into their shader graphs as constants, so "same grid"
 * is precisely the condition under which a rebake can be written into the
 * existing textures and nothing needs rebuilding.
 *
 * @param {WindGridSpec|null|undefined} a @param {WindGridSpec|null|undefined} b
 * @returns {boolean}
 */
export function sameWindGrid(a, b) {
  return (
    !!a &&
    !!b &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.cellSize === b.cellSize &&
    a.minX === b.minX &&
    a.minY === b.minY
  );
}

/**
 * Fill an RGBA8 solid-mask array from the coarse 0/1 mask, in place.
 * @param {Uint8Array} out - length 4×n. @param {ArrayLike<number>} solidMask
 */
export function writeSolidMaskData(out, solidMask) {
  const n = Math.min(solidMask.length, Math.floor(out.length / 4));
  for (let i = 0; i < n; i++) {
    const v = solidMask[i] ? 255 : 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
}

// ── THE GRID STATE — WHAT STAYS ALIVE BETWEEN BAKES ─────────────────────────

/**
 * Everything that must SURVIVE a rebake, owned in one place and tested in Node:
 * the three textures, their backing arrays, the raw per-cell arrays the particle
 * kernels read, and the cached {@link WindStructure} a dial change re-derives
 * from. The viewer used to hold these as eleven loose `let`s inside a 28k-line
 * closure that no test could reach — and the property this object exists to
 * guarantee (a rebake on the same grid returns the SAME texture objects and the
 * SAME arrays, so no consumer's shader ever has to be rebuilt) is exactly the
 * kind that fails silently and only shows live.
 *
 * Textures are the one non-pure thing here, and `gpu/textures-in-vt-only` keeps
 * every `new …Texture(` in vt/ — so the three constructors arrive as an
 * injected FACTORY (`vt/wind-grid-textures.js`, which also owns the filter
 * choice and its test); everything else here is plain arrays.
 *
 * @param {object} args
 * @param {{createOpennessTexture: Function, createWallAvoidTexture: Function, createSolidMaskTexture: Function}} args.textures
 *   — `vt/wind-grid-textures.js#createWindGridTextureFactory(THREE)`.
 * @param {(v:number)=>number} args.toHalf - `THREE.DataUtils.toHalfFloat`.
 */
export function createWindGridState({ textures, toHalf }) {
  if (
    typeof textures?.createOpennessTexture !== 'function' ||
    typeof textures?.createWallAvoidTexture !== 'function' ||
    typeof textures?.createSolidMaskTexture !== 'function' ||
    typeof toHalf !== 'function'
  ) {
    // Loud, not defaulted: a grid state with no way to make textures would run
    // to the first bake and then fail somewhere unrelated (the seam-default trap).
    throw new TypeError('createWindGridState: `textures` (a wind texture factory) and `toHalf` are required.');
  }
  const half = toHalf;
  /** @type {WindStructure|null} */
  let structure = null;
  let cells = null;
  let opennessData = null;
  let wallAvoidData = null;
  let solidData = null;
  let opennessValues = null;
  let shadowValues = null;
  let opennessTexture = null;
  let wallAvoidTexture = null;
  let solidTexture = null;

  function writeOpenness(speed01) {
    opennessValues.set(deriveWindOpenness(structure, speed01));
    writeHalfFloatChannel(opennessData, OPENNESS_TEXTURE_CHANNELS.openness, opennessValues, half, 1);
    opennessTexture.needsUpdate = true;
  }

  function writeShadow(directionDeg) {
    shadowValues.set(deriveWindShadow(structure, directionDeg));
    writeHalfFloatChannel(wallAvoidData, WALL_AVOID_TEXTURE_CHANNELS.shadow, shadowValues, half, 0);
    wallAvoidTexture.needsUpdate = true;
  }

  return {
    /** The cached structure, or null before the first bake. */
    get structure() {
      return structure;
    },
    /** The raw per-cell arrays (`openness`/`windShadow` are stable across bakes). */
    get cells() {
      return cells;
    },
    get opennessTexture() {
      return opennessTexture;
    },
    get wallAvoidTexture() {
      return wallAvoidTexture;
    },
    get solidMaskTexture() {
      return solidTexture;
    },

    /**
     * Adopt a freshly baked structure. On the SAME grid every texture and every
     * array is rewritten in place (`regrid: false`, nothing for a consumer to
     * rebuild); on a different grid (or the first bake) all of it is replaced and
     * the old textures disposed (`regrid: true`).
     *
     * @param {WindStructure} next
     * @param {{speed01: number, directionDeg: number}} ambient - the dial's CURRENT value,
     *   so the dial-owned channels are derived from it, not from a stale default.
     * @returns {{regrid: boolean}}
     */
    applyStructure(next, { speed01, directionDeg }) {
      const regrid = !structure || !sameWindGrid(structure.gridSpec, next.gridSpec);
      if (regrid) {
        const { cols, rows } = next;
        const n = cols * rows;
        const old = [opennessTexture, wallAvoidTexture, solidTexture];
        opennessData = new Uint16Array(n * 4); // R/G stay 0 — Tier 2 reads them as a velocity
        wallAvoidData = new Uint16Array(n * 4);
        solidData = new Uint8Array(n * 4);
        opennessValues = new Float32Array(n);
        shadowValues = new Float32Array(n);
        // New textures first, old ones disposed after: never a moment with nothing bound.
        opennessTexture = textures.createOpennessTexture(opennessData, cols, rows);
        wallAvoidTexture = textures.createWallAvoidTexture(wallAvoidData, cols, rows);
        solidTexture = textures.createSolidMaskTexture(solidData, cols, rows);
        for (const tex of old) tex?.dispose();
      }
      // Assigned only once the grid state it describes EXISTS — a bake that throws
      // above must not leave a structure with no textures behind it.
      structure = next;
      cells = {
        solid: next.solidMask,
        openness: opennessValues,
        wallAvoidDirX: next.wallAvoidDirX,
        wallAvoidDirY: next.wallAvoidDirY,
        wallProximity: next.wallProximity,
        windShadow: shadowValues,
        sky: next.sky,
      };
      // Structure-owned channels (written only here)…
      writeHalfFloatChannel(opennessData, OPENNESS_TEXTURE_CHANNELS.exterior, next.exterior, half, 1);
      writeHalfFloatChannel(wallAvoidData, WALL_AVOID_TEXTURE_CHANNELS.dirX, next.wallAvoidDirX, half, 0);
      writeHalfFloatChannel(wallAvoidData, WALL_AVOID_TEXTURE_CHANNELS.dirY, next.wallAvoidDirY, half, 0);
      writeHalfFloatChannel(wallAvoidData, WALL_AVOID_TEXTURE_CHANNELS.proximity, next.wallProximity, half, 0);
      writeSolidMaskData(solidData, next.solidMask);
      solidTexture.needsUpdate = true;
      // …and the dial-owned ones, derived from the dial's CURRENT value.
      writeOpenness(speed01);
      writeShadow(directionDeg);
      return { regrid };
    },

    /**
     * Re-derive only what the dial changed, from the cached structure, and
     * rewrite just those channels. No structure bake, no allocation of textures.
     *
     * @param {{speed01: number, directionDeg: number}} ambient
     * @param {{speedChanged: boolean, directionChanged: boolean}} changed
     */
    applyAmbient({ speed01, directionDeg }, { speedChanged, directionChanged }) {
      if (!structure) return;
      if (speedChanged) writeOpenness(speed01);
      if (directionChanged) writeShadow(directionDeg);
    },

    dispose() {
      for (const tex of [opennessTexture, wallAvoidTexture, solidTexture]) tex?.dispose();
      structure = null;
      cells = null;
      opennessTexture = null;
      wallAvoidTexture = null;
      solidTexture = null;
    },
  };
}

// ── TEXTURE DATA — IN-PLACE WRITERS ─────────────────────────────────────────
// The textures are RGBA half-float, uploaded once and then REWRITTEN in place
// (same array, same DataTexture, `needsUpdate`), never replaced: a new texture
// object is a new binding, and a new binding is what used to force every
// consumer's material to be rebuilt.

/** Channel indices in the openness texture (see `sampleWind`'s `bakedField` doc). */
export const OPENNESS_TEXTURE_CHANNELS = Object.freeze({ openness: 2, exterior: 3 });
/** Channel indices in the wall-avoidance texture. */
export const WALL_AVOID_TEXTURE_CHANNELS = Object.freeze({ dirX: 0, dirY: 1, proximity: 2, shadow: 3 });

/**
 * Write one float array into one channel of an RGBA half-float array.
 *
 * @param {Uint16Array} data - length 4×n.
 * @param {number} channel - 0..3.
 * @param {ArrayLike<number>} values - length n.
 * @param {(v:number)=>number} toHalf - `THREE.DataUtils.toHalfFloat`.
 * @param {number} [fallback=0] - for a missing/NaN sample.
 */
export function writeHalfFloatChannel(data, channel, values, toHalf, fallback = 0) {
  const n = Math.min(values.length, Math.floor(data.length / 4));
  for (let i = 0; i < n; i++) {
    const v = values[i];
    data[i * 4 + channel] = toHalf(Number.isFinite(v) ? v : fallback);
  }
}
