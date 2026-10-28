/**
 * core/compile-policy.js — WHICH PIPELINES MAY COMPILE OFF THE GPU'S MAIN THREAD (2026-10-27, epic mmp-fpu).
 *
 * ============================================================================
 * THE PROBLEM THIS IS THE POLICY HALF OF
 * ============================================================================
 * three's ordinary `renderer.render()` creates a missing pipeline with the
 * SYNCHRONOUS `device.createRenderPipeline`. In Chrome that compile runs on the
 * GPU process's main thread, which a watchdog kills after ~15 s of silence. One
 * candle pipeline took 19.7 s on the author's card (`tools/shader-lab/cost-probe.js`),
 * so a cold load did not merely stutter: it lost the device, and with it every
 * context on the page.
 *
 * `createRenderPipelineAsync` compiles on a worker thread instead. three already
 * supports it (`compileAsync`) and already knows how to draw around a pipeline
 * that is not ready yet: `_renderObjectDirect` draws only when
 * `pipelines.isReady(renderObject)`. So an async pipeline costs nothing but
 * a few frames in which that one object is not drawn.
 *
 * ## Which pipelines
 *
 * "A few frames in which it is not drawn" is harmless for something redrawn every
 * frame (a light bucket, a flame, a canopy) and WRONG for a one-shot pass that
 * marks itself done after drawing (a bake, a derivation). The policy is therefore
 * explicit about both, in this order:
 *
 *   1. `markCompileSyncOnly(material)`     — never deferred. For one-shot GPU work.
 *   2. `markCompileDeferrable(material)`   — always deferred. For per-frame effects.
 *   3. a pipeline whose generated shader is `HEAVY_PIPELINE_CHARS` or larger is
 *      deferred anyway, and named in the log so someone decides which of 1 or 2
 *      it should have carried. A shader that big is a per-frame effect almost by
 *      definition, and the alternative is the crash this module exists for.
 *   4. everything else compiles as it always did.
 *
 * Pure: no renderer, no clock — Node-tested.
 *
 * @module core/compile-policy
 */

/** Generated WGSL (vertex + fragment) at or above this many characters is deferred even when unmarked. */
export const HEAVY_PIPELINE_CHARS = 45_000;

const DEFER_KEY = 'msaDeferCompile';
const SYNC_KEY = 'msaSyncCompile';

/**
 * This material is redrawn every frame; it may compile asynchronously and appear a few frames late.
 * @template {{userData?: any}} M
 * @param {M} material @param {string|true} [why] - one line for the log if it ever matters.
 * @returns {M} the same material, for chaining.
 */
export function markCompileDeferrable(material, why = true) {
  if (material) {
    material.userData = material.userData ?? {};
    material.userData[DEFER_KEY] = why;
  }
  return material;
}

/**
 * This material does one-shot GPU work: skipping its first draw would lose the result. Never deferred,
 * however large its shader.
 * @template {{userData?: any}} M
 * @param {M} material @param {string|true} [why]
 * @returns {M}
 */
export function markCompileSyncOnly(material, why = true) {
  if (material) {
    material.userData = material.userData ?? {};
    material.userData[SYNC_KEY] = why;
  }
  return material;
}

/**
 * @param {{userData?: any}|null|undefined} material
 * @param {number} chars - the pipeline's generated shader size, vertex + fragment.
 * @returns {{mode: 'async'|'sync', reason: 'sync-only'|'flagged'|'heavy'|'default'}}
 */
export function compilePolicyFor(material, chars) {
  const data = material?.userData;
  if (data?.[SYNC_KEY]) return { mode: 'sync', reason: 'sync-only' };
  if (data?.[DEFER_KEY]) return { mode: 'async', reason: 'flagged' };
  if (Number.isFinite(chars) && chars >= HEAVY_PIPELINE_CHARS) return { mode: 'async', reason: 'heavy' };
  return { mode: 'sync', reason: 'default' };
}
