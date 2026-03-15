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
      const center = c?.center && Number.isFinite(c.center.x) && Number.isFinite(c.center.y)
        ? { x: Number(c.center.x), y: Number(c.center.y) }
        : null;
      if (!center) continue;

      const from = this._resolveFloorKey(c?.fromFloor, bands);
      const to = this._resolveFloorKey(c?.toFloor, bands);
      if (!from || !to || from === to) continue;

      out.push({
        portalId: String(c?.portalId || ''),
        source: String(c?.source || 'unknown'),
        bidirectional: c?.bidirectional !== false,
        fromFloorKey: from,
        toFloorKey: to,
        entry: { ...center },
        exit: c?.exit && Number.isFinite(c.exit.x) && Number.isFinite(c.exit.y)
          ? { x: Number(c.exit.x), y: Number(c.exit.y) }
          : { ...center },
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
