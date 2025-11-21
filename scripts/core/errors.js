/**
 * @fileoverview User-facing error handling and messaging
 * @module core/errors
 */

import { createLogger } from './log.js';

const log = createLogger('Errors');

/**
 * Show compatibility error dialog with detailed information
 * @param {GPUCapabilities} capabilities - Detected GPU capabilities
 * @public
 */
export function showCompatibilityError(capabilities) {
  const errorMsg = `
    <h2>Map Shine Advanced - Compatibility Issue</h2>
    <p><strong>This module requires GPU acceleration to function.</strong></p>
    <hr>
    <h3>Your System Status:</h3>
    <ul>
      <li>WebGL 2.0: ${capabilities.webgl2 ? '✓ Available' : '✗ Not Available'}</li>
      <li>WebGL 1.0: ${capabilities.webgl ? '✓ Available' : '✗ Not Available'}</li>
    </ul>
    <hr>
    <h3>Possible Solutions:</h3>
    <ul>
      <li><strong>Update GPU drivers</strong> - Outdated drivers often lack WebGL support</li>
      <li><strong>Enable hardware acceleration</strong> in your browser settings</li>
      <li><strong>Update your browser</strong> to the latest version</li>
      <li><strong>Check GPU compatibility</strong> - Very old GPUs may not support WebGL</li>
    </ul>
    <p><em>If you're using Electron/Foundry VTT, try updating to the latest version.</em></p>
  `;

  ui.notifications.error('Map Shine Advanced cannot initialize - check console for details', { 
    permanent: true 
  });
  
  new Dialog({
    title: 'Map Shine Advanced - GPU Compatibility Error',
    content: errorMsg,
    buttons: {
      ok: {
        icon: '<i class="fas fa-check"></i>',
        label: 'Understood'
      }
    }
  }).render(true);

  log.error('Compatibility error shown to user');
}

/**
 * Show initialization error notification
 * @param {string} message - Error message
 * @param {Error} [error] - Optional error object
 * @public
 */
export function showInitializationError(message, error) {
  ui.notifications.error(`Map Shine Advanced: ${message}`, { permanent: true });
  
  if (error) {
    log.error(`Initialization failed: ${message}`, error);
  } else {
    log.error(`Initialization failed: ${message}`);
  }
}

/**
 * Show success notification with tier information
 * @param {'high'|'medium'|'low'} tier - Rendering tier
 * @public
 */
export function showSuccessNotification(tier) {
  const tierMessages = {
    high: 'Full effects enabled with WebGL 2.0',
    medium: 'Standard effects enabled with WebGL 2.0',
    low: 'Basic effects enabled with WebGL 1.0 (consider updating GPU drivers)'
  };
  
  ui.notifications.info(`Map Shine Advanced initialized - ${tierMessages[tier]}`);
  log.info('Initialization success notification shown');
}

/**
 * Show warning notification
 * @param {string} message - Warning message
 * @public
 */
export function showWarning(message) {
  ui.notifications.warn(`Map Shine Advanced: ${message}`);
  log.warn(message);
}

/**
 * Show info notification
 * @param {string} message - Info message
 * @public
 */
export function showInfo(message) {
  ui.notifications.info(`Map Shine Advanced: ${message}`);
  log.info(message);
}
