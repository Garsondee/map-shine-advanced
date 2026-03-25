/**
 * @fileoverview Levels editor domain helpers.
 * @module ui/levels-editor/levels-domain
 */

import {
  readSceneLevelsFlag,
  readTileLevelsFlags,
  tileHasLevelsRange,
} from '../../foundry/levels-scene-flags.js';

export const TILE_LEVEL_ROLES = Object.freeze({
  NONE: 'none',
  FLOOR: 'floor',
  CEILING: 'ceiling',
  FILLER: 'filler',
});

const ROLE_SET = new Set(Object.values(TILE_LEVEL_ROLES));
const MODULE_NS = 'map-shine-advanced';
const ROLE_FLAG_KEY = 'levelRole';
const ROLE_LEVEL_FLAG_KEY = 'levelRoleBand';

function _toFiniteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _toRole(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ROLE_SET.has(v) ? v : TILE_LEVEL_ROLES.NONE;
}

/**
 * Normalize `flags.levels.sceneLevels` into sorted finite bands.
 * @param {Scene|null|undefined} scene
 * @returns {Array<{index:number,label:string,bottom:number,top:number,center:number}>}
 */
export function normalizeSceneLevelBands(scene) {
  const raw = readSceneLevelsFlag(scene);
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const bottom = _toFiniteOr(entry.bottom ?? entry.rangeBottom, -Infinity);
    const top = _toFiniteOr(entry.top ?? entry.rangeTop, Infinity);
    const lo = Math.min(bottom, top);
    const hi = Math.max(bottom, top);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const label = String(entry.label ?? entry.name ?? `Level ${i + 1}`);
    out.push({
      index: i,
      label,
      bottom: lo,
      top: hi,
      center: (lo + hi) * 0.5,
    });
  }
  out.sort((a, b) => (a.bottom - b.bottom) || (a.top - b.top));
  return out.map((band, idx) => ({ ...band, index: idx }));
}

/**
 * Find nearest matching band for a vertical range.
 * @param {{rangeBottom:number, rangeTop:number}} range
 * @param {Array<{index:number,bottom:number,top:number,center:number}>} bands
 * @returns {number} Band index or -1
 */
export function resolveBandIndexForRange(range, bands) {
  if (!Array.isArray(bands) || bands.length === 0) return -1;
  const rb = _toFiniteOr(range?.rangeBottom, NaN);
  const rt = _toFiniteOr(range?.rangeTop, NaN);
  if (!Number.isFinite(rb) || !Number.isFinite(rt)) return -1;

  let best = -1;
  let bestOverlap = -Infinity;
  for (let i = 0; i < bands.length; i += 1) {
    const b = bands[i];
    const overlap = Math.min(rt, b.top) - Math.max(rb, b.bottom);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  }

  const mid = (rb + rt) * 0.5;
  for (let i = 0; i < bands.length; i += 1) {
    const b = bands[i];
    if (mid >= b.bottom && mid < b.top) return i;
  }
  return best;
}

/**
 * Read a tile role from module flags.
 * @param {object} tileDoc
 * @returns {'none'|'floor'|'ceiling'|'filler'}
 */
export function getTileLevelRole(tileDoc) {
  const raw = tileDoc?.flags?.[MODULE_NS]?.[ROLE_FLAG_KEY];
  return _toRole(raw);
}

/**
 * Read a tile's explicit role-band assignment.
 * @param {object} tileDoc
 * @returns {number|null}
 */
export function getTileRoleBandIndex(tileDoc) {
  const n = Number(tileDoc?.flags?.[MODULE_NS]?.[ROLE_LEVEL_FLAG_KEY]);
  return Number.isInteger(n) ? n : null;
}

/**
 * Build a role projection update object for `tileDoc.update`.
 * @param {'none'|'floor'|'ceiling'|'filler'} role
 * @param {number|null} bandIndex
 * @returns {object}
 */
export function createTileRoleFlagUpdate(role, bandIndex = null) {
  const nextRole = _toRole(role);
  const out = {
    flags: {
      [MODULE_NS]: {
        [ROLE_FLAG_KEY]: nextRole,
      },
    },
  };
  if (Number.isInteger(bandIndex)) {
    out.flags[MODULE_NS][ROLE_LEVEL_FLAG_KEY] = Number(bandIndex);
  } else {
    out.flags[MODULE_NS][`-=${ROLE_LEVEL_FLAG_KEY}`] = null;
  }
  return out;
}

/**
 * Infer a default role from existing tile + Levels data.
 * @param {object} tileDoc
 * @param {Array<{index:number,bottom:number,top:number}>} bands
 * @returns {'none'|'floor'|'ceiling'|'filler'}
 */
export function inferTileLevelRole(tileDoc, bands = []) {
  if (!tileDoc) return TILE_LEVEL_ROLES.NONE;
  if (!tileHasLevelsRange(tileDoc)) return TILE_LEVEL_ROLES.NONE;
  const flags = readTileLevelsFlags(tileDoc);
  const top = _toFiniteOr(flags.rangeTop, Infinity);
  if (!Number.isFinite(top) || top === Infinity) return TILE_LEVEL_ROLES.CEILING;
  const bottom = _toFiniteOr(flags.rangeBottom, Number(tileDoc?.elevation ?? 0));
  if (Math.abs(top - bottom) <= 2) return TILE_LEVEL_ROLES.FLOOR;
  const idx = resolveBandIndexForRange(flags, bands);
  if (idx >= 0) {
    const b = bands[idx];
    if (Math.abs(bottom - b.bottom) <= 1) return TILE_LEVEL_ROLES.FLOOR;
    if (Math.abs(top - b.top) <= 1) return TILE_LEVEL_ROLES.CEILING;
  }
  return TILE_LEVEL_ROLES.FILLER;
}

/**
 * Build normalized tile-role records for editor rendering/migration.
 * @param {Scene|null|undefined} scene
 * @returns {Array<{id:string,name:string,bandIndex:number,role:string,elevation:number,rangeBottom:number,rangeTop:number}>}
 */
export function buildTileRoleRecords(scene) {
  const bands = normalizeSceneLevelBands(scene);
  const tiles = Array.from(scene?.tiles ?? []);
  const out = [];
  for (const tileDoc of tiles) {
    const range = readTileLevelsFlags(tileDoc);
    const bandIndex = resolveBandIndexForRange(range, bands);
    const role = getTileLevelRole(tileDoc) || inferTileLevelRole(tileDoc, bands);
    out.push({
      id: String(tileDoc.id || ''),
      name: String(tileDoc.texture?.src || tileDoc.img || tileDoc.id || 'Tile'),
      bandIndex,
      role,
      elevation: _toFiniteOr(tileDoc.elevation, 0),
      rangeBottom: _toFiniteOr(range.rangeBottom, _toFiniteOr(tileDoc.elevation, 0)),
      rangeTop: _toFiniteOr(range.rangeTop, Infinity),
    });
  }
  return out;
}

/**
 * Backfill missing tile role flags using existing Levels ranges.
 * Safe migration: only writes missing/invalid role values.
 * @param {Scene|null|undefined} scene
 * @returns {Promise<number>} Number of updated tiles
 */
export async function migrateSceneTileRoles(scene) {
  const bands = normalizeSceneLevelBands(scene);
  const updates = [];
  for (const tileDoc of Array.from(scene?.tiles ?? [])) {
    const rawRole = tileDoc?.flags?.[MODULE_NS]?.[ROLE_FLAG_KEY];
    if (ROLE_SET.has(String(rawRole ?? '').toLowerCase())) continue;
    const role = inferTileLevelRole(tileDoc, bands);
    const range = readTileLevelsFlags(tileDoc);
    const bandIndex = resolveBandIndexForRange(range, bands);
    updates.push({
      _id: tileDoc.id,
      flags: {
        [MODULE_NS]: {
          [ROLE_FLAG_KEY]: role,
          [ROLE_LEVEL_FLAG_KEY]: Number.isInteger(bandIndex) ? bandIndex : null,
        },
      },
    });
  }
  if (!updates.length) return 0;
  await scene.updateEmbeddedDocuments('Tile', updates);
  return updates.length;
}

/**
 * Build consistent elevation/range update that keeps `elevation` and
 * `flags.levels.rangeBottom` aligned to the same floor boundary.
 * @param {object} tileDoc
 * @param {{bottom:number,top:number}} band
 * @returns {object}
 */
export function createTileBandProjectionUpdate(tileDoc, band) {
  const bottom = _toFiniteOr(band?.bottom, _toFiniteOr(tileDoc?.elevation, 0));
  const top = _toFiniteOr(band?.top, Infinity);
  return {
    elevation: bottom,
    flags: {
      levels: {
        rangeBottom: bottom,
        rangeTop: top,
      },
    },
  };
}
