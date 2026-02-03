/**
 * @fileoverview Diagnostic Center Manager
 *
 * Owns the Diagnostic Center dialog lifecycle and provides a small stable API.
 *
 * @module ui/diagnostic-center
 */

import { createLogger } from '../core/log.js';
import { DiagnosticCenterDialog } from './diagnostic-center-dialog.js';

const log = createLogger('DiagnosticCenter');

export class DiagnosticCenterManager {
  /**
   * @param {any} [options]
   */
  constructor(options = null) {
    this.options = options || {};

    /** @type {DiagnosticCenterDialog} */
    this.dialog = new DiagnosticCenterDialog(this);

    /** @type {boolean} */
    this._initialized = false;
  }

  async initialize() {
    if (this._initialized) return;
    await this.dialog.initialize();
    this._initialized = true;
    log.info('Diagnostic Center initialized');
  }

  toggle() {
    this.dialog.toggle();
  }

  show() {
    this.dialog.show();
  }

  hide() {
    this.dialog.hide();
  }
}
