/**
 * @fileoverview Shader validation and error detection
 * Catches silent shader failures that produce invalid renders
 * @module core/shader-validator
 */

import { createLogger } from './log.js';

const log = createLogger('ShaderValidator');

/**
 * Shader validator - detects common shader errors and invalid states
 */
export class ShaderValidator {
  /**
   * Check if a material's uniforms contain invalid values
   * @param {THREE.ShaderMaterial} material - Material to check
   * @returns {Object} { valid, errors, warnings }
   */
  static validateMaterialUniforms(material) {
    if (!material || !material.uniforms) {
      return { valid: false, errors: ['Material or uniforms missing'], warnings: [] };
    }

    const errors = [];
    const warnings = [];

    for (const [name, uniform] of Object.entries(material.uniforms)) {
      const value = uniform.value;

      // Check for NaN/Infinity in numbers
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          errors.push(`Uniform ${name} is ${value} (not finite)`);
        }
      }

      // Check for NaN/Infinity in vectors
      if (value && typeof value === 'object') {
        if (value.isVector2 || value.isVector3 || value.isVector4) {
          const components = value.isVector2 ? ['x', 'y'] :
                           value.isVector3 ? ['x', 'y', 'z'] :
                           ['x', 'y', 'z', 'w'];
          
          for (const comp of components) {
            if (!Number.isFinite(value[comp])) {
              errors.push(`Uniform ${name}.${comp} is ${value[comp]} (not finite)`);
            }
          }
        }
      }

      // Check for null/undefined textures when expected
      if (name.toLowerCase().includes('map') || name.toLowerCase().includes('texture')) {
        if (value === null || value === undefined) {
          warnings.push(`Texture uniform ${name} is ${value}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Check if shader compilation succeeded
   * @param {THREE.WebGLRenderer} renderer - Three.js renderer
   * @param {THREE.ShaderMaterial} material - Material to check
   * @returns {Object} { valid, error }
   */
  static checkShaderCompilation(renderer, material) {
    if (!renderer || !material) {
      return { valid: false, error: 'Renderer or material missing' };
    }

    try {
      // Force compilation
      const gl = renderer.getContext();
      const program = renderer.properties.get(material).programs?.values().next().value;
      
      if (!program) {
        return { valid: false, error: 'Shader program not found' };
      }

      const glProgram = program.program;
      if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
        const error = gl.getProgramInfoLog(glProgram);
        return { valid: false, error: `Shader link error: ${error}` };
      }

      return { valid: true, error: null };
    } catch (e) {
      return { valid: false, error: `Shader validation error: ${e.message}` };
    }
  }

  /**
   * Suggest fixes for common shader errors
   * @param {Array<string>} errors - Error messages
   * @returns {Array<Object>} Fix suggestions
   */
  static suggestFixes(errors) {
    const fixes = [];

    for (const error of errors) {
      if (error.includes('not finite')) {
        fixes.push({
          error,
          fix: 'Reset to defaults',
          reason: 'NaN or Infinity values break shader math'
        });
      }

      if (error.includes('division by zero')) {
        fixes.push({
          error,
          fix: 'Ensure frequency/width values are not zero',
          reason: 'Division by zero creates NaN'
        });
      }

      if (error.includes('normalize')) {
        fixes.push({
          error,
          fix: 'Check light direction vector is not zero',
          reason: 'Cannot normalize zero-length vector'
        });
      }
    }

    return fixes;
  }
}

/**
 * Monitor for shader errors in an effect
 * @param {THREE.ShaderMaterial} material - Material to monitor
 * @param {Function} onError - Called when error detected
 * @param {number} interval - Check interval in milliseconds
 * @returns {Function} Stop monitoring function
 */
export function monitorShaderErrors(material, onError, interval = 1000) {
  let lastCheck = 0;
  let errorCount = 0;

  const check = () => {
    const now = performance.now();
    if (now - lastCheck < interval) return;

    lastCheck = now;

    const result = ShaderValidator.validateMaterialUniforms(material);
    
    if (!result.valid) {
      errorCount++;
      
      if (errorCount >= 3) {
        // 3 consecutive errors = critical issue
        onError({
          critical: true,
          errors: result.errors,
          warnings: result.warnings,
          fixes: ShaderValidator.suggestFixes(result.errors)
        });
      } else {
        // Single error = log warning
        log.warn('Shader validation warning:', result.errors);
      }
    } else {
      // Reset error count on success
      errorCount = 0;
    }
  };

  // Use RAF for checking (tied to render loop)
  let rafHandle = null;
  const loop = () => {
    check();
    rafHandle = requestAnimationFrame(loop);
  };
  
  rafHandle = requestAnimationFrame(loop);

  // Return stop function
  return () => {
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  };
}

log.info('Shader validator initialized');
