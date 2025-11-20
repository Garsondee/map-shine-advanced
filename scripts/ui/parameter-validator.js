/**
 * @fileoverview Parameter validation system with sanity checks
 * Prevents invalid parameter combinations that break effects silently
 * @module ui/parameter-validator
 */

import { createLogger } from '../core/log.js';

const log = createLogger('ParamValidator');

/**
 * Validation result
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether the value is valid
 * @property {*} value - Validated/clamped value
 * @property {string[]} warnings - Any warnings about the value
 * @property {string|null} error - Error message if invalid
 */

/**
 * Parameter validator - ensures safe parameter values
 */
export class ParameterValidator {
  constructor() {
    /** @type {Map<string, Function>} Custom validators per parameter */
    this.customValidators = new Map();
    
    /** @type {Map<string, Function>} Sanity checkers per effect */
    this.sanityCheckers = new Map();
  }

  /**
   * Register a custom validator for a specific parameter
   * @param {string} paramId - Parameter identifier (e.g., 'stripe1Intensity')
   * @param {Function} validator - Validator function (value) => ValidationResult
   */
  registerValidator(paramId, validator) {
    this.customValidators.set(paramId, validator);
  }

  /**
   * Register a sanity checker for an effect
   * Checks combinations of parameters for invalid states
   * @param {string} effectId - Effect identifier
   * @param {Function} checker - Checker function (params) => { valid, warnings, fixes }
   */
  registerSanityChecker(effectId, checker) {
    this.sanityCheckers.set(effectId, checker);
  }

  /**
   * Validate a single parameter value
   * @param {string} paramId - Parameter identifier
   * @param {*} value - Value to validate
   * @param {Object} paramDef - Parameter definition from schema
   * @returns {ValidationResult}
   */
  validateParameter(paramId, value, paramDef) {
    const warnings = [];
    let validValue = value;

    // Type checking
    const expectedType = this.inferType(paramDef);
    if (expectedType && typeof value !== expectedType) {
      return {
        valid: false,
        value: paramDef.default,
        warnings: [],
        error: `Type mismatch: expected ${expectedType}, got ${typeof value}`
      };
    }

    // Numeric validation
    if (typeof value === 'number') {
      // Check for NaN/Infinity
      if (!Number.isFinite(value)) {
        return {
          valid: false,
          value: paramDef.default,
          warnings: [],
          error: `Invalid number: ${value}`
        };
      }

      // Clamp to min/max
      if (paramDef.min !== undefined && value < paramDef.min) {
        validValue = paramDef.min;
        warnings.push(`Value ${value} clamped to min ${paramDef.min}`);
      }
      if (paramDef.max !== undefined && value > paramDef.max) {
        validValue = paramDef.max;
        warnings.push(`Value ${value} clamped to max ${paramDef.max}`);
      }

      // Warn on extreme values
      if (paramDef.min !== undefined && paramDef.max !== undefined) {
        const range = paramDef.max - paramDef.min;
        const normalized = (value - paramDef.min) / range;
        if (normalized > 0.95) {
          warnings.push(`Value near maximum (${(normalized * 100).toFixed(0)}%)`);
        }
      }
    }

    // Boolean validation
    if (paramDef.type === 'boolean' && typeof value !== 'boolean') {
      validValue = Boolean(value);
      warnings.push(`Coerced to boolean: ${value} -> ${validValue}`);
    }

    // Enum/options validation
    if (paramDef.options) {
      const validValues = Object.values(paramDef.options);
      if (!validValues.includes(value)) {
        return {
          valid: false,
          value: paramDef.default,
          warnings: [],
          error: `Invalid option: ${value} not in [${validValues.join(', ')}]`
        };
      }
    }

    // Custom validator
    if (this.customValidators.has(paramId)) {
      const customResult = this.customValidators.get(paramId)(validValue, paramDef);
      if (customResult.warnings) warnings.push(...customResult.warnings);
      if (!customResult.valid) {
        return customResult;
      }
      validValue = customResult.value;
    }

    return {
      valid: true,
      value: validValue,
      warnings,
      error: null
    };
  }

  /**
   * Validate all parameters for an effect
   * @param {string} effectId - Effect identifier
   * @param {Object} params - Parameter object
   * @param {Object} schema - Effect schema
   * @returns {Object} { valid, params, warnings, errors }
   */
  validateAllParameters(effectId, params, schema) {
    const validatedParams = {};
    const allWarnings = [];
    const allErrors = [];

    // Validate each parameter
    for (const [paramId, value] of Object.entries(params)) {
      const paramDef = schema.parameters?.[paramId];
      if (!paramDef) {
        allWarnings.push(`Unknown parameter: ${paramId}`);
        continue;
      }

      const result = this.validateParameter(paramId, value, paramDef);
      
      if (result.error) {
        allErrors.push(`${paramId}: ${result.error}`);
        validatedParams[paramId] = paramDef.default;
      } else {
        validatedParams[paramId] = result.value;
      }

      if (result.warnings.length > 0) {
        result.warnings.forEach(w => allWarnings.push(`${paramId}: ${w}`));
      }
    }

    // Run sanity checker if registered
    if (this.sanityCheckers.has(effectId)) {
      const sanityResult = this.sanityCheckers.get(effectId)(validatedParams, schema);
      
      if (!sanityResult.valid) {
        allErrors.push(...(sanityResult.errors || []));
        
        // Apply auto-fixes if provided
        if (sanityResult.fixes) {
          Object.assign(validatedParams, sanityResult.fixes);
          allWarnings.push('Auto-fixes applied for invalid parameter combination');
        }
      }

      if (sanityResult.warnings) {
        allWarnings.push(...sanityResult.warnings);
      }
    }

    return {
      valid: allErrors.length === 0,
      params: validatedParams,
      warnings: allWarnings,
      errors: allErrors
    };
  }

  /**
   * Infer expected type from parameter definition
   * @param {Object} paramDef - Parameter definition
   * @returns {string|null} Type name or null
   * @private
   */
  inferType(paramDef) {
    if (paramDef.type === 'slider') return 'number';
    if (paramDef.type === 'boolean') return 'boolean';
    if (paramDef.type === 'list') return typeof Object.values(paramDef.options || {})[0];
    if (paramDef.min !== undefined || paramDef.max !== undefined) return 'number';
    return null;
  }
}

/**
 * Calculate effective state of specular effect
 * Determines if effect is enabled but ineffective (no visual output)
 * @param {Object} params - Effect parameters
 * @returns {Object} { effective, reasons }
 */
export function getSpecularEffectiveState(params) {
  const reasons = [];
  
  // Main effect disabled
  if (!params.enabled) {
    return { effective: false, reasons: ['Effect is disabled'] };
  }
  
  // Missing required texture
  if (params.hasSpecularMask === false) {
    reasons.push('Missing specular mask (_Specular suffix)');
  }

  // Zero intensity = no visible effect
  if (params.intensity === 0) {
    reasons.push('Shine intensity is 0 (no visual effect)');
  }
  
  // Check stripes if enabled
  if (params.stripeEnabled) {
    const hasActiveStripe = 
      (params.stripe1Enabled && params.stripe1Intensity > 0 && params.stripe1Width > 0) ||
      (params.stripe2Enabled && params.stripe2Intensity > 0 && params.stripe2Width > 0) ||
      (params.stripe3Enabled && params.stripe3Intensity > 0 && params.stripe3Width > 0);
    
    if (!hasActiveStripe) {
      reasons.push('Stripes enabled but all layers ineffective (zero intensity or width)');
    }
  }
  
  return {
    effective: reasons.length === 0,
    reasons
  };
}

/**
 * Get dependency state for stripe layers
 * Determines which controls should be enabled based on parent settings
 * Also identifies problematic parameters (causing auto-disable)
 * @param {Object} params - Effect parameters
 * @returns {Object} Dependency state with problem tracking
 */
export function getStripeDependencyState(params) {
  const stripeControlsActive = params.stripeEnabled === true;
  
  // Check each layer for problems (intensity or width = 0)
  const layer1Problems = [];
  const layer2Problems = [];
  const layer3Problems = [];
  
  if (params.stripe1Intensity === 0) layer1Problems.push('stripe1Intensity');
  if (params.stripe1Width === 0) layer1Problems.push('stripe1Width');
  
  if (params.stripe2Intensity === 0) layer2Problems.push('stripe2Intensity');
  if (params.stripe2Width === 0) layer2Problems.push('stripe2Width');
  
  if (params.stripe3Intensity === 0) layer3Problems.push('stripe3Intensity');
  if (params.stripe3Width === 0) layer3Problems.push('stripe3Width');
  
  return {
    stripeControlsActive, // Blend mode, parallax strength
    // A layer is considered "active" if stripes are enabled globally and the
    // layer's own enabled flag is true. This drives which controls the UI
    // disables in tweakpane-manager.js.
    stripe1Active: stripeControlsActive && params.stripe1Enabled === true,
    stripe2Active: stripeControlsActive && params.stripe2Enabled === true,
    stripe3Active: stripeControlsActive && params.stripe3Enabled === true,
    stripe1Problems: layer1Problems,
    stripe2Problems: layer2Problems,
    stripe3Problems: layer3Problems
  };
}

/**
 * Create sanity checker for iridescence effect
 * Keeps key parameters within visually sane ranges
 * @param {Object} params - Effect parameters
 * @returns {Object} Sanity check result
 */
export function createIridescenceSanityChecker(params, schema) {
  const warnings = [];
  const errors = [];
  const fixes = {};
  
  if (params.intensity < 0.0) {
    errors.push(`Iridescence intensity below 0 (${params.intensity}) is invalid`);
    fixes.intensity = 0.0;
  } else if (params.intensity > 2.0) {
    warnings.push(`Iridescence intensity very high (${params.intensity}), may wash out details`);
  }
  
  if (params.noiseScale < 0.01) {
    errors.push(`Noise scale too small (${params.noiseScale}), islands may collapse to flat color`);
    fixes.noiseScale = 0.01;
  } else if (params.noiseScale > 10.0) {
    warnings.push(`Noise scale very large (${params.noiseScale}), glitter may alias or look noisy`);
  }
  
  if (params.phaseMult <= 0.0) {
    errors.push(`Phase multiplier must be > 0 (got ${params.phaseMult})`);
    fixes.phaseMult = 1.0;
  } else if (params.phaseMult > 12.0) {
    warnings.push(`Phase multiplier very high (${params.phaseMult}), may cause dense banding`);
  }
  
  if (params.ignoreDarkness < 0.0) {
    fixes.ignoreDarkness = 0.0;
    warnings.push('Clamping Magic Glow below 0 to 0.0');
  } else if (params.ignoreDarkness > 1.0) {
    fixes.ignoreDarkness = 1.0;
    warnings.push('Clamping Magic Glow above 1 to 1.0');
  }
  
  return {
    valid: errors.length === 0,
    warnings,
    errors,
    fixes: Object.keys(fixes).length > 0 ? fixes : null
  };
}

/**
 * Global validator instance
 */
export const globalValidator = new ParameterValidator();

// Register sanity checkers
globalValidator.registerSanityChecker('specular', (params, schema) => {
  // If effect is disabled, it's a valid state - no sanity check errors needed
  if (!params.enabled) {
    return {
      valid: true,
      warnings: [],
      errors: [],
      fixes: null
    };
  }

  // Delegate to existing logic by reusing getSpecularEffectiveState where appropriate
  const state = getSpecularEffectiveState(params);
  return {
    valid: state.effective,
    warnings: state.effective ? [] : state.reasons,
    errors: state.effective ? [] : state.reasons,
    fixes: null
  };
});
globalValidator.registerSanityChecker('iridescence', createIridescenceSanityChecker);

// Register existing stripe width custom validators (if needed elsewhere)
globalValidator.registerValidator('stripe1Width', (value, paramDef) => {
  const warnings = [];
  if (value <= 0) {
    warnings.push('Stripe width is 0 (layer will be auto-disabled)');
  }
  return {
    valid: true,
    value,
    warnings,
    error: null
  };
});
globalValidator.registerValidator('stripe2Width', globalValidator.customValidators.get('stripe1Width'));
globalValidator.registerValidator('stripe3Width', globalValidator.customValidators.get('stripe1Width'));

log.info('Parameter validator initialized');
