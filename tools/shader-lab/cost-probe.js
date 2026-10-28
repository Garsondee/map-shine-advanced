/**
 * Shader Lab — COST PROBE (2026-10-27, epic mmp-fpu).
 *
 * Builds REAL production materials (never a lab copy — `AGENTS.md` §6) against a
 * realistic wind handle, compiles them on this machine's real WebGPU device, and
 * reports for each pipeline:
 *
 *   - `vsChars` / `fsChars` — the size of the WGSL three generated. A complexity
 *     proxy that needs no GPU to interpret, and the number the budget tests ratchet;
 *   - `gpuMs`  — wall time from `createRenderPipelineAsync` to its resolution: the
 *     real driver/compiler cost, off the GPU process's main thread;
 *   - `syncMs` — wall time of a SYNCHRONOUS first draw (`render()` then
 *     `queue.onSubmittedWorkDone()`): what production's warm-up pays, and the
 *     number Chrome's GPU watchdog is watching.
 *
 * ## Why this exists
 *
 * A cold load of one scene lost the whole GPU device three times in a day and
 * every diagnosis was a guess, because nothing could say how big or how slow a
 * shader was. The fix for shaders that keep growing is a budget, and a budget
 * needs a measuring stick that runs on the real compiler. This is it.
 *
 * ## Use
 *
 *   const probe = await import('/tools/shader-lab/cost-probe.js');
 *   await probe.runAll({ only: ['candle-flame'] });
 *
 * Read the output, don't trust a pass: sizes are exact; times vary with the
 * driver, the machine's load and whether the shader cache is warm. Run a scenario
 * twice and look at the second number for the steady-state, the first for a cold
 * player's.
 *
 * @module tools/shader-lab/cost-probe
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { createWindHandle, createWindAdvectionUniforms } from '../../src/world/index.js';
import { buildCandleFlameGeometry, buildCandleFlameMaterial } from '../../src/effects/candle-flame-render.js';
import { createBatchedLightMesh } from '../../src/effects/lighting/point-light-batch-mesh.js';
import { resolveLightAnimation } from '../../src/effects/lighting/animations/registry.js';
import { setSafeLevel } from '../../src/core/safe-mode.js';
import {
  planGustHistoryBakes,
  gustHistoryTileOf,
  stepWindAdvection,
  writeWindAdvectionUniforms,
} from '../../src/world/index.js';
import { buildCandleWindState } from '../../src/effects/candle-wind-state.js';
import { createStormFog } from '../../src/effects/precipitation/storm-fog-render.js';
import { createPrecipCurtain } from '../../src/effects/precipitation/curtain-render.js';
import { createTorrent } from '../../src/effects/precipitation/torrent-render.js';
import { buildWindowSurfaceMaterial } from '../../src/effects/window/window-render.js';
import { createWindowRain } from '../../src/effects/window/window-rain.js';
import { createWindowRoomLight } from '../../src/effects/window/window-room-light.js';
import { buildWaterSurfaceMaterial } from '../../src/effects/water/water-render.js';
import { buildWorldSpaceOutdoorsGate } from '../../src/effects/lighting/environmental-light.js';

const WORLD = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

/** @type {{renderer: any, records: any[], current: any}|null} */
let rig = null;

/**
 * One renderer for the whole probe, with the creation hooks that measure.
 * @param {{fresh?: boolean}} [opts] - `fresh`: a new device. three caches programs by their WGSL text, so
 *   measuring the same shader twice on one device would be a cache hit and time nothing.
 */
export async function ensureRig({ fresh = false } = {}) {
  if (rig && !fresh) return rig;
  if (rig) {
    try {
      rig.renderer.dispose();
    } catch (err) {
      console.warn('[cost-probe] could not dispose the previous renderer:', err);
    }
    rig = null;
  }
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  await renderer.init();
  const records = [];
  const state = { renderer, records, current: null };
  const device = renderer.backend.device;
  const utils = renderer.backend.pipelineUtils;

  const originalCreate = utils.createRenderPipeline.bind(utils);
  utils.createRenderPipeline = (renderObject, promises) => {
    const p = renderObject.pipeline;
    const rec = {
      label: renderObject.material?.name || renderObject.object?.name || renderObject.material?.type || '?',
      vsChars: p?.vertexProgram?.code?.length ?? 0,
      fsChars: p?.fragmentProgram?.code?.length ?? 0,
      async: promises !== null,
      gpuMs: null,
    };
    records.push(rec);
    state.current = rec;
    try {
      return originalCreate(renderObject, promises);
    } finally {
      state.current = null;
    }
  };

  const originalAsync = device.createRenderPipelineAsync.bind(device);
  device.createRenderPipelineAsync = (desc) => {
    const rec = state.current;
    const t0 = performance.now();
    return originalAsync(desc).then((pipeline) => {
      if (rec) rec.gpuMs = Math.round(performance.now() - t0);
      return pipeline;
    });
  };

  rig = state;
  return rig;
}

const GRID = { originX: 0, originY: 0, cellSize: 25, cols: 64, rows: 64 };

const atlasTexture = () => {
  const t = new THREE.DataTexture(
    new Uint16Array(GRID.cols * 4 * GRID.rows * 4),
    GRID.cols * 4,
    GRID.rows * 4,
    THREE.RedFormat,
    THREE.HalfFloatType
  );
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
};

/**
 * A wind handle shaped like production's: live ambient nodes, a baked grid, all three field textures —
 * and, with `field`, the per-frame baked field's two slices (`fieldTextures` overrides the stand-ins,
 * for the fidelity check where they are real render targets).
 * @param {{field?: boolean, fieldTextures?: {now: any, lag: any}, structure?: boolean}} [opts]
 */
export function makeWindHandle({
  field = false,
  fieldTextures = null,
  structure = false,
  history = false,
  historyOverride = null,
} = {}) {
  const T = THREE.TSL;
  const ambient = {
    directionDeg: T.uniform(T.float(90)),
    speed01: T.uniform(T.float(0.3)),
    gustiness01: T.uniform(T.float(1)),
    pixelsPerMetre: T.uniform(T.float(65.6)),
    advection: createWindAdvectionUniforms(T),
  };
  const { cols, rows } = GRID;
  const half = THREE.DataUtils.toHalfFloat;
  const tex = (fill) => {
    const data = new Uint16Array(cols * rows * 4);
    if (fill) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const px = fill(c, r);
          for (let k = 0; k < 4; k++) data[(r * cols + c) * 4 + k] = half(px[k]);
        }
      }
    }
    const t = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.HalfFloatType);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  // A synthetic building: a sealed room in the middle (openness 0.15, not exterior), a wall-avoid ramp
  // around it and a wind shadow behind it — enough structure for the gates, the deflection and the shadow
  // to matter, which a flat field would not exercise.
  const inRoom = (c, r) => c >= 22 && c < 42 && r >= 24 && r < 40;
  const nearRoom = (c, r) => Math.max(0, 1 - Math.hypot(Math.max(22 - c, 0, c - 41), Math.max(24 - r, 0, r - 39)) / 6);
  const opennessFill = structure ? (c, r) => [0, 0, inRoom(c, r) ? 0.15 : 1, inRoom(c, r) ? 0 : 1] : null;
  const wallFill = structure
    ? (c, r) => {
        const dx = c - 32;
        const dy = r - 32;
        const len = Math.hypot(dx, dy) || 1;
        const shadow = c > 42 && Math.abs(r - 32) < 8 ? 0.6 : 0;
        return [dx / len, dy / len, nearRoom(c, r), shadow];
      }
    : null;
  const handle = createWindHandle({
    version: 1,
    ambientWind: ambient,
    grid: GRID,
    opennessTexture: tex(opennessFill),
    wallAvoidTexture: tex(wallFill),
    liveTexture: tex(),
    fieldTexture: fieldTextures ? fieldTextures.now : field ? tex() : null,
    fieldLagTexture: fieldTextures ? fieldTextures.lag : field ? tex() : null,
    // The recorded gust history: a stand-in atlas (4x4 tiles of the grid) and the baker's moment index.
    gustHistoryTexture: historyOverride ? historyOverride.atlas : history ? atlasTexture() : null,
    gustHistoryGridIndex: historyOverride ? historyOverride.gridIndex : history ? T.uniform(T.float(100)) : null,
    cells: null,
  });
  return { handle, ambient };
}

const camera = () => {
  const c = new THREE.OrthographicCamera(WORLD.minX, WORLD.maxX, WORLD.minY, WORLD.maxY, 0.1, 1000);
  c.position.set(0, 0, 100);
  c.updateProjectionMatrix();
  return c;
};

/**
 * Make a scene's shaders new to the driver. Chrome keeps a disk cache of compiled shaders across devices AND
 * sessions, so a shader this machine has compiled before reads as "compiles in 10 ms" — a cache hit, which is
 * not what a player's first load pays. One literal in the fragment output changes; nothing visible does.
 * @param {any} scene @param {number} salt - 0 leaves the scene untouched.
 */
export function applySalt(scene, salt) {
  if (!salt) return;
  const T = THREE.TSL;
  scene.traverse((o) => {
    for (const m of [].concat(o.material ?? [])) {
      if (m?.fragmentNode) m.fragmentNode = m.fragmentNode.mul(T.float(1 + salt * 1e-6));
      else if (m?.colorNode) m.colorNode = m.colorNode.mul(T.float(1 + salt * 1e-6));
    }
  });
}

const stubTexture = () => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
};

/** Every material reachable from whatever a builder returned: a scene, a material, or an object holding them. */
function materialsIn(x, out = new Set(), depth = 0) {
  if (!x || depth > 3) return out;
  if (x.isMaterial) out.add(x);
  else if (x.isObject3D) x.traverse((o) => o.material && [].concat(o.material).forEach((m) => out.add(m)));
  else if (typeof x === 'object')
    for (const v of Object.values(x)) if (v && typeof v === 'object') materialsIn(v, out, depth + 1);
  return out;
}

/** A full-map quad for each material — enough geometry for a builder that returns only materials. */
function quadsFor(built) {
  const scene = new THREE.Scene();
  for (const material of materialsIn(built)) {
    const geometry = new THREE.PlaneGeometry(WORLD.maxX, WORLD.maxY);
    geometry.translate(WORLD.maxX / 2, WORLD.maxY / 2, 0);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  return { scene, camera: camera() };
}

const waterArgs = (tier) => ({
  THREE,
  tier,
  maskTexture: stubTexture(),
  maskRect: WORLD,
  bodyTexture: stubTexture(),
  bodyRect: WORLD,
  capturedTexture: stubTexture(),
  capturedRect: WORLD,
  capturedTexSize: { width: 512, height: 512 },
  timeMsNode: THREE.TSL.uniform(THREE.TSL.float(0)),
  uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1000, 1000)),
  uOutdoorsRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1000, 1000)),
  outdoorsTexNode: THREE.TSL.texture(stubTexture()),
  buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
  // what `water-surface-subsystem.js#buildSurfaceForTier` also always supplies (its four "always a real
  // texture" inputs, the depth gate, the cast-shadow gate, the body pack's grid size, and the wind)
  bodyTexSize: [1, 1],
  depthTexture: stubTexture(),
  flowPackTexture: stubTexture(),
  waterSimTexture: stubTexture(),
  waterSimSoftTexture: stubTexture(),
  waterSprayTexture: stubTexture(),
  sunShadowTexture: stubTexture(),
  windHandle: makeWindHandle({ field: true, history: true }).handle,
  // The viewer builds water in SHARED-RESOLVE mode (`vt-pan-viewer.js`, "W-02"): the big surface graph is
  // computed once into a target by the resolve material, and the absorb / in-scatter meshes only read it.
  // Without this the lab would compile that graph into every material and overstate water several-fold.
  sharedResolve: true,
  resolveTextures: { output: stubTexture(), absorb: stubTexture(), refract: stubTexture() },
});

/** The scenarios: each returns `{scene, camera, dispose}`. Real builders, real wind. */
export const SCENARIOS = {
  /** The candle flame billboard at its shipped tier, with the real wind field. */
  'candle-flame': ({ field = false, history = false } = {}) => {
    const { handle } = makeWindHandle({ field, history });
    const uGlobalTimeMs = THREE.TSL.uniform(THREE.TSL.float(4200));
    const built = buildCandleFlameMaterial({ THREE, uGlobalTimeMs, quality: 2, windHandle: handle });
    const anchors = [0, 1, 2].map((i) => ({
      id: `probe:${i}`,
      x: 200 + i * 200,
      y: 400,
      windExposure: 1,
      params: { intensity: 1, useCustomSize: true, customSizePx: 60 },
    }));
    const { geometry } = buildCandleFlameGeometry(THREE, anchors, { sizePx: 60, colorHex: '#ffaa00' });
    const mesh = new THREE.Mesh(geometry, built.material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { scene, camera: camera() };
  },
  /** The batched candle-light buckets production draws: one illumination, one coloration. */
  'candle-light-illumination': (o) => candleLightBucket('illumination', o),
  'candle-light-coloration': (o) => candleLightBucket('coloration', o),
  /** The weather layers: full-map quads, each one pipeline. */
  'storm-fog': () => ({ scene: createStormFog({ THREE }).scene, camera: camera() }),
  'curtain-rain': () => ({ scene: createPrecipCurtain({ THREE, speciesId: 'rain' }).scene, camera: camera() }),
  torrent: () => ({ scene: createTorrent({ THREE }).scene, camera: camera() }),
  /** The window's light cookie, the rain-on-glass darkening that started this investigation. */
  window: () =>
    quadsFor(
      buildWindowSurfaceMaterial({
        THREE,
        maskTexture: stubTexture(),
        depthTexture: stubTexture(),
        uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 100, 100)),
      })
    ),
  /**
   * The window as production builds it at the glass rung (2026-10-28): glass, rain on the glass AND the SUN & ROOMS
   * term (`window-room-light.js`) — the smear taps and room-map reads that term adds are what this measures.
   */
  /** The same, without the SUN & ROOMS term — so the room term's own share can be read off the difference. */
  'window-rain': () =>
    quadsFor(
      buildWindowSurfaceMaterial({
        THREE,
        maskTexture: stubTexture(),
        depthTexture: stubTexture(),
        depthFlagsTexture: stubTexture(),
        uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 100, 100)),
        rain: createWindowRain({ THREE, flowDirsTexture: stubTexture(), flowAuxTexture: stubTexture() }),
        gateGlass: true,
        glass: true,
      })
    ),
  'window-full': () =>
    quadsFor(
      buildWindowSurfaceMaterial({
        THREE,
        maskTexture: stubTexture(),
        depthTexture: stubTexture(),
        depthFlagsTexture: stubTexture(),
        uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 100, 100)),
        rain: createWindowRain({ THREE, flowDirsTexture: stubTexture(), flowAuxTexture: stubTexture() }),
        roomLight: createWindowRoomLight({ THREE, roomTexture: stubTexture(), fieldTexture: stubTexture() }),
        gateGlass: true,
        glass: true,
      })
    ),
  /**
   * Water at every rung of its quality ladder — only the passes production draws. The builder's
   * `debugMaterial` is a lazy getter that a plain walk of the returned object would trigger; it is the largest
   * of them all and never ships in the normal render path.
   */
  ...Object.fromEntries(
    [0, 1, 2, 3, 4, 5].map((tier) => [
      `water-tier-${tier}`,
      () => {
        const built = buildWaterSurfaceMaterial(waterArgs(tier));
        // Touch the lazy getter without drawing it: building the debug material finishes shared state the
        // real passes compile against (without it their fragment output struct comes out empty).
        void built.debugMaterial;
        return quadsFor({
          absorb: built.absorbMaterial,
          inscatter: built.inscatterMaterial,
          resolve: built.resolveMaterial,
          refract: built.refractMaterial,
        });
      },
    ])
  ),
};

function regularPolygonShapePoints(x, y, radius, sides) {
  const pts = new Array(sides * 2);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pts[i * 2] = x + Math.cos(a) * radius;
    pts[i * 2 + 1] = y + Math.sin(a) * radius;
  }
  return pts;
}

function candleLightBucket(channel, { field = false, history = false } = {}) {
  const { handle } = makeWindHandle({ field, history });
  const T = THREE.TSL;
  const uGlobalTimeMs = T.uniform(T.float(4200));
  const albedoTexture = new THREE.DataTexture(
    new Uint8Array([160, 160, 160, 255]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  albedoTexture.needsUpdate = true;
  const entry = resolveLightAnimation('candleFlicker');
  const shared = {
    uGlobalTimeMs,
    windHandle: handle,
    albedoTexture,
    depthTexNode: null,
    depthFlagsTexNode: null,
    sunShadowSlotNodes: null,
    blendSunVisibilityAcrossFloors: null,
    attrTexNode: null,
  };
  const flags = {
    animated: true,
    windPresent: true,
    animationEntry: entry,
    animationQuality: 2,
    falloffModel: 'inverseSquare',
  };
  const bucket = createBatchedLightMesh({ THREE, channel, shared, flags });
  const member = (i) => ({
    sourceId: `probe:${i}`,
    x: 250 + i * 300,
    y: 400,
    radius: 90,
    shapePoints: regularPolygonShapePoints(250 + i * 300, 400, 90, 20),
    ratio: 0.25,
    attenuationEased: 0.6,
    exposure: 0,
    expectedDepth: 0,
    bg: [0.5, 0.5, 0.5],
    dim: [0.65, 0.65, 0.65],
    bright: [1, 0.9, 0.8],
    colorationAlpha: 1,
    lightColor: [1, 0.6, 0.2],
    speedRaw: 5,
    reverseSign: 1,
    seed: 11 + i,
    intensityRaw: 5,
    windExposure: 0.7,
    windResponse: 1,
  });
  bucket.reconcile([0, 1].map(member));
  const scene = new THREE.Scene();
  scene.add(bucket.mesh);
  return { scene, camera: camera() };
}

/**
 * Compile one scenario on the real device and report what it cost.
 * @param {string} id
 * @param {{safeLevel?: number, field?: boolean, history?: boolean, salt?: number}} [opts] - `salt`: see
 *   {@link applySalt}; pass a fresh integer for a COLD compile (a first-time player's), none for the warm one.
 */
export async function probe(id, { safeLevel = 0, field = false, history = false, salt = 0 } = {}) {
  const { renderer, records } = await ensureRig();
  setSafeLevel(safeLevel);
  const before = records.length;
  const t0 = performance.now();
  const { scene, camera: cam } = SCENARIOS[id]({ field, history });
  applySalt(scene, salt);
  const buildMs = Math.round(performance.now() - t0);

  const t1 = performance.now();
  await renderer.compileAsync(scene, cam);
  const compileMs = Math.round(performance.now() - t1);
  setSafeLevel(0);

  const made = records.slice(before);
  return {
    id,
    safeLevel,
    field,
    history,
    buildMs,
    compileMs,
    pipelines: made.length,
    vsChars: made.reduce((a, r) => a + r.vsChars, 0),
    fsChars: made.reduce((a, r) => a + r.fsChars, 0),
    gpuMs: made.map((r) => r.gpuMs),
    detail: made.map((r) => ({ label: r.label, vs: r.vsChars, fs: r.fsChars, gpuMs: r.gpuMs })),
  };
}

/**
 * Run scenarios at each requested safe level and variant.
 * @param {{only?: string[], levels?: number[], variants?: Array<{field?: boolean, history?: boolean}>}} [opts]
 */
export async function runAll({ only = Object.keys(SCENARIOS), levels = [0], variants = [{}] } = {}) {
  const out = [];
  for (const id of only) {
    for (const safeLevel of levels) {
      for (const v of variants) {
        try {
          out.push(await probe(id, { safeLevel, ...v }));
        } catch (err) {
          out.push({ id, safeLevel, ...v, error: String(err?.message ?? err) });
        }
      }
    }
  }
  return out;
}

/**
 * FIDELITY — does READING the baked wind field give the wind the analytic code gave? (epic mmp-fpu)
 *
 * The baked field is the same `sampleWind`, evaluated at the centre of each grid cell, then read back with
 * a bilinear sampler. This renders BOTH at a lattice four times finer than the cells — the analytic field
 * straight from `handle.node()`, and the baked field through `handle.node({baked:'now'})` — reads the two
 * images back and compares them. A synthetic building (a sealed room, wall deflection, a wind shadow) is in
 * the grid, because a flat field would pass for any implementation.
 *
 * Reports absolute and RELATIVE error (against the analytic field's own RMS magnitude), the worst point,
 * and the worst point's neighbourhood. Read the relative numbers; the field is in dial units.
 *
 * @param {{speed?: number, directionDeg?: number, structure?: boolean, timeMs?: number}} [opts]
 */
export async function fidelity({ speed = 0.5, directionDeg = 60, structure = true, timeMs = 4200 } = {}) {
  const { renderer } = await ensureRig();
  const T = THREE.TSL;
  const { cols, rows, cellSize, originX, originY } = GRID;
  const fieldRT = () =>
    new THREE.RenderTarget(cols, rows, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });
  const nowRT = fieldRT();
  const lagRT = fieldRT();
  const { handle, ambient } = makeWindHandle({ structure, fieldTextures: { now: nowRT.texture, lag: lagRT.texture } });
  ambient.speed01.value = speed;
  ambient.directionDeg.value = directionDeg;

  // 1. bake the field exactly as the viewer does
  const built = handle.buildFieldBake(THREE);
  const bakeQuad = new THREE.QuadMesh(built.material);
  built.uBakeTimeMs.value = timeMs;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(nowRT);
  bakeQuad.render(renderer);

  // 2. read both fields on a finer lattice
  const N = 256;
  const spanX = cellSize * cols;
  const spanY = cellSize * rows;
  const uTime = T.uniform(T.float(timeMs));
  const world = T.vec2(
    T.uv().x.mul(T.float(spanX)).add(T.float(originX)),
    T.uv().y.mul(T.float(spanY)).add(T.float(originY))
  );
  const render = async (node) => {
    const material = new THREE.NodeMaterial();
    material.fragmentNode = T.vec4(node.x, node.y, T.float(0), T.float(1));
    material.depthTest = false;
    material.depthWrite = false;
    material.blending = THREE.NoBlending;
    const rt = new THREE.RenderTarget(N, N, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });
    renderer.setRenderTarget(rt);
    new THREE.QuadMesh(material).render(renderer);
    renderer.setRenderTarget(null);
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, N, N);
    rt.dispose();
    material.dispose();
    return px;
  };
  const analytic = await render(handle.node(T, { centerXY: world, time: uTime }));
  const baked = await render(handle.node(T, { centerXY: world, time: uTime, baked: 'now' }));
  renderer.setRenderTarget(prev);

  let sumSq = 0;
  let sumErr = 0;
  let maxErr = 0;
  let maxAt = [0, 0];
  const errs = [];
  for (let i = 0; i < N * N; i++) {
    const ax = analytic[i * 4];
    const ay = analytic[i * 4 + 1];
    const e = Math.hypot(baked[i * 4] - ax, baked[i * 4 + 1] - ay);
    sumSq += ax * ax + ay * ay;
    sumErr += e;
    errs.push(e);
    if (e > maxErr) {
      maxErr = e;
      maxAt = [i % N, Math.floor(i / N)];
    }
  }
  errs.sort((a, b) => a - b);
  const rms = Math.sqrt(sumSq / (N * N));
  nowRT.dispose();
  lagRT.dispose();
  return {
    speed,
    structure,
    fieldRms: +rms.toFixed(5),
    meanAbsErr: +(sumErr / (N * N)).toFixed(6),
    p99AbsErr: +errs[Math.floor(errs.length * 0.99)].toFixed(6),
    maxAbsErr: +maxErr.toFixed(6),
    meanRel: +(sumErr / (N * N) / rms).toFixed(4),
    p99Rel: +(errs[Math.floor(errs.length * 0.99)] / rms).toFixed(4),
    maxRel: +(maxErr / rms).toFixed(4),
    worstAtLatticeXY: maxAt,
  };
}

/**
 * HISTORY FIDELITY — does the candle's recorded memory give the analytic ladder's answer? (epic mmp-fpu)
 *
 * Runs the REAL pipeline end to end on the real device: the scheduler plans the moments, the handle's bake
 * pass draws each into a one-tile target, `copyTextureToTexture` lands it in its tile of the atlas, and
 * the candle state reads the atlas. A synthetic building is in the grid. Then `alive01` from that recorded
 * history is compared, over a lattice of wick positions, with `alive01` from the analytic ladder (14
 * evaluations of the gust envelope per position — what shipped yesterday). With a constant wind the two
 * must agree; the report counts how many lattice points are actually snuffed, because a comparison in
 * which nothing happens proves nothing.
 *
 * @param {{speed?: number, directionDeg?: number, seconds?: number}} [opts]
 */
export async function historyFidelity({ speed = 0.2, directionDeg = 60, seconds = 30 } = {}) {
  const { renderer } = await ensureRig();
  const T = THREE.TSL;
  const { cols, rows, cellSize, originX, originY } = GRID;
  const target = (w, h) =>
    new THREE.RenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });
  const slotRT = target(cols, rows);
  const atlasRT = target(cols * 4, rows * 4);
  renderer.setRenderTarget(atlasRT);
  renderer.clear();
  renderer.setRenderTarget(slotRT);
  renderer.clear();
  renderer.setRenderTarget(null);

  const gridIndex = T.uniform(T.float(0));
  const { handle, ambient } = makeWindHandle({
    structure: true,
    historyOverride: { atlas: atlasRT.texture, gridIndex },
  });
  ambient.speed01.value = speed;
  ambient.directionDeg.value = directionDeg;
  const bake = handle.buildGustHistoryBake(THREE);
  const bakeQuad = new THREE.QuadMesh(bake.material);

  // record the wind's past exactly as the viewer's tickGustHistory does
  let plan = { lastMoment: null };
  let advection = null;
  const copyAt = new THREE.Vector2();
  const dt = 0.1;
  let bakes = 0;
  for (let t = 0; t <= seconds + 1e-9; t += dt) {
    advection = stepWindAdvection(advection, { tMs: t * 1000, dtSec: dt, speed01: speed, directionDeg });
    writeWindAdvectionUniforms(ambient.advection, advection);
    const p = planGustHistoryBakes(plan, t * 1000);
    plan = p.state;
    for (const b of p.bakes) {
      bake.uBakeTimeMs.value = b.timeMs;
      renderer.setRenderTarget(slotRT);
      bakeQuad.render(renderer);
      const { tx, ty } = gustHistoryTileOf(b.slot);
      copyAt.set(tx * cols, ty * rows);
      renderer.copyTextureToTexture(slotRT.texture, atlasRT.texture, null, copyAt);
      bakes++;
    }
    gridIndex.value = p.moment;
  }
  renderer.setRenderTarget(null);

  // compare alive01 over a lattice of wick positions at the final time
  const N = 64;
  const uTime = T.uniform(T.float(seconds * 1000));
  const world = T.vec2(
    T.uv()
      .x.mul(T.float(cellSize * cols))
      .add(T.float(originX)),
    T.uv()
      .y.mul(T.float(cellSize * rows))
      .add(T.float(originY))
  );
  const aliveOf = (recorded) =>
    buildCandleWindState(T, {
      magNow: T.float(0),
      timeMs: uTime,
      seed: T.float(0.5),
      memory: true,
      ...(recorded
        ? { history: handle.gustHistory(T, { centerXY: world }) }
        : { magAt: handle.gustMagnitudeAt(T, { centerXY: world }) }),
    }).alive01;
  const read = async (node) => {
    const material = new THREE.NodeMaterial();
    material.fragmentNode = T.vec4(node, T.float(0), T.float(0), T.float(1));
    material.depthTest = false;
    material.depthWrite = false;
    material.blending = THREE.NoBlending;
    const rt = new THREE.RenderTarget(N, N, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });
    renderer.setRenderTarget(rt);
    new THREE.QuadMesh(material).render(renderer);
    renderer.setRenderTarget(null);
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, N, N);
    rt.dispose();
    material.dispose();
    return px;
  };
  const analytic = await read(aliveOf(false));
  const recorded = await read(aliveOf(true));
  let maxErr = 0;
  let sumErr = 0;
  let snuffed = 0;
  let dimmed = 0;
  for (let i = 0; i < N * N; i++) {
    const a = analytic[i * 4];
    const e = Math.abs(a - recorded[i * 4]);
    maxErr = Math.max(maxErr, e);
    sumErr += e;
    if (a < 0.2) snuffed++;
    else if (a < 0.95) dimmed++;
  }
  slotRT.dispose();
  atlasRT.dispose();
  return {
    speed,
    seconds,
    momentsBaked: bakes,
    latticePoints: N * N,
    snuffed,
    dimmed,
    meanAbsErr: +(sumErr / (N * N)).toFixed(5),
    maxAbsErr: +maxErr.toFixed(5),
  };
}

/** A macrotask boundary that background-tab timer throttling cannot stretch. */
const yieldTask = () =>
  new Promise((resolve) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => resolve();
    c.port2.postMessage(0);
  });

const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

/**
 * THE PIPELINE GOVERNOR ON THE REAL GPU (epic mmp-fpu).
 *
 * Renders a scenario through `vt/pipeline-governor.js` exactly the way production's first frame does —
 * `renderer.render()`, no promises array — on a FRESH device, and answers what the governor exists for:
 *
 *   1. Did the first `render()` return at once (the compile went to a worker thread), or did it block?
 *   2. How long was the GPU process unresponsive while the compile ran? A pinger submits an empty command
 *      buffer back to back and times `onSubmittedWorkDone()`. A synchronous 20 s compile shows up as a ~20 s
 *      ping — that is the stall Chrome's watchdog counts. An asynchronous one should stay in single-digit ms.
 *   3. Once it is done, does the object actually DRAW (its draws beyond an empty scene's baseline), without
 *      creating anything new? Before that, it must NOT draw: `firstScenarioDraws` is 0 for a deferred pipeline.
 *
 * `field:false, history:false` is the shader as it was before the wind-field bake (the ~20 s one).
 * `blocking:true` runs the first render inside `governor.blocking()` instead — the floor-prepare contract:
 * the call returns only once everything it drew is compiled, so the draw happens in that same call.
 *
 * `salt` (an integer) changes one literal in the fragment output, so the generated shader text is new to the
 * driver. Chrome keeps a disk cache of compiled shaders across devices AND sessions; without a salt, the second
 * measurement of any shader is a cache hit that reads as "compiles in 20 ms".
 *
 * @param {{scenario?: string, field?: boolean, history?: boolean, blocking?: boolean, salt?: number, capMs?: number, renderEveryMs?: number}} [opts]
 */
export async function governorCheck({
  scenario = 'candle-flame',
  field = false,
  history = false,
  blocking = false,
  salt = 0,
  capMs = 90_000,
  renderEveryMs = 100,
} = {}) {
  const { renderer, records } = await ensureRig({ fresh: true });
  const { createPipelineGovernor } = await import('../../src/vt/pipeline-governor.js');
  const device = renderer.backend.device;
  const crumbs = [];
  const governor = createPipelineGovernor({
    renderer,
    guard: {
      noteCompileStart: (id, label, chars) => crumbs.push(`start ${id} ${label} ${chars}`),
      noteCompileEnd: (id) => crumbs.push(`end ${id}`),
    },
  });
  governor.install();
  const { scene, camera: cam } = SCENARIOS[scenario]({ field, history });
  applySalt(scene, salt);

  const pings = [];
  let pinging = true;
  const pinger = (async () => {
    while (pinging) {
      const t = performance.now();
      device.queue.submit([]);
      await device.queue.onSubmittedWorkDone();
      pings.push(performance.now() - t);
      await yieldTask();
    }
  })();

  // `info.render.drawCalls` also counts three's own output-transform quad, so the SCENARIO's draws are what a
  // render adds beyond an empty scene's.
  const empty = new THREE.Scene();
  renderer.render(empty, cam);
  renderer.info.reset();
  renderer.render(empty, cam);
  const baselineDraws = renderer.info.render.drawCalls;
  const renderScenario = () => {
    renderer.info.reset();
    renderer.render(scene, cam);
    return renderer.info.render.drawCalls - baselineDraws;
  };

  const t0 = performance.now();
  const firstScenarioDraws = blocking ? governor.blocking(renderScenario) : renderScenario();
  const firstRenderMs = Math.round(performance.now() - t0);
  const inFlightAfterFirst = governor.inFlight();
  if (blocking) await device.queue.onSubmittedWorkDone();

  // a production-like loop: draw every tick while the compile runs, noting when the first real draw lands
  let firstDrawAtMs = firstScenarioDraws > 0 ? firstRenderMs : null;
  let framesBeforeFirstDraw = firstScenarioDraws > 0 ? 0 : 1;
  let frames = 1;
  while (governor.inFlight() > 0 && performance.now() - t0 < capMs) {
    await new Promise((r) => setTimeout(r, renderEveryMs));
    const drew = renderScenario();
    frames++;
    if (firstDrawAtMs === null) {
      if (drew > 0) firstDrawAtMs = Math.round(performance.now() - t0);
      else framesBeforeFirstDraw++;
    }
  }
  await governor.idle();
  const idleAtMs = Math.round(performance.now() - t0);

  const createdBefore = governor.report().created;
  const settledScenarioDraws = renderScenario();
  await device.queue.onSubmittedWorkDone();
  const createdAfter = governor.report().created;
  if (firstDrawAtMs === null && settledScenarioDraws > 0) firstDrawAtMs = Math.round(performance.now() - t0);

  pinging = false;
  await pinger;
  const sorted = pings.slice().sort((a, b) => a - b);
  const report = governor.report();
  governor.uninstall();
  return {
    scenario,
    field,
    history,
    blocking,
    salt,
    firstRenderMs,
    baselineDraws,
    firstScenarioDraws,
    inFlightAfterFirst,
    firstDrawAtMs,
    framesBeforeFirstDraw,
    idleAtMs,
    framesWhileCompiling: frames,
    settledScenarioDraws,
    newPipelinesAfterReady: createdAfter - createdBefore,
    gpuPing: {
      samples: sorted.length,
      maxMs: Math.round(sorted.at(-1) ?? 0),
      p95Ms: Math.round(percentile(sorted, 0.95)),
      p50Ms: Math.round(percentile(sorted, 0.5) * 10) / 10,
    },
    pipelines: records.map((r) => ({ label: r.label, vs: r.vsChars, fs: r.fsChars, async: r.async, gpuMs: r.gpuMs })),
    governor: {
      created: report.created,
      sync: report.sync,
      async: report.async,
      overBudget: report.overBudget,
      heavyInBlocking: report.heavyInBlocking,
      failed: report.failed,
      slowest: report.slowest,
      heavyUnflagged: report.heavyUnflagged,
    },
    crumbs,
  };
}

/**
 * THE COMPILE BENCH — every budgeted scenario, COLD, against the numbers stored beside its budget.
 *
 * Run it in the Shader Lab pane before a release, or after changing anything a budget names:
 *
 *   const probe = await import('/tools/shader-lab/cost-probe.js');
 *   (await probe.bench()).table
 *
 * Each scenario in `src/effects/__tests__/shader-budgets.json` is compiled with a fresh salt (so the driver's
 * disk cache cannot turn a 12 s shader into a 12 ms one) and compared with the `measured.gpu` block recorded
 * there. A row is flagged when:
 *
 *   - GREW   — its generated shader is more than `growth` times what was recorded;
 *   - SLOW   — one of its pipelines took longer than `coldMsLimit` and the scenario is not marked
 *              `mustBeDeferrable` (a pipeline that slow and compiled synchronously is the crash);
 *   - SPREAD — its slowest pipeline is past `watchdogMs` even though it IS deferrable: it will not crash the GPU
 *              process, but it is a long wait on a first load and someone should know.
 *
 * The node-side numbers (`census`) are what `npm test` enforces; these are what they MEAN. When a row is
 * deliberately different (a feature landed), copy the printed `proposed` block into the JSON.
 *
 * @param {{only?: string[], growth?: number, coldMsLimit?: number, watchdogMs?: number}} [opts]
 */
export async function bench({ only = null, growth = 1.25, coldMsLimit = 4000, watchdogMs = 12_000 } = {}) {
  const budgets = await (await fetch('/src/effects/__tests__/shader-budgets.json')).json();
  const base = 5000 + (Date.now() % 900000);
  const rows = [];
  let n = 0;
  for (const [key, entry] of Object.entries(budgets.scenarios)) {
    if (only && !only.includes(key)) continue;
    const r = await probe(entry.scenario, { ...(entry.opts ?? {}), salt: base + n++ });
    const sizes = r.detail.map((d) => d.vs + d.fs);
    const times = r.gpuMs.filter(Number.isFinite);
    const stored = entry.measured?.gpu ?? {};
    const chars = r.vsChars + r.fsChars;
    const maxPipelineMs = Math.max(0, ...times);
    const flags = [];
    if (stored.chars && chars > stored.chars * growth) flags.push('GREW');
    if (!entry.mustBeDeferrable && maxPipelineMs > coldMsLimit) flags.push('SLOW');
    if (entry.mustBeDeferrable && maxPipelineMs > watchdogMs) flags.push('SPREAD');
    rows.push({
      key,
      pipelines: r.pipelines,
      chars,
      storedChars: stored.chars ?? null,
      maxPipelineChars: Math.max(0, ...sizes),
      maxPipelineMs,
      coldMs: r.compileMs,
      flags: flags.join(' ') || 'ok',
    });
  }
  const pad = (v, w) => String(v).padEnd(w);
  const table = [
    [
      pad('scenario', 28),
      pad('pipes', 6),
      pad('chars', 8),
      pad('stored', 8),
      pad('max pipe', 9),
      pad('max ms', 7),
      pad('cold ms', 8),
      'flags',
    ].join(' '),
    ...rows.map((x) =>
      [
        pad(x.key, 28),
        pad(x.pipelines, 6),
        pad(x.chars, 8),
        pad(x.storedChars ?? '-', 8),
        pad(x.maxPipelineChars, 9),
        pad(x.maxPipelineMs, 7),
        pad(x.coldMs, 8),
        x.flags,
      ].join(' ')
    ),
  ].join('\n');
  const proposed = Object.fromEntries(
    rows.map((x) => [
      x.key,
      {
        pipelines: x.pipelines,
        chars: x.chars,
        maxPipelineChars: x.maxPipelineChars,
        maxPipelineMs: x.maxPipelineMs,
        coldMs: x.coldMs,
      },
    ])
  );
  return { table, rows, proposed };
}
