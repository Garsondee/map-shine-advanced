import { createLogger } from '../core/log.js';

const log = createLogger('MultiFloorGraph');

function asNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function distance(a, b) {
  const ax = asNumber(a?.x, NaN);
  const ay = asNumber(a?.y, NaN);
  const bx = asNumber(b?.x, NaN);
  const by = asNumber(b?.y, NaN);
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return Number.POSITIVE_INFINITY;
  return Math.hypot(ax - bx, ay - by);
}

/**
 * MultiFloorGraph (foundation)
 *
 * Holds floor bands + portal links and produces a coarse cross-floor route plan.
 * Current phase emits route metadata and portal hops only; token transition
 * execution is wired in later phases.
 */
export class MultiFloorGraph {
  constructor() {
    this._snapshot = null;
    this._floorBands = [];
    this._portals = [];
  }

  setData({ snapshot = null, floorBands = [], portals = [] } = {}) {
    this._snapshot = snapshot || null;
    this._floorBands = Array.isArray(floorBands) ? floorBands.slice() : [];
    this._portals = Array.isArray(portals) ? portals.slice() : [];
  }

  getDiagnostics() {
    return {
      hasSnapshot: !!this._snapshot,
      floorBandCount: this._floorBands.length,
      portalCount: this._portals.length
    };
  }

  /**
   * @param {object} params
   * @param {{x:number,y:number}} params.start
   * @param {{x:number,y:number}} params.end
   * @param {string} params.startFloorKey
   * @param {string} params.endFloorKey
   * @returns {{ok:boolean,reason?:string,segments?:Array<object>,diagnostics?:object}}
   */
  planRoute({ start, end, startFloorKey, endFloorKey } = {}) {
    const fromKey = String(startFloorKey || '');
    const toKey = String(endFloorKey || '');
    if (!fromKey || !toKey) {
      return { ok: false, reason: 'missing-floor-key' };
    }

    if (fromKey === toKey) {
      return {
        ok: true,
        reason: 'same-floor',
        segments: [{ type: 'walk', floorKey: fromKey, start, end }],
        diagnostics: { portalHops: 0, routeType: 'same-floor' }
      };
    }

    // Foundation heuristic: choose the portal whose from/to directly match and
    // minimizes entry + exit travel cost.
    const candidates = this._portals.filter((p) => {
      if (!p) return false;
      const pFrom = String(p.fromFloorKey || '');
      const pTo = String(p.toFloorKey || '');
      if (pFrom === fromKey && pTo === toKey) return true;
      return !!p.bidirectional && pFrom === toKey && pTo === fromKey;
    });

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: 'no-portal-link',
        diagnostics: {
          fromKey,
          toKey,
          portalCount: this._portals.length
        }
      };
    }

    let best = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const portal of candidates) {
      const pFrom = String(portal.fromFloorKey || '');
      const reverse = pFrom !== fromKey;
      const entry = reverse ? portal.exit : portal.entry;
      const exit = reverse ? portal.entry : portal.exit;
      const cost = distance(start, entry) + distance(exit, end) + Math.max(0, asNumber(portal.travelTimeMs, 400));
      if (cost < bestCost) {
        bestCost = cost;
        best = { portal, reverse, entry, exit };
      }
    }

    if (!best) {
      return { ok: false, reason: 'portal-selection-failed' };
    }

    return {
      ok: true,
      segments: [
        { type: 'walk', floorKey: fromKey, start, end: best.entry },
        {
          type: 'portal-transition',
          portalId: String(best.portal.portalId || ''),
          fromFloorKey: fromKey,
          toFloorKey: toKey,
          entry: best.entry,
          exit: best.exit,
          travelTimeMs: Math.max(0, asNumber(best.portal.travelTimeMs, 400))
        },
        { type: 'walk', floorKey: toKey, start: best.exit, end }
      ],
      diagnostics: {
        portalHops: 1,
        routeType: 'single-portal',
        selectedPortalId: String(best.portal.portalId || ''),
        estimatedCost: bestCost
      }
    };
  }

  logDiagnostics() {
    log.debug('multi-floor graph diagnostics', this.getDiagnostics());
  }
}
