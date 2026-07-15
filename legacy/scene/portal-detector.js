import { createLogger } from '../core/log.js';

const log = createLogger('PortalDetector');

function asNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function floorKey(bottom, top) {
  const b = asNumber(bottom, NaN);
  const t = asNumber(top, NaN);
  if (!Number.isFinite(b) || !Number.isFinite(t)) return '';
  return `${b}:${t}`;
}

function readPoint(point) {
  const x = asNumber(point?.x, NaN);
  const y = asNumber(point?.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function mirrorPointAroundCenter(point, center) {
  const p = readPoint(point);
  const c = readPoint(center);
  if (!p || !c) return null;
  return {
    x: (2 * c.x) - p.x,
    y: (2 * c.y) - p.y
  };
}

/**
 * PortalDetector (foundation)
 *
 * Converts nav-mesh snapshot portal candidates into normalized portal links
 * between floor bands. This is intentionally permissive and best-effort for
 * now; only candidates with clear from/to floor ranges are emitted.
 */
export class PortalDetector {
  constructor() {
    this._lastPortals = [];
  }

  get lastPortals() {
    return this._lastPortals;
  }

  /**
   * @param {object} params
   * @param {object|null} params.snapshot
   * @param {Array<{elevationMin:number,elevationMax:number,compositorKey?:string}>} params.floorBands
   * @returns {Array<object>}
   */
  detectPortals({ snapshot = null, floorBands = [] } = {}) {
    const candidates = Array.isArray(snapshot?.portalCandidates) ? snapshot.portalCandidates : [];
    const bands = Array.isArray(floorBands) ? floorBands : [];
    const out = [];

    for (const c of candidates) {
      const center = readPoint(c?.center);
      if (!center) continue;

      const from = this._resolveFloorKey(c?.fromFloor, bands);
      const to = this._resolveFloorKey(c?.toFloor, bands);
      if (!from || !to || from === to) continue;

      const rawEntry = readPoint(c?.entry);
      const rawExit = readPoint(c?.exit);
      const entry = rawEntry || (rawExit ? mirrorPointAroundCenter(rawExit, center) : null) || { ...center };
      const exit = rawExit || (rawEntry ? mirrorPointAroundCenter(rawEntry, center) : null) || { ...center };

      out.push({
        portalId: String(c?.portalId || ''),
        source: String(c?.source || 'unknown'),
        bidirectional: c?.bidirectional !== false,
        fromFloorKey: from,
        toFloorKey: to,
        entry,
        exit,
        travelTimeMs: Math.max(0, asNumber(c?.travelTimeMs, 400) || 400)
      });
    }

    this._lastPortals = out;
    return out;
  }

  _resolveFloorKey(rawRange, floorBands) {
    if (rawRange && typeof rawRange === 'object') {
      const direct = floorKey(rawRange.bottom, rawRange.top);
      if (direct) return direct;

      // Allow elevation-only ranges by mapping to the containing band.
      const elev = asNumber(rawRange.elevation, NaN);
      if (Number.isFinite(elev)) {
        for (const band of floorBands) {
          const min = asNumber(band?.elevationMin, NaN);
          const max = asNumber(band?.elevationMax, NaN);
          if (Number.isFinite(min) && Number.isFinite(max) && elev >= min && elev <= max) {
            return String(band?.compositorKey || floorKey(min, max));
          }
        }
      }
    }
    return '';
  }

  logPortals(portals = this._lastPortals) {
    log.debug('portal detector output', {
      count: Array.isArray(portals) ? portals.length : 0,
      portals
    });
  }
}
