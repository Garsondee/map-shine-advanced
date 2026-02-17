/**
 * @fileoverview Token Movement authoring dialog
 * @module ui/token-movement-dialog
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TokenMovementDialog');

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class TokenMovementDialog {
  constructor() {
    /** @type {Tweakpane.Pane|null} */
    this.pane = null;

    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {HTMLElement|null} */
    this.headerOverlay = null;

    /** @type {boolean} */
    this.visible = false;

    this.uiState = {
      managerStatus: 'Unavailable',
      defaultStyle: 'walk',
      fogPathPolicy: 'strictNoFogPath',
      weightedAStarWeight: 1.15,
      autoOpen: true,
      autoClose: 'outOfCombatOnly',
      closeDelayMs: 0,
      playerAutoDoorEnabled: false,
      requireDoorPermission: true
    };

    /** @type {Object<string, any>} */
    this._bindings = {};

    this._folderTags = {
      style: null,
      door: null
    };

    this._drag = {
      active: false,
      mx: 0,
      my: 0,
      left: 0,
      top: 0
    };

    this._bound = {
      onHeaderDown: (e) => this._onHeaderDown(e),
      onHeaderMove: (e) => this._onHeaderMove(e),
      onHeaderUp: () => this._onHeaderUp()
    };
  }

  async initialize() {
    if (this.pane) return;

    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (typeof Tweakpane === 'undefined') {
      throw new Error('Tweakpane library not available');
    }

    this.container = document.createElement('div');
    this.container.id = 'map-shine-token-movement-dialog';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10006';
    this.container.style.right = '20px';
    this.container.style.top = '80px';
    this.container.style.display = 'none';
    document.body.appendChild(this.container);

    {
      const stop = (e) => {
        try { e.stopPropagation(); } catch (_) {}
      };
      const stopAndPrevent = (e) => {
        try { e.preventDefault(); } catch (_) {}
        stop(e);
      };

      const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
      for (const type of events) {
        if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
        else this.container.addEventListener(type, stop);
      }
      this.container.addEventListener('contextmenu', stopAndPrevent);
    }

    this.pane = new Tweakpane.Pane({
      title: 'Token Movement Manager',
      container: this.container,
      expanded: true
    });

    this.headerOverlay = document.createElement('div');
    this.headerOverlay.className = 'map-shine-token-movement-header-overlay';
    this.headerOverlay.style.position = 'absolute';
    this.headerOverlay.style.top = '0';
    this.headerOverlay.style.left = '0';
    this.headerOverlay.style.right = '0';
    this.headerOverlay.style.height = '24px';
    this.headerOverlay.style.pointerEvents = 'auto';
    this.headerOverlay.style.cursor = 'move';
    this.headerOverlay.style.background = 'transparent';
    this.headerOverlay.style.zIndex = '10007';
    this.headerOverlay.addEventListener('mousedown', this._bound.onHeaderDown);
    this.container.appendChild(this.headerOverlay);

    this._buildUI();
    this.refreshFromManager();
    this.hide();

    log.info('Token Movement dialog initialized');
  }

  _getManager() {
    return window.MapShine?.tokenMovementManager || null;
  }

  _buildUI() {
    const mgr = this._getManager();
    const canEdit = game.user?.isGM === true && !!mgr;

    const statusFolder = this.pane.addFolder({ title: 'Status', expanded: true });
    this._bindings.managerStatus = statusFolder.addBinding(this.uiState, 'managerStatus', {
      label: 'State',
      readonly: true
    });

    const movementFolder = this.pane.addFolder({ title: 'Movement', expanded: true });
    this._ensureFolderTag(movementFolder, 'style', this.uiState.defaultStyle);

    const styleOptions = this._getStyleOptions();
    this._bindings.defaultStyle = movementFolder.addBinding(this.uiState, 'defaultStyle', {
      label: 'Default Style',
      options: styleOptions
    }).on('change', (ev) => {
      const manager = this._getManager();
      if (!manager || !game.user?.isGM) return;
      manager.setDefaultStyle(ev.value);
      this.uiState.defaultStyle = ev.value;
      this._setFolderTag('style', ev.value);
    });
    this._bindings.defaultStyle.disabled = !canEdit;

    this._bindings.weightedAStarWeight = movementFolder.addBinding(this.uiState, 'weightedAStarWeight', {
      label: 'A* Weight',
      min: 1,
      max: 2,
      step: 0.01
    }).on('change', (ev) => {
      const manager = this._getManager();
      if (!manager || !game.user?.isGM) return;
      manager.settings.weightedAStarWeight = clamp(asNumber(ev.value, 1.15), 1, 2);
    });
    this._bindings.weightedAStarWeight.disabled = !canEdit;

    this._bindings.fogPathPolicy = movementFolder.addBinding(this.uiState, 'fogPathPolicy', {
      label: 'Fog Path Policy',
      options: {
        'Strict No Fog Path': 'strictNoFogPath',
        'Allow but Redact': 'allowButRedact',
        'GM Unrestricted': 'gmUnrestricted'
      }
    }).on('change', (ev) => {
      const manager = this._getManager();
      if (!manager || !game.user?.isGM) return;
      manager.setFogPathPolicy(ev.value);
    });
    this._bindings.fogPathPolicy.disabled = !canEdit;

    const doorFolder = this.pane.addFolder({ title: 'Door Policy', expanded: true });
    this._ensureFolderTag(doorFolder, 'door', this.uiState.autoOpen ? 'Auto Open' : 'Manual');

    this._bindings.autoOpen = doorFolder.addBinding(this.uiState, 'autoOpen', {
      label: 'Auto Open'
    }).on('change', (ev) => {
      this._patchDoorPolicy({ autoOpen: !!ev.value });
      this._setFolderTag('door', ev.value ? 'Auto Open' : 'Manual');
    });

    this._bindings.autoClose = doorFolder.addBinding(this.uiState, 'autoClose', {
      label: 'Auto Close',
      options: {
        Never: 'never',
        Always: 'always',
        'Out of Combat': 'outOfCombatOnly',
        'In Combat': 'combatOnly'
      }
    }).on('change', (ev) => {
      this._patchDoorPolicy({ autoClose: ev.value });
    });

    this._bindings.closeDelayMs = doorFolder.addBinding(this.uiState, 'closeDelayMs', {
      label: 'Close Delay (ms)',
      min: 0,
      max: 5000,
      step: 50
    }).on('change', (ev) => {
      this._patchDoorPolicy({ closeDelayMs: clamp(asNumber(ev.value, 0), 0, 5000) });
    });

    this._bindings.playerAutoDoorEnabled = doorFolder.addBinding(this.uiState, 'playerAutoDoorEnabled', {
      label: 'Player Auto Door'
    }).on('change', (ev) => {
      this._patchDoorPolicy({ playerAutoDoorEnabled: !!ev.value });
    });

    this._bindings.requireDoorPermission = doorFolder.addBinding(this.uiState, 'requireDoorPermission', {
      label: 'Require Permission'
    }).on('change', (ev) => {
      this._patchDoorPolicy({ requireDoorPermission: !!ev.value });
    });

    for (const key of ['autoOpen', 'autoClose', 'closeDelayMs', 'playerAutoDoorEnabled', 'requireDoorPermission']) {
      if (this._bindings[key]) this._bindings[key].disabled = !canEdit;
    }

    const actionsFolder = this.pane.addFolder({ title: 'Actions', expanded: false });
    actionsFolder.addButton({ title: 'Refresh from Manager' }).on('click', () => this.refreshFromManager());
  }

  _getStyleOptions() {
    const manager = this._getManager();
    const out = {};

    if (manager?.styles instanceof Map && manager.styles.size > 0) {
      for (const [id, def] of manager.styles.entries()) {
        out[String(def?.label || id)] = id;
      }
      return out;
    }

    return {
      'Walk - Steady March': 'walk',
      'Walk - Heavy Stomp': 'walk-heavy-stomp',
      'Walk - Sneak Glide': 'walk-sneak-glide',
      'Walk - Swagger Stride': 'walk-swagger-stride',
      'Walk - Skitter Step': 'walk-skitter-step',
      'Walk - Limping Advance': 'walk-limping-advance',
      'Walk - Wobble Totter': 'walk-wobble-totter',
      'Walk - Drunken Drift': 'walk-drunken-drift',
      'Walk - Clockwork Tick-Walk': 'walk-clockwork-tick',
      'Walk - Chaos Skip': 'walk-chaos-skip',
      'Pick Up and Drop': 'pick-up-drop',
      'Flying - Glide': 'flying-glide',
      'Flying - Hover Bob': 'flying-hover-bob',
      'Flying - Bank Swoop': 'flying-bank-swoop',
      'Flying - Flutter Dart': 'flying-flutter-dart',
      'Flying - Chaos Drift': 'flying-chaos-drift'
    };
  }

  _patchDoorPolicy(patch) {
    const manager = this._getManager();
    if (!manager || !game.user?.isGM) return;
    manager.setDoorPolicy(patch);
  }

  refreshFromManager() {
    const manager = this._getManager();
    if (!manager) {
      this.uiState.managerStatus = 'Unavailable';
      this._refreshBindings();
      return;
    }

    this.uiState.managerStatus = manager.initialized ? 'Ready' : 'Not Initialized';
    this.uiState.defaultStyle = String(manager.settings?.defaultStyle || 'walk');
    this.uiState.fogPathPolicy = String(manager.settings?.fogPathPolicy || 'strictNoFogPath');
    this.uiState.weightedAStarWeight = asNumber(manager.settings?.weightedAStarWeight, 1.15);

    const doorPolicy = manager.settings?.doorPolicy || {};
    this.uiState.autoOpen = !!doorPolicy.autoOpen;
    this.uiState.autoClose = String(doorPolicy.autoClose || 'outOfCombatOnly');
    this.uiState.closeDelayMs = asNumber(doorPolicy.closeDelayMs, 0);
    this.uiState.playerAutoDoorEnabled = !!doorPolicy.playerAutoDoorEnabled;
    this.uiState.requireDoorPermission = doorPolicy.requireDoorPermission !== false;

    this._setFolderTag('style', this.uiState.defaultStyle);
    this._setFolderTag('door', this.uiState.autoOpen ? 'Auto Open' : 'Manual');
    this._refreshBindings();
  }

  _refreshBindings() {
    for (const binding of Object.values(this._bindings)) {
      try { binding?.refresh?.(); } catch (_) {}
    }
  }

  _ensureFolderTag(folder, key, initialText = '') {
    try {
      const titleElement = folder?.element?.querySelector?.('.tp-fldv_t');
      if (!titleElement) return;

      const tag = document.createElement('span');
      tag.className = `map-shine-folder-tag map-shine-folder-tag-${key}`;
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
      this._folderTags[key] = tag;
      this._setFolderTag(key, initialText);
    } catch (_) {
    }
  }

  _setFolderTag(key, text) {
    const tag = this._folderTags?.[key];
    if (!tag) return;
    const next = String(text || '').trim();
    tag.textContent = next;
    tag.style.display = next ? 'inline-block' : 'none';
  }

  _onHeaderDown(event) {
    if (!this.container || event.button !== 0) return;
    this._drag.active = true;
    this._drag.mx = event.clientX;
    this._drag.my = event.clientY;
    const rect = this.container.getBoundingClientRect();
    this._drag.left = rect.left;
    this._drag.top = rect.top;
    window.addEventListener('mousemove', this._bound.onHeaderMove);
    window.addEventListener('mouseup', this._bound.onHeaderUp);
  }

  _onHeaderMove(event) {
    if (!this._drag.active || !this.container) return;
    const dx = event.clientX - this._drag.mx;
    const dy = event.clientY - this._drag.my;
    this.container.style.right = 'auto';
    this.container.style.left = `${Math.round(this._drag.left + dx)}px`;
    this.container.style.top = `${Math.round(this._drag.top + dy)}px`;
  }

  _onHeaderUp() {
    this._drag.active = false;
    window.removeEventListener('mousemove', this._bound.onHeaderMove);
    window.removeEventListener('mouseup', this._bound.onHeaderUp);
  }

  show() {
    if (!this.container) return;
    this.visible = true;
    this.refreshFromManager();
    this.container.style.display = 'block';
  }

  hide() {
    if (!this.container) return;
    this.visible = false;
    this.container.style.display = 'none';
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  dispose() {
    this.hide();

    if (this.headerOverlay) {
      this.headerOverlay.removeEventListener('mousedown', this._bound.onHeaderDown);
      this.headerOverlay = null;
    }

    window.removeEventListener('mousemove', this._bound.onHeaderMove);
    window.removeEventListener('mouseup', this._bound.onHeaderUp);

    if (this.pane) {
      try { this.pane.dispose(); } catch (_) {}
      this.pane = null;
    }

    if (this.container?.parentNode) {
      try { this.container.parentNode.removeChild(this.container); } catch (_) {}
    }
    this.container = null;
  }
}
