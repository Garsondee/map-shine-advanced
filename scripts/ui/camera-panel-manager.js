/**
 * @fileoverview Camera Panel Manager
 * Lightweight panel for Map Shine Advanced camera controls.
 *
 * @module ui/camera-panel-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('CameraPanel');

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
        <div class="map-shine-camera-panel__title">Map Shine Camera</div>
        <button type="button" class="map-shine-camera-panel__close" data-action="close" aria-label="Close">×</button>
      </div>
      <div class="map-shine-camera-panel__body">
        <label><input type="checkbox" data-input="improvedModeEnabled"> Enable Improved Camera Mode</label>

        <div class="map-shine-camera-panel__section">Cinematic</div>
        <label><input type="checkbox" data-input="cinematicActive"> Cinematic Active</label>
        <label><input type="checkbox" data-input="lockPlayers"> Lock Players to GM Camera</label>
        <label><input type="checkbox" data-input="strictFollow"> Strict Force Follow</label>

        <label>UI Fade
          <input type="range" data-input="uiFade" min="0" max="1" step="0.01">
        </label>
        <label>Bar Height
          <input type="range" data-input="barHeightPct" min="0.03" max="0.35" step="0.01">
        </label>
        <label>Transition (ms)
          <input type="range" data-input="transitionMs" min="50" max="3000" step="10">
        </label>

        <div class="map-shine-camera-panel__section">Player Fog Bounds</div>
        <label><input type="checkbox" data-input="playerBoundsEnabled"> Enable Player Bounds</label>
        <label>Padding (px)
          <input type="range" data-input="playerBoundsPadding" min="0" max="2000" step="10">
        </label>
        <label>Sampling
          <input type="range" data-input="playerBoundsSampleDivisions" min="6" max="80" step="1">
        </label>

        <div class="map-shine-camera-panel__section">Group Cohesion</div>
        <label><input type="checkbox" data-input="cohesionEnabled"> Enable Group Cohesion Force</label>
        <label>Strength
          <input type="range" data-input="cohesionStrength" min="0" max="1" step="0.01">
        </label>
        <label><input type="checkbox" data-input="cohesionAutoFit"> Auto-fit Group</label>
        <label>Fit Padding (px)
          <input type="range" data-input="cohesionPadding" min="0" max="2000" step="10">
        </label>

        <div class="map-shine-camera-panel__section">Actions</div>
        <div class="map-shine-camera-panel__actions">
          <button type="button" data-action="focusSelected">Focus Selected</button>
          <button type="button" data-action="focusGroup">Focus Group</button>
          <button type="button" data-action="testImpulse">Test Impulse API</button>
          <button type="button" data-action="emergencyUnlock">Emergency Unlock</button>
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
        case 'testImpulse':
          this.cinematicManager?.triggerImpulse?.({ x: 0.6, y: 0.4, zoom: 0.03, durationMs: 220 });
          ui.notifications?.info?.('Camera impulse API invoked (foundation test).');
          break;
        case 'emergencyUnlock':
          this.cinematicManager?.emergencyUnlockPlayers?.();
          break;
      }
    });

    const bind = (key, handler) => {
      const el = this._inputs[key];
      if (!el) return;
      el.addEventListener('input', () => handler(el));
      el.addEventListener('change', () => handler(el));
    };

    bind('improvedModeEnabled', (el) => this.cinematicManager?.setImprovedModeEnabled?.(el.checked));
    bind('cinematicActive', (el) => {
      if (el.checked) this.cinematicManager?.startCinematic?.();
      else this.cinematicManager?.endCinematic?.();
    });
    bind('lockPlayers', (el) => this.cinematicManager?.setLockPlayers?.(el.checked));
    bind('strictFollow', (el) => this.cinematicManager?.setStrictFollow?.(el.checked));

    bind('uiFade', (el) => this.cinematicManager?.setUiFade?.(asNumber(el.value, 0.92)));
    bind('barHeightPct', (el) => this.cinematicManager?.setBarHeightPct?.(asNumber(el.value, 0.12)));
    bind('transitionMs', (el) => this.cinematicManager?.setTransitionMs?.(asNumber(el.value, 450)));

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
      setCheck('cinematicActive', state.cinematicActive);
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

    this._applyRoleRestrictions();
  }

  _applyRoleRestrictions() {
    if (!this.container) return;
    const isGM = game.user?.isGM === true;

    const gmOnlyInputs = [
      'improvedModeEnabled',
      'cinematicActive',
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
