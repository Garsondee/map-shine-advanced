/**
 * DUST — the CPU half of the effect, proven in Node: what the sky tells the motes about their light, how the
 * subsystem hands them the wind grid and rebuilds when it changes, and the one number the draw's glints are
 * built on. The kernel and the draw are GPU code: `critter-consumption.test.mjs` builds both to WGSL on a real
 * wind grid, and the critter lab (`tools/shader-lab/critter-lab.js`) looks at them on a real device.
 */
import {
  createCritterSubsystem,
  critterUniformValues,
  moteSkyFromEnv,
  moteLightFromScene,
} from '../critter-subsystem.js';
import { moteActivity } from '../critter-activity.js';
import { glintPeak } from '../mote-render.js';
import { DUST, DUST_PARAMS } from '../dust.js';
import { allocateWindCells, windGridKey } from '../../particles/critter-runtime.js';
import { CRITTER_CAPACITY, critterTierPlan } from '../critter-species.js';

const defaultsOf = (schema) => Object.fromEntries(Object.entries(schema).map(([id, def]) => [id, def.default]));

class FakeScene {
  constructor() {
    this.children = [];
    this.visible = true;
  }
  add(c) {
    this.children.push(c);
  }
  remove(c) {
    this.children = this.children.filter((x) => x !== c);
  }
}

/** One painted disc, in a 640 × 480 world. */
function discGrid() {
  const w = 64;
  const h = 48;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if ((x - 32) ** 2 + (y - 24) ** 2 <= 100) data[y * w + x] = 255;
  return { spec: { x: 0, y: 0, width: w * 10, height: h * 10, w, h, texelW: 10, texelH: 10 }, data };
}

/** A wind handle as the subsystem sees it: a grid and its cells, a version, and whether it has a live ambient. */
const windHandle = (over = {}) => ({
  version: 1,
  grid: { originX: 0, originY: 0, cellSize: 25, cols: 20, rows: 12 },
  cells: { openness: new Float32Array(240).fill(1) },
  ambient: {},
  ...over,
});

function harness({ handle = windHandle(), indoor = [0.2, 0.2, 0.2], outdoor = [1, 1, 1], params = {} } = {}) {
  const spy = { engines: [], windCells: [], updateWind: 0 };
  let current = handle;
  const createEngine = (args) => {
    const e = {
      args,
      kind: args.kind,
      scene: {},
      paramCalls: [],
      active: 0,
      zoneValid: false,
      disposed: false,
      setZone(z) {
        this.zoneValid = !!z.field && z.population > 0;
      },
      setActive(n) {
        this.active = n;
      },
      setParams(p) {
        this.paramCalls.push(p);
      },
      step() {},
      updateWind() {
        spy.updateWind += 1;
      },
      get hasContent() {
        return this.zoneValid && this.active > 0.001;
      },
      debugState: () => ({}),
      resumeToken: () => ({ seeded: true, signature: 1, colony: 0 }),
      dispose() {
        this.disposed = true;
      },
    };
    spy.engines.push(e);
    return e;
  };
  const renderState = {
    enabled: true,
    params: { ...defaultsOf(DUST_PARAMS), ...params },
    perfTier: 2,
    floorIndex: 0,
    elevation: 0,
    gridPx: 100,
    maskGrid: discGrid(),
    maskVersion: 1,
  };
  const sub = createCritterSubsystem({
    THREE: { Scene: FakeScene },
    group: 'dust',
    getRenderState: () => renderState,
    createEngine,
    allocateBuffers: (T, capacity) => ({ capacity }),
    createZoneBuffer: ({ maxCells, homeCapacities }) => ({
      node: {},
      sectionOffsets: homeCapacities.map((_, i) => maxCells + i),
      write: (field) => ({ cellsWritten: field ? field.cols * field.rows : 0, truncated: false }),
    }),
    getWindHandle: () => current,
    allocateWindCells: (T, n) => {
      const cells = { node: { tag: 'wind-cells' }, cells: n };
      spy.windCells.push(cells);
      return cells;
    },
    getIndoorLightRgb: () => indoor,
    getOutdoorLightRgb: () => outdoor,
  });
  return { sub, spy, setHandle: (h) => (current = h) };
}

const NOON = {
  sun: { elevationDeg: 55, azimuthDeg: 180, dayFactor01: 1, golden01: 0 },
  weather: { precip01: 0, cloudCover01: 0 },
  wind: { speed01: 0 },
};
const GOLDEN = { ...NOON, sun: { elevationDeg: 8, azimuthDeg: 250, dayFactor01: 0.9, golden01: 0.9 } };
const NIGHT = { ...NOON, sun: { elevationDeg: -40, azimuthDeg: 0, dayFactor01: 0, golden01: 0 } };
const RENDERER = {};
const RECT = { minX: 0, minY: 0, maxX: 640, maxY: 480 };

export function run(t) {
  // ---- the declaration ---------------------------------------------------------------------------
  t.ok('the dust paints its own `dust` mask', DUST.authoring.paint === 'dust' && DUST.id === 'dust');
  t.ok(
    'dust is a kind with a mote plan whose rungs only ever add',
    [0, 1, 2, 3, 4].every((n) => {
      const p = critterTierPlan('mote', n);
      const q = critterTierPlan('mote', n + 1);
      return n === 4 || ['glint', 'depth', 'sparkle'].every((f) => !p[f] || q[f]);
    })
  );
  t.ok(
    'the standard rung has glints and depth but not the star',
    critterTierPlan('mote', 2).glint && critterTierPlan('mote', 2).depth && !critterTierPlan('mote', 2).sparkle
  );
  t.ok(
    'the dust is not photosensitive: a mote flares at most once a cycle and the cloud is tens of thousands of them',
    DUST.a11y.photosensitive === false
  );

  // ---- uniform conversion ------------------------------------------------------------------------
  const v = critterUniformValues('mote', { ...defaultsOf(DUST_PARAMS), color: '#ff0000' });
  t.ok('a dust colour becomes an sRGB triple', v.color.join() === '1,0,0');
  t.ok('plain numbers pass through by their own names', v.sparkle === DUST_PARAMS.sparkle.default);

  // ---- what the sky tells a mote about its light -------------------------------------------------
  const noon = moteSkyFromEnv(NOON);
  const golden = moteSkyFromEnv(GOLDEN);
  t.ok(
    'the sunbeam slants: a finite shift per px of height',
    noon.sunShift.length === 2 && noon.sunShift.every(Number.isFinite)
  );
  t.ok(
    'a low sun leans the beam further than a high one (the same throw a shadow has)',
    Math.hypot(...golden.sunShift) > Math.hypot(...noon.sunShift)
  );
  t.ok(
    'the beam never leans more than 2.5 px per px of height',
    Math.hypot(...moteSkyFromEnv(NIGHT).sunShift) <= 2.5 + 1e-9
  );
  t.ok('the golden hour is read from the sun', golden.sunLow === 0.9 && noon.sunLow === 0);
  t.ok(
    'no sky at all is a calm, flat noon — never a throw',
    (() => {
      const s = moteSkyFromEnv(null);
      return s.sunShift.every(Number.isFinite) && s.sunLow === 0;
    })()
  );
  t.ok(
    'a golden01 outside 0..1 is clamped',
    moteSkyFromEnv({ ...NOON, sun: { ...NOON.sun, golden01: 4 } }).sunLow === 1
  );

  // ---- the room's own light against the window's ------------------------------------------------
  const lit = moteLightFromScene([0.2, 0.22, 0.24], [1, 1, 1]);
  t.ok('the room light is what the shader subtracts', lit.lightBase.join() === '0.2,0.22,0.24');
  t.ok(
    'the beam range is how much brighter than the room a full window can make the floor',
    Math.abs(lit.beamRef - (1 - (0.2126 * 0.2 + 0.7152 * 0.22 + 0.0722 * 0.24))) < 1e-9
  );
  t.ok(
    'a moonlit window still has a range',
    moteLightFromScene([0.02, 0.02, 0.02], [0.03, 0.03, 0.05]).beamRef === 0.08
  );
  t.ok(
    'a window as dark as the room has the floor range, not zero or negative',
    moteLightFromScene([0.5, 0.5, 0.5], [0.3, 0.3, 0.3]).beamRef === 0.08
  );
  t.ok('the range is capped', moteLightFromScene([0, 0, 0], [9, 9, 9]).beamRef === 1.5);
  const unknown = moteLightFromScene(null, null);
  t.ok(
    'with no light known the dust assumes a grey room and a moderate window',
    unknown.lightBase.join() === '0.3,0.3,0.3' && unknown.beamRef === 0.45
  );
  t.ok(
    'garbage in is not NaN out',
    Number.isFinite(moteLightFromScene([NaN, 0, 0], ['x', 1, 1]).beamRef) &&
      moteLightFromScene([NaN, 0, 0], [1, 1, 1]).lightBase.every(Number.isFinite)
  );

  // ---- the head-count follows the weather and nothing else --------------------------------------
  const calm = { ...defaultsOf(DUST_PARAMS) };
  t.ok(
    'dust is out at noon, at dusk-golden and at night alike (the LIGHT decides what shows)',
    [NOON, GOLDEN, NIGHT].every((e) => moteActivity(e, calm) === 1)
  );
  const gale = { ...NOON, wind: { speed01: 1, gustiness01: 1 } };
  t.ok('a gale thins it', moteActivity(gale, calm) < 1);
  t.ok('…but never below the brave few', moteActivity(gale, calm) >= calm.weatherFloor - 1e-9);
  t.ok(
    'rain does not clear it by default (dust is indoors)',
    moteActivity({ ...NOON, weather: { precip01: 1, precipKind: 'rain' } }, calm) === 1
  );

  // ---- the glint keeps the cloud's brightness ---------------------------------------------------
  const cycleMean = (sharpness) => {
    let sum = 0;
    const steps = 20000;
    for (let i = 0; i < steps; i++) {
      const g = Math.max(Math.cos((i / steps) * Math.PI * 2), 0) ** sharpness;
      sum += 0.2 + glintPeak(sharpness) * g;
    }
    return sum / steps;
  };
  t.ok(
    'a glint adds sparkle, not light: the mean over a tumble stays near 1 at every sharpness',
    [1, 3, 9, 20, 40].every((n) => cycleMean(n) > 0.8 && cycleMean(n) < 1.05)
  );
  t.ok('a sharper glint is a taller one', glintPeak(40) > glintPeak(9) && glintPeak(9) > glintPeak(1));
  t.ok('a bad sharpness is floored, never NaN', Number.isFinite(glintPeak(0)) && glintPeak(0) > 0);

  // ---- the wind grid: allocation and the key a kernel is rebuilt on -----------------------------
  const THREE = { TSL: { instancedArray: (n, type) => ({ n, type }) } };
  const small = allocateWindCells(THREE, 240);
  t.ok(
    'wind cells are two vec4s a cell, in a bucket of 16384 cells',
    small.node.n === 16384 * 2 && small.node.type === 'vec4' && small.cells === 16384
  );
  t.ok('a bigger grid gets the next bucket', allocateWindCells(THREE, 16385).cells === 32768);
  t.ok(
    'no handle, or a handle with no cells, is "none"',
    windGridKey(null) === 'none' && windGridKey({ grid: {} }) === 'none'
  );
  t.ok(
    'the key changes with the grid and with a live ambient, and not with the version',
    windGridKey(windHandle()) !==
      windGridKey(windHandle({ grid: { originX: 0, originY: 0, cellSize: 50, cols: 10, rows: 6 } })) &&
      windGridKey(windHandle()) !== windGridKey(windHandle({ ambient: null })) &&
      windGridKey(windHandle()) === windGridKey(windHandle({ version: 9 }))
  );

  // ---- the subsystem builds a mote engine and hands it the wind -----------------------------------
  {
    const { sub, spy } = harness();
    sub.sync(RENDERER, 1000, 0.016, RECT, NOON);
    const e = spy.engines[0];
    t.ok('one engine, of the mote kind', spy.engines.length === 1 && e.kind === 'mote');
    t.ok('its arena is the mote capacity', e.args.memory.capacity === CRITTER_CAPACITY.mote);
    t.ok(
      'it is handed the live wind handle and a cell buffer',
      e.args.windHandle?.grid?.cols === 20 && e.args.windCells?.node?.tag === 'wind-cells'
    );
    t.ok(
      'the cell buffer is sized for the grid (one bucket)',
      spy.windCells.length === 1 && spy.windCells[0].cells === 240
    );
    t.ok('it draws', sub.hasContent);
    const pushed = e.paramCalls.find((c) => 'expectedDepth' in c);
    t.ok(
      'the sky and the room light ride along with the author’s values',
      pushed && Array.isArray(pushed.sunShift) && Array.isArray(pushed.lightBase) && pushed.beamRef > 0
    );
    sub.sync(RENDERER, 1016, 0.016, RECT, NOON);
    t.ok(
      'the wind cells are refreshed every frame (a rebake is a version bump the engine checks)',
      spy.updateWind >= 2
    );
    t.ok(
      'a second frame at the same sky does not rebuild the engine or reallocate',
      spy.engines.length === 1 && spy.windCells.length === 1
    );
    sub.sync(RENDERER, 1032, 0.016, RECT, NIGHT);
    t.ok('night does not hide the dust', sub.hasContent && spy.engines[0].active > 0);
  }
  {
    const { sub, spy, setHandle } = harness();
    sub.sync(RENDERER, 1000, 0.016, RECT, NOON);
    const bigger = windHandle({
      grid: { originX: 0, originY: 0, cellSize: 25, cols: 40, rows: 30 },
      cells: { openness: new Float32Array(1200).fill(1) },
    });
    setHandle(bigger);
    sub.sync(RENDERER, 1016, 0.016, RECT, NOON);
    t.ok('a new wind grid rebuilds the engine (its size is baked into the kernel)', spy.engines.length === 2);
    t.ok(
      '…and the old engine gives back what the renderer holds for it',
      spy.engines[0].disposed === true && !spy.engines[1].disposed
    );
    t.ok(
      '…on the new grid, REUSING the cell buffer (both grids fit one 16384-cell bucket; a storage buffer can never be freed)',
      spy.engines[1].args.windHandle.grid.cols === 40 &&
        spy.windCells.length === 1 &&
        spy.engines[1].args.windCells === spy.engines[0].args.windCells
    );
    const before = spy.updateWind;
    setHandle({ ...bigger, version: 7 });
    sub.sync(RENDERER, 1032, 0.016, RECT, NOON);
    t.ok(
      'a rebake of the SAME grid (a version bump) rebuilds nothing, it only refreshes the cells',
      spy.engines.length === 2 && spy.updateWind > before
    );
  }
  {
    const { sub, spy } = harness({ handle: null });
    sub.sync(RENDERER, 1000, 0.016, RECT, NOON);
    t.ok(
      'with no wind handle the dust still builds, on the map-wide wind',
      spy.engines.length === 1 && spy.engines[0].args.windHandle === null && spy.windCells.length === 0
    );
  }
  {
    const { sub, spy } = harness({ indoor: null, outdoor: null });
    sub.sync(RENDERER, 1000, 0.016, RECT, NOON);
    const pushed = spy.engines[0].paramCalls.find((c) => 'expectedDepth' in c);
    t.ok(
      'no light known is a default, not a crash',
      pushed.lightBase.every(Number.isFinite) && pushed.beamRef === 0.45
    );
  }
  {
    const { sub, spy } = harness({ params: { countPerZone: 0 } });
    sub.sync(RENDERER, 1000, 0.016, RECT, NOON);
    t.ok('zero dust per cloud builds nothing', spy.engines.length === 0 && !sub.hasContent);
  }
}
