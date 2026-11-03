/**
 * vt/kept-renderer.js — ONE GPU DEVICE FOR THE WHOLE SESSION, AND THE LAST SCENES' PIPELINES KEPT
 * (2026-11-03, epic mmp-8gf.2).
 *
 * ============================================================================
 * WHAT A SCENE CHANGE USED TO COST
 * ============================================================================
 * Every genuine scene change stopped the viewer and `renderer.dispose()`d it: the GPU device, every compiled
 * pipeline and every shader module went with it, and the next scene built a brand-new device (seconds on a cold
 * driver) and compiled everything again. Measured on the private rig (Big Bank <-> Deep Forest, 2026-11-03):
 * 37% of Deep Forest's shader text was byte-identical to what Big Bank had just compiled, and on the way BACK
 * 77% of Big Bank's (1.5 M chars, 75 of 101 modules) was — and the return trip still spent 19 s compiling.
 *
 * ============================================================================
 * WHY KEEPING THE RENDERER IS NOT ENOUGH ON ITS OWN
 * ============================================================================
 * three keeps a pipeline only while something uses it: `Pipelines.delete` drops a pipeline (and its shader
 * modules) the moment its `usedTimes` reaches 0, and the viewer's teardown disposes every material. So the
 * teardown first PINS every live pipeline (one extra use each, on the pipeline and its programs), then
 * disposes as before. A next scene whose material builds the same WGSL with the same draw state finds the
 * pipeline in three's own cache (`_getRenderCacheKey` is programs + state, no object ids) and creates nothing.
 * Compute pipelines are keyed by node id, so only their shader module carries over.
 *
 * Pins live for {@link KEEP_SCENES} scene changes, then are released exactly as three would have released
 * them. The device itself is kept until a loss, a crash slide, or the revert flag says otherwise; a lost or
 * WebGL2 renderer is never kept. The canvas is NOT reused: each start makes its own as before and the kept
 * renderer is pointed at it (`setCanvasTarget`, three's own API), so nothing that listens on a canvas can
 * double up.
 *
 * Revert: localStorage `msa.keepDevice` = '0' and reload (every scene change disposes, as before).
 *
 * @module vt/kept-renderer
 */

/** How many scene changes a pipeline stays pinned for after its last use (A -> B -> A keeps A's). */
export const KEEP_SCENES = 2;

/** @returns {boolean} false only when the revert flag is set. */
export function keepDeviceEnabled() {
  try {
    return globalThis.localStorage?.getItem('msa.keepDevice') !== '0';
  } catch {
    return true;
  }
}

/**
 * HDR output asked for (epic mmp-8gf.4): localStorage `msa.hdrOutput` = '1', then reload. Off by default. Read when
 * a renderer is CREATED; a kept renderer keeps the choice it was born with, so a change needs a reload.
 * @returns {boolean}
 */
export function hdrOutputRequested() {
  try {
    return globalThis.localStorage?.getItem('msa.hdrOutput') === '1';
  } catch {
    return false;
  }
}

/** A renderer worth keeping: WebGPU, initialised, device not lost. */
export function rendererIsKeepable(renderer) {
  return (
    !!renderer &&
    renderer._isDeviceLost !== true &&
    renderer.backend?.isWebGPUBackend === true &&
    !!renderer.backend?.device &&
    !!renderer._pipelines?.caches
  );
}

function programsOf(pipeline) {
  return pipeline?.isComputePipeline ? [pipeline.computeProgram] : [pipeline?.vertexProgram, pipeline?.fragmentProgram];
}

/**
 * One extra use on every pipeline that something really uses right now (and on each one's programs), so
 * disposing the materials that use them leaves them alive. A pipeline alive ONLY because of earlier pins
 * (`heldPins` of its uses are ours) is not pinned again — or no pin would ever expire.
 * @param {any} renderer @param {Map<object, number>} [heldPins] - pins already held per pipeline.
 * @returns {Array<object>} the pinned pipelines.
 */
export function pinLivePipelines(renderer, heldPins = null) {
  const caches = renderer?._pipelines?.caches;
  if (!caches) return [];
  const pinned = [];
  for (const pipeline of caches.values()) {
    if (!pipeline || typeof pipeline.usedTimes !== 'number') continue;
    if (pipeline.usedTimes <= (heldPins?.get(pipeline) ?? 0)) continue;
    pipeline.usedTimes++;
    for (const program of programsOf(pipeline)) if (program) program.usedTimes++;
    pinned.push(pipeline);
  }
  return pinned;
}

/** Take back the uses `pinLivePipelines` added, releasing anything left unused — three's `Pipelines.delete`. */
export function unpinPipelines(renderer, pinned) {
  const p = renderer?._pipelines;
  if (!p || !Array.isArray(pinned)) return 0;
  let released = 0;
  for (const pipeline of pinned) {
    pipeline.usedTimes--;
    if (pipeline.usedTimes === 0) {
      p._releasePipeline(pipeline);
      released++;
    }
    for (const program of programsOf(pipeline)) {
      if (!program) continue;
      program.usedTimes--;
      if (program.usedTimes === 0) p._releaseProgram(program);
    }
  }
  return released;
}

/**
 * The keeper: at most ONE parked renderer, with the pins of the last {@link KEEP_SCENES} teardowns.
 * @param {{ log?: {info?: Function, warn?: Function} }} [opts]
 */
export function createRendererKeeper({ log = null } = {}) {
  /** @type {{renderer: any, ring: Array<Array<object>>} | null} */
  let parked = null;
  /** The renderer currently in use, adopted or new, and its pin ring (carried forward at the next park). */
  let liveRing = [];
  const stats = { parks: 0, adopts: 0, fresh: 0, releasedPipelines: 0, disposed: 0, lastPinned: 0 };

  function disposeRenderer(renderer, ring) {
    for (const pins of ring) {
      try {
        unpinPipelines(renderer, pins);
      } catch {
        /* a dead backend — dispose frees it all anyway */
      }
    }
    try {
      renderer.dispose();
      stats.disposed++;
    } catch (err) {
      log?.warn?.('kept renderer dispose failed — GPU context may be leaked:', err);
    }
  }

  return {
    /**
     * Before the viewer disposes its materials: pin the live pipelines. Returns whether this renderer will be
     * kept (the caller then skips `renderer.dispose()` and calls {@link park} last).
     */
    prepareToPark(renderer) {
      if (!keepDeviceEnabled() || !rendererIsKeepable(renderer)) return false;
      const held = new Map();
      for (const ring of liveRing) for (const p of ring) held.set(p, (held.get(p) ?? 0) + 1);
      const pins = pinLivePipelines(renderer, held);
      stats.lastPinned = pins.length;
      liveRing = [pins, ...liveRing];
      while (liveRing.length > KEEP_SCENES) {
        stats.releasedPipelines += unpinPipelines(renderer, liveRing.pop());
      }
      return true;
    },
    /** Last step of teardown for a renderer `prepareToPark` accepted. */
    park(renderer) {
      if (parked && parked.renderer !== renderer) disposeRenderer(parked.renderer, parked.ring);
      parked = { renderer, ring: liveRing };
      liveRing = [];
      stats.parks++;
    },
    /**
     * The parked renderer, pointed at `canvas`, or null (none parked, revert flag, or it died while parked —
     * then it is disposed here). The caller makes a new one on null.
     */
    adopt(canvas, THREE) {
      if (!parked) return null;
      const { renderer, ring } = parked;
      parked = null;
      if (!keepDeviceEnabled() || !rendererIsKeepable(renderer) || typeof renderer.setCanvasTarget !== 'function') {
        disposeRenderer(renderer, ring);
        return null;
      }
      const previous = renderer.getCanvasTarget?.();
      renderer.setCanvasTarget(new THREE.CanvasTarget(canvas));
      try {
        previous?.dispose?.();
      } catch {
        /* the old canvas is already out of the DOM; its context goes with it */
      }
      liveRing = ring;
      stats.adopts++;
      log?.info?.(`kept GPU device adopted (${ring.reduce((a, r) => a + r.length, 0)} pinned pipelines carried)`);
      return renderer;
    },
    /** A brand-new renderer is in use (no parked one, or it could not be adopted). */
    noteFresh() {
      liveRing = [];
      stats.fresh++;
    },
    /** Dispose whatever is parked (a crash slide, safe mode, the revert flag). */
    releaseParked() {
      if (!parked) return;
      disposeRenderer(parked.renderer, parked.ring);
      parked = null;
    },
    hasParked: () => !!parked,
    stats: () => ({ ...stats, parked: !!parked, liveRingSizes: liveRing.map((r) => r.length) }),
  };
}
