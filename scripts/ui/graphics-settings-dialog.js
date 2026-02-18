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

    /** @type {HTMLElement|null} Active-count tag on the Effects folder title. */
    this._effectsCountTag = null;
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

    globalFolder.addBinding(this.manager.state, 'renderResolutionPreset', {
      label: 'Render Resolution',
      options: {
        'Native': 'native',
        '3840x2160 (4K)': '3840x2160',
        '2560x1440 (1440p)': '2560x1440',
        '1920x1080 (1080p)': '1920x1080',
        '1600x900 (900p)': '1600x900',
        '1280x720 (720p)': '1280x720',
        '1024x576': '1024x576',
        '800x450': '800x450'
      }
    }).on('change', (ev) => {
      this.manager.setRenderResolutionPreset(ev.value);
      this.manager.saveState();
    });

    // Frame pacing controls (client-local).
    globalFolder.addBinding(this.manager.state, 'renderAdaptiveFpsEnabled', {
      label: 'Adaptive Frame Cap'
    }).on('change', (ev) => {
      this.manager.setRenderAdaptiveFpsEnabled(ev.value === true);
      this.manager.saveState();
    });

    globalFolder.addBinding(this.manager.state, 'renderIdleFps', {
      label: 'Idle FPS',
      min: 5,
      max: 60,
      step: 1
    }).on('change', (ev) => {
      this.manager.setRenderIdleFps(ev.value);
      this.manager.saveState();
    });

    globalFolder.addBinding(this.manager.state, 'renderActiveFps', {
      label: 'Active FPS',
      min: 5,
      max: 120,
      step: 1
    }).on('change', (ev) => {
      this.manager.setRenderActiveFps(ev.value);
      this.manager.saveState();
    });

    globalFolder.addBinding(this.manager.state, 'renderContinuousFps', {
      label: 'Continuous FX FPS',
      min: 5,
      max: 120,
      step: 1
    }).on('change', (ev) => {
      this.manager.setRenderContinuousFps(ev.value);
      this.manager.saveState();
    });

    // Compact 2-column button grid (matches Main Config / Control Panel pattern).
    {
      const contentElement = globalFolder?.element?.querySelector?.('.tp-fldv_c') || globalFolder?.element;
      if (contentElement) {
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = '1fr 1fr';
        grid.style.gap = '4px';
        grid.style.padding = '4px 6px 6px 6px';

        const addGridButton = (label, onClick, danger = false) => {
          const btn = document.createElement('button');
          btn.textContent = label;
          btn.style.padding = '4px 8px';
          btn.style.borderRadius = '6px';
          btn.style.border = danger ? '1px solid rgba(255,80,80,0.35)' : '1px solid rgba(255,255,255,0.14)';
          btn.style.background = danger ? 'rgba(255,60,60,0.12)' : 'rgba(255,255,255,0.08)';
          btn.style.color = danger ? '#ff9090' : 'inherit';
          btn.style.cursor = 'pointer';
          btn.style.fontSize = '11px';
          btn.style.fontWeight = '500';
          btn.addEventListener('click', onClick);
          grid.appendChild(btn);
        };

        addGridButton('Enable All', () => {
          this.manager.setDisableAll(false);
          this.manager.enableAllEffects();
          this.refresh();
        });

        addGridButton('Disable All', () => {
          this.manager.setDisableAll(true);
          this.manager.disableAllEffects();
          this.refresh();
        });

        addGridButton('Reset Overrides', () => {
          this.manager.resetAllOverrides();
          this.refresh();
        }, true);

        contentElement.appendChild(grid);

        // Persistence scope note (client-local settings).
        const scopeNote = document.createElement('div');
        scopeNote.textContent = 'These settings are saved per-client (browser-local).';
        scopeNote.style.fontSize = '10px';
        scopeNote.style.opacity = '0.55';
        scopeNote.style.padding = '4px 6px 2px 6px';
        scopeNote.style.fontStyle = 'italic';
        contentElement.appendChild(scopeNote);

        const framePacingNote = document.createElement('div');
        framePacingNote.textContent = 'Adaptive Frame Cap: Active = interactions, Continuous = animated effects, Idle = static scene refresh.';
        framePacingNote.style.fontSize = '10px';
        framePacingNote.style.opacity = '0.55';
        framePacingNote.style.padding = '2px 6px 4px 6px';
        framePacingNote.style.fontStyle = 'italic';
        contentElement.appendChild(framePacingNote);
      }
    }

    // Effects section.
    const effectsFolder = this.pane.addFolder({
      title: 'Effects',
      expanded: true
    });

    // Active-count tag on the Effects folder title.
    this._ensureEffectsCountTag(effectsFolder);

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

  /**
   * Add a small count-tag chip to the Effects folder title (e.g. "8/12 active").
   * @private
   * @param {any} folder
   */
  _ensureEffectsCountTag(folder) {
    try {
      const titleElement = folder?.element?.querySelector?.('.tp-fldv_t');
      if (!titleElement) return;

      const tag = document.createElement('span');
      tag.className = 'map-shine-effects-count-tag';
      tag.style.marginLeft = '8px';
      tag.style.fontSize = '10px';
      tag.style.fontWeight = '600';
      tag.style.padding = '1px 6px';
      tag.style.borderRadius = '999px';
      tag.style.border = '1px solid rgba(255,255,255,0.14)';
      tag.style.background = 'rgba(255,255,255,0.08)';
      tag.style.opacity = '0.9';
      tag.style.verticalAlign = 'middle';
      tag.style.pointerEvents = 'none';
      titleElement.appendChild(tag);
      this._effectsCountTag = tag;
    } catch (_) {
    }
  }

  /**
   * Update the Effects folder count tag with current active/total.
   * @private
   */
  _updateEffectsCountTag() {
    if (!this._effectsCountTag) return;
    let active = 0;
    let total = 0;
    for (const [effectId] of this._effectUI.entries()) {
      total++;
      if (this.manager.getEffectiveEnabled(effectId)) active++;
    }
    const text = `${active}/${total} active`;
    this._effectsCountTag.textContent = text;
    this._effectsCountTag.style.display = text ? 'inline-block' : 'none';
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

    this._updateEffectsCountTag();
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
