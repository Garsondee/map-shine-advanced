/**
 * THE KEPT DEVICE (vt/kept-renderer.js, epic mmp-8gf.2) against a stand-in for three's `Pipelines`: the same
 * `caches` / `programs` / `usedTimes` / `_releasePipeline` / `_releaseProgram` shape `Pipelines.delete` works on.
 */
import {
  createRendererKeeper,
  pinLivePipelines,
  unpinPipelines,
  KEEP_SCENES,
  rendererIsKeepable,
} from '../kept-renderer.js';

function fakeRenderer() {
  const caches = new Map();
  const programs = { vertex: new Map(), fragment: new Map(), compute: new Map() };
  const pipelines = {
    caches,
    programs,
    _releasePipeline(p) {
      caches.delete(p.cacheKey);
    },
    _releaseProgram(prog) {
      programs[prog.stage].delete(prog.code);
    },
  };
  let target = {
    domElement: 'canvas-0',
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
  const r = {
    _isDeviceLost: false,
    disposed: 0,
    backend: { isWebGPUBackend: true, device: {} },
    _pipelines: pipelines,
    getCanvasTarget: () => target,
    setCanvasTarget(t) {
      target = t;
    },
    dispose() {
      this.disposed++;
    },
  };
  /** A material's pipeline coming to life: three's getForRender counts one use each. */
  r.use = (key) => {
    let p = caches.get(key);
    if (!p) {
      const v = programs.vertex.get(key) ?? { stage: 'vertex', code: key, usedTimes: 0 };
      const f = programs.fragment.get(key) ?? { stage: 'fragment', code: key, usedTimes: 0 };
      programs.vertex.set(key, v);
      programs.fragment.set(key, f);
      p = { cacheKey: key, usedTimes: 0, vertexProgram: v, fragmentProgram: f };
      caches.set(key, p);
    }
    p.usedTimes++;
    p.vertexProgram.usedTimes++;
    p.fragmentProgram.usedTimes++;
    return p;
  };
  /** A material disposed: three's Pipelines.delete. */
  r.drop = (p) => unpinPipelines(r, [p]);
  return r;
}
const THREE = {
  CanvasTarget: class {
    constructor(c) {
      this.domElement = c;
    }
  },
};

export function run(t) {
  // pin survives the materials' disposal; unpin releases exactly as three would
  {
    const r = fakeRenderer();
    const a = r.use('A');
    const b = r.use('B');
    const pins = pinLivePipelines(r);
    r.drop(a);
    r.drop(b);
    t.ok(
      'pinned pipelines survive their materials being disposed',
      r._pipelines.caches.has('A') && r._pipelines.caches.has('B')
    );
    t.ok('…and so do their shader modules', r._pipelines.programs.fragment.has('A'));
    unpinPipelines(r, pins);
    t.ok(
      'unpinning an unused pipeline releases it and its programs, like Pipelines.delete',
      r._pipelines.caches.size === 0 && r._pipelines.programs.vertex.size === 0
    );
  }
  // a still-used pipeline is not released by an unpin
  {
    const r = fakeRenderer();
    const a = r.use('A');
    const pins = pinLivePipelines(r);
    unpinPipelines(r, pins);
    t.ok('an unpin never releases a pipeline something still uses', r._pipelines.caches.has('A') && a.usedTimes === 1);
  }
  // park -> adopt keeps the device and points it at the new canvas
  {
    const k = createRendererKeeper();
    const r = fakeRenderer();
    r.use('A');
    t.ok('a healthy WebGPU renderer is kept', k.prepareToPark(r) === true);
    k.park(r);
    t.ok('nothing is disposed when parking', r.disposed === 0 && k.hasParked());
    const got = k.adopt('canvas-1', THREE);
    t.ok('the next start adopts the same renderer', got === r);
    t.ok('…pointed at the NEW canvas (setCanvasTarget)', r.getCanvasTarget().domElement === 'canvas-1');
    t.ok('nothing is parked while it is in use', !k.hasParked());
  }
  // pins last KEEP_SCENES scene changes: A -> B -> A keeps A's
  {
    const k = createRendererKeeper();
    const r = fakeRenderer();
    const pa = r.use('A');
    k.prepareToPark(r);
    r.drop(pa);
    k.park(r);
    k.adopt('c', THREE);
    const pb = r.use('B');
    k.prepareToPark(r);
    r.drop(pb);
    k.park(r);
    t.ok(
      `A's pipeline is still cached after one more scene (KEEP_SCENES=${KEEP_SCENES})`,
      r._pipelines.caches.has('A')
    );
    k.adopt('c', THREE);
    k.prepareToPark(r);
    k.park(r);
    k.adopt('c', THREE);
    k.prepareToPark(r);
    k.park(r);
    t.ok(
      '…and released once it has gone unused for longer than that',
      !r._pipelines.caches.has('A') && !r._pipelines.caches.has('B')
    );
  }
  // never keep a lost device or a WebGL2 backend; a renderer that died while parked is disposed at adopt
  {
    const k = createRendererKeeper();
    const lost = fakeRenderer();
    lost._isDeviceLost = true;
    t.ok('a lost device is never kept', k.prepareToPark(lost) === false && !rendererIsKeepable(lost));
    const gl = fakeRenderer();
    gl.backend.isWebGPUBackend = false;
    t.ok('a WebGL2 renderer is never kept', k.prepareToPark(gl) === false);
    const r = fakeRenderer();
    k.prepareToPark(r);
    k.park(r);
    r._isDeviceLost = true;
    t.ok('a renderer lost while parked is refused at adopt', k.adopt('c', THREE) === null);
    t.ok('…and disposed', r.disposed === 1);
  }
  // the revert flag
  {
    const store = new Map();
    const prev = globalThis.localStorage;
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null };
    store.set('msa.keepDevice', '0');
    const k = createRendererKeeper();
    t.ok('msa.keepDevice = 0 turns keeping off', k.prepareToPark(fakeRenderer()) === false);
    globalThis.localStorage = prev;
  }
  // a second park never strands the first renderer
  {
    const k = createRendererKeeper();
    const r1 = fakeRenderer();
    const r2 = fakeRenderer();
    k.prepareToPark(r1);
    k.park(r1);
    k.prepareToPark(r2);
    k.park(r2);
    t.ok(
      'parking a different renderer disposes the one already parked (never two live devices)',
      r1.disposed === 1 && r2.disposed === 0
    );
  }
}
