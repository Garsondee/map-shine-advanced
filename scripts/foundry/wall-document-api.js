/**
 * V14-safe reads for WallDocument fields and CONST edge enums.
 *
 * Foundry v14 deprecates `CONST.WALL_SENSE_TYPES` / `CONST.WALL_DIRECTIONS`
 * (and legacy document getters) in favour of `CONST.EDGE_*`. Accessing the
 * deprecated CONST aliases calls `logCompatibilityWarning` on every property
 * read — catastrophic inside per-wall vision loops (candle glow clipping).
 *
 * @module foundry/wall-document-api
 */

/** @type {Readonly<Record<string, number>>|null} */
let _cachedEdgeSenseTypes = null;

/** @type {{ BOTH: number, LEFT: number, RIGHT: number }|null} */
let _cachedEdgeDirections = null;

const FALLBACK_SENSE_TYPES = Object.freeze({
  NONE: 0,
  LIMITED: 10,
  NORMAL: 20,
  PROXIMITY: 30,
  DISTANCE: 40,
});

const FALLBACK_DIRECTIONS = Object.freeze({
  BOTH: 0,
  LEFT: 1,
  RIGHT: 2,
});

/**
 * Edge sense enum without touching deprecated `CONST.WALL_SENSE_TYPES` on v14.
 * @returns {Readonly<Record<string, number>>}
 */
export function getEdgeSenseTypes() {
  if (_cachedEdgeSenseTypes) return _cachedEdgeSenseTypes;
  const edge = (typeof CONST !== 'undefined') ? CONST.EDGE_SENSE_TYPES : null;
  if (edge) {
    _cachedEdgeSenseTypes = edge;
    return edge;
  }
  // Pre-v14 only — avoid reading EDGE_SENSE_TYPES and WALL_SENSE_TYPES in one expression.
  const legacy = (typeof CONST !== 'undefined') ? CONST.WALL_SENSE_TYPES : null;
  _cachedEdgeSenseTypes = legacy ?? FALLBACK_SENSE_TYPES;
  return _cachedEdgeSenseTypes;
}

/**
 * Edge direction constants without touching deprecated `CONST.WALL_DIRECTIONS` on v14.
 * @returns {{ BOTH: number, LEFT: number, RIGHT: number }}
 */
export function getEdgeDirections() {
  if (_cachedEdgeDirections) return _cachedEdgeDirections;
  const edge = (typeof CONST !== 'undefined') ? CONST.EDGE_DIRECTIONS : null;
  if (edge) {
    _cachedEdgeDirections = {
      BOTH: Number(edge.BOTH ?? 0),
      LEFT: Number(edge.LEFT ?? 1),
      RIGHT: Number(edge.RIGHT ?? 2),
    };
    return _cachedEdgeDirections;
  }
  const legacy = (typeof CONST !== 'undefined') ? CONST.WALL_DIRECTIONS : null;
  _cachedEdgeDirections = {
    BOTH: Number(legacy?.BOTH ?? 0),
    LEFT: Number(legacy?.LEFT ?? 1),
    RIGHT: Number(legacy?.RIGHT ?? 2),
  };
  return _cachedEdgeDirections;
}

/**
 * Read a wall document field from `_source` when present.
 * @param {object|null|undefined} doc
 * @param {string} key
 * @returns {*}
 */
function readWallDocField(doc, key) {
  if (!doc || typeof doc !== 'object') return undefined;
  const src = doc._source;
  if (src && typeof src === 'object') {
    if (Object.prototype.hasOwnProperty.call(src, key)) return src[key];
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(doc, key)) return doc[key];
  return undefined;
}

/**
 * Read a scalar wall document field from `_source` when present (avoids v14
 * compatibility getters on live documents). Falls back to direct field access
 * for plain wall-like objects.
 *
 * @param {object|null|undefined} doc
 * @param {'sight'|'light'|'sound'|'move'|'dir'|'door'|'ds'} key
 * @returns {number}
 */
export function readWallDocScalar(doc, key) {
  const raw = readWallDocField(doc, key);
  if (raw == null) return 0;
  const v = Number(raw);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Wall restriction for vision / light polygon passes.
 * @param {object|null|undefined} doc
 * @param {'sight'|'light'} sense
 * @returns {number}
 */
export function readWallSenseRestriction(doc, sense) {
  return readWallDocScalar(doc, sense === 'light' ? 'light' : 'sight');
}

/**
 * True when a wall is a door that is open for LOS purposes.
 * @param {object|null|undefined} doc
 * @returns {boolean}
 */
export function wallDocDoorIsOpenForVision(doc) {
  const open = (typeof CONST !== 'undefined' && CONST.WALL_DOOR_STATES)
    ? CONST.WALL_DOOR_STATES.OPEN
    : 1;
  return readWallDocScalar(doc, 'door') > 0 && readWallDocScalar(doc, 'ds') === open;
}

/**
 * Foundry one-way wall direction from document / edge data.
 * @param {object|null|undefined} wall
 * @param {object|null|undefined} doc
 * @returns {number}
 */
export function readWallEdgeDirection(wall, doc) {
  const { BOTH, LEFT, RIGHT } = getEdgeDirections();
  let raw = readWallDocField(doc, 'dir');
  if (raw == null && wall) {
    raw = wall.edge?.direction ?? wall.edge?.dir;
  }
  const n = Number(raw);
  if (n === LEFT || n === RIGHT) return n;
  return BOTH;
}
