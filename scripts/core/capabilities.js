/**
 * @fileoverview GPU capability detection for Map Shine Advanced
 * @module core/capabilities
 */

import { createLogger } from './log.js';

const log = createLogger('Capabilities');

/**
 * Detect GPU capabilities and determine rendering tier
 * @returns {Promise<GPUCapabilities>} Detected capabilities and computed tier
 * @public
 */
export async function detect() {
  /** @type {GPUCapabilities} */
  const capabilities = {
    webgpu: false,
    webgl2: false,
    webgl: false,
    tier: 'none'
  };

  // Check WebGPU availability
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      capabilities.webgpu = !!adapter;
      if (adapter) {
        log.debug('WebGPU adapter acquired:', adapter);
      }
    } catch (e) {
      log.warn('WebGPU adapter request failed:', e);
    }
  } else {
    log.debug('navigator.gpu not available');
  }

  // Check WebGL2 availability
  const canvas = document.createElement('canvas');
  const gl2 = canvas.getContext('webgl2');
  capabilities.webgl2 = !!gl2;
  
  if (gl2) {
    log.debug('WebGL2 context created successfully');
  }

  // Check WebGL 1.0 availability (only if WebGL2 failed)
  if (!capabilities.webgl2) {
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    capabilities.webgl = !!gl;
    
    if (gl) {
      log.debug('WebGL 1.0 context created successfully');
    }
  }

  // Determine rendering tier based on capabilities
  if (capabilities.webgpu) {
    capabilities.tier = 'high';
  } else if (capabilities.webgl2) {
    capabilities.tier = 'medium';
  } else if (capabilities.webgl) {
    capabilities.tier = 'low';
  }

  log.info('GPU Capabilities:', capabilities);

  return capabilities;
}

/**
 * Get human-readable tier description
 * @param {'high'|'medium'|'low'|'none'} tier - Rendering tier
 * @returns {string} Description of what this tier supports
 * @public
 */
export function getTierDescription(tier) {
  const descriptions = {
    high: 'Full effects enabled with WebGPU (compute shaders, advanced pipelines)',
    medium: 'Standard effects enabled with WebGL 2.0 (PBR, post-processing)',
    low: 'Basic effects enabled with WebGL 1.0 (limited features, upgrade recommended)',
    none: 'No GPU acceleration available'
  };
  
  return descriptions[tier] || 'Unknown tier';
}

/**
 * Check if a specific feature tier is supported
 * @param {GPUCapabilities} capabilities - Detected capabilities
 * @param {'high'|'medium'|'low'} minimumTier - Minimum required tier
 * @returns {boolean} Whether the minimum tier is met
 * @public
 */
export function supportsMinimumTier(capabilities, minimumTier) {
  const tierRanking = { high: 3, medium: 2, low: 1, none: 0 };
  return tierRanking[capabilities.tier] >= tierRanking[minimumTier];
}
