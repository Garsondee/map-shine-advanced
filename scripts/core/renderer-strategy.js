/**
 * @fileoverview Renderer selection and initialization strategy
 * @module core/renderer-strategy
 */

import { createLogger } from './log.js';

const log = createLogger('Renderer');

/**
 * Create and initialize renderer based on detected capabilities
 * Uses tiered fallback: WebGL2 → WebGL1
 * @param {*} THREE - three.js module
 * @param {GPUCapabilities} capabilities - Detected GPU capabilities
 * @param {{sharedContext?: WebGLRenderingContext|null}} [options]
 * @returns {Promise<RendererResult>} Initialized renderer and type
 * @public
 */
export async function create(THREE, capabilities, options = {}) {
  let renderer = null;
  let rendererType = null;
  const sharedContext = options?.sharedContext ?? null;
  const tryWithFallback = (factory) => {
    const primary = factory(sharedContext);
    if (primary.success) return primary;
    if (!sharedContext) return primary;
    const fallback = factory(null);
    if (fallback.success) {
      log.warn('Shared-context renderer init failed; falling back to dedicated context.');
      return fallback;
    }
    return primary;
  };

  // Tier 1: WebGL2 for full feature set
  if (capabilities.webgl2) {
    const result = tryWithFallback((ctx) => tryWebGL2(THREE, { sharedContext: ctx }));
    if (result.success) {
      renderer = result.renderer;
      rendererType = result.usedSharedContext ? 'WebGL2(shared-context)' : 'WebGL2';
      log.info('WebGL2 renderer initialized (Medium-tier effects)');
    } else {
      log.warn('WebGL2 initialization failed:', result.error);
    }
  }

  // Tier 2: Fallback to WebGL 1 (limited features)
  if (!renderer && capabilities.webgl) {
    const result = tryWithFallback((ctx) => tryWebGL1(THREE, { sharedContext: ctx }));
    if (result.success) {
      renderer = result.renderer;
      rendererType = result.usedSharedContext ? 'WebGL1(shared-context)' : 'WebGL1';
      log.warn('WebGL 1.0 renderer initialized (Limited features, upgrade GPU drivers recommended)');
    } else {
      log.error('WebGL initialization failed:', result.error);
    }
  }

  return { renderer, rendererType };
}

/**
 * Attempt to create WebGL2 renderer
 * @param {*} THREE - three.js module
 * @param {{sharedContext?: WebGLRenderingContext|null}} [options]
 * @returns {{success: boolean, renderer?: THREE.WebGLRenderer, error?: Error, usedSharedContext?: boolean}}
 * @private
 */
function tryWebGL2(THREE, options = {}) {
  try {
    const sharedContext = options?.sharedContext ?? null;
    const rendererOptions = {
      antialias: true,
      alpha: false, // Opaque background
      powerPreference: 'high-performance'
    };
    if (sharedContext) {
      rendererOptions.context = sharedContext;
      rendererOptions.canvas = sharedContext.canvas;
    }
    const renderer = new THREE.WebGLRenderer(rendererOptions);

    return { success: true, renderer, usedSharedContext: !!sharedContext };
  } catch (e) {
    return { success: false, error: e };
  }
}

/**
 * Attempt to create WebGL1 renderer
 * @param {*} THREE - three.js module
 * @param {{sharedContext?: WebGLRenderingContext|null}} [options]
 * @returns {{success: boolean, renderer?: THREE.WebGLRenderer, error?: Error, usedSharedContext?: boolean}}
 * @private
 */
function tryWebGL1(THREE, options = {}) {
  try {
    const sharedContext = options?.sharedContext ?? null;
    let gl = sharedContext;
    if (!gl) {
      const canvas = document.createElement('canvas');
      gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    }
    
    if (!gl) {
      throw new Error('Failed to acquire WebGL 1.0 context');
    }
    
    const renderer = new THREE.WebGLRenderer({
      canvas: gl.canvas,
      context: gl,
      antialias: false,
      alpha: false // Opaque background
    });
    
    return { success: true, renderer, usedSharedContext: !!sharedContext };
  } catch (e) {
    return { success: false, error: e };
  }
}

/**
 * Configure common renderer settings
 * @param {THREE.WebGLRenderer} renderer - Renderer instance
 * @param {Object} [options] - Configuration options
 * @param {number} [options.width] - Canvas width
 * @param {number} [options.height] - Canvas height
 * @param {number} [options.pixelRatio] - Device pixel ratio
 * @public
 */
export function configure(renderer, options = {}) {
  const {
    width = window.innerWidth,
    height = window.innerHeight,
    pixelRatio = window.devicePixelRatio || 1
  } = options;

  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(pixelRatio, 2)); // Cap at 2 for performance
  
  // CRITICAL: Set clear color to OPAQUE black (alpha = 1)
  // Without this, canvas is transparent and nothing is visible!
  if (renderer.setClearColor) {
    renderer.setClearColor(0x000000, 1); // Black, fully opaque
  }

  // Defense-in-depth: some renderer paths can still retain a non-opaque clearAlpha.
  // Ensure the default clear alpha is fully opaque so nothing behind the Three
  // canvas can bleed through.
  if (typeof renderer.setClearAlpha === 'function') {
    renderer.setClearAlpha(1);
  }

  // Configure color space and tone mapping for correct brightness matching with Foundry PIXI
  // See docs/CONTRAST-DARKNESS-ANALYSIS.md for rationale
  const THREE = window.THREE;
  if (THREE && THREE.SRGBColorSpace) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  // Disable built-in tone mapping - we handle it in LightingEffect composite shader
  // This prevents double tone mapping which would darken the image
  if (THREE && THREE.NoToneMapping !== undefined) {
    renderer.toneMapping = THREE.NoToneMapping;
  }

  log.debug(`Renderer configured: ${width}x${height}, pixelRatio: ${pixelRatio}, outputColorSpace: sRGB`);
}
