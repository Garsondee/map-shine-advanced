/**
 * THE COMPUTE SPIKE — throwaway proof that renderer.compute() actually runs.
 *
 * ============================================================================
 * WHY (and why it is throwaway)
 * ============================================================================
 *
 * Nothing in this codebase has ever called `renderer.compute()` (verified
 * 2026-07-21 — the only prior hits were doc-comments). The particle engine is the
 * first, so before the kernel that rides on it is built (Particles.md §23 step 2),
 * this proves the ground is solid: it runs ONE compute dispatch that writes a
 * known, non-trivial formula into a real storage buffer, reads it back, and
 * asserts the values moved. That is the bar `diag/tsl-spike.js` set for the RENDER
 * port — "a real pixel, on the author's own 3070, on BOTH backends" — not the
 * inert "it didn't throw" the legacy build's `build:tsl` met. DELETE this file
 * once it is green (memory: keyhole-webgpu-tsl-decision).
 *
 * It is STANDALONE (its own throwaway renderer, disposed immediately) on purpose:
 * the app renderer is closure-captured in `vt/vt-pan-viewer.js`, which a standing
 * decision says not to touch, and a fresh WebGPU device answers the only question
 * this asks — "does compute run on this machine, on each backend" — just as well.
 * The fuller check (compute alongside the live VT pipeline) arrives for free at
 * step 2, when the real kernel dispatches inside the frame.
 *
 * It allocates through the real {@link ParticleArena} (Particles.md §10), so it
 * also proves `arena.allocateBuffers()`'s `instancedArray` path — the one
 * storage-buffer door — actually allocates. THREE and the arena are imported
 * DYNAMICALLY, so this module's top level stays THREE-free and the pure verdict
 * logic below is Node-testable without bundling the 2.8 MB renderer.
 *
 * Reports per STAGE (init / allocate / build / dispatch / readback), so a setup
 * failure never masquerades as "compute is broken" and vice-versa
 * (memory: feedback_instruments_must_not_lie).
 *
 * @module diag/compute-spike
 */

import { createLogger } from '../core/log.js';

const log = createLogger('compute-spike');

/** Small enough to read back instantly, big enough that a pattern is unmistakable. */
export const SPIKE_COUNT = 16;

/**
 * The value slot `i` MUST hold after the kernel runs. Deliberately NOT the
 * identity and NOT zero, so a kernel that never ran (all zero) and one that ran
 * wrong (some other pattern) are both distinguishable from success.
 * @param {number} i
 * @returns {number}
 */
export function expectedSpikeValue(i) {
  return i * 2 + 1;
}

/**
 * Pure verdict: do the read-back values prove compute ran correctly? Node-tested,
 * because an instrument that guesses is worse than none.
 * @param {number[]} values
 * @param {number} count
 * @returns {{ok: boolean, verdict: string, detail: string, sample?: object[]}}
 */
export function classifySpikeResult(values, count) {
  if (!Array.isArray(values) || values.length < count) {
    return {
      ok: false,
      verdict: 'unreadable',
      detail: `expected ${count} values, read back ${Array.isArray(values) ? values.length : 0}`,
    };
  }
  const wrong = [];
  let allZero = true;
  for (let i = 0; i < count; i++) {
    if (values[i] !== 0) allZero = false;
    if (values[i] !== expectedSpikeValue(i)) wrong.push({ slot: i, got: values[i], want: expectedSpikeValue(i) });
  }
  if (wrong.length === 0) return { ok: true, verdict: 'compute-works', detail: `all ${count} slots hold i*2+1` };
  if (allZero) {
    return {
      ok: false,
      verdict: 'no-write',
      detail: 'every slot is still zero — the dispatch did not run or wrote nothing (NOT "wrong maths")',
    };
  }
  return {
    ok: false,
    verdict: 'wrong-values',
    detail: `${wrong.length}/${count} slots wrong — the kernel ran but the result is off (buffer stride? maths?)`,
    sample: wrong.slice(0, 4),
  };
}

/**
 * Run the spike on ONE backend. Fully self-contained and independent, so WebGL2
 * failing does not stop WebGPU from reporting (and vice-versa). Names the last
 * stage reached, so a setup failure is never read as a compute failure.
 * @returns {Promise<object>}
 */
async function runOnBackend(THREE, ParticleArena, bytesPerParticle, forceWebGL) {
  const requested = forceWebGL ? 'webgl2' : 'webgpu';
  let stage = 'init';
  let renderer = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
    await renderer.init();
    const actualBackend = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';

    stage = 'allocate';
    const { Fn, instanceIndex, float } = THREE.TSL;
    const arena = new ParticleArena({ budgetBytes: bytesPerParticle * SPIKE_COUNT });
    const buffers = arena.allocateBuffers(THREE.TSL);
    const age = buffers.age; // a float storage node, `arena.capacity` long

    stage = 'build';
    // The whole point, in one line: each invocation writes a known formula into
    // its own slot. If this dispatches and the buffer changes, compute works.
    const kernel = Fn(() => {
      age.element(instanceIndex).assign(float(instanceIndex).mul(2).add(1));
    })().compute(arena.capacity);

    stage = 'dispatch';
    await renderer.computeAsync(kernel);

    stage = 'readback';
    const raw = await renderer.getArrayBufferAsync(age.value);
    const values = Array.from(new Float32Array(raw)).slice(0, arena.capacity);

    return { requested, actualBackend, count: arena.capacity, ...classifySpikeResult(values, arena.capacity), values };
  } catch (err) {
    log.error(`compute spike (${requested}) failed at stage '${stage}'`, err);
    return {
      requested,
      ok: false,
      verdict: `failed-at-${stage}`,
      detail:
        `${stage} threw: ${err?.message ?? String(err)} — a failure at 'init'/'allocate'/'build' is a ` +
        "SETUP problem, not proof compute is broken; only 'dispatch'/'readback' would implicate compute itself.",
    };
  } finally {
    try {
      renderer?.dispose?.();
    } catch (err) {
      log.error(`compute spike (${requested}) renderer dispose threw`, err);
    }
  }
}

/**
 * Browser-only. Proves `renderer.compute()` on BOTH backends via two independent
 * throwaway renderers. Returns per-backend verdicts and a one-line summary; safe
 * to run repeatedly. THREE + the arena are imported HERE (not at module top) so
 * the pure verdict logic above stays Node-testable without the renderer.
 *
 * @returns {Promise<object>}
 */
export async function runComputeSpike() {
  if (typeof document === 'undefined') {
    return { skipped: true, reason: 'no DOM — the compute spike is browser-only (run it from the debug panel)' };
  }

  const loaded = await Promise.all([import('../vendor/three/three.webgpu.js'), import('../effects/index.js')]).catch(
    (err) => {
      log.error('compute spike could not load THREE / the arena', err);
      return null;
    }
  );
  if (!loaded)
    return { ok: false, verdict: 'module-load-failed', detail: 'dynamic import of THREE or the arena failed' };

  const [THREE, effects] = loaded;
  const { ParticleArena, BYTES_PER_PARTICLE } = effects;

  const webgpu = await runOnBackend(THREE, ParticleArena, BYTES_PER_PARTICLE, false);
  const webgl2 = await runOnBackend(THREE, ParticleArena, BYTES_PER_PARTICLE, true);

  const ok = !!webgpu.ok && !!webgl2.ok;
  const summary = ok
    ? 'renderer.compute() WORKS on both backends — the ground is solid; build the kernel (Particles.md §23 step 2).'
    : `compute proof INCOMPLETE — webgpu:${webgpu.verdict}, webgl2:${webgl2.verdict}. Read the per-backend detail before building the kernel.`;
  log.info(summary);
  return { ok, summary, webgpu, webgl2 };
}
