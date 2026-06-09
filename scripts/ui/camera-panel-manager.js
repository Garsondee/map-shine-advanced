/**
 * @fileoverview Camera Panel Manager
 * Full tuning panel for Map Shine Advanced camera controls.
 *
 * @module ui/camera-panel-manager
 */
import { isUserGM } from '../core/gm-parity.js';

import { createLogger } from '../core/log.js';

const log = createLogger('CameraPanel');

const SLIDER_DISPLAY_FORMAT = {
  uiFade: (v) => `${Math.round(asNumber(v, 0) * 100)}%`,
  barHeightPct: (v) => `${Math.round(asNumber(v, 0) * 100)}%`,
  transitionMs: (v) => `${Math.round(asNumber(v, 0))} ms`,
  playerBoundsPadding: (v) => `${Math.round(asNumber(v, 0))} px`,
  playerBoundsSampleDivisions: (v) => `${Math.round(asNumber(v, 0))}`,
  cohesionStrength: (v) => `${Math.round(asNumber(v, 0) * 100)}%`,
  cohesionPadding: (v) => `${Math.round(asNumber(v, 0))} px`,
};

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class CameraPanelManager {
  /**
   * @param {import('../foundry/cinematic-camera-manager.js').CinematicCameraManager|null} cinematicManager
   */
  constructor(cinematicManager = null) {
    this.cinematicManager = cinematicManager;

    this.container = null;
    this.visible = false;

    this._unbindState = null;
    this._inputs = {};
    this._displays = {};
  }

  setCinematicManager(manager) {
    this.cinematicManager = manager;
    this._bindStateListener();
    this._syncFromManager();
  }

  initialize(parentElement = document.body) {
    if (this.container) return;

    const container = document.createElement('div');
    container.id = 'map-shine-camera-panel';
    container.className = 'map-shine-camera-panel map-shine-overlay-ui';
    container.style.display = 'none';

    container.innerHTML = `
      <div class="map-shine-camera-panel__header">
        <div class="map-shine-camera-panel__title">Cinematic Options</div>
        <button type="button" class="map-shine-camera-panel__close" data-action="close" aria-label="Close">×</button>
      </div>
      <div class="map-shine-camera-panel__body">
        <label><input type="checkbox" data-input="improvedModeEnabled"> Enable Improved Camera Mode</label>

        <div class="map-shine-camera-panel__section">Cinematic (players)</div>
        <label><input type="checkbox" data-input="lockPlayers"> Lock Players to GM Camera</label>
        <label><input type="checkbox" data-input="strictFollow"> Strict Force Follow</label>

        <label class="map-shine-camera-panel__slider">
          <span class="map-shine-camera-panel__slider-head">
            <span>UI Fade (legacy opacity when not fully hidden)</span>
            <span data-display="uiFade">92%</span>
          </span>
          <input type="range" data-input="uiFade" min="0" max="1" step="0.01">
        </label>
        <label class="map-shine-camera-panel__slider">
          <span class="map-shine-camera-panel__slider-head">
            <span>Bar Height</span>
            <span data-display="barHeightPct">12%</span>
          </span>
          <input type="range" data-input="barHeightPct" min="0.03" max="0.35" step="0.01">
        </label>
        <label class="map-shine-camera-panel__slider">
          <span class="map-shine-camera-panel__slider-head">
            <span>Transition (bar speed; cinematic sequence uses 5s minimum)</span>
            <span data-display="transitionMs">5000 ms</span>
          </span>
          <input type="range" data-input="transitionMs" min="5000" max="10000" step="100">
        </label>

        <div class="map-shine-camera-panel__section">Player Fog Bounds</div>
        <label><input type="checkbox" data-input="playerBoundsEnabled"> Enable Player Bounds</label>
        <label class="map-shine-camera-panel__slider">
          <span class="map-shine-camera-panel__slider-head">
            <span>Padding</span>
            <span data-display="playerBoundsPadding">220 px</span>
          </span>
          <input type="range" data-input="playerBoundsPadding" min="0" max="2000" step="10">
        </label>
        <label class="map-shine-camera-panel__slider">
          <span class="map-shine-camera-panel__slider-head">
            <span>Sampling divisions</span>
            <span data-display="playerBoundsSampleDivisions">16</span>
          </span>
          <input type="range" data-input="playerBoundsSampleDivisions" min="6" max="80" step="1">
        </label>

        <div class="map-shine-camera-panel__section">Group Cohesion</div>
        <label><input type="checkbox" data-input="cohesionEnabled"> Enable Group Cohesion Force</label>
        <label class="map-shine-camera-panel__slider">
          <span class="map-shine-camera-panel__slider-head">
            <span>Strength</span>
            <span data-display="cohesionStrength">8%</span>
          </span>
          <input type="range" data-input="cohesionStrength" min="0" max="1" step="0.01">
        </label>
        <label><input type="checkbox" data-input="cohesionAutoFit"> Auto-fit Group</label>
        <label class="map-shine-camera-panel__slider">
          <span class="map-shine-camera-panel__slider-head">
            <span>Fit Padding</span>
            <span data-display="cohesionPadding">220 px</span>
          </span>
          <input type="range" data-input="cohesionPadding" min="0" max="2000" step="10">
        </label>

        <div class="map-shine-camera-panel__section">Actions</div>
        <div class="map-shine-camera-panel__actions">
          <button type="button" data-action="focusSelected">Focus Selected</button>
          <button type="button" data-action="focusGroup">Focus Group</button>
          <button type="button" data-action="emergencyUnlock">Unlock Players (keep cinematic)</button>
        </div>
      </div>
    `;

    parentElement.appendChild(container);
    this.container = container;

    this._cacheInputs();
    this._bindUiEvents();
    this._bindStateListener();
    this._syncFromManager();

    log.info('Camera panel initialized');
  }

  _cacheInputs() {
    if (!this.container) return;

    const inputs = this.container.querySelectorAll('[data-input]');
    for (const input of inputs) {
      this._inputs[input.dataset.input] = input;
    }

    const displays = this.container.querySelectorAll('[data-display]');
    for (const display of displays) {
      this._displays[display.dataset.display] = display;
    }
  }

  _formatDisplay(key, value) {
    const fmt = SLIDER_DISPLAY_FORMAT[key];
    return fmt ? fmt(value) : String(value ?? '');
  }

  _updateDisplays(keys = null) {
    const state = this.cinematicManager?.getState?.();
    const keyList = keys || Object.keys(this._displays);
    for (const key of keyList) {
      const el = this._displays[key];
      if (!el) continue;
      const raw = state ? state[key] : this._inputs[key]?.value;
      el.textContent = this._formatDisplay(key, raw);
    }
  }

  _bindUiEvents() {
    if (!this.container) return;

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

    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      this.container.addEventListener(type, stop);
    }
    this.container.addEventListener('wheel', stop, { passive: true });
    this.container.addEventListener('contextmenu', stopAndPrevent);

    this.container.addEventListener('click', (event) => {
      const actionEl = event.target?.closest?.('[data-action]');
      if (!actionEl) return;

      const action = actionEl.dataset.action;
      switch (action) {
        case 'close':
          this.hide();
          break;
        case 'focusSelected':
          this.cinematicManager?.focusSelectedToken?.();
          break;
        case 'focusGroup':
          this.cinematicManager?.focusControlledGroup?.();
          break;
        case 'emergencyUnlock':
          this.cinematicManager?.emergencyUnlockPlayers?.();
          break;
      }
    });

    const bind = (key, handler) => {
      const el = this._inputs[key];
      if (!el) return;
      const run = () => {
        handler(el);
        this._updateDisplays([key]);
      };
      el.addEventListener('input', run);
      el.addEventListener('change', run);
    };

    bind('improvedModeEnabled', (el) => this.cinematicManager?.setImprovedModeEnabled?.(el.checked));
    bind('lockPlayers', (el) => this.cinematicManager?.setLockPlayers?.(el.checked));
    bind('strictFollow', (el) => this.cinematicManager?.setStrictFollow?.(el.checked));

    bind('uiFade', (el) => this.cinematicManager?.setUiFade?.(asNumber(el.value, 0.92)));
    bind('barHeightPct', (el) => this.cinematicManager?.setBarHeightPct?.(asNumber(el.value, 0.12)));
    bind('transitionMs', (el) => this.cinematicManager?.setTransitionMs?.(asNumber(el.value, 5000)));

    bind('playerBoundsEnabled', (el) => this.cinematicManager?.setPlayerBoundsEnabled?.(el.checked));
    bind('playerBoundsPadding', (el) => this.cinematicManager?.setPlayerBoundsPadding?.(asNumber(el.value, 220)));
    bind('playerBoundsSampleDivisions', (el) => this.cinematicManager?.setPlayerBoundsSampleDivisions?.(asNumber(el.value, 16)));

    bind('cohesionEnabled', (el) => this.cinematicManager?.setGroupCohesionEnabled?.(el.checked));
    bind('cohesionStrength', (el) => this.cinematicManager?.setGroupCohesionStrength?.(asNumber(el.value, 0.08)));
    bind('cohesionAutoFit', (el) => this.cinematicManager?.setGroupCohesionAutoFit?.(el.checked));
    bind('cohesionPadding', (el) => this.cinematicManager?.setGroupCohesionPadding?.(asNumber(el.value, 220)));
  }

  _bindStateListener() {
    if (this._unbindState) {
      this._unbindState();
      this._unbindState = null;
    }

    if (!this.cinematicManager?.onStateChange) return;
    this._unbindState = this.cinematicManager.onStateChange(() => this._syncFromManager());
  }

  _syncFromManager() {
    if (!this.container) return;

    const state = this.cinematicManager?.getState ? this.cinematicManager.getState() : null;

    const setCheck = (key, value) => {
      const el = this._inputs[key];
      if (el) el.checked = value === true;
    };

    const setValue = (key, value) => {
      const el = this._inputs[key];
      if (el) el.value = String(value);
    };

    if (state) {
      setCheck('improvedModeEnabled', state.improvedModeEnabled);
      setCheck('lockPlayers', state.lockPlayers);
      setCheck('strictFollow', state.strictFollow);

      setValue('uiFade', state.uiFade);
      setValue('barHeightPct', state.barHeightPct);
      setValue('transitionMs', state.transitionMs);

      setCheck('playerBoundsEnabled', state.playerBoundsEnabled);
      setValue('playerBoundsPadding', state.playerBoundsPadding);
      setValue('playerBoundsSampleDivisions', state.playerBoundsSampleDivisions);

      setCheck('cohesionEnabled', state.cohesionEnabled);
      setValue('cohesionStrength', state.cohesionStrength);
      setCheck('cohesionAutoFit', state.cohesionAutoFit);
      setValue('cohesionPadding', state.cohesionPadding);
    }

    this._updateDisplays();
    this._applyRoleRestrictions();
  }

  _applyRoleRestrictions() {
    if (!this.container) return;
    const isGM = isUserGM();

    const gmOnlyInputs = [
      'improvedModeEnabled',
      'lockPlayers',
      'strictFollow',
      'uiFade',
      'barHeightPct',
      'transitionMs',
      'playerBoundsEnabled',
      'playerBoundsPadding',
      'playerBoundsSampleDivisions',
      'cohesionEnabled',
      'cohesionStrength',
      'cohesionAutoFit',
      'cohesionPadding',
    ];

    for (const key of gmOnlyInputs) {
      const el = this._inputs[key];
      if (el) {
        el.disabled = !isGM;
      }
    }

    const actionButtons = this.container.querySelectorAll('[data-action="emergencyUnlock"], [data-action="focusSelected"], [data-action="focusGroup"]');
    for (const btn of actionButtons) {
      btn.disabled = !isGM;
    }
  }

  show() {
    if (!this.container) return;
    this.container.style.display = 'block';
    this.visible = true;
    this._syncFromManager();
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

  destroy() {
    if (this._unbindState) {
      this._unbindState();
      this._unbindState = null;
    }

    if (this.container) {
      try {
        this.container.remove();
      } catch (_) {
      }
    }

    this.container = null;
    this._inputs = {};
    this._displays = {};
    this.visible = false;
  }
}
