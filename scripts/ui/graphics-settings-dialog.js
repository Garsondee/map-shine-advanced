/**
 * @fileoverview Graphics Settings Dialog (Tweakpane)
 *
 * ESSENTIAL FEATURE:
 * This dialog is the player/GM-facing entry point for per-client graphics overrides.
 * It must remain lightweight, stable, and safe to open during live play.
 *
 * @module ui/graphics-settings-dialog
 */

import { createLogger } from '../core/log.js';

const log = createLogger('GraphicsSettingsDialog');

export class GraphicsSettingsDialog {
  /**
   * @param {import('./graphics-settings-manager.js').GraphicsSettingsManager} manager
   */
  constructor(manager) {
    this.manager = manager;

    /** @type {Tweakpane.Pane|null} */
    this.pane = null;

    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {boolean} */
    this.visible = false;

    /** @type {Map<string, {folder:any, state:{enabled:boolean}, statusDot:HTMLElement|null}>} */
    this._effectUI = new Map();

    this._boundStopHandlers = null;
  }

  async initialize(parentElement = document.body) {
    if (this.pane) return;

    // Wait for Tweakpane to be available.
    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (typeof Tweakpane === 'undefined') {
      throw new Error('Tweakpane library not available');
    }

    this.container = document.createElement('div');
    this.container.id = 'map-shine-graphics-settings';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10000';
    this.container.style.left = '50%';
    this.container.style.top = '50%';
    this.container.style.transform = 'translate(-50%, -50%)';
    this.container.style.display = 'none';
    parentElement.appendChild(this.container);

    // Prevent pointer interaction with the scene behind the panel.
    {
      const stop = (e) => {
        try {
          e.stopPropagation();
        } catch (_) {
        }
      };

      const stopAndPrevent = (e) => {
        try {
          e.preventDefault();
        } catch (_) {
        }
        stop(e);
      };

      const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
      for (const type of events) {
        if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
        else this.container.addEventListener(type, stop);
      }
      this.container.addEventListener('contextmenu', stopAndPrevent);

      this._boundStopHandlers = { stop, stopAndPrevent };
    }

    this.pane = new Tweakpane.Pane({
      title: 'Map Shine Graphics Settings',
      container: this.container,
      expanded: true
    });

    // Global section.
    const globalFolder = this.pane.addFolder({
      title: 'Global',
      expanded: true
    });

    globalFolder.addBinding(this.manager.state, 'globalDisableAll', {
      label: 'Disable All'
    }).on('change', (ev) => {
      this.manager.state.globalDisableAll = ev.value === true;
      this.manager.applyOverrides();
      this.manager.saveState();
      this.refreshStatus();
    });

    globalFolder.addButton({
      title: 'Enable All'
    }).on('click', () => {
      this.manager.setDisableAll(false);
      this.manager.enableAllEffects();
      this.refresh();
    });

    globalFolder.addButton({
      title: 'Disable All Effects'
    }).on('click', () => {
      this.manager.setDisableAll(true);
      this.manager.disableAllEffects();
      this.refresh();
    });

    globalFolder.addButton({
      title: 'Reset Overrides'
    }).on('click', () => {
      this.manager.resetAllOverrides();
      this.refresh();
    });

    // Effects section.
    const effectsFolder = this.pane.addFolder({
      title: 'Effects',
      expanded: true
    });

    this._buildEffectsUI(effectsFolder);

    // Start hidden.
    this.hide();

    log.info('Graphics Settings dialog initialized');
  }

  /**
   * @private
   * @param {any} parentFolder
   */
  _buildEffectsUI(parentFolder) {
    // Clear any existing UI entries.
    this._effectUI.clear();

    const effects = this.manager.listEffectsForUI();

    // Sort for readability.
    effects.sort((a, b) => {
      const an = String(a.displayName || a.effectId);
      const bn = String(b.displayName || b.effectId);
      return an.localeCompare(bn);
    });

    for (const entry of effects) {
      const { effectId, displayName } = entry;
      const initialEnabled = this.manager.getEffectiveEnabled(effectId);

      const folder = parentFolder.addFolder({
        title: displayName || effectId,
        expanded: false
      });

      const state = { enabled: initialEnabled };

      folder.addBinding(state, 'enabled', {
        label: 'Enabled'
      }).on('change', (ev) => {
        this.manager.setEffectEnabled(effectId, ev.value === true);
        this.manager.saveState();
        this.refreshStatus();
      });

      folder.addButton({
        title: 'Reset Override'
      }).on('click', () => {
        this.manager.clearEffectOverride(effectId);
        this.manager.saveState();
        this.refresh();
      });

      // Visual status dot in folder title.
      const statusDot = this._ensureStatusDot(folder);

      this._effectUI.set(effectId, { folder, state, statusDot });
    }

    this.refreshStatus();
  }

  /**
   * Add a small dot indicator to a Tweakpane folder title.
   * @private
   * @param {any} folder
   * @returns {HTMLElement|null}
   */
  _ensureStatusDot(folder) {
    try {
      const titleElement = folder?.element?.querySelector?.('.tp-fldv_t');
      if (!titleElement) return null;

      let dot = titleElement.querySelector('.map-shine-status-dot');
      if (dot) return dot;

      dot = document.createElement('span');
      dot.className = 'map-shine-status-dot';
      dot.style.display = 'inline-block';
      dot.style.width = '8px';
      dot.style.height = '8px';
      dot.style.borderRadius = '50%';
      dot.style.marginRight = '8px';
      dot.style.verticalAlign = 'middle';
      dot.style.background = '#666';

      titleElement.prepend(dot);
      return dot;
    } catch (_) {
      return null;
    }
  }

  refresh() {
    // Sync UI state from manager.
    for (const [effectId, ui] of this._effectUI.entries()) {
      ui.state.enabled = this.manager.getEffectiveEnabled(effectId);
      try {
        ui.folder.refresh?.();
      } catch (_) {
      }
    }

    try {
      this.pane?.refresh?.();
    } catch (_) {
    }

    this.refreshStatus();
  }

  refreshStatus() {
    for (const [effectId, ui] of this._effectUI.entries()) {
      const dot = ui.statusDot;
      if (!dot) continue;

      const avail = this.manager.getAvailability(effectId);
      const enabled = this.manager.getEffectiveEnabled(effectId);

      if (!avail.available) {
        dot.style.backgroundColor = '#666666';
        dot.style.boxShadow = 'none';
        dot.title = `Unavailable: ${avail.reason || 'Unavailable'}`;
      } else if (!enabled) {
        dot.style.backgroundColor = '#ff4444';
        dot.style.boxShadow = '0 0 4px #ff4444';
        dot.title = 'Disabled';
      } else {
        dot.style.backgroundColor = '#44ff44';
        dot.style.boxShadow = '0 0 4px #44ff44';
        dot.title = 'Active';
      }
    }
  }

  show() {
    if (!this.container) return;
    this.container.style.display = 'block';
    this.visible = true;
    this.refresh();
  }

  hide() {
    if (!this.container) return;
    this.container.style.display = 'none';
    this.visible = false;
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  dispose() {
    try {
      this.pane?.dispose?.();
    } catch (_) {
    }

    if (this.container && this._boundStopHandlers) {
      try {
        const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
        for (const type of events) {
          this.container.removeEventListener(type, this._boundStopHandlers.stop);
        }
        this.container.removeEventListener('contextmenu', this._boundStopHandlers.stopAndPrevent);
      } catch (_) {
      }
    }

    try {
      this.container?.parentNode?.removeChild?.(this.container);
    } catch (_) {
    }

    this._effectUI.clear();
    this.pane = null;
    this.container = null;
    this.visible = false;
  }
}
