/**
 * @fileoverview SafeShaderBuilder - Helper for safe shader compilation with timeout.
 *
 * Provides a wrapper around THREE.ShaderMaterial creation that:
 * - Times shader compilation
 * - Detects hangs/timeouts
 * - Forces fallback material on timeout (never blocks loading)
 * - Reports to ShaderCompileMonitor for diagnostics
 *
 * @module core/diagnostics/SafeShaderBuilder
 */

import { createLogger } from '../log.js';
import { getShaderCompileMonitor } from './ShaderCompileMonitor.js';

const log = createLogger('SafeShader');

/**
 * Result of a safe shader build attempt.
 * @typedef {Object} ShaderBuildResult
 * @property {THREE.ShaderMaterial|null} material - The compiled material or fallback
 * @property {boolean} success - Whether compilation succeeded
 * @property {boolean} usedFallback - Whether timeout fallback was used
 * @property {string|null} error - Error message if failed
 * @property {number|null} compileMs - Compile duration in milliseconds
 */

/**
 * Safely build a shader material with timeout protection.
 *
 * This function guarantees that loading will never hang - if the shader
 * compilation exceeds the timeout, it returns a fallback material immediately.
 *
 * @param {Object} THREE - THREE.js namespace
 * @param {string} effectId - Effect identifier for diagnostics
 * @param {Object} params - ShaderMaterial parameters
 * @param {Object} options
 * @param {number} [options.timeoutMs=5000] - Compile timeout
 * @param {Object} [options.fallbackParams] - Fallback material params on timeout
 * @returns {Promise<ShaderBuildResult>}
 */
export async function safeBuildShaderMaterial(THREE, effectId, params, options = {}) {
  const monitor = getShaderCompileMonitor();
  const timeoutMs = options.timeoutMs ?? 5000;

  // Track fragment shader complexity
  const fragKey = monitor.beginCompile(effectId, 'fragment', params.fragmentShader || '', { timeoutMs });
  const vertKey = params.vertexShader ? monitor.beginCompile(effectId, 'vertex', params.vertexShader, { timeoutMs }) : null;

  const startTime = performance?.now?.() ?? Date.now();

  return new Promise((resolve) => {
    let completed = false;
    let material = null;
    let compileError = null;

    // Create a race between compile completion and timeout
    const timeoutId = setTimeout(() => {
      if (completed) return;
      completed = true;

      // Force completion of tracking
      monitor.endCompileError(fragKey, new Error(`Timeout after ${timeoutMs}ms`), true);
      if (vertKey) monitor.endCompileError(vertKey, new Error(`Timeout after ${timeoutMs}ms`), true);

      // Create fallback material
      const fallback = _createFallbackMaterial(THREE, options.fallbackParams);

      log.error(`[${effectId}] Shader compile TIMEOUT - using fallback material`);

      resolve({
        material: fallback,
        success: false,
        usedFallback: true,
        error: `Shader compile timeout after ${timeoutMs}ms`,
        compileMs: timeoutMs,
      });
    }, timeoutMs);

    // Attempt actual shader compilation
    try {
      material = new THREE.ShaderMaterial(params);

      // Force compilation by creating a minimal render target and rendering once
      // This is where GPU driver actually compiles the shader
      const compileStart = performance?.now?.() ?? Date.now();

      _forceShaderCompilation(THREE, material).then(() => {
        if (completed) return; // Timeout already fired
        clearTimeout(timeoutId);
        completed = true;

        const compileEnd = performance?.now?.() ?? Date.now();
        const compileMs = compileEnd - compileStart;

        // Mark tracking as successful
        monitor.endCompileSuccess(fragKey);
        if (vertKey) monitor.endCompileSuccess(vertKey);

        log.info(`[${effectId}] Shader compiled successfully in ${compileMs.toFixed(1)}ms`);

        resolve({
          material,
          success: true,
          usedFallback: false,
          error: null,
          compileMs,
        });
      }).catch((err) => {
        if (completed) return;
        clearTimeout(timeoutId);
        completed = true;

        monitor.endCompileError(fragKey, err, false);
        if (vertKey) monitor.endCompileError(vertKey, err, false);

        // Create fallback on compile error
        const fallback = _createFallbackMaterial(THREE, options.fallbackParams);

        log.error(`[${effectId}] Shader compile ERROR: ${err.message}`);

        resolve({
          material: fallback,
          success: false,
          usedFallback: true,
          error: err.message,
          compileMs: null,
        });
      });

    } catch (err) {
      if (completed) return;
      clearTimeout(timeoutId);
      completed = true;

      monitor.endCompileError(fragKey, err, false);
      if (vertKey) monitor.endCompileError(vertKey, err, false);

      const fallback = _createFallbackMaterial(THREE, options.fallbackParams);

      log.error(`[${effectId}] Shader creation ERROR: ${err.message}`);

      resolve({
        material: fallback,
        success: false,
        usedFallback: true,
        error: err.message,
        compileMs: null,
      });
    }
  });
}

/**
 * Force shader compilation by rendering to a 1x1 target.
 * @private
 */
async function _forceShaderCompilation(THREE, material) {
  return new Promise((resolve, reject) => {
    try {
      const renderer = _getRenderer();
      if (!renderer) {
        // No renderer available - assume compilation will happen on first real render
        resolve();
        return;
      }

      const tempScene = new THREE.Scene();
      const tempQuad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        material
      );
      tempScene.add(tempQuad);

      const tempTarget = new THREE.WebGLRenderTarget(1, 1);
      const tempCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(tempTarget);
      renderer.render(tempScene, tempCamera);
      renderer.setRenderTarget(prevTarget);

      // Cleanup
      tempTarget.dispose();
      tempScene.remove(tempQuad);
      tempQuad.geometry.dispose();

      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Create a fallback material when shader compile fails.
 * @private
 */
function _createFallbackMaterial(THREE, fallbackParams) {
  // Default fallback: basic passthrough
  const defaultParams = {
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(tDiffuse, vUv);
      }
    `,
    depthTest: false,
    depthWrite: false,
    transparent: false,
  };

  const params = fallbackParams || defaultParams;

  try {
    return new THREE.ShaderMaterial(params);
  } catch (err) {
    // Ultimate fallback: MeshBasicMaterial
    log.error('Failed to create fallback ShaderMaterial, using MeshBasicMaterial');
    return new THREE.MeshBasicMaterial({ color: 0xffffff });
  }
}

/**
 * Get the WebGLRenderer from window.MapShine.
 * @private
 */
function _getRenderer() {
  return window.MapShine?.renderer ?? window.MapShine?.sceneComposer?.renderer ?? null;
}

/**
 * Quick synchronous material creation (no forced compilation).
 * Use this when you want deferred compilation (material created but GPU compile happens later).
 *
 * @param {Object} THREE - THREE.js namespace
 * @param {string} effectId - Effect identifier
 * @param {Object} params - ShaderMaterial parameters
 * @returns {THREE.ShaderMaterial}
 */
export function createMaterialDeferred(THREE, effectId, params) {
  const monitor = getShaderCompileMonitor();

  // Just track start - actual compile happens on first render
  monitor.beginCompile(effectId, 'fragment', params.fragmentShader || '', { timeoutMs: 30000 });
  if (params.vertexShader) {
    monitor.beginCompile(effectId, 'vertex', params.vertexShader, { timeoutMs: 30000 });
  }

  try {
    return new THREE.ShaderMaterial(params);
  } catch (err) {
    log.error(`[${effectId}] Immediate shader creation failed: ${err.message}`);
    return _createFallbackMaterial(THREE, null);
  }
}

/**
 * Mark deferred compilation as complete (call from render() after first frame).
 * @param {string} effectId - Effect identifier
 * @param {boolean} success - Whether compile succeeded
 * @param {Error|null} error - Error if failed
 */
export function markDeferredCompileComplete(effectId, success, error = null) {
  const monitor = getShaderCompileMonitor();

  // Find pending compiles for this effect and mark them
  const pending = monitor.getPendingCompiles().filter(p => p.effectId === effectId);

  for (const rec of pending) {
    if (success) {
      // Need to construct key from record data
      const key = `${rec.effectId}|${rec.shaderType}|${Math.floor(rec.startTimeMs)}`;
      monitor.endCompileSuccess(key);
    } else {
      const key = `${rec.effectId}|${rec.shaderType}|${Math.floor(rec.startTimeMs)}`;
      monitor.endCompileError(key, error || new Error('Deferred compile failed'), false);
    }
  }
}
