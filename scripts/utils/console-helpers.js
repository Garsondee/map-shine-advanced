/**
 * @fileoverview Console debugging helpers
 * Diagnostic tools for troubleshooting effect issues
 * @module utils/console-helpers
 */

import { createLogger } from '../core/log.js';
import { globalProfiler } from '../core/profiler.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';

const log = createLogger('ConsoleHelpers');

/**
 * Console helpers for debugging Map Shine Advanced
 * Access via window.MapShine.debug
 */
export const consoleHelpers = {
  /**
   * Diagnose current specular effect state
   * Checks for common issues that break the effect
   */
  async diagnoseSpecular() {
    console.group('🔍 Map Shine Specular Diagnostics');
    
    const effect = window.MapShine?.specularEffect;
    if (!effect) {
      console.error('❌ Specular effect not found');
      console.groupEnd();
      return;
    }

    console.log('✅ Specular effect found');
    
    // Check enabled state
    console.log(`Enabled: ${effect.enabled}`);
    
    // Check effective state
    const { getSpecularEffectiveState } = await import('../ui/parameter-validator.js');
    const effectiveState = getSpecularEffectiveState(effect.params);
    if (!effectiveState.effective) {
      console.warn('⚠️ Effect is ineffective:', effectiveState.reasons);
    } else {
      console.log('✅ Effect is active and functional');
    }
    
    // Check material
    if (!effect.material) {
      console.error('❌ Material is null');
      console.groupEnd();
      return;
    }
    console.log('✅ Material exists');
    
    // Check validation status
    const validation = effect.getValidationStatus();
    if (!validation.valid) {
      console.error('❌ Validation failed:', validation.errors);
    } else {
      console.log('✅ Validation passed');
    }
    
    // Check parameters
    console.group('Parameters');
    for (const [key, value] of Object.entries(effect.params)) {
      const isValid = typeof value === 'number' ? Number.isFinite(value) : true;
      const icon = isValid ? '✅' : '❌';
      console.log(`${icon} ${key}: ${value}`);
    }
    console.groupEnd();
    
    // Check uniforms
    console.group('Shader Uniforms (critical)');
    const criticalUniforms = [
      'uSpecularIntensity',
      'uRoughness',
      'uMetallic',
      'uStripeEnabled',
      'uStripe1Frequency',
      'uStripe1Width',
      'uStripe1Intensity'
    ];
    
    for (const name of criticalUniforms) {
      const uniform = effect.material.uniforms[name];
      if (!uniform) {
        console.error(`❌ ${name}: MISSING`);
        continue;
      }
      
      const value = uniform.value;
      const isValid = typeof value === 'number' ? Number.isFinite(value) : value !== null;
      const icon = isValid ? '✅' : '❌';
      console.log(`${icon} ${name}: ${value}`);
    }
    console.groupEnd();
    
    // Check for common issues
    console.group('Common Issues');
    const issues = [];
    
    if (effect.params.stripeEnabled && effect.params.stripe1Frequency === 0) {
      issues.push('⚠️ Stripe 1 frequency is 0 (will cause NaN)');
    }
    
    if (effect.params.stripe1Width < 0.01) {
      issues.push('⚠️ Stripe 1 width very small (may cause aliasing)');
    }
    
    const totalIntensity = 
      (effect.params.stripe1Enabled ? effect.params.stripe1Intensity : 0) +
      (effect.params.stripe2Enabled ? effect.params.stripe2Intensity : 0) +
      (effect.params.stripe3Enabled ? effect.params.stripe3Intensity : 0);
    
    if (totalIntensity > 3.0) {
      issues.push(`⚠️ Total stripe intensity very high (${totalIntensity.toFixed(2)})`);
    }
    
    if (issues.length === 0) {
      console.log('✅ No obvious issues detected');
    } else {
      issues.forEach(issue => console.warn(issue));
    }
    console.groupEnd();
    
    // Suggestions
    console.group('💡 Suggestions');
    if (!validation.valid || issues.length > 0) {
      console.log('Try resetting to defaults:');
      console.log('  MapShine.debug.resetSpecular()');
      console.log('Or check specific parameters that look wrong above');
    } else {
      console.log('Effect looks healthy. If still not rendering:');
      console.log('1. Check if specular mask texture loaded');
      console.log('2. Verify WebGL context is active');
      console.log('3. Check browser console for GL errors');
    }
    console.groupEnd();
    
    console.groupEnd();
  },

  /**
   * Reset specular effect to defaults
   */
  resetSpecular() {
    const uiManager = window.MapShine?.uiManager;
    if (!uiManager) {
      console.error('UI Manager not found');
      return;
    }
    
    console.log('🔄 Resetting specular effect to defaults...');
    uiManager.resetEffectToDefaults('specular');
    console.log('✅ Reset complete');
  },

  /**
   * Export current parameters as JSON
   */
  exportParameters() {
    const effect = window.MapShine?.specularEffect;
    if (!effect) {
      console.error('Specular effect not found');
      return;
    }
    
    const json = JSON.stringify(effect.params, null, 2);
    console.log('Current parameters:');
    console.log(json);
    
    // Copy to clipboard if available
    if (navigator.clipboard) {
      navigator.clipboard.writeText(json);
      console.log('✅ Copied to clipboard');
    }
    
    return effect.params;
  },

  /**
   * Import parameters from object
   * @param {Object} params - Parameters to apply
   */
  importParameters(params) {
    const effect = window.MapShine?.specularEffect;
    const uiManager = window.MapShine?.uiManager;
    
    if (!effect || !uiManager) {
      console.error('Effect or UI Manager not found');
      return;
    }
    
    console.log('📥 Importing parameters...');
    
    for (const [key, value] of Object.entries(params)) {
      if (effect.params[key] !== undefined) {
        effect.params[key] = value;
        console.log(`Set ${key} = ${value}`);
      }
    }
    
    // Refresh UI
    const effectData = uiManager.effectFolders['specular'];
    if (effectData) {
      for (const [key, binding] of Object.entries(effectData.bindings)) {
        effectData.params[key] = effect.params[key];
        binding.refresh();
      }
    }
    
    console.log('✅ Import complete');
  },

  /**
   * Show validation report for all effects
   */
  async validateAll() {
    console.group('🔍 Validation Report');
    
    const uiManager = window.MapShine?.uiManager;
    if (!uiManager) {
      console.error('UI Manager not found');
      console.groupEnd();
      return;
    }
    
    const { globalValidator } = await import('./parameter-validator.js');
    
    for (const [effectId, effectData] of Object.entries(uiManager.effectFolders)) {
      const validation = globalValidator.validateAllParameters(
        effectId,
        effectData.params,
        effectData.schema
      );
      
      const icon = validation.valid ? '✅' : '❌';
      console.log(`${icon} ${effectId}`);
      
      if (!validation.valid) {
        console.group('Errors');
        validation.errors.forEach(e => console.error(e));
        console.groupEnd();
      }
      
      if (validation.warnings.length > 0) {
        console.group('Warnings');
        validation.warnings.forEach(w => console.warn(w));
        console.groupEnd();
      }
    }
    
    console.groupEnd();
  },

  /**
   * Monitor shader for errors
   * @param {number} duration - How long to monitor (ms)
   */
  async monitorShader(duration = 5000) {
    const effect = window.MapShine?.specularEffect;
    if (!effect || !effect.material) {
      console.error('Effect or material not found');
      return;
    }
    
    console.log(`🔍 Monitoring shader for ${duration}ms...`);
    
    const { ShaderValidator } = await import('../core/shader-validator.js');
    
    let errorCount = 0;
    let checkCount = 0;
    
    const interval = setInterval(() => {
      checkCount++;
      const result = ShaderValidator.validateMaterialUniforms(effect.material);
      
      if (!result.valid) {
        errorCount++;
        console.error(`Check ${checkCount}: FAILED`, result.errors);
      }
    }, 100);
    
    setTimeout(() => {
      clearInterval(interval);
      console.log(`✅ Monitoring complete: ${checkCount} checks, ${errorCount} errors`);
      
      if (errorCount > 0) {
        console.warn('Shader has validation errors - try resetting to defaults');
      }
    }, duration);
  },

  /**
   * Show help
   */
  help() {
    console.log(`
╔═══════════════════════════════════════════╗
║   Map Shine Advanced - Debug Helpers      ║
╚═══════════════════════════════════════════╝

Available commands (access via MapShine.debug):

  .diagnoseSpecular()     - Check specular effect health
  .resetSpecular()        - Reset to defaults
  .exportParameters()     - Export current params as JSON
  .importParameters(obj)  - Import params from object
  .validateAll()          - Validate all effects
  .monitorShader(ms)      - Monitor shader for errors
  .help()                 - Show this help

Examples:

  // Diagnose why effect is broken
  MapShine.debug.diagnoseSpecular()

  // Reset if broken
  MapShine.debug.resetSpecular()

  // Export current settings
  const params = MapShine.debug.exportParameters()

  // Import saved settings
  MapShine.debug.importParameters(params)
    `);
  }
};

/**
 * Install console helpers globally
 */
export function installConsoleHelpers() {
  if (typeof window !== 'undefined') {
    if (!window.MapShine) window.MapShine = {};
    window.MapShine.debug = consoleHelpers;

    window.MapShine.perf = {
      start: (options = {}) => {
        globalProfiler.start(options);
        return globalProfiler;
      },
      stop: () => {
        globalProfiler.stop();
        return true;
      },
      clear: () => {
        globalProfiler.clear();
        return true;
      },
      summary: () => {
        return globalProfiler.getSummary();
      },
      top: (kind = 'updatables', n = 10) => {
        return globalProfiler.getTopContributors(kind, n);
      },
      exportJson: () => {
        return globalProfiler.exportJson();
      },
      exportCsv: () => {
        return globalProfiler.exportCsv();
      },
      exportAllJson: () => {
        return {
          perf: globalProfiler.exportJson(),
          loading: globalLoadingProfiler.exportJson()
        };
      },
      loading: {
        start: () => {
          globalLoadingProfiler.start();
          return globalLoadingProfiler;
        },
        stop: () => {
          globalLoadingProfiler.stop();
          return true;
        },
        clear: () => {
          globalLoadingProfiler.clear();
          return true;
        },
        report: () => {
          return globalLoadingProfiler.getReport();
        },
        summary: () => {
          return globalLoadingProfiler.getSummary();
        },
        top: (n = 20, prefix = 'effect:') => {
          return globalLoadingProfiler.getTopSpans(n, prefix);
        },
        exportJson: () => {
          return globalLoadingProfiler.exportJson();
        },
        exportCsv: () => {
          return globalLoadingProfiler.exportCsv();
        }
      }
    };
    
    log.info('Console helpers installed: MapShine.debug');
    console.log('💡 Type MapShine.debug.help() for debugging commands');
  }
}
