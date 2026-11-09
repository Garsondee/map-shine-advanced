/**
 * vt/air-runtime.js — THE 3-D AIR IN THE VIEWER (2026-11-09, Lab · Air): drives `world/air.worker.js`, keeps the
 * last two ground snapshots as textures, and builds the COMPOSE pass that writes them into the baked wind field every
 * effect already reads (`wind.field.now` / `wind.field.lag`), so vegetation, fire, rain, flies and candles inherit the
 * new air with no change of their own.
 *
 * WHAT THE FIELD BECOMES. Mean air = the solver's 1-2 m layer (one cell per grid square), blended between its last two
 * steps by sim time (a step behind, so it never snaps: ~0.1-0.2 s of latency nobody can see in wind). Swirl = the
 * analytic field's own curl-noise turbulence, scaled by the solver's LOCAL turbulence energy over the open ground's
 * (`sigma / sigma_open`, 0..3): a lee or a doorway churns, a sealed room is still, the open ground is exactly as before.
 *
 * The viewer owns the render targets and runs the quad (`renderer-state/graph-only`); this file owns the worker, the
 * snapshot textures and the material. Cadence comes from the SIM clock the viewer passes (paused = dt 0 = no step).
 *
 * @module vt/air-runtime
 */
import { computeWindTurbulence, WIND_DIAL_MAX_METRES_PER_SECOND, AIR_DRIVER_DEFAULTS } from '../world/index.js';

/** Sim seconds between solver steps (the worker's cadence). */
export const AIR_STEP_SEC = 0.1;
/** The open ground's swirl, σ/U: sqrt(2·0.9/3)·openTurbulence (the solver's floor k = 0.9·(0.22 U)²). */
export const AIR_OPEN_SIGMA_PER_U = Math.sqrt(0.6) * AIR_DRIVER_DEFAULTS.openTurbulence;

/** A cheap fingerprint of the geometry the worker was built from (so an unchanged bake does not restart the air). */
export function airGeometryKey(g) {
  let h = 0x811c9dc5 | 0;
  const mix = (v) => {
    h = Math.imul(h ^ (Math.round(v * 8) | 0), 0x01000193);
  };
  for (const w of g.walls ?? []) {
    mix(w.x1);
    mix(w.y1);
    mix(w.x2);
    mix(w.y2);
    mix((w.solid ? 1 : 0) | (w.blocksExterior ? 2 : 0));
  }
  for (const r of g.roofs ?? []) {
    mix(r.x);
    mix(r.y);
    mix(r.w);
    mix(r.h);
    mix(r.heightM);
  }
  const s = g.sky;
  if (s?.data) {
    const stride = Math.max(1, Math.floor(s.data.length / 4096));
    for (let i = 0; i < s.data.length; i += stride) mix(s.data[i]);
  }
  return `${g.rect.x},${g.rect.y},${g.rect.w},${g.rect.h}|${g.cellPx}|${g.pxPerMetre}|${(g.walls ?? []).length}|${h >>> 0}`;
}

/**
 * @param {object} a
 * @param {*} a.THREE
 * @param {() => Worker} [a.makeWorker] - injected for tests; defaults to the module worker.
 * @param {{warn?:Function, info?:Function, debug?:Function}} [a.log]
 */
export function createAirRuntime({ THREE, makeWorker, log = console }) {
  const spawn =
    makeWorker ?? (() => new Worker(new URL('../world/air.worker.js', import.meta.url), { type: 'module' }));
  let worker = null;
  let key = '';
  let id = 0;
  let grid = null; // from 'ready'
  let busy = false;
  let acc = 0; // sim seconds not yet stepped
  let wantLayers = false;
  /** Snapshots: {simTimeSec, ground, all}. */
  let prev = null;
  let cur = null;
  let texA = null;
  let texB = null;
  let texCurIsA = true;
  let composeEntry = null;
  const stats = { steps: 0, lastStepMs: 0, meanStepMs: 0, substeps: 0, errors: 0, lastError: '' };

  function ensureWorker() {
    if (worker) return worker;
    worker = spawn();
    worker.onmessage = (e) => onMessage(e.data);
    worker.onerror = (e) => {
      stats.errors++;
      stats.lastError = String(e?.message ?? e);
      busy = false;
      log.warn?.('air worker error:', stats.lastError);
    };
    return worker;
  }

  function makeTex(nx, ny) {
    const t = new THREE.DataTexture(new Uint16Array(nx * ny * 4), nx, ny, THREE.RGBAFormat, THREE.HalfFloatType);
    t.colorSpace = THREE.NoColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  /** Ground snapshot (m/s, k) → dial units (vx, vy, vz, σ) half floats. */
  function upload(tex, ground) {
    const d = tex.image.data;
    const inv = 1 / WIND_DIAL_MAX_METRES_PER_SECOND;
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let c = 0, n = ground.length / 4; c < n; c++) {
      const k = ground[c * 4 + 3];
      d[c * 4] = toHalf(ground[c * 4] * inv);
      d[c * 4 + 1] = toHalf(ground[c * 4 + 1] * inv);
      d[c * 4 + 2] = toHalf(ground[c * 4 + 2] * inv);
      d[c * 4 + 3] = toHalf(Math.sqrt(Math.max(0, (2 * k) / 3)) * inv);
    }
    tex.needsUpdate = true;
  }

  function onMessage(m) {
    if (!m || m.id !== id) return; // an old grid's answer
    if (m.type === 'ready') {
      grid = m.grid;
      texA?.dispose?.();
      texB?.dispose?.();
      texA = makeTex(grid.nx, grid.ny);
      texB = makeTex(grid.nx, grid.ny);
      texCurIsA = true;
      prev = cur = null;
      composeEntry = null; // the material closes over the grid
      log.info?.(`air: ${grid.nx}x${grid.ny}x${grid.nz} cells (${grid.doors} doorways)`);
      return;
    }
    if (m.type === 'field') {
      busy = false;
      stats.steps++;
      stats.lastStepMs = m.stepMs;
      stats.meanStepMs = stats.meanStepMs ? stats.meanStepMs * 0.9 + m.stepMs * 0.1 : m.stepMs;
      stats.substeps = m.substeps;
      prev = cur;
      cur = { simTimeSec: m.simTimeSec, ground: m.ground, all: m.all ?? cur?.all ?? null };
      if (!texA) return;
      texCurIsA = !texCurIsA;
      upload(texCurIsA ? texA : texB, m.ground);
      if (!prev) upload(texCurIsA ? texB : texA, m.ground);
      return;
    }
    if (m.type === 'error') {
      busy = false;
      stats.errors++;
      stats.lastError = m.message;
      log.warn?.('air worker:', m.message);
    }
  }

  return {
    /**
     * (Re)build the air for this geometry. Unchanged geometry is a no-op.
     * @param {{walls:Array, rect:{x,y,w,h}, cellPx:number, pxPerMetre:number, sky?:object, roofs?:Array,
     *   gridOpts?:object, solverOpts?:object}} geometry
     */
    configure(geometry) {
      const k = airGeometryKey(geometry);
      if (k === key && worker) return false;
      key = k;
      id++;
      grid = null;
      busy = false;
      acc = 0;
      ensureWorker().postMessage({ type: 'init', id, geometry });
      return true;
    },
    /** Ask for the whole box (every layer) with each step — the wind view wants it. */
    setWantLayers(on) {
      wantLayers = !!on;
    },
    /**
     * Advance the air with the sim clock. Posts at most one step in flight, every ~AIR_STEP_SEC of sim time.
     * @param {number} simTimeSec @param {number} dtSec @param {{directionDeg:number, speedMps:number, gustiness01:number}} wind
     */
    tick(simTimeSec, dtSec, wind) {
      if (!worker || !grid) return;
      if (dtSec > 0) acc += Math.min(dtSec, 0.5);
      // Until the first field arrives, ask even with no time passed (a paused world still needs its air).
      if (busy || (cur && acc < AIR_STEP_SEC)) return;
      busy = true;
      const dt = Math.min(acc, 0.4);
      acc = 0;
      worker.postMessage({ type: 'step', id, wind, dtSec: dt, simTimeSec, layers: wantLayers });
    },
    /** True once a field has arrived for the current grid. */
    get ready() {
      return !!(grid && cur && texA);
    },
    get grid() {
      return grid;
    },
    /** The latest snapshot (CPU arrays) for the wind view and the lab: {simTimeSec, ground, all}. */
    latest() {
      return cur;
    },
    stats() {
      return { ...stats, grid: grid ? `${grid.nx}x${grid.ny}x${grid.nz}` : null, wantLayers };
    },
    /**
     * The compose pass for the CURRENT air grid and this bake grid: writes the field (dial units) the effects read.
     * @param {{originX:number, originY:number, cellSize:number, cols:number, rows:number}} bakeGrid
     * @param {object} ambient - the live wind uniforms (`directionDeg`, `speed01`, `pixelsPerMetre`, `advection`).
     */
    compose(bakeGrid, ambient) {
      if (!grid || !texA) return null;
      const bk = `${bakeGrid.originX},${bakeGrid.originY},${bakeGrid.cellSize},${bakeGrid.cols},${bakeGrid.rows}`;
      if (composeEntry && composeEntry.bk === bk) return composeEntry;
      composeEntry?.material?.dispose?.();
      composeEntry = { bk, ...buildAirComposeMaterial({ THREE, texA, texB, airGrid: grid, bakeGrid, ambient }) };
      return composeEntry;
    },
    /**
     * Set the compose uniforms for this frame: which texture is newest, how far between the last two steps the sim
     * clock stands (the display runs one step behind, so it always interpolates), the frame's time and the lag.
     */
    prepareCompose(entry, simTimeSec, timeMs, lagSec) {
      const tPrev = prev?.simTimeSec ?? cur?.simTimeSec ?? simTimeSec;
      const tCur = cur?.simTimeSec ?? simTimeSec;
      const span = Math.max(1e-3, tCur - tPrev);
      const alpha = Math.min(1, Math.max(0, (simTimeSec - tCur) / span));
      entry.uCurIsA.value = texCurIsA ? 1 : 0;
      entry.uAlpha.value = alpha;
      entry.uTimeMs.value = timeMs;
      entry.uLagSec.value = lagSec;
    },
    dispose() {
      worker?.terminate?.();
      worker = null;
      key = '';
      grid = null;
      composeEntry?.material?.dispose?.();
      composeEntry = null;
      texA?.dispose?.();
      texB?.dispose?.();
      texA = texB = null;
      prev = cur = null;
    },
  };
}

/**
 * THE COMPOSE MATERIAL: the bake grid's texel → its world point → the air grid's texel; blend the two ground
 * snapshots; add the analytic swirl scaled by the local turbulence; write the field in dial units.
 */
export function buildAirComposeMaterial({ THREE, texA, texB, airGrid, bakeGrid, ambient }) {
  const TSL = THREE.TSL;
  const { texture, uv, vec2, vec4, float, uniform, clamp, mix, max } = TSL;
  const uv0 = uv();
  const uCurIsA = uniform(float(1));
  const uAlpha = uniform(float(1));
  const uTimeMs = uniform(float(0));
  const uLagSec = uniform(float(0));
  const worldXY = vec2(
    uv0.x.mul(float(bakeGrid.cellSize * bakeGrid.cols)).add(float(bakeGrid.originX)),
    uv0.y.mul(float(bakeGrid.cellSize * bakeGrid.rows)).add(float(bakeGrid.originY))
  );
  const spanX = airGrid.cellPx * airGrid.nx;
  const spanY = airGrid.cellPx * airGrid.ny;
  const airUv = vec2(
    worldXY.x.sub(float(airGrid.originX)).div(float(spanX)),
    worldXY.y.sub(float(airGrid.originY)).div(float(spanY))
  );
  const read = (p) => {
    const a = texture(texA, p);
    const b = texture(texB, p);
    // newest = cur, older = prev; display blends prev → cur by alpha.
    const newest = mix(b, a, uCurIsA);
    const older = mix(a, b, uCurIsA);
    return { node: mix(older, newest, uAlpha), a, b };
  };
  const here = read(airUv);
  // The lagged slice: the air that was here `lag` seconds ago is now a little downstream (frozen turbulence).
  const ppm = ambient.pixelsPerMetre ?? float(98.43);
  const uvPerUnitSec = vec2(
    ppm.mul(float(WIND_DIAL_MAX_METRES_PER_SECOND / spanX)),
    ppm.mul(float(WIND_DIAL_MAX_METRES_PER_SECOND / spanY))
  );
  const lagUv = clamp(airUv.add(here.node.xy.mul(uvPerUnitSec).mul(uLagSec)), vec2(0, 0), vec2(1, 1));
  const f = read(lagUv).node;
  const turb = computeWindTurbulence(TSL, {
    centerXY: worldXY,
    time: uTimeMs,
    openness: float(1),
    exteriorOpenness: float(1),
    windSpeed01: ambient.speed01,
    directionDeg: ambient.directionDeg,
    advectSpeed01: ambient.speed01,
    pixelsPerMetre: ambient.pixelsPerMetre,
    advection: ambient.advection,
  });
  const sigmaOpen = max(ambient.speed01.mul(float(AIR_OPEN_SIGMA_PER_U)), float(1e-4));
  const ratio = clamp(f.w.div(sigmaOpen), float(0), float(3));
  const out = f.xy.add(turb.mul(ratio));
  const material = new THREE.NodeMaterial();
  material.name = 'wind.air.compose';
  material.fragmentNode = vec4(out.x, out.y, float(0), float(1));
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  return { material, quad: new THREE.QuadMesh(material), uCurIsA, uAlpha, uTimeMs, uLagSec };
}
