/**
 * @fileoverview Player Light mode picker — single palette entry point for all modes.
 * @module ui/player-light-picker-dialog
 */

import {
  getPlayerLightAllowanceLabel,
  isPlayerLightModeAllowedForUser,
  isValidPlayerLightMode,
  PLAYER_LIGHT_MODES,
  applyPlayerLightModeToToken,
} from '../core/player-light-allowance.js';
import { createLogger } from '../core/log.js';

const log = createLogger('PlayerLightPicker');

/** @type {Record<string, string>} */
const MODE_ICONS = Object.freeze({
  torch: 'fas fa-fire',
  flashlight: 'fas fa-lightbulb',
  nightVision: 'fas fa-binoculars',
  lowLightVision: 'fas fa-eye',
  infravision: 'fas fa-temperature-high',
  activeIR: 'fas fa-radar',
});

/**
 * @param {string} value
 */
function escapeHtml(value) {
  const s = String(value ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class PlayerLightPickerDialog {
  constructor() {
    /** @type {HTMLElement|null} */
    this.container = null;
    /** @type {boolean} */
    this.visible = false;
    this._boundStopHandlers = null;
  }

  /**
   * @param {HTMLElement} [parentElement]
   */
  initialize(parentElement = document.body) {
    if (this.container) return;

    const container = document.createElement('div');
    container.id = 'map-shine-player-light-picker';
    container.className = 'map-shine-player-light-picker map-shine-overlay-ui';
    container.style.display = 'none';

    container.innerHTML = `
      <div class="msa-pl-picker__header" data-drag-handle>
        <div class="msa-pl-picker__header-text">
          <div class="msa-pl-picker__title">Player Light</div>
          <div class="msa-pl-picker__subtitle" data-bind="subtitle">Select a token first</div>
        </div>
        <button type="button" class="msa-pl-picker__close" data-action="close" aria-label="Close">×</button>
      </div>
      <div class="msa-pl-picker__body" data-bind="mode-list"></div>
    `;

    parentElement.appendChild(container);
    this.container = container;
    this._installPointerIsolation();
    this._bindEvents();
    this._installDrag();
  }

  /** @private */
  _installPointerIsolation() {
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
    this._boundStopHandlers = { stop, stopAndPrevent };
  }

  /** @private */
  _bindEvents() {
    this.container?.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-action]');
      if (!btn || !this.container?.contains(btn)) return;
      const action = btn.dataset.action;
      if (action === 'close') this.hide();
      else if (action === 'pick-mode') {
        const mode = btn.dataset.mode;
        this._pickMode(mode === 'off' ? null : mode);
      }
    });
  }

  /** @private */
  _installDrag() {
    const root = this.container;
    const handle = root?.querySelector('[data-drag-handle]');
    if (!root || !handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    const onMove = (ev) => {
      if (!dragging) return;
      root.style.left = `${baseLeft + (ev.clientX - startX)}px`;
      root.style.top = `${baseTop + (ev.clientY - startY)}px`;
      root.style.transform = 'none';
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.target?.closest?.('button')) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      baseLeft = rect.left;
      baseTop = rect.top;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      try { ev.preventDefault(); } catch (_) {}
    });
  }

  /**
   * @private
   * @returns {{ tokenDoc: TokenDocument|null, enabled: boolean, mode: string|null }}
   */
  _readTokenState() {
    try {
      const tokenDoc = canvas?.tokens?.controlled?.[0]?.document ?? null;
      if (!tokenDoc) return { tokenDoc: null, enabled: false, mode: null };
      const enabled = !!tokenDoc.getFlag?.('map-shine-advanced', 'playerLightEnabled');
      const modeRaw = tokenDoc.getFlag?.('map-shine-advanced', 'playerLightMode');
      const mode = isValidPlayerLightMode(modeRaw) ? modeRaw : null;
      return { tokenDoc, enabled, mode };
    } catch (_) {
      return { tokenDoc: null, enabled: false, mode: null };
    }
  }

  /**
   * @private
   * @param {string|null} mode
   */
  async _pickMode(mode) {
    const { tokenDoc } = this._readTokenState();
    if (!tokenDoc) {
      ui.notifications?.warn?.('Select a token first.');
      return;
    }

    const playerLightEffect = window.MapShine?.floorCompositorV2?._playerLightEffect
      ?? window.MapShine?.effectComposer?._floorCompositorV2?._playerLightEffect
      ?? null;
    if (playerLightEffect && !playerLightEffect.enabled) {
      ui.notifications?.warn?.('Player Light is disabled for this map.');
      return;
    }

    if (mode && !isPlayerLightModeAllowedForUser(mode)) {
      ui.notifications?.warn?.(`${getPlayerLightAllowanceLabel(mode)} is not enabled by the GM on this scene.`);
      return;
    }

    try {
      await applyPlayerLightModeToToken(tokenDoc, mode);
      this.refresh();
      try {
        ui?.controls?.render?.(true);
      } catch (_) {}
    } catch (e) {
      log.warn('Failed to set player light mode', e);
      ui.notifications?.warn?.('Failed to set Player Light mode.');
    }
  }

  /** @private */
  _listSelectableModes() {
    return PLAYER_LIGHT_MODES.filter((mode) => isPlayerLightModeAllowedForUser(mode));
  }

  refresh() {
    const host = this.container?.querySelector('[data-bind="mode-list"]');
    const subtitle = this.container?.querySelector('[data-bind="subtitle"]');
    if (!host) return;

    const { tokenDoc, enabled, mode: activeMode } = this._readTokenState();
    if (subtitle) {
      subtitle.textContent = tokenDoc?.name
        ? `Token: ${tokenDoc.name}`
        : 'Select a token on the canvas first';
    }

    const modes = this._listSelectableModes();
    if (!tokenDoc) {
      host.innerHTML = '<p class="msa-pl-picker__empty">Select a token, then choose a light mode.</p>';
      return;
    }

    if (modes.length === 0) {
      host.innerHTML = '<p class="msa-pl-picker__empty">No player light modes are enabled for you on this scene.</p>';
      return;
    }

    const offActive = !enabled || !activeMode;
    const rows = [
      `<button type="button" class="msa-pl-picker__mode${offActive ? ' is-active' : ''}" data-action="pick-mode" data-mode="off">
        <i class="fas fa-power-off" aria-hidden="true"></i>
        <span>Off</span>
      </button>`,
      ...modes.map((m) => {
        const active = enabled && activeMode === m;
        const icon = MODE_ICONS[m] || 'fas fa-lightbulb';
        const label = getPlayerLightAllowanceLabel(m);
        return `<button type="button" class="msa-pl-picker__mode${active ? ' is-active' : ''}" data-action="pick-mode" data-mode="${escapeHtml(m)}">
          <i class="${icon}" aria-hidden="true"></i>
          <span>${escapeHtml(label)}</span>
        </button>`;
      }),
    ];

    host.innerHTML = rows.join('');
  }

  show() {
    if (!this.container) this.initialize();
    if (!this.container) return;
    this.container.style.display = 'flex';
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
    if (this.container && this._boundStopHandlers) {
      try {
        const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
        for (const type of events) {
          this.container.removeEventListener(type, this._boundStopHandlers.stop);
        }
        this.container.removeEventListener('contextmenu', this._boundStopHandlers.stopAndPrevent);
      } catch (_) {}
    }
    try {
      this.container?.parentNode?.removeChild?.(this.container);
    } catch (_) {}
    this.container = null;
    this.visible = false;
  }
}

/** @type {PlayerLightPickerDialog|null} */
let _singleton = null;

/**
 * @returns {PlayerLightPickerDialog}
 */
export function getPlayerLightPickerDialog() {
  if (!_singleton) {
    _singleton = new PlayerLightPickerDialog();
    _singleton.initialize();
  }
  return _singleton;
}
