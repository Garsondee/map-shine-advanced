/**
 * @fileoverview Compact always-visible level navigator overlay.
 *
 * This overlay is intended for both players and GMs during gameplay when a
 * scene has Levels data enabled. It provides fast level stepping and key
 * level-focused controls without requiring the full camera panel.
 */

import { createLogger } from '../core/log.js';
import { isLevelsEnabledForScene } from '../foundry/levels-scene-flags.js';

const log = createLogger('LevelNavigatorOverlay');

const OVERLAY_ID = 'level-navigator-compact';
const STORAGE_KEY = 'map-shine.levelNavigatorOverlay.position.v1';

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function getDefaultScreenPos() {
  const w = Math.max(320, window.innerWidth || 1280);
  const h = Math.max(240, window.innerHeight || 720);
  return {
    x: Math.round(w - 180),
    y: Math.round(h - 150),
  };
}

export class LevelNavigatorOverlay {
  /**
   * @param {import('./overlay-ui-manager.js').OverlayUIManager|null} overlayManager
   * @param {import('../foundry/camera-follower.js').CameraFollower|null} levelNavigationController
   */
  constructor(overlayManager, levelNavigationController = null) {
    this.overlayManager = overlayManager || null;
    this.levelNavigationController = levelNavigationController || null;

    /** @type {any|null} */
    this._overlayHandle = null;

    /** @type {HTMLElement|null} */
    this._panel = null;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {number|null} */
    this._levelHookId = null;

    /** @type {number|null} */
    this._sceneHookId = null;

    /** @type {object|null} */
    this._lastDiagnostics = null;

    /** @type {{active:boolean,startX:number,startY:number,startClientX:number,startClientY:number}} */
    this._drag = {
      active: false,
      startX: 0,
      startY: 0,
      startClientX: 0,
      startClientY: 0,
    };

    this._boundHandlers = {
      onMove: (e) => this._onDragMove(e),
      onUp: (e) => this._onDragEnd(e),
    };

    this._els = {
      title: null,
      status: null,
      diagnostics: null,
      levelSelect: null,
      follow: null,
      ghost: null,
      tint: null,
    };
  }

  initialize() {
    if (this._initialized) return;
    if (!this.overlayManager) {
      log.warn('Cannot initialize level navigator overlay: no overlay manager');
      return;
    }

    const handle = this.overlayManager.createOverlay(OVERLAY_ID, {
      capturePointerEvents: true,
      clampToScreen: true,
      marginPx: 20,
    });
    this._overlayHandle = handle;

    const host = handle.el;
    host.id = 'map-shine-level-navigator-overlay';
    host.classList.add('map-shine-overlay-ui');
    host.style.pointerEvents = 'auto';
    host.style.width = '0px';
    host.style.height = '0px';

    const panel = document.createElement('div');
    panel.classList.add('map-shine-level-navigator-panel');
    panel.style.cssText = [
      'position:absolute',
      'left:0px',
      'top:0px',
      'transform:translate(-50%, -50%)',
      'min-width:220px',
      'max-width:280px',
      'padding:8px 10px',
      'border-radius:10px',
      'background:rgba(20,24,30,0.90)',
      'border:1px solid rgba(170,210,255,0.35)',
      'box-shadow:0 10px 28px rgba(0,0,0,0.45)',
      'backdrop-filter:blur(8px)',
      '-webkit-backdrop-filter:blur(8px)',
      'font-family:var(--font-primary, Signika, sans-serif)',
      'font-size:12px',
      'line-height:1.25',
      'color:rgba(245,248,255,0.94)',
      'pointer-events:auto',
      'user-select:none',
      '-webkit-user-select:none',
    ].join(';');

    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      panel.addEventListener(type, (e) => {
        e.stopPropagation();
      });
    }
    panel.addEventListener('wheel', (e) => {
      e.stopPropagation();
    }, { passive: true });
    panel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:8px',
      'margin-bottom:6px',
      'cursor:move',
      'padding-bottom:4px',
      'border-bottom:1px solid rgba(255,255,255,0.10)',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Levels';
    title.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:0.02em;';

    const hint = document.createElement('div');
    hint.textContent = '[ / ]';
    hint.style.cssText = 'font-size:10px;opacity:0.7;';

    header.appendChild(title);
    header.appendChild(hint);
    header.addEventListener('pointerdown', (e) => this._onDragStart(e), true);

    const row1 = document.createElement('div');
    row1.style.cssText = 'display:grid;grid-template-columns:auto 1fr auto auto;gap:6px;align-items:center;';

    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '-';
    down.title = 'Level down';
    down.style.cssText = this._buttonStyle();
    down.addEventListener('click', () => {
      this.levelNavigationController?.stepLevel?.(-1, { reason: 'compact-overlay' });
    });

    const levelSelect = document.createElement('select');
    levelSelect.style.cssText = [
      'width:100%',
      'min-width:90px',
      'border-radius:6px',
      'border:1px solid rgba(255,255,255,0.24)',
      'background:rgba(7,10,14,0.75)',
      'color:rgba(255,255,255,0.92)',
      'font-size:11px',
      'padding:3px 6px',
    ].join(';');
    levelSelect.addEventListener('change', () => {
      const idx = Number(levelSelect.value);
      if (!Number.isFinite(idx)) return;
      this.levelNavigationController?.setActiveLevel?.(idx, { reason: 'compact-overlay-select' });
    });

    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '+';
    up.title = 'Level up';
    up.style.cssText = this._buttonStyle();
    up.addEventListener('click', () => {
      this.levelNavigationController?.stepLevel?.(1, { reason: 'compact-overlay' });
    });

    const snap = document.createElement('button');
    snap.type = 'button';
    snap.textContent = 'T';
    snap.title = 'Snap to token level';
    snap.style.cssText = this._buttonStyle();
    snap.addEventListener('click', () => {
      this.levelNavigationController?.setLockMode?.('follow-controlled-token', { emit: true, reason: 'compact-overlay-token' });
      this.levelNavigationController?.setLockMode?.('manual', { emit: true, reason: 'compact-overlay-token-manual' });
    });

    row1.appendChild(down);
    row1.appendChild(levelSelect);
    row1.appendChild(up);
    row1.appendChild(snap);

    const row2 = document.createElement('div');
    row2.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:6px;';

    const followWrap = this._makeCheckbox('Follow', (checked) => {
      this.levelNavigationController?.setLockMode?.(checked ? 'follow-controlled-token' : 'manual', { reason: 'compact-overlay-follow' });
    });

    const ghostWrap = this._makeCheckbox('Ghost', (checked) => {
      window.MapShine?.gridRenderer?.setGhostGridEnabled?.(checked);
      this._syncFromState();
    });

    const tintWrap = this._makeCheckbox('Tint', (checked) => {
      window.MapShine?.gridRenderer?.setFloorTintPresetsEnabled?.(checked);
      this._syncFromState();
    });

    row2.appendChild(followWrap.root);
    row2.appendChild(ghostWrap.root);
    row2.appendChild(tintWrap.root);

    const status = document.createElement('div');
    status.style.cssText = 'margin-top:6px;font-size:11px;opacity:0.9;';
    status.textContent = 'Waiting for level context...';

    const diagnostics = document.createElement('div');
    diagnostics.style.cssText = 'margin-top:3px;font-size:10px;opacity:0.72;white-space:pre-line;';
    diagnostics.textContent = '';

    panel.appendChild(header);
    panel.appendChild(row1);
    panel.appendChild(row2);
    panel.appendChild(status);
    panel.appendChild(diagnostics);

    host.appendChild(panel);

    this._panel = panel;
    this._els.title = title;
    this._els.status = status;
    this._els.diagnostics = diagnostics;
    this._els.levelSelect = levelSelect;
    this._els.follow = followWrap.input;
    this._els.ghost = ghostWrap.input;
    this._els.tint = tintWrap.input;

    const startPos = this._loadPosition();
    this.overlayManager.lockOverlay(OVERLAY_ID, startPos);

    this._levelHookId = Hooks.on('mapShineLevelContextChanged', (payload) => {
      this._lastDiagnostics = payload?.diagnostics || this.levelNavigationController?.getLevelDiagnostics?.() || null;
      this._syncFromState();
    });

    this._sceneHookId = Hooks.on('updateScene', (scene, changes) => {
      if (!scene || scene.id !== canvas.scene?.id) return;
      if (changes?.flags?.levels !== undefined) {
        this._syncFromState();
      }
    });

    this._initialized = true;
    this._syncFromState();
    log.info('Level navigator compact overlay initialized');
  }

  setLevelNavigationController(controller) {
    this.levelNavigationController = controller || null;
    this._lastDiagnostics = this.levelNavigationController?.getLevelDiagnostics?.() || null;
    this._syncFromState();
  }

  _buttonStyle() {
    return [
      'height:24px',
      'min-width:24px',
      'padding:0 6px',
      'border-radius:6px',
      'border:1px solid rgba(255,255,255,0.20)',
      'background:rgba(255,255,255,0.09)',
      'color:rgba(255,255,255,0.95)',
      'font-size:12px',
      'font-weight:700',
      'cursor:pointer',
    ].join(';');
  }

  _makeCheckbox(label, onChange) {
    const root = document.createElement('label');
    root.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:10px;opacity:0.92;';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.style.cssText = 'margin:0;';
    input.addEventListener('change', () => {
      onChange(input.checked === true);
    });

    const span = document.createElement('span');
    span.textContent = label;

    root.appendChild(input);
    root.appendChild(span);

    return { root, input };
  }

  _hasLevelsEnabledOnScene() {
    return isLevelsEnabledForScene(canvas?.scene);
  }

  _syncFromState() {
    if (!this._initialized || !this.overlayManager) return;

    const enabledForScene = this._hasLevelsEnabledOnScene();
    const hasController = !!this.levelNavigationController;
    const visible = enabledForScene && hasController;
    this.overlayManager.setVisible(OVERLAY_ID, visible);

    if (!visible) return;

    const context = this.levelNavigationController?.getActiveLevelContext?.() || null;
    const levels = this.levelNavigationController?.getAvailableLevels?.() || [];
    const lockMode = this.levelNavigationController?.getLockMode?.() || 'manual';
    const diagnostics = this._lastDiagnostics || this.levelNavigationController?.getLevelDiagnostics?.() || null;

    if (this._els.follow) this._els.follow.checked = lockMode === 'follow-controlled-token';
    if (this._els.ghost) this._els.ghost.checked = window.MapShine?.gridRenderer?.isGhostGridEnabled?.() === true;
    if (this._els.tint) this._els.tint.checked = window.MapShine?.gridRenderer?.isFloorTintPresetsEnabled?.() === true;

    if (this._els.levelSelect) {
      const select = this._els.levelSelect;
      const nextHtml = levels.map((level, i) => {
        const label = escapeHtml(level?.label || `L${i + 1}`);
        const range = `${Number(level?.bottom ?? 0).toFixed(0)}..${Number(level?.top ?? 0).toFixed(0)}`;
        return `<option value="${i}">${label} (${range})</option>`;
      }).join('');
      select.innerHTML = nextHtml;
      const idx = Number(context?.index);
      if (Number.isFinite(idx)) {
        select.value = String(idx);
      }
      select.disabled = !levels.length;
    }

    if (this._els.title) {
      const source = context?.source || diagnostics?.source || 'unknown';
      this._els.title.textContent = `Levels • ${source}`;
    }

    if (this._els.status) {
      if (!context) {
        this._els.status.textContent = 'No level context available.';
      } else {
        const idx = Number.isFinite(context.index) ? context.index + 1 : '?';
        const count = Number.isFinite(context.count) ? context.count : levels.length;
        const label = context.label || context.levelId || `Level ${idx}`;
        this._els.status.textContent = `${label} (${idx}/${count}) • ${lockMode === 'follow-controlled-token' ? 'Follow' : 'Manual'}`;
      }
    }

    if (this._els.diagnostics) {
      const raw = Number(diagnostics?.rawCount || 0);
      const parsed = Number(diagnostics?.parsedCount || levels.length || 0);
      const invalid = Number(diagnostics?.invalidCount || 0);
      this._els.diagnostics.textContent = `Bands ${parsed}/${raw} • Invalid ${invalid}`;
    }
  }

  _onDragStart(event) {
    if (!this._overlayHandle) return;

    this._drag.active = true;
    const p = this._overlayHandle.lockedScreenPos || this._loadPosition();
    this._drag.startX = Number(p?.x ?? 0);
    this._drag.startY = Number(p?.y ?? 0);
    this._drag.startClientX = Number(event.clientX || 0);
    this._drag.startClientY = Number(event.clientY || 0);

    try { this._overlayHandle.el?.setPointerCapture?.(event.pointerId); } catch (_) {}

    window.addEventListener('pointermove', this._boundHandlers.onMove, true);
    window.addEventListener('pointerup', this._boundHandlers.onUp, true);
    window.addEventListener('pointercancel', this._boundHandlers.onUp, true);

    event.preventDefault();
    event.stopPropagation();
  }

  _onDragMove(event) {
    if (!this._drag.active || !this.overlayManager) return;

    const dx = Number(event.clientX || 0) - this._drag.startClientX;
    const dy = Number(event.clientY || 0) - this._drag.startClientY;

    const x = clamp(this._drag.startX + dx, 16, Math.max(16, (window.innerWidth || 0) - 16));
    const y = clamp(this._drag.startY + dy, 16, Math.max(16, (window.innerHeight || 0) - 16));

    this.overlayManager.lockOverlay(OVERLAY_ID, { x, y });

    // Immediate visual response.
    try {
      const el = this._overlayHandle?.el;
      if (el) {
        el.style.left = `${Math.round(x)}px`;
        el.style.top = `${Math.round(y)}px`;
      }
    } catch (_) {
    }

    event.preventDefault();
    event.stopPropagation();
  }

  _onDragEnd(event) {
    if (!this._drag.active) return;
    this._drag.active = false;

    window.removeEventListener('pointermove', this._boundHandlers.onMove, true);
    window.removeEventListener('pointerup', this._boundHandlers.onUp, true);
    window.removeEventListener('pointercancel', this._boundHandlers.onUp, true);

    const pos = this._overlayHandle?.lockedScreenPos || null;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      this._savePosition(pos);
    }

    event?.preventDefault?.();
    event?.stopPropagation?.();
  }

  _loadPosition() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return getDefaultScreenPos();
      const parsed = JSON.parse(raw);
      const x = Number(parsed?.x);
      const y = Number(parsed?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return getDefaultScreenPos();
      return {
        x: clamp(x, 16, Math.max(16, (window.innerWidth || 0) - 16)),
        y: clamp(y, 16, Math.max(16, (window.innerHeight || 0) - 16)),
      };
    } catch (_) {
      return getDefaultScreenPos();
    }
  }

  _savePosition(pos) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        x: Number(pos.x) || 0,
        y: Number(pos.y) || 0,
      }));
    } catch (_) {
    }
  }

  dispose() {
    if (this._levelHookId !== null) {
      Hooks.off('mapShineLevelContextChanged', this._levelHookId);
      this._levelHookId = null;
    }

    if (this._sceneHookId !== null) {
      Hooks.off('updateScene', this._sceneHookId);
      this._sceneHookId = null;
    }

    window.removeEventListener('pointermove', this._boundHandlers.onMove, true);
    window.removeEventListener('pointerup', this._boundHandlers.onUp, true);
    window.removeEventListener('pointercancel', this._boundHandlers.onUp, true);

    if (this.overlayManager) {
      try {
        this.overlayManager.removeOverlay(OVERLAY_ID);
      } catch (_) {
      }
    }

    this._overlayHandle = null;
    this._panel = null;
    this._initialized = false;
    this._lastDiagnostics = null;

    log.info('Level navigator compact overlay disposed');
  }
}
