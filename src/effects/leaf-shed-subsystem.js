/**
 * LEAF SHED — THE SUBSYSTEM: the viewer hands it facts, it hands back a scene.
 *
 * Owns everything between "the viewer has canopies and a wind" and "the engine
 * has births to start": which canopies exist, their colours (one small worker
 * decode per canopy file, asked for only once a wind strong enough to shed has
 * actually blown), the emitters placed on the world, the per-frame birth plan,
 * and when the engine needs stepping at all. A calm scene costs one comparison a
 * frame: no decode is requested, no engine is built, nothing is dispatched.
 *
 * The viewer injects every fact it owns (`listCanopies`, the wind, the floor's
 * expected depth, the colour-grid request) and the allocating factory
 * (`createEngine`: the `particles/allocator-only` wall keeps every storage
 * buffer under `effects/particles/`), the same seam shape as the critter
 * subsystem.
 *
 * @module effects/leaf-shed-subsystem
 */
import { createLogger } from '../core/log.js';
import { metresPerSecondForSpeed01 } from '../world/index.js';
import { leafShedCapacity, resolveLeafShedParams } from './leaf-shed.js';
import { buildCanopyEmitters, placeEmitters, planShedBirths } from './leaf-shed-sources.js';

const log = createLogger('leaf-shed');

/** Colour decodes are asked for once the wind reaches this share of the start threshold — ahead of the first leaf. */
const WARM_SHARE = 0.75;
/** Seconds a leaf can outlive its birth (airborne cap + the longest ground time + its fade). */
const LONGEST_LIFE_SEC = 14 + 20 * 1.3 + 1.2;
/** Average seconds a slot is busy, for the per-frame birth budget (the ring must not lap live leaves). */
const AVG_BUSY_SEC = 6;

/**
 * @typedef {object} CanopySource
 * @property {string} key - stable per canopy instance (item id + kind).
 * @property {string} url - the canopy art.
 * @property {'tree'|'bush'} kind
 * @property {Array<{x:number,y:number}>} corners - the quad it is drawn on (TL, TR, BR, BL).
 * @property {boolean} visible - drawn on the floor in view right now.
 */

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {(a: object) => object} deps.createEngine - `createLeafShedEngine`.
 * @param {() => object} deps.getRenderState - `{enabled, params, profile, gridPx, pxPerFt,
 *   treeHeightFt, bushHeightFt, groundElevation}`. Required: a defaulted seam is how an
 *   unwired effect ships with a green test suite.
 * @param {() => CanopySource[]} deps.listCanopies
 * @param {(url: string) => Promise<{gridW:number, gridH:number, rgba:Uint8Array}|null>} deps.requestColourGrid
 * @param {() => object} deps.getWindHandle - a getter: the handle is rebuilt on every rebake.
 * @param {() => number} deps.getWindSpeed01
 * @param {(elevation: number) => number} [deps.resolveExpectedDepth]
 * @param {object} [deps.engineDeps] - lighting/depth texture nodes handed to the engine.
 * @param {() => number} [deps.random]
 */
export function createLeafShedSubsystem({
  THREE,
  createEngine,
  getRenderState,
  listCanopies,
  requestColourGrid,
  getWindHandle,
  getWindSpeed01,
  resolveExpectedDepth = null,
  engineDeps = {},
  random = Math.random,
}) {
  for (const [name, fn] of Object.entries({
    createEngine,
    getRenderState,
    listCanopies,
    requestColourGrid,
    getWindHandle,
    getWindSpeed01,
  })) {
    if (typeof fn !== 'function') throw new TypeError(`createLeafShedSubsystem: \`${name}\` is required`);
  }

  /** url → {status:'pending'|'ready'|'missing', uv: {tree: CanopyEmitter[], bush: CanopyEmitter[]}} */
  const colourByUrl = new Map();
  /** source key → {sig, emitters} (placed on the world) */
  const placedByKey = new Map();
  let engine = null;
  let carry = new Float64Array(0);
  let liveUntilSec = -Infinity;
  let clockSec = 0;
  let lastPlanned = 0;
  let lastEmitters = 0;
  let decodes = 0;
  let missing = 0;
  let drawThisFrame = false;

  function colourFor(url) {
    let rec = colourByUrl.get(url);
    if (rec) return rec;
    rec = { status: 'pending', uv: null };
    colourByUrl.set(url, rec);
    decodes++;
    const ingest = (grid) => {
      if (!grid?.rgba || !(grid.gridW > 0) || !(grid.gridH > 0)) {
        rec.status = 'missing';
        missing++;
        log.warn(`no colour grid for canopy ${url} — it will not shed (the worker answered null)`);
        return;
      }
      const raster = {
        spec: { x: 0, y: 0, w: grid.gridW, h: grid.gridH, texelW: 1 / grid.gridW, texelH: 1 / grid.gridH },
        rgba: grid.rgba,
      };
      rec.uv = { tree: buildCanopyEmitters(raster, 'tree'), bush: buildCanopyEmitters(raster, 'bush') };
      rec.status = 'ready';
    };
    const fail = (err) => {
      rec.status = 'missing';
      missing++;
      log.error(`colour grid for canopy ${url} failed:`, err);
    };
    // The worker answers with a promise; a lab or a test may hand the grid over directly.
    try {
      const answer = requestColourGrid(url);
      if (answer && typeof answer.then === 'function') Promise.resolve(answer).then(ingest).catch(fail);
      else ingest(answer);
    } catch (err) {
      fail(err);
    }
    return rec;
  }

  /** The visible canopies' emitters, placed on the world (cached per placement). */
  function gatherEmitters() {
    const out = [];
    for (const src of listCanopies() ?? []) {
      if (!src?.visible || !src.url) continue;
      const rec = colourFor(src.url);
      if (rec.status !== 'ready') continue;
      const c = src.corners;
      const sig = c.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('|');
      let placed = placedByKey.get(src.key);
      if (!placed || placed.sig !== sig) {
        placed = { sig, emitters: placeEmitters(rec.uv[src.kind] ?? [], c) };
        placedByKey.set(src.key, placed);
      }
      for (const e of placed.emitters) out.push(e);
    }
    return out;
  }

  function ensureEngine(state, sceneRect) {
    if (engine) return engine;
    engine = createEngine({
      THREE,
      capacity: leafShedCapacity(state.profile),
      sceneRect,
      windHandle: getWindHandle(),
      ...engineDeps,
    });
    log.info(`leaf shed engine built (${engine.capacity} slots)`);
    return engine;
  }

  return {
    /** The draw scene, or null before the first leaf ever needed one. */
    get scene() {
      return engine?.scene ?? null;
    },
    /** True when this frame stepped leaves the viewer should draw. */
    get hasContent() {
      return drawThisFrame;
    },

    /**
     * One frame. Plans births, steps the engine, or does nothing at all in a calm.
     * @param {*} renderer
     * @param {{dtSec:number, tMs:number, viewRect:object, sceneRect:object,
     *   shadowThrow?:{x:number,y:number}, daylight01?:number}} frame - `shadowThrow`: world px of
     *   sun shadow per px of height; `daylight01`: how much sun there is to cast one.
     */
    sync(renderer, frame) {
      drawThisFrame = false;
      const state = getRenderState();
      if (!state?.enabled) return;
      const dt = Math.min(0.05, Math.max(0, frame.dtSec || 0));
      clockSec += dt;
      const p = resolveLeafShedParams(state.params);
      const mps = metresPerSecondForSpeed01(getWindSpeed01());
      const shedding = mps >= p.startsAboveMps * WARM_SHARE;
      if (!shedding && clockSec > liveUntilSec) return;

      const gridPx = state.gridPx > 0 ? state.gridPx : 100;
      const pxPerFt = state.pxPerFt > 0 ? state.pxPerFt : gridPx / 5;
      let births = [];
      if (shedding) {
        const emitters = gatherEmitters();
        lastEmitters = emitters.length;
        if (carry.length !== emitters.length) carry = new Float64Array(emitters.length);
        const handle = getWindHandle();
        const capacity = engine?.capacity ?? leafShedCapacity(state.profile);
        births = planShedBirths({
          emitters,
          carry,
          windMpsAt: (e) => mps * (handle?.cpuAt ? handle.cpuAt(e.cx, e.cy).openness : 1),
          dtSec: dt,
          params: p,
          gridPx,
          viewRect: frame.viewRect ?? null,
          maxBirths: Math.ceil((capacity * dt) / AVG_BUSY_SEC) + 1,
          heightPx: {
            tree: (state.treeHeightFt > 0 ? state.treeHeightFt : 25) * pxPerFt,
            bush: (state.bushHeightFt > 0 ? state.bushHeightFt : 2) * pxPerFt,
          },
          random,
        });
      }
      lastPlanned = births.length;
      if (!engine && births.length === 0) return;
      // A leaf leaving the scene dies (nothing draws in the padding); no scene rect yet, no leaves.
      const sceneRect = frame.sceneRect ?? null;
      if (!sceneRect) return;
      const eng = ensureEngine(state, sceneRect);
      if (births.length) liveUntilSec = clockSec + LONGEST_LIFE_SEC;
      eng.setSceneRect(sceneRect);
      eng.setLook({
        ...p,
        gridPx,
        // The Vegetation card's own dials: a leaf rides the air the way the canopy it fell from leans.
        treeGustTurbulence: state.gustTurbulence,
        treeClumpSizePx: state.clumpSizePx,
        treeClumpDirSpread: state.clumpDirSpread,
      });
      eng.setView({
        shadowThrowX: frame.shadowThrow?.x,
        shadowThrowY: frame.shadowThrow?.y,
        daylight01: frame.daylight01,
        crownHeightPx: (state.treeHeightFt > 0 ? state.treeHeightFt : 25) * pxPerFt,
        expectedDepth:
          typeof resolveExpectedDepth === 'function' ? resolveExpectedDepth(Number(state.groundElevation) || 0) : 0,
      });
      eng.writeBirths(births);
      eng.step(renderer, { dtSec: dt, tMs: frame.tMs });
      drawThisFrame = true;
    },

    /** A wind rebake: refresh the engine's cell buffer in place. */
    updateWind(handle) {
      engine?.updateWind(handle);
    },

    /** Forget every canopy (a scene change): colours and placements are per scene. */
    reset() {
      colourByUrl.clear();
      placedByKey.clear();
      carry = new Float64Array(0);
      liveUntilSec = -Infinity;
    },

    getStatus() {
      let ready = 0;
      let pending = 0;
      for (const r of colourByUrl.values()) {
        if (r.status === 'ready') ready++;
        else if (r.status === 'pending') pending++;
      }
      return {
        engineBuilt: !!engine,
        canopyFiles: { ready, pending, missing, requested: decodes },
        emitters: lastEmitters,
        lastPlanned,
        drawing: drawThisFrame,
        engine: engine?.debugState() ?? null,
      };
    },
  };
}
